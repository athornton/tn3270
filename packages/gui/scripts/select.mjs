#!/usr/bin/env node
/**
 * Selection and copy under Xvfb: does a real drag put the right text on the clipboard?
 *
 * ## WHAT THIS COVERS THAT NOTHING ELSE CAN
 *
 * `renderer.ts` is a browser entry point that throws at module load, so the barrel deliberately
 * does not export it (`canvas/src/index.ts`) and NO vitest file can execute a line of it. The whole
 * selection gesture lives there: `mousedown`'s selection branch, `mousemove`, `cellAt`, the
 * inverse-video highlight and `__tn3270Copy`. Same argument as `clicks.mjs`, and the same answer.
 *
 * The path under test runs end to end: a real Chromium `mouseDown`/`mouseMove`/`mouseUp` through
 * `sendInputEvent`, the renderer's own `cellAt`, `sendAction({kind:'copy', rect})`, the IPC hop,
 * main's `extractText` over `resolve(snapshot)`, and `clipboard.writeText` into the real OS
 * clipboard -- which is then READ BACK through Electron. Nothing short of that read is honest:
 * every earlier step could pass while the text never reached the clipboard.
 *
 * MUTATION TO PROVE IT, and run it before trusting this harness: make the `mousedown` selection
 * branch return before it sets `anchor`. `npm run build`, `npm run typecheck` and `npx vitest run`
 * all stay clean while this reports `copied=false` and an empty clipboard.
 *
 * ## IT ASSERTS THE EXACT TEXT, NOT MERELY THAT SOMETHING WAS COPIED
 *
 * The plan for this task checked only `copied=true` and a non-empty clipboard, which would pass
 * against an off-by-one rectangle, a transposed row/column, a missing centring offset or text taken
 * from the wrong row entirely -- i.e. against most of the ways this can actually break. The fixture
 * is a REPLAY, so its screen is fixed and the expected strings can be spelled out: row 0 is
 * `" MENU"` and row 1 is `" OPTION ===>"`. A wrong rectangle now names what it got.
 *
 * REPLAY MODE AND NOT A LIVE HOST, for two reasons: the expected text has to be deterministic (TK5's
 * panel paints a live clock), and no password can reach the clipboard during a test.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDisplay, guiEnv } from './xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..');
const electron = join(repo, 'node_modules', '.bin', 'electron');
const main = join(here, '..', 'dist', 'main.js');
const trace = join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace');

/**
 * The client's argv, as one constant so the guard test has a single thing to pin.
 *
 * `-insecure` IS MANDATORY even though this replays a trace and opens no socket: point it at a real
 * host and default-on TLS against plaintext Hercules does not fail, it HANGS.
 * `--no-sandbox --disable-gpu` are Electron's; there is no GL on this box, and without
 * `--disable-gpu` a window HANGS rather than failing. All three are `clicks.mjs`'s, for its reasons.
 */
const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E'];

/**
 * Each drag and the text it MUST put on the clipboard.
 *
 * `top,left,bottom,right` INCLUSIVE, in cells. The expected strings come from the fixture's own
 * screen, and the trailing-space trimming is visible in them: row 0 is `" MENU"` padded to 80, so
 * selecting columns 0-11 yields `" MENU"` and not `" MENU      "`. That is per-LINE trimming, which
 * is what makes a copied column paste usefully, and asserting it here means the rule is proved on a
 * real screen and not only in a unit test's synthetic grid.
 *
 * THE TWO-ROW CASE IS THE ONE THAT MATTERS MOST. A single row passes against a renderer whose
 * `mousemove` never fires -- the anchor alone would be a 1x1 rectangle, which `isEmptyRect` rejects,
 * so a one-row drag at least proves the move happened. But only a MULTI-row case proves the
 * rectangle is normalized and joined in the right order, and it is the case where a row/column
 * transposition in `cellAt` stops being invisible.
 */
const CASES = [
  {
    label: 'one row, trailing blanks trimmed',
    select: '0,0,0,11',
    want: ' MENU',
  },
  {
    label: 'two rows, joined with a newline',
    select: '0,0,1,11',
    want: ' MENU\n OPTION ===>',
  },
  {
    label: 'a column out of the middle of a row',
    select: '1,1,1,6',
    want: 'OPTION',
  },
];

ensureDisplay();

let failures = 0;
for (const kase of CASES) {
  const env = guiEnv({
    TN3270_GUI_REPLAY: trace,
    TN3270_GUI_SELECT: kase.select,
  });
  const r = spawnSync(electron, [main, ...ARGV, '127.0.0.1:1'],
    { env, encoding: 'utf8', timeout: 90_000 });
  // THREE ORDERED BAILS -- error, then signal, then status -- because a SIGSEGV gives
  // `status=null, signal='SIGSEGV'` with stdout INTACT, and a bare `status !== 0` check let a
  // crashed client score a pass in this repo before.
  if (r.error) { console.log(`FAIL ${kase.label}: ${r.error.message}`); failures++; continue; }
  if (r.signal) { console.log(`FAIL ${kase.label}: died on ${r.signal}`); failures++; continue; }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const line = out.split('\n').find((l) => l.startsWith('select:'));
  if (line === undefined) {
    // THE SEAM DID NOT RUN AT ALL, which is a different failure from a wrong selection and is
    // reported as one: a seam that silently never fires would otherwise look like an empty
    // clipboard. `clicks.mjs` has the same bail for the same reason.
    console.log(`FAIL ${kase.label}: no select: line (seam never ran)`);
    console.log(out.split('\n').filter((l) => l !== '').slice(-6).join('\n'));
    failures++;
    continue;
  }
  // The client prints the clipboard JSON-encoded, so the comparison is against the same encoding
  // rather than against a parse of its own output.
  const wantLine = `select: copied=true clipboard=${JSON.stringify(kase.want)}`;
  const ok = line.trim() === wantLine;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${kase.label}`);
  if (!ok) {
    console.log(`       want: ${wantLine}`);
    console.log(`       got:  ${line.trim()}`);
    failures++;
  }
}
console.log(`\n${CASES.length - failures}/${CASES.length} selection cases passed`);
process.exit(failures === 0 ? 0 : 1);
