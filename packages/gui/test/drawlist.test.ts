import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Screen, resolve, Colour, colourRgb, type ResolvedCell } from '@tn3270/core';
import { drawList, type AtlasGeometry } from '../src/drawlist.js';
import { ebcdicToCg, CG_BOXSOLID } from '../src/cg.js';

/** The real atlas, so the glyph indices under test are the ones that will be drawn. */
const atlas: AtlasGeometry = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'atlas.json'), 'utf8'));

/** A 24x80 screen with the given EBCDIC bytes placed at the given addresses. */
function screenWith(chars: readonly [number, number][]): Screen {
  const s = new Screen({ rows: 24, cols: 80 });
  for (const [addr, ebcdic] of chars) s.setChar(addr, ebcdic);
  return s;
}

const listFor = (s: Screen, oia?: string) => {
  const snap = s.snapshot();
  return drawList(snap, resolve(snap), atlas, oia);
};

describe('drawList', () => {
  it('emits one entry per screen cell', () => {
    const dl = listFor(screenWith([[0, 0xc1]]));
    expect(dl.cells).toHaveLength(24 * 80);
  });

  it('places cell (row, col) at the right pixel', () => {
    const dl = listFor(screenWith([[81, 0xc1]]));    // row 2, col 2 (0-based 1,1)
    expect(dl.cells[81]).toMatchObject({ x: atlas.cellWidth, y: atlas.cellHeight });
  });

  it('looks the glyph up through the CG MAP, not by EBCDIC value', () => {
    // The correction that Task 3 forced. EBCDIC 0xc1 must draw 'A', which lives at CG 160
    // -- so the column is index[160], and emphatically not index[0xc1].
    const dl = listFor(screenWith([[0, 0xc1]]));
    expect(dl.cells[0]!.glyph).toBe(atlas.index[ebcdicToCg(0xc1)]);
    expect(dl.cells[0]!.glyph).not.toBe(atlas.index[0xc1]);
  });

  it('converts Colour3279 codes to RGB, since the atlas is colourless coverage', () => {
    const dl = listFor(screenWith([[0, 0xc1]]));
    // Default unformatted foreground is green on a 3279.
    expect(dl.cells[0]!.fg).toEqual(colourRgb(Colour.GREEN));
    expect(dl.cells[0]!.fg).not.toBe(Colour.GREEN);      // a code, not an Rgb
  });

  it('SWAPS foreground and background for a reverse-video cell', () => {
    // Reverse video is the one attribute a blitter cannot infer, and getting it wrong is
    // invisible on a mostly-empty screen. Asserted as a swap of the same two colours
    // rather than against literal RGB, so a palette change does not break it.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const plain = drawList(snap, resolve(snap), atlas).cells[0]!;
    const flipped = resolve(snap).map((c, i): ResolvedCell => (i === 0 ? { ...c, reverse: true } : c));
    const reversed = drawList(snap, flipped, atlas).cells[0]!;
    expect(reversed.fg).toEqual(plain.bg);
    expect(reversed.bg).toEqual(plain.fg);
  });

  it('marks exactly one cell as the cursor', () => {
    const dl = listFor(screenWith([[0, 0xc1]]));
    expect(dl.cells.filter((c) => c.cursor)).toHaveLength(1);
  });

  it('DRAWS A HIDDEN CELL BLANK, never its text', () => {
    // THE SECURITY CASE. core's own comment: `hidden` "is the ONLY thing standing between
    // a password field and the screen", and `text`/`ebcdic` are deliberately NOT
    // pre-redacted. The TUI blanks it at render.ts:343 and the GUI matches. Without this
    // the window shows passwords -- and Task 10 commits screenshots to git.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const hidden = resolve(snap).map((c, i): ResolvedCell => (i === 0 ? { ...c, hidden: true } : c));
    const dl = drawList(snap, hidden, atlas);
    expect(dl.cells[0]!.glyph).toBe(atlas.index[ebcdicToCg(0x40)]);   // CG space
    expect(dl.cells[0]!.glyph).not.toBe(atlas.index[ebcdicToCg(0xc1)]);
  });

  it('carries blink, intensify and underscore through', () => {
    // All three exist on ResolvedCell and the plan's original DrawCell dropped them, which
    // would have silently lost host-specified emphasis.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const flagged = resolve(snap).map((c, i): ResolvedCell =>
      (i === 0 ? { ...c, blink: true, intensify: true, underscore: true } : c));
    expect(drawList(snap, flagged, atlas).cells[0]).toMatchObject({
      blink: true, intensify: true, underline: true,
    });
  });

  it('falls back to boxsolid for a byte with no glyph, not to a neighbour', () => {
    // An out-of-range column would sample whichever glyph sits next in the atlas, which
    // reads as corruption. EBCDIC 0x01 is one of the 55 unmapped bytes.
    const dl = listFor(screenWith([[0, 0x01]]));
    expect(dl.cells[0]!.glyph).toBe(atlas.index[CG_BOXSOLID]);
  });

  it('reports the pixel size of the whole screen', () => {
    const dl = listFor(screenWith([]));
    expect(dl.width).toBe(80 * atlas.cellWidth);
    expect(dl.height).toBe(24 * atlas.cellHeight);
  });
});

describe('the OIA', () => {
  it('is drawn BELOW the screen and is not one of the 1920 cells', () => {
    // The spec is explicit that the OIA lives outside the screen buffer. If it were a
    // cell, a host write could overwrite the status line.
    const dl = listFor(screenWith([]), 'X Wait');
    expect(dl.cells).toHaveLength(24 * 80);
    expect(dl.oia?.text).toBe('X Wait');
    expect(dl.oia!.y).toBe(24 * atlas.cellHeight);
    expect(dl.height).toBe(25 * atlas.cellHeight);
  });

  it('leaves no room for the OIA when no text is given', () => {
    const dl = listFor(screenWith([]));
    expect(dl.oia).toBeUndefined();
    expect(dl.height).toBe(24 * atlas.cellHeight);
  });
});
