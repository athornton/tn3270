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
 * ## THE STYLING IS FALLBACK 1, AND THE FONT STAYED
 *
 * The font choice was provisional and the ranked fallbacks were (1) restyle within the atlas --
 * inverse video, box-drawing borders -- then (2) a second baked bitmap font, and `fillText` not at
 * all without demoting the goldens in writing. The user saw the labels in the 3270 font on
 * 2026-09-17 and chose (1): nothing read as a BUTTON, and the one-character arrows `^ v < >` were
 * lone glyphs with no visible click target. So every key is now a 45x14 INVERSE VIDEO block on a
 * SPACED grid -- a blank row between key rows (`KEYPAD_ROWS_TALL`) and a blank column at the end of
 * every key (`KEYPAD_BLOCK_WIDTH`), both of which are what stop the blocks merging into bars rather
 * than reading as keys. It needs no new glyph and no `fillText`, so the goldens stay
 * byte-reproducible; the press highlight in `renderer.ts` had to become a DARK wash, and the note
 * there explains why.
 *
 * A PROPORTIONAL FONT WAS RULED OUT, measured, and this is why the ranking above is not revisited:
 * Helvetica's capital I is a bare stem, so `ErInp` renders as "Erlnp"; Inter Light put 0.4% of its
 * ink at full white against the screen's 100%, reading as greyed-out; and `fillText` rasterisation
 * is machine-dependent, which is the one thing that stops a golden reproducing.
 */
export interface KeypadRegion {
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly DrawCell[];
  readonly buttons: readonly KeypadButton[];
}

/**
 * Rows in the table, plus one blank separator row BETWEEN EVERY PAIR of them.
 *
 * Five declared rows (`KEYPAD_ROWS` in `frontend/src/keypad.ts`) with a gap after all but the last:
 * 5 + 4 = 9.
 *
 * THE GAPS ARE LOAD-BEARING AND NOT DECORATION, and they are the reason the inverse-video styling
 * works at all. A button is ONE CELL TALL, so with the key rows adjacent -- as they were, at six
 * rows for five -- each key's solid white block touches the block above it and a COLUMN of keys
 * merges into one white bar with the labels floating inside it. MEASURED on a mockup before this
 * change: `PF13`/`PF1` became a single two-cell block, as did `PA1`/`Attn`/`ErEOF`. Hence 9, and
 * hence `never puts two buttons in vertically-touching rows` in `keypad.test.ts`.
 */
export const KEYPAD_ROWS_TALL = 9;

/**
 * Which table row sits on which drawn row: table row r is drawn at 2r, so every ODD drawn row
 * (1, 3, 5, 7) is a blank separator and every key row lands on an even one.
 *
 * Indexed by `KeypadKey.row`, whose declared values are `KEYPAD_ROWS` (`frontend/src/keypad.ts`).
 * Written down rather than computed as `key.row * 2` for the same reason `KEYPAD_ROWS` itself is
 * written down: a table that agrees with the layout BY CONSTRUCTION cannot disagree, and this array
 * is also what makes the `undefined` guard below reachable for a key on a row nobody declared.
 */
const DRAWN_ROW: readonly number[] = Object.freeze([0, 2, 4, 6, 8]);

/**
 * How many of a key's six cells are PAINTED: five, so the sixth is a black separator COLUMN.
 *
 * The same argument the blank rows make, in the OTHER AXIS, and it was measured the hard way. Keys
 * on the PF rows are adjacent -- 12 of them at columns 0, 6, 12 ... 66 with no gutter between -- so
 * painting all six cells makes the twelve white blocks one continuous 648-pixel white bar, exactly as
 * the collapsed rows make a column of keys one white bar. Seen in the first capture of this change,
 * and it is why this constant is not `KEYPAD_KEY_WIDTH`.
 *
 * So each key is a 45x14 white rectangle (5 * 9 by 14) with a 9-pixel black gutter on its right, and
 * that 45x14 is also what gives a one-character arrow a target to aim at.
 *
 * THE BUTTON RECTANGLE STAYS SIX CELLS WIDE, deliberately: the hit rectangle is the whole key, so a
 * click in the separator column still works the key it belongs to. A 45-wide hit target would put a
 * 9-pixel dead stripe between every pair of keys -- forgiving is right for a mouse -- and every
 * containment, gutter and hit-test assertion in `keypad.test.ts` is written against the 6-cell pitch.
 */
