import { describe, it, expect } from 'vitest';
import { Tn3270eUnbindReason } from '../src/constants.js';
import { maxRu, BIND_RU, BIND_OFF, BIND_PLU_NAME_MAX, parseBind, type BindImage } from '../src/bind.js';

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

/** The real BIND from x3270's s3270/Test/devname_success.trc, bytes after the header. */
const REAL_BIND = Uint8Array.from([
  0x31, 0x01, 0x03, 0x03, 0xb1, 0x90, 0x30, 0x80, 0x00, 0x87,
  0x87, 0xf8, 0x87, 0x00, 0x02, 0x80, 0x00, 0x00, 0x00, 0x00,
  0x18, 0x50, 0x2b, 0x50, 0x7f, 0x00, 0x00, 0x08, 0xc9, 0xc2,
  0xd4, 0xf0, 0xe2, 0xd4, 0xc1, 0xd1, 0x00, 0x05, 0x00, 0x7e,
  0xec, 0x0b, 0x10, 0x08, 0xc9, 0xc2, 0xd4, 0xf0, 0xe3, 0xc5,
  0xe2, 0xd8,
]);

describe('parseBind — the real host BIND', () => {
  it('decodes devname_success.trc exactly as x3270 annotated it', () => {
    // x3270's own decode of these bytes, from the trace at line 133:
    //   < BIND PLU-name 'IBM0SMAJ' MaxSec-RU 1024 MaxPri-RU 3840
    //     Rows-Cols Default 24x80 Alternate 43x80
    //
    // THIS IS THE POINT OF THE WHOLE TASK: a host-free witness from a real host,
    // which BIND has never had. Not one byte of this is our invention.
    const b = parseBind(REAL_BIND);
    expect(b).not.toBeNull();
    expect(b!.pluName).toBe('IBM0SMAJ');
    expect(b!.maxRuSecondary).toBe(1024);
    expect(b!.maxRuPrimary).toBe(3840);
    expect(b!.sizeCode).toBe(0x7f);
    expect(b!.dims).toEqual({
      defaultRows: 24, defaultCols: 80,
      alternate: { rows: 43, cols: 80 },
    });
  });
});

describe('parseBind — size codes', () => {
  /** A BIND long enough to reach every offset, with the size code and dims settable. */
  const bindWith = (ssize: number, rd = 0, cd = 0, ra = 0, ca = 0): Uint8Array => {
    const b = new Uint8Array(28);
    b[0] = BIND_RU;
    b[BIND_OFF.RD] = rd; b[BIND_OFF.CD] = cd;
    b[BIND_OFF.RA] = ra; b[BIND_OFF.CA] = ca;
    b[BIND_OFF.SSIZE] = ssize;
    return b;
  };

  it('0x00 and 0x02 both mean model 2 for both sizes', () => {
    for (const code of [0x00, 0x02]) {
      const b = parseBind(bindWith(code, 43, 80, 43, 80))!;
      // The dims bytes are DELIBERATELY set to 43x80 and must be IGNORED: these two
      // codes mean model 2 regardless of what bytes 20-23 happen to hold.
      expect(b.dims).toEqual({
        defaultRows: 24, defaultCols: 80, alternate: { rows: 24, cols: 80 },
      });
    }
  });

  it('0x03 means model-2 default and defers the alternate to the caller', () => {
    const b = parseBind(bindWith(0x03, 43, 80, 43, 80))!;
    expect(b.dims).toEqual({
      defaultRows: 24, defaultCols: 80, alternate: 'caller',
    });
  });

  it('0x7e uses ONE pair for both sizes', () => {
    // The alternate bytes are set to something different and must be ignored:
    // 0x7e duplicates the default pair, it does not read 22-23.
    const b = parseBind(bindWith(0x7e, 32, 80, 43, 132))!;
    expect(b.dims).toEqual({
      defaultRows: 32, defaultCols: 80, alternate: { rows: 32, cols: 80 },
    });
  });

  it('0x7f uses both pairs', () => {
    // Columns are DELIBERATELY distinct (80 vs 132), not tied like an earlier version
    // of this test (80 vs 80): a coincidental tie can't catch defaultCols and
    // alternate.cols being read from each other's offset. Rows already differed
    // (24 vs 43), so only the columns half was under-verified.
    const b = parseBind(bindWith(0x7f, 24, 80, 43, 132))!;
    expect(b.dims).toEqual({
      defaultRows: 24, defaultCols: 80, alternate: { rows: 43, cols: 132 },
    });
  });

  it('reports no dimensions for an unrecognised size code', () => {
    const b = parseBind(bindWith(0x55, 43, 80, 43, 80))!;
    expect(b.dims).toBeUndefined();
    // Still a valid BIND: the PLU name and RU sizes are unaffected.
    expect(b.sizeCode).toBe(0x55);
  });
});

