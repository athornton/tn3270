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

  // THE INTERLEAVING THE GENERATION EXISTS FOR: a new frame clears the selection (invalidate),
  // the operator drags the SAME rect again over the changed screen (begin), and only then does
  // the answer extracted from the OLD, pre-invalidate request arrive. It must be dropped. (This
  // alone does not prove invalidate()'s own bump mattered, since the following begin() bumps gen
  // too -- see the next test, which invalidates with no later begin.)
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

  // `invalidate()` on its own, with NO later `begin()`, must still block a stale accept. Bumping
  // `gen`, clearing `asked`, and clearing `text` are each independently sufficient to do that
  // (defence in depth), so this test alone cannot tell which one did it -- the mutation that
  // removes all three together is what isolates this case from the one above.
  it('drops an answer that arrives after invalidate, with no later begin', () => {
    const c = createCopyCache();
    const stale = c.begin(R);
    c.invalidate();
    c.accept(stale, 'OLD SCREEN');
    expect(c.take(R)).toBeUndefined();
  });

  // A new drag must forget the previous answer: without this, the operator's clipboard would get
  // text from a selection they no longer have.
  it('a new begin forgets the previous answer', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'A');
    c.begin(OTHER);
    expect(c.take(OTHER)).toBeUndefined();
    expect(c.take(R)).toBeUndefined();
  });

  // `same()` compares all four fields of the rect. A rect that shares R's rows but differs only
  // in `left` or only in `right` -- what a shift-extended drag by one column produces -- must not
  // match, or the clipboard would get a column the operator did not select.
  it('does not answer for a rect that differs only in left or only in right', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    expect(c.take({ ...R, left: R.left + 1 })).toBeUndefined();
    expect(c.take({ ...R, right: R.right - 1 })).toBeUndefined();
  });

  // The SECOND request's answer can land before the first's late answer does. `take` must keep
  // reflecting the current selection (the second) and not revert once the stale first answer
  // shows up.
  it('keeps the current answer when a superseded request answers late', () => {
    const c = createCopyCache();
    const first = c.begin(R);
    const second = c.begin(OTHER);
    c.accept(second, 'SECOND');
    expect(c.take(OTHER)).toBe('SECOND');
    c.accept(first, 'FIRST');
    expect(c.take(OTHER)).toBe('SECOND');
    expect(c.take(R)).toBeUndefined();
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

  // A one-row all-blank rectangle extracts '' (`extractText` trims each line and joins with
  // `\n`, so a blank TWO-row rect gives '\n', not ''; that '\n' IS cached, matching the old path,
  // whose `web/src/main.ts` `copy` arm sends only when `text !== ''`). Caching '' would make a
  // copy SET '' and cancel the default, blanking the clipboard, where today's path sends nothing
  // for an empty copy and leaves the clipboard alone. Not caching it routes that copy to the
  // fallback, which keeps today's behavior.
  it('does not cache an empty answer', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), '');
    expect(c.take(R)).toBeUndefined();
  });
});
