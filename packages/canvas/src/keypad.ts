import { cp037, Colour } from '@tn3270/core';
import { KEYPAD_KEYS, KEYPAD_KEY_WIDTH, schemeRgb, type Scheme } from '@tn3270/frontend';
import { ebcdicToCg, column } from './cg.js';
// FROM `geometry.js`, NOT `drawlist.js`, and that is the point: `drawlist.js` imports THIS module
// for `keypadRegion`, so any import of it from here -- even a type one -- closes a cycle.
// `column()` moved to `cg.js` for the runtime half of the same problem, and these two interfaces
// moved to a leaf module for the type half. `module-cycles.test.ts` reads the SOURCE, because a
// type import is invisible in `dist`.
import type { AtlasGeometry, DrawCell } from './geometry.js';
import type { KeypadButton } from './hittest.js';

/**
 * The virtual keypad, as cells and rectangles.
 *
 * THIS FILE RUNS IN THE MAIN PROCESS ONLY, like `drawlist.js` and for the same reason: the value
 * imports above are bare `@tn3270/` specifiers, which a browser cannot resolve. The renderer gets
 * the finished region inside the draw list, and reaches `hitTest` through `hittest.js` -- a separate
 * file with no runtime import at all, which is what lets the browser have it.
 *
 * ## SCALE-1 PIXELS THROUGHOUT
 *
 * The same coordinate space `DrawCell.x/.y` and `DrawList.oia.y` already use
 * (`drawlist.ts:112-113` emits `x: col * atlas.cellWidth`). The renderer multiplies by whatever
 * integer scale it picks at paint time and adds the centring offset, exactly as it does for the
 * screen, so nothing here goes stale on a resize. There are deliberately NO cell coordinates in
 * this file's output: two conventions in one structure is how an off-by-one becomes invisible.
 *
 * ## DRAWN THROUGH THE GLYPH ATLAS, NOT WITH `fillText`
 *
 * Labels are EBCDIC-encoded and looked up in the atlas like any other cell, through the SAME
 * `column()` the screen and the OIA use (`cg.ts:106`, the one copy). That is what keeps the screenshot goldens
 * byte-reproducible: `fillText` would pull in a system font, and font rasterisation is the
 * machine-dependent thing that stops a golden reproducing -- the reason `drawlist.ts:53-61` gives
 * for the OIA taking the same route.
 *
 * The FONT CHOICE is provisional: the user has not yet seen the labels in the 3270 font and the
 * ranked fallbacks are (1) restyle within the atlas -- inverse video, box-drawing borders -- then
 * (2) a second baked bitmap font, and `fillText` not at all without demoting the goldens in
 * writing. Options 1 and 2 change only this file, which is why the drawing decisions are local.
 */
export interface KeypadRegion {
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly DrawCell[];
  readonly buttons: readonly KeypadButton[];
}

/** Rows in the table, plus one blank separator under the PF block. */
export const KEYPAD_ROWS_TALL = 6;

/**
 * Which table row sits on which drawn row: rows 0 and 1 are the PF block, then a gap, then 2-4.
 *
 * Indexed by `KeypadKey.row`, whose declared values are `KEYPAD_ROWS` (`frontend/src/keypad.ts:93`).
 * The blank drawn row 2 separates the PF block from the clusters, and is the whole reason
 * `KEYPAD_ROWS_TALL` is 6 for a five-row table.
 */
const DRAWN_ROW: readonly number[] = Object.freeze([0, 1, 3, 4, 5]);

/**
 * The keypad's cells and buttons, with its top edge at `y` scale-1 pixels.
 *
 * The caller puts it BELOW the screen and the OIA, so showing the keypad never moves or covers a
 * row the host wrote.
 */
export function keypadRegion(atlas: AtlasGeometry, scheme: Scheme, y: number): KeypadRegion {
  // Our chrome, not one of the host's cells, so no byte in the data stream says what colour it is
  // -- the same argument and the same pair `oiaCells` uses at `drawlist.ts:168-169`.
  const fg = schemeRgb(scheme, Colour.NEUTRAL_WHITE);
  const bg = schemeRgb(scheme, Colour.NEUTRAL_BLACK);
  const cells: DrawCell[] = [];
  const buttons: KeypadButton[] = [];

  for (const key of KEYPAD_KEYS) {
    const drawnRow = DRAWN_ROW[key.row];
    // THROW RATHER THAN LET IT BE `undefined`. A key on a row this map does not cover would
    // otherwise give `NaN * cellHeight`, and a NaN rectangle draws nowhere and matches no hit
    // test: the keypad would silently lose a row instead of failing.
    if (drawnRow === undefined) {
      throw new RangeError(`keypad key ${key.name} is on row ${key.row}, which has no drawn row`);
    }
    const bx = key.col * atlas.cellWidth;
    const by = y + drawnRow * atlas.cellHeight;

    buttons.push({
      x: bx,
      y: by,
      w: KEYPAD_KEY_WIDTH * atlas.cellWidth,
      h: atlas.cellHeight,
      action: key.action,
      label: key.label,
    });

    // Left-aligned in the key. Labels are at most 5 characters against a 6-cell key
    // (`frontend/src/keypad.ts:70` and the test that pins it), so a label cannot spill into its
    // neighbour.
    for (let i = 0; i < key.label.length; i++) {
      cells.push({
        x: bx + i * atlas.cellWidth,
        y: by,
        glyph: column(atlas, ebcdicToCg(cp037.fromUnicode(key.label[i]!))),
        fg,
        bg,
        cursor: false,
        underline: false,
        blink: false,
        intensify: false,
      });
    }
  }

  return {
    y,
    // The PF block is the widest row: 12 keys of 6 cells span 72, inside an 80-column screen
    // (`frontend/src/keypad.ts:95-96`). Written down rather than measured from the table, so a key
    // placed past the right edge fails a test instead of silently widening the window.
    width: 12 * KEYPAD_KEY_WIDTH * atlas.cellWidth,
    height: KEYPAD_ROWS_TALL * atlas.cellHeight,
    cells,
    buttons,
  };
}
