import { describe, it, expect } from 'vitest';
import { Screen } from '../src/screen.js';
import { execute } from '../src/stream/execute.js';
import { buildQueryReply, DEFAULT_CAPABILITIES } from '../src/queryreply.js';
import { MODEL_2, MODEL_3, MODEL_4, MODEL_5, Qcode } from '../src/constants.js';
import type { ParsedRecord } from '../src/stream/parse.js';

/**
 * Alternate screen size: the Erase/Write vs Erase/Write Alternate pair.
 *
 * THE FACT THE WHOLE FEATURE TURNS ON, and it is not what the model numbers make
 * it look like: EVERY model's DEFAULT size is model 2's 24x80. x3270 sets
 * `ROWS = defROWS = MODEL_2_ROWS` unconditionally (`ctlr.c:341`) and only
 * `altROWS = maxROWS` varies (`ctlr.c:345`). A model number does not change the
 * screen you get on connect; it changes the one the host may switch you to.
 *
 * None of this is TN3270E. x3270 switches size at `ctlr.c:558-561` with no
 * reference to the telnet option.
 */

/** A bare record of one command, which is all these tests need. */
const record = (command: ParsedRecord['command']): ParsedRecord =>
  ({ command, wcc: 0, tokens: [] });

const model4 = () => new Screen({
  rows: MODEL_2.rows, cols: MODEL_2.cols,
  alternateRows: MODEL_4.rows, alternateCols: MODEL_4.cols,
});

describe('the model geometry table', () => {
  it('matches x3270 include/3270ds.h:446-453', () => {
    expect(MODEL_2).toEqual({ rows: 24, cols: 80 });
    expect(MODEL_3).toEqual({ rows: 32, cols: 80 });
    expect(MODEL_4).toEqual({ rows: 43, cols: 80 });
    expect(MODEL_5).toEqual({ rows: 27, cols: 132 });
  });

  it('keeps every model inside 12-bit addressing except by oversize', () => {
    // Screens over 4096 cells need 14-bit addresses. No architected model crosses
    // that line -- model 5 is the largest at 3564 -- so a model alone never
    // changes the address encoding. Only x3270-style oversize does.
    for (const m of [MODEL_2, MODEL_3, MODEL_4, MODEL_5]) {
      expect(m.rows * m.cols).toBeLessThanOrEqual(0x1000);
    }
  });
});

