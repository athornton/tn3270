/**
 * Chord guard for the WEB gateway, under Xvfb: does a real Alt+1 still reach the host as PA1
 * after crossing a WebSocket?
 *
 * ## WHAT THIS PROVES THAT NOTHING IN `npm test` CAN
 *
 * Every test in `packages/web` runs under vitest with no DOM: `bridgecore.test.ts` injects a fake
 * socket, and `integration.test.ts` speaks the protocol directly. So the entire browser half of the
 * gateway -- the SERVED `bridge.js`, the real `WebSocket`, `DecompressionStream`, and the
 * renderer's own `keydown` listener -- has no coverage there at all. This is the only thing that
 * runs it.
 *
 * It is the same argument as `packages/gui/scripts/keys.mjs`, one transport further along: that
 * harness proves the renderer/IPC/`ipcMain` path, this one proves the renderer/WebSocket/gateway
 * path. Breaking the MAPPING is caught by `keys.test.ts` in either case, because that calls
 * `actionForKey` directly. What only these harnesses catch is the PLUMBING.
 *
 * ## WHY THE OBSERVABLE IS THE SERVER'S LOG
 *
 * Replay mode is not connected, so `sendAID` throws 'not connected' and `applyAction` swallows it:
 * a PA key has NO other observable consequence, and pixels would pin an absence. The GATEWAY logs
 * each action it applies, gated behind `--log-actions`, which `parseWebArgs` refuses without
 * `--replay` -- a `type` action carries typed text, and a gateway's stdout is routinely a log file.
 *
 * Not in `npm test`; run it by hand, like `keys.mjs`, `shot.mjs` and `pty-smoke.py`:
 *
 *     node packages/web/scripts/browser-keys.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiEnv } from '../../gui/scripts/xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const guiMain = join(repo, 'packages', 'gui', 'dist', 'main.js');
const webMain = join(repo, 'packages', 'web', 'dist', 'main.js');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

/**
 * The GATEWAY's argv, as one constant so the guard test has a single thing to pin.
 *
 * `--replay` is doing two jobs: it makes the run hostless, and it is what permits `--log-actions`
 * at all. `--listen 0` takes an ephemeral port so a stale listener from a previous run cannot make
 * this one silently test the wrong server.
 */
const SERVER_ARGV = ['--replay', trace, '--listen', '0', '--log-actions', '127.0.0.1:3270'];

/**
 * Electron's argv. `--no-sandbox --disable-gpu` are both REQUIRED on this box: there is no GL at
 * all, and without `--disable-gpu` a window HANGS rather than failing.
 *
 * No host argument and no `-insecure`, unlike `keys.mjs`: the URL seam creates no `Session`, so
 * this shell cannot dial anything and has no TLS decision to make.
 *
 * `--no-proxy-server` IS MANDATORY ON THIS BOX AND THE FAILURE IS SILENT. Measured: `HTTP_PROXY` is
 * set in this environment (an outbound SLAC squid), and Chromium sent the LOOPBACK page request to
 * it rather than to 127.0.0.1 -- despite `no_proxy` naming both `localhost` and `127.0.0.1`, which
 * Chromium does not honour the way curl does. The symptom is the worst kind: the window opens,
 * `did-fail-load` never fires, no renderer error appears, keys are delivered to a blank page, and
 * the gateway's log shows NOT ONE HTTP REQUEST. It cost a request-logging patch to the built server
 * to see that nothing had arrived at all.
 */
const ELECTRON_ARGV = ['--no-sandbox', '--disable-gpu', '--no-proxy-server'];

/**
 * Each chord and the action it MUST produce -- `null` meaning it must produce NONE.
 *
 * SPELLINGS ARE ELECTRON ACCELERATOR NAMES, never DOM code names: `Digit1` and `ArrowUp` are
 * delivered as EMPTY events, so the wrong spelling is a test that passes while proving nothing.
 *
 * `Ctrl+]` is deliberately absent, and for a DIFFERENT reason than in `keys.mjs`. There it quits
 * and would truncate the run; here the bridge intercepts it and closes the socket, so it would end
 * the session mid-sequence. Its interception is tested in `bridgecore.test.ts` instead.
 *
 * The negatives carry as much weight as the positives: Ctrl+Z must be dropped rather than typing
 * "z", and F13 must not become PF13. Both are asserted as absences, which is why the pass
 * condition is the whole ORDERED sequence rather than a set of sightings.
 *
 * `Ctrl+K` IS THE ONLY OBSERVABLE FOR THE KEYPAD CHORD OVER THIS PATH, and `integration.test.ts`'s
 * 'logs a toggleKeypad BEFORE intercepting it' names this harness as the reason that order matters:
 * the gateway swallows the action, a keypad changes no screen in replay mode, so an interception
 * placed above the log line would make the chord unprovable here while every unit test stayed
 * green. Alt+K, the second spelling, is covered directly in `keys.test.ts`.
 */
