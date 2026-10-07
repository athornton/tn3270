import { describe, it, expect, vi } from 'vitest';
import { createBridge, socketUrl } from '../src/bridgecore.js';

/**
 * The bridge's LOGIC, with the browser injected.
 *
 * `bridge.ts` is a five-line shim that passes the real `WebSocket` and `sessionStorage`; everything
 * worth testing lives here, so it runs under vitest's node environment with no DOM at all. This is
 * the same instinct as the TUI's `app.ts` taking its streams as parameters rather than reaching for
 * `process`.
 */
const fakeSocket = () => {
  const sent: string[] = [];
  const s = {
    sent,
    readyState: 1,
    send: (t: string) => sent.push(t),
    close: vi.fn(),
    onmessage: undefined as ((e: { data: unknown }) => void) | undefined,
    onopen: undefined as (() => void) | undefined,
    onclose: undefined as (() => void) | undefined,
  };
  return s;
};

const fakeStorage = (initial?: string) => {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('tn3270.sessionId', initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    map,
  };
};

/** Inbound messages arrive already-inflated in these tests; inflation is the shim's job. */
const deliver = (socket: ReturnType<typeof fakeSocket>, msg: unknown) => {
  socket.onmessage?.({ data: JSON.stringify(msg) });
};

describe('createBridge', () => {
  it('sends hello on open, with no id the first time', () => {
    const socket = fakeSocket();
    createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello' });
  });

  it('offers a stored session id, so a reload reattaches', () => {
    const socket = fakeSocket();
    createBridge({ socket: socket as never, storage: fakeStorage('kept-id') as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello', sessionId: 'kept-id' });
  });

  it('stores the id the server assigns', async () => {
    const socket = fakeSocket();
    const storage = fakeStorage();
    createBridge({ socket: socket as never, storage: storage as never, inflate: async (d) => String(d) });
    deliver(socket, { kind: 'session', id: 'new-id' });
    await Promise.resolve();
    expect(storage.map.get('tn3270.sessionId')).toBe('new-id');
  });

  it('QUEUES messages that arrive before a handler is registered, and flushes in order', async () => {
    // THE RACE THIS EXISTS FOR: the server sends `atlas` as soon as the socket opens, but
    // renderer.js registers its handlers when its module body runs. Without the queue the atlas is
    // delivered to nobody and the canvas stays black with NO error -- the same signature as four
    // other traps already recorded for this renderer.
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    deliver(socket, { kind: 'atlas', geometry: { cols: 16 }, coverage: 'AQID', blank: [1] });
    deliver(socket, { kind: 'frame', list: { width: 1, height: 1, cells: [] } });
    deliver(socket, { kind: 'frame', list: { width: 2, height: 2, cells: [] } });
    await Promise.resolve();

    const atlases: unknown[] = [];
    const frames: unknown[] = [];
    api.onAtlas((a) => atlases.push(a));
    api.onFrame((f) => frames.push(f));
    await Promise.resolve();

    expect(atlases).toHaveLength(1);
    expect(frames).toHaveLength(2);
    expect((frames[0] as { width: number }).width).toBe(1);
    expect((frames[1] as { width: number }).width).toBe(2);
  });

  it('decodes the atlas coverage back to a Uint8Array', async () => {
    // The renderer expects what Electron's structured clone gave it. base64 is a transport detail
    // and must not leak into it.
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    let got: { coverage: Uint8Array } | undefined;
    api.onAtlas((a) => { got = a as { coverage: Uint8Array }; });
    deliver(socket, { kind: 'atlas', geometry: {}, coverage: 'AQID', blank: [] });
    await Promise.resolve();
    expect(got!.coverage).toBeInstanceOf(Uint8Array);
    expect([...got!.coverage]).toEqual([1, 2, 3]);
  });

  it('forwards an action', () => {
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    api.sendAction({ kind: 'enter' });
    expect(JSON.parse(socket.sent[1]!)).toEqual({ kind: 'action', action: { kind: 'enter' } });
  });

  it('INTERCEPTS quit: closes the socket and reports it, never sends it', () => {
    // A browser must not be able to stop the gateway, but Ctrl-] cannot be a dead key either --
    // the renderer binds it and a silent no-op is worse than either alternative.
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    api.sendAction({ kind: 'quit' });
    expect(socket.sent.filter((s) => s.includes('quit'))).toHaveLength(0);
    expect(socket.close).toHaveBeenCalled();
    expect(errors.join(' ')).toMatch(/disconnect/i);
  });

  it('INTERCEPTS toggleKeypad: calls the local handler, never sends it', () => {
    /**
     * THE KEYPAD IS A DOM OVERLAY IN THIS FRONT END AS OF 2026-10-06, so showing it is a local
     * display decision with nothing for the server to do. It USED to cross the socket, because
     * the keypad was a region of the draw list the server built.
     *
     * Both halves are asserted, and the second is the one that matters: a handler that fired AND
     * also sent would make the server repaint for no visible change, and -- worse -- would reach
     * `applyAction`, which THROWS on this kind outside any try in a socket handler. The server
     * keeps its own intercept for exactly that reason, since a client is not obliged to run
     * served code; this is the other half of `protocol.ts`'s two-branch rule.
     */
    const socket = fakeSocket();
    let toggled = 0;
    const api = createBridge({
      socket: socket as never,
      storage: fakeStorage() as never,
      inflate: async (d) => String(d),
      toggleKeypad: () => { toggled += 1; },
    });
    socket.onopen?.();
    api.sendAction({ kind: 'toggleKeypad' });
    expect(toggled).toBe(1);
    expect(socket.sent.filter((s) => s.includes('toggleKeypad'))).toHaveLength(0);
  });

  it('DROPS toggleKeypad when no handler is given, rather than sending it', () => {
    // `toggleKeypad` is optional on the deps, so a caller with no DOM -- the gateway's own tests,
    // or a future headless client -- can build a bridge without one. Dropping is correct for a
    // client with no keypad to show; falling through to the socket would hand the server an
    // action that throws.
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    socket.onopen?.();
    api.sendAction({ kind: 'toggleKeypad' });
    expect(socket.sent.filter((s) => s.includes('toggleKeypad'))).toHaveLength(0);
  });

  it('INTERCEPTS transferForm: shows the local overlay, never sends it', () => {
    /**
     * THE TRANSFER FORM IS A DOM OVERLAY IN THIS FRONT END TOO (2026-10-07), so opening it is a
     * local display decision. It USED to cross the socket, where `main.ts:314` swallowed it with
     * a bare return -- so the operator's `Xfer` press was a round trip that produced nothing.
     *
     * BOTH HALVES ARE ASSERTED, and the second is the one that matters: a handler that fired AND
     * also sent would reach `applyAction`, which THROWS on this kind outside any try in a socket
     * handler -- which `wsserver.ts` records as ending the gateway process. The server keeps its
     * own intercept for exactly that reason, since a client is not obliged to run served code;
     * this is the other half of `protocol.ts`'s two-branch rule.
     */
    const socket = fakeSocket();
    let shown = 0;
    const api = createBridge({
      socket: socket as never,
      storage: fakeStorage() as never,
      inflate: async (d) => String(d),
      showTransfer: () => { shown += 1; },
    });
    socket.onopen?.();
    api.sendAction({ kind: 'transferForm' });
    expect(shown).toBe(1);
    expect(socket.sent.filter((s) => s.includes('transferForm'))).toHaveLength(0);
  });

  it('DROPS transferForm when no handler is given, rather than sending it', () => {
    // `showTransfer` is optional on the deps for the reason `toggleKeypad` is: the gateway's own
    // tests, and any caller with no DOM, must be able to build a bridge without one. Dropping is
    // correct for a client with no form to show; falling through to the socket would hand the
    // server an action `applyAction` throws on.
    //
    // THE ABSENCE CASE IS NOT CEREMONY. `deps.showTransfer?.()` with a non-optional call --
    // `deps.showTransfer()` -- is a `TypeError` thrown out of `sendAction`, i.e. out of the
    // renderer's own key handler, for every client that has no overlay.
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    socket.onopen?.();
    expect(() => api.sendAction({ kind: 'transferForm' })).not.toThrow();
    expect(socket.sent.filter((s) => s.includes('transferForm'))).toHaveLength(0);
  });

  it('hands transfer messages to onTransfer, decoding transferData bytes', async () => {
    /**
     * WITHOUT THIS HOOK THE THREE TRANSFER KINDS VANISH WITH NOTHING IN ANY CONSOLE.
     *
     * `onmessage` returns on each kind it knows and then simply falls off the end -- no `else`, no
     * throw, no log. So before this branch existed, `transferProgress`, `transferDone` and
     * `transferData` were silently discarded: the operator would watch a transfer form that never
     * updated and there would be no evidence anywhere -- the same shape as the other
     * nothing-in-any-console traps recorded for this renderer (`bridgecore.ts:8-14` lists them).
     */
    const socket = fakeSocket();
    const got: unknown[] = [];
    createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
      onTransfer: (m) => { got.push(m); },
    });
    deliver(socket, { kind: 'transferProgress', text: '512 bytes' });
    deliver(socket, { kind: 'transferDone', ok: true, bytes: 3 });
    deliver(socket, { kind: 'transferData', seq: 0, total: 3, bytes: 'AQID' });
    await Promise.resolve();
    expect(got).toHaveLength(3);
    // The first two pass through untouched -- there is nothing in them to decode.
    expect(got[0]).toEqual({ kind: 'transferProgress', text: '512 bytes' });
    expect(got[1]).toEqual({ kind: 'transferDone', ok: true, bytes: 3 });
    // DECODED TO REAL BYTES, so the form never sees base64 -- the same contract the atlas has, and
    // `protocol.ts:58-60` names this decode as the one convention for bytes over this socket
    // rather than a second one. `atob`, NOT `Buffer`: this module is served to the browser.
    const data = got[2] as { kind: string; seq: number; total: number; bytes: Uint8Array };
    expect(data.bytes).toBeInstanceOf(Uint8Array);
    expect([...data.bytes]).toEqual([1, 2, 3]);
    expect(data.seq).toBe(0);
    expect(data.total).toBe(3);
  });

  it('DROPS transfer messages when no handler is given, rather than throwing', async () => {
    /**
     * `onTransfer` is optional on the deps for exactly the reason `toggleKeypad` is: the gateway's
     * own tests and any caller with no DOM -- `integration.test.ts` builds no bridge at all, and a
     * future headless client would -- must not need a transfer form to exist.
     *
     * ## THE LISTENER IS WHY THIS TEST IS WORTH ANYTHING, AND IT WAS ADDED AFTER A MUTATION SURVIVED
     *
     * MEASURED 2026-10-06: without it, replacing `deps.onTransfer?.(...)` with a non-optional call
     * -- so an absent handler throws `is not a function` -- left this file 13/13 GREEN. The throw
     * happens inside `onmessage`'s async IIFE, which nothing awaits, so it becomes an UNHANDLED
     * REJECTION that vitest does not fail the test on. The assertions below could not see it:
     * `errors` stayed empty and nothing was sent, because the throw happens after both.
     *
     * In the browser the same break is an uncaught promise rejection in the console and a form
     * that never updates -- i.e. invisible in exactly the way this repo's recorded traps are. So
     * the rejection is captured explicitly rather than assumed absent.
     */
    const seen: unknown[] = [];
    const onRejection = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', onRejection);
    const socket = fakeSocket();
    const errors: string[] = [];
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    api.onError((m) => errors.push(m));
    deliver(socket, { kind: 'transferDone', ok: true });
    deliver(socket, { kind: 'transferData', seq: 0, total: 3, bytes: 'AQID' });
    // A MACROTASK, not `await Promise.resolve()`: a rejection is reported at the end of the
    // microtask queue, so the microtask tick the other cases use lands too early to see one.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    process.off('unhandledRejection', onRejection);
    expect(seen, 'an absent onTransfer must be inert, not a rejected promise').toEqual([]);
    // Dropped, not reported as an error and not queued for a handler that will never register.
    expect(errors).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  it('does NOT send transfer messages to the renderer handlers, which cannot read them', async () => {
    /**
     * `onTransfer` IS A CONSTRUCTION-TIME DEP, NOT A REGISTERED HANDLER, and this is the case
     * that pins the difference.
     *
     * The queue exists because `renderer.js` registers its handlers when its module body runs,
     * which races the atlas the server sends on open. There is no such race for transfer: the
     * SAME module that constructs this bridge builds the overlay (`bridge.ts`), so the handler is
     * present or it never will be. So `dispatch` is the wrong route twice over -- under its own
     * kind a transfer message would sit in the queue forever waiting for a registration that
     * never comes, and under a renderer kind it would reach `renderer.js`, which has no case for
     * it. Two assertions, because they are two different breaks:
     */
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
      onTransfer: () => { /* present, so the branch is taken */ },
    });
    const frames: unknown[] = [];
    const errors: string[] = [];
    api.onFrame((f) => frames.push(f));
    api.onError((m) => errors.push(m));
    deliver(socket, { kind: 'transferProgress', text: 'x' });
    deliver(socket, { kind: 'transferDone', ok: false, error: 'host refused' });
    await Promise.resolve();
    // 1. Nothing leaked into a renderer kind. MEASURED: `dispatch('frame', msg)` and
    //    `dispatch('error', msg)` each redden this.
    expect(frames).toEqual([]);
    expect(errors).toEqual([]);
    // 2. WHAT THIS TEST CANNOT SEE, recorded because a mutation survived it rather than guessed
    //    at. MEASURED 2026-10-06: adding `dispatch(msg.kind, msg)` ALONGSIDE the real call leaves
    //    this file green. That mutant pushes every transfer message into the private queue under
    //    its own kind, where nothing ever claims it -- an unbounded growth over a session of
    //    progress messages. It is not observable through `BridgeApi`, because `onAtlas`/`onFrame`
    //    /`onError` are the only registrars and each hardcodes its kind, so no caller can ask the
    //    queue whether it holds a `transferProgress`. Exposing a registrar to test it would widen
    //    the four surfaces whose narrowness is the whole reason `renderer.ts` is shared, which is
    //    a worse trade than an uncovered mutant. The two assertions above DO catch the mutation a
    //    developer would plausibly write -- routing through an existing renderer kind.
  });

  it('reports an unexpected close through onError, so the canvas is not silently frozen', () => {
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    socket.onclose?.();
    expect(errors).toHaveLength(1);
  });
});

