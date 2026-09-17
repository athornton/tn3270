/**
 * Click guard for the GUI keypad, under Xvfb: does a real mouse press at a real button work?
 *
 * ## WHAT THIS COVERS THAT NOTHING ELSE CAN
 *
 * The click path is `mousedown` -> the primary-button guard -> `hitTestAt` -> `sendAction` -> IPC ->
 * `applyAction`, and every unit test in this repo stops before the first arrow: `renderer.ts` is a
 * browser entry point that throws at module load outside a browser, so the barrel deliberately does
 * not export it (`canvas/src/index.ts`) and no vitest file can execute a line of it.
 *
 * PROVED AS A MUTATION, 2026-09-16: make the `mousedown` listener return before it does anything --
 * `if (Date.now() > 0) return;` as its first line -- and `npm run build`, `npm run typecheck` and
 * `npm test` are ALL clean, 1637 tests in 70 files, while this harness fails all 8 click positions.
 * Every keypad button is dead and the fast gate has nothing to say about it.
 *
 * A BARE `return;` there, which is the obvious spelling of that mutation, does NOT typecheck: the
 * code below it becomes unreachable, unreachable code gets no control-flow narrowing, and `list` and
 * `list.keypad` go back to being possibly-undefined -- five errors. tsc emits anyway (nothing sets
 * `noEmitOnError`), so `npm test` still runs green over the mutated `dist` and the finding survives;
 * but the honest mutation is the one the build cannot see, and that is the one recorded above.
 *
 * ## WHAT IT DOES NOT COVER, DELIBERATELY -- THE ARITHMETIC
 *
 * `hitTestAt` is unit-tested directly, at scale 3 with a non-zero centring offset
 * (`canvas/test/keypad.test.ts`), because both fatal mutations -- multiplying instead of dividing,
 * and dropping the offset -- are invisible at scale 1 with no centring, and that is the ONLY
 * configuration this harness can run in: `main.ts`'s `fit` sets the content size to exactly
 * `list.width * scale` by `list.height * scale`, so `centre` returns (0,0) for every model in native
 * Electron mode, and an 80-column screen with the keypad is 720x434, which at scale 2 is 1440x868
 * and does not fit Xvfb's 1280x1024. So this run is the PLUMBING, which is scale-independent, and
 * the offset arithmetic lives where a unit test can mutate it.
 *
 * ## CLICKS BY LABEL, WHICH IS ALSO AN ASSERTION ABOUT THE TABLE
 *
 * `TN3270_GUI_CLICKS` takes LABELS, and `main.ts` asks the renderer where that label is. So each
 * case says "the button drawn `FldMk` sends `fieldMark`", and a label/action transposition in
 * `frontend/src/keypad.ts` fails here: MEASURED by swapping `Dup`'s and `FldMk`'s actions, which
 * failed positions 5 and 6 with each other's action.
 *
 * IT IS NOT THE ONLY COVER FOR THAT PAIRING, and the plan for this task said it was. The SAME swap
 * also reddens `frontend/test/keypad.test.ts`'s independently-written label-to-action map and
 * `tui/test/keypadOverlay.test.ts` -- two unit failures, in the fast gate, for all 47 keys rather
 * than these 8. What is true is the narrower claim: the pixel goldens cannot see it (the glyphs are
 * identical either way), and this is the only place the pairing is checked THROUGH the drawn button
 * -- the rectangle `keypadRegion` built, the frame the renderer hit-tested, the IPC hop -- rather
 * than in the table.
 *
 *     node packages/gui/scripts/clicks.mjs
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
 * `-insecure` IS MANDATORY even though this replays a trace and opens no socket: point it at a real
 * host and default-on TLS against plaintext Hercules does not fail, it HANGS.
 * `--no-sandbox --disable-gpu` are Electron's; there is no GL on this box, and without
 * --disable-gpu a window HANGS rather than failing. All three are `keys.mjs`'s, for its reasons.
 */
const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E'];

/**
 * The chord that SHOWS the keypad, which must happen before a click can land on one.
 *
 * The keypad is off by default -- it is toggled, not permanent (`main.ts`'s `showKeypad`) -- and
 * with it hidden the draw list has no `keypad` region at all, so the renderer's probe returns
 * `null`, `main.ts` prints `clicks: NO BUTTON` for every label and the bail below reports it.
 * `TN3270_GUI_CLICKS` deliberately does not turn the keypad on itself: two on-switches would toggle
 * it back off, and doing it with a real chord means this run also proves that Ctrl+K reaches
 * `main.ts` and resizes the window, which is what puts the buttons inside the content area.
 *
 * So `toggleKeypad` is the FIRST expected action, ahead of every case.
 */
