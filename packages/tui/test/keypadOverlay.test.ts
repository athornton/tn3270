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
 * `kind` alone (`frontend/src/keymap.ts:43-88`).
 */
const sameAction = (a: Action, b: Action): boolean =>
  a.kind === b.kind
  && ('n' in a ? 'n' in b && a.n === b.n : !('n' in b))
  && ('text' in a ? 'text' in b && a.text === b.text : !('text' in b));

/** The chord for a key, by the same rule the module uses and recomputed here, as `CHORD_COL` is. */
const chordOf = (action: Action): string =>
  BINDING_INTENT.find((b) => sameAction(b.action, action))?.key ?? '';

/**
 * The width of the chord column, and of the whole line, recomputed here for `CHORD_COL`'s reason.
 *
 * Every line is padded to `LINE_WIDTH` so the list paints an OPAQUE rectangle; a natural-length line
 * let the host's own cells show through in the chord column, which reads as a chord the key has not
 * got. A module that padded to the wrong width would still be uniform, so the width itself is pinned
 * in two directions: too wide and the `OVERLAY_MIN.cols` test below reddens (it recomputes the
 * widest line and demands 29), too narrow and the long lines are not padded at all, so the
 * uniform-width test reddens.
 */
const CHORD_WIDTH = Math.max(...KEYPAD_KEYS.map((k) => chordOf(k.action).length));
const LINE_WIDTH = CHORD_COL + CHORD_WIDTH;

/**
 * The whole line a key should render as: mark, space, the name in its column, the chord, padding.
 *
 * Built from the chord as GROUND TRUTH (the caller writes `Ctrl-R` out) and the geometry as
 * derivation, which is what the `' '.repeat(CHORD_COL - n)` expressions this replaces did before the
 * padding existed.
 */
