import {
  AID, MODEL_2, TERMINAL_TYPE, Tn3270eDataType, Tn3270eFunc, Tn3270eResponseFlag,
  Tn3270eSense,
} from './constants.js';
import { Screen } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Oia, KeyboardState } from './oia.js';
import { Trace, parseTrace } from './trace.js';
import { TelnetLayer } from './telnet.js';
import {
  initialState, negotiate, encodeHeader, decodeHeader, carriesDatastream,
  TN3270E_HEADER_BYTES, type Tn3270eState,
} from './tn3270e.js';
import { parseRecord, ParseError, describeRecord } from './stream/parse.js';
import { execute, ExecuteError } from './stream/execute.js';
import { buildReadModified, buildReadBuffer } from './inbound.js';
import { buildReply, DEFAULT_CAPABILITIES, type QueryRequest } from './queryreply.js';
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
  /** The DEFAULT (Erase/Write) screen size. Always 24x80 on a real model. */
  rows?: number;
  cols?: number;
  /**
   * The ALTERNATE (Erase/Write Alternate) size, from the model number. Defaults
   * to the default size, which is a model 2.
   */
  alternateRows?: number;
  alternateCols?: number;
  codePage?: CodePage;
  /** Telnet TERMINAL-TYPE to advertise. Defaults to IBM-3278-2. */
  terminalType?: string;
  /** Offer TN3270E. Defaults to true; `-tn3270e off` and the N: prefix clear it. */
  tn3270e?: boolean;
  /** LU names to request via CONNECT, tried in order as REJECTs come back. */
  lus?: readonly string[];
}

/**
 * Settings that belong to ONE connection rather than to the session.
 *
 * In s3270 these are properties of a HOST — they are written in the host argument
 * (`N:`, `LUname@`), and `Connect()` can name a different host every time. Passing
 * them to the constructor alone would make them properties of the process, so a CLI
 * script that connects to a plain host and then to a TN3270E one could only be right
 * about one of them. Each field falls back to the `SessionOptions` value.
 *
 * Lives on the connection, and so is discarded with it: see `handleClose`.
 */
