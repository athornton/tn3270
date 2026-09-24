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
 * `len` is the FIELD length the host declares (0x23 or 0x29), so the payload is
 * len-3 bytes. The name sits at the x3270 offset minus 3.
 */
function openPayload(len: 0x23 | 0x29, name: string, recsz = 0): Uint8Array {
  const p = new Uint8Array(len - 3);
  p[0] = 0x00;
  p[1] = 0x12;                       // TR_OPEN_REQ
  const nameAt = len === 0x23 ? 22 : 28;
  if (len === 0x29) {
    p[24] = (recsz >> 8) & 0xff;     // recsz at x3270's +27
    p[25] = recsz & 0xff;
  }
  // Name is 7 bytes, space-padded, EBCDIC on the wire but ASCII in x3270's
  // comparison because the host sends it as ASCII -- see the note in the impl.
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) p[nameAt + i] = padded.charCodeAt(i);
  return p;
}

describe('parseDftOpen', () => {
  it('accepts the short form, name at payload offset 22', () => {
    const open = parseDftOpen(openPayload(0x23, 'FT:DATA'));
    expect(open.name).toBe('FT:DATA');
    expect(open.recordSize).toBeUndefined();
    expect(open.isMessage).toBe(false);
  });

  it('accepts the long form, record size at 24 and name at 28', () => {
    const open = parseDftOpen(openPayload(0x29, 'FT:DATA', 1024));
    expect(open.name).toBe('FT:DATA');
    expect(open.recordSize).toBe(1024);
    expect(open.isMessage).toBe(false);
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
    // Anything but 0x23 or 0x29 is ftDftUnknownOpen (ft_dft.c:153-155).
    expect(() => parseDftOpen(new Uint8Array(0x24 - 3))).toThrow(/unknown Open length/);
    expect(() => parseDftOpen(new Uint8Array(0x28 - 3))).toThrow(/unknown Open length/);
  });

  it('BISECTS the boundary: 0x20 and 0x26 payloads pass, 0x21 and 0x25 do not', () => {
    // The payload lengths for the two legal FIELD lengths. Testing one grossly
    // wrong value would not catch an off-by-one in the subtraction, which is the
    // error this whole plan warns about.
    expect(() => parseDftOpen(new Uint8Array(0x20))).not.toThrow();
    expect(() => parseDftOpen(new Uint8Array(0x26))).not.toThrow();
    expect(() => parseDftOpen(new Uint8Array(0x21))).toThrow();
    expect(() => parseDftOpen(new Uint8Array(0x25))).toThrow();
  });
});
