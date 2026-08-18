import { describe, it, expect } from 'vitest';
import {
  parseStructuredFields, isQueryRequest, queryListRequest, SfParseError,
  type StructuredField,
} from '../src/stream/sf.js';
import { ReqTyp } from '../src/constants.js';

describe('structured field framing', () => {
  it('parses the Read Partition Query that TSO sends', () => {
    // From packages/fixtures/x3270/tso-query-reply.txt, after the telnet layer
    // has un-doubled ff ff -> ff. L=5 covers 00 05 01 ff 02.
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02));
    expect(fields).toEqual([
      { kind: 'readPartition', pid: 0xff, type: 0x02 },
    ]);
  });

  it('parses several structured fields in one payload', () => {
    // The second field is a Query List, which needs REQTYP at byte 5 and so is
    // 6 bytes, not 5. It read `00 05 01 ff 03` before Query List was
    // implemented, and that input is now correctly REJECTED for lacking REQTYP
    // — see the dedicated test below. Lengthened rather than swapped for
    // another Query so this still covers two DIFFERENT field shapes back to
    // back, which is what would catch an advance computed from the wrong one.
    const fields = parseStructuredFields(Uint8Array.of(
      0x00, 0x05, 0x01, 0xff, 0x02,
      0x00, 0x06, 0x01, 0xff, 0x03, 0x80,
    ));
    expect(fields).toHaveLength(2);
    expect(fields[1]).toEqual({
      kind: 'readPartition',
      pid: 0xff,
      type: 0x03,
      queryList: { reqtyp: 0x80, qcodes: [] },
    });
  });

  it('keeps an unrecognised SFID as an opaque field rather than failing', () => {
    // A host may send anything; an unknown SF is a logged no-op, not an error.
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x40, 0xaa, 0xbb));
    expect(fields).toEqual([
      { kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of(0xaa, 0xbb) },
    ]);
  });

  it('records the PID rather than assuming the query value', () => {
    // A read against a real partition, which we do not support. It must be
    // distinguishable in the trace from the query case.
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0x00, 0x02));
    expect(fields[0]).toEqual({ kind: 'readPartition', pid: 0x00, type: 0x02 });
  });

  it('rejects a zero length, which would otherwise loop forever', () => {
    // THE nasty case for a naive loop, which reads L=0 as "advance by zero" and
    // hangs. We reject this input, but NOT because L=0 is illegal: per
    // GA23-0059 p. 5-5 a zero length means the field runs to the end of the
    // transmission (see the 'runs to the end of the payload' test below). Here
    // that leaves 00 00 01 -> a 3-byte Read Partition with no PID or TYPE,
    // which is what fails. See the tests below for L=0 rejected on length.
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x00, 0x01)))
      .toThrow(SfParseError);
  });

  it('rejects a length shorter than the two length bytes plus an SFID', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x02, 0x01)))
      .toThrow(SfParseError);
  });

  it('rejects a length running past the end of the payload', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x20, 0x01, 0xff, 0x02)))
      .toThrow(SfParseError);
  });

  it('rejects a trailing partial field', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02, 0x00)))
      .toThrow(SfParseError);
  });

  it('rejects a Read Partition too short to hold PID and TYPE', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x04, 0x01, 0xff)))
      .toThrow(SfParseError);
  });

  it('accepts an empty payload as no structured fields', () => {
    expect(parseStructuredFields(Uint8Array.of())).toEqual([]);
  });

  it('reads a length above 255, so both length bytes are used', () => {
    // L=0x0104 = 260: two length bytes, an SFID, and 257 parameter bytes. Every
    // other test here has 0x00 in the high position, so a parser that ignored
    // payload[i] entirely would pass all of them.
    const payload = new Uint8Array(260);
    payload[0] = 0x01; payload[1] = 0x04; payload[2] = 0x40;
    const fields = parseStructuredFields(payload);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ kind: 'unknownSf', sfid: 0x40 });
    expect((fields[0] as { data: Uint8Array }).data.length).toBe(257);
  });
});

