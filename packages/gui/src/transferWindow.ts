import type { StartTransferOptions, TransferRequest, TransferRun } from '@tn3270/frontend';

/**
 * The transfer window's main-side logic, with Electron INJECTED.
 *
 * `BrowserWindow`, `dialog` and `ipcMain` cannot be constructed outside an Electron process, and
 * none of the decisions here are Electron's: which dialog a direction wants, whether a close may
 * proceed, and -- the one that earns this file -- that `cancel` is reached on EVERY path that
 * ends a transfer.
 *
 * ## THE TEARDOWN RULE, WRITTEN DOWN BECAUSE IT HAS BITTEN THIS PROJECT THREE TIMES
 *
 * `packages/core/src/session.ts` has been fixed three times for one shape: *one teardown path
 * clears the state and another does not* (`Session.e` cleared only on the REJECT path, then
 * `IAC DONT TN3270E` taking a generic arm, then `handleClose` not clearing `dft`). A window adds
 * new ways for a transfer to end that a TUI overlay never had -- the red button, Cmd-W, Cmd-Q,
 * the session closing underneath. Every one of them must reach `cancel`, because ABANDONING a
 * transfer leaves the host's program waiting for a frame that never comes, where ABORTING tells
 * it to stop.
 *
 * `TransferRun.cancel` already knows the hard parts and needs no help: it defers to the engine
 * for a DFT transfer that has started, discards one that lost the protocol race without sending
 * anything, and refuses a CUT abort at a geometry with no frame layout to write into. So this
 * file adds no cancellation logic -- only the guarantee that the existing one is called.
 *
 * ## ONE STATE WORD, NOT TWO, AND THAT IS THE FOURTH INSTANCE PRE-EMPTED
 *
 * The run and the running flag are the SAME FACT, so they are one variable. The plan's draft kept
 * `run` and `isRunning` separately and got them out of step on its very first path -- see
 * `startRun` below for the measurement. Two words for one fact is precisely the `session.ts`
 * shape quoted above; collapsing them is what makes "every teardown path clears the state"
 * structurally true rather than a thing each path has to remember.
 */

export interface TransferDeps {
  /** Send to the transfer window's renderer. */
  send(channel: 'transfer:progress' | 'transfer:done', payload: unknown): void;
  /**
   * Bring the window forward, so the operator SEES the form and its enabled Cancel button.
   *
   * NAMED FOR WHAT IT DOES. The plan called this `focusCancel` and documented it as focusing the
   * Cancel button, but its only implementation was `webContents.focus()` -- the web contents as a
   * whole, which does not move focus to any particular control. Focusing the button itself would
   * need a sixth bridge function and a renderer-side handler, i.e. a new IPC channel and a new
   * decision in `transferBoot.ts` (the file whose whole discipline is that it contains no
   * decisions), to replace a thing the operator can already see: `Cancel` is the one enabled
   * button on the form while a transfer runs, because `setRunning(true)` disables everything else
   * (`transferUi.ts`'s `setRunning` and `transferBoot.ts:239-246`). So the window comes forward
   * and the form says the rest. A comment claiming a focus that does not happen is worse than
   * either.
   */
  focusWindow(): void;
  /** Native Open dialog: resolves to a path, or undefined if canceled. */
  openDialog(): Promise<string | undefined>;
  /** Native Save dialog: resolves to a path, or undefined if canceled. */
  saveDialog(): Promise<string | undefined>;
  /**
   * `startTransfer` from `@tn3270/frontend`, ALREADY BOUND to this process's session and files.
   *
   * NARROWER THAN `StartTransferOptions` ON PURPOSE, and the plan got this wrong once: that
   * interface REQUIRES `session` and `files` (`transferRun.ts:65-75`), which this controller
   * does not have and must not have -- it is the Electron-free half. Taking the full type here
   * would force a lying `as StartTransferOptions` cast at the call site. `main.ts` owns the
   * session and closes over both, so the two omitted fields are supplied there.
   *
   * **MAY CALL `onDone` BEFORE IT RETURNS.** See `startRun`; everything about the ordering below
   * follows from it.
   */
  startTransfer(opts: Omit<StartTransferOptions, 'session' | 'files'>): TransferRun;
  /** `transferCommand` from `@tn3270/frontend`. THROWS on invalid keywords. */
  buildCommand(keywords: readonly string[]): { request: TransferRequest; command: string };
}

export interface TransferController {
  running(): boolean;
  browse(direction: string): Promise<string | undefined>;
  submit(keywords: readonly string[]): Promise<{ ok: boolean; error?: string }>;
  requestCancel(): void;
  /** True while a close must be refused. */
  shouldPreventClose(): boolean;
  onCloseAttempt(): void;
  /** App quit, or the session going away: cancel rather than block. */
  shutdown(): void;
}

