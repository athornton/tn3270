import { createConnection } from 'node:net';
import {
  Session, type Connection, AID, PF_AIDS, PA_AIDS,
} from '@tn3270/core';
import { parseCommand } from './commands.js';
import { formatStatus } from './status.js';

/**
 * Executes s3270 commands against a session.
 *
 * Separated from main.ts so the command semantics are testable without a
 * process or a socket. main.ts only does stdin/stdout.
 */

/** How long the record stream must be idle for Wait(Settle) to fire. */
const SETTLE_MS = 400;
/**
 * How long to keep waiting for a typable field before accepting a screen that has
 * none. Output-only panels are legitimate, so this cannot wait forever — but it
 * must outlast a host that settles on one screen and then sends another.
 */
const SETTLE_QUIET_MS = 2000;

export interface RunnerOptions {
  clock?: () => number;
  /** Default Wait timeout in seconds. x3270 uses about 30. */
  defaultWaitSeconds?: number;
}

/** A real TCP connection adapter. */
function tcpConnect(host: string, port: number): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port });
    const conn: Connection = {
      write: (b) => { sock.write(b); },
      close: () => { sock.destroy(); },
      onData: undefined,
      onClose: undefined,
      onError: undefined,
    };
    sock.on('data', (b: Buffer) => conn.onData?.(new Uint8Array(b)));
    sock.on('close', () => conn.onClose?.());
    sock.on('error', (e: Error) => {
      conn.onError?.(e);
      reject(e);
    });
    sock.on('connect', () => resolve(conn));
  });
}

export function defaultSession(terminalType?: string): Session {
  return new Session({
    connect: (h, p) => tcpConnect(h, p),
    ...(terminalType ? { terminalType } : {}),
  });
}

export class Runner {
  shouldQuit = false;
  private host: string | undefined;
  private readonly clock: () => number;
  private readonly defaultWait: number;
  /** Bumped whenever the host writes, so Wait(Output) can observe it. */
  private outputCount = 0;

  constructor(private readonly session: Session, opts: RunnerOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.defaultWait = opts.defaultWaitSeconds ?? 30;
    this.session.on('screen', () => { this.outputCount++; });
  }

  /** Run one command line and return the complete s3270 reply. */
  async run(line: string): Promise<string> {
    const started = this.clock();
    const data: string[] = [];
    let ok = true;

    try {
      const cmd = parseCommand(line);
      if (cmd !== null) {
        await this.dispatch(cmd.name, cmd.args, data);
      }
    } catch (err) {
      ok = false;
      data.push(err instanceof Error ? err.message : String(err));
    }

    const elapsed = (this.clock() - started) / 1000;
    const out = data.map((d) => `data: ${d}`);
    out.push(formatStatus(this.session, this.host, elapsed));
    out.push(ok ? 'ok' : 'error');
    return out.join('\n');
  }

  /**
   * Format an out-of-band failure (e.g. Replay's file I/O, which main.ts owns)
   * as a proper s3270 reply: a data line, the status line, then error. Every
   * reply must carry a status line, even ones that never reached dispatch().
   */
  errorReply(message: string): string {
    return [`data: ${message}`, formatStatus(this.session, this.host, undefined), 'error'].join('\n');
  }

  /** Replay trace text directly — used by Replay() and by tests. */
  async runReplayText(traceText: string): Promise<string> {
    const started = this.clock();
    this.session.replay(traceText);
    const elapsed = (this.clock() - started) / 1000;
    return [formatStatus(this.session, this.host, elapsed), 'ok'].join('\n');
  }

