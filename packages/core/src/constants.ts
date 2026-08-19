/**
 * Wire constants for the 3270 datastream and the telnet options TN3270 uses.
 *
 * Verified against GA23-0059-07 Appendix F (hexadecimal index), Tables 3-2
 * (WCC), 3-4 (AID), 4-4 (field attributes), 4-6 (attribute types), and 6-1
 * (Query Replies), plus chapter 5 (Read Partition) and chapter 6 (Query
 * Reply), cross-checked against x3270's include/3270ds.h. Do not change a
 * value without checking both sources: the manual's OCR mangles some hex
 * digits in tables, and memory is not a source.
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

/**
 * Structured field identifiers (SFID), GA23-0059 p. 5-51 and chapter 6.
 *
 * 0x81 is BOTH the Query Reply SFID (inbound — i.e. sent by us; chapter 6 is
 * "Inbound Structured Fields") and, as a QCODE, the Usable Area reply code.
 * They occupy different byte positions and are never interchangeable: SFID is
 * byte 2, QCODE is byte 3.
 */
export const Sfid = {
  READ_PARTITION: 0x01,
  QUERY_REPLY: 0x81,
} as const;

/** PID value meaning "this is a query, not a read of partition 0x00-0x7E". */
export const PID_QUERY = 0xff;

/**
 * Read Partition TYPE byte, GA23-0059 p. 5-51 (pages.txt:6350-6355).
 *
 * We answer both query types. The table also lists X'6E' Read Modified All,
 * X'F2' Read Buffer and X'F6' Read Modified — reads against a REAL partition,
 * which we do not support, so they are absent here on purpose. x3270 handles
 * them (sf.c:304-334) and requires PID 0x00 for each; we have no partitions to
 * read.
 */
export const ReadPartitionType = {
  QUERY: 0x02,
  QUERY_LIST: 0x03,
} as const;

/**
 * Query List REQTYP, GA23-0059 p. 5-51 and p. 6-19.
 *
 * BITS 0-1 OF BYTE 5, not the whole byte: "an additional parameter, REQTYP
 * (Request Type), bits 0-1 of byte 5 and, / optionally, a list of QCODES
 * starting at byte 6" (pages.txt:8508-8509, p. 6-19). Bits 2-7 are reserved —
 * the byte table's row reads "2-7 SFID Reserved" (pages.txt:6356; that "SFID"
 * is OCR damage, the field is unnamed reserved space).
 *
 * The values below are therefore the SHIFTED forms, B'00'/B'01'/B'10' occupying
 * the top two bits: 0x00, 0x40, 0x80. That is exactly how x3270 spells them
 * (include/3270ds.h:118-120):
 *
 *     #define   SF_RPQ_LIST	0x00	//   QCODE list
 *     #define   SF_RPQ_EQUIV	0x40	//   equivalent+ QCODE list
 *     #define   SF_RPQ_ALL	0x80	//   all
 *
 * B'11' (0xC0) is "Reserved" (pages.txt:6361) and there is no entry for it:
 * x3270 rejects an unrecognised request type outright (sf.c:301-303, `default:
 * ... return PDS_BAD_CMD`), and so do we.
 *
 * NOTE x3270 compares `buf[5]` against these WITHOUT masking off bits 2-7, so a
 * host setting a reserved low bit lands in its default case and is rejected.
 * We mask instead — see REQTYP_MASK — because the manual defines the field as
 * bits 0-1 and says nothing about the other six mattering.
 */
export const ReqTyp = {
  QCODE_LIST: 0x00,
  EQUIVALENT: 0x40,
  ALL: 0x80,
} as const;

/** Bits 0-1 of byte 5. The rest is reserved; see the note on ReqTyp. */
export const REQTYP_MASK = 0xc0;

/**
 * Query Reply codes (QCODE), GA23-0059 Table 6-1. Only what we implement.
 *
 * Usable Area and Implicit Partition are legible in that table (pages.txt:8638,
 * :8608). Summary's own code is NOT: its row OCRs as "Summary Yes X'BO' Yes
 * Yes" (pages.txt:8635), and 0xB0 is a real QCODE elsewhere (Segment,
 * 3270ds.h:173), so the damage is not self-evident. 0x80 comes from the prose
 * at p. 6-20: "must support the Summary Query Reply, QCODE = X '80'"
 * (pages.txt:8568-8569), and from 3270ds.h:136 QR_SUMMARY 0x80.
 */
