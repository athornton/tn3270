# The save affordance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Save the obvious next step after a receive — name it in the completion message, focus it, and give every overlay button a visible focus ring.

**Architecture:** Three changes in three layers. `ui.css` (shared with the Electron GUI) gains one `:focus-visible` rule. `packages/web/src/transferBoot.ts` focuses Save and appends the hint, both keyed off the single `bridge.hasUnsaved()` read that already decides the button's enabled state. `packages/canvas/src/transferUi.ts` is **NOT** touched — it is shared with the TUI and GUI, neither of which has a Save button.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes` on), vitest + jsdom for units, CDP-driven Firefox/Chromium via `packages/web/scripts/browser-clicks.mjs` for the real-browser cover, plain CSS.

**Spec:** `docs/superpowers/specs/2026-10-22-save-affordance-design.md`

---

## Read this before Task 1

**THE SPEC AND THIS PLAN ARE DRAFTS; THE REPO IS THE SOURCE.** This project has recorded that most
defects found during execution were in the plan's own literal code rather than in the
implementations. **Re-derive every citation below against the tree before you rely on it**, and if
the repo disagrees with this plan, the repo wins — say so in your report rather than making the code
match the plan.

**Three facts this plan depends on, each verified 2026-10-22. Re-check them:**

1. `packages/gui/ui.css` has **no** `:focus` or `outline` rule (`grep -c 'focus\|outline'` → `0`),
   and line 98 is the selector `.ui-surface button, #keypad-overlay button, #transfer-overlay button {`.
2. `packages/web/src/transferBoot.ts:560` is `saveButton.disabled = !bridge.hasUnsaved();`, the last
   statement of the `transferDone` arm before `running = undefined;`.
3. `packages/canvas/src/transferUi.ts`'s `finished()` (around `:423`) calls `deps.setRunning` and
   `deps.setStatus` and **never** `redraw()` — which is why no focus-memo restore can steal the
   focus this plan sets. **If that changed, Task 3 must move the focus call after the redraw.**

**Do not add an ellipsis to any status text.** `transferUi.ts:370` records that Fira Code and
friends ligate `..` and `...`. The `Save…` BUTTON label already uses a real U+2026 and is fine;
status-line text must not use three dots.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/gui/ui.css` | The stylesheet shared by the GUI's two windows and the browser page | Add one `:focus-visible` rule |
| `packages/web/src/transferBoot.ts` | Browser-only DOM wiring for the transfer overlay | Focus Save; append the hint |
| `packages/web/test/transferBoot.test.ts` | Unit cover for the above, if it exists | New cases, or none — see Task 2 |
| `packages/web/scripts/browser-clicks.mjs` | The only real-browser cover for this overlay | Extend the `progress` phase |
| `packages/canvas/src/transferUi.ts` | **UNCHANGED** — shared by three front ends | none |

---

## Task 1: The focus ring

**Files:**
- Modify: `packages/gui/ui.css` (after line 101, the close of the existing button rule)

- [ ] **Step 1: Confirm there is no focus styling to conflict with**

```bash
cd ~/git/tn3270
grep -n 'focus\|outline' packages/gui/ui.css
```

Expected: **no output.** If anything matches, STOP and report it — the premise of this task is that
the file has none, and an existing rule changes the design.

- [ ] **Step 2: Add the rule**

Append after the existing button rule (which closes at line 101):

```css
/*
  THE FOCUS RING, AND IT IS AN ACCESSIBILITY FIX RATHER THAN A FLOURISH.

  Before this rule there was NO `:focus` or `outline` anywhere in this file, so every button in
  the keypad and both transfer surfaces relied on the browser's default ring -- which differs
  between Firefox and Chromium and can read poorly against the `Canvas` background these overlays
  set. The transfer form is deliberately keyboard-navigable (`transferBoot.ts`'s focus memo,
  `transferUi.ts`'s `caretAfterEdit`, and the tab order the field table fixes), so an invisible
  focus indicator was a real defect.

  `:focus-visible` AND NOT `:focus`: the latter leaves a ring behind after a mouse click, which is
  why the pseudo-class was split. PROGRAMMATIC focus still matches `:focus-visible`, which is what
  `transferBoot.ts` relies on when it focuses Save on a completed receive.

  THIS APPLIES TO THE ELECTRON GUI TOO, deliberately. The file is served to the browser from
  `packages/gui` (see `web/src/httpstatic.ts`'s note on the third asset root), and the GUI's keypad
  and transfer windows had no focus indicator either.

  `outline-offset` KEEPS THE RING OFF THE GLYPHS on the small keypad buttons, which are 3.4em wide
  with 3px padding.
*/
.ui-surface button:focus-visible,
#keypad-overlay button:focus-visible,
#transfer-overlay button:focus-visible {
  outline: 2px solid Highlight;
  outline-offset: 2px;
}
```

**`Highlight` is a CSS system colour**, so it follows the operator's own theme and contrasts with
the `Canvas` background these surfaces already use — the same system-colour approach the rest of
this file takes (`GrayText` on the status lines, `Canvas` on the overlay).

- [ ] **Step 3: Verify the stylesheet still parses and is served**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | tail -3
npx vitest run packages/web/test/httpstatic.test.ts 2>&1 | tail -4
```

