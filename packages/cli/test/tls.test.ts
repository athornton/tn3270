import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Session, type Connection } from '@tn3270/core';
import { parseArgs, UsageError } from '../src/main.js';
import { parseArgs as parseTuiArgs, UsageError as TuiUsageError } from '../../tui/src/main.js';
import { Runner } from '../src/runner.js';
import { resolveHostSpec } from '../src/hostspec.js';
import { resolveTls, describeTlsError, tcpConnect, type TlsFlags } from '../src/tls.js';
// @ts-expect-error -- .mjs harness, deliberately untyped; tests are outside the tsc build
import { startTlsProxy } from '../scripts/tls-proxy.mjs';
// @ts-expect-error -- see above
import { generateCerts, haveOpenssl } from '../scripts/gen-test-certs.mjs';

/** Design: docs/superpowers/specs/2026-08-25-tls-support-design.md */

const usage = (m: string) => new UsageError(m);

describe('TLS flag resolution', () => {
  it('defaults to TLS with verification on', () => {
    expect(resolveTls({}, usage)).toEqual({ kind: 'tls', verify: true });
  });

  it('-insecure turns TLS off entirely', () => {
    expect(resolveTls({ insecure: true }, usage)).toEqual({ kind: 'plaintext' });
  });

  it('-noverifycert keeps TLS but stops verifying', () => {
    expect(resolveTls({ verify: false }, usage)).toEqual({ kind: 'tls', verify: false });
  });

  it('-cafile keeps verification on and names the anchor', () => {
    expect(resolveTls({ caFile: '/tmp/h.pem' }, usage))
      .toEqual({ kind: 'tls', verify: true, caFile: '/tmp/h.pem' });
  });

  // Contradictions are refused rather than resolved by precedence: one of the two
  // readings of `-insecure -cafile x` is an unencrypted connection, and a user who
  // typed both cannot be assumed to have wanted that one.
  it('refuses -insecure combined with any verification flag', () => {
    for (const extra of [{ verify: true }, { verify: false }, { caFile: '/tmp/h.pem' }]) {
      expect(() => resolveTls({ insecure: true, ...extra } as TlsFlags, usage))
        .toThrow(/-insecure disables TLS/);
    }
  });

  it('refuses -noverifycert combined with -cafile', () => {
    expect(() => resolveTls({ verify: false, caFile: '/tmp/h.pem' }, usage))
      .toThrow(/contradict each other/);
  });
});

describe('TLS flags on both front ends', () => {
  // The two parsers delegate to the same helper, so this asserts they cannot drift.
  const cases: readonly [string[], unknown][] = [
    [[], { kind: 'tls', verify: true }],
    [['-insecure'], { kind: 'plaintext' }],
    [['-noverifycert'], { kind: 'tls', verify: false }],
    [['-no-verify'], { kind: 'tls', verify: false }],
    [['-verifycert'], { kind: 'tls', verify: true }],
    [['-cafile', '/tmp/h.pem'], { kind: 'tls', verify: true, caFile: '/tmp/h.pem' }],
  ];

  it.each(cases)('the CLI parses %j', (argv, expected) => {
    expect(parseArgs(argv).tls).toEqual(expected);
  });

  it.each(cases)('the TUI parses %j identically', (argv, expected) => {
    expect(parseTuiArgs([...argv, 'vm:3270']).tls).toEqual(expected);
  });

  it('rejects -cafile with no value on both', () => {
    expect(() => parseArgs(['-cafile'])).toThrow(UsageError);
    expect(() => parseTuiArgs(['-cafile'])).toThrow(TuiUsageError);
  });

  it('still parses the non-TLS flags alongside', () => {
    expect(parseArgs(['-model', '3278-2-E', '-noverifycert']))
      .toEqual({ model: '3278-2-E', tls: { kind: 'tls', verify: false } });
  });
});

