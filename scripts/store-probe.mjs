#!/usr/bin/env node
/**
 * The store probe (store-probe spec, and its Amendment 2026-11-12): the app, confined as each
 * store confines it, must prove the confinement from inside the process and pass package-smoke's
 * two checks (package-checks.mjs). Nothing built here is ever uploaded.
 *
 *     node scripts/store-probe.mjs [artifacts/gui]
 *
 * macOS: `<dir>/mas-universal/TN3270.app` (Electron's MAS build, made by a separate CI step) is
 * copied into scratch, given ElectronTeamID, ad-hoc signed inside out with
 * `packages/gui/resources/entitlements.mas*.plist`, verified, launched once to prove the App
 * Sandbox, then given the two checks with every input staged inside its container. Windows: the
 * one `TN3270-*-win-x64.appx` is copied into scratch, signed with a throwaway self-signed
 * certificate by the newest Windows SDK signtool, installed, launched through its app execution
 * alias to prove package identity, then given the two checks. Both are ports of the spike scripts'
 * proven paths (scripts/spike/mac-sandbox.sh variant D, run 43115293433; scripts/spike/win-appx.ps1,
 * run 43112504521); see the drivers below.
 *
 * Output: `ok <route>: <what>` / `FAIL <route>: <why>`, and `time <phase>: <s>s` for the cost
 * figure. Exit 0: confined and both checks passed. 1: any FAIL (a cleanup failure included). 2: a
 * setup problem -- no artifact, an unsupported platform, no signtool, the alias not on PATH after
 * install, the certificate not made, or a tool that cannot start (runCommand THROWS; a missing
 * tool is never read as a result). Cleanup runs on every path, every step, each failure logged.
 * `STORE_PROBE_ECHO=1` logs every command and its raw output (the pfx password masked).
 *
 * Every judge FAILS CLOSED -- missing or unrecognised evidence is a problem, never "unconfined
 * but fine":
 *   - a missing or malformed `probe:` line is a problem (parseProbeLine -> null);
 *   - `sandbox=none` is a problem on macOS, `windowsStore=false` on Windows;
 *   - a `codesign --verify` that names any subcomponent, or does not say `valid on disk`, is one.
 *
 * Paths are built with the TARGET platform's rules (posix in the mac route, win32 in the Windows
 * one), never the host's: verify-signatures.mjs learnt that from CI run 42844605289.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECKS, LAUNCH_MS, TRACE, probeSeen, start, stop, switches } from './package-checks.mjs';
import { CheckFailed, until } from './smoke-lib.mjs';
import { runCommand } from './verify-signatures.mjs';

export { CheckFailed };

/** The app's bundle id (electron-builder.cjs `appId`), and so its container's name. */
export const BUNDLE_ID = 'io.github.athornton.tn3270';
/** The user's Apple Team ID, in the main entitlements' application-groups and ElectronTeamID. Not a secret. */
export const TEAM_ID = 'H68TN685J4';
/** electron-builder.cjs `appx.identityName` and `appx.publisher`: PLACEHOLDERS until piece 3. */
export const IDENTITY_NAME = 'TN3270.Probe';
export const PUBLISHER = 'CN=TN3270 Store Probe';

/** `<home>/Library/Containers/<bundle id>`, posix whatever the host. */
export const containerPath = (home) => posix.join(home, 'Library', 'Containers', BUNDLE_ID);

/**
 * The LAST `probe:` line of `stdout` (probe.ts prints exactly one), parsed. Null when there is
 * none, and null when it is not exactly `probe: sandbox=<id|none> windowsStore=<true|false>`:
 * a line this cannot read proves nothing, so the judges FAIL it rather than read it as "none".
 */
export function parseProbeLine(stdout) {
  if (typeof stdout !== 'string') return null;
  const ls = stdout.split(/\r?\n/).filter((l) => l.startsWith('probe:'));
  if (ls.length === 0) return null;
  const m = /^probe: sandbox=(\S+) windowsStore=(true|false)$/.exec(ls[ls.length - 1]);
  if (m === null) return null;
  return { sandbox: m[1] === 'none' ? null : m[1], windowsStore: m[2] === 'true' };
}

/** What a missing or unreadable probe line means, for every judge. */
const NO_PROBE = 'no readable "probe: sandbox=... windowsStore=..." line from the app: its confinement is unproven';

/** The signature's `com.apple.security.app-sandbox` is `<true/>` (`codesign -d --entitlements :-`). */
const sandboxEntitled = (text) => /<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\s*\/>/.test(text ?? '');

/**
 * The mac copy is confined iff ALL of: its signature entitles app-sandbox, the container exists
 * after a launch, and the app itself reports `sandbox=<bundleId>` (APP_SANDBOX_CONTAINER_ID). The
 * probe line is the decisive witness, the container the second (spec Amendment, Task 4 override).
 */