Expected: build clean, `httpstatic` tests pass. That suite covers `ui.css` being served at all; it
does not read the rule.

- [ ] **Step 4: Commit**

```bash
git add packages/gui/ui.css
git commit -m "fix(ui): overlay buttons had no visible focus indicator

Shared stylesheet, so this reaches the GUI's keypad and transfer windows as
well as the browser overlay. :focus-visible rather than :focus so a mouse
click leaves no ring; programmatic focus still matches, which the Save
autofocus relies on.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: Decide where the unit cover goes

**Files:**
- Inspect: `packages/web/test/` (whatever exists)

- [ ] **Step 1: Find out whether `transferBoot.ts` has unit cover at all**

```bash
cd ~/git/tn3270
ls packages/web/test/
grep -rln "transferBoot\|createTransferBoot\|bootTransfer" packages/web/test/
```

- [ ] **Step 2: Record what you found, and pick the target**

**If a `transferBoot` unit suite exists**, add Task 3's cases there and follow its existing fake-DOM
pattern — do not invent a second one.

**If it does NOT exist**, that is expected and is not a gap to fill in this plan: `transferBoot.ts`'s
own header explains that it only ever runs in a browser and uses `instanceof HTMLInputElement`
against real constructors, which is why `browser-clicks.mjs` exists at all. In that case **Task 3
ships with the real-browser cover in Task 4 as its only test**, and you must say so plainly in the
commit message rather than implying unit cover exists.

**Do not create a new jsdom harness for this file.** The spec does not ask for one, and a fake-DOM
double for a module whose whole point is real DOM would be cover that cannot fail for the right
reasons.

- [ ] **Step 3: No commit** — this task produces a decision, not a change.

---

## Task 3: Name Save in the completion message, and focus it

**Files:**
- Modify: `packages/web/src/transferBoot.ts:558-561` (the tail of the `transferDone` arm)

- [ ] **Step 1: Read the current code, exactly**

```bash
cd ~/git/tn3270 && sed -n '544,562p' packages/web/src/transferBoot.ts
```

You are replacing only these two lines at the end of the arm:

```ts
      // ENABLED ONLY NOW, AND THE PICKER IS NOT OPENED HERE -- see the Save handler above.
      saveButton.disabled = !bridge.hasUnsaved();
      running = undefined;
