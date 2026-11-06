#!/usr/bin/env node
/**
 * Installs the packed tarballs into a FRESH temporary prefix and runs every executable BY NAME
 * through PATH -- never by file path -- so npm's symlinks (POSIX) and .cmd shims (Windows) are
 * what is tested. Each check must SEE its executable run; none passes because a file exists.
 *
 *   node scripts/pack.mjs && node scripts/install-smoke.mjs [--only cli,tui,web] [--keep]
 *
 * `--keep` leaves the temporary prefix behind and prints where, for debugging.
 *
 * ## THE INSTALL MECHANISM, AND WHY NO LOCAL REGISTRY -- MEASURED 2026-11-06, npm 11.20, Node 26
 *
 * `npm install -g --prefix <tmp> artifacts/npm/*.tgz` WORKS, with nothing published. npm asks the
 * registry for each internal `@tn3270/*` dependency, gets a 404 (logged at `--loglevel http`, NOT
 * an error), and satisfies it from the co-installed tarball of the same exact version. A project
 * install (`npm install <tgz...>` in an `npm init -y` directory) works the same way. So the
 * plan's fallback, a throwaway verdaccio registry, is not needed, and the GLOBAL install -- the
 * path a user takes -- is what this tests. Bins land in `<prefix>/bin` on POSIX and in `<prefix>`
 * itself on Windows. With the registry unreachable rather than 404ing, the install still
 * succeeded but took 74 s of retries instead of 9 s.
 *
 * ## ELECTRON's BINARY IS NOT DOWNLOADED UNLESS THE gui CHECK IS SELECTED
 *
 * `@tn3270/gui` depends on `electron`, whose download of a ~100 MB binary would make a
 * cli/tui/web run slow and network-bound for nothing. When no selected check needs it, the gui
 * tarball is left out of the install entirely (nothing else depends on it); and
 * `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is set besides, unless a selected check says it needs the
 * binary. A check is data (`CHECKS` below), so the gui check (packaging Task 8) is one entry with
 * `needsElectron: true`.
 *
 * ## DEVIATION FROM THE SPEC: THE CLI USES `Replay`, NOT A FAKE HOST
 *
 * The spec's "against an in-process fake host" is replaced by `Replay(<trace>)`, which drives the
 * installed core, frontend and cli end to end without a socket. The trace is read from this
 * repository, outside the install, which is fine: it is input, not code under test.
 *
 * ## WINDOWS
 *
 * A `.cmd` shim can only be run by a shell, so every spawn there goes through `shell: true` with
 * the command line built by `commandLine()` below; PATH is joined with `path.delimiter`, and the
 * PATH variable is looked up case-insensitively because Windows calls it `Path`. A process started
 * through a shell is the SHELL's PID, so it is killed with `taskkill /T /F`, which takes node with
 * it. None of this has run on Windows yet; CI is where it will.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackages, tarballName } from './pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = join(root, 'artifacts', 'npm');
const win = process.platform === 'win32';
const TRACE = join(root, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

// ---------------------------------------------------------------------------------------------
// Process helpers

/** `cmd /c`-safe quoting for one argument. Only what these checks pass ever needs it. */
function quoteWin(a) {
  return /^[A-Za-z0-9_\-.:/\\=,]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`;
}

/** What `spawn` gets: on Windows a single shell command line, elsewhere the program and argv. */
function commandLine(cmd, args) {
  return win ? [[cmd, ...args].map(quoteWin).join(' '), [], { shell: true }] : [cmd, args, {}];
}

/** The environment with `binDir` first on PATH, whatever the variable's case. */
function envWithPath(binDir, extra = {}) {
  const env = { ...process.env, ...extra };
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = [binDir, env[key] ?? ''].join(delimiter);
  return env;
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/**
 * Runs `cmd` by NAME with `env`, feeding `input`; resolves `{ code, signal, stdout, stderr }`.
 * Killed after `timeoutMs`, and then `timedOut` is set: a hung bin fails its check, never the run.
 */
function run(cmd, args, env, { input = '', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const [c, a, opts] = commandLine(cmd, args);
    const child = spawn(c, a, { ...opts, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, signal: null, stdout, stderr: `${stderr}${err.message}`, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
    child.stdin.on('error', () => {}); // a bin that exits before reading stdin is its check's business
    child.stdin.end(input);
  });
}

class CheckFailed extends Error {}
const fail = (why) => { throw new CheckFailed(why); };

/** `result` summarised for a failure message, so a FAIL line says what actually came back. */
function said(r) {
  const clip = (s) => JSON.stringify(s.length > 300 ? `${s.slice(0, 300)}...` : s);
  return `exit ${r.code}${r.signal ? ` signal ${r.signal}` : ''}${r.timedOut ? ' (TIMED OUT)' : ''}, `
    + `stdout ${clip(r.stdout)}, stderr ${clip(r.stderr)}`;
}

async function usageError(bin, env) {
  const r = await run(bin, ['--bogus'], env, { timeoutMs: 20_000 });
  if (r.code !== 2 || !r.stderr.includes('unrecognized argument')) {
    fail(`expected exit 2 and "unrecognized argument" on stderr; got ${said(r)}`);
  }
}

/** True once `pid` no longer exists. `process.kill(pid, 0)` throws ESRCH for a dead process. */
function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/**
 * Starts `tn3270-web`, waits for its `serving ... at http://.../` line, fetches every path, and
 * kills it -- by PID, and then PROVES the PID is gone, so a gateway that outlives the run fails.
 */
async function webServes(env) {
  const [c, a, opts] = commandLine('tn3270-web', ['--listen', '0', '-insecure', '127.0.0.1:1']);
  const child = spawn(c, a, { ...opts, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('close', resolve));
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CheckFailed(
        `no "serving ... at http://.../" line within 15 s; stdout ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}`)), 15_000);
      child.stdout.on('data', (d) => {
        stdout += d;
        const m = /^serving \S+ at (http:\/\/\S+\/)\s*$/m.exec(stdout);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      child.on('error', (err) => { clearTimeout(timer); reject(new CheckFailed(`could not start: ${err.message}`)); });
      child.on('close', (code) => { clearTimeout(timer); reject(new CheckFailed(
        `exited ${code} before serving; stdout ${JSON.stringify(stdout)}, stderr ${JSON.stringify(stderr)}`)); });
    });
    // The page, the shared stylesheet, and one module from each source the static table draws
    // on: web's own dist (bridge.js), canvas's BROWSER_MODULES (renderer.js), and frontend's dist
    // found through Node's resolver (keypadView.js, transferForm.js, keymap.js). Names checked
    // against `packages/web/src/httpstatic.ts` on 2026-11-06.
    const want = [
      ['/', 'text/html'], ['/ui.css', 'text/css'],
      ['/renderer.js', 'text/javascript'], ['/bridge.js', 'text/javascript'],
      ['/keypadView.js', 'text/javascript'], ['/transferForm.js', 'text/javascript'],
      ['/keymap.js', 'text/javascript'],
    ];
    const problems = [];
    for (const [path, type] of want) {
      try {
        const res = await fetch(new URL(path, url), { signal: AbortSignal.timeout(10_000) });
        const body = await res.text();
        const ct = res.headers.get('content-type') ?? '';
        if (res.status !== 200) problems.push(`${path} -> ${res.status}`);
        else if (!ct.startsWith(type)) problems.push(`${path} -> content-type ${ct}`);
        else if (body.length === 0) problems.push(`${path} -> empty body`);
        else if (path === '/' && !/<html/i.test(body)) problems.push('/ -> not HTML');
      } catch (e) {
        // A missing file is a 200 header followed by a read error that resets the connection.
        problems.push(`${path} -> ${e.cause?.code ?? e.message}`);
      }
    }
    if (problems.length > 0) fail(`${problems.join('; ')} (served at ${url}; stderr ${JSON.stringify(stderr)})`);
  } finally {
    killTree(child);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  }
  if (!gone(child.pid)) fail(`killed PID ${child.pid}, but it is still running`);
}

