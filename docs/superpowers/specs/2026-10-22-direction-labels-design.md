# The transfer direction labels — design

**Status: designed and approved 2026-10-22. Not implemented.**

## The defect: this cost a real file

On 2026-10-07 the user — an expert on this protocol, driving their own client — **overwrote their
own `PROFILE EXEC A`** on VM/370 with `Exist=replace`. The form showed a `Direction` field whose
values are the bare words `receive` and `send` (`transferForm.ts:58`), with **nothing naming the
endpoints**, and it opened on `receive`.

**ALL FOUR OF THIS FEATURE'S EXISTING GUARDS DEFEND AGAINST AN EMPTY FILE REACHING THE HOST. NONE
COVERS A VALID FILE HITTING THE WRONG TARGET.** That asymmetry is the whole of this defect: every
safety mechanism built for the transfer feature was pointed at a different hazard than the one that
actually destroyed data.

x3270 does not confirm a direction either, so the current behaviour is arguably correct — but it is
one click from data loss, and the remedy costs nothing.

## Two changes

### 1. The displayed direction names both endpoints

| stored value | displayed as |
|---|---|
| `send` | `send: local to host` |
| `receive` | `receive: host to local` |

**THE STORED VALUE MUST NOT CHANGE, AND THIS IS THE CONSTRAINT THE WHOLE DESIGN TURNS ON.**
`formKeywords` emits `Direction=${value}` verbatim (`transferForm.ts:233`) and
`parseTransferKeywords` validates against the literal `['receive', 'send']`
(`transfer.ts:483`). A relabelled *value* would emit an invalid keyword and be refused by our own
validator. So this is **display-only**.

**That split is an established pattern here, not an invention.** Two front ends already map a
stored value to different display text: the TUI's `shown()` renders `''` as `-`
(`tui/src/transferOverlay.ts:101-105`), and the web `<select>` renders `''` as `(host default)`
(`web/src/transferBoot.ts:295`). This adds a third mapping of the same kind.

**Why "local" and not "this browser".** The user's own suggestion was `send (this browser → host)`,
which is right for the web gateway and **wrong for the other two front ends**: in the TUI and the
Electron GUI, "local" is this machine's filesystem, not a browser. `local` is true in all three, and
it **matches the `Local file` field label directly above it** — so the form reads as one coherent
statement instead of two vocabularies. A per-front-end wording was considered and rejected: it buys
precision about *which* local thing, which does not change which way the bytes go, at the cost of a
new seam through `transferUi.ts`'s shared `offered()`.

**No `->` or `<-` anywhere.** Fira Code and friends ligate them, and this repo has already pulled
arrows out of the TUI's help line for that reason (`transferUi.ts:370-371`). A real `→` (U+2192) is
safe in a browser but the TUI accepts **printable ASCII only** (`tui/src/app.ts:958`), so an arrow
would force per-front-end text. The word `to` carries the same meaning in every renderer.

**It fits.** `receive: host to local` is 24 characters; the TUI's `VALUE_WIDTH` is already **40**,
set by the two 40-wide text fields, so cycle values up to 40 cost nothing. `LINE_WIDTH` stays 54 and
`TRANSFER_MIN.cols` stays 56 — **24 columns of headroom against the 80-column floor**, and no change
to `TRANSFER_MIN`. Verified by computation, not assumed.

### 2. The form opens on `send`, not `receive`

**The user's stated reason, recorded because it explains a choice that may look surprising later:**
until there is a TCP/IP stack for VM, this client is *mostly going to be used to get software onto*
VM and MVS systems — few people will actually be developing software locally on them. So upload is
the common case and should be the default.

**The user's planned route to that TCP/IP stack**, noted as the condition that could make this worth
revisiting: UTS (v7 Unix) plus an IUCV-alike backported to VM/370, plus a simple network driver over
a **CTC pair** (cribbing from Linux on System/390 and z, which already has this), running a small TCP
stack in UTS — difficult on the PDP-11 for address-space reasons, but not on S/370 with up to 16 MB —
and using the IUCV-alike to reach VM service machines. **If that lands, download stops being the
rare direction and this default should be reconsidered.**

