import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { BROWSER_MODULES } from '@tn3270/canvas';
import { resolveAsset, tokenCookie, parseCookies } from '../src/httpstatic.js';

/**
 * A FIXED TABLE, not a path mapping. There is no traversal to defend against because there is no
 * arithmetic on the request path -- the only reachable files are the five named here.
 */
describe('resolveAsset', () => {
  it('serves the five files the browser needs', () => {
    for (const p of ['/', '/index.html', '/bridge.js', '/renderer.js', '/blit.js', '/keys.js']) {
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
    // so naming the three files again here would be a second copy to keep in step -- which is the
    // failure `assets.ts` was extracted to prevent.
    expect(BROWSER_MODULES.length).toBe(3);
    for (const m of BROWSER_MODULES) expect(resolveAsset(`/${m}`), `for ${m}`).toBeDefined();
  });

  it('every file it claims to serve EXISTS after a build', () => {
    // Resolving a path only says the table has an entry. A renamed or unbuilt module still
    // resolves, then 404s at runtime and leaves a BLANK CANVAS WITH NO ERROR -- the signature this
    // renderer has already produced four separate ways. Reads the built tree deliberately, as
    // `renderer-imports.test.ts` does.
    //
    // `/bridge.js` IS DELIBERATELY ABSENT FROM THIS LIST: it is built by Task 9 and does not exist
    // yet, so including it now would make this task's suite red for a reason unrelated to it.
    // Task 9 adds it, and until then the existence of the served bridge is unguarded.
    for (const p of ['/', '/index.html', '/renderer.js', '/blit.js', '/keys.js']) {
      const asset = resolveAsset(p)!;
      expect(existsSync(asset.file), `${p} -> ${asset.file}`).toBe(true);
    }
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
