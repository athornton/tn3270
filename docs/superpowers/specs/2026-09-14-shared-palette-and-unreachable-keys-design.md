# Shared palette schemes, the keys nothing could reach, and the default terminal type

**Date:** 2026-09-14
**Status:** designed, not built
**Origin:** the user ran the Electron GUI as a Model 4 against VM/370 on a Mac, got the
expected 80x43 window, and reported that **the dark blue is very hard to read on a black
background**. Then asked which keys are PA1 and PA2.

The answer to the second question turned out to be "none, in the GUI", and chasing that
found a class of the same defect. So this design has several parts that share one principle:
**a front end should not silently diverge from the others**, and where they do, the guard
that was supposed to notice is itself part of the bug.

**Amended 2026-09-14 after the user tested against MVS 3.8j TK5 and reported back.** That
session found two more defects — the TUI's PA keys are broken too, and the default terminal
type fails on MVS — and corrected one misconception about the light pen. Everything the user
measured is recorded in *Live findings from the MVS session* below.

**Amended again the same day** with Problem 5: the readable palette becomes the default rather
than the only option, selectable by `-scheme` across four named schemes. Note that this
**supersedes one earlier decision within this document** — `ANSI_16` moves out of the TUI after
all; see *The shared palette registry*.

**Five parts, in dependency order:** the palette registry (1, 5) must land before the GUI can
draw from it; the bindings (2, 3) are independent of both; the default terminal type (4) is
independent of everything else here and could ship alone.

## Problem 1: the GUI never got the TUI's palette

`packages/gui/src/drawlist.ts` resolves colour through core's `colourRgb`, where blue F1 is
**pure `#0000ff`** (`packages/core/src/palette.ts:92`). On black that is close to
illegible, which is what the user saw.

The TUI does not use that table. It has its own, `TUI_PALETTE`
(`packages/tui/src/colours.ts:61`), where blue is **`(120,144,240)`** — zti's own value,
read from `tnz/zti.py:2813-2820` and independently confirmed on the wire, with F8-FF taken
from x3270's `rgbmap` (`c3270/screen.c:213-229`). Core's saturated primaries exist for one
reason, stated in its own comment: so that seven base colours stay distinct when quantised
to sixteen ANSI slots. **That reason no longer applies** — the TUI stopped relying on
nearest-RGB when it gained the explicit `ANSI_16` slot table (`colours.ts:95`), and the GUI
is truecolour and never quantises at all. So nothing is served by the GUI using them.

The comment in `core/src/palette.ts:5-7` claims "The TUI quantises these, the GUI will fill
canvas cells with them ... One table, three consumers." The first clause has been false
since the TUI shipped its own table. **The stale comment is why this drifted**, and it is
part of what gets fixed.

## Problem 2: PA1/PA2/PA3, Attn, Insert and Newline are unreachable in the GUI

`packages/gui/src/keys.ts:73` returns `null` for any Alt or Meta chord and has no PA entry,
so **PA1/PA2/PA3 cannot be pressed in the GUI at all**. In the TUI they are `Esc`-`1`/`2`/`3`
(`packages/frontend/src/keymap.ts:120`), which is what Alt-digit sends in a terminal and
matches x3270's own default (`Alt <Key>1: PA(1)`, `Common/fb-c3270:43-45`).

`BINDING_INTENT` exists precisely to catch this — "a key added to one front end is visibly
missing from the other" — and it did not, because **the test skips what it cannot express**:
`packages/gui/test/keys.test.ts:96` does `if (key === undefined) continue;` with the comment
"e.g. Alt-1, a terminal-only spelling". Alt-1 is not a terminal-only spelling; Chromium
reports Alt chords fine. **The guard has a hole, and fixing the binding without fixing the
guard leaves the mechanism broken for the next key.**

Auditing the rest of `BINDING_INTENT` against core found more of the same class:

- **`Session.sendAttn()` exists** (`core/src/session.ts:606`, Telnet BREAK per RFC 1576 §8)
  and is bound to no key in **either** front end. Implemented and unreachable.
- **`Session.sysreq()` exists** (`session.ts:598`) — likewise unbound.
- **`Keyboard.newline()` and `setInsertMode()` exist** (`keyboard.ts:196,286`) — likewise
  unbound in both front ends.
