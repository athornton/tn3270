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

export interface BorderSides {
  top: boolean; bottom: boolean; left: boolean; right: boolean;
}

export interface Layout {
  /** 0-based rows/cols to add to every screen address. */
  rowOffset: number;
  colOffset: number;
  /** 1-based terminal row for the OIA, or undefined if it does not fit. */
  statusRow: number | undefined;
  /**
   * 1-based terminal row for the key-binding hint, or undefined if it does not
   * fit. Above the top border when there is one, directly above the screen when
   * there is not.
   */
  hintRow: number | undefined;
  border: BorderSides;
}

/**
 * Where to put the 3270 screen, its OIA and its border in a given terminal.
 *
 * ## SLACK IS SPENT IN PRIORITY ORDER, NOT SHARED OUT
 *
 * A JupyterLab terminal is essentially never 80x24, so the interesting case is a
 * window somewhat bigger than the screen and the question is what to do with the
 * extra cells. Vertically: the screen is mandatory, then the OIA, then the BOTTOM
 * border, then the KEY-BINDING HINT, then the top border. Horizontally: the
 * screen, then the LEFT border, then the right. So a window one cell too wide gets
 * a left border and one cell too tall gets an OIA, which is the "prefer left and
 * bottom" rule.
 *
 * **The OIA outranks the bottom border deliberately** -- it is functional (it is
 * where `X Wait` and the connection state appear) and the border is decorative.
 * That is a judgment call rather than a derivation; flipping it means swapping two
 * lines below.
 *
 * **The hint outranks the TOP border for the same reason**, decided with the user
 * 2026-08-25: a line saying how to quit is worth more than a decorative rule, and
 * `Ctrl-C` being Clear rather than quit is exactly the thing a first-time user
 * needs told. So at +3 rows the hint takes the row the top border used to get, and
 * only at +4 do both appear. The consequence to know: a 27-row terminal showing a
 * 24-row screen now has a hint and no top border, where it previously had a top
 * border and no hint.
 *
 * Whatever is left over is split evenly, biased so any odd cell falls at the
 * bottom and right, which is what `Math.floor` gives and what centring
 * conventionally means.
 *
 * PURE, and the invariant worth having: nothing it returns may fall outside the
 * terminal. A border row below the last line, or an OIA past it, scrolls the window
 * and corrupts every cursor address computed afterwards -- `render.test.ts` sweeps
 * 22 heights by 5 widths asserting exactly that.
 */
export function layout(terminal: Geometry, screen: Geometry): Layout {
  const slackV = Math.max(0, terminal.rows - screen.rows);
  const slackH = Math.max(0, terminal.cols - screen.cols);

  const wantStatus = slackV >= 1;
  const bottom = slackV >= 2;
  const hint = slackV >= 3;
  const top = slackV >= 4;
  const left = slackH >= 1;
  const right = slackH >= 2;

  const blockRows = screen.rows
    + (wantStatus ? 1 : 0) + (bottom ? 1 : 0) + (hint ? 1 : 0) + (top ? 1 : 0);
  const blockCols = screen.cols + (left ? 1 : 0) + (right ? 1 : 0);

  // Both the hint and the top border sit ABOVE the screen, so each pushes the
  // screen down by one.
  const rowOffset = Math.floor((terminal.rows - blockRows) / 2)
    + (top ? 1 : 0) + (hint ? 1 : 0);
  const colOffset = Math.floor((terminal.cols - blockCols) / 2) + (left ? 1 : 0);

  return {
    rowOffset,
    colOffset,
    statusRow: wantStatus ? rowOffset + screen.rows + 1 : undefined,
    // The top border occupies 1-based row `rowOffset`, so the hint goes one above
    // it; with no top border the hint takes that row itself. `hint` implies
    // `slackV >= 3`, which is what keeps this inside the terminal.
    hintRow: hint ? rowOffset - (top ? 1 : 0) : undefined,
    border: { top, bottom, left, right },
  };
}

interface RendererOptions extends Geometry {
  depth: Depth;
  /**
   * Where the screen, OIA and border go. Defaults to flush at the top left with
   * the OIA directly below and no border, which is what a caller that has not
   * measured the terminal must assume. `App` always passes `layout(...)`.
   */
  layout?: Layout;
  /**
   * The key-binding hint, drawn on `layout.hintRow` when there is room for one.
   * Absent means draw nothing there, which is what a caller with no message to
   * show wants. main.ts passes `BANNER`.
   */
  hint?: string;
}

