/**
 * Bundles the GUI into `packages/gui/app/`: a directory that runs under Electron with NO
 * `node_modules`. It is the single input to the npm package (`files: ["app", ...]`) and to
 * electron-builder, so both ship the same bytes.
 *
 *     npm run build && npm run bundle:gui
 *
 * ## WHAT GOES IN
 *
 *  - `dist/main.js` -> `app/main.js`: ESM, platform node, `electron` external. Inlines core,
 *    frontend, canvas and node-files, which have no third-party runtime dependencies at all.
 *  - every `dist/*.cjs` preload -> `app/<same>.cjs`: CommonJS, because an ESM preload cannot load
 *    (`src/preload.cts` has the measurement).
 *  - each document's `<script src>` module -> `app/<basename>`: ESM, platform browser,
 *    SELF-CONTAINED, so the shipped HTML needs no import map and reaches nothing outside `app/`.
 *  - the documents themselves, `ui.css`, and the atlas (`atlas.{json,bin}`, from canvas's own
 *    `assetDir()` -- the package that owns them answers where they are).
 *  - `package.json` (Electron reads `main`, `type` and `name`) and the `BUNDLED` marker that
 *    `src/appRoot.ts` looks for. The marker is what makes `main.js` read flat paths; without it the
 *    bundle would look for `../index.html` and show a blank window.
 *
 * ## IT BUNDLES `dist/`, NOT `src/`, SO `npm run build` MUST RUN FIRST
 *
 * Every entry is the COMPILED JavaScript the unbundled build already runs -- `dist/main.js`,
 * `dist/*.cjs`, and whatever each document's `<script src>` names (`../canvas/dist/renderer.js`,
 * `./dist/keypadBoot.js`, ...). That is deliberate: the bundle is then a re-packaging of exactly
 * the code the Xvfb harnesses and the goldens were measured against, typechecked by `tsc` rather
 * than by esbuild's type-stripping (which checks nothing). The price is that a stale or missing
 * `dist/` bundles stale code; the missing case is refused below by name, the stale case is the
 * reason the root script order is `build` then `bundle:gui`.
 *
 * ## THE IMPORT MAPS ARE THE RESOLVER, NOT A THING TO DELETE AND FORGET
 *
 * The page modules say bare specifiers -- `@tn3270/canvas`, `@tn3270/frontend`, deep
 * `@tn3270/canvas/dist/forwardKeys.js` -- and each document's import map decides what they mean
 * IN THAT DOCUMENT. The same bare `@tn3270/frontend` is `keypadView.js` in `keypad.html`, and Node
 * resolution would make it the package BARREL, which reaches `tls.js` and `node:tls` and cannot
 * run in a renderer at all. So letting esbuild resolve bare specifiers its own way would bundle a
 * DIFFERENT graph from the one the unbundled window loads, and the difference would show up as a
 * blank window or, worse, a working one that ships the TLS stack to a renderer.
 *
 * Instead each page is built with a resolver plugin that reads THAT DOCUMENT'S map, resolves each
 * address against the document's location (a map address is relative to the document's base URL,
 * which `keypad.html`'s own comment records), and REFUSES any bare specifier the map does not
 * answer -- the same rule a browser applies, made loud. The map is then stripped from the shipped
 * copy, because nothing left in it is bare.
 *
 * ## IT CHECKS ITS OWN OUTPUT, EVERY RUN
 *
 * `uiAssets.test.ts` checks the unbundled documents; nothing ran against `app/` until now, and a
 * missed reference here is a blank window in the one artifact users get. So after writing, this
 * script REFUSES (exit 1) if any shipped document still has an import map, any `src`/`href` that
 * climbs out with `../`, is absolute or remote, or names a file `app/` lacks -- and if any
 * `layout.document(...)`/`layout.preload(...)` that `src/main.ts` asks for is missing from `app/`.
 * An always-run check beats a test that skips whenever the bundle is absent, which in the plain
 * suite is always.
 *
 * ## ADDING A PAGE
 *
 * Add its document to `DOCUMENTS`. Its scripts, its map and its stylesheet are read out of the
 * document itself; there is no second list to keep in step.
 */
import { build } from 'esbuild';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetDir } from '@tn3270/canvas';

const here = dirname(fileURLToPath(import.meta.url));
const gui = join(here, '..');
const dist = join(gui, 'dist');
const out = join(gui, 'app');

/** The documents main.ts loads. The connect dialog's lands here when it exists. */
const DOCUMENTS = ['index.html', 'keypad.html', 'keyboard.html', 'transfer.html'];

/**
 * esbuild targets, MEASURED from the pinned Electron 44.10.2 (`ELECTRON_RUN_AS_NODE=1 electron -e
 * 'console.log(process.versions)'`, 2026-11-06): Chrome 152.0.7977.169, Node 24.22.2. They only
 * bound which syntax esbuild may leave alone -- `dist/` is already ES2023, below both -- so they
 * need revisiting on an Electron upgrade only if the TS target rises past them.
 */
const BROWSER_TARGET = 'chrome152';
const NODE_TARGET = 'node24';

