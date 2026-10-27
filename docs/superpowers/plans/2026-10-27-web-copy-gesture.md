# Web Copy Gesture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a browser operator a way to invoke copy — `Ctrl-Shift-C` on Linux/Windows and `Cmd-Shift-C` on macOS — since web copy currently ships its whole server path with no reachable trigger.

**Architecture:** `actionForKey` is a PURE function with no access to the selection, and `{kind:'copy'}` requires a `rect`. So the chord CANNOT return a `copy` action from the keymap. It returns a new intent-only kind, and `renderer.ts` — which owns `anchor`/`focus` — turns it into the real `copy` action by calling the existing `__tn3270Copy()` logic. This is the same split the keypad already uses for `toggleKeypad`.

**Tech Stack:** TypeScript, vitest, Electron 44.3.0 + CDP for the real-browser harness.

---

## Read this before Task 1 — six measured facts

Spec: `docs/superpowers/specs/2026-10-27-web-copy-gesture-design.md`. Read it. These are the
facts an implementer most often gets wrong here, each measured on 2026-10-26/27, not reasoned:

1. **`actionForKey` CANNOT return `{kind:'copy'}`.** That action carries
   `rect: {top,left,bottom,right}` (`frontend/src/keymap.ts:130`), and `actionForKey(e: KeyLike)`
   receives only a key event — the selection lives in `renderer.ts`'s module-level
   `anchor`/`focus` (`renderer.ts:88`). The spec said "`Ctrl-Shift-C` -> `{kind:'copy', rect}`
   in `keys.ts`", which is **not implementable as written**. This plan uses a `requestCopy`
   intent kind instead. If you find a way to make the spec's literal version work, STOP and
   report it rather than inventing a rect.

2. **The `CTRL` lookup is case-folded on purpose, so a `copy` entry in that table cannot work.**
   `keys.ts:167-170` does `CTRL[e.key.toLowerCase()]`, and driving it confirms `Ctrl-C` AND
   `Ctrl-Shift-C` both return `{"kind":"clear"}` today. The new branch must come BEFORE that
   lookup.

3. **macOS does NOT get `Cmd-C` for free.** Measured in a real Chromium window with **no DOM
   selection** (our real case — the canvas selection is module state, and there is no
   `getSelection`/`createRange` anywhere in `packages/canvas` or `packages/web`):
   `Ctrl-C` fires a `copy` event with `clipboardData` present; **`Cmd-C` fires none**;
   `Ctrl-Shift-C` fires none. A `null` from our keymap means "we declined it", not "the platform
   handles it". Hence `Cmd-Shift-C` is a real binding, not a courtesy.

4. **`renderer.ts:312-315` currently asserts the OPPOSITE invariant and will go stale.** It
   says the selection survives a copy because *"on Linux `Ctrl+Shift+C` is **not in
   `actionForKey`'s table**, so it lands here as an unclaimed key."* This change reverses that.
   The listener calls `clearSelection()` unconditionally once `actionForKey` returns non-null
   (`:307-316`), so **without an exemption a copy wipes the rect it just sent.** Rewrite that
   comment in the same commit; it is the only one of its kind in the repo.

5. **`keys.test.ts` has a conformance loop over `BINDING_INTENT`** (`:66-142`) that requires
   `checked === BINDING_INTENT.length - Object.keys(TERMINAL_ONLY).length`, with `TERMINAL_ONLY`
   currently **empty**. Adding a row to `BINDING_INTENT` without adding it to that test's `named`
   map fails the suite. The table is intent-only and deliberately NOT a code generator
   (`bindings.ts:3-18`).

6. **The Linux Electron Copy accelerator is the SAME chord.** `menu.ts:70-76` makes
   `Ctrl+Shift+C` the Linux/Windows Copy accelerator, and Task 5 of the previous feature
   measured that such an accelerator fires ALONGSIDE the page event, with page-side
   `preventDefault()` NOT suppressing it. Task 4 of this plan measures whether that double-fires
   and decides what to do. **Do not pre-emptively gate anything; measure first.**

**Baseline before Task 1:** branch `web-copy-paste` at `7807edd`, tree clean, build exit 0,
**2603 tests in 110 files**, `browser-clicks` 9 buttons + 13/13, `browser-shot` 1/1.

**Conventions:** US English in all prose/comments. `npm run build` BEFORE `npx vitest` (packages
resolve to built `dist/`). `vitest` does NOT typecheck — capture the build's exit code UNPIPED,
never through a `grep` pipeline. Before any Electron harness: `pkill -9 -f "node_modules/[e]lectron"`.
Check Xvfb with `[ -S /tmp/.X11-unix/X99 ]`, never `pgrep -f "Xvfb :99"`. After reverting a
mutation, `npx tsc --build --force <pkg>` — a restored backup has an older mtime and `dist/`
silently keeps the mutant. Electron needs `LD_LIBRARY_PATH=$HOME/micromamba/envs/gui/lib` and
`DISPLAY=:99`. Commit messages end with:

