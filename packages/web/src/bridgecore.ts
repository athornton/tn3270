/**
 * The browser side of the bridge, with the browser injected.
 *
 * Supplies exactly what `preload.cts` supplies over IPC -- `onAtlas`, `onFrame`, `onError`,
 * `sendAction` -- so `renderer.ts` is reused UNMODIFIED. If `BridgeApi` grows a fifth function,
 * the renderer has stopped being shared and something is wrong.
 *
 * THAT RULE IS ABOUT `BridgeApi` AND NOT ABOUT THIS FILE'S EXPORTS, which is worth spelling out
 * because the two have drifted: `socketUrl` and `writeClipboard` are exported plain functions
 * nothing in the renderer can see, and `BridgeDeps` has grown several members. The renderer
 * consumes `BridgeApi` alone, so that is the width that must not move.
 *
 * ## THE QUEUE IS NOT DEFENSIVE CODING
 *
 * The server sends `atlas` as soon as the socket opens. `renderer.js` registers its handlers when
 * its module body runs. Those orders are independent, so without a queue the atlas can be
 * delivered to nobody and the canvas stays black with no error in any console -- the same
 * signature as the ESM-preload, missing-`.cts`, bare-specifier and `file://`-fetch traps already
 * recorded for this renderer. So inbound messages are held until a handler for their kind exists.
 */
/**
 * ## THESE HANDLER TYPES ARE THE DOM'S, NOT A CONVENIENT APPROXIMATION
 *
 * MEASURED: the obvious spelling -- `onmessage?: ((e: { data: unknown }) => void) | undefined` --
 * does not accept a real `WebSocket`, and the error is two levels deep. A `WebSocket`'s handlers are
 * `| null`, never `| undefined`, and `onopen`/`onclose` are called WITH an `Event`. A function
 * needing one argument is not assignable to a zero-argument type, and `{ data: unknown }` is not a
 * supertype of `MessageEvent`, so parameter contravariance rejects that too. Approximating the
 * shapes therefore forces a cast in `bridge.ts`, which is the one place a cast would hide a real
 * break. Naming the DOM types instead means the shim needs no cast for the socket at all, and
 * `packages/web` already compiles with the DOM lib.
 *
 * The test fakes pass `as never`, so they are unaffected by this and still need no DOM.
 */
