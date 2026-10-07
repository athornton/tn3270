import { describe, it, expect } from 'vitest';
import { createKeypadOverlay } from '../src/keypadOverlay.js';

/**
 * A fake element, for the reason `environment: 'node'` always gives here: there is no `document`
 * in any test in this repo and jsdom is not a dependency. Only `hidden` is read or written, so
 * only `hidden` is faked.
 */
function fakeEl(): { hidden: boolean } {
  return { hidden: true };
}

describe('createKeypadOverlay', () => {
  it('starts HIDDEN, so every page load begins with no keypad', () => {
    /**
     * The user's no-persistence decision, confirmed on its merits: "making the user reopen the
     * keypad on each new application start, if they need it, is fine."
     *
     * It is also the GATEWAY's own existing rule, which matters more here than in the GUI: the
     * README records that a REATTACHING browser client must not inherit someone else's keypad
     * flag. A session resumed in a new tab starts closed, exactly as a fresh one does.
     *
     * Asserted even though the markup also carries `hidden`: belt and braces is the point, since
     * either one alone can be removed by someone who sees the other.
     */
    const el = fakeEl();
    createKeypadOverlay({ element: el as unknown as HTMLElement, build: () => {} });
    expect(el.hidden).toBe(true);
  });

  it('toggle() shows, then hides', () => {
    const el = fakeEl();
    const o = createKeypadOverlay({ element: el as unknown as HTMLElement, build: () => {} });
    o.toggle();
    expect(el.hidden).toBe(false);
    o.toggle();
    expect(el.hidden).toBe(true);
  });

  it('BUILDS THE BUTTONS ONCE, not on every toggle', () => {
    /**
     * 48 buttons rebuilt per keystroke is work nobody can see -- and it would also discard
     * whatever had focus, which is the observable half: tab to a button, hide, show, and the
     * caret is gone.
     *
     * Counted rather than spied on a boolean, because "built once" and "built at least once" are
     * different claims and only the first is correct.
     */
    let built = 0;
    const el = fakeEl();
    const o = createKeypadOverlay({
      element: el as unknown as HTMLElement, build: () => { built += 1; },
    });
    o.toggle(); o.toggle(); o.toggle();
    expect(built).toBe(1);
  });

  it('does NOT build until the first toggle', () => {
    // LAZY, deliberately: most sessions never open the keypad, and building 48 buttons at page
    // load would cost every session for the few that do. The GUI's window is lazy for the same
    // reason -- it is not created until `Ctrl-K`.
    let built = 0;
    const el = fakeEl();
    createKeypadOverlay({ element: el as unknown as HTMLElement, build: () => { built += 1; } });
    expect(built).toBe(0);
  });

  it('hide() closes it, and is safe when it is already closed', () => {
    // The close button needs this, and so does a future Escape binding. Idempotent because a
    // second close must not re-show -- which is what a naive `hidden = !hidden` here would do.
    const el = fakeEl();
    const o = createKeypadOverlay({ element: el as unknown as HTMLElement, build: () => {} });
    o.toggle();
    o.hide();
    expect(el.hidden).toBe(true);
    o.hide();
    expect(el.hidden).toBe(true);
  });
});

describe('the construction-time hide, from a VISIBLE starting state', () => {
  it('hides an element that arrives shown, which the default fake cannot detect', () => {
    // A MUTATION GAP FOUND 2026-10-07 while building the transfer overlay against this precedent:
    // deleting `deps.element.hidden = true` from the constructor reddened NOTHING, because the
    // fake above starts at `hidden: true` and the test could not tell "construction set it" from
    // "it was already set". Starting visible is what makes the assignment observable -- and it is
    // the realistic case the line exists for, markup whose `hidden` attribute someone removed.
    const el = { hidden: false } as unknown as HTMLElement;
    createKeypadOverlay({ element: el, build: () => {} });
    expect(el.hidden, 'construction must hide an element that arrived visible').toBe(true);
  });
});
