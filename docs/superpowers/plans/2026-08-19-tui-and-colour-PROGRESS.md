# TUI and Colour — Execution Progress

Live status for `2026-08-19-tui-and-colour.md`, executed subagent-driven on branch
**`tui-and-colour`** (branched from `main` at `b054045`). Update after each task.

## Status

| Task | State | Commits | Tests after |
|---|---|---|---|
| 1. Attribute type/value constants | **DONE** | `805c474`, `cc1f89d`, `71fdbdd` | 698 |
| 2. The 3279 palette | **DONE** | `965cbd4`, `5932ace` | 704 |
| 3. Per-cell storage in `Screen` | next | — | — |
| 4. SA running state in executor | | | |
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
