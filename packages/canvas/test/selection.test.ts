import { describe, it, expect } from 'vitest';
import { normalizeRect, isEmptyRect, extractText, type CellRect } from '../src/selection.js';
import type { ResolvedCell } from '@tn3270/core';

describe('normalizeRect', () => {
  it('orders a top-left to bottom-right drag', () => {
    expect(normalizeRect({ row: 2, col: 5 }, { row: 7, col: 20 }))
      .toEqual({ top: 2, left: 5, bottom: 7, right: 20 });
  });

  it('ALL FOUR DRAG DIRECTIONS give the same rectangle', () => {
    // The whole point of normalizing: dragging up-left must select what dragging down-right does.
    const want: CellRect = { top: 2, left: 5, bottom: 7, right: 20 };
    expect(normalizeRect({ row: 7, col: 20 }, { row: 2, col: 5 })).toEqual(want);   // up-left
    expect(normalizeRect({ row: 2, col: 20 }, { row: 7, col: 5 })).toEqual(want);   // down-left
    expect(normalizeRect({ row: 7, col: 5 }, { row: 2, col: 20 })).toEqual(want);   // up-right
  });

  it('a single cell normalizes to a 1x1 rectangle', () => {
    expect(normalizeRect({ row: 3, col: 3 }, { row: 3, col: 3 }))
      .toEqual({ top: 3, left: 3, bottom: 3, right: 3 });
  });
});

describe('isEmptyRect', () => {
  it('calls a 1x1 rectangle EMPTY, so a stray click is not a selection', () => {
    // A click with no drag must not arm a one-character copy.
    expect(isEmptyRect({ top: 3, left: 3, bottom: 3, right: 3 })).toBe(true);
  });

  it('calls a wider or taller rectangle non-empty', () => {
    expect(isEmptyRect({ top: 3, left: 3, bottom: 3, right: 4 })).toBe(false);
    expect(isEmptyRect({ top: 3, left: 3, bottom: 4, right: 3 })).toBe(false);
  });
});

/** A grid of resolved cells from a string per row, padded with spaces. */
function grid(rows: readonly string[], cols = 10): ResolvedCell[] {
  const out: ResolvedCell[] = [];
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      out.push({
        text: row[c] ?? ' ',
        fg: 1, bg: 0, blink: false, reverse: false,
        underscore: false, intensify: false, hidden: false,
      } as ResolvedCell);
    }
  }
  return out;
}

describe('extractText', () => {
  it('takes one line per row, clipped to the columns', () => {
    const cells = grid(['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123']);
    const text = extractText(cells, 10, { top: 0, left: 2, bottom: 1, right: 4 });
    expect(text).toBe('CDE\nMNO');
  });

  it('TRIMS TRAILING WHITESPACE PER LINE, not per block', () => {
    // Per-line trimming is what makes a copied COLUMN paste usefully. Trimming the block as a
    // whole would leave ragged leading spaces on every row but the longest.
    const cells = grid(['AB        ', 'CDEF      ']);
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 1, right: 9 })).toBe('AB\nCDEF');
  });

  it('does NOT add a trailing newline', () => {
    const cells = grid(['AB', 'CD']);
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 1, right: 1 })).toBe('AB\nCD');
  });

  it('keeps INTERIOR spaces, which carry a panel\'s column alignment', () => {
    const cells = grid(['A  B      ']);
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 0, right: 5 })).toBe('A  B');
  });

  it('A HIDDEN CELL CONTRIBUTES A SPACE, NOT ITS CHARACTER', () => {
    /**
     * THE RULE THAT MATTERS MOST IN THIS FILE. `hidden` marks a password field, and core calls it
     * "the ONLY thing standing between a password field and the screen" -- while `text` is STILL
     * THE REAL CHARACTER, deliberately not pre-redacted. So extraction that reads `text` without
     * checking `hidden` puts a password on the clipboard, and a copy feature is exactly how a
     * password escapes. This project has already shipped one diagnostic that printed a live
     * password on its first run.
     */
    const cells = grid(['USERPASSWD']);
    for (let c = 4; c < 10; c++) (cells[c] as { hidden: boolean }).hidden = true;
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 0, right: 9 })).toBe('USER');
  });

  it('clamps a rectangle that runs off the grid rather than reading undefined', () => {
    const cells = grid(['ABCDEFGHIJ']);
    expect(extractText(cells, 10, { top: 0, left: 8, bottom: 5, right: 40 })).toBe('IJ');
  });
});
