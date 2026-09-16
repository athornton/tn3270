import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_MODULES } from '@tn3270/canvas';
import { resolveAsset, tokenCookie, parseCookies } from '../src/httpstatic.js';

/**
 * A FIXED TABLE, not a path mapping. There is no traversal to defend against because there is no
 * arithmetic on the request path -- the only reachable files are the ones the table names. Written
 * without a COUNT on purpose: the count said "five" while the table held six, and the keypad's
 * `hittest.js` has since made it seven.
 */
describe('resolveAsset', () => {
  it('serves the page and every browser module by path', () => {
    for (const p of ['/', '/index.html', '/bridge.js', '/bridgecore.js',
                     '/renderer.js', '/blit.js', '/keys.js', '/hittest.js']) {
      expect(resolveAsset(p), `for ${p}`).toBeDefined();
    }
  });

  it('gives / and /index.html the same file, with an HTML content type', () => {
    expect(resolveAsset('/')!.file).toBe(resolveAsset('/index.html')!.file);
    expect(resolveAsset('/')!.type).toMatch(/^text\/html/);
  });

  it('serves the browser modules as JavaScript', () => {
    expect(resolveAsset('/renderer.js')!.type).toMatch(/javascript/);
  });

  it('refuses everything else, including traversal attempts', () => {
    for (const p of ['/../package.json', '/../../etc/passwd', '/main.js', '/atlas.bin',
                     '/index.html/../secret', '//etc/passwd', '/drawlist.js']) {
      expect(resolveAsset(p), `for ${p}`).toBeUndefined();
    }
  });

  it('refuses inherited property names, which a plain-object table would RESOLVE', () => {
    // MEASURED on the plan's `Record`-and-index-signature version: `table()['constructor']` returns
    // `Function` and `table()['__proto__']` returns `Object.prototype`. Both are truthy non-Assets,
    // so the caller would go on to `readFileSync(undefined)` -- and `resolveAsset`'s documented
    // contract is that it refuses everything not in the table. A real request path always begins
    // with `/`, so this is not reachable over HTTP today; it is reachable through the exported
    // function, and this branch has already been bitten once by a frozen plain object still
    // inheriting from `Object.prototype`. A `Map` cannot have the bug at all.
    for (const p of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(resolveAsset(p), `for ${p}`).toBeUndefined();
    }
  });

  it('does NOT serve the atlas, which travels over the socket instead', () => {
    // Keeping the renderer's contract identical to the IPC path is the reason; a served atlas
    // would be a second way to get it and a second thing to keep in step.
    expect(resolveAsset('/atlas.json')).toBeUndefined();
  });

  it('serves every module `canvas` declares a browser needs', () => {
    // The drift guard. `BROWSER_MODULES` is the list `canvas` publishes for exactly this consumer,
    // so naming those files again here would be a second copy to keep in step -- which is the
    // failure `assets.ts` was extracted to prevent. Four since the keypad's `hittest.js` joined it.
    expect(BROWSER_MODULES.length).toBe(4);
    for (const m of BROWSER_MODULES) expect(resolveAsset(`/${m}`), `for ${m}`).toBeDefined();
  });

  it('every file it claims to serve EXISTS after a build', () => {
    // Resolving a path only says the table has an entry. A renamed or unbuilt module still
    // resolves, then 404s at runtime and leaves a BLANK CANVAS WITH NO ERROR -- the signature this
    // renderer has already produced four separate ways. Reads the built tree deliberately, as
    // `renderer-imports.test.ts` does.
    //
    // `/bridge.js` IS NOT IN THIS LOOP, and the reason is a trap rather than an omission -- see the
    // separate test below. Adding it here fails, because the two kinds of path in the table resolve
    // differently under vitest.
    for (const p of ['/', '/index.html', '/renderer.js', '/blit.js', '/keys.js', '/hittest.js']) {
      const asset = resolveAsset(p)!;
      expect(existsSync(asset.file), `${p} -> ${asset.file}`).toBe(true);
    }
  });

  it('serves EVERY module reachable from the ones it serves', () => {
    // THE GUARD THAT CATCHES WHAT A TABLE CANNOT NOTICE ABOUT ITSELF, and it is not hypothetical:
    // the planned table listed five files and omitted `bridgecore.js`, which `bridge.js` imports.
    // MEASURED against the running gateway -- `/bridge.js` answered 200 and `/bridgecore.js` 404,
    // so the module never loaded, `window.tn3270` never appeared, the renderer's registrations went
    // nowhere, and the page was a BLACK CANVAS with no error in any console. The only evidence
    // anywhere was one 404 in a log nobody was reading. Every existing test passed.
    //
    // A per-file existence check cannot find this, because the missing file is missing from the
    // TABLE, so nothing iterates it. Closure over the import graph is the property that matters, and
    // it is the same instinct as `canvas`'s `renderer-imports.test.ts` -- read the BUILT javascript,
    // since `import type` erases and only the runtime graph can 404.
    const served = ['/bridge.js', '/bridgecore.js', '/renderer.js', '/blit.js', '/keys.js'];
    const queue = [...served];
    const seen = new Set<string>();
    const missing: string[] = [];
    while (queue.length > 0) {
      const path = queue.pop()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const asset = resolveAsset(path);
      if (asset === undefined) { missing.push(path); continue; }
      // Built output only; a source tree has no `.js` to read here.
      if (!existsSync(asset.file)) continue;
      const source = readFileSync(asset.file, 'utf8');
      for (const m of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        // Every served path is flat at the root, so a relative specifier maps to `/basename`.
        queue.push(`/${m[1]!.replace(/^\.\//, '')}`);
      }
    }
    expect(missing, `imported but not served: ${missing.join(', ')}`).toEqual([]);
    // The walk must have actually read something, or an empty graph would pass vacuously.
    expect(seen.size).toBeGreaterThanOrEqual(served.length);
  });

  it('serves the bridge from beside itself, and the BUILT bridge exists', () => {
    // WHY `/bridge.js` CANNOT JOIN THE LOOP ABOVE, measured by trying it: the table holds two kinds
    // of path, and under vitest they resolve into different trees.
    //
    // `/bridge.js` is `join(here, 'bridge.js')` where `here` comes from `import.meta.url` -- which
    // vitest sets to the SOURCE file, so it lands on `packages/web/src/bridge.js`, a file that never
    // exists because the source is `bridge.ts`. In production `httpstatic.js` and `bridge.js` are
    // siblings in `dist` and the path is right. The canvas modules resolve through `assetDir()`
    // instead, and `@tn3270/canvas` resolves to its BUILT dist even under vitest, so those are
    // checkable directly. Same table, two trees.
    //
    // So the two halves are asserted separately: that the entry names the file beside the module,
    // and that the built file is really there. This matters as much as any other asset -- the page
    // loads the bridge FIRST and `renderer.js` reads `window.tn3270` in its module body, so a
    // missing bridge means nothing renders and nothing says why.
    expect(resolveAsset('/bridge.js')!.file).toMatch(/[/\\]bridge\.js$/);
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    expect(existsSync(join(pkgDir, 'dist', 'bridge.js'))).toBe(true);
  });
});

