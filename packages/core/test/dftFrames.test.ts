import { describe, it, expect } from 'vitest';
import { DftRequest, DftReply, DftHeader, DftError, OPEN_MSG } from '../src/ft/dftFrames.js';

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
