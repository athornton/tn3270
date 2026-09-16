import { createBridge, type BridgeApi } from './bridgecore.js';

/**
 * The few lines that touch real browser globals. Everything testable is in `bridgecore.ts`.
 *
 * The socket URL keeps the page's own scheme and host, so a TLS gateway gets `wss:` with no flag
 * and no configuration. The token rides in the cookie the page was served with, so it is not in
 * this URL and not in the address bar.
 *
 * ## WHY `window.tn3270` IS REACHED THROUGH A CAST AND NOT A `declare global`
 *
 * `renderer.ts` already augments `Window` with `tn3270`, but it does so in `packages/canvas` and
 * the barrel there deliberately does NOT export it -- it is a browser entry point that throws at
 * module load outside a browser. So nothing in `packages/web` imports the file carrying that
 * augmentation, and it is not in scope here. Re-declaring it would not help either: a second
 * `declare global` for the same property must be structurally IDENTICAL, and the renderer's
 * version is typed in its own `AtlasMessage`/`DrawList` while this bridge deals in `unknown`
 * payloads, so the two would collide as "subsequent property declarations must have the same type".
 * The cast keeps the augmentation single-sourced in the package that owns the renderer.
 */
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${proto}//${location.host}/ws`);
socket.binaryType = 'arraybuffer';

/** Inflate one binary message. Measured: the server sends zlib-wrapped deflate, so 'deflate'. */
async function inflate(data: unknown): Promise<string> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(data as ArrayBuffer));
  void writer.close();
  return new Response(stream.readable).text();
}

(window as unknown as { tn3270: BridgeApi }).tn3270 = createBridge({
  socket, storage: sessionStorage, inflate,
});


// The token was in the query string on the first load only; the cookie carries it from here, so
// take it out of the address bar and out of any future Referer.
if (location.search !== '') history.replaceState(null, '', location.pathname);
