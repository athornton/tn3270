/**
 * The DFT file-transfer state machine.
 *
 * ## WHY THIS IS A SEPARATE ENGINE FROM `CutTransfer`
 *
 * CUT is screen-shaped: it takes a `Screen`, parses a frame out of fixed offsets
 * in a 1920-cell buffer, writes a response back into it, and returns an AID to
 * press. That is why CUT works only at 24x80 and why `frames.ts` throws on any
 * other geometry.
 *
 * DFT is record-shaped. **This module imports no `Screen` and no `Session`**, and
 * that is the feature, not an accident of layering: it is what lets a transfer run
 * at 43x80, which is the user's own working geometry and the reason this stage
 * exists. `ft_dft.c` has zero screen-buffer references against 25 in `ft_cut.c`.
 *
 * One instance per transfer, single-use like `CutTransfer` — once `handle` has
 * returned a `done`, the transfer is over and further calls are inert.
 */
import {
  DftRequest,
  buildCloseAck,
  buildDataAck,
  buildDftError,
  buildOpenAck,
  parseDftFrame,
  parseDftOpen,
} from './dftFrames.js';
import { FT_MSG, type TransferDirection, type TransferResult } from './transfer.js';

/** `END_TRANSFER` (`ft_dft.c:54`): the host's own "transfer complete" message. */
const END_TRANSFER = 'TRANS03';

/**
 * Offsets into a `Data Insert` payload.
 *
 * **These ARE x3270's minus 3, unlike the `Open`'s** — `dft_data_insert` is handed
 * `data_bufr` itself, the struct base, so `struct data_buffer`'s own offsets apply
 * and our stripped 3 bytes come off them. The `Open` is the exception because it
 * receives a pointer already 3 bytes in; see the long note in `dftFrames.ts`, which
 * exists because getting that backwards shipped a real bug.
 *
 * Offsets are into `struct data_buffer` (`ft_dft.c:59-67`): `data_length` at 8,
 * `data` at 10, both verified with `offsetof`.
 */
const DATA_LENGTH_AT = 8 - 3;                  // 5
const DATA_AT = 10 - 3;                        // 7
/** The declared data length counts 5 bytes of header. `ft_dft.c:236`. */
const LENGTH_OVERHEAD = 5;

export interface DftOptions {
  direction: TransferDirection;
  /** For `send`, the bytes to put on the host. Required for `send`. */
  data?: Uint8Array | readonly number[];
}

/** What one inbound frame produced. */
export interface DftStep {
  /**
   * The reply to send, as a complete inbound record starting with `AID_SF`.
   *
   * **Absent is a real answer, not a gap.** Set Cursor, Insert and an unknown
   * request type all produce no reply, because x3270's handlers for all three
   * trace and return. Sending something would put unsolicited bytes on the wire
   * mid-transfer.
   */
  reply?: Uint8Array;
  /** Present exactly once, on the frame that ends the transfer. */
  done?: TransferResult;
  /**
   * The request type, when it was one we do not implement. For the caller to
   * trace — x3270 logs `Unsupported(0x%04x)` and carries on (`ft_dft.c:131-133`),
   * and a silent drop with nothing in the log is how an unimplemented request
   * becomes an unexplainable stall.
   */
  unsupported?: number;
}

export class DftTransfer {
  readonly direction: TransferDirection;

  /** local->host: the source bytes. Empty for a `receive`. */
  private readonly source: Uint8Array;
  /** local->host: how many source bytes have gone out. Task 6 advances it. */
  private offset = 0;

  /** host->local: received chunks, joined once at the end. */
  private readonly chunks: Uint8Array[] = [];
  private receivedLength = 0;

  /** The record number on the next acknowledgement. `recnum` starts at 1. */
  private recordNumber = 1;

  /**
   * Did the host open `FT:MSG` rather than a file? Exposed because the session
   * needs it: a message transfer must not be reported as a file transfer.
   */
  private messageFlag = false;

  /** Has the operator asked to cancel? Checked on the inbound edge. */
  private cancelRequested = false;

  private outcome: TransferResult | undefined;

