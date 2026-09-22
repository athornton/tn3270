# A second, modern font in the GUI — scoping note

**Date:** 2026-09-22
**Status:** SCOPING ONLY. Nothing designed in detail, nothing built. Priority is **behind** interactive
file transfer, because this is appearance and that is a capability nobody can reach at all.

## The question

Offer the user a choice in the GUI between the x3270 bitmap font currently used and
[rbanffy's `3270font`](https://github.com/rbanffy/3270font), which looks very similar but ships modern
outline formats. The fonts are downloaded to `$HOME/fonts` (ttf, otf, woff, svg, plus `LICENSE.txt`).

## The decision, which is the user's and should not be silently reversed

**Keep the x3270 bitmap atlas as the ONLY golden-verified path, and let the browser render the modern
font.**

The author's reasoning, 2026-09-22: the point of a modern font is looking good *at strange sizes*, and
a pixel-exact image "isn't terribly important as long as it's plausible (which a well-behaved font
should be)."

This overrode a proposal to rasterize the TTF at build time in order to keep goldens byte-exact. That
proposal was wrong in an instructive way: **byte-exactness is meaningless for output that legitimately
varies with size and platform**, so preserving it would have cost real work to protect a property this
feature does not want — and would have negated the font's whole advantage, since smooth scaling is
exactly what the bitmap path cannot do.

## Why this makes it cheap

- **A second font is a second RENDER MODE, not a second renderer.** Every real glyph currently goes
  through `ctx.drawImage` from an alpha-only atlas (`canvas/src/blit.ts:117`).
- **The primitive already exists.** `canvas/src/renderer.ts` already uses `ctx.font` (`:234`) and
  `fillText` (`:237`) — for error chrome only, and deliberately so: `:225` calls it "the one place
  canvas text is used".
- **No rasterizer, no new build input, and NO ATLAS INDEXING PROBLEM AT ALL.** `fillText` takes a
  Unicode string, so `EBCDIC → Unicode` replaces `EBCDIC → CG → column` and Chromium does the work.
- **It also unblocks non-integer scaling**, which is currently a design rule *because* bitmaps demand
  it. The modern path carries no such constraint.

`-scheme` is the precedent a `-font` flag should follow: four palettes, both front ends, not the CLI
(which has no renderer).

## THE HONEST COST, recorded because it is a real reduction in rigour

**The modern path would be verified BY EYE, not by test.** The three goldens (`synthetic-ispf`,
`-green`, `-keypad`) compare a raw-bitmap sha256 with **no tolerance**, and that is deliberate — "a
tolerance that hides a one-pixel regression is worse than no golden" (`gui/scripts/shot.mjs:22`).

So the goldens must keep asserting the **bitmap** path, **plus a test pinning which path is DEFAULT.**
Without that second test, a regression could silently move every user onto the unverified renderer and
the gate would stay green. This is the same shape as the recurring lesson that a harness outside
`npm test` is silently exempt from every change.

## Measured while scoping — do not re-derive

1. **Coverage is ample.** `3270-Regular.ttf` has **1997 cmap glyphs** against our atlas's 431:
   APL/Misc Technical **107**, Box Drawing 48, Block Elements 32, Math Operators 76, Greek 108, Basic
   Latin + Latin-1 191.

2. **The APL coverage question is MOOT TODAY.** `canvas/src/cg.ts`'s EBCDIC→CG table **never references
   a value above `0xff`**, so the vendored BDF's 175 page-1/2 glyphs (`apl_del`, `apl_iota`,
   `apl_epsilon`, …) are baked into the atlas and **unreachable**. Nothing above CG 255 can be drawn, so
   a second font cannot regress APL.
   *If APL is ever wired up*, the new path needs `column()`'s miss behaviour too: it falls back to
   `CG_BOXSOLID` (`cg.ts:107`), x3270's visible "unprintable" marker, and `cg.ts:104` warns that
   returning the wrong column "is a font bug only a golden could catch" — which under this design the
   goldens deliberately will not.

3. **The licence is fine: 3-clause BSD**, and the copyright list includes **Paul Mattes** (x3270's
   author) and GTRC, so this font descends from the same lineage as the BDF we already vendor. This
   repo is MIT; BSD-3 requires the notice be retained, which is the pattern
   `packages/canvas/assets/LICENSE-3270-font.txt` already establishes. No blocker.

4. **A build-time rasterizer would have needed NO new dependency** — `fontTools` and PIL 12.3.0 are both
   in `lsst-scipipe-13.1.0-exact` (`source /opt/lsst/software/stack/loadLSST.bash`), and the TTF loads
   as `('IBM 3270', 'Regular')`. Recorded because it kills the "we would have to add a dependency"
   objection if this decision is ever revisited. Under the chosen design it is not needed.

## Not decided

- Which formats to vendor, and whether to vendor at all or load from the system.
- How the EBCDIC→Unicode map is built, and what it does on a miss (see finding 2).
- Whether the web gateway gets the same choice. It shares `renderer.ts` unmodified, so it probably
  comes along for free — but "probably" is not a design.
- Whether non-integer scaling is actually enabled for the modern path, or merely becomes possible.
