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
}

export interface BridgeApi {
  onAtlas(fn: (atlas: unknown) => void): void;
  onFrame(fn: (frame: unknown) => void): void;
  onError(fn: (message: string) => void): void;
  sendAction(action: unknown): void;
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
      deps.socket.send(JSON.stringify({ kind: 'action', action }));
    },
  };
}
