# 15b B2 Part 2b: the View menu — window scale and Appearance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the GUI's View menu gains Bigger (Ctrl-=), Smaller (Ctrl--), Fit Window (Ctrl-0), Snap
Window and an Appearance submenu (System, Light, Dark). `-scale N` and `-appearance` are new GUI
flags, and `scale` and `appearance` save through B1's store.

**Architecture:** the renderer already picks its own scale from the window: `paint` draws at
`bestScale(list, innerWidth × innerHeight)` and centers the result (`canvas/src/renderer.ts:253-255`).
So every scale command is a **window resize** in main. Main keeps one new piece of state,
`chosenScale: number | undefined` (undefined means fit), and `fit()` uses it. The arithmetic lives
in a new pure module, `gui/src/viewScale.ts`, because vitest cannot load `main.ts`. That is the same
reason `measure.ts` exists. Appearance is `nativeTheme.themeSource`. The menu follows 2a's pattern:
a pure template plus a state function in `menu.ts`, with items changed by id.

**Spec:** `docs/superpowers/specs/2026-11-24-appearance-while-running-design.md`, Part 2, GUI View
menu and Flags. 2a (the Options menu) was merged at `d73b892`.

**THE SOURCE BEATS THIS PLAN.** This plan was read at `d73b892`. Run
`npm run build && npm run typecheck && npx vitest run` after every task, because vitest does not
typecheck. Re-derive each task against the repo before dispatch: the snippets below are drafts.

## Facts established while planning (2026-11-27)

- **The window's scale today** comes from `fit()` (`gui/src/main.ts:1438-1444`). It runs on every
  frame and returns early unless the draw list's size changed. It then calls
  `win.setContentSize(list.width * s, list.height * s)` with `s = windowScale(list, workAreaSize)`,
  the largest integer that fits 80% of the work area (`measure.ts:8-20`).
- **The renderer follows the window.** A manual resize already repaints at the new best scale and
  letterboxes the remainder (`renderer.ts:253-274`). Snap is therefore
  `setContentSize(list × currentScale)`, where `currentScale = bestScale(list, getContentSize())`.
- **The chords are free.** `CTRL` in `canvas/src/keys.ts:122` binds `c r u ] q a d f k b t` and
  nothing among `= - 0`. The Ctrl branch (`:245-251`) returns `null` for an unbound key. The menu
  accelerators are `Ctrl+…` on every platform, like `Ctrl+K` and `Ctrl+B` (`menu.ts:510, 516`).
- **The accelerators cannot be driven by the keys seam.** `sendInputEvent` does not trigger menu
  accelerators (`menu.ts:91`). The seam's `menu:ID` step calls `item.click()` and ignores
  `enabled` (`docs/live-testing.md:964`). Task 5 therefore drives the items through `menu:ID`, and
  the chords are witnessed either with `xdotool` under Xvfb, if it is installed, or by the user on a
  desktop. **Say which.**
- **`Ctrl+=` and not `Ctrl+Plus`** for Bigger. On a US layout, `Plus` needs Shift. `=` is the key
  marked `+`, and it is what browsers bind for zoom in. The label reads "Bigger". Whether to add a
  second `Ctrl+Plus` item, for layouts with a separate `+` key such as the numeric keypad, is
  **deferred to the user** and is not built.
- **The store maps keys to flags** (`frontend/src/prefs.ts`, `PrefKey {key, flag, type}`, with
  types `string | bare | onoff | number`). The spec's `scale` key therefore needs a flag. The spec's
  flag table omits one, so this plan adds **`-scale N`**, GUI only, an integer of at least 1.
  Absent means fit. **This is a plan decision the user has not reviewed.**
- **The bound on Bigger is the full work area**, `bestScale(list, workAreaSize)`, and not Fit's 80%.
  Otherwise Bigger could never pass Fit. The window frame and the menu bar add height beyond the
  content size, so Task 5 measures whether the maximum scale's window fits on Xvfb. If it does not,
  the bound becomes `windowArea` and Bigger ends at Fit. Record the result.
- **Save** is `guiPrefsToSave(startupArgv, geometry, runtime)` (`guiPrefs.ts:55`). `RuntimeOptions`
  is `{scheme, highlightBold, cursorColor}` (`:47-52`). The scheme rule, "save if not the default
  or argv had one", is the rule for `appearance` too.
