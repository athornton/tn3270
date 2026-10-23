# Child-window keystrokes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing reaches the 3270 session whether the terminal window or one of the GUI's child
windows (keypad, keyboard) has focus.

**Architecture:** One new `packages/canvas/src/forwardKeys.ts` with injected deps, called by
`keypadBoot.ts` and `keyboardBoot.ts`. It reuses `actionForKey` and sends through each window's
existing one-function bridge, so no new IPC channel and no `main.ts` change. The form-control
predicate moves out of `renderer.ts` into the new module and is imported back, so the two cannot
diverge.

**Tech Stack:** TypeScript, vitest (`environment: 'node'`, no jsdom), Electron, native ES modules
resolved by per-document import maps.

**Spec:** `docs/superpowers/specs/2026-10-23-child-window-keystrokes-design.md`

---

## READ THIS BEFORE TASK 1 — TWO TRAPS THIS REPO HAS ALREADY PAID FOR

**1. A NEW IMPORT NEEDS A MAP ENTRY IN *BOTH* HTML DOCUMENTS, AND A TEST ENFORCES IT.**
`keyboard.html` maps deep paths (`@tn3270/canvas/dist/keyboardUi.js`) while `keypad.html` maps the
BARE `@tn3270/canvas` to `keypadUi.js`. One specifier cannot name two files, so `forwardKeys` must
be imported by its DEEP path and both documents need a new entry. Two tests already check this —
`gui/test/keypadModule.test.ts` ("uses only specifiers the import map actually resolves") and
`gui/test/keyboardModule.test.ts` — so skipping either map fails the suite rather than only the
window. **Task 3 does both; do not split them.**

**2. `dist/` CAN BE STALE AFTER A REBASE OR A TIMESTAMP SHUFFLE.** Every browser harness refuses to
run with `dist is OLDER than src`. If `npm run build` says everything is up to date and a harness
still refuses, run `npx tsc --build --force packages/canvas packages/gui`.

---

## File Structure

- **Create `packages/canvas/src/forwardKeys.ts`** — the listener and the form-control predicate.
  Zero runtime imports beyond `./keys.js` (which itself has none), so each child window's module
  graph grows by exactly one file.
- **Create `packages/canvas/test/forwardKeys.test.ts`** — unit tests against an injected fake.
- **Modify `packages/canvas/src/renderer.ts`** — import the extracted predicate instead of
  inlining it.
- **Modify `packages/gui/src/keyboardBoot.ts`**, **`packages/gui/src/keypadBoot.ts`** — one
  `forwardKeys` call each.
- **Modify `packages/gui/keyboard.html`**, **`packages/gui/keypad.html`** — one import-map entry
  each.

---

## Task 1: `forwardKeys` and the extracted predicate

