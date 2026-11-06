/**
 * Helpers shared by the smoke scripts (`install-smoke.mjs`, `package-smoke.mjs`) and the GUI
 * harness `packages/gui/scripts/connect.mjs`: bounded spawns that kill their whole process tree,
 * failure reporting, the display an Electron needs, and the throwaway telnet server whose reply
 * is the oracle for "the client connected in plaintext".
 *
 * Moved here, not copied, so the two smoke scripts share one copy of the kill and display rules.
 * NOT YET connect.mjs: it imports `descendants`, `sleep`, `startServer` and `until` from here but
 * keeps its own `alive`/`launch`/`kill` (repo Electron via `guiEnv`, no Windows path), so those
 * can still drift from `gone`/`launch`/`killTree` below. Nothing in this module resolves Electron
 * at load time (see `displayEnv`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';

const win = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Failures

export class CheckFailed extends Error {}
export const fail = (why) => { throw new CheckFailed(why); };

/** A run's result summarised for a failure message, so a FAIL line says what actually came back. */
export function said(r) {
  const clip = (s) => JSON.stringify(s.length > 300 ? `${s.slice(0, 300)}...` : s);
  return `exit ${r.code}${r.signal ? ` signal ${r.signal}` : ''}${r.timedOut ? ' (TIMED OUT)' : ''}, `
    + `stdout ${clip(r.stdout)}, stderr ${clip(r.stderr)}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `cond` until true or `ms` elapse; true when it held. */
export async function until(cond, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

// ---------------------------------------------------------------------------------------------
// Processes

/** Children started as their own process-group leader (`group: true`, POSIX). */
const GROUPED = new WeakSet();

/** True once `pid` no longer exists. `process.kill(pid, 0)` throws ESRCH for a dead process. */
export function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

export function killTree(child) {
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (win) {
    // Not after the root has exited: Windows reuses PIDs, and /T from a reused one would kill a
    // stranger's tree. A caller that must prove no child outlived it checks by other means.
    if (exited) return;
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 30_000 });
  } else if (GROUPED.has(child)) {
    // A detached child leads its own process group: SIGKILL the GROUP, which takes Electron and
    // its zygote/GPU/renderer children along with any launcher. Sent even when the leader has
    // exited, because its children can still be in the group. SIGKILL to a launcher alone could
    // not be forwarded, and would orphan Electron.
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
  } else if (!exited) child.kill('SIGKILL');
}

/** True when no process is left in the process group `pgid` (POSIX). */
export function groupEmpty(pgid) {
  try { process.kill(-pgid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

/**
 * Starts `cmd` with `env` and returns at once: `{ child, stdout, stderr, exited, closed }`, the
 * output fields growing as it runs. `group`: its own process group (POSIX), so `killTree` can
 * take the whole tree. `spawnOptions` is merged into spawn's options (e.g. `shell` on Windows).
 */
export function launch(cmd, args, env, { group = false, spawnOptions = {} } = {}) {
  const detached = group && !win;
  const child = spawn(cmd, args, { windowsHide: true, ...spawnOptions, env, stdio: ['pipe', 'pipe', 'pipe'], detached });
  if (detached) GROUPED.add(child);
  const p = { child, stdout: '', stderr: '', exited: false, error: undefined };
  child.stdout.on('data', (d) => { p.stdout += d; });
  child.stderr.on('data', (d) => { p.stderr += d; });
  child.stdin.on('error', () => {}); // a program that exits before reading stdin is its caller's business
  p.closed = new Promise((resolve) => {
    child.on('error', (err) => { p.error = err; p.exited = true; resolve({ code: null, signal: null }); });
    child.on('close', (code, signal) => { p.exited = true; resolve({ code, signal }); });
  });
  return p;
}

/**
 * Runs `cmd` with `env`, feeding `input`; resolves `{ code, signal, stdout, stderr, timedOut }`.
 * Killed after `timeoutMs`, and then `timedOut` is set: a hung program fails its check, never the run.
 */
export async function run(cmd, args, env, { input = '', timeoutMs = 30_000, group = false, spawnOptions = {} } = {}) {
  const p = launch(cmd, args, env, { group, spawnOptions });
  p.child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(p.child); }, timeoutMs);
  const { code, signal } = await p.closed;
  clearTimeout(timer);
  return { code, signal, stdout: p.stdout, stderr: `${p.stderr}${p.error ? p.error.message : ''}`, timedOut, child: p.child };
}

/** Every descendant of `pid`, from /proc (Linux only) -- read before a kill, checked after it. */
export function descendants(pid) {
  const parent = new Map();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // Field 4 (ppid) comes after the parenthesised comm, which may itself contain spaces.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parent.set(Number(name), ppid);
    } catch { /* gone already */ }
  }
  const out = [];
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.shift();
    for (const [child, pp] of parent) if (pp === p) { out.push(child); queue.push(child); }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Display

/**
 * The display an Electron needs. `DISPLAY` set (a desktop, or CI under `xvfb-run`) is used as it
 * is; so is any non-Linux host. On Linux without one, this dev box's userspace Xvfb from
 * `xvfb.mjs` -- and with it the micromamba GUI libraries and fontconfig, which an installed or
 * packaged Electron needs exactly as the repo's does. Imported lazily: `xvfb.mjs` resolves the
 * repo's own Electron at load time, which a cli/tui/web run has no business touching.
 */
export async function displayEnv(env) {
  if (process.platform !== 'linux' || process.env.DISPLAY) return env;
  const { guiEnv } = await import('../packages/gui/scripts/xvfb.mjs');
  const g = guiEnv();
  const pick = ['DISPLAY', 'LD_LIBRARY_PATH', 'FONTCONFIG_PATH', 'FONTCONFIG_FILE'];
  return { ...env, ...Object.fromEntries(pick.map((k) => [k, g[k]])) };
}

// ---------------------------------------------------------------------------------------------
// The throwaway telnet server

const IAC = 255, DO = 253, WILL = 251, TTYPE = 24;

/**
 * A throwaway server on port 0 that records connections and what each client sent first. Unless
 * `silent`, it opens with `IAC DO TERMINAL-TYPE`, so `willTtype()` -- `IAC WILL TERMINAL-TYPE`
 * came back -- proves a PLAINTEXT telnet client, which a TLS client (sending a ClientHello)
 * cannot fake.
 */
export function startServer({ silent = false } = {}) {
  return new Promise((resolve) => {
    const seen = { connections: 0, bytes: Buffer.alloc(0) };
    const sockets = new Set();
    const server = net.createServer((sock) => {
      seen.connections++;
      sockets.add(sock);
      sock.on('data', (b) => { seen.bytes = Buffer.concat([seen.bytes, b]); });
      sock.on('error', () => {});
      sock.on('close', () => { sockets.delete(sock); });
      if (!silent) sock.write(Buffer.from([IAC, DO, TTYPE]));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        willTtype: () => seen.bytes.includes(Buffer.from([IAC, WILL, TTYPE])),
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}
