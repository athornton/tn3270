/**
 * Screenshot goldens for the GUI, under Xvfb.
 *
 * ## WHY THE GOLDENS COME FROM A REPLAYED TRACE AND NEVER FROM A LOGON
 *
 * Goldens live in git forever. A capture of a live session can contain a typed PASSWORD --
 * `docs/live-testing.md` already warns that traces carry passwords in EBCDIC, and a picture
 * is no different. It also cannot be reproducible if the host paints a clock, which TK5's
 * VTAM logon panel does: that exact trap produced a false "DIFFERS" on the stage 2b
 * comparison. `synthetic-ispf-like.trace` has neither problem and is identical every run.
 *
 * ## WHAT IS COMPARED, AND WHY IT IS NOT THE PNG
 *
 * The hash of the RAW BITMAP. Rendering is deterministic -- bitmap glyphs at integer scale
 * with smoothing off, no hinting, no subpixel antialiasing -- but the PNG encoder is not part
 * of that promise and may change between Electron versions. Comparing the encoded file would
 * break the suite on an upgrade and teach people to run `--update` without looking, which is
 * how a golden stops being evidence. The PNG is written too, so a human can see WHAT changed.
 *
 * If comparison ever proves genuinely unstable, DO NOT add a pixel tolerance: find out why,
 * or demote these to a "not blank" smoke check and let the draw-list tests carry the weight.
 * A tolerance that hides a one-pixel regression is worse than no golden.
 *
 *     node packages/gui/scripts/shot.mjs [--update]
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const goldenDir = join(here, '..', 'test', 'golden');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const main = join(here, '..', 'dist', 'main.js');

/**
 * The client's argv, as one constant so the guard test has a single thing to pin.
 *
 * `-insecure` IS MANDATORY even though these runs replay a trace and open no socket: the
 * moment someone points this harness at a real host, default-on TLS against a plaintext
 * Hercules does not fail, it HANGS. That silently broke every harness in this repo once
 * already -- pty-smoke.py sat at 1/12 for two days -- so the flag goes in now, and
 * packages/gui/test/shot-flags.test.ts pins it.
 *
 * `--no-sandbox --disable-gpu` are Electron's: there is no GL on this box, and without
 * --disable-gpu a hidden window HANGS rather than failing.
 */
const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E'];

const CASES = [
  {
    name: 'synthetic-ispf',
    trace: join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace'),
    // Not a real host: the trace is replayed, so nothing is dialled. A parseable target is
    // still required because the host argument is mandatory in every front end.
    host: '127.0.0.1:1',
  },
];

const update = process.argv.includes('--update');

/** Start Xvfb if there is no display, and PROVE it came up before trusting DISPLAY. */
function ensureDisplay() {
  if (process.env.DISPLAY) return process.env.DISPLAY;
  const gui = join(process.env.HOME ?? '', 'micromamba', 'envs', 'gui');
  const sock = '/tmp/.X11-unix/X99';
  if (!existsSync(sock)) {
    // Detached, because a backgrounded child dies with the shell that started it -- and the
    // symptom is Electron reporting "Missing X server" WITH DISPLAY set, which reads as
    // misconfiguration rather than as a dead server. Cost two runs to spot.
    spawn(join(gui, 'bin', 'Xvfb'), [':99', '-screen', '0', '1280x1024x24'],
      { detached: true, stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: join(gui, 'lib') } })
      .unref();
    const deadline = Date.now() + 15000;
    while (!existsSync(sock) && Date.now() < deadline) spawnSync('sleep', ['0.2']);
  }
  if (!existsSync(sock)) throw new Error('Xvfb did not create /tmp/.X11-unix/X99');
  return ':99';
}

function run(kase) {
  const gui = join(process.env.HOME ?? '', 'micromamba', 'envs', 'gui');
  const shot = join('/tmp', `tn3270-shot-${kase.name}.png`);
  const result = spawnSync(electron, [main, ...ARGV, kase.host], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      DISPLAY: ensureDisplay(),
      LD_LIBRARY_PATH: join(gui, 'lib'),
      FONTCONFIG_PATH: join(gui, 'etc', 'fonts'),
      FONTCONFIG_FILE: join(gui, 'etc', 'fonts', 'fonts.conf'),
      TN3270_GUI_REPLAY: kase.trace,
      TN3270_GUI_SHOT: shot,
      TN3270_GUI_SHOT_MS: '2500',
    },
  });
  const rendererErrors = (result.stdout ?? '').split('\n').filter((l) => l.startsWith('renderer[3]'));
  return { shot, hash: `${shot}.sha256`, rendererErrors, stdout: result.stdout ?? '' };
}

let failed = 0;
mkdirSync(goldenDir, { recursive: true });

for (const kase of CASES) {
  const { shot, hash, rendererErrors, stdout } = run(kase);

  if (!existsSync(shot) || !existsSync(hash)) {
    console.log(`FAIL     ${kase.name}: no capture produced`);
    process.stdout.write(stdout);
    failed++;
    continue;
  }
  // A renderer exception produces a BLANK window and a perfectly valid PNG, so the absence
  // of console errors is part of the pass condition rather than a nicety.
  if (rendererErrors.length > 0) {
    console.log(`FAIL     ${kase.name}: the renderer threw`);
    for (const line of rendererErrors) console.log(`         ${line}`);
    failed++;
    continue;
  }
  // And a golden that is uniformly black would match itself forever. ~3 KB is the observed
  // size of a real screen; a blank 800x600 compresses to well under 1 KB.
  if (statSync(shot).size < 1500) {
    console.log(`FAIL     ${kase.name}: the capture looks blank (${statSync(shot).size} bytes)`);
    failed++;
    continue;
  }

  const goldenPng = join(goldenDir, `${kase.name}.png`);
  const goldenHash = join(goldenDir, `${kase.name}.sha256`);
  const got = readFileSync(hash, 'utf8').trim();

  if (update || !existsSync(goldenHash)) {
    copyFileSync(shot, goldenPng);
    copyFileSync(hash, goldenHash);
    console.log(`updated  ${kase.name} (${got.slice(0, 12)})`);
    continue;
  }

  const want = readFileSync(goldenHash, 'utf8').trim();
  if (got === want) {
    console.log(`ok       ${kase.name}`);
  } else {
    failed++;
    console.log(`FAIL     ${kase.name}: pixels differ`);
    console.log(`         golden ${want.slice(0, 16)}`);
    console.log(`         actual ${got.slice(0, 16)}`);
    console.log(`         look at ${shot} beside ${goldenPng}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} goldens matched`);
process.exit(failed > 0 ? 1 : 0);
