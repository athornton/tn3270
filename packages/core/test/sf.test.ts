import { describe, it, expect } from 'vitest';
import { parseStructuredFields, isQueryRequest, SfParseError } from '../src/stream/sf.js';

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
    const fields = parseStructuredFields(Uint8Array.of(
      0x00, 0x05, 0x01, 0xff, 0x02,
      0x00, 0x05, 0x01, 0xff, 0x03,
    ));
    expect(fields).toHaveLength(2);
    expect(fields[1]).toEqual({ kind: 'readPartition', pid: 0xff, type: 0x03 });
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

describe('isQueryRequest', () => {
  it('accepts a Query against the query PID', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0xff, type: 0x02 })).toBe(true);
  });

  it('rejects a Query List, whose subsetting rules we have not implemented', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0xff, type: 0x03 })).toBe(false);
  });

  it('rejects a read against a real partition', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0x00, type: 0x02 })).toBe(false);
  });

  it('rejects an unknown structured field', () => {
    expect(isQueryRequest({ kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of() })).toBe(false);
  });
});
