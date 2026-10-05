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
 */
export function copyAccelerator(platform: Platform): string {
  return platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C';
}

export function pasteAccelerator(platform: Platform): string {
  return platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V';
}

export interface MenuHandlers {
  readonly onCopy: () => void;
  readonly onPaste: () => void;
  /** Open the keypad window. OPEN, not toggle -- see the View menu below. */
  readonly onKeypad: () => void;
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
  const view: MenuItemTemplate = {
    label: 'View',
    submenu: [
      {
        label: 'Keypad',
        id: 'keypad',
        accelerator: 'Ctrl+K',
        ...(handlers !== undefined ? { click: handlers.onKeypad } : {}),
      },
    ],
  };
  // AN APP MENU IS MANDATORY ON macOS: without one the window gets NO menu bar at all, which is a
  // behavioral difference rather than a cosmetic one.
  return platform === 'darwin' ? [{ role: 'appMenu' }, edit, view] : [edit, view];
}