**Files:**
- Create: `packages/canvas/src/forwardKeys.ts`
- Create: `packages/canvas/test/forwardKeys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/canvas/test/forwardKeys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { forwardKeys, isEditableTarget, type ForwardKeysDeps } from '../src/forwardKeys.js';
import type { Action } from '@tn3270/frontend';

/** A `keydown` event, as much of one as `actionForKey` and the predicate actually read. */
const ev = (o: {
  key: string; code?: string; ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean;
  tag?: string; editable?: boolean;
}): unknown => ({
  key: o.key,
  code: o.code ?? '',
  ctrlKey: o.ctrl === true,
  altKey: o.alt === true,
  metaKey: o.meta === true,
  shiftKey: o.shift === true,
  target: o.tag === undefined && o.editable === undefined
    ? null
    : { tagName: o.tag, isContentEditable: o.editable === true },
  preventDefault: () => {},
});

/**
 * A fake window, because vitest runs `environment: 'node'`: there is no `window` to listen on.
 *
 * The same injected-deps shape as `keyboardUi.test.ts`'s fake DOM and for the same reason -- what
 * is worth testing is which actions get forwarded and whether the default was prevented, neither
 * of which needs a real event loop. jsdom is deliberately not a dependency of this repo.
 */
function fake(): {
  deps: ForwardKeysDeps;
  readonly sent: Action[];
  readonly prevented: unknown[];
  fire: (e: unknown) => void;
} {
  const sent: Action[] = [];
  const prevented: unknown[] = [];
  let handler: ((e: unknown) => void) | undefined;
  return {
    sent,
    prevented,
    fire: (e) => {
      if (handler === undefined) throw new Error('forwardKeys registered no handler');
      // The real DOM calls `preventDefault` ON the event; the fake records which events had it
      // called, so "only claimed keys are prevented" is checkable.
      handler({ ...(e as object), preventDefault: () => { prevented.push(e); } });
    },
    deps: {
      on: (_type, fn) => { handler = fn as (e: unknown) => void; },
      sendAction: (a) => { sent.push(a); },
    },
  };
}

describe('forwardKeys', () => {
  it('forwards a claimed chord as its action', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'a', code: 'KeyA', ctrl: true }));
    expect(f.sent).toEqual([{ kind: 'attn' }]);
  });

  it('forwards a plain character as a type action', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'A', code: 'KeyA' }));
    expect(f.sent).toEqual([{ kind: 'type', text: 'A' }]);
  });

  it('forwards NOTHING for a key no table claims', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'z', code: 'KeyZ', ctrl: true }));
    expect(f.sent, 'Ctrl-Z is deliberately unclaimed').toEqual([]);
  });

  /*
    PREVENTDEFAULT ONLY FOR CLAIMED KEYS, asserted in BOTH directions.

    `renderer.ts` records why: preventing everything would break shortcuts we do not use and would
    stop Tab moving focus. A test that only checked the claimed case would pass an implementation
    that prevented every key.
  */
  it('prevents the default for a claimed key', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'a', code: 'KeyA', ctrl: true }));
    expect(f.prevented.length, 'a claimed key must be ours').toBe(1);
  });

  it('does NOT prevent the default for an unclaimed key', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'z', code: 'KeyZ', ctrl: true }));
    expect(f.prevented.length, 'an unclaimed key must reach the browser').toBe(0);
  });

  /*
    A FORM CONTROL IS SKIPPED EVEN WHEN THE KEY IS CLAIMED, which is the half that matters: a
    plain letter IS claimed (`{kind:'type'}`), so an implementation missing this check would send
    every character an operator typed into a field to the mainframe AND suppress it locally --
    exactly the live bug `renderer.ts` records from 2026-10-07.
  */
  it('skips an event aimed at a form control, claimed or not', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const f = fake();
      forwardKeys(f.deps);
      f.fire(ev({ key: 'A', code: 'KeyA', tag }));
      expect(f.sent, `${tag} must be left alone`).toEqual([]);
      expect(f.prevented.length, `${tag} must keep its default`).toBe(0);
    }
  });

  it('skips a contentEditable target too', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'A', code: 'KeyA', tag: 'DIV', editable: true }));
    expect(f.sent).toEqual([]);
  });

  it('listens for keydown and nothing else', () => {
    const types: string[] = [];
    forwardKeys({ on: (type) => { types.push(type); }, sendAction: () => {} });
    expect(types).toEqual(['keydown']);
  });
});

describe('isEditableTarget', () => {
  // EXPORTED AND TESTED DIRECTLY because `renderer.ts` imports it: it is a shared rule now, not a
  // private detail, and a change there must fail here rather than in a browser.
  it('is true for the three form tags and for contentEditable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget({ tagName }), tagName).toBe(true);
    }
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for a plain element, for null, and for a missing tagName', () => {
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });

  it('is false for a BUTTON, which every cap on these surfaces is', () => {
    // THE CASE THAT WOULD BREAK THE FEATURE if the predicate were widened to "any control":
    // the keyboard window is 118 buttons, and one of them has focus after every click.
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/canvas/test/forwardKeys.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Failed to resolve import "../src/forwardKeys.js"`. The module does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `packages/canvas/src/forwardKeys.ts`:

