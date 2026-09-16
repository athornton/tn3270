/**
 * RFC 6455 frame parsing and serialising. Pure: no sockets, no state beyond the buffer given.
 *
 * WHY HAND-ROLLED: every package in this project declares only workspace siblings, and keeping
 * that property in the one network-facing component was a deliberate call. Framing is
 * well-specified and not security-sensitive the way crypto would be. `wsserver.ts` is the seam
 * that makes adopting the `ws` package a contained change if this disappoints.
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRIC (§5.1): a client MUST mask every frame and a server MUST
 * NOT. `parseFrame` therefore refuses an unmasked frame -- it only ever reads client frames -- and
 * `serializeFrame` never masks. Getting this backwards produces a stream that desynchronises a
 * few frames later, failing far from the cause.
 */
// NO `as const` HERE, AND THAT IS DELIBERATE: it would be dead syntax. A review asked for one on
// the grounds that `(typeof OPCODE)['TEXT']` otherwise widens to `number` and a future
// exhaustiveness `switch` would lose its literal-type protection. MEASURED on this exact six-key
// shape under `tsc --strict`, and the premise is FALSE both ways -- `const t: (typeof
// OPCODE)['TEXT'] = 999` is rejected as "Type '999' is not assignable to type '1'", and a `switch`
// over `keyof` values with a `const never: never = x` default compiles clean. `Object.freeze`'s lib
// overload constrains its values to primitives, so T infers with literal types already preserved.
export const OPCODE = Object.freeze({
  CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa,
});

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  /** Bytes of the input this frame occupied, so the caller can advance its buffer. */
  readonly consumed: number;
}

/**
 * Parse one client frame, or `undefined` if the buffer does not yet hold a whole one.
 *
 * Returning `undefined` rather than throwing on a short buffer is the important half: a TCP read
 * boundary is not a protocol error, and treating it as one would drop a legitimate frame that had
 * merely arrived in two pieces.
 *
 * `maxPayload` is the SERVER's policy, not the codec's, which is why it is a parameter and why it
 * defaults to no cap: the pure framing tests exercise encodings without taking a view on size, and
 * `Connection` -- the only production caller -- always passes one. It has to be checked HERE rather
 * than by the caller, because refusing a frame that merely DECLARES four gigabytes has to happen
 * from its header alone, before the payload it promised is waited for and buffered.
 */
export function parseFrame(buf: Buffer, maxPayload = Number.MAX_SAFE_INTEGER): Frame | undefined {
  if (buf.length < 2) return undefined;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;

  // CHECKED BEFORE THE LENGTH, DELIBERATELY. The mask bit is bit 7 of byte 1, so it is already
  // known here and this test has no dependency on the extended length. Do it afterwards and an
  // unmasked frame gets diagnosed by bytes that are really PAYLOAD read as a length -- reported as
  // `frame length out of range`, which sends whoever is debugging a hand-rolled or half-finished
  // client hunting an oversized frame that does not exist instead of one bit in the second byte.
  // An unmasked frame is also never worth waiting for more bytes on, so this precedes the
  // short-buffer returns below rather than following them.
  if (!masked) throw new Error('client frame is not masked, which RFC 6455 §5.1 requires');

  if (len === 126) {
    if (buf.length < off + 2) return undefined;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return undefined;
    const big = buf.readBigUInt64BE(off);
    // A frame larger than this is a bug or an attack; Buffer cannot hold it anyway.
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame length out of range');
    len = Number(big);
    off += 8;
  }

  // Before the masking key and the payload are waited for, so an oversized declaration costs one
  // read rather than however much memory it asked for.
  if (len > maxPayload) throw new Error(`frame payload of ${len} exceeds the ${maxPayload} cap`);

  if (buf.length < off + 4) return undefined;
  const key = buf.subarray(off, off + 4);
  off += 4;
  if (buf.length < off + len) return undefined;

  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) payload[i] = buf[off + i]! ^ key[i % 4]!;
  return { fin, opcode, payload, consumed: off + len };
}

/** Serialise one unmasked server frame. Always final; we never fragment outbound. */
export function serializeFrame(opcode: number, payload: Buffer): Buffer {
  // A GUARD RATHER THAN A COMMENT, because the failure is silent and downstream. Byte 0 shares its
  // high nibble with FIN and the three RSV bits, so `0x10` would not be rejected by anything -- it
  // would set RSV1, which a browser reads as "an extension negotiated that we never agreed", and
  // the connection would fail somewhere unrelated to the caller that passed the wrong number.
  if (!Number.isInteger(opcode) || opcode < 0 || opcode > 0x0f) {
    throw new Error(`opcode ${opcode} does not fit the 4 bits RFC 6455 gives it`);
  }
  let head: Buffer;
  if (payload.length < 126) {
    head = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([head, payload]);
}