```
Generated with AI

Co-Authored-By: SLAC AI
```

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/frontend/src/keymap.ts` | the `Action` union | Add `{kind:'requestCopy'}` |
| `packages/frontend/src/actions.ts` | `applyAction` | THROW on `requestCopy` (seventh of that shape) |
| `packages/canvas/src/keys.ts` | key -> action mapping | New Shift-C branch before the `CTRL` lookup |
| `packages/canvas/src/renderer.ts` | owns the selection | Intercept `requestCopy`; exempt it from `clearSelection` |
| `packages/web/src/protocol.ts` | gateway decode | REFUSE `requestCopy` (two-branch rule) |
| `packages/frontend/src/bindings.ts` | written-down intent | Row for the chord |
| `packages/canvas/test/keys.test.ts` | mapper tests | Chord cases + `named` entry |
| `packages/canvas/test/renderer-imports.test.ts` | built-artifact asserts | Pin the exemption |
| `packages/web/scripts/browser-clicks.mjs` | real-browser cover | Drive the real chord |
| `README.md`, `docs/live-testing.md` | docs | Three false claims |

---

## Task 1: the `requestCopy` intent kind, which `applyAction` refuses

**Files:**
- Modify: `packages/frontend/src/keymap.ts`
- Modify: `packages/frontend/src/actions.ts`
- Modify: `packages/web/src/protocol.ts`
- Test: `packages/frontend/test/actions.test.ts`

- [ ] **Step 1: Read the five existing members of this shape**

```bash
cd ~/git/tn3270 && grep -n "does not handle" packages/frontend/src/actions.ts
sed -n '95,110p' packages/frontend/src/actions.ts
```

You will see six kinds `applyAction` throws on: `quit`, `toggleKeypad`, `transferForm`, `copy`,
`toggleKeyboard`, `paste`. Yours is the **seventh**. Read `copy`'s note — it states the rule this
one follows: what a clipboard IS differs per front end, so it cannot be dispatched centrally.

- [ ] **Step 2: Write the failing test**

Read two neighboring cases in `packages/frontend/test/actions.test.ts` first and match its idiom.
Add:

```ts
  it('REFUSES requestCopy, because only the renderer knows the selection', () => {
    // The seventh kind of this shape. It exists because `actionForKey` is pure and `copy`
    // carries a rect: the keymap can say "the operator asked to copy" and nothing more.
    const s = freshSession();
    expect(() => applyAction(s, { kind: 'requestCopy' }))
      .toThrow(/does not handle requestCopy/);
  });
```

**`freshSession()` is a placeholder for whatever that file already uses** — read the file and use
its real helper. Earlier plans in this repo invented `defaultSession()`, `session.keyboard.lock()`
and a wrong import path, none of which exist. Verify before you type.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npm run build >/dev/null 2>&1; npx vitest run packages/frontend/test/actions.test.ts 2>&1 | tail -10
```

Expected: FAIL — `requestCopy` is not in the `Action` union, so this is a TYPE error at build and
an assertion failure at run. Both are fine; note which you got.

- [ ] **Step 4: Add the union member**

In `packages/frontend/src/keymap.ts`, beside the `copy` member at `:130`:

```ts
  /**
   * THE OPERATOR ASKED TO COPY, carrying no rect. 2026-10-27.
   *
   * SEPARATE FROM `copy` BECAUSE `actionForKey` IS PURE. `copy` carries
   * `rect: {top,left,bottom,right}`, and the selection lives in `renderer.ts`'s module state
   * (`anchor`/`focus`) which a key mapper cannot see. So the keymap raises the INTENT and the
   * renderer — the one place that knows the rectangle — turns it into a real `copy`.
   *
   * This is the split `transferForm` already uses: a kind intercepted before `applyAction` --
   * which THROWS on it -- that raises a DIFFERENT kind once the front end has what was missing.
   *
   * (This read "the split `toggleKeypad` already uses" and that was WRONG, corrected 2026-10-27
   * from Task 1. `toggleKeypad` is terminally intercepted and converts to nothing; `transferForm`
   * shows an overlay that later emits different messages, which is this kind's shape. The spec
   * carried the same error and now carries the same correction.)
   *
   * IT NEVER REACHES THE WIRE. `renderer.ts` consumes it and sends `copy` instead, so the
   * gateway REFUSES it at decode rather than accepting a kind no server path handles.
   */
  | { kind: 'requestCopy' }
```

- [ ] **Step 5: Add the throw**

In `packages/frontend/src/actions.ts`, after the `paste` throw:

