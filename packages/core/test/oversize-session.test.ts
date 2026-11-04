import { describe, it, expect, vi } from 'vitest';
import { Session, type Connection, type SessionEvent, type SessionOptions } from '../src/session.js';
import {
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, Cmd, SnaCmd, AID,
  Tn3270eOp, Tn3270eFunc, Tn3270eDataType, Qcode,
} from '../src/constants.js';
import { OversizeError, type GeometrySetting, type Size } from '../src/geometry.js';
import { TerminalTypeError } from '../src/termtype.js';
import { BIND_RU, BIND_OFF } from '../src/bind.js';

/**
 * Session-level oversize: the geometry setting resolved at every connect (Task 2 of the
 * oversize plan; spec docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md).
 * Wire behaviour beyond the terminal type -- TN3270E device type, Query Reply, BIND 0x03,
 * UNBIND -- is Task 3's.
 */

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

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

  /** A TN3270E subnegotiation body, framed. From tn3270e-session.test.ts. */
  sb(...body: number[]): void { this.host(T.IAC, T.SB, O.TN3270E, ...body, T.IAC, T.SE); }

  /**
   * The TN3270E route: DO TN3270E, then the three-way DEVICE-TYPE/FUNCTIONS exchange,
   * granting `grant`. Copied from tn3270e-session.test.ts's `negotiateE`, with the
   * device type hardcoded to IBM-3278-2-E there -- this one reads back whatever this
   * session actually requested, so it works under IBM-DYNAMIC too.
   */
  negotiateE(grant: number[] = [Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ]): void {
    const reqStart = this.sent.length;
    this.host(T.IAC, T.DO, O.TN3270E);
    this.sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    // Read the DEVICE-TYPE REQUEST we just sent back off the wire, so the IS we answer
    // with always names what was actually requested rather than a hardcoded guess.
    const reqIdx = this.sent.findIndex((b, i) =>
      i >= reqStart && b === Tn3270eOp.DEVICE_TYPE && this.sent[i + 1] === Tn3270eOp.REQUEST);
    const seStart = this.sent.indexOf(T.SE, reqIdx);
    const ttype = String.fromCharCode(...this.sent.slice(reqIdx + 2, seStart - 1));
    this.sb(Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii(ttype),
      Tn3270eOp.CONNECT, ...ascii('TESTLU01'));
    this.sb(Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, ...grant);
  }
}

/** A BIND-IMAGE TN3270E record carrying `body`, framed with a header and IAC EOR. From tn3270e-session.test.ts. */
const bindRecord = (body: number[]): number[] =>
  [Tn3270eDataType.BIND_IMAGE, 0x00, 0x00, 0x00, 0x00, ...body, T.IAC, T.EOR];

/** An UNBIND TN3270E record. From tn3270e-session.test.ts. */
const unbindRecord = (reason?: number): number[] =>
  [Tn3270eDataType.UNBIND, 0x00, 0x00, 0x00, 0x00,
    ...(reason === undefined ? [] : [reason]), T.IAC, T.EOR];

/**
 * A 28-byte BIND RU body with the given size code and dims, no PLU name. From
 * tn3270e-session.test.ts.
 */
const bindBody = (ssize: number, rd = 0, cd = 0, ra = 0, ca = 0): number[] => {
  const b = new Uint8Array(28);
  b[0] = BIND_RU;
  b[BIND_OFF.RD] = rd; b[BIND_OFF.CD] = cd;
  b[BIND_OFF.RA] = ra; b[BIND_OFF.CA] = ca;
  b[BIND_OFF.SSIZE] = ssize;
  return [...b];
};

/** BIND-IMAGE and RESPONSES, so a BIND is owed and the gate opens. From tn3270e-session.test.ts. */
const GRANT_BIND_IMAGE = [Tn3270eFunc.BIND_IMAGE, Tn3270eFunc.RESPONSES];

/**
 * The 3270 record the session sent, unwrapped from telnet framing. From
 * session.test.ts's `lastRecord`. Every call site here is on a connection that is
 * NOT in TN3270E mode (classic `negotiate()`), so there is no 5-byte header to strip
 * -- unlike tn3270e-session.test.ts's own helpers, which do need that.
 */
function lastRecord(conn: FakeConnection): number[] {
  const end = conn.sent.length - 2; // drop the trailing IAC EOR
  expect(conn.sent.slice(end)).toEqual([T.IAC, T.EOR]);
  return conn.sent.slice(0, end);
}

/** WSF carrying Read Partition: L=5 SFID=01 PID=ff TYPE=02. From session.test.ts; see its comment on IAC doubling. */
const QUERY = [SnaCmd.WSF, 0x00, 0x05, 0x01, T.IAC, T.IAC, 0x02] as const;

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

