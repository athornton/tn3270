import { describe, it, expect } from 'vitest';

import { CutTransfer } from '../../src/ft/transfer.js';
import {
  AckAid,
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
} from '../../src/ft/frames.js';
import { CutCodec, QUADRANTS, checksum, from6, to6 } from '../../src/ft/cut.js';
import { FA } from '../../src/constants.js';
import { cp037 } from '../../src/codepage.js';
import { Screen } from '../../src/screen.js';

/**
 * CUT transfer state-machine tests, over synthetic host screens.
 *
 * The machine is frames-in, intents-out and does no I/O, which is exactly what
 * makes a WHOLE scripted transfer testable here rather than only against a live
 * host: each test paints a screen the way the host would, calls `step`, and
 * checks both the returned intent and the bytes left in the buffer.
 *
 * References, cited by line throughout:
 *  - x3270 4.5 `Common/ft_cut.c` — `cut_control_code` (:419), `cut_data_request`
 *    (:497), `cut_retransmit` (:573), `cut_data` (:599), `cut_ack` (:652),
 *    `cut_abort` (:662) — and `include/ft_cut_ds.h` for every offset.
 *  - docs/superpowers/specs/2026-08-18-indfile-cut-transfer-design.md, whose
 *    "Data flow", "Error handling" and codec finding 3 are what the sequencing
 *    tests below encode.
 *
 * The lower two layers are already verified against a live MVS 3.8j TK5 host (a
 * real captured frame parses and decodes correctly, see frames.test.ts), so these
 * tests are about SEQUENCING and STATE — the things a single frame cannot show.
 */

// ---------------------------------------------------------------------------
// Screen builders: one per frame type the host can send
// ---------------------------------------------------------------------------

/** A blank 24x80 screen with the host's auto-skip attribute at O_SF. */
function cutScreen(): Screen {
  const s = new Screen();
  // 0x7c is the byte the real TK5 host plants here: PROTECT|NUMERIC, so
  // FA_IS_SKIP (3270ds.h:207) holds and `isCutFrame` is true.
  s.setFieldAttribute(O_SF, 0x7c);
  expect(isCutFrame(s)).toBe(true);
  return s;
}

/** `FT_CONTROL_CODE` with a status and optional message text (ft_cut_ds.h:37-44). */
function controlCodeScreen(status: number, message = '', seq = 0): Screen {
  const s = cutScreen();
  s.setChar(O_FRAME_TYPE, FrameType.CONTROL_CODE);
  s.setChar(O_CC_FRAME_SEQ, to6(seq));
  s.setChar(O_CC_STATUS_CODE, (status >> 8) & 0xff);
  s.setChar(O_CC_STATUS_CODE + 1, status & 0xff);
  cp037.encode(message).forEach((b, i) => s.setChar(O_CC_MESSAGE + i, b));
  return s;
}

/**
 * `FT_DATA` carrying an already-6-bit-encoded payload (ft_cut_ds.h:50-54).
 *
 * `csum` defaults to the value the host would compute, so a test that wants a
 * mismatch has to ask for one explicitly.
 */
function dataScreen(payload: readonly number[], seq: number, csum?: number): Screen {
  const s = cutScreen();
  s.setChar(O_FRAME_TYPE, FrameType.DATA);
  s.setChar(O_DT_FRAME_SEQ, to6(seq));
  s.setChar(O_DT_CSUM, to6(csum ?? checksum(payload)));
  s.setChar(O_DT_LEN, to6((payload.length >> 6) & 0x3f));
  s.setChar(O_DT_LEN + 1, to6(payload.length & 0x3f));
  payload.forEach((b, i) => s.setChar(O_DT_DATA + i, b));
  return s;
}

/** The two-byte end-of-file sentinel as a data frame (ft_cut.c:625). */
function eofDataScreen(seq: number): Screen {
  return dataScreen([EOF_DATA1, EOF_DATA2], seq);
}

/**
 * `FT_DATA_REQUEST` (ft_cut_ds.h:45-48), with the field attribute the host
 * plants at `O_DR_SF` so the display hack at ft_cut.c:558-561 has something to
 * modify.
 */
function dataRequestScreen(seq: number): Screen {
  const s = cutScreen();
  s.setChar(O_FRAME_TYPE, FrameType.DATA_REQUEST);
  s.setFieldAttribute(O_DR_SF, FA.PRINTABLE | FA.MODIFY);
  s.setChar(O_DR_FRAME_SEQ, to6(seq));
  return s;
}

/** `FT_RETRANSMIT` (ft_cut_ds.h:49) — the frame type is the whole message. */
function retransmitScreen(): Screen {
  const s = cutScreen();
  s.setChar(O_FRAME_TYPE, FrameType.RETRANSMIT);
  s.setFieldAttribute(O_DR_SF, FA.PRINTABLE | FA.MODIFY);
  return s;
}

// ---------------------------------------------------------------------------
// Readers: pull our local->host frame back out of a screen
// ---------------------------------------------------------------------------

/** The declared length of the upload frame in this screen (ft_cut.c:555-556). */
function uploadLength(s: Screen): number {
  return (from6(s.cellAt(O_UP_LEN).ebcdic) << 6) | from6(s.cellAt(O_UP_LEN + 1).ebcdic);
}

/** The encoded payload of the upload frame in this screen. */
function uploadPayload(s: Screen): number[] {
  return Array.from({ length: uploadLength(s) }, (_, i) => s.cellAt(O_UP_DATA + i).ebcdic);
}

/**
 * Every byte of the upload frame, sequence through payload — the contiguous
 * range `O_UP_FRAME_SEQ`(3) .. `O_UP_DATA + count - 1` (ft_cut_ds.h:77-80).
 *
 * This is what "byte-identical" is measured over in the retransmit test: not
 * just the payload, but the sequence byte, the checksum and both length
 * characters as well, since a retransmit that got any of those wrong would be
 * just as broken.
 */
function uploadFrameBytes(s: Screen): number[] {
  const end = O_UP_DATA + uploadLength(s);
  return Array.from({ length: end - O_UP_FRAME_SEQ }, (_, i) =>
    s.cellAt(O_UP_FRAME_SEQ + i).ebcdic,
  );
}

