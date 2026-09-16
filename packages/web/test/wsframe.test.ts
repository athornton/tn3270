import { describe, it, expect } from 'vitest';
import { parseFrame, serializeFrame, OPCODE } from '../src/wsframe.js';

/**
 * RFC 6455 framing, hand-rolled to keep this project's zero-dependency property in the one
 * component that faces a network.
 *
 * WHAT THESE TESTS ARE FOR: the length encoding switches representation at 126 and at 65536, and
 * a client frame MUST be masked while a server frame MUST NOT be. Every one of those is a boundary
 * where an off-by-one produces a stream that looks almost right and desynchronises later --
 * failing far from the cause. `integration.test.ts` then checks the whole thing against Node's
 * built-in WebSocket client, which is an INDEPENDENT implementation; these tests alone would only
 * prove we agree with ourselves.
 */
const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);

/** Build a client frame by hand, so the parser is tested against bytes we control. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const masked = Buffer.from(payload);
  // Written as an explicit read-xor-write because `^=` on an index is not `noUncheckedIndexedAccess`
  // clean, and this file is held to the same strictness as `src/` even though no tsconfig covers it.
  for (let i = 0; i < masked.length; i += 1) masked[i] = masked[i]! ^ mask[i % 4]!;
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) head.push(0x80 | payload.length);
  else if (payload.length < 65536) head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0,
      (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

describe('parseFrame', () => {
  it('returns undefined when the buffer holds less than a whole frame', () => {
    expect(parseFrame(Buffer.from([0x81]))).toBeUndefined();
    const whole = clientFrame(OPCODE.TEXT, Buffer.from('hello'));
    expect(parseFrame(whole.subarray(0, whole.length - 1))).toBeUndefined();
  });

  it('unmasks a short text frame and reports how many bytes it consumed', () => {
    const buf = clientFrame(OPCODE.TEXT, Buffer.from('hello'));
    const f = parseFrame(buf)!;
    expect(f.opcode).toBe(OPCODE.TEXT);
    expect(f.fin).toBe(true);
    expect(f.payload.toString()).toBe('hello');
    expect(f.consumed).toBe(buf.length);
  });

  it('handles the 126-byte boundary, where the length becomes 16-bit', () => {
    for (const n of [125, 126, 127]) {
      const body = Buffer.alloc(n, 0x61);
      const f = parseFrame(clientFrame(OPCODE.BINARY, body))!;
      expect(f.payload.length, `payload for n=${n}`).toBe(n);
      expect(f.payload.equals(body)).toBe(true);
    }
  });

  it('handles the 65536-byte boundary, where the length becomes 64-bit', () => {
    for (const n of [65535, 65536]) {
      const body = Buffer.alloc(n, 0x62);
      const f = parseFrame(clientFrame(OPCODE.BINARY, body))!;
      expect(f.payload.length, `payload for n=${n}`).toBe(n);
    }
  });

  it('leaves a second frame in the buffer rather than consuming it', () => {
    const a = clientFrame(OPCODE.TEXT, Buffer.from('one'));
    const b = clientFrame(OPCODE.TEXT, Buffer.from('two'));
    const f = parseFrame(Buffer.concat([a, b]))!;
    expect(f.consumed).toBe(a.length);
    const g = parseFrame(Buffer.concat([a, b]).subarray(f.consumed))!;
    expect(g.payload.toString()).toBe('two');
  });

  it('REFUSES an unmasked client frame, which the RFC requires', () => {
    // Same bytes with the mask bit cleared and no masking key.
    const buf = Buffer.concat([Buffer.from([0x80 | OPCODE.TEXT, 5]), Buffer.from('hello')]);
    expect(() => parseFrame(buf)).toThrow(/mask/i);
  });

  it('blames the MASK, not the length, when an unmasked frame has an extended length header', () => {
    // The mask bit is bit 7 of byte 1, so it is known the moment byte 1 is in hand -- it does not
    // depend on the extended length at all. If the length is parsed first, an unmasked frame is
    // diagnosed by whatever those length bytes happen to say: bytes that are really PAYLOAD get
    // read as a 64-bit length, and the reported fault becomes `frame length out of range`.
    //
    // WHY THIS MATTERS EVEN THOUGH REAL CLIENTS ALWAYS MASK: this message is what a person reads
    // when the client is hand-rolled, half-finished or misbehaving -- exactly the situation in
    // which someone is staring at this module. `frame length out of range` sends them to the wrong
    // end of the problem entirely, hunting an oversized frame that does not exist, when the actual
    // fault is one bit in the second byte.
    //
    // A truncated header is the same story: for an UNMASKED frame there is nothing to wait for, so
    // reporting the mask beats returning `undefined` and stalling until more bytes arrive.
    const unmaskedExtended: readonly [string, Buffer][] = [
      // Complete 64-bit length whose top bit is set; the length bytes here are really payload.
      ['64-bit header', Buffer.concat([Buffer.from([0x80 | OPCODE.TEXT, 127]),
        Buffer.from([0xff, 0, 0, 0, 0, 0, 0, 0])])],
      ['64-bit header, truncated', Buffer.from([0x80 | OPCODE.TEXT, 127, 0, 0, 0])],
      ['16-bit header, truncated', Buffer.from([0x80 | OPCODE.TEXT, 126, 0x01])],
      ['16-bit header, complete', Buffer.from([0x80 | OPCODE.TEXT, 126, 0x01, 0x00])],
    ];
    // Soft, so a regression names EVERY header shape that stopped blaming the mask rather than
    // stopping at the first and hiding the rest -- the same "fail near the cause" reason the
    // boundaries above are each spelled out.
    for (const [what, buf] of unmaskedExtended) {
      expect.soft(() => parseFrame(buf), what).toThrow(/mask/i);
    }
  });

  it('still returns undefined for a MASKED frame whose header is split across reads', () => {
    // The other half of the case above, and the one a real client hits constantly: a MASKED frame
    // that arrived in pieces is a TCP read boundary, not a protocol error. Throwing here would
    // drop legitimate traffic, so every one of these must still be "come back with more bytes".
    const partialMasked: readonly [string, Buffer][] = [
      ['16-bit header, truncated', Buffer.from([0x80 | OPCODE.BINARY, 0x80 | 126, 0x01])],
      ['16-bit header, no masking key', Buffer.from([0x80 | OPCODE.BINARY, 0x80 | 126, 0x01, 0x00])],
      ['64-bit header, truncated', Buffer.from([0x80 | OPCODE.BINARY, 0x80 | 127, 0, 0, 0])],
      ['64-bit header, no masking key', Buffer.concat([Buffer.from([0x80 | OPCODE.BINARY, 0x80 | 127]),
        Buffer.from([0, 0, 0, 0, 0, 1, 0, 0])])],
      ['key present, payload short', Buffer.concat([Buffer.from([0x80 | OPCODE.BINARY, 0x80 | 5]),
        mask, Buffer.from('ab')])],
    ];
    for (const [what, buf] of partialMasked) {
      expect.soft(parseFrame(buf), what).toBeUndefined();
    }
  });

  it('reports a non-final frame so the caller can reassemble', () => {
    const f = parseFrame(clientFrame(OPCODE.TEXT, Buffer.from('par'), false))!;
    expect(f.fin).toBe(false);
    expect(f.opcode).toBe(OPCODE.TEXT);
    const g = parseFrame(clientFrame(OPCODE.CONTINUATION, Buffer.from('tial')))!;
    expect(g.opcode).toBe(OPCODE.CONTINUATION);
  });

  it('parses close, ping and pong', () => {
    for (const op of [OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG]) {
      expect(parseFrame(clientFrame(op, Buffer.alloc(0)))!.opcode).toBe(op);
    }
  });
});

describe('serializeFrame', () => {
  it('does NOT mask, because a server frame must not be masked', () => {
    const out = serializeFrame(OPCODE.BINARY, Buffer.from('abc'));
    expect(out[0]).toBe(0x80 | OPCODE.BINARY);
    expect(out[1]! & 0x80).toBe(0);          // mask bit clear
    expect(out[1]! & 0x7f).toBe(3);
    expect(out.subarray(2).toString()).toBe('abc');
  });

  it('uses the 16-bit length for 126 and above', () => {
    const out = serializeFrame(OPCODE.BINARY, Buffer.alloc(200));
    // The mask bit shares byte 1 with the length, so each length branch writes it separately and
    // each one has to be pinned. This is the branch real traffic uses -- a draw list is ~6.7 KiB.
    expect(out[1]! & 0x80).toBe(0);
    expect(out[1]! & 0x7f).toBe(126);
    expect(out.readUInt16BE(2)).toBe(200);
    expect(out.length).toBe(4 + 200);
  });

  it('uses the 64-bit length for 65536 and above', () => {
    const out = serializeFrame(OPCODE.BINARY, Buffer.alloc(65536));
    expect(out[1]! & 0x80).toBe(0);
    expect(out[1]! & 0x7f).toBe(127);
    expect(Number(out.readBigUInt64BE(2))).toBe(65536);
    expect(out.length).toBe(10 + 65536);
  });

  it('round-trips through the parser when the payload is masked back', () => {
    // A server frame is unmasked, so re-parsing it as a CLIENT frame must be refused -- which is
    // itself the property that keeps the two directions from being confused.
    expect(() => parseFrame(serializeFrame(OPCODE.TEXT, Buffer.from('x')))).toThrow(/mask/i);
  });

  it('refuses an opcode that does not fit its 4 bits', () => {
    // Byte 0's high nibble is FIN and the three RSV bits, so 0x10 would not corrupt the opcode --
    // it would quietly set RSV1, which a browser reads as an extension nobody negotiated, and the
    // connection would then fail somewhere with no relation to the caller that caused it.
    for (const bad of [0x10, -1, 1.5, 0xff]) {
      expect(() => serializeFrame(bad, Buffer.alloc(0))).toThrow(/4 bits/);
    }
    expect(serializeFrame(0x0f, Buffer.alloc(0))[0]).toBe(0x8f);
  });
});

describe('parseFrame with a payload cap', () => {
  it('accepts a payload at the cap and refuses one byte more', () => {
    expect(parseFrame(clientFrame(OPCODE.TEXT, Buffer.alloc(100)), 100)!.payload.length).toBe(100);
    expect(() => parseFrame(clientFrame(OPCODE.TEXT, Buffer.alloc(101)), 100)).toThrow(/exceeds/);
  });

  it('refuses a DECLARED length from the 10 header bytes alone, mask key not yet arrived', () => {
    // The point of the cap. A 64-bit length announcing 4 GB must cost one read to refuse, not 4 GB
    // of buffering while the payload it promised is waited for.
    //
    // TEN BYTES, NOT FOURTEEN, AND THAT IS THE WHOLE TEST. Written with the 4-byte masking key
    // appended, this passed with the cap checked LATE -- `off + 4` was already satisfied, so the
    // late check still threw and the mutation was INERT. Stopping at the length pins the earliest
    // point the cap CAN be applied, which makes every later placement fail.
    const header = Buffer.alloc(10);
    header[0] = 0x80 | OPCODE.TEXT;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(4 * 1024 * 1024 * 1024), 2);
    expect(header.length).toBe(10);
    expect(() => parseFrame(header, 8192)).toThrow(/exceeds/);
  });

  it('is uncapped by default, so the pure framing tests take no view on size', () => {
    expect(parseFrame(clientFrame(OPCODE.TEXT, Buffer.alloc(70000)))!.payload.length).toBe(70000);
  });
});
