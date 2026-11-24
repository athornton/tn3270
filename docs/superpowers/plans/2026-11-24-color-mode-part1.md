# 15b B2 Part 1: color mode and the terminal type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the model's 3278/3279 prefix is the color mode, as in x3270. Models 2 and 3 in color
advertise `IBM-3279-N[-E]`, the default becomes `3279-2-E`, and `-mono` forces mono in every
front end.

**Architecture:** core's `termtype.ts` parses every x3270 model form into `{ number, color,
extended }`. `KNOWN_MODELS` grows the 3279 names. The advertised type follows
`create_3270_termtype`. The session derives `mode3279` from its model and `-mono`, and the screen
snapshot carries it, so `resolve()` draws mono without its callers passing anything (the
`codePage` pattern from 15a).

**Spec:** `docs/superpowers/specs/2026-11-24-appearance-while-running-design.md`, Part 1.

**THE SOURCE BEATS THIS PLAN.** Read at `0739ec6`. Run
`npm run build && npm run typecheck && npx vitest run` after every task.

## Facts established while planning (2026-11-24)

- **x3270's name rule** (`Common/model.c:68-101`, `canonical_model_x`): after an optional `IBM-`
  (case-insensitive), a bare `2`-`5`, or `327[89]-[2345]`, optionally `-E` or `-e`. `3279` and a
  bare number are color, `3278` mono (`*is_color = (*colorp == '9')`, default `colorp = "9"`).
  **Difference kept:** x3270 ignores a name's `-E` (the extended data stream comes from the
  `extendedDataStream` resource); ours selects it, as it always has.
- **The advertised type** (`Common/telnet.c:2095-2108`): oversize sends `IBM-DYNAMIC`; otherwise
  `IBM-327{9 if mode3279 and model < 4, else 8}-N` plus `-E`. `mode3279` is
  `!mono && is_color` (`model.c:155`).
- **Ours today:** `core/src/termtype.ts` has `KNOWN_MODELS` with only the eight `3278-N[-E]` keys,
  each with a fixed `ttype`. `lookUpModel` uppercases and strips `IBM-`. `TERMINAL_TYPE =
  'IBM-3278-2-E'` (`constants.ts:748`) is the no-model default. `geometry.ts` produces
  `IBM-DYNAMIC` for oversize. `CONNECT_DEFAULT_MODEL = '3278-2-E'`
  (`gui/src/connectDialog.ts:14`). `KNOWN_MODELS` keys feed the GUI's Connect dialog and Model
  menu (`gui/src/main.ts:1522`, `gui/src/menu.ts:207-319`).
- **`mode3279` today:** `resolve(snap, { mode3279 })`, default true (`core/src/render.ts`); only
  the TUI passes it (`tui/src/app.ts:633`, from its `mode3279` option).

## Tasks

### Task 1: core model names and the advertised type

- [ ] **Failing tests** (`core/test/termtype.test.ts`), as a table:
  - **Accepted forms:** `3278-2`, `3279-2`, `2`, `3279-4-E`, `ibm-3279-3-e`, `IBM-3278-5-E`.
  - **Refused, with a message naming the forms:** `3277-2`, `3279-6`, `6`, `3279-2-X`,
    `3279--2`.
  - **The advertised type, each model × mode × extended:**

    | model | ttype |
    |---|---|
    | `3279-2-E` | `IBM-3279-2-E` |
    | `3279-3` | `IBM-3279-3` |
    | `3279-4-E` | `IBM-3278-4-E` (model 4 stays 3278) |
    | `3279-5-E` | `IBM-3278-5-E` |
    | `3278-2-E` | `IBM-3278-2-E` |
    | `2` | `IBM-3279-2` |
    | `3279-2-E` with `mono: true` | `IBM-3278-2-E` |

  - **No model:** the default is `IBM-3279-2-E`.
  - **`isColorModel(opts)`:** true for 3279 and bare names, false for 3278, false with `mono`.
  - **The alternate size** is unchanged for each number.
- [ ] **Implement:**
  - A `parseModel(name)` returning `{ number: 2|3|4|5, color: boolean, extended: boolean }`.
  - `KNOWN_MODELS` gains the eight `3279-N[-E]` keys, each `ttype` computed by
    `create_3270_termtype`'s rule; a bare `N` resolves through `parseModel`.
  - `TerminalTypeOptions` gains `mono?: boolean`, applied when computing the ttype.
  - `TERMINAL_TYPE` becomes `'IBM-3279-2-E'`. Grep every test that asserts `IBM-3278-2-E` as the
    *default*, and update only the default-asserting ones.
- [ ] **Commit:** `core: 3279 model names and IBM-3279-N advertising, as x3270's create_3270_termtype`.