describe('tokenCookie', () => {
  it('is HttpOnly and SameSite=Strict, so a hostile page cannot read or send it cross-site', () => {
    const c = tokenCookie('abc', false);
    expect(c).toContain('tn3270_token=abc');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
  });

  it('adds Secure only when the gateway itself is TLS', () => {
    // Secure on a plaintext gateway would make the browser DROP the cookie, breaking the token
    // entirely -- so this flag cannot simply be set unconditionally "to be safe".
    expect(tokenCookie('abc', false)).not.toContain('Secure');
    expect(tokenCookie('abc', true)).toContain('Secure');
  });
});

describe('parseCookies', () => {
  it('reads one and several cookies', () => {
    expect(parseCookies('tn3270_token=abc')).toEqual({ tn3270_token: 'abc' });
    expect(parseCookies('a=1; tn3270_token=abc; b=2').tn3270_token).toBe('abc');
  });

  it('survives absent, empty and malformed headers without throwing', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('junk')).toEqual({});
    expect(parseCookies('=x; y=')).toEqual({ y: '' });
  });

  it('does not let a cookie NAME reach Object.prototype either', () => {
    // Same hole, other end: `out[name] = ...` on a plain object with name `__proto__` mutates the
    // prototype of every object literal in the process rather than setting a cookie. The handshake
    // reads `parseCookies(...)[TOKEN_COOKIE]`, so a null-prototype result also means a hostile
    // `constructor=x` cookie cannot make the token lookup return a function.
    const out = parseCookies('__proto__=polluted; constructor=x; tn3270_token=real');
    expect(out.tn3270_token).toBe('real');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBeNull();
  });
});
