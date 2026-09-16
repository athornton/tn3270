# The virtual keypad, the special-keys overlay, and three missing keys

Roadmap item (9), requested 2026-09-14 and moved ahead of Programmable Symbol Sets on
2026-09-15. Design settled 2026-09-16.

## What this is for

A 3270 keyboard has keys a PC keyboard has not got. Some of them are reachable today through
chords nobody would guess, and three of them are not reachable at all. This adds:

- a **clickable virtual keypad** in the two canvas front ends (the Electron GUI and the web
  gateway), laid out like the special-key clusters of a 122-key tn327x keyboard;
- a **keyboard-navigable overlay** in the TUI, which has no mouse, listing every special key and
  able to fire one;
- the three keys that are missing from the stack: **Sys Req**, **Dup** and **Field Mark**.

Explicitly NOT in this spec, and each for its own reason:

- **Cursor Select.** `AID.SELECT` and its no-data Read Modified rule already exist, but the key
  needs the field-intensity parse ("selector pen detectable" IS the intensity field, bits 4 and 5)
  and belongs with the light-pen work rather than with a button.
- **Mouse for anything but keypad buttons.** No click-to-place-cursor, no drag-to-select, no light
  pen. Mouse is three separate jobs and this spec takes only the first. Note for whoever takes the
  others: **text selection is NOT the light pen** and must not be implemented with
  `lightpen_select()`, which sends an AID and sets MDT — drag-to-select would then transmit on
  every copy attempt. x3270 keeps them apart deliberately (`wc3270/screen.c:2357`).
- **Compose.** x3270's own input method, with no analogue here.
- A clickable typewriter area. The keypad earns its space by offering keys the real keyboard
  lacks; a clickable QWERTY duplicates hardware, triples the hit-testing surface and eats the
  screen area the 3270 display needs.

## Facts established from sources before designing

Checked rather than remembered, per this repo's standing rule:

| fact | source |
| --- | --- |
| `EBC_dup = 0x1c`, `EBC_fm = 0x1e` | x3270 `include/3270ds.h:364-365` |
| **Dup and Field Mark are typed CHARACTERS, not AIDs** | `Common/kybd.c:2788` and `:2825` both call `key_Character(EBC_dup/EBC_fm, ...)` |
| **The Dup KEY performs a TAB.** `kybd.c:1435` suppresses `key_Character`'s auto-skip for a keyboard Dup — `if (auto_skip && (pasting \|\| (ebc != EBC_dup)))`, commented "for all pasted data (even DUP), and for all keyboard-generated data except DUP" — but `Dup_action` then moves the cursor ITSELF, so the net effect is a tab. **CORRECTED 2026-09-16 during Task 1; this table's first version read the suppression alone and concluded the opposite.** What the suppression buys is that the tab happens ONCE rather than twice. | `Common/kybd.c:1435` **and `:2788-2792`** (`cursor_move(next_unprotected(cursor_addr))` after `key_Character` returns), settled by the manual p. 7-12: "Operation of this key causes a X'1C' code to be entered into the presentation space, **a Tab key operation to be performed**, and the MDT bit to be set to 1" |
| **A numeric field TAKES Dup and refuses Field Mark** | manual p. 4-13: "Numeric fields are limited to numeric characters, the minus and decimal sign characters, **and the duplicate (DUP) control**." x3270's byte test (`kybd.c:1232-1238`) refuses DUP too, but is gated on `appres.numeric_lock`, which has **no default assignment anywhere** (`glue.c:914` registers the resource only) and is therefore off — so stock x3270 refuses neither, and that byte set is the shape of the numeric-lock feature rather than a ruling on DUP |
| Which keys a 3270 keypad is expected to carry | c3270's own keypad: `Common/c3270/keypad.labels` — PA1-3, Attn, Erase EOF, Erase Input, Sys Req, Clear, PF1-24, Home, Cursor Select, Compose, Insert, Delete, Dup, Field Mark, Reset, Enter, arrows |
| `Session.sysreq()` exists in core and **no front end can reach it** | `packages/core/src/session.ts:641`; no `sysreq` anywhere in any front end |
| Dup and Field Mark are absent from core entirely | not even the 0x1C/0x1E constants exist |
| `Ctrl-K` is free in both keymaps | canvas `keys.ts` binds only `c r u ] a`; the TUI adds `0x7f` |
| `advanceAfterType` IS our auto-skip | `packages/core/src/keyboard.ts:98`, "At the end of a field, skip to the next typable one" |
| `DrawList` already carries an optional second region | `packages/canvas/src/drawlist.ts`: `oia?: { text, y, cells }` |

