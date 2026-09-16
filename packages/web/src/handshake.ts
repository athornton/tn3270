import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The WebSocket upgrade decision: is this a WebSocket request, is it authorised, and is it from
 * somewhere allowed?
 *
 * Split out from `wsserver.ts` so it can be tested as a pure function over headers, which is the
 * only way the refusal paths get exercised without a socket.
 */

/** RFC 6455 §1.3's fixed GUID. Not a secret; the handshake proves protocol awareness, not identity. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/**
 * The cookie the browser carries the session token in.
 *
 * Exported so the static-file route compares the same name this does. A bare `'tn3270_token'`
 * retyped in a second module is a typo away from a route that never finds the token.
 */
export const TOKEN_COOKIE = 'tn3270_token';

export interface UpgradeRequest {
  readonly headers: Record<string, string | undefined>;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly auth: boolean;
  readonly token: string;
  /** Extra Origins accepted verbatim, from `--allow-origin`. Empty in the no-proxy case. */
  readonly allowOrigins: readonly string[];
}

export type UpgradeResult =
  | { ok: true; accept: string }
  | { ok: false; reason: string };

/**
 * Constant-time compare that survives unequal lengths, which `timingSafeEqual` throws on.
 *
 * EXPORTED ON PURPOSE: the static-file route needs the same check, and a plain `!==` there would
 * leak the token by timing on the asset route while the upgrade path was careful. One comparison,
 * used twice. Its own test is the same-length wrong-token case in `handshake.test.ts` -- the
 * length-mismatch cases return before `timingSafeEqual` is ever reached.
 */
export function tokenMatches(given: string | undefined, want: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  // Length is not secret -- and an unequal-length call to timingSafeEqual THROWS, which on an
  // unauthenticated path would be a remote crash rather than a refusal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function checkUpgrade(req: UpgradeRequest): UpgradeResult {
  const key = req.headers['sec-websocket-key'];
  if (key === undefined || key === '') return { ok: false, reason: 'no Sec-WebSocket-Key' };
  if (req.headers['sec-websocket-version'] !== '13') {
    return { ok: false, reason: `unsupported Sec-WebSocket-Version ${req.headers['sec-websocket-version']}` };
  }

  /**
   * ABSENT Origin is ACCEPTED; a MISMATCH is refused.
   *
   * Browsers always send Origin on an upgrade, so a mismatch is the cross-site WebSocket
   * hijacking shape and must be refused -- the cookie would otherwise be attached automatically
   * by the very browser being abused. Non-browser clients do not send Origin at all, including
   * Node's built-in WebSocket, which the integration tests use as an independent oracle of our
   * framing. Rejecting absent would block those and stop no attack, since an attack needs a
   * browser to supply the cookie.
   *
   * ## `allowOrigins` IS NOT REDUNDANT WITH THE HOST COMPARISON -- do not delete it
   *
   * MEASURED: nginx's DEFAULT is `proxy_set_header Host $proxy_host`, and Apache's default is
   * `ProxyPreserveHost Off`. Both rewrite Host to the UPSTREAM address, so a browser at
   * `https://gw.example` arrives here with `Host: 127.0.0.1:8270` and the comparison below can
   * never match: the gateway then refuses every legitimate browser behind such a proxy. (nginx with
   * `Host $host`, and Caddy by default, preserve it and need no flag. Default ports are not the
   * issue -- a browser omits `:80`/`:443` from both Origin and Host, so those agree.) `--allow-origin`
   * is the operator's way to name what the browser actually sees.
   *
   * Entries are compared as EXACT strings. No wildcards, no suffix rules, no scheme folding: a
   * `*.example.com` entry is how this control gets quietly widened into uselessness.
   */
  const origin = req.headers['origin'];
  if (origin !== undefined && origin !== '') {
    const host = req.headers['host'] ?? '';
    const matchesHost = origin === `http://${host}` || origin === `https://${host}`;
    if (!matchesHost && !req.allowOrigins.includes(origin)) {
      return { ok: false, reason: `cross-origin upgrade from ${origin}` };
    }
  }

  if (req.auth) {
    // An EMPTY cookie counts as absent, so the `?t=` fallback still gets its turn. With `??` an
    // empty cookie shadows a valid query token and locks the caller out -- fail-closed, so not a
    // hole, but wrong, and inconsistent with the empty-key and empty-Origin rules above.
    const cookie = req.cookies[TOKEN_COOKIE];
    const given = cookie !== undefined && cookie !== '' ? cookie : req.query['t'];
    if (!tokenMatches(given, req.token)) return { ok: false, reason: 'bad or missing token' };
  }

  return { ok: true, accept: acceptKey(key) };
}
