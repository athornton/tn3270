import { describe, it, expect, vi } from 'vitest';
import {
  encodeAddress, Order, Session, SnaCmd,
  TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S,
  type Connection,
} from '@tn3270/core';
import { startTransfer, type StartTransferOptions, type TransferFiles, type TransferRun } from '@tn3270/frontend';
import { createTransferController, type TransferDeps } from '../src/transferWindow.js';
import { createTransferUi, type UiDeps } from '@tn3270/canvas/dist/transferUi.js';

/**
 * THE TWO HALVES OF THE TRANSFER WINDOW, COMPOSED ACROSS THE IPC SEAM THAT SEPARATES THEM.
 *
 * ## WHY THIS FILE EXISTS: 2239 TESTS STAYED GREEN WHILE BOTH HALVES WERE JOINTLY WRONG
 *
 * `transferUi.test.ts` drives the renderer against a fake `submit`. `transferWindow.test.ts` drives
 * the controller against a fake `startTransfer` and asserts MAIN-SIDE STATE ONLY. Both were green,
 * both were individually CORRECT, and nothing anywhere instantiated `createTransferUi` and
 * `createTransferController` together -- so the seam where they disagreed was untested, and two
 * operator-visible defects survived three reviews inside it:
 *
 *  - **A transfer that completed SYNCHRONOUSLY left the form permanently claiming `transferring`,
 *    on the SUCCESS path.** `start()` awaited `deps.submit` and only then armed `isRunning` and
 *    painted the status, so an ending that arrived DURING that await was overwritten by the submit
 *    that started it. Reachable because `startTransfer` can call `onDone` before it returns
 *    (`transferRun.ts:377`, `if (ended) return { ok: true };` -- a whole DFT transfer finishing
 *    inside `session.sendAID(AID.ENTER)`), the controller's `finish` then runs inside the
 *    `ipcMain.handle` handler, and a `webContents.send` issued there reaches the renderer BEFORE
 *    the `invoke()` promise resolves (measured in real Electron 44, 20 runs out of 20). The
 *    operator saw a transfer that had SUCCEEDED reported as permanently in progress, with Cancel
 *    and Start both dead for the window's life.
 *  - **A session dropping mid-CUT-transfer at 24x80 left the form stuck, then told it a LIE.**
 *    `shutdown` deliberately sent no `transfer:done`, justified as "there is nobody left to tell"
 *    -- true for a quit, false for a disconnect, where the window is still on screen. See the
 *    disconnect test below for the measured chain.
 *
 * Neither half can see either defect alone. The renderer's own tests call `finished()` only AFTER
 * `start()` has resumed, which is the one ordering that cannot fail; the controller's assert
 * `c.running()`, which was always right. **An ordering this file does not encode is an ordering
 * nobody checks** -- so when a new way for the two sides to interleave is added, it belongs here.
 *
 * ## HOW THE SEAM IS MODELLED, AND WHAT THAT IS WORTH
 *
 * `compose()` wires the controller's `send` to the UI's `progress`/`finished` and the UI's `submit`
 * to the controller's `submit`, which is what `main.ts` and `transferBoot.ts` do through
 * `transferPreload.cts`. The ORDERING is the thing under test, so it is made explicit rather than
 * left to chance: `submit` resolves through a queue the test controls, so a `transfer:done` issued
 * synchronously inside the controller's `submit` is delivered to the renderer BEFORE that submit's
 * promise resolves -- Electron's measured ordering, reproduced in node.
 *
 * WHAT IT IS NOT: real IPC. There is no structured clone, no process boundary and no Electron. Those
 * belong to `scripts/transfer.mjs`, which drives a real window under Xvfb. What this file owns is the
 * ORDER in which the two halves observe each other's effects, which `transfer.mjs` cannot vary and
 * no single-half unit test can see.
 */

/** A connection a test can drive, and drop. Lifted from `tui/test/transferRun.test.ts`. */
class FakeConnection implements Connection {
  sent: number[] = [];
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); }
  /** THE SOCKET DROPPING, which is what reaches `Session.handleClose` and fires `disconnect`. */
  close(): void { this.onClose?.(); }
  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }

  negotiate(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.sent = [];
  }
}

