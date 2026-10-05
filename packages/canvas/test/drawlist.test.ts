import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Screen, resolve, Color, type ResolvedCell } from '@tn3270/core';
import { SCHEMES, schemeRgb, type Scheme } from '@tn3270/frontend';
import { drawList } from '../src/drawlist.js';
import type { AtlasGeometry } from '../src/geometry.js';
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

const listFor = (s: Screen, scheme: Scheme = SCHEMES.default!, oia?: string) => {
  const snap = s.snapshot();
  return drawList(snap, resolve(snap), atlas, scheme, oia);
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

  it('converts Color3279 codes to RGB, since the atlas is colorless coverage', () => {
    const dl = listFor(screenWith([[0, 0xc1]]));
    // Default unformatted foreground is green on a 3279.
    expect(dl.cells[0]!.fg).toEqual(schemeRgb(SCHEMES.default!, Color.GREEN));
    expect(dl.cells[0]!.fg).not.toBe(Color.GREEN);      // a code, not an Rgb
  });

  it('SWAPS foreground and background for a reverse-video cell', () => {
    // Reverse video is the one attribute a blitter cannot infer, and getting it wrong is
    // invisible on a mostly-empty screen. Asserted as a swap of the same two colors
    // rather than against literal RGB, so a palette change does not break it.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const plain = drawList(snap, resolve(snap), atlas, SCHEMES.default!).cells[0]!;
    const flipped = resolve(snap).map((c, i): ResolvedCell => (i === 0 ? { ...c, reverse: true } : c));
    const reversed = drawList(snap, flipped, atlas, SCHEMES.default!).cells[0]!;
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
    // pre-redacted. The TUI blanks it at render.ts:369 and the GUI matches. Without this
    // the window shows passwords -- and Task 10 commits screenshots to git.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const hidden = resolve(snap).map((c, i): ResolvedCell => (i === 0 ? { ...c, hidden: true } : c));
    const dl = drawList(snap, hidden, atlas, SCHEMES.default!);
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
    expect(drawList(snap, flagged, atlas, SCHEMES.default!).cells[0]).toMatchObject({
      blink: true, intensify: true, underline: true,
    });
  });

  it('falls back to boxsolid for a byte with no glyph, not to a neighbor', () => {
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
  it('renders its text THROUGH THE ATLAS, not as canvas text', () => {
    // fillText would pull in a system font, and font rasterisation is the machine-dependent
    // thing that would stop screenshot goldens being byte-reproducible. So the OIA is glyphs
    // from the same atlas as the screen.
    const dl = listFor(screenWith([]), SCHEMES.default!, 'X Wait');
    expect(dl.oia!.cells).toHaveLength(6);
    // 'X' is EBCDIC 0xe7, which is CG-mapped like any other character.
    expect(dl.oia!.cells[0]!.glyph).toBe(atlas.index[ebcdicToCg(0xe7)]);
    // and the space in the middle is the blank glyph, not a gap in the array
    expect(dl.oia!.cells[1]!.glyph).toBe(atlas.index[ebcdicToCg(0x40)]);
    expect(dl.oia!.cells.every((c) => c.y === 24 * atlas.cellHeight)).toBe(true);
  });

  it('truncates the OIA at the screen width rather than wrapping', () => {
    // A status line that reflowed would move the screen above it.
    const dl = listFor(screenWith([]), SCHEMES.default!, 'y'.repeat(200));
    expect(dl.oia!.cells).toHaveLength(80);
    expect(dl.height).toBe(25 * atlas.cellHeight);
  });

  it('is drawn BELOW the screen and is not one of the 1920 cells', () => {
    // The spec is explicit that the OIA lives outside the screen buffer. If it were a
    // cell, a host write could overwrite the status line.
    const dl = listFor(screenWith([]), SCHEMES.default!, 'X Wait');
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

describe('the drawing height', () => {
  /*
    THE KEYPAD-REGION BLOCK WAS HERE: five tests covering `keypadRegion`'s placement below the
    screen and the OIA, its button extent, and that showing it changed no screen cell. Deleted
    2026-10-06 with the canvas keypad itself -- neither front end draws one now, so `drawList` has
    no `showKeypad` parameter and `DrawList` no `keypad` member.

    ONE ASSERTION IS KEPT RATHER THAN DELETED WITH THEM, because it was never about the keypad:
    the height of a drawing with an OIA. That was the control case in the old block ("is absent
    unless asked for, and the height is then screen plus OIA"), and with the keypad gone it is the
    WHOLE of what `height` means -- `main.ts`'s `fit` sizes the window from it, and the model-4
    bug that cost an entire operator status line was a height one row short. A deletion that
    removed the keypad's four tests AND this one would have left `height` unpinned for the case
    that still exists, which is the recorded deleting-a-gate shape: the gate goes, and the caller
    it was guarding is forgotten.
  */
  const listWith = (oia?: string) => {
    const snap = screenWith([]).snapshot();
    return drawList(snap, resolve(snap), atlas, SCHEMES.default!, oia);
  };

  it('is the screen plus the OIA row when there is OIA text', () => {
    const list = listWith('X Wait');
    expect(list.oia!.y).toBe(24 * atlas.cellHeight);
    expect(list.height).toBe(25 * atlas.cellHeight);
  });

  it('is the screen alone when there is none', () => {
    // The OIA's row is CONDITIONAL, and this is the half a single test would have missed: a
    // `height` that always added a row would pass the case above and leave a blank line here.
    const list = listWith(undefined);
    expect(list.oia).toBeUndefined();
    expect(list.height).toBe(24 * atlas.cellHeight);
  });

  it('is never taller than its own cells need', () => {
    // Measured off the CELLS rather than recomputed from a row count, so this cannot agree with
    // the implementation's arithmetic by construction. An over-declared height is dead space at
    // the bottom of the window that nothing else would notice.
    const list = listWith('X Wait');
    const lowest = Math.max(
      ...list.cells.map((c) => c.y),
      ...(list.oia?.cells ?? []).map((c) => c.y),
    );
    expect(lowest + atlas.cellHeight).toBe(list.height);
  });
});

describe('drawList honors the scheme it is given', () => {
  it("draws the scheme's blue, not core's", () => {
    // The bug this change fixes: the GUI resolved through core's colorRgb, whose blue is
    // pure #0000ff and unreadable on black. A default 3279 field is green, so recolor one
    // cell by hand rather than relying on the default attribute.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const recolored = resolve(snap).map((c, i) =>
      i === 0 ? { ...c, fg: Color.BLUE } : c);

    const readable = drawList(snap, recolored, atlas, SCHEMES.default!);
    const saturated = drawList(snap, recolored, atlas, SCHEMES['3279']!);

    // DERIVED from the registry on purpose. The literal value is pinned once, in
    // frontend's palette.test.ts; what THIS test asserts is that drawList consults the
    // registry at all -- so it fails if drawlist.ts ever regrows a private table, which is
    // the drift that shipped two different blues in the first place.
    expect(readable.cells[0]!.fg).toEqual(schemeRgb(SCHEMES.default!, Color.BLUE));
    expect(saturated.cells[0]!.fg).toEqual([0, 0, 255]);
  });

  it('draws the default green field color from the scheme', () => {
    expect(listFor(screenWith([[0, 0xc1]]), SCHEMES.default!).cells[0]!.fg)
      .toEqual([36, 216, 48]);                       // zti green
    expect(listFor(screenWith([[0, 0xc1]]), SCHEMES.x3270!).cells[0]!.fg)
      .toEqual([0x32, 0xcd, 0x32]);                  // x3270 limegreen
  });

  it("draws the OIA in the scheme too, not in core's colors", () => {
    // The OIA is our chrome, so no host byte says what color it is -- but it must not be
    // the one scheme-independent thing on screen.
    const list = listFor(screenWith([[0, 0xc1]]), SCHEMES.green!, 'X Wait');
    const oia = list.oia!.cells[list.oia!.cells.length - 1]!;
    expect(oia.fg).toEqual([0, 255, 0]);             // green's LIME for neutral-white
    expect(oia.bg).toEqual([0, 0, 0]);
  });
});
