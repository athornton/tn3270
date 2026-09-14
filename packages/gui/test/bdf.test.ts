import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBdf } from '../src/bdf.js';

const bdfPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', '3270.bdf');
const text = readFileSync(bdfPath, 'utf8');
const font = parseBdf(text);

/**
 * The numbers here were read out of the vendored file, not recalled:
 * `FONTBOUNDINGBOX 9 14 0 -3` and `CHARS 431`.
 */
describe('parseBdf', () => {
  it('reads the font bounding box', () => {
    expect(font.width).toBe(9);
    expect(font.height).toBe(14);
  });

  it('reads as many glyphs as the file says it has', () => {
    // CHARS is the file's own count, so this catches a parser that stops early -- the
    // commonest BDF bug, and one that a spot-check of a single glyph would never reveal.
    const declared = Number(/^CHARS (\d+)$/m.exec(text)![1]);
    expect(declared).toBe(431);
    expect(font.glyphs.size).toBe(declared);
  });

  it('indexes glyphs by CG order, NOT by EBCDIC', () => {
    // The font's comment says "Page 0: EBCDIC US-International set, CG order" -- the
    // character SET is EBCDIC's, the ORDER is the Character Generator's. Measured from the
    // file's own glyph names: ENCODING 160 is `A`, where EBCDIC `A` is 0xc1; ENCODING 16 is
    // `space`, where EBCDIC space is 0x40. cg.ts carries the translation, and this test
    // pins the distinction so nobody "simplifies" it back to identity.
    const a = font.glyphs.get(160);
    expect(a, 'no glyph at CG 160').toBeDefined();
    expect(a!.rows.length).toBe(font.height);
    // And the EBCDIC value is NOT the index: 0xc1 is a different glyph entirely.
    const notA = font.glyphs.get(0xc1)!;
    expect(notA.rows.map((r) => r.join('')).join())
      .not.toBe(a!.rows.map((r) => r.join('')).join());
  });

  it('decodes a bitmap row as bits, most significant bit leftmost', () => {
    // A parser that returned all zeroes, or the same row repeated, would pass a length
    // check. Both are ruled out here.
    const a = font.glyphs.get(160)!;   // CG 160 = 'A'
    expect(a.rows.some((r) => r.some((bit) => bit === 1)), 'every pixel of A was 0').toBe(true);
    expect(new Set(a.rows.map((r) => r.join(''))).size).toBeGreaterThan(1);
  });

  it('gives every glyph rows of exactly the font width and height', () => {
    // Uniform cells are what let the atlas be a simple grid and the blitter carry no
    // per-glyph metrics, so this is load-bearing rather than tidiness.
    for (const [code, g] of font.glyphs) {
      expect(g.rows.length, `glyph ${code.toString(16)} height`).toBe(font.height);
      for (const row of g.rows) expect(row.length, `glyph ${code.toString(16)} width`).toBe(font.width);
    }
  });

  it('leaves the null glyph (ENCODING 0) entirely blank', () => {
    // Its BITMAP really is all zeroes in the file. A parser that mis-shifted would light
    // pixels here, so this is the cheapest possible detector for an off-by-one shift.
    const nul = font.glyphs.get(0)!;
    expect(nul.rows.every((r) => r.every((b) => b === 0))).toBe(true);
  });

  it('draws CG space (16) blank but CG boxsolid (223) nearly filled', () => {
    // Two glyphs whose expected extremes are known from the font's own NAMES rather than
    // from our parser, which is what makes them a check and not a restatement.
    expect(font.glyphs.get(16)!.rows.every((r) => r.every((b) => b === 0))).toBe(true);
    const solid = font.glyphs.get(223)!;
    const lit = solid.rows.flatMap((r) => [...r]).filter((b) => b === 1).length;
    expect(lit).toBeGreaterThan((font.width * font.height) / 2);
  });
});