describe("s3270's L: host prefix", () => {
  // In s3270 `L:` is what turns TLS on (Common/host.c:633). Here TLS is already
  // the default, so it is a no-op — but it must be stripped, or the host becomes
  // literally `L` and the failure is a baffling DNS error.
  const err = (m: string) => new Error(m);

  it('is stripped, and reported', () => {
    expect(resolveHostSpec('L:vm.example:992', err))
      .toMatchObject({ host: 'vm.example', port: 992, tlsRequested: true });
    expect(resolveHostSpec('l:vm.example', err))
      .toMatchObject({ host: 'vm.example', port: 23, tlsRequested: true });
  });

  it('leaves an ordinary target alone, still defaulting to port 23', () => {
    expect(resolveHostSpec('vm.example:3270', err))
      .toMatchObject({ host: 'vm.example', port: 3270, tlsRequested: false });
    expect(resolveHostSpec('vm.example', err))
      .toMatchObject({ host: 'vm.example', port: 23, tlsRequested: false });
  });

  it('still loses only the last group of a bare IPv6 literal', () => {
    // Unbracketed, so the last colon is the port separator. Carried over from the
    // `splitTarget` this replaced, because it is the case that made it use lastIndexOf.
    expect(resolveHostSpec('::1:3270', err)).toMatchObject({ host: '::1', port: 3270 });
  });

  it('is a usage error with -insecure on the TUI, where both are in argv', () => {
    expect(() => parseTuiArgs(['-insecure', 'L:vm:992'])).toThrow(TuiUsageError);
    expect(() => parseTuiArgs(['-insecure', 'L:vm:992'])).toThrow(/-insecure disables TLS/);
  });

  it('is refused by the runner on an -insecure session, where the host arrives later', async () => {
    // The CLI's host comes from `Connect()` at runtime, not argv, so the same
    // contradiction has to be caught here. Connecting in the clear to a host a
    // script explicitly marked TLS would be a silent downgrade.
    const session = new Session({ connect: () => ({
      write: () => {}, close: () => {},
      onData: undefined, onClose: undefined, onError: undefined,
    } as Connection) });
    const runner = new Runner(session, { clock: () => 0, tlsEnabled: false });
    const reply = await runner.run('Connect(L:vm:992)');
    expect(reply).toMatch(/silent downgrade/);
    expect(reply.trimEnd().endsWith('error')).toBe(true);
  });
});

describe('TLS error messages name the flag that fixes them', () => {
  // This mapping is most of the feature's usability: a TLS failure against a
  // plaintext host is otherwise indistinguishable from a host being down.
  it('points a plaintext host at -insecure', () => {
    expect(describeTlsError('HANDSHAKE_TIMEOUT', 'vm', 3270)).toMatch(/-insecure/);
    expect(describeTlsError('ERR_SSL_WRONG_VERSION_NUMBER', 'vm', 3270)).toMatch(/-insecure/);
  });

  it('offers -cafile BEFORE -noverifycert for a self-signed cert', () => {
    const msg = describeTlsError('DEPTH_ZERO_SELF_SIGNED_CERT', 'vm', 992);
    expect(msg.indexOf('-cafile')).toBeLessThan(msg.indexOf('-noverifycert'));
    // The advice has to say why, or -noverifycert is the one people will copy.
    expect(msg).toMatch(/authenticates nothing/);
  });

  it('distinguishes a name mismatch from an untrusted chain', () => {
    expect(describeTlsError('ERR_TLS_CERT_ALTNAME_INVALID', 'vm', 992))
      .toMatch(/different name/);
  });

  it('names the host and port even for a code it does not know', () => {
    expect(describeTlsError('ENETUNREACH', 'vm', 992)).toMatch(/vm:992/);
  });
});

const describeTls = haveOpenssl() ? describe : describe.skip;

