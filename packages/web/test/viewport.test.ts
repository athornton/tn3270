import { describe, it, expect } from 'vitest';
import { measureViewport } from '../src/viewport.js';

/**
 * `-oversize auto` in the gateway: the browser's viewport, in CSS pixels, as cells at SCALE 1
 * (the spec's "What each front end measures"), less the OIA's row.
 */
describe('measureViewport', () => {
  const cell = { width: 9, height: 14 };

  it('gives every whole cell at scale 1, less the OIA row', () => {
    // 1350 / 9 = 150 columns; 980 / 14 = 70 rows, one of which is the OIA's.
    expect(measureViewport({ width: 1350, height: 980 }, cell)).toEqual({ cols: 150, rows: 69 });
    // Floors, never rounds: one pixel short of a cell is not a cell.
    expect(measureViewport({ width: 1349, height: 979 }, cell)).toEqual({ cols: 149, rows: 68 });
  });

  it('is no measurement when the browser sent no viewport', () => {
    expect(measureViewport(undefined, cell)).toBeUndefined();
  });

  it('is no measurement when there is no room for a row beside the OIA, or a column', () => {
    expect(measureViewport({ width: 1350, height: 27 }, cell)).toBeUndefined();   // OIA only
    expect(measureViewport({ width: 8, height: 980 }, cell)).toBeUndefined();     // no column
    expect(measureViewport({ width: 9, height: 28 }, cell)).toEqual({ cols: 1, rows: 1 });
  });
});
