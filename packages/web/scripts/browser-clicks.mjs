#!/usr/bin/env node
/**
 * Keypad guard for the WEB GATEWAY, under Xvfb: does clicking the overlay reach the host?
 *
 * ## WHAT THIS COVERS THAT NOTHING ELSE CAN
 *
 * The web keypad is a DOM OVERLAY over the canvas, built by the shared `createKeypadUi` and
 * toggled client-side. Three separate things have to work for a press to reach the gateway, and
 * before this harness existed NOTHING exercised any of them in a browser:
 *
 *  1. `Ctrl+K` reaching `bridgecore.ts`'s interception rather than the socket, and the overlay
 *     becoming visible. `browser-keys.mjs` can only assert the ABSENCE of a `toggleKeypad` on the
 *     wire -- which is necessary, and says nothing about whether anything appeared on screen.
 *  2. `index.html`'s IMPORT MAP resolving `@tn3270/canvas` and `@tn3270/frontend`, and
 *     `httpstatic.ts` actually serving all five modules behind them. MEASURED: one missing entry
 *     (`keypadOverlay.js`) made `bridge.js` fail to load entirely, so `window.tn3270` was never
 *     assigned and the error surfaced in RENDERER.JS -- `Cannot read properties of undefined
 *     (reading 'onAtlas')`, naming the wrong file. Unit tests cannot see a 404.
 *  3. A clicked button's action crossing the WebSocket and being applied by the gateway.
 *
 * `clicks.mjs` is the Electron twin of this and covers none of it: that one drives a separate
 * `BrowserWindow` loading from `file://`, where the import map's `../frontend/dist/...` paths are
 * real directories. A SERVED page's `..` is a URL the server must answer, which is the whole
 * difference and exactly where this harness earns its keep.
 *
 * ## IT CLICKS BY LABEL
 *
 * `TN3270_GUI_CLICKS` takes LABELS and main queries `button[data-label=...]`, so each case says
 * "the button drawn `FldMk` sends `fieldMark`". A coordinate list would be a second copy of the
 * layout that passes while the layout is wrong.
 *
 * Not in `npm test`; run it by hand, like its neighbours:
 *
 *     node packages/web/scripts/browser-clicks.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guiEnv } from '../../gui/scripts/xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const guiMain = join(repo, 'packages', 'gui', 'dist', 'main.js');
const webMain = join(repo, 'packages', 'web', 'dist', 'main.js');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

/**
 * The GATEWAY's argv. `--replay` makes the run hostless AND is what permits `--log-actions`,
 * which `parseWebArgs` refuses without it -- a `type` action carries typed text and a gateway's
 * stdout is routinely a log file. `--listen 0` takes an ephemeral port, so a stale listener from a
 * previous run cannot make this one silently test the wrong server.
 */
const SERVER_ARGV = ['--replay', trace, '--listen', '0', '--log-actions', '127.0.0.1:3270'];

/**
 * Electron's argv, identical to `browser-keys.mjs`'s and for its reasons.
 *
 * `--no-proxy-server` IS MANDATORY ON THIS BOX AND ITS ABSENCE IS SILENT: `HTTP_PROXY` is set
 * here, and Chromium sends even a LOOPBACK request to it, ignoring `no_proxy` in a way curl does
 * not. The window opens, `did-fail-load` never fires, and the gateway logs not one HTTP request.
 */
const ELECTRON_ARGV = ['--no-sandbox', '--disable-gpu', '--no-proxy-server'];

/**
 * The chord that SHOWS the overlay, which must happen before a click can land on it.
 *
 * The overlay starts hidden on every page load -- the no-persistence decision -- and main's click
 * seam tests `offsetParent === null`, so a run without this reports `NO BUTTON` for every label
 * rather than silently clicking invisible buttons. Delivered as a REAL CHORD, so this run also
 * proves `Ctrl+K` reaches the client-side interception at all.
 */
const SHOW_KEYPAD = 'Ctrl+K';

/**
 * Each button LABEL and the action clicking it MUST produce.
 *
 * LABELS AS DRAWN, from `frontend/src/keypad.ts` -- `FldMk` and `BkSp`, not `FieldMark`.
 *
 * ONE FROM EVERY BLOCK of `KEYPAD_BLOCKS`, so no block can go dead unseen: both PF rows, the
 * attention cluster, the cursor cluster, the editing cluster and the send pair. `SysRq` and
 * `NewLn` are here because they have NO KEYBOARD CHORD in any front end -- verified by
 * enumerating all 48 actions against `canvas/src/keys.ts` -- so for those two the button is the
 * only route that exists, and a dead button is a lost capability rather than an inconvenience.
 *
 * `Xfer` IS DELIBERATELY ABSENT. The gateway REJECTS `transferForm` at decode, because a browser
 * transfer would write to the gateway's filesystem rather than the operator's; clicking it
 * returns an `error` frame, which is correct behaviour and not an action this log would show. See
 * `web/src/protocol.ts`.
 */
