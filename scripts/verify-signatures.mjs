#!/usr/bin/env node
/**
 * Fail-closed signature check of the finished GUI installers (code signing spec, section 3).
 *
 *     node scripts/verify-signatures.mjs --expect signed|unsigned [artifacts/gui]
 *
 * `signed` needs APPLE_TEAM_ID (macOS) or AZURE_SIGNING_PUBLISHER (Windows). `unsigned` runs on
 * every non-release push, so the checks are shown to REJECT an unsigned build continuously.
 *
 * macOS: the one `TN3270-*-mac-universal.zip` is unpacked with `ditto -x -k` (as package-smoke
 * does; it keeps the bundle's symlinks) and the one `.dmg` is mounted read-only; the `TN3270.app`
 * in EACH is checked with `codesign --verify --deep --strict`, `codesign -dv --verbose=4`,
 * `spctl -a -t exec -vv` and `xcrun stapler validate`. The dmg itself is not required to be signed.
 * `unsigned` passes only on output it recognises as an unsigned app (see judgeMacApp): an ad-hoc
 * or absent signature, a `: rejected` from spctl, no stapled ticket. A tool answering anything
 * else is a FAIL, never "unsigned".
 *
 * Windows: the one `TN3270-*-win-x64.exe` is checked, then silent-installed exactly as
 * package-smoke does (`/S /D=<dir>`, `/D=` last and unquoted, verbatim arguments), and the
 * installed `TN3270.exe` and `Uninstall TN3270.exe` are checked too; then it is uninstalled
 * (`/S _?=<dir>`, which waits), best effort. (The spec said to extract app-64.7z with 7zz
 * instead; 7zip-bin is not a dependency here, and the installed files are what users run.) Each
 * check is `Get-AuthenticodeSignature` through pwsh, projected to `{"Status","Subject"}` JSON
 * on stdout; `unsigned` accepts only `NotSigned`.
 *
 * Exit 0: every artifact is as expected (`ok <artifact>: <mode>`). 1: problems, each printed as
 * `FAIL <artifact>: <problem>`. 2: usage -- a bad or missing `--expect`, an unsupported platform,
 * a missing or duplicate artifact. A tool that cannot start THROWS: it is never read as "unsigned".
 * `VERIFY_SIGNATURES_ECHO=1` logs every command and its raw output, for capturing fixtures, and on
 * macOS also runs `spctl --status` once (logged, never judged).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_ID = 'Developer ID Application:';

/** Non-comment lines; fixtures carry their provenance (captured, or provisional) on `#` lines. */
const lines = (text) => text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'));

/** `codesign -dv --verbose=4` (stderr) -> what judgeMacApp needs. */
export function parseCodesignDisplay(text) {
  const ls = lines(text);
  const authorities = ls.filter((l) => l.startsWith('Authority=')).map((l) => l.slice('Authority='.length));
  const team = ls.find((l) => l.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length);
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(ls.find((l) => l.startsWith('CodeDirectory')) ?? '')?.[1]?.split(',') ?? [];
  return {
    authorities,
    teamId: team === undefined || team === 'not set' ? undefined : team,
    runtime: flags.includes('runtime'),
    adhoc: flags.includes('adhoc') || ls.includes('Signature=adhoc'),
  };
}

/** `(<tool> exit N: <first line>)`, for messages about output that was not understood. */
const said = (tool, r) => `(${tool} exit ${r.status}: ${lines(r.text)[0] ?? '(no output)'})`;

/** spctl's own word that Gatekeeper is off, so a FAIL says why spctl could not judge. */
const gatekeeper = (text) => (text.includes('override=security disabled')
  ? '; Gatekeeper assessments are DISABLED on this machine (override=security disabled), so spctl did not judge it'
  : '');

