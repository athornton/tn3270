/**
 * The startup Connect dialog, under Xvfb: the window a double-clicked app opens when it has no host.
 *
 * Nothing in vitest reaches it. `connectDialog.test.ts` and `connectForm.test.ts` pin the decision
 * and the form-to-argv step, but the window, `connect.html`, `connectBoot.ts`, the preload, the two
 * `connect:` IPC handlers and the hand-off to `startSession` only run in a real Electron. This
 * drives them through `TN3270_GUI_CONNECT`, which fills the form THROUGH THE DOM and presses the
 * page's own Connect button (see `SEAM.connect` in main.ts).
 *
 * ## EACH CASE GETS ITS OWN THROWAWAY SERVER, AND THE SERVER IS THE ORACLE
 *
 * A fresh `net.createServer` on port 0 per case, recording every connection and the first bytes the
 * client sent. A TCP connection alone does NOT prove the form's TLS choice was honoured -- a TLS
 * client connects too, then sends a ClientHello. So the server opens with `IAC DO TERMINAL-TYPE`
 * and the plaintext cases pass only on `IAC WILL TERMINAL-TYPE` coming back, which a TLS client
 * cannot send. MEASURED: with main.ts made to ignore the checkbox (always TLS), case 1 fails on
 * exactly that check and on no other.
 *
 * ## KILLED BY PID, NEVER BY NAME
 *
 * The client never exits on its own here -- a connected session or an open dialog just sits -- so
 * every case ends with a SIGKILL to the PROCESS GROUP this harness made for it (`detached: true`),
 * after recording the whole descendant tree from /proc. Then it asserts every one of those PIDs is
 * gone. `pkill -f electron` would kill other people's sessions on a shared box (memory note
 * *electron-harness-leaks-look-like-regressions*).
 *
 *     node packages/gui/scripts/connect.mjs
 *     TN3270_GUI_MAIN=app node packages/gui/scripts/connect.mjs     # against the bundle
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { descendants, sleep, startServer, until } from '../../../scripts/smoke-lib.mjs';
import { electron, guiEnv, guiMain, guiMainLabel, staleness } from './xvfb.mjs';

const main = guiMain();
console.log(`entry: ${guiMainLabel()}`);

/** dist/ or app/ is what runs and nothing here builds either; see keys.mjs for the argument. */
{
  const problem = staleness(main, ['gui', 'frontend', 'canvas']);
  if (problem !== undefined) {
    console.log(`FAIL ${problem.why}`);
    console.log(`     ${problem.fix}`);
    process.exit(1);
  }
}

/**
 * Electron's switches only: NO host and NO `-insecure`, because a launch with no host is what opens
 * the dialog, and the TLS choice is the FORM's. The command-line case adds both itself.
 */
const ARGV = ['--no-sandbox', '--disable-gpu'];

/** `HANDSHAKE_TIMEOUT_MS` in packages/frontend/src/tls.ts is 10 s; the TLS case waits past it. */
const HANDSHAKE_BOUND_MS = 20_000;

/** A port with nothing listening: bound, read, released. */
async function deadPort() {
  const s = await startServer();
  await s.close();
  return s.port;
}

/**
 * A fake host that goes all the way into 3270 mode, for the case that has to TYPE: `startServer`
 * stops at `IAC DO TERMINAL-TYPE`, so a client connected to it has no screen and a locked keyboard.
 *
 * PORTED FROM `packages/tui/scripts/pty-smoke.py`'s `FakeHost`, the repo's one existing fake host
 * that reaches 3270 mode, with the same negotiation: TERMINAL-TYPE SEND on WILL, then EOR and
 * BINARY both ways, then one Erase/Write -- its screen less the red field: a protected
 * `HELLO TN3270` and an unprotected field on row 3 with the cursor in it (the IC -- without it the
 * cursor sits in the protected field and every keystroke is refused). Its `records()` are the client's inbound 3270 records after the
 * screen went out, split on `IAC EOR`.
 */
