import { describe, it, expect } from 'vitest';
import { cp037, bracket } from '@tn3270/core';
import { codePageFlag } from '../src/codepageFlag.js';
import { defaultSession } from '../src/session.js';

const err = (m: string): Error => new Error(`usage: ${m}`);

describe('codePageFlag', () => {
  it('resolves names and aliases', () => {
    expect(codePageFlag('-codepage', 'cp037', err)).toBe(cp037);
    expect(codePageFlag('-charset', 'oldibm', err)).toBe(bracket);
  });

  it('a missing value names the flag and the choices', () => {
    expect(() => codePageFlag('-codepage', undefined, err))
      .toThrow('usage: -codepage needs a value: bracket, cp037');
  });

  it('an unknown name puts the remedy first, through the caller\'s error type', () => {
    expect(() => codePageFlag('-charset', 'cp273', err))
      .toThrow("usage: -charset: use one of bracket, cp037 (got 'cp273')");
  });
});

describe('defaultSession code page', () => {
  const u = undefined;
  it('passes a chosen page to the session', () => {
    const s = defaultSession(u, u, u, u, u, u, u, u, u, cp037);
    expect(s.screen.snapshot().codePage).toBe('cp037');
  });

  it('absent means the default, bracket', () => {
    expect(defaultSession().screen.snapshot().codePage).toBe('bracket');
  });
});
