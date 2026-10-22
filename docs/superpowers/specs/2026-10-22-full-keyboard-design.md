# A full 122-key 3279 keyboard for the DOM front ends — design

**Status: designed and approved 2026-10-22. Not implemented.**

**The idea, in the user's words:** *"instead of just presenting the weird, hard-to-type keys in a
rectangular grid, present an entire 122-key 3279 keyboard, laid out like a real one."* Reference
photograph: `$HOME/s-l960.png`, an IBM 122-key terminal keyboard.

**Why:** the current keypad answers *"which keys are hard to type?"* — a 48-button grid in six
semantic blocks. It does not answer *"where is Field Mark on a 3279?"*, which is the question
someone learning this hardware actually has. x3270 draws a keyboard; we draw a list of oddities.

**What this is NOT for.** The alphanumerics will work, but nobody is expected to use them — the
user's own framing: *"I don't know why anyone would rather type 'a' on a virtual keyboard than a
real one, but they could do it if they wanted to."* They exist because a keyboard with holes in it
is not a picture of a keyboard. **Do not spend effort optimising the typing path.**

## Scope

**THE GUI AND THE WEB GATEWAY ONLY. THE TUI IS EXPLICITLY EXCLUDED**, at the user's direction:
*"the TUI on the other hand is much more restrictive, so I am not suggesting a full virtual
keyboard for it."* The TUI renders `KEYPAD_KEYS` as a scrolling **name + chord list** in a
29-column overlay (`OVERLAY_MIN = { rows: 12, cols: 29 }`) precisely because it cannot draw a
keyboard — c3270's own keypad is 78 columns wide and this TUI refuses to draw below 24×80.
**`KEYPAD_KEYS` and every TUI path are untouched by this work.**

**Corner-anchoring the existing keypad is OUT OF SCOPE.** It is a separate small change and
bundling it would muddle two sets of evidence. It remains open.

## 1. The data model: a parallel table, not an extension

**A new `KEYBOARD_3279` in `packages/frontend`, alongside `KEYPAD_KEYS` rather than replacing or
extending it.** The two answer different questions:

| | `KEYPAD_KEYS` | `KEYBOARD_3279` |
|---|---|---|
| question | which keys are hard to type | what does a 3279 look like |
| entries | 48 | ~122 |
| consumers | TUI list, GUI window, web overlay | GUI window, web overlay |
| geometry | none that is live (see below) | row, x-offset, width in KEY UNITS |

**This follows an established precedent in this repo rather than inventing one.**
`frontend/src/keypadView.ts` exists for the same reason — `KEYPAD_KEYS`'s cell coordinates were
the wrong model for a DOM layout — and its header argues the grouping should be **written down,
not derived**, because deriving it would make it agree with the old layout by construction and be
unable to catch a change. The same argument applies here with more force.

**Each entry carries:**

- `label`, and `shiftLabel` where the cap shows two glyphs (`2`/`@`, `;`/`:`).
- `action: Action | undefined` — `undefined` means **inert**, see §2.
- `region`: `'pf' | 'special-left' | 'main' | 'cursor' | 'numpad'`, matching the five physical
  regions visible in the photograph.
- `row` within its region, `x` offset and `width` in **KEY UNITS, not pixels** — `Enter`, the
  spacebar, the numpad `+` and several others are multi-unit. Units keep the table independent of
  whatever pitch the CSS picks.
- `name`: what the key is called in words, for the tooltip and for accessibility, exactly as
  `KeypadKey.name` does.

**TWO THINGS THIS CHANGE CAN CLEAN UP, both verified 2026-10-22:**

1. **`KeypadKey.row` and `.col` ARE NOW DEAD FIELDS.** They were cell coordinates for
   `canvas/src/keypad.ts`, **which no longer exists** — it was deleted in the keypad-window work.
   `keypadView.ts`'s header says explicitly that they *"become dead only when that file is
   deleted"*. Nothing reads them now. Delete them, in a commit of their own so the deletion is
   separable from the new feature.
