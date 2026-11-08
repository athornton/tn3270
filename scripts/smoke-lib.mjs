/**
 * Helpers shared by the smoke scripts (`install-smoke.mjs`, `package-smoke.mjs`) and the GUI
 * harness `packages/gui/scripts/connect.mjs`: bounded spawns that kill their whole process tree,
 * failure reporting, the display an Electron needs, the throwaway telnet server whose reply is the
 * oracle for "the client connected in plaintext", and a fake host that reaches 3270 mode.
 *
 * Moved here, not copied, so the two smoke scripts share one copy of the kill and display rules.
 * NOT YET connect.mjs: it imports `descendants`, `sleep`, `startHost`, `startServer` and `until`
 * from here but keeps its own `alive`/`launch`/`kill` (repo Electron via `guiEnv`, no Windows
 * path), so those can still drift from `gone`/`launch`/`killTree` below. Nothing in this module resolves Electron
 * at load time (see `displayEnv`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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
  return { ...env, ...Object.fromEntries(pick.filter((k) => g[k] !== undefined).map((k) => [k, g[k]])) };
}

// ---------------------------------------------------------------------------------------------
// The throwaway telnet servers

const IAC = 255, DO = 253, WILL = 251, TTYPE = 24;
const SB = 250, SE = 240, EOR = 239, BINARY = 0, OPT_EOR = 25;

/**
 * The core both servers share: listen on 127.0.0.1 port 0, count connections, append every byte
 * any client sends to `seen.bytes`, and close by destroying every open socket. `onConnect(sock)`
 * runs once per connection and may return a per-chunk handler, called AFTER the chunk is appended.
 */
