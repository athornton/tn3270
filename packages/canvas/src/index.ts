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
export type { DrawList } from './drawlist.js';
// The two shapes every drawing module here shares, from the LEAF module that declares them. They
// were `drawlist.ts`'s, and consumers outside this package are unaffected by the move: they take
// them from this barrel, which is the only import path `packages/gui` and `packages/web` use.
export type { AtlasGeometry, DrawCell } from './geometry.js';
export { blit, blankColumns, bestScale, centre, rgbCss, tintKey } from './blit.js';
export type { Surface, Ctx2D, BlitOptions } from './blit.js';
export { actionForKey } from './keys.js';
export type { KeyLike } from './keys.js';
export { assetDir, readAtlas, BROWSER_MODULES } from './assets.js';
export { ebcdicToCg, CG_BOXSOLID } from './cg.js';
export { parseBdf } from './bdf.js';
// The virtual keypad's geometry: scale-1 pixels, so a consumer needs no cell arithmetic of its own.
// `hitTest` is in its OWN module because a click is hit-tested IN THE BROWSER, and `keypad.js`
// value-imports core, frontend and `drawlist.js` -- see hittest.ts on what importing it from there
// does to the renderer's graph.
export { keypadRegion, KEYPAD_ROWS_TALL } from './keypad.js';
export type { KeypadRegion } from './keypad.js';
export { hitTest, hitTestAt } from './hittest.js';
export type { KeypadButton } from './hittest.js';