```

- [ ] **Step 2: Write the replacement**

```ts
      /**
       * SAVE IS ENABLED, NAMED AND FOCUSED HERE, FROM ONE READ OF ONE CONDITION.
       *
       * `hasUnsaved()` is read ONCE into `unsaved` and used for all three, which is the point
       * rather than a tidy: the enablement, the hint and the focus cannot then disagree. A
       * message telling the operator to press a disabled Save is the
       * button-contradicts-the-message defect this file already records fixing once (see the
       * `receiveError` arm above, and `ff89eff`).
       *
       * WHY THE HINT IS APPENDED HERE AND NOT IN `transferUi.ts`'s `finished()`: that module is
       * shared by all three front ends and ONLY THIS ONE HAS A SAVE BUTTON. `gui/transfer.html`
       * has Cancel and Start alone -- Electron writes the file to disk itself -- and the TUI
       * likewise, so naming Save in the shared string would tell those operators to press a
       * button that does not exist.
       *
       * NO ELLIPSIS IN THE STATUS TEXT. Fira Code and friends ligate `..` and `...`
       * (`transferUi.ts:370`). The BUTTON's `Save…` label is a real U+2026 and is unaffected.
       *
       * THE FOCUS MUST FOLLOW THE `disabled` ASSIGNMENT: focusing a disabled button is a no-op,
       * so the order of these statements is load-bearing.
       *
       * NO REDRAW CAN TAKE THIS FOCUS BACK, verified rather than assumed: `finished()` calls
       * `setRunning` and `setStatus` and never `redraw()`, so `renderFields` -- the only caller
       * of `restoreFocus` -- does not run on completion. IF `finished()` EVER REDRAWS, this
       * focus call must move after it.
       */
      const unsaved = bridge.hasUnsaved();
      saveButton.disabled = !unsaved;
      if (unsaved) {
        status.textContent = `${status.textContent ?? ''} — press Save to keep it`;
        saveButton.focus();
      }
      running = undefined;
```

**Read the existing text rather than rebuilding it**, so this cannot drift from `finished()`'s
format: `transferUi.ts` has already written `done: N bytes` (or a refusal) to `#transfer-status` by
the time this line runs, because `ui.finished(...)` is called a few lines above.

- [ ] **Step 3: Build and typecheck**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | tail -3 && npm run typecheck 2>&1 | tail -3
```

Expected: both clean. **`npm run build` is not optional before believing any test** — this repo has
recorded 15 green tests over a build that failed, because vitest does not typecheck.

- [ ] **Step 4: Run the full suite and expect ONE class of failure**

```bash
cd ~/git/tn3270 && npx vitest run 2>&1 | tail -6
```

Expected: **2475 pass**, unless a unit test asserts `#transfer-status`'s exact text after a
completion. If one fails, read it before changing it: if it is pinning `transferUi.ts`'s shared
format it must keep doing so, and only a browser-side assertion should learn the new suffix.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/transferBoot.ts
git commit -m "feat(web): name Save in the completion message, and focus it

A live operator found Start-then-Save one click too many, and the completion
message named no action. Browser-only: transferUi.ts is shared with the TUI
and GUI, neither of which has a Save button.

Enablement, hint and focus all come from ONE hasUnsaved() read, so they
cannot disagree -- a hint over a disabled Save is the
button-contradicts-the-message defect this file records fixing once. The
focus follows the disabled assignment because focusing a disabled button
does nothing.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: Real-browser cover in the `progress` phase

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs` — the `progress` phase (around `:1060-1082`) and its `TRANSFER_CHECKS` entry (around `:373`)

- [ ] **Step 1: Read the phase as it stands**

```bash
cd ~/git/tn3270 && sed -n '1055,1085p' packages/web/scripts/browser-clicks.mjs
grep -n "name: 'progress'" -A4 packages/web/scripts/browser-clicks.mjs
```

It already feeds `transferProgress`, `transferData` and `transferDone` through the page's real
`onmessage`, and already reads `saveMidData` and `saveAfterDone`.

- [ ] **Step 2: Add the three new reads**

After the existing `const saveAfterDone = ...` line, add:

```js
    // THE AFFORDANCE: Save is named on the status line and HAS THE FOCUS, so Enter saves.
    // `activeElement` is read from the page rather than inferred, and the id is compared rather
    // than the label, because the label is `Save…` with a real U+2026 that is easy to mistype here.
    const focusedAfterDone = await cdp.eval('document.activeElement?.id');
    // THE RING IS NOT ASSERTED TO BE VISIBLE -- no harness in this repo reads computed styles, and
    // whether it READS well against the overlay is a rendering judgement for a human. What IS
    // assertable is that the programmatic focus MATCHES `:focus-visible`, which is the pseudo-class
    // `ui.css` styles: a browser that matched only `:focus` here would leave the ring unpainted.
    const ringMatches = await cdp.eval(
      'document.getElementById("transfer-save").matches(":focus-visible")');
