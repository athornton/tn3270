import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Cmd, Order, AID, FA, Qcode, Sfid,
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
