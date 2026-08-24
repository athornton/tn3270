import { createConnection } from 'node:net';
import {
  Session, type Connection, AID, PF_AIDS, PA_AIDS, KeyboardState,
  CutTransfer, isCutFrame, type TransferResult, resolve,
} from '@tn3270/core';
import { parseCommand } from './commands.js';
import { formatStatus } from './status.js';
import { transferCommand, type TransferFiles, type TransferRequest } from './transfer.js';

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

/**
 * How long a whole `Transfer()` may take, and how long any one frame may take.
 *
 * BOTH ARE MANDATORY, for the reason Wait's own comment gives: without a timeout
 * a script against a host that stops answering hangs forever. A transfer needs
 * two of them because the two failures look different. A host that goes quiet
 * mid-file stalls one frame, and 30 s is generous for a round trip that has
 * already had a dozen predecessors; a host that keeps answering but never
 * finishes — the retransmit loop the design doc warns about — would refresh a
 * per-frame timer forever, so the overall cap is what bounds it.
 *
 * 600 s overall is sized off the protocol rather than picked: a download frame
 * carries at most 1909 bytes (MAX_DOWNLOAD_DATA) and each costs a round trip, so
 * a megabyte is around 550 frames. Both are overridable per Runner.
 */
const TRANSFER_TIMEOUT_MS = 600_000;
const TRANSFER_FRAME_TIMEOUT_MS = 30_000;

export interface RunnerOptions {
  clock?: () => number;
  /** Default Wait timeout in seconds. x3270 uses about 30. */
  defaultWaitSeconds?: number;
  /**
   * The file system, for `Transfer()`. Absent by default, and `Transfer()` then
   * fails the way `Replay()` does: this file deliberately imports no `node:fs`,
   * so that every command's semantics stay testable without a temp directory.
   * main.ts supplies the real one. See `TransferFiles`.
   */
  files?: TransferFiles;
  /** Overall Transfer() timeout in seconds. See TRANSFER_TIMEOUT_MS. */
  transferSeconds?: number;
  /** Per-frame Transfer() timeout in seconds. See TRANSFER_FRAME_TIMEOUT_MS. */
  transferFrameSeconds?: number;
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
  private readonly files: TransferFiles | undefined;
  private readonly transferMs: number;
  private readonly transferFrameMs: number;
  /** Bumped whenever the host writes, so Wait(Output) can observe it. */
  private outputCount = 0;

