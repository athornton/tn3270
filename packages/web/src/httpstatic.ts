import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assetDir, BROWSER_MODULES } from '@tn3270/canvas';

/**
 * The only files a browser can fetch, as a FIXED TABLE.
 *
 * There is deliberately no mapping from request path to filesystem path: a table lookup cannot be
 * walked out of, so directory traversal is not a class of bug this file can have. Adding a
 * pattern-matched route here would reintroduce it.
 *
 * ## A `Map`, NOT AN OBJECT, AND THAT IS NOT A STYLE CHOICE
 *
 * MEASURED on the object version: `table['constructor']` returns `Function` and
 * `table['__proto__']` returns `Object.prototype`. Both are truthy non-Assets, so a caller trusting
 * this function's "everything else is refused" contract would reach `readFileSync(undefined)`. No
 * real request path can get there, because every key here starts with `/` -- but this branch has
 * already been bitten once by a frozen plain object still inheriting, and a `Map` cannot have the
 * bug at all rather than merely not exhibiting it today.
 *
 * The atlas is NOT here. It goes over the socket, which is what keeps the renderer's contract
 * identical to Electron's IPC path -- and one way to get a thing is easier to keep correct than two.
 */
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, '..', 'static');

export interface Asset { readonly file: string; readonly type: string }

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

let cached: Map<string, Asset> | undefined;

