import { describe, it, expect } from 'vitest';
import {
  CodePage, cp037, bracket, DEFAULT_CODE_PAGE, resolveCodePage, CODE_PAGE_NAMES,
} from '../src/codepage.js';

describe('cp037', () => {
  it('decodes letters and space', () => {
    expect(cp037.toUnicode(0xc1)).toBe('A');
    expect(cp037.toUnicode(0x40)).toBe(' ');
    expect(cp037.toUnicode(0xf0)).toBe('0');
  });

  it('decodes a null to U+0000, not a space', () => {
    // The code page is a faithful table: 0x00 maps to U+0000. Rendering a null
    // cell as blank is screen.ts's job, not the code page's. Keeping that
    // boundary clean matters because Read Buffer must report real nulls.
    expect(cp037.toUnicode(0x00)).toBe('\u0000');
    expect(cp037.toUnicode(0x00).codePointAt(0)).toBe(0);
  });

  it('encodes back to EBCDIC', () => {
    expect(cp037.fromUnicode('A')).toBe(0xc1);
    expect(cp037.fromUnicode(' ')).toBe(0x40);
    expect(cp037.fromUnicode('0')).toBe(0xf0);
  });

  it('round-trips every byte exactly', () => {
    // Verified: CP037's 256 entries map to 256 distinct Unicode code points,
    // so this is an exact byte-for-byte round trip with no collisions.
    for (let b = 0; b < 256; b++) {
      expect(cp037.fromUnicode(cp037.toUnicode(b))).toBe(b);
    }
  });

  it('decodes a whole string', () => {
    const bytes = Uint8Array.of(0xc8, 0xc5, 0xd3, 0xd3, 0xd6);
    expect(cp037.decode(bytes)).toBe('HELLO');
  });

  it('encodes a whole string', () => {
    expect(Array.from(cp037.encode('HELLO'))).toEqual([0xc8, 0xc5, 0xd3, 0xd3, 0xd6]);
  });

  it('substitutes a known byte for unmappable characters', () => {
    // A character with no CP037 representation must not throw or corrupt
    // position; it becomes the EBCDIC substitute (0x3f, which decodes to
    // U+001A) so column alignment holds.
    expect(cp037.fromUnicode('中')).toBe(0x3f);
  });

  it('reports its name', () => {
    expect(cp037.name).toBe('cp037');
  });

  it('normalizes decomposed input to NFC before encoding, so accented text stays one cell per character', () => {
    // 'é' precomposed (NFC) vs 'e' + combining acute accent (NFD). macOS
    // keyboard input, paste, and filenames routinely deliver NFD.
    const nfc = 'é'; // 'e' with acute, precomposed
    const nfd = 'é'; // 'e' + combining acute accent
    expect(Array.from(cp037.encode(nfc))).toEqual([0x51]);
    expect(Array.from(cp037.encode(nfd))).toEqual([0x51]);
  });
});

describe('CodePage', () => {
  it('can be constructed from any table, so other pages are data', () => {
    // Two-entry toy table proves nothing is hardcoded to cp037.
    const table = new Array(256).fill(0x003f);
    table[0x41] = 0x0058; // 'X'
    const toy = new CodePage('toy', table, 37);
    expect(toy.toUnicode(0x41)).toBe('X');
    expect(toy.fromUnicode('X')).toBe(0x41);
    expect(toy.name).toBe('toy');
  });

  it('resolves a colliding code point to the lowest EBCDIC byte', () => {
    // A code page can legitimately map several bytes to the same Unicode
    // character (e.g. Python's cp875 maps 7 different bytes to U+001A).
    // fromUnicode must be deterministic: lowest byte wins.
    const table = new Array(256).fill(0x003f);
    table[0x10] = 0x0058; // 'X'
    table[0x20] = 0x0058; // 'X' again, higher byte
    table[0x05] = 0x0058; // 'X' again, lowest byte
    const toy = new CodePage('toy-collision', table, 37);
    expect(toy.fromUnicode('X')).toBe(0x05);
  });

  it('rejects a table with a non-code-point entry, naming the offending byte', () => {
    const table = new Array(256).fill(0x003f);
    table[0x99] = NaN;
    expect(() => new CodePage('bad', table, 37)).toThrow(/0x99/);
  });

  it('rejects a table with an out-of-range code point', () => {
    const table = new Array(256).fill(0x003f);
    table[0x03] = 0x110000; // beyond U+10FFFF
    expect(() => new CodePage('bad', table, 37)).toThrow(/0x03/);
  });
});

