/**
 * Drive the transfer WINDOW under Xvfb and assert what it did. Run by hand; `npm test` cannot.
 *
 * ## WHAT THIS COVERS THAT NOTHING ELSE CAN
 *
 * The transfer window's own wiring, end to end: a second `BrowserWindow`, its `transferPreload.cjs`
 * bridge, `transfer.html`'s IMPORT MAP, `transferBoot.ts`'s module body, `transferUi.ts`'s form
 * logic, the `transfer:submit` IPC hop and `transferWindow.ts`'s controller. Not one line of that
 * path is reachable from vitest: `transferBoot.ts` needs a `document` (there is none --
 * `vitest.config.ts` sets `environment: 'node'` and jsdom is not a dependency), `main.ts` calls
 * `app.whenReady()` in its module body so importing it throws, and an import map cannot fail to
 * resolve in a fake DOM.
 *
 * THAT LAST ONE IS THE POINT. `transferUi.ts`'s docstring names this harness as the only thing that
 * can see a blank-window-with-no-error, which is this repo's most-repeated failure -- met five
 * separate ways, and shipped once already on this very branch (`ui?.running()` in a TDZ). A blank
 * window still loads, still answers `did-finish-load`, and still photographs as a valid PNG. What it
 * does NOT do is render six rows into `#fields` or answer a submit, which is what the checks below
 * ask it for.
 *
 * ## IT NEVER REACHES A HOST, AND THAT IS A PRIVACY REQUIREMENT
 *
 * A transfer form carries a path and sits in front of a logged-on session. `TN3270_GUI_REPLAY`
 * exists because a golden taken from a live logon can contain a typed password and goldens live in
 * git forever; the same argument applies to anything this harness prints. So it runs in REPLAY mode
 * against a committed trace, which can reach no host at all.
 *
 * REPLAY IS ALSO WHAT MAKES THE SUBMIT CHECK MEAN SOMETHING, which was not obvious and was
 * measured: `Session.replay()` never assigns `this.telnet` (it builds a local `TelnetLayer` and
 * feeds it the trace, `core/src/session.ts:1607-1650`), so `is3270Mode()` -- which is
 * `this.telnet?.is3270Mode() ?? false` -- is FALSE for the whole run no matter what the trace
 * negotiated. `startTransfer`'s first guard is exactly that (`frontend/src/transferRun.ts:90-93`),
 * so the submit is refused with `not in 3270 mode` BEFORE anything is typed at a host. The check
 * below pins that error text rather than merely `ok=false`, because `ok=false` alone would also be
 * satisfied by a validator complaint, by 'the transfer window is not open', or by a buildCommand
 * throw -- i.e. by the form never having been filled in at all.
 *
 * ## THE DIALOG IS STUBBED, BECAUSE A NATIVE CHOOSER CANNOT BE DRIVEN HEADLESSLY
 *
 * `TN3270_GUI_TRANSFER_PATH` makes `openDialog`/`saveDialog` resolve to that path without showing
 * anything. Without it a run that reached Browse would hang on a modal nobody can click -- a stall,
 * not an error, which is the shape this repo keeps writing comments about. Nothing in the scenario
 * below presses Browse today, so this is a guard against the next scenario rather than a thing this
 * run needs; it is set anyway, because the failure it prevents is a hang and the cost is nil.
 *
 *     node packages/gui/scripts/transfer.mjs
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

/**
 * THE SYNTHETIC TRACE, and NOT `x3270/tso-query-reply.txt`, which the plan for this task named.
 *
 * That file exists, so a wrong path here would not have announced itself -- it would simply have
 * replayed nothing. `packages/fixtures/x3270/README.md` says in as many words that it is "an excerpt
 * of two records rather than a whole session and would be meaningless as a replay fixture", and the
 * `.txt` extension is deliberately chosen to keep it out of the `*.trace` glob. It also carries no
 * negotiation, and `synthetic-ispf-like.trace`'s own header records what that costs: "TelnetLayer
 * only accumulates record bytes once BINARY and EOR are agreed both ways ... so a data-only fixture
 * replays as a blank screen".
 *
 * So this uses the same trace `shot.mjs`, `keys.mjs` and `clicks.mjs` do: synthetic, no host
 * capture, no credential, identical every run.
 */
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

/**
 * The client's argv, as one constant so the guard test has a single thing to pin.
 *
 * `-insecure` IS MANDATORY even though this replays a trace and opens no socket: point it at a real
 * host and default-on TLS against plaintext Hercules does not fail, it HANGS.
 * `--no-sandbox --disable-gpu` are Electron's; there is no GL on this box, and without
 * `--disable-gpu` a window HANGS rather than failing. All three are the other three harnesses',
 * for their reasons, and `transfer-harness-flags.test.ts` pins them here.
 */
