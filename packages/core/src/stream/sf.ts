import { Sfid, PID_QUERY, ReadPartitionType, ReqTyp, REQTYP_MASK } from '../constants.js';

/**
 * Structured field framing for the OUTBOUND direction — outbound is the
 * manual's word for host-to-terminal, not ours-to-host. GA23-0059 p. 5-5:
 * "The outbound structured fields are described under "Outbound Structured
 * Fields" / on page 5-11" (pages.txt:4414-4415), and that section's list
 * includes "01nn Read Partition" (pages.txt:4419), the field parsed here. The
 * INBOUND structured fields are the ones we send; see the note on
 * Sfid.QUERY_REPLY in constants.ts, which uses "inbound" in that same sense.
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

/**
 * The extra parameters a Query List (TYPE=0x03) carries and a Query does not.
 *
 * GA23-0059 p. 5-52 (pages.txt:6371-6373) draws the line: for TYPE "X'02' The
 * structured field ends after byte 4", while for "X'03' Byte 5 is a flag byte.
 * Bytes 6-n contain the QCODEs of the / Query Replies being requested." So this
 * is present for exactly one TYPE, which is why it is a separate optional member
 * rather than two more always-present numbers on readPartition.
 */
export interface QueryListParams {
  /**
   * REQTYP, already MASKED to bits 0-1 — compare against ReqTyp, not the raw
   * byte. See the note on REQTYP_MASK in constants.ts for why we mask where
   * x3270 does not.
   */
  readonly reqtyp: number;
  /**
   * QCODEs from byte 6 on, in the order the host sent them. MAY BE EMPTY, and
   * an empty list is meaningful rather than degenerate: under REQTYP=QCODE List
   * it selects the Null Query Reply (p. 5-52, pages.txt:6377-6379, "If the value
   * is B'00' but no list is present (count field is valid), a Null Query Reply
   * is returned"; x3270 sf.c:258-262 `if (buflen < 7) ... do_query_reply(
   * QR_NULL)`).
   *
   * Duplicates are NOT removed here. They are legal — "It is not invalid for a
   * particular QCODE to appear / more than once in the list" (pages.txt:8540-
   * 8541, p. 6-20) — and de-duplication belongs where the reply is built, since
   * the rule is about the REPLIES ("the 3270 device or / workstation does not
   * return duplicate Query Replies", pages.txt:8542-8544), not about the
   * request. Keeping the raw order also keeps the trace faithful.
   */
  readonly qcodes: readonly number[];
}

export type StructuredField =
  /**
   * Read Partition. We answer TYPE=QUERY and TYPE=QUERY_LIST, both with
   * PID=0xFF; see the stage 2a spec and the Query List work that followed it.
   */
  | { kind: 'readPartition'; pid: number; type: number; queryList?: QueryListParams }
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
        `structured field at offset ${i} truncated: ${payload.length - i} byte(s) left, need at least 2 for the length`,
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
    // non-zero, so the loop still terminates.
    //
    // The substitution MUST stay ahead of the minimum check below, and the case
    // that proves it is a LEGAL zero-length field, not an illegal one: a Query
    // sent as `00 00 01 ff 02` at the end of a transmission resolves to 5 and
    // parses, but a minimum check applied to the declared 0 would reject it and
    // we would hang on the very request this stage exists to answer. (A bare
    // `00 00` is rejected under either ordering, so it does NOT demonstrate the
    // constraint — do not use it to convince yourself a reordering is safe.)
    const length = declared === 0 ? payload.length - i : declared;

    // An undersized length must be rejected BEFORE it is used to advance, or
    // the loop makes no progress.
    if (length < MIN_SF_LENGTH) {
      // Report the declared bytes when they were zero: `length` is synthesised
      // in that case, and an operator grepping a trace for it would find
      // nothing on the wire.
      throw new SfParseError(
        declared === 0
          ? `zero-length structured field at offset ${i} resolved to ${length} byte(s), below the minimum ${MIN_SF_LENGTH}`
          : `structured field at offset ${i} has length ${length}, below the minimum ${MIN_SF_LENGTH}`,
      );
    }
    if (i + length > payload.length) {
      throw new SfParseError(
        `structured field at offset ${i} has length ${length}, which runs past the end of a ${payload.length}-byte payload`,
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
        throw new SfParseError(
          `Read Partition at offset ${i} needs PID and TYPE, got ${params.length} byte(s)`,
        );
      }
      const pid = params[0]!;
      const type = params[1]!;

      // A Query List carries REQTYP at byte 5 and an optional QCODE list from
      // byte 6. Both live in `params`, which starts at byte 3, so REQTYP is
      // params[2] and the list is params[3...]. Off-by-three here would read the
      // PID as a request type.
      //
      // MISSING REQTYP IS AN ERROR, not a defaulted zero. x3270 rejects it
      // explicitly (sf.c:252-255):
      //
      //     if (buflen < 6) {
      //         trace_ds("error: missing request type\n");
      //         return PDS_BAD_CMD;
      //     }
      //
      // and its buflen counts from byte 0, so `< 6` means "no byte 5" — the same
      // condition as params.length < 3 here. Defaulting to B'00' would be worse
      // than rejecting: QCODE List with an absent list means Null Query Reply,
      // so we would answer a malformed request with a positive-looking "we
      // support nothing" that the host would believe.
      //
      // Note this check does NOT apply to a plain Query. p. 5-52 says TYPE=0x02
      // "ends after byte 4" (pages.txt:6371), so demanding byte 5 of a Query
      // would reject the very request MVS/TSO sends and that path is live-
      // verified. Hence the guard sits inside the QUERY_LIST branch.
      if (type === ReadPartitionType.QUERY_LIST) {
        if (params.length < 3) {
          throw new SfParseError(
            `Read Partition (Query List) at offset ${i} needs REQTYP at byte 5, `
            + `got ${params.length + 3} byte(s) of field`,
          );
        }
        fields.push({
          kind: 'readPartition',
          pid,
          type,
          queryList: {
            // Masked to bits 0-1 at the PARSE boundary so no consumer has to
            // remember to. See REQTYP_MASK in constants.ts.
            reqtyp: params[2]! & REQTYP_MASK,
            // Array.from, not subarray: a Uint8Array view would alias the
            // caller's record buffer, and these values outlive the parse in the
            // ExecuteResult the session acts on.
            qcodes: Array.from(params.subarray(3)),
          },
        });
      } else {
        // PID is RECORDED, not assumed: a non-0xFF value is a read against a
        // real partition, which we do not support, and the trace must show the
        // difference rather than silently treating it as a query.
        //
        // No `queryList` key at all rather than an explicit undefined, which
        // exactOptionalPropertyTypes rejects and which would also make the
        // existing toEqual assertions on this shape fail.
        fields.push({ kind: 'readPartition', pid, type });
      }
    } else {
      fields.push({ kind: 'unknownSf', sfid, data: Uint8Array.from(params) });
    }

    i += length;
  }

  return fields;
}

