/**
 * The two checks every packaged-app route gets, and their launch plumbing: MOVED here from
 * `package-smoke.mjs`, not copied, so `store-probe.mjs` runs the very same checks on its routes.
 *
 *   1. `drawsGolden`: it replays `synthetic-ispf-like.trace` with shot.mjs case 1's argv and draws
 *      the synthetic-ispf golden (see "THE GOLDEN, ON EVERY OS" below);
 *   2. `dialogConnects`: launched with NO host -- the double-click route -- it opens the Connect
 *      dialog, and the dialog's submit reaches a throwaway telnet server in plaintext
 *      (`IAC WILL TERMINAL-TYPE` comes back to the server's `IAC DO TERMINAL-TYPE`).
 *
 * Each check is `fn(route, work)` and resolves `{ note, probe }` (`note` is '' or text for the ok
 * line; `probe` below), or throws `CheckFailed`. `work` is the route's scratch directory; each
 * launch makes its own fresh mkdtemp directory under it.
 *
 * ## THE ROUTE
 *
 * `{ exe, prefix, env, installDir?, processDir?, stage?, probe? }`. `exe` is started with
 * `[...prefix, ...args]` and `env` over the inherited environment. The optional fields, with
 * the defaults that are package-smoke's behaviour (`routeDefaults`):
 *   - `stage(dir) -> { trace, shot, userData }`: where a launch's input trace, its capture and
 *     its Electron userData live. `dir` is the launch's fresh directory. Default `defaultStage`:
 *     the repository's trace, and `shot.png` and `user-data` in `dir`. A route whose app cannot
 *     see `dir` (macOS App Sandbox) puts them somewhere it can, copying the trace there itself.
 *     EVERY path the checks pass to the app comes from here. The repository trace is still
 *     required to exist, but the STAGED trace is not pre-checked: the app reporting that it cannot
 *     read it is the honest failure (`replay: cannot read ...`, exit 1).
 *   - `probe`: true adds `TN3270_GUI_PROBE=1` to the launch, and the check's `probe` is the last
 *     `probe:` line the app printed (null when it printed none). Default false, and then `probe`
 *     is null.
 *   - `processDir`: Windows only, the directory the survivor check looks under (by
 *     ExecutablePath). Default `installDir`. A route that starts the app through something outside
 *     its install (an MSIX app execution alias) names the package's directory here.
 *
 * Host flags (`linux`, `win`, from process.platform) still decide `--no-sandbox`, the Linux
 * XDG_CONFIG_HOME, the /proc descendant record and the Windows survivor check, as in
 * package-smoke.
 *
 * Every launch on every OS gets `--user-data-dir=<stage's userData>` (Electron's userData;
 * main.ts strips it before parsing, electronSwitches.ts), so a run never reads or writes the real
 * `TN3270` app-data directory -- XDG_CONFIG_HOME alone would cover only Linux.
 *
 * ## THE GOLDEN, ON EVERY OS
 *
 * `synthetic-ispf.sha256` was recorded on Linux under Xvfb at scale factor 1 in sRGB, and the hash
 * is of the raw bitmap. Every launch passes `CAPTURE_SWITCHES` (smoke-lib.mjs) to ask Chromium for
 * exactly that, and the hash must then match on every OS. Measured before that rule (CI runs 2 and
 * 3, 2026-11-06): macOS arm64, Windows and both Linux runners matched byte for byte; macos-26-intel
 * captured 1440x700 (scale 2) with greens shifted by the display profile, and the same geometry.
 *
 * ## EVERY LAUNCH IS BOUNDED AND KILLED BY PID
 *
 * 120 s per launch. POSIX: each launch leads its own process group and the group is SIGKILLed;
 * Windows: `taskkill /T /F /PID`. Then the check asserts no survivor: the process group is empty
 * (POSIX; on Linux also every descendant recorded from /proc before the kill), or no process runs
 * from the route's `processDir` (Windows, by ExecutablePath). Never by name -- `pkill -f electron`
 * kills other people's sessions on a shared box.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPTURE_SWITCHES, descendants, displayEnv, fail, gone, groupEmpty, judgeShot, killTree, launch, said,
  startServer, until, within,
} from './smoke-lib.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const TRACE = join(root, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');
/** shot.mjs case 1's golden; read at check time, never copied here. */
export const GOLDEN = join(root, 'packages', 'gui', 'test', 'golden', 'synthetic-ispf.sha256');
export const GOLDEN_PNG = join(root, 'packages', 'gui', 'test', 'golden', 'synthetic-ispf.png');
const linux = process.platform === 'linux';
const win = process.platform === 'win32';
export const LAUNCH_MS = 120_000;

