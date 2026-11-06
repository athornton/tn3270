import { contextBridge, ipcRenderer } from 'electron';

/**
 * The startup Connect dialog's bridge. A `.cts` FILE ON PURPOSE, like every preload here: an ESM
 * preload fails with "Cannot use import statement outside a module" and the bridge then silently
 * never appears -- a dialog whose Connect does nothing. See `transferPreload.cts`.
 *
 * `tn3270connect` AND NOT AN ADDITION TO `tn3270`: `exposeInMainWorld` defines a NON-WRITABLE
 * property, and two bridges sharing a name is a measured failure recorded in `main.ts`.
 *
 * THREE FUNCTIONS, all of them main's: the model list (so the page imports nothing from core), the
 * submit (whose answer is the parser's own words), and quit.
 */
contextBridge.exposeInMainWorld('tn3270connect', {
  /** The dropdown's models and its default, from `KNOWN_MODELS` in main. */
  models: (): Promise<{ models: readonly string[]; default: string }> =>
    ipcRenderer.invoke('connect:models') as Promise<{ models: readonly string[]; default: string }>,
  /**
   * `invoke`, not `send`: a refusal is the ANSWER, shown in the dialog, which stays open. On
   * `{ ok: true }` main closes this window and starts the session.
   */
  submit: (form: { host: string; model: string; tls: boolean }): Promise<{ ok?: true; error?: string }> =>
    ipcRenderer.invoke('connect:submit', form) as Promise<{ ok?: true; error?: string }>,
  /** Quit the application: there is nothing to show without a host. */
  quit: (): void => { ipcRenderer.send('connect:quit'); },
});
