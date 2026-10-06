import { describe, it, expect, afterEach, vi } from 'vitest';
import { inflateSync } from 'node:zlib';
import { connect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/main.js';
import { parseWebArgs } from '../src/args.js';
// The `Action`-union scan MOVED to `frontend/test/helpers/actionKinds.ts` when
// `frontend/test/actions.test.ts` grew its dispatch table and needed the identical list. It is
// shared rather than copied because the bounding of that regex to the union's own declaration is
// what makes it trustworthy, and a second copy could lose it and still pass. This package already
// depends on `@tn3270/frontend`, and `cli/test/tls.test.ts:8` is the precedent for a test reaching
// into a sibling package.
import { actionKinds, ACTION_KIND_FLOOR, ACTION_KIND_CANARIES }
  from '../../frontend/test/helpers/actionKinds.js';

/**
 * THE WHOLE GATEWAY, DRIVEN BY NODE'S BUILT-IN WebSocket.
 *
 * This is the important test in the package. The framing is hand-rolled, so testing it only
 * against our own client would be self-consistent and prove nothing; Node's built-in WebSocket is
 * an INDEPENDENT implementation and is therefore an oracle. If our handshake or framing is subtly
 * wrong, this is what says so.
 *
 * Hostless: `--replay` paints a recorded trace, so no socket is opened to any mainframe and no
 * credential can appear.
 */
const trace = join(process.cwd(), 'packages/fixtures/traces/synthetic-ispf-like.trace');

/**
 * As much of a `DrawList` as the keypad cases read, spelled out rather than imported.
 *
 * These messages have been through `JSON.stringify` and `inflateSync`, so they are plain data and
 * NOT a `DrawList` -- `coverage` arrives as base64 in the atlas message for exactly that reason.
 * The optional `keypad` mirrors `canvas/src/drawlist.ts:77`.
 *
 * `keypad.height` is deliberately ABSENT: the assertions below measure the region against the
 * buttons that occupy it instead, so declaring the field would invite exactly the tautology they
 * were written to avoid.
 */
type FrameList = {
  readonly height: number;
  readonly keypad?: {
    readonly y: number;
    readonly buttons: ReadonlyArray<{ readonly y: number; readonly h: number }>;
  };
};
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

/** Start on an ephemeral port and return its URL and token. */
async function start(extra: string[] = []): Promise<{ url: string; token: string; port: number }> {
  // `--auth on` EXPLICITLY, because the default is now OFF and these tests are about the
  // authenticated path. Relying on the default would have made every one of them silently stop
  // exercising the token the moment that default changed -- which is exactly what happened: the
  // "refuses the upgrade without a token" case went green-to-red on the flip, because with no token
  // required there was nothing to refuse. The unauthenticated default has its own test below.
  const args = parseWebArgs(['--replay', trace, '--listen', '0', '--auth', 'on', ...extra,
    '127.0.0.1:3270']);
  const { server, registry } = buildServer(args);
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const port = (server.address() as { port: number }).port;
  stop = () => { registry.closeAll(); server.close(); };
  return { url: `ws://127.0.0.1:${port}/ws?t=${args.token}`, token: args.token, port };
}

/**
 * The fields a kind cannot travel without. Anything absent here is sent bare.
 *
 * `pf`/`pa` carry a number `decodeClientMessage` bounds against core's AID tables, and `type`
 * carries text. A NEW kind with a required field and no entry here still gets sent bare, and that is
 * deliberate: the test then asserts the gateway answers a malformed action rather than dying on it,
 * which is a property worth having too.
 */
const ACTION_FIELDS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  pf: { n: 1 },
  pa: { n: 1 },
  type: { text: 'a' },
};

