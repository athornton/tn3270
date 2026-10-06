import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `transferUi.js` is loaded DIRECTLY BY A BROWSER, so its own graph must stay clean.
 *
 * ## WHY THIS EXISTS, AND WHY IT DID NOT BEFORE 2026-10-06
 *
 * This module lived in `packages/gui` until that day, where `gui/test/transferModule.test.ts`
 * covered the FAR side of its one import -- that `frontend/dist/transferForm.js` closes at an
 * import-free leaf -- and nothing walked `transferUi.js` itself. Moving it here made it a
 * browser-loaded module of THIS package, which is exactly the position `keypadUi.js` is in, and
 * `keypadUiModule.test.ts` beside this file is the precedent this follows.
 *
 * Its header states the invariant in capitals: *"IT IMPORTS ONLY `@tn3270/frontend`, and must
 * keep doing so."* A capitalised comment is not a test. This is the test.
 *
 * ## THE FAILURE IT GUARDS IS A BLANK WINDOW WITH NO ERROR
 *
 * `gui/transfer.html`'s import map resolves `@tn3270/frontend` to `transferForm.js` and
 * `@tn3270/canvas/dist/transferUi.js` to this module. A specifier NO map entry names is
 * unresolvable in a browser with no bundler, and the window comes up blank with nothing in any
 * console -- a shape this repo has met several separate ways, including once in the very commit
 * that moved this file, when the map's key did not match the deep specifier the import emits.
 *
 * So a second workspace import here is a decision that must be made in the map too, and the map
 * has no automated guard of its own. Exact equality below is what forces that to be deliberate.
 *
 * ## IT READS THE BUILT JAVASCRIPT
 *
 * `import type` erases at compile time, so the SOURCE shows imports a browser never fetches and
 * hides none that it does. Only `dist/` answers the question a browser asks.
 *
 * THAT CUTS THE OTHER WAY TOO, and `tsc --build` never prunes: a `dist/` file can outlive a
 * deleted source and keep a test like this one green against a module that no longer exists.
 * `npm run build` before believing a pass here, which the first case asserts as best it can.
 */
const canvasDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(canvasDir, 'dist');

/** Every specifier in a built module, static and dynamic. Same shape as the keypad's. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [
    ...[...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
  ];
}

describe('the transfer form DOM view, as a browser loads it', () => {
  it('was built (run npm run build first)', () => {
    expect(existsSync(join(distDir, 'transferUi.js')), 'missing dist/transferUi.js').toBe(true);
  });

  it('imports NOTHING but the DEEP `transferForm.js` path, which both import maps resolve', () => {
    /**
     * EXACT EQUALITY AND NOT A SUBSET CHECK, for the reason `keypadUiModule.test.ts` gives: a new
     * workspace import needs a new map entry, and forgetting it is the blank-window family.
     *
     * In particular it must never reach `./drawlist.js`, `./cg.js` or anything else in this
     * package: those are Node-side modules that value-import `@tn3270/core`, whose graph a
     * browser cannot resolve.
     *
     * ## WHY THE DEEP PATH, CHANGED 2026-10-06 FROM THE BARE `@tn3270/frontend`
     *
     * The web gateway became this module's second consumer, and `packages/web/static/index.html`
     * had ALREADY bound the bare `@tn3270/frontend` to `keypadView.js` for the keypad overlay.
     * An import-map key without a trailing `/` matches EXACTLY, so one specifier cannot name two
     * files: a bare import here would have resolved to `keypadView.js`, which does not export
     * `TRANSFER_FIELDS`. Blank page, no error -- the failure this case exists to force a decision
     * about, and it did exactly that.
     *
     * So the expected value is the deep path, and BOTH maps now spell it verbatim as a key
     * (`gui/transfer.html` was updated in the same change, since its bare key stopped matching
     * the moment this specifier grew a subpath). `packages/frontend/package.json`'s `exports` map
     * declares the subpath too, which is what lets `tsc` and Node resolve the same string --
     * without it, `TS2307` and `ERR_PACKAGE_PATH_NOT_EXPORTED` (both measured that day).
     */
    expect(importsOf(join(distDir, 'transferUi.js')))
      .toEqual(['@tn3270/frontend/dist/transferForm.js']);
  });

  it('reaches no `node:` builtin, directly or through the one import it has', () => {
    // The concrete thing the barrel ban is about: `frontend`'s own barrel reaches `tls.js` and its
    // `node:net`/`node:tls`/`node:fs`. This module must name the MODULE, never the package root,
    // and the map must point at a module that does the same. Asserted here as a property rather
    // than inferred from the specifier's spelling.
    const specs = importsOf(join(distDir, 'transferUi.js'));
    expect(specs.filter((s) => s.startsWith('node:'))).toEqual([]);
  });
});
