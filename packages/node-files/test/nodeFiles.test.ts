import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeTransferFiles } from '../src/index.js';

/**
 * These touch a REAL filesystem, in a real temp directory.
 *
 * That is deliberate and it is the whole reason this package exists: its only content is
 * the `node:fs` coupling, so an in-memory double would test nothing but itself. The four
 * methods are what a transfer needs, and every one of them has a failure mode below that a
 * naive implementation gets wrong.
 */
describe('nodeTransferFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tn3270-nf-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips bytes through write and read', () => {
    const p = join(dir, 'a.bin');
    // Includes 0x00 and 0xff: these are file BYTES and nothing in the path may decode
    // them. A string round trip would pass here while corrupting every binary.
    const bytes = new Uint8Array([0x00, 0x41, 0xff, 0x0a, 0x1a]);
    nodeTransferFiles.write(p, bytes);
    expect(Array.from(nodeTransferFiles.read(p))).toEqual(Array.from(bytes));
  });

  it('reports existence, and a DIRECTORY exists', () => {
    expect(nodeTransferFiles.exists(join(dir, 'missing'))).toBe(false);
    writeFileSync(join(dir, 'there'), 'x');
    expect(nodeTransferFiles.exists(join(dir, 'there'))).toBe(true);
    // A directory exists. The Exist=keep check consults this, and a false here would wave
    // a directory through into a write() that fails with an EISDIR the operator cannot
    // read -- after the host has already been told to start.
    mkdirSync(join(dir, 'sub'));
    expect(nodeTransferFiles.exists(join(dir, 'sub'))).toBe(true);
  });

  it('write TRUNCATES and append EXTENDS', () => {
    const p = join(dir, 'b.bin');
    nodeTransferFiles.write(p, new Uint8Array([1, 2, 3]));
    nodeTransferFiles.write(p, new Uint8Array([9]));
    expect(Array.from(readFileSync(p))).toEqual([9]);
    nodeTransferFiles.append(p, new Uint8Array([8, 7]));
    expect(Array.from(readFileSync(p))).toEqual([9, 8, 7]);
  });

  it('append CREATES a missing file rather than throwing', () => {
    // Exist=append against a file that is not there is a legitimate first transfer, so
    // this must not require the caller to check first.
    const p = join(dir, 'fresh.bin');
    nodeTransferFiles.append(p, new Uint8Array([5]));
    expect(Array.from(readFileSync(p))).toEqual([5]);
  });

  it('read returns a plain Uint8Array view, not a pooled Buffer', () => {
    const p = join(dir, 'c.bin');
    writeFileSync(p, Buffer.from([1, 2]));
    const got = nodeTransferFiles.read(p);
    // `readFileSync` returns a Buffer, which IS a Uint8Array but carries extra methods and
    // a POOLED backing store -- so a caller holding it can see another read's bytes. A
    // fresh view is constructed so nothing downstream can be surprised by either.
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(got)).toBe(false);
  });

  it('read throws on a missing file', () => {
    // The caller turns this into "cannot read local file X" BEFORE the host is told
    // anything. Returning empty instead would be indistinguishable from a legitimately
    // empty file, which is a real transfer.
    expect(() => nodeTransferFiles.read(join(dir, 'nope'))).toThrow();
  });
});
