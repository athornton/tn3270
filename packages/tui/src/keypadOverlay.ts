/**
 * The special-keys overlay: the keypad table as a navigable list.
 *
 * PURE. Every function here is a total function of its arguments; nothing draws, nothing holds
 * state and nothing reads the terminal. `app.ts` owns the selection index AND the scroll window
 * (`overlayWindow`, which follows the selection), and `render.ts` draws the lines it is handed --
 * over the top-left of the screen region, with the marked line in reverse video. (This paragraph
 * gave the window to `render.ts` until Task 12 wired it up: the renderer is handed lines and has no
 * selection index to scroll towards, so the window could only live with the state.)
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
 * shows a blank, and 22 of the 47 do: PF2, PF4-PF11, PF14-PF24, Sys Req and Newline.
 *
 * Sys Req's blank is the whole reason this module exists. c3270 defines no chord for it in either
 * of its keymaps, so the overlay is its only keyboard route; a blank there is correct rather than
 * missing. NEWLINE'S BLANK IS THE SAME AND FOR A DIFFERENT REASON: c3270 does bind it, to Ctrl-J
 * (`Common/fb-c3270:190`), but Ctrl-J is `\n` and the terminal keymap already reads that as `enter`
 * -- one byte cannot be both, and Enter is the AID that submits. See the note on the union member
 * in `frontend/src/keymap.ts`.
 *
 * Dup and Field Mark were blank too until `Ctrl-D`/`Ctrl-F` reached `BINDING_INTENT`, and they
 * filled in here WITH NO EDIT TO THIS FILE -- which is the property the indirection buys, and it
 * was measured rather than assumed. Newline arriving in `KEYPAD_KEYS` is the other half of the same
 * property: it appears as a row here, with a blank chord, also with no edit to this file.
 */

import { BINDING_INTENT, KEYPAD_KEYS, type Action } from '@tn3270/frontend';
import type { Geometry } from './render.js';

/**
 * The smallest terminal this overlay will open in.
 *
 * `cols` is the line width (27: mark, space, the 14-character `System Request`, two spaces and the
 * 9-character `Shift-Tab`) plus one cell of frame on each side. Every line is that wide -- see
 * `LINE_WIDTH`, which is why this is "the line width" and not "the widest line" -- and no single
 * key contributes both halves: Sys Req is the longest name and has no chord at all.
 *
 * Written down rather than derived from `overlayLines`, so that the two can DISAGREE -- deriving it
 * would make it correct by construction and unable to catch a change in either.
 * `keypadOverlay.test.ts` recomputes it, which is also what pins `LINE_WIDTH` from above.
 *
 * `rows` is a judgement, not a derivation: 12 terminal rows leave 10 lines of list inside a frame,
 * and below that a window onto 47 entries shows so little that scrolling is worse than nothing.
 *
 * NO FRAME IS ACTUALLY DRAWN as of Task 12 -- the list is written straight over the screen's
 * top-left corner -- so the frame cells both figures allow for are slack in a floor that is already
 * unreachable (below). Keeping them costs nothing and leaves room for a frame; shrinking the
 * constant to 27x11 would only make an unreachable check marginally less conservative.
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
 * member of the union is its `kind` alone (`frontend/src/keymap.ts:43-88`).
 */
const sameAction = (a: Action, b: Action): boolean =>
  a.kind === b.kind
  && ('n' in a ? 'n' in b && a.n === b.n : !('n' in b))
  && ('text' in a ? 'text' in b && a.text === b.text : !('text' in b));

/** How a user would describe the key that fires `action`, or `''` if nothing is bound to it. */
const chordFor = (action: Action): string =>
  BINDING_INTENT.find((b) => sameAction(b.action, action))?.key ?? '';

/**
 * Widest chord any key in the table has, so the chord column has a width of its own.
 *
 * Over the chords of `KEYPAD_KEYS` and not over all of `BINDING_INTENT`: a chord bound to an action
 * no key in the table names would widen every line for nothing. (Both give 9 today -- `Shift-Tab`
 * and `Backspace` -- so no test can tell them apart; recorded as intent, not as measured.)
 */
const CHORD_WIDTH = Math.max(...KEYPAD_KEYS.map((k) => chordFor(k.action).length));

/**
 * The width of EVERY line, which is what makes the list OPAQUE.
 *
 * Mark and space (2), the name column, the two-space gap, and the chord column. Lines used to be
 * `trimEnd()`ed to their natural length, and the 22 keys with no chord therefore ended at the name
 * -- so the host's own cells stayed visible to the right of them, LANDING IN THE CHORD COLUMN and
 * reading as a chord the key has not got. Measured over a real pty against a host whose screen row 1
 * read `HELLO TN3270`: the PF16 row rendered as `  PF16 TN3270`.
 *
 * PADDED HERE AND NOT IN `render.ts`, although opacity is a drawing concern: the renderer is handed
 * a WINDOW of these lines (`app.ts`'s `overlayWindow`), so the widest line it can see is not the
 * widest line in the list -- a screenful of chordless PF keys would pad to a narrower rectangle and
 * bleed again. This module is the only place that knows all 47.
 *
 * Never truncates: `padEnd` alone, so a chord longer than `CHORD_WIDTH` could not silently lose its
 * tail. It cannot happen -- the width is derived from the same chords -- and if the derivation broke,
 * the lines would differ in length and the uniform-width test would redden rather than the overlay
 * lying about a chord.
 */
const LINE_WIDTH = 2 + NAME_WIDTH + 2 + CHORD_WIDTH;

/**
 * One line per key, in table order: a selection mark, the name, then the chord.
 *
 * Returns all 47, which is taller than `OVERLAY_MIN.rows`. SCROLLING IS THE CALLER'S JOB -- the
 * caller takes a window of these. Keeping the window out of here is what lets the whole list be
 * asserted without a terminal.
 *
 * A `selected` outside the list marks nothing, so a caller with no selection yet can render the
 * list unmarked rather than having to fake an index.
 *
 * EVERY LINE IS `LINE_WIDTH` WIDE, padding included -- see that constant for why. One visible
 * consequence: the selected line is a full-width reverse-video bar rather than a highlighted
 * fragment, which is what a selection in a list should look like anyway.
 */
export function overlayLines(selected: number): readonly string[] {
  return KEYPAD_KEYS.map((k, i) => {
    const mark = i === selected ? '>' : ' ';
    return `${mark} ${k.name.padEnd(NAME_WIDTH)}  ${chordFor(k.action)}`.padEnd(LINE_WIDTH);
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