/**
 * Task 3: the wire needs NO new code once Task 2's resolved terminal type and
 * `modelAlternate` are in place. These tests DRIVE that claim rather than read it off
 * the spec -- see the project's "plan claims need driving, not reading" note.
 */
describe('Session wire: TN3270E device type', () => {
  it('DEVICE-TYPE REQUEST carries IBM-DYNAMIC for a fixed oversize', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().host(T.IAC, T.DO, O.TN3270E);
    // Only WILL TN3270E so far -- SEND DEVICE-TYPE below is the HOST'S move, not ours;
    // mirrors tn3270e-session.test.ts ~:68-78's own split of the exchange.
    expect(last().sent).toEqual([T.IAC, T.WILL, O.TN3270E]);
    last().sent = [];
    last().sb(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE);
    expect(last().sent).toEqual([
      T.IAC, T.SB, O.TN3270E, Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST,
      ...ascii('IBM-DYNAMIC'), T.IAC, T.SE,
    ]);
  });
});

describe('Session wire: Query Reply reports the oversize', () => {
  it('Usable Area and Implicit Partition both carry 160x62 for a fixed 62x160 oversize', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiate();
    last().sent = [];
    last().host(...QUERY, T.IAC, T.EOR);
    const framed = lastRecord(last());
    // UN-DOUBLE IAC FIRST. `lastRecord` strips only the trailing IAC EOR; the telnet
    // layer's own doubling (telnet.ts's `doubleIac`, applied to every outbound record)
    // is still in the body, and the Color unit's content really does contain 0xff
    // (queryreply.test.ts's own GEOMETRY reply has it) -- walking the doubled bytes by
    // declared length desynchronizes partway through and corrupts every unit after.
    // queryreply.test.ts's `units` helper does not need this because it reads
    // buildQueryReply's output directly, never through the telnet layer.
    const reply: number[] = [];
    for (let j = 0; j < framed.length; j++) {
      reply.push(framed[j]!);
      if (framed[j] === T.IAC && framed[j + 1] === T.IAC) j++;
    }

    // AID 0x88 precedes the whole set (pages.txt:8648-8649, p. 6-22). `AID.SF`, not
    // `AID.QREPLY` (0x61) -- see queryreply.ts's own note on that exact confusion.
    expect(reply[0]).toBe(AID.SF);

    // Walk the length-prefixed units exactly as queryreply.test.ts's `units` helper
    // does (that file ~:15-30), starting after the AID byte. Throws on a bogus
    // length rather than looping forever on a desynchronized stream -- same guard
    // as that helper's, and the walk must land EXACTLY on the end of the record,
    // not merely terminate: see the project's "check what a comparison covers" note.
    const units: number[][] = [];
    for (let i = 1; i < reply.length; ) {
      const len = (reply[i]! << 8) | reply[i + 1]!;
      if (len < 4) throw new Error(`bogus unit length ${len} at offset ${i}`);
      units.push(reply.slice(i, i + len));
      i += len;
    }
    expect(units.reduce((sum, u) => sum + u.length, 1)).toBe(reply.length);

    // Usable Area (QCODE 0x81): W H are bytes 6-9 of the unit (after L L SFID
    // QCODE FLAGS FLAGS), BUFFSZ is bytes 21-22 -- queryreply.ts:216-220 and :267-268,
    // pinned by queryreply.test.ts's own byte-offset assertions (~:138-148).
    const ua = units.find((u) => u[3] === Qcode.USABLE_AREA)!;
    expect((ua[6]! << 8) | ua[7]!).toBe(160); // W: alt(geometry).cols
    expect((ua[8]! << 8) | ua[9]!).toBe(62); // H: alt(geometry).rows
    expect((ua[21]! << 8) | ua[22]!).toBe(160 * 62); // BUFFSZ

    // Implicit Partition (QCODE 0xa6): the SDP's WD HD (default) and WA HA
    // (alternate) sit at bytes 9-16 of the unit (base 6 bytes + SDP header 3
    // bytes) -- queryreply.ts:300-320, pinned by queryreply.test.ts ~:170-186.
    const ip = units.find((u) => u[3] === Qcode.IMPLICIT_PARTITION)!;
    const sdp = ip.slice(6);
    expect((sdp[3]! << 8) | sdp[4]!).toBe(80); // WD: default, unchanged
    expect((sdp[5]! << 8) | sdp[6]!).toBe(24); // HD: default, unchanged
    expect((sdp[7]! << 8) | sdp[8]!).toBe(160); // WA: alternate
    expect((sdp[9]! << 8) | sdp[10]!).toBe(62); // HA: alternate
  });
});

