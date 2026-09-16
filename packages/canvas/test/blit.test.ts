import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Screen, resolve, Colour } from '@tn3270/core';
import { SCHEMES, schemeRgb } from '@tn3270/frontend';
import { drawList, type AtlasGeometry } from '../src/drawlist.js';
import {
  blit, bestScale, centre, rgbCss, tintKey, blankColumns, type Ctx2D,
} from '../src/blit.js';

const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const atlas: AtlasGeometry = JSON.parse(readFileSync(join(distDir, 'atlas.json'), 'utf8'));
const blank = blankColumns(new Uint8Array(readFileSync(join(distDir, 'atlas.bin'))), atlas);

const listFor = (chars: readonly [number, number][] = [], oia?: string) => {
  const s = new Screen({ rows: 24, cols: 80 });
  for (const [addr, e] of chars) s.setChar(addr, e);
  const snap = s.snapshot();
  return drawList(snap, resolve(snap), atlas, SCHEMES.default!, oia);
};

/** Records what was asked of the context, so the arithmetic can be asserted. */
function recorder() {
  const fills: { x: number; y: number; w: number; h: number; style: string }[] = [];
  const draws: { sx: number; dx: number; dy: number; dw: number; dh: number }[] = [];
  let smoothing = true;
  const ctx: Ctx2D = {
    fillStyle: '',
    get imageSmoothingEnabled() { return smoothing; },
    set imageSmoothingEnabled(v: boolean) { smoothing = v; },
    fillRect(x, y, w, h) { fills.push({ x, y, w, h, style: this.fillStyle }); },
    drawImage(_img, sx, _sy, _sw, _sh, dx, dy, dw, dh) { draws.push({ sx, dx, dy, dw, dh }); },
  };
  return { ctx, fills, draws, smoothing: () => smoothing };
}

const opts = (scale = 1, offsetX = 0, offsetY = 0) =>
  ({ atlas, scale, offsetX, offsetY, tinted: () => ({}), blank });

describe('bestScale', () => {
  it('is the largest integer multiple that fits, never fractional', () => {
    const list = listFor();                       // 720x336 at 9x14
    expect(bestScale(list, { width: 720, height: 336 })).toBe(1);
    expect(bestScale(list, { width: 1440, height: 672 })).toBe(2);
    // 1.9x fits but must round DOWN: a fractional scale smears a bitmap font.
    expect(bestScale(list, { width: 1400, height: 650 })).toBe(1);
  });

  it('is limited by the tighter axis', () => {
    const list = listFor();
    expect(bestScale(list, { width: 5000, height: 336 })).toBe(1);
  });

  it('never goes below 1, even in a window too small to hold the screen', () => {
    // Drawing small beats refusing to draw: unlike the TUI there is no risk of corrupting
    // a terminal, and a clipped window is something the user can resize.
    expect(bestScale(listFor(), { width: 100, height: 50 })).toBe(1);
  });
});

describe('centre', () => {
  it('letterboxes evenly', () => {
    const list = listFor();                       // 720x336
    expect(centre(list, { width: 800, height: 400 }, 1)).toEqual({ x: 40, y: 32 });
  });

  it('clamps to zero rather than going negative when the window is too small', () => {
    expect(centre(listFor(), { width: 100, height: 50 }, 1)).toEqual({ x: 0, y: 0 });
  });
});