```ts
import { actionForKey, type KeyLike } from './keys.js';
import type { Action } from '@tn3270/frontend';

/**
 * Forward a window's real keystrokes to the 3270 session.
 *
 * ## WHY THIS EXISTS: THE GUI'S CHILD WINDOWS WERE DEAF
 *
 * `renderer.ts` has the product's ONLY other `keydown` listener and it lives in the CANVAS
 * window. The GUI's keypad and keyboard are separate `BrowserWindow`s, so with either focused the
 * physical keyboard did nothing at all -- not a dropped chord, silence. The user met it the day
 * the keyboard window shipped: a window full of keys is an invitation to type.
 *
 * **The web gateway never had this problem and needs nothing from this module.** Its surfaces are
 * `<div>` overlays in the canvas page, so one `window` listener already covers them. The
 * asymmetry is Electron's, and it is the GUI's alone.
 *
 * ## INJECTED DEPS, LIKE `keypadUi.ts` AND `keyboardUi.ts`
 *
 * Nothing here touches a real `window`: the caller supplies `on` and `sendAction`. That is what
 * lets this be unit-tested in `environment: 'node'` with a hand-rolled fake, and jsdom is
 * deliberately not a dependency of this repo.
 *
 * ## IT IMPORTS ONLY `keys.js`, WHICH IS THE WHOLE REASON IT IS A NEW FILE
 *
 * The obvious alternative was to export the listener from `renderer.ts`. That file value-imports
 * `blit.js` and `selection.js`, so a child window importing it would drag the whole rasteriser
 * into a document that has no canvas -- and every new specifier needs its own entry in two import
 * maps. `keys.js` has ZERO runtime imports, so each window's graph grows by exactly one file.
 */
export interface ForwardKeysDeps {
  /** Register the listener. The real caller passes `window.addEventListener`. */
  readonly on: (type: string, handler: (e: never) => void) => void;
  /** Deliver an action. The real caller passes its window's bridge. */
  readonly sendAction: (action: Action) => void;
}

/**
 * Is this event's target a thing the operator is typing INTO?
 *
 * ## EXTRACTED FROM `renderer.ts` RATHER THAN COPIED, 2026-10-23
 *
 * That file had this inline and now imports it. Two copies of a rule that must agree is how they
 * diverge, and this one is load-bearing: MEASURED 2026-10-07, without it typing into the web
 * gateway's transfer form sent every character TO THE MAINFRAME and left the field empty, because
 * `actionForKey` claims any single-code-point key as `{kind:'type'}` without knowing what was
 * focused, and the `preventDefault` that follows suppressed the character locally.
 *
 * ## CHECKED HERE AND NOT INSIDE `actionForKey`
 *
 * `keys.ts` is deliberately DOM-free -- `KeyLike` carries six scalars and no target, which is what
 * lets its cases run without jsdom. The target is a property of the EVENT, so the code that owns
 * real events owns this question.
 *
 * ## `BUTTON` IS DELIBERATELY NOT IN THE LIST
 *
 * Every cap on both surfaces is a `<button>`, and one of them holds focus after every click. A
 * predicate widened to "any form control" would make the keyboard window deaf again the moment an
 * operator clicked a key -- which is the exact bug this module exists to fix. The list is the
 * three TEXT-ENTRY tags plus `contentEditable`, and nothing else.
 */
export function isEditableTarget(
  target: { tagName?: unknown; isContentEditable?: unknown } | null,
): boolean {
  const tag = typeof target?.tagName === 'string' ? target.tagName : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || target?.isContentEditable === true;
}

/** The shape this module reads off a real `KeyboardEvent`. */
type KeyEventLike = KeyLike & {
  readonly target: { tagName?: unknown; isContentEditable?: unknown } | null;
  readonly preventDefault: () => void;
};

/**
 * Install the listener. Called once per window, at load.
 *
 * ALL CHORDS WORK EVERYWHERE, which is the user's decision of 2026-10-23 and not an oversight:
 * `Ctrl-B` pressed in the keyboard window raises `toggleKeyboard`, which `main.ts` answers by
 * showing and focusing the window that is already open -- a harmless self-focus.
 * `openKeyboardWindow` is idempotent precisely so a repeated chord cannot stack a second window.
 * Special-casing the two toggle chords would add a second place for the rule to be wrong.
 */
export function forwardKeys(deps: ForwardKeysDeps): void {
  deps.on('keydown', (raw: never) => {
    const e = raw as unknown as KeyEventLike;
    if (isEditableTarget(e.target)) return;
    const action = actionForKey(e);
    if (action === null) return;
    // `preventDefault` ONLY for keys we CLAIMED, so shortcuts we do not use keep working and Tab
    // does not move focus out of the window. `renderer.ts` makes the same call for the same reason.
    e.preventDefault();
    deps.sendAction(action);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ~/git/tn3270 && npx vitest run packages/canvas/test/forwardKeys.test.ts 2>&1 | tail -6
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Verify `KeyLike` is exported from `keys.ts`**

The implementation imports `type KeyLike` as a VALUE-less type import. Confirm it is exported:

```bash
cd ~/git/tn3270 && grep -n "^export interface KeyLike" packages/canvas/src/keys.ts
```

Expected: one match at line 26. If absent, add `export` to the interface and re-run Step 4.

- [ ] **Step 6: Typecheck, because vitest does NOT typecheck**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5; echo "BUILD done"
npm run typecheck 2>&1 | grep -iE "error TS" | head -5; echo "TYPECHECK done"
```

