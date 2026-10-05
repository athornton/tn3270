# The keypad, out of the canvas and into real controls — design

**Status:** approved 2026-10-06, not started.
**Roadmap position:** (0b), immediately after GUI copy and paste (0ab), which merged at `d949243`.
**Scope:** the keypad's PRESENTATION, in **both** canvas front ends. The 48 keys, their actions and
their names do not move.

## Why this exists

The user's judgement after using the shipped keypad, 2026-09-30, in their own weighting:

- **it is ugly** — strongly. Inverse video on a spaced grid, drawn through x3270's own `3270.bdf`
  atlas, so the buttons are 3270 glyphs rather than anything resembling a button.
- **it is modal in an annoying way** — strongly. `Ctrl-K` toggles it and it is awkward to leave up
  while working.
- it is somewhat awkward to aim at: 48 buttons, no tooltips, no keyboard navigation in the GUI.
- **screen space is explicitly NOT a concern.**

**That the complaints are "ugly" and "modal" and not "it takes space" is the load-bearing fact.** The
problem is not that the keypad occupies the window — it is that it is **drawn in the wrong medium**.
A design that merely shrank it would fix nothing the user minds. So the answer is real controls, in
both front ends.

**The user's guiding principle for the whole job: *if in doubt, do what x3270 does*.**

## THE DECISIONS, AND WHICH ARE THE USER'S

Taken by the user on 2026-09-30 and 2026-10-06. Recorded so none is re-litigated.

| Decision | Answer |
|---|---|
| GUI presentation | **A separate `BrowserWindow`**, detached and free-floating |
| **WEB presentation** | **AN OPAQUE OVERLAY IN THE SAME PANE**, not a second browser window |
| Both must | **look stylistically similar to each other and to the transfer window** |
| `Ctrl-K` | **Opens** it, and stays a hotkey, joined by a toolbar control |
| Persistence | **None.** Every launch starts closed, confirmed on its merits |
| `clicks.mjs` | **Rewired to real DOM buttons, keeping the by-LABEL property** |
| Tooltips | **`name` always; `BINDING_INTENT`'s note where one exists** |
| The 48 keys | **Stay in `frontend`.** Presentation changes; the table does not |

### The web keypad is an in-pane overlay, and that is a deliberate asymmetry

The GUI gets a **window**; the web gets an **overlay in the same pane**. This is not an
inconsistency to tidy — a browser tab cannot open an OS window the operator can place beside the
terminal, and `window.open` for a palette would be a popup-blocked second document with its own
WebSocket question. The pane is what the web has.

**Opaque, not translucent**, per the user, and there is a measured reason to respect it: the TUI's
overlay had host text leak through into its chord column, and opacity was the hard-won fix. An
overlay that lets the screen show through is a legibility bug waiting to be re-found.

## What this changes, and what it must not

### BOTH front ends stop drawing a keypad into the `DrawList`

This is the biggest consequence of making the web keypad HTML too, and it is bigger than the idea
doc anticipated — that doc assumed the web stayed canvas-drawn and `keypad.ts` kept exactly one
consumer. **It does not. It keeps none.**

Verified consumers of the canvas keypad geometry, 2026-10-06:

- `keypadRegion` / `KEYPAD_ROWS_TALL` — used **only** by `canvas/src/drawlist.ts:130` and
  re-exported by the barrel. No other package calls either.
- `hitTest` / `hitTestAt` — used **only** by `canvas/src/renderer.ts:438`, for the keypad click.
  **Note `renderer.ts` still needs `hitTestAt`'s arithmetic in spirit**: the copy/paste work added
  `cellAt`, which is documented as that function's inverse. Removing the keypad does not remove the
  need for the inverse pair to agree.

**So this is deletion, not divergence** — the opposite of the idea doc's conclusion, and the single
most important correction in this spec. `showKeypad`, the `fit()` window-growing path, the
`keypad?` member of `DrawList`, `keypadRegion`, `KEYPAD_ROWS_TALL`, `KeypadRegion`, `hitTest`,
`hitTestAt`, `KeypadButton` (no consumer outside `canvas` today, verified) and the renderer's whole
keypad branch all become **dead at the same moment**.

**`BROWSER_MODULES` loses `hittest.js`, NOT a keypad entry** — stated precisely because the obvious
guess is wrong. That list is
`['renderer.js', 'blit.js', 'keys.js', 'hittest.js', 'selection.js']`; `keypad.js` was never in it,
because the keypad's *geometry* is computed in `drawlist.ts` on the server/main side and only the
*hit test* runs in the browser. `httpstatic.test.ts` carries an exact-count guard on that list (5
today) and a hardcoded existence loop, both of which must move with it — the copy/paste work hit
the same two assertions going the other way.

**DELETE THEM IN ONE STEP RATHER THAN LEAVING THEM.** A recorded finding applies directly:
*deleting a gate breaks its tests silently* — its tests pass on the next check down, and the gate
was guarding a caller you forgot. The same shape here is code kept "in case the web needs it",
whose tests keep passing while nothing calls it.