export function judgeMacConfinement({ entitlements, containerExists, probe }, bundleId) {
  const p = [];
  if (!sandboxEntitled(entitlements)) p.push('the signature does not entitle com.apple.security.app-sandbox (codesign -d --entitlements)');
  if (containerExists !== true) p.push(`no container ~/Library/Containers/${bundleId} after the launch: the sandbox did not take`);
  return [...p, ...judgeProbeMac(probe, bundleId)];
}

/** One launch's probe line, on macOS: it must name the container `bundleId`. */
export function judgeProbeMac(probe, bundleId) {
  if (probe === null || probe === undefined) return [NO_PROBE];
  if (probe.sandbox === null) return ['the app reports sandbox=none: it is NOT sandboxed'];
  if (probe.sandbox !== bundleId) return [`the app reports sandbox=${probe.sandbox}, not ${bundleId}`];
  return [];
}

/** One launch's probe line, on Windows: it must report package identity. */
export function judgeProbeWin(probe) {
  if (probe === null || probe === undefined) return [NO_PROBE];
  if (probe.windowsStore !== true) return ['the app reports windowsStore=false: it has no package identity'];
  return [];
}

/**
 * `codesign --verify --deep --strict --verbose=2 <app>` (stdout+stderr, exit `rc`) -> problems.
 * Positive, like verify-signatures: it must exit 0 AND say `valid on disk`, and it must name no
 * unsigned part (round 3, run 43114227702: the unsigned login helper showed as
 * `In subcomponent: ...` and `code object is not signed at all`).
 */
export function judgeSignatureVerify(text, rc) {
  const p = [];
  const t = text ?? '';
  if (rc !== 0) p.push(`codesign --verify --deep --strict exited ${rc}`);
  const bad = t.split(/\r?\n/).filter((l) => /In subcomponent|not signed at all|code object is not signed/.test(l));
  for (const l of bad) p.push(`codesign --verify: ${l.trim()}`);
  if (!/: valid on disk\r?$/m.test(t)) p.push(`codesign --verify did not say "valid on disk": ${t.trim().split(/\r?\n/)[0] ?? '(no output)'}`);
  return p;
}

/**
 * `Get-AppxPackage <name> | ConvertTo-Json -Compress` -> the fields the probe uses, or null when
 * it is not ONE package object with them all (two installed packages are an array: null too).
 */
export function parseAppxPackage(text) {
  let o;
  try { o = JSON.parse((text ?? '').trim()); } catch { return null; }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const s = (v) => typeof v === 'string' && v !== '';
  if (!s(o.Name) || !s(o.PackageFamilyName) || !s(o.PackageFullName) || !s(o.InstallLocation)) return null;
  return { name: o.Name, packageFamilyName: o.PackageFamilyName, packageFullName: o.PackageFullName, installLocation: o.InstallLocation };
}

/**
 * The installed MSIX is the confinement iff ALL of: Get-AppxPackage lists it under
 * `identityName`, the app reports `windowsStore=true` (Electron's process.windowsStore), and the
 * process started through the alias has that package's full name (GetPackageFullName, measured
 * from OUTSIDE the app: the spike's route, Task 5 override).
 */
export function judgeWinConfinement({ pkg, probe, started }, identityName) {
  const p = [];
  if (pkg === null || pkg === undefined) p.push(`Get-AppxPackage lists no ${identityName} package (or not one readable package)`);
  else if (pkg.name !== identityName) p.push(`Get-AppxPackage lists ${pkg.name}, not ${identityName}`);
  p.push(...judgeProbeWin(probe));
  if (pkg) {
    if (typeof started !== 'string' || started === '') p.push('the started process\'s package full name was not measured');
    else if (started !== pkg.packageFullName) p.push(`the started process's package is ${started}, not ${pkg.packageFullName}`);
  }
  return p;
}

/**
 * The macOS route: the sandboxed copy's executable, launched from the shell (as the spike did),
 * with every input staged INSIDE the container, where the sandbox lets the app read and write:
 * `<home>/Library/Containers/<id>/Data/probe-<n>/`, a fresh `n` per launch. The repository trace
 * is copied there (spike: `cp "$TRACE" "$D/"`). posix paths whatever the host.
 *
 * `io`: `{ home, fs: { mkdir, copy }, trace? }` (`trace` defaults to package-checks' TRACE).
 */
export function macRoute(io, app) {
  let n = 0;
  const data = posix.join(containerPath(io.home), 'Data');
  return {
    exe: posix.join(app, 'Contents', 'MacOS', 'TN3270'),
    prefix: [],
    env: {},
    probe: true,
    stage: () => {
      const d = posix.join(data, `probe-${++n}`);
      io.fs.mkdir(d);
      const trace = posix.join(d, 'synthetic-ispf-like.trace');
      io.fs.copy(io.trace ?? TRACE, trace);
      return { trace, shot: posix.join(d, 'shot.png'), userData: posix.join(d, 'user-data') };
    },
  };
}

