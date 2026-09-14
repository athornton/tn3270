import type { Rgb } from '@tn3270/core';
import type { AtlasGeometry, DrawList } from './drawlist.js';

/**
 * Draw a `DrawList` onto a 2D canvas context.
 *
 * ## THE ATLAS IS COVERAGE, SO EVERY COLOUR NEEDS ITS OWN TINTED COPY
 *
 * `atlas.bin` is alpha only. Tinting per CELL would mean a composite operation 1920 times
 * a frame; tinting per COLOUR means at most sixteen, because that is how many a 3279 has.
 * So each colour gets one pre-tinted `ImageBitmap`-alike, built on demand and cached. The
 * cache is bounded by the palette, not by the screen, which is why it can be unbounded in
 * code without being unbounded in fact.
 *
 * ## SMOOTHING OFF, INTEGER SCALE ONLY
 *
 * `imageSmoothingEnabled = false` and an integer `scale`. This is what keeps a bitmap font
 * pixel-exact, and it is also what makes screenshot goldens byte-reproducible -- there is no
 * hinting and no subpixel antialiasing to vary between machines. A fractional scale would
 * smear the glyphs and make every golden machine-specific.
 *
 * Kept free of `document` and `window` so the arithmetic is testable: the caller supplies
 * the context and a factory for offscreen surfaces.
 */
export interface Surface {
  readonly width: number;
  readonly height: number;
}

/** The 2D context operations this needs, named so a test can supply a recorder. */
export interface Ctx2D {
  fillStyle: string;
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    image: unknown, sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void;
}

export interface BlitOptions {
  readonly atlas: AtlasGeometry;
  /** Integer multiple. 1 draws one atlas pixel per canvas pixel. */
  readonly scale: number;
  /** Left offset in canvas pixels, for letterboxing. */
  readonly offsetX: number;
  readonly offsetY: number;
  /**
   * A pre-tinted atlas for one colour, or `undefined` if it is not ready yet.
   *
   * Returning undefined SKIPS the glyph for this frame rather than drawing a placeholder.
   * An earlier version returned an empty `ImageData`, which `drawImage` rejects outright --
   * "the provided value is not of type ... ImageBitmap" -- so every cell threw and the
   * window drew backgrounds only. The caller repaints when the tint finishes building.
   */
  readonly tinted: (colour: Rgb) => unknown | undefined;
  /**
   * Atlas columns with NO INK, whose `drawImage` can be skipped. From `blankColumns`.
   *
   * Necessary rather than an optimisation detail: an untouched 3270 cell holds EBCDIC
   * 0x00, which maps to CG 0 (`null`), NOT to CG 16 (`space`). An earlier version tested
   * only for space and therefore stamped all 1920 cells of a blank screen -- caught by a
   * test asserting an empty screen issues no draws.
   */
  readonly blank: ReadonlySet<number>;
}

export const rgbCss = ([r, g, b]: Rgb): string => `rgb(${r},${g},${b})`;

/** Cache key for a tinted atlas. Colours are triples, so a string key is the simplest. */
export const tintKey = ([r, g, b]: Rgb): string => `${r},${g},${b}`;

/**
 * The largest integer scale whose letterboxed screen fits `within`, minimum 1.
 *
 * Stated as a rule rather than "fit to the window": a fractional fit would smear a bitmap
 * font, and refusing to draw at all when the window is small would be worse than drawing
 * small. 1 is the floor because there is no half-pixel glyph.
 */
export function bestScale(list: DrawList, within: Surface): number {
  const byWidth = Math.floor(within.width / list.width);
  const byHeight = Math.floor(within.height / list.height);
  return Math.max(1, Math.min(byWidth, byHeight));
}

/** Where to put the screen so it sits centred in `within` at `scale`. */
export function centre(list: DrawList, within: Surface, scale: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.floor((within.width - list.width * scale) / 2)),
    y: Math.max(0, Math.floor((within.height - list.height * scale) / 2)),
  };
}

export function blit(ctx: Ctx2D, list: DrawList, opts: BlitOptions): void {
  const { atlas, scale, offsetX, offsetY } = opts;
  ctx.imageSmoothingEnabled = false;

  const w = atlas.cellWidth * scale;
  const h = atlas.cellHeight * scale;

  for (const cell of list.cells) {
    const dx = offsetX + cell.x * scale;
    const dy = offsetY + cell.y * scale;

    // Background first, always -- including for a blank cell, or a previous frame's glyph
    // shows through. The 3270 has no transparency.
    ctx.fillStyle = rgbCss(cell.bg);
    ctx.fillRect(dx, dy, w, h);

    if (!opts.blank.has(cell.glyph)) {
      const image = opts.tinted(cell.fg);
      if (image !== undefined) {
        ctx.drawImage(
          image,
          cell.glyph * atlas.cellWidth, 0, atlas.cellWidth, atlas.cellHeight,
          dx, dy, w, h,
        );
      }
    }

    if (cell.underline) {
      ctx.fillStyle = rgbCss(cell.fg);
      ctx.fillRect(dx, dy + h - scale, w, scale);
    }

    if (cell.cursor) {
      // A block cursor drawn as a reverse bar over the bottom third: visible over a glyph
      // without hiding it, which a full reverse block does.
      ctx.fillStyle = rgbCss(cell.fg);
      ctx.fillRect(dx, dy + h - Math.max(scale, Math.floor(h / 4)), w, Math.max(scale, Math.floor(h / 4)));
    }
  }
}

/**
 * Which atlas columns contain no ink at all.
 *
 * Computed from the coverage bitmap rather than from a list of "blank-looking" codes,
 * because there is more than one: EBCDIC 0x00 (an untouched cell) is CG 0 `null`, EBCDIC
 * 0x40 is CG 16 `space`, and the font has others. Guessing the set is what made the first
 * version of this file stamp every cell of an empty screen.
 *
 * Worth the single startup pass over ~54 KB: a 3270 screen is 1920 cells and a logon panel
 * is mostly empty, so this removes the large majority of per-frame composites.
 */
export function blankColumns(bytes: Uint8Array, atlas: AtlasGeometry): ReadonlySet<number> {
  const stride = atlas.cols * atlas.cellWidth;
  const blank = new Set<number>();
  for (let col = 0; col < atlas.cols; col++) {
    let inked = false;
    for (let y = 0; y < atlas.cellHeight && !inked; y++) {
      const base = y * stride + col * atlas.cellWidth;
      for (let x = 0; x < atlas.cellWidth; x++) {
        if (bytes[base + x] !== 0) { inked = true; break; }
      }
    }
    if (!inked) blank.add(col);
  }
  return blank;
}
