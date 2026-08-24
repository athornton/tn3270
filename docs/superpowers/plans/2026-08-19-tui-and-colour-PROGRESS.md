# TUI and Colour — Execution Progress

Live status for `2026-08-19-tui-and-colour.md`, executed subagent-driven on branch
**`tui-and-colour`** (branched from `main` at `b054045`). Update after each task.

> **STOPPED AFTER TASK 8, 2026-08-20, on a spend limit — not a blocker.** Tasks 1-8 (the
> whole core half) are done, reviewed and green: **822 tests**, typecheck clean, working tree
> clean, `~/bin/check-spend` reading $1705.86 of a $1800 ceiling the user set. **Tasks 9-16
> are untouched and the plan for them is unamended** — resume at Task 9 (`packages/tui`
> skeleton). Nothing is half-finished: every task that was started is committed with both
> reviews closed.
>
> **Read this whole file before resuming.** It records 39 defects, 30 of them errors in the
> plan itself, and six recurring traps that will bite again. In particular: the plan's Task 9-13
> text has NOT had the scrutiny Tasks 1-8's had, so expect the same defect rate and verify its
> code against the sources rather than transcribing it.

## Status

| Task | State | Commits | Tests after |
|---|---|---|---|
| 1. Attribute type/value constants | **DONE** | `805c474`, `cc1f89d`, `71fdbdd` | 698 |
| 2. The 3279 palette | **DONE** | `965cbd4`, `5932ace` | 704 |
| 3. Per-cell storage in `Screen` | **DONE** | `8058145`, `dd999f0`, `a6327bb` | 715 |
| 4. SA running state in executor | **DONE**, both reviews closed | `a456b06`, `4ea5c50`, `78c0dd4` | 751 |
| 5. `render.ts` resolution | **DONE**, both reviews closed | `3a3531b`, `27e5310`, `52a19f7`, `4188b1e`, `6cefc9c` | 822 |
| 6. TK5 fixture proof | **DONE**, reviewed — the run's goal, reached | `cdc200c`, `7045b10` | 808 |
| 7. Query Reply Color + Highlighting | **DONE** | `c4708d1` | 816 |
| 8. `ScreenJson` resolved colour | **DONE** | `a79f4fd` | 821 |
| 9. `packages/tui` skeleton | | | |
| 10. Depth detection + quantisation | | | |
| 11. ANSI rendering + diffing | | | |
| 12. Keymap | | | |
| 13. App wiring + raw mode | | | |
| 14. Live verification (needs both hosts IPLed) | | | |
| 15. Mutation testing | | | |
| 16. Handoff update | | | |

Baseline at branch point: 695 tests, typecheck clean.

## Process that is working, keep doing it

Each task: implementer subagent → spec-compliance review → code-quality review → fix
loop → verify independently → next. **The reviews are earning their cost**: every task
so far has had real defects found after the implementer self-reviewed and reported DONE.

**Verify reviewer claims before acting on them.** Both review rounds so far were correct
on every checkable point, but they are checkable — line numbers, byte values, whether a
cited passage says what it is claimed to say — and checking takes a minute.

## Defects found so far, and where they came from

**Task 1 — four citation errors, all in MY plan, found by implementer + reviewer:**
- `pages.txt:2991` → the quoted sentence is at **2986**; and 2986 is the wrong passage
  anyway for "reset all types", which is at **3449-3456** ("All Character Attributes").