```ts
  // THE SEVENTH OF THE SAME SHAPE, 2026-10-27, and outside the `try` for the reason the six
  // above give: the catch-all would swallow the throw and hand back the silent no-op it exists
  // to prevent. A front end that bound the chord and forgot to intercept it gets a loud failure
  // rather than a key that appears to do nothing.
  if (action.kind === 'requestCopy') {
    throw new Error(
      'applyAction does not handle requestCopy: only the renderer knows the selection',
    );
  }
```

- [ ] **Step 6: REFUSE it at the gateway's decode**

This repo's recorded rule: *the two-branch rule is necessary but not sufficient* — a kind
`applyAction` throws on needs a rejection or an interception, and "neither" is forbidden. Since
`requestCopy` never legitimately arrives from a client, it must be REFUSED, not accepted.

```bash
cd ~/git/tn3270 && grep -n "REFUSED" packages/web/src/protocol.ts | head -5
```

Read how `REFUSED` is built and add `requestCopy` to it, with a comment saying why: the browser's
renderer consumes this kind locally and sends `copy`, so a `requestCopy` on the socket is either a
stale client or a hostile one, and in neither case is there a server path for it.

- [ ] **Step 7: Run the whole suite and the build**

```bash
cd ~/git/tn3270 && npm run build >/tmp/t1.log 2>&1; echo "BUILD EXIT: $?"; grep -c "error TS" /tmp/t1.log
npx vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: build exit 0, 0 `error TS`, and the suite UP by your new tests (2603 + n). If any
existing test went red, report which — a new union member can make an exhaustive `switch`
non-exhaustive, and that is information, not an obstacle.

- [ ] **Step 8: Commit**

```bash
cd ~/git/tn3270 && git add packages/frontend/src/keymap.ts packages/frontend/src/actions.ts \
  packages/web/src/protocol.ts packages/frontend/test/actions.test.ts
git commit -m "feat(frontend): a requestCopy intent kind, which applyAction refuses

actionForKey is pure and the copy action carries a rect, so a key mapper cannot
raise copy: the selection lives in renderer.ts's module state. The keymap raises
the INTENT and the renderer turns it into a real copy, which is the split
transferForm already uses.

Seventh kind of that shape, and REFUSED at the gateway's decode rather than
merely unhandled -- the two-branch rule forbids neither, and this kind has no
server path at all because the browser consumes it locally.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: the chord, in `keys.ts`

**Files:**
- Modify: `packages/canvas/src/keys.ts`
- Modify: `packages/frontend/src/bindings.ts`
- Test: `packages/canvas/test/keys.test.ts`

- [ ] **Step 1: Write the failing tests**

In `packages/canvas/test/keys.test.ts`, inside the `describe('actionForKey', ...)` block. The
file's helper is `ev({...})` (`:6-7`) — read it; it defaults every modifier to `false`.

```ts
  it('maps Ctrl-Shift-C and Cmd-Shift-C to a copy REQUEST, on e.code', () => {
    // Two chords, no platform detection, because neither is ambiguous on either platform:
    // Cmd-Shift-C is not the macOS address bar and Ctrl-Shift-C is not Clear once this
    // branch precedes the case-folded CTRL lookup.
    //
    // MEASURED, which is why Cmd gets a binding at all: in a real Chromium window with no DOM
    // selection -- our case, since the canvas selection is module state -- Ctrl-C fires a
    // native `copy` event and Cmd-C fires NONE. So macOS copies nothing without this.
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
  });

  it('keeps plain Ctrl-C as CLEAR, which is the property the fold protected', () => {
    // The CTRL lookup is case-folded so that Ctrl-Shift-C ALSO meant Clear. This change takes
    // the shifted form for copy and leaves the unshifted one alone -- Clear is an AID a 3270
    // operator needs constantly, and `menu.ts` records rejecting any binding that makes it
    // conditional on invisible state.
    expect(actionForKey(ev({ key: 'c', ctrlKey: true }))).toEqual({ kind: 'clear' });
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', ctrlKey: true }))).toEqual({ kind: 'clear' });
  });

  it('does NOT claim Shift-V in either spelling, because paste is the native event', () => {
    // Claiming it would call preventDefault and SUPPRESS the `paste` event the whole paste
    // feature depends on -- measured: Ctrl-C's claim suppresses the native copy event the
    // same way. Paste must stay unclaimed.
    expect(actionForKey(ev({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(actionForKey(ev({ key: 'V', code: 'KeyV', metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('matches the PHYSICAL key, so a non-US layout cannot break it', () => {
    // KeyLike.code's own note: on macOS Option-1 reports key === '¡', so an e.key binding
    // works on Linux and fails on a Mac. A Shift chord has the same hazard since e.key is the
    // shifted form. A bogus `key` with the right `code` must still map.
    expect(actionForKey(ev({ key: 'Ç', code: 'KeyC', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
    // And the converse: the right letter on the wrong physical key must NOT map.
    expect(actionForKey(ev({ key: 'C', code: 'KeyX', ctrlKey: true, shiftKey: true })))
      .toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd ~/git/tn3270 && npm run build >/dev/null 2>&1; npx vitest run packages/canvas/test/keys.test.ts 2>&1 | tail -15
```

