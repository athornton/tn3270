import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the GUI's files are, given the directory `main.js` runs from.
 *
 * ## TWO LAYOUTS, ONE RULE
 *
 * UNBUNDLED (`tsc --build`, what every harness and the monorepo run): `main.js` is
 * `packages/gui/dist/main.js`, the preloads compile beside it as `dist/*.cjs`, the HTML documents
 * sit one level up in `packages/gui/`, and the atlas belongs to `@tn3270/canvas`, whose own
 * `assetDir()` knows where it is. The documents reach into `../canvas/dist` and `../frontend/dist`
 * through import maps, which works ONLY because the workspace keeps those packages as siblings.
 *
 * BUNDLED (`scripts/bundle.mjs` -> `packages/gui/app/`, the single input to both the npm package
 * and electron-builder): everything is FLAT beside `main.js` -- documents, preloads, page modules
 * and `atlas.{json,bin}` -- because there is no `node_modules` and no sibling package to reach.
 *
 * The bundle writes a `BUNDLED` marker file, and this function asks for it. That makes the answer
 * a FACT ON DISK rather than a guess from a directory name: a packaged app runs from
 * `.../resources/app.asar`, a name nobody here chose, and a check like `basename(here) === 'app'`
 * would get it wrong the day electron-builder (or a user's install prefix) names it differently.
 * `existsSync` works inside asar because Electron patches `fs` in the main process.
 *
 * The marker is looked for BESIDE `main.js` ONLY, never in a parent: the unbundled `dist/` must
 * stay unbundled even if someone copies an `app/` over `packages/gui/`. `appRoot.test.ts` pins it.
 *
 * ## WHY THE ATLAS IS EXPLICIT IN THE BUNDLE, NOT LEFT TO `assetDir()`
 *
 * esbuild inlines `@tn3270/canvas`'s `assets.ts` into `app/main.js`, and its module-level
 * `dirname(fileURLToPath(import.meta.url))` then evaluates to `app/` -- which HAPPENS to be where
 * the bundle copies the atlas. Relying on that would make a correct-looking app depend on two
 * unrelated decisions agreeing by accident (where esbuild puts the output, and where the copy
 * step puts the atlas); a bundler change to `import.meta` handling would break it with nothing
 * naming the cause. So the bundled layout states its atlas directory, and `main.ts` passes it.
 */
export interface Layout {
  /** True when `BUNDLED` sits beside `main.js`. */
  readonly bundled: boolean;
  /** An HTML document (`index.html`, `keypad.html`, ...). */
  document(name: string): string;
  /** A compiled preload (`preload.cjs`, `keypadPreload.cjs`, ...). */
  preload(name: string): string;
  /** The atlas directory, or undefined to use `@tn3270/canvas`'s own `assetDir()`. */
  readonly atlasDir: string | undefined;
  /**
   * The window icon PNG. Unbundled it is the tracked `resources/icon.png`, which is also what
   * electron-builder converts into the `.icns`/`.ico`/Linux icon set; the bundle copies it flat.
   */
  readonly icon: string;
}

/** The marker `scripts/bundle.mjs` writes into `app/`. Its contents are irrelevant. */
export const BUNDLE_MARKER = 'BUNDLED';

/** The icon's file name, in `resources/` unbundled and flat in `app/` bundled. */
export const ICON_FILE = 'icon.png';

export function layoutFor(mainDir: string): Layout {
  if (existsSync(join(mainDir, BUNDLE_MARKER))) {
    return {
      bundled: true,
      document: (name) => join(mainDir, name),
      preload: (name) => join(mainDir, name),
      atlasDir: mainDir,
      icon: join(mainDir, ICON_FILE),
    };
  }
  return {
    bundled: false,
    document: (name) => join(mainDir, '..', name),
    preload: (name) => join(mainDir, name),
    atlasDir: undefined,
    icon: join(mainDir, '..', 'resources', ICON_FILE),
  };
}
