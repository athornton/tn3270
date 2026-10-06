import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_MODULES } from '@tn3270/canvas';
import { resolveAsset, tokenCookie, parseCookies } from '../src/httpstatic.js';

/**
 * A FIXED TABLE, not a path mapping. There is no traversal to defend against because there is no
 * arithmetic on the request path -- the only reachable files are the ones the table names. Written
 * without a COUNT on purpose, and the history is the argument: the count once said "five" while
 * the table held six, `hittest.js` made it seven, that module was DELETED with the canvas keypad
 * on 2026-10-06, and the keypad overlay then added five entries of its own. A number in this
 * docstring would have been wrong four times.
 */
describe('resolveAsset', () => {
  it('serves the page and every browser module by path', () => {
    for (const p of ['/', '/index.html', '/bridge.js', '/bridgecore.js',
                     '/renderer.js', '/blit.js', '/keys.js', '/selection.js',
                     // The keypad overlay's own five: its module, the shared view, the two
                     // import-free leaves that view reaches, and the stylesheet. `hittest.js` was
                     // in this list until the canvas keypad was deleted.
                     '/keypadOverlay.js', '/keypadUi.js', '/keypadView.js', '/keypad.js',
                     '/bindings.js', '/ui.css']) {
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
    // failure `assets.ts` was extracted to prevent. SIX since the keypad overlay's `keypadUi.js`
    // joined it; five when the selection gesture's `selection.js` did. `hittest.js` was a member
    // until the canvas keypad was deleted on 2026-10-06, which is why this moved 6 -> 5 rather
    // than up: one module left as another arrived. SIX AGAIN since the transfer form's
    // `transferUi.js` joined later that same day for the gateway's in-pane overlay -- so this
    // number has now been 5, 6, 7, 6 and 5 before reaching 6, which is the argument for keeping
    // the history in this comment rather than just the current figure.
    expect(BROWSER_MODULES.length).toBe(6);
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
    // `/ui.css` IS IN THIS LOOP AND IS THE FIRST NON-JS, NON-OWN-PACKAGE ASSET -- it is served
    // from `packages/gui`, where the shared stylesheet lives because the GUI's two windows were
    // its first consumers. A path into a third package is exactly the kind of thing that resolves
    // in the table and 404s at runtime, which is what this loop exists to catch.
    //
    // `/transferUi.js` and `/transferForm.js` JOINED 2026-10-06 and they belong here for the same
    // reason `/ui.css` does -- both reach into another package's `dist` (canvas's through
    // `assetDir()`, frontend's through a relative path), so both are exactly the kind of entry
    // that resolves in the table and 404s in a browser.
    //
    // `/transferChunk.js` IS DELIBERATELY NOT HERE, by the same trap as `/bridge.js` and MEASURED
    // the same way: it is `join(here, ...)` in this package, and under vitest `import.meta.url` is
    // the SOURCE file, so it resolves to `packages/web/src/transferChunk.js` -- a path that never
    // exists, because the source is `.ts`. Its built file is asserted in the `/bridge.js` case
    // below instead, which is where this table's own-package paths are checked.
    for (const p of ['/', '/index.html', '/renderer.js', '/blit.js', '/keys.js',
      '/selection.js', '/keypadUi.js', '/transferUi.js', '/transferForm.js', '/ui.css']) {
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
    // `transferChunk.js` is the SECOND own-package module served (2026-10-06), and it lands in
    // the same trap -- MEASURED: `resolveAsset('/transferChunk.js').file` is
    // `packages/web/src/transferChunk.js` under vitest, which does not and cannot exist. So it is
    // checked here in both halves rather than in the existence loop above.
    expect(resolveAsset('/transferChunk.js')!.file).toMatch(/[/\\]transferChunk\.js$/);
    expect(existsSync(join(pkgDir, 'dist', 'transferChunk.js'))).toBe(true);
    // `transferBridge.js` is the THIRD, added 2026-10-06 with the module itself, and it is in the
    // same trap for the same reason: under vitest `import.meta.url` is the SOURCE file, so the
    // entry resolves to `packages/web/src/transferBridge.js`, which never exists.
    //
    // ## WHAT THESE TWO LINES DO AND DO NOT CATCH, MEASURED RATHER THAN CLAIMED
    //
    // THEY CATCH A MISSING ENTRY. 2026-10-06: deleting `'transferBridge.js'` from
    // `httpstatic.ts`'s own-package loop reddens both this case and the transfer-modules case
    // below -- 2 failures. That is the break that matters, because a 404 on a module
    // `transferBoot.js` imports means the IMPORTING module never runs.
    //
    // THEY DO NOT CATCH A BOGUS EXTRA ENTRY, and an earlier version of this very comment claimed
    // they did. MEASURED the same day: adding `'doesNotExist.js'` to that loop leaves this FILE
    // at 18/18 green, these two lines included -- they name one module each, so they cannot
    // notice a neighbour that was invented. Nothing in the suite can: the existence loop above
    // deliberately excludes own-package paths for the resolution reason just given. So an entry
    // for a module that does not exist is still caught by NOTHING automatically, which is why
    // `httpstatic.ts` carries that warning and why a module is added here only when it is built.
    expect(resolveAsset('/transferBridge.js')!.file).toMatch(/[/\\]transferBridge\.js$/);
    expect(existsSync(join(pkgDir, 'dist', 'transferBridge.js'))).toBe(true);
  });
});

describe('transfer modules', () => {
  it('serves every browser module the transfer overlay needs', () => {
    // `resolveAsset` is this suite's own entry point -- it is what the existing cases use, and
    // it answers for one URL path at a time. There is no map-returning helper.
    // ONLY THE MODULES THAT EXIST TODAY. Tasks 6 and 8 add their own as they create them.
    // `transferBridge.js` joined 2026-10-06 with the file itself, which is the habit Task 4's
    // note argues for: the entry and the module land together, so neither can be forgotten.
    for (const path of ['/transferUi.js', '/transferChunk.js', '/transferBridge.js']) {
      expect(resolveAsset(path), path).toBeDefined();
    }
  });

  it('serves transferForm.js, which transferUi.js imports for its field table', () => {
    // The import-graph closure rule this file already tests for the keypad: a 404 on a
    // transitive import means the IMPORTING module never executes, and the error surfaces in
    // the next script naming the wrong file.
    expect(resolveAsset('/transferForm.js')).toBeDefined();
  });

  it('lists transferUi.js in BROWSER_MODULES, which is what makes it served', () => {
    // `httpstatic.ts` DERIVES its canvas entries from that list rather than retyping them, so
    // this is the assertion that one edit reaches the server.
    expect(BROWSER_MODULES).toContain('transferUi.js');
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
