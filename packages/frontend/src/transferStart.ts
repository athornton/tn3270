/**
 * What a transfer that NEVER STARTED reports, shared by both drivers so they cannot drift: the
 * event-driven `transferRun.ts` (TUI, GUI, web gateway) and the CLI's blocking poll in
 * `cli/src/runner.ts`.
 *
 * ## WHY "DID NOT START" AND NOT "MAY STILL BE TRANSFERRING"
 *
 * Both drivers used to say the host "may still be transferring" / "may still be in transfer
 * mode" at the start deadline. When no CUT frame and no DFT frame ever arrived that is false: the
 * host never entered transfer mode. Seen live on 2026-10-27 (`docs/live-testing.md`, the RC=12
 * entry): TSO's IND$FILE exited `RC=12` at once and we waited 30 s to say otherwise. The owner
 * chose this fix on 2026-11-12 (option A): x3270's own wording, `ftStartTimeout` "Transfer did not
 * start within 30s" (suite3270-4.5 `fb-common:34`, `ft_didnt_start` at `ft.c:488-501`), plus the
 * host's own words.
 *
 * ## THE HOST'S WORDS ARE THE ROWS IT CHANGED, NOT A PATTERN
 *
 * TSO's exact refusal text has never been captured, so nothing here matches `RC=` or any other
 * guessed format. The rows that differ between a snapshot taken just before Enter and the screen
 * at the deadline are what the host said, whatever it said: MECAFF's three-line refusal, TSO's
 * `RC=` line and `READY`, an ISPF `INVALID OPTION`. Diffing is also what keeps a STALE line out:
 * TSO line mode leaves the previous `READY` on screen, and that row has not changed.
 *
 * ## STILL A DEADLINE
 *
 * This does not end the wait early. Telling a refusal from a slow host needs a captured TSO
 * refusal screen sequence, which does not exist yet; until it does, the deadline is x3270's too.
 */

import { CUT_SCREEN_SIZE, type Screen } from '@tn3270/core';

/** At most this many changed rows are quoted. MECAFF's refusal is three; the rest are counted. */
export const NON_START_ROWS_SHOWN = 5;

/**
 * Each display row as text, with the cells of a non-display field blanked.
 *
 * BLANKED because this text goes into an error message, a log and a status line: a hidden field
 * is how a host asks for a password, and `Screen.rowText` renders it like any other.
 */
export function screenRows(screen: Screen): string[] {
  const hidden = new Set<number>();
  if (screen.isFormatted()) {
    screen.forEachCellWithField(0, 0, (addr, field, isAttr) => {
      if (!isAttr && field?.hidden === true) hidden.add(addr);
    });
  }
  const out: string[] = [];
  for (let r = 1; r <= screen.rows; r++) {
    const text = screen.rowText(r);
    if (hidden.size === 0) { out.push(text); continue; }
    const base = (r - 1) * screen.cols;
    let row = '';
    for (let c = 0; c < text.length; c++) row += hidden.has(base + c) ? ' ' : text[c];
    out.push(row);
  }
  return out;
}

export interface NonStart {
  /** The deadline that fired, in seconds, from the driver's own timeout. */
  seconds: number;
  /** `screenRows` just before the command was sent. */
  before: readonly string[];
  /** `screenRows` at the deadline. */
  after: readonly string[];
  /** Still inhibited: the host has not handed the keyboard back since Enter. */
  keyboardLocked: boolean;
  /** Did the host write anything at all after Enter? */
  sawHostWrite: boolean;
  ddmAdvertised: boolean;
  rows: number;
  cols: number;
}

/** The failure text for a transfer that never started. */
export function describeNonStart(n: NonStart): string {
  // THE ADVICE ONLY WHERE IT IS TRUE. A host that has handed the keyboard back is sitting at a
  // prompt, not in transfer mode, so there is nothing to interrupt. A host that has NOT may still
  // be working on the command (or about to start), and Attn or Clear is how a terminal operator
  // stops it. First, because the TUI status line is 54 columns and truncates.
  const lead = n.keyboardLocked ? 'press Attn or Clear: ' : '';
  const offered = n.ddmAdvertised ? 'CUT or DFT' : 'CUT only';

  // Every row counts as changed when the geometry did (an EWA under us): positions no longer line up.
  const resized = n.before.length !== n.after.length;
  const changed = n.after
    .filter((row, i) => resized || row !== n.before[i])
    .map((row) => row.trim())
    .filter((row) => row.length > 0);

  let said: string;
  if (changed.length > 0) {
    const shown = changed.slice(0, NON_START_ROWS_SHOWN).map((row) => `"${row}"`).join(' / ');
    const omitted = changed.length - NON_START_ROWS_SHOWN;
    said = `the host wrote: ${shown}${omitted > 0 ? ` (${omitted} more rows omitted)` : ''}`;
  } else {
    said = n.sawHostWrite ? 'the screen did not change' : 'the host wrote nothing';
  }

  let hints = '';
  if (!n.sawHostWrite && !n.ddmAdvertised) {
    // A host that speaks only DFT cannot choose DFT unless we advertised QCODE 0x95 -- and since
    // the 2026-09-29 default flip only an explicit `-ddm off` gets here.
    hints += ' (DDM was not advertised; a host that speaks only DFT needs -ddm on)';
  }
  if (n.rows * n.cols !== CUT_SCREEN_SIZE) {
    // LAST, AND A FACT PLUS A CANDIDATE, never the lead: the host's quoted words come first and
    // usually say why (measured on VM/370 at 43x80, MECAFF refused over the terminal TYPE, not the
    // geometry: live-testing.md:757). But a CUT-only host at 43x80 may paint a prompt and go quiet.
    hints += ` (a CUT host needs 24x80; this session is ${n.rows}x${n.cols})`;
  }

  return `${lead}transfer did not start within ${n.seconds}s (we offered ${offered}); ${said}${hints}`;
}