const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E'];

/** Where the form's Local file field is pointed, and what the stubbed dialog would return. */
const LOCAL = '/tmp/harness-transfer.bin';
/** A TSO dataset name, so `transferCommand` builds `IND$FILE GET HARNESS.DATA` and not a refusal. */
const HOST_FILE = 'HARNESS.DATA';

/**
 * The scenario, as comma-separated STEPS applied in order.
 *
 * STEPS AND NOT COORDINATES, the same choice `TN3270_GUI_CLICKS` makes and for the same reason: a
 * coordinate list would be a second copy of the layout that agreed with itself while the layout was
 * wrong. Each step names a FIELD BY ID and goes through `ui.type`, i.e. through the model, so a
 * value the model refuses cannot be reported as set -- the seam echoes back what the model actually
 * holds rather than what it was handed.
 *
 * NO `open` STEP, which the plan for this task had. Nothing consumed it: the loop skipped it with
 * "already open" while nothing in `main.ts` had opened anything, so the whole scenario would have
 * printed nothing at all. The window is opened by the PRESENCE of this variable instead, which is
 * one fact in one place.
 *
 * ## REAL FIELD IDS -- `localFile`/`hostFile` -- AND NOT THE PLAN'S `path`/`host`
 *
 * MEASURED, and it is the sharpest finding of this task. With the plan's step names the run printed
 *
 *     transfer window: path=
 *     transfer window: host=tso
 *
 * `path` is not a field id at all, so `setFieldText` missed in `FIELD_BY_ID`, returned the state
 * untouched, and the local path was never set. Worse, `host` IS a field id -- the TSO/VM CYCLE field
 * -- so `ui.type` was asked to put `HARNESS.DATA` into it; `setFieldText` refuses a cycle field, and
 * the echo came back `tso`, the value that was always there. A seam with an alias table would have
 * had to translate `host` to `hostFile`, i.e. hold a second copy of the field names, and it would
 * have been WRONG IN A WAY THAT LOOKED RIGHT: a plausible-looking `host=` line, from a form where
 * nothing had been typed.
 *
 * The ids come straight from `TRANSFER_FIELDS`, so there is no table to drift. This is also what
 * made the echo worth having: without it both steps reported success.
 *
 * ## THE EDIT **AFTER** THE SUBMIT IS NOT PADDING -- IT IS THE ONLY WAY TO SEE A FROZEN FORM
 *
 * `transferUi.ts`'s `start()` arms the running state BEFORE it awaits the submit, which is the fix for
 * a defect this harness was BLIND TO: a transfer completing synchronously used to have its ending
 * overwritten by the submit that started it, leaving a form permanently claiming `transferring`. The
 * harness could not see it because `__tn3270Submit` answers with `ui.running()`, which was `true`
 * *because of* the bug -- so a broken run printed `ok=true status=transferring` and SCORED.
 *
 * That ordering has a liability of its own, and it is the one reachable from here: the refusal arm must
 * now CLEAR the flag it armed. A refusal that forgets leaves every control disabled for the window's
 * life -- the same frozen form, moved one path over. A disabled form is not visible in `ok=false`, nor
 * in the status text, nor in the field count: the only symptom is that nothing can be typed afterwards.
 *
 * So the scenario edits a field AFTER the refused submit and the check below reads the echo. Under
 * replay the submit is always refused (`not in 3270 mode`), which makes this the one C1-adjacent
 * property a headless run can establish -- in the REAL window, over REAL IPC, where `isRunning` and
 * the DOM's `disabled` attributes are the actual ones. Note it proves the MODEL still accepts an edit;
 * `transferBoot.ts`'s `disabled` half is the defense-in-depth twin and needs a human at the keyboard.
 */
const AFTER_SUBMIT = 'AFTER.SUBMIT';
const STEPS = `localFile=${LOCAL},hostFile=${HOST_FILE},submit,hostFile=${AFTER_SUBMIT}`;

/**
 * HOW MANY ROWS THE FORM MUST DRAW, as a literal with its derivation written down.
 *
 * A fresh form is `direction=receive, host=tso` (`newTransferForm`), and `applicable()` then hides
 * four of the ten fields: `recfm`, `lrecl` and `blksize` need `direction === 'send'`, and `cr`
 * needs `mode === 'ascii'`. Six remain -- direction, host, localFile, hostFile, mode, exist --
 * which is what `#fields .row` must contain. MEASURED against the built `transferForm.js` rather
 * than read off the table.
 *
 * A LITERAL AND NOT A COUNT COMPUTED HERE, deliberately: importing `TRANSFER_FIELDS` and filtering
 * it with `applicable()` would be a second copy of the renderer's own logic, and it would agree
 * with itself while the window drew nothing. `fields=\d+` -- the plan's spelling -- has the same
 * defect in a smaller way: it matches `fields=0`, which is precisely the blank window this harness
 * exists to catch.
 */
