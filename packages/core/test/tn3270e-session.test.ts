import { describe, it, expect } from 'vitest';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, AID,
  Tn3270eOp, Tn3270eFunc, Tn3270eDataType, Tn3270eResponseFlag, Tn3270eSense,
} from '../src/constants.js';

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** As session.test.ts's FakeConnection, plus TN3270E negotiation helpers. */
class FakeConnection implements Connection {
  sent: number[] = [];
  /** Each write kept separately, so "what did we send for this event" is answerable. */
  writes: number[][] = [];
  closed = false;
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); this.writes.push([...b]); }
  close(): void { this.closed = true; this.onClose?.(); }

  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }
  sb(...body: number[]): void { this.host(T.IAC, T.SB, O.TN3270E, ...body, T.IAC, T.SE); }
  clear(): void { this.sent = []; this.writes = []; }

  /** The classic route, for the strict-addition guard. */
  negotiateClassic(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.clear();
  }

  /**
   * The TN3270E route, exactly as the recorded s3270 transcript runs it. Note NO
   * BINARY and NO EOR are negotiated: RFC 2355 §4 makes them implied, and the
   * harness that produced the transcript sent only DO TN3270E.
   */
  negotiateE(grant: number[] = [Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ]): void {
    this.host(T.IAC, T.DO, O.TN3270E);
    this.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    this.sb(Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'),
      Tn3270eOp.CONNECT, ...ascii('TESTLU01'));
    this.sb(Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, ...grant);
  }
}

function newSession(opts: Partial<SessionOptions> = {}) {
  const conn = new FakeConnection();
  const session = new Session({
    connect: () => conn, terminalType: 'IBM-3278-2-E', ...opts,
  });
  return { session, conn };
}

/** Erase/Write, WCC reset+unlock, SBA(0,0), unprotected field, Insert Cursor. */
const WRITE_FIELD = [0xf5, 0xc3, 0x11, 0x40, 0x40, 0x1d, 0x40, 0x13];
/** A TN3270E 3270-DATA header with the given response flag and sequence. */
const hdr = (responseFlag = 0, seq = 0): number[] =>
  [Tn3270eDataType.DATA_3270, 0x00, responseFlag, (seq >> 8) & 0xff, seq & 0xff];

describe('TN3270E session negotiation', () => {
  it('runs the negotiation the s3270 capture shows, byte for byte', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    expect(conn.writes).toEqual([
      [T.IAC, T.WILL, O.TN3270E],
      [T.IAC, T.SB, O.TN3270E, Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST,
        ...ascii('IBM-3278-2-E'), T.IAC, T.SE],
      [T.IAC, T.SB, O.TN3270E, Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST,
        Tn3270eFunc.BIND_IMAGE, Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ,
        Tn3270eFunc.CONTENTION_RESOLUTION, T.IAC, T.SE],
    ]);
  });

  it('requests the LU it was given', async () => {
    const { session, conn } = newSession({ lus: ['MYLU01'] });
    await session.connect('127.0.0.1', 992);
    conn.host(T.IAC, T.DO, O.TN3270E);
    conn.clear();
    conn.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    expect(conn.writes[0]).toEqual([
      T.IAC, T.SB, O.TN3270E, Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST,
      ...ascii('IBM-3278-2-E'), Tn3270eOp.CONNECT, ...ascii('MYLU01'), T.IAC, T.SE,
    ]);
  });

  it('reaches 3270 mode with NO binary or EOR negotiated', async () => {
    // The integration form of the RFC 2355 §4 gate. If is3270Mode() only knew the
    // classic route this would be false and every record below would be discarded.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    expect(session.is3270Mode()).toBe(true);
  });

  it('sends NOTHING after an acceptable FUNCTIONS IS', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.clear();
    conn.sb(Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES);
    expect(conn.writes).toEqual([]);
  });

  it('refuses TN3270E and stays usable when the host adds a function', async () => {
    // BIND-IMAGE moved into REQUESTED_FUNCTIONS this task, so it can no longer stand
    // in for "a function we never asked for" -- SCS-CTL-CODES (still unrequested,
    // still a printer function per RFC 2355 §7.2.2) takes its place here.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.host(T.IAC, T.DO, O.TN3270E);
    conn.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    conn.sb(Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'));
    conn.clear();
    conn.sb(Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.SCS_CTL_CODES);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
    // And the classic route still works on the same connection, which is the whole
    // point of backing off rather than failing.
    conn.negotiateClassic();
    expect(session.is3270Mode()).toBe(true);
  });

  it('backs off on a DEVICE-TYPE REJECT', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.host(T.IAC, T.DO, O.TN3270E);
    conn.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    conn.clear();
    conn.sb(Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REJECT, Tn3270eOp.REASON, 0x01);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
    expect(session.is3270Mode()).toBe(false);
  });

  it('never offers TN3270E when tn3270e is false', async () => {
    const { session, conn } = newSession({ tn3270e: false });
    await session.connect('127.0.0.1', 992);
    conn.host(T.IAC, T.DO, O.TN3270E);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
    expect(session.is3270Mode()).toBe(false);
  });
});

