/**
 * The launcher's decisions, as pure functions, so they can be tested without Electron.
 * `tn3270-gui.mjs` is the only caller; it does the I/O.
 */
import { constants } from 'node:os';

/** Signals the launcher forwards to Electron. SIGHUP is the terminal closing. */
export const FORWARDED = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP']);

/**
 * Signals worth RE-RAISING on the launcher when Electron died of one, so a parent shell or
 * harness sees "killed by SIGTERM" rather than an exit code. Anything else -- SIGTRAP from
 * Chromium's sandbox abort, SIGSEGV -- would make Node dump core if re-raised, so it becomes the
 * shell convention `128 + n` instead.
 */
const RERAISE = new Set(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGKILL']);

/**
 * What the launcher does once Electron has exited: `{ exit: n }` or `{ raise: signal }`.
 * `platform` is a parameter only for the tests.
 */
export function exitPlan(code, signal, platform = process.platform) {
  if (signal === null || signal === undefined) return { exit: code ?? 1 };
  // Windows has no signal delivery to itself worth the name: `process.kill(pid, sig)` there
  // terminates outright, so an exit code says more.
  if (platform !== 'win32' && RERAISE.has(signal)) return { raise: signal };
  return { exit: 128 + (constants.signals[signal] ?? 0) };
}

/** The message for `require('electron')` throwing: the binary was never downloaded, or failed. */
export function electronMissing(err) {
  return 'tn3270-gui: the Electron binary is not installed.\n'
    + `  (${err instanceof Error ? err.message : String(err)})\n`
    + '  Electron 44 downloads its ~100 MB binary on first use, so this means that download failed\n'
    + '  (no network, a proxy, or ELECTRON_MIRROR pointing somewhere wrong). Fix the network and\n'
    + '  run tn3270-gui again, or reinstall: npm install -g @tn3270/gui\n';
}

/** The message for a package whose `app/` bundle is incomplete. */
export function bundleMissing(path) {
  return `tn3270-gui: reinstall @tn3270/gui (npm install -g @tn3270/gui): ${path} is missing, `
    + 'so this install has no complete app bundle to run.\n';
}

/**
 * Printed after Electron dies of SIGTRAP on Linux, which is how Chromium's "SUID sandbox helper
 * binary was found, but is not configured correctly" abort arrives. Chromium's own FATAL line,
 * just above on stderr, names only the chown/chmod fix; this names the other two.
 */
export function sandboxHint(chromeSandbox) {
  return '\ntn3270-gui: Electron aborted. If the line above mentions the SUID sandbox helper, this\n'
    + "  system blocks unprivileged user namespaces, which Chromium's sandbox needs when\n"
    + '  chrome-sandbox is not setuid root (npm cannot install it setuid). Either, as root:\n'
    + `    chown root:root ${chromeSandbox} && chmod 4755 ${chromeSandbox}\n`
    + '  or run without the sandbox, at your own risk: tn3270-gui --no-sandbox ...\n';
}
