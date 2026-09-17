import { deflateSync } from 'node:zlib';
import { PA_AIDS, PF_AIDS } from '@tn3270/core';
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
 * `DecompressionStream('deflate')` requires exactly that. `deflateRawSync` emits raw DEFLATE, which
 * has no header at all, and would need `'deflate-raw'`. Mismatch them and every frame silently
 * fails to inflate, with a blank canvas and no error -- the same signature as four other traps
 * already recorded for this renderer.
 *
 * `protocol.test.ts` pins the FORMAT and not the compression level: the first byte must be 78, and
 * the two header bytes as a big-endian 16-bit value must be a multiple of 31 (RFC 1950's FCHECK).
 * MEASURED: the second byte is 01/5e/9c/da at levels 0/1/6/9, so asserting `9c` would have pinned
 * the LEVEL and broken on a change that still emitted valid zlib.
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

/**
 * Parse and VALIDATE one client message. Throws on anything unexpected.
 *
 * ## UNKNOWN KINDS ARE HARMLESS; KNOWN KINDS WITH OUT-OF-RANGE FIELDS ARE NOT
 *
 * This deliberately does not enumerate `Action` variants: an unrecognised `kind` falls through
 * `applyAction`'s `switch` as a no-op, so a merely NEW action name needs no change here. But a
 * KNOWN kind carrying a bogus field is a different animal, and `pf`/`pa` are the case in point --
 * see below.
 *
 * ## AN ACTION `applyAction` REFUSES MUST BE ACCOUNTED FOR, AND THAT IS A SECOND RULE
 *
 * This note used to say a new action name needs no change in this file, full stop. THAT WAS WRONG,
 * and `toggleKeypad` is the counterexample that proved it: `applyAction` throws on the actions a
 * front end must own -- `quit` and `toggleKeypad` -- and `main.ts` calls it OUTSIDE any try, inside
 * a socket 'data' handler. So the "harmless no-op" reasoning holds only for kinds `applyAction`
 * IGNORES; for a kind it THROWS on, the throw ends the gateway process and every other operator's
 * session with it.
 *
 * So: when `applyAction` grows a refusal, the gateway grows one of exactly two things in the SAME
 * change, and either closes the hole --
 *
 *  - a rejection here, which is right when a browser must not have the action at all. `quit` is
 *    that: it stops the gateway, so the bridge intercepts it client-side AND this refuses it,
 *    because served code is not code a client is obliged to run.
 *  - or an interception in `main.ts` that returns BEFORE `applyAction`, which is right when the
 *    action is the sender's own business. `toggleKeypad` is that: it toggles one socket's own
 *    display, so it is accepted here and handled there.
 *
 * WHAT IS NOT ALLOWED IS NEITHER, and `toggleKeypad` spent a commit in that state. There is no
 * compile-time link between these files -- `applyAction`'s own `satisfies never` catches a missing
 * case in `frontend`, not a missing one here -- which is why it is written down.
 *
 * ## `type`'s PAYLOAD IS NOT BOUNDED HERE
 *
 * `Keyboard.typeString` loops char by char, and on an UNFORMATTED screen `advanceAfterType` has no
 * overflow check, so a multi-megabyte `text` just wraps the cursor and is consumed synchronously --
 * a CPU stall for every other session on this single-process gateway, and reachable because
 * VM/370's own logon panel is unformatted. The bound belongs on the frame, not on this one field:
 * the WebSocket server caps payload size before a frame ever reaches `decodeClientMessage`, which
 * covers every oversized field at once instead of one per `Action` variant.
 */
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
    // `toggleKeypad` IS ACCEPTED, AND DELIBERATELY SO -- see the second rule in the docstring for
    // why that is not a contradiction. It stood rejected here for one commit, while `applyAction`
    // already threw on it and nothing in `main.ts` intercepted it; now `main.ts` handles it and
    // returns before `applyAction`, so the reason to refuse it is gone. It toggles the SENDER's own
    // display and reaches no `Session`, so there is nothing here to bound.
    // AN OUT-OF-RANGE PF/PA NUMBER PUTS A BOGUS AID BYTE ON THE WIRE. Traced chain, all measured:
    // `applyAction` does `session.sendAID(PF_AIDS[action.n - 1]!)`, so n=-1 or n=1e9 indexes past
    // the table and the `!` hands `undefined` to `sendAID`; that reaches `buildReadModified`, which
    // does `Uint8Array.from(out)`, and `Uint8Array.from([undefined])` SILENTLY COERCES TO 0. So
    // `{"kind":"pf","n":-1}` transmits AID 0x00 to the live host, locks the local keyboard
    // (`waitingForHost`), and `applyAction`'s catch-all swallows any complaint. The message is a
    // few dozen bytes, so no frame-size cap stops it.
    //
    // The `!` is defensible in the other three front ends because their `n` comes from a trusted
    // keymap table (1-24, 1-3). This gateway is the first front end where a REMOTE party supplies
    // `n`, and `actions.ts` says in its own docstring that it decides nothing about 3270 semantics,
    // so the boundary that admits untrusted input is where the bound belongs.
    //
    // Bounds come from core's tables rather than literal 24/3 so this cannot drift from them.
    if (aKind === 'pf' || aKind === 'pa') {
      const table = aKind === 'pf' ? PF_AIDS : PA_AIDS;
      const n = (action as { n?: unknown }).n;
      // `Number.isInteger` also rejects NaN, 1.5 and the string "1", all of which a browser can
      // send and any of which would index the table with a non-index.
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > table.length) {
        throw new Error(`${aKind} number must be an integer in 1..${table.length}`);
      }
    }
    return { kind: 'action', action: action as Action };
  }

  throw new Error(`unknown client message kind ${String(kind)}`);
}
