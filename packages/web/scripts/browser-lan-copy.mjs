#!/usr/bin/env node
/**
 * Web copy in a NON-SECURE CONTEXT, under Xvfb: does a copy at a plain-http LAN address reach the
 * OS clipboard?
 *
 * ## WHY THIS IS NOT ANOTHER PHASE OF `browser-clicks.mjs`
 *
 * `browser-clicks.mjs` loads the gateway at `http://127.0.0.1`, and Chromium treats loopback as a
 * SECURE context: `navigator.clipboard` exists there, so every copy it witnesses could have been
 * written by the async API. The fetch-ahead copy exists for the other case -- an operator opening
 * `http://<the gateway's LAN address>/`, where `isSecureContext` is false, `navigator.clipboard`
 * is undefined, and the ONLY write that can work is `clipboardData.setData` inside the browser's
 * own `copy` event. This harness binds its own gateway to `0.0.0.0`, loads it at this machine's
 * non-loopback IPv4, ASSERTS the page is non-secure, and drives the two gestures that must work
 * there: the `Ctrl+Shift+C` chord (`copyByChord`'s `execCommand('copy')`) and the browser's own
 * copy command (`Meta+C` with `commands: ['copy']`, which is what macOS's Edit > Copy does).
 *
 * ## THE WITNESS IS A SEPARATE PROCESS
 *
 * The page has no clipboard API to read its result back with -- that is the point -- so
 * `read-clipboard.cjs` reads the X11 clipboard from its own Electron main process. MEASURED
 * 2026-11-02: that works across processes, and the clipboard EMPTIES when its owner exits, so every
 * read happens while the browser under test is still alive.
 *
 * ## SKIPPED IS NOT A PASS
 *
 * With no non-loopback IPv4 there is no address at which the page is non-secure, so the run prints
 * `SKIPPED` and exits 0. That exit status means "could not check", NOT "copy works": a SKIPPED run
 * proves nothing about the feature, and must not be read as green.
 *
 * Not in `npm test`; run it by hand, like its neighbours:
 *
 *     node packages/web/scripts/browser-lan-copy.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { electron, guiEnv } from '../../gui/scripts/xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const guiMain = join(repo, 'packages', 'gui', 'dist', 'main.js');
const webMain = join(repo, 'packages', 'web', 'dist', 'main.js');
const reader = join(here, 'read-clipboard.cjs');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

/**
 * The gateway's argv. `--replay` makes the run hostless. `--bind 0.0.0.0` is what makes the LAN
 * address reachable at all, and it makes the gateway print two WARNING lines on stderr (no auth, no
 * TLS off loopback): expected, and the reason this run uses no token. `--listen 0` for
 * `browser-clicks.mjs`'s reason: a stale listener cannot make this run test the wrong server.
 */
const SERVER_ARGV = ['--replay', trace, '--listen', '0', '--bind', '0.0.0.0', '127.0.0.1:3270'];

/**
 * Electron's argv, identical to `browser-clicks.mjs`'s and for its reasons.
 *
 * `--no-proxy-server` IS MANDATORY ON THIS BOX AND ITS ABSENCE IS SILENT: `HTTP_PROXY` is set
 * here, and Chromium sends even a LOOPBACK request to it, ignoring `no_proxy` in a way curl does
 * not. The window opens, `did-fail-load` never fires, and the gateway logs not one HTTP request.
 * A LAN address is no more exempt than loopback.
 */
const ELECTRON_ARGV = ['--no-sandbox', '--disable-gpu', '--no-proxy-server'];

const CDP_CTRL = 2;
const CDP_META = 4;
const CDP_SHIFT = 8;

/** The fixture's text: row 0 is " MENU", row 1 " OPTION ===>", trailing blanks trimmed per line. */
const COPY_WANT = ' MENU\n OPTION ===>';
const ROW0_WANT = ' MENU';

/** A refusal to even start, before there is a run to report on. */
const refuse = (why, fix) => {
  console.log(`FAIL ${why}`);
  console.log(`     ${fix}`);
  process.exit(1);
};

