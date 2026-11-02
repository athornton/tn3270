import { describe, it, expect } from 'vitest';
import { createCopyCache } from '../src/copyCache.js';

const R = { top: 0, left: 0, bottom: 1, right: 11 };
const OTHER = { top: 2, left: 0, bottom: 3, right: 11 };

describe('copyCache, the prefetched text a copy event hands over synchronously', () => {
  it('has nothing until the answer arrives, then the text for that rect', () => {
    const c = createCopyCache();
    const gen = c.begin(R);
    expect(c.take(R)).toBeUndefined();
    c.accept(gen, ' MENU\n OPTION ===>');
    expect(c.take(R)).toBe(' MENU\n OPTION ===>');
  });

  // A cache filled for one selection must never answer for another: the copy would put text the
  // operator did not select on their clipboard.
  it('answers only for the rect that was asked about', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    expect(c.take(OTHER)).toBeUndefined();
    expect(c.take({ ...R })).toBe('TEXT');
  });

  // THE INTERLEAVING THE GENERATION EXISTS FOR. A new frame clears the selection (invalidate),
  // and the answer extracted from the OLD request arrives after it. It must be dropped even
  // though the operator has since dragged the SAME rect again over a changed screen.
  it('drops an answer that arrives after invalidate, even for the same rect', () => {
    const c = createCopyCache();
    const stale = c.begin(R);
    c.invalidate();
    const fresh = c.begin(R);
    c.accept(stale, 'OLD SCREEN');
    expect(c.take(R)).toBeUndefined();
    c.accept(fresh, 'NEW SCREEN');
    expect(c.take(R)).toBe('NEW SCREEN');
  });

  it('drops an answer superseded by a newer begin', () => {
    const c = createCopyCache();
    const first = c.begin(R);
    const second = c.begin(OTHER);
    c.accept(first, 'FIRST');
    expect(c.take(R)).toBeUndefined();
    expect(c.take(OTHER)).toBeUndefined();
    c.accept(second, 'SECOND');
    expect(c.take(OTHER)).toBe('SECOND');
  });

  // The selection survives a copy, so a second copy must find the same text.
  it('does not consume on take', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    expect(c.take(R)).toBe('TEXT');
    expect(c.take(R)).toBe('TEXT');
  });

  it('forgets on invalidate', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    c.invalidate();
    expect(c.take(R)).toBeUndefined();
  });

  // An all-blank rectangle extracts ''. Caching it would make a copy SET '' and cancel the
  // default, blanking the clipboard, where today's path sends nothing for an empty copy
  // (`web/src/main.ts`'s `copy` arm) and leaves the clipboard alone. Not caching it routes that
  // copy to the fallback, which keeps today's behavior.
  it('does not cache an empty answer', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), '');
    expect(c.take(R)).toBeUndefined();
  });
});
