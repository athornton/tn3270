# 15b B2 Part 2a: the Options menu, highlight-bold and the fixed cursor color — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the GUI gets an Options menu with Color Scheme (switching live), Color Mode, Highlight
Bold and Fixed Cursor Color. `-highlightbold` and `-cursorcolor` come to the front ends where they
mean something, and the new settings save through B1's store. Mono draws intensified fields bold,
as x3270 does, which it does not today.

**Architecture:** the x3270 bold rule moves into core's `resolve()` as a new `ResolvedCell.bold`,
so the GUI, the web and the TUI share one rule. The cursor color is a draw-list field the canvas
blit reads. The menu is a pure template plus a state function in `gui/src/menu.ts`, mutated by id
like the Model menu. `main.ts` holds the live scheme, bold and cursor settings and repaints.

**Spec:** `docs/superpowers/specs/2026-11-24-appearance-while-running-design.md`, Part 2.
**Split (2026-11-25, for budget):** this plan is the Options menu and its flags. **Part 2b** is the
View menu: Bigger, Smaller, Fit and Snap Window, Appearance, `-appearance`, and the `scale` and
`appearance` keys. 2b is planned separately and is not started here.

**THE SOURCE BEATS THIS PLAN.** Read at `93f414a`. Run
`npm run build && npm run typecheck && npx vitest run` after every task (vitest does not
typecheck). Re-derive each task against the repo before dispatch: the snippets below are drafts.

## Facts established while planning (2026-11-25)

- **x3270's bold rule** (`suite3270-4.5/x3270/screen.c`): `highlight_bold` is the resource in 3279
  mode and forced true in mono (`:706-712`). A cell's gr gains `GR_INTENSIFY` when
  `highlight_bold && FA_IS_HIGH(fa)` (`:3178`), and `GR_INTENSIFY` draws the overstrike
  (`:2917-2921`). `FA_IS_HIGH` is an **equality** on the intensity bits, `(fa & 0x0C) == 0x08`
  (`include/3270ds.h:211-212`). So a hidden field (0x0C) is never bold. That differs from
  `defaultColor`'s bit test in `render.ts:200`, and must.
- **Today, mono loses intensified fields.** `resolve` makes every mono cell green (`render.ts`
  `fg` under `mode3279`), and `intensify` carries only highlight 0xF8. So on a 3278 an intensified
  field looks exactly like a normal one. This plan fixes that as a side effect of the rule above.
- **Fixed cursor color:** `useCursorColor` off by default and `cursorColor` `"red"`
  (`x3270/resources.c:240-241, 258-259`). That is the X11 name `red`, `#FF0000`, not the scheme's
  red. The blit draws the cursor bar in `cell.fg` (`canvas/src/blit.ts:152-157`).
- **Menu gating** (`x3270/menubar.c`): the 3278/3279 items are **absent** under `-mono`
  (`:2313`) and insensitive while connected (`!PCONNECTED`, `:2319, :2325`). The Colors pullright
  is sensitive only in `mode3279` (`:2496`).
- **The GUI paint path:** `startSession` resolves `scheme` once as a `const`
  (`gui/src/main.ts:812`). `send()` calls `drawList(snapshot, resolve(snapshot), geometry, scheme,
  oia)` (`:1443`). The web does the same with a per-process scheme (`web/src/main.ts:298`). The TUI
  calls `resolve(snap, {mode3279?})` (`tui/src/app.ts:634`) and emits SGR 1 on `cell.intensify`
  (`tui/src/render.ts:489`, and `sameCell` at `:501`).
- **Menus** (`gui/src/menu.ts`): the template is pure. `modelMenuStates` and `applyChoiceStates`
  set checked and enabled by id. Writing `checked = false` to an Electron 44 **radio** checks it,
  so only the true item is written. `MenuItemTemplate.type` is `'radio' | 'separator'`; this plan
  adds `'checkbox'`. Whether a checkbox has the radio quirk is **unmeasured**, so Task 7 measures
  it.
