import { describe, it, expect } from 'vitest';
import { Session, type Connection, SnaCmd, Order, TelnetCmd as T, TelnetOpt as O, AID, FA } from '@tn3270/core';
import { Runner } from '../src/runner.js';

class FakeConnection implements Connection {
  sent: number[] = [];
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;
  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.onClose?.(); }
  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }
  negotiate(): void {
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.sent = [];
  }
}

function newRunner() {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn });
  const runner = new Runner(session, { clock: () => 0 });
  return { runner, session, conn };
}

describe('reply format', () => {
  it('ends a successful command with a status line then ok', async () => {
    const { runner } = newRunner();
    const reply = await runner.run('Home');
    const lines = reply.split('\n');
    expect(lines[lines.length - 1]).toBe('ok');
    expect(lines[lines.length - 2]!.split(' ')).toHaveLength(12);
  });

  it('ends a failed command with error', async () => {
    const { runner } = newRunner();
    const reply = await runner.run('Enter'); // not connected
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('reports an unknown command as an error with a data line', async () => {
    const { runner } = newRunner();
    const reply = await runner.run('Frobnicate');
    expect(reply).toContain('data: unknown command');
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('treats a blank line as a no-op that still reports status', async () => {
    const { runner } = newRunner();
    const reply = await runner.run('');
    expect(reply.split('\n').pop()).toBe('ok');
  });
});

describe('screen reading', () => {
  it('Ascii returns the whole screen as data lines', async () => {
    const { runner, session } = newRunner();
    session.screen.setChar(0, 0xc1);
    const reply = await runner.run('Ascii');
    const dataLines = reply.split('\n').filter((l) => l.startsWith('data: '));
    expect(dataLines).toHaveLength(24);
    expect(dataLines[0]).toBe('data: ' + 'A' + ' '.repeat(79));
  });

  it('Ascii(row,col,len) returns one region, 0-based as s3270 is', async () => {
    const { runner, session } = newRunner();
    session.screen.setChar(0, 0xc8);
    session.screen.setChar(1, 0xc9);
    const reply = await runner.run('Ascii(0,0,2)');
    expect(reply).toContain('data: HI');
  });

  it('ScreenText returns the screen without the data prefix noise', async () => {
    const { runner, session } = newRunner();
    session.screen.setChar(0, 0xc1);
    const reply = await runner.run('ScreenText');
    expect(reply.split('\n').filter((l) => l.startsWith('data: '))).toHaveLength(24);
  });

  it('ScreenJson returns parseable JSON with cells and fields', async () => {
    const { runner, session } = newRunner();
    session.screen.setFieldAttribute(0, FA.PROTECT);
    session.screen.setChar(1, 0xc1);
    const reply = await runner.run('ScreenJson');
    const json = reply.split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('');
    const parsed = JSON.parse(json);
    expect(parsed.rows).toBe(24);
    expect(parsed.cols).toBe(80);
    expect(parsed.fields).toHaveLength(1);
    expect(parsed.cells[1].ebcdic).toBe(0xc1);
  });
});

describe('typing and keys', () => {
  it('String types into a field', async () => {
    const { runner, session, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.host(SnaCmd.EW, 0xc3, Order.SF, 0x00, T.IAC, T.EOR);
    await runner.run('MoveCursor(0,1)');
    const reply = await runner.run('String("AB")');
    expect(reply.split('\n').pop()).toBe('ok');
    expect(session.screen.cellAt(1).ebcdic).toBe(0xc1);
    expect(session.screen.cellAt(2).ebcdic).toBe(0xc2);
  });

  it('PF(3) sends the right AID', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.sent = [];
    await runner.run('PF(3)');
    expect(conn.sent[0]).toBe(AID.PF3);
  });

  it('rejects a PF number outside 1-24', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    const reply = await runner.run('PF(25)');
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('PA(1) sends a short read: AID alone', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.sent = [];
    await runner.run('PA(1)');
    expect(conn.sent).toEqual([AID.PA1, T.IAC, T.EOR]);
  });

  it('Attn sends IAC BREAK', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.sent = [];
    await runner.run('Attn');
    expect(conn.sent).toEqual([T.IAC, T.BREAK]);
  });
});

describe('Wait', () => {
  it('Wait(3270Mode) returns once negotiation completes', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    const pending = runner.run('Wait(3270Mode)');
    conn.negotiate();
    const reply = await pending;
    expect(reply.split('\n').pop()).toBe('ok');
  });

  it('Wait(Unlock) times out rather than hanging forever', async () => {
    const { runner, session, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    session.oia.waitingForHost = true;
    const reply = await runner.run('Wait(Unlock,0.05)');
    expect(reply).toContain('data: timed out');
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('Wait(Output) returns when the host writes', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    const pending = runner.run('Wait(Output)');
    conn.host(SnaCmd.W, 0x02, 0xc1, T.IAC, T.EOR);
    expect((await pending).split('\n').pop()).toBe('ok');
  });
});

describe('trace and replay', () => {
  it('Trace(on) starts recording and Trace(off) stops', async () => {
    const { runner, session, conn } = newRunner();
    await runner.run('Trace(on)');
    expect(session.trace.isEnabled()).toBe(true);
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    await runner.run('Trace(off)');
    expect(session.trace.isEnabled()).toBe(false);
  });

  it('Replay drives the screen from trace text', async () => {
    const { runner, session } = newRunner();
    // Session.replay() builds a fresh TelnetLayer with no pre-negotiated
    // options, and flushRecord() discards any record delivered before
    // is3270Mode() is true. A real trace always contains the negotiation
    // that preceded the data, so the fixture must include it too.
    const trace = [
      '0.000 < ff fd 19 ff fb 19', // IAC DO EOR, IAC WILL EOR
      '0.000 < ff fd 00 ff fb 00', // IAC DO BINARY, IAC WILL BINARY
      '0.000 < f5 c3 11 40 40 c8 c9 ff ef', // Erase/Write placing "HI" at top left
    ].join('\n');
    const reply = await runner.runReplayText(trace);
    expect(reply.split('\n').pop()).toBe('ok');
    expect(session.screen.rowText(1).slice(0, 2)).toBe('HI');
  });
});

describe('Quit', () => {
  it('reports that the runner should stop', async () => {
    const { runner } = newRunner();
    await runner.run('Quit');
    expect(runner.shouldQuit).toBe(true);
  });
});
