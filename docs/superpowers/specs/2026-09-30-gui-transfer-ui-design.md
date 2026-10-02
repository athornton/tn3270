# IND$FILE transfer UI for the Electron GUI — design

**Status: designed, not built. 2026-09-30.** Scope is the **Electron GUI only**. The web gateway is
deliberately out of scope and stays refused; see *What this does not do* for why, and what it must
become instead.

Roadmap item 2 of the *what remains* list in `docs/HANDOFF.md`. The protocol work is finished and
live: CUT and DFT both transfer against real hosts, the host chooses the protocol, and
`packages/frontend/src/transferRun.ts` was moved out of `packages/tui` **for exactly this consumer**.
This spec adds a renderer, not transfer logic.

## The decisions the user made, 2026-09-30

Recorded first because the design follows from them and none is derivable from the code:

1. **GUI only now; the web gateway gets real browser file I/O later** — "local file is the operator's
   machine, and that does sound like a larger job."
2. **Native file dialog for the local file, typed field for the host file.** The host file must be
   typed: only the host knows its own datasets.
3. **A separate `BrowserWindow` with real HTML controls**, not a region drawn into the canvas.
4. **While a transfer runs, the window refuses to close**; an explicit Cancel is the only route.
5. **The transfer window gets its OWN preload**, not a widened canvas bridge.

## Why a separate window rather than the keypad's pattern

The keypad converged: model in `frontend`, geometry in `canvas`, drawn into the `DrawList`,
hit-tested by the renderer. A transfer form deliberately **diverges**, for three reasons that are
about capability rather than taste:

- **`renderer.ts` must stay untouched.** It is reused UNMODIFIED by the web gateway, and
  `packages/web/src/bridgecore.ts:5` records the rule that keeps it so: *"If this file grows a fifth
  function, the renderer has stopped being shared."* Drawing the form into the canvas would require
  teaching the renderer text editing and focus; an HTML overlay in the same page would put non-canvas
  DOM into the page the renderer owns. Both erode the seam four separate recorded traps protect.
- **Text entry is what a browser already does well.** The TUI needed ~90 lines
  (`app.ts:consumeTransferKey`) to handle split escape sequences, backspace and printable filtering
  in a terminal. Reproducing that in a canvas buys nothing.
- **The file dialog needs the main process anyway**, so a window with its own channel is its natural
  home.

**x3270 does the same thing**: its transfer dialog is Xaw widgets, not drawing on the 3270 canvas.

**Accepted cost, stated plainly: it will not look like a 3270 screen.** It will look like a native
dialog. The alternative was a form typeset from a 1980s bitmap font in CG order, which is worse.

## Architecture

```
packages/gui
  src/main.ts                owns the Session, BOTH windows, BOTH IPC namespaces
  src/transferWindow.ts      create/show/focus/close, and the running-transfer close guard
  src/transferPreload.cts  → .cjs   the transfer window's own contextBridge
  transfer.html              real HTML controls
  src/transferUi.ts          browser-side form logic — NO workspace runtime imports
```

**Two windows, two preloads, one `Session`.** `main.ts` is already the only module that knows about
the session and the socket; it becomes the only one that knows there are two windows.

**The canvas window is not modified at all.** Its preload keeps exactly four functions
(`onAtlas`/`onFrame`/`onError`/`sendAction`), so `renderer.ts` stays shared and the web gateway is
unaffected by this work.

### Reused unchanged from `@tn3270/frontend`

All already exported (verified in `packages/frontend/src/index.ts`):

`TRANSFER_FIELDS`, `applicable`, `cycleField`, `setFieldText`, `moveField`, `newTransferForm`,
`formKeywords`, `transferCommand`, `startTransfer`, `TransferFiles`, `TransferRequest`,
`StartTransferOptions`, `TransferRun`.

**`transferForm.ts` is NOT modified.** Its docstring states the central rule — the form never
validates, it collects strings and `parseTransferKeywords` is the authority — and the GUI honors
that by calling `transferCommand` and displaying its error, exactly as the TUI does. If the two ever
disagree, the validator wins.

### One genuinely new dependency

`packages/gui/package.json` gains **`@tn3270/node-files`**, for `nodeTransferFiles`. The GUI has
never done file I/O, so it does not have it today. This is an addition, not an oversight: the graph
`core ← frontend ← { cli, tui, canvas, gui, web }` already permits it, and `cli`/`tui` take the same
dependency for the same reason.

## The form

**Built FROM `TRANSFER_FIELDS` at load time, not hardcoded in HTML.** A field added in `frontend`
must appear here without an HTML edit, or the two front ends drift — which is the failure the shared
model exists to prevent.

- `kind: 'cycle'` → `<select>`, options from the model's own `valuesFor` logic, so **VM still loses
  `Recfm=undefined`** without that rule being written twice.
- `kind: 'text'` / `'numeric'` → `<input type="text">`, routed through `setFieldText`.

