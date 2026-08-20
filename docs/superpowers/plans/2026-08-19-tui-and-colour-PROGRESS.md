# TUI and Colour — Execution Progress

Live status for `2026-08-19-tui-and-colour.md`, executed subagent-driven on branch
**`tui-and-colour`** (branched from `main` at `b054045`). Update after each task.

## Status

| Task | State | Commits | Tests after |
|---|---|---|---|
| 1. Attribute type/value constants | **DONE** | `805c474`, `cc1f89d`, `71fdbdd` | 698 |
| 2. The 3279 palette | **DONE** | `965cbd4`, `5932ace` | 704 |
| 3. Per-cell storage in `Screen` | **DONE** | `8058145`, `dd999f0`, `a6327bb` | 715 |
| 4. SA running state in executor | **DONE**, both reviews closed | `a456b06`, `4ea5c50`, `78c0dd4` | 751 |
| 5. `render.ts` resolution | | | |
| 6. TK5 fixture proof | | | |
| 7. Query Reply Color + Highlighting | | | |
| 8. `ScreenJson` resolved colour | | | |
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

## Reminders for the rest of the run

- **Task 14 needs both Hercules systems IPLed** (VM/370 on 3270, TK5 on 3271) and the
  user does that by hand. `ss`/`netstat` show nothing in this sandbox — probe with
  `/dev/tcp/127.0.0.1/PORT`.
- **The VM reconnect trap**: an account left logged on is reconnected, not refused,
  landing at `CP READ` where every command goes to CP (`?CP: ...`). Log off cleanly.
- Task 4 is the riskiest (SA running state, four reset rules, the composite rule).
- Task 15's mutation pass predicts which mutant most likely survives; do not skip it.
