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
import { descendants, sleep, startHost, startServer, until } from '../../../scripts/smoke-lib.mjs';
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

/**
 * `HANDSHAKE_TIMEOUT_MS` in packages/frontend/src/tls.ts is 10 s, and TWO cases wait past it: the
 * TLS remedy case, and the retry case's first (TLS) attempt.
 */
const HANDSHAKE_BOUND_MS = 20_000;

/** A port with nothing listening: bound, read, released. */
async function deadPort() {
  const s = await startServer();
  await s.close();
  return s.port;
}

/** Every run the current case launched, so the loop below kills them even if the case throws. */
let launched = [];

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
  // On `close`, not `exit`: `exit` can fire before the last stdout chunk is read, and a wait that
  // ends on `|| r.exited` must not end before the line it is waiting for has arrived.
  child.on('close', () => { run.exited = true; });
  launched.push(run);
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
      await until(() => /connect: dialog (still open|closed)/.test(r.stdout) || r.exited, 2_000);
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
      // NOT silent: it opens with IAC DO TERMINAL-TYPE, which the second (plaintext) attempt
      // answers. The first (TLS) attempt does not refuse those three bytes -- they are shorter than
      // a TLS record header, so it waits for more and fails by the handshake TIMEOUT (measured:
      // "never completed a TLS handshake"), which is why this case waits past HANDSHAKE_BOUND_MS.
      const srv = await startServer();
      const host = `127.0.0.1:${srv.port}`;
      const r = launch([
        { host, model: '3278-2-E', tls: true },
        { host, model: '3278-2-E', tls: false },
      ]);
      const ended = /connect: (dialog closed|dialog still open|submit never settled)/;
      await until(() => ended.test(r.stdout) || r.exited, HANDSHAKE_BOUND_MS + 15_000);
      await until(() => srv.willTtype(), 5_000);
      const lines = r.stdout.split('\n');
      const checks = [
        ['two presses', lines.filter((l) => l === 'connect: submitted').length === 2],
        ['the first said to untick TLS',
          lines.some((l) => l.startsWith('connect: error Untick TLS in the Connect dialog'))],
        ['the dialog closed after the second', r.stdout.includes('connect: dialog closed')],
        ['the second was PLAINTEXT telnet (IAC WILL TERMINAL-TYPE came back)', srv.willTtype()],
        ['two connections at the server, one per press', srv.seen.connections === 2],
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
      await until(() => /connect: dialog (still open|closed)/.test(r.stdout) || r.exited, 2_000);
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
     *
     * THE SECOND `Alt+M` IS A THROWAWAY. A keys-only run quits as soon as `keys: sent` is out
     * (`quitIfKeysOnly`), and on a slow runner that quit could beat the last chord's IPC; the
     * extra chord puts 150 ms between the counted one and the quit, and the wait below gives the
     * line itself time to arrive.
     */
    name: 'a dialog connect goes live: keys reach the host, the menu is installed',
    async run() {
      const srv = await startHost();
      const r = launch({ host: `127.0.0.1:${srv.port}`, model: '3278-2-E', tls: false }, [], {
        TN3270_GUI_KEYS: 'wait:HELLO TN3270,h,i,Enter,Alt+M,Alt+M',
        TN3270_GUI_WAIT_MS: '10000',
      });
      const enter = () => srv.records().find((rec) => rec[0] === 0x7D);
      const popped = () => r.stdout.split('\n').includes('menu: popup model');
      await until(() => r.stdout.includes('keys: sent ') || r.exited, 30_000);
      await until(() => enter() !== undefined || r.exited, 2_000);
      await until(() => popped() || r.exited, 2_000);
      const rec = enter();
      const checks = [
        ['connect: dialog closed', r.stdout.includes('connect: dialog closed')],
        ['the keys seam waited for the screen and sent every key',
          r.stdout.includes('keys: saw "HELLO TN3270"') && r.stdout.includes('keys: sent ')],
        ['the host got an AID Enter (0x7D) record', rec !== undefined],
        ['carrying the typed "hi" (0x88 0x89)',
          rec !== undefined && rec.includes(Buffer.from([0x88, 0x89]))],
        ['the Model menu popped up (menu: popup model)', popped()],
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
  launched = [];
  let r = { stdout: '', stderr: '' };
  let srv;
  let checks;
  const survivors = [];
  // A throw after `launch()` must still kill by PID: `finally`, over every run the case launched.
  try {
    ({ r, srv, checks } = await kase.run());
  } catch (err) {
    checks = [[`the case threw: ${err?.stack ?? err}`, false]];
    if (launched.length > 0) r = launched[launched.length - 1];
  } finally {
    for (const run of launched) survivors.push(...await kill(run));
    await srv?.close();
  }
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