/** Every seam these checks do not use, cleared: an inherited one would replay, type or photograph. */
export const NO_SEAMS = Object.freeze({
  TN3270_GUI_REPLAY: '', TN3270_GUI_SHOT: '', TN3270_GUI_KEYS: '', TN3270_GUI_CLICKS: '',
  TN3270_GUI_SELECT: '', TN3270_GUI_TRANSFER: '', TN3270_GUI_URL: '', TN3270_GUI_CONNECT: '',
  TN3270_GUI_PROBE: '',
});

/** package-smoke's staging: the repository trace, and the capture and userData in `dir`. */
export const defaultStage = (dir) => ({
  trace: TRACE, shot: join(dir, 'shot.png'), userData: join(dir, 'user-data'),
});

/** The route's optional fields, with their defaults filled in (see "THE ROUTE"). */
export const routeDefaults = (r) => ({
  stage: r.stage ?? defaultStage,
  probe: r.probe === true,
  processDir: r.processDir ?? r.installDir,
});

/**
 * The Chromium switches every launch gets; main.ts strips them (electronSwitches.ts). `userData`
 * is the stage's: the app's userData, on every OS.
 */
export const switches = (userData) => ['--disable-gpu', ...CAPTURE_SWITCHES, ...(linux ? ['--no-sandbox'] : []), `--user-data-dir=${userData}`];

/**
 * Starts the route's app with `args` and `extraEnv`; see `launch` in smoke-lib.mjs. A probe
 * route also gets `TN3270_GUI_PROBE=1`, after NO_SEAMS so the clearing does not undo it.
 * `display`: smoke-lib's displayEnv (on Linux with no DISPLAY it starts Xvfb); injectable so a
 * test launching a fake, display-less app does not depend on the host having an X server.
 */
export async function start(r, args, extraEnv, cwd, { display = displayEnv } = {}) {
  const probe = routeDefaults(r).probe ? { TN3270_GUI_PROBE: '1' } : {};
  const env = await display({ ...process.env, ...r.env, ...NO_SEAMS, ...probe, ...extraEnv });
  delete env.TN3270_GUI_MAIN;
  // macOS sets APP_SANDBOX_CONTAINER_ID itself in a sandboxed process (probe.ts reports it): an
  // inherited one would let an UNSANDBOXED launch print `sandbox=<id>` and pass the probe.
  delete env.APP_SANDBOX_CONTAINER_ID;
  // windowsHide OFF (unmeasured caution): it puts SW_HIDE in STARTUPINFO, which Windows applies
  // to a process's first ShowWindow -- possibly the very window being captured.
  return launch(r.exe, [...r.prefix, ...args], env, { group: true, spawnOptions: { cwd, windowsHide: false } });
}

/** Windows: PIDs of every process whose executable lives under `dir` (PowerShell CIM). */
export function winProcessesUnder(dir) {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${dir.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.status !== 0) return [`(powershell failed: ${r.error?.message ?? r.stderr})`];
  return r.stdout.split(/\s+/).filter((s) => s !== '');
}

/**
 * Kills the launch's whole tree and returns whatever survived (empty: nothing did). The tree is
 * recorded BEFORE the kill on Linux, because a reparented orphan is no longer anyone's
 * descendant afterwards. Windows looks under the route's `processDir`; a route with none cannot
 * be checked, and that is reported as a survivor rather than passed.
 */
