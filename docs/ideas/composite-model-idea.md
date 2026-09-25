# Idea: an "all the bells and whistles" 3270 that never existed

**Status:** IDEA ONLY — captured 2026-09-25 from the user, for a future brainstorming session. Not
designed, not scheduled, not scoped. **Do not implement from this file.**

## The idea, in the user's terms

An explicit terminal type that maps to a 3270 **that never existed**: it advertises `IBM-DYNAMIC` so
it can be whatever size, implements the **full GOCA set including `Box`**, and carries
**3279-S3G-class full-featured Programmed Symbol support** — even though the last two never coexisted
on any real 3270. On that model *only*, default to the **antialiased TrueType font** rather than the
bitmap atlas.

A combination of every good feature, rather than a faithful copy of one device.

## Why this is interesting beyond convenience

**It is a self-consistent destination for capabilities that otherwise have no device to aim at.**
Recorded as of 2026-09-25, native vector graphics is the first feature in this project with
**neither an x3270 oracle nor a live witness** — no emulator implements it and no host here drives a
G-terminal. A composite model does not conjure a witness, but it does give the implementation a
coherent target: "what does OUR terminal do" is answerable where "what does a 3179-G do" currently is
not.

It also inverts a real constraint. Today, deciding whether to implement an order means asking which
historical device accepted it. On a model we define, **we** decide, and the answer can be "all of
them" — which is why `Box` is called out: it is in AFP GOCA at `X'80'`/`X'C0'` and **j3270 omits it**,
so on a faithful model its status is genuinely unresolved, while on this one it is simply supported.

## What already exists in our favour

- **Models live in ONE table with ONE shape.** `packages/core/src/termtype.ts` `KNOWN_MODELS` maps a
  name to `{ ttype, alternate }`, and `lookUpModel` rejects anything not in it *by name*. Adding a
  model is a table entry; the rejection path already exists and is tested.
- **`Cell` is a tagged variant specifically so a renderer dispatches on `kind`** rather than assuming
  a font lookup — recorded as the reason PS was designable at all. A composite model leans on the
  same seam.
- **The GUI's blit primitive was chosen so PS is a small addition**: a PS glyph is a host-supplied
  bitmap, which is what the blitter already draws.
- **Four front ends already share `frontend`** (`core ← frontend ← { cli, tui, canvas, gui, web }`),
  so a model-scoped default has one obvious home.

## The questions a brainstorming session has to answer

These are the reasons this is a spec and not a patch:

1. **What is it called, and does the name go on the wire?** A name outside `IBM-*` may be rejected by
   real hosts; `IBM-DYNAMIC` is a real advertised value, so the *advertisement* and the *local model
   name* may need to be separate things. Today `Model` conflates them (`ttype` is what we send).
2. **`IBM-DYNAMIC` is already roadmapped separately** (scheduled immediately after the keypad, user
   2026-09-16, and still unstarted). Its prerequisite is Read Partition / Query Reply, which TK5's TSO
   does issue. **This idea should probably CONSUME that work rather than duplicate it** — so it likely
   sequences after `IBM-DYNAMIC` lands, not before.
3. **What does the model actually change?** Candidates, and they are not equivalent: the advertised
   terminal type; the Query Reply capability set (graphics QRs `X'B4'`/`X'B6'`/`X'B0'`/`X'B2'` are all
   Query-List-All-only); the renderer's font choice; which GOCA orders are accepted. A model that
   changes *four unrelated things* may want to be a **capability bundle** with a model name attached,
   not a fifth row in `KNOWN_MODELS`.
4. **Does a host have to cooperate, and what happens when it does not?** A host that never issues Read
   Partition learns nothing about us — VM/370 never issues one even to a `-E` client. So on such a
   host this model may be indistinguishable from a plain one, which is fine but should be stated
   rather than discovered.
5. **TrueType-by-default is a real divergence.** The GUI's atlas is baked from x3270's own `3270.bdf`
   precisely so glyphs match the reference, and the goldens compare rendered ink. A TrueType default
   means **this model cannot share those goldens** and needs its own. Worth confirming that is
   intended, and noting `docs/superpowers/specs/2026-09-22-second-font-scoping.md` may already bear on
   it.
6. **Does it risk becoming the default?** A terminal that admits every capability is a good testbed
   and a bad conformance baseline. The conformance comparison against real s3270 depends on our
   advertising what s3270 advertises — this model must not quietly become what `npm test` measures.

## What it is NOT

- Not a substitute for GA18-2177 / GA18-2535. Those describe real devices and are still wanted; this
  model is a destination, not a source.
- Not a reason to skip faithfulness elsewhere. The existing models stay exactly as they are, including
  their refusals — a plain `IBM-3278-2` still gets `IKT00405I` from TSO, and that is correct.
- Not scheduled. The roadmap ahead of it is: DFT selection → DFT tasks 10-12 → `IBM-DYNAMIC` → PS +
  VMGIF → native vector graphics. This is downstream of all of it, because it composes the features
  they build.
