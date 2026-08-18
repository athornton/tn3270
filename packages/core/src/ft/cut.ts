/**
 * IND$FILE CUT-mode codec: the 6-bit alphabet, the four quadrant translation
 * tables, the XOR checksum, and the two stateful byte conversions.
 *
 * Pure and host-independent. No screen, no session, no I/O. Frames, the state
 * machine and the CLI action are separate units; see
 * docs/superpowers/specs/2026-08-18-indfile-cut-transfer-design.md.
 *
 * Ported from x3270 4.5, `Common/ft_cut.c`, which the design doc names as the
 * de facto protocol definition: CUT is underspecified, and x3270 is the client
 * these hosts have actually been driven with for decades. Every table and every
 * branch below cites a line in that file. Constants were extracted from the C
 * with a script and diffed against this file, not retyped -- see
 * packages/core/test/ft/cut.test.ts, which re-derives the invariants.
 *
 * ## THE NAMING TRAP
 *
 * x3270's "upload" and "download" are named from the HOST's point of view,
 * which is inverted from ordinary usage. Its `upload_convert` (`ft_cut.c:134`,
 * commented at `:129` "Convert a buffer for uploading (host->local)") is what a
 * user calls a DOWNLOAD, i.e. IND$FILE GET. Its `download_convert`
 * (`ft_cut.c:307`) and `store_download` (`ft_cut.c:270`) are what a user calls
 * an UPLOAD, i.e. IND$FILE PUT.
 *
 * This module therefore uses `hostToLocal` and `localToHost`, which cannot be
 * misread. The words "upload" and "download" appear nowhere in an identifier
 * here, only in citations that state the real direction.
 *
 * ## SCOPE: binary mode only, for now
 *
 * ASCII mode is DEFERRED. `upload_convert` also does CR/EOF suppression when
 * `ascii_flag && cr_flag` (`ft_cut.c:190-192`), a remap through the local
 * multi-byte encoding when `ascii_flag && remap_flag` (`ft_cut.c:193-262`), and
 * DBCS shift-in/shift-out state (`ft_cut.c:206-236`); `download_convert` has
 * the mirror image (`ft_cut.c:336-380`). None of that is implemented. The
 * design doc makes binary the default precisely because a wrong default
 * silently corrupts a MODULE, so binary is also the honest first delivery.
 */

/** Number of quadrants. `#define NQ 4` (ft_cut.c:56). */
export const NQ = 4;

/** Elements per quadrant. `#define NE 77` (ft_cut.c:57). */
export const NE = 77;

/**
 * The "OTHER 2" quadrant, which is the one containing NULL.
 * `#define OTHER_2 2` (ft_cut.c:58), whose own comment reads
 * `"OTHER 2" quadrant (includes NULL)`.
 */
export const OTHER_2 = 2;

/** Translation of NULL. `#define XLATE_NULL 0xc1` (ft_cut.c:59). */
export const XLATE_NULL = 0xc1;

/**
 * The 6-bit alphabet, used for sequence numbers, lengths and the checksum.
 * `static char table6[]` (ft_cut.c:105-106), verbatim:
 *
 *     "abcdefghijklmnopqrstuvwxyz&-.,:+ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
 *
 * 64 characters, all distinct, so index <-> character is a bijection.
 */
export const TABLE6 = 'abcdefghijklmnopqrstuvwxyz&-.,:+ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

/**
 * The 77-character quadrant index alphabet. `static char alphas[NE + 1]`
 * (ft_cut.c:61-62), verbatim -- note the LEADING SPACE, which is element 0 and
 * is load-bearing, not formatting:
 *
 *     " ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%&_()<+,-./:>?"
 *
 * The C declares it `[NE + 1]` because of the NUL terminator; the alphabet
 * itself is NE = 77 characters.
 */
export const ALPHAS =
  ' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789%&_()<+,-./:>?';

/** One quadrant: the selector byte that switches to it, and its 77 entries. */
export interface Quadrant {
  /** EBCDIC byte the host sends, and we send, to select this quadrant. */
  readonly selector: number;
  /** ALPHAS index -> the data byte it stands for. 0 means "not in this quadrant". */
  readonly xlate: readonly number[];
}

