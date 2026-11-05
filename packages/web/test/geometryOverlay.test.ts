import { describe, it, expect } from 'vitest';
import {
  createGeometryOverlay, parseGeometryChoices, CONNECTED_LINE, CONNECTING_LINE, GATEWAY_CLOSED_LINE,
  type GeometryChoices,
} from '../src/geometryOverlay.js';

/**
 * Fake elements, for the reason `environment: 'node'` always gives here: there is no `document`
 * and jsdom is not a dependency. Every element the overlay builds is one of these, so a test can
 * walk the tree, read `checked`/`disabled` and fire a `change` the way a click would.
 */
/** What the overlay reads off a real event. `detail` is a click's count: 0 for a keyboard click. */
interface Ev {
  type: string; detail?: number; key?: string; code?: string;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
  prevented?: boolean; stopped?: boolean;
  preventDefault(): void; stopPropagation(): void;
}
const ev = (fields: Partial<Ev> & { type: string }): Ev => ({
  ...fields,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
});

interface Fake {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  checked: boolean;
  disabled: boolean;
  children: Fake[];
  /** Every event the overlay subscribed to on this element, by the injected `listen`. */
  on: Array<{ types: readonly string[]; fn: (e: Ev) => void }>;
}

/** Fire `e` at whatever the overlay subscribed to on `el`. */
const fire = (el: Fake, e: Ev): void => {
  for (const l of el.on) if (l.types.includes(e.type)) l.fn(e);
};
/** A pointer click: `detail` 1, which no keyboard-induced click carries. */
const click = (el: Fake): void => { fire(el, ev({ type: 'click', detail: 1 })); };
const fake = (tag: string): Fake => ({
  tag, attrs: {}, text: '', checked: false, disabled: false, children: [], on: [],
});

function rig(start: { hidden: boolean } = { hidden: true }) {
  const element = { ...fake('div'), ...start };
  const root = fake('div');
  const status = fake('p');
  const sent: string[] = [];
  const o = createGeometryOverlay<Fake, Ev>({
    element, root, status,
    setHidden: (el, h) => { (el as Fake & { hidden: boolean }).hidden = h; },
    isHidden: (el) => (el as Fake & { hidden: boolean }).hidden,
    create: (tag) => fake(tag),
    append: (p, c) => { p.children.push(c); },
    setText: (el, t) => { el.text = t; },
    setAttr: (el, n, v) => { el.attrs[n] = v; },
    setChecked: (el, on) => { el.checked = on; },
    setDisabled: (el, on) => { el.disabled = on; },
    listen: (el, types, fn) => { el.on.push({ types, fn }); },
    send: (t) => { sent.push(t); },
  });
  const inputs = (): Fake[] => {
    const out: Fake[] = [];
    const walk = (f: Fake): void => { if (f.tag === 'input') out.push(f); f.children.forEach(walk); };
    walk(root);
    return out;
  };
  /** The Disconnect button, if built: the one `button` in the root. */
  const button = (): Fake | undefined => {
    const out: Fake[] = [];
    const walk = (f: Fake): void => { if (f.tag === 'button') out.push(f); f.children.forEach(walk); };
    walk(root);
    if (out.length > 1) throw new Error(`${out.length} buttons in the picker`);
    return out[0];
  };
  const input = (name: string, value: string): Fake => {
    const found = inputs().find((i) => i.attrs['name'] === name && i.attrs['value'] === value);
    if (found === undefined) throw new Error(`no ${name}=${value} input`);
    return found;
  };
  return { o, element, root, status, sent, inputs, input, button };
}

const MODELS = ['3278-2', '3278-2-E', '3278-3', '3278-3-E', '3278-4', '3278-4-E', '3278-5', '3278-5-E'];
const choices = (over: Partial<GeometryChoices> = {}): GeometryChoices => ({
  models: MODELS.map((m) => ({ name: m, label: `${m} (some size)` })),
  oversizes: [
    { name: 'none', label: 'None' }, { name: 'auto', label: 'Auto' },
    { name: 'startup', label: '160x62 (62 rows by 160 columns)' },
  ],
  current: { model: '3278-2-E', oversize: 'none' },
  connected: false,
  connecting: false,
  ...over,
});

