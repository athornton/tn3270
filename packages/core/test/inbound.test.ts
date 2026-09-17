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

  it('sends only the AID and cursor on an EMPTY unformatted screen', () => {
    // Nothing typed, so there is no character data to send. An unformatted
    // screen WITH content is a different case — see the 'unformatted screens'
    // block below, which was added after a live VM/370 session showed that
    // dropping that content stops LOGON from ever reaching CP.
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

describe('unformatted screens', () => {
  // Found against a live VM/370: its first screen has ZERO field attributes, so
  // a field-iterating implementation sends nothing and LOGON never reaches CP.
  // x3270's ctlr_read_modified has an `else` branch for exactly this
  // (ctlr.c:997-1057) that walks the buffer emitting every nonzero character.
  it('sends every non-null character when there are no fields', () => {
    const s = new Screen();
    s.setChar(0, 0xc8);
    s.setChar(1, 0xc9);
    s.cursor = 3;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out)).toEqual([AID.ENTER, 0x40, 0xc3, 0xc8, 0xc9]);
  });

  it('emits no SBA orders on an unformatted screen', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    s.setChar(500, 0xc2);
    s.cursor = 0;
    const out = buildReadModified(s, AID.ENTER, false);
    expect(Array.from(out)).not.toContain(Order.SBA);
    expect(Array.from(out).slice(3)).toEqual([0xc1, 0xc2]);
  });

  it('still sends the AID alone for a short read when unformatted', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    expect(Array.from(buildReadModified(s, AID.CLEAR, false))).toEqual([AID.CLEAR]);
  });
});

describe('all-protected screens (the Hercules connect-time banner)', () => {
  // This host greets a new connection with the Hercules/Aethra banner: 19 fields,
  // every one of them protected, and it sends nothing further until it receives an
  // AID. Pressing Enter there is therefore unavoidable — it is how you get VM's
  // real screen — and what we send is the whole of record 0 in the x3270
  // conformance comparison, so it has to be exactly right.
  //
  // Correct is AID + cursor and NO field data: x3270 emits AID then
  // ENCODE_BADDR(cursor_addr) unconditionally for an ordinary AID
  // (ctlr.c:796-803), then walks fields and skips any whose MDT is clear
  // (ctlr.c:810-830). A protected field cannot have been typed into, so no MDT is
  // set and nothing follows the cursor. Confirmed on the wire against the live
  // host as `7d 40 40`.
  function allProtectedBanner(): Screen {
    const s = new Screen();
    for (let row = 0; row < 19; row++) {
      const at = row * 80;
      s.setFieldAttribute(at, FA.PROTECT);
      s.setChar(at + 1, 0xc8); // some banner text; never modified by the operator
    }
    s.cursor = 0;
    return s;
  }

  it('sends AID and cursor only, with no field data', () => {
    const out = buildReadModified(allProtectedBanner(), AID.ENTER, false);
    expect(Array.from(out)).toEqual([AID.ENTER, 0x40, 0x40]);
  });

  it('emits no SBA order, because no field has its MDT set', () => {
    const out = buildReadModified(allProtectedBanner(), AID.ENTER, false);
    expect(Array.from(out)).not.toContain(Order.SBA);
  });

  it('treats the screen as formatted, not unformatted', () => {
    // The regression this guards: an implementation that decides "no modified
    // fields, so fall back to the unformatted path" would dump the banner's own
    // text back at the host. The banner HAS fields; it just has no modified ones.
    const out = buildReadModified(allProtectedBanner(), AID.ENTER, false);
    expect(Array.from(out)).not.toContain(0xc8);
    expect(out).toHaveLength(3);
  });
});

/**
 * THE TEST REQUEST READ, which is what the Sys Req key produces on a classic session.
 *
 * The bytes below are written as raw numbers, NOT as the `EBCDIC_SOH`/`EBCDIC_PERCENT`/
 * `EBCDIC_SLASH`/`EBCDIC_STX` constants the builder uses, deliberately: asserting a
 * constant against itself would pass however wrong the constant is. They come from
 * x3270's `include/3270ds.h:356-357,373,375` — `EBC_soh 0x01`, `EBC_stx 0x02`,
 * `EBC_slash 0x61`, `EBC_percent 0x6c`.
 *
 * NOTE 0x6c IS ALSO `AID.PA1`. In a wire dump the two are indistinguishable; here it is
 * the EBCDIC graphic `%`, the second byte of the heading, and nothing to do with PA1.
 */