/**
 * The four quadrants: `static struct { ... } conv[NQ]` (ft_cut.c:64-104).
 *
 * TRANSCRIPTION PROVENANCE: these 308 bytes were extracted from ft_cut.c by
 * script and emitted in the C's own 12-per-line, 4-per-group layout so a diff
 * against the source is a visual no-op. The test file re-checks the properties
 * that a single wrong byte would break (lengths, selectors, the exhaustive
 * round trip, and the disjointness structure).
 *
 * A zero entry means "this quadrant does not encode a byte at this index",
 * EXCEPT at index 0 of OTHER_2 and of quadrant 3, where 0x00 is the real data
 * byte NULL -- which is exactly why hostToLocal needs the OTHER_2 and
 * XLATE_NULL special cases at ft_cut.c:181-182.
 */
export const QUADRANTS: readonly Quadrant[] = [
  {
    selector: 0x5e, // ';'
    xlate: [
      0x40,0xc1,0xc2,0xc3, 0xc4,0xc5,0xc6,0xc7, 0xc8,0xc9,0xd1,0xd2,
      0xd3,0xd4,0xd5,0xd6, 0xd7,0xd8,0xd9,0xe2, 0xe3,0xe4,0xe5,0xe6,
      0xe7,0xe8,0xe9,0x81, 0x82,0x83,0x84,0x85, 0x86,0x87,0x88,0x89,
      0x91,0x92,0x93,0x94, 0x95,0x96,0x97,0x98, 0x99,0xa2,0xa3,0xa4,
      0xa5,0xa6,0xa7,0xa8, 0xa9,0xf0,0xf1,0xf2, 0xf3,0xf4,0xf5,0xf6,
      0xf7,0xf8,0xf9,0x6c, 0x50,0x6d,0x4d,0x5d, 0x4c,0x4e,0x6b,0x60,
      0x4b,0x61,0x7a,0x6e, 0x6f,
    ],
  },
  {
    selector: 0x7e, // '='
    xlate: [
      0x20,0x41,0x42,0x43, 0x44,0x45,0x46,0x47, 0x48,0x49,0x4a,0x4b,
      0x4c,0x4d,0x4e,0x4f, 0x50,0x51,0x52,0x53, 0x54,0x55,0x56,0x57,
      0x58,0x59,0x5a,0x61, 0x62,0x63,0x64,0x65, 0x66,0x67,0x68,0x69,
      0x6a,0x6b,0x6c,0x6d, 0x6e,0x6f,0x70,0x71, 0x72,0x73,0x74,0x75,
      0x76,0x77,0x78,0x79, 0x7a,0x30,0x31,0x32, 0x33,0x34,0x35,0x36,
      0x37,0x38,0x39,0x25, 0x26,0x27,0x28,0x29, 0x2a,0x2b,0x2c,0x2d,
      0x2e,0x2f,0x3a,0x3b, 0x3f,
    ],
  },
  {
    selector: 0x5c, // '*'
    xlate: [
      0x00,0x00,0x01,0x02, 0x03,0x04,0x05,0x06, 0x07,0x08,0x09,0x0a,
      0x0b,0x0c,0x0d,0x0e, 0x0f,0x10,0x11,0x12, 0x13,0x14,0x15,0x16,
      0x17,0x18,0x19,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,
      0x00,0x00,0x00,0x00, 0x00,0x3c,0x3d,0x3e, 0x00,0xfa,0xfb,0xfc,
      0xfd,0xfe,0xff,0x7b, 0x7c,0x7d,0x7e,0x7f, 0x1a,0x1b,0x1c,0x1d,
      0x1e,0x1f,0x00,0x00, 0x00,
    ],
  },
  {
    selector: 0x7d, // '\'' (apostrophe)
    xlate: [
      0x00,0xa0,0xa1,0xea, 0xeb,0xec,0xed,0xee, 0xef,0xe0,0xe1,0xaa,
      0xab,0xac,0xad,0xae, 0xaf,0xb0,0xb1,0xb2, 0xb3,0xb4,0xb5,0xb6,
      0xb7,0xb8,0xb9,0x80, 0x00,0xca,0xcb,0xcc, 0xcd,0xce,0xcf,0xc0,
      0x00,0x8a,0x8b,0x8c, 0x8d,0x8e,0x8f,0x90, 0x00,0xda,0xdb,0xdc,
      0xdd,0xde,0xdf,0xd0, 0x00,0x00,0x21,0x22, 0x23,0x24,0x5b,0x5c,
      0x00,0x5e,0x5f,0x00, 0x9c,0x9d,0x9e,0x9f, 0xba,0xbb,0xbc,0xbd,
      0xbe,0xbf,0x9a,0x9b, 0x00,
    ],
  },
];