const SHOW_KEYPAD = 'Ctrl+K';

/**
 * Each button LABEL and the action clicking it MUST produce.
 *
 * LABELS AS DRAWN, from `frontend/src/keypad.ts` -- `FldMk` and `BkSp`, not `FieldMark` or
 * `Backspace`. A label not in that table is not a plumbing failure and is not reported as one: the
 * client prints `clicks: NO BUTTON <label>` and the bail below names it.
 *
 * ONE FROM EVERY BLOCK OF THE LAYOUT, so no block can go dead unseen. Both PF rows -- `PF24` is on
 * the TOP row and `PF1` on the bottom, because PF13-24 sits above PF1-12 -- then the left-hand block
 * at columns 0-17 (`PA2` on its row 2, `SysRq` on its row 3), the middle block at columns 24-41
 * (`BkSp`, on its bottom row) and the right-hand block at columns 48-65 (`Dup`, `FldMk`, `Enter`).
 * `NewLn` is outside all three: it is alone at column 42 on the bottom row, which is the middle
 * block's gutter on the two rows above it.
 *
 * EVERY BUTTON WHOSE ACTION IS NEW ON THIS BRANCH IS HERE -- `Dup`, `FldMk`, `SysRq` and now
 * `NewLn`: those are the capabilities this feature exists to make reachable, each of them a method
 * that sat in core with no interactive route, so a run that proved the plumbing while leaving them
 * out would prove it for the keys nobody was worried about. `NewLn` earns its place twice over: it
 * is the NEWEST button, the only one on its row past `BkSp`, and the only one whose column was
 * asserted EMPTY until it arrived.
 *
 * THE OTHER 38 KEYS ARE NOT CLICKED, and that is a deliberate limit rather than an oversight. What
 * this run costs is real -- 1.2s of settle plus 120ms a click -- and what a 39th click would add is
 * one more instance of a path the first nine already exercised end to end. Their label-to-action
 * pairing is checked as DATA, for all 47, by `frontend/test/keypad.test.ts`; their rectangles by
 * `canvas/test/keypad.test.ts`; their pixels by the goldens. If a whole block ever falls out of that
 * list above, add a case for it here rather than trusting the neighbour.
 */
const CASES = [
  { label: 'PF1', action: { kind: 'pf', n: 1 } },
  { label: 'PF24', action: { kind: 'pf', n: 24 } },
  { label: 'PA2', action: { kind: 'pa', n: 2 } },
  { label: 'SysRq', action: { kind: 'sysreq' } },
  { label: 'Dup', action: { kind: 'dup' } },
  { label: 'FldMk', action: { kind: 'fieldMark' } },
  { label: 'Enter', action: { kind: 'enter' } },
  { label: 'BkSp', action: { kind: 'backspace' } },
  { label: 'NewLn', action: { kind: 'newline' } },
];

/** Key order in JSON is an implementation detail; compare canonically. */
const canon = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

const labels = CASES.map((c) => c.label).join(',');
/** The chord's own action first, then one per click, in order. */
const expected = [canon({ kind: 'toggleKeypad' }), ...CASES.map((c) => canon(c.action))];

/** A refusal to even start: `bail` reports on a run, and these happen before there is one. */
const refuse = (why, fix) => {
  console.log(`FAIL ${why}`);
  console.log(`     ${fix}`);
  process.exit(1);
};

/**
 * AN EMPTY `CASES` MUST REFUSE, and the check is on `CASES` rather than on `expected`.
 *
 * `expected` always holds the `toggleKeypad` the chord produces, so `expected.length === 0` -- the
 * shape `keys.mjs` uses, where every case can legitimately be a negative -- is UNREACHABLE here and
 * would be a guard nothing could redden. With `CASES` emptied, `expected` and `actual` would both be
 * the single `toggleKeypad`, and this file would print `ok 0 buttons, 1 actions in order`: a green
 * run in which no button was clicked at all.
 */
if (CASES.length === 0) {
  refuse('CASES is empty, so this run would click nothing and still compare equal',
    'restore at least one { label, action } case');
}

