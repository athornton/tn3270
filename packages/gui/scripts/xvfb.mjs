/**
 * Xvfb startup, the GL-less Electron environment this box needs, and the Electron binary.
 *
 * Shared by every GUI and browser harness so the copies cannot drift -- and because the traps
 * below each cost a run to find and would be re-learned independently otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Newest mtime among files under `dir` (recursive) whose name ends with one of `suffixes`. */
function newest(dir, ...suffixes) {
  return Math.max(...readdirSync(dir, { recursive: true })
    .filter((f) => suffixes.some((s) => f.endsWith(s)))
    .map((f) => statSync(join(dir, f)).mtimeMs));
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
 * how to fix it -- `undefined` when it is fresh.
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
 */
export function staleness(main, pkgs) {
  if (main === join(gui, 'app', 'main.js')) {
    if (!existsSync(main)) return { why: `there is no ${main} to run`, fix: REBUNDLE };
    const marker = join(gui, 'app', 'BUNDLED');
    if (!existsSync(marker)) {
      return {
        why: `there is no ${marker}, so packages/gui/app is an incomplete bundle`,
        fix: REBUNDLE,
      };
    }
    const bundledAt = statSync(marker).mtimeMs;
    for (const pkg of BUNDLE_PACKAGES) {
      const src = join(gui, '..', pkg, 'src');
      if (newest(src, '.ts', '.cts') > bundledAt) {
        return {
          why: `packages/${pkg}/src is NEWER than app/BUNDLED, so this run would test a stale bundle`,
          fix: REBUNDLE,
        };
      }
    }
    for (const f of BUNDLE_GUI_FILES) {
      if (statSync(join(gui, f)).mtimeMs > bundledAt) {
        return {
          why: `packages/gui/${f} is NEWER than app/BUNDLED, so this run would test a stale bundle`,
          fix: REBUNDLE,
        };
      }
    }
    return undefined;
  }

  if (!existsSync(main)) return { why: `there is no ${main} to run`, fix: REBUILD };
  for (const pkg of pkgs) {
    const root = join(gui, '..', pkg);
    if (!existsSync(join(root, 'dist'))) {
      return { why: `there is no packages/${pkg}/dist, so there is nothing built to run`, fix: REBUILD };
    }
    if (newest(join(root, 'dist'), '.js', '.cjs') < newest(join(root, 'src'), '.ts', '.cts')) {
      return {
        why: `packages/${pkg}/dist is OLDER than packages/${pkg}/src, so this run would test stale code`,
        fix: `${REBUILD}  (if that reports everything up to date, only a timestamp moved: ` +
          `npx tsc --build --force packages/${pkg})`,
      };
    }
  }
  return undefined;
}