describeTls('tcpConnect over a real TLS proxy', () => {
  let dir: string;
  let certs: { certPath: string; keyPath: string; certPem: Buffer };
  let backend: net.Server;
  let backendPort: number;
  let proxy: { port: number; close: () => Promise<void> };

  /** Answers anything with a byte, so a reply proves the tunnel carries traffic. */
  const startBackend = () => new Promise<void>((r) => {
    backend = net.createServer((s) => {
      s.on('error', () => {});
      s.on('data', () => s.write(Uint8Array.from([0xff, 0xfd, 0x18])));
    });
    backend.listen(0, '127.0.0.1', () => {
      backendPort = (backend.address() as net.AddressInfo).port;
      r();
    });
  });

  /** Resolves with the first byte the host sends, or rejects as tcpConnect does. */
  const roundTrip = async (port: number, caFile?: string, handshakeMs = 5000) => {
    const conn = await tcpConnect(
      '127.0.0.1', port,
      caFile !== undefined
        ? { kind: 'tls', verify: true, caFile }
        : { kind: 'tls', verify: false },
      handshakeMs,
    );
    const got = new Promise<string>((resolve) => {
      conn.onData = (b) => resolve([...b].map((x) => x.toString(16)).join(' '));
    });
    conn.write(Uint8Array.from([0xff, 0xfb, 0x18]));
    const hex = await got;
    conn.close();
    return hex;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tn3270-tls-impl-'));
    certs = generateCerts(dir);
    await startBackend();
    proxy = await startTlsProxy({
      certPath: certs.certPath, keyPath: certs.keyPath,
      target: { host: '127.0.0.1', port: backendPort },
      onError: () => {},
    });
  });

  afterAll(async () => {
    await proxy?.close();
    await new Promise<void>((r) => backend.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a self-signed cert by default, and says how to proceed', async () => {
    await expect(tcpConnect('127.0.0.1', proxy.port)).rejects.toThrow(/-cafile/);
  });

  it('connects with -noverifycert and carries 3270 traffic', async () => {
    expect(await roundTrip(proxy.port)).toBe('ff fd 18');
  });

  it('connects with -cafile, which is what proves verification was really on', async () => {
    // The default rejection above and this success together establish it: if
    // verification were off, the default would have connected; if the CA were
    // ignored, this would have failed.
    expect(await roundTrip(proxy.port, certs.certPath)).toBe('ff fd 18');
  });

  it('explains an unreadable -cafile instead of failing obscurely', async () => {
    await expect(
      tcpConnect('127.0.0.1', proxy.port, { kind: 'tls', verify: true, caFile: join(dir, 'nope.pem') }),
    ).rejects.toThrow(/cannot be read/);
  });

  it('DOES NOT DROP AN IDLE SESSION once the handshake is done', async () => {
    // The regression test for `sock.setTimeout(0)` on secureConnect. `timeout` is
    // an inactivity timer, so leaving it armed kills a session while the user is
    // reading the screen. Deadline of 250 ms, idle for 4x that.
    const conn = await tcpConnect(
      '127.0.0.1', proxy.port, { kind: 'tls', verify: false }, 250,
    );
    let died: Error | undefined;
    let closed = false;
    conn.onError = (e) => { died = e; };
    conn.onClose = () => { closed = true; };
    await new Promise((r) => setTimeout(r, 1000));
    expect(died).toBeUndefined();
    expect(closed).toBe(false);
    // Still usable, not merely un-errored.
    const got = new Promise<boolean>((resolve) => { conn.onData = () => resolve(true); });
    conn.write(Uint8Array.from([0xff, 0xfb, 0x18]));
    expect(await got).toBe(true);
    conn.close();
  });

  it('gives the -insecure message on a plaintext host instead of hanging', async () => {
    // The trap the whole design turns on: this host never answers the handshake,
    // so without the deadline this test would hang forever rather than fail.
    const stub = net.createServer((s) => {
      s.on('error', () => {});
      // The `data` listener is what resumes the socket. Without it the stub stays
      // paused, never processes our FIN, and `stub.close()` below waits forever
      // for a connection that will not end — which looks exactly like the client
      // hanging, and cost one confused test run.
      s.on('data', () => {});
      s.write(Uint8Array.from([0xff, 0xfd, 0x28]));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as net.AddressInfo).port;
    try {
      const started = Date.now();
      await expect(
        tcpConnect('127.0.0.1', port, { kind: 'tls', verify: false }, 300),
      ).rejects.toThrow(/-insecure/);
      // Asserting it was the DEADLINE that ended this, not a lucky error: a
      // plaintext host that goes quiet produces no error of its own at all.
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });

  it('-insecure connects to that same plaintext host', async () => {
    const stub = net.createServer((s) => {
      s.on('data', () => s.write(Uint8Array.from([0xff, 0xfd, 0x18])));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as net.AddressInfo).port;
    try {
      const conn = await tcpConnect('127.0.0.1', port, { kind: 'plaintext' });
      const got = new Promise<boolean>((resolve) => { conn.onData = () => resolve(true); });
      conn.write(Uint8Array.from([0xff, 0xfb, 0x18]));
      expect(await got).toBe(true);
      conn.close();
    } finally {
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });
});