Expected: the first and fourth tests FAIL (`{kind:'clear'}` received, or `null`), the second
PASSES already, the third PASSES already. **Report which passed before you changed anything** —
a test that was already green proves nothing about your change, and two of these are
regression guards by design.

- [ ] **Step 3: Add the branch BEFORE the CTRL lookup**

In `packages/canvas/src/keys.ts`, immediately after `if (MODIFIERS.has(e.key)) return null;` and
**before** the `if (e.ctrlKey && ...)` block:

```ts
  /**
   * COPY, on `Ctrl-Shift-C` (Linux/Windows) and `Cmd-Shift-C` (macOS). 2026-10-27.
   *
   * ## BEFORE THE `CTRL` LOOKUP, AND THAT ORDER IS THE WHOLE TRICK
   *
   * That lookup is case-folded, so `Ctrl-Shift-C` used to mean Clear just as `Ctrl-C` does.
   * Taking the shifted form for copy therefore requires getting in first. Plain `Ctrl-C` is
   * untouched and still Clear, which is the property the fold existed to protect.
   *
   * ## WHY NOT THE NATIVE `copy` EVENT, WHICH IS HOW PASTE WORKS
   *
   * MEASURED in a real Chromium window with NO DOM selection -- our case, since the canvas
   * selection is `renderer.ts` module state and not a Range: `Ctrl-C` fires a native `copy`
   * event, while `Cmd-C` and `Ctrl-Shift-C` fire none. So the native gesture on Linux is
   * `Ctrl-C` -- the Clear AID -- and adopting it would collide with the one binding this
   * project has decided must stay Clear everywhere (`menu.ts` records rejecting a conditional
   * "copy when a selection exists", because it makes a destructive AID depend on invisible
   * state). Paste got a free ride because `keys.ts` never claimed `Ctrl-V`; copy gets none.
   *
   * The same measurement is why macOS needs a binding at all: `Cmd-C` copies NOTHING from a
   * canvas. A `null` from this mapper means "we declined it", not "the platform handles it".
   *
   * ## `requestCopy`, NOT `copy`
   *
   * `copy` carries a rect and this function is pure -- see the union member's own note.
   *
   * ## `e.code`, NOT `e.key`
   *
   * `KeyLike.code`'s note gives the reason: `e.key` is the shifted form and is layout-dependent
   * (macOS Option-1 reports `'¡'`), so a `key` test would work on Linux and fail on a Mac,
   * passing every test written on Linux. `Alt-K` above matches `e.code` for this reason.
   *
   * `!altKey` keeps Ctrl-Alt-Shift-C with the window manager.
   */
  if (e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey) && e.code === 'KeyC') {
    return { kind: 'requestCopy' };
  }
```

- [ ] **Step 4: Rewrite the comment this falsifies**

`keys.ts:168-169` currently reads:

```ts
    // Case-folded because Ctrl-Shift-C still means Clear, and browsers report the shifted
    // letter. `?? null` is what drops Ctrl-Z rather than typing "z".
```

The first clause is now FALSE — `Ctrl-Shift-C` is copy. Rewrite it to say the fold makes
`Ctrl-Shift-R`, `Ctrl-Shift-U` and the rest still reach their unshifted meaning, that
`Ctrl-Shift-C` is the ONE exception and is claimed above, and keep the `?? null` sentence, which
is still true. **Do not leave the old sentence standing** — this repo's recorded failure mode is
a fix reaching the body and never the sentence that summarizes it.

- [ ] **Step 5: Add the `BINDING_INTENT` row and its `named` entry — BOTH, or the suite fails**

`keys.test.ts:66-142` loops over `BINDING_INTENT` and asserts
`checked === BINDING_INTENT.length - Object.keys(TERMINAL_ONLY).length`, with `TERMINAL_ONLY`
currently EMPTY. A row with no `named` entry fails that exactness check.

In `packages/frontend/src/bindings.ts`:

```ts
  {
    key: 'Ctrl-Shift-C', action: { kind: 'requestCopy' },
    note: 'copy the selection. NO `terminal` sequence: the TUI has no selection to copy, so '
      + 'this is a canvas-front-end binding like Ctrl-B. Cmd-Shift-C is the macOS spelling and '
      + 'this table names one key per action, so the pair is asserted directly in keys.test.ts. '
      + 'The shifted form is deliberate: plain Ctrl-C is the Clear AID and stays Clear.',
  },
```

