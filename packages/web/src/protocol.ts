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
 * color data is enormously repetitive. Raw frames would be unpleasant over a network since a
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
  | { kind: 'session'; id: string }
  // Transfer progress and completion. `ServerMessage` was `frame | error | session | atlas`
  // until now; web copy will be the next thing to widen it, as the handoff records.
  | { kind: 'transferProgress'; text: string }
  // TWO ARMS, SO `error` NARROWS. `{ ok: boolean; error?: string }` was the first shape and it is
  // the exact one `transferChunk.ts`'s `AcceptResult` replaced ONE COMMIT EARLIER, for the reason
  // recorded there: inside `if (!msg.ok)` the message a caller just branched on is still
  // `string | undefined`, so every reader needs a non-null assertion to print it. `handshake.ts`
  // and `frontend`'s `transferRun.ts` both use unions for this, and `transferRun.ts:224` comments
  // on relying on the narrowing. Cheap to fix with no consumers; structurally awkward by Task 8.
  | { kind: 'transferDone'; ok: true; bytes?: number }
  | { kind: 'transferDone'; ok: false; error: string }
  // A receive's bytes, chunked the same way an upload's are, then terminated by `transferDone`.
  | { kind: 'transferData'; seq: number; total: number; bytes: Uint8Array };

export type ClientMessage =
  | { kind: 'hello'; sessionId?: string }
  | { kind: 'action'; action: Action }
  | { kind: 'transferChunk'; seq: number; total: number; bytes: Uint8Array }
  | { kind: 'transferStart'; keywords: readonly string[] }
  | { kind: 'transferCancel' };

/** Encode one server message as the payload of a binary WebSocket frame. */
export function encodeServerMessage(msg: ServerMessage): Buffer {
  // `coverage` is bytes and JSON has no way to hold them, so the atlas message carries base64.
  // The bridge decodes it back to a Uint8Array, so the renderer sees exactly what Electron's
  // structured clone gave it and needs no knowledge of the transport.
  // `transferData` carries file bytes for exactly the same reason and in the same shape, so its
  // browser-side decode is the one the bridge ALREADY uses for `coverage` rather than a second
  // convention: `Uint8Array.from(atob(s), (c) => c.charCodeAt(0))` at `bridgecore.ts:105`.
  //
  // `atob`, NOT `Buffer.from(s, 'base64')` -- and the distinction is not stylistic. An earlier
  // version of this comment named `Buffer`, which is the API THIS file uses on the server and
  // which DOES NOT EXIST in `bridgecore.ts`: that module is served to the browser by
  // `httpstatic.ts` and contains zero occurrences of `Buffer`. Naming it here would have sent the
  // consumer of this message at an API unavailable in its own environment.
  const wire = msg.kind === 'atlas'
    ? { ...msg, coverage: Buffer.from(msg.coverage).toString('base64') }
    : msg.kind === 'transferData'
      ? { ...msg, bytes: Buffer.from(msg.bytes).toString('base64') }
      : msg;
  return deflateSync(Buffer.from(JSON.stringify(wire)));
}

