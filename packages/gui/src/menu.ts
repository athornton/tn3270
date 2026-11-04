/**
 * The application menu. THE FIRST ONE THIS APP HAS HAD -- `setApplicationMenu` was never called
 * before copy/paste needed somewhere to live.
 *
 * ## DELIBERATELY NOT THE FINAL MENU STRUCTURE
 *
 * Edit, View and (geometry sessions only) Model. A connect dialog is roadmapped and will
 * want menus too; guessing their shape now would be a second copy of a decision nobody has taken.
 *
 * ## THE TEMPLATE IS A PURE FUNCTION OF THE PLATFORM, WHICH IS WHY IT IS TESTABLE
 *
 * `process.platform` is read by the CALLER and passed in. A module that read it directly could only
 * be tested on the machine it runs on, and the whole point of the split below is that both halves
 * are asserted on every machine.
 *
 * ## IT IMPORTS NOTHING FROM `electron`, ALSO DELIBERATELY
 *
 * A plain data template, so vitest can call it with no Electron runtime at all. `main.ts` passes
 * the result to `Menu.buildFromTemplate`. That is the same split the transfer window used to stay
 * testable. `@tn3270/core` IS imported, by the Model menu below: it is plain data and pure
 * functions, and the model list and the size wording must come from the one place a connect
 * reads them, not from a copy here.
 */

import {
  KNOWN_MODELS, OversizeError, describeSize, resolveTerminalType,
  type GeometrySetting, type Oversize, type Size,
} from '@tn3270/core';

/** The platform strings this file distinguishes. `process.platform`'s type. */
export type Platform = 'darwin' | 'linux' | 'win32' | string;

/**
 * The menu roles this file uses.
 *
 * A LITERAL UNION AND NOT `string`, which is what lets `main.ts` pass the template to
 * `Menu.buildFromTemplate` with no cast at all: Electron's own `role` is a union of its 40-odd
 * role names, and `string` does not overlap with it -- TypeScript rejects even an `as` between
 * them ("neither type sufficiently overlaps"), which would have left a `as unknown as` double
 * cast in main. Naming only the role we actually use keeps that honest AND documents the
 * dependency; adding a role here is a one-word change.
 */
export type MenuRole = 'appMenu';

export interface MenuItemTemplate {
  readonly label?: string;
  readonly role?: MenuRole;
  readonly accelerator?: string;
  readonly id?: string;
  /** A literal union, for the reason `MenuRole` gives. Absent is Electron's `normal`. */
  readonly type?: 'radio' | 'separator';
  readonly checked?: boolean;
  readonly enabled?: boolean;
  readonly click?: () => void;
  /**
   * MUTABLE, UNLIKE EVERY FIELD BESIDE IT, and that asymmetry is deliberate rather than an
   * oversight to tidy. Electron's `MenuItemConstructorOptions.submenu` is a MUTABLE array, and a
   * `readonly` one is not assignable to it -- so a `readonly` here would force a double cast in
   * `main.ts` and switch off checking on the whole template to paper over one nested field.
   * Electron is entitled to sort or splice what it is given; `buildMenuTemplate` hands out a fresh
   * array on every call, so there is nothing shared for a caller to corrupt.
   */
  readonly submenu?: MenuItemTemplate[];
}