/**
 * `dist/` IS WHAT RUNS, and nothing in this harness builds it.
 *
 * The whole argument is in `keys.mjs`, which found this stale in this very tree, and it is not
 * repeated here: newest output against newest source, per package, because `tsc --build` re-emits
 * only what changed and `tsc --build --dry` is not an oracle -- it reported "up to date" with an
 * output file DELETED, since `--build` trusts its `.tsbuildinfo` rather than looking at the outputs.
 *
 * BOTH PACKAGES, SEPARATELY, and for this harness `canvas` is the more important of the two:
 * `renderer.ts` and its new `__tn3270ButtonCentre` probe live there, and so does `hittest.js`. One
 * `max` across both would let a fresh `gui` build MASK a stale `canvas` one, since gui's newer
 * output would win the max over canvas's newer source -- and a stale `canvas` is precisely a run
 * that clicks yesterday's layout and reports `ok`.
 *
 * `.cts`/`.cjs` are named explicitly on BOTH sides because `'preload.cts'.endsWith('.ts')` is FALSE,
 * which once exempted the preload -- the IPC hop this harness claims to cover -- from the check
 * entirely. That was a false GREEN, and it is why the suffix lists are spelled out.
 */
const newest = (dir, ...suffixes) => Math.max(...readdirSync(dir, { recursive: true })
  .filter((f) => suffixes.some((s) => f.endsWith(s)))
  .map((f) => statSync(join(dir, f)).mtimeMs));
/**
 * The remedy names the WHOLE-WORKSPACE build, never `-w @tn3270/gui`: MEASURED, a scoped gui build
 * exits 0, compiles `canvas` through the project reference and never runs `canvas`'s second build
 * step, so `atlas.json` is missing and the client dies at startup. See `keys.mjs` and
 * `canvas/src/assets.ts`. A refusal that names its own fix is worthless if the fix is the cause.
 */
const REBUILD = 'run: npm run build';
if (!existsSync(main)) {
  refuse(`there is no ${main} to run`, REBUILD);
}
for (const pkg of ['gui', 'canvas']) {
  const root = join(here, '..', '..', pkg);
  if (!existsSync(join(root, 'dist'))) {
    refuse(`there is no packages/${pkg}/dist, so there is nothing built to run`, REBUILD);
  }
  if (newest(join(root, 'dist'), '.js', '.cjs') < newest(join(root, 'src'), '.ts', '.cts')) {
    refuse(`packages/${pkg}/dist is OLDER than packages/${pkg}/src, so this run would test ` +
      'stale code',
      `${REBUILD}  (if that reports everything up to date, only a timestamp moved: ` +
      `npx tsc --build --force packages/${pkg})`);
  }
}

const result = spawnSync(electron, [main, ...ARGV, '127.0.0.1:1'], {
  encoding: 'utf8',
  timeout: 120000,
  env: guiEnv({
    // REPLAY, so this cannot reach a host: the actions below include `enter` and the PF keys, and
    // against a live session those submit whatever is on the screen. It is also what makes the
    // action log legal at all -- `main.ts` gates it on replay mode, because a `type` action carries
    // the text typed and that could be a password.
    TN3270_GUI_REPLAY: trace,
    TN3270_GUI_KEYS: SHOW_KEYPAD,
    TN3270_GUI_CLICKS: labels,
    TN3270_GUI_KEYS_MS: '1200',
  }),
});

const stdout = result.stdout ?? '';
const actual = stdout.split('\n')
  .filter((l) => l.startsWith('action: '))
  .map((l) => canon(JSON.parse(l.slice('action: '.length))));

const bail = (why) => {
  console.log(`FAIL ${why}`);
  // A missing `electron` gives ENOENT with BOTH streams empty, so without this line a failed
  // launch's entire account of itself is the headline above. `error.message` is what names ENOENT
  // or ETIMEDOUT.
  if (result.error !== undefined) console.log(`     ${result.error.message}`);
  process.stdout.write(stdout);
  process.stderr.write(result.stderr ?? '');
  process.exit(1);
};

