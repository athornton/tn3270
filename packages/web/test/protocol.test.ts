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

  it('REFUSES transferForm, and gives the FILESYSTEM as the reason rather than a missing UI', () => {
    /**
     * THE REASON IS WHAT THIS PINS, not merely the refusal: `integration.test.ts`'s REFUSED loop
     * already asserts the message `toContain(kind)`, which the old wording ("the gateway has no
     * transfer UI") and the new one BOTH satisfy, so nothing distinguished them and the reason
     * could rot unobserved. It did: the Electron GUI has had a transfer window since 2026-10-01,
     * which made "no front end has a transfer UI" false while every test stayed green.
     *
     * `/filesystem/` and NOT `/transferForm/`, for that reason -- a regression to the old text must
     * redden here. The negative half is the load-bearing one and is asserted separately so a
     * failure says which property broke.
     */
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"transferForm"}}'))
      .toThrow(/transferForm/);
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"transferForm"}}'))
      .toThrow(/filesystem/);
    // The GUI HAS a transfer UI now, so the refusal must not claim otherwise.
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"transferForm"}}'))
      .not.toThrow(/no transfer UI/);
  });

  it('REFUSES copy, and gives WHOSE MACHINE as the reason rather than a missing feature', () => {
    /**
     * THE SAME DISCIPLINE AS `transferForm` ABOVE, AND FOR A REASON THAT HAS ALREADY GONE WRONG
     * ONCE IN THIS FEATURE. The copy/paste spec asserted the gateway got copy "free" because
     * `sendAction` already crosses the WebSocket. Transmitting the ACTION is free; returning the
     * TEXT is not, and nothing in that direction exists -- `ServerMessage` is `frame | error`,
     * `bridgecore.ts` has no clipboard among its four functions, and the browser's own renderer
     * holds a `DrawList` whose cells carry a CG-order atlas glyph and no character. So the gateway
     * would extract onto ITS OWN machine, which is the same objection as the transfer one.
     *
     * `/machine/` and NOT `/copy/`: a future refusal rewritten to say "no clipboard support yet"
     * would still contain the kind and still pass `integration.test.ts`'s `toContain` check, which
     * is exactly how the transfer reason rotted for months while every test stayed green. The
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