describe('the test request read (Sys Req / Test Req)', () => {
  it('sends SOH % / STX then the modified field data, with NO AID and NO cursor address', () => {
    // GA23-0059-07 (pages.txt:13776-13795): the heading, then "the same as described
    // previously for read-modified operations, excluding the 3-byte read heading (AID
    // and cursor address)". x3270's ctlr_read_modified writes the four bytes and
    // `break`s out of the AID switch (ctlr.c:770-777) — the break leaves the SWITCH,
    // not the function, so the field scan below it still runs.
    const s = screenWithModifiedField();
    const out = buildReadModified(s, AID.SYSREQ, false);
    expect(Array.from(out)).toEqual([
      0x01, 0x6c, 0x61, 0x02, // SOH % / STX
      Order.SBA, 0x40, 0xc1,  // the modified field, whose data starts at address 1
      0xc1, 0xc2,             // "AB"
    ]);
  });

  it('never puts AID 0xf0 on the wire, even though the AID exists', () => {
    // `AID.SYSREQ` is a real architected AID byte — GA23-0059-07 Table 3-4 lists
    // "Test Req and Sys Req  F0" (pages.txt:2017) — and it is what selects this branch.
    // It is still never TRANSMITTED for this key. This is the counterintuitive part.
    const out = buildReadModified(screenWithModifiedField(), AID.SYSREQ, false);
    expect(Array.from(out)).not.toContain(AID.SYSREQ);
    expect(out[0]).not.toBe(AID.SYSREQ);
  });

  it('sends the heading ALONE when no field has its MDT set', () => {
    // "If no MDT bits are set, the read data stream consists of the Test Request Read
    // heading only" (pages.txt:13793-13794).
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1); // typed by the host, not the operator: MDT stays clear
    expect(Array.from(buildReadModified(s, AID.SYSREQ, false))).toEqual([0x01, 0x6c, 0x61, 0x02]);
  });

  it('sends every non-null byte after the heading on an unformatted screen', () => {
    // "If the buffer is unformatted, all the alphanumeric data in the buffer is included
    // in the data stream (nulls suppressed), starting at address 0" (pages.txt:13788-13790).
    // Not a corner case: VM/370's logon screen is unformatted, and it is one of the two
    // hosts this key will meet.
    const s = new Screen();
    s.setChar(0, 0xc1);
    s.setChar(500, 0xc2);
    const out = buildReadModified(s, AID.SYSREQ, false);
    expect(Array.from(out)).toEqual([0x01, 0x6c, 0x61, 0x02, 0xc1, 0xc2]);
    expect(Array.from(out)).not.toContain(Order.SBA);
  });

  it('sends the heading alone on an empty screen — no cursor address leaks in', () => {
    // The regression this catches: an implementation that emitted the heading and then
    // fell into the ordinary path's `encodeAddress(screen.cursor)` would send two extra
    // bytes here, and on a NON-zero cursor they would not even look like padding.
    const s = new Screen();
    s.cursor = 3;
    expect(Array.from(buildReadModified(s, AID.SYSREQ, false))).toEqual([0x01, 0x6c, 0x61, 0x02]);
  });

  it('appends no ETX, because this is not BSC', () => {
    // The manual's BSC form ends in ETX (pages.txt:13780-13785); the non-SNA form is
    // "the same as for the BSC environment, except there is no ETX"
    // (pages.txt:14180-14184). ETX is EBCDIC 0x03. x3270 emits none either.
    const out = buildReadModified(screenWithModifiedField(), AID.SYSREQ, false);
    expect(Array.from(out)).not.toContain(0x03);
    expect(out.at(-1)).toBe(0xc2); // the last data byte, nothing after it
  });

  it('is not treated as a short read', () => {
    // `isShortReadAID` covers Clear and PA1-3 only. If SYSREQ ever joined that set the
    // heading would be replaced by a bare 0xf0, which is the one byte it must never be.
    const out = buildReadModified(screenWithModifiedField(), AID.SYSREQ, false);
    expect(out.length).toBeGreaterThan(4);
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