const FIELD_ROWS = 6;

/**
 * The status the form must end up showing, and the reason it is asserted rather than `ok=false`.
 *
 * See the module docstring: replay leaves `is3270Mode()` false, so this is `startTransfer`'s FIRST
 * guard and it fires before the host is told anything. Pinning the text proves the whole chain in
 * between actually ran -- the keywords were built, `transferCommand` accepted them, the controller
 * was found over IPC, and `startTransfer` was reached -- where `ok=false` alone would be satisfied
 * by any of those failing instead.
 *
 * x3270's own wording, `ftUnableNot3270` (`fb-common:47`), via `transferRun.ts:92`.
 */
const REFUSAL = 'not in 3270 mode';

/** A refusal to even start: the scoreboard reports on a run, and these happen before there is one. */
const refuse = (why, fix) => {
  console.log(`FAIL ${why}`);
  console.log(`     ${fix}`);
  process.exit(1);
};

/**
 * `dist/` IS WHAT RUNS, and nothing in this harness builds it.
 *
 * The whole argument is in `keys.mjs`, which found this stale in this very tree, and it is not
 * repeated here: newest output against newest source, PER PACKAGE, because `tsc --build` re-emits
 * only what changed and `tsc --build --dry` is not an oracle -- it reported "up to date" with an
 * output file DELETED, since `--build` trusts its `.tsbuildinfo` rather than looking at the outputs.
 *
 * THREE PACKAGES, and `frontend` is the one that matters most here. `transfer.html`'s import map
 * points `@tn3270/frontend` straight at `packages/frontend/dist/transferForm.js`, bypassing the
 * barrel, so a stale `transferForm.js` is a window whose form logic is yesterday's -- and if the
 * file were missing the window would go BLANK with nothing in any console, which is the failure
 * this harness exists to see. `gui` carries `main.js`, `transferBoot.js` and the preload; `canvas`
 * carries the main window's `renderer.js`, without which the replay paints nothing.
 *
 * PER PACKAGE rather than one max across all three, for `clicks.mjs`'s measured reason: a fresh
 * `gui` build would MASK a stale `frontend` one, since gui's newer output would win the max over
 * frontend's newer source.
 *
 * `.cts`/`.cjs` are named explicitly on BOTH sides because `'transferPreload.cts'.endsWith('.ts')`
 * is FALSE, which once exempted the preload -- the IPC hop this harness depends on -- from the
 * check entirely. That was a false GREEN, and it is why the suffix lists are spelled out.
 */
const newest = (dir, ...suffixes) => Math.max(...readdirSync(dir, { recursive: true })
  .filter((f) => suffixes.some((s) => f.endsWith(s)))
  .map((f) => statSync(join(dir, f)).mtimeMs));
/**
 * The remedy names the WHOLE-WORKSPACE build, never `-w @tn3270/gui`: MEASURED, a scoped gui build
 * exits 0, compiles `canvas` through the project reference and never runs `canvas`'s second build
 * step, so `atlas.json` is missing and the client dies at startup. A refusal that names its own fix
 * is worthless if the fix is the cause.
 */
const REBUILD = 'run: npm run build';
if (!existsSync(main)) {
  refuse(`there is no ${main} to run`, REBUILD);
}
for (const pkg of ['gui', 'frontend', 'canvas']) {
  const root = join(here, '..', '..', pkg);
  if (!existsSync(join(root, 'dist'))) {
    refuse(`there is no packages/${pkg}/dist, so there is nothing built to run`, REBUILD);
  }
  if (newest(join(root, 'dist'), '.js', '.cjs') < newest(join(root, 'src'), '.ts', '.cts')) {
    refuse(`packages/${pkg}/dist is OLDER than packages/${pkg}/src, so this run would test stale code`,
      `${REBUILD}  (if that reports everything up to date, only a timestamp moved: `
      + `npx tsc --build --force packages/${pkg})`);
  }
}

