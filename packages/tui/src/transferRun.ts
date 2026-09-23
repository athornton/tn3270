/**
 * Drive a CUT transfer from the TUI, event-driven rather than blocking.
 *
 * ## WHY NOT REUSE THE CLI'S LOOP
 *
 * `Runner.runTransferFrames` is `async` and polls inside a `for(;;)` with a 10ms sleep,
 * which suits a script that blocks until the transfer ends -- the s3270 line protocol has
 * no way to report a completion arriving after its `ok`. A TUI cannot block: the screen
 * underneath must keep repainting, and in CUT mode a transfer IS screen traffic, so the
 * user watches the frames go by. Same `CutTransfer`, same steps, driven from the `screen`
 * event instead of a sleep.
 *
 * ## THE ORDER OF OPERATIONS IS THE ERROR-HANDLING RULE
 *
 * Everything checkable locally is checked BEFORE the host is told anything: the geometry,
 * 3270 mode, the keyboard lock, the source file, the destination. A local error after the
 * host has been primed leaves it sitting in transfer mode waiting for a client that has
 * already given up -- which the operator then has to break out of by hand.
 *
 * The checks are in the CLI's order and that order is load-bearing, not incidental:
 * geometry comes before 3270 mode because on a model-4 session BOTH are wrong, and which
 * message the operator sees decides what they do. "Restart with -model 3278-2-E" is
 * actionable; "not in 3270 mode" sends them looking at the connection.
 *
 * ## WHAT IS DELIBERATELY NOT HERE
 *
 * No abort synthesised from a timeout. The CLI's comment gives the reason and it still
 * holds: an abort writes the response area and presses PF2 from a frame `CutTransfer` has
 * parsed, so inventing one here would put bytes on the wire that no captured session
 * contains. A timeout reports honestly that the host may still be mid-transfer. What IS
 * available now, and was not when the CLI was written, is `CutTransfer.cancel` for an abort
 * the OPERATOR asks for -- which is a different thing from one a deadline infers.
 */

import {
  AID, CUT_SCREEN_SIZE, CutTransfer, isCutFrame, type Session, type TransferResult,
} from '@tn3270/core';
import type { TransferFiles, TransferRequest } from '@tn3270/frontend';

/** The CLI's own defaults (`runner.ts:43-44`), so the two front ends wedge alike. */
const FRAME_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 600_000;

export interface TransferRun {
  readonly ok: boolean;
  readonly error?: string;
  /** Abort and tell the host. Absent when the run never started. */
  readonly cancel?: () => void;
}

export interface StartTransferOptions {
  /** `Session` from `@tn3270/core`, which is what `App` already holds. */
  session: Session;
  files: TransferFiles;
  request: TransferRequest;
  command: string;
  onProgress: (text: string) => void;
  onDone: (result: { ok: boolean; error?: string; bytes?: number }) => void;
  frameMs?: number;
  totalMs?: number;
}

/**
 * Start a transfer, or refuse it.
 *
 * Returns `{ ok: false, error }` for anything checkable locally, in which case nothing has
 * reached the host and `onDone` is never called -- the caller shows the error on the form.
 * Returns `{ ok: true, cancel }` once the command has been typed and Enter sent, after
 * which the outcome arrives through `onDone` exactly once.
 */
