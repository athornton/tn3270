# Idea: render the terminal as SVG rather than rasterizing to pels

**The user's idea, 2026-09-29. Not designed, not scheduled, and deliberately downstream of the
graphics work it would change the shape of.** Parked here because the decision it forces is worth
taking deliberately rather than discovering halfway through GOCA.

## The idea, in the user's terms

The GUI has been thought of as *presenting the 3270 display*: a rectangular matrix of pels. That
framing implies **rasterizing all the GOCA output at a layer before it touches the display** — which
is exactly what a real 3192G did, in firmware.

The alternative: **use an HTML Canvas and SVG.** Most (maybe not all) GOCA orders map fairly directly
onto SVG elements. Then the character grid of a real terminal becomes just *where on the canvas to
draw a text glyph*, and nothing is rasterized by us at all — SVG represents the terminal output
directly. Modern browsers would handle it happily for the web UI, and Electron renders SVG too.

**It goes with [[composite-model-idea]]**: a superset terminal with font smoothing and the graphics
commands of every model combined. These two ideas want each other — a model that never existed is the
natural home for a renderer that is not imitating any particular hardware.

## Why it is attractive

- **GOCA's primitives really are SVG's primitives.** Lines, arcs, fillets, character strings with
  angle and shear, area fill — `docs/goca-reference-notes.md`'s order table reads substantially like
  a list of SVG path and text features. Arc and character angle/shear are confirmed honored by the
  3192G firmware, and both are one SVG attribute each.
- **It deletes a whole layer we would otherwise write and verify.** Rasterizing vectors correctly —
  joins, caps, fill rules, arc parameterization — is real work with no oracle. SVG has all of that
  implemented and tested by other people.
- **Resolution independence comes free**, which is the natural fit for oversize, `IBM-DYNAMIC` and
  local model-switching: those three make geometry a user-driven variable, and a vector scene graph
  resizes where a bitmap has to be re-blitted.
- **Font smoothing becomes possible** rather than being fought, which is the composite model's point.

## THE USER'S CONSTRAINT, STATED 2026-09-29 AND NOT NEGOTIABLE: THIS IS *IN ADDITION TO*, NEVER *INSTEAD OF*

**Read this before the section below, because it reframes it.** An earlier draft of this file
presented pixel-exactness as a tension "to resolve", which misread the intent. The user's position,
in their words: they *"still, absolutely, want to do a traditional pixel-perfect terminal emulation
(and that should very likely stay the default)"*. A prettier composite terminal, which would **not**
have perfect pixel replicability, *"would remain a user-settable option ('Display Mode' or something
like that) but would be in addition to the rectangular array of pixels, not instead of it."*

**So the question is NOT "what replaces pixel-exact goldens".** Nothing replaces them. They keep
verifying the default renderer exactly as they do today, including `browser-shot.mjs`'s proof that
Electron and the browser produce identical bitmaps. The question is the narrower and much more
tractable one: **what does a SECOND, opt-in display mode get verified by, given that it cannot be
verified the same way?**

That also settles question 2 below before it is asked: **yes, both paths exist, permanently and by
design.** The PS work's "an addition rather than a second renderer" principle was about not
*duplicating* the bitmap path to get PS glyphs; it was never an argument against an opt-in second
display mode that exists for a different purpose. Authenticity is the default's job; prettiness is
the option's.

## WHAT THAT MEANS FOR VERIFICATION: the existing evidence is untouched

**This is the thing to get right FIRST, not discover later.** The GUI and web renderers are verified by
hashing the **raw bitmap** and requiring byte-identical output. `packages/gui/scripts/shot.mjs` says
why in its own words: rendering is deterministic *"bitmap glyphs at integer scale with smoothing off,
no hinting, no subpixel antialiasing"*, and it explicitly forbids the escape hatch —
**"If comparison ever proves genuinely unstable, DO NOT add a pixel tolerance: find out why."**

That guarantee is load-bearing well beyond the goldens:

- **`browser-shot.mjs` proves the renderer is genuinely SHARED, in pixels**, by requiring the served
  page and the Electron app to produce identical bitmaps. That test is only possible because both
  rasterize identically.
- **Three GUI goldens and two browser cases** rest on it, and it is how a renderer change is
  distinguished from a renderer *regression*.

