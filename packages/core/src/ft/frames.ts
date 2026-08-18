/**
 * IND$FILE CUT-mode frame layout over a `Screen`.
 *
 * CUT is the 3270 screen used as a data pipe: the host plants a structured
 * field at the last cell of a 24x80 buffer and both sides read and write data at
 * fixed offsets inside that buffer. This module owns those offsets — reading a
 * frame out of a screen, and writing a response or an upload frame in. It is
 * pure with respect to I/O: no sockets, no session, no files. The codec is
 * `ft/cut.ts`; the state machine and the CLI action are later units. See
 * docs/superpowers/specs/2026-08-18-indfile-cut-transfer-design.md.
 *
 * Every constant below is cited to x3270 4.5 `include/ft_cut_ds.h`, which is 82
 * lines and documents the whole wire format, and every behaviour to
 * `Common/ft_cut.c`. Where CUT is underspecified the design doc's governing
 * principle applies: do what x3270 does, because it is the client these hosts
 * have actually been driven with for decades.
 *
 * ## THE GEOMETRY COUPLING IS LOAD-BEARING
 *
 * `O_SF` is 1919, which is the last cell of a 24x80 buffer and nothing else.
 * Stage 2a pinned the advertised geometry to 24x80 as both default and alternate
 * size, so this works today, and the design doc's "GEOMETRY COUPLING" section
 * warns whoever implements alternate screen sizes that these two facts are
 * coupled. Every entry point here therefore calls `requireCutGeometry` and
 * THROWS on a differently-sized screen rather than reading or writing cells that
 * mean something else. See that function for why throwing beats returning false.
 *
 * ## ONE CODEC PER TRANSFER
 *
 * `writeUploadData` takes a `CutCodec` rather than constructing one. The
 * quadrant is persistent state and a selector byte is emitted only when it
 * changes, so a per-frame codec would emit a spurious leading selector on every
 * upload frame after the first. This is finding 3 in the design doc and it is
 * why no function in this file ever calls `new CutCodec()`.
 *
 * ## SEQUENCE NUMBERS AND CHECKSUMS ARE ECHOED RAW, NEVER RE-ENCODED
 *
 * A trap that would produce a wrong byte on the wire while every decoded value
 * looked right. x3270 echoes the frame sequence back as the RAW EBCDIC byte it
 * received — `ctlr_add(O_UP_FRAME_SEQ, seq, 0)` where `seq =
 * ea_buf[O_DR_FRAME_SEQ].ec` (ft_cut.c:500, :549), and likewise
 * `ctlr_add(RO_FRAME_SEQ, ea_buf[O_DT_FRAME_SEQ].ec, 0)` (ft_cut.c:670). It
 * never runs the decoded number back through `to6`. Because `from6`/`to6` are
 * inverses over the 64 real encodings the two agree for well-formed input, but
 * `from6` maps all 192 other bytes to 0 (ft_cut.c:590-592), so a host byte
 * outside the alphabet would come back as `to6(0)` = 'a' instead of itself.
 *
 * So the parsed frames carry BOTH forms — `seq` decoded for logic and display,
 * `rawSeq` for echoing — and the write functions take `rawSeq` under that name
 * precisely so that passing the wrong one does not typecheck as a mistake a
 * reader would miss.
 */

import { AID, FA } from '../constants.js';
import { cp037 } from '../codepage.js';
import type { Screen } from '../screen.js';
import { checksum, to6, from6, type CutCodec } from './cut.js';

// ---------------------------------------------------------------------------
// Wire constants, all from include/ft_cut_ds.h
// ---------------------------------------------------------------------------

/**
 * Offset to the CUT structured field. `#define O_SF 1919` (ft_cut_ds.h:33).
 *
 * This is the last cell of a 24x80 buffer. Its field attribute being auto-skip
 * is the whole of the frame-detection test; see `isCutFrame`.
 */
export const O_SF = 1919;

/** The only screen size CUT works on: 24 * 80. See `requireCutGeometry`. */
export const CUT_SCREEN_SIZE = 1920;

/** Offset to the frame type. `#define O_FRAME_TYPE 0` (ft_cut_ds.h:36). */
export const O_FRAME_TYPE = 0;

/**
 * Frame types, all host->us except FT_DATA which the header marks
 * "bidirectional" (ft_cut_ds.h:37, :45, :49, :50).
 */
