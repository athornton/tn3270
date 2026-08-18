import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AckAid,
  CC_MESSAGE_LENGTH,
  CUT_SCREEN_SIZE,
  CutFrameError,
  EOF_DATA1,
  EOF_DATA2,
  FrameType,
  MAX_DOWNLOAD_DATA,
  O_CC_FRAME_SEQ,
  O_CC_MESSAGE,
  O_CC_STATUS_CODE,
  O_DR_FRAME_SEQ,
  O_DR_SF,
  O_DT_CSUM,
  O_DT_DATA,
  O_DT_FRAME_SEQ,
  O_DT_LEN,
  O_FRAME_TYPE,
  O_RESPONSE,
  O_SF,
  O_UP_CSUM,
  O_UP_DATA,
  O_UP_FRAME_SEQ,
  O_UP_LEN,
  O_UP_MAX,
  RO_FRAME_SEQ,
  RO_FRAME_TYPE,
  RO_REASON_CODE,
  ResponseFrameType,
  StatusCode,
  isCutFrame,
  isEofData,
  isKnownStatusCode,
  parseFrame,
  writeResponse,
  writeUploadData,
  writeUploadEof,
} from '../../src/ft/frames.js';
import { CutCodec, QUADRANTS, TABLE6, checksum, from6, to6 } from '../../src/ft/cut.js';
import { AID, FA } from '../../src/constants.js';
import { cp037 } from '../../src/codepage.js';
import { Screen } from '../../src/screen.js';
import { execute } from '../../src/stream/execute.js';
import { parseRecord } from '../../src/stream/parse.js';

/**
 * CUT frame layout tests.
 *
 * Two independent references, and the test file uses both deliberately:
 *
 *  - x3270 4.5 `include/ft_cut_ds.h` (82 lines, every offset and code) and
 *    `Common/ft_cut.c` (the algorithm), cited by line throughout.
 *  - `packages/fixtures/cut/tk5-ind-file-data-frame.txt`, a REAL inbound record
 *    captured from MVS 3.8j TK5's IND$FILE. That fixture is the better oracle,
 *    because it can disagree with our reading of the header, and the first test
 *    below is the one that would catch it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', '..', '..', 'fixtures', 'cut', 'tk5-ind-file-data-frame.txt');

/** Strip `#` comment lines and whitespace; return the hex bytes. */
function readHexFixture(path: string): Uint8Array {
  const bytes = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join(' ')
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map((h) => {
      const b = parseInt(h, 16);
      if (Number.isNaN(b) || b < 0 || b > 0xff) throw new Error(`bad hex byte ${JSON.stringify(h)}`);
      return b;
    });
  return Uint8Array.from(bytes);
}

/** A blank 24x80 screen: the only geometry CUT works on. */
function blankScreen(): Screen {
  const s = new Screen();
  expect(s.size).toBe(CUT_SCREEN_SIZE);
  return s;
}

/**
 * Plant the auto-skip field attribute the host puts at O_SF.
 *
 * 0x7c is the byte the real TK5 host sends (see the fixture): protected (0x20)
 * and numeric (0x10) are both on, which is FA_IS_SKIP.
 */
function markCutFrame(screen: Screen): void {
  screen.setFieldAttribute(O_SF, 0x7c);
}

/** Write bytes into the buffer starting at `addr`. */
function poke(screen: Screen, addr: number, bytes: readonly number[]): void {
  bytes.forEach((b, i) => screen.setChar(addr + i, b));
}

describe('the wire constants, verified against include/ft_cut_ds.h', () => {
  it('places the structured field at the last cell of a 24x80 buffer', () => {
    // `#define O_SF 1919` (ft_cut_ds.h:33). This is the geometry coupling the
    // design doc warns about: 1919 is the last cell of 24x80 and of nothing
    // else, so pinning both here makes a future alternate-geometry change fail
    // loudly rather than corrupt a transfer.
    expect(O_SF).toBe(1919);
    expect(CUT_SCREEN_SIZE).toBe(24 * 80);
    expect(O_SF).toBe(CUT_SCREEN_SIZE - 1);
  });

  it('has the primary-area offsets and frame types the header defines', () => {
    expect(O_FRAME_TYPE).toBe(0); // ft_cut_ds.h:36
    expect(FrameType.CONTROL_CODE).toBe(0xc3); // :37
    expect(O_CC_FRAME_SEQ).toBe(1); // :38
    expect(O_CC_STATUS_CODE).toBe(2); // :39
    expect(O_CC_MESSAGE).toBe(4); // :44
    expect(FrameType.DATA_REQUEST).toBe(0xc2); // :45
    expect(O_DR_SF).toBe(1); // :46
    expect(O_DR_FRAME_SEQ).toBe(3); // :48
    expect(FrameType.RETRANSMIT).toBe(0x4c); // :49
    expect(FrameType.DATA).toBe(0xc1); // :50
    expect(O_DT_FRAME_SEQ).toBe(1); // :51
    expect(O_DT_CSUM).toBe(2); // :52
    expect(O_DT_LEN).toBe(3); // :53
    expect(O_DT_DATA).toBe(5); // :54
  });

  it('has the four status codes', () => {
    expect(StatusCode.HOST_ACK).toBe(0x8181); // ft_cut_ds.h:40
    expect(StatusCode.XFER_COMPLETE).toBe(0x8189); // :41
    expect(StatusCode.ABORT_FILE).toBe(0x8194); // :42
    expect(StatusCode.ABORT_XMIT).toBe(0x8198); // :43
  });

  it('derives the response area from O_SF, as the header does', () => {
    // `#define O_RESPONSE (O_SF-5)` (ft_cut_ds.h:57) and the three offsets
    // relative to it (:58, :61, :62). RO_REASON_CODE is two bytes, so the
    // response area ends at 1918 -- exactly the last cell before O_SF, which is
    // why the host leaves a five-byte gap there.
    expect(O_RESPONSE).toBe(1914);
    expect(RO_FRAME_TYPE).toBe(1915);
    expect(RO_FRAME_SEQ).toBe(1916);
    expect(RO_REASON_CODE).toBe(1917);
    expect(RO_REASON_CODE + 1).toBe(O_SF - 1);
    expect(ResponseFrameType.RETRANSMIT).toBe(0x4c); // :59
    expect(ResponseFrameType.CONTROL_CODE).toBe(0xc3); // :60
  });

  it('has the upload-area offsets, and O_UP_MAX derived from O_SF', () => {
    expect(O_UP_FRAME_SEQ).toBe(3); // ft_cut_ds.h:77
    expect(O_UP_CSUM).toBe(4); // :78
    expect(O_UP_LEN).toBe(5); // :79
    expect(O_UP_DATA).toBe(7); // :80
    // `#define O_UP_MAX (O_SF-O_UP_DATA)` (:81).
    expect(O_UP_MAX).toBe(O_SF - O_UP_DATA);
    expect(O_UP_MAX).toBe(1912);
  });

  it('bounds a download payload at O_RESPONSE - O_DT_DATA', () => {
    // Not a header constant: it is the size of x3270's `cvbuf`
    // (ft_cut.c:602) and the bound its oversize check uses (ft_cut.c:617).
    expect(MAX_DOWNLOAD_DATA).toBe(1909);
    expect(MAX_DOWNLOAD_DATA).toBe(O_RESPONSE - O_DT_DATA);
  });

  it('has the EOF sentinel and the five acknowledgement AIDs', () => {
    expect(EOF_DATA1).toBe(0x5c); // ft_cut_ds.h:65
    expect(EOF_DATA2).toBe(0xa9); // :66
    // ft_cut_ds.h:69-73, resolved through our own AID table rather than
    // restated as numbers. RESYNC differing between VM and TSO is the dialect
    // seam the design doc anticipated.
    expect(AckAid.OK).toBe(AID.ENTER);
    expect(AckAid.RETRANSMIT).toBe(AID.PF1);
    expect(AckAid.RESYNC_VM).toBe(AID.CLEAR);
    expect(AckAid.RESYNC_TSO).toBe(AID.PA2);
    expect(AckAid.ABORT).toBe(AID.PF2);
    // And the numbers, against GA23-0059 Table 3-4, so a constants.ts edit
    // cannot silently change what goes on the wire here.
    expect([AckAid.OK, AckAid.RETRANSMIT, AckAid.RESYNC_VM, AckAid.RESYNC_TSO, AckAid.ABORT])
      .toEqual([0x7d, 0xf1, 0x6d, 0x6e, 0xf2]);
  });

  it('reads a control-code message as 80 bytes, x3270’s loop bound', () => {
    // Not in the header: `for (i = 0; i < 80; i++)` (ft_cut.c:460). One display
    // line, which is what the host paints.
    expect(CC_MESSAGE_LENGTH).toBe(80);
  });
});

