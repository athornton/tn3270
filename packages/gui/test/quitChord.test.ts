import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isQuitChord } from '../src/quitChord.js';

/** Electron's `before-input-event` Input, the fields `isQuitChord` reads. */
const key = (over: Partial<Parameters<typeof isQuitChord>[0]> = {}) =>
  ({ type: 'keyDown', key: ']', control: true, alt: false, meta: false, shift: false, ...over });

describe('isQuitChord', () => {
  it('is Ctrl-] on key down, the renderer rule (canvas/src/keys.ts CTRL table)', () => {
    expect(isQuitChord(key())).toBe(true);
  });

  it('ignores key up, other keys, and Ctrl-] with Alt or Meta (AltGr on Windows is Ctrl+Alt)', () => {
    expect(isQuitChord(key({ type: 'keyUp' }))).toBe(false);
    expect(isQuitChord(key({ key: '[' }))).toBe(false);
    expect(isQuitChord(key({ control: false }))).toBe(false);
    expect(isQuitChord(key({ alt: true }))).toBe(false);
    expect(isQuitChord(key({ meta: true }))).toBe(false);
  });
});

/**
 * Ctrl-] used to be a `globalShortcut`, which is SYSTEM-WIDE: Ctrl-] typed in any other app
 * (telnet's escape key, in a terminal) quit TN3270. It is app-scoped now, per window.
 */
describe('main.ts quits on Ctrl-] only from its own windows', () => {
  const main = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

  it('registers no global shortcut, and does not import the module', () => {
    expect(main).not.toMatch(/globalShortcut\.register/);
    const imports = main.match(/import \{([^}]*)\} from 'electron'/)?.[1] ?? '';
    expect(imports).not.toMatch(/\bglobalShortcut\b/);
    expect(imports).toMatch(/\bBrowserWindow\b/); // the import list really was found
  });

  it('hooks before-input-event on every window it creates, through isQuitChord', () => {
    expect(main).toMatch(/app\.on\('browser-window-created'[\s\S]{0,400}before-input-event[\s\S]{0,300}isQuitChord\(/);
  });

  it('reads argv through userArgv with process.defaultApp, not a fixed slice', () => {
    expect(main).toMatch(/userArgv\(process\.argv, process\.defaultApp\)/);
    expect(main).not.toMatch(/process\.argv\.slice\(2\)/);
  });
});