/**
 * `spawnSync` WITH A TIMEOUT, and the plan for this task had neither.
 *
 * It asked for `spawn` plus `child.on('close')` and nothing else, which HANGS FOREVER on a client
 * that does not exit -- and that was the state of the world when it was written: `quitIfKeysOnly`
 * returns early unless the keys or clicks seam is set (`main.ts`), so a transfer-only run reaches
 * the end of `app.whenReady()`'s callback with a window still open and sits there. The harness's own
 * docstring warned about exactly that failure shape while being written in it.
 *
 * `spawnSync` is also the house pattern -- `keys.mjs` and `clicks.mjs` both use it -- and it is
 * CORRECT here for the reason `clicks-harness-flags.test.ts` spells out: it blocks the event loop,
 * which only matters for a harness reading one child's pipe while another child runs
 * (`browser-shot.mjs`). This spawns a single child and reads its output afterwards.
 *
 * A TIMEOUT DOES NOT LOSE THE OUTPUT. Measured: a child that printed two lines and then slept was
 * killed at the deadline and came back `status: null`, `signal: 'SIGTERM'`, `error.code:
 * 'ETIMEDOUT'` with stdout FULLY INTACT. So the scoreboard below is still scored on a timeout, and
 * the exit check is what reports the hang.
 */
const result = spawnSync(electron, [main, ...ARGV, '127.0.0.1:1'], {
  encoding: 'utf8',
  timeout: 120000,
  env: guiEnv({
    TN3270_GUI_REPLAY: trace,
    TN3270_GUI_TRANSFER: STEPS,
    TN3270_GUI_TRANSFER_PATH: LOCAL,
    /**
     * DEFAULTED TO CLEARED, not merely unset by us, for `shot.mjs`'s measured reason: this env is
     * inherited from the caller's shell, and a stray `TN3270_GUI_KEYS` there would type into the
     * session this run submits from AND stretch its settle. A harness that silently depends on the
     * operator's environment is not a harness.
     */
    TN3270_GUI_KEYS: '',
    TN3270_GUI_CLICKS: '',
    TN3270_GUI_SHOT: '',
  }),
});

const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;

/**
 * Did the client finish on its own? A CHECK RATHER THAN A BAIL, deliberately.
 *
 * The other three harnesses bail on error/signal/status before scoring, because for them a client
 * that died is a client whose run says nothing. Here the client's OWN EXIT is part of what is under
 * test: `quitIfKeysOnly` has to recognise a transfer-only run, and until it does the process hangs
 * until this harness's deadline. Bailing would report that as "the client never ran to completion",
 * which reads as a broken client rather than as the missing exit it is -- and it would also throw
 * away a perfectly intact stdout that has every other answer in it.
 *
 * THE THREE SHAPES ARE STILL ORDERED, MOST-SPECIFIC FIRST, because that is what keeps each message
 * about its own cause. MEASURED in `keys.mjs`: a client that printed its whole expected output and
 * then `kill -SEGV $$` comes back as `status: null`, `signal: 'SIGSEGV'`, `error: undefined` with
 * INTACT stdout, so a guard of `status !== null && status !== 0` PASSES a client that died -- and a
 * Chromium process is likelier to be killed than to exit non-zero.
 *
 *  - `error` first: ENOENT (no `electron`) and ETIMEDOUT (the hang) both leave `status === null`,
 *    and `error.message` is the only diagnosis of either. A missing binary leaves BOTH streams
 *    empty, so without this line the run's entire account of itself would be a scoreboard of
 *    zeroes.
 *  - `signal` next, so the SIGSEGV case cannot reach the status check.
 *  - `status` last and unguarded, safe now that neither null case can arrive here.
 */
const exited = () => {
  if (result.error !== undefined) return `the client never ran to completion: ${result.error.message}`;
  if (result.signal !== null) return `the client was killed by ${result.signal}`;
  if (result.status !== 0) return `the client exited ${result.status}`;
  return undefined;
};
const exitProblem = exited();

/**
 * Each check as a NAME and a PREDICATE OVER THE OUTPUT.
 *
 * NOT ONE REGEX PER CHECK, which the plan had, because two of its six could pass vacuously. Its
 * `no did-fail-load` check was `/^(?!.*transfer window failed to load).*$/s`, a negative lookahead
 * over the whole output -- and `/^(?!.*x).*$/s.test('')` is TRUE, verified under node. So a client
 * that produced NOTHING AT ALL scored that check, which is worse than not having it: a check that
 * passes on an empty run certifies. Both negatives below therefore require positive evidence as
 * well.
 */