/**
 * Copy and paste accelerators.
 *
 * ## `Ctrl-C` STAYS CLEAR ON EVERY PLATFORM
 *
 * `canvas/src/keys.ts:72` binds it to `{kind:'clear'}` and the window says so at startup. Clear is
 * an AID needed constantly to dismiss VM's `MORE...` state. On macOS `Cmd` is free, so the native
 * key is available with no conflict; elsewhere `Ctrl-Shift-C` is the terminal-emulator convention,
 * adopted by gnome-terminal and VS Code's terminal for this very collision.
 *
 * REJECTED, and recorded so it is not revisited: "Ctrl-C copies when a selection exists, Clear when
 * it does not." That makes a DESTRUCTIVE AID conditional on invisible state -- the
 * one-path-does-X-and-another-doesn't shape this project has been bitten by at least five times --
 * and its failure mode is a missed Clear on a locked `MORE...` screen.
 *
 * ## THIS ACCELERATOR NOW SHARES ITS CHORD WITH A PAGE BINDING, AND THE OVERLAP IS UNMEASURED
 *
 * 2026-10-27, with the web copy gesture: `canvas/src/keys.ts` claims `Ctrl-Shift-C` in the keydown
 * listener, and on Linux/Windows that is this accelerator's chord. Both routes end at
 * `__tn3270Copy`, so a double fire would copy the same rect to the same clipboard -- idempotent,
 * but it would print `copy: N chars` TWICE, and `select.mjs` asserts on that line.
 *
 * **WHETHER THEY BOTH FIRE IS NOT KNOWN, AND THE HARNESSES HERE CANNOT ANSWER IT.** Measured
 * 2026-10-27: `webContents.sendInputEvent` -- the only input route any harness in this repo has,
 * all 20 call sites in `main.ts` -- **does not trigger menu accelerators at all.** The control run
 * that proves it: with a real `Ctrl+Shift+C` accelerator installed and the page's own keydown
 * listener disabled, the click handler still never fired, so nothing reached the menu. A probe
 * built on that seam therefore reports "no double fire" on every build, whether one exists or not,
 * which is worse than no probe. `xdotool`/`xte` are not on this box, so there is no real-key
 * injector to settle it.
 *
 * The analogous `Ctrl+Shift+V` case WAS measured to fire both -- `forwardPaste`'s docstring in
 * `canvas/src/forwardKeys.ts` is the single home for that measurement, cited here rather than
 * restated for the reason `pasteAccelerator` below spells out. That run predates this finding
 * about `sendInputEvent`, so treat a double fire as the LIKELY case rather than the disproven one. **It needs a human on a real desktop**, which the feature's
 * live pass already owes. If it doubles, the fix is to gate the page branch off `file:` the way
 * `forwardPaste` gates its listener, leaving this accelerator to own the chord in Electron.
 */
export function copyAccelerator(platform: Platform): string {
  return platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C';
}

/**
 * ## THIS ACCELERATOR IS THE GUI'S ONLY PASTE, AND THAT IS NOW LOAD-BEARING. 2026-10-26.
 *
 * `canvas/src/forwardKeys.ts`'s `forwardPaste` raises `{kind:'paste'}` from a real `paste` EVENT,
 * and `renderer.ts` installs it -- but it refuses to install on `file:`, which is what this app's
 * own window is. So the menu item below is the whole of this front end's paste.
 *
 * SO DO NOT "FIX" THE GUI'S MISSING `Ctrl+V` BY ADDING A `paste` ARM AND WIDENING THAT GATE. This
 * accelerator and the page's `paste` event OVERLAP rather than compose, so an arm plus a widened
 * gate is a DOUBLE PASTE into a 3270 field -- where a silently doubled dataset name can be a
 * valid different one, the failure `frontend/src/pasteAction.ts` exists to prevent.
 *
 * **`forwardPaste`'S DOCSTRING IS THE SINGLE HOME FOR THE MEASUREMENT** behind both of those
 * claims, and the Electron version it was taken on. Cited rather than restated ON PURPOSE: the
 * numbers were briefly copied into this comment and two others, which put one measurement in five
 * files and would have let an Electron upgrade falsify three of them at once -- the shape
 * `d4fce66` exists to stop. What belongs HERE is the instruction, not the evidence.
 *
 * A native `Ctrl+V` here is a real improvement and is deliberately NOT taken: it needs the
 * accelerator and the event reconciled (one of them has to stop firing), which is a decision
 * about this menu rather than a handler somebody can add.
 */
export function pasteAccelerator(platform: Platform): string {
  return platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V';
}

export interface MenuHandlers {
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  /** Open the keypad window. OPEN, not toggle -- see the View menu below. */
  readonly onKeypad: () => void;
  /** Open the full-keyboard window. OPEN, not toggle, for the same reason. */
  readonly onKeyboard: () => void;
  /**
   * One Model-menu choice. Optional, unlike the four above, because only a geometry-mode session
   * has a Model menu; the other handlers predate it and a caller without it is still complete.
   */
  readonly onGeometry?: (choice: GeometryChoice) => void;
}

/** What one Model-menu item asks for: ONE field, because one click changes one thing. */
export type GeometryChoice = { readonly model: string } | { readonly oversize: Oversize };

/**
 * What the Model menu is built from. `main.ts` reads it off the session each time.
 *
 * `startupFixed` is the `-oversize <cols>x<rows>` given at startup, if any: the spec's choices are
 * PICKED FROM LISTS, NOTHING TYPED (the user's decision, 2026-11-04), so the only fixed size the
 * menu can offer is the one already typed on the command line. A new size is `-oversize` or the
 * CLI's `Set(oversize,...)`.
 */