**SVG text rendering is not bitwise reproducible across engines, versions, or platforms** — and font
smoothing deliberately abandons the property that makes the current comparison work.

**None of which threatens the above, because the default mode keeps rasterizing.** The goldens, the
three GUI cases, the two browser cases and the shared-renderer proof all go on testing the bitmap
path unchanged. **The real risk is subtler and worth naming: that adding a second mode quietly erodes
the first** — a shared code path refactored for the SVG mode's benefit, a golden regenerated because
"the renderer changed", a `--update` run without looking. **Guard the default explicitly**: whatever
gates the mode should be pinned so the bitmap path cannot be reached through the SVG one, and the
existing goldens should keep running in the default mode with no flag set.

## The questions a brainstorming session must answer

1. **What verifies the OPT-IN mode?** Not "what replaces the goldens" — those stay. Comparing
   serialized **SVG** is the obvious candidate: deterministic, diffable, reviewable in a way a bitmap
   is not. Its honest weakness is that it verifies the *scene we built* rather than the *image a user
   sees*. Is that acceptable for a mode whose whole premise is that exact pixels are not the point,
   or does it still want some tolerance-based visual check — and does that cross the line this
   project drew against pixel tolerances, or sit outside it because the default never uses it?
2. **HOW IS THE DEFAULT PROTECTED FROM THE OPTION?** (Replaces the old "do both paths survive" — they
   do, by decision.) Two display modes means a mode flag, and a flag means a way to get the wrong
   one. What pins that the goldens still exercise the bitmap path, and that no SVG-motivated
   refactor silently changes it? This is the question with the most downside if got wrong, because
   the failure is invisible: a still-green suite over a subtly different default renderer.
3. **Where does the mode live, how is it set, and what do the non-canvas front ends do?**
   `-display-mode` alongside `-scheme`, which is already GUI/TUI-only? Per-window in Electron,
   per-connection in the gateway, following the keypad's precedent? **The TUI has neither canvas nor
   SVG**, so it should presumably reject the flag rather than ignore it — this project's `applyAction`
   convention is to fail loudly rather than show a dead control. And architecturally: `core` hands
   out `Cell` variants a renderer dispatches on, so does SVG generation live in `canvas` as a second
   consumer of the same cells, or does `core` grow a second output shape? **The first keeps one
   source of truth; the second is how two renderers start to drift.**
4. **Which GOCA orders do NOT map cleanly?** The user's own "maybe not all" is the right instinct.
   Candidates from the notes: `X'7E'` Erase Graphics Plane and the Viewing Window orders are
   *stateful display* operations rather than drawing, and pattern/marker sets may not have SVG
   equivalents. **Enumerate them before committing**, because they are where a clean mapping turns
   into a special case.
5. **Which mode does the GOCA work itself get verified in?** Authenticity is no longer the open
   question — the user settled that: the default is pixel-perfect and the pretty mode is opt-in. But
   it leaves a real one. A 3192G rasterized in firmware and its output carried firmware's exact
   imperfections; an SVG renderer will look *better* than the hardware, which is the point of the
   option and a problem for the DEFAULT. **If GOCA is implemented against SVG first because it is
   easier, the authentic mode's rasterizer becomes the untested path** — and graphics already has no
   oracle and no live witness. So: does the default's vector rasterizer get built first, or at least
   verified independently of the SVG one?
6. **Is the 3270 character grid genuinely just placement?** Mostly — but field attributes, the cursor,
   and inverse video interact with cell boundaries in ways the blitter currently gets for free.

## What already exists in our favor

- **`Cell` is a tagged variant precisely so a renderer dispatches on `kind`** rather than assuming
  bitmaps — noted in [[composite-model-idea]] and equally true here.
- **`canvas` is already a separate package** from both consumers (`gui` and `web`), so a second
  rendering strategy has a natural home without touching either front end.
- **The web front end is already a browser**, so SVG costs it nothing architecturally.

## What this is NOT

- Not a replacement for the bitmap renderer today. The current one is live-verified against two real
  hosts and pixel-shared between Electron and a browser; nothing here is a defect in it.
- Not scheduled. It sits behind oversize, model-switching, packaging, PS and GOCA — and **GOCA is
  where it would actually pay off**, which is why the question should be settled before that work
  starts rather than after.