const row = (name: string, chord: string): string =>
  `  ${name}${' '.repeat(CHORD_COL - 2 - name.length)}${chord}`.padEnd(LINE_WIDTH);

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
    // because a guard for a frozen 47-entry table would be unreachable code.
    expect(KEYPAD_KEYS.length).toBeGreaterThan(0);

    const lines = overlayLines(0);
    expect(lines).toHaveLength(KEYPAD_KEYS.length);
    // Position, not `toContain` over the joined text: `toContain('PF1')` is satisfied by the PF13
    // line, and by a single line holding all 47 names, and by any order at all.
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
    // by one padded to the wrong width, so it would pass over a broken overlay.
    //
    // A BLANK CHORD IS NOW REAL PADDING, not absent text: this was `toBe('  System Request')`, a
    // trimmed 18-column line, until the trim proved to be what let the host's cells show through
    // the chord column. `System Request` is the longest name, so the whole tail of this line is the
    // empty chord column, which makes it the strongest single line in the file for the padding.
    expect(lineFor('System Request')).toBe(row('System Request', ''));
    expect(lineFor('System Request')).toHaveLength(LINE_WIDTH);

    // NEWLINE'S BLANK IS THE SAME PROPERTY WITH A DIFFERENT CAUSE, and it is the reason this
    // assertion is here rather than left to the sweep below: c3270 DOES bind Newline, to Ctrl-J
    // (`Common/fb-c3270:190`), and this project deliberately does not -- Ctrl-J is `\n`, which the
    // terminal keymap already reads as `enter`. So a Ctrl-J row appearing in `BINDING_INTENT` would
    // make this line claim a chord that, in the TUI, submits the screen instead. Pinned as a whole
    // line, blanks and all, exactly as Sys Req's is.
    expect(lineFor('Newline')).toBe(row('Newline', ''));

    expect(lineFor('Reset')).toBe(row('Reset', 'Ctrl-R'));
    // `Shift-Tab` is a widest chord, so this line is the one that reaches `LINE_WIDTH` with content
    // rather than with padding -- it is what the padding above is padding TO.
    expect(lineFor('Back Tab')).toBe(row('Back Tab', 'Shift-Tab'));
    expect(lineFor('Back Tab').trimEnd()).toHaveLength(LINE_WIDTH);

    // Dup and Field Mark, blank until `Ctrl-D`/`Ctrl-F` reached `BINDING_INTENT` and filled in
    // here with NO EDIT to `keypadOverlay.ts`. Added as GROUND TRUTH now that the rows exist:
    // the sweep below recomputes the module's own lookup rule, so it would agree with a rule
    // that was wrong the same way in both places; these two lines would not.
    expect(lineFor('Dup')).toBe(row('Dup', 'Ctrl-D'));
    expect(lineFor('Field Mark')).toBe(row('Field Mark', 'Ctrl-F'));

    // The `n`-discriminated pair, written out as GROUND TRUTH rather than derived. The sweep below
    // recomputes the module's own matching rule, so a rule that is wrong the same way in both
    // would pass it; these two do not. A lookup that matched on `kind` alone hands every PF key
    // the first `pf` row's chord, so PF13 would read F1 -- and PF1 alone cannot tell the two
    // apart. Source: bindings.ts binds F1 to PF1 and Shift-F1 to PF13 (Shift+F(n) is PF(n+12)).
    expect(lineFor('PF1')).toBe(row('PF1', 'F1'));
    expect(lineFor('PF13')).toBe(row('PF13', 'Shift-F1'));
  });

  it('derives the chord column from BINDING_INTENT rather than a second list', () => {
    // The point of reading BINDING_INTENT: on-screen help that cannot drift from the bindings.
    // This sweeps all 47 keys, so a lookup that matched on `kind` alone -- and therefore gave
    // every PF key F1's chord -- reddens here even though the Reset line above still passes.
    const lines = overlayLines(-1);
    let withChord = 0;
    KEYPAD_KEYS.forEach((k, i) => {
      const want = chordOf(k.action);
      // `padEnd`, because the column is a fixed width now: a key with no chord must show blanks IN
      // THE COLUMN rather than nothing at all, and asserting the trimmed chord would pass either
      // way. All 22 chordless keys assert the padding here, not just Sys Req and Newline above.
      expect(lines[i]!.slice(CHORD_COL), `chord for ${k.name}`).toBe(want.padEnd(CHORD_WIDTH));
      if (want !== '') withChord += 1;
    });
    // Both halves must be non-empty or the sweep proves nothing: all-blank would satisfy it just
    // as well if `chordFor` always returned ''.
    expect(withChord).toBeGreaterThan(0);
    expect(withChord).toBeLessThan(KEYPAD_KEYS.length);
  });

  it('aligns the chord column across every line', () => {
    for (const line of overlayLines(-1)) {
      // The gap before the column, on every line: a name that ran into its chord would lose this.
      expect(line[CHORD_COL - 1], line).toBe(' ');
      const chord = line.slice(CHORD_COL);
      // A chordless key is now all blanks in the column, and this used to `continue` on a line that
      // simply ENDED there. Either shape satisfies "no chord", which is why the width is asserted.
      if (chord.trim() === '') {
        expect(chord, line).toHaveLength(CHORD_WIDTH);
        continue;
      }
      // A chord starts at exactly the shared column -- never one cell late, which a `padStart` or an
      // off-by-one gap would produce and which would still look plausible in a screenshot.
      expect(chord, line).toMatch(/^\S/);
    }
  });

  it('pads every line to ONE width, so the list paints an opaque rectangle', () => {
    // THE FIX THIS TEST EXISTS FOR. The lines were `trimEnd()`ed to their natural length, so the 22
    // keys with no chord ended at the name and the host's own cells stayed visible to the right of
    // them -- landing in the chord column, reading as a chord the key has not got. Measured over a
    // real pty against a fake host whose screen row 1 read `HELLO TN3270`, the PF16 row rendered as
    // `  PF16 TN3270`. Restore the `trimEnd()` and this reddens: the trimmed lines take 11 widths
    // (5, 6, 9, 16, 20-24, 26, 27), measured, not one.
    //
    // The MARKED line is in here too (`overlayLines(0)`), because it is the one drawn in reverse
    // video: a short bar would be the same bleed with a highlight on it.
    const widths = new Set(overlayLines(0).map((l) => l.length));
    expect(widths.size).toBe(1);
    // ...and the one width holds the whole content, so 'uniform' cannot mean 'all truncated'. Too
    // wide is caught by the `OVERLAY_MIN.cols` test below, which recomputes the widest line.
    expect([...widths][0]).toBe(LINE_WIDTH);
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
    // Clamped, not wrapped: a wrap at 47 entries means holding an arrow silently cycles past the
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

  it('is exactly wide enough for the line width plus one cell of frame each side', () => {
    // The other half of the over-declaration pin: written down in the module, recomputed from the
    // content here, so the two can disagree. Too narrow and the caller must truncate a chord; too
    // wide and the overlay refuses room it does not need.
    //
    // Every line is that width now rather than only the longest, so this ALSO pins the module's
    // `LINE_WIDTH` from above: pad to 30 and every line is 30, and 29 !== 32 reddens here.
    const widest = Math.max(...overlayLines(0).map((l) => l.length));
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
