import { describe, it, expect } from 'vitest';
import { Screen } from '../src/screen.js';
import { parseRecord } from '../src/stream/parse.js';
import { execute, ExecuteError } from '../src/stream/execute.js';
import { SnaCmd, Order, FA, WCC } from '../src/constants.js';

/** Parse and execute one record against a screen. */
function run(s: Screen, ...bytes: number[]) {
  return execute(s, parseRecord(Uint8Array.from(bytes)));
}

describe('write commands', () => {
  it('Write leaves existing content alone', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(160).ebcdic).toBe(0xc2);
  });

  it('Erase/Write clears the buffer first', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    run(s, SnaCmd.EW, 0x00, Order.SBA, 0xc2, 0x60, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0x00);
    expect(s.cellAt(160).ebcdic).toBe(0xc2);
  });

  it('Erase/Write Alternate behaves as Erase/Write on a model 2', () => {
    const s = new Screen();
    s.setChar(5, 0xc1);
    run(s, SnaCmd.EWA, 0x00);
    expect(s.cellAt(5).ebcdic).toBe(0x00);
  });

  it('Erase All Unprotected keeps protected data and attributes', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SF, 0x00, 0xc1, Order.SBA, 0xc2, 0x60, Order.SF, FA.PROTECT, 0xc2);
    run(s, SnaCmd.EAU);
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(161).ebcdic).toBe(0xc2);
    expect(s.isFieldAttribute(0)).toBe(true);
  });

  it('a write starts at address 0 by default', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, 0xc1, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(1).ebcdic).toBe(0xc2);
  });
});

describe('WCC handling', () => {
  it('resets MDT in unprotected fields when bit 7 is set', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.MODIFY);
    run(s, SnaCmd.W, WCC.RESET_MDT);
    expect(s.fieldAt(1)!.modified).toBe(false);
  });

  it('reports a keyboard restore request', () => {
    const s = new Screen();
    const r = run(s, SnaCmd.W, WCC.KEYBOARD_RESTORE);
    expect(r.keyboardRestore).toBe(true);
    expect(run(s, SnaCmd.W, 0x00).keyboardRestore).toBe(false);
  });

  it('reports an alarm request', () => {
    const s = new Screen();
    expect(run(s, SnaCmd.W, WCC.SOUND_ALARM).alarm).toBe(true);
  });

  it('reports that no printer is available for start-printer', () => {
    const s = new Screen();
    expect(run(s, SnaCmd.W, WCC.START_PRINTER).printerUnavailable).toBe(true);
  });
});