describe('TN3270E session data path', () => {
  it('strips the header and executes the 3270 data behind it', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(), 0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // EBCDIC 'A'
  });

  it('prepends a 3270-DATA header to outbound records', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sendAID(AID.ENTER);
    const rec = conn.writes.at(-1)!;
    expect(rec.slice(0, 5)).toEqual([0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(rec.slice(-2)).toEqual([T.IAC, T.EOR]);
    // The AID follows the header rather than leading the record.
    expect(rec[5]).toBe(0x7d);
  });

  it('sends NO header when TN3270E was never negotiated', async () => {
    // THE STRICT-ADDITION GUARD. A classic session must be byte-identical to what it
    // was before this stage, or every Hercules golden moves.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateClassic();
    conn.host(...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sendAID(AID.ENTER);
    // First byte is the AID, not a header.
    expect(conn.writes.at(-1)![0]).toBe(0x7d);
  });

  it('advances SEQ-NUMBER when RESPONSES was agreed', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();                       // grants RESPONSES
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    session.sendAID(AID.ENTER);
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)!.slice(0, 5)).toEqual([0x00, 0x00, 0x00, 0x00, 0x01]);
  });

  it('keeps SEQ-NUMBER at zero when RESPONSES was NOT agreed', async () => {
    // §8.1.4: "When the RESPONSES function is not agreed to, this field should always
    // be set to 0x0000 by the sender." So basic TN3270E must not count.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE([]);                     // basic TN3270E
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    session.sendAID(AID.ENTER);
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)!.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('DOUBLES a 0xff inside SEQ-NUMBER, per RFC 2355 §8.1.4', async () => {
    // "If either byte contains a 0xff, it should be doubled to 0xffff before sending
    // and stripped back to 0xff upon receipt; this is standard IAC escaping."
    // Because RESPONSES is agreed the counter advances, so 0x00ff arrives after 255
    // records -- reachable in a long session, not theoretical. A bare 0xff here
    // desynchronises the host's telnet parser mid-record, which presents as a hang
    // rather than an error.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    for (let i = 0; i < 255; i++) session.sendAID(AID.ENTER);
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)!.slice(0, 6)).toEqual([0x00, 0x00, 0x00, 0x00, 0xff, 0xff]);
  });

  it('traces and drops a data type it does not implement', async () => {
    // We now REQUEST the BIND-IMAGE function (this task), but this session's
    // negotiateE() only GRANTS RESPONSES and SYSREQ by default, so a BIND-IMAGE
    // record here is still unearned -- either way, until Task 8 wires up bind.ts,
    // the session does not implement this data type, and handing one to the 3270
    // executor would raise a program check the host never caused.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(Tn3270eDataType.BIND_IMAGE, 0, 0, 0, 0, 0x31, 0x01, T.IAC, T.EOR);
    expect(session.oia.toText()).not.toContain('PROG');
  });

  it('drops a record too short to hold a header', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    expect(() => conn.host(0x00, 0x00, T.IAC, T.EOR)).not.toThrow();
    expect(session.oia.toText()).not.toContain('PROG');
  });

  it('un-doubles an escaped 0xff in the inbound 3270 payload', async () => {
    // The header strip must happen AFTER the telnet layer has un-doubled, or the
    // offset is wrong for any record containing a 0xff. Field attribute 0xff is
    // unusual but legal.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(), 0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1,
      T.IAC, T.IAC, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // EBCDIC 'A'
  });
});

