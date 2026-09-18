/**
 * BIND and UNBIND: the SNA session-management RUs a TN3270E host forwards as data
 * types BIND-IMAGE (0x03) and UNBIND (0x04).
 *
 * PURE. No session state, no I/O, no timers -- the caller owns all of that, exactly
 * as `tn3270e.ts` owns the negotiation state machine without owning a socket. That is
 * what lets every offset and every boundary below be tested against a byte array.
 *
 * BIND IS THE SECOND CHANNEL BY WHICH A HOST DICTATES GEOMETRY, the other being Query
 * Reply. That is the whole reason it matters here and not merely as trace decoration.
 *
 * Design doc: docs/superpowers/specs/2026-09-17-bind-image-and-bind-unbind-design.md
 * Plan:       docs/superpowers/plans/2026-09-17-bind-image-and-bind-unbind.md
 */

import { MODEL_2 } from './constants.js';
import { cp037 } from './codepage.js';

/** A BIND request unit begins with this. Anything else is not a BIND. */
export const BIND_RU = 0x31;

/** Byte offsets within the BIND RU, from x3270's include/3270ds.h:433-441. */
export const BIND_OFF = {
  MAXRU_SEC: 10,
  MAXRU_PRI: 11,
  RD: 20,
  CD: 21,
  RA: 22,
  CA: 23,
  SSIZE: 24,
  PLU_NAME_LEN: 27,
  PLU_NAME: 28,
} as const;

/**
 * A LENGTH CAP, not an offset -- x3270's include/3270ds.h:442 names it
 * `BIND_PLU_NAME_MAX`, deliberately dropping the `_OFF_` infix every true offset
 * above carries, which is why it is not a member of `BIND_OFF`. A host may declare a
 * longer name than this and x3270 truncates rather than refusing.
 */
export const BIND_PLU_NAME_MAX = 8;

/**
 * Decode a maximum-RU byte (x3270's `maxru`, Common/telnet.c:2440-2446).
 *
 * MANTISSA-EXPONENT, not an integer: the high bit doubles as a validity flag and as
 * the top bit of a 4-bit mantissa spanning bits 4-7 (so `(c >> 4) & 0x0f` is always
 * >= 8 on any byte that reaches the multiply), and bits 0-3 are the exponent, giving
 * `mantissa * 2^exponent`. A byte with the high bit clear means "not specified" and
 * decodes to 0 -- which is why this returns a number rather than throwing on it.
 *
 * The `& 0x0f` on the shifted mantissa is transcription fidelity with x3270, not a
 * behavioural guard: `c >> 4` on a byte (c <= 0xff) is already <= 15, so the mask
 * cannot change the result for any of the 256 possible inputs. Kept so a reader
 * comparing the two sources finds them identical character for character.
 */
export function maxRu(c: number): number {
  if (!(c & 0x80)) return 0;
  return ((c >> 4) & 0x0f) * (1 << (c & 0x0f));
}

/**
 * Geometry a BIND asked for.
 *
 * `alternate: 'caller'` is size code 0x03, which means "model-2 default, and the
 * CLIENT's own alternate". A pure function cannot know the client's model, and
 * resolving it here by importing a default would silently turn every 0x03 BIND into a
 * model 2 -- so the caller substitutes and the type makes forgetting impossible.
 */
export interface BindDims {
  readonly defaultRows: number;
  readonly defaultCols: number;
  readonly alternate: { readonly rows: number; readonly cols: number } | 'caller';
}

export interface BindImage {
  /** EBCDIC-decoded primary LU name: WHICH APPLICATION you were just connected to. */
  readonly pluName: string;
  readonly maxRuSecondary: number;
  readonly maxRuPrimary: number;
  /** Byte 24 verbatim, kept so a trace can report a code we do not implement. */
  readonly sizeCode: number;
  /** Absent when the size code is one we have no table entry for. */
  readonly dims?: BindDims;
}

/**
 * Parse a BIND RU (x3270's `process_bind`, Common/telnet.c:2449).
 *
 * Returns null when this is not a BIND at all. EVERY OTHER FIELD IS OPTIONAL and
 * length-guarded, because a short BIND is malformed rather than truncated and there is
 * nothing to salvage -- the same contract as `decodeHeader`, and for the same reason:
 * a client cannot correct a host, and throwing here would surface to the operator as a
 * program check the host never caused.
 *
 * NOTE THE COMPARISON: x3270 guards with `buflen > OFFSET`, not `>=`, so a buffer whose
 * LAST byte is at OFFSET is treated as not reaching it. Preserved exactly, because the
 * boundary is what a fixture from a real host will land on.
 */
