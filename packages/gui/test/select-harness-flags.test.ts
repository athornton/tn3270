import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the SELECTION harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as `clicks-harness-flags.test.ts`, `keys-harness-flags.test.ts` and
 * `shot-flags.test.ts`: a harness outside the fast gate is exempt from every change until somebody
 * remembers it, and `pty-smoke.py` sat at 1 of 12 for two days proving it. This reads the files as
 * TEXT and pins the things whose absence would disable the run SILENTLY.
 *
 * Silence is the specific hazard here, and more so than for the click harness: `select.mjs` is the
 * ONLY cover anywhere for the selection gesture. Measured -- comment out the `mousedown` selection
 * branch and `npm run build`, `npm run typecheck` and all 2302 unit tests stay green while every
 * selection case fails.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const select = readFileSync(join(guiDir, 'scripts', 'select.mjs'), 'utf8');
const main = readFileSync(join(guiDir, 'src', 'main.ts'), 'utf8');

describe('the selection harness', () => {
  it('keeps the three flags without which it hangs or lies', () => {
    // Without `-insecure` a run pointed at a real host does not fail, it HANGS -- default-on TLS
    // against plaintext Hercules. Without `--no-sandbox` and `--disable-gpu` there is no window at
    // all on this box: no GL, and `show: false` stalls rather than erroring.
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(select);
    expect(argv, 'no ARGV list found in select.mjs').not.toBeNull();
    expect(argv![0]).toContain("'-insecure'");
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
  });

  it('actually spreads that argv into the process it spawns', () => {
    // Without this half, ARGV could keep saying -insecure while nothing passed it: the constant
    // above would still pass its own test and the run would be flagless.
    expect(select).toMatch(/spawnSync\(electron, \[main, \.\.\.ARGV/);
  });

  it('drives a replayed trace, never a live host', () => {
    // TWO reasons, and the second is this feature's own. A replay makes the expected text
    // DETERMINISTIC -- TK5's panel paints a live clock, so no exact assertion is possible against
    // it. And a live screen can hold a password: a copy harness is exactly the thing that would put
    // one on the developer's clipboard.
    //
    // The WIRING and the trace, not just the names, which would still pass from a comment.
    expect(select).toContain('TN3270_GUI_REPLAY');
    expect(select).toMatch(/TN3270_GUI_REPLAY:\s*trace/);
    expect(select).toContain('synthetic-ispf-like.trace');
  });

  it('passes each case\'s rectangle to the seam it exists to drive', () => {
    // Without the wiring the client would launch with no selection seam, print no `select:` line,
    // and fail the seam-ran bail -- loudly, but the diagnosis would point at the client.
    expect(select).toMatch(/TN3270_GUI_SELECT:\s*kase\.select/);
  });

  it('ASSERTS THE EXACT CLIPBOARD TEXT, not merely that something was copied', () => {
    // THE PLAN FOR THIS HARNESS CHECKED `copied=true` AND A NON-EMPTY CLIPBOARD, which passes
    // against an off-by-one rectangle, a transposed row/column, a dropped centring offset, or text
    // taken from the wrong row entirely -- most of the ways this actually breaks. Every case
    // therefore carries a `want` string, and the comparison is an equality against the client's own
    // JSON encoding.
    expect(select).toMatch(/want:\s*'/);
    expect(select).toMatch(/line\.trim\(\) === wantLine/);
    // And the expectations are the fixture's real screen, so a case cannot quietly become vacuous.
    expect(select).toContain(' MENU');
    expect(select).toContain(' OPTION ===>');
  });

  it('keeps a MULTI-ROW case, which is the one a single row cannot replace', () => {
    // A one-row drag proves the move happened at all (the anchor alone is a 1x1 rectangle, which
    // `isEmptyRect` rejects). Only a multi-row case proves the rectangle is normalized and the lines
    // joined in order, and it is where a row/column transposition in `cellAt` stops being invisible.
    // Pinned by the NEWLINE in an expected string, which is what a multi-row copy produces.
    expect(select).toMatch(/want:\s*'[^']*\\n[^']*'/);
  });

  it('BAILS ON A SIGNAL BEFORE READING STATUS, so a crash cannot pass', () => {
    // Measured in this repo: a SIGSEGV gives `status=null, signal='SIGSEGV'` with stdout intact, so
    // a `status !== 0` check alone scored a crashed client as a pass.
    const sigAt = select.indexOf('r.signal');
    const compareAt = select.indexOf('line.trim() === wantLine');
    expect(sigAt).toBeGreaterThan(-1);
    expect(sigAt).toBeLessThan(compareAt);
  });

  it('distinguishes a seam that never ran from a wrong selection', () => {
    // An absent `select:` line means the seam did not fire -- a different failure from a wrong
    // rectangle, and one that would otherwise read as an empty clipboard.
    expect(select).toContain('seam never ran');
  });

  it('sends a mouseMove BETWEEN the press and the release, in MAIN', () => {
    /**
     * A press and a release at two points is NOT a drag: `mousemove` is what advances `focus`, so
     * without it the harness would pass against a renderer that never tracked the drag -- the
     * anchor alone, which `isEmptyRect` then rejects, leaving the feature inert.
     *
     * ASSERTED AGAINST `main.ts` AND NOT `select.mjs`, which is where the plan for this task
     * pointed it. The `sendInputEvent` calls live in main's `maybeSelect`; the harness only sets an
     * environment variable. A regex pointed at the harness would have matched nothing and passed
     * VACUOUSLY FOREVER -- the plan flagged this as a soft spot and said to check, so it was
     * checked.
     */
    expect(main).toMatch(/mouseDown[\s\S]*mouseMove[\s\S]*mouseUp/);
    // `button: 'left'` on the MOVE too: a move with no button held is not a drag either.
    expect(main).toMatch(/type: 'mouseMove'[^}]*button: 'left'/);
  });

  it('lets a selection-only run QUIT, which no other seam would do for it', () => {
    // `quitIfKeysOnly` keys on which seams are set. Before `select` was added to that condition a
    // selection-only invocation drove the drag, printed its line and then SAT until the harness's
    // 90s timeout -- reading as a hung client rather than as a seam nobody taught to quit.
    expect(main).toMatch(/SEAM\.select === ''\)\s*\|\|\s*SEAM\.shot/);
  });
});
