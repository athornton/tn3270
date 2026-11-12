#!/usr/bin/env node
/**
 * Smoke test of the PACKAGED native app (`npm run package:gui` -> `artifacts/gui/`) on the OS it
 * runs on. Each route launches the artifact the way a user would get it, and each route gets the
 * same two checks:
 *
 *   1. it replays `synthetic-ispf-like.trace` with shot.mjs case 1's argv and draws the
 *      synthetic-ispf golden (see "THE GOLDEN, ON EVERY OS" below);
 *   2. launched with NO host -- the double-click route -- it opens the Connect dialog, and the
 *      dialog's submit reaches a throwaway telnet server in plaintext (`IAC WILL TERMINAL-TYPE`
 *      comes back to the server's `IAC DO TERMINAL-TYPE`).
 *
 *     node scripts/package-smoke.mjs [--keep]
 *
 * `--keep` leaves the temporary directory (extractions, installs, captures) and prints where.
 *
 * ## THE ROUTES
 *
 * Linux: the AppImage, run with `APPIMAGE_EXTRACT_AND_RUN=1` (no FUSE needed; the runtime then
 * prints the extracted file names on a buffered stdout that interleaves with the app's own, so
 * the `shot:` line is looked for anywhere, not at a line start -- see `drawsGolden` in package-checks.mjs); and the .deb, unpacked with `dpkg-deb -x` into a fresh directory and
 * run from `opt/TN3270/tn3270-gui` (electron-builder.cjs `linux.executableName`). No dpkg-deb is
 * a SKIP on a dev box but a FAIL under `CI=true`: GitHub's ubuntu runners have it. Every Linux
 * launch adds `--no-sandbox`: Ubuntu 23.10+ blocks the unprivileged user namespaces Chromium's
 * sandbox needs, and an unpacked .deb has no setuid `chrome-sandbox` (same as the harnesses).
 *
 * macOS (NOT YET RUN -- CI is where it will): the universal .zip, unpacked with `ditto -x -k`
 * (what Finder's Archive Utility does; it keeps the bundle's symlinks and modes, which `unzip`
 * has been known to mangle), run as `TN3270.app/Contents/MacOS/TN3270` (productName). First
 * `lipo -archs` must list both `x86_64` and `arm64`. Then each slice is a route:
 *   - Apple silicon: the arm64 slice as `arch -arm64 <exe>`, and the x86_64 slice as
 *     `arch -x86_64 <exe>` under Rosetta. No Rosetta (`arch -x86_64 /usr/bin/true` fails) is a
 *     FAIL, `x64 slice NOT tested: no Rosetta on this runner` -- never a silent skip.
 *   - Intel: the x86_64 slice, natively. The arm64 slice cannot run here; the arm64 job is its
 *     witness.
 *   `TN3270_PACKAGE_SMOKE_X64=native`: set it on the arm64 macOS job ONLY when the matrix also has
 *   an Intel macOS job running this script natively. Then the arm64 job skips its Rosetta route
 *   (a printed SKIP line, not counted), and the Intel job is the x64 witness. On an Intel runner
 *   it changes nothing but the route's label; leave it unset there.
 * `arch` execs the binary in place, so the spawned PID is the app's own. QUARANTINE: an unsigned
 * app downloaded from the internet carries `com.apple.quarantine` and Gatekeeper refuses it; one
 * built (or downloaded as a workflow artifact by `gh`/actions) on the runner does not, so no
 * `xattr` work is done here. A user's download is a different story, for the README.
 *
 * Windows (NOT YET RUN): the NSIS installer, run silently as `<installer> /S /D=<fresh dir>`.
 * NSIS requires `/D=` to be LAST and UNQUOTED even when the path has spaces (NSIS manual 3.2,
 * "Installer usage"; electron-builder's multiUser.nsh `GetDParameter` reads everything after
 * `/D=` to the end of the command line). Node would quote an argument with spaces, so the
 * command line is passed verbatim (`windowsVerbatimArguments`), the program name quoted by hand.
 * `oneClick: false` with no `perMachine` is a per-user install: no elevation, so the installer
 * process does the work itself and its exit is the end of the install. Silent and not
 * `--force-run`, it does not launch the app (installSection.nsh). The installed executable is
 * `TN3270.exe` (`win` has no `executableName`, so productName); the install directory is listed
 * and the check FAILs naming what IS there if that is not it. Afterwards `Uninstall TN3270.exe /S`
 * (common.nsh `UNINSTALL_FILENAME`), best effort.
 *
 * Every launch on every OS gets a fresh `--user-data-dir`, and every launch is bounded and killed
 * by PID; THE GOLDEN, ON EVERY OS and the kill rules are in package-checks.mjs, which holds the
 * two checks and their launch plumbing (moved there so store-probe.mjs runs the same checks).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckFailed, fail } from './smoke-lib.mjs';
import { CHECKS } from './package-checks.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = join(root, 'artifacts', 'gui');
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const PLATFORM = process.platform;
const linux = PLATFORM === 'linux';
const win = PLATFORM === 'win32';
const CI = process.env.CI === 'true';

const argv = process.argv.slice(2);
for (const a of argv) {
  if (a !== '--keep') {
    process.stderr.write(`package-smoke: unrecognized argument ${JSON.stringify(a)}\nusage: node scripts/package-smoke.mjs [--keep]\n`);
    process.exit(2);
  }
}
const keep = argv.includes('--keep');

// ---------------------------------------------------------------------------------------------
// Artifacts

/**
 * `artifacts/gui/<name>` for this version, or a FAIL naming what was expected and what IS there.
 * The names come from electron-builder.cjs `artifactName` `${productName}-${version}-${os}-${arch}
 * .${ext}`, with app-builder-lib's per-format arch names (builder-util `getArtifactArchName`:
 * x64 is `x86_64` for an AppImage, `amd64` for a .deb, `x64` otherwise). Only THIS version's file
 * is taken: another version's leftover would test some other build.
 */