/**
 * Kinds the GATEWAY must refuse outright, rather than answer.
 *
 * An expected-refusal list and NOT an exemption list: a kind named here must still produce an
 * `error` naming it, so a rejection that silently stopped happening still fails. The bar for a
 * member is high -- see `protocol.ts`'s two-branch rule. A front end action that is the SENDER's own
 * business, like `toggleKeypad`, belongs in `main.ts` as an interception and must be answered here,
 * not added to this list.
 *
 * TWO MEMBERS NOW, since `transferForm` left on 2026-10-06 when socket-carried file I/O landed.
 * It was refused because a browser-initiated transfer would have moved bytes between the host and
 * the GATEWAY's filesystem rather than the operator's machine -- and the bytes now cross the
 * WebSocket as `transferChunk` and `transferData`, so that reason is gone. It moved where this
 * docblock always said it would: OUT of this list and INTO an interception in `main.ts`, which
 * means it is a member of `SWALLOWED` below rather than merely deleted from here. It is still
 * reachable from a CLICK, not just a hand-built frame, because `KEYPAD_KEYS` carries an `Xfer`
 * button and `canvas/src/keys.ts` maps Ctrl-T.
 *
 * `quit` would stop the gateway, and that reason does not expire.
 *
 * `copy` IS THE OTHER, added 2026-10-05 with the Electron GUI's clipboard, and it is refused for
 * the same shape of reason `transferForm` was: WHOSE MACHINE the result lands on. Electron's main
 * extracts the text and writes an OS clipboard the operator owns; the gateway's "main" is the
 * SERVER, so it would extract onto its own machine. The feature's spec claimed the gateway got copy
 * "free" because `sendAction` already crosses the socket -- THIS TEST IS WHAT DISPROVED IT, by
 * reporting `no reply to the copy action` over an uncaught `applyAction does not handle copy`.
 * Returning the text needs a server->client message that still does not exist: `ServerMessage`
 * gained three transfer members on 2026-10-06 and so is no longer `frame | error`, but none of them
 * carries clipboard text, and the bridge has no clipboard write either. It is reachable from a
 * gesture too, since the browser runs the same `renderer.ts`.
 *
 * `copy` LEAVES THIS LIST BEFORE PACKAGING -- the user committed to web copy/paste on 2026-10-05,
 * with its own spec. When it lands, this list should be back to one member. The transfer half of
 * that commitment is what this change was, and it is the worked example of how the move goes.
 *
 * THE MESSAGE CHECK BELOW IS `toContain(kind)` AND THAT IS ALL IT IS. It cannot tell the current
 * refusal from the superseded one, both of which name the kind; `protocol.test.ts` pins the REASON,
 * which is the half that went stale here.
 */
const REFUSED: readonly string[] = ['quit', 'copy'];

/**
 * Kinds the gateway accepts and answers with SILENCE, which is a third category this loop needed.
 *
 * `toggleKeypad` was the only member until `transferForm` JOINED IT on 2026-10-06, moving here out
 * of `REFUSED` above. Neither is refused and neither is applied.
 *
 * THE TWO ARE SWALLOWED FOR DIFFERENT REASONS, AND THE DIFFERENCE IS NOT COSMETIC. `toggleKeypad`
 * is a browser-side DOM overlay, so `bridgecore.ts` intercepts it client-side (`:150`) and should
 * never cross the socket at all; `main.ts`'s `return` is only for clients that send it anyway --
 * which is exactly this test, since it builds raw frames rather than running the served bridge.
 * `transferForm` has NO client-side interception yet: `bridgecore.ts` contains no `transferForm`
 * at all as of 2026-10-06, so the action DOES cross the socket and `main.ts`'s `return` is the
 * only thing standing between it and `applyAction`'s throw. Task 8 of the transfer plan is what
 * gives the browser its own dialog; until then this entry is load-bearing for real clients, not
 * just for hand-built frames.
 *
 * `transferForm` EARNS ITS PLACE HERE BY THE SAME RULE `toggleKeypad` DOES, which is the half worth
 * stating: `applyAction` still THROWS on it, so `protocol.ts` accepting the kind would have ended
 * the gateway process without the `main.ts` interception that landed with it. That is `protocol.ts`'s
 * two-branch rule -- a rejection OR an interception, never neither -- taking its other branch.
 * MEASURED 2026-10-06: with the interception removed this case reports `no reply to the
 * transferForm action` over an uncaught `applyAction does not handle transferForm`.
 *
 * IT USED TO ANSWER WITH A FRAME, because the keypad was a region of the draw list and flipping a
 * `showKeypad` flag owed a repaint. There is no flag and no repaint now, so a frame here would
 * mean the gateway had taken on work it should not have.
 *
 * A MEMBER OF THIS LIST IS STILL FULLY TESTED, which is what keeps it from being an exemption: the
 * `tab` sent after every kind must still come back as a frame, and that is the assertion that
 * `applyAction` was never reached -- the throw would have taken the socket handler with it.
 */
