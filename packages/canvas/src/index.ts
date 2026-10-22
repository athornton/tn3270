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
export { blit, blankColumns, bestScale, center, rgbCss, tintKey } from './blit.js';
export type { Surface, Ctx2D, BlitOptions } from './blit.js';
export { actionForKey } from './keys.js';
export type { KeyLike } from './keys.js';
export { assetDir, readAtlas, BROWSER_MODULES } from './assets.js';
export { ebcdicToCg, CG_BOXSOLID } from './cg.js';
export { parseBdf } from './bdf.js';
// THE CANVAS-DRAWN KEYPAD WAS HERE AND IS GONE, 2026-10-06: `keypadRegion`,
// `KEYPAD_ROWS_TALL`, `KeypadRegion`, `hitTest`, `hitTestAt` and `KeypadButton`, with
// `keypad.ts` and `hittest.ts` deleted outright.
//
// NOT DIVERGENCE BUT DELETION, which is the opposite of what this feature's idea doc predicted.
// That doc assumed the GUI would move to real controls while the web gateway stayed
// canvas-drawn, leaving `keypad.ts` exactly one consumer. The user's 2026-10-06 decision made
// the WEB keypad an HTML overlay too, so it ended up with NONE -- and code with no consumer
// whose tests still pass is the shape the recorded deleting-a-gate finding warns about.
//
// The 48 keys themselves never moved: they are `KEYPAD_KEYS` in `@tn3270/frontend`, grouped for
// a DOM layout by `keypadView.ts` and built into buttons by `keypadUi.ts` below.
// Rectangular selection. `extractText` runs in MAIN and not in the renderer, for the reason
// `selection.ts` gives at length: a `DrawCell` carries a CG-order atlas glyph and no character, so
// only the side holding `resolve(snapshot)` can turn a rectangle into text. `renderer.ts` imports
// the two geometry functions from the MODULE rather than from this barrel -- importing them from
// here would pull `drawlist.js` and `@tn3270/core` into its graph and blank the window.
export { normalizeRect, isEmptyRect, extractText } from './selection.js';
export type { CellAddr, CellRect } from './selection.js';
// The keypad's DOM view, shared by the Electron keypad WINDOW and the web gateway's in-pane
// OVERLAY. It is here rather than in `packages/gui` because `packages/web` needs it and cannot
// depend on an Electron app; see the file's own header.
//
// EXPORTED FOR TYPESCRIPT, WHICH IS NOT HOW THE BROWSER GETS IT. Both front ends' import maps
// name `canvas/dist/keypadUi.js` DIRECTLY, because this barrel reaches `drawlist.js` and
// `@tn3270/core` -- a bare specifier that blanks the window. So the two resolutions differ on
// purpose: `tsc` follows the package entry point, the browser follows the map.
export { createKeypadUi } from './keypadUi.js';
export type { KeypadDeps } from './keypadUi.js';
// The transfer form's view. Here for the same reason `keypadUi.ts` is -- `packages/web` needs it
// and cannot depend on an Electron app -- and moved here on 2026-10-06 to make that possible.
//
// UNLIKE THE KEYPAD ABOVE, ONLY ONE FRONT END CONSUMES IT TODAY. The keypad note's "both front
// ends" is true of `keypadUi.js` and would be false here: the Electron transfer window names
// `canvas/dist/transferUi.js` in `gui/transfer.html`'s map, and the gateway's overlay does not
// exist yet. Do not copy that sentence down here when it does; see `transferUi.ts`'s own header
// for why the two maps will differ rather than match.
//
// EXPORTED FOR TYPESCRIPT, WHICH IS NOT HOW THE BROWSER GETS IT: the consuming document names
// `canvas/dist/transferUi.js` DIRECTLY, because this barrel reaches `drawlist.js` and
// `@tn3270/core` -- a bare specifier that blanks the window.
//
// THE DEEP SPECIFIER RESOLVES ONLY BECAUSE THIS PACKAGE HAS NO `exports` FIELD, which is a
// prerequisite rather than an accident: `frontend`, `core`, `node-files` and `cli` all have one,
// so adding one here looks like tidying. MEASURED -- `"exports": { ".": "./dist/index.js" }` in
// `canvas/package.json` fails the build with `TS2307: Cannot find module
// '@tn3270/canvas/dist/transferUi.js'` at `gui/src/transferBoot.ts`. It fails loudly, which is the
// only mercy in it.
export { createTransferUi, caretAfterEdit } from './transferUi.js';
export type { UiDeps, UiField, TransferUi } from './transferUi.js';
