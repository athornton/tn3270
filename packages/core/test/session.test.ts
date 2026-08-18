import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Order, AID, FA, Qcode, Sfid,
} from '../src/constants.js';
import { KeyboardState } from '../src/oia.js';

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

  it('does not answer a Query List, which we do not implement', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    // PID 0xff doubled, as in QUERY above; only the TYPE differs.
    conn.host(SnaCmd.WSF, 0x00, 0x05, 0x01, T.IAC, T.IAC, 0x03, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
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

  it('negotiates IBM-3278-2 when no terminal type is given', async () => {
    // Must not change. The goldens do NOT enforce this -- they replay recorded
    // bytes; this assertion and telnet.test.ts are the real enforcement.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    expect(negotiatedName(conn)).toBe('IBM-3278-2');
  });
});
