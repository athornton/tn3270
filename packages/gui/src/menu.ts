/**
 * The application menu. THE FIRST ONE THIS APP HAS HAD -- `setApplicationMenu` was never called
 * before copy/paste needed somewhere to live.
 *
 * ## DELIBERATELY NOT THE FINAL MENU STRUCTURE
 *
 * Edit only. The keypad window's toolbar icon and a connect dialog are both roadmapped and will
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
 * testable.
 */

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
}

/** The menu template for a platform. Handlers are optional so tests can inspect the shape. */
export function buildMenuTemplate(
  platform: Platform, handlers?: MenuHandlers,
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
  return platform === 'darwin' ? [{ role: 'appMenu' }, edit, view] : [edit, view];
}
