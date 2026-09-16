/**
 * The canvas presentation layer, shared by the Electron GUI and the web gateway.
 *
 * WHY THIS PACKAGE EXISTS. These modules had two consumers the moment a web front end appeared,
 * and `packages/frontend` is explicitly not their home: its own docstring excludes "anything a
 * front end owns because of HOW it presents: ANSI generation, SGR depth, canvas geometry".
 *
 * `renderer.ts` IS DELIBERATELY NOT EXPORTED HERE. It is a browser ENTRY POINT with side effects
 * -- it queries `#screen` and throws when there is no canvas -- so importing it from Node would
 * throw at module load. Browsers get it as a served file, not as a package export.
 *
 * NOTHING HERE MAY BE IMPORTED BY THE BROWSER. This barrel reaches `drawlist.js`, which imports
 * `@tn3270/core`, and a browser has no bundler to resolve a bare specifier -- the window goes
 * BLANK WITH NO ERROR. `renderer-imports.test.ts` pins that boundary by walking the built
 * renderer's graph, and this file is outside it precisely because the renderer does not import
 * it.
 */
export { drawList } from './drawlist.js';
export type { AtlasGeometry, DrawCell, DrawList } from './drawlist.js';
export { blit, blankColumns, bestScale, centre, rgbCss, tintKey } from './blit.js';
export type { Surface, Ctx2D, BlitOptions } from './blit.js';
export { actionForKey } from './keys.js';
export type { KeyLike } from './keys.js';
export { assetDir, readAtlas, BROWSER_MODULES } from './assets.js';
export { ebcdicToCg, CG_BOXSOLID } from './cg.js';
export { parseBdf } from './bdf.js';
// The virtual keypad's geometry: scale-1 pixels, so a consumer needs no cell arithmetic of its
// own. `hitTest` comes with it because a click arrives in the same space the buttons are in.
export { keypadRegion, hitTest, KEYPAD_ROWS_TALL } from './keypad.js';
export type { KeypadButton, KeypadRegion } from './keypad.js';
