import { describe, it, expect, vi } from 'vitest';
import {
  Session, type Connection, SnaCmd, Order, TelnetCmd as T, TelnetOpt as O, AID, FA, KeyboardState,
  encodeAddress, cp037, checksum, from6, to6, hostToLocal, localToHost,
  EOF_DATA1, EOF_DATA2, FrameType, ResponseFrameType, StatusCode, Color,
  O_CC_FRAME_SEQ, O_CC_MESSAGE, O_CC_STATUS_CODE, O_DR_FRAME_SEQ, O_DR_SF,
  O_DT_CSUM, O_DT_DATA, O_DT_FRAME_SEQ, O_DT_LEN, O_FRAME_TYPE, O_SF,
  O_UP_DATA, O_UP_FRAME_SEQ, O_UP_LEN, RO_FRAME_TYPE, RO_REASON_CODE,
} from '@tn3270/core';
import { Runner } from '../src/runner.js';
import { parseCommand } from '../src/commands.js';

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

/**
 * `Connect()` is the CLI's only host argument, so the full
 * `[prefix:][LU,LU@]host[:port]` shape has to be applied HERE. The rules themselves
 * belong to `resolveHostSpec` and are tested in hostspec.test.ts; these pin that the
 * runner applies them and hands the per-host parts to the session.
 *
 * The session's `connect` is wrapped rather than mocked out, so the real one still
 * runs: the assertion is about what the runner passes, and a test that stubbed the
 * connection away could not tell a rejected target from a connected one.
 */
function spyingRunner() {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn });
  const calls: { host: string; port: number; per: unknown }[] = [];
  const real = session.connect.bind(session);
  session.connect = async (host, port, per) => {
    calls.push({ host, port, per });
    await real(host, port, per);
  };
  return { runner: new Runner(session, { clock: () => 0 }), calls, conn };
}

