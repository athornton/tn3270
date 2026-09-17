import { describe, it, expect } from 'vitest';
import { Tn3270eUnbindReason } from '../src/constants.js';

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