/** A failure that names its fix. Every refusal below goes through here and exits non-zero. */
class BundleError extends Error {}

function need(path, what) {
  if (!existsSync(path)) throw new BundleError(`${what} is missing (${path}): run npm run build first`);
}

/**
 * The single `<script type="importmap">` block of a document, as `{ specifier: absolutePath }`,
 * plus the block's text so it can be stripped. A document with none gets an empty map, which then
 * refuses every bare specifier -- `index.html` is that case: the renderer imports only relatives.
 */
function importMap(doc, html) {
  const blocks = [...html.matchAll(/<script\s+type="importmap"\s*>([\s\S]*?)<\/script>\s*/g)];
  if (blocks.length > 1) throw new BundleError(`${doc} has ${blocks.length} import maps; a browser uses one`);
  if (blocks.length === 0) return { map: {}, block: undefined };
  const { imports = {}, ...rest } = JSON.parse(blocks[0][1]);
  if (Object.keys(rest).length > 0) {
    // `scopes` would change resolution per importer, and this resolver does not model it.
    throw new BundleError(`${doc}'s import map has ${Object.keys(rest).join(', ')}; only "imports" is supported`);
  }
  const map = {};
  for (const [spec, addr] of Object.entries(imports)) {
    if (spec.endsWith('/')) throw new BundleError(`${doc}: prefix mapping ${spec} is not supported`);
    map[spec] = resolve(gui, addr);
    need(map[spec], `${doc}'s import map entry ${spec}`);
  }
  return { map, block: blocks[0][0] };
}

/** An esbuild plugin that resolves bare specifiers through ONE document's import map, and only it. */
function importMapPlugin(doc, map) {
  return {
    name: `importmap:${doc}`,
    setup(b) {
      // Bare = not relative, not absolute. Exact-match keys, as a browser does without a trailing `/`.
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (isAbsolute(args.path)) return undefined;
        const target = map[args.path];
        if (target !== undefined) return { path: target };
        return {
          errors: [{
            text: `${doc}: bare specifier ${JSON.stringify(args.path)} (from ${relative(gui, args.importer)}) ` +
              'is not in the document\'s import map; the unbundled window could not load it either',
          }],
        };
      });
    },
  };
}

/** Every `src`/`href` attribute value in a document, from any tag. */
const refsOf = (html) => [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]);

/** Strips HTML comments: the source documents' commentary describes the UNBUNDLED import maps. */
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->\s*/g, '');

