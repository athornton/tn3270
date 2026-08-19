import { describe, it, expect } from 'vitest';
import {
  TelnetCmd, TelnetOpt, TelnetSubopt,
  Cmd, SnaCmd, Order, AID, FA, WCC,
  ADDRESS_CODE_TABLE, isShortReadAID,
  PF_AIDS, PA_AIDS,
  Sfid, PID_QUERY, ReadPartitionType, ReqTyp, REQTYP_MASK, Qcode, XA_3270,
  XA, XAH, XAC_DEFAULT,
} from '../src/constants.js';

describe('telnet constants', () => {
  it('matches RFC 854 and RFC 1576', () => {
    expect(TelnetCmd.SE).toBe(240);
    expect(TelnetCmd.NOP).toBe(241);
    expect(TelnetCmd.BREAK).toBe(243);
    expect(TelnetCmd.SB).toBe(250);
    expect(TelnetCmd.WILL).toBe(251);
    expect(TelnetCmd.WONT).toBe(252);
    expect(TelnetCmd.DO).toBe(253);
    expect(TelnetCmd.DONT).toBe(254);
    expect(TelnetCmd.IAC).toBe(255);
    expect(TelnetCmd.EOR).toBe(239);
    expect(TelnetOpt.BINARY).toBe(0);
    expect(TelnetOpt.TERMINAL_TYPE).toBe(24);
    expect(TelnetOpt.EOR).toBe(25);
    expect(TelnetSubopt.IS).toBe(0);
    expect(TelnetSubopt.SEND).toBe(1);
  });
});

describe('3270 command constants', () => {
  it('has both SNA and non-SNA encodings', () => {
    expect(SnaCmd.W).toBe(0xf1);
    expect(SnaCmd.EW).toBe(0xf5);
    expect(SnaCmd.EWA).toBe(0x7e);
    expect(SnaCmd.EAU).toBe(0x6f);
    expect(SnaCmd.RB).toBe(0xf2);
    expect(SnaCmd.RM).toBe(0xf6);
    expect(SnaCmd.RMA).toBe(0x6e);
    expect(SnaCmd.WSF).toBe(0xf3);

    expect(Cmd.W).toBe(0x01);
    expect(Cmd.RB).toBe(0x02);
    expect(Cmd.NOP).toBe(0x03);
    expect(Cmd.EW).toBe(0x05);
    expect(Cmd.RM).toBe(0x06);
    expect(Cmd.EWA).toBe(0x0d);
    expect(Cmd.RMA).toBe(0x0e);
    expect(Cmd.EAU).toBe(0x0f);
    expect(Cmd.WSF).toBe(0x11);
  });
});

describe('order constants', () => {
  it('matches Appendix F', () => {
    expect(Order.PT).toBe(0x05);
    expect(Order.GE).toBe(0x08);
    expect(Order.SBA).toBe(0x11);
    expect(Order.EUA).toBe(0x12);
    expect(Order.IC).toBe(0x13);
    expect(Order.SF).toBe(0x1d);
    expect(Order.SA).toBe(0x28);
    expect(Order.SFE).toBe(0x29);
    expect(Order.MF).toBe(0x2c);
    expect(Order.RA).toBe(0x3c);
  });
});

