import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the CHORD harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as `shot-flags.test.ts`: a harness outside the fast gate is exempt from
 * every change until somebody remembers it, and `pty-smoke.py` sat at 1 of 12 for two days
 * proving it. This reads `keys.mjs` as TEXT and pins the things whose absence would
 * disable it silently.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const keys = readFileSync(join(guiDir, 'scripts', 'keys.mjs'), 'utf8');

describe('the chord harness', () => {
  it('keeps the three flags without which it hangs or lies', () => {
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(keys);
    expect(argv, 'no ARGV list found in keys.mjs').not.toBeNull();
    // Point it at a real host without -insecure and default-on TLS HANGS rather than fails.
    expect(argv![0]).toContain("'-insecure'");
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
  });

  it('actually spreads that argv into the process it spawns', () => {
    // Without this half, ARGV could keep saying -insecure while nothing passed it.
    expect(keys).toMatch(/spawnSync\(electron, \[main, \.\.\.ARGV/);
  });

  it('drives a replayed trace, never a live logon', () => {
    expect(keys).toContain('TN3270_GUI_REPLAY');
    expect(keys).toContain('TN3270_GUI_KEYS');
    // Pin the WIRING and the trace, not just the strings: the names alone would still pass if
    // TN3270_GUI_REPLAY drifted into a comment. `shot-flags.test.ts` pins its trace for the
    // same reason, and tests 1-2 here already pin a constant AND its use.
    expect(keys).toMatch(/TN3270_GUI_REPLAY:\s*trace/);
    expect(keys).toContain('synthetic-ispf-like.trace');
  });

  it('still tests at least one Alt chord, which is the whole point', () => {
    // The PA keys are why this harness exists: they were bound in core and reachable from
    // no key in this front end, and only a real chord through Chromium can show that.
    expect(keys).toMatch(/spec:\s*'Alt\+\d'/);
    expect(keys).toMatch(/kind:\s*'pa'/);
  });

  it('keeps both NEGATIVE cases, which is what makes the order mean anything', () => {
    // Ctrl+Z must be dropped rather than typing 'z'; F13 must not become PF13.
    expect(keys).toMatch(/spec:\s*'Ctrl\+Z',\s*action:\s*null/);
    expect(keys).toMatch(/spec:\s*'F13',\s*action:\s*null/);
  });

  it('bails on error, then signal, then a bare exit status -- in that order', () => {
    // PROVED false pass: a fake client that printed the whole expected sequence plus
    // "keys: sent" and then `kill -SEGV $$` reports `status: null`, `signal: 'SIGSEGV'`,
    // `error: undefined` and INTACT stdout. A guard of `status !== null && status !== 0`
    // (the shape this harness had before) skips that death outright and the run says `ok`.
    // So all three shapes must be named, and in this order: `error` first, because ENOENT and
    // a timeout BOTH leave `status === null` and `result.error.message` is the only diagnosis
    // of either; `signal` next, to catch exactly the SIGSEGV case above before anything reads
    // `status`; `status` last and UNGUARDED, safe now that both null cases were handled above.
    // Order is pinned, not just presence, because the order is what keeps each bail's message
    // specific to its cause.
    const errorAt = keys.indexOf('result.error !== undefined');
    const signalAt = keys.indexOf('result.signal !== null');
    const statusAt = keys.indexOf('result.status !== 0');
    expect(errorAt, 'no error-bail found').toBeGreaterThan(-1);
    expect(signalAt, 'no signal-bail found').toBeGreaterThan(errorAt);
    expect(statusAt, 'no status-bail found').toBeGreaterThan(signalAt);
  });

  it('refuses a stale dist/, or Task 7 unbinding the PA table would prove nothing', () => {
    // dist/ is what actually RUNS; nothing in this harness builds it. Comparing newest output
    // against newest source (tolerant of exact spacing, since a cosmetic reformat should not
    // fail this) closes the gap where yesterday's mapping table still runs green today.
    // `.cts` on the SOURCE side is load-bearing and was missing at first: `'preload.cts'
    // .endsWith('.ts')` is false, so the preload -- the IPC hop this harness claims to cover --
    // was exempt from the staleness check, which is a false GREEN rather than a false red.
    expect(keys).toMatch(
      /newest\(join\(here, '\.\.', 'dist'\),\s*'\.js',\s*'\.cjs'\)\s*<\s*newest\(join\(here, '\.\.', 'src'\),\s*'\.ts',\s*'\.cts'\)/,
    );
    // Recorded so nobody "simplifies" this into `tsc --build --dry`: that was MEASURED to
    // report "up to date" with an output file deleted, because --build trusts .tsbuildinfo
    // rather than looking at the outputs on disk.
    expect(keys).toContain('is not an oracle');
  });

  it('refuses an all-negative CASES table before spawning anything', () => {
    // Without this, a table that lost every positive case would compare zero actions against
    // zero actions, print "0 actions in order" and pass -- the same zero-length false pass the
    // `keys: sent` check exists to stop, one level up.
    expect(keys).toMatch(/expected\.length === 0/);
  });

  it('prints result.error.message on a bail, or a missing binary reads as a silent client', () => {
    // With a missing `electron`, BOTH stdout and stderr come back empty; without this line
    // the harness's entire account of the run is silence, which looks exactly like a client
    // that started and never sent anything, not like ENOENT.
    expect(keys).toContain('result.error.message');
  });

  it('refuses a run in which the seam never reported sending keys', () => {
    // Without this, a client that exited early yields zero action lines, zero mismatches
    // over a zero-length comparison, and a false pass.
    expect(keys).toContain("stdout.includes('keys: sent ')");
  });

  it('compares the whole ORDERED sequence rather than a subset', () => {
    expect(keys).toMatch(/Math\.max\(expected\.length, actual\.length\)/);
  });

  it('fails the run when the renderer throws', () => {
    // A renderer exception produces a window that receives keys and does nothing.
    expect(keys).toMatch(/renderer\[3\]/);
  });
});