- **Prefs** (`frontend/src/prefs.ts`): `mono` is already a COMMON bare key, and `-mono` is already
  in all four parsers (Part 1). A bare key saved `false` emits no flag. `guiPrefsToSave(startupArgv,
  geometry)` (`gui/src/guiPrefs.ts:47`) knows nothing yet of runtime settings.
- **A `Scheme` carries no name** (`frontend/src/palette.ts:42`). About prints `default` or `set by
  -scheme` (`main.ts:1022`), and its `colorMode` is hard-coded `'3279 color'` (`:1019`): a Part 1
  leftover that this plan fixes.
- **Color Mode applies at the next connect** by swapping the model prefix. KNOWN_MODELS has both
  prefixes (`core/src/termtype.ts:83`). The swap goes through the Model menu's path,
  `applyGeometryChoice` → `session.setGeometry`, which already refuses while connected.

## Tasks

### Task 1: core — the bold rule in `resolve`

**Files:** `packages/core/src/render.ts`, `packages/core/test/render.test.ts`.

- [ ] **Failing tests** (`fielded(attr)` builds a one-field screen; cell 1 is the character):
  ```ts
  describe('resolve: bold, x3270 highlight_bold', () => {
    const HIGH = FA.PRINTABLE | FA.INT_HIGH_SEL;
    const mono = (s: Screen) => { s.mode3279 = false; return s.snapshot(); };
    it('3279: an intensified field is not bold by default', () => {
      expect(resolve(fielded(HIGH).snapshot())[1]!.bold).toBe(false);
    });
    it('3279: highlightBold makes it bold', () => {
      expect(resolve(fielded(HIGH).snapshot(), { highlightBold: true })[1]!.bold).toBe(true);
    });
    it('mono: always bold, whatever highlightBold says', () => {
      expect(resolve(mono(fielded(HIGH)))[1]!.bold).toBe(true);
      expect(resolve(mono(fielded(HIGH)), { highlightBold: false })[1]!.bold).toBe(true);
    });
    it('a normal field is never bold', () => {
      expect(resolve(mono(fielded(FA.PRINTABLE)))[1]!.bold).toBe(false);
    });
    it('a hidden field is never bold: FA_IS_HIGH is an equality', () => {
      expect(resolve(mono(fielded(FA.PRINTABLE | FA.INT_ZERO_NSEL)))[1]!.bold).toBe(false);
    });
    it('highlight 0xF8 is bold in either mode, as before', () => {
      for (const m of [true, false]) {
        const s = fielded(FA.PRINTABLE);
        s.setExtended(1, { gr: XAH.INTENSIFY });
        s.mode3279 = m;
        const c = resolve(s.snapshot())[1]!;
        expect([c.bold, c.intensify], `mode3279 ${m}`).toEqual([true, true]);
      }
    });
    it('intensify keeps its wire meaning: an intensified field alone leaves it false', () => {
      expect(resolve(mono(fielded(HIGH)))[1]!.intensify).toBe(false);
    });
  });
  ```
  Also check the field-attribute cell itself (addr 0), which is blank and must not matter. Assert
  whatever the implementation gives and say why in the test name.
- [ ] **Implement:**
  - `ResolveOptions.highlightBold?: boolean`, documented with the x3270 citations above.
  - `ResolvedCell.bold: boolean`: "draw the overstrike". It is
    `gr === XAH.INTENSIFY || (hb && (attr & FA.INTENSITY) === FA.INT_HIGH_SEL)`, where
    `hb = !mode3279 || opts.highlightBold === true`.
  - Update `intensify`'s doc comment (`render.ts:124-136`). The "a renderer wanting x3270's look
    can OR in its own test" sentence becomes a pointer to `bold`.
  - `tsc` will flag every hand-built `ResolvedCell` in tests and sources. Fill `bold` in each, and
    grep `intensify:` across `packages/*/src` and `packages/*/test` to find them.
- [ ] **Commit:** `core: resolve's bold, x3270's highlight_bold rule (mono always bold)`.

