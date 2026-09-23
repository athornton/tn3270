/**
 * The file-transfer form, rendered to lines.
 *
 * PURE, exactly like `keypadOverlay.ts`: nothing draws, nothing holds state, nothing reads
 * the terminal. `app.ts` owns the form state and `render.ts` paints the lines it is handed.
 * The MODEL is `frontend/src/transferForm.ts` -- fields, values and applicability live
 * there so that stage 3's GUI reuses them and cannot drift.
 *
 * ## EVERY LINE IS THE SAME WIDTH, AND THAT IS NOT COSMETIC
 *
 * The keypad overlay learned this from a live host: one `.trimEnd()` let the screen's own
 * cells show through to the right of a short line, LANDING IN THE CHORD COLUMN and reading
 * as a chord the key had not got. Here the same leak would put host text where a field's
 * value goes -- a value the operator did not type, in a form they are about to submit. So
 * every line is padded to `LINE_WIDTH` and the overlay is opaque.
 *
 * Values are TRUNCATED to their field width. A 300-character path must not widen the box
 * past the terminal, because the line would wrap and corrupt every row below it.
 *
 * ## THE HELP TEXT IS THE ONE LINE THAT MUST FIT RATHER THAN TRUNCATE
 *
 * Everything else on the status line comes from outside -- a validator message, a path, a
 * host's abort text -- and truncating those is the only option. The help is a constant we
 * choose, so a version that does not fit is a bug rather than a long input: the plan's
 * first draft was 59 characters against a `LINE_WIDTH` of 54 and rendered as
 * `... Enter start  Esc c>`, cutting off the two keys that submit and close the form. It
 * is now written to fit, and a test pins that no line ends in the truncation marker.
 */

import {
  TRANSFER_FIELDS, applicable, type TransferFieldId, type TransferFormState,
  type TransferValues,
} from '@tn3270/frontend';
import type { Geometry } from './render.js';

/** How the transfer is going, which decides the status line. */
export type TransferPhase = 'idle' | 'running' | 'done' | 'failed';

/** Widest label, for the label column. Computed, never hardcoded. */
const LABEL_WIDTH = Math.max(...TRANSFER_FIELDS.map((f) => f.label.length));

/** Widest value column any field asks for: the text fields' `width`, or a cycle's longest value. */
const VALUE_WIDTH = Math.max(
  ...TRANSFER_FIELDS.map((f) => (f.kind === 'cycle'
    ? Math.max(...f.values.map((v) => (v === '' ? 1 : v.length)))
    : f.width)),
);

/** Mark and space, the label column, a two-space gap, and the value column. */
const LINE_WIDTH = 2 + LABEL_WIDTH + 2 + VALUE_WIDTH;

/**
 * The key help, which must be at most `LINE_WIDTH` (54) characters.
 *
 * A constant rather than an inline string so that its length is checkable, and phrased in
 * the shortest form that still names all four operations: move, change, submit, close.
 * See the module comment on why this one line truncating would be a defect.
 */
const HELP = 'Tab moves  <-/-> change  Enter start  Esc close';

/**
 * The smallest terminal this form will open in.
 *
 * Written down rather than derived from `transferLines`, for the reason `OVERLAY_MIN`
 * gives: deriving it would make it correct by construction and unable to catch a change
 * in either. `transferOverlay.test.ts` recomputes it.
 *
 * `rows` is a title, up to ten fields, a blank and a status line, with one cell of frame
 * each side. `cols` is `LINE_WIDTH` plus that frame. **Both stay at or below 24x80**, the
 * floor `tooSmall` already imposes on the session, so this can never refuse a terminal the
 * session itself accepted -- the same property `OVERLAY_MIN` has, and for the same reason.
 * As there, that means `transferFits` cannot return `false` for any terminal a live
 * session is running in: it is a floor against a future caller passing a sub-window.
 */
export const TRANSFER_MIN: Geometry = { rows: 15, cols: LINE_WIDTH + 2 };

/** Will the form fit? */
export function transferFits(terminal: Geometry): boolean {
  return terminal.rows >= TRANSFER_MIN.rows && terminal.cols >= TRANSFER_MIN.cols;
}

/**
 * A value as drawn: unset shows a dash, and everything is truncated to the column.
 *
 * Takes a `TransferFieldId` rather than a `string`, so a caller cannot pass a name that is
 * not a field and silently get the dash that means "unset".
 */
function shown(id: TransferFieldId, values: TransferValues): string {
  const raw = values[id];
  const text = raw === '' ? '-' : raw;
  return text.length > VALUE_WIDTH ? text.slice(0, VALUE_WIDTH - 1) + '>' : text;
}

/**
 * The form as lines: a title, one line per APPLICABLE field, then a status line.
 *
 * An inapplicable field is omitted entirely rather than drawn blank or greyed -- the TUI
 * has one attribute to spend and a blank row invites a user to try to type in it.
 *
 * `state.selected` indexes `TRANSFER_FIELDS`, not the lines, so the caller never has to
 * know which fields are currently hidden.
 */
export function transferLines(
  state: TransferFormState,
  phase: TransferPhase,
  progress: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  lines.push('  File Transfer (IND$FILE)'.padEnd(LINE_WIDTH));

  for (const [index, field] of TRANSFER_FIELDS.entries()) {
    if (!applicable(field.id, state.values)) continue;
    const mark = index === state.selected ? '>' : ' ';
    lines.push(
      `${mark} ${field.label.padEnd(LABEL_WIDTH)}  ${shown(field.id, state.values)}`
        .padEnd(LINE_WIDTH),
    );
  }

  lines.push(''.padEnd(LINE_WIDTH));
  lines.push(statusLine(state, phase, progress).padEnd(LINE_WIDTH));
  return lines;
}

/**
 * The bottom line: the error if there is one, else the progress, else the key help.
 *
 * The error OUTRANKS the help, because a refused submit must not look like an idle form --
 * and it is truncated rather than wrapped, since a wrapped line would push the form's own
 * rows off whatever window the caller took.
 */
function statusLine(
  state: TransferFormState, phase: TransferPhase, progress: string | undefined,
): string {
  if (state.error !== undefined) return truncate(state.error);
  if (phase === 'running') return truncate(`transferring... ${progress ?? ''} (Esc cancels)`);
  if (phase === 'done') return truncate(`done: ${progress ?? ''}`);
  if (phase === 'failed') return truncate(progress ?? 'failed');
  return truncate(HELP);
}

const truncate = (s: string): string =>
  s.length > LINE_WIDTH ? s.slice(0, LINE_WIDTH - 1) + '>' : s;