/**
 * Parse and VALIDATE one client message. Throws on anything unexpected.
 *
 * ## UNKNOWN KINDS ARE HARMLESS; KNOWN KINDS WITH OUT-OF-RANGE FIELDS ARE NOT
 *
 * This deliberately does not enumerate `Action` variants: an unrecognized `kind` falls through
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
 * THE RULE HAS NOW CAUGHT A SECOND KIND: `copy`, added for the Electron GUI's clipboard on
 * 2026-10-05. Its feature spec asserted the gateway would get copy "free" because `sendAction`
 * already crosses the socket; the integration test answered with an uncaught throw and a dead
 * handler. Sending an action is free, returning its RESULT is not -- see the rejection below. The
 * lesson for the next kind is the one this rule already states: ask what `applyAction` does with
 * it, not whether the action can be transmitted.
 *
 * AND IT HAS NOW CAUGHT A THIRD CASE, WHICH IS THE FIRST TO RUN THE RULE BACKWARDS: `transferForm`
 * on 2026-10-06. The other two arrived as new refusals in `applyAction`; this one kept its refusal
 * there and lost its reason HERE, because socket-carried file I/O meant a browser transfer no
 * longer wrote to the gateway's filesystem. So the kind did not leave the rule when it stopped
 * being rejected -- it MOVED TO THE RULE'S OTHER BRANCH, and `main.ts` grew the interception in the
 * same change. THE LESSON THE PLAN FOR IT GOT WRONG: a task that only deletes a rejection here
 * looks like a one-file change and is not one, because deleting a rejection without adding the
 * interception leaves the kind in the forbidden "neither" state -- measured in
 * `integration.test.ts` as `no reply to a tab after transferForm` over an uncaught
 * `applyAction does not handle transferForm`. (The quoted string names the TAB because the case
 * sends a tab after each kind to prove the session survived it; an earlier version of this note
 * quoted `no reply to the transferForm action`, which is what the message would be only if the
 * kind were absent from `SWALLOWED` too. Re-measured 2026-10-06.)
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
    // `transferForm` IS NOW ACCEPTED, 2026-10-06. It was refused because a browser-initiated
    // transfer would have moved bytes between the host and the GATEWAY's filesystem rather than
    // the operator's -- and socket-carried file I/O is precisely what removes that reason. The
    // bytes now arrive as `transferChunk` messages and leave as `transferData`, so "local file"
    // means the operator's machine.
    //
    // `copy` AND `quit` STAY REFUSED and their reasons are unchanged: `quit` would stop the
    // gateway, and `copy` would extract text onto the SERVER's clipboard. Web copy is the next
    // roadmap item and will remove the second one the same way this removed this one.
    //
    // THE REFUSAL THAT REMAINS IS LOAD-BEARING: `applyAction` throws on `copy`, and
    // `web/src/main.ts` calls it outside any try in a socket data handler, so deleting that
    // refusal ends the gateway process on the first browser copy.
    //
    // AND ACCEPTING THIS KIND OWED `main.ts` AN INTERCEPTION, WHICH LANDED IN THE SAME CHANGE --
    // the other branch of this file's two-branch rule, taken rather than skipped. `applyAction`
    // STILL THROWS on `transferForm` (`frontend/src/actions.ts:57-59`), and `main.ts` calls it
    // outside any try in a socket 'data' handler, so dropping this rejection on its own would have
    // ended the gateway process on the first `Xfer` click. MEASURED 2026-10-06, not feared: with
    // the acceptance here and no interception there, `integration.test.ts` reports `no reply to a
    // tab after transferForm` over an uncaught `applyAction does not handle transferForm` -- the
    // same shape `toggleKeypad` and `copy` each produced, the tab being how that case proves the
    // session survived the kind. `main.ts` now returns before
    // `applyAction` for this kind, and the integration test's `SWALLOWED` list is where that is
    // asserted; this kind moved from its `REFUSED` list to that one, rather than out of both.
    // `copy` IS REJECTED FOR THE SAME SHAPE OF REASON `transferForm` WAS:
    // whose machine the result lands on. The Electron GUI extracts the text in main and writes an
    // OS clipboard that belongs to the operator; here "main" is the GATEWAY, so the extracted text
    // would land on the gateway's machine and the operator's clipboard would never see it.
    //
    // THE SPEC FOR THIS FEATURE SAID THE GATEWAY GETS COPY "FREE" BECAUSE `sendAction` ALREADY
    // CROSSES THE SOCKET, AND THAT IS WRONG -- recorded here because it is the kind of claim that
    // gets re-adopted from a design doc. Sending the ACTION is indeed free; getting the TEXT BACK
    // is not, and nothing in that direction CARRIES IT. `ServerMessage` is no longer the
    // `frame | error` this comment used to cite -- it gained three transfer members on 2026-10-06
    // (see the union above) -- but not one of them carries clipboard text, so the objection is
    // unchanged and only its evidence moved. `bridgecore.ts` still has no clipboard function among
    // its four, and `static/` is one `index.html` with no clipboard code. The browser's own
    // renderer cannot extract it either -- a `DrawCell` carries a CG-order atlas glyph and no
    // character, which is the whole reason the Electron side extracts in main.
    //
    // So web copy needs a new server->client message plus a `navigator.clipboard` write in the
    // bridge, which is its own spec -- exactly the conclusion already reached for the web transfer
    // UI. THE USER COMMITTED TO BOTH BEFORE PACKAGING (2026-10-05): web copy/paste and the web
    // transfer form. THE TRANSFER HALF HAS NOW LANDED, and it is the worked example of how this one
    // goes: its rejection above became an acceptance here plus an interception in `main.ts`, and
    // the integration test's REFUSED list lost a member -- the sentence this note has been carrying
    // all along, now with a precedent rather than a plan.
    //
    // A REJECTION AND NOT AN OMISSION, which is this file's second documented rule: `applyAction`
    // THROWS on `copy`, and `main.ts:272` calls it outside any try inside a socket 'data' handler,
    // so leaving this out would end the GATEWAY PROCESS and every other operator's session on the
    // first copy a browser sent. Measured, not feared: without this branch the integration test
    // reports `no reply to the copy action` and an uncaught `applyAction does not handle copy`.
    // `toggleKeypad` spent a commit in exactly that state.
    //
    // REACHABLE FROM A GESTURE, not just a hand-built frame: the browser runs the same
    // `renderer.ts`, so a drag plus the Copy accelerator raises this action there too.
    if (aKind === 'copy') {
      throw new Error(
        'copy is not accepted from a client: the gateway would extract the text onto its own '
        + "machine, not yours");
    }
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

  // THESE MUST STAY ABOVE THE `unknown client message kind` THROW BELOW, which is the whole of why
  // placement is called out: it is a catch-all, not a default case, so a branch written after it is
  // unreachable and every transfer message would be refused as an unknown kind.
  //
  // A 4096-BYTE CHUNK FITS THE FRAME CAP WITH ROOM TO SPARE, and this is the number the chunk size
  // was chosen against. MEASURED 2026-10-06: 4096 source bytes base64-encode to 5464 characters,
  // and the worst-case envelope -- `seq` at 2559 and `total` at the 10485760-byte ceiling, i.e. the
  // widest both fields can be under `MAX_TRANSFER_BYTES` -- brings the whole `JSON.stringify` to
  // 5527 bytes against `wsserver.ts`'s `MAX_MESSAGE_BYTES` of 8192. 2665 bytes of headroom. An
  // oversize frame CLOSES THE SOCKET with no message (`wsserver.ts:106`, `:114`), so a chunk size
  // that fit only BEFORE encoding would kill the 3270 session rather than refuse the transfer.
  if (kind === 'transferChunk') {
    const { seq, total, bytes } = raw as { seq?: unknown; total?: unknown; bytes?: unknown };
    // `Number.isInteger` rejects NaN, 1.5 and "0" alike -- so the `typeof` clauses below are
    // redundant AT RUNTIME and are not removable: each NARROWS `unknown` to `number`, and dropping
    // either makes `tsc` report `'seq' is of type 'unknown'` and `Type 'unknown' is not assignable
    // to type 'number'` at the return. Verified by deletion 2026-10-06, and noted because mutation
    // testing flags them as surviving changes -- they are the one kind of survivor that is correct.
    //
    // The RANGE of `total` is NOT bounded here, and deliberately not: `ChunkReassembler`'s
    // constructor owns the `MAX_TRANSFER_BYTES` refusal and phrases it for an operator, and
    // duplicating the ceiling here would be a second number to drift. This checks only that the
    // fields are usable as a sequence and a length.
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      throw new Error('transferChunk seq must be a non-negative integer');
    }
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw new Error('transferChunk total must be a non-negative integer');
    }
    if (typeof bytes !== 'string') {
      throw new Error('transferChunk bytes must be a base64 string');
    }
    // `Buffer.from(s, 'base64')` IS LENIENT and does not throw on non-base64 input -- it skips the
    // characters it cannot use -- so there is no validity check to make here, only a type one. The
    // length disagreement that a mangled chunk produces is caught by `ChunkReassembler`, which
    // compares the running total against the declared one and refuses rather than repairs.
    //
    // A FRESH BUFFER PER CHUNK, which is what makes `ChunkReassembler.accept` safe to retain it:
    // that class's docstring warns that a caller passing a subarray of a reused accumulator would
    // corrupt every chunk but the last. This allocates, so nothing can overwrite it.
    return {
      kind: 'transferChunk', seq, total, bytes: new Uint8Array(Buffer.from(bytes, 'base64')),
    };
  }
  if (kind === 'transferStart') {
    const { keywords } = raw as { keywords?: unknown };
    // NO VALIDATION OF THE KEYWORDS THEMSELVES, on purpose: `frontend`'s transfer code parses them
    // and reports its own errors, so a second parser here would be a second thing to keep in step.
    // This bounds only the SHAPE, which is what the rest of the gateway assumes.
    //
    // `every` WITH A TYPE PREDICATE, and not the `some((k) => typeof k !== 'string')` that reads
    // more naturally against the error message. `Array.isArray` on an `unknown` narrows it to
    // `any[]`, so after a `some` check the elements are still `any` and `keywords` assigns to
    // `readonly string[]` ONLY because `any` assigns to everything -- it typechecks without
    // proving anything, which is why the draft of this needed an `as readonly string[]`. `every`
    // with `k is string` narrows the ARRAY to `string[]`, so the assignment below is checked
    // rather than waved through and no cast is told to the compiler.
    if (!Array.isArray(keywords)
      || !keywords.every((k): k is string => typeof k === 'string')) {
      throw new Error('transferStart keywords must be an array of strings');
    }
    return { kind: 'transferStart', keywords };
  }
  if (kind === 'transferCancel') return { kind: 'transferCancel' };

  throw new Error(`unknown client message kind ${String(kind)}`);
}
