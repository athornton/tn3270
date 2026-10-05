# GUI copy and paste — design

**Status:** approved 2026-10-05, not started.
**Roadmap position:** inserted by the user ahead of packaging, 2026-10-05.
**Scope:** the Electron GUI. The light pen is explicitly NOT here; it gets its own spec.

## Why this exists

The user's own words, playing with the shipped GUI: *"it was disconcerting that I could neither copy
text out of the window, nor paste it in. Before we package the emulator, it's a feature we need to
have."*

So this is a **"behaves like a normal application" gap, not a protocol feature.** That framing is
load-bearing for every decision below: where the reference and native convention disagree, native
convention wins for the clipboard and the reference wins for anything that reaches the host.

## THE RULE THAT SHAPES THE WHOLE FEATURE: SELECTION IS NOT THE LIGHT PEN

**Do not implement drag-to-select with anything resembling `lightpen_select()`.** That function
**sends an AID and sets MDT**, so a copy built on it would **transmit to the host on every copy
attempt** — on a live mainframe, a spurious interaction mid-session. x3270 keeps the two apart
deliberately (`wc3270/screen.c:2357`; light pen gated behind Alt).

The mouse has **three** jobs in this emulator, and only the middle one is in scope:

1. keypad buttons — no 3270 semantics (**already shipped**)
2. **selection and cursor placement — this spec**
3. light pen — sends `AID.SELECT`, its own spec

The light pen is cheaper than it looks when it comes: "selector pen detectable" IS the intensity
field (core already parses `FA.INT_NORM_SEL`/`INT_HIGH_SEL` at `constants.ts:697-698` but never
exposes it), and `AID.SELECT = 0x7e` with its no-data Read Modified rule already exists
(`inbound.ts:65`). None of that is touched here.

## Architecture

Four units. The first three are new; the fourth is an extension.

### 1. `packages/canvas/src/selection.ts` — pure geometry and extraction

- Normalizes an anchor and focus cell into a rectangle: `[min(row), max(row)] × [min(col), max(col)]`,
  so all four drag directions behave identically.
- Extracts clipboard text from a rectangle plus a `ResolvedCell[]`.
- No DOM, no Electron, no `Session`. Ordinary unit tests.

### 2. `packages/frontend/src/paste.ts` — pure paste semantics over an injected `Keyboard`

The character rules below, as a function taking the keyboard as a dependency. In `frontend` because
the TUI and (later) the web gateway want the same semantics; `frontend` is the one package every
front end can consume (`core ← frontend ← { cli, tui, canvas, gui, web }`). Testable with no Electron.

### 3. `packages/gui/src/menu.ts` — the application menu

`setApplicationMenu` is **never called today**; this feature introduces the first menu bar. Edit →
Copy / Paste, plus the minimum the platform needs (on macOS an app menu is mandatory or the window
gets no menu at all). Deliberately NOT the final menu structure: the keypad window's toolbar icon
and a connect dialog are both roadmapped and will want menus too.

### 4. `packages/canvas/src/renderer.ts` and `packages/gui/src/main.ts` — extended

Renderer owns the gesture and the highlight. Main owns extraction, the clipboard, and paste.

## THE CORRECTION THAT MOVED THE DESIGN: A DRAW LIST HAS NO TEXT

The first shape of this design had the renderer extract the text and send it. **Measured against
`drawlist.ts` before any code was written, and it does not work:** `DrawCell` is
`{x, y, glyph, fg, bg, cursor, underline, blink, intensify}` — **pixel geometry and an atlas column,
with no character at all** (`drawlist.ts:111-121`). The glyph is a CG-order atlas index, and
`drawlist.ts:114` has **already replaced a hidden cell's glyph with a blank**.

So the renderer cannot copy text: it has none. Reversing CG indices back to characters would be a
second, drifting copy of `cg.ts`'s mapping — the "two copies of what a glyph means" problem this
project avoids elsewhere.

**Therefore the split is:**

- The renderer sends the **RECTANGLE**, not the text: `{kind:'copy', top, left, bottom, right}`.
- **Main extracts**, because it already holds the `Session` and already calls `resolve(snapshot)` on
  every frame (`main.ts:687`) — which is where `text` and `hidden` both live.

