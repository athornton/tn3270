# GUI Key-Chord Seam and Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `TN3270_GUI_KEYS` able to hold Ctrl/Alt/Shift/Meta, and put a committed
harness behind the GUI's chord keys — PA1-3 above all — that goes red when they break.

**Architecture:** A pure `parseKeySpec` in a new `packages/gui/src/keyspec.ts` turns
`'Alt+1'` into Electron's `{ keyCode, modifiers }`; `main.ts` logs every action arriving at
`ipcMain` **only while the seam is active**; a new `packages/gui/scripts/keys.mjs` drives the
app under Xvfb in replay mode and asserts the exact ordered action sequence. Xvfb startup
moves to a shared `packages/gui/scripts/xvfb.mjs`.

**Tech Stack:** TypeScript, Electron 44.0.0, vitest, Xvfb from `~/micromamba/envs/gui`.

**Spec:** `docs/superpowers/specs/2026-09-15-gui-key-chord-seam-and-guard-design.md`

**Baseline before starting:** `main` had 1328 tests in 53 files, `npm run typecheck` clean,
`npm run build` clean, both GUI goldens matching. Work happens on branch
`gui-key-chord-guard`, which already carries the spec commit.

---

## Facts you must not re-derive (measured 2026-09-15, Electron 44.0.0, Xvfb)

Read these before Task 1. Getting any of them wrong produces a test that passes while
proving nothing, which is the failure this whole plan exists to prevent.

- `sendInputEvent({ type: 'keyDown', keyCode: '1', modifiers: ['alt'] })` delivers
  `key: '1'`, `code: 'Digit1'`, `altKey: true`. **The chord works; `code` is populated.**
- `keyCode: 'Digit1'` delivers `key: ''`, `code: ''`, `keyCode: 0` — an **empty event**,
  silently. Same for `ArrowUp`. The valid spellings are `1` and `Up`.
- `keyCode: 'A'` and `keyCode: 'a'` both deliver `key: 'a'`. Case in the spelling is ignored.
- `F13` and `Ctrl+Z` are delivered correctly and must map to **no action** —
  `actionForKey` returns `null` for both (`keys.ts`: `n > 12` is rejected, and an unmapped
  Ctrl chord is dropped rather than typing its letter).
- **`applyAction` swallows every exception** (`packages/frontend/src/actions.ts`, the
  `catch { void err }` at the end). In replay mode `session.sendAID` throws
  `'not connected'`, that throw is swallowed, and the process does **not** crash. This is
  why the action log is the observable: a PA key in replay mode has no other consequence.
- `ipcMain.on('action')` at `packages/gui/src/main.ts:198` is the single funnel every
  renderer action passes through.
- Xvfb: start it detached and **prove the socket** at `/tmp/.X11-unix/X99`. A
  `pgrep -f "Xvfb :99"` guard matches the shell command containing the pattern, skips the
  start, and Electron then reports "Missing X server" with `DISPLAY` set.

---

## File Structure

**Create:**
- `packages/gui/src/keyspec.ts` — pure parser, one job: one seam spelling →
  `{ keyCode, modifiers }`. No Electron import, so vitest can test it.
- `packages/gui/test/keyspec.test.ts` — its tests, the refusals above all.
- `packages/gui/scripts/xvfb.mjs` — Xvfb startup and the GL-less env, shared by both
  harnesses so the two copies cannot drift.
- `packages/gui/scripts/keys.mjs` — the chord harness.
- `packages/gui/test/keys-harness-flags.test.ts` — pins `keys.mjs`'s invocation as text.

**Modify:**
- `packages/gui/src/main.ts` — action log at `ipcMain`; `maybeSendKeys` uses `parseKeySpec`
  and lifts out of `maybeCapture`; a keys-only quit path.
- `packages/gui/scripts/shot.mjs` — import Xvfb startup instead of owning it.
- `docs/live-testing.md`, `docs/HANDOFF.md`, `README.md` — record the spelling table and
  retire the "unguarded" wording.

**Do not touch:** `packages/gui/src/keys.ts` (except in Task 8's temporary mutation, which
is reverted), `packages/gui/src/renderer.ts`, and anything in `core` or `frontend`.

---

### Task 1: `parseKeySpec`