const CASES = [
  { spec: 'Alt+1', action: { kind: 'pa', n: 1 } },
  { spec: 'Alt+2', action: { kind: 'pa', n: 2 } },
  { spec: 'Ctrl+A', action: { kind: 'attn' } },
  { spec: 'Ctrl+C', action: { kind: 'clear' } },
  { spec: 'Ctrl+K', action: { kind: 'toggleKeypad' } },
  { spec: 'Ctrl+Z', action: null },
  { spec: 'Shift+Tab', action: { kind: 'backTab' } },
  { spec: 'Tab', action: { kind: 'tab' } },
  { spec: 'F1', action: { kind: 'pf', n: 1 } },
  { spec: 'Shift+F1', action: { kind: 'pf', n: 13 } },
  { spec: 'F13', action: null },
  { spec: 'Insert', action: { kind: 'toggleInsert' } },
  { spec: 'Enter', action: { kind: 'enter' } },
];

/** Key order in JSON is an implementation detail; compare canonically. */
const canon = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

const specs = CASES.map((c) => c.spec).join(',');
const expected = CASES.filter((c) => c.action !== null).map((c) => canon(c.action));

/** A refusal to even start: `bail` reports on a run, and these happen before there is one. */
const refuse = (why, fix) => {
  console.log(`FAIL ${why}`);
  console.log(`     ${fix}`);
  process.exit(1);
};

// An all-`null` table would compare zero against zero, print "0 actions in order" and pass: the
// same zero-length false pass the `action` count check below exists to stop, one level up.
if (expected.length === 0) {
  refuse('every case in CASES is a negative, so nothing would be asserted',
    'restore at least one case with a non-null action');
}

/**
 * `dist/` IS WHAT RUNS, and nothing here builds it. Same guard as `keys.mjs`, and THREE packages
 * now, compared PER PACKAGE.
 *
 * `web` joins `gui` and `canvas` because this harness runs the gateway's own built output. One
 * `max` across all three would let a fresh build of one MASK a stale build of another -- the exact
 * measurement recorded in `keys.mjs` when `canvas` was added to it.
 *
 * Both sides name `.cts`/`.cjs` explicitly: `'preload.cts'.endsWith('.ts')` is FALSE, and that
 * exemption was once a false GREEN in the very layer these harnesses claim as unique coverage.
 */
const newest = (dir, ...suffixes) => Math.max(...readdirSync(dir, { recursive: true })
  .filter((f) => suffixes.some((s) => f.endsWith(s)))
  .map((f) => statSync(join(dir, f)).mtimeMs));

const REBUILD = 'run: npm run build';
for (const entry of [guiMain, webMain]) {
  if (!existsSync(entry)) refuse(`there is no ${entry} to run`, REBUILD);
}
for (const pkg of ['gui', 'canvas', 'web']) {
  const root = join(repo, 'packages', pkg);
  if (!existsSync(join(root, 'dist'))) {
    refuse(`there is no packages/${pkg}/dist, so there is nothing built to run`, REBUILD);
  }
  if (newest(join(root, 'dist'), '.js', '.cjs') < newest(join(root, 'src'), '.ts', '.cts')) {
    refuse(`packages/${pkg}/dist is OLDER than packages/${pkg}/src, so this run would test stale code`,
      `${REBUILD}  (if that reports everything up to date, only a timestamp moved: ` +
      `npx tsc --build --force packages/${pkg})`);
  }
}