/**
 * The client must have SUCCEEDED, and the four shapes are ordered most-specific-first.
 *
 * `keys.mjs` measured why this cannot be one check: a fake client that printed the whole expected
 * sequence and then `kill -SEGV $$` comes back as `status: null`, `signal: 'SIGSEGV'`,
 * `error: undefined` and INTACT stdout, so a guard of `status !== null && status !== 0` PASSES a
 * client that died. A Chromium process is likelier to be killed than to exit non-zero.
 *
 *  - `error` first: ENOENT and ETIMEDOUT both leave `status === null`, and `error.message` is the
 *    only diagnosis of either. A timeout also arrives as SIGTERM, and "never ran to completion" is
 *    a better headline for it than "killed by SIGTERM", which invites a hunt for a killer.
 *  - `signal` next, so the SIGSEGV case above cannot reach the status check.
 *  - `status` last and unguarded, safe now that neither null case can arrive here. This is also
 *    where a misspelled `TN3270_GUI_KEYS` lands: the client exits 2 with the valid form on stderr.
 *  - then the seam-ran check, because the everyday failure is a mistake in this file's tables,
 *    whose explanation is already on stderr and would read as a broken client otherwise.
 */
if (result.error !== undefined) bail('the client never ran to completion');
if (result.signal !== null) bail(`the client was killed by ${result.signal}`);
if (result.status !== 0) bail(`the client exited ${result.status}`);
// The seam must have RUN. Without this, a client that exited early -- or one whose URL-mode branch
// ignores this seam entirely -- would produce zero action lines, zero mismatches on a zero-length
// comparison, and a false pass.
if (!stdout.includes('clicks: sent ')) bail('the clicks seam never reported sending anything');

/**
 * A LABEL THAT IS NOT IN THE LAYOUT IS NOT A PLUMBING FAILURE.
 *
 * `main.ts` prints this when the renderer's probe returns `null`, which means either a typo or a
 * renamed key in `CASES` above, or the keypad was never shown. Reported HERE, ahead of the position
 * diff, because without it that diff shows a missing action for every remaining case and reads as
 * "the buttons are dead" -- the one diagnosis this harness must not hand out wrongly. The client
 * deliberately continues past it so a single typo reports itself rather than truncating the run.
 */
const missing = stdout.split('\n').filter((l) => l.startsWith('clicks: NO BUTTON'));
if (missing.length > 0) {
  bail(`the client could not find a button:\n${missing.join('\n')}\n     ` +
    '(a label not in frontend/src/keypad.ts, or a keypad that was never shown -- not a dead button)');
}

/**
 * A renderer exception produces a window that receives clicks and does nothing with them.
 *
 * `3` IS 'error' ON A SCALE ELECTRON HAS DEPRECATED, and this literal will drift SILENTLY on an
 * upgrade: the filter would simply stop matching and a renderer that threw would present as dead
 * buttons. It cannot be loosened to `renderer[` either, because level 2 arrives on every run here
 * (Electron's own CSP warning) and would fail every run. `keys.mjs` and `shot.mjs` filter on the
 * same literal; the duplication is KNOWN, and if the level moves those are the other places.
 *
 * This one matters more here than in `keys.mjs`: the probe is a `window` global installed by
 * `renderer.js`'s module body, so a renderer that threw before installing it has no probe at all.
 * `main.ts` catches that rejection and exits 2 rather than hanging, so the status bail above fires
 * first and dumps the stdout these lines are in.
 */
const rendererErrors = stdout.split('\n').filter((l) => l.startsWith('renderer[3]'));
if (rendererErrors.length > 0) bail(`the renderer threw:\n${rendererErrors.join('\n')}`);

let failed = 0;

// `Math.max`, not `expected.length`: a run that delivered EXTRA actions -- a double-click, or a
// press that fired twice -- must fail rather than being trimmed away by the shorter loop.
for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
  if (expected[i] === actual[i]) continue;
  failed += 1;
  console.log(`FAIL at position ${i}`);
  console.log(`     expected ${expected[i] ?? '(nothing)'}`);
  console.log(`     actual   ${actual[i] ?? '(nothing)'}`);
}

if (failed === 0) {
  // `expected.length` is one MORE than the number of buttons, and saying so is the point: the extra
  // action is the Ctrl+K that showed the keypad, and a count that quietly matched `CASES.length`
  // would mean the chord's own action had gone missing from the log.
  console.log(`ok       ${CASES.length} buttons, ${expected.length} actions in order ` +
    `(toggleKeypad + ${CASES.length})`);
  console.log(`         labels clicked: ${labels}`);
} else {
  console.log(`\nthe whole sequence, for context:`);
  for (const line of actual) console.log(`  ${line}`);
}
process.exit(failed > 0 ? 1 : 0);