describe('a zero length runs to the end of the payload', () => {
  // GA23-0059 p. 5-5 (pages.txt:4402-4408): "A length of zero on an outbound or
  // inbound 3270DS indicates one of the following: ... The length of the
  // structured field should be determined using the end of the transmission
  // (tor SNA, transmission =chain)." [OCR: "tor" for "for"]. x3270 implements
  // exactly this: sf.c:138-140 `if (fieldlen == 0) { fieldlen = buflen; }`.

  it('reads a Read Partition Query whose length is zero', () => {
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x00, 0x01, 0xff, 0x02));
    expect(fields).toEqual([
      { kind: 'readPartition', pid: 0xff, type: 0x02 },
    ]);
  });

  it('consumes the whole remainder, so it terminates the loop', () => {
    // The trailing bytes are swallowed by the zero-length field rather than
    // being read as a second field, and the loop ends.
    const fields = parseStructuredFields(Uint8Array.of(
      0x00, 0x05, 0x01, 0xff, 0x02,
      0x00, 0x00, 0x40, 0xaa, 0xbb, 0xcc,
    ));
    expect(fields).toEqual([
      { kind: 'readPartition', pid: 0xff, type: 0x02 },
      { kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of(0xaa, 0xbb, 0xcc) },
    ]);
  });

  it('rejects a bare zero length, which carries no SFID', () => {
    // p. 5-5 (pages.txt:4413): "Thus, sending only the Length field (i.e.
    // 0000), as a zero length structured field is invalid."
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x00)))
      .toThrow(SfParseError);
  });
});

describe('Read Partition Query List parameters', () => {
  it('parses the real Query List captured from VM/370 MECAFF', () => {
    // THE REQUEST THAT UNBLOCKS VM/CMS FILE TRANSFER, captured live and shown
    // here after the telnet layer has un-doubled the 0xFF PID:
    //
    //   00 07 01 ff 03 80 00
    //   ^^^^^ L=7
    //         ^^ SFID 01 = Read Partition
    //            ^^ PID ff = query operations
    //               ^^ TYPE 03 = Query List
    //                  ^^ REQTYP 80 = B'10' All
    //                     ^^ QCODE 00
    //
    // Note the QCODE list is [0x00], NOT empty: L=7 leaves one byte at offset 6.
    // 0x00 is not a QCODE we support (nor any in Table 6-1), which makes this
    // request a live proof that REQTYP=All must ignore the list — intersecting
    // would match nothing and send a Null Query Reply, and MECAFF would learn
    // nothing about the terminal.
    const fields = parseStructuredFields(
      Uint8Array.of(0x00, 0x07, 0x01, 0xff, 0x03, 0x80, 0x00));
    expect(fields).toEqual([{
      kind: 'readPartition',
      pid: 0xff,
      type: 0x03,
      queryList: { reqtyp: ReqTyp.ALL, qcodes: [0x00] },
    }]);
  });

  it('parses a QCODE list of several codes in wire order', () => {
    const fields = parseStructuredFields(
      Uint8Array.of(0x00, 0x09, 0x01, 0xff, 0x03, 0x00, 0x81, 0xa6, 0x80));
    expect(fields[0]).toEqual({
      kind: 'readPartition',
      pid: 0xff,
      type: 0x03,
      queryList: { reqtyp: ReqTyp.QCODE_LIST, qcodes: [0x81, 0xa6, 0x80] },
    });
  });

  it('accepts an empty QCODE list, which is the Null Query Reply trigger', () => {
    // L=6 stops right after REQTYP, so bytes 6-n are absent. p. 5-52
    // (pages.txt:6377-6379): "If the value / is B'00' but no list is present
    // (count field is valid), a Null Query Reply is / returned." So this MUST
    // parse — rejecting it would turn a defined case into a program check.
    // x3270 likewise parses it and answers, sf.c:258-262 `if (buflen < 7) ...
    // do_query_reply(QR_NULL)`.
    const fields = parseStructuredFields(
      Uint8Array.of(0x00, 0x06, 0x01, 0xff, 0x03, 0x00));
    expect(fields[0]).toEqual({
      kind: 'readPartition',
      pid: 0xff,
      type: 0x03,
      queryList: { reqtyp: ReqTyp.QCODE_LIST, qcodes: [] },
    });
  });

  it('rejects a Query List with no REQTYP byte', () => {
    // x3270 sf.c:252-255: `if (buflen < 6) { trace_ds("error: missing request
    // type\n"); return PDS_BAD_CMD; }`. Defaulting the absent byte to B'00'
    // would answer a malformed request with a Null Query Reply, i.e. a
    // positive-looking "we support nothing".
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x03)))
      .toThrow(SfParseError);
  });

  it('does not demand a REQTYP byte of a plain Query', () => {
    // THE REGRESSION GUARD for the check above. p. 5-52: TYPE "X'02' The
    // structured field ends after byte 4" (pages.txt:6371). A missing-REQTYP
    // check applied to every Read Partition would reject the request MVS/TSO
    // sends, which is a live-verified path.
    expect(parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02)))
      .toEqual([{ kind: 'readPartition', pid: 0xff, type: 0x02 }]);
  });

  it('masks REQTYP to bits 0-1 and keeps the QCODE list intact', () => {
    // REQTYP is "bits 0-1 of byte 5" (pages.txt:8508) with "2-7 ... Reserved"
    // (pages.txt:6356). 0x83 is B'10' with two reserved bits set, so it must
    // read as ALL. x3270 compares the raw byte and would reject this
    // (sf.c:301-303 default), which is a deliberate difference — see the note on
    // REQTYP_MASK in constants.ts.
    const fields = parseStructuredFields(
      Uint8Array.of(0x00, 0x07, 0x01, 0xff, 0x03, 0x83, 0x81));
    expect(fields[0]).toMatchObject({
      queryList: { reqtyp: ReqTyp.ALL, qcodes: [0x81] },
    });
  });

  it('does not alias the caller record, so a later mutation cannot corrupt it', () => {
    // The QCODE list outlives the parse: it travels on the ExecuteResult that
    // session.ts acts on. A Uint8Array subarray would be a VIEW of the host
    // record, so reusing that buffer would silently rewrite the request we are
    // about to answer.
    const record = Uint8Array.of(0x00, 0x07, 0x01, 0xff, 0x03, 0x00, 0x81);
    const fields = parseStructuredFields(record);
    record[6] = 0x86;
    expect(fields[0]).toMatchObject({ queryList: { qcodes: [0x81] } });
  });
});