**Files:**
- Create: `packages/gui/src/keyspec.ts`
- Test: `packages/gui/test/keyspec.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gui/test/keyspec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseKeySpec } from '../src/keyspec.js';

/**
 * The parser for the `TN3270_GUI_KEYS` seam.
 *
 * THE REFUSALS ARE THE POINT OF THIS FILE. Measured on Electron 44.0.0: a DOM code name
 * like `Digit1` or `ArrowUp` is not an invalid keyCode, it is an EMPTY one -- Chromium
 * delivers `key: ''`, `code: ''`, `keyCode: 0`, `actionForKey` returns null, no action is
 * sent, and the harness still exits 0 reporting that it sent the key. Our own keymap is
 * written in terms of `e.code`, so that spelling is the one a reader reaches for first.
 */
describe('parseKeySpec', () => {
  it('parses a bare key with no modifiers', () => {
    expect(parseKeySpec('1')).toEqual({ keyCode: '1', modifiers: [] });
  });

  it('parses the Alt chord the PA keys need', () => {
    expect(parseKeySpec('Alt+1')).toEqual({ keyCode: '1', modifiers: ['alt'] });
  });

  it('keeps multiple modifiers in the order written', () => {
    expect(parseKeySpec('Ctrl+Shift+F1')).toEqual({
      keyCode: 'F1', modifiers: ['control', 'shift'],
    });
  });

  it('accepts every spelling of each modifier, case-insensitively', () => {
    expect(parseKeySpec('CTRL+c').modifiers).toEqual(['control']);
    expect(parseKeySpec('control+c').modifiers).toEqual(['control']);
    expect(parseKeySpec('Option+2').modifiers).toEqual(['alt']);
    expect(parseKeySpec('Cmd+a').modifiers).toEqual(['meta']);
    expect(parseKeySpec('Command+a').modifiers).toEqual(['meta']);
    expect(parseKeySpec('Super+a').modifiers).toEqual(['meta']);
  });

  it('passes the key through VERBATIM, including punctuation', () => {
    // ']' arrives as code BracketRight; nothing here normalises it.
    expect(parseKeySpec('Ctrl+]')).toEqual({ keyCode: ']', modifiers: ['control'] });
  });

  it('handles a literal plus as the key', () => {
    // A naive split-and-pop turns '+' into an empty key and then into an empty event.
    expect(parseKeySpec('+')).toEqual({ keyCode: '+', modifiers: [] });
    expect(parseKeySpec('Ctrl++')).toEqual({ keyCode: '+', modifiers: ['control'] });
  });

  it('de-duplicates a repeated modifier', () => {
    expect(parseKeySpec('Alt+Alt+1').modifiers).toEqual(['alt']);
  });

  it('trims surrounding whitespace', () => {
    expect(parseKeySpec('  Alt+1  ')).toEqual({ keyCode: '1', modifiers: ['alt'] });
  });

  it('REFUSES a DOM code name, naming the valid spelling', () => {
    expect(() => parseKeySpec('Digit1')).toThrow(/Digit1.*empty/i);
    expect(() => parseKeySpec('Digit1')).toThrow(/use '1'/);
    expect(() => parseKeySpec('ArrowUp')).toThrow(/use 'Up'/);
    expect(() => parseKeySpec('KeyA')).toThrow(/use 'a'/);
    // No hint exists for this one, but it is still refused rather than passed through.
    expect(() => parseKeySpec('Numpad0')).toThrow(/empty/i);
    // And the refusal survives a modifier prefix, which is how it would really be written.
    expect(() => parseKeySpec('Alt+Digit1')).toThrow(/use '1'/);
  });

  it('refuses an unknown modifier name rather than passing it to Chromium', () => {
    // 'Ctl+1' would otherwise reach sendInputEvent verbatim and deliver an empty event.
    expect(() => parseKeySpec('Ctl+1')).toThrow(/unknown modifier/i);
  });

  it('refuses modifiers with no key, and an empty spec', () => {
    expect(() => parseKeySpec('Alt+')).toThrow(/no key/i);
    expect(() => parseKeySpec('')).toThrow(/empty/i);
    expect(() => parseKeySpec('   ')).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `cd ~/git/tn3270 && npx vitest run packages/gui/test/keyspec.test.ts`

Expected: FAIL — `Failed to resolve import "../src/keyspec.js"`. If it fails for any other
reason, stop and read the error; a test that fails because of a typo in the test proves
nothing about the implementation.

- [ ] **Step 3: Write the implementation**

Create `packages/gui/src/keyspec.ts`:

```ts
/**
 * One `TN3270_GUI_KEYS` spelling to an Electron `sendInputEvent` chord.
 *
 * ## WHY THIS REFUSES INSTEAD OF TRANSLATING
 *
 * MEASURED on Electron 44.0.0, 2026-09-15: `sendInputEvent` accepts Accelerator key names
 * (`1`, `Up`, `F1`, `]`), and a DOM CODE NAME is not rejected -- it is delivered as an
 * EMPTY event, `key: ''` and `keyCode: 0`. `actionForKey` then returns null, no action is
 * sent, and the harness still reports that it sent the key. A guard written with the wrong
 * spelling therefore passes while proving nothing.
 *
 * That spelling is the natural mistake here, because the GUI's own keymap is written in
 * terms of `e.code` and `e.key`: `Digit1` is exactly what the PA table matches on. So this
 * throws and names the valid form. It does NOT silently map `Digit1` to `1`, because that
 * would teach a spelling only our harness accepts.
 *
 * Modifier names are the ones a person writes; Electron wants lowercase `control`, `alt`,
 * `shift`, `meta`.
 */

/** Electron's modifier names, which are not the names anybody types. */
export type ChordModifier = 'control' | 'alt' | 'shift' | 'meta';

export interface KeySpec {
  /** Passed to `sendInputEvent` verbatim: an Electron Accelerator key name. */
  readonly keyCode: string;
  readonly modifiers: readonly ChordModifier[];
}

const MODIFIER_ALIASES: Readonly<Record<string, ChordModifier>> = Object.freeze({
  ctrl: 'control', control: 'control',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta', super: 'meta',
});

/** The families of DOM code names, all of which arrive empty. */
const DOM_CODE = /^(Digit|Key|Numpad|Arrow)/;