and in that test's `named` map:

```ts
      'Ctrl-Shift-C': ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
```

- [ ] **Step 6: Run the build and the whole suite**

```bash
cd ~/git/tn3270 && npm run build >/tmp/t2.log 2>&1; echo "BUILD EXIT: $?"; grep -c "error TS" /tmp/t2.log
npx vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: build exit 0, suite green and up by your cases. **If `keymap.test.ts` (the TUI's) went
red, STOP and report** — it may assert that every `BINDING_INTENT` row with no `terminal` is
accounted for, and that is a real interaction worth reading rather than patching.

- [ ] **Step 7: Mutation-check the two guards**

Each applied, run, reverted — with `npx tsc --build --force packages/canvas` after each revert,
because a restored backup's older mtime leaves `dist/` holding the mutant.

1. Move the new branch to AFTER the `CTRL` lookup -> the Ctrl-Shift-C case must fail (it becomes
   Clear). This pins the ORDER, which is the whole trick.
2. Change `e.code === 'KeyC'` to `e.key.toLowerCase() === 'c'` -> the physical-key test must fail.
3. Drop `e.metaKey` from the condition -> the Cmd-Shift-C case must fail.

Report each result. **A mutation that does NOT fail is a finding** — report it rather than
adjusting the mutation until it fails.

- [ ] **Step 8: Commit**

```bash
cd ~/git/tn3270 && git add packages/canvas/src/keys.ts packages/frontend/src/bindings.ts \
  packages/canvas/test/keys.test.ts
git commit -m "feat(canvas): Ctrl-Shift-C and Cmd-Shift-C request a copy

Before the CTRL lookup, which is the whole trick: that lookup is case-folded, so
Ctrl-Shift-C used to mean Clear. Plain Ctrl-C is untouched and still Clear.

Both spellings, no platform detection, because neither chord is ambiguous on
either platform -- and macOS needs a real binding rather than the browser default:
measured with no DOM selection, Ctrl-C fires a native copy event and Cmd-C fires
none, so Cmd-C copies nothing from a canvas.

Matched on e.code because e.key is the shifted, layout-dependent form -- the
hazard KeyLike.code's note records, which would pass every test written on Linux.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: the renderer turns the intent into a copy — and the selection must survive

**Files:**
- Modify: `packages/canvas/src/renderer.ts`
- Test: `packages/canvas/test/renderer-imports.test.ts`

- [ ] **Step 1: Read the listener and the global you are joining**

```bash
cd ~/git/tn3270 && sed -n '300,320p' packages/canvas/src/renderer.ts
sed -n '466,512p' packages/canvas/src/renderer.ts
```

`__tn3270Copy()` already normalizes the rect, refuses an empty selection, returns a boolean and
raises `{kind:'copy', rect}`. **Your job is to call that logic, not to reimplement it.** Extract
it to a named local function if that reads better, but there must remain exactly ONE place that
builds the rect.

- [ ] **Step 2: Intercept the kind and exempt it from `clearSelection`**

The listener at `:303-316` does `actionForKey` -> `preventDefault()` -> `clearSelection()` ->
`sendAction`. A `requestCopy` must `preventDefault` (we claimed it) and must **NOT** reach
`clearSelection()` or `sendAction` — the former destroys the rect, the latter sends a kind the
gateway refuses.

```ts
  const action = actionForKey(e);
  if (action === null) return;
  // preventDefault only for keys we CLAIMED, so shortcuts we do not use keep working and
  // Tab does not move focus out of the canvas.
  e.preventDefault();
  /**
   * COPY IS INTERCEPTED HERE, AND IT MUST NOT FALL THROUGH TO `clearSelection()` BELOW.
   *
   * The clear exists because any action that changes the screen invalidates a highlight. A copy
   * changes nothing -- and clearing would destroy the very rectangle it is about to send, so a
   * copy would reliably copy nothing. This is the one claimed action that must leave the
   * selection standing.
   *
   * BEFORE `clearSelection()`, and the ORDER is the behavior: moving this below it still
   * compiles, still typechecks, and silently breaks copy. `renderer-imports.test.ts` pins it.
   *
   * `requestCopy` NEVER REACHES THE WIRE: this converts it to a real `copy`, carrying the rect
   * only this file knows. `applyAction` throws on it and the gateway refuses it at decode, so a
   * front end that forgot this arm fails loudly rather than being silently inert.
   */
  if (action.kind === 'requestCopy') { copySelection(); return; }
  // ANY KEYSTROKE THAT DOES SOMETHING INVALIDATES THE SELECTION, because the screen is about to
  // change under it and a highlight over changed text would offer a copy of something never seen.
  clearSelection();
  window.tn3270.sendAction(action);
```

