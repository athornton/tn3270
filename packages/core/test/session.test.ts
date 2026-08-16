import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection } from '../src/session.js';
import { TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, SnaCmd, Order, AID, FA } from '../src/constants.js';
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

function newSession() {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn });
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
});
