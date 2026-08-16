import { AID, MODEL_2 } from './constants.js';
import { Screen } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Oia, KeyboardState } from './oia.js';
import { Trace, parseTrace } from './trace.js';
import { TelnetLayer } from './telnet.js';
import { parseRecord, ParseError, describeRecord } from './stream/parse.js';
import { execute, ExecuteError } from './stream/execute.js';
import { buildReadModified, buildReadBuffer } from './inbound.js';
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
    const conn = await this.opts.connect(host, port);
    this.conn = conn;
    this.error = undefined;
    this.oia.connected = true;

    this.telnet = new TelnetLayer({
      write: (b) => conn.write(b),
      onRecord: (r) => this.handleRecord(r),
      trace: this.trace,
    });

    conn.onData = (bytes) => {
      this.telnet?.receive(bytes);
      this.oia.tn3270Mode = this.is3270Mode();
    };
    conn.onClose = () => this.handleClose();
    conn.onError = (err) => {
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
  private handleRecord(record: Uint8Array): void {
    if (this.trace.isEnabled()) {
      this.trace.note(describeRecord(record));
    }
    try {
      const parsed = parseRecord(record);
      const result = execute(this.screen, parsed);

      if (result.keyboardRestore) {
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
