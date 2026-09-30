# Idea: move the GUI's keypad out of the canvas and into a native window

**The user's judgement after using the shipped keypad, 2026-09-30. Not designed, not scheduled.**
Parked here rather than folded into the transfer-UI spec, because it would change a SHIPPED feature
that a second front end shares and that has pixel goldens and two by-hand harnesses pinned to it.

## What prompted it

The user was asked what they did not love about the current `Ctrl-K` keypad, given four candidate
complaints. Their answer, in their own weighting:

- **(2) It is ugly** — strongly. Inverse video on a spaced grid, drawn through x3270's own `3270.bdf`
  atlas, so the buttons are 3270 glyphs rather than anything resembling a button.
- **(4) It is modal in an annoying way** — strongly. `Ctrl-K` toggles it and it is awkward to leave up
  while working.
- **(3) It is awkward to use** — somewhat. 47 buttons in a grid you have to aim at, no tooltips, no
  keyboard navigation in the GUI (the TUI's overlay has a navigable list; the GUI's does not).
- **(1) It takes screen space / resizes the window** — explicitly NOT a concern.

That the complaint is (2) and (4) and not (1) is the useful part: **the problem is not that the keypad
occupies the window, it is that it is drawn in the wrong medium and cannot be left alone.** A design
that merely shrank it would fix nothing the user actually minds.

## The shape of the idea

The same call the user made for the transfer form on the same day: **a separate `BrowserWindow` with
real HTML controls**, rather than a region drawn into the `DrawList` and hit-tested. A palette window
that can sit beside the terminal, be left open, be tabbed through, and carry tooltips naming what each
key does — `BINDING_INTENT` in `packages/frontend/src/bindings.ts` already holds that prose for every
key, and nothing currently shows it to a user.

**It would make the keypad NON-MODAL by construction**, which is complaint (4) answered structurally
rather than by tuning: a separate window has no reason to steal the terminal's keyboard, where an
in-canvas overlay must own it.

## Why it is NOT a rider on the transfer-UI work

- **The keypad is shipped and the web gateway shares it.** `packages/canvas/src/keypad.ts` is consumed
  by `gui` AND `web`; `KEYPAD_KEYS` lives in `frontend`. Changing the GUI's presentation does not
  change the browser's, so this SPLITS a currently-converged feature — the transfer UI merely starts
  out diverged, which is much cheaper.
- **It has real guards to re-satisfy**: the GUI goldens (`shot.mjs` 3/3), `clicks.mjs` (9 buttons/10
  actions, which clicks BY LABEL through `__tn3270ButtonCentre`), and `browser-keys.mjs`. A native
  window has no canvas coordinates for `clicks.mjs` to aim at, so that harness needs rethinking, not
  merely rerunning. See [[harness-passes-on-stale-artifacts]].
- **`hitTest`/`hitTestAt` exist FOR the in-canvas keypad** (`packages/canvas/src/hittest.ts`) and are
  in `BROWSER_MODULES` because the renderer hit-tests clicks itself. If the GUI stops drawing a keypad,
  that code is still needed by `web` — so it is not deletion, it is divergence.

## What it should NOT disturb

- **The TUI's overlay is a different answer to the same action and is liked.** It is a navigable list,
  keyboard-driven, and its opacity was a hard-won fix (host text once leaked into the chord column).
  Nothing here should touch `tui/src/keypadOverlay.ts`.
- **`applyAction` must keep throwing on `toggleKeypad`.** It is the front end's own display decision,
  and the throw is what makes a front end that forgot the arm fail loudly (`frontend/src/actions.ts`).
- **The 47 keys and their actions stay in `frontend`.** `keypad.test.ts` pins label/action pairs with a
  deliberately duplicated map precisely so a mismatch cannot hide; a presentation change must not
  become an excuse to re-derive the table.

## Open questions for whoever picks this up

- Does the web front end follow later, or stay canvas-drawn permanently? If permanently, `keypad.ts`'s
  geometry keeps exactly one consumer and that is fine.
- Does the palette window replace `Ctrl-K`'s toggle semantics, or become show/hide-and-remember?
  Non-modal argues for the latter, which is a preferences question the GUI does not have yet.
- Tooltips from `BINDING_INTENT` are the cheapest visible win here and could ship independently of any
  window change. Worth considering as a separate, much smaller job.
- Four keys have no other route in any interactive front end — **Sys Req, Dup, Field Mark, Newline** —
  so whatever replaces the keypad must still reach them, and none has a live witness yet.

## The four open questions above are ANSWERED — user, 2026-09-30

Recorded so the spec can be written without re-asking. **The user's guiding principle for the whole
job: "if in doubt, do what x3270 does."**