describe('orders', () => {
  it('SBA moves the write position', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60, 0xc1);
    expect(s.cellAt(160).ebcdic).toBe(0xc1);
  });

  it('SF plants a field attribute and advances past it', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SF, FA.PROTECT, 0xc1);
    expect(s.attributeAt(0)).toBe(FA.PROTECT);
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
  });

  it('IC sets the cursor to the current position', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc2, 0x60, Order.IC);
    expect(s.cursor).toBe(160);
  });

  it('RA fills from the current address up to but excluding the stop', () => {
    const s = new Screen();
    // Start at 10, repeat '*' (0x5c) to address 15.
    const [h, l] = [0xc0 | (15 >> 6), 0xc0 | (15 & 0x3f)];
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f), Order.RA, h, l, 0x5c);
    for (let a = 10; a < 15; a++) expect(s.cellAt(a).ebcdic).toBe(0x5c);
    expect(s.cellAt(15).ebcdic).toBe(0x00);
  });

  it('RA to the current address fills the entire buffer', () => {
    // x3270 uses a do-while, so stop == start wraps all the way around.
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.RA, 0x40, 0x40, 0x5c);
    expect(s.cellAt(0).ebcdic).toBe(0x5c);
    expect(s.cellAt(1919).ebcdic).toBe(0x5c);
  });

  it('RA wraps around the end of the buffer to reach its stop', () => {
    const s = new Screen();
    // Start at 1918, stop at 2 — fills 1918, 1919, 0, 1.
    run(s, SnaCmd.W, 0x00,
      Order.SBA, 0xc0 | (1918 >> 6), 0xc0 | (1918 & 0x3f),
      Order.RA, 0xc0 | (2 >> 6), 0xc0 | (2 & 0x3f), 0x5c);
    expect(s.cellAt(1918).ebcdic).toBe(0x5c);
    expect(s.cellAt(1919).ebcdic).toBe(0x5c);
    expect(s.cellAt(0).ebcdic).toBe(0x5c);
    expect(s.cellAt(1).ebcdic).toBe(0x5c);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
  });

  it('RA rejects a stop address past the end of the screen', () => {
    const s = new Screen();
    // 14-bit form so we can express an address beyond 1919.
    expect(() => run(s, SnaCmd.W, 0x00, Order.RA, 0x0f, 0xff, 0x5c))
      .toThrow(ExecuteError);
  });

  it('RA with a GE before the fill fills with the escaped character, not 0x08', () => {
    const s = new Screen();
    const [h, l] = [0xc0 | (5 >> 6), 0xc0 | (5 & 0x3f)];
    run(s, SnaCmd.W, 0x00, Order.RA, h, l, Order.GE, 0xf1);
    for (let a = 0; a < 5; a++) expect(s.cellAt(a).ebcdic).toBe(0xf1);
    expect(s.cellAt(5).ebcdic).toBe(0x00);
  });

  it('EUA nulls unprotected cells in a range and leaves protected ones', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00,
      Order.SF, 0x00, 0xc1, 0xc2,              // unprotected field at 0, data 1-2
      Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f),
      Order.SF, FA.PROTECT, 0xc3);             // protected field at 10, data 11
    run(s, SnaCmd.W, 0x00,
      Order.SBA, 0x40, 0x40,
      Order.EUA, 0xc0 | (20 >> 6), 0xc0 | (20 & 0x3f));
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
    expect(s.cellAt(11).ebcdic).toBe(0xc3);
  });

  it('EUA rejects a stop address past the end of the screen', () => {
    const s = new Screen();
    // 14-bit form so we can express an address beyond 1919.
    expect(() => run(s, SnaCmd.W, 0x00, Order.EUA, 0x0f, 0xff))
      .toThrow(ExecuteError);
  });

  it('PT advances to the first data cell of the next unprotected field', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00,
      Order.SF, FA.PROTECT,                                   // protected at 0
      Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f),
      Order.SF, 0x00);                                        // unprotected at 10
    const r = run(s, SnaCmd.W, 0x00, Order.PT, 0xc1);
    expect(r.programCheck).toBeUndefined();
    expect(s.cellAt(11).ebcdic).toBe(0xc1);
  });

  it('GE writes its character like data', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.GE, 0xf1);
    expect(s.cellAt(0).ebcdic).toBe(0xf1);
  });

  it('skips deferred orders without corrupting following data', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SA, 0x42, 0xf2, 0xc1, 0xc2);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(1).ebcdic).toBe(0xc2);
  });

  it('data wraps past the end of the buffer', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00,
      Order.SBA, 0xc0 | (1919 >> 6), 0xc0 | (1919 & 0x3f),
      0xc1, 0xc2);
    expect(s.cellAt(1919).ebcdic).toBe(0xc1);
    expect(s.cellAt(0).ebcdic).toBe(0xc2);
  });

  it('a field attribute overwritten by data destroys the field', () => {
    const s = new Screen();
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f), Order.SF, FA.PROTECT);
    expect(s.fields()).toHaveLength(1);
    run(s, SnaCmd.W, 0x00, Order.SBA, 0xc0 | (10 >> 6), 0xc0 | (10 & 0x3f), 0xc1);
    expect(s.fields()).toHaveLength(0);
  });
});

describe('read commands', () => {
  it('reports which read the host asked for without mutating the screen', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    expect(run(s, SnaCmd.RB).readRequest).toBe('ReadBuffer');
    expect(run(s, SnaCmd.RM).readRequest).toBe('ReadModified');
    expect(run(s, SnaCmd.RMA).readRequest).toBe('ReadModifiedAll');
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
  });
});

describe('structured fields and no-op', () => {
  it('ignores a WSF payload but reports that one arrived', () => {
    const s = new Screen();
    // A well-formed field with an SFID we do not implement. The old payload
    // declared a length of 5 with only 4 bytes present, which typed SF parsing
    // now rejects. An unknown SFID rather than a Read Partition Query on
    // purpose: this test is about the ignored-field counter, and task 7 makes a
    // Query set an sfReply intent instead of incrementing it.
    const r = run(s, SnaCmd.WSF, 0x00, 0x04, 0x40, 0xaa);
    expect(r.structuredFieldsIgnored).toBe(1);
  });

  it('does nothing for a NoOp', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    run(s, 0x03);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
  });
});