/** A fresh codec's encoding of a whole buffer, as the reference to compare to. */
function encodeWhole(src: Uint8Array | readonly number[]): number[] {
  return Array.from(new CutCodec().localToHost(src));
}

/** A fresh codec's decoding of a whole buffer — what the HOST does on receive. */
function decodeWhole(encoded: readonly number[]): number[] {
  return Array.from(new CutCodec().hostToLocal(Uint8Array.from(encoded)));
}

// ---------------------------------------------------------------------------
// A payload with real quadrant traffic in it
// ---------------------------------------------------------------------------

/**
 * Twelve source bytes that exercise all four quadrants and both NULL paths.
 *
 * A text file exercises none of the quadrant machinery, which is the design
 * doc's own warning about live-test payloads. These bytes encode to 20 bytes
 * through 6 quadrant changes, so any frame split lands somewhere the quadrant
 * state matters.
 */
const NASTY = Uint8Array.from([
  0xc1, 0xc2, 0x41, 0x42, 0x00, 0xff, 0x40, 0xa0, 0x1a, 0x5c, 0xc3, 0xc4,
]);

/** The 20 encoded bytes NASTY produces, verified below rather than assumed. */
const NASTY_ENCODED = encodeWhole(NASTY);

describe('the NASTY payload this file leans on', () => {
  it('expands through six quadrant changes and round-trips', () => {
    // Pinned so a later test's split index cannot silently start meaning
    // something else. 12 source bytes -> 20 encoded, i.e. eight selectors'
    // worth of quadrant traffic... or rather 8 extra bytes, one per change plus
    // NULL's own selector.
    expect(NASTY_ENCODED).toHaveLength(20);
    expect(NASTY_ENCODED.map((b) => b.toString(16))).toEqual([
      '5e', 'c1', 'c2', '7e', 'c1', 'c2', '5c', 'c1', 'f9', '5e',
      '40', '7d', 'c1', '5c', '4c', '7d', 'f6', '5e', 'c3', 'c4',
    ]);
    expect(decodeWhole(NASTY_ENCODED)).toEqual(Array.from(NASTY));
  });
});

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

describe('a full download: host ack, data, data, EOF, complete', () => {
  // The design doc's "Data flow" for Direction=receive, in one test:
  //
  //   host: FT_CONTROL_CODE / SC_HOST_ACK       -> ack (Enter)
  //   host: FT_DATA (seq, csum, len, data)      -> hostToLocal, append, ack
  //   host: FT_DATA with 5c a9                  -> EOF, ack
  //   host: FT_CONTROL_CODE / SC_XFER_COMPLETE  -> done

  // Split the encoded stream right after a SELECTOR (index 10, whose predecessor
  // is 0x5e). Frame 2 then opens with a character that is only decodable against
  // the quadrant frame 1 selected -- the sharpest possible check that the codec
  // is held across frames.
  const first = NASTY_ENCODED.slice(0, 10);
  const second = NASTY_ENCODED.slice(10);

  it('accumulates exactly the decoded bytes, acking Enter every time', () => {
    expect(QUADRANTS.map((q) => q.selector)).toContain(first[first.length - 1]);

    const t = new CutTransfer({ direction: 'receive' });

    // SC_HOST_ACK: the host has accepted the IND$FILE command (ft_cut.c:431-441).
    expect(t.step(controlCodeScreen(StatusCode.HOST_ACK))).toEqual({ ack: AckAid.OK });
    expect(t.complete).toBe(false);

    // Two data frames (ft_cut.c:621-645).
    expect(t.step(dataScreen(first, 1))).toEqual({ ack: AckAid.OK });
    expect(t.step(dataScreen(second, 2))).toEqual({ ack: AckAid.OK });
    expect(t.bytesTransferred).toBe(NASTY.length);

    // The EOF sentinel: acked, and NOT appended to the file (ft_cut.c:625-629).
    expect(t.sawEof).toBe(false);
    expect(t.step(eofDataScreen(3))).toEqual({ ack: AckAid.OK });
    expect(t.sawEof).toBe(true);
    expect(t.bytesTransferred).toBe(NASTY.length);

    // SC_XFER_COMPLETE: ack FIRST, then complete (ft_cut.c:442-447).
    const last = t.step(controlCodeScreen(StatusCode.XFER_COMPLETE));
    expect(last.ack).toBe(AckAid.OK);
    expect(last.done).toEqual({ ok: true, data: NASTY });
    expect(t.complete).toBe(true);
    expect(t.warnings).toEqual([]);
  });

  it('leaves the screen alone on the happy path', () => {
    // Nothing in a download writes the response area: `cut_ack` is only
    // `run_action(AnEnter)` (ft_cut.c:652-657), and the response area is
    // `cut_abort`'s alone. A stray write there would look to the host like an
    // abort we never meant to send.
    const t = new CutTransfer({ direction: 'receive' });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const s = dataScreen(first, 1);
    t.step(s);
    expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(0x00);
    expect(s.cellAt(RO_FRAME_SEQ).ebcdic).toBe(0x00);
    expect(s.cellAt(RO_REASON_CODE).ebcdic).toBe(0x00);
    expect(isCutFrame(s)).toBe(true);
  });

  it('does not need SC_HOST_ACK first, since the host decides the order', () => {
    // The machine is driven by frames, not by an internal expectation of which
    // comes next -- x3270's `ft_cut_data` is likewise a pure dispatch on the
    // frame type (ft_cut.c:395-412). A data frame arriving without a preceding
    // host ack is processed, because refusing it would be us second-guessing the
    // host on a protocol we do not control.
    const t = new CutTransfer({ direction: 'receive' });
    expect(t.step(dataScreen(NASTY_ENCODED, 1))).toEqual({ ack: AckAid.OK });
    expect(t.bytesTransferred).toBe(NASTY.length);
  });
});