describe('AID constants', () => {
  it('matches Table 3-4', () => {
    expect(AID.ENTER).toBe(0x7d);
    expect(AID.PF1).toBe(0xf1);
    expect(AID.PF9).toBe(0xf9);
    expect(AID.PF10).toBe(0x7a);
    expect(AID.PF11).toBe(0x7b);
    expect(AID.PF12).toBe(0x7c);
    expect(AID.PF13).toBe(0xc1);
    expect(AID.PF21).toBe(0xc9);
    expect(AID.PF22).toBe(0x4a);
    expect(AID.PF23).toBe(0x4b);
    expect(AID.PF24).toBe(0x4c);
    expect(AID.PA1).toBe(0x6c);
    expect(AID.PA2).toBe(0x6e);
    expect(AID.PA3).toBe(0x6b);
    expect(AID.CLEAR).toBe(0x6d);
    expect(AID.SYSREQ).toBe(0xf0);
    expect(AID.SELECT).toBe(0x7e);
    expect(AID.NONE).toBe(0x60);
    expect(AID.QREPLY).toBe(0x61);
    expect(AID.SF).toBe(0x88);
  });

  it('identifies exactly the four short-read AIDs', () => {
    expect(isShortReadAID(AID.CLEAR)).toBe(true);
    expect(isShortReadAID(AID.PA1)).toBe(true);
    expect(isShortReadAID(AID.PA2)).toBe(true);
    expect(isShortReadAID(AID.PA3)).toBe(true);
    expect(isShortReadAID(AID.ENTER)).toBe(false);
    expect(isShortReadAID(AID.PF1)).toBe(false);
    expect(isShortReadAID(AID.SELECT)).toBe(false);
  });
});

describe('PF_AIDS and PA_AIDS', () => {
  it('index PF key n at n-1', () => {
    expect(PF_AIDS).toHaveLength(24);
    expect(PF_AIDS[0]).toBe(AID.PF1);
    expect(PF_AIDS[8]).toBe(AID.PF9);
    expect(PF_AIDS[9]).toBe(AID.PF10);
    expect(PF_AIDS[23]).toBe(AID.PF24);
  });

  it('index PA key n at n-1', () => {
    expect(PA_AIDS).toHaveLength(3);
    expect(PA_AIDS[0]).toBe(AID.PA1);
    expect(PA_AIDS[1]).toBe(AID.PA2);
    expect(PA_AIDS[2]).toBe(AID.PA3);
  });
});

describe('field attribute bits', () => {
  it('matches Table 4-4', () => {
    expect(FA.PROTECT).toBe(0x20);
    expect(FA.NUMERIC).toBe(0x10);
    expect(FA.INTENSITY).toBe(0x0c);
    expect(FA.INT_NORM_NSEL).toBe(0x00);
    expect(FA.INT_NORM_SEL).toBe(0x04);
    expect(FA.INT_HIGH_SEL).toBe(0x08);
    expect(FA.INT_ZERO_NSEL).toBe(0x0c);
    expect(FA.RESERVED).toBe(0x02);
    expect(FA.MODIFY).toBe(0x01);
  });
});

describe('WCC bits', () => {
  it('matches Table 3-2', () => {
    expect(WCC.RESET).toBe(0x40);
    expect(WCC.START_PRINTER).toBe(0x08);
    expect(WCC.SOUND_ALARM).toBe(0x04);
    expect(WCC.KEYBOARD_RESTORE).toBe(0x02);
    expect(WCC.RESET_MDT).toBe(0x01);
  });
});

describe('12-bit address code table', () => {
  it('has 64 entries starting 0x40 0xC1', () => {
    expect(ADDRESS_CODE_TABLE).toHaveLength(64);
    expect(ADDRESS_CODE_TABLE[0]).toBe(0x40);
    expect(ADDRESS_CODE_TABLE[1]).toBe(0xc1);
    expect(ADDRESS_CODE_TABLE[10]).toBe(0x4a);
    expect(ADDRESS_CODE_TABLE[16]).toBe(0x50);
    expect(ADDRESS_CODE_TABLE[63]).toBe(0x7f);
  });
});