This is the better factoring on three counts, not merely the possible one: the four-function bridge
survives, the renderer stays free of EBCDIC knowledge, and the `hidden` check sits beside
`drawlist.ts`'s existing one instead of in a second place. It is also the same discipline
`keypadButtonCenter` already documents — *"returning COORDINATES rather than firing the action is
what keeps the seam honest."*

## THE BRIDGE STAYS AT FOUR FUNCTIONS

`bridgecore.ts` records that **a fifth bridge function means the renderer has stopped being shared**
between Electron and the browser, and that sharing is what made the web gateway cheap
(`renderer.ts:332-334`, `drawlist.ts:75`). Copy therefore travels on the **existing** `sendAction`
as a new action kind. The transfer window hit this same wall and was solved with a second window and
its own preload rather than by widening the bridge; this feature does not need even that.

~~**A side benefit, and it is free:** `sendAction` already crosses the WebSocket, so the web gateway
gets **copy** with the same renderer code.~~

**CORRECTED DURING IMPLEMENTATION, 2026-10-05 — THAT WAS WRONG, AND THE GATEWAY'S OWN TEST IS WHAT
DISPROVED IT.** Transmitting the *action* is free; getting the *text back* is not, and nothing in
that direction exists:

- `ServerMessage` is `frame | error` (`web/src/protocol.ts:27-30`) — **no message can carry copied
  text to a browser.**
- `bridgecore.ts` has no clipboard function among its four, and `web/static/` is one `index.html`
  with no clipboard code at all.
- The browser's renderer **cannot extract the text itself** — a `DrawCell` carries a CG-order atlas
  glyph and no character, which is the whole reason the Electron side extracts in main. In the
  gateway, "main" is the **server**, so it would extract onto the *gateway's* machine.

So web copy is the same shape as the web transfer UI: a new server→client message plus a
`navigator.clipboard` write in the bridge, and **its own spec**. Worse, leaving it alone was not a
gap but a **crash**: `applyAction` throws on `copy` and `web/src/main.ts:229` calls it outside any
try inside a socket `data` handler, so the first copy from any browser would have ended the gateway
process and every other operator's session with it. `packages/web/src/protocol.ts` states that rule
in its own docstring, and `integration.test.ts` reported it immediately as *"no reply to the copy
action"*. **`copy` is therefore REJECTED at decode, beside `transferForm`**, with the durable reason
pinned in `protocol.test.ts`.

**BOTH LEAVE THAT REJECTION LIST BEFORE PACKAGING.** The user's decision, 2026-10-05: **web
copy/paste AND the web transfer form are required before the packaging work**, each with its own
spec. When they land, both rejections become interceptions in `main.ts`.

The GUI's **paste** is out of scope for the gateway in this feature either way, and stays refused as
it is today, because a browser's clipboard is the operator's machine — the same asymmetry already
written down for the web transfer UI.

## Data flow

**Copy:** drag → renderer tracks anchor/focus cells → `Cmd-C` / `Ctrl-Shift-C` or Edit → Copy →
`sendAction({kind:'copy', rect})` → IPC → main → `selection.ts` over `resolve(snapshot)` →
`clipboard.writeText`.

**Paste:** menu/accelerator in main → `clipboard.readText()` → `frontend/paste.ts` over
`session.keyboard` → screen event → new frame to the renderer by the existing path. **Paste never
touches the renderer**, because it is a session operation, not a display one — and that is what lets
the gateway's paste differ later without disturbing this code.

## Selection semantics

- **Rectangular (block) only.** A 3270 panel is columnar — datasets, LRECLs, option lists sit in
  columns, and the common want is one column of a list without the labels either side. Linear
  selection on a grid also has a question with no good answer: whether to include the trailing spaces
  at the end of each row. x3270 selects rectangularly by default on a 3270 screen.
- **A click with no drag is NOT a selection.** A 1×1 rectangle is treated as empty, or every stray
  click arms a one-character copy.
- **One line per row, columns clipped to the rectangle, trailing whitespace trimmed PER LINE**, rows
  joined with `\n`, no trailing newline. Per-line trimming is what makes a copied column paste
  usefully; trimming the block as a whole would leave ragged leading spaces.
- **A field attribute** occupies a cell, displays as a space, and extracts as a space. Stated so it
  is not rediscovered.
