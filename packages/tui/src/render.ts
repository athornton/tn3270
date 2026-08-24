/**
 * Turn resolved cells into ANSI, writing as few bytes as possible.
 *
 * PURE: returns a string, never touches stdout. app.ts does the writing. That is
 * what makes the diffing testable, and diffing is not optional -- a host that
 * repaints an identical screen must not make the terminal flicker, and over a
 * 300-baud-equivalent link the byte count is the frame rate.
 *
 * The status line is drawn on the row BELOW the screen buffer, so a 24-row 3270
 * needs 25 terminal rows. The OIA is not part of the 1920 cells (spec: "the OIA
 * is drawn outside the screen buffer") and is owned here, not by Screen.
 */

import { sgrFor, type Depth } from './colours.js';
import type { ResolvedCell } from '@tn3270/core';

export interface Geometry { rows: number; cols: number; }

/** Does the 3270 screen plus its status row fit in the terminal? */
export function tooSmall(terminal: Geometry, screen: Geometry): boolean {
  return terminal.rows < screen.rows + 1 || terminal.cols < screen.cols;
}

interface RendererOptions extends Geometry { depth: Depth; }

const ESC = '\x1b[';

export class TerminalRenderer {
  private readonly rows: number;
  private readonly cols: number;
  private readonly depth: Depth;
  private previous: ResolvedCell[] | undefined;
  private previousCursor = -1;
  private previousStatus = '';

  constructor(opts: RendererOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.depth = opts.depth;
  }

  /** Force the next paint to redraw everything, e.g. after a terminal resize. */
  invalidate(): void {
    this.previous = undefined;
    this.previousStatus = '';
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

    if (status !== this.previousStatus) {
      parts.push(`${ESC}${this.rows + 1};1H${ESC}0m${status}${ESC}K`);
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