- **The menu** (`menu.ts`): the View submenu holds Keypad and Keyboard (`:505-520`).
  `applyChoiceStates` writes states by id and writes **only the true radio item**, because writing
  `checked = false` to a radio in Electron 44 checks it. Checkboxes have no such quirk (measured in
  2a). `optionsMenuStates` (`:387`) is the model for the new state function, and
  `refreshOptionsMenu` (`main.ts:1580`) is the model for the refresh.

## File structure

- Create `packages/gui/src/viewScale.ts` for the pure scale arithmetic, tested by
  `packages/gui/test/viewScale.test.ts`.
- Modify `packages/gui/src/args.ts` (`-scale`, `-appearance`, usage), `packages/frontend/src/prefs.ts`
  (two GUI keys), `packages/gui/src/guiPrefs.ts` (save), `packages/gui/src/menu.ts` (View items,
  `viewMenuStates`) and `packages/gui/src/main.ts` (wiring).
- For docs, update `README.md`, `docs/parity.md`, `docs/live-testing.md`, `docs/HANDOFF.md` and add
  a fragment under `changelog.d/`.

---

### Task 1: `viewScale.ts`, the pure arithmetic

**Files:** create `packages/gui/src/viewScale.ts` and `packages/gui/test/viewScale.test.ts`.

- [ ] **Failing tests** (draft):

```ts
import { describe, it, expect } from 'vitest';
import { maxScale, currentScale, stepScale, targetScale } from '../src/viewScale.js';

const list = { width: 720, height: 400 };          // any scale-1 draw list
const area = { width: 1920, height: 1080 };        // the work area

describe('viewScale', () => {
  it('maxScale is the largest scale that fits the WHOLE work area', () => {
    expect(maxScale(list, area)).toBe(2);           // 1080/400 = 2.7, 1920/720 = 2.67
  });
  it('currentScale reads the window back, floored, never below 1', () => {
    expect(currentScale(list, { width: 1500, height: 900 })).toBe(2);
    expect(currentScale(list, { width: 10, height: 10 })).toBe(1);
  });
  it('stepScale clamps to 1..max', () => {
    expect(stepScale(1, -1, 3)).toBe(1);
    expect(stepScale(1, +1, 3)).toBe(2);
    expect(stepScale(3, +1, 3)).toBe(3);
    // Above max only when the display shrank: Smaller goes one below the largest that fits.
    expect(stepScale(5, -1, 3)).toBe(2);
    expect(stepScale(5, +1, 3)).toBe(3);
  });
  it('targetScale: undefined is fit, a choice is clamped to max', () => {
    expect(targetScale(undefined, list, area)).toBe(windowScale(list, area));
    expect(targetScale(1, list, area)).toBe(1);
    expect(targetScale(9, list, area)).toBe(2);
  });
});
```

  Also `import { windowScale } from '../src/measure.js'`. The fit case must equal it, so there is
  one rule.
- [ ] **Implement** (draft):

```ts
import { bestScale, type Surface } from '@tn3270/canvas';
import { windowScale } from './measure.js';

type Area = { readonly width: number; readonly height: number };
export const maxScale = (list: Surface, workArea: Area): number => bestScale(list, workArea);
export const currentScale = (list: Surface, content: Area): number => bestScale(list, content);
export function stepScale(current: number, dir: 1 | -1, max: number): number {
  return Math.max(1, Math.min(max, Math.min(current, max) + dir));
}
export function targetScale(chosen: number | undefined, list: Surface, workArea: Area): number {
  return chosen === undefined ? windowScale(list, workArea) : Math.min(chosen, maxScale(list, workArea));
}
```

  Put the shrunken-display reason from the test in a comment on `stepScale`.
- [ ] **Commit:** `gui: viewScale -- the View menu's scale arithmetic`.

### Task 2: flags and keys, `-scale` and `-appearance`

**Files:** `packages/gui/src/args.ts`, `packages/frontend/src/prefs.ts`,
`packages/gui/test/args.test.ts`, and the prefs tests in `packages/frontend/test/`.