## Architecture

Three new modules, each with one job, plus hit-testing in the renderer.

```
packages/frontend/src/keypad.ts   the key TABLE: label, action, cluster, row, column.
                                  No pixels, no cells. The single source of truth,
                                  reachable from BOTH package graphs.
packages/canvas/src/keypad.ts     the table -> cells + button rectangles, in cell
                                  coordinates. Drawn through the existing blitter.
packages/canvas/src/renderer.ts   hit-test a click against those rectangles; draw a
                                  local press highlight. Nothing else new.
packages/tui/src/keypadOverlay.ts the same table as a navigable list.
```

The table lives in `frontend` because `canvas` already imports from it (`keys.ts` takes `Action`,
`drawlist.ts` takes `schemeRgb`) and so does `tui`. Putting it in `canvas` would put it out of the
TUI's reach and guarantee two lists that drift.

### Why the keypad is part of the draw list

**`gui/src/main.ts:290` sizes the window from the draw list**: `setContentSize(list.width * scale,
list.height * scale)`. That single line decides the architecture.

If the keypad were owned by the renderer, main would never learn the drawing had grown, and the
Electron page is `overflow:hidden` — so the keypad would be clipped. That is precisely the bug live
verification found for a 43-row model-4 screen last week. Repairing it would need a renderer-to-main
channel, i.e. a fifth bridge function, and `bridgecore.ts` states that a fifth function means the
renderer has stopped being shared.

So the keypad is a third `DrawList` region, mirroring `oia`:

```ts
readonly keypad?: {
  readonly y: number;                          // top of the keypad, in scale-1 pixels
  readonly cells: readonly DrawCell[];         // same atlas, same blitter
  readonly buttons: readonly KeypadButton[];   // hit-testing, in scale-1 pixels
};
```

**The vertical order is screen, then OIA, then keypad.** The keypad is appended below both, so
showing it never moves or covers a row the host wrote — the rule that the TUI's refusal-to-clip and
the GUI's resize both come from. `list.height` grows by the keypad's rows while `oia.y` is
unchanged.

`KeypadButton` is `{ x, y, w, h, action, label }` in **scale-1 pixels — the same coordinate space
`DrawCell` already uses**, since `drawList` emits `x: col * atlas.cellWidth` and `oia.y:
snapshot.rows * atlas.cellHeight`. An earlier draft of this spec said cell coordinates, on the
reasoning that a pixel rectangle would go stale when the window resized; that reasoning is wrong,
because these are BASE pixels that the renderer multiplies by the scale it picks at paint time,
exactly as it already does for every cell. Using cells would introduce a second coordinate
convention in the same structure for no benefit. The renderer converts a click the inverse way:
subtract the centring offset, divide by the scale, then compare.

Everything then works through paths that exist: main resizes to a taller list for free, the gateway
ships whole frames for free, and `browser-shot.mjs` can compare the keypad's pixels because it is
in the canvas.

## The key set and the layout

46 buttons. Six cell-rows, at most 72 columns wide so it never exceeds an 80-column screen:

```
PF13 PF14 PF15 PF16 PF17 PF18 PF19 PF20 PF21 PF22 PF23 PF24
PF1  PF2  PF3  PF4  PF5  PF6  PF7  PF8  PF9  PF10 PF11 PF12

PA1   PA2   PA3     Home   ^    Ins      Dup     Reset
Attn  SysRq Clear    <     v     >       FldMk   Enter
ErEOF ErInp Tab     BkTab Del   BkSp
```