/** Built lazily so `assetDir()` is not called at import time in a test that never serves. */
function table(): Map<string, Asset> {
  if (cached !== undefined) return cached;
  const page: Asset = { file: join(staticDir, 'index.html'), type: HTML };
  const built = new Map<string, Asset>([
    ['/', page],
    ['/index.html', page],
  ]);
  // THIS PACKAGE'S OWN browser modules, and `bridgecore.js` is not optional: `bridge.js` imports it,
  // so serving only the entry point 404s the import and the module never loads. MEASURED -- the page
  // then has no `window.tn3270`, the renderer's registrations go nowhere, and the result is a black
  // canvas with NO error in any console and nothing on the server but a 404. `renderer-imports`-style
  // graph closure is asserted in `httpstatic.test.ts`, because a table cannot notice its own gap.
  // `keypadOverlay.js` joined for the keypad overlay, AND ITS ABSENCE WAS MEASURED, not foreseen:
  // without it `browser-shot.mjs` reported `Cannot read properties of undefined (reading
  // 'onAtlas')` from renderer.js and 0/2 goldens. The 404 is on a module `bridge.js` imports, so
  // BRIDGE.JS ITSELF NEVER EXECUTES -- `window.tn3270` is never assigned, and the error surfaces
  // in the NEXT script rather than this one. That misdirection is the whole reason this list has
  // a test walking the graph: the symptom names the wrong file.
  for (const module of [
    'bridge.js', 'bridgecore.js', 'keypadOverlay.js',
    // `transferChunk.js` joins 2026-10-06: the browser WILL need `chunkBytes` and the 10 MB cap
    // to refuse an oversize file before sending a byte, so it will be loaded by both sides.
    // NOTHING LOADS IT TODAY -- the page's module graph is `bridge.js` and `renderer.js` and
    // reaches neither this nor `transferUi.js`. Served ahead of the overlay that will import it (a
    // later task in the same plan) deliberately: the entry is what stops it 404ing the day that
    // lands, and an entry costs nothing until then.
    //
    // Safe to serve, and checked rather than assumed -- `dist/transferChunk.js` has ZERO imports
    // of any kind (measured 2026-10-06 on the BUILT file, since `import type` erases), so it
    // closes the graph at itself and needs no map entry or neighbour of its own.
    //
    // AN ENTRY IN *THIS* LOOP IS NOT COVERED BY THE EXISTS-AFTER-BUILD TEST, which is the trap
    // worth naming here. An earlier version of this comment claimed the opposite -- that naming a
    // module Tasks 5/6/8 have not written yet "would fail" that case. MEASURED 2026-10-06: adding
    // `'transferOverlay.js'` here leaves `httpstatic.test.ts` at 18/18 GREEN. Own-package paths are
    // deliberately excluded from that loop, because under vitest `import.meta.url` is the SOURCE
    // file so they resolve into `src/` rather than `dist/` -- the same reason its comment gives for
    // keeping `/bridge.js` out. So a bogus entry here is caught by NOTHING automatically, and the
    // only cover is the hand-written assertion in the `/bridge.js` case, where `transferChunk.js`
    // is named explicitly. ADD YOUR MODULE THERE TOO when you add it here.
    'transferChunk.js',
    // `transferBridge.js` joins the same day, WITH the file rather than ahead of it: it reads a
    // local file into chunks and writes a received one out, and `transferBoot.js` will import it.
    // Its only runtime import is `./transferChunk.js` above, so it closes the graph at a module
    // already served and needs no map entry of its own. MEASURED on the BUILT file, since
    // `import type` erases -- `dist/transferBridge.js` has exactly that one `from` line.
    //
    // NOT LOADED BY ANY PAGE YET, like `transferChunk.js` beside it: the page's graph is still
    // `bridge.js` and `renderer.js`, and Task 8's boot module is what will reach this.
    'transferBridge.js',
  ]) {
    built.set(`/${module}`, { file: join(here, module), type: JS });
  }
  // DERIVED FROM `BROWSER_MODULES`, not retyped. That list is what `canvas` publishes for this
  // consumer, and `assets.ts` exists precisely because a second copy of an asset list drifts
  // silently when the package that owns the files changes. `assetDir()` answers WHERE, so this file
  // never guesses a relative path into a sibling package's dist.
  for (const module of BROWSER_MODULES) {
    built.set(`/${module}`, { file: join(assetDir(), module), type: JS });
  }
  /**
   * `ui.css`, THE SHARED STYLESHEET, WHICH LIVES IN `packages/gui`.
   *
   * ## WHY A THIRD ASSET ROOT, RELUCTANTLY
   *
   * The two above are this package's own `dist` and `canvas`'s, the latter through `assetDir()`
   * precisely so no relative path into a sibling is guessed. This is the first asset served from
   * a package the web gateway does not depend on -- and that asymmetry is the point: the file is
   * in `gui` because the GUI's two windows were its first consumers, and the user's requirement
   * that the keypad and the transfer window look alike is what made it shared at all.
   *
   * ## THE ALTERNATIVES, AND WHY THIS ONE
   *
   * Moving `ui.css` into `canvas` beside the atlas was the obvious tidy, and it is wrong for a
   * reason worth recording: `canvas` is the package whose whole job is pixels blitted from a font
   * atlas, and `ui.css` is the stylesheet for the surfaces that are deliberately NOT that. Putting
   * HTML chrome there would blur the one boundary this split exists to draw. Copying the file into
   * `web/static` was the other option and is the thing `assets.ts` exists to prevent -- two copies
   * of a stylesheet diverge the first time one is touched, which is the exact failure that made
   * this file shared in the first place.
   *
   * So: one path, named once, with a comment. `uiAssets.test.ts` in `gui` checks the file exists
   * for that package's documents; `httpstatic.test.ts` checks this entry resolves.
   *
   * NOT DERIVED FROM A LIST, because there is exactly one such asset. A `GUI_ASSETS` array of one
   * element would be ceremony that implies a pattern nobody has.
   */
  built.set('/ui.css', {
    file: join(here, '..', '..', 'gui', 'ui.css'),
    type: 'text/css; charset=utf-8',
  });
  /**
   * THE THREE `frontend` MODULES THE KEYPAD OVERLAY NEEDS, and this is where the web gateway
   * differs from the Electron GUI in a way that is easy to miss.
   *
   * ## THE GUI GETS THESE FOR FREE AND THE GATEWAY DOES NOT
   *
   * `gui/keypad.html` and `gui/transfer.html` carry import maps pointing at
   * `../frontend/dist/...`, and they WORK -- because an Electron window loads from `file://`,
   * where `..` is a real directory on disk. A served page has no such thing: `..` is a URL path
   * the server must answer, and nothing here answered it. The failure would have been the whole
   * blank-page family again, this time from a 404 on a module the import map named confidently.
   *
   * MEASURED while wiring the overlay: `bridge.js` imports `@tn3270/canvas` (mapped to
   * `keypadUi.js`, served above), which imports `@tn3270/frontend` (mapped to `keypadView.js`),
   * which value-imports `./keypad.js` and `./bindings.js`. Three files, and all three have to be
   * reachable by URL or the chain breaks at the first missing link.
   *
   * ## SERVED AT THE ROOT, FLAT, LIKE EVERY OTHER MODULE HERE
   *
   * Not under a `/frontend/` prefix: the two already-served packages are flat at `/`, and a
   * second convention would be one more thing for `index.html`'s map to get wrong. The map names
   * `./keypadView.js`, so `keypadView.js`'s own relative imports of `./keypad.js` and
   * `./bindings.js` resolve against the same flat root and need no map entries of their own.
   *
   * THEY ARE SAFE TO SERVE, which is not true of every module in that package: each of these
   * three has zero `node:` imports and no reach into `tls.js`, pinned by
   * `frontend/test/keypadModule.test.ts`. Serving the package BARREL would be the mistake -- it
   * reaches `tls.js` and its `node:net`/`node:tls`/`node:fs`.
   */
  const frontendDist = join(here, '..', '..', 'frontend', 'dist');
  // `transferForm.js` joined 2026-10-06 for the transfer overlay. It is SAFE by the same test
  // as its neighbours: zero imports at all (`gui/test/transferModule.test.ts` asserts exactly
  // that, and it was re-measured on the built file this day), which is why BOTH front ends'
  // import maps point straight at it.
  //
  // NOTE THE SPECIFIER IT IS REACHED BY, because it differs from its three neighbours above:
  // `transferUi.js` imports `@tn3270/frontend/dist/transferForm.js`, a DEEP path, since the bare
  // `@tn3270/frontend` key in `static/index.html` is already bound to `keypadView.js` for the
  // keypad and an import-map key without a trailing `/` matches EXACTLY. The map therefore needs
  // its own entry naming that deep specifier -- but the ADDRESS is still `./transferForm.js`,
  // flat at the root like everything else here.
  for (const module of ['keypadView.js', 'keypad.js', 'bindings.js', 'transferForm.js']) {
    built.set(`/${module}`, { file: join(frontendDist, module), type: JS });
  }
  cached = built;
  return built;
}

export function resolveAsset(path: string): Asset | undefined {
  return table().get(path);
}

/**
 * The token cookie.
 *
 * `Secure` is conditional and that is not timidity: a `Secure` cookie is DROPPED by the browser
 * over plain HTTP, so setting it unconditionally would break authentication on exactly the
 * deployment that has no TLS. `HttpOnly` means the bridge never reads it -- it does not need to,
 * because the browser attaches cookies to the WebSocket upgrade automatically.
 */
export function tokenCookie(token: string, secure: boolean): string {
  const parts = [`tn3270_token=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Parse a `Cookie` header.
 *
 * NULL-PROTOTYPE RESULT, DELIBERATELY. `out[name] = value` on an object literal with the name
 * `__proto__` does not set a cookie -- it replaces the prototype, which is process-wide corruption
 * reached from a request header. And since `handshake.ts` looks the token up BY NAME in this result,
 * a plain object would also let a `constructor=x` cookie make that lookup return a function instead
 * of a string.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}
