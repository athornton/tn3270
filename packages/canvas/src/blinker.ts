/**
 * The blink phase, x3270's `text_blink_it` (x3270/screen.c:1411-1435): every 500 ms the phase
 * flips and the screen repaints, and the timer runs ONLY while some cell blinks. PURE apart from
 * the timers it is given, so vitest can drive it with fake timers; renderer.ts owns the DOM.
 */
import type { DrawList } from './drawlist.js';

export const BLINK_MS = 500;

/** Does this frame contain a blinking cell, in the screen or the OIA? */
export function hasBlink(list: DrawList): boolean {
  return list.cells.some((c) => c.blink) || (list.oia?.cells.some((c) => c.blink) ?? false);
}

export interface Blinker {
  /** True in the off phase: blinking glyphs are not drawn. */
  readonly off: boolean;
  /** Tell it about each painted frame. */
  frame(list: DrawList): void;
}

export function createBlinker(opts: {
  repaint: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Blinker {
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let off = false;
  let timer: unknown;
  return {
    get off() { return off; },
    frame(list) {
      if (hasBlink(list)) {
        if (timer === undefined) timer = setTimer(() => { off = !off; opts.repaint(); }, BLINK_MS);
      } else if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
        off = false;
      }
    },
  };
}
