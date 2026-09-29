import { describe, it, expect } from 'vitest';
import {
  DftRequest,
  DftReply,
  DftHeader,
  DftError,
  OPEN_MSG,
  parseDftFrame,
  parseDftOpen,
  DftFrameError,
  buildOpenAck,
  buildCloseAck,
  buildDataAck,
  buildDftError,
  u16,
  u32,
} from '../src/ft/dftFrames.js';

describe('DFT wire constants, from include/ft_dft_ds.h', () => {
  it('has the six host request types', () => {
    expect(DftRequest.OPEN).toBe(0x0012);
    expect(DftRequest.CLOSE).toBe(0x4112);
    expect(DftRequest.SET_CUR).toBe(0x4511);
    expect(DftRequest.GET).toBe(0x4611);
    expect(DftRequest.INSERT).toBe(0x4711);
    expect(DftRequest.DATA_INSERT).toBe(0x4704);
  });

  it('has the four PC reply types', () => {
    expect(DftReply.GET).toBe(0x4605);
    expect(DftReply.NORMAL).toBe(0x4705);
    expect(DftReply.ERROR).toBe(0x08);
    expect(DftReply.CLOSE).toBe(0x4109);
  });

  it('has the other headers', () => {
    expect(DftHeader.RECNUM).toBe(0x6306);
    expect(DftHeader.ERROR).toBe(0x6904);
    expect(DftHeader.NOT_COMPRESSED).toBe(0xc080);
    expect(DftHeader.BEGIN_DATA).toBe(0x61);
  });

  it('has the two error codes', () => {
    expect(DftError.EOF).toBe(0x2200);
    expect(DftError.CMDFAIL).toBe(0x0100);
  });

  it('spells the message-open name exactly as x3270 does', () => {
    // ft_dft.c:53 `#define OPEN_MSG "FT:MSG"`. Six characters, no trailing space:
    // the comparison is against a name whose trailing spaces have been trimmed.
    expect(OPEN_MSG).toBe('FT:MSG');
    expect(OPEN_MSG).toHaveLength(6);
  });
});

describe('parseDftFrame', () => {
  it('reads the request type from offset 0 of the PARAMS, not offset 3', () => {
    // Distinct bytes at BOTH candidate offsets, so a wrong offset reads a REAL
    // value rather than running off the end and coercing to 0. x3270 reads this
    // field at cp+3 because its pointer includes the length bytes and the SFID;
    // parseStructuredFields strips both, so for us it is at 0.
    const frame = parseDftFrame(Uint8Array.of(0x00, 0x12, 0xff, 0x99, 0x88, 0x77));
    expect(frame.requestType).toBe(0x0012);
    expect(frame.requestType).not.toBe(0x9988); // what an offset-3 read would give
  });

  it('reads a CLOSE', () => {
    expect(parseDftFrame(Uint8Array.of(0x41, 0x12)).requestType).toBe(0x4112);
  });

  it('keeps the whole payload, so handlers can read their own offsets', () => {
    const frame = parseDftFrame(Uint8Array.of(0x46, 0x11, 0xaa, 0xbb));
    expect(frame.requestType).toBe(0x4611);
    expect([...frame.payload]).toEqual([0x46, 0x11, 0xaa, 0xbb]);
  });

  it('refuses a payload too short to hold a request type', () => {
    expect(() => parseDftFrame(Uint8Array.of(0x00))).toThrow(DftFrameError);
    expect(() => parseDftFrame(new Uint8Array(0))).toThrow(/2 bytes/);
  });
});

/**
 * Build an Open payload as OUR parser sees it: field length minus 3.
 *
 * **CORRECTED 2026-09-25.** This helper used to write the name at payload offset
 * 22/28 — the same wrong offsets the parser read — so the two agreed with each
 * other and not with the wire, and every test here passed over a real bug.
 *
 * The Open's internal offsets are x3270's UNCHANGED, not minus 3, because
 * `dft_open_request` is handed a pointer to `sf_request_type` (struct offset 3)
 * rather than the struct base: `GET16` does not advance its argument
 * (`3270ds.h:341-344`), so the `cp` set at `ft_dft.c:108` is still there at `:114`.
 * That is the same byte our payload starts at. See the long note in `dftFrames.ts`.
 *
 * To keep this helper from ever again being "right" only relative to the parser, it
 * is written in terms of the FIELD and then sliced, exactly as the wire is laid
 * out, and `pins the struct layout` below checks it against a hand-written literal.
 */
