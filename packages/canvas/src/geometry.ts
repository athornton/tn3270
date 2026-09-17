// TYPE-ONLY, and the file has no other import: `import type` erases, so `dist/geometry.js` is an
// empty module that no runtime graph can reach. See below on why that matters.
import type { Rgb } from '@tn3270/core';

/**
 * The shapes every drawing module in this package shares: the atlas's geometry and one cell.
 *
 * ## A LEAF, AND THAT IS THE WHOLE REASON IT EXISTS
 *
 * Nothing here imports a sibling and nothing here is a value -- two interfaces, so the compiled
 * `dist/geometry.js` is an empty module and no runtime graph reaches it. That is what breaks the
 * last import cycle in this package: `AtlasGeometry` lived in `drawlist.ts`, so `cg.ts` took it
 * from there with `import type` while `drawlist.ts` value-imported `column` from `cg.ts` -- and
 * `keypad.ts` did the same in the other direction. Both cycles typechecked and both erased at
 * build time, which is exactly why they survived two rounds of review.
 *
 * The hazard a cycle carries here is not a build failure but module initialisation ORDER: the day
 * one of those type imports becomes a value import, the loser of the cycle sees `undefined` at
 * module load. In a browser with no bundler that is a BLACK CANVAS WITH NO ERROR, which this
 * project has already met four separate ways. `test/module-cycles.test.ts` is what keeps the
 * graph acyclic now, and it reads the SOURCE, because `import type` is invisible in `dist`.
 *
 * ## WHY NOT `DrawList` TOO
 *
 * `DrawList` stays in `drawlist.ts`: it is that module's return type, and it names `KeypadRegion`,
 * so moving it here would make THIS file import `keypad.ts` -- which imports these two interfaces
 * back. That is the cycle again, one module along. What belongs here is only what a module BELOW
 * `drawlist.ts` in the graph needs: `cg.ts`, `keypad.ts`, `assets.ts` and `blit.ts` all take
 * `AtlasGeometry`, and `keypad.ts` builds `DrawCell`s.
 */

export interface AtlasGeometry {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cols: number;
  /** CG code to atlas column. Sparse: the font's encodings run 0..543 with holes. */
  readonly index: Readonly<Record<number, number>>;
}

export interface DrawCell {
  readonly x: number;
  readonly y: number;
  /** Atlas COLUMN, already resolved through the CG map. */
  readonly glyph: number;
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly cursor: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly intensify: boolean;
}