export function startTransfer(opts: StartTransferOptions): TransferRun {
  const { session, files, request, command, onProgress, onDone } = opts;
  const frameMs = opts.frameMs ?? FRAME_TIMEOUT_MS;
  const totalMs = opts.totalMs ?? TOTAL_TIMEOUT_MS;

  // GEOMETRY, before anything else. `isCutFrame` throws on a screen that is not 24x80
  // (`requireCutGeometry`), and it is better to say so here than to have the first frame
  // throw it after the host has been told to start.
  if (session.screen.size !== CUT_SCREEN_SIZE) {
    // NAMES THE REMEDY, not just the problem. `-model` is parsed once at launch and runtime
    // model-switching does not exist -- it is an unbuilt roadmap item -- so a user at
    // `-model 3278-4-E` cannot fix this from inside the running client. A message that only
    // reported the geometry would leave them stuck.
    //
    // THE REMEDY LEADS, AND A LIVE RUN IS WHAT PROVED IT HAD TO. The first version read
    // "CUT file transfer needs a 24x80 screen; this session is 43x80. Restart with -model
    // 3278-2-E, or wait for DFT." -- 109 characters against the form's 54-column status
    // line, so a real model-4 session showed "CUT file transfer needs a 24x80 screen; this
    // session >" and CUT OFF EVERY WORD OF THE REMEDY. The one thing the message exists to
    // carry was the one thing truncated, and no unit test saw it because they all read
    // `r.error` rather than what was drawn. Third instance on this branch, after the keypad
    // help string and the timeout message: on a 54-column line, put the action first.
    return {
      ok: false,
      error: `restart with -model 3278-2-E: CUT needs 24x80, not `
        + `${session.screen.rows}x${session.screen.cols} (DFT will lift this)`,
    };
  }
  if (!session.is3270Mode()) {
    // x3270's `ftUnableNot3270`, "not in 3270 mode" (fb-common:47).
    return { ok: false, error: 'not in 3270 mode' };
  }

  // The local side. For a send this reads the whole file into memory, which is what the
  // state machine wants anyway (`CutTransfer` takes the bytes up front so it can answer a
  // retransmit without re-reading), and a file big enough to matter would take hours over
  // CUT regardless.
  let source: Uint8Array | undefined;
  if (request.direction === 'send') {
    try {
      source = files.read(request.localFile);
    } catch (err) {
      return {
        ok: false,
        error: `cannot read local file ${request.localFile}: `
          + `${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else if (request.exist === 'keep' && files.exists(request.localFile)) {
    // `if (p->receive_flag && !p->append_flag && !p->allow_overwrite)` (ft.c:666-674), with
    // x3270's own "File exists" wording plus the path.
    return { ok: false, error: `file exists: ${request.localFile} (use Exist=replace or append)` };
  }

  // The keyboard and the field, which can also refuse -- and must, before the host is told.
  const primed = primeAndType(session, command);
  if (primed !== undefined) return { ok: false, error: primed };

  const transfer = new CutTransfer({
    direction: request.direction,
    ...(source !== undefined ? { data: source } : {}),
  });

  let ended = false;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = (): void => {
    if (frameTimer !== undefined) { clearTimeout(frameTimer); frameTimer = undefined; }
    if (totalTimer !== undefined) { clearTimeout(totalTimer); totalTimer = undefined; }
  };

  /**
   * End the run exactly once: drop the listener, kill both timers, report.
   *
   * `ended` guards against every way two endings could race -- a frame completing as a
   * deadline fires, or a cancel arriving as the last frame lands. Without it a cancelled run
   * would later report a timeout, OVERWRITING "cancelled" on a form the operator has already
   * closed, and `onDone` would run twice for one transfer.
   */
  const finish = (result: TransferResult): void => {
    if (ended) return;
    ended = true;
    // A LEAKED LISTENER PER TRANSFER is invisible except as wasted CPU, which is why
    // `Session.listenerCount` exists at all. Removed here because this is the one place a
    // run ends -- the same discipline as `Session.handleClose` owning TN3270E teardown.
    session.off('screen', onScreen);
    clearTimers();
    // NARROWED, not `result.error`: `TransferResult` is a DISCRIMINATED UNION
    // (`ft/transfer.ts:98`) and `error` exists only on the `ok: false` arm, so reading it
    // unconditionally does not typecheck. Caught by `npm run typecheck` with all 14 tests
    // green -- vitest does not typecheck, and a `result.error` on the success arm would have
    // been `undefined` at runtime anyway, so no test could have found it.
    onDone({
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error }),
      bytes: transfer.bytesTransferred,
    });
  };

  const timeout = (why: string): void => {
    // We deliberately do NOT abort here -- see the module comment. The operator's recovery
    // is Attn or Clear, as it would be from a real terminal, and the message says so because
    // otherwise their next keystroke goes into a host still waiting for a CUT frame.
    //
    // THE RECOVERY COMES FIRST, WHICH IS NOT COSMETIC. The TUI's status line is 54 columns
    // and truncates, so the CLI's word order -- reason, bytes, then "(press Attn or Clear)"
    // -- put the ONE ACTIONABLE PHRASE past the cut: the operator saw "transfer did not
    // complete within 600s after 0 bytes; " and nothing about what to do with a host still
    // in transfer mode. Measured: the message is 113 characters. Same shape as the help
    // string that did not fit in `transferOverlay.ts`, one layer down.
    finish({
      ok: false,
      error: `press Attn or Clear: host may still be transferring. `
        + `${why}, ${transfer.bytesTransferred} bytes`,
    });
  };

  /** Re-armed on every frame: the per-frame deadline measures the GAP, not the total. */
  const armFrameTimer = (): void => {
    if (frameTimer !== undefined) clearTimeout(frameTimer);
    frameTimer = setTimeout(
      () => { timeout(`stalled: no CUT frame from the host within ${frameMs / 1000}s`); },
      frameMs,
    );
  };

  /**
   * One frame.
   *
   * NO `outputCount` EQUIVALENT IS NEEDED, and that is the real simplification over the CLI:
   * its loop polls, so it must ask "has the host written since I last looked" to avoid
   * re-processing the frame still sitting in the buffer. An event fires once per host write,
   * so arriving here IS the freshness signal.
   */
  const onScreen = (): void => {
    if (ended) return;
    if (!isCutFrame(session.screen)) return;
    armFrameTimer();
    // `step` may mutate the screen -- an abort response, or a whole upload frame -- and the
    // AID it returns is what sends those bytes, so the two must not be separated.
    const step = transfer.step(session.screen);
    if (step.ack !== undefined) session.sendAID(step.ack);
    onProgress(`${transfer.bytesTransferred} bytes`);
    if (step.done !== undefined) {
      if (step.done.ok && request.direction === 'receive') {
        // `result.data` is always present for a successful receive (`CutTransfer.success`),
        // but the type allows its absence and an empty file is a legitimate transfer.
        const bytes = step.done.data ?? new Uint8Array(0);
        try {
          if (request.exist === 'append') files.append(request.localFile, bytes);
          else files.write(request.localFile, bytes);
        } catch (err) {
          // THE TRANSFER SUCCEEDED AND THE WRITE DID NOT. Reported as a failure, because a
          // "complete" that left no file on disk is the one outcome an operator must not be
          // told; the host is already out of transfer mode, so there is nothing to abort.
          finish({
            ok: false,
            error: `transfer complete but could not write ${request.localFile}: `
              + `${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
      finish(step.done);
    }
  };

  // NOW the host is involved. Everything from here can leave it in transfer mode, which is
  // why nothing above could.
  session.on('screen', onScreen);
  session.sendAID(AID.ENTER);
  armFrameTimer();
  totalTimer = setTimeout(
    () => { timeout(`did not complete within ${totalMs / 1000}s`); },
    totalMs,
  );

  return {
    ok: true,
    cancel: (): void => {
      if (ended) return;
      // ABORT, NOT ABANDON: `cancel` writes the response area and returns PF2, so the host
      // leaves transfer mode. Walking away would leave its program waiting for a frame that
      // never comes. `CutTransfer.cancel` is itself idempotent, and `ended` means we do not
      // rely on that -- a second call here does nothing at all.
      const step = transfer.cancel(session.screen);
      if (step.ack !== undefined) session.sendAID(step.ack);
      finish(step.done ?? { ok: false, error: 'transfer canceled by user' });
    },
  };
}

/**
 * Prime the field and type the command, or return why it could not be done.
 *
 * Ported from `Runner.primeAndType` (`runner.ts:551`) with its reasoning intact, returning a
 * message instead of throwing because this caller reports onto a form rather than into an
 * s3270 reply. **Every refusal here happens BEFORE the host is told anything**, which is why
 * it is called before `sendAID(ENTER)` and not merged into it.
 */
function primeAndType(session: Session, command: string): string | undefined {
  const s = session.screen;
  const k = session.keyboard;

  if (session.oia.isInhibited()) {
    // x3270's `ftUnableLocked`, "keyboard locked" (fb-common:46).
    return 'cannot begin transfer: keyboard locked';
  }

  // An unformatted screen has no fields to erase and no capacity to measure -- x3270 guesses
  // at the run of nulls and spaces from the cursor (kybd.c:4389-4403) and leaves it to the
  // host to make sense of. We refuse instead: IND$FILE is typed at a command prompt, every
  // host that offers one paints it as a field, and an unformatted screen here means the
  // operator is somewhere they did not think they were -- a VM/370 logon banner, say.
  // Failing is recoverable; typing a transfer command into a logon screen is not.
  if (!s.isFormatted()) {
    return 'cannot begin transfer: no input field (screen is unformatted)';
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
      return 'cannot begin transfer: no input field';
    }
  }

  const field = s.fieldAt(s.cursor);
  if (field === null || field.length < command.length) {
    // `ftUnableTooSmall`, "input field too small" (fb-common:49), with both numbers, because
    // the operator's fix depends on which panel they are on.
    return `cannot begin transfer: input field too small `
      + `(${field?.length ?? 0} cells for a ${command.length}-character command)`;
  }

  // "Erase it" (kybd.c:4430-4435): the whole field is nulled before typing, so whatever the
  // operator or the host left there does not become part of the command.
  k.eraseEOF();
  if (!k.typeString(command)) {
    // typeString stops at the first refusal and the OIA says why. Cannot normally happen --
    // the lock and the capacity are both checked above -- but a half-typed command must be
    // reported, not sent.
    return `input inhibited while typing the command (${session.oia.toText()})`;
  }
  return undefined;
}
