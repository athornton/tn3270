#!/usr/bin/env node
/**
 * A TLS-terminating proxy: accepts TLS, forwards plaintext to a 3270 host.
 *
 * This is what lets us test and use TLS against hosts that cannot speak it.
 * Neither Hercules system can — VM/CE on :3270 and MVS 3.8j TK5 on :3271 —
 * so without a proxy in front of them, TLS could only ever be unit-tested.
 *
 * Why in-repo rather than stunnel or socat: neither is installed on this box and
 * there is no root to install them, but more importantly the tests need to start
 * and stop the proxy themselves, on an ephemeral port, with a cert they just
 * generated. A committed harness does that; an external daemon does not.
 * Verified 2026-08-25 that telnet negotiation passes through byte-intact.
 *
 * Usage as a script:
 *   node gen-test-certs.mjs /tmp/certs
 *   node tls-proxy.mjs --to localhost:3270 --listen 9992 \
 *        --cert /tmp/certs/cert.pem --key /tmp/certs/key.pem
 *   # then, once the client supports it:
 *   node packages/tui/dist/main.js -cafile /tmp/certs/cert.pem \
 *        -model 3278-2-E localhost:9992
 *
 * Usage from a test: `await startTlsProxy({...})` -> `{ port, close() }`.
 */
import tls from 'node:tls';
import net from 'node:net';
import { readFileSync } from 'node:fs';

/**
 * Starts the proxy and resolves once it is listening.
 *
 * `listenPort: 0` asks the OS for an ephemeral port, which is what tests want —
 * a fixed port makes concurrent test files collide. The chosen port comes back
 * in the return value.
 */
export async function startTlsProxy({
  cert, key, certPath, keyPath,
  target,
  listenHost = '127.0.0.1',
  listenPort = 0,
  onError,
}) {
  const certPem = cert ?? readFileSync(certPath);
  const keyPem = key ?? readFileSync(keyPath);

  const server = tls.createServer({ cert: certPem, key: keyPem }, (client) => {
    const upstream = net.connect(target.port, target.host);
    // Both halves must be torn down together, or a half-open socket keeps the
    // event loop alive and a test that awaits close() never returns.
    const shutdown = (err) => {
      if (err !== undefined) onError?.(err);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', shutdown);
    upstream.on('error', shutdown);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });

  // A failed handshake is routine here: it is exactly what the
  // verification-rejects-a-self-signed-cert test provokes. It must not be an
  // unhandled error event that kills the run.
  server.on('tlsClientError', (err) => { onError?.(err); });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    host: listenHost,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function parseTarget(s) {
  const i = s.lastIndexOf(':');
  if (i <= 0) throw new Error(`--to needs host:port, got ${s}`);
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--to has a bad port: ${s}`);
  }
  return { host: s.slice(0, i), port };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const to = opt('--to');
  const certPath = opt('--cert');
  const keyPath = opt('--key');
  if (to === undefined || certPath === undefined || keyPath === undefined) {
    console.error('usage: tls-proxy.mjs --to host:port --cert FILE --key FILE [--listen PORT]');
    process.exit(2);
  }
  const proxy = await startTlsProxy({
    certPath, keyPath,
    target: parseTarget(to),
    listenPort: Number(opt('--listen') ?? 0),
    onError: (e) => { console.error(`proxy: ${e.message}`); },
  });
  console.error(`TLS proxy listening on ${proxy.host}:${proxy.port} -> ${to}`);
}
