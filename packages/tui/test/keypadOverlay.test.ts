import { describe, expect, it } from 'vitest';
import { BINDING_INTENT, KEYPAD_KEYS, type Action } from '@tn3270/frontend';
import {
  moveSelection, overlayFits, overlayLines, selectedAction, OVERLAY_MIN,
} from '../src/keypadOverlay.js';

/**
 * Where the chord column starts, recomputed here rather than imported.
 *
 * The module computes its own name column from `KEYPAD_KEYS`; computing it a second way here is
 * what makes the pair able to DISAGREE. A hardcoded name width in the module (12, say, which fits
 * every name except `System Request`) would shift this offset and redden the alignment test.
 *
 * 1 cell of selection mark + 1 space + the longest name + 2 spaces.
 */
const CHORD_COL = 2 + Math.max(...KEYPAD_KEYS.map((k) => k.name.length)) + 2;

/**
 * Does `a` describe the same action as `b`?
 *
 * Deliberately structural and NOT `JSON.stringify`, so that this test agrees with the module only
 * when the module is right rather than when it happens to serialise its literals in the same key
 * order. `pf`/`pa` carry `n` and `type` carries `text`; every other member of the union is its
 * `kind` alone (`frontend/src/keymap.ts:43-76`).
 */
const sameAction = (a: Action, b: Action): boolean =>
  a.kind === b.kind
  && ('n' in a ? 'n' in b && a.n === b.n : !('n' in b))
  && ('text' in a ? 'text' in b && a.text === b.text : !('text' in b));

/** The line for a named key, found by its index so that `PF1` cannot match `PF13`. */
const lineFor = (name: string): string => {
  const i = KEYPAD_KEYS.findIndex((k) => k.name === name);
  expect(i, `no key named ${name}`).toBeGreaterThanOrEqual(0);
  return overlayLines(-1)[i]!;
};