/**
 * x3270's fixed EBCDIC-to-ASCII table, `ebc2asc0[256]` (Common/tables.c:41-73).
 *
 * WHY THIS IS NOT `CodePage`/cp037. `ft_cut.c` uses `ebc2asc0`/`asc2ebc0` for
 * exactly one purpose: locating a character in TABLE6 or ALPHAS. The comment at
 * ft_cut.c:344-348 explains the model -- "The host uses a fixed EBCDIC-to-ASCII
 * translation table, which was derived empirically into i_ft2asc/i_asc2ft.
 * Invert that so that when the host applies its conversion, it gets the right
 * EBCDIC code."
 *
 * These tables are single-byte ASCII, and differ from cp037 in 66 of 256
 * entries: `ebc2asc0` maps every EBCDIC control byte below 0x40 to 0x20 (space)
 * rather than to a control character, except X'1C' -> '*' and X'1E' -> ';'.
 * cp037 is a faithful character-set mapping and (correctly, for its purpose)
 * does not do that.
 *
 * Only ONE of those 66 differences can reach this codec: EBCDIC X'41', which
 * `ebc2asc0` maps to 0x20 (space, ALPHAS index 0) while cp037 maps to U+00A0
 * NO-BREAK SPACE (not in ALPHAS at all). Using cp037 would make X'41' a
 * conversion error where x3270 decodes it as ALPHAS[0]. Over the 64 TABLE6
 * characters and the 77 ALPHAS characters, in both directions, the two tables
 * otherwise agree exactly -- the test asserts all four of those agreements and
 * pins the X'41' disagreement, so the claim is checked rather than asserted.
 *
 * Hence: cp037 is right for the screen and wrong here, and this module carries
 * its own 256-byte tables. They are a codec detail, not a code page, and are
 * deliberately not exported as one.
 */
const EBC2ASC: readonly number[] = [
  /* 00 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 08 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 10 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 18 */ 0x20, 0x20, 0x20, 0x20, 0x2a, 0x20, 0x3b, 0x20,
  /* 20 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 28 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 30 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 38 */ 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20,
  /* 40 */ 0x20, 0x20, 0xe2, 0xe4, 0xe0, 0xe1, 0xe3, 0xe5,
  /* 48 */ 0xe7, 0xf1, 0xa2, 0x2e, 0x3c, 0x28, 0x2b, 0x7c,
  /* 50 */ 0x26, 0xe9, 0xea, 0xeb, 0xe8, 0xed, 0xee, 0xef,
  /* 58 */ 0xec, 0xdf, 0x21, 0x24, 0x2a, 0x29, 0x3b, 0xac,
  /* 60 */ 0x2d, 0x2f, 0xc2, 0xc4, 0xc0, 0xc1, 0xc3, 0xc5,
  /* 68 */ 0xc7, 0xd1, 0xa6, 0x2c, 0x25, 0x5f, 0x3e, 0x3f,
  /* 70 */ 0xf8, 0xc9, 0xca, 0xcb, 0xc8, 0xcd, 0xce, 0xcf,
  /* 78 */ 0xcc, 0x60, 0x3a, 0x23, 0x40, 0x27, 0x3d, 0x22,
  /* 80 */ 0xd8, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67,
  /* 88 */ 0x68, 0x69, 0xab, 0xbb, 0xf0, 0xfd, 0xfe, 0xb1,
  /* 90 */ 0xb0, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70,
  /* 98 */ 0x71, 0x72, 0xaa, 0xba, 0xe6, 0xb8, 0xc6, 0xa4,
  /* a0 */ 0xb5, 0x7e, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
  /* a8 */ 0x79, 0x7a, 0xa1, 0xbf, 0xd0, 0xdd, 0xde, 0xae,
  /* b0 */ 0x5e, 0xa3, 0xa5, 0xb7, 0xa9, 0xa7, 0xb6, 0xbc,
  /* b8 */ 0xbd, 0xbe, 0x5b, 0x5d, 0xaf, 0xa8, 0xb4, 0xd7,
  /* c0 */ 0x7b, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47,
  /* c8 */ 0x48, 0x49, 0xad, 0xf4, 0xf6, 0xf2, 0xf3, 0xf5,
  /* d0 */ 0x7d, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50,
  /* d8 */ 0x51, 0x52, 0xb9, 0xfb, 0xfc, 0xf9, 0xfa, 0xff,
  /* e0 */ 0x5c, 0xf7, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
  /* e8 */ 0x59, 0x5a, 0xb2, 0xd4, 0xd6, 0xd2, 0xd3, 0xd5,
  /* f0 */ 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
  /* f8 */ 0x38, 0x39, 0xb3, 0xdb, 0xdc, 0xd9, 0xda, 0x20,
];

