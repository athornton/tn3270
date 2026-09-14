import { describe, it, expect } from 'vitest';
import { resolveTls, describeTlsError, type TlsFlags } from '../src/tls.js';
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
});