describe('the BIND gate', () => {
  /**
   * Task 8's four behaviours. `negotiateE([Tn3270eFunc.BIND_IMAGE, ...])` is what
   * puts a session behind the gate at all -- `bindImageGranted()` reads exactly this
   * grant list, and every OTHER describe block in this file negotiates WITHOUT
   * BIND_IMAGE (the default grant is `[RESPONSES, SYSREQ]`), which is why none of them
   * hit the gate and none needed to change for this task -- confirmed by running the
   * full suite unmodified before writing any of the tests below.
   */
  const GRANT_BIND_IMAGE = [Tn3270eFunc.BIND_IMAGE, Tn3270eFunc.RESPONSES];

  /**
   * Erase/Write, WCC, SBA(0,0), then EBCDIC 'A' as a DATA byte -- same shape as the
   * "strips the header and executes the 3270 data behind it" test above. NOT
   * WRITE_FIELD: that constant ends in an unprotected FIELD ATTRIBUTE at (0,0), which
   * leaves `cellAt(0)` at 0x00 even once executed, so it cannot discriminate "ran" from
   * "still gated" the way a painted character can.
   */
  const write3270 = (): number[] =>
    [...hdr(), 0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR];

  /**
   * A minimal BIND-IMAGE record: just enough for `decodeHeader` to see data type
   * BIND-IMAGE and dispatch to `handleBind`. `BIND_RU` (0x31) is the one byte
   * `parseBind` requires to recognize the RU at all; nothing past it is read by this
   * task's minimal `handleBind`, which does not yet call `parseBind` -- that is
   * Task 9's job. See the scope note in session.ts's `handleBind`.
   */
  const BIND_RU = 0x31;
  const bind = (): number[] =>
    [Tn3270eDataType.BIND_IMAGE, 0x00, 0x00, 0x00, 0x00, BIND_RU, T.IAC, T.EOR];

  it('retains, rather than drops, a 3270-DATA record that arrives before any BIND', async () => {
    const { session, conn } = newSession();
    session.trace.setEnabled(true);
    await session.connect('127.0.0.1', 992);
    conn.negotiateE(GRANT_BIND_IMAGE);
    conn.host(...write3270());
    // Not executed: the screen the record would have painted must still be blank.
    expect(session.screen.cellAt(0).ebcdic).toBe(0x00);
    // RETAINED, NOT SILENTLY DROPPED -- the distinction the task exists to make.
    // x3270's `return 0` at telnet.c:2681 leaves no trace at all; ours must say so,
    // both because the operator deserves to know why the screen went quiet and
    // because "observable" is how a later task can tell retention happened without
    // reaching into a private field.
    expect(session.trace.toText()).toContain('3270 data before BIND, retained');
  });

  it('executes the retained record once the BIND arrives', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE(GRANT_BIND_IMAGE);
    conn.host(...write3270());
    expect(session.screen.cellAt(0).ebcdic).toBe(0x00);   // premise: still gated
    conn.host(...bind());
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // EBCDIC 'A', from write3270()
  });

  it('keeps only the MOST RECENT pre-BIND record, not a queue of every one', async () => {
    // Two records painting different things before the BIND arrives: a host that
    // painted twice has overwritten its own first screen, so the second one's content
    // must be what the BIND releases -- not the first, and not both.
    const writeOther = (): number[] => [
      ...hdr(), 0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc2, T.IAC, T.EOR,   // EBCDIC 'B' at (0,0)
    ];
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE(GRANT_BIND_IMAGE);
    conn.host(...write3270());     // paints 'A' -- withheld
    conn.host(...writeOther());    // paints 'B' -- withheld, and supersedes 'A'
    conn.host(...bind());
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc2);   // 'B', not 'A'
  });

  it('does NOT gate 3270 data when BIND-IMAGE was not granted', async () => {
    // The default grant (RESPONSES, SYSREQ) is exactly what every other test in this
    // file already negotiates, and this is the severity check: breaking this would
    // silently withhold data from every ordinary TN3270E session in the suite.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();              // no BIND_IMAGE in the grant
    conn.host(...write3270());
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // executed immediately
  });
});

