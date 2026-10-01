import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolveTerminalType, resolveAlternateSize, resolve, TerminalTypeError } from '@tn3270/core';
import {
  applyAction, defaultSession, describeTlsError, resolveScheme, startTransfer, transferCommand,
  type Action,
} from '@tn3270/frontend';
import { nodeTransferFiles } from '@tn3270/node-files';
import { drawList, blankColumns, bestScale, readAtlas } from '@tn3270/canvas';
import { parseGuiArgs, UsageError } from './args.js';
import { parseKeySpec } from './keyspec.js';
import { createTransferController } from './transferWindow.js';

/**
 * Electron main: the Session, the socket and the window live here.
 *
 * CTRL-] QUITS, AND THAT IS NOT A STYLE CHOICE. Ctrl-C is the Clear AID -- a 3270 user
 * needs it constantly to dismiss VM's MORE... state -- so the usual instinct for escaping
 * cannot be the way out, and an undocumented alternative is no alternative. The TUI has
 * the same binding; `BINDING_INTENT` in `@tn3270/frontend` records it for both.
 *
 * ## THREE THINGS THAT ARE NOT NEGOTIABLE ON THIS BOX
 *
 * Measured 2026-08-28, written up in docs/live-testing.md under *Electron headless
 * re-verification*:
 *
 *  - `--no-sandbox`: Chromium's sandbox wants privileges this box does not grant.
 *  - `--disable-gpu`: there is no GL at all (`GLX is not present`), and WITHOUT this a
 *    `show: false` window HANGS rather than failing -- a stall, not an error, the same shape
 *    as the TLS trap.
 *  - `useContentSize: true`, below: `capturePage()` returns the CONTENT area, so a 400x200
 *    window otherwise yields a 400x173 image and every screenshot golden silently depends on
 *    window chrome height, which will not reproduce on a Mac.
 *
 * ## FAILURES GO IN THE WINDOW, NOT ONLY TO stderr
 *
 * Someone who double-clicked a `.app` never sees a console. `describeTlsError` exists so
 * every TLS failure names the flag that fixes it -- and against Hercules the common case is
 * a plaintext host, where a default-TLS attempt HANGS rather than refusing, so the message
 * pointing at `-insecure` is the difference between a diagnosis and a mystery.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * Chromium switches this app is launched with, stripped before OUR parser sees argv.
 *
 * Listed explicitly rather than filtered by a `--` prefix rule, because our own
 * `--terminal-type` takes a VALUE: a prefix rule either eats that value or needs to know
 * about it, and both readings were wrong in the first draft of this file. Anything not
 * named here still reaches `parseGuiArgs`, so an unrecognized flag is still an error --
 * silently swallowing one is what produces a session that negotiates something nobody
 * asked for.
 */
const ELECTRON_SWITCHES: ReadonlySet<string> = new Set([
  '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--disable-dev-shm-usage', '--enable-logging', '--in-process-gpu',
]);

/**
 * The test seams, read ONCE for the whole process.
 *
 * THREE PLACES ASK "IS THE KEYS SEAM ACTIVE?" -- the action log's privacy gate,
 * `maybeSendKeys` and `quitIfKeysOnly`. When each re-read `process.env` with its own inline
 * emptiness check they agreed only by coincidence: a later edit to what counts as empty
 * (treating `' '` as unset, say) would have moved one gate and left the others, and one of
 * them is the gate that keeps a typed password off stdout. The environment cannot change
 * under a running process, so reading it once is not a cache with an invalidation problem --
 * the action log already relied on exactly that.
 *
 * EMPTY STRING MEANS ABSENT throughout, so `TN3270_GUI_SHOT=` behaves as not setting it.
 */
const SEAM = Object.freeze({
  /** Chord specs for `maybeSendKeys`, comma-separated Accelerator names. */
  keys: process.env['TN3270_GUI_KEYS'] ?? '',
  /** A recorded trace to paint instead of dialling a host. */
  replay: process.env['TN3270_GUI_REPLAY'] ?? '',
  /** Where `maybeCapture` writes its PNG. */
  shot: process.env['TN3270_GUI_SHOT'] ?? '',
  /** How long to let the host paint before capturing. */
  shotMs: Number(process.env['TN3270_GUI_SHOT_MS'] ?? '2500'),
  /** How long to let the host paint before typing -- a FLOOR applies; see `maybeSendKeys`. */
  keysMs: Number(process.env['TN3270_GUI_KEYS_MS'] ?? '1200'),
  /**
   * A FOURTH TEST SEAM: `TN3270_GUI_URL=http://127.0.0.1:PORT/?t=TOKEN` loads a URL instead of
   * this package's own `index.html`, and creates NO `Session` at all.
   *
   * It exists so the WEB gateway's served page can be driven by a real browser with real key
   * events, which is the one thing no test in `packages/web` can reach: vitest has no DOM, and
   * `bridgecore.test.ts` deliberately injects a fake socket. Pointing this Electron shell at the
   * gateway exercises the served `bridge.js`, the WebSocket hop and the renderer's own `keydown`
   * listener in one path.
   *
   * WHY IT SKIPS EVERYTHING ELSE: in this mode the PAGE's bridge owns the protocol. A `Session`
   * here would be a second, unrelated 3270 connection whose frames nothing displays, and the
   * atlas would be sent over an IPC channel the served page does not listen on. So this returns
   * before argv parsing, before `defaultSession` and before `readAtlas` -- and takes no host
   * argument, which is also what keeps it unable to dial anything.
   */
  url: process.env['TN3270_GUI_URL'] ?? '',
  /**
   * `TN3270_GUI_SIZE=720x350` sets the CONTENT size, and it is meaningful only alongside `url`.
   *
   * On the normal path the window sizes itself from the first draw list, because main computes that
   * list. In URL mode main sees no frames at all -- the page does -- so the window would stay at its
   * 800x600 default, `renderer.ts` would center a 720x350 drawing inside it, and a capture would
   * differ from the GUI golden by a black border alone. That is a difference in the HARNESS's
   * geometry rather than in anything drawn, which is the least interesting reason for a golden to
   * fail. `browser-shot.mjs` reads the size out of the golden PNG itself, so the golden defines the
   * geometry rather than a constant repeated somewhere else.
   */
  size: process.env['TN3270_GUI_SIZE'] ?? '',
  /**
   * A FIFTH TEST SEAM: `TN3270_GUI_CLICKS='PF1,PA2,SysRq'` clicks keypad buttons by LABEL.
   *
   * Labels, not coordinates. A coordinate list would be a second copy of the layout, and it would
   * pass while the layout was wrong -- which is the one thing this seam exists to catch. Main asks
   * the renderer for the button's center and delivers a real `mouseDown`/`mouseUp` pair through
   * `sendInputEvent`, so the click enters at the top of Chromium's input pipeline exactly as
   * `TN3270_GUI_KEYS` does for keys.
   *
   * IT DOES NOT IMPLY THE KEYPAD, and the plan for it said it did -- so this is written down rather
   * than left as an omission. The keypad is a per-window display flag toggled by a `toggleKeypad`
   * action (see `showKeypad` below), and a run with the keypad hidden has no `list.keypad`, so
   * `__tn3270ButtonCenter` returns `null` and every label reports `NO BUTTON`. Turning it on from
   * here would ALSO be wrong: `clicks.mjs` shows the keypad with `TN3270_GUI_KEYS=Ctrl+K`, which
   * proves the chord and the click path in one run, and a second on-switch here would toggle it
   * straight back off. So the caller shows the keypad; this seam only clicks.
   */
  clicks: process.env['TN3270_GUI_CLICKS'] ?? '',
  /**
   * A SIXTH TEST SEAM: `TN3270_GUI_TRANSFER='localFile=/tmp/f,hostFile=A.B,submit'` drives the transfer
   * window without a mouse.
   *
   * Comma-separated steps, applied in order, so one variable expresses a whole scenario and the
   * harness needs no IPC of its own. Like `TN3270_GUI_CLICKS` it names WHAT to do rather than where
   * to click: a coordinate list would be a second copy of the layout and would pass while the
   * layout was wrong.
   *
   * ITS PRESENCE IS WHAT OPENS THE WINDOW, and the plan for this seam had an `open` STEP instead --
   * which nothing would have consumed. Its loop skipped `open` with "already open" while nothing in
   * this file had opened anything, so the whole scenario would have printed nothing at all. One
   * fact, one place.
   *
   * A STEP THIS FILE DOES NOT RECOGNISE IS REPORTED, not ignored, the same way `clicks: NO BUTTON`
   * reports a label that is not in the layout: a typo would otherwise present as a field that never
   * got set, which reads as a broken form.
   */
  transfer: process.env['TN3270_GUI_TRANSFER'] ?? '',
  /**
   * What the native file dialog should return, INSTEAD OF SHOWING.
   *
   * Separate from `transfer` above because it substitutes a MODAL, and a modal nobody can click
   * does not fail -- it HANGS, which is the failure shape this project has met in four other
   * places. Empty means show the real dialog.
   *
   * ONE VALUE FOR BOTH DIRECTIONS, which is honest about what it is: a stub for a chooser, not a
   * model of one. A scenario that needed an Open and a Save to answer differently would need two
   * variables, and no scenario does.
   */
  transferPath: process.env['TN3270_GUI_TRANSFER_PATH'] ?? '',
});

