import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { readFileSync } from 'node:fs';
import type { Connection } from '@tn3270/core';

/**
 * TLS for the host connection, and the flags that select it.
 *
 * Separate from runner.ts for two reasons: runner.ts is already long and has one
 * job (command semantics), and this file needs `node:fs` to read a CA file,
 * which runner.ts deliberately does without so its commands stay testable with
 * no temp directory.
 *
 * `packages/core` is untouched by all of this. `Session` takes an injected
 * `connect: (host, port) => Connection` (core/src/session.ts), so the protocol
 * layer never learns that TLS exists — it is handed a `Connection` that happens
 * to be encrypted. Design: docs/superpowers/specs/2026-08-25-tls-support-design.md
 */

/**
 * How the socket is made. A discriminated union, so that once flags are
 * resolved, a contradictory combination cannot be represented at all.
 */
export type TlsOptions =
  | { readonly kind: 'plaintext' }
  | { readonly kind: 'tls'; readonly verify: boolean; readonly caFile?: string };

/** TLS on, verified against the system trust store. The product default. */
export const DEFAULT_TLS: TlsOptions = Object.freeze({ kind: 'tls', verify: true });

/**
 * How long the TLS handshake may stall before we give up and say so.
 *
 * NOT optional, and not a nicety. A plaintext 3270 host does not reject a TLS
 * handshake — IT HANGS. Hercules writes `IAC DO TN3270E` and waits; OpenSSL
 * reads that leading 0xff as a record content type and blocks for a length that
 * never arrives. Measured 2026-08-25 and pinned by test/tls-harness.test.ts.
 * Without this deadline, `tn3270 localhost:3270` under a TLS default appears to
 * do nothing whatsoever.
 *
 * 10 s because a handshake is two round trips and these hosts are on a LAN or
 * loopback, while a genuinely slow link should not be called dead too early.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Raw flag state, before conflicts are resolved. */
export interface TlsFlags {
  insecure?: boolean;
  /** Undefined means "not mentioned", which resolves to verifying. */
  verify?: boolean;
  caFile?: string;
}

/** Usage text for the TLS flags, shared so the two front ends cannot drift. */
export const TLS_USAGE = '[-insecure] [-noverifycert] [-verifycert] [-cafile FILE]';

/**
 * Consumes a TLS flag if `flag` is one, returning how many extra argv entries it
 * ate; returns undefined if the flag is none of ours, so the caller's switch can
 * fall through to its own handling.
 *
 * Both front ends delegate here rather than each spelling the flags out, because
 * two copies of these rules is two things to keep in step — the mistake
 * `splitTarget`'s own comment was written to avoid.
 */
export function takeTlsFlag(
  flags: TlsFlags,
  flag: string,
  value: string | undefined,
  usageError: (message: string) => Error,
): number | undefined {
  switch (flag) {
    case '-insecure':
      flags.insecure = true;
      return 0;
    // s3270's spelling is `-noverifycert` (include/resources.h:583), which we
    // adopt for free compatibility; `-no-verify` is accepted because it is what
    // a person guesses.
    case '-noverifycert':
    case '-no-verify':
      flags.verify = false;
      return 0;
    case '-verifycert':
      flags.verify = true;
      return 0;
    case '-cafile':
      if (value === undefined) {
        throw usageError('-cafile needs a PEM file, e.g. -cafile /etc/ssl/host.pem');
      }
      flags.caFile = value;
      return 1;
    default:
      return undefined;
  }
}

/**
 * Turns raw flags into a `TlsOptions`, rejecting contradictions.
 *
 * Contradictions are usage errors rather than precedence rules on purpose. If
 * `-insecure -cafile x.pem` quietly picked a winner, half the people who typed
 * it would get the opposite of what they meant, and one of those two outcomes is
 * an unencrypted connection. Better to refuse.
 *
 * `usageError` is injected because each front end has its own `UsageError` class
 * and each maps it to exit status 2; throwing our own would need both catch
 * blocks widened.
 */
export function resolveTls(flags: TlsFlags, usageError: (message: string) => Error): TlsOptions {
  if (flags.insecure === true) {
    if (flags.verify !== undefined || flags.caFile !== undefined) {
      throw usageError(
        '-insecure disables TLS, so it cannot be combined with -verifycert, -noverifycert or -cafile',
      );
    }
    return { kind: 'plaintext' };
  }
  if (flags.verify === false && flags.caFile !== undefined) {
    throw usageError(
      '-noverifycert and -cafile contradict each other: -cafile verifies against that PEM, -noverifycert verifies nothing',
    );
  }
  const verify = flags.verify !== false;
  return flags.caFile !== undefined
    ? { kind: 'tls', verify, caFile: flags.caFile }
    : { kind: 'tls', verify };
}

