import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionEvent, type SessionOptions } from '../src/session.js';
import { TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, Cmd, SnaCmd } from '../src/constants.js';
import { OversizeError, type GeometrySetting, type Size } from '../src/geometry.js';
import { TerminalTypeError } from '../src/termtype.js';

/**
 * Session-level oversize: the geometry setting resolved at every connect (Task 2 of the
 * oversize plan; spec docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md).
 * Wire behaviour beyond the terminal type -- TN3270E device type, Query Reply, BIND 0x03,
 * UNBIND -- is Task 3's.
 */

/** An in-memory connection that records what the session sends. Copied from session.test.ts. */
class FakeConnection implements Connection {
  sent: number[] = [];
  closed = false;
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.closed = true; this.onClose?.(); }

  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }

  /** Negotiate into 3270 mode, keeping what we sent so the terminal type can be read back. */
  negotiate(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
  }
}

/** The ASCII name from the session's TERMINAL-TYPE IS subnegotiation. From session.test.ts. */
function negotiatedName(conn: FakeConnection): string {
  const start = conn.sent.findIndex((b, i) =>
    b === T.IAC && conn.sent[i + 1] === T.SB
    && conn.sent[i + 2] === O.TERMINAL_TYPE && conn.sent[i + 3] === S.IS);
  expect(start, 'no TERMINAL-TYPE IS was sent').toBeGreaterThanOrEqual(0);
  const nameStart = start + 4;
  const end = conn.sent.indexOf(T.SE, nameStart);
  return String.fromCharCode(...conn.sent.slice(nameStart, end - 1));
}

/** A session whose every connect hands out a FRESH FakeConnection, the latest in `conns`. */
function newSession(geometry: GeometrySetting, extra: Partial<SessionOptions> = {}) {
  const conns: FakeConnection[] = [];
  const connect = vi.fn(() => { const c = new FakeConnection(); conns.push(c); return c; });
  const session = new Session({ connect, geometry, ...extra });
  const last = (): FakeConnection => conns[conns.length - 1]!;
  return { session, connect, last };
}

const FIXED_62x160: GeometrySetting = { model: '3278-2-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } };

describe('Session geometry: a fixed oversize', () => {
  it('advertises IBM-DYNAMIC, starts at 24x80 and offers 62x160 as the alternate', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiate();
    expect(negotiatedName(last())).toBe('IBM-DYNAMIC');
    expect({ rows: session.screen.rows, cols: session.screen.cols }).toEqual({ rows: 24, cols: 80 });
    expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
  });

  it('Erase/Write Alternate switches to the oversize, and its far cells are addressable', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiate();
    last().host(Cmd.EWA, 0x00, T.IAC, T.EOR);
    expect({ rows: session.screen.rows, cols: session.screen.cols }).toEqual({ rows: 62, cols: 160 });
    expect(() => session.screen.setChar(9000, 0xc1)).not.toThrow();
  });

  it('a resolve that throws at connect() opens no socket and leaves no target', async () => {
    // Since the constructor and setGeometry both validate, a FIXED setting can no longer reach
    // connect() invalid; the throw left at connect time is the front end's own measure.
    const { session, connect } = newSession({ oversize: { kind: 'auto' } }, {
      measure: () => { throw new Error('font atlas not loaded'); },
    });
    await expect(session.connect('h', 23)).rejects.toThrow(/font atlas not loaded/);
    expect(connect).not.toHaveBeenCalled();
    await expect(session.reconnect()).rejects.toThrow(/No previous host/);
  });
});

describe('Session geometry: auto', () => {
  it('measures at each connect, never at construction', async () => {
    let size: Size = { rows: 40, cols: 100 };
    const measure = vi.fn(() => size);
    const { session, last } = newSession({ oversize: { kind: 'auto' } }, { measure });
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
    expect(measure).not.toHaveBeenCalled();
    await session.connect('h', 23);
    expect(session.screen.alternateSize).toEqual({ rows: 40, cols: 100 });
    last().close();
    size = { rows: 50, cols: 132 };
    await session.reconnect();
    expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 });
  });

  it('a window smaller than the model falls back, with a notice in the getter and the trace', async () => {
    const { session } = newSession({ oversize: { kind: 'auto' } }, { measure: () => ({ rows: 20, cols: 80 }) });
    session.trace.setEnabled(true);
    const onGeometry = vi.fn();
    session.on('geometry', onGeometry);
    await session.connect('h', 23);
    expect(onGeometry).toHaveBeenCalledTimes(1);
    expect(session.lastGeometryNotice).toMatch(/using the model/);
    expect(session.trace.toText()).toContain(session.lastGeometryNotice!);
  });
});

