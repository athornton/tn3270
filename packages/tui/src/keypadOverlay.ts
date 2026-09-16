/**
 * The special-keys overlay: the keypad table as a navigable list.
 *
 * PURE. Every function here is a total function of its arguments; nothing draws, nothing holds
 * state and nothing reads the terminal. `app.ts` owns the selection index and `render.ts` owns the
 * frame and the scroll window.
 *
 * ## WHY A LIST AND NOT c3270'S KEYPAD
 *
 * c3270's keypad is 16 rows tall and 78 columns wide (`Common/c3270/keypad.outline`, measured: 16
 * lines, longest 78). This TUI refuses to draw below 24 rows (`tooSmall` in `render.ts`) and
 * centres the screen above that, so a faithful keypad would have to hide two thirds of the 3270
 * display in order to show itself. A list overlays a corner instead, and can refuse to open at
 * all.
 *
 * ## THE CHORDS COME FROM `BINDING_INTENT`, NOT FROM A SECOND LIST
 *
 * That table already records key-to-action with a note, and `keymap.test.ts` already pins the
 * terminal keymap against it. Reading it here means the on-screen help cannot drift from the
 * bindings -- which is exactly the kind of documentation that otherwise rots. A key with no entry
 * shows a blank, and today 23 of the 46 do: PF2, PF4-PF11, PF14-PF24, Dup, Field Mark and Sys Req.
 *
 * Sys Req's blank is the whole reason this module exists. c3270 defines no chord for it, so the
 * overlay is its only keyboard route; a blank there is correct rather than missing. Dup and Field
 * Mark are blank only until Task 4 adds their rows to `BINDING_INTENT`, at which point they fill
 * in here with no edit to this file -- which is the property the indirection buys.
 */

import { BINDING_INTENT, KEYPAD_KEYS, type Action } from '@tn3270/frontend';
import type { Geometry } from './render.js';

/**
 * The smallest terminal this overlay will open in.
 *
 * `cols` is the widest line (27: mark, space, the 14-character `System Request`, two spaces and
 * the 9-character `Shift-Tab`) plus one cell of frame on each side. Written down rather than
 * derived from `overlayLines`, so that the two can DISAGREE -- deriving it would make it correct
 * by construction and unable to catch a change in either. `keypadOverlay.test.ts` recomputes it.
 *
 * `rows` is a judgement, not a derivation: 12 terminal rows leave 10 lines of list inside a frame,
 * and below that a window onto 46 entries shows so little that scrolling is worse than nothing.
 *
 * Both are deliberately BELOW the 24x80 floor that `tooSmall` (`render.ts:43`) already imposes on
 * the session, so this never refuses a terminal the session itself accepted. That does mean
 * `overlayFits` cannot return `false` for any terminal a live session is running in; it is a floor
 * against a future caller passing a sub-window rather than the whole terminal, not a live check.
 */
export const OVERLAY_MIN: Geometry = { rows: 12, cols: 29 };

/** Longest name in the table, for column alignment. Computed, never hardcoded. */
const NAME_WIDTH = Math.max(...KEYPAD_KEYS.map((k) => k.name.length));

/**
 * Do these describe the same action?
 *
 * Structural, and NOT `JSON.stringify(a) === JSON.stringify(b)`: that compares SERIALISATIONS, so
 * writing `{ n: 1, kind: 'pf' }` in either table would silently stop matching. The failure mode
 * would be a blank chord, which this overlay renders as "no chord exists" -- a wrong answer that
 * looks exactly like a right one. `pf`/`pa` carry `n` and `type` carries `text`; every other
 * member of the union is its `kind` alone (`frontend/src/keymap.ts:43-76`).
 */
const sameAction = (a: Action, b: Action): boolean =>
  a.kind === b.kind
  && ('n' in a ? 'n' in b && a.n === b.n : !('n' in b))
  && ('text' in a ? 'text' in b && a.text === b.text : !('text' in b));

/** How a user would describe the key that fires `action`, or `''` if nothing is bound to it. */
const chordFor = (action: Action): string =>
  BINDING_INTENT.find((b) => sameAction(b.action, action))?.key ?? '';

/**
 * One line per key, in table order: a selection mark, the name, then the chord.
 *
 * Returns all 46, which is taller than `OVERLAY_MIN.rows`. SCROLLING IS THE CALLER'S JOB -- the
 * caller takes a window of these. Keeping the window out of here is what lets the whole list be
 * asserted without a terminal.
 *
 * A `selected` outside the list marks nothing, so a caller with no selection yet can render the
 * list unmarked rather than having to fake an index.
 */
export function overlayLines(selected: number): readonly string[] {
  return KEYPAD_KEYS.map((k, i) => {
    const mark = i === selected ? '>' : ' ';
    return `${mark} ${k.name.padEnd(NAME_WIDTH)}  ${chordFor(k.action)}`.trimEnd();
  });
}

/** Clamped, never wrapped: see the test for why. */
export function moveSelection(selected: number, delta: number): number {
  return Math.min(KEYPAD_KEYS.length - 1, Math.max(0, selected + delta));
}

export function overlayFits(terminal: Geometry): boolean {
  return terminal.rows >= OVERLAY_MIN.rows && terminal.cols >= OVERLAY_MIN.cols;
}

/**
 * The action the selected line fires.
 *
 * Clamped with the same rule as `moveSelection`, so an out-of-range index cannot return
 * `undefined` and crash `applyAction` on a keystroke.
 */
export function selectedAction(selected: number): Action {
  return KEYPAD_KEYS[Math.min(KEYPAD_KEYS.length - 1, Math.max(0, selected))]!.action;
}
