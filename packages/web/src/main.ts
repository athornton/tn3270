import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createReadStream, readFileSync } from 'node:fs';
import type { Session } from '@tn3270/core';
import { readAtlas, drawList, blankColumns } from '@tn3270/canvas';
import { resolve, resolveTerminalType, resolveAlternateSize } from '@tn3270/core';
import { applyAction, defaultSession, resolveScheme, resolveTls } from '@tn3270/frontend';
import { parseWebArgs, UsageError, type WebArgs } from './args.js';
import { resolveAsset, tokenCookie, parseCookies } from './httpstatic.js';
import { checkUpgrade, tokenMatches } from './handshake.js';
import { Connection } from './wsserver.js';
import { SessionRegistry } from './sessions.js';
import { encodeServerMessage, decodeClientMessage } from './protocol.js';

/**
 * The gateway: an HTTP(S) server, a WebSocket per client, and one 3270 Session each.
 *
 * This is Electron's `main.ts` with a socket where the IPC was. The draw list is computed HERE for
 * the same reason it is computed in Electron's main process -- `drawList` needs core's palette and
 * code page, and a browser cannot resolve a bare specifier without a bundler.
 *
 * ## WHAT MAKES THIS SAFE TO EXPOSE, AND WHAT DOES NOT
 *
 * Loopback by default, a token by default, and a mismatched Origin refused. Without `--tls-cert`
 * every keystroke -- including a password -- crosses the network in the clear, which is why
 * startup says so out loud rather than burying it in a doc.
 */