function artifact(name) {
  const path = join(ARTIFACTS, name);
  if (existsSync(path)) return path;
  const ext = name.slice(name.lastIndexOf('.'));
  const others = existsSync(ARTIFACTS) ? readdirSync(ARTIFACTS).filter((f) => f.endsWith(ext)) : [];
  fail(`${path} is missing (version ${VERSION} from package.json); `
    + (others.length > 0 ? `${ARTIFACTS} has only ${others.join(', ')}` : `no *${ext} in ${ARTIFACTS}`)
    + ': run npm run build && npm run package:gui');
}

const linuxArch = (ext) => {
  if (process.arch === 'x64') return ext === 'deb' ? 'amd64' : 'x86_64';
  if (process.arch === 'arm64') return 'arm64';
  return fail(`no Linux artifact is built for ${process.arch}`);
};

// ---------------------------------------------------------------------------------------------
// The routes: each `prepare(work)` returns the route's launch, or FAILs/SKIPs; `cleanup` after.

class Skip extends Error {}

function has(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 30_000 });
  return r.error === undefined && r.status === 0;
}

function must(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (r.error !== undefined || r.status !== 0) {
    fail(`${what} failed: ${cmd} ${args.join(' ')}: ${r.error?.message ?? `exit ${r.status}`} ${r.stderr ?? ''}`.trim());
  }
  return r.stdout;
}

function linuxRoutes() {
  return [
    {
      name: 'linux AppImage',
      prepare(work) {
        const exe = artifact(`TN3270-${VERSION}-linux-${linuxArch('AppImage')}.AppImage`);
        // TMPDIR: the runtime extracts under it, so the extraction goes with the work directory.
        const tmp = join(work, 'tmp');
        mkdirSync(tmp);
        return { exe, prefix: [], env: { APPIMAGE_EXTRACT_AND_RUN: '1', TMPDIR: tmp } };
      },
    },
    {
      name: 'linux deb',
      prepare(work) {
        const deb = artifact(`TN3270-${VERSION}-linux-${linuxArch('deb')}.deb`);
        if (!has('dpkg-deb')) {
          if (CI) fail('dpkg-deb is not on PATH, and under CI=true it must be (the ubuntu runners have it)');
          throw new Skip('dpkg-deb is not on PATH, so the .deb cannot be unpacked here');
        }
        const dir = join(work, 'deb');
        must('dpkg-deb', ['-x', deb, dir], `unpacking ${deb}`);
        const exe = join(dir, 'opt', 'TN3270', 'tn3270-gui');
        if (!existsSync(exe)) fail(`${deb} unpacked without ${exe}`);
        return { exe, prefix: [], env: {} };
      },
    },
  ];
}

function macRoutes() {
  // Hardware, not process.arch: a node running under Rosetta reports x64 on Apple silicon.
  const appleSilicon = spawnSync('sysctl', ['-in', 'hw.optional.arm64'], { encoding: 'utf8' }).stdout?.trim() === '1';
  const x64Native = process.env.TN3270_PACKAGE_SMOKE_X64 === 'native';
  let exe;
  const unpack = (work) => {
    if (exe !== undefined) return exe;
    const zip = artifact(`TN3270-${VERSION}-mac-universal.zip`);
    const dir = join(work, 'zip');
    must('ditto', ['-x', '-k', zip, dir], `unpacking ${zip}`);
    const e = join(dir, 'TN3270.app', 'Contents', 'MacOS', 'TN3270');
    if (!existsSync(e)) fail(`${zip} unpacked without ${e}`);
    const archs = must('lipo', ['-archs', e], 'lipo').trim().split(/\s+/);
    if (!archs.includes('x86_64') || !archs.includes('arm64')) {
      fail(`${e} is not universal: lipo -archs says ${JSON.stringify(archs.join(' '))}, need x86_64 and arm64`);
    }
    process.stdout.write(`lipo -archs ${e}: ${archs.join(' ')}\n`);
    exe = e;
    return exe;
  };
  if (!appleSilicon) {
    return [{
      name: `mac x86_64 slice (native Intel${x64Native ? ', the x64 witness' : ''})`,
      prepare: (work) => ({ exe: unpack(work), prefix: [], env: {} }),
    }];
  }
  return [
    { name: 'mac arm64 slice', prepare: (work) => ({ exe: '/usr/bin/arch', prefix: ['-arm64', unpack(work)], env: {} }) },
    {
      name: 'mac x86_64 slice (Rosetta)',
      prepare(work) {
        if (x64Native) throw new Skip('TN3270_PACKAGE_SMOKE_X64=native: the Intel job tests the x64 slice natively');
        if (!has('/usr/bin/arch', ['-x86_64', '/usr/bin/true'])) fail('x64 slice NOT tested: no Rosetta on this runner');
        return { exe: '/usr/bin/arch', prefix: ['-x86_64', unpack(work)], env: {} };
      },
    },
  ];
}

