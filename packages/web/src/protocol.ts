import { deflateSync } from 'node:zlib';
import { KNOWN_MODELS, PA_AIDS, PF_AIDS } from '@tn3270/core';
import type { AtlasGeometry, DrawList } from '@tn3270/canvas';
import type { Action } from '@tn3270/frontend';
import type { GeometryChoices, OversizeName } from './geometryOverlay.js';

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
  /*
    WEB COPY'S ANSWER, 2026-10-23 -- AND THE LINE ABOVE CALLED IT: "web copy will be the next
    thing to widen it" was written on 2026-10-06 and is now spent, which is worth noting because
    a comment naming the future change that invalidates it does not usually survive that change.

    A MESSAGE IS NEEDED AT ALL BECAUSE ONLY THIS SIDE CAN EXTRACT THE TEXT. A `DrawCell` carries a
    CG-order atlas glyph and NO character (`canvas/src/drawlist.ts`), so the browser's renderer
    holds nothing to read and sends the RECTANGLE; `text` and `hidden` live on `ResolvedCell`, and
    `resolve(snapshot)` is called on this side. So the extraction cannot move to the client, and
    the result has to travel back. That is what removes `copy`'s refusal rather than merely
    relocating it: the text lands on the OPERATOR's clipboard, which was the whole objection.

    THE SPEC CLAIMED THIS WAS FREE because `sendAction` already crosses the socket. Sending the
    ACTION is free; nothing carried the TEXT, and this member is the thing that was missing.

    PLAIN JSON WITH NO BASE64 BRANCH, unlike `atlas`'s `coverage` and `transferData`'s `bytes`.
    Those are byte arrays JSON cannot hold; this is already a string, so a branch in
    `encodeServerMessage` would be a third convention for nothing. `protocol.test.ts` pins its
    absence by asserting the wire object has exactly `kind` and `text`.

    NOT SIZE-CAPPED HERE, and it does not need to be: a 24x80 screenful of text is under 2 KB and
    an alternate-size screen a few times that, both far under what `deflateSync` then compresses.
    This is a SERVER->client message, so `wsserver.ts`'s `MAX_MESSAGE_BYTES` inbound cap does not
    apply to it in either direction.
  */
  | { kind: 'copyText'; text: string }
  /*
    THE PREFETCHED TEXT OF A SELECTION, 2026-11-02 -- the answer to the client's `selection`. Same
    extraction as `copyText` (hidden fields become spaces), sent when a drag ends rather than when a
    copy is requested, so the browser can hand it to its own `copy` event synchronously. `seq`
    echoes the request's, which is how the bridge matches the answer to its promise.
  */
  | { kind: 'selectionText'; seq: number; text: string }
  // TWO ARMS, SO `error` NARROWS. `{ ok: boolean; error?: string }` was the first shape and it is
  // the exact one `transferChunk.ts`'s `AcceptResult` replaced ONE COMMIT EARLIER, for the reason
  // recorded there: inside `if (!msg.ok)` the message a caller just branched on is still
  // `string | undefined`, so every reader needs a non-null assertion to print it. `handshake.ts`
  // and `frontend`'s `transferRun.ts` both use unions for this, and `transferRun.ts:224` comments
  // on relying on the narrowing. Cheap to fix with no consumers; structurally awkward by Task 8.
  | { kind: 'transferDone'; ok: true; bytes?: number }
  | { kind: 'transferDone'; ok: false; error: string }
  // A receive's bytes, chunked the same way an upload's are, then terminated by `transferDone`.
  | { kind: 'transferData'; seq: number; total: number; bytes: Uint8Array }
  /*
    THE PICKER'S CHOICES, 2026-11-04 -- what the `Alt-M` overlay draws. Sent after `atlas` on
    `hello`, on the session's 'geometry', 'connect', 'connectSettled' and 'disconnect', and as the
    reply to every `setGeometry`. The shape is `GeometryChoices` in `geometryOverlay.ts`, the
    browser module that consumes it, so the two halves share one declaration.

    LABELS TRAVEL WITH THE NAMES, where a bare `models: string[]` would have been smaller: the
    overlay is served unbundled and cannot import `@tn3270/core`, so `KNOWN_MODELS`' sizes and
    `describeSize`'s wording would otherwise be a second copy in the browser. The gateway builds
    them exactly as the GUI's Model menu does (`geometryChoices.ts`).

    `current.oversize` IS `null` FOR A FIXED SIZE OTHER THAN THE STARTUP ONE, and that is
    unreachable from the web: the setting starts as `-oversize`, and the only fixed size any
    `setGeometry` can name is `startup`. So `null` checks nothing rather than inventing an item.

    `notice` RIDES ONLY ON THE REPLY TO A `setGeometry`: `applyGeometryChoice`'s reset text, or the
    refusal. HERE AND NOT AS AN `error`, because `error` paints the CANVAS -- underneath the open
    picker -- and stays there until the next frame, which a replayed or idle session never sends.
    The picker is where the operator clicked, and the reply has to come anyway to put the radios
    back where the session is. A MALFORMED `setGeometry` is still an `error`: it is refused at
    decode, below, like every other bad frame.
  */
  | ({ kind: 'geometryChoices' } & GeometryChoices);