export interface BridgeDeps {
  readonly socket: {
    send(data: string): void;
    close(): void;
    onmessage: ((e: MessageEvent) => void) | null;
    onopen: ((e: Event) => void) | null;
    // A `CloseEvent`, not an `Event`: it carries `code`/`reason`/`wasClean`, and `Event` is missing
    // all three, so the narrower spelling is rejected by parameter contravariance.
    onclose: ((e: CloseEvent) => void) | null;
  };
  readonly storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  /** Inflate one binary message to JSON text. Injected because Node and the browser differ. */
  readonly inflate: (data: unknown) => Promise<string>;
  /**
   * Show or hide the keypad overlay. OPTIONAL, and absent means "this client has no keypad".
   *
   * THIS IS THE FIFTH MEMBER OF `BridgeDeps` AND IT DOES NOT BREAK THE FOUR-FUNCTION RULE, which
   * is about `BridgeApi` below -- the surface `renderer.ts` consumes, and whose width is what lets
   * that file be reused UNMODIFIED by Electron. `BridgeDeps` is what the BROWSER ENTRY POINT hands
   * in, and it has always been browser-specific (a socket, `sessionStorage`, a
   * `DecompressionStream`). The renderer never sees it.
   *
   * Here because `toggleKeypad` is intercepted in `sendAction` below rather than sent: the keypad
   * is a DOM overlay in this front end, so showing it is a local display decision with nothing for
   * the server to do. Injected rather than imported so this module still needs no DOM.
   */
  readonly toggleKeypad?: () => void;
  /**
   * Show or hide the FULL 122-KEY KEYBOARD, `Ctrl-B`. 2026-10-22.
   *
   * Here for exactly the reason `toggleKeypad` above is: it is a DOM overlay in this front end, so
   * showing it is a local display decision with nothing for the server to do, and it is
   * intercepted in `sendAction` below rather than sent. OPTIONAL for the same reason too -- the
   * gateway's own tests and any caller with no DOM must be able to construct a bridge without one.
   */
  readonly toggleKeyboard?: () => void;
  /**
   * Transfer messages from the gateway. OPTIONAL, and absent means "this client has no transfer
   * form" -- the same contract `toggleKeypad` above has, for the same reason: the gateway's own
   * tests and any caller with no DOM must not need one.
   *
   * SIXTH MEMBER OF `BridgeDeps`, AND STILL NOT A BREACH OF THE FOUR-FUNCTION RULE, which is
   * about `BridgeApi` below -- the surface `renderer.ts` consumes unmodified. See the note on
   * `toggleKeypad`, which made this argument first.
   *
   * WITHOUT THIS HOOK THE THREE TRANSFER KINDS VANISH. The `onmessage` chain below returns on
   * each kind it knows and then simply ends, so an unhandled kind is dropped with nothing in any
   * console -- the operator would see a transfer form that never updates and no way to tell why.
   *
   * NOT ROUTED THROUGH `dispatch`, unlike every other inbound kind, and the asymmetry is the
   * point: that queue exists because `renderer.js` registers its handlers when its module body
   * runs, which races the atlas. The transfer overlay is built by the SAME module that constructs
   * this bridge (`bridge.ts`), so its handler cannot be late and there is nothing to queue --
   * while `dispatch`ing an unclaimed transfer kind would park it in that queue forever.
   *
   * TYPED LOOSELY, MATCHING THE `JSON.parse` RESULT BELOW RATHER THAN `protocol.ts`'s
   * `ServerMessage`. `import type` from that module would erase at build (checked: no
   * `verbatimModuleSyntax`, so it does not reach the browser's import graph), so servability is
   * NOT the reason -- an earlier draft of this comment claimed it was and was wrong. The reason
   * is that narrowing a parsed JSON object to a discriminated union takes an unchecked `as`, and
   * this file validates nothing: it would be telling the compiler the gateway sent a well-formed
   * message, which is exactly the claim a cast must not make. The overlay narrows on `kind`.
   */
  readonly onTransfer?: (msg: { kind: string } & Record<string, unknown>) => void;
  /**
   * Open the transfer form. OPTIONAL, and absent means "this client has no transfer form" --
   * the same contract `toggleKeypad` above has, for the same reason.
   *
   * SEVENTH MEMBER OF `BridgeDeps`, and still not a breach of the four-function rule, which is
   * about `BridgeApi` below. See the note on `toggleKeypad`, which made that argument first.
   *
   * THE SERVER'S OWN `transferForm` INTERCEPT STAYS (`main.ts:314`), and this does not replace
   * it. `applyAction` still THROWS on this kind (`frontend/src/actions.ts:57-59`) and `main.ts`
   * calls it outside any try inside a socket `data` handler, where an escaping throw ends the
   * GATEWAY PROCESS -- and a client is not obliged to run served code:
   * `integration.test.ts` sends every `Action` kind as a raw frame. Both halves are required,
   * which is `protocol.ts`'s two-branch rule.
   *
   * `| undefined` EXPLICITLY, unlike `toggleKeypad` beside it. Under
   * `tsconfig.base.json`'s `exactOptionalPropertyTypes: true` a bare `?:` accepts the property
   * being ABSENT but rejects it being present and `undefined`, so the annotation is what lets a
   * caller inject the result of a condition rather than branching on the whole object literal.
   * `bridge.ts` passes a real function today; `transferBridge.ts`'s `savePicker` records the
   * measurement (`TS2379`) for the dep that is genuinely handed `undefined`.
   */
  readonly showTransfer?: (() => void) | undefined;
  /**
   * The operator's copied text, for THEIR clipboard. 2026-10-23.
   *
   * OPTIONAL, the same contract `toggleKeypad`, `toggleKeyboard` and `onTransfer` above have and
   * for the same reason: the gateway's own tests and any caller with no DOM must be able to
   * construct a bridge without one.
   *
   * STILL NOT A BREACH OF THE FOUR-FUNCTION RULE, which is about `BridgeApi` below -- the surface
   * `renderer.ts` consumes unmodified, and whose width is what lets that file be reused by
   * Electron. See the note on `toggleKeypad`, which made this argument first. LAST IN THE
   * INTERFACE DELIBERATELY: `showTransfer` above states its own position in this list, so
   * inserting beside `onTransfer` -- where the plan for this task said to put it -- would have
   * falsified that sentence.
   *
   * WHY A SERVER->CLIENT MESSAGE EXISTS AT ALL is stated once in `protocol.ts`, on the `copyText`
   * member: only the gateway can extract the text. Cited rather than restated, because it is a
   * fact about `canvas/src/drawlist.ts`'s `DrawCell` and this rationale is already copied into
   * enough files to drift independently.
   *
   * WITHOUT THIS HOOK THE REPLY IS DROPPED: the `onmessage` chain below returns on each kind it
   * knows and then falls off the end, with no `else`, no throw and no log -- so the operator would
   * press copy, the gateway would log `copy: N chars`, and their clipboard would be unchanged with
   * nothing in any console. Same shape as the transfer kinds before `onTransfer` existed.
   *
   * NOT ROUTED THROUGH `dispatch`, for the reason `onTransfer` gives above: that queue exists
   * because `renderer.js` registers its handlers when its module body runs, which races the atlas.
   * This handler is injected by the SAME module that constructs the bridge (`bridge.ts`), so it
   * cannot be late and there is nothing to queue -- while `dispatch`ing this kind would park it in
   * that queue forever, since `onAtlas`/`onFrame`/`onError` are the only registrars and each
   * hardcodes its kind.
   *
   * ## `String(msg['text'])` IS SUFFICIENT, AND THAT IS ABOUT DIRECTION RATHER THAN TRUST
   *
   * This repo's rule is that the two-branch rule is necessary but not sufficient -- a kind's
   * FIELDS must be shape-checked at decode -- so the bare coercion below invites the question.
   * `decodeClientMessage` is the boundary that rule governs: it guards CLIENT->server messages,
   * where the sender is a client under nobody's control and the prior task measured the cost as
   * the GATEWAY PROCESS and every other operator's session with it. `copyText` runs the other way.
   * Its sender is the gateway whose own JS this browser is already executing, and the blast radius
   * of a malformed one is one string on one operator's clipboard in one tab.
   *
   * MEASURED 2026-10-26 rather than reasoned about, and the convenient version of this claim is
   * WRONG: `String()` is not total over JSON-reachable values. `{"text":{"toString":null}}` parses
   * fine -- `toString` is an ordinary own property and the prototype is untouched -- and coercing
   * it throws `TypeError: Cannot convert object to primitive value`, inside the un-awaited async
   * IIFE below, which makes it an unhandled rejection rather than anything visible.
   *
   * THE RULE IS AN OWN `toString` THAT IS NOT CALLABLE, not that one specific literal:
   * `{"toString":1}` throws identically, and so does `[{"toString":null}]` -- `Array.prototype
   * .join` coerces each ELEMENT, so an array is only as safe as its contents, at any depth. A
   * literal `__proto__` key does NOT hijack it, because `JSON.parse` leaves the prototype intact,
   * so `{"text":{"__proto__":{"toString":null}}}` coerces to `"[object Object]"`.
   *
   * THE SHAPES CHECKED, and deliberately not "every other shape": `{}`, `[1,2]`, `[null,1,"a"]`,
   * `[{}]`, `{"valueOf":null}`, `null`, a number, a boolean and an absent field all coerce without
   * throwing. An enumeration is the evidence for "only this family throws", so a reader who tests
   * it must not find a thrower it implied was safe -- which is what an unqualified "every other
   * shape" did here, by inviting generalization from `[1,2]` to arrays.
   *
   * NOT HARDENED HERE, because the thrower has to be the gateway and the gateway encodes this
   * field from a `string`; recorded so the next reader neither hardens it on a false premise nor
   * cites it as precedent for skipping a check on the inbound side, where the cost is the process.
   *
   * NO `| undefined` ANNOTATION, unlike `showTransfer` above. That annotation is what lets a
   * caller inject the result of a condition under `exactOptionalPropertyTypes`; `bridge.ts` passes
   * a real function here unconditionally, and the capability detection lives one level down in
   * `writeClipboard` below -- injected there, which is what gives the no-API route a test.
   */
  readonly onCopyText?: (text: string) => void;
}