describe('the REAL frame captured from MVS 3.8j TK5', () => {
  /**
   * THE LOAD-BEARING TEST. Everything else in this file checks our code against
   * our reading of x3270's header; this one checks it against a host.
   *
   * It executes the WHOLE inbound record through the existing parse/execute
   * path -- EraseWrite, WCC, both SBA orders, the data, the trailing field
   * attributes -- rather than reaching into the hex for the payload. That
   * proves the frame layer composes with the stage 1 screen model, which is
   * the claim that actually matters: a hand-extracted payload could pass while
   * the real path put the bytes somewhere else.
   */
  function screenFromFixture(): Screen {
    const record = readHexFixture(fixture);
    // 1931 bytes on the wire. The last two are IAC EOR (ff ef), telnet
    // framing rather than record content, so they come off before parsing --
    // the same step packages/core/test/queryreply.test.ts takes with its
    // x3270 capture. No content byte in this record is 0xff, so there is no
    // IAC doubling to undo.
    expect(record).toHaveLength(1931);
    expect(Array.from(record.subarray(-2))).toEqual([0xff, 0xef]);
    const screen = blankScreen();
    execute(screen, parseRecord(record.subarray(0, record.length - 2)));
    return screen;
  }

  it('is recognised as a CUT frame', () => {
    // The host's own attribute at O_SF, arrived at through the real data
    // stream: `SBA(1919) ... SF(0x7c)`. 0x7c has PROTECT and NUMERIC, so
    // FA_IS_SKIP (3270ds.h:207) holds.
    const screen = screenFromFixture();
    expect(screen.attributeAt(O_SF)).toBe(0x7c);
    expect(isCutFrame(screen)).toBe(true);
  });

  it('parses as FT_DATA seq 1, checksum 62, length 1904', () => {
    const frame = parseFrame(screenFromFixture());
    expect(frame.kind).toBe('data');
    if (frame.kind !== 'data') throw new Error('unreachable');

    // The fixture's own annotation, byte by byte:
    //   c1     O_FRAME_TYPE = FT_DATA
    //   82     O_DT_FRAME_SEQ   -> from6 = 1
    //   f4     O_DT_CSUM        -> from6 = 62
    //   6b d8  O_DT_LEN         -> (from6<<6)|from6 = 1904
    expect(frame.seq).toBe(1);
    expect(frame.rawSeq).toBe(0x82);
    expect(frame.declaredChecksum).toBe(62);
    expect(frame.length).toBe(1904);
    expect(frame.data).toHaveLength(1904);

    // Cross-check the length arithmetic against the raw bytes rather than only
    // against the decoded result, so a from6 regression cannot pass by
    // agreeing with itself.
    expect((from6(0x6b) << 6) | from6(0xd8)).toBe(1904);
  });

  it('carries the checksum the host computed, and we compute the same one', () => {
    // THIS IS THE FINDING THAT MADE CHECKSUM VERIFICATION WORTHWHILE. x3270
    // never reads O_DT_CSUM (its only mention in the tree is the #define), and
    // MECAFF on VM/370 ignores the field on receive -- but TK5's IND$FILE
    // populates it on send, so a mismatch here is a real diagnostic rather
    // than a spurious warning on every frame.
    const frame = parseFrame(screenFromFixture());
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    expect(checksum(frame.data)).toBe(62);
    expect(checksum(frame.data)).toBe(frame.declaredChecksum);
  });

  it('is not the EOF sentinel', () => {
    const frame = parseFrame(screenFromFixture());
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    expect(isEofData(frame.data)).toBe(false);
  });

  it('decodes to the real contents of SYS1.PARMLIB(IEASYS00)', () => {
    // The frame's data is handed back RAW, so the caller's own CutCodec --
    // whose quadrant persists across every frame of the transfer -- does the
    // decoding. This is the first frame of the transfer, so a fresh codec is
    // the correct state here.
    const frame = parseFrame(screenFromFixture());
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    const decoded = new CutCodec().hostToLocal(frame.data);

    // 1904 encoded bytes -> 1498 file bytes: the encoding is 1 byte per source
    // byte while the quadrant holds and 2 when it changes, so a shrink of this
    // size is the quadrant machinery genuinely working, not a coincidence.
    expect(decoded).toHaveLength(1498);

    const text = Buffer.from(decoded).toString('latin1');
    expect(text.startsWith(' APF=00,')).toBe(true);

    // NOTE ON THE FIXTURE'S OWN ANNOTATION: its header quotes this content with
    // the column padding collapsed to five spaces (" APF=00,     Suffix for
    // ..."), because it was written as wrapped prose in a comment block. The
    // real member is padded to a fixed column -- 22 spaces after the comma --
    // which is what the assertions below use. The bytes are the same; only the
    // header's whitespace is abridged.
    expect(text.slice(0, 74)).toBe(
      ' APF=00,                      Suffix for authorized lib list IEAAPFxx\r\n' +
        ' AP',
    );
    // \r\n is the CRLF option the IND$FILE command asked for, and the next two
    // lines the header records are present.
    expect(text).toContain(' APG=07,                      Automatic Prority Group\r\n');
    expect(text).toContain(' BLDLF=BA,                    Suffix for BLDL list IEABLDxx\r\n');
  });
});

