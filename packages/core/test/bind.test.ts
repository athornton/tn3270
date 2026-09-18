import { describe, it, expect } from 'vitest';
import { Tn3270eUnbindReason } from '../src/constants.js';
import { maxRu, BIND_RU, BIND_OFF, BIND_PLU_NAME_MAX } from '../src/bind.js';

/**
 * Values are x3270's include/tn3270e.h:108-118, read from the source rather than
 * from RFC 2355 -- the RFC lists fewer, and the wire is the authority here.
 *
 * NOTE THE GAPS: there is no 0x03-0x06, and no 0x0d. They are not omissions to be
 * "fixed" by interpolating: x3270 has no name for them either, and an unknown reason
 * is handled as unknown rather than guessed at.
 */
describe('UNBIND reason codes', () => {
  it('has the values x3270 defines, gaps included', () => {
    expect(Tn3270eUnbindReason.NORMAL).toBe(0x01);
    expect(Tn3270eUnbindReason.BIND_FORTHCOMING).toBe(0x02);
    expect(Tn3270eUnbindReason.VR_INOPERATIVE).toBe(0x07);
    expect(Tn3270eUnbindReason.RX_INOPERATIVE).toBe(0x08);
    expect(Tn3270eUnbindReason.HRESET).toBe(0x09);
    expect(Tn3270eUnbindReason.SSCP_GONE).toBe(0x0a);
    expect(Tn3270eUnbindReason.VR_DEACTIVATED).toBe(0x0b);
    expect(Tn3270eUnbindReason.LU_FAILURE_PERM).toBe(0x0c);
    expect(Tn3270eUnbindReason.LU_FAILURE_TEMP).toBe(0x0e);
    expect(Tn3270eUnbindReason.CLEANUP).toBe(0x0f);
    expect(Tn3270eUnbindReason.BAD_SENSE).toBe(0xfe);
  });

  it('does not collide NORMAL with the 0x00 that means "no reason byte"', () => {
    // A zero-length UNBIND body has no reason at all, and parseUnbind reports
    // undefined for it. If NORMAL were 0x00 the two would be indistinguishable.
    expect(Tn3270eUnbindReason.NORMAL).not.toBe(0x00);
  });
});

/**
 * x3270's maxru(), Common/telnet.c:2440-2446:
 *
 *   if (!(c & 0x80)) return 0;
 *   return ((c >> 4) & 0x0f) * (1 << (c & 0xf));
 *
 * It is a MANTISSA-EXPONENT encoding, not a plain integer. The high bit doubles as a
 * validity flag and as the top bit of a 4-bit mantissa spanning bits 4-7 -- so the
 * mantissa the multiply uses is always 8-15, never 0-7, on any byte that reaches it.
 */
describe('maxRu', () => {
  it('is zero when the high bit is clear, whatever the rest says', () => {
    expect(maxRu(0x00)).toBe(0);
    expect(maxRu(0x7f)).toBe(0);
    // 0x79 would decode to 7 * 512 with the flag set; without it, zero.
    expect(maxRu(0x79)).toBe(0);
  });

  it('decodes the two values in the real BIND from devname_success.trc', () => {
    // The trace's own annotation reads: MaxSec-RU 1024 MaxPri-RU 3840.
    // Bytes 10 and 11 of that BIND are 0x87 and 0xf8.
    expect(maxRu(0x87)).toBe(1024);   // (8 & 0x0f) * (1 << 7) = 8 * 128
    expect(maxRu(0xf8)).toBe(3840);   // (15 & 0x0f) * (1 << 8) = 15 * 256
  });

  it('decodes the largest legal byte', () => {
    // 0xff: mantissa 15, exponent 15 -> 15 * 32768 = 491520. Large, and legal.
    //
    // THIS DOES NOT TEST THE `& 0x0f` MASK, and deliberately makes no claim to.
    // See the note below Step 5: that mask is unfalsifiable.
    expect(maxRu(0xff)).toBe(491520);
  });
});

describe('BIND offsets', () => {
  it('are x3270 s, from include/3270ds.h:433-443', () => {
    expect(BIND_RU).toBe(0x31);
    expect(BIND_OFF.MAXRU_SEC).toBe(10);
    expect(BIND_OFF.MAXRU_PRI).toBe(11);
    expect(BIND_OFF.RD).toBe(20);
    expect(BIND_OFF.CD).toBe(21);
    expect(BIND_OFF.RA).toBe(22);
    expect(BIND_OFF.CA).toBe(23);
    expect(BIND_OFF.SSIZE).toBe(24);
    expect(BIND_OFF.PLU_NAME_LEN).toBe(27);
    expect(BIND_OFF.PLU_NAME).toBe(28);
    expect(BIND_PLU_NAME_MAX).toBe(8);
  });
});
