import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleness } from '../scripts/xvfb.mjs';
import { BUNDLE_GUI_FILES, BUNDLE_PACKAGES, bundleStaleness } from '../scripts/bundleVerify.mjs';

/**
 * Guards `xvfb.mjs`'s `staleness()` BEHAVIOURALLY, against a temp `packages/` tree with mtimes
 * this file sets itself -- not against this repo's own `dist`/`app`, which this suite's own
 * build state makes a moving target.
 *
 * ## WHY BEHAVIOURAL, WHERE THE FIRST VERSION OF THIS FILE WAS TEXT
 *
 * The first version of this file read `xvfb.mjs` as TEXT and pinned regexes against its source
 * -- `/newest\(join\(root, 'dist'\).../` and the like. REVIEW FOUND A REAL GAP those regexes could
 * not see: in app mode, `staleness()` compared `app/BUNDLED`'s mtime against each package's `src`
 * only, never against that package's `dist`. REPRODUCED: edit a file under `packages/gui/src`, run
 * `npm run bundle:gui` WITHOUT `npm run build` first -- `BUNDLED`'s mtime is written after the
 * edit, so the src-vs-BUNDLED comparison saw nothing wrong, but `bundle.mjs` had read its input
 * from a `dist/` the edit never reached, so `app/` was quietly built from yesterday's compiled
 * code. A text pin on the comparison that existed would have stayed green through that whole
 * scenario, because the code it was pinning was the wrong half of the chain. `staleness()` now
 * takes `packagesRoot` as a parameter (default: the real `packages/`) precisely so this file can
 * drive it against a tree it controls and ask it the actual question: given these exact mtimes,
 * does it refuse or not.
 *
 * ## WHAT STAYS TEXT
 *
 * The `*-harness-flags.test.ts` files still pin, as text, that each harness calls `staleness(main,
 * [the right package list])` -- that is a WIRING fact (does this harness ask for the right
 * packages at all), not a behavioural one, and reading five Electron processes under Xvfb just to
 * observe which `pkgs` array reached a function call would be the wrong tool for it.
 */
const root = () => mkdtempSync(join(tmpdir(), 'staleness-'));


/** One package: a `src/*.ts` and a `dist/*.js`, with the given mtimes. `pkg === 'gui'` writes
 *  `dist/main.js`, matching the real layout (`guiMain()` resolves to exactly that path); every
 *  other package's dist filename is arbitrary, since nothing names it specifically. */
function makePackage(pkgRoot: string, pkg: string, srcAt: number, distAt: number): string {
  const srcDir = join(pkgRoot, pkg, 'src');
  const distDir = join(pkgRoot, pkg, 'dist');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  const srcFile = join(srcDir, 'index.ts');
  const distFile = join(distDir, pkg === 'gui' ? 'main.js' : 'index.js');
  writeFileSync(srcFile, '// src');
  writeFileSync(distFile, '// dist');
  utimesSync(srcFile, srcAt, srcAt);
  utimesSync(distFile, distAt, distAt);
  return distFile;
}

/** `packages/gui`'s own HTML/CSS files that `BUNDLE_GUI_FILES` checks, all set to one mtime. */
function makeGuiFiles(pkgRoot: string, at: number): void {
  for (const f of BUNDLE_GUI_FILES) {
    const p = join(pkgRoot, 'gui', f);
    writeFileSync(p, '');
    utimesSync(p, at, at);
  }
}

/** `app/main.js` and, unless `omitMarker`, `app/BUNDLED`, each at the given mtime. */
function makeApp(
  pkgRoot: string,
  { mainAt, markerAt, omitMarker = false }: { mainAt: number; markerAt: number; omitMarker?: boolean },
): string {
  const appDir = join(pkgRoot, 'gui', 'app');
  mkdirSync(appDir, { recursive: true });
  const mainFile = join(appDir, 'main.js');
  writeFileSync(mainFile, '');
  utimesSync(mainFile, mainAt, mainAt);
  if (!omitMarker) {
    const marker = join(appDir, 'BUNDLED');
    writeFileSync(marker, '');
    utimesSync(marker, markerAt, markerAt);
  }
  return mainFile;
}

describe('staleness() -- dist mode', () => {
  let tmp: string | undefined;
  afterEach(() => { if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true }); });

  it('refuses when src is newer than dist', () => {
    tmp = root();
    const main = makePackage(tmp, 'gui', 2000, 1000); // src at 2000, dist at 1000: dist is older
    const problem = staleness(main, ['gui'], tmp);
    expect(problem).not.toBeUndefined();
    expect(problem?.why).toContain('packages/gui/dist is OLDER than packages/gui/src');
    expect(problem?.fix).toContain('npm run build');
  });

  it('passes when dist is at least as new as src, across every named package', () => {
    tmp = root();
    const main = makePackage(tmp, 'gui', 1000, 2000); // dist newer than src: fresh
    makePackage(tmp, 'canvas', 1000, 2000);
    expect(staleness(main, ['gui', 'canvas'], tmp)).toBeUndefined();
  });

  it('refuses when main.js itself does not exist', () => {
    tmp = root();
    const missing = join(tmp, 'gui', 'dist', 'main.js');
    expect(staleness(missing, ['gui'], tmp)?.why).toContain(`there is no ${missing} to run`);
  });
});

