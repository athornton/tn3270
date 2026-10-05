import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `browser-keys.mjs` is NOT in `npm test` -- it needs Xvfb and a real browser -- so nothing else
 * notices if its invocation rots. This reads it as TEXT and pins the properties whose loss would
 * turn it from a guard into a green light, exactly as `gui/test/keys-harness-flags.test.ts` does for
 * the GUI harness.
 *
 * Each test says what its absence would COST, because a pin whose reason is unrecorded gets deleted
 * by the next person simplifying the file.
 */
const harness = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'browser-keys.mjs'), 'utf8');

describe('browser-keys.mjs', () => {
  it('passes --no-sandbox and --disable-gpu', () => {
    // Neither is optional on this box: there is no GL at all, and without --disable-gpu a window
    // HANGS rather than failing, which presents as a timeout with no diagnosis.
    expect(harness).toContain('--no-sandbox');
    expect(harness).toContain('--disable-gpu');
  });

  it('passes --no-proxy-server', () => {
    // MEASURED: HTTP_PROXY is set in this environment and Chromium sent the LOOPBACK request to it,
    // ignoring no_proxy. The symptom is silent -- no load failure, no renderer error, and not one
    // request in the gateway's log. Losing this flag makes every run fail for a reason that looks
    // like a product bug.
    expect(harness).toContain('--no-proxy-server');
  });

  it('runs the gateway with --replay, so it can reach no host', () => {
    // Without it the harness would dial a real mainframe. It is also what permits --log-actions:
    // `parseWebArgs` refuses that combination precisely because the log carries typed text.
    expect(harness).toMatch(/'--replay'/);
    expect(harness).toContain('--log-actions');
  });

  it('takes an ephemeral port rather than a fixed one', () => {
    // A fixed port lets a stale gateway from a previous run answer this one, so the harness would
    // silently test a different build -- green over code that was never exercised.
    expect(harness).toMatch(/'--listen', '0'/);
  });

  it('drives at least one Alt chord and asserts both negatives', () => {
    // The Alt chords are the PA keys, which is the case that was broken in the real app and invisible
    // to the suite. The negatives carry equal weight: Ctrl+Z must not type "z", F13 must not become
    // PF13, and an absence is only assertable as part of an ordered sequence.
    expect(harness).toMatch(/spec: 'Alt\+1'/);
    expect(harness).toMatch(/spec: 'Ctrl\+Z', action: null/);
    expect(harness).toMatch(/spec: 'F13', action: null/);
  });

  it('compares the WHOLE ordered sequence, not a set of sightings', () => {
    // `Math.max(expected.length, actual.length)` is what makes a MISSING action fail. Iterating only
    // `expected` would pass a run that produced extra actions; iterating only `actual` would pass a
    // run that produced none of them.
    expect(harness).toContain('Math.max(expected.length, actual.length)');
  });

  it('bails when the gateway applied NO actions at all', () => {
    // THE ZERO-LENGTH FALSE PASS. An empty-against-empty comparison reports "ok", which would turn
    // the total failure this harness exists to detect into a success.
    expect(harness).toMatch(/actual\.length === 0/);
  });

  it('refuses a CASES table with no positives', () => {
    // Same false pass one level up: an all-negative table asserts nothing and would print
    // "0 actions in order" and exit 0.
    expect(harness).toMatch(/expected\.length === 0/);
  });

  it('checks status, signal AND error, in that order', () => {
    // MEASURED in the GUI harness: `spawnSync` reports a SIGNAL death as `status: null`, so a check
    // reading `status !== 0` alone passed a client that had died with its output intact. A Chromium
    // process is likelier to be killed than to exit non-zero.
    const iError = harness.indexOf('result.error !== undefined');
    const iSignal = harness.indexOf('result.signal !== null');
    const iStatus = harness.indexOf('result.status !== 0');
    expect(iError).toBeGreaterThan(-1);
    expect(iSignal).toBeGreaterThan(iError);
    expect(iStatus).toBeGreaterThan(iSignal);
  });

  it('fails on a renderer exception', () => {
    // A renderer that throws produces a page which receives keys and does nothing with them --
    // indistinguishable from a broken mapping unless the console is read.
    expect(harness).toContain('renderer[3]');
  });

  it('does NOT use spawnSync for the browser', () => {
    // THE BUG THAT MADE THIS HARNESS LIE. `spawnSync` blocks the event loop, so the gateway's output
    // sat unread in its pipe and the harness parsed an empty transcript -- reporting "no actions at
    // all" while every action had in fact been applied. Any harness that reads one child's pipe
    // while spawning another synchronously has this bug.
    //
    // Matches the CALL, not the word: the comments in that file discuss `spawnSync` at length in
    // order to explain why it is not used, and a bare `toContain` fails on the explanation itself.
    expect(harness).not.toMatch(/spawnSync\s*\(/);
    expect(harness).toMatch(/await new Promise\(\(resolveP\) => \{\s*const child = spawn\(/);
  });

  it('tears the gateway down in a finally', () => {
    // Every bail above exits the process; without a `finally` each failed run would leave a gateway
    // listening with a replayed session open.
    expect(harness).toMatch(/finally\s*\{[\s\S]*server\.kill\(\)/);
  });
});

/**
 * `browser-clicks.mjs` gets the same treatment, and needs it more than its sibling.
 *
 * It is the ONLY thing in the repo that loads the web gateway's keypad overlay in a browser, so
 * its silent rot would leave three mechanisms with no cover at all: the client-side `Ctrl+K`
 * interception, `index.html`'s import map, and `httpstatic.ts` serving the five modules behind it.
 * Each of those failed at least once while this harness was being written, and two of them
 * reported the WRONG FILE when they did.
 */
const clicksHarness = readFileSync(
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'browser-clicks.mjs'), 'utf8');

describe('browser-clicks.mjs', () => {
  it('passes the three flags without which it hangs or lies', () => {
    // `--no-sandbox`/`--disable-gpu`: no GL on this box, and a window HANGS without the second.
    // `--no-proxy-server` IS THE SILENT ONE -- measured: HTTP_PROXY is set here and Chromium
    // routes even a loopback request through it, ignoring `no_proxy`. The window opens,
    // `did-fail-load` never fires, and the gateway logs not one HTTP request.
    for (const flag of ['--no-sandbox', '--disable-gpu', '--no-proxy-server']) {
      expect(clicksHarness, `missing ${flag}`).toContain(flag);
    }
  });

  it('opens the overlay with a REAL Ctrl+K before clicking anything', () => {
    // The overlay starts hidden on every page load -- the no-persistence decision -- and main's
    // seam refuses to click an invisible button. So without the chord every label reports
    // `NO BUTTON` and the run cannot pass; and delivering it as a real chord is what makes this
    // run ALSO prove `Ctrl+K` reaches the client-side interception.
    expect(clicksHarness).toMatch(/const SHOW_KEYPAD = 'Ctrl\+K'/);
    expect(clicksHarness).toMatch(/TN3270_GUI_KEYS:\s*SHOW_KEYPAD/);
  });

  it('expects NO toggleKeypad in the gateway log, unlike the Electron twin', () => {
    /**
     * THE DIFFERENCE BETWEEN THE TWO HARNESSES *IS* THE CLIENT-SIDE INTERCEPTION, asserted from
     * the far side. `clicks.mjs`'s expectation opens with a `toggleKeypad` because in Electron
     * that action crosses IPC and main logs it; here it never leaves the browser, so a tenth
     * entry in the gateway's log would mean the interception had broken.
     *
     * Pinned as the SHAPE of `expected`, since that is what encodes the claim.
     */
    expect(clicksHarness).toMatch(/const expected = CASES\.map\(\(c\) => canon\(c\.action\)\)/);
    expect(clicksHarness, 'a toggleKeypad in `expected` would contradict the interception')
      .not.toMatch(/expected = \[canon\(\{ kind: 'toggleKeypad' \}\)/);
  });

  it('clicks BY LABEL and keeps the two chordless keys among its cases', () => {
    // By label because a coordinate list would be a second copy of the layout that passes while
    // the layout is wrong. `SysRq` and `NewLn` have NO keyboard chord in any front end, so for
    // those two the button is the only route that exists -- a dead button is a lost capability,
    // not an inconvenience.
    expect(clicksHarness).toMatch(/TN3270_GUI_CLICKS:\s*labels/);
    expect(clicksHarness).toMatch(/const labels = CASES\.map\(\(c\) => c\.label\)\.join\(','\)/);
    for (const label of ['SysRq', 'NewLn']) {
      expect(clicksHarness, `${label} left the CASES table`).toContain(`'${label}'`);
    }
  });

  it('bails separately on NO BUTTON, which is the overlay-not-shown case', () => {
    // A different diagnosis from a wrong action: the overlay was not visible, or the label is not
    // in the table. Merging it into the sequence comparison would report "0 actions" and point at
    // the socket.
    expect(clicksHarness).toContain('clicks: NO BUTTON');
    expect(clicksHarness).toMatch(/did Ctrl\+K open it/);
  });

  it('checks the seam RAN, so an ignored TN3270_GUI_CLICKS cannot pass', () => {
    // URL mode ignored this seam entirely until this feature wired it, which is exactly the state
    // where a comparison of zero against zero looks green.
    expect(clicksHarness).toContain('clicks: sent');
  });

  it('bails on a SIGNAL before reading status, so a crash cannot pass', () => {
    // Measured here: a SIGSEGV gives `status=null, signal='SIGSEGV'` with stdout intact, so a
    // bare `status !== 0` check once scored a crashed client as a pass.
    const sigAt = clicksHarness.indexOf('result.signal');
    const statusAt = clicksHarness.indexOf('result.status !== 0');
    expect(sigAt).toBeGreaterThan(-1);
    expect(sigAt).toBeLessThan(statusAt);
  });

  it('does NOT use spawnSync for the browser, and tears the gateway down', () => {
    // The bug that made its sibling lie: `spawnSync` blocks the event loop, so the gateway's
    // output sits unread in its pipe and the harness parses an empty transcript -- reporting the
    // product broken while it was fine.
    expect(clicksHarness).not.toMatch(/spawnSync\s*\(/);
    expect(clicksHarness).toMatch(/finally\s*\{[\s\S]*server\.kill\(/);
  });

  it('compares all four packages dist against src, canvas included', () => {
    // `keypadUi.js` lives in `canvas` now, so a stale build there is a run that clicks
    // yesterday's buttons and reports ok. Per package, never one `max` across all of them: a
    // fresh build of one would mask a stale build of another.
    expect(clicksHarness).toMatch(/\['gui', 'canvas', 'web', 'frontend'\]/);
  });
});
