import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
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
    // MEASURED: DecompressionStream('deflate') wants RFC 1950 (first bytes 78 9c), which
    // zlib.deflateSync emits. deflateRawSync emits RFC 1951 (ab a8) and would need
    // 'deflate-raw'. Mismatch these and EVERY frame silently fails to inflate in the browser.
    const out = encodeServerMessage({ kind: 'error', message: 'x' });
    expect(out[0]).toBe(0x78);
    expect(out[1]).toBe(0x9c);
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
    // The bridge intercepts quit and closes its own socket. This is defence in depth, because the
    // bridge is served code and a client is not obliged to run it.
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"quit"}}'))
      .toThrow(/quit/i);
  });

  it('refuses malformed input rather than passing it on', () => {
    for (const bad of ['', 'not json', '{}', '[]', '{"kind":"nope"}', '{"kind":"action"}']) {
      expect(() => decodeClientMessage(bad), `for ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('refuses a sessionId that is not a string', () => {
    expect(() => decodeClientMessage('{"kind":"hello","sessionId":42}')).toThrow();
  });
});