/** A browser viewport in CSS pixels, for `-oversize auto`. See `checkViewport`. */
export interface Viewport { readonly width: number; readonly height: number }

export type ClientMessage =
  /*
    `viewport` IN `hello`, 2026-11-04: the browser's window in CSS pixels, which the gateway turns
    into cells at scale 1 for `-oversize auto` (`viewport.ts`). In `hello` and not only in its own
    message because a NEW session connects inside `registry.attach`, before any later message
    could arrive -- so the size its first connect measures has to travel with the hello itself.
  */
  | { kind: 'hello'; sessionId?: string; viewport?: Viewport }
  | { kind: 'action'; action: Action }
  | { kind: 'transferChunk'; seq: number; total: number; bytes: Uint8Array }
  | { kind: 'transferStart'; keywords: readonly string[] }
  | { kind: 'transferCancel' }
  /*
    A PREFETCH, NOT AN ACTION, 2026-11-02: a top-level kind beside the transfer ones because the
    operator did nothing to the session. Answered with `selectionText`; changes no screen.
  */
  | { kind: 'selection'; seq: number; rect: { top: number; left: number; bottom: number; right: number } }
  /*
    THE WINDOW RESIZED, 2026-11-04: sent by the page, debounced, so the gateway keeps the latest
    viewport per session for `-oversize auto`'s next reconnect. A top-level kind like `selection`,
    not an `Action`: the operator did nothing to the session. `main.ts` intercepts it ABOVE the
    action guard and never replies -- a resize changes no screen until the next connect.
  */
  | { kind: 'viewport'; width: number; height: number }
  /*
    THE PICKER'S CHOICE, 2026-11-04: EXACTLY ONE FIELD, a model or an oversize, never both.

    ONE FIELD BECAUSE ONE CLICK CHANGES ONE THING, and because the rule for applying one is already
    written and shared: `applyGeometryChoice` (`@tn3270/frontend`) takes `{model}` OR `{oversize}`,
    and a model the current oversize refuses is applied with oversize None and a notice. The GUI's
    Model menu goes through it unchanged; so does this. A two-field message (the spec's first
    wording, "naming a model and one of none, auto or startup") would need a SECOND rule for which
    field wins when the pair is refused, and the web would then answer a click differently from
    the GUI -- the drift the shared rule exists to stop.

    `oversize` IS A NAME, NEVER A SIZE: picked from lists, nothing typed (the spec). `startup` is
    the gateway's `-oversize <cols>x<rows>`, mapped in `main.ts`, which alone knows whether there
    is one. `model` is case-folded to its `KNOWN_MODELS` key here.
  */
  | { kind: 'setGeometry'; model: string }
  | { kind: 'setGeometry'; oversize: OversizeName }
  /*
    THE PICKER'S DISCONNECT BUTTON, 2026-11-05: drop THIS SOCKET'S host session, so the choices
    can be used without waiting for the host to drop the line (LOGOFF). A top-level kind like
    `setGeometry`, NOT an `Action`: no keymap binds it, and the operator's 3270 keys never send it.
    No fields -- there is no session to name, the socket already has exactly one.
  */
  | { kind: 'disconnect' };

