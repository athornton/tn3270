/**
 * The CLI package's public surface, for other packages in this workspace.
 *
 * DELIBERATELY NOT re-exporting `main.ts`. That module calls `main()` at its top
 * level, so importing it *runs the CLI* -- an `export *` here would launch a
 * readline loop in whatever process imported this package. Anything in `main.ts`
 * that a second package needs (currently nothing) should move to a module that
 * has no side effects on import.
 *
 * `defaultSession` is the reason this file exists: it wraps the TCP `Connection`
 * adapter, and the TUI needs exactly that one transport rather than a second copy
 * of the socket code.
 */

export { defaultSession, Runner, splitTarget } from './runner.js';
export type { RunnerOptions } from './runner.js';
// The TUI parses the same TLS flags and must resolve them by the same rules, so
// these are shared rather than reimplemented. See tls.ts.
export {
  takeTlsFlag, resolveTls, tcpConnect, describeTlsError,
  DEFAULT_TLS, HANDSHAKE_TIMEOUT_MS, TLS_USAGE,
} from './tls.js';
export type { TlsFlags, TlsOptions } from './tls.js';
export { parseCommand } from './commands.js';
export type { TransferFiles } from './transfer.js';
