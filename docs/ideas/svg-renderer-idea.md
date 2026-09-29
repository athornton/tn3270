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
  a list of SVG path and text features. Arc and character angle/shear are confirmed honoured by the
  3192G firmware, and both are one SVG attribute each.
- **It deletes a whole layer we would otherwise write and verify.** Rasterizing vectors correctly —
  joins, caps, fill rules, arc parameterization — is real work with no oracle. SVG has all of that
  implemented and tested by other people.
- **Resolution independence comes free**, which is the natural fit for oversize, `IBM-DYNAMIC` and
  local model-switching: those three make geometry a user-driven variable, and a vector scene graph
  resizes where a bitmap has to be re-blitted.
- **Font smoothing becomes possible** rather than being fought, which is the composite model's point.

## THE TENSION THAT DECIDES IT: this project's evidence is pixel-exact hashes

**This is the thing to resolve FIRST, not discover later.** The GUI and web renderers are verified by
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
smoothing deliberately abandons the property that makes the current comparison work. So this idea and
the current verification strategy are in direct conflict. **That is not a reason to reject it; it is
the question it has to answer.**

## The questions a brainstorming session must answer

1. **What replaces pixel-exact goldens?** Comparing serialized **SVG** rather than pixels is the
   obvious candidate — it is deterministic, diffable, and reviewable in a way a bitmap is not. But it
   verifies the *scene we built*, not the *image a user sees*, which is a genuinely weaker claim.
   Would a structural comparison plus a small set of tolerance-based visual checks be acceptable, or
   does that cross the line this project drew against pixel tolerances?
2. **Does the existing bitmap path SURVIVE alongside it?** Two renderers is exactly the outcome the
   PS work was shaped to avoid ("an addition rather than a second renderer"). If SVG is only for a
   composite model, is the cost two rendering paths forever?
3. **What about the TUI?** It has no canvas and no SVG. Today all four front ends share `frontend`,
   and `core` hands out `Cell` variants a renderer dispatches on. An SVG scene graph is a
   *different* interface. Does `core` grow a second output shape, or does SVG generation live in
   `canvas` as one more consumer of the same cells?
4. **Which GOCA orders do NOT map cleanly?** The user's own "maybe not all" is the right instinct.
   Candidates from the notes: `X'7E'` Erase Graphics Plane and the Viewing Window orders are
   *stateful display* operations rather than drawing, and pattern/marker sets may not have SVG
   equivalents. **Enumerate them before committing**, because they are where a clean mapping turns
   into a special case.
5. **Does authenticity matter here?** A 3192G rasterized in firmware, and its output had firmware's
   exact imperfections. An SVG renderer will look *better* than the hardware. For a composite model
   that never existed, better is the point — but it means the GOCA work can no longer be verified by
   "does it look like the real thing", and there is already no oracle or live witness for graphics.
6. **Is the 3270 character grid genuinely just placement?** Mostly — but field attributes, the cursor,
   and inverse video interact with cell boundaries in ways the blitter currently gets for free.

## What already exists in our favour

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