export const FrameType = {
  /** `FT_CONTROL_CODE 0xc3` (ft_cut_ds.h:37). */
  CONTROL_CODE: 0xc3,
  /** `FT_DATA_REQUEST 0xc2` (ft_cut_ds.h:45). */
  DATA_REQUEST: 0xc2,
  /** `FT_RETRANSMIT 0x4c` (ft_cut_ds.h:49). */
  RETRANSMIT: 0x4c,
  /** `FT_DATA 0xc1` (ft_cut_ds.h:50). */
  DATA: 0xc1,
} as const;

/** Control-code frame: offset to frame sequence. ft_cut_ds.h:38. */
export const O_CC_FRAME_SEQ = 1;
/** Control-code frame: offset to the two-byte status code. ft_cut_ds.h:39. */
export const O_CC_STATUS_CODE = 2;
/** Control-code frame: offset of the message text. ft_cut_ds.h:44. */
export const O_CC_MESSAGE = 4;

/**
 * How many bytes of message text a control code carries.
 *
 * NOT in the header — it is the loop bound in x3270's `cut_control_code`,
 * `for (i = 0; i < 80; i++)` over `ea_buf[O_CC_MESSAGE + i].ec`
 * (ft_cut.c:460-469). One display line's worth, which is what the host paints.
 */
export const CC_MESSAGE_LENGTH = 80;

/** Status codes inside a control-code frame (ft_cut_ds.h:40-43). */
export const StatusCode = {
  /** `SC_HOST_ACK 0x8181` — ack of the IND$FILE command (ft_cut_ds.h:40). */
  HOST_ACK: 0x8181,
  /** `SC_XFER_COMPLETE 0x8189` — file transfer complete (ft_cut_ds.h:41). */
  XFER_COMPLETE: 0x8189,
  /** `SC_ABORT_FILE 0x8194` — abort, file error (ft_cut_ds.h:42). */
  ABORT_FILE: 0x8194,
  /** `SC_ABORT_XMIT 0x8198` — abort, transmission error (ft_cut_ds.h:43). */
  ABORT_XMIT: 0x8198,
} as const;

const KNOWN_STATUS_CODES: readonly number[] = [
  StatusCode.HOST_ACK,
  StatusCode.XFER_COMPLETE,
  StatusCode.ABORT_FILE,
  StatusCode.ABORT_XMIT,
];

/**
 * Whether a status code is one of the four the header names.
 *
 * `parseFrame` deliberately does NOT reject an unknown one, even though x3270
 * aborts with `ftCutUnknownControl` (ft_cut.c:487-490): aborting is a state
 * machine's decision and it needs the code to report, so the frame carries the
 * raw number and the caller uses this predicate. Contrast an unknown FRAME TYPE,
 * which is rejected here, because there is then no frame to hand anybody.
 */
export function isKnownStatusCode(status: number): boolean {
  return KNOWN_STATUS_CODES.includes(status);
}

/**
 * Data-request frame: offset to the start field. ft_cut_ds.h:46.
 *
 * The field attribute governing the upload data area. x3270 rewrites it
 * non-display after filling the area; see `writeUploadData`.
 */
export const O_DR_SF = 1;
/**
 * Data-request frame: offset to the data code. ft_cut_ds.h:47.
 *
 * Defined by the header and read by nothing: `grep -rn O_DR_DATA_CODE` over the
 * whole x3270 4.5 tree returns only the `#define`. Exported for completeness,
 * and not consulted, exactly as x3270 does not consult it.
 */
export const O_DR_DATA_CODE = 2;
/** Data-request frame: offset to frame sequence. ft_cut_ds.h:48. */
export const O_DR_FRAME_SEQ = 3;

/** Data frame: offset to frame sequence. ft_cut_ds.h:51. */
export const O_DT_FRAME_SEQ = 1;
/**
 * Data frame: offset to checksum. ft_cut_ds.h:52.
 *
 * x3270 NEVER READS THIS — `grep -rn O_DT_CSUM` over the tree returns only the
 * `#define`, a deliberate omission per the design doc. We read it because the
 * live TK5 capture proved the host populates it (6-bit 62, and our `checksum()`
 * over the same data computes 62), so a mismatch is a real diagnostic. The
 * design decision is "trace it, never abort on it": the protocol offers no
 * client-initiated retransmit to recover with, and MECAFF on VM/370 ignores the
 * field entirely on receive, so a mismatch must not fail a transfer x3270 would
 * have completed. `parseFrame` therefore reports the declared value and leaves
 * the comparison to the caller.
 */
