import { describe, it, expect } from 'vitest';
import { forwardKeys, isEditableTarget, type ForwardKeysDeps } from '../src/forwardKeys.js';
import type { Action } from '@tn3270/frontend';

/** A `keydown` event, as much of one as `actionForKey` and the predicate actually read. */
const ev = (o: {
  key: string; code?: string; ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean;
  tag?: string; editable?: boolean;
}): unknown => ({
  key: o.key,
  code: o.code ?? '',
  ctrlKey: o.ctrl === true,
  altKey: o.alt === true,
  metaKey: o.meta === true,
  shiftKey: o.shift === true,
  target: o.tag === undefined && o.editable === undefined
    ? null
    : { tagName: o.tag, isContentEditable: o.editable === true },
  preventDefault: () => {},
});

/**
 * A fake window, because vitest runs `environment: 'node'`: there is no `window` to listen on.
 *
 * The same injected-deps shape as `keyboardUi.test.ts`'s fake DOM and for the same reason -- what
 * is worth testing is which actions get forwarded and whether the default was prevented, neither
 * of which needs a real event loop. jsdom is deliberately not a dependency of this repo.
 */
function fake(): {
  deps: ForwardKeysDeps;
  readonly sent: Action[];
  readonly prevented: unknown[];
  fire: (e: unknown) => void;
} {
  const sent: Action[] = [];
  const prevented: unknown[] = [];
  let handler: ((e: unknown) => void) | undefined;
  return {
    sent,
    prevented,
    fire: (e) => {
      if (handler === undefined) throw new Error('forwardKeys registered no handler');
      // The real DOM calls `preventDefault` ON the event; the fake records which events had it
      // called, so "only claimed keys are prevented" is checkable.
      handler({ ...(e as object), preventDefault: () => { prevented.push(e); } });
    },
    deps: {
      on: (_type, fn) => { handler = fn as (e: unknown) => void; },
      sendAction: (a) => { sent.push(a); },
    },
  };
}

describe('forwardKeys', () => {
  it('forwards a claimed chord as its action', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'a', code: 'KeyA', ctrl: true }));
    expect(f.sent).toEqual([{ kind: 'attn' }]);
  });

  it('forwards a plain character as a type action', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'A', code: 'KeyA' }));
    expect(f.sent).toEqual([{ kind: 'type', text: 'A' }]);
  });

  it('forwards NOTHING for a key no table claims', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'z', code: 'KeyZ', ctrl: true }));
    expect(f.sent, 'Ctrl-Z is deliberately unclaimed').toEqual([]);
  });

  /*
    PREVENTDEFAULT ONLY FOR CLAIMED KEYS, asserted in BOTH directions.

    `renderer.ts` records why: preventing everything would break shortcuts we do not use and would
    stop Tab moving focus. A test that only checked the claimed case would pass an implementation
    that prevented every key.
  */
  it('prevents the default for a claimed key', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'a', code: 'KeyA', ctrl: true }));
    expect(f.prevented.length, 'a claimed key must be ours').toBe(1);
  });

  it('does NOT prevent the default for an unclaimed key', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'z', code: 'KeyZ', ctrl: true }));
    expect(f.prevented.length, 'an unclaimed key must reach the browser').toBe(0);
  });

  /*
    A FORM CONTROL IS SKIPPED EVEN WHEN THE KEY IS CLAIMED, which is the half that matters: a
    plain letter IS claimed (`{kind:'type'}`), so an implementation missing this check would send
    every character an operator typed into a field to the mainframe AND suppress it locally --
    exactly the live bug `renderer.ts` records from 2026-10-07.
  */
  it('skips an event aimed at a form control, claimed or not', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const f = fake();
      forwardKeys(f.deps);
      f.fire(ev({ key: 'A', code: 'KeyA', tag }));
      expect(f.sent, `${tag} must be left alone`).toEqual([]);
      expect(f.prevented.length, `${tag} must keep its default`).toBe(0);
    }
  });

  it('skips a contentEditable target too', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'A', code: 'KeyA', tag: 'DIV', editable: true }));
    expect(f.sent).toEqual([]);
  });

  it('listens for keydown and nothing else', () => {
    const types: string[] = [];
    forwardKeys({ on: (type) => { types.push(type); }, sendAction: () => {} });
    expect(types).toEqual(['keydown']);
  });
});

describe('isEditableTarget', () => {
  // EXPORTED AND TESTED DIRECTLY because `renderer.ts` imports it: it is a shared rule now, not a
  // private detail, and a change there must fail here rather than in a browser.
  it('is true for the three form tags and for contentEditable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget({ tagName }), tagName).toBe(true);
    }
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for a plain element, for null, and for a missing tagName', () => {
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });

  it('is false for a BUTTON, which every cap on these surfaces is', () => {
    // THE CASE THAT WOULD BREAK THE FEATURE if the predicate were widened to "any control":
    // the keyboard window is 118 buttons, and one of them has focus after every click.
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
  });
});