Expected: no `error TS` lines. A green vitest run over a failed build has happened in this repo
before; the build is what proves the types.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/canvas/src/forwardKeys.ts packages/canvas/test/forwardKeys.test.ts
git commit -m "feat(canvas): forwardKeys, so a window that is not the canvas can type

The GUI's keypad and keyboard are separate BrowserWindows and the product's only
keydown listener is in the canvas window, so with either focused the physical
keyboard did nothing at all. This is the shared half of the fix: a listener with
injected deps, reusing actionForKey, plus the form-control predicate extracted
out of renderer.ts so the two cannot diverge.

BUTTON is deliberately not in that predicate: every cap is a button and one holds
focus after every click, so widening it would make the window deaf again.

12 tests, each watched fail first, including preventDefault in BOTH directions --
a test that only checked the claimed case would pass an implementation that
prevented every key.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: `renderer.ts` uses the extracted predicate

**Files:**
- Modify: `packages/canvas/src/renderer.ts` (the import block at the top, and the listener at ~268)

- [ ] **Step 1: Add the import**

In `packages/canvas/src/renderer.ts`, find this line (line 4):

```ts
import { actionForKey } from './keys.js';
```

Add directly beneath it:

```ts
import { isEditableTarget } from './forwardKeys.js';
```

- [ ] **Step 2: Replace the inlined predicate with the call**

In the `window.addEventListener('keydown', ...)` handler, find this exact block:

```ts
  const target = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  const tag = typeof target?.tagName === 'string' ? target.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || target?.isContentEditable === true) {
    return;
  }
```

Replace it with:

```ts
  // THE PREDICATE NOW LIVES IN `forwardKeys.ts` and is shared with the GUI's child windows, which
  // need the identical rule. The long note above is why it exists; this is now the only copy.
  if (isEditableTarget(e.target as { tagName?: unknown; isContentEditable?: unknown } | null)) {
    return;
  }
```

Leave the long docstring above it in place — it records the measured 2026-10-07 bug and is still
the reason the check exists.

