import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The SIXTH seam's privacy gate and its two hooks, pinned AS SOURCE TEXT.
 *
 * ## WHY TEXT, AND WHAT THAT IS WORTH
 *
 * Neither file can be imported. `main.ts` calls `app.whenReady()` in its module body, so importing
 * it outside Electron throws, and `driveTransferWindow` is a module-scope function whose only caller
 * is inside that callback's closure. `transferBoot.ts` needs a `document`, and `vitest.config.ts`
 * sets `environment: 'node'` with no jsdom. So this is the same instinct and the same admitted limit
 * as `transferTeardown.test.ts` and the three harness-flags tests: it would pass against a seam that
 * printed the wrong numbers. Its value is the ONE failure it catches, and that failure is a privacy
 * leak rather than a wrong number.
 *
 * ## THE PROPERTY THAT EARNS A TEST RATHER THAN A BY-HAND CHECK
 *
 * `driveTransferWindow` prints a `localFile=` line, which carries A PATH, from a window that is
 * opened in front of a live logged-on session. A normal run must print NONE of it. That was verified
 * by hand under Xvfb -- `TN3270_GUI_SHOT` with no `TN3270_GUI_TRANSFER` printed 0 matching lines --
 * but a by-hand check is outside the fast gate, which is the whole reason the harness-flags tests
 * exist: a thing nobody runs is exempt from every later change until somebody remembers it.
 *
 * The STRUCTURE is what makes this checkable at all, and it is why the seam is a function rather than
 * a block inlined at the end of `openTransferWindow` (which is what the plan for this task asked
 * for). One early return ahead of every write is a property a reader and a regex can both confirm;
 * a condition repeated on each line is a thing every new line has to remember, and the one that
 * forgets is the one that prints a path.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const main = readFileSync(join(guiDir, 'src', 'main.ts'), 'utf8');
const boot = readFileSync(join(guiDir, 'src', 'transferBoot.ts'), 'utf8');

/**
 * `driveTransferWindow`'s body, from its signature to the closing brace at column 0.
 *
 * Anchored on `\n}` rather than on a brace count: every nested brace in that function is indented,
 * since it is declared at module scope. If this ever stops matching, the assertions below fail
 * LOUDLY on the null check rather than silently passing over an empty string.
 */
const driveBody = /async function driveTransferWindow\([\s\S]*?\n\}/.exec(main);

/**
 * `driveSteps`'s body -- the half that does the printing.
 *
 * ## WHY THE GATED REGION IS TWO FUNCTIONS NOW, AND WHY THAT IS STILL SOUND
 *
 * `driveTransferWindow` grew a `transferScenarioRunning` flag (so `quitIfKeysOnly` cannot quit while
 * a live transfer is mid-flight -- it did, and killed one), and the steps moved into `driveSteps`.
 * These five tests reddened on that refactor and were RIGHT to: they read one function's text, and
 * the printing had moved out of it.
 *
 * The property they check is unchanged and is checked here in two parts:
 *   1. `driveTransferWindow` gates on the seam BEFORE it calls anything (asserted below), and
 *   2. `driveSteps` HAS EXACTLY ONE CALLER, which is that gated function (asserted below too).
 *
 * The second half is what keeps this structural rather than a convention. An ungated second caller
 * of `driveSteps` is the leak this file exists to prevent, and it would now be caught by the
 * call-count assertion rather than by the `transfer window:` census alone.
 */
const stepsBody = /async function driveSteps\([\s\S]*?\n\}/.exec(main);

/** The gated region: the two functions that together make up the seam. */
const gatedRegion = (): string => `${driveBody![0]}\n${stepsBody![0]}`;

