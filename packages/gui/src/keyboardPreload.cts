import { contextBridge, ipcRenderer } from 'electron';

/**
 * The full-keyboard window's bridge. A `.cts` FILE ON PURPOSE -- an ESM preload fails with "Cannot
 * use import statement outside a module" and the bridge then SILENTLY NEVER APPEARS, leaving a
 * window whose 118 caps all do nothing and no error anywhere. See `preload.cts`,
 * `transferPreload.cts` and `keypadPreload.cts`, which carry the same note for the same measured
 * reason.
 *
 * `tsconfig.json` already includes `src/**\/*.cts`, so `tsc` emits `dist/keyboardPreload.cjs` with
 * no build-script step -- the same path the other three take.
 *
 * ## ONE FUNCTION, WHICH IS THE WHOLE SURFACE
 *
 * A key press is exactly the `sendAction` the canvas window already has, so this window needs
 * nothing else: no `invoke`, no reply, no events. It reuses main's EXISTING `ipcMain.on('action')`
 * handler, which is why this feature adds no new IPC channel anywhere.
 *
 * ## A SEPARATE PRELOAD FROM THE KEYPAD'S, AND NOT MERELY FOR SYMMETRY
 *
 * `keypadPreload.cts` exposes `tn3270keypad` and this exposes `tn3270keyboard`. Reusing the
 * keypad's file would mean the keyboard window's boot module read a property named for the other
 * surface -- which works and is a lie in a diff, the kind this repo pays for later. The cost of a
 * second file is nine lines of real code.
 *
 * ## THE EXPOSED NAME IS UNIQUE, AND THAT IS MEASURED RATHER THAN STYLISTIC
 *
 * `exposeInMainWorld` defines a NON-WRITABLE property, and `main.ts:161-164` records the measured
 * failure from a collision: "Cannot assign to read only property 'tn3270' of object '#<Window>'".
 * The canvas window is `tn3270`, the transfer window `tn3270transfer` and the keypad
 * `tn3270keypad`, so this is `tn3270keyboard`.
 *
 * `contextIsolation` stays on and `nodeIntegration` off. This window sits in front of a logged-on
 * host session and sends it AIDs, so it is the last place to grant Node access.
 */
contextBridge.exposeInMainWorld('tn3270keyboard', {
  /**
   * Fire a key's action at the session.
   *
   * `send`, NOT `invoke`: there is nothing to answer. The screen repaints by the frame that main
   * pushes to the CANVAS window afterwards, which is a different window entirely -- so a reply
   * here would be a promise resolving to nothing, and awaiting it would only hide that.
   */
  sendAction: (action: unknown): void => { ipcRenderer.send('action', action); },
});
