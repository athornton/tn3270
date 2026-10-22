import { describe, it, expect } from 'vitest';
import { createKeypadUi, type KeypadDeps } from '../src/keypadUi.js';
import { KEYPAD_KEYS } from '@tn3270/frontend';

/**
 * A FAKE DOM, because `vitest.config.ts` sets `environment: 'node'` -- there is no `document` in
 * any test in this repo and jsdom is not a dependency.
 *
 * ## PRIMITIVES INJECTED, NOT A `render(fields)` SEAM
 *
 * `transferUi.ts` took the other option: it hands its boot file a `render(fields)` callback and
 * lets that file do the element building. The cost is visible in the line counts --
 * `transferBoot.ts` holds several hundred lines of UNTESTABLE code, comparable to the whole of the
 * testable `transferUi.ts` -- and the boot file is where this project's one blank-window bug
 * actually shipped (a TDZ read on an uninitialised `const`). Exact integers were cited here until
 * 2026-10-06 and rotted; the comparison is what matters.
 *
 * Injecting the primitives instead moves the element building into THIS testable module and
 * leaves the boot file as a handful of one-line adapters. The tradeoff is a wider deps interface;
 * the gain is that "48 buttons exist, each labelled and wired to its own action" is asserted by a
 * unit test rather than by a human looking at a window.
 */
interface FakeEl {
  tag: string;
  text: string;
  title: string;
  children: FakeEl[];
  onClick?: () => void;
  attrs: Record<string, string>;
}

function fakeDom(): { deps: KeypadDeps; root: FakeEl; sent: unknown[] } {
  const make = (tag: string): FakeEl => ({ tag, text: '', title: '', children: [], attrs: {} });
  const root = make('div');
  const sent: unknown[] = [];
  const deps = {
    root,
    create: make,
    append: (parent: FakeEl, child: FakeEl) => { parent.children.push(child); },
    setText: (el: FakeEl, text: string) => { el.text = text; },
    setTitle: (el: FakeEl, title: string) => { el.title = title; },
    setAttr: (el: FakeEl, name: string, value: string) => { el.attrs[name] = value; },
    onClick: (el: FakeEl, fn: () => void) => { el.onClick = fn; },
    sendAction: (action: unknown) => { sent.push(action); },
  } as unknown as KeypadDeps;
  return { deps, root, sent };
}

/** Every button in the tree, depth-first. */
function buttons(el: FakeEl): FakeEl[] {
  return el.tag === 'button' ? [el] : el.children.flatMap(buttons);
}

/** Press a button by its visible label, throwing rather than silently doing nothing. */
function press(root: FakeEl, label: string): void {
  const b = buttons(root).find((x) => x.text === label);
  if (b === undefined) throw new Error(`no button labelled ${label}`);
  if (b.onClick === undefined) throw new Error(`button ${label} has no click handler`);
  b.onClick();
}

describe('createKeypadUi', () => {
  it('builds a button for EVERY one of the 48 keys', () => {
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    expect(buttons(root)).toHaveLength(KEYPAD_KEYS.length);
  });

  it('labels each button as the key is labelled', () => {
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    const labels = buttons(root).map((b) => b.text).sort();
    expect(labels).toEqual([...KEYPAD_KEYS].map((k) => k.label).sort());
  });

  it('SENDS THE RIGHT ACTION for each key, all 48 of them', () => {
    /**
     * THE TABLE-WIDE VERSION, not a spot check, and it is the assertion this file exists for: a
     * label/action transposition is invisible on screen -- the button is drawn, it is labelled
     * correctly, and it sends the wrong thing to a live mainframe.
     *
     * `frontend/test/keypad.test.ts` pins label-to-action in the TABLE; this pins that the DOM
     * view wires each button to its OWN key's action rather than, say, every button to the first
     * key's. Those are different failures and the second one lives here.
     */
    const { deps, root, sent } = fakeDom();
    createKeypadUi(deps);
    for (const key of KEYPAD_KEYS) press(root, key.label);
    expect(sent).toEqual(KEYPAD_KEYS.map((k) => k.action));
  });

  it('wires the keys nothing else can reach', () => {
    /**
     * `SysRq` and `NewLn` have NO keyboard chord in any front end -- verified by enumerating all
     * 48 actions against `canvas/src/keys.ts`, where `sysreq` and `newline` are the only two
     * absent. So for those two the button is the ONLY route, and losing it makes a core
     * capability unreachable rather than merely inconvenient.
     *
     * `Dup` and `FldMk` are included because they are the usual suspects in this project's notes,
     * but they DO have chords (Ctrl-D/Ctrl-F, `canvas/src/keys.ts:77-78`): losing their buttons
     * would cost the mouse route only. Kept as a group of four since that is how the spec names
     * them, with the distinction recorded so a triage starts at the right two.
     */
    const { deps, root, sent } = fakeDom();
    createKeypadUi(deps);
    press(root, 'SysRq');
    press(root, 'NewLn');
    press(root, 'Dup');
    press(root, 'FldMk');
    expect(sent).toEqual([
      { kind: 'sysreq' }, { kind: 'newline' }, { kind: 'dup' }, { kind: 'fieldMark' },
    ]);
  });

  it('carries a non-empty tooltip on every button', () => {
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    for (const b of buttons(root)) {
      expect(b.title, `${b.text} has no tooltip`).not.toBe('');
    }
  });

  it('gives every button type=button, so none can submit a form', () => {
    // A bare <button> inside a form defaults to type=submit. There is no form in the keypad
    // window today, and this is what keeps a later one from turning a PF key into a page reload.
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    for (const b of buttons(root)) expect(b.attrs['type']).toBe('button');
  });

  it('carries data-label on every button, which is how the harness finds them', () => {
    // `clicks.mjs` queries BY LABEL (Task 8), deliberately: a coordinate list would be a second
    // copy of the layout and would pass while the layout was wrong. `data-label` is that handle,
    // separate from the visible text so a future icon cannot break the query.
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    const found = buttons(root).map((b) => b.attrs['data-label']).sort();
    expect(found).toEqual([...KEYPAD_KEYS].map((k) => k.label).sort());
  });

  it('groups the buttons under headings, one section per block', () => {
    // The grouping is the readability win over the canvas keypad's undifferentiated grid, so it
    // is asserted rather than assumed: six sections, each with a heading element.
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    const sections = root.children.filter((c) => c.attrs['class'] === 'keypad-block');
    expect(sections.length).toBeGreaterThanOrEqual(6);
    for (const s of sections) {
      const heading = s.children.find((c) => c.tag === 'h2');
      expect(heading, `a block has no heading`).toBeDefined();
      expect(heading!.text, 'a block heading is empty').not.toBe('');
    }
  });
});
