#!/usr/bin/env node
/**
 * Generates a short-lived self-signed certificate for TLS testing.
 *
 * NOTHING IS COMMITTED. A certificate checked into the repo expires and turns a
 * green suite red on a date nobody chose, in a commit that did not touch TLS.
 * Tests call `generateCerts(tmpdir)` instead, so the cert is always minutes old.
 *
 * The SAN matters: `subjectAltName` must carry both `DNS:localhost` and
 * `IP:127.0.0.1`, or a client that verifies against this cert as a pinned CA
 * fails hostname checking rather than chain checking, and the test reports the
 * wrong cause.
 *
 * Usage as a script (for live testing against a real host):
 *   node gen-test-certs.mjs [dir]        # defaults to the current directory
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** True if `openssl` can be run at all. Callers skip rather than fail. */
export function haveOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `cert.pem` and `key.pem` into `dir` and returns their paths plus the
 * certificate PEM itself, which is what a client needs as a trust anchor.
 */
export function generateCerts(dir, { days = 2, cn = 'localhost' } = {}) {
  mkdirSync(dir, { recursive: true });
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', String(days),
    '-subj', `/CN=${cn}`,
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'pipe' });
  return { certPath, keyPath, certPem: readFileSync(certPath) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!haveOpenssl()) {
    console.error('openssl not found on PATH');
    process.exit(1);
  }
  const dir = process.argv[2] ?? '.';
  const { certPath, keyPath } = generateCerts(dir);
  console.error(`wrote ${certPath} and ${keyPath}`);
}
