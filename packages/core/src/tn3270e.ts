/**
 * TN3270E (RFC 2355): the option-40 subnegotiation state machine and the 5-byte
 * data header codec.
 *
 * PURE BY DESIGN — bytes in, decisions and bytes out, no socket and no session. The
 * negotiation is the part most likely to be wrong, and a pure function can be driven
 * directly with the transcript recorded from real s3270 in
 * docs/superpowers/specs/2026-08-27-stage2b-tn3270e-design.md. That is the same
 * reason queryreply.ts is pure.
 *
 * Design doc: docs/superpowers/specs/2026-08-27-stage2b-tn3270e-design.md
 * Plan:       docs/superpowers/plans/2026-08-27-stage2b-tn3270e.md
 */
import { Tn3270eDataType } from './constants.js';

/**
 * RFC 2355 §8.1: DATA-TYPE, REQUEST-FLAG, RESPONSE-FLAG, then a 2-byte SEQ-NUMBER.
 * x3270 calls the same number EH_SIZE (include/tn3270e.h).
 */
export const TN3270E_HEADER_BYTES = 5;

export interface Tn3270eHeader {
  dataType: number;
  requestFlag: number;
  responseFlag: number;
  seq: number;
}

/**
 * Build the true header bytes.
 *
 * DELIBERATELY DOES NOT ESCAPE 0xFF. RFC 2355 §8.1.4 requires that a 0xff inside
 * SEQ-NUMBER be doubled — "this is standard IAC escaping" — and it will be, by
 * doubleIac() in telnet.ts, which every outbound record already passes through.
 * Escaping here as well would double it twice, and would also mangle any record
 * whose 3270 payload happens to contain a 0xff. Prepend this to the payload and
 * hand the single buffer to sendRecord(), and the requirement is met by
 * construction rather than by a second escaping implementation that could drift out
 * of step with the first. The end-to-end behaviour is pinned at the session level.
 *
 * The `& 0xff` on each field is INTENT, NOT PROTECTION: `Uint8Array.of` already
 * truncates mod 256, established by deleting a mask and watching the test still
 * pass. They are kept because they say what the field is, and because they become
 * load-bearing the moment this is rewritten to build a `number[]` or write through a
 * DataView — neither of which truncates for you.
 */
export function encodeHeader(h: Tn3270eHeader): Uint8Array {
  return Uint8Array.of(
    h.dataType & 0xff,
    h.requestFlag & 0xff,
    h.responseFlag & 0xff,
    (h.seq >> 8) & 0xff,
    h.seq & 0xff,
  );
}

/**
 * Read a header off the front of an inbound record, or null if the record cannot
 * hold one.
 *
 * A record of exactly five bytes is valid and carries no data: RFC 2355 §8 permits
 * `<TN3270E Header><IAC EOR>`, which is how PRINT-EOJ arrives and how a bare
 * RESPONSE could. So the test is `< TN3270E_HEADER_BYTES`, not `<=`.
 *
 * Returns null rather than throwing. Four bytes is not a truncated message we can
 * salvage, it is a malformed one, and the caller should trace and drop it: a client
 * cannot correct a host, and an exception here would surface to the operator as a
 * program check the host never caused.
 */
export function decodeHeader(record: Uint8Array): Tn3270eHeader | null {
  if (record.length < TN3270E_HEADER_BYTES) return null;
  return {
    dataType: record[0]!,
    requestFlag: record[1]!,
    responseFlag: record[2]!,
    seq: (record[3]! << 8) | record[4]!,
  };
}

/**
 * True only for the data type that carries a 3270 datastream we can execute.
 *
 * This is the gate that keeps a bind image, an unbind reason code or NVT text out of
 * the 3270 executor, where any of them would produce a spurious program check
 * attributable to nothing the host did wrong. SCS-DATA is excluded too: it is SNA
 * Character Stream, which belongs to the printer session rather than here.
 */
export function carriesDatastream(dataType: number): boolean {
  return dataType === Tn3270eDataType.DATA_3270;
}