**Numeric filtering goes through the model, not through `<input type="number">`.** `setFieldText`
refuses non-digits and over-width values; browser number validation differs by engine and would let
the GUI accept what the TUI rejects.

**Applicability hides rather than disables**, matching the TUI's omit-don't-grey rule, and — the part
that matters — **the value clearing happens in the shared model**. Every edit re-runs
`cycleField`/`setFieldText`, whose `clearInapplicable` iterates to a fixed point because the rules
chain. Clearing in the DOM instead would let the GUI submit a keyword the TUI would have wiped.

### The local file, and the `Exist` collision

`Browse…` sits beside an **editable** field:

- `Direction=send` → `dialog.showOpenDialog`, single selection, must exist.
- `Direction=receive` → `dialog.showSaveDialog`.

The field stays typeable, so a path that does not exist yet still works and nothing the TUI can do is
lost.

**THE DIALOG DOES NOT SET `Exist`, and this must not be "improved" later.** A Save dialog asks about
overwriting, so there would otherwise be two overwrite authorities disagreeing. `Exist` is a
THREE-way choice — `keep`/`replace`/`append` — and **`append` has no dialog equivalent at all**, so
letting the chooser decide would make one legal transfer unexpressible. It stays the operator's
explicit selection, and `startTransfer` enforces it before the host is told anything
(`Exist=keep` on an existing file refuses locally). One authority, unchanged, in one place.

## IPC: the transfer window's own bridge

Five functions in `transferPreload.cts`. `contextIsolation` stays on and `nodeIntegration` stays
off — a window that handles file paths and host credentials is the last place to grant Node access.

| dir | function | shape |
|---|---|---|
| ↑ | `browse(direction)` | `invoke`; resolves to a path, or `undefined` if the dialog was canceled |
| ↑ | `submit(keywords)` | `invoke`; resolves to `{ ok: false, error }` for a local refusal, else `{ ok: true }` |
| ↑ | `cancel()` | `send` |
| ↓ | `onProgress(fn)` | `on`; text plus phase |
| ↓ | `onDone(fn)` | `on`; `{ ok, error?, bytes? }`, **exactly once** |

`submit` and `browse` are `invoke`/`handle` because they return values; the rest are `send`/`on`.

**Five functions here does not violate the four-function rule.** That rule is about the CANVAS
bridge, whose width is what lets `renderer.ts` be shared with the browser. This is a different
window with a different surface, which is precisely why the user chose a second preload: widening the
canvas bridge would force the web gateway to stub functions it can never implement — there is no
native file dialog in a browser, and the gateway's filesystem is not the operator's.

### The served-module problem, and its measured solution

`transferUi.ts` runs in a browser context, so it **cannot import `@tn3270/frontend`**: a bare
specifier with no bundler leaves a blank window and no error, a trap this repo has recorded four
separate ways.

**MEASURED, not assumed: `packages/frontend/dist/transferForm.js` is 9141 bytes with ZERO runtime
imports and zero `require` calls.** Its only dependencies are `import type`, which erase. So it is
self-contained and can be served to the transfer window directly — exactly the justification
`packages/canvas/src/hittest.ts` carries for being its own module.

Therefore:

- `transfer.html` loads `transferUi.js`, which imports `transferForm.js` by **relative path**.
- **The GUI loads from `file://`, so nothing is "served" — the relative path must resolve on disk.**
  This differs from the web gateway, which serves `BROWSER_MODULES` over HTTP and 404s a module
  missing from that table. Here the failure mode is a resolve error instead, but the symptom is the
  same blank window. `packages/gui/index.html` already reaches across packages with
  `../canvas/dist/renderer.js`, so **`transfer.html` reaching `../frontend/dist/transferForm.js` is
  the established pattern in this package** and needs no copy step.
- **Pinned by a graph-CLOSURE test, not a per-file existence check.** The repo's own lesson is that a
  per-file check cannot catch a module missing from the table itself (`bridgecore.js` 404'd exactly
  that way). The test must walk the BUILT `transferUi.js`'s import graph and assert every specifier
  resolves to a file that exists.
- **A test must assert `transferForm.js` still has no runtime imports.** The day someone adds one to
  `transferForm.ts`, this window goes blank with no error. That guard is the whole basis of this
  choice and must fail loudly if the premise expires — measured at 9141 bytes and zero imports on
  2026-09-30, but that is a fact with a date, not an invariant.

## Lifecycle

- **Submit** → `formKeywords` → `transferCommand` → `startTransfer`.
  A local refusal (`not in 3270 mode`, `keyboard locked`, `no input field`, `file exists`,
  `input field too small`) shows on the form and **nothing reached the host**; the window stays open
  with what was typed. This is `transferRun.ts`'s documented order-of-operations rule and the GUI
  inherits it for free.
- **Running** → every field and Submit disabled, Cancel enabled, progress live from `onProgress`.
- **Close is intercepted while running.** The `close` event is `preventDefault`ed and Cancel is
  focused. Per the user's decision: an accidental Cmd-W or red button cannot abandon a transfer.