/** x3270's fixed ASCII-to-EBCDIC table, `asc2ebc0[256]` (Common/tables.c:74-106). */
const ASC2EBC: readonly number[] = [
  /* 00 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 08 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 10 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 18 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 20 */ 0x40, 0x5a, 0x7f, 0x7b, 0x5b, 0x6c, 0x50, 0x7d,
  /* 28 */ 0x4d, 0x5d, 0x5c, 0x4e, 0x6b, 0x60, 0x4b, 0x61,
  /* 30 */ 0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
  /* 38 */ 0xf8, 0xf9, 0x7a, 0x5e, 0x4c, 0x7e, 0x6e, 0x6f,
  /* 40 */ 0x7c, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  /* 48 */ 0xc8, 0xc9, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  /* 50 */ 0xd7, 0xd8, 0xd9, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6,
  /* 58 */ 0xe7, 0xe8, 0xe9, 0xba, 0xe0, 0xbb, 0xb0, 0x6d,
  /* 60 */ 0x79, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  /* 68 */ 0x88, 0x89, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96,
  /* 70 */ 0x97, 0x98, 0x99, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6,
  /* 78 */ 0xa7, 0xa8, 0xa9, 0xc0, 0x4f, 0xd0, 0xa1, 0x00,
  /* 80 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 88 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 90 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* 98 */ 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  /* a0 */ 0x41, 0xaa, 0x4a, 0xb1, 0x9f, 0xb2, 0x6a, 0xb5,
  /* a8 */ 0xbd, 0xb4, 0x9a, 0x8a, 0x5f, 0xca, 0xaf, 0xbc,
  /* b0 */ 0x90, 0x8f, 0xea, 0xfa, 0xbe, 0xa0, 0xb6, 0xb3,
  /* b8 */ 0x9d, 0xda, 0x9b, 0x8b, 0xb7, 0xb8, 0xb9, 0xab,
  /* c0 */ 0x64, 0x65, 0x62, 0x66, 0x63, 0x67, 0x9e, 0x68,
  /* c8 */ 0x74, 0x71, 0x72, 0x73, 0x78, 0x75, 0x76, 0x77,
  /* d0 */ 0xac, 0x69, 0xed, 0xee, 0xeb, 0xef, 0xec, 0xbf,
  /* d8 */ 0x80, 0xfd, 0xfe, 0xfb, 0xfc, 0xad, 0xae, 0x59,
  /* e0 */ 0x44, 0x45, 0x42, 0x46, 0x43, 0x47, 0x9c, 0x48,
  /* e8 */ 0x54, 0x51, 0x52, 0x53, 0x58, 0x55, 0x56, 0x57,
  /* f0 */ 0x8c, 0x49, 0xcd, 0xce, 0xcb, 0xcf, 0xcc, 0xe1,
  /* f8 */ 0x70, 0xdd, 0xde, 0xdb, 0xdc, 0x8d, 0x8e, 0xdf,
];

/**
 * A byte the CUT codec cannot convert.
 *
 * host->local, this is x3270's `cut_abort(get_message("ftCutConversionError"),
 * SC_ABORT_XMIT)` at ft_cut.c:156 and :162, which returns -1 and fails the
 * transfer. We throw, and the caller (the state machine, a later unit) turns it
 * into that same abort -- the design doc's rule is that a transfer fault ends
 * the transfer without killing the session.
 */
export class CutConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CutConversionError';
  }
}