describe('frame detection, ft_cut.c:394', () => {
  // `if (ea_buf[O_SF].fa && FA_IS_SKIP(ea_buf[O_SF].fa))`, where FA_IS_SKIP is
  // `((c) & FA_PROTECT) && ((c) & FA_NUMERIC)` (3270ds.h:207) -- the same
  // computation Screen.makeField does for Field.autoSkip.

  it('accepts an auto-skip attribute at 1919', () => {
    const screen = blankScreen();
    screen.setFieldAttribute(O_SF, FA.PROTECT | FA.NUMERIC);
    expect(isCutFrame(screen)).toBe(true);
    // And agrees with the screen model's own notion of auto-skip, which is what
    // "be consistent with fieldAt" means concretely.
    expect(screen.fieldAt(O_SF)?.autoSkip).toBe(true);
  });

  it('accepts the host’s real 0x7c, so the test is by mask and not by value', () => {
    // Masks matter because the byte carries other bits: TK5 sends 0x7c, x3270's
    // own ctlr_add_fa would store 0xfc for the same field (it ORs in
    // FA_PRINTABLE, ctlr.c:2812), and both are auto-skip.
    for (const attr of [0x7c, 0xfc, 0x30, FA.PROTECT | FA.NUMERIC | FA.MODIFY]) {
      const screen = blankScreen();
      screen.setFieldAttribute(O_SF, attr);
      expect(isCutFrame(screen)).toBe(true);
    }
  });

  it('rejects a normal field at 1919', () => {
    // FA_IS_SKIP needs BOTH bits, so each of these must fail: an ordinary
    // protected field, an ordinary unprotected one, a numeric-but-unprotected
    // input field, and a bare zero attribute.
    for (const attr of [
      FA.PRINTABLE | FA.PROTECT, // 0xe0: protected, not numeric
      FA.PRINTABLE, // 0xc0: a plain unprotected field, as a real host sends it
      FA.PRINTABLE | FA.NUMERIC, // 0xd0: numeric entry field, not protected
      0x00, // what SFE stores when no 0xC0 pair is present
    ]) {
      const screen = blankScreen();
      screen.setFieldAttribute(O_SF, attr);
      expect(isCutFrame(screen)).toBe(false);
    }
  });

  it('rejects an empty screen', () => {
    expect(isCutFrame(blankScreen())).toBe(false);
  });

  it('is not fooled by an auto-skip field EARLIER in the buffer', () => {
    // The reason this uses attributeAt and not fieldAt: fieldAt(1919) scans
    // BACKWARDS for the attribute governing 1919, which here is the one at 0.
    // Testing that field's autoSkip would answer a different question and
    // report a CUT frame on an ordinary protected screen.
    const screen = blankScreen();
    screen.setFieldAttribute(0, FA.PROTECT | FA.NUMERIC);
    expect(screen.fieldAt(O_SF)?.autoSkip).toBe(true);
    expect(isCutFrame(screen)).toBe(false);
  });
});

