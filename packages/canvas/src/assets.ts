import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AtlasGeometry } from './drawlist.js';

/**
 * Where this package's BUILT assets live, and how to read the atlas.
 *
 * WHY THIS EXISTS: two consumers now need `atlas.json`, `atlas.bin` and -- for the web front
 * end -- the three browser modules as static files. Both previously lived beside `gui`'s own
 * `dist`, so `main.ts` could say `join(here, 'atlas.json')`. A second consumer guessing a
 * relative path into a sibling package's `dist` is how that breaks silently when either
 * package moves, so the package that OWNS the assets answers where they are.
 *
 * `assetDir()` IS `dist`, NOT THE `assets/` DIRECTORY BESIDE IT. Two different things in this
 * package are called assets: `assets/3270.bdf` is the checked-in BUILD INPUT that
 * `scripts/build-atlas.mjs` reads, and `dist` is where it bakes the atlas that ships. Only
 * the latter is what a consumer wants; asking for the font at runtime would mean shipping a
 * BDF parser to every front end, which is the work the atlas exists to have already done.
 *
 * Node-side only. The browser never imports this file, and `renderer-imports.test.ts` is what
 * keeps that true.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** This package's built output directory: the atlas and the browser modules. */
export function assetDir(): string {
  return here;
}

/** The three modules a browser must be served, in load order. */
export const BROWSER_MODULES: readonly string[] = Object.freeze([
  'renderer.js', 'blit.js', 'keys.js',
]);

/**
 * Read the baked atlas. Throws NAMING THE BUILD when the package was not built.
 *
 * ## A SCOPED BUILD OF A CONSUMER LEAVES THE ATLAS UNBUILT
 *
 * MEASURED 2026-09-15, from a clean tree: `npm run build -w @tn3270/gui` EXITS 0 and fills
 * `packages/canvas/dist` with compiled `.js` -- and no `atlas.json` or `atlas.bin`. Project
 * references chain TYPESCRIPT COMPILATION and nothing else: `tsc --build` follows
 * `gui`'s reference to this package and compiles it, but it has no idea this package's own
 * `build` script has a SECOND step (`node scripts/build-atlas.mjs`) that bakes the atlas.
 * Only `npm run build` at the root, or `-w @tn3270/canvas`, runs that step.
 *
 * `gui` used to carry `&& node scripts/build-atlas.mjs` in its own build script, so a scoped
 * gui build was self-sufficient; extracting this package moved that step behind a reference
 * that cannot pull it. Hence the message below names the command rather than letting a bare
 * `ENOENT ... dist/atlas.json` be the whole diagnosis -- that failure surfaced as an
 * unhandled rejection and a BLANK WINDOW that never quit, which is the shape this repo keeps
 * writing comments to prevent.
 *
 * The original error is kept as `cause` so a developer can still see which file was missing.
 */
export function readAtlas(): { geometry: AtlasGeometry; coverage: Uint8Array } {
  try {
    const geometry = JSON.parse(readFileSync(join(here, 'atlas.json'), 'utf8')) as AtlasGeometry;
    const coverage = new Uint8Array(readFileSync(join(here, 'atlas.bin')));
    return { geometry, coverage };
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new Error(
        '@tn3270/canvas has not been built: run npm run build -w @tn3270/canvas',
        { cause: err });
    }
    throw err;
  }
}
