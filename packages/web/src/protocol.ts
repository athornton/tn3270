import { deflateSync } from 'node:zlib';
import type { AtlasGeometry, DrawList } from '@tn3270/canvas';
import type { Action } from '@tn3270/frontend';

/**
 * What crosses the socket, in both directions.
 *
 * ## COMPRESSION IS NOT OPTIONAL AND ITS FORMAT IS NOT FREE
 *
 * MEASURED: a 24x80 draw list is 237220 bytes of JSON and 6760 deflated -- 35x, because per-cell
 * colour data is enormously repetitive. Raw frames would be unpleasant over a network since a
 * keystroke can produce several; compressed they are a non-issue, which is why dirty-cell diffing
 * is NOT in this design.
 *
 * `deflateSync` emits the ZLIB wrapper (RFC 1950, first bytes 78 9c) and the browser's
 * `DecompressionStream('deflate')` requires exactly that. `deflateRawSync` emits raw DEFLATE
 * (ab a8) and would need `'deflate-raw'`. Mismatch them and every frame silently fails to inflate,
 * with a blank canvas and no error -- the same signature as four other traps already recorded for
 * this renderer. `protocol.test.ts` pins the header bytes.
 */
export type ServerMessage =
  | { kind: 'atlas'; geometry: AtlasGeometry; coverage: Uint8Array; blank: readonly number[] }
  | { kind: 'frame'; list: DrawList }
  | { kind: 'error'; message: string }
  | { kind: 'session'; id: string };

export type ClientMessage =
  | { kind: 'hello'; sessionId?: string }
  | { kind: 'action'; action: Action };

/** Encode one server message as the payload of a binary WebSocket frame. */
export function encodeServerMessage(msg: ServerMessage): Buffer {
  // `coverage` is bytes and JSON has no way to hold them, so the atlas message carries base64.
  // The bridge decodes it back to a Uint8Array, so the renderer sees exactly what Electron's
  // structured clone gave it and needs no knowledge of the transport.
  const wire = msg.kind === 'atlas'
    ? { ...msg, coverage: Buffer.from(msg.coverage).toString('base64') }
    : msg;
  return deflateSync(Buffer.from(JSON.stringify(wire)));
}

/** Parse and VALIDATE one client message. Throws on anything unexpected. */
export function decodeClientMessage(text: string): ClientMessage {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('client message must be an object');
  }
  const kind = (raw as { kind?: unknown }).kind;

  if (kind === 'hello') {
    const id = (raw as { sessionId?: unknown }).sessionId;
    if (id === undefined) return { kind: 'hello' };
    if (typeof id !== 'string') throw new Error('sessionId must be a string');
    return { kind: 'hello', sessionId: id };
  }

  if (kind === 'action') {
    const action = (raw as { action?: unknown }).action;
    if (typeof action !== 'object' || action === null) throw new Error('action must be an object');
    const aKind = (action as { kind?: unknown }).kind;
    if (typeof aKind !== 'string') throw new Error('action needs a kind');
    // A browser must not be able to stop the gateway. The bridge intercepts `quit` and closes its
    // own socket; this is the server half, because the bridge is served code and a client is not
    // obliged to run it.
    if (aKind === 'quit') throw new Error('quit is not accepted from a client');
    return { kind: 'action', action: action as Action };
  }

  throw new Error(`unknown client message kind ${String(kind)}`);
}
