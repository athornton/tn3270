#!/usr/bin/env node
/**
 * Smoke test of the PACKAGED native app (`npm run package:gui` -> `artifacts/gui/`) on the OS it
 * runs on. Each route launches the artifact the way a user would get it, and each route gets the
 * same two checks:
 *
 *   1. it replays `synthetic-ispf-like.trace` with shot.mjs case 1's argv and draws the
 *      synthetic-ispf golden (see "THE GOLDEN IS LINUX'S" below);
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
 * the `shot:` line is looked for anywhere, not at a line start -- see `drawsGolden`); and the .deb, unpacked with `dpkg-deb -x` into a fresh directory and
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
 *     FAIL, `x64 slice NOT tested: no Rosetta on this runner` -- never a silent skip -- UNLESS
 *     `TN3270_PACKAGE_SMOKE_X64=native` says an Intel job witnesses the x64 slice natively, and
 *     then it is a SKIP line that says so.
 *   - Intel: the x86_64 slice, natively. The arm64 slice cannot run here; the arm64 job is its
 *     witness. `TN3270_PACKAGE_SMOKE_X64=native` is how that Intel job declares it is the x64
 *     witness (it changes nothing here but the label; it is the arm64 job it lets off Rosetta).
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
 * ## THE GOLDEN IS LINUX'S
 *
 * `synthetic-ispf.sha256` was recorded on Linux under Xvfb at scale factor 1, and the hash is of
 * the raw bitmap. On Linux the hash must match exactly. Elsewhere a HiDPI display, a scale
 * factor or a different font stack could change it, and nobody has measured whether it does; so
 * there, on a differing hash, the check prints the measured size and hash and passes only when
 * the capture is the golden PNG's size (from its IHDR) AND is not one flat colour (decoded here:
 * more than one distinct pixel value) -- `ok (size match; golden hash is Linux-only: <hash>)`.
 * That is weaker than the hash, and says so in its own ok line.
 *
 * ## EVERY LAUNCH IS BOUNDED AND KILLED BY PID
 *
 * 120 s per launch. POSIX: each launch leads its own process group and the group is SIGKILLed;
 * Windows: `taskkill /T /F /PID`. Then the check asserts no survivor: the process group is empty
 * (POSIX; on Linux also every descendant recorded from /proc before the kill), or no process runs
 * from the install directory (Windows, by ExecutablePath). Never by name -- `pkill -f electron`
 * kills other people's sessions on a shared box.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  CheckFailed, descendants, displayEnv, fail, gone, groupEmpty, killTree, launch, said, sleep,
  startServer, until,
} from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACTS = join(root, 'artifacts', 'gui');
const TRACE = join(root, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');
/** shot.mjs case 1's golden; read at check time, never copied here. */
const GOLDEN = join(root, 'packages', 'gui', 'test', 'golden', 'synthetic-ispf.sha256');
const GOLDEN_PNG = join(root, 'packages', 'gui', 'test', 'golden', 'synthetic-ispf.png');
const VERSION = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const PLATFORM = process.platform;
const linux = PLATFORM === 'linux';
const win = PLATFORM === 'win32';
const CI = process.env.CI === 'true';
const LAUNCH_MS = 120_000;

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
// The checks

/** Every seam this smoke does not use, cleared: an inherited one would replay, type or photograph. */
const NO_SEAMS = {
  TN3270_GUI_REPLAY: '', TN3270_GUI_SHOT: '', TN3270_GUI_KEYS: '', TN3270_GUI_CLICKS: '',
  TN3270_GUI_SELECT: '', TN3270_GUI_TRANSFER: '', TN3270_GUI_URL: '', TN3270_GUI_CONNECT: '',
};

/** The Chromium switches every launch gets; `ELECTRON_SWITCHES` in main.ts strips them. */
const SWITCHES = ['--disable-gpu', ...(linux ? ['--no-sandbox'] : [])];

/** Starts the route's app with `args` and `extraEnv`; see `launch` in smoke-lib.mjs. */
async function start(r, args, extraEnv, cwd) {
  const env = await displayEnv({ ...process.env, ...r.env, ...NO_SEAMS, ...extraEnv });
  delete env.TN3270_GUI_MAIN;
  // windowsHide OFF (unmeasured caution): it puts SW_HIDE in STARTUPINFO, which Windows applies
  // to a process's first ShowWindow -- possibly the very window being captured.
  return launch(r.exe, [...r.prefix, ...args], env, { group: true, spawnOptions: { cwd, windowsHide: false } });
}

