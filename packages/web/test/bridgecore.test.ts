import { describe, it, expect, vi } from 'vitest';
import { createBridge, socketUrl, writeClipboard } from '../src/bridgecore.js';

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

/**
 * DRAIN EVERY MESSAGE DELIVERED SO FAR: one macrotask, after which the chained `onmessage` has
 * handled them all. See the note at the end of this file for why a single microtask stopped being
 * enough on 2026-11-02.
 */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

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
    await settle();
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
    await settle();

    const atlases: unknown[] = [];
    const frames: unknown[] = [];
    api.onAtlas((a) => atlases.push(a));
    api.onFrame((f) => frames.push(f));
    await settle();

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
    await settle();
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

  it('INTERCEPTS geometryMenu: calls the local handler, never sends it', () => {
    // `Alt-M`, 2026-11-04. The model/oversize picker is a DOM overlay in this front end, so opening
    // it is a local display decision -- and the choice it makes travels later as its own message,
    // not as this action. Both halves asserted, the second being the one that matters: `applyAction`
    // THROWS on this kind outside any try in the gateway's socket handler.
    const socket = fakeSocket();
    let opened = 0;
    const api = createBridge({
      socket: socket as never,
      storage: fakeStorage() as never,
      inflate: async (d) => String(d),
      toggleGeometry: () => { opened += 1; },
    });
    socket.onopen?.();
    const before = socket.sent.length;
    api.sendAction({ kind: 'geometryMenu' });
    expect(opened).toBe(1);
    expect(socket.sent.slice(before)).toHaveLength(0);
    expect(socket.sent.filter((s) => s.includes('geometryMenu'))).toHaveLength(0);
  });

  it('DROPS geometryMenu when no handler is given, rather than sending it', () => {
    // The same bargain `toggleKeypad` makes: a caller with no DOM has no picker to show, and falling
    // through to the socket would hand the gateway an action `applyAction` throws on.
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    socket.onopen?.();
    const before = socket.sent.length;
    api.sendAction({ kind: 'geometryMenu' });
    expect(socket.sent.slice(before)).toHaveLength(0);
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
     * nothing-in-any-console traps recorded for this renderer, which `bridgecore.ts`'s header
     * lists under *THE QUEUE IS NOT DEFENSIVE CODING*. BY NAME AND NOT BY LINE RANGE: the
     * `:8-14` this cited was correct when written and was broken by an insertion ABOVE it one
     * commit later, which is the second time a range in this file rotted that fast.
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
    await settle();
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
     *
     * SINCE 2026-11-02 THE `errors` ASSERTION CATCHES IT FIRST: `onmessage`'s chain now has a
     * `catch` that reports through `onError`, so that mutant reddens `errors` rather than escaping.
     * The listener stays, because deleting that `catch` would put this case back where it was.
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
    await settle();
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

  it("hands copyText to onCopyText, which is the operator's own clipboard", async () => {
    /**
     * THE RECEIVING HALF OF `copy`. The gateway intercepts the action, extracts the rectangle and
     * replies with `copyText` -- see `main.ts`'s `copy` intercept, cited by name because a line
     * range here went stale within one commit of being written, and `protocol.ts`'s `copyText`
     * member for why only that side can extract. Without this branch the reply is dropped by an
     * `onmessage` chain that returns on each kind it knows and then falls off the end: no
     * `else`, no throw, no log. The operator would press copy, see the gateway log that it sent the text,
     * and find their clipboard unchanged with nothing in any console -- the shape of the traps
     * `bridgecore.ts`'s header lists under *THE QUEUE IS NOT DEFENSIVE CODING*.
     *
     * THE SECOND PAIR OF ASSERTIONS IS NOT CEREMONY: this kind must NOT go through `dispatch`, for
     * the reason `onTransfer` gives. Routing it through a renderer kind would hand `renderer.js` a
     * payload it has no case for, and routing it under its own kind would park it in the private
     * queue forever, since `onAtlas`/`onFrame`/`onError` are the only registrars.
     */
    const socket = fakeSocket();
    const got: string[] = [];
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
      onCopyText: (t) => { got.push(t); },
    });
    const frames: unknown[] = [];
    const errors: string[] = [];
    api.onFrame((f) => frames.push(f));
    api.onError((m) => errors.push(m));
    deliver(socket, { kind: 'copyText', text: 'ROW ONE\nROW TWO' });
    await settle();
    // THE TEXT ITSELF, newlines intact: a copied rectangle is usually several rows, and the row
    // separator is what makes it pasteable anywhere else.
    expect(got).toEqual(['ROW ONE\nROW TWO']);
    expect(frames).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('DROPS copyText when no handler is given, rather than throwing', async () => {
    /**
     * `onCopyText` is optional on the deps for exactly the reason `toggleKeypad` and `onTransfer`
     * are: the gateway's own tests and any caller with no DOM must be able to construct a bridge
     * without one. `integration.test.ts` builds no bridge at all, and a headless client would.
     *
     * THE REJECTION LISTENER IS WHY THIS TEST IS WORTH ANYTHING, and it is here because a mutation
     * survived the `onTransfer` version of this case without one (recorded above at length). The
     * throw a non-optional `deps.onCopyText(...)` would produce happens inside `onmessage`'s async
     * IIFE, which nothing awaits, so it became an UNHANDLED REJECTION that vitest does not fail
     * the test on. Since 2026-11-02 that chain's `catch` reports it through `onError`, so `errors`
     * catches it too; the listener stays for the day that `catch` is removed.
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
    deliver(socket, { kind: 'copyText', text: 'HELLO' });
    // A MACROTASK, not `await Promise.resolve()`: a rejection is reported at the end of the
    // microtask queue, so the microtask tick the other cases use lands too early to see one.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    process.off('unhandledRejection', onRejection);
    expect(seen, 'an absent onCopyText must be inert, not a rejected promise').toEqual([]);
    expect(errors).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  it('hands onCopyText a REPORT that goes to onCopyFailed, NOT onError, so the selection survives', async () => {
    /**
     * THE LIVE PASS OF 2026-10-27 FOUND THE SILENCE. On a LAN address over plain `http` the browser
     * has no clipboard API, `writeClipboard` warned to `console.warn` alone, and the gateway's own
     * `copy: 28 chars` read as success -- so the operator's copy did nothing, visibly to nobody.
     *
     * AND 2026-11-03 FOUND THE CHANNEL WAS WRONG. The report used to be `dispatch('error')`, and
     * `renderer.ts`'s `onError` clears the selection and its prefetched text -- so the documented
     * remedy, pressing copy again once the prefetch has answered, found nothing selected. It now
     * goes to `onCopyFailed`, which the renderer paints as a notice that keeps the selection. The
     * negative half is the point: an `onError` that also saw it would still clear the selection.
     */
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
      onCopyText: (_t, report) => { report('copy failed: because'); },
    });
    const errors: string[] = [];
    const notices: string[] = [];
    api.onError((m) => errors.push(m));
    api.onCopyFailed?.((m) => notices.push(m));
    deliver(socket, { kind: 'copyText', text: 'HELLO' });
    await settle();
    expect(notices).toEqual(['copy failed: because']);
    expect(errors, 'a copy report must not reach onError, which clears the selection').toEqual([]);
  });

  it('falls back to onError when no onCopyFailed is registered, so the report is never lost', async () => {
    /**
     * A RENDERER THAT NEVER REGISTERS `onCopyFailed` -- an older build, any third client -- must
     * still see the failure painted. `error` is queued, so even an `onError` registered after the
     * report arrives receives it; registered here before, which is the renderer's real order.
     */
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
      onCopyText: (_t, report) => { report('copy failed: because'); },
    });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    deliver(socket, { kind: 'copyText', text: 'HELLO' });
    await settle();
    expect(errors).toEqual(['copy failed: because']);
  });

  it('REPORTS a message it cannot read, rather than dropping it as an unhandled rejection', async () => {
    /**
     * `onmessage` runs an async chain nothing awaits, so before 2026-11-02 a throw anywhere in it
     * -- `inflate`, `JSON.parse`, a coercion -- became an unhandled rejection: nothing on the
     * canvas and, as the live pass found, nothing the operator noticed in the console either.
     * Asserted through the rejection listener, for the reason the copyText absence case gives.
     */
    const seen: unknown[] = [];
    const onRejection = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', onRejection);
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never,
      inflate: async () => { throw new Error('bad deflate stream'); },
    });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    socket.onmessage?.({ data: 'whatever' });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    process.off('unhandledRejection', onRejection);
    expect(seen, 'a failed message must be reported, not left as a rejected promise').toEqual([]);
    expect(errors).toHaveLength(1);
    // The cause itself, so the line on the canvas says WHAT broke and not merely that something did.
    expect(errors[0]).toMatch(/bad deflate stream/);
  });

  it('fetchSelection sends the rect with a seq and resolves on the matching answer', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const rect = { top: 0, left: 0, bottom: 1, right: 11 };
    const got = api.fetchSelection!(rect);
    const sent = JSON.parse(socket.sent[0]!) as { kind: string; seq: number; rect: unknown };
    expect(sent.kind).toBe('selection');
    expect(sent.rect).toEqual(rect);
    // What `decodeClientMessage` demands, or the gateway answers `error` and this never settles.
    expect(Number.isSafeInteger(sent.seq) && sent.seq >= 0).toBe(true);
    deliver(socket, { kind: 'selectionText', seq: sent.seq, text: 'HELLO' });
    await expect(got).resolves.toBe('HELLO');
  });

  // A NEWER REQUEST SUPERSEDES AN OLDER ONE, so two are never live at once. The seq match is what
  // still matters: the OLD request's answer, arriving first, must not resolve the new one.
  it('supersedes an older fetch, and its late answer cannot resolve the newer one', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    const a = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 });
    const b = api.fetchSelection!({ top: 1, left: 0, bottom: 1, right: 1 });
    await expect(a).rejects.toThrow(/superseded/);
    const [sa, sb] = socket.sent.map((s) => (JSON.parse(s) as { seq: number }).seq);
    expect(sa).not.toBe(sb);
    deliver(socket, { kind: 'selectionText', seq: sa, text: 'A' });
    deliver(socket, { kind: 'selectionText', seq: sb, text: 'B' });
    await expect(b).resolves.toBe('B');
    // The late 'A' was dropped harmlessly: nothing painted, nothing thrown into the chain.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(errors).toEqual([]);
  });

  it('drops an answer nobody asked for, and sends it to no renderer handler', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const errors: string[] = [];
    const frames: unknown[] = [];
    api.onError((m) => errors.push(m));
    api.onFrame((f) => frames.push(f));
    deliver(socket, { kind: 'selectionText', seq: 999, text: 'NOBODY' });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(errors).toEqual([]);
    expect(frames).toEqual([]);
  });

  // A MALFORMED ANSWER TO A REAL WAITER REJECTS IT rather than being dropped: dropping would leave
  // that promise pending for the life of the page, the one outcome the cache cannot recover from.
  it('rejects, rather than strands, a waiter whose answer has no string text', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    const got = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 });
    const { seq } = JSON.parse(socket.sent[0]!) as { seq: number };
    deliver(socket, { kind: 'selectionText', seq, text: 42 });
    await expect(got).rejects.toThrow(/text/);
    // A failed PREFETCH never paints over the 3270 screen; the copy's fallback does its own reporting.
    expect(errors).toEqual([]);
  });

  // A CLOSE REJECTS WHAT IS PENDING, so a prefetch never waits forever on a dead socket. The
  // caller (`renderer.ts`) catches, and the cache stays empty, so every gesture falls back.
  it('rejects pending fetches when the socket closes', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const got = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 });
    socket.onclose?.();
    await expect(got).rejects.toThrow(/closed/);
  });

  // A real `WebSocket.send` SILENTLY DISCARDS after close, so a fetch sent then would be answered by
  // nobody, and the close that rejects pending fetches has already run.
  it('rejects a fetch made AFTER the socket closed, which nothing would ever answer', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    socket.onclose?.();
    errors.length = 0;   // the CLOSE itself is reported, and is the next test's business
    await expect(api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 })).rejects.toThrow(/closed/);
    expect(socket.sent).toEqual([]);
    // A failed PREFETCH never paints over the 3270 screen.
    expect(errors).toEqual([]);
  });

  // ...and THROWS `InvalidStateError` while CONNECTING. That must arrive as a rejection the caller's
  // `.catch` sees, not as a synchronous throw out of a mouseup handler.
  it('turns a send that throws (a socket still CONNECTING) into a rejection', async () => {
    const socket = fakeSocket();
    socket.send = () => { throw new Error('InvalidStateError: still CONNECTING'); };
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    let got: Promise<string> | undefined;
    expect(() => { got = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 }); }).not.toThrow();
    await expect(got).rejects.toThrow(/CONNECTING/);
  });

  // INBOUND MESSAGES ARE HANDLED IN ARRIVAL ORDER, however long each takes to inflate. Without that,
  // a slow `frame` could be painted after a fast `selectionText` that followed it -- which is the
  // order the fetch-ahead design's stale-answer argument depends on -- or an older screen last.
  it('handles messages in ARRIVAL order even when the first inflates slower', async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never,
      inflate: async (d) => {
        calls += 1;
        if (calls === 1) await firstDone;
        return String(d);
      },
    });
    const order: string[] = [];
    api.onFrame(() => order.push('frame'));
    const got = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 });
    void got.then(() => order.push('answer'));
    const { seq } = JSON.parse(socket.sent[0]!) as { seq: number };
    deliver(socket, { kind: 'frame', list: { width: 1, height: 1, cells: [] } });
    deliver(socket, { kind: 'selectionText', seq, text: 'X' });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    releaseFirst();
    await got;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(order).toEqual(['frame', 'answer']);
  });

  it('keeps handling messages after one that cannot be read', async () => {
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    const errors: string[] = [];
    const frames: unknown[] = [];
    api.onError((m) => errors.push(m));
    api.onFrame((f) => frames.push(f));
    socket.onmessage?.({ data: 'not json' });
    deliver(socket, { kind: 'frame', list: { width: 1, height: 1, cells: [] } });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(errors).toHaveLength(1);
    expect(frames).toHaveLength(1);
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
 * `settle()` IS A MACROTASK, AND A SINGLE MICROTASK STOPPED BEING ENOUGH ON 2026-11-02.
 *
 * Until then each message started its own async chain, and one `await Promise.resolve()` settled
 * it because these tests' `inflate` returns an already-resolved promise. Since messages became ONE
 * chain (each `.then` on the one before, so they are handled in arrival order), every message costs
 * extra ticks for its link, so six of these tests reddened with nothing else changed. The
 * `setTimeout` drain was measured alongside the single tick when it was chosen and caught the
 * same mutations, so this is a switch to the other sufficient wait, not a new one.
 *
 * The evidence is not that the assertions pass. They would pass either way: a message dispatched
 * LATE still reaches a handler registered EARLY, and the totals come out the same. It is that the
 * mutations are CAUGHT -- dropping unclaimed messages and reversing the flush order each redden the
 * queueing test -- which is what proves the drain lands between arrival and registration.
 * Re-measured with `settle()` on 2026-11-02.
 */

describe('writeClipboard, whose COMMON case is the browser having no clipboard at all', () => {
  /**
   * THE ROUTE AT RISK OF ROTTING IS THE ONE THAT RUNS IN PRODUCTION, which is why this function
   * takes the clipboard as a parameter instead of reading `navigator` where it is used.
   *
   * `navigator.clipboard` is secure-context-only and a LAN gateway on plain `http` has no secure
   * context, so `undefined` is the COMMON case here -- the same situation `transferBridge.ts`
   * records for `showSaveFilePicker`, with the same structural lesson: a developer on
   * Chrome-over-localhost always gets the API, so nothing but an injected `undefined` exercises
   * the other branch. It is worse than that here, because `lib.dom` types `Navigator.clipboard`
   * as non-optional: inlined in `bridge.ts` the guard's body narrowed to `never`, making the
   * likeliest production path look like dead code to anyone cleaning up.
   *
   * THESE CASES ARE THE SECOND LINE OF DEFENSE, NOT THE FIRST, AND THAT IS WORTH KNOWING WHEN
   * READING THEM. Since the capability became a `ClipboardWriter | undefined` PARAMETER, the
   * compiler owns the guard: measured 2026-10-26, deleting it fails the build with
   * `TS18048: 'clip' is possibly 'undefined'`. So what the no-API case below adds is the
   * BEHAVIOR -- that the absence warns, names the secure context, and does not throw -- which no
   * compiler can check and which `vitest` alone would not catch either, since it does not
   * typecheck.
   */
  it('writes the text when the browser has a clipboard', async () => {
    const wrote: string[] = [];
    const warned: string[] = [];
    writeClipboard({ writeText: async (t) => { wrote.push(t); } }, 'ROW ONE\nROW TWO',
      (m) => { warned.push(m); });
    await Promise.resolve();
    expect(wrote).toEqual(['ROW ONE\nROW TWO']);
    // Nothing is reported on the happy path: a warning here would train the operator to ignore
    // the one that means their copy did not land.
    expect(warned).toEqual([]);
  });

  it('WARNS rather than throwing when there is no clipboard API, naming the cause', () => {
    // NOT a throw: this runs from the bridge's own socket message handler, whose `catch` would
    // report it as an unreadable gateway message -- the wrong diagnosis. And the absence is
    // EXPECTED on a LAN gateway, so it must read as a cause and not as a bug.
    const warned: string[] = [];
    expect(() => { writeClipboard(undefined, 'TEXT', (m) => { warned.push(m); }); }).not.toThrow();
    expect(warned).toHaveLength(1);
    // THE REMEDY, NOT JUST THE SYMPTOM, AND FIRST. "no clipboard API" alone sent the reader to the
    // wrong place -- the browser, rather than the ADDRESS that actually explains it: `localhost` is a
    // secure context even over `http`, a LAN address is not. Remedy-first because this is now
    // painted on the canvas, where the start of a message is the part that is read.
    expect(warned[0]).toMatch(/^copy failed: use https \(--tls-cert\) or localhost/);
    expect(warned[0]).toMatch(/secure context/);
  });

  it('CATCHES a refused clipboard, so a rejection never escapes unhandled', async () => {
    /**
     * `void clip.writeText(...)` IS THE BREAK THIS CASE EXISTS FOR. `void` on a rejecting promise
     * is what CREATES an unhandled rejection -- measured on this project's transfer window -- and
     * the browser refuses this call routinely: permission denied, or a document that is not
     * focused. The rejection is asserted ABSENT through a listener rather than inferred from the
     * warning, because the `onTransfer` case above records a mutation that survived exactly that
     * inference: a throw inside an un-awaited async chain is invisible to vitest's assertions.
     */
    const seen: unknown[] = [];
    const onRejection = (e: unknown): void => { seen.push(e); };
    process.on('unhandledRejection', onRejection);
    const warned: string[] = [];
    writeClipboard(
      { writeText: async () => { throw new Error('NotAllowedError'); } },
      'TEXT',
      (m) => { warned.push(m); },
    );
    // A MACROTASK, for the reason the `onTransfer` absence case gives: a rejection is reported at
    // the end of the microtask queue, so a single microtask tick lands too early to see one.
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    process.off('unhandledRejection', onRejection);
    expect(seen, 'a refused clipboard must be reported, not left as a rejected promise').toEqual([]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/refused/);
    // The error itself reaches the message, so a console reader can tell a permission denial from
    // an unfocused document without guessing.
    expect(warned[0]).toMatch(/NotAllowedError/);
  });
});

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

/**
 * `-oversize auto`'s half in the browser (2026-11-04): the viewport, in CSS pixels, rides in
 * `hello` and again, debounced, on every resize -- the gateway converts it to cells and keeps the
 * latest per session, so a reconnect measures the window as it is then.
 */
describe('the viewport, for -oversize auto', () => {
  const resizable = () => {
    let fire: (() => void) | undefined;
    return { onResize: (fn: () => void) => { fire = fn; }, resize: () => { fire?.(); } };
  };

  it('puts the viewport in hello when the client has one', () => {
    const socket = fakeSocket();
    createBridge({
      socket: socket as never, storage: fakeStorage('kept-id') as never, inflate: async (d) => String(d),
      viewport: () => ({ width: 1350, height: 980 }),
    });
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!))
      .toEqual({ kind: 'hello', sessionId: 'kept-id', viewport: { width: 1350, height: 980 } });
  });

  it('reads the viewport WHEN the socket opens, not when the bridge is built', () => {
    const socket = fakeSocket();
    let size = { width: 100, height: 100 };
    createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
      viewport: () => size,
    });
    size = { width: 1350, height: 980 };
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello', viewport: { width: 1350, height: 980 } });
  });

  it('sends ONE viewport message per burst of resizes, 250 ms after the last', () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const r = resizable();
      let size = { width: 1350, height: 980 };
      createBridge({
        socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
        viewport: () => size, onResize: r.onResize,
      });
      socket.onopen?.();
      socket.sent.length = 0;
      r.resize();
      vi.advanceTimersByTime(200);
      size = { width: 900, height: 700 };
      r.resize();
      vi.advanceTimersByTime(249);
      expect(socket.sent).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(socket.sent.map((t) => JSON.parse(t)))
        .toEqual([{ kind: 'viewport', width: 900, height: 700 }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing for a resize before the socket opened or after it closed', () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const r = resizable();
      createBridge({
        socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
        viewport: () => ({ width: 800, height: 600 }), onResize: r.onResize,
      });
      // Before open: a real `WebSocket.send` THROWS while CONNECTING, and `hello` will carry the
      // size read at open anyway.
      r.resize();
      vi.advanceTimersByTime(250);
      expect(socket.sent).toEqual([]);
      socket.onopen?.();
      socket.sent.length = 0;
      // A resize whose timer is still pending when the socket closes, and one after it.
      r.resize();
      socket.onclose?.();
      r.resize();
      vi.advanceTimersByTime(1000);
      expect(socket.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('LEAVES OUT a viewport the gateway would refuse, rather than lose the whole hello', () => {
    // `checkViewport` refuses 0, and a refused hello gets an error and no session at all.
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const r = resizable();
      createBridge({
        socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
        viewport: () => ({ width: 0, height: 0 }), onResize: r.onResize,
      });
      socket.onopen?.();
      expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello' });
      r.resize();
      vi.advanceTimersByTime(1000);
      expect(socket.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with no viewport dep: hello is unchanged and a resize sends nothing', () => {
    vi.useFakeTimers();
    try {
      const socket = fakeSocket();
      const r = resizable();
      createBridge({
        socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
        onResize: r.onResize,
      });
      socket.onopen?.();
      expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello' });
      r.resize();
      vi.advanceTimersByTime(1000);
      expect(socket.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