2. **THE ALPHANUMERICS NEED NO NEW MACHINERY.** `{ kind: 'type'; text: string }` already exists in
   the `Action` union (`keymap.ts:116`) and is what the real-keyboard path produces
   (`canvas/src/keys.ts:155`). Every letter, digit and symbol is a one-line table entry against an
   action kind that already works end to end.

## 2. The keys that cannot work: INERT, NOT OMITTED

**The user's decision: inert and visibly so, not left out.** A gap where `Esc` belongs is less
honest than a key that is plainly scenery.

**~8 of ~122 keys have no action and will not get one:**

- **`Cursr Sel`** — `AID.SELECT` exists in core, but the key was **dropped by decision**:
  `keypad.ts:22` records that it *"needs the field-intensity parse and belongs with the light-pen
  work"*. It is a real 3270 key whose implementation is deferred, which its **tooltip** says.
- **`Esc`, `Print Screen`, `Scroll Lock`, `Pause`, `Alt` (×2)** — PC-keyboard keys present on this
  122-key unit but not 3270 functions. They get no action because they *should* not have one.
- **One of the two unlabelled keys** on the bottom-left special bar stays blank.

**`Xfer` GOES ON THE OTHER UNLABELLED KEY**, the user's own suggestion. There is precedent: the
existing keypad already carries `Xfer` as a deliberate non-3270 addition, and `keypad.ts` argues a
transfer button *"is a perfectly sensible thing to click"* even though `applyAction` throws on the
kind, because the front end intercepts it exactly as it intercepts the chord. The same interception
already exists in both DOM front ends, so this needs no new plumbing.

### The inert STYLING is deliberately NOT the house `opacity: 0.5`

**Option B of three, chosen by the user.** `ui.css` uses `opacity: 0.5` for disabled controls in
three places — and that pattern means *"not right now, try again when a transfer finishes."* **An
inert 3279 key means something different: "this exists on the hardware and will never do anything
here."** Same visual, two incompatible promises.

So inert keys get **`GrayText` on a slightly recessed cap, with no opacity change.** The reason is
functional, not aesthetic: **the label must stay READABLE.** Half the value of drawing `Cursr Sel`
at all is being able to see where it sits on the hardware, and 0.5 opacity on a small cap at the
smaller font this layout needs could make `Print Screen` unreadable — which defeats the
faithfulness the whole feature exists for.

**The `disabled` attribute IS still set**, so clicks genuinely do nothing and screen readers and
keyboard navigation behave correctly. Only the styling departs from the house pattern, and
`ui.css` must say why at the rule, or someone will "fix" it into consistency.

**No second inert tier.** A `not yet` versus `never` distinction (`Cursr Sel` against `Esc`) was
considered and rejected: three button states is too much visual vocabulary for a distinction that
the **tooltip** can carry, and every keypad button already has one.

## 3. Surfaces and chords

**`Ctrl-K` keeps the compact keypad, unchanged. `Ctrl-B` opens the full keyboard.**

**`Ctrl-B` IS FREE, verified against every front end 2026-10-22.** The taken chords are
`Ctrl-C` (clear), `Ctrl-R` (reset), `Ctrl-U` (eraseInput), `Ctrl-]` (quit), `Ctrl-A` (attn),
`Ctrl-D` (dup), `Ctrl-F` (fieldMark), `Ctrl-K` (toggleKeypad) and `Ctrl-T` (transferForm) —
`bindings.ts`'s `BINDING_INTENT` and `canvas/src/keys.ts`'s `CTRL` table agree. `B` collides with
nothing. **In the browser this also suppresses Firefox's bookmarks sidebar, which is correct:**
`renderer.ts:301` calls `preventDefault` only for keys we claimed, so claiming it is what makes it
ours.