/**
 * A connected, negotiated session sitting at a host-painted prompt, at the geometry asked for.
 *
 * THE HOST HAS TO PAINT THE PROMPT, per `tui/test/transferRun.test.ts`'s own note: a freshly
 * connected session is in `X Wait`, so `startTransfer` would refuse with "keyboard locked" before
 * reaching anything this file is about. The unlock is the WCC's keyboard-restore bit (0xc3).
 *
 * `rows`/`cols` size the BUFFER, and nothing here calls EWA, so `screen.size` really is what the
 * arguments say -- which matters because the whole 24x80-versus-43x80 split below turns on it.
 */
async function connected(rows = 24, cols = 80): Promise<{ session: Session; conn: FakeConnection }> {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn, rows, cols });
  await session.connect('localhost', 3270);
  conn.negotiate();
  expect(session.is3270Mode(), 'the host really negotiated 3270 mode').toBe(true);
  const [hi, lo] = encodeAddress(0, session.screen.size);
  conn.host(SnaCmd.EW, 0xc3, Order.SBA, hi!, lo!, Order.SF, 0x00, T.IAC, T.EOR);
  expect(session.oia.isInhibited(), 'the prompt really did unlock the keyboard').toBe(false);
  return { session, conn };
}

/** An in-memory `TransferFiles`; nothing here touches a disk. */
function fakeFiles(): TransferFiles {
  const files = new Map<string, Uint8Array>();
  return {
    exists: (p) => files.has(p),
    read: (p) => {
      const got = files.get(p);
      if (got === undefined) throw new Error(`ENOENT: ${p}`);
      return got;
    },
    write: (p, bytes) => { files.set(p, bytes); },
    append: (p, bytes) => { files.set(p, bytes); },
  };
}

/** What the controller hands `startTransfer`, narrowed to what a test drives. */
type StartedWith = Omit<StartTransferOptions, 'session' | 'files'>;

const REQUEST = Object.freeze({
  direction: 'receive', localFile: '/tmp/a.bin', hostFile: 'A.BIN',
  host: 'tso', mode: 'binary', cr: 'auto', exist: 'keep',
} as const);

interface Composed {
  readonly ui: ReturnType<typeof createTransferUi>;
  readonly controller: ReturnType<typeof createTransferController>;
  /** Every `setStatus` the form was given, in order. The last one is what an operator SEES. */
  readonly statuses: string[];
  /** Every `setRunning`, in order: the enablement half of the same fact. */
  readonly enabled: boolean[];
  /**
   * How many times the form reached for the `transfer:cancel` BRIDGE.
   *
   * COUNTED AT THE BRIDGE AND NOT AT THE DRIVER, which was measured rather than assumed: a form
   * that wrongly believes it is running calls `deps.cancel()`, main answers
   * `if (run === undefined) return;`, and the driver's own `cancel` is therefore NOT called either
   * way. An assertion on the driver passes with the bug in place -- it was in this file's first
   * draft and survived the mutation check, which is the most misleading result there is. The bridge
   * is the one place the two cases differ.
   */
  readonly cancels: { count: number };
  /** What the status line currently reads. */
  status(): string;
}

/**
 * Both halves, wired to each other the way `main.ts` and `transferBoot.ts` wire them.
 *
 * ## `deliverEagerly` IS THE WHOLE POINT OF THIS HELPER
 *
 * When true, a `transfer:done` the controller issues while the renderer is still awaiting its
 * `submit` is delivered IMMEDIATELY -- which is what real Electron does, measured. When false the
 * send is queued until after the submit resolves, which is the ordering every pre-existing test
 * happened to exercise. Both are driven below, because the bug lived in exactly the difference.
 *
 * IT ONLY GOVERNS SENDS ISSUED WHILE A SUBMIT IS IN FLIGHT, and that was measured rather than
 * reasoned: holding every send unconditionally queued the ordinary mid-transfer `onDone` -- issued
 * long after the submit resolved -- behind a drain that had already run, so the form was never told
 * and a test asserting the NORMAL path failed. A delay that outlives the window it is modelling is
 * not a slower seam, it is a broken one.
 */