- **Selection clears on:** a new `mousedown`, any keystroke that produces an action, and **a new frame
  from the host**. The last one matters: a repaint invalidates what the coordinates meant, and a
  highlight left over a changed screen would copy text the operator never saw.
- **Highlight** is inverse video on the selected cells — the keypad already draws inverse video
  through the same atlas, so no new primitive. Drawn in `paint` from **renderer-local state**, NOT
  added to the `DrawList`: the draw list comes from main, and selection is the renderer's own concern.
  Main stays unaware of selection apart from receiving a rectangle.
- **Primary button only.** `mousedown` fires for the right and middle buttons too; `renderer.ts:284`
  already guards the keypad this way and selection must do the same.

## `hidden` IS NON-NEGOTIABLE, AND A COPY FEATURE IS EXACTLY HOW A PASSWORD ESCAPES

`ResolvedCell.hidden` marks a password field. Core's own comment: it **"is the ONLY thing standing
between a password field and the screen"** (`render.ts`, quoted at `drawlist.ts:25`). A hidden cell
contributes **a space**, not its character — the same substitution the renderer already makes when
drawing.

`ResolvedCell.text` is **still the real character when `hidden` is set** — it is deliberately not
pre-redacted (`drawlist.ts` comment at `:109-111`) — so extraction that reads `text` without checking
`hidden` puts a password on the clipboard. **A test must prove a password field copies as blanks, and
it must be mutation-verified:** remove the `hidden` check and that test must redden.

This is not hypothetical caution. This project has already shipped a diagnostic that **printed a live
password on its first run**, because the state it argued it could not capture was exactly the state
it caught. See `[[error-paths-lie-about-measurements]]`.

## Paste semantics — MEASURED FROM `Common/kybd.c`, NOT RECALLED

Reference source at `~/src/suite3270-4.5`. The `auto_skip` default path; **overlay-paste mode is NOT
implemented, and not asking for it is what keeps that branch unreachable** — the same reasoning that
kept BIND-IMAGE unrequested in stage 2b.

| Input | Action | Source |
|---|---|---|
| `\n` | `Newline_action` — next unprotected field | `kybd.c:3928` |
| `\n` when `just_wrapped` | **suppressed** | `kybd.c:3929` |
| `\b` | `Left_action` | `kybd.c:3914` |
| `\f` | types a **space** | `kybd.c:3918` |
| `\t` | field tab | |
| printable | the existing per-character `typeString` path | |

**`just_wrapped` is the detail that makes multi-line paste land correctly** (`kybd.c:3859`,
`:3899-3906`, `:3929`). The loop tracks the cursor's row; if filling a field has already moved the
cursor to a new row, the following `\n` is **swallowed**, because the wrap already did the newline's
job. Without it every line after the first full one lands **one field late** — and that would present
as a core keyboard fault rather than a paste bug. **Its test needs a fixture where a field fills and
wraps**, because every single-line test passes without it.

**`\f` → space is the rule that would have bitten.** Outside pasting, `\f` is **Clear** — an AID that
wipes the screen (`kybd.c:3920`). A form feed in pasted text sending Clear mid-paste would
destroy the panel being filled. Pasting changes its meaning, and that asymmetry is explicit in the
source.

**NO ENTER IS EVER SYNTHESISED.** `\n` is Newline; Enter happens only when the operator presses it.
The reference makes exactly this distinction — `\n` becomes `Enter_action` **only when not pasting**
(`kybd.c:3957`) — and conflating them would submit a half-filled panel to a live host.

### Two abort conditions, both from the reference, both reported rather than silent

- **Keyboard locked → the remainder is DROPPED** (`kybd.c:3879`, `"keyboard locked, string dropped"`).
  x3270 calls it fatal because a string cannot unlock a keyboard. We report how many characters got in.
- **Cursor wrapped past the start address → abort the remainder** (`kybd.c:3886`). Stops a long paste
  circling the screen and overwriting what it already typed.

Outcome goes to the **OIA**, with the remedy first: the status line truncates, and this project has
already had one message put its only actionable phrase past the cut. Assert on the rendered line.
See `[[fixed-width-messages-lose-their-point]]`.

## Accelerators — platform-split, because `Ctrl-C` IS ALREADY CLEAR