/**
 * TABLE6 character -> its index, i.e. decode one 6-bit value.
 *
 * `static unsigned from6(unsigned char c)` (ft_cut.c:583-594). Takes an EBCDIC
 * byte as it came off the wire, translates it with `ebc2asc0`, and looks it up:
 *
 *     c = ebc2asc0[c];
 *     p = strchr(table6, c);
 *     if (p == NULL) {
 *         return 0;
 *     }
 *
 * NOTE THE ERROR SEMANTICS, which we match deliberately: an unrecognised byte
 * yields 0, indistinguishable from a genuine 0. That is lossy, and we keep it
 * because from6 decodes sequence numbers and lengths whose framing x3270 has
 * validated for decades -- diverging here would change frame handling on a
 * protocol we cannot yet test against the live host. 192 of the 256 possible
 * bytes take this path.
 *
 * There is one subtlety worth stating: `strchr` on a C string also matches the
 * NUL terminator, so in x3270 a byte translating to 0x00 would return 64, one
 * past the end. It cannot arise, because ebc2asc0 never produces 0x00 (verified
 * over all 256 entries), so JS's `indexOf` -- which does not have that quirk --
 * is faithful, not merely close.
 */
export function from6(byte: number): number {
  const ascii = EBC2ASC[byte & 0xff]!;
  const ix = TABLE6.indexOf(String.fromCharCode(ascii));
  return ix === -1 ? 0 : ix;
}

/**
 * A 6-bit value -> the EBCDIC byte encoding it. The inverse of from6.
 *
 * x3270 has no `to6` function; it inlines this as
 * `asc2ebc0[(int)table6[cs & 0x3f]]` (ft_cut.c:554, the checksum) and
 * `asc2ebc0[(int)table6[count & 0x3f]]` (ft_cut.c:556, the length). Naming it
 * lets one place own the `& 0x3f` mask.
 */
export function to6(value: number): number {
  return ASC2EBC[TABLE6.charCodeAt(value & 0x3f)]!;
}

/**
 * XOR of every byte, masked to 6 bits.
 *
 * ft_cut.c:550-554, the local->host frame checksum:
 *
 *     cs = 0;
 *     for (i = 0; i < count; i++) {
 *         cs ^= ea_buf[O_UP_DATA + i].ec;
 *     }
 *     ctlr_add(O_UP_CSUM, asc2ebc0[(int)table6[cs & 0x3f]], 0);
 *
 * Returns the RAW 6-bit value; the caller encodes it with `to6` when writing it
 * into a frame. Splitting those apart keeps this function testable by hand and
 * lets the host->local direction reuse it to verify the checksum the host sent
 * (which the design doc has us trace but never treat as fatal, since x3270
 * never even reads O_DT_CSUM).
 *
 * Note the mask is applied ONCE at the end, not per byte. Same result, because
 * XOR is bitwise, but it matters that it is the encoded value that is 6 bits.
 */
export function checksum(bytes: Iterable<number>): number {
  let cs = 0;
  for (const b of bytes) cs ^= b & 0xff;
  return cs & 0x3f;
}

/**
 * The quadrant state that persists across bytes within one transfer.
 *
 * WHY AN OBJECT RATHER THAN A MODULE VARIABLE. x3270 uses a file-static
 * `static int quadrant = -1` (ft_cut.c:108), reset per transfer at
 * ft_cut.c:435. That has two consequences we refuse to inherit: two concurrent
 * transfers would corrupt each other's encoding, and tests would be
 * order-dependent -- a test that left the quadrant set would change the output
 * of the next one, which is precisely the bug class this codec is most likely
 * to hide.
 *
 * A class, rather than a state object threaded through free functions, because
 * the state is one small field with exactly two operations on it, and because
 * "one instance per transfer" is then enforced by construction instead of by
 * everyone remembering to pass the right object.
 */
export class CutCodec {
  /**
   * Current quadrant, or -1 for "not yet established".
   *
   * -1 rather than undefined to keep the comparisons `< 0` / `!== OTHER_2`
   * readable against the C, since the retry logic depends on both.
   */
  private quadrant = -1;

  /** Reset to the start-of-transfer state (x3270 does this at ft_cut.c:435). */
  reset(): void {
    this.quadrant = -1;
  }

  /** The current quadrant, or -1 if unset. Exposed for tests and tracing. */
  get currentQuadrant(): number {
    return this.quadrant;
  }