function compose(
  over: {
    startTransfer?: TransferDeps['startTransfer'];
    deliverEagerly?: boolean;
  } = {},
): Composed {
  const statuses: string[] = [];
  const enabled: boolean[] = [];
  const cancels = { count: 0 };
  const deliverEagerly = over.deliverEagerly ?? true;

  // Assigned immediately below; the controller's `send` closes over it, and nothing can call that
  // before `createTransferUi` has returned (the controller only sends from inside a `submit` or a
  // driver callback, both of which the test triggers afterwards).
  let ui!: ReturnType<typeof createTransferUi>;
  /** Sends held back until the submit resolves, when `deliverEagerly` is false. */
  const held: Array<() => void> = [];
  /** True only between the controller's `submit` being entered and its answer being returned. */
  let submitting = false;

  const send: TransferDeps['send'] = (channel, payload) => {
    const deliver = (): void => {
      if (channel === 'transfer:progress') { ui.progress(payload as string); return; }
      ui.finished(payload as { ok: boolean; error?: string; bytes?: number });
    };
    // `submitting` IS PART OF THE CONDITION, not just `deliverEagerly`. See the docstring: a send
    // issued when no submit is in flight has no promise to be ordered against, so holding it would
    // queue it behind a drain that has already happened and the form would never hear it.
    if (deliverEagerly || !submitting) { deliver(); return; }
    held.push(deliver);
  };

  const controller = createTransferController({
    send,
    focusWindow: vi.fn(),
    openDialog: vi.fn(async () => undefined),
    saveDialog: vi.fn(async () => undefined),
    startTransfer: over.startTransfer ?? vi.fn((): TransferRun => ({ ok: true, cancel: vi.fn() })),
    buildCommand: vi.fn(() => ({
      request: { ...REQUEST },
      command: 'IND$FILE GET A.BIN',
    })),
  });

  const uiDeps: UiDeps = {
    render: () => {},
    setStatus: (text) => { statuses.push(text); },
    setRunning: (running) => { enabled.push(running); },
    browse: async () => undefined,
    /**
     * THE SEAM. `ipcRenderer.invoke` over `ipcMain.handle`: the handler runs to completion and its
     * return value resolves the renderer's promise. A `webContents.send` the handler issued on the
     * way reaches the renderer FIRST -- which is what `deliverEagerly` reproduces.
     */
    submit: async (keywords) => {
      submitting = true;
      try {
        return await controller.submit(keywords);
      } finally {
        // DRAINED IN `finally` AND THE FLAG CLEARED THERE TOO, so a `submit` that threw cannot leave
        // the seam permanently holding every later send -- which would make the form deaf for the
        // rest of the test and look like a product bug.
        submitting = false;
        for (const deliver of held.splice(0)) deliver();
      }
    },
    cancel: () => {
      // COUNTED HERE: this is `ipcRenderer.send('transfer:cancel')`, i.e. the form deciding it has
      // a transfer to abort. See `Composed.cancels` for why the driver's own `cancel` is the wrong
      // place to look.
      cancels.count += 1;
      controller.requestCancel();
    },
  };
  ui = createTransferUi(uiDeps);

  return {
    ui,
    controller,
    statuses,
    enabled,
    cancels,
    status: () => statuses[statuses.length - 1] ?? '',
  };
}