/**
 * `dist/` IS WHAT RUNS, and nothing here builds it -- `browser-clicks.mjs`'s guard, per package,
 * so a fresh build of one cannot mask a stale build of another. `canvas` matters most: `renderer.js`
 * and `forwardKeys.js`, the code under test, live there.
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

/** 1. The address. Without one there is no non-secure context to reach, so nothing to check. */
const lan = Object.values(networkInterfaces()).flat()
  .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address;
if (lan === undefined) {
  console.log('SKIPPED  no non-loopback IPv4 address, so a non-secure context cannot be reached from here');
  console.log('         (SKIPPED is NOT a pass: copy at a LAN address was not checked)');
  process.exit(0);
}

/**
 * A minimal CDP client over the page target's own WebSocket.
 *
 * NODE'S BUILT-IN `WebSocket` (node 26 here), so this adds no dependency -- and `ws` is not in
 * this workspace's `node_modules` to borrow. `Runtime.evaluate` with `returnByValue` is the read
 * side; `exceptionDetails` is checked on every call, because a `Runtime.evaluate` that THREW
 * still answers `{result: {}}` and a silently-undefined read is exactly how a harness scores a
 * broken page green.
 */
async function openCdp(port) {
  // The page target, polled rather than slept for: Electron answers `/json/list` before the
  // renderer has a target to list.
  let target;
  for (let waited = 0; waited < 20000 && target === undefined; waited += 200) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`)
      .then((r) => r.json()).catch(() => []);
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined);
    if (target === undefined) await new Promise((r) => { setTimeout(r, 200); });
  }
  if (target === undefined) throw new Error('CDP listed no page target within 20s');

  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error('the CDP socket never opened')), 20000);
    sock.onopen = () => { clearTimeout(timer); resolveP(); };
    sock.onerror = () => { clearTimeout(timer); rejectP(new Error('the CDP socket errored')); };
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];
  sock.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === undefined) { events.push(msg); return; }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };

  const cmd = (method, params = {}) => new Promise((resolveP, rejectP) => {
    const id = ++nextId;
    // BOUNDED. A mistyped domain never answers at all, and an unbounded await here would hang
    // the whole run until the 120s kill -- which reads as a broken browser rather than a broken
    // harness. Every other wait in this file is bounded for the same reason.
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`${method} did not answer within 20s`));
    }, 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error !== undefined) rejectP(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolveP(msg.result);
    });
    sock.send(JSON.stringify({ id, method, params }));
  });

  return {
    cmd,
    events,
    close: () => { sock.close(); },
    /** Evaluate in the page and return the value. A THROWN expression is a harness failure. */
    eval: async (expression) => {
      const r = await cmd('Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails !== undefined) {
        throw new Error(`the page threw evaluating ${expression}\n     `
          + `${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)}`);
      }
      return r.result.value;
    },
  };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * The OS clipboard, read by `read-clipboard.cjs` in its own Electron main process.
 *
 * Returns the text, or a string starting `READER FAILED` that can never equal a wanted value. Same
 * env as the browser, so it reads the SAME X display. Bounded and SIGKILLed on timeout: the real
 * binary, so the kill takes its children with it (see `xvfb.mjs`).
 */
const readClipboard = () => new Promise((resolveP) => {
  const profile = mkdtempSync(join(tmpdir(), 'tn3270-read-clipboard-'));
  const r = spawn(electron, [reader, ...ELECTRON_ARGV, `--user-data-dir=${profile}`],
    { env: guiEnv() });
  let out = '';
  r.stdout.setEncoding('utf8');
  r.stderr.setEncoding('utf8');
  r.stdout.on('data', (d) => { out += d; });
  r.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { r.kill('SIGKILL'); }, 15000);
  const finish = (why) => {
    clearTimeout(timer);
    rmSync(profile, { recursive: true, force: true });
    const m = /^CLIP=(.*)$/m.exec(out);
    resolveP(m !== null ? JSON.parse(m[1]) : `READER FAILED (${why}): ${out.trim()}`);
  };
  r.on('error', (e) => { finish(e.message); });
  r.on('close', (status, signal) => { finish(`status ${status}, signal ${signal}`); });
});

/** Poll the clipboard until it equals `want` or `ms` passes; return the last value read. */
const pollClipboard = async (want, ms = 3000) => {
  const deadline = Date.now() + ms;
  let clip = await readClipboard();
  while (clip !== want && Date.now() < deadline) {
    await sleep(200);
    clip = await readClipboard();
  }
  return clip;
};

/** 2. The gateway, torn down in the `finally` below whatever happens. */
const server = spawn(process.execPath, [webMain, ...SERVER_ARGV]);
let serverOut = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const logsSince = (mark) => serverOut.slice(mark).split('\n').filter((l) => l !== '');
const waitForLog = async (mark, matches, ms = 6000) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if (logsSince(mark).some(matches)) break;
    await sleep(100);
  }
  return logsSince(mark);
};

const CHECKS = ['lanChord', 'lanCommand'];
let passed = 0;
const done = new Set();
const ok = (name, detail) => { passed += 1; done.add(name); console.log(`ok       ${name}: ${detail}`); };
const no = (name, why, detail = '') => {
  done.add(name);
  console.log(`FAIL     ${name}: ${why}`);
  if (detail !== '') console.log(`         ${detail}`);
};

const profile = mkdtempSync(join(tmpdir(), 'tn3270-browser-lan-copy-'));
let child;
let childOut = '';
let cdp;
let fatal = false;
try {
  // The PORT off the `serving ... at http://YOUR-HOST:PORT/` line: with `--bind 0.0.0.0` the
  // gateway prints a placeholder host, not an address, so only the port is taken from it.
  const port = await new Promise((resolveP, rejectP) => {
    const timer = setTimeout(
      () => rejectP(new Error(`the gateway printed no serving line:\n${serverOut}`)), 20000);
    server.on('exit', (code) => {
      clearTimeout(timer);
      rejectP(new Error(`the gateway exited ${code} before serving:\n${serverOut}`));
    });
    const check = () => {
      const m = /^serving \S+ at https?:\/\/[^:/\s]+:(\d+)\//m.exec(serverOut);
      if (m !== null) { clearTimeout(timer); resolveP(m[1]); }
    };
    server.stdout.on('data', check);
    check();
  });
  const url = `http://${lan}:${port}/`;
  console.log(`         loading ${url}`);

  /** 3. The GUI in URL mode, with a private profile so `DevToolsActivePort` cannot be stale. */
  child = spawn(electron, [guiMain, ...ELECTRON_ARGV,
    `--user-data-dir=${profile}`, '--remote-debugging-port=0'],
  { env: guiEnv({ TN3270_GUI_URL: url }) });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });

  const portFile = join(profile, 'DevToolsActivePort');
  let devPort;
  for (let waited = 0; waited < 30000 && devPort === undefined; waited += 200) {
    if (existsSync(portFile)) {
      const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim();
      if (first !== undefined && first !== '') { devPort = first; break; }
    }
    await sleep(200);
  }
  if (devPort === undefined) throw new Error('the browser never published a DevTools port');

  cdp = await openCdp(devPort);
  await cdp.cmd('Runtime.enable');

  // `window.tn3270` is the last thing `bridge.js` assigns, and a non-null cell centre means the
  // renderer has a frame to select from. No reload and no probe: nothing here wraps the socket.
  // A throw mid-reload ("the page threw", or a context destroyed under the evaluate) is retried,
  // not reported: only the deadline is a failure.
  const waitReady = async () => {
    let ready = false;
    for (let waited = 0; waited < 20000 && !ready; waited += 200) {
      ready = await cdp.eval("typeof window.tn3270 === 'object' "
        + "&& typeof window.__tn3270CellCenter === 'function' && window.__tn3270CellCenter(0, 0) !== null")
        .catch(() => false);
      if (!ready) await sleep(200);
    }
    if (!ready) throw new Error('the page never loaded a screen: no window.tn3270 or no cell (0,0)');
  };
  await waitReady();

  /** 4. The precondition the whole check rests on. */
  const secure = await cdp.eval('window.isSecureContext');
  const clipApi = await cdp.eval('typeof navigator.clipboard');
  console.log(`         isSecureContext=${secure}, typeof navigator.clipboard=${clipApi}`);
  if (secure !== false || clipApi !== 'undefined') {
    fatal = true;
    throw new Error('the page IS a secure context, so this check would prove nothing '
      + `(isSecureContext=${secure}, navigator.clipboard=${clipApi})`);
  }

  /** 5. Before: it must not already hold the answer, or the "after" read could be stale. */
  const before = await readClipboard();
  console.log(`         clipboard before: ${JSON.stringify(before)}`);
  if (before.startsWith('READER FAILED')) {
    fatal = true;
    throw new Error(`the clipboard witness does not work, so nothing here is measured: ${before}`);
  }
  if (before === COPY_WANT || before === ROW0_WANT) {
    fatal = true;
    throw new Error(`the clipboard already holds ${JSON.stringify(before)}, so a copy that did `
      + 'nothing would pass');
  }

  /** `browser-clicks.mjs`'s `dragCells`: by cell, never by pixel, with a move between. */
  const dragCells = async (fromRow, fromCol, toRow, toCol) => {
    const a = JSON.parse(await cdp.eval(
      `JSON.stringify(window.__tn3270CellCenter(${fromRow}, ${fromCol}))`));
    const b = JSON.parse(await cdp.eval(
      `JSON.stringify(window.__tn3270CellCenter(${toRow}, ${toCol}))`));
    if (a === null || b === null) return `NO SUCH CELL (${fromRow},${fromCol})-(${toRow},${toCol})`;
    const hit = await cdp.eval(`(() => {
      const h = document.elementFromPoint(${a.x}, ${a.y});
      return h === null ? 'OUTSIDE THE VIEWPORT'
        : (h.id !== '' ? '#' + h.id : h.tagName.toLowerCase());
    })()`);
    if (hit !== '#screen') return `THE SCREEN IS COVERED AT (${fromRow},${fromCol}): ${hit}`;
    await cdp.cmd('Input.dispatchMouseEvent',
      { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1, buttons: 1 });
    await cdp.cmd('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, button: 'left', buttons: 1 });
    await cdp.cmd('Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: b.x, y: b.y, button: 'left', buttons: 1 });
    await cdp.cmd('Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(250);
    return '';
  };

  /**
   * Drag, wait for the prefetch, run `gesture`, read the clipboard. The `selection:` wait is what
   * makes the CACHED path the one measured; a `copy:` line after the gesture means the async
   * fallback ran instead, which cannot write anything here and is named if it shows up.
   */
  const copyCase = async (name, rect, want, gesture, describe) => {
    /*
      A FRESH DOCUMENT PER CASE, SO NEITHER CASE'S RESULT DEPENDS ON THE OTHER'S -- MEASURED while
      mutation-proving this file. With `copyByChord`'s `execCommand` deleted, `lanChord` fell back,
      the fallback's `writeClipboard` found no clipboard API and REPORTED it, `onError` set
      `errored`, and `prefetchSelection` then refused `lanCommand`'s drag: `lanCommand` failed on
      "no prefetch", which is the first case's damage, not evidence about the copy command.
    */
    await cdp.cmd('Page.reload');
    await waitReady();
    const mark = serverOut.length;
    const dragged = await dragCells(...rect);
    if (dragged !== '') { no(name, dragged); return; }
    const dragLogs = await waitForLog(mark, (l) => l.startsWith('selection: '), 3000);
    const prefetch = dragLogs.find((l) => l.startsWith('selection: '));
    await sleep(100);
    // THIS CASE'S OWN "BEFORE": after `lanChord` the clipboard holds its text, not step 5's value,
    // and a case whose prior value already equals its answer would pass on a no-op.
    const prior = await readClipboard();
    if (prior === want || prior.startsWith('READER FAILED')) {
      no(name, `the clipboard read ${JSON.stringify(prior)} BEFORE the gesture, so this case cannot `
        + 'discriminate a copy from a no-op');
      return;
    }
    const gestureMark = serverOut.length;
    await gesture();
    const clip = await pollClipboard(want);
    const after = logsSince(gestureMark);
    const why = [
      prefetch === `selection: sent ${want.length} chars to the browser` ? ''
        : `the gateway did not log the prefetch (want "selection: sent ${want.length} chars to the `
          + `browser", logged ${JSON.stringify(dragLogs)})`,
      !after.some((l) => l.startsWith('copy: ')) ? ''
        : 'the gateway logged a copy: line, so the gesture took the ASYNC FALLBACK, which has no '
          + 'clipboard API here',
      clip === want ? '' : `the OS clipboard reads ${JSON.stringify(clip)}, want ${JSON.stringify(want)}`,
    ].filter((w) => w !== '');
    if (why.length === 0) {
      ok(name, `${describe} put ${JSON.stringify(clip)} on the OS clipboard over `
        + `${JSON.stringify(prior)}, in a page with isSecureContext=${secure} and no `
        + `navigator.clipboard; the gateway logged ${JSON.stringify(prefetch)} at drag end`);
    } else {
      no(name, why.join('; '), `gateway after the gesture: ${JSON.stringify(after)}`);
    }
  };

  /** 6. `lanChord`: `copyByChord` raising the copy event with `execCommand` inside the keydown. */
  await copyCase('lanChord', [0, 0, 1, 11], COPY_WANT, async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.cmd('Input.dispatchKeyEvent', {
        type, key: 'C', code: 'KeyC', modifiers: CDP_CTRL | CDP_SHIFT,
        windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67,
      });
    }
  }, 'a real Ctrl+Shift+C over a drag of (0,0)-(1,11)');

  /** 7. `lanCommand`: the browser's own copy command, as `webNativeCopy` drives it. */
  await copyCase('lanCommand', [0, 0, 0, 11], ROW0_WANT, async () => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.cmd('Input.dispatchKeyEvent', {
        type, key: 'c', code: 'KeyC', modifiers: CDP_META,
        windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67,
        ...(type === 'rawKeyDown' ? { commands: ['copy'] } : {}),
      });
    }
  }, "Meta+C with commands:['copy'] over a drag of (0,0)-(0,11)");
} catch (err) {
  console.log(`FAIL     ${fatal ? '' : 'the check could not be driven: '}${err.message}`);
  if (!fatal) {
    process.stdout.write(childOut);
    console.log('--- gateway output ---');
    process.stdout.write(serverOut);
  }
} finally {
  /** 8. Both processes, always. The REAL Electron binary, so SIGKILL takes its children too. */
  // AND WAITED FOR, bounded: MEASURED on this file's first run, a leak count taken the instant this
  // process exited still saw six `electron` processes on their way out. Waiting for `close` makes
  // "nothing left running" true when the total prints, not a moment later.
  cdp?.close();
  const closed = (p) => (p === undefined || p.exitCode !== null || p.signalCode !== null
    ? Promise.resolve()
    : new Promise((r) => { p.on('close', r); setTimeout(r, 5000); }));
  child?.kill('SIGKILL');
  server.kill('SIGKILL');
  await Promise.all([closed(child), closed(server)]);
  rmSync(profile, { recursive: true, force: true });
}

// A check that never reported is a failure, not an absence: a throw above skips both.
for (const name of CHECKS) {
  if (!done.has(name)) console.log(`FAIL     ${name}: never ran, so it proves nothing`);
}
console.log(`\nlan copy: ${passed}/${CHECKS.length} checks`);
process.exit(passed === CHECKS.length ? 0 : 1);
