import { bestScale } from '@tn3270/canvas';
import { resolveGeometry, type GeometrySetting, type Size } from '@tn3270/core';

/**
 * `-oversize auto` in the GUI: how many rows and columns the display can hold "at the scale the
 * window would pick anyway" (the spec's "What each front end measures", the user's choice over
 * scale 1 and over refusing `auto` in the GUI).
 *
 * PURE, AND OUT OF main.ts FOR THAT REASON: main.ts imports `electron`, which vitest (node
 * environment, no Electron) cannot load, so arithmetic left there would be untested. main.ts
 * supplies the two things only Electron knows -- the work area and the atlas cell -- at call time.
 *
 * THIS MIRRORS `fit()` in main.ts, which is what "the scale the window would pick" means:
 *  - `within` is 80% of the work area each way, floored, exactly as `fit()` computes it;
 *  - the scale is `bestScale` (canvas/src/blit.ts: the largest integer multiple that fits, never
 *    below 1) of the MODEL's draw list -- `model.cols` cells wide and `model.rows + 1` high, the +1
 *    being the OIA row `drawList` adds whenever there is OIA text (canvas/src/drawlist.ts), which
 *    there always is once connected;
 *  - the answer is every whole cell that fits `within` at that scale, less the OIA's row.
 *
 * `fit()` sizes the window from the draw list it is about to send, which for an oversize screen is
 * the OVERSIZE list -- bigger than the model's. It nonetheless picks THE SAME scale, so the screen
 * is drawn at the scale the user chose: at scale `s` the oversize list fits `within` by
 * construction (each dimension was cut to it), so `bestScale` is at least `s`; and when the result
 * is at least the model in both dimensions (anything smaller falls back to the model in
 * `resolveGeometry`) the list is at least the model's, so it is at most `s`. The 14-bit clamp cuts
 * rows only, keeping the width, and the width alone still pins it to `s`. `measure.test.ts` sweeps
 * displays and models to check it.
 */
export function measureDisplay(
  area: { readonly width: number; readonly height: number },
  cell: { readonly width: number; readonly height: number },
  model: Size,
): Size | undefined {
  const within = { width: Math.floor(area.width * 0.8), height: Math.floor(area.height * 0.8) };
  const scale = bestScale(
    { width: model.cols * cell.width, height: (model.rows + 1) * cell.height }, within);
  const cols = Math.floor(within.width / (cell.width * scale));
  const rows = Math.floor(within.height / (cell.height * scale)) - 1;
  // No room for a row plus the OIA, or a cell with no size: no measurement, which geometry.ts
  // turns into its "no window size known" fallback.
  if (!(rows > 0 && cols > 0 && Number.isFinite(rows) && Number.isFinite(cols))) return undefined;
  return { rows, cols };
}

/**
 * The session's `auto` measure, given what main.ts can read when `connect()` calls it.
 *
 * The MODEL is the setting's at call time -- `resolveGeometry` with the oversize dropped, which is
 * the model's own alternate -- so a model changed between connects (step 2's switching) is the one
 * measured against. Any input missing (no atlas read, no display, a legacy-mode session) is no
 * measurement rather than a throw: a throw here would fail the connect, and the spec's answer for
 * a window that cannot be measured is to fall back to the model and say so.
 */
export function measureAuto(
  setting: GeometrySetting | undefined,
  area: { readonly width: number; readonly height: number } | undefined,
  cell: { readonly width: number; readonly height: number } | undefined,
): Size | undefined {
  if (setting === undefined || area === undefined || cell === undefined) return undefined;
  const model = resolveGeometry({ ...setting, oversize: { kind: 'none' } }).alternate;
  return measureDisplay(area, cell, model);
}
