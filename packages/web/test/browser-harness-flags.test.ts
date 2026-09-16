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
