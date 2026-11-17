/**
 * Ctrl-] quits, from any of this app's windows -- and ONLY from this app's windows.
 *
 * It used to be `globalShortcut.register('Control+]')`, which is system-wide: Ctrl-] typed in
 * another application (telnet's escape key, in a terminal) quit TN3270. main.ts now checks each
 * window's `before-input-event` with this, so the Connect dialog and the child windows quit too,
 * as the global shortcut let them, without reaching outside the app.
 *
 * The rule is the renderer's (`canvas/src/keys.ts`, the CTRL table and its Alt/Meta guard): Ctrl
 * with neither Alt nor Meta, so Windows' AltGr (reported as Ctrl+Alt) still types `]`. HERE AND NOT
 * IN main.ts because main.ts imports `electron`, which vitest cannot load.
 */
export interface KeyInput {
  type: string;
  key: string;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

export function isQuitChord(input: KeyInput): boolean {
  return input.type === 'keyDown' && input.control && !input.alt && !input.meta && input.key === ']';
}