#### BOTH DEFAULTS MOVE TO `send` — REVISED BY THE USER, LATER THE SAME DAY

> **THE SECTION BELOW WAS THE ORIGINAL DECISION AND IT WAS OVERRULED. It is kept verbatim because
> the argument it makes is still the strongest case against what shipped, and anyone reconsidering
> this should read it first.**
>
> **What shipped:** BOTH defaults are `send` — `newTransferForm()` *and*
> `parseTransferKeywords`. The user's reasoning, which carried the decision: *people are more
> likely to use IND$FILE to get something INTO a historic S/370 system than to get it out.* A
> default should reflect what the tool is FOR, and a form/parser disagreement is its own trap for
> anyone who learns the tool through the form and then writes a script.
>
> **The risk the section below names is real and was accepted, not refuted.** It is documented
> loudly instead: in `transfer.ts` at the default, in the README's *File transfer* section as a
> call-out, and in the one test that pins it. **MEASURED when it changed: 39 of the 48
> `Transfer(...)` calls in `cli/test/runner.test.ts` omitted `Direction=`** and 23 tests failed at
> once — a good demonstration of how much can depend on an unnamed default. Every one was made
> explicit rather than left tracking whatever the default happens to be.

##### The original decision, superseded

There are two distinct defaults and **they are deliberately asymmetric**:

- **`newTransferForm()`** (`transferForm.ts:92`) — what the interactive form opens on. **Becomes
  `send`.**
- **`parseTransferKeywords`** (`transfer.ts:483`) — `get('direction') ?? 'receive'`, which applies
  when a script's `Transfer(...)` omits `Direction=`. **Stays `receive`.**

**Flipping the parser default would re-create this very defect in a worse place.** It would
silently change the meaning of every existing script that omits `Direction=`: a run that used to
download would upload, with `Exist=replace` reachable, and no form to look at. It is also
**x3270's own default**, which this project matches unless it has a documented reason not to.

**Checked, 2026-10-22: every `Transfer(...)` call in `packages/cli/scripts/` names `Direction=`
explicitly** (the two apparent exceptions are comments), so no in-repo script depends on the parser
default. The risk is to the user's own scripts and to anything written from x3270 habit — small, but
real, and not worth taking for consistency's sake.

**The justification for the asymmetry:** an interactive form with a visible, now-explicit control is
a different safety situation from an omitted keyword in an unattended script. The form's default is
safe *because* this design makes the direction unmissable; a script has no such affordance.

#### One visible consequence

`applicable()` shows `Recfm` only on a send (`transferForm.ts:163`), so **the form now opens with an
extra field drawn**. Harmless, but: several tests assert the opening field list, and the TUI's box
height is computed from the applicable count. Both must be re-verified rather than assumed.

## What this does NOT do

- **No confirmation prompt.** x3270 has none, and a modal on every transfer would be worse than the
  disease. The remedy here is that the direction states itself.
- **No change to the four empty-file guards.** They defend a different hazard and stay as they are.
- **No protection against a correct direction with a wrong `Host file`.** Naming the endpoints does
  not stop an operator from overwriting a *different* host file deliberately. Stated so the
  remaining exposure is not mistaken for closed.

## Verification

- **Unit:** `transferForm.test.ts` for the new default and the unchanged stored values;
  `transfer.test.ts` pins the parser's default in ONE place (its `keyword defaults` block) and
  every other case in that file names its direction explicitly, so the default has one home.
- **The display mapping is tested where each front end renders it:** `tui/test/transferOverlay.test.ts`
  recomputes the box geometry, which is what catches a width regression; the web and GUI render
  through `<select>`/`<option>`, covered by `browser-clicks.mjs` and `transfer.mjs`.
- **`formKeywords` must still emit `Direction=send`, not the label.** This is the one assertion that
  distinguishes a display mapping from a value change, and it is the thing most likely to be got
  wrong.
- **No live host run is needed.** Nothing here changes a byte on the wire: the keywords emitted are
  identical, and the only difference is which characters are drawn next to a field. **Said
  explicitly rather than implied**, per this project's convention.