describe('a multi-frame download holds ONE codec across frames', () => {
  // FINDING 3 IN THE DESIGN DOC, as the failure it would actually cause. The
  // quadrant is persistent state; a selector appears only when it changes. So a
  // per-frame codec does not merely lose efficiency -- it decodes the same bytes
  // to DIFFERENT values, or refuses them outright.

  /** Frame 1 selects a quadrant and sends two characters; frame 2 sends two more. */
  const frame2 = [0xc1, 0xc2];

  it('decodes frame 2 against the quadrant frame 1 selected', () => {
    // The same frame-2 bytes, after two different frame 1s, MUST decode to
    // different file bytes. That is the whole point of the carried state, and it
    // is what no single-frame test can show.
    const viaQ0 = new CutTransfer({ direction: 'receive' });
    viaQ0.step(dataScreen([QUADRANTS[0]!.selector, 0xc1, 0xc2], 1));
    viaQ0.step(dataScreen(frame2, 2));
    viaQ0.step(controlCodeScreen(StatusCode.XFER_COMPLETE));

    const viaQ1 = new CutTransfer({ direction: 'receive' });
    viaQ1.step(dataScreen([QUADRANTS[1]!.selector, 0xc1, 0xc2], 1));
    viaQ1.step(dataScreen(frame2, 2));
    viaQ1.step(controlCodeScreen(StatusCode.XFER_COMPLETE));

    const q0 = viaQ0.result;
    const q1 = viaQ1.result;
    if (!q0?.ok || !q1?.ok) throw new Error('both transfers should have succeeded');
    // Quadrant 0 maps ALPHAS 'A','B' to EBCDIC 0xc1,0xc2; quadrant 1 maps the
    // same two ALPHAS indices to ASCII 0x41,0x42.
    expect(Array.from(q0.data!)).toEqual([0xc1, 0xc2, 0xc1, 0xc2]);
    expect(Array.from(q1.data!)).toEqual([0x41, 0x42, 0x41, 0x42]);
    expect(Array.from(q0.data!)).not.toEqual(Array.from(q1.data!));
  });

  it('would have been a hard failure with a per-frame codec', () => {
    // Not a subtle difference: a codec starting from quadrant -1 REQUIRES its
    // first byte to be a selector (ft_cut.c:148-158), and frame 2 opens with a
    // character. So the naive implementation throws rather than quietly
    // diverging -- which is worth pinning, because it means the bug would have
    // shown up on the second frame of the very first live download.
    expect(() => new CutCodec().hostToLocal(Uint8Array.from(frame2))).toThrow(
      /not a quadrant selector/,
    );
  });

  it('resets the codec on SC_HOST_ACK, as x3270 resets its quadrant', () => {
    // `quadrant = -1` at ft_cut.c:435. A second transfer's first frame legitimately
    // starts with a selector, and a stale quadrant would decode it as data.
    const t = new CutTransfer({ direction: 'receive' });
    t.step(dataScreen([QUADRANTS[0]!.selector, 0xc1], 1));
    expect(t.bytesTransferred).toBe(1);

    // A fresh host ack throws the accumulated file away and demands a selector
    // again -- so a frame that would have been fine mid-transfer now fails.
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    expect(t.bytesTransferred).toBe(0);
    const step = t.step(dataScreen([0xc1], 2));
    expect(step.done?.ok).toBe(false);
    expect(step.done && !step.done.ok && step.done.error).toContain('not a quadrant selector');
  });
});