describe('TN3270E state across connections', () => {
  /**
   * `this.e` is cleared only on the REJECT backoff path, so without a reset in
   * connect() a SECOND connection to a host that never mentions option 40 still has
   * `inTn3270e()` true. Both directions then corrupt: decodeHeader eats the first
   * five bytes of every inbound record, and sendAID prepends a header the host reads
   * as 3270 data.
   *
   * Reachable from the CLI as a matter of course — two `Connect()` actions in one
   * script is its normal mode of operation, and the roadmap's per-host `N:` makes
   * "TN3270E host then plain host" an ordinary sequence rather than a contrived one.
   */
  const reconnectToPlainHost = async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    // Guard the premise: if the first connection did not reach TN3270E there is no
    // stale state to leak and the test proves nothing.
    expect(session.is3270Mode()).toBe(true);

    session.disconnect();
    await session.connect('127.0.0.1', 3270);
    conn.negotiateClassic();
    return { session, conn };
  };

  it('strips no header from the next host that never offered TN3270E', async () => {
    const { session, conn } = await reconnectToPlainHost();
    conn.host(0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // EBCDIC 'A'
    expect(session.oia.toText()).not.toContain('PROG');
  });

  it('sends no header to the next host either', async () => {
    // The worse half of the same bug: five bytes the plain host parses as 3270 data.
    const { session, conn } = await reconnectToPlainHost();
    conn.host(...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)![0]).toBe(0x7d);            // the AID, not a header
  });

  it('clears it on a connect that REPLACES a live connection', async () => {
    // The path with no explicit Disconnect: connect() tears the old one down itself
    // (session.ts, "Tear down any live connection first"). This is what makes one
    // reset site sufficient — both routes reach handleClose — so it is pinned rather
    // than assumed. `Connect()` twice with no `Disconnect()` between is legal s3270.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    expect(session.is3270Mode()).toBe(true);

    await session.connect('127.0.0.1', 3270);   // no disconnect() call
    conn.negotiateClassic();
    conn.host(0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);
  });
});

describe('TN3270E withdrawn mid-session', () => {
  /**
   * `IAC DONT TN3270E` AFTER THE NEGOTIATION COMPLETED — THE SAME BUG ONE LAYER UP.
   *
   * RFC 854 lets either party withdraw an option whenever it likes, and this one does not
   * close the connection: `handleClose`, the one place `Session.e` was reliably cleared,
   * never runs. So without the telnet layer telling us, `inTn3270e()` stayed true on a
   * host that had stopped speaking TN3270E, and both directions corrupt exactly as they
   * did across connections — five bytes eaten off each inbound record, five prepended to
   * each outbound one.
   *
   * Not contrived: a real z/VM 4.4 answers our `IAC WILL TN3270E` with `IAC DONT
   * TN3270E` and then carries on as a plain TN3270 host, measured 2026-09-17
   * (docs/live-testing.md). Only the timing differed — its DONT arrived before the
   * negotiation completed.
   */
  const withdrawMidSession = async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    // Guard the premise: with no completed negotiation there is no stale state to leak
    // and the test below proves nothing.
    expect(session.is3270Mode()).toBe(true);
    conn.host(T.IAC, T.DONT, O.TN3270E);
    // ...and the host carries on as a plain TN3270 host, which is what z/VM did next.
    conn.negotiateClassic();
    expect(session.is3270Mode()).toBe(true);
    return { session, conn };
  };

  it('answers the withdrawal with WONT and drops out of 3270 mode', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    expect(session.is3270Mode()).toBe(true);
    conn.clear();
    conn.host(T.IAC, T.DONT, O.TN3270E);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
    // Nothing here negotiated BINARY or EOR — RFC 2355 §4 implied them — so the session
    // must fall all the way out of 3270 mode rather than keep the short-circuit.
    expect(session.is3270Mode()).toBe(false);
  });

  it('strips no header from a host that has stopped speaking TN3270E', async () => {
    const { session, conn } = await withdrawMidSession();
    conn.host(0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // EBCDIC 'A'
    expect(session.oia.toText()).not.toContain('PROG');
  });

  it('sends no header to it either', async () => {
    // The worse half, again: five bytes the plain host parses as 3270 data.
    const { session, conn } = await withdrawMidSession();
    conn.host(...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)![0]).toBe(0x7d);            // the AID, not a header
  });

  it('keeps the negotiation when the host withdraws some OTHER option', async () => {
    // The transposition guard at session level: TERMINAL-TYPE goes away and TN3270E
    // framing must not.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.DONT, O.TERMINAL_TYPE);
    expect(session.is3270Mode()).toBe(true);
    conn.host(...hdr(), 0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);   // header still stripped
  });
});

