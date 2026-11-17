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
/**
 * Chromium switches that take an `=value`, stripped only in that form with a non-empty value.
 *
 * `--force-device-scale-factor=` and `--force-color-profile=` make a screenshot reproducible across
 * displays: CI run 3 (2026-11-06) captured the golden on macos-26-intel at 1440x700 (scale 2) with
 * every green shifted by the display profile, while macOS arm64, Windows and Linux matched it
 * byte for byte. The smokes pass `=1` and `=srgb`, which is what the golden was recorded under.
 */
export const ELECTRON_VALUE_SWITCHES: readonly string[] = [
  '--user-data-dir=', '--force-device-scale-factor=', '--force-color-profile=',
];

/** `argv` without the Electron/Chromium switches above; an empty `=` value is NOT stripped. */
export function stripElectronSwitches(argv: readonly string[]): string[] {
  return argv.filter((a) => !ELECTRON_SWITCHES.has(a)
    && !ELECTRON_VALUE_SWITCHES.some((p) => a.startsWith(p) && a.length > p.length));
}

/**
 * The user's arguments from `process.argv`, with the Chromium switches above removed.
 *
 * `defaultApp` is `process.defaultApp`: true under `electron main.js ...` (npm's launcher and the
 * harnesses), whose argv is [electron, main.js, ...user]; unset in a PACKAGED app, whose argv is
 * [exe, ...user]. A fixed `slice(2)` dropped the packaged app's first argument, so `TN3270 host`
 * opened the Connect dialog -- and package smoke never saw it, because the argument it lost was a
 * Chromium switch that would have been stripped anyway.
 */
export function userArgv(argv: readonly string[], defaultApp: boolean | undefined): string[] {
  return stripElectronSwitches(argv.slice(defaultApp === true ? 2 : 1)).filter((a) => !PSN.test(a));
}

/**
 * macOS LaunchServices may append `-psn_<n>_<n>` (a process serial number) when Finder opens the
 * app, reportedly on the first launch of a quarantined download. `slice(2)` used to drop it by
 * accident; now that the packaged app keeps its first argument, it is dropped by name. Only that
 * exact shape: anything else still reaches `parseGuiArgs` and fails as an unknown flag.
 */
const PSN = /^-psn_\d+_\d+$/;