`keys.ts:72` binds `c` to `{kind:'clear'}`, and `keys.ts:20-24` explains why: *"Correct for a 3270
and surprising to everyone: Clear is an AID a user needs constantly to dismiss VM's `MORE...` state,
so the usual instinct for escaping cannot be the way out."* The window says so at startup.

| Platform | Copy | Paste | Clear |
|---|---|---|---|
| macOS | `Cmd-C` | `Cmd-V` | `Ctrl-C` |
| Linux | `Ctrl-Shift-C` | `Ctrl-Shift-V` | `Ctrl-C` |

**`Ctrl-C` stays Clear on both, and the startup message must keep saying so.** On a Mac `Cmd` is free,
so the native key is available with no conflict at all; on Linux `Ctrl-Shift-C` is what terminal users
already expect, for exactly this reason (gnome-terminal, VS Code's terminal).

**REJECTED, and recorded so it is not revisited: "`Ctrl-C` copies when a selection exists, Clear when
it does not."** That makes a destructive AID silently conditional on invisible state — the
*one-path-does-X-and-another-doesn't* shape this project has been bitten by at least five times
(`Session.e`, `tn3270eNegotiated`, the parent/child close, the IPC race, the stall counter). The
failure mode here is a **missed Clear on a locked `MORE...` screen** with a stale selection.

### A HAZARD THE MENU CREATES: ACCELERATORS ARE GLOBAL TO THE APP

An accelerator registered in main fires **regardless of which window has focus**, so with the transfer
window open a `Cmd-V` would paste into the session behind it. The Edit items must be **disabled or
no-op while the transfer window holds focus**; that window's fields are HTML inputs and get the
browser's native clipboard behavior for free. This is the same family as the already-recorded
*"closing a parent skips the child close"* finding — two windows, one global mechanism.

## Testing

| Unit | How | Notes |
|---|---|---|
| `selection.ts` | unit | all four drag directions; per-line trimming; **password → blanks, mutation-verified** |
| `paste.ts` | unit, injected `Keyboard` | every table row; `just_wrapped`; both abort conditions |
| renderer gesture | **new by-hand harness** | `npm test` cannot fire a real `mousedown` |
| clipboard write | Electron, under Xvfb | assert via `clipboard.readText()` after the action |
| menu/accelerators | unit on the menu template | pin the platform split by name |

**The gesture harness follows `clicks.mjs`'s pattern**, which already drives real Chromium mouse
events through `sendInputEvent` and asserts actions **by label rather than by coordinate** — a
coordinate list is a second copy of the layout that passes while the layout is wrong. It drags across
known cells **in replay mode** and asserts the resulting `copy` action's rectangle and the extracted
text. Replay, not a live host: that is both the privacy gate on the action log (a `type` action
carries typed text, and replay can reach no host) and what makes the expected text deterministic —
TK5's panel paints a live clock, so a whole-screen comparison proves nothing.

**`npm test` does not run the by-hand harnesses, and `vitest` does not typecheck.** Run
`npm run build` before believing any suite here, and after a `git checkout` run
`npx tsc --build --force packages/gui packages/web` or the staleness guards redden on mtimes alone.

## What this does NOT do

- **No light pen** — its own spec. It is the only piece that sends an AID.
- **No linear selection** — rectangular only.
- **No overlay-paste mode** — not requesting it keeps the branch unreachable.
- **No right-click context menu** — menu and accelerators only.
- **No web gateway copy OR paste.** ~~Copy comes along free.~~ **Corrected 2026-10-05: it does
  not** — see the struck-through claim above for the three measurements. Both are REJECTED at
  decode, and the rejection is load-bearing rather than cosmetic: without it the first browser copy
  ends the gateway process. **Both are committed before packaging, each with its own spec.**
- **No claim of a live paste witness.** The semantics are unit-testable, but "a 38-character dataset
  name lands in TSO's field" needs TK5. **Verify offline with the replay probe FIRST**
  (`TN3270_GUI_REPLAY` plus the action log): it settled in one line what five live hypotheses could
  not, and it costs **no TK5 userid**. A failed TSO run strands one, because its `host:logoff` is
  typed into whatever wrong screen the failure left behind.

## Open questions

None. Every decision above was taken by the user on 2026-10-05: scope B (copy + paste, light pen
later), paste rule C (newline → next field), selection A (rectangular), clipboard path A (no fifth
bridge function), accelerators D (platform-split).
