import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { resolveTerminalType, resolveAlternateSize, resolve, TerminalTypeError } from '@tn3270/core';
import {
  applyAction, defaultSession, describeTlsError, resolveScheme, type Action,
} from '@tn3270/frontend';
import { parseGuiArgs, UsageError } from './args.js';
import { drawList, type AtlasGeometry } from './drawlist.js';
import { blankColumns, bestScale } from './blit.js';

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
      // `.cjs`, compiled from preload.cts: an ESM preload cannot load. See that file.
      preload: join(here, 'preload.cjs'),
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
  const geometry = JSON.parse(
    readFileSync(join(here, 'atlas.json'), 'utf8')) as AtlasGeometry;
  const coverage = new Uint8Array(readFileSync(join(here, 'atlas.bin')));
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

  ipcMain.on('action', (_e, action: Action) => {
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
  const replayPath = process.env['TN3270_GUI_REPLAY'];
  if (replayPath !== undefined && replayPath !== '') {
    session.replay(readFileSync(replayPath, 'utf8'));
    send();
    await maybeCapture(win);
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

  await maybeCapture(win);
});

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
 * bug rather than a timing one.
 */
/**
 * A THIRD TEST SEAM: `TN3270_GUI_KEYS=A,B,Enter` delivers REAL key events to the window.
 *
 * `webContents.sendInputEvent` goes in at the top of Chromium's input pipeline, so this
 * exercises the ONE link nothing else can reach: the renderer's own `keydown` listener,
 * `actionForKey`, the IPC hop and `applyAction`. A seam that injected actions at `ipcMain`
 * instead would skip exactly the part that had never run.
 *
 * Deliberately does not type a logon. On VM a completed logon arms the reconnect trap for
 * the next run (docs/live-testing.md), and a golden of a logged-on screen can contain a
 * password.
 */
async function maybeSendKeys(win: BrowserWindow): Promise<void> {
  const keys = process.env['TN3270_GUI_KEYS'];
  if (keys === undefined || keys === '') return;
  for (const key of keys.split(',')) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    win.webContents.sendInputEvent({ type: 'char', keyCode: key });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write(`keys: sent ${keys}\n`);
}

async function maybeCapture(win: BrowserWindow): Promise<void> {
  const path = process.env['TN3270_GUI_SHOT'];
  if (path === undefined || path === '') return;
  const waitMs = Number(process.env['TN3270_GUI_SHOT_MS'] ?? '2500');
  await new Promise((r) => setTimeout(r, waitMs));
  // Keys AFTER the host has painted: typing into a screen that has no field yet proves
  // nothing, and the OIA would rightly refuse the input.
  await maybeSendKeys(win);
  await new Promise((r) => setTimeout(r, 800));
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