/** The valid spelling for the DOM names somebody is most likely to write. */
function validSpelling(key: string): string | undefined {
  const arrow = /^Arrow(Up|Down|Left|Right)$/.exec(key);
  if (arrow !== null) return arrow[1];
  const digit = /^Digit(\d)$/.exec(key);
  if (digit !== null) return digit[1];
  const letter = /^Key([A-Za-z])$/.exec(key);
  if (letter !== null) return letter[1]!.toLowerCase();
  return undefined;
}

export function parseKeySpec(spec: string): KeySpec {
  const trimmed = spec.trim();
  if (trimmed === '') throw new Error('empty key spec');

  const segments = trimmed.split('+');
  const modifiers: ChordModifier[] = [];
  let i = 0;
  // Consumed GREEDILY FROM THE FRONT, with the remainder rejoined as the key, so that '+'
  // and 'Ctrl++' still name a literal plus. A `pop()` would turn both into an empty key,
  // and an empty key is an empty event.
  while (i < segments.length - 1) {
    const alias = MODIFIER_ALIASES[segments[i]!.toLowerCase()];
    if (alias === undefined) break;
    if (!modifiers.includes(alias)) modifiers.push(alias);
    i += 1;
  }

  const rest = segments.slice(i);
  const key = rest.join('+');
  if (key === '') {
    throw new Error(`key spec '${spec}' names modifiers but no key`);
  }
  // More than one leftover segment is only legitimate when the key IS a plus, which arrives
  // as empty segments. Anything else -- 'Ctl+1' -- is a misspelled modifier, and passing it
  // through verbatim is how it would reach Chromium as an empty event.
  if (rest.length > 1 && !rest.every((s) => s === '')) {
    throw new Error(
      `unknown modifier in key spec '${spec}': use Ctrl, Alt, Shift or Meta`,
    );
  }

  if (DOM_CODE.test(key)) {
    const valid = validSpelling(key);
    throw new Error(
      `key spec '${spec}' uses the DOM code name '${key}', which sendInputEvent delivers ` +
      `as an empty event rather than refusing` +
      (valid !== undefined ? `; use '${valid}'` : ''),
    );
  }

  return { keyCode: key, modifiers };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `cd ~/git/tn3270 && npx vitest run packages/gui/test/keyspec.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check two of the refusals**

A refusal nobody has watched fail is not a guard. Temporarily change `DOM_CODE` to
`/^(Key|Numpad|Arrow)/` (dropping `Digit`), re-run, and confirm the `Digit1` cases FAIL.
Then restore it. Do the same by deleting the `rest.length > 1` block and confirming the
`Ctl+1` case fails.

Run: `cd ~/git/tn3270 && npx vitest run packages/gui/test/keyspec.test.ts`
Expected while mutated: FAIL. After restoring: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
cd ~/git/tn3270
npm run typecheck
git add packages/gui/src/keyspec.ts packages/gui/test/keyspec.test.ts
git commit -m "feat(gui): parse modifier chords for the key seam, refusing DOM code names

Measured: sendInputEvent delivers keyCode 'Digit1' as an EMPTY event rather
than refusing it, so a guard written in the spelling our own keymap uses
passes while proving nothing. This throws and names the valid form.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 2: log every action arriving at `ipcMain`, gated on the seam

**Files:**
- Modify: `packages/gui/src/main.ts:198-204`

- [ ] **Step 1: Add the gate and the log**

In `main.ts`, immediately **above** the `ipcMain.on('action', ...)` block, add:

```ts
  /**
   * Every action the renderer sends, logged for the chord harness -- and ONLY while the
   * keys seam is active.
   *
   * THE GATE IS A PRIVACY REQUIREMENT, NOT TIDINESS. A `type` action carries the text
   * typed, so logging unconditionally would put a password on stdout in a live session --
   * the same hazard that keeps goldens away from live logons.
   *
   * IT REQUIRES REPLAY MODE, AND SEAM-PRESENCE ALONE IS NOT ENOUGH. Corrected in review:
   * `TN3270_GUI_KEYS` has been set against a LIVE host before -- docs/live-testing.md,
   * *Typed input, proved end to end* -- and `keys.ts` builds a `type` action carrying the
   * text for ANY printable keypress, seam-driven or not. A replayed session is connected to
   * nothing, so it is replay that makes a logged keystroke impossible to be a credential.
   *
   * This is the ONE funnel every renderer action passes through, which is why the harness
   * asserts here rather than on pixels: in replay mode nothing is connected, `sendAID`
   * throws 'not connected', and `applyAction` swallows it, so a PA key has no other
   * observable consequence. Key order in the JSON is insertion order and not a contract, so
   * a consumer must compare canonically rather than diffing the raw line.
   */
  const logActions = (process.env['TN3270_GUI_KEYS'] ?? '') !== ''
    && (process.env['TN3270_GUI_REPLAY'] ?? '') !== '';
```

Then replace the body of the handler so the log comes first — **before** the `quit` check,
so a quit is visible too:

```ts
  ipcMain.on('action', (_e, action: Action) => {
    if (logActions) process.stdout.write(`action: ${JSON.stringify(action)}\n`);
    // `quit` is THIS front end's business: applyAction throws on it rather than ignoring
    // it, so a front end that forgot this check fails loudly instead of being unquittable.
    if (action.kind === 'quit') { app.quit(); return; }
    applyAction(session, action);
    send();
  });
```

- [ ] **Step 2: Build and typecheck**

Run: `cd ~/git/tn3270 && npm run build && npm run typecheck`
Expected: both clean.

- [ ] **Step 3: Confirm the log is silent when the seam is off, and prove BOTH halves of the gate**

The two existing goldens run with no `TN3270_GUI_KEYS`, and `shot.mjs` fails a case whose
stdout contains renderer errors. Prove the log adds nothing to a normal run:

Run: `cd ~/git/tn3270 && node packages/gui/scripts/shot.mjs 2>&1 | tail -5`
Expected: `2/2 goldens matched`, and no `action:` lines anywhere in the output.

Then prove the conjunction, because a gate with one half untested is a gate with one half
missing. Both runs need `TN3270_GUI_SHOT` only because the seam is still reachable solely
from inside `maybeCapture` until Task 3:

```bash
# (a) replay + seam -> logging ON: expect a NON-ZERO count
DISPLAY=:99 LD_LIBRARY_PATH=$HOME/micromamba/envs/gui/lib \
TN3270_GUI_REPLAY=packages/fixtures/traces/synthetic-ispf-like.trace \
TN3270_GUI_KEYS='Enter' TN3270_GUI_SHOT=/tmp/gate-a.png TN3270_GUI_SHOT_MS=1200 \
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox --disable-gpu \
  -insecure -model 3278-2-E 127.0.0.1:1 2>&1 | grep -cE "^action:"

# (b) seam set, NO replay -> logging OFF: expect 0
DISPLAY=:99 LD_LIBRARY_PATH=$HOME/micromamba/envs/gui/lib \
TN3270_GUI_KEYS='Enter' TN3270_GUI_SHOT=/tmp/gate-b.png TN3270_GUI_SHOT_MS=1200 \
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox --disable-gpu \
  -insecure -model 3278-2-E 127.0.0.1:1 2>&1 | grep -cE "^action:"
```

- [ ] **Step 4: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/src/main.ts
git commit -m "feat(gui): log actions at the ipcMain funnel while the keys seam is active

Gated because a 'type' action carries the text typed: an unconditional log
would put a password on stdout in a live session.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 3: send chords, and lift the seam out of the screenshot path

**Files:**
- Modify: `packages/gui/src/main.ts:262-272` (`maybeSendKeys`), `:274-283` (the head of
  `maybeCapture`), and the two call sites at `:221` and after `session.connect`.

- [ ] **Step 1: Rewrite `maybeSendKeys`**

Replace the whole function (keep the docstring above it, amended as shown) with:

```ts
/**
 * A THIRD TEST SEAM: `TN3270_GUI_KEYS='Alt+1,Ctrl+A,Enter'` delivers REAL key events.
 *
 * `webContents.sendInputEvent` goes in at the top of Chromium's input pipeline, so this
 * exercises the ONE link nothing else can reach: the renderer's own `keydown` listener,
 * `actionForKey`, the IPC hop and `applyAction`. A seam that injected actions at `ipcMain`
 * instead would skip exactly the part that had never run.
 *
 * SPELLINGS ARE ELECTRON ACCELERATOR NAMES, NOT DOM CODE NAMES -- `1` and `Up`, never
 * `Digit1` or `ArrowUp`, which are delivered as EMPTY events. `parseKeySpec` refuses those
 * by name; see `keyspec.ts` for the measurement.
 *
 * Note that a spelling's CASE IS IGNORED by Chromium: both `A` and `a` deliver `key: 'a'`,
 * so this seam types lowercase unless `Shift+` is given.
 *
 * Deliberately does not type a logon. On VM a completed logon arms the reconnect trap for
 * the next run (docs/live-testing.md), and a golden of a logged-on screen can contain a
 * password.
 */
async function maybeSendKeys(win: BrowserWindow): Promise<void> {
  const keys = process.env['TN3270_GUI_KEYS'];
  if (keys === undefined || keys === '') return;
  // Let the paint settle first: typing into a screen that has no field yet proves nothing,
  // and the OIA would rightly refuse the input. Mirrors TN3270_GUI_SHOT_MS's reason for
  // existing; a replay paints synchronously, so the default only has to cover startup.
  await new Promise((r) => setTimeout(r, Number(process.env['TN3270_GUI_KEYS_MS'] ?? '1200')));
  for (const spec of keys.split(',')) {
    const { keyCode, modifiers } = parseKeySpec(spec);
    // Spread conditionally: an empty `modifiers` array is not the same as absent under
    // exactOptionalPropertyTypes, and the rest of this file builds options the same way.
    const chord = { keyCode, ...(modifiers.length > 0 ? { modifiers: [...modifiers] } : {}) };
    win.webContents.sendInputEvent({ type: 'keyDown', ...chord });
    win.webContents.sendInputEvent({ type: 'char', ...chord });
    win.webContents.sendInputEvent({ type: 'keyUp', ...chord });
    await new Promise((r) => setTimeout(r, 150));
  }
  process.stdout.write(`keys: sent ${keys}\n`);
}
```

Add the import at the top of `main.ts`, beside the other local imports:

```ts
import { parseKeySpec } from './keyspec.js';
```

- [ ] **Step 2: Remove the keys call from inside `maybeCapture`**

In `maybeCapture`, delete these three lines:

```ts
  // Keys AFTER the host has painted: typing into a screen that has no field yet proves
  // nothing, and the OIA would rightly refuse the input.
  await maybeSendKeys(win);
```

and the `await new Promise((r) => setTimeout(r, 800));` that followed it. Keys now happen
before `maybeCapture` is called at all, and `TN3270_GUI_SHOT_MS` still runs before the
capture, so a screenshot run keeps the ordering it had: settle, keys, settle, capture.

- [ ] **Step 3: Add the keys-only quit path**

Add this function immediately after `maybeSendKeys`:

```ts
/**
 * A keys-only run has to quit itself.
 *
 * `maybeCapture` quits when it has taken its picture, but a chord run takes none -- and
 * without this the process hangs, which reads as a broken client rather than a missing
 * exit. The drain is not superstition: `process.stdout.write` to a PIPE is asynchronous,
 * and `app.quit()` is otherwise free to tear the process down with the last `action:` line
 * still buffered, failing the harness on whichever case happened to be last.
 */
async function quitIfKeysOnly(): Promise<void> {
  const keys = process.env['TN3270_GUI_KEYS'] ?? '';
  const shot = process.env['TN3270_GUI_SHOT'] ?? '';
  if (keys === '' || shot !== '') return;
  await new Promise<void>((resolve) => { process.stdout.write('', () => { resolve(); }); });
  await new Promise((r) => setTimeout(r, 200));
  app.quit();
}
```

- [ ] **Step 4: Call both at the two exit points**

In the replay branch, replace:

```ts
    session.replay(readFileSync(replayPath, 'utf8'));
    send();
    await maybeCapture(win);
    return;
```

with:

```ts
    session.replay(readFileSync(replayPath, 'utf8'));
    send();
    await maybeSendKeys(win);
    await maybeCapture(win);
    await quitIfKeysOnly();
    return;
```

And at the end of `app.whenReady()`, replace the final `await maybeCapture(win);` with:

```ts
  await maybeSendKeys(win);
  await maybeCapture(win);
  await quitIfKeysOnly();
```

- [ ] **Step 5: Build, typecheck, and prove the goldens are unmoved**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck
node packages/gui/scripts/shot.mjs
```
Expected: `2/2 goldens matched`. If a golden moved, STOP: this task was meant to leave a
no-keys run byte-identical, and a moved golden means the restructure changed drawing or
timing rather than only reachability.

- [ ] **Step 6: Smoke the seam by hand, before any harness exists**

```bash
cd ~/git/tn3270
[ -S /tmp/.X11-unix/X99 ] || { nohup ~/micromamba/envs/gui/bin/Xvfb :99 -screen 0 1280x1024x24 >/tmp/xvfb.log 2>&1 & sleep 3; }
DISPLAY=:99 LD_LIBRARY_PATH=$HOME/micromamba/envs/gui/lib \
TN3270_GUI_REPLAY=packages/fixtures/traces/synthetic-ispf-like.trace \
TN3270_GUI_KEYS='Alt+1,Ctrl+A,F1' \
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox --disable-gpu \
  -insecure -model 3278-2-E 127.0.0.1:1 2>&1 | grep -E "^(action|keys):"
```
Expected, in this order:
```
action: {"kind":"pa","n":1}
action: {"kind":"attn"}
action: {"kind":"pf","n":1}
keys: sent Alt+1,Ctrl+A,F1
```
**If `Ctrl+A` is missing, do not paper over it:** suspect Electron's default application
menu swallowing the accelerator, confirm by testing `Ctrl+A` alone, and record the finding
in `docs/live-testing.md`. Drop the affected cases from Task 5's list with a comment saying
why rather than changing the app's menu, which is product behaviour and out of scope here.
The process must also exit on its own; if it hangs, `quitIfKeysOnly` is not being reached.

**AS BUILT — a defect in this task's own plan text, found by measurement.** `parseKeySpec`
throws, and `maybeSendKeys` runs inside `app.whenReady()`'s promise, so a refused spelling
became an UNHANDLED REJECTION and `quitIfKeysOnly` never ran: the process printed the
refusal and then HUNG until killed. That is the same failure this task exists to remove,
merely on the error path. The implementation therefore (a) parses **every** spec before
sending any, so a bad third spelling cannot half-deliver the first two, and (b) drains
stderr and calls **`app.exit(2)`** on a refusal. **`Ctrl+A` was NOT swallowed by the default
menu**, so the contingency above did not apply and no case was dropped.

**Exit-code contract, which Task 5 and Task 7 both depend on:** a refused spelling exits
**2** with a message on stderr naming the bad spelling and the valid form, and emits no
`action:` or `keys:` line. A normal chord run exits 0.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/src/main.ts
git commit -m "feat(gui): send modifier chords through the keys seam, and reach it alone

maybeSendKeys was callable only from inside maybeCapture, so keys could not be
driven without also taking a screenshot. It is now its own step with its own
quit path; a run with neither seam set is untouched, which is what keeps both
goldens byte-identical.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 4: extract Xvfb startup into a shared module

**Files:**
- Create: `packages/gui/scripts/xvfb.mjs`
- Modify: `packages/gui/scripts/shot.mjs`

- [ ] **Step 1: Create `packages/gui/scripts/xvfb.mjs`**

```js
/**
 * Xvfb startup and the GL-less Electron environment this box needs.
 *
 * Shared by shot.mjs and keys.mjs so the two copies cannot drift -- and because the traps
 * below each cost a run to find and would be re-learned independently otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The userspace GUI stack: static micromamba env, no root, no system X. */
export const GUI_ENV = join(process.env.HOME ?? '', 'micromamba', 'envs', 'gui');

const SOCKET = '/tmp/.X11-unix/X99';

/** Start Xvfb if there is no display, and PROVE it came up before trusting DISPLAY. */
export function ensureDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  if (!existsSync(SOCKET)) {
    // Detached, because a backgrounded child dies with the shell that started it -- and the
    // symptom is Electron reporting "Missing X server" WITH DISPLAY set, which reads as
    // misconfiguration rather than as a dead server. Cost two runs to spot.
    //
    // Tested by SOCKET and never by `pgrep -f "Xvfb :99"`, which matches the shell command
    // containing the pattern and so reports a server that was never started.
    spawn(join(GUI_ENV, 'bin', 'Xvfb'), [':99', '-screen', '0', '1280x1024x24'],
      { detached: true, stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: join(GUI_ENV, 'lib') } })
      .unref();
    const deadline = Date.now() + 15000;
    while (!existsSync(SOCKET) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
  }
  if (!existsSync(SOCKET)) throw new Error(`Xvfb did not create ${SOCKET}`);
  return ':99';
}

/** The environment every Electron run here needs, plus whatever the caller adds. */
export function guiEnv(extra = {}) {
  return {
    ...process.env,
    DISPLAY: ensureDisplay(),
    LD_LIBRARY_PATH: join(GUI_ENV, 'lib'),
    FONTCONFIG_PATH: join(GUI_ENV, 'etc', 'fonts'),
    FONTCONFIG_FILE: join(GUI_ENV, 'etc', 'fonts', 'fonts.conf'),
    ...extra,
  };
}
```

- [ ] **Step 2: Make `shot.mjs` use it**

In `shot.mjs`: delete the whole `ensureDisplay` function and its docstring, drop `spawn`
from the `node:child_process` import (leaving `spawnSync`), add

```js
import { guiEnv } from './xvfb.mjs';
```

and replace the `env:` block inside `run()` with:

```js
    env: guiEnv({
      TN3270_GUI_REPLAY: kase.trace,
      TN3270_GUI_SHOT: shot,
      TN3270_GUI_SHOT_MS: '2500',
      // CLEARED, not merely unset by us: this env is inherited from the caller's shell, and
      // a stray TN3270_GUI_KEYS there would type into the goldens AND stretch their settle
      // to max(KEYS_MS, SHOT_MS). A golden that silently depends on the operator's
      // environment is not a golden. Found while measuring the settle floor in Task 3.
      TN3270_GUI_KEYS: '',
    }),
```

Also delete the now-unused `const gui = join(...)` line at the top of `run()`.

- [ ] **Step 3: Prove the extraction changed nothing**

```bash
cd ~/git/tn3270
rm -f /tmp/.X11-unix/X99 2>/dev/null; pkill -f "Xvfb :99" 2>/dev/null; sleep 1
node packages/gui/scripts/shot.mjs
```
Expected: `2/2 goldens matched` — and it must pass **from a cold start with no Xvfb
running**, which is the half of `ensureDisplay` that a warm box never exercises.

- [ ] **Step 4: Confirm the existing text guard still holds**

Run: `cd ~/git/tn3270 && npx vitest run packages/gui/test/shot-flags.test.ts`
Expected: PASS, 8 tests. It pins `spawnSync(electron, [main, ...ARGV`, `TN3270_GUI_REPLAY`
and `synthetic-ispf-like.trace`, all of which survive this refactor.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/scripts/xvfb.mjs packages/gui/scripts/shot.mjs
git commit -m "refactor(gui): share Xvfb startup between the harnesses

Two copies of the socket-proving trap would be re-learned independently.
Verified from a COLD start with no Xvfb running, which a warm box never tests.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 5: the chord harness

**Files:**
- Create: `packages/gui/scripts/keys.mjs`

- [ ] **Step 1: Write the harness**

```js
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
  process.stdout.write(stdout);
  process.stderr.write(result.stderr ?? '');
  process.exit(1);
};

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
```

- [ ] **Step 2: Run it**

Run: `cd ~/git/tn3270 && node packages/gui/scripts/keys.mjs`
Expected: `ok       14 chords, 12 actions in order`.

If a Ctrl chord is missing, apply the contingency from Task 3 Step 6: diagnose it, record
the finding, and remove that case with a comment naming the cause. Do **not** delete a
negative case, and do **not** loosen the comparison to a subset match — an ordered
comparison is what makes the two negatives mean anything.

- [ ] **Step 3: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/scripts/keys.mjs
git commit -m "test(gui): a committed harness that drives real chords through Chromium

Alt+1 through the renderer's own keydown listener, the IPC hop and ipcMain --
the links keys.test.ts cannot reach, and the ones that were broken when the PA
keys were bound in core and reachable from no key.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 6: pin the harness inside `npm test`

**Files:**
- Create: `packages/gui/test/keys-harness-flags.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the CHORD harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as `shot-flags.test.ts`: a harness outside the fast gate is exempt from
 * every change until somebody remembers it, and `pty-smoke.py` sat at 1 of 12 for two days
 * proving it. This reads `keys.mjs` as TEXT and pins the things whose absence would
 * disable it silently.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const keys = readFileSync(join(guiDir, 'scripts', 'keys.mjs'), 'utf8');

describe('the chord harness', () => {
  it('keeps the three flags without which it hangs or lies', () => {
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(keys);
    expect(argv, 'no ARGV list found in keys.mjs').not.toBeNull();
    // Point it at a real host without -insecure and default-on TLS HANGS rather than fails.
    expect(argv![0]).toContain("'-insecure'");
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
  });

  it('actually spreads that argv into the process it spawns', () => {
    // Without this half, ARGV could keep saying -insecure while nothing passed it.
    expect(keys).toMatch(/spawnSync\(electron, \[main, \.\.\.ARGV/);
  });

  it('drives a replayed trace, never a live logon', () => {
    expect(keys).toContain('TN3270_GUI_REPLAY');
    expect(keys).toContain('TN3270_GUI_KEYS');
  });

  it('still tests at least one Alt chord, which is the whole point', () => {
    // The PA keys are why this harness exists: they were bound in core and reachable from
    // no key in this front end, and only a real chord through Chromium can show that.
    expect(keys).toMatch(/spec:\s*'Alt\+\d'/);
    expect(keys).toMatch(/kind:\s*'pa'/);
  });

  it('keeps both NEGATIVE cases, which is what makes the order mean anything', () => {
    // Ctrl+Z must be dropped rather than typing 'z'; F13 must not become PF13.
    expect(keys).toMatch(/spec:\s*'Ctrl\+Z',\s*action:\s*null/);
    expect(keys).toMatch(/spec:\s*'F13',\s*action:\s*null/);
  });

  it('refuses a run in which the seam never reported sending keys', () => {
    // Without this, a client that exited early yields zero action lines, zero mismatches
    // over a zero-length comparison, and a false pass.
    expect(keys).toContain("stdout.includes('keys: sent ')");
  });

  it('compares the whole ORDERED sequence rather than a subset', () => {
    expect(keys).toMatch(/Math\.max\(expected\.length, actual\.length\)/);
  });

  it('fails the run when the renderer throws', () => {
    // A renderer exception produces a window that receives keys and does nothing.
    expect(keys).toMatch(/renderer\[3\]/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd ~/git/tn3270 && npx vitest run packages/gui/test/keys-harness-flags.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 3: Mutation-check it**

Remove `'-insecure'` from `keys.mjs`'s `ARGV`, re-run, confirm FAIL. Restore it. Then delete
the `Ctrl+Z` case, re-run, confirm FAIL. Restore it. A text guard that has never been
watched failing is decoration.

Run: `cd ~/git/tn3270 && npx vitest run packages/gui/test/keys-harness-flags.test.ts`
Expected: FAIL while mutated, PASS after each restore. Finish by confirming
`node packages/gui/scripts/keys.mjs` is still green, so no mutation was left behind.

- [ ] **Step 4: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/test/keys-harness-flags.test.ts
git commit -m "test(gui): pin the chord harness's flags, cases and pass condition

Mutation-checked: dropping -insecure or the Ctrl+Z negative turns it red.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 7: prove the guard can fail

**Files:** temporary, reverted edits to `packages/gui/src/keys.ts`

This is the task that decides whether any of the above is evidence. This repo has already
found one test that was unfalsifiable and one that passed vacuously against an
unimplemented branch.

- [ ] **Step 1: Unbind the PA keys**

In `packages/gui/src/keys.ts`, comment out the PA lookup inside `actionForKey`:

```ts
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    // return PA_CODES[e.code] ?? null;
    return null;
  }
