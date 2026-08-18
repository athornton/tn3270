import { AID, MODEL_2 } from './constants.js';
import { Screen } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Oia, KeyboardState } from './oia.js';
import { Trace, parseTrace } from './trace.js';
import { TelnetLayer } from './telnet.js';
import { parseRecord, ParseError, describeRecord } from './stream/parse.js';
import { execute, ExecuteError } from './stream/execute.js';
import { buildReadModified, buildReadBuffer } from './inbound.js';
import { buildQueryReply, DEFAULT_CAPABILITIES } from './queryreply.js';
import { AddressError } from './address.js';
import { cp037, type CodePage } from './codepage.js';

/**
 * A single TN3270 session: socket, telnet layer, screen, keyboard.
 *
 * No module-level state anywhere in this file — construct as many as you like.
 * That is what makes multi-session tabs a UI change rather than a core rewrite.
 */

/** The transport, injected so tests and Replay() need no real socket. */
export interface Connection {
  write(bytes: Uint8Array): void;
  close(): void;
  onData: ((bytes: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((err: Error) => void) | undefined;
}

export interface SessionOptions {
  connect: (host: string, port: number) => Connection | Promise<Connection>;
  rows?: number;
  cols?: number;
  codePage?: CodePage;
}

export type SessionEvent = 'screen' | 'connect' | 'disconnect' | 'alarm';

/** Program check codes. x3270 shows a number after "X PROG". */
const PROG_INVALID_COMMAND = 754;
const PROG_INVALID_ADDRESS = 755;

export class Session {
  readonly screen: Screen;
  readonly keyboard: Keyboard;
  readonly oia = new Oia();
  readonly trace = new Trace();

  private readonly opts: SessionOptions;
  private conn: Connection | undefined;
  private telnet: TelnetLayer | undefined;
  private error: string | undefined;
  private readonly listeners = new Map<SessionEvent, Set<() => void>>();
  /**
   * Host records applied since connect. Monotonic; never reset.
   *
   * Exposed so a caller can wait for the stream to QUIESCE rather than for a
   * particular screen predicate. tnz uses exactly this technique — it polls the
   * session's byte count and proceeds once it stops changing, with a WAITSLEEP
   * interval (ati.py:1965-1976) — and it is the robust answer when a host sends
   * one logical screen as several records, which VM/370 does.
   */
  private records = 0;

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.screen = new Screen({
      rows: opts.rows ?? MODEL_2.rows,
      cols: opts.cols ?? MODEL_2.cols,
      ...(opts.codePage ? { codePage: opts.codePage } : {}),
    });
    this.keyboard = new Keyboard(this.screen, this.oia, opts.codePage ?? cp037);
  }

  on(event: SessionEvent, fn: () => void): void {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(fn);
  }

  private emit(event: SessionEvent): void {
    for (const fn of this.listeners.get(event) ?? []) fn();
  }

  isConnected(): boolean {
    return this.conn !== undefined;
  }

  is3270Mode(): boolean {
    return this.telnet?.is3270Mode() ?? false;
  }

  lastError(): string | undefined {
    return this.error;
  }

  async connect(host: string, port: number): Promise<void> {
    // Tear down any live connection first. Without this the old Connection is
    // dropped without close(), and its onClose/onError closures still capture
    // `this` — so when the stale socket eventually closes it calls
    // handleClose() and tears down the NEW session.
    if (this.conn !== undefined) this.disconnect();

    const conn = await this.opts.connect(host, port);
    this.conn = conn;
    this.error = undefined;
    this.oia.connected = true;
    // The keyboard is locked until the host writes something: there is no screen
    // to type into yet. x3270 sets KL_AWAITING_FIRST here for the same reason
    // (kybd.c:580-585). This is what makes Wait(Unlock) meaningful immediately
    // after Connect — without it the wait returns at once and a script types
    // into a blank buffer.
    this.oia.waitingForHost = true;
    this.oia.inhibit(KeyboardState.AwaitingFirstWrite);

    this.telnet = new TelnetLayer({
      write: (b) => conn.write(b),
      onRecord: (r) => this.handleRecord(r),
      trace: this.trace,
    });

    // Each callback checks identity against the `conn` it closes over, not just
    // `this.conn !== undefined`. Real transports fire data/close/error
    // asynchronously (not necessarily inside our call to close()), so a stale
    // connection's event can still arrive after connect() has already swapped
    // in a new one. Without the identity check, stale data would be fed into
    // the NEW telnet layer, and a stale close/error would tear down the live
    // connection via handleClose().
    conn.onData = (bytes) => {
      if (this.conn !== conn) return;
      this.telnet?.receive(bytes);
      this.oia.tn3270Mode = this.is3270Mode();
    };
    conn.onClose = () => { if (this.conn === conn) this.handleClose(); };
    conn.onError = (err) => {
      if (this.conn !== conn) return;
      this.error = err.message;
      this.trace.note(`transport error: ${err.message}`);
      this.handleClose();
    };

    this.emit('connect');
  }

  disconnect(): void {
    this.conn?.close();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.conn === undefined) return;
    this.conn = undefined;
    this.telnet = undefined;
    this.oia.connected = false;
    this.oia.tn3270Mode = false;
    this.oia.waitingForHost = false;
    this.emit('disconnect');
  }

  /**
   * Apply one host record.
   *
   * Protocol violations become a program check and the session stays up; that
   * is what real hardware does, and a client that dies on a malformed record is
   * useless against real hosts.
   */
  /** Count of host records applied. Monotonic. */
  recordCount(): number {
    return this.records;
  }