/**
 * ONE `await Promise.resolve()` IS ENOUGH HERE, AND IT WAS CHECKED RATHER THAN ASSUMED.
 *
 * `onmessage` starts an async chain (`await inflate(...)`), so a message is not dispatched in the
 * turn that delivered it, and a single microtask tick looks too thin to settle three of them. It is
 * sufficient, because these tests' `inflate` returns an already-resolved promise.
 *
 * The evidence is not that the assertions pass. They would pass either way: a message dispatched
 * LATE still reaches a handler registered EARLY, and the totals come out the same. It is that the
 * mutations are CAUGHT -- dropping unclaimed messages and reversing the flush order each redden the
 * queueing test -- which is what proves the tick lands between arrival and registration.
 * (A `setTimeout` macrotask drain was measured too and catches the same mutations, so this is a
 * question of which is sufficient, not of which is correct.)
 */

describe('socketUrl, which a reverse proxy breaks if it is built from the host', () => {
  it('resolves relatively, so a path prefix survives', () => {
    // MEASURED 2026-10-07 on the Rubin Science Platform's JupyterLab `/proxy/<port>/` route.
    // Served under that prefix, the old `${proto}//${location.host}/ws` sent the socket to the
    // PLATFORM's root: all eighteen modules loaded with HTTP 200, the socket went to
    // `wss://host/ws`, and the canvas stayed black and unresponsive with nothing in the console --
    // because no atlas and no frame ever arrived.
    expect(socketUrl('https://usdf-rsp.slac.stanford.edu/nb/user/athor/proxy/8017/'))
      .toBe('wss://usdf-rsp.slac.stanford.edu/nb/user/athor/proxy/8017/ws');
  });

  it('is unchanged at the root, which is how every harness and local run serves it', () => {
    expect(socketUrl('http://127.0.0.1:8017/')).toBe('ws://127.0.0.1:8017/ws');
  });

  it('resolves against the DIRECTORY when the document names a file', () => {
    // `new URL('ws', '.../8017/index.html')` drops the filename, which is the behaviour wanted:
    // the socket belongs beside the document, not beside its name.
    expect(socketUrl('https://host/a/b/index.html')).toBe('wss://host/a/b/ws');
  });

  it('swaps the scheme ITSELF, because `new URL` keeps the document`s', () => {
    // The property `bridge.ts` claims -- a TLS gateway gets `wss:` with no flag -- depends on
    // this line rather than on `URL`, which would hand back `https:`.
    expect(socketUrl('https://host/').startsWith('wss://')).toBe(true);
    expect(socketUrl('http://host/').startsWith('ws://')).toBe(true);
  });

  it('keeps a non-default port, which a prefixed deployment usually has', () => {
    expect(socketUrl('http://127.0.0.1:9999/x/')).toBe('ws://127.0.0.1:9999/x/ws');
  });
});