/**
 * The Windows route: the app execution alias `tn3270-gui.exe` (its resolved path, `alias`), so
 * the process gets package identity and still takes argv. A full-trust MSIX reads the file system
 * normally, so the stage is package-smoke's (shot and userData in the launch's directory, the
 * repository trace), in win32 paths whatever the host. The survivor check looks under the
 * package's install location, because the alias itself lives elsewhere.
 */
export function winRoute(io, { alias, installLocation }) {
  return {
    exe: alias,
    prefix: [],
    env: {},
    probe: true,
    installDir: installLocation,
    processDir: installLocation,
    stage: (dir) => ({ trace: io.trace ?? TRACE, shot: win32.join(dir, 'shot.png'), userData: win32.join(dir, 'user-data') }),
  };
}

// ---------------------------------------------------------------------------------------------
// Drivers. Everything that touches the system goes through `io` (run, fs, launch, checks), so
// main() is testable on a Linux box with none of codesign, PowerShell or Electron.

/** A setup problem: exit 2 (after cleanup). */
class Setup extends Error {}

const ROUTE_MAC = 'mac-sandbox';
const ROUTE_WIN = 'win-msix';

/** The entitlements files, posix (the mac driver's paths). */
const RESOURCES = fileURLToPath(new URL('../packages/gui/resources/', import.meta.url)).replace(/\\/g, '/');
const PLISTBUDDY = '/usr/libexec/PlistBuddy';
/** Where the Windows SDKs keep their tools; the newest `10.x.y.z\x64\signtool.exe` signs. */
export const SDK_BIN = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
/** The throwaway certificate's friendly name: with the subject, what cleanup finds it by without a thumbprint. */
const CERT_NAME = 'TN3270 store probe';
const STORES = ['Cert:\\CurrentUser\\My', 'Cert:\\LocalMachine\\TrustedPeople'];

/** The first lines of a command's output, for a FAIL line. */
const head = (text, n = 3) => (text ?? '').trim().split(/\r?\n/).slice(0, n).join(' | ') || '(no output)';
/** A PowerShell single-quoted string. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The newest SDK `bin\<10.x.y.z>\x64\<tool>`, by parsed version (not string order), among the
 * directory `names` under SDK_BIN; null when none has it. The spike's SdkTool, ported.
 */
export function newestSdkTool(names, exists, tool = 'signtool.exe') {
  const v = (n) => n.split('.').map(Number);
  const dirs = names.filter((n) => /^10\.\d+\.\d+\.\d+$/.test(n)).sort((a, b) => {
    const x = v(a); const y = v(b);
    for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  });
  for (const d of dirs) {
    const f = win32.join(SDK_BIN, d, 'x64', tool);
    if (exists(f)) return f;
  }
  return null;
}

