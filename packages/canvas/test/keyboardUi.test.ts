import { describe, it, expect } from 'vitest';
import { createKeyboardUi, type KeyboardDeps } from '../src/keyboardUi.js';
import type { Action } from '@tn3270/frontend';

interface FakeEl {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  title: string;
  clicks: Array<() => void>;
}

/**
 * A fake DOM, because vitest runs `environment: 'node'` and there is no `document`.
 *
 * The same shape as `keypadUi.test.ts`'s and for the same reason: what is worth testing here is
 * which buttons exist, what each sends, and the one-shot Shift -- none of which needs a real
 * element. jsdom is deliberately not a dependency of this repo.
 */
function fakeDeps(): KeyboardDeps & { readonly sent: Action[]; readonly els: FakeEl[] } {
  const sent: Action[] = [];
  const els: FakeEl[] = [];
  const mk = (tag: string): HTMLElement => {
    const rec: FakeEl = { tag, attrs: {}, text: '', title: '', clicks: [] };
    els.push(rec);
    return rec as unknown as HTMLElement;
  };
  const rec = (el: HTMLElement): FakeEl => el as unknown as FakeEl;
  return {
    sent,
    els,
    root: mk('div'),
    create: mk,
    append: () => {},
    setText: (el, text) => { rec(el).text = text; },
    setTitle: (el, title) => { rec(el).title = title; },
    setAttr: (el, name, value) => { rec(el).attrs[name] = value; },
    removeAttr: (el, name) => { delete rec(el).attrs[name]; },
    onClick: (el, fn) => { rec(el).clicks.push(fn); },
    sendAction: (a) => { sent.push(a); },
  };
}

/** Find a button by its `data-key`, which is the cap's NAME. */
function button(deps: ReturnType<typeof fakeDeps>, name: string): FakeEl {
  const el = deps.els.find((e) => e.tag === 'button' && e.attrs['data-key'] === name);
  if (el === undefined) throw new Error(`no button named ${JSON.stringify(name)}`);
  return el;
}

/** Click a button by cap name. */
function click(deps: ReturnType<typeof fakeDeps>, name: string): void {
  for (const fn of button(deps, name).clicks) fn();
}