/** Windows: PIDs of every process whose executable lives under `dir` (PowerShell CIM). */
function winProcessesUnder(dir) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.status !== 0) return [`(powershell failed: ${r.error?.message ?? r.stderr})`];
  return r.stdout.split(/\s+/).filter((s) => s !== '');
}

/**
 * Kills the launch's whole tree and returns whatever survived (empty: nothing did). The tree is
 * recorded BEFORE the kill on Linux, because a reparented orphan is no longer anyone's
 * descendant afterwards.
 */
async function stop(r, p) {
  const pid = p.child.pid;
  if (pid === undefined) return [];
  const tree = linux ? [pid, ...descendants(pid)] : [pid];
  killTree(p.child);
  await Promise.race([p.closed, sleep(10_000)]);
  if (win) {
    let left = [];
    await until(() => (left = winProcessesUnder(r.installDir)).length === 0, 10_000);
    return left;
  }
  for (const q of tree) { try { process.kill(q, 'SIGKILL'); } catch { /* gone */ } }
  await until(() => groupEmpty(pid) && tree.every(gone), 10_000);
  return [...(groupEmpty(pid) ? [] : [`process group ${pid}`]), ...tree.filter((q) => !gone(q))];
}

/** Waits for the launch to exit by itself, up to `ms`; true when it did. */
const exitedWithin = (p, ms) => Promise.race([p.closed.then(() => true), sleep(ms).then(() => false)]);

/** `{ width, height, distinct }` of a PNG: its IHDR size and how many distinct pixels it decodes to. */
function pngFacts(path) {
  const b = readFileSync(path);
  if (b.readUInt32BE(12) !== 0x49484452) fail(`${path} is not a PNG (no IHDR)`);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const depth = b[24];
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[b[25]];
  if (depth !== 8 || bpp === undefined || b[28] !== 0) {
    fail(`${path}: PNG bit depth ${depth}, colour type ${b[25]}, interlace ${b[28]} -- this decoder only reads 8-bit non-interlaced, non-palette`);
  }
  const idat = [];
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o);
    if (b.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  const seen = new Set();
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (f === 1) add = a;
      else if (f === 2) add = up;
      else if (f === 3) add = (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) fail(`${path}: PNG row ${y} has filter type ${f}`);
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < stride && seen.size < 2; x += bpp) seen.add(line.toString('hex', x, x + bpp));
    prev = line;
  }
  return { width, height, distinct: seen.size };
}

