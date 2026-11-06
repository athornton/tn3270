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

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** One client launch. `form` goes to TN3270_GUI_CONNECT; `extra` is appended to argv. */
function launch(form, extra = []) {
  const child = spawn(electron, [main, ...ARGV, ...extra], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: guiEnv({
      TN3270_GUI_CONNECT: JSON.stringify(form),
      // Cleared, not merely unset by us: this env is inherited, and a stray seam in the caller's
      // shell would replay, type, click or photograph instead of connecting (shot.mjs's trap).
      TN3270_GUI_REPLAY: '', TN3270_GUI_SHOT: '', TN3270_GUI_KEYS: '', TN3270_GUI_CLICKS: '',
      TN3270_GUI_SELECT: '', TN3270_GUI_TRANSFER: '', TN3270_GUI_URL: '',
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
      const checks = [
        ['the server saw a connection', srv.seen.connections > 0],
        [`stderr says "${want}"`, r.stderr.includes(want)],
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
      const checks = [
        [`stderr says "${want}"`, r.stderr.includes(want)],
        ['stderr does not say TLS', r.stderr !== '' && !r.stderr.includes('TLS')],
      ];
      return { r, checks };
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