const KEYPAD_BLOCK_WIDTH = KEYPAD_KEY_WIDTH - 1;

/**
 * The keypad's cells and buttons, with its top edge at `y` scale-1 pixels.
 *
 * The caller puts it BELOW the screen and the OIA, so showing the keypad never moves or covers a
 * row the host wrote.
 */
export function keypadRegion(atlas: AtlasGeometry, scheme: Scheme, y: number): KeypadRegion {
  // Our chrome, not one of the host's cells, so no byte in the data stream says what colour it is
  // -- the same argument and the same pair `oiaCells` uses in `drawlist.ts`.
  //
  // INVERSE VIDEO: that pair EXCHANGED, black ink on white paper, which is what makes a key read as
  // a button. Named for what they are rather than assigned to `fg`/`bg` inverted, because a reader
  // meeting `const fg = ...NEUTRAL_BLACK` next to a white background would take it for a typo.
  //
  // SOUND AGAINST THE BLITTER WITH NO OTHER CHANGE, checked in `blit.ts` rather than assumed: it
  // fills `cell.bg` over the whole cell unconditionally and then stamps the glyph tinted `cell.fg`,
  // so exchanging the two IS a reverse-video cell -- one `fillRect` and one composite, exactly as
  // before. There is no separate reverse flag to set. `intensify` is not read by the blitter at all;
  // `underline` and `cursor` are, and both paint `cell.fg`, which would now be a BLACK bar across
  // the bottom of a white key -- so all four stay false, as they already were, and the test says so.
  const ink = schemeRgb(scheme, Colour.NEUTRAL_BLACK);
  const paper = schemeRgb(scheme, Colour.NEUTRAL_WHITE);
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

    // THE WHOLE BLOCK, ALL FIVE CELLS OF IT, AND NOT JUST THE LABEL. With inverse video the cell
    // paints the background, so emitting only the label's characters draws a white patch the WIDTH OF
    // THE TEXT: `PA1` would be three cells of a six-cell key, and `^ v < >` would each be a lone 9x14
    // speck with nothing to aim at. Padding to `KEYPAD_BLOCK_WIDTH` is what makes every key the same
    // 45x14 rectangle. The sixth cell gets NO CELL AT ALL rather than a black-on-black one: the
    // renderer clears the canvas to black before blitting, so absence is already the separator, and
    // that is how the gutters between the clusters have always been drawn.
    //
    // CENTRED, not left-aligned -- the one place this departs from the mockup the user approved, and
    // it is a departure the mockup could not show: it left short labels flush left because there was
    // no block for them to be centred IN until the padding above existed. Five is an ODD width, so
    // every odd-length label -- including all four arrows and `PA1`/`Ins`/`Dup`/`Tab`/`Del` -- is now
    // EXACTLY centred, which is the case that reads worst when it is not. Only the 4-character labels
    // (`PF13`..`PF24`, `Home`, `Attn`, `BkSp`) lean half a cell left, and `Math.floor` is what decides
    // that.
    //
    // Labels are at most 5 characters (see `KeypadKey.label` in `frontend/src/keypad.ts` and the test
    // that pins it), which is exactly the block, so `left` is never negative and `padEnd` never
    // truncates: a label cannot spill into its neighbour.
    const left = Math.floor((KEYPAD_BLOCK_WIDTH - key.label.length) / 2);
    const text = key.label.padStart(key.label.length + left).padEnd(KEYPAD_BLOCK_WIDTH);
    for (let i = 0; i < KEYPAD_BLOCK_WIDTH; i++) {
      cells.push({
        x: bx + i * atlas.cellWidth,
        y: by,
        // A pad cell is a SPACE, and that is not the same as leaving it out: EBCDIC 0x40 is CG 16,
        // which `blankColumns` finds inkless, so the blitter skips its composite and paints the
        // white background only (`blit.ts`). Cheap, and it keeps one code path for all five cells.
        glyph: column(atlas, ebcdicToCg(cp037.fromUnicode(text[i]!))),
        fg: ink,
        bg: paper,
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
    // (`KEYPAD_KEY_WIDTH` in `frontend/src/keypad.ts`). Written down rather than measured from the
    // table, so a key
    // placed past the right edge fails a test instead of silently widening the window.
    width: 12 * KEYPAD_KEY_WIDTH * atlas.cellWidth,
    height: KEYPAD_ROWS_TALL * atlas.cellHeight,
    cells,
    buttons,
  };
}