/** The last non-empty line of the package-full-name query, or null. */
export function parsePackageFullName(text) {
  const ls = (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  return ls.length > 0 ? ls[ls.length - 1] : null;
}

/** A path compared as a normalized posix path, without a trailing slash. */
const norm = (p) => posix.normalize(p).replace(/(.)\/+$/, '$1');

/**
 * Removes the app's container, and ONLY `<home>/Library/Containers/io.github.athornton.tn3270`
 * (compared as normalized posix paths): any other path, or a home that is not an absolute
 * directory other than `/`, THROWS before anything is removed. Then the container must be gone.
 */
export function removeContainer(io, path) {
  const home = io.home;
  if (typeof home !== 'string' || !posix.isAbsolute(home) || norm(home) === '/') {
    throw new Error(`refusing to remove ${path}: home ${JSON.stringify(home)} is not an absolute directory other than /`);
  }
  const want = norm(containerPath(home));
  if (typeof path !== 'string' || norm(path) !== want) throw new Error(`refusing to remove ${path}: the only path ever removed is ${want}`);
  io.fs.rm(want);
  if (io.fs.exists(want)) throw new Error(`${want} still exists after removal`);
}

/** The one file in `files` matching `re`, or a Setup error naming what IS there. */
function one(files, re, what, dir) {
  const hits = files.filter((f) => re.test(f));
  if (hits.length === 1) return hits[0];
  throw new Setup(`expected exactly one ${what} in ${dir}, found ${hits.length === 0 ? 'none' : hits.join(', ')}; it has: ${files.join(', ') || '(nothing)'}`);
}

/** The ok/FAIL lines of one route, counting the FAILs. */
function reporter(io, route) {
  const r = { fails: 0 };
  r.ok = (what) => io.log(`ok ${route}: ${what}`);
  r.fail = (why) => { r.fails++; io.log(`FAIL ${route}: ${why}`); };
  /** One cleanup step: always attempted, its failure a FAIL line, never a throw. */
  r.cleanup = async (what, fn) => {
    try { await fn(); } catch (e) { r.fail(`cleanup ${what}: ${e.message}`); }
  };
  return r;
}

/**
 * Runs the checks on `route`, each judged twice: the check itself (a CheckFailed is its FAIL),
 * and the probe line its launch printed (`judgeProbe`), so every check's launch was confined too.
 * Anything else a check throws is not a verdict, and propagates (exit 2).
 */
async function runChecks(ctx, route, judgeProbe) {
  const { io, phase, rep, work } = ctx;
  for (const [i, [name, fn]] of (io.checks ?? CHECKS).entries()) {
    await phase(`check ${fn.name || i + 1}`, async () => {
      let res;
      try {
        res = await fn(route, work);
      } catch (e) {
        if (e instanceof CheckFailed) { rep.fail(`${name}: ${e.message}`); return; }
        throw e;
      }
      if (ctx.echo) io.log(`check ${name}: probe line ${JSON.stringify(res.probe)}`);
      const p = judgeProbe(parseProbeLine(res.probe));
      for (const x of p) rep.fail(`${name}: ${x}`);
      if (p.length === 0) rep.ok(`${name}${res.note ? ` (${res.note})` : ''}`);
    });
  }
}

/** The confinement launch, through io.launch; echoes its output; survivors are a FAIL. */
async function confinementLaunch(ctx, route, args, whileRunning) {
  const l = await ctx.io.launch(route, args, { work: ctx.work, whileRunning });
  if (ctx.echo) ctx.io.log(`confinement launch output:\n${l.stdout}${l.stderr ?? ''}`.replace(/\s+$/, ''));
  if (l.survivors.length > 0) ctx.rep.fail(`confinement launch: survived the kill: ${l.survivors.join(' ')}`);
  return l;
}

/**
 * macOS: a port of scripts/spike/mac-sandbox.sh's variant D (`prepare D ... teamid`, then the
 * first of `launches D`), run 43115293433. Steps, in the spike's order:
 *   1. plutil -lint the three entitlements files;
 *   2. remove a stale container (guarded), so its existence later is THIS launch's doing;
 *   3. ditto the MAS app into scratch;
 *   4. PlistBuddy Add (else Set) :ElectronTeamID, and Print it back;
 *   5. sign inside out: the Frameworks dylibs, the frameworks --deep, the helper apps with inherit,
 *      each login item's executables then the item with loginhelper, the app with main;
 *   6. codesign -d --entitlements :- and codesign --verify --deep --strict --verbose=2; an
 *      invalid copy (a signing failure, a --verify problem, no app-sandbox) launches nothing;
 *   7. the confinement launch (the spike's `bare`: --disable-gpu, TN3270_GUI_PROBE=1), then the
 *      container; judged by judgeMacConfinement;
 *   8. the checks on macRoute, every probe line judged;
 *   9. cleanup: the processes running from scratch (ps, kill -9 by PID), the container, the scratch.
 */
async function probeMac(ctx, dir) {
  const { io, run, phase, rep } = ctx;
  const src = posix.join(dir, 'mas-universal', 'TN3270.app');
  if (!io.fs.exists(src)) {
    throw new Setup(`no ${src}: build Electron's MAS app first, with \`npm run package:gui -- --mac mas --universal -c.mac.identity=null\``);
  }
  const container = containerPath(io.home);
  const ent = {
    main: posix.join(RESOURCES, 'entitlements.mas.plist'),
    inherit: posix.join(RESOURCES, 'entitlements.mas.inherit.plist'),
    login: posix.join(RESOURCES, 'entitlements.mas.loginhelper.plist'),
  };
  const work = io.fs.mkdtemp('tn3270-store-probe-');
  ctx.work = work;
  try {
    const bad = [];
    for (const f of [ent.main, ent.inherit, ent.login]) {
      const r = run('plutil', ['-lint', f]);
      if (r.status !== 0) bad.push(`plutil -lint ${f} failed (exit ${r.status}): ${head(r.text)}`);
    }
    if (bad.length > 0) { bad.forEach(rep.fail); return; }
    try { removeContainer(io, container); } catch (e) { throw new Setup(`a stale container would make the check meaningless: ${e.message}`); }

    const app = posix.join(work, 'TN3270.app');
    const copied = phase('copy', () => run('ditto', [src, app]));
    if (copied.status !== 0) { rep.fail(`ditto ${src} failed (exit ${copied.status}): ${head(copied.text)}`); return; }

    phase('sign', () => {
      const plist = posix.join(app, 'Contents', 'Info.plist');
      const add = run(PLISTBUDDY, ['-c', `Add :ElectronTeamID string ${TEAM_ID}`, plist]);
      if (add.status !== 0) {
        const set = run(PLISTBUDDY, ['-c', `Set :ElectronTeamID ${TEAM_ID}`, plist]);
        if (set.status !== 0) bad.push(`PlistBuddy could not add or set ElectronTeamID (exit ${set.status}): ${head(set.text)}`);
      }
      const got = run(PLISTBUDDY, ['-c', 'Print :ElectronTeamID', plist]);
      if (got.status !== 0 || got.stdout.trim() !== TEAM_ID) bad.push(`ElectronTeamID reads back as ${head(got.text)}, not ${TEAM_ID}`);

      const found = (args, what, atLeastOne) => {
        const r = run('find', args);
        if (r.status !== 0) { bad.push(`find ${what} failed (exit ${r.status}): ${head(r.text)}`); return []; }
        const hits = r.stdout.split('\n').filter((l) => l !== '');
        if (atLeastOne && hits.length === 0) bad.push(`found no ${what} to sign`);
        return hits;
      };
      const sign = (args, what) => {
        const r = run('codesign', args);
        if (r.status !== 0) bad.push(`signing ${what} failed (exit ${r.status}): ${head(r.text)}`);
      };
      const fw = posix.join(app, 'Contents', 'Frameworks');
      for (const f of found([fw, '-name', '*.dylib'], 'dylibs', false)) sign(['--force', '-s', '-', f], f);
      // --deep on frameworks only: Electron Framework.framework nests executables (Helpers/chrome_crashpad_handler).
      for (const f of found([fw, '-maxdepth', '1', '-name', '*.framework'], 'frameworks', true)) sign(['--force', '--deep', '-s', '-', f], f);
      for (const f of found([fw, '-maxdepth', '1', '-name', '*.app'], 'helper apps', true)) sign(['--force', '-s', '-', '--entitlements', ent.inherit, f], f);
      const items = posix.join(app, 'Contents', 'Library', 'LoginItems');
      for (const name of (io.fs.exists(items) ? io.fs.list(items) : []).filter((n) => n.endsWith('.app'))) {
        const li = posix.join(items, name);
        for (const f of found([posix.join(li, 'Contents', 'MacOS'), '-type', 'f', '-perm', '-u+x'], `${name} executables`, true)) {
          sign(['--force', '-s', '-', '--entitlements', ent.login, f], f);
        }
        sign(['--force', '-s', '-', '--entitlements', ent.login, li], li);
      }
      sign(['--force', '-s', '-', '--entitlements', ent.main, app], app);
    });
    const entitlements = run('codesign', ['-d', '--entitlements', ':-', app]).text;
    const verify = phase('verify', () => run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]));
    bad.push(...judgeSignatureVerify(verify.text, verify.status));
    if (!sandboxEntitled(entitlements)) bad.push('the signature does not entitle com.apple.security.app-sandbox (codesign -d --entitlements); not launched');
    if (bad.length > 0) { bad.forEach(rep.fail); return; }
    rep.ok(`signed (ad-hoc, app-sandbox entitled, codesign --verify --deep --strict clean)`);

    const route = macRoute({ home: io.home, fs: io.fs, trace: io.trace }, app);
    const confined = await phase('confine', async () => {
      const l = await confinementLaunch(ctx, route, ['--disable-gpu']);
      const probe = parseProbeLine(l.stdout);
      const p = judgeMacConfinement({ entitlements, containerExists: io.fs.exists(container), probe }, BUNDLE_ID);
      p.forEach(rep.fail);
      if (p.length === 0) rep.ok(`confined (the app reports sandbox=${probe.sandbox}; ${container} exists)`);
      return p.length === 0 && l.survivors.length === 0;
    });
    if (!confined) { io.log(`${ROUTE_MAC}: the checks were not run: without the confinement nothing else counts`); return; }
    await runChecks(ctx, route, (probe) => judgeProbeMac(probe, BUNDLE_ID));
  } finally {
    await phase('cleanup', async () => {
      await rep.cleanup('processes', () => reapMac(ctx, work));
      await rep.cleanup('container', () => removeContainer(io, container));
      await rep.cleanup('scratch', () => io.fs.rm(work));
    });
  }
}