function listen(onConnect) {
  return new Promise((resolve) => {
    const seen = { connections: 0, bytes: Buffer.alloc(0) };
    const sockets = new Set();
    const server = net.createServer((sock) => {
      seen.connections++;
      sockets.add(sock);
      const onData = onConnect(sock);
      sock.on('data', (b) => {
        seen.bytes = Buffer.concat([seen.bytes, b]);
        onData?.(b);
      });
      sock.on('error', () => {});
      sock.on('close', () => { sockets.delete(sock); });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

/**
 * A throwaway server on port 0 that records connections and what each client sent first. Unless
 * `silent`, it opens with `IAC DO TERMINAL-TYPE`, so `willTtype()` -- `IAC WILL TERMINAL-TYPE`
 * came back -- proves a PLAINTEXT telnet client, which a TLS client (sending a ClientHello)
 * cannot fake.
 */
export async function startServer({ silent = false } = {}) {
  const srv = await listen((sock) => {
    if (!silent) sock.write(Buffer.from([IAC, DO, TTYPE]));
  });
  const { seen } = srv;
  return { ...srv, willTtype: () => seen.bytes.includes(Buffer.from([IAC, WILL, TTYPE])) };
}

/**
 * A fake host that goes all the way into 3270 mode, for a harness that has to TYPE: `startServer`
 * stops at `IAC DO TERMINAL-TYPE`, so a client connected to it has no screen and a locked keyboard.
 *
 * PORTED FROM `packages/tui/scripts/pty-smoke.py`'s `FakeHost`, the repo's one existing fake host
 * that reaches 3270 mode, with the same negotiation: `IAC DO TERMINAL-TYPE`; TERMINAL-TYPE SEND
 * once the client says WILL; once its `IS` arrives, EOR and BINARY both ways and, 300 ms later --
 * pty-smoke.py's `time.sleep(0.3)`, kept so the two hosts behave alike: it lets the client's
 * replies to that negotiation land before the screen does -- one Erase/Write, its screen less the
 * red field: a protected `HELLO TN3270` and an unprotected field on row 3 with the cursor in it
 * (the IC -- without it the cursor sits in the protected field and every keystroke is refused).
 *
 * Both triggers are matched on the connection's ACCUMULATED inbound bytes and fire once each, so
 * a reply split across TCP chunks is still seen and a repeated one is not answered twice.
 *
 * `records()` is the ORACLE: the most recent connection's inbound 3270 records after its screen
 * went out (see `inboundRecords`). One client per host is the intended use.
 */
export async function startHost() {
  let last;
  const srv = await listen((sock) => {
    const conn = { bytes: Buffer.alloc(0), ttypeSent: false, screenAt: -1 };
    last = conn;
    sock.write(Buffer.from([IAC, DO, TTYPE]));
    return (b) => {
      conn.bytes = Buffer.concat([conn.bytes, b]);
      if (!conn.ttypeSent && conn.bytes.includes(Buffer.from([IAC, WILL, TTYPE]))) {
        conn.ttypeSent = true;
        sock.write(Buffer.from([IAC, SB, TTYPE, 1, IAC, SE]));   // SEND
      }
      if (conn.screenAt < 0 && conn.bytes.includes(Buffer.from([IAC, SB, TTYPE, 0]))) {   // IS
        conn.screenAt = conn.bytes.length;
        sock.write(Buffer.from([
          IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR, IAC, DO, BINARY, IAC, WILL, BINARY,
        ]));
        setTimeout(() => { if (!sock.destroyed) sock.write(HOST_SCREEN); }, 300);
      }
    };
  });
  return {
    ...srv,
    records: () => (last === undefined || last.screenAt < 0
      ? []
      : inboundRecords(last.bytes.subarray(last.screenAt))),
  };
}

/** cp037 for `HELLO TN3270`: the letter runs are NOT contiguous (A-I C1, J-R D1, S-Z E2). */
const HELLO_EBCDIC = {
  H: 0xC8, E: 0xC5, L: 0xD3, O: 0xD6, ' ': 0x40, T: 0xE3, N: 0xD5, 2: 0xF2, 3: 0xF3, 7: 0xF7, 0: 0xF0,
};
/** The 12-bit buffer address, the 3270 manual's 64-entry table. */
const ADDR = [
  0x40, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F,
  0x50, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F,
  0x60, 0x61, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F,
  0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F,
];
const addr12 = (a) => [ADDR[(a >> 6) & 0x3F], ADDR[a & 0x3F]];
const HOST_SCREEN = Buffer.from([
  // Erase/Write; WCC 0xC3 = reset + restore keyboard + reset MDT (0xC0 is the graphic encoding).
  0xF5, 0xC3,
  // SBA row 1, SF protected, the text.
  0x11, ...addr12(0), 0x1D, 0xF0, ...[...'HELLO TN3270'].map((c) => HELLO_EBCDIC[c]),
  // SBA row 3, SF unprotected, IC.
  0x11, ...addr12(160), 0x1D, 0x40, 0x13,
  IAC, EOR,
]);

/**
 * The 3270 records in a client's inbound bytes, telnet stripped: `IAC WILL/WONT/DO/DONT x` and
 * `IAC SB ... IAC SE` dropped, `IAC IAC` is one 0xFF data byte, `IAC EOR` ends a record. Written
 * here from RFC 854/885, NOT shared with the client's telnet code, because it is what judges that
 * code: a parser imported from the client would agree with the client's bugs.
 */
function inboundRecords(b) {
  const out = [];
  let rec = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] !== IAC) { rec.push(b[i]); continue; }
    const cmd = b[i + 1];
    if (cmd === IAC) {
      rec.push(IAC);
      i++;
    } else if (cmd === EOR) {
      out.push(Buffer.from(rec));
      rec = [];
      i++;
    } else if (cmd === SB) {
      while (i < b.length && !(b[i] === IAC && b[i + 1] === SE)) i++;
      i++;
    } else {
      i += cmd >= WILL ? 2 : 1;   // WILL/WONT/DO/DONT carry an option byte
    }
  }
  return out;
}

/**
 * Chromium switches every smoke GUI launch passes, so a capture is comparable on any display.
 *
 * KEPT, BUT NOT SUFFICIENT ON macOS. They make Linux and Windows captures independent of the
 * display. MEASURED, CI run 4 (2026-11-06): on macos-26-intel neither had any effect -- the
 * capture was byte-identical to run 3's without them (1440x700, greens shifted). Chromium on macOS
 * takes the backing scale factor from the screen. So `judgeShot` also accepts an exact integer
 * upscale of the golden with a consistent colour remap; see there.
 */
export const CAPTURE_SWITCHES = Object.freeze(['--force-device-scale-factor=1', '--force-color-profile=srgb']);

/** A PNG decoded to `{ width, height, px }`, `px[y][x]` an `r,g,b` string. 8-bit RGB/RGBA only. */
export function decodePng(path) {
  const b = readFileSync(path);
  if (b.length < 29 || b.readUInt32BE(12) !== 0x49484452) fail(`${path} is not a PNG (no IHDR)`);
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  const bpp = { 2: 3, 6: 4 }[b[25]];
  if (b[24] !== 8 || bpp === undefined || b[28] !== 0) {
    fail(`${path}: PNG depth ${b[24]}, colour type ${b[25]}, interlace ${b[28]} -- only 8-bit RGB/RGBA, not interlaced`);
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
  const px = [];
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
        const q = a + up - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (f !== 0) fail(`${path}: PNG row ${y} has filter type ${f}`);
      line[i] = (line[i] + add) & 0xff;
    }
    const row = [];
    for (let x = 0; x < width; x++) row.push(`${line[x * bpp]},${line[x * bpp + 1]},${line[x * bpp + 2]}`);
    px.push(row);
    prev = line;
  }
  return { width, height, px };
}

/** Largest per-channel difference between two `r,g,b` strings. */
const channelGap = (p, q) => {
  const a = p.split(',').map(Number), b = q.split(',').map(Number);
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
};

/**
 * Whether `shot` is the golden drawn at an integer scale `k` through a colour remap: returns a
 * description, or fails naming the first rule broken.
 *
 * THE RULES, each derived from what the macos-26-intel capture actually was (CI runs 3 and 4):
 *  - size is exactly k times the golden's on both axes, k an integer >= 2;
 *  - at least 99.9% of k-by-k blocks are a single colour (9 of 252000 were not: a few edge pixels);
 *  - every golden colour maps to ONE capture colour across all its uniform blocks, the mapping is
 *    one-to-one, and no channel moves more than 16 (measured: at most 7, 36,216,48 -> 43,215,51).
 * Together these say every glyph pixel landed exactly where the golden has it, and only the
 * display's colour profile touched the values. A wrong screen, a missing glyph or a blurred
 * (filtered) upscale each break one of them.
 */
export function scaledMatch(shot, goldenPng) {
  const g = decodePng(goldenPng);
  const m = decodePng(shot);
  const k = m.width / g.width;
  if (!Number.isInteger(k) || k < 2 || m.height !== g.height * k) {
    fail(`capture ${m.width}x${m.height} is not an integer upscale of the golden's ${g.width}x${g.height}`);
  }
  const map = new Map();
  let mixed = 0;
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const first = m.px[y * k][x * k];
      let uniform = true;
      for (let dy = 0; dy < k && uniform; dy++) {
        for (let dx = 0; dx < k; dx++) if (m.px[y * k + dy][x * k + dx] !== first) { uniform = false; break; }
      }
      if (!uniform) { mixed += 1; continue; }
      const want = g.px[y][x];
      const seen = map.get(want);
      if (seen === undefined) map.set(want, first);
      else if (seen !== first) fail(`golden colour ${want} became both ${seen} and ${first} (block ${x},${y})`);
    }
  }
  const blocks = g.width * g.height;
  if (mixed > blocks / 1000) fail(`${mixed} of ${blocks} ${k}x${k} blocks are not one colour: not a clean upscale`);
  const targets = [...map.values()];
  if (new Set(targets).size !== targets.length) fail(`two golden colours map to one capture colour: ${[...map].join(' ')}`);
  for (const [from, to] of map) {
    if (channelGap(from, to) > 16) fail(`golden colour ${from} became ${to}: more than a colour-profile shift`);
  }
  const shifts = [...map].filter(([a, b]) => a !== b).map(([a, b]) => `${a}->${b}`);
  return `golden at ${k}x (${mixed} mixed blocks of ${blocks}${shifts.length > 0 ? `; colour profile ${shifts.join(' ')}` : ''})`;
}