export function createTransferController(deps: TransferDeps): TransferController {
  /**
   * The run in flight, or `undefined` when nothing is running. ONE WORD FOR ONE FACT.
   *
   * `running()` is `run !== undefined`, so there is no second flag that can disagree with it --
   * see the module docstring. A run that has ENDED is cleared here, which is why `cancel` can
   * never be called on a dead one.
   */
  let run: TransferRun | undefined;

  /**
   * How many transfers have been STARTED, used as the identity of the current one.
   *
   * THE GENERATION IS WHAT MAKES A LATE `onDone` HARMLESS. `TransferRun.cancel`'s DFT arm
   * DEFERS -- `DftTransfer.cancel` sets a flag and acts on the next inbound frame
   * (`transferRun.ts:399-406`, citing `dft.ts:186-188`) -- so an ending can arrive after
   * `shutdown` has already cleared the state, and in principle after a LATER transfer has begun.
   * Comparing the generation means such an ending reports itself and stops, instead of clearing a
   * run it is not about. (`transferRun.ts`'s own `ended` guard, at `:180-181`, promises `onDone`
   * fires at most once PER RUN; it says nothing about two runs, which is this counter's job.)
   */
  let generation = 0;

  /**
   * End the current run, if the ending belongs to it, and tell the window either way.
   *
   * NOT PART OF THE PUBLIC INTERFACE. The plan exported a `finish` member; nothing in `main.ts`
   * called it, and the only ending there is `onDone`'s -- so a public `finish` was a second
   * teardown route with no caller, which is the exact shape the module docstring is about.
   * Removed rather than left as an invitation.
   */
  const finish = (
    forGeneration: number,
    result: { ok: boolean; error?: string; bytes?: number },
  ): void => {
    if (forGeneration === generation) run = undefined;
    deps.send('transfer:done', result);
  };

  /**
   * Hand the driver its work and record the run -- ORDERING FIRST, CALL SECOND.
   *
   * ## THE BUG THIS SHAPE EXISTS TO PREVENT, MEASURED IN THE SOURCE
   *
   * `startTransfer` CAN CALL `onDone` BEFORE IT RETURNS. A whole DFT transfer can begin and
   * finish inside `session.sendAID(AID.ENTER)`'s record handling; the listeners are registered
   * BEFORE that send precisely so it works (`transferRun.ts:358-361` says so in as many words),
   * and the next statement is `if (ended) return { ok: true };` (`transferRun.ts:377`) -- a run
   * with NO `cancel` on it, because there is nothing left to cancel.
   * `tui/test/transferRun.test.ts:689-718` drives that case against a real `Session` and asserts
   * the completion lands with no `await` in between.
   *
   * The plan's draft assigned `run`/`isRunning` AFTER the call, so a synchronous `onDone` ran
   * `finish()` first and the assignment then armed the flag on a transfer that had ALREADY ENDED.
   * `shouldPreventClose()` would be true forever: the close guard refuses every Cmd-W and red
   * button, Start is refused for the rest of the window's life, and the app has to be killed.
   *
   * The fix is not an ordering convention anybody has to remember. `generation` is bumped and the
   * placeholder stored BEFORE the call, so a synchronous `onDone` matches the current generation
   * and clears it; the assignment afterwards is then CONDITIONAL on the run still being the one
   * this call started. A run that ended inside the call is left cleared.
   */
  const startRun = (
    /**
     * Builds the driver's options from the generation this run will have.
     *
     * A CALLBACK AND NOT A PLAIN OPTIONS OBJECT, because the generation has to reach `onDone` and
     * the only honest way to hand it over is to let this function allocate it. The first draft of
     * this file had `submit` write `generation + 1`, which is the same number arrived at by
     * guessing what `startRun` would do next -- two places agreeing by arithmetic about one fact,
     * which is the drift this module's docstring is about.
     */
    build: (forGeneration: number) => Omit<StartTransferOptions, 'session' | 'files'>,
  ): TransferRun => {
    generation += 1;
    const mine = generation;
    // A PLACEHOLDER, so `running()` is true for the duration of the call: that is what makes a
    // synchronous `onDone` find a run to clear, and what keeps a reentrant `submit` from the
    // renderer out. It carries no `cancel`, which is honest -- there is nothing to cancel until
    // the driver hands one back.
    run = { ok: true };
    const started = deps.startTransfer(build(mine));
    // CONDITIONAL. If `onDone` already fired, `run` is `undefined` and must STAY undefined --
    // overwriting it here is the plan's bug restated.
    if (run !== undefined && mine === generation) run = started;
    return started;
  };

  /**
   * Cancel the run and stop holding it, swallowing a throw from the driver.
   *
   * `cancel` CAN THROW, and that is not hypothetical: its CUT arm calls `session.sendAID`
   * (`transferRun.ts:437-438`) and `Session.sendAID` throws `Error('not connected')` once the
   * socket is gone (`core/src/session.ts:1513`). So a session that dropped mid-transfer plus a
   * Cmd-Q is a throw out of `app.on('before-quit')` -- which would make the application
   * unquittable, the one outcome this module's own justification forbids. The run is dropped
   * either way, because a cancel that could not be delivered has still ended our interest in it.
   *
   * Returns the failure text, if there was one, for the caller to report or discard.
   */
  const cancelRun = (): string | undefined => {
    const r = run;
    run = undefined;
    if (r?.cancel === undefined) return undefined;
    try {
      r.cancel();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  return {
    running: () => run !== undefined,

    async browse(direction) {
      // A SEND must choose a file that exists; a RECEIVE names a destination that need not.
      // The dialog returns a PATH ONLY and never sets `Exist`: that is a three-way choice
      // (`keep`/`replace`/`append`) whose `append` has no dialog equivalent at all, so letting
      // the chooser decide would make a legal transfer unexpressible. See the spec.
      //
      // NO `running` CHECK, deliberately: `transferUi.ts`'s `browseLocal` guards on BOTH sides of
      // its own `await`, and the second of those checks is the measured fix for a non-modal
      // dialog resolving mid-transfer. Refusing here as well would hide that guard from its own
      // tests without covering anything the form does not already cover.
      return direction === 'send' ? deps.openDialog() : deps.saveDialog();
    },

    async submit(keywords) {
      // ONE SESSION, ONE TRANSFER. Two would interleave two machines' frames on one screen and
      // the host is answering only one of them.
      if (run !== undefined) return { ok: false, error: 'a transfer is already running' };

      // THE VALIDATOR IS THE AUTHORITY, and it throws. `transferForm.ts` states the rule: the
      // form collects strings and `parseTransferKeywords` decides. Catching here is what lets
      // the form show the validator's own message rather than a guess of ours.
      let built;
      try {
        built = deps.buildCommand(keywords);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      // NO CAST. `TransferDeps.startTransfer` is declared as
      // `Omit<StartTransferOptions, 'session' | 'files'>` precisely so these four fields are the
      // whole of what this Electron-free half supplies; `main.ts` adds the session and the files.
      //
      // `mine` IS CAPTURED FOR THE CALLBACKS and not read from the closure: by the time a late
      // `onDone` arrives, `generation` may belong to a different transfer. See `startRun`, which
      // hands the number over rather than letting this call site compute it.
      const started = startRun((mine) => ({
        request: built.request,
        command: built.command,
        onProgress: (text) => { deps.send('transfer:progress', text); },
        onDone: (result) => { finish(mine, result); },
      }));

      // A LOCAL REFUSAL MEANS THE HOST WAS TOLD NOTHING, and `onDone` will never fire for it --
      // `startTransfer` returns `{ ok: false, error }` for everything checkable locally (3270
      // mode, the keyboard lock, the input field, the source file, the destination). So the
      // answer goes back through this return value and the form stays open and populated. NO
      // `transfer:done` is sent: inventing an ending for a transfer that never began would make
      // the renderer's `finished()` overwrite the refusal with 'transfer failed'.
      if (!started.ok) {
        // CLEARED, because `startRun` armed the placeholder before the call and this run never
        // happened. Without this the window would refuse to close over a refusal.
        run = undefined;
        return { ok: false, error: started.error ?? 'transfer refused' };
      }

      return { ok: true };
    },

    requestCancel() {
      // `cancel` is absent when the run never started; calling it is the only route out of a
      // running transfer, since the window refuses to close.
      if (run === undefined) return;
      const failed = cancelRun();
      // REPORTED, not swallowed. The form is showing 'transferring' with every other control
      // disabled, so a cancel that silently failed would leave the operator nothing to press --
      // the same dead end as a window that will not close. `onDone` cannot rescue this: the
      // throw happened on the way to it.
      if (failed !== undefined) {
        deps.send('transfer:done', { ok: false, error: `could not cancel the transfer: ${failed}` });
      }
    },

    shouldPreventClose: () => run !== undefined,

    onCloseAttempt() {
      // REFUSED, NOT QUEUED. An accidental Cmd-W or red button must not abandon a transfer, so
      // the close does nothing except bring forward the form, whose only enabled control is the
      // Cancel button that ends it properly.
      deps.focusWindow();
    },

    shutdown() {
      // QUIT CANCELS, IT DOES NOT BLOCK. The window may refuse a close; it may not make the
      // application unquittable. Canceling first is what tells the host to leave transfer mode
      // rather than leaving its program waiting for a frame -- the abort/abandon distinction
      // this module's docstring turns on.
      //
      // NO `transfer:done` IS SENT, and that is a decision rather than an omission. This runs on
      // `app.on('before-quit')`, after which every renderer in the process is torn down, so the
      // message would arrive at a window that is going away -- and `requestCancel`'s report
      // exists for the case where a human is still looking. A failed cancel is therefore
      // DISCARDED here: there is nobody left to tell, and throwing would be the unquittable app.
      cancelRun();
    },
  };
}
