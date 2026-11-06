#!/usr/bin/env node
/**
 * `tn3270-gui`: runs the bundled app (`../app/main.js`) under the Electron that npm installed
 * beside it, with the user's arguments. The decisions are in `launch.mjs`, tested without Electron.
 *
 * ## WHY NOT ELECTRON'S OWN BIN
 *
 * `electron/cli.js` forwards only SIGINT, SIGTERM and SIGUSR2 and never kills its child when it
 * dies itself, so a harness's SIGKILL in this repo orphaned the real binary to PID 1 (see
 * `scripts/xvfb.mjs`). This one forwards SIGINT/SIGTERM/SIGHUP, kills Electron if the launcher
 * exits first, and exits with Electron's code -- or re-raises its signal. A SIGKILL to the
 * launcher still cannot be forwarded (nothing can catch it); kill Electron's PID for that.
 *
 * ## THE SANDBOX IS LEFT ON -- MEASURED 2026-11-06, Electron 44.10.2, Rocky 9 kernel 5.14
 *
 * npm cannot install `chrome-sandbox` setuid root (here it is `athor 0755`). That does NOT stop
 * Electron: Chromium prefers the user-namespace sandbox and only falls back to the SUID helper
 * when namespaces are blocked. On this box the app ran and drew the golden pixels WITHOUT
 * `--no-sandbox`; forcing the SUID path (`--disable-namespace-sandbox`) reproduced the abort
 * ("SUID sandbox helper binary was found, but is not configured correctly"), exit by SIGTRAP.
 * So adding `--no-sandbox` automatically would switch the sandbox off on every system that can
 * run it, to help only those that block unprivileged namespaces (Ubuntu 23.10+ AppArmor, some
 * hardened kernels). Electron's own npm launcher (`electron/cli.js`, read 2026-11-06) makes the
 * same choice: it never adds `--no-sandbox`. The user passes it, or fixes the helper's ownership
 * (what distro packages of Electron apps do in a postinst). We print both remedies when Electron
 * dies of
 * SIGTRAP on Linux, and `--no-sandbox` on the command line passes straight through to Chromium
 * (main.ts strips it from what our own parser sees).
 *
 * ## WINDOWS -- NOT RUN THERE YET
 *
 * Node emulates SIGINT/SIGHUP delivery only from the console, and `child.kill()` there is
 * TerminateProcess whatever the signal, so forwarding degrades to "kill Electron when asked to
 * stop". Re-raising is replaced by an exit code (`exitPlan`), and `process.kill` is guarded.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORWARDED, bundleMissing, electronMissing, exitPlan, sandboxHint } from './launch.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..', 'app');
const main = join(app, 'main.js');

// BOTH, because bundle.mjs writes BUNDLED last: main.js without it is a bundle that failed its
// own self-check. Without this, Electron given a missing path opens its default window.
for (const f of [main, join(app, 'BUNDLED')]) {
  if (!existsSync(f)) {
    process.stderr.write(bundleMissing(f));
    process.exit(1);
  }
}

let electron;
try {
  // In Node, `require('electron')` is the binary's PATH -- and, in Electron 44, downloads the
  // binary first if npm's install never did. It throws if that download fails.
  electron = createRequire(import.meta.url)('electron');
} catch (err) {
  process.stderr.write(electronMissing(err));
  process.exit(1);
}

const child = spawn(electron, [main, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });

for (const sig of FORWARDED) {
  process.on(sig, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(sig);
  });
}
// Any way the launcher leaves before Electron does (an uncaught throw, process.exit elsewhere)
// takes Electron with it, so no path here orphans it.
process.on('exit', () => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});

child.on('error', (err) => {
  process.stderr.write(`tn3270-gui: cannot start Electron (${electron}): ${err.message}\n`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal === 'SIGTRAP' && process.platform === 'linux') {
    process.stderr.write(sandboxHint(join(dirname(electron), 'chrome-sandbox')));
  }
  const plan = exitPlan(code, signal);
  if ('exit' in plan) process.exit(plan.exit);
  // Our own handler for that signal would swallow it; drop it, then die of the same signal so the
  // parent sees what Electron died of.
  process.removeAllListeners(plan.raise);
  try {
    process.kill(process.pid, plan.raise);
  } catch {
    process.exit(1);
  }
});