```

- [ ] **Step 2: Rebuild and run the harness**

```bash
cd ~/git/tn3270
npm run build
node packages/gui/scripts/keys.mjs; echo "exit=$?"
```
Expected: `FAIL at position 0`, expecting `pa 1` and finding `attn`, and `exit=1`. Record
the actual output in the commit message of Task 8's docs commit — a guard's first observed
failure is worth quoting.

- [ ] **Step 3: Confirm `npm test` alone would NOT have caught it**

Run: `cd ~/git/tn3270 && npm test 2>&1 | tail -5`
Expected: still all green with the PA keys unbound. This is the gap being closed, and it is
worth seeing once: `keys.test.ts` builds a synthetic `KeyLike` and cannot notice.

- [ ] **Step 4: Revert, rebuild, and confirm green**

```bash
cd ~/git/tn3270
git checkout packages/gui/src/keys.ts
npm run build
node packages/gui/scripts/keys.mjs
git status --short
```
Expected: `ok  14 chords, 12 actions in order`, and a clean status for `keys.ts`.

- [ ] **Step 5: Second mutation — the parser's refusal in situ**

```bash
cd ~/git/tn3270
DISPLAY=:99 LD_LIBRARY_PATH=$HOME/micromamba/envs/gui/lib \
TN3270_GUI_REPLAY=packages/fixtures/traces/synthetic-ispf-like.trace \
TN3270_GUI_KEYS='Alt+Digit1' \
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox --disable-gpu \
  -insecure -model 3278-2-E 127.0.0.1:1 2>&1 | grep -iE "digit1|action:"