describe('parseFrame', () => {
  it('parses a control code with a host message', () => {
    // SC_ABORT_FILE carries text at O_CC_MESSAGE for the user to see
    // (ft_cut.c:457-482). cp037 is right here and wrong in the codec: this is
    // host text meant for a human, not a TABLE6/ALPHAS lookup.
    const screen = blankScreen();
    markCutFrame(screen);
    poke(screen, O_FRAME_TYPE, [FrameType.CONTROL_CODE]);
    poke(screen, O_CC_FRAME_SEQ, [to6(3)]);
    poke(screen, O_CC_STATUS_CODE, [0x81, 0x94]); // SC_ABORT_FILE
    poke(screen, O_CC_MESSAGE, Array.from(cp037.encode('TRANS13 - Error writing file')));

    expect(parseFrame(screen)).toEqual({
      kind: 'controlCode',
      seq: 3,
      rawSeq: to6(3),
      status: StatusCode.ABORT_FILE,
      message: 'TRANS13 - Error writing file',
    });
    expect(isKnownStatusCode(StatusCode.ABORT_FILE)).toBe(true);
  });

  it('strips trailing blanks, then a trailing $, then blanks again', () => {
    // ft_cut.c:470-479, in that order. The '$' is IND$FILE's own message
    // terminator, and the second blank strip exists because removing it can
    // expose more padding.
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.CONTROL_CODE]);
    poke(screen, O_CC_STATUS_CODE, [0x81, 0x98]);
    poke(screen, O_CC_MESSAGE, Array.from(cp037.encode('TRANS99 - done   $   ')));
    const frame = parseFrame(screen);
    if (frame.kind !== 'controlCode') throw new Error('expected a control code');
    expect(frame.message).toBe('TRANS99 - done');
  });

  it('reads exactly 80 message bytes and no more', () => {
    // The 81st byte must not appear, or a long message would leak whatever the
    // host painted after the field.
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.CONTROL_CODE]);
    poke(screen, O_CC_STATUS_CODE, [0x81, 0x81]);
    poke(screen, O_CC_MESSAGE, Array.from(cp037.encode('A'.repeat(90))));
    const frame = parseFrame(screen);
    if (frame.kind !== 'controlCode') throw new Error('expected a control code');
    expect(frame.message).toBe('A'.repeat(CC_MESSAGE_LENGTH));
  });

  it('yields an empty message when the host sent only blanks', () => {
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.CONTROL_CODE]);
    poke(screen, O_CC_STATUS_CODE, [0x81, 0x89]);
    poke(screen, O_CC_MESSAGE, new Array(CC_MESSAGE_LENGTH).fill(0x40)); // EBCDIC space
    const frame = parseFrame(screen);
    if (frame.kind !== 'controlCode') throw new Error('expected a control code');
    expect(frame.message).toBe('');
  });

  it('reports an unrecognised status code rather than rejecting it', () => {
    // x3270 aborts with ftCutUnknownControl (ft_cut.c:487-490), but aborting is
    // the state machine's decision and it needs the code to report. So the
    // frame parses and isKnownStatusCode says no.
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.CONTROL_CODE]);
    poke(screen, O_CC_STATUS_CODE, [0x82, 0x77]);
    const frame = parseFrame(screen);
    if (frame.kind !== 'controlCode') throw new Error('expected a control code');
    expect(frame.status).toBe(0x8277);
    expect(isKnownStatusCode(frame.status)).toBe(false);
    expect(isKnownStatusCode(StatusCode.HOST_ACK)).toBe(true);
  });

  it('parses a data request, keeping the raw sequence byte for echoing', () => {
    // `unsigned char seq = ea_buf[O_DR_FRAME_SEQ].ec;` (ft_cut.c:500), echoed
    // verbatim at ft_cut.c:549 -- never re-encoded from the decoded number.
    const screen = blankScreen();
    markCutFrame(screen);
    poke(screen, O_FRAME_TYPE, [FrameType.DATA_REQUEST]);
    poke(screen, O_DR_FRAME_SEQ, [to6(7)]);
    expect(parseFrame(screen)).toEqual({ kind: 'dataRequest', seq: 7, rawSeq: to6(7) });
  });

  it('keeps rawSeq distinct from to6(seq) when the host byte is off-alphabet', () => {
    // WHY BOTH FORMS EXIST. from6 maps all 192 non-alphabet bytes to 0
    // (ft_cut.c:590-592), so re-encoding a decoded sequence would turn such a
    // byte into to6(0) = 'a' = 0x81 and put a byte on the wire the host never
    // sent. 0x4a decodes to 0 but is not to6(0).
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.DATA_REQUEST]);
    poke(screen, O_DR_FRAME_SEQ, [0x4a]);
    const frame = parseFrame(screen);
    if (frame.kind !== 'dataRequest') throw new Error('expected a data request');
    expect(frame.seq).toBe(0);
    expect(frame.rawSeq).toBe(0x4a);
    expect(to6(frame.seq)).not.toBe(frame.rawSeq);
  });

  it('parses a retransmit, which carries nothing but its type', () => {
    // `cut_retransmit` (ft_cut.c:573-578) reads no other field.
    const screen = blankScreen();
    markCutFrame(screen);
    poke(screen, O_FRAME_TYPE, [FrameType.RETRANSMIT]);
    poke(screen, O_DT_FRAME_SEQ, [to6(9)]); // present and deliberately ignored
    expect(parseFrame(screen)).toEqual({ kind: 'retransmit' });
  });

  it('parses a data frame, decoding the 12-bit length from two 6-bit chars', () => {
    // `raw_length = from6(ea_buf[O_DT_LEN].ec) << 6 |
    //               from6(ea_buf[O_DT_LEN + 1].ec);` (ft_cut.c:615-616).
    const screen = blankScreen();
    markCutFrame(screen);
    const payload = [0x5e, 0xc1, 0xc2, 0xc3, 0x7e, 0x81];
    poke(screen, O_FRAME_TYPE, [FrameType.DATA]);
    poke(screen, O_DT_FRAME_SEQ, [to6(2)]);
    poke(screen, O_DT_CSUM, [to6(checksum(payload))]);
    poke(screen, O_DT_LEN, [to6((payload.length >> 6) & 0x3f), to6(payload.length & 0x3f)]);
    poke(screen, O_DT_DATA, payload);

    const frame = parseFrame(screen);
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    expect(frame.seq).toBe(2);
    expect(frame.length).toBe(payload.length);
    expect(Array.from(frame.data)).toEqual(payload);
    expect(frame.declaredChecksum).toBe(checksum(payload));
  });

  it('decodes a length that needs both 6-bit characters', () => {
    // A single-character length maxes out at 63, so a value above that is the
    // only thing that proves the high char is read at all.
    const screen = blankScreen();
    const len = 1234; // 1234 = 19 * 64 + 18
    poke(screen, O_FRAME_TYPE, [FrameType.DATA]);
    poke(screen, O_DT_LEN, [to6(19), to6(18)]);
    for (let i = 0; i < len; i++) screen.setChar(O_DT_DATA + i, 0x40 + (i % 0x30));
    const frame = parseFrame(screen);
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    expect(frame.length).toBe(1234);
    expect(frame.data).toHaveLength(1234);
  });

  it('hands back a COPY of the data, so a later screen write cannot change it', () => {
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.DATA]);
    poke(screen, O_DT_LEN, [to6(0), to6(3)]);
    poke(screen, O_DT_DATA, [0x5e, 0xc1, 0xc2]);
    const frame = parseFrame(screen);
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    screen.setChar(O_DT_DATA, 0x00);
    expect(frame.data[0]).toBe(0x5e);
  });

  it('accepts a data frame of exactly MAX_DOWNLOAD_DATA bytes', () => {
    // The boundary the live host actually sends: the capture's full frames are
    // `data[1909]`, exactly O_RESPONSE - O_DT_DATA.
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.DATA]);
    poke(screen, O_DT_LEN, [
      to6((MAX_DOWNLOAD_DATA >> 6) & 0x3f),
      to6(MAX_DOWNLOAD_DATA & 0x3f),
    ]);
    // The last data byte sits at 1913, one before O_RESPONSE -- so a maximal
    // download frame stops exactly where the response area begins. Mark that
    // cell, and the one after it, so the copy loop's end is checked rather than
    // inferred from a length that could be right while the loop was off by one.
    expect(O_DT_DATA + MAX_DOWNLOAD_DATA - 1).toBe(O_RESPONSE - 1);
    screen.setChar(O_RESPONSE - 1, 0xc9);
    screen.setChar(O_RESPONSE, 0xd9); // must NOT appear in the payload

    const frame = parseFrame(screen);
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    expect(frame.length).toBe(MAX_DOWNLOAD_DATA);
    expect(frame.data).toHaveLength(MAX_DOWNLOAD_DATA);
    expect(frame.data[MAX_DOWNLOAD_DATA - 1]).toBe(0xc9);
    expect(Array.from(frame.data)).not.toContain(0xd9);
  });

  it('rejects an oversize length with SC_ABORT_XMIT', () => {
    // `if ((int)raw_length > O_RESPONSE - O_DT_DATA) { cut_abort(
    //      get_message("ftCutOversize"), SC_ABORT_XMIT); return; }`
    // (ft_cut.c:617-620). One byte over the limit, so the comparison's
    // strictness is pinned too.
    const screen = blankScreen();
    const len = MAX_DOWNLOAD_DATA + 1;
    poke(screen, O_FRAME_TYPE, [FrameType.DATA]);
    poke(screen, O_DT_LEN, [to6((len >> 6) & 0x3f), to6(len & 0x3f)]);
    let caught: unknown;
    try {
      parseFrame(screen);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CutFrameError);
    expect((caught as CutFrameError).abortStatus).toBe(StatusCode.ABORT_XMIT);
    expect((caught as CutFrameError).message).toContain('1910');
  });

  it('rejects an unknown frame type with SC_ABORT_XMIT', () => {
    // `default: ... cut_abort(get_message("ftCutUnknownFrame"), SC_ABORT_XMIT)`
    // (ft_cut.c:408-411). NOT a silent default: an unrecognised frame type
    // means we have lost sync, and guessing would write a wrong file.
    const screen = blankScreen();
    markCutFrame(screen);
    poke(screen, O_FRAME_TYPE, [0x99]);
    let caught: unknown;
    try {
      parseFrame(screen);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CutFrameError);
    expect((caught as CutFrameError).abortStatus).toBe(StatusCode.ABORT_XMIT);
    expect((caught as CutFrameError).message).toContain('0x99');
  });

  it('treats a blank screen as an unknown frame type, not as some default', () => {
    // 0x00 at O_FRAME_TYPE is no frame type at all. Silently defaulting to,
    // say, FT_DATA would read a length of 0 and ack an empty frame forever.
    expect(() => parseFrame(blankScreen())).toThrow(CutFrameError);
  });
});