/**
 * One .app's four command results -> problems (empty = as expected).
 *
 * `unsigned` passes ONLY on recognised shapes, so a broken tool is never read as "unsigned":
 * `codesign -dv` exits non-zero saying `code object is not signed at all`, or exits 0 with an
 * ad-hoc signature (no authorities, no team); AND `spctl` exits non-zero with a `: rejected`
 * line; AND `stapler` exits non-zero saying `does not have a ticket stapled to it`.
 */
export function judgeMacApp(r, expect, teamId) {
  const d = parseCodesignDisplay(r.display.text);
  const leaf = d.authorities[0];
  if (expect === 'unsigned') {
    const p = [];
    const notSigned = r.display.status !== 0 && r.display.text.includes('code object is not signed at all');
    const adhoc = r.display.status === 0 && d.adhoc && d.authorities.length === 0 && d.teamId === undefined;
    if (leaf?.startsWith(DEV_ID)) p.push(`signed by ${leaf}; expected unsigned`);
    else if (!notSigned && !adhoc) p.push(`unrecognised codesign -dv answer: neither ad-hoc nor not signed at all ${said('codesign -dv', r.display)}`);
    if (r.spctl.status === 0 || !lines(r.spctl.text).some((l) => l.endsWith(': rejected'))) {
      p.push(`unrecognised spctl answer: expected a non-zero exit and a ": rejected" line ${said('spctl', r.spctl)}${gatekeeper(r.spctl.text)}`);
    }
    // Wording CONFIRMED by CI run 42844605289 (exit 65, "TN3270.app does not have a ticket stapled
    // to it."). Positive on purpose: an empty failure, a signal, `Operation not permitted` or
    // xcrun's own `xcrun: error:` (no developer tools) are not "no ticket".
    if (r.stapler.status === 0 || !r.stapler.text.includes('does not have a ticket stapled to it')) {
      p.push(`unrecognised xcrun stapler validate answer: expected it to find no ticket ${said('xcrun stapler', r.stapler)}`);
    }
    return p;
  }
  const p = [];
  if (teamId === undefined || teamId === '') p.push('APPLE_TEAM_ID is not set; nothing to check the signature against');
  if (r.verify.status !== 0) p.push(`codesign --verify --deep --strict failed: ${r.verify.text.trim()}`);
  if (!leaf?.startsWith(DEV_ID)) p.push(`leaf authority is ${leaf ?? '(none)'}, not ${DEV_ID}`);
  else if (teamId && (d.teamId !== teamId || !leaf.endsWith(`(${teamId})`))) p.push(`signed by ${leaf}, team ${d.teamId}; expected team ${teamId}`);
  if (!d.runtime) p.push('no hardened runtime flag (notarization requires it)');
  if (r.spctl.status !== 0) p.push(`spctl rejected it: ${r.spctl.text.trim()}${gatekeeper(r.spctl.text)}`);
  else if (!lines(r.spctl.text).includes('source=Notarized Developer ID')) p.push(`spctl source is not Notarized Developer ID: ${r.spctl.text.trim()}${gatekeeper(r.spctl.text)}`);
  if (r.stapler.status !== 0) p.push(`xcrun stapler validate failed: ${r.stapler.text.trim()}`);
  return p;
}

/** The verifier's own pwsh projection, `{"Status":..,"Subject":..}`. */
export function parseAuthenticode(text) {
  let o;
  try { o = JSON.parse(text.trim()); } catch { o = undefined; }
  if (typeof o?.Status !== 'string' || typeof o?.Subject !== 'string') {
    throw new Error(`not an Authenticode projection: ${text.trim().slice(0, 200)}`);
  }
  return { status: o.Status, subject: o.Subject };
}

/**
 * One file's signature -> problems. The CN must EQUAL the publisher, not contain it. `unsigned`
 * accepts ONLY `NotSigned`: UnknownError, NotSupportedFileFormat, HashMismatch... are not an
 * unsigned file, they are something this check does not understand.
 */
