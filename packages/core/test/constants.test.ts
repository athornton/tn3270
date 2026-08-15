import { describe, it, expect } from 'vitest';
import {
  TelnetCmd, TelnetOpt, TelnetSubopt,
  Cmd, SnaCmd, Order, AID, FA, WCC,
  ADDRESS_CODE_TABLE, isShortReadAID,
  PF_AIDS, PA_AIDS,
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
