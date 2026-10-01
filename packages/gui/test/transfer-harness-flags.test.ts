import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the TRANSFER harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as `clicks-harness-flags.test.ts`, `keys-harness-flags.test.ts` and
 * `shot-flags.test.ts`: a harness outside the fast gate is exempt from every change until somebody
 * remembers it, and `pty-smoke.py` sat at 1 of 12 for two days proving it. This reads the script as
 * TEXT and pins the things whose absence would disable it SILENTLY -- and silence is the hazard,
 * because `transfer.mjs` is the only cover anywhere for the transfer window's Electron wiring: the
 * second `BrowserWindow`, its preload bridge, `transfer.html`'s import map, `transferBoot.ts`'s
 * module body and the `transfer:submit` IPC hop. Not one of those is reachable from vitest.
 *
 * LIKE ITS THREE SIBLINGS, THIS WOULD PASS AGAINST A HARNESS THAT CHECKED NOTHING. It pins the
 * invocation, not the behavior. The behavior is the by-hand run, whose numbers go in the AS BUILT
 * notes.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = readFileSync(join(guiDir, 'scripts', 'transfer.mjs'), 'utf8');

/**
 * The harness with its COMMENTS REMOVED, for the assertions that pin an ABSENCE.
 *
 * ## WHY THIS IS NEEDED, WHICH WAS MEASURED RATHER THAN ANTICIPATED
 *
 * Three of the `not.toMatch` assertions below failed on their first run, against a harness that was
 * correct. Each pins a spelling the harness must NOT use -- `tso-query-reply`, a negative-lookahead
 * regex, `fields=\d+` -- and `transfer.mjs` DOCUMENTS all three, because each is a defect in the
 * plan this task was given and the reason for rejecting it belongs next to the code that rejects it.
 * So the guard was reddened by the very prose explaining why it exists.
 *
 * Deleting those comments to satisfy a test would be the wrong repair -- it trades the explanation,
 * which is the durable half, for a regex's convenience. So the negatives read the CODE and the
 * positives read the whole file.
 *
 * ## THE LIMIT OF THIS STRIPPER, STATED RATHER THAN HIDDEN
 *
 * It is textual, not a parser: a `/*` or a `//` inside a string literal would confuse it. There is
 * none in `transfer.mjs` today (checked), and the failure mode is a test that reddens on a harness
 * that is fine -- loud, and exactly what happened above -- rather than one that passes on a harness
 * that is broken. A guard whose failure direction is safe is worth having at this price; one whose
 * failure direction was silent would not be.
 */
