import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS, TERMINAL_TYPE, describeSize, type Oversize,
} from '@tn3270/core';
import type { GeometryChoice } from '@tn3270/frontend';
import {
  buildMenuTemplate, modelMenuStates, applyChoiceStates, type MutableChoice, type GeometryMenu,
} from '../src/menu.js';

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

    const bare = (buildMenuTemplate('linux').find((m) => m.label === 'Edit')!.submenu)!;
    expect(Object.prototype.hasOwnProperty.call(bare[0]!, 'click')).toBe(false);
    const bareView = (buildMenuTemplate('linux').find((m) => m.label === 'View')!.submenu)!;
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

/**
 * THE MODEL MENU, 2026-11-04: model and oversize picked from lists while disconnected, applied at
 * the next connect (the spec's "Step 2"). The template is still pure, so all of it is asserted
 * here with no Electron runtime; `main.ts` only builds it and mutates `checked`/`enabled` by id.
 */
describe('the Model menu', () => {
  type Item = {
    label?: string; id?: string; type?: string; checked?: boolean; enabled?: boolean;
    click?: () => void; submenu?: Item[];
  };
  const MODELS = Object.keys(KNOWN_MODELS);
  const base = { models: MODELS, connected: false } as const;
  const none: Oversize = { kind: 'none' };
  const modelMenu = (t: readonly unknown[]): Item =>
    (t as Item[]).find((m) => m.id === 'model')!;
  const choices = (m: Item): Item[] => {
    const own = m.submenu!.filter((i) => i.type === 'radio');
    const os = m.submenu!.find((i) => i.id === 'oversize')!;
    return [...own, ...os.submenu!];
  };

  it('is absent without a geometry, so the template is exactly the old one', () => {
    // A LITERAL of the pre-Model-menu template, not buildMenuTemplate compared with itself.
    const edit = { label: 'Edit', submenu: [
      { label: 'Copy', id: 'copy', accelerator: 'Ctrl+Shift+C' },
      { label: 'Paste', id: 'paste', accelerator: 'Ctrl+Shift+V' },
    ] };
    const view = { label: 'View', submenu: [
      { label: 'Keypad', id: 'keypad', accelerator: 'Ctrl+K' },
      { label: 'Keyboard', id: 'keyboard', accelerator: 'Ctrl+B' },
    ] };
    expect(buildMenuTemplate('linux')).toEqual([edit, view]);
    expect(buildMenuTemplate('win32', undefined, undefined)).toEqual([edit, view]);
    const mac = (a: string): string => a.replace('Ctrl+Shift+', 'Cmd+');
    expect(buildMenuTemplate('darwin')).toEqual([{ role: 'appMenu' },
      { ...edit, submenu: edit.submenu.map((i) => ({ ...i, accelerator: mac(i.accelerator) })) },
      view]);
  });

  it('lists the eight models, a separator, then an Oversize submenu of None and Auto', () => {
    const m = modelMenu(buildMenuTemplate('linux', undefined, { ...base, current: { oversize: none } }));
    expect(m.label).toBe('Model');
    // AFTER Disconnect and its separator (2026-11-05), pinned in their own case below.
    const sub = m.submenu!.slice(2);
    expect(sub.slice(0, 8).map((i) => [i.type, i.label, i.id])).toEqual(
      MODELS.map((k) => ['radio', `${k} (${describeSize(KNOWN_MODELS[k]!.alternate)})`, `model:${k}`]));
    expect(sub[6]!.label).toBe('3278-5 (27 rows by 132 columns)');
    expect(MODELS).toHaveLength(8);
    expect(sub[8]!.type).toBe('separator');
    expect(sub[9]!.label).toBe('Oversize');
    expect(sub[9]!.id).toBe('oversize');
    expect(sub).toHaveLength(10);
    expect(sub[9]!.submenu!.map((i) => [i.type, i.label, i.id])).toEqual([
      ['radio', 'None', 'oversize:none'],
      ['radio', 'Auto', 'oversize:auto'],
    ]);
  });

  it('comes after Edit and View, on every platform', () => {
    expect(buildMenuTemplate('linux', undefined, { ...base, current: { oversize: none } })
      .map((m) => m.label)).toEqual(['Edit', 'View', 'Model']);
    expect(buildMenuTemplate('darwin', undefined, { ...base, current: { oversize: none } })
      .map((m) => m.role ?? m.label)).toEqual(['appMenu', 'Edit', 'View', 'Model']);
  });

  it('offers the startup fixed size third, labelled cols x rows and then in words', () => {
    const m = modelMenu(buildMenuTemplate('linux', undefined, {
      ...base, current: { oversize: none }, startupFixed: { rows: 62, cols: 160 },
    }));
    const os = m.submenu!.find((i) => i.id === 'oversize')!.submenu!;
    expect(os.map((i) => [i.label, i.id])).toEqual([
      ['None', 'oversize:none'],
      ['Auto', 'oversize:auto'],
      ['160x62 (62 rows by 160 columns)', 'oversize:fixed'],
    ]);
  });

  it('checks the current model and oversize, and only those', () => {
    const m = modelMenu(buildMenuTemplate('linux', undefined, {
      ...base, current: { model: '3278-4-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } },
      startupFixed: { rows: 62, cols: 160 },
    }));
    expect(choices(m).filter((i) => i.checked === true).map((i) => i.id))
      .toEqual(['model:3278-4-E', 'oversize:fixed']);
    const auto = modelMenu(buildMenuTemplate('linux', undefined, {
      ...base, current: { model: '3278-3', oversize: { kind: 'auto' } },
    }));
    expect(choices(auto).filter((i) => i.checked === true).map((i) => i.id))
      .toEqual(['model:3278-3', 'oversize:auto']);
  });

  it('does not check the startup size for a different fixed oversize', () => {
    // Only reachable from outside this menu (the menu can only set the startup size), but a
    // checked "160x62" while the session holds 100x30 would be a menu that lies.
    const m = modelMenu(buildMenuTemplate('linux', undefined, {
      ...base, current: { oversize: { kind: 'fixed', rows: 30, cols: 100 } },
      startupFixed: { rows: 62, cols: 160 },
    }));
    expect(choices(m).filter((i) => i.checked === true).map((i) => i.id)).toEqual(['model:3278-2-E']);
  });

  it('checks the product default, 3278-2-E, when no model was named', () => {
    // From core's TERMINAL_TYPE, not a literal in menu.ts.
    expect(TERMINAL_TYPE).toBe('IBM-3278-2-E');
    const m = modelMenu(buildMenuTemplate('linux', undefined, { ...base, current: { oversize: none } }));
    expect(choices(m).filter((i) => i.checked === true).map((i) => i.id))
      .toEqual(['model:3278-2-E', 'oversize:none']);
  });

  it('checks a model given in another spelling, as core would resolve it', () => {
    const m = modelMenu(buildMenuTemplate('linux', undefined, {
      ...base, current: { model: 'ibm-3278-5-e', oversize: none },
    }));
    expect(choices(m).filter((i) => i.checked === true).map((i) => i.id))
      .toEqual(['model:3278-5-E', 'oversize:none']);
  });

  it('enables every choice while disconnected and disables every one while connected', () => {
    const geom = { ...base, current: { oversize: none }, startupFixed: { rows: 62, cols: 160 } };
    const off = choices(modelMenu(buildMenuTemplate('linux', undefined, geom)));
    expect(off).toHaveLength(11);
    expect(off.every((i) => i.enabled === true)).toBe(true);
    const on = choices(modelMenu(buildMenuTemplate('linux', undefined, { ...geom, connected: true })));
    expect(on).toHaveLength(11);
    expect(on.every((i) => i.enabled === false)).toBe(true);
  });

  it('gives every item in the whole template a unique id', () => {
    const ids: string[] = [];
    const walk = (items: readonly Item[]): void => {
      for (const i of items) {
        if (i.id !== undefined) ids.push(i.id);
        if (i.submenu !== undefined) walk(i.submenu);
      }
    };
    walk(buildMenuTemplate('darwin', undefined, {
      ...base, current: { oversize: none }, startupFixed: { rows: 30, cols: 100 },
    }) as Item[]);
    expect(ids.length).toBeGreaterThan(11);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hands the handler the choice each item names, and omits click with no handler', () => {
    const got: GeometryChoice[] = [];
    const t = buildMenuTemplate('linux', {
      onCopy: () => {}, onPaste: () => {}, onKeypad: () => {}, onKeyboard: () => {},
      onGeometry: (c) => { got.push(c); },
    }, { ...base, current: { oversize: none }, startupFixed: { rows: 62, cols: 160 } });
    for (const i of choices(modelMenu(t))) i.click!();
    expect(got).toEqual([
      ...MODELS.map((model) => ({ model })),
      { oversize: { kind: 'none' } },
      { oversize: { kind: 'auto' } },
      { oversize: { kind: 'fixed', rows: 62, cols: 160 } },
    ]);
    const bare = choices(modelMenu(buildMenuTemplate('linux', undefined, {
      ...base, current: { oversize: none },
    })));
    expect(bare.some((i) => Object.prototype.hasOwnProperty.call(i, 'click'))).toBe(false);
  });

  /*
    THE DISCONNECT ITEM, 2026-11-05 (user-approved): before it the Model menu could be used only
    after the HOST dropped the line. A NORMAL item, not a radio, so Electron 44's radio quirk
    (`applyChoiceStates`) does not touch it -- only `enabled` is ever written.
  */
  it('puts a Disconnect item FIRST, then a separator, then the models', () => {
    const sub = modelMenu(buildMenuTemplate('linux', undefined, { ...base, current: { oversize: none } })).submenu!;
    expect(sub[0]!.label).toBe('Disconnect');
    expect(sub[0]!.id).toBe('model-disconnect');
    expect(sub[0]!.type).toBeUndefined();
    expect('checked' in sub[0]!).toBe(false);
    expect(sub[1]!.type).toBe('separator');
    expect(sub[2]!.id).toBe('model:3278-2');
  });

  it('enables Disconnect ONLY while actually connected: not connecting, not free', () => {
    const at = (g: Partial<GeometryMenu>): boolean | undefined =>
      modelMenu(buildMenuTemplate('linux', undefined, { ...base, current: { oversize: none }, ...g }))
        .submenu![0]!.enabled;
    expect(at({ connected: false })).toBe(false);
    expect(at({ connected: true })).toBe(true);
    expect(at({ connected: true, connecting: true })).toBe(false);
  });

  it('calls onDisconnect from the item, and omits click with no handler', () => {
    let n = 0;
    const t = buildMenuTemplate('linux', {
      onCopy: () => {}, onPaste: () => {}, onKeypad: () => {}, onKeyboard: () => {},
      onDisconnect: () => { n += 1; },
    }, { ...base, connected: true, current: { oversize: none } });
    modelMenu(t).submenu![0]!.click!();
    expect(n).toBe(1);
    const bare = modelMenu(buildMenuTemplate('linux', undefined, { ...base, current: { oversize: none } }));
    expect('click' in bare.submenu![0]!).toBe(false);
  });

  it('reports Disconnect\'s state through modelMenuStates too, enabled only, never checked', () => {
    const states = (g: Partial<GeometryMenu>) =>
      modelMenuStates({ ...base, current: { oversize: none }, ...g });
    expect(states({ connected: true })[0]).toEqual({ id: 'model-disconnect', enabled: true });
    expect(states({ connected: true, connecting: true })[0]).toEqual({ id: 'model-disconnect', enabled: false });
    expect(states({})[0]).toEqual({ id: 'model-disconnect', enabled: false });
  });

  it('reports the same states through modelMenuStates, which main.ts mutates by id', () => {
    const geom = {
      ...base, connected: true, startupFixed: { rows: 62, cols: 160 },
      current: { model: '3278-4-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } } as const,
    };
    const fromTemplate = choices(modelMenu(buildMenuTemplate('linux', undefined, geom)))
      .map((i) => ({ id: i.id, checked: i.checked, enabled: i.enabled }));
    expect(modelMenuStates(geom).filter((st) => st.id !== 'model-disconnect')).toEqual(fromTemplate);
  });
});

/**
 * THE BUILT MENU IS MUTATED, and Electron's radio items do not behave like booleans: MEASURED on
 * 44.3.0, ANY assignment to a radio item's `checked`, `false` included, selects it and clears its
 * group. The fake below models exactly that, so a loop that writes `checked = false` fails here.
 */
describe('applyChoiceStates', () => {
  const electronLikeRadios = (groups: string[][]): Map<string, MutableChoice> => {
    const items = new Map<string, MutableChoice>();
    for (const group of groups) {
      for (const id of group) {
        let checked = false;
        const item: MutableChoice = {
          enabled: true,
          get checked() { return checked; },
          set checked(_v: boolean) {
            for (const other of group) (items.get(other) as unknown as { _clear(): void })._clear();
            checked = true;
          },
        };
        Object.defineProperty(item, '_clear', { value: () => { checked = false; } });
        items.set(id, item);
      }
    }
    return items;
  };

  it('leaves exactly the session\'s choices checked, on radios where false means select', () => {
    const geom = {
      models: Object.keys(KNOWN_MODELS), connected: false, startupFixed: { rows: 62, cols: 160 },
      current: { model: '3278-2-E', oversize: { kind: 'none' } } as const,
    };
    const states = modelMenuStates(geom);
    const modelIds = states.filter((s) => s.id.startsWith('model:')).map((s) => s.id);
    const osIds = states.filter((s) => s.id.startsWith('oversize:')).map((s) => s.id);
    const items = electronLikeRadios([modelIds, osIds]);
    items.get('model:3278-5-E')!.checked = true;   // what a click on 3278-5-E leaves behind
    items.get('oversize:fixed')!.checked = true;
    applyChoiceStates(states, (id) => items.get(id) ?? null);
    expect([...items].filter(([, i]) => i.checked).map(([id]) => id))
      .toEqual(['model:3278-2-E', 'oversize:none']);
  });

  it('never writes checked on the Disconnect item, which is a normal item', () => {
    // A write would be harmless on a normal item today, but the state carries no `checked` at all,
    // so nothing can turn it into a radio-quirk write later by accident.
    const writes: string[] = [];
    const item = {
      enabled: false,
      get checked() { return false; },
      set checked(_v: boolean) { writes.push('checked'); },
    };
    applyChoiceStates(modelMenuStates({
      models: Object.keys(KNOWN_MODELS), connected: true, current: { oversize: { kind: 'none' } },
    }), (id) => (id === 'model-disconnect' ? item : null));
    expect(writes).toEqual([]);
    expect(item.enabled).toBe(true);
  });

  it('writes enabled onto every item, and skips an id the menu does not have', () => {
    const a: MutableChoice = { checked: false, enabled: true };
    const b: MutableChoice = { checked: false, enabled: true };
    applyChoiceStates([
      { id: 'a', checked: false, enabled: false },
      { id: 'gone', checked: true, enabled: false },
      { id: 'b', checked: false, enabled: false },
    ], (id) => (id === 'a' ? a : id === 'b' ? b : null));
    expect([a.enabled, b.enabled]).toEqual([false, false]);
  });
});