export const Qcode = {
  SUMMARY: 0x80,
  USABLE_AREA: 0x81,
  IMPLICIT_PARTITION: 0xa6,
  /**
   * Null (QCODE 0xFF) — "we support none of what you asked for".
   *
   * NOT a capability, which is why it is not in DEFAULT_CAPABILITIES and why
   * Table 6-1 gives it "Null No X'FF' No No" (pages.txt:8612): the only three
   * columns are Query / Query List / Equivalent / All and it is returned by
   * NONE of them as a matter of support. It is returned by exactly one path,
   * REQTYP=QCODE List matching nothing we have. x3270 keeps it in its reply
   * table but pointedly excludes it from every enumeration, with the comment
   * "QR_NULL must be last in the table" (sf.c:94) and NSR = NSR_ALL - 1
   * (sf.c:102-103) so the loops stop before it.
   *
   * Value from 3270ds.h:180 `#define QR_NULL 0xff` and from the manual's own
   * byte table, "3 QCODE X'FF' Identifies this Query Reply as Null"
   * (pages.txt:10771).
   */
  NULL: 0xff,
} as const;

/**
 * SFE/MF attribute-type for the basic 3270 field attribute.
 *
 * 0xC0, confirmed twice because the manual's prose example OCRs as X'C8'
 * (pages.txt:2882). The attribute-type table (Table 4-6) reads
 * "X'CO' 3270 Field attribute" (pages.txt:3430) — that O is OCR of a zero —
 * and x3270's include/3270ds.h:230 defines XA_3270 0xc0. Numerically equal to
 * FA.PRINTABLE, which is a coincidence of the architecture, not a relation —
 * do not unify them.
 */
export const XA_3270 = 0xc0;

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

/** PF key number 1-24, at index n-1, to its AID byte. */
export const PF_AIDS: readonly number[] = [
  AID.PF1, AID.PF2, AID.PF3, AID.PF4, AID.PF5, AID.PF6,
  AID.PF7, AID.PF8, AID.PF9, AID.PF10, AID.PF11, AID.PF12,
  AID.PF13, AID.PF14, AID.PF15, AID.PF16, AID.PF17, AID.PF18,
  AID.PF19, AID.PF20, AID.PF21, AID.PF22, AID.PF23, AID.PF24,
];

/** PA key number 1-3, at index n-1, to its AID byte. */
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

/**
 * Extended attribute types, carried by SA (X'28') and as SFE type-value pairs.
 * x3270's include/3270ds.h:240-250.
 *
 * `RESET` is 0x00 AS A TYPE and means "return every character attribute type to
 * its default" — the manual: "The attribute type X'00' is always supported by
 * the SA order" (pages.txt:2986). Do not confuse it with `XAC_DEFAULT`, which is
 * 0x00 as a VALUE under FOREGROUND/BACKGROUND and means "device default colour".
 * Both appear in the committed TK5 fixture (101 FOREGROUND, 12 RESET), so a
 * conflation is not hypothetical.
 *
 * CHARSET is named but deliberately NOT implemented — it selects Programmable
 * Symbol Sets, which are out of scope. It stays counted by setAttributeIgnored.
 */
export const XA = {
  RESET: 0x00,
  HIGHLIGHTING: 0x41,
  FOREGROUND: 0x42,
  CHARSET: 0x43,
  BACKGROUND: 0x45,
} as const;

/** Highlighting values for `XA.HIGHLIGHTING`. 3270ds.h:241-246. */
export const XAH = {
  DEFAULT: 0x00,
  NORMAL: 0xf0,
  BLINK: 0xf1,
  REVERSE: 0xf2,
  UNDERSCORE: 0xf4,
  INTENSIFY: 0xf8,
} as const;

/** Colour value meaning "the device default", per Query Reply (Color). 3270ds.h:248. */
export const XAC_DEFAULT = 0x00;
export const TERMINAL_TYPE = 'IBM-3278-2';