describe('Screen size switching', () => {
  it('starts at the DEFAULT size, not the alternate', () => {
    const s = model4();
    expect([s.rows, s.cols]).toEqual([24, 80]);
    expect(s.size).toBe(1920);
    expect(s.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('switches to the alternate size and back', () => {
    const s = model4();
    expect(s.useAlternateSize()).toBe(true);
    expect([s.rows, s.cols, s.size]).toEqual([43, 80, 3440]);
    expect(s.useDefaultSize()).toBe(true);
    expect([s.rows, s.cols, s.size]).toEqual([24, 80, 1920]);
  });

  it('reports NO change when the size is already right', () => {
    // What keeps a model 2 session free: its two sizes are equal, so every
    // Erase/Write Alternate in the session is a no-op and costs no repaint.
    const two = new Screen();
    expect(two.useAlternateSize()).toBe(false);
    expect(two.useDefaultSize()).toBe(false);
    const s = model4();
    expect(s.useAlternateSize()).toBe(true);
    expect(s.useAlternateSize()).toBe(false);
  });

  it('defaults the alternate size to the default size, as a model 2 has', () => {
    const s = new Screen({ rows: 24, cols: 80 });
    expect(s.alternateSize).toEqual({ rows: 24, cols: 80 });
  });

  it('discards content, which is what EW and EWA do anyway', () => {
    const s = model4();
    s.setChar(0, 0xc1);
    expect(s.readBuffer()[0]).toBe(0xc1);
    s.useAlternateSize();
    expect(s.readBuffer()[0]).toBe(0x00);
    expect(s.cursor).toBe(0);
  });

  it('addresses the whole new buffer, and nothing past it', () => {
    // The invariant with teeth: `check` bounds every address against `size`, so a
    // resize that updated the arrays but not `size` would either reject legal
    // addresses or write out of bounds.
    const s = model4();
    s.useAlternateSize();
    expect(() => s.setChar(3439, 0xc1)).not.toThrow();
    expect(() => s.setChar(3440, 0xc1)).toThrow(RangeError);
    s.useDefaultSize();
    expect(() => s.setChar(1920, 0xc1)).toThrow(RangeError);
  });

  it('rejects a geometry it cannot build a buffer from', () => {
    const s = model4();
    for (const [r, c] of [[0, 80], [24, 0], [-1, 80], [24.5, 80]]) {
      expect(() => s.resize(r!, c!), `${r}x${c}`).toThrow(RangeError);
    }
    expect(() => new Screen({ alternateRows: 0, alternateCols: 80 })).toThrow(RangeError);
  });
});

describe('Erase/Write vs Erase/Write Alternate', () => {
  it('EWA selects the alternate size and reports the resize', () => {
    const s = model4();
    const r = execute(s, record('EraseWriteAlternate'));
    expect(r.resized).toBe(true);
    expect([s.rows, s.cols]).toEqual([43, 80]);
  });

  it('EW selects the default size', () => {
    const s = model4();
    execute(s, record('EraseWriteAlternate'));
    const r = execute(s, record('EraseWrite'));
    expect(r.resized).toBe(true);
    expect([s.rows, s.cols]).toEqual([24, 80]);
  });

  it('reports no resize on a model 2, for either command', () => {
    const s = new Screen();
    expect(execute(s, record('EraseWriteAlternate')).resized).toBe(false);
    expect(execute(s, record('EraseWrite')).resized).toBe(false);
  });

  it('still erases when the size did not change', () => {
    // The resize returns early when the geometry matches, so the erase has to be
    // its own step. Dropping `screen.clear()` from the EWA case would leave a
    // model 2 never clearing on Erase/Write Alternate at all.
    const s = new Screen();
    s.setChar(5, 0xc1);
    execute(s, record('EraseWriteAlternate'));
    expect(s.readBuffer()[5]).toBe(0x00);
  });
});

describe('the Query Reply stops saying alternate == default', () => {
  const reply = (alternate?: { rows: number; cols: number }) => buildQueryReply(
    DEFAULT_CAPABILITIES,
    { rows: 24, cols: 80, ...(alternate !== undefined ? { alternate } : {}) },
  );
  const body = (r: Uint8Array, qcode: number): number[] => {
    let i = 1;
    while (i < r.length) {
      const len = (r[i]! << 8) | r[i + 1]!;
      if (len < 4) throw new Error(`bogus unit length ${len}`);
      if (r[i + 3] === qcode) return Array.from(r.subarray(i + 4, i + len));
      i += len;
    }
    throw new Error(`no unit 0x${qcode.toString(16)}`);
  };
  const u16 = (bytes: number[], at: number) => (bytes[at]! << 8) | bytes[at + 1]!;

  it('reports the default THEN the alternate in Implicit Partition', () => {
    // sf.c:919-922: implicit width, implicit height, then maxCOLS, maxROWS.
    const b = body(reply(MODEL_5), Qcode.IMPLICIT_PARTITION);
    expect([u16(b, 5), u16(b, 7)]).toEqual([80, 24]);    // WD HD
    expect([u16(b, 9), u16(b, 11)]).toEqual([132, 27]);  // WA HA
  });

  it('reports the MAXIMUM in Usable Area, not the default', () => {
    // sf.c:718-719 writes maxCOLS/maxROWS. Reporting the default here would tell
    // a host the alternate size it is about to be offered does not fit.
    const b = body(reply(MODEL_5), Qcode.USABLE_AREA);
    expect([u16(b, 2), u16(b, 4)]).toEqual([132, 27]);
  });

  it('sizes BUFFSZ from the maximum too', () => {
    const b = body(reply(MODEL_4), Qcode.USABLE_AREA);
    // 43 * 80 = 3440. Its offset is found by searching rather than hardcoded, so
    // this test does not silently move if the unit gains a field.
    expect(b.some((_, i) => u16(b, i) === 3440)).toBe(true);
  });

  it('still says alternate == default when there is no alternate', () => {
    // The compatibility case, and the one every caller predating this got.
    const b = body(reply(), Qcode.IMPLICIT_PARTITION);
    expect([u16(b, 9), u16(b, 11)]).toEqual([80, 24]);
    expect([u16(body(reply(), Qcode.USABLE_AREA), 2)]).toEqual([80]);
  });

  it('rejects a zero alternate as firmly as a zero default', () => {
    // p. 6-72: "Default and alternate values must be nonzero."
    expect(() => buildQueryReply(DEFAULT_CAPABILITIES, {
      rows: 24, cols: 80, alternate: { rows: 0, cols: 80 },
    })).toThrow(/alternate\.rows/);
  });
});