/**
 * True for a PLAIN Query (TYPE=0x02) against the query PID — and nothing else.
 *
 * DELIBERATELY STILL NARROW now that Query List is implemented. This predicate
 * does not mean "a request we answer"; it means one specific request type, and
 * the caller distinguishes the two because their replies differ. Widening it to
 * match TYPE=0x03 would make a Query List take the plain-Query branch and send
 * the full capability set regardless of REQTYP — the exact bug the subsetting
 * code exists to avoid, and one that would pass every plain-Query test.
 * See queryListRequest below for the other half.
 *
 * A non-query PID still fails here: it is a read against a real partition, which
 * we do not support.
 */
export function isQueryRequest(sf: StructuredField): boolean {
  return sf.kind === 'readPartition'
    && sf.pid === PID_QUERY
    && sf.type === ReadPartitionType.QUERY;
}

/**
 * The Query List parameters if this is one we should answer, else undefined.
 *
 * Returns the PARAMS rather than a boolean so the caller cannot ask "is it a
 * Query List?" and then reach for `.queryList` separately, which under
 * noUncheckedIndexedAccess would need a non-null assertion at every use.
 *
 * The PID check is the same rejection x3270 makes, and it is a REJECTION rather
 * than an ignore — sf.c:248-251:
 *
 *     if (partition != 0xff) {
 *         trace_ds("error: illegal partition\n");
 *         return PDS_BAD_CMD;
 *     }
 *
 * and the manual lists it among the conditions under which "Read Partition is
 * rejected": "The operation type is Query or Query List and the PIO is not
 * X'FF'" (pages.txt:6404; "PIO" is OCR damage for "PID"). Note that covers Query
 * AND Query List with one clause, so both PID checks come from this one line.
 *
 * Undefined for a bad PID rather than throwing, matching isQueryRequest's shape:
 * whether an unanswerable Read Partition is a counted no-op or a program check
 * is the executor's policy decision, not this predicate's. See execute.ts.
 */
export function queryListRequest(sf: StructuredField): QueryListParams | undefined {
  if (sf.kind !== 'readPartition') return undefined;
  if (sf.type !== ReadPartitionType.QUERY_LIST) return undefined;
  if (sf.pid !== PID_QUERY) return undefined;
  // Present for every QUERY_LIST the parser emits — it throws when REQTYP is
  // missing — so this is a type narrowing, not a real branch.
  if (sf.queryList === undefined) return undefined;
  // B'11' is "Reserved" (pages.txt:6361) and there is no defined behaviour for
  // it, so it is not a request we can answer. Screened HERE, at the same place
  // as the bad-PID case, so the caller's "unanswerable" branch handles both
  // alike and no invalid REQTYP can reach the reply builder.
  //
  // This ordering is load-bearing for session robustness, not just tidiness:
  // selectCapabilities throws a RangeError on a reserved REQTYP, and
  // session.ts handleRecord deliberately RETHROWS anything that is not a
  // ParseError/AddressError/ExecuteError as "our own bug" — which tears the
  // connection down. A host sending B'11' must not be able to do that. Rejecting
  // it before it becomes an sfReply keeps that throw as the unreachable
  // assertion it is meant to be.
  if (!isKnownReqtyp(sf.queryList.reqtyp)) return undefined;
  return sf.queryList;
}

/** Is this one of the three defined REQTYP values? Expects a masked value. */
function isKnownReqtyp(reqtyp: number): boolean {
  return reqtyp === ReqTyp.QCODE_LIST
    || reqtyp === ReqTyp.EQUIVALENT
    || reqtyp === ReqTyp.ALL;
}