describe('Session.setGeometry', () => {
  it('refuses while connected, and applies at the next connect', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    expect(() => session.setGeometry({ model: '3278-4-E', oversize: { kind: 'none' } }))
      .toThrow(/^disconnect first/);
    last().close();
    session.setGeometry({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(session.geometrySetting).toEqual({ model: '3278-4-E', oversize: { kind: 'none' } });
    await session.reconnect();
    last().negotiate();
    expect(negotiatedName(last())).toBe('IBM-3278-4-E');
    last().host(Cmd.EWA, 0x00, T.IAC, T.EOR);
    expect({ rows: session.screen.rows, cols: session.screen.cols }).toEqual({ rows: 43, cols: 80 });
  });

  it('a reconnect at UNCHANGED geometry leaves the screen as it was', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiate();
    last().host(SnaCmd.EW, 0xc3, 0xc1, T.IAC, T.EOR);
    expect(session.screen.cellAt(0)).toMatchObject({ ebcdic: 0xc1 });
    last().close();
    await session.reconnect();
    expect(session.screen.cellAt(0)).toMatchObject({ ebcdic: 0xc1 });
  });

  it('a reconnect at CHANGED geometry clears the screen', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiate();
    last().host(SnaCmd.EW, 0xc3, 0xc1, T.IAC, T.EOR);
    last().close();
    session.setGeometry({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 50, cols: 100 } });
    await session.reconnect();
    expect(session.screen.cellAt(0)).toMatchObject({ ebcdic: 0x00 });
    expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 100 });
  });

  it('an unknown model is refused at set time', () => {
    const { session } = newSession(FIXED_62x160);
    expect(() => session.setGeometry({ model: '3278-9', oversize: { kind: 'none' } }))
      .toThrow(TerminalTypeError);
  });

  it('auto is accepted at set time without measuring, when the session can measure', () => {
    const measure = vi.fn(() => ({ rows: 40, cols: 100 }));
    const { session } = newSession(FIXED_62x160, { measure });
    session.setGeometry({ oversize: { kind: 'auto' } });
    expect(measure).not.toHaveBeenCalled();
    expect(session.geometrySetting).toEqual({ oversize: { kind: 'auto' } });
  });

  it('auto is refused at set time when the session has nothing to measure', () => {
    const { session } = newSession(FIXED_62x160);
    expect(() => session.setGeometry({ oversize: { kind: 'auto' } }))
      .toThrow(/oversize auto needs a window to measure/);
  });
});

describe('Session construction in geometry mode', () => {
  it('refuses geometry together with the legacy terminalType option', () => {
    expect(() => new Session({
      connect: () => new FakeConnection(), geometry: FIXED_62x160, terminalType: 'IBM-3278-2-E',
    })).toThrow(/geometry/);
  });

  it('throws TerminalTypeError for an unknown model', () => {
    expect(() => new Session({ connect: () => new FakeConnection(), geometry: { model: '3278-9', oversize: { kind: 'none' } } }))
      .toThrow(TerminalTypeError);
  });
});