/** Encode one server message as the payload of a binary WebSocket frame. */
export function encodeServerMessage(msg: ServerMessage): Buffer {
  // `coverage` is bytes and JSON has no way to hold them, so the atlas message carries base64.
  // The bridge decodes it back to a Uint8Array, so the renderer sees exactly what Electron's
  // structured clone gave it and needs no knowledge of the transport.
  // `transferData` carries file bytes for exactly the same reason and in the same shape, so its
  // browser-side decode is the one the bridge ALREADY uses for `coverage` rather than a second
  // convention: `Uint8Array.from(atob(s), (c) => c.charCodeAt(0))` at `bridgecore.ts:155`.
  // (`:105` until 2026-10-06, when `onTransfer` and its inbound branch moved it. The consumer
  // this comment promises exists is now real -- that branch decodes `transferData` exactly so.)
  //
  // `atob`, NOT `Buffer.from(s, 'base64')` -- and the distinction is not stylistic. An earlier
  // version of this comment named `Buffer`, which is the API THIS file uses on the server and
  // which DOES NOT EXIST in `bridgecore.ts`: that module is served to the browser by
  // `httpstatic.ts`, where no `Buffer` exists. Naming it here would have sent the consumer of
  // this message at an API unavailable in its own environment.
  //
  // (This clause said "contains zero occurrences of `Buffer`" until 2026-10-06, when the inbound
  // `transferData` branch landed there and made it literally false -- the word now appears three
  // times in that file, in the comments warning against it. The claim that matters is about the
  // ENVIRONMENT, not a grep count, so it is now stated that way.)
  const wire = msg.kind === 'atlas'
    ? { ...msg, coverage: Buffer.from(msg.coverage).toString('base64') }
    : msg.kind === 'transferData'
      ? { ...msg, bytes: Buffer.from(msg.bytes).toString('base64') }
      : msg;
  return deflateSync(Buffer.from(JSON.stringify(wire)));
}

/**
 * THE FOUR RECT FIELDS, CHECKED ONCE FOR BOTH KINDS THAT CARRY ONE. `copy` and `selection` both
 * reach `extractText` in the socket handler, so both need the rule the `copy` note below records:
 * a missing rect throws there, and a FRACTIONAL one silently extracts nothing. `what` keeps each
 * kind's error naming itself, which is what `protocol.test.ts`'s `/copy (needs a rect|rect )/` and
 * `/selection (...)/` patterns need -- `integration.test.ts` never matches a rect error by kind.
 *
 * `typeof r[k] !== 'number'` is redundant both AT RUNTIME, next to `Number.isInteger`, and for
 * TYPES: TS does not narrow `r[k]` through a `for...of` loop variable, so deleting the `typeof`
 * clause still compiles -- the `as number` casts in the return below are what type it, not this
 * check. It is kept only as the clearer phrasing, same as the `copy` comment it replaces said.
 *
 * Returns a fresh object with only the four fields. `copy` discards this return and passes the
 * client's own rect object through unchanged, which stays safe because `extractText` reads only
 * the four named fields off it. `selection` returns the rebuilt object, because it is stored on
 * `ClientMessage` and compared with `toEqual` in tests, where a stray extra field would be visible.
 */
function checkRect(rect: unknown, what: string): {
  top: number; left: number; bottom: number; right: number;
} {
  if (typeof rect !== 'object' || rect === null) throw new Error(`${what} needs a rect object`);
  const r = rect as Record<string, unknown>;
  for (const k of ['top', 'left', 'bottom', 'right']) {
    if (typeof r[k] !== 'number' || !Number.isInteger(r[k])) {
      throw new Error(`${what} rect ${k} must be an integer`);
    }
  }
  return {
    top: r['top'] as number, left: r['left'] as number,
    bottom: r['bottom'] as number, right: r['right'] as number,
  };
}

/** The largest viewport side accepted, in CSS pixels: far past any display, small enough to be sane. */
const MAX_VIEWPORT = 100_000;