- **CursorSelect, Dup and FieldMark do not exist in core at all.** (CursorSelect is
  reclassified below; see *Follow-up*.)

### Two of those have no conflict-free spelling, and that decided the scope

Measured, not assumed:

- **Attn = `Ctrl-A`.** c3270's own default (`Common/fb-c3270:83`; x3270 also binds `Meta-a`,
  `fb-x3270:306`). `\x01` is unbound in our table. Clean in both front ends.
- **Insert = the `Insert` key**, toggling insert mode, as x3270 does
  (`fb-x3270:210`, `Toggle(insertMode)`). **`tput kich1` measures `\x1b[2~`** on the
  development box; it collides with and prefixes nothing in our table.
- **SysReq has no shared default at all.** c3270 binds it to no key — it is reachable *only*
  from the keypad (`Common/c3270/keypad.callbacks:7`, `g SysReq`). x3270 uses `Shift-F22`
  and `F19`, keys nobody has. Any keyboard spelling here would be **invented**.
- **Newline conflicts irreducibly in a terminal.** c3270 uses `Ctrl-J`
  (`Common/fb-c3270:100`) — but `Ctrl-J` **is** `\n` (0x0a), and `keymap.ts:106` already maps
  `\n` to Enter for terminals that send LF for Return. One byte cannot be both. x3270's
  `Shift-Return` is unavailable too: terminals do not report modifiers on Return.

