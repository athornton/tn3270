import type { Action } from '@tn3270/frontend';

/**
 * Which keypad button a click landed on. Integer arithmetic and NOTHING ELSE.
 *
 * ## THIS FILE RUNS IN THE BROWSER, WHICH IS WHY IT IS NOT IN `keypad.ts`
 *
 * The renderer receives a finished draw list and turns a mouse position into an action, so `hitTest`
 * has to be reachable from `renderer.ts` -- and `renderer.ts` may not have a single RUNTIME import
 * of a workspace package: a browser cannot resolve `@tn3270/core` and there is no bundler, so the
 * window goes BLANK WITH NO ERROR (`renderer.ts:11-23`, measured). `keypad.ts` value-imports
 * `@tn3270/core`, `@tn3270/frontend` and `drawlist.js`, so importing `hitTest` from there would drag
 * all three into the renderer's graph. MEASURED during review: both assertions of
 * `renderer-imports.test.ts` fail when it does.
 *
 * That a specifier is RELATIVE does not make the graph clean -- the point `index.ts:12-16` already
 * makes about `drawlist.js`. And a served module that is not in `BROWSER_MODULES` (`assets.ts:39`)
 * 404s, which this project has already met four separate ways as a black canvas with no error
 * anywhere; so `hittest.js` is in that list.
 *
 * The `Action` import above is `import type`, which ERASES: nothing survives into `dist/hittest.js`,
 * and `renderer-imports.test.ts` reads the built javascript for exactly that reason.
 */
export interface KeypadButton {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /**
   * Copied from the key table alongside `label` and NEVER derived from it. A label/action mismatch
   * is invisible to property tests and to pixel goldens -- the glyphs are identical either way --
   * so `frontend/test/keypad.test.ts` pins the pair with a deliberately-duplicated map. Deriving
   * either side from the other would discard that.
   */
  readonly action: Action;
  readonly label: string;
}

/**
 * The button containing a point, in the same scale-1 pixels the buttons are in.
 *
 * Half-open on the right and bottom, so adjacent buttons cannot both claim a pixel.
 */
export function hitTest(
  buttons: readonly KeypadButton[], x: number, y: number,
): KeypadButton | undefined {
  return buttons.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
}

/**
 * The button under an element-relative click, given the paint's centring offset and scale.
 *
 * THE ONE LINE OF THE CLICK PATH THAT IS ARITHMETIC, PULLED OUT OF `renderer.ts` SO A TEST CAN
 * REACH IT. The renderer is a browser entry point -- it throws at module load outside a browser, so
 * the barrel cannot export it and no unit test can execute a line of it. That is not a theoretical
 * gap: adding `if (e.altKey) return;` to the renderer's `keydown` listener leaves this repo's suite
 * fully green while every Alt chord is dead. This function is the same risk in the mouse path, and
 * it is the half that does not need a browser.
 *
 * THE EXACT INVERSE of what `paint` draws: `blit.ts:106-107` puts a scale-1 cell at
 * `offset + coordinate * scale`, so a click subtracts the offset and DIVIDES by the scale. Both
 * mistakes -- multiplying instead of dividing, and forgetting the offset -- are INVISIBLE AT SCALE 1
 * WITH NO CENTRING, which is exactly the configuration both screenshot harnesses run in
 * (`browser-shot.mjs` sizes the viewport from the golden, so `bestScale` returns 1 and `centre`
 * returns 0,0). `keypad.test.ts`'s `hitTestAt` describe therefore probes at scale 3 with a non-zero
 * offset, and both mutations were run against it: multiplying fails a CENTRE probe, while dropping
 * the offset passes every centre probe and fails only the last-device-pixel one.
 */
export function hitTestAt(
  buttons: readonly KeypadButton[], offsetX: number, offsetY: number,
  at: { readonly x: number; readonly y: number }, scale: number,
): KeypadButton | undefined {
  return hitTest(buttons, (offsetX - at.x) / scale, (offsetY - at.y) / scale);
}