export interface BridgeApi {
  onAtlas(fn: (atlas: unknown) => void): void;
  onFrame(fn: (frame: unknown) => void): void;
  onError(fn: (message: string) => void): void;
  sendAction(action: unknown): void;
}

/**
 * The gateway's WebSocket URL, resolved against the document the page was served from.
 *
 * HERE RATHER THAN IN `bridge.ts` SO IT CAN BE TESTED. That file touches real browser globals at
 * module load, so no unit test can import it -- and this is pure arithmetic on two strings, which
 * is exactly the split this module exists for.
 *
 * ## WHY IT IS RELATIVE AND NOT BUILT FROM THE HOST
 *
 * The first version was `` `${proto}//${location.host}/ws` ``, which discards the PATH. That is
 * correct at the root and broken behind every reverse proxy with a prefix.
 *
 * MEASURED 2026-10-07 against a JupyterLab `/proxy/<port>/` route on the Rubin Science Platform:
 * served at `https://host/nb/user/athor/proxy/8017/`, all eighteen browser modules loaded with
 * HTTP 200 and the socket went to `wss://host/ws` -- the platform's own root rather than the
 * gateway. Nothing errored visibly; the page simply never received an atlas or a frame, so the
 * canvas stayed BLACK AND UNRESPONSIVE. That is this project's most-repeated failure signature,
 * arriving by a route no harness covers, because every harness loads the page from `/`.
 *
 * THE PROTOCOL SWAP IS STILL OURS. `new URL` keeps the document's `http:`/`https:`, so the
 * `ws:`/`wss:` substitution has to be explicit -- which is also what makes a TLS gateway work
 * with no flag, the property `bridge.ts`'s header claims.
 *
 * NO SERVER CHANGE IS NEEDED, which is worth saying because it looks like it should be:
 * `main.ts`'s `upgrade` handler parses the request URL only for its query string and NEVER
 * compares the path, so it accepts an upgrade at any path. `/ws` was a convention, not a route.
 */
