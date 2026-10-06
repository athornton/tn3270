import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PA_AIDS, PF_AIDS } from '@tn3270/core';
import type { DrawCell } from '@tn3270/canvas';
import { encodeServerMessage, decodeClientMessage } from '../src/protocol.js';

/**
 * A realistic screenful of cells: EVERY field `DrawCell` declares, because a test object that
 * omits half the shape is weak evidence about how the real thing compresses. The plan's version
 * carried only `x, y, glyph, fg, bg` and hid the gap behind `as never`.
 */
function screenful(): DrawCell[] {
  return Array.from({ length: 1920 }, (_, i) => ({
    x: (i % 80) * 9,
    y: Math.floor(i / 80) * 14,
    glyph: 64,
    fg: [0, 255, 0] as const,
    bg: [0, 0, 0] as const,
    cursor: i === 0,
    underline: false,
    blink: false,
    intensify: false,
  }));
}

describe('encodeServerMessage', () => {
  it('emits a ZLIB-wrapped deflate stream, because that is what the browser expects', () => {
    // MEASURED: DecompressionStream('deflate') wants RFC 1950, which zlib.deflateSync emits.
    // deflateRawSync emits RFC 1951, which has NO header -- its leading bytes are compressed data
    // (measured `ab 56` for this payload but `4b 04` for "a", so the `ab a8` quoted elsewhere is
    // payload-specific rather than a signature) -- and would need 'deflate-raw'. Mismatch these and
    // EVERY frame silently fails to inflate in the browser.
    const out = encodeServerMessage({ kind: 'error', message: 'x' });
    expect(out[0]).toBe(0x78);
    // This pins the FORMAT, not the compression LEVEL. MEASURED: the second byte is 01/5e/9c/da for
    // levels 0/1/6/9, so `toBe(0x9c)` would break on a level change that still emits perfectly
    // valid zlib. RFC 1950's FCHECK rule is level-independent: CMF*256 + FLG must be a multiple of
    // 31. VERIFIED to still catch the trap this test exists for -- under deflateRawSync this
    // assertion fails on its own (0xab56 = 43862, which is 28 mod 31), not just via the byte above.
    expect((out[0]! * 256 + out[1]!) % 31).toBe(0);
  });

  it('round-trips a frame message', () => {
    const msg = { kind: 'frame' as const, list: { width: 2, height: 3, cells: [] } };
    expect(JSON.parse(inflateSync(encodeServerMessage(msg)).toString())).toEqual(msg);
  });

  it('compresses a realistic frame by more than 20x', () => {
    // The measured figure is 237220 -> 6760 for a 24x80 screen. This asserts the PROPERTY that
    // makes full frames acceptable over a network, without pinning an exact byte count that a
    // zlib upgrade could legitimately change.
    const list = { width: 720, height: 350, cells: screenful() };
    const raw = JSON.stringify({ kind: 'frame', list });
    const enc = encodeServerMessage({ kind: 'frame', list });
    expect(raw.length / enc.length).toBeGreaterThan(20);
  });

  it('sends the atlas coverage as base64, since JSON cannot hold bytes', () => {
    const enc = encodeServerMessage({
      kind: 'atlas',
      geometry: { cellWidth: 9, cellHeight: 14, cols: 16, index: {} },
      coverage: new Uint8Array([1, 2, 250]),
      blank: [0, 1],
    });
    const back: unknown = JSON.parse(inflateSync(enc).toString());
    const obj = back as { coverage: unknown; blank: unknown };
    expect(obj.coverage).toBe(Buffer.from([1, 2, 250]).toString('base64'));
    expect(obj.blank).toEqual([0, 1]);
  });
});