describe('the download checksum: verify, warn, never abort', () => {
  // The design doc's decision, made at the user's request and resting on
  // measurement: x3270 never reads O_DT_CSUM (its only mention in the tree is
  // the #define) and MECAFF ignores the field on receive, but TK5's IND$FILE
  // POPULATES it -- host sent 6-bit 62 and our checksum() computed 62 over the
  // same 1904 bytes. So a mismatch is real information. It still must not be
  // fatal: the protocol has no client-initiated retransmit to recover with, and
  // failing a transfer x3270 would have completed is a regression.

  it('records a warning and carries on to a successful transfer', () => {
    const payload = NASTY_ENCODED;
    const right = checksum(payload);
    const wrong = (right + 1) & 0x3f;
    const t = new CutTransfer({ direction: 'receive' });

    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const step = t.step(dataScreen(payload, 4, wrong));

    // Carried on: acked, not done, and the data was still appended.
    expect(step).toEqual({ ack: AckAid.OK });
    expect(t.complete).toBe(false);
    expect(t.bytesTransferred).toBe(NASTY.length);

    // And warned, with both numbers in it so the note is actionable.
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('frame 4');
    expect(t.warnings[0]).toContain(`declared ${wrong}`);
    expect(t.warnings[0]).toContain(`compute to ${right}`);

    // The transfer completes successfully and delivers the full file.
    const last = t.step(controlCodeScreen(StatusCode.XFER_COMPLETE));
    expect(last.done).toEqual({ ok: true, data: NASTY });
  });

  it('says nothing when the checksum matches', () => {
    const t = new CutTransfer({ direction: 'receive' });
    t.step(dataScreen(NASTY_ENCODED, 1));
    expect(t.warnings).toEqual([]);
  });

  it('hands out a copy of the log, not the log itself', () => {
    // `readonly string[]` stops only the honest mistake; a caller can still cast
    // it away, and a transfer's own diagnostics being editable from outside is
    // the kind of thing that gets discovered while debugging something else.
    const t = new CutTransfer({ direction: 'receive' });
    t.step(dataScreen(NASTY_ENCODED, 1, (checksum(NASTY_ENCODED) + 1) & 0x3f));
    const snapshot = t.warnings;
    expect(snapshot).toHaveLength(1);
    (snapshot as string[]).push('injected');
    expect(t.warnings).toHaveLength(1);
    // And the snapshot really is a snapshot: a later warning does not appear in it.
    t.step(dataScreen(NASTY_ENCODED, 2, (checksum(NASTY_ENCODED) + 2) & 0x3f));
    expect(t.warnings).toHaveLength(2);
    expect(snapshot).toHaveLength(2); // the pushed one, not the new warning
    expect(snapshot[1]).toBe('injected');
  });

  it('warns once per bad frame, in order', () => {
    // A log, not a flag: two bad frames must produce two notes, or a
    // sporadically-wrong host would look like a single glitch.
    const a = NASTY_ENCODED.slice(0, 10);
    const b = NASTY_ENCODED.slice(10);
    const t = new CutTransfer({ direction: 'receive' });
    t.step(dataScreen(a, 1, (checksum(a) + 1) & 0x3f));
    t.step(dataScreen(b, 2, (checksum(b) + 7) & 0x3f));
    expect(t.warnings).toHaveLength(2);
    expect(t.warnings[0]).toContain('frame 1');
    expect(t.warnings[1]).toContain('frame 2');
    // And the file is still intact, which is the point of not aborting.
    const last = t.step(controlCodeScreen(StatusCode.XFER_COMPLETE));
    expect(last.done).toEqual({ ok: true, data: NASTY });
  });

  it('does not checksum the EOF sentinel frame', () => {
    // ft_cut.c:625 returns before any conversion, and the sentinel is not file
    // content. Planting a wrong checksum on it must therefore be silent, or
    // every transfer against a host that leaves it zero would end with a
    // spurious warning.
    const t = new CutTransfer({ direction: 'receive' });
    const s = eofDataScreen(9);
    s.setChar(O_DT_CSUM, to6(0)); // deliberately not checksum([5c, a9])
    expect(checksum([EOF_DATA1, EOF_DATA2])).not.toBe(0);
    expect(t.step(s)).toEqual({ ack: AckAid.OK });
    expect(t.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

describe('a full upload: host ack, data requests, EOF, complete', () => {
  // The design doc's "Data flow" for Direction=send, the primary use:
  //
  //   host: FT_CONTROL_CODE / SC_HOST_ACK       -> ack
  //   host: FT_DATA_REQUEST (seq)               -> localToHost into the screen
  //   us:   5c a9 as the data                   -> EOF
  //   host: FT_CONTROL_CODE / SC_XFER_COMPLETE  -> done

  it('writes bytes that decode back to the source through a fresh codec', () => {
    const t = new CutTransfer({ direction: 'send', data: NASTY });

    expect(t.step(controlCodeScreen(StatusCode.HOST_ACK))).toEqual({ ack: AckAid.OK });

    // One data request is enough for 12 source bytes (a frame holds 1912
    // encoded), so this frame is the whole file.
    const req = dataRequestScreen(1);
    expect(t.step(req)).toEqual({ ack: AckAid.OK });
    expect(t.bytesTransferred).toBe(NASTY.length);

    // THE ASSERTION THAT MATTERS: what is on the screen is what the host will
    // decode, and it decodes with a FRESH codec on the reading side because this
    // is the transfer's first frame.
    const payload = uploadPayload(req);
    expect(payload).toEqual(NASTY_ENCODED);
    expect(decodeWhole(payload)).toEqual(Array.from(NASTY));

    // Sequence echoed RAW (ft_cut.c:549), checksum and length over the ENCODED
    // bytes (ft_cut.c:551-556).
    expect(req.cellAt(O_UP_FRAME_SEQ).ebcdic).toBe(to6(1));
    expect(req.cellAt(O_UP_CSUM).ebcdic).toBe(to6(checksum(payload)));
    expect(uploadLength(req)).toBe(NASTY_ENCODED.length);

    // The next request draws the end-of-file sentinel, RAW, not encoded
    // (ft_cut.c:541-546).
    const eofReq = dataRequestScreen(2);
    expect(t.step(eofReq)).toEqual({ ack: AckAid.OK });
    expect(uploadPayload(eofReq)).toEqual([EOF_DATA1, EOF_DATA2]);
    expect(uploadLength(eofReq)).toBe(2);
    expect(eofReq.cellAt(O_UP_FRAME_SEQ).ebcdic).toBe(to6(2));

    // SC_XFER_COMPLETE ends it, with no data (the file went the other way).
    const last = t.step(controlCodeScreen(StatusCode.XFER_COMPLETE));
    expect(last.ack).toBe(AckAid.OK);
    expect(last.done).toEqual({ ok: true });
  });

  it('hides the data field without clearing MDT, and never touches O_SF', () => {
    // ft_cut.c:558-561, and the O_SF invariant frame detection depends on.
    const t = new CutTransfer({ direction: 'send', data: NASTY });
    const req = dataRequestScreen(1);
    t.step(req);
    const attr = req.attributeAt(O_DR_SF);
    expect(attr).not.toBeNull();
    expect(attr! & FA.INTENSITY).toBe(FA.INT_ZERO_NSEL);
    expect(attr! & FA.MODIFY).toBe(FA.MODIFY);
    expect(isCutFrame(req)).toBe(true);
  });

  it('sends an EMPTY file as the sentinel alone', () => {
    // A zero-length source is legitimate -- an empty MODULE or a truncated
    // dataset -- and must produce the sentinel on the FIRST data request rather
    // than a zero-length data frame. `writeUploadData`'s `consumed === 0` case
    // exists but means "no room", not "end of file"; conflating them here would
    // ack an empty frame forever.
    const t = new CutTransfer({ direction: 'send', data: new Uint8Array(0) });
    const req = dataRequestScreen(1);
    expect(t.step(req)).toEqual({ ack: AckAid.OK });
    expect(uploadPayload(req)).toEqual([EOF_DATA1, EOF_DATA2]);
    expect(t.bytesTransferred).toBe(0);
    expect(t.step(controlCodeScreen(StatusCode.XFER_COMPLETE)).done).toEqual({ ok: true });
  });

  it('refuses a send with no data at all', () => {
    // A caller mistake, and the constructor is the right place: an empty upload
    // would sit in the host's transfer mode sending only a sentinel.
    expect(() => new CutTransfer({ direction: 'send' })).toThrow(TypeError);
    // And the mirror image, which would silently be ignored otherwise.
    expect(() => new CutTransfer({ direction: 'receive', data: NASTY })).toThrow(TypeError);
  });
});

describe('an upload spanning several frames', () => {
  /**
   * 2000 source bytes alternating between quadrant 0 and quadrant 1, which is
   * the WORST CASE: every byte needs a selector as well as a character, so the
   * encoding is exactly 2 bytes per source byte and a 1912-byte frame holds 956
   * source bytes.
   *
   * Chosen over 2000 random bytes because the frame arithmetic is then
   * predictable enough to assert exactly, and because it puts a quadrant change
   * on every single byte -- including at both frame boundaries.
   */
  const src = Uint8Array.from(
    Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 0xc1 : 0x41)),
  );

  it('splits into 956 + 956 + 88 source bytes and reassembles exactly', () => {
    const t = new CutTransfer({ direction: 'send', data: src });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));

    const payloads: number[][] = [];
    const consumedPerFrame: number[] = [];
    let before = 0;

    for (let seq = 1; seq <= 3; seq++) {
      const req = dataRequestScreen(seq);
      expect(t.step(req)).toEqual({ ack: AckAid.OK });
      payloads.push(uploadPayload(req));
      consumedPerFrame.push(t.bytesTransferred - before);
      before = t.bytesTransferred;
    }

    // 956 * 2 = 1912 = O_UP_MAX exactly, twice; then the 88-byte remainder.
    expect(consumedPerFrame).toEqual([956, 956, 88]);
    expect(payloads.map((p) => p.length)).toEqual([O_UP_MAX, O_UP_MAX, 176]);
    expect(956 * 2).toBe(O_UP_MAX);
    expect(t.bytesTransferred).toBe(src.length);

    // THE HOST'S VIEW: it concatenates the frame payloads and decodes the lot
    // with one codec. So must this test, and the result must be the original
    // file -- byte for byte, all 2000 of them.
    const wire = payloads.flat();
    expect(wire).toHaveLength(4000);
    expect(decodeWhole(wire)).toEqual(Array.from(src));

    // And the concatenation equals what a single whole-buffer encode produces,
    // i.e. the frame boundaries added and removed nothing.
    expect(wire).toEqual(encodeWhole(src));

    // Then the sentinel, then completion.
    const eofReq = dataRequestScreen(4);
    expect(t.step(eofReq)).toEqual({ ack: AckAid.OK });
    expect(uploadPayload(eofReq)).toEqual([EOF_DATA1, EOF_DATA2]);
    expect(t.step(controlCodeScreen(StatusCode.XFER_COMPLETE)).done).toEqual({ ok: true });
  });

  it('emits no spurious selector at a frame boundary', () => {
    // The concrete symptom a per-frame codec would produce: frame 2 would open
    // with a selector the quadrant did not need. Here frame 2 opens with
    // quadrant 1's selector only because byte 956 genuinely changes quadrant --
    // so the check is that the stream CONCATENATES to the whole-buffer encoding,
    // which the previous test asserts, and additionally that frame 2's first two
    // bytes are the pair the source demands rather than a doubled selector.
    const t = new CutTransfer({ direction: 'send', data: src });
    const f1 = dataRequestScreen(1);
    t.step(f1);
    const f2 = dataRequestScreen(2);
    t.step(f2);
    const p1 = uploadPayload(f1);
    const p2 = uploadPayload(f2);
    // Frame 1 ends on quadrant 1 (source byte 955 is odd -> 0x41), so frame 2's
    // first source byte (956, even -> 0xc1) needs quadrant 0's selector, once.
    expect(p1[p1.length - 2]).toBe(QUADRANTS[1]!.selector);
    expect(p2[0]).toBe(QUADRANTS[0]!.selector);
    expect(p2[1]).not.toBe(QUADRANTS[0]!.selector);
    expect(p2[1]).not.toBe(QUADRANTS[1]!.selector);
  });

  it('writes a maximal frame over the response area but never over O_SF', () => {
    // CONSTRAINT 3. O_UP_DATA (7) + O_UP_MAX (1912) reaches 1918, so a maximal
    // frame covers the whole response area at 1914-1918. That is x3270's own
    // behaviour (ft_cut.c:515-522) and harmless -- the host is asking for data,
    // not reading a response -- but it is exactly why this machine never writes
    // a response and an upload frame in the same step.
    const t = new CutTransfer({ direction: 'send', data: src });
    const req = dataRequestScreen(1);
    t.step(req);
    expect(uploadLength(req)).toBe(O_UP_MAX);
    expect(O_UP_DATA + O_UP_MAX - 1).toBe(O_SF - 1);
    // The response area now holds encoded data, not a response -- and the frame
    // detection attribute at O_SF is untouched.
    expect(req.cellAt(RO_FRAME_TYPE).ebcdic).not.toBe(ResponseFrameType.CONTROL_CODE);
    expect(req.attributeAt(O_SF)).toBe(0x7c);
    expect(isCutFrame(req)).toBe(true);
  });

  it('aborts if the host keeps asking after end of file', () => {
    // Not something a well-behaved host does, but re-sending the sentinel
    // forever is worse than saying so: the transfer would never terminate.
    const t = new CutTransfer({ direction: 'send', data: Uint8Array.from([0xc1]) });
    t.step(dataRequestScreen(1)); // the data
    t.step(dataRequestScreen(2)); // the sentinel
    const step = t.step(dataRequestScreen(3));
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done?.ok).toBe(false);
    expect(step.done && !step.done.ok && step.done.error).toContain('after end of file');
  });
});