describe('createKeyboardUi', () => {
  it('draws a button for every cap in the table', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    const buttons = deps.els.filter((e) => e.tag === 'button');
    expect(buttons.length).toBeGreaterThanOrEqual(110);
  });

  it('sends a cap action on click', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    click(deps, 'PF3');
    expect(deps.sent).toEqual([{ kind: 'pf', n: 3 }]);
  });

  it('sends a typed character for a letter', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    click(deps, 'Q');
    expect(deps.sent).toEqual([{ kind: 'type', text: 'Q' }]);
  });

  it('carries the cap WIDTH as a custom property, so the CSS owns the pitch', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    expect(button(deps, 'Space').attrs['style']).toBe('--kb-w:7');
    expect(button(deps, 'Q').attrs['style']).toBe('--kb-w:1');
  });

  it('addresses buttons by NAME rather than label, since labels repeat and one is empty', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    // `Enter` appears on the main block AND the numeric pad; the spacebar's label is ''.
    expect(button(deps, 'Enter').attrs['data-key']).toBe('Enter');
    expect(button(deps, 'Enter (numeric pad)').attrs['data-key']).toBe('Enter (numeric pad)');
    expect(button(deps, 'Space').text).toBe('');
  });

  describe('the two bands, which stop the regions stacking into a column', () => {
    it('puts the PF strip in its OWN band and the other four regions in a second', () => {
      /*
        MEASURED DEFECT, 2026-10-22: the regions were appended straight to the root as plain
        `div`s, so all five STACKED VERTICALLY -- a column the user's very wide monitor still could
        not show at once. There was no horizontal layout at all, so this was not a narrow-screen
        fallback; it was the only thing the markup could do, at any width.

        THE ASSERTION IS ON THE STRUCTURE, NOT ON PIXELS. A unit test cannot measure a layout, but
        it can prove the two containers exist and that each region went to the right one -- which
        is what the CSS needs in order to lay them out side by side.
      */
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const bands = deps.els.filter((e) => e.attrs['class'] === 'keyboard-band');
      expect(bands, 'exactly two bands: the PF strip, and everything else').toHaveLength(2);
      const ids = deps.els
        .filter((e) => e.attrs['class'] === 'keyboard-band')
        .map((e) => e.attrs['id']);
      expect(ids).toEqual(['keyboard-band-pf', 'keyboard-band-main']);
    });

    it('OFFSETS A ROW THAT DOES NOT START AT ZERO, so the arrows form an inverted T', () => {
      /*
        A `keyboard-row` is a flex container, so every cap packed FLUSH LEFT and `KeyCap.x` was
        ignored entirely. The geometry happened to look right only because every other row starts
        at 0 -- the cursor cluster's `up` arrow sits at x=1 to be directly above `down`, and it was
        drawn hard against the left edge, so the inverted-T read as an L. The user caught it on a
        screenshot.

        ASSERTED ON THE EMITTED PADDING, which is what a unit test can see: there is no layout
        engine here, so this proves the row CARRIES the offset and leaves "does it line up" to the
        browser harness, which measures real boxes.
      */
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const rows = deps.els.filter((e) => e.attrs['class'] === 'keyboard-row');
      const offset = rows.filter((r) => r.attrs['style'] !== undefined);
      expect(offset, 'exactly one row has an offset today: the up arrow').toHaveLength(1);
      expect(offset[0]?.attrs['style']).toContain('padding-left');
      // ONE KEY UNIT, which is what puts `up` above `down`.
      expect(offset[0]?.attrs['style']).toContain('1 *');
      // And the rows that start at 0 must NOT carry a padding, or every row would shift right.
      expect(rows.length - offset.length, 'every other row starts flush left')
        .toBeGreaterThan(10);
    });

    it('creates a region container for every region in the table', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const regions = deps.els.filter((e) => e.attrs['class'] === 'keyboard-region');
      expect(regions, 'pf, special-left, main, cursor, numpad').toHaveLength(5);
      for (const r of regions) {
        expect(r.attrs['id'], 'each region is identified for the CSS and for a harness')
          .toMatch(/^keyboard-/);
      }
    });
  });

  describe('inert caps', () => {
    it('MARKS AN INERT CAP DISABLED', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      expect(button(deps, 'Escape (not a 3270 key)').attrs['disabled']).toBeDefined();
    });

    it('GIVES AN INERT CAP NO CLICK HANDLER AT ALL, so the no-op cannot be got wrong', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const esc = button(deps, 'Escape (not a 3270 key)');
      expect(esc.clicks, 'a handler would be a second place for the no-op to be wrong')
        .toHaveLength(0);
      click(deps, 'Escape (not a 3270 key)');
      expect(deps.sent).toEqual([]);
    });

    it('does NOT mark an actionable cap disabled', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      expect(button(deps, 'PF3').attrs['disabled']).toBeUndefined();
    });

    it('does NOT mark SHIFT disabled, though it has no action either', () => {
      // An inert cap and an actionless-but-LIVE cap must look different: `ui.css` greys
      // `[disabled]`, and Shift is a working control.
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const shift = deps.els.find((e) => e.attrs['data-shift'] === 'true');
      expect(shift?.attrs['disabled'], 'Shift must not be greyed out').toBeUndefined();
    });
  });

  describe('the one-shot Shift', () => {
    const SHIFT_L = 'Shift (left, one-shot)';
    const SHIFT_R = 'Shift (right, one-shot)';

    it('sends the SHIFTED text for the next character, then disarms', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, SHIFT_L);
      click(deps, '@ 2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '@' }]);
      click(deps, '@ 2');
      expect(deps.sent, 'disarmed, so the second press is unshifted')
        .toEqual([{ kind: 'type', text: '@' }, { kind: 'type', text: '2' }]);
    });

    it('A KEY WITH NO shiftLabel DOES NOT CONSUME THE ARM', () => {
      /*
        THE RULE MOST LIKELY TO BE IMPLEMENTED WRONGLY, asserted in both directions.

        3270 has no shifted PF3. If a PF key ate the arm, the operator would press Shift, reach
        for a character and find it unshifted -- a modifier that feels broken. The user's
        specification is a one-shot that survives until a CHARACTER uses it.
      */
      const deps = fakeDeps();
      const ui = createKeyboardUi(deps);
      click(deps, SHIFT_L);
      click(deps, 'PF3');
      expect(deps.sent).toEqual([{ kind: 'pf', n: 3 }]);
      expect(ui.shiftArmed(), 'the arm must SURVIVE a PF key').toBe(true);
      click(deps, '@ 2');
      expect(deps.sent[1]).toEqual({ kind: 'type', text: '@' });
    });

    it('is not consumed by an INERT cap either', () => {
      const deps = fakeDeps();
      const ui = createKeyboardUi(deps);
      click(deps, SHIFT_L);
      click(deps, 'Escape (not a 3270 key)');
      expect(ui.shiftArmed()).toBe(true);
    });

    it('disarms when Shift is pressed again, so a misclick is undoable', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, SHIFT_L);
      click(deps, SHIFT_L);
      click(deps, '@ 2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '2' }]);
    });

    it('BOTH Shift caps drive the SAME state, neither being distinguishable to us', () => {
      const deps = fakeDeps();
      const ui = createKeyboardUi(deps);
      click(deps, SHIFT_L);
      expect(ui.shiftArmed()).toBe(true);
      click(deps, SHIFT_R);
      expect(ui.shiftArmed(), 'the right cap must disarm what the left armed').toBe(false);
      click(deps, SHIFT_R);
      click(deps, '@ 2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '@' }]);
    });

    it('RE-LETTERS the dual-glyph caps when armed, and puts them back', () => {
      /*
        THE USER'S IDEA: "display the unshifted one by default and if the user clicks shift or caps
        lock, go to the shifted one". A cap should SHOW what it will send.
      */
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const two = button(deps, '@ 2');
      expect(two.text, 'unshifted by default').toBe('2');
      click(deps, SHIFT_L);
      expect(two.text, 'armed: the cap shows what it will send').toBe('@');
      click(deps, SHIFT_L);
      expect(two.text, 'disarmed: back to the unshifted legend').toBe('2');
    });

    it('PUTS THE LEGENDS BACK when the one-shot is CONSUMED, not only when toggled off', () => {
      // The arm is spent by typing a character, which is the whole point of a one-shot -- so the
      // caps must re-letter on THAT path too, not just on a second Shift press.
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const six = button(deps, '¢ 6');
      click(deps, SHIFT_L);
      expect(six.text).toBe('¢');
      click(deps, '@ 2');                 // consumes the arm
      expect(six.text, 'the arm was spent, so every cap reverts').toBe('6');
    });

    it('re-letters on disarmShift(), which is what closing the surface calls', () => {
      const deps = fakeDeps();
      const ui = createKeyboardUi(deps);
      const two = button(deps, '@ 2');
      click(deps, SHIFT_L);
      expect(two.text).toBe('@');
      ui.disarmShift();
      expect(two.text).toBe('2');
    });

    it('LEAVES A LETTER ALONE, because a letter has no shifted legend to show', () => {
      // `A` sends `A` unshifted on this keyboard, so there is nothing to re-letter -- and this is
      // also why Caps Lock stays inert: it would have no visible effect at all.
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const q = button(deps, 'Q');
      click(deps, SHIFT_L);
      expect(q.text, 'a letter must not flicker').toBe('Q');
    });

    it('leaves an INERT cap and the Shift caps themselves alone', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const esc = button(deps, 'Escape (not a 3270 key)');
      const shift = button(deps, SHIFT_L);
      click(deps, SHIFT_L);
      expect(esc.text).toBe('Esc');
      // `Shft`, the abbreviation that fits a 1.25-unit cap -- the point of the assertion is that
      // the cap keeps its OWN label rather than being re-lettered, not what that label spells.
      expect(shift.text, 'the Shift cap keeps its own label').toBe('Shft');
    });

    it('RE-LETTERS EVERY dual cap, not just the one that gets clicked', () => {
      // A keyboard where only the next key pressed re-lettered would be worse than none: the
      // operator cannot tell in advance which key they are about to press.
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const named = ['@ 2', '# 3', '¢ 6', '& 7', ': ;'];
      const before = named.map((n) => button(deps, n).text);
      click(deps, SHIFT_L);
      const after = named.map((n) => button(deps, n).text);
      for (let i = 0; i < named.length; i++) {
        expect(after[i], `${named[i]} should have re-lettered`).not.toBe(before[i]);
      }
    });

    it('raises NO action of its own: Shift is pure surface state', () => {
      // Nothing may cross the socket or the IPC boundary when Shift is pressed, which is why the
      // Action union needs no `shift` member.
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, SHIFT_L);
      expect(deps.sent).toEqual([]);
    });

    it('PAINTS BOTH CAPS when armed, and unpaints them when not', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      const caps = () => deps.els.filter((e) => e.attrs['data-shift'] === 'true');
      expect(caps()).toHaveLength(2);
      click(deps, SHIFT_L);
      for (const c of caps()) expect(c.attrs['data-armed']).toBe('true');
      click(deps, '@ 2');
      for (const c of caps()) expect(c.attrs['data-armed']).toBeUndefined();
    });

    it('reports and clears its state, which is how closing the surface disarms it', () => {
      // The sixth of the user's rules: a keyboard reopened later must not be holding a Shift
      // nobody remembers pressing. The overlay's `onHide` calls this.
      const deps = fakeDeps();
      const ui = createKeyboardUi(deps);
      expect(ui.shiftArmed()).toBe(false);
      click(deps, SHIFT_L);
      expect(ui.shiftArmed()).toBe(true);
      ui.disarmShift();
      expect(ui.shiftArmed()).toBe(false);
      click(deps, '@ 2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '2' }]);
    });

    it('does nothing surprising when a character is pressed UNARMED', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, '@ 2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '2' }]);
    });
  });
});