1. **The web gateway FOLLOWS LATER.** So `packages/canvas/src/keypad.ts` keeps its browser consumer
   and nothing there is deleted — the GUI diverges first and the gateway catches up, rather than both
   moving at once. `hitTest`/`hitTestAt` stay in `BROWSER_MODULES` regardless.
2. **`Ctrl-K` OPENS THE PALETTE WINDOW, and stays a hotkey.** It is joined by a toolbar control (see
   below), not replaced by one. **NO PERSISTENCE YET, which is the half of this question the user
   flagged as unclear and which is therefore decided conservatively:** the sub-question was whether
   "the keypad is open" should survive an app restart, since a separate window makes that newly
   possible. x3270 DOES remember, through the `keypadOn` resource — `x3270/x3270.c:264`, "Turn on
   pop-up keypad at start-up" — but that needs a preferences store the GUI does not have. So: both
   routes open it, closing closes it, every launch starts closed, and persistence arrives with
   preferences (which the connect dialog will want anyway).
3. **`clicks.mjs` gets REWIRED to the native window's real buttons**, not retired. It stays the only
   cover for the click path and for 9 of the 48 label/action pairs. Note what changes: it clicks by
   LABEL today via `__tn3270ButtonCentre` and canvas coordinates, and a DOM button has no canvas
   coordinates — so the seam becomes a DOM query by label. **Keep the by-label property**, since a
   coordinate list would be a second copy of the layout and would pass while the layout was wrong.
4. **The four otherwise-unreachable keys MUST keep a route** — Sys Req, Dup, Field Mark, Newline.
   Nothing else in any interactive front end can press them, and none has a keypad-button witness
   yet.

## What the window should look and behave like

**x3270's model, which the user named explicitly and which is confirmed in its source:**

- **A keyboard ICON in the window's own toolbar opens it.** `x3270/keypad.bm` is exactly that, and
  `menubar.c:604` places it via `keypad_button_init`; it ships at three sizes (`keypad.bm`,
  `keypad15.bm`, `keypad20.bm`) beside a TLS padlock icon in the same menubar. **So this work implies
  a MENU BAR**, which the user accepts as needed anyway — "we will need one for at least a connection
  dialog."
- **A separate keypad window**, opened by that control or by `Ctrl-K`.

**MEASURED REFINEMENT THE USER'S SKETCH DID NOT INCLUDE: x3270 has FIVE placements, not two** —
`left`, `right`, `bottom`, `integral`, `inside-right` (`x3270/keypad.c:318-332`, from the `keypad`
resource). **`integral` is precisely what we ship today**, and the other four are variations on
detached or docked. So "separate window" is x3270's majority behaviour and ours is its one in-window
mode. **The spec need not offer all five** — offering a choice at all is a preferences question — but
it should say which one it is implementing and that the others exist.

**Appearance, the user's words: it should "look like a native app, not an X-windows app", with a
pleasant font.** That is the same call they made for the transfer form the same day, and it points
the same way: real HTML controls in a `BrowserWindow`, not glyphs blitted through the 3270 atlas.

**ICONOGRAPHY IS AN OPEN PIECE OF WORK, and the user raised it themselves:** the arrows, Home, Tab
forward/back and Newline may want **drawn or sourced icons** rather than the current `^ v < >` and
abbreviated words. Note the constraint that makes this more than taste: the present labels are
atlas glyphs in CG order, so they are limited to the 3270 character set — a native window is not,
which is what makes icons possible at all. **Licensing matters if icons are sourced rather than
drawn**, since this repo already vendors x3270's font with its licence and is careful about it.

## What a spec still has to decide

- **Whether the 48 keys keep one table.** `KEYPAD_KEYS` in `frontend` carries label, action, row and
  col; rows/cols are canvas geometry a DOM layout would not use. Does the DOM view ignore them, or
  does the table grow a presentation-neutral grouping?
- **Where the menu bar lives**, since it is new: Electron's application menu (macOS convention, off
  the window) versus an in-window toolbar (which x3270 uses, and which Linux users may expect).
  These differ per platform and packaging targets all three.
- **What happens to `KEYPAD_ROWS_TALL` and `keypadRegion`** once the GUI no longer draws a keypad
  into its draw list: still needed by `web`, so they stay — but the GUI's `showKeypad` flag, its
  `fit()` window-growing path and the keypad's presence in `DrawList` all become web-only.
- **Whether the GUI goldens change.** `shot.mjs` has a `synthetic-ispf-keypad` case that renders the
  in-window keypad. If the GUI stops drawing one, that golden is testing a path only the browser
  still has — so it either moves to the web harness or is regenerated.
