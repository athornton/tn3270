import { describe, it, expect } from 'vitest';
import {
  CHUNK_BYTES, MAX_TRANSFER_BYTES, chunkBytes, ChunkReassembler,
} from '../src/transferChunk.js';
// THE REAL CAP, IMPORTED RATHER THAN RESTATED. The headroom case below used to assert against a
// bare `6000`, which is unanchored: lowering `MAX_MESSAGE_BYTES` to 5000 would break the premise
// of the whole module while that test stayed green.
import { MAX_MESSAGE_BYTES } from '../src/wsserver.js';

describe('chunkBytes', () => {
  it('splits a buffer into chunks no larger than CHUNK_BYTES', () => {
    const src = new Uint8Array(CHUNK_BYTES * 2 + 17).fill(7);
    const chunks = chunkBytes(src);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(CHUNK_BYTES);
    expect(chunks[2]!.length).toBe(17);
  });

  it('leaves room under the real frame cap once base64 expands a chunk', () => {
    // ENCODED BY THE ENCODER, not by re-deriving the implementation's own formula. An earlier
    // version of this case computed `Math.ceil(CHUNK_BYTES / 3) * 4` and asserted on its own
    // arithmetic, which cannot fail for the right reason; this asks `Buffer` what a real chunk
    // weighs on the wire.
    const encoded = Buffer.from(new Uint8Array(CHUNK_BYTES)).toString('base64').length;
    expect(encoded).toBe(5464);
    // AGAINST THE IMPORTED CAP, so a change to `MAX_MESSAGE_BYTES` reddens this rather than
    // silently invalidating the reason CHUNK_BYTES is 4096.
    expect(encoded).toBeLessThan(MAX_MESSAGE_BYTES);
    // And comfortably under, not merely under: the JSON envelope rides along in the same frame.
    expect(MAX_MESSAGE_BYTES - encoded).toBeGreaterThan(2000);
  });

  it('shows why the obvious CHUNK_BYTES would NOT fit, which is the trap the constant avoids', () => {
    // The premise, asserted rather than asserted-about: a chunk sized at the cap itself encodes
    // to 10924 bytes and would close the socket.
    const atTheCap = Buffer.from(new Uint8Array(MAX_MESSAGE_BYTES)).toString('base64').length;
    expect(atTheCap).toBeGreaterThan(MAX_MESSAGE_BYTES);
  });

  it('returns one empty-safe chunk list for an empty file', () => {
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });
});

describe('ChunkReassembler', () => {
  it('reassembles chunks in order into the declared total', () => {
    const r = new ChunkReassembler(5);
    expect(r.accept(0, new Uint8Array([1, 2, 3]))).toEqual({ ok: true, done: false });
    expect(r.accept(1, new Uint8Array([4, 5]))).toEqual({ ok: true, done: true });
    expect(r.bytes()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('rejects a chunk that arrives out of sequence, rather than guessing', () => {
    const r = new ChunkReassembler(5);
    r.accept(0, new Uint8Array([1, 2, 3]));
    const out = r.accept(5, new Uint8Array([4, 5]));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/out of sequence/);
  });

  it('rejects a duplicate sequence number', () => {
    const r = new ChunkReassembler(5);
    r.accept(0, new Uint8Array([1, 2, 3]));
    const out = r.accept(0, new Uint8Array([9, 9, 9]));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/out of sequence/);
  });

  it('rejects bytes exceeding the declared total', () => {
    const r = new ChunkReassembler(4);
    const out = r.accept(0, new Uint8Array([1, 2, 3, 4, 5]));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/exceeds declared/);
  });

  it('refuses a declared total over the 10 MB cap, naming both numbers', () => {
    // Decision 2: the refusal must be explicit, so the message carries the limit AND the
    // size. A fixed-width or truncated message would eat the remedy.
    expect(() => new ChunkReassembler(MAX_TRANSFER_BYTES + 1))
      .toThrow(/10485761 bytes exceeds the 10485760-byte limit/);
  });

  it('accepts a declared total exactly AT the cap, which is not over it', () => {
    // The off-by-one on the operator's side of the limit: 10 MB on the nose must work.
    expect(() => new ChunkReassembler(MAX_TRANSFER_BYTES)).not.toThrow();
  });

  it('rejects a malformed declared total as MALFORMED, not as too large', () => {
    // THE GUARD ORDER IS WHAT THIS PINS. With the cap tested first, `Infinity` and `1e9 + 0.5`
    // both answered "exceeds the 10485760-byte limit" -- which tells an operator to try a
    // smaller file when the real fault is a client sending nonsense. Measured 2026-10-06.
    for (const bad of [Infinity, 1e9 + 0.5, -1, 5.5, NaN]) {
      expect(() => new ChunkReassembler(bad), String(bad))
        .toThrow(/must be a non-negative integer/);
    }
  });

  it('is complete at construction for a zero-byte transfer, where accept never runs', () => {
    // `chunkBytes` emits nothing for an empty file, so a caller waiting on `accept`'s `done`
    // would wait forever. `complete()` is the question to ask.
    const r = new ChunkReassembler(0);
    expect(r.complete()).toBe(true);
    expect(r.bytes()).toEqual(new Uint8Array(0));
  });

  it('ABANDONS the transfer after a refusal, instead of completing anyway', () => {
    // The comment used to claim a bad chunk "abandons the transfer" while nothing abandoned
    // anything: the reject paths changed no state, so feeding the right chunk next completed
    // the transfer and delivered a file with a hole in it as a success. Measured 2026-10-06.
    const r = new ChunkReassembler(5);
    r.accept(0, new Uint8Array([1, 2, 3]));
    expect(r.accept(7, new Uint8Array([4, 5])).ok).toBe(false);
    const after = r.accept(1, new Uint8Array([4, 5]));
    expect(after.ok, 'a refused reassembler must not complete').toBe(false);
    expect(r.complete()).toBe(false);
    expect(r.bytes()).toBeUndefined();
  });

  it('refuses a chunk arriving after every declared byte is in', () => {
    const r = new ChunkReassembler(3);
    expect(r.accept(0, new Uint8Array([1, 2, 3]))).toEqual({ ok: true, done: true });
    const extra = r.accept(1, new Uint8Array(0));
    expect(extra.ok).toBe(false);
    if (extra.ok) throw new Error('narrowing');
    expect(extra.error).toMatch(/after all 3 bytes/);
  });

  it('is not done until every declared byte has arrived', () => {
    const r = new ChunkReassembler(10);
    expect(r.accept(0, new Uint8Array([1, 2, 3]))).toEqual({ ok: true, done: false });
    expect(r.bytes()).toBeUndefined();
  });
});
