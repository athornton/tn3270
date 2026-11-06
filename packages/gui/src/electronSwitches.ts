/**
 * Chromium switches this app is launched with, stripped before OUR parser sees argv.
 *
 * HERE AND NOT IN main.ts for the reason `planStartup` is in connectDialog.ts: main.ts imports
 * `electron`, which vitest cannot load.
 *
 * Listed explicitly rather than filtered by a `--` prefix rule, because our own
 * `--terminal-type` takes a VALUE: a prefix rule either eats that value or needs to know
 * about it, and both readings were wrong in the first draft of this file. Anything not
 * named here still reaches `parseGuiArgs`, so an unrecognized flag is still an error --
 * silently swallowing one is what produces a session that negotiates something nobody
 * asked for.
 */
export const ELECTRON_SWITCHES: ReadonlySet<string> = new Set([
  '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--disable-dev-shm-usage', '--enable-logging', '--in-process-gpu',
]);

/**
 * Switches that carry their value after `=` in the SAME argument, matched by this prefix. Only
 * the `=` form: a separate-argument value (`--user-data-dir /x`) would leave `/x` behind for
 * `parseGuiArgs` to read as the host. Chromium itself parses switches only in the `=` form.
 *
 * `--user-data-dir=<dir>`: Electron's userData (and Chromium's profile) directory -- the smoke
 * scripts give every launch a fresh one so a test run never writes the user's real app data.
 */
export const ELECTRON_VALUE_SWITCHES: readonly string[] = ['--user-data-dir='];

/** `argv` without the Electron/Chromium switches above; an empty `=` value is NOT stripped. */
export function stripElectronSwitches(argv: readonly string[]): string[] {
  return argv.filter((a) => !ELECTRON_SWITCHES.has(a)
    && !ELECTRON_VALUE_SWITCHES.some((p) => a.startsWith(p) && a.length > p.length));
}
