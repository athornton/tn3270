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
 * ## WHAT IT PROVES THAT keys.test.ts CANNOT -- AND WHAT IT DOES NOT
 *
 * MEASURED 2026-09-15, and the first draft of this comment had it wrong. Breaking the
 * MAPPING is caught by both: unbind `PA_CODES` and `keys.test.ts` reddens too, because it
 * calls `actionForKey` directly, which is where the mapping lives. Same for a PA2->PA3
 * transposition and for giving `Ctrl+Z` a binding.
 *
 * What ONLY this harness catches is the PLUMBING between a real keypress and that mapper.
 * Proof, run as a mutation: add `if (e.altKey) return;` to `renderer.ts`'s `keydown`
 * listener -- the original bug's shape, chords never reaching the mapper -- and `npm test`
 * stays FULLY GREEN at 1352 while this harness fails all 13 positions. `actionForKey` is
 * untouched and correct; the keys are simply dead in the real GUI.
 *
 * So the claim to make for this file is the renderer/IPC/`ipcMain` path, not the mapping.
 *
 *     node packages/gui/scripts/keys.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
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
 * SPELLINGS ARE ELECTRON ACCELERATOR NAMES, never DOM code names. `Digit1` here would be
 * refused by `parseKeySpec` before any event was sent and the client would exit 2 with the
 * valid form on stderr, which the status bail below reports -- so a failing run that sent
 * nothing means a typo in this table rather than a broken client.
 *
 * The negatives carry as much weight as the positives: Ctrl+Z must be dropped rather than
 * typing "z", and F13 must not become PF13. Both are asserted as absences, which is why the
 * pass condition is the whole ORDERED sequence rather than a set of sightings.
 *
 * Ctrl+] is deliberately absent: it quits, and would truncate the run. Every OTHER entry in
 * `keys.ts`'s CTRL table is here, so a chord dropped from that table cannot hide.
 */