export const O_DT_CSUM = 2;
/**
 * Data frame: offset to the length. ft_cut_ds.h:53.
 *
 * TWO bytes forming a 12-bit value, `from6(ea_buf[O_DT_LEN].ec) << 6 |
 * from6(ea_buf[O_DT_LEN + 1].ec)` (ft_cut.c:615-616).
 */
export const O_DT_LEN = 3;
/** Data frame: offset to the data. ft_cut_ds.h:54. */
export const O_DT_DATA = 5;

/** Offset to the response area. `#define O_RESPONSE (O_SF-5)` = 1914, ft_cut_ds.h:57. */
export const O_RESPONSE = O_SF - 5;
/** Response frame type. `(O_RESPONSE+1)` = 1915, ft_cut_ds.h:58. */
export const RO_FRAME_TYPE = O_RESPONSE + 1;
/** Response frame sequence. `(O_RESPONSE+2)` = 1916, ft_cut_ds.h:61. */
export const RO_FRAME_SEQ = O_RESPONSE + 2;
/**
 * Response reason code. `(O_RESPONSE+3)` = 1917, ft_cut_ds.h:62.
 *
 * TWO bytes, 1917 and 1918: x3270 writes `HIGH8(reason)` then `LOW8(reason)`
 * (ft_cut.c:671-672). 1918 is the last cell before `O_SF`, so the response area
 * exactly fills the gap the host leaves for it.
 */
export const RO_REASON_CODE = O_RESPONSE + 3;

/** Response frame types (ft_cut_ds.h:59-60). */
export const ResponseFrameType = {
  /**
   * `RFT_RETRANSMIT 0x4c` (ft_cut_ds.h:59).
   *
   * Like `O_DR_DATA_CODE`, defined by the header and written by nothing in
   * x3270 — its only abort path writes `RFT_CONTROL_CODE`. Exported because the
   * header names it, not because we have a use for it yet.
   */
  RETRANSMIT: 0x4c,
  /** `RFT_CONTROL_CODE 0xc3` (ft_cut_ds.h:60) — what `cut_abort` writes. */
  CONTROL_CODE: 0xc3,
} as const;

/**
 * Upload area: offset to the data code. ft_cut_ds.h:76.
 *
 * The third of the header's write-only constants; nothing in x3270 reads or
 * writes it. Exported for completeness.
 */
export const O_UP_DATA_CODE = 2;
/** Upload area: offset to frame sequence. ft_cut_ds.h:77. */
export const O_UP_FRAME_SEQ = 3;
/** Upload area: offset to checksum. ft_cut_ds.h:78. */
export const O_UP_CSUM = 4;
/** Upload area: offset to the two-byte length. ft_cut_ds.h:79. */
export const O_UP_LEN = 5;
/** Upload area: offset to the start of data. ft_cut_ds.h:80. */
export const O_UP_DATA = 7;
/**
 * Maximum bytes of ENCODED data in one upload frame.
 * `#define O_UP_MAX (O_SF-O_UP_DATA)` = 1912, ft_cut_ds.h:81.
 *
 * NOTE THE OVERLAP, which is x3270's and which we inherit deliberately: 1912
 * bytes at offset 7 reach address 1918, so a maximal upload frame writes over
 * `O_RESPONSE` (1914) and the whole response area. That is fine, and is what
 * `cut_data_request` does (ft_cut.c:515-522): a data-request screen's own field
 * attribute is at `O_DR_SF`, and the host is asking for data, not reading a
 * response. `O_SF` itself at 1919 is never touched, so frame detection survives.
 */
export const O_UP_MAX = O_SF - O_UP_DATA;

/**
 * Maximum bytes of data in one DOWNLOAD frame: `O_RESPONSE - O_DT_DATA` = 1909.
 *
 * Not a header constant; it is the size of x3270's conversion buffer,
 * `static unsigned char cvbuf[O_RESPONSE - O_DT_DATA]` (ft_cut.c:602), and the
 * bound its oversize check uses (ft_cut.c:617-620). The live TK5 capture sends
 * exactly `data[1909]` in a full frame, so the host agrees with the derivation.
 */
export const MAX_DOWNLOAD_DATA = O_RESPONSE - O_DT_DATA;

/** First byte of the two-byte end-of-file sentinel. ft_cut_ds.h:65. */
export const EOF_DATA1 = 0x5c;
/** Second byte of the two-byte end-of-file sentinel. ft_cut_ds.h:66. */
export const EOF_DATA2 = 0xa9;