// ---------------------------------------------------------------------------------------------
// The checks. DATA: `group` is what `--only` selects; Task 8 adds the gui entry here.

const CHECKS = [
  { group: 'cli', name: 'tn3270-cli --bogus is a usage error', fn: (env) => usageError('tn3270-cli', env) },
  {
    group: 'cli', name: 'tn3270-cli replays a trace and prints its screen',
    fn: async (env) => {
      if (!existsSync(TRACE)) fail(`the input trace ${TRACE} is missing from the repository`);
      // The path is QUOTED: `Replay` splits its arguments on spaces and commas, and a checkout
      // under `C:\Users\Some Name` would otherwise arrive as two arguments.
      const quoted = `"${TRACE.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const r = await run('tn3270-cli', [], env, { input: `Replay(${quoted})\nAscii()\nQuit()\n` });
      if (r.code !== 0 || !r.stdout.includes('data:  MENU') || !r.stdout.includes('OPTION ===>')) {
        fail(`expected exit 0 and "data:  MENU" and "OPTION ===>" on stdout; got ${said(r)}`);
      }
    },
  },
  { group: 'tui', name: 'tn3270 --bogus is a usage error', fn: (env) => usageError('tn3270', env) },
  { group: 'web', name: 'tn3270-web serves its page, stylesheet and modules', fn: webServes },
];
const GROUPS = ['cli', 'tui', 'web', 'gui'];
const IMPLEMENTED = [...new Set(CHECKS.map((c) => c.group))];

// ---------------------------------------------------------------------------------------------

function usage(message) {
  process.stderr.write(`install-smoke: ${message}\n`
    + 'usage: node scripts/install-smoke.mjs [--only cli,tui,web] [--keep]\n');
  process.exit(2);
}

function parseArgs(argv) {
  let only = IMPLEMENTED;
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') keep = true;
    else if (a === '--only') {
      const v = argv[++i];
      if (v === undefined || v === '') usage('--only needs a comma-separated list');
      only = v.split(',');
      for (const g of only) {
        if (!GROUPS.includes(g)) usage(`unknown group ${JSON.stringify(g)}; groups are ${GROUPS.join(', ')}`);
        if (!IMPLEMENTED.includes(g)) usage(`the ${g} check is not implemented yet (packaging Task 8)`);
      }
    } else usage(`unrecognized argument ${JSON.stringify(a)}`);
  }
  return { only, keep };
}

async function main() {
  const { only, keep } = parseArgs(process.argv.slice(2));
  const checks = CHECKS.filter((c) => only.includes(c.group));
  const needsElectron = checks.some((c) => c.needsElectron === true);
  const pkgs = publishedPackages();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

  // EVERY tarball must be this version's: pack.mjs deletes artifacts/npm first, so a stale one
  // means pack was not run, and installing it would test some other build.
  const tarballs = [];
  for (const { m } of pkgs) {
    if (m.name === '@tn3270/gui' && !only.includes('gui')) continue;
    const t = join(artifacts, tarballName(m));
    if (!existsSync(t)) usage(`${t} is missing: run node scripts/pack.mjs first`);
    tarballs.push(t);
  }

  const prefix = mkdtempSync(join(tmpdir(), 'tn3270-smoke-'));
  const binDir = win ? prefix : join(prefix, 'bin');
  let failed = 0;
  try {
    process.stdout.write(`installing ${tarballs.length} tarballs into ${prefix}\n`);
    const installEnv = { ...process.env, ...(needsElectron ? {} : { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }) };
    const [c, a, opts] = commandLine('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', ...tarballs]);
    const inst = spawnSync(c, a, { ...opts, env: installEnv, encoding: 'utf8', timeout: 600_000, windowsHide: true });
    if (inst.error !== undefined || inst.status !== 0) {
      process.stderr.write(`install-smoke: npm install failed (${inst.error?.message ?? `exit ${inst.status}`}):\n${inst.stderr}\n`);
      failed = checks.length;
      return;
    }

    // WHICH BUILD THIS TESTED: the installed cli's own manifest, which must be the repo's version.
    const libDir = win ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules');
    const installed = JSON.parse(readFileSync(join(libDir, '@tn3270', 'cli', 'package.json'), 'utf8')).version;
    process.stdout.write(`installed @tn3270/cli ${installed} (repo ${version})\n`);
    if (installed !== version) {
      process.stderr.write(`install-smoke: installed version ${installed} is not the repo's ${version}\n`);
      failed = checks.length;
      return;
    }

    // ONLY the prefix's bin directory is added: the rest of PATH is the caller's, so `node` (which
    // the shims and shebangs need) is found the same way a user's shell would find it.
    const env = envWithPath(binDir);
    for (const check of checks) {
      try {
        await check.fn(env);
        process.stdout.write(`ok ${check.name}\n`);
      } catch (e) {
        failed += 1;
        process.stdout.write(`FAIL ${check.name}: ${e instanceof CheckFailed ? e.message : e?.stack ?? e}\n`);
      }
    }
  } finally {
    process.stdout.write(`${checks.length - failed}/${checks.length}\n`);
    if (keep) process.stdout.write(`kept ${prefix}\n`);
    else rmSync(prefix, { recursive: true, force: true, maxRetries: 5 });
    process.exitCode = failed > 0 ? 1 : 0;
  }
}

await main();