const IAC = 255, SB = 250, SE = 240, WILL = 251, DO = 253, EOR = 239;
const BINARY = 0, TTYPE = 24, OPT_EOR = 25;
/** cp037 for `HELLO TN3270`: the letter runs are NOT contiguous (A-I C1, J-R D1, S-Z E2). */
const EBCDIC = { H: 0xC8, E: 0xC5, L: 0xD3, O: 0xD6, ' ': 0x40, T: 0xE3, N: 0xD5, 2: 0xF2, 3: 0xF3, 7: 0xF7, 0: 0xF0 };
const ebcdic = (text) => [...text].map((c) => EBCDIC[c]);
/** The 12-bit buffer address, the 3270 manual's 64-entry table. */
const ADDR = [
  0x40, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F,
  0x50, 0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F,
  0x60, 0x61, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F,
  0xF0, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8, 0xF9, 0x7A, 0x7B, 0x7C, 0x7D, 0x7E, 0x7F,
];
const addr12 = (a) => [ADDR[(a >> 6) & 0x3F], ADDR[a & 0x3F]];
const SCREEN = Buffer.from([
  0xF5, 0xC3,                              // Erase/Write, WCC = reset + restore keyboard
  0x11, ...addr12(0), 0x1D, 0xF0, ...ebcdic('HELLO TN3270'),   // SBA row 1, SF protected
  0x11, ...addr12(160), 0x1D, 0x40, 0x13,  // SBA row 3, SF unprotected, IC
  IAC, EOR,
]);