describe('isEofData, ft_cut.c:625', () => {
  it('accepts exactly the two-byte sentinel', () => {
    expect(isEofData([EOF_DATA1, EOF_DATA2])).toBe(true);
    expect(isEofData(Uint8Array.from([0x5c, 0xa9]))).toBe(true);
  });

  it('requires the length to be 2, not merely a 5c a9 prefix', () => {
    // `if (raw_length == 2 && cvbuf[0] == EOF_DATA1 && cvbuf[1] == EOF_DATA2)`.
    // The length is part of the test: 0x5c is quadrant 2's selector and 0xa9 an
    // ordinary encoded character, so a real data frame CAN start with these two
    // bytes, and treating it as EOF would truncate the file.
    expect(QUADRANTS[2]!.selector).toBe(0x5c);
    expect(isEofData([EOF_DATA1, EOF_DATA2, 0xc1])).toBe(false);
    expect(isEofData([EOF_DATA1])).toBe(false);
    expect(isEofData([])).toBe(false);
  });

  it('rejects the sentinel reversed or altered', () => {
    expect(isEofData([EOF_DATA2, EOF_DATA1])).toBe(false);
    expect(isEofData([EOF_DATA1, 0xa8])).toBe(false);
  });
});

describe('writeResponse, ft_cut.c:662-678', () => {
  it('writes frame type, sequence and both reason bytes at the RO_ offsets', () => {
    //     ctlr_add(RO_FRAME_TYPE, RFT_CONTROL_CODE, 0);
    //     ctlr_add(RO_FRAME_SEQ, ea_buf[O_DT_FRAME_SEQ].ec, 0);
    //     ctlr_add(RO_REASON_CODE, HIGH8(reason), 0);
    //     ctlr_add(RO_REASON_CODE+1, LOW8(reason), 0);
    const screen = blankScreen();
    writeResponse(screen, {
      frameType: ResponseFrameType.CONTROL_CODE,
      rawSeq: 0x82,
      reason: StatusCode.ABORT_XMIT,
    });
    expect(screen.cellAt(RO_FRAME_TYPE).ebcdic).toBe(0xc3);
    expect(screen.cellAt(RO_FRAME_SEQ).ebcdic).toBe(0x82);
    expect(screen.cellAt(RO_REASON_CODE).ebcdic).toBe(0x81); // HIGH8(0x8198)
    expect(screen.cellAt(RO_REASON_CODE + 1).ebcdic).toBe(0x98); // LOW8(0x8198)
  });

  it('leaves O_RESPONSE and O_SF alone', () => {
    // The host plants field attributes at both (`SBA(1914) SF(0xc1)` and
    // `SBA(1919) SF(0x7c)` in the live capture). Writing 1914 would destroy the
    // pre-armed MDT field the host reads our response out of; writing 1919
    // would destroy frame detection.
    const screen = blankScreen();
    screen.setFieldAttribute(O_RESPONSE, 0xc1);
    markCutFrame(screen);
    writeResponse(screen, {
      frameType: ResponseFrameType.CONTROL_CODE,
      rawSeq: 0x82,
      reason: StatusCode.ABORT_FILE,
    });
    expect(screen.attributeAt(O_RESPONSE)).toBe(0xc1);
    expect(screen.attributeAt(O_SF)).toBe(0x7c);
    // 0xc1 already carries FA.MODIFY, which is why nothing here has to set MDT
    // -- and x3270 does not either.
    expect((0xc1 & FA.MODIFY) !== 0).toBe(true);
    expect(isCutFrame(screen)).toBe(true);
  });

  it('leaves both reason bytes untouched when no reason is given', () => {
    const screen = blankScreen();
    poke(screen, RO_REASON_CODE, [0x11, 0x22]);
    writeResponse(screen, { frameType: ResponseFrameType.RETRANSMIT, rawSeq: 0x83 });
    expect(screen.cellAt(RO_FRAME_TYPE).ebcdic).toBe(0x4c);
    expect(screen.cellAt(RO_REASON_CODE).ebcdic).toBe(0x11);
    expect(screen.cellAt(RO_REASON_CODE + 1).ebcdic).toBe(0x22);
  });

  it('echoes the raw sequence byte from a parsed frame', () => {
    // End to end through parseFrame, so the rawSeq/seq distinction is exercised
    // the way the state machine will use it.
    const screen = blankScreen();
    poke(screen, O_FRAME_TYPE, [FrameType.DATA]);
    poke(screen, O_DT_FRAME_SEQ, [0x4a]); // off-alphabet: from6 -> 0
    poke(screen, O_DT_LEN, [to6(0), to6(0)]);
    const frame = parseFrame(screen);
    if (frame.kind !== 'data') throw new Error('expected a data frame');
    writeResponse(screen, {
      frameType: ResponseFrameType.CONTROL_CODE,
      rawSeq: frame.rawSeq,
      reason: StatusCode.ABORT_XMIT,
    });
    expect(screen.cellAt(RO_FRAME_SEQ).ebcdic).toBe(0x4a);
  });
});

