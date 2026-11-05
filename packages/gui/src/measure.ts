import { bestScale, type Surface } from '@tn3270/canvas';
import { resolveGeometry, type GeometrySetting, type Size } from '@tn3270/core';

/**
 * The part of the display the window may use: 80% of the work area each way, rounded down.
 * `fit()` in main.ts and `measureDisplay` below both use THIS, so they cannot disagree.
 */
export function windowArea(area: { readonly width: number; readonly height: number }): Surface {
  return { width: Math.floor(area.width * 0.8), height: Math.floor(area.height * 0.8) };
}

/**
 * The scale the GUI draws `list` at on a display with this work area: the largest integer multiple
 * that fits `windowArea`, never below 1 (`bestScale`, canvas/src/blit.ts). THIS IS `fit()`'s RULE,
 * moved here from main.ts so it can be tested -- main.ts imports `electron`, which vitest cannot
 * load -- and so `measureDisplay` uses the rule itself rather than a copy of it.
 */
export function windowScale(list: Surface, area: { readonly width: number; readonly height: number }): number {
  return bestScale(list, windowArea(area));
}

/**
 * `-oversize auto` in the GUI: how many rows and columns the display can hold "at the scale the
 * window would pick anyway" (the spec's "What each front end measures", the user's choice over
 * scale 1 and over refusing `auto` in the GUI).
 *
 * PURE, AND OUT OF main.ts FOR THAT REASON: main.ts imports `electron`, which vitest (node
 * environment, no Electron) cannot load, so arithmetic left there would be untested. main.ts
 * supplies the two things only Electron knows -- the work area and the atlas cell -- at call time.
 *
 * "The scale the window would pick" is `windowScale`, the function `fit()` itself calls:
 *  - of the MODEL's draw list -- `model.cols` cells wide and `model.rows + 1` high, the +1 being
 *    the OIA row `drawList` adds whenever there is OIA text (canvas/src/drawlist.ts), which is
 *    always: `Oia.toText()` returns at least the connection state, connected or not;
 *  - the answer is every whole cell that fits `windowArea` at that scale, less the OIA's row.
 *
 * `fit()` sizes the window from the draw list it is about to send, which for an oversize screen is
 * the OVERSIZE list -- bigger than the model's. `windowScale` nonetheless gives it THE SAME scale,
 * so the screen is drawn at the scale the user chose: at scale `s` the oversize list fits
 * `windowArea` by construction (each dimension was cut to it), so the scale is at least `s`; and
 * when the result is at least the model in both dimensions (anything smaller falls back to the
 * model in `resolveGeometry`) the list is at least the model's, so it is at most `s`. The 14-bit
 * clamp cuts rows only, keeping the width, and the width alone still pins it to `s`.
 * `measure.test.ts` sweeps displays and models through `windowScale` to check it.
 */
export function measureDisplay(
  area: { readonly width: number; readonly height: number },
  cell: { readonly width: number; readonly height: number },
  model: Size,
): Size | undefined {
  const within = windowArea(area);
  const scale = windowScale(
    { width: model.cols * cell.width, height: (model.rows + 1) * cell.height }, area);
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
