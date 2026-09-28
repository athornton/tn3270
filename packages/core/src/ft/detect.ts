import { CUT_SCREEN_SIZE, isCutFrame } from './frames.js';
import type { Screen } from '../screen.js';

/**
 * Does this screen LOOK like a CUT frame? Never throws, whatever the geometry.
 *
 * ## WHY THIS IS NOT JUST `isCutFrame`
 *
 * `isCutFrame` calls `requireCutGeometry`, which THROWS `CutFrameError` on any screen
 * that is not 24x80 (`frames.ts:312`). That is right for STEPPING a transfer: `O_SF` is
 * 1919, the last cell of a 24x80 buffer and of nothing else, so the frame offsets are
 * meaningless on another geometry and computing them anyway would read fields that mean
 * something else. The throw turns a silent corruption into a failure a developer cannot
 * miss.
 *
 * But it makes `isCutFrame` unable to answer the question a protocol DECIDER has to ask.
 * **The host chooses the protocol, not the client** — x3270's `ft_running` merely
 * REPORTS which one arrived (`ft.c:556`) and it has no selection logic at all — so we do
 * not learn whether the geometry is legal until the host has already answered. A decider
 * must therefore be askable at 43x80 and get `false` rather than an exception.
 *
 * Hence: **new function for DECIDING, `isCutFrame` unchanged for STEPPING.** Once CUT has
 * won, the 24x80 demand is real again and the throw is how existing code refuses to
 * compute offsets it cannot.
 *
 * ## WHY IT DELEGATES RATHER THAN RE-IMPLEMENTING
 *
 * The geometry check runs FIRST and returns `false`, so `isCutFrame` is only ever reached
 * on a screen it accepts — which means the attribute test itself is not duplicated. Two
 * copies of "what is a CUT frame" would drift, and the reasoning in `isCutFrame` is
 * load-bearing and not obvious: it masks rather than compares, because a live TK5 frame
 * plants 0x7c at `O_SF` where x3270 would store 0xfc for the same field, and both are
 * auto-skip.
 */
export function looksLikeCutFrame(screen: Screen): boolean {
  if (screen.size !== CUT_SCREEN_SIZE) return false;
  return isCutFrame(screen);
}