- [ ] **Failing tests:**
  - `-scale 3` gives `args.scale === 3`. `-scale 0`, `-scale 1.5`, `-scale x` and a missing value
    each throw a `UsageError` naming the accepted form ("a whole number, 1 or more").
  - `-appearance dark` gives `'dark'`, and likewise `light` and `system`. Anything else is a
    `UsageError` listing the three values. When the flag is absent, `args.appearance` is
    `undefined`, which means system.
  - The usage string names both flags. The usage-covers-every-flag test from sub-project A must
    pass without edits; if it needed one, that test is not doing its job.
  - `GUI_PREF_KEYS` contains `{key:'scale', flag:'-scale', type:'number'}` and
    `{key:'appearance', flag:'-appearance', type:'string'}`. `TUI_PREF_KEYS` contains neither.
    Find the test that asserts the TUI refuses or ignores GUI-only keys, the way it handles
    `cursorcolor`, and extend it.
  - A saved `{"scale": 2, "appearance": "light"}` loads to argv `-scale 2 -appearance light`.
- [ ] **Implement:** two cases in the `args.ts` switch beside `-cursorcolor` (`:193`), two fields
  in the args interface with doc comments, the usage line (`:103`), and the two keys appended to
  `GUI_PREF_KEYS` (`prefs.ts:38`).
- [ ] **Commit:** `gui: -scale and -appearance, saved as scale and appearance`.

### Task 3: the View menu template and its states

**Files:** `packages/gui/src/menu.ts` and `packages/gui/test/menu.test.ts`.

- [ ] **Failing tests:**
  - With handlers, View is: Keypad, Keyboard, separator, Bigger (`view-bigger`, `Ctrl+=`),
    Smaller (`view-smaller`, `Ctrl+-`), Fit Window (`view-fit`, `Ctrl+0`), Snap Window
    (`view-snap`, no accelerator), separator, then an Appearance submenu of radios
    `appearance-system`, `appearance-light` and `appearance-dark`.
  - Every View accelerator differs from every other accelerator in the template. Extend the
    existing distinct-ids-and-accelerators test, don't write a second one.
  - Without handlers (the old caller), View is still exactly Keypad and Keyboard.
  - `viewMenuStates({ current, max, appearance })` returns:
    - Bigger enabled iff `current < max`;
    - Smaller enabled iff `current > 1`;
    - Fit and Snap always enabled;
    - **exactly one** appearance state with `checked: true`, and no `checked: false`, for the radio
      quirk.
- [ ] **Implement:** add `onBigger`, `onSmaller`, `onFit`, `onSnap` and `onAppearance(a)` to
  `MenuHandlers`, optional like `onGeometry`. A caller without them gets no scale items. Add
  `export type Appearance = 'system' | 'light' | 'dark'`. Put it in `viewScale.ts` or `menu.ts`,
  wherever `args.ts` can import it without a cycle. `viewMenuStates` returns `ChoiceState[]` for
  `applyChoiceStates`.
- [ ] **Commit:** `gui: the View menu's scale and Appearance items and their states`.

### Task 4: wiring in `main.ts`, and the save

**Files:** `packages/gui/src/main.ts`, `packages/gui/src/guiPrefs.ts` and
`packages/gui/test/guiPrefs.test.ts`.

- [ ] **Failing tests** (`guiPrefs.test.ts`): `RuntimeOptions` gains `scale?: number` and
  `appearance: Appearance`.
  - `scale: 3` saves `scale: 3`. `scale: undefined` **deletes** `scale`, so a `-scale 2` in argv
    that Fit Window cleared is not saved back.
  - `appearance` is saved when it is not `'system'`, or when argv had one, which is the scheme's
    rule. Choosing System over a saved `dark` saves `system`.
  - Calls that pass no runtime behave as before.
- [ ] **Implement in `main.ts`:**
  - **Before any window is created:** `nativeTheme.themeSource = args.appearance ?? 'system'`.
    Keep `let appearance` as the live value.
  - `let chosenScale = args.scale` and `let lastList`, set in `send()`.
  - `fit(list, force = false)`: the early return is skipped when `force` is true, and the scale is
    `targetScale(chosenScale, list, workAreaSize)`. A geometry change therefore keeps the chosen
    scale, clamped to the new screen.
  - Each handler is a no-op until `lastList` is set:
    - `onBigger` and `onSmaller`:
      `chosenScale = stepScale(currentScale(lastList, contentSize), ±1, maxScale(lastList, area))`,
      then `fit(lastList, true)`.
    - `onFit`: `chosenScale = undefined`, then `fit(lastList, true)`.
    - `onSnap`: `chosenScale = currentScale(lastList, contentSize)`, then `fit(lastList, true)`.
      Snap records the scale, so a manual resize followed by Snap is what gets saved.
    - `onAppearance(a)`: set `nativeTheme.themeSource` and `appearance`, then refresh.
  - `refreshViewMenu()` applies `viewMenuStates`. Call it after every click, on the main window's
    `resize` event, and from `fit`. A manual resize changes `current`, so Bigger and Smaller can
    become enabled or disabled without a click.
  - **Seam logging**, so Task 5 can read results back: on every resize from a View command, write
    `view: scale=N content=WxH` to stdout under `SEAM_ACTIVE`, and `appearance: X` likewise. Model
    them on the `bell:` line (`main.ts`, the alarm handler).
  - Save passes `scale: chosenScale` and `appearance`.
  - `grep -n "setContentSize" main.ts` finds a second caller at `:506`, with `TN3270_GUI_SIZE`.
    Decide whether it must set `chosenScale` too, and write the answer in a comment.
