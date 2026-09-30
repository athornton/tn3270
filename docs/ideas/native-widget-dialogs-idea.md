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
