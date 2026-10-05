/**
 * Turn a screen snapshot plus its resolved attributes into per-cell draw instructions.
 *
 * THIS FILE RUNS IN THE MAIN PROCESS ONLY. `renderer.js` reaches it through `import type`
 * alone, which erases, so the value import above cannot reach the browser. Task 4 pins that.
 *
 * ## PURE, AND THAT IS THE POINT
 *
 * This is where reverse video, the cursor, color and the hidden-field rule are decided,
 * and it is testable with no canvas, no Xvfb and no Electron. `render.ts` in the TUI is
 * built the same way -- it returns a string and lets the caller write it -- and that is
 * what made the TUI's output diffable and its tests fast. Putting these decisions inside a
 * canvas call would put every one of them behind a screenshot.
 *
 * ## WHY IT TAKES BOTH THE SNAPSHOT AND THE RESOLVED CELLS
 *
 * They are parallel arrays and each has half of what a glyph needs. `resolve()` gives
 * color and the attribute flags but its `text` is a STRING, while the atlas is indexed by
 * the font's Character Generator codes, reached from the EBCDIC byte that only the raw
 * snapshot carries. Zipping them by index costs nothing and avoids a Unicode round trip
 * that would lose APL. The design assumed `resolve()` alone would do; it does not.
 *
 * ## THE HIDDEN-FIELD RULE IS A SECURITY REQUIREMENT, NOT A DETAIL
 *
 * core's comment on `ResolvedCell.hidden`: it "is the ONLY thing standing between a
 * password field and the screen", and neither `text` nor the snapshot's `ebcdic` is
 * pre-redacted. A renderer that draws the glyph without checking this puts the password on
 * screen -- and in this project's case into committed screenshot goldens. Blanked here,
 * matching the TUI at `render.ts:369`.
 *
 * ## `AtlasGeometry` AND `DrawCell` ARE NOT DECLARED HERE ANY MORE
 *
 * They are in `geometry.ts`, which imports no sibling. They were here, and `cg.ts`, `assets.ts`
 * and `blit.ts` all took them from here with `import type` -- while this module value-imports
 * `column` from `cg.ts`. That is an import cycle in the type position: harmless while the imports
 * erase, and a module-initialization ordering bug the day one of them becomes a value. See
 * `geometry.ts` and the guard in `test/module-cycles.test.ts`.
 *
 * `keypad.ts` WAS THE OTHER HALF OF THAT CYCLE and is gone (2026-10-06): neither front end draws
 * a keypad into the canvas any more, so `keypadRegion` had no consumer. `DrawList` named its
 * `KeypadRegion`, which was the stated reason the type could not live in a leaf module -- that
 * reason has now expired, and moving `DrawList` into `geometry.ts` is a tidy somebody could do.
 * Not done here: this change is already deleting a shipped feature's worth of code, and mixing a
 * type move into it would make the diff harder to read than the tidy is worth.
 */

import {
  cp037, Color, type ResolvedCell, type ScreenSnapshot,
} from '@tn3270/core';
import { schemeRgb, type Scheme } from '@tn3270/frontend';
import { ebcdicToCg, column } from './cg.js';
import type { AtlasGeometry, DrawCell } from './geometry.js';

export interface DrawList {
  readonly cells: readonly DrawCell[];
  /**
   * Absent when no OIA text was supplied, and the height then omits its row.
   *
   * `cells` is the OIA rendered THROUGH THE SAME ATLAS as the screen, not text for the
   * canvas to typeset. That is not cosmetic consistency: `fillText` would pull in a system
   * font, and font rasterisation is exactly the machine-dependent thing that would stop
   * screenshot goldens being byte-reproducible. `text` is kept alongside for debugging and
   * for tests to assert against something readable.
   */
  readonly oia?: {
    readonly text: string;
    readonly y: number;
    readonly cells: readonly DrawCell[];
  };
  readonly width: number;
  readonly height: number;
}

/** EBCDIC space, which is what a hidden cell draws instead of its own character. */
const EBCDIC_SPACE = 0x40;

