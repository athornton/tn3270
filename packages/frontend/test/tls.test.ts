import { describe, it, expect } from 'vitest';
import net from 'node:net';
import { resolveTls, describeTlsError, tcpConnect, type TlsFlags } from '../src/tls.js';
import { resolveHostSpec } from '../src/hostspec.js';

/**
 * Design: docs/superpowers/specs/2026-08-25-tls-support-design.md
 *
 * MOVED HERE FROM packages/cli/test/tls.test.ts by the frontend extraction, assertions
 * unchanged. What stayed behind, and why, because the division is not arbitrary:
 *
 *  - the "both front ends" cases need the TUI's and CLI's own arg parsers, and a test
 *    here that imported them would make this package's tests depend on the packages that
 *    depend on IT;
 *  - the `tcpConnect over a real TLS proxy` cases drive
 *    `packages/cli/scripts/tls-proxy.mjs`, whose path is documented in the live-host
 *    runbook, so the tests stay with the harness they run.
 *
 * The error factory is a local class rather than the CLI's `UsageError`, for the same
 * no-upward-dependency reason. Every assertion below is on the MESSAGE, never the type,
 * so nothing is weakened -- injecting the constructor is what the API is for.
 */
class UsageError extends Error {}
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

  /**
   * A DIALOG LAUNCH HAS NO COMMAND LINE TO ADD `-insecure` TO, so the remedy names the checkbox.
   * Spec 2026-11-05-packaging-design.md section 2, "TLS hang".
   */
  describe('the Connect dialog remedy', () => {
    const plaintextCodes = [
      'HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG',
    ] as const;

    it.each(plaintextCodes)('%s names the TLS checkbox and not -insecure', (code) => {
      const msg = describeTlsError(code, 'vm', 3270, 'dialog');
      expect(msg).toMatch(/untick TLS in the Connect dialog/i);
      expect(msg).not.toMatch(/-insecure/);
      expect(msg).toMatch(/vm:3270/);
    });

    it.each(plaintextCodes)('%s puts the remedy FIRST, where truncation cannot eat it', (code) => {
      expect(describeTlsError(code, 'vm', 3270, 'dialog')).toMatch(/^Untick TLS in the Connect dialog/);
    });

    it.each(plaintextCodes)('%s is unchanged with the default and with an explicit flag', (code) => {
      const byDefault = describeTlsError(code, 'vm', 3270);
      expect(byDefault).toMatch(/use -insecure\.$/);
      expect(byDefault).not.toMatch(/Connect dialog/);
      expect(describeTlsError(code, 'vm', 3270, 'flag')).toBe(byDefault);
    });

    it('keeps the two causes distinct in the dialog wording too', () => {
      expect(describeTlsError('HANDSHAKE_TIMEOUT', 'vm', 3270, 'dialog'))
        .toMatch(/never completed a TLS handshake/);
      expect(describeTlsError('ERR_SSL_WRONG_VERSION_NUMBER', 'vm', 3270, 'dialog'))
        .toMatch(/not TLS/);
    });
  });
});

/**
 * THE CODE TRAVELS WITH THE ERROR, which is what lets a front end re-word the remedy.
 *
 * `tcpConnect` rejects with `describeTlsError`'s FLAG wording already in the message, so without the
 * code a caller that knows the session came from the GUI's Connect dialog has nothing to re-describe
 * from: main.ts's `explain()` read `err.code`, found it undefined for every TLS failure, and returned
 * the `-insecure` text -- measured 2026-11-06 against a silent stub, before this was added.
 */
describe('tcpConnect TLS failures carry their code', () => {
  it('a stalled handshake rejects with code HANDSHAKE_TIMEOUT and the flag wording', async () => {
    const stub = net.createServer((s) => { s.on('data', () => {}); });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as net.AddressInfo).port;
    try {
      const err = await tcpConnect('127.0.0.1', port, { kind: 'tls', verify: false }, 200)
        .then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe('HANDSHAKE_TIMEOUT');
      expect((err as Error).message).toBe(describeTlsError('HANDSHAKE_TIMEOUT', '127.0.0.1', port));
    } finally {
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });

  it('a plaintext answer rejects with the TLS library code', async () => {
    // A 3270 host speaks first with telnet negotiation, which is not a TLS record.
    const stub = net.createServer((s) => {
      s.on('data', () => {});
      s.write(Buffer.from('HTTP/1.0 400 not tls at all\r\n\r\n'));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as net.AddressInfo).port;
    try {
      const err = await tcpConnect('127.0.0.1', port, { kind: 'tls', verify: false }, 2000)
        .then(() => undefined, (e: unknown) => e);
      const code = (err as { code?: string }).code;
      expect(code).toMatch(/^ERR_SSL_/);
      expect((err as Error).message).toBe(describeTlsError(code, '127.0.0.1', port));
    } finally {
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });
});