/** Turn any startup failure into something a person can act on. */
function explain(err: unknown, host?: string, port?: number): string {
  if (err instanceof UsageError) return err.message;
  if (err instanceof TerminalTypeError) return err.message;
  if (err instanceof Error) {
    // Node attaches a `code` to socket and TLS failures; describeTlsError maps the ones
    // worth explaining and names the flag that fixes each.
    const code = (err as { code?: string }).code;
    if (code !== undefined && host !== undefined) {
      return describeTlsError(code, host, port ?? 23);
    }
    return err.message;
  }
  return String(err);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    // See the note above: this is what makes capturePage() match the window we asked for.
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      /**
       * NO PRELOAD IN URL MODE, and this was MEASURED as a hard failure rather than reasoned.
       *
       * `preload.cts` calls `contextBridge.exposeInMainWorld('tn3270', ...)`, which defines a
       * NON-WRITABLE property on `window`. The gateway's own served `bridge.js` then does
       * `window.tn3270 = createBridge(...)` and dies with "Cannot assign to read only property
       * 'tn3270' of object '#<Window>'" -- so the page loads, receives keys, and does nothing.
       *
       * The two bridges are alternatives, never both: Electron's supplies the four functions over
       * IPC, the gateway's supplies them over a WebSocket. A real browser has no preload at all, so
       * this asymmetry belongs to the test shell and not to the served page.
       */
      // `.cjs`, compiled from preload.cts: an ESM preload cannot load. See that file.
      ...(process.env['TN3270_GUI_URL'] ? {} : { preload: join(here, 'preload.cjs') }),
    },
  });
  // Renderer console and load failures forwarded to stdout. Without this a renderer that
  // throws produces a BLANK WINDOW and no explanation anywhere -- which is exactly how the
  // first screenshot came out, and it is indistinguishable from a drawing bug.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    process.stdout.write(`renderer[${level}] ${sourceId}:${line} ${message}\n`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    process.stdout.write(`renderer failed to load ${url}: ${code} ${desc}\n`);
  });

  // That HTML pulls its renderer from `../canvas/dist/renderer.js`, which ASSUMES `gui` and
  // `canvas` stay siblings on disk. True in the workspace and false in an asar bundle, so
  // packaging -- explicitly out of scope in the stage-3 spec -- has to copy or rewrite that
  // path. The failure would be a blank window with a `did-fail-load` line above it.
  // The URL seam branches HERE, before anything reads argv or builds a Session -- see SEAM.url.
  if (SEAM.url !== '') {
    if (SEAM.size !== '') {
      const [w, h] = SEAM.size.split('x').map(Number);
      if (Number.isInteger(w) && Number.isInteger(h) && w! > 0 && h! > 0) {
        win.setContentSize(w!, h!);
      } else {
        // Refused by name rather than ignored: a silently-dropped size produces a golden mismatch
        // that reads as a rendering change, which is the diagnosis this seam exists to avoid.
        process.stderr.write(`TN3270_GUI_SIZE must be WxH, not ${JSON.stringify(SEAM.size)}\n`);
        app.exit(2);
        return;
      }
    }
    await win.loadURL(SEAM.url);
    globalShortcut.register('Control+]', () => { app.quit(); });
    await maybeSendKeys(win);
    await maybeCapture(win);
    await quitIfKeysOnly();
    return;
  }

  await win.loadFile(join(here, '..', 'index.html'));
  globalShortcut.register('Control+]', () => { app.quit(); });

  const fail = (message: string): void => {
    process.stderr.write(`${message}\n`);
    win.webContents.send('error-message', message);
  };

  let args;
  try {
    const argv = process.argv.slice(2).filter((a) => !ELECTRON_SWITCHES.has(a));
    args = parseGuiArgs(argv);
  } catch (err) {
    fail(explain(err));
    return;
  }

  // Resolved once: a scheme is fixed for the process, and re-resolving per frame would put a
  // string lookup in the paint path.
  const scheme = args.scheme ?? resolveScheme();

  // Built once and passed to both resolvers, so the terminal-type string and the geometry
  // can never come from different readings of the same arguments.
  const typeOpts = {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.terminalType !== undefined ? { terminalType: args.terminalType } : {}),
  };

  let session;
  try {
    session = defaultSession(
      resolveTerminalType(typeOpts), args.tls, resolveAlternateSize(typeOpts), args.tn3270e,
      args.bindImage, args.bindLimit, args.devname, args.ddm,
    );
  } catch (err) {
    fail(explain(err));
    return;
  }

  /**
   * The atlas is read HERE and shipped over IPC, not fetched by the renderer.
   *
   * Two reasons, both found by running it: `fetch` on a `file://` URL is blocked in
   * Chromium, and a packaged app's resources live inside an asar archive that only the main
   * process can read. Sending it once at startup avoids both and keeps the renderer with no
   * filesystem access at all.
   */
  /**
   * GUARDED like the two startup failures above, because a missing atlas is a REAL user's
   * broken install and not only a developer's half-built tree.
   *
   * `readAtlas` throws synchronously, and this runs inside `app.whenReady().then(async ...)`
   * where an uncaught throw is an unhandled rejection: MEASURED, that produced a warning on
   * stderr and then a BLANK WINDOW that sat until the harness timeout -- console-only
   * diagnosis, which is exactly what the rule at the top of this file forbids. A scoped
   * `npm run build -w @tn3270/gui` is enough to reach it; `assets.ts` records why.
   */
  let atlas;
  try {
    atlas = readAtlas();
  } catch (err) {
    fail(explain(err));
    return;
  }
  const { geometry, coverage } = atlas;
  const blank = [...blankColumns(coverage, geometry)];
  win.webContents.send('atlas', { geometry, coverage, blank });

  // Per WINDOW, not per session: whether the keypad is shown is a property of this display, and
  // `Session` knows nothing about it. Off by default -- the keypad is toggled, not permanent.
  let showKeypad = false;

  /**
   * The transfer window, created on first request and reused after that.
   *
   * LAZY because most sessions never transfer a file, and an Electron window costs a renderer
   * process. Reused rather than recreated so that reopening mid-transfer shows the RUNNING
   * state instead of a fresh form -- two submits would interleave two machines' frames on one
   * screen.
   *
   * ## ONE PER PROCESS, WHICH IS WHY THE HANDLERS BELOW ARE SAFE
   *
   * Everything in this block runs inside `app.whenReady().then(...)`, and that callback is
   * registered exactly ONCE at module scope (line 151). There is no `second-instance` or
   * `activate` handler in this file, so nothing re-enters it -- which matters because
   * `ipcMain.handle` THROWS on a second registration for the same channel ("Attempted to
   * register a second handler for 'transfer:browse'") and `app.on('before-quit')` would
   * accumulate a listener per entry. Both are therefore correct HERE and would be bugs if this
   * callback ever became re-entrant; a second window per process needs the three handlers and
   * the quit hook hoisted to module scope, keyed on which window asked.
   */
  let transferWin: BrowserWindow | undefined;
  let transfer: ReturnType<typeof createTransferController> | undefined;

  const openTransferWindow = async (): Promise<void> => {
    if (transferWin !== undefined && !transferWin.isDestroyed()) {
      transferWin.show();
      transferWin.focus();
      return;
    }
    const tw = new BrowserWindow({
      width: 460,
      height: 420,
      useContentSize: true,
      title: 'File Transfer',
      // A CHILD of the terminal window so it travels with it, but NOT modal: the operator may
      // want to look at the screen behind it, and a 3270 transfer is typed at a command prompt
      // they may need to see.
      parent: win,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // `.cjs`, compiled from transferPreload.cts: an ESM preload cannot load.
        preload: join(here, 'transferPreload.cjs'),
      },
    });
    transferWin = tw;
    // Same forwarding as the main window: a renderer that throws otherwise produces a window
    // that does nothing with no explanation anywhere.
    //
    // THE DEPRECATED FIVE-ARGUMENT FORM, MATCHING THE MAIN WINDOW'S HANDLER ABOVE RATHER THAN
    // electron.d.ts's preferred shape. Electron 44 still declares both -- `(details, level,
    // message, line, sourceId)` with the last four marked `@deprecated` -- and `level` is a
    // NUMBER there, where the `details.level` of the new form is a STRING ('info' | 'warning' |
    // 'error' | 'debug'). That difference is not cosmetic for the harnesses: `shot.mjs`,
    // `keys.mjs` and `clicks.mjs` all filter stdout on the literal `renderer[3]`, and each
    // records that the numeric level is deprecated and will drift silently on an upgrade. Using
    // the new shape here would print `transfer[error]` while the main window printed
    // `renderer[3]` -- two spellings of one thing in one stream, for a window whose log nothing
    // greps yet. One spelling, one upgrade to do when the level finally moves.
    tw.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      process.stdout.write(`transfer[${level}] ${sourceId}:${line} ${message}\n`);
    });
    tw.webContents.on('did-fail-load', (_e, code, desc, url) => {
      process.stdout.write(`transfer window failed to load ${url}: ${code} ${desc}\n`);
    });

    transfer = createTransferController({
      send: (channel, payload) => {
        if (!tw.isDestroyed()) tw.webContents.send(channel, payload);
      },
      // THE WINDOW, NOT THE BUTTON, and the dep is named `focusWindow` for that reason -- see its
      // docstring. `webContents.focus()` moves focus to no particular control; the form's only
      // enabled control while a transfer runs IS Cancel, because `setRunning(true)` disables
      // everything else, so bringing the window forward is the whole of the remedy. `show()`
      // first, because a close attempt can come from a window that is behind the terminal.
      focusWindow: () => { tw.show(); tw.focus(); },
      openDialog: async () => {
        // THE STUB SUBSTITUTES THE WHOLE DIALOG, never merely its default. A real modal under Xvfb
        // has nobody to click it and would HANG the harness -- a stall, not an error.
        if (SEAM.transferPath !== '') return SEAM.transferPath;
        // `tw` AS THE FIRST ARGUMENT IS WHAT MAKES THIS WINDOW-MODAL (the `showOpenDialog(window,
        // options)` overload, electron.d.ts:7850), which is what closes the interleaving recorded
        // in the AS BUILT notes: a parentless dialog leaves Start clickable while it is open, and
        // a late resolution then lands mid-transfer. `transferUi.ts`'s post-await `isRunning`
        // check is the primary guard for that and stays -- this is the half that stops the race
        // being reachable at all.
        const r = await dialog.showOpenDialog(tw, {
          title: 'Send which file?',
          properties: ['openFile'],
        });
        return r.canceled ? undefined : r.filePaths[0];
      },
      saveDialog: async () => {
        // Same stub, same reason as `openDialog` above.
        if (SEAM.transferPath !== '') return SEAM.transferPath;
        const r = await dialog.showSaveDialog(tw, { title: 'Receive into which file?' });
        // `filePath`, SINGULAR, and a STRING rather than an optional one: `SaveDialogReturnValue`
        // (electron.d.ts:23629-23637) gives '' when the dialog was canceled, where
        // `OpenDialogReturnValue` gives a `filePaths` array. So the `canceled` check is what
        // distinguishes them, and returning '' would put an empty path in the form's Local file
        // field -- erasing whatever the operator had typed, which `browseLocal` treats `undefined`
        // as specifically meaning it must not do.
        return r.canceled ? undefined : r.filePath;
      },
      startTransfer: (opts) => startTransfer({ ...opts, session, files: nodeTransferFiles }),
      buildCommand: (keywords) => transferCommand(keywords),
    });

    // THE CLOSE GUARD. `preventDefault` on `close` is what makes an accidental Cmd-W or red
    // button unable to abandon a running transfer; Cancel is the only route out.
    tw.on('close', (e) => {
      if (transfer?.shouldPreventClose() === true) {
        e.preventDefault();
        transfer.onCloseAttempt();
      }
    });
    tw.on('closed', () => {
      // GUARDED ON IDENTITY, because `closed` can arrive after a replacement window has already
      // been built: `openTransferWindow` only reuses a window that is not destroyed, so a
      // destroyed-but-not-yet-notified window would otherwise clear the NEW window's controller
      // and leave `transfer` undefined while a form sat on screen -- every submit answered 'the
      // transfer window is not open'. Nothing reaches `transfer = undefined` in that case now.
      if (transferWin !== tw) return;
      /**
       * CANCEL BEFORE CLEARING -- THE FOURTH INSTANCE OF THE TEARDOWN BUG, AND IT IS REACHABLE.
       *
       * `closed` can mean "the window was destroyed out from under a LIVE transfer", not only
       * "nothing was running". MEASURED in real Electron: closing a child window's PARENT destroys
       * the child and fires the child's `closed` WITHOUT EVER FIRING ITS `close`. So an operator
       * who closes the terminal window mid-transfer never reaches the close guard above at all.
       *
       * WHY `before-quit` IS NOT SUFFICIENT ON ITS OWN, which is the non-obvious part: the order
       * is `closed` -> this handler -> `window-all-closed` -> `app.quit()` -> `before-quit`. So by
       * the time the quit hook runs, `transfer` is ALREADY `undefined` and it has nothing left to
       * cancel. Observed: `cancel() was called 0 time(s)`, with `session.dft` still set and the
       * host waiting for a frame that never comes -- the spec's "session.dft set with the window
       * gone", reached by a different door than the identity guard above is watching.
       *
       * NOT A DOUBLE CANCEL on the ordinary paths. A `closed` that follows a REFUSED close can
       * only happen after the transfer ended -- `onDone` cleared `run` -- so `shutdown` finds
       * nothing and does nothing. Cmd-Q genuinely does reach `before-quit` first (verified order:
       * `before-quit` -> child `close` -> PREVENTED -> `closed`), and `shutdown` is idempotent, so
       * the two hooks overlapping costs nothing. `TransferRun.cancel` is itself idempotent too
       * (`transferRun.ts:388`).
       */
      // `'windowGone'` AND NOT `'sessionLost'`: the form this reason decides about has already been
      // destroyed, so there is nothing on screen to tell. `shutdown`'s own docstring has the split.
      transfer?.shutdown('windowGone');
      transferWin = undefined;
      transfer = undefined;
    });

    await tw.loadFile(join(here, '..', 'transfer.html'));
    await driveTransferWindow(tw);
  };

  /**
   * THE SIXTH SEAM'S ENTRY POINT: open the transfer window because `TN3270_GUI_TRANSFER` is set.
   *
   * A WRAPPER RATHER THAN A CALL AT EACH SITE, so the "is the seam active?" question is asked in one
   * place. `main.ts`'s own `SEAM` docstring records why that matters: three places once asked "is
   * the keys seam active?" with their own inline emptiness checks, agreed only by coincidence, and
   * one of them was the gate keeping a typed password off stdout.
   *
   * CALLED FROM THE REPLAY AND LIVE PATHS, after the input seams and before `maybeCapture`. Not from
   * the URL branch: there is no `Session` there, no `openTransferWindow` in scope, and
   * `TN3270_GUI_CLICKS` is ignored in that mode for the same reason -- an untested call site is a
   * claim this file has not earned.
   *
   * AFTER the keys, which matters for composition rather than for this seam alone: `keys.mjs` sends
   * a real Ctrl+T, and that opens the window through the `action` handler. Reaching here afterwards
   * finds the window already open, `openTransferWindow` shows and focuses it, and `driveTransferWindow`
   * is NOT re-entered -- it runs from the `loadFile` path only. A chord run therefore cannot be
   * driven by this seam, which is correct: `keys.mjs` sets no `TN3270_GUI_TRANSFER`.
   */
  const maybeOpenTransferWindow = async (): Promise<void> => {
    if (SEAM.transfer === '') return;
    await openTransferWindow();
  };

  /**
   * ONE REGISTRATION PER PROCESS, for the reason given at `transferWin` above.
   *
   * Registered OUT HERE rather than inside `openTransferWindow`, which is the difference between
   * working and crashing: `ipcMain.handle` throws on a second handler for the same channel, so
   * registering them per window would die the second time the operator closed the form and
   * pressed Ctrl-T again -- and that throw would come out of `openTransferWindow`'s promise,
   * i.e. as an unhandled rejection with no window, which is this file's worst failure shape.
   *
   * They tolerate a MISSING controller rather than assuming one, because these channels outlive
   * any particular window: the preload is only loaded by the transfer window, so in practice
   * nothing can call them while it is closed, but a handler that threw on the way to finding out
   * would reject the renderer's `invoke` with a stack trace instead of an answer.
   */
  ipcMain.handle('transfer:browse', async (_e, direction: string) =>
    transfer === undefined ? undefined : transfer.browse(direction));
  ipcMain.handle('transfer:submit', async (_e, keywords: readonly string[]) =>
    transfer === undefined
      ? { ok: false, error: 'the transfer window is not open' }
      : transfer.submit(keywords));
  ipcMain.on('transfer:cancel', () => { transfer?.requestCancel(); });

  /**
   * A QUIT CANCELS A RUNNING TRANSFER RATHER THAN BEING BLOCKED BY IT.
   *
   * The window refuses a close while running; it must not make the application unquittable.
   * Canceling here is what tells the host to leave transfer mode -- walking away leaves its
   * program waiting for a frame that never comes.
   *
   * ONE LISTENER, for the same scope reason as the handlers above: `app.on` accumulates, and a
   * per-window registration would cancel the same transfer once per window ever opened.
   * `shutdown` is safe to reach with nothing running, and swallows a `cancel` that throws --
   * which it can, on a dropped session -- because a throw here would be the unquittable app this
   * hook exists to prevent.
   */
  app.on('before-quit', () => { transfer?.shutdown('quit'); });

  /**
   * Compute the DRAW LIST here and send that, rather than sending the snapshot.
   *
   * `drawList` needs core's palette and code page, and a browser cannot resolve a bare
   * specifier like `@tn3270/core` without a bundler -- measured: the renderer failed with
   * "Failed to resolve module specifier". Doing it in main means the renderer imports only
   * its own relative modules, which is also less for it to know. It already owns no
   * protocol state, so a dropped or coalesced frame costs a repaint and never correctness.
   */
  /**
   * Grow the window to hold the whole screen, once we know how big the screen is.
   *
   * NOT COSMETIC. The screen geometry is not known until the host has spoken -- VM sends
   * Erase/Write Alternate and a model 4 becomes 43 rows -- and 44 rows of 14px is 616px,
   * which does not fit the 600px default. The first live run against VM CLIPPED the bottom
   * 16px, losing the entire OIA row: the host's own data and our status line, silently.
   *
   * The TUI refuses to draw rather than clip, because it cannot resize a terminal. A window
   * CAN resize, so it does -- and the scale follows the design's rule: the largest integer
   * multiple whose screen fits within 80% of the display work area, minimum 1.
   */
  let sized = '';
  const fit = (list: { width: number; height: number }): void => {
    const key = `${list.width}x${list.height}`;
    if (key === sized) return;                       // most frames change nothing
    sized = key;
    const area = screen.getPrimaryDisplay().workAreaSize;
    const scale = bestScale(list, {
      width: Math.floor(area.width * 0.8),
      height: Math.floor(area.height * 0.8),
    });
    win.setContentSize(list.width * scale, list.height * scale);
  };

  const send = (): void => {
    const snapshot = session.screen.snapshot();
    const oia = session.oia.toText();
    const list = drawList(
      snapshot, resolve(snapshot), geometry, scheme, oia === '' ? undefined : oia, showKeypad,
    );
    fit(list);
    win.webContents.send('frame', list);
  };
  session.on('screen', send);
  session.on('connect', send);
  session.on('disconnect', send);
  /**
   * THE SESSION GOING AWAY UNDERNEATH, which is the fourth of the paths `transferWindow.ts`'s
   * docstring names and the one nothing handled.
   *
   * A repaint alone is not enough, and the gap is not a leak in core: `Session.handleClose` clears
   * its own `dft`, so nothing is left registered down there. It is the CONTROLLER that keeps
   * `run !== undefined` forever, which makes `shouldPreventClose()` permanently true -- so the
   * transfer window refuses EVERY close on a session that is already dead. The only control left is
   * Cancel, and that throws `not connected` (`core/src/session.ts:1513`), which `cancelRun`
   * swallows and reports: an escape by error message rather than by a working control.
   *
   * A SEPARATE LISTENER rather than a line inside `send`, because `send` is the paint path and runs
   * on every frame -- putting teardown in it would mean re-deciding this on each of them. The TUI
   * does the equivalent from its own close path (`tui/src/app.ts:899-900`, `closeTransfer`), so
   * this makes the two front ends agree rather than inventing a rule for this one.
   *
   * `shutdown` and not `requestCancel`: this is the same "cancel rather than block" case as a quit,
   * and it must not throw out of an event listener -- `shutdown` swallows a failed cancel, which on
   * a dropped socket is the expected outcome rather than a surprise.
   *
   * ## `'sessionLost'` IS THE ONE REASON THAT STILL HAS SOMEBODY TO TELL
   *
   * AND THE ONE THING CANCELING DOES NOT ACHIEVE BY ITSELF, which cost this branch a defect: at
   * 24x80 the cancel THROWS on its way to the driver's `finish` (`transferRun.ts:438` ->
   * `session.sendAID` -> `not connected`), so `onDone` never fires and the form was left showing
   * 'transferring' with a dead Cancel and a dead Start -- then 30 seconds later the driver's own
   * frame timer said `press Attn or Clear: host may still be transferring`, at a host that was gone.
   * Geometry-dependent, and 24x80 is the broken one. Naming the reason is what lets `shutdown` send
   * an honest ending instead, and bump the generation so that stale timeout cannot contradict it.
   */
  session.on('disconnect', () => { transfer?.shutdown('sessionLost'); });

  /**
   * Every action the renderer sends, logged for the chord harness -- and ONLY while BOTH
   * the keys seam and replay mode are active.
   *
   * THE GATE IS A PRIVACY REQUIREMENT, NOT TIDINESS. A `type` action carries the text
   * typed, so logging unconditionally would put a password on stdout in a live session --
   * the same hazard that keeps goldens away from live logons.
   *
   * SEAM PRESENCE ALONE IS NOT ENOUGH -- do not "simplify" this back to one variable.
   * `TN3270_GUI_KEYS` has been set against a LIVE host before (docs/live-testing.md,
   * "Typed input, proved end to end"), and `keys.ts` builds a `type` action carrying the
   * text for any printable keypress, seam-driven or not -- so the seam variable alone says
   * nothing about what is on screen. REPLAY mode is what actually makes a logged keystroke
   * safe: it cannot reach a host, so nothing typed while it is active can be a live
   * credential. Both variables must be set together, which is how the Task 5 harness and
   * the Task 3 manual smoke test already use them, so this costs no coverage.
   *
   * This is the ONE funnel every renderer action passes through, which is why the harness
   * asserts here rather than on pixels: in replay mode nothing is connected, `sendAID`
   * throws 'not connected', and `applyAction` swallows it, so a PA key has no other
   * observable consequence.
   *
   * Key order in `JSON.stringify(action)` is insertion order, not a stable contract -- a
   * consumer of this log should parse and compare canonically rather than string-diffing
   * the raw line.
   */
  const logActions = SEAM.keys !== '' && SEAM.replay !== '';

  ipcMain.on('action', (_e, action: Action) => {
    if (logActions) process.stdout.write(`action: ${JSON.stringify(action)}\n`);
    // `quit` is THIS front end's business: applyAction throws on it rather than ignoring
    // it, so a front end that forgot this check fails loudly instead of being unquittable.
    if (action.kind === 'quit') { app.quit(); return; }
    // INTERCEPTED HERE, like `quit`, because `applyAction` throws on it: showing a keypad is a
    // display decision, and this is the front end that owns this display. Recomputing the frame is
    // what makes the window resize, since `fit` sizes from the draw list.
    if (action.kind === 'toggleKeypad') { showKeypad = !showKeypad; send(); return; }
    // INTERCEPTED HERE for the same reason as `quit` and `toggleKeypad`: `applyAction` THROWS on
    // it (`frontend/src/actions.ts:57-58`), because a transfer dialog is the front end's own
    // business. A front end that forgot this arm would die on the keystroke rather than being
    // silently inert -- which is the property that throw exists to give.
    //
    // `void`, NOT AWAITED, and the handler is deliberately not `async`: this is a fire-and-forget
    // UI action, and making the listener async would swallow a `loadFile` failure into an
    // unhandled rejection. The window reports its own load failures through the `did-fail-load`
    // forwarding above, which is where a diagnosis belongs.
    if (action.kind === 'transferForm') { void openTransferWindow(); return; }
    applyAction(session, action);
    send();
  });

  /**
   * A SECOND TEST SEAM: `TN3270_GUI_REPLAY=<trace>` paints a recorded trace instead of
   * connecting.
   *
   * This is how screenshot goldens are made, and the reason is not convenience. A golden
   * taken from a live logon can contain a typed password -- and goldens live in git
   * forever. It also cannot be byte-reproducible if the host paints a clock, which TK5's
   * VTAM logon panel does. A synthetic trace has neither problem and is identical on every
   * run. `docs/live-testing.md` already warns that traces carry passwords in EBCDIC, so
   * the trace CHOSEN matters as much as the mechanism.
   */
  if (SEAM.replay !== '') {
    session.replay(readFileSync(SEAM.replay, 'utf8'));
    send();
    await maybeSendKeys(win);
    // AFTER the keys, always: `clicks.mjs` shows the keypad with a real Ctrl+K, and there is no
    // keypad to click before that chord has been delivered and repainted.
    await maybeSendClicks(win);
    await maybeOpenTransferWindow();
    await maybeCapture(win);
    await quitIfKeysOnly();
    return;
  }

  try {
    await session.connect(args.host!, args.port ?? 23,
      args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {});
  } catch (err) {
    // Host and port passed in, so a TLS or socket failure names the actual target rather
    // than a placeholder -- 'vm:3270 accepted the connection but never completed a TLS
    // handshake ... use -insecure' is the message that matters against Hercules.
    fail(explain(err, args.host, args.port));
  }

  await maybeSendKeys(win);
  await maybeSendClicks(win);            // after the keys, for the reason the replay branch gives
  await maybeOpenTransferWindow();
  await maybeCapture(win);
  await quitIfKeysOnly();
});