- `3270ds.h:240-250` excludes `XA_ALL` (RESET's x3270 name), which is at **229**.
- **`XAH.INTENSIFY` 0xF8 is ABSENT from the manual's Chapter 4 highlighting table**
  (`pages.txt:3487-3498`, five values only). It is confirmed only in Query Reply
  (Highlighting) at **10310-10325**. Now flagged in the code as a TRAP so a future
  verifier does not "correct" it away.
- Placement: the block belonged next to `XA_3270`, which documents the same Table 4-6.

**Task 2 — one real error of mine plus two test gaps:**
- **The plan claimed the RGB values "follow x3270's default 3279 rendering". FALSE** —
  x3270's real table is `rgbmap[16]` at `c3270/screen.c:213-229` and only 4 of 16
  matched. Ours are saturated primaries. **Kept ours deliberately**: with x3270's
  values, blue (`1e90ff`) and turquoise (`00ffff`) both quantise to ANSI 96, collapsing
  two of the seven base colours. Comment now states the provenance honestly.
- Two RGB pairs collided (`neutral-black`/`black`, `neutral-white`/`white`), losing
  information a host sent. Fixed: `F0`→`1a1a1a`, `F7`→`e0e0e0`; `F8`/`FF` stay pure.
- No test caught the three 16-entry structures drifting apart; one added.
- The "every entry has an RGB triple" test was vacuous (the `Rgb` tuple type already
  guarantees it) and was replaced with pairwise-distinctness, which is what would have
  caught the collisions.

**Task 3 — three more wrong citations in my plan, and one real test gap:**
- SF reset is at `pages.txt:2869-2870`, **not** 2874-2875 (which is SFE format text).
- EW/EWA reset is at `2990-2992`, **not** 2988-2991.
- The `session.ts` Clear call is at `350-351`, not 350-353.
- **`setChar`'s non-interference with extended attributes was untested.** Found by the
  spec reviewer doing real mutation testing, and I reproduced it: adding
  `this.clearExtended(addr)` to `setChar` left **all 59 tests passing**. That is the
  rule Task 4 depends on most — the executor calls `setChar` then `setExtended`, so a
  clear there would silently discard every SA colour and quietly send the TK5 fixture
  monochrome. Now pinned; re-running the same mutation gives 1 failure.

**A question worth having settled (raised by quality review, checked against the
manual):** storing `0` as the "unspecified" sentinel in `Uint8Array`s looks like it
conflates `XAH.DEFAULT` (0x00, a value a host CAN send) with "nothing set". It does —
and that is correct, because the manual says `X'00'` means "the same as the action for
the attribute value X'00' (the default action of the device)" (`pages.txt:10329-10331`).
The two states resolve identically, so collapsing them loses nothing.

**The most instructive defect so far, because of what it was:** the comment justifying
that sentinel argued from "SA type 0x00 clears back to unspecified" — i.e. it justified
a claim about `XAH.DEFAULT` (0x00 as a highlighting VALUE) by appealing to `XA.RESET`
(0x00 as an attribute TYPE). **That is precisely the TYPE-vs-VALUE conflation
`constants.ts` was written to warn against**, reproduced inside the change that added the
warning's neighbour. The behaviour was correct throughout; only the argument was wrong.
Fixed in `a6327bb`, which now cites the real reason and explicitly warns the next reader
off the `XA.RESET` route. Worth remembering that a comment can be confidently wrong in a
file whose whole purpose is preventing that error.

**Task 4 — the richest task for defects, and FOUR of them were mine.** This is the one
where the plan was actively dangerous, not just imprecise. All verified from the manual and
x3270 before acceptance, and each reproduced.

1. **`applySa` was a merge with an early return. Silent corruption.** Because Task 3's
   `setExtended` merges (rightly — the composite rule needs it), a cell overwritten by a
   later record with no SA in effect **kept the previous record's colour**. The manual:
   "whenever a character is overwritten by a new character (or cleared or erased), the old
   character attribute is overwritten" (`pages.txt:3388-3391`). Must be clear-then-set, an
   assignment. x3270 stamps unconditionally (`ctlr.c:2141-2143`) via `ctlr_add_fg`, which
   assigns (`:2865`). **I reproduced this: reverting to my version fails exactly 2 tests.**
   Note the plan's own reset-per-write test could not catch it — it wrote the second record
   to a *different address*, so it never exercised an overwrite.
2. **EUA and PT must CLEAR attributes, not merely "not stamp"** as the plan said
   (`pages.txt:3165-3166` and `:3090-3091`, PT gated on `wroteSinceOrder` because "when PT
   immediately follows a command, order, or order sequence, the buffer is not modified").
3. **THE EIGHTH RULE: extended FIELD attributes were never stored at all.** The manual
   requires a two-level lookup — a character whose own attribute is default "is displayed
   using the value of that property established for the field in the extended field
   attribute" (`pages.txt:3383-3387`). Demonstrated: SFE `fg=yellow` + 3 chars, then a
   second record overwrites the middle one → colourless cell between two yellow neighbours,
   inside a field still defined yellow, unrecoverable. Fix follows x3270: store on the
   **FA cell** (`ctlr.c:1886-1889`) and fall back per cell (`fprint_screen.c:754-758`).
   **This makes Task 5 four-level, not three** — cell → field → base map → mode3279.
4. **An SFE pair of type X'00' is NOT a reset — the plan said it was.** "The attribute type
   X'00' can appear only in the SA order" (`pages.txt:3456`); in SFE it is invalid and
   "rejected" (`:2897-2898`), i.e. ignored. x3270's SFE arm advances past
   (`ctlr.c:1869-1871`) where its SA arm zeroes everything (`:1915-1921`). As shipped it
   would have discarded a colour the host set in the same order.

5. **SFE seeding leaked across field boundaries — a real correctness bug, found by quality
   review and reproduced.** An `SBA` can move the write address into a *different,
   existing* field without passing an SF/SFE, and the SFE-seeded state followed the
   address: a plain field with no EFA got the previous field's yellow stamped onto it.
   Root cause named exactly: **seeding a FIELD-scoped attribute into a CHARACTER-scoped
   running variable gives it the wrong lifetime.** Fix — drop the seeding entirely and rely
   on the FA-cell storage, which is what x3270 does (`grep default_(fg|bg|gr)` over its SFE
   region `ctlr.c:1816-1894` returns **zero** matches).
6. **AND FIXING THAT EXPOSED THE SAME CONFUSION INVERTED: a plain SF must not reset the
   running SA state, and the plan said it should.** `pages.txt:2869-2870` is purely
   field-level; the SA reset list is **closed** — "These **four** actions…"
   (`:2977-2982`) — and SF is not among them; x3270's `ORDER_SF` clears the FA cell
   (`ctlr.c:1486-1487`) and never touches `default_*` (every assignment in the file:
   `:410`, `:1414`, `:1905`, `:1917`, `:2711` — no SF, no SFE). So a field-scoped event was
   destroying character-scoped state.

**The lesson from 5 and 6 together, which is the real one:** field attributes and character
attributes are **separate planes with separate lifetimes**, and they get conflated because
the wire encoding shares the `0x28` family. Defect 5 gave a field attribute a character
lifetime; defect 6 gave a field event authority over character state. **Neither direction
was caught by any test until each was specifically probed** — and defect 6 only surfaced
because fixing 5 made a mutation stop failing, which the implementer investigated instead of
dismissing as a thin test.

Plus two untested-invariant gaps: EUA's protected-cell attribute preservation (mutation
passed 740/740 before a test was added), and a predicate duplicating a switch, now both
derived from one `SA_HANDLERS` table — keyed by `XA`'s literal union, so a typo'd entry is
a `TS2353` error — with a test that compares screen effect to counter across ten types.

**One correction to a reviewer, worth noting since the pattern has been the reverse:** the
quality review claimed tightening `SA_HANDLERS`'s key type would leave indexing unaffected.
It does not — a wire byte is `number` and a literal-keyed `Record` rejects it (`TS7053`), so
one widening cast is unavoidable and is now confined to a single shared accessor. Reviewers
are checkable too.

**My citation `pages.txt:3388-3392` was also wrong** (over-included "If a character is
moved"); the quote ends mid-3391, so `3388-3391` is exact. Corrected across all three docs.

**MEASURED LIMIT ON OUR ONE FIXTURE, and it explains the whole defect cluster: the TK5
trace has 344 plain SF orders, 113 SA orders and ZERO SFE orders.** So the field level is
unexercised by the only real host traffic we regression-test against. Task 6 can prove the
character level and cannot prove the field level; it now says so. Real coverage needs a
trace from a host that sends SFE. [[check-what-a-comparison-covers]].

**A genuinely useful find, now in the spec:** the OCR-damaged colour Table 4-7 is
**reprinted UNDAMAGED at `pages.txt:9244-9260`** (manual p. 6-37, Chapter 6's Query
Reply (Color) section) — `Neutral X'F7'`, `Black X'F8'`, `Purple X'FB'` all correct.
Prefer it for the codes. Caveat: same OCR pipeline over the same table, so it
corroborates rather than independently confirms.

## Verified downstream, so later tasks can rely on it

Task 10's quantisation numbers were **re-derived against the committed palette after
the RGB change** and still hold: green cube index **46**, 16-colour SGR **92/94/91**
for green/blue/red, 8-colour **32** for green, white cube **231**. All seven base
colours remain distinct at 16 **and** 256. The four changed entries are not among the
seven, which is why the numbers survived — but re-derive rather than trust this if
`PALETTE_3279` changes again.

**Task 5 — three plan defects, and one of them I repeated in my own instruction to the
implementer.** All corrected against the sources, which the implementer checked rather than
taking my word for.

1. **`0xF7` must NOT be remapped to white.** The plan's drafted `resolve()` had
   `cell.fg === 0xf7 ? Colour.WHITE : cell.fg`, **and I repeated that instruction verbatim
   when dispatching the task.** Both wrong. `0xF7` is Neutral — a distinct architected
   identification listed separately from White `0xFF` in Table 4-7, given its own RGB in
   `palette.ts` deliberately — and the manual routes it through Query Reply (Color)
   (`pages.txt:3544-3550`), whose F7 entry is an identity pair in our own reply, so F7
   resolves to F7. x3270 keeps `HOST_COLOR_NEUTRAL_WHITE` (7) and `HOST_COLOR_WHITE` (15) as
   separate slots and special-cases F7 nowhere. Remapping collapses two colours a host chose
   between.
2. **The field fallback covers background and highlighting too, not just foreground.** The
   manual says "any character property (color, highlighting, or character set)", and x3270
   mirrors its fg two-step for bg (`c3270/screen.c:1153-1158`) and gr (`:1166-1171`). A
   foreground-only fallback leaves an SFE's reverse-video field flat.
3. **`mode3279 === false` gates colour but NOT highlighting.** The plan gated only fg,
   letting a background through on monochrome hardware; and highlighting must stay ungated
   because a 3278 blinks and reverses — x3270 computes `gr` after its colour branch closes.

Also `pages.txt:3546-3548` → **`3544-3546`** for the `0x00` rule, and the drafted `Int16Array`
for field addresses would have been a latent bug: an address can exceed 32767 on a large
alternate size. The implementer used `Int32Array`.

## THE GOAL OF THIS RUN IS REACHED — real host colour now reaches the screen

**Task 6, verified independently.** Replaying the converted TK5 trace:

- **28 fields, 532 of 1920 cells carrying a character-level `fg`** (it was 0 before this work)
- resolving to **white 793, blue 618, red 329, neutral-white 144, yellow 36**
- **neutral-white and yellow cannot come from the base-attribute map** (green/red/blue/white
  only), so they are the specific evidence that SA orders reached the screen rather than
  merely arriving on the wire

**But the fixture was not replayable as committed, and that is why the gap survived so long.**
It was raw CLI output with every hex line prefixed `data: `, so `parseTrace`'s regex matched
**zero** lines: replaying it gave 0 fields and 1920 uniformly green cells. Nothing in the
repository exercised SA colour end to end — the three fixtures that *did* replay contain no
character-level colour at all, all of theirs coming from the base map. Converting it is the
substance of Task 6.

**Two things Task 6 found that I had not flagged:**

1. **A grep that can never come back clean is not a check.** The original fixture header quoted
   *both* the plaintext password and its EBCDIC bytes inside its own redaction note, so
   `grep CUL8TR` on the committed file was guaranteed to fire. Header reworded so both greps
   are real gates. (The implementer reintroduced the literal in its own explanatory note and
   caught it on re-grep.) Verified myself: 0 hits for `CUL8TR` and 0 for `c3 e4 d3 f8 e3 d9`,
   in the fixture **and** in the generated golden — the golden was a redaction risk nobody had
   considered, since MVS 3.8j echoes passwords unmasked.
2. **`count-orders.mjs` could not read the canonical form** — its regex hard-required the
   `data: ` prefix, so on the converted file it reported `SA=0`, which is indistinguishable
   from "the parser stopped recognising SA". The plan told the implementer to trust the script
   over the plan, but that cross-check was impossible to perform. Prefix now optional; the
   **script** reports 113/101/12 on both forms.

   **A correction to my own commit message for `cdc200c`,** caught by review: it claimed the
   script *and the test helper* agree on both forms. Not true — `countDeferredOrders`
   (`helpers/trace.ts:85`) has no optional prefix and returns **all zeros** on the raw form.
   **That narrowness is right and must not be "fixed":** the helper resolves names only under
   `tracesDir`, so a raw file cannot arrive in normal use, and returning zeros is exactly what
   makes two of the TK5 count tests fail as negative controls if the fixture ever reverts to
   unconverted form. Widening the regex would silently turn those tests green against a blank
   screen. Now stated in the helper's own comment as a do-not-change note.

**Chosen deliberately:** the fixture went into `fixtures/traces/` *with* a generated golden, so
`golden.test.ts`'s "every fixture renders something" case guards it — that case is a standing
check against exactly the blank-screen failure this task existed to fix, and it does fail
against the unconverted file.

**And the negative control caught the storage-sentinel trap a fifth time:** the
zero-SFE-assertion test initially **passed against the unconverted fixture**, because every one
of its assertions is "expect zero/absent" and an empty parse satisfies all of them for free —
including `for (const f of [])`. Anchored to `parsed === 21` and `sa === 113` first.

**Task 7 — a NEW failure mode: adding a capability silently hollowed out three tests.**
Two wrong page numbers in my plan (Color is p. **6-36** not 6-38; Highlighting p. **6-65**
not 6-53) and an expected length wrong twice over (it counted header bytes while indexing
from the body, and 15 identity pairs plus a default is 32 payload bytes, not 30). But the
interesting part is what advertising `0x86`/`0x87` did to the existing suite, because **none
of it would have failed**:

- Three tests used `0x86`/`0x87` as standing examples of *"QCODEs we do not support"*. One
  appended a synthetic capability with `qcode: 0x86` — which would have put a **second**
  `0x86` in a list that already contained one, **and still passed**. Now `0x83`.
- One sliced Summary as `subarray(5, 5 + 4)`, a hardcoded body length that silently cut
  `0x9F` off the end once the list grew. It also never asserted `0x9F` was absent from the
  reply, which was its actual claim.
- Four tests indexed units **positionally**, so inserting before Implicit Partition made
  index 2 start reading the Color unit. All now look up by QCODE.

**The lesson generalises past this project:** when a test uses a real protocol value as a
stand-in for "unsupported", implementing that value converts the test into something else
without breaking it. Prefer a value asserted-unsupported in exactly one place, so adding it
later fails *there*, with a reason.

Verified myself: five units now go out as `0x80(L=9) 0x81(L=23) 0x86(L=38) 0x87(L=15)
0xa6(L=17)`, both Table 6-1 rows are OCR-clean and say `Yes ... Yes Yes`, and **the fixture
still reports 113/101/12** — advertising colour did not change what TK5 sends, which is the
invariant that matters.

One deliberate divergence, well handled: our Color unit is **not** byte-identical to the
x3270 capture, differing in exactly its fifteen colour-identifier bytes, because that capture
was taken with x3270 in monochrome mode. Rather than skipping the unit in the comparison, the
test exempts those bytes **by name and pins both sides**, so the other 23 stay pinned and the
divergence cannot silently widen.

## THE CHAIN IS PROVEN END TO END THROUGH THE OPERATOR-FACING SURFACE

**Task 8 closed the agreed scope (Tasks 5-8).** `ScreenJson` now emits `resolved` alongside the
raw `cells`, and driving the real CLI's `Replay()` against the committed TK5 fixture — no host
needed — gives **exactly** the numbers the core tests assert:

```
fields: 28   resolved length: 1920
WHITE 793   BLUE 618   RED 329   NEUTRAL-WHITE 144   YELLOW 36
```

So the whole path works: wire bytes → telnet → parse → execute (SA/SFE, eight rules) → per-cell
storage → four-level resolution → the operator-facing CLI. Colour can now be inspected on a live
host **without simultaneously trusting a brand-new terminal renderer**, which is exactly why this
task came before the TUI rather than after it.

Both keys are emitted deliberately: a conformance comparison needs the raw bytes, a human
debugging colour needs the resolution, and dropping either makes one of those impossible.

## A RECURRING TRAP, now seen three times: the storage sentinel hides the rule

`Screen` stores "unspecified" as `0`, so `cellAt` omits the property when the byte is zero.
That is correct and deliberate — but it means **`0x00` as a legitimate protocol VALUE cannot
be represented in a `Screen`**, and therefore cannot reach any consumer through the normal
path. Three consequences have now bitten:

1. **Task 3**: the sentinel comment justified itself with `XA.RESET` (a TYPE) when the claim
   was about `XAH.DEFAULT` (a VALUE). Right behaviour, wrong argument.
2. **Task 5**: three tests named the `0x00`-means-device-default rule and **none of them
   reached it.** Both routes they used — `setExtended({fg: 0x00})` and a real SA order with
   value `0x00` — collapse to *absent* before resolution sees them. I reproduced the
   consequence: making `0x00` resolve to black, the exact error the manual forbids, left all
   49 tests green. An elaborate palette-stub test written to defend that very line passed
   with the line deleted.
3. **The general shape**: a test that drives a pure function *through the storage layer* can
   only exercise states the storage layer can represent. Where a rule concerns a state
   storage collapses, the test must **hand the function a value directly** — for `resolve`,
   a hand-built snapshot, which is a legitimate input to an exported pure function.

**Practical rule for the remaining tasks:** when a test names a specific protocol value, check
that the value actually arrives. Instrumenting the branch (a `console.log` and a test run) takes
a minute and is the only way to tell "asserted" from "pinned". Both Task 5 gaps were found this
way, not by reading. Verified closed: the same `0x00`→black mutation that left **49 tests green**
now produces **5 failures**.

**A FOURTH instance of the same shape, worth knowing if any test ever mocks a module here:**
that palette-stub test was vacuous for a *second, independent* reason — `vi.doMock` alone never
reached `render.ts`, because it is statically imported at the top of the test file and therefore
already cached against the real palette. Re-importing returned the **identical module object**
(`a.resolve === resolve` → `true`). **`vi.resetModules()` must precede the re-import.** So a
test can be doubly vacuous, and each guard assertion it now carries corresponds to a way it has
already failed to test anything.

**A tooling hazard from the same session, flagged because it silently destroys work:** using
`git checkout --` to revert a mutation **discards uncommitted implementation fixes** made
earlier in the same sweep. Restore from a pristine copy (`cp`) instead, and verify with `diff`.

**A SECOND, worse one — concurrency. Do not run two agents that both touch the working tree.**
Task 8's implementer ran `git stash` (to A/B a test flake) while the Task 5 agent had
uncommitted edits in flight, and the stash swept up **both** agents' work. It recovered
correctly — restored only its own two files with `git checkout stash@{0} -- <path>`, dropped
the stash, and left Task 5's files untouched — and I verified afterwards that the stash list is
empty, Task 5's WIP is intact, and the **committed** state at HEAD is green (56/56 in a clean
detached worktree). But that was luck plus a careful agent, not a safe design.

**Rules going forward:** only ever one agent with write access to the tree at a time. Reviews
that mutate code must run alone. Read-only reviews can overlap with an implementer, but must be
told to review a **commit** (`git show <sha>`) rather than the working tree. And **never
`git stash`** in a shared tree — it is repo-global, so it cannot be scoped to your own files.
A transient full-suite failure while another agent is mid-edit is expected and is not a
regression; verify HEAD in a detached worktree before believing otherwise.

## Task 5's final round, and a third pass on one comment

`4188b1e` unified the three attribute fall-throughs behind a `usableHighlight` mirroring
`usableColour`, after review found `gr` gated level 1 on *non-zero* where fg/bg gate it on
*renderable*. I reproduced the consequence: a cell carrying a garbage `gr` of `0x99`
**suppressed its field's highlighting entirely**, while a garbage `fg` fell through to the
field's colour — same malformed host byte, two policies, one property apart. Also closed a
gap where **swapping background's levels 1 and 2 left all 56 tests green** (verified).

**A subtlety in that fix worth keeping:** `HIGHLIGHTS` holds **five** of the six architected
values, not all six. `X'00'` is excluded so it falls through, but **`X'F0'` Normal is
included** — "Normal (as determined by the 3270 field attribute)" is a *positive* instruction
to show no extended highlighting, so a character set to Normal must **override** a
reverse-video field rather than inherit from it. That F0-vs-00 distinction is why it is a set
rather than a range check.

**And a caution about masking:** x3270 stores `gr` unchecked because its SA path already did
`*cp & 0x0f` (`ctlr.c:1785`) for its compressed bit field — but that mask turns `0x99` into
blink|intensify, **two highlights at once**, which the architecture forbids "on an exclusive
basis" (`pages.txt:10326-10328`). So masking is not a safe shortcut for us; we keep the
architected value verbatim and check membership.

**Third pass on one comment, which is its own lesson.** The `Int16Array` justification was
wrong; the correction replaced it with a *different* wrong fact (43×132 as "the largest
architected geometry"); the passage cited actually says a 3180 does 43 rows **or** 132 columns
"but not concurrently", so the largest architected model is 27×132 = 3564. `6cefc9c` fixes it.
**A correction can be as wrong as what it corrects** — verify the replacement fact, not just
the fact being replaced.

## Reminders for the rest of the run

- **Task 14 needs both Hercules systems IPLed** (VM/370 on 3270, TK5 on 3271) and the
  user does that by hand. `ss`/`netstat` show nothing in this sandbox — probe with
  `/dev/tcp/127.0.0.1/PORT`.
- **The VM reconnect trap**: an account left logged on is reconnected, not refused,
  landing at `CP READ` where every command goes to CP (`?CP: ...`). Log off cleanly.
- Task 4 is the riskiest (SA running state, four reset rules, the composite rule).
- Task 15's mutation pass predicts which mutant most likely survives; do not skip it.

---

# Tasks 9-13, 15, 16 — the TUI, 2026-08-24

`909` tests in 34 files, typecheck and build clean. **Task 14 is the only task in
this plan not done**, because both Hercules systems were down and the user IPLs
them by hand. Everything below was found by measuring, and each item cost real
time, so it is recorded rather than summarised.

## THE PLAN'S OWN NUMBERS WERE RIGHT TWICE AND WRONG THREE TIMES

Task 10 asked for the `tput`-versus-Node measurement to be reproduced *before*
implementing, which was the right instruction. `tput` matched exactly
(256/256/16777216/8/-1). **Node's column did not**: `getColorDepth` returns BITS
— documented as 1/4/8/24, confirmed at both ends here (`TERM=dumb` → 1,
`COLORTERM=truecolor` → 24) — so the real values are `8/4/4/4/4`, not the plan's
`8/16/16/16/16`. Four of the five rows had been transcribed as colour COUNTS while
the first was left as raw bits, mixing units inside one column. The conclusion
survives and gets stronger: `tput` is right five times out of five,
`getColorDepth` once.

Every quantisation number was re-derived from the committed `PALETTE_3279` as the
plan asked, since four palette entries changed after those numbers were written.
All of them held.

**The keymap correction is the one a user would have felt: the arrow keys and Home
have TWO encodings each, and terminfo reports the one the plan did not.**
`tput kcuu1` is `\x1bOA` and `khome` is `\x1bOH`, where the plan's tests used
`\x1b[A` and `\x1b[H`. Both are real — xterm sends CSI in normal cursor mode and
SS3 once DECCKM is set, and `smkx` is exactly `\x1b[?1h\x1b=`, so terminfo
documents the application-mode form because it assumes `smkx` was sent. Any layer
(us, tmux, screen) can flip it, so binding one encoding loses the arrow keys
outright on some terminals. Both are bound and both are tested. The function keys
needed no correction, including the irregularity: F7-F11 are `18/19/20/21/23~`,
with **no `22~`**.

## A REGEX THAT COULD NOT MATCH, AND THE VACUOUS TEST NEXT TO IT

Task 11's two colour tests shared one mistake with two faces. A cell emits
foreground and background in ONE sequence — `\x1b[38;5;46;48;5;59m` — so the
foreground parameter is never followed by `m`, and the plan's `/\x1b\[38;5;\d+m/`
matches nothing at all.

One test failed honestly. **The other counted matches of the same impossible
regex, got zero, and passed.** It is the test named "does not repeat an identical
SGR for adjacent cells", and it was verified vacuous by mutation: an
implementation emitting a fresh SGR for EVERY cell — precisely the defect it
names — passed it. Both now match the parameter within the list, and the count is
**exactly one** rather than "at most one per row", because an upper bound would
readmit that same mutant if the regex were ever loosened again.

**This is the fifth instance of the project's recurring shape** (see the storage
sentinel section above): a test that names a rule it never reaches. The tell is
always the same — the assertion passes when the behaviour is deleted.

## THE STATUS ROW NUMBER WAS UNPINNED, AND THAT IS A VISIBLE BUG

Mutation found it: moving the OIA from `rows + 1` to `rows + 2` left all eleven
other render tests green. It is not cosmetic. `tooSmall` reserves exactly ONE
extra row, so the status line would be drawn off the bottom of a terminal the
renderer had just declared large enough. The row number and `tooSmall`'s allowance
are **one decision** and are now pinned together at three geometries.

## A DROPPED KEYSTROKE IN THE PLAN'S `pump()`

The plan called `lookup()` on the WHOLE buffer and discarded one byte whenever it
returned null. One `read` carries several keystrokes, so a buffer of `A\x1b[A` is
ordinary — type fast, or press a key while an arrow is in flight. `lookup("A\x1b[A")`
is null (not a sequence, not all printable), **so the loop shifted the `A` away**:
silent, and likelier the faster the user types. Confirmed by restoring the plan's
version under the new tests, which fail with `expected ' ' to be 'A'`.

`pump()` now matches the FRONT of the buffer, preferring the longest action, and
discards an impossible sequence WHOLE — leaving the `[` of a broken `\x1b[?`
behind would type a literal bracket into the user's field.

## RAW MODE: WHY THE STREAMS ARE INJECTED

`stdin`/`stdout`/`host` are narrow interfaces rather than `process` globals, and
that is what makes "raw mode is restored on every exit path" testable at all. All
six paths are pinned **separately**, because registering five of six is the likely
defect and using the program normally would never reveal it. Eight mutants die,
including a forgotten `SIGHUP`, a non-idempotent `restore`, and the geometry check
moved to after raw mode is entered.

`quitting` was the field the plan said to use or delete. It is used: `host.exit()`
does not stop the current turn, so an already-queued `screen` event can otherwise
reach `draw()` after `restore()` and paint 3270 cells over the user's shell prompt.

## TASK 15: THE PREDICTED SURVIVOR IS AN EQUIVALENT MUTANT

The plan predicted mutation 11 (`applySa` before `setChar`) would survive, and
prescribed a fix: write a cell twice with different SA state between the writes.
**It survives, and that test cannot close it.** `setChar` writes `chars[]` and the
field-attribute marker and "deliberately does NOT touch fgs/bgs/grs"
(`screen.ts:228-231`); `applySa` writes only those three planes. Disjoint state,
so the two statements commute and **no input can distinguish the orderings**.

Verified rather than argued: the prescribed test was written and it passes with
the pristine code AND with the lines swapped, 38 for 38 both ways. Recording it as
having closed the hole would have been the sixth instance of the trap. It is kept,
relabelled for what it genuinely pins (the second write of an address wins,
character and colour together — previously unpinned), with the equivalence
recorded in the test so nobody re-derives it. A second new test pins the
falsifiable part: `applySa` clears before it sets, so making it additive fails 3
tests where the ordering swap fails none.

**Mutation 12 was obsolete** — it wanted `delete sa.*` removed from the `'sf'`
case, and earlier work had already deliberately stopped SF touching the running
state. Twelve of thirteen killed, one obsolete, one equivalent.

## COMMENTS OUTLIVE THE CODE THEY DESCRIBE — THIRD TIME THIS STAGE

`resetSa` claimed to be "Shared by the SA X'00' handler and the plain-SF reset".
It has exactly one caller. The claim was true when written and became false when
the SF reset was removed. Same shape as the `Int16Array` justification and the
43×132 geometry claim. **When you remove a caller, grep for prose that names it.**

## TWO BUGS IN MY OWN TEST HARNESS, BOTH BLAMING THE CLIENT FIRST

`pty-smoke.py` reported a broken input path twice, and was wrong twice.

1. It typed as soon as the alternate screen appeared — which is *before* the
   host's first write, when the keyboard is correctly locked with `X Wait`
   (`AwaitingFirstWrite`). Every keystroke was properly refused.
2. It omitted the `IC` order, so the cursor sat at address 0 inside a PROTECTED
   field and typing was again correctly refused.

Both times the client was right and the test was early or malformed. A harness
that reports a failure has to be shown capable of reporting success first — the
same lesson as the trace probe that lacked `Trace(on)`.

## ONE MORE UNENFORCEABLE GUARD, ANNOTATED RATHER THAN PAPERED OVER

Two clauses in this work cannot be pinned by any test, and both are annotated in
place saying so, so that nobody later writes a test claiming to cover them:

- `colours.ts`: the `depth < 16777216` clause in the COLORTERM branch is redundant,
  because the only assignment is to the maximum. Deleting it leaves everything
  green. It stays as a guard for a future edit mapping some COLORTERM value to a
  LOWER depth. What IS testable, and now tested, is that a present-but-smaller
  COLORTERM (`256color`, `8`) never lowers a higher terminfo answer.
- `keymap.ts`: checking an exact match before a prefix cannot be pinned, because
  no key in the table is a proper prefix of another. It becomes load-bearing the
  moment a terminal needs such a key.

## Where to resume

**Task 14, and it needs the user to IPL both Hercules systems** (VM/370 on 3270,
TK5 on 3271). `ss`/`netstat` show nothing in this sandbox — probe with
`/dev/tcp/127.0.0.1/PORT`. Read the VM reconnect trap in `docs/HANDOFF.md` first:
an account left logged on is reconnected, not refused, landing at `CP READ` where
every command goes to CP. Then `docs/live-testing.md` gains a *TUI and colour
results* section, and **record what did not work too**.

## A GAP THE PLAN DID NOT COVER: SIGWINCH IS NOT HANDLED

Found while checking for dead API at the end of the run, and left UNFIXED
deliberately, because it needs a decision rather than a patch.

`TerminalRenderer.invalidate()` is documented "Force the next paint to redraw
everything, **e.g. after a terminal resize**" and is called exactly once, in
`App.start()`. **Nothing listens for `SIGWINCH`.** So resizing the window leaves
the renderer's `previous` array describing the old geometry: the screen stays
stale until the host happens to write again, and every cursor-position escape is
computed from `this.cols`, which never changes.

Note this is NOT the 3270 mid-session resize already recorded as deferred in
`HANDOFF.md` — that is a protocol question about alternate screen sizes. This is
purely about the terminal window, and the repaint half is already built.

**It is not a one-line fix, which is why it is a note and not a commit.** Three
things need deciding together:

1. On growth, `invalidate()` and repaint is right and easy.
2. On shrink below `screen.rows + 1` or `screen.cols`, `start()`'s rule is to
   REFUSE — but refusing mid-session cannot mean throwing, because the session is
   live and the host is mid-conversation. Probably: stop painting, show a
   "terminal too small" message, and resume when it grows back. That is new
   behaviour with its own tests, not a wiring change.
3. `App` currently takes `stdout.rows/columns` once, in `start()`. It would need
   to re-read them per resize, which means the geometry stops being effectively
   readonly and `tooSmall` gets a second caller with different consequences.

The `pty-smoke.py` harness already sets the window size with `TIOCSWINSZ`, so it
is the natural place to test this: resize the pty mid-session and assert a full
repaint arrives.