### Task 2: the renderers draw `bold`

**Files:** `packages/canvas/src/drawlist.ts`, `packages/tui/src/render.ts`, and their tests.

- [ ] **Failing tests:**
  - `drawlist.test.ts`: a resolved cell with `bold: true, intensify: false` gives a `DrawCell` with
    `intensify: true`; `bold: false, intensify: true` gives `false`. `DrawCell.intensify` stays the
    blit's "overstrike" flag, and its doc says it now comes from `bold`.
  - `tui/test/render.test.ts`: SGR `1` is emitted for `bold`, not for `intensify` alone. Two cells
    differing only in `bold` are not `sameCell`, so the second is repainted.
- [ ] **Implement:** `drawlist.ts:136` `intensify: r.bold`; `render.ts:489` `cell.bold`;
  `sameCell` compares `bold` (keep `intensify` too, so it stays a full comparison).
- [ ] **Commit:** `canvas, tui: draw resolve's bold`.

### Task 3: core — `withColorMode`

**Files:** `packages/core/src/termtype.ts` (export from `index.ts`), `packages/core/test/termtype.test.ts`.

- [ ] **Failing tests:** `withColorMode(undefined, false)` is `'3278-2-E'` (the default is
  `3279-2-E`). `withColorMode('3279-4-E', false)` is `'3278-4-E'`. `withColorMode('3278-3', true)`
  is `'3279-3'`. A bare `'4'` gives `'3278-4'` for mono and `'3279-4'` for color. `ibm-3278-2-e`
  gives `'3279-2-E'`, the canonical casing. A name `parseModel` refuses throws
  `TerminalTypeError`. Every result is a `KNOWN_MODELS` key.
- [ ] **Implement:** parse, then build `` `327${color ? '9' : '8'}-${p.number}${p.extended ? '-E' : ''}` ``.
  The default comes from `TERMINAL_TYPE` with `IBM-` stripped, not a literal.
- [ ] **Commit:** `core: withColorMode swaps a model's 3278/3279 prefix`.

### Task 4: canvas — the fixed cursor color

**Files:** `packages/canvas/src/drawlist.ts`, `packages/canvas/src/blit.ts`, and their tests.

- [ ] **Failing tests:**
  - `drawList(..., scheme, oia, { cursorColor: true })` has `cursorColor: [255, 0, 0]`. Without
    the option the key is **absent** (`exactOptionalPropertyTypes`).
  - `blit.test.ts`, with its existing fake context: the cursor bar's `fillStyle` is
    `rgb(255, 0, 0)` when `list.cursorColor` is set and the cell's fg otherwise. Read how that test
    records fills before writing it.
- [ ] **Implement:** `DrawList.cursorColor?: Rgb`. `drawList`'s **sixth** parameter is
  `opts: { cursorColor?: boolean } = {}`, appended after `oiaText` for the positional reason in the
  comment above it. Use `export const FIXED_CURSOR_RGB: Rgb = [255, 0, 0]`, citing
  `resources.c:240` and X11 `red`. The blit uses `list.cursorColor ?? cell.fg`. The draw list goes
  over IPC and the web socket, so check the renderer and the web client read it from the list. Grep
  `cells` in `canvas/src/renderer.ts`.
- [ ] **Commit:** `canvas: a fixed cursor color, x3270's useCursorColor`.

### Task 5: flags and keys — `-highlightbold`, `-cursorcolor`

**Files:** `packages/{gui,tui,web}/src/args.ts`, `packages/frontend/src/prefs.ts`, the three
`main.ts`/`app.ts` paint calls, and the tests beside each.