```

And capture the mid-transfer negative beside the existing `saveMidData` read:

```js
    const focusedMidData = await cdp.eval('document.activeElement?.id');
```

- [ ] **Step 3: Extend the assertion**

Replace the `doneOk` line and the `if` with:

```js
    // THE BYTE COUNT IS STILL ASSERTED, and that is deliberate: the message now carries a suffix,
    // but a form that printed a CONSTANT must still fail. `startsWith` on the exact
    // `done: N bytes` prefix keeps `finished()`'s format pinned -- the whole point of the old
    // exact-equality check -- while letting this file's own suffix follow it.
    const doneOk = sawDone.startsWith(`done: ${INJECTED_BYTES.length} bytes`)
      && sawDone.includes('press Save');
    if (armed === 'transferring' && sawProgress === '4096 bytes' && doneOk
      && saveMidData === true && saveAfterDone === false
      && focusedMidData !== 'transfer-save' && focusedAfterDone === 'transfer-save'
      && ringMatches === true) {
      ok(check('progress'),
        `progress reached the form (${JSON.stringify(sawProgress)}), then `
        + `${JSON.stringify(sawDone)}, and the ${INJECTED_BYTES.length} received bytes enabled, `
        + 'named and FOCUSED Save (:focus-visible matching, so the ring paints)');
    } else {
      no(check('progress'), 'the three inbound transfer kinds did not all reach the form',
        `armed: ${JSON.stringify(armed)}, after progress: ${JSON.stringify(sawProgress)}, `
        + `after done: ${JSON.stringify(sawDone)}, Save disabled mid-data: ${saveMidData}, `
        + `Save disabled after done: ${saveAfterDone}, focus mid-data: `
        + `${JSON.stringify(focusedMidData)}, focus after: ${JSON.stringify(focusedAfterDone)}, `
        + `:focus-visible matched: ${ringMatches}`);
    }
```

- [ ] **Step 4: Update the phase's `what` and `mutant` fields**

In the `TRANSFER_CHECKS` entry for `progress`:

```js
  {
    name: 'progress',
    kind: 'injected',
    what: 'the three inbound kinds reach the form, and a completed receive enables, NAMES and FOCUSES Save',
    mutant: 'transferBoot.ts  drop the `saveButton.focus()`; or the hint suffix',
  },
```

**`kind` STAYS `injected` — do not change it to `live`.** The existing entry says `injected`
because no host sends these three messages; the run-time report distinguishes the two, and
relabelling a phase that fakes its input as `live` would overstate the evidence. Only `what` and
`mutant` change.

- [ ] **Step 5: Run it**

```bash
cd ~/git/tn3270 && node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -4
```

Expected: `transfer form: 7/7 checks`.

- [ ] **Step 6: PROVE THE NEW ASSERTIONS CAN FAIL — two mutants, run one at a time**

A green phase proves nothing until a deliberate break turns it red. This repo has recorded tests
that passed with the behaviour they claimed to pin deleted.

```bash
cd ~/git/tn3270
# MUTANT A: no focus.
#   Comment out `saveButton.focus();` in transferBoot.ts, then:
npm run build >/dev/null 2>&1 && node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
#   EXPECTED: progress FAILS, reporting `focus after: null` or the previously focused id.
#   Restore the line, rebuild.