export function judgeWinFile(sig, expect, publisher) {
  if (expect === 'unsigned') {
    if (sig.status === 'NotSigned') return [];
    if (sig.status === 'Valid') return [`has a Valid signature (${sig.subject}); expected unsigned`];
    return [`signature status ${sig.status}, not NotSigned; expected unsigned`];
  }
  const p = [];
  if (publisher === undefined || publisher === '') p.push('AZURE_SIGNING_PUBLISHER is not set; nothing to check the signer against');
  if (sig.status !== 'Valid') p.push(`signature status ${sig.status}, not Valid`);
  const cn = sig.subject.split(/,\s*/).find((part) => part.startsWith('CN='));
  if (publisher && cn !== `CN=${publisher}`) p.push(`signer ${cn ?? '(no CN)'}; expected CN=${publisher}`);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Drivers. Everything that touches the system goes through `io`, so main() is testable on a box
// that has none of codesign, hdiutil, spctl or pwsh.
// Paths are built with the TARGET platform's rules (posix.join in the mac driver, win32.join in
// the Windows one), never the host's: the driver is picked by io.platform, and with host `join`
// a darwin run tested on a Windows host got `\scratch\zip\TN3270.app` (CI run 42844605289).

/** A usage problem: exit 2. */
class Usage extends Error {}

/** The one file in `files` matching `re`, or a Usage error naming what IS there. */
function one(files, re, what, dir) {
  const hits = files.filter((f) => re.test(f));
  if (hits.length === 1) return hits[0];
  const found = hits.length === 0 ? 'none' : hits.join(', ');
  throw new Usage(`expected exactly one ${what} in ${dir}, found ${found}; it has: ${files.join(', ') || '(nothing)'}`);
}

/** `list(dir)` (the names `keep` keeps), or a note saying why not, for messages that name what IS there. */
function listing(list, dir, keep = () => true) {
  try { return list(dir).filter(keep).join(', ') || '(none)'; } catch (e) { return `(cannot list: ${e.message})`; }
}

/** The four mac checks of one .app. */
function macApp(run, app, expect, teamId) {
  return judgeMacApp({
    verify: run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]),
    display: run('codesign', ['-dv', '--verbose=4', app]),
    spctl: run('spctl', ['-a', '-t', 'exec', '-vv', app]),
    stapler: run('xcrun', ['stapler', 'validate', app]),
  }, expect, teamId);
}

/** -> [[artifact, problems]] for the zip's app and the dmg's app, in that order. */
function verifyMac(dir, expect, io, run, work) {
  const files = io.list(dir);
  const zip = one(files, /^TN3270-.+-mac-universal\.zip$/, 'TN3270-*-mac-universal.zip', dir);
  const dmg = one(files, /^TN3270-.+-mac-universal\.dmg$/, 'TN3270-*-mac-universal.dmg', dir);
  const teamId = io.env.APPLE_TEAM_ID;
  const zipDir = posix.join(work, 'zip');
  const mnt = posix.join(work, 'dmg');
  const results = [];
  // Logged, never judged: the first capture shows whether Gatekeeper assessments are on here.
  if (io.env.VERIFY_SIGNATURES_ECHO === '1') run('spctl', ['--status']);
  const check = (name, root) => {
    const app = posix.join(root, 'TN3270.app');
    if (!io.exists(app)) return [name, [`no ${app}; ${root} has: ${listing(io.list, root)}`]];
    return [name, macApp(run, app, expect, teamId)];
  };
  const unpacked = run('ditto', ['-x', '-k', posix.join(dir, zip), zipDir]);
  let thrown;
  try {
    const attached = run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mnt, posix.join(dir, dmg)]);
    results.push(unpacked.status === 0 ? check(zip, zipDir) : [zip, [`ditto -x -k failed (exit ${unpacked.status}): ${unpacked.text.trim()}`]]);
    results.push(attached.status === 0 ? check(dmg, mnt) : [dmg, [`hdiutil attach failed (exit ${attached.status}): ${attached.text.trim()}`]]);
  } catch (e) {
    thrown = e;
    throw e;
  } finally {
    // Always, even after a throw or a failed attach (which leaves nothing to detach: harmless).
    // A detach that throws is logged and must not replace the error that got us here.
    try {
      const d = run('hdiutil', ['detach', mnt]);
      if (d.status !== 0) {
        const f = run('hdiutil', ['detach', '-force', mnt]);
        if (f.status !== 0) io.log(`verify-signatures: hdiutil detach -force ${mnt} failed (exit ${f.status}): ${f.text.trim()}`);
      }
    } catch (e) {
      io.log(`verify-signatures: hdiutil detach ${mnt} threw: ${e.message}`);
      if (thrown === undefined) throw e;
    }
  }
  return results;
}