describe('per-connection TN3270E settings', () => {
  /**
   * s3270's `N:` and `LU@` are properties of a HOST, not of a process — they sit in
   * the host argument, and `Connect()` can name a different host every time. The CLI
   * has no host argument at all, so without this the only way to reach an LU list was
   * to construct a `Session` by hand, and `Connect(N:host)` could not be honoured.
   */
  it('lets one connection decline TN3270E on a session that offers it', async () => {
    const { session, conn } = newSession();          // default: tn3270e on
    await session.connect('127.0.0.1', 3270, { tn3270e: false });
    conn.host(T.IAC, T.DO, O.TN3270E);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
  });

  it('lets one connection name its own LU list', async () => {
    const { session, conn } = newSession({ lus: ['SESSLU'] });
    await session.connect('127.0.0.1', 992, { lus: ['CONNLU'] });
    conn.host(T.IAC, T.DO, O.TN3270E);
    conn.clear();
    conn.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    expect(conn.writes[0]).toEqual([
      T.IAC, T.SB, O.TN3270E, Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST,
      ...ascii('IBM-3278-2-E'), Tn3270eOp.CONNECT, ...ascii('CONNLU'), T.IAC, T.SE,
    ]);
  });

  it('does NOT leak a per-connection setting into the next connection', async () => {
    // The same failure class as the stale-`e` bug above: a setting that outlives the
    // connection it was given for. A script that connects to a plain host with N: and
    // then to a TN3270E host must get TN3270E on the second one.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 3270, { tn3270e: false });
    conn.host(T.IAC, T.DO, O.TN3270E);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);

    await session.connect('127.0.0.1', 992);         // no per-connection options
    conn.clear();
    conn.negotiateE();
    expect(session.is3270Mode()).toBe(true);
  });

  it('falls back to the session default when the connection says nothing', async () => {
    const { session, conn } = newSession({ tn3270e: false, lus: ['SESSLU'] });
    await session.connect('127.0.0.1', 3270, {});
    conn.host(T.IAC, T.DO, O.TN3270E);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);
  });

  /**
   * `reconnect()` REPLAYS THE ConnectOptions TOO, AND THAT IS NOT SYMMETRY FOR ITS OWN SAKE.
   *
   * `N:` and `LU@` are written in the HOST ARGUMENT, so they are part of the answer to "which host
   * is this session for" -- which is exactly what the remembered target is. Replaying the host and
   * port ALONE would silently reconnect with TN3270E back on to a host the operator spelled `N:`,
   * and the symptom is not an error: the host offers option 40, we accept where the operator said
   * not to, and a session that worked before the reconnect is negotiated differently after it.
   *
   * The wire is what is asserted, not a stored field: `WONT TN3270E` on the SECOND connection is
   * only reachable if `per.tn3270e === false` came back with the target, and the two-connection
   * shape is the one `does NOT leak a per-connection setting` above uses in the other direction.
   * Both tests are needed -- one pins that the options are forgotten by a NEW `connect()`, the other
   * that they are remembered by a `reconnect()`.
   */
  it('replays a per-connection N: on reconnect, rather than losing it', async () => {
    const { session, conn } = newSession();          // session default: TN3270E on
    await session.connect('127.0.0.1', 3270, { tn3270e: false });
    conn.host(T.IAC, T.DO, O.TN3270E);
    expect(conn.writes).toEqual([[T.IAC, T.WONT, O.TN3270E]]);

    conn.close();                                    // the host hangs up
    conn.clear();
    conn.closed = false;
    await session.reconnect();
    conn.host(T.IAC, T.DO, O.TN3270E);
    expect(conn.writes, 'the reconnect forgot the N: it was connected with')
      .toEqual([[T.IAC, T.WONT, O.TN3270E]]);
  });

  it('replays a per-connection LU list on reconnect', async () => {
    // The other half of `ConnectOptions`, and the one with a name on the wire to assert: `CONNLU`
    // over the session's own `SESSLU`. A reconnect that dropped `per.lus` would fall back to the
    // session default and request the WRONG LU -- which a host may well grant, so the failure is a
    // session on someone else's terminal rather than an error.
    const { session, conn } = newSession({ lus: ['SESSLU'] });
    await session.connect('127.0.0.1', 992, { lus: ['CONNLU'] });
    conn.close();
    conn.clear();
    conn.closed = false;
    await session.reconnect();
    conn.host(T.IAC, T.DO, O.TN3270E);
    conn.clear();
    conn.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    expect(conn.writes[0]).toEqual([
      T.IAC, T.SB, O.TN3270E, Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST,
      ...ascii('IBM-3278-2-E'), Tn3270eOp.CONNECT, ...ascii('CONNLU'), T.IAC, T.SE,
    ]);
  });
});

