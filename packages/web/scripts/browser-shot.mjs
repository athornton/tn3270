/**
 * Does the SERVED page draw the same pixels as the Electron app?
 *
 * ## WHY THIS IS THE CHECK THAT PROVES REUSE
 *
 * The whole design claim for this branch is that `renderer.ts` is reused UNMODIFIED -- Electron
 * hands it a four-function bridge over IPC, the gateway hands it the same four functions over a
 * WebSocket, and nothing in between knows the difference. Every other test in `packages/web` could
 * pass with a SECOND renderer that merely behaved similarly. Identical pixels cannot.
 *
 * So identical pixels are the EXPECTED result, not a hoped-for one: same renderer, same atlas baked
 * from the same BDF, same scheme, same integer scale, smoothing off. The goldens compared against
 * are the GUI's own -- `packages/gui/test/golden/*.sha256` -- deliberately not second goldens of our
 * own, because two goldens can drift apart while both stay green.
 *
 * ## AND WHY THERE IS MORE THAN ONE CASE
 *
 * The KEYPAD is the part of the drawing the two front ends could most easily disagree about: its
 * on/off flag is the one piece of display state each front end holds FOR ITSELF -- per window in
 * Electron (`gui/src/main.ts:279`), per connection in the gateway (`web/src/main.ts:147`) -- and its
 * cells and buttons come from `canvas` while the toggle that reveals them does not. A single
 * keypad-less case would have compared only the parts nothing owns separately.
 *
 * ## WHAT IS COMPARED
 *
 * The hash of the RAW BITMAP, exactly as `shot.mjs` does it and for the same reason: rendering is
 * deterministic, but the PNG encoder is not part of that promise and may change between Electron
 * versions. If this ever differs, DO NOT add a pixel tolerance -- that is how a golden stops being
 * evidence. Diagnose the content size, the integer scale, the scheme and the device pixel ratio, in
 * that order.
 *
 * The trace is replayed, so no host is dialled and no capture can contain a password.
 *
 *     node packages/web/scripts/browser-shot.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiEnv } from '../../gui/scripts/xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const guiMain = join(repo, 'packages', 'gui', 'dist', 'main.js');
const webMain = join(repo, 'packages', 'web', 'dist', 'main.js');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');
const goldenDir = join(repo, 'packages', 'gui', 'test', 'golden');

/**
 * Each case names a GUI GOLDEN and the chords needed to reproduce it in a browser.
 *
 * `keys` IS PART OF THE CASE, not of the harness: `synthetic-ispf-keypad` is a picture of a keypad,
 * and `Ctrl+K` is the only thing that shows one -- there is no URL, flag or setting that starts a
 * page with the keypad up, deliberately (`web/src/main.ts:147`). So the chord that reveals it is as
 * much part of reproducing that golden as the trace is. Empty for the first case, and empty is also
 * the DEFAULT below, so no case picks up keys by accident.
 */
const CASES = [
  { golden: 'synthetic-ispf', keys: '' },
  { golden: 'synthetic-ispf-keypad', keys: 'Ctrl+K' },
];

/** `--no-proxy-server`: measured, Chromium routes even loopback through HTTP_PROXY. See browser-keys.mjs. */
const ELECTRON_ARGV = ['--no-sandbox', '--disable-gpu', '--no-proxy-server'];
const SERVER_ARGV = ['--replay', trace, '--listen', '0', '127.0.0.1:3270'];

/**
 * A refusal to even start. It exits, so it may only be used BEFORE the gateway is spawned:
 * `process.exit` does NOT run `finally` blocks -- measured -- so an exit after that point would
 * orphan a listening gateway however carefully the teardown were written. Everything that can go
 * wrong once a case is running counts a failure and returns instead.
 */
const refuse = (why, extra = '') => {
  console.log(`FAIL     ${why}`);
  if (extra !== '') console.log(extra);
  process.exit(1);
};

for (const f of [guiMain, webMain]) {
  if (!existsSync(f)) refuse(`there is no ${f}`, '         run: npm run build');
}
for (const kase of CASES) {
  for (const f of [join(goldenDir, `${kase.golden}.png`), join(goldenDir, `${kase.golden}.sha256`)]) {
    if (!existsSync(f)) refuse(`there is no ${f}`, '         run: node packages/gui/scripts/shot.mjs --update');
  }
}

const server = spawn(process.execPath, [webMain, ...SERVER_ARGV]);
let serverOut = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let failed = 0;
/** Reports one case's failure and lets the run continue, so the second case still says something. */
const fail = (kase, why, extra = '') => {
  failed += 1;
  console.log(`FAIL     ${kase.golden}: ${why}`);
  if (extra !== '') console.log(extra);
};

/**
 * One case: size the window from ITS golden, type ITS keys, compare against ITS hash.
 *
 * THE GOLDEN DEFINES THE GEOMETRY, read out of its own IHDR.
 *
 * The alternative was to recompute `bestScale` here, which would put a second copy of the sizing
 * rule in a harness -- and if that copy drifted, this check would compare two differently-sized
 * renderings and report a rendering change. Bytes 16..24 of a PNG are width and height. It is also
 * what makes the taller keypad case size itself: 720x434 rather than 720x350, from the file.
 */
