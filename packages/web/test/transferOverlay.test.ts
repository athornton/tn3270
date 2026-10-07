import { describe, it, expect } from 'vitest';
import { createTransferOverlay } from '../src/transferOverlay.js';

/**
 * A fake element, matching `keypadOverlay.test.ts`'s idiom exactly: `environment: 'node'` means
 * there is no `document` in any test in this repo and jsdom is not a dependency, and only `hidden`
 * is read or written by this module, so only `hidden` is faked.
 */
function fakeEl(): { hidden: boolean } {
  return { hidden: true };
}

describe('createTransferOverlay', () => {
  it('starts HIDDEN, so every page load (and every reattaching client) begins with no overlay', () => {
    /**
     * Mirrors `keypadOverlay.test.ts`'s first case and the same gateway rule it cites: a
     * REATTACHING browser client must not inherit a previous session's overlay state. Asserted
     * even though the markup also carries `hidden` (`transfer-overlay` in the plan's Task 8
     * markup) -- belt and braces is the point, since either one alone can be removed by someone
     * who sees the other.
     */
    const el = fakeEl();
    createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    expect(el.hidden).toBe(true);
  });

  it('does NOT build until the first show', () => {
    // LAZY, for the same reason the keypad's 48 buttons are: most sessions never open the
    // transfer form, and building its fields at page load would cost every session for the few
    // that do.
    let built = 0;
    const el = fakeEl();
    createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => { built += 1; },
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    expect(built).toBe(0);
  });

  it('BUILDS THE FORM ONCE, not on every show', () => {
    // Counted rather than spied on a boolean, because "built once" and "built at least once" are
    // different claims and only the first is correct -- matching `keypadOverlay.test.ts`'s own
    // reasoning for the same assertion.
    let built = 0;
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => { built += 1; },
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    o.show(); o.hide(); o.show();
    expect(built).toBe(1);
  });

  it('show() reveals the overlay, hide() closes it (nothing unsaved)', () => {
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    o.show();
    expect(el.hidden).toBe(false);
    o.hide();
    expect(el.hidden).toBe(true);
  });

  it('visible() reports the current state', () => {
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    expect(o.visible()).toBe(false);
    o.show();
    expect(o.visible()).toBe(true);
    o.hide();
    expect(o.visible()).toBe(false);
  });

  it('hide() closes it, and is safe when it is already closed', () => {
    // The close button needs this, and so does a future Escape binding -- the same case
    // `keypadOverlay.test.ts` asserts for `hide()`. Idempotent because a second close must not
    // RE-SHOW, which is what a naive `hidden = !hidden` would do.
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    o.show();
    o.hide();
    expect(el.hidden).toBe(true);
    o.hide();
    expect(el.hidden).toBe(true);
  });

  it('WARNS before discarding a completed transfer nobody saved', () => {
    // The transfer SUCCEEDED and the host is out of transfer mode, so there is nothing to retry
    // from -- the same principle as transferRun.ts refusing to report a "complete" that left no
    // file (packages/frontend/src/transferRun.ts:338-340, :404-406). Not a memory concern: 10 MB
    // held in a browser is nothing beside its normal footprint (the design doc's Decision 8,
    // docs/superpowers/specs/2026-10-06-web-transfer-ui-design.md:305-306) -- the warning here is
    // about losing a result, not about holding bytes.
    let asked = 0;
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => true,
      confirmDiscard: () => { asked += 1; return true; },
    });
    o.show();
    o.hide();
    expect(asked).toBe(1);
    expect(el.hidden).toBe(true);
  });

  it('stays open when the operator declines to discard', () => {
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => true,
      confirmDiscard: () => false,
    });
    o.show();
    o.hide();
    expect(el.hidden, 'must not close over unsaved bytes').toBe(false);
    expect(o.visible(), 'must not close over unsaved bytes').toBe(true);
  });

  it('does not prompt when there is nothing unsaved', () => {
    let asked = 0;
    const el = fakeEl();
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => false,
      confirmDiscard: () => { asked += 1; return true; },
    });
    o.show();
    o.hide();
    expect(asked).toBe(0);
  });
});

describe('the construction-time hide, from a VISIBLE starting state', () => {
  it('hides an element that arrives shown, which the default fake cannot detect', () => {
    // THIS CLOSES A MUTATION GAP, and the gap is inherited rather than introduced: deleting
    // `deps.element.hidden = true` from the constructor reddened NOTHING, here or in
    // `keypadOverlay.ts`'s identical line, because both fakes start at `hidden: true` -- so the
    // test could not tell "construction set it" from "it was already set".
    //
    // Starting from `hidden: false` is what makes the assignment observable. It is also the
    // realistic case the belt-and-braces line exists for: markup whose `hidden` attribute someone
    // removed, which is exactly the single-point-of-failure the module's own comment warns about.
    const el = { hidden: false };
    const o = createTransferOverlay({
      element: el as unknown as HTMLElement,
      build: () => {},
      hasUnsaved: () => false,
      confirmDiscard: () => true,
    });
    expect(el.hidden, 'construction must hide an element that arrived visible').toBe(true);
    expect(o.visible(), 'and the overlay must agree it is hidden').toBe(false);
  });
});
