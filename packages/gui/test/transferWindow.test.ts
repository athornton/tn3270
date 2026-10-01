import { describe, it, expect, vi } from 'vitest';
import { createTransferController, type TransferDeps } from '../src/transferWindow.js';
import type { StartTransferOptions, TransferRun } from '@tn3270/frontend';

/**
 * Electron is FAKED, entirely. `BrowserWindow`, `dialog` and `ipcMain` cannot be constructed
 * outside an Electron process, and the logic worth testing here is not Electron's -- it is the
 * close guard, the one-transfer rule and the guarantee that `cancel` is reached on every path
 * that ends a transfer.
 *
 * THAT LAST ONE IS WHY THIS FILE EXISTS. `packages/core/src/session.ts` has been fixed THREE
 * times for the shape "one teardown path clears the state and another does not" (`Session.e` on
 * the REJECT path, `IAC DONT TN3270E`, and `handleClose` not clearing `dft`). A window adds new
 * ways to end a transfer -- the red button, Cmd-W, Cmd-Q -- so the fourth instance is waiting
 * here unless it is asserted.
 */

/** What the controller hands `startTransfer`. Narrowed to the two callbacks a test drives. */
type StartedWith = Omit<StartTransferOptions, 'session' | 'files'>;

/**
 * The options the controller passed to `startTransfer` on its Nth call.
 *
 * A HELPER RATHER THAN THE PLAN'S INLINE CAST, which spelled out a four-deep `mock.calls`
 * generic at every use site and had to be re-spelled for each callback it wanted. One cast,
 * named, and the callbacks come back fully typed.
 */
function startedWith(d: TransferDeps, n = 0): StartedWith {
  const calls = (d.startTransfer as unknown as { mock: { calls: Array<[StartedWith]> } })
    .mock.calls;
  const call = calls[n];
  if (call === undefined) throw new Error(`startTransfer was not called ${n + 1} time(s)`);
  return call[0];
}

/**
 * A COMPLETE `TransferRequest`, which the plan's fixture was not.
 *
 * `TransferRequest` requires `host`, `mode` and `cr` as well (`frontend/src/transfer.ts:76-84`);
 * the plan's literal supplied four of seven required fields. Nothing CAUGHT it -- `packages/gui`
 * typechecks `src/**` only, so no test file in this repo is typechecked at all, and vitest does
 * not typecheck either -- which is exactly why it is written correctly here rather than left to
 * a gate that does not exist.
 */
const REQUEST = Object.freeze({
  direction: 'receive', localFile: '/tmp/a', hostFile: 'A',
  host: 'tso', mode: 'binary', cr: 'auto', exist: 'keep',
} as const);

function deps(over: Partial<TransferDeps> = {}): TransferDeps & {
  readonly sent: Array<[string, unknown]>;
} {
  const sent: Array<[string, unknown]> = [];
  const base: TransferDeps = {
    send: (channel, payload) => { sent.push([channel, payload]); },
    focusWindow: vi.fn(),
    openDialog: vi.fn(async () => '/tmp/open.txt'),
    saveDialog: vi.fn(async () => '/tmp/save.txt'),
    startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel: vi.fn() })),
    buildCommand: vi.fn((keywords: readonly string[]) => ({
      request: { ...REQUEST },
      command: `IND$FILE GET A (${keywords.join(' ')}`,
    })),
    ...over,
  };
  return Object.assign(base, { sent });
}

