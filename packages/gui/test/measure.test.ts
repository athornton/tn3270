import { describe, it, expect } from 'vitest';
import { bestScale } from '@tn3270/canvas';
import { resolveGeometry } from '@tn3270/core';
import { measureAuto, measureDisplay } from '../src/measure.js';

const CELL = { width: 9, height: 14 };          // 3270.bdf's FONTBOUNDINGBOX 9 14
const MODEL2 = { rows: 24, cols: 80 };

/**
 * `-oversize auto` in the GUI: the display's work area at the scale `fit()` would pick anyway.
 * The arithmetic is checked by hand here, because a test that recomputed it with the same
 * expressions would only prove the code agrees with itself.
 */
describe('measureDisplay', () => {
  it('1920x1080: scale 2, so 85 columns by 29 rows', () => {
    // within = floor(1920*0.8) x floor(1080*0.8) = 1536 x 864.
    // Model 2's list: 80*9 = 720 wide, (24+1)*14 = 350 high (the +1 is the OIA row).
    // scale = min(floor(1536/720), floor(864/350)) = min(2, 2) = 2.
    // cols = floor(1536 / (9*2)) = floor(85.33) = 85; rows = floor(864 / (14*2)) - 1 = 30 - 1 = 29.
    expect(measureDisplay({ width: 1920, height: 1080 }, CELL, MODEL2)).toEqual({ rows: 29, cols: 85 });
  });

  it('1280x1024 (the Xvfb display): scale 1, so 113 columns by 57 rows', () => {
    // within = 1024 x floor(819.2) = 1024 x 819.
    // scale = min(floor(1024/720), floor(819/350)) = min(1, 2) = 1 -- width-limited.
    // cols = floor(1024/9) = floor(113.8) = 113; rows = floor(819/14) - 1 = 58 - 1 = 57.
    expect(measureDisplay({ width: 1280, height: 1024 }, CELL, MODEL2)).toEqual({ rows: 57, cols: 113 });
  });

  it('the OIA row counts toward the scale: 1920x850 is scale 1, not 2', () => {
    // within = 1536 x 680. Model 2 WITH its OIA row is 350 high, and 2*350 = 700 > 680, so
    // fit() would draw it at scale 1; without that row it would be 336, and 2*336 = 672 fits.
    // At scale 1: cols = floor(1536/9) = 170, rows = floor(680/14) - 1 = 48 - 1 = 47.
    expect(measureDisplay({ width: 1920, height: 850 }, CELL, MODEL2)).toEqual({ rows: 47, cols: 170 });
  });

  it('a display too small for the model at scale 1 still measures at scale 1, never 0', () => {
    // within = 320 x 240; floor(320/720) = 0 and floor(240/350) = 0, so bestScale floors at 1.
    // cols = floor(320/9) = 35; rows = floor(240/14) - 1 = 17 - 1 = 16. Smaller than the model,
    // which resolveGeometry turns into its "less than model" fallback -- not a division by zero.
    expect(measureDisplay({ width: 400, height: 300 }, CELL, MODEL2)).toEqual({ rows: 16, cols: 35 });
  });

  it('the scale comes from the MODEL, so a taller model measures at a smaller scale', () => {
    // Model 4 (43x80): list 720 x 44*14 = 616. At 1920x1080, floor(864/616) = 1, so scale 1:
    // cols = floor(1536/9) = 170, rows = floor(864/14) - 1 = 61 - 1 = 60.
    expect(measureDisplay({ width: 1920, height: 1080 }, CELL, { rows: 43, cols: 80 }))
      .toEqual({ rows: 60, cols: 170 });
  });

  it('a display with no room for even one row and the OIA is no measurement', () => {
    // within height floor(20*0.8) = 16: floor(16/14) - 1 = 0 rows.
    expect(measureDisplay({ width: 1000, height: 20 }, CELL, MODEL2)).toBeUndefined();
    expect(measureDisplay({ width: 0, height: 0 }, CELL, MODEL2)).toBeUndefined();
  });

  /**
   * THE CLAIM "AT THE SCALE THE WINDOW WOULD PICK ANYWAY", checked against `fit()`'s own rule.
   * `fit()` sizes the window from the draw list it is about to send -- for an oversize screen,
   * the OVERSIZE list, which is bigger than the model's. If `bestScale` of that list were smaller
   * than the model's, the screen would be drawn smaller than the user chose. It cannot be: every
   * dimension was cut to fit `within` at the model's scale. Swept over many displays and models.
   */
  it('fit() picks the same scale for the oversize screen as measureDisplay used', () => {
    // Through resolveGeometry, so what is checked is the alternate a connect really gets --
    // including the 14-bit clamp, which cuts rows and keeps the width. Portrait displays are
    // in the sweep because they are what reach the clamp at scale 1.
    const models = ['3278-2-E', '3278-3-E', '3278-4-E', '3278-5-E'];
    let checked = 0;
    let clamped = 0;
    for (const model of models) {
      const setting = { model, oversize: { kind: 'auto' } } as const;
      const alt = resolveGeometry({ ...setting, oversize: { kind: 'none' } }).alternate;
      for (let w = 640; w <= 5120; w += 37) {
        for (let h = 480; h <= 5120; h += 41) {
          const within = { width: Math.floor(w * 0.8), height: Math.floor(h * 0.8) };
          const g = resolveGeometry(setting, () => measureAuto(setting, { width: w, height: h }, CELL));
          if (!g.dynamic) continue;                   // fell back to the model: fit() is unchanged
          if (g.clamp !== undefined) clamped++;
          const modelScale = bestScale(
            { width: alt.cols * CELL.width, height: (alt.rows + 1) * CELL.height }, within);
          const oversizeScale = bestScale(
            { width: g.alternate.cols * CELL.width, height: (g.alternate.rows + 1) * CELL.height },
            within);
          expect(oversizeScale, `${w}x${h} model ${model}`).toBe(modelScale);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(clamped).toBeGreaterThan(0);
  });
});

describe('measureAuto', () => {
  const area = { width: 1920, height: 1080 };

  it('takes the model from the session setting AT CALL TIME', () => {
    expect(measureAuto({ oversize: { kind: 'auto' } }, area, CELL)).toEqual({ rows: 29, cols: 85 });
    expect(measureAuto({ model: '3278-4-E', oversize: { kind: 'auto' } }, area, CELL))
      .toEqual({ rows: 60, cols: 170 });
  });

  it('no atlas yet, no display, or no setting is no measurement -- never a throw', () => {
    expect(measureAuto({ oversize: { kind: 'auto' } }, area, undefined)).toBeUndefined();
    expect(measureAuto({ oversize: { kind: 'auto' } }, undefined, CELL)).toBeUndefined();
    expect(measureAuto(undefined, area, CELL)).toBeUndefined();
  });

  it('what it measures, resolveGeometry turns into that alternate', () => {
    const setting = { oversize: { kind: 'auto' } } as const;
    const g = resolveGeometry(setting, () => measureAuto(setting, area, CELL));
    expect(g).toMatchObject({ terminalType: 'IBM-DYNAMIC', alternate: { rows: 29, cols: 85 } });
  });
});
