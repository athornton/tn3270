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
 * from the same BDF, same scheme, same integer scale, smoothing off. The golden compared against is
 * the GUI's own -- `packages/gui/test/golden/synthetic-ispf.sha256` -- deliberately not a second
 * golden of our own, because two goldens can drift apart while both stay green.
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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiEnv } from '../../gui/scripts/xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const guiMain = join(repo, 'packages', 'gui', 'dist', 'main.js');
const webMain = join(repo, 'packages', 'web', 'dist', 'main.js');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');
const goldenPng = join(repo, 'packages', 'gui', 'test', 'golden', 'synthetic-ispf.png');
const goldenHash = join(repo, 'packages', 'gui', 'test', 'golden', 'synthetic-ispf.sha256');

/** `--no-proxy-server`: measured, Chromium routes even loopback through HTTP_PROXY. See browser-keys.mjs. */
const ELECTRON_ARGV = ['--no-sandbox', '--disable-gpu', '--no-proxy-server'];
const SERVER_ARGV = ['--replay', trace, '--listen', '0', '127.0.0.1:3270'];

const fail = (why, extra = '') => {
  console.log(`FAIL     ${why}`);
  if (extra !== '') console.log(extra);
  process.exit(1);
};

for (const f of [guiMain, webMain, goldenPng, goldenHash]) {
  if (!existsSync(f)) fail(`there is no ${f}`, '         run: npm run build (and shot.mjs for the golden)');
}

/**
 * THE GOLDEN DEFINES THE GEOMETRY, read out of its own IHDR.
 *
 * The alternative was to recompute `bestScale` here, which would put a second copy of the sizing
 * rule in a harness -- and if that copy drifted, this check would compare two differently-sized
 * renderings and report a rendering change. Bytes 16..24 of a PNG are width and height.
 */
const png = readFileSync(goldenPng);
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);
if (width === 0 || height === 0) fail(`could not read a size out of ${goldenPng}`);

const shot = '/tmp/tn3270-browser-shot.png';
const server = spawn(process.execPath, [webMain, ...SERVER_ARGV]);
let serverOut = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

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

  // ASYNC spawn, never spawnSync: it blocks the event loop, so this process would stop reading the
  // gateway's pipe while the browser ran. See the measurement in browser-keys.mjs.
  const result = await new Promise((resolveP) => {
    const child = spawn(electron, [guiMain, ...ELECTRON_ARGV], {
      env: guiEnv({
        TN3270_GUI_URL: url,
        TN3270_GUI_SHOT: shot,
        TN3270_GUI_SHOT_MS: '3000',
        TN3270_GUI_SIZE: `${width}x${height}`,
        // CLEARED, not merely unset: a stray TN3270_GUI_KEYS in the caller's shell would type into
        // the capture. A golden that depends on the operator's environment is not a golden.
        TN3270_GUI_KEYS: '',
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

  if (result.error !== undefined) fail('the browser never ran to completion', `         ${result.error.message}`);
  if (result.signal !== null) fail(`the browser was killed by ${result.signal}`, result.stdout);
  if (result.status !== 0) fail(`the browser exited ${result.status}`, result.stdout);

  // A renderer exception produces a BLANK window and a perfectly valid PNG, so the absence of
  // console errors is part of the pass condition rather than a nicety.
  const rendererErrors = result.stdout.split('\n').filter((l) => l.startsWith('renderer[3]'));
  if (rendererErrors.length > 0) fail('the renderer threw', rendererErrors.map((l) => `         ${l}`).join('\n'));

  if (!existsSync(shot) || !existsSync(`${shot}.sha256`)) {
    fail('no capture produced', `${result.stdout}\n--- the gateway said: ---\n${serverOut}`);
  }
  // A uniformly black capture would match another uniformly black capture forever. ~3 KB is the
  // observed size of a real screen; a blank one compresses to well under 1 KB.
  if (statSync(shot).size < 1500) fail(`the capture looks blank (${statSync(shot).size} bytes)`);

  const got = readFileSync(`${shot}.sha256`, 'utf8').trim();
  const want = readFileSync(goldenHash, 'utf8').trim();
  if (got === want) {
    console.log(`ok       the served page is pixel-identical to the GUI golden (${width}x${height})`);
    console.log(`         ${got.slice(0, 16)}  renderer.ts is genuinely shared, not merely duplicated`);
  } else {
    console.log('FAIL     pixels differ from the GUI golden');
    console.log(`         golden ${want.slice(0, 16)}`);
    console.log(`         actual ${got.slice(0, 16)}`);
    console.log(`         look at ${shot} beside ${goldenPng}`);
    console.log('         DO NOT add a tolerance. Check, in order: the content size against the');
    console.log('         draw list; the integer scale bestScale chose; the -scheme (the golden is');
    console.log('         `default`); and the device pixel ratio.');
    process.exit(1);
  }
} finally {
  // In a `finally` because every bail above exits: otherwise a failed run leaves a gateway
  // listening with a replayed session open.
  server.kill();
}
