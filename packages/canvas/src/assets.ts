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

/** Read the baked atlas. Throws if the package was not built. */
export function readAtlas(): { geometry: AtlasGeometry; coverage: Uint8Array } {
  const geometry = JSON.parse(readFileSync(join(here, 'atlas.json'), 'utf8')) as AtlasGeometry;
  const coverage = new Uint8Array(readFileSync(join(here, 'atlas.bin')));
  return { geometry, coverage };
}