// x3270's rows, pasted verbatim from suite3270 4.5 Common/unicode.c (cp037 at :103, bracket at
// :293). Each row starts at EBCDIC 0x41 and runs to 0xFE.
const X3270_CP037 = [
  0x00a0, 0x00e2, 0x00e4, 0x00e0, 0x00e1, 0x00e3, 0x00e5, 0x00e7,
  0x00f1, 0x00a2, 0x002e, 0x003c, 0x0028, 0x002b, 0x007c, 0x0026,
  0x00e9, 0x00ea, 0x00eb, 0x00e8, 0x00ed, 0x00ee, 0x00ef, 0x00ec,
  0x00df, 0x0021, 0x0024, 0x002a, 0x0029, 0x003b, 0x00ac, 0x002d,
  0x002f, 0x00c2, 0x00c4, 0x00c0, 0x00c1, 0x00c3, 0x00c5, 0x00c7,
  0x00d1, 0x00a6, 0x002c, 0x0025, 0x005f, 0x003e, 0x003f, 0x00f8,
  0x00c9, 0x00ca, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc,
  0x0060, 0x003a, 0x0023, 0x0040, 0x0027, 0x003d, 0x0022, 0x00d8,
  0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067, 0x0068,
  0x0069, 0x00ab, 0x00bb, 0x00f0, 0x00fd, 0x00fe, 0x00b1, 0x00b0,
  0x006a, 0x006b, 0x006c, 0x006d, 0x006e, 0x006f, 0x0070, 0x0071,
  0x0072, 0x00aa, 0x00ba, 0x00e6, 0x00b8, 0x00c6, 0x00a4, 0x00b5,
  0x007e, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078, 0x0079,
  0x007a, 0x00a1, 0x00bf, 0x00d0, 0x00dd, 0x00de, 0x00ae, 0x005e,
  0x00a3, 0x00a5, 0x00b7, 0x00a9, 0x00a7, 0x00b6, 0x00bc, 0x00bd,
  0x00be, 0x005b, 0x005d, 0x00af, 0x00a8, 0x00b4, 0x00d7, 0x007b,
  0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047, 0x0048,
  0x0049, 0x00ad, 0x00f4, 0x00f6, 0x00f2, 0x00f3, 0x00f5, 0x007d,
  0x004a, 0x004b, 0x004c, 0x004d, 0x004e, 0x004f, 0x0050, 0x0051,
  0x0052, 0x00b9, 0x00fb, 0x00fc, 0x00f9, 0x00fa, 0x00ff, 0x005c,
  0x00f7, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057, 0x0058, 0x0059,
  0x005a, 0x00b2, 0x00d4, 0x00d6, 0x00d2, 0x00d3, 0x00d5, 0x0030,
  0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038,
  0x0039, 0x00b3, 0x00db, 0x00dc, 0x00d9, 0x00da,
];
const X3270_BRACKET = [
  0x00a0, 0x00e2, 0x00e4, 0x00e0, 0x00e1, 0x00e3, 0x00e5, 0x00e7,
  0x00f1, 0x00a2, 0x002e, 0x003c, 0x0028, 0x002b, 0x007c, 0x0026,
  0x00e9, 0x00ea, 0x00eb, 0x00e8, 0x00ed, 0x00ee, 0x00ef, 0x00ec,
  0x00df, 0x0021, 0x0024, 0x002a, 0x0029, 0x003b, 0x00ac, 0x002d,
  0x002f, 0x00c2, 0x00c4, 0x00c0, 0x00c1, 0x00c3, 0x00c5, 0x00c7,
  0x00d1, 0x00a6, 0x002c, 0x0025, 0x005f, 0x003e, 0x003f, 0x00f8,
  0x00c9, 0x00ca, 0x00cb, 0x00c8, 0x00cd, 0x00ce, 0x00cf, 0x00cc,
  0x0060, 0x003a, 0x0023, 0x0040, 0x0027, 0x003d, 0x0022, 0x00d8,
  0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067, 0x0068,
  0x0069, 0x00ab, 0x00bb, 0x00f0, 0x00fd, 0x00fe, 0x00b1, 0x00b0,
  0x006a, 0x006b, 0x006c, 0x006d, 0x006e, 0x006f, 0x0070, 0x0071,
  0x0072, 0x00aa, 0x00ba, 0x00e6, 0x00b8, 0x00c6, 0x00a4, 0x00b5,
  0x007e, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078, 0x0079,
  0x007a, 0x00a1, 0x00bf, 0x00d0, 0x005b, 0x00de, 0x00ae, 0x005e,
  0x00a3, 0x00a5, 0x00b7, 0x00a9, 0x00a7, 0x00b6, 0x00bc, 0x00bd,
  0x00be, 0x00dd, 0x00a8, 0x00af, 0x005d, 0x00b4, 0x00d7, 0x007b,
  0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047, 0x0048,
  0x0049, 0x00ad, 0x00f4, 0x00f6, 0x00f2, 0x00f3, 0x00f5, 0x007d,
  0x004a, 0x004b, 0x004c, 0x004d, 0x004e, 0x004f, 0x0050, 0x0051,
  0x0052, 0x00b9, 0x00fb, 0x00fc, 0x00f9, 0x00fa, 0x00ff, 0x005c,
  0x00f7, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057, 0x0058, 0x0059,
  0x005a, 0x00b2, 0x00d4, 0x00d6, 0x00d2, 0x00d3, 0x00d5, 0x0030,
  0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038,
  0x0039, 0x00b3, 0x00db, 0x00dc, 0x00d9, 0x00da,
];