/** A PNG's IHDR size, for failure messages. */
function pngSize(path) {
  const b = readFileSync(path);
  return b.length >= 24 && b.readUInt32BE(12) === 0x49484452 ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : 'not a PNG';
}

/**
 * Judges a capture against the synthetic-ispf golden: returns '' or a note, or fails.
 *
 * ONE RULE FOR BOTH SMOKES (install-smoke's gui check and package-smoke's check 1). The hash must
 * match -- which it did on Linux x64 and arm64, macOS arm64 and Windows (CI runs 2-4) -- unless
 * the capture passes `scaledMatch`: the golden at an exact integer scale with a consistent colour
 * remap, which is what a Retina display with a colour profile produces (macos-26-intel) and which
 * CAPTURE_SWITCHES cannot prevent there. That note says so in the ok line. Under CI any
 * non-identical capture is copied into `artifacts/smoke-shots/` for upload.
 */
export function judgeShot({ got, want, shot, goldenPng }) {
  if (got === want) return '';
  let copied = '';
  if (process.env.CI === 'true') {
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'smoke-shots');
    mkdirSync(out, { recursive: true });
    const name = `${process.platform}-${process.arch}-${Date.now()}-${basename(shot)}`;
    copyFileSync(shot, join(out, name));
    copied = `; copied to artifacts/smoke-shots/${name}`;
  }
  try {
    return ` (${scaledMatch(shot, goldenPng)}${copied})`;
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    return fail(`pixels differ from the synthetic-ispf golden: got ${got} (${pngSize(shot)}), want ${want} (${pngSize(goldenPng)}); not a scaled match either: ${e.message} -- capture ${shot}${copied}`);
  }
}