**38 TESTS LOSE THEIR SUBJECT.** All **32** in `canvas/test/keypad.test.ts` (`keypadRegion`,
`hitTest`, `hitTestAt`) plus the **6** in `canvas/test/drawlist.test.ts`'s
`describe('the keypad region')` block, which asserts the keypad's contribution to `DrawList.height`.
**That second file is the one a build will not warn about**, because test files are not typechecked
here — `vitest` strips types rather than checking them, so its import of `KEYPAD_ROWS_TALL` fails
at run time, after the build looks clean.

They are not bad tests — `hitTestAt`'s are the ones that pin the inverse arithmetic at scale 3 with
a non-zero offset, which the Xvfb harnesses explicitly *cannot* reach. **So the total test count
will FALL, and the plan must say so rather than letting a drop look like breakage.** A recorded
finding is exactly on point: *merge totals hide lost tests* — a count that moves for two reasons at
once hides one of them. **State −38 from the deletion and + whatever the new tests add as separate
numbers, against the 2312 baseline.**

**AND ONE LIVE DEPENDENCY THE COPY/PASTE WORK JUST CREATED.** `renderer.ts`'s `cellAt` computes
`const screenBottom = list.oia?.y ?? list.keypad?.y ?? list.height;` — the keypad is one of its
three bounds, there so a selection drag cannot run onto the keypad. **With no keypad in the draw
list that middle term is dead** and the expression simplifies to `list.oia?.y ?? list.height`.
Simplify it deliberately and keep the comment explaining why the OIA is still excluded; leaving a
`?? list.keypad?.y` that can never fire is a reader trap, and the selection harness
(`select.mjs`, 3/3) is what proves the simplification did not break the bound.

### The goldens shrink, and that is the honest outcome

`synthetic-ispf-keypad` is a picture of a canvas-drawn keypad. **Once neither front end draws one,
that golden photographs something that no longer exists.** It cannot "move to the web harness", as
the idea doc suggested, because the web will not draw one either.

- `shot.mjs` goes **3 → 2** cases.
- `browser-shot.mjs` goes **2 → 1** case, losing its `Ctrl+K` case.
- **The golden PNG is deleted**, not regenerated.

**This weakens the cross-front-end pixel evidence and the spec says so rather than hiding it.**
`browser-shot.mjs`'s surviving case still proves `renderer.ts` is genuinely shared — it compares the
browser's pixels against the GUI's own golden, which is the property that matters — but the keypad
is no longer part of that proof. **What replaces it is stronger for the keypad specifically and
weaker for the pixels:** a DOM keypad's layout is asserted by querying real buttons by label, which
a pixel diff never did.

### What must NOT be disturbed

- **The 48 keys and their actions stay in `packages/frontend/src/keypad.ts`.** `keypad.test.ts` pins
  label/action pairs with a deliberately duplicated map so a mismatch cannot hide. A presentation
  change must not become an excuse to re-derive the table.
- **`row`/`col` stay on `KeypadKey`** even though a DOM layout ignores them. They are canvas
  geometry with no remaining consumer, but deleting fields from a 48-row table in the same change
  that rewrites two front ends mixes two risks. **Mark them deprecated in the docstring; delete
  later.**
- **`applyAction` must keep throwing on `toggleKeypad`.** It is the front end's own display
  decision, and the throw is what makes a front end that forgot the arm fail loudly.
- **The TUI's overlay is untouched.** It is a different answer to the same action, it is liked, and
  `tui/src/keypadOverlay.ts` is out of scope entirely.
- **All four of Sys Req, Dup, Field Mark and Newline keep a route** — and **the precise claim,
  corrected during Task 1 because the original overstated it: only `SysRq` and `NewLn` have NO
  chord at all.** `Dup` and `FldMk` are Ctrl-D/Ctrl-F in both the terminal keymap
  (`frontend/src/keymap.ts:190-191`) and the GUI/web mapper (`canvas/src/keys.ts:77-78`), so
  losing their buttons would cost the MOUSE route, not every route. `SysRq` and `NewLn` are the
  two with nothing else, and they are the ones a dropped button makes genuinely unreachable.
  Keeping all four is still the requirement; knowing which two are load-bearing matters when
  triaging a failure.
- **`Xfer` stays a keypad button**, and its action still opens the transfer window. Clicking a
  button in one palette to open another window is fine; it already works that way.

## Architecture

Four units. The pattern is the transfer window's, which is the precedent to read first.

### 1. `packages/frontend/src/keypadView.ts` *(new)* — the presentation-neutral model

Pure. Groups the 48 keys into DOM-friendly blocks and pairs each with its tooltip text. No DOM, no
Electron, no `Session`.

- **Takes the grouping it needs rather than reusing `row`/`col`**, which are cell coordinates for a
  blitter. A DOM layout wants "the PF13-24 row", "the cursor cluster", not a column number.