describe('createGeometryOverlay', () => {
  it('starts HIDDEN, even when the element arrives shown', () => {
    // The four overlay rules' first: hidden in code AS WELL AS in the markup, and the shown start
    // is the case that tells "construction set it" from "it was already set".
    expect(rig().element.hidden).toBe(true);
    expect(rig({ hidden: false }).element.hidden).toBe(true);
  });

  it('toggle() shows, then hides; hide() ASSIGNS, so a second close cannot re-show', () => {
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    expect(r.element.hidden).toBe(false);
    expect(r.o.visible()).toBe(true);
    r.o.toggle();
    expect(r.element.hidden).toBe(true);
    r.o.toggle();
    r.o.hide();
    r.o.hide();
    expect(r.element.hidden).toBe(true);
  });

  it('builds NOTHING until it is first shown, and then builds ONCE', () => {
    const r = rig();
    r.o.update(choices());
    expect(r.inputs()).toHaveLength(0);              // lazy: never shown, nothing built
    r.o.toggle(); r.o.toggle(); r.o.toggle();
    r.o.update(choices({ current: { model: '3278-4-E', oversize: 'auto' } }));
    // Eight models and three oversizes, and NOT a second set: rebuilding would double them.
    expect(r.inputs()).toHaveLength(11);
  });

  it('shown before any choices arrive, it builds on the first update and still only once', () => {
    const r = rig();
    r.o.toggle();
    expect(r.inputs()).toHaveLength(0);
    r.o.update(choices());
    r.o.update(choices());
    expect(r.inputs()).toHaveLength(11);
  });

  it('labels each radio as the gateway sent it, models first, then the oversizes', () => {
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    const labels: string[] = [];
    const walk = (f: Fake): void => {
      if (f.tag === 'label') labels.push(f.children.find((c) => c.tag === 'span')!.text);
      f.children.forEach(walk);
    };
    walk(r.root);
    expect(labels).toEqual([
      ...MODELS.map((m) => `${m} (some size)`), 'None', 'Auto', '160x62 (62 rows by 160 columns)',
    ]);
    expect(r.inputs().every((i) => i.attrs['type'] === 'radio')).toBe(true);
  });

  it('checks the current model and oversize, and enables everything while disconnected', () => {
    const r = rig();
    r.o.update(choices({ current: { model: '3278-4-E', oversize: 'startup' } }));
    r.o.toggle();
    expect(r.inputs().filter((i) => i.checked).map((i) => i.attrs['value']))
      .toEqual(['3278-4-E', 'startup']);
    expect(r.inputs().some((i) => i.disabled)).toBe(false);
    expect(r.status.text).not.toBe(CONNECTED_LINE);
  });

  it('with connected:true DISABLES EVERY INPUT and says why', () => {
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    r.o.update(choices({ connected: true }));
    expect(r.inputs().every((i) => i.disabled)).toBe(true);
    expect(r.status.text).toBe('Disconnect first; the choice applies at the next connect.');
    // And back again on the disconnect.
    r.o.update(choices({ connected: false }));
    expect(r.inputs().some((i) => i.disabled)).toBe(false);
  });

  it('with connected:true AND connecting:true, disables everything but gives the IN-FLIGHT remedy', () => {
    // `connected` is `isConnected() || isConnecting()` (session.ts), so it is true in BOTH states,
    // and `Session.setGeometry` refuses both -- but with DIFFERENT text (session.ts ~:502-510):
    // `disconnect first` while actually connected, `wait for the connection attempt to finish`
    // while only connecting. `CONNECTED_LINE` gave the first remedy in both cases, which told an
    // operator watching a connect attempt to disconnect something that does not exist yet. Pinned
    // by core/test/oversize-session.test.ts's `setGeometry is refused while a reconnect() is in
    // flight` and its FIRST-connect sibling, both asserting the in-flight wording distinctly.
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    r.o.update(choices({ connected: true, connecting: true }));
    expect(r.inputs().every((i) => i.disabled)).toBe(true);
    expect(r.status.text).toBe(CONNECTING_LINE);
    expect(r.status.text).not.toBe(CONNECTED_LINE);
    // Settles into the ordinary connected remedy once the attempt lands.
    r.o.update(choices({ connected: true, connecting: false }));
    expect(r.status.text).toBe(CONNECTED_LINE);
    // And fully free once disconnected.
    r.o.update(choices({ connected: false, connecting: false }));
    expect(r.inputs().some((i) => i.disabled)).toBe(false);
  });

  it('after markGatewayClosed says the GATEWAY closed and disables everything, from every state', () => {
    // THE STALE PICKER, reported live 2026-11-05: after the gateway socket closed, the picker kept
    // its last `geometryChoices` and said "Disconnect first" -- a remedy that cannot work, since a
    // pick can no longer be sent. From connected, connecting AND free, the line must change.
    for (const [state, over] of [
      ['connected', { connected: true }],
      ['connecting', { connected: true, connecting: true }],
      ['free', {}],
      ['free with a notice', { notice: 'oversize is now None: something' }],
    ] as const) {
      const r = rig();
      r.o.update(choices(over));
      r.o.toggle();
      r.o.markGatewayClosed();
      expect(r.status.text, state).toBe(GATEWAY_CLOSED_LINE);
      expect(r.status.text, state).toBe('The connection to the gateway closed; reload to reconnect.');
      expect(r.inputs(), state).toHaveLength(11);
      expect(r.inputs().every((i) => i.disabled), state).toBe(true);
      // And nothing can be sent, even by a click the disabled radio would not deliver.
      click(r.input('geometry-model', '3278-4-E'));
      expect(r.sent, state).toEqual([]);
    }
  });

  it('closed BEFORE it is ever shown, it builds disabled with the closed line', () => {
    const r = rig();
    r.o.update(choices());
    r.o.markGatewayClosed();
    r.o.toggle();
    expect(r.status.text).toBe(GATEWAY_CLOSED_LINE);
    expect(r.inputs()).toHaveLength(11);
    expect(r.inputs().every((i) => i.disabled)).toBe(true);
  });

  it('closed before ANY choices arrived, it still says the gateway closed when shown', () => {
    const r = rig();
    r.o.markGatewayClosed();
    r.o.toggle();
    expect(r.status.text).toBe(GATEWAY_CLOSED_LINE);
    expect(r.inputs()).toHaveLength(0);
  });

  it('an update AFTER the close cannot resurrect a stale line or re-enable a choice', () => {
    // Unreachable on a real page (nothing arrives on a closed socket), so the decision is the
    // safe one: closed is final. A late `free` update must not re-enable radios whose picks
    // would be sent into a dead socket; its `current` IS still written, so the checks are true.
    const r = rig();
    r.o.update(choices({ connected: true }));
    r.o.toggle();
    r.o.markGatewayClosed();
    r.o.update(choices({ current: { model: '3278-4-E', oversize: 'auto' } }));
    expect(r.status.text).toBe(GATEWAY_CLOSED_LINE);
    expect(r.inputs().every((i) => i.disabled)).toBe(true);
    expect(r.inputs().filter((i) => i.checked).map((i) => i.attrs['value'])).toEqual(['3278-4-E', 'auto']);
    click(r.input('geometry-model', '3278-2'));
    expect(r.sent).toEqual([]);
  });

  /*
    THE DISCONNECT BUTTON, 2026-11-05 (user-approved): before it the picker could be used only after
    the HOST dropped the line. Enabled ONLY while actually connected -- not while connecting, since
    `Session.disconnect()` does nothing to an attempt in flight (a known core limitation) -- and not
    when free or once the gateway socket has closed.
  */
  it('puts a Disconnect button FIRST, before the two groups, built once', () => {
    const r = rig();
    r.o.update(choices({ connected: true }));
    r.o.toggle();
    const b = r.button()!;
    expect(b).toBeDefined();
    expect(b.text).toBe('Disconnect');
    expect(b.attrs['type']).toBe('button');
    expect(r.root.children[0]).toBe(b);
    expect(r.root.children.slice(1).map((c) => c.tag)).toEqual(['fieldset', 'fieldset']);
    r.o.update(choices());
    r.o.toggle(); r.o.toggle();
    expect(r.root.children).toHaveLength(3);
  });

  it('enables Disconnect ONLY while connected: not connecting, not free, not after the gateway closed', () => {
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    const b = r.button()!;
    expect(b.disabled, 'free').toBe(true);
    r.o.update(choices({ connected: true, connecting: true }));
    expect(b.disabled, 'connecting').toBe(true);
    expect(r.status.text, 'connecting keeps its own line').toBe(CONNECTING_LINE);
    r.o.update(choices({ connected: true }));
    expect(b.disabled, 'connected').toBe(false);
    expect(r.status.text).toBe(CONNECTED_LINE);
    r.o.update(choices());
    expect(b.disabled, 'free again').toBe(true);
    r.o.update(choices({ connected: true }));
    r.o.markGatewayClosed();
    expect(b.disabled, 'gateway closed').toBe(true);
  });

  it('a pointer click on Disconnect sends {kind:disconnect}, and only while connected', () => {
    const r = rig();
    r.o.update(choices({ connected: true }));
    r.o.toggle();
    click(r.button()!);
    expect(r.sent.map((t) => JSON.parse(t))).toEqual([{ kind: 'disconnect' }]);
    // A click the disabled button would not deliver must still send nothing, in every other state.
    for (const over of [{}, { connected: true, connecting: true }] as const) {
      r.sent.length = 0;
      r.o.update(choices(over));
      click(r.button()!);
      expect(r.sent, JSON.stringify(over)).toEqual([]);
    }
    r.o.update(choices({ connected: true }));
    r.o.markGatewayClosed();
    click(r.button()!);
    expect(r.sent).toEqual([]);
  });

  it('Enter or Space on Disconnect sends ONCE and stops there, so the host never gets the Enter', () => {
    // `renderer.ts`'s window keydown skips INPUTs but NOT buttons (`isEditableTarget`), so an Enter
    // that bubbled would also go to the host as an Enter AID. The button's own keydown claims both
    // keys -- preventDefault, so no native keyboard click follows, and stopPropagation -- and the
    // keyboard click a browser might still synthesise carries `detail` 0 and is ignored.
    for (const key of ['Enter', ' ']) {
      const r = rig();
      r.o.update(choices({ connected: true }));
      r.o.toggle();
      const e = ev({ type: 'keydown', key, code: key === ' ' ? 'Space' : 'Enter' });
      fire(r.button()!, e);
      fire(r.button()!, ev({ type: 'click', detail: 0 }));
      expect(r.sent.map((t) => JSON.parse(t)), JSON.stringify(key)).toEqual([{ kind: 'disconnect' }]);
      expect(e.prevented && e.stopped, JSON.stringify(key)).toBe(true);
    }
  });

  it('arrow keys and other keys on Disconnect send nothing and are left alone', () => {
    const r = rig();
    r.o.update(choices({ connected: true }));
    r.o.toggle();
    for (const key of ['ArrowDown', 'ArrowUp', 'Tab', 'a']) {
      const e = ev({ type: 'keydown', key, code: key });
      fire(r.button()!, e);
      expect(e.prevented || e.stopped, key).toBeFalsy();
    }
    expect(r.sent).toEqual([]);
  });

  it('Escape still closes the picker with Disconnect focused', () => {
    // The overlay's own keydown is on the ELEMENT, which a button's keydown bubbles to.
    const r = rig();
    r.o.update(choices({ connected: true }));
    r.o.toggle();
    const e = ev({ type: 'keydown', key: 'Escape', code: 'Escape' });
    fire(r.button()!, e);
    fire(r.element, e);
    expect(r.element.hidden).toBe(true);
    expect(r.sent).toEqual([]);
  });

  it('while FREE the line stays empty: Enter reconnects, and the OIA is what says so honestly', () => {
    // DECIDED 2026-11-05: no "Press Enter to reconnect" here. The picker cannot tell a session
    // that WAS connected (Enter reconnects: `reconnectInstead`) from one that never was (`--replay`,
    // where Enter does nothing), and the OIA's own `X Disconnected -- press Enter to reconnect`
    // already offers the key only when it works (`Oia.reconnectable`).
    const r = rig();
    r.o.update(choices({ connected: true }));
    r.o.toggle();
    r.o.update(choices());
    expect(r.status.text).toBe('');
  });

  it('shows a notice the gateway sent with its reply, in the picker beside the radio it moved', () => {
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    r.o.update(choices({ notice: 'oversize is now None: model 3278-4 has no extended data stream; '
      + 'pick 3278-4-E for an oversize' }));
    expect(r.status.text).toMatch(/^oversize is now None: model 3278-4/);
  });

  it('a click sends setGeometry with ONE field: the model, or the oversize name', () => {
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    click(r.input('geometry-model', '3278-4-E'));
    click(r.input('geometry-oversize', 'auto'));
    click(r.input('geometry-oversize', 'startup'));
    expect(r.sent.map((s) => JSON.parse(s))).toEqual([
      { kind: 'setGeometry', model: '3278-4-E' },
      { kind: 'setGeometry', oversize: 'auto' },
      { kind: 'setGeometry', oversize: 'startup' },
    ]);
  });

  it('ARROWING through a group sends NOTHING: change and keyboard clicks are not a pick', () => {
    /*
      THE DEFECT, found in review 2026-11-05: listening on `change` applied every radio an arrow
      key passed over -- and a model passed on the way can reset the oversize to None. Arrow keys in
      a radio group fire `change` AND a `click`, both with `detail` 0 (a keyboard click), so neither
      may count. A pick is a POINTER click (`detail` >= 1) or Enter/Space on the focused radio.
    */
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    const radio = r.input('geometry-model', '3278-3');
    fire(radio, ev({ type: 'change' }));
    fire(radio, ev({ type: 'click', detail: 0 }));
    fire(radio, ev({ type: 'keydown', key: 'ArrowDown', code: 'ArrowDown' }));
    expect(r.sent).toEqual([]);
    click(radio);
    expect(r.sent.map((t) => JSON.parse(t))).toEqual([{ kind: 'setGeometry', model: '3278-3' }]);
  });

  it('Enter or Space on the focused radio is the keyboard pick, sent ONCE', () => {
    // Space's own default checks the radio and fires a keyboard click (`detail` 0) after the
    // keydown; that click is ignored, so Space sends once, not twice.
    const r = rig();
    r.o.update(choices());
    r.o.toggle();
    const radio = r.input('geometry-oversize', 'auto');
    fire(radio, ev({ type: 'keydown', key: ' ', code: 'Space' }));
    fire(radio, ev({ type: 'click', detail: 0 }));
    const enter = ev({ type: 'keydown', key: 'Enter', code: 'Enter' });
    fire(radio, enter);
    expect(r.sent.map((t) => JSON.parse(t))).toEqual([
      { kind: 'setGeometry', oversize: 'auto' }, { kind: 'setGeometry', oversize: 'auto' },
    ]);
    // Enter's default is nothing useful here, and must not reach the page as a keystroke.
    expect(enter.prevented).toBe(true);
  });

  it('Escape and Alt+M CLOSE it from inside, even with a radio focused, and stop there', () => {
    /*
      `renderer.ts` ignores every keydown aimed at an INPUT -- the fix that keeps typed letters out
      of the host -- so with a radio focused the page-level Alt+M never ran and the picker could
      only be shut by its button (measured 2026-11-04). The overlay listens itself. `stopPropagation`
      so the window listener does not ALSO toggle it back open when focus is not on an input.
    */
    for (const e of [
      ev({ type: 'keydown', key: 'Escape', code: 'Escape' }),
      ev({ type: 'keydown', key: 'm', code: 'KeyM', altKey: true }),
      ev({ type: 'keydown', key: 'µ', code: 'KeyM', altKey: true }),   // Option-M on a Mac
    ]) {
      const r = rig();
      r.o.update(choices());
      r.o.toggle();
      expect(r.element.hidden).toBe(false);
      fire(r.element, e);
      expect(r.element.hidden, `${e.key} must close it`).toBe(true);
      expect(e.prevented && e.stopped, `${e.key} must stop at the overlay`).toBe(true);
    }
  });

  it('leaves every OTHER key alone, including Ctrl+Alt+M and plain m', () => {
    for (const e of [
      ev({ type: 'keydown', key: 'm', code: 'KeyM' }),
      ev({ type: 'keydown', key: 'm', code: 'KeyM', altKey: true, ctrlKey: true }),
      ev({ type: 'keydown', key: 'm', code: 'KeyM', altKey: true, metaKey: true }),
      ev({ type: 'keydown', key: 'Tab', code: 'Tab' }),
    ]) {
      const r = rig();
      r.o.update(choices());
      r.o.toggle();
      fire(r.element, e);
      expect(r.element.hidden, JSON.stringify(e)).toBe(false);
      expect(e.prevented || e.stopped, JSON.stringify(e)).toBeFalsy();
    }
  });
});

describe('parseGeometryChoices', () => {
  it('accepts what the gateway sends, and keeps only the known fields', () => {
    const c = choices({ notice: 'n' });
    expect(parseGeometryChoices({ kind: 'geometryChoices', ...c, extra: 1 })).toEqual(c);
    const { notice: _n, ...plain } = c;
    expect(parseGeometryChoices({ kind: 'geometryChoices', ...plain })).toEqual(plain);
  });

  it('THROWS on a malformed message, which the bridge then paints rather than drops', () => {
    for (const bad of [
      { models: 'x' },
      { models: [{ name: 1, label: 'a' }] },
      { oversizes: [{ name: 'huge', label: 'a' }] },
      { current: { model: '3278-2-E' } },
      { connected: 'no' },
      { connecting: 'no' },
      { notice: 5 },
    ]) {
      expect(() => parseGeometryChoices({ kind: 'geometryChoices', ...choices(), ...bad }),
        JSON.stringify(bad)).toThrow(/geometryChoices/);
    }
  });
});