const CASES = [
  { spec: 'Alt+1', action: { kind: 'pa', n: 1 } },
  { spec: 'Alt+2', action: { kind: 'pa', n: 2 } },
  { spec: 'Alt+3', action: { kind: 'pa', n: 3 } },
  { spec: 'Ctrl+A', action: { kind: 'attn' } },
  { spec: 'Ctrl+C', action: { kind: 'clear' } },
  { spec: 'Ctrl+R', action: { kind: 'reset' } },
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

/** A refusal to even start: `bail` reports on a run, and these happen before there is one. */
const refuse = (why, fix) => {
  console.log(`FAIL ${why}`);
  console.log(`     ${fix}`);
  process.exit(1);
};

// An all-`null` table would compare zero against zero, print "0 actions in order" and pass:
// the same zero-length false pass the `keys: sent` check exists to stop, one level up.
if (expected.length === 0) {
  refuse('every case in CASES is a negative, so nothing would be asserted',
    'restore at least one case with a non-null action');
}

/**
 * `dist/` IS WHAT RUNS, and nothing in this harness builds it.
 *
 * FOUND STALE IN THIS TREE during review: `dist/keys.js` was a day older than `src/keys.ts`.
 * It happened to still agree, so those green runs were honest -- but a green harness over
 * yesterday's mapping table is exactly the false pass this file exists to prevent, and the
 * proof that this guard BITES (unbind the PA table and watch it go red) proves nothing if the
 * build under test predates the unbinding.
 *
 * ## NEWEST SOURCE AGAINST NEWEST OUTPUT, AND NEITHER OF THE OBVIOUS ALTERNATIVES
 *
 * Both were tried and MEASURED, 2026-09-15:
 *
 *  - `dist/main.js` alone against the newest source is WRONG and fails honest work:
 *    `tsc --build` re-emits only the files that changed, so editing `keys.ts` and rebuilding
 *    leaves `main.js` at its old mtime and the harness red with nothing to fix.
 *  - `tsc --build --dry` is not an oracle: it reported "up to date" with `dist/keys.js`
 *    DELETED, because `--build` trusts its `.tsbuildinfo` rather than looking at the outputs.
 *
 * A CONTENT-PRESERVING `touch` IS THE ONE FALSE RED, and it is why the remedy names `--force`.
 * tsc keys its incremental state on content, so after a bare touch it correctly emits nothing
 * -- and then no ordinary build can restore the ordering. `--force` re-emits and clears it.
 * The trade is deliberate: this check errs towards refusing to run, and a refusal that names
 * its own fix costs a rebuild, where a false pass costs a wrong belief about the PA keys.
 *
 * BOTH SIDES must name `.cts`/`.cjs` explicitly, and the first version of this check did not:
 * `'preload.cts'.endsWith('.ts')` is FALSE, so the source side skipped the preload entirely.
 * That was the one surviving route to a green run over broken chords -- edit `preload.cts`,
 * forget the build, and the harness exercises yesterday's IPC bridge and reports `ok` -- and
 * it sat in the exact layer this harness claims as its unique coverage. Found in the
 * whole-branch review, after the per-task reviews had passed.
 */
// RECURSIVE, because tsconfig's `include` is (`src/**/*.ts`): a file at `src/foo/bar.ts`
// compiles to `dist/foo/bar.js` and would otherwise be invisible to BOTH sides of the
// comparison -- the same false-GREEN class as the `.cts` bug below. `src/` is flat today.
const newest = (dir, ...suffixes) => Math.max(...readdirSync(dir, { recursive: true })
  .filter((f) => suffixes.some((s) => f.endsWith(s)))
  .map((f) => statSync(join(dir, f)).mtimeMs));
if (!existsSync(main)) {
  refuse(`there is no ${main} to run`, 'run: npm run build -w @tn3270/gui');
}
if (newest(join(here, '..', 'dist'), '.js', '.cjs') < newest(join(here, '..', 'src'), '.ts', '.cts')) {
  refuse('dist/ is OLDER than src/, so this run would test stale code',
    'run: npm run build -w @tn3270/gui  (if that reports everything up to date, only a ' +
    'timestamp moved: npx tsc --build --force packages/gui)');
}

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

const bail = (why) => {
  console.log(`FAIL ${why}`);
  // Printed here rather than only beside the `error` bail below, because MEASURED: a missing
  // `electron` gives ENOENT with BOTH streams empty, so without this line a failed launch's
  // entire account of itself is the headline above. `error.message` is what names ENOENT or
  // ETIMEDOUT; the dumped stdout of a timeout says nothing, it just stops.
  if (result.error !== undefined) console.log(`     ${result.error.message}`);
  process.stdout.write(stdout);
  process.stderr.write(result.stderr ?? '');
  process.exit(1);
};

/**
 * The client must have SUCCEEDED, and a SIGNAL DEATH IS THE LIKELIEST WAY FOR IT NOT TO HAVE.
 *
 * `keys: sent` only says the last chord was delivered. It says nothing about what happened
 * next, and a version of this check that read `status !== null && status !== 0` PASSED a
 * client that died: MEASURED with a fake client that printed the whole expected sequence plus
 * `keys: sent` and then `kill -SEGV $$`, which `spawnSync` reports as `status: null`,
 * `signal: 'SIGSEGV'`, `error: undefined` and stdout INTACT. The harness printed `ok` and
 * exited 0. A Chromium process is likelier to be killed than to exit non-zero, and the same
 * hole covered a timeout after complete output -- a regression in `quitIfKeysOnly` that
 * stopped the client quitting would have burned 120s and then said `ok`.
 *
 * So all FOUR shapes are named, ordered most-specific-first:
 *  - never ran, or never finished: `error` -- ENOENT and ETIMEDOUT. A timeout ALSO arrives as
 *    SIGTERM, and "never ran to completion" beside `error.message` is the better headline for
 *    it than "killed by SIGTERM", which invites a hunt for a killer.
 *  - killed: `signal`, which carries no exit code to report.
 *  - failed: a non-zero `status`, unguarded now that null cannot reach it.
 *
 * MEASURED on a healthy keys-only run: `status: 0`, `signal: null`, `error: undefined` --
 * three runs that printed the raw values -- because `quitIfKeysOnly` calls `app.quit()` once
 * the stdout drain completes.
 *
 * ALL THREE COME BEFORE THE SEAM BAIL, deliberately. The everyday failure here is a bad
 * spelling in the table above, which exits 2 having sent nothing, so the seam bail would
 * report the silence and read as a broken client -- when the explanation is already on stderr.
 */
if (result.error !== undefined) bail('the client never ran to completion');
if (result.signal !== null) bail(`the client was killed by ${result.signal}`);
if (result.status !== 0) bail(`the client exited ${result.status}`);
// The seam must have RUN. Without this, a client that exited early would produce zero
// action lines, zero mismatches on a zero-length comparison, and a false pass.
if (!stdout.includes('keys: sent ')) bail('the keys seam never reported sending anything');

/**
 * A renderer exception produces a window that receives keys and does nothing with them.
 *
 * `3` IS 'error' ON A SCALE ELECTRON HAS DEPRECATED. Electron 44's own typings give the
 * numeric level as 0..3 for verbose, info, warning, error and mark the argument `@deprecated`
 * in favour of `Event<WebContentsConsoleMessageEventParams>` -- a run prints that deprecation
 * notice on stderr. So this literal will drift on an upgrade, and it will drift SILENTLY: the
 * filter would simply stop matching and a renderer that threw would present as a mapping bug.
 * It cannot be loosened to `renderer[` either, because level 2 arrives on every run here
 * (Electron's own CSP warning) and would fail every run.
 *
 * `shot.mjs` filters on the same literal for the same reason. The duplication is KNOWN and
 * left deliberately: a shared home would churn that file and the test pinning it this late in
 * the branch. If the level moves, that is the other place to fix.
 */
const rendererErrors = stdout.split('\n').filter((l) => l.startsWith('renderer[3]'));
if (rendererErrors.length > 0) bail(`the renderer threw:\n${rendererErrors.join('\n')}`);

let failed = 0;

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