function openPayload(len: 0x23 | 0x29, name: string, recsz = 0): Uint8Array {
  // Build the WHOLE structured field, as `struct data_buffer` overlays it.
  const field = new Uint8Array(len);
  field[0] = 0x00;
  field[1] = len;                    // declared field length
  field[2] = 0xd0;                   // SFID
  field[3] = 0x00;
  field[4] = 0x12;                   // TR_OPEN_REQ, at struct offset 3
  // `cp` is field + 3, so x3270's cp+N is field index N + 3.
  const cp = 3;
  if (len === 0x29) {
    field[cp + 27] = (recsz >> 8) & 0xff;
    field[cp + 27 + 1] = recsz & 0xff;
  }
  const nameAt = cp + (len === 0x23 ? 25 : 31);
  // Name is 7 bytes, space-padded. ASCII, not EBCDIC: x3270 strcmp's the raw
  // bytes and TK5's own frames carry ASCII -- see the note in the impl.
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) field[nameAt + i] = padded.charCodeAt(i);
  // What parseStructuredFields hands us: the params, less the 2 length bytes and
  // the SFID.
  return field.subarray(3);
}

describe('parseDftOpen', () => {
  it('pins the struct layout against a HAND-WRITTEN frame, owing nothing to the helper', () => {
    // THIS TEST EXISTS BECAUSE THE HELPER AND THE PARSER ONCE AGREED ON A WRONG
    // OFFSET AND EVERY OTHER TEST HERE PASSED. It is written byte by byte from
    // `struct data_buffer` (ft_dft.c:59-67) plus the pointer fact at :108/:114, so
    // it is an INDEPENDENT oracle: if the parser and `openPayload` drift together
    // again, this still fails.
    //
    // A real 0x23 Open for "FT:MSG ". Field: 00 23 d0 | 00 12 | 20 filler | name(7).
    const field = [
      0x00, 0x23, 0xd0,                    // 0-2   length, length, SFID
      0x00, 0x12,                          // 3-4   TR_OPEN_REQ  (cp+0)
      ...Array(23).fill(0x00),             // 5-27  filler       (cp+2 .. cp+24)
      0x46, 0x54, 0x3a, 0x4d, 0x53, 0x47, 0x20, // 28-34 "FT:MSG " at cp+25
    ];
    expect(field).toHaveLength(0x23);      // the declared length, self-checked
    // Our payload is the field less the 2 length bytes and the SFID.
    const payload = Uint8Array.from(field.slice(3));
    expect(payload).toHaveLength(0x23 - 3);
    const open = parseDftOpen(payload);
    expect(open.name).toBe('FT:MSG');
    expect(open.isMessage).toBe(true);
    // And the offset the original code used reads filler, not a name.
    expect(payload[22]).toBe(0x00);
    expect(payload[25]).toBe(0x46);        // 'F'
  });

  it('accepts the short form, name at payload offset 25', () => {
    const open = parseDftOpen(openPayload(0x23, 'FT:DATA'));
    expect(open.name).toBe('FT:DATA');
    expect(open.recordSize).toBeUndefined();
    expect(open.isMessage).toBe(false);
  });

  it('accepts the long form, record size at 27 and name at 31', () => {
    const open = parseDftOpen(openPayload(0x29, 'FT:DATA', 1024));
    expect(open.name).toBe('FT:DATA');
    expect(open.recordSize).toBe(1024);
    expect(open.isMessage).toBe(false);
  });

  it('the name ends exactly at the payload\'s last byte, in both forms', () => {
    // 25+7 = 32 and 31+7 = 38, the two legal payload lengths. The exact fit is
    // corroborating evidence for the offsets: x3270's 7-byte memcpy consumes the
    // field to its end, which is why 0x23 is the short form's length and not more.
    // An off-by-one either way would read off the end or leave a byte spare.
    expect(25 + 7).toBe(0x23 - 3);
    expect(31 + 7).toBe(0x29 - 3);
  });

  it('trims the name\'s trailing spaces, so a padded FT:MSG still matches', () => {
    const open = parseDftOpen(openPayload(0x23, 'FT:MSG'));
    expect(open.name).toBe('FT:MSG');
    expect(open.isMessage).toBe(true);
  });

  it('does NOT treat a message open as a file, which is the branch that matters', () => {
    expect(parseDftOpen(openPayload(0x29, 'FT:MSG', 80)).isMessage).toBe(true);
  });

  it('refuses any other length, as dft_open_request does', () => {
    // Anything but 0x23 or 0x29 is ftDftUnknownOpen (ft_dft.c:154-156).
    expect(() => parseDftOpen(new Uint8Array(0x24 - 3))).toThrow(/unknown Open length/);
    expect(() => parseDftOpen(new Uint8Array(0x28 - 3))).toThrow(/unknown Open length/);
  });

  it('BISECTS the boundary from both sides: 31/39 are new, 33/37 pin the adjacency', () => {
    // 31 and 39 sit one step BEYOND the accepted 32 and 38 -- new coverage that
    // would catch the boundary drifting outward, which the accept-tests above
    // (already at 32/38) and the refuse-test above (already at 33/37) do not
    // exercise. 33 and 37 duplicate the refuse-test's values on purpose: they
    // pin the inward adjacency so this test still reads as a full bisection.
    expect(() => parseDftOpen(new Uint8Array(31))).toThrow();
    expect(() => parseDftOpen(new Uint8Array(39))).toThrow();
    expect(() => parseDftOpen(new Uint8Array(33))).toThrow();
    expect(() => parseDftOpen(new Uint8Array(37))).toThrow();
  });
});

