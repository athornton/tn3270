import type { Size } from '@tn3270/core';

/**
 * `-oversize auto` in the gateway: how many rows and columns the browser's viewport holds.
 *
 * AT SCALE 1, per the spec's "What each front end measures": the page does not know the cell size
 * until the gateway's `atlas` reply, which follows `hello`, so it sends CSS pixels and the GATEWAY
 * converts them with the atlas cell. Scale 1 is the smallest the renderer draws at
 * (`canvas/src/renderer.ts` picks `bestScale`, never below 1), so a screen sized this way fits.
 *
 * LESS ONE ROW FOR THE OIA: `drawList` adds a row below the screen whenever there is OIA text
 * (`canvas/src/drawlist.ts`, `rows = snapshot.rows + 1`), and the gateway always passes some --
 * `Oia.toText()` returns at least the connection state, connected or not.
 *
 * `undefined` -- NO MEASUREMENT -- when the browser sent no viewport, or the result has no room
 * for a column or for a row beside the OIA. `resolveGeometry` turns that into its "no window size
 * known" fallback to the model. Pure, so vitest reaches it without a socket.
 */
export function measureViewport(
  vp: { readonly width: number; readonly height: number } | undefined,
  cell: { readonly width: number; readonly height: number },
): Size | undefined {
  if (vp === undefined) return undefined;
  const cols = Math.floor(vp.width / cell.width);
  const rows = Math.floor(vp.height / cell.height) - 1;
  if (!(rows > 0 && cols > 0 && Number.isFinite(rows) && Number.isFinite(cols))) return undefined;
  return { rows, cols };
}