function startHost() {
  return new Promise((resolve) => {
    const seen = { connections: 0, inbound: Buffer.alloc(0), screenAt: -1 };
    const sockets = new Set();
    const server = net.createServer((sock) => {
      seen.connections++;
      sockets.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => { sockets.delete(sock); });
      sock.on('data', (b) => {
        seen.inbound = Buffer.concat([seen.inbound, b]);
        if (b.includes(Buffer.from([IAC, WILL, TTYPE]))) sock.write(Buffer.from([IAC, SB, TTYPE, 1, IAC, SE]));
        if (seen.screenAt < 0 && seen.inbound.includes(Buffer.from([IAC, SB, TTYPE, 0]))) {
          seen.screenAt = seen.inbound.length;
          sock.write(Buffer.from([IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR, IAC, DO, BINARY, IAC, WILL, BINARY]));
          setTimeout(() => { if (!sock.destroyed) sock.write(SCREEN); }, 300);
        }
      });
      sock.write(Buffer.from([IAC, DO, TTYPE]));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        seen,
        /**
         * The client's 3270 records after the screen went out, telnet commands stripped:
         * `IAC WILL/WONT/DO/DONT x` and `IAC SB ... IAC SE` dropped, `IAC IAC` is 0xFF data,
         * `IAC EOR` ends a record.
         */
        records: () => {
          if (seen.screenAt < 0) return [];
          const b = seen.inbound.subarray(seen.screenAt);
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
        },
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * One client launch. `form` -- one form or a list of them -- goes to TN3270_GUI_CONNECT; `extra` is
 * appended to argv; `seams` overrides the cleared seams below, one at a time, for the case that
 * needs one.
 */
function launch(form, extra = [], seams = {}) {
  const child = spawn(electron, [main, ...ARGV, ...extra], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({
      TN3270_GUI_CONNECT: JSON.stringify(form),
      // Cleared, not merely unset by us: this env is inherited, and a stray seam in the caller's
      // shell would replay, type, click or photograph instead of connecting (shot.mjs's trap).
      TN3270_GUI_REPLAY: '', TN3270_GUI_SHOT: '', TN3270_GUI_KEYS: '', TN3270_GUI_CLICKS: '',
      TN3270_GUI_SELECT: '', TN3270_GUI_TRANSFER: '', TN3270_GUI_URL: '',
      ...seams,
    }),
  });
  const run = { child, stdout: '', stderr: '', exited: false };
  child.stdout.on('data', (b) => { run.stdout += b; });
  child.stderr.on('data', (b) => { run.stderr += b; });
  child.on('exit', () => { run.exited = true; });
  return run;
}

/** Kills the whole tree by PID and reports any survivor. */
async function kill(run) {
  const tree = [run.child.pid, ...descendants(run.child.pid)];
  try { process.kill(-run.child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await until(() => tree.every((p) => !alive(p)), 5000);
  return tree.filter(alive);
}

/**
 * A failed press's two dialog checks: the dialog is STILL OPEN (the driver's last line), and its
 * error line -- as `driveConnectDialog` reads it from the DOM -- carries the stderr text. stderr
 * alone was written before the retry too, so it proves nothing about the dialog.
 */
const dialogKept = (r, want) => [
  ['the dialog is STILL OPEN', r.stdout.includes('connect: dialog still open')],
  [`the dialog's error line says "${want}"`,
    r.stdout.split('\n').some((l) => l.startsWith('connect: error') && l.includes(want))],
];

const CASES = [
  {
    name: 'connects',
    async run() {
      const srv = await startServer();
      const r = launch({ host: `127.0.0.1:${srv.port}`, model: '3278-2-E', tls: false });
      // 5 s from the SUBMIT, not from the launch: Electron's cold start is not the dialog's latency.
      await until(() => r.stdout.includes('connect: submitted\n') || r.exited, 15_000);
      const connected = await until(() => srv.seen.connections > 0, 5_000);
      await until(() => srv.willTtype(), 5_000);
      const checks = [
        ['connect: dialog shown', r.stdout.includes('connect: dialog shown\n')],
        ['connect: submitted', r.stdout.includes('connect: submitted\n')],
        ['the server saw a connection within 5 s of the submit', connected],
        ['it was PLAINTEXT telnet (IAC WILL TERMINAL-TYPE came back)', srv.willTtype()],
      ];
      return { r, srv, checks };
    },
  },
  {
    name: 'bad host stays open',
    async run() {
      const srv = await startServer();
      const r = launch({ host: '', model: '3278-2-E', tls: false });
      await until(() => r.stdout.includes('connect: error') || r.exited, 15_000);
      await sleep(1000);
      const line = r.stdout.split('\n').find((l) => l.startsWith('connect: error')) ?? '';
      const checks = [
        ['connect: error names the usage', line.includes('usage: tn3270-gui')],
        ['still alive 1 s later', !r.exited && alive(r.child.pid)],
        ['the server saw no connection', srv.seen.connections === 0],
      ];
      return { r, srv, checks };
    },
  },
  {
    name: 'TLS remedy names the checkbox',
    async run() {
      const srv = await startServer({ silent: true });
      const r = launch({ host: `127.0.0.1:${srv.port}`, model: '3278-2-E', tls: true });
      const want = 'Untick TLS in the Connect dialog';
      await until(() => r.stderr.includes(want), HANDSHAKE_BOUND_MS);
      await until(() => /connect: dialog (still open|closed)/.test(r.stdout), 2_000);
      const checks = [
        ['the server saw a connection', srv.seen.connections > 0],
        [`stderr says "${want}"`, r.stderr.includes(want)],
        ...dialogKept(r, want),
      ];
      return { r, srv, checks };
    },
  },
  {
    name: 'retry with TLS unticked connects, on the same run',
    async run() {
      // NOT silent: it opens with IAC DO TERMINAL-TYPE, which the first (TLS) attempt reads as a
      // TLS record and refuses -- and which the second (plaintext) attempt answers.
      const srv = await startServer();
      const host = `127.0.0.1:${srv.port}`;
      const r = launch([
        { host, model: '3278-2-E', tls: true },
        { host, model: '3278-2-E', tls: false },
      ]);
      await until(() => r.stdout.includes('connect: dialog closed') || r.stdout.includes('connect: dialog still open')
        || r.stdout.includes('connect: submit never settled') || r.exited, HANDSHAKE_BOUND_MS + 15_000);
      await until(() => srv.willTtype(), 5_000);
      const lines = r.stdout.split('\n');
      const checks = [
        ['two presses', lines.filter((l) => l === 'connect: submitted').length === 2],
        ['the first said to untick TLS',
          lines.some((l) => l.startsWith('connect: error Untick TLS in the Connect dialog'))],
        ['the dialog closed after the second', r.stdout.includes('connect: dialog closed')],
        ['the second was PLAINTEXT telnet (IAC WILL TERMINAL-TYPE came back)', srv.willTtype()],
      ];
      return { r, srv, checks };
    },
  },
  {
    name: 'refused connect is not called TLS',
    async run() {
      const port = await deadPort();
      const r = launch({ host: `127.0.0.1:${port}`, model: '3278-2-E', tls: false });
      const want = `cannot connect to 127.0.0.1:${port}: connection refused (ECONNREFUSED)`;
      await until(() => r.stderr.includes(want), 15_000);
      await until(() => /connect: dialog (still open|closed)/.test(r.stdout), 2_000);
      const checks = [
        [`stderr says "${want}"`, r.stderr.includes(want)],
        ['stderr does not say TLS', r.stderr !== '' && !r.stderr.includes('TLS')],
        ...dialogKept(r, want),
      ];
      return { r, checks };
    },
  },
  {
    /**
     * AFTER A DIALOG CONNECT THE SESSION IS LIVE -- both halves of `goLive`, which in dialog mode
     * runs at the start of `afterConnect` and nowhere else. Without it every key is dropped at the
     * `action` gate and the app menu is never installed, and no other case here would notice: they
     * all stop at the connect.
     *
     * (a) THE GATE: `TN3270_GUI_KEYS` types `hi` and Enter into the fake host's unprotected field,
     *     and the HOST is the oracle -- an inbound record with AID Enter (0x7D) carrying `hi`
     *     (cp037 0x88 0x89). (b) THE MENU: `Alt+M` pops the Model submenu, which `main.ts` finds
     *     through `Menu.getApplicationMenu()` -- before `goLive` that is Electron's default menu,
     *     with no `model` item -- and reports as `menu: popup model`, the line `keys.mjs` counts.
     *     `Alt+M` is intercepted in main past the same gate, so it is sent after Enter has locked
     *     the keyboard without being refused.
     */
    name: 'a dialog connect goes live: keys reach the host, the menu is installed',
    async run() {
      const srv = await startHost();
      const r = launch({ host: `127.0.0.1:${srv.port}`, model: '3278-2-E', tls: false }, [],
        { TN3270_GUI_KEYS: 'wait:HELLO TN3270,h,i,Enter,Alt+M', TN3270_GUI_WAIT_MS: '10000' });
      const enter = () => srv.records().find((rec) => rec[0] === 0x7D);
      await until(() => r.stdout.includes('keys: sent ') || r.exited, 30_000);
      await until(() => enter() !== undefined, 2_000);
      const rec = enter();
      const checks = [
        ['connect: dialog closed', r.stdout.includes('connect: dialog closed')],
        ['the keys seam waited for the screen and sent every key',
          r.stdout.includes('keys: saw "HELLO TN3270"') && r.stdout.includes('keys: sent ')],
        ['the host got an AID Enter (0x7D) record', rec !== undefined],
        ['carrying the typed "hi" (0x88 0x89)', rec !== undefined && rec.includes(Buffer.from([0x88, 0x89]))],
        ['the Model menu popped up (menu: popup model)', r.stdout.split('\n').includes('menu: popup model')],
      ];
      return { r, srv, checks };
    },
  },
  {
    name: 'a host on the command line skips the dialog',
    async run() {
      const srv = await startServer();
      const r = launch({ host: '127.0.0.1:1', model: '3278-2-E', tls: false },
        ['-insecure', `127.0.0.1:${srv.port}`]);
      await until(() => srv.willTtype(), 15_000);
      const checks = [
        ['the server saw a plaintext telnet connection', srv.willTtype()],
        // Not vacuous on an empty run: the check above needs a client that ran far enough to talk.
        ['no connect: dialog shown', !r.stdout.includes('connect: dialog shown')],
      ];
      return { r, srv, checks };
    },
  },
];

let passed = 0;
for (const kase of CASES) {
  const { r, srv, checks } = await kase.run();
  const survivors = await kill(r);
  await srv?.close();
  checks.push(['no process survived the kill', survivors.length === 0]);
  const failed = checks.filter(([, ok]) => !ok);
  if (failed.length === 0) {
    passed++;
    console.log(`ok       ${kase.name}`);
  } else {
    console.log(`FAIL     ${kase.name}`);
    for (const [what] of failed) console.log(`         ${what}`);
    if (survivors.length > 0) console.log(`         survivors: ${survivors.join(' ')}`);
    for (const l of r.stdout.split('\n').filter((x) => x.startsWith('connect'))) console.log(`         stdout| ${l}`);
    for (const l of r.stderr.split('\n').filter((x) => x !== '').slice(-6)) console.log(`         stderr| ${l}`);
  }
}

console.log(`\n${passed}/${CASES.length}`);
process.exit(passed === CASES.length ? 0 : 1);