describe('overlayLines', () => {
  it('lists every key in the table, one line each, in table order', () => {
    // `KEYPAD_KEYS` is non-empty, which the module's `Math.max(...names)` relies on: an empty
    // table would make the name width -Infinity and `padEnd` throw. Asserted rather than guarded,
    // because a guard for a frozen 46-entry table would be unreachable code.
    expect(KEYPAD_KEYS.length).toBeGreaterThan(0);

    const lines = overlayLines(0);
    expect(lines).toHaveLength(KEYPAD_KEYS.length);
    // Position, not `toContain` over the joined text: `toContain('PF1')` is satisfied by the PF13
    // line, and by a single line holding all 46 names, and by any order at all.
    KEYPAD_KEYS.forEach((k, i) => {
      expect(lines[i]!.slice(2, 2 + k.name.length)).toBe(k.name);
    });
  });

  it('shows the chord beside a key that has one, and nothing beside one that has none', () => {
    // Sys Req deliberately has no chord (c3270 defines none), which is WHY the overlay exists: it
    // is the only keyboard route to it. A blank there is correct, not missing.
    //
    // Asserted as a WHOLE LINE with `toBe`, not as /System Request\s*$/m -- that regex is also
    // satisfied by a line with no chord column at all, by one with the wrong selection mark, and
    // by one that never trimmed its padding, so it would pass over a broken overlay.
    //
    // `System Request` is the longest name, so its padding is empty and its line is exact.
    expect(lineFor('System Request')).toBe('  System Request');

    // Chords that BINDING_INTENT holds TODAY. The plan asked for `Dup  Ctrl-D` and
    // `Field Mark  Ctrl-F`; those two rows are Task 4's to add and do not exist yet
    // (`frontend/src/bindings.ts` has no `dup`, `fieldMark` or `toggleKeypad` entry), so
    // asserting them here would fail for a reason that is not this module's. The mechanism test
    // below covers them the moment Task 4 lands, with no edit to this file.
    expect(lineFor('Reset')).toBe(`  Reset${' '.repeat(CHORD_COL - 7)}Ctrl-R`);
    expect(lineFor('Back Tab')).toBe(`  Back Tab${' '.repeat(CHORD_COL - 10)}Shift-Tab`);

    // The `n`-discriminated pair, written out as GROUND TRUTH rather than derived. The sweep below
    // recomputes the module's own matching rule, so a rule that is wrong the same way in both
    // would pass it; these two do not. A lookup that matched on `kind` alone hands every PF key
    // the first `pf` row's chord, so PF13 would read F1 -- and PF1 alone cannot tell the two
    // apart. Source: bindings.ts binds F1 to PF1 and Shift-F1 to PF13 (Shift+F(n) is PF(n+12)).
    expect(lineFor('PF1')).toBe(`  PF1${' '.repeat(CHORD_COL - 5)}F1`);
    expect(lineFor('PF13')).toBe(`  PF13${' '.repeat(CHORD_COL - 6)}Shift-F1`);
  });

  it('derives the chord column from BINDING_INTENT rather than a second list', () => {
    // The point of reading BINDING_INTENT: on-screen help that cannot drift from the bindings.
    // This sweeps all 46 keys, so a lookup that matched on `kind` alone -- and therefore gave
    // every PF key F1's chord -- reddens here even though the Reset line above still passes.
    const lines = overlayLines(-1);
    let withChord = 0;
    KEYPAD_KEYS.forEach((k, i) => {
      const want = BINDING_INTENT.find((b) => sameAction(b.action, k.action))?.key ?? '';
      expect(lines[i]!.slice(CHORD_COL), `chord for ${k.name}`).toBe(want);
      if (want !== '') withChord += 1;
    });
    // Both halves must be non-empty or the sweep proves nothing: all-blank would satisfy it just
    // as well if `chordFor` always returned ''.
    expect(withChord).toBeGreaterThan(0);
    expect(withChord).toBeLessThan(KEYPAD_KEYS.length);
  });

  it('aligns the chord column across every line', () => {
    for (const line of overlayLines(-1)) {
      // Either the line stopped at the name (no chord, padding trimmed) or its chord starts at
      // exactly the shared column with a gap before it.
      if (line.length <= CHORD_COL) continue;
      expect(line[CHORD_COL - 1]).toBe(' ');
      expect(line.slice(CHORD_COL)).toMatch(/^\S/);
    }
  });

  it('marks exactly one line as selected, and it is the requested one', () => {
    const lines = overlayLines(3);
    const marked = lines.filter((l) => l.startsWith('>'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toBe(lines[3]);
    // An out-of-range selection marks nothing, so the caller can render an unselected list.
    expect(overlayLines(-1).filter((l) => l.startsWith('>'))).toHaveLength(0);
  });
});

describe('moveSelection', () => {
  it('moves by one and CLAMPS rather than wrapping', () => {
    // Clamped, not wrapped: a wrap at 46 entries means holding an arrow silently cycles past the
    // key you were aiming at, which is worse than stopping.
    expect(moveSelection(0, -1)).toBe(0);
    expect(moveSelection(0, 1)).toBe(1);
    expect(moveSelection(KEYPAD_KEYS.length - 1, 1)).toBe(KEYPAD_KEYS.length - 1);
    expect(moveSelection(KEYPAD_KEYS.length - 1, -1)).toBe(KEYPAD_KEYS.length - 2);
  });

  it('clamps a page-sized jump to the ends rather than taking it modulo', () => {
    // A modulo would land mid-list here, which is the mistake this distinguishes from a clamp.
    expect(moveSelection(2, -10)).toBe(0);
    expect(moveSelection(KEYPAD_KEYS.length - 3, 10)).toBe(KEYPAD_KEYS.length - 1);
    expect(moveSelection(0, KEYPAD_KEYS.length * 3)).toBe(KEYPAD_KEYS.length - 1);
  });
});

describe('overlayFits', () => {
  it('refuses a terminal too small to hold it', () => {
    // The TUI's rule: never show a partial thing. It refuses the OVERLAY, not the session.
    expect(overlayFits({ rows: OVERLAY_MIN.rows - 1, cols: 80 })).toBe(false);
    expect(overlayFits({ rows: 24, cols: OVERLAY_MIN.cols - 1 })).toBe(false);
    expect(overlayFits({ rows: 24, cols: 80 })).toBe(true);
  });

  it('never refuses a terminal that can hold the smallest 3270 screen', () => {
    // This is the over-declaration pin. `tooSmall` already refuses any terminal below 24x80
    // (render.ts:43), so an OVERLAY_MIN above that would be a refusal no live session could ever
    // reach -- dead code dressed as a safety check. Raise either field past 24 or 80 and this
    // reddens.
    expect(overlayFits({ rows: 24, cols: 80 })).toBe(true);
    expect(OVERLAY_MIN.rows).toBeLessThanOrEqual(24);
    expect(OVERLAY_MIN.cols).toBeLessThanOrEqual(80);
  });

  it('is exactly wide enough for the widest line plus one cell of frame each side', () => {
    // The other half of the over-declaration pin: written down in the module, recomputed from the
    // content here, so the two can disagree. Too narrow and the caller must truncate a chord; too
    // wide and the overlay refuses room it does not need.
    const widest = Math.max(...overlayLines(-1).map((l) => l.length));
    expect(OVERLAY_MIN.cols).toBe(widest + 2);
  });
});

describe('selectedAction', () => {
  it('returns the action of the selected line', () => {
    KEYPAD_KEYS.forEach((k, i) => {
      expect(selectedAction(i)).toBe(k.action);
    });
  });

  it('clamps an out-of-range selection to the ends rather than returning undefined', () => {
    // `noUncheckedIndexedAccess` would let a missing clamp hand the caller `undefined` and crash
    // `applyAction` on a keystroke.
    expect(selectedAction(-5)).toBe(KEYPAD_KEYS[0]!.action);
    expect(selectedAction(KEYPAD_KEYS.length + 5))
      .toBe(KEYPAD_KEYS[KEYPAD_KEYS.length - 1]!.action);
  });
});
