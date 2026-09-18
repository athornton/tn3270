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
