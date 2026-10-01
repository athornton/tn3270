import { contextBridge, ipcRenderer } from 'electron';

/**
 * The transfer window's bridge. A `.cts` FILE ON PURPOSE -- an ESM preload fails with "Cannot
 * use import statement outside a module" and the bridge then silently never appears, leaving a
 * window that does nothing and no error anywhere. See `preload.cts` for the same note.
 *
 * ## FIVE FUNCTIONS HERE DOES NOT BREAK THE FOUR-FUNCTION RULE
 *
 * That rule (`packages/web/src/bridgecore.ts`) is about the CANVAS bridge, whose width is what
 * lets `renderer.ts` be reused UNMODIFIED by the web gateway. This is a different window with a
 * different surface. Widening the canvas bridge to carry transfers instead would force the
 * browser front end to stub functions it cannot implement -- there is no native file dialog in a
 * browser, and the gateway's filesystem is not the operator's.
 *
 * ## THE NAME IS DIFFERENT FROM THE CANVAS WINDOW'S, DELIBERATELY
 *
 * `exposeInMainWorld` defines a NON-WRITABLE property. `main.ts:161-164` records the measured
 * failure from a name collision ("Cannot assign to read only property 'tn3270' of object
 * '#<Window>'"), so this is `tn3270transfer` and not an addition to `tn3270`.
 *
 * `contextIsolation` stays on and `nodeIntegration` off. This window handles file paths and
 * sits in front of a logged-on host session, so it is the last place to grant Node access.
 */
contextBridge.exposeInMainWorld('tn3270transfer', {
  /** Open a native file dialog. Resolves to a path, or undefined if the user canceled. */
  browse: (direction: string): Promise<string | undefined> =>
    ipcRenderer.invoke('transfer:browse', direction) as Promise<string | undefined>,
  /**
   * Hand the form's keywords to main.
   *
   * `invoke`, not `send`, because a LOCAL refusal is the answer: `startTransfer` checks 3270
   * mode, the keyboard lock, the field and the file BEFORE the host is told anything, and the
   * form must show that without the round trip going through `onDone` -- which fires only for
   * transfers that actually started.
   */
  submit: (keywords: readonly string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('transfer:submit', keywords) as Promise<{ ok: boolean; error?: string }>,
  /** Abort a running transfer. Fire-and-forget: the outcome arrives through `onDone`. */
  cancel: (): void => { ipcRenderer.send('transfer:cancel'); },
  onProgress: (fn: (text: string) => void): void => {
    ipcRenderer.on('transfer:progress', (_e, text: string) => { fn(text); });
  },
  onDone: (fn: (r: { ok: boolean; error?: string; bytes?: number }) => void): void => {
    ipcRenderer.on('transfer:done', (_e, r) => { fn(r); });
  },
});
