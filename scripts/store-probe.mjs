#!/usr/bin/env node
/**
 * The store probe (store-probe spec, and its Amendment 2026-11-12): the app, confined as each
 * store confines it, must prove the confinement from inside the process and pass package-smoke's
 * two checks (package-checks.mjs). Nothing built here is ever uploaded.
 *
 * This part is PURE: the parsers and judges of what the tools and the app say, and the two routes
 * the checks launch. Every judge FAILS CLOSED -- missing or unrecognised evidence is a problem,
 * never "unconfined but fine":
 *   - a missing or malformed `probe:` line is a problem (parseProbeLine -> null);
 *   - `sandbox=none` is a problem on macOS, `windowsStore=false` on Windows;
 *   - a `codesign --verify` that names any subcomponent, or does not say `valid on disk`, is one.
 *
 * Paths are built with the TARGET platform's rules (posix in the mac route, win32 in the Windows
 * one), never the host's: verify-signatures.mjs learnt that from CI run 42844605289.
 */
import { posix, win32 } from 'node:path';
import { TRACE } from './package-checks.mjs';

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
  if (probe === null || probe === undefined) p.push(NO_PROBE);
  else if (probe.sandbox === null) p.push('the app reports sandbox=none: it is NOT sandboxed');
  else if (probe.sandbox !== bundleId) p.push(`the app reports sandbox=${probe.sandbox}, not ${bundleId}`);
  return p;
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
  if (probe === null || probe === undefined) p.push(NO_PROBE);
  else if (probe.windowsStore !== true) p.push('the app reports windowsStore=false: it has no package identity');
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