- **App quit cancels FIRST, then quits.** The window may refuse a close; it may not make the
  application unquittable. `TransferRun.cancel` already distinguishes *aborting* a DFT transfer that
  has started (defer, let the engine tell the host on its next frame) from *discarding* one that lost
  the protocol race (send nothing), and refuses a CUT abort at a geometry with no frame layout to
  write into. **No new cancellation logic is needed** — only a guarantee that `cancel` is reached on
  every close path.
- **`onDone` fires exactly once**, which `finish`'s `ended` guard already guarantees against every
  race between a completion, a deadline and a cancel.

**One session, one transfer.** Reopening the window mid-transfer shows the RUNNING state, not a fresh
form — two submits would interleave two machines' frames on one screen, and the TUI already refuses a
second Enter for that reason.

### The teardown rule this must not break

`cancel` must be reached on **every** path that ends the window: Cancel button, intercepted close
after completion, app quit, and the session closing under it. This project has fixed the shape *one
teardown path clears the state and another does not* **three times** in `session.ts` alone
(`Session.e` on the REJECT path, `IAC DONT TN3270E`, and `handleClose` not clearing `dft`). A fourth
instance here would leave `session.dft` set with the window gone.

## Testing

**What unit tests can reach**, and it is most of it, because the model and the driver are already
pure and already tested: form construction from `TRANSFER_FIELDS`, applicability-driven hiding,
`Exist` independence from the dialog, keyword emission, and the disabled/enabled state machine across
phases. These need no Electron.

**What needs the Electron harness**, following `clicks.mjs`/`keys.mjs`: that the window opens, that
`Browse…` reaches `dialog`, that Submit produces the expected keywords, that a running transfer
refuses to close, and that quit cancels. The seam should be **env-var driven and stub the dialog**,
because a real native chooser cannot be driven headlessly — and because the seam must not be able to
reach a real host. `TN3270_GUI_REPLAY`'s privacy argument applies unchanged: a transfer seam that
could log a typed path and a real logon is a seam that can leak.

**What has no test and must be said so**: that the native dialog looks and behaves correctly on macOS.
There is no macOS here. `docs/live-testing.md` gets a by-hand item.
**CLOSED 2026-10-02: the user
verified it on a Mac, GUI and TUI, to and from VM in ASCII mode** -- a mode no scripted run has
used, and one where the HOST does the translation because our local `upload_convert` half is still
unimplemented (`core/src/ft/cut.ts`, *SCOPE: binary mode only*).

**A golden is NOT proposed for this window.** The canvas goldens exist because glyph rendering through
a baked atlas is byte-reproducible; a native form is system-font-dependent and would not reproduce
across machines — the same reason `composite-model-idea.md` records that TrueType-by-default cannot
share the GUI goldens.

## What this does not do

- **The web gateway stays refused.** `packages/web/src/protocol.ts` rejects the `transferForm` action
  with a reason that remains accurate: a browser-initiated transfer would move bytes between the host
  and the **gateway's** filesystem, not the operator's. The user's decision is that the browser must
  get **real browser file I/O** — the bytes travel over the WebSocket so that "local file" means the
  operator's machine. That needs a new protocol message pair, chunking, and a `TransferFiles`
  implemented over the socket. It is a larger job and its own spec. **The refusal message should be
  updated to say "the browser front end needs socket-carried file I/O" rather than "the gateway has
  no transfer UI", which will have stopped being the reason.**
- **No transfer history, no queue, no multiple concurrent transfers.** One session, one transfer.
- **No progress in the main window.** Progress lives in the transfer window, which cannot be closed
  while a transfer runs, so it is always visible when it exists.
- **`SessionOptions.dftBufferSize` stays reachable from no flag**, as recorded; `BufferSize` is not
  exposed as a form field. It is a tuning parameter, not an operator decision, and the form already
  has ten fields.
- **The keypad is not touched.** The user's dislike of it (ugly, modal) is parked separately at
  `docs/ideas/native-widget-dialogs-idea.md`, because changing it would SPLIT a feature the web
  gateway currently shares — where this work merely starts out diverged.

## Open questions

1. **Menu item as well as a keypad button?** The `Xfer` keypad button produces the `transferForm`
   action today and the GUI has no menu bar at all. A menu is the discoverable route on macOS, but
   adding one is its own small piece of work.
2. **Should the transfer window be modal to the main window** (a sheet on macOS) or freely
   positionable? Non-modal argues for the latter and matches the keypad complaint's direction, but a
   3270 transfer requires the session to sit at a command prompt, so there is little to do in the
   main window meanwhile.
3. **Remember the last-used values between transfers?** The TUI deliberately resets the form each
   time, because a stale `HostFile` on a send is a write to the wrong dataset. The same argument
   probably applies here, but a GUI makes retyping more annoying.
