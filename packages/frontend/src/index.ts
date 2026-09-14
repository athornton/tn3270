/**
 * Rules shared by every front end: the host argument, the TLS flags, the session
 * factory, the keymap and the action dispatch.
 *
 * WHY THIS PACKAGE EXISTS. Two front ends already shared these by importing them from
 * `@tn3270/cli`, which was the wrong home the moment a third front end appeared: a GUI
 * has no business depending on the s3270 line protocol to find out what `-insecure`
 * means. Both defects fixed on 2026-08-28 were one rule with two homes -- `splitTarget`
 * beside `hostspec.ts`, and `-insecure` drifting between the two arg parsers until
 * `harness-flags.test.ts` pinned it.
 *
 * WHAT DOES NOT BELONG HERE. Anything a front end owns because of HOW it presents:
 * ANSI generation, SGR depth, canvas geometry, the s3270 reply format. If a symbol here
 * would be used by exactly one front end, it is in the wrong package.
 */

// The host argument's shape. Prefix meaning and port validation must be identical in
// every front end -- `N:` disabling TN3270E in one and not another would be the drift
// this package exists to prevent.
export { parseHostSpec, resolveHostSpec } from './hostspec.js';
export type { HostSpec, ResolvedHost } from './hostspec.js';

// The TLS flags. Every front end parses the same ones and must resolve them by the same
// rules -- they were already shared between two front ends for exactly this reason.
// `tcpConnect` comes too: it is the one transport all of them need.
export {
  takeTlsFlag, resolveTls, tcpConnect, describeTlsError,
  DEFAULT_TLS, HANDSHAKE_TIMEOUT_MS, TLS_USAGE,
} from './tls.js';
export type { TlsFlags, TlsOptions } from './tls.js';