  /**
   * host -> local: decode frame data bytes into file bytes.
   *
   * `upload_convert` (ft_cut.c:134-200) -- which, per the naming trap above, is
   * the direction a user calls a DOWNLOAD (IND$FILE GET). Binary mode only; the
   * ASCII/CRLF and DBCS tails of the C function are deferred.
   *
   * The loop, following the C including its `goto retry`:
   *
   *  1. If no quadrant is established, the byte MUST be a selector
   *     (ft_cut.c:148-158). Found: set it and CONSUME the byte -- the C's
   *     `continue`, so a selector produces no output. Not found: conversion
   *     error.
   *  2. Otherwise the byte must be in 0x40..0xf9 (ft_cut.c:161-164), or it is a
   *     conversion error. Note this check happens only once a quadrant is set,
   *     so a selector below 0x40 could never be rejected by it.
   *  3. Translate to ASCII and find it in ALPHAS (ft_cut.c:167-168). Not there:
   *     drop the quadrant and RETRY THE SAME BYTE (`goto retry`), which will
   *     then read it as a selector.
   *  4. If the quadrant does not map that index -- `quadrant != OTHER_2 && c !=
   *     XLATE_NULL && !conv[quadrant].xlate[ix]` (ft_cut.c:181-182) -- drop the
   *     quadrant and retry likewise. The OTHER_2 exemption exists because a
   *     zero xlate entry normally means "absent", but in OTHER_2 zero is the
   *     genuine data byte NULL.
   *
   *     FINDING: the `c != XLATE_NULL` half of that condition is DEAD CODE in
   *     x3270 as shipped. It can only matter when the quadrant is not OTHER_2,
   *     xlate[ix] is 0, and c is 0xc1 -- but ebc2asc0[0xc1] is 'A', always
   *     ALPHAS index 1, and no non-OTHER_2 quadrant has a zero at index 1
   *     (0xc1, 0x41, --, 0xa0). Ported anyway, since it costs nothing and the
   *     quadrants are data; the test file asserts the unsatisfiability, so we
   *     would learn if that ever changed.
   *  5. Emit `xlate[ix]` (ft_cut.c:188-189).
   *
   * The retry is a loop rather than recursion, and is bounded: each retry sets
   * quadrant to -1, and the -1 branch either consumes the byte or throws, so at
   * most two passes per input byte.
   */
  hostToLocal(input: Uint8Array | readonly number[]): Uint8Array {
    const out: number[] = [];
    const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);

    for (const c of bytes) {
      // The C's `retry:` label (ft_cut.c:147).
      for (;;) {
        if (this.quadrant < 0) {
          // Find the quadrant (ft_cut.c:148-158).
          const q = QUADRANTS.findIndex((quad) => quad.selector === c);
          if (q < 0) {
            throw new CutConversionError(
              `CUT conversion error: 0x${c.toString(16).padStart(2, '0')} is not a quadrant selector`,
            );
          }
          this.quadrant = q;
          break; // the C's `continue`: the selector itself emits nothing
        }

        // Make sure it's in a valid range (ft_cut.c:160-164).
        if (c < 0x40 || c > 0xf9) {
          throw new CutConversionError(
            `CUT conversion error: 0x${c.toString(16).padStart(2, '0')} is outside 0x40..0xf9`,
          );
        }

        // Translate to a quadrant index (ft_cut.c:168-173).
        const ix = ALPHAS.indexOf(String.fromCharCode(EBC2ASC[c]!));
        if (ix === -1) {
          this.quadrant = -1; // try a different quadrant
          continue;
        }

        // See if it's mapped by that quadrant, handling NULLs specially
        // (ft_cut.c:175-186).
        const mapped = QUADRANTS[this.quadrant]!.xlate[ix]!;
        if (this.quadrant !== OTHER_2 && c !== XLATE_NULL && !mapped) {
          this.quadrant = -1; // try a different quadrant
          continue;
        }

        // Map it (ft_cut.c:188-189).
        out.push(mapped);
        break;
      }
    }