Six rows is 84px at scale 1, about a seventh of a model-2 screen. Each PF button is 6 cells wide
(a 4-character label plus padding), so the PF block is 72 cells.

The arrangement follows a 122-key keyboard in the way that matters for muscle memory: the PF keys
in a 2x12 block across the top, the modal keys in a left-hand cluster, cursor and edit keys on the
right. **It is data, not code**, so rearranging it later is a table edit.

The keypad is drawn with the 3270 glyph atlas through the existing blitter. That is what keeps
screenshot goldens byte-reproducible — `fillText` would pull in a system font, and font
rasterisation is the machine-dependent thing that would stop them reproducing. It also means the
keypad looks like a 3270 rather than like a native widget, which for a virtual terminal keyboard is
the intent.

### The font choice is PROVISIONAL, and the fallback is not what you would guess

**Recorded 2026-09-16: the user is not convinced the x3270 font is right for keypad labels, and
agreed to try it and see.** So treat this as a decision to revisit after looking at it, not a
settled one — and if it does look wrong, reach for the cheaper fix first:

1. **Restyle within the atlas.** Inverse-video buttons, box-drawn borders, a dimmer label for a
   disabled key. The baked atlas carries **431 glyph columns** at 9x14 and the BDF has 137 glyphs in
   the CG range where x3270 keeps its line-drawing characters, so borders and fills are available
   without new machinery. This keeps every property below intact.
2. **A second bitmap font**, baked into its own atlas the way `3270.bdf` is. More work, but still
   deterministic.
3. **`fillText` in a system font.** This is the one to avoid, and not on taste grounds:
   font rasterisation is machine-dependent, so it would **stop the screenshot goldens being
   byte-reproducible** — which is what makes `shot.mjs` and `browser-shot.mjs` evidence rather than
   decoration, and what proves the served page and the Electron app draw the same pixels. Trading
   that for nicer labels is a bad trade; if it is ever wanted anyway, the goldens have to be
   demoted to a "not blank" smoke check deliberately and in writing, not quietly widened.

The layout table carries a `label` per button, so options 1 and 2 change only how a button is drawn,
not what the table says or where the rectangles are. Hit-testing and the tests around it are
unaffected either way.

## Data flow

**The chords come from c3270's own default keymap where it has one** (`Common/fb-c3270`), which is
where our `Ctrl-A` = Attn came from too:

| key | chord | source |
| --- | --- | --- |
| Dup | `Ctrl-D` | `fb-c3270:88` |
| Field Mark | `Ctrl-F` | `fb-c3270:93` |
| show/hide the keypad or overlay | `Ctrl-K`, **plus `Alt-K` in the canvas front ends only** | diverges; see below |
| Sys Req | **no chord** | c3270 has none either |

**The keypad toggle diverges from c3270 deliberately.** c3270 uses `Alt-K` (`fb-c3270:48`) and a
two-key `Ctrl-A K` (`:136`). In a terminal `Alt-K` arrives as `ESC k`, and this project does not put
new bindings through the ESC path: `app.ts` records two regressions there and warns against
touching it. So the TUI uses `Ctrl-K`, which is ESC-free and unclaimed. The canvas front ends accept
**both** `Ctrl-K` and `Alt-K`, since they see a real `KeyboardEvent` with no ESC ambiguity and `Alt`
is already an established modifier there (Alt+digit is PA1-3) — so c3270 muscle memory works in the
GUI and the browser.

**Sys Req gets no chord**, because c3270 defines none and inventing one is how a keymap accretes
bindings nobody can predict. It is reachable from the keypad, from the TUI overlay, and from the
CLI as `SysReq()` — which is the overlay's whole purpose: a home for keys too rare to memorise.

