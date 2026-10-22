# The save affordance — naming and focusing Save, and a focus ring — design

**Status: designed and approved 2026-10-22. Not implemented.**

**The problem, from a live run.** On 2026-10-22 the first real operator round-tripped a file
through the browser front end (`live-testing.md`, newest entry) and reported the two-step
Start-then-Save as one click too many: *"if I started the transfer, of course I want to save the
file"*. Most of the friction was **not knowing Save was the next step** — the completion message
says `done: 249 bytes` and names no action.

**What this does NOT do: it does not auto-save.** That option was considered and declined by the
user in favour of this one. Auto-saving on completion is impossible on the picker route anyway —
`showSaveFilePicker` requires transient user activation and the starting click is spent by the time
`transferDone` arrives — so building it would have meant auto-saving only on the `<a download>`
fallback, i.e. only on the browsers WITHOUT a picker, giving the less capable browsers the better
flow. The asymmetry is the reason this design exists instead.

## Three changes, each in the layer that owns it

### 1. A focus ring for every overlay button (`packages/gui/ui.css`)

**There is no focus styling anywhere in `ui.css` today** — 235 lines, zero `:focus` or `outline`
rules — so the buttons rely on each browser's default ring, which differs between Firefox and
Chromium and can read poorly against the overlay's `Canvas` background. The form is deliberately
keyboard-navigable (the focus memo, `caretAfterEdit` and tab order all exist for that), so a
missing focus indicator is a real accessibility defect and not merely cosmetic.

**Scope: ALL overlay buttons, per the user's explicit choice** — the same selector that already
styles them, `.ui-surface button, #keypad-overlay button, #transfer-overlay button` (`ui.css:98`).
A ring on Save alone would look like a bug.

**`:focus-visible`, NOT `:focus`.** `:focus` leaves a ring behind after a mouse click, which is the
reason browsers moved to `:focus-visible`; programmatic focus — this design's whole point — still
matches `:focus-visible`.

**THIS RULE IS SHARED WITH THE ELECTRON GUI.** `ui.css` lives in `packages/gui` and is served to
the browser as a third asset root, for the reasons `httpstatic.ts:133` sets out at length. So the
GUI's keypad and transfer windows get the ring too. That is **intended**: they have no focus
indicator either, and the user requirement that the keypad and transfer window look alike is what
made the file shared in the first place.

### 2. Autofocus Save when a receive completes with bytes to save (`packages/web/src/transferBoot.ts`)

At the existing `saveButton.disabled = !bridge.hasUnsaved()` line in the `transferDone` arm
(`transferBoot.ts:560`).

**Gated on `bridge.hasUnsaved()` — the same condition that enables the button.** One condition, read
once, used for both, so the focus and the enablement cannot disagree.

**THE FOCUS MUST FOLLOW THE `disabled = false` ASSIGNMENT, not precede it: focusing a disabled
button is a no-op.** This is the one ordering constraint in the change.

**No conflict with the focus memo, verified rather than assumed.** `rememberFocus`/`restoreFocus`
run only inside `renderFields`, and `finished()` calls `setRunning` and `setStatus` but **never
`redraw()`** (`transferUi.ts:423-431`) — so no render, and no restore, happens on completion. If a
future change makes `finished()` redraw, this autofocus must move after that redraw or the memo
will take the focus back.

### 3. Name Save in the completion message — BROWSER ONLY (`packages/web/src/transferBoot.ts`)

**`transferUi.ts` keeps emitting `done: N bytes` UNCHANGED.** That module is shared by all three
front ends, and **only the browser has a Save button**: `gui/transfer.html:80-82` has Cancel and
Start only, because Electron writes the file to disk itself, and the TUI likewise. Changing the
shared string would tell GUI and TUI operators to press a button that does not exist.

So `transferBoot.ts` appends the hint from its own `transferDone` handler, **keyed off
`hasUnsaved()`** for the same reason as the focus: `transferBoot.ts:523-545` records a case where
the transfer succeeds host-side but a chunk was refused, leaving nothing to save — and a message
telling the operator to press a disabled Save is the button-contradicts-the-message defect that
file already records fixing once.

**Rejected alternative:** a new `saveHint()` dep on `UiDeps` that the web injects and the others
leave empty. More principled if the TUI or GUI ever grows a Save button, but it adds a seam to a
shared interface for one consumer's text, and would still require updating the two GUI tests. The
`transferUi.ts` / `transferBoot.ts` split — model and view decisions in the shared module, real DOM
and browser-specific text in the boot module — already puts this text in the boot module.

## Verification, and what cannot be verified

**`browser-clicks.mjs`'s `progress` phase is the hook, and it already does most of the work.** It
drives a receive to completion with injected `transferProgress`/`transferData`/`transferDone`
through the page's real `onmessage`, and already asserts the `done:` text and Save's enabled state
both mid-transfer and after. Extend it to assert:

- **`document.activeElement` IS the Save button** after the receive completes.
- **the status text names Save.**
- **Save is NOT focused mid-transfer**, which is the negative that stops a blanket focus call from
  passing. The phase already reads `saveMidData` at that point.

**THAT PHASE'S EXACT-EQUALITY ASSERTION WILL FAIL AND MUST BE UPDATED DELIBERATELY.** It asserts
``sawDone === `done: ${N} bytes` ``, which is what pins the format; the new expectation must keep
asserting the byte count, so a form printing a constant still cannot pass.

**THE RING'S VISIBILITY CANNOT BE VERIFIED BY ANY HARNESS IN THIS REPO, AND IS NOT CLAIMED TO BE.**
The harnesses check CSS *behaviourally* — hit-testing, `elementFromPoint` — and never read computed
styles; whether a ring reads clearly against the overlay is a rendering judgement, and this project
has recorded that apparent rendering bugs are sometimes the emulator rather than the code. A
harness can assert the rule *matches* (`el.matches(':focus-visible')`), which is strictly weaker
than "it looks right". **The user will eyeball it once in Firefox**, as they did the transfer
itself.

## Out of scope

- **Auto-save on completion.** Declined above.
- **The direction-label data-loss defect** (`transferForm.ts:58`), which is the more dangerous open
  item and needs its own design.
- **The keypad overlay's opacity**, still awaiting the user's decision, and where
  `keypadOverlay.ts` records that opacity is load-bearing.