async function main() {
  need(join(dist, 'main.js'), 'packages/gui/dist/main.js');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // --- main process
  await build({
    entryPoints: [join(dist, 'main.js')],
    outfile: join(out, 'main.js'),
    bundle: true, platform: 'node', format: 'esm', target: NODE_TARGET,
    external: ['electron'],
    sourcemap: true, logLevel: 'warning',
  });

  // --- preloads: whatever tsc compiled to `.cjs`, so a new preload cannot be forgotten here.
  const preloads = readdirSync(dist).filter((f) => f.endsWith('.cjs'));
  if (preloads.length === 0) throw new BundleError('no dist/*.cjs preloads: run npm run build first');
  for (const p of preloads) {
    await build({
      entryPoints: [join(dist, p)], outfile: join(out, p),
      bundle: true, platform: 'node', format: 'cjs', target: NODE_TARGET,
      external: ['electron'], sourcemap: true, logLevel: 'warning',
    });
  }

  // --- documents, their page modules and their stylesheets
  /*
    FLAT MEANS ONE NAMESPACE: every page module and stylesheet lands at `app/<basename>`, so two
    DIFFERENT sources with one basename would silently overwrite each other and one window would
    load the other's code. Refused instead. The same source named by two documents (`ui.css`, three
    times today) is the normal case and is written once.
  */
  const claimed = new Map();
  const claim = (name, source) => {
    const prior = claimed.get(name);
    if (prior !== undefined && prior !== source) {
      throw new BundleError(`app/${name} would be written from both ${prior} and ${source}`);
    }
    const fresh = prior === undefined;
    claimed.set(name, source);
    return fresh;
  };
  for (const doc of DOCUMENTS) {
    const docPath = join(gui, doc);
    need(docPath, doc);
    let html = readFileSync(docPath, 'utf8');
    const { map, block } = importMap(doc, html);
    if (block !== undefined) html = html.replace(block, '');

    const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"[^>]*>/g)].map((m) => m[1]);
    if (scripts.length === 0) throw new BundleError(`${doc} has no <script src>; nothing to bundle`);
    for (const src of scripts) {
      const entry = resolve(gui, src);
      need(entry, `${doc}'s <script src="${src}">`);
      const name = basename(entry);
      // Claimed PER DOCUMENT: a page module is resolved through ITS document's import map, so one
      // module shared by two documents could mean two different graphs -- refused as a collision
      // rather than silently built with whichever map came first.
      if (claim(name, `${entry} (for ${doc})`)) await build({
        entryPoints: [entry], outfile: join(out, name),
        bundle: true, platform: 'browser', format: 'esm', target: BROWSER_TARGET,
        plugins: [importMapPlugin(doc, map)], sourcemap: true, logLevel: 'warning',
      });
      const written = `src="${src}"`;
      if (!html.includes(written)) throw new BundleError(`${doc}: could not find ${written} to rewrite`);
      html = html.replace(written, `src="./${name}"`);
    }

    // Stylesheets and any other non-script reference: copied flat, by basename.
    for (const m of html.matchAll(/<link\b[^>]*\shref="([^"]+)"[^>]*>/g)) {
      const href = m[1];
      const file = resolve(gui, href);
      need(file, `${doc}'s <link href="${href}">`);
      if (claim(basename(file), file)) copyFileSync(file, join(out, basename(file)));
      html = html.replace(`href="${href}"`, `href="./${basename(file)}"`);
    }

    html = stripComments(html).replace(/^<!DOCTYPE html>\n/,
      `<!DOCTYPE html>\n<!-- Generated by packages/gui/scripts/bundle.mjs from packages/gui/${doc}; edit that. -->\n`);
    writeFileSync(join(out, doc), html);
  }

  // --- atlas, read from the package that bakes it
  for (const f of ['atlas.json', 'atlas.bin']) {
    need(join(assetDir(), f), `@tn3270/canvas ${f}`);
    copyFileSync(join(assetDir(), f), join(out, f));
  }

  /*
    `name` IS THE GUI MANIFEST'S, AND THAT DECIDES `app.getName()` AND THE userData DIRECTORY.
    MEASURED 2026-11-06 with a probe calling `app.getName()`/`app.getPath('userData')`:
      - `electron packages/gui/dist/main.js` (every harness, a FILE path): `Electron`, ~/.config/Electron
      - `electron <dir>` whose package.json says `@tn3270/gui`: `@tn3270/gui`, ~/.config/@tn3270/gui
      - the same with `productName: "tn3270"`: `tn3270`, ~/.config/tn3270 (productName wins)
    So the unbundled value cannot be matched and should not be: it is Electron's default, shared by
    every Electron app launched that way. No `productName` here; the user-visible app name is the
    electron-builder configuration's decision, which can set it on this file.
  */
  const manifest = JSON.parse(readFileSync(join(gui, 'package.json'), 'utf8'));
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({
    name: manifest.name, version: manifest.version, description: manifest.description,
    license: manifest.license, author: manifest.author, type: 'module', main: 'main.js',
  }, null, 2)}\n`);
  writeFileSync(join(out, 'BUNDLED'),
    'Marker read by src/appRoot.ts: this directory is the flat esbuild layout. Contents unused.\n');

  verify();
}

/** The always-run check described at the top. Collects every problem before refusing. */
function verify() {
  const problems = [];
  for (const doc of DOCUMENTS) {
    const html = readFileSync(join(out, doc), 'utf8');
    if (/type\s*=\s*"importmap"/.test(html)) problems.push(`${doc}: an import map survived`);
    const refs = refsOf(html);
    if (refs.length === 0) problems.push(`${doc}: references nothing, which cannot be right`);
    for (const ref of refs) {
      if (ref.includes('../')) problems.push(`${doc}: ${ref} climbs out of app/`);
      else if (/^[a-z]+:|^\/\//i.test(ref) || isAbsolute(ref)) problems.push(`${doc}: ${ref} is not app-relative`);
      else if (!existsSync(resolve(out, ref))) problems.push(`${doc}: ${ref} is not in app/`);
    }
  }
  // Every file main.ts hands Electron, read from its source so a new window cannot be missed.
  const mainSrc = readFileSync(join(gui, 'src', 'main.ts'), 'utf8');
  const asked = [...mainSrc.matchAll(/layout\.(?:document|preload)\('([^']+)'\)/g)].map((m) => m[1]);
  if (asked.length === 0) problems.push('found no layout.document/preload calls in src/main.ts; the pattern drifted');
  for (const f of asked) if (!existsSync(join(out, f))) problems.push(`main.ts loads ${f}, which is not in app/`);
  // The main bundle must not have kept a runtime `require` esbuild could not resolve (an ESM
  // bundle turns one into a shim that throws at startup) or any import other than node: builtins
  // and electron.
  const mainJs = readFileSync(join(out, 'main.js'), 'utf8');
  if (/\b__require\(/.test(mainJs)) problems.push('app/main.js contains a __require shim that throws under ESM');
  for (const m of mainJs.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)) {
    if (!m[1].startsWith('node:') && m[1] !== 'electron') problems.push(`app/main.js still imports ${m[1]}`);
  }
  if (problems.length > 0) throw new BundleError(`app/ is not self-contained:\n  ${problems.join('\n  ')}`);
}

try {
  await main();
  const files = readdirSync(out).sort();
  console.log(`bundled ${files.length} files into ${relative(process.cwd(), out) || out}`);
} catch (err) {
  // esbuild has already printed its own errors, with source excerpts; a stack trace under them
  // adds nothing. Ours name their fix.
  if (err instanceof BundleError) console.error(`bundle.mjs: ${err.message}`);
  else if (Array.isArray(err?.errors)) console.error(`bundle.mjs: esbuild failed with ${err.errors.length} error(s), above`);
  else console.error(err);
  process.exit(1);
}
