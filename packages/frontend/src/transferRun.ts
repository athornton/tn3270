/**
 * Drive a CUT transfer event-driven rather than blocking, for any front end that cannot
 * block: the TUI today, and the GUI and web gateway when they grow a transfer UI.
 *
 * ## WHY IT LIVES IN `frontend` AND NOT IN `tui`
 *
 * It was written for the TUI and sat in `packages/tui` for that reason alone. But its
 * justification below -- "a TUI cannot block" -- is equally true of a GUI and of a web
 * gateway, and both already declare `@tn3270/frontend`. There are TWO genuine control
 * flows here, not four: the CLI's blocking poll-until-done (the s3270 line protocol
 * cannot report a completion arriving after its `ok`) and this one, which the other three
 * front ends all want. Keeping it here is what stops the DFT arm being written four
 * times.
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
 * Everything checkable locally is checked BEFORE the host is told anything: 3270 mode, the
 * keyboard lock, the source file, the destination. A local error after the host has been
 * primed leaves it sitting in transfer mode waiting for a client that has already given up
 * -- which the operator then has to break out of by hand.
 *
 * The checks are in the CLI's order. Geometry is NO LONGER AMONG THEM: under
 * host-chooses-the-protocol we cannot know CUT was chosen until the host answers, so the
 * 24x80 demand moved to the decision point (see `docs/superpowers/specs/
 * 2026-09-25-transfer-protocol-selection-design.md`). The accepted cost is that a CUT-only
 * host at 43x80 is now primed before we find out; measured on VM/370, MECAFF refuses with
 * its own text in about a second and CMS recovers itself, so nothing wedges.
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
  AID, CUT_SCREEN_SIZE, CutTransfer, DftTransfer, isCutFrame,
  type Session, type TransferResult,
} from '@tn3270/core';
import type { TransferFiles, TransferRequest } from './transfer.js';

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

  // BOTH ENGINES, over the SAME source buffer. The host chooses the protocol, not us
  // (x3270's `ft_running` merely REPORTS which arrived, ft.c:556), so we cannot know
  // which we need until the first frame lands. Both need their source bytes up front
  // anyway -- CUT to answer a retransmit, DFT to answer a GET -- so this is one extra
  // object over one Uint8Array, not a second copy.
  const cut = new CutTransfer({
    direction: request.direction,
    ...(source !== undefined ? { data: source } : {}),
  });
  const dft = new DftTransfer({
    direction: request.direction,
    ...(source !== undefined ? { data: source } : {}),
  });

  // REGISTERED BEFORE THE HOST IS TOLD ANYTHING, and the order is load-bearing: a fast
  // host's first 0xd0 arrives from inside `handleRecord`, before any driver code runs
  // again, and `handleTransferData` needs a registered transfer at that moment. Doing
  // this after sendAID(ENTER) would lose the first frame of a fast transfer to a race.
  session.startDftTransfer(dft);

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
      bytes: cut.bytesTransferred,
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
        + `${why}, ${cut.bytesTransferred} bytes`,
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
    const step = cut.step(session.screen);
    if (step.ack !== undefined) session.sendAID(step.ack);
    onProgress(`${cut.bytesTransferred} bytes`);
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
      // RELEASE THE DFT REGISTRATION FIRST. This driver now registers a DFT engine before
      // priming the host, and on a cancelled run the host never addressed it -- so it is
      // DISCARDED rather than aborted, which is exactly `cancelDftTransfer`'s documented
      // case ("the loser of a protocol race", `session.ts:367`). Without this a cancelled
      // run leaves `session.dft` set, and `answerRead` would replay its retained frame at a
      // host that has moved on. `handleClose` clears `dft` too, but a form closed on a live
      // session never reaches it.
      session.cancelDftTransfer();

      // A CUT ABORT IS ONLY POSSIBLE AT 24x80, AND DELETING THE GEOMETRY GATE IS WHAT MADE
      // THAT REACHABLE -- a defect this task introduced and the plan did not predict.
      // `CutTransfer.cancel` writes the response area through `writeResponse`, which calls
      // `requireCutGeometry` and THROWS `CutFrameError` on any other geometry
      // (`frames.ts:314`). The gate used to guarantee this line was never reached at 43x80;
      // now it is, and the throw escaped uncaught into the TUI's form-close path.
      //
      // Reported, not aborted, and that is the honest answer rather than the convenient
      // one: there is no CUT frame layout to write into at this geometry, and the host has
      // not told us it is running CUT. Inventing an abort would put bytes on the wire that
      // no captured session contains -- the same rule this module already gives for
      // refusing to synthesise one from a timeout.
      if (session.screen.size !== CUT_SCREEN_SIZE) {
        finish({ ok: false, error: 'transfer canceled by user' });
        return;
      }
      // ABORT, NOT ABANDON: `cancel` writes the response area and returns PF2, so the host
      // leaves transfer mode. Walking away would leave its program waiting for a frame that
      // never comes. `CutTransfer.cancel` is itself idempotent, and `ended` means we do not
      // rely on that -- a second call here does nothing at all.
      const step = cut.cancel(session.screen);
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
