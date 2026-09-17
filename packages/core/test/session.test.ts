import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Cmd, Order, AID, FA, Qcode, Sfid,
} from '../src/constants.js';
import { KeyboardState, Oia } from '../src/oia.js';

/** An in-memory connection that records what the session sends. */
class FakeConnection implements Connection {
  sent: number[] = [];
  closed = false;
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.closed = true; this.onClose?.(); }

  /** Test helper: pretend the host sent these bytes. */
  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }

  /** Negotiate into 3270 mode the way a real host does. */
  negotiate(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.sent = [];
  }
}

function newSession(opts: Partial<SessionOptions> = {}) {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn, ...opts });
  return { session, conn };
}

describe('connection lifecycle', () => {
  it('starts disconnected', () => {
    const { session } = newSession();
    expect(session.isConnected()).toBe(false);
    expect(session.oia.toText()).toContain('X Disconnected');
  });

  it('reaches 3270 mode after negotiation and reports it in the OIA', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(session.is3270Mode()).toBe(true);
    expect(session.oia.toText()).toContain('4 A');
  });

  it('reports disconnection when the host closes', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.close();
    expect(session.isConnected()).toBe(false);
    expect(session.oia.toText()).toContain('X Disconnected');
  });

  it('surfaces a transport error as a disconnect, not a crash', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.onError?.(new Error('ECONNRESET'));
    expect(session.isConnected()).toBe(false);
    expect(session.lastError()).toContain('ECONNRESET');
  });

  it('connecting twice closes the first connection and leaves the session connected', async () => {
    const conn1 = new FakeConnection();
    const conn2 = new FakeConnection();
    let calls = 0;
    const session = new Session({
      connect: () => {
        calls++;
        return calls === 1 ? conn1 : conn2;
      },
    });

    await session.connect('localhost', 3270);
    await session.connect('localhost', 3270);

    expect(conn1.closed).toBe(true);
    expect(conn2.closed).toBe(false);
    expect(session.isConnected()).toBe(true);
  });

  it("a stale socket's onClose cannot make isConnected() false while the new one is live", async () => {
    const conn1 = new FakeConnection();
    const conn2 = new FakeConnection();
    let calls = 0;
    const session = new Session({
      connect: () => {
        calls++;
        return calls === 1 ? conn1 : conn2;
      },
    });

    await session.connect('localhost', 3270);
    const staleOnClose = conn1.onClose;
    await session.connect('localhost', 3270);

    // Fire the FIRST connection's close callback directly, simulating a
    // straggling event from the socket we already replaced.
    staleOnClose?.();

    expect(session.isConnected()).toBe(true);
  });

  it("disconnect() is idempotent: two calls emit 'disconnect' once", async () => {
    const { session, conn } = newSession();
    const onDisconnect = vi.fn();
    session.on('disconnect', onDisconnect);
    await session.connect('localhost', 3270);
    conn.negotiate();

    session.disconnect();
    session.disconnect();

    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

/**
 * `reconnect()`: THE SAME TARGET, THROUGH THE SAME INJECTED `connect`.
 *
 * The interactive front ends reach this from the Enter and Clear keys while disconnected, and the
 * CLI from `Reconnect()`. What is asserted here is the three-part memory (host, port, options) and
 * the two refusals; the KEY BINDING is `frontend/test/actions.test.ts`'s business.
 */
describe('reconnect() replays the remembered target', () => {
  /**
   * A session whose injected `connect` records what it was asked for AND the decision it closes
   * over -- which is how the real one carries TLS.
   *
   * `frontend`'s `defaultSession` builds `connect: (h, p) => tcpConnect(h, p, tls)`, so the TLS
   * choice is not a parameter of `connect()` at all: it is captured in the closure. THAT IS THE
   * WHOLE SAFETY ARGUMENT FOR `reconnect()`, and it is worth a test that would fail if reconnecting
   * ever routed around `opts.connect`, because the failure mode is not an error -- a plaintext
   * Hercules does not reject a TLS handshake, it HANGS.
   */
  function dialRecorder(scheme: 'tls' | 'plaintext') {
    const dialled: { host: string; port: number; scheme: string }[] = [];
    const conns: FakeConnection[] = [];
    const session = new Session({
      connect: (host, port) => {
        // `scheme` is read from the closure, exactly as `tcpConnect(h, p, tls)` reads `tls`.
        dialled.push({ host, port, scheme });
        const conn = new FakeConnection();
        conns.push(conn);
        return conn;
      },
    });
    return { session, dialled, conns };
  }

  it('dials the SAME host and port, through the SAME injected connect', async () => {
    const { session, dialled, conns } = dialRecorder('plaintext');
    await session.connect('vm.example', 3270);
    conns[0]!.close();                                  // the host hangs up, as a LOGOFF does

    await session.reconnect();

    // THE PORT IS AS LOAD-BEARING AS THE HOST. Replaying 23 -- the default every host spec falls
    // back to -- would dial the wrong service on the right machine, and 3270 versus 23 is exactly
    // the transposition a from-memory reimplementation makes.
    expect(dialled).toEqual([
      { host: 'vm.example', port: 3270, scheme: 'plaintext' },
      { host: 'vm.example', port: 3270, scheme: 'plaintext' },
    ]);
    // The second dial's connection is the live one, so the reconnect really produced the session's
    // transport rather than leaving the closed socket in place.
    expect(session.isConnected()).toBe(true);
    expect(conns).toHaveLength(2);
    conns[1]!.negotiate();
    expect(session.is3270Mode()).toBe(true);
  });

  it('carries the original TLS decision, because it cannot do anything else', async () => {
    // The same run with the other decision. Neither dial can differ from the other, because
    // `reconnect()` has no host argument and therefore nothing to re-derive a scheme FROM -- the
    // property is structural, and this is the assertion that would notice if it stopped being.
    const { session, dialled, conns } = dialRecorder('tls');
    await session.connect('secure.example', 992);
    conns[0]!.close();
    await session.reconnect();
    expect(dialled.map((d) => d.scheme)).toEqual(['tls', 'tls']);
  });

  it('works AFTER handleClose, which is the entire point', async () => {
    // `handleClose` is documented as the one place a connection ends and it discards everything the
    // connection owned. The remembered target deliberately survives it: reconnecting happens only
    // after a close, so clearing it there would make this unreachable by construction. Both routes
    // into `handleClose` are exercised -- the host's own close and our `disconnect()`.
    const { session, dialled, conns } = dialRecorder('plaintext');
    await session.connect('vm.example', 3270);
    conns[0]!.close();                                  // route 1: the socket closed on us
    await session.reconnect();
    expect(session.isConnected()).toBe(true);

    session.disconnect();                               // route 2: we closed it
    expect(session.isConnected()).toBe(false);
    await session.reconnect();
    expect(session.isConnected()).toBe(true);
    expect(dialled).toHaveLength(3);
  });

  it('REFUSES when nothing has ever been connected, in x3270 s own words', async () => {
    // `Reconnect_action`: `if (current_host == NULL) { popup_an_error(AnReconnect "(): No previous
    // host to connect to"); return false; }` (Common/host.c). A refusal and not a no-op, and the
    // wording is passed through to a script by the CLI's `Reconnect()`.
    //
    // THIS IS THE STATE EVERY REPLAY-MODE FRONT END IS IN -- `TN3270_GUI_REPLAY` and the gateway's
    // `--replay` never connect at all -- so it is reached by more than a hypothetical.
    const { session, dialled } = dialRecorder('tls');
    await expect(session.reconnect()).rejects.toThrow('Reconnect(): No previous host to connect to');
    expect(dialled, 'a session with no target dialled something anyway').toEqual([]);
  });

  it('REFUSES while connected, rather than silently redialling', async () => {
    // x3270's first check: `if (PCONNECTED) { popup_an_error(AnReconnect "(): Already connected");
    // return false; }`. `connect()` would happily tear down the live socket and build another, which
    // is what `Connect()` is for; a reconnect asked for while up is a caller's mistake and saying so
    // is more useful than a silent reconnection an operator did not ask for.
    const { session, dialled } = dialRecorder('plaintext');
    await session.connect('vm.example', 3270);
    await expect(session.reconnect()).rejects.toThrow('Reconnect(): Already connected');
    expect(dialled).toHaveLength(1);
    expect(session.isConnected()).toBe(true);
  });

  it('REFUSES a second reconnect while the first is still in flight', async () => {
    // x3270's `PCONNECTED` is "connected OR HALF-connected"; `isConnected()` only sees the completed
    // case. Without the pending half, two presses of the reconnect key both pass `connect()`'s
    // teardown check while `this.conn` is undefined, so the first socket is replaced WITHOUT being
    // closed -- an LU left open on the mainframe per impatient keypress, and invisible from here.
    const conns: FakeConnection[] = [];
    let release: (() => void) | undefined;
    const session = new Session({
      connect: async () => {
        const conn = new FakeConnection();
        conns.push(conn);                               // pushed BEFORE the wait: a dial is a dial
        await new Promise<void>((r) => { release = r; });
        return conn;
      },
    });
    const first = session.connect('vm.example', 3270);
    release!();
    await first;
    conns[0]!.close();

    const pending = session.reconnect();
    expect(conns, 'the first reconnect did not dial').toHaveLength(2);
    await expect(session.reconnect()).rejects.toThrow('Reconnect(): Already connected');
    expect(conns, 'the refused reconnect opened a socket anyway').toHaveLength(2);
    release!();
    await pending;
    expect(session.isConnected()).toBe(true);
  });

  it('records a failed reconnect in lastError and the trace, and rethrows it', async () => {
    // A front end that can only swallow the rejection -- `applyAction` is synchronous -- must still
    // leave the reason somewhere findable, so the failure is recorded before it is rethrown. The
    // rethrow is what lets the CLI report `error` for `Reconnect()`.
    let fail = false;
    const conn = new FakeConnection();
    const session = new Session({
      connect: () => {
        if (fail) throw new Error('ECONNREFUSED');
        return conn;
      },
    });
    session.trace.setEnabled(true);
    await session.connect('vm.example', 3270);
    conn.close();
    fail = true;

    await expect(session.reconnect()).rejects.toThrow('ECONNREFUSED');
    expect(session.lastError()).toContain('ECONNREFUSED');
    expect(session.trace.toText()).toContain('reconnect to vm.example:3270 failed');
    // AND THE TARGET SURVIVES THE FAILURE: an operator whose host was down retries the same key.
    // Recording the target only on a SUCCESSFUL connect would make the key dead in exactly the
    // situation that produced it.
    fail = false;
    await session.reconnect();
    expect(session.isConnected()).toBe(true);
  });

  it('remembers a target that NEVER came up, so the first key press can retry it', async () => {
    // The initial `connect()` failed -- a refused socket, or the TLS-against-Hercules hang's
    // eventual timeout. The OIA offers the key, so the key must work.
    let fail = true;
    const conn = new FakeConnection();
    const session = new Session({
      connect: () => {
        if (fail) throw new Error('ECONNREFUSED');
        return conn;
      },
    });
    await expect(session.connect('vm.example', 3270)).rejects.toThrow('ECONNREFUSED');
    expect(session.oia.reconnectable).toBe(true);
    fail = false;
    await session.reconnect();
    expect(session.isConnected()).toBe(true);
  });
});

describe('the OIA says the reconnect key exists', () => {
  it('offers Enter once there is a host to go back to, and not before', async () => {
    // GATED ON A REMEMBERED TARGET, deliberately: a session that never connected -- which is what
    // every replay-mode front end is -- has nothing to reconnect to, and offering the key there
    // would be an instruction that silently does nothing. It is also what keeps the GUI and browser
    // screenshot goldens still, since both are taken in replay mode.
    const { session, conn } = newSession();
    expect(session.oia.toText()).toBe('X Disconnected');

    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.close();
    expect(session.oia.toText()).toContain('X Disconnected -- press Enter to reconnect');
  });

  it('fits the status line, worst case included', () => {
    // The OIA is a 3270 status line with a real layout: both renderers TRUNCATE rather than wrap
    // (`canvas/src/drawlist.ts`'s `oiaCells`, `tui/src/render.ts`), so a line over 80 columns
    // silently loses its tail. Asserted with every other part this method can add while
    // disconnected -- a program check and the insert caret; `waitingForHost` is cleared by
    // `handleClose` -- rather than for the phrase alone.
    const oia = new Oia();
    oia.reconnectable = true;
    oia.programCheck(754);
    oia.insertMode = true;
    const text = oia.toText();
    expect(text).toContain('press Enter to reconnect');
    expect(text).toContain('X PROG754');
    expect(text.length, `the OIA no longer fits 80 columns: ${text}`).toBeLessThanOrEqual(80);
  });
});

describe('initial keyboard lock', () => {
  // Found live: a script that connects and immediately types races the host's
  // first screen. x3270 sets KL_AWAITING_FIRST on connect — "Wait for any output
  // or a WCC(restore) from the host" (kybd.c:580-585).
  it('locks the keyboard on connect, before the host writes', async () => {
    const { session } = newSession();
    await session.connect('localhost', 3270);
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    expect(session.oia.isInhibited()).toBe(true);
    expect(session.oia.waitingForHost).toBe(true);
  });

  it('releases the lock on the first host write, restore bit or not', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    // WCC 0x00 — no keyboard-restore bit at all.
    conn.host(SnaCmd.W, 0x00, 0xc1, T.IAC, T.EOR);
    expect(session.oia.isInhibited()).toBe(false);
    expect(session.oia.waitingForHost).toBe(false);
  });

  it('reports the wait in the OIA while awaiting the first write', async () => {
    const { session } = newSession();
    await session.connect('localhost', 3270);
    expect(session.oia.toText()).toContain('X Wait');
  });
});

describe('applying host writes', () => {
  it('applies an Erase/Write and emits a screen event', async () => {
    const { session, conn } = newSession();
    const onScreen = vi.fn();
    session.on('screen', onScreen);
    await session.connect('localhost', 3270);
    conn.negotiate();

    conn.host(SnaCmd.EW, 0xc3, Order.SBA, 0x40, 0x40, Order.SF, FA.PROTECT, 0xc8, 0xc9, T.IAC, T.EOR);

    expect(session.screen.rowText(1).slice(0, 3)).toBe(' HI');
    expect(onScreen).toHaveBeenCalled();
  });

  it('unlocks the keyboard when the WCC says to', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.oia.inhibit(KeyboardState.SystemWait);
    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // WCC keyboard restore
    expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);
  });

  it('answers a Read Modified with an inbound record', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR);
    session.keyboard.moveCursor(1);
    session.keyboard.type('A');
    conn.sent = [];

    conn.host(SnaCmd.RM, T.IAC, T.EOR);

    // AID.NONE because no key was pressed; then cursor, SBA, data, IAC EOR.
    expect(conn.sent[0]).toBe(AID.NONE);
    expect(conn.sent.slice(-2)).toEqual([T.IAC, T.EOR]);
  });
});