- [ ] **Step 3: Verify the behaviour did not change**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -3; echo "BUILD done"
npx vitest run packages/canvas 2>&1 | tail -4
```

Expected: no `error TS`, all canvas tests pass.

- [ ] **Step 4: Check `renderer.ts` has not gained a forbidden import**

`renderer.ts` is walked by a module test. Confirm the new specifier is relative and resolvable:

```bash
cd ~/git/tn3270 && grep -oE "from '[^']*'" packages/canvas/dist/renderer.js | sort -u
npx vitest run packages/canvas/test/module-cycles.test.ts 2>&1 | tail -4
```

Expected: `./forwardKeys.js` appears, and the cycle test passes. **If the cycle test FAILS**, stop:
`forwardKeys.ts` must not import `renderer.ts` (it does not in Task 1), and a cycle would mean
something else was changed.

- [ ] **Step 5: Prove the extraction is load-bearing, not cosmetic**

Mutate the predicate to always return `false`, rebuild, and confirm the browser harness catches it
in the WEB front end — which is what proves `renderer.ts` really uses the shared copy:

```bash
cd ~/git/tn3270
cp packages/canvas/src/forwardKeys.ts /tmp/fk.bak
python3 - <<'PY'
p = 'packages/canvas/src/forwardKeys.ts'
s = open(p).read()
s = s.replace("""  const tag = typeof target?.tagName === 'string' ? target.tagName : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || target?.isContentEditable === true;""", """  return false;""")
open(p, 'w').write(s)
PY
npm run build >/dev/null 2>&1
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -4
pkill -9 -f "node_modules/electron" >/dev/null 2>&1; sleep 3
cp /tmp/fk.bak packages/canvas/src/forwardKeys.ts && npm run build >/dev/null 2>&1
echo "restored"
```

Expected: the transfer phase FAILS (the form's typed text goes to the gateway instead of the
field). Then `restored`. **If every check still passes**, the extraction is not wired up — stop and
investigate before continuing.

- [ ] **Step 6: Re-verify green after restoring, then commit**

```bash
cd ~/git/tn3270 && node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/electron" >/dev/null 2>&1; sleep 3
git add packages/canvas/src/renderer.ts
git commit -m "refactor(canvas): renderer.ts imports the shared editable-target predicate

One copy of the rule rather than two. The long note on WHY the check exists stays
in renderer.ts, where the measured 2026-10-07 bug was found; the logic now lives
in forwardKeys.ts, which the GUI's child windows also need.

Mutation-proved rather than assumed: making the predicate return false fails
browser-clicks.mjs's transfer phase, so renderer.ts demonstrably uses the shared
copy and not a leftover inline one.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: Both child windows call it — boot files AND both import maps

**Files:**
- Modify: `packages/gui/src/keyboardBoot.ts`, `packages/gui/src/keypadBoot.ts`
- Modify: `packages/gui/keyboard.html`, `packages/gui/keypad.html`

**DO NOT SPLIT THIS TASK.** A boot file importing a specifier its document does not map fails
`gui/test/keypadModule.test.ts` and `gui/test/keyboardModule.test.ts`, and blanks the window.

- [ ] **Step 1: Add the map entry to `keyboard.html`**

That document maps DEEP paths. Find:

```html
    "@tn3270/canvas/dist/keyboardUi.js": "../canvas/dist/keyboardUi.js",
```

Add directly beneath it:

```html
    "@tn3270/canvas/dist/forwardKeys.js": "../canvas/dist/forwardKeys.js",
```

- [ ] **Step 2: Add the map entry to `keypad.html`**

That document maps the BARE `@tn3270/canvas` to `keypadUi.js`, so the new module needs its own
deep entry beside it. Find:

```html
    "@tn3270/canvas": "../canvas/dist/keypadUi.js",
```

Add directly beneath it:

```html
    "@tn3270/canvas/dist/forwardKeys.js": "../canvas/dist/forwardKeys.js",
```

- [ ] **Step 3: Call it from `keyboardBoot.ts`**

At the top of `packages/gui/src/keyboardBoot.ts`, find:

```ts
import { createKeyboardUi } from '@tn3270/canvas/dist/keyboardUi.js';
```

Add beneath it:

```ts
import { forwardKeys } from '@tn3270/canvas/dist/forwardKeys.js';
```

Then at the END of the file, after the `createKeyboardUi({...});` call, append:

```ts
/**
 * AND THE PHYSICAL KEYBOARD, so this window is not deaf while it has focus.
 *
 * The user's requirement, 2026-10-23: *"typing should send keystrokes to the terminal emulator
 * whether the keyboard window or the terminal window has focus."* Before this, the product's only
 * `keydown` listener was `renderer.ts`'s, in the CANVAS window -- so with this window focused a
 * physical key did nothing at all, which is a worse failure than a wrong action because nothing on
 * screen explains it.
 *
 * THE SAME BRIDGE THE CAPS USE, so a typed key and a clicked cap take one path to the session:
 * `ipcMain.on('action')` reads no sender, so main's existing interceptions answer both.
 */
forwardKeys({
  on: (type, handler) => { window.addEventListener(type, handler as () => void); },
  sendAction: (action) => { bridge.sendAction(action); },
});
```

- [ ] **Step 4: Call it from `keypadBoot.ts`**

At the top of `packages/gui/src/keypadBoot.ts`, find:

```ts
import { createKeypadUi } from '@tn3270/canvas';
```

Add beneath it:

```ts
import { forwardKeys } from '@tn3270/canvas/dist/forwardKeys.js';
```

Then at the END of the file, after the `createKeypadUi({...});` call, append:

```ts
/**
 * AND THE PHYSICAL KEYBOARD, for the reason `keyboardBoot.ts` gives at length.
 *
 * THIS WINDOW HAD THE IDENTICAL GAP and the user only named the keyboard one. Fixing a single
 * window would leave the other broken the same way, with the same silent symptom, and the fix is
 * the same two lines.
 */
forwardKeys({
  on: (type, handler) => { window.addEventListener(type, handler as () => void); },
  sendAction: (action) => { bridge.sendAction(action); },
});
```