export interface GeometryMenu {
  readonly models: readonly string[];
  readonly current: GeometrySetting;
  readonly startupFixed?: Size;
  /** Every choice is disabled while true: `setGeometry` refuses a change while connected. */
  readonly connected: boolean;
}

/** One choice item's mutable state. `main.ts` applies these by id; see `modelMenuStates`. */
export interface ChoiceState {
  readonly id: string;
  readonly checked: boolean;
  readonly enabled: boolean;
}

/** The model a setting resolves to, as a `KNOWN_MODELS` key: `IBM-` stripped, core's casing. */
function currentModel(setting: GeometrySetting): string | undefined {
  try {
    // Core's own resolution, so an absent model is the product default (TERMINAL_TYPE, today
    // 3278-2-E) and `ibm-3278-5-e` is 3278-5-E -- exactly what a connect would advertise.
    return resolveTerminalType({ ...(setting.model !== undefined ? { model: setting.model } : {}) })
      .replace(/^IBM-/, '');
  } catch {
    return undefined; // a model core refuses checks nothing rather than guessing one
  }
}

/** Whether a fixed oversize is the startup one: only then is that item honestly checked. */
function isStartupFixed(o: Oversize, startup: Size | undefined): boolean {
  return o.kind === 'fixed' && startup !== undefined
    && o.rows === startup.rows && o.cols === startup.cols;
}

/**
 * Every choice item's `checked` and `enabled`, models first, then the oversize items, in menu
 * order.
 *
 * THE ONE SOURCE OF BOTH THE TEMPLATE AND `main.ts`'S UPDATES. After a click or a connect,
 * `main.ts` MUTATES the built items by id rather than rebuilding the application menu (a rebuild
 * re-creates the macOS app menu and every accelerator to change two booleans) -- and it must,
 * after EVERY click, refused or not: Electron checks a clicked radio item itself, before the
 * handler runs, so a refused choice would otherwise be left showing as chosen.
 */
export function modelMenuStates(g: GeometryMenu): ChoiceState[] {
  const enabled = !g.connected;
  const model = currentModel(g.current);
  const o = g.current.oversize;
  return [
    ...g.models.map((m) => ({ id: `model:${m}`, checked: m === model, enabled })),
    { id: 'oversize:none', checked: o.kind === 'none', enabled },
    { id: 'oversize:auto', checked: o.kind === 'auto', enabled },
    ...(g.startupFixed !== undefined
      ? [{ id: 'oversize:fixed', checked: isStartupFixed(o, g.startupFixed), enabled }]
      : []),
  ];
}

/** The two writable fields of a built Electron `MenuItem` this file touches. */
export interface MutableChoice { checked: boolean; enabled: boolean }

/**
 * Write `states` onto the BUILT menu, looking each item up with `get` (main.ts passes
 * `menu.getMenuItemById`). Pure in the same sense as the template: no Electron import, so the
 * radio rule below is pinned by a test.
 *
 * ONLY `checked = true` IS EVER WRITTEN, BECAUSE WRITING `false` CHECKS THE ITEM. MEASURED on
 * Electron 44.3.0 under Xvfb: in a radio group a/b/c with `a` checked, `c.checked = false` left
 * `c` CHECKED and `a` cleared, and `a.checked = false` on the checked `a` changed nothing -- any
 * assignment to a radio item's `checked` selects it. The first version of this loop wrote every
 * item's boolean and so left the LAST item of each group checked after every refresh, whatever
 * the session held. Selecting the one true item clears the rest of its group, which is all that is
 * needed. (A group with no true item does not arise: `setGeometry` refuses an unknown model, and
 * the only fixed size the menu can set is the startup one, which it offers.)
 */
export function applyChoiceStates(
  states: readonly ChoiceState[], get: (id: string) => MutableChoice | null,
): void {
  for (const st of states) {
    const item = get(st.id);
    if (item === null) continue;
    if (st.checked) item.checked = true;
    item.enabled = st.enabled;
  }
}

/**
 * The Model menu: the models as one radio group, a separator, and an Oversize submenu.
 *
 * EACH CHOICE IS DISABLED, NOT THE MENU. The spec says "the whole menu disabled while connected";
 * disabling every item gets that everywhere, where disabling the top-level item is a per-platform
 * question (on macOS a disabled top-level menu cannot even be opened to see what is current), and
 * `Alt-M` pops the SUBMENU up directly, past any parent item, so only per-item state reaches it.
 */