/**
 * Explains a TLS failure in terms of the flag that would change it.
 *
 * This mapping is most of the feature's usability. A TLS failure against a
 * plaintext host is otherwise indistinguishable from a host being down, and the
 * fix — one flag — is not guessable from `ECONNRESET`.
 */
export function describeTlsError(code: string | undefined, host: string, port: number): string {
  switch (code) {
    case 'HANDSHAKE_TIMEOUT':
      return `${host}:${port} accepted the connection but never completed a TLS handshake. `
        + 'If it does not speak TLS — a Hercules or other vintage system — use -insecure.';
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'ERR_SSL_PACKET_LENGTH_TOO_LONG':
      return `${host}:${port} answered with something that is not TLS. `
        + 'It is almost certainly a plaintext host: use -insecure.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return `${host}:${port} presented a certificate that no trusted CA vouches for. `
        + 'Prefer -cafile FILE with a copy of its certificate, which still authenticates the '
        + 'host; -noverifycert also connects but authenticates nothing.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `${host}:${port} presented a valid certificate issued for a different name. `
        + 'Connect using the name on the certificate, or -noverifycert to ignore the mismatch.';
    case 'CERT_HAS_EXPIRED':
      return `${host}:${port} presented an expired certificate. `
        + 'Use -cafile with a current copy, or -noverifycert to ignore the expiry.';
    default:
      return `TLS connection to ${host}:${port} failed${code !== undefined ? ` (${code})` : ''}.`;
  }
}

/** Wraps a socket as the `Connection` the core session consumes. */
function adapt(sock: import('node:net').Socket): Connection {
  const conn: Connection = {
    write: (b) => { sock.write(b); },
    close: () => { sock.destroy(); },
    onData: undefined,
    onClose: undefined,
    onError: undefined,
  };
  sock.on('data', (b: Buffer) => conn.onData?.(new Uint8Array(b)));
  sock.on('close', () => conn.onClose?.());
  return conn;
}

/**
 * Opens a connection to the host, encrypted or not.
 *
 * The plaintext path is byte-for-byte the behaviour that shipped before TLS
 * existed, so `-insecure` is a true escape hatch rather than a differently
 * configured TLS path.
 */
export function tcpConnect(
  host: string,
  port: number,
  options: TlsOptions = DEFAULT_TLS,
  handshakeMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<Connection> {
  if (options.kind === 'plaintext') {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ host, port });
      const conn = adapt(sock);
      sock.on('error', (e: Error) => { conn.onError?.(e); reject(e); });
      sock.on('connect', () => resolve(conn));
    });
  }

  let ca: Buffer | undefined;
  if (options.caFile !== undefined) {
    try {
      ca = readFileSync(options.caFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Promise.reject(new Error(`-cafile ${options.caFile} cannot be read: ${msg}`));
    }
  }

  return new Promise((resolve, reject) => {
    const sock = tlsConnect({
      host,
      port,
      rejectUnauthorized: options.verify,
      ...(ca !== undefined ? { ca: [ca] } : {}),
      // Doubles as the handshake deadline: measured to fire on a stalled
      // handshake, so no second timer is needed.
      timeout: handshakeMs,
    });
    const conn = adapt(sock);
    let settled = false;
    const fail = (code: string | undefined, err?: Error) => {
      if (settled) return;
      settled = true;
      const e = new Error(describeTlsError(code, host, port), { cause: err });
      conn.onError?.(e);
      sock.destroy();
      reject(e);
    };

    sock.on('timeout', () => { fail('HANDSHAKE_TIMEOUT'); });
    sock.on('error', (e: NodeJS.ErrnoException) => {
      // After a successful handshake this is an ordinary mid-session socket
      // error, which belongs to the session, not to connect().
      if (settled) { conn.onError?.(e); return; }
      fail(e.code ?? e.message, e);
    });
    sock.on('secureConnect', () => {
      // MANDATORY. `timeout` is an INACTIVITY timer, not a handshake timer: a
      // 3270 session is idle for as long as the user is reading the screen, so
      // leaving it armed would drop live sessions at think-time. There is a
      // regression test for exactly this, because it is the line an implementer
      // would naturally omit.
      sock.setTimeout(0);
      settled = true;
      resolve(conn);
    });
  });
}