```
Expected: an error naming `Digit1` and telling you to use `1`, and **no** `action:` line —
the refusal happens before Chromium is asked for an empty event. The process must **exit 2
promptly**, not hang: that error path was itself a defect found while implementing Task 3
(an unhandled rejection in `app.whenReady()`'s promise), so it is worth re-confirming here
rather than assuming.

---

### Task 8: documentation

**Files:**
- Modify: `docs/live-testing.md`, `docs/HANDOFF.md`, `README.md`

- [ ] **Step 1: Add the measurement to `docs/live-testing.md`**

Add a new section titled **The GUI's key chords, and which spellings Chromium accepts**,
containing: the measured spelling table from the spec (reproduce it in full — it is the
reusable artefact); the fact that an invalid spelling delivers an empty event rather than an
error; the note that `A` and `a` both deliver `a`; that `applyAction` swallows the
`'not connected'` throw so the action log is the only observable in replay mode; and the
first observed failure output from Task 7 Step 2, quoted, as the proof the guard bites.
Note also which Ctrl chords, if any, the contingency removed and why.

- [ ] **Step 2: Retire the "unguarded" wording**

In `docs/HANDOFF.md`, the *Where things stand* paragraph currently ends with **"The one
known soft spot: PA's Alt-digit plumbing works — the author confirmed it by hand — but
nothing in `npm test` guards it, because the `TN3270_GUI_KEYS` seam cannot send a modifier
chord."** Replace it with what is now true: the seam sends chords, `keys.mjs` asserts
PA1-3 and nine other keys against real Chromium events, the harness is pinned in `npm test`
by `keys-harness-flags.test.ts`, and its failure has been observed by unbinding the PA
table. Say plainly that `keys.mjs` is **not** part of `npm test` and must be run by hand,
like `shot.mjs` and `pty-smoke.py`.

Do the same at `README.md:160`.

- [ ] **Step 3: Fix the docstring the measurement falsified**

`main.ts`'s seam docstring said `TN3270_GUI_KEYS=A,B,Enter`. Task 3 already replaced the
example; confirm no other file still claims a capital letter comes out capitalised:

Run: `cd ~/git/tn3270 && grep -rn "GUI_KEYS=A" --include=*.ts --include=*.md --include=*.mjs . | grep -v node_modules | grep -v dist/`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
cd ~/git/tn3270
git add docs/live-testing.md docs/HANDOFF.md README.md
git commit -m "docs: the chord seam's measured spellings, and a soft spot closed

Records that an invalid keyCode is delivered as an EMPTY event rather than
refused, quotes the guard's first observed failure, and stops describing the
PA plumbing as unguarded.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 9: whole-branch verification and merge

- [ ] **Step 1: Run everything**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npm test 2>&1 | tail -6
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
```
Expected: build and typecheck clean; **1347 tests** (1328 + 11 `keyspec` + 8
`keys-harness-flags`) in 55 files; `2/2 goldens matched`; `ok 14 chords`; `pty-smoke.py`
12/12. If the test count differs, reconcile it before merging rather than editing the number
into the docs.