/**
 * A THIRD TEST SEAM: `TN3270_GUI_KEYS='Alt+1,Ctrl+A,Enter'` delivers REAL key events.
 *
 * `webContents.sendInputEvent` goes in at the top of Chromium's input pipeline, so this
 * exercises the ONE link nothing else can reach: the renderer's own `keydown` listener,
 * `actionForKey`, the IPC hop and `applyAction`. A seam that injected actions at `ipcMain`
 * instead would skip exactly the part that had never run.
 *
 * SPELLINGS ARE ELECTRON ACCELERATOR NAMES, NOT DOM CODE NAMES -- `1` and `Up`, never
 * `Digit1` or `ArrowUp`, which are delivered as EMPTY events. `parseKeySpec` refuses those
 * by name; see `keyspec.ts` for the measurement.
 *
 * Note that a spelling's CASE IS IGNORED by Chromium: both `A` and `a` deliver `key: 'a'`,
 * so this seam types lowercase unless `Shift+` is given.
 *
 * THE MAC BEHAVIOR HERE IS REASONED, NOT MEASURED. Accelerator names are Chromium's own
 * vocabulary and ought to be platform-independent, but this seam has only ever run on Linux
 * under Xvfb. Treat a Mac disagreement as likely rather than surprising: `Option-1` reports
 * `key === '¡'` there, which is the whole reason `keys.ts` matches the PA keys on `e.code`,
 * and this is the first place to look if a chord goes missing on a laptop.
 *
 * Deliberately does not type a logon. On VM a completed logon arms the reconnect trap for
 * the next run (docs/live-testing.md), and a golden of a logged-on screen can contain a
 * password.
 */