describe('parseBind — the PLU name', () => {
  /** Build a BIND carrying `name` as its PLU name, EBCDIC-encoded. */
  const withName = (bytes: number[], declaredLen = bytes.length): Uint8Array => {
    const b = new Uint8Array(BIND_OFF.PLU_NAME + bytes.length);
    b[0] = BIND_RU;
    b[BIND_OFF.SSIZE] = 0x00;
    b[BIND_OFF.PLU_NAME_LEN] = declaredLen;
    b.set(bytes, BIND_OFF.PLU_NAME);
    return b;
  };

  it('decodes EBCDIC', () => {
    // 'IBM' in cp037: I=0xc9 B=0xc2 M=0xd4
    expect(parseBind(withName([0xc9, 0xc2, 0xd4]))!.pluName).toBe('IBM');
  });

  it('is empty when the declared length is zero', () => {
    // x3270 requires namelen > 0 before copying, so a zero length is "no name" and
    // not "a name of length zero followed by whatever bytes are there".
    expect(parseBind(withName([0xc9, 0xc2, 0xd4], 0))!.pluName).toBe('');
  });

  it('caps at 8 bytes even when the host declares more', () => {
    // x3270 clamps namelen to BIND_PLU_NAME_MAX rather than refusing the BIND.
    const nine = [0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9];
    const name = parseBind(withName(nine, 9))!.pluName;
    expect(name).toHaveLength(8);
    expect(name).toBe('ABCDEFGH');
  });

  it('is empty when the declared length overruns the buffer', () => {
    // A HOSTILE OR TRUNCATED BIND: it says 8 bytes and supplies 2. x3270 requires
    // buflen > PLU_NAME + namelen before copying, so it takes nothing. Taking the two
    // available bytes would be inventing a name the host did not send.
    expect(parseBind(withName([0xc9, 0xc2], 8))!.pluName).toBe('');
  });

  it('is empty when the buffer does not reach the length byte at all', () => {
    const short = new Uint8Array(20);
    short[0] = BIND_RU;
    expect(parseBind(short)!.pluName).toBe('');
  });

  it('decodes a name whose last byte is the buffer-s last byte (buflen == PLU_NAME + namelen)', () => {
    // x3270's C guard is `buflen > BIND_OFF_PLU_NAME + namelen` (Common/telnet.c:2567)
    // -- STRICT greater-than. Copying `namelen` bytes from offset 28 only touches
    // indices up to 28 + namelen - 1, so buflen == 28 + namelen supplies every byte the
    // copy needs; x3270's `>` refuses this buffer anyway, which reads as an off-by-one
    // bug in x3270 itself. This decoder deliberately does NOT reproduce that bug (see
    // the comment on decodePluName in bind.ts) because this file's own "decodes EBCDIC"
    // test above builds exactly this boundary via `withName`'s default declaredLen and
    // is required to succeed. This is the fixture that discriminates the two readings:
    // the real BIND (52 bytes, declares 8 at offset 28, 28+8=36 < 52) has 16 bytes of
    // slack and passes under EITHER reading, so it proves nothing about this choice.
    const declaredLen = 5;
    const bytes = [0xc1, 0xc2, 0xc3, 0xc4, 0xc5]; // 'ABCDE', fully present
    const b = new Uint8Array(BIND_OFF.PLU_NAME + declaredLen); // buflen == 28 + 5 == 33
    b[0] = BIND_RU;
    b[BIND_OFF.PLU_NAME_LEN] = declaredLen;
    b.set(bytes, BIND_OFF.PLU_NAME);
    expect(parseBind(b)!.pluName).toBe('ABCDE');
  });
});
