import { describe, it, expect } from 'vitest';
import { CodePage, cp037 } from '../src/codepage.js';

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
    const toy = new CodePage('toy', table);
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
    const toy = new CodePage('toy-collision', table);
    expect(toy.fromUnicode('X')).toBe(0x05);
  });

  it('rejects a table with a non-code-point entry, naming the offending byte', () => {
    const table = new Array(256).fill(0x003f);
    table[0x99] = NaN;
    expect(() => new CodePage('bad', table)).toThrow(/0x99/);
  });

  it('rejects a table with an out-of-range code point', () => {
    const table = new Array(256).fill(0x003f);
    table[0x03] = 0x110000; // beyond U+10FFFF
    expect(() => new CodePage('bad', table)).toThrow(/0x03/);
  });
});