/** Kills (by PID) every process whose executable is inside scratch, never by name (the spike's reap). */
function reapMac(ctx, work) {
  const r = ctx.run('ps', ['-ww', '-axo', 'pid=,comm=']);
  if (r.status !== 0) throw new Error(`ps failed (exit ${r.status}): ${head(r.text)}`);
  const under = [`${work}/`, `/private${work}/`];
  const pids = r.stdout.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null && under.some((u) => m[2].startsWith(u))).map((m) => m[1]);
  if (pids.length === 0) return;
  ctx.io.log(`${ROUTE_MAC}: reaping ${pids.join(' ')}`);
  const k = ctx.run('kill', ['-9', ...pids]);
  if (k.status !== 0) ctx.io.log(`${ROUTE_MAC}: kill -9 exit ${k.status}: ${head(k.text)}`);
}

/** The spike's SpikePkg: GetPackageFullName of a live pid, from outside the app. */
const packageOfPid = (pid) => `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class StoreProbePkg {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr h, ref uint len, StringBuilder name);
  public static string Of(int pid) {
    IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
    if (h == IntPtr.Zero) return "OpenProcess failed, error " + Marshal.GetLastWin32Error();
    try {
      uint len = 0;
      int rc = GetPackageFullName(h, ref len, null);
      if (rc == 15700) return "none (APPMODEL_ERROR_NO_PACKAGE)";
      if (rc != 122) return "GetPackageFullName rc=" + rc;
      StringBuilder sb = new StringBuilder((int)len);
      rc = GetPackageFullName(h, ref len, sb);
      return rc == 0 ? sb.ToString() : "GetPackageFullName rc=" + rc;
    } finally { CloseHandle(h); }
  }
}
'@
[StoreProbePkg]::Of(${Number(pid)})`;

