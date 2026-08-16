import { describe, it, expect } from 'vitest';
import { Screen } from '../src/screen.js';
import { buildReadModified, buildReadBuffer, encodeAttribute } from '../src/inbound.js';
import { AID, FA, Order } from '../src/constants.js';

/** A screen with one modified unprotected field holding "AB" at 1-2. */
function screenWithModifiedField(): Screen {
  const s = new Screen();
  s.setFieldAttribute(0, 0x00);
  s.setChar(1, 0xc1);
  s.setChar(2, 0xc2);
  s.setMDT(0);
  s.cursor = 3;
  return s;
}

describe('short reads', () => {
  it('sends the AID alone for Clear and PA1-3', () => {
    const s = screenWithModifiedField();
    for (const aid of [AID.CLEAR, AID.PA1, AID.PA2, AID.PA3]) {
      const out = buildReadModified(s, aid, false);
      expect(Array.from(out)).toEqual([aid]);
    }
  });

  it('Read Modified All suppresses the short read', () => {
    const s = screenWithModifiedField();
    const out = buildReadModified(s, AID.PA1, true);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]).toBe(AID.PA1);
    // AID, cursor(2), SBA, addr(2), data(2)
    expect(Array.from(out.subarray(0, 3))).toEqual([AID.PA1, 0x40, 0xc3]);
  });

  it('Selector Pen sends cursor but no field data', () => {
    const s = screenWithModifiedField();
    const out = buildReadModified(s, AID.SELECT, false);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(AID.SELECT);
  });
});

describe('ordinary reads', () => {
  it('sends AID, cursor, then SBA and data for each modified field', () => {
    const s = screenWithModifiedField();
    const out = buildReadModified(s, AID.ENTER, false);
    // cursor 3 -> 12-bit coded (0xc0|0, 0xc0|3); field addr 1 -> (0xc0|0, 0xc1)
    expect(Array.from(out)).toEqual([
      AID.ENTER,
      0x40, 0xc3,             // cursor address 3
      Order.SBA, 0x40, 0xc1,  // field data starts at address 1
      0xc1, 0xc2,             // "AB"
    ]);
  });

  it('sends nothing for a field whose MDT is clear', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    s.cursor = 0;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out)).toEqual([AID.ENTER, 0x40, 0x40]);
  });

  it('omits trailing nulls inside a field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    // cells 2..79 stay null
    s.setMDT(0);
    s.cursor = 2;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out.subarray(3))).toEqual([Order.SBA, 0x40, 0xc1, 0xc1]);
  });

  it('sends embedded nulls but not trailing ones', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    s.setChar(3, 0xc2); // gap at 2
    s.setMDT(0);
    s.cursor = 4;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out.subarray(3))).toEqual([
      Order.SBA, 0x40, 0xc1, 0xc1, 0x00, 0xc2,
    ]);
  });

  it('reports several modified fields in address order', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    s.setMDT(0);
    s.setFieldAttribute(10, 0x00);
    s.setChar(11, 0xc2);
    s.setMDT(10);
    s.cursor = 0;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out)).toEqual([
      AID.ENTER, 0x40, 0x40,
      Order.SBA, 0x40, 0xc1, 0xc1,
      Order.SBA, 0x40, 0x4b, 0xc2,
    ]);
  });

  it('sends only the AID and cursor on an unformatted screen with no fields', () => {
    const s = new Screen();
    s.cursor = 0;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out)).toEqual([AID.ENTER, 0x40, 0x40]);
  });

  it('doubles nothing — IAC escaping belongs to the telnet layer', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xff);
    s.setMDT(0);
    s.cursor = 2;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out).filter((b) => b === 0xff)).toHaveLength(1);
  });
});

describe('Read Buffer', () => {
  it('returns AID, cursor, and the whole buffer with attributes in place', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setChar(1, 0xc1);
    s.cursor = 1;
    const out = buildReadBuffer(s, AID.NONE);
    expect(out[0]).toBe(AID.NONE);
    expect(Array.from(out.subarray(1, 3))).toEqual([0x40, 0xc1]);
    // Then 1920 buffer positions: an SF order pair for the attribute, then data.
    expect(out[3]).toBe(Order.SF);
    // Attribute goes out through the code table, not raw: ctlr.c:1112-1114.
    expect(out[4]).toBe(0x60);
    expect(out[5]).toBe(0xc1);
    expect(out).toHaveLength(3 + 1 + 1920);
  });
});

describe('attribute encoding', () => {
  it('maps attributes through the code table', () => {
    expect(encodeAttribute(0x00)).toBe(0x40);
    expect(encodeAttribute(FA.PROTECT)).toBe(0x60);
    // FA.PROTECT|FA.NUMERIC = 0x30; ADDRESS_CODE_TABLE[0x30] is 0xf0, not 0x70.
    expect(encodeAttribute(FA.PROTECT | FA.NUMERIC)).toBe(0xf0);
  });

  it('masks off the printable bits before indexing the table', () => {
    expect(encodeAttribute(0xe1)).toBe(encodeAttribute(0x21));
    expect(encodeAttribute(0xe1)).toBe(0x61);
  });
});