describe('program checks keep the session up', () => {
  it('turns a malformed record into X PROG and stays connected', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();

    conn.host(0x99, 0x00, T.IAC, T.EOR); // unknown command

    expect(session.oia.keyboard).toBe(KeyboardState.ProgramCheck);
    expect(session.oia.toText()).toContain('X PROG');
    expect(session.isConnected()).toBe(true);
  });

  it('recovers and applies the next valid record', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(0x99, 0x00, T.IAC, T.EOR);
    conn.host(SnaCmd.EW, 0xc3, 0xc1, T.IAC, T.EOR);
    expect(session.screen.rowText(1)[0]).toBe('A');
    expect(session.isConnected()).toBe(true);
  });

  it('treats an out-of-range address as a program check', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    // RA with a 14-bit address of 4095, past the 1920-cell buffer.
    conn.host(SnaCmd.W, 0x00, Order.RA, 0x0f, 0xff, 0x5c, T.IAC, T.EOR);
    expect(session.oia.keyboard).toBe(KeyboardState.ProgramCheck);
    expect(session.isConnected()).toBe(true);
  });
});

describe('sending AIDs', () => {
  it('sends Enter with cursor and modified fields', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR);
    session.keyboard.moveCursor(1);
    session.keyboard.type('A');
    conn.sent = [];

    session.sendAID(AID.ENTER);

    expect(conn.sent[0]).toBe(AID.ENTER);
    expect(conn.sent).toContain(Order.SBA);
    expect(conn.sent.slice(-2)).toEqual([T.IAC, T.EOR]);
  });

  it('sends a short read for Clear — AID alone plus the record terminator', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, 0xc1, T.IAC, T.EOR);
    conn.sent = [];

    session.sendAID(AID.CLEAR);

    expect(conn.sent).toEqual([AID.CLEAR, T.IAC, T.EOR]);
  });

  it('clears the local screen when Clear is sent, as the hardware does', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, 0xc1, T.IAC, T.EOR);
    session.sendAID(AID.CLEAR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0x00);
  });

  it('locks the keyboard while waiting for the host to reply', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.sendAID(AID.ENTER);
    expect(session.oia.waitingForHost).toBe(true);
    conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // keyboard restore
    expect(session.oia.waitingForHost).toBe(false);
  });

  it('sends Attn as IAC BREAK rather than an AID', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent = [];
    session.sendAttn();
    expect(conn.sent).toEqual([T.IAC, T.BREAK]);
  });

  it('refuses to send when not connected', () => {
    const { session } = newSession();
    expect(() => session.sendAID(AID.ENTER)).toThrow(/not connected/i);
  });

  /**
   * SYS REQ ON A CLASSIC SESSION, i.e. every session either of this project's live hosts
   * will ever give us: VM/370 CE and MVS 3.8j TK5 both answer `IAC WILL TN3270E` with
   * DONT (`ff fe 28`).
   *
   * The TN3270E form — Telnet IAC AO — is asserted separately in tn3270e-session.test.ts,
   * on a session that negotiated the function. The two must not share a test: a single
   * assertion loose enough to accept either would accept neither being right.
   *
   * Raw byte literals rather than the constants under test, for the reason given at the
   * head of inbound.test.ts's test-request block.
   */
  describe('Sys Req on a classic session', () => {
    /** Erase/Write, WCC 0xc3 (restore keyboard, reset MDT). Leaves the screen unformatted. */
    function connected() {
      const { session, conn } = newSession();
      return session.connect('localhost', 3270).then(() => {
        conn.negotiate();
        conn.host(SnaCmd.EW, 0xc3, T.IAC, T.EOR);
        conn.sent = [];
        return { session, conn };
      });
    }

    it('sends the four-byte test request heading and nothing else', async () => {
      const { session, conn } = await connected();
      session.sysreq();
      expect(conn.sent).toEqual([0x01, 0x6c, 0x61, 0x02, T.IAC, T.EOR]);
    });

    it('sends the heading then the modified field data, with no AID and no cursor', async () => {
      const { session, conn } = newSession();
      await session.connect('localhost', 3270);
      conn.negotiate();
      conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR);
      session.keyboard.moveCursor(1);
      session.keyboard.type('X');
      conn.sent = [];

      session.sysreq();

      expect(conn.sent).toEqual([
        0x01, 0x6c, 0x61, 0x02, // SOH % / STX
        Order.SBA, 0x40, 0xc1,  // the modified field's data starts at address 1
        0xe7,                   // the 'X' the operator typed
        T.IAC, T.EOR,
      ]);
    });

    it('goes out as an ordinary inbound record, terminated by IAC EOR', async () => {
      // NOT like Attn or the TN3270E Sys Req, both of which are bare Telnet commands with
      // no EOR. A test request is 3270 data: it is what a Read Modified returns.
      const { session, conn } = await connected();
      session.sysreq();
      expect(conn.sent.slice(-2)).toEqual([T.IAC, T.EOR]);
    });

    it('never sends AID 0xf0', async () => {
      const { session, conn } = await connected();
      session.sysreq();
      expect(conn.sent).not.toContain(AID.SYSREQ);
    });

    it('locks the keyboard, as x3270 does for every key_AID', async () => {
      // key_AID sets KL_OIA_TWAIT | KL_OIA_LOCKED before calling ctlr_read_modified
      // (kybd.c:918-923), and SysReq_action reaches ctlr_read_modified through key_AID on
      // a non-E session (kybd.c:2857). So the operator waits, exactly as after Enter.
      const { session, conn } = await connected();
      session.sysreq();
      expect(session.oia.waitingForHost).toBe(true);
      expect(session.oia.toText()).toContain('X SYSTEM');
      conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // keyboard restore
      expect(session.oia.waitingForHost).toBe(false);
    });

    it('refuses, writing nothing, when the keyboard is inhibited', async () => {
      // x3270 refuses outright on KL_OIA_MINUS and QUEUES on any other lock, via enq_ta
      // (kybd.c:2858-2864). WE HAVE NO ACTION QUEUE, and inventing one for a single key
      // would be a new mechanism nothing else in this codebase uses. Refusing is the
      // honest analogue of both: the operator's press is declined rather than deferred,
      // the OIA already says why, and nothing goes on the wire out of turn.
      const { session, conn } = await connected();
      session.oia.inhibit(KeyboardState.ProtectedField);
      session.sysreq();
      expect(conn.sent).toEqual([]);
    });

    it('refuses before the host\'s first write, when the connect-time lock is up', async () => {
      // The realistic case: negotiation is done, the keyboard is AwaitingFirstWrite, and
      // the operator hits Sys Req. Nothing should go out.
      const { session, conn } = newSession();
      await session.connect('localhost', 3270);
      conn.negotiate();
      conn.sent = [];
      session.sysreq();
      expect(conn.sent).toEqual([]);
    });

    it('is silent rather than throwing when not connected', async () => {
      // Unlike sendAID, which throws. The key exists on the keyboard whatever the
      // transport is doing, and the CLI's SysReq() reports no refusal (cli/src/runner.ts).
      const { session, conn } = newSession();
      expect(() => { session.sysreq(); }).not.toThrow();
      expect(conn.sent).toEqual([]);
    });
  });

  describe('off', () => {
    /**
     * WHY A LISTENER MUST BE REMOVABLE, and it is a leak with teeth rather than tidiness.
     *
     * The web gateway's sessions OUTLIVE their sockets by design, so an operator can reload or
     * survive a wifi handoff and reattach. Each attach registered three listeners and there was no
     * way to take them off again, so a session reattached ten times carried thirty, and every later
     * screen change ran `drawList` and `deflateSync` thirty times -- twenty-nine of them for dead
     * connections that would discard the result. Unbounded in the number of reconnections.
     */
    it('removes a listener, and only that one', () => {
      const { session } = newSession();
      const a = vi.fn();
      const b = vi.fn();
      session.on('screen', a);
      session.on('screen', b);
      session.off('screen', a);
      session.replay('< f5 c1 11 40 40 c8 c9\n');       // any host write emits 'screen'
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalled();
    });

    it('counts what is registered, so a leak is observable', () => {
      const { session } = newSession();
      const fn = (): void => {};
      expect(session.listenerCount('screen')).toBe(0);
      session.on('screen', fn);
      expect(session.listenerCount('screen')).toBe(1);
      // The SAME function twice is one listener, because the store is a Set -- which is also why
      // `off` can be exact rather than removing the first match.
      session.on('screen', fn);
      expect(session.listenerCount('screen')).toBe(1);
      session.off('screen', fn);
      expect(session.listenerCount('screen')).toBe(0);
    });

    it('is a no-op for a function that was never registered, or an event with none', () => {
      // The gateway calls this on every socket close, including ones that never got as far as
      // `hello` and so registered nothing. Throwing there would turn a normal disconnect into an
      // error on a path with no caller to tell.
      const { session } = newSession();
      expect(() => session.off('screen', () => {})).not.toThrow();
      session.on('screen', () => {});
      expect(() => session.off('connect', () => {})).not.toThrow();
      expect(session.listenerCount('screen')).toBe(1);
    });

    it('does not disturb emit while it is running', () => {
      // A listener that removes itself is the shape that breaks a naive `for` over a mutating
      // collection. Iterating a Set that is modified during iteration is defined in JS, but the
      // behaviour is worth pinning rather than assuming.
      const { session } = newSession();
      const seen: string[] = [];
      const once = (): void => { seen.push('once'); session.off('screen', once); };
      session.on('screen', once);
      session.on('screen', () => { seen.push('always'); });
      session.replay('< f5 c1 11 40 40 c8 c9\n');
      session.replay('< f5 c1 11 40 40 c8 c9\n');
      expect(seen).toEqual(['once', 'always', 'always']);
    });
  });

  it('refuses a byte that is not an AID, and sends NOTHING', async () => {
    /**
     * THE BACKSTOP FOR A DEFECT THAT REACHED A LIVE MAINFRAME.
     *
     * `PF_AIDS[n - 1]!` on an out-of-range `n` is `undefined`, and `buildReadModified`'s
     * `Uint8Array.from` coerces that to **0** -- so a bogus `0x00` AID was transmitted and the
     * local keyboard locked. `pfAID`/`paAID` fix the two callers that existed; this is what makes
     * the byte unsendable by a caller written later.
     *
     * `0x00` is the exact value the coercion produced, and `undefined` is what produced it, so both
     * are asserted rather than a tidier representative sample.
     */
    const { session, conn } = newSession();
    await session.connect('h', 23);
    for (const bad of [0x00, 0xff, 0x01, -1, 1.5, undefined as unknown as number]) {
      conn.sent = [];
      expect(() => session.sendAID(bad), `sendAID(${String(bad)})`).toThrow(RangeError);
      expect(conn.sent, `sendAID(${String(bad)}) must write nothing`).toEqual([]);
    }
  });

  it('refuses a bogus AID BEFORE complaining about the connection', () => {
    // Order matters for the diagnosis: hearing 'not connected' first would send whoever passed a
    // nonsense AID looking at the transport, when their bug is the argument.
    const { session } = newSession();
    expect(() => session.sendAID(0x00)).toThrow(/not an AID byte/);
  });
});

