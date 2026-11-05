import { describe, it, expect } from 'vitest';
import {
  createGeometryOverlay, parseGeometryChoices, CONNECTED_LINE, type GeometryChoices,
} from '../src/geometryOverlay.js';

/**
 * Fake elements, for the reason `environment: 'node'` always gives here: there is no `document`
 * and jsdom is not a dependency. Every element the overlay builds is one of these, so a test can
 * walk the tree, read `checked`/`disabled` and fire a `change` the way a click would.
 */
interface Fake {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  checked: boolean;
  disabled: boolean;
  children: Fake[];
  change?: () => void;
}
const fake = (tag: string): Fake => ({
  tag, attrs: {}, text: '', checked: false, disabled: false, children: [],
});

function rig(start: { hidden: boolean } = { hidden: true }) {
  const element = start;
  const root = fake('div');
  const status = fake('p');
  const sent: string[] = [];
  const o = createGeometryOverlay<Fake>({
    element: element as unknown as HTMLElement, root, status,
    create: (tag) => fake(tag),
    append: (p, c) => { p.children.push(c); },
    setText: (el, t) => { el.text = t; },
    setAttr: (el, n, v) => { el.attrs[n] = v; },
    setChecked: (el, on) => { el.checked = on; },
    setDisabled: (el, on) => { el.disabled = on; },
    onChange: (el, fn) => { el.change = fn; },
    send: (t) => { sent.push(t); },
  });
  const inputs = (): Fake[] => {
    const out: Fake[] = [];
    const walk = (f: Fake): void => { if (f.tag === 'input') out.push(f); f.children.forEach(walk); };
    walk(root);
    return out;
  };
  const input = (name: string, value: string): Fake => {
    const found = inputs().find((i) => i.attrs['name'] === name && i.attrs['value'] === value);
    if (found === undefined) throw new Error(`no ${name}=${value} input`);
    return found;
  };
  return { o, element, root, status, sent, inputs, input };
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
    r.input('geometry-model', '3278-4-E').change!();
    r.input('geometry-oversize', 'auto').change!();
    r.input('geometry-oversize', 'startup').change!();
    expect(r.sent.map((s) => JSON.parse(s))).toEqual([
      { kind: 'setGeometry', model: '3278-4-E' },
      { kind: 'setGeometry', oversize: 'auto' },
      { kind: 'setGeometry', oversize: 'startup' },
    ]);
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
      { notice: 5 },
    ]) {
      expect(() => parseGeometryChoices({ kind: 'geometryChoices', ...choices(), ...bad }),
        JSON.stringify(bad)).toThrow(/geometryChoices/);
    }
  });
});
