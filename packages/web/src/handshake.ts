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

export interface UpgradeRequest {
  readonly headers: Record<string, string | undefined>;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly auth: boolean;
  readonly token: string;
}

export type UpgradeResult =
  | { ok: true; accept: string }
  | { ok: false; reason: string };

/** Constant-time compare that survives unequal lengths, which `timingSafeEqual` throws on. */
function tokenMatches(given: string | undefined, want: string): boolean {
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
   */
  const origin = req.headers['origin'];
  if (origin !== undefined && origin !== '') {
    const host = req.headers['host'] ?? '';
    if (origin !== `http://${host}` && origin !== `https://${host}`) {
      return { ok: false, reason: `cross-origin upgrade from ${origin}` };
    }
  }

  if (req.auth) {
    const given = req.cookies['tn3270_token'] ?? req.query['t'];
    if (!tokenMatches(given, req.token)) return { ok: false, reason: 'bad or missing token' };
  }

  return { ok: true, accept: acceptKey(key) };
}