describe('TN3270E RESPONSES', () => {
  /** Erase/Write with a header carrying the given response flag and sequence. */
  const write = (flag: number, seq: number): number[] => [
    ...hdr(flag, seq), 0xf5, 0xc3, 0x11, 0x40, 0x40, 0xc1, T.IAC, T.EOR,
  ];

  it('answers ALWAYS-RESPONSE positively, carrying the SAME sequence back', async () => {
    // Measured from real s3270 in harness config F: it replied 02 00 00 00 00 00 --
    // RESPONSE, POSITIVE, the seq copied from the message answered, one 0x00 byte.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.clear();
    conn.host(...write(Tn3270eResponseFlag.ALWAYS_RESPONSE, 0x0042));
    expect(conn.writes).toEqual([[
      Tn3270eDataType.RESPONSE, 0x00, Tn3270eResponseFlag.POSITIVE_RESPONSE,
      0x00, 0x42, Tn3270eSense.DEVICE_END, T.IAC, T.EOR,
    ]]);
  });

  it('says nothing for NO-RESPONSE', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.clear();
    conn.host(...write(Tn3270eResponseFlag.NO_RESPONSE, 7));
    expect(conn.writes).toEqual([]);
  });

  it('says nothing for ERROR-RESPONSE when nothing went wrong', async () => {
    // §10.4.1: a response is due only if an error occurred. Answering anyway would
    // put a message on the wire the host is not waiting for.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.clear();
    conn.host(...write(Tn3270eResponseFlag.ERROR_RESPONSE, 7));
    expect(conn.writes).toEqual([]);
  });

  it('answers a bad buffer address with NEGATIVE and OP-CHECK', async () => {
    // SBA past the end of the buffer: "an illegal 3270 buffer address or order
    // sequence was received", RFC 2355's 0x02.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.clear();
    conn.host(...hdr(Tn3270eResponseFlag.ERROR_RESPONSE, 0x0009),
      0xf5, 0xc3, 0x11, 0x7f, 0x7f, T.IAC, T.EOR);
    expect(conn.writes).toEqual([[
      Tn3270eDataType.RESPONSE, 0x00, Tn3270eResponseFlag.NEGATIVE_RESPONSE,
      0x00, 0x09, Tn3270eSense.OP_CHECK, T.IAC, T.EOR,
    ]]);
  });

  it('answers an invalid command with NEGATIVE and COMMAND-REJECT', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.clear();
    conn.host(...hdr(Tn3270eResponseFlag.ALWAYS_RESPONSE, 0x000a), 0x99, T.IAC, T.EOR);
    expect(conn.writes.at(-1)!.slice(0, 6)).toEqual([
      Tn3270eDataType.RESPONSE, 0x00, Tn3270eResponseFlag.NEGATIVE_RESPONSE,
      0x00, 0x0a, Tn3270eSense.COMMAND_REJECT,
    ]);
  });

  it('still raises the program check as well as answering', async () => {
    // The response goes to the host; the program check goes to the operator. Both,
    // not either -- a silent negative response would leave an operator staring at a
    // screen that never updated with no indication why.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(Tn3270eResponseFlag.ALWAYS_RESPONSE, 1), 0x99, T.IAC, T.EOR);
    expect(session.oia.toText()).toContain('PROG');
  });

  it('sends no response at all when RESPONSES was not agreed', async () => {
    // A server asking for a response on a session where the function was never
    // agreed is out of spec; answering would put a message on the wire it has no
    // parser for.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE([]);                       // basic TN3270E
    conn.clear();
    conn.host(...write(Tn3270eResponseFlag.ALWAYS_RESPONSE, 5));
    expect(conn.writes).toEqual([]);
  });

  it('does not let a response consume an outbound sequence number', async () => {
    // A RESPONSE copies the inbound seq and must not spend one of ours, or our
    // numbering drifts out of step with what the host is acknowledging.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...write(Tn3270eResponseFlag.ALWAYS_RESPONSE, 0x0100));
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)!.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('TN3270E SYSREQ', () => {
  it('sends IAC AO when SYSREQ was agreed', async () => {
    // RFC 2355 §11 and x3270 telnet.c:3636. SYSREQ is a Telnet command, not an AID,
    // so it carries no TN3270E header and no IAC EOR.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();                        // grants SYSREQ
    conn.clear();
    session.sysreq();
    expect(conn.writes).toEqual([[T.IAC, T.AO]]);
  });

  it('sends nothing when SYSREQ was negotiated away', async () => {
    // A deliberate no-op rather than an error: the key exists on the keyboard whatever
    // the host granted, and pressing it on a session without the function is not the
    // operator's mistake. Sending IAC AO anyway would put a command on the wire the host
    // has no handler for.
    //
    // AND NOT THE TEST REQUEST EITHER, even though nothing else goes out. x3270 splits on
    // `IN_E`, not on the function bit: an E session takes net_abort(), which then checks
    // the bit itself and does nothing (telnet.c:3632-3648). The classic test request is
    // reached only through the `else` branch (kybd.c:2853-2865). A host that negotiated
    // TN3270E and declined SYSREQ has said what it wants; SOH % / STX is not a fallback
    // it asked for.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE([Tn3270eFunc.RESPONSES]);  // no SYSREQ
    conn.clear();
    session.sysreq();
    expect(conn.writes).toEqual([]);
  });

  it('sends the classic test request on a session that never saw TN3270E', async () => {
    // THE PATH BOTH OF THIS PROJECT'S LIVE HOSTS TAKE: VM/370 CE and MVS 3.8j TK5 each
    // answer `IAC WILL TN3270E` with DONT. x3270's `else` branch calls
    // key_AID(AID_SYSREQ) (kybd.c:2864), and ctlr_read_modified turns that AID into the
    // four-byte test request heading rather than transmitting it (ctlr.c:770-777).
    //
    // The host write is required, not decoration: it releases the connect-time keyboard
    // lock, and Sys Req refuses on an inhibited keyboard. See session.test.ts.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateClassic();
    conn.host(...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sysreq();
    expect(conn.writes).toEqual([[0x01, 0x6c, 0x61, 0x02, T.IAC, T.EOR]]);
  });

  it('sends IAC AO and NOT the test request when the function was agreed', async () => {
    // The strict separation: the E path must not have quietly become the classic path.
    // Same call as the classic test above, different bytes, and neither assertion could
    // pass against the other's session.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    conn.clear();
    session.sysreq();
    expect(conn.writes).toEqual([[T.IAC, T.AO]]);
    expect(conn.sent).not.toContain(0x6c);
  });

  it('does not disturb the outbound sequence counter', async () => {
    // SYSREQ is not a data message, so it must not spend a sequence number.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE();
    conn.host(...hdr(), ...WRITE_FIELD, T.IAC, T.EOR);
    session.sysreq();
    conn.clear();
    session.sendAID(AID.ENTER);
    expect(conn.writes.at(-1)!.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
  });
});
