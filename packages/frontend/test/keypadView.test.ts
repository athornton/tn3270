import { describe, it, expect } from 'vitest';
import { KEYPAD_BLOCKS } from '../src/keypadView.js';
import { KEYPAD_KEYS } from '../src/keypad.js';

describe('KEYPAD_BLOCKS', () => {
  it('accounts for EVERY key exactly once', () => {
    // THE PROPERTY THAT MATTERS: a regrouping must not lose a key. 48 buttons in, 48 out, and
    // no key in two blocks -- which a hand-written grouping can easily do and which would
    // present as a duplicate button rather than as an error.
    const grouped = KEYPAD_BLOCKS.flatMap((b) => b.keys);
    expect(grouped).toHaveLength(KEYPAD_KEYS.length);
    expect(new Set(grouped.map((k) => k.label)).size).toBe(KEYPAD_KEYS.length);
    expect([...grouped].map((k) => k.label).sort())
      .toEqual([...KEYPAD_KEYS].map((k) => k.label).sort());
  });

  it('puts the PF keys in two rows of twelve, in numeric order', () => {
    // PF13-24 ABOVE PF1-12, which is the shipped layout and x3270's: the canvas keypad put
    // row 0 at PF13 deliberately (`KEYPAD_KEYS` opens with `pfRow(0, 13)`, and its header cites
    // `Common/c3270/keypad.labels:2` and `:4` for c3270 doing the same). A DOM layout that
    // reordered them would be a silent relearn for anyone used to the old one.
    const pf = KEYPAD_BLOCKS.filter((b) => b.id === 'pf-high' || b.id === 'pf-low');
    expect(pf).toHaveLength(2);
    expect(pf[0]!.keys.map((k) => k.label)[0]).toBe('PF13');
    expect(pf[0]!.keys).toHaveLength(12);
    expect(pf[1]!.keys.map((k) => k.label)[0]).toBe('PF1');
    expect(pf[1]!.keys).toHaveLength(12);
  });

  it('gives every block a non-empty id and title', () => {
    // The title is a visible heading, so an empty one is a blank label in the window.
    for (const b of KEYPAD_BLOCKS) {
      expect(b.id, 'a block has no id').not.toBe('');
      expect(b.title, `block ${b.id} has no title`).not.toBe('');
      expect(b.keys.length, `block ${b.id} is empty`).toBeGreaterThan(0);
      // LOWERCASE AND HYPHENATED, which `keypadView.ts` documents as the rule because the id
      // reaches a DOM `id` attribute and a CSS selector -- and nothing enforced it until this
      // line. The two ways it can go wrong FAIL DIFFERENTLY, and an earlier draft of this comment
      // had them backwards. MEASURED in Electron's own Chromium 152.0.7977.78 under this repo's
      // Xvfb harness (`gui/scripts/xvfb.mjs`), not assumed:
      //
      //   `querySelector('#PF High')` does NOT throw. It is a VALID selector meaning "a
      //   descendant `High` of an element with id `PF`", so it returned null -- the window
      //   wires up no buttons for that block and reports nothing anywhere.
      //
      //   `querySelector('#1cursor')` DOES throw, a `DOMException` whose `name` is
      //   `SyntaxError` (`instanceof DOMException` confirmed true): an identifier may not
      //   start with a digit.
      //
      // The silent one is the worse of the two, which is the real argument for this assertion:
      // a throw at least names the problem, while a null is a block of dead buttons with
      // nothing in the model to point at.
      expect(b.id, `block id ${b.id} is not a safe DOM id`).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('has no block with a duplicate id', () => {
    const ids = KEYPAD_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
