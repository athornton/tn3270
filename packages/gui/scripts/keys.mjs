/**
 * Chord guard for the GUI, under Xvfb: does a real Alt+1 still produce PA1?
 *
 * ## WHY THIS IS NOT A CASE INSIDE shot.mjs
 *
 * Different failure mode. That script compares a bitmap hash; this one compares an ordered
 * list of actions. Folding chords into it would also let a chord that DID change the screen
 * silently re-baseline a pixel golden on the next --update.
 *
 * ## WHY IT ASSERTS ON AN ACTION LOG AND NOT ON PIXELS
 *
 * Replay mode is not connected, so `sendAID` throws 'not connected' and `applyAction`
 * swallows it: a PA key has NO other observable consequence. Pixels would pin an absence.
 * `main.ts` logs each action at the `ipcMain` funnel while this seam is active.
 *
 * ## WHAT IT PROVES THAT keys.test.ts CANNOT
 *
 * That test hands `actionForKey` a synthetic object. This drives Chromium's own event
 * pipeline, so it covers the renderer's `keydown` listener, the IPC hop and `ipcMain` --
 * the links that were broken when the PA keys were unreachable, and which no unit test saw.
 *
 *     node packages/gui/scripts/keys.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiEnv } from './xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const main = join(here, '..', 'dist', 'main.js');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

/**
 * The client's argv, as one constant so the guard test has a single thing to pin.
 *
 * `-insecure` IS MANDATORY even though this replays a trace and opens no socket: point it
 * at a real host and default-on TLS against plaintext Hercules does not fail, it HANGS.
 * `--no-sandbox --disable-gpu` are Electron's; there is no GL on this box, and without
 * --disable-gpu a window HANGS rather than failing.
 */
const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E'];

/**
 * Each seam spelling and the action it MUST produce -- `null` meaning it must produce NONE.
 *
 * The negatives carry as much weight as the positives: Ctrl+Z must be dropped rather than
 * typing "z", and F13 must not become PF13. Both are asserted as absences, which is why the
 * pass condition is the whole ORDERED sequence rather than a set of sightings.
 *
 * Ctrl+] is deliberately absent: it quits, and would truncate the run.
 */
const CASES = [
  { spec: 'Alt+1', action: { kind: 'pa', n: 1 } },
  { spec: 'Alt+2', action: { kind: 'pa', n: 2 } },
  { spec: 'Alt+3', action: { kind: 'pa', n: 3 } },
  { spec: 'Ctrl+A', action: { kind: 'attn' } },
  { spec: 'Ctrl+C', action: { kind: 'clear' } },
  { spec: 'Ctrl+U', action: { kind: 'eraseInput' } },
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

// Every spelling here must be an Electron Accelerator name. A DOM code name is REFUSED by
// parseKeySpec before any event is sent, and the client then exits 2 with the valid form
// named on stderr -- measured while implementing Task 3, where an unhandled rejection made
// that path HANG instead. So a non-zero exit with no action lines means a bad spelling in
// this table, not a broken client.

const result = spawnSync(electron, [main, ...ARGV, '127.0.0.1:1'], {
  encoding: 'utf8',
  timeout: 120000,
  env: guiEnv({
    TN3270_GUI_REPLAY: trace,
    TN3270_GUI_KEYS: specs,
    TN3270_GUI_KEYS_MS: '1200',
  }),
});

const stdout = result.stdout ?? '';
const actual = stdout.split('\n')
  .filter((l) => l.startsWith('action: '))
  .map((l) => canon(JSON.parse(l.slice('action: '.length))));

let failed = 0;
const bail = (why) => {
  console.log(`FAIL ${why}`);
  // `error` is the ONLY report of a run that never started or never finished, and the two
  // cases were MEASURED: a missing `electron` gives ENOENT with BOTH streams empty, so
  // without this line the run's entire account of itself is the one above -- which reads as
  // a client that started and stayed silent. A timeout gives ETIMEDOUT, which the stdout
  // dumped below does not say either: it just stops.
  if (result.error !== undefined) console.log(`     ${result.error.message}`);
  process.stdout.write(stdout);
  process.stderr.write(result.stderr ?? '');
  process.exit(1);
};

/**
 * The client must have SUCCEEDED, which is a stronger claim than the seam reporting.
 *
 * `keys: sent` says the last chord was delivered; it says nothing about what happened next,
 * so a crash after the final chord would otherwise pass with a complete-looking log.
 * MEASURED: a healthy keys-only run exits 0, three runs out of three, because
 * `quitIfKeysOnly` calls `app.quit()` once the stdout drain completes.
 *
 * CHECKED BEFORE THE SEAM BAIL, deliberately: the everyday failure here is a bad spelling in
 * the table above, which exits 2 and prints no `keys: sent` line, so the bail below would
 * report that silence -- reading as a broken client rather than as the typo the stderr line
 * names. A `status` of null means the client never exited at all (a missing `electron`, or a
 * timeout's SIGTERM); those runs have no exit code to name and no `keys: sent` line either,
 * so they fall through to that bail, where `result.error` is what says ENOENT or ETIMEDOUT.
 */
if (result.status !== null && result.status !== 0) bail(`the client exited ${result.status}`);
// The seam must have RUN. Without this, a client that exited early would produce zero
// action lines, zero mismatches on a zero-length comparison, and a false pass.
if (!stdout.includes('keys: sent ')) bail('the keys seam never reported sending anything');
// A renderer exception produces a window that receives keys and does nothing with them.
const rendererErrors = stdout.split('\n').filter((l) => l.startsWith('renderer[3]'));
if (rendererErrors.length > 0) bail(`the renderer threw:\n${rendererErrors.join('\n')}`);

for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
  if (expected[i] === actual[i]) continue;
  failed += 1;
  console.log(`FAIL at position ${i}`);
  console.log(`     expected ${expected[i] ?? '(nothing)'}`);
  console.log(`     actual   ${actual[i] ?? '(nothing)'}`);
}

if (failed === 0) {
  console.log(`ok       ${CASES.length} chords, ${expected.length} actions in order`);
  console.log(`         negatives asserted: ${CASES.filter((c) => c.action === null).map((c) => c.spec).join(', ')}`);
} else {
  console.log(`\nthe whole sequence, for context:`);
  for (const line of actual) console.log(`  ${line}`);
}
process.exit(failed > 0 ? 1 : 0);