  private handleRecord(record: Uint8Array): void {
    this.records++;
    if (this.trace.isEnabled()) {
      this.trace.note(describeRecord(record));
    }
    try {
      const parsed = parseRecord(record);
      const result = execute(this.screen, parsed);

      if (result.keyboardRestore) {
        this.oia.waitingForHost = false;
        this.oia.reset();
      } else if (this.oia.keyboard === KeyboardState.AwaitingFirstWrite
        && parsed.command !== 'WriteStructuredField') {
        // "Wait for any output OR a WCC(restore)" (x3270 kybd.c:583): the
        // initial post-connect lock is released by the host writing anything at
        // all, not only by an explicit keyboard-restore. VM/370's logo arrives
        // with WCC 0x42 (restore set) but a host that omits the bit must not
        // leave us locked out forever.
        //
        // ...and a Write Structured Field is NOT such a write: it puts nothing
        // in the buffer. TSO sends its Read Partition (Query) BEFORE any write,
        // so without this exclusion the operator gets an unlocked keyboard over
        // a blank screen.
        this.oia.waitingForHost = false;
        this.oia.reset();
      }
      if (result.alarm) {
        this.oia.alarm = true;
        this.emit('alarm');
      }
      if (result.readRequest !== undefined) {
        this.answerRead(result.readRequest);
      }
      if (result.sfReply === 'queryReply') {
        this.answerQuery();
      }
      // The only thing that OBSERVES the SA/MF counters. execute() bumps them
      // per record and nothing sums them, so without a line here a live run
      // could not tell "we saw no SA/MF" from "nobody looked" — the precise
      // failure those counters exist to rule out. Named in the message so a
      // trace grep finds them.
      //
      // isEnabled() first, matching describeRecord above: this runs on every
      // record, and trace.note's own guard would still have us build the string.
      if (this.trace.isEnabled()
        && (result.setAttributeIgnored > 0 || result.modifyFieldIgnored > 0)) {
        this.trace.note(
          `ignored orders: SA=${result.setAttributeIgnored} MF=${result.modifyFieldIgnored}`);
      }
      this.emit('screen');
    } catch (err) {
      if (err instanceof ParseError || err instanceof AddressError) {
        this.programCheck(PROG_INVALID_COMMAND, err.message);
      } else if (err instanceof ExecuteError) {
        this.programCheck(PROG_INVALID_ADDRESS, err.message);
      } else {
        // Our own bug: never swallowed.
        throw err;
      }
    }
  }

  private programCheck(code: number, why: string): void {
    this.oia.programCheck(code);
    this.oia.waitingForHost = false;
    this.trace.note(`program check ${code}: ${why}`);
    this.emit('screen');
  }

  /** A host-initiated read, which carries no operator AID. */
  private answerRead(kind: 'ReadBuffer' | 'ReadModified' | 'ReadModifiedAll'): void {
    const payload = kind === 'ReadBuffer'
      ? buildReadBuffer(this.screen, AID.NONE)
      : buildReadModified(this.screen, AID.NONE, kind === 'ReadModifiedAll');
    this.telnet?.sendRecord(payload);
  }

  /**
   * Answer a Read Partition (Query) with our capabilities.
   *
   * Deliberately does NOT touch the screen, the cursor or the keyboard: a Query
   * is a question about the device, not a write to it. In particular the
   * keyboard stays locked, because AwaitingFirstWrite is released by host
   * WRITES and the host has not written anything yet.
   *
   * `this.telnet?.` and not a throw, matching answerRead: both are reached only
   * from handleRecord, which the telnet layer itself calls, so a missing telnet
   * means the transport went away mid-record and there is nowhere to send. The
   * throwing convention belongs to the operator-initiated senders (sendAID,
   * sendAttn), where a caller is present to be told.
   */
  private answerQuery(): void {
    const geometry = { rows: this.screen.rows, cols: this.screen.cols };
    this.telnet?.sendRecord(buildQueryReply(DEFAULT_CAPABILITIES, geometry));
  }

  /** Operator pressed a key that generates an AID. */
  sendAID(aid: number): void {
    if (this.telnet === undefined) throw new Error('not connected');

    const payload = buildReadModified(this.screen, aid, false);
    this.telnet.sendRecord(payload);

    // The Clear key blanks the buffer locally as well as telling the host.
    if (aid === AID.CLEAR) {
      this.screen.clear();
      this.emit('screen');
    }

    // Any AID locks the keyboard until the host restores it. A short read is no
    // exception: the host still owns the next move, and buildReadModified
    // already decides what a short read puts on the wire.
    this.oia.waitingForHost = true;
    this.oia.inhibit(KeyboardState.SystemWait);
  }

  /** Attn is Telnet BREAK (RFC 1576 §8), not an AID. */
  sendAttn(): void {
    if (this.telnet === undefined) throw new Error('not connected');
    this.telnet.sendAttn();
  }

  /**
   * Drive the screen from a recorded trace, with no socket. Only host-to-
   * terminal bytes are replayed; what we sent last time is not re-sent.
   */
  replay(traceText: string): void {
    if (this.conn !== undefined) {
      // Refuse rather than transmit. A recorded trace contains the host's
      // negotiation AND its read commands; replaying it on a live session makes
      // handleRecord answer those reads through this.telnet, i.e. down the real
      // socket. Verified: a trace ending in a Read Buffer sent 60 40 40 ... to
      // the live host.
      throw new Error('replay() requires a disconnected session; disconnect first');
    }
    const events = parseTrace(traceText);
    const telnet = new TelnetLayer({
      write: () => { /* discard: replay is one-directional */ },
      onRecord: (r) => this.handleRecord(r),
    });
    for (const ev of events) {
      if (ev.dir === 'recv') telnet.receive(ev.bytes);
    }
    this.emit('screen');
  }
}
