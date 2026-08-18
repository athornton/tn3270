/**
 * IND$FILE CUT-mode transfer state machine: frames in, intents out.
 *
 * This is the third of the four units the design doc lays out
 * (docs/superpowers/specs/2026-08-18-indfile-cut-transfer-design.md): the codec
 * is `ft/cut.ts`, the frame layout is `ft/frames.ts`, and the `Transfer()` CLI
 * action that drives a `Session` is a later unit. This module does NO I/O. It
 * never touches a socket, never opens a file, and does not import `Session`. It
 * is handed a `Screen` that already holds a CUT frame, it may write a response
 * or an upload frame INTO that screen, and it returns the AID to press and
 * whether the transfer has ended. That is what makes a whole scripted transfer
 * testable against synthetic screens — see packages/core/test/ft/transfer.test.ts.
 *
 * Ported from x3270 4.5 `Common/ft_cut.c`: `ft_cut_data` (:391-414) is the
 * dispatch, and `cut_control_code` (:419-492), `cut_data_request` (:497-568),
 * `cut_retransmit` (:573-578), `cut_data` (:599-647), `cut_ack` (:652-657) and
 * `cut_abort` (:662-678) are the five handlers. Every branch below cites the
 * line it came from, and every deliberate divergence says so.
 *
 * ## FOUR CONSTRAINTS, EACH OF WHICH HAS ALREADY COST THIS PROJECT SOMETHING
 *
 * **1. ONE `CutCodec` FOR THE WHOLE TRANSFER.** Finding 3 in the design doc.
 * The quadrant is persistent state and a selector byte is emitted only when it
 * changes, so a per-frame codec would put a spurious leading selector on every
 * upload frame after the first, and would reject a download frame that
 * legitimately starts with data rather than a selector. This class constructs
 * exactly one codec, in its constructor, and resets it only where x3270 does
 * (on `SC_HOST_ACK`, ft_cut.c:435).
 *
 * **2. A RETRANSMIT RE-SENDS THE PREVIOUS BLOCK BYTE-IDENTICALLY,** and the way
 * that is achieved is the central design decision here. See `RetainedBlock`.
 *
 * **3. A MAXIMAL UPLOAD FRAME OVERWRITES THE RESPONSE AREA.** `O_UP_DATA` (7) +
 * `O_UP_MAX` (1912) = 1919, so the data runs to 1918 and the response area
 * begins at 1914. A response and a maximal upload frame therefore cannot
 * coexist in one screen, and this machine never writes both: the abort path and
 * the upload path are mutually exclusive branches of a single `step`. `O_SF`
 * itself is never written by either, so frame detection survives regardless.
 *
 * **4. SEQUENCE NUMBERS ARE ECHOED RAW.** `frames.ts` exposes both `seq`
 * (through `from6`) and `rawSeq` (the literal byte) because `to6(from6(b))` is
 * not the identity for the 192 bytes outside the alphabet. Everything written
 * back to the host here uses `rawSeq`, or reads the byte straight out of the
 * screen as x3270 does.
 */

import { FA } from '../constants.js';
import type { Screen } from '../screen.js';
import { CutCodec, CutConversionError, checksum } from './cut.js';
import {
  AckAid,
  CutFrameError,
  O_DR_SF,
  O_DT_FRAME_SEQ,
  O_UP_DATA,
  O_UP_FRAME_SEQ,
  ResponseFrameType,
  StatusCode,
  isEofData,
  isKnownStatusCode,
  parseFrame,
  writeResponse,
  writeUploadData,
  writeUploadEof,
  type CutFrame,
} from './frames.js';

/**
 * Which way the file is going, named from the LOCAL side — the opposite of
 * x3270's internal vocabulary, which names both directions from the host's.
 *
 * `receive` is host->local, `IND$FILE GET`, and uses `hostToLocal`.
 * `send` is local->host, `IND$FILE PUT`, and uses `localToHost`. The design doc
 * calls this out as naming trap 1 and it is why no identifier in this module is
 * called "upload" or "download" without an offset constant's name attached: the
 * `O_UP_*` offsets are x3270's, and those really are the local->host ones.
 */
export type TransferDirection = 'send' | 'receive';