`copySelection()` is the extracted body of `__tn3270Copy`; keep the global as a thin wrapper over
it so the Electron menu and the harnesses keep working unchanged.

- [ ] **Step 3: Rewrite the now-false comment at `:312-315`**

It currently explains that the selection survives because *"on Linux `Ctrl+Shift+C` is **not in
`actionForKey`'s table**, so it lands here as an unclaimed key."* That mechanism is gone. The
replacement must say: the selection used to survive a copy by accident of non-binding, and now
survives by the explicit exemption above; the macOS half (the Electron menu consumes the
accelerator before the page sees it) still holds for the GUI and is irrelevant in a browser,
which has no menu. **A reader who trusts the old text will conclude no exemption is needed** —
that is why this step is not optional.

- [ ] **Step 4: Pin the ordering on the built artifact**

A unit test cannot import `renderer.ts` (it touches browser globals at module load), so follow
the precedent at `packages/canvas/test/renderer-imports.test.ts:103-105`, which reads
`dist/selection.js` as text. Add a case asserting the `requestCopy` arm appears BEFORE
`clearSelection()` in `dist/renderer.js`:

```ts
  it('copies BEFORE the selection is cleared, or a copy copies nothing', () => {
    // MEASURED HAZARD, not caution: moving the requestCopy arm below `clearSelection()` still
    // builds, still typechecks and still passes every unit test, while silently making copy
    // always copy an empty rect. Ordering is the behavior, so the ordering is what is pinned.
    const js = readFileSync(join(distDir, 'renderer.js'), 'utf8');
    const copyArm = js.indexOf("requestCopy");
    const clear = js.indexOf('clearSelection()', copyArm);
    expect(copyArm, 'renderer.js must intercept requestCopy').toBeGreaterThan(-1);
    expect(clear, 'and clearSelection must follow it').toBeGreaterThan(copyArm);
  });
```

**Verify `distDir` and the import are what that file actually uses** before copying this in, and
check the string you search for really is in the emitted output — `tsc` may rename locals.

- [ ] **Step 5: Build, suite, and the real-browser harnesses**

```bash
cd ~/git/tn3270 && npm run build >/tmp/t3.log 2>&1; echo "BUILD EXIT: $?"; grep -c "error TS" /tmp/t3.log
npx vitest run 2>&1 | grep -E "Test Files|Tests "
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -4
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1
```

Expected: `browser-clicks` still 9 buttons + 13/13, `select.mjs` still 3/3. **`select.mjs`
exercises `__tn3270Copy` through the Electron menu — if it broke, your wrapper changed the
global's contract.**

- [ ] **Step 6: Mutation-check the exemption**

Move the `requestCopy` arm BELOW `clearSelection()`, rebuild with
`npx tsc --build --force packages/canvas`, and run the suite. **The new ordering test must fail.**
If the suite stays green, the test is not pinning anything — report that rather than proceeding.
Revert, force-rebuild.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/canvas/src/renderer.ts packages/canvas/test/renderer-imports.test.ts
git commit -m "feat(canvas): the renderer turns a copy request into a real copy

The one claimed action that must NOT clear the selection: clearing would destroy
the rectangle it is about to send, so a copy would reliably copy nothing. The arm
sits before clearSelection() and the ordering is pinned on the built artifact,
because moving it below still builds, typechecks and passes every unit test.

Also rewrites the comment that stated the opposite invariant -- that the selection
survived a copy because Ctrl+Shift+C was NOT in actionForKey's table. It is now,
so the survival is by explicit exemption rather than by accident of non-binding.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: measure the Electron double-copy, then decide

**Files:**
- Modify (only if the measurement says so): `packages/canvas/src/renderer.ts`, `packages/gui/src/menu.ts`

**This task is a MEASUREMENT FIRST. Do not change code before you have the numbers.**

- [ ] **Step 1: Read the two things that may now overlap**

```bash
cd ~/git/tn3270 && sed -n '70,80p' packages/gui/src/menu.ts
grep -n "onCopy" packages/gui/src/main.ts
```

`menu.ts` makes `Ctrl+Shift+C` the Linux/Windows Copy accelerator, wired to `onCopy`, which calls
`__tn3270Copy()` via `executeJavaScript`. Your Task 2 chord now ALSO fires in that window, because
`keys.ts` is shared by both DOM front ends.

- [ ] **Step 2: Measure whether both fire**

The previous feature measured that `Ctrl+Shift+V` fires BOTH the page event and the menu
accelerator, and that page-side `preventDefault()` does not suppress the accelerator. Check
whether the same holds here, using the real GUI:

