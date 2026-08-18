import { Sfid, PID_QUERY, ReadPartitionType } from '../constants.js';

/**
 * Structured field framing for the inbound (host to us) direction.
 *
 * A Write Structured Field record carries one or more structured fields, each
 * `L L SFID <params...>` where the 16-bit L INCLUDES the two length bytes:
 * GA23-0059 p. 5-5 (pages.txt:4399-4400) "Each structured field contains a
 * 2-byte length field. This field defines the length of / the structured field
 * (including the length bytes)."
 *
 * The bytes here have already been un-doubled by the telnet layer
 * (telnet.ts:122), so a 0xFF in a parameter is a single 0xFF.
 */

export class SfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SfParseError';
  }
}

export type StructuredField =
  /** Read Partition. We answer TYPE=QUERY with PID=0xFF; see stage 2a spec. */
  | { kind: 'readPartition'; pid: number; type: number }
  /** Any SFID we do not implement: counted and traced, never fatal. */
  | { kind: 'unknownSf'; sfid: number; data: Uint8Array };

/**
 * Smallest legal structured field: two length bytes and a one-byte SFID.
 *
 * GA23-0059 p. 5-5 (pages.txt:4409-4412): "Except for the use of a Length
 * parameter value of zero, a structured field with a / one-byte type parameter
 * will be rejected if the Length field value is less than / three." Every SFID
 * we recognise is one byte — Read Partition's is X'01' at byte 2
 * (pages.txt:6345) — so three is our minimum. The manual's four-byte minimum
 * applies to the two-byte type fields we do not implement, e.g. Begin/End of
 * File, whose table row reads "2-3 SFID X' OF85' Identifies this structured
 * field as" (pages.txt:4683; the OCR renders the leading zero as the letter O
 * and inserts a space, so that field is really X'0F85').
 */
const MIN_SF_LENGTH = 3;

export function parseStructuredFields(payload: Uint8Array): StructuredField[] {
  const fields: StructuredField[] = [];
  let i = 0;

  while (i < payload.length) {
    if (i + 2 > payload.length) {
      throw new SfParseError(
        `structured field truncated: ${payload.length - i} byte(s) left, need at least 2 for the length`,
      );
    }
    const declared = (payload[i]! << 8) | payload[i + 1]!;

    // A zero length is legal and means "this field runs to the end of the
    // transmission". GA23-0059 p. 5-5 (pages.txt:4402-4408): "A length of zero
    // on an outbound or / inbound 3270DS indicates one of the following: ...
    // The length of the structured field should be determined using the end of
    // the / transmission (tor SNA, transmission =chain)." [The "tor" is OCR
    // damage for "for".] x3270 does exactly this substitution, sf.c:138-140:
    //     if (fieldlen == 0) {
    //         fieldlen = buflen;
    //     }
    // Resolving it to the remaining length here also makes the advance below
    // non-zero, so the loop still terminates. Note this is why the substitution
    // must come BEFORE the minimum check: 00 00 with nothing after it resolves
    // to 2, which then fails as being below the minimum, matching the manual's
    // "sending only the Length field (i.e. 0000) ... is invalid"
    // (pages.txt:4413).
    const length = declared === 0 ? payload.length - i : declared;

    // An undersized length must be rejected BEFORE it is used to advance, or
    // the loop makes no progress.
    if (length < MIN_SF_LENGTH) {
      throw new SfParseError(`structured field length ${length} below the minimum ${MIN_SF_LENGTH}`);
    }
    if (i + length > payload.length) {
      throw new SfParseError(
        `structured field length ${length} runs past the end of a ${payload.length}-byte payload`,
      );
    }

    const sfid = payload[i + 2]!;
    // Parameters only: excludes the length bytes and the SFID.
    const params = payload.subarray(i + MIN_SF_LENGTH, i + length);

    if (sfid === Sfid.READ_PARTITION) {
      // PID at byte 3 and TYPE at byte 4 are both mandatory, so the field is at
      // least 5 bytes long — GA23-0059 p. 5-51 (pages.txt:6344-6351) gives the
      // format as L(0-1) SFID(2) PIO(3) TYPE(4), and x3270 rejects a shorter
      // one at sf.c:221 `if (buflen < 5)`. ["PIO" is OCR damage for "PID".]
      if (params.length < 2) {
        throw new SfParseError(`Read Partition needs PID and TYPE, got ${params.length} byte(s)`);
      }
      // PID is RECORDED, not assumed: a non-0xFF value is a read against a real
      // partition, which we do not support, and the trace must show the
      // difference rather than silently treating it as a query.
      fields.push({ kind: 'readPartition', pid: params[0]!, type: params[1]! });
    } else {
      fields.push({ kind: 'unknownSf', sfid, data: Uint8Array.from(params) });
    }

    i += length;
  }

  return fields;
}

/**
 * True for the one request we answer: a Query against the query PID.
 *
 * Both halves matter. A non-query PID is a read against a real partition, which
 * we do not support, and TYPE 0x03 is a Query List whose subsetting rules we
 * have not implemented — answering either with our capabilities would be wrong.
 */
export function isQueryRequest(sf: StructuredField): boolean {
  return sf.kind === 'readPartition'
    && sf.pid === PID_QUERY
    && sf.type === ReadPartitionType.QUERY;
}
