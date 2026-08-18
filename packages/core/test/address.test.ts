import { describe, it, expect } from 'vitest';
import { decodeAddress, encodeAddress, AddressError } from '../src/address.js';

describe('decodeAddress', () => {
  it('decodes a 12-bit coded address (flags 01)', () => {
    // 12-bit address 160 = 0b000010_100000; high 6 bits 0b000010 = 2,
    // low 6 bits 0b100000 = 32. Coded via the table: 2 -> 0xC2, 32 -> 0x60.
    expect(decodeAddress(0xc2, 0x60)).toBe(160);
  });

  it('decodes address 0', () => {
    expect(decodeAddress(0x40, 0x40)).toBe(0);
  });

  it('decodes the last cell of an 80x24 screen', () => {
    // 1919 = 0b011101_111111 -> high 29, low 63
    const hi = 29, lo = 63;
    expect(decodeAddress(0xc0 | hi, 0xc0 | lo)).toBe(1919);
  });

  it('decodes a 14-bit binary address (flags 00)', () => {
    // flags 00, so the value is the low 6 bits of byte 1 plus all of byte 2.
    expect(decodeAddress(0x01, 0x2c)).toBe(300);
    expect(decodeAddress(0x00, 0x00)).toBe(0);
    expect(decodeAddress(0x3f, 0xff)).toBe(16383);
  });

  it('treats flags 11 the same as 01', () => {
    const a = decodeAddress(0x40 | 0x02, 0x40 | 0x10); // flags 01
    const b = decodeAddress(0xc0 | 0x02, 0xc0 | 0x10); // flags 11
    expect(a).toBe(b);
  });

  it('rejects the reserved flag combination 10', () => {
    expect(() => decodeAddress(0x80, 0x40)).toThrow(AddressError);
  });
});

describe('encodeAddress', () => {
  it('encodes 12-bit form for a screen of 4096 cells or fewer', () => {
    expect(Array.from(encodeAddress(0, 1920))).toEqual([0x40, 0x40]);
    expect(Array.from(encodeAddress(160, 1920))).toEqual([0xc2, 0x60]);
  });

  it('encodes 14-bit binary form for larger screens', () => {
    // x3270 switches at > 0x1000 cells.
    expect(Array.from(encodeAddress(300, 8000))).toEqual([0x01, 0x2c]);
  });

  it('pins the 12/14-bit threshold at exactly 0x1000 cells', () => {
    // bufferSize 4096 (0x1000) is NOT > 0x1000, so it still uses 12-bit form.
    expect(Array.from(encodeAddress(4095, 4096))).toEqual([0x7f, 0x7f]);
    // bufferSize 4097 is > 0x1000, so it switches to 14-bit form.
    expect(Array.from(encodeAddress(4095, 4097))).toEqual([0x0f, 0xff]);
  });

  it('rejects addresses out of range for the chosen encoding', () => {
    // 12-bit form: valid range is 0..4095 (0x1000 cells).
    expect(() => encodeAddress(4096, 1920)).toThrow(AddressError);
    expect(() => encodeAddress(-1, 1920)).toThrow(AddressError);
    // 14-bit form: valid range is 0..16383 (0x4000).
    expect(() => encodeAddress(16384, 20000)).toThrow(AddressError);
  });

  it('round-trips every address on an 80x24 screen', () => {
    for (let a = 0; a < 1920; a++) {
      const [hi, lo] = encodeAddress(a, 1920);
      expect(decodeAddress(hi!, lo!)).toBe(a);
    }
  });

  it('round-trips a large-screen address through 14-bit form', () => {
    for (const a of [0, 1, 4095, 4096, 9999, 16383]) {
      const [hi, lo] = encodeAddress(a, 20000);
      expect(decodeAddress(hi!, lo!)).toBe(a);
    }
  });
});
