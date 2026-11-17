/**
 * Ctrl-] and Ctrl-Q quit, from any of this app's windows -- and ONLY from this app's windows.
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
  return input.type === 'keyDown' && input.control && !input.alt && !input.meta && QUIT_KEYS.has(input.key);
}

/**
 * `]` is c3270's quit chord; `q` is the one every keyboard layout can type. Ctrl-] needs AltGr on
 * German and French layouts, where Windows reports AltGr as Ctrl+Alt and the Alt guard above then
 * refuses it. Ctrl-Q is no 3270 chord here (the renderer's CTRL table is c r u ] a d f k b t), and
 * it matches the File -> Quit item's accelerator (menu.ts).
 */
const QUIT_KEYS: ReadonlySet<string> = new Set([']', 'q', 'Q']);

/**
 * The `before-input-event` listener main.ts gives every window: on Ctrl-] it keeps the key from
 * the page (so the terminal's renderer does not ALSO send `quit`) and calls `quit` once. Every other
 * key passes through untouched. Separate from main.ts so a test can drive it with a fake event.
 */
export function quitOnChord(quit: () => void): (event: { preventDefault(): void }, input: KeyInput) => void {
  return (event, input) => {
    if (isQuitChord(input)) { event.preventDefault(); quit(); }
  };
}