**Toggling.** `Ctrl-K` (or `Alt-K` on a canvas front end), hidden by default. In the canvas front ends the chord maps to a new
`{ kind: 'toggleKeypad' }` action, which travels the ordinary action path to Electron's main or the
gateway's server; that side holds the boolean and recomputes the frame with the region present or
absent. State lives in one place, and the web gateway inherits it with no protocol change.

**Clicking.** `mousedown` on the canvas is hit-tested locally against `list.keypad.buttons`; a hit
fires that button's action through the `sendAction` the bridge already has. A miss is ignored.

**Press feedback** is drawn locally, immediately, on `mousedown` — a highlight over the pressed
button. It is purely visual, so it must not cost a round trip; over a WebSocket it would otherwise
lag behind the finger.

**The TUI.** `Ctrl-K` opens the overlay; arrows move, Enter fires, Esc dismisses. It is rendered
from `BINDING_INTENT` plus the new table, so the on-screen help cannot drift from the bindings —
there is already a test that the terminal keymap agrees with `BINDING_INTENT`. Nothing here touches
the ESC state machine, whose own comments record two regressions and warn against simplification.

## The three missing keys

**Sys Req** is nearly free: `Session.sysreq()` exists, so `{ kind: 'sysreq' }` is an entry in
`applyAction` and in both keymaps. It is currently unreachable from any front end, which is worth
stating plainly — the capability has been in core since stage 2b with no way to press it.

**Dup** and **Field Mark** need new `Keyboard` methods. Both write an EBCDIC control byte —
0x1C and 0x1E — **directly into the buffer, bypassing code-page translation**, because they are
EBCDIC controls with no sensible Unicode source character; routing them through `type(ch)` would
mean inventing one. Both set MDT, as any typed character does.

**Dup performs a TAB, and this paragraph said the opposite until Task 1 checked it.** The original
reasoning stopped at `kybd.c:1435` — auto-skip is suppressed for a keyboard-generated Dup — and
concluded that the cursor advances one position and stops. It does not: `Dup_action` moves the cursor
itself once `key_Character` returns (`kybd.c:2790`, `cursor_move(next_unprotected(cursor_addr))`), so
the **net effect of the key is always a move to the next unprotected field**. The manual settles it in
one sentence (p. 7-12): a X'1C' is entered, **a Tab key operation is performed**, and MDT is set. It is
also what the key means — "duplicate the rest of this field" leaves nothing more to type there.

**What the suppression actually buys is that the tab happens ONCE.** Our `advanceAfterType` already
tabs at the end of a field, so advancing first and tabbing after would skip a whole field when Dup is
pressed in the last cell — exactly what x3270 avoids by starting `next_unprotected` from the field
attribute rather than from the next field's first data cell. So `dup()` is `write; setMDT; tab()`, and
both halves are mutation-checked.

**`advanceAfterType` is NOT byte-for-byte x3270's auto-skip, and the difference is documented on it
rather than papered over:** x3270's loop can leave the cursor in a protected non-auto-skip field,
where our `tab()` always finds a typable one. Dup and Field Mark inherit that pre-existing difference
rather than introduce it.

**A related gap was found and deliberately NOT fixed in Task 1:** neither `type()` nor `writeControl()`
refuses a cursor parked *on* a field attribute byte, where x3270 does (`kybd.c:1221`) and the manual
says the keyboard is disabled for both these keys. Writing there destroys the field boundary. Task 1
kept parity with `type()` rather than making the two inconsistent; fixing it belongs in its own commit
covering both, and is **not** part of this feature.

New actions: `{ kind: 'sysreq' }`, `{ kind: 'dup' }`, `{ kind: 'fieldMark' }`,
`{ kind: 'toggleKeypad' }`.

**The CLI gets `Dup()`, `FieldMark()` and `SysReq()` commands too**, and that is conformance rather
than symmetry: s3270 has all three by those names (`Common/kybd.c:223`, `:230`, `:254`), so a script
written for s3270 should not fail against us. `toggleKeypad` is deliberately NOT a CLI command — a
script-driven client has no renderer, which is the same reason `-scheme` is absent there.

