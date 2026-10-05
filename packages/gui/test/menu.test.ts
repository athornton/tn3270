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
    const t = buildMenuTemplate('linux', { onCopy: () => { copied++; }, onPaste: () => { pasted++; } });
    const items = (t.find((m) => m.label === 'Edit')!.submenu) as
      { label: string; click?: () => void }[];
    items.find((i) => i.label === 'Copy')!.click!();
    items.find((i) => i.label === 'Paste')!.click!();
    expect([copied, pasted]).toEqual([1, 1]);

    const bare = (buildMenuTemplate('linux').find((m) => m.label === 'Edit')!.submenu) as
      readonly Record<string, unknown>[];
    expect(Object.prototype.hasOwnProperty.call(bare[0]!, 'click')).toBe(false);
  });
});
