import { describe, it, expect, afterEach } from 'vitest';
import { inflateSync } from 'node:zlib';
import { connect, type Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from '../src/main.js';
import { parseWebArgs } from '../src/args.js';

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
 * an upgrade have any behavioural test without going down to a socket. Both were confirmed INERT to
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
    // A SOURCE SCAN, because the property is invisible to behaviour: a plain `!==` rejects exactly
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

  it('refuses toggleKeypad and STAYS UP to serve the next action', async () => {
    // THE SAME HOLE AS `quit`, AND IT WAS LIVE. `applyAction` throws on `toggleKeypad`, `main.ts`
    // calls it outside any try, and that runs in a socket 'data' handler -- so before
    // `decodeClientMessage` rejected this kind, one frame from any client ended the gateway PROCESS
    // and took every other operator's session down with it.
    //
    // THE SECOND HALF IS THE POINT. Asserting the error message alone would pass just as well
    // against a gateway that answered and then died, since the reply is written before the process
    // goes. Sending a real action afterwards and getting a frame back is what proves it survived.
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;

    const refusal = collect(ws, 1);
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));
    const got = await refusal;
    expect(got[0]!['kind']).toBe('error');
    expect(String(got[0]!['message'])).toMatch(/toggleKeypad/);

    const after = collect(ws, 1);
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
    expect((await after)[0]!['kind']).toBeTypeOf('string');
    ws.close();
  });
});