export function socketUrl(documentHref: string): string {
  const url = new URL('ws', documentHref);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * A narrowing of `navigator.clipboard` to the one method this uses.
 *
 * Declared rather than taken from `lib.dom` so `writeClipboard` can be handed `undefined`, which
 * `Navigator.clipboard`'s own type forbids -- see that function's note. The same shape and the
 * same reason as `transferBridge.ts`'s `SaveSink`, which narrows a `FileSystemWritableFileStream`
 * so a unit test can supply one.
 */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/**
 * Put the operator's copied text on their clipboard, or say why it could not be done.
 *
 * HERE RATHER THAN IN `bridge.ts` SO THE NO-API ROUTE CAN BE TESTED, which is the same split
 * `socketUrl` above exists for and the same one `transferBridge.ts` makes for its save dialog.
 * `bridge.ts` touches real browser globals at module load, so no unit test can import it; this
 * takes the clipboard and the warn sink as PARAMETERS, so both routes are drivable with no DOM.
 * It is an exported plain function and not a fifth member of `BridgeApi`, exactly as `socketUrl`
 * is -- the four-function rule is about the surface `renderer.ts` consumes.
 *
 * ## `clip === undefined` IS THE COMMON CASE AND THE UNTESTED ROUTE IS THE ONE THAT ROTS
 *
 * `navigator.clipboard` is SECURE-CONTEXT-ONLY, and a LAN deployment of this gateway on plain
 * `http` does not have one. `transferBridge.ts` records the identical situation for
 * `showSaveFilePicker` -- "`undefined` is the COMMON case for this gateway, not an edge one" --
 * and the structural lesson with it: "the fallback is the one at risk of rotting, because a
 * developer on Chrome-over-localhost always gets the picker." So the capability is INJECTED here
 * rather than read from `navigator` at the point of use, which is the whole reason this function
 * exists instead of an inline `if` in the entry point.
 *
 * ## THE GUARD BELOW IS COMPILER-ENFORCED, NOT COMMENT-ENFORCED
 *
 * MEASURED 2026-10-26: deleting the `clip === undefined` branch FAILS THE BUILD with
 * `TS18048: 'clip' is possibly 'undefined'`. So a reader who takes it for dead code finds out
 * from `tsc` rather than from an operator whose copy silently did nothing, and that is the
 * durable half of this note -- re-measure it rather than trusting this line if the signature
 * ever changes.
 *
 * THE `| undefined` IN THE SIGNATURE IS WHAT BUYS THAT, and it is also why `bridge.ts`'s call
 * needs no cast. `lib.dom.d.ts` declares `readonly clipboard: Clipboard` on `Navigator`, NOT
 * `| undefined`, which is wrong about every non-secure context; inlined in `bridge.ts` that
 * narrowed this guard's body to `never`, and the branch most likely to RUN in production read as
 * dead code to anyone cleaning up. Injecting the capability is what inverted that.
 *
 * CAUGHT, NOT VOIDED. `void` on a rejecting promise is what CREATES an unhandled rejection --
 * measured on this project's transfer window, and the reason `gui/src/main.ts` wraps its own
 * clipboard call. A clipboard the browser refuses (permission denied, an unfocused document) is
 * reportable and recoverable, never fatal: this returns `void` rather than the promise precisely
 * so no caller can forget to handle it.
 *
 * NO `execCommand` FALLBACK, which is a refusal to guess rather than an omission.
 * `document.execCommand('copy')` would need a hidden textarea, a selection and transient user
 * activation that this path -- a server message arriving asynchronously -- does not have. What a
 * non-secure-context browser actually does here is NOT YET MEASURED; the real-browser task is
 * where that belongs, and a speculative fallback would be untested code on the exact path whose
 * failure mode is already silent.
 */
export function writeClipboard(
  clip: ClipboardWriter | undefined,
  text: string,
  warn: (message: string) => void,
): void {
  if (clip === undefined) {
    warn('copy: this browser has no clipboard API (needs a secure context)');
    return;
  }
  clip.writeText(text).catch((err: unknown) => {
    warn(`copy: the browser refused the clipboard: ${String(err)}`);
  });
}

const ID_KEY = 'tn3270.sessionId';

export function createBridge(deps: BridgeDeps): BridgeApi {
  const handlers = new Map<string, (payload: unknown) => void>();
  const queue: Array<{ kind: string; payload: unknown }> = [];

  const dispatch = (kind: string, payload: unknown): void => {
    const fn = handlers.get(kind);
    if (fn === undefined) { queue.push({ kind, payload }); return; }
    fn(payload);
  };

  const register = (kind: string, fn: (payload: unknown) => void): void => {
    handlers.set(kind, fn);
    // Flush in arrival order, keeping anything still unclaimed.
    const mine = queue.filter((m) => m.kind === kind);
    for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i]!.kind === kind) queue.splice(i, 1);
    for (const m of mine) fn(m.payload);
  };

  deps.socket.onopen = () => {
    const id = deps.storage.getItem(ID_KEY);
    deps.socket.send(JSON.stringify(id === null ? { kind: 'hello' } : { kind: 'hello', sessionId: id }));
  };

  deps.socket.onclose = () => {
    dispatch('error', 'The connection to the gateway closed. Reload to reconnect.');
  };

  deps.socket.onmessage = (e) => {
    void (async () => {
      const text = await deps.inflate(e.data);
      const msg = JSON.parse(text) as { kind: string } & Record<string, unknown>;
      if (msg.kind === 'session') {
        deps.storage.setItem(ID_KEY, String(msg['id']));
        return;
      }
      if (msg.kind === 'atlas') {
        // base64 is a transport detail; the renderer must see what structured clone gave it.
        const bytes = Uint8Array.from(atob(String(msg['coverage'])), (c) => c.charCodeAt(0));
        dispatch('atlas', { geometry: msg['geometry'], coverage: bytes, blank: msg['blank'] });
        return;
      }
      if (msg.kind === 'frame') { dispatch('frame', msg['list']); return; }
      if (msg.kind === 'error') { dispatch('error', String(msg['message'])); return; }
      // THE RECEIVING HALF OF `copy`, 2026-10-23. NOT through `dispatch`, for the reason the
      // transfer branch below gives: that queue is for handlers `renderer.js` registers in its
      // module body, and this is not one of them -- `bridge.ts` injects it at construction, so it
      // cannot be late, and a `dispatch`ed `copyText` would sit in the queue forever. Absent, the
      // text is dropped, which is correct for a client with no clipboard to write.
      if (msg.kind === 'copyText') { deps.onCopyText?.(String(msg['text'])); return; }
      if (msg.kind === 'transferProgress' || msg.kind === 'transferDone'
        || msg.kind === 'transferData') {
        // `atob`, NOT `Buffer.from(s, 'base64')`: this module is SERVED TO THE BROWSER by
        // `httpstatic.ts` and `Buffer` does not exist here. The atlas branch above decodes its
        // `coverage` the same way, which is the one convention for bytes over this socket -- and
        // `encodeServerMessage` in `protocol.ts` records that an earlier comment there named
        // `Buffer` for this very message and had to be corrected. (Both of this sentence's line
        // references were stale before this feature touched the file -- `:233` for the atlas and
        // `protocol.ts:64-68` for that note -- which is why neither is a number any more.)
        //
        // ONLY `transferData` CARRIES BYTES. `transferProgress` and `transferDone` are passed
        // through untouched, and decoding a missing `bytes` field would turn `undefined` into the
        // string "undefined" and then into nine garbage bytes.
        deps.onTransfer?.(msg.kind === 'transferData'
          ? { ...msg, bytes: Uint8Array.from(atob(String(msg['bytes'])), (c) => c.charCodeAt(0)) }
          : msg);
        return;
      }
    })();
  };

  return {
    onAtlas: (fn) => { register('atlas', fn as (p: unknown) => void); },
    onFrame: (fn) => { register('frame', fn as (p: unknown) => void); },
    onError: (fn) => { register('error', (p) => { fn(String(p)); }); },
    sendAction: (action) => {
      // `quit` never goes to the server: a browser must not be able to stop the gateway. But the
      // renderer binds Ctrl-] and a dead key is worse than either alternative, so it means
      // "disconnect this session" -- which, after the grace window, is exactly what it says.
      if ((action as { kind?: unknown }).kind === 'quit') {
        deps.socket.close();
        dispatch('error', 'Disconnected. Reload to start a new session.');
        return;
      }
      /**
       * `toggleKeypad` IS NOW CLIENT-SIDE AND MUST NOT REACH THE SERVER.
       *
       * It used to, and the reason is worth keeping: the keypad was a REGION OF THE DRAW LIST the
       * server builds, so `web/src/main.ts` flipped a `showKeypad` flag and repainted. As of
       * 2026-10-06 the web keypad is a DOM overlay drawn in the browser, so the server has nothing
       * to toggle and a round trip would be a full repaint for no visible change.
       *
       * ## THE SERVER'S OWN INTERCEPT STAYS, AND REMOVING IT WOULD BE A BUG RATHER THAN A CLEANUP
       *
       * `applyAction` still THROWS on this kind, and `web/src/main.ts` calls it OUTSIDE any try
       * inside a socket `data` handler -- where a throw ends the GATEWAY PROCESS and every other
       * operator's session with it. This interception is served code, and a client is not obliged
       * to run served code: `integration.test.ts` sends every `Action` kind as a raw frame, which
       * is precisely the unobliged client. So BOTH halves are required, which is the two-branch
       * rule `protocol.ts` writes down at length -- and `toggleKeypad` has already spent one
       * commit in the forbidden "neither" state.
       *
       * `deps.toggleKeypad` is OPTIONAL, so the gateway's own tests and any caller with no DOM
       * can construct a bridge without one. Absent, the action is simply dropped -- which is
       * correct for a client that has no keypad to show, and is why this returns either way
       * rather than falling through to the socket.
       */
      if ((action as { kind?: unknown }).kind === 'toggleKeypad') {
        deps.toggleKeypad?.();
        return;
      }
      /**
       * `toggleKeyboard` IS CLIENT-SIDE TOO, BY THE SAME ARGUMENT, 2026-10-22.
       *
       * The full keyboard is a DOM overlay drawn in the browser, so showing it is a local display
       * decision the server has nothing to do with. `main.ts` keeps its OWN intercept regardless,
       * which is the two-branch rule rather than belt and braces: a client is not obliged to run
       * the code we served it, and `applyAction` throws on this kind OUTSIDE ANY TRY in a socket
       * handler -- so a hand-rolled client sending it would end the gateway process. Measured on
       * the way in: `integration.test.ts` reported `no reply to the toggleKeyboard action` before
       * the server-side return existed.
       *
       * Absent `deps.toggleKeyboard`, the action is DROPPED rather than falling through to the
       * socket -- correct for a client with no keyboard to show, and the same bargain the keypad
       * branch above makes.
       */
      if ((action as { kind?: unknown }).kind === 'toggleKeyboard') {
        deps.toggleKeyboard?.();
        return;
      }
      /**
       * `transferForm` IS CLIENT-SIDE TOO, AND FOR THE SAME REASON THE KEYPAD IS.
       *
       * The transfer form is a DOM overlay drawn in the browser (`transferOverlay.ts`), so
       * showing it is a local display decision with nothing for the server to do. The operator
       * reaches this through the keypad's `Xfer` button (`frontend/src/keypad.ts:145`) or the
       * renderer's key binding, and both arrive here as an `Action`.
       *
       * BEFORE THIS BRANCH THE ACTION CROSSED THE SOCKET AND WAS SWALLOWED. `main.ts:314` is
       * `if (msg.action.kind === 'transferForm') return;` -- a bare return with no reply, which
       * Task 3 of this plan recorded as the deliberate "SWALLOWED" state while the browser half
       * did not exist yet. So an `Xfer` press was a round trip that produced nothing visible.
       *
       * ## THE SERVER'S INTERCEPT STAYS AND REMOVING IT WOULD BE A BUG, NOT A CLEANUP
       *
       * Exactly as the `toggleKeypad` note above argues: `applyAction` THROWS on this kind
       * (`frontend/src/actions.ts:57-59`, "the front end owns its own dialog") and `main.ts`
       * calls it outside any try inside a socket `data` handler. This interception is SERVED
       * code, and a client is not obliged to run served code -- `integration.test.ts` sends
       * every `Action` kind as a raw frame, which is precisely the unobliged client. Both halves
       * are required, which is `protocol.ts`'s two-branch rule.
       *
       * `deps.showTransfer` is OPTIONAL, so the gateway's own tests and any caller with no DOM
       * can construct a bridge without one. Absent, the action is DROPPED rather than sent --
       * which is correct for a client with no form to show, and is why this returns either way
       * rather than falling through to the socket.
       */
      if ((action as { kind?: unknown }).kind === 'transferForm') {
        deps.showTransfer?.();
        return;
      }
      deps.socket.send(JSON.stringify({ kind: 'action', action }));
    },
  };
}
