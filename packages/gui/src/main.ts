import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolveTerminalType, resolveAlternateSize, resolve, TerminalTypeError } from '@tn3270/core';
import {
  applyAction, defaultSession, describeTlsError, resolveScheme, type Action,
} from '@tn3270/frontend';
import { drawList, blankColumns, bestScale, readAtlas } from '@tn3270/canvas';
import { parseGuiArgs, UsageError } from './args.js';
import { parseKeySpec } from './keyspec.js';

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
 * named here still reaches `parseGuiArgs`, so an unrecognised flag is still an error --
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
      snapshot, resolve(snapshot), geometry, scheme, oia === '' ? undefined : oia,
    );
    fit(list);
    win.webContents.send('frame', list);
  };
  session.on('screen', send);
  session.on('connect', send);
  session.on('disconnect', send);

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
 * THE MAC BEHAVIOUR HERE IS REASONED, NOT MEASURED. Accelerator names are Chromium's own
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
 * A keys-only run has to quit itself.
 *
 * `maybeCapture` quits when it has taken its picture, but a chord run takes none -- and
 * without this the process hangs, which reads as a broken client rather than a missing exit.
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
  if (SEAM.keys === '' || SEAM.shot !== '') return;
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