/** The gateway, started here and torn down in the `finally` below whatever happens. */
const server = spawn(process.execPath, [webMain, ...SERVER_ARGV], { encoding: 'utf8' });
let serverOut = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let failed = 0;
try {
  /**
   * Wait for the URL the gateway prints, rather than sleeping.
   *
   * A fixed sleep is either a flake or a waste, and the line carries the PORT -- which is chosen by
   * the kernel here, so it cannot be predicted or hardcoded. It carries the token too.
   */
  const url = await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`the gateway printed no URL:\n${serverOut}`)), 20000);
    server.on('exit', (code) => {
      clearTimeout(timer);
      rejectP(new Error(`the gateway exited ${code} before serving:\n${serverOut}`));
    });
    const check = () => {
      const m = /(https?:\/\/\S+)/.exec(serverOut);
      if (m !== null) { clearTimeout(timer); resolveP(m[1]); }
    };
    server.stdout.on('data', check);
    check();
  });

  /**
   * ASYNC `spawn`, NOT `spawnSync`, AND THAT IS THE WHOLE REASON THIS HARNESS WORKS.
   *
   * MEASURED, and it cost an hour of chasing the wrong layer: `spawnSync` BLOCKS THE EVENT LOOP, so
   * while the browser ran, this process could not service the `data` events carrying the gateway's
   * output. The bytes sat in the pipe; `spawnSync` returned; and the code below read `serverOut`
   * SYNCHRONOUSLY, seeing only the "serving" line written before the browser started. Every action
   * had in fact been applied -- running the same browser and gateway by hand showed all six asset
   * requests and `action: {"kind":"enter"}` -- so the harness reported the product broken while the
   * product was fine, which is the exact failure mode `docs/HANDOFF.md` warns about for new
   * harnesses. Any harness that reads one child's pipe while spawning another SYNCHRONOUSLY has
   * this bug.
   *
   * `close` rather than `exit`, because it fires once stdio is drained.
   */
  let timedOut = false;
  const result = await new Promise((resolveP) => {
    const child = spawn(electron, [guiMain, ...ELECTRON_ARGV], {
      env: guiEnv({
        TN3270_GUI_URL: url,
        TN3270_GUI_KEYS: specs,
        TN3270_GUI_KEYS_MS: '2500',
      }),
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveP({ error, stdout: out, stderr: err, status: null, signal: null });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveP({
        stdout: out, stderr: err, status, signal,
        ...(timedOut ? { error: new Error('the browser did not finish within 120s') } : {}),
      });
    });
  });

  /**
   * Then WAIT for the gateway's own account to arrive, bounded.
   *
   * Even with the loop free, the server's last writes are only delivered on a later turn than the
   * browser's exit -- two processes, two pipes, no ordering between them. Polling until the expected
   * count arrives is deterministic on success and costs its bound only on a real failure, which is
   * the opposite trade to a fixed sleep.
   */
  const actionLines = () => serverOut.split('\n').filter((l) => l.startsWith('action: '));
  for (let waited = 0; waited < 4000 && actionLines().length < expected.length; waited += 50) {
    await new Promise((r) => { setTimeout(r, 50); });
  }

  const stdout = result.stdout ?? '';
  const bail = (why) => {
    console.log(`FAIL ${why}`);
    // MEASURED in the GUI harness: a missing `electron` gives ENOENT with BOTH streams empty, so
    // without this line a failed launch's entire account of itself is the headline above.
    if (result.error !== undefined) console.log(`     ${result.error.message}`);
    process.stdout.write(stdout);
    process.stderr.write(result.stderr ?? '');
    console.log('--- the gateway said: ---');
    process.stdout.write(serverOut);
    process.exit(1);
  };

  /**
   * All four failure shapes, ordered most-specific-first, exactly as `keys.mjs` orders them.
   *
   * A version reading `status !== null && status !== 0` PASSED a client that died: `spawnSync`
   * reports a signal death as `status: null`, `signal: 'SIGSEGV'`, stdout INTACT. A Chromium
   * process is likelier to be killed than to exit non-zero.
   */
  if (result.error !== undefined) bail('the browser never ran to completion');
  if (result.signal !== null) bail(`the browser was killed by ${result.signal}`);
  if (result.status !== 0) bail(`the browser exited ${result.status}`);
  if (!stdout.includes('keys: sent ')) bail('the keys seam never reported sending anything');

  // A renderer exception produces a page that receives keys and does nothing with them. `3` is
  // 'error' on a scale Electron has deprecated, so this literal will drift on an upgrade -- and it
  // will drift SILENTLY. `keys.mjs` and `shot.mjs` filter on the same literal for the same reason.
  const rendererErrors = stdout.split('\n').filter((l) => l.startsWith('renderer[3]'));
  if (rendererErrors.length > 0) bail(`the renderer threw:\n${rendererErrors.join('\n')}`);

  const actual = actionLines().map((l) => canon(JSON.parse(l.slice('action: '.length))));

  // THE ZERO-LENGTH FALSE PASS. Without this, a page that never connected produces no action
  // lines, and an empty-against-empty comparison would report "ok" -- which is the failure this
  // whole harness exists to detect, reported as a success.
  if (actual.length === 0) {
    bail('the gateway applied NO actions at all, so the page never reached it.\n'
      + '     check in this order, each a trap already recorded: bridge.js loading before\n'
      + '     renderer.js; the queue in bridgecore.ts flushing; the deflate pairing (78 9c);\n'
      + '     and whether renderer.js is served from packages/canvas/dist');
  }

  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    if (expected[i] === actual[i]) continue;
    failed += 1;
    console.log(`FAIL at position ${i}`);
    console.log(`     expected ${expected[i] ?? '(nothing)'}`);
    console.log(`     actual   ${actual[i] ?? '(nothing)'}`);
  }

  if (failed === 0) {
    console.log(`ok       ${CASES.length} chords, ${expected.length} actions in order, over a WebSocket`);
    console.log(`         negatives asserted: ${CASES.filter((c) => c.action === null).map((c) => c.spec).join(', ')}`);
  } else {
    console.log('\nthe whole sequence, for context:');
    for (const line of actual) console.log(`  ${line}`);
  }
} finally {
  // IN A `finally`, because every bail above and every throw leaves a listening server otherwise.
  // A stale gateway on a fixed port would make the NEXT run test the wrong build; on an ephemeral
  // port it merely leaks, which is still a process holding a replayed session open.
  server.kill();
}

process.exit(failed > 0 ? 1 : 0);