/**
 * Get-AuthenticodeSignature of `path` -> problems. Unparseable output fails in BOTH modes. The
 * JSON is read from stdout ALONE: PowerShell can write CLIXML progress records to stderr, and
 * progress is switched off besides.
 */
function winFile(run, path, expect, publisher) {
  const ps = `$ProgressPreference='SilentlyContinue'; Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}' | Select-Object @{n='Status';e={$_.Status.ToString()}}, @{n='Subject';e={if ($_.SignerCertificate) { $_.SignerCertificate.Subject } else { '' }}} | ConvertTo-Json -Compress`;
  const r = run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  if (r.status !== 0) return [`Get-AuthenticodeSignature failed (exit ${r.status}): ${r.text.trim()}`];
  let sig;
  try { sig = parseAuthenticode(r.stdout); } catch (e) { return [e.message]; }
  return judgeWinFile(sig, expect, publisher);
}

/** -> [[artifact, problems]] for the installer, then the installed app and uninstaller. */
function verifyWin(dir, expect, io, run, work) {
  const installerName = one(io.list(dir), /^TN3270-.+-win-x64\.exe$/, 'TN3270-*-win-x64.exe', dir);
  const installer = win32.join(dir, installerName);
  const publisher = io.env.AZURE_SIGNING_PUBLISHER;
  const results = [[installerName, winFile(run, installer, expect, publisher)]];
  const target = win32.join(work, 'install');
  const uninstaller = win32.join(target, 'Uninstall TN3270.exe');
  try {
    // package-smoke's invocation: /S, then /D= LAST and unquoted (NSIS reads to the end of the
    // command line), verbatim so node adds no quotes, the program name quoted by hand.
    const r = run(installer, ['/S', `/D=${target}`], { verbatim: true });
    if (r.status !== 0) {
      results.push(['install', [`silent install of ${installerName} failed (exit ${r.status}): ${r.text.trim()}`]]);
      return results;
    }
    // No separate "made no install directory" check: each file below then FAILs, and the
    // listing says the directory cannot be listed.
    for (const name of ['TN3270.exe', 'Uninstall TN3270.exe']) {
      const p = win32.join(target, name);
      const label = `installed ${name}`;
      if (!io.exists(p)) {
        results.push([label, [`no ${p}; its .exe files are ${listing(io.list, target, (f) => f.toLowerCase().endsWith('.exe'))}`]]);
      } else {
        results.push([label, winFile(run, p, expect, publisher)]);
      }
    }
    return results;
  } finally {
    // Best effort. Plain `/S` makes the NSIS uninstaller copy itself to %TEMP% and return at once,
    // racing the next CI step; `_?=<dir>` (LAST and unquoted, so verbatim) runs it in place and
    // waits. electron-builder's own installUtil.nsh calls it so: `ExecWait '"$uninstallerFileName"
    // /S /KEEP_APP_DATA $0 _?=$installationDir'` (app-builder-lib 26.18.0, line 230). In place it
    // cannot delete itself; the scratch removal afterwards takes the leftover.
    if (io.exists(uninstaller)) {
      try {
        const u = run(uninstaller, ['/S', `_?=${target}`], { verbatim: true });
        io.log(`uninstall: exit ${u.status}`);
      } catch (e) {
        io.log(`uninstall: ${e.message}`);
      }
    }
  }
}

