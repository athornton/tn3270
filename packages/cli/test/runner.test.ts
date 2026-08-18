import { describe, it, expect } from 'vitest';
import { Session, type Connection, SnaCmd, Order, TelnetCmd as T, TelnetOpt as O, AID, FA, KeyboardState } from '@tn3270/core';
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

  it('Wait(Unlock) does not return while enter-inhibit is up', async () => {
    // Enter-inhibit sets no waitingForHost — answering a Query sends no AID and
    // is not a host write — so a wait that tested only that flag would return
    // over a keyboard that still refuses input, and the next String() would
    // fail as "input inhibited". x3270 blocks here: KBWAIT_MASK includes
    // KL_ENTER_INHIBIT (Common/task.c:262) and TS_WAIT_UNLOCK returns early
    // while KBWAIT holds (task.c:2276-2279).
    const { runner, session, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    session.oia.waitingForHost = false;
    session.oia.inhibit(KeyboardState.EnterInhibit);
    const reply = await runner.run('Wait(Unlock,0.05)');
    expect(reply).toContain('data: timed out');
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('Wait(Unlock) returns once a write releases the inhibit', async () => {
    const { runner, session, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    session.oia.waitingForHost = false;
    session.oia.inhibit(KeyboardState.EnterInhibit);
    conn.host(SnaCmd.W, 0x00, 0xc1, T.IAC, T.EOR);
    const reply = await runner.run('Wait(Unlock,0.05)');
    expect(reply.split('\n').pop()).toBe('ok');
  });

  it('Wait(Unlock) still returns immediately on a program check', async () => {
    // Narrowness check on the guard above: a program check must NOT newly block
    // the wait. Only the operator's Reset clears one, so waiting could do
    // nothing but burn the timeout — and x3270's KBWAIT_MASK likewise omits the
    // operator-error bits.
    const { runner, session, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.host(0x99, 0x00, T.IAC, T.EOR); // unknown command
    expect(session.oia.keyboard).toBe(KeyboardState.ProgramCheck);
    const reply = await runner.run('Wait(Unlock,0.05)');
    expect(reply.split('\n').pop()).toBe('ok');
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

describe('TraceText', () => {
  // Found live: Trace(on) enabled tracing but nothing ever emitted it — no sink
  // was wired and the CLI had no way to retrieve it, so recording a fixture
  // (the whole point of Task 16) was impossible.
  it('emits the recorded trace as data lines', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Trace(on)');
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.host(SnaCmd.EW, 0x02, 0xc1, T.IAC, T.EOR);
    const reply = await runner.run('TraceText');
    const lines = reply.split('\n').filter((l) => l.startsWith('data: '));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => / [<>] /.test(l))).toBe(true);
    expect(reply.split('\n').pop()).toBe('ok');
  });

  it('emits nothing when tracing was never enabled', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    const reply = await runner.run('TraceText');
    expect(reply.split('\n').filter((l) => l.startsWith('data: '))).toHaveLength(0);
    expect(reply.split('\n').pop()).toBe('ok');
  });
});

describe('Wait(InputField)', () => {
  // Added after a live VM/370 session: the host sends its banner and the logon
  // panel as SEPARATE records, and only the second carries the IC that puts the
  // cursor in a field. Wait(Output) fires on the first and Wait(Unlock) can
  // return before either, so a script types onto a protected cell. This
  // condition tests screen STATE, so it cannot be missed by arriving early.
  // x3270 has the same condition as TS_WAIT_IFIELD (task.c:135).
  it('returns once the cursor sits in an unprotected field', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    const pending = runner.run('Wait(InputField,5)');
    // First record: formatted but the cursor is left on a protected cell.
    conn.host(SnaCmd.EW, 0x02, Order.SF, FA.PROTECT, 0xc1, T.IAC, T.EOR);
    // Second record puts an unprotected field down and an IC inside it.
    conn.host(SnaCmd.W, 0x02, Order.SBA, 0x40, 0x4a, Order.SF, 0x00,
      Order.IC, T.IAC, T.EOR);
    expect((await pending).split('\n').pop()).toBe('ok');
  });

  it('does not return while the cursor is on a protected cell', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.host(SnaCmd.EW, 0x02, Order.SF, FA.PROTECT, 0xc1, T.IAC, T.EOR);
    const reply = await runner.run('Wait(InputField,0.05)');
    expect(reply).toContain('data: timed out');
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('names the accepted conditions when given an unknown one', async () => {
    const { runner, conn } = newRunner();
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    const reply = await runner.run('Wait(Frobnicate,1)');
    expect(reply).toContain('InputField');
    expect(reply.split('\n').pop()).toBe('error');
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
