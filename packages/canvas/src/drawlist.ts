import {
  cp037, Colour, type Rgb, type ResolvedCell, type ScreenSnapshot,
} from '@tn3270/core';
import { schemeRgb, type Scheme } from '@tn3270/frontend';
import { ebcdicToCg, CG_BOXSOLID } from './cg.js';

/**
 * Turn a screen snapshot plus its resolved attributes into per-cell draw instructions.
 *
 * THIS FILE RUNS IN THE MAIN PROCESS ONLY. `renderer.js` reaches it through `import type`
 * alone, which erases, so the value import above cannot reach the browser. Task 4 pins that.
 *
 * ## PURE, AND THAT IS THE POINT
 *
 * This is where reverse video, the cursor, colour and the hidden-field rule are decided,
 * and it is testable with no canvas, no Xvfb and no Electron. `render.ts` in the TUI is
 * built the same way -- it returns a string and lets the caller write it -- and that is
 * what made the TUI's output diffable and its tests fast. Putting these decisions inside a
 * canvas call would put every one of them behind a screenshot.
 *
 * ## WHY IT TAKES BOTH THE SNAPSHOT AND THE RESOLVED CELLS
 *
 * They are parallel arrays and each has half of what a glyph needs. `resolve()` gives
 * colour and the attribute flags but its `text` is a STRING, while the atlas is indexed by
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
 * matching the TUI at `render.ts:343`.
 */
export interface AtlasGeometry {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cols: number;
  /** CG code to atlas column. Sparse: the font's encodings run 0..543 with holes. */
  readonly index: Readonly<Record<number, number>>;
}

export interface DrawCell {
  readonly x: number;
  readonly y: number;
  /** Atlas COLUMN, already resolved through the CG map. */
  readonly glyph: number;
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly cursor: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly intensify: boolean;
}

export interface DrawList {
  readonly cells: readonly DrawCell[];
  /**
   * Absent when no OIA text was supplied, and the height is then the screen alone.
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
    // colours are what a 3279 inverts.
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
    height: rows * atlas.cellHeight,
  };
}

/**
 * The OIA as atlas cells on the row below the screen buffer.
 *
 * Neutral white on black, which is a presentation choice rather than a protocol fact: the
 * OIA is OUR chrome, not one of the host's 1920 cells, so nothing in the data stream says
 * what colour it should be. Truncated at the screen width rather than wrapped, because a
 * status line that reflowed would move the screen.
 */
function oiaCells(
  text: string, y: number, cols: number, atlas: AtlasGeometry, scheme: Scheme,
): readonly DrawCell[] {
  const fg = schemeRgb(scheme, Colour.NEUTRAL_WHITE);
  const bg = schemeRgb(scheme, Colour.NEUTRAL_BLACK);
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

/**
 * The atlas column for a CG code, falling back to the solid box.
 *
 * A MISS MUST NOT BECOME AN OUT-OF-RANGE COLUMN. Sampling past the end of the atlas draws
 * whichever glyph sits next along, which reads as corruption rather than as a missing
 * character -- so an unknown code gets x3270's visible unprintable marker instead.
 *
 * EXPORTED FOR `keypad.ts`, WHICH MUST NOT HAVE ITS OWN COPY. `atlas.index` is a sparse map and
 * emphatically not the identity: 175 of its 431 entries differ from their CG code, because the
 * font's encodings run 0..543 with holes and the atlas is packed. Any second calculation --
 * `cg % atlas.cols` was the one proposed -- both loses the fallback above and returns the wrong
 * column for every code past 256, which is a font bug only a golden could catch.
 */
export function column(atlas: AtlasGeometry, cg: number): number {
  return atlas.index[cg] ?? atlas.index[CG_BOXSOLID] ?? 0;
}