/** Removes our certificate from `store`: by thumbprint, or without one by subject AND friendly name. */
const removeCert = (store, thumb) => (thumb
  ? `$p = ${q(`${store}\\${thumb}`)}; Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $p) { throw "still in ${store}: ${thumb}" }; 'removed'`
  : `$c = @(Get-ChildItem ${q(store)} | Where-Object { $_.Subject -eq ${q(PUBLISHER)} -and $_.FriendlyName -eq ${q(CERT_NAME)} }); foreach ($x in $c) { Remove-Item -LiteralPath $x.PSPath -Force }; "removed $($c.Count) by subject"`);

/**
 * Windows: a port of scripts/spike/win-appx.ps1's working path (the default package), run
 * 43112504521. Steps:
 *   1. the one TN3270-*-win-x64.appx, copied into scratch (the spike signed the artifact in place);
 *   2. the newest SDK signtool (the spike's SdkTool; never electron-builder's winCodeSign one);
 *   3. the certificate: New-SelfSignedCertificate (subject = the appx publisher, code-signing EKU),
 *      Export-PfxCertificate, Export-Certificate, Import-Certificate into LocalMachine\TrustedPeople;
 *   4. signtool sign /fd SHA256 /f <pfx> /p <pw>;
 *   5. Add-AppxPackage (with Get-AppPackageLog on failure), then Get-AppxPackage as JSON;
 *   6. the alias: Get-Command tn3270-gui.exe, else the WindowsApps alias file;
 *   7. the confinement launch through the alias, its pid's package full name sampled while it runs;
 *      judged by judgeWinConfinement;
 *   8. the checks on winRoute, every probe line judged;
 *   9. cleanup: processes under the install location (by PID), Remove-AppxPackage, the certificate
 *      from both stores, the pfx and cer, the scratch.
 */
