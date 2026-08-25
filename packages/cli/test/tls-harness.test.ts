import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import net from 'node:net';
// @ts-expect-error -- .mjs harness, deliberately untyped; tests are outside the tsc build
import { startTlsProxy } from '../scripts/tls-proxy.mjs';
// @ts-expect-error -- see above
import { generateCerts, haveOpenssl } from '../scripts/gen-test-certs.mjs';

/**
 * Pins the TLS harness and the platform facts the TLS design rests on.
 *
 * These are characterisation tests, not tests of our client — the client has no
 * TLS support yet. They exist because the design in
 * docs/superpowers/specs/2026-08-25-tls-support-design.md makes five factual
 * claims about how Node behaves, and a design resting on unpinned claims rots
 * silently. If a Node upgrade changes any of them, this file fails and names the
 * paragraph that needs rewriting, rather than the TLS feature mysteriously
 * breaking a month later.
 */

const openssl = haveOpenssl();
// Skipped rather than failed: openssl is present on the dev box (3.5.6) but this
// suite should not require it of every machine that clones the repo.
const describeTls = openssl ? describe : describe.skip;

/** Long enough to prove no error arrived; the real errors below land in 1-2 ms. */
const HANG_PROOF_MS = 600;

/** IAC DO TN3270E — what Hercules opens with. */
const IAC_DO_TN3270E = Buffer.from([0xff, 0xfd, 0x28]);
/** IAC DO TERMINAL-TYPE / IAC WILL TERMINAL-TYPE, a negotiation round trip. */
const IAC_DO_TTYPE = Buffer.from([0xff, 0xfd, 0x18]);
const IAC_WILL_TTYPE = Buffer.from([0xff, 0xfb, 0x18]);

interface Stub { port: number; close: () => Promise<void> }

/** A plaintext server standing in for a host that cannot speak TLS. */
async function startPlaintextStub(behave: (s: net.Socket) => void): Promise<Stub> {
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', () => {});
    behave(s);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as net.AddressInfo;
  return { port, close: () => new Promise<void>((r) => { server.close(() => r()); }) };
}

/** Resolves with what happened, never rejects, so every outcome is assertable. */
function attempt(port: number, opts: tls.ConnectionOptions & { deadlineMs?: number } = {}) {
  const { deadlineMs = 4000, ...connectOpts } = opts;
  return new Promise<{
    handshook: boolean; authorized?: boolean; authError?: string | null;
    protocol?: string | null; echoed?: string; error?: string;
  }>((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port, ...connectOpts });
    const done = (r: Awaited<ReturnType<typeof attempt>>) => { resolve(r); sock.destroy(); };
    sock.on('secureConnect', () => {
      // Prove the tunnel carries 3270 traffic, not just that it handshook.
      sock.write(IAC_WILL_TTYPE);
    });
    sock.on('data', (d: Buffer) => done({
      handshook: true,
      authorized: sock.authorized,
      authError: sock.authorizationError?.toString() ?? null,
      protocol: sock.getProtocol(),
      echoed: d.toString('hex'),
    }));
    sock.on('error', (e: NodeJS.ErrnoException) => done({ handshook: false, error: e.code ?? e.message }));
    setTimeout(() => done({ handshook: false, error: 'HUNG' }), deadlineMs);
  });
}