export interface TransferOptions {
  direction: TransferDirection;
  /**
   * For `send`, the bytes to put on the host. Required, and a `send` without it
   * throws from the constructor rather than transferring an empty file.
   * For `receive`, must be omitted: passing data to a download is a caller
   * mistake worth failing loudly on.
   */
  data?: Uint8Array | readonly number[];
}

/**
 * How a transfer ended.
 *
 * `status` on failure is the `StatusCode` involved — the one the host sent in
 * its control code, or the one we put in the response area when we aborted. It
 * is what a trace wants and what a test can assert on without matching prose.
 */
export type TransferResult =
  | { ok: true; data?: Uint8Array }
  | { ok: false; error: string; status?: number };

export interface TransferStep {
  /**
   * The AID to press, if any. Present on every step until the transfer has
   * ended; absent only when `step` is called again after completion.
   *
   * Note that a HOST-initiated abort is acknowledged with Enter, not PF2:
   * `cut_control_code` calls `cut_ack()` for `SC_ABORT_FILE`/`SC_ABORT_XMIT`
   * (ft_cut.c:452) before completing the transfer as failed. PF2
   * (`AckAid.ABORT`) is only for an abort WE initiate.
   */
  ack?: number;
  /** Present exactly once, on the step that ends the transfer. */
  done?: TransferResult;
}

/**
 * The previous local->host frame, retained verbatim so a `FT_RETRANSMIT` can
 * re-send it byte for byte.
 *
 * ## WHY THE ENCODED BYTES AND NOT THE SOURCE RANGE
 *
 * This is the design decision the task singles out, and re-encoding is not an
 * option. The codec is stateful: `localToHost` emits a selector only when the
 * quadrant changes, so encoding the same source bytes again — with the quadrant
 * now sitting wherever the frame LEFT it rather than where the frame STARTED —
 * produces a different byte string. Concretely, a frame whose first byte needed
 * a selector would not emit one the second time, and the host would decode the
 * first character against the wrong quadrant. That is a silent file corruption,
 * not a visible failure.
 *
 * The alternatives were:
 *
 *  - **Snapshot and restore the codec's quadrant.** `CutCodec` deliberately
 *    exposes only `currentQuadrant` (read) and `reset()`, because a settable
 *    quadrant is a footgun; faking a restore by encoding a priming byte would
 *    emit bytes nobody asked for. And even done cleanly it buys nothing: it
 *    reproduces the same output only by re-deriving it, so it is strictly more
 *    machinery for a strictly weaker guarantee.
 *  - **Retain the bytes.** Byte-identity holds BY CONSTRUCTION rather than by
 *    an argument about determinism, and it costs at most 1916 bytes.
 *
 * So we retain the bytes. And we retain them by reading them back out of the
 * screen `frames.ts` just wrote, not by recomputing them: the whole frame
 * `writeUploadData`/`writeUploadEof` writes is the CONTIGUOUS range
 * `O_UP_FRAME_SEQ`(3), `O_UP_CSUM`(4), `O_UP_LEN`(5,6), `O_UP_DATA`(7)..
 * `O_UP_DATA + count - 1`, so one loop captures the sequence byte, the
 * checksum, the two length characters and the payload together. Nothing in this
 * module recomputes a checksum or re-encodes a length, which means a retransmit
 * cannot drift from a first transmission even if `frames.ts` changed how it
 * computes either.
 *
 * The source range is retained too, per the design, but only as a record: the
 * offset is NOT rewound on a retransmit, because the block was already accounted
 * for when it was first sent and the host is asking for the same block again,
 * not for a different one.
 */
interface RetainedBlock {
  /** First address written: `O_UP_FRAME_SEQ`. */
  addr: number;
  /** The frame's bytes, `addr` onwards, exactly as they went to the host. */
  bytes: Uint8Array;
  /** Where in the source this block started. A record, not used to rewind. */
  sourceOffset: number;
  /** How many SOURCE bytes it covered. 0 for the end-of-file frame. */
  sourceLength: number;
  /** Was this the end-of-file sentinel frame rather than data? */
  eof: boolean;
}

/**
 * x3270's own message strings, from `Common/fb-common:35-41`, so a user reading
 * our failure sees the text they would have seen from wc3270.
 */
