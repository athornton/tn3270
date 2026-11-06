import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_MODULES } from '@tn3270/canvas';
import { resolveAsset, assetPaths, tokenCookie, parseCookies } from '../src/httpstatic.js';

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
    // the history in this comment rather than just the current figure. SEVEN since the full
    // 122-key keyboard's `keyboardUi.js` joined on 2026-10-22, for the gateway's second in-pane
    // surface -- and that one arrived with a measured lesson: a module MISSING from this list is
    // a 404 that stops the IMPORTING module evaluating, which the browser reports only as
    // `window.tn3270` never being assigned. A blank canvas, not a missing file.
    // EIGHT since `forwardKeys.js` joined on 2026-10-23, when `renderer.ts` stopped inlining the
    // editable-target rule and imported the shared one -- a renderer-graph entry again, like
    // `selection.js`, and the same measured symptom as the sentence above: omitting it took
    // `browser-clicks.mjs` from 9/9 and 8/8 to no keypad buttons and 1/8, with every failing check
    // naming a module other than the one that 404'd. THE GRAPH-CLOSURE CASE BELOW DID CATCH IT,
    // unlike the 2026-10-22 miss it describes -- what hid it for a while was running only
    // `vitest run packages/canvas`, which cannot reach this file.
    // NINE since `copyCache.js` joined on 2026-11-02, the renderer's prefetched selection text --
    // a renderer-graph entry like `forwardKeys.js`, and the closure case below caught its removal.
    expect(BROWSER_MODULES.length).toBe(9);
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
    // `/ui.css` IS NOT IN THIS LOOP ANYMORE, and the reason changed along with its mechanism:
    // it USED to reach into `packages/gui` by a monorepo-relative path, making it "the first
    // non-JS, non-own-package asset" and exactly the kind of entry this loop existed to catch.
    // It is now `join(here, 'ui.css')`, an OWN-PACKAGE path copied into this package's `dist` by
    // `scripts/copy-ui-css.mjs` at build time -- which puts it in the SAME trap as `/bridge.js`
    // below rather than this loop's: under vitest `import.meta.url` is the SOURCE file, so the
    // entry resolves to `packages/web/src/ui.css`, which never exists (src/ never gets the copy,
    // only dist/ does). Checked instead in the `/bridge.js` case, where this table's other
    // own-package, vitest-trapped paths are checked against the built tree directly.
    //
    // `/transferUi.js` and `/transferForm.js` JOINED 2026-10-06 and belong here because both
    // reach into another package's `dist` through that package's own resolver (canvas's through
    // `assetDir()`, frontend's through `createRequire(...).resolve('@tn3270/frontend')`), which
    // resolves to a real built file under vitest too -- exactly the kind of entry that resolves
    // in the table and 404s in a browser if that target package were ever left unbuilt.
    //
    // `/transferChunk.js` IS DELIBERATELY NOT HERE, by the same trap as `/bridge.js` and MEASURED
    // the same way: it is `join(here, ...)` in this package, and under vitest `import.meta.url` is
    // the SOURCE file, so it resolves to `packages/web/src/transferChunk.js` -- a path that never
    // exists, because the source is `.ts`. Its built file is asserted in the `/bridge.js` case
    // below instead, which is where this table's own-package paths are checked.
    for (const p of ['/', '/index.html', '/renderer.js', '/blit.js', '/keys.js',
      '/selection.js', '/keypadUi.js', '/transferUi.js', '/transferForm.js']) {
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

  it('WALKS BRIDGE.JS ITSELF, which the loop above silently cannot', () => {
    /*
      THE HOLE THIS CLOSES, MEASURED 2026-10-22 AND IT COST AN EVENING.

      `keyboardOverlay.js` was missing from `httpstatic.ts`'s own-module list while `bridge.js`
      imported it. The 404 stopped `bridge.js` executing, so the page had no `window.tn3270` and
      the console blamed `renderer.js` with `Cannot read properties of undefined (reading
      'onAtlas')`. `browser-clicks.mjs` reported 0/7. **ALL 2536 UNIT TESTS PASSED, INCLUDING THE
      GRAPH-CLOSURE TEST ABOVE** -- which exists for exactly this and could not see it.

      WHY IT COULD NOT: under vitest `/bridge.js` resolves to `packages/web/src/bridge.js`, a file
      that never exists because the source is `bridge.ts` (the next test explains that split at
      length). The loop above hits `existsSync` false, `continue`s, and NEVER READS BRIDGE'S
      IMPORTS. So it was vacuous for every module `bridge.js` pulls in -- which is most of this
      package's own browser code.

      SO THIS TEST READS THE BUILT FILE BY PATH instead of through `resolveAsset`, and checks each
      relative import against the table. It is the same property the loop above claims, over the
      one root that loop cannot reach.
    */
    // `pkgDir` is derived here rather than borrowed from the test below, which declares it in its
    // own scope. `import.meta.url` is this TEST file under vitest, so two `dirname`s reach the
    // package root -- the same derivation that test uses.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const built = join(root, 'dist', 'bridge.js');
    if (!existsSync(built)) {
      // A source-only tree has no dist. Fail LOUDLY rather than skipping: a silent skip here is
      // how this guard was vacuous in the first place.
      throw new Error(`run npm run build first: ${built} does not exist`);
    }
    const source = readFileSync(built, 'utf8');
    const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)]
      .map((m) => `/${m[1]!.replace(/^\.\//, '')}`);
    // NOT VACUOUS: bridge.js imports several modules, and a regex that matched none would
    // otherwise pass this test by finding nothing to check.
    expect(imports.length, 'bridge.js should import several relative modules')
      .toBeGreaterThanOrEqual(4);
    const unserved = imports.filter((p) => resolveAsset(p) === undefined);
    expect(unserved, `bridge.js imports these and they are NOT served: ${unserved.join(', ')}`)
      .toEqual([]);
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
    // `transferOverlay.js` is the FOURTH, added 2026-10-07 with the module itself, in the same
    // trap for the same reason: under vitest `import.meta.url` is the SOURCE file, so the entry
    // resolves to `packages/web/src/transferOverlay.js`, which never exists. Same two-line cover,
    // same documented limit as the three above -- catches a deleted entry, not an invented one.
    expect(resolveAsset('/transferOverlay.js')!.file).toMatch(/[/\\]transferOverlay\.js$/);
    expect(existsSync(join(pkgDir, 'dist', 'transferOverlay.js'))).toBe(true);
    // `transferBoot.js` is the FIFTH, added 2026-10-07 with the module itself, and it is the one
    // of the five that `bridge.js` ACTUALLY IMPORTS -- so a missing entry here is not an inert
    // table gap but the measured misdirection: the 404 stops `bridge.js` executing entirely and
    // the error surfaces in `renderer.js`, naming the wrong file. Same trap as the four above
    // (under vitest `import.meta.url` is the SOURCE file, so the entry resolves to
    // `packages/web/src/transferBoot.js`, which never exists), same two-line cover, and the same
    // documented limit: this catches a DELETED entry, not an invented one.
    expect(resolveAsset('/transferBoot.js')!.file).toMatch(/[/\\]transferBoot\.js$/);
    expect(existsSync(join(pkgDir, 'dist', 'transferBoot.js'))).toBe(true);
    // `geometryOverlay.js`, 2026-11-04, the `Alt-M` picker `bridge.js` imports: same two lines.
    expect(resolveAsset('/geometryOverlay.js')!.file).toMatch(/[/\\]geometryOverlay\.js$/);
    expect(existsSync(join(pkgDir, 'dist', 'geometryOverlay.js'))).toBe(true);
    // `/ui.css` joined this group 2026-11-05 when its mechanism changed from a monorepo-relative
    // path into `packages/gui` to `join(here, 'ui.css')` plus a build-time copy
    // (`scripts/copy-ui-css.mjs`) -- the exact same vitest trap as `/bridge.js` above, since
    // `here` is this file's SOURCE directory under vitest and the copy only ever lands in `dist`.
    expect(resolveAsset('/ui.css')!.file).toMatch(/[/\\]ui\.css$/);
    expect(existsSync(join(pkgDir, 'dist', 'ui.css'))).toBe(true);
  });
});