async function probeWin(ctx, dir) {
  const { io, run, phase, rep } = ctx;
  const ps = (script) => {
    const full = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`;
    // -EncodedCommand (UTF-16LE base64), not -Command: no quoting of `"` or newlines through the
    // Windows command line can mangle the script. The echo shows the script itself.
    return run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')],
      { show: `$ powershell -EncodedCommand <<\n${full}\n>>` });
  };
  let files;
  try { files = io.fs.list(dir); } catch (e) { throw new Setup(`cannot list ${dir}: ${e.message}`); }
  const name = one(files, /^TN3270-.+-win-x64\.appx$/, 'TN3270-*-win-x64.appx', dir);
  let sdk;
  try { sdk = io.fs.list(SDK_BIN); } catch { sdk = []; }
  const signtool = newestSdkTool(sdk, io.fs.exists);
  if (signtool === null) throw new Setup(`no Windows SDK signtool: none of ${SDK_BIN}\\10.*\\x64\\signtool.exe exists (electron-builder's winCodeSign signtool cannot sign an appx, run 43112504521)`);
  io.log(`${ROUTE_WIN}: signtool ${signtool}`);

  const work = io.fs.mkdtemp('tn3270-store-probe-');
  ctx.work = work;
  const pfx = win32.join(work, 'probe.pfx');
  const cer = win32.join(work, 'probe.cer');
  const pw = (io.secret ?? (() => randomUUID().replace(/-/g, '')))();
  ctx.secrets.push(pw);
  let thumb = null;
  let installLocation = null;
  try {
    const appx = win32.join(work, name);
    io.fs.copy(win32.join(dir, name), appx);

    phase('certificate', () => {
      const r = ps([
        `$c = New-SelfSignedCertificate -Type Custom -Subject ${q(PUBLISHER)} -KeyUsage DigitalSignature -CertStoreLocation Cert:\\CurrentUser\\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') -FriendlyName ${q(CERT_NAME)}`,
        'Write-Output "thumbprint=$($c.Thumbprint)"',
        `Export-PfxCertificate -Cert "Cert:\\CurrentUser\\My\\$($c.Thumbprint)" -FilePath ${q(pfx)} -Password (ConvertTo-SecureString -String ${q(pw)} -Force -AsPlainText) | Out-Null`,
        `Export-Certificate -Cert "Cert:\\CurrentUser\\My\\$($c.Thumbprint)" -FilePath ${q(cer)} | Out-Null`,
        `Import-Certificate -FilePath ${q(cer)} -CertStoreLocation Cert:\\LocalMachine\\TrustedPeople | Out-Null`,
        'if (-not (Test-Path "Cert:\\LocalMachine\\TrustedPeople\\$($c.Thumbprint)")) { throw "the certificate is not in LocalMachine\\TrustedPeople" }',
      ].join('\n'));
      thumb = /^thumbprint=([0-9A-Fa-f]{40})\s*$/m.exec(r.stdout)?.[1] ?? null;
      if (r.status !== 0 || thumb === null) throw new Setup(`the throwaway certificate was not made and trusted (exit ${r.status}): ${head(r.text)}`);
    });

    const signed = phase('sign', () => run(signtool, ['sign', '/fd', 'SHA256', '/f', pfx, '/p', pw, appx]));
    if (signed.status !== 0) { rep.fail(`signtool sign failed (exit ${signed.status}): ${head(signed.text)}`); return; }

    const added = phase('install', () => ps([
      `try { Add-AppxPackage -Path ${q(appx)} -ErrorAction Stop; 'Add-AppxPackage: OK' }`,
      'catch {',
      '  $m = $_.Exception.Message; Write-Output "Add-AppxPackage: FAILED $m"',
      "  $aid = [regex]::Match($m, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}').Value",
      '  if ($aid) { Get-AppPackageLog -ActivityID $aid -ErrorAction SilentlyContinue | Select-Object -First 40 | Format-List | Out-String | Write-Output }',
      '  exit 1',
      '}',
    ].join('\n')));
    if (added.status !== 0) { rep.fail(`Add-AppxPackage failed (exit ${added.status}): ${head(added.text, 6)}`); return; }
    const listed = ps(`Get-AppxPackage -Name ${q(IDENTITY_NAME)} | ConvertTo-Json -Compress`);
    const pkg = listed.status === 0 ? parseAppxPackage(listed.stdout) : null;
    if (pkg === null) { rep.fail(`Get-AppxPackage lists no readable ${IDENTITY_NAME} package after the install (exit ${listed.status}): ${head(listed.text)}`); return; }
    installLocation = pkg.installLocation;
    io.log(`${ROUTE_WIN}: installed ${pkg.packageFullName} (family ${pkg.packageFamilyName}) at ${installLocation}`);

    const found = ps([
      '$c = Get-Command tn3270-gui.exe -ErrorAction SilentlyContinue',
      'if ($c) { "alias=$($c.Source)" } else {',
      "  $f = Join-Path $env:LOCALAPPDATA 'Microsoft\\WindowsApps\\tn3270-gui.exe'",
      '  if (Test-Path $f) { "alias=$f" } else { "alias=" }',
      '}',
    ].join('\n'));
    const alias = found.status === 0 ? (/^alias=(.+?)\s*$/m.exec(found.stdout)?.[1] ?? null) : null;
    if (alias === null) throw new Setup(`the app execution alias tn3270-gui.exe is not on PATH after Add-AppxPackage (exit ${found.status}): ${head(found.text)}`);

    const route = winRoute(io, { alias, installLocation });
    const confined = await phase('confine', async () => {
      const l = await confinementLaunch(ctx, route, switches(win32.join(work, 'confine-user-data')),
        (pid) => { const r = ps(packageOfPid(pid)); return r.status === 0 ? parsePackageFullName(r.stdout) : `query failed (exit ${r.status}): ${head(r.text)}`; });
      const probe = parseProbeLine(l.stdout);
      const p = judgeWinConfinement({ pkg, probe, started: l.during }, IDENTITY_NAME);
      p.forEach(rep.fail);
      if (p.length === 0) rep.ok(`confined (the app reports windowsStore=true; the alias-started process is ${l.during})`);
      return p.length === 0 && l.survivors.length === 0;
    });
    if (!confined) { io.log(`${ROUTE_WIN}: the checks were not run: without the confinement nothing else counts`); return; }
    await runChecks(ctx, route, judgeProbeWin);
  } finally {
    await phase('cleanup', async () => {
      await rep.cleanup('processes', () => {
        if (installLocation === null) return;
        const r = ps([
          `$d = ${q(installLocation)}`,
          'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; "killed $($_.ProcessId) $($_.ExecutablePath)" }',
        ].join('\n'));
        if (r.status !== 0) throw new Error(`exit ${r.status}: ${head(r.text)}`);
      });
      await rep.cleanup('Remove-AppxPackage', () => {
        const r = ps([
          `foreach ($p in @(Get-AppxPackage -Name ${q(IDENTITY_NAME)})) { Remove-AppxPackage -Package $p.PackageFullName; "removed $($p.PackageFullName)" }`,
          `if (@(Get-AppxPackage -Name ${q(IDENTITY_NAME)}).Count -gt 0) { throw 'still installed' }`,
        ].join('\n'));
        if (r.status !== 0) throw new Error(`exit ${r.status}: ${head(r.text)}`);
      });
      for (const store of STORES) {
        await rep.cleanup(`certificate ${store}`, () => {
          const r = ps(removeCert(store, thumb));
          if (r.status !== 0) throw new Error(`exit ${r.status}: ${head(r.text)}`);
        });
      }
      for (const f of [pfx, cer]) {
        await rep.cleanup(win32.basename(f), () => {
          io.fs.rm(f);
          if (io.fs.exists(f)) throw new Error(`${f} still exists`);
        });
      }
      await rep.cleanup('scratch', () => io.fs.rm(work));
    });
  }
}

