import { describe, it, expect } from 'vitest';
import { createKeyboardOverlay } from '../src/keyboardOverlay.js';

/**
 * A fake element, for the reason `environment: 'node'` always gives here: there is no `document`
 * in any test in this repo and jsdom is not a dependency. Only `hidden` is read or written, so
 * only `hidden` is faked.
 */
function fakeEl(): { hidden: boolean } {
  return { hidden: true };
}

/** An element that arrives SHOWN, which the default fake cannot detect. */
function shownEl(): { hidden: boolean } {
  return { hidden: false };
}

describe('createKeyboardOverlay', () => {
  it('starts HIDDEN, so every page load begins with no keyboard', () => {
    // The gateway's own no-persistence rule, which matters here more than in the GUI: a
    // REATTACHING browser client must not inherit a previous session's display state.
    const el = fakeEl();
    createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => {}, onHide: () => {},
    });
    expect(el.hidden).toBe(true);
  });

  it('hides an element that arrives SHOWN, which the default fake cannot detect', () => {
    // `hidden = true` in the constructor is not redundant with the markup's own attribute: either
    // alone is removable by someone who sees the other. This is the case that tells them apart.
    const el = shownEl();
    createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => {}, onHide: () => {},
    });
    expect(el.hidden).toBe(true);
  });

  it('does NOT build until the first show', () => {
    // 117 buttons at page load would cost every session for the few that open the keyboard.
    const el = fakeEl();
    let built = 0;
    createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => { built += 1; }, onHide: () => {},
    });
    expect(built).toBe(0);
  });

  it('BUILDS ONCE, not on every show', () => {
    // Rebuilding per toggle is invisible work that ALSO discards focus: tab to a cap, hide, show,
    // and the caret is gone.
    const el = fakeEl();
    let built = 0;
    const o = createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => { built += 1; }, onHide: () => {},
    });
    o.toggle();
    o.toggle();
    o.toggle();
    expect(built).toBe(1);
  });

  it('toggle() reveals and closes it, and visible() reports which', () => {
    const el = fakeEl();
    const o = createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => {}, onHide: () => {},
    });
    expect(o.visible()).toBe(false);
    o.toggle();
    expect(el.hidden).toBe(false);
    expect(o.visible()).toBe(true);
    o.toggle();
    expect(el.hidden).toBe(true);
    expect(o.visible()).toBe(false);
  });

  it('hide() ASSIGNS rather than toggling, so a second close cannot re-show', () => {
    // `hidden = !hidden` here is what a double-click on a close button would turn into a re-show.
    const el = fakeEl();
    const o = createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => {}, onHide: () => {},
    });
    o.toggle();
    o.hide();
    o.hide();
    expect(el.hidden).toBe(true);
  });

  describe('onHide, which is how the one-shot Shift gets disarmed', () => {
    it('CALLS onHide when a toggle CLOSES it', () => {
      // The sixth of the user's Shift rules: a keyboard reopened later must not still be holding
      // a Shift nobody remembers pressing.
      const el = fakeEl();
      let hidden = 0;
      const o = createKeyboardOverlay({
        element: el as unknown as HTMLElement, build: () => {}, onHide: () => { hidden += 1; },
      });
      o.toggle();
      expect(hidden, 'opening must NOT disarm').toBe(0);
      o.toggle();
      expect(hidden).toBe(1);
    });

    it('CALLS onHide on an explicit hide()', () => {
      const el = fakeEl();
      let hidden = 0;
      const o = createKeyboardOverlay({
        element: el as unknown as HTMLElement, build: () => {}, onHide: () => { hidden += 1; },
      });
      o.toggle();
      o.hide();
      expect(hidden).toBe(1);
    });

    it('is harmless when hide() finds it already hidden, since disarming twice is disarming once',
      () => {
        const el = fakeEl();
        let hidden = 0;
        const o = createKeyboardOverlay({
          element: el as unknown as HTMLElement, build: () => {}, onHide: () => { hidden += 1; },
        });
        o.hide();
        o.hide();
        expect(hidden).toBe(2);
        expect(el.hidden).toBe(true);
      });
  });
});