describe('transfer modules', () => {
  it('serves every browser module the transfer overlay needs', () => {
    // `resolveAsset` is this suite's own entry point -- it is what the existing cases use, and
    // it answers for one URL path at a time. There is no map-returning helper.
    // `transferBridge.js` joined 2026-10-06 with the file itself, which is the habit Task 4's
    // note argues for: the entry and the module land together, so neither can be forgotten.
    // `transferOverlay.js` and then `transferBoot.js` joined the same way, 2026-10-07 -- and with
    // the last of them the page's module graph finally REACHES all five, since `bridge.js`
    // imports `transferBoot.js`.
    for (const path of ['/transferUi.js', '/transferChunk.js', '/transferBridge.js',
      '/transferOverlay.js', '/transferBoot.js']) {
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

describe('no asset path depends on the monorepo layout', () => {
  it('httpstatic.ts names no path that climbs out of its own package', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/httpstatic.ts', import.meta.url)), 'utf8');
    // Code lines only: the comments legitimately describe the old paths and the history of why
    // they were wrong, which this file's house style keeps rather than deletes.
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    // Two forms of "climb out twice", which is what a monorepo-relative path into a SIBLING
    // package's dist looks like from this package's src/: `join(here, '..', '..', 'x')` (two
    // separate string arguments) and a single `'../..'` specifier. One level up (`join(here,
    // '..', 'static')`, this package's own dist-relative path) is fine and must still match.
    expect(code).not.toMatch(/'\.\.'\s*,\s*'\.\.'/);
    expect(code).not.toMatch(/'\.\.\/\.\.'/);
  });

  it('resolves every table entry inside a package web actually depends on', () => {
    // A SOURCE SCAN (the test above) is a PROXY: it catches a `'..'`-shaped path, but it would
    // not catch a future regression spelled a different way -- say, a path built from
    // `process.cwd()` or a hardcoded absolute string. The STRONGER check is this one: resolve
    // every package `web` depends on THROUGH NODE's OWN RESOLVER (never by `..`, which is the
    // thing under test), then assert every file this table names is actually inside one of those
    // directories, or inside this package's own. This is also what makes the check
    // install-shaped: npm is free to hoist or nest `node_modules/@tn3270/*` however it likes, and
    // resolving through `createRequire(...).resolve` finds each package wherever that happens to
    // be, exactly as the gateway's own code does at runtime.
    const req = createRequire(import.meta.url);
    // `dirname` twice: each dependency's resolved entry point is `./dist/<file>.js` (`main` in
    // every one of these packages' `package.json`), so one `dirname` reaches `dist/` and a second
    // reaches the package root.
    const webRoot = dirname(dirname(req.resolve('@tn3270/web')));
    const canvasRoot = dirname(dirname(req.resolve('@tn3270/canvas')));
    const frontendRoot = dirname(dirname(req.resolve('@tn3270/frontend')));
    const allowedRoots = [webRoot, canvasRoot, frontendRoot];
    const offenders: string[] = [];
    for (const path of assetPaths()) {
      const file = resolveAsset(path)!.file;
      // `sep`, not '/': on Windows every resolved path uses `\\` (first Windows CI run, 2026-11-06).
      if (!allowedRoots.some((root) => file.startsWith(root + sep) || file === root)) {
        offenders.push(`${path} -> ${file}`);
      }
    }
    expect(offenders, `escaped the allowed package roots: ${offenders.join(', ')}`).toEqual([]);
    // Not vacuous: the table has more than a couple of entries, or this would pass by iterating
    // nothing.
    expect(assetPaths().length).toBeGreaterThan(5);
  });

  it('serves ui.css from this package\'s own directory, not from `gui`', () => {
    // NOT literally `web/dist/ui.css` here: under vitest `import.meta.url` is the SOURCE file
    // (the same trap every own-package path in this table hits, documented at length on
    // `/bridge.js` below), so this resolves to `web/src/ui.css` rather than `web/dist/ui.css`.
    // What matters for THIS test is the package -- `web`, not `gui` -- and the filename; that the
    // built file is really in `dist` is asserted separately, against the built tree, in the
    // `/bridge.js` case below where this table's other vitest-trapped own-package paths are.
    expect(resolveAsset('/ui.css')!.file).toMatch(/[\\/]web[\\/](?:src|dist)[\\/]ui\.css$/);
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