describe('decodeClientMessage', () => {
  it('accepts hello with and without a session id', () => {
    expect(decodeClientMessage('{"kind":"hello"}')).toEqual({ kind: 'hello' });
    expect(decodeClientMessage('{"kind":"hello","sessionId":"abc"}'))
      .toEqual({ kind: 'hello', sessionId: 'abc' });
  });

  it('accepts an action', () => {
    expect(decodeClientMessage('{"kind":"action","action":{"kind":"enter"}}'))
      .toEqual({ kind: 'action', action: { kind: 'enter' } });
  });

  it('REFUSES a quit action, which a browser must not be able to do to the gateway', () => {
    // The bridge intercepts quit and closes its own socket. This is defense in depth, because the
    // bridge is served code and a client is not obliged to run it.
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"quit"}}'))
      .toThrow(/quit/i);
  });

  /*
   * `REFUSES transferForm, and gives the FILESYSTEM as the reason rather than a missing UI` WAS
   * HERE AND IS DELETED, 2026-10-06, because its subject is gone rather than reworded. It pinned
   * the refusal's REASON -- `/filesystem/` and deliberately not `/transferForm/` -- precisely so
   * that a reason going stale would redden instead of passing on the kind's name alone. The reason
   * it pinned is now the reason the kind is ACCEPTED: socket-carried file I/O means a browser
   * transfer no longer touches the gateway's filesystem.
   *
   * DELETED RATHER THAN INVERTED because the `copy` case below already carries the discipline, and
   * `transfer messages > NO LONGER refuses the transferForm action` is its replacement. The plan
   * for this change did not mention this test at all; it was found by grep, and leaving it would
   * have made the suite assert both halves of a contradiction.
   */
  it('REFUSES copy, and gives WHOSE MACHINE as the reason rather than a missing feature', () => {
    /**
     * THE SAME DISCIPLINE THE DELETED `transferForm` CASE CARRIED, AND FOR A REASON THAT HAS
     * ALREADY GONE WRONG ONCE IN THIS FEATURE. The copy/paste spec asserted the gateway got copy
     * "free" because `sendAction` already crosses the WebSocket. Transmitting the ACTION is free;
     * returning the TEXT is not, and nothing in that direction carries it -- `ServerMessage` gained
     * three transfer members on 2026-10-06 and so is no longer `frame | error`, but none of them is
     * a clipboard message; `bridgecore.ts` has no clipboard among its four functions; and the
     * browser's own renderer holds a `DrawList` whose cells carry a CG-order atlas glyph and no
     * character. So the gateway would extract onto ITS OWN machine, which was the same objection
     * socket-carried file I/O has now answered for transfers.
     *
     * `/machine/` and NOT `/copy/`: a future refusal rewritten to say "no clipboard support yet"
     * would still contain the kind and still pass `integration.test.ts`'s `toContain` check, which
     * is exactly how the transfer reason rotted unobserved while every test stayed green. The
     * durable reason is whose machine the bytes land on, and that does not expire when web copy
     * ships -- at which point this becomes an interception in `main.ts` and this test is deleted
     * rather than reworded.
     *
     * AND IT MUST NOT CLAIM THE FEATURE IS MERELY ABSENT, because the user has committed to web
     * copy/paste before packaging (2026-10-05). "Not implemented" would read as an invitation to
     * delete the rejection the moment a bridge clipboard call appears, which would restore the
     * process-ending throw this exists to prevent.
     */
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"copy"}}'))
      .toThrow(/copy/);
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"copy"}}'))
      .toThrow(/machine/);
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"copy"}}'))
      .not.toThrow(/not implemented|unsupported/i);
  });

  it('refuses malformed input rather than passing it on', () => {
    // `{"kind":"action","action":{}}` is here because the `typeof aKind !== 'string'` branch was
    // otherwise VACUOUS: mutating it to `if (false)` left every test passing.
    const bads = [
      '', 'not json', '{}', '[]', '{"kind":"nope"}', '{"kind":"action"}',
      '{"kind":"action","action":{}}',
    ];
    for (const bad of bads) {
      expect(() => decodeClientMessage(bad), `for ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('accepts pf/pa numbers at both ends of core\'s AID tables', () => {
    // 1..PF_AIDS.length and 1..PA_AIDS.length -- 24 and 3 as measured, but the test reads the
    // tables so it moves with them rather than pinning literals.
    for (const n of [1, PF_AIDS.length]) {
      expect(decodeClientMessage(`{"kind":"action","action":{"kind":"pf","n":${n}}}`))
        .toEqual({ kind: 'action', action: { kind: 'pf', n } });
    }
    for (const n of [1, PA_AIDS.length]) {
      expect(decodeClientMessage(`{"kind":"action","action":{"kind":"pa","n":${n}}}`))
        .toEqual({ kind: 'action', action: { kind: 'pa', n } });
    }
  });

  it('REFUSES an out-of-range pf/pa number, which would put a bogus AID on the wire', () => {
    // `applyAction` does `PF_AIDS[action.n - 1]!`; out of range that is `undefined`, and
    // `Uint8Array.from([undefined])` in `buildReadModified` coerces to 0 -- so an unbounded `n`
    // transmits AID 0x00 to the live host and locks the keyboard. The other front ends are safe
    // only because their `n` comes from a trusted keymap.
    const bad = ['0', '-1', '1e9', '1.5', '"1"', 'null', 'true'];
    for (const kind of ['pf', 'pa'] as const) {
      const past = (kind === 'pf' ? PF_AIDS.length : PA_AIDS.length) + 1;
      for (const n of [...bad, String(past)]) {
        const text = `{"kind":"action","action":{"kind":"${kind}","n":${n}}}`;
        expect(() => decodeClientMessage(text), `for ${text}`).toThrow(/integer/i);
      }
      // A missing `n` must not sneak through as `undefined - 1` = NaN either.
      expect(() => decodeClientMessage(`{"kind":"action","action":{"kind":"${kind}"}}`))
        .toThrow(/integer/i);
    }
  });

  it('refuses a sessionId that is not a string', () => {
    expect(() => decodeClientMessage('{"kind":"hello","sessionId":42}')).toThrow();
  });
});

describe('transfer messages', () => {
  it('accepts a transferChunk with its sequence, declared total and base64 bytes', () => {
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 3, bytes: 'AQID',
    }));
    expect(msg.kind).toBe('transferChunk');
    if (msg.kind !== 'transferChunk') throw new Error('narrowing');
    expect(msg.seq).toBe(0);
    expect(msg.total).toBe(3);
    expect(msg.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a transferChunk whose bytes are not a string', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 3, bytes: 42,
    }))).toThrow(/bytes must be a base64 string/);
  });

  /*
   * EVERY REJECTED SHAPE OF `seq` AND `total`, AND THIS CASE EXISTS BECAUSE THE TWO ABOVE WERE NOT
   * ENOUGH. Measured 2026-10-06 by mutation: with only the non-integer `seq` case and the `bytes`
   * case, deleting `|| seq < 0` left 22/22 passing, and replacing the ENTIRE `total` guard with
   * `if (false)` also left 22/22 passing -- so two of the three validations this decode performs
   * were vacuous and the suite could not tell. A negative `seq` is the one that matters most:
   * `ChunkReassembler.accept` compares it against its own `next` counter, so a bogus value is
   * refused rather than acted on, but the decode is the boundary where untrusted numbers stop and
   * `pf`/`pa` above is this file's record of what an unchecked index did reach.
   */
  it('rejects every non-index seq and total a client can send', () => {
    for (const seq of [-1, 1.5, Number.NaN, Infinity, '0', null, true]) {
      expect(() => decodeClientMessage(JSON.stringify({
        kind: 'transferChunk', seq, total: 3, bytes: 'AQID',
      })), `for seq ${String(seq)}`).toThrow(/seq must be a non-negative integer/);
    }
    for (const total of [-1, 1.5, Number.NaN, Infinity, '3', null, true]) {
      expect(() => decodeClientMessage(JSON.stringify({
        kind: 'transferChunk', seq: 0, total, bytes: 'AQID',
      })), `for total ${String(total)}`).toThrow(/total must be a non-negative integer/);
    }
    // A MISSING FIELD IS NOT A ZERO, which `undefined` would become under a `< 0` test alone.
    expect(() => decodeClientMessage('{"kind":"transferChunk","bytes":"AQID"}'))
      .toThrow(/seq must be a non-negative integer/);
    expect(() => decodeClientMessage('{"kind":"transferChunk","seq":0,"bytes":"AQID"}'))
      .toThrow(/total must be a non-negative integer/);
  });

  it('rejects a transferChunk with a non-integer seq', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 1.5, total: 3, bytes: 'AQID',
    }))).toThrow(/seq must be a non-negative integer/);
  });

  it('accepts transferStart with its keyword list', () => {
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 'LocalFile=x'],
    }));
    if (msg.kind !== 'transferStart') throw new Error('narrowing');
    expect(msg.keywords).toEqual(['Direction=send', 'LocalFile=x']);
  });

  it('rejects transferStart whose keywords are not all strings', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 7],
    }))).toThrow(/keywords must be an array of strings/);
  });

  it('accepts transferCancel', () => {
    expect(decodeClientMessage(JSON.stringify({ kind: 'transferCancel' })).kind)
      .toBe('transferCancel');
  });

  it('NO LONGER refuses the transferForm action', () => {
    // It was refused because a browser transfer would have written to the GATEWAY's disk.
    // Socket-carried file I/O is exactly what removes that reason.
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'transferForm' },
    }));
    expect(msg.kind).toBe('action');
  });

  it('STILL refuses copy and quit, which are refused for other reasons', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'copy' },
    }))).toThrow();
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'quit' },
    }))).toThrow();
  });

  it('round-trips transferProgress and transferDone as server messages', () => {
    // `inflateSync(encodeServerMessage(...))` is this suite's own idiom for a server message --
    // see its `round-trips a frame message` case. There is no decode helper and none is wanted.
    const prog = { kind: 'transferProgress' as const, text: '512 bytes' };
    expect(JSON.parse(inflateSync(encodeServerMessage(prog)).toString())).toEqual(prog);
    const done = { kind: 'transferDone' as const, ok: true, bytes: 249 };
    expect(JSON.parse(inflateSync(encodeServerMessage(done)).toString())).toEqual(done);
  });

  it('encodes transferData bytes as base64, the way the atlas message does', () => {
    const msg = {
      kind: 'transferData' as const, seq: 0, total: 3, bytes: new Uint8Array([1, 2, 3]),
    };
    const wire = JSON.parse(inflateSync(encodeServerMessage(msg)).toString());
    expect(wire.bytes).toBe('AQID');
  });
});