const SWALLOWED: readonly string[] = ['toggleKeypad', 'transferForm'];

/**
 * One socket, read as a queue: `next` takes messages in order, `settle` waits for the flow to stop
 * and discards whatever is left.
 *
 * `collect(ws, n)` cannot serve the loop below, because it needs an exact count per send and a kind
 * that produced two frames -- a local action that also emitted `screen` -- would desynchronise every
 * later step and be reported against the wrong kind.
 */
function reader(ws: WebSocket): {
  next(what: string): Promise<Record<string, unknown>>;
  settle(): Promise<void>;
} {
  const got: Array<Record<string, unknown>> = [];
  let last = Date.now();
  let read = 0;
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (e) => {
    got.push(JSON.parse(inflateSync(Buffer.from(e.data as ArrayBuffer)).toString()) as Record<string, unknown>);
    last = Date.now();
  });
  return {
    async next(what: string): Promise<Record<string, unknown>> {
      // 2s, DELIBERATELY UNDER vitest's 5s per-test timeout, so a kind that hangs fails with
      // `no reply to the sysreq action` and names itself. MEASURED against a temporary throwing
      // guard in `applyAction`: with a deadline above the test timeout, vitest's anonymous
      // `Test timed out in 5000ms` won the race and left the next reader to bisect 24 kinds. The
      // caller raises the TEST timeout to match, since one hang must not starve the kinds after it.
      const deadline = Date.now() + 2000;
      while (read >= got.length) {
        if (Date.now() > deadline) throw new Error(`no reply to ${what}`);
        await new Promise((r) => { setTimeout(r, 5); });
      }
      read += 1;
      return got[read - 1]!;
    },
    async settle(): Promise<void> {
      // 25ms of quiet. Frames for one action are written synchronously inside the `data` handler, so
      // this is a boundary between sends and not a race with one: without it an extra frame would be
      // read as the answer to the NEXT thing sent.
      while (Date.now() - last < 25) await new Promise((r) => { setTimeout(r, 25); });
      read = got.length;
    },
  };
}

/** Collect inflated server messages until `want` of them have arrived. */
function collect(ws: WebSocket, want: number): Promise<Array<Record<string, unknown>>> {
  const got: Array<Record<string, unknown>> = [];
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`only ${got.length} of ${want} messages`)), 8000);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e) => {
      const text = inflateSync(Buffer.from(e.data as ArrayBuffer)).toString();
      got.push(JSON.parse(text) as Record<string, unknown>);
      if (got.length >= want) { clearTimeout(timer); resolveP(got); }
    });
  });
}

/**
 * A RAW upgrade, so two things Node's WebSocket client cannot reach are testable.
 *
 * Node's built-in client sends no `Origin` header and gives no way to add one, and it never writes
 * payload before the server's 101 -- so neither the `--allow-origin` wiring nor the `head` bytes of
 * an upgrade have any behavioral test without going down to a socket. Both were confirmed INERT to
 * mutation before this existed.
 *
 * Everything is written in ONE `socket.write`, deliberately: that is what puts the first frame in
 * Node's `head` argument, the bytes read off the socket BEFORE `Connection` attaches its listener.
 */