describe('isQueryRequest', () => {
  it('accepts a Query against the query PID', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0xff, type: 0x02 })).toBe(true);
  });

  it('still rejects a Query List now that Query List is implemented', () => {
    // NOT an obsolete test. This predicate means "a plain Query", and execute.ts
    // branches on it to choose the reply. If it started matching TYPE=0x03, a
    // Query List would send the full capability set whatever its REQTYP said —
    // and every plain-Query test would still pass. See the note on
    // isQueryRequest in stream/sf.ts.
    expect(isQueryRequest({
      kind: 'readPartition',
      pid: 0xff,
      type: 0x03,
      queryList: { reqtyp: ReqTyp.ALL, qcodes: [] },
    })).toBe(false);
  });

  it('rejects a read against a real partition', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0x00, type: 0x02 })).toBe(false);
  });

  it('rejects an unknown structured field', () => {
    expect(isQueryRequest({ kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of() })).toBe(false);
  });
});

describe('queryListRequest', () => {
  const ql = (
    pid: number, reqtyp: number, qcodes: readonly number[] = [],
  ): StructuredField => ({
    kind: 'readPartition', pid, type: 0x03, queryList: { reqtyp, qcodes },
  });

  it('returns the parameters for each of the three defined REQTYPs', () => {
    expect(queryListRequest(ql(0xff, ReqTyp.QCODE_LIST, [0x81])))
      .toEqual({ reqtyp: 0x00, qcodes: [0x81] });
    expect(queryListRequest(ql(0xff, ReqTyp.EQUIVALENT)))
      .toEqual({ reqtyp: 0x40, qcodes: [] });
    expect(queryListRequest(ql(0xff, ReqTyp.ALL)))
      .toEqual({ reqtyp: 0x80, qcodes: [] });
  });

  it('rejects a Query List against a real partition', () => {
    // x3270 sf.c:248-251 returns PDS_BAD_CMD here, and the manual lists it among
    // the rejection conditions: "The operation type is Query or Query List and
    // the PIO is not X'FF'" (pages.txt:6404, "PIO" being OCR of "PID").
    expect(queryListRequest(ql(0x00, ReqTyp.ALL))).toBeUndefined();
    expect(queryListRequest(ql(0x01, ReqTyp.QCODE_LIST, [0x81]))).toBeUndefined();
  });

  it('rejects the reserved REQTYP B(11)', () => {
    // p. 5-51 (pages.txt:6361) "B'11' Reserved". Screened here rather than at
    // the reply builder because session.ts handleRecord RETHROWS a RangeError as
    // our own bug, which drops the connection — a host must not be able to do
    // that by setting two bits. There is a session-level test for this.
    expect(queryListRequest(ql(0xff, 0xc0))).toBeUndefined();
  });

  it('rejects a plain Query, which the other predicate handles', () => {
    expect(queryListRequest({ kind: 'readPartition', pid: 0xff, type: 0x02 }))
      .toBeUndefined();
  });

  it('rejects an unknown structured field', () => {
    expect(queryListRequest({ kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of() }))
      .toBeUndefined();
  });
});
