# The x3270 parity checklist, the store gate — design

Date: 2026-11-17. Status: approved in conversation, section by section.

This replaces an earlier version of this file (`729bdaf`), written in a divergent resumed copy of
the same session. The user chose this design over it (2026-11-17).

## Problem

Nothing goes into the Mac App Store or the Microsoft Store before feature parity with x3270
(the user, 2026-11-11; HANDOFF, *the three-piece store plan*, piece 2). "Parity" has no
definition yet, so there is no gate to pass. This spec defines it: a checklist, the rules for
its rows, a test that keeps it honest, and a gate verdict. It does **not** build any missing
feature. Each gap gets its own spec → plan → build afterwards.

## Decisions (the user, 2026-11-16/17)

1. **Comparator: x3270, the X11 application, as of suite3270 4.5** (`~/src/suite3270-4.5`, the
   tree every other x3270 citation in this project uses). **Only the GUI column gates.** The
   browser, TUI and CLI columns are recorded for information; they never gate.
2. **The user can hold the gate** for any row, gating or not, with a `wanted` override (below).
3. **A row is one user-facing feature.** Each row lists the x3270 names it covers, and a test
   checks that every name in an extracted inventory lands in exactly one row or in the
   not-applicable list.
4. **`ours` needs a citation**: a test that drives the feature, or a recorded live witness. Code
   that exists with nothing proving it is `unverified`, which blocks like `missing`.
5. **Approach: a hand-edited Markdown checklist, a committed inventory, and a vitest test**
   (approach 1 of 3; YAML-generated Markdown and an unenforced script were rejected).

## 1. Files

- `scripts/x3270-inventory.mjs` (with `x3270-inventory.d.mts`, as for the other scripts) takes
  the x3270 tree's path as an argument and writes `docs/parity/x3270-inventory.txt`. It reads the
  tree as text only and never builds or runs it. It is run by hand, only when the x3270 version is
  moved; the output is committed, and CI never needs the tree.
- `docs/parity/x3270-checklist.md`: the checklist itself, edited by hand.
- `scripts/parity.mjs` (with `parity.d.mts`): the parser, and a `--gate` mode that prints the
  verdict.
- `packages/core/test/parity.test.ts`: the enforcement, beside `releaseNotes.test.ts`, which
  already tests a script in `scripts/`. It runs in every CI run.

### The inventory

