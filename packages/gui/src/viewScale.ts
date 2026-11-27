import { bestScale, type Surface } from '@tn3270/canvas';
import { windowScale } from './measure.js';

/**
 * THE VIEW MENU'S SCALE ARITHMETIC (B2 Part 2b), pure and out of main.ts because vitest cannot
 * load `electron`. Every View command is a WINDOW RESIZE: the renderer already draws at
 * `bestScale(list, innerWidth x innerHeight)` and centers the rest (canvas/src/renderer.ts), so
 * main only has to pick a content size of `list x scale`.
 */

type Area = { readonly width: number; readonly height: number };

/** System follows the OS; Light and Dark override it for the GUI's own windows. */
export type Appearance = 'system' | 'light' | 'dark';
export const APPEARANCES: readonly Appearance[] = ['system', 'light', 'dark'];

/**
 * Bigger's bound: the largest scale whose screen fits the WHOLE work area. Not `windowArea`'s 80%,
 * which is Fit's rule -- with that bound Bigger could never go past Fit.
 */
export const maxScale = (list: Surface, workArea: Area): number => bestScale(list, workArea);

/** The scale the renderer is drawing at in a window of this content size. */
export const currentScale = (list: Surface, content: Area): number => bestScale(list, content);

/**
 * One Bigger (+1) or Smaller (-1) step, kept within 1..max. A `current` above `max` happens only
 * when the display shrank under the window; Smaller then goes one below the largest that fits,
 * and Bigger lands on it.
 */
export function stepScale(current: number, dir: 1 | -1, max: number): number {
  return Math.max(1, Math.min(max, Math.min(current, max) + dir));
}

/** The scale to size the window to: Fit's rule when nothing is chosen, else the choice, clamped. */
export function targetScale(chosen: number | undefined, list: Surface, workArea: Area): number {
  return chosen === undefined ? windowScale(list, workArea) : Math.min(chosen, maxScale(list, workArea));
}