function modelMenu(g: GeometryMenu, onGeometry: ((c: GeometryChoice) => void) | undefined): MenuItemTemplate {
  const states = new Map(modelMenuStates(g).map((s) => [s.id, s]));
  const item = (id: string, label: string, choice: GeometryChoice): MenuItemTemplate => {
    const s = states.get(id)!;
    return {
      label, id, type: 'radio', checked: s.checked, enabled: s.enabled,
      ...(onGeometry !== undefined ? { click: () => { onGeometry(choice); } } : {}),
    };
  };
  const fixed = g.startupFixed;
  return {
    label: 'Model',
    id: 'model',
    submenu: [
      // The size in words beside each name, the spec's rule for every new message naming a size:
      // the names alone do not say that 3278-4 is the tall one.
      ...g.models.map((m) => {
        const alt = KNOWN_MODELS[m]?.alternate;
        return item(`model:${m}`, alt !== undefined ? `${m} (${describeSize(alt)})` : m, { model: m });
      }),
      { type: 'separator' },
      {
        label: 'Oversize',
        id: 'oversize',
        submenu: [
          item('oversize:none', 'None', { oversize: { kind: 'none' } }),
          item('oversize:auto', 'Auto', { oversize: { kind: 'auto' } }),
          // `<cols>x<rows>` as typed on `-oversize` (x3270's order), then the size in words.
          ...(fixed !== undefined
            ? [item('oversize:fixed', `${fixed.cols}x${fixed.rows} (${describeSize(fixed)})`,
              { oversize: { kind: 'fixed', rows: fixed.rows, cols: fixed.cols } })]
            : []),
        ],
      },
    ],
  };
}

/**
 * Apply one menu choice through `setGeometry`, and THE ORDER-DEPENDENCE RULE.
 *
 * A menu changes one thing per click, and core validates model and oversize TOGETHER -- the
 * CLI's `Set()` found that some single steps are refused (commit `1a4713e`): from a fixed 100x30,
 * model 3278-5-E alone is "use at least 132x27". The CLI's answer, both in one call, is not
 * available to a radio item. So: A MODEL CHOICE WINS. If the CURRENT oversize is what refuses it
 * (an `OversizeError`, and an oversize other than None to blame), the model is applied with
 * oversize None instead and the returned notice says so, outcome first so a truncated status line
 * still carries it, then core's own reason. Picking Oversize again afterwards is then a single,
 * valid-or-honestly-refused step.
 *
 * WHY THE MODEL WINS AND NOT THE OVERSIZE: the alternative is refusing, which leaves an operator
 * who wants 3278-5-E at 160x62 from 3278-2-E at 100x30 with no route at all -- the 160x62 they
 * want is not on the menu unless it was the startup size, and the model they want is refused.
 * Dropping to None always succeeds for a known model (None has no rule to break), so this rule
 * can always reach any model.
 *
 * AN OVERSIZE CHOICE IS NEVER FIXED UP by changing the model behind it: that would change the
 * thing the operator did not touch. Its refusal, and every refusal that is not the oversize's
 * fault (`disconnect first`, an unknown model), is thrown unchanged for the caller's `fail()`.
 *
 * `setGeometry` is a parameter so this is testable with no session and no Electron.
 */
export function applyGeometryChoice(
  current: GeometrySetting, choice: GeometryChoice, setGeometry: (next: GeometrySetting) => void,
): string | undefined {
  if (!('model' in choice)) {
    setGeometry({ ...current, oversize: choice.oversize });
    return undefined;
  }
  const next: GeometrySetting = { ...current, model: choice.model };
  try {
    setGeometry(next);
    return undefined;
  } catch (err) {
    if (!(err instanceof OversizeError) || current.oversize.kind === 'none') throw err;
    // The retry's own refusal, if any, is the one thrown: it describes the state that was tried
    // last, and None failing would mean something other than the oversize is wrong.
    setGeometry({ ...next, oversize: { kind: 'none' } });
    return `oversize is now None for model ${choice.model}; pick Oversize again to change it `
      + `(${err.message})`;
  }
}