describe('bracket', () => {
  it('matches x3270 from 0x41 to 0xFE, for both pages', () => {
    expect(X3270_CP037).toHaveLength(190);
    expect(X3270_BRACKET).toHaveLength(190);
    for (let i = 0; i < 190; i++) {
      expect(cp037.toUnicode(0x41 + i).codePointAt(0)).toBe(X3270_CP037[i]);
      expect(bracket.toUnicode(0x41 + i).codePointAt(0)).toBe(X3270_BRACKET[i]);
    }
  });

  it('differs from cp037 in exactly 0xAD, 0xBA, 0xBB and 0xBD', () => {
    const diffs: number[] = [];
    for (let b = 0; b < 256; b++) if (bracket.toUnicode(b) !== cp037.toUnicode(b)) diffs.push(b);
    expect(diffs).toEqual([0xad, 0xba, 0xbb, 0xbd]);
    expect([0xad, 0xbd].map((b) => bracket.toUnicode(b))).toEqual(['[', ']']);
    expect(bracket.encode('[]')).toEqual(new Uint8Array([0xad, 0xbd]));
  });

  it('declares CGCSGID 37, as does cp037', () => {
    expect(bracket.cgcsgid).toBe(37);
    expect(cp037.cgcsgid).toBe(37);
  });

  it('is the default', () => {
    expect(DEFAULT_CODE_PAGE).toBe(bracket);
  });
});

describe('resolveCodePage', () => {
  it.each([
    ['cp037', 'cp037'], ['cp37', 'cp037'], ['037', 'cp037'], ['37', 'cp037'], ['us', 'cp037'],
    ['us-intl', 'cp037'], ['CP037', 'cp037'], ['bracket', 'bracket'], ['oldibm', 'bracket'],
    ['bracket437', 'bracket'], ['Bracket', 'bracket'],
  ])('%s resolves to %s', (alias, canonical) => {
    expect(resolveCodePage(alias).name).toBe(canonical);
  });

  it('rejects an unknown name, listing the choices first', () => {
    expect(() => resolveCodePage('cp273')).toThrow("use one of bracket, cp037 (got 'cp273')");
  });

  it('lists the canonical names, default first', () => {
    expect(CODE_PAGE_NAMES).toEqual(['bracket', 'cp037']);
  });
});