async function maybeSendKeys(win: BrowserWindow): Promise<void> {
  if (SEAM.keys === '') return;
  /**
   * EVERY spec is parsed before ANY key is delivered, and a refusal EXITS rather than throws.
   *
   * `parseKeySpec` throws by design, and this runs inside `app.whenReady()`'s promise, where
   * a throw is an unhandled rejection: the steps after it -- including `quitIfKeysOnly` --
   * never run. MEASURED: `TN3270_GUI_KEYS=Digit1` printed the refusal and then SAT until the
   * harness timeout killed it, which reads as a broken client rather than as the typo it is.
   * A non-zero exit keeps the diagnosis and loses the hang. Parsing the whole list up front
   * also means a bad third spec cannot half-deliver the first two, which would leave the
   * action log looking like a mapping bug.
   */
  let chords;
  try {
    chords = SEAM.keys.split(',').map((spec) => parseKeySpec(spec));
  } catch (err) {
    // Drained before exiting, for the reason quitIfKeysOnly spells out: a write to a PIPE is
    // asynchronous, and app.exit would otherwise be free to discard the one line that says
    // what was wrong.
    await new Promise<void>((r) => { process.stderr.write(`${explain(err)}\n`, () => { r(); }); });
    // 2 is this repo's usage-error code, as cli/src/main.ts and tui/src/main.ts both use it
    // for a bad argument: a misspelled spec is the same kind of mistake, so it exits the same
    // way. And this is the ONE failure that goes to stderr only, against the rule at the top
    // of this file, because the only route to it is an env var somebody deliberately set --
    // nobody who double-clicked a `.app` can reach it, so there is no console-less user to
    // strand.
    app.exit(2);
    return;
  }
  /**
   * Let the paint settle first: typing into a screen that has no field yet proves nothing,
   * and the OIA would rightly refuse the input.
   *
   * `TN3270_GUI_SHOT_MS` IS A FLOOR WHEN A SCREENSHOT IS ALSO BEING TAKEN. Keys used to be
   * sent from inside `maybeCapture`, i.e. always after that deliberately generous wait, and
   * making the seam independent would otherwise have quietly cut a shot run's settle from
   * 2500ms to 1200ms -- a REGRESSION dressed as a refactor, and invisible to a replay smoke
   * test because a replay paints synchronously. `Math.max` also means an explicit
   * `TN3270_GUI_KEYS_MS` still wins whenever it is the larger number.
   *
   * The 1200ms default therefore only has to cover a synchronous replay paint plus startup.
   * A LIVE OR SLOW HOST SHOULD RAISE `TN3270_GUI_KEYS_MS` EXPLICITLY: against VM the first
   * screen can take seconds to arrive, and a chord delivered before it does is an input
   * inhibit, not a failed mapping -- which is a confusing thing to debug from a log.
   */
  const settleMs = SEAM.shot !== '' ? Math.max(SEAM.keysMs, SEAM.shotMs) : SEAM.keysMs;
  await new Promise((r) => setTimeout(r, settleMs));
  for (const { keyCode, modifiers } of chords) {
    // Spread conditionally: an empty `modifiers` array is not the same as absent under
    // exactOptionalPropertyTypes, and the rest of this file builds options the same way.
    const chord = { keyCode, ...(modifiers.length > 0 ? { modifiers: [...modifiers] } : {}) };
    win.webContents.sendInputEvent({ type: 'keyDown', ...chord });
    // `char` is the event that carries a TYPED CHARACTER, so it is sent for a bare key --
    // that is what a printable keystroke does, and `keys.ts` turns it into a `type` action.
    // A real Ctrl- or Alt-held keystroke produces NO char event, so sending one here would
    // simulate a keyboard that does not exist. Harmless today (the renderer listens on
    // `keydown` and the page has no editable node) and live the moment one appears.
    if (modifiers.length === 0) win.webContents.sendInputEvent({ type: 'char', ...chord });
    win.webContents.sendInputEvent({ type: 'keyUp', ...chord });
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write(`keys: sent ${SEAM.keys}\n`);
}

/**
 * A FIFTH TEST SEAM: `TN3270_GUI_CLICKS='PF1,PA2,SysRq'` clicks keypad buttons by LABEL.
 *
 * The click path -- canvas `mousedown`, the primary-button guard, `hitTestAt`, `sendAction`, the IPC
 * hop, `applyAction` -- is plumbing no unit test can reach, for the reason `hittest.ts:53-58` gives:
 * `renderer.ts` throws at module load outside a browser, so the barrel cannot export it. The same
 * argument the chord seam won. `hitTestAt`'s ARITHMETIC is separately unit-tested at scale 3 with a
 * non-zero offset (`canvas/test/keypad.test.ts:297`), so what this seam carries is the wiring, which
 * is provable at any scale -- and just as well, because in native Electron mode the centring offset
 * can never be non-zero at ANY scale: `fit` sets the content size to exactly `list.width * scale` by
 * `list.height * scale`, so `center` returns (0,0) for every model on every display. The SCALE does
 * vary with the display -- `fit` takes 80% of the work area -- and this seam does not care, because
 * it asks the renderer for a point rather than computing one.
 *
 * ASKS THE RENDERER WHERE THE BUTTON IS, rather than carrying coordinates. A coordinate list here
 * would be a second copy of the layout that agreed with itself while the layout was wrong -- the one
 * failure this seam exists to catch. `__tn3270ButtonCenter` returns a point; the CLICK still goes in
 * through Chromium, so nothing about the path under test is bypassed.
 *
 * THE SETTLE IS NOT DECORATION. `clicks.mjs` shows the keypad with a real `Ctrl+K` first, and that
 * action makes the window GROW (`fit` re-sizes from the new draw list: 720x350 to 720x476 for a
 * model 2). Every keypad button is in the pixels that resize adds, so a click delivered before it
 * lands outside the content area entirely and hits nothing. `maybeSendKeys` has already waited
 * `keysMs` before its own first chord; this waits again because the chord that matters is the LAST
 * one, and because a clicks-only run gets no settle from `maybeSendKeys` at all.
 *
 * NOT CALLED FROM THE URL BRANCH, unlike `maybeSendKeys`. In that mode the served page owns the
 * protocol and main sees no frames, so nothing here would be wrong -- `__tn3270ButtonCenter` reads
 * the renderer's own `last` -- but no harness drives it that way and an untested call site is a
 * claim this file has not earned. `TN3270_GUI_CLICKS` is therefore IGNORED alongside
 * `TN3270_GUI_URL`, which fails loudly rather than quietly: no `clicks: sent` line is printed, and
 * `clicks.mjs`'s seam-ran bail is exactly the check for that.
 */
async function maybeSendClicks(win: BrowserWindow): Promise<void> {
  if (SEAM.clicks === '') return;
  await new Promise((r) => setTimeout(r, SEAM.keysMs));
  for (const label of SEAM.clicks.split(',')) {
    /**
     * VIEWPORT PIXELS, which is what `sendInputEvent` wants -- and that equality is a property of
     * `gui/index.html`, not of the renderer: `html,body{margin:0}`, `canvas{display:block}` and
     * `overflow:hidden`, so the canvas box starts at the viewport origin and cannot scroll away
     * from it. The renderer computes the point from the canvas's own origin (that is where its
     * `offsetX` is measured from too). Give the page a body margin and every click here misses by
     * it.
     */
    let at;
    try {
      at = await win.webContents.executeJavaScript(
        `window.__tn3270ButtonCenter(${JSON.stringify(label)})`,
      ) as { x: number; y: number } | null;
    } catch (err) {
      /**
       * A REJECTION HERE WOULD OTHERWISE HANG THE PROCESS, which is the exact trap `maybeSendKeys`
       * measured for `parseKeySpec`: a throw inside `app.whenReady()`'s promise is an unhandled
       * rejection, so `quitIfKeysOnly` never runs and the client SITS until the harness's 120s
       * timeout -- which reads as a broken client rather than as the broken renderer it is.
       *
       * The reachable cause is a renderer that threw before installing the probe: it is a `window`
       * global set in `renderer.js`'s module body, and if the canvas or the 2D context is missing
       * that module throws at load, leaving `window.__tn3270ButtonCenter` undefined and this call
       * rejecting with a TypeError. Exiting 2 keeps the diagnosis and loses the hang, exactly as the
       * bad-spelling path above does -- and `clicks.mjs`'s status bail then dumps the stdout, which
       * has the renderer's own `renderer[3]` line in it.
       */
      await new Promise<void>((r) => {
        process.stdout.write(`clicks: PROBE FAILED ${label}: ${explain(err)}\n`, () => { r(); });
      });
      app.exit(2);
      return;
    }
    if (at === null) {
      // NOT a plumbing failure and reported as its own thing: either the keypad is hidden -- so
      // there is no `list.keypad` to search -- or the label is not in the table. `clicks.mjs` bails
      // on this line separately for that reason.
      process.stdout.write(`clicks: NO BUTTON ${label}\n`);
      continue;
    }
    // A PAIR, because a press without a release leaves Chromium holding the button down and the
    // renderer holding its highlight: `release()` runs on `mouseup`, and the next `mousedown`
    // would arrive during a drag.
    for (const type of ['mouseDown', 'mouseUp'] as const) {
      win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  process.stdout.write(`clicks: sent ${SEAM.clicks}\n`);
}

/**
 * A SIXTH TEST SEAM: `TN3270_GUI_TRANSFER='localFile=/tmp/f,hostFile=A.B,submit'` drives the transfer
 * window, and reports what it did.
 *
 * ## WHAT IT COVERS THAT NOTHING ELSE CAN
 *
 * A second `BrowserWindow`, its own preload bridge, `transfer.html`'s IMPORT MAP, every line of
 * `transferBoot.ts`, and the `transfer:submit` hop into the controller. None of that is reachable
 * from vitest: `transferBoot.ts` needs a `document` and there is none under `environment: 'node'`,
 * this file cannot be imported at all, and no fake DOM can fail to resolve a module specifier.
 * `transferUi.ts`'s docstring names this seam's harness as the only thing that can see a
 * blank-window-with-no-error -- which this branch shipped once already, as a TDZ read in
 * `transferBoot.ts`.
 *
 * ## STEPS, NOT COORDINATES, AND THE ECHO IS THE MODEL'S OWN VALUE
 *
 * Each step names a FIELD BY ID and goes through `window.__tn3270SetField`, which calls the same
 * `ui.type` a keystroke does. The line printed back carries `ui.values()[id]` rather than the
 * string this function handed over, so a value the MODEL REFUSED cannot be reported as set -- a
 * non-digit into `Lrecl`, a cycle field, an id that is not in the table. A seam that echoed its own
 * input would pass while the form ignored it.
 *
 * ## EVERY LINE HERE IS GATED, AND THAT IS A PRIVACY RULE RATHER THAN TIDINESS
 *
 * A `localFile=` line carries a PATH, in a window opened in front of a live logged-on session. The
 * same argument gates the action log (see `logActions`) and keeps goldens away from live logons.
 *
 * THE GATE IS THE EARLY RETURN BELOW AND NOTHING ELSE -- one `if` ahead of every write, rather than
 * a condition on each. That is deliberate: a per-line gate is a thing each new line has to
 * remember, and the one that forgets is the one that prints a path. A whole FUNCTION that is not
 * entered is structural. `transferSeam.test.ts` pins it by reading this file as text, since nothing
 * can import it.
 *
 * NOT GATED ON REPLAY MODE, unlike `logActions`, and the asymmetry is reasoned. That gate exists
 * because `TN3270_GUI_KEYS` is used against live hosts and `keys.ts` builds a `type` action
 * carrying typed text for every printable keypress -- so the seam variable alone says nothing about
 * what is on screen. This seam has no such life: it is set by a harness, the paths it prints are
 * the harness's own, and requiring replay would make it unable to ever drive a real transfer by
 * hand -- which is the thing a human would most want it for.
 */
async function driveTransferWindow(tw: BrowserWindow): Promise<void> {
  if (SEAM.transfer === '') return;
  process.stdout.write('transfer window: opened\n');
  /**
   * THE FIELD COUNT FIRST, BEFORE ANY STEP RUNS.
   *
   * This is the blank-window check, and it describes the form AS FIRST DRAWN, which is what "did it
   * render" means. The plan for this seam printed it LAST, after the submit, where the number
   * describes whatever the submit left behind and a reader has to know which -- and where a
   * scenario that crashed mid-way would print no count at all, losing the one line that says the
   * window is not blank.
   */
  const rows = await tw.webContents.executeJavaScript(
    'document.querySelectorAll("#fields .row").length',
  ) as number;
  process.stdout.write(`transfer window: fields=${rows}\n`);

  for (const step of SEAM.transfer.split(',')) {
    /**
     * SPLIT ON THE FIRST `=` ONLY, KEEPING THE REMAINDER -- and `split('=', 2)` DOES NOT DO THAT.
     *
     * The plan for this seam used it. JavaScript's second argument is a LIMIT ON THE OUTPUT, not
     * Python's maxsplit: `'path=/tmp/a=b'.split('=', 2)` is `['path', '/tmp/a']`, silently
     * discarding `=b`. Verified under node. So a Windows path, or any value containing `=`, would
     * have been TRUNCATED and the field set to a prefix -- and the echoed line would have agreed
     * with the truncation, because it reports what the model holds. `indexOf` plus `slice` keeps
     * the remainder whole.
     */
    const at = step.indexOf('=');
    const name = at < 0 ? step : step.slice(0, at);
    const value = at < 0 ? undefined : step.slice(at + 1);

    if (name === 'submit') {
      const r = await tw.webContents.executeJavaScript('window.__tn3270Submit()') as
        { ok: boolean; status: string };
      // THE FORM'S OWN STATUS LINE, which is what a user would see and what distinguishes a
      // validator complaint from `not in 3270 mode` from 'the transfer window is not open'. `ok`
      // alone is satisfied by all three, i.e. by the form never having been filled in.
      process.stdout.write(`transfer window: submit -> ok=${r.ok} status=${r.status}\n`);
      continue;
    }
    if (value === undefined) {
      // REPORTED, not ignored, for the reason `SEAM.transfer`'s docstring gives.
      process.stdout.write(`transfer window: UNKNOWN STEP ${step}\n`);
      continue;
    }
    /**
     * THE FIELD ID IS NOT VALIDATED HERE, and that is the renderer's job rather than an omission.
     * `__tn3270SetField` returns what the model holds afterwards, so an id outside
     * `TransferFieldId` comes back as the empty string and the echo below says so -- a line reading
     * `localFil=` is a visible failure, where a list of legal ids in this file would be a second
     * copy of `TRANSFER_FIELDS` that could agree with itself while the form disagreed.
     */
    const held = await tw.webContents.executeJavaScript(
      `window.__tn3270SetField(${JSON.stringify(name)}, ${JSON.stringify(value)})`,
    ) as string;
    process.stdout.write(`transfer window: ${name}=${held}\n`);
  }

  /**
   * THE RUN HAS TO END ITSELF, and `quitIfKeysOnly` will not do it: it returns early unless the
   * keys or clicks seam is set, so a transfer-only run reaches the end of `app.whenReady()`'s
   * callback with two windows open and SITS THERE until something kills it. Measured before this
   * line existed: the harness burned its full 120-second timeout, which is the stall-rather-than-
   * fail shape this file keeps writing comments about.
   *
   * NOT FOLDED INTO `quitIfKeysOnly`, deliberately. That function is reached from three places on
   * the main window's paths, all AFTER `maybeCapture`; this seam runs inside `openTransferWindow`,
   * which is called from the `action` handler and from Ctrl-T -- i.e. at a time nothing in those
   * paths is waiting. Widening its condition would make it quit from whichever path happened to
   * reach it first, which for a `transferForm` action is a race with the scenario still running.
   *
   * THE DRAIN IS NOT OPTIONAL, and `quitIfKeysOnly` has the measurement: writing to a PIPE is
   * asynchronous, and with no drain output stops at one 64000-byte buffer with the last line GONE,
   * three runs out of three. Everything this function prints is what the harness scores, and the
   * `submit ->` line is the LAST of them.
   *
   * A SHOT RUN IS LEFT ALONE, so the two seams compose rather than racing: `maybeCapture` quits
   * when it has its picture, and quitting here first would leave a zero-byte PNG. That is also what
   * makes the privacy check in the AS BUILT notes runnable -- a `TN3270_GUI_SHOT` run with this
   * variable unset prints nothing and exits on its own.
   */
  if (SEAM.shot !== '') return;
  await new Promise<void>((r) => { process.stdout.write('', () => { r(); }); });
  app.quit();
}

/**
 * A keys-only run has to quit itself.
 *
 * `maybeCapture` quits when it has taken its picture, but a chord run takes none -- and
 * without this the process hangs, which reads as a broken client rather than a missing exit.
 *
 * A CLICKS-ONLY RUN IS THE SAME RUN, hence the second half of the condition rather than a second
 * quit path: it also produces only stdout, and `clicks.mjs` reads that stdout with a 120s timeout,
 * so a client that did not quit would burn the timeout and arrive as `error`/SIGTERM -- diagnosable,
 * but as "the client never ran to completion" rather than as the missing exit it is. The NAME still
 * says keys because `keys.mjs` and the docs cite it, and a rename would invalidate those citations
 * for no gain; read it as "an input-seam-only run".
 *
 * ## THE DRAIN, AND WHY THERE IS NO SLEEP BESIDE IT
 *
 * MEASURED 2026-09-15, because a fixed sleep here would have been exactly the kind of
 * unjustified number this file otherwise refuses. Writing ~5MB to a PIPE and exiting:
 *
 *  - with no drain at all, output stops at 64000 bytes -- one pipe buffer -- and the last
 *    line is GONE, three runs out of three. So the hazard is real, not folklore.
 *  - with `write('', cb)` and exit from the callback, all 5000005 bytes arrive, three out of
 *    three. An EMPTY chunk still queues behind the pending ones, which is the property being
 *    relied on here.
 *
 * A 200ms sleep after that callback was also tried and removed: the full chord sequence ran
 * 20 times with the callback alone and all 20 kept every `action:` line and the trailing
 * `keys:` line. The callback is the mechanism; the sleep only made it look like one.
 *
 * The seam's own output is a few hundred bytes and would fit the buffer regardless -- the
 * drain earns its place for the run that adds a longer chord list or a slower reader.
 */
async function quitIfKeysOnly(): Promise<void> {
  if ((SEAM.keys === '' && SEAM.clicks === '') || SEAM.shot !== '') return;
  await new Promise<void>((resolve) => { process.stdout.write('', () => { resolve(); }); });
  app.quit();
}

/**
 * A TEST SEAM, not a feature: `TN3270_GUI_SHOT=<path>` captures the window and exits.
 *
 * `capturePage()` is a main-process API, so a screenshot harness cannot reach it from
 * outside -- something in here has to take the picture. This is the same instinct as
 * `app.ts` injecting its streams rather than reaching for `process`: the alternative is a
 * renderer nothing can check without a human looking at it.
 *
 * `TN3270_GUI_SHOT_MS` is how long to let the host finish painting first. It defaults
 * generously because a missed frame produces a blank golden, which looks like a rendering
 * bug rather than a timing one. It runs AFTER `maybeSendKeys`, so a run with both seams set
 * still gets its full settle before the capture -- and the keys are in the picture.
 * `maybeSendKeys` ALSO applies this value as a floor on its own wait, so making the keys seam
 * independent did not shorten the settle a screenshot run used to get; the reasoning is
 * there rather than here, next to the `Math.max` that does it.
 */
async function maybeCapture(win: BrowserWindow): Promise<void> {
  const path = SEAM.shot;
  if (path === '') return;
  await new Promise((r) => setTimeout(r, SEAM.shotMs));
  const image = await win.webContents.capturePage();
  writeFileSync(path, image.toPNG());

  /**
   * The hash is of the RAW BITMAP, not of the PNG.
   *
   * Rendering is deterministic -- bitmap glyphs at integer scale with smoothing off have no
   * hinting and no subpixel antialiasing -- but the PNG ENCODER is not part of that promise
   * and can change between Electron versions. Hashing `toBitmap()` compares what was drawn;
   * hashing the file would compare what was drawn AND how it was compressed, and a goldens
   * suite that breaks on an Electron upgrade teaches people to run --update without looking.
   *
   * The PNG is still written, for a human to look at when a hash does differ.
   */
  writeFileSync(`${path}.sha256`, createHash('sha256').update(image.toBitmap()).digest('hex'));
  const { width, height } = image.getSize();
  process.stdout.write(`shot: ${path} ${width}x${height}\n`);
  app.quit();
}

app.on('window-all-closed', () => { app.quit(); });
