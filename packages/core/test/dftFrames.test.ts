import { describe, it, expect } from 'vitest';
import {
  DftRequest,
  DftReply,
  DftHeader,
  DftError,
  OPEN_MSG,
  parseDftFrame,
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
    // A minimal Open: request type only. x3270 would read this at cp+3; we get
    // params, so it is at 0. Getting this wrong is the bug this test exists for.
    const frame = parseDftFrame(Uint8Array.of(0x00, 0x12));
    expect(frame.requestType).toBe(0x0012);
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