const CASES = [
  { label: 'PF1', action: { kind: 'pf', n: 1 } },
  { label: 'PF24', action: { kind: 'pf', n: 24 } },
  { label: 'PA2', action: { kind: 'pa', n: 2 } },
  { label: 'SysRq', action: { kind: 'sysreq' } },
  { label: 'Home', action: { kind: 'home' } },
  { label: 'NewLn', action: { kind: 'newline' } },
  { label: 'Dup', action: { kind: 'dup' } },
  { label: 'FldMk', action: { kind: 'fieldMark' } },
  { label: 'Enter', action: { kind: 'enter' } },
];

/** Key order in JSON is an implementation detail; compare canonically. */
const canon = (o) => JSON.stringify(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

const labels = CASES.map((c) => c.label).join(',');
/**
 * ONE PER CLICK, AND NOTHING FOR THE CHORD.
 *
 * `clicks.mjs`'s expectation opens with a `toggleKeypad`, because in Electron that action crosses
 * IPC to main and is logged there. Here it is intercepted CLIENT-SIDE and never reaches the
 * gateway, so the gateway's log must contain the nine clicks and not a tenth entry. That
 * difference between the two harnesses IS the client-side interception, asserted from the far
 * side.
 */
const expected = CASES.map((c) => canon(c.action));

/** A refusal to even start: `bail` reports on a run, and these happen before there is one. */
const refuse = (why, fix) => {
  console.log(`FAIL ${why}`);
  console.log(`     ${fix}`);
  process.exit(1);
};

// An empty CASES would compare zero against zero and print "0 buttons" as a pass -- the same
// zero-length false green its neighbours guard against.
if (CASES.length === 0) {
  refuse('CASES is empty, so this run would click nothing and still compare equal',
    'restore at least one { label, action } case');
}

/**
 * `dist/` IS WHAT RUNS, and nothing here builds it. THREE packages, compared PER PACKAGE: one
 * `max` across all three would let a fresh build of one MASK a stale build of another, which is
 * the measurement recorded in `keys.mjs` when `canvas` was added to it.
 *
 * `canvas` matters most for this harness: `keypadUi.js` lives there, and a stale copy is a run
 * that clicks yesterday's buttons and reports `ok`.
 */
const newest = (dir, ...suffixes) => Math.max(...readdirSync(dir, { recursive: true })
  .filter((f) => suffixes.some((s) => f.endsWith(s)))
  .map((f) => statSync(join(dir, f)).mtimeMs));

const REBUILD = 'run: npm run build';
for (const entry of [guiMain, webMain]) {
  if (!existsSync(entry)) refuse(`there is no ${entry} to run`, REBUILD);
}
for (const pkg of ['gui', 'canvas', 'web', 'frontend']) {
  const root = join(repo, 'packages', pkg);
  if (!existsSync(join(root, 'dist'))) {
    refuse(`there is no packages/${pkg}/dist, so there is nothing built to run`, REBUILD);
  }
  if (newest(join(root, 'dist'), '.js', '.cjs') < newest(join(root, 'src'), '.ts', '.cts')) {
    refuse(`packages/${pkg}/dist is OLDER than packages/${pkg}/src, so this run would test stale code`,
      `${REBUILD}  (if that reports everything up to date, only a timestamp moved: ` +
      `npx tsc --build --force packages/${pkg})`);
  }
}

/** The gateway, started here and torn down in the `finally` below whatever happens. */
const server = spawn(process.execPath, [webMain, ...SERVER_ARGV], { encoding: 'utf8' });
let serverOut = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let failed = 0;
try {
  /**
   * Wait for the URL the gateway prints rather than sleeping: a fixed sleep is either a flake or a
   * waste, and the line carries the kernel-chosen PORT and the token, neither predictable.
   */
  const url = await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(
      () => rejectP(new Error(`the gateway printed no URL:\n${serverOut}`)), 20000);
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

  /**
   * ASYNC `spawn`, NOT `spawnSync`, AND THAT IS WHAT MAKES THIS HARNESS WORK AT ALL.
   *
   * MEASURED on `browser-keys.mjs` and it cost an hour there: `spawnSync` BLOCKS THE EVENT LOOP,
   * so while the browser runs this process cannot service the `data` events carrying the
   * gateway's output. The bytes sit in the pipe, `spawnSync` returns, and the code below reads
   * `serverOut` seeing only what was written before the browser started -- reporting the product
   * broken while it was fine. ANY harness that reads one child's pipe while synchronously
   * spawning another has this bug.
   */
  let timedOut = false;
  const result = await new Promise((resolveP) => {
    const child = spawn(electron, [guiMain, ...ELECTRON_ARGV], {
      env: guiEnv({
        TN3270_GUI_URL: url,
        TN3270_GUI_KEYS: SHOW_KEYPAD,
        TN3270_GUI_CLICKS: labels,
        // The settle before the first click, and it is also what `maybeSendKeys` waits before the
        // chord. Generous because the page has to fetch five modules over HTTP and build 48
        // buttons before anything is clickable.
        TN3270_GUI_KEYS_MS: '2500',
      }),
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveP({ error, stdout: out, stderr: err, status: null, signal: null });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolveP({
        stdout: out, stderr: err, status, signal,
        ...(timedOut ? { error: new Error('the browser did not finish within 120s') } : {}),
      });
    });
  });

  /**
   * Then WAIT for the gateway's own account to arrive, bounded. Even with the loop free, the
   * server's last writes land on a later turn than the browser's exit -- two processes, two pipes,
   * no ordering between them.
   */
  const actionLines = () => serverOut.split('\n').filter((l) => l.startsWith('action: '));
  for (let waited = 0; waited < 4000 && actionLines().length < expected.length; waited += 50) {
    await new Promise((r) => { setTimeout(r, 50); });
  }

  const stdout = result.stdout ?? '';
  const bail = (why) => {
    console.log(`FAIL ${why}`);
    // MEASURED in the GUI harness: a missing `electron` gives ENOENT with BOTH streams empty, so
    // without this line a failed launch's whole account of itself is the headline above.
    if (result.error !== undefined) console.log(`     ${result.error.message}`);
    process.stdout.write(stdout);
    process.stderr.write(result.stderr ?? '');
    console.log('--- gateway output ---');
    process.stdout.write(serverOut);
    failed = 1;
  };

  // THREE ORDERED BAILS -- error, then signal, then status -- because a SIGSEGV gives
  // `status=null, signal='SIGSEGV'` with stdout INTACT, and a bare `status !== 0` check once let a
  // crashed client score a pass in this repo.
  if (result.error !== undefined) bail('the browser did not run');
  else if (result.signal !== null) bail(`the browser died on ${result.signal}`);
  else if (result.status !== 0) bail(`the browser exited ${result.status}`);
  else if (/clicks: NO KEYPAD WINDOW/.test(stdout)) {
    bail('the click seam found no keypad window at all');
  } else if (/clicks: NO BUTTON/.test(stdout)) {
    // ITS OWN BAIL, because the diagnosis is specific: the overlay was not VISIBLE (so `Ctrl+K`
    // never reached the client-side interception, or the page failed to load it) or the label is
    // not in the table. Either is a different failure from a wrong action.
    bail('the overlay had no clickable button -- did Ctrl+K open it?');
  } else if (/clicks: PROBE FAILED/.test(stdout)) {
    bail('the click probe threw, which means the page did not build its keypad');
  } else if (!stdout.includes('clicks: sent')) {
    // THE SEAM-RAN CHECK. Without it a run in which `TN3270_GUI_CLICKS` was ignored entirely --
    // which is exactly what URL mode did before this feature -- would compare zero against zero
    // somewhere and look green.
    bail('the client never ran the clicks seam, so nothing was clicked');
  } else {
    const actual = actionLines().map((l) => canon(JSON.parse(l.slice('action: '.length))));
    const want = expected.join('\n');
    const got = actual.join('\n');
    if (want === got) {
      console.log(`ok       ${CASES.length} buttons, ${actual.length} actions in order, over a WebSocket`);
      console.log(`         labels clicked: ${labels}`);
    } else {
      console.log('FAIL the gateway applied a different sequence than the clicks should produce');
      for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
        if (expected[i] !== actual[i]) {
          console.log(`     position ${i}`);
          console.log(`     expected ${expected[i] ?? '(nothing)'}`);
          console.log(`     actual   ${actual[i] ?? '(nothing)'}`);
        }
      }
      process.stdout.write(stdout);
      console.log('--- gateway output ---');
      process.stdout.write(serverOut);
      failed = 1;
    }
  }
} finally {
  server.kill('SIGKILL');
}

process.exit(failed);