**Decision (user's call): bind Attn and Insert now; leave SysReq and Newline to the keypad,
where a button has no spelling problem.** This follows c3270, which made the same call for
SysReq. It also avoids inventing a keyboard spelling for SysReq, which **could not be
verified against a live host here in any case** — SysReq only does anything under TN3270E,
and both Hercules systems actively refuse option 40 (measured: they answer `ff fe 28`).

## Problem 3: the TUI's PA keys are broken too, not merely awkward

Reported by the user: in the TUI, `Esc` `1` **types the digit `1`**. Confirmed from the code,
and the mechanism is certain.

`ESC_TIMEOUT_MS = 50` (`tui/src/app.ts:32`). A lone `\x1b` is `PARTIAL`, so the timer is
armed; if nothing follows within 50 ms **the buffer is discarded** (`app.ts:354-361`). A human
pressing Esc and then 1 takes hundreds of milliseconds, so the ESC is thrown away and the `1`
then arrives as a fresh printable run and is typed as text.

**So the TUI's PA keys only ever worked when the terminal sent `\x1b1` as a single burst** —
that is, via Option/Alt configured as Meta. `README.md:169-170` documents "`Esc` `1`/`2`/`3`
are PA1/PA2/PA3", which describes bytes rather than a keystroke a human can perform. The
keymap's own comment is accurate about the mechanism ("only a timeout can tell them apart")
but the resulting behaviour was never exercised by a human, and no test could catch it: the
unit tests hand `lookup()` a complete `\x1b1` buffer, which is exactly the case that works.

**Fix (user's call): when the buffer is exactly a lone `\x1b`, do not discard it on the timer
— hold it as a Meta prefix for one further keystroke.** Truncated escape sequences (`\x1b[`,
`\x1bO`) keep the 50 ms discard, so that protection is unchanged. Then literal `Esc` `1` works
in any terminal on any keyboard with no Option mapping, which also matches Emacs' Meta
behaviour — the user's habitual editor, and the reason they like this spelling.

The cost, stated plainly: a bare Escape pressed with no follow-up leaves one byte buffered
until the next keystroke, and that next keystroke is then consumed by the failed `\x1b`+key
lookup. **On a 3270 that costs nothing real** — Escape has no 3270 meaning and was already
being discarded — but it is a behaviour change and needs its own test.

## Problem 4: the default terminal type fails on MVS

With no `-model`, we advertise a bare `IBM-3278-2` (`termtype.ts:139`, from `TERMINAL_TYPE`
at `constants.ts:545`). **MVS 3.8j TSO rejects that with `IKT00405I` and no logon** — already
recorded at `termtype.ts:10`, and now reproduced live through the GUI.

**Decision (user's call): the default becomes `IBM-3278-2-E`.** The reasoning is support
load, and it is the user's to make: both live systems work with `3278-2-E`, and a default that
fails on one of the two most likely hosts generates "but it doesn't work" from every user who
did not read the manual. A bare `IBM-3278-2` stays available via `-model 3278-2` or
`--terminal-type`, and eventually a GUI model selector.

### The blast radius was measured, not estimated

The existing comment at `termtype.ts:132-138` warns that keeping the default at `IBM-3278-2`
"is what lets the VM/370 conformance comparison stay valid". **That overstates the coupling,
and the difference matters because it is the stated reason not to do this.** Measured by
flipping the constant, rebuilding and running the whole suite:

- **4 tests fail, in 3 files, and they are all expectation updates**: `termtype.test.ts:13`,
  `telnet.test.ts:64`, `telnet.test.ts:77`, `session.test.ts:760`. 1279 of 1283 still pass.
- **`conformance.test.ts` and `golden.test.ts` both PASS unchanged.** Two independent reasons:
  the offline conformance test filters negotiation out of the comparison
  (`conformance.test.ts:71`, `if (!isNegotiation(bytes))`), and the live conformance script
  already pins `-model 3278-2` explicitly (`packages/cli/scripts/conformance-vm.txt`). So the
  comparison is against a model-2 negotiation either way, and the committed capture is even
  named `vm370-conformance-model2.trace`.

**The comment therefore gets corrected rather than carried forward.** A stale warning that
forbids a change for a reason that no longer holds is as costly as a missing one.

### Harness audit, because a flipped default silently exempts everything outside `npm test`

This is the documented lesson from default-on TLS, which left `pty-smoke.py` at 1 of 12 for
two days. Audited, every script under `packages/*/scripts`:

- **Already pin a model, so unaffected**: `conformance-vm.txt` (`3278-2`), `shot.mjs`,
  `live-drive.py`, `drive-e.py`, `transfer-vm.txt`, `record-mvs.txt` (all `3278-2-E`).
- **`record-vm.txt` passes no `-model`** and is the recorder for the committed VM fixture.
  It gets an explicit **`-model 3278-2`**, so a re-record still reproduces
  `vm370-conformance-model2.trace` instead of silently negotiating `-E`.
- **`pty-smoke.py`** passes no model and asserts only that *a* terminal type was negotiated
  (`pty-smoke.py:265`), not which — so it passes either way. Left alone deliberately; the
  assertion is about negotiation happening, and narrowing it would couple a host-free smoke
  test to a default it does not care about.
- `count-orders.mjs`, `build-atlas.mjs`, `gen-test-certs.mjs` do not negotiate at all.

### Comments that name the old default and become false

`termtype.ts:126` ("Both spell IBM-3278-2 today"), `termtype.ts:132-138` (above),
`queryreply.ts:357` ("TERMINAL_TYPE is IBM-3278-2 regardless"), and `cli/src/main.ts:122`
("the same IBM-3278-2"). All four are load-bearing explanations, not decoration, so each is
rewritten rather than deleted.

## Problem 5: no way to ask for the primary-colour palette

Requested by the user once the default was settled: someone may want the unpleasant-but-
saturated colours deliberately, so the readable table should be the default rather than the
only option — a flag in the TUI, a menu item in the GUI and webserver later.

**There is no "literal original 3270 palette" to serve, and the flag must not claim there is.**
Core's `PALETTE_3279` is not it: its own comment says *"THE RGB VALUES ARE OUR OWN CHOICE,
DELIBERATELY NOT X3270'S"*, chosen as saturated primaries so sixteen-colour ANSI quantisation
keeps the seven base colours distinct — a TUI constraint, not fidelity. The same comment adds
that *"a real 3279's phosphors matched none of these precisely — ours or x3270's."* The manual
specifies which colour each code **is**, never its chromaticity. So the value is named
**`3279`** — the architected colours at full saturation — and not `original` or `authentic`.
A flag value is a claim users quote back.

x3270 solves this with **named schemes** rather than an authenticity switch: `default`,
`old-default`, `reverse`, `bright`, `cpe`, `GreenScreen` (`x3270/fb-x3270:49-99`), with its
menu labelling the standard one "Default 3279" (`schemeList:104`). It also keeps `old-default`,
which is precedent for our exact situation — change the look, keep the previous one named.

**And the genuinely authentic option is not a colour palette at all**: a 3278 is a monochrome
green display and colour is a 3279 feature, while we advertise `IBM-3278-2-E`. Hence `green`.

### x3270's scheme format has a separate screen background, and ours does not

Verified from `xfer_color_scheme` (`x3270/screen.c:4119-4180`), the 23 tokens are: **0-15** the
IBM colours, **16** a fallback, **17 the screen background**, **18** select background,
**19-22** attribute colours.

So `GreenScreen` sets **F0 neutral-black to `#21a021` — green** — and gets its dark screen from
`grey10` at token 17. **We resolve the background from F0** (the TUI's own note: "the default
background resolves to F0, and F0 renders black"). **Copying that table literally would give us
a green background.** Our `green` scheme therefore keeps F0 and F8 dark: a documented
deviation forced by a structural difference, not a transcription slip.

## Design

### The shared palette registry

New `packages/frontend/src/palette.ts`, exported from `frontend/src/index.ts`. **A scheme
carries BOTH its RGB table and its sixteen-slot map** — not RGB alone:

```
interface Scheme { rgb: Record<number, Rgb>; ansi16: Record<number, [number, boolean]> }
```

**Green is what forces that**, and it is worth stating because the RGB-only shape looks
sufficient: with a shared slot map, one session would render green at truecolour and
blue/red/yellow at sixteen colours. The slot map is part of a scheme's identity.

| Scheme | RGB source | Slot map |
|---|---|---|
| `default` | zti F0-F7 (`tnz/zti.py:2813-2820`) + x3270 F8-FF — today's `TUI_PALETTE`, moved verbatim | standard |
| `3279` | core's `PALETTE_3279` | standard |
| `x3270` | the full `rgbmap`, all sixteen verified at `c3270/screen.c:213-229` (blue `#1e90ff`, green `#32cd32`, neutral-black `#1a1a1a`) | standard |
| `green` | `#21a021` normal, `lime` bright, following x3270's per-code assignment (F2, F7, FF bright) — **F0 and F8 stay dark**, per the deviation above | **its own**: foreground codes → green slot, bright variants bright, F0/F8 → black |

`default`'s F8-FF already match `rgbmap` byte for byte, so `x3270` is mostly data we hold.

Also exported: **`DEFAULT_SCHEME = 'default'`**, **`resolveScheme(name?)`** (case-insensitive,
`greenscreen` aliased to `green`, and on an unknown name it throws listing the valid ones
rather than falling back — a silent fallback would render the wrong palette and blame the
user's memory), and **`schemeRgb(scheme, code)`**, which throws on a non-3279 code exactly as
core's `colourRgb` does.

The throwing helper exists alongside the raw table because the consumers need opposite failure
behaviour: `sgrFor` deliberately returns `''` for a bad code rather than throwing, since "a
throw here would take down the whole screen for one bad cell" (`colours.ts:184`).

`packages/frontend` may hold this: the graph is `core <- frontend <- { cli, tui, gui }`, and
`frontend` already imports core types. No graph change.

**Consumers:**

| File | Change |
|---|---|
| `packages/tui/src/colours.ts` | delete `TUI_PALETTE` **and `ANSI_16`**; `sgrFor` gains a `scheme` argument and reads both tables from it. What stays is the genuinely terminal-specific part: `detectDepth`, `cube256`, and the depth quantisation itself. |
| `packages/tui/src/main.ts` | parse `-scheme`; thread the resolved scheme to `Renderer`. |
| `packages/gui/src/drawlist.ts:94,95,139,140` | `colourRgb` (core) → `schemeRgb(scheme, …)`; `drawList` takes the scheme. It runs in MAIN, which has the parsed args, so nothing new crosses IPC. |
| `packages/gui/src/args.ts` | parse `-scheme`. |
| `packages/gui/test/blit.test.ts`, `drawlist.test.ts` | assert against the scheme the GUI actually draws. |
| `packages/core/src/palette.ts:5-7` | correct the false "TUI quantises these / GUI fills cells with them" comment; point at the registry. |

**This supersedes an earlier decision in this spec**: `ANSI_16` was to stay in the TUI, on the
grounds that terminal quantisation is the TUI's problem. Once a scheme owns its slot map that
is no longer true — the slot map is scheme data, and leaving it behind would make `green`
impossible to express. Recorded rather than silently rewritten, because the original reasoning
was sound for a registry that held RGB only.

**`PALETTE_3279` and `colourRgb` stay in core, untouched**, and core's table now has a job: it
is the `3279` scheme's data. That resolves the "two palettes with no signpost" risk better
than a cross-reference comment did — core states the architected meaning, and the registry
decides what a front end draws.

### The flag

**`-scheme NAME`**, x3270's own spelling (`include/resources.h:529`,
`OptColorScheme "-scheme"`), following the project's habit of taking x3270/s3270 spellings
where one exists — as `-model`, `-cafile` and `-noverifycert` did. Note that **`-scheme` is
X11-x3270 only; c3270 has no scheme support at all** (no hits in its sources), so there is no
terminal-side precedent to contradict. Both front ends parse it; the GUI menu comes with the
menu work.

**Trap #5 does not apply here, verified rather than assumed.** `drawlist.ts` is a
main-process module: `dist/renderer.js` imports only `./keys.js` and `./blit.js`, and both
reach `drawlist` through `import type` only, which erases. So adding a value import of
`@tn3270/frontend` to `drawlist.ts` cannot put a workspace import in the renderer's runtime
graph. `keys.ts` **does** run in the renderer, so its changes below are literals only and add
no value import. A new test pins this rather than trusting the reasoning.

**Visible consequences beyond blue,** since the whole table is adopted: F0 neutral-black
`#1a1a1a` → **pure black** (the GUI background and the OIA go truly black), F7 neutral-white
`#e0e0e0` → pure white, F5 turquoise `#00ffff` → `(88,240,240)`, F9 deep-blue `#000080` →
`#0000cd`. Every cell shifts slightly; **blue F1 is the only one that changes character.**

**Caveat, stated because it is not settled:** F9 deep-blue stays dark even in this table
(x3270's `#0000cd`). Basic 3270 field colour reaches only F1-F7, so the user almost certainly
saw F1 and this fixes it — but a panel sending *deep-blue* through extended attributes will
still be dark. If it survives, F9 is a separate question and must not be pre-emptively
"fixed" here on a guess.

### The bindings

- **`Action`** (`frontend/src/keymap.ts`) gains `{kind:'attn'}` and `{kind:'toggleInsert'}`.
- **`applyAction`** (`frontend/src/actions.ts`) gains `case 'attn': session.sendAttn()` and
  `case 'toggleInsert': k.setInsertMode(!k.insertMode)`. `Keyboard.insertMode` is a public
  field (`keyboard.ts:14`), so the toggle needs no new core API. Both sit inside the existing
  try/catch, which is correct: Attn on a closed connection is normal operation, and the OIA
  already says why.
- **`BINDING_INTENT`** gains PA3 (it listed only PA1/PA2), `Ctrl-A`/`\x01` for Attn, and
  `\x1b[2~` for Insert. The Alt-digit entries gain a note that the GUI matches `e.code`.
- **TUI `keymap.ts`**: add `\x01` → attn, `\x1b[2~` → toggleInsert. PA1-3 already present.
- **GUI `keys.ts`**: handle Alt+digit **before** the `if (e.metaKey || e.altKey) return null`
  bail, matched on **`e.code`** (`Digit1`..`Digit3`) — **not `e.key`**, because on macOS
  Option-1 reports `e.key === '¡'`, so a `e.key`-based binding works on Linux and silently
  fails on the user's Mac. `Ctrl-A` joins `CTRL`; `Insert` joins `NAMED`. Alt with any other
  key still returns `null`.
- **The guard gets repaired**: `keys.test.ts`'s silent `continue` becomes an explicit,
  **currently empty** allowlist of terminal-only bindings. A future `BINDING_INTENT` entry
  the GUI cannot express then **fails** instead of vanishing. The `checked` floor rises with
  the new entries.

### The lone-ESC Meta prefix

In `tui/src/app.ts`, the timeout path (`app.ts:354-361`) splits on buffer content instead of
discarding unconditionally: a buffer of exactly `[0x1b]` is **retained** across the timeout;
anything longer is discarded as it is today. The `escTimer` still exists for the longer case,
including its teardown at `app.ts:200-204` that stops an armed timer keeping the event loop
alive at exit. `keymap.ts` needs no change at all — `\x1b1` is already in the table; it was
the delivery that never happened.

### The default terminal type

`constants.ts:545` becomes `IBM-3278-2-E`. That is the whole code change; the work is the four
expectation updates, the four stale comments, `record-vm.txt`'s new explicit `-model 3278-2`,
and the live re-check with no flag. `KNOWN_MODELS` is untouched — `termtype.ts:125-130` is
explicit that editing it must never change what a session with no options negotiates, and that
separation is what makes this a one-line change.

### Documentation

The README has **two** key paragraphs and **one palette paragraph**, and all three are
affected. Missing any of them leaves the README contradicting itself.

- **`README.md:123-125`, the GUI's key list**: gains PA (Alt-1/2/3), Attn (`Ctrl-A`) and
  Insert.
- **`README.md:140` is wrong today** and gets corrected: it lists the GUI's "PA keys" under
  *implemented but not yet verified against a live host* when they are not implemented at all.
- **`README.md:168-170`, the TUI's key list**: gains `Ctrl-A` and Insert. Its `Esc` `1`/`2`/`3`
  claim becomes true only once the Problem 3 fix lands — **it is a promise the code does not
  currently keep**, so the fix and the sentence must ship together.
- **`README.md:173-175` becomes false and must be rewritten.** It currently says "Colours are
  zti's, not core's: **the shared palette in `packages/core`** keeps saturated primaries, and
  **the TUI** renders the gentler values". After this change the gentler values are the shared
  ones, they live in `packages/frontend`, and every front end uses them — core's table is no
  longer "the shared palette" in any sense a reader would take from that sentence. The rewrite
  documents `-scheme` and the four names, and says plainly that **`3279` is our saturated
  choice rather than a phosphor measurement** — the same honesty the flag value is named for.
- The TUI `BANNER` (`tui/src/main.ts:177`) **stays as it is**. It deliberately names only
  quit/Clear/Reset so that a short terminal still learns the way out; diluting it with Attn
  would work against its stated purpose. The TUI's on-screen hint line (README:162-171) is the
  same argument and also stays.

## Testing

- **The cross-front-end property, asserted directly**: for **every scheme** and all sixteen
  codes, the RGB the GUI resolves equals the RGB the TUI emits at truecolour depth. This is the
  actual requirement, and it fails if either front end drifts again. `default`'s blue is pinned
  at `(120,144,240)` with its zti provenance.
- **Every scheme must be complete**: all sixteen codes present in both `rgb` and `ansi16`,
  asserted table-driven over the registry so a scheme added later cannot ship half-defined.
- **The pairwise-distinctness assertion must become PER-SCHEME, and `green` must assert the
  opposite.** `green` deliberately aliases fourteen codes onto one value, so the existing
  distinctness test applied blindly would report the new scheme as a defect. `green` instead
  asserts that it *does* alias, and that F0/F8 are **not** green — the deviation that keeps our
  background dark, and the one thing a literal transcription of x3270's table would have got
  wrong.
- **A luminance-floor test was considered and rejected**: F8 black is legitimately black, so
  any "every foreground must be legible on F0" assertion needs exemptions that make it
  vacuous. The value pins plus per-scheme distinctness carry more.
- **The GUI golden must be re-baselined** — `test/golden/synthetic-ispf.png` and its sha256.
  The `TN3270_GUI_REPLAY` seam makes that host-free and clock-free (no password, no TK5
  clock). **The diff must be inspected, not accepted**: colours should change and ink
  positions should not. A moved glyph means something else broke.
- **A second golden on `green`**, since replay is deterministic and that scheme is the one most
  likely to break the blit path: `blit.ts` caches tinted glyph copies keyed by colour
  (`tintKey`), and a scheme where fourteen codes share one RGB is the first thing that has ever
  exercised a cache hit across *different* colour codes.
- **New renderer-import guard**: assert that the renderer's runtime graph (`dist/renderer.js`
  plus its transitive *local* imports) contains no `@tn3270/*` value import. This is trap #5,
  whose symptom is a blank window with no error, and this change edits both a renderer-side
  and a main-side module.
- **Key unit tests**: Alt-1/2/3 via `e.code` **including the macOS `key:'¡'` case**, `Ctrl-A`,
  `Insert`, and the repaired intent guard.
- **The ESC-prefix fix needs a test no existing one could have caught.** Every current keymap
  test hands `lookup()` a complete `\x1b1`, which is the case that already worked. The new
  tests must drive `app.ts` with the bytes **split across two reads with the timer firing in
  between** — that is the shape of the bug. Also pin the part that does *not* change:
  `\x1b[` followed by nothing is still discarded after 50 ms.
- **Four expectation updates for the default flip**, already located by measurement:
  `termtype.test.ts:13`, `telnet.test.ts:64`, `telnet.test.ts:77`, `session.test.ts:760`.
  `conformance.test.ts` and `golden.test.ts` must still pass **without being touched** — if
  either needs editing, the premise of Problem 4 is wrong and the flip should stop.
- **Build before test.** `frontend` resolves to its built `dist/index.js`, so `npm run build`
  must precede `vitest` or the move looks like a broken refactor.

### Live verification, and its honest limits

- **Colour**: run the GUI against VM/370 here and confirm blue is legible. Doable in this
  sandbox.
- **PA1/PA2**: need a host that acts on them, which realistically means ISPF on MVS. **This
  is the user's check on the Mac and must not be reported as verified here.** What PA1 and PA2
  actually do in TSO — conventionally Attention and a screen redisplay — is **unverified**:
  there is no `pdftotext` on this box to search the TK5 manual, and the keys could not
  transmit until now, so nothing has ever exercised them.
- **Attn**: Telnet BREAK. Whether VM/370 acts on it is **to be measured, not assumed.**
- **The default flip wants one live run per host with NO `-model` flag at all**, which is the
  case that was broken. Expected: MVS TSO logs on where it previously gave `IKT00405I`, and
  VM/370 is unaffected. Both are reachable from this sandbox.
- **The flip puts the Query Reply path into the DEFAULT MVS session, and that must be
  confirmed from a trace rather than inferred.** TK5's TSO issues a Read Partition (Query) to
  an `IBM-3278-2-E` client and **waits** for the answer — captured 2026-08-17 in
  `packages/fixtures/x3270/tso-query-reply.txt`, with TN3270E *not* negotiated, so the trigger
  is the `-E` claim alone. Two consequences:
  - The user's successful `-model 3278-4-E` logon **strongly implies our Query Reply was
    accepted by a live host for the first time** — the session would have stalled otherwise,
    and it did not. That is inference from an outcome, so **the plan must confirm it in a wire
    trace**; the standing rule here is that a passing outcome does not tell you which of its
    inputs was exercised.
  - After the flip this stops being opt-in: any Query Reply defect reaches a user who passed no
    flags. That is an argument for the flip (real coverage by default) *and* a reason the live
    no-flag run above is mandatory rather than nice to have.
- **`packages/fixtures/x3270/README.md` and the fixture's own header are now stale** and get
  corrected: both say the Query exchange "is what our client cannot yet perform, and the reason
  TSO is unreachable". Query Reply landed in stage 2a, and the user has since logged on to TSO.
  A fixture header that misdescribes the current state is how a future session re-derives
  solved work.

## Live findings from the MVS session (user, 2026-09-14)

Recorded here and to be folded into `docs/live-testing.md`, because two of the three are new
witnesses and the third corrects a note we already had.

- **EWA IS NOW LIVE-VERIFIED ON MVS, not just VM/370.** With `-model 3278-4-E` the session
  starts at 24x80 and resizes to **80x43 once HERC01 is logged on** — the `f5` (EW) then `7e`
  (EWA) transition, previously witnessed only on VM. **`-model 3278-2-E` correctly stays at
  24x80**, since model 2's alternate size *is* 24x80 and there is nothing to switch to.
- **This sharpens an older finding rather than contradicting it.** We had concluded TSO does
  not *need* more than 24x80 (ISPF reported `TERMINAL: 3277`). That still holds — but it is now
  measured that **TSO will use 43 rows when they are offered.**
- **`IKT00405I` reproduced with a bare `IBM-3278-2`**, which is what no `-model` sends. See
  Problem 4. The user's transcription read `IKT004051` and `ERRIR`; the 3270 face makes
  `I`/`1` and `O`/`0` hard to separate, which is worth knowing when reading host messages off
  a screenshot.

## Follow-up, deliberately out of scope

- **SysReq and Newline** — per the decision above, they arrive with the keypad.
- **A menu of special keys, and/or a show/hide virtual keypad** (the user's request, x3270
  style). Its own spec. A native Electron menu needs no mouse plumbing; the keypad needs
  canvas hit-testing, which does not exist yet.
- **Mouse input is three unrelated jobs**, and only the third is architected: keypad buttons
  (pure UI hit-testing, no 3270 semantics), **text selection and cursor placement**, and the
  light pen. **The keypad needs none of the 3270 side, which is why it can ship first.**
- **Text selection is job 2, and it is NOT the light pen.** The user proposed implementing
  mouse text selection *with* `lightpen_select()`; that would be actively harmful and the two
  must stay separate. `lightpen_select()` **sends an AID to the host and mutates the buffer**
  (designator `?` → `>`, sets MDT, transmits `0x7e`), so if drag-to-select ran it, **every
  attempt to copy text would transmit to the host and modify fields.** x3270 keeps them apart
  for exactly this reason — plain click is selection, the light pen is a separate action gated
  behind Alt (`wc3270/screen.c:2357`).
  Selection is hit-testing, a text extent and a clipboard write: **no protocol work, no core
  changes.** It is also the mouse behaviour a Mac user misses first, so it is the strongest
  candidate to ship before either the keypad or the light pen.

### Light pen / Cursor Select — measured groundwork for that spec

The user asked whether mouse input should be the light pen. Largely yes, and core is already
half-built for it:

- **"Selector pen detectable" is not a separate bit — it *is* the intensity field.** Manual
  bits 4,5 (`~/3270/ref/pages.txt:3284-3287`): `00` normal/not detectable, `01`
  normal/**detectable**, `10` intensified/**detectable**, `11` nondisplay/not detectable.
  Core already parses exactly these (`FA.INT_NORM_SEL = 0x04`, `INT_HIGH_SEL = 0x08` — the
  names already say `_SEL`) but `screen.ts:375-379` surfaces only `intensified` and `hidden`.
  **Light pen needs no new data-stream parsing, just one derived boolean exposed.**
- **The inbound half is already written.** `AID.SELECT = 0x7e` exists
  (`constants.ts:460`), and `inbound.ts:30` already implements the rule that a SELECT AID
  sends addresses but **no field contents** on Read Modified — `sendData = all || aid !==
  AID.SELECT` — matching the manual (`pages.txt:2178`) and x3270 (`ctlr.c:788`). Tested, for
  an AID nothing can currently generate.
- **CursorSelect comes off the "core doesn't implement it" list.** In x3270 the Cursor Select
  *key* and the light pen are the same function: `lightpen_select(baddr)`
  (`Common/kybd.c:2906`), called with `cursor_addr` from the keyboard (`kybd.c:3001`) and
  with the hit address from the mouse (`x3270/xkybd.c:123`). **One function, two callers** —
  the keypad button passes the cursor address, a click passes the clicked address.
- **Its whole logic** is the designator character at field-attribute+1 (`kybd.c:2960-2980`,
  the non-DBCS `switch`), and it agrees with the manual (`pages.txt:12860-12960`):
  `?` (X'6F') → `>` and set MDT; `>` (X'6E') → `?` and clear MDT; space or null → set MDT and
  send AID `0x7e`; `&` → set MDT and send AID **`0x7d`** (Enter simulation, an optional
  implementation feature per the manual); **anything else, including a non-detectable field,
  rings the bell and sends nothing.**
- **Light pen must not be the plain left-click.** x3270 does not do that: it is a distinct
  action, and wc3270 gates it behind Alt unless `lightPenPrimary` is set
  (`wc3270/screen.c:2357`, `include/appres.h:203`). Plain click is wanted for cursor
  placement and text selection, both of which a Mac user will expect.
- **Dup and FieldMark remain genuinely unimplemented** in core.