    return Uint8Array.from(out);
  }

  /**
   * local -> host: encode file bytes into frame data bytes.
   *
   * `download_convert` (ft_cut.c:307-384) plus `store_download`
   * (ft_cut.c:270-304) -- the direction a user calls an UPLOAD (IND$FILE PUT),
   * which the design doc names as the primary use, since VM/370 has no TCP/IP.
   * Binary mode only.
   *
   * Two paths:
   *
   *  - NULL is special-cased FIRST (ft_cut.c:320-333), before store_download is
   *    ever reached: if the quadrant is not OTHER_2, switch to it and emit its
   *    selector; then emit XLATE_NULL. NULL is in two quadrants' xlate at index
   *    0 (OTHER_2 and quadrant 3), so leaving it to the generic search would
   *    make the encoding depend on which was found first.
   *  - Otherwise `store_download`: if the current quadrant maps the byte, emit
   *    one byte, `asc2ebc0[alphas[ix]]` (ft_cut.c:276-283). Otherwise search
   *    the OTHER quadrants -- skipping the current one, which was just tried
   *    (ft_cut.c:286-300) -- and on a hit emit the selector AND the character,
   *    two bytes, having updated the current quadrant.
   *
   * Output length is therefore data-dependent: 1 byte per input byte while the
   * quadrant holds, 2 when it changes. That statefulness is the whole point of
   * the encoding, and the reason the tests exercise a deliberate mid-buffer
   * quadrant change rather than only single bytes.
   *
   * WHERE WE DIVERGE FROM x3270, deliberately: when no quadrant contains the
   * byte, the C sets `quadrant = -1`, prints "Oops" to stderr and returns 0
   * (ft_cut.c:301-303) -- silently dropping the byte and corrupting the file.
   * We throw. This is safe to make fatal rather than lossy because the branch
   * is unreachable: all 256 byte values are covered by the four tables
   * (verified exhaustively in the test file), so reaching it would mean the
   * tables had been damaged, and a loud failure beats a corrupt upload.
   */
  localToHost(input: Uint8Array | readonly number[]): Uint8Array {
    const out: number[] = [];
    const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);

    for (const c of bytes) {
      // Handle nulls separately (ft_cut.c:320-333).
      if (c === 0) {
        if (this.quadrant !== OTHER_2) {
          this.quadrant = OTHER_2;
          out.push(QUADRANTS[OTHER_2]!.selector);
        }
        out.push(XLATE_NULL);
        continue;
      }
      this.storeByte(c, out);
    }

    return Uint8Array.from(out);
  }

  /**
   * One byte, local->host: `store_download` (ft_cut.c:270-304).
   *
   * Appends to `out` rather than returning a count, since the C's return value
   * exists only to advance an output pointer.
   */
  private storeByte(c: number, out: number[]): void {
    // Quadrant already defined (ft_cut.c:275-283).
    if (this.quadrant >= 0) {
      const ix = QUADRANTS[this.quadrant]!.xlate.indexOf(c);
      if (ix !== -1) {
        out.push(ASC2EBC[ALPHAS.charCodeAt(ix)]!);
        return;
      }
    }

    // Locate a quadrant (ft_cut.c:285-300). `oq` skips the one just tried.
    const oq = this.quadrant;
    for (let q = 0; q < NQ; q++) {
      if (q === oq) continue;
      const ix = QUADRANTS[q]!.xlate.indexOf(c);
      if (ix === -1) continue;
      this.quadrant = q;
      out.push(QUADRANTS[q]!.selector);
      out.push(ASC2EBC[ALPHAS.charCodeAt(ix)]!);
      return;
    }

    // Unreachable: every byte 0x00-0xff is in some quadrant. See the class
    // comment on why this throws where x3270 prints "Oops" and drops the byte.
    this.quadrant = -1;
    throw new CutConversionError(
      `CUT conversion error: no quadrant encodes byte 0x${c.toString(16).padStart(2, '0')}`,
    );
  }
}

/**
 * Convenience wrappers for a whole buffer converted by a fresh codec.
 *
 * Correct ONLY for a complete buffer, because they start from quadrant -1.
 * A multi-frame transfer must hold one CutCodec across all its frames, or a
 * frame boundary would silently reset the quadrant and produce a leading
 * selector the host never asked for -- or, host->local, reject a first byte
 * that is data rather than a selector.
 */
export function hostToLocal(input: Uint8Array | readonly number[]): Uint8Array {
  return new CutCodec().hostToLocal(input);
}

/** See hostToLocal: whole-buffer only. */
export function localToHost(input: Uint8Array | readonly number[]): Uint8Array {
  return new CutCodec().localToHost(input);
}
