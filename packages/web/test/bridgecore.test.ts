import { describe, it, expect, vi } from 'vitest';
import { createBridge } from '../src/bridgecore.js';

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