- [ ] **Failing tests:**
  - GUI: `-highlightbold` and `-cursorcolor` set `args.highlightBold` and `args.cursorColor`.
    `-scheme green` also sets `args.schemeName` to the canonical name. Check how `resolveScheme`
    treats `greenscreen` and store what `SCHEME_NAMES` spells.
  - TUI: `-highlightbold`. **No `-cursorcolor`** (a terminal draws its own cursor, per the spec).
  - Web: both.
  - A's "usage covers every flag" test (`gui/test/args.test.ts:428`, and its siblings in the tui and
    web tests) passes only once each usage line names the flag. Watch it fail first.
  - Prefs: `highlightbold` is a bare key in `COMMON` (GUI and TUI). `cursorcolor` is a bare key in
    `GUI_PREF_KEYS` only. Both round-trip through `prefsToArgv`/`argvToPrefs`. The existing "a flag
    beats the preferences file, for every stored key" test (`args.test.ts:440`) covers them once
    added. Confirm it iterates the key list rather than a literal.
  - Wiring, one test each where a seam exists: the TUI passes `highlightBold` to `resolve`
    (`app.ts:634`), and the web passes `highlightBold` to `resolve` and `cursorColor` to `drawList`
    (`web/src/main.ts:298`). If there is no seam, the live check in Task 8 covers it. Say which in
    the commit message.
- [ ] **Implement** the parsers, usage lines, keys and paint calls. The GUI's paint call changes in
  Task 7, not here.
- [ ] **Commit:** `gui, tui, web: -highlightbold and -cursorcolor, saved through B1`.

### Task 6: GUI — the Options menu template

**Files:** `packages/gui/src/menu.ts`, `packages/gui/test/menu.test.ts`.

- [ ] **Failing tests:**
  - `buildMenuTemplate(platform, handlers, geometry, options)` with an `OptionsMenu` has an
    `Options` menu after View and before Model.
  - Options contains, in order:
    - **Color Scheme**, a submenu of radios `scheme:default`, `scheme:3279`, `scheme:x3270`,
      `scheme:green`, labelled `Default`, `3279`, `x3270`, `Green`. They come from `SCHEME_NAMES`,
      not a literal list.
    - **Color Mode**, a submenu of radios `colormode:3279` (`3279 color`) and `colormode:3278`
      (`3278 mono`).
    - A separator.
    - `Highlight Bold`, a checkbox, `highlight-bold`.
    - `Fixed Cursor Color`, a checkbox, `cursor-color`.
  - `optionsMenuStates(o)`:
    - The scheme radios are enabled iff `o.colorMode === true`, and the current one is checked.
    - The Color Mode radios are enabled iff `!o.connected`, and the current mode is checked.
    - The checkboxes are always enabled and checked per their values.
  - `colorMode: undefined` means **no Color Mode items at all**: under `-mono` (x3270 omits them)
    and for a `--terminal-type` session (no model to swap). Scheme is then enabled iff
    `o.mode3279`. Model the two separately: `colorModeChoice?: boolean` (the swappable prefix) and
    `mode3279: boolean` (the drawing).
  - Without an `OptionsMenu`, the template is exactly what it was. Keep the existing tests passing
    untouched.
  - The checkbox state write: `applyChoiceStates` writes `checked` **both ways** for a state marked
    `checkbox: true`, and still only `true` for radios. Pin both.
- [ ] **Implement:**
  - `MenuItemTemplate.type` gains `'checkbox'`.
  - `MenuHandlers` gains optional `onScheme(name)`, `onColorMode(color: boolean)`,
    `onHighlightBold()` and `onCursorColor()`.
  - `ChoiceState` gains `checkbox?: true`.
  - The scheme submenu sits on the item, not on the Options menu, so the per-item enabled rule (the
    `modelMenu` comment explains why) holds.
- [ ] **Commit:** `gui: the Options menu template and its states`.

### Task 7: GUI — wiring, live repaint, save, About

**Files:** `packages/gui/src/main.ts`, `packages/gui/src/guiPrefs.ts`, `packages/gui/test/guiPrefs.test.ts`.

