import {
  AID, MODEL_2, TERMINAL_TYPE, Tn3270eDataType, Tn3270eFunc, Tn3270eResponseFlag,
  Tn3270eSense, VALID_AIDS,
} from './constants.js';
import { Screen } from './screen.js';
import { Keyboard } from './keyboard.js';
import { Oia, KeyboardState } from './oia.js';
import { Trace, parseTrace } from './trace.js';
import { TelnetLayer } from './telnet.js';
import {
  initialState, negotiate, encodeHeader, decodeHeader, carriesDatastream,
  TN3270E_HEADER_BYTES, type Tn3270eState, type Tn3270eHeader,
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
  /** Telnet TERMINAL-TYPE to advertise. Defaults to IBM-3278-2-E. */
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
  /**
   * True once a BIND has been received on a session that granted BIND-IMAGE.
   *
   * Mirrors x3270's `tn3270e_bound` (Common/telnet.c:182), which the gate below reads
   * at telnet.c:2681-2682 and BIND/UNBIND set and clear at :2742 and :2752. Meaningless
   * -- and never consulted -- on a session that never granted the function: see
   * `bindImageGranted()`.
   *
   * Cleared in `forgetTn3270e()`, alongside `pendingBindRecord`: see that method's
   * comment for why a negotiation ending is the one place both belong, and for the
   * enumeration of every path that reaches it.
   */
  private bound = false;
  /**
   * The most recent 3270-DATA record withheld by the BIND gate (`handleRecord`).
   *
   * ONLY THE MOST RECENT, DELIBERATELY NOT A QUEUE: a host that painted twice before
   * binding has overwritten its own first screen, so keeping the first would show the
   * operator a screen the host itself has abandoned, and an unbounded queue is a
   * memory hole a remote party controls -- it decides how many records precede its
   * own BIND. `wants` is the decoded header, kept alongside the header-stripped body
   * because they are exactly `executeRecord`'s two parameters: the timeout path
   * (Task 9) calls `executeRecord(pendingBindRecord.body, pendingBindRecord.wants)`,
   * so a host that asked for ALWAYS-RESPONSE on the withheld record still gets one.
   *
   * Cleared in `forgetTn3270e()`; see `bound`'s comment.
   */
  private pendingBindRecord: { wants: Tn3270eHeader; body: Uint8Array } | undefined;
  /**
   * The Task 9 timer that gives up waiting for a BIND and executes
   * `pendingBindRecord` anyway. Armed by `armNoBindTimer()` when the gate first
   * withholds a record; a stub here because arming and firing the timer are that
   * task's, not this one's -- see NO_BIND_TIMEOUT_MS in bind.ts.
   */
  private noBindTimer: ReturnType<typeof setTimeout> | undefined;
  /** This connection's overrides. Empty between connections. See ConnectOptions. */
  private per: ConnectOptions = {};
  /**
   * The last target `connect()` was ASKED for, kept so `reconnect()` can replay it.
   *
   * ## IT SURVIVES `handleClose()`, AND THAT IS NOT A VIOLATION OF ITS RULE
   *
   * `handleClose` discards everything that belongs to the connection — the telnet layer, the
   * TN3270E state, `per` — because a second connection must not inherit the first one's
   * negotiation. This field is the one thing here that is NOT a property of the connection: it
   * is a property of the session's CONFIGURATION, the answer to "which host is this session
   * for", and it is read only when there is no connection at all. Clearing it on close would
   * make `reconnect()` unreachable by construction, since the only time anyone wants to
   * reconnect is after a close.
   *
   * `per` is copied in rather than aliased, and stored HERE as well as in `this.per`, precisely
   * because the two have different lifetimes: `this.per` dies with the connection (see
   * `ConnectOptions`), while the remembered copy is part of the target. `N:` and `LU@` are
   * written in the HOST argument, so "the host we were told to talk to" includes them —
   * replaying the host and port without them would silently reconnect with TN3270E back on to a
   * host the operator spelled `N:`.
   *
   * NOT the resolved socket, and NOT a TLS decision: see `reconnect()` for why that matters.
   */
  private target: { host: string; port: number; per: ConnectOptions } | undefined;
  /**
   * A `reconnect()` between its call and its socket. See that method: this is the half of
   * x3270's `PCONNECTED` that `isConnected()` does not cover, and it is what stops two quick
   * presses of the reconnect key opening two sockets.
   */
  private reconnecting = false;

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

  /**
   * Stop calling `fn` for `event`. A no-op if it was never registered.
   *
   * ## WHY THIS EXISTS: A SESSION CAN OUTLIVE ITS LISTENER
   *
   * For three of the four front ends it does not — a TUI or a GUI registers once and lives as long
   * as the process. The web gateway is different BY DESIGN: its sessions outlive their sockets so an
   * operator can reload, or survive a wifi handoff, and reattach to the running 3270 session. Each
   * attach registers three listeners, and with no way to remove them a session reattached ten times
   * carried thirty. Every later screen change then ran `drawList` and `deflateSync` thirty times,
   * twenty-nine of them for dead connections that discard the result — unbounded in the number of
   * reconnections, and invisible because the output was correct throughout.
   *
   * A no-op rather than a throw for an unknown function, because the gateway calls this on every
   * socket close, including sockets that never reached `hello` and so registered nothing. Throwing
   * there would turn an ordinary disconnect into an error on a path with nobody to tell.
   */
  off(event: SessionEvent, fn: () => void): void {
    this.listeners.get(event)?.delete(fn);
  }

  /**
   * How many listeners `event` has. Exists so a leak is OBSERVABLE to a test: without it the only
   * symptom of the bug above is wasted CPU, which no assertion can see.
   */
  listenerCount(event: SessionEvent): number {
    return this.listeners.get(event)?.size ?? 0;
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

    // REMEMBERED BEFORE THE AWAIT, so a target that never came up is still a target: a refused
    // socket or a TLS handshake that failed is exactly the case an operator wants to retry, and
    // recording it only on success would leave the reconnect key dead after the one failure
    // that makes it useful. Copied, not aliased: a caller that reuses and mutates its options
    // object must not silently change where this session reconnects to.
    //
    // The OIA carries the same fact so the STATUS LINE can offer the key, and it is set here for
    // the same reason: see `Oia.reconnectable`.
    this.target = { host, port, per: { ...per } };
    this.oia.reconnectable = true;

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
      onTn3270eDisabled: () => { this.tn3270eDisabled(); },
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

  /**
   * Connect again to the host this session was last asked for.
   *
   * ## WHY IT REUSES `this.opts.connect` AND TAKES NO ARGUMENTS — THE TLS TRAP
   *
   * `SessionOptions.connect` is INJECTED, and the injected function is where the TLS decision
   * lives: `frontend`'s `defaultSession` closes over a `TlsOptions` (`tcpConnect(h, p, tls)`),
   * chosen once from the command line. Replaying the remembered host and port THROUGH THAT SAME
   * FUNCTION therefore reuses the original decision by construction, and there is nothing here
   * that could re-derive it.
   *
   * That is not a stylistic preference. A PLAINTEXT HOST DOES NOT REJECT A TLS HANDSHAKE, IT
   * HANGS: Hercules writes `IAC DO TERMINAL-TYPE` and waits, and OpenSSL reads that leading 0xff
   * as a record content type and blocks for a length that never arrives. TLS is ON by default in
   * this client and the Hercules hosts are reached with `-insecure`, so anything that re-parsed
   * the front end's arguments — or built a fresh socket factory — would turn a keypress into a
   * hung client against the two hosts this project actually tests against. No parameters is also
   * what keeps the WEB gateway safe: a browser pressing Enter cannot name a host or a scheme,
   * because there is no argument for it to name one in.
   *
   * ## THE TWO REFUSALS, BOTH x3270's
   *
   * `Reconnect_action` (`Common/host.c`, verified against the current source) is exactly these
   * two checks and nothing else:
   *
   *     if (PCONNECTED) { popup_an_error(AnReconnect "(): Already connected"); return false; }
   *     if (current_host == NULL) {
   *         popup_an_error(AnReconnect "(): No previous host to connect to"); return false; }
   *     host_reconnect();
   *
   * So both are refusals rather than no-ops, and the wording is x3270's own — including the
   * capitalised `Reconnect()` prefix, which is the s3270 ACTION name: `cli/src/runner.ts` passes
   * these messages straight through to a script, exactly as it copies `check_argc`'s wording for
   * `Connect()`, so a script written for s3270 reads the same text from us.
   *
   * `PCONNECTED` in x3270 is "connected OR half-connected", which is why the first check also
   * covers a reconnect ALREADY IN FLIGHT and not just `this.conn`. Our `isConnected()` sees only
   * the completed case, and this method is reachable from a KEY: two quick presses would
   * otherwise start two connects, both of which passed `connect()`'s teardown check while
   * `this.conn` was still undefined, so the first socket would be replaced without being closed
   * and left open on the mainframe forever — an LU leaked per impatient keypress.
   *
   * ## `async`, BECAUSE `connect` IS
   *
   * It resolves when the connection is up, so the CLI's `Reconnect()` can report failure the way
   * `Connect()` does. INTERACTIVE CALLERS MUST STILL CONTAIN THE REJECTION: `applyAction` is
   * synchronous and an unhandled rejection ends the process on modern Node — in the web gateway
   * that would take every other operator's session with it. See `applyAction`.
   *
   * The failure is recorded in `lastError()` and in the trace before it is rethrown, so a front
   * end that can only swallow it still leaves the reason somewhere findable.
   */
  async reconnect(): Promise<void> {
    if (this.conn !== undefined || this.reconnecting) {
      throw new Error('Reconnect(): Already connected');
    }
    const target = this.target;
    if (target === undefined) throw new Error('Reconnect(): No previous host to connect to');
    this.reconnecting = true;
    try {
      // The remembered ConnectOptions are copied out again, so the session's memory of its target
      // cannot be reached through the object handed to `connect()`.
      await this.connect(target.host, target.port, { ...target.per });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.error = why;
      this.trace.note(`reconnect to ${target.host}:${target.port} failed: ${why}`);
      throw err;
    } finally {
      this.reconnecting = false;
    }
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
    // first one's total. Both live in `forgetTn3270e()`, because a connection ending is
    // not the only way a negotiation ends: see that method.
    this.forgetTn3270e();
    // The connection's own overrides go with it, for the same reason: `N:` applied to
    // one host must not silently disable TN3270E for the next one.
    this.per = {};
    // `this.target` AND `this.oia.reconnectable` ARE DELIBERATELY NOT CLEARED HERE, and this is
    // the one exception to the rule above. They record which host this SESSION is for, not
    // anything the closing connection negotiated, and `reconnect()` runs only after this method
    // has already run — clearing them would make the feature unreachable rather than clean. See
    // the field's own comment.
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
      // BIND and UNBIND are dispatched BEFORE the carriesDatastream/gate checks below,
      // because neither carries a 3270 datastream and the gate condition below tests
      // `!this.bound` -- reaching it before `handleBind` has had a chance to flip that
      // flag would make a session's OWN BIND look like more pre-BIND data.
      //
      // BOTH ARE GATED ON `bindImageGranted()`, NOT DISPATCHED UNCONDITIONALLY ON THE
      // DATA TYPE. This departs from the plan's sketch, which dispatched on data type
      // alone -- but x3270 does not: `case TN3270E_DT_BIND_IMAGE` and `case
      // TN3270E_DT_UNBIND` each open with `if (!b8_bit_is_set(&e_funcs,
      // TN3270E_FUNC_BIND_IMAGE)) return 0;` (Common/telnet.c:2709 and :2746) before
      // doing anything else. A record carrying data type BIND-IMAGE on a session that
      // never negotiated the FUNCTION is not a BIND we are owed; it falls through to
      // the same "not implemented, dropped" trace as any other type we do not handle,
      // exactly as it did before this task and exactly as x3270's silent `return 0`
      // does. Confirmed against session.test.ts's own regression: `negotiateE()`
      // grants RESPONSES and SYSREQ only, so its BIND-IMAGE-data-type test is (and
      // must stay) a "not implemented" trace, not a bind.
      if (this.bindImageGranted() && h.dataType === Tn3270eDataType.BIND_IMAGE) {
        this.handleBind(record.subarray(TN3270E_HEADER_BYTES));
        return;
      }
      if (this.bindImageGranted() && h.dataType === Tn3270eDataType.UNBIND) {
        this.handleUnbind(record.subarray(TN3270E_HEADER_BYTES));
        return;
      }
      if (!carriesDatastream(h.dataType)) {
        // RESPONSE, NVT-DATA, SSCP-LU-DATA, PRINT-EOJ. None of these carries a 3270
        // datastream, and feeding one to the executor would raise a spurious program
        // check. Traced rather than silently ignored: the trace is how we would find
        // out a real host sends these.
        this.trace.note(
          `TN3270E data type 0x${h.dataType.toString(16)} not implemented, dropped`);
        return;
      }
      if (this.bindImageGranted() && !this.bound) {
        // THE GATE (x3270's telnet.c:2681-2682), with the hang removed. x3270 returns
        // here and the record is gone; we keep the most recent one so the Task 9
        // timeout can run it through this same `executeRecord`. Only the most recent:
        // a host that painted twice before binding has overwritten its own first
        // screen, and a queue would be a memory hole a remote party controls. See
        // `pendingBindRecord`'s own comment.
        this.pendingBindRecord = { wants: h, body: record.subarray(TN3270E_HEADER_BYTES) };
        this.armNoBindTimer();
        this.trace.note('3270 data before BIND, retained');
        return;
      }
      body = record.subarray(TN3270E_HEADER_BYTES);
      wants = h;
    }
    this.executeRecord(body, wants);
  }

  /**
   * Parse and apply one 3270 datastream, once `handleRecord` has decided it is safe
   * to run: past the BIND gate, with any TN3270E header already stripped.
   *
   * PULLED OUT OF `handleRecord` SO THE RETAINED PATH AND THE LIVE PATH CANNOT DRIFT.
   * `handleBind` (Task 9's timeout does the same) calls this directly on a record
   * `pendingBindRecord` held back, with the exact `wants` that record arrived with --
   * so a host that asked for ALWAYS-RESPONSE on the withheld record still gets one,
   * and every side effect below (OIA, alarm, Query reply, program check) runs exactly
   * as it would have if the BIND had arrived first. Two copies of this logic, one for
   * "arrived before BIND" and one for "arrived after", is exactly the kind of drift
   * this project has already paid for once with `e` (see `forgetTn3270e`).
   */
  private executeRecord(body: Uint8Array, wants: Tn3270eHeader | null): void {
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
      //
      // The reason is traced BEFORE the state goes, and the state goes before
      // refuseTn3270e(): that call reaches `tn3270eDisabled()` back through the layer,
      // which traces a line of its own only if there is still state to discard. So the
      // specific reason above is what a trace of this path shows, not a generic one.
      this.trace.note(`TN3270E abandoned: ${r.effect.why}`);
      this.forgetTn3270e();
      layer?.refuseTn3270e();
    }
  }

  /**
   * Forget a TN3270E negotiation: `e`, and the sequence counter that belongs to it.
   *
   * ONE place, THREE callers — the connection ending (`handleClose`), our own backoff
   * (`handleTn3270eSubneg`) and the HOST withdrawing option 40 mid-session
   * (`tn3270eDisabled`). The third was missing, and it is the same defect as the first
   * one layer along: `e` outliving the negotiation makes `inTn3270e()` true on a session
   * that is no longer TN3270E, so `handleRecord` eats five bytes off the front of every
   * inbound record and `sendInbound` prepends five the host has no parser for. That
   * exact corruption shipped once already, through `connect()` rather than through a
   * `DONT` — see the comment in `handleClose`.
   *
   * `eSeq` goes with it: it is zeroed only on a COMPLETED negotiation, so a
   * renegotiation on this same connection would otherwise keep counting from the
   * abandoned one's total. Nothing observes that today, because a session with no
   * negotiation writes no SEQ-NUMBER — which is the argument for putting it here rather
   * than at each caller, where "nothing observes it" would have to be re-derived.
   *
   * `bound`, `pendingBindRecord` and `noBindTimer` go with it for the SAME reason, not
   * a new one: the BIND gate is meaningless without a live TN3270E negotiation to have
   * granted the function, so every path that ends one must also end the gate, or a
   * second negotiation on this connection (or the next connection entirely) could
   * inherit `bound = true` from the first and skip the gate for data the new host has
   * not yet earned -- or, worse, inherit a `pendingBindRecord` addressed to a screen
   * geometry that no longer applies and execute it against the wrong buffer size. This
   * project has shipped exactly that shape of bug twice already for `e` itself (see
   * above and `tn3270eDisabled`), which is why the gate's state is retired in the same
   * place rather than trusted to a fourth call site remembering to do it by hand.
   */
  private forgetTn3270e(): void {
    this.e = undefined;
    this.eSeq = 0;
    this.bound = false;
    this.pendingBindRecord = undefined;
    if (this.noBindTimer !== undefined) {
      clearTimeout(this.noBindTimer);
      this.noBindTimer = undefined;
    }
  }

  /**
   * The telnet layer turned TN3270E off. Our negotiation goes with it.
   *
   * Wired to `TelnetLayerOptions.onTn3270eDisabled`, so it runs for BOTH ways the option
   * dies — the host's `IAC DONT 40` and our own `refuseTn3270e()` — rather than only the
   * one whose call site remembered. The host's is the one that had no route here at all:
   * a mid-session `DONT` does not close the connection, so `handleClose` never runs and
   * `e` survived a host that had stopped speaking TN3270E.
   *
   * The trace line is conditional because the backoff path clears `e` itself and has
   * already traced its own, more specific reason before calling `refuseTn3270e()`. A
   * line here regardless would report the same event twice with the second one vaguer.
   */
  private tn3270eDisabled(): void {
    if (this.e !== undefined) {
      this.trace.note('TN3270E turned off; negotiation state discarded');
    }
    this.forgetTn3270e();
  }

  /** True once TN3270E negotiation completed, i.e. records carry a header. */
  private inTn3270e(): boolean {
    return this.e?.phase === 'negotiated';
  }

  /**
   * True when the host agreed the BIND-IMAGE FUNCTION (0x00), NOT when a record of
   * BIND-IMAGE DATA TYPE (0x03) has arrived — those are two different meanings of the
   * same name, one negotiated once, the other carried on every BIND record. This
   * method answers only the first question, which is the one the gate in
   * `handleRecord` needs: whether a BIND is owed at all.
   */
  private bindImageGranted(): boolean {
    return this.e?.agreed.includes(Tn3270eFunc.BIND_IMAGE) ?? false;
  }

  /**
   * A BIND-IMAGE record arrived. MINIMAL FOR THIS TASK: Task 9 owns the geometry
   * (`Screen.setSizes`, `acceptBindDims`) and the OIA/trace reporting of what the BIND
   * asked for; this task's job is only the gate, so this stops at the two facts the
   * gate itself depends on -- `bound` flips true, and whatever the gate withheld now
   * runs through the SAME `executeRecord` a live record would have. `parseBind` and
   * its geometry are deliberately not consulted here yet.
   *
   * Cancels the Task-9 timer, since there is no more "no BIND" to time out on --
   * left inert today because `armNoBindTimer` is itself a stub, but wired here so
   * Task 9 does not also have to touch this call site.
   */
  private handleBind(_body: Uint8Array): void {
    this.bound = true;
    if (this.noBindTimer !== undefined) {
      clearTimeout(this.noBindTimer);
      this.noBindTimer = undefined;
    }
    const pending = this.pendingBindRecord;
    if (pending !== undefined) {
      this.pendingBindRecord = undefined;
      this.executeRecord(pending.body, pending.wants);
    }
  }

  /**
   * An UNBIND record arrived. MINIMAL FOR THIS TASK: x3270 also reverts geometry and
   * re-erases the screen on UNBIND (Common/telnet.c:2745-2765), which is Task 9/10
   * territory. This task only owns `bound`'s lifecycle, so it stops at clearing it --
   * a BIND-forthcoming UNBIND re-arms the gate for whatever 3270 data follows, exactly
   * as granting BIND-IMAGE armed it the first time.
   */
  private handleUnbind(_body: Uint8Array): void {
    this.bound = false;
  }

  /**
   * Arm the Task-9 "give up waiting for a BIND" timer. STUB FOR THIS TASK: the plan
   * reserves the timeout logic itself for Task 9 (NO_BIND_TIMEOUT_MS, bind.ts), and
   * this task's tests never let a timer fire -- each one either supplies a BIND or
   * asserts the retained-not-executed state before one would. Left as a documented
   * no-op rather than removed so `handleRecord`'s call site and this task's tests do
   * not have to change again when Task 9 fills it in.
   */
  private armNoBindTimer(): void {
    // Intentionally empty. See NO_BIND_TIMEOUT_MS in bind.ts.
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

  /**
   * Operator pressed a key that generates an AID.
   *
   * THE BYTE IS CHECKED, and that check is the backstop for a defect that reached a live host: an
   * out-of-range `PF_AIDS[n - 1]!` is `undefined`, and `buildReadModified`'s `Uint8Array.from`
   * coerces that to **0**, so a bogus `0x00` AID went to a mainframe and locked the keyboard.
   * `pfAID`/`paAID` fix the callers; this makes the bad byte unsendable by any caller written later.
   *
   * Checked BEFORE the connected test, so the diagnosis does not depend on whether a socket happens
   * to be open: a caller passing a nonsense AID has a bug either way, and hearing 'not connected'
   * first would send them looking at the transport.
   */
  sendAID(aid: number): void {
    if (!VALID_AIDS.has(aid)) {
      throw new RangeError(`${aid} is not an AID byte; use AID, pfAID(n) or paAID(n)`);
    }
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

  /**
   * The Sys Req key. TWO COMPLETELY DIFFERENT THINGS ON THE WIRE, chosen by whether the
   * session is TN3270E.
   *
   * x3270's `SysReq_action` splits on `IN_E`, and nothing else (`Common/kybd.c:2849-2870`):
   *
   *   if (IN_E) net_abort();
   *   else { ...; key_AID(AID_SYSREQ); }
   *
   * TN3270E: Telnet IAC AO, via `sendSysreq()`. `net_abort()` then checks the SYSREQ
   * function bit itself (`Common/telnet.c:3632-3648`), which is what the guard below
   * mirrors. An E session that declined the function sends NOTHING — and specifically not
   * the classic form as a fallback, because x3270 never reaches the `else` arm on an E
   * session. A host that negotiated TN3270E and refused SYSREQ has said what it wants.
   * Not a data message, so it spends no sequence number.
   *
   * CLASSIC: a TEST REQUEST READ — the four bytes SOH `%` `/` STX, then the modified field
   * data, and NO AID BYTE AT ALL. `key_AID(AID_SYSREQ)` looks like it transmits 0xf0 and
   * does not; `ctlr_read_modified` intercepts that AID and substitutes the heading
   * (`Common/ctlr.c:770-777`). `buildReadModified` carries the same branch and the
   * citations. THIS IS THE PATH BOTH OF THIS PROJECT'S LIVE HOSTS TAKE: VM/370 CE and MVS
   * 3.8j TK5 each answer `IAC WILL TN3270E` with DONT, measured three times.
   *
   * Routed through `sendAID` because that is this codebase's `key_AID`: the keyboard lock it
   * sets is not incidental, it is what x3270 does for every AID including this one
   * (`kybd.c:918-923`). `sendAID` validates 0xf0 against `VALID_AIDS`, where `AID.SYSREQ`
   * already sits, and hands the record to `sendInbound`, so the framing question is answered
   * the same way as for Enter.
   *
   * SILENT, NEVER THROWING, on every refusal. The key exists on the keyboard whatever the
   * host granted or the transport is doing, so pressing it is not the operator's mistake;
   * `applyAction` swallows refusals into the OIA and the CLI's `SysReq()` reports none.
   * That is why the not-connected check is here rather than left to `sendAID`, which throws.
   *
   * REFUSES ON AN INHIBITED KEYBOARD, WHERE x3270 WOULD QUEUE. It refuses outright on
   * `KL_OIA_MINUS` and calls `enq_ta` on any other lock (`kybd.c:2858-2864`). We have no
   * action queue and one is not worth inventing for a single key, so both become a refusal:
   * the press is declined rather than deferred, nothing goes on the wire out of turn, and
   * the OIA already shows the operator why.
   */
  sysreq(): void {
    if (this.telnet === undefined) {
      this.trace.note('SYSREQ ignored: not connected');
      return;
    }
    if (this.inTn3270e()) {
      if (!this.e?.agreed.includes(Tn3270eFunc.SYSREQ)) {
        this.trace.note('SYSREQ ignored: function not negotiated');
        return;
      }
      this.telnet.sendSysreq();
      return;
    }
    if (this.oia.isInhibited()) {
      this.trace.note(`SYSREQ refused: input inhibited (${this.oia.toText()})`);
      return;
    }
    this.sendAID(AID.SYSREQ);
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
    const telnet: TelnetLayer = new TelnetLayer({
      write: () => { /* discard: replay is one-directional */ },
      onRecord: (r) => this.handleRecord(r),
      tn3270eEnabled: this.opts.tn3270e ?? true,
      // Wired even though writes are discarded: replaying a TN3270E trace still has
      // to advance the state machine, or handleRecord never learns to strip the
      // 5-byte header and every replayed record is parsed one command byte early.
      // `telnet` rather than `this.telnet`, which replay leaves undefined.
      onTn3270eSubneg: (body) => { this.handleTn3270eSubneg(body, telnet); },
      // Wired here too, and for the same reason the subnegotiation callback is: a
      // recorded trace can contain the host's `IAC DONT TN3270E`, and a replay that kept
      // `e` past it would strip a header from every later record that has none.
      onTn3270eDisabled: () => { this.tn3270eDisabled(); },
    });
    for (const ev of events) {
      if (ev.dir === 'recv') telnet.receive(ev.bytes);
    }
    this.emit('screen');
  }
}
