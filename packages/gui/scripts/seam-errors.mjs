/**
 * A seam whose FILE cannot be read or written must fail fast and loudly, under Xvfb.
 *
 * ## THE FAILURE THIS GUARDS, MEASURED IN CI
 *
 * Run 43115293433, the App-Sandboxed MAS build: `TN3270_GUI_REPLAY` named a trace the sandbox
 * could not read. `readFileSync` threw inside `app.whenReady()`'s promise, which nothing catches,
 * so the log showed `UnhandledPromiseRejectionWarning: Error: EPERM ...` -- and then the client
 * SAT, its terminal window still open, until the job killed it at 60 s. Reproduced on Linux with
 * ENOENT, EACCES and EISDIR, and with a `TN3270_GUI_SHOT` path in a missing directory, which had
 * the identical shape at `maybeCapture`'s `writeFileSync`.
 *
 * A HANG AND AN EXIT 0 ARE BOTH WRONG: either lets a harness score a client that did nothing. So
 * each case asserts all three: a NON-ZERO exit, inside `BOUND_MS`, with the seam's one stderr
 * line naming the path and the error code.
 *
 * KILLED BY PID, never by name: `child.kill` signals the real Electron binary `xvfb.mjs` resolves,
 * whose main process takes its helpers with it (see `electron` there).
 *
 *     node packages/gui/scripts/seam-errors.mjs
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron, guiEnv, guiMain, guiMainLabel, staleness } from './xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const main = guiMain();
console.log(`entry: ${guiMainLabel()}`);

{
  const problem = staleness(main, ['gui', 'canvas']);
  if (problem !== undefined) {
    console.log(`FAIL ${problem.why}`);
    console.log(`     ${problem.fix}`);
    process.exit(1);
  }
}

/** `-insecure` and the two Electron switches for the reasons `shot.mjs` gives at its own ARGV. */
const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E', '127.0.0.1:1'];

/**
 * Generous against a ~1 s startup and the 2.5 s shot settle, and far under the 60 s that CI's hang
 * cost -- so a pass here cannot be a hang that happened to end.
 */
const BOUND_MS = 10_000;

const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');
const scratch = mkdtempSync(join(tmpdir(), 'tn3270-seam-errors-'));
const missing = join(scratch, 'does-not-exist.trace');
const dirAsTrace = join(scratch, 'a-directory');
mkdirSync(dirAsTrace);
const unreadable = join(scratch, 'unreadable.trace');
writeFileSync(unreadable, 'x');
chmodSync(unreadable, 0o000);
const shotInMissingDir = join(scratch, 'no-such-dir', 'shot.png');

const CASES = [
  // The CI run's own env, PROBE and SHOT included, with the path swapped for one that is missing.
  { name: 'replay-enoent', env: { TN3270_GUI_REPLAY: missing, TN3270_GUI_PROBE: '1' },
    want: `replay: cannot read ${missing}: ENOENT ` },
  { name: 'replay-eisdir', env: { TN3270_GUI_REPLAY: dirAsTrace },
    want: `replay: cannot read ${dirAsTrace}: EISDIR ` },
  // As root `chmod 000` is ignored and the read succeeds, so this case would test nothing.
  ...(process.getuid?.() === 0 ? [] : [{ name: 'replay-eacces', env: { TN3270_GUI_REPLAY: unreadable },
    want: `replay: cannot read ${unreadable}: EACCES ` }]),
  // A readable trace, so the run reaches the capture and fails at its write.
  { name: 'shot-enoent', env: { TN3270_GUI_REPLAY: trace, TN3270_GUI_SHOT: shotInMissingDir },
    want: `shot: cannot write ${shotInMissingDir}: ENOENT ` },
];

function run(kase) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(electron, [main, ...ARGV], {
      env: guiEnv({
        // Cleared rather than inherited, as in `shot.mjs`: a stray seam in the caller's shell
        // would change what these runs do.
        TN3270_GUI_KEYS: '', TN3270_GUI_CLICKS: '', TN3270_GUI_SELECT: '', TN3270_GUI_TRANSFER: '',
        TN3270_GUI_CONNECT: '', TN3270_GUI_URL: '',
        TN3270_GUI_SHOT: join(scratch, `${kase.name}.png`), TN3270_GUI_SHOT_MS: '2500',
        ...kase.env,
      }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, BOUND_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, ms: Date.now() - started, stdout, stderr });
    });
  });
}

let failed = 0;
for (const kase of CASES) {
  const r = await run(kase);
  const line = r.stderr.split('\n').find((l) => l.startsWith(kase.want));
  const problems = [];
  if (r.timedOut) problems.push(`HUNG: still running after ${BOUND_MS}ms, killed pid`);
  else if (r.code === 0) problems.push('exited 0, which a harness would score as a pass');
  else if (r.code === null) problems.push(`died on ${r.signal}`);
  if (line === undefined) problems.push(`no stderr line starting ${JSON.stringify(kase.want)}`);
  if (r.stderr.includes('UnhandledPromiseRejection')) problems.push('an unhandled rejection was logged');
  if (problems.length === 0) {
    console.log(`ok       ${kase.name}: exit ${r.code} in ${r.ms}ms: ${line}`);
  } else {
    failed++;
    console.log(`FAIL     ${kase.name}: ${problems.join('; ')}`);
    for (const l of r.stderr.split('\n').filter((s) => /replay:|shot:|Error/.test(s))) console.log(`         ${l}`);
  }
}

chmodSync(unreadable, 0o600);
rmSync(scratch, { recursive: true, force: true });
console.log(`\n${CASES.length - failed}/${CASES.length} seam failures exited fast`);
process.exit(failed > 0 ? 1 : 0);
