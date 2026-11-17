import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isQuitChord, quitOnChord } from '../src/quitChord.js';

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

/** The listener main.ts attaches to every window's `before-input-event`, driven with a fake event. */
describe('quitOnChord', () => {
  const drive = (input: Parameters<typeof isQuitChord>[0]) => {
    let quits = 0; let prevented = 0;
    quitOnChord(() => { quits++; })({ preventDefault: () => { prevented++; } }, input);
    return { quits, prevented };
  };

  it('quits once on Ctrl-] and keeps the key from the page, so the renderer does not act on it too', () => {
    expect(drive(key())).toEqual({ quits: 1, prevented: 1 });
  });

  it('leaves every other key alone: no quit, and the page still gets it', () => {
    for (const k of [key({ key: 'a' }), key({ type: 'keyUp' }), key({ alt: true }), key({ control: false })]) {
      expect(drive(k)).toEqual({ quits: 0, prevented: 0 });
    }
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

  it('hooks the before-input-event of every created window with quitOnChord(app.quit)', () => {
    expect(main).toMatch(/app\.on\('browser-window-created', \(_e, created\) => \{\s*created\.webContents\.on\('before-input-event', quitOnChord\(\(\) => \{ app\.quit\(\); \}\)\);/);
  });

  it('reads argv through userArgv with process.defaultApp, not a fixed slice', () => {
    expect(main).toMatch(/userArgv\(process\.argv, process\.defaultApp\)/);
    expect(main).not.toMatch(/process\.argv\.slice\(2\)/);
  });
});
