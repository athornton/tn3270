import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the CLICK harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as `keys-harness-flags.test.ts` and `shot-flags.test.ts`: a harness outside the fast
 * gate is exempt from every change until somebody remembers it, and `pty-smoke.py` sat at 1 of 12 for
 * two days proving it. This reads `clicks.mjs` as TEXT and pins the things whose absence would
 * disable it SILENTLY -- and silence is the specific hazard, because `clicks.mjs` is the only cover
 * anywhere for the keypad's click path and for the label/action pairing of 8 of its 46 keys.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const clicks = readFileSync(join(guiDir, 'scripts', 'clicks.mjs'), 'utf8');

describe('the click harness', () => {
  it('keeps the three flags without which it hangs or lies', () => {
    // Without `-insecure` a run pointed at a real host does not fail, it HANGS -- default-on TLS
    // against plaintext Hercules. Without `--no-sandbox` and `--disable-gpu` there is no window at
    // all on this box: no GL, and `show: false` stalls rather than erroring.
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(clicks);
    expect(argv, 'no ARGV list found in clicks.mjs').not.toBeNull();
    expect(argv![0]).toContain("'-insecure'");
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
  });

  it('actually spreads that argv into the process it spawns', () => {
    // Without this half, ARGV could keep saying -insecure while nothing passed it: the constant
    // above would still pass its own test and the run would be flagless.
    //
    // `spawnSync` IS CORRECT HERE, and the plan for this task asked for the opposite -- it wanted
    // `spawnSync(` pinned ABSENT, which is `browser-harness-flags.test.ts`'s pin and does not
    // transfer. That harness runs TWO children, a gateway and a client, and reads the gateway's pipe
    // while the client runs: `spawnSync` blocks the event loop, so the bytes sit in the pipe and the
    // harness lies. This one spawns a single child and reads its output afterwards, exactly as
    // `keys.mjs` does, so there is no pipe to starve.
    expect(clicks).toMatch(/spawnSync\(electron, \[main, \.\.\.ARGV/);
  });

  it('drives a replayed trace, never a live host', () => {
    // TWO costs, not one. A live run would send `enter` and PF1/PF24 to a real session, which
    // submits whatever is on the screen -- and `main.ts` gates its action log on replay mode
    // precisely so that a logged action cannot be a typed credential, so without replay there is no
    // log to assert on either and this harness has nothing to read.
    //
    // The WIRING and the trace, not just the strings: the names alone would still pass if
    // TN3270_GUI_REPLAY drifted into a comment.
    expect(clicks).toContain('TN3270_GUI_REPLAY');
    expect(clicks).toMatch(/TN3270_GUI_REPLAY:\s*trace/);
    expect(clicks).toContain('synthetic-ispf-like.trace');
  });

  it('shows the keypad with a real Ctrl+K before clicking anything', () => {
    // THE KEYPAD IS OFF BY DEFAULT. Without this the draw list has no `keypad` region, the
    // renderer's probe returns null for every label, and the whole run is `NO BUTTON` -- which the
    // bail below catches, so the cost is not a false green but a harness that cannot pass at all.
    // Pinned as the value AND its use, so the constant cannot keep saying Ctrl+K while the
    // environment stops carrying it.
    expect(clicks).toMatch(/const SHOW_KEYPAD = 'Ctrl\+K'/);
    expect(clicks).toMatch(/TN3270_GUI_KEYS:\s*SHOW_KEYPAD/);
  });

  it('passes the case labels to the seam it exists to drive', () => {
    // Without the wiring the client would be launched with no clicks seam, print no `clicks: sent`,
    // and fail on the seam-ran bail -- loudly, but the diagnosis would point at the client.
    expect(clicks).toMatch(/TN3270_GUI_CLICKS:\s*labels/);
    expect(clicks).toMatch(/const labels = CASES\.map\(\(c\) => c\.label\)\.join\(','\)/);
  });

  it('expects toggleKeypad as the FIRST action, ahead of every click', () => {
    // The Ctrl+K that shows the keypad is itself an action through the same funnel, so leaving it out
    // of `expected` would put every position off by one -- and including it is free extra cover:
    // `main.ts` intercepts `toggleKeypad` and must LOG IT FIRST, so an interception moved above the
    // log makes this position vanish.
    expect(clicks).toMatch(/expected = \[canon\(\{ kind: 'toggleKeypad' \}\), \.\.\.CASES/);
  });

  it('keeps the buttons whose actions are new on this branch', () => {
    // `dup`, `fieldMark` and `sysreq` are the capabilities this whole feature exists to make
    // reachable -- they were in core with no interactive route. A CASES table that proved the
    // plumbing for PF1 while dropping these would prove it for the keys nobody was worried about.
    expect(clicks).toMatch(/label: 'Dup',\s*action: \{ kind: 'dup' \}/);
    expect(clicks).toMatch(/label: 'FldMk',\s*action: \{ kind: 'fieldMark' \}/);
    expect(clicks).toMatch(/label: 'SysRq',\s*action: \{ kind: 'sysreq' \}/);
  });

  it('covers both PF rows, which are the two halves of the block', () => {
    // PF13-24 sits ABOVE PF1-12, and Task 3 measured that inverting the two blocks leaves every
    // table test green. A CASES list with only PF1 in it would exercise one row of the block.
    expect(clicks).toMatch(/label: 'PF1',\s*action: \{ kind: 'pf', n: 1 \}/);
    expect(clicks).toMatch(/label: 'PF24',\s*action: \{ kind: 'pf', n: 24 \}/);
  });

  it('refuses an empty CASES table before spawning anything', () => {
    // Without this, a table that lost every case would still expect the Ctrl+K's `toggleKeypad`,
    // receive exactly that, and print `ok 0 buttons, 1 actions in order`: a green run in which no
    // button was clicked at all.
    //
    // ON `CASES`, NOT ON `expected`, and that differs from `keys.mjs` deliberately: `expected` here
    // always holds the `toggleKeypad`, so `expected.length === 0` is UNREACHABLE and would be a
    // guard nothing could ever redden.
    expect(clicks).toMatch(/CASES\.length === 0/);
  });

  it('bails on error, then signal, then a bare exit status -- in that order', () => {
    // MEASURED in the chord harness: a client that printed the whole expected sequence and then
    // `kill -SEGV $$` comes back as `status: null`, `signal: 'SIGSEGV'`, `error: undefined` and
    // INTACT stdout, so a guard of `status !== null && status !== 0` PASSES a client that died --
    // and a Chromium process is likelier to be killed than to exit non-zero. Order is pinned, not
    // just presence, because it is what keeps each bail's message specific to its cause: `error`
    // first (ENOENT and ETIMEDOUT both leave `status === null`, and `error.message` is the only
    // account of either), `signal` next, `status` last and unguarded.
    const errorAt = clicks.indexOf('result.error !== undefined');
    const signalAt = clicks.indexOf('result.signal !== null');
    const statusAt = clicks.indexOf('result.status !== 0');
    expect(errorAt, 'no error-bail found').toBeGreaterThan(-1);
    expect(signalAt, 'no signal-bail found').toBeGreaterThan(errorAt);
    expect(statusAt, 'no status-bail found').toBeGreaterThan(signalAt);
  });

  it('prints result.error.message on a bail, or a missing binary reads as a silent client', () => {
    // With a missing `electron`, BOTH streams come back empty; without this line the harness's
    // entire account of the run is its own headline, which looks exactly like a client that started
    // and clicked nothing rather than like ENOENT.
    expect(clicks).toContain('result.error.message');
  });

  it('refuses a run in which the seam never reported sending clicks', () => {
    // THE ZERO-CLICK FALSE PASS. Without this, a client that exited early -- or a mode that ignores
    // this seam, which URL mode does -- yields only the chord's action, and a comparison that
    // happened to line up would pass having clicked nothing.
    expect(clicks).toContain("stdout.includes('clicks: sent ')");
  });

  it('bails on NO BUTTON, separately from a plumbing failure', () => {
    // `NO BUTTON` means the label is not in the layout, or the keypad was never shown. Without a
    // bail of its own it would surface only as a missing action at every later position, which reads
    // as "the buttons are dead" -- the one diagnosis this harness must not hand out wrongly, since
    // it is the very thing it claims to detect.
    expect(clicks).toContain('clicks: NO BUTTON');
    expect(clicks).toMatch(/missing\.length > 0/);
  });

  it('compares the whole ORDERED sequence rather than a subset', () => {
    // Without `Math.max` a run that delivered EXTRA actions -- one press arriving twice, or a
    // `click` listener added beside `mousedown` -- would be trimmed away by the shorter loop and
    // pass.
    expect(clicks).toMatch(/Math\.max\(expected\.length, actual\.length\)/);
  });

  it('fails the run when the renderer throws', () => {
    // A renderer exception produces a window that receives clicks and does nothing with them. It is
    // sharper here than in the chord harness: the button-centre probe is a `window` global installed
    // by the renderer's module body, so a renderer that threw before installing it has no probe.
    expect(clicks).toMatch(/renderer\[3\]/);
  });

  it('refuses a stale dist/, in BOTH packages', () => {
    // dist/ is what actually RUNS and nothing here builds it; the chord harness found `dist/keys.js`
    // a day older than `src/keys.ts` in this very tree. `canvas` is the more important of the two for
    // this harness -- `renderer.ts`, the probe and `hittest.ts` all live there -- and per package
    // rather than one max across both, or a fresh `gui` build would MASK a stale `canvas` one and
    // the run would click yesterday's layout and report ok.
    //
    // `.cts`/`.cjs` on both sides is load-bearing: `'preload.cts'.endsWith('.ts')` is FALSE, which
    // once exempted the preload -- the IPC hop this harness covers -- from the check entirely.
    expect(clicks).toMatch(
      /newest\(join\(root, 'dist'\),\s*'\.js',\s*'\.cjs'\)\s*<\s*newest\(join\(root, 'src'\),\s*'\.ts',\s*'\.cts'\)/,
    );
    expect(clicks).toMatch(/for \(const pkg of \[('gui',\s*'canvas'|'canvas',\s*'gui')\]\)/);
    expect(clicks).toMatch(/const root = join\(here, '\.\.', '\.\.', pkg\)/);
    // Recorded so nobody "simplifies" this into `tsc --build --dry`, which was MEASURED to report
    // "up to date" with an output file deleted.
    expect(clicks).toContain('is not an oracle');
  });
});
