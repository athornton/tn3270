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
  for (const module of ['bridge.js', 'bridgecore.js']) {
    built.set(`/${module}`, { file: join(here, module), type: JS });
  }
  // DERIVED FROM `BROWSER_MODULES`, not retyped. That list is what `canvas` publishes for this
  // consumer, and `assets.ts` exists precisely because a second copy of an asset list drifts
  // silently when the package that owns the files changes. `assetDir()` answers WHERE, so this file
  // never guesses a relative path into a sibling package's dist.
  for (const module of BROWSER_MODULES) {
    built.set(`/${module}`, { file: join(assetDir(), module), type: JS });
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
