import { describe, it, expect } from 'vitest';
import {
  Session, type Connection, SnaCmd, Order, TelnetCmd as T, TelnetOpt as O, AID, FA, KeyboardState,
  encodeAddress, cp037, checksum, from6, to6, hostToLocal, localToHost,
  EOF_DATA1, EOF_DATA2, FrameType, ResponseFrameType, StatusCode,
  O_CC_FRAME_SEQ, O_CC_MESSAGE, O_CC_STATUS_CODE, O_DR_FRAME_SEQ, O_DR_SF,
  O_DT_CSUM, O_DT_DATA, O_DT_FRAME_SEQ, O_DT_LEN, O_FRAME_TYPE, O_SF,
  O_UP_DATA, O_UP_FRAME_SEQ, O_UP_LEN, RO_FRAME_TYPE, RO_REASON_CODE,
} from '@tn3270/core';
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
    // Same division of labour as Replay(): runner.ts imports no node:fs.
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