// ---------------------------------------------------------------------------
// Retransmit -- the headline upload test
// ---------------------------------------------------------------------------

describe('FT_RETRANSMIT re-sends the previous block byte-identically', () => {
  /**
   * THE CHARACTERISTIC UPLOAD FAILURE PATH, and the reason the machine retains
   * the ENCODED bytes rather than the source range.
   *
   * x3270 does not do this at all: `cut_retransmit` aborts
   * (ft_cut.c:573-578) under a comment calling its own handling "(Improperly)
   * process a retransmit". `frames.ts` therefore surfaces `retransmit` as a
   * frame kind, and the real behaviour lives here.
   *
   * Why re-encoding would be WRONG rather than merely slower: the codec is
   * stateful. After frame 1 the quadrant sits wherever frame 1 left it, not
   * where frame 1 started, so re-encoding the same source bytes omits the
   * leading selector frame 1 emitted -- and the host would decode the first
   * character against the wrong quadrant. Silent file corruption. The test
   * below measures both halves: that our replay is identical, and that the
   * re-encode a naive implementation would have produced is not.
   */

  it('replays the sequence byte, checksum, length and payload unchanged', () => {
    const t = new CutTransfer({ direction: 'send', data: NASTY });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));

    const first = dataRequestScreen(1);
    t.step(first);
    const original = uploadFrameBytes(first);
    expect(original).toHaveLength(4 + NASTY_ENCODED.length); // seq, csum, 2 len, data

    // The host asks for it again.
    const again = retransmitScreen();
    const step = t.step(again);

    // Enter, not PF1: ACK_RETRANSMIT (PF1) is what a client presses to ask the
    // HOST to re-send. Here the host asked US, so this is an ordinary data frame
    // going up -- the same `run_action(AnEnter)` that ends cut_data_request
    // (ft_cut.c:567).
    expect(step).toEqual({ ack: AckAid.OK });
    expect(t.complete).toBe(false);

    // BYTE-IDENTICAL, over the whole contiguous frame and not just the payload.
    expect(uploadFrameBytes(again)).toEqual(original);
    expect(uploadPayload(again)).toEqual(NASTY_ENCODED);
    expect(again.cellAt(O_UP_FRAME_SEQ).ebcdic).toBe(first.cellAt(O_UP_FRAME_SEQ).ebcdic);
    expect(again.cellAt(O_UP_CSUM).ebcdic).toBe(first.cellAt(O_UP_CSUM).ebcdic);
    expect(uploadLength(again)).toBe(uploadLength(first));

    // The source offset did NOT rewind: the block was accounted for when it was
    // first sent, and the host is asking for the same block again, not for a
    // different one. So the transfer still has 12 of 12 bytes sent.
    expect(t.bytesTransferred).toBe(NASTY.length);

    // And the retained source range is reported, which is what a trace needs:
    // neither number is recoverable from the current position, since the
    // position has already moved past the block.
    expect(t.lastSentBlock).toEqual({
      sourceOffset: 0,
      sourceLength: NASTY.length,
      frameLength: 4 + NASTY_ENCODED.length,
      eof: false,
    });
  });

  it('reports the retained range for a later frame, and for the sentinel', () => {
    const src = Uint8Array.from(
      Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 0xc1 : 0x41)),
    );
    const t = new CutTransfer({ direction: 'send', data: src });
    expect(t.lastSentBlock).toBeUndefined();

    t.step(dataRequestScreen(1));
    expect(t.lastSentBlock).toEqual({
      sourceOffset: 0,
      sourceLength: 956,
      frameLength: O_UP_MAX + 4,
      eof: false,
    });

    t.step(dataRequestScreen(2));
    expect(t.lastSentBlock).toEqual({
      sourceOffset: 956,
      sourceLength: 956,
      frameLength: O_UP_MAX + 4,
      eof: false,
    });

    t.step(dataRequestScreen(3)); // the 88-byte remainder
    t.step(dataRequestScreen(4)); // the sentinel
    expect(t.lastSentBlock).toEqual({
      sourceOffset: src.length,
      sourceLength: 0,
      frameLength: 6, // seq, csum, two length chars, two sentinel bytes
      eof: true,
    });
  });

  it('would NOT have been identical if the block were re-encoded', () => {
    // The measurement that justifies retaining bytes. Re-encoding NASTY with the
    // codec as it stands AFTER frame 1 -- quadrant 0, because the last encoded
    // byte was 0xc4 in quadrant 0 -- drops the leading 0x5e selector and comes
    // out one byte shorter.
    const codec = new CutCodec();
    const firstPass = Array.from(codec.localToHost(NASTY));
    expect(codec.currentQuadrant).toBe(0);
    const secondPass = Array.from(codec.localToHost(NASTY));

    expect(firstPass[0]).toBe(QUADRANTS[0]!.selector);
    expect(secondPass[0]).not.toBe(QUADRANTS[0]!.selector);
    expect(secondPass).toHaveLength(firstPass.length - 1);
    expect(secondPass).not.toEqual(firstPass);

    // And decoding the re-encoded bytes with a fresh codec -- which is what the
    // host would do for the FIRST frame of a transfer -- fails outright, so the
    // consequence really is a broken upload rather than a cosmetic difference.
    expect(() => decodeWhole(secondPass)).toThrow(/not a quadrant selector/);
  });

  it('replays a maximal frame, all 1912 bytes of it', () => {
    // The retained block is bounded by O_UP_MAX + 4, so the worst case is worth
    // exercising: a full frame's replay must reach 1918 and stop.
    const src = Uint8Array.from(
      Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 0xc1 : 0x41)),
    );
    const t = new CutTransfer({ direction: 'send', data: src });
    const first = dataRequestScreen(1);
    t.step(first);
    expect(uploadLength(first)).toBe(O_UP_MAX);
    const original = uploadFrameBytes(first);

    const again = retransmitScreen();
    t.step(again);
    expect(uploadFrameBytes(again)).toEqual(original);
    expect(uploadFrameBytes(again)).toHaveLength(O_UP_MAX + 4);
    // Nothing past 1918: O_SF still carries the detection attribute.
    expect(again.attributeAt(O_SF)).toBe(0x7c);
    expect(isCutFrame(again)).toBe(true);
  });

  it('replays the END-OF-FILE frame too, if that was the last one sent', () => {
    // The sentinel goes on the wire RAW (ft_cut.c:541-546), so a retransmit of
    // it must also be raw -- pushing 0x5c through the codec would emit something
    // else entirely, since 0x5c is quadrant 2's selector.
    const t = new CutTransfer({ direction: 'send', data: Uint8Array.from([0xc1, 0xc2]) });
    t.step(dataRequestScreen(1));
    const eofReq = dataRequestScreen(2);
    t.step(eofReq);
    const original = uploadFrameBytes(eofReq);

    const again = retransmitScreen();
    expect(t.step(again)).toEqual({ ack: AckAid.OK });
    expect(uploadFrameBytes(again)).toEqual(original);
    expect(uploadPayload(again)).toEqual([EOF_DATA1, EOF_DATA2]);
  });

  it('continues correctly after a retransmit: the next frame is frame 2', () => {
    // A retransmit must not disturb the source position or the codec, or the
    // recovery would corrupt everything after it. Drive request, retransmit,
    // request -- and check the concatenation still equals the whole-buffer
    // encoding, which it cannot if either moved.
    const src = Uint8Array.from(
      Array.from({ length: 1200 }, (_, i) => (i % 2 === 0 ? 0xc1 : 0x41)),
    );
    const t = new CutTransfer({ direction: 'send', data: src });

    const f1 = dataRequestScreen(1);
    t.step(f1);
    t.step(retransmitScreen());
    const f2 = dataRequestScreen(2);
    t.step(f2);

    expect(t.bytesTransferred).toBe(src.length);
    expect([...uploadPayload(f1), ...uploadPayload(f2)]).toEqual(encodeWhole(src));
    expect(decodeWhole([...uploadPayload(f1), ...uploadPayload(f2)])).toEqual(Array.from(src));
  });

  it('replays twice in a row identically', () => {
    // The retained block is not consumed by being replayed, so a host that asks
    // twice gets the same answer twice.
    const t = new CutTransfer({ direction: 'send', data: NASTY });
    const first = dataRequestScreen(1);
    t.step(first);
    const original = uploadFrameBytes(first);
    const a = retransmitScreen();
    const b = retransmitScreen();
    t.step(a);
    t.step(b);
    expect(uploadFrameBytes(a)).toEqual(original);
    expect(uploadFrameBytes(b)).toEqual(original);
  });

  it('aborts on a retransmit before anything has been sent', () => {
    // Nothing exists to re-send, so x3270's abort is the only honest answer:
    // `cut_abort(get_message("ftCutRetransmit"), SC_ABORT_XMIT)` (ft_cut.c:577),
    // whose message text is "Transmission error" (fb-common:39).
    const t = new CutTransfer({ direction: 'send', data: NASTY });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const s = retransmitScreen();
    const step = t.step(s);
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done).toEqual({
      ok: false,
      error: 'Transmission error',
      status: StatusCode.ABORT_XMIT,
    });
    expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(ResponseFrameType.CONTROL_CODE);
  });

  it('aborts on a retransmit during a DOWNLOAD, where nothing was ever sent', () => {
    // host->local we send only acknowledgements, so there is no previous frame
    // and no client-initiated recovery in the protocol. x3270's abort is simply
    // correct in this direction.
    const t = new CutTransfer({ direction: 'receive' });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const step = t.step(retransmitScreen());
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done).toEqual({
      ok: false,
      error: 'Transmission error',
      status: StatusCode.ABORT_XMIT,
    });
  });
});