const USAGE = 'usage: store-probe.mjs [artifacts/gui]';

/**
 * `io`: `{ run, fs, platform, env, log, home }`, and optionally `launch` (default
 * launchForProbe), `checks` (default package-checks' CHECKS), `trace`, `now`, `secret`.
 * Resolves the exit status.
 */
export async function main(argv, io) {
  const secrets = [];
  const echo = io.env.STORE_PROBE_ECHO === '1';
  const hide = (s) => secrets.filter((x) => x !== '').reduce((t, x) => t.split(x).join('***'), s);
  const run = (cmd, args, opts) => {
    if (echo) io.log(hide(opts?.show ?? `$ ${[cmd, ...args].join(' ')}`));
    const r = io.run(cmd, args, opts);
    if (echo) io.log(hide(`${r.text.replace(/\s+$/, '')}\n[exit ${r.status}]`));
    return r;
  };
  const now = io.now ?? Date.now;
  const time = (name, t0) => io.log(`time ${name}: ${((now() - t0) / 1000).toFixed(1)}s`);
  /** Times `fn` (sync or async) as `time <name>: <s>s`, however it ends. */
  const phase = (name, fn) => {
    const t0 = now();
    let r;
    try { r = fn(); } catch (e) { time(name, t0); throw e; }
    if (r instanceof Promise) return r.finally(() => time(name, t0));
    time(name, t0);
    return r;
  };
  const full = { launch: launchForProbe, ...io };
  const t0 = now();
  let rep;
  try {
    const rest = [];
    for (const a of argv) {
      if (a.startsWith('-')) throw new Setup(`unknown option ${a}\n${USAGE}`);
      rest.push(a);
    }
    if (rest.length > 1) throw new Setup(`one artifacts directory, not ${rest.length}\n${USAGE}`);
    const dir = rest[0] ?? 'artifacts/gui';
    const driver = io.platform === 'darwin' ? probeMac : io.platform === 'win32' ? probeWin : undefined;
    if (driver === undefined) throw new Setup(`nothing to probe on ${io.platform}: the store probe runs on macOS and Windows`);
    rep = reporter(io, io.platform === 'darwin' ? ROUTE_MAC : ROUTE_WIN);
    await driver({ io: full, run, phase, rep, echo, secrets, work: undefined }, dir);
    return rep.fails > 0 ? 1 : 0;
  } catch (err) {
    for (const line of (err instanceof Setup ? err.message : `error: ${err.message}`).split('\n')) io.log(`store-probe: ${line}`);
    return 2;
  } finally {
    time('total', t0);
  }
}

/**
 * The confinement launch (default io.launch): starts `route` with `args` through package-checks'
 * `start` (probe on, NO_SEAMS), waits for its `probe:` line (or its exit, at most LAUNCH_MS),
 * calls `whileRunning(pid)` while it still runs, then kills it by PID with package-checks' `stop`
 * and reports any survivor. An app that cannot start THROWS (exit 2).
 */
export async function launchForProbe(route, args, { work, whileRunning }) {
  const dir = mkdtempSync(posixOrHost(work, 'confine-'));
  const p = await start(route, args, {}, dir);
  p.child.stdin.end();
  let during = null;
  let survivors;
  try {
    await until(() => probeSeen(p.stdout) !== null || p.exited, LAUNCH_MS);
    if (!p.exited && whileRunning !== undefined && p.child.pid !== undefined) during = whileRunning(p.child.pid);
  } finally {
    survivors = await stop(route, p);
  }
  await p.closed;
  if (p.error !== undefined) throw new Error(`cannot start ${route.exe}: ${p.error.message}`);
  return { stdout: p.stdout, stderr: p.stderr, during, survivors };
}

/** `work` + `/` or `\` + `name`, by the separator `work` already uses (it is a host path). */
const posixOrHost = (work, name) => (work.includes('\\') ? win32.join(work, name) : posix.join(work, name));

/** The real file system, for the CLI. */
export const nodeFs = Object.freeze({
  exists: existsSync,
  list: (d) => readdirSync(d),
  copy: (from, to) => cpSync(from, to, { recursive: true }),
  rm: (p) => rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  mkdtemp: (prefix) => mkdtempSync(posixOrHost(tmpdir(), prefix)),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, text) => writeFileSync(p, text),
});

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2), {
    run: runCommand, fs: nodeFs, platform: process.platform, env: process.env, log: (l) => console.log(l), home: homedir(),
  });
}