describe('writeUploadData, ft_cut.c:513-556', () => {
  it('writes encoded data at O_UP_DATA with sequence, checksum and length', () => {
    const screen = blankScreen();
    const codec = new CutCodec();
    // All four bytes are in quadrant 0 (0xc1..0xc4 at ALPHAS indices 1..4), so
    // the only expansion is the one leading selector a fresh codec must emit.
    const src = Uint8Array.from([0xc1, 0xc2, 0xc3, 0xc4]);
    const r = writeUploadData(screen, { rawSeq: to6(1), data: src, codec });

    expect(r.consumed).toBe(4);
    expect(r.encodedLength).toBe(5); // selector + 4 characters

    const written = Array.from(
      { length: r.encodedLength },
      (_, i) => screen.cellAt(O_UP_DATA + i).ebcdic,
    );
    expect(written[0]).toBe(QUADRANTS[0]!.selector);
    expect(written).toEqual(Array.from(new CutCodec().localToHost(src)));

    // `ctlr_add(O_UP_FRAME_SEQ, seq, 0)` -- the RAW byte (ft_cut.c:549).
    expect(screen.cellAt(O_UP_FRAME_SEQ).ebcdic).toBe(to6(1));
    // `ctlr_add(O_UP_CSUM, asc2ebc0[table6[cs & 0x3f]], 0)` over the ENCODED
    // bytes as they sit in the buffer (ft_cut.c:551-554).
    expect(screen.cellAt(O_UP_CSUM).ebcdic).toBe(to6(checksum(written)));
    // Two 6-bit characters, high then low (ft_cut.c:555-556).
    expect(screen.cellAt(O_UP_LEN).ebcdic).toBe(to6((5 >> 6) & 0x3f));
    expect(screen.cellAt(O_UP_LEN + 1).ebcdic).toBe(to6(5 & 0x3f));
    // And the length decodes back to what was written, which is the property
    // the host actually depends on.
    expect(
      (from6(screen.cellAt(O_UP_LEN).ebcdic) << 6) | from6(screen.cellAt(O_UP_LEN + 1).ebcdic),
    ).toBe(r.encodedLength);
  });

  it('reports consumed < encodedLength when a quadrant change expands the data', () => {
    // THE CASE THAT JUSTIFIES THE RETURN VALUE. 0xc1 is in quadrant 0 and 0x41
    // in quadrant 1, both at ALPHAS index 1, so alternating them forces a
    // selector before every single byte: 6 source bytes become 12 encoded ones.
    // The caller could not have predicted that, which is why this function
    // decides how much fits and reports it.
    const screen = blankScreen();
    const src = Uint8Array.from([0xc1, 0x41, 0xc1, 0x41, 0xc1, 0x41]);
    const r = writeUploadData(screen, { rawSeq: to6(1), data: src, codec: new CutCodec() });
    expect(r.consumed).toBe(6);
    expect(r.encodedLength).toBe(12);
    expect(r.consumed).toBeLessThan(r.encodedLength);
    for (let i = 0; i < 12; i += 2) {
      expect(screen.cellAt(O_UP_DATA + i).ebcdic).toBe(QUADRANTS[i % 4 === 0 ? 0 : 1]!.selector);
    }
  });

  it('stops at O_UP_MAX and reports how many SOURCE bytes it took', () => {
    // Worst-case expansion, 2 encoded bytes per source byte, so 956 source
    // bytes exactly fill the 1912-byte frame and the remaining 44 wait for the
    // next one.
    const screen = blankScreen();
    markCutFrame(screen);
    const src = new Uint8Array(1000);
    for (let i = 0; i < src.length; i++) src[i] = i % 2 === 0 ? 0xc1 : 0x41;

    const r = writeUploadData(screen, { rawSeq: to6(1), data: src, codec: new CutCodec() });
    expect(r.encodedLength).toBe(O_UP_MAX);
    expect(r.consumed).toBe(956);
    expect(r.consumed).toBeLessThan(src.length);
    expect(r.consumed * 2).toBe(O_UP_MAX);
    // A maximal frame reaches 1918 -- the last cell before O_SF. So it DOES
    // overwrite the response area, which is x3270's behaviour and harmless
    // (the host is asking for data, not reading a response), but it must never
    // touch O_SF or frame detection would die.
    expect(O_UP_DATA + O_UP_MAX - 1).toBe(O_SF - 1);
    expect(screen.attributeAt(O_SF)).toBe(0x7c);
    expect(isCutFrame(screen)).toBe(true);
  });

  it('never splits one source byte’s encoding across a frame boundary', () => {
    // WHERE WE DIVERGE FROM x3270, deliberately. x3270 fills to exactly
    // O_UP_MAX by buffering leftover encoded bytes in xlate_buf
    // (ft_cut.c:696-702, :751-760), so a selector can land in one frame and its
    // character in the next. We stop with fewer than 2 bytes of room, wasting
    // at most one byte per 1912 and needing no cross-frame buffer. Safe because
    // the host concatenates payloads: a frame boundary inside the encoded
    // stream has no protocol meaning.
    //
    // The exact boundary: 1910 single-cost bytes leave two bytes of room, and
    // the next byte needs both of them. Selector and character must land
    // together in this frame, filling it to O_UP_MAX exactly.
    const screen = blankScreen();
    const codec = new CutCodec();
    const src = new Uint8Array(1913);
    src.fill(0x41); // quadrant 1 from index 1910 on
    src.fill(0xc1, 0, 1910); // quadrant 0 for the first 1910
    // Prime the codec into quadrant 0 so the first byte costs 1, not 2 --
    // exactly the mid-transfer state a second frame starts in.
    codec.localToHost(Uint8Array.from([0xc1]));
    expect(codec.currentQuadrant).toBe(0);

    const r = writeUploadData(screen, { rawSeq: to6(2), data: src, codec });
    expect(r.consumed).toBe(1911); // 1910 cheap bytes plus one costing two
    expect(r.encodedLength).toBe(O_UP_MAX);
    // The pair went in together: the last two encoded bytes are quadrant 1's
    // selector and its character, not a selector orphaned at the frame end.
    expect(screen.cellAt(O_UP_DATA + O_UP_MAX - 2).ebcdic).toBe(QUADRANTS[1]!.selector);
    expect(screen.cellAt(O_UP_DATA + O_UP_MAX - 1).ebcdic).not.toBe(QUADRANTS[1]!.selector);
    // And the codec's quadrant moved with it, so the next frame continues from
    // quadrant 1 with no repeated selector.
    expect(codec.currentQuadrant).toBe(1);
    expect(r.consumed).toBeLessThan(src.length);
  });

  it('leaves at most one byte of a frame unused at a quadrant boundary', () => {
    // The other side of the divergence above: when the byte that does not fit
    // needs two bytes and only one remains, the frame is 1911 long. That single
    // wasted byte is the entire cost of not having a cross-frame buffer.
    const screen = blankScreen();
    const codec = new CutCodec();
    const src = new Uint8Array(1913);
    for (let i = 0; i < 1911; i++) src[i] = 0xc1;
    src[1911] = 0x41;
    src[1912] = 0x41;
    codec.localToHost(Uint8Array.from([0xc1])); // prime quadrant 0
    const r = writeUploadData(screen, { rawSeq: to6(2), data: src, codec });
    // 1911 * 1 = 1911 encoded, one byte of room left, next byte needs 2.
    expect(r.consumed).toBe(1911);
    expect(r.encodedLength).toBe(1911);
    expect(O_UP_MAX - r.encodedLength).toBe(1);
  });

  it('continues a transfer with ONE codec, emitting no spurious selector', () => {
    // FINDING 3 IN THE DESIGN DOC, as an executable check. The quadrant is
    // persistent state and a selector is emitted only on change, so a codec
    // constructed per frame would put a leading selector on every frame after
    // the first -- bytes the host never asked for, corrupting the upload.
    const codec = new CutCodec();
    const src = Uint8Array.from([0xc1, 0xc2, 0xc3, 0xc4]);

    const first = blankScreen();
    const r1 = writeUploadData(first, { rawSeq: to6(1), data: src, codec });
    expect(r1.encodedLength).toBe(5); // selector + 4

    const second = blankScreen();
    const r2 = writeUploadData(second, { rawSeq: to6(2), data: src, codec });
    expect(r2.encodedLength).toBe(4); // NO selector: the quadrant carried over
    expect(second.cellAt(O_UP_DATA).ebcdic).not.toBe(QUADRANTS[0]!.selector);

    // And a fresh codec would have produced the wrong thing, which is the
    // failure this guards against.
    const wrong = blankScreen();
    const rBad = writeUploadData(wrong, {
      rawSeq: to6(2),
      data: src,
      codec: new CutCodec(),
    });
    expect(rBad.encodedLength).toBe(5);
    expect(wrong.cellAt(O_UP_DATA).ebcdic).toBe(QUADRANTS[0]!.selector);
  });

  it('consumes nothing, and writes a zero length, for empty data', () => {
    // Not end of file -- that is writeUploadEof. A caller must distinguish the
    // two, so the zero case is pinned rather than left to inference.
    const screen = blankScreen();
    const r = writeUploadData(screen, { rawSeq: to6(1), data: [], codec: new CutCodec() });
    expect(r).toEqual({ consumed: 0, encodedLength: 0 });
    expect(screen.cellAt(O_UP_LEN).ebcdic).toBe(to6(0));
    expect(screen.cellAt(O_UP_LEN + 1).ebcdic).toBe(to6(0));
    expect(screen.cellAt(O_UP_CSUM).ebcdic).toBe(to6(0));
  });

  it('encodes a nasty binary payload the way a whole-buffer conversion would', () => {
    // A text file exercises none of the quadrant machinery. NULL, 0xFF, and
    // bytes from each of the four quadrants do -- and NULL is the one the codec
    // must special-case, since it sits at index 0 of two quadrants.
    const screen = blankScreen();
    const src = Uint8Array.from([0x00, 0xff, 0x40, 0x41, 0xc1, 0xa0, 0x00, 0x5c, 0x1a]);
    const codec = new CutCodec();
    const r = writeUploadData(screen, { rawSeq: to6(1), data: src, codec });
    expect(r.consumed).toBe(src.length);
    const written = Array.from(
      { length: r.encodedLength },
      (_, i) => screen.cellAt(O_UP_DATA + i).ebcdic,
    );
    // Same bytes a single whole-buffer conversion produces: the per-byte
    // feeding this function does must not change the encoding.
    expect(written).toEqual(Array.from(new CutCodec().localToHost(src)));
    // And it round-trips, which is the property the transferred file depends on.
    expect(Array.from(new CutCodec().hostToLocal(Uint8Array.from(written)))).toEqual(
      Array.from(src),
    );
  });

  it('hides the data field, preserving MDT, when the host planted one at O_DR_SF', () => {
    // "XXX: Change the data field attribute so it doesn't display."
    //     attr = (attr & ~FA_INTENSITY) | FA_INT_ZERO_NSEL;
    // (ft_cut.c:558-561). Cosmetic, but it must not clear MDT or the host would
    // never read the frame back.
    const screen = blankScreen();
    screen.setFieldAttribute(O_DR_SF, FA.PRINTABLE | FA.INT_HIGH_SEL | FA.MODIFY);
    writeUploadData(screen, { rawSeq: to6(1), data: [0xc1], codec: new CutCodec() });
    const attr = screen.attributeAt(O_DR_SF);
    expect(attr).not.toBeNull();
    expect(attr! & FA.INTENSITY).toBe(FA.INT_ZERO_NSEL);
    expect(attr! & FA.MODIFY).toBe(FA.MODIFY);
    expect(attr! & FA.PRINTABLE).toBe(FA.PRINTABLE);
  });

  it('does not INVENT a field attribute at O_DR_SF when there is none', () => {
    // Where we diverge from x3270 once more, and this one is about our screen
    // model rather than the protocol. x3270 reads `.fa` as 0 when no field is
    // there and its ctlr_add_fa then CREATES one; doing that here would change
    // the buffer's field structure behind the host's back.
    const screen = blankScreen();
    writeUploadData(screen, { rawSeq: to6(1), data: [0xc1], codec: new CutCodec() });
    expect(screen.attributeAt(O_DR_SF)).toBeNull();
  });
});

