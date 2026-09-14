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

// The session factory. It wraps the TCP/TLS `Connection` adapter, which is the one
// transport every front end needs -- and it defaults to VERIFIED TLS, so it must not be
// reimplemented per front end where one copy could quietly default to plaintext.
export { defaultSession } from './session.js';

// The terminal keymap. Shared for its ACTION VOCABULARY, which every front end needs --
// the byte-sequence table itself is terminal-specific, and the GUI will have its own
// KeyboardEvent mapper beside it rather than a shared abstraction over both. See
// keymap.ts on why the table is MOVED here rather than generalised.
export { lookup, printableRun, isValidPf, PARTIAL, MAX_SEQUENCE_LENGTH } from './keymap.js';
export type { Action } from './keymap.js';

// The action dispatch. The one translation from a named action onto the session that
// every front end needs and none should own -- the CLI's command table, the TUI's keymap
// and the GUI's KeyboardEvent mapper all produce these same names.
export { applyAction } from './actions.js';
