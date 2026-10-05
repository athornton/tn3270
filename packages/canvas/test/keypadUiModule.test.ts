import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `keypadUi.js` is loaded DIRECTLY BY TWO BROWSERS, so its own graph must stay clean.
 *
 * ## THE THREE-PACKAGE BOUNDARY THIS SITS ON
 *
 * Both front ends' import maps resolve `@tn3270/canvas` to this ONE MODULE -- the Electron keypad
 * window's `keypad.html` and the web gateway's page -- rather than to `canvas/dist/index.js`. The
 * barrel reaches `drawlist.js`, which value-imports `@tn3270/core`, and a bare specifier in a
 * browser is unresolvable with no bundler: the window comes up BLANK WITH NO ERROR in any
 * console, a shape this repo has met five separate ways.
 *
 * So the graph is walked in three places, one per package, because no single test can see across
 * a package boundary by relative path:
 *
 *  - `gui/test/keypadModule.test.ts`      -- `keypadBoot.js` reaches only mapped specifiers
 *  - THIS FILE                            -- `keypadUi.js` reaches only `@tn3270/frontend`
 *  - `frontend/test/keypadModule.test.ts` -- `keypadView.js` closes at two import-free leaves
 *
 * A gap in any one of them is a blank window, which is why each names its neighbours.
 *
 * ## IT READS THE BUILT JAVASCRIPT
 *
 * `import type` erases at compile time, so the SOURCE shows imports a browser never fetches and
 * hides none that it does. Only `dist/` answers the question a browser asks.
 */
const canvasDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(canvasDir, 'dist');

/** Every specifier in a built module, static and dynamic. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [
    ...[...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
  ];
}

describe('the keypad DOM view, as a browser loads it', () => {
  it('was built (run npm run build first)', () => {
    expect(existsSync(join(distDir, 'keypadUi.js')), 'missing dist/keypadUi.js').toBe(true);
  });

  it('imports NOTHING but `@tn3270/frontend`, which both import maps resolve', () => {
    /**
     * EXACT EQUALITY AND NOT A SUBSET CHECK. A second workspace import would need a second map
     * entry in BOTH documents, and the failure mode of forgetting one is the whole blank-window
     * family -- so a new import is a decision that has to be made twice, deliberately, rather
     * than something this test waves through.
     *
     * In particular it must never reach `./drawlist.js`, `./keypad.js` or anything else in this
     * package: those are Node-side modules that value-import `@tn3270/core`.
     */
    expect(importsOf(join(distDir, 'keypadUi.js'))).toEqual(['@tn3270/frontend']);
  });

  it('is NOT reachable from anything that imports `@tn3270/core`', () => {
    // The inverse direction, and the one a reader would not think to check: it would be equally
    // fatal for some OTHER browser-loaded module in this package to import `keypadUi.js` while
    // itself importing core. `renderer.js` is the module both browsers load alongside this one,
    // so it is named explicitly.
    const renderer = join(distDir, 'renderer.js');
    if (!existsSync(renderer)) return;          // a renderer-less build is checked elsewhere
    const specs = importsOf(renderer);
    expect(specs.filter((s) => s.startsWith('@tn3270/')),
      'renderer.js must stay free of workspace imports').toEqual([]);
  });
});