async function runCase(kase, url) {
  const goldenPng = join(goldenDir, `${kase.golden}.png`);
  const goldenHash = join(goldenDir, `${kase.golden}.sha256`);
  const png = readFileSync(goldenPng);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width === 0 || height === 0) { fail(kase, `could not read a size out of ${goldenPng}`); return; }

  const shot = `/tmp/tn3270-browser-shot-${kase.golden}.png`;
  // DELETED FIRST, because the checks below ask whether a capture EXISTS: a run that captured
  // nothing would otherwise be compared against the file a previous run left at this path, and a
  // stale pass is the failure mode this whole harness exists to avoid.
  rmSync(shot, { force: true });
  rmSync(`${shot}.sha256`, { force: true });

  // ASYNC spawn, never spawnSync: it blocks the event loop, so this process would stop reading the
  // gateway's pipe while the browser ran. See the measurement in browser-keys.mjs.
  const result = await new Promise((resolveP) => {
    const child = spawn(electron, [guiMain, ...ELECTRON_ARGV], {
      env: guiEnv({
        TN3270_GUI_URL: url,
        TN3270_GUI_SHOT: shot,
        TN3270_GUI_SHOT_MS: '3000',
        TN3270_GUI_SIZE: `${width}x${height}`,
        // DEFAULTS TO CLEARED, not merely unset: a stray TN3270_GUI_KEYS in the caller's shell would
        // type into the capture, and a golden that depends on the operator's environment is not a
        // golden. A case may ASK for keys -- see CASES -- and `?? ''` is what keeps that from
        // becoming a hole for every case that does not.
        TN3270_GUI_KEYS: kase.keys ?? '',
      }),
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 120000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveP({ error, stdout: out, stderr: err, status: null, signal: null });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveP({ stdout: out, stderr: err, status, signal });
    });
  });

  if (result.error !== undefined) { fail(kase, 'the browser never ran to completion', `         ${result.error.message}`); return; }
  if (result.signal !== null) { fail(kase, `the browser was killed by ${result.signal}`, result.stdout); return; }
  if (result.status !== 0) { fail(kase, `the browser exited ${result.status}`, result.stdout); return; }
  // A case that asks for keys and gets none would compare a keypad-less capture against a keypad
  // golden -- a real failure, but reported as "pixels differ", which sends the reader to the
  // renderer instead of to the seam. `browser-keys.mjs` guards its own run the same way.
  if (kase.keys !== '' && !result.stdout.includes(`keys: sent ${kase.keys}`)) {
    fail(kase, `the keys seam never reported sending ${kase.keys}`, result.stdout);
    return;
  }

  // A renderer exception produces a BLANK window and a perfectly valid PNG, so the absence of
  // console errors is part of the pass condition rather than a nicety.
  const rendererErrors = result.stdout.split('\n').filter((l) => l.startsWith('renderer[3]'));
  if (rendererErrors.length > 0) { fail(kase, 'the renderer threw', rendererErrors.map((l) => `         ${l}`).join('\n')); return; }

  if (!existsSync(shot) || !existsSync(`${shot}.sha256`)) {
    fail(kase, 'no capture produced', `${result.stdout}\n--- the gateway said: ---\n${serverOut}`);
    return;
  }
  // A uniformly black capture would match another uniformly black capture forever. ~3 KB is the
  // observed size of a real screen; a blank one compresses to well under 1 KB.
  if (statSync(shot).size < 1500) { fail(kase, `the capture looks blank (${statSync(shot).size} bytes)`); return; }

  const got = readFileSync(`${shot}.sha256`, 'utf8').trim();
  const want = readFileSync(goldenHash, 'utf8').trim();
  if (got === want) {
    console.log(`ok       ${kase.golden}: the served page is pixel-identical to the GUI golden (${width}x${height})`);
    console.log(`         ${got.slice(0, 16)}  renderer.ts is genuinely shared, not merely duplicated`);
    return;
  }
  fail(kase, 'pixels differ from the GUI golden');
  console.log(`         golden ${want.slice(0, 16)}`);
  console.log(`         actual ${got.slice(0, 16)}`);
  console.log(`         look at ${shot} beside ${goldenPng}`);
  console.log('         DO NOT add a tolerance. Check, in order: the content size against the');
  console.log('         draw list; the integer scale bestScale chose; the -scheme (the golden is');
  console.log('         `default`); and the device pixel ratio.');
}

try {
  const url = await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`the gateway printed no URL:\n${serverOut}`)), 20000);
    server.on('exit', (code) => {
      clearTimeout(timer);
      rejectP(new Error(`the gateway exited ${code} before serving:\n${serverOut}`));
    });
    const check = () => {
      const m = /(https?:\/\/\S+)/.exec(serverOut);
      if (m !== null) { clearTimeout(timer); resolveP(m[1]); }
    };
    server.stdout.on('data', check);
    check();
  });

  // SEQUENTIALLY, not in parallel: two browsers under one Xvfb would race for the display, and
  // each case's Electron run also holds the whole 3s settle. One gateway serves both -- a second
  // `hello` with no session id creates a second replayed session, so the two cases cannot see each
  // other's keypad flag (`web/src/main.ts:147` explains why that flag dies with its socket).
  for (const kase of CASES) await runCase(kase, url);
} finally {
  // In a `finally`, which is now reachable: nothing inside the try calls `process.exit`, because
  // that skips `finally` blocks -- measured -- and would leave a gateway listening with a replayed
  // session open. `refuse` still exits, and only ever before this server exists.
  server.kill();
}

console.log(`\n${CASES.length - failed}/${CASES.length} cases matched the GUI's own goldens`);
process.exit(failed > 0 ? 1 : 0);