const NO_BORDER: BorderSides = { top: false, bottom: false, left: false, right: false };

function sameLayout(a: Layout, b: Layout): boolean {
  return a.rowOffset === b.rowOffset && a.colOffset === b.colOffset
    && a.statusRow === b.statusRow && a.hintRow === b.hintRow
    && a.border.top === b.border.top && a.border.bottom === b.border.bottom
    && a.border.left === b.border.left && a.border.right === b.border.right;
}

const ESC = '\x1b[';

export class TerminalRenderer {
  /**
   * The SCREEN geometry, not the terminal's. Mutable because Erase/Write
   * Alternate changes it mid-session: these bound the cell loop and give every
   * row its start column, so a stale pair would clip the new screen and address
   * every row after the first to the wrong place.
   */
  private rows: number;
  private cols: number;
  private readonly depth: Depth;
  private readonly hint: string | undefined;
  private place: Layout;
  /** Set when the layout moved, so the next full paint clears the old drawing. */
  private needsClear = false;
  private previous: ResolvedCell[] | undefined;
  private previousCursor = -1;
  private previousStatus = '';

  constructor(opts: RendererOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.depth = opts.depth;
    this.hint = opts.hint;
    this.place = opts.layout ?? {
      rowOffset: 0, colOffset: 0, statusRow: opts.rows + 1,
      hintRow: undefined, border: NO_BORDER,
    };
  }

  /**
   * Re-shape for a screen that changed size, e.g. Erase/Write Alternate.
   *
   * Clears as well as invalidating, for the same reason `setLayout` does: the old
   * drawing is a different shape, so anything not overwritten by the new one is
   * left behind as litter.
   */
  setScreenSize(rows: number, cols: number): void {
    if (rows === this.rows && cols === this.cols) return;
    this.rows = rows;
    this.cols = cols;
    this.needsClear = true;
    this.invalidate();
  }

  /** Force the next paint to redraw everything, e.g. after a terminal resize. */
  invalidate(): void {
    this.previous = undefined;
    this.previousStatus = '';
  }

  /**
   * Re-place everything, because the terminal was resized.
   *
   * Invalidates AND clears on any change: every cursor address in `previous` was
   * computed against the old placement, so diffing across the transition would
   * write cells to the wrong cells, and the old border and screen would be left
   * behind as litter wherever the block used to be. A no-op change deliberately
   * does neither, or every spurious SIGWINCH would cost a full clear and repaint.
   */
  setLayout(next: Layout): void {
    if (sameLayout(next, this.place)) return;
    this.place = next;
    this.needsClear = true;
    this.invalidate();
  }

  /** The border, drawn only on a full repaint -- it never changes between them. */
  private borderParts(): string[] {
    const { rowOffset, colOffset, statusRow, border } = this.place;
    if (!border.top && !border.bottom && !border.left && !border.right) return [];
    const top = rowOffset + 1;
    const bottom = statusRow !== undefined
      ? Math.max(rowOffset + this.rows, statusRow)
      : rowOffset + this.rows;
    const left = colOffset + 1;
    const right = colOffset + this.cols;
    const parts: string[] = [];
    const across = '\u2500'.repeat(this.cols);

    if (border.top) {
      parts.push(`${ESC}${top - 1};${border.left ? left - 1 : left}H`
        + (border.left ? '\u250c' : '') + across + (border.right ? '\u2510' : ''));
    }
    if (border.bottom) {
      parts.push(`${ESC}${bottom + 1};${border.left ? left - 1 : left}H`
        + (border.left ? '\u2514' : '') + across + (border.right ? '\u2518' : ''));
    }
    for (let row = top; row <= bottom; row++) {
      if (border.left) parts.push(`${ESC}${row};${left - 1}H\u2502`);
      if (border.right) parts.push(`${ESC}${row};${right + 1}H\u2502`);
    }
    return parts;
  }