- **Tooltip text is composed here and unit-tested here**, which matters because the data is uneven:
  **`BINDING_INTENT` covers 26 of the 48 keys. The 22 without one are PF14-24, PF2-11, `SysRq` and
  `NewLn`** (measured 2026-10-06). Every key does have a `name`. So the rule is **`name` always,
  plus `BINDING_INTENT`'s note when present** — nothing is ever blank, and the 22 bare ones are
  mostly PF keys whose meaning is host-dependent and cannot honestly be described beyond their
  number.

### 2. `packages/gui/keypad.html` + `packages/gui/src/keypadUi.ts` *(new)* — the GUI window

A second `BrowserWindow` with its own preload and its own bridge, **exactly** the transfer window's
shape. `keypadUi.ts` takes its DOM **injected**, as `transferUi.ts` does, because
`vitest.config.ts` sets `environment: 'node'` and there is no `document` in any test here.

**The import map is what makes a browser-loaded module legal**, and the feasibility is measured
rather than assumed: `frontend/dist/keypad.js` and `frontend/dist/bindings.js` each have **ZERO
runtime imports** (8209 and 5052 bytes, 2026-10-06), so a one-entry map per specifier closes the
graph at a single file — the same property `transferModule.test.ts` pins for the transfer form, and
the same failure if it expires: **a blank window with no error in any console.**

### 3. `packages/web/static/` — the overlay

The same markup and the same stylesheet, rendered into a positioned element over the canvas rather
than into a window. Opaque background. `Ctrl-K` toggles its visibility; the canvas keeps the
keyboard.

**The canvas must stay at the viewport origin.** `main.ts:1234` records that the click path depends
on `html,body{margin:0}` and `canvas{display:block}` — "give the page a body margin and every click
here misses by it". An overlay is therefore **absolutely positioned over** the canvas, never a
sibling that displaces it.

### 4. A shared stylesheet — `packages/gui/ui.css` *(new)*, served by the web too

The user's requirement that the keypad and the transfer window be stylistically similar is what
makes this a file rather than two copies of a `<style>` block. `transfer.html` currently inlines its
CSS; the keypad would be the second copy, and the web overlay the third.

**One stylesheet, three documents.** `httpstatic.ts` already serves cross-package assets through
`assetDir()`, so the web side has a mechanism. The transfer window's existing rules move into it
unchanged — `:root { color-scheme: light dark }`, `font: 13px system-ui`, `GrayText` labels — which
is what "native, not X-ish" means concretely.

## Data flow

Unchanged from today, and that is the point: **a button click produces the same `Action` it always
did.**

**GUI:** click a DOM button → keypad preload `sendAction` → IPC → `main.ts`'s existing
`ipcMain.on('action')` → `applyAction`. The canvas window's four-function bridge is untouched.

**Web:** click a DOM button → the existing `bridgecore` `sendAction` → WebSocket → the gateway's
existing handler. **No new protocol message**, which is the asymmetry that makes this cheap where
web copy was not.

## Testing

| What | How |
|---|---|
| Grouping and tooltip composition | Unit tests on `keypadView.ts`, including the 22-key `BINDING_INTENT` gap |
| Label/action pairs for all 48 | **Already covered** by `frontend/test/keypad.test.ts`; untouched |
| The GUI window boots at all | Xvfb. `transferUi`'s TDZ blank-window bug is the precedent — **load it, don't reason about it** |
| The click path, GUI | **`clicks.mjs`, rewired**: a DOM query by label replaces `__tn3270ButtonCenter` |
| The click path, web | `browser-keys.mjs` gains keypad cases |
| Nothing regressed | Full gate, and the two shrunken golden sets |

**`clicks.mjs` keeps its by-LABEL property, which is the whole reason it has value.** A coordinate
list would be a second copy of the layout that passes while the layout is wrong. It also stays the
only cover for 9 of the 48 label/action pairs, so **it is rewired, never retired.**

## What this does NOT do

- **No preferences, and no persistence.** Confirmed on its merits: *"making the user reopen the
  keypad on each new application start, if they need it, is fine."* **This is explicitly NOT on the
  list of things a future preferences store should bring.**
- **No keyboard navigation of the palette** beyond what native focus order gives for free. Tab
  order comes from DOM order at no cost; anything more is its own job.
- **No icons.** The arrows, Home, Tab and Newline may want drawn or sourced glyphs, and a DOM is no
  longer limited to the 3270 character set — but **licensing matters** if icons are sourced, and
  this repo is careful about vendored assets. **Text labels first.**
- **No new placements.** x3270 has five (`left`, `right`, `bottom`, `integral`, `inside-right`,
  `x3270/keypad.c:318-332`); we ship `integral` today and will ship **detached** for the GUI and
  **in-pane overlay** for the web. Offering a choice is a preferences question.
- **No `row`/`col` deletion.** Deprecated in place.
- **No TUI change.**

## Open questions

**None.** Presentation (both front ends), placement, persistence, tooltips, the harness rewire and
the shared styling were all decided by the user on 2026-09-30 and 2026-10-06.