  constructor(private readonly session: Session, opts: RunnerOptions = {}) {
    this.clock = opts.clock ?? (() => Date.now());
    this.defaultWait = opts.defaultWaitSeconds ?? 30;
    this.files = opts.files;
    this.transferMs = opts.transferSeconds !== undefined
      ? opts.transferSeconds * 1000 : TRANSFER_TIMEOUT_MS;
    this.transferFrameMs = opts.transferFrameSeconds !== undefined
      ? opts.transferFrameSeconds * 1000 : TRANSFER_FRAME_TIMEOUT_MS;
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
          // Resolved colours alongside the raw cells, not instead of them: a
          // conformance comparison needs the bytes, a human debugging colour
          // needs the resolution, and dropping either would make one of those
          // impossible.
          resolved: resolve(snap),
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

      case 'Transfer':
        await this.transfer(args, data);
        return;

      case 'Wait':
        await this.wait(args);
        return;

      default:
        throw new Error(`unimplemented command: ${name}`);
    }
  }

  // -------------------------------------------------------------------------
  // Transfer()
  // -------------------------------------------------------------------------

  /**
   * `Transfer(keyword=value,...)` — drive one IND$FILE transfer to completion.
   *
   * ## THE SHAPE OF THIS, AND WHY IT FITS `dispatch` RATHER THAN FIGHTING IT
   *
   * Every other command here is one screen action; this is a multi-round-trip
   * conversation. It nonetheless belongs in the same place, because `dispatch` is
   * already `async` and `Wait()` already owns the pattern this needs: poll a
   * predicate over the session's state against a real-time deadline
   * (`this.wait`'s loop, and the note there on why it uses `Date.now` and not the
   * injectable clock). A transfer is that loop, with a state machine's `step`
   * instead of a boolean predicate. No new timing mechanism is introduced and no
   * event-driven observer is registered — the design doc's "observer, not a
   * session feature" applies to `Session`, which is untouched, and the runner is
   * the only thing subscribing to anything.
   *
   * The alternative — an `ftState` field on the Runner, stepped from the `screen`
   * event, with `Transfer()` returning immediately — was rejected: the s3270 line
   * protocol has no way to report a completion that arrives after the `ok`, so
   * every script would need a `Wait(TransferComplete)` that does not exist, and a
   * half-finished transfer would survive into the next command.
   *
   * ## THE ORDER OF OPERATIONS IS THE ERROR-HANDLING RULE
   *
   * The design doc: "A local file error — unreadable source, or destination
   * existing without `Exist=replace` — fails BEFORE the host command is typed, so
   * the host is never left sitting in transfer mode waiting for a client that has
   * already given up." So everything that can be checked locally is checked
   * first: the keywords, the geometry, the connection, the source file, the
   * destination. Only then does anything reach the host.
   */
  private async transfer(args: string[], data: string[]): Promise<void> {
    const { request, command } = transferCommand(args);
    const files = this.requireFiles();

    // GEOMETRY, before anything else. `isCutFrame` throws on a screen that is not
    // 24x80 (frames.ts `requireCutGeometry`, and the design doc's "GEOMETRY
    // COUPLING" section), and it is better to say so here than to have the first
    // poll of the loop throw it after the host has been told to start.
    if (this.session.screen.size !== 1920) {
      throw new Error(
        `Transfer(): CUT file transfer needs a 24x80 screen; this session is ` +
          `${this.session.screen.rows}x${this.session.screen.cols}`,
      );
    }
    if (!this.session.is3270Mode()) {
      // x3270's `ftUnableNot3270`, "not in 3270 mode" (fb-common:47).
      throw new Error('Transfer(): not in 3270 mode');
    }

    // The local side. For a send this reads the whole file into memory, which is
    // what the state machine wants anyway (`CutTransfer` takes the bytes up
    // front, so it can answer a retransmit without re-reading), and a file big
    // enough to matter would take hours over CUT regardless.
    let source: Uint8Array | undefined;
    if (request.direction === 'send') {
      try {
        source = files.read(request.localFile);
      } catch (err) {
        throw new Error(
          `Transfer(): cannot read local file ${request.localFile}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (request.exist === 'keep' && files.exists(request.localFile)) {
      // `if (p->receive_flag && !p->append_flag && !p->allow_overwrite) { ...
      // popup_an_error(AnTransfer "(): File exists"); }` (ft.c:666-674). Same
      // message as x3270's, with the path added because a script that transfers
      // several files needs to know which one.
      throw new Error(`Transfer(): file exists: ${request.localFile} (use Exist=replace or append)`);
    }

    const transfer = new CutTransfer({
      direction: request.direction,
      ...(source !== undefined ? { data: source } : {}),
    });

    // NOW the host is involved. Everything from here can leave it in transfer
    // mode, which is why nothing above could.
    this.primeAndType(command);
    this.session.sendAID(AID.ENTER);

    const result = await this.runTransferFrames(transfer);

    for (const warning of transfer.warnings) data.push(`Transfer(): ${warning}`);

    if (!result.ok) {
      // The host's own text, which `CutTransfer` has already substituted
      // `ftHostCancel` into if the host sent none. Thrown rather than pushed, so
      // the reply's last line is `error`.
      throw new Error(`Transfer(): ${result.error}`);
    }

    if (request.direction === 'receive') {
      // `result.data` is always present for a successful receive (`CutTransfer.
      // success()`), but the type allows its absence, and an empty file is a
      // legitimate transfer.
      const bytes = result.data ?? new Uint8Array(0);
      if (request.exist === 'append') files.append(request.localFile, bytes);
      else files.write(request.localFile, bytes);
    }

    // `ftComplete: Transfer complete, %i bytes transferred` (fb-common:31).
    data.push(`Transfer complete, ${transfer.bytesTransferred} bytes transferred`);
  }

  private requireFiles(): TransferFiles {
    if (this.files === undefined) {
      // The same division of labour as Replay(): this file imports no `node:fs`,
      // so main.ts injects the real implementation and a test injects an
      // in-memory one.
      throw new Error('Transfer() requires the file system; construct the Runner with a `files` option');
    }
    return this.files;
  }

  /**
   * Erase the input field and type the command into it. x3270's `kybd_prime`
   * (kybd.c:4367-4438), called from `ft_go` (ft.c:775).
   *
   * x3270 uses the return value as a capacity check — `if (flen <= 0 || flen <
   * vb_len(&r) - 1)` fails with `ftUnableTooSmall` (ft.c:776-801), the `- 1`
   * discounting the trailing newline it appends. We do the same test against the
   * command length, because a command truncated at the field boundary is a
   * command the host will reject in a way that looks like a protocol fault.
   *
   * ONE DIVERGENCE, stated because it is reachable. x3270 searches for the next
   * unprotected field starting AT THE CURSOR (`next_unprotected(cursor_addr)`,
   * kybd.c:4412); we fall back to the FIRST typable field on the screen
   * (`Keyboard.home`, which is `Screen.firstUnprotectedStart`). They differ only
   * when the cursor sits in a protected area of a screen with several input
   * fields, and on the panels that matter — a TSO READY prompt, a CMS command
   * line — there is exactly one. Going to the first field is also the safer of
   * the two guesses: it cannot wrap around into a field the operator was in the
   * middle of.
   */
  private primeAndType(command: string): void {
    const s = this.session.screen;
    const k = this.session.keyboard;

    if (this.session.oia.isInhibited()) {
      // x3270's `ftUnableLocked`, "keyboard locked" (fb-common:46). A script
      // should have reached a settled prompt with Wait(Settle) or
      // Wait(InputField) first.
      throw new Error('Transfer(): cannot begin transfer: keyboard locked');
    }

    // An unformatted screen has no fields to erase and no capacity to measure —
    // x3270 guesses at the run of nulls and spaces from the cursor
    // (kybd.c:4389-4403) and leaves it to the host to make sense of. We refuse
    // instead: IND$FILE is typed at a command prompt, every host that offers one
    // paints it as a field, and an unformatted screen at this point means the
    // script is somewhere it did not think it was — a VM/370 logon banner, say.
    // Failing here is recoverable; typing a transfer command into a logon screen
    // is not.
    if (!s.isFormatted()) {
      throw new Error('Transfer(): cannot begin transfer: no input field (screen is unformatted)');
    }

    const atCursor = s.fieldAt(s.cursor);
    const usable = atCursor !== null && !atCursor.protected && !s.isFieldAttribute(s.cursor)
      && atCursor.length > 0;
    if (usable) {
      k.moveCursor(atCursor.start);
    } else {
      k.home();
      const homed = s.fieldAt(s.cursor);
      if (homed === null || homed.protected) {
        // `ftUnableNoField`, "no input field" (fb-common:48).
        throw new Error('Transfer(): cannot begin transfer: no input field');
      }
    }

    const field = s.fieldAt(s.cursor);
    if (field === null || field.length < command.length) {
      // `ftUnableTooSmall`, "input field too small" (fb-common:49), with the two
      // numbers, because the operator's fix depends on which panel they are on.
      throw new Error(
        `Transfer(): cannot begin transfer: input field too small ` +
          `(${field?.length ?? 0} cells for a ${command.length}-character command)`,
      );
    }

    // "Erase it" (kybd.c:4430-4435): the whole field is nulled before typing, so
    // whatever the operator or the host left there does not become part of the
    // command. eraseEOF from the field start does exactly that, and sets MDT.
    k.eraseEOF();
    if (!k.typeString(command)) {
      // typeString stops at the first refusal and the OIA says why. Cannot
      // normally happen — the lock and the capacity are both checked above — but
      // a half-typed command must be reported, not sent.
      throw new Error(`Transfer(): input inhibited while typing the command (${this.session.oia.toText()})`);
    }
  }

  /**
   * The frame loop: wait for a CUT frame, step the machine, send its AID, repeat.
   *
   * `Date.now`, not `this.clock`, for the same reason `wait()` gives: the
   * injectable clock exists to make the status line deterministic, and driving a
   * real timeout from a frozen test clock would spin forever.
   *
   * TWO DEADLINES, because the two ways a transfer wedges look different — see
   * `TRANSFER_TIMEOUT_MS`. A timeout is reported as a failure rather than thrown,
   * so the caller's single "did it work" branch handles it, and it says that the
   * host may still be mid-transfer: we deliberately do NOT invent an abort
   * sequence here. x3270's abort writes the response area and presses PF2
   * (`cut_abort`, ft_cut.c:662-678), which is `CutTransfer`'s to do from a frame
   * it has parsed; synthesising one from the runner would put bytes on the wire
   * that no captured session contains, and the honest failure is better than an
   * untested guess. The operator's recovery is Attn or Clear, as it would be from
   * a real terminal.
   */
  private async runTransferFrames(transfer: CutTransfer): Promise<TransferResult> {
    const overallDeadline = Date.now() + this.transferMs;
    // The screen the host wrote most recently that we have already processed.
    // A frame is "new" only once the host has written again, otherwise the first
    // poll after an ack would re-process the frame still sitting in the buffer.
    let processedOutput = this.outputCount;

    for (;;) {
      const frameDeadline = Math.min(Date.now() + this.transferFrameMs, overallDeadline);
      while (this.outputCount === processedOutput || !isCutFrame(this.session.screen)) {
        if (Date.now() >= frameDeadline) {
          const why = Date.now() >= overallDeadline
            ? `did not complete within ${this.transferMs / 1000}s`
            : `no CUT frame from the host within ${this.transferFrameMs / 1000}s`;
          return {
            ok: false,
            error: `transfer ${why} after ${transfer.bytesTransferred} bytes; ` +
              `the host may still be in transfer mode (press Attn or Clear)`,
          };
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      processedOutput = this.outputCount;

      // `step` may mutate the screen — an abort response, or a whole upload frame
      // — and the AID it returns is what sends those bytes, so the two must not
      // be separated.
      const step = transfer.step(this.session.screen);
      if (step.ack !== undefined) this.session.sendAID(step.ack);
      if (step.done !== undefined) return step.done;
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
        // Both halves are needed, and the second was added with enter-inhibit.
        //
        // waitingForHost alone was sufficient while every host-imposed lock set
        // it — AwaitingFirstWrite on connect and SystemWait on an AID both do.
        // EnterInhibit does not: it is raised by answering a Query, which sends
        // no AID and is not the host writing, so nothing sets that flag and
        // Wait(Unlock) would return over a keyboard that still refuses input.
        // The next String() would then fail as "input inhibited" — the exact
        // failure mode the Wait(Settle) comment below records from a live run.
        //
        // x3270 blocks Wait(Unlock) on enter-inhibit: TS_WAIT_UNLOCK's test is
        // `if (KBWAIT) { return any; }` (Common/task.c:2276-2279), and
        // KBWAIT_MASK lists the bit — `#define KBWAIT_MASK (KL_OIA_LOCKED|
        // KL_OIA_TWAIT|KL_DEFERRED_UNLOCK|KL_ENTER_INHIBIT|KL_AWAITING_FIRST|
        // KL_FT|KL_BID)` (task.c:262).
        //
        // Deliberately tests EnterInhibit BY NAME rather than isInhibited(),
        // narrow to the one state that was missing. The broad version would
        // also start blocking on ProgramCheck, which today returns immediately
        // because programCheck() clears waitingForHost (session.ts:269) — and
        // blocking there would be wrong as well as out of scope, since only the
        // operator's Reset clears a program check, so the wait could do nothing
        // but burn its timeout. x3270's mask likewise omits the operator-error
        // bits (KL_OERR_MASK is absent from KBWAIT_MASK above) for that reason.
        case 'unlock':
          return !this.session.oia.waitingForHost
            && this.session.oia.keyboard !== KeyboardState.EnterInhibit;
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

/**
 * `host:port`, defaulting to 23. Exported because the TUI parses the same
 * argument and a second copy of this rule would be one to keep in step.
 *
 * `lastIndexOf` rather than `indexOf`, so a bare IPv6 literal loses only its
 * final group rather than everything after the first colon.
 */
export function splitTarget(target: string): [string, number] {
  const colon = target.lastIndexOf(':');
  if (colon < 0) return [target, 23];
  return [target.slice(0, colon), Number(target.slice(colon + 1))];
}