One name per line, `kind:name`, sorted, so identical input gives identical bytes. The first line
records the source version (from the tree's `Common/version.txt`). Kinds:

- `action:` — every `An*` entry in an `action_table_t` array in a source file the x3270 binary
  links (`Common/`, `x3270/`). A first grep found 108.
- `resource:` — every `Res*` resource those sources use. A first grep found 190.
- `option:` — every command-line option in x3270's option table.
- `menu:` — every menu item and toggle in `x3270/menubar.c`, as `menu:<menu>/<item>`.

The counts are estimates from a first grep (2026-11-16). The extractor's output is the
measurement, and the plan must not hard-code them. **`x3270.man` is the cross-check:** after a
run, every action, option and resource the man page documents must be in the inventory. A name
it misses means the extractor is wrong. Fix the extractor; never hand-add the name to the file.

## 2. The checklist

### One row

| Feature | x3270 names | GUI | Browser | TUI | CLI | Evidence | Gate | Override |
|---|---|---|---|---|---|---|---|---|
| Crosshair cursor | `action:ToggleCrosshair` … | missing | missing | – | skipped | | yes | |

(Illustrative, not a finding.)

- **x3270 names**: the inventory names this row covers, each in backticks.
- **Front-end cells**: one status each (below), or `–` where the feature cannot apply to that
  front end.
- **Evidence**: repo-relative paths, separated by `<br>`: a test file, or
  `docs/live-testing.md#<anchor>`. Required for `ours` and `unverified`.
- **Gate**: `yes` or `no`. `yes` by default for anything a GUI user would reach for; `no` for
  what only matters to someone scripting x3270, which the CLI column already records.
- **Override**: empty, `waived <XX> YYYY-MM-DD` or `wanted <XX> YYYY-MM-DD`, where `<XX>` is the
  user's initials (2–3 capitals). Only the user writes an override.
- **Skipped reasons** go in a footnote under the area's table, keyed by feature name.

### Statuses

| status | meaning | requires |
|---|---|---|
| `ours` | we have it, and it is proven | evidence |
| `unverified` | code exists, nothing proves it | evidence (the code path) |
| `missing` | we do not have it | — |
| `skipped` | deliberately not done | footnote reason |

**Every `ours` claim is checked by opening the cited test** and confirming it drives *this*
feature, not something nearby. The parser can only confirm that a path exists. If relevance
cannot be confirmed, the row is `unverified`.

### Overrides

- **waived**: a gating row the user does not need for this release.
- **wanted**: a non-gating row, or any row, that the user wants before the release. It holds
  the gate until the row's GUI cell is `ours`.

### Areas, one table each, in this order

1. connection and TLS
2. telnet and TN3270E negotiation
3. screen models and oversize
4. display: fonts, colours, cursor, crosshair, status line
5. keyboard and keymaps
6. keypad
7. mouse: selection, cursor placement, light pen
8. copy and paste
9. code pages and DBCS
10. file transfer
11. printing: screen print, printer sessions (pr3287)
12. scripting and macros: actions, `-script`, the HTTP and socket interfaces
13. tracing
14. preferences and session files (`.x3270pro`, saved sessions)
15. menus and dialogs
16. **not applicable**: X11-only names (Xt resources, `-geometry`, `-iconic`, bitmap font paths
    and the like), as a list, each with a one-line reason, so the inventory still closes.

### The gate opens when

- every `Gate: yes` row's GUI cell is `ours` or `skipped`, or the row is `waived`; and
- every `wanted` row's GUI cell is `ours`.

## 3. The test and the gate command

`parity.test.ts` asserts:

1. Every inventory name appears in exactly one row or the not-applicable list: no orphans, no
   double claims, and no row names something absent from the inventory.
2. Every front-end cell holds a valid status or `–`.
3. Every `ours` or `unverified` row has evidence, every path exists in the repo, and every
   `#anchor` matches a heading in the cited file.
4. Every row with a `skipped` cell has a footnote with that feature name.
5. Every override matches `^(waived|wanted) [A-Z]{2,3} \d{4}-\d{2}-\d{2}$`.
6. `parity.mjs --gate` on a small fixture checklist prints a golden verdict: `gate: open`, or
   `gate: closed` and one line per blocking row, with the feature first and the reason (`missing`,
   `unverified`, `wanted`) after it.

Each assertion gets a mutation check, recorded in the plan with its FAIL line: break the fixture,
watch the test fail, revert.

**Not mechanically provable:** that a cited test exercises the feature through the GUI. That is
for review (section 2).

**The verdict does not gate CI or releases.** CI prints it in the job summary. GitHub and npm
releases ship as now. Piece 3 (submission) decides how the store upload uses it.

## 4. Filling it, and what follows

**In this spec's plan**, three steps, each a commit:

1. the extractor and the committed inventory for 4.5, cross-checked against `x3270.man`;
2. the parser, the test and its fixtures, with the mutation checks;
3. the first complete checklist, area by area: each row cites x3270's behaviour by `file:line` in
   suite3270 4.5 and our status by its evidence. Unsure means `missing` or `unverified`, never
   `ours`. One writer edits the checklist; any sweep agents return proposals only.

Then **the user reviews** it, sets `wanted` and `waived`, and `--gate` gives the first real
verdict. Its blocking rows are the store backlog.

**Afterwards (separate work, recorded so it is not lost):** each blocking row, or cluster of
rows, gets its own spec in the order the user sets. README *Remaining* 15-22 is rewritten to
point at checklist rows, so there is one backlog. HANDOFF's store plan points at the checklist.

## Out of scope

Building any feature; the store submission (piece 3); any change to `package.yml` or the tag
workflow beyond printing the verdict; moving the pinned x3270 version.
