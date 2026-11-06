import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards `xvfb.mjs`'s `staleness()`, the staleness check shared by `shot.mjs`, `keys.mjs`,
 * `clicks.mjs`, `select.mjs` and `transfer.mjs` since the bundle-parity task. Each harness used
 * to carry its own copy of the dist-mode half (`keys.mjs` found `dist/keys.js` a day older than
 * `src/keys.ts` in this very tree, which is why that half exists at all), and the per-harness
 * `*-harness-flags.test.ts` files used to pin their own copy's text. They now pin only that their
 * harness CALLS `staleness()` with the right package list; this file pins the shared mechanics
 * those calls rely on, so the behaviour is not left unguarded by the move.
 *
 * TEXT, not a behavioral test against real timestamps: `staleness()` reads the real
 * `packages/*\/src` and `packages/gui/{dist,app}` trees, which this repo's own build/bundle state
 * makes a moving target -- a behavioral test would be flaky depending on whether `dist/` or
 * `app/` happen to be fresh when the suite runs. `xvfbMain.test.ts` covers `guiMain()` itself
 * behaviorally because that one only touches an env var, no filesystem timestamps.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const xvfb = readFileSync(join(guiDir, 'scripts', 'xvfb.mjs'), 'utf8');
/** The measured history of WHY `staleness()`'s dist-mode half is shaped as it is still lives in
 *  `keys.mjs`'s doc comment, unmoved -- it is the harness that found the original bug, and the
 *  reasoning belongs beside the code it explains. `keys-harness-flags.test.ts` does not re-pin
 *  it now that the CODE moved to `xvfb.mjs`, so it is pinned here instead. */
const keys = readFileSync(join(guiDir, 'scripts', 'keys.mjs'), 'utf8');

describe('xvfb.mjs staleness()', () => {
  it('compares newest dist output against newest src, per package, in dist mode', () => {
    // `.cts`/`.cjs` on the source/output side is load-bearing: `'preload.cts'.endsWith('.ts')`
    // is FALSE, which once exempted the preload -- an IPC hop every harness depends on -- from
    // the check entirely. That was a false GREEN.
    expect(xvfb).toMatch(
      /newest\(join\(root, 'dist'\),\s*'\.js',\s*'\.cjs'\)\s*<\s*newest\(join\(root, 'src'\),\s*'\.ts',\s*'\.cts'\)/,
    );
    // PER PACKAGE, not one max across all of them passed in: a fresh `gui` build would otherwise
    // mask a stale `canvas` one in `for (const pkg of pkgs)`.
    expect(xvfb).toMatch(/for \(const pkg of pkgs\)/);
  });

  it('recorded why tsc --build --dry is not an oracle, so nobody "simplifies" into it', () => {
    // MEASURED: it reported "up to date" with an output file deleted, because --build trusts its
    // .tsbuildinfo rather than looking at the outputs on disk. The comment recording this stayed
    // in `keys.mjs` -- the harness that found the original bug -- when the CODE moved to
    // `xvfb.mjs`'s `staleness()`.
    expect(keys).toContain('is not an oracle');
  });

  it('names the whole-workspace build as the dist-mode remedy, never a scoped workspace build', () => {
    // MEASURED: a scoped `-w @tn3270/gui` build exits 0, compiles `canvas` through the project
    // reference and never runs canvas's second build step, so atlas.json is missing and the
    // client dies at startup. A refusal that names its own fix is worthless if the fix is the
    // cause.
    expect(xvfb).toContain("const REBUILD = 'run: npm run build'");
  });

  it('checks app/BUNDLED exists before trusting its mtime', () => {
    // An incomplete bundle (the marker missing) must be refused by name, not read as "infinitely
    // stale" or, worse, let a missing-marker crash into a confusing stack trace.
    expect(xvfb).toMatch(/if \(!existsSync\(marker\)\)/);
  });

  it('refuses an app/ bundle older than ANY dependency it was built from, not just gui', () => {
    // `scripts/bundle.mjs` inlines core, frontend, canvas and node-files into app/main.js and
    // copies gui's own documents and ui.css flat -- so a harness whose own dist-mode coverage
    // names only `['gui', 'canvas']` must still have its app-mode run checked against ALL of
    // them, or a stale `frontend` or `node-files` bundle would pass under TN3270_GUI_MAIN=app
    // while every dist-mode harness correctly refused it.
    expect(xvfb).toMatch(
      /BUNDLE_PACKAGES = \[('core',\s*'frontend',\s*'canvas',\s*'node-files',\s*'gui'|[^\]]*'core'[^\]]*'frontend'[^\]]*'canvas'[^\]]*'node-files'[^\]]*'gui'[^\]]*)\]/,
    );
    // The HTML/CSS half of the bundle too -- a stale index.html or ui.css is not caught by any
    // package's src/ check at all.
    expect(xvfb).toMatch(/BUNDLE_GUI_FILES = \[[^\]]*'index\.html'[^\]]*\]/);
    expect(xvfb).toMatch(/BUNDLE_GUI_FILES = \[[^\]]*'ui\.css'[^\]]*\]/);
    // Compared against the MARKER's own mtime, written last by bundle.mjs after its self-check --
    // not against app/main.js, which a partial bundle could still have touched.
    expect(xvfb).toMatch(/newest\(src, '\.ts', '\.cts'\)\s*>\s*bundledAt/);
    expect(xvfb).toMatch(/statSync\(join\(gui, f\)\)\.mtimeMs\s*>\s*bundledAt/);
  });

  it('names npm run bundle:gui in every app-mode remedy, not just npm run build', () => {
    // A refusal under TN3270_GUI_MAIN=app whose fix forgot the bundle step would send someone
    // back to a dist/ that was already fresh, fixing nothing.
    expect(xvfb).toContain("const REBUNDLE = 'run: npm run build && npm run bundle:gui'");
  });
});