describe('trace and replay', () => {
  it('records both directions when tracing is on', async () => {
    const { session, conn } = newSession();
    session.trace.setEnabled(true);
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, 0xc1, T.IAC, T.EOR);
    const text = session.trace.toText();
    expect(text).toContain(' < ');
    expect(text).toContain(' > ');
  });

  it('replays a recorded trace with no socket at all', async () => {
    // Record a session...
    const { session: rec, conn } = newSession();
    rec.trace.setEnabled(true);
    await rec.connect('localhost', 3270);
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, Order.SBA, 0x40, 0x40, 0xc8, 0xc9, T.IAC, T.EOR);
    const traceText = rec.trace.toText();

    // ...then replay it into a fresh session.
    const fresh = new Session({ connect: () => { throw new Error('must not connect'); } });
    fresh.replay(traceText);
    expect(fresh.screen.rowText(1).slice(0, 2)).toBe('HI');
  });

  it('replay() on a connected session throws and writes nothing', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent = [];

    // A realistic recorded fixture: host negotiation followed by a Read
    // Buffer. If replay() were allowed to run against a live session,
    // handleRecord would answer that Read Buffer through this.telnet, i.e.
    // straight down the real socket.
    const traceText = [
      '0.000 < ff fd 19 ff fb 19',
      '0.001 < ff fd 00 ff fb 00',
      '0.002 < f2 ff ef',
    ].join('\n');

    expect(() => session.replay(traceText)).toThrow(/disconnected/i);
    expect(conn.sent).toEqual([]);
  });
});

