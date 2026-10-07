/**
 * The browser side of the bridge, with the browser injected.
 *
 * Supplies exactly what `preload.cts` supplies over IPC -- `onAtlas`, `onFrame`, `onError`,
 * `sendAction` -- so `renderer.ts` is reused UNMODIFIED. If this file grows a fifth function, the
 * renderer has stopped being shared and something is wrong.
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
      if (msg.kind === 'transferProgress' || msg.kind === 'transferDone'
        || msg.kind === 'transferData') {
        // `atob`, NOT `Buffer.from(s, 'base64')`: this module is SERVED TO THE BROWSER by
        // `httpstatic.ts` and `Buffer` does not exist here. The atlas branch above decodes its
        // `coverage` the same way at `:133`, which is the one convention for bytes over this
        // socket -- and `protocol.ts:64-68` records that an earlier comment there named `Buffer`
        // for this very message and had to be corrected.
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