- [ ] **Commit:** `gui: the View menu, live: Bigger, Smaller, Fit, Snap, Appearance`.

### Task 5: mutation check, the Xvfb witness, docs

No host is needed, because this is display-only and the spec's gate is "a live check under Xvfb".
Use 2a's replayed-trace witness (`docs/live-testing.md:950` onward, `TN3270_GUI_REPLAY` with
`vm370-logon-logoff.trace`, and the keys seam's `menu:ID` steps), and the toolchain recipe in the
same file. The environment may have reset: check `~/micromamba/envs/gui` first (memory:
rsp-environment-resets).

- [ ] **Mutations.** Each must fail a test. Revert after each one.
  1. `stepScale` does not clamp at `max`.
  2. `stepScale` does not floor at 1.
  3. `targetScale` ignores `chosen`.
  4. `targetScale` uses `windowArea` for the cap, so Bigger stops at Fit. If the Task 5 measurement
     chose this bound, invert the mutation.
  5. `viewMenuStates` enables Bigger at `max`.
  6. `viewMenuStates` writes `checked: false` to an appearance radio.
  7. The save keeps `scale` after Fit cleared it.
  8. The save drops `appearance` when it is `system` over a saved `dark`.
  9. `-scale 0` is accepted.
- [ ] **Witness under Xvfb.** Read every PNG back, because an Electron that quit writes nothing
  (memory: electron-quits-when-last-window-closes).
  - `menu:view-smaller` until Smaller is disabled. The logged `scale=` drops by one each step and
    stops at 1, and `content=` equals the list size times the scale.
  - `menu:view-bigger` up to the maximum. **Measure** whether the outer window fits the Xvfb
    screen, then record the bound decision from the Facts section.
  - Resize by hand with `TN3270_GUI_SIZE`, or with `win.setSize` through the seam if that is
    easier, then `menu:view-snap`. The content becomes an exact multiple, and the screenshot has no
    letterbox border.
  - `menu:view-fit` returns to the fit scale.
  - `menu:appearance-dark` and `menu:appearance-light`: the log line, and the About or Connect
    window's background changing in a screenshot. The terminal canvas must **not** change: compare
    the main window's image hashes.
  - Save after Bigger and Dark writes `"scale":N,"appearance":"dark"`. A relaunch from the saved
    file gives the same content size as a run with `-scale N -appearance dark`.
  - The chords Ctrl-=, Ctrl-- and Ctrl-0: use `xdotool` under Xvfb if it exists. Otherwise record
    them as **owed to the user on a desktop**, and do not claim them.
  - **Any surprise stops the merge** and goes to the user.
- [ ] **Docs:**
  - README: the View items, `-scale` and `-appearance`. Change the Staging line so that 2b is done
    and B2 is complete. The spec's deferred items keep their Staging lines.
  - `docs/parity.md`: find the rows that touch window size or font scaling (x3270's font menu and
    `-efont`) and update their `ours` truthfully. Bigger and Smaller step an integer scale of one
    bitmap font, which is not x3270's font list. Run `parity.mjs gate` and record the count.
  - A changelog fragment, `changelog.d/`, under Features.
  - `docs/live-testing.md`: the witness, with what was measured and what is owed.
  - HANDOFF.
- [ ] **Commit:** `docs, gui: 15b B2 Part 2b -- the View menu, the Xvfb witness, parity, changelog`.

## Not in this plan

- A `Ctrl+Plus` duplicate accelerator (see Facts).
- Live switching in the browser's Alt-M panel, vector fonts, a color picker and themes, which are
  the spec's deferred list.
- About's stale `Model:` line (known since 2a).