export function buildServer(args: WebArgs) {
  const atlas = readAtlas();
  const blank = [...blankColumns(atlas.coverage, atlas.geometry)];
  // `resolveScheme` already treats `undefined` as "the default", so no conditional is needed.
  const scheme = resolveScheme(args.scheme);
  const typeOpts = { ...(args.model !== undefined ? { model: args.model } : {}) };
  const secure = args.tls !== undefined;

  // `parseWebArgs` yields RAW `TlsFlags`; `defaultSession` needs resolved `TlsOptions`, exactly as
  // the CLI and TUI do it (`main.ts:81` and `:143`). Resolved ONCE, here, and deliberately not
  // inside the session factory: `resolveTls` THROWS on contradictory flags (`-insecure` with
  // `-cafile`), and inside the factory that throw would land on the first browser's `hello` as a
  // failed session rather than on the operator's terminal as a usage error at startup.
  const hostTls = resolveTls(args.hostTls, (m) => new UsageError(m));

  const registry = new SessionRegistry({
    graceMs: args.graceMs,
    maxSessions: args.maxSessions,
    factory: () => {
      const session = defaultSession(
        resolveTerminalType(typeOpts), hostTls, resolveAlternateSize(typeOpts), undefined,
        args.bindImage, args.bindLimit,
      );
      if (args.replay !== undefined) {
        // The hostless test seam: paint a recorded trace and open no socket at all, so no test
        // can reach a host or capture a credential.
        session.replay(readFileSync(args.replay, 'utf8'));
      } else {
        void session.connect(args.host, args.port).catch(() => { /* reported per-connection */ });
      }
      return { session, close: () => { session.disconnect(); } };
    },
  });

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const asset = resolveAsset(url.pathname);
    if (asset === undefined) { res.writeHead(404).end('not found'); return; }

    if (args.auth) {
      const cookies = parseCookies(req.headers.cookie);
      const given = cookies['tn3270_token'] ?? url.searchParams.get('t') ?? undefined;
      // `tokenMatches`, NOT `!==`. `handshake.ts` exports it for this exact route and says why: a
      // plain comparison here would leak the token by timing on the asset path while the upgrade
      // path was careful, which is the same secret and so the same leak. One comparison, used twice.
      if (!tokenMatches(given, args.token)) { res.writeHead(403).end('forbidden'); return; }
      // Set it on every page load, so a bookmarked ?t= link keeps working and the cookie refreshes.
      if (asset.type.startsWith('text/html')) {
        res.setHeader('Set-Cookie', tokenCookie(args.token, secure));
      }
    }
    res.writeHead(200, { 'content-type': asset.type });
    createReadStream(asset.file).pipe(res);
  };

  const server = args.tls !== undefined
    ? createHttps({
        cert: readFileSync(args.tls.cert), key: readFileSync(args.tls.key),
        ...(args.tls.chain !== undefined ? { ca: readFileSync(args.tls.chain) } : {}),
      }, handler)
    : createHttp(handler);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const check = checkUpgrade({
      headers: req.headers as Record<string, string | undefined>,
      cookies: parseCookies(req.headers.cookie),
      query: Object.fromEntries(url.searchParams),
      auth: args.auth,
      token: args.token,
      // REQUIRED, and omitting it silently disables `--allow-origin` -- the whole of Task 4b, which
      // exists so a reverse proxy does not break the Origin rule.
      allowOrigins: args.allowOrigins,
    });
    if (!check.ok) {
      process.stderr.write(`upgrade refused: ${check.reason}\n`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${check.accept}\r\n\r\n`,
    );

    // BYTES CAN ARRIVE WITH THE UPGRADE. Node hands the first packet of the upgraded stream as
    // `head`, and anything in it was read off the socket BEFORE `Connection` attached its listener,
    // so it would be silently lost -- a first frame that vanishes, which is the read-boundary class
    // of bug Task 7 exists to prevent. `unshift` puts it back for the listener to pick up.
    if (head.length > 0) socket.unshift(head);

    const conn = new Connection(socket);
    let id: string | undefined;
    let session: Session | undefined;
    // Set on `hello`. Called after EVERY action, because a local one emits no session event -- see
    // the comment at its call site below.
    let repaint: (() => void) | undefined;
    /**
     * Set on `hello`: takes this socket's listeners OFF the session, which outlives it.
     *
     * This replaces a `live` boolean that made a dead connection's listeners return early. That
     * worked, but it left them REGISTERED, so a session reattached ten times carried thirty
     * listeners and every screen change walked all thirty. `Session.off` removes them instead, which
     * is why no guard is needed inside `send` any more: after this runs, nothing can call it.
     */
    let stopListening: (() => void) | undefined;
    /**
     * Per CONNECTION, and that is the one thing this differs from Electron in (`gui/src/main.ts:279`,
     * where the same flag is per WINDOW and the two coincide).
     *
     * Here they do not, and the harm is SEQUENTIAL rather than concurrent. Two sockets can never
     * hold one `Session` at the same time -- `attach` reattaches only a DETACHED entry
     * (`sessions.ts:61`) and an id someone is using falls through to a new session, which is the
     * anti-hijacking rule, and `bridge.ts:35` keeps the id in `sessionStorage`, which is per TAB. So
     * there is no other window to resize. What a session-scoped flag would do instead is hand the
     * preference to whoever attaches NEXT: a gateway `Session` deliberately outlives its socket so a
     * reload reattaches, and the next attacher is a different window -- possibly a different person
     * -- that never asked for a keypad and would find its screen 9 rows taller than it left it.
     * Declared in the `upgrade` scope, so it dies with the socket, which is exactly the lifetime the
     * preference has; a reattaching client therefore starts with the keypad hidden.
     */
    let showKeypad = false;
    conn.onText((text) => {
      let msg;
      try { msg = decodeClientMessage(text); } catch (err) {
        conn.sendBinary(encodeServerMessage({ kind: 'error', message: String(err) }));
        return;
      }
      if (msg.kind === 'hello') {
        let attached;
        try { attached = registry.attach(msg.sessionId); } catch (err) {
          conn.sendBinary(encodeServerMessage({ kind: 'error', message: String(err) }));
          conn.close();
          return;
        }
        id = attached.id;
        session = attached.session;
        const mine = attached.session;
        if (attached.created) {
          conn.sendBinary(encodeServerMessage({ kind: 'session', id: attached.id }));
        }
        conn.sendBinary(encodeServerMessage({
          kind: 'atlas', geometry: atlas.geometry, coverage: atlas.coverage, blank,
        }));
        const send = (): void => {
          const snapshot = mine.screen.snapshot();
          const oia = mine.oia.toText();
          conn.sendBinary(encodeServerMessage({
            kind: 'frame',
            // The VARIABLE is closed over, so this reads whatever it holds at paint time and the
            // toggle below needs no more than a repaint. Every route into this closure -- a host
            // frame, a local action, a reattach -- therefore draws what THIS socket last asked for.
            list: drawList(snapshot, resolve(snapshot), atlas.geometry, scheme,
              oia === '' ? undefined : oia, showKeypad),
          }));
        };
        mine.on('screen', send);
        mine.on('connect', send);
        mine.on('disconnect', send);
        // Paired with the three lines above, in one place, so a fourth event cannot be added to one
        // list and forgotten in the other.
        stopListening = () => {
          mine.off('screen', send);
          mine.off('connect', send);
          mine.off('disconnect', send);
        };
        repaint = send;
        send();                                     // repaint immediately, which is what makes
        return;                                     // a reattach show the CURRENT screen
      }
      if (session === undefined) return;            // an action before hello: nothing to apply to
      // THE SESSION IS HELD HERE, NOT RE-FETCHED. `registry.attach(id)` is NOT a cheap lookup for
      // an id that is already attached: its anti-hijacking rule reattaches only a DETACHED entry, so
      // an attached id falls through and BUILDS A NEW SESSION. Calling it per action would open a
      // fresh connection to the mainframe on every keystroke, apply the action to a screen nobody is
      // looking at, and exhaust `--max-sessions` (default 16) within a dozen keys.
      // Gated on `--log-actions`, which `parseWebArgs` refuses without `--replay`. The action
      // carries typed text, so on a live gateway this line would be a password in a log file.
      if (args.logActions) process.stdout.write(`action: ${JSON.stringify(msg.action)}\n`);
      /**
       * INTERCEPTED, and this is what makes the kind safe to admit at all.
       *
       * `applyAction` THROWS on `toggleKeypad` (its guard in `frontend/src/actions.ts`) rather than ignoring
       * it, deliberately, so a front end that forgot to own its own display fails loudly. But the
       * call below is outside any try and runs inside a socket 'data' handler, where `wsserver.ts`
       * records that a throw ends the PROCESS and every other operator's session with it. So
       * `protocol.ts` rejected this kind outright until now; that rejection is gone, and THIS
       * `return` is the whole of what replaces it. It is unconditional for the kind and sits above
       * every path to `applyAction`, so the kind cannot reach it.
       *
       * AFTER the log line above, on purpose: `--log-actions` is the only thing the browser chord
       * harness can observe, and in replay mode a toggle changes no screen.
       *
       * A repaint and nothing else, because `send` reads `showKeypad` itself -- and a repaint IS
       * required, since no `Session` event fires for a decision no `Session` knows about.
       */
      if (msg.action.kind === 'toggleKeypad') { showKeypad = !showKeypad; repaint?.(); return; }
      applyAction(session, msg.action);
      // REPAINT UNCONDITIONALLY, exactly as Electron's main does (`gui/src/main.ts:365-366`).
      // A LOCAL action emits NO session event: `emit('screen')` fires for host data and for a
      // replay, but tab, the arrow keys, Home and an ordinary typed character only move the cursor
      // or write into the buffer. Relying on the event listeners alone therefore leaves a browser
      // showing nothing at all until the host next speaks -- measured, as a 5-second timeout in the
      // integration test's `tab` case, which is the only reason this was not shipped.
      repaint?.();
    });
    conn.onClose(() => {
      // BEFORE `detach`, so the grace window never holds a session with listeners pointing at a
      // socket that has gone. `stopListening` is undefined for a socket that closed before `hello`.
      stopListening?.();
      if (id !== undefined) registry.detach(id);
    });
  });

  return { server, registry };
}

/** Entry point. Kept separate from `buildServer` so tests can bind an ephemeral port. */
export function run(argv: readonly string[]): void {
  let args;
  let built;
  // `buildServer` IS INSIDE THE TRY, not after it. It resolves the TLS flags, and a contradiction
  // there is a usage error like any other -- reported by name and exiting 2, rather than surfacing as
  // an uncaught exception with a stack trace over a message that already says what to fix.
  try {
    args = parseWebArgs(argv);
    built = buildServer(args);
  } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const { server } = built;
  server.listen(args.listen, args.bind, () => {
    const scheme = args.tls !== undefined ? 'https' : 'http';
    const shown = args.bind === '0.0.0.0' ? 'YOUR-HOST' : args.bind;
    // THE PORT COMES FROM THE SOCKET, NOT FROM `args.listen`. With `--listen 0` -- which this
    // package's own args parser goes out of its way to accept, because 0 means "let the kernel
    // choose" -- echoing the argument prints `http://127.0.0.1:0/`, a URL that cannot be opened.
    // Measured on the first run of the gateway as a program.
    const bound = (server.address() as { port: number } | null)?.port ?? args.listen;
    process.stdout.write(`serving ${args.host}:${args.port} at ${scheme}://${shown}:${bound}/`
      + (args.auth ? `?t=${args.token}\n` : '\n'));
    /**
     * THE WARNINGS FIRE ON THE COMBINATION, NOT ON THE FLAG.
     *
     * Auth is off by DEFAULT now, so warning about `--auth off` alone would print on every single
     * run — and a warning that appears every time is read as decoration and then not read at all,
     * which would cost more than it buys on the one run that matters. What is actually dangerous is
     * being reachable from the network WITHOUT a token, so that pair is what speaks up.
     *
     * `loopback` is a prefix test rather than a `=== '127.0.0.1'` comparison: `127.0.0.53` and
     * `::1` are equally unreachable from elsewhere, and the old exact test would have called them
     * exposed and cried wolf.
     */
    const loopback = args.bind.startsWith('127.') || args.bind === '::1' || args.bind === 'localhost';
    if (!args.auth && !loopback) {
      process.stderr.write(`WARNING: bound to ${args.bind} with --auth off. Anything that can reach `
        + `this port can type at ${args.host}:${args.port}, with no token required. `
        + 'Use --auth on.\n');
    }
    if (args.tls === undefined && !loopback) {
      process.stderr.write('WARNING: no --tls-cert and not bound to loopback. Keystrokes, '
        + 'including passwords, cross the network in the clear.\n');
    }
  });
}

// The same self-invoking guard the TUI uses (`tui/src/main.ts`), so this file is both the module the
// tests import and the program `node packages/web/dist/main.js` runs. Without it there is no way to
// start the gateway at all, and `browser-keys.mjs` has nothing to spawn.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2));
}
