import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeFileError } from '../src/seamFile.js';

/** The real error `fs` throws for `f`, so the tests are about Node's shapes and not a guess at them. */
function thrown(f: () => unknown): unknown {
  try {
    f();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('describeFileError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seamfile-'));

  it('names the seam, the path and the code for a missing file, without repeating the path', () => {
    const path = join(dir, 'missing.trace');
    const err = thrown(() => readFileSync(path, 'utf8'));
    expect(describeFileError('replay', 'read', path, err))
      .toBe(`replay: cannot read ${path}: ENOENT no such file or directory`);
  });

  it('describes a directory given as the file (EISDIR), whose message names no path', () => {
    const err = thrown(() => readFileSync(dir, 'utf8'));
    expect(describeFileError('replay', 'read', dir, err))
      .toBe(`replay: cannot read ${dir}: EISDIR illegal operation on a directory`);
  });

  it('describes a write into a missing directory, for the shot seam', () => {
    const path = join(dir, 'nodir', 'x.png');
    const err = thrown(() => writeFileSync(path, 'x'));
    expect(describeFileError('shot', 'write', path, err))
      .toBe(`shot: cannot write ${path}: ENOENT no such file or directory`);
  });

  it('keeps the code for the sandbox case CI hit (EPERM), built as Node builds it', () => {
    const path = '/Users/runner/synthetic-ispf-like.trace';
    const err = Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`),
      { code: 'EPERM', syscall: 'open', path });
    expect(describeFileError('replay', 'read', path, err))
      .toBe(`replay: cannot read ${path}: EPERM operation not permitted`);
  });

  it('passes an uncoded error message through whole', () => {
    expect(describeFileError('replay', 'read', '/x', new Error('something else')))
      .toBe('replay: cannot read /x: something else');
  });

  it('still says something for a thrown non-Error', () => {
    expect(describeFileError('replay', 'read', '/x', 'boom')).toBe('replay: cannot read /x: boom');
  });
});