**A new `toggleKeyboard` action**, modelled exactly on `toggleKeypad`: it lives in the `Action`
union so the chord, the GUI's menu item and `BINDING_INTENT` can all name it the way every other
action is named — and **`applyAction` must throw on it**, as it does on `toggleKeypad` and `quit`,
because what a surface looks like is the front end's business. It must therefore NOT appear in
`KEYPAD_KEYS` or `KEYBOARD_3279`: a drawn button for it would be a button that toggles the surface
it is drawn on.

### THE GATEWAY'S TWO-BRANCH RULE IS THE HIGHEST-RISK ITEM HERE

**`web/src/main.ts` calls `applyAction` OUTSIDE ANY TRY in a socket `data` handler, and
`applyAction` will throw on `toggleKeyboard`** (by design, as it does on `toggleKeypad` and
`quit`). So an unguarded new kind **ends the gateway process on the first browser keystroke that
sends it** — not a failed check, a dead server.

`protocol.ts` states the rule: **a new action kind is either REFUSED at decode or INTERCEPTED in
`main.ts`, and the branch must be taken in the same change that introduces the kind.** That file
records a commit which took neither — *"what `toggleKeypad` once spent a commit violating"* — and
`transferForm` later had to move *"from its `REFUSED` list to that one, rather than out of both."*

**For `toggleKeyboard` the branch is INTERCEPTION**, matching `toggleKeypad` exactly:

1. `protocol.ts` must **accept** the kind at decode (it is a legitimate browser action, intercepted
   client-side, so refusing it would be refusing a chord the browser is allowed to press).
2. `main.ts` must `return` before `applyAction` for it — the same empty-return line as
   `main.ts:290`, which `keypadOverlay.ts` records *"is now an empty `return` and MUST STAY"*.
3. `web/test/integration.test.ts` has the two lists that assert which branch was taken:
   `REFUSED = ['quit', 'copy']` and `SWALLOWED = ['toggleKeypad', 'transferForm']`.
   **`toggleKeyboard` joins `SWALLOWED`**, and a kind in neither list is the bug this pair exists
   to catch.
4. `browser-keys.mjs` asserts the chord's **ABSENCE** from the gateway's action log, since a
   client-side interception means it never crosses the socket. An entry appearing there would mean
   the interception had broken.

**All four land in the same commit as the action kind.** This is the one place where getting the
order wrong produces a dead process rather than a red test.

**Layout: bottom-docked, full width.** The keyboard is **2.6:1** (measured from the photograph:
~885×340px of keyboard) and about 24 key-units across — at a readable 30px pitch that is ~720×235px,
**as wide as a 24×80 screen itself**. It cannot be corner-anchored in any useful sense, so it
occupies a bottom strip.

**`position: fixed`, like both existing overlays, and that is load-bearing:** `ui.css:34` records
that the click path's `offsetX` arithmetic assumes the canvas sits at the viewport origin — *"give
the page a body margin and every click here misses by it"* — and a sibling in normal flow would
push the canvas down and break the **other** front end's clicks through the shared renderer.

**Opening one surface closes the other.** Two overlapping opaque overlays would be unreadable.
`keypadOverlay.ts` already owns show/hide and lazy first-build; generalise it rather than writing a
second copy, and keep its two no-persistence rules — hidden at start, and a reattaching client does
not inherit a previous session's state.

**Opaque, `background: Canvas`, like the keypad.** `keypadOverlay.ts` records that opacity is
load-bearing: the TUI's keypad once let host text bleed into its chord column, and *"a 3270 screen
behind 48 buttons is a dense background to read over."* 122 buttons is denser still.

## 4. Verification

- **Unit, `KEYBOARD_3279`:** every key's `action` is either a legal `Action` or `undefined`; no key
  carries `toggleKeypad`, `toggleKeyboard` or `quit`; `shiftLabel` present exactly where the cap is
  dual-glyph; **no two keys in a region overlap** given their `x`/`width` in key units, and no row
  exceeds the region's width — that last pair is the arithmetic a photograph cannot check.
