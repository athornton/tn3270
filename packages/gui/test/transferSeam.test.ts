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

describe('the transfer seam prints nothing in a normal run', () => {
  it('gates the WHOLE function on the seam, as its first statement', () => {
    expect(driveBody, 'no driveTransferWindow function found in main.ts').not.toBeNull();
    const body = driveBody![0];
    const gateAt = body.indexOf("if (SEAM.transfer === '') return;");
    expect(gateAt, 'the seam must refuse to run when TN3270_GUI_TRANSFER is unset')
      .toBeGreaterThan(-1);
    // BEFORE EVERY WRITE, which is the actual property: a gate that came after the first
    // `process.stdout.write` would leak the line it was meant to suppress.
    const firstWriteAt = body.indexOf('process.stdout.write');
    expect(firstWriteAt, 'the seam must write something, or there is nothing to gate')
      .toBeGreaterThan(-1);
    expect(gateAt, 'the gate must come BEFORE the first write, or a normal run prints a path')
      .toBeLessThan(firstWriteAt);
  });

  it('writes to stdout from NOWHERE outside that gated function', () => {
    // THE REAL GUARD, and the reason the previous test is not sufficient on its own: a second copy of
    // the reporting -- a stray `transfer window: localFile=` added to `openTransferWindow`, or to the
    // `closed` handler -- would pass every assertion above while printing a path on every run.
    //
    // So every `transfer window:` write in the file must be INSIDE `driveTransferWindow`. Counted,
    // rather than located, because counting is what makes a new one visible wherever it is put.
    const all = main.match(/process\.stdout\.write\(\s*`?transfer window:/g) ?? [];
    const inside = driveBody![0].match(/process\.stdout\.write\(\s*`?transfer window:/g) ?? [];
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
    expect(driveBody![0]).toMatch(/const at = step\.indexOf\('='\);/);
    expect(driveBody![0]).toMatch(/step\.slice\(at \+ 1\)/);
    // ON THE CODE WITH ITS COMMENTS STRIPPED, and this was measured rather than anticipated: the
    // assertion failed first time against a `main.ts` that is correct, because the comment above the
    // parser QUOTES the spelling it rejects. Deleting that explanation to satisfy a regex would trade
    // the durable half for the convenient one. `transfer-harness-flags.test.ts` hit the same thing
    // three times and carries the same note.
    const code = driveBody![0]
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
    expect(driveBody![0]).toMatch(/process\.stdout\.write\('',\s*\(\) => \{ r\(\); \}\)/);
    expect(driveBody![0]).toMatch(/app\.quit\(\);/);
    // And it must leave a SHOT run alone, or the two seams race and the PNG is zero bytes.
    expect(driveBody![0]).toMatch(/if \(SEAM\.shot !== ''\) return;/);
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

  it('exposes exactly those two hooks and nothing else on window', () => {
    // The surface is the thing to keep small: this window handles file paths and sits in front of a
    // logged-on session, which is why its preload keeps `contextIsolation` on and `nodeIntegration`
    // off. A third hook added without thought is a third thing a page could reach.
    const hooks = boot.match(/^window\.__tn3270\w+ =/gm) ?? [];
    expect(hooks.length, 'exactly two harness hooks belong on window').toBe(2);
  });
});