// ---------------------------------------------------------------------------
// Aborts
// ---------------------------------------------------------------------------

describe('an abort from the host', () => {
  // ft_cut.c:448-486. Both status codes take the same path, and the host's own
  // text at O_CC_MESSAGE is what the user needs to see -- for SC_ABORT_FILE it
  // is typically the reason the dataset could not be written.

  for (const [name, status] of [
    ['SC_ABORT_FILE', StatusCode.ABORT_FILE],
    ['SC_ABORT_XMIT', StatusCode.ABORT_XMIT],
  ] as const) {
    it(`fails the transfer with the host's text for ${name}`, () => {
      const message = 'TRANS13 - Error writing file';
      const t = new CutTransfer({ direction: 'receive' });
      t.step(controlCodeScreen(StatusCode.HOST_ACK));
      t.step(dataScreen(NASTY_ENCODED, 1));

      const s = controlCodeScreen(status, `${message}$`, 5);
      const step = t.step(s);

      // ACKNOWLEDGED WITH ENTER, NOT PF2: `cut_ack()` at ft_cut.c:452. The host
      // has already decided; PF2 is only for an abort WE initiate.
      expect(step.ack).toBe(AckAid.OK);
      expect(step.done).toEqual({ ok: false, error: message, status });
      expect(t.complete).toBe(true);
      // The trailing '$' -- IND$FILE's own message terminator -- was stripped by
      // frames.ts (ft_cut.c:474-476), and nothing was written to the response
      // area, because this abort is not ours.
      expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(0x00);
      // Whatever had been received is NOT delivered: a failed download must not
      // hand back a truncated file that looks complete.
      expect(step.done && !step.done.ok).toBe(true);
    });

    it(`fails an upload the same way for ${name}`, () => {
      const t = new CutTransfer({ direction: 'send', data: NASTY });
      t.step(dataRequestScreen(1));
      const step = t.step(controlCodeScreen(status, 'TRANS17 - Error reading file'));
      expect(step.ack).toBe(AckAid.OK);
      expect(step.done).toEqual({
        ok: false,
        error: 'TRANS17 - Error reading file',
        status,
      });
    });
  }

  it('substitutes ftHostCancel when the abort carried no text', () => {
    // `if (!*buf) { strcpy(buf, get_message("ftHostCancel")); }`
    // (ft_cut.c:480-482), whose text is "Transfer canceled by host"
    // (fb-common:36). Without this a failed transfer would report an empty
    // reason, which is the least useful possible error.
    const t = new CutTransfer({ direction: 'receive' });
    const blank = controlCodeScreen(StatusCode.ABORT_FILE);
    // Blanks rather than NULs, as the host would actually paint them.
    for (let i = 0; i < 80; i++) blank.setChar(O_CC_MESSAGE + i, 0x40);
    const step = t.step(blank);
    expect(step.done).toEqual({
      ok: false,
      error: 'Transfer canceled by host',
      status: StatusCode.ABORT_FILE,
    });
  });

  it('aborts on an unknown control code, naming the code', () => {
    // `cut_abort(get_message("ftCutUnknownControl"), SC_ABORT_XMIT)`
    // (ft_cut.c:487-490). frames.ts deliberately PARSES an unknown status rather
    // than rejecting it, precisely so this decision could live here and could
    // report the number.
    const t = new CutTransfer({ direction: 'receive' });
    const s = controlCodeScreen(0x8277, '', 4);
    const step = t.step(s);
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done?.ok).toBe(false);
    expect(step.done && !step.done.ok && step.done.error).toBe(
      'Unknown FT control code from host (0x8277)',
    );
    expect(step.done && !step.done.ok && step.done.status).toBe(StatusCode.ABORT_XMIT);
    // And the response area carries our abort (ft_cut.c:669-672).
    expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(ResponseFrameType.CONTROL_CODE);
    expect(s.cellAt(RO_REASON_CODE).ebcdic).toBe(0x81); // HIGH8(SC_ABORT_XMIT)
    expect(s.cellAt(RO_REASON_CODE + 1).ebcdic).toBe(0x98); // LOW8
  });
});

