import { describe, it, expect } from 'vitest';
import { acceptKey, checkUpgrade } from '../src/handshake.js';

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
    cookies: { tn3270_token: 'sekrit' },
    query: {} as Record<string, string>,
    auth: true,
    token: 'sekrit',
  };

  it('accepts a well-formed request with the token in a cookie', () => {
    expect(checkUpgrade(base)).toEqual({ ok: true, accept: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' });
  });

  it('accepts the token in the query string too, for the first load', () => {
    const r = checkUpgrade({ ...base, cookies: {}, query: { t: 'sekrit' } });
    expect(r.ok).toBe(true);
  });

  it('refuses a wrong or missing token', () => {
    expect(checkUpgrade({ ...base, cookies: { tn3270_token: 'nope' } }).ok).toBe(false);
    expect(checkUpgrade({ ...base, cookies: {} }).ok).toBe(false);
  });

  it('refuses a token of the wrong LENGTH without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so the length must be checked first. A crash here
    // would be a remote denial of service on a gateway, from an unauthenticated request.
    expect(checkUpgrade({ ...base, cookies: { tn3270_token: 'x' } }).ok).toBe(false);
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
    expect(r.ok === false && r.reason).toMatch(/origin/i);
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

  it('refuses a missing key or the wrong protocol version', () => {
    expect(checkUpgrade({ ...base, headers: { ...base.headers, 'sec-websocket-key': undefined } }).ok)
      .toBe(false);
    expect(checkUpgrade({ ...base, headers: { ...base.headers, 'sec-websocket-version': '8' } }).ok)
      .toBe(false);
  });
});