describe('the two halves across the IPC seam: a synchronous completion', () => {
  /**
   * ## C1: A TRANSFER THAT COMPLETED **SUCCESSFULLY** MUST NOT REPORT AS STILL RUNNING
   *
   * THE TEST THE OLD `start()` FAILED, and it failed on the SUCCESS path, which is what made it so
   * hard to see: `__tn3270Submit` answers with `ui.running()`, which was `true` *because of* the
   * bug, so `transfer.mjs` printed `ok=true status=transferring` and scored it.
   *
   * The ordering is real, not contrived. `startTransfer` calls `onDone` before returning
   * (`transferRun.ts:372-377`; `tui/test/transferRun.test.ts` drives it against a real `Session`),
   * so `finish` runs inside `ipcMain.handle` and its `webContents.send('transfer:done')` arrives
   * before the `invoke()` resolves.
   */
  it('a completion delivered BEFORE submit resolves is not undone by the submit', async () => {
    const c = compose({
      // Exactly `transferRun.ts:372-377`: the ending fires from inside the call, and the returned
      // run carries no `cancel` because there is nothing left to cancel.
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: true, bytes: 3 });
        return { ok: true };
      }),
    });

    await c.ui.start();

    // THE DECISIVE ASSERTION. Before the fix this was `true`, on a transfer that had SUCCEEDED.
    expect(c.ui.running(), 'a transfer that already finished is NOT running').toBe(false);
    expect(c.status(), "the form must report the ending, not the submit that started it")
      .toBe('done: 3 bytes');
    // The enablement half of the same fact: the LAST word to the DOM must re-enable the form. A
    // `setRunning(true)` arriving after the ending leaves every control disabled with nothing
    // running -- which is what the operator actually met.
    expect(c.enabled[c.enabled.length - 1], 'the form must end up ENABLED').toBe(false);
  });

  it('Start works again after a transfer that completed inside the submit', async () => {
    let endings = 0;
    const c = compose({
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        endings += 1;
        opts.onDone({ ok: true, bytes: 3 });
        return { ok: true };
      }),
    });
    await c.ui.start();
    // THE USER-VISIBLE HALF: `start()` opens with `if (isRunning) return;`, so a flag left armed
    // makes Start dead for the window's LIFE and the operator has to close and reopen the window.
    await c.ui.start();
    expect(endings, 'the second Start must reach the host').toBe(2);
  });

  /**
   * CANCEL WAS SILENTLY DEAD, and this asserts it at the only place the two cases differ.
   *
   * With the bug, the form believed it was running, so `requestCancel` passed its `isRunning` check
   * and reached the bridge -- and main then answered `if (run === undefined) return;`, doing
   * nothing. The operator pressed the one enabled control on the form and NOTHING HAPPENED, with no
   * message either way.
   *
   * ASSERTED ON THE BRIDGE COUNT, not on the driver's `cancel`: the driver is not reached in either
   * case, so a driver-level assertion passes with the bug in place. That version was this file's
   * first draft and it SURVIVED the mutation check -- a false "this is covered".
   */
  it('Cancel does not reach a dead transfer after a completion inside the submit', async () => {
    const c = compose({
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: true, bytes: 3 });
        return { ok: true };
      }),
    });
    await c.ui.start();
    c.ui.requestCancel();
    expect(c.cancels.count,
      'the form must know there is nothing to cancel, not ask main and be ignored')
      .toBe(0);
  });

  /**
   * THE SAME ORDERING ON THE FAILURE PATH, which is a different arm of `finished()`: a transfer the
   * host refused after it had started still reports through `onDone`, and its message must survive
   * the submit as well.
   */
  it('a FAILURE delivered before submit resolves is not overwritten either', async () => {
    const c = compose({
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onDone({ ok: false, error: 'host refused the transfer' });
        return { ok: true };
      }),
    });
    await c.ui.start();
    expect(c.status()).toBe('host refused the transfer');
    expect(c.ui.running()).toBe(false);
  });

  /**
   * THE ORDERING THE OLD TESTS EXERCISED, kept so the fix is not a swap of one failure for another.
   * With the ending delivered AFTER the submit resolves, the form must go running and stay so.
   */
  it('an ending that arrives AFTER the submit resolves still works normally', async () => {
    let started!: StartedWith;
    const c = compose({
      deliverEagerly: false,
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        started = opts;
        return { ok: true, cancel: vi.fn() };
      }),
    });
    await c.ui.start();
    expect(c.ui.running(), 'a transfer that really is running').toBe(true);
    expect(c.status()).toBe('transferring');
    started.onDone({ ok: true, bytes: 128 });
    expect(c.ui.running()).toBe(false);
    expect(c.status()).toBe('done: 128 bytes');
  });

  /**
   * A LOCAL REFUSAL MUST STILL LEAVE THE FORM USABLE, which is the liability the fix introduces:
   * `start()` now arms `isRunning` BEFORE the await, so the refusal arm has to clear it. A refusal
   * that left it armed would be C1 again, moved one path over -- and `transferWindow.test.ts` could
   * not see it, because main's state is correct on this path either way.
   */
  it('a local refusal leaves the form IDLE and usable, despite the early arming', async () => {
    const c = compose({
      startTransfer: vi.fn((): TransferRun => ({ ok: false, error: 'not in 3270 mode' })),
    });
    await c.ui.start();
    expect(c.ui.running(), 'nothing is running after a refusal').toBe(false);
    expect(c.status()).toBe('not in 3270 mode');
    expect(c.enabled[c.enabled.length - 1], 'the controls must be re-enabled').toBe(false);
    // AND THE FORM STILL ACCEPTS EDITS, which is the thing an operator does next: the whole point
    // of leaving a refused form open and populated is fixing one field.
    c.ui.type('hostFile', 'OTHER.DATA');
    expect(c.ui.values().hostFile).toBe('OTHER.DATA');
  });

  /**
   * A `transfer:progress` ARRIVING DURING THE AWAIT, which is the sibling of C1 on the same
   * suspension point. `progress()` guards on `isRunning`, so before the fix a progress report
   * issued while the submit was in flight was DROPPED -- and then painted over by the tail's
   * `transferring` even if it had not been.
   */
  it('a progress report delivered during the submit is not dropped', async () => {
    const c = compose({
      startTransfer: vi.fn((opts: StartedWith): TransferRun => {
        opts.onProgress('128 bytes');
        return { ok: true, cancel: vi.fn() };
      }),
    });
    await c.ui.start();
    expect(c.statuses, 'a live progress line must reach the form').toContain('128 bytes');
    expect(c.status(), 'and must not be painted over by the submit that started it')
      .toBe('128 bytes');
    expect(c.ui.running()).toBe(true);
  });
});