export function parseBind(body: Uint8Array): BindImage | null {
  if (body.length < 1 || body[0] !== BIND_RU) return null;

  const maxRuSecondary = body.length > BIND_OFF.MAXRU_SEC
    ? maxRu(body[BIND_OFF.MAXRU_SEC]!) : 0;
  const maxRuPrimary = body.length > BIND_OFF.MAXRU_PRI
    ? maxRu(body[BIND_OFF.MAXRU_PRI]!) : 0;

  const sizeCode = body.length > BIND_OFF.SSIZE ? body[BIND_OFF.SSIZE]! : 0;
  const dims = body.length > BIND_OFF.SSIZE ? decodeDims(body, sizeCode) : undefined;

  return {
    pluName: decodePluName(body),
    maxRuSecondary,
    maxRuPrimary,
    sizeCode,
    ...(dims === undefined ? {} : { dims }),
  };
}

/** The size-code table, Common/telnet.c:2485-2521. */
function decodeDims(body: Uint8Array, sizeCode: number): BindDims | undefined {
  const at = (off: number): number => body[off] ?? 0;
  switch (sizeCode) {
    case 0x00:
    case 0x02:
      return {
        defaultRows: MODEL_2.rows, defaultCols: MODEL_2.cols,
        alternate: { rows: MODEL_2.rows, cols: MODEL_2.cols },
      };
    case 0x03:
      return {
        defaultRows: MODEL_2.rows, defaultCols: MODEL_2.cols,
        alternate: 'caller',
      };
    case 0x7e:
      // ONE pair, used for BOTH sizes. Bytes 22-23 are deliberately not read.
      return {
        defaultRows: at(BIND_OFF.RD), defaultCols: at(BIND_OFF.CD),
        alternate: { rows: at(BIND_OFF.RD), cols: at(BIND_OFF.CD) },
      };
    case 0x7f:
      return {
        defaultRows: at(BIND_OFF.RD), defaultCols: at(BIND_OFF.CD),
        alternate: { rows: at(BIND_OFF.RA), cols: at(BIND_OFF.CA) },
      };
    default:
      // x3270 clears bind_state here: a code we do not know is not a geometry we may
      // guess at. The BIND is still valid; it simply carries no dimensions.
      return undefined;
  }
}

/**
 * The primary LU name: WHICH APPLICATION the host has just connected us to.
 *
 * Four guards, each matching x3270 (Common/telnet.c:2562-2582) and each with a
 * distinct failure it prevents:
 *  - the buffer must REACH the length byte (`buflen > BIND_OFF_PLU_NAME_LEN`, :2562);
 *  - a declared length over 8 is CLAMPED, as x3270 clamps it, not refused (:2564-2565);
 *  - a declared length of 0 means no name, not an empty one followed by stray bytes
 *    (the `namelen > 0` half of :2567's `&&`);
 *  - a declared length that does not leave enough buffer for the name yields nothing
 *    at all (the other half of :2567's `&&`) -- see the note below for the exact bound
 *    used here, which is NOT x3270's literal one.
 *
 * DELIBERATE DEPARTURE FROM x3270's LITERAL BOUND: x3270's C guard is
 * `buflen > BIND_OFF_PLU_NAME + namelen` -- STRICT greater-than. Copying `namelen`
 * bytes starting at offset 28 only touches indices up to `28 + namelen - 1`, so
 * `buflen >= 28 + namelen` (one byte less than x3270 demands) is everything the copy
 * itself needs; x3270's `>` refuses a buffer that ends exactly on the name's last
 * byte even though every byte the copy would read is present and valid. That reads as
 * an off-by-one bug in x3270 itself, and here it is NOT reproduced: this file's own
 * "decodes EBCDIC" test (bind.test.ts, `withName` with its default `declaredLen`)
 * builds a buffer sized to exactly `PLU_NAME + bytes.length` -- i.e. it sits exactly on
 * this boundary -- and is required to succeed. Matching x3270's `>` verbatim would make
 * that mandatory test fail, so the bound used below is `>=`
 * (`body.length < BIND_OFF.PLU_NAME + namelen` to reject), the logically-correct one,
 * not x3270's. See bind.test.ts's dedicated boundary test for the case this documents.
 */
function decodePluName(body: Uint8Array): string {
  if (body.length <= BIND_OFF.PLU_NAME_LEN) return '';
  let namelen = body[BIND_OFF.PLU_NAME_LEN]!;
  if (namelen > BIND_PLU_NAME_MAX) namelen = BIND_PLU_NAME_MAX;
  if (namelen === 0) return '';
  if (body.length < BIND_OFF.PLU_NAME + namelen) return '';
  const slice = body.subarray(BIND_OFF.PLU_NAME, BIND_OFF.PLU_NAME + namelen);
  return cp037.decode(slice);
}
