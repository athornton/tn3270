# The x3270 parity checklist, the store gate — design

Date: 2026-11-17. Status: approved in conversation, section by section.

## Problem

Nothing goes into the Mac App Store or the Microsoft Store before feature parity with x3270
(the user, 2026-11-11; HANDOFF, *the three-piece store plan*, piece 2). "Parity" has no
definition yet, so there is no gate to pass. This spec defines it: a checklist, the rules for
its rows, the checks that keep it honest, and a gate command. It does **not** build any of the
missing features. Each gap gets its own spec → plan → build afterwards.

## Decisions (the user, 2026-11-16/17)

1. **Comparator: x3270, the X11 application, against our GUI.** The stores ship the GUI, so
   only GUI rows gate. Each row carries an informational browser note, and TUI/CLI/pr3287
   equivalents are recorded where obvious; they never gate.
2. **A row is one user-visible feature, plus a coverage index.** Rows are judged per feature
   (~50-80 of them). Every name in x3270's tables must be listed under exactly one row, and a test
   enforces that against an extracted name list.
3. **A `deferred` status exists.** It means planned but not in the first store release, with a
   reason and the user's sign-off. The gate passes deferred rows and blocks missing ones.
4. **`ours` needs evidence and equivalent reach.** It needs a code citation, a test, and a live
   witness for wire behaviour (or an explicit acceptance of `unwitnessed`), and x3270's way of
   reaching the feature must have an equivalent in our GUI. A menu-reachable x3270 feature that
   we offer only by a flag is `partial`, which blocks.
5. **Data file + generated document + coverage test** (approach 1 of 3; a parsed markdown table
   and TypeScript rows were rejected).
6. **The comparator is the newest released (GA) x3270, kept up automatically.** Today that is
   **4.5ga6**: GitHub `pmattes/x3270` tags include `4.6alpha1` and `4.5ga6`, and alphas and
   betas never count. `~/src/suite3270-4.5` is exactly 4.5ga6 (`Common/version.txt`).

## 1. The name inventory

`scripts/parity-extract.mjs` (with `parity-extract.d.mts`, as for the other scripts) scans an
x3270 source tree and writes `docs/parity/x3270-names.json`.

- **Input:** `--dir <suite3270-tree>` or `--tag <x3270-tag>`. `--tag` downloads that tag's source
  archive from GitHub into a new empty temporary directory. The tree is only read as text and
  never built or executed, and the extractor runs with no cwd inside it.
- **Scope: only what the x3270 binary links.** The object list comes from
  `x3270/Makefile.obj.in`, and only the matching `.c` files in `Common/` and `x3270/` are scanned.
  `c3270`-, `s3270`- and `b3270`-only code and the `*_stubs*.c` files are therefore out. The
  extractor re-reads this list for every tag, because a new release may change it.
- **Five kinds of name, each with `file:line`:**
  - `action`: `An*` entries in `action_table_t` arrays (~98 in 4.5ga6);
  - `option`: entries of the `opts[]` table, each paired with the `Res*` it sets (~88). Covering
    either name covers the pair;
  - `resource`: `#define Res*` in `include/resources.h` that a linked source uses (≤248);
  - `toggle`: `toggle_names[]` in `Common/toggles.c` (24);
  - `menu`: widget names passed to `add_menu_itemv`, `toggle_init` and
    `XtVaCreateManagedWidget` in `x3270/menubar.c` and the other linked x3270 popups (~45; spacers
    such as `"space"` excluded).
- **Output:** sorted and stable (identical input gives identical bytes), with the tag recorded at
  the top. It is committed, and CI never runs the extractor against a local tree.
- **Counts above are estimates** from a first grep (2026-11-16). The extractor's output is the
  measurement, and the plan must not hard-code these numbers.

### Keeping up with upstream

`.github/workflows/parity-upstream.yml`, a weekly schedule plus `workflow_dispatch`:
lists `pmattes/x3270` tags, picks the newest matching `ga`, and compares it with the tag
recorded in `x3270-names.json`. If newer, it runs `parity-extract.mjs --tag <new>` and fails
with the difference: names added, names removed, names whose `file:line` moved. A failure here
is a notification and does not break `main`. Updating means committing the regenerated file, and
the coverage test then fails on every new name until a row covers it. `workflow.test.ts` gains
assertions for the new workflow (schedule present, GA-only tag selection, no write
permissions).

The README's existing x3270 citations (`kybd.c:978` and the like) stay pinned to 4.5. They are
measurements, not the gate.

## 2. Rows

`docs/parity/checklist.yaml`, parsed with the `yaml` package (new root devDependency; zero
runtime dependencies of its own).