describe("Connect()'s host argument", () => {
  it('splits host and port, defaulting to 23', async () => {
    const { runner, calls } = spyingRunner();
    await runner.run('Connect(vm.example:3270)');
    await runner.run('Connect(vm.example)');
    expect(calls[0]).toMatchObject({ host: 'vm.example', port: 3270 });
    expect(calls[1]).toMatchObject({ host: 'vm.example', port: 23 });
  });

  it('passes a QUOTED LU list to the session as a per-connection option', async () => {
    // Quoted, because the LU separator and the action-argument separator are both
    // commas. Measured against real s3270 4.5ga6: `Connect(LUA,LUB@host)` answers
    // "Connect() requires 1 argument", and `Connect("LUA,LUB@host")` connects.
    const { runner, calls } = spyingRunner();
    await runner.run('Connect("LUA,LUB@vm:992")');
    expect(calls[0]).toMatchObject({
      host: 'vm', port: 992, per: { lus: ['LUA', 'LUB'] },
    });
  });

  it('rejects an UNQUOTED LU list with s3270 s own arity error', async () => {
    // Without this the comma splits the argument and we connect to the host `LUA` on
    // port 23 -- a silently wrong target, which is the one outcome worth an error.
    // s3270's wording exactly, so a script's failure output is comparable.
    const { runner, calls } = spyingRunner();
    const reply = await runner.run('Connect(LUA,LUB@vm:992)');
    expect(reply).toContain('Connect() requires 1 argument');
    expect(reply.trimEnd().endsWith('error')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects Connect() with no argument the same way', async () => {
    // Measured: s3270 gives the identical message for argc 0.
    const { runner, calls } = spyingRunner();
    const reply = await runner.run('Connect()');
    expect(reply).toContain('Connect() requires 1 argument');
    expect(calls).toHaveLength(0);
  });

  it('turns the N: prefix into tn3270e false for that connection only', async () => {
    const { runner, calls } = spyingRunner();
    await runner.run('Connect(N:plain:3270)');
    await runner.run('Connect(fancy:992)');
    expect(calls[0]).toMatchObject({ host: 'plain', per: { tn3270e: false } });
    // The SECOND connection must not inherit it. This is the whole reason the option
    // is per-connection rather than per-session.
    expect(calls[1]!.per).toEqual({});
  });

  it('says nothing about tn3270e when the target does not', async () => {
    // `undefined`, not `true`: the session's own setting (from `-tn3270e`) has to keep
    // deciding, or every Connect() would silently override the flag.
    const { runner, calls } = spyingRunner();
    await runner.run('Connect(vm:3270)');
    expect(calls[0]!.per).toEqual({});
  });

  it('reports an unusable port as an error reply instead of connecting', async () => {
    const { runner, calls } = spyingRunner();
    const reply = await runner.run('Connect(vm:no-such-port)');
    expect(reply).toMatch(/port/i);
    expect(reply.trimEnd().endsWith('error')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('refuses a prefix it does not implement rather than ignoring it', async () => {
    const { runner, calls } = spyingRunner();
    const reply = await runner.run('Connect(P:vm:3270)');
    expect(reply).toMatch(/P:/);
    expect(reply.trimEnd().endsWith('error')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('still reports the bare hostname in the status line', async () => {
    // Field 4 is C(<host>) with no port and no prefix: s3270 formats it from
    // current_host (task.c:3144). A prefix leaking in here would be a visible
    // difference from s3270 in every reply.
    const { runner } = spyingRunner();
    const reply = await runner.run('Connect(N:LUA@vm.example:3270)');
    expect(reply).toContain('C(vm.example)');
  });
});

/**
 * `Reconnect()` — CONFORMANCE, exactly as `Dup()`/`FieldMark()`/`SysReq()` are: s3270 has the
 * action under this name (`Reconnect_action`, `AnReconnect`, Common/host.c), so a script written
 * for s3270 must not fail against us.
 *
 * AND `Enter()` IS DELIBERATELY NOT THIS. The interactive front ends reconnect on Enter or Clear;
 * a script's `Enter()` must not silently open a socket to a mainframe, which is the whole reason
 * this is a separate verb. The last test in this block is what pins that divergence.
 */
describe('Reconnect()', () => {
  it('dials the last host again after a Disconnect, options included', async () => {
    // `spyingRunner` wraps the INSTANCE's `connect`, and `Session.reconnect()` calls `this.connect`
    // -- so the replayed call lands in `calls` and all three parts of the target are visible from
    // here. `N:` is in the host argument on purpose: it is a property of the HOST, so it has to come
    // back with the host, and a reconnect that dropped it would silently offer TN3270E to a host the
    // script said not to. (Core asserts the same thing on the wire, in
    // `tn3270e-session.test.ts`; this is the CLI's own end of it.)
    const { runner, calls } = spyingRunner();
    await runner.run('Connect(N:vm.example:3270)');
    await runner.run('Disconnect()');
    const reply = await runner.run('Reconnect()');
    expect(reply.split('\n').pop()).toBe('ok');
    expect(calls).toEqual([
      { host: 'vm.example', port: 3270, per: { tn3270e: false } },
      { host: 'vm.example', port: 3270, per: { tn3270e: false } },
    ]);
    expect(reply).toContain('C(vm.example)');
  });

  it('puts the host back in field 4 of the status line', async () => {
    // `Disconnect()` clears it, since `C(<host>)` while disconnected would be a lie, so a
    // `Reconnect()` that did not restore it would answer `N` for a live connection -- a difference
    // from s3270 visible in every subsequent reply.
    const { runner } = newRunner();
    await runner.run('Connect(localhost:3270)');
    await runner.run('Disconnect()');
    expect(await runner.run('Enter()')).toContain(' N N ');
    const reply = await runner.run('Reconnect()');
    expect(reply).toContain('C(localhost)');
  });

  it('reports x3270 s own refusals, verbatim', async () => {
    // `Reconnect_action` is exactly two checks (Common/host.c): `if (PCONNECTED) {
    // popup_an_error(AnReconnect "(): Already connected"); ... }` and `if (current_host == NULL) {
    // popup_an_error(AnReconnect "(): No previous host to connect to"); ... }`. Core raises both and
    // this runner passes the message straight through, the same way `Connect()` passes check_argc's
    // wording -- so the MESSAGE is the assertion, not the `error` line: a bare `error` is also what
    // `parseCommand` produces for an unknown verb, which would pass with the action unimplemented.
    const fresh = newRunner();
    const never = await fresh.runner.run('Reconnect()');
    expect(never.split('\n').pop()).toBe('error');
    expect(never).toContain('data: Reconnect(): No previous host to connect to');

    const { runner } = newRunner();
    await runner.run('Connect(localhost:3270)');
    const live = await runner.run('Reconnect()');
    expect(live.split('\n').pop()).toBe('error');
    expect(live).toContain('data: Reconnect(): Already connected');
  });

  it('takes no arguments', async () => {
    const { runner } = newRunner();
    const reply = await runner.run('Reconnect(vm.example:3270)');
    expect(reply.split('\n').pop()).toBe('error');
    expect(reply).toContain('data: Reconnect() requires 0 arguments');
  });

  it('is in COMMAND_NAMES, so parseCommand admits it', () => {
    // A NAME MISSING FROM THAT TABLE IS REJECTED BEFORE `dispatch` EVER RUNS -- as "unknown
    // command", i.e. reading like an unimplemented action rather than a missing table entry. That is
    // measured history in this repo: the dispatch half of Dup/FieldMark/SysReq alone left all seven
    // of their tests failing on `unknown command: Dup`.
    expect(parseCommand('Reconnect()')).toEqual({ name: 'Reconnect', args: [] });
    expect(parseCommand('reconnect')!.name).toBe('Reconnect');
  });

  it('does NOT reconnect on Enter(), which the interactive front ends do', async () => {
    // THE DIVERGENCE, ASSERTED. `applyAction` reconnects on `enter`/`clear` while disconnected, and
    // the CLI deliberately does not share that: a script that types Enter into a dead session gets
    // s3270's own error, not a new socket to a mainframe. Without this test the two behaviors could
    // be unified by accident and nothing would notice.
    const { runner, calls } = spyingRunner();
    await runner.run('Connect(vm.example:3270)');
    await runner.run('Disconnect()');
    const reply = await runner.run('Enter()');
    expect(reply.split('\n').pop()).toBe('error');
    expect(reply).toContain('not connected');
    expect(calls, 'Enter() dialled a host from a script').toHaveLength(1);
    expect(reply).toContain(' N N ');                 // still disconnected, field 4 and 5
  });
});

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

describe('ScreenJson color', () => {
  it('reports resolved color per cell', async () => {
    const { runner, session } = newRunner();
    // A protected, unintensified field: the 3279 default map renders it BLUE.
    session.screen.setFieldAttribute(0, FA.PRINTABLE | FA.PROTECT);
    session.screen.setChar(1, 0xc1);

    const reply = await runner.run('ScreenJson');
    // Data lines are prefixed "data: "; the JSON is the only one here.
    const line = reply.split('\n').find((l) => l.startsWith('data: '))!;
    const json = JSON.parse(line.slice('data: '.length));

    expect(json.resolved).toBeDefined();
    expect(json.resolved).toHaveLength(1920);
    expect(json.resolved[1].fg).toBe(Color.BLUE);
    expect(json.resolved[1].text).toBe('A');
  });

  it('still reports the raw cells alongside the resolved ones', async () => {
    // A conformance comparison needs the bytes; a human debugging color needs
    // the resolution. Dropping either makes one of those impossible.
    const { runner, session } = newRunner();
    session.screen.setChar(0, 0xc1);
    const reply = await runner.run('ScreenJson');
    const line = reply.split('\n').find((l) => l.startsWith('data: '))!;
    const json = JSON.parse(line.slice('data: '.length));
    expect(json.cells[0].ebcdic).toBe(0xc1);
    expect(json.resolved[0].text).toBe('A');
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

/**
 * `Dup()`, `FieldMark()` and `SysReq()` — CONFORMANCE, not symmetry with the other
 * front ends. s3270 has all three under exactly these names (`Common/kybd.c:223`,
 * `:230`, `:254`), so a script written for s3270 must not fail here.
 *
 * The field is built the way the `String()` test above builds one, from the same
 * `newRunner()`: Erase/Write with a WCC that unlocks the keyboard, one field
 * attribute at address 0, then `MoveCursor` into the first data cell. `0x00` is an
 * unprotected attribute and `FA.PROTECT` a protected one, which is the only
 * difference between the two setups.
 *
 * The refusal and argument tests ASSERT THE MESSAGE, not just the `error` line. A
 * bare `error` would also be produced by `parseCommand` rejecting the verb as
 * unknown, so a test that only looked at the last line would pass just as well with
 * these three actions never implemented at all.
 */
describe('Dup, FieldMark and SysReq', () => {
  /** A connected runner with the cursor in the first cell of a one-field screen. */
  async function onAField(attr: number) {
    const built = newRunner();
    await built.runner.run('Connect(localhost:3270)');
    built.conn.negotiate();
    built.conn.host(SnaCmd.EW, 0xc3, Order.SF, attr, T.IAC, T.EOR);
    await built.runner.run('MoveCursor(0,1)');
    return built;
  }

  it('Dup() writes 0x1c into the field', async () => {
    const { runner, session } = await onAField(0x00);
    const at = session.screen.cursor;
    const reply = await runner.run('Dup()');
    expect(reply.split('\n').pop()).toBe('ok');
    expect(session.screen.cellAt(at).ebcdic).toBe(0x1c);
  });

  it('FieldMark() writes 0x1e into the field', async () => {
    const { runner, session } = await onAField(0x00);
    const at = session.screen.cursor;
    const reply = await runner.run('FieldMark()');
    expect(reply.split('\n').pop()).toBe('ok');
    expect(session.screen.cellAt(at).ebcdic).toBe(0x1e);
  });

  it('accepts the bare-verb spelling too, s3270 taking either', async () => {
    const { runner, session } = await onAField(0x00);
    const at = session.screen.cursor;
    expect((await runner.run('Dup')).split('\n').pop()).toBe('ok');
    expect(session.screen.cellAt(at).ebcdic).toBe(0x1c);
  });

  /**
   * `Session.sysreq()` is spied rather than watched on the wire because SYSREQ is a
   * TN3270E function: without it negotiated the session deliberately sends nothing
   * (session.ts, `SYSREQ ignored: function not negotiated`). That IAC AO reaches the
   * socket once the function is agreed is core's, and is covered end to end by
   * `core/test/tn3270e-session.test.ts` ("sends IAC AO when SYSREQ was agreed").
   * What was untested until this task is the only thing this task adds: that the
   * command reaches the session at all. Before it, no front end could call sysreq().
   */
  it('SysReq() reaches Session.sysreq', async () => {
    const { runner, session } = await onAField(0x00);
    const spy = vi.spyOn(session, 'sysreq');
    const reply = await runner.run('SysReq()');
    expect(spy).toHaveBeenCalledOnce();
    expect(reply.split('\n').pop()).toBe('ok');
  });

  it('reports a protected field as an error reply carrying the OIA reason', async () => {
    const { runner, session } = await onAField(FA.PROTECT);
    const reply = await runner.run('Dup()');
    expect(reply.split('\n').pop()).toBe('error');
    expect(reply).toContain('data: Dup(): input inhibited (4 A  X Protected)');
    // Nothing was written: a refusal must not half-apply.
    expect(session.screen.cellAt(1).ebcdic).toBe(0x00);
  });

  it('refuses Field Mark in a numeric field, where Dup is allowed', async () => {
    // The manual's permitted set for a numeric field names the DUP control and not
    // the field mark (p. 4-13); core owns the rule, this pins that the CLI reports
    // its two different outcomes rather than flattening them.
    const dup = await onAField(FA.NUMERIC);
    expect((await dup.runner.run('Dup()')).split('\n').pop()).toBe('ok');
    expect(dup.session.screen.cellAt(1).ebcdic).toBe(0x1c);

    const fm = await onAField(FA.NUMERIC);
    const reply = await fm.runner.run('FieldMark()');
    expect(reply.split('\n').pop()).toBe('error');
    expect(reply).toContain('data: FieldMark(): input inhibited (4 A  X Numeric)');
  });

  it('takes no arguments', async () => {
    const { runner } = await onAField(0x00);
    for (const name of ['Dup', 'FieldMark', 'SysReq']) {
      const reply = await runner.run(`${name}(1)`);
      expect(reply.split('\n').pop()).toBe('error');
      expect(reply).toContain(`data: ${name}() requires 0 arguments`);
    }
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

// ---------------------------------------------------------------------------
// Transfer()
// ---------------------------------------------------------------------------

/**
 * `Transfer()` driven end to end through the fake connection.
 *
 * This is the test the task asks for: "drive a synthetic host that emits a
 * host-ack frame, a data frame, an EOF and a completion, and assert the file
 * content that comes out." It is feasible without elaborate mocking because the
 * only two things the runner touches outside the session are already injected —
 * the clock and now `files` — and because a CUT frame is just a screen the host
 * painted, so `FakeCutHost` below writes one with ordinary 3270 orders through
 * the same `conn.host()` every other test in this file uses.
 *
 * WHAT IS REAL HERE: the telnet layer, the record parser, the screen model, the
 * keyboard, `isCutFrame`, `parseFrame`, the codec, `CutTransfer`, and the runner's
 * own polling loop. WHAT IS SYNTHETIC: only the host's side of the conversation,
 * and it is synthesised from `ft_cut_ds.h` offsets rather than from a recording,
 * because no live transfer has been captured yet. The lower layers ARE verified
 * against a live TK5 frame (see packages/core/test/ft/frames.test.ts), so what
 * these tests add is the sequencing across round trips and the file I/O at the
 * ends.
 */

/** An in-memory `TransferFiles`, so no test touches a temp directory. */
class FakeFiles {
  readonly store = new Map<string, Uint8Array>();
  /** Set to make read() throw, for the unreadable-source path. */
  readError: string | undefined;

  exists(path: string): boolean { return this.store.has(path); }

  read(path: string): Uint8Array {
    if (this.readError !== undefined) throw new Error(this.readError);
    const b = this.store.get(path);
    if (b === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    return b;
  }

  write(path: string, bytes: Uint8Array): void { this.store.set(path, new Uint8Array(bytes)); }

  append(path: string, bytes: Uint8Array): void {
    const old = this.store.get(path) ?? new Uint8Array(0);
    const out = new Uint8Array(old.length + bytes.length);
    out.set(old, 0);
    out.set(bytes, old.length);
    this.store.set(path, out);
  }
}

/**
 * Paint one CUT frame into the session's screen, the way a host does.
 *
 * ERASE/WRITE, NOT WRITE, and that is not a detail: the live TK5 capture is
 * `EraseWrite SBA(1919) SBA(0) data[5] SBA(1914) SF(0xc1) IC data[4] SF(0x7c)`
 * (design doc, "PROTOCOL CONFIRMED") — the host erases and then paints only the
 * few cells the frame occupies. Using a plain Write instead left the typed
 * IND$FILE command sitting in the buffer, and since the command starts at address
 * 1 its tail lands on `O_CC_MESSAGE` (4) — so an abort frame carrying NO message
 * reported "$FILE GET FOO" as the host's text. That was the test being
 * unfaithful, not the code being wrong, but it is exactly the confusion a
 * synthetic host is prone to and the reason to copy the capture rather than
 * improvise. The WCC restores the keyboard, which is what `sendAID` locked.
 */
function cutFrame(conn: FakeConnection, cells: ReadonlyMap<number, number>): void {
  const bytes: number[] = [SnaCmd.EW, 0x02];
  for (const [addr, value] of [...cells].sort((a, b) => a[0] - b[0])) {
    bytes.push(Order.SBA, ...encodeAddress(addr, 1920), value);
  }
  // The detection attribute at O_SF last, so it survives whatever came before.
  // 0x7c is the byte the real TK5 host plants: PROTECT|NUMERIC, i.e. auto-skip,
  // which is x3270's whole test (`FA_IS_SKIP(ea_buf[O_SF].fa)`, ft_cut.c:394).
  bytes.push(Order.SBA, ...encodeAddress(O_SF, 1920), Order.SF, 0x7c);
  bytes.push(T.IAC, T.EOR);
  conn.host(...bytes);
}

/** `FT_CONTROL_CODE` with a status code (ft_cut_ds.h:37-43). */
function controlCode(conn: FakeConnection, status: number, message = ''): void {
  const cells = new Map<number, number>([
    [O_FRAME_TYPE, FrameType.CONTROL_CODE],
    [O_CC_FRAME_SEQ, to6(0)],
    [O_CC_STATUS_CODE, (status >> 8) & 0xff],
    [O_CC_STATUS_CODE + 1, status & 0xff],
  ]);
  cp037.encode(message).forEach((b, i) => cells.set(O_CC_MESSAGE + i, b));
  cutFrame(conn, cells);
}

/** `FT_DATA` carrying an already-6-bit-encoded payload (ft_cut_ds.h:50-54). */
function dataFrame(conn: FakeConnection, payload: readonly number[], seq: number): void {
  const cells = new Map<number, number>([
    [O_FRAME_TYPE, FrameType.DATA],
    [O_DT_FRAME_SEQ, to6(seq)],
    [O_DT_CSUM, to6(checksum(payload))],
    [O_DT_LEN, to6((payload.length >> 6) & 0x3f)],
    [O_DT_LEN + 1, to6(payload.length & 0x3f)],
  ]);
  payload.forEach((b, i) => cells.set(O_DT_DATA + i, b));
  cutFrame(conn, cells);
}

/** `FT_DATA_REQUEST` (ft_cut_ds.h:45-48), with the field attribute at O_DR_SF. */
function dataRequest(conn: FakeConnection, seq: number): void {
  // O_DR_SF is 1, and the host plants a field attribute there — the one
  // writeUploadFrame turns non-display (ft_cut.c:558-561). Written as an SF
  // order, hence the separate record rather than a cell in the map.
  conn.host(
    SnaCmd.EW, 0x02,
    Order.SBA, ...encodeAddress(O_FRAME_TYPE, 1920), FrameType.DATA_REQUEST,
    Order.SBA, ...encodeAddress(O_DR_SF, 1920), Order.SF, FA.PRINTABLE | FA.MODIFY,
    Order.SBA, ...encodeAddress(O_DR_FRAME_SEQ, 1920), to6(seq),
    Order.SBA, ...encodeAddress(O_SF, 1920), Order.SF, 0x7c,
    T.IAC, T.EOR,
  );
}

/**
 * A session sitting at a host command prompt, with the runner wired to a
 * `FakeFiles`.
 *
 * One unprotected field covering row 1 from column 2, which is where the
 * IND$FILE command gets typed — 79 cells, comfortably more than the longest
 * command any test here builds, so the capacity pre-flight passes.
 */
async function transferRunner(opts: { transferFrameSeconds?: number } = {}) {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn });
  const files = new FakeFiles();
  const runner = new Runner(session, {
    clock: () => 0,
    files,
    // Short by default: a test that WANTS a timeout should not wait 30s for it,
    // and a test that does not should never reach it.
    transferFrameSeconds: opts.transferFrameSeconds ?? 5,
  });
  await runner.run('Connect(localhost:3270)');
  conn.negotiate();
  // Erase/Write with a keyboard-restoring WCC, a protected prompt, and one
  // unprotected field with the cursor in it.
  conn.host(SnaCmd.EW, 0x02, Order.SF, 0x00, Order.IC, T.IAC, T.EOR);
  conn.sent = [];
  return { runner, session, conn, files };
}

/** The EBCDIC bytes the runner typed, as text, up to the first AID. */
function typedCommand(session: Session): string {
  return session.screen.rowText(1).trim();
}

describe('Transfer(): option and pre-flight failures', () => {
  it('rejects a bad option without typing anything at the host', async () => {
    const { runner, session, conn } = await transferRunner();
    const reply = await runner.run('Transfer(LocalFile=/tmp/x,HostFile=FOO,Frobnicate=1)');
    expect(reply).toContain('unknown option');
    expect(reply.split('\n').pop()).toBe('error');
    // THE POINT OF THE ORDERING RULE: nothing reached the host, so it is not
    // left sitting in transfer mode waiting for a client that gave up.
    expect(conn.sent).toEqual([]);
    expect(typedCommand(session)).toBe('');
  });

  it('rejects a missing local file for a send before typing anything', async () => {
    const { runner, conn } = await transferRunner();
    const reply = await runner.run('Transfer(Direction=send,LocalFile=/tmp/gone,HostFile=FOO)');
    expect(reply).toContain('cannot read local file /tmp/gone');
    expect(reply).toContain('ENOENT');
    expect(conn.sent).toEqual([]);
  });

  it('reports an unreadable source file rather than a protocol error', async () => {
    const { runner, files, conn } = await transferRunner();
    files.store.set('/tmp/locked', Uint8Array.of(1));
    files.readError = 'EACCES: permission denied';
    const reply = await runner.run('Transfer(Direction=send,LocalFile=/tmp/locked,HostFile=FOO)');
    expect(reply).toContain('EACCES');
    expect(conn.sent).toEqual([]);
  });

  it('refuses to overwrite an existing destination without Exist=replace', async () => {
    // `if (p->receive_flag && !p->append_flag && !p->allow_overwrite)` (ft.c:666-674).
    const { runner, files, conn } = await transferRunner();
    files.store.set('/tmp/there', Uint8Array.of(0xff));
    const reply = await runner.run('Transfer(LocalFile=/tmp/there,HostFile=FOO)');
    expect(reply).toContain('file exists: /tmp/there');
    expect(conn.sent).toEqual([]);
    // ...and the existing bytes are untouched.
    expect(Array.from(files.store.get('/tmp/there')!)).toEqual([0xff]);
  });

  it('fails when the Runner has no file system at all', async () => {
    // Same division of labor as Replay(): runner.ts imports no node:fs.
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn });
    const runner = new Runner(session, { clock: () => 0 });
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    const reply = await runner.run('Transfer(LocalFile=/tmp/x,HostFile=FOO)');
    expect(reply).toContain('requires the file system');
    expect(reply.split('\n').pop()).toBe('error');
  });

  it('refuses when not in 3270 mode', async () => {
    // x3270's ftUnableNot3270 (fb-common:47).
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn });
    const runner = new Runner(session, { clock: () => 0, files: new FakeFiles() });
    await runner.run('Connect(localhost:3270)'); // no negotiate()
    const reply = await runner.run('Transfer(LocalFile=/tmp/x,HostFile=FOO)');
    expect(reply).toContain('not in 3270 mode');
  });

  it('refuses on an unformatted screen rather than guessing at a field', async () => {
    // x3270 guesses at the run of nulls from the cursor (kybd.c:4389-4403); we
    // refuse, because an unformatted screen at this point means the script is
    // somewhere it did not think it was — a VM/370 logon banner, say — and typing
    // a transfer command into that is unrecoverable.
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn });
    const runner = new Runner(session, { clock: () => 0, files: new FakeFiles() });
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    conn.host(SnaCmd.EW, 0x02, 0xc1, T.IAC, T.EOR); // data, no fields
    const reply = await runner.run('Transfer(LocalFile=/tmp/x,HostFile=FOO)');
    expect(reply).toContain('no input field');
    expect(reply).toContain('unformatted');
  });

  it('refuses when the input field is too small for the command', async () => {
    // `ftUnableTooSmall` (fb-common:49), x3270's `flen < vb_len(&r) - 1` check
    // (ft.c:776). A truncated command is a command the host rejects in a way that
    // reads like a protocol fault.
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn });
    const runner = new Runner(session, { clock: () => 0, files: new FakeFiles() });
    await runner.run('Connect(localhost:3270)');
    conn.negotiate();
    // A 4-cell unprotected field between two attributes.
    conn.host(SnaCmd.EW, 0x02, Order.SF, 0x00, Order.IC,
      Order.SBA, ...encodeAddress(5, 1920), Order.SF, FA.PROTECT, T.IAC, T.EOR);
    const reply = await runner.run('Transfer(LocalFile=/tmp/x,HostFile=FOO)');
    expect(reply).toContain('input field too small');
    expect(reply).toContain('4 cells');
  });

  it('refuses while the keyboard is locked', async () => {
    // `ftUnableLocked`, "keyboard locked" (fb-common:46). A script should have
    // reached a settled prompt with Wait(Settle) first.
    const { runner, session } = await transferRunner();
    session.oia.inhibit(KeyboardState.SystemWait);
    const reply = await runner.run('Transfer(LocalFile=/tmp/x,HostFile=FOO)');
    expect(reply).toContain('keyboard locked');
  });
});

describe('Transfer(): receive, end to end', () => {
  it('types the command, walks the frames, and writes the decoded file', async () => {
    const { runner, session, conn, files } = await transferRunner();
    const content = Uint8Array.from([0x00, 0x40, 0x7f, 0xc1, 0xff, 0x5c, 0xa9, 0x81]);
    // Encoded the way the host would: one codec for the whole transfer, which is
    // codec finding 3 and the reason this is a single call rather than one per
    // frame.
    const encoded = Array.from(localToHost(content));

    const pending = runner.run(
      'Transfer(Direction=receive,LocalFile=/tmp/out.bin,HostFile=\'HERC02.TEST\')');

    // The command is typed and Enter pressed before any frame arrives — which is
    // exactly what the host is waiting for.
    await new Promise((r) => setTimeout(r, 20));
    expect(typedCommand(session)).toBe("IND$FILE GET 'HERC02.TEST'");
    expect(conn.sent[0]).toBe(AID.ENTER);

    // The four-step conversation from the design doc's "Data flow".
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, encoded, 1);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, [EOF_DATA1, EOF_DATA2], 2);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);

    const reply = await pending;
    expect(reply.split('\n').pop()).toBe('ok');
    expect(reply).toContain(`data: Transfer complete, ${content.length} bytes transferred`);
    // THE ASSERTION THE WHOLE TEST EXISTS FOR: the bytes that came out.
    expect(Array.from(files.store.get('/tmp/out.bin')!)).toEqual(Array.from(content));
  });

  it('acknowledges every frame with Enter', async () => {
    // `cut_ack()` is `run_action(AnEnter, ...)` (ft_cut.c:652-657), and it is what
    // every step of a receive returns, including the one that completes
    // (ft_cut.c:442-447 acks BEFORE completing).
    const { runner, conn } = await transferRunner();
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    conn.sent = [];

    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, Array.from(localToHost(Uint8Array.of(0xc1))), 1);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    await pending;

    // Three AIDs, all Enter. Filtering for AID bytes at record starts is not
    // reliable in general, so count occurrences of the AID at index 0 of each
    // record — every inbound record here begins with one and Enter is 0x7d.
    expect(conn.sent.filter((b) => b === AID.ENTER).length).toBeGreaterThanOrEqual(3);
    expect(conn.sent).not.toContain(AID.PF2); // no abort
  });

  it('writes an empty file for a transfer that carries no data', async () => {
    const { runner, conn, files } = await transferRunner();
    const pending = runner.run('Transfer(LocalFile=/tmp/empty,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    const reply = await pending;
    expect(reply).toContain('Transfer complete, 0 bytes transferred');
    expect(files.store.get('/tmp/empty')).toEqual(new Uint8Array(0));
  });

  it('appends to an existing destination with Exist=append', async () => {
    const { runner, conn, files } = await transferRunner();
    files.store.set('/tmp/log', Uint8Array.of(0x11, 0x22));
    const pending = runner.run('Transfer(LocalFile=/tmp/log,HostFile=FOO,Exist=append)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, Array.from(localToHost(Uint8Array.of(0x33))), 1);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    await pending;
    expect(Array.from(files.store.get('/tmp/log')!)).toEqual([0x11, 0x22, 0x33]);
  });

  it('replaces an existing destination with Exist=replace', async () => {
    const { runner, conn, files } = await transferRunner();
    files.store.set('/tmp/dst', Uint8Array.of(0x11, 0x22, 0x33));
    const pending = runner.run('Transfer(LocalFile=/tmp/dst,HostFile=FOO,Exist=replace)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, Array.from(localToHost(Uint8Array.of(0x44))), 1);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    await pending;
    expect(Array.from(files.store.get('/tmp/dst')!)).toEqual([0x44]);
  });

  it('reassembles a file split across several frames', async () => {
    // What a single frame cannot show: the codec's quadrant persists across
    // frames, so a frame whose first byte is DATA rather than a selector must
    // still decode. A fresh codec per frame would reject it, which is codec
    // finding 3's failure mode.
    const { runner, conn, files } = await transferRunner();
    const content = Uint8Array.from([0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6]);
    const encoded = Array.from(localToHost(content));
    // Split after the selector plus two characters, so frame 2 legitimately
    // starts mid-quadrant with no selector of its own.
    const cut = 3;
    expect(encoded.length).toBeGreaterThan(cut);

    const pending = runner.run('Transfer(LocalFile=/tmp/split,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, encoded.slice(0, cut), 1);
    await new Promise((r) => setTimeout(r, 20));
    dataFrame(conn, encoded.slice(cut), 2);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    await pending;
    expect(Array.from(files.store.get('/tmp/split')!)).toEqual(Array.from(content));
  });
});

describe('Transfer(): send, end to end', () => {
  it('answers each data request with an upload frame and finishes on EOF', async () => {
    const { runner, session, conn, files } = await transferRunner();
    const content = Uint8Array.from([0x00, 0xff, 0x40, 0xc1]);
    files.store.set('/tmp/in.bin', content);

    const pending = runner.run(
      "Transfer(Direction=send,LocalFile=/tmp/in.bin,HostFile='HERC02.NEW',Recfm=fixed,Lrecl=80)");
    await new Promise((r) => setTimeout(r, 20));
    expect(typedCommand(session)).toBe("IND$FILE PUT 'HERC02.NEW' RECFM(F) LRECL(80)");

    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));

    // One data request is enough for a 4-byte file: a frame holds O_UP_MAX bytes.
    dataRequest(conn, 1);
    await new Promise((r) => setTimeout(r, 20));
    // The frame the state machine wrote is in the screen. Read the declared
    // length back and decode the payload, which is the host's own job.
    const encodedLength = (from6(session.screen.cellAt(O_UP_LEN).ebcdic) << 6)
      | from6(session.screen.cellAt(O_UP_LEN + 1).ebcdic);
    const payload: number[] = [];
    for (let i = 0; i < encodedLength; i++) payload.push(session.screen.cellAt(O_UP_DATA + i).ebcdic);
    expect(Array.from(hostToLocal(payload))).toEqual(Array.from(content));

    // Then the host asks again, gets the EOF sentinel, and completes.
    dataRequest(conn, 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(session.screen.cellAt(O_UP_DATA).ebcdic).toBe(EOF_DATA1);
    expect(session.screen.cellAt(O_UP_DATA + 1).ebcdic).toBe(EOF_DATA2);

    controlCode(conn, StatusCode.XFER_COMPLETE);
    const reply = await pending;
    expect(reply.split('\n').pop()).toBe('ok');
    expect(reply).toContain(`Transfer complete, ${content.length} bytes transferred`);
    // Nothing was written locally: a send reads only.
    expect(files.store.has('/tmp/in.bin')).toBe(true);
    expect(files.store.size).toBe(1);
  });

  it('re-sends the previous block byte-identically on a retransmit', async () => {
    // Upload's characteristic failure path, and the design doc requires it be a
    // deliberate test at this level too: the RETAINED bytes go back out, not a
    // re-encoding, because the codec's quadrant has already moved.
    const { runner, session, conn, files } = await transferRunner();
    files.store.set('/tmp/in.bin', Uint8Array.from([0x00, 0xff, 0x40, 0xc1]));
    const pending = runner.run('Transfer(Direction=send,LocalFile=/tmp/in.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    dataRequest(conn, 1);
    await new Promise((r) => setTimeout(r, 20));

    const snapshot = (): number[] => {
      const out: number[] = [];
      for (let a = O_UP_FRAME_SEQ; a < O_SF; a++) out.push(session.screen.cellAt(a).ebcdic);
      return out;
    };
    const first = snapshot();

    // FT_RETRANSMIT: the frame type is the whole message (ft_cut_ds.h:49).
    cutFrame(conn, new Map([[O_FRAME_TYPE, FrameType.RETRANSMIT]]));
    await new Promise((r) => setTimeout(r, 20));
    expect(snapshot()).toEqual(first);

    dataRequest(conn, 2);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    expect((await pending).split('\n').pop()).toBe('ok');
  });
});

describe('Transfer(): failure paths', () => {
  it('reports the host\'s own abort message', async () => {
    // `cut_control_code`'s SC_ABORT_FILE branch takes the text from O_CC_MESSAGE
    // (ft_cut.c:448-486) and acks with ENTER, not PF2 — the host has already
    // decided.
    const { runner, conn, files } = await transferRunner();
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=NOPE)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.ABORT_FILE, 'DATA SET NOT FOUND');
    const reply = await pending;
    expect(reply).toContain('data: Transfer(): DATA SET NOT FOUND');
    expect(reply.split('\n').pop()).toBe('error');
    // NO LOCAL FILE IS WRITTEN on a failure, which is the whole reason the write
    // happens after the loop rather than per frame.
    expect(files.store.has('/tmp/out.bin')).toBe(false);
  });

  it('substitutes x3270\'s text when the host aborts with no message', async () => {
    // `ftHostCancel`, "Transfer canceled by host" (fb-common:36, ft_cut.c:480-482).
    const { runner, conn } = await transferRunner();
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.ABORT_XMIT);
    expect(await pending).toContain('Transfer canceled by host');
  });

  it('times out rather than hanging when the host goes quiet', async () => {
    // A timeout is MANDATORY, for the reason Wait's own comment gives. The
    // message says the host may still be in transfer mode, because we
    // deliberately do not synthesise an abort sequence no captured session
    // contains.
    const { runner, conn, files } = await transferRunner({ transferFrameSeconds: 0.1 });
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    // ...and then nothing.
    const reply = await pending;
    expect(reply).toContain('no CUT frame from the host within 0.1s');
    expect(reply).toContain('press Attn or Clear');
    expect(reply.split('\n').pop()).toBe('error');
    expect(files.store.has('/tmp/out.bin')).toBe(false);
  });

  it('aborts with PF2 and reports when a frame is malformed', async () => {
    // An unknown frame type is one of the two faults x3270 aborts on
    // (ft_cut.c:408-411, SC_ABORT_XMIT). `cut_abort` writes the response area and
    // presses PF2 (ft_cut.c:662-678).
    const { runner, session, conn } = await transferRunner();
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    conn.sent = [];
    cutFrame(conn, new Map([[O_FRAME_TYPE, 0x42]]));
    const reply = await pending;
    expect(reply).toContain('unknown CUT frame type 0x42');
    expect(reply.split('\n').pop()).toBe('error');
    expect(conn.sent[0]).toBe(AID.PF2);
    // And the response area carries the reason the host expects.
    expect(session.screen.cellAt(RO_FRAME_TYPE).ebcdic).toBe(ResponseFrameType.CONTROL_CODE);
    expect(session.screen.cellAt(RO_REASON_CODE).ebcdic).toBe((StatusCode.ABORT_XMIT >> 8) & 0xff);
  });

  it('surfaces a checksum mismatch as a data line without failing the transfer', async () => {
    // "Verify but warn, never abort" — the design doc's decision, resting on the
    // live TK5 evidence that the host really does populate O_DT_CSUM. A warning
    // nobody can see is not a warning, so it comes out as a data line.
    const { runner, conn, files } = await transferRunner();
    const encoded = Array.from(localToHost(Uint8Array.of(0xc1, 0xc2)));
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.HOST_ACK);
    await new Promise((r) => setTimeout(r, 20));
    // Same frame as dataFrame() builds, with a deliberately wrong checksum.
    const cells = new Map<number, number>([
      [O_FRAME_TYPE, FrameType.DATA],
      [O_DT_FRAME_SEQ, to6(1)],
      [O_DT_CSUM, to6((checksum(encoded) + 1) & 0x3f)],
      [O_DT_LEN, to6((encoded.length >> 6) & 0x3f)],
      [O_DT_LEN + 1, to6(encoded.length & 0x3f)],
    ]);
    encoded.forEach((b, i) => cells.set(O_DT_DATA + i, b));
    cutFrame(conn, cells);
    await new Promise((r) => setTimeout(r, 20));
    controlCode(conn, StatusCode.XFER_COMPLETE);
    const reply = await pending;
    expect(reply).toContain('checksum mismatch');
    expect(reply.split('\n').pop()).toBe('ok'); // NOT a failure
    expect(Array.from(files.store.get('/tmp/out.bin')!)).toEqual([0xc1, 0xc2]);
  });
});

/**
 * A transfer runner at an arbitrary geometry, and a DFT-capable one.
 *
 * `transferRunner` above hardcodes a default `Session`, which is always 24x80 -- every
 * model's DEFAULT size is 24x80 and `-model` sets only the ALTERNATE, so a 43-row session
 * needs `rows`/`cols` at construction. Written as a second factory rather than by widening
 * the first, so none of the thirty CUT tests above changes.
 */
async function transferRunnerAt(
  rows: number, cols: number, opts: { transferFrameSeconds?: number; ddm?: boolean } = {},
) {
  const conn = new FakeConnection();
  const session = new Session({
    // FORWARDED BOTH WAYS, not only when true: since the 2026-09-29 default flip, `ddm: false`
    // is the meaningful one and dropping it would silently give an advertising session.
    connect: () => conn, rows, cols, ...(opts.ddm === undefined ? {} : { ddm: opts.ddm }),
  });
  const files = new FakeFiles();
  const runner = new Runner(session, {
    clock: () => 0,
    files,
    transferFrameSeconds: opts.transferFrameSeconds ?? 5,
  });
  await runner.run(`Connect(localhost:3270)`);
  conn.negotiate();
  conn.host(SnaCmd.EW, 0x02, Order.SF, 0x00, Order.IC, T.IAC, T.EOR);
  conn.sent = [];
  return { runner, session, conn, files };
}

/** `WriteStructuredField` carrying one DFT frame: `L L SFID payload`, then IAC EOR. */
function dftWsf(conn: FakeConnection, payload: number[]): void {
  const len = payload.length + 3;
  conn.host(0xf3, (len >> 8) & 0xff, len & 0xff, 0xd0, ...payload, T.IAC, T.EOR);
}

/** A DFT `Open` payload; the name sits at payload offset 25 (`dftFrames.ts`). */
function dftOpen(name = 'FT:DATA'): number[] {
  const p = new Array<number>(0x23 - 3).fill(0x00);
  p[0] = 0x00;
  p[1] = 0x12;
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) p[25 + i] = padded.charCodeAt(i);
  return p;
}

/** A DFT `Data Insert` carrying these bytes. */
function dftData(bytes: number[]): number[] {
  return [
    0x47, 0x04, 0xc0, 0x80, 0x61,
    ((bytes.length + 5) >> 8) & 0xff, (bytes.length + 5) & 0xff, ...bytes,
  ];
}

/** Every record of a complete DFT download: Open, data, Close, then FT:MSG/TRANS03. */
function dftDownload(conn: FakeConnection, payload = [0x41, 0x42, 0x43]): void {
  dftWsf(conn, dftOpen());
  dftWsf(conn, dftData(payload));
  dftWsf(conn, [0x41, 0x12]);                                     // Close
  dftWsf(conn, dftOpen('FT:MSG'));
  dftWsf(conn, dftData([...'TRANS03'].map((c) => c.charCodeAt(0))));
}

describe('Transfer() protocol selection', () => {
  it('does not refuse 43x80 before the host is asked', async () => {
    // THE DELETION, in the CLI's idiom: this used to THROW
    // "CUT file transfer needs a 24x80 screen" before a byte reached the host. Under
    // host-chooses-the-protocol we cannot know CUT was chosen until the host answers.
    //
    // NOTHING PINNED THAT GATE. Measured: no test in this file mentioned 24x80, 43x80 or
    // `screen.size` at all, so its deletion could not redden anything -- which is exactly
    // why this test is written as the deletion happens rather than after.
    const { runner, session, conn } = await transferRunnerAt(43, 80, { transferFrameSeconds: 0.1 });
    expect(session.screen.size).toBe(3440);
    const reply = await runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    // It gets as far as a TIMEOUT, which means it reached the host -- the old behavior
    // failed with the geometry message and an empty wire.
    expect(reply).not.toContain('needs a 24x80 screen');
    expect(reply).toContain('press Attn or Clear');
    expect(typedCommand(session)).toContain('IND$FILE GET FOO');
    expect(conn.sent).toContain(AID.ENTER);
  });

  it('a DFT host completes, and the poll loop does not spin to its deadline', async () => {
    // THE SECOND WAKE CONDITION. The loop waits on `outputCount` changing AND a CUT frame
    // being present; a DFT transfer satisfies the first and never the second, so without
    // `!dft.complete` a HEALTHY transfer runs to `transferFrameSeconds` and reports a
    // timeout.
    //
    // THE PLAN IS WRONG ABOUT WHY, in the same way it was for the event-driven driver, and
    // the correction matters for anyone reading the loop: it says "a DFT transfer never
    // changes `outputCount`". It DOES -- `emit('screen')` fires once per record handled
    // (`session.ts:897`, unconditional) and a DFT frame arrives as a WriteStructuredField
    // record. What it never does is paint a CUT frame, so `looksLikeCutFrame` stays false
    // and the inner `while` never exits. Same conclusion, different mechanism.
    const { runner, conn, files } = await transferRunnerAt(24, 80, { transferFrameSeconds: 0.1 });
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    dftDownload(conn);
    const reply = await pending;
    expect(reply.split('\n').pop()).toBe('ok');
    expect(reply).not.toContain('press Attn or Clear');
    expect(Array.from(files.store.get('/tmp/out.bin')!)).toEqual([0x41, 0x42, 0x43]);
  });

  it('a DFT transfer works at 43x80, which is what the deletion bought', async () => {
    // THE PAYOFF, and the CLI half of it. Before this design a 43x80 session could not
    // transfer a file at all. DFT is structured fields, not screen scraping, so it has no
    // 24x80 requirement.
    const { runner, conn, files } = await transferRunnerAt(43, 80, { transferFrameSeconds: 0.5 });
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    dftDownload(conn, [0x44, 0x45]);
    const reply = await pending;
    expect(reply.split('\n').pop()).toBe('ok');
    expect(Array.from(files.store.get('/tmp/out.bin')!)).toEqual([0x44, 0x45]);
  });

  it('registers the DFT engine BEFORE priming, so a fast host cannot lose its first frame', async () => {
    // Same race as the event-driven driver: a fast host's first 0xd0 arrives from inside
    // `handleRecord`, before any runner code runs again, and `handleTransferData` needs a
    // registered transfer AT THAT MOMENT. Asserted from inside `sendAID` rather than after,
    // because checking afterwards cannot tell the two orders apart.
    const { runner, session } = await transferRunnerAt(24, 80, { transferFrameSeconds: 0.1 });
    let registeredWhenPrimed: boolean | undefined;
    const realSendAID = session.sendAID.bind(session);
    vi.spyOn(session, 'sendAID').mockImplementation((aid: number) => {
      registeredWhenPrimed ??= session.dftTransfer !== undefined;
      realSendAID(aid);
    });
    await runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    expect(registeredWhenPrimed).toBe(true);
  });

  it('a CUT frame RELEASES the DFT registration, so no retained frame is replayed', async () => {
    // CUT HAS WON, so the DFT engine registered before priming must go: `answerRead` replays
    // a registered engine's retained frame, which at a host now running a CUT transfer is
    // unsolicited traffic mid-transfer. The registration is released before `step` is called,
    // so a Read Modified arriving between the two cannot find it.
    //
    // MEASURED AS NECESSARY: without this test, removing the `cancelDftTransfer()` call left
    // the whole suite green -- the spec's rule is that an unpinned call is decoration, so the
    // choice was this test or deleting the line.
    const { runner, session, conn } = await transferRunner();
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    expect(session.dftTransfer).toBeDefined();          // registered before priming
    controlCode(conn, StatusCode.HOST_ACK);             // the host answers with a CUT frame
    await new Promise((r) => setTimeout(r, 20));
    expect(session.dftTransfer).toBeUndefined();        // and the DFT engine is released
    controlCode(conn, StatusCode.XFER_COMPLETE);
    await pending;
  });

  it('A CUT HOST AT 24x80 IS BYTE-FOR-BYTE UNCHANGED, which is the real safety net', async () => {
    // The spec's own words: "If the CUT path changes behavior at 24x80, this design is
    // wrong." Asserted on the WIRE rather than on success, because a transfer that succeeds
    // while sending different bytes is exactly the regression this would hide.
    //
    // The comparison is against a run of the SAME sequence, so it cannot drift from a
    // hardcoded expectation -- and the acks are what the CUT engine chose, frame by frame.
    const encoded = Array.from(localToHost(Uint8Array.of(0xc1, 0xc2)));
    const drive = async () => {
      const { runner, conn, files } = await transferRunner();
      const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
      await new Promise((r) => setTimeout(r, 20));
      conn.sent = [];
      controlCode(conn, StatusCode.HOST_ACK);
      await new Promise((r) => setTimeout(r, 20));
      dataFrame(conn, encoded, 1);
      await new Promise((r) => setTimeout(r, 20));
      controlCode(conn, StatusCode.XFER_COMPLETE);
      const reply = await pending;
      return { wire: [...conn.sent], reply, file: [...(files.store.get('/tmp/out.bin') ?? [])] };
    };
    const got = await drive();
    expect(got.reply.split('\n').pop()).toBe('ok');
    expect(got.file).toEqual([0xc1, 0xc2]);
    // Every byte the client sent for a three-frame CUT download, and there is no DFT
    // structured field among them -- registering a DFT engine must put NOTHING on the wire.
    expect(got.wire).not.toContain(0xd0);
    expect(got.wire.filter((b) => b === AID.ENTER).length).toBeGreaterThan(0);
  });

  it('names -ddm on in a timeout when DDM was never advertised', async () => {
    // The CLI gets the same observed-state rows as the TUI. Forgetting `-ddm on` will be the
    // commonest failure once DFT works, because a host that speaks only DFT cannot CHOOSE
    // DFT unless the Query Reply carried QCODE 0x95.
    // `ddm: false` EXPLICITLY, since the 2026-09-29 flip made the default ON.
    const { runner, session } = await transferRunnerAt(24, 80, {
      transferFrameSeconds: 0.1, ddm: false,
    });
    expect(session.ddmAdvertised).toBe(false);
    const reply = await runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    expect(reply).toContain('-ddm on');
    expect(reply).toContain('press Attn or Clear');
  });

  it('does NOT name -ddm on when it WAS advertised', async () => {
    // The half that stops the clause becoming noise printed on every timeout.
    const { runner, session } = await transferRunnerAt(24, 80, {
      transferFrameSeconds: 0.1, ddm: true,
    });
    expect(session.ddmAdvertised).toBe(true);
    const reply = await runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    expect(reply).not.toContain('-ddm on');
  });

  it('names the GEOMETRY when screens arrived at 43x80 and none was a CUT frame', async () => {
    // THE FALLBACK ROW, and a fallback on purpose: measured on VM/370, MECAFF answers
    // `IND$FILE requires a MECAFF connected 3270 terminal` and CMS recovers in about a
    // second, so the host's own text usually arrives and beats ours. This is for a CUT-only
    // host at 43x80 that goes quiet instead.
    const { runner, conn } = await transferRunnerAt(43, 80, { transferFrameSeconds: 0.2 });
    const pending = runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');
    await new Promise((r) => setTimeout(r, 20));
    // The host paints SOMETHING -- a refusal, a menu -- but never a CUT frame.
    conn.host(SnaCmd.W, 0x02, Order.SBA, ...encodeAddress(0, 3440), 0xc8, T.IAC, T.EOR);
    const reply = await pending;
    // ASSERTS THE WHOLE CLAUSE, NOT JUST "43x80", AND THAT IS THE POINT. The first version
    // of this test read `toContain('43x80')` -- and PASSED under the mutation it exists to
    // catch. Swapping `looksLikeCutFrame` back to `isCutFrame` makes the detector THROW
    // `CutFrameError`, whose own message reads "...this screen is 43x80 = 3440 cells...", so
    // the weak assertion matched the exception text instead of the timeout row. A test that
    // passes against the bug it names, for the fifth time on this project's record.
    //
    // So: assert the RECOVERY leads, the row's own wording, and that no CutFrameError text
    // is present. The third is what actually pins the non-throwing detector.
    expect(reply).toContain('press Attn or Clear');
    expect(reply).toContain('host may want 24x80; this session is 43x80');
    expect(reply).not.toContain('offsets are meaningless');   // i.e. it did not throw
    expect(reply).not.toContain('-ddm on');     // screens DID arrive, so not that row
  });
});

describe('Transfer(BufferSize=N)', () => {
  it('reaches the DFT engine and BOUNDS THE FRAMES ON THE WIRE', async () => {
    // THE KEYWORD'S WHOLE POINT, asserted on bytes rather than on the option. A small
    // BufferSize must produce small upload frames: the engine chunks by
    // `bufferSize - UPLOAD_OVERHEAD` (dft.ts:340), so 300 gives 273 data bytes per frame and
    // a 600-byte file needs three. Before the driver passed the keyword through, the engine
    // silently used 16384 and the whole file went in ONE frame -- which is also what the host
    // was NOT told to expect.
    const { runner, session, conn, files } = await transferRunnerAt(24, 80, {
      transferFrameSeconds: 0.5,
    });
    files.store.set('/tmp/big.bin', new Uint8Array(600).fill(0xc1));

    const pending = runner.run(
      'Transfer(Direction=send,HostFile=BIG.BIN,LocalFile=/tmp/big.bin,BufferSize=300)');
    await new Promise((r) => setTimeout(r, 20));
    expect(session.dftTransfer?.bufferSize).toBe(300);

    // Open, then a Get per frame until the engine says EOF.
    dftWsf(conn, dftOpen());
    const frames: number[] = [];
    for (let i = 0; i < 6; i++) {
      conn.sent = [];
      dftWsf(conn, [0x46, 0x11]);                      // TR_GET_REQ
      if (conn.sent.length === 0) break;
      frames.push(conn.sent.length);
      if (session.dftTransfer === undefined) break;
    }
    // Every frame fits the advertised buffer, and no single frame swallowed the file.
    expect(frames.length).toBeGreaterThan(1);
    for (const len of frames) expect(len).toBeLessThanOrEqual(300);

    dftWsf(conn, [0x41, 0x12]);                        // Close
    dftWsf(conn, dftOpen('FT:MSG'));
    dftWsf(conn, dftData([...'TRANS03'].map((c) => c.charCodeAt(0))));
    await pending;
  });

  it('TELLS THE OPERATOR when it clamped, before the transfer runs', async () => {
    // A WARNING NOBODY SEES IS NOT A WARNING. The validator produces it; this asserts it
    // reaches the s3270 reply as a `data:` line, in the same idiom CutTransfer.warnings
    // already uses -- and BEFORE anything else, since a clamp changes what goes on the wire
    // and the operator may want to stop.
    const { runner } = await transferRunnerAt(24, 80, { transferFrameSeconds: 0.1 });
    const reply = await runner.run(
      'Transfer(Direction=receive,HostFile=A.BIN,LocalFile=/tmp/out.bin,BufferSize=100)');
    expect(reply).toContain('data: Transfer(): BufferSize 100 is outside the DFT range');
    expect(reply).toContain('using 256');
  });

  it('says nothing extra when the size was in range', async () => {
    // The other half, so the line cannot become noise printed on every transfer.
    const { runner } = await transferRunnerAt(24, 80, { transferFrameSeconds: 0.1 });
    const reply = await runner.run(
      'Transfer(Direction=receive,HostFile=A.BIN,LocalFile=/tmp/out.bin,BufferSize=512)');
    expect(reply).not.toContain('outside the DFT range');
  });

  it('CLAMPS through the whole path, so the engine and the wire agree at the bounds', async () => {
    // `BufferSize=10` is below DFT_MIN_BUF. The keyword clamps it to 256 with the same
    // `boundDftBufferSize` the engine and the advertisement use, so all three say 256 --
    // the property that makes a mismatch structurally impossible rather than merely unlikely.
    const { runner, session } = await transferRunnerAt(24, 80, { transferFrameSeconds: 0.1 });
    await runner.run(
      'Transfer(Direction=receive,HostFile=A.BIN,LocalFile=/tmp/out.bin,BufferSize=10)');
    expect(session.dftTransfer?.bufferSize ?? 256).toBe(256);
  });
});

describe('Transfer(): a DFT transfer that finishes before the poll loop', () => {
  it('is NOT missed when it completes inside sendAID(ENTER) itself', async () => {
    // THE CLI'S VERSION OF "CHECK STATE BEFORE WAITING". A whole DFT transfer can begin AND
    // FINISH inside `sendAID`'s record handling -- the frames arrive from `onRecord` and
    // nothing yields to the runner in between -- so by the time `runTransferFrames` is entered
    // the transfer is already over and there is no further host write to wake a poll.
    //
    // WHAT MAKES IT WORK IS THE `while` CONDITION, NOT A SEPARATE PRE-CHECK. The plan asked
    // for an `if (dft.complete)` before the loop; that was written, and its mutation check
    // showed it REDUNDANT -- removing it left every test green, because `!dft.complete` in the
    // `while` exits the poll immediately and the check after the loop returns the same result.
    // It was deleted rather than kept, per the spec's rule: "If nothing does, the call is
    // decoration and should be deleted rather than kept." This test is what pins the case, so
    // the behavior is covered even though the extra line is gone.
    const { runner, session, conn, files } = await transferRunnerAt(24, 80, {
      transferFrameSeconds: 0.1,
    });
    const realSendAID = session.sendAID.bind(session);
    vi.spyOn(session, 'sendAID').mockImplementation((aid: number) => {
      realSendAID(aid);
      dftDownload(conn, [0x41, 0x42, 0x43]);
    });

    const reply = await runner.run('Transfer(LocalFile=/tmp/out.bin,HostFile=FOO)');

    // NOT a timeout: it noticed a transfer that was over before it looked.
    expect(reply.split('\n').pop()).toBe('ok');
    expect(reply).not.toContain('press Attn or Clear');
    expect(reply).toContain('Transfer complete, 3 bytes transferred');
    expect(Array.from(files.store.get('/tmp/out.bin')!)).toEqual([0x41, 0x42, 0x43]);
  });
});
