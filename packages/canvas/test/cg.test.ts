import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ebcdicToCg, CG_BOXSOLID } from '../src/cg.js';
import { parseBdf } from '../src/bdf.js';

const font = parseBdf(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', '3270.bdf'), 'utf8'));

/**
 * The table is generated from x3270's `ebc2cg0` (xtables.c:76). These tests check it
 * against a DIFFERENT source -- the font's own glyph names -- so agreement means something.
 */
describe('ebcdicToCg', () => {
  it('maps the characters whose CG index the font NAMES', () => {
    // From `awk` over the BDF: ENCODING 16 is `space`, 128 is `a`, 160 is `A`.
    expect(ebcdicToCg(0x40)).toBe(16);    // EBCDIC space
    expect(ebcdicToCg(0xc1)).toBe(160);   // EBCDIC 'A'
    expect(ebcdicToCg(0x81)).toBe(128);   // EBCDIC 'a'
  });

  it('is NOT the identity, which is the whole reason it exists', () => {
    // The design originally assumed the atlas was EBCDIC-indexed. If this ever became an
    // identity map, that mistake would be back and every glyph would be wrong.
    const identical = [...Array(256).keys()].filter((e) => ebcdicToCg(e) === e);
    expect(identical.length).toBeLessThan(16);
  });

  it('sends every EBCDIC byte to a glyph the font actually has', () => {
    // The strongest check available without a host: 256 lookups, no gaps. A missing glyph
    // would sample a neighbouring atlas cell at blit time, which looks like corruption
    // rather than a missing character.
    for (let e = 0; e < 256; e++) {
      const cg = ebcdicToCg(e);
      expect(font.glyphs.has(cg), `EBCDIC 0x${e.toString(16)} -> CG ${cg} missing`).toBe(true);
    }
  });

  it('sends unprintable bytes to boxsolid, not to a blank', () => {
    // x3270 shows a solid box so junk from a host is VISIBLE. Drawing a space instead
    // would hide a protocol problem behind an innocent-looking screen.
    //
    // The codes here were READ OFF the generated table, not guessed: 55 of the 256 map to
    // boxsolid, and 0x01 is the lowest. An earlier version of this test guessed 0x41 and
    // failed -- that one maps to CG 1, `nobreakspace`, which is a real glyph.
    expect(ebcdicToCg(0x01)).toBe(CG_BOXSOLID);
    expect(ebcdicToCg(0x08)).toBe(CG_BOXSOLID);
    expect(ebcdicToCg(0x00)).not.toBe(CG_BOXSOLID);   // null has its own blank glyph
    expect(ebcdicToCg(0x41)).not.toBe(CG_BOXSOLID);   // nobreakspace, not junk

    const boxed = [...Array(256).keys()].filter((e) => ebcdicToCg(e) === CG_BOXSOLID);
    expect(boxed).toHaveLength(55);
  });

  it('never throws on an out-of-range byte', () => {
    // This sits on the drawing path; a malformed byte must show a box, not crash a window.
    expect(ebcdicToCg(-1)).toBeTypeOf('number');
    expect(ebcdicToCg(999)).toBeTypeOf('number');
  });
});