/** The menu template for a platform. Handlers are optional so tests can inspect the shape. */
export function buildMenuTemplate(
  platform: Platform, handlers?: MenuHandlers, geometry?: GeometryMenu,
): readonly MenuItemTemplate[] {
  const edit: MenuItemTemplate = {
    label: 'Edit',
    submenu: [
      {
        label: 'Copy',
        id: 'copy',
        accelerator: copyAccelerator(platform),
        // SPREAD AND NOT `click: handlers?.onCopy`, because `exactOptionalPropertyTypes` is on:
        // an absent handler must leave the key ABSENT rather than present-and-undefined, which is
        // a distinction Electron itself acts on.
        ...(handlers !== undefined ? { click: handlers.onCopy } : {}),
      },
      {
        label: 'Paste',
        id: 'paste',
        accelerator: pasteAccelerator(platform),
        ...(handlers !== undefined ? { click: handlers.onPaste } : {}),
      },
    ],
  };
  /**
   * The keypad's MENU route, which is what makes it discoverable.
   *
   * `Ctrl-K` alone is undiscoverable: nothing on screen says the keypad exists, and an operator
   * who has not read the README has no way to find 48 keys behind an unannounced chord. x3270
   * solves this with a keyboard ICON in its own toolbar (`x3270/keypad.bm`, placed by
   * `menubar.c:604`, shipped at three sizes beside a TLS padlock); a menu item is the
   * Electron-native spelling of the same affordance, and this app now has a menu bar to put it in
   * -- which the copy/paste work added, and which was one of the stated reasons for doing that
   * feature first.
   *
   * THE ACCELERATOR IS NOT PLATFORM-SPLIT, unlike Copy and Paste. `Ctrl+K` collides with nothing
   * in the 3270 keyboard -- the collision that forced the Copy/Paste split was `Ctrl-C` being the
   * Clear AID -- and `Ctrl-K` is already c3270's own binding (`Common/fb-c3270:191`) plus the
   * TUI's, so an operator moving between front ends does not learn two spellings. `Alt-K` is
   * honored too, in `canvas/src/keys.ts`, because that is how x3270's Windows keymap spells the
   * same command; only one of them can be shown here, and `Ctrl-K` is the documented one.
   *
   * "KEYPAD" AND NOT "SHOW KEYPAD" OR A CHECKBOX, because this OPENS and does not toggle: the
   * window's own close button closes it. A checked menu item would promise a toggle and then
   * misreport the state the moment the operator closed the window instead.
   */
  /*
    THE FULL KEYBOARD IS THE SECOND VIEW ITEM, 2026-10-23, and everything the note above says
    about discoverability applies to it MORE strongly: the keypad is 48 keys an operator might
    guess at, and this is the entire 122-key 3279 layout behind a chord nothing announces.

    `Ctrl+B` IS NOT PLATFORM-SPLIT, for the reason given above: the Copy/Paste split exists ONLY
    because `Ctrl-C` is the Clear AID. `Ctrl-B` collides with nothing in the 3270 keyboard --
    `canvas/src/keys.ts:85` is its only binding -- so `Cmd+B` on macOS would diverge from the
    documented chord for no collision at all. `menu.test.ts` pins both halves of that.

    "KEYBOARD" BESIDE "KEYPAD", AND THE TWO WORDS ARE CLOSE ENOUGH TO BE A HAZARD. They differ by
    two letters and sit adjacent. That is tolerated rather than fixed with a longer label, because
    these are the names the whole project already uses -- the README, both chords' documentation,
    `KEYPAD_BLOCKS` and `KEYBOARD_3279` -- and inventing a third name for one surface in one menu
    would be worse than the adjacency. The accelerators differ, the ids differ, and a test asserts
    all three are distinct so a copy-paste that wires one to the other's handler fails.
  */
  const view: MenuItemTemplate = {
    label: 'View',
    submenu: [
      {
        label: 'Keypad',
        id: 'keypad',
        accelerator: 'Ctrl+K',
        ...(handlers !== undefined ? { click: handlers.onKeypad } : {}),
      },
      {
        label: 'Keyboard',
        id: 'keyboard',
        accelerator: 'Ctrl+B',
        ...(handlers !== undefined ? { click: handlers.onKeyboard } : {}),
      },
    ],
  };
  // AN APP MENU IS MANDATORY ON macOS: without one the window gets NO menu bar at all, which is a
  // behavioral difference rather than a cosmetic one.
  //
  // THE MODEL MENU ONLY WITH A GEOMETRY, so a caller that passes none gets exactly the old
  // template. `main.ts` passes none for a `--terminal-type` session, which has no model to switch.
  const menus = geometry !== undefined ? [edit, view, modelMenu(geometry, handlers?.onGeometry)] : [edit, view];
  return platform === 'darwin' ? [{ role: 'appMenu' }, ...menus] : menus;
}
