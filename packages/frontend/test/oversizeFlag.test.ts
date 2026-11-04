import { describe, it, expect } from 'vitest';
import { takeOversizeFlag, OVERSIZE_USAGE } from '../src/oversizeFlag.js';
import type { Oversize } from '@tn3270/core';

/**
 * `-oversize`, shared by every front end -- mirrors `tls.test.ts`'s coverage of
 * `takeTlsFlag`. Design: docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md
 */
class UsageError extends Error {}
const usage = (m: string) => new UsageError(m);

describe('takeOversizeFlag', () => {
  it('consumes -oversize <cols>x<rows>, eating one extra argv entry', () => {
    const out: { oversize?: Oversize } = {};
    const eaten = takeOversizeFlag(out, '-oversize', '160x62', usage);
    expect(eaten).toBe(1);
    expect(out.oversize).toEqual({ kind: 'fixed', rows: 62, cols: 160 });
  });

  it('ignores a flag that is not its own', () => {
    const out: { oversize?: Oversize } = {};
    expect(takeOversizeFlag(out, '-model', '3278-2-E', usage)).toBeUndefined();
    expect(out.oversize).toBeUndefined();
  });

  it('rejects a missing value', () => {
    const out: { oversize?: Oversize } = {};
    expect(() => takeOversizeFlag(out, '-oversize', undefined, usage))
      .toThrow(/-oversize needs a value: <cols>x<rows>, auto or none/);
  });

  it('turns a bad value into the caller\'s error class, carrying parseOversize\'s message', () => {
    const out: { oversize?: Oversize } = {};
    expect(() => takeOversizeFlag(out, '-oversize', 'nonsense', (m) => new RangeError(m)))
      .toThrow(RangeError);
    try {
      takeOversizeFlag(out, '-oversize', 'nonsense', (m) => new RangeError(m));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RangeError);
      expect((e as Error).message).toMatch(/-oversize takes <cols>x<rows>, auto or none/);
    }
  });
});

describe('OVERSIZE_USAGE', () => {
  it('names the flag and its three forms', () => {
    expect(OVERSIZE_USAGE).toBe('[-oversize <cols>x<rows>|auto|none]');
  });
});
