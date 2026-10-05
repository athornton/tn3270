import { describe, it, expect } from 'vitest';
import { KEYPAD_BLOCKS, tooltipFor } from '../src/keypadView.js';
import { KEYPAD_KEYS, type KeypadKey } from '../src/keypad.js';

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

describe('tooltipFor', () => {
  it('uses the key NAME for a key with no BINDING_INTENT entry', () => {
    // MEASURED 2026-10-06: `BINDING_INTENT` has an ENTRY for 26 of the 48 keys. The 22 without
    // are PF14-24, PF2-11, SysRq and NewLn. Those must still get a tooltip, or a third of the
    // window is bare.
    expect(tooltipFor(byLabelInTest('PF14'))).toBe('PF14');
    expect(tooltipFor(byLabelInTest('SysRq'))).toBe('System Request');
  });

  it('uses the key NAME when a binding EXISTS but carries no note', () => {
    /**
     * THE CASE THAT IS NOT THE SAME AS "no entry", AND IT IS THE BIGGER OF THE TWO. `note` is
     * OPTIONAL on `Binding` (`bindings.ts:32`), and MEASURED 2026-10-06, 15 keypad keys match an
     * entry that has none: PF1, PF3, PA2, PA3, Home, all four arrows, Reset, ErInp, Tab, BkTab,
     * Del, BkSp -- most of the cursor cluster among them.
     *
     * So "found a binding" and "has prose" are different questions. Reading `binding.note` after
     * checking only `binding === undefined` throws on all 15, which is what the first draft of
     * `tooltipFor` did.
     */
    expect(tooltipFor(byLabelInTest('Tab'))).toBe('Tab');
    expect(tooltipFor(byLabelInTest('Home'))).toBe('Home');
    expect(tooltipFor(byLabelInTest('<'))).toBe('Cursor left');
  });

  it('APPENDS the BINDING_INTENT note when there is one', () => {
    // `BINDING_INTENT` holds prose nothing currently shows a user, which is the cheapest visible
    // win in this whole feature. Matched on the ACTION, not the label: its `key` field is a chord
    // like 'Ctrl-C', not a keypad label, so matching on it would silently find nothing for most
    // keys -- and "silently finds nothing" is indistinguishable from "has no note".
    const tip = tooltipFor(byLabelInTest('Clear'));
    expect(tip.startsWith('Clear')).toBe(true);
    expect(tip).toContain('MORE...');          // from the Clear note
    expect(tip.length).toBeGreaterThan('Clear'.length);
  });

  it('NEVER returns an empty tooltip, for any of the 48', () => {
    // The property, rather than a spot check: a blank `title` attribute is a tooltip that
    // flickers and says nothing, which is worse than none at all.
    for (const key of KEYPAD_KEYS) {
      expect(tooltipFor(key), `${key.label} has no tooltip`).not.toBe('');
    }
  });

  it('never repeats the name when the note already starts with it', () => {
    // Guards the join, not the data: "Enter -- the Enter AID ..." must not come out as
    // "Enter -- Enter -- ...". Checked across all 48 rather than on one example, because which
    // notes happen to open with their own key name is data that can change.
    for (const key of KEYPAD_KEYS) {
      expect(tooltipFor(key)).not.toMatch(/^(.+?) -- \1/);
    }
  });
});

/**
 * Local lookup, so these tests do not depend on `keypadView`'s private helper.
 *
 * THROWS rather than returning undefined: a typo in a label here would otherwise make
 * `tooltipFor(undefined)` the thing under test, which fails for the wrong reason.
 */
function byLabelInTest(label: string): KeypadKey {
  const k = KEYPAD_KEYS.find((x) => x.label === label);
  if (k === undefined) throw new Error(`test asked for a missing label ${label}`);
  return k;
}