describe('staleness() -- app mode', () => {
  let tmp: string | undefined;
  afterEach(() => { if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true }); });

  it('refuses when app/BUNDLED is missing', () => {
    tmp = root();
    const main = makeApp(tmp, { mainAt: 1000, markerAt: 1000, omitMarker: true });
    const problem = staleness(main, ['gui'], tmp);
    expect(problem?.why).toContain('incomplete bundle');
  });

  it("refuses when a bundled package's src is newer than its OWN dist (hop 1: src -> dist)", () => {
    // THE EXACT GAP REVIEW FOUND: edit gui/src, bundle without rebuilding. BUNDLED is written
    // AFTER the edit, so a check that compared only src-vs-BUNDLED would see nothing wrong --
    // this is hop 1, which compares src against the package's OWN dist instead, and must fire
    // regardless of what BUNDLED's mtime says.
    tmp = root();
    for (const pkg of BUNDLE_PACKAGES) {
      if (pkg === 'gui') continue;
      makePackage(tmp, pkg, 1000, 2000); // every other package fresh
    }
    makePackage(tmp, 'gui', 4000, 3000); // gui: src edited AFTER its own dist was built
    const main = makeApp(tmp, { mainAt: 2000, markerAt: 5000 }); // BUNDLED written well after
    const problem = staleness(main, ['gui'], tmp);
    expect(problem?.why).toContain('packages/gui/dist is OLDER than packages/gui/src');
    expect(problem?.fix).toContain('npm run build && npm run bundle:gui');
  });

  it('refuses when a bundled package\'s dist is newer than app/BUNDLED (hop 2: dist -> app)', () => {
    // Every package individually fresh (src -> dist holds for each), but the BUNDLE was taken
    // before the last rebuild: `dist` moved on, `app/` did not follow. `distStaleness()` alone
    // cannot see this, because it never looks at `app/` at all -- hop 2 is what does.
    tmp = root();
    for (const pkg of BUNDLE_PACKAGES) {
      if (pkg === 'gui') continue;
      makePackage(tmp, pkg, 1000, 2000);
    }
    makePackage(tmp, 'gui', 1000, 4000); // gui rebuilt AFTER the bundle below was taken
    makeGuiFiles(tmp, 1000);
    const main = makeApp(tmp, { mainAt: 2000, markerAt: 3000 }); // BUNDLED older than gui's dist
    const problem = staleness(main, ['gui'], tmp);
    expect(problem?.why).toContain('packages/gui/dist is NEWER than app/BUNDLED');
    expect(problem?.fix).toContain('npm run build && npm run bundle:gui');
  });

  it('refuses when a gui HTML/CSS file is newer than app/BUNDLED', () => {
    tmp = root();
    for (const pkg of BUNDLE_PACKAGES) makePackage(tmp, pkg, 1000, 2000);
    makeGuiFiles(tmp, 5000); // index.html etc. edited after the bundle
    const main = makeApp(tmp, { mainAt: 2000, markerAt: 3000 });
    const problem = staleness(main, ['gui'], tmp);
    expect(problem?.why).toMatch(/packages\/gui\/.*\.(html|css) is NEWER than app\/BUNDLED/);
  });

  it('refuses when connect.html alone is newer than app/BUNDLED', () => {
    // A retyped file list in xvfb.mjs never grew when the Connect dialog added connect.html
    // (2026-11-06), so editing that page left the bundle "fresh". The list now derives from
    // bundleVerify's DOCUMENTS; this pins that the newest document is in it.
    tmp = root();
    for (const pkg of BUNDLE_PACKAGES) makePackage(tmp, pkg, 1000, 2000);
    makeGuiFiles(tmp, 1000);
    const main = makeApp(tmp, { mainAt: 3000, markerAt: 3000 });
    const page = join(tmp, 'gui', 'connect.html');
    utimesSync(page, 5000, 5000);
    expect(staleness(main, ['gui'], tmp)?.why).toContain('packages/gui/connect.html is NEWER than app/BUNDLED');
  });

  it('bundleStaleness (what pack.mjs calls) refuses a bundle older than a dist, and passes an ordered tree', () => {
    tmp = root();
    for (const pkg of BUNDLE_PACKAGES) makePackage(tmp, pkg, 1000, 2000);
    makeGuiFiles(tmp, 1000);
    makeApp(tmp, { mainAt: 3000, markerAt: 3000 });
    expect(bundleStaleness(tmp)).toBeUndefined();
    makePackage(tmp, 'gui', 1000, 4000); // rebuilt after bundling, never re-bundled
    expect(bundleStaleness(tmp)?.why).toContain('packages/gui/dist is NEWER than app/BUNDLED');
  });

  it('passes when every hop is correctly ordered: src -> dist -> BUNDLED', () => {
    tmp = root();
    for (const pkg of BUNDLE_PACKAGES) makePackage(tmp, pkg, 1000, 2000);
    makeGuiFiles(tmp, 1000);
    const main = makeApp(tmp, { mainAt: 2000, markerAt: 3000 });
    expect(staleness(main, ['gui'], tmp)).toBeUndefined();
  });
});
