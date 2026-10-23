import { describe, it, expect } from 'vitest';
import { buildMenuTemplate } from '../src/menu.js';

describe('the Edit menu accelerators are PLATFORM-SPLIT', () => {
  it('uses Cmd-C / Cmd-V on macOS, where Cmd is free', () => {
    const t = buildMenuTemplate('darwin');
    const edit = t.find((m) => m.label === 'Edit')!;
    const items = edit.submenu as { label: string; accelerator?: string }[];
    expect(items.find((i) => i.label === 'Copy')?.accelerator).toBe('Cmd+C');
    expect(items.find((i) => i.label === 'Paste')?.accelerator).toBe('Cmd+V');
  });

  it('uses Ctrl-Shift-C / Ctrl-Shift-V elsewhere, BECAUSE Ctrl-C IS CLEAR', () => {
    /**
     * `canvas/src/keys.ts:72` binds `c` to `{kind:'clear'}`, and its docstring explains why:
     * Clear is an AID a user needs constantly to dismiss VM's `MORE...` state, "so the usual
     * instinct for escaping cannot be the way out". Ctrl-Shift-C is what terminal users already
     * expect for exactly this conflict (gnome-terminal, VS Code's terminal).
     */
    const t = buildMenuTemplate('linux');
    const edit = t.find((m) => m.label === 'Edit')!;
    const items = edit.submenu as { label: string; accelerator?: string }[];
    expect(items.find((i) => i.label === 'Copy')?.accelerator).toBe('Ctrl+Shift+C');
    expect(items.find((i) => i.label === 'Paste')?.accelerator).toBe('Ctrl+Shift+V');
  });

  it('NEVER binds a bare Ctrl-C anywhere in the template', () => {
    // A regression guard with teeth: binding Ctrl+C here would steal Clear from the 3270 keyboard
    // and the theft would be invisible until someone met a MORE... screen.
    //
    // THE QUOTES IN THE PATTERN ARE LOAD-BEARING. `"Ctrl+C"` as a JSON string value cannot match
    // inside `"Ctrl+Shift+C"`, so the legitimate Linux accelerator does not trip it; a bare
    // `Ctrl+C` substring check WOULD match it and this guard would be unfailable.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const flat = JSON.stringify(buildMenuTemplate(platform));
      expect(flat, `${platform} bound a bare Ctrl+C, which is Clear`).not.toContain('"Ctrl+C"');
    }
  });

  it('includes an app menu on macOS, which the platform requires', () => {
    // Without one, a Mac window gets no menu bar at all -- not a cosmetic difference.
    expect(buildMenuTemplate('darwin')[0]!.role).toBe('appMenu');
    expect(buildMenuTemplate('linux')[0]!.label).toBe('Edit');
  });

  it('wires the handlers it is given, and omits click entirely when given none', () => {
    // The shape tests above pass `undefined` handlers, so nothing there would notice a template
    // that dropped the clicks -- and a menu whose items do nothing is the whole feature failing
    // silently. `exactOptionalPropertyTypes` is on, so an absent `click` must be ABSENT and not
    // `undefined`: Electron treats a present-but-undefined click differently from no click.
    let copied = 0;
    let pasted = 0;
    let keypad = 0;
    let keyboard = 0;
    const t = buildMenuTemplate('linux', {
      onCopy: () => { copied++; },
      onPaste: () => { pasted++; },
      onKeypad: () => { keypad++; },
      onKeyboard: () => { keyboard++; },
    });
    const items = (t.find((m) => m.label === 'Edit')!.submenu) as
      { label: string; click?: () => void }[];
    items.find((i) => i.label === 'Copy')!.click!();
    items.find((i) => i.label === 'Paste')!.click!();
    // THE VIEW MENU'S HANDLER TOO, and each is checked to fire its OWN callback: three items
    // wired to one handler would satisfy a "something was called" assertion.
    const viewItems = (t.find((m) => m.label === 'View')!.submenu) as
      { label: string; click?: () => void }[];
    viewItems.find((i) => i.label === 'Keypad')!.click!();
    /*
      AND THE KEYBOARD'S, which is the one most likely to be wired to the keypad's handler by a
      copy-paste: the two items sit side by side and differ by one word. Each counter is separate
      precisely so that mistake fails here -- `[1, 1, 1, 1]` cannot be reached by one handler
      firing twice.
    */
    viewItems.find((i) => i.label === 'Keyboard')!.click!();
    expect([copied, pasted, keypad, keyboard]).toEqual([1, 1, 1, 1]);

    const bare = (buildMenuTemplate('linux').find((m) => m.label === 'Edit')!.submenu) as
      readonly Record<string, unknown>[];
    expect(Object.prototype.hasOwnProperty.call(bare[0]!, 'click')).toBe(false);
    const bareView = (buildMenuTemplate('linux').find((m) => m.label === 'View')!.submenu) as
      readonly Record<string, unknown>[];
    expect(Object.prototype.hasOwnProperty.call(bareView[0]!, 'click')).toBe(false);
  });

  it('offers the keypad on a View menu, on every platform', () => {
    /**
     * `Ctrl-K` ALONE IS UNDISCOVERABLE -- nothing on screen says 48 keys exist behind it -- so the
     * menu item is what makes the keypad findable. x3270 uses a keyboard icon in its own toolbar
     * for the same purpose; a menu item is the Electron-native spelling.
     *
     * ASSERTED ON EVERY PLATFORM because this accelerator is NOT platform-split, unlike Copy and
     * Paste. That split exists only because `Ctrl-C` is the Clear AID; `Ctrl+K` collides with
     * nothing in the 3270 keyboard and is already c3270's and the TUI's binding.
     */
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const view = buildMenuTemplate(platform).find((m) => m.label === 'View');
      expect(view, `${platform} has no View menu`).toBeDefined();
      const items = view!.submenu as { label: string; accelerator?: string }[];
      expect(items.find((i) => i.label === 'Keypad')?.accelerator).toBe('Ctrl+K');
    }
  });

  it('does NOT give the keypad a platform-split accelerator', () => {
    // The inverse of the Copy/Paste rule, pinned so nobody "fixes" an inconsistency that is
    // deliberate: Cmd+K on macOS would diverge from c3270 and the TUI for no collision at all.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const flat = JSON.stringify(buildMenuTemplate(platform));
      expect(flat, `${platform} bound Cmd+K`).not.toContain('"Cmd+K"');
    }
  });

  it('offers the full KEYBOARD on the same View menu, on every platform', () => {
    /**
     * THE SECOND SURFACE, `Ctrl-B`, undiscoverable for the same reason the keypad is: nothing on
     * screen says 118 caps exist behind a chord.
     *
     * `Ctrl+B` IS NOT PLATFORM-SPLIT EITHER, and the reason is the keypad's: the Copy/Paste split
     * exists ONLY because `Ctrl-C` is the Clear AID. `Ctrl-B` collides with nothing in the 3270
     * keyboard -- `canvas/src/keys.ts:85` is the only binding -- so `Cmd+B` on macOS would
     * diverge from the chord the README documents for no collision at all.
     */
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const view = buildMenuTemplate(platform).find((m) => m.label === 'View');
      expect(view, `${platform} has no View menu`).toBeDefined();
      const items = view!.submenu as { label: string; accelerator?: string }[];
      expect(items.find((i) => i.label === 'Keyboard')?.accelerator).toBe('Ctrl+B');
      expect(JSON.stringify(buildMenuTemplate(platform)), `${platform} bound Cmd+B`)
        .not.toContain('"Cmd+B"');
    }
  });

  /**
   * THE TWO ITEMS MUST BE DISTINGUISHABLE, which is a real hazard rather than a hypothetical one.
   *
   * "Keypad" and "Keyboard" differ by two letters and sit adjacent in one menu. An operator has to
   * be able to tell which is which, and the `id`s have to differ or a future `getMenuItemById`
   * would silently find the wrong one.
   */
  it('gives the two View items distinct labels, ids and accelerators', () => {
    const items = buildMenuTemplate('linux').find((m) => m.label === 'View')!
      .submenu as { label: string; id?: string; accelerator?: string }[];
    expect(items.map((i) => i.label)).toEqual(['Keypad', 'Keyboard']);
    expect(new Set(items.map((i) => i.id)).size, 'the two View items share an id').toBe(2);
    expect(new Set(items.map((i) => i.accelerator)).size,
      'the two View items share an accelerator').toBe(2);
  });
});