describe('query reply', () => {
  /**
   * WSF carrying Read Partition: L=5 SFID=01 PID=ff TYPE=02.
   *
   * The PID is DOUBLED on the wire, and it must be: PID_QUERY is 0xFF, which is
   * IAC, and conn.host() feeds raw wire bytes into the telnet state machine.
   * A single 0xFF here is read as an IAC command and the following 0x02 as its
   * argument, so the record arrives 2 bytes short and never parses as a Query.
   * A real host doubles it the same way our sendRecord does (telnet.ts:79), and
   * the receiver un-doubles it (telnet.ts:122) — see the note in stream/sf.ts.
   */
  const QUERY = [SnaCmd.WSF, 0x00, 0x05, 0x01, T.IAC, T.IAC, 0x02] as const;

  /**
   * The 3270 record the session sent, unwrapped from telnet framing.
   *
   * conn.sent is a flat byte array and an outbound record ends with IAC EOR
   * (telnet.ts:84). Doubled IAC inside the payload is not un-doubled here — no
   * assertion below needs it.
   */
  function lastRecord(conn: FakeConnection): number[] {
    const end = conn.sent.length - 2; // drop the trailing IAC EOR
    expect(conn.sent.slice(end)).toEqual([T.IAC, T.EOR]);
    return conn.sent.slice(0, end);
  }

  it('answers a Read Partition Query with a Query Reply', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(...QUERY, T.IAC, T.EOR);
    const reply = lastRecord(conn);
    // AID 0x88, then L L SFID QCODE — Summary first.
    expect(reply[0]).toBe(AID.SF);
    expect(reply[3]).toBe(Sfid.QUERY_REPLY);
    expect(reply[4]).toBe(Qcode.SUMMARY);
  });

  it('does not touch the screen when answering a Query', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.screen.setChar(0, 0xc1);
    session.screen.cursor = 5;
    conn.host(...QUERY, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);
    expect(session.screen.cursor).toBe(5);
  });

  it('does NOT unlock the keyboard on a Query, which is not a write', async () => {
    // THE REGRESSION THIS GUARDS: the AwaitingFirstWrite release fires for any
    // record, and TSO sends its Query BEFORE any write. Without excluding
    // WriteStructuredField the operator gets an unlocked keyboard over a blank
    // screen.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    conn.host(...QUERY, T.IAC, T.EOR);
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    expect(session.oia.isInhibited()).toBe(true);
  });

  it('still unlocks on a real write that follows a Query', async () => {
    // The exclusion must not break the normal release.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(...QUERY, T.IAC, T.EOR);
    conn.host(SnaCmd.W, 0x00, 0xc1, T.IAC, T.EOR);
    expect(session.oia.isInhibited()).toBe(false);
  });

  /**
   * The Query List MECAFF sends, in wire form.
   *
   * 00 07 01 ff 03 80 00 with the PID's 0xFF DOUBLED, for the reason spelled out
   * on QUERY above: a single 0xFF reaching the telnet state machine is read as
   * IAC and eats the following byte. The REQTYP 0x80 and QCODE 0x00 need no
   * doubling.
   *
   * Note L stays 7 — it counts RECORD bytes, not wire bytes, so the doubled IAC
   * does not change it. Getting that wrong yields a field one byte short of its
   * REQTYP and a program check instead of a reply.
   */
  const QUERY_LIST_ALL = [
    SnaCmd.WSF, 0x00, 0x07, 0x01, T.IAC, T.IAC, 0x03, 0x80, 0x00,
  ] as const;

  it('answers the real VM/370 Query List with a full Query Reply', async () => {
    // THE TEST THAT MATTERS FOR VM/CMS FILE TRANSFER. MECAFF's IND$FILE sends
    // this and waits; while Query List went unanswered, transfer hung forever.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(...QUERY_LIST_ALL, T.IAC, T.EOR);
    const reply = lastRecord(conn);
    expect(reply[0]).toBe(AID.SF);
    expect(reply[3]).toBe(Sfid.QUERY_REPLY);
    expect(reply[4]).toBe(Qcode.SUMMARY);
    // REQTYP=All, so all three units. Asserted as EQUAL to what a plain Query
    // produces, which is the strongest available statement for our current
    // capability list and which would catch a filter accidentally applied here.
    conn.sent.length = 0;
    conn.host(...QUERY, T.IAC, T.EOR);
    expect(reply).toEqual(lastRecord(conn));
  });

  it('answers a QCODE List with exactly the unit requested', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    // L=7: REQTYP 0x00 (QCODE List) then QCODE 0x81 (Usable Area).
    conn.host(
      SnaCmd.WSF, 0x00, 0x07, 0x01, T.IAC, T.IAC, 0x03, 0x00, 0x81, T.IAC, T.EOR);
    const reply = lastRecord(conn);
    // ONE unit: 1 AID + 23 Usable Area. Neither Summary nor Implicit Partition was
    // named, so neither appears — p. 6-96's "QCODE List=X'80'" is Summary's own
    // QCODE, not a REQTYP, so there is no always-send-Summary rule to apply here.
    // An earlier version of this test expected a forced Summary.
    expect(reply[4]).toBe(Qcode.USABLE_AREA);
    expect(reply).toHaveLength(1 + 23);
  });

  it('sends the Null Query Reply when it supports nothing requested', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    // QCODE List asking for Image (0x82) and Line Type (0xB2), neither of which
    // we advertise: Table 6-1 gives "Image No X'82' No Yes" (pages.txt:8607) and
    // "Line Type No X'B2' No Yes" (pages.txt:8610). p. 6-77's example 2
    // (pages.txt:10758-10761).
    //
    // These WERE 0x86 and 0x87. We now advertise Color and Highlighting, so that
    // request would return two real units and this test would be asserting the
    // Null reply against a host request we DO satisfy. Neither replacement is
    // 0xFF, so neither needs doubling and L stays 8.
    conn.host(
      SnaCmd.WSF, 0x00, 0x08, 0x01, T.IAC, T.IAC, 0x03, 0x00, 0x82, 0xb2,
      T.IAC, T.EOR);
    // Byte-exact, INCLUDING the wire doubling: the QCODE 0xFF is content, so
    // sendRecord doubles it (telnet.ts:82). lastRecord does not un-double, hence
    // ff ff here for the one 0xff in `88 00 04 81 ff`. That doubling is exactly
    // what makes this reply survive the transport, and asserting the wire form
    // proves it happened.
    expect(conn.sent).toEqual([AID.SF, 0x00, 0x04, Sfid.QUERY_REPLY, 0xff, 0xff, T.IAC, T.EOR]);
  });

  it('does not answer a Query List against a real partition', async () => {
    // x3270 rejects this (sf.c:248-251); we count it and stay quiet. PID 0x00 is
    // not doubled — it is not 0xFF.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(SnaCmd.WSF, 0x00, 0x07, 0x01, 0x00, 0x03, 0x80, 0x81, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
  });

  it('survives a reserved REQTYP without answering or dropping the session', async () => {
    // B'11' (0xC0) is "Reserved" (pages.txt:6361). THE REGRESSION THIS GUARDS:
    // selectCapabilities throws a RangeError on it, and handleRecord rethrows
    // anything that is not a ParseError/AddressError/ExecuteError as "our own
    // bug". If the reserved value reached the builder, two bits from a host would
    // tear the connection down. It is screened in stream/sf.ts instead.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(SnaCmd.WSF, 0x00, 0x06, 0x01, T.IAC, T.IAC, 0x03, 0xc0, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
    expect(session.isConnected()).toBe(true);
    // Not a program check either: an unanswerable field is ignored, not faulted.
    expect(session.oia.toText()).not.toContain('X PROG');
  });

  it('does not touch the screen or keyboard when answering a Query List', async () => {
    // The same rule as the plain-Query test above, which is live-verified: a
    // Read Partition is a question about the device. p. 5-53's step list
    // (pages.txt:6413-6427) changes no buffer, and its step 1 raises the
    // enter-inhibit — so the keyboard must stay LOCKED, not be unlocked by a
    // record that wrote nothing.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.screen.setChar(0, 0xc1);
    session.screen.cursor = 5;
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    conn.host(...QUERY_LIST_ALL, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);
    expect(session.screen.cursor).toBe(5);
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    expect(session.oia.isInhibited()).toBe(true);
  });

  it('rejects a Query List with no REQTYP as a program check, keeping the connection', async () => {
    // L=5 ends after TYPE, so byte 5 is missing. x3270 calls this "error: missing
    // request type" (sf.c:252-255). This was a VALID no-op input before Query
    // List was implemented; it is now a malformed record, and the session must
    // fault it rather than guess REQTYP=B'00' (which would answer with a Null
    // Query Reply — a positive-looking "we support nothing").
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(SnaCmd.WSF, 0x00, 0x05, 0x01, T.IAC, T.IAC, 0x03, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
    expect(session.oia.toText()).toContain('X PROG');
    expect(session.isConnected()).toBe(true);
  });

  it('does not answer a Read Partition against a real partition', async () => {
    // PID 0x00 is a read of partition zero, not a query. We do not support
    // partitions, so answering with capabilities would be wrong.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(SnaCmd.WSF, 0x00, 0x05, 0x01, 0x00, 0x02, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
  });

  it('reports a malformed structured field as a program check, keeping the connection', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    // A length with an SFID but no PID/TYPE. NOTE L=0 is LEGAL (it means "to
    // the end of the transmission", which stream/sf.ts resolves), so this is
    // rejected for lacking PID and TYPE, not for the zero.
    conn.host(SnaCmd.WSF, 0x00, 0x00, 0x01, T.IAC, T.EOR);
    expect(session.oia.toText()).toContain('X PROG');
    expect(session.isConnected()).toBe(true);
  });

  describe('the enter-inhibit condition', () => {
    /**
     * GA23-0059 p. 5-53, step 1 of Read Partition processing
     * (pages.txt:6413): "1. The enter-inhibit condition is raised."
     *
     * x3270 does the same in query_reply_end() (Common/sf.c:926-930):
     *
     *     net_output();
     *     kybd_inhibit(true);
     *
     * and kybd_inhibit(true) sets KL_ENTER_INHIBIT (Common/kybd.c:528),
     * whose header comment is "Awaiting unlock after QueryReply"
     * (include/kybd.h:45).
     */

    /** Get a session past its first host write, so AwaitingFirstWrite is gone. */
    async function midSession() {
      const { session, conn } = newSession();
      await session.connect('localhost', 3270);
      conn.negotiate();
      // Erase/Write with WCC keyboard-restore, one unprotected field, cursor
      // inside it: an ordinary host panel the operator may type into.
      conn.host(SnaCmd.EW, 0x02, Order.SF, 0x00, T.IAC, T.EOR);
      session.keyboard.moveCursor(1);
      expect(session.oia.isInhibited()).toBe(false);
      conn.sent.length = 0;
      return { session, conn };
    }

    it('raises the inhibit on a mid-session Query', async () => {
      // THE DIVERGENCE THIS CLOSES. Before this fix a mid-session Query left
      // the keyboard unlocked over a screen the host considers frozen, and the
      // operator could type into it.
      const { session, conn } = await midSession();
      conn.host(...QUERY, T.IAC, T.EOR);
      expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);
      expect(session.oia.isInhibited()).toBe(true);
    });

    it('refuses operator input after a mid-session Query', async () => {
      // Enforcement, not just state: the whole point is that the operator
      // cannot type into the frozen screen.
      const { session, conn } = await midSession();
      expect(session.keyboard.type('A')).toBe(true); // typable before
      conn.host(...QUERY, T.IAC, T.EOR);
      expect(session.keyboard.type('B')).toBe(false);
      expect(session.screen.cellAt(2).ebcdic).toBe(0x00);
    });

    it('answers the Query BEFORE raising the inhibit', async () => {
      // x3270's ordering in query_reply_end(): net_output() then
      // kybd_inhibit(true) (Common/sf.c:928-929). Asserted by observing that
      // the reply is on the wire by the time the state has changed — both
      // happen inside the one synchronous handleRecord, so the only way to see
      // the order is that the reply is NOT lost to the lock.
      const { session, conn } = await midSession();
      conn.host(...QUERY, T.IAC, T.EOR);
      expect(conn.sent.length).toBeGreaterThan(0);
      expect(lastRecord(conn)[0]).toBe(AID.SF);
      expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);
    });

    // The four commands x3270 clears KL_ENTER_INHIBIT on, and only those:
    // ctlr_erase (Common/ctlr.c:550), reached for Erase/Write and
    // Erase/Write Alternate (the dispatch at ctlr.c:615-625);
    // ctlr_erase_all_unprotected (ctlr.c:1309); and ctlr_write (ctlr.c:1406),
    // reached for all three write commands. Deliberately WITHOUT WCC
    // keyboard-restore, so what releases the lock is the command itself.
    const clearing: ReadonlyArray<readonly [string, readonly number[]]> = [
      ['Write', [SnaCmd.W, 0x00, 0xc1]],
      ['EraseWrite', [SnaCmd.EW, 0x00, 0xc1]],
      ['EraseWriteAlternate', [SnaCmd.EWA, 0x00, 0xc1]],
      // EAU takes no WCC and no data (format at pages.txt:1951-1958).
      ['EraseAllUnprotected', [SnaCmd.EAU]],
    ];

    for (const [name, record] of clearing) {
      it(`releases the inhibit on ${name}`, async () => {
        const { session, conn } = await midSession();
        conn.host(...QUERY, T.IAC, T.EOR);
        expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);
        conn.host(...record, T.IAC, T.EOR);
        expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);
        expect(session.oia.isInhibited()).toBe(false);
      });
    }

    it('is NOT released by a Read command, a NoOp or another Query', async () => {
      // x3270 clears the bit in exactly three functions, none of which a read,
      // a NoOp or a second WSF reaches: process_ds dispatches CMD_RB/RM/RMA to
      // ctlr_read_buffer/ctlr_read_modified, CMD_WSF to
      // write_structured_field, and CMD_NOP to nothing but a trace line
      // (Common/ctlr.c:632-657).
      const { session, conn } = await midSession();
      conn.host(...QUERY, T.IAC, T.EOR);
      conn.host(SnaCmd.RM, T.IAC, T.EOR);
      expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);
      // Cmd.NOP, not SnaCmd.NOP, which does not exist: Table 3-1 "Command
      // Codes and Abbreviations" (pages.txt:1712-1722) lists no NOP row at all,
      // and x3270 likewise defines `#define CMD_NOP 0x03 /* no-op */`
      // (include/3270ds.h:43) with no SNA_CMD_NOP beside its eight siblings.
      conn.host(Cmd.NOP, T.IAC, T.EOR);
      expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);
      conn.host(...QUERY, T.IAC, T.EOR);
      expect(session.oia.keyboard).toBe(KeyboardState.EnterInhibit);
    });

    it('leaves AwaitingFirstWrite in place for a pre-write Query', async () => {
      // WHICH STATE WINS BEFORE THE FIRST WRITE. AwaitingFirstWrite must not
      // be downgraded to EnterInhibit: it is the STRONGER condition (there is
      // no screen at all yet, versus a screen that is merely frozen), it is
      // released by a strictly larger set of records (any write, including one
      // whose WCC restores the keyboard), and x3270 gives it priority in the
      // status line too — the KL_AWAITING_FIRST arm precedes the
      // KL_ENTER_INHIBIT arm in all four renderers (c3270/screen.c:2383-2386).
      // Both are inhibits, so the operator is refused either way.
      const { session, conn } = newSession();
      await session.connect('localhost', 3270);
      conn.negotiate();
      expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
      conn.host(...QUERY, T.IAC, T.EOR);
      expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
      expect(session.oia.isInhibited()).toBe(true);
      expect(session.keyboard.type('A')).toBe(false);
    });

    it('does not disturb a stronger inhibit the operator must clear', async () => {
      // A program check outranks enter-inhibit: x3270 keeps the operator-error
      // and lock bits set independently in one word, so raising
      // KL_ENTER_INHIBIT cannot erase them. We have a single state, so the
      // rule has to be explicit — and losing X PROG would hide a protocol
      // fault behind a routine wait.
      const { session, conn } = await midSession();
      conn.host(0x99, 0x00, T.IAC, T.EOR); // unknown command
      expect(session.oia.keyboard).toBe(KeyboardState.ProgramCheck);
      conn.host(...QUERY, T.IAC, T.EOR);
      expect(session.oia.keyboard).toBe(KeyboardState.ProgramCheck);
      expect(session.oia.toText()).toContain('X PROG');
    });

    it('a WCC keyboard-restore still unlocks after a Query', async () => {
      // The existing keyboardRestore path must keep working: WCC bit 6 unlocks
      // regardless, and it arrives on a Write, which clears the inhibit anyway.
      const { session, conn } = await midSession();
      conn.host(...QUERY, T.IAC, T.EOR);
      conn.host(SnaCmd.W, 0x02, T.IAC, T.EOR); // WCC keyboard restore
      expect(session.oia.keyboard).toBe(KeyboardState.Unlocked);
    });
  });
});