- [ ] **Failing tests** (`guiPrefs.test.ts`): `guiPrefsToSave(argv, geometry, runtime)` with
  `runtime = { scheme, highlightBold, cursorColor }`:
  - It saves `scheme` when it differs from `DEFAULT_SCHEME` or was in argv.
  - It saves `highlightbold: true` when on, and **deletes** the key when off, so a `-highlightbold`
    in argv turned off by the menu is not saved back on.
  - `cursorcolor` behaves the same way.
  - The old two-argument behaviour is unchanged.
- [ ] **Implement in `main.ts`:**
  - `let scheme`, `let schemeName`, `let highlightBold` and `let cursorColor`, initialised from
    args. **Grep every `scheme` use in `main.ts`** and decide whether each reads the live value.
    The keypad and keyboard windows may take colors.
  - `send()` passes `{ highlightBold }` to `resolve` and `{ cursorColor }` to `drawList`. A menu
    change sets the variable, runs `send()` and refreshes the Options states.
  - `onColorMode(color)` runs the Model menu's path with
    `{ model: withColorMode(session.geometrySetting.model, color) }`, then `refreshModelMenu()` and
    the Options refresh. It does **not** print `monoModelNotice`: the user asked for mono.
  - `colorModeChoice` is `undefined` when `args.mono` or `session.geometrySetting === undefined`.
  - `mode3279` is `session.colorMode()`.
  - Refresh the Options states on the same four session events as the Model menu, and after every
    click, accepted or refused, for the radio reason in `refreshModelMenu`'s comment.
  - Save passes the runtime settings to `guiPrefsToSave`.
  - About: `colorMode` from `session.colorMode()` (`'3279 color'` or `'3278 mono'`) instead of the
    literal, and `scheme` from `schemeName`. Find About's test, and assert both there.
- [ ] **Measure, then record:** under Xvfb, with Electron 44, does writing `checked = false` to a
  **checkbox** check it? Write the result into `applyChoiceStates`' comment with the version. If it
  does, the Task 6 rule changes: write only on a change.
- [ ] **Commit:** `gui: the Options menu, live: scheme repaint, color mode, bold, cursor color`.

### Task 8: mutation check, live gate, docs

- [ ] **Mutation** (each must fail a test; revert after each):
  1. `FA_IS_HIGH` as a bit test (makes hidden bold).
  2. `hb` ignores mono.
  3. `hb` ignores `highlightBold`.
  4. The drawlist reads `intensify` instead of `bold`.
  5. TUI `sameCell` ignores `bold`.
  6. `cursorColor` ignored by the blit.
  7. The scheme radios enabled in mono.
  8. Color Mode enabled while connected.
  9. Color Mode present under `-mono`.
  10. The save keeps `highlightbold` when the menu turned it off.
  11. `withColorMode` drops `-E`.
- [ ] **Live under Xvfb, the merge gate** (GUI on VM/370 at `127.0.0.1:3270`, `docs/live-testing.md`):
  - Logon screen; switch the scheme to each of the four through the menu, screenshotting each, and
    read the PNGs back (an Electron that quit writes nothing).
  - Highlight Bold on: an intensified field (VM's logon has them) gains the overstrike.
  - Fixed Cursor Color on: the bar is red.
  - Color Mode is disabled while connected. After Disconnect it is enabled, and choosing 3278 mono
    then reconnecting advertises `IBM-3278-2-E` in the trace and draws green with bold intensified
    fields.
  - Save, restart, and the settings return.
  - `-mono` has no Color Mode items.
  - The web gateway with `-highlightbold -cursorcolor`, and the TUI with `-highlightbold`, to the
    same host.
  - **Any surprise stops the merge** and goes to the user.
- [ ] **Docs:**
  - README: the Options menu and the two flags.
  - Parity rows `color-scheme` (the menu exists now; note what is still missing), `highlight-bold`,
    `cursor-color`, and `color-mode` (the menu).
  - A changelog fragment, under Bug fixes, saying mono now draws intensified fields bold.
  - A Staging line for Part 2b.
  - HANDOFF.
- [ ] **Commit:** `docs, gui: 15b B2 Part 2a -- the Options menu, the live gate, parity, changelog`.