  private async dispatch(name: string, args: string[], data: string[]): Promise<void> {
    const s = this.session;
    const k = s.keyboard;

    switch (name) {
      case 'Connect': {
        const target = args[0] ?? '';
        const [host, portText] = splitTarget(target);
        await s.connect(host, portText);
        // Field 4 of the status line is C(<host>) with NO port: s3270 formats it
        // from current_host, which holds the hostname alone (task.c:3144).
        // Verified by running s3270 against the same host: it reports
        // C(127.0.0.1) where we were reporting C(127.0.0.1:3270).
        this.host = host;
        return;
      }
      case 'Disconnect':
        s.disconnect();
        this.host = undefined;
        return;

      case 'Quit':
        this.shouldQuit = true;
        return;

      case 'String':
        if (!k.typeString(args[0] ?? '')) throw new Error('input inhibited');
        return;

      case 'Enter': s.sendAID(AID.ENTER); return;
      case 'Clear': s.sendAID(AID.CLEAR); return;

      case 'PF': {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > 24) throw new Error(`PF number out of range: ${args[0]}`);
        s.sendAID(PF_AIDS[n - 1]!);
        return;
      }
      case 'PA': {
        const n = Number(args[0]);
        if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error(`PA number out of range: ${args[0]}`);
        s.sendAID(PA_AIDS[n - 1]!);
        return;
      }
      case 'Attn': s.sendAttn(); return;

      case 'Tab': k.tab(); return;
      case 'BackTab': k.backTab(); return;
      case 'Home': k.home(); return;
      case 'Newline': k.newline(); return;
      case 'Left': k.left(); return;
      case 'Right': k.right(); return;
      case 'Up': k.up(); return;
      case 'Down': k.down(); return;
      case 'BackSpace': k.backspace(); return;
      case 'Delete': k.deleteChar(); return;
      case 'EraseEOF': k.eraseEOF(); return;
      case 'EraseInput': k.eraseInput(); return;
      case 'Reset': k.reset(); return;
      case 'Insert': k.setInsertMode(!k.insertMode); return;

      case 'MoveCursor': {
        // s3270 addresses are 0-based row/col.
        const row = Number(args[0]);
        const col = Number(args[1]);
        if (!Number.isInteger(row) || !Number.isInteger(col)) {
          throw new Error('MoveCursor needs a row and a column');
        }
        k.moveCursor(s.screen.fromRowCol(row + 1, col + 1));
        return;
      }

      case 'Ascii': {
        if (args.length === 0) {
          data.push(...s.screen.toText().split('\n'));
          return;
        }
        const row = Number(args[0]);
        const col = Number(args[1]);
        const len = Number(args[2]);
        if (![row, col, len].every(Number.isInteger)) {
          throw new Error('Ascii needs row, col and length');
        }
        const start = s.screen.fromRowCol(row + 1, col + 1);
        let text = '';
        let a = start;
        for (let i = 0; i < len; i++) {
          const { row: r, col: c } = s.screen.toRowCol(a);
          text += s.screen.rowText(r)[c - 1] ?? ' ';
          a = s.screen.inc(a);
        }
        data.push(text);
        return;
      }

      case 'ScreenText':
        data.push(...s.screen.toText().split('\n'));
        return;

      case 'Snap':
        data.push(...s.screen.toText().split('\n'));
        return;

      case 'ScreenJson': {
        const snap = s.screen.snapshot();
        data.push(JSON.stringify({
          rows: snap.rows,
          cols: snap.cols,
          cursor: snap.cursor,
          formatted: snap.formatted,
          oia: s.oia.toText(),
          fields: snap.fields,
          cells: snap.cells,
        }));
        return;
      }

      case 'Trace': {
        const mode = (args[0] ?? '').toLowerCase();
        if (mode === 'on') s.trace.setEnabled(true);
        else if (mode === 'off') s.trace.setEnabled(false);
        else throw new Error(`Trace needs on or off, got ${args[0]}`);
        return;
      }

      case 'TraceText':
        // Emit what has been traced so far as data lines. Without this the trace
        // is enabled but unreachable: nothing writes it anywhere, so recording a
        // fixture would be impossible. Trace(on,file) is the eventual home for
        // streaming straight to disk; this makes the data available today through
        // the same channel as every other reply.
        data.push(...s.trace.lines());
        return;

      case 'Replay':
        throw new Error('Replay(file) requires the file system; use runReplayText in tests');

      case 'Wait':
        await this.wait(args);
        return;

      default:
        throw new Error(`unimplemented command: ${name}`);
    }
  }

  /**
   * Wait(Output|Unlock|3270Mode[,seconds]).
   *
   * A timeout is mandatory, not optional: without one, a script against a host
   * that never unlocks the keyboard hangs forever.
   *
   * Note this uses Date.now, NOT this.clock. The injectable clock exists to make
   * the status line's timing field deterministic in tests; a real timeout needs
   * real elapsed time, and driving it from a frozen test clock would spin
   * forever.
   */
  private async wait(args: string[]): Promise<void> {
    const what = (args[0] ?? 'Unlock').toLowerCase();
    const seconds = args[1] !== undefined ? Number(args[1]) : this.defaultWait;
    const deadline = Date.now() + seconds * 1000;

    const startingOutput = this.outputCount;
    let settleLast = -1;
    let settleSince = 0;
    const done = (): boolean => {
      switch (what) {
        case 'output': return this.outputCount > startingOutput;
        case 'unlock': return !this.session.oia.waitingForHost;
        case '3270mode': return this.session.is3270Mode();
        case 'settle': {
          // Wait for the host to stop sending. Distinct from Output (which fires
          // on the FIRST record) and from Unlock (which can return before any
          // record arrives). tnz uses this technique: poll until the session's
          // byte count stops changing, then proceed (ati.py:1965-1976).
          //
          // Needed because VM/370 sends one logical screen as several records —
          // a banner, then the panel carrying the IC — so a predicate that is
          // briefly true between records fires too early.
          // Three conditions, all necessary:
          //  - at least one record has arrived (a session that has received
          //    nothing is not "settled", it is unstarted);
          //  - the record count has been stable for SETTLE_MS;
          //  - the keyboard is usable, because a settled screen we may not type
          //    into is not ready. Without this last check the wait returned with
          //    the keyboard still locked and the very next String() failed as
          //    "input inhibited" — observed live, and it is what made record 0 of
          //    the conformance comparison differ.
          const now = this.session.recordCount();
          if (now === 0) return false;
          if (settleLast !== now) {
            settleLast = now;
            settleSince = Date.now();
            return false;
          }
          if (Date.now() - settleSince < SETTLE_MS) return false;
          if (this.session.oia.isInhibited()) return false;

          // And there must be somewhere to type. An unlocked keyboard is not
          // enough: this host settles briefly on a status screen that has 28
          // fields, none of them typable, with the cursor on a protected cell —
          // then replaces it with the logon panel. Returning on the first quiet
          // moment therefore hands the script a screen it cannot type into, and
          // the next String() fails as "input inhibited". Intermittent, because
          // whether the panel has landed depends on timing.
          //
          // A screen with no typable field at all is a legitimate final state
          // (an output-only panel), so this cannot be an unconditional
          // requirement — it applies only while the host is still sending. Hence
          // the check is "typable OR the stream has been quiet a long time".
          const sc = this.session.screen;
          const typable = sc.typableFields().length > 0;
          if (typable) return true;
          return Date.now() - settleSince >= SETTLE_QUIET_MS;
        }
        case 'inputfield': {
          // Wait until the cursor is sitting somewhere typable. This is the
          // condition scripts actually want after Enter, and unlike
          // Wait(Output) it tests SCREEN STATE rather than an event, so it
          // cannot be missed by arriving too early. x3270 has the same
          // condition (TS_WAIT_IFIELD, task.c:135).
          //
          // Needed because a host may send several records for one logical
          // screen: VM/370 sends its banner and then the logon panel, and only
          // the second carries the IC that puts the cursor in a field. A script
          // that types after the first one lands on a protected cell.
          if (this.session.oia.isInhibited()) return false;
          const sc = this.session.screen;
          const f = sc.fieldAt(sc.cursor);
          return f !== null && !f.protected;
        }
        default: throw new Error(
          `Wait: unknown condition ${args[0]} (expected Output, Unlock, Settle, 3270Mode or InputField)`);
      }
    };

    if (done()) return;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      if (done()) return;
    }
    throw new Error(`timed out waiting for ${args[0] ?? 'Unlock'}`);
  }
}

function splitTarget(target: string): [string, number] {
  const colon = target.lastIndexOf(':');
  if (colon < 0) return [target, 23];
  return [target.slice(0, colon), Number(target.slice(colon + 1))];
}
