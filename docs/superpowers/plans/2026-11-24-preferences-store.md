# 15b sub-project B1: the preferences store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a JSON preferences file for the GUI (`userData/preferences.json`) and the TUI
(`~/.config/tn3270/tui.json`), loaded as flags in front of the real argv, and saved explicitly:
File → Save Changed Options in the GUI, `-save` in the TUI.

**Architecture:** `frontend/src/prefs.ts` holds the pure parts: the key table, `prefsToArgv`,
its inverse `argvToPrefs`, and `loadPrefs`/`savePrefs` over an injected fs. Each front end
computes its path, prepends the file's tokens to argv, and saves from the effective tokens.

**Tech Stack:** TypeScript, vitest, Electron 44.

**Spec:** `docs/superpowers/specs/2026-11-24-preferences-store-design.md`.

**THE SOURCE BEATS THIS PLAN.** Read at `772ca26`. Re-read each file before changing it. Run
`npm run build && npm run typecheck && npx vitest run` after every task; vitest does not typecheck.

## Facts established while planning (2026-11-24)

- **Last-one-wins holds for every stored flag**, checked: the parsers assign `args.x = value`
  per occurrence, `takeTlsFlag` assigns `flags.caFile` (`frontend/src/tls.ts`),
  `takeOversizeFlag` assigns `out.oversize` (`frontend/src/oversizeFlag.ts`), and no front-end
  parser refuses a repeated flag (the only "given more than once" refusal is the transfer
  keyword parser, which this doesn't touch). Task 1's order test proves it per flag anyway.
- **GUI startup:** `userArgv(process.argv, process.defaultApp)` then `planStartup(argv, SEAM)`
  (`gui/src/main.ts`, inside `app.whenReady()`). A `fail` plan is painted by `fail(explain(err))`.
  With no host, `openConnectDialog(win, fail, argv)` runs. `dialogToArgv(form, commandLine)`
  (`frontend/src/connectForm.ts:57`) drops the flags the dialog owns (`-model`, `-insecure`, …)
  from `commandLine` and appends the form's. The dropdown's default is `CONNECT_DEFAULT_MODEL`
  (`gui/src/connectDialog.ts:17-19`), **even when `-model` was given**. That's an existing gap,
  and B1 must close it, or a saved model would be dropped on every dialog launch.
- **TUI startup:** `run(argv, …)` → `parseArgs(argv)`. With no host, `promptConnect(argv, …)`
  (`tui/src/connectPrompt.ts:35`) receives the same argv.
- **Names lost in parsing:** `scheme` is stored as a resolved `Scheme` with no name. That's why
  saving inverts the tokens (`argvToPrefs`) rather than reading parsed args back.
- **Oversize** is `{kind:'none'} | {kind:'auto'} | {kind:'fixed', rows, cols}` (`core/src/geometry.ts:20`),
  with no formatter. Task 1 adds `oversizeFlagValue()`: `none`, `auto`, `<cols>x<rows>`.
- **Store probe:** `scripts/store-probe.mjs`. Task 6 checks whether its drivers can run a step.
- **SPEC AMENDMENT, recorded here and in the spec at the end:** a save writes what the file,
  a flag or a menu set, not strictly "everything not at its built-in default". A value set
  explicitly equal to a default is kept. That's simpler and honest, and the spec's reason for
  leaving defaults out still holds: an unset default is never written.

## Files

- Create `packages/frontend/src/prefs.ts`, test `packages/frontend/test/prefs.test.ts`; export
  from `packages/frontend/src/index.ts`.
- GUI: `packages/gui/src/main.ts`, `packages/gui/src/menu.ts`, `packages/gui/src/connectDialog.ts`;
  tests in `packages/gui/test/`.
- TUI: `packages/tui/src/args.ts`, `packages/tui/src/main.ts`; tests in `packages/tui/test/main.test.ts`.
- Docs: `README.md`, `docs/parity/checklist.yaml` (fix `save-options`'s stale `:808`),
  `docs/live-testing.md`, `docs/HANDOFF.md`, a `changelog.d/` fragment, and the spec's amendment.

---

### Task 1: `frontend/src/prefs.ts`, the pure core

- [ ] **Step 1: Failing tests** (`frontend/test/prefs.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import {
  GUI_PREF_KEYS, TUI_PREF_KEYS, prefsToArgv, argvToPrefs, parsePrefsJson, oversizeFlagValue,
} from '../src/prefs.js';

describe('prefsToArgv', () => {
  it('maps each type to its flag form', () => {
    const r = prefsToArgv({ model: '3278-4-E', visualbell: true, ddm: false, colors: 256, cafile: '/ca.pem' }, TUI_PREF_KEYS);
    expect(r.argv).toEqual(['-model', '3278-4-E', '-visualbell', '-ddm', 'off', '--colors', '256', '-cafile', '/ca.pem']);
    expect(r.warnings).toEqual([]);
  });
  it('visualbell false emits nothing', () => {
    expect(prefsToArgv({ visualbell: false }, GUI_PREF_KEYS).argv).toEqual([]);
  });
  it('an unknown key is a warning and skipped', () => {
    const r = prefsToArgv({ colour: 'red', model: '3278-2' }, GUI_PREF_KEYS);
    expect(r.argv).toEqual(['-model', '3278-2']);
    expect(r.warnings).toEqual(['ignoring unknown key "colour"']);
  });
  it('a refused key is a warning saying why, and skipped', () => {
    const r = prefsToArgv({ insecure: true, host: 'vm' }, GUI_PREF_KEYS);
    expect(r.argv).toEqual([]);
    expect(r.warnings[0]).toMatch(/^ignoring "insecure": .*TLS/);
    expect(r.warnings[1]).toMatch(/^ignoring "host": /);
  });
  it('colors is TUI only', () => {
    expect(prefsToArgv({ colors: 16 }, GUI_PREF_KEYS).warnings).toEqual(['ignoring unknown key "colors"']);
  });
  it('a value of the wrong type throws, naming the key', () => {
    expect(() => prefsToArgv({ model: 4 }, GUI_PREF_KEYS)).toThrow('"model" must be a string');
    expect(() => prefsToArgv({ ddm: 'off' }, GUI_PREF_KEYS)).toThrow('"ddm" must be true or false');
  });
});

describe('parsePrefsJson', () => {
  it('accepts an object, refuses anything else', () => {
    expect(parsePrefsJson('{"model":"3278-2"}')).toEqual({ model: '3278-2' });
    expect(() => parsePrefsJson('[1]')).toThrow('must be a JSON object');
    expect(() => parsePrefsJson('{nope')).toThrow(/not valid JSON/);
  });
});

describe('argvToPrefs, the inverse', () => {
  it('collects stored flags, last one winning, and skips everything else', () => {
    const p = argvToPrefs(['-model', '3278-2', '-insecure', '-model', '3278-4-E', '-ddm', 'off',
      '-visualbell', '-scheme', 'green', 'vm.example:3270', '-devname', 'x==='], GUI_PREF_KEYS);
    expect(p).toEqual({ model: '3278-4-E', ddm: false, visualbell: true, scheme: 'green' });
  });
  it('round-trips with prefsToArgv', () => {
    const prefs = { model: '3278-4-E', oversize: 'auto', codepage: 'cp037', tn3270e: true, cafile: '/c' };
    expect(argvToPrefs(prefsToArgv(prefs, GUI_PREF_KEYS).argv, GUI_PREF_KEYS)).toEqual(prefs);
  });
});

describe('oversizeFlagValue', () => {
  it.each([[{ kind: 'none' }, 'none'], [{ kind: 'auto' }, 'auto'], [{ kind: 'fixed', rows: 62, cols: 160 }, '160x62']] as const)(
    '%o is %s', (o, s) => { expect(oversizeFlagValue(o)).toBe(s); });
});
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement `prefs.ts`:**
  - A key table entry is `{ key, flag, type: 'string' | 'number' | 'onoff' | 'bare' }`.
    - `GUI_PREF_KEYS`: model `-model`, oversize `-oversize`, scheme `-scheme`, codepage
      `-codepage`, visualbell `-visualbell` (bare), tn3270e/bind-image/bind-limit/ddm (onoff),
      cafile `-cafile`.
    - `TUI_PREF_KEYS`: the same plus colors `--colors` (number).
  - `REFUSED`, keyed by name, each with its reason: insecure and noverifycert (TLS), host and
    devname (they belong to a host; sub-project C), terminal-type (a debugging override). A flag
    accepts aliases (`-charset` for `-codepage`); `argvToPrefs` must map an alias to its key.
    Grep each parser for the alias set rather than trusting this list.
  - `prefsToArgv` returns `{ argv, warnings }` and throws `Error` for a wrong type.
  - `argvToPrefs(tokens, keys)` walks the tokens: a stored flag takes its value (or, for bare,
    is `true`; for onoff, `on`/`off` becomes a boolean), and anything else is skipped, along with
    its value when the flag takes one. To know which non-stored flags take a value, use a
    `VALUE_FLAGS` set covering every flag of both front ends that takes a value (the TUI and GUI
    usage lines list them). A test feeds it `-devname x===` and checks `x===` isn't read as a host.
  - `loadPrefs(path, keys, fs)`: a missing file gives `{argv: [], warnings: []}`. It throws
    `Error('<basename>: <reason>')` for bad JSON, a wrong type or a non-object.
  - `savePrefs(path, prefs, fs)` reads the existing file's unknown keys to preserve them, writes
    `<path>.tmp` then renames it, creates the directory, and returns the number of settings
    written. `fs` is an injected `{ readFile, writeFile, rename, mkdir }` subset, so tests use an
    in-memory map. Also `oversizeFlagValue`.
- [ ] **Step 4: Tests for `loadPrefs`/`savePrefs`** with an in-memory fs: missing file; bad JSON
  names the basename; save writes tmp then renames; save preserves an unknown key from the
  existing file; save creates the directory. Run, pass.
- [ ] **Step 5: Commit:** `frontend: the preferences file: keys, prefsToArgv, argvToPrefs, load and atomic save`.

### Task 2: The order test, per stored flag, in both parsers

- [ ] For each GUI and TUI key, in `gui/test/args.test.ts` and `tui/test/main.test.ts`: parse
  `[...prefsToArgv({k: fileValue}).argv, flag, flagValue]` and check the flag's value wins.
  Parse the file's tokens alone and check the file's value is used. Use real values each parser
  accepts. A failing flag means that parser doesn't keep the last value: fix the parser.
- [ ] Commit: `gui, tui: tests that a flag beats the preferences file, for every stored key`.

### Task 3: The TUI: load and `-save`

- [ ] **Failing tests** (`tui/test/main.test.ts`), with the injected fs and an explicit path:
  1. **`tuiPrefsPath(env, platform, home)`:** `XDG_CONFIG_HOME` → `$X/tn3270/tui.json`; unset →
     `<home>/.config/tn3270/tui.json`; win32 → `%APPDATA%\tn3270\tui.json`.
  2. **`run()` with a file `{model: '3278-4-E'}`** and argv `['vm']` builds a session at
     3278-4-E (use `buildSession`'s geometry, as the existing model tests do).
  3. **A bad file value** fails startup with `tui.json: -model …` (a UsageError, exit 2).
  4. **`-save`** with argv `['-model', '3278-4-E', '-save', 'vm']` writes `{model: '3278-4-E'}`
     (no `save`, no host) and reports `saved 1 setting to <path>` on stderr.
  5. **`-save` is in USAGE**: the Task 3 coverage test from sub-project A catches this anyway.
- [ ] **Implement:** add `case '-save': args.save = true; break;` to `tui/src/args.ts`. `run()`
  gains an injectable `prefs` option (`{ path, fs }`, defaulting to the real ones). It loads the
  file, writes warnings to stderr, and prepends the tokens. On a load error it throws a
  UsageError with the message. After parsing, if `args.save`, it calls
  `savePrefs(path, argvToPrefs(effectiveTokens, TUI_PREF_KEYS), fs)`. `-save` itself isn't a
  stored key, so `argvToPrefs` skips it. The prompt path receives the same effective argv.
- [ ] Commit: `tui: a preferences file (tui.json), and -save`.

### Task 4: The GUI: load, the dialog default, Save Changed Options

- [ ] **Failing tests:**
  1. **`connectModels(defaultModel?)`** returns the given model as the default when it's a known
     model, and `CONNECT_DEFAULT_MODEL` otherwise (`gui/test/connectDialog.test.ts` or wherever
     `connectModels` is tested).
  2. **`menu.test.ts`:** with an `onSaveOptions` handler, linux and win32 get File → Save Changed
     Options (id `save-options`) before Quit, and darwin gets it in the app menu. It's absent
     without the handler, matching `onAbout`'s pattern.
  3. **A pure `guiPrefsToSave(effectiveArgv, geometrySetting)`:** `argvToPrefs(effectiveArgv,
     GUI_PREF_KEYS)`, then the Model menu's pending `model` and `oversize` (via
     `oversizeFlagValue`) when the geometry setting has them.
- [ ] **Implement in `main.ts`:**
  - Path: `join(app.getPath('userData'), 'preferences.json')`.
  - After `userArgv` (the startup argv), load the file, write warnings to stdout (the GUI's log),
    and on a load error `fail(message)` and paint it as any startup failure. The effective argv is
    `[...fileTokens, ...argv]`, given to `planStartup` and to `openConnectDialog`. **The
    `answerInfoFlag` call stays on the raw argv**, since `--help` must be the lone *typed*
    argument.
  - The dialog default is `connectModels(parsedModel)`, where `parsedModel` comes from parsing the
    effective argv (catch and ignore a parse failure there: the dialog path reports its own).
  - **Save:** `onSaveOptions` calls `savePrefs(path, guiPrefsToSave(effectiveArgv,
    session.geometrySetting), realFs)` and reports `saved N settings to <path>` (or the error)
    through `fail()`, the window's message path. Check `fail()` isn't styled as fatal; if it is,
    find the notice path the geometry-reset notice uses (`main.ts`'s model-menu comment says it
    goes through `fail()` too).
- [ ] Commit: `gui: a preferences file, the dialog's model from it, and Save Changed Options`.

### Task 5: Mutation check

Each must fail a test:
1. `prefsToArgv` puts file tokens after argv (in a front end's prepend).
2. `argvToPrefs` takes the first value instead of the last.
3. `REFUSED` loses `insecure`.
4. `savePrefs` writes straight to the path (no tmp and rename).
5. `savePrefs` drops unknown keys.
6. `-save` writes `save: true`.
7. `connectModels` ignores its argument.
8. `answerInfoFlag` given the effective argv (a file with any key would break `--help`).

### Task 6: Store probe, docs, parity, live

- [ ] **Store probe:** read `scripts/store-probe.mjs` and its drivers. If a probe run can
  exercise a step (env seams such as `TN3270_GUI_KEYS` with `menu:save-options`, then a second
  launch reading the file back), add one. Otherwise record the gap in the HANDOFF and the parity
  row.
- [ ] **Live (Xvfb + VM/370):** a fresh `--user-data-dir`. Launch with a host, choose
  Model → 3278-4-E with `menu:` steps (the Model menu's ids are in `menu.ts`), then
  `menu:save-options`. Relaunch the same user-data-dir with only the host, and check 43 rows
  (the title shows `3278-4-E`, from sub-project A). TUI: `-model 3278-4-E -save` against VM,
  then a plain run, and check the geometry through the CLI-style status or the TUI's own output.
- [ ] **Parity `save-options` → `ours`:** a JSON file, not an x3270 profile, by the user's
  choice. Fix the stale `docs/releasing.md:808` citation to `:661-668`.
- [ ] **README** (*Using the GUI*, *Using the TUI*: the file, its keys, the refused keys, Save /
  `-save`), the **spec amendment**, a **changelog** fragment and the **HANDOFF**. Commit.