/**
 * The five acknowledgement AIDs (ft_cut_ds.h:69-73), resolved against our own
 * `AID` table rather than restated as numbers.
 *
 * The header writes these as `AID_ENTER`, `AID_PF1`, `AID_CLEAR`, `AID_PA2`,
 * `AID_PF2`; the numeric values live in our constants.ts, verified there against
 * GA23-0059 Table 3-4. RESYNC differing between VM and TSO is the dialect seam
 * the design doc anticipated, and is why these are two separate entries rather
 * than one "resync".
 */
export const AckAid = {
  /** `ACK_OK = AID_ENTER` (ft_cut_ds.h:69). */
  OK: AID.ENTER,
  /** `ACK_RETRANSMIT = AID_PF1` (ft_cut_ds.h:70). */
  RETRANSMIT: AID.PF1,
  /** `ACK_RESYNC_VM = AID_CLEAR` (ft_cut_ds.h:71). */
  RESYNC_VM: AID.CLEAR,
  /** `ACK_RESYNC_TSO = AID_PA2` (ft_cut_ds.h:72). */
  RESYNC_TSO: AID.PA2,
  /** `ACK_ABORT = AID_PF2` (ft_cut_ds.h:73). */
  ABORT: AID.PF2,
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A frame we refuse to parse, or a screen we refuse to touch.
 *
 * `abortStatus` carries the status code x3270 aborts with, so the state machine
 * can send the response the host expects without re-deriving which fault it was.
 * It is absent for the geometry error, which is a local configuration bug rather
 * than anything the host did wrong.
 */
export class CutFrameError extends Error {
  readonly abortStatus?: number;

  constructor(message: string, abortStatus?: number) {
    super(message);
    this.name = 'CutFrameError';
    if (abortStatus !== undefined) this.abortStatus = abortStatus;
  }
}

/**
 * Refuse to operate on anything but a 24x80 buffer.
 *
 * WHY THIS THROWS instead of making `isCutFrame` return false. A silent false on
 * a 43x80 screen would mean "the transfer never progresses and nothing says
 * why", which is the worst of the three outcomes; corrupting memory at offsets
 * that mean something else on a bigger buffer is worse still. Throwing turns the
 * design doc's coupling warning into a failure a developer cannot miss. It is
 * safe to be loud because the caller is a transfer, and the established error
 * rule is that a transfer fault ends the transfer without killing the session.
 */
function requireCutGeometry(screen: Screen): void {
  if (screen.size !== CUT_SCREEN_SIZE) {
    throw new CutFrameError(
      `CUT file transfer requires a ${CUT_SCREEN_SIZE}-cell (24x80) screen; ` +
        `this screen is ${screen.rows}x${screen.cols} = ${screen.size} cells. ` +
        `O_SF is ${O_SF}, the last cell of a 24x80 buffer, and the frame offsets ` +
        `are meaningless on any other geometry.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Does this screen hold a CUT frame?
 *
 * x3270's whole test, `ft_cut_data` at ft_cut.c:394:
 *
 *     if (ea_buf[O_SF].fa && FA_IS_SKIP(ea_buf[O_SF].fa)) {
 *
 * `.fa` non-zero means "there is a field attribute at this cell" (x3270's
 * `ctlr_add_fa` ORs in `FA_PRINTABLE` so the stored byte is never zero,
 * ctlr.c:2812); ours is `attributeAt(addr) !== null`. `FA_IS_SKIP(c)` is
 * `((c) & FA_PROTECT) && ((c) & FA_NUMERIC)` (3270ds.h:207), i.e. protected AND
 * numeric — the same computation `Screen.makeField` does for `Field.autoSkip`.
 *
 * `attributeAt` rather than `fieldAt`: `fieldAt(O_SF)` scans backwards for the
 * attribute GOVERNING 1919, which on most screens is some other field's, so its
 * `autoSkip` would answer a different question. It is also O(size) where this is
 * O(1), and this runs on every screen update while a transfer is active.
 *
 * Masks, never equality: the live TK5 frame plants 0x7c here (protect | numeric
 * | zero-intensity | printable-ish bits), x3270 would store 0xfc for the same
 * field, and both are auto-skip. See the `Field.attr` comment in screen.ts.
 */
export function isCutFrame(screen: Screen): boolean {
  requireCutGeometry(screen);
  const attr = screen.attributeAt(O_SF);
  if (attr === null) return false;
  return (attr & FA.PROTECT) !== 0 && (attr & FA.NUMERIC) !== 0;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A control code from the host: `cut_control_code`, ft_cut.c:419-492. */
export interface CutControlCodeFrame {
  kind: 'controlCode';
  /** Frame sequence, decoded through `from6`. */
  seq: number;
  /** The raw byte at `O_CC_FRAME_SEQ`; echo THIS, never `to6(seq)`. */
  rawSeq: number;
  /** The 16-bit status code; compare against `StatusCode`. */
  status: number;
  /** Host message text, for humans. Empty when the host sent only blanks. */
  message: string;
}

/** A request for the next upload frame: `cut_data_request`, ft_cut.c:497-568. */
export interface CutDataRequestFrame {
  kind: 'dataRequest';
  /** Frame sequence, decoded through `from6`. */
  seq: number;
  /** The raw byte at `O_DR_FRAME_SEQ`; this is what `writeUploadData` echoes. */
  rawSeq: number;
}

/**
 * "Re-send the previous frame": `cut_retransmit`, ft_cut.c:573-578.
 *
 * Carries nothing — the frame type is the whole message. x3270 answers this by
 * giving up (`cut_abort(get_message("ftCutRetransmit"), SC_ABORT_XMIT)`, and its
 * own comment calls that "(Improperly) process a retransmit"). We surface it as
 * a frame kind instead, because the design doc requires upload to RETAIN the
 * last encoded block and actually re-send it. That divergence lives in the state
 * machine; this module's job is only to say a retransmit arrived.
 */
export interface CutRetransmitFrame {
  kind: 'retransmit';
}

/** Data from the host: `cut_data`, ft_cut.c:599-647. */
export interface CutDataFrame {
  kind: 'data';
  /** Frame sequence, decoded through `from6`. */
  seq: number;
  /** The raw byte at `O_DT_FRAME_SEQ`; `writeResponse` echoes this on abort. */
  rawSeq: number;
  /**
   * The 6-bit checksum the host declared at `O_DT_CSUM`, already decoded.
   * Compare with `checksum(frame.data)` from ft/cut.ts. See `O_DT_CSUM` on why
   * a mismatch is a trace note and not an abort.
   */
  declaredChecksum: number;
  /** Declared payload length, the 12-bit value from the two `O_DT_LEN` bytes. */
  length: number;
  /**
   * The RAW 6-bit-encoded payload, NOT decoded.
   *
   * Decoding belongs to the caller because it owns the `CutCodec` whose quadrant
   * persists across frames — see the module comment. A copy, not a view, so a
   * later screen update cannot change a frame already parsed.
   */
  data: Uint8Array;
}

export type CutFrame =
  | CutControlCodeFrame
  | CutDataRequestFrame
  | CutRetransmitFrame
  | CutDataFrame;

/**
 * Read the frame at the start of the buffer.
 *
 * The dispatch is x3270's `ft_cut_data` switch (ft_cut.c:395-412). Callers
 * should gate on `isCutFrame` first; this function does not, because the two
 * questions are separable and a test wants to parse a synthetic frame without
 * also constructing the detection attribute.
 *
 * THROWS `CutFrameError` for the two faults x3270 aborts on, carrying the same
 * status code it uses:
 *
 *   - an unknown frame type — `ftCutUnknownFrame` / `SC_ABORT_XMIT`,
 *     ft_cut.c:408-411. Not a silent default: a frame type we do not recognise
 *     means we have lost sync with the host, and guessing would write a wrong
 *     file.
 *   - a declared length past `MAX_DOWNLOAD_DATA` — `ftCutOversize` /
 *     `SC_ABORT_XMIT`, ft_cut.c:617-620.
 */
export function parseFrame(screen: Screen): CutFrame {
  requireCutGeometry(screen);
  const at = (addr: number): number => screen.cellAt(addr).ebcdic;
  const frameType = at(O_FRAME_TYPE);

  switch (frameType) {
    case FrameType.CONTROL_CODE: {
      // `code = (ea_buf[O_CC_STATUS_CODE].ec << 8) |
      //         ea_buf[O_CC_STATUS_CODE + 1].ec;` (ft_cut.c:428-429).
      const status = (at(O_CC_STATUS_CODE) << 8) | at(O_CC_STATUS_CODE + 1);
      const rawSeq = at(O_CC_FRAME_SEQ);
      return {
        kind: 'controlCode',
        seq: from6(rawSeq),
        rawSeq,
        status,
        message: readMessage(screen),
      };
    }

    case FrameType.DATA_REQUEST: {
      const rawSeq = at(O_DR_FRAME_SEQ);
      return { kind: 'dataRequest', seq: from6(rawSeq), rawSeq };
    }

    case FrameType.RETRANSMIT:
      return { kind: 'retransmit' };

    case FrameType.DATA: {
      // 12 bits across two 6-bit characters (ft_cut.c:615-616).
      const length = (from6(at(O_DT_LEN)) << 6) | from6(at(O_DT_LEN + 1));
      if (length > MAX_DOWNLOAD_DATA) {
        throw new CutFrameError(
          `CUT data frame declares ${length} bytes, more than the ` +
            `${MAX_DOWNLOAD_DATA}-byte maximum (O_RESPONSE - O_DT_DATA)`,
          StatusCode.ABORT_XMIT,
        );
      }
      const data = new Uint8Array(length);
      for (let i = 0; i < length; i++) data[i] = at(O_DT_DATA + i);
      const rawSeq = at(O_DT_FRAME_SEQ);
      return {
        kind: 'data',
        seq: from6(rawSeq),
        rawSeq,
        declaredChecksum: from6(at(O_DT_CSUM)),
        length,
        data,
      };
    }

    default:
      throw new CutFrameError(
        `unknown CUT frame type 0x${frameType.toString(16).padStart(2, '0')}`,
        StatusCode.ABORT_XMIT,
      );
  }
}

/**
 * The 80 bytes of host message text in a control-code frame.
 *
 * x3270's tail of `cut_control_code` (ft_cut.c:457-482): translate 80 bytes from
 * `O_CC_MESSAGE`, then strip trailing spaces, then one trailing '$', then
 * trailing spaces again. (The '$' is IND$FILE's own message terminator, and the
 * second strip exists because removing it can expose more padding.)
 *
 * cp037 IS right here, unlike in the codec. This is host text meant for a human,
 * so a faithful character-set mapping is exactly what is wanted; the codec's
 * private `ebc2asc0` tables exist only to locate characters in TABLE6/ALPHAS and
 * flatten the whole EBCDIC control range to space, which would mangle a message.
 *
 * One divergence, and it is about our screen rather than the protocol: untouched
 * cells hold 0x00, which cp037 maps to U+0000, and x3270 never sees those
 * because a real host paints the whole line. NULs are treated as blanks — the
 * same convention `Screen.rowText` uses — so a synthetic or partly-written frame
 * yields a trimmed message instead of a string full of NULs.
 */
function readMessage(screen: Screen): string {
  // O_CC_MESSAGE + 80 = 84, nowhere near O_SF, so no bound check is needed.
  let text = '';
  for (let i = 0; i < CC_MESSAGE_LENGTH; i++) {
    const b = screen.cellAt(O_CC_MESSAGE + i).ebcdic;
    text += b === 0x00 ? ' ' : cp037.toUnicode(b);
  }
  let out = text.replace(/ +$/, '');
  if (out.endsWith('$')) out = out.slice(0, -1).replace(/ +$/, '');
  return out;
}

/**
 * Is this payload the two-byte end-of-file sentinel?
 *
 * `if (raw_length == 2 && cvbuf[0] == EOF_DATA1 && cvbuf[1] == EOF_DATA2)`
 * (ft_cut.c:625). The length check is part of the test, not a precondition: a
 * longer buffer that merely STARTS with 5c a9 is data, and treating it as EOF
 * would truncate the file. `5c` is also quadrant 2's selector and `a9` a
 * perfectly ordinary encoded character, so that is a reachable payload, not a
 * theoretical one.
 */
export function isEofData(data: Uint8Array | readonly number[]): boolean {
  return data.length === 2 && data[0] === EOF_DATA1 && data[1] === EOF_DATA2;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ResponseOptions {
  /** `ResponseFrameType.CONTROL_CODE` for an abort; see that enum. */
  frameType: number;
  /**
   * The RAW sequence byte from the frame being responded to — `frame.rawSeq`.
   * x3270 echoes `ea_buf[O_DT_FRAME_SEQ].ec` verbatim (ft_cut.c:670). See the
   * module comment on why this is not the decoded number.
   */
  rawSeq: number;
  /**
   * 16-bit reason, written high byte then low (ft_cut.c:671-672). Omit to leave
   * both reason bytes untouched, for a response type that carries none.
   */
  reason?: number;
}

/**
 * Write the response area, us -> host. x3270's `cut_abort`, ft_cut.c:662-678.
 *
 * Writes only 1915-1918. `O_RESPONSE` itself (1914) is NOT written: in the live
 * TK5 capture the host plants a field attribute there (`SBA(1914) SF(0xc1)`),
 * and 0xc1 already carries `FA.MODIFY`, so the field is pre-armed for Read
 * Modified and we neither need nor want to disturb it. That is also why this
 * function sets no MDT of its own — x3270 does not either.
 *
 * Sending the AID is the caller's job: x3270 follows this with
 * `run_action(AnPF, IA_FT, "2", NULL)`, i.e. `AckAid.ABORT`. Keeping the AID out
 * of here is what makes this module pure with respect to I/O.
 */
export function writeResponse(screen: Screen, opts: ResponseOptions): void {
  requireCutGeometry(screen);
  screen.setChar(RO_FRAME_TYPE, opts.frameType);
  screen.setChar(RO_FRAME_SEQ, opts.rawSeq);
  if (opts.reason !== undefined) {
    // HIGH8/LOW8 (ft_cut.c:671-672).
    screen.setChar(RO_REASON_CODE, (opts.reason >> 8) & 0xff);
    screen.setChar(RO_REASON_CODE + 1, opts.reason & 0xff);
  }
}

export interface UploadDataOptions {
  /**
   * The RAW sequence byte from the data request — `frame.rawSeq`. Echoed
   * verbatim (ft_cut.c:500, :549).
   */
  rawSeq: number;
  /** Source file bytes still to send. Only a prefix will be consumed. */
  data: Uint8Array | readonly number[];
  /**
   * The transfer's ONE codec, held across every frame. See the module comment:
   * constructing one here would emit a spurious selector at the start of every
   * frame after the first.
   */
  codec: CutCodec;
}

export interface UploadDataResult {
  /**
   * How many SOURCE bytes were consumed. The caller cannot compute this — see
   * `writeUploadData`.
   */
  consumed: number;
  /** How many ENCODED bytes were written at `O_UP_DATA`, i.e. the frame length. */
  encodedLength: number;
}

/**
 * Fill the upload data area, us -> host. x3270's `cut_data_request`,
 * ft_cut.c:513-556.
 *
 * WHY THIS RETURNS A CONSUMED COUNT. Encoding expands: a byte the current
 * quadrant maps costs one output byte, a byte in another quadrant costs two,
 * because the selector has to be emitted too (`store_download`,
 * ft_cut.c:277-299). The frame holds at most `O_UP_MAX` ENCODED bytes, so how
 * many SOURCE bytes fit depends on the data and on the codec's quadrant at the
 * moment the frame starts. The caller therefore cannot know it in advance, and
 * this function decides and reports.
 *
 * WHERE WE DIVERGE FROM x3270, and why it is safe. x3270 fills to exactly
 * `O_UP_MAX` by pulling one ENCODED byte at a time from `xlate_getc`, which
 * converts a source byte and buffers the leftover in `xlate_buf`
 * (ft_cut.c:696-702, :751-760) — so a selector can land in one frame and its
 * character in the next. We stop while fewer than 2 bytes of room remain, which
 * never splits a byte's encoding and so needs no cross-frame buffer. It costs at
 * most ONE unused byte per frame out of 1912, and it is safe because the host
 * concatenates frame payloads: where a frame boundary falls inside the encoded
 * stream has no protocol meaning. The alternative — encode, discover it does not
 * fit, put it back — is not available, since a `CutCodec`'s quadrant has already
 * moved by then and there is no rollback.
 *
 * Callers must handle the `consumed === 0` case. It means the frame has no room
 * (only possible with an empty `data`), NOT that the file has ended; end of file
 * is `writeUploadEof`.
 */
export function writeUploadData(screen: Screen, opts: UploadDataOptions): UploadDataResult {
  requireCutGeometry(screen);
  const src = opts.data instanceof Uint8Array ? opts.data : Uint8Array.from(opts.data);

  const encoded: number[] = [];
  let consumed = 0;
  // One source byte at a time: the maximum expansion is 2 bytes, so with 2 bytes
  // of room the next byte is guaranteed to fit and no speculative encoding — and
  // hence no impossible rollback — is ever needed.
  //
  // A `localToHost` call per byte, which allocates, and that is a deliberate
  // trade: the alternative is to encode a whole slice and discard the tail, but
  // a `CutCodec`'s quadrant would already have moved past the discard point and
  // there is no way to wind it back. Correctness over allocations; a full frame
  // is 1912 calls and a transfer is bounded by the file size.
  const one = new Uint8Array(1);
  while (consumed < src.length && O_UP_MAX - encoded.length >= 2) {
    one[0] = src[consumed]!;
    for (const b of opts.codec.localToHost(one)) encoded.push(b);
    consumed++;
  }
  // The loop invariant, asserted rather than trusted: overrunning here would
  // scribble past O_SF and destroy the frame-detection attribute, which would
  // present as "the transfer silently stops" rather than as an encoding bug.
  if (encoded.length > O_UP_MAX) {
    throw new CutFrameError(
      `internal error: encoded ${encoded.length} bytes for an upload frame, ` +
        `over the ${O_UP_MAX}-byte maximum`,
    );
  }

  writeUploadFrame(screen, opts.rawSeq, encoded);
  return { consumed, encodedLength: encoded.length };
}

/**
 * Write an end-of-file upload frame: the two-byte sentinel as the data.
 *
 * ft_cut.c:541-546:
 *
 *     if (!count && cut_eof) {
 *         ctlr_add(O_UP_DATA, EOF_DATA1, 0);
 *         ctlr_add(O_UP_DATA+1, EOF_DATA2, 0);
 *         count = 2;
 *     }
 *
 * A separate function rather than a flag on `writeUploadData`, because these two
 * bytes go on the wire RAW and must not pass through the codec: `0x5c` is
 * quadrant 2's selector, so encoding it would emit something else entirely and
 * would additionally move the quadrant. The checksum and length are computed
 * over the sentinel exactly as over data, since x3270 falls through to the same
 * code.
 */
export function writeUploadEof(screen: Screen, rawSeq: number): void {
  requireCutGeometry(screen);
  writeUploadFrame(screen, rawSeq, [EOF_DATA1, EOF_DATA2]);
}

/**
 * The shared tail of both upload writers: data, sequence, checksum, length, and
 * the display hack. ft_cut.c:520, :549-561.
 */
function writeUploadFrame(screen: Screen, rawSeq: number, encoded: readonly number[]): void {
  for (let i = 0; i < encoded.length; i++) {
    screen.setChar(O_UP_DATA + i, encoded[i]!);
  }

  // `ctlr_add(O_UP_FRAME_SEQ, seq, 0)` -- the raw byte (ft_cut.c:549).
  screen.setChar(O_UP_FRAME_SEQ, rawSeq);

  // `ctlr_add(O_UP_CSUM, asc2ebc0[(int)table6[cs & 0x3f]], 0)` (ft_cut.c:554),
  // over the ENCODED bytes as they sit in the buffer (ft_cut.c:551-553). The
  // 6-bit mask lives in ft/cut.ts's checksum/to6.
  screen.setChar(O_UP_CSUM, to6(checksum(encoded)));

  // The length is the ENCODED byte count, as two 6-bit characters, high then
  // low (ft_cut.c:555-556). O_UP_MAX is 1912, which needs 11 bits, so 12 bits
  // is always enough.
  const count = encoded.length;
  screen.setChar(O_UP_LEN, to6((count >> 6) & 0x3f));
  screen.setChar(O_UP_LEN + 1, to6(count & 0x3f));

  // "XXX: Change the data field attribute so it doesn't display."
  // (ft_cut.c:558-561) -- purely cosmetic, and it preserves MDT, which matters:
  //
  //     attr = ea_buf[O_DR_SF].fa;
  //     attr = (attr & ~FA_INTENSITY) | FA_INT_ZERO_NSEL;
  //     ctlr_add_fa(O_DR_SF, attr, 0);
  //
  // Ported because a screenful of encoded bytes flashing past is a real
  // annoyance, and because it is one line. x3270 does this unconditionally,
  // reading `.fa` as 0 when there is no field there and thereby CREATING one;
  // we skip instead, since inventing a field attribute the host did not send
  // would change the buffer's field structure behind the host's back.
  const attr = screen.attributeAt(O_DR_SF);
  if (attr !== null) {
    screen.setFieldAttribute(O_DR_SF, (attr & ~FA.INTENSITY) | FA.INT_ZERO_NSEL);
  }
}
