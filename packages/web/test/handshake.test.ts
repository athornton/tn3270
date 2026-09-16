import { describe, it, expect } from 'vitest';
import {
  acceptKey, checkUpgrade, tokenMatches, TOKEN_COOKIE, type UpgradeResult,
} from '../src/handshake.js';

/**
 * Narrow a refusal to its reason, failing with a useful message if it was in fact accepted.
 *
 * The alternative idiom, `expect(r.ok === false && r.reason).toMatch(...)`, asserts on `false` when
 * the request was ACCEPTED -- so a security control that started letting something through would
 * report "expected false to match /origin/i" rather than "this was accepted".
 */
function refusal(r: UpgradeResult): string {
  if (r.ok) throw new Error(`expected a refusal, got an accepted upgrade (${r.accept})`);
  return r.reason;
}

describe('acceptKey', () => {
  it('computes the RFC 6455 example', () => {
    // §1.3's worked example: this is the one value in the spec we can check against.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

/**
 * `checkUpgrade` decides whether to speak WebSocket at all. It returns a reason string when it
 * refuses, so main.ts can log WHICH rule fired -- a gateway that refuses silently is
 * indistinguishable from one that is down.
 */
describe('checkUpgrade', () => {
  const base = {
    headers: {
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      host: 'gw.example:8270',
    } as Record<string, string | undefined>,
    cookies: { [TOKEN_COOKIE]: 'sekrit' } as Record<string, string>,
    query: {} as Record<string, string>,
    auth: true,
    token: 'sekrit',
    allowOrigins: [] as readonly string[],
  };

  it('accepts a well-formed request with the token in a cookie', () => {
    expect(checkUpgrade(base)).toEqual({ ok: true, accept: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' });
  });

  it('accepts the token in the query string too, for the first load', () => {
    const r = checkUpgrade({ ...base, cookies: {}, query: { t: 'sekrit' } });
    expect(r.ok).toBe(true);
  });

  it('refuses a wrong or missing token', () => {
    expect(checkUpgrade({ ...base, cookies: { [TOKEN_COOKIE]: 'nope' } }).ok).toBe(false);
    expect(checkUpgrade({ ...base, cookies: {} }).ok).toBe(false);
  });

  it('treats an EMPTY cookie as absent, so the ?t= fallback is still tried', () => {
    // With `??` a present-but-empty cookie shadows the query token, locking out a caller who has
    // both. Fail-closed, so never a hole -- but wrong, and inconsistent with this same function,
    // which treats an empty Sec-WebSocket-Key and an empty Origin as absent.
    const r = checkUpgrade({ ...base, cookies: { [TOKEN_COOKIE]: '' }, query: { t: 'sekrit' } });
    expect(r.ok).toBe(true);
  });

  it('refuses a token of the wrong LENGTH without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so the length must be checked first. A crash here
    // would be a remote denial of service on a gateway, from an unauthenticated request.
    expect(checkUpgrade({ ...base, cookies: { [TOKEN_COOKIE]: 'x' } }).ok).toBe(false);
  });

  /**
   * DO NOT DELETE AS REDUNDANT WITH THE TWO TESTS ABOVE. This is the only test that reaches
   * `timingSafeEqual` at all, and so the only one that tests the comparison itself.
   *
   * Both wrong-token cases above use tokens of a DIFFERENT LENGTH from 'sekrit' ('nope', 'x'), so
   * they are refused by the length gate and return before the comparison runs. Measured: replacing
   * `tokenMatches`'s body with `return true` after the length check left all ten of this file's
   * original tests GREEN. 'sekrot' is six characters, like 'sekrit', so it is the case that fails
   * when the comparison is broken or removed.
   */
  it('refuses a SAME-LENGTH wrong token, which is what actually tests the comparison', () => {
    expect(checkUpgrade({ ...base, cookies: { [TOKEN_COOKIE]: 'sekrot' } }).ok).toBe(false);
    expect(tokenMatches('sekrot', 'sekrit')).toBe(false);
    expect(tokenMatches('sekrit', 'sekrit')).toBe(true);
  });

  it('skips the token entirely when auth is off', () => {
    expect(checkUpgrade({ ...base, cookies: {}, auth: false }).ok).toBe(true);
  });

  it('refuses a MISMATCHED Origin', () => {
    const r = checkUpgrade({
      ...base,
      headers: { ...base.headers, origin: 'https://evil.example' },
    });
    expect(r.ok).toBe(false);
    expect(refusal(r)).toMatch(/origin/i);
  });

  it('accepts a MATCHING Origin, on either scheme', () => {
    for (const o of ['http://gw.example:8270', 'https://gw.example:8270']) {
      expect(checkUpgrade({ ...base, headers: { ...base.headers, origin: o } }).ok).toBe(true);
    }
  });

  it('ACCEPTS an absent Origin, and this is deliberate', () => {
    // Browsers always send Origin on an upgrade; non-browser clients -- including Node's built-in
    // WebSocket, which the integration test uses as an independent oracle -- do not. Rejecting
    // absent would block every scripted client while stopping no browser attack, because the
    // attack needs a browser to supply the cookie automatically. Do NOT "tighten" this.
    expect(checkUpgrade(base).ok).toBe(true);
  });

  /**
   * THE REVERSE-PROXY CASE, and it is why `allowOrigins` exists. Do not delete these as redundant
   * with the Host comparison above: nginx's DEFAULT `proxy_set_header Host $proxy_host` (and
   * Apache's default `ProxyPreserveHost Off`) rewrites Host to the upstream address, so a browser
   * at https://gw.example arrives with `Host: 127.0.0.1:8270` and can NEVER match. Without the
   * allow-list, that deployment refuses every legitimate browser.
   */
  describe('--allow-origin', () => {
    /** Host as a Host-rewriting proxy delivers it: the upstream address, not what the browser saw. */
    const proxied = { ...base, headers: { ...base.headers, host: '127.0.0.1:8270' } };

    it('refuses the proxied browser when the list is empty, which is the problem being fixed', () => {
      const r = checkUpgrade({ ...proxied, headers: { ...proxied.headers, origin: 'https://gw.example' } });
      expect(r.ok).toBe(false);
      expect(refusal(r)).toMatch(/origin/i);
    });

    it('accepts an Origin listed in allowOrigins even though Host cannot match', () => {
      const r = checkUpgrade({
        ...proxied,
        headers: { ...proxied.headers, origin: 'https://gw.example' },
        allowOrigins: ['https://gw.example'],
      });
      expect(r.ok).toBe(true);
    });

    it('still refuses an unlisted Origin when the list is NON-empty', () => {
      const r = checkUpgrade({
        ...proxied,
        headers: { ...proxied.headers, origin: 'https://evil.example' },
        allowOrigins: ['https://gw.example'],
      });
      expect(r.ok).toBe(false);
      expect(refusal(r)).toMatch(/origin/i);
    });

    it('does NOT honour a wildcard, glob or suffix rule', () => {
      // A `*.example` rule is how this control gets quietly widened into uselessness. The entry is
      // compared as a literal string, so it can only ever match an Origin spelled `https://*.example`.
      for (const pattern of ['https://*.example', '*', 'https://*', '.example']) {
        const r = checkUpgrade({
          ...proxied,
          headers: { ...proxied.headers, origin: 'https://a.example' },
          allowOrigins: [pattern],
        });
        expect(r.ok, `allowOrigins ${pattern} must not match https://a.example`).toBe(false);
      }
    });

    it('matches EXACTLY: not scheme-insensitive, not port-insensitive, not path-tolerant', () => {
      for (const origin of ['http://gw.example', 'https://gw.example:443', 'https://gw.example/']) {
        const r = checkUpgrade({
          ...proxied,
          headers: { ...proxied.headers, origin },
          allowOrigins: ['https://gw.example'],
        });
        expect(r.ok, `${origin} must not match https://gw.example`).toBe(false);
      }
    });

    it('does not change the absent-Origin rule, in either direction', () => {
      // Absent stays ACCEPTED whether the list is empty or not -- the flag is about which browsers
      // are allowed, and a client with no Origin is not a browser. See the absent-Origin test above.
      expect(checkUpgrade({ ...proxied, allowOrigins: ['https://gw.example'] }).ok).toBe(true);
      expect(checkUpgrade({ ...proxied, headers: { ...proxied.headers, origin: '' }, allowOrigins: ['https://gw.example'] }).ok)
        .toBe(true);
    });

    it('collects a repeated flag, so several proxied names can be served', () => {
      for (const origin of ['https://gw.example', 'https://alt.example']) {
        const r = checkUpgrade({
          ...proxied,
          headers: { ...proxied.headers, origin },
          allowOrigins: ['https://gw.example', 'https://alt.example'],
        });
        expect(r.ok, origin).toBe(true);
      }
    });

    it('still accepts a matching Host when a list is configured', () => {
      // The two rules are OR, not either-or: adding --allow-origin must not disable the Host check
      // for a deployment with no proxy in front of some of its clients.
      const r = checkUpgrade({
        ...base,
        headers: { ...base.headers, origin: 'https://gw.example:8270' },
        allowOrigins: ['https://other.example'],
      });
      expect(r.ok).toBe(true);
    });
  });

  it('refuses a missing key or the wrong protocol version', () => {
    expect(checkUpgrade({ ...base, headers: { ...base.headers, 'sec-websocket-key': undefined } }).ok)
      .toBe(false);
    expect(checkUpgrade({ ...base, headers: { ...base.headers, 'sec-websocket-version': '8' } }).ok)
      .toBe(false);
  });
});