function rawUpgrade(opts: {
  port: number; token: string; origin?: string; body?: Buffer;
}): { socket: Socket; response: Promise<Buffer> } {
  const socket = connect(opts.port, '127.0.0.1');
  const chunks: Buffer[] = [];
  const response = new Promise<Buffer>((resolveP) => {
    socket.on('data', (b: Buffer) => {
      chunks.push(b);
      const all = Buffer.concat(chunks);
      // WHEN IS THE RESPONSE COMPLETE? It depends on whether a body was sent, and getting this
      // wrong hangs rather than fails: with no body the server answers only the ~130-byte 101 and
      // then waits for a `hello` that never comes, so a fixed byte threshold never trips.
      const headerDone = all.includes('\r\n\r\n');
      if (headerDone && (opts.body === undefined || all.length > 2000)) resolveP(all);
    });
    socket.on('close', () => resolveP(Buffer.concat(chunks)));
    socket.on('error', () => resolveP(Buffer.concat(chunks)));
  });
  const lines = [
    `GET /ws?t=${opts.token} HTTP/1.1`,
    `Host: 127.0.0.1:${opts.port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...(opts.origin !== undefined ? [`Origin: ${opts.origin}`] : []),
    '', '',
  ];
  socket.on('connect', () => {
    socket.write(Buffer.concat([
      Buffer.from(lines.join('\r\n')),
      ...(opts.body !== undefined ? [opts.body] : []),
    ]));
  });
  return { socket, response };
}

/** One masked client text frame, as a browser would send it. */
function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const key = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4]!;
  const head = Buffer.from([0x81, 0x80 | payload.length]);   // FIN + TEXT, masked, short length
  return Buffer.concat([head, key, masked]);
}

/** Inflate the server's binary frames out of a raw byte stream, after the HTTP response. */
function serverMessagesFrom(raw: Buffer): Array<Record<string, unknown>> {
  const split = raw.indexOf('\r\n\r\n');
  let buf = raw.subarray(split + 4);
  const out: Array<Record<string, unknown>> = [];
  while (buf.length >= 2) {
    let len = buf[1]! & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) break;
    out.push(JSON.parse(inflateSync(buf.subarray(off, off + len)).toString()) as Record<string, unknown>);
    buf = buf.subarray(off + len);
  }
  return out;
}

describe('the gateway end to end', () => {
  it('completes a handshake with a standards-compliant client and sends session, atlas, frame', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const messages = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    const got = await messages;
    expect(got.map((m) => m['kind'])).toEqual(['session', 'atlas', 'frame']);
    expect(typeof got[0]!['id']).toBe('string');
    expect(typeof got[1]!['coverage']).toBe('string');       // base64
    const list = got[2]!['list'] as { cells: unknown[] };
    expect(list.cells.length).toBeGreaterThan(100);          // the trace paints a real screen
    ws.close();
  });

  it('applies an action and sends a new frame', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;
    const next = collect(ws, 1);
    // `tab` moves the cursor with no host involved, so a replayed session can show it.
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
    expect((await next)[0]!['kind']).toBe('frame');
    ws.close();
  });

  it('applies actions to the SAME session, without creating one per keystroke', async () => {
    // WHAT THIS CATCHES, and nothing else here does: re-fetching the session per action with
    // `registry.attach(id)` looks like a cheap lookup and is not one. Its anti-hijacking rule
    // reattaches only a DETACHED entry, so an id that is currently attached falls through and BUILDS
    // A NEW SESSION -- a fresh connection to the mainframe on every keystroke, with the action
    // applied to a screen nobody is looking at.
    //
    // The `tab` test above cannot see it: the repaint closure holds the session from `hello`, so a
    // frame still arrives and the assertion still passes. `--max-sessions 1` is what makes the
    // second session impossible instead of merely wasteful, so the bug becomes an error rather than
    // a silent leak.
    const { url } = await start(['--max-sessions', '1']);
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;

    const got = collect(ws, 3);
    for (const kind of ['tab', 'tab', 'home']) {
      ws.send(JSON.stringify({ kind: 'action', action: { kind } }));
    }
    const frames = await got;
    expect(frames.map((m) => m['kind'])).toEqual(['frame', 'frame', 'frame']);
    ws.close();
  });

  it('reattaches the SAME session after a reconnect, and repaints', async () => {
    const { url } = await start();
    const a = new WebSocket(url);
    await new Promise((r) => a.addEventListener('open', r, { once: true }));
    const firstBatch = collect(a, 3);
    a.send(JSON.stringify({ kind: 'hello' }));
    const id = (await firstBatch)[0]!['id'] as string;
    a.close();

    const b = new WebSocket(url);
    await new Promise((r) => b.addEventListener('open', r, { once: true }));
    const second = collect(b, 2);
    b.send(JSON.stringify({ kind: 'hello', sessionId: id }));
    const got = await second;
    // No fresh `session` message, because nothing was created: atlas then frame.
    expect(got.map((m) => m['kind'])).toEqual(['atlas', 'frame']);
    b.close();
  });

  it('refuses the upgrade without a token', async () => {
    const { url } = await start();
    const bad = url.replace(/\?t=.*/, '');
    const ws = new WebSocket(bad);
    const err = await new Promise<string>((r) => {
      ws.addEventListener('error', () => r('error'), { once: true });
      ws.addEventListener('close', () => r('close'), { once: true });
    });
    expect(err).toMatch(/error|close/);
  });

  it('by DEFAULT needs no token, which is the flipped default paired with loopback', async () => {
    // Pins the new default from the OUTSIDE rather than trusting `args.auth === false`: a browser
    // reaching the default gateway must actually get a session with no token anywhere.
    //
    // Note what this does and does not say. It says a LOCAL operator is not asked for a token, which
    // is the intent. It says nothing about safety off the loopback interface -- there, `--auth on` is
    // required and `main.ts` warns on exactly that pair. The token protects ACCESS; `--tls-cert`
    // protects the traffic; neither substitutes for the other.
    const args = parseWebArgs(['--replay', trace, '--listen', '0', '127.0.0.1:3270']);
    expect(args.auth).toBe(false);
    const { server, registry } = buildServer(args);
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    const port = (server.address() as { port: number }).port;
    stop = () => { registry.closeAll(); server.close(); };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);       // no ?t= at all
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const messages = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    expect((await messages).map((m) => m['kind'])).toEqual(['session', 'atlas', 'frame']);
    ws.close();
  });

  it('takes its listeners OFF a session that outlives the socket, however often it reattaches', async () => {
    // THE LEAK THIS PINS. A gateway session outlives its socket by design so a reload reattaches, and
    // each attach registers three listeners. Without `Session.off` they accumulated: ten reconnects
    // left thirty, and every later screen change ran `drawList` and `deflateSync` thirty times --
    // twenty-nine for dead sockets that discard the result. Unbounded in reconnections, and
    // INVISIBLE, because the output stayed correct throughout. Wasted CPU is not something an
    // assertion can see, which is why `listenerCount` exists.
    //
    // `--grace 30` keeps the session alive across the loop; the registry hands back the same one.
    const args = parseWebArgs(['--replay', trace, '--listen', '0', '--auth', 'on', '--grace', '30',
      '127.0.0.1:3270']);
    const { server, registry } = buildServer(args);
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    const port = (server.address() as { port: number }).port;
    stop = () => { registry.closeAll(); server.close(); };
    const url = `ws://127.0.0.1:${port}/ws?t=${args.token}`;

    let id: string | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const ws = new WebSocket(url);
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      const want = collect(ws, id === undefined ? 3 : 2);
      ws.send(JSON.stringify(id === undefined ? { kind: 'hello' } : { kind: 'hello', sessionId: id }));
      const got = await want;
      id ??= got.find((m) => m['kind'] === 'session')?.['id'] as string;
      ws.close();
      // `peek`, NEVER `attach`. MEASURED: a version of this polled `attach` and passed with the leak
      // fully present, because `attach` on an ALREADY-ATTACHED id falls through and builds a fresh
      // session -- so the second poll read a brand-new object with zero listeners. `peek` observes
      // without changing attachment.
      for (let waited = 0; waited < 40; waited += 1) {
        await new Promise((r) => { setTimeout(r, 25); });
        if ((registry.peek(id)?.listenerCount('screen') ?? -1) === 0) break;
      }
      const session = registry.peek(id);
      expect(session, `session ${id} should still exist inside the grace window`).toBeDefined();
      for (const event of ['screen', 'connect', 'disconnect'] as const) {
        expect(session!.listenerCount(event), `${event} after close ${attempt + 1}`).toBe(0);
      }
    }
  });

  it('accepts a proxied browser Origin ONLY when --allow-origin names it', async () => {
    // Pins Task 4b's flag all the way through `main.ts`. Without the wiring, `checkUpgrade` is
    // called with an empty list and every browser behind a Host-rewriting proxy is refused -- which
    // is the entire failure that task exists to prevent, and it was INERT to mutation until now.
    const proxied = 'https://gw.example';
    const named = await start(['--allow-origin', proxied]);
    const accepted = rawUpgrade({ port: named.port, token: named.token, origin: proxied });
    expect((await accepted.response).toString('latin1')).toMatch(/^HTTP\/1\.1 101 /);
    accepted.socket.destroy();
    stop?.(); stop = undefined;

    const plain = await start();
    const refused = rawUpgrade({ port: plain.port, token: plain.token, origin: proxied });
    expect((await refused.response).toString('latin1')).toMatch(/403/);
    refused.socket.destroy();
  });

  it('does not lose a frame that arrives in the SAME packet as the upgrade', async () => {
    // Node hands those bytes over as `head`, already read off the socket before `Connection` can
    // listen. Dropping them loses the client's first message -- here the `hello` itself, so the
    // session never starts and the browser waits forever with no error. Also INERT to mutation
    // before this test, because no browser and no Node client writes before the 101.
    const { port, token } = await start();
    const { socket, response } = rawUpgrade({
      port, token, body: maskedTextFrame(JSON.stringify({ kind: 'hello' })),
    });
    const raw = await response;
    expect(raw.toString('latin1')).toMatch(/^HTTP\/1\.1 101 /);
    const messages = serverMessagesFrom(raw);
    expect(messages.map((m) => m['kind'])).toEqual(['session', 'atlas', 'frame']);
    socket.destroy();
  });

  it('compares the token ONLY through tokenMatches, on both routes', () => {
    // A SOURCE SCAN, because the property is invisible to behavior: a plain `!==` rejects exactly
    // the same tokens and every functional test passes either way (measured -- that mutation is
    // inert). What differs is timing, and `handshake.ts` exports `tokenMatches` precisely so the
    // asset route cannot leak by timing while the upgrade route is careful. The same instinct as
    // `renderer-imports.test.ts`, which scans built output for a property no assertion can see.
    const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/tokenMatches\(given, args\.token\)/);
    expect(source).not.toMatch(/given\s*[!=]==\s*args\.token/);
  });

  it('refuses a quit action rather than stopping the gateway', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;
    const next = collect(ws, 1);
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'quit' } }));
    const got = await next;
    expect(got[0]!['kind']).toBe('error');
    expect(String(got[0]!['message'])).toMatch(/quit/i);
    ws.close();
  });

  it('SWALLOWS toggleKeypad without throwing, and STAYS UP to serve the next action', async () => {
    // THE SAME HOLE AS `quit`, AND IT WAS LIVE. `applyAction` throws on `toggleKeypad`, `main.ts`
    // calls it outside any try, and that runs in a socket 'data' handler -- so while this kind was
    // reachable but unhandled, one frame from any client ended the gateway PROCESS and took every
    // other operator's session down with it. Task 2 stopped that with a rejection in
    // `decodeClientMessage`; this task replaced the rejection with real handling, so what closes the
    // hole now is the interception in `main.ts` that returns BEFORE `applyAction`.
    //
    // IT ANSWERS WITH SILENCE NOW, AND THAT IS THE 2026-10-06 CHANGE. This test used to assert a
    // FRAME came back, because the gateway flipped a `showKeypad` flag and repainted. The web
    // keypad is a browser-side DOM overlay now: the server holds no keypad state, owes no repaint,
    // and the interception is an empty `return` whose ONLY job is keeping the kind away from
    // `applyAction`. So a frame here would mean the gateway had taken on work it should not have.
    //
    // THE SURVIVAL HALF IS NOW THE WHOLE TEST, and it is unchanged in intent: sending a real
    // action afterwards and getting a frame back is what proves the process is still up. Asserting
    // the interception alone would pass against a gateway that swallowed the action and then died,
    // since silence is what both look like.
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;

    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));

    const after = collect(ws, 1);
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
    // `toBe('frame')`, not `toBeTypeOf('string')`: the loose form this replaces was satisfied by an
    // `error` message too, so it proved the socket was answering and nothing about the action.
    //
    // AND IT IS EXACTLY ONE REPLY, which is what makes the silence above an assertion rather than
    // an absence of one: `collect(ws, 1)` resolves on the FIRST message, so had the toggle also
    // produced a frame this would have read that one and the `tab` frame would be left unread --
    // passing for the wrong reason. The count is the pin.
    expect((await after)[0]!['kind']).toBe('frame');
    ws.close();
  });

  it('accounts for EVERY kind in the Action union, and stays up after each one', async () => {
    /**
     * THE CLASS, NOT THE INSTANCE. `protocol.ts`'s second rule says a kind `applyAction` throws on
     * must grow either a rejection there or an interception in `main.ts` -- and until this test that
     * rule was PROSE WITH NO ENFORCEMENT. `toggleKeypad` spent a commit in the forbidden "neither"
     * state for exactly that reason: one 48-byte frame from any client ended the gateway process and
     * every other operator's session with it, and the whole suite stayed green. Nothing mechanical
     * could have caught it -- `applyAction`'s `satisfies never` proves exhaustiveness in `frontend`
     * and nothing here, and no test in this package enumerated the union.
     *
     * So every kind is sent over a live socket and every kind must be answered. The next
     * `applyAction` refusal reddens this the moment it lands, rather than depending on its author
     * reading a docstring in another package.
     *
     * THE SECOND HALF OF EACH STEP IS THE LOAD-BEARING ONE. A gateway that answers and then dies
     * passes the first assertion, because the reply is written before the process goes; the `tab`
     * afterwards is what proves it survived. In-process the throw surfaces as an unhandled error
     * rather than an exit, so the reply assertion is what actually reddens here -- but the pair is
     * what the property is, and `dist/main.js` driven as a child process is where the exit is
     * visible.
     */
    const kinds = actionKinds();
    // A FLOOR, not an equality: adding an action must not fail this, but a scan that stopped
    // matching must. Both the floor and the canaries now live beside the scan itself, so the
    // dispatch-table test in `frontend` sanity-checks it the same way.
    expect(kinds.length, 'the Action union scan found too few kinds to be right')
      .toBeGreaterThanOrEqual(ACTION_KIND_FLOOR);
    for (const canary of ACTION_KIND_CANARIES) {
      expect(kinds, 'the Action union scan missed a known kind').toContain(canary);
    }

    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const io = reader(ws);
    ws.send(JSON.stringify({ kind: 'hello' }));
    for (const want of ['session', 'atlas', 'frame']) {
      expect((await io.next('hello'))['kind']).toBe(want);
    }
    await io.settle();

    for (const kind of kinds) {
      const action = { kind, ...(ACTION_FIELDS[kind] ?? {}) };
      ws.send(JSON.stringify({ kind: 'action', action }));
      if (SWALLOWED.includes(kind)) {
        // NO REPLY AT ALL IS THE CORRECT ANSWER for these, so there is nothing to read -- and
        // reading would block until `next`'s deadline and report the kind as hung. The survival
        // check below is what proves the gateway handled it rather than died on it, which is the
        // same property the other branches get from their reply.
        await io.settle();
      } else {
        const reply = await io.next(`the ${kind} action`);
        if (REFUSED.includes(kind)) {
          expect(reply['kind'], `${kind} must be refused, not applied`).toBe('error');
          expect(String(reply['message']), `${kind}'s refusal must name it`).toContain(kind);
        } else {
          // An `error` here means the gateway refused a kind nothing documents as refusable; a
          // timeout in `next` above means `applyAction` threw and took the handler with it.
          expect(reply['kind'], `${kind} must be answered with a frame`).toBe('frame');
        }
        await io.settle();
      }
      ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
      expect((await io.next(`a tab after ${kind}`))['kind'],
        `the gateway must still serve actions after ${kind}`).toBe('frame');
      await io.settle();
    }
    ws.close();
    // Two sends a kind -- 50 for the 25 members -- and a 25ms settle between them, so this is the
    // one case here that does not fit the 5s default. And it must not, or a single hanging kind
    // would be reported as a whole-test timeout instead of by name. See `reader`'s own 2s deadline.
  }, 30_000);

  it('REATTACHES to the same session without carrying display state across the socket', async () => {
    /*
      THIS WAS 'toggles the keypad per CONNECTION', AND MOST OF IT WAS DELETED ON 2026-10-06.

      It toggled the keypad three times and asserted the `keypad` region's presence, its top edge
      against the frame's old bottom, and the frame's new height against the lowest BUTTON -- all of
      which named things the server no longer sends. The web keypad is a browser-side DOM overlay:
      there is no `showKeypad` flag, no `DrawList.keypad`, and a `toggleKeypad` frame is answered
      with silence.

      WHAT SURVIVES IS THE PROPERTY THAT WAS NEVER ABOUT THE KEYPAD: a reattach returns the SAME
      session and the second connection inherits no display state from the first. That mattered
      because a gateway `Session` deliberately outlives its socket, so anything held per session is
      handed to whoever attaches next -- a different window, possibly a different person. The old
      test measured something sharp here and the measurement is worth keeping verbatim: with only
      the first two toggles, it PASSED against a flag stored per SESSION, because the second toggle
      left the preference OFF and a surviving flag had nothing to carry. Closing with it ON is what
      made per-session and per-connection give different answers.

      The overlay now starts hidden on every page load for exactly that reason -- the same rule
      arriving at the same answer one layer up, where `keypadOverlay.test.ts` pins it. So this test
      keeps the SESSION half, which is the half only a real socket can show.
    */
    const { url } = await start();
    const a = new WebSocket(url);
    await new Promise((r) => a.addEventListener('open', r, { once: true }));
    const first = collect(a, 3);
    a.send(JSON.stringify({ kind: 'hello' }));
    const id = (await first)[0]!['id'] as string;

    // A toggle still goes over the wire from a client that does not run the served bridge, and the
    // gateway must swallow it: no reply, and the session unharmed. Proven by what follows working.
    a.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));
    const typed = collect(a, 1);
    a.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
    expect((await typed)[0]!['kind']).toBe('frame');
    a.close();

    const b = new WebSocket(url);
    await new Promise((r) => b.addEventListener('open', r, { once: true }));
    const second = collect(b, 2);
    b.send(JSON.stringify({ kind: 'hello', sessionId: id }));
    const got = await second;
    // NO `session` MESSAGE: the same session came back, which is what makes this a reattach rather
    // than a fresh connection -- and a fresh connection would satisfy everything below for a much
    // less interesting reason.
    expect(got.map((m) => m['kind'])).toEqual(['atlas', 'frame']);
    const frame = got.find((m) => m['kind'] === 'frame')!['list'] as FrameList;
    // AND THE FRAME CARRIES NO KEYPAD REGION, which is now a statement about the SHAPE of what the
    // server sends rather than about a toggle: `DrawList` has no such member any more, so this
    // would fail if one came back.
    expect('keypad' in frame).toBe(false);
    b.close();
  });

  it('logs an action BEFORE intercepting it, so an intercepted kind is still observable', async () => {
    /*
      ORDERING, and `toggleKeypad` is still the kind that shows it -- but the REASON changed on
      2026-10-06 and the old one is now false.

      It used to be that `--log-actions` was the only observable `browser-keys.mjs` had for the
      Ctrl-K chord, so an interception above the log line would make that chord unprovable. The web
      keypad is a client-side overlay now: the chord never crosses the socket, and that harness
      asserts its ABSENCE from this very log. So the old justification has expired.

      WHAT THE ORDERING STILL BUYS, and why this is not deleted: it is the ONLY way an intercepted
      action is visible to anyone at all. A kind that returns early reaches no `Session`, changes no
      screen and produces no frame -- so if the log line sat below the interception, a gateway
      swallowing actions it should have applied would look identical to one applying them. This
      kind is the one the suite can reach; the property is general.
    */
    const written: string[] = [];
    // CALLS THROUGH, rather than returning `true` and swallowing the write. Nothing else writes to
    // stdout in this window today, so a swallowing spy would be harmless -- and silently wrong the
    // day `buildServer` or `start` logs anything, which is the sort of gap that turns into a lost
    // diagnostic hours later. `bind` because the original needs its `this`.
    const through = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return (through as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write);
    try {
      // `--log-actions` needs `--replay`, which `start` always passes; `args.ts:173` refuses the
      // pair otherwise, because the log carries typed text.
      const { url } = await start(['--log-actions']);
      const ws = new WebSocket(url);
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      const first = collect(ws, 3);
      ws.send(JSON.stringify({ kind: 'hello' }));
      await first;
      ws.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));
      // NO REPLY TO WAIT FOR -- the interception is silent now, where it used to repaint. A real
      // action afterwards gives this something to await, and doubles as the proof the gateway
      // survived: `collect` would hang if the handler had died on the throw.
      const next = collect(ws, 1);
      ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
      await next;
      ws.close();
      expect(written.join('')).toContain('action: {"kind":"toggleKeypad"}');
    } finally {
      spy.mockRestore();
    }
  });
});
