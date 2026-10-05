import { describe, it, expect } from 'vitest';
import { normalizeRect, isEmptyRect, type CellRect } from '../src/selection.js';

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
