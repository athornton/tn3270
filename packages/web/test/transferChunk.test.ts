import { describe, it, expect } from 'vitest';
import {
  CHUNK_BYTES, MAX_TRANSFER_BYTES, chunkBytes, ChunkReassembler,
} from '../src/transferChunk.js';

describe('chunkBytes', () => {
  it('splits a buffer into chunks no larger than CHUNK_BYTES', () => {
    const src = new Uint8Array(CHUNK_BYTES * 2 + 17).fill(7);
    const chunks = chunkBytes(src);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(CHUNK_BYTES);
    expect(chunks[2]!.length).toBe(17);
  });

  it('leaves room under the 8192-byte frame cap once base64 expands it', () => {
    // base64 is 4 bytes out per 3 in. The JSON envelope adds its own overhead, so the
    // encoded chunk must be comfortably under MAX_MESSAGE_BYTES, not merely under it.
    const encodedSize = Math.ceil(CHUNK_BYTES / 3) * 4;
    expect(encodedSize).toBeLessThan(6000);
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

  it('is not done until every declared byte has arrived', () => {
    const r = new ChunkReassembler(10);
    expect(r.accept(0, new Uint8Array([1, 2, 3]))).toEqual({ ok: true, done: false });
    expect(r.bytes()).toBeUndefined();
  });
});
