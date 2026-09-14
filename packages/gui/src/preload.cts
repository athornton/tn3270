import { contextBridge, ipcRenderer } from 'electron';

/**
 * A `.cts` FILE ON PURPOSE. Electron preload scripts are CommonJS -- an ESM preload fails
 * with "Cannot use import statement outside a module" and the bridge silently never
 * appears, leaving a blank window and no error in the renderer. TypeScript compiles `.cts`
 * to `.cjs` with CommonJS semantics, so this stays typechecked instead of becoming a
 * hand-written JavaScript file.
 */

/**
 * The ONLY bridge between the protocol and the canvas: frames down, actions up.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer cannot reach a socket
 * even if it tried. That is not ceremony -- the renderer parses nothing and owns no protocol
 * state, so a compromise there costs a repaint. Widening this surface is what would change
 * that, which is why it is two functions and not an object graph.
 */
contextBridge.exposeInMainWorld('tn3270', {
  /** Receive the glyph atlas once: geometry, coverage bytes and the blank-column set. */
  onAtlas: (fn: (atlas: unknown) => void) => {
    ipcRenderer.on('atlas', (_e, atlas) => { fn(atlas); });
  },
  /**
   * Receive a finished draw list.
   *
   * The LIST, not the snapshot: `drawList` needs core's palette and code page, and a
   * browser cannot resolve a bare specifier like `@tn3270/core` without a bundler. Doing
   * the work in main means the renderer imports nothing but its own relative modules --
   * which is also less for it to know, and it already owns no protocol state.
   */
  onFrame: (fn: (frame: unknown) => void) => {
    ipcRenderer.on('frame', (_e, frame) => { fn(frame); });
  },
  /** Receive a message to show instead of a screen (connect and TLS failures). */
  onError: (fn: (message: string) => void) => {
    ipcRenderer.on('error-message', (_e, message: string) => { fn(message); });
  },
  /** Send one named 3270 action up to the session. */
  sendAction: (action: unknown) => { ipcRenderer.send('action', action); },
});