const USAGE = 'usage: verify-signatures.mjs --expect signed|unsigned [artifacts/gui]';

export function main(argv, io) {
  const list = io.list ?? ((d) => readdirSync(d));
  const exists = io.exists ?? existsSync;
  const env = io.env;
  const echo = env.VERIFY_SIGNATURES_ECHO === '1';
  const run = (cmd, args, opts) => {
    if (echo) io.log(`$ ${[cmd, ...args].join(' ')}`);
    const r = io.run(cmd, args, opts);
    if (echo) io.log(`${r.text.replace(/\s+$/, '')}\n[exit ${r.status}]`);
    return r;
  };
  let work;
  let results;
  try {
    let expect;
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--expect') expect = argv[++i];
      else if (argv[i].startsWith('-')) throw new Usage(`unknown option ${argv[i]}\n${USAGE}`);
      else rest.push(argv[i]);
    }
    if (expect !== 'signed' && expect !== 'unsigned') throw new Usage(`--expect must be signed or unsigned, not ${expect ?? '(missing)'}\n${USAGE}`);
    if (rest.length > 1) throw new Usage(`one artifacts directory, not ${rest.length}\n${USAGE}`);
    const driver = io.platform === 'darwin' ? verifyMac : io.platform === 'win32' ? verifyWin : undefined;
    if (driver === undefined) throw new Usage(`no GUI installers to verify on ${io.platform}: run it on macOS or Windows`);
    const dir = rest[0] ?? 'artifacts/gui';
    let files;
    try { files = list(dir); } catch (e) { throw new Usage(`cannot list ${dir}: ${e.message}`); }
    work = io.scratch ? io.scratch() : mkdtempSync(join(tmpdir(), 'tn3270-sig-'));
    results = driver(dir, expect, { env, log: io.log, exists, list: (d) => (d === dir ? files : list(d)) }, run, work);
    let failed = 0;
    for (const [artifact, problems] of results) {
      if (problems.length === 0) io.log(`ok ${artifact}: ${expect}`);
      for (const p of problems) { failed++; io.log(`FAIL ${artifact}: ${p}`); }
    }
    return failed > 0 ? 1 : 0;
  } catch (err) {
    if (!(err instanceof Usage)) throw err;
    for (const line of err.message.split('\n')) io.log(`verify-signatures: ${line}`);
    return 2;
  } finally {
    // Only our own: an injected scratch belongs to the caller. The uninstaller has finished by now
    // (`_?=` waits), but a failure here is still only logged: a file held open by, say, an
    // antivirus scan, or a dmg that would not detach, must not turn a verdict into a crash.
    if (work !== undefined && !io.scratch) {
      try { rmSync(work, { recursive: true, force: true }); } catch (e) { io.log(`verify-signatures: left ${work}: ${e.message}`); }
    }
  }
}

/**
 * `cmd args...` -> exit status and stdout+stderr together (codesign -dv and spctl answer on
 * stderr). THROWS when the command cannot start or times out: a missing tool is not "unsigned".
 * `verbatim`: Windows command line passed as is, the program name quoted by hand (package-smoke).
 */
export function runCommand(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, spawnOptions(cmd, opts));
  if (r.error !== undefined) throw new Error(`cannot run ${cmd}: ${r.error.message}`);
  const stdout = r.stdout ?? '';
  const killed = r.signal ? `[killed by ${r.signal}]\n` : '';
  return { status: r.status ?? 1, stdout, text: stdout + (r.stderr ?? '') + killed };
}

/** runCommand's spawnSync options: 10 minutes at most, and package-smoke's verbatim mode. */
export function spawnOptions(cmd, opts = {}) {
  return {
    encoding: 'utf8', timeout: 600_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    ...(opts.verbatim ? { windowsVerbatimArguments: true, argv0: `"${cmd}"` } : {}),
  };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), {
    env: process.env, run: runCommand, log: (l) => console.log(l), platform: process.platform,
  });
}
