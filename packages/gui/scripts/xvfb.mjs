/**
 * Xvfb startup and the GL-less Electron environment this box needs.
 *
 * Shared by shot.mjs and keys.mjs so the two copies cannot drift -- and because the traps
 * below each cost a run to find and would be re-learned independently otherwise.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The userspace GUI stack: static micromamba env, no root, no system X. */
const GUI_ENV = join(process.env.HOME ?? '', 'micromamba', 'envs', 'gui');

const SOCKET = '/tmp/.X11-unix/X99';

/** Start Xvfb if there is no display, and PROVE it came up before trusting DISPLAY. */
export function ensureDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  if (!existsSync(SOCKET)) {
    // Detached, because a backgrounded child dies with the shell that started it -- and the
    // symptom is Electron reporting "Missing X server" WITH DISPLAY set, which reads as
    // misconfiguration rather than as a dead server. Cost two runs to spot.
    //
    // Tested by SOCKET and never by `pgrep -f "Xvfb :99"`, which matches the shell command
    // containing the pattern and so reports a server that was never started.
    spawn(join(GUI_ENV, 'bin', 'Xvfb'), [':99', '-screen', '0', '1280x1024x24'],
      { detached: true, stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: join(GUI_ENV, 'lib') } })
      .unref();
    // Forks a process per poll (up to ~75 over the deadline) because node has no synchronous
    // sleep; a fork every 0.2s is the price of not returning before Xvfb is actually up.
    const deadline = Date.now() + 15000;
    while (!existsSync(SOCKET) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
  }
  if (!existsSync(SOCKET)) throw new Error(`Xvfb did not create ${SOCKET}`);
  return ':99';
}

/**
 * The environment every Electron run here needs, plus whatever the caller adds. On a cold box
 * this starts a detached Xvfb :99 as a side effect, not just constructs a value -- and two
 * harnesses calling this at the same cold-start instant can both see no socket and both spawn
 * an Xvfb on :99, colliding on the display number. Harnesses run sequentially today, so this
 * hasn't been hit; if that stops being true, the fix is a lockfile around ensureDisplay().
 */
export function guiEnv(extra = {}) {
  return {
    ...process.env,
    DISPLAY: ensureDisplay(),
    LD_LIBRARY_PATH: join(GUI_ENV, 'lib'),
    FONTCONFIG_PATH: join(GUI_ENV, 'etc', 'fonts'),
    FONTCONFIG_FILE: join(GUI_ENV, 'etc', 'fonts', 'fonts.conf'),
    ...extra,
  };
}