describe('the transfer seam prints nothing in a normal run', () => {
  it('gates the WHOLE function on the seam, as its first statement', () => {
    expect(driveBody, 'no driveTransferWindow function found in main.ts').not.toBeNull();
    const body = driveBody![0];
    const gateAt = body.indexOf("if (SEAM.transfer === '') return;");
    expect(gateAt, 'the seam must refuse to run when TN3270_GUI_TRANSFER is unset')
      .toBeGreaterThan(-1);
    // BEFORE EVERYTHING THAT PRINTS, which is the actual property. The writes live in
    // `driveSteps` now, so what must precede the gate is the CALL to it -- a gate after that call
    // would leak every line it was meant to suppress.
    // MATCHED ON THE CALL, NOT ITS ARGUMENT LIST, which a later edit is free to change -- it did:
    // `driveSteps` gained the main window and the session so a `host:` step could type a LOGOFF into
    // the live session, and a literal `await driveSteps(tw);` stopped matching. Pinning the argument
    // list here would make this test fail on every signature change while proving nothing more.
    const callAt = body.search(/await driveSteps\(/);
    expect(callAt, 'driveTransferWindow must call driveSteps, or there is nothing to gate')
      .toBeGreaterThan(-1);
    expect(gateAt, 'the gate must come BEFORE the call, or a normal run prints a path')
      .toBeLessThan(callAt);
    // AND `driveSteps` MUST HAVE EXACTLY ONE CALLER, which is what makes its lack of a gate of its
    // own safe rather than merely conventional. A second, ungated caller is the leak this file is
    // about, and splitting the function is precisely what would make one easy to add by accident.
    expect(stepsBody, 'no driveSteps function found in main.ts').not.toBeNull();
    const callers = main.match(/driveSteps\(/g) ?? [];
    expect(callers.length, 'driveSteps must be declared once and called from exactly one place')
      .toBe(2);
  });

  it('writes to stdout from NOWHERE outside that gated function', () => {
    // THE REAL GUARD, and the reason the previous test is not sufficient on its own: a second copy of
    // the reporting -- a stray `transfer window: localFile=` added to `openTransferWindow`, or to the
    // `closed` handler -- would pass every assertion above while printing a path on every run.
    //
    // So every `transfer window:` write in the file must be inside the GATED REGION -- the two
    // functions above, which the previous test proves are reachable only behind the seam check.
    // Counted rather than located, because counting is what makes a new one visible wherever it is
    // put.
    const all = main.match(/process\.stdout\.write\(\s*`?transfer window:/g) ?? [];
    const inside = gatedRegion().match(/process\.stdout\.write\(\s*`?transfer window:/g) ?? [];
    expect(all.length, 'no transfer-window reporting found at all').toBeGreaterThan(0);
    expect(inside.length, 'every `transfer window:` line must live inside the gated function')
      .toBe(all.length);
  });

  it('opens the window from ONE place that asks whether the seam is active', () => {
    // `main.ts`'s own SEAM docstring records why: three places once asked "is the keys seam active?"
    // with their own inline emptiness checks, they agreed only by coincidence, and one of them was
    // the gate keeping a typed password off stdout. This seam has two call sites (the replay path and
    // the live path) and therefore one wrapper.
    expect(main).toMatch(
      /const maybeOpenTransferWindow = async \(\): Promise<void> => \{\s*\n\s*if \(SEAM\.transfer === ''\) return;/,
    );
    const calls = main.match(/await maybeOpenTransferWindow\(\);/g) ?? [];
    expect(calls.length, 'the seam must be reached from the replay path and the live path').toBe(2);
  });

  it('keeps the step parser from TRUNCATING a value that contains "="', () => {
    // `step.split('=', 2)` -- which the plan for this task used -- is NOT Python's maxsplit. The
    // second argument limits the OUTPUT: `'path=/tmp/a=b'.split('=', 2)` is `['path', '/tmp/a']`,
    // silently discarding `=b`. Verified under node. A Windows path, or any value containing `=`,
    // would have been set to a prefix -- and the seam's echo would have AGREED with the truncation,
    // because it reports what the model holds.
    expect(stepsBody![0]).toMatch(/const at = step\.indexOf\('='\);/);
    expect(stepsBody![0]).toMatch(/step\.slice\(at \+ 1\)/);
    // ON THE CODE WITH ITS COMMENTS STRIPPED, and this was measured rather than anticipated: the
    // assertion failed first time against a `main.ts` that is correct, because the comment above the
    // parser QUOTES the spelling it rejects. Deleting that explanation to satisfy a regex would trade
    // the durable half for the convenient one. `transfer-harness-flags.test.ts` hit the same thing
    // three times and carries the same note.
    const code = stepsBody![0]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/split\('=', 2\)/);
  });

  it('ends the run itself, because quitIfKeysOnly will not', () => {
    // MEASURED before this existed: `quitIfKeysOnly` returns early unless the keys or clicks seam is
    // set, so a transfer-only run reached the end of `app.whenReady()`'s callback with two windows
    // open and SAT THERE -- the harness burned its full 120-second timeout. A stall, not an error.
    //
    // The DRAIN is part of it: writing to a pipe is asynchronous, and `quitIfKeysOnly`'s own
    // measurement found output truncated at one 64000-byte buffer with the last line GONE, three
    // runs out of three. The `submit ->` line is the last thing this function prints.
    // IN `driveTransferWindow` AND AFTER THE `finally`, which is where the flag is cleared: a quit
    // issued while `transferScenarioRunning` was still set would deadlock against
    // `quitIfKeysOnly`'s wait on exactly that flag.
    expect(driveBody![0]).toMatch(/process\.stdout\.write\('',\s*\(\) => \{ r\(\); \}\)/);
    expect(driveBody![0]).toMatch(/app\.quit\(\);/);
    // And it must leave a SHOT run alone, or the two seams race and the PNG is zero bytes.
    expect(driveBody![0]).toMatch(/if \(SEAM\.shot !== ''\) return;/);
    const clearAt = driveBody![0].indexOf('transferScenarioRunning = false;');
    const quitAt = driveBody![0].indexOf('app.quit();');
    expect(clearAt, 'the scenario flag must be cleared').toBeGreaterThan(-1);
    expect(clearAt, 'the flag must be cleared BEFORE the quit, or quitIfKeysOnly waits forever')
      .toBeLessThan(quitAt);
  });
});

describe("the harness hooks go through the form's own object", () => {
  it('sets a field through ui.type and returns what the MODEL holds', () => {
    // A hook that wrote to the DOM directly, or that returned `void`, would let a scenario pass over
    // a form that ignored every step: `setFieldText` refuses a cycle field, a non-digit in a numeric
    // one, and an id that is not in the table. Measured on this very task -- the plan's `host=` step
    // echoed back `tso`, the value that was always there, because `host` is a CYCLE field.
    expect(boot).toMatch(/ui\.type\(id as TransferFieldId, text\)/);
    expect(boot).toMatch(/return ui\.values\(\)\[id as TransferFieldId\] \?\? ''/);
  });

  it('answers a submit with ui.running() and NOT by string-matching the status', () => {
    // THE PLAN FOR THIS TASK MATCHED `'transferring'` ON THE STATUS TEXT. Three things wrong with
    // it: the literal is duplicated out of `transferUi.ts`, so the two drift silently; it is a
    // DECISION in the one file whose discipline is to hold none, where no test can reach it; and
    // `ui.running()` already answers the same question directly, from the same flag the form's own
    // enablement is driven by.
    expect(boot).toMatch(/return \{ ok: ui\.running\(\), status \}/);
    expect(boot).not.toMatch(/startsWith\('transferring'\)/);
    // The status text is still carried, because it is WHICH refusal -- `not in 3270 mode` versus a
    // validator complaint versus 'the transfer window is not open'. `ok` alone is satisfied by all
    // three, i.e. by the form never having been filled in at all.
    expect(boot).toMatch(/document\.querySelector\('#status'\)\?\.textContent \?\? ''/);
  });

  it('exposes exactly the FIVE named hooks and nothing else on window', () => {
    // The surface is the thing to keep small: this window handles file paths and sits in front of a
    // logged-on session, which is why its preload keeps `contextIsolation` on and `nodeIntegration`
    // off. A hook added without thought is one more thing a page could reach.
    //
    // WENT FROM TWO TO FIVE ON 2026-10-02, and each addition was forced by a measured gap in the
    // live run rather than wanted for convenience:
    //   - `__tn3270FieldKind`  -- `setFieldText` is a NO-OP on a cycle field, so `direction=send`
    //                            echoed `receive` and a scenario could believe it had set it.
    //   - `__tn3270CycleField` -- the fix for that, clicking the model the way an arrow key does.
    //   - `__tn3270AwaitDone`  -- `__tn3270Submit` returns when the submit was ACCEPTED, so the
    //                            seam quit mid-transfer and killed a real one against VM/CMS.
    //
    // LISTED BY NAME rather than counted, which is the stronger form and the reason this assertion
    // changed shape as well as number: a count tempts the next person to increment it, while a list
    // makes adding a hook a decision that has to be written down here.
    const hooks = (boot.match(/^window\.(__tn3270\w+) =/gm) ?? [])
      .map((m) => /^window\.(__tn3270\w+)/.exec(m)![1]).sort();
    // SEVEN ON 2026-10-02, and the last two are for the live items 249 bytes could not reach:
    //   - `__tn3270SampleStatus` -- a byte count CLIMBING cannot be seen in one reading, and a
    //                              report that silently stops is the failure this window hides best.
    //   - `__tn3270ClickCancel`  -- clicks the REAL button, because that is the operator's only way
    //                              out of a running transfer and a direct `requestCancel()` would
    //                              pass while the control was disabled or wired to nothing.
    expect(hooks, 'the harness hook surface is fixed; add one only deliberately').toEqual([
      '__tn3270AwaitDone', '__tn3270ClickCancel', '__tn3270CycleField', '__tn3270FieldKind',
      '__tn3270SampleStatus', '__tn3270SetField', '__tn3270Submit',
    ]);
  });

  it('waits for a transfer to END by asking running(), not by reading prose', () => {
    // MEASURED against VM/CMS: `submit -> ok=true status=transferring` was the LAST thing a run
    // printed, because the seam quit as soon as the submit was accepted -- so a real transfer was
    // started and then killed by the harness. No run could observe a COMPLETION, and replay mode
    // cannot see it at all, since there a submit is always refused.
    //
    // `running()` is the same fact the form's enablement uses and `finished()` clears it on EVERY
    // ending, so this cannot miss one by watching the wrong signal; the three endings are different
    // STRINGS and reading the status line would be reading prose.
    expect(boot).toMatch(/while \(ui\.running\(\) && Date\.now\(\) < deadline\)/);
    expect(boot).toMatch(/timedOut: ui\.running\(\)/);
  });

  it('samples the status line as a SEQUENCE, and reports whether Cancel was enabled', () => {
    // A sequence because the property is that a real byte count CLIMBS; distinct-only because at
    // 15ms a frame and a 100ms poll most readings are repeats, and a hundred identical lines in a
    // harness log hide the three that differ.
    expect(boot).toMatch(/if \(seen\[seen\.length - 1\] !== text\) seen\.push\(text\)/);
    // RETURNS EARLY when the transfer ends, or a 3-second transfer holds the scenario for the whole
    // budget and the most interesting sample is followed by nothing but waiting.
    expect(boot).toMatch(/if \(!ui\.running\(\) \|\| Date\.now\(\) >= deadline\) return seen;/);
    // THROUGH THE BUTTON, and `enabled` reported separately: `click()` on a disabled button is a
    // silent no-op, so a cancel that "worked" against a dead control would look identical.
    expect(boot).toMatch(/const enabled = !btn\.disabled;/);
    expect(boot).toMatch(/btn\.click\(\);/);
  });

  it('asks the DOM which control a field is drawn as, not the field table', () => {
    // Reading `TRANSFER_FIELDS` here would need a second runtime import, and `transfer.html`'s
    // import map has ONE entry -- an unresolved specifier blanks this window with no error in any
    // console. The DOM is also the better oracle: it answers what the form actually DREW.
    expect(boot).toMatch(/\[data-field="\$\{id\}"\]\[data-role="value"\]/);
    expect(boot).toMatch(/if \(el instanceof HTMLSelectElement\) return 'cycle';/);
  });
});

describe('a timed-out scenario wait says what was on screen, WITHOUT the password', () => {
  /**
   * THE REDACTION IS LOAD-BEARING AND IT WAS MEASURED, NOT ANTICIPATED.
   *
   * A scenario `wait:` that times out reports and CONTINUES (deliberately -- a transfer may be
   * mid-flight), so every later step runs against the wrong screen. On TSO 2026-10-02 that chain
   * produced a transfer with ZERO DFT frames which was then recorded as a protocol-layer failure
   * ("no DFT frames are arriving"), when the real cause was an ISPF wait expiring during logon.
   * Printing the screen is what makes that one-line-visible instead of a three-line mystery.
   *
   * **But the first version printed a REAL PASSWORD.** It assumed a scenario step runs after the
   * logon, so the screen could only be a host panel. The measured screen was TSO's logon panel with
   * `ENTER CURRENT PASSWORD FOR HERC01- CUL8TR` on it, echoed as ORDINARY TEXT -- because the state
   * a timeout here is most likely to catch is precisely the one the assumption excluded.
   *
   * Asserted against THE REAL MEASURED SCREEN STRING rather than a contrived one, and by applying
   * the regex the source actually uses, so this tests the behavior and not a spelling.
   */
  const SEEN_LIVE_2026_10_02 = 'ENTER CURRENT PASSWORD FOR HERC01- CUL8TR HERC01 LOGON IN '
    + 'PROGRESS AT 18:18:13 ON OCTOBER 2, 2026 NO BROADCAST MESSAGES '
    + '+----------------------------------------------------------------------------+ !';

  /** The redaction exactly as `main.ts` writes it, extracted so the test cannot drift from it. */
  const redactionFrom = (src: string): RegExp => {
    const m = /\.replace\((\/(?:[^/\\]|\\.)+\/[a-z]*),\s*'\$1 <redacted> '\)/.exec(src);
    expect(m, 'no password redaction found in main.ts').not.toBeNull();
    const body = m![1]!;
    const lastSlash = body.lastIndexOf('/');
    return new RegExp(body.slice(1, lastSlash), body.slice(lastSlash + 1));
  };

  it('REDACTS the echoed password out of the measured live screen', () => {
    const out = SEEN_LIVE_2026_10_02.replace(redactionFrom(main), '$1 <redacted> ');
    expect(out, 'the password must not survive into a harness log').not.toContain('CUL8TR');
    expect(out, 'and the prompt itself is kept, so the state is still diagnosable')
      .toContain('ENTER CURRENT PASSWORD FOR HERC01-');
    expect(out).toContain('<redacted>');
  });

  it('leaves an ordinary host panel ALONE, so the diagnostic still diagnoses', () => {
    // The whole point is to print the screen. A redaction that ate every screen would be a
    // regression dressed as a fix -- this is the case the ISPF-wait failure actually wants.
    const ispf = 'ISPF Primary Option Menu USERID : HERC01 TERMINAL : 3277 PANEL : ISP@PRIM';
    expect(ispf.replace(redactionFrom(main), '$1 <redacted> ')).toBe(ispf);
  });

  it('prints essentially the WHOLE panel, because 240 characters hid the answer', () => {
    // THE TRUNCATION WAS ITSELF A DEFECT. The TSO failure was narrowed to "`X` does not exit this
    // ISPF", and the one thing that would have named the real exit -- the panel's own option list --
    // sat PAST THE CUT in every capture. Four TK5 userids were spent on hypotheses that one full
    // panel would have settled. Pinned as a MINIMUM so a later "tidy up the log line" cannot
    // reintroduce it, and read off the constant rather than the call sites so both stay in step.
    const m = /const SCREEN_DUMP_CHARS = (\d+);/.exec(main);
    expect(m, 'no SCREEN_DUMP_CHARS constant found').not.toBeNull();
    expect(Number(m![1]), 'a 24x80 panel is 1920 cells; anything much less truncates the evidence')
      .toBeGreaterThanOrEqual(1900);
    // BOTH arms must use it. The `host:` arm was added second and is the one that caught the ISPF
    // refusal, so a constant applied to only one of them would leave the important half short.
    const uses = main.match(/seen\.slice\(0, SCREEN_DUMP_CHARS\)/g) ?? [];
    expect(uses.length, 'both the wait: and host: timeout arms must print the full screen').toBe(2);
    // AND NO BARE NUMBER LEFT BEHIND, which is how one site silently keeps the old cap.
    expect(main).not.toMatch(/seen\.slice\(0, \d+\)/);
  });

  it('WAITS FOR THE KEYBOARD after Clear, instead of a fixed delay', () => {
    // THIS IS WHY EVERY TSO `host:` STEP TYPED NOTHING. Clear is an AID: it locks the keyboard
    // (`X Wait`) until the host repaints. On VM's `MORE...` the answer is instant, so a flat 600ms
    // was never caught there; on TK5's ISPF the host redraws a full panel, the characters went out
    // while the keyboard was still inhibited, and `Option ===>` came back EMPTY. Same
    // fixed-delay-versus-condition mistake `live-drive.py` names and that `drain:` was just fixed for.
    const steps = stepsBody![0];
    const hostAt = steps.indexOf("step.startsWith('host:')");
    expect(hostAt).toBeGreaterThan(-1);
    const arm = steps.slice(hostAt);
    expect(arm, 'the step must poll the OIA, not sleep a guessed interval')
      .toMatch(/while \(session\.oia\.isInhibited\(\)/);
    // A DEADLINE, not an unbounded wait: a host that never unlocks must still reach the report
    // rather than hanging the whole scenario, which is this seam's standing rule for every wait.
    expect(arm).toMatch(/Date\.now\(\) < unlockBy/);
    // AND THE CLEAR MUST COME FIRST, which is the property the fixed delay was protecting: VM's
    // MORE... eats input, and that once swallowed a LOGOFF and left an account logged on.
    const clearAt = arm.indexOf("keyCode: 'c', modifiers: ['control']");
    const waitAt = arm.indexOf('session.oia.isInhibited()');
    const typeAt = arm.indexOf("for (const ch of [...cmd");
    expect(clearAt).toBeGreaterThan(-1);
    expect(clearAt, 'Clear, then wait for the unlock, then type').toBeLessThan(waitAt);
    expect(waitAt, 'the unlock wait must precede the typing').toBeLessThan(typeAt);
  });

  it('prints the screen on the TIMEOUT arm only, not on a successful wait', () => {
    // A successful wait prints which needle MATCHED and nothing else: the screen at that moment is
    // by definition the one the scenario asked for, and printing it on every step would put a
    // host panel in the log 20 times a run -- including, on the keys seam, a password prompt.
    const steps = stepsBody![0];
    const timeoutArm = steps.indexOf('wait TIMED OUT for');
    expect(timeoutArm).toBeGreaterThan(-1);
    expect(steps.slice(timeoutArm, timeoutArm + 400)).toMatch(/screen was/);
    const sawAt = steps.indexOf('transfer window: saw ');
    expect(sawAt).toBeGreaterThan(-1);
    expect(steps.slice(sawAt, sawAt + 120)).not.toMatch(/screen was/);
  });
});

describe('drain: stops on the TARGET arriving, not on a needle vanishing', () => {
  /**
   * THE STOPPING RULE IS THE WHOLE BUG. `drain:***` stops when `***` is ABSENT, and an absent prompt
   * is indistinguishable from one that has not been painted yet. Measured on TK5 2026-10-02 at both
   * payload sizes: the screen after the TSO password carried no `***` at all, so the drain broke on
   * its first poll, pressed nothing, and the welcome banner arrived with nobody left to dismiss it --
   * which ended as a transfer with zero DFT frames, recorded as a protocol fault and blamed on size.
   *
   * These read the source because `main.ts` cannot be imported (it calls `app.whenReady()` in its
   * module body), which is this file's established pattern.
   */
  const drainArm = (): string => {
    const body = stepsBody![0];
    const at = body.indexOf("step.startsWith('drain:')");
    expect(at, 'no drain arm found in driveSteps').toBeGreaterThan(-1);
    // ANCHORED ON THE NEXT ARM, not a character count: a fixed slice silently truncates when the arm
    // grows, and three of these tests failed that way first -- a false negative that reads exactly
    // like the feature being absent.
    const next = body.indexOf("step.startsWith('host:')", at);
    expect(next, 'no host: arm after the drain arm').toBeGreaterThan(at);
    return body.slice(at, next);
  };

  it('parses a `>` into a separate TARGET, keeping the one-needle form intact', () => {
    const arm = drainArm();
    expect(arm).toMatch(/const gt = spec\.indexOf\('>'\);/);
    // The OLD spelling must still mean what it meant: with no `>`, target is empty and the absence
    // rule applies. `drain:` is a seam other scenarios may use, so redefining it silently would
    // break them -- the same reasoning that kept `-ddm`'s default explicit.
    expect(arm).toMatch(/const needle = gt < 0 \? spec : spec\.slice\(0, gt\);/);
    expect(arm).toMatch(/const target = gt < 0 \? '' : spec\.slice\(gt \+ 1\);/);
  });

  it('tests the TARGET before the prompt, so it cannot press into the panel it wanted', () => {
    // Order matters and is not stylistic: once ISPF is up, a further Enter SELECTS AN OPTION and
    // navigates away from the panel the next step needs. A screen can show both while repainting.
    const arm = drainArm();
    const targetAt = arm.indexOf("targetNeedles.some(");
    const needleAt = arm.indexOf("seen.includes(needle)");
    expect(targetAt).toBeGreaterThan(-1);
    expect(needleAt).toBeGreaterThan(-1);
    expect(targetAt, 'the target check must come first, or the drain overshoots')
      .toBeLessThan(needleAt);
  });

  it('KEEPS POLLING when neither is on screen, but only when a target was given', () => {
    // This is the actual fix. "Neither" with a target means the host is still working -- the case
    // that broke -- so it must not break out. Without a target it is the ORIGINAL stopping rule and
    // must remain one, or every existing `drain:` burns the whole poll budget before continuing.
    const arm = drainArm();
    expect(arm).toMatch(/if \(target === ''\) break;/);
  });

  it('REPORTS whether the target was reached, so a drain that gave up is visible', () => {
    // It continues rather than failing the run (a transfer may be mid-flight), so the log line is
    // the only evidence. A silent give-up is what let three runs be misdiagnosed.
    const arm = drainArm();
    expect(arm).toMatch(/NEVER REACHED/);
    expect(arm).toMatch(/arrived/);
  });

  it('the TARGET takes `|` ALTERNATIVES, because one panel name was not enough', () => {
    // MEASURED, not anticipated: with a bare `>Primary Option` the live drain reported
    // `NEVER REACHED` while the very next step `saw "USERID"`. The panel HAD arrived, under another
    // of the three names the scenario already lists for it -- so a one-name target drains to its
    // full poll budget on a finished host and prints a line contradicting the step after it.
    const arm = drainArm();
    expect(arm).toMatch(/target\.split\('\|'\)/);
    expect(arm).toMatch(/targetNeedles\.some\(\(n\) => seen\.includes\(n\)\)/);
    // EMPTIES DROPPED, as `waitForScreen` does: an empty alternative matches every screen including
    // a blank one, which is the vacuous-wait failure the seam exists to avoid.
    expect(arm).toMatch(/\.filter\(\(n\) => n !== ''\)/);
  });

  it('the TSO scenario uses the target form, which is what it was built for', () => {
    const harness = readFileSync(
      join(guiDir, 'scripts', 'live-transfer.py'), 'utf8');
    expect(harness).toMatch(/drain:\*\*\*>Primary Option\|USERID\|BROWSE/);
    // THE SAME SET THE WAIT USES. If the two disagree about what "arrived" means, the drain either
    // gives up on a ready host or presses into the panel the wait is about to require.
    expect(harness).toMatch(/wait:Primary Option\|USERID\|BROWSE/);
    // AND THE LEADING `wait:` IS GONE: it existed to synchronise before the drain, and a wait for a
    // panel sitting BEHIND a prompt can never succeed -- it burned its whole budget, which is how
    // the failure began. The trailing one stays, as the thing that surfaces a drain that gave up.
    expect(harness).not.toMatch(/wait:Primary Option\|USERID\|BROWSE,drain:/);
  });
});