describe('the two halves across the IPC seam: the session dropping underneath', () => {
  /**
   * ## I2: A DROPPED SESSION AT 24x80 MUST TELL THE FORM, AND TELL IT THE TRUTH
   *
   * REAL `Session`, REAL `startTransfer`, REAL controller, REAL UI -- because the defect lives in
   * what the driver does on the way out and a fake `startTransfer` cannot have it. The chain, every
   * step cited:
   *
   *  1. The socket drops. `Session.handleClose` fires `disconnect`, and `main.ts`'s listener calls
   *     `shutdown('sessionLost')`.
   *  2. `cancelRun()` reaches `TransferRun.cancel`, whose CUT arm calls `session.sendAID(step.ack)`
   *     (`transferRun.ts:438`).
   *  3. `Session.sendAID` throws `not connected` (`core/src/session.ts:1513`) -- the socket is gone.
   *  4. The throw is BEFORE the driver's `finish` (`transferRun.ts:439`), so `onDone` NEVER FIRES.
   *
   * GEOMETRY-DEPENDENT, and the common case is the broken one: at any non-CUT geometry
   * `transferRun.ts:429-432` returns `finish(...)` before that throwing `sendAID`, so a 43x80
   * session reported itself correctly all along. 24x80 did not. Measured before the fix:
   *
   *     24x80 (screen.size=1920): ui.running()=true  status="transferring"   <-- STUCK
   *     43x80 (screen.size=3440): ui.running()=false status="transfer canceled by user"
   *
   * with Cancel and Start both dead at 24x80.
   */
  it('AT 24x80 -- the CUT geometry -- the form learns the transfer ended', async () => {
    const { session, conn } = await connected(24, 80);
    expect(session.screen.size, 'this really is the CUT geometry').toBe(1920);
    const c = compose({
      startTransfer: (opts) => startTransfer({ ...opts, session, files: fakeFiles() }),
    });
    session.on('disconnect', () => { c.controller.shutdown('sessionLost'); });

    await c.ui.start();
    expect(c.ui.running(), 'the transfer really started').toBe(true);

    // THE SOCKET DROPS.
    conn.close();

    expect(c.ui.running(), 'THE FORM MUST NOT BE LEFT CLAIMING transferring').toBe(false);
    expect(c.status(), 'and the message must name the session, honestly')
      .toBe('transfer ended: the session disconnected');
    // THE ENABLEMENT HALF: a form that is told nothing keeps every control disabled but Cancel, and
    // Cancel then does nothing -- the operator has to close and reopen the window.
    expect(c.enabled[c.enabled.length - 1], 'the controls must come back').toBe(false);
  });

  it('AT 43x80 the message is the same, so the two geometries no longer disagree', async () => {
    const { session, conn } = await connected(43, 80);
    expect(session.screen.size, 'and this really is NOT the CUT geometry').not.toBe(1920);
    const c = compose({
      startTransfer: (opts) => startTransfer({ ...opts, session, files: fakeFiles() }),
    });
    session.on('disconnect', () => { c.controller.shutdown('sessionLost'); });

    await c.ui.start();
    conn.close();

    expect(c.ui.running()).toBe(false);
    // BEFORE THE FIX THIS SAID 'transfer canceled by user', which is the driver's own cancel
    // message and FALSE here: the operator canceled nothing, the session dropped. The two
    // geometries now report the same event the same way, which they did not before.
    expect(c.status()).toBe('transfer ended: the session disconnected');
  });

  /**
   * ## THE STALE 30-SECOND TIMEOUT MUST NOT ARRIVE AND CONTRADICT THE TRUTH
   *
   * The reason the generation is bumped. Nothing can disarm the driver's frame timer from out here:
   * the cancel threw on its way to `finish`, so the driver's `ended` stayed FALSE and its timers
   * stayed armed (`transferRun.ts:379-383`). About 30 seconds later it fires and `finish` forwards
   * `press Attn or Clear: host may still be transferring. stalled: no CUT frame...` -- a message
   * that is FALSE, because the session is gone and there is no host to press Attn at.
   *
   * `frameMs: 50` rather than fake timers: the driver's timer is real and its deadline is an option
   * the caller already supplies (`transferRun.ts:73-74`, used throughout
   * `tui/test/transferRun.test.ts`), so shortening it tests the real path rather than a mocked
   * clock.
   */
  it('the stale frame timeout cannot overwrite the honest message afterwards', async () => {
    const { session, conn } = await connected(24, 80);
    const c = compose({
      startTransfer: (opts) => startTransfer({
        ...opts, session, files: fakeFiles(), frameMs: 50, totalMs: 60_000,
      }),
    });
    session.on('disconnect', () => { c.controller.shutdown('sessionLost'); });

    await c.ui.start();
    conn.close();
    expect(c.status()).toBe('transfer ended: the session disconnected');

    // LONGER THAN THE FRAME DEADLINE, so the driver's timer really does fire while we wait.
    await new Promise<void>((r) => { setTimeout(r, 250); });

    expect(c.status(), 'a dead run\'s timeout must not contradict the ending already reported')
      .toBe('transfer ended: the session disconnected');
    expect(c.statuses.some((s) => s.includes('press Attn or Clear')),
      'and the false "host may still be transferring" must never reach the form at all')
      .toBe(false);
    expect(c.ui.running()).toBe(false);
  });

  /**
   * A QUIT REALLY DOES HAVE NOBODY TO TELL, which is the half of the old comment that was right.
   * Asserted so the fix does not become "always send": `app.on('before-quit')` is followed by every
   * renderer in the process being torn down, and `tw.on('closed')` runs on a window that is already
   * destroyed.
   */
  it('a quit and a destroyed window send NOTHING to the form', async () => {
    for (const why of ['quit', 'windowGone'] as const) {
      const c = compose({
        startTransfer: vi.fn((): TransferRun => ({ ok: true, cancel: vi.fn() })),
        deliverEagerly: false,
      });
      await c.ui.start();
      const before = c.statuses.length;
      c.controller.shutdown(why);
      expect(c.statuses.length, `${why} has nobody left to tell`).toBe(before);
    }
  });

  /**
   * A DISCONNECT WITH NOTHING RUNNING MUST ALSO STAY QUIET. An ending invented for a transfer that
   * never started would make `finished()` paint 'transfer failed' over the idle help text -- the
   * same rule `submit`'s refusal arm already follows for the same reason.
   */
  it('a disconnect with no transfer running says nothing', () => {
    const c = compose();
    const before = c.statuses.length;
    c.controller.shutdown('sessionLost');
    expect(c.statuses.length).toBe(before);
  });
});
