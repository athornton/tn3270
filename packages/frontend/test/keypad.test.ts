import { describe, it, expect } from 'vitest';
import { KEYPAD_KEYS, KEYPAD_ROWS, KEYPAD_KEY_WIDTH } from '../src/keypad.js';
import { PF_AIDS, PA_AIDS } from '@tn3270/core';

describe('KEYPAD_KEYS', () => {
  it('has 48 keys, which is the layout in the spec plus the transfer button', () => {
    // 47 = c3270's 44 (`Common/c3270/keypad.callbacks`) minus Cursor Select and Compose, plus the
    // four cursor arrows and Backspace. It was 46 until Newline -- which c3270's keypad has and
    // this table had dropped without noticing -- was added on the user's decision.
    //
    // 48 SINCE `Xfer`, which c3270 has NO equivalent of at all: file transfer is a menu item
    // there, not a keypad key. It is here so the GUI gets the button for free when stage 3 ports
    // the form, and it is the first key whose action `applyAction` throws on.
    expect(KEYPAD_KEYS).toHaveLength(48);
  });

  it('carries every PF and PA key exactly once', () => {
    const pf = KEYPAD_KEYS.filter((k) => k.action.kind === 'pf');
    const pa = KEYPAD_KEYS.filter((k) => k.action.kind === 'pa');
    expect(pf).toHaveLength(PF_AIDS.length);
    expect(pa).toHaveLength(PA_AIDS.length);
    // Numbered 1..24 and 1..3 with no gaps and no repeats.
    expect([...pf].map((k) => (k.action as { n: number }).n).sort((a, b) => a - b))
      .toEqual(Array.from({ length: PF_AIDS.length }, (_, i) => i + 1));
    expect([...pa].map((k) => (k.action as { n: number }).n).sort((a, b) => a - b))
      .toEqual(Array.from({ length: PA_AIDS.length }, (_, i) => i + 1));
  });

  it('has no duplicate labels and no duplicate actions', () => {
    const labels = KEYPAD_KEYS.map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
    const actions = KEYPAD_KEYS.map((k) => JSON.stringify(k.action));
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('names every key, with no duplicate names', () => {
    // The TUI overlay lists keys by `name`; two rows reading the same would be two rows a
    // keyboard user cannot tell apart. A label can be cryptic, a name may not be empty.
    for (const k of KEYPAD_KEYS) expect(k.name.length).toBeGreaterThan(0);
    const names = KEYPAD_KEYS.map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('never carries an action whose button would be SELF-DEFEATING', () => {
    // `quit`, `toggleKeypad` and `transferForm` all throw inside applyAction, so "throws" is
    // NOT the rule -- `transferForm` is a keypad key. The rule is whether a BUTTON makes sense:
    //
    //  - `quit` would tear down the window the button is drawn in.
    //  - `toggleKeypad` would hide the surface the button is drawn on, so the only way to press
    //    it twice is to find the chord anyway.
    //  - `transferForm` opens a dialog, which is a perfectly sensible thing to click, and the
    //    front end intercepts the button exactly as it intercepts Ctrl-T.
    //
    // THE TITLE USED TO SAY "an action a front end must intercept", and that became false the
    // moment a third throwing action was a legitimate key. Named individually rather than
    // derived from the throw, so adding a fourth is a decision someone writes down here.
    for (const k of KEYPAD_KEYS) {
      expect(k.action.kind).not.toBe('quit');
      expect(k.action.kind).not.toBe('toggleKeypad');
    }
  });

  it('labels every PF and PA key with its own number', () => {
    // Mechanical, and so free for 27 of the 47: a `PF7` button that sends PF8 is invisible to
    // every other test here and to a pixel golden, since both labels draw fine.
    for (const k of KEYPAD_KEYS) {
      if (k.action.kind === 'pf') expect(k.label).toBe(`PF${(k.action as { n: number }).n}`);
      if (k.action.kind === 'pa') expect(k.label).toBe(`PA${(k.action as { n: number }).n}`);
    }
  });

  it('gives each of the 21 special keys the action its label names', () => {
    // THE DUPLICATION BELOW IS DELIBERATE. This restates the source's label-to-action mapping, and
    // that is the point: it is a second, independently written statement of a critical lookup
    // table, which is the only thing that can catch a label naming the wrong action. Swap `Del`'s
    // action with `BkSp`'s and every other test here stays green -- and the drawn pixels are
    // IDENTICAL, so Task 14's goldens cannot see it either. Task 13 clicks only 9 of the 47.
    //
    // Grouped by what the key DOES, deliberately not in the source table's row-by-row order, so a
    // mismatch has to survive being read in two different arrangements.
    const expected = new Map<string, string>([
      // Moving the cursor. `NewLn` is one of these and not an AID: `Keyboard.newline()` moves to
      // the first unprotected cell of the next line and sends nothing.
      ['^', 'up'], ['v', 'down'], ['<', 'left'], ['>', 'right'],
      ['Home', 'home'], ['Tab', 'tab'], ['BkTab', 'backTab'], ['NewLn', 'newline'],
      // Changing what is in the field.
      ['BkSp', 'backspace'], ['Del', 'delete'],
      ['ErEOF', 'eraseEOF'], ['ErInp', 'eraseInput'], ['Ins', 'toggleInsert'],
      // Typed characters rather than AIDs -- see the note in keymap.ts.
      ['Dup', 'dup'], ['FldMk', 'fieldMark'],
      // Sent to the host, or handled locally.
      ['Enter', 'enter'], ['Clear', 'clear'], ['Attn', 'attn'],
      ['SysRq', 'sysreq'], ['Reset', 'reset'],
      // Opens a form rather than doing anything, because a transfer needs arguments.
      ['Xfer', 'transferForm'],
    ]);
    // RE-DERIVED, not bumped: the table is 12 + 12 PF keys and 3 PA keys, which is 27 the loop
    // below excludes by `kind`, so the specials are 48 - 27 = 21. This line and the length check on
    // `special` come at it from the two different sides -- what this map says, and what the source
    // table holds -- so adding a key here and not there (or there and not here) fails.
    expect(expected.size).toBe(21);
    expect(KEYPAD_KEYS).toHaveLength(27 + expected.size);

    const special = KEYPAD_KEYS.filter((k) => k.action.kind !== 'pf' && k.action.kind !== 'pa');
    expect(special).toHaveLength(expected.size);
    for (const k of special) {
      expect(expected.get(k.label), `no expected action for label ${k.label}`).toBeDefined();
      expect(k.action.kind).toBe(expected.get(k.label));
      expected.delete(k.label);
    }
    // Nothing expected went unmatched: a renamed or deleted key fails here rather than passing
    // because the loop above simply never visited it.
    expect([...expected.keys()]).toEqual([]);
  });

  it('labels fit the width the layout reserves', () => {
    // The canvas layout gives each key a fixed cell width; a longer label would overflow into
    // its neighbour, silently, because the blitter clips nothing.
    for (const k of KEYPAD_KEYS) expect(k.label.length).toBeLessThanOrEqual(5);
  });

  it('groups into exactly the rows the layout expects, each within 72 columns', () => {
    expect(KEYPAD_ROWS).toHaveLength(5);
    for (const row of KEYPAD_ROWS) {
      const keys = KEYPAD_KEYS.filter((k) => k.row === row);
      expect(keys.length).toBeGreaterThan(0);
      const widest = Math.max(...keys.map((k) => k.col + KEYPAD_KEY_WIDTH));
      expect(widest).toBeLessThanOrEqual(72);
    }
  });

  it('puts every key in a row KEYPAD_ROWS declares, on a whole-key column boundary', () => {
    // Task 5 turns `col` into pixels as `col * cellWidth`, so a `col` that is not a multiple of
    // KEYPAD_KEY_WIDTH would draw a button straddling its neighbour's cells.
    for (const k of KEYPAD_KEYS) {
      expect(KEYPAD_ROWS).toContain(k.row);
      expect(k.col % KEYPAD_KEY_WIDTH).toBe(0);
      expect(k.col).toBeGreaterThanOrEqual(0);
    }
  });

  it('never overlaps two keys in a row', () => {
    // The invariant a transposed or mistyped `col` breaks: two buttons sharing cells means one
    // draws over the other and the hit test resolves a click to whichever came first.
    for (const row of KEYPAD_ROWS) {
      const cols = KEYPAD_KEYS.filter((k) => k.row === row).map((k) => k.col);
      expect(new Set(cols).size).toBe(cols.length);
      const sorted = [...cols].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(KEYPAD_KEY_WIDTH);
      }
    }
  });
});
