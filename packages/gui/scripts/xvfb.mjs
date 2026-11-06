/**
 * Xvfb startup, the GL-less Electron environment this box needs, and the Electron binary.
 *
 * Shared by every GUI and browser harness so the copies cannot drift -- and because the traps
 * below each cost a run to find and would be re-learned independently otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distStaleness, newest } from './freshness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** The userspace GUI stack: static micromamba env, no root, no system X. */
const GUI_ENV = join(process.env.HOME ?? '', 'micromamba', 'envs', 'gui');

const SOCKET = '/tmp/.X11-unix/X99';

/**
 * THE REAL ELECTRON BINARY, NEVER `node_modules/.bin/electron`.
 *
 * That `.bin` entry is `electron/cli.js`, a Node wrapper that spawns this binary and forwards
 * only SIGINT, SIGTERM and SIGUSR2. A harness's SIGKILL therefore killed the wrapper and
 * orphaned Electron to PID 1, six processes a time: `browser-clicks.mjs` leaked six on EVERY
 * run. 60 of them, some ~10 hours old, exhausted the box until pages failed with
 * `net::ERR_INSUFFICIENT_RESOURCES`, which read as a product bug. MEASURED: a SIGKILL to this
 * binary's main process takes its zygote, GPU, network and renderer children with it.
 *
 * `require('electron')` returns this path in Node, so it follows the package, not a guess.
 */
export const electron = createRequire(import.meta.url)('electron');

/** Start Xvfb if there is no display, and PROVE it came up before trusting DISPLAY. */
export function ensureDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  if (!existsSync(SOCKET)) {
    // Detached, because a backgrounded child dies with the shell that started it -- and the
    // symptom is Electron reporting "Missing X server" WITH DISPLAY set, which reads as
    // misconfiguration rather than as a dead server. Cost two runs to spot.
    //
    // Tested by SOCKET and never by `pgrep -f "Xvfb :99"`, which matches the shell command
    // containing the pattern and so reports a server that was never started.
    spawn(join(GUI_ENV, 'bin', 'Xvfb'), [':99', '-screen', '0', '1280x1024x24'],
      { detached: true, stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: join(GUI_ENV, 'lib') } })
      .unref();
    // Forks a process per poll (up to ~75 over the deadline) because node has no synchronous
    // sleep; a fork every 0.2s is the price of not returning before Xvfb is actually up.
    const deadline = Date.now() + 15000;
    while (!existsSync(SOCKET) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
  }
  if (!existsSync(SOCKET)) throw new Error(`Xvfb did not create ${SOCKET}`);
  return ':99';
}

/**
 * The environment every Electron run here needs, plus whatever the caller adds. On a cold box
 * this starts a detached Xvfb :99 as a side effect, not just constructs a value -- and two
 * harnesses calling this at the same cold-start instant can both see no socket and both spawn
 * an Xvfb on :99, colliding on the display number. Harnesses run sequentially today, so this
 * hasn't been hit; if that stops being true, the fix is a lockfile around ensureDisplay().
 */
export function guiEnv(extra = {}) {
  return {
    ...process.env,
    DISPLAY: ensureDisplay(),
    LD_LIBRARY_PATH: join(GUI_ENV, 'lib'),
    FONTCONFIG_PATH: join(GUI_ENV, 'etc', 'fonts'),
    FONTCONFIG_FILE: join(GUI_ENV, 'etc', 'fonts', 'fonts.conf'),
    ...extra,
  };
}

/** `packages/gui` itself, the directory every path below is relative to. */
const gui = join(here, '..');

/**
 * `TN3270_GUI_MAIN` resolved to a word, treating an unset OR EMPTY variable as `'dist'`.
 *
 * EMPTY MEANS ABSENT, the same convention `main.ts`'s own `SEAM` block uses throughout
 * (`TN3270_GUI_SHOT=` behaves as not set) -- so a harness invoked with the variable exported but
 * blank, which is how a shell leaves it after `export TN3270_GUI_MAIN=; unset -v` style cleanup,
 * still tests `dist` rather than tripping the "must be dist or app" throw below.
 */
function which() {
  const raw = process.env['TN3270_GUI_MAIN'] ?? '';
  return raw === '' ? 'dist' : raw;
}

/**
 * The GUI entry point a harness launches: the unbundled dist/main.js by default, the esbuild
 * bundle with TN3270_GUI_MAIN=app. Anything else is refused by name -- a typo silently testing
 * dist would report the bundle as proven.
 */
export function guiMain() {
  const w = which();
  if (w === 'dist') return join(here, '..', 'dist', 'main.js');
  if (w === 'app') return join(here, '..', 'app', 'main.js');
  throw new Error(`TN3270_GUI_MAIN must be dist or app, not ${JSON.stringify(w)}`);
}

/** `"app (/path/to/app/main.js)"` -- what a harness prints so its own log names what it tested. */
export function guiMainLabel() {
  return `${which()} (${guiMain()})`;
}

/**
 * EVERY PACKAGE AND FILE `app/`'s BUNDLE DEPENDS ON, so the app-mode staleness check below can
 * refuse a bundle that predates ANY of them -- not just the dist/ packages a given harness
 * happens to exercise. `scripts/bundle.mjs` inlines core, frontend, canvas and node-files into
 * `app/main.js` and copies gui's own documents and `ui.css` flat; a stale bundle over any of
 * those seven things is stale over something every harness would otherwise trust silently.
 */
const BUNDLE_PACKAGES = ['core', 'frontend', 'canvas', 'node-files', 'gui'];
const BUNDLE_GUI_FILES = ['index.html', 'keypad.html', 'keyboard.html', 'transfer.html', 'ui.css'];