describe('terminal type negotiation', () => {
  /** The ASCII name from the session's TERMINAL-TYPE IS subnegotiation. */
  function negotiatedName(conn: FakeConnection): string {
    // IAC SB 24 IS <name...> IAC SE — telnet.ts:230-234.
    const start = conn.sent.findIndex((b, i) =>
      b === T.IAC && conn.sent[i + 1] === T.SB
      && conn.sent[i + 2] === O.TERMINAL_TYPE && conn.sent[i + 3] === S.IS);
    expect(start, 'no TERMINAL-TYPE IS was sent').toBeGreaterThanOrEqual(0);
    const nameStart = start + 4;
    // The first SE at or after the name is the one closing this subnegotiation:
    // an ASCII ttype cannot contain 0xf0. The name runs up to IAC SE, so stop
    // one byte before the SE to exclude its IAC.
    const end = conn.sent.indexOf(T.SE, nameStart);
    return String.fromCharCode(...conn.sent.slice(nameStart, end - 1));
  }

  it('negotiates the configured terminal type', async () => {
    const { session, conn } = newSession({ terminalType: 'IBM-3278-2-E' });
    await session.connect('localhost', 3270);
    // By hand, because negotiate() clears conn.sent afterwards.
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    expect(negotiatedName(conn)).toBe('IBM-3278-2-E');
  });

  it('negotiates IBM-3278-2-E when no terminal type is given', async () => {
    // Must not change casually. The goldens do NOT enforce this -- they replay
    // recorded bytes; this assertion and telnet.test.ts are the real enforcement.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    expect(negotiatedName(conn)).toBe('IBM-3278-2-E');
  });
});