describe('writeUploadEof, ft_cut.c:541-546', () => {
  it('writes the sentinel RAW, with a length of 2 and a checksum over it', () => {
    //     ctlr_add(O_UP_DATA, EOF_DATA1, 0);
    //     ctlr_add(O_UP_DATA+1, EOF_DATA2, 0);
    //     count = 2;
    // then the same checksum and length code as a data frame.
    const screen = blankScreen();
    writeUploadEof(screen, to6(5));
    expect(screen.cellAt(O_UP_DATA).ebcdic).toBe(EOF_DATA1);
    expect(screen.cellAt(O_UP_DATA + 1).ebcdic).toBe(EOF_DATA2);
    expect(screen.cellAt(O_UP_FRAME_SEQ).ebcdic).toBe(to6(5));
    expect(screen.cellAt(O_UP_CSUM).ebcdic).toBe(to6(checksum([EOF_DATA1, EOF_DATA2])));
    expect(screen.cellAt(O_UP_LEN).ebcdic).toBe(to6(0));
    expect(screen.cellAt(O_UP_LEN + 1).ebcdic).toBe(to6(2));
  });

  it('does NOT push the sentinel through the codec', () => {
    // 0x5c is quadrant 2's selector, so encoding it would emit something else
    // entirely AND move the quadrant, which is why this is a separate function
    // rather than a flag on writeUploadData.
    expect(QUADRANTS[2]!.selector).toBe(EOF_DATA1);
    const encoded = new CutCodec().localToHost(Uint8Array.from([EOF_DATA1, EOF_DATA2]));
    expect(Array.from(encoded)).not.toEqual([EOF_DATA1, EOF_DATA2]);
    const screen = blankScreen();
    writeUploadEof(screen, to6(5));
    expect(Array.from([0, 1].map((i) => screen.cellAt(O_UP_DATA + i).ebcdic))).toEqual([
      EOF_DATA1,
      EOF_DATA2,
    ]);
  });

  it('lays the sentinel out at the UPLOAD offsets, not the download ones', () => {
    // A REAL TRAP, and worth an explicit test: the upload area's sequence,
    // checksum and length live at 3, 4, 5-6 (ft_cut_ds.h:77-79) while a
    // download data frame's live at 1, 2, 3-4 (ft_cut_ds.h:51-53), and the data
    // starts at 7 rather than 5. The two layouts are NOT the same, so writing
    // one and reading it with the other parser is meaningless.
    //
    // Confirm the offsets genuinely differ, then that nothing was written at
    // the download offsets -- which is what would silently happen if the
    // upload writer reached for the wrong constants.
    expect([O_UP_FRAME_SEQ, O_UP_CSUM, O_UP_LEN, O_UP_DATA]).toEqual([3, 4, 5, 7]);
    expect([O_DT_FRAME_SEQ, O_DT_CSUM, O_DT_LEN, O_DT_DATA]).toEqual([1, 2, 3, 5]);

    const screen = blankScreen();
    writeUploadEof(screen, to6(5));
    // Offsets 1 and 2 -- the download frame's sequence and checksum -- are
    // outside the upload layout and must be untouched.
    expect(screen.cellAt(O_DT_FRAME_SEQ).ebcdic).toBe(0x00);
    expect(screen.cellAt(O_DT_CSUM).ebcdic).toBe(0x00);
    // Offsets 5 and 6 are the upload LENGTH, which is also where a download
    // frame's length and first data byte would be. So they are non-zero, but
    // they hold to6(0) and to6(2), not the sentinel.
    expect(screen.cellAt(O_UP_LEN).ebcdic).toBe(to6(0));
    expect(screen.cellAt(O_UP_LEN + 1).ebcdic).toBe(to6(2));
    // And the sentinel is at 7-8, where the upload area puts data.
    expect(screen.cellAt(O_UP_DATA).ebcdic).toBe(EOF_DATA1);
    expect(screen.cellAt(O_UP_DATA + 1).ebcdic).toBe(EOF_DATA2);
    // Nothing beyond the two sentinel bytes was written.
    expect(screen.cellAt(O_UP_DATA + 2).ebcdic).toBe(0x00);
  });

  it('leaves O_SF and frame detection intact', () => {
    const screen = blankScreen();
    markCutFrame(screen);
    writeUploadEof(screen, to6(5));
    expect(isCutFrame(screen)).toBe(true);
  });
});