## Error handling and edge cases

- A click outside every button is ignored; so is a click while the keypad is hidden, there being no
  rectangles to hit.
- **`toggleKeypad` must be HANDLED by the gateway, not merely accepted.** `decodeClientMessage`
  deliberately does not enumerate action kinds, and an unrecognised kind falls through
  `applyAction`'s switch as a no-op — so an unhandled `toggleKeypad` would be silently dropped and
  the button would appear dead. A hostile client sending it is harmless: it toggles a display.
- Screen plus keypad taller than the work area needs no new code: `bestScale` drops to a smaller
  integer scale, and the browser scrolls, which is what the `max(viewport, drawing)` canvas sizing
  and `overflow:auto` already provide.
- If the terminal is too small for the TUI overlay, it **refuses to open and says so**, following
  the rule the TUI already applies to a too-small screen: never show a partial one.
- `applyAction` swallows a rejected action, so a keypad press against a disconnected session is a
  no-op with the reason in the OIA, exactly as the equivalent keystroke is.

## Verification

Unit, in `npm test`:

- the table: every `action` is in the `Action` union, no duplicate labels, no duplicate actions,
  and every new action appears in `BINDING_INTENT`;
- the layout: no two button rectangles overlap, all lie within the declared width and height, and
  the output is deterministic for a given table;
- hit-testing: a point inside each button returns it, points on each edge behave consistently, and
  a point in the gaps returns nothing. **The rectangle bounds get a mutation check**, because an
  off-by-one there is the defect this code is most likely to have and the one a happy-path test
  will not see;
- core: `dup`/`fieldMark` write 0x1C/0x1E and set MDT; Dup does not perform the end-of-field skip;
  `sysreq` reaches `Session.sysreq()`.

By hand, following the existing harnesses:

- a new screenshot golden with the keypad shown, byte-compared as `shot.mjs` already does;
- `browser-shot.mjs` extended, so the keypad is proven pixel-identical between Electron and the
  browser — the same argument that proved the renderer is shared;
- `keys.mjs` and `browser-keys.mjs` gain the toggle chord, with the guard tests that pin their
  invocations updated;
- **a new seam, `TN3270_GUI_CLICKS`**, delivering real mouse events through `sendInputEvent` the
  way `TN3270_GUI_KEYS` delivers real key events. The click-to-action path — canvas `mousedown`,
  hit-test, `sendAction`, IPC or WebSocket, `applyAction` — is exactly the plumbing no unit test
  reaches, which is the argument the chord guard already won: breaking that path leaves the suite
  fully green.

No live-host verification is required for this feature: a keypad press produces the same wire bytes
as the equivalent keystroke, and those are already live-verified. PA1 and PA2 in particular have
observed host reactions on MVS (`ISP088E ... TERMINATED DUE TO ATTENTION INTERRUPT` and a bare
`READY` redisplay). Sys Req, Dup and Field Mark have no live witness and the docs must say so
rather than implying the keypad as a whole is live-verified.

## Success criteria

1. `Ctrl-K` shows and hides the keypad in the Electron GUI and in a browser, and the window resizes
   or the page scrolls rather than clipping anything.
2. Clicking every button produces exactly the action its label names, proven by a real mouse event
   through the new seam, not by calling the handler.
3. The keypad is pixel-identical between the Electron app and the served page.
4. Sys Req, Dup and Field Mark are reachable from **every** front end — the TUI and both canvas
   keymaps, the keypad itself, and the CLI as `SysReq()`, `Dup()` and `FieldMark()` — and **Dup's tab
   is asserted, along with the fact that it happens only once** (an earlier wording of this criterion
   said "Dup's auto-skip suppression is asserted", which was the inverted rule; see the three-keys
   section).
5. The TUI overlay lists every special key with its chord, fires one, and refuses to open in a
   terminal too small to hold it.
6. `npm test`, both goldens, `pty-smoke.py` and all four by-hand harnesses pass.
