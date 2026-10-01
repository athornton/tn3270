import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The FOUR paths that must reach `cancel`, pinned in `main.ts` AS SOURCE TEXT.
 *
 * ## WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT -- READ THIS BEFORE TRUSTING A GREEN RUN
 *
 * `main.ts` CANNOT BE IMPORTED. It calls `app.whenReady()` in its module body, so importing it
 * outside Electron throws, and the wirings below live inside that callback's closure where nothing
 * can reach them. The two controller-side halves ARE unit-tested properly, against a fake, in
 * `transferWindow.test.ts` -- `shutdown` cancels, is idempotent, survives a throwing `cancel`, and
 * a late ending cannot resurrect a run. What is untestable is the WIRING: that `main.ts` calls
 * `shutdown` from all four places.
 *
 * So these are TEXT ASSERTIONS, the same instinct and the same admitted limit as
 * `clicks-harness-flags.test.ts` and `keys-harness-flags.test.ts`, which read their harness as a
 * string for exactly this reason. They would pass against a `shutdown` that did nothing. Their
 * whole value is the one failure they DO catch, which is the one that happened: a teardown path
 * that clears the state and never cancels, deleted or never written. That is worth catching,
 * because it is the fourth instance of a bug this project has now fixed four times -- but a reader
 * must not mistake this file for proof that cancellation WORKS.
 *
 * THE BEHAVIORAL EVIDENCE IS BY HAND, under Xvfb, and is recorded in `docs/live-testing.md` under
 * *The transfer window's four teardown paths*. Both reachable paths were driven in real Electron
 * with a counting `cancel`, and each was confirmed to FAIL without its fix -- which is the half a
 * text assertion can never supply.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(join(guiDir, 'src', 'main.ts'), 'utf8');

describe('every path that ends a transfer reaches shutdown', () => {
  /**
   * PATH 1: the app quitting. Cmd-Q, Ctrl-], `maybeCapture`'s own `app.quit()`.
   */
  it('a quit cancels rather than being blocked', () => {
    expect(main).toMatch(/app\.on\('before-quit', \(\) => \{ transfer\?\.shutdown\('quit'\); \}\)/);
  });

  /**
   * PATH 2: the window being destroyed. THE ONE THAT WAS MISSING, and the reason this file exists.
   *
   * MEASURED in real Electron: closing a child window's PARENT destroys the child and fires the
   * child's `closed` WITHOUT its `close`, so the close guard is bypassed entirely -- and `closed`
   * runs BEFORE `window-all-closed` -> `app.quit()` -> `before-quit`, which therefore finds
   * `transfer` already `undefined` and has nothing to cancel. Observed `cancel() was called 0
   * time(s)` with the host still waiting for a frame.
   *
   * Asserted as ORDER, not merely presence, which is the whole content of the bug: `shutdown` must
   * come BEFORE the two assignments that clear the state. A `shutdown()` after
   * `transfer = undefined` is a no-op on `undefined` and would pass a presence-only check.
   */
  it('a destroyed window cancels BEFORE it clears the state', () => {
    const closed = /tw\.on\('closed', \(\) => \{([\s\S]*?)\n    \}\);/.exec(main);
    expect(closed, "no tw.on('closed') handler found in main.ts").not.toBeNull();
    const body = closed![1]!;
    const shutdownAt = body.indexOf("transfer?.shutdown('windowGone');");
    const clearAt = body.indexOf('transfer = undefined;');
    expect(shutdownAt, 'the closed handler must cancel the run').toBeGreaterThanOrEqual(0);
    expect(clearAt, 'the closed handler must clear the controller').toBeGreaterThanOrEqual(0);
    expect(shutdownAt, 'cancel must happen BEFORE the state is cleared, or it cancels nothing')
      .toBeLessThan(clearAt);
    // And still inside the identity guard, so a late `closed` cannot tear down a REPLACEMENT
    // window's live transfer -- the two corrections have to coexist.
    const guardAt = body.indexOf('if (transferWin !== tw) return;');
    expect(guardAt, 'the identity guard must still be there').toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeLessThan(shutdownAt);
  });

  /**
   * PATH 3: the session going away underneath.
   *
   * `Session.handleClose` clears its own `dft`, so core does not leak -- but the CONTROLLER would
   * keep `run !== undefined` forever, and `shouldPreventClose()` with it, so the window refused
   * EVERY close on a dead session. The only control left was Cancel, which throws `not connected`.
   *
   * A SECOND listener on `disconnect`, deliberately not folded into the repaint one: `send` runs on
   * every frame and is the paint path.
   *
   * THE REASON IS PINNED, NOT JUST THE CALL, and that is the whole content of the second defect
   * found on this path: canceling is not sufficient, because at 24x80 the cancel throws on its way
   * to the driver's `finish` and the form is never told the transfer ended. Only `'sessionLost'`
   * makes `shutdown` send an honest ending; `'quit'` or `'windowGone'` here would compile, pass a
   * presence-only check, and leave the form stuck for 30 seconds followed by a false message about
   * a host that is gone. See `transferSeamIpc.test.ts` for the behavioral half.
   */
  it('a session that disconnects cancels the transfer AND says it was the session', () => {
    expect(main).toMatch(
      /session\.on\('disconnect', \(\) => \{ transfer\?\.shutdown\('sessionLost'\); \}\)/,
    );
    // The repaint listener must SURVIVE alongside it: a disconnect still has to redraw the OIA,
    // which is how the operator learns the session dropped at all.
    expect(main).toMatch(/session\.on\('disconnect', send\)/);
  });

  /**
   * PATH 4: the operator's own Cancel button, and the close guard that makes it the only way out.
   *
   * This one is REFUSED rather than cancelled, which is why it is not a `shutdown` call: an
   * accidental Cmd-W must not abandon a transfer. Pinned here so the set of four stays visible in
   * one place -- and because deleting `preventDefault` is what would silently turn an accident into
   * an abandoned transfer.
   */
  it('an accidental close is refused, not obeyed', () => {
    expect(main).toMatch(/e\.preventDefault\(\);\s*\n\s*transfer\.onCloseAttempt\(\);/);
    expect(main).toMatch(/ipcMain\.on\('transfer:cancel', \(\) => \{ transfer\?\.requestCancel\(\); \}\)/);
  });
});
