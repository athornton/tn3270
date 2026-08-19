import { describe, expect, it } from 'vitest';
import { COLOUR_NAMES, PALETTE_3279, colourRgb, Colour } from '../src/palette.js';

describe('3279 palette', () => {
  it('maps all sixteen identifications contiguously from 0xF0', () => {
    const codes = Object.keys(PALETTE_3279).map(Number).sort((a, b) => a - b);
    expect(codes).toEqual([
      0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
      0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
    ]);
  });

  it('names them per 3270ds.h:313-328, with Black 0xF8 and Purple 0xFB', () => {
    // The manual's Table 4-7 OCRs BOTH of these as X'FB'. This test is the
    // guard against transcribing that damage.
    expect(COLOUR_NAMES[0xf8]).toBe('black');
    expect(COLOUR_NAMES[0xfb]).toBe('purple');
    expect(COLOUR_NAMES[0xf0]).toBe('neutral-black');
    expect(COLOUR_NAMES[0xf7]).toBe('neutral-white');
  });

  it('names the seven base 3279 colours at their architected codes', () => {
    expect(COLOUR_NAMES[Colour.BLUE]).toBe('blue');
    expect(COLOUR_NAMES[Colour.RED]).toBe('red');
    expect(COLOUR_NAMES[Colour.PINK]).toBe('pink');
    expect(COLOUR_NAMES[Colour.GREEN]).toBe('green');
    expect(COLOUR_NAMES[Colour.TURQUOISE]).toBe('turquoise');
    expect(COLOUR_NAMES[Colour.YELLOW]).toBe('yellow');
    expect(COLOUR_NAMES[Colour.WHITE]).toBe('white');
    expect(Colour.BLUE).toBe(0xf1);
    expect(Colour.GREEN).toBe(0xf4);
  });

  it('gives every architected colour a distinct RGB triple', () => {
    // Neutral black/white (0xF0/0xF7) and Black/White (0xF8/0xFF) are
    // architecturally distinct codes; collapsing either pair to the same
    // pixel would silently discard information a host chose deliberately.
    const seen = new Set<string>();
    for (const code of Object.keys(PALETTE_3279).map(Number)) {
      const rgb = colourRgb(code);
      const key = rgb.join(',');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(16);
  });

  it('keeps Colour, COLOUR_NAMES and PALETTE_3279 in sync', () => {
    // These three are authored separately but keyed by the same sixteen
    // codes. A missing or mistyped entry in any one of them, outside the
    // handful of codes the other tests spot-check, would otherwise pass
    // silently.
    const colourCodes = Object.values(Colour).sort((a, b) => a - b);
    const nameCodes = Object.keys(COLOUR_NAMES).map(Number).sort((a, b) => a - b);
    const paletteCodes = Object.keys(PALETTE_3279).map(Number).sort((a, b) => a - b);
    expect(nameCodes).toEqual(colourCodes);
    expect(paletteCodes).toEqual(colourCodes);
  });

  it('throws on a code outside 0xF0-0xFF rather than guessing', () => {
    // A malformed attribute must be caught by the resolver, which substitutes a
    // default; it must never reach here and silently produce black.
    expect(() => colourRgb(0x99)).toThrow(/not a 3279 colour/);
  });
});
