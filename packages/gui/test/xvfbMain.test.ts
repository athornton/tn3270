import { describe, it, expect, afterEach } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiMain, guiMainLabel } from '../scripts/xvfb.mjs';

const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * `guiMain()`'s word-to-path mapping, which decides whether a harness tests the unbundled
 * `dist/main.js` or the esbuild bundle in `app/main.js`.
 *
 * Importing `xvfb.mjs` here is safe to do without Xvfb or a display: `ensureDisplay()` is a
 * function and is never called at module load, and the `createRequire('electron')` at the top of
 * that file only resolves the package's own path -- it does not start Electron. Nothing in this
 * file calls `guiEnv()` or `ensureDisplay()`, so no Xvfb is spawned by running it.
 */
describe('guiMain', () => {
  const ORIGINAL = process.env['TN3270_GUI_MAIN'];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env['TN3270_GUI_MAIN'];
    else process.env['TN3270_GUI_MAIN'] = ORIGINAL;
  });

  it('defaults to dist/main.js when unset', () => {
    delete process.env['TN3270_GUI_MAIN'];
    expect(guiMain()).toBe(join(guiDir, 'dist', 'main.js'));
  });

  it('treats an empty string as unset, the SEAM convention main.ts uses throughout', () => {
    // `main.ts`'s own `SEAM` block: "EMPTY STRING MEANS ABSENT throughout". A harness invoked
    // with the variable exported but blank must still test dist, not trip the bogus-value throw.
    process.env['TN3270_GUI_MAIN'] = '';
    expect(guiMain()).toBe(join(guiDir, 'dist', 'main.js'));
  });

  it('switches to the bundle on app', () => {
    process.env['TN3270_GUI_MAIN'] = 'app';
    expect(guiMain()).toBe(join(guiDir, 'app', 'main.js'));
  });

  it('refuses anything else by name, rather than silently falling back to dist', () => {
    // A typo here must be LOUD: silently testing dist would let a bundling defect report the
    // bundle as proven.
    process.env['TN3270_GUI_MAIN'] = 'bogus';
    expect(() => guiMain()).toThrow(/TN3270_GUI_MAIN must be dist or app, not "bogus"/);
  });

  it('labels the entry with the word AND the resolved path, so a log names what ran', () => {
    process.env['TN3270_GUI_MAIN'] = 'app';
    expect(guiMainLabel()).toBe(`app (${join(guiDir, 'app', 'main.js')})`);
  });
});