describe('createTransferController', () => {
  it('picks the OPEN dialog for a send and the SAVE dialog for a receive', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.browse('send');
    expect(d.openDialog).toHaveBeenCalled();
    expect(d.saveDialog).not.toHaveBeenCalled();
    await c.browse('receive');
    expect(d.saveDialog).toHaveBeenCalled();
  });

  it('reports a keyword validation error as a local refusal, telling the host nothing', async () => {
    const d = deps({
      buildCommand: vi.fn(() => { throw new Error('missing LocalFile'); }),
    });
    const c = createTransferController(d);
    const r = await c.submit(['Direction=receive']);
    expect(r).toEqual({ ok: false, error: 'missing LocalFile' });
    expect(d.startTransfer, 'a validation failure must not reach the host').not.toHaveBeenCalled();
  });

  it('passes a driver refusal straight through, without going running', async () => {
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: false, error: 'keyboard locked' })) });
    const c = createTransferController(d);
    const r = await c.submit(['Direction=receive']);
    expect(r).toEqual({ ok: false, error: 'keyboard locked' });
    expect(c.running()).toBe(false);
    // AND THE FORM STAYS OPEN RATHER THAN BEING TOLD THE TRANSFER ENDED. `onDone` never fires
    // for a local refusal (`transferRun.ts:80-82`), so a `transfer:done` here would be the
    // controller inventing an ending for a transfer that never began -- and the renderer's
    // `finished()` would overwrite the refusal with 'transfer failed'.
    expect(d.sent).toEqual([]);
  });

  it('a driver refusal that names no reason still gets a message', async () => {
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: false })) });
    const c = createTransferController(d);
    expect(await c.submit([])).toEqual({ ok: false, error: 'transfer refused' });
  });

  it('is running once the driver accepted, and refuses a second submit', async () => {
    const d = deps();
    const c = createTransferController(d);
    expect((await c.submit([])).ok).toBe(true);
    expect(c.running()).toBe(true);
    const second = await c.submit([]);
    expect(second.ok).toBe(false);
    expect(d.startTransfer).toHaveBeenCalledTimes(1);
  });

  it('REFUSES to close while running, and focuses the window instead', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    expect(c.shouldPreventClose()).toBe(true);
    c.onCloseAttempt();
    expect(d.focusWindow).toHaveBeenCalled();
  });

  it('allows the close once nothing is running', async () => {
    const d = deps();
    const c = createTransferController(d);
    expect(c.shouldPreventClose()).toBe(false);
    await c.submit([]);
    // ENDED THROUGH THE DRIVER, which is the only route there is. The plan drove this with a
    // public `finish` member; that member had no caller in `main.ts` either, so it was a dead
    // part of the interface whose only user was this line -- and driving `onDone` instead
    // exercises the path a real completion takes.
    startedWith(d).onDone({ ok: true, bytes: 5 });
    expect(c.shouldPreventClose()).toBe(false);
  });

  it('CANCELS on quit rather than blocking it', async () => {
    const cancel = vi.fn();
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel })) });
    const c = createTransferController(d);
    await c.submit([]);
    c.shutdown();
    expect(cancel, 'quit must tell the host, not leave it waiting for a frame').toHaveBeenCalled();
  });

  it('shutdown is safe with no transfer running', () => {
    const d = deps();
    const c = createTransferController(d);
    expect(() => { c.shutdown(); }).not.toThrow();
  });

  it('shutdown does not cancel twice if it is called twice', async () => {
    const cancel = vi.fn();
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel })) });
    const c = createTransferController(d);
    await c.submit([]);
    c.shutdown();
    c.shutdown();
    // `TransferRun.cancel` is itself idempotent (`transferRun.ts:388`), so a second call is
    // harmless -- but a controller that still HELD the run after quitting would also still
    // report `shouldPreventClose()`, which is the state this asserts about.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(c.shouldPreventClose()).toBe(false);
  });

  /**
   * A `cancel` THAT THROWS MUST NOT MAKE THE APPLICATION UNQUITTABLE.
   *
   * REACHABLE, not hypothetical. `TransferRun.cancel`'s CUT arm calls `session.sendAID`
   * (`transferRun.ts:437-438`), and `Session.sendAID` throws `Error('not connected')` when the
   * socket has gone (`core/src/session.ts:1513`). So a session that dropped mid-CUT-transfer and
   * an operator who then presses Cmd-Q is a throw out of `app.on('before-quit')` -- which is the
   * one thing this method's whole justification forbids ("the window may refuse a close; it may
   * not make the application unquittable").
   */
  it('a cancel that THROWS still leaves the app quittable', async () => {
    const cancel = vi.fn(() => { throw new Error('not connected'); });
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel })) });
    const c = createTransferController(d);
    await c.submit([]);
    expect(() => { c.shutdown(); }).not.toThrow();
    expect(c.shouldPreventClose(), 'a failed cancel must not leave the close guard armed')
      .toBe(false);
  });

  /**
   * The same throw on the OPERATOR's route out, where it must be ANSWERED and not only swallowed.
   *
   * `requestCancel` is the only way out of a running transfer, because the window refuses to
   * close. A silent throw there leaves the form showing 'transferring' with nothing the operator
   * can press, which is the window-cannot-be-closed failure wearing a different hat.
   */
  it('a requestCancel whose cancel throws reports the failure and clears running', async () => {
    const cancel = vi.fn(() => { throw new Error('not connected'); });
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel })) });
    const c = createTransferController(d);
    await c.submit([]);
    expect(() => { c.requestCancel(); }).not.toThrow();
    expect(c.running()).toBe(false);
    expect(d.sent).toContainEqual(['transfer:done',
      { ok: false, error: 'could not cancel the transfer: not connected' }]);
  });

  it('requestCancel is safe with nothing running', () => {
    const d = deps();
    const c = createTransferController(d);
    expect(() => { c.requestCancel(); }).not.toThrow();
    expect(d.sent).toEqual([]);
  });

  it('requestCancel reaches the run that is actually going', async () => {
    const cancel = vi.fn();
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel })) });
    const c = createTransferController(d);
    await c.submit([]);
    c.requestCancel();
    expect(cancel).toHaveBeenCalled();
  });

  it('forwards progress and the final result to the window', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    // The driver's callbacks were handed to it by the controller; drive them as it would.
    const opts = startedWith(d);
    opts.onProgress('128 bytes');
    expect(d.sent).toContainEqual(['transfer:progress', '128 bytes']);
    opts.onDone({ ok: true, bytes: 128 });
    expect(d.sent).toContainEqual(['transfer:done', { ok: true, bytes: 128 }]);
    expect(c.running()).toBe(false);
  });

  it('a completion through the driver clears running, so the window can close', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    startedWith(d).onDone({ ok: false, error: 'aborted' });
    expect(c.running()).toBe(false);
    expect(c.shouldPreventClose()).toBe(false);
  });

  it('hands the driver the validator\'s request and command, unaltered', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit(['Direction=receive', 'HostFile=A']);
    const opts = startedWith(d);
    expect(opts.request).toEqual(REQUEST);
    expect(opts.command).toBe('IND$FILE GET A (Direction=receive HostFile=A');
  });

  it('a non-Error thrown by the validator is still reported as text', async () => {
    const d = deps({ buildCommand: vi.fn(() => { throw 'not an Error'; }) });
    const c = createTransferController(d);
    expect(await c.submit([])).toEqual({ ok: false, error: 'not an Error' });
  });

  /**
   * ## THE ORDERING INVARIANT: A TRANSFER THAT ENDS *INSIDE* `startTransfer`
   *
   * THIS IS THE TEST THE PLAN'S DRAFT WOULD HAVE FAILED, and the failure mode is a window that
   * can never be closed and an application that has to be killed.
   *
   * `startTransfer` CAN call `onDone` before it returns, and that is not a hypothetical: a whole
   * DFT transfer can begin and finish inside `session.sendAID(AID.ENTER)`'s record handling, the
   * listeners are registered BEFORE that send precisely so it works (`transferRun.ts:358-361`),
   * and the function then returns a run with NO `cancel` at all (`transferRun.ts:377`:
   * `if (ended) return { ok: true };`). `tui/test/transferRun.test.ts:689-718` drives exactly
   * that case against a real `Session` and asserts the completion arrives with no `await`.
   *
   * The plan's draft set `isRunning = true` AFTER the call, so a synchronous `onDone` ran
   * `finish()` first and the assignment then re-armed the flag on a transfer that had already
   * ended: `shouldPreventClose()` true forever, the close guard refusing every Cmd-W, and
   * `requestCancel` holding a dead run.
   */
  it('a transfer that ENDS INSIDE startTransfer leaves the controller NOT running', async () => {
    const d = deps({
      // Exactly `transferRun.ts:372-377`: the callback fires from inside the call, and the
      // returned run carries no `cancel` because there is nothing left to cancel.
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: true, bytes: 3 });
        return { ok: true };
      }),
    });
    const c = createTransferController(d);
    const r = await c.submit([]);
    expect(r.ok).toBe(true);
    expect(c.running(), 'a transfer that already ended is not running').toBe(false);
    expect(c.shouldPreventClose(), 'THE WINDOW MUST STILL BE CLOSEABLE').toBe(false);
    // ONE ending, reported once: the renderer gets a single `transfer:done`.
    expect(d.sent.filter(([ch]) => ch === 'transfer:done')).toHaveLength(1);
  });

  it('a transfer that ended inside startTransfer is not kept as a cancellable run', async () => {
    const cancel = vi.fn();
    const d = deps({
      // The run DOES carry a cancel here, which the real driver would not -- so that a
      // controller holding on to a dead run is observable rather than merely untidy.
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: true, bytes: 3 });
        return { ok: true, cancel };
      }),
    });
    const c = createTransferController(d);
    await c.submit([]);
    c.requestCancel();
    c.shutdown();
    expect(cancel, 'a run that already ended must not be cancelled afterwards')
      .not.toHaveBeenCalled();
  });

  it('a second submit is accepted after a transfer that ended inside startTransfer', async () => {
    const d = deps({
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: true, bytes: 3 });
        return { ok: true };
      }),
    });
    const c = createTransferController(d);
    await c.submit([]);
    // THE USER-VISIBLE HALF of the ordering bug: with the flag left armed, the form's Start
    // button is refused for the rest of the window's life.
    expect((await c.submit([])).ok).toBe(true);
    expect(d.startTransfer).toHaveBeenCalledTimes(2);
  });

  it('a transfer that FAILS inside startTransfer is also not left running', async () => {
    const d = deps({
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: false, error: 'host refused' });
        return { ok: true };
      }),
    });
    const c = createTransferController(d);
    expect((await c.submit([])).ok).toBe(true);
    expect(c.running()).toBe(false);
    expect(d.sent).toContainEqual(['transfer:done', { ok: false, error: 'host refused' }]);
  });

  /**
   * A LATE `onDone` AFTER A QUIT MUST NOT RE-ARM THE CLOSE GUARD.
   *
   * `shutdown` clears the state; `TransferRun.cancel` normally reaches `onDone` on its way out,
   * but the DFT arm DEFERS -- `DftTransfer.cancel` checks its flag on the next inbound frame
   * (`transferRun.ts:399-406` cites `dft.ts:186-188`) -- so an ending can still arrive after
   * `shutdown` has returned. It must report and stay cleared, not resurrect a run.
   */
  it('an onDone arriving after shutdown does not re-arm the close guard', async () => {
    const d = deps({ startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel: vi.fn() })) });
    const c = createTransferController(d);
    await c.submit([]);
    const opts = startedWith(d);
    c.shutdown();
    opts.onDone({ ok: false, error: 'transfer canceled by user' });
    expect(c.running()).toBe(false);
    expect(c.shouldPreventClose()).toBe(false);
  });

  /**
   * ## A DEAD RUN'S LATE ENDING MUST NOT CLEAR THE LIVE ONE
   *
   * THE GENERATION GUARD'S OWN TEST, and it took tracing `transferRun.ts` to find a sequence that
   * reaches it -- single mutation did NOT redden without this, so by this repo's own rule the
   * guard had to be either proved load-bearing or deleted.
   *
   * The reachable sequence, every step cited:
   *
   *  1. The operator cancels. `TransferRun.cancel`'s CUT arm calls `session.sendAID`
   *     (`transferRun.ts:437-438`), which THROWS `Error('not connected')` on a dropped socket
   *     (`core/src/session.ts:1513`).
   *  2. That throw is BEFORE `finish` (`transferRun.ts:439`), so the driver's `ended` flag stays
   *     FALSE, its screen listeners stay registered and its frame and total timers stay ARMED
   *     (`transferRun.ts:379-383`). The run is dead to us and still live to itself.
   *  3. The controller has dropped it, so the form re-enables and a SECOND transfer can start.
   *  4. Run 1's frame deadline then fires -- 30s later -- and `timeout` calls `finish`, so run 1's
   *     `onDone` arrives while run 2 is mid-flight.
   *
   * Without the generation check that ending clears run 2: `shouldPreventClose()` goes false, so
   * Cmd-W abandons a live transfer and `shutdown` never calls its `cancel` -- the host left
   * waiting for a frame that never comes, which is this module's whole subject.
   */
  it('a LATE onDone from a cancelled run does not clear the transfer that replaced it', async () => {
    const cancel1 = vi.fn(() => { throw new Error('not connected'); });
    const cancel2 = vi.fn();
    const runs: TransferRun[] = [{ ok: true, cancel: cancel1 }, { ok: true, cancel: cancel2 }];
    const d = deps({
      startTransfer: vi.fn((): TransferRun => runs.shift() ?? { ok: false, error: 'no more' }),
    });
    const c = createTransferController(d);

    await c.submit([]);
    const first = startedWith(d, 0);
    // Step 1-3: the cancel throws, the controller drops the run, a second transfer starts.
    c.requestCancel();
    expect((await c.submit([])).ok, 'the form must be usable again after a failed cancel')
      .toBe(true);

    // Step 4: run 1's frame deadline fires, long after we stopped caring about it.
    first.onDone({ ok: false, error: 'press Attn or Clear: host may still be transferring' });

    expect(c.running(), 'the SECOND transfer is still running').toBe(true);
    expect(c.shouldPreventClose(), 'and the window must still refuse to close over it').toBe(true);
    // The decisive one: a quit now must still abort the live transfer.
    c.shutdown();
    expect(cancel2, 'the live run must still be cancellable on quit').toHaveBeenCalled();
  });

  /**
   * `browse` DOES NOT CARE WHETHER A TRANSFER IS RUNNING, and that is the renderer's job rather
   * than an omission here: `transferUi.ts`'s `browseLocal` checks `isRunning` on BOTH sides of
   * its `await` (the second check is the measured fix for a non-modal dialog resolving
   * mid-transfer). Pinned so nobody "hardens" this end into a silent `undefined` that would
   * make the real guard untestable from the form's side.
   */
  it('browse still opens a dialog while a transfer runs -- the FORM owns that refusal', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    expect(await c.browse('send')).toBe('/tmp/open.txt');
  });

  it('passes a canceled dialog through as undefined rather than an empty path', async () => {
    const d = deps({ openDialog: vi.fn(async () => undefined) });
    const c = createTransferController(d);
    expect(await c.browse('send')).toBeUndefined();
  });

  /**
   * ANY direction that is not `send` takes the SAVE dialog, which is what `TransferDirection`
   * makes safe: the union is `'send' | 'receive'` and the value comes from the form's own model.
   * Asserted because the dispatch is on a `string` crossing an IPC boundary -- a renderer could
   * send anything -- and a Save dialog for a nonsense direction is the harmless answer, where an
   * Open dialog would let a bad value pick a file the operator then tries to overwrite.
   */
  it('an unrecognized direction gets the SAVE dialog, not the OPEN one', async () => {
    const d = deps();
    const c = createTransferController(d);
    expect(await c.browse('nonsense')).toBe('/tmp/save.txt');
    expect(d.openDialog).not.toHaveBeenCalled();
  });
});