- [ ] **Step 5: Build, then run the two module tests that police the maps**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5; echo "BUILD done"
npx vitest run packages/gui 2>&1 | tail -5
```

Expected: no `error TS`; all gui tests pass. **If `keypadModule` or `keyboardModule` fails with an
unresolvable specifier**, a map entry in Step 1 or 2 is missing or misspelled — fix it rather than
editing the test.

- [ ] **Step 6: Load each window for real and dispatch a keystroke**

Both boot files read `document` in their module bodies, so nothing in the suite can execute them.
This repo's rule is that such a file must be LOADED to be believed.

```bash
mkdir -p /tmp/kbkeys && cat > /tmp/kbkeys/probe.cjs <<'PROBE'
const { app, BrowserWindow, ipcMain } = require('electron');
const { join } = require('node:path');
const repo = '/home/a/athor/git/tn3270';
const seen = [];
ipcMain.on('action', (_e, a) => { seen.push(a); });
app.whenReady().then(async () => {
  for (const [doc, preload] of [['keyboard.html', 'keyboardPreload.cjs'],
    ['keypad.html', 'keypadPreload.cjs']]) {
    const w = new BrowserWindow({ width: 820, height: 320, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false,
        preload: join(repo, 'packages', 'gui', 'dist', preload) } });
    w.webContents.on('console-message', (_e, lvl, msg) => {
      if (lvl >= 2) console.log(`  ${doc} console[${lvl}]: ${String(msg).slice(0, 120)}`);
    });
    await w.loadFile(join(repo, 'packages', 'gui', doc));
    const before = seen.length;
    // A REAL KEYSTROKE at the top of Chromium's input pipeline, not a synthetic DOM event.
    //
    // NO `char` EVENT, and that is deliberate: `main.ts:1502-1508` sends one ONLY when the chord
    // has no modifiers, because a `char` for a modified key is not what a browser produces. A
    // `keyDown`/`keyUp` pair is what a Ctrl chord looks like.
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a', modifiers: ['control'] });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a', modifiers: ['control'] });
    await new Promise((r) => setTimeout(r, 900));
    console.log(`${doc.padEnd(14)} Ctrl-A -> ${JSON.stringify(seen.slice(before))}`);
    w.destroy();
  }
  app.exit(0);
});
PROBE
cd ~/git/tn3270 && node -e "
import('/home/a/athor/git/tn3270/packages/gui/scripts/xvfb.mjs').then(async ({guiEnv})=>{
  const {spawnSync}=await import('node:child_process');
  const r=spawnSync('/home/a/athor/git/tn3270/node_modules/.bin/electron',
    ['/tmp/kbkeys/probe.cjs','--no-sandbox','--disable-gpu'],
    {encoding:'utf8',timeout:120000,env:guiEnv({})});
  for(const l of ((r.stdout||'')+(r.stderr||'')).split('\n')) if(/->|console\[/.test(l)) console.log(l);
});"
```

Expected: both lines read `Ctrl-A -> [{"kind":"attn"}]`.

**If a line reads `[]`**, the listener is not installed — check the import resolved (a blank window
logs a module error at console level 3). **If a `console[3]` line appears naming a specifier**, the
import map entry is wrong.

- [ ] **Step 7: Confirm a clicked cap still works, so the listener did not break the caps**

```bash
cd ~/git/tn3270 && node packages/gui/scripts/clicks.mjs 2>&1 | grep -viE "dbus|OOM|zygote|deprecated|GPU" | tail -3
pkill -9 -f "node_modules/electron" >/dev/null 2>&1; sleep 3
```

Expected: `ok  9 buttons, 10 actions in order (toggleKeypad + 9)`.

- [ ] **Step 8: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/src/keyboardBoot.ts packages/gui/src/keypadBoot.ts \
  packages/gui/keyboard.html packages/gui/keypad.html
git commit -m "feat(gui): the keypad and keyboard windows are no longer deaf

Both call forwardKeys, so a physical key reaches the session whichever window has
focus -- the user's requirement, and before this the only keydown listener in the
product was renderer.ts's, in the canvas window.

BOTH WINDOWS, though only the keyboard was reported: the keypad had the identical
gap and the same silent symptom.

TWO IMPORT MAPS, in the same commit as the imports that need them, because
keypad.html maps the BARE @tn3270/canvas while keyboard.html maps deep paths --
one specifier cannot name two files, so forwardKeys is imported deep and both
documents gained an entry. Two module tests already police this.

Verified by LOADING both documents in a real BrowserWindow and dispatching a real
Ctrl-A through sendInputEvent: both answer {kind:'attn'} on main's own IPC
handler. Neither boot file is executable by the suite, so loading it is the only
evidence that counts.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: The gate and the docs

**Files:**
- Modify: `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md`

- [ ] **Step 1: The full gate, serially, with a pkill between browser runs**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
node packages/gui/scripts/keys.mjs 2>&1 | tail -2;     pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/shot.mjs 2>&1 | tail -2;     pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2; pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3; pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -2
```

`browser-keys.mjs` AND `browser-clicks.mjs` are the ones to watch: `renderer.ts` changed, and those
two are what prove the web front end's key path and transfer form still work. A golden diff in
either `shot` harness means something leaked into the base page — report it and stop rather than
regenerating.

- [ ] **Step 2: README — say the windows accept typing**

In `README.md`, find the sentence describing the keypad/keyboard windows and add after it:

```markdown
**Both windows accept the physical keyboard too.** Typing or pressing a chord while the keypad or
keyboard window has focus reaches the session exactly as it would from the terminal window — you do
not have to click back to the terminal first. The on-screen `Shift` is a separate one-shot from
your physical Shift key: it arms on a click and is spent by the next character you click.
```

- [ ] **Step 3: `docs/live-testing.md` — a new entry, and why no live run was needed**

Append to `docs/live-testing.md`:

```markdown
- **CHILD-WINDOW KEYSTROKES, 2026-10-23 — NO LIVE HOST RUN WAS NEEDED, AND THIS IS WHY.**

  The GUI's keypad and keyboard windows now forward the physical keyboard to the session. **Every
  action a forwarded keystroke can raise is one an existing chord or cap already raises**, through
  the same `actionForKey` table and the same `applyAction` — so there is no new wire format, no new
  protocol message, and no path a host could tell apart from a keystroke in the terminal window.

  **What IS proven, offline:** `forwardKeys.test.ts` covers the table lookup, the unclaimed-key
  drop, `preventDefault` in both directions and the form-control skip; and both documents were
  LOADED in a real `BrowserWindow` where a `sendInputEvent` Ctrl-A arrived at main's own
  `ipcMain.on('action')` as `{kind:'attn'}`.

  **What is NOT verified:** whether a real operator's modifier habits feel right in a child window
  — in particular that HELD PHYSICAL SHIFT does not arm the on-screen one-shot, which is out of
  scope by the user's decision (*"if it feels weird we will revisit it later"*). Also unverified on
  macOS and Windows, where `renderer.ts` already records that Option/AltGr behave differently.
```

- [ ] **Step 4: `docs/HANDOFF.md` — update START HERE**

In the START HERE section, replace the held-Shift bullet's first sentence with:

```markdown
- **HELD-SHIFT DETECTION.** Still open, and now narrower: child windows DO receive keystrokes as of
  2026-10-23 (`forwardKeys.ts`), so the focus objection below is gone — what remains is the state
  question. A physical Shift held down does NOT arm the on-screen one-shot, and if held and
  one-shot share one flag, releasing a physical Shift clears an arm set by clicking. Two states
  OR'd together avoids that. The user has seen the current behaviour and chose to live with it:
  *"if it feels weird we will revisit it later."*
```

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add README.md docs/live-testing.md docs/HANDOFF.md
git commit -m "docs: child windows accept typing, and why no live run was needed

Every action a forwarded keystroke raises is one an existing chord or cap already
raises, through the same table and the same applyAction -- no new wire format and
no path a host could tell apart. live-testing.md says so explicitly, and states
the two things NOT verified: whether held physical Shift feels wrong (out of
scope by the user's choice) and macOS/Windows modifier behaviour.

The handoff's held-Shift item is narrower now: the FOCUS objection is gone, the
state question remains.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| New `forwardKeys.ts` in `packages/canvas`, injected deps | 1 |
| Skip form controls; `actionForKey`; `preventDefault` only when claimed; `sendAction` | 1 Steps 1, 3 |
| Imports only `keys.js`, so each window's graph grows by one file | 1 Step 3, 2 Step 4 |
| Predicate EXTRACTED from `renderer.ts`, not copied | 1 Step 3, 2 Steps 1-2 |
| Both child windows call it | 3 Steps 3, 4 |
| All chords work everywhere (no toggle special-case) | 1 Step 3 (documented at `forwardKeys`) |
| No new IPC channel; no `main.ts` change | no task touches `main.ts` |
| Web gateway unchanged | no task touches `packages/web/src` or `static/` |
| Unit tests: claimed, unclaimed, preventDefault both ways, form control, character | 1 Step 1 |
| Real-window verification, because boot files are untestable | 3 Step 6 |
| Held physical Shift out of scope | stated in 4 Step 3; no task implements it |
| Gate incl. `browser-clicks` because `renderer.ts` changed | 4 Step 1 |
| No live host run, stated explicitly | 4 Step 3 |

**Type consistency check:** `ForwardKeysDeps` (`on`, `sendAction`) is defined in Task 1 Step 3 and
used with those exact member names in Task 1 Step 1's fake and in Task 3 Steps 3-4.
`isEditableTarget` is exported in Task 1 Step 3, tested in Task 1 Step 1, imported in Task 2 Step 1.
`forwardKeys` is the same name throughout. `KeyLike` is imported as a type and its export is
verified in Task 1 Step 5.

**One risk, named rather than hidden:** Task 3 Step 6's probe uses `sendInputEvent`, which
synthesizes events WITHOUT `getModifierState` — `keys.ts`'s `KeyLike` declares that method optional
for exactly this reason. So the probe proves the Ctrl path and says nothing about AltGr; the AltGr
fallback is covered by `keys.test.ts` instead.