- **Unit, the shared builder:** follow `keypadUi.ts`'s injected-DOM pattern (`KeypadDeps`), which is
  what lets the existing keypad be tested on all 48 pairs with no jsdom. The new builder gets the
  same treatment, including that **inert keys emit `disabled`** and **actionable keys do not**.
- **Real browser, `browser-clicks.mjs`:** `Ctrl-B` opens the surface; a sample key from **each of
  the five regions** reaches the gateway as the right action (the existing keypad phase samples one
  button per block for exactly this reason — so no region can go dead unseen); an **inert key sends
  nothing**; `Ctrl-K` closes it and opens the keypad.
- **Electron, `clicks.mjs`:** the same, through IPC, since that harness reads main's own action log.
- **Mutation-prove the two that matter:** delete the gateway's `toggleKeyboard` intercept (expect a
  dead process, not a failed check) and make an inert key actionable (expect the no-op check to go
  red).
- **`shot.mjs` and `browser-shot.mjs` must still match.** Neither golden contains an overlay, so a
  diff means something leaked into the base page.
- **NO LIVE HOST RUN IS NEEDED and the plan must say so**, per this project's convention that an
  unqualified claim was witnessed: every action this surface can raise is one an existing keypad
  button or chord can already raise, so nothing new reaches the wire. The inert keys raise nothing
  at all.

## 5. What this does not do

- **No TUI keyboard**, by the user's direction.
- ~~**No Shift/Caps state machine.**~~ **SHIFT WORKS, and it is a ONE-SHOT STICKY MODIFIER** --
  the user's specification, verbatim: *"if you hit it the next regular character you type acts as
  if you'd shifted it, and then shift unselects. Basically the same as Caps Lock but it unsets
  itself after the next character."*

  **The rules, stated so they cannot be read two ways:**

  1. Clicking `Shift` ARMS it. The surface shows it armed (a pressed/held cap), and every dual-glyph
     cap may show its `shiftLabel` prominently while armed -- that second part is a nicety, not a
     requirement.
  2. The next click on a key with a `shiftLabel` sends the SHIFTED text and DISARMS shift.
  3. **A click on a key with NO `shiftLabel` -- a PF key, `Enter`, a cursor arrow -- does NOT
     consume the arm and does NOT change behaviour.** 3270 has no shifted `PF3`, and silently
     eating the arm would make the modifier feel broken. Shift stays armed until a character key
     uses it.
  4. Clicking `Shift` again DISARMS it, so an accidental press is undoable.
  5. **Shift arms NOTHING on the host.** It is pure surface state, held in the view, and no action
     crosses the socket or the IPC boundary when it is pressed. There is no `shift` member of the
     `Action` union and none is needed.
  6. **Closing the surface disarms it**, like every other piece of no-persistence state these
     overlays keep.

  **Both `Shift` caps behave identically** -- the keyboard has left and right ones and neither is
  distinguishable to us.

  **Caps Lock is NOT implemented.** The photograph's keyboard has one, and it stays inert like the
  other non-3270 caps: a latching mode is a second state machine for a typing path nobody is
  expected to use, and the one-shot above covers the real need (reaching `@` or `:` to type a
  host file name).

  **This is the one piece of genuinely new logic in the feature**, so it belongs in the shared view
  module where it can be unit-tested without a DOM -- the same split `transferUi.ts` uses, and for
  the same reason.
- **No key-repeat, no chording, no modifier latching.**
- **`Cursr Sel` stays unimplemented** — it is light-pen work.
- **No replacement of the compact keypad.** The user wants both *"at least for now"*, and may drift
  toward only the full keyboard: *"if I find that I don't ever use the little keyboard then maybe we
  drift towards A, but I kind of want to try it out first."* **So nothing in this design may make
  the keypad hard to delete later.**