export async function stop(r, p) {
  const pid = p.child.pid;
  if (pid === undefined) return [];
  const tree = linux ? [pid, ...descendants(pid)] : [pid];
  killTree(p.child);
  await within(p.closed, 10_000);
  if (win) {
    const { processDir } = routeDefaults(r);
    if (processDir === undefined) return ['(the route has no processDir or installDir to look under)'];
    let left = [];
    await until(() => (left = winProcessesUnder(processDir)).length === 0, 10_000);
    return left;
  }
  for (const q of tree) { try { process.kill(q, 'SIGKILL'); } catch { /* gone */ } }
  await until(() => groupEmpty(pid) && tree.every(gone), 10_000);
  return [...(groupEmpty(pid) ? [] : [`process group ${pid}`]), ...tree.filter((q) => !gone(q))];
}

/** Waits for the launch to exit by itself, up to `ms`; true when it did. */
export const exitedWithin = (p, ms) => within(p.closed, ms);

/**
 * The last `probe:` line on `stdout`, or null. Anchored at a line start: probe.ts prints it as
 * its own line, and the probe routes are not the AppImage, whose runtime interleaves its stdout
 * (see `drawsGolden`).
 */
export function probeSeen(stdout) {
  const lines = stdout.split(/\r?\n/).filter((l) => l.startsWith('probe: '));
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

/** Check 1: shot.mjs case 1's argv and env, and the synthetic-ispf golden. */
export async function drawsGolden(r, work) {
  if (!existsSync(TRACE)) fail(`the input trace ${TRACE} is missing from the repository`);
  if (!existsSync(GOLDEN)) fail(`the golden ${GOLDEN} is missing from the repository`);
  const want = readFileSync(GOLDEN, 'utf8').trim();
  const d = routeDefaults(r);
  // A fresh directory each run, so a capture left by an earlier run cannot be what passes.
  const dir = mkdtempSync(join(work, 'shot-'));
  const { trace, shot, userData } = d.stage(dir);
  const p = await start(r, [...switches(userData), '-insecure', '-model', '3278-2-E', '127.0.0.1:1'],
    { TN3270_GUI_REPLAY: trace, TN3270_GUI_SHOT: shot, TN3270_GUI_SHOT_MS: '2500' }, dir);
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
  const note = judgeShot({ got, want, shot, goldenPng: GOLDEN_PNG });
  return { note, probe: d.probe ? probeSeen(res.stdout) : null };
}

/** Check 2: no host, so the Connect dialog; its submit must reach a plaintext telnet server. */
export async function dialogConnects(r, work) {
  const d = routeDefaults(r);
  const srv = await startServer();
  const dir = mkdtempSync(join(work, 'connect-'));
  const { userData } = d.stage(dir);
  const p = await start(r, switches(userData), {
    TN3270_GUI_CONNECT: JSON.stringify({ host: `127.0.0.1:${srv.port}`, model: '3278-2-E', tls: false }),
    // Linux: a fresh config directory as well, for anything that reads XDG rather than userData.
    ...(linux ? { XDG_CONFIG_HOME: join(dir, 'config') } : {}),
  }, dir);
  p.child.stdin.end();
  let survivors = [];
  let checks;
  try {
    // THE SERVER IS THE WITNESS, NOT STDOUT. The first CI run (2026-11-06, ubuntu-latest) had the
    // AppImage's `connect: submitted` line never reach this pipe -- the AppImage runtime holds the
    // app's stdout -- while the server HAD received WILL TERMINAL-TYPE: the submit worked and the
    // check waited out LAUNCH_MS for a line, then killed a working app. So wait for either, and
    // decide on the bytes. With NO host argument, a telnet reply can only come from the dialog's
    // submit; one `connect:` line is still required, so a launch that dialled by some other route
    // cannot pass.
    // From launch to submit: cold start, and on the AppImage its extraction too.
    await until(() => p.stdout.includes('connect: submitted') || srv.willTtype() || p.exited, LAUNCH_MS);
    // ~10 s from the SUBMIT for the handshake reply.
    await until(() => srv.willTtype(), 10_000);
    checks = [
      ['a connect: line (dialog shown or submitted)',
        p.stdout.includes('connect: dialog shown') || p.stdout.includes('connect: submitted')],
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
  return { note: '', probe: d.probe ? probeSeen(p.stdout) : null };
}

export const CHECKS = Object.freeze([
  ['replays a trace and draws the synthetic-ispf golden', drawsGolden],
  ['with no host, opens the Connect dialog and connects', dialogConnects],
]);
