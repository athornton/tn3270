import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Screen, resolve, Colour, type ResolvedCell } from '@tn3270/core';
import { SCHEMES, schemeRgb, type Scheme } from '@tn3270/frontend';
import { drawList, type AtlasGeometry } from '../src/drawlist.js';
import { KEYPAD_ROWS_TALL } from '../src/keypad.js';
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

  it('converts Colour3279 codes to RGB, since the atlas is colourless coverage', () => {
    const dl = listFor(screenWith([[0, 0xc1]]));
    // Default unformatted foreground is green on a 3279.
    expect(dl.cells[0]!.fg).toEqual(schemeRgb(SCHEMES.default!, Colour.GREEN));
    expect(dl.cells[0]!.fg).not.toBe(Colour.GREEN);      // a code, not an Rgb
  });

  it('SWAPS foreground and background for a reverse-video cell', () => {
    // Reverse video is the one attribute a blitter cannot infer, and getting it wrong is
    // invisible on a mostly-empty screen. Asserted as a swap of the same two colours
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
    // pre-redacted. The TUI blanks it at render.ts:343 and the GUI matches. Without this
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

describe('the keypad region', () => {
  /** Same construction as `listFor`, with the appended flag the front ends will pass. */
  const keypadList = (oia?: string, showKeypad?: boolean) => {
    const snap = screenWith([]).snapshot();
    return drawList(snap, resolve(snap), atlas, SCHEMES.default!, oia, showKeypad);
  };

  it('is absent unless asked for, and the height is then screen plus OIA', () => {
    const list = keypadList('X Wait');
    expect(list.keypad).toBeUndefined();
    expect(list.height).toBe(25 * atlas.cellHeight);
  });

  it('sits BELOW the screen and the OIA, and grows the height', () => {
    // The order is screen, OIA, keypad. Showing it must never move or cover a row the host
    // wrote -- the same rule the TUI's refusal-to-clip and the GUI's resize come from.
    const list = keypadList('X Wait', true);
    expect(list.oia!.y).toBe(24 * atlas.cellHeight);
    expect(list.keypad!.y).toBe(25 * atlas.cellHeight);
    // Pins the OIA-inclusive offset and that the keypad is counted at all; the over-declaration
    // is caught by the button extent below, not here. MEASURED: this form imports the same
    // constant the mutation moves, so at KEYPAD_ROWS_TALL 6 -> 7 it stays green -- as does
    // `expect(height).toBe(keypad.y + keypad.height)`, which is a tautology over the
    // implementation's own expression.
    expect(list.height).toBe((25 + KEYPAD_ROWS_TALL) * atlas.cellHeight);
  });

  it('sits directly below the screen when there is no OIA', () => {
    const list = keypadList(undefined, true);
    expect(list.keypad!.y).toBe(24 * atlas.cellHeight);
    expect(list.height).toBe((24 + KEYPAD_ROWS_TALL) * atlas.cellHeight);
  });

  it('reserves room for EVERY button it declares, and not a pixel more', () => {
    // Independent of both `KEYPAD_ROWS_TALL` and the height arithmetic: measured off the
    // buttons themselves. `main.ts:290` sizes the window from `height` and the page is
    // `overflow:hidden` (`gui/index.html:3`), so a height short of the bottom button clips it
    // -- the model-4 OIA bug -- while an over-declared one leaves dead space no test would
    // otherwise notice.
    const list = keypadList('X Wait', true);
    const buttons = list.keypad!.buttons;
    expect(buttons.length).toBeGreaterThan(0);
    expect(Math.max(...buttons.map((b) => b.y + b.h))).toBe(list.height);
    expect(Math.min(...buttons.map((b) => b.y))).toBe(list.keypad!.y);
    // and nothing it draws reaches back up into the OIA's row or the host's cells
    expect(list.keypad!.cells.length).toBeGreaterThan(0);
    expect(list.keypad!.cells.every((c) => c.y >= list.keypad!.y)).toBe(true);
  });

  it('does not change the screen cells, the OIA or the width', () => {
    const without = keypadList('X Wait');
    const with_ = keypadList('X Wait', true);
    expect(with_.cells).toEqual(without.cells);
    // Explicit, because `toEqual` above only proves the two agree: appending the keypad's
    // cells to BOTH lists would satisfy it.
    expect(with_.cells).toHaveLength(24 * 80);
    expect(with_.oia!.cells).toEqual(without.oia!.cells);
    // 12 keys of 6 cells span 72 columns, so the keypad is NARROWER than any 3270 screen and
    // the window's width is still the screen's.
    expect(with_.width).toBe(without.width);
    expect(with_.keypad!.width).toBeLessThanOrEqual(with_.width);
  });
});

describe('drawList honours the scheme it is given', () => {
  it("draws the scheme's blue, not core's", () => {
    // The bug this change fixes: the GUI resolved through core's colourRgb, whose blue is
    // pure #0000ff and unreadable on black. A default 3279 field is green, so recolour one
    // cell by hand rather than relying on the default attribute.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const recoloured = resolve(snap).map((c, i) =>
      i === 0 ? { ...c, fg: Colour.BLUE } : c);

    const readable = drawList(snap, recoloured, atlas, SCHEMES.default!);
    const saturated = drawList(snap, recoloured, atlas, SCHEMES['3279']!);

    // DERIVED from the registry on purpose. The literal value is pinned once, in
    // frontend's palette.test.ts; what THIS test asserts is that drawList consults the
    // registry at all -- so it fails if drawlist.ts ever regrows a private table, which is
    // the drift that shipped two different blues in the first place.
    expect(readable.cells[0]!.fg).toEqual(schemeRgb(SCHEMES.default!, Colour.BLUE));
    expect(saturated.cells[0]!.fg).toEqual([0, 0, 255]);
  });

  it('draws the default green field colour from the scheme', () => {
    expect(listFor(screenWith([[0, 0xc1]]), SCHEMES.default!).cells[0]!.fg)
      .toEqual([36, 216, 48]);                       // zti green
    expect(listFor(screenWith([[0, 0xc1]]), SCHEMES.x3270!).cells[0]!.fg)
      .toEqual([0x32, 0xcd, 0x32]);                  // x3270 limegreen
  });

  it("draws the OIA in the scheme too, not in core's colours", () => {
    // The OIA is our chrome, so no host byte says what colour it is -- but it must not be
    // the one scheme-independent thing on screen.
    const list = listFor(screenWith([[0, 0xc1]]), SCHEMES.green!, 'X Wait');
    const oia = list.oia!.cells[list.oia!.cells.length - 1]!;
    expect(oia.fg).toEqual([0, 255, 0]);             // green's LIME for neutral-white
    expect(oia.bg).toEqual([0, 0, 0]);
  });
});