describeTls('TLS harness', () => {
  let dir: string;
  let certs: { certPath: string; keyPath: string; certPem: Buffer };
  let backend: Stub;
  let proxy: { port: number; close: () => Promise<void> };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tn3270-tls-'));
    certs = generateCerts(dir);
    // Stands in for a 3270 host: prepends a negotiation byte sequence to whatever
    // it receives, so a reply proves both directions crossed the proxy intact.
    backend = await startPlaintextStub((s) => {
      s.on('data', (d: Buffer) => s.write(Buffer.concat([IAC_DO_TTYPE, d])));
    });
    proxy = await startTlsProxy({
      certPath: certs.certPath, keyPath: certs.keyPath,
      target: { host: '127.0.0.1', port: backend.port },
      onError: () => {}, // handshake rejections are expected here
    });
  });

  afterAll(async () => {
    await proxy?.close();
    await backend?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a self-signed certificate by default', async () => {
    const r = await attempt(proxy.port);
    expect(r.handshook).toBe(false);
    expect(r.error).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('connects with verification off, but reports the peer as unauthorized', async () => {
    const r = await attempt(proxy.port, { rejectUnauthorized: false });
    expect(r.handshook).toBe(true);
    expect(r.protocol).toBe('TLSv1.3');
    // The point of -noverifycert: it authenticates nothing, and says so.
    expect(r.authorized).toBe(false);
    expect(r.authError).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('connects AND authorizes when the cert is pinned as a CA', async () => {
    const r = await attempt(proxy.port, { ca: [certs.certPem], servername: 'localhost' });
    expect(r.handshook).toBe(true);
    // This is the assertion that distinguishes -cafile from -noverifycert.
    // Asserting only that the connection succeeded would pass for both.
    expect(r.authorized).toBe(true);
    expect(r.authError).toBeNull();
  });

  it('passes telnet negotiation through byte-intact', async () => {
    const r = await attempt(proxy.port, { rejectUnauthorized: false });
    expect(r.echoed).toBe(
      Buffer.concat([IAC_DO_TTYPE, IAC_WILL_TTYPE]).toString('hex'),
    );
  });
});

describeTls('a plaintext host does not reject TLS, it hangs', () => {
  // The trap that forces a handshake deadline into the design. Without one,
  // `tn3270 localhost:3270` under a TLS default appears to do nothing at all.

  it('HANGS when the host negotiates then waits — what Hercules does', async () => {
    const stub = await startPlaintextStub((s) => { s.write(IAC_DO_TN3270E); });
    try {
      const r = await attempt(stub.port, { rejectUnauthorized: false, deadlineMs: HANG_PROOF_MS });
      expect(r.error).toBe('HUNG');
    } finally { await stub.close(); }
  });

  it('HANGS when the host says nothing', async () => {
    const stub = await startPlaintextStub(() => {});
    try {
      const r = await attempt(stub.port, { rejectUnauthorized: false, deadlineMs: HANG_PROOF_MS });
      expect(r.error).toBe('HUNG');
    } finally { await stub.close(); }
  });

  it('errors cleanly only when the host keeps talking', async () => {
    const stub = await startPlaintextStub((s) => {
      s.write(IAC_DO_TN3270E);
      s.on('data', () => s.write(Buffer.from([0xff, 0xfb, 0x19])));
    });
    try {
      const r = await attempt(stub.port, { rejectUnauthorized: false });
      expect(r.error).toBe('ERR_SSL_WRONG_VERSION_NUMBER');
    } finally { await stub.close(); }
  });

  it("fires tls.connect's timeout event during a stalled handshake", async () => {
    // Establishes that `timeout` is a usable handshake deadline, so the
    // implementation needs no separate timer. It is an INACTIVITY timer, so the
    // implementation must clear it on secureConnect -- see the spec.
    const stub = await startPlaintextStub((s) => { s.write(IAC_DO_TN3270E); });
    try {
      const what = await new Promise<string>((resolve) => {
        const sock = tls.connect({
          host: '127.0.0.1', port: stub.port, rejectUnauthorized: false, timeout: 300,
        });
        sock.on('secureConnect', () => resolve('handshook'));
        sock.on('error', (e: NodeJS.ErrnoException) => resolve(`error:${e.code}`));
        sock.on('timeout', () => { resolve('timeout'); sock.destroy(); });
        setTimeout(() => { resolve('no timeout event'); sock.destroy(); }, 2000);
      });
      expect(what).toBe('timeout');
    } finally { await stub.close(); }
  });
});