describe('the geometry coupling', () => {
  // O_SF = 1919 is the last cell of a 24x80 buffer and of nothing else. On any
  // other geometry every offset here means something different, so each entry
  // point refuses rather than corrupting memory or silently doing nothing. The
  // design doc's "GEOMETRY COUPLING" section is what these tests enforce.

  const wrongSizes = [
    { rows: 32, cols: 80 }, // model 3
    { rows: 43, cols: 80 }, // model 4
    { rows: 27, cols: 132 }, // model 5
    { rows: 24, cols: 79 }, // one column short: 1896 cells, O_SF past the end
  ];

  for (const geom of wrongSizes) {
    it(`rejects a ${geom.rows}x${geom.cols} screen everywhere`, () => {
      const screen = new Screen(geom);
      expect(screen.size).not.toBe(CUT_SCREEN_SIZE);
      expect(() => isCutFrame(screen)).toThrow(CutFrameError);
      expect(() => parseFrame(screen)).toThrow(CutFrameError);
      expect(() =>
        writeResponse(screen, { frameType: ResponseFrameType.CONTROL_CODE, rawSeq: 0x81 }),
      ).toThrow(CutFrameError);
      expect(() =>
        writeUploadData(screen, { rawSeq: 0x81, data: [0xc1], codec: new CutCodec() }),
      ).toThrow(CutFrameError);
      expect(() => writeUploadEof(screen, 0x81)).toThrow(CutFrameError);
    });
  }

  it('explains itself in the message, and carries no abort status', () => {
    // A local configuration bug, not something the host did wrong -- so there
    // is no status code to send it, unlike an oversize or unknown frame.
    const screen = new Screen({ rows: 43, cols: 80 });
    let caught: unknown;
    try {
      isCutFrame(screen);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CutFrameError);
    expect((caught as CutFrameError).abortStatus).toBeUndefined();
    expect((caught as CutFrameError).message).toContain('24x80');
    expect((caught as CutFrameError).message).toContain('3440');
  });

  it('accepts a 24x80 screen built either way', () => {
    // Default construction and explicit dimensions must both work, since the
    // session builds one and tests build the other.
    expect(() => isCutFrame(new Screen())).not.toThrow();
    expect(() => isCutFrame(new Screen({ rows: 24, cols: 80 }))).not.toThrow();
  });
});

describe('the 6-bit encodings this module relies on', () => {
  it('encodes every length O_UP_MAX allows in 12 bits', () => {
    // O_UP_MAX is 1912, which needs 11 bits, so two 6-bit characters are always
    // enough. Checked over the whole range rather than at the endpoints, since
    // the split is where an off-by-one would hide.
    for (let n = 0; n <= O_UP_MAX; n++) {
      const hi = to6((n >> 6) & 0x3f);
      const lo = to6(n & 0x3f);
      expect((from6(hi) << 6) | from6(lo)).toBe(n);
    }
    expect(O_UP_MAX).toBeLessThan(1 << 12);
  });

  it('encodes a checksum as one TABLE6 character', () => {
    for (let cs = 0; cs < 64; cs++) {
      expect(from6(to6(cs))).toBe(cs);
    }
    expect(TABLE6).toHaveLength(64);
  });
});