// `scheme` comes BEFORE `oiaText`: an existing call passing OIA text positionally would
// otherwise silently take it as the scheme, with no type error and no failing test.
//
// A SIXTH `showKeypad` PARAMETER WAS HERE AND IS GONE (2026-10-06). It was appended and defaulted
// to off for exactly the reason above -- so existing callers kept their meaning -- and both front
// ends now draw their keypad as real HTML controls instead, so nothing ever passed `true`.
// Removing it rather than leaving a parameter no caller sets: a defaulted flag that cannot be
// turned on is a reader trap, and `tsc` catches every stale `true` at the call site.
export function drawList(
  snapshot: ScreenSnapshot,
  resolved: readonly ResolvedCell[],
  atlas: AtlasGeometry,
  scheme: Scheme,
  oiaText?: string,
): DrawList {
  const blank = column(atlas, ebcdicToCg(EBCDIC_SPACE));
  const cells: DrawCell[] = [];

  for (let i = 0; i < snapshot.cells.length; i++) {
    const raw = snapshot.cells[i]!;
    const r = resolved[i]!;
    const row = Math.floor(i / snapshot.cols);
    const col = i % snapshot.cols;

    // Reverse video swaps the pair rather than picking a fixed inverse: the cell's own
    // colors are what a 3279 inverts.
    const fg = schemeRgb(scheme, r.reverse ? r.bg : r.fg);
    const bg = schemeRgb(scheme, r.reverse ? r.fg : r.bg);

    cells.push({
      x: col * atlas.cellWidth,
      y: row * atlas.cellHeight,
      glyph: r.hidden ? blank : column(atlas, ebcdicToCg(raw.ebcdic ?? EBCDIC_SPACE)),
      fg,
      bg,
      cursor: i === snapshot.cursor,
      underline: r.underscore,
      blink: r.blink,
      intensify: r.intensify,
    });
  }

  const rows = snapshot.rows + (oiaText !== undefined ? 1 : 0);
  const oiaY = snapshot.rows * atlas.cellHeight;
  return {
    cells,
    ...(oiaText !== undefined
      ? {
        oia: {
          text: oiaText,
          y: oiaY,
          cells: oiaCells(oiaText, oiaY, snapshot.cols, atlas, scheme),
        },
      }
      : {}),
    width: snapshot.cols * atlas.cellWidth,
    // SCREEN PLUS THE OIA's ROW, AND NOTHING ELSE NOW. A `keypadY + keypad.height` branch was here
    // until 2026-10-06 and the keypad was the only thing that ever made the drawing taller than
    // its rows; `rows` already counts the OIA's row when there is one, so this one expression
    // covers both cases. `gui/src/main.ts`'s `fit` sizes the window from this, which is why the
    // keypad had to live in the draw list at all -- a renderer-owned one would have left main
    // unaware the drawing had grown and the Electron page is `overflow:hidden`, so it would have
    // been clipped. That whole argument is moot now: the keypad is a separate WINDOW in Electron
    // and an overlay in the browser, and neither changes this height.
    height: rows * atlas.cellHeight,
  };
}

/**
 * The OIA as atlas cells on the row below the screen buffer.
 *
 * Neutral white on black, which is a presentation choice rather than a protocol fact: the
 * OIA is OUR chrome, not one of the host's 1920 cells, so nothing in the data stream says
 * what color it should be. Truncated at the screen width rather than wrapped, because a
 * status line that reflowed would move the screen.
 */
function oiaCells(
  text: string, y: number, cols: number, atlas: AtlasGeometry, scheme: Scheme,
): readonly DrawCell[] {
  const fg = schemeRgb(scheme, Color.NEUTRAL_WHITE);
  const bg = schemeRgb(scheme, Color.NEUTRAL_BLACK);
  const out: DrawCell[] = [];
  const chars = [...text].slice(0, cols);
  for (let i = 0; i < chars.length; i++) {
    out.push({
      x: i * atlas.cellWidth,
      y,
      glyph: column(atlas, ebcdicToCg(cp037.fromUnicode(chars[i]!))),
      fg,
      bg,
      cursor: false,
      underline: false,
      blink: false,
      intensify: false,
    });
  }
  return out;
}