const REBUILD = 'run: npm run build';
const REBUNDLE = 'run: npm run build && npm run bundle:gui';

/**
 * Whether `main` (whatever `guiMain()` returned) is fresh enough to run, and if not, why and
 * how to fix it -- `undefined` when it is fresh. `packagesRoot` defaults to the real
 * `packages/` and exists as a parameter only so `xvfbStaleness.test.ts` can point this at a
 * temp directory and assert BEHAVIOUR against mtimes it set itself, rather than against
 * whatever this tree's own `dist`/`app` happen to be when the suite runs.
 *
 * SHARED, rather than one copy per harness, because `keys.mjs`, `clicks.mjs` and `transfer.mjs`
 * each carried their own `newest`-plus-per-package-loop and the three had already begun to
 * drift (different package lists, same bug class waiting in each). Centralising it is also what
 * let the `app`-mode half below be written once instead of five times.
 *
 * `pkgs` is the package list to check in DIST mode only -- each harness's own deliberate choice
 * of which packages' staleness it can detect (`clicks.mjs`'s comment explains why `canvas`
 * matters more to it than `gui` does). In APP MODE the check is NOT scoped to `pkgs`: `app/` is
 * one bundle of everything, so every harness run against it must be checked against the SAME
 * full dependency set (`BUNDLE_PACKAGES`/`BUNDLE_GUI_FILES`) regardless of which packages that
 * harness's own dist-mode coverage happens to name.
 *
 * ## THE CHAIN IS src -> dist -> app, AND APP MODE USED TO CHECK ONLY THE LAST HOP
 *
 * REPRODUCED AND FOUND BY REVIEW: edit a `packages/gui/src` file, then run `npm run bundle:gui`
 * WITHOUT `npm run build` first. `BUNDLED`'s mtime is written after the edit, so the
 * src-vs-BUNDLED comparison below sees nothing wrong -- but `bundle.mjs` read its input from
 * `dist/`, which the edit never reached, so `app/` was built from yesterday's compiled code. The
 * harness-side guard passed over exactly the staleness it exists to catch.
 *
 * The fix is BOTH hops, checked separately, because each catches a different ordering mistake:
 *  - `distStaleness()` over `BUNDLE_PACKAGES`: did every package's `dist` get rebuilt from its
 *    OWN current `src`? This is the hop the reviewer's scenario breaks -- `gui/src` edited,
 *    `gui/dist` never rebuilt -- and it is the same question `distStaleness()` already answers
 *    for the plain dist-mode harnesses, asked here of five packages instead of whichever
 *    `pkgs` names.
 *  - `bundledAt` against the newest file in each package's OWN `dist`: did `bundle.mjs` run
 *    AFTER the last rebuild, not before it? A `dist` that is individually fresh against its own
 *    `src` can still predate `BUNDLED` if someone bundled, then rebuilt, then never re-bundled --
 *    `distStaleness()` alone cannot see that, because it never looks at `app/` at all.
 * Either hop failing is stale by itself; both must hold for app/ to be trustworthy.
 */
export function staleness(main, pkgs, packagesRoot = join(gui, '..')) {
  // EVERYTHING BELOW IS DERIVED FROM `packagesRoot`, never from the module-level `gui`
  // constant, so a test can point `packagesRoot` at a temp tree and have the app-mode branch
  // (including WHICH `main` counts as "app mode") follow it there. `packagesRoot` defaults to
  // the real `packages/`, under which this resolves to the same `gui/app/main.js` the real
  // `guiMain()` returns.
  const guiRoot = join(packagesRoot, 'gui');
  if (main === join(guiRoot, 'app', 'main.js')) {
    if (!existsSync(main)) return { why: `there is no ${main} to run`, fix: REBUNDLE };
    const marker = join(guiRoot, 'app', 'BUNDLED');
    if (!existsSync(marker)) {
      return {
        why: `there is no ${marker}, so packages/gui/app is an incomplete bundle`,
        fix: REBUNDLE,
      };
    }

    // HOP 1 of 2: src -> dist, for every package the bundle inlines or copies from, not just
    // whichever `pkgs` this harness's own dist-mode coverage names.
    const distProblem = distStaleness(packagesRoot, BUNDLE_PACKAGES);
    if (distProblem !== undefined) {
      return { why: distProblem.why, fix: `${REBUNDLE}${distProblem.forceHint}` };
    }

    // HOP 2 of 2: dist -> app. `BUNDLED` is written LAST, after `bundle.mjs`'s own self-check
    // passes, so its mtime is "when the bundle was actually produced" -- compared against each
    // package's OWN newest dist file, not `app/main.js`, which a PARTIAL bundle could still have
    // touched before failing.
    const bundledAt = statSync(marker).mtimeMs;
    for (const pkg of BUNDLE_PACKAGES) {
      const pkgDist = join(packagesRoot, pkg, 'dist');
      if (newest(pkgDist, '.js', '.cjs') > bundledAt) {
        return {
          why: `packages/${pkg}/dist is NEWER than app/BUNDLED, so this run would test a stale bundle`,
          fix: REBUNDLE,
        };
      }
    }
    for (const f of BUNDLE_GUI_FILES) {
      if (statSync(join(guiRoot, f)).mtimeMs > bundledAt) {
        return {
          why: `packages/gui/${f} is NEWER than app/BUNDLED, so this run would test a stale bundle`,
          fix: REBUNDLE,
        };
      }
    }
    return undefined;
  }

  if (!existsSync(main)) return { why: `there is no ${main} to run`, fix: REBUILD };
  const problem = distStaleness(packagesRoot, pkgs);
  if (problem === undefined) return undefined;
  return { why: problem.why, fix: `${REBUILD}${problem.forceHint}` };
}