/** Check 1: shot.mjs case 1's argv and env, and the synthetic-ispf golden. */
async function drawsGolden(r, work) {
  if (!existsSync(TRACE)) fail(`the input trace ${TRACE} is missing from the repository`);
  if (!existsSync(GOLDEN)) fail(`the golden ${GOLDEN} is missing from the repository`);
  const want = readFileSync(GOLDEN, 'utf8').trim();
  // A fresh directory each run, so a capture left by an earlier run cannot be what passes.
  const dir = mkdtempSync(join(work, 'shot-'));
  const shot = join(dir, 'shot.png');
  const p = await start(r, [...SWITCHES, '-insecure', '-model', '3278-2-E', '127.0.0.1:1'],
    { TN3270_GUI_REPLAY: TRACE, TN3270_GUI_SHOT: shot, TN3270_GUI_SHOT_MS: '2500' }, dir);
  p.child.stdin.end();
  const exited = await exitedWithin(p, LAUNCH_MS);
  const survivors = await stop(r, p);
  const { code, signal } = await p.closed;
  const res = { code, signal, stdout: p.stdout, stderr: `${p.stderr}${p.error?.message ?? ''}`, timedOut: !exited };
  if (survivors.length > 0) fail(`survived the kill: ${survivors.join(' ')}`);
  // NOT anchored at the start of a line. MEASURED 2026-11-06: the AppImage runtime prints each
  // extracted file's name to a buffered stdout and the tail of that buffer lands in the middle of
  // the app's own output -- `/tmp/ebsmshot: /tmp/.../shot.png 720x350`. The path is this run's
  // fresh mkdtemp, so finding it anywhere, followed by `WxH` at the end of the line, is still
  // this run's capture and nothing else.
  const escaped = shot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const size = new RegExp(`shot: ${escaped} (\\d+)x(\\d+)\\r?$`, 'm').exec(res.stdout);
  if (code !== 0 || size === null) {
    fail(`expected exit 0 and "shot: ${shot} WxH" on stdout; got ${said(res)}`);
  }
  // A renderer exception draws a blank window and still captures it (see shot.mjs).
  const thrown = res.stdout.split(/\r?\n/).filter((l) => l.startsWith('renderer[3]'));
  if (thrown.length > 0) fail(`the renderer threw: ${thrown.join(' | ')}`);
  if (!existsSync(`${shot}.sha256`)) fail(`no ${shot}.sha256 was written; got ${said(res)}`);
  const got = readFileSync(`${shot}.sha256`, 'utf8').trim();
  if (got === want) return '';
  const wxh = `${size[1]}x${size[2]}`;
  if (linux) fail(`pixels differ from the synthetic-ispf golden: got ${got}, want ${want} (${wxh}, capture ${shot})`);
  // See "THE GOLDEN IS LINUX'S".
  const g = pngFacts(GOLDEN_PNG);
  const m = pngFacts(shot);
  process.stdout.write(`  measured ${m.width}x${m.height} hash ${got}; golden ${g.width}x${g.height} hash ${want}\n`);
  if (m.width !== g.width || m.height !== g.height) {
    fail(`hash differs and so does the size: ${m.width}x${m.height}, golden ${g.width}x${g.height} (capture ${shot})`);
  }
  if (m.distinct < 2) fail(`the ${m.width}x${m.height} capture is one flat colour: nothing was drawn (capture ${shot})`);
  return ` (size match; golden hash is Linux-only: ${got})`;
}

/** Check 2: no host, so the Connect dialog; its submit must reach a plaintext telnet server. */
async function dialogConnects(r, work) {
  const srv = await startServer();
  const dir = mkdtempSync(join(work, 'connect-'));
  const p = await start(r, SWITCHES, {
    TN3270_GUI_CONNECT: JSON.stringify({ host: `127.0.0.1:${srv.port}`, model: '3278-2-E', tls: false }),
    // Linux: a fresh config directory, so nothing a desktop session saved changes the run.
    ...(linux ? { XDG_CONFIG_HOME: join(dir, 'config') } : {}),
  }, dir);
  p.child.stdin.end();
  let survivors = [];
  let checks;
  try {
    // From launch to submit: cold start, and on the AppImage its extraction too.
    await until(() => p.stdout.includes('connect: submitted') || p.exited, LAUNCH_MS);
    // ~10 s from the SUBMIT for the handshake reply.
    await until(() => srv.willTtype(), 10_000);
    checks = [
      ['connect: dialog shown', p.stdout.includes('connect: dialog shown')],
      ['connect: submitted', p.stdout.includes('connect: submitted')],
      ['IAC WILL TERMINAL-TYPE within 10 s of the submit', srv.willTtype()],
    ];
  } finally {
    survivors = await stop(r, p);
    await srv.close();
  }
  if (survivors.length > 0) checks.push([`no survivors (left: ${survivors.join(' ')})`, false]);
  const missing = checks.filter(([, ok]) => !ok).map(([what]) => what);
  if (missing.length > 0) {
    const { code, signal } = await p.closed;
    fail(`missing: ${missing.join('; ')}; server saw ${srv.seen.connections} connection(s), bytes ${srv.seen.bytes.toString('hex').slice(0, 40) || '(none)'}; `
      + said({ code, signal, stdout: p.stdout.split('\n').filter((l) => l.startsWith('connect')).join('\n'), stderr: p.stderr, timedOut: !p.exited && !p.stdout.includes('connect: submitted') }));
  }
  return '';
}

const CHECKS = [
  ['replays a trace and draws the synthetic-ispf golden', drawsGolden],
  ['with no host, opens the Connect dialog and connects', dialogConnects],
];

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
            const note = await fn(r, rwork);
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
    else rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    process.exitCode = failed > 0 || passed === 0 ? 1 : 0;
  }
}

await main();
