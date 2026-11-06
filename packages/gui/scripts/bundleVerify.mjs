/**
 * The self-check `bundle.mjs` runs on its own output, pulled out so `pack.mjs` can run it again
 * right before packing `@tn3270/gui` -- SEPARATE from `bundle.mjs` on purpose: `bundle.mjs` runs
 * its build at top level (`await main()`), so importing it would re-run the whole esbuild pass;
 * `verify()` needed a home a plain `import` could reach without that.
 *
 * FOUND BY REVIEW: `pack.mjs` checked only that `packages/gui/app/BUNDLED` exists, so a bundle
 * that lost a file afterwards -- e.g. `atlas.bin` deleted by hand once `npm run bundle:gui` had
 * already finished -- packed fine. `BUNDLED` says a bundle finished, not that `app/` still matches
 * what finished.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_FILES } from '@tn3270/canvas';

const here = dirname(fileURLToPath(import.meta.url));
const gui = join(here, '..');

/** The documents main.ts loads. The connect dialog's lands here when it exists. */
export const DOCUMENTS = ['index.html', 'keypad.html', 'keyboard.html', 'transfer.html'];

/** A failure that names its fix. */
export class BundleError extends Error {}

/** Every `src`/`href` attribute value in a document, from any tag. */
const refsOf = (html) => [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);

/**
 * Checks that `outDir` (normally `packages/gui/app`) is still self-contained: every document in
 * `DOCUMENTS` carries no import map and references only files inside `outDir`; every
 * `layout.document(...)`/`layout.preload(...)` `src/main.ts` asks for is present; both atlas files
 * named by `@tn3270/canvas`'s `ATLAS_FILES` are present; and `main.js` kept no unresolved `require`
 * shim or import outside `node:` builtins and `electron`. Throws `BundleError` naming every problem
 * found, collected rather than reported one at a time; returns nothing on success.
 */
export function verify(outDir) {
  const problems = [];
  for (const doc of DOCUMENTS) {
    const docPath = join(outDir, doc);
    if (!existsSync(docPath)) {
      problems.push(`${doc} is not in app/`);
      continue;
    }
    const html = readFileSync(docPath, 'utf8');
    if (/type\s*=\s*"importmap"/.test(html)) problems.push(`${doc}: an import map survived`);
    const refs = refsOf(html);
    if (refs.length === 0) problems.push(`${doc}: references nothing, which cannot be right`);
    for (const ref of refs) {
      if (ref.includes('../')) problems.push(`${doc}: ${ref} climbs out of app/`);
      else if (/^[a-z]+:|^\/\//i.test(ref) || isAbsolute(ref)) problems.push(`${doc}: ${ref} is not app-relative`);
      else if (!existsSync(resolve(outDir, ref))) problems.push(`${doc}: ${ref} is not in app/`);
    }
  }
  // Every file main.ts hands Electron, read from its source so a new window cannot be missed.
  const mainSrc = readFileSync(join(gui, 'src', 'main.ts'), 'utf8');
  const asked = [...mainSrc.matchAll(/layout\.(?:document|preload)\('([^']+)'\)/g)].map((m) => m[1]);
  if (asked.length === 0) problems.push('found no layout.document/preload calls in src/main.ts; the pattern drifted');
  for (const f of asked) if (!existsSync(join(outDir, f))) problems.push(`main.ts loads ${f}, which is not in app/`);
  // The atlas: main reads it with `readAtlas(layout.atlasDir)`, i.e. from app/, by these names. A
  // bundle missing one starts, opens a window and then shows only the incomplete-install error.
  for (const f of Object.values(ATLAS_FILES)) {
    if (!existsSync(join(outDir, f))) problems.push(`readAtlas reads ${f}, which is not in app/`);
  }
  // The main bundle must not have kept a runtime `require` esbuild could not resolve (an ESM
  // bundle turns one into a shim that throws at startup) or any import other than node: builtins
  // and electron.
  const mainJsPath = join(outDir, 'main.js');
  if (!existsSync(mainJsPath)) {
    problems.push('main.js is not in app/');
  } else {
    const mainJs = readFileSync(mainJsPath, 'utf8');
    if (/\b__require\(/.test(mainJs)) problems.push('app/main.js contains a __require shim that throws under ESM');
    for (const m of mainJs.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      if (!m[1].startsWith('node:') && m[1] !== 'electron') problems.push(`app/main.js still imports ${m[1]}`);
    }
  }
  if (problems.length > 0) throw new BundleError(`app/ is not self-contained:\n  ${problems.join('\n  ')}`);
}
