import { app, BrowserWindow, globalShortcut, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveTerminalType, resolveAlternateSize, resolve, TerminalTypeError } from '@tn3270/core';
import { applyAction, defaultSession, describeTlsError, type Action } from '@tn3270/frontend';
import { parseGuiArgs, UsageError } from './args.js';

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
      preload: join(here, 'preload.js'),
    },
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

  // The renderer holds no protocol state, so a dropped or coalesced frame costs a repaint
  // and never correctness -- the same property that lets the TUI diff its output safely.
  const send = (): void => {
    const snapshot = session.screen.snapshot();
    win.webContents.send('frame', {
      snapshot,
      resolved: resolve(snapshot),
      oia: session.oia.toText(),
    });
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

  try {
    await session.connect(args.host!, args.port ?? 23,
      args.lus !== undefined && args.lus.length > 0 ? { lus: args.lus } : {});
  } catch (err) {
    // Host and port passed in, so a TLS or socket failure names the actual target rather
    // than a placeholder -- 'vm:3270 accepted the connection but never completed a TLS
    // handshake ... use -insecure' is the message that matters against Hercules.
    fail(explain(err, args.host, args.port));
  }
});

app.on('window-all-closed', () => { app.quit(); });