describe('blit', () => {
  it('turns image smoothing OFF, which is what keeps glyphs pixel-exact', () => {
    const r = recorder();
    blit(r.ctx, listFor(), opts());
    expect(r.smoothing()).toBe(false);
  });

  it('fills a background for every cell, even blank ones', () => {
    // Skipping the fill on a blank cell leaves the previous frame's glyph showing: the
    // 3270 has no transparency.
    //
    // Filtered on FULL CELL HEIGHT, not width alone: the cursor bar is also cellWidth wide
    // at scale 1, so a width-only filter counted 1921 and looked like an off-by-one in the
    // loop rather than an imprecise assertion.
    const r = recorder();
    blit(r.ctx, listFor(), opts());
    const backgrounds = r.fills.filter(
      (f) => f.w === atlas.cellWidth && f.h === atlas.cellHeight);
    expect(backgrounds).toHaveLength(24 * 80);
  });

  it('stamps a glyph only for non-blank cells', () => {
    // An all-blank screen must issue no drawImage at all -- 1920 needless composites per
    // frame is the cost of getting this wrong, on a screen that is mostly blank.
    const blank = recorder();
    blit(blank.ctx, listFor(), opts());
    expect(blank.draws).toHaveLength(0);

    const one = recorder();
    blit(one.ctx, listFor([[0, 0xc1]]), opts());
    expect(one.draws).toHaveLength(1);
  });

  it('SKIPS a glyph whose tint is not ready, rather than drawing a placeholder', () => {
    // An earlier version passed an empty ImageData, which drawImage rejects outright, so
    // every cell threw and the window drew backgrounds only -- a blank screen with no clue.
    const r = recorder();
    blit(r.ctx, listFor([[0, 0xc1]]), { ...opts(), tinted: () => undefined });
    expect(r.draws).toHaveLength(0);
    // The background must still have been filled: a missing tint is not a missing cell.
    expect(r.fills.filter((f) => f.h === atlas.cellHeight)).toHaveLength(24 * 80);
  });

  it('samples the atlas at the glyph column, scaled by cell width', () => {
    const r = recorder();
    blit(r.ctx, listFor([[0, 0xc1]]), opts());
    expect(r.draws[0]!.sx).toBe(atlas.index[160]! * atlas.cellWidth);   // CG 160 = 'A'
  });

  it('scales and offsets destination geometry by integers', () => {
    const r = recorder();
    blit(r.ctx, listFor([[81, 0xc1]]), opts(3, 10, 20));
    const d = r.draws[0]!;
    expect(d.dw).toBe(atlas.cellWidth * 3);
    expect(d.dh).toBe(atlas.cellHeight * 3);
    expect(d.dx).toBe(10 + atlas.cellWidth * 3);      // col 1 at scale 3, plus offset
    expect(d.dy).toBe(20 + atlas.cellHeight * 3);
  });

  it('draws the cursor as a bar without suppressing the glyph under it', () => {
    // A full reverse block hides the character the cursor is on, which matters most on the
    // field you are typing into.
    const r = recorder();
    blit(r.ctx, listFor([[0, 0xc1]]), opts());
    expect(r.draws).toHaveLength(1);                    // the glyph was still stamped
    const bars = r.fills.filter((f) => f.h < atlas.cellHeight);
    expect(bars.length).toBeGreaterThanOrEqual(1);
  });
});

describe('blankColumns', () => {
  it('finds the glyphs with no ink, and they include null AND space', () => {
    // The bug this exists for: an untouched 3270 cell is EBCDIC 0x00 -> CG 0 (`null`), not
    // CG 16 (`space`). Testing only for space stamped all 1920 cells of an empty screen.
    expect(blank.has(atlas.index[0]!), 'CG 0 (null) should be blank').toBe(true);
    expect(blank.has(atlas.index[16]!), 'CG 16 (space) should be blank').toBe(true);
    expect(blank.has(atlas.index[160]!), 'CG 160 (A) should NOT be blank').toBe(false);
    expect(blank.has(atlas.index[223]!), 'CG 223 (boxsolid) should NOT be blank').toBe(false);
  });
});

describe('colour helpers', () => {
  it('formats an Rgb as CSS', () => {
    expect(rgbCss(schemeRgb(SCHEMES.default!, Colour.GREEN))).toMatch(/^rgb\(\d+,\d+,\d+\)$/);
  });

  it('keys the tint cache by colour, so it is bounded by the palette', () => {
    // A 3279 has sixteen colours, so tinting per COLOUR is at most sixteen composites
    // where tinting per cell would be 1920 a frame.
    const keys = new Set(Object.values(Colour).map((c) => tintKey(schemeRgb(SCHEMES.default!, c))));
    expect(keys.size).toBeLessThanOrEqual(16);
  });
});