```yaml
- id: proxy                       # unique, kebab-case
  title: Connect through a proxy (HTTP, SOCKS4/4a, SOCKS5/5d, telnet, passthru)
  covers: [OptProxy, ResProxy, proxyOption]   # names from x3270-names.json
  x3270: "Options menu → Proxy…; -proxy"      # how x3270 reaches it
  gui: "flag only: -proxy"                    # how ours does
  status: partial
  gap: "no dialog or preference"              # partial only
  evidence:
    code: [packages/core/src/proxy.ts:40]
    tests: [packages/core/test/proxy.test.ts]
    live: unwitnessed            # a docs/live-testing.md heading | unwitnessed | n/a
  browser: "n/a: the gateway connects, not the browser"
  others: {tui: "-proxy", cli: "-proxy"}      # optional, informational
```

(The example's paths and status are illustrative, not a finding.)

### Statuses and what each requires

| status | requires | gate |
|---|---|---|
| `ours` | `evidence.code`, `evidence.tests` (files exist), `gui` equivalent to `x3270` (below), `evidence.live` a heading or `n/a` | passes |
| `ours` + `live: unwitnessed` | as above, plus `accept-unwitnessed: <reason>` | passes only with that field |
| `partial` | `gap` | blocks |
| `missing` | none | blocks |
| `proposed-deferred` / `proposed-skipped` | `reason` | blocks |
| `deferred` | `reason`, `decided: "<YYYY-MM-DD>, user"` | passes |
| `skipped` | `category` (`x11-only` / `obsolete` / `declined` / `n/a`), `reason`, `decided` | passes |

**Equivalent reach.** If x3270 offers the feature from a menu item or dialog, the GUI needs a
menu item, dialog or preference. If x3270 offers it only by a command-line option or resource,
a flag or a persistent preference is enough.

**Sign-off.** Only the user sets `decided`. An agent or a session proposes; it writes
`proposed-deferred` / `proposed-skipped` with a draft reason, never `decided`.

## 3. Checks and the gate

`packages/core/test/parity.test.ts`, beside `releaseNotes.test.ts`, which already tests a script in
`scripts/`. It runs in every CI run.

1. **Coverage.** Every name in `x3270-names.json` is covered by exactly one row. Every `covers`
   entry exists there, so stale names fail.
2. **Shape.** Each row has what its status requires (table above); ids are unique; `decided`
   appears only on `deferred` / `skipped`; `accept-unwitnessed` only on `ours` with
   `live: unwitnessed`.
3. **Citations resolve.** Cited files exist; a `file:line`'s line is within the file; a `live`
   heading exists in `docs/live-testing.md`.
4. **`docs/parity.md` is current.** Re-rendering gives exactly the committed bytes. Its header counts
   are generated, never hand-typed.
5. **The checker is tested on bad fixtures.** An uncovered name, a double cover, `ours` without
   tests, `deferred` without `decided`, and a dead citation each fail with a reason naming the
   row.

**Not mechanically provable:** that a cited test exercises the feature *through the GUI*. That
is for review, and the `gui` field states the claim so a reviewer can check it.

`scripts/parity.mjs` (with `.d.mts`) has two modes:
- `render`: writes `docs/parity.md`, a header with generated counts per status, then one table
  per area with the reason or gap leading in each row;
- `gate`: exits 0 only when no row is `missing`, `partial`, `proposed-*`, or `unwitnessed` without
  acceptance; otherwise it prints one line per blocking row, id and reason first, and exits 1.

**The gate is not wired into the tag workflow.** GitHub and npm releases ship as now. Piece 3
(submission) will make the store-package step call `parity.mjs gate`.

## 4. Populating it, and what follows

**In this spec's plan:** the extractor, `x3270-names.json` for 4.5ga6, `parity.test.ts`,
`parity.mjs`, `parity-upstream.yml`, and **a complete first `checklist.yaml`**, meaning the
coverage test passes with every name in some row.

**How the first rows are written.** Read-only agents sweep x3270 by area, then propose rows
against our repo:
connection (host, telnet, TN3270E, TLS, proxy); keyboard and actions; display (fonts, colours,
code pages, models, cursor); file, print, trace, screen trace and save/restore; scripting and
the remainder. Rules:
- **Unsure means `missing`.** `ours` only with citations in hand, and each claim is checked
  against the repo before it is written; the source wins over a sweep's report.
- **No agent writes `decided`.** Likely skips and deferrals are `proposed-*` with a draft reason.
- **One writer.** Sweep agents return proposals, and one session edits `checklist.yaml`.

**The user's triage** follows: the `proposed-*` rows, reviewed area by area. That review
decides the scope of the first store release. Whatever is still `missing` / `partial` afterwards
is the store roadmap.

**Afterwards (separate work, recorded here so it is not lost):** the ordered gap list replaces
README *Remaining* 15-22, with each existing item mapped to row ids; each gap gets its own
spec; README *What is not implemented* keeps its prose and links its rows; HANDOFF's store plan
points at `docs/parity.md`.

## Out of scope

Building any feature; the store submission (piece 3); any change to `package.yml` or the tag
workflow; re-pinning the README's existing x3270 citations.
