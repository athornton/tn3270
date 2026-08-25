/**
 * Turn resolved cells into ANSI, writing as few bytes as possible.
 *
 * PURE: returns a string, never touches stdout. app.ts does the writing. That is
 * what makes the diffing testable, and diffing is not optional -- a host that
 * repaints an identical screen must not make the terminal flicker, and over a
 * 300-baud-equivalent link the byte count is the frame rate.
 *
 * The status line is drawn on the row BELOW the screen buffer, so a 24-row 3270
 * wants 25 terminal rows -- but only WANTS them. When the terminal has exactly as
 * many rows as the screen, the OIA is dropped and the screen is still drawn in
 * full; see `tooSmall` and `statusRowFor`. (This paragraph said "needs 25" until
 * the minimum was relaxed to match c3270.) The OIA is not part of the 1920 cells
 * (spec: "the OIA is drawn outside the screen buffer") and is owned here, not by
 * Screen.
 */

import { sgrFor, type Depth } from './colours.js';
import type { ResolvedCell } from '@tn3270/core';

export interface Geometry { rows: number; cols: number; }

/**
 * Is the terminal too small to draw the 3270 screen at all?
 *
 * ## THE SCREEN IS MANDATORY; THE OIA IS NOT
 *
 * This is the c3270 rule, deliberately. c3270 errors only when the SCREEN will not
 * fit -- "Rows and/or cols too small on default screen (minimum 24x80)"
 * (`c3270/screen.c:412-419`) -- and when there is no room for the status line it
 * simply does not draw one: `set_status_row` at `screen.c:895` sets
 * `status_row = status_skip = 0` for `screen_rows < emulator_rows + 1`, and its
 * menubar degrades the same way ("2 rows, 1 in a pinch").
 *
 * This function previously required `screen.rows + 1`, which made us STRICTER THAN
 * THE REFERENCE: an 80x24 terminal, the commonest size in existence, was refused
 * outright while c3270 runs there quite happily minus the OIA. The distinction that
 * justifies the asymmetry is whose data is at stake -- the 1920 cells are the
 * HOST'S and hiding any of them is a correctness problem, whereas the OIA is our
 * own chrome and dropping it costs a status display.
 */
export function tooSmall(terminal: Geometry, screen: Geometry): boolean {
  return terminal.rows < screen.rows || terminal.cols < screen.cols;
}

/**
 * Which 1-based terminal row the OIA goes on, or `undefined` if it does not fit.
 *
 * Paired with `tooSmall` on purpose: together they are one decision about how a
 * tight terminal is apportioned, and `render.test.ts` pins them against each other
 * so a future edit cannot let the status line land on a row the terminal does not
 * contain. Drawing it there would scroll the terminal, push the 3270 screen up a
 * line, and corrupt every cursor address computed afterwards.
 */
export function statusRowFor(terminal: Geometry, screen: Geometry): number | undefined {
  return terminal.rows >= screen.rows + 1 ? screen.rows + 1 : undefined;
}

interface RendererOptions extends Geometry {
  depth: Depth;
  /**
   * 1-based terminal row for the OIA, or `undefined` to draw none.
   *
   * Defaults to `rows + 1`, which is the only correct answer when the caller has
   * not measured the terminal, and is what every caller wanted before the OIA
   * became optional. `App` always passes `statusRowFor(...)` explicitly.
   */
  statusRow?: number | undefined;
}

const ESC = '\x1b[';

export class TerminalRenderer {
  private readonly rows: number;
  private readonly cols: number;
  private readonly depth: Depth;
  private statusRow: number | undefined;
  private previous: ResolvedCell[] | undefined;
  private previousCursor = -1;
  private previousStatus = '';

  constructor(opts: RendererOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.depth = opts.depth;
    this.statusRow = 'statusRow' in opts ? opts.statusRow : opts.rows + 1;
  }

  /** Force the next paint to redraw everything, e.g. after a terminal resize. */
  invalidate(): void {
    this.previous = undefined;
    this.previousStatus = '';
  }

  /**
   * Move the OIA, or drop it, because the terminal was resized.
   *
   * Invalidates on any change: every cursor address in `previous` was computed for
   * the old layout, so a diff across the transition would write cells to the wrong
   * places. A no-op change deliberately does NOT invalidate, or every SIGWINCH that
   * did not actually change the size would cost a full repaint.
   */
  setStatusRow(row: number | undefined): void {
    if (row === this.statusRow) return;
    this.statusRow = row;
    this.invalidate();
  }

  paint(cells: readonly ResolvedCell[], cursor: number, status: string): string {
    const parts: string[] = [];
    let sgr = '';          // the SGR currently in effect on the terminal
    let lastWritten = -2;  // index of the previously emitted cell

    for (let i = 0; i < cells.length && i < this.rows * this.cols; i++) {
      const cell = cells[i]!;
      const old = this.previous?.[i];
      if (old !== undefined && sameCell(old, cell)) continue;

      // Move the cursor only when this cell does not directly follow the last
      // one we wrote. A full-screen change therefore emits one position escape.
      if (i !== lastWritten + 1) {
        const row = Math.floor(i / this.cols) + 1;
        const col = (i % this.cols) + 1;
        parts.push(`${ESC}${row};${col}H`);
      }

      const want = this.cellSgr(cell);
      if (want !== sgr) {
        parts.push(`${ESC}${want || '0'}m`);
        sgr = want;
      }
      parts.push(cell.hidden ? ' ' : cell.text);
      lastWritten = i;
    }

    // No status row means no room for one: the screen is drawn in full and the OIA
    // is dropped, per the note on `tooSmall`.
    //
    // `previousStatus` is not updated in that case either, which LOOKS load-bearing
    // (it would make a later paint see a difference once there is room again) and is
    // NOT: verified by mutation, updating it anyway leaves every test green. The
    // reason is that the only route from no-row to row is `setStatusRow`, which
    // invalidates, and `invalidate` already clears `previousStatus`. So this is
    // belt-and-braces for a caller that changes the row some other way, and no test
    // can pin it as the class stands -- do not write one claiming to.
    if (this.statusRow !== undefined && status !== this.previousStatus) {
      parts.push(`${ESC}${this.statusRow};1H${ESC}0m${status}${ESC}K`);
      sgr = '';
      this.previousStatus = status;
    }

    // The terminal's own cursor goes where the 3270 cursor is, so a user sees it
    // in the field they are typing into.
    if (parts.length > 0 || cursor !== this.previousCursor) {
      const row = Math.floor(cursor / this.cols) + 1;
      const col = (cursor % this.cols) + 1;
      parts.push(`${ESC}${row};${col}H`);
    }

    this.previous = cells.slice();
    this.previousCursor = cursor;
    return parts.join('');
  }

  /** The full SGR parameter list for one cell: colours plus highlighting. */
  private cellSgr(cell: ResolvedCell): string {
    const params: string[] = [];
    if (cell.blink) params.push('5');
    if (cell.reverse) params.push('7');
    if (cell.underscore) params.push('4');
    if (cell.intensify) params.push('1');
    const fg = sgrFor(cell.fg, this.depth, 'fg');
    const bg = sgrFor(cell.bg, this.depth, 'bg');
    if (fg) params.push(fg);
    if (bg) params.push(bg);
    return params.join(';');
  }
}

function sameCell(a: ResolvedCell, b: ResolvedCell): boolean {
  return a.text === b.text && a.fg === b.fg && a.bg === b.bg
    && a.blink === b.blink && a.reverse === b.reverse
    && a.underscore === b.underscore && a.intensify === b.intensify
    && a.hidden === b.hidden;
}