/**
 * A VIEWPORT'S TWO FIELDS, CHECKED ONCE FOR BOTH PLACES ONE TRAVELS -- `hello.viewport` and the
 * `viewport` kind. Integers in 1..100000, each. The value reaches `measureViewport` inside
 * `Session.connect()`, where the division would COERCE a string (`'800' / 9` is a number) and
 * `Math.floor` would turn a fraction or a huge number into a size nobody has: `resolveGeometry`
 * would then size the host, fall back or clamp on input that is simply malformed. Refused here like every other bad field, so the sender hears about it.
 *
 * Returns a fresh object with only the two fields, as `checkRect` does for the same reason.
 */
function checkViewport(raw: unknown): Viewport {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('viewport needs a width and a height');
  }
  const v = raw as Record<string, unknown>;
  for (const k of ['width', 'height']) {
    const n = v[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_VIEWPORT) {
      throw new Error(`viewport ${k} must be an integer in 1..${MAX_VIEWPORT}`);
    }
  }
  return { width: v['width'] as number, height: v['height'] as number };
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
 * ## `viewport`, AND `hello.viewport`, 2026-11-04: NOT ACTIONS, SO OUTSIDE THE RULE ABOVE
 *
 * `-oversize auto` measures the browser window. The page sends its viewport in CSS pixels in
 * `hello` and again, debounced, as a top-level `viewport` kind whenever the window resizes. Neither
 * is an `Action`, so neither can reach `applyAction`: `hello` has its own branch in `main.ts`, and
 * `viewport` is intercepted ABOVE the action guard there, beside `selection`, and answered with
 * nothing. The FIELD rule still applies in full -- both are shape-checked by `checkViewport`,
 * integers in 1..100000 -- because the value is read inside `Session.connect()` by the measure.
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
    const { sessionId: id, viewport } = raw as { sessionId?: unknown; viewport?: unknown };
    if (id !== undefined && typeof id !== 'string') throw new Error('sessionId must be a string');
    return {
      kind: 'hello',
      ...(id !== undefined ? { sessionId: id } : {}),
      ...(viewport !== undefined ? { viewport: checkViewport(viewport) } : {}),
    };
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
    /*
      `requestCopy` IS REFUSED TOO, 2026-10-27, AND ITS REFUSAL IS ABOUT WHAT THE SERVER CANNOT
      KNOW rather than about whose machine a result lands on.

      NOT "THE FIRST OF ITS KIND", WHICH IS WHAT THIS NOTE CLAIMED WHEN IT WAS WRITTEN AND IS
      CORRECTED HERE -- the correction being worth more than the claim was. The draft said every
      refusal this file had ever carried except `quit`'s was freed by making the socket carry a
      stranded payload, and named `transferForm`, `copy` and `paste`. THERE WERE FOUR, AND THE
      FOURTH IS THIS FILE'S OWN MOST-CITED PRECEDENT: `toggleKeypad` was refused here too
      (`c94979f`, "a toggleKeypad frame could end the gateway process", 2026-09-16), and it was
      freed by neither a payload nor a reason expiring -- `2fb921c` replaced the rejection with an
      INTERCEPTION in `main.ts`, the rule's other branch, and that commit calls the rejection it
      removed "a stop-gap". So the refusal history here has two shapes, not one, and the kind this
      file cites over and over for the forbidden "neither" state is the one the draft forgot.

      WHAT IS TRUE WITHOUT A RANKING, which is the part that justifies the refusal: `requestCopy`
      has NO FIELDS. The rectangle is the whole of what a copy needs, it lives in
      `canvas/src/renderer.ts`'s module-level `anchor`/`focus`, and only the BROWSER holds it. So
      `transferForm`, `copy` and `paste`'s escape route is unavailable -- there is no stranded thing
      for a new message to carry, because the missing information is on the client -- and
      `toggleKeypad`'s is unavailable too, for the reason given under the two-branch heading below.

      SO IT NEVER LEGITIMATELY ARRIVES. The browser's renderer consumes the kind and sends `copy`
      -- carrying the rect -- instead, so a `requestCopy` on the wire is either a hand-built frame
      or a renderer defect, and an `error` naming the kind is the right answer to both.

      THE OTHER BRANCH WOULD HAVE BEEN WRONG, not merely redundant: `applyAction` THROWS on this
      kind (`frontend/src/actions.ts`), and `main.ts` calls it outside any try inside a socket text
      handler, so the two-branch rule in the docstring above demands a rejection HERE or an
      interception THERE. An interception would have to be a bare `return`, i.e. silence -- which
      would tell a buggy client its copy had been honored when nothing was copied. `quit`'s branch
      is the right one.

      NO SHAPE CHECK FOLLOWS IT, AND THAT IS NOT THE OMISSION THE `copy` NOTE BELOW WARNS ABOUT:
      the throw is unconditional and nothing downstream ever sees this kind, so there are no fields
      for a malformed frame to under-fill. The "necessary but not sufficient" lesson recorded below
      applies to kinds that are ACCEPTED while carrying fields.
    */
    if (aKind === 'requestCopy') {
      throw new Error('requestCopy is not accepted from a client: the browser holds the selection');
    }
    // `transferForm` IS NOW ACCEPTED, 2026-10-06. It was refused because a browser-initiated
    // transfer would have moved bytes between the host and the GATEWAY's filesystem rather than
    // the operator's -- and socket-carried file I/O is precisely what removes that reason. The
    // bytes now arrive as `transferChunk` messages and leave as `transferData`, so "local file"
    // means the operator's machine.
    //
    // `copy` HAS SINCE FOLLOWED IT, 2026-10-23, in exactly the way the sentences below predicted
    // -- leaving `quit` the only refusal, until `requestCopy` joined it on 2026-10-27 (see the
    // note above it, whose reason is of a different kind from any of these). Those sentences are
    // kept rather than deleted because they are the record of why the refusal existed and of what
    // removed it; see the `copy` and `paste` acceptance note further down for what replaced them.
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
    // `copy` WAS REJECTED FOR THE SAME SHAPE OF REASON `transferForm` WAS, AND IS NOW ACCEPTED FOR
    // THE SAME SHAPE OF REASON TOO (2026-10-23). The refusal's reason was:
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
    // unchanged and only its evidence moved. The second piece of evidence has now moved too, and
    // in the direction that ANSWERS the objection rather than weakening it: as of 2026-10-26 the
    // browser half is BUILT -- `bridgecore.ts` dispatches `copyText` to an optional `onCopyText`
    // dep and `bridge.ts` writes the operator's own clipboard through `writeClipboard`. This
    // paragraph used to read "`bridgecore.ts` still has no clipboard function among its four, and
    // `static/` is one `index.html` with no clipboard code", which was true when written and is
    // kept here because it is what made the objection concrete. `BridgeApi` IS STILL FOUR
    // FUNCTIONS WIDE; the write is a `BridgeDeps` member and an exported helper, which is the
    // distinction that let the half be built without touching the surface `renderer.ts` consumes.
    // The browser's own renderer still cannot extract -- a `DrawCell` carries a CG-order atlas
    // glyph and no character, which is the whole reason the Electron side extracts in main, and
    // the reason the text has to travel back rather than being read locally.
    //
    // So web copy needed a new server->client message plus a `navigator.clipboard` write in the
    // bridge, which was its own spec -- exactly the conclusion already reached for the web transfer
    // UI. THE USER COMMITTED TO BOTH BEFORE PACKAGING (2026-10-05): web copy/paste and the web
    // transfer form. BOTH HALVES HAVE NOW LANDED: the transfer one first, as the worked example,
    // and this one on 2026-10-23 by the same route -- a rejection here became an acceptance plus
    // an interception in `main.ts`, and the integration test's REFUSED list lost a member.
    /*
      `copy` AND `paste` ARE BOTH ACCEPTED NOW, 2026-10-23, AND BOTH REFUSALS ABOVE ARE DELETED --
      which is why their reasoning is preserved rather than removed with them: the reason each was
      refused is the reason each is now accepted, and that inversion is the thing worth keeping.

      WHAT REMOVED EACH REASON, specifically, since "whose machine" was both of them:
        - `copy`: the text would have landed on the GATEWAY's clipboard. The new `copyText` server
          message (see the `ServerMessage` union above) carries the extracted text back to the
          OPERATOR's own browser, which is what removes that reason -- not a relocation of the
          problem but its answer. The extraction itself cannot move to the client: a `DrawCell`
          carries a CG-order atlas glyph and NO character, so the browser's renderer has nothing
          to read and sends the RECTANGLE, while `text` and `hidden` live on `ResolvedCell`, which
          only this side computes.
        - `paste`: the text was on the OPERATOR's machine and the gateway could no more read that
          clipboard than write it. The browser sending text it ALREADY HOLDS is what removes that,
          and `frontend/src/pasteAction.ts`'s `applyPaste` -- the shared helper the refusal said
          did not exist yet -- is what both DOM front ends now call.

      `quit` STAYS REFUSED and was the whole of the refusal list until 2026-10-27. Its reason does
      not expire the way these two did: it would stop the GATEWAY, ending every connected
      operator's session, and no message travelling back to a browser changes whose process is
      being stopped. There is no "the operator's own quit" to send back the way there is an
      operator's own clipboard.

      `requestCopy` IS THE SECOND MEMBER, added 2026-10-27, and its reason does not expire either
      -- for a different reason again, which is why it is refused beside `quit` rather than
      following `copy` out. See the note above its rejection: it carries no fields, so the server
      lacks the rectangle and no message in either direction could supply one. The pattern these
      two share is not "whose machine" but PERMANENCE.

      AND PERMANENCE HAS TO MEAN AGAINST BOTH BRANCHES, NOT JUST AGAINST A NEW MESSAGE, which is
      what `toggleKeypad`'s history teaches: its refusal here was ended by an INTERCEPTION rather
      than by any payload (`2fb921c`, which calls the rejection "a stop-gap"), so "no message can
      free it" is only half a case for a permanent refusal. Both members clear the other half too.
      `quit` would stop the gateway, so an interception that swallowed it would be a lie about
      whether the operator had quit; `requestCopy`'s interception could only be a bare `return`,
      which would tell a buggy client its copy had succeeded when nothing was copied.

      BOTH KINDS NOW OWE `main.ts` AN INTERCEPTION, AND IT LANDS IN THIS SAME COMMIT, because
      `applyAction` THROWS on both (`frontend/src/actions.ts`) and `main.ts` calls it outside any
      try inside a socket text handler -- which `wsserver.ts` runs from a socket 'data' handler, so
      an uncaught throw there ends the PROCESS and every other operator's session. Accepting a kind
      here without that return is the one state this file's two-branch rule forbids, and
      `toggleKeypad` has already spent a commit in it.

      BUT NEITHER INTERCEPTION IS A BARE `return`, which is where these two differ from the four
      above and from what the plan for this change assumed. `transferForm`, `toggleKeypad` and
      `toggleKeyboard` are SWALLOWED -- answered with silence -- because each is the sender's own
      display business. These two are ANSWERED: `copy` with the `copyText` message, which is the
      whole point of accepting it, and `paste` with the frame its repaint produces, since typing
      into the screen emits no session event. So neither joined `integration.test.ts`'s
      `SWALLOWED` list on the way out of its `REFUSED` one.

      MUTATION-PROVED 2026-10-23 by deleting each
      interception separately and re-running `integration.test.ts`; both failures are quoted at
      those lines in `main.ts`.

      AND BOTH KINDS CARRY A FIELD, SO BOTH ARE SHAPE-CHECKED BELOW -- which is the part of this
      change that was NOT in its plan, and was found by measuring rather than by reading. The plan
      deleted these two rejections, added the two interceptions, and stopped; with exactly that,
      `integration.test.ts` still reported `no reply to the copy action`, and then -- with `copy`
      parked in `SWALLOWED` to expose the other half -- `no reply to a tab after copy`, meaning the
      SESSION HAD GONE. `extractText(cells, cols, undefined)` throws a TypeError, and `pasteString`
      throws `text is not iterable` on a non-string, both inside the same socket handler and with
      the same process-ending consequence as the `applyAction` throw this whole rule is about.

      SO THE TWO-BRANCH RULE IS NECESSARY AND NOT SUFFICIENT, which is worth stating plainly next
      to it: it keeps a kind away from a THROWING `applyAction`, and says nothing about the
      interception throwing on its own. A kind whose fields the honest client always fills is
      still a kind a hand-built frame can send empty -- and `integration.test.ts` IS that client,
      by design, which is why it caught this and nothing else could have.

      HERE AND NOT IN `main.ts`, for the reason this file already gives for `pf`/`pa` below and for
      `transferChunk`'s `seq`/`total`/`bytes` above: the boundary that admits untrusted input is
      where the bound belongs, and a malformed frame then takes the SAME path every other malformed
      frame takes -- the decode `try` in `main.ts` answers with an `error` naming the problem, with
      the socket and the session intact. Validating at the call site instead would have needed its
      own error-reply code, duplicated for both kinds.

      WHAT IS CHECKED IS THE SHAPE ONLY, and deliberately not the range. `extractText` CLAMPS a
      rect to the grid (measured: `{top:0,left:0,bottom:1e9,right:1e9}` yields the screen, and
      `-Infinity`/`Infinity` clamp too), and `pasteString` owns what every control character in the
      text means. Re-checking either here would be a second copy of rules that live with their
      consumers. `Number.isInteger` is the test for the four rect fields because a FRACTIONAL rect
      silently extracts NOTHING -- measured: `{top:0.5,left:0.5,bottom:1.5,right:3.5}` returns the
      empty string, so a browser bug of that shape would look like an empty selection rather than
      an error, and `Number.isInteger` rejects NaN and the string "0" in the same stroke.
    */
    if (aKind === 'copy') {
      checkRect((action as { rect?: unknown }).rect, 'copy');
    }
    if (aKind === 'paste') {
      // `pasteString` does `[...text]`, which throws `text is not iterable` on anything else --
      // including a NUMBER, which JSON can carry and `String()` would have quietly accepted. An
      // EMPTY string is valid and must stay valid: it is what a paste from an empty clipboard is,
      // and it pastes nothing and warns about nothing.
      if (typeof (action as { text?: unknown }).text !== 'string') {
        throw new Error('paste text must be a string');
      }
    }
    /*
      `toggleKeyboard` IS ACCEPTED TOO, 2026-10-22, AND BY THE SAME RULE -- stated rather than left
      to the default, because "accepted because nothing refuses it" is how a kind ends up in
      NEITHER branch of this file's two-branch rule.

      It toggles the SENDER's own display and reaches no `Session`, so there is nothing here to
      bound. `applyAction` throws on it, so the OTHER branch was owed and was taken in the same
      commit: `main.ts` returns before `applyAction` for this kind. Without that return the first
      `Ctrl-B` from a browser would have ended the gateway process -- and it did, under
      `integration.test.ts`, before the line was added.
    */
    /*
      `geometryMenu` IS ACCEPTED TOO, 2026-11-04, by the `toggleKeyboard` reasoning above, stated
      here so the kind is visibly in a branch of the two-branch rule rather than accepted by default.

      It opens the SENDER's own model/oversize picker and reaches no `Session`, so there is nothing
      here to bound -- it carries no fields. `applyAction` throws on it, so the interception branch
      was owed and landed in the same commit: `main.ts` returns before `applyAction` for this kind.
      Without that return `integration.test.ts` reported `no reply to a tab after geometryMenu`.
      The CHOICE the picker makes is a separate client message with its own shape check, not this.
    */
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
    // characters it cannot use -- so there is no validity check to make here, only a type one.
    //
    // THE SENTENCE THAT FOLLOWED THIS WAS FALSE AND IS CORRECTED, 2026-10-07. It said the length
    // disagreement a mangled chunk produces "is caught by `ChunkReassembler`, which compares the
    // running total against the declared one". That class refuses OVERRUNS ONLY (`accept`'s
    // `received + bytes.length > declared` test): a SHORT chunk leaves it merely INCOMPLETE and
    // refuses nothing, which is correct there, because a short chunk and a chunk with more to
    // follow are indistinguishable until the sender says it has finished. MEASURED 2026-10-07 on
    // node 26: `'!!!!'` decodes to zero bytes, `'AQ!ID'` silently yields the same three bytes as
    // `'AQID'`, and deleting any one character from the 8-character encoding of 6 bytes yields 5.
    //
    // THE SHORTFALL IS CAUGHT AT `transferStart`, in `transferGateway.ts`, which is the earliest
    // point at which the sender has said it finished -- and that file records at length why the
    // check is there and not here. Until it existed the transfer went silent with no
    // `transferDone` ever sent, which is the stall Task 3's review of this file left behind.
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

  /*
    THE SELECTION PREFETCH, 2026-11-02. A top-level kind, not an `action`, because the operator did
    nothing to the session -- it is answered with `selectionText` and changes no screen. It reaches
    `extractText` in the SAME socket handler `copy` does, so it owns the same two checks: `seq` is
    needed because the browser matches the answer to its own pending promise by that number, and the
    rect gets the identical `checkRect` `copy` uses, for the identical reason.

    `Number.isSafeInteger`, NOT `Number.isInteger`, for `seq`: a value past
    `Number.MAX_SAFE_INTEGER` cannot be echoed back exactly through a JSON round-trip in either
    direction, so the bridge's match on `selectionText`'s `seq` could silently fail.
  */
  if (kind === 'selection') {
    const { seq, rect } = raw as { seq?: unknown; rect?: unknown };
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      throw new Error('selection seq must be a non-negative safe integer');
    }
    return { kind: 'selection', seq, rect: checkRect(rect, 'selection') };
  }

  // THE RESIZE, 2026-11-04. Above the catch-all for the reason the transfer kinds' note gives.
  // Both fields through `checkViewport`, as `hello.viewport` is; see that function.
  if (kind === 'viewport') {
    const { width, height } = checkViewport(raw);
    return { kind: 'viewport', width, height };
  }

  /*
    THE PICKER'S CHOICE, 2026-11-04. Above the catch-all for the reason the transfer kinds' note
    gives. NOT AN `Action`, so outside the two-branch rule's subject -- but the field rule applies in
    full. NOT BECAUSE A BAD FIELD WOULD END THE PROCESS: `applyPick` runs the choice inside a try,
    so even a number that `resolveTerminalType` cannot fold would come back as a notice (an earlier
    draft of this note said "a TypeError in the socket handler", which the try makes false). It is
    because the boundary is where a malformed frame gets its `error` naming the problem, like every
    other kind, rather than a notice phrased for an operator who picked from a list. So the shape is
    closed here: `kind` and exactly one other field, and nothing else (an unknown key is a
    hand-built frame, refused like one); a model that is a
    `KNOWN_MODELS` key under case-folding (`Object.hasOwn`, so `constructor` is not a model, the
    lookup rule `termtype.ts` records); an oversize that is one of the three names. `IBM-3278-4-E`
    is refused even though core would accept it: the picker sends keys, and anything else is a
    hand-built frame.
  */
  if (kind === 'setGeometry') {
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== 'kind' && k !== 'model' && k !== 'oversize')) {
      throw new Error('setGeometry takes only kind and one of model or oversize');
    }
    const hasModel = Object.hasOwn(r, 'model');
    const hasOversize = Object.hasOwn(r, 'oversize');
    if (hasModel === hasOversize) {
      throw new Error('setGeometry needs exactly one of model or oversize');
    }
    if (hasModel) {
      const model = r['model'];
      if (typeof model !== 'string') throw new Error('setGeometry model must be a string');
      const key = model.toUpperCase();
      if (!Object.hasOwn(KNOWN_MODELS, key)) {
        throw new Error(`setGeometry model must be one of ${Object.keys(KNOWN_MODELS).join(', ')}`);
      }
      return { kind: 'setGeometry', model: key };
    }
    const oversize = r['oversize'];
    if (oversize !== 'none' && oversize !== 'auto' && oversize !== 'startup') {
      throw new Error('setGeometry oversize must be none, auto or startup');
    }
    return { kind: 'setGeometry', oversize };
  }

  /*
    THE PICKER'S DISCONNECT, 2026-11-05. Above the catch-all for the reason the transfer kinds'
    note gives, and outside the two-branch rule's subject because it is not an `Action` -- but
    still ACCEPTED HERE AND HANDLED in `main.ts` (`session.disconnect()` on the socket's own
    session, swallowed before `hello`), never one without the other. CLOSED SHAPE: `kind` alone.
    A `sessionId` beside it would read as "disconnect that one", which this gateway never does
    for a socket -- a hand-built frame, refused like one.
  */
  if (kind === 'disconnect') {
    if (Object.keys(raw).some((k) => k !== 'kind')) throw new Error('disconnect takes no fields');
    return { kind: 'disconnect' };
  }

  throw new Error(`unknown client message kind ${String(kind)}`);
}
