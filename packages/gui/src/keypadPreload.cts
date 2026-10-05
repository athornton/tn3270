import { contextBridge, ipcRenderer } from 'electron';

/**
 * The keypad window's bridge. A `.cts` FILE ON PURPOSE -- an ESM preload fails with "Cannot use
 * import statement outside a module" and the bridge then SILENTLY NEVER APPEARS, leaving a window
 * whose buttons all do nothing and no error anywhere. See `preload.cts` and
 * `transferPreload.cts`, which carry the same note for the same measured reason.
 *
 * `tsconfig.json` already includes `src/**\/*.cts`, so `tsc` emits `dist/keypadPreload.cjs` with
 * no build-script step -- the same path `transferPreload.cjs` takes.
 *
 * ## ONE FUNCTION, WHICH IS THE WHOLE SURFACE
 *
 * A keypad press is exactly the `sendAction` the canvas window already has, so this window needs
 * nothing else: no `invoke`, no reply, no events. It reuses main's EXISTING `ipcMain.on('action')`
 * handler, which is why this feature adds no new IPC channel anywhere -- and why a button here
 * reaches `applyAction` by precisely the route a canvas keypad click used to.
 *
 * ## FIVE FUNCTIONS IN THE TRANSFER BRIDGE DID NOT BREAK THE FOUR-FUNCTION RULE, AND NOR DOES ONE HERE
 *
 * That rule (`web/src/bridgecore.ts`) is about the CANVAS bridge, whose width is what lets
 * `renderer.ts` be reused UNMODIFIED by the web gateway. This is a different window with a
 * different surface. Widening the canvas bridge to carry keypad presses instead would be the
 * actual mistake: the browser front end would have to stub a window it cannot open.
 *
 * ## THE EXPOSED NAME IS UNIQUE, AND THAT IS MEASURED RATHER THAN STYLISTIC
 *
 * `exposeInMainWorld` defines a NON-WRITABLE property, and `main.ts:161-164` records the measured
 * failure from a collision: "Cannot assign to read only property 'tn3270' of object '#<Window>'".
 * The canvas window is `tn3270` and the transfer window `tn3270transfer`, so this is
 * `tn3270keypad`.
 *
 * `contextIsolation` stays on and `nodeIntegration` off. This window sits in front of a logged-on
 * host session and sends it AIDs, so it is the last place to grant Node access.
 */
contextBridge.exposeInMainWorld('tn3270keypad', {
  /**
   * Fire a keypad action at the session.
   *
   * `send`, NOT `invoke`: there is nothing to answer. The screen repaints by the frame that main
   * pushes to the CANVAS window afterwards, which is a different window entirely -- so a reply
   * here would be a promise resolving to nothing, and awaiting it would only hide that.
   */
  sendAction: (action: unknown): void => { ipcRenderer.send('action', action); },
});
