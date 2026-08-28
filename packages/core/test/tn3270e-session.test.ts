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
        Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ, Tn3270eFunc.CONTENTION_RESOLUTION,
        T.IAC, T.SE],
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
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.host(T.IAC, T.DO, O.TN3270E);
    conn.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    conn.sb(Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'));
    conn.clear();
    conn.sb(Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.BIND_IMAGE);
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
    // BIND-IMAGE should never arrive, since we do not request the function -- but a
    // non-conforming server could send one, and handing a bind image to the 3270
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
    // A deliberate no-op rather than an error: the key exists on the keyboard
    // whatever the host granted, and pressing it on a session without the function
    // is not the operator's mistake. Sending IAC AO anyway would put a command on
    // the wire the host has no handler for.
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateE([Tn3270eFunc.RESPONSES]);  // no SYSREQ
    conn.clear();
    session.sysreq();
    expect(conn.writes).toEqual([]);
  });

  it('sends nothing on a classic session that never saw TN3270E', async () => {
    const { session, conn } = newSession();
    await session.connect('127.0.0.1', 992);
    conn.negotiateClassic();
    conn.clear();
    session.sysreq();
    expect(conn.writes).toEqual([]);
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