const MSG = {
  /** `ftHostCancel`, substituted when the host's abort carried no text
   * (ft_cut.c:480-482). */
  HOST_CANCEL: 'Transfer canceled by host',
  /** `ftCutUnknownControl` (ft_cut.c:489). */
  UNKNOWN_CONTROL: 'Unknown FT control code from host',
  /** `ftCutRetransmit` (ft_cut.c:577). */
  RETRANSMIT: 'Transmission error',
} as const;

/**
 * The CUT transfer state machine.
 *
 * One instance per transfer, and it is single-use: once `step` has returned a
 * `done`, the transfer is over and further steps are inert. A second transfer
 * needs a second instance, which is also what keeps the codec's quadrant from
 * leaking between transfers (the bug x3270's file-static `quadrant` has and we
 * declined to inherit — see the `CutCodec` class comment).
 */
export class CutTransfer {
  readonly direction: TransferDirection;

  /**
   * THE ONE CODEC. Constructed here, held for the life of the transfer, reset
   * only on `SC_HOST_ACK` where x3270 resets its quadrant (ft_cut.c:435).
   */
  private readonly codec = new CutCodec();

  /** local->host: the source bytes. Empty for a `receive`. */
  private readonly source: Uint8Array;

  /** local->host: how many source bytes have been sent. */
  private offset = 0;

  /** local->host: the previous frame, for a retransmit. See `RetainedBlock`. */
  private lastBlock: RetainedBlock | undefined;

  /** local->host: has the end-of-file sentinel gone out? */
  private eofSent = false;

  /** host->local: decoded file bytes, kept in chunks and joined once. */
  private readonly chunks: Uint8Array[] = [];
  private receivedLength = 0;

  /** host->local: has the two-byte EOF sentinel arrived? Reported, not required. */
  private eofSeen = false;

  private readonly warningList: string[] = [];

  private outcome: TransferResult | undefined;

  constructor(opts: TransferOptions) {
    this.direction = opts.direction;
    if (opts.direction === 'send') {
      if (opts.data === undefined) {
        throw new TypeError("a 'send' transfer needs the bytes to send");
      }
      this.source = opts.data instanceof Uint8Array ? opts.data : Uint8Array.from(opts.data);
    } else {
      if (opts.data !== undefined) {
        throw new TypeError("a 'receive' transfer takes no data; the host supplies it");
      }
      this.source = new Uint8Array(0);
    }
  }

  /** The result, once the transfer has ended; `undefined` while it is running. */
  get result(): TransferResult | undefined {
    return this.outcome;
  }

  /** Has the transfer ended, either way? */
  get complete(): boolean {
    return this.outcome !== undefined;
  }

  /**
   * Non-fatal oddities noticed along the way, in order.
   *
   * Today this holds exactly one kind of entry: a download checksum that did not
   * match. See `verifyChecksum` for why that warns rather than aborts. Exposed
   * so a CLI can surface it, because a warning nobody can see is not a warning.
   *
   * A COPY, so a caller cannot append to or truncate our log. `readonly` in the
   * type only stops the honest mistake.
   */
  get warnings(): readonly string[] {
    return [...this.warningList];
  }

  /**
   * File bytes moved so far — decoded bytes written for a `receive`, source
   * bytes sent for a `send`. x3270's `ft_update_length` progress display
   * (ft_cut.c:565, :644) reads the same two counters.
   */
  get bytesTransferred(): number {
    return this.direction === 'receive' ? this.receivedLength : this.offset;
  }

  /** Did the host send the two-byte EOF sentinel? host->local only. */
  get sawEof(): boolean {
    return this.eofSeen;
  }

  /**
   * What a `FT_RETRANSMIT` would re-send, or `undefined` before the first
   * local->host frame has gone out.
   *
   * This is what makes the retained source range (see `RetainedBlock`) more than
   * bookkeeping: "re-sent 956 bytes from offset 1912" is the trace line a
   * retransmit needs, and neither number is recoverable from the transfer's
   * current position, because the position has already moved past the block.
   */
  get lastSentBlock():
    | { sourceOffset: number; sourceLength: number; frameLength: number; eof: boolean }
    | undefined {
    const b = this.lastBlock;
    if (b === undefined) return undefined;
    return {
      sourceOffset: b.sourceOffset,
      sourceLength: b.sourceLength,
      frameLength: b.bytes.length,
      eof: b.eof,
    };
  }