export interface ConnectOptions {
  /** Offer TN3270E on this connection. The `N:` host prefix passes `false`. */
  tn3270e?: boolean;
  /** LU names to request on this connection, tried in order as REJECTs come back. */
  lus?: readonly string[];
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
  /** TN3270E negotiation state. Undefined until the host offers option 40. */
  private e: Tn3270eState | undefined;
  /** Outbound SEQ-NUMBER. Only advances when RESPONSES was agreed (§8.1.4). */
  private eSeq = 0;
  /** This connection's overrides. Empty between connections. See ConnectOptions. */
  private per: ConnectOptions = {};

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.screen = new Screen({
      rows: opts.rows ?? MODEL_2.rows,
      cols: opts.cols ?? MODEL_2.cols,
      ...(opts.alternateRows !== undefined ? { alternateRows: opts.alternateRows } : {}),
      ...(opts.alternateCols !== undefined ? { alternateCols: opts.alternateCols } : {}),
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

  async connect(host: string, port: number, per: ConnectOptions = {}): Promise<void> {
    // Tear down any live connection first. Without this the old Connection is
    // dropped without close(), and its onClose/onError closures still capture
    // `this` — so when the stale socket eventually closes it calls
    // handleClose() and tears down the NEW session.
    if (this.conn !== undefined) this.disconnect();

    // AFTER the teardown, which clears the previous connection's overrides — set it
    // before and disconnect() would wipe the ones just passed in.
    this.per = per;

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
      // Spread conditionally: with exactOptionalPropertyTypes an explicit
      // `terminalType: undefined` is a type error, and passing it would also
      // bypass the layer's own `?? TERMINAL_TYPE` default if that guard ever
      // became a truthiness check.
      ...(this.opts.terminalType ? { terminalType: this.opts.terminalType } : {}),
      tn3270eEnabled: this.per.tn3270e ?? this.opts.tn3270e ?? true,
      onTn3270eSubneg: (body) => { this.handleTn3270eSubneg(body, this.telnet); },
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
    // TN3270E state DIES WITH THE CONNECTION THAT NEGOTIATED IT. Until this line, `e`
    // was cleared only by the REJECT backoff below, so a second connection to a host
    // that never mentions option 40 inherited `phase: 'negotiated'` — and then
    // corrupted traffic in both directions: decodeHeader ate the first five bytes of
    // every inbound record, and sendRecord prepended a header the plain host parses as
    // 3270 data. The CLI reaches this with two `Connect()` actions in one script,
    // which is its ordinary mode of operation.
    //
    // Here rather than in connect(), because this is the ONE place a connection ends:
    // connect() tears down a live predecessor through disconnect(), so both routes
    // pass through here. `eSeq` too — it is only reset on a completed negotiation
    // (below), so a second session that never negotiates would keep counting from the
    // first one's total.
    this.e = undefined;
    this.eSeq = 0;
    // The connection's own overrides go with it, for the same reason: `N:` applied to
    // one host must not silently disable TN3270E for the next one.
    this.per = {};
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
    let body = record;
    /** The header of a TN3270E record, kept so the catch below can answer it. */
    let wants: ReturnType<typeof decodeHeader> = null;
    if (this.inTn3270e()) {
      const h = decodeHeader(record);
      if (h === null) {
        // Shorter than a header: malformed rather than truncated, so there is nothing
        // to salvage. Trace and drop, rather than handing the parser five bytes of
        // nothing and raising a program check the host never caused.
        this.trace.note(
          `TN3270E record shorter than a header, ${record.length} bytes, dropped`);
        return;
      }
      if (!carriesDatastream(h.dataType)) {
        // RESPONSE, UNBIND, BIND-IMAGE, NVT-DATA, SSCP-LU-DATA, PRINT-EOJ. None
        // carries a 3270 datastream, and feeding one to the executor would raise a
        // spurious program check. Traced rather than silently ignored: the trace is
        // how we would find out a real host sends these.
        this.trace.note(
          `TN3270E data type 0x${h.dataType.toString(16)} not implemented, dropped`);
        return;
      }
      body = record.subarray(TN3270E_HEADER_BYTES);
      wants = h;
    }
    this.records++;
    if (this.trace.isEnabled()) {
      this.trace.note(describeRecord(body));
    }
    try {
      const parsed = parseRecord(body);
      const result = execute(this.screen, parsed);

      // Release the enter-inhibit condition raised by an earlier Query.
      //
      // Placed before the two branches below for READABILITY, narrowest rule
      // first, and NOT because the order is load-bearing: it was checked by
      // moving this block after them, and all 45 session tests still passed.
      // The three rules turn out to commute, because the state EnterInhibit
      // can coexist with is only itself. Reaching the AwaitingFirstWrite
      // branch requires the state to BE AwaitingFirstWrite, and enterInhibit()
      // never overwrites that, so the two can never contend for the same
      // record. Do not read the sequence here as an invariant.
      //
      // releaseEnterInhibit, not reset(): it clears that one state and leaves
      // any other alone, mirroring x3270's single-bit `kybdlock_clr(
      // KL_ENTER_INHIBIT, "kybd_inhibit")` (Common/kybd.c:533). A reset() here
      // would let a routine host write clear a program check the host has not
      // acknowledged.
      //
      // Unconditional on the flag rather than guarded by "are we inhibited":
      // x3270 calls kybd_inhibit(false) on every Erase/EAU/Write regardless of
      // the current lock (ctlr.c:550, :1309, :1406), and releaseEnterInhibit is
      // itself a no-op unless EnterInhibit is the live state.
      if (result.releasesEnterInhibit) {
        this.oia.releaseEnterInhibit();
      }

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
      if (result.sfReply !== undefined) {
        this.answerQuery(result.sfReply);
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
      if (wants?.responseFlag === Tn3270eResponseFlag.ALWAYS_RESPONSE) {
        // Only ALWAYS-RESPONSE gets a positive answer. ERROR-RESPONSE means "tell me
        // only if it went wrong", so a success there is answered with silence.
        this.sendResponse(wants.seq, true, Tn3270eSense.DEVICE_END);
      }
    } catch (err) {
      // The response goes to the host and the program check to the operator: BOTH,
      // not either. A silent negative response would leave an operator looking at a
      // screen that never updated with no indication why.
      //
      // The sense code is mapped from the ERROR rather than from our program check
      // code, because RFC 2355's two reachable senses are finer-grained than our two
      // codes: 0x00 is "an invalid 3270 command was received" and 0x02 is "an illegal
      // 3270 buffer address or order sequence". A ParseError is the former, an
      // AddressError the latter -- even though both report program check 754.
      // DO NOT collapse the program check codes to match: they are pinned by goldens
      // and by the live VM/370 measurement.
      const answerable = wants !== null
        && wants.responseFlag !== Tn3270eResponseFlag.NO_RESPONSE;
      if (err instanceof ParseError || err instanceof AddressError) {
        this.programCheck(PROG_INVALID_COMMAND, err.message);
        if (answerable) {
          this.sendResponse(wants!.seq, false, err instanceof ParseError
            ? Tn3270eSense.COMMAND_REJECT
            : Tn3270eSense.OP_CHECK);
        }
      } else if (err instanceof ExecuteError) {
        this.programCheck(PROG_INVALID_ADDRESS, err.message);
        if (answerable) this.sendResponse(wants!.seq, false, Tn3270eSense.OP_CHECK);
      } else {
        // Our own bug: never swallowed.
        throw err;
      }
    }
  }

  /**
   * Advance TN3270E negotiation by one subnegotiation body.
   *
   * All the protocol logic is in tn3270e.ts; this only moves bytes and applies
   * effects, which is what lets the state machine be tested without a socket.
   *
   * The layer is passed in rather than read from `this.telnet`, because replay()
   * builds a local one and leaves the field undefined.
   */
  private handleTn3270eSubneg(body: Uint8Array, layer: TelnetLayer | undefined): void {
    this.e ??= initialState({
      terminalType: this.opts.terminalType ?? TERMINAL_TYPE,
      lus: this.per.lus ?? this.opts.lus ?? [],
    });
    const r = negotiate(this.e, body);
    this.e = r.next;
    if (r.reply) layer?.sendTn3270eSubneg(r.reply);
    if (r.effect?.kind === 'complete') {
      this.eSeq = 0;
      layer?.setTn3270eNegotiated(true);
      this.trace.note(
        `TN3270E negotiated, device ${this.e.deviceType ?? '?'}`
        + `${this.e.lu === undefined ? '' : ` LU ${this.e.lu}`}`
        + `, functions: ${r.effect.agreed.join(',') || '(none: basic TN3270E)'}`);
    } else if (r.effect?.kind === 'backoff') {
      // Tell the host no and forget the option, so the classic BINARY/EOR route is
      // still reachable on this same connection. x3270's backoff_tn3270e().
      this.trace.note(`TN3270E abandoned: ${r.effect.why}`);
      this.e = undefined;
      layer?.refuseTn3270e();
    }
  }

  /** True once TN3270E negotiation completed, i.e. records carry a header. */
  private inTn3270e(): boolean {
    return this.e?.phase === 'negotiated';
  }

  /**
   * Send a TN3270E RESPONSE message (RFC 2355 §10.4.1).
   *
   * `seq` is COPIED from the message being answered rather than generated, and this
   * deliberately does not go through sendInbound(): a response must not consume one
   * of our outbound sequence numbers, or our numbering drifts out of step with what
   * the host is acknowledging.
   *
   * A no-op when RESPONSES was not agreed. A server asking for a response on such a
   * session is out of spec, and answering would put a message on the wire it has no
   * parser for.
   */
  private sendResponse(seq: number, positive: boolean, sense: number): void {
    if (!this.e?.agreed.includes(Tn3270eFunc.RESPONSES)) return;
    const header = encodeHeader({
      dataType: Tn3270eDataType.RESPONSE,
      requestFlag: 0,
      responseFlag: positive
        ? Tn3270eResponseFlag.POSITIVE_RESPONSE
        : Tn3270eResponseFlag.NEGATIVE_RESPONSE,
      seq,
    });
    const msg = new Uint8Array(header.length + 1);
    msg.set(header, 0);
    msg[header.length] = sense;
    this.telnet?.sendRecord(msg);
  }

  /**
   * Send one inbound record, adding the TN3270E header when the session has one.
   *
   * THE HEADER IS PREPENDED AND THE WHOLE THING HANDED TO sendRecord, so it flows
   * through the existing doubleIac(). RFC 2355 §8.1.4 requires a 0xff inside
   * SEQ-NUMBER to be doubled, and doing it this way satisfies that by construction
   * rather than with a second escaping implementation that could drift out of step
   * with the first. Writing the header separately would put a bare 0xff on the wire
   * once the counter passes 255 and desynchronise the host's telnet parser
   * mid-record, which presents as a hang rather than an error.
   */
  private sendInbound(payload: Uint8Array): void {
    if (!this.inTn3270e()) {
      this.telnet?.sendRecord(payload);
      return;
    }
    const header = encodeHeader({
      dataType: Tn3270eDataType.DATA_3270,
      requestFlag: 0,
      responseFlag: Tn3270eResponseFlag.NO_RESPONSE,
      seq: this.eSeq,
    });
    const framed = new Uint8Array(header.length + payload.length);
    framed.set(header, 0);
    framed.set(payload, header.length);
    // Advance only when RESPONSES was agreed. §8.1.4: otherwise the field "should
    // always be set to 0x0000". x3270 gates the increment the same way
    // (telnet.c:3350), and masks to 15 bits.
    if (this.e?.agreed.includes(Tn3270eFunc.RESPONSES)) {
      this.eSeq = (this.eSeq + 1) & 0x7fff;
    }
    this.telnet?.sendRecord(framed);
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
    this.sendInbound(payload);
  }

  /**
   * Answer a Read Partition (Query or Query List) with our capabilities, then
   * lock the keyboard.
   *
   * Deliberately does NOT touch the screen or the cursor: a Query is a question
   * about the device, not a write to it. That holds for a Query List too —
   * p. 5-53's step list (pages.txt:6413-6427) treats the two identically apart
   * from which replies go inbound, and nowhere among its seven steps is a buffer
   * change.
   *
   * It DOES touch the keyboard, which is step 1 of Read Partition processing,
   * GA23-0059 p. 5-53 (pages.txt:6413): "1. The enter-inhibit condition is
   * raised." The host has frozen the screen pending its own next write, and
   * until that arrives the operator must not type into it. x3270 raises it in
   * query_reply_end (Common/sf.c:926-930), which is the whole function:
   *
   *     net_output();
   *     kybd_inhibit(true);
   *
   * REPLY FIRST, THEN INHIBIT, matching that ordering exactly. The manual's own
   * step list is the other way round — the inhibit is step 1 and step 5 says
   * that for a Query "a / set of Query Replies is transmitted inbound"
   * (pages.txt:6420-6421, the slash marking the OCR line break) — but
   * the two are indistinguishable from outside, because sendRecord neither
   * consults the keyboard state nor yields, and x3270's concrete ordering is
   * the better guide for anyone diffing the two clients. What would be a real
   * bug is the reverse of what we do: raising it first through a path that
   * checked the lock before transmitting would swallow our own reply.
   *
   * `this.telnet?.` and not a throw, matching answerRead: both are reached only
   * from handleRecord, which the telnet layer itself calls, so a missing telnet
   * means the transport went away mid-record and there is nowhere to send. The
   * throwing convention belongs to the operator-initiated senders (sendAID,
   * sendAttn), where a caller is present to be told.
   *
   * Note the inhibit is raised even on that transport-gone path. That is
   * correct: the host asked and the screen is frozen whether or not our answer
   * reached it, and a session whose socket has just vanished is not one to
   * unlock a keyboard over.
   */
  private answerQuery(request: QueryRequest): void {
    // The DEFAULT size and the ALTERNATE size, NOT the current one. A host that
    // asks while we happen to be in alternate mode must still be told what the
    // default is, and `screen.rows` is whichever mode we are in right now --
    // reading it here would make the reply depend on the moment it was asked.
    const geometry = {
      rows: this.screen.defaultSize.rows,
      cols: this.screen.defaultSize.cols,
      alternate: this.screen.alternateSize,
    };
    // buildReply, not buildQueryReply: it applies the REQTYP rules and the
    // always-send-Summary rule in one place.
    //
    // It CAN throw a RangeError, on a reserved REQTYP (B'11'), and handleRecord
    // does not catch that — it rethrows non-protocol errors as "our own bug",
    // which drops the connection. A host must not be able to trigger that, so
    // the reserved value is screened out in stream/sf.ts queryListRequest before
    // it ever becomes an sfReply. The throw is an unreachable assertion, and
    // there are tests at both levels pinning that.
    this.sendInbound(buildReply(request, DEFAULT_CAPABILITIES, geometry));
    // enterInhibit, not inhibit(EnterInhibit): it yields to a stronger inhibit
    // already in force. Before the host's first write that is
    // AwaitingFirstWrite — the case TSO produces, since it queries before
    // writing — and demoting it there would narrow the release rule from "any
    // write, or a WCC keyboard-restore" to "any write". See Oia.enterInhibit.
    this.oia.enterInhibit();
  }

  /** Operator pressed a key that generates an AID. */
  sendAID(aid: number): void {
    if (this.telnet === undefined) throw new Error('not connected');

    const payload = buildReadModified(this.screen, aid, false);
    this.sendInbound(payload);

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
  /**
   * The SYSREQ key.
   *
   * A no-op unless the function was agreed, and deliberately silent rather than an
   * error: the key exists on the keyboard whatever the host granted, so pressing it
   * on a session without the function is not the operator's mistake. Sending IAC AO
   * anyway would put a command on the wire the host has no handler for.
   *
   * Not a data message, so it spends no sequence number.
   */
  sysreq(): void {
    if (!this.e?.agreed.includes(Tn3270eFunc.SYSREQ)) {
      this.trace.note('SYSREQ ignored: function not negotiated');
      return;
    }
    this.telnet?.sendSysreq();
  }

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
    const telnet: TelnetLayer = new TelnetLayer({
      write: () => { /* discard: replay is one-directional */ },
      onRecord: (r) => this.handleRecord(r),
      tn3270eEnabled: this.opts.tn3270e ?? true,
      // Wired even though writes are discarded: replaying a TN3270E trace still has
      // to advance the state machine, or handleRecord never learns to strip the
      // 5-byte header and every replayed record is parsed one command byte early.
      // `telnet` rather than `this.telnet`, which replay leaves undefined.
      onTn3270eSubneg: (body) => { this.handleTn3270eSubneg(body, telnet); },
    });
    for (const ev of events) {
      if (ev.dir === 'recv') telnet.receive(ev.bytes);
    }
    this.emit('screen');
  }
}