const code = harness
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the transfer harness', () => {
  it('keeps the three flags without which it hangs or lies', () => {
    // Without `-insecure` a run pointed at a real host does not fail, it HANGS -- default-on TLS
    // against plaintext Hercules. Without `--no-sandbox` and `--disable-gpu` there is no window at
    // all on this box: no GL, and `show: false` stalls rather than erroring.
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(harness);
    expect(argv, 'no ARGV list found in transfer.mjs').not.toBeNull();
    expect(argv![0]).toContain("'-insecure'");
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
  });

  it('actually spreads that argv into the process it spawns', () => {
    // Without this half, ARGV could keep saying -insecure while nothing passed it: the constant
    // above would still pass its own test and the run would be flagless. `clicks.mjs` carries the
    // same pair.
    expect(code).toMatch(/spawnSync\(electron, \[main, \.\.\.ARGV/);
  });

  it('runs in REPLAY mode, which is both a privacy rule and the submit check itself', () => {
    // TWO costs, not one, and the second is easy to miss. A transfer form carries a path and sits in
    // front of a logged-on session, so replay is what makes anything this harness prints safe to
    // look at -- the same argument that keeps goldens away from live logons.
    //
    // It is ALSO what makes the submit check meaningful: `Session.replay()` never assigns
    // `this.telnet`, so `is3270Mode()` is false for the whole run and `startTransfer`'s first guard
    // refuses before the host is told anything. Point this at a live session and the scenario would
    // submit a REAL transfer.
    //
    // The WIRING and the trace, not just the names: the strings alone would still pass if
    // `TN3270_GUI_REPLAY` drifted into a comment.
    expect(code).toMatch(/TN3270_GUI_REPLAY:\s*trace/);
    expect(code).toContain('synthetic-ispf-like.trace');
    // NOT `x3270/tso-query-reply.txt`, which the plan for this task named and which exists -- so a
    // wrong path here would not have announced itself. That file is an excerpt of two records with
    // no negotiation in it (`packages/fixtures/x3270/README.md` says it "would be meaningless as a
    // replay fixture"), and a fixture with no negotiation replays as a BLANK SCREEN.
    //
    // ON `code` AND NOT `harness`, for the reason `code` documents: the harness explains in a
    // comment why it rejects that fixture, and this assertion was reddened by that explanation.
    expect(code).not.toContain('tso-query-reply');
  });

  it('stubs the native dialog, or a Browse would hang on a modal nobody can click', () => {
    expect(code).toMatch(/TN3270_GUI_TRANSFER_PATH:\s*LOCAL/);
  });

  it('passes the scenario to the seam it exists to drive', () => {
    // Without the wiring the client would open no transfer window at all, print none of the lines
    // every check reads, and score 0 -- loudly, but with the diagnosis pointing at the window.
    expect(code).toMatch(/TN3270_GUI_TRANSFER:\s*STEPS/);
    // And the scenario must still FILL THE FORM AND SUBMIT. A STEPS that lost its `submit` would
    // leave the two field checks passing and the submit check failing, which reads as a broken
    // controller rather than as the truncated scenario it is.
    //
    // REAL FIELD IDS, which is the one thing here that was measured rather than reasoned. The plan
    // for this task used `path=` and `host=`, and the run printed `path=` (empty -- not a field id,
    // so `setFieldText` missed and the local path was never set) and `host=tso` (`host` IS a field
    // id, the TSO/VM CYCLE field, which refuses a text edit and echoed back the value that was
    // always there). A plausible-looking line from a form where nothing had been typed.
    expect(harness).toMatch(
      /const STEPS = `localFile=\$\{LOCAL\},hostFile=\$\{HOST_FILE\},submit`/,
    );
  });

  it('bounds the run, because a client that does not exit would HANG it forever', () => {
    // THE PLAN FOR THIS TASK HAD NEITHER A TIMEOUT NOR ANY OTHER BOUND: `spawn` plus
    // `child.on('close')`, which never fires for a process that does not exit. And that was the
    // state of the world when it was written -- `quitIfKeysOnly` returns early unless the keys or
    // clicks seam is set, so a transfer-only run sat with its window open until something killed
    // it. A hang reads as a broken client rather than as the missing exit it is.
    expect(code).toMatch(/timeout:\s*\d+/);
  });

  it('insists the client exited ON ITS OWN, as a scored check rather than a bail', () => {
    // THE EXIT IS PART OF WHAT IS UNDER TEST, which is why this harness differs from its three
    // siblings: they bail on a dead client before scoring anything, because for them a client that
    // died says nothing. Here `quitIfKeysOnly` has to RECOGNISE a transfer-only run, and a bail
    // would both report the hang as "the client never ran to completion" -- a broken client, which
    // is the wrong diagnosis -- and throw away a stdout that has every other answer in it.
    //
    // Pinned as a CHECK, so nobody turns it back into an early bail and loses the scoreboard.
    expect(harness).toMatch(/\['the client exited on its own', \(\) => exitProblem === undefined\]/);
    // And the three shapes must still be ordered most-specific-first, which is what keeps each
    // message about its own cause. MEASURED in `keys.mjs`: a client that printed everything expected
    // and then `kill -SEGV $$` comes back `status: null`, `signal: 'SIGSEGV'`, `error: undefined`
    // with INTACT stdout, so a guard of `status !== null && status !== 0` PASSES a client that died.
    // `error` must come first because ENOENT and ETIMEDOUT -- the missing binary and the hang --
    // both leave `status === null` and `error.message` is the only account of either.
    const errorAt = harness.indexOf('result.error !== undefined');
    const signalAt = harness.indexOf('result.signal !== null');
    const statusAt = harness.indexOf('result.status !== 0');
    expect(errorAt, 'no error check found').toBeGreaterThan(-1);
    expect(signalAt, 'no signal check found').toBeGreaterThan(errorAt);
    expect(statusAt, 'no status check found').toBeGreaterThan(signalAt);
    // A missing `electron` leaves BOTH streams empty, so without this the run's entire account of
    // itself is a scoreboard of zeroes rather than ENOENT.
    expect(harness).toContain('result.error.message');
  });

  it('cannot score its two negative checks on an EMPTY run', () => {
    // THE PLAN'S VERSION COULD. Its `no did-fail-load` check was
    // `/^(?!.*transfer window failed to load).*$/s` over the whole output, and
    // `/^(?!.*x).*$/s.test('')` is TRUE -- verified under node. So a client that produced NOTHING AT
    // ALL scored that check, which is worse than not having it: a check that passes on an empty run
    // certifies. The repair is positive evidence alongside the negative.
    expect(harness).toMatch(/out !== '' && !out\.includes\('transfer window failed to load'\)/);
    // The other negative needs no `out !== ''` of its own: it is scored beside `opened` and
    // `fields=6`, which an empty run fails. What it must NOT be is a lookahead regex -- and this
    // reads `code`, because the harness's own comment about the vacuity QUOTES one.
    expect(code).not.toMatch(/\(\?!/);
  });

  it('pins the FIELD COUNT rather than matching any number of rows', () => {
    // `fields=\d+` -- the plan's spelling -- matches `fields=0`, which is EXACTLY the blank window
    // this harness exists to catch. A `transferBoot.ts` that throws in its module body (the TDZ bug
    // shipped on this very branch) loads fine, answers `did-finish-load` fine, and draws zero rows.
    //
    // Six, because a fresh form is `direction=receive, host=tso` and `applicable()` hides four:
    // `recfm`/`lrecl`/`blksize` need a send, `cr` needs ascii.
    expect(harness).toMatch(/const FIELD_ROWS = 6/);
    expect(harness).toMatch(/transfer window: fields=\$\{FIELD_ROWS\}/);
    // `code`, because the comment above the check in `transfer.mjs` names the rejected spelling.
    expect(code).not.toMatch(/fields=\\d\+/);
  });

  it('pins the submit REFUSAL TEXT, not merely ok=false', () => {
    // `ok=false` alone would also be satisfied by a validator complaint, by 'the transfer window is
    // not open', or by a `buildCommand` throw -- i.e. by the form never having been filled in at
    // all, which is the case this harness is most likely to meet. The text proves the whole chain
    // ran: keywords built, `transferCommand` accepted them, the controller was found over IPC, and
    // `startTransfer` was reached.
    expect(harness).toMatch(/const REFUSAL = 'not in 3270 mode'/);
    expect(harness).toMatch(/submit -> ok=false status=\$\{REFUSAL\}/);
  });

  it('refuses a stale dist/, in all THREE packages this window spans', () => {
    // dist/ is what actually RUNS and nothing here builds it; `keys.mjs` found `dist/keys.js` a day
    // older than `src/keys.ts` in this very tree. `frontend` is the one that matters most: the import
    // map in `transfer.html` points straight at `packages/frontend/dist/transferForm.js`, bypassing
    // the barrel, so a stale copy is a window running yesterday's form logic -- and a MISSING one is
    // a blank window with nothing in any console.
    //
    // PER PACKAGE rather than one max across all three, for `clicks.mjs`'s measured reason: a fresh
    // `gui` build would MASK a stale `frontend` one, since gui's newer output would win the max.
    //
    // `.cts`/`.cjs` on both sides is load-bearing: `'transferPreload.cts'.endsWith('.ts')` is FALSE,
    // which once exempted the preload -- the IPC hop every check here depends on -- from the check
    // entirely. That was a false GREEN.
    expect(harness).toMatch(
      /newest\(join\(root, 'dist'\),\s*'\.js',\s*'\.cjs'\)\s*<\s*newest\(join\(root, 'src'\),\s*'\.ts',\s*'\.cts'\)/,
    );
    expect(harness).toMatch(/for \(const pkg of \[[^\]]*'frontend'[^\]]*\]\)/);
    expect(harness).toMatch(/for \(const pkg of \[[^\]]*'gui'[^\]]*\]\)/);
    expect(harness).toMatch(/for \(const pkg of \[[^\]]*'canvas'[^\]]*\]\)/);
  });

  it('clears the inherited input seams, so a stray shell variable cannot change the run', () => {
    // `shot.mjs`'s measured trap: this env is inherited from the caller, and a stray
    // `TN3270_GUI_KEYS` there would type into the session this run submits from AND stretch its
    // settle. A harness that silently depends on the operator's environment is not a harness.
    expect(code).toMatch(/TN3270_GUI_KEYS:\s*''/);
    expect(code).toMatch(/TN3270_GUI_CLICKS:\s*''/);
  });
});
