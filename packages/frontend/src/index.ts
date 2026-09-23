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

// The virtual keypad's key set, as data. Here rather than in `canvas` because the TUI's
// overlay offers the same keys and `tui` cannot import `canvas` -- two lists of 47 keys
// would drift silently. Pure data: no pixels, no cells-to-pixels arithmetic.
export { KEYPAD_KEYS, KEYPAD_ROWS, KEYPAD_KEY_WIDTH } from './keypad.js';
export type { KeypadKey } from './keypad.js';

// The action dispatch. The one translation from a named action onto the session that
// every front end needs and none should own -- the CLI's command table, the TUI's keymap
// and the GUI's KeyboardEvent mapper all produce these same names.
export { applyAction } from './actions.js';

// Which key means which action, in words. Documentation with a test rather than a code
// generator: each front end satisfies it in its own encoding, and bindings.test.ts checks
// the terminal keymap actually agrees.
export { BINDING_INTENT } from './bindings.js';
export type { Binding } from './bindings.js';

// The display palettes. Shared because a front end's colours are a presentation choice that
// must not differ BETWEEN front ends -- the GUI drew core's saturated primaries while the
// TUI had its own gentler table, and a user reported the blue as unreadable. Core keeps the
// architected meaning; this decides what gets drawn.
export { SCHEMES, SCHEME_NAMES, DEFAULT_SCHEME, resolveScheme, schemeRgb } from './palette.js';
export type { Scheme, Slot } from './palette.js';

// IND$FILE transfer's host-independent half: keyword validation and command construction.
// Here rather than in `cli` because the TUI must be able to validate a transfer request and
// `tui` deliberately does not depend on `cli` -- severing that dependency was the point of
// creating this package. The Node-coupled half (`TransferFiles` over `node:fs`) lives in
// `@tn3270/node-files`, so this stays safe for the browser bundles in `gui` and `web`.
export {
  parseTransferKeywords, transferCommand, dialectFor,
  TSO_DIALECT, VM_DIALECT, TransferOptionError, IND_FILE,
} from './transfer.js';
export type {
  TransferFiles, TransferRequest, Dialect,
  FtHostType, FtMode, FtCr, FtExist, FtRecfm,
} from './transfer.js';
