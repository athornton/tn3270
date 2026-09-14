import { app, BrowserWindow, globalShortcut } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Electron main: the Session, the socket and the window live here.
 *
 * CTRL-] QUITS, AND THAT IS NOT A STYLE CHOICE. Ctrl-C is the Clear AID -- a 3270 user
 * needs it constantly to dismiss VM's MORE... state -- so the usual instinct for escaping
 * cannot be the way out, and an undocumented alternative is no alternative. The TUI has
 * the same binding and says so in its banner; `BINDING_INTENT` in `@tn3270/frontend`
 * records it for both.
 *
 * ## THREE FLAGS AND ONE WINDOW OPTION THAT ARE NOT NEGOTIABLE HERE
 *
 * Measured on this box 2026-08-28, written up in docs/live-testing.md under *Electron
 * headless re-verification*:
 *
 *  - `--no-sandbox`: Chromium's sandbox wants privileges this box does not grant.
 *  - `--disable-gpu`: there is no GL at all (`GLX is not present`), and WITHOUT this a
 *    `show: false` window HANGS rather than failing -- a stall, not an error, which is the
 *    same shape as the TLS trap and reads as a broken build.
 *  - `useContentSize: true`: `capturePage()` returns the CONTENT area, so a 400x200 window
 *    otherwise produces a 400x173 image. Without this every screenshot golden silently
 *    depends on window chrome height and will not reproduce on a Mac.
 *
 * The first two are command-line flags the launcher passes; the third is here.
 */
const here = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    // See the note above: this is what makes capturePage() match the window we asked for.
    useContentSize: true,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(join(here, '..', 'index.html'));
  globalShortcut.register('Control+]', () => { app.quit(); });
});

app.on('window-all-closed', () => { app.quit(); });