- [ ] **Step 2: Read the whole diff**

Run: `cd ~/git/tn3270 && git diff main...HEAD`
Look for: a mutation left behind in `keys.ts`, a stray `console.log`, and any unconditional
action logging (the gate is the privacy property — if `logActions` is gone, stop).

- [ ] **Step 3: Merge and push**

```bash
cd ~/git/tn3270
git checkout main
git merge --no-ff gui-key-chord-guard -m "Merge gui-key-chord-guard: chords through the seam, and a guard that bites

The PA keys worked from a real keypress and nothing would have noticed if they
stopped. TN3270_GUI_KEYS now holds Ctrl/Alt/Shift/Meta, main logs actions at the
ipcMain funnel while that seam is active, and packages/gui/scripts/keys.mjs
asserts an ordered sequence of twelve actions plus two required absences through
Chromium's own event pipeline.

Measured first: sendInputEvent delivers a DOM code name as an EMPTY event rather
than refusing it, so the spelling our keymap uses would have passed while proving
nothing. parseKeySpec refuses it by name.

Generated with AI

Co-Authored-By: SLAC AI"
git push origin main
git branch -d gui-key-chord-guard
git log --oneline -3 && git status --short --branch
```
Expected: merge commit on `main`, `origin/main` in sync, branch deleted.

---

## Self-review notes

Checked against the spec's six numbered pieces and five success criteria:

| spec item | task |
| --- | --- |
| 1. `parseKeySpec` + DOM-code refusal | Task 1 |
| 2. Action log gated on the seam | Task 2 |
| 3. Lifting the seam out of the capture path | Task 3 |
| 4. `keys.mjs`, and `xvfb.mjs` extraction | Tasks 5, 4 |
| 5. `npm test` guards | Tasks 1, 6 |
| 6. Mutation proof | Task 7 |
| Criterion 4 (goldens unmoved) | Task 3 Step 5, Task 4 Step 3 |
| Criterion 5 (docs) | Task 8 |

Names used consistently throughout: `parseKeySpec`, `KeySpec`, `ChordModifier`,
`logActions`, `quitIfKeysOnly`, `guiEnv`, `ensureDisplay`, `GUI_ENV`, `CASES`, `ARGV`,
`canon`. `TN3270_GUI_KEYS_MS` is introduced in Task 3 and consumed in Task 5.