describe('Session wire: 14-bit addressing above 4096 cells', () => {
  it('a cursor at 5000 on a 62x160 oversize encodes 14-bit', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiate();
    last().host(Cmd.EWA, 0x00, T.IAC, T.EOR);
    expect(session.screen.size).toBe(62 * 160); // premise: above the 4096-cell threshold
    session.screen.cursor = 5000;
    last().sent = [];
    session.sendAID(AID.ENTER);
    const reply = lastRecord(last());
    // aid, then the two cursor-address bytes (inbound.ts:62, address.ts:50-51).
    expect(reply[0]).toBe(AID.ENTER);
    expect([reply[1], reply[2]]).toEqual([(5000 >> 8) & 0x3f, 5000 & 0xff]);
  });

  it('a cursor at 100 on a model 2 (1920 cells) encodes 12-bit, with the literal ADDRESS_CODE_TABLE bytes', async () => {
    // Model 2 is 1920 cells (24x80), well under the 4096 threshold -- NOT "exactly
    // at" it; the boundary itself is pinned by the two tests below. ADDRESS_CODE_TABLE
    // (constants.ts ~:720-729) maps (addr>>6)&0x3f and addr&0x3f to 0xc1 and 0xe4 for
    // addr=100: (100>>6)&0x3f = 1 -> table[1] = 0xc1; 100&0x3f = 36 -> table[36] = 0xe4.
    const { session: model2, last: last2 } = newSession({ model: '3278-2-E', oversize: { kind: 'none' } });
    await model2.connect('h', 23);
    last2().negotiate();
    expect(model2.screen.size).toBe(1920);
    model2.screen.cursor = 100;
    last2().sent = [];
    model2.sendAID(AID.ENTER);
    const reply2 = lastRecord(last2());
    expect([reply2[1], reply2[2]]).toEqual([0xc1, 0xe4]);
  });

  // The `> 0x1000` BOUNDARY ITSELF (address.ts:45), pinned directly rather than
  // inferred from a model: a fixed oversize of exactly 4096 cells (32x128) still uses
  // the 12-bit form, and one cell more (33x128, 4224) switches to 14-bit. Both are
  // valid fixed oversizes on 3278-2-E: at or above the model-2 floor (24x80) and under
  // the 16383-cell ceiling.
  const FIXED_32x128: GeometrySetting = { model: '3278-2-E', oversize: { kind: 'fixed', rows: 32, cols: 128 } };
  const FIXED_33x128: GeometrySetting = { model: '3278-2-E', oversize: { kind: 'fixed', rows: 33, cols: 128 } };

  it('a screen of exactly 4096 cells (32x128) still encodes 12-bit', async () => {
    const { session, last } = newSession(FIXED_32x128);
    await session.connect('h', 23);
    last().negotiate();
    last().host(Cmd.EWA, 0x00, T.IAC, T.EOR);
    expect(session.screen.size).toBe(4096); // NOT > 0x1000 -- the 12-bit boundary itself
    session.screen.cursor = 4000;
    last().sent = [];
    session.sendAID(AID.ENTER);
    const reply = lastRecord(last());
    expect(reply[0]).toBe(AID.ENTER);
    // 12-bit coded form: (4000>>6)&0x3f = 62 -> table[62] = 0x7e; 4000&0x3f = 32 -> table[32] = 0x60.
    expect([reply[1], reply[2]]).toEqual([0x7e, 0x60]);
  });

  it('one cell more, 4224 (33x128), switches to 14-bit', async () => {
    const { session, last } = newSession(FIXED_33x128);
    await session.connect('h', 23);
    last().negotiate();
    last().host(Cmd.EWA, 0x00, T.IAC, T.EOR);
    expect(session.screen.size).toBe(4224); // > 0x1000 -- one cell past the boundary
    session.screen.cursor = 4000;
    last().sent = [];
    session.sendAID(AID.ENTER);
    const reply = lastRecord(last());
    expect(reply[0]).toBe(AID.ENTER);
    expect([reply[1], reply[2]]).toEqual([(4000 >> 8) & 0x3f, 4000 & 0xff]);
  });
});

describe('Session wire: BIND 0x03 gives the oversize', () => {
  it('a 0x03 BIND (RFC 2355\'s prescription for IBM-DYNAMIC) gives the resolved oversize', async () => {
    // NARROW FIRST, with an ordinary 0x7f BIND, so the screen is NOT already at
    // 62x160 when 0x03 arrives. Without this, alternateSize is 62x160 straight out of
    // connect() -- its RESTING value -- and a 0x03 that does NOTHING, or one that
    // reads screen.alternateSize back on itself instead of modelSize(), would leave
    // it at 62x160 too and this test would pass for the wrong reason.
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiateE(GRANT_BIND_IMAGE);
    last().host(...bindRecord(bindBody(0x7f, 24, 80, 50, 132)));
    expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 }); // premise: narrowed
    last().host(...bindRecord(bindBody(0x03)));
    expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
  });
});