const CHECKS = [
  /**
   * THE WINDOW EXISTS. Nothing else in this list can pass without it, and it is the line that says
   * the `transferForm` route actually reached a second `BrowserWindow`.
   */
  ['the transfer window opened', () => out.includes('transfer window: opened')],
  /**
   * THE FORM RENDERED. This is the blank-window check, and it is the whole reason this harness
   * exists: a `transferBoot.ts` that threw in its module body -- the TDZ bug shipped on this very
   * branch -- loads fine, answers `did-finish-load` fine, and draws ZERO rows.
   *
   * Printed BEFORE the steps rather than after the submit, which is a change from the plan. It
   * describes the form as the window FIRST DREW it, which is what "did it render" means; after a
   * submit the number would describe whatever the submit left behind, and a reader would have to
   * know which.
   */
  [`the form drew its ${FIELD_ROWS} applicable rows`,
    () => out.includes(`transfer window: fields=${FIELD_ROWS}\n`)],
  /**
   * THE MODEL ACCEPTED THE PATH. The seam echoes back `ui.values()[id]`, not the string it was
   * handed, so this fails rather than lying if `setFieldText` refused the edit -- which it does for
   * a cycle field, for a non-digit in a numeric one, and for an id that is not in the table at all.
   */
  ['the local path reached the model', () => out.includes(`transfer window: localFile=${LOCAL}\n`)],
  ['the host file reached the model', () => out.includes(`transfer window: hostFile=${HOST_FILE}\n`)],
  /**
   * THE SUBMIT WAS REFUSED, AND FOR THE RIGHT REASON. See `REFUSAL` above for why the text is
   * pinned and not merely `ok=false`.
   */
  [`submit refused with '${REFUSAL}'`,
    () => out.includes(`transfer window: submit -> ok=false status=${REFUSAL}\n`)],
  /**
   * THE FORM IS STILL USABLE AFTER THE REFUSAL -- THE CHECK THIS HARNESS DID NOT HAVE.
   *
   * See `STEPS` for the whole argument. `start()` now arms the running state BEFORE awaiting the
   * submit, which is the fix for a synchronous completion being overwritten by its own submit; the
   * refusal arm therefore has to CLEAR that flag, and a refusal that forgot would leave the form
   * frozen for the window's life with EVERY OTHER LINE HERE STILL PASSING. The echo comes back
   * through `ui.values()`, so this fails rather than lying if the model refused the edit.
   *
   * ONE MORE CHECK THAN THIS HARNESS USED TO SCORE: 9 became 10.
   */
  ['the form still accepts an edit after the refusal',
    () => out.includes(`transfer window: hostFile=${AFTER_SUBMIT}\n`)],
  /**
   * A STEP NOBODY CONSUMES. `main.ts` prints this rather than ignoring the step, the same way
   * `clicks: NO BUTTON` reports a label that is not in the layout: a typo in `STEPS` above would
   * otherwise present as a missing field, which reads as a broken form.
   */
  ['every step was understood', () => !out.includes('transfer window: UNKNOWN STEP')],
  /**
   * THE PAGE LOADED. `transfer.html` reaches ACROSS PACKAGES for its import map target
   * (`../frontend/dist/transferForm.js`) and for its own `./dist/transferBoot.js`, so this is a live
   * failure mode and not a theoretical one.
   *
   * `out !== ''` is half the check, for the vacuity reason in this list's docstring.
   */
  ['the window did not fail to load',
    () => out !== '' && !out.includes('transfer window failed to load')],
  /**
   * THE RENDERER DID NOT THROW. `main.ts` forwards the transfer window's console as
   * `transfer[<level>]`, matching the main window's `renderer[<level>]` spelling.
   *
   * `3` IS 'error' ON A SCALE ELECTRON HAS DEPRECATED, and this literal will drift SILENTLY on an
   * upgrade: the test would simply stop matching and a renderer that threw would present as a
   * perfectly clean run. It cannot be loosened to `transfer[` either -- level 2 arrives on every
   * run (Electron's own CSP warning) and would fail every one. `shot.mjs`, `keys.mjs` and
   * `clicks.mjs` filter `renderer[3]` on the same literal for the same reason; the duplication is
   * KNOWN, and if the level moves those are the other places.
   */
  ['the transfer renderer did not throw', () => !out.includes('transfer[3]')],
  /**
   * THE CLIENT QUIT BY ITSELF. See `exited` above for why this is a check and not a bail.
   */
  ['the client exited on its own', () => exitProblem === undefined],
];

let passed = 0;
for (const [name, ok] of CHECKS) {
  const good = ok();
  console.log(`${good ? 'PASS' : 'FAIL'} ${name}`);
  if (good) passed++;
}
if (exitProblem !== undefined) console.log(`     ${exitProblem}`);

if (passed !== CHECKS.length) {
  console.log('\nthe whole output, for context:');
  process.stdout.write(out);
}
console.log(`\n${passed}/${CHECKS.length} checks passed`);
process.exit(passed === CHECKS.length ? 0 : 1);