### Task 2: the session's color mode, carried by the snapshot

- [ ] **Failing tests:**
  - `session.colorMode()` is true by default, false for a 3278 model, and false with `mono`.
  - `screen.snapshot().mode3279` matches it.
  - `resolve(snap)` with no options draws a mono snapshot in x3270's green: assert a field's fg
    against the existing mono test's expected color in `render.test.ts`.
  - A hand-built snapshot without the field draws color.
- [ ] **Implement:**
  - `SessionOptions.mono?: boolean`, and the session computes the mode from its geometry
    setting's model.
  - `ScreenSnapshot.mode3279?: boolean`, set by the session on its screen whenever the model
    changes (connect, geometry menu).
  - In `resolve`: `opts.mode3279 ?? snap.mode3279 ?? true`.
  - The TUI's own `mode3279` option is removed in favour of the snapshot. Check `tui/src/app.ts`
    callers, and keep any explicit override the TUI needs.
- [ ] **Commit:** `core: the session's color mode from its model, carried by the snapshot`.

### Task 3: `-mono` in the four front ends, and the B1 key

- [ ] **Tests:** each front end's parser takes `-mono` and passes `mono` to `defaultSession`
  (which gains the parameter, after `codePage`). It's in each usage line (A's coverage test).
  B1's `mono` key is in `GUI_PREF_KEYS` and `TUI_PREF_KEYS` (bare type) and round-trips.
- [ ] **Commit:** `gui, tui, web, cli: -mono forces a 3278 mono session`.

### Task 4: the default model, the menus and the once-per-process notice

- [ ] **Tests:**
  - `CONNECT_DEFAULT_MODEL` is `3279-2-E`.
  - The Model menu and the Connect dialog list the 3279 names first, then the 3278 ones. Check
    the dialog's current ordering and whether its tests pin it.
  - `frontend`'s `monoModelNotice(model)` returns the notice the first time a `3278-` model is
    given and `undefined` after that, with a reset hook for tests. It returns `undefined` for
    3279, bare and no model. Text: `-model 3278-4-E now means a mono 3278, as in x3270; for
    color use 3279-4-E`.
- [ ] **Implement,** and print the notice through each front end's existing notice path: the
  GUI's `fail()` (as the geometry reset notice is), and stderr for the TUI, CLI and web. Do it
  once at startup, and in the GUI again when the Model menu selects a 3278 name.
- [ ] **Commit:** `frontend, gui: the 3279 default, 3279-first model lists, and the mono notice`.

### Task 5: mutation check

Each must fail a test:
1. 3279 advertised for model 4.
2. Bare `N` taken as mono.
3. `mono` ignored in the ttype.
4. `snap.mode3279` ignored by `resolve`.
5. The default left at 3278.
6. The notice shown twice.

### Task 6: live on VM/370 and TK5 (the merge gate), docs, parity

- [ ] **Live:** the CLI with a trace on (`Trace(on)`, as `docs/live-testing.md` does), then the
  GUI.
  - **VM/370 (`127.0.0.1:3270`):** the default (`IBM-3279-2-E` in the trace's TTYPE IS), logon,
    `Ready;`, the screen in color; then `-model 3278-2-E` (mono, green) and `-mono`.
  - **TK5 (`127.0.0.1:3271`):** the default to the TSO logon panel; then `3278-2-E`.
  - **Any refusal stops the merge** and goes to the user with the trace.
- [ ] **Docs:**
  - README: every `-model 3278-…` example used for color becomes `3279-…`; the model and
    `-mono` docs; the B2 *Staging* line.
  - Parity: `color-mode` (the flag and drawing; the menu is Part 2) and `screen-model` (its 3279
    gap closed).
  - A changelog fragment, under Bug fixes, saying 3278 now means mono.
  - The HANDOFF.