function windowsRoutes() {
  return [{
    name: 'windows NSIS install',
    prepare(work) {
      const installer = artifact(`TN3270-${VERSION}-win-x64.exe`);
      const dir = join(work, 'install dir'); // a space on purpose: /D= must survive one
      // See "Windows" above: /S, then /D= LAST and unquoted; verbatim, so node adds no quotes.
      const r = spawnSync(installer, ['/S', `/D=${dir}`], {
        argv0: `"${installer}"`, windowsVerbatimArguments: true, timeout: 300_000, windowsHide: true, stdio: 'ignore',
      });
      if (r.error !== undefined || r.status !== 0) fail(`silent install failed: ${r.error?.message ?? `exit ${r.status}`}`);
      if (!existsSync(dir)) fail(`the silent install exited 0 but made no ${dir}`);
      const exes = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.exe'));
      process.stdout.write(`installed into ${dir}: ${exes.join(', ')}\n`);
      const exe = join(dir, 'TN3270.exe');
      if (!existsSync(exe)) fail(`no TN3270.exe in ${dir}; its .exe files are ${exes.join(', ') || '(none)'}`);
      return { exe, prefix: [], env: {}, installDir: dir };
    },
    cleanup(route) {
      if (route?.installDir === undefined) return;
      const un = join(route.installDir, 'Uninstall TN3270.exe');
      if (!existsSync(un)) return;
      // Best effort: the uninstaller copies itself to %TEMP% and returns at once.
      const r = spawnSync(un, ['/S'], { timeout: 120_000, windowsHide: true, stdio: 'ignore' });
      process.stdout.write(`uninstall: ${r.error?.message ?? `exit ${r.status}`}\n`);
    },
  }];
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const routes = linux ? linuxRoutes() : PLATFORM === 'darwin' ? macRoutes() : win ? windowsRoutes() : [];
  if (routes.length === 0) {
    process.stdout.write(`FAIL no packaged app is built for ${PLATFORM}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`package-smoke: TN3270 ${VERSION} on ${PLATFORM}/${process.arch}, artifacts in ${ARTIFACTS}\n`);
  // realpath: a Windows runner's %TEMP% is an 8.3 short path (C:\Users\RUNNER~1\...), and the
  // Windows survivor check compares it with processes' LONG ExecutablePath; macOS's /var is
  // /private/var. Resolved once, so every path below is the one the OS reports.
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'tn3270-pkgsmoke-')));
  let passed = 0, failed = 0, skipped = 0;
  try {
    for (const route of routes) {
      const rwork = mkdtempSync(join(work, 'route-'));
      let r;
      try {
        r = route.prepare(rwork);
      } catch (e) {
        for (const [name] of CHECKS) {
          if (e instanceof Skip) { skipped++; process.stdout.write(`SKIP ${route.name}: ${name}: ${e.message}\n`); }
          else { failed++; process.stdout.write(`FAIL ${route.name}: ${name}: ${e instanceof CheckFailed ? e.message : e?.stack ?? e}\n`); }
        }
        continue;
      }
      try {
        for (const [name, fn] of CHECKS) {
          try {
            const { note } = await fn(r, rwork);
            passed++;
            process.stdout.write(`ok ${route.name}: ${name}${note}\n`);
          } catch (e) {
            failed++;
            process.stdout.write(`FAIL ${route.name}: ${name}: ${e instanceof CheckFailed ? e.message : e?.stack ?? e}\n`);
          }
        }
      } finally {
        route.cleanup?.(r);
      }
    }
  } finally {
    process.stdout.write(`${passed}/${passed + failed}${skipped > 0 ? ` (${skipped} SKIPPED, not counted)` : ''}\n`);
    if (keep) process.stdout.write(`kept ${work}\n`);
    process.exitCode = failed > 0 || passed === 0 ? 1 : 0;
    // Best effort, and AFTER the result is set: on Windows the NSIS uninstaller copies itself to
    // %TEMP% and returns at once, so the install directory can still be busy (EBUSY) here. A
    // passing run must not fail on cleanup, nor a throw from here escape the summary.
    if (!keep) {
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
      } catch (e) {
        process.stdout.write(`note: could not remove ${work}: ${e?.message ?? e}\n`);
      }
    }
  }
}

await main();