describe('DFT reply builders', () => {
  it('builds the Open acknowledgement, 6 bytes', () => {
    // ft_dft.c:181-189: AID_SF, SET16(5), SF_TRANSFER_DATA, SET16(9).
    expect([...buildOpenAck()]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x00, 0x09]);
  });

  it('builds the Close acknowledgement, 6 bytes ending in TR_CLOSE_REPLY', () => {
    // ft_dft.c:680-687.
    expect([...buildCloseAck()]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x41, 0x09]);
  });

  it('builds a data acknowledgement carrying a 32-bit record number', () => {
    // ft_dft.c:206-214: AID_SF, SET16(11), SF, TR_NORMAL_REPLY, TR_RECNUM_HDR,
    // SET32(recnum). 12 bytes.
    expect([...buildDataAck(1)]).toEqual([
      0x88, 0x00, 0x0b, 0xd0, 0x47, 0x05, 0x63, 0x06, 0x00, 0x00, 0x00, 0x01,
    ]);
  });

  it('puts a large record number in big-endian order', () => {
    expect([...buildDataAck(0x01020304)].slice(8)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('builds an error reply borrowing the failed request\'s high byte', () => {
    // ft_dft.c:698-706: AID_SF, SET16(9), SF, HIGH8(code), TR_ERROR_REPLY,
    // TR_ERROR_HDR, TR_ERR_CMDFAIL. 10 bytes. The reply type's high byte comes
    // from the REQUEST that failed -- 0x46 for a GET -- which is why ERROR is an
    // 8-bit constant.
    expect([...buildDftError(0x4611)]).toEqual([
      0x88, 0x00, 0x09, 0xd0, 0x46, 0x08, 0x69, 0x04, 0x01, 0x00,
    ]);
  });

  it('borrows 0x00 from an Open, since TR_OPEN_REQ is 0x0012', () => {
    expect([...buildDftError(DftRequest.OPEN)].slice(4, 6)).toEqual([0x00, 0x08]);
  });

  it('numbers records from 1 upwards without the builder holding state', () => {
    // x3270 keeps `recnum` as a static and increments it in dft_data_ack
    // (ft_dft.c:213). Ours takes it as an argument, so the COUNTER belongs to the
    // state machine in Task 5 -- pinned here because a builder that remembered
    // anything would make two acks for record 1 impossible to construct, which
    // is what a retransmit needs.
    expect([...buildDataAck(1)]).toEqual([...buildDataAck(1)]);
  });
});

describe('big-endian writers', () => {
  it('splits a 16-bit value high byte first', () => {
    expect(u16(0x1234)).toEqual([0x12, 0x34]);
    expect(u16(0)).toEqual([0x00, 0x00]);
    expect(u16(0xffff)).toEqual([0xff, 0xff]);
  });

  it('splits a 32-bit value high byte first', () => {
    expect(u32(0x01020304)).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(u32(0)).toEqual([0x00, 0x00, 0x00, 0x00]);
  });

  it('keeps the high byte unsigned past 0x7fffffff', () => {
    // A record number this large cannot arise from a real transfer, but the
    // writer is exported and Task 6 reuses it. `>>` would give the same bytes
    // here because `& 0xff` truncates either way -- MEASURED, not assumed -- so
    // this pins the OUTPUT and does not claim the shift operator is what saves it.
    expect(u32(0xffffffff)).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect(u32(0x80000000)).toEqual([0x80, 0x00, 0x00, 0x00]);
  });
});
