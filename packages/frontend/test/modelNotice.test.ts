import { describe, it, expect, beforeEach } from 'vitest';
import { monoModelNotice, resetMonoModelNotice } from '../src/modelNotice.js';

describe('monoModelNotice', () => {
  beforeEach(() => { resetMonoModelNotice(); });
  it('the first 3278 name gets the notice, naming the color form', () => {
    expect(monoModelNotice('3278-4-E')).toBe('-model 3278-4-E now means a mono 3278, as in x3270; for color use 3279-4-E');
  });
  it('only once per process', () => {
    monoModelNotice('3278-2');
    expect(monoModelNotice('3278-4')).toBeUndefined();
  });
  it('nothing for 3279, bare, absent or unparseable names, and they do not use up the notice', () => {
    for (const m of ['3279-2-E', '4', undefined, 'bogus']) expect(monoModelNotice(m)).toBeUndefined();
    expect(monoModelNotice('3278-3')).toMatch(/for color use 3279-3$/);
  });
});