describe('Session geometry: review fixes', () => {
  it('setGeometry refuses auto on a non-extended model at set time, without measuring', () => {
    const measure = vi.fn(() => ({ rows: 40, cols: 100 }));
    const { session } = newSession(FIXED_62x160, { measure });
    expect(() => session.setGeometry({ model: '3278-2', oversize: { kind: 'auto' } }))
      .toThrow(/oversize needs an extended model/);
    expect(measure).not.toHaveBeenCalled();
    expect(session.geometrySetting).toBe(FIXED_62x160);
  });

  it('setGeometry refuses auto with a raw terminalType at set time, without measuring', () => {
    const measure = vi.fn(() => ({ rows: 40, cols: 100 }));
    const { session } = newSession(FIXED_62x160, { measure });
    expect(() => session.setGeometry({ terminalType: 'IBM-3278-2-E', oversize: { kind: 'auto' } }))
      .toThrow(/cannot both be given/);
    expect(measure).not.toHaveBeenCalled();
  });

  it('connect() while connected tears the old connection down BEFORE the geometry changes', async () => {
    let size: Size = { rows: 40, cols: 100 };
    const { session } = newSession({ oversize: { kind: 'auto' } }, { measure: () => size });
    await session.connect('h', 23);
    const seen: string[] = [];
    for (const ev of ['disconnect', 'screen', 'geometry', 'connect'] as SessionEvent[]) {
      session.on(ev, () => seen.push(`${ev}:${session.isConnected()}`));
    }
    size = { rows: 50, cols: 132 };
    await session.connect('h', 23);
    expect(seen).toEqual(['disconnect:false', 'screen:false', 'geometry:false', 'connect:true']);
  });

  it('a change of terminal type alone, at the same alternate, still counts as a change', async () => {
    const { session, last } = newSession({ model: '3278-2-E', oversize: { kind: 'none' } });
    await session.connect('h', 23);
    last().close();
    // 24x80 on a model 2 is legal (equal to the model) and is still advertised as IBM-DYNAMIC.
    session.setGeometry({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 24, cols: 80 } });
    await session.reconnect();
    last().negotiate();
    expect(negotiatedName(last())).toBe('IBM-DYNAMIC');
  });

  it('setGeometry is refused while a reconnect() is in flight', async () => {
    let release: ((c: Connection) => void) | undefined;
    let deferred = false;
    const session = new Session({
      connect: () => deferred
        ? new Promise<Connection>((r) => { release = r; })
        : new FakeConnection(),
      geometry: FIXED_62x160,
    });
    await session.connect('h', 23);
    session.disconnect();
    deferred = true;
    const pending = session.reconnect();
    expect(() => session.setGeometry({ model: '3278-4-E', oversize: { kind: 'none' } }))
      .toThrow(/^disconnect first/);
    release!(new FakeConnection());
    await pending;
  });

  it('a later connect with no notice clears lastGeometryNotice', async () => {
    let size: Size = { rows: 20, cols: 80 };
    const { session, last } = newSession({ oversize: { kind: 'auto' } }, { measure: () => size });
    await session.connect('h', 23);
    expect(session.lastGeometryNotice).toMatch(/using the model/);
    last().close();
    size = { rows: 40, cols: 100 };
    await session.reconnect();
    expect(session.lastGeometryNotice).toBeUndefined();
  });

  it("emits 'screen' at connect when the geometry changed, and not when it did not", async () => {
    const { session, last } = newSession(FIXED_62x160);
    const onScreen = vi.fn();
    session.on('screen', onScreen);
    await session.connect('h', 23); // model 2 at construction -> 62x160: changed
    expect(onScreen).toHaveBeenCalledTimes(1);
    last().close();
    await session.reconnect(); // unchanged
    expect(onScreen).toHaveBeenCalledTimes(1);
  });

  it('writes an auto clamp to the trace', async () => {
    const { session } = newSession({ oversize: { kind: 'auto' } }, { measure: () => ({ rows: 100, cols: 200 }) });
    session.trace.setEnabled(true);
    await session.connect('h', 23);
    expect(session.trace.toText()).toContain('the 14-bit address limit');
    expect(session.screen.alternateSize).toEqual({ rows: 81, cols: 200 });
  });

  it('the constructor refuses an invalid fixed oversize at construction', () => {
    expect(() => new Session({
      connect: () => new FakeConnection(),
      geometry: { model: '3278-4-E', oversize: { kind: 'fixed', rows: 30, cols: 80 } },
    })).toThrow(OversizeError);
    expect(() => new Session({
      connect: () => new FakeConnection(),
      geometry: { model: '3278-4-E', oversize: { kind: 'fixed', rows: 30, cols: 80 } },
    })).toThrow(/use at least 80x43/);
  });
});