```bash
cd ~/git/tn3270 && pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
[ -S /tmp/.X11-unix/X99 ] || echo "START XVFB FIRST: node packages/gui/scripts/xvfb.mjs"
```

Drive a drag-select then the chord in a real GUI window and count the `copy: N chars` lines on
stdout — `gui/src/main.ts`'s copy arm prints exactly one per copy. `packages/gui/scripts/select.mjs`
already drives a real drag and is the harness to extend or imitate; `TN3270_GUI_KEYS` delivers
chords. **Report the actual count: one line or two.**

- [ ] **Step 3: Decide on the evidence, and say which you chose and why**

- **If exactly one** `copy: N chars` — nothing to do. Record the measurement in a comment at the
  new `renderer.ts` arm, dated, so nobody re-opens it.
- **If two** — pick ONE owner for the chord in Electron and justify it:
  - (a) gate the renderer's `requestCopy` arm off `file:` the way `forwardPaste` gates its
    listener (`forwardKeys.ts:229`), leaving the menu to own it in the GUI; or
  - (b) drop the menu's accelerator on Linux/Windows and let the keydown path own it.
  **(a) matches the existing precedent** and keeps the menu item discoverable, which is why the
  keypad kept its menu route. Prefer it unless you measure a reason not to.

Two copies of the same rect to the same clipboard is idempotent, so the user-visible harm is low
— but the doubled `copy: N chars` line is asserted by `select.mjs`, and this is the same class of
defect that made the GUI `paste` arm wrong in the previous feature.

- [ ] **Step 4: Verify whichever way it went**

```bash
cd ~/git/tn3270 && npm run build >/tmp/t4.log 2>&1; echo "BUILD EXIT: $?"; grep -c "error TS" /tmp/t4.log
npx vitest run 2>&1 | grep -E "Test Files|Tests "
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1
```

- [ ] **Step 5: Commit, whatever the outcome**

Commit even if the answer was "one line, no change needed" — the measurement is the deliverable
and a dated comment recording it is what stops the question being re-opened. Message:
`test(gui): measure whether the Copy chord double-fires in Electron`, with the actual finding in
the body.

---