describe('Session wire: BIND range-checked against the oversize', () => {
  it('a 0x7f BIND within the oversize is accepted, and one row past it is refused', async () => {
    const { session, last } = newSession(FIXED_62x160);
    session.trace.setEnabled(true);
    await session.connect('h', 23);
    last().negotiateE(GRANT_BIND_IMAGE);

    // In range: default 24x80, alternate 50x132 -- below the 62x160 ceiling.
    last().host(...bindRecord(bindBody(0x7f, 24, 80, 50, 132)));
    expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 });

    // Exactly at the ceiling: 62x160 itself must be accepted, not refused -- the
    // bound in acceptBindDims is `>`, not `>=`.
    last().host(...bindRecord(bindBody(0x7f, 24, 80, 62, 160)));
    expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });

    // One row past the oversize ceiling: refused, with acceptBindDims' exact wording
    // (bind.ts ~:269-294) naming the oversize as the model, and the geometry
    // unchanged from the BIND just accepted above.
    last().host(...bindRecord(bindBody(0x7f, 24, 80, 63, 160)));
    expect(session.trace.toText())
      .toContain('BIND alternate 63x160 exceeds model 62x160; keeping our geometry');
    expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
  });
});

describe('Session wire: UNBIND reverts to the oversize', () => {
  it('UNBIND after a narrowing BIND reverts to 62x160, not to 24x80', async () => {
    const { session, last } = newSession(FIXED_62x160);
    await session.connect('h', 23);
    last().negotiateE(GRANT_BIND_IMAGE);
    last().host(...bindRecord(bindBody(0x7f, 24, 80, 50, 132)));
    expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 }); // premise
    last().host(...unbindRecord());
    expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
  });
});

describe('Session wire: each connect resets what UNBIND/BIND 0x03 use', () => {
  it('a reconnect at a plain model makes 0x03 give the model, not the old oversize', async () => {
    // Constructed at model 4 (alternate 43x80, NOT 24x80) so that a mutation which
    // forgets to update `modelAlternate` on a later connect cannot coincide with
    // this test's expectation by reusing the CONSTRUCTOR's own value -- an earlier
    // version of this test used '3278-2-E' at construction, whose alternate is
    // already 24x80, so "never updates modelAlternate past construction" silently
    // produced the right answer for the wrong reason.
    const { session, last } = newSession({ model: '3278-4-E', oversize: { kind: 'none' } });
    await session.connect('h', 23);
    last().close();
    session.setGeometry(FIXED_62x160);
    await session.reconnect();
    last().close();
    session.setGeometry({ model: '3278-2-E', oversize: { kind: 'none' } });
    await session.reconnect();
    last().negotiateE(GRANT_BIND_IMAGE);
    last().host(...bindRecord(bindBody(0x03)));
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
  });
});

describe('Session wire: a resolve that throws mid-connect leaves a live connection alone', () => {
  it('connect() to a second target that fails to resolve rejects without touching the first', async () => {
    let size: Size | undefined = { rows: 40, cols: 100 };
    const measure = (): Size | undefined => {
      if (size === undefined) throw new Error('font atlas not loaded');
      return size;
    };
    const { session, connect, last } = newSession({ oversize: { kind: 'auto' } }, { measure });
    await session.connect('h', 23);
    expect(session.isConnected()).toBe(true);
    const firstConn = last();

    size = undefined; // the NEXT resolve throws, simulating the font atlas going away
    await expect(session.connect('other', 24)).rejects.toThrow(/font atlas not loaded/);

    // The live connection from the FIRST connect is untouched: still connected, and
    // the transport was never closed.
    expect(session.isConnected()).toBe(true);
    expect(firstConn.closed).toBe(false);
    expect(last()).toBe(firstConn);

    // The REMEMBERED TARGET is unchanged too: the failed connect('other', 24) must
    // not have overwritten it, since `connect()` records `target` only after the
    // teardown it never reached. A later reconnect() replays the ORIGINAL host and
    // port, 'h'/23, not 'other'/24 -- fixed, now that the font atlas works again.
    firstConn.close();
    size = { rows: 40, cols: 100 };
    await session.reconnect();
    expect(connect).toHaveBeenLastCalledWith('h', 23);
  });
});
