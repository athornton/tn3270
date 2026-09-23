/**
 * The CLI package's public surface, for other packages in this workspace.
 *
 * DELIBERATELY NOT re-exporting `main.ts`. That module calls `main()` at its top
 * level, so importing it *runs the CLI* -- an `export *` here would launch a
 * readline loop in whatever process imported this package. Anything in `main.ts`
 * that a second package needs (currently nothing) should move to a module that
 * has no side effects on import.
 *
 * `defaultSession` used to be the reason this file exists; it now lives in
 * `@tn3270/frontend` along with the rest of the shared front-end surface, so what is
 * left here is the s3270 line protocol: the `Runner` and the command parser. The
 * transfer types moved to `@tn3270/frontend`, which is where the TUI can reach them;
 * this package deliberately keeps no re-export shim for them.
 */

export { Runner } from './runner.js';
export type { RunnerOptions } from './runner.js';
export { parseCommand } from './commands.js';