describe('an oversize declared length', () => {
  it('fails the transfer and writes an SC_ABORT_XMIT response', () => {
    // `if ((int)raw_length > O_RESPONSE - O_DT_DATA) { cut_abort(
    //      get_message("ftCutOversize"), SC_ABORT_XMIT); return; }`
    // (ft_cut.c:617-620). parseFrame already rejects it with a CutFrameError
    // carrying that status; the machine's job is to turn the throw into a failed
    // transfer plus the response the host expects.
    const len = MAX_DOWNLOAD_DATA + 1; // one byte over, so strictness is pinned
    const s = cutScreen();
    s.setChar(O_FRAME_TYPE, FrameType.DATA);
    s.setChar(O_DT_FRAME_SEQ, 0x4a); // off-alphabet, to check the RAW echo
    s.setChar(O_DT_LEN, to6((len >> 6) & 0x3f));
    s.setChar(O_DT_LEN + 1, to6(len & 0x3f));

    const t = new CutTransfer({ direction: 'receive' });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const step = t.step(s);

    expect(step.ack).toBe(AckAid.ABORT); // PF2, ft_cut.c:674
    expect(step.done?.ok).toBe(false);
    expect(step.done && !step.done.ok && step.done.status).toBe(StatusCode.ABORT_XMIT);
    expect(step.done && !step.done.ok && step.done.error).toContain('1910');
    expect(t.complete).toBe(true);

    // The response, at 1915-1918 (ft_cut.c:669-672).
    expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(ResponseFrameType.CONTROL_CODE);
    expect(s.cellAt(RO_REASON_CODE).ebcdic).toBe(0x81);
    expect(s.cellAt(RO_REASON_CODE + 1).ebcdic).toBe(0x98);
    // THE SEQUENCE BYTE IS READ RAW FROM OFFSET 1, exactly as x3270 does:
    // `ctlr_add(RO_FRAME_SEQ, ea_buf[O_DT_FRAME_SEQ].ec, 0)` (ft_cut.c:670).
    // 0x4a decodes to 0 but is not to6(0), so re-encoding would have put a
    // different byte on the wire.
    expect(s.cellAt(RO_FRAME_SEQ).ebcdic).toBe(0x4a);
    expect(to6(from6(0x4a))).not.toBe(0x4a);
    // And O_SF is intact, so the session can still detect frames.
    expect(isCutFrame(s)).toBe(true);
  });

  it('fails on an unknown frame type, too', () => {
    // `default: cut_abort(get_message("ftCutUnknownFrame"), SC_ABORT_XMIT)`
    // (ft_cut.c:408-411). An unrecognised type means we have lost sync with the
    // host, and guessing would write a wrong file.
    const s = cutScreen();
    s.setChar(O_FRAME_TYPE, 0x99);
    const t = new CutTransfer({ direction: 'receive' });
    const step = t.step(s);
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done && !step.done.ok && step.done.error).toContain('0x99');
    expect(step.done && !step.done.ok && step.done.status).toBe(StatusCode.ABORT_XMIT);
    expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(ResponseFrameType.CONTROL_CODE);
  });

  it('aborts, rather than throwing, on a data frame that will not decode', () => {
    // `cut_abort(get_message("ftCutConversionError"), SC_ABORT_XMIT)`
    // (ft_cut.c:156, :164) -- which is exactly the mapping the CutConversionError
    // class comment says the state machine would apply. 0x40 is a valid ALPHAS
    // character but not a quadrant selector, so it fails at the very first byte
    // of a transfer.
    const t = new CutTransfer({ direction: 'receive' });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const s = dataScreen([0x40, 0x40], 1);
    const step = t.step(s);
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done && !step.done.ok && step.done.status).toBe(StatusCode.ABORT_XMIT);
    expect(step.done && !step.done.ok && step.done.error).toContain('not a quadrant selector');
    expect(s.cellAt(RO_FRAME_TYPE).ebcdic).toBe(ResponseFrameType.CONTROL_CODE);
  });

  it('RETHROWS a geometry error rather than reporting a transfer failure', () => {
    // A 43x80 screen is a local configuration bug, not something the host did,
    // and the CutFrameError for it carries no abortStatus precisely so it can be
    // told apart. Reporting it as a transfer failure would send whoever debugs
    // it looking at the host. The design doc's coupling warning is what this
    // enforces.
    const t = new CutTransfer({ direction: 'receive' });
    expect(() => t.step(new Screen({ rows: 43, cols: 80 }))).toThrow(CutFrameError);
    expect(t.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direction faults and terminal behaviour
// ---------------------------------------------------------------------------

describe('a frame for the wrong direction', () => {
  // x3270 has no such check: its `cut_data_request` would read from a file it
  // opened for writing. We would rather fail than write a corrupt local file or
  // send garbage up, because both are silent.

  it('aborts when the host requests data during a receive', () => {
    const t = new CutTransfer({ direction: 'receive' });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const step = t.step(dataRequestScreen(1));
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done && !step.done.ok && step.done.error).toContain(
      'requested data during a receive',
    );
  });

  it('aborts when the host sends data during a send', () => {
    const t = new CutTransfer({ direction: 'send', data: NASTY });
    t.step(controlCodeScreen(StatusCode.HOST_ACK));
    const step = t.step(dataScreen(NASTY_ENCODED, 1));
    expect(step.ack).toBe(AckAid.ABORT);
    expect(step.done && !step.done.ok && step.done.error).toContain('sent data during a send');
  });
});

describe('after the transfer has ended', () => {
  it('is inert: no ack, no screen writes, the same result', () => {
    // Whoever drives this is subscribed to a `screen` event, so a late frame is
    // entirely possible -- the host may still be painting when we have already
    // completed. Acking it would put an AID on the wire after the transfer, and
    // writing the screen could corrupt whatever came next.
    const t = new CutTransfer({ direction: 'receive' });
    t.step(dataScreen(NASTY_ENCODED, 1));
    const done = t.step(controlCodeScreen(StatusCode.XFER_COMPLETE)).done;
    expect(done).toEqual({ ok: true, data: NASTY });

    const late = cutScreen();
    late.setChar(O_FRAME_TYPE, 0x99); // would otherwise abort loudly
    const step = t.step(late);
    expect(step.ack).toBeUndefined();
    expect(step.done).toEqual(done);
    expect(t.result).toEqual(done);
    expect(late.cellAt(RO_FRAME_TYPE).ebcdic).toBe(0x00);
  });

  it('reports its result through `result` as well as through the step', () => {
    const t = new CutTransfer({ direction: 'send', data: NASTY });
    expect(t.result).toBeUndefined();
    expect(t.complete).toBe(false);
    t.step(controlCodeScreen(StatusCode.XFER_COMPLETE));
    expect(t.result).toEqual({ ok: true });
    expect(t.complete).toBe(true);
  });
});