  /**
   * Process the CUT frame currently on `screen`, which may be mutated with a
   * response or an upload frame.
   *
   * The caller gates on `isCutFrame(screen)`; this does not, for the same reason
   * `parseFrame` does not — the two questions are separable, and a test wants to
   * drive a synthetic frame without also constructing the detection attribute.
   *
   * Faults are contained. A malformed frame ends the TRANSFER, never the
   * session, which is the design doc's error rule and matches how a program
   * check reports without dropping the connection. The single exception is a
   * screen of the wrong geometry: `frames.ts` throws a `CutFrameError` with no
   * `abortStatus` for that, because it is a local configuration bug rather than
   * anything the host did, and we rethrow it rather than reporting a transfer
   * failure that would send whoever debugs it looking at the host.
   */
  step(screen: Screen): TransferStep {
    if (this.outcome !== undefined) {
      // Idempotent after the end: no ack, no screen writes, the same result.
      return { done: this.outcome };
    }

    let frame: CutFrame;
    try {
      frame = parseFrame(screen);
    } catch (e) {
      if (e instanceof CutFrameError && e.abortStatus !== undefined) {
        // The two faults x3270 aborts on: an unknown frame type
        // (ft_cut.c:408-411) and an oversize declared length (ft_cut.c:617-620),
        // both with SC_ABORT_XMIT. `CutFrameError` carries which, so we do not
        // re-derive it, and its message is more specific than x3270's fixed
        // "Illegal frame length" / "Unknown frame type from host".
        return this.abort(screen, e.abortStatus, e.message);
      }
      throw e; // wrong geometry: loud, and not the host's fault
    }

    return this.direction === 'receive'
      ? this.stepReceive(screen, frame)
      : this.stepSend(screen, frame);
  }

  // -------------------------------------------------------------------------
  // host -> local (IND$FILE GET)
  // -------------------------------------------------------------------------

  private stepReceive(screen: Screen, frame: CutFrame): TransferStep {
    switch (frame.kind) {
      case 'controlCode':
        return this.controlCode(screen, frame.status, frame.message);

      case 'data': {
        // `if (raw_length == 2 && cvbuf[0] == EOF_DATA1 && cvbuf[1] ==
        // EOF_DATA2) { cut_ack(); return; }` (ft_cut.c:625-629). EOF is
        // acknowledged and then the host sends SC_XFER_COMPLETE; the sentinel
        // itself is not file content and must not be decoded.
        if (isEofData(frame.data)) {
          this.eofSeen = true;
          return { ack: AckAid.OK };
        }

        this.verifyChecksum(frame.seq, frame.declaredChecksum, frame.data);

        let decoded: Uint8Array;
        try {
          // THE ONE CODEC, carrying its quadrant across every frame. A fresh
          // one here would reject any frame whose first byte is data rather
          // than a selector — which is most frames after the first.
          decoded = this.codec.hostToLocal(frame.data);
        } catch (e) {
          if (e instanceof CutConversionError) {
            // `cut_abort(get_message("ftCutConversionError"), SC_ABORT_XMIT)`
            // (ft_cut.c:156, :164), which is exactly the mapping the
            // `CutConversionError` class comment promises the state machine
            // would apply.
            return this.abort(screen, StatusCode.ABORT_XMIT, e.message);
          }
          throw e;
        }

        this.chunks.push(decoded);
        this.receivedLength += decoded.length;
        // `fts.length += conv_length; ft_update_length(); cut_ack();`
        // (ft_cut.c:643-645).
        return { ack: AckAid.OK };
      }

      case 'retransmit':
        // "Re-send the previous frame" — but host->local we have sent no frame,
        // only acknowledgements, so there is nothing to re-send and no
        // client-initiated recovery in the protocol. x3270 gives up here in
        // BOTH directions (`cut_abort(get_message("ftCutRetransmit"),
        // SC_ABORT_XMIT)`, ft_cut.c:577), and for this direction that is simply
        // correct rather than the "(Improperly)" its own comment admits to.
        return this.abort(screen, StatusCode.ABORT_XMIT, MSG.RETRANSMIT);

      case 'dataRequest':
        // The host asking us for data during a GET means one of us has lost
        // track of the direction. x3270 has no such check — its
        // `cut_data_request` would read from a file it opened for writing — and
        // we would rather fail than write a corrupt local file.
        return this.abort(
          screen,
          StatusCode.ABORT_XMIT,
          'host requested data during a receive transfer',
        );
    }
  }