describe('structured field constants', () => {
  it('structured field identifiers match GA23-0059', () => {
    // Read Partition format, p. 5-51 (pages.txt:6342-6356).
    expect(Sfid.READ_PARTITION).toBe(0x01);
    expect(Sfid.QUERY_REPLY).toBe(0x81);
    expect(PID_QUERY).toBe(0xff);
    expect(ReadPartitionType.QUERY).toBe(0x02);
    expect(ReadPartitionType.QUERY_LIST).toBe(0x03);
  });

  it('query reply codes match GA23-0059 table 6-1', () => {
    expect(Qcode.SUMMARY).toBe(0x80);
    expect(Qcode.USABLE_AREA).toBe(0x81);
    expect(Qcode.IMPLICIT_PARTITION).toBe(0xa6);
    // Null, p. 6-77: "3 QCODE X'FF' Identifies this Query Reply as Null"
    // (pages.txt:10771); x3270 include/3270ds.h:180 QR_NULL 0xff.
    expect(Qcode.NULL).toBe(0xff);
  });

  it('REQTYP values are the shifted bits 0-1 forms, matching x3270', () => {
    // REQTYP occupies "bits 0-1 of byte 5" (pages.txt:8508), so B'00'/B'01'/B'10'
    // land in the TOP two bits: 0x00, 0x40, 0x80 — not 0, 1, 2. Reading the
    // manual's B'01' as the literal value 1 is the mistake this guards; the
    // captured VM request carries 0x80, which under that misreading is unknown.
    // x3270 include/3270ds.h:118-120 spells them exactly this way.
    expect(ReqTyp.QCODE_LIST).toBe(0x00);
    expect(ReqTyp.EQUIVALENT).toBe(0x40);
    expect(ReqTyp.ALL).toBe(0x80);
    // The mask covers those two bits and nothing else; bits 2-7 are reserved
    // ("2-7 SFID Reserved", pages.txt:6356, where "SFID" is OCR damage).
    expect(REQTYP_MASK).toBe(0xc0);
    // Every defined value survives masking, i.e. none of them sets a reserved
    // bit. B'11' = 0xC0 is "Reserved" (pages.txt:6361) and is deliberately
    // absent from ReqTyp.
    for (const v of Object.values(ReqTyp)) expect(v & REQTYP_MASK).toBe(v);
    expect(Object.values(ReqTyp)).not.toContain(0xc0);
  });

  it('0x81 is both the Query Reply SFID and the Usable Area QCODE', () => {
    // Distinguished by byte position (2 vs. 3), never by value.
    expect(Sfid.QUERY_REPLY).toBe(Qcode.USABLE_AREA);
  });

  it('the SFE field-attribute pair type is 0xC0, not the 0xC8 the manual prose OCRs as', () => {
    // Manual attribute-type table gives X'C0' 3270 Field attribute; x3270
    // include/3270ds.h:230 defines XA_3270 0xc0. Both checked.
    expect(XA_3270).toBe(0xc0);
  });
});

describe('extended attribute types and values', () => {
  it('names the attribute types from 3270ds.h:240-250', () => {
    expect(XA.RESET).toBe(0x00);
    expect(XA.HIGHLIGHTING).toBe(0x41);
    expect(XA.FOREGROUND).toBe(0x42);
    expect(XA.CHARSET).toBe(0x43);
    expect(XA.BACKGROUND).toBe(0x45);
  });

  it('names all six highlighting values, including intensify', () => {
    expect(XAH.DEFAULT).toBe(0x00);
    expect(XAH.NORMAL).toBe(0xf0);
    expect(XAH.BLINK).toBe(0xf1);
    expect(XAH.REVERSE).toBe(0xf2);
    expect(XAH.UNDERSCORE).toBe(0xf4);
    expect(XAH.INTENSIFY).toBe(0xf8);
  });

  it('XA.RESET is a TYPE meaning reset-all, distinct from XAC_DEFAULT as a VALUE', () => {
    // Both are 0x00 and conflating them is a real bug: as a type it means "return
    // every character attribute to default" (pages.txt:2986); as a value under
    // XA.FOREGROUND it means "device default colour". The TK5 fixture contains
    // twelve of the former.
    expect(XA.RESET).toBe(XAC_DEFAULT);
    expect(XA.RESET).not.toBe(XA.FOREGROUND);
  });
});