  constructor(opts: DftOptions) {
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

  get result(): TransferResult | undefined { return this.outcome; }
  get complete(): boolean { return this.outcome !== undefined; }
  get isMessage(): boolean { return this.messageFlag; }
  /** Bytes transferred so far, for a progress display. */
  get transferred(): number {
    return this.direction === 'send' ? this.offset : this.receivedLength;
  }

  /**
   * Ask for the transfer to stop. Idempotent, and deliberately does NOT send
   * anything: DFT defers, checking the flag on the next inbound frame
   * (`ft_dft.c:225-228`, `:576-579`). CUT sends its abort immediately because a
   * front end closing a form has no later frame to wait on; a DFT transfer always
   * has a next inbound frame, so the deferral is free and matches x3270.
   */
  cancel(): void {
    this.cancelRequested = true;
  }

  /** Feed one `SF_TRANSFER_DATA` payload in; get the reply out. */
  handle(payload: Uint8Array): DftStep {
    if (this.outcome !== undefined) return { done: this.outcome };

    const frame = parseDftFrame(payload);

    // The cancellation edge: x3270 tests this in dft_data_insert and
    // dft_get_request, before processing either (ft_dft.c:225, :576). NOT for a
    // message frame, which is how the host's own final message still gets read.
    if (this.cancelRequested && !this.messageFlag
      && (frame.requestType === DftRequest.DATA_INSERT || frame.requestType === DftRequest.GET)) {
      return this.fail(FT_MSG.USER_CANCEL, frame.requestType);
    }

    switch (frame.requestType) {
      case DftRequest.OPEN: return this.onOpen(frame.payload);
      case DftRequest.DATA_INSERT: return this.onDataInsert(frame.payload);
      case DftRequest.CLOSE: return this.onClose();
      // NEITHER SENDS ANYTHING. Both x3270 handlers trace and return -- they are
      // empty functions, `dft_insert_request` at ft_dft.c:193-198 and
      // `dft_set_cur_req` at :414-419, each carrying a "doesn't currently do
      // anything" comment. So the correct reply is NO reply.
      //
      // An earlier draft of the plan had these acknowledge with an Open ack,
      // which would put six unsolicited bytes on the wire to a live mainframe
      // mid-transfer. Returning {} is not laziness; it is what the reference does.
      case DftRequest.SET_CUR:
      case DftRequest.INSERT: return {};
      default:
        // ALSO SILENT. x3270's default arm traces "Unsupported(0x%04x)" and
        // breaks (ft_dft.c:131-133) -- it does not send an error reply, and
        // inventing one would answer a frame the host may not expect an answer to.
        // The caller traces; this returns nothing.
        return { unsupported: frame.requestType };
    }
  }

  /**
   * An `Open`. Acknowledged either way — x3270 acks at `ft_dft.c:181`, which is
   * AFTER it has set `message_flag` at `:171-176` but unconditional on it, so a
   * message open gets the same six bytes a file open does.
   *
   * `message_flag` is a single flag RESET by every Open, which is what lets one
   * transfer be a file and then a message. The received chunks must survive that
   * — see `onClose` for the sequence, and note there is a test asserting the
   * chunks are not discarded here, because clearing them would deliver an empty
   * file while reporting success.
   */
  private onOpen(payload: Uint8Array): DftStep {
    const open = parseDftOpen(payload);
    this.messageFlag = open.isMessage;
    // recnum = 1 at ft_dft.c:178, in dft_open_request and nowhere else.
    this.recordNumber = 1;
    return { reply: buildOpenAck() };
  }

  private onDataInsert(payload: Uint8Array): DftStep {
    const declared = (payload[DATA_LENGTH_AT]! << 8) | payload[DATA_LENGTH_AT + 1]!;
    const length = declared - LENGTH_OVERHEAD;
    const data = payload.subarray(DATA_AT, DATA_AT + Math.max(0, length));

    if (this.messageFlag) return this.onMessage(data);

    // x3270 guards the file write with `if (my_length > 0)` (ft_dft.c:284) and
    // acknowledges OUTSIDE that block (:410, after it closes at :407), so an empty
    // frame is acked rather than treated as an error.
    if (data.length > 0) {
      // Copied, not retained: `payload` is a view into the inbound record's buffer
      // and the caller is free to reuse it. A subarray here would alias a buffer
      // that the next read overwrites, which would corrupt every chunk but the last.
      this.chunks.push(Uint8Array.from(data));
      this.receivedLength += data.length;
    }
    const reply = buildDataAck(this.recordNumber);
    this.recordNumber++;
    return { reply };
  }

  /**
   * A message frame. **This is the completion channel** — the host's text ends the
   * transfer either way, and it is the only path on which `ft_complete` is called.
   * On a download the received bytes are handed over here, not on the `Close`.
   *
   * The frame is acknowledged as well as completing: `dft_data_ack()` runs at
   * `ft_dft.c:250`, before the text is inspected at `:267`.
   */
  private onMessage(data: Uint8Array): DftStep {
    const reply = buildDataAck(this.recordNumber);
    this.recordNumber++;

    let text = '';
    for (const b of data) text += String.fromCharCode(b);
    // A '$' terminates the message (ft_dft.c:258-265).
    const dollar = text.indexOf('$');
    if (dollar >= 0) text = text.slice(0, dollar);

    // A PREFIX test, matching `memcmp(msgp, END_TRANSFER, strlen(END_TRANSFER))`
    // at ft_dft.c:268 -- NOT an equality test. A real host sends "TRANS03" followed
    // by its own wording, so an equality test would report every successful
    // transfer as a failure whose error text is the success message.
    if (text.startsWith(END_TRANSFER)) {
      this.outcome = this.direction === 'receive'
        ? { ok: true, data: this.join() }
        : { ok: true };
    } else {
      this.outcome = { ok: false, error: text };
    }
    return { reply, done: this.outcome };
  }

  /**
   * A `Close` acknowledges and **does NOT end the transfer.**
   *
   * MEASURED FROM THE SOURCE, and it is the opposite of the obvious guess:
   * `ft_complete` is called from exactly three places, all inside the message
   * branch of `dft_data_insert` (`ft_dft.c:270`, `:273`, `:276`).
   * `dft_close_request` (`:672-688`) only writes a CloseAck. The real sequence is:
   *
   *     Open("FT:DATA") -> Data... -> Close -> Open("FT:MSG") -> Data(TRANS03)
   *
   * and it is that last message that completes the transfer. `message_flag` is one
   * flag reset by every `Open` (`:171-175`), which is what lets a single transfer
   * be a file and then a message.
   *
   * So this instance MUST survive its own Close. Ending here would report success
   * before the host said `TRANS03` — i.e. before the host has committed the file —
   * and would discard the host's error text on a failure, which is the one channel
   * that carries it.
   */
  private onClose(): DftStep {
    return { reply: buildCloseAck() };
  }

  private fail(error: string, failedRequest: number): DftStep {
    this.outcome = { ok: false, error };
    return { reply: buildDftError(failedRequest), done: this.outcome };
  }

  private join(): Uint8Array {
    const out = new Uint8Array(this.receivedLength);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}