# MUTANT B: no hint.
#   Remove the ` — press Save to keep it` append, keeping the focus call, then:
npm run build >/dev/null 2>&1 && node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
#   EXPECTED: progress FAILS on `doneOk`, reporting a `done: N bytes` with no suffix.
#   Restore, rebuild, and confirm 7/7 again.
```

**Record both results in the commit message.** If either mutant leaves the phase GREEN, the
assertion is not wired to the behaviour and must be fixed before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/web/scripts/browser-clicks.mjs
git commit -m "test(web): the progress phase now pins the save affordance

Asserts activeElement is the Save button after a completed receive, that it
is NOT focused mid-transfer, and that the status line names Save. Keeps the
byte count asserted via startsWith, so a form printing a constant still
fails -- which was the point of the old exact-equality check.

Also asserts the focused button matches :focus-visible, which is what makes
ui.css's ring paint. It does NOT assert the ring is visible: no harness here
reads computed styles, and that is a judgement for a human eye.

Mutation-proved: dropping the focus call and dropping the hint each turn the
phase red.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: The full gate, the docs, and the handoff

**Files:**
- Modify: `docs/live-testing.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Run the whole gate**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2
node packages/gui/scripts/keys.mjs 2>&1 | tail -2
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2
node packages/gui/scripts/select.mjs 2>&1 | tail -2
node packages/gui/scripts/shot.mjs 2>&1 | tail -2
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -2
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -2
```

**`shot.mjs` AND `browser-shot.mjs` ARE THE ONES TO WATCH.** They compare rendered goldens, and
this change touches a shared stylesheet. A golden diff here is a REAL result, not noise: report it
and stop rather than regenerating. The `:focus-visible` rule should not fire in an unfocused
screenshot, so the expectation is that both still match — if they do not, the rule is painting when
nothing is focused and the design is wrong.

`drive-playback.py` and `drive-e.py` are **not** required: nothing here touches telnet negotiation
or the stream layer. Say so in the commit rather than leaving it implied.

- [ ] **Step 2: Record it in `docs/live-testing.md`**

Add to the 2026-10-22 entry's UX-defect paragraph that the hint-and-focus option was BUILT, with the
phase that covers it and the two mutants that proved it. **State that the ring's visibility is
unwitnessed** until the user looks at it in Firefox — this file's convention is that an unqualified
claim means it was witnessed, and no harness can judge a ring.

- [ ] **Step 3: Update `docs/HANDOFF.md`'s item 3**

It currently says the user "has not chosen" between uniformity and the better flow, and names the
middle option. Replace with: the user chose the hint-and-focus option, it is built, auto-save was
declined, and the focus ring was added for all overlay buttons because `ui.css` had no focus styling
at all.

- [ ] **Step 4: Commit**

```bash
git add -A docs
git commit -m "docs: the save affordance is built, and the ring awaits a human eye

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `:focus-visible` ring, ALL overlay buttons, `ui.css:98` selector | 1 |
| Shared with the Electron GUI, intentionally | 1 Step 2 comment; 5 Step 1 watches the goldens |
| Autofocus Save on a receive with bytes, AFTER `disabled = false` | 3 Step 2 |
| Keyed off `hasUnsaved()`, one read, so nothing can disagree | 3 Step 2 (`const unsaved`) |
| Message names Save, BROWSER ONLY, `transferUi.ts` untouched | 3 Step 2; File Structure row says UNCHANGED |
| Does NOT auto-save | nothing implements one; stated in 5 Step 3 |
| `activeElement` is Save; Save NOT focused mid-transfer; text names Save | 4 Steps 2-3 |
| The `done: N bytes` equality must be updated deliberately, keeping the count | 4 Step 3 (`startsWith` + `includes`) |
| Ring visibility is NOT claimed to be verified | 4 Step 2 comment; 5 Step 2 |
| Out of scope: direction labels, keypad opacity | neither appears in any task |