  /**
   * The key-binding hint, drawn only on a full repaint -- like the border, it
   * never changes between them.
   *
   * DIM, and self-contained: it opens with a reset so it cannot inherit an SGR and
   * closes with one so it cannot leak dim into the border or the first cell. The
   * cell loop resets before its first write anyway, but the border parts do not.
   *
   * Aligned to the screen's left column rather than column 1, and truncated to the
   * screen width, for the reason the OIA is: it belongs to the block, and running
   * past the screen would overwrite the right-hand border.
   */
  private hintParts(): string[] {
    const { hintRow, colOffset } = this.place;
    if (hintRow === undefined || this.hint === undefined || this.hint === '') return [];
    const text = this.hint.length > this.cols ? this.hint.slice(0, this.cols) : this.hint;
    return [`${ESC}${hintRow};${colOffset + 1}H${ESC}0;2m${text}${ESC}0m`];
  }

  paint(cells: readonly ResolvedCell[], cursor: number, status: string): string {
    const parts: string[] = [];
    const fullRepaint = this.previous === undefined;
    if (fullRepaint) {
      // Clearing is only needed when the block MOVED; on the first paint app.ts has
      // already cleared, and clearing again would throw away its own work.
      if (this.needsClear) {
        parts.push(`${ESC}2J`);
        this.needsClear = false;
      }
      parts.push(...this.borderParts());
      parts.push(...this.hintParts());
    }
    let sgr = '';          // the SGR currently in effect on the terminal
    let lastWritten = -2;  // index of the previously emitted cell

    for (let i = 0; i < cells.length && i < this.rows * this.cols; i++) {
      const cell = cells[i]!;
      const old = this.previous?.[i];
      if (old !== undefined && sameCell(old, cell)) continue;

      // Move the cursor when this cell does not directly follow the last one we
      // wrote, AND at the start of every screen row.
      //
      // The row-start case is not an optimisation to skip: cells ARE contiguous
      // across a row boundary, but the terminal wraps at ITS right edge, not at the
      // screen's. That coincided only while the screen exactly filled the terminal
      // width. Centred in a 90-column window an 80-column screen wrapped at column
      // 90 rather than 85, putting every row after the first in the wrong place --
      // found on a real pty, where only the first screen row and the OIA began at
      // the screen's left edge. Costs one escape per row on a full repaint.
      if (i !== lastWritten + 1 || i % this.cols === 0) {
        const row = this.place.rowOffset + Math.floor(i / this.cols) + 1;
        const col = this.place.colOffset + (i % this.cols) + 1;
        parts.push(`${ESC}${row};${col}H`);
      }

      const want = this.cellSgr(cell);
      if (want !== sgr) {
        // RESET FIRST, ALWAYS. SGR parameters ACCUMULATE -- `\x1b[38;5;46m` sets a
        // colour and leaves reverse, bold, blink and underline exactly as they were,
        // because only 0 (or 22/24/25/27) clears them. Emitting the desired
        // attributes alone therefore let a highlighted run leak into everything after
        // it: ISPF's tutorial sends SA highlighting=0xF2 for its title bar, and every
        // following cell stayed inverted, turning each subsequent SPACE into a solid
        // block of the foreground colour and mottling the whole page. VM/370 never
        // sends reverse, which is why only TK5 showed it.
        //
        // The monochrome path accidentally did the right thing (`want` is empty there,
        // so it emitted a bare `0`), which is why this survived the depth-0 tests.
        //
        // Costs two bytes per SGR CHANGE, not per cell -- changes are already
        // coalesced by the `want !== sgr` test above. Explicit off-codes would save
        // those two bytes and cost a state machine; not worth it.
        parts.push(`${ESC}0${want === '' ? '' : `;${want}`}m`);
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
    if (this.place.statusRow !== undefined && status !== this.previousStatus) {
      // PADDED to the screen width, not `\x1b[K`. Erasing to end of line would wipe
      // the right-hand border on this row, and aligning to the screen rather than to
      // column 1 keeps the OIA under the screen when the block is centred.
      const text = status.length > this.cols
        ? status.slice(0, this.cols)
        : status.padEnd(this.cols, ' ');
      parts.push(`${ESC}${this.place.statusRow};${this.place.colOffset + 1}H${ESC}0m${text}`);
      sgr = '';
      this.previousStatus = status;
    }

    // The terminal's own cursor goes where the 3270 cursor is, so a user sees it
    // in the field they are typing into.
    if (parts.length > 0 || cursor !== this.previousCursor) {
      const row = this.place.rowOffset + Math.floor(cursor / this.cols) + 1;
      const col = this.place.colOffset + (cursor % this.cols) + 1;
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