## Task 5: drive the real chord in the browser harness

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs`

- [ ] **Step 1: Read what `webCopy` does today and the comment that is now false**

```bash
cd ~/git/tn3270 && grep -n "webCopy" packages/web/scripts/browser-clicks.mjs | head
grep -n "binds no Copy gesture" packages/web/scripts/browser-clicks.mjs
```

`webCopy` currently calls `__tn3270Copy()` directly, and its comment says the page binds no Copy
gesture so only the human's keystroke is substituted. **That comment becomes false with Task 2.**

- [ ] **Step 2: Drive the real chord instead of the global**

Replace the `__tn3270Copy()` call with a real `Input.dispatchKeyEvent` Ctrl+Shift+C. The file
already uses that command (`:704`, `:769`) — follow its existing modifier spelling. This is
strictly stronger: it covers the BINDING as well as the path behind it, so a chord that stops
mapping now fails here.

Keep both existing witnesses (the gateway's `--log-actions` line and the real clipboard read) —
the two-witness rule exists because a page-side probe alone was once satisfied by a mutant.

- [ ] **Step 3: Add the assertion the chord makes possible**

Assert the SELECTION SURVIVED: after the chord, copy again via the same chord and confirm the
same text arrives. If clearing had happened, the second copy returns nothing. That is the
end-to-end witness for Task 3's exemption, and no unit test can reach it.

- [ ] **Step 4: Update the check's `mutant` field**

It is the documentation a future reader reproduces from. Name the new mutations: the chord moved
after the `CTRL` lookup, and the `requestCopy` arm moved below `clearSelection()`.

- [ ] **Step 5: Run it**

```bash
cd ~/git/tn3270 && npm run build >/dev/null 2>&1
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -6
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1
```

Expected: still 9 buttons + 13/13 (the count does not grow; `webCopy` got stronger, not
duplicated). Report the real output.

- [ ] **Step 6: Mutation-check, each reverted with a forced rebuild**

1. Move the Task 2 branch after the `CTRL` lookup -> `webCopy` must FAIL (the chord becomes Clear).
2. Move the Task 3 arm below `clearSelection()` -> `webCopy` must FAIL (an empty rect).

Report both. If either passes, say so plainly.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/web/scripts/browser-clicks.mjs
git commit -m "test(web): drive the real Copy chord, not the page global

Strictly stronger: the check now covers the BINDING as well as the path behind it,
so a chord that stops mapping fails here. Keeps both witnesses -- the gateway's
log line and the real clipboard -- because a page-side probe alone was once
satisfied by a mutant.

Also asserts the selection SURVIVES a copy by copying twice, which is the only
end-to-end witness for the clearSelection exemption.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 6: the docs, including three claims that are currently false

**Files:**
- Modify: `README.md`
- Modify: `docs/live-testing.md`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Fix the three false claims**

```bash
cd ~/git/tn3270 && sed -n '285,290p' README.md; sed -n '314,318p' README.md
grep -n "not machine-checkable\|machine-checkable" docs/live-testing.md
```

1. `README.md:287` — "copy from the Edit menu" is Electron-only. Name the browser chords.
2. `README.md:316` — "The web gateway has NEITHER copy nor paste yet" is false in both
   directions. Replace with what ships: `Ctrl-V`/`Cmd-V` for paste via the native event,
   `Ctrl-Shift-C`/`Cmd-Shift-C` for copy.
3. `docs/live-testing.md` — any claim that the OS clipboard is not machine-checkable is false:
   `browser-clicks.mjs` checks it over loopback. What stays human-only is the LAN / plain-`http`
   non-secure-context case, where `navigator.clipboard` is absent.

**Verify each line number before editing** — earlier commits on this branch moved text, and this
repo has a recorded habit of citations going stale within a commit of being written. Prefer
citing by heading rather than by line.

- [ ] **Step 2: Record why Ctrl-C is NOT the copy key**

Readers will ask. State it once, in the README's copy/paste section: the native copy gesture on
Linux is `Ctrl-C`, which is the Clear AID here, and `Cmd-C` copies nothing from a canvas because
the selection is not a DOM selection. Both measured 2026-10-26.

- [ ] **Step 3: Note what the human pass still owes**

In `docs/live-testing.md`: the LAN/non-secure-context clipboard branch, and **whether a page can
claim `Ctrl-L` on Linux or Windows** — the open question that would reopen Clear-on-Ctrl-L. Note
that the macOS result (Ctrl-L reaches the page) cannot settle it, because `Cmd-L` is the macOS
address bar and `Ctrl-L` was never the browser's shortcut there.

- [ ] **Step 4: Update `docs/HANDOFF.md`'s START HERE**

State: roadmap (0e) web copy/paste is complete including the gesture; what the human pass owes;
and the two open questions (Ctrl-L on Linux/Windows, and whether `Alt-C` should land as a Clear
alias since both c3270 and zti bless it).

- [ ] **Step 5: Run the full gate on the final commit**

```bash
cd ~/git/tn3270 && npm run build >/tmp/t6.log 2>&1; echo "BUILD EXIT: $?"; grep -c "error TS" /tmp/t6.log
npx vitest run 2>&1 | grep -E "Test Files|Tests "
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -2
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | tail -2
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/shot.mjs 2>&1 | tail -2
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1
```

Expected: build 0; suite green; `browser-clicks` 9 + 13/13; `browser-shot` 1/1; `select` 3/3;
`keys` 20 chords/18 actions; `shot` 2/2. **A `git checkout` before the gate means running
`npx tsc --build --force packages/gui` first**, or the staleness guard reddens on mtimes alone.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add README.md docs/live-testing.md docs/HANDOFF.md
git commit -m "docs: the web gateway has copy AND paste, and says how to invoke both

Three claims were false: the README documented copy as an Edit-menu action (true
only for Electron), still said the gateway had neither direction, and
live-testing.md called the OS clipboard un-checkable when browser-clicks.mjs
checks it over loopback.

Records why Ctrl-C is not the copy key -- the native gesture on Linux is Ctrl-C,
which is the Clear AID here -- and what the human pass still owes: the LAN
non-secure-context branch, and whether a page can claim Ctrl-L on Linux.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the spec

**Spec coverage.** Spec §1 (`Ctrl-Shift-C` in `keys.ts`) -> Task 2. §2 (`Cmd-Shift-C`) -> Task 2.
§3 (the action is plumbed; selection must survive) -> Task 3, including the stale comment the spec
flagged. §4 (the GUI double-copy) -> Task 4, as a measurement rather than a guess. §5 (docs) ->
Task 6. The spec's "Testing" section -> Task 2 Step 1 (chords, the Shift-V non-claim), Task 3
Step 4 (the survival pin), Task 5 (the real-chord harness).

**One place this plan DEPARTS from the spec, deliberately.** The spec said the chord maps to
`{kind:'copy', rect}` in `keys.ts`. That is not implementable: `actionForKey` is pure and cannot
see the selection. Tasks 1-3 use a `requestCopy` intent kind instead, which is why Task 1 exists
at all and is not in the spec. **The spec should be corrected when this lands** — an implementer
reading only the spec would try the impossible version first.

**Not covered, and deliberately out of scope:** `Alt-C` as a Clear alias (independent of this
plan, and the user has not chosen it), and Clear-on-`Ctrl-L` (blocked on a Linux measurement the
user will take). Both are recorded as open in Task 6 Step 4.
