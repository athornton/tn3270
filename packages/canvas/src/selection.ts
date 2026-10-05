/**
 * Rectangular selection geometry, pure and renderer-agnostic.
 *
 * ## WHY RECTANGULAR AND NOT LINEAR
 *
 * A 3270 panel is COLUMNAR -- datasets, LRECLs and option lists sit in columns, and the common
 * want is one column of a list without the labels either side of it. Linear selection on a fixed
 * grid also has a question with no good answer: whether to include the trailing spaces at the end
 * of each row. x3270 selects rectangularly by default on a 3270 screen.
 *
 * ## THIS FILE IS REACHED BY THE RENDERER, SO IT MUST STAY VALUE-IMPORT-FREE OF WORKSPACE PACKAGES
 *
 * `renderer.ts` imports `normalizeRect` and `isEmptyRect`, and a browser cannot resolve a bare
 * specifier like `@tn3270/core` -- the window goes BLANK WITH NO ERROR, which
 * `renderer-imports.test.ts` exists to catch. The `ResolvedCell` import below is therefore an
 * `import type`, which erases at compile time; `extractText` itself runs in MAIN, never in the
 * renderer. Do not add a value import to this file.
 */

import type { ResolvedCell } from '@tn3270/core';

/** A cell address in screen coordinates. Row and column are 0-based. */
export interface CellAddr {
  readonly row: number;
  readonly col: number;
}

/** An inclusive rectangle of cells. */
export interface CellRect {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * Two cell addresses into an inclusive rectangle.
 *
 * Normalizing is what makes all four drag directions behave identically: an up-left drag selects
 * exactly what the equivalent down-right drag does.
 */
export function normalizeRect(anchor: CellAddr, focus: CellAddr): CellRect {
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.col, focus.col),
  };
}

/**
 * Is this rectangle too small to be a selection?
 *
 * A 1x1 rectangle is a CLICK, not a drag, and treating it as a selection would arm a
 * one-character copy on every stray click -- including the clicks that place the cursor.
 */
export function isEmptyRect(rect: CellRect): boolean {
  return rect.top === rect.bottom && rect.left === rect.right;
}

/**
 * Clipboard text for a rectangle, from the RESOLVED cells.
 *
 * ## WHY THIS TAKES `ResolvedCell[]` AND NOT A `DrawList`
 *
 * A draw list has no characters. `DrawCell` is `{x, y, glyph, ...}` and `glyph` is a CG-order atlas
 * column (`drawlist.ts:111-121`), so text cannot be recovered from it -- reversing those indices
 * would be a second, drifting copy of `cg.ts`'s mapping. `ResolvedCell` is where `text` lives, and
 * `main.ts` already computes it every frame for the draw list.
 *
 * ## `hidden` IS HONORED HERE AND THAT IS NOT OPTIONAL
 *
 * `ResolvedCell.text` is still the real character when `hidden` is set -- core leaves redaction to
 * the consumer precisely because only the consumer knows what to substitute. A hidden cell yields a
 * SPACE, the same substitution `drawlist.ts:114` makes when drawing. Omitting this check puts a
 * password on the clipboard.
 *
 * Trailing whitespace is trimmed PER LINE, which is what makes a copied column paste usefully;
 * interior spaces are kept, because they carry a panel's alignment.
 */
export function extractText(
  cells: readonly ResolvedCell[], cols: number, rect: CellRect,
): string {
  const rows = Math.ceil(cells.length / cols);
  // CLAMPED, so a rectangle running off the grid yields short lines rather than reading
  // `undefined` out of the array and stringifying it.
  const top = Math.max(0, rect.top);
  const bottom = Math.min(rows - 1, rect.bottom);
  const left = Math.max(0, rect.left);
  const right = Math.min(cols - 1, rect.right);

  const lines: string[] = [];
  for (let row = top; row <= bottom; row++) {
    let line = '';
    for (let col = left; col <= right; col++) {
      const cell = cells[row * cols + col];
      if (cell === undefined) continue;
      line += cell.hidden ? ' ' : cell.text;
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