  /**
   * Compare the checksum the host declared with the one we compute.
   *
   * VERIFY BUT WARN, NEVER ABORT — the design doc's decision, made at the user's
   * request and resting on evidence rather than on principle. x3270 never reads
   * `O_DT_CSUM` at all (its only mention in the tree is the `#define`), and
   * MECAFF on VM/370 ignores the field on receive; but the live TK5 capture
   * proves TK5's IND$FILE POPULATES it — host sent 6-bit 62, our `checksum()`
   * over the same 1904 bytes computed 62 — so a mismatch here is real
   * information rather than a spurious warning on every frame.
   *
   * It must not be fatal for two reasons: the protocol offers no
   * client-initiated retransmit to recover with (`ACK_RETRANSMIT` exists in the
   * header and x3270 never sends it), and failing a transfer that x3270 would
   * have completed would be a regression against the de facto protocol.
   */
  private verifyChecksum(seq: number, declared: number, data: Uint8Array): void {
    const computed = checksum(data);
    if (computed !== declared) {
      this.warningList.push(
        `frame ${seq}: checksum mismatch, host declared ${declared} but ` +
          `${data.length} data bytes compute to ${computed}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // local -> host (IND$FILE PUT)
  // -------------------------------------------------------------------------

  private stepSend(screen: Screen, frame: CutFrame): TransferStep {
    switch (frame.kind) {
      case 'controlCode':
        return this.controlCode(screen, frame.status, frame.message);

      case 'dataRequest': {
        // `cut_data_request` (ft_cut.c:497-568). x3270 discovers end of file by
        // reading it (`xlate_getc() == EOF`, :516-519) and then sends the
        // sentinel on the NEXT pass when `count` came out 0 (:541-546); we know
        // the length up front, so the same two frames come out of one test.
        if (this.offset >= this.source.length) {
          if (this.eofSent) {
            // The host asked for more after we said end of file. Nothing left
            // to give, and re-sending the sentinel forever is worse than saying
            // so.
            return this.abort(
              screen,
              StatusCode.ABORT_XMIT,
              'host requested data after end of file',
            );
          }
          writeUploadEof(screen, frame.rawSeq);
          this.eofSent = true;
          this.retain(screen, 2, this.offset, 0, true);
          return { ack: AckAid.OK };
        }

        const sourceOffset = this.offset;
        let written;
        try {
          written = writeUploadData(screen, {
            rawSeq: frame.rawSeq,
            data: this.source.subarray(sourceOffset),
            codec: this.codec, // THE ONE CODEC again: see the class comment
          });
        } catch (e) {
          if (e instanceof CutConversionError) {
            // Unreachable with intact quadrant tables — all 256 byte values are
            // covered (codec finding 2) — but if it ever fires, note that
            // `writeUploadData` builds its whole encoding before writing any of
            // it, so the screen is untouched and there is nothing to clean out.
            // x3270 does have to zero what it wrote (ft_cut.c:529-532).
            return this.abort(screen, StatusCode.ABORT_XMIT, e.message);
          }
          throw e;
        }

        if (written.consumed === 0) {
          // Cannot happen: the worst-case expansion is 2 encoded bytes per
          // source byte and a frame holds 1912, so a non-empty remainder always
          // consumes at least one byte. Asserted anyway, because the failure
          // mode is an infinite ack loop against a live host rather than
          // anything a reader would spot.
          return this.abort(
            screen,
            StatusCode.ABORT_XMIT,
            `internal error: no source bytes fit in an upload frame with ` +
              `${this.source.length - sourceOffset} still to send`,
          );
        }

        this.offset += written.consumed;
        this.retain(screen, written.encodedLength, sourceOffset, written.consumed, false);
        // `run_action(AnEnter, IA_FT, NULL, NULL)` (ft_cut.c:567).
        return { ack: AckAid.OK };
      }

      case 'retransmit': {
        // WHERE WE DELIBERATELY DIVERGE FROM x3270, and the reason this frame
        // kind exists in `frames.ts` at all. x3270 aborts
        // (`cut_abort(get_message("ftCutRetransmit"), SC_ABORT_XMIT)`,
        // ft_cut.c:577) under a comment that calls its own handling
        // "(Improperly) process a retransmit". The design doc requires the real
        // behaviour: re-send the previous block, byte for byte.
        //
        // The AID is Enter, not PF1: `AckAid.RETRANSMIT` is what a client would
        // press to ask the HOST to re-send, whereas here the host has asked US,
        // so this is an ordinary data frame going up — the same
        // `run_action(AnEnter)` that ends `cut_data_request` (ft_cut.c:567).
        if (this.lastBlock === undefined) {
          // A retransmit before we ever sent a frame — nothing exists to
          // re-send, so x3270's abort is the only honest answer.
          return this.abort(screen, StatusCode.ABORT_XMIT, MSG.RETRANSMIT);
        }
        this.replay(screen, this.lastBlock);
        return { ack: AckAid.OK };
      }

      case 'data':
        // The host sending us data during a PUT: same lost-direction fault as a
        // data request during a GET, and the same answer.
        return this.abort(screen, StatusCode.ABORT_XMIT, 'host sent data during a send transfer');
    }
  }

  /**
   * Snapshot the frame `frames.ts` has just written, for a possible retransmit.
   *
   * The written region is contiguous — `O_UP_FRAME_SEQ` 3, `O_UP_CSUM` 4,
   * `O_UP_LEN` 5-6, `O_UP_DATA` 7 onwards (ft_cut_ds.h:77-80) — so one loop
   * captures the sequence byte, the checksum, both length characters and the
   * payload as one string of bytes. See `RetainedBlock` for why this reads the
   * screen back instead of recomputing any of it.
   *
   * `O_UP_DATA_CODE` (2) is excluded because nothing in x3270 writes it, so
   * copying whatever happens to be at offset 2 would put a byte on the wire that
   * the first transmission did not.
   */
  private retain(
    screen: Screen,
    encodedLength: number,
    sourceOffset: number,
    sourceLength: number,
    eof: boolean,
  ): void {
    const end = O_UP_DATA + encodedLength; // exclusive
    const bytes = new Uint8Array(end - O_UP_FRAME_SEQ);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = screen.cellAt(O_UP_FRAME_SEQ + i).ebcdic;
    }
    this.lastBlock = { addr: O_UP_FRAME_SEQ, bytes, sourceOffset, sourceLength, eof };
  }

  /**
   * Write a retained frame into a new screen, byte for byte.
   *
   * The one thing NOT replayed is the field attribute at `O_DR_SF`: that is
   * x3270's cosmetic "change the data field attribute so it doesn't display"
   * (ft_cut.c:558-561), and it is a property of THIS screen's field structure
   * rather than of the frame we are re-sending, so it is recomputed from the
   * attribute the host planted here. As in `frames.ts`, an absent attribute is
   * left absent rather than invented.
   */
  private replay(screen: Screen, block: RetainedBlock): void {
    for (let i = 0; i < block.bytes.length; i++) {
      screen.setChar(block.addr + i, block.bytes[i]!);
    }
    const attr = screen.attributeAt(O_DR_SF);
    if (attr !== null) {
      screen.setFieldAttribute(O_DR_SF, (attr & ~FA.INTENSITY) | FA.INT_ZERO_NSEL);
    }
  }

  // -------------------------------------------------------------------------
  // shared
  // -------------------------------------------------------------------------

  /**
   * `cut_control_code` (ft_cut.c:419-492) — identical in both directions, which
   * is why it is not duplicated per direction.
   */
  private controlCode(screen: Screen, status: number, message: string): TransferStep {
    switch (status) {
      case StatusCode.HOST_ACK:
        // ft_cut.c:431-441. The host has accepted the IND$FILE command; this is
        // the transfer's real start, and x3270 resets ALL its per-transfer state
        // here: `expanded_length = 0; quadrant = -1; xlate_buffered = 0;
        // xlate_buf_ix = 0; cut_eof = false;`. We do the same, which for us
        // means resetting the codec's quadrant and everything derived from it.
        // Warnings survive, because they are a log rather than transfer state.
        this.codec.reset();
        this.offset = 0;
        this.eofSent = false;
        this.eofSeen = false;
        this.lastBlock = undefined;
        this.chunks.length = 0;
        this.receivedLength = 0;
        return { ack: AckAid.OK };

      case StatusCode.XFER_COMPLETE:
        // `cut_ack(); cut_xfer_in_progress = false; ft_complete(NULL);`
        // (ft_cut.c:442-447). Note the ack comes FIRST and then the transfer
        // completes, so the terminal step carries both.
        return this.finish(AckAid.OK, this.success());

      case StatusCode.ABORT_FILE:
      case StatusCode.ABORT_XMIT:
        // ft_cut.c:448-486. ACKNOWLEDGED WITH ENTER, not PF2: `cut_ack()` at
        // :452, because the host has already decided and is not being asked to
        // do anything. The message is the host's own text from `O_CC_MESSAGE`,
        // already stripped by `frames.ts`; an empty one becomes
        // `ftHostCancel`(:480-482).
        return this.finish(AckAid.OK, {
          ok: false,
          error: message.length > 0 ? message : MSG.HOST_CANCEL,
          status,
        });

      default:
        // `cut_abort(get_message("ftCutUnknownControl"), SC_ABORT_XMIT)`
        // (ft_cut.c:487-490). `frames.ts` deliberately parses an unknown status
        // rather than rejecting it, precisely so this decision could live here
        // and could name the code it rejected.
        // A known code reaching the default branch means someone added a fifth
        // entry to `StatusCode` and to `isKnownStatusCode` without teaching this
        // switch about it. Reporting it to the host as "unknown control code"
        // would be a lie that reads as a host fault, so it throws instead: this
        // is the one failure here that is OURS.
        if (isKnownStatusCode(status)) {
          throw new Error(`internal error: unhandled known status code 0x${status.toString(16)}`);
        }
        return this.abort(
          screen,
          StatusCode.ABORT_XMIT,
          `${MSG.UNKNOWN_CONTROL} (0x${status.toString(16).padStart(4, '0')})`,
        );
    }
  }

  /**
   * We abort: write the response area and press PF2. `cut_abort`
   * (ft_cut.c:662-678), minus the AID, which is the caller's to send.
   *
   * THE SEQUENCE BYTE IS READ STRAIGHT OUT OF THE SCREEN, at offset 1, exactly
   * as x3270 does: `ctlr_add(RO_FRAME_SEQ, ea_buf[O_DT_FRAME_SEQ].ec, 0)`
   * (ft_cut.c:670), regardless of which frame type is actually there. Offset 1
   * is `O_DT_FRAME_SEQ`, `O_CC_FRAME_SEQ` and `O_DR_SF` all at once, so for a
   * data request x3270 echoes the field attribute cell rather than the sequence
   * at offset 3 — faithfully reproduced, because whatever the host makes of that
   * byte it has made of it for decades. It is also the only thing available when
   * `parseFrame` threw before producing a frame at all.
   *
   * Constraint 3 in the module comment: this writes 1915-1918, so it must never
   * run in the same `step` as a maximal upload frame, whose data reaches 1918.
   * It does not — every path here either aborts or writes upload data.
   */
  private abort(screen: Screen, status: number, error: string): TransferStep {
    writeResponse(screen, {
      frameType: ResponseFrameType.CONTROL_CODE,
      rawSeq: screen.cellAt(O_DT_FRAME_SEQ).ebcdic,
      reason: status,
    });
    // `run_action(AnPF, IA_FT, "2", NULL)` (ft_cut.c:674) = ACK_ABORT = PF2.
    return this.finish(AckAid.ABORT, { ok: false, error, status });
  }

  /** The successful result, with the accumulated file for a `receive`. */
  private success(): TransferResult {
    if (this.direction !== 'receive') return { ok: true };
    const data = new Uint8Array(this.receivedLength);
    let at = 0;
    for (const chunk of this.chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    return { ok: true, data };
  }

  private finish(ack: number, result: TransferResult): TransferStep {
    this.outcome = result;
    return { ack, done: result };
  }
}
