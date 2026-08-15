/**
 * Wire constants for the 3270 datastream and the telnet options TN3270 uses.
 *
 * Verified against GA23-0059-07 Appendix F (hexadecimal index), Tables 3-2
 * (WCC), 3-4 (AID), and 4-4 (field attributes), cross-checked against x3270's
 * include/3270ds.h. Do not change a value without checking both sources: the
 * manual's OCR mangles some hex digits in tables, and memory is not a source.
 */

/** Telnet commands (RFC 854), plus EOR (RFC 885). */
export const TelnetCmd = {
  EOR: 239,
  SE: 240,
  NOP: 241,
  DM: 242,
  BREAK: 243,
  IP: 244,
  AO: 245,
  AYT: 246,
  EC: 247,
  EL: 248,
  GA: 249,
  SB: 250,
  WILL: 251,
  WONT: 252,
  DO: 253,
  DONT: 254,
  IAC: 255,
} as const;

/** Telnet options. The first three are what make a session TN3270 (RFC 1576 §3). */
export const TelnetOpt = {
  BINARY: 0,
  TERMINAL_TYPE: 24,
  EOR: 25,
  ECHO: 1,
  SUPPRESS_GO_AHEAD: 3,
  TIMING_MARK: 6,
  REGIME_3270: 29,
  TN3270E: 40,
} as const;

/** TERMINAL-TYPE subnegotiation codes (RFC 1091). */
export const TelnetSubopt = { IS: 0, SEND: 1 } as const;

/**
 * 3270 commands, non-SNA/channel encoding. x3270 accepts these as well as the
 * SNA codes below, so we do too.
 *
 * Note WSF (0x11) collides numerically with Order.SBA; they are distinguished
 * by position (command byte vs. order byte), never by value. Note also that
 * Cmd.NOP (0x03) is a 3270 command and has nothing to do with TelnetCmd.NOP.
 */
export const Cmd = {
  W: 0x01,
  RB: 0x02,
  NOP: 0x03,
  EW: 0x05,
  RM: 0x06,
  EWA: 0x0d,
  RMA: 0x0e,
  EAU: 0x0f,
  WSF: 0x11,
} as const;

/** 3270 commands, SNA encoding — what a TN3270 host normally sends. */
export const SnaCmd = {
  RMA: 0x6e,
  EAU: 0x6f,
  EWA: 0x7e,
  W: 0xf1,
  RB: 0xf2,
  WSF: 0xf3,
  EW: 0xf5,
  RM: 0xf6,
} as const;

/** Buffer orders (Appendix F). SA/SFE/MF are recognized in stage 1 only so
 * they can be skipped by length instead of mis-executed. */
export const Order = {
  PT: 0x05,
  GE: 0x08,
  SBA: 0x11,
  EUA: 0x12,
  IC: 0x13,
  SF: 0x1d,
  SA: 0x28,
  SFE: 0x29,
  MF: 0x2c,
  RA: 0x3c,
} as const;

/** Attention identifiers (Table 3-4). */
export const AID = {
  NONE: 0x60,
  QREPLY: 0x61,
  ENTER: 0x7d,
  PF1: 0xf1,
  PF2: 0xf2,
  PF3: 0xf3,
  PF4: 0xf4,
  PF5: 0xf5,
  PF6: 0xf6,
  PF7: 0xf7,
  PF8: 0xf8,
  PF9: 0xf9,
  PF10: 0x7a,
  PF11: 0x7b,
  PF12: 0x7c,
  PF13: 0xc1,
  PF14: 0xc2,
  PF15: 0xc3,
  PF16: 0xc4,
  PF17: 0xc5,
  PF18: 0xc6,
  PF19: 0xc7,
  PF20: 0xc8,
  PF21: 0xc9,
  PF22: 0x4a,
  PF23: 0x4b,
  PF24: 0x4c,
  PA1: 0x6c,
  PA2: 0x6e,
  PA3: 0x6b,
  CLEAR: 0x6d,
  SYSREQ: 0xf0,
  SELECT: 0x7e,
  SF: 0x88,
} as const;

/** PF key number (1-24) to AID byte. */
export const PF_AIDS: readonly number[] = [
  AID.PF1, AID.PF2, AID.PF3, AID.PF4, AID.PF5, AID.PF6,
  AID.PF7, AID.PF8, AID.PF9, AID.PF10, AID.PF11, AID.PF12,
  AID.PF13, AID.PF14, AID.PF15, AID.PF16, AID.PF17, AID.PF18,
  AID.PF19, AID.PF20, AID.PF21, AID.PF22, AID.PF23, AID.PF24,
];

/** PA key number (1-3) to AID byte. */
export const PA_AIDS: readonly number[] = [AID.PA1, AID.PA2, AID.PA3];

/**
 * Short-read AIDs send the AID byte ALONE — no cursor address, no field data.
 * GA23-0059-07: "During the short-read operation, only an AID byte is
 * transferred to the application program." x3270's ctlr_read_modified jumps to
 * rm_done immediately after writing the AID for these four.
 *
 * Read Modified All suppresses this (see inbound.ts), and SELECT is NOT a
 * short read — it sends cursor but no field data.
 */
export function isShortReadAID(aid: number): boolean {
  return aid === AID.CLEAR || aid === AID.PA1 || aid === AID.PA2 || aid === AID.PA3;
}

/** Field attribute bits (Table 4-4). */
export const FA = {
  PRINTABLE: 0xc0,
  PROTECT: 0x20,
  NUMERIC: 0x10,
  INTENSITY: 0x0c,
  INT_NORM_NSEL: 0x00,
  INT_NORM_SEL: 0x04,
  INT_HIGH_SEL: 0x08,
  INT_ZERO_NSEL: 0x0c,
  RESERVED: 0x02,
  MODIFY: 0x01,
} as const;

/**
 * WCC bits (Table 3-2). The manual numbers bits 0-7 from the most significant
 * end, so its "bit 7" (reset MDT) is mask 0x01 and its "bit 1" (reset) is 0x40.
 */
export const WCC = {
  RESET: 0x40,
  START_PRINTER: 0x08,
  SOUND_ALARM: 0x04,
  KEYBOARD_RESTORE: 0x02,
  RESET_MDT: 0x01,
} as const;

/**
 * Maps a 6-bit value to its outbound byte in 12-bit address form.
 * Matches x3270's code_table in Common/ctlr.c.
 */
export const ADDRESS_CODE_TABLE: readonly number[] = [
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7,
  0xd8, 0xd9, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7,
  0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
  0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
];

/** Default screen geometry for an IBM-3278-2. */
export const MODEL_2 = { rows: 24, cols: 80 } as const;
export const TERMINAL_TYPE = 'IBM-3278-2';
