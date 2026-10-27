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
 * ## AND A SECOND PHASE, FOR THE TRANSFER FORM, BECAUSE FIVE MUTANTS SURVIVED EVERYTHING
 *
 * Task 8's review ran 8 mutants against the full gate AND all three browser harnesses
 * (2026-10-07). **Five survived**, including two that disable the feature outright:
 * `showTransfer: () => {}` (the `Xfer` button wired to nothing), `onTransfer` dropping every
 * message (no progress, no data, no ending), `submit`'s nothing-staged guard returning
 * `{ok:true}` (a DATA-LOSS guard -- see `transferBoot.ts`), a deleted `fileInput.oncancel`, and
 * `position: static` on the overlay. Each was build-clean with every test green, `browser-shot`
 * 1/1 and this harness's own first phase 9/9.
 *
 * What the earlier cover amounted to was LIVENESS, not function: that the modules are served and
 * that `bridge.js` finishes evaluating with every element present. Real, and it closes the
 * blank-window class -- but the entire browser half of the transfer feature could have been
 * reverted to no-ops and nothing in the repository would have noticed. `TRANSFER_CHECKS` below is
 * those five survivors by name, plus the `Save…`-starts-disabled invariant that goes with them.
 *
 * ## ALL SIX MUTANTS NOW DIE, AND EACH WAS RE-RUN RATHER THAN REASONED ABOUT
 *
 * Measured 2026-10-07, one mutant at a time, each with `npm run build` CHECKED before the run --
 * because a deleted guard often produces a `TS18048` and a failed build, while `tsc` still emits
 * JavaScript, so a run that ignores the build result scores it against stale `dist/` and reports
 * green. Every mutant below was therefore applied SEMANTICALLY (the guard returns the wrong
 * answer) rather than by deletion, and every build came back 0. Baseline: 9/9 and 7/7.
 *
 *   `bridge.ts  showTransfer: () => {}`                   build 0, 1/7   (overlay FAILED)
 *   `bridge.ts  onTransfer: () => {}`                     build 0, 5/7   (liveRefusal, progress)
 *   `transferBoot.ts  nothing-staged arm -> {ok:true}`    build 0, 4/7   (noFile FAILED)
 *   `transferBoot.ts  fileInput.oncancel deleted`         build 0, 6/7   (browseCancel ONLY)
 *   `ui.css  #transfer-overlay { position: static }`      build 0, 2/7   (viewport FAILED)
 *   `index.html  Save without the `disabled` attribute`   build 0, 6/7   (saveDisabled ONLY)
 *
 * THE COLLATERAL FAILURES ARE EXPECTED AND THEY ARE NOT THE PROOF. `showTransfer` and `position:
 * static` both make the FORM unreachable, so every later check that needs to click it fails too;
 * what proves each mutant is the named check in the right-hand column, which is why those are
 * listed. The two SURGICAL rows are the interesting evidence -- `oncancel` and the `Save`
 * attribute each reddened exactly one check and left the other six green, so neither assertion is
 * passing by accident of some other check's side effects.
 *
 * ## AND IT FOUND A LIVE BUG ON ITS FIRST RUN, WHICH IS NOT ONE OF THE FIVE
 *
 * **IT FOUND A LIVE BUG ON ITS FIRST RUN, AND THAT BUG IS NOW FIXED.** Keystrokes aimed at the
 * transfer form's text fields did not reach them; they went to the HOST. `renderer.ts`'s
 * `window.addEventListener('keydown', ...)` saw events targeted at `#transfer-localFile`,
 * `actionForKey` claimed any single-code-point key as `{kind:'type'}` without knowing what was
 * focused, and the `e.preventDefault()` that followed suppressed the character -- so the field
 * stayed empty and the letter crossed the socket. Proved three ways, including
 * `action: {"kind":"type","text":"a"}` in this harness's own gateway log for a letter typed into a
 * text field.
 *
 * The fix is in `renderer.ts`: the listener now returns early for an INPUT/TEXTAREA/SELECT or
 * contenteditable target, before `actionForKey` is consulted. It is checked THERE rather than in
 * `keys.ts` because `KeyLike` is deliberately DOM-free -- six scalar fields and no target, which
 * is what lets its cases run with no jsdom.
 *
 * AND THE FIX IS WHAT MADE THIS HARNESS HONEST. The first version of `typeChar` needed an explicit
 * CDP `char` event to get a character into a field at all -- an event a physical keyboard would
 * not produce given that `preventDefault`. With the bug fixed these seven checks pass 7/7 on a
 * plain `keyDown`/`keyUp` pair, so what they prove is now what an operator would experience. See
 * `typeChar`.
 *
 * A SEVENTH MUTANT WAS RUN FOR THE OTHER HALF OF THE QUESTION -- not "does a check fail?" but
 * "does this phase diagnose its own inability to run?". `transferBoot.js` removed from
 * `httpstatic.ts`'s served table (build 0) gave phase one's existing `NO BUTTON` bail plus
 * `the served page never assigned window.tn3270, so bridge.js did not load` and `0/7`. That names
 * BRIDGE.JS, which is the file at fault -- where the renderer's own complaint on that mutant is
 * `Cannot read properties of undefined (reading 'onAtlas')`, naming `renderer.js` instead. The
 * misdirection `httpstatic.ts:94-100` records is therefore not repeated here.
 *
 * `transferBoot.ts` is the file this phase exists for, and that file's own header says so: it has
 * no unit test, because `vitest.config.ts` sets `environment: 'node'`, nothing in this repo has a
 * `document`, and jsdom is not a dependency.
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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * THE GATEWAY'S OWN ENCODER, imported from `dist/` rather than reimplemented here.
 *
 * Phase two feeds three server messages into the page's socket (see `TRANSFER_CHECKS`), and they
 * must be byte-identical to what `main.ts` would put on the wire: zlib-wrapped deflate of the JSON,
 * with `transferData`'s bytes base64'd the one way `protocol.ts` does it. A hand-rolled copy here
 * would be a second encoder that could pass while the real one was wrong -- the same argument this
 * file's own header makes against a coordinate list standing in for the layout.
 *
 * FROM `dist/`, LIKE EVERYTHING ELSE THIS HARNESS RUNS, and the staleness check below covers it.
 */
const { encodeServerMessage } = await import(join(repo, 'packages', 'web', 'dist', 'protocol.js'));

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
 * `Xfer` IS DELIBERATELY ABSENT, AND THE REASON CHANGED UNDER IT -- corrected 2026-10-07.
 *
 * The note here used to say the gateway REJECTS `transferForm` at decode and answers an `error`
 * frame. That was true when it was written and is now false twice over: `protocol.ts` accepted
 * the kind on 2026-10-06 (socket-carried file I/O removed the reason to refuse it, since the
 * bytes travel as `transferChunk`/`transferData` and never touch the gateway's filesystem), and
 * `bridgecore.ts` INTERCEPTS it client-side as of 2026-10-07 to show the DOM overlay -- so it no
 * longer reaches the socket at all.
 *
 * The CONCLUSION survives the correction, which is why the case is still absent rather than
 * added here: clicking `Xfer` produces no `action:` line in the gateway's log, so it cannot be
 * expressed in this table's one-action-per-click shape. It is intercepted, exactly as `Ctrl+K`
 * is, and this harness's own expectation comment below explains why an intercepted press is
 * asserted by its ABSENCE from the log. Phase two below adds the overlay's positive cover --
 * visibility, field rows, button states, a driven transfer -- in a second browser run that does
 * NOT use this table at all, because none of those things is "one click, one logged action".
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

/*
  ============================================================================================
  PHASE TWO: THE TRANSFER FORM, DRIVEN OVER THE CHROME DEVTOOLS PROTOCOL
  ============================================================================================

  ## WHY CDP AND NOT ANOTHER `TN3270_GUI_*` SEAM

  Phase one's `TN3270_GUI_CLICKS` is "click this label, assert the gateway logged that action",
  and not one of the five survivors has that shape: four of them are about what the FORM did and
  the fifth is about where the form IS. Expressing them as a seam would have meant adding five
  new environment variables to `gui/src/main.ts` -- i.e. writing PRODUCTION CODE to make a test
  possible, which this task was told not to do, and which would also have put the assertions
  themselves inside the thing under test.

  CDP is attached from OUTSIDE instead: `--remote-debugging-port=0` on the same Electron shell,
  `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` for real input at the top of Chromium's
  pipeline (exactly where `sendInputEvent` enters, which is what `maybeSendKeys` uses), and
  `Runtime.evaluate` to READ the resulting DOM. The page is not modified to be testable; it is
  observed. `gui/src/main.ts` is untouched by this phase.

  ## WHAT IS REAL AND WHAT IS INJECTED -- STATED PLAINLY, PER CHECK

  THE GATEWAY CANNOT REACH 3270 MODE UNDER `--replay`. `Session.replay`
  (`core/src/session.ts:1626`) builds a LOCAL `const telnet: TelnetLayer` at `:1641` and never
  assigns `this.telnet`, while `is3270Mode()` is `this.telnet?.is3270Mode() ?? false`
  (`core/src/session.ts:469-471`) -- so it is false for the life of a replayed session and
  `startTransfer` refuses with `not in 3270 mode` before the host is told anything
  (`frontend/src/transferRun.ts:90-93`, x3270's own `ftUnableNot3270`). MEASURED here
  2026-10-07: a real submit from this form produced exactly that string in `#transfer-status`.

  So the browser half can be driven end to end and the server half only as far as that refusal:

   - `overlay`, `viewport`, `saveDisabled`, `noFile` and `browseCancel` are ENTIRELY REAL. Real
     keystrokes, real clicks, a real file chooser opened by Chromium, real DOM read back. Nothing
     is injected and nothing is stubbed.
   - `liveRefusal` is REAL IN BOTH DIRECTIONS: the browser's own `transferStart` crosses the
     socket, the gateway's `startTransfer` refuses it, and the refusal comes back as a
     `transferDone {ok:false}` that this check reads off the status line.
   - `webCopy` AND `webPaste` ARE ENTIRELY REAL TOO, in both directions, and BOTH are now driven
     by a real chord. A real Chromium `Ctrl+V` through `Input.dispatchKeyEvent` fires a `paste`
     event with `isTrusted: true` carrying the real clipboard text (MEASURED 2026-10-26 in this
     page), and a real `Ctrl+Shift+C` through the same command reaches `actionForKey`'s copy branch
     (MEASURED 2026-10-27; it used to call the page's `__tn3270Copy` global, because until that day
     the page bound no copy gesture to substitute for). `webCopy` reads the text back off the REAL
     OS clipboard through `navigator.clipboard.readText()`, over a sentinel it put there first.
     Nothing is synthesized and nothing is instrumented -- the production `onCopyText` and
     `writeClipboard` run unmodified. The checks' own block records what that does and does NOT
     cover.
   - `progress` IS INJECTED, and this is the one place in this file where something is. Three
     server messages -- `transferProgress`, `transferData`, `transferDone {ok:true}` -- are
     encoded by the GATEWAY'S OWN `encodeServerMessage` and handed to the page's
     `WebSocket.onmessage`. They are byte-identical to what a gateway on a live host would send;
     what is not real is that no host sent them. They are NOT dressed up as a live transfer:
     `liveRefusal` above is what a replay gateway actually answers, and this check is labelled
     `(injected)` in its own `ok` line.

  Driving them in is what kills the `onTransfer` mutant, which is the point: `onTransfer` is the
  function that carries a gateway message to the form, and no replay gateway will ever send it a
  successful one.

  ## HOW THE SOCKET IS REACHED WITHOUT A PRODUCTION HOOK

  `Page.addScriptToEvaluateOnNewDocument` installs a `window.WebSocket` wrapper BEFORE any page
  script runs, which keeps a reference to the one socket `bridge.js` opens and records every
  string it sends. That reference is how a message is fed in, and the send log is how "nothing
  was sent" is asserted rather than assumed -- the nothing-staged guard is a DATA-LOSS guard, so
  "the status line complained" is not sufficient evidence on its own. The wrapper forwards
  everything; it does not change behaviour.

  ONE THING IT DOES SUPPRESS, AND ONLY FOR THE INJECTED CHECK: with `hold` set it drops the
  outgoing `transferStart` instead of forwarding it. That is needed because `transferUi.ts` arms
  `isRunning` before the await and `progress()` DROPS a message when `isRunning` is false
  (`canvas/src/transferUi.ts:418-421`), so the gateway's `not in 3270 mode` refusal would clear
  the flag again and the injected progress line would land on a form that had already gone idle.
  Holding the start message leaves the form armed with no host involved -- which is honest for a
  check whose frames are injected anyway.
*/

/**
 * One phase-two check: a name, what it asserts, and whether it is live or injected.
 *
 * A TABLE RATHER THAN A SCRIPT OF `console.log`s, so a check cannot be silently skipped: the
 * runner below counts what it ran against this length, the same zero-length guard `CASES` has.
 * `mutant` names the mutation each check was PROVED against -- see the measurements in the
 * header -- so a later reader can redo the proof rather than trust the word "covered".
 */
const TRANSFER_CHECKS = [
  {
    name: 'overlay',
    kind: 'live',
    what: 'the Xfer keypad button SHOWS the transfer overlay, with its field rows drawn',
    mutant: 'bridge.ts  showTransfer: () => {}',
  },
  {
    name: 'viewport',
    kind: 'live',
    what: 'Start is inside the viewport and is what elementFromPoint finds over it',
    mutant: 'ui.css  #transfer-overlay { position: static }',
  },
  {
    name: 'saveDisabled',
    kind: 'live',
    what: 'Save starts disabled, because there is nothing to save until a receive completes',
    mutant: 'index.html  <button id="transfer-save"> without `disabled`',
  },
  {
    name: 'noFile',
    kind: 'live',
    what: 'Start with nothing staged is refused LOCALLY and sends not one byte',
    mutant: 'transferBoot.ts  the `pending === undefined` arm returning { ok: true }',
  },
  {
    name: 'browseCancel',
    kind: 'live',
    what: 'a dismissed file chooser leaves the typed name and the form still usable',
    mutant: 'transferBoot.ts  `fileInput.oncancel` deleted',
  },
  {
    name: 'liveRefusal',
    kind: 'live',
    what: "a real submit crosses the socket and the gateway's own refusal comes back",
    mutant: 'bridge.ts  onTransfer: () => {}',
  },
  {
    name: 'progress',
    kind: 'injected',
    what: 'the three inbound kinds reach the form, and a completed receive enables, NAMES and FOCUSES Save',
    mutant: 'bridge.ts  onTransfer: () => {}; transferBoot.ts  drop saveButton.focus() or the hint',
  },
  {
    name: 'keyboard',
    kind: 'live',
    what: 'Ctrl-B opens the keyboard: regions side by side, reflow when narrow, main block a RECTANGLE, no cap clipped',
    mutant: "ui.css  .keyboard-band { display: block } -- the stacking defect the user's screenshots found",
  },
  /*
    AND THE FUNCTIONAL HALF OF THE KEYBOARD, WHICH NOTHING IN THIS FILE COVERED UNTIL 2026-10-23.

    The `keyboard` entry above measures TEN LAYOUT PROPERTIES AND NOT ONE ACTION, and that is not a
    reading of the code -- it is a MEASUREMENT. `keyboardUi.ts`'s `deps.sendAction(action)` was
    replaced with `void action;`, making every cap dead, and the phase still reported 8/8 green.
    A keyboard can be laid out perfectly and be entirely dead.
  */
  {
    name: 'keyboardCaps',
    kind: 'live',
    what: 'one cap from EVERY region reaches the gateway as the right action',
    mutant: 'keyboardUi.ts  `deps.sendAction(action)` -> `void action;`  (every cap dead)',
  },
  {
    name: 'keyboardInert',
    kind: 'live',
    what: 'an INERT cap sends nothing at all, being disabled rather than merely silent',
    mutant: 'keyboard3279.ts  give the Caps Lock cap an action',
  },
  {
    name: 'keyboardShift',
    kind: 'live',
    what: 'the one-shot Shift sends the shifted legend, then is spent',
    mutant: 'keyboardUi.ts  the `armed = false` in the consuming branch becomes `armed = true`',
  },
  /*
    AND THE BROWSER'S OWN CLIPBOARD, BOTH DIRECTIONS, 2026-10-26.

    Web copy/paste had NO real-browser cover at all before these two. Everything under it was
    covered by unit tests and by `gui/scripts/select.mjs` -- and `select.mjs` drives the ELECTRON
    client, whose copy goes over IPC to `clipboard.writeText` in main. The gateway's route shares
    not one line of that: a `copyText` SERVER MESSAGE, `bridgecore.ts`'s dispatch, `writeClipboard`
    and `navigator.clipboard` in the page. The paste direction has no Electron twin at all -- the
    `PASTE_HOSTS` gate exists precisely to keep the listener OUT of the GUI.

    BOTH ARE `live` AND NEITHER IS INJECTED, which is not what this task's plan expected of the
    paste half; the measurements that earned the label are with the checks themselves.

    THE ONE THAT MATTERS MOST: `bridge.ts`'s `onCopyText: () => {}` left THE WHOLE SUITE GREEN --
    110 files, 2603 tests, not one failure -- while an operator's copy silently did nothing. That
    is the defect shape this pair exists for, and no unit test in this repo reaches it: `bridge.ts`
    touches real browser globals at module load, so no test file imports it, which is the very
    reason `writeClipboard` was extracted out of it. A tested helper and an untested call site.

    AND ONE MUTANT THAT SURVIVES THESE CHECKS, STATED HERE RATHER THAN LEFT TO BE DISCOVERED:
    `selection.ts`'s `cell.hidden ? ' ' : cell.text` -> `cell.text`, the leaked-password line.
    MEASURED: `browser-clicks` still scores 13/13, because the replay fixture has no hidden field
    anywhere on its screen, so this harness has nothing to see. `canvas/test/selection.test.ts`'s
    `A HIDDEN CELL CONTRIBUTES A SPACE, NOT ITS CHARACTER` is what fails, and it is the ONLY thing
    that does. That cover is adequate and the gap is not worth closing here -- a fixture with a
    password field on it would be a trace built to be redacted, and the rule being proved
    (`extractText` substitutes a space) is a pure function's, already pinned on a grid that test
    controls. What this comment buys is that nobody reads 13/13 as cover for redaction.
  */
  {
    name: 'webCopy',
    kind: 'live',
    what: "a real Ctrl+Shift+C over a real drag-select puts the screen's own text on the REAL OS "
      + 'clipboard, TWICE over two different sentinels, so the selection is proved to survive',
    mutant: 'bridge.ts  onCopyText: () => {}  (2603 unit tests stay GREEN)  OR  '
      + 'main.ts  delete the `copy` arm, which also ENDS THE GATEWAY PROCESS on applyAction\'s '
      + 'throw.  AND, SINCE 2026-10-27, THE GESTURE ITSELF: keys.ts  move the `requestCopy` '
      + 'branch BELOW the case-folded `CTRL[e.key.toLowerCase()]` lookup -- the chord then folds '
      + 'to Clear and the clipboard keeps the sentinel; renderer.ts  move the '
      + '`action.kind === \'requestCopy\'` arm BELOW `clearSelection()` -- the rect is destroyed a '
      + 'moment before it is read, so no copy frame is sent at all.  NOT caught here: '
      + 'selection.ts  `cell.hidden ? \' \' : cell.text` -> `cell.text` -- see the note above',
  },
  {
    name: 'webPaste',
    kind: 'live',
    what: 'a REAL Ctrl+V reaches the gateway as {kind:paste} and its text appears somewhere in the '
      + '3270 buffer (the row is REPORTED, not predicted -- where it lands is pasteString\'s rule '
      + 'and paste.test.ts pins it)',
    mutant: "forwardKeys.ts  delete the `deps.on('paste', ...)` registration, OR renderer.ts drop "
      + "the `forwardPaste({...})` call  (gateway logs nothing).  ALSO KILLS: forwardKeys.ts "
      + "delete `if (text === '') return;` -- the empty clipboard then raises "
      + '{"kind":"paste","text":""}.  COLLATERAL, NOT PROOF: it fails on bridge.ts '
      + 'onCopyText: () => {} too, because its screen witness reads back through the COPY path; '
      + 'the `action:` line is the half that isolates paste',
  },
];

if (TRANSFER_CHECKS.length === 0) {
  refuse('TRANSFER_CHECKS is empty, so phase two would assert nothing and still report a pass',
    'restore the five mutants this phase exists to kill');
}

/**
 * Ctrl and Shift as `Input.dispatchKeyEvent` spells them, and the keypad label that opens the form.
 *
 * `CDP_CTRL = 2` AND `CDP_SHIFT = 8` ARE CDP'S OWN BITMASK VALUES (Alt 1, Ctrl 2, Meta 4,
 * Shift 8), which is a different encoding from the Electron `Accelerator` strings
 * `TN3270_GUI_KEYS` takes. `CDP_CTRL` alone builds the same `Ctrl+K` phase one delivers, and it
 * reaches `canvas/src/keys.ts`'s `CTRL` table through the renderer's own `keydown` listener:
 * verified by this run, since the keypad opens and its buttons become clickable. The two ORed
 * together are the Copy chord `webCopy` drives; `press` below is where the rest of the event's
 * fields are justified.
 *
 * `Xfer` IS CLICKED RATHER THAN CHORDED, deliberately, and it is the harder of the two routes:
 * `canvas/src/keys.ts`'s `CTRL` table maps Ctrl-T to `transferForm` too, so a chord would prove the
 * key table and the interception together. The BUTTON proves the key table is not involved at all
 * -- the press goes `keypadUi` click handler -> `bridge.sendAction` -> `bridgecore.ts`'s
 * `transferForm` branch -> `deps.showTransfer()`. That is the exact path the
 * `showTransfer: () => {}` mutant breaks, and `frontend/src/keypad.ts:145` is where the label comes
 * from. (The `keys.ts:97` line citation this paragraph used to carry was stale -- that entry sits
 * at `:154` today -- so it is cited by TABLE now, which cannot drift the same way.)
 */
const CDP_CTRL = 2;
const CDP_SHIFT = 8;
const XFER_LABEL = 'Xfer';

/** Bytes fed to the injected `transferData`. Content is arbitrary; its LENGTH is asserted. */
const INJECTED_BYTES = new Uint8Array([0x48, 0x45, 0x4c, 0x4c, 0x4f]);

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

/**
 * Installed before any page script runs, so it sees the socket `bridge.js` is about to open.
 *
 * NOT A STUB AND NOT A FAKE SOCKET. `bridgecore.test.ts` injects a fake one and that is right for
 * a unit test; the whole value of THIS harness is that everything is real, so this keeps the real
 * constructor and wraps only `send`. The `hold` flag is the single exception and the comment block
 * above says exactly when it is set and why.
 *
 * `feed` IS NOT A PRODUCTION HOOK: it calls the page's own `onmessage` with an `ArrayBuffer`,
 * which is precisely what Chromium hands that handler for a binary frame (`bridge.ts` sets
 * `binaryType = 'arraybuffer'`). The bytes come from `encodeServerMessage`, so `inflate`,
 * `JSON.parse`, the kind dispatch, the `atob` decode of `transferData` and `boot.onMessage` all
 * run unmodified -- and `deps.onTransfer` is on that path, which is what makes the mutant die.
 */
const PROBE_SOURCE = `
(() => {
  const H = { sent: [], hold: false, sock: null, warns: [], keys: [] };
  window.__tn3270Probe = H;
  /*
    EVERY KEYDOWN AS IT ARRIVES, WHICH IS A DIAGNOSTIC AND DELIBERATELY NOT AN ASSERTION TARGET.

    \`webCopy\` dispatches a CDP \`Ctrl+Shift+C\`, and the branch that claims it matches on
    \`e.code === 'KeyC'\` with \`shiftKey\` -- four fields CDP will happily deliver EMPTY rather than
    reject, which is the \`sendInputEvent\`-with-a-bad-keyCode shape this repo has recorded. So when
    the chord fails, "the event the page received" and "the event the harness meant to send" have
    to be separable, or the failure names the product for a harness bug.

    CAPTURE PHASE, so this runs BEFORE \`renderer.ts\`'s own bubble-phase window listener and
    records the event as it ARRIVED -- not as the renderer left it after \`preventDefault()\`.

    IT PROVES NOTHING ABOUT THE PRODUCT ON ITS OWN and must never be the witness a check passes on:
    it reports what the HARNESS INJECTED, which is the "do not assert on a value you injected" rule.
    The real witnesses stay the gateway's own log line and the real OS clipboard. This is here so a
    red run can be diagnosed, and \`webCopy\` prints it only in its FAILURE message.
  */
  window.addEventListener('keydown', (e) => {
    H.keys.push({
      key: e.key, code: e.code, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey,
      metaKey: e.metaKey, altKey: e.altKey, isTrusted: e.isTrusted,
    });
  }, true);
  /*
    THE PAGE'S OWN WARNINGS, KEPT BECAUSE THE CLIPBOARD'S FAILURES ARRIVE ONLY THAT WAY.

    \`writeClipboard\` reports both of its failure routes through an injected \`warn\`, and
    \`bridge.ts\` passes \`console.warn\` -- so "this browser has no clipboard API" and "the browser
    refused the clipboard: NotAllowedError ..." are console lines and nothing else. Without this
    the \`webCopy\` check below could only say the clipboard did not change, which is the symptom
    of a missing API, a refused permission, an unfocused document AND a broken gateway alike.

    THE REAL \`console.warn\` STILL RUNS, so main's \`console-message\` forwarding is unaffected.
  */
  const realWarn = console.warn.bind(console);
  console.warn = (...args) => { H.warns.push(args.map(String).join(' ')); realWarn(...args); };
  const Real = window.WebSocket;
  const Wrapped = function (...args) {
    const s = new Real(...args);
    H.sock = s;
    const realSend = s.send.bind(s);
    s.send = (data) => {
      const text = typeof data === 'string' ? data : '<binary>';
      H.sent.push(text);
      if (H.hold && text.includes('"transferStart"')) return;
      realSend(data);
    };
    return s;
  };
  Wrapped.prototype = Real.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[k] = Real[k];
  window.WebSocket = Wrapped;
  H.feed = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    H.sock.onmessage({ data: bytes.buffer });
  };
})();
`;

/**
 * PHASE TWO, start to finish: a second browser against the SAME gateway, driven over CDP.
 *
 * A SECOND BROWSER RUN AND NOT A CONTINUATION OF THE FIRST. Phase one's Electron exits when
 * `quitIfKeysOnly` fires -- that is how it reports -- so there is no window left to attach to.
 * Reusing one gateway is deliberate and safe for the reason `browser-shot.mjs` records: a second
 * `hello` with no session id creates a SECOND replayed session, so the two phases cannot see each
 * other's state.
 *
 * SEQUENTIAL WITH PHASE ONE, never concurrent: two Electrons under one Xvfb race for the display,
 * and `xvfb.mjs`'s own docstring says so.
 *
 * Returns the number of checks that FAILED. Every failure is counted and reported rather than
 * thrown, so one broken check still lets the others say something -- the posture
 * `browser-shot.mjs` takes with its per-case `fail`.
 *
 * READS `serverOut`, WHICH IS DECLARED BELOW THIS FUNCTION, and that is safe for the one reason
 * this repository insists on spelling out: `serverOut` is a `let` at the top level and this is a
 * closure over it, so what makes the read legal is WHEN it runs -- the single call site is far
 * below that declaration, after the gateway has been spawned and its pipes wired. The recorded
 * finding elsewhere in this project is that OPTIONAL CHAINING DOES NOT GUARD A TDZ, so the call
 * site's position IS the guard; do not hoist the call above the declaration to "tidy" the flow.
 */
async function runTransferPhase(url) {
  let bad = 0;
  const done = new Set();
  const ok = (check, detail) => {
    done.add(check.name);
    console.log(`ok       ${check.name}${check.kind === 'injected' ? ' (injected)' : ''}: ${detail}`);
  };
  /**
   * A failure prints WHAT WAS SUPPOSED TO BE TRUE as well as what was seen.
   *
   * `check.what` is in the table for exactly this: `why` says how it went wrong and the measured
   * values say in what way, but a reader who has never seen this file still needs the claim
   * itself. `check.mutant` follows, so the first thing a reader can do is reproduce the proof.
   */
  const no = (check, why, detail = '') => {
    bad += 1;
    done.add(check.name);
    console.log(`FAIL     ${check.name}: ${why}`);
    if (detail !== '') console.log(`         ${detail}`);
    console.log(`         what should be true: ${check.what}`);
    console.log(`         the mutant this check exists to kill: ${check.mutant}`);
  };
  const check = (name) => {
    const found = TRANSFER_CHECKS.find((c) => c.name === name);
    // A TYPO IN A NAME MUST NOT SILENTLY SKIP A CHECK. Without this the `done` bookkeeping below
    // would report the check as never run, which is the right answer but names the wrong cause.
    if (found === undefined) throw new Error(`no TRANSFER_CHECKS entry named ${name}`);
    return found;
  };

  /**
   * A PRIVATE `--user-data-dir`, which is what makes `--remote-debugging-port=0` readable.
   *
   * Chromium writes the kernel-chosen port into `DevToolsActivePort` inside the profile directory,
   * and that is the only machine-readable place it appears -- the `DevTools listening on ws://...`
   * line goes to stderr unprefixed and is not part of any contract. Port 0 rather than a fixed
   * number for the reason `--listen 0` is used for the gateway: a stale listener from a previous
   * run must not be able to make this one drive the wrong browser.
   *
   * REMOVED IN THE `finally` BELOW. A left-behind profile is not merely untidy: a stale
   * `DevToolsActivePort` in a REUSED directory would be read before the new browser rewrote it,
   * and a run that attached to nothing would then wait out its timeout.
   */
  const profile = mkdtempSync(join(tmpdir(), 'tn3270-browser-clicks-'));
  let cdp;
  let child;
  let childOut = '';
  try {
    child = spawn(electron, [guiMain, ...ELECTRON_ARGV,
      `--user-data-dir=${profile}`, '--remote-debugging-port=0'],
    { env: guiEnv({ TN3270_GUI_URL: url }) });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { childOut += d; });
    child.stderr.on('data', (d) => { childOut += d; });

    const portFile = join(profile, 'DevToolsActivePort');
    let port;
    for (let waited = 0; waited < 30000 && port === undefined; waited += 200) {
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, 'utf8').split('\n')[0]?.trim();
        if (first !== undefined && first !== '') { port = first; break; }
      }
      await new Promise((r) => { setTimeout(r, 200); });
    }
    if (port === undefined) {
      console.log('FAIL     the browser never published a DevTools port, so phase two drove nothing');
      process.stdout.write(childOut);
      return TRANSFER_CHECKS.length;
    }

    cdp = await openCdp(port);
    await cdp.cmd('Runtime.enable');
    await cdp.cmd('Page.enable');
    await cdp.cmd('DOM.enable');

    /**
     * INSTALLED, THEN RELOADED, and the order is the whole point.
     *
     * `addScriptToEvaluateOnNewDocument` applies to the NEXT document, not the current one, and
     * by the time CDP is attached `bridge.js` has already opened its socket. Without the reload
     * the wrapper would be installed over a page whose socket predates it, `H.sock` would stay
     * `null`, and the injected check would fail with a null dereference rather than with
     * anything about the product.
     *
     * BUT THE FIRST LOAD MUST FINISH FIRST, AND SKIPPING THAT WAIT PRODUCES A FALSE ALARM --
     * MEASURED 2026-10-07 while writing this. A reload issued while the first document's module
     * graph is still being fetched ABORTS it: `bridge.js`'s request dies with `ERR_ABORTED`, so
     * `window.tn3270` is never assigned, and `renderer.js` -- which reads it in its module body
     * -- threw `Cannot read properties of undefined (reading 'onAtlas')`. That is the exact
     * string this file's own header records for a MISSING SERVED MODULE, so the harness
     * manufactured the most misleading error it knows how to report. Every check still passed,
     * because the reloaded page was fine; only the error scan reddened.
     *
     * `window.tn3270` IS THE THING WAITED ON, not `readyState`: it is the last thing `bridge.js`
     * assigns, so its presence means that module evaluated to completion.
     */
    let firstLoadFinished = false;
    for (let waited = 0; waited < 20000 && !firstLoadFinished; waited += 200) {
      firstLoadFinished = await cdp.eval('typeof window.tn3270') === 'object';
      if (!firstLoadFinished) await new Promise((r) => { setTimeout(r, 200); });
    }
    // REPORTED RATHER THAN RELOADED ANYWAY. Falling through would reload a page that never
    // loaded, and every check below would then fail against a second broken load -- naming the
    // reload as the suspect instead of whatever stopped the first one.
    if (!firstLoadFinished) {
      console.log('FAIL     the served page never assigned window.tn3270, so bridge.js did not load');
      process.stdout.write(childOut);
      console.log('--- gateway output ---');
      process.stdout.write(serverOut);
      return TRANSFER_CHECKS.length;
    }
    await cdp.cmd('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE });
    await cdp.cmd('Page.reload');
    // The same generous settle phase one uses, and for its stated reason: the page fetches its
    // modules over HTTP and builds the keypad and the form before anything is clickable.
    await new Promise((r) => { setTimeout(r, 4000); });

    if (await cdp.eval('window.__tn3270Probe.sock === null') === true) {
      console.log('FAIL     the page opened no WebSocket after the reload, so nothing here is driven');
      process.stdout.write(childOut);
      return TRANSFER_CHECKS.length;
    }

    /**
     * One real keystroke pair, entering where `sendInputEvent` does.
     *
     * `code` IS NOT DECORATION AND IS THE FIELD THE COPY CHORD TURNS ON. `actionForKey` matches
     * `Ctrl-Shift-C` on `e.code === 'KeyC'` and not on `e.key`, deliberately -- `e.key` is the
     * shifted, layout-dependent form, and caps lock inverts it -- so an event dispatched without a
     * real `code` reaches the renderer with `code: ''` and the branch cannot fire. CDP is fussy
     * enough about these four fields to deliver a USELESS event rather than an error, which this
     * repo has recorded for `sendInputEvent` and an invalid `keyCode`; so `webCopy` REPORTS what
     * the page's keydown listener actually received -- `PROBE_SOURCE`'s `keys` log, read by
     * `chordCopy` and printed in the failure message -- rather than leaving a reader to assume
     * this call built what it meant to.
     *
     * MEASURED 2026-10-27 with `key:'C'`, `code:'KeyC'`, `keyCode:67` and `CDP_CTRL | CDP_SHIFT`:
     * the page's own capture-phase listener saw
     * `{key:'C', code:'KeyC', shift:true, ctrl:true, meta:false, alt:false, isTrusted:true}` --
     * so the chord arrives as a real, trusted event with the physical key the branch needs.
     */
    const press = async (key, code, keyCode, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.cmd('Input.dispatchKeyEvent', {
          type, key, code, modifiers,
          windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
        });
      }
    };

    /*
      ONE PRINTABLE CHARACTER -- AND THE `char` EVENT HERE IS A WORKAROUND FOR A REAL BUG IN THE
      PRODUCT, WHICH IS WORTH WRITING DOWN RATHER THAN QUIETLY DEPENDING ON.

      **MEASURED 2026-10-07, AND IT IS A DEFECT IN THE SERVED PAGE, NOT IN THIS HARNESS:
      KEYSTROKES AIMED AT THE TRANSFER FORM'S INPUTS DO NOT REACH THEM, AND ARE SENT TO THE HOST
      INSTEAD.** `renderer.ts:268` registers `window.addEventListener('keydown', ...)`, which sees
      every keystroke in the page -- including one whose target is `#transfer-localFile` -- and
      `actionForKey` claims any single-code-point `key` as `{kind:'type'}`, then calls
      `e.preventDefault()`. Preventing the default on `keydown` is what SUPPRESSES the character,
      so the field stays empty while the letter goes down the socket to the mainframe.

      Proved three ways against the built page, with a faithful `keyDown`(text)/`keyUp` pair and
      the caret in `Local file`:

        1. the field's own `keydown` listener fired with `defaultPrevented` true, and NEITHER
           `beforeinput` NOR `input` fired at all -- `{keydown:2, defaultPrevented:2,
           beforeinput:0, input:0}`, field value `""`;
        2. the gateway's `--log-actions` showed the leak by name:
           `action: {"kind":"type","text":"a"}` and `"b"` for two letters typed into the field,
           and `backspace`, `left`, `home` and `tab` for those four keys pressed in it;
        3. adding `e.stopPropagation()` on `#transfer-overlay`'s `keydown` -- so the window
           listener never sees it -- made the very next keystroke land in the field (`"w"`) and
           sent nothing. That isolates the cause to the window-level listener.

      SO THIS IS A PRODUCT BUG AND THE FIX BELONGS IN PRODUCTION CODE, not here: the page needs
      the overlays to keep keystrokes aimed at their own controls away from `renderer.ts`'s window
      listener, or that listener needs to ignore events whose target is an editable element. It is
      NOT fixed in this commit, which only adds cover; it is reported with the task.

      WHY THE EXTRA `char` EVENT IS STILL THE RIGHT THING FOR THIS HARNESS. Chromium's own
      pipeline derives the character from the OS and suppresses it on a prevented `keydown`; CDP's
      `char` is a SEPARATE injected event that is not suppressed, so sending it puts the letter in
      the field. That is the behaviour the form would have once the bug is fixed, which is what
      lets the checks below assert the form's REAL logic -- the nothing-staged guard, the refusal,
      the field applicability -- instead of all failing on the typing bug. The leaked `type`
      actions still happen on the side (visible in this run's own gateway log) and are harmless
      against a replay.

      WHAT THIS COSTS IN HONESTY, STATED PLAINLY: the field values below are entered by a REAL
      Chromium input event, but by one a physical keyboard would not generate on its own in the
      presence of that `preventDefault`. Everything else in these checks -- the clicks, the
      chooser, the socket, the DOM reads -- is unaffected.
    */
    const typeChar = async (ch) => {
      // A PLAIN keyDown/keyUp PAIR, WHICH IS WHAT A PHYSICAL KEYBOARD SENDS.
      //
      // THIS USED TO NEED AN EXPLICIT CDP `char` EVENT AS A WORKAROUND, and the workaround is
      // gone because the bug it worked around is FIXED. `renderer.ts`'s `window` keydown listener
      // claimed every printable key for the 3270 screen and called `preventDefault()` without
      // looking at the event target, so a letter typed into `#transfer-localFile` was sent TO THE
      // MAINFRAME and the field stayed empty. This phase is what found it.
      //
      // MEASURED 2026-10-07: with the listener now ignoring INPUT/TEXTAREA/SELECT targets, these
      // seven checks pass 7/7 on keyDown/keyUp alone. That is the honest version -- the harness no
      // longer sends an event a real keyboard would not produce, so what it proves is what an
      // operator would experience.
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.cmd('Input.dispatchKeyEvent', { type, key: ch, text: ch, unmodifiedText: ch });
      }
    };

    /**
     * A REAL MOUSE CLICK at an element's center, asked of the browser rather than computed here.
     *
     * The rectangle comes from `getBoundingClientRect`, so there is no second copy of the layout
     * -- the property this file's header insists on for the keypad, applied to the form. The
     * click then goes in through `Input.dispatchMouseEvent`, so Chromium does the hit testing: a
     * button that is covered, off screen or `display:none` is NOT clicked, which is exactly what
     * makes this a real check rather than a `.click()` on an invisible node.
     */
    const clickCenter = async (selector) => {
      const at = await cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el === null) return null;
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
      })()`);
      if (at === null) throw new Error(`there is no ${selector} to click`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.cmd('Input.dispatchMouseEvent', {
          type, x: at.x, y: at.y, button: 'left', clickCount: 1,
          buttons: type === 'mousePressed' ? 1 : 0,
        });
      }
    };

    const statusText = () => cdp.eval('document.getElementById("transfer-status").textContent');
    const sentCount = () => cdp.eval('window.__tn3270Probe.sent.length');
    /**
     * Wait for the status line to say something, bounded, rather than sleeping a guess.
     *
     * The form is driven by real events and -- for `liveRefusal` -- by a round trip to the
     * gateway, so a fixed sleep is either a flake or a waste. On a timeout the LAST TEXT SEEN is
     * returned rather than thrown, so the caller's own assertion reports what the line actually
     * said instead of "timed out".
     */
    const waitForStatus = async (matches, ms = 8000) => {
      let last = '';
      for (let waited = 0; waited < ms; waited += 100) {
        last = await statusText();
        if (matches(last)) return last;
        await new Promise((r) => { setTimeout(r, 100); });
      }
      return last;
    };

    // ===== overlay: the Xfer BUTTON opens the form ============================================
    //
    // `Ctrl+K` first, because the keypad starts hidden on every page load (the no-persistence
    // decision) and an invisible button cannot be clicked by a real mouse event.
    await press('k', 'KeyK', 75, CDP_CTRL);
    await new Promise((r) => { setTimeout(r, 600); });
    const keypadUp = await cdp.eval('document.getElementById("keypad-overlay").hidden === false');
    const xferVisible = await cdp.eval(
      `(() => {
         const b = document.querySelector('button[data-label=' + ${JSON.stringify(JSON.stringify(XFER_LABEL))} + ']');
         return b !== null && b.offsetParent !== null;
       })()`);
    if (!keypadUp || !xferVisible) {
      no(check('overlay'), 'the keypad never opened, so the Xfer button could not be clicked',
        `keypad shown: ${keypadUp}, Xfer visible: ${xferVisible}`);
    } else {
      await clickCenter(`button[data-label=${JSON.stringify(XFER_LABEL)}]`);
      await new Promise((r) => { setTimeout(r, 600); });
      const shown = await cdp.eval('document.getElementById("transfer-overlay").hidden === false');
      // THE FIELD ROWS TOO, because a shown but EMPTY overlay would pass a visibility check
      // alone. `#transfer-fields` is empty in `index.html` and filled by `transferBoot.ts`'s
      // `render` from `TRANSFER_FIELDS`, so a row count is cover for that render having run.
      //
      // SIX AND NOT TEN, and the arithmetic is `applicable()`'s, not this file's:
      // `newTransferForm()` starts at `direction=receive, mode=binary`, so `recfm`, `lrecl` and
      // `blksize` are withheld as send-only and `cr` is withheld because it is meaningless on a
      // binary transfer (`frontend/src/transferForm.ts:158-177`). Ten minus four is six.
      //
      // ASSERTED AS `> 1` RATHER THAN `=== 6`, deliberately: pinning the number here would make
      // this a SECOND COPY of the applicability rules, which is the one thing this file's header
      // argues against for the keypad layout. What is being covered is that `render` ran at all,
      // and the count is PRINTED so a reader sees the real number either way.
      const rows = await cdp.eval(
        'document.querySelectorAll("#transfer-fields [data-role=value]").length');
      /*
        THE DIRECTION NAMES BOTH ENDPOINTS, read off the SELECTED OPTION'S TEXT in a real browser.

        The bare words `send`/`receive` cost the user their own `PROFILE EXEC A` on 2026-10-07
        (`live-testing.md`), so this is a data-loss guard rather than a cosmetic one. The text
        comes from `frontend`'s `directionLabel` by way of `UiField.optionLabels`, and asserting
        the RENDERED text is what proves the chain reached the DOM -- a `<select>` built from the
        bare `options` would still pass every row count above.

        AND THE VALUE MUST STILL BE THE BARE WORD: `formKeywords` emits `Direction=${value}`, so a
        `<option value>` carrying the label would submit `Direction=send: local to host` and be
        refused by our own validator. Both halves are checked, because only together do they show
        a DISPLAY mapping rather than a renamed value.
      */
      const dirText = await cdp.eval(
        'document.getElementById("transfer-direction").selectedOptions[0].textContent');
      const dirValue = await cdp.eval('document.getElementById("transfer-direction").value');
      if (shown && rows > 1 && dirText.includes('local to host') && dirValue === 'send') {
        ok(check('overlay'),
          `the Xfer button opened the overlay, with ${rows} field rows drawn and the direction `
          + `reading ${JSON.stringify(dirText)} while still submitting ${JSON.stringify(dirValue)}`);
      } else {
        no(check('overlay'), 'clicking Xfer did not produce a populated transfer overlay',
          `overlay shown: ${shown}, field rows: ${rows}, `
          + `direction text: ${JSON.stringify(dirText)}, value: ${JSON.stringify(dirValue)}`);
      }
    }

    // ===== viewport: Start is on screen AND is what the browser finds over it =================
    //
    // NOT A CANVAS-DISPLACEMENT CHECK, and that is a correction rather than a preference.
    // MEASURED 2026-10-07 in Task 8: `#transfer-overlay` FOLLOWS `<canvas id="screen">` in
    // document order, so a `position: static` one lands BELOW the canvas and cannot displace it
    // -- the canvas rect came back byte-identical either way and `browser-shot.mjs` still scored
    // 1/1 with the mutant in place. Re-measured here while writing this check: with the overlay
    // shown, the canvas rect is `x:0 y:0 width:800 height:600` at this harness's default window
    // size, which is the window, so there is nothing for a displacement assertion to see.
    //
    // What `static` actually breaks is the FORM. Measured in Task 8's probe at a 773px viewport:
    // the form's top edge sat at y=773, entirely below the fold, `body.scrollHeight` grew from
    // 773 to 1105, and `elementFromPoint` over Start returned `null`. So containment and
    // hit-testability are what is asserted, which is what the mutation actually moves.
    //
    // REPRODUCED HERE 2026-10-07 at THIS harness's 600px viewport, which is the proof that the
    // assertion below is the one that can fail: with the mutant applied (build 0), this check
    // printed `start top=890.39 bottom=919.39; overlay top=600 bottom=932.39; innerHeight=600
    // scrollHeight=932 elementFromPoint=null`. The overlay's top edge is exactly `innerHeight`,
    // i.e. the first pixel past the fold -- the same shape as the 773/773 reading, because the
    // number that matters is the CANVAS HEIGHT the static overlay is pushed below, and the canvas
    // fills the viewport in both.
    //
    // BOTH HALVES, because either alone is weaker than it looks: a containment check alone passes
    // for a button under an opaque sibling, and a hit test alone passes for a button at the
    // viewport origin with the rest of the form off screen.
    const geom = await cdp.eval(`(() => {
      const el = document.getElementById('transfer-start');
      const r = el.getBoundingClientRect();
      const mid = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      const overlay = document.getElementById('transfer-overlay').getBoundingClientRect();
      return {
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        overlayTop: overlay.top, overlayBottom: overlay.bottom,
        innerHeight: window.innerHeight, innerWidth: window.innerWidth,
        scrollHeight: document.body.scrollHeight,
        hit: mid === null ? null : mid.id,
      };
    })()`);
    const inViewport = geom.top >= 0 && geom.bottom <= geom.innerHeight
      && geom.left >= 0 && geom.right <= geom.innerWidth;
    if (inViewport && geom.hit === 'transfer-start') {
      ok(check('viewport'),
        `Start sits at y=${Math.round(geom.top)}..${Math.round(geom.bottom)} `
        + `in a ${geom.innerHeight}px viewport and hit-tests to itself`);
    } else {
      // THE OVERLAY'S OWN RECT IS IN THE DIAGNOSIS, not just Start's, because it is what tells
      // the two causes apart: an overlay top at or past `innerHeight` with a grown `scrollHeight`
      // is `position: static` putting the whole form below the fold (Task 8's measurement:
      // overlay at y=773 in a 773px viewport, `scrollHeight` 773 -> 1105). An overlay that is on
      // screen while Start is not means the form grew past its own `max-height`, which is a
      // different fix in a different file.
      no(check('viewport'), 'the Start button is below the fold or is not hit-testable',
        `start top=${geom.top} bottom=${geom.bottom}; `
        + `overlay top=${geom.overlayTop} bottom=${geom.overlayBottom}; `
        + `innerHeight=${geom.innerHeight} scrollHeight=${geom.scrollHeight} `
        + `elementFromPoint=${geom.hit}`);
    }

    // ===== saveDisabled: nothing to save until a receive completes ============================
    //
    // ASSERTED HERE, BEFORE ANYTHING IS DRIVEN, which is the only moment it means anything: the
    // injected check below ENABLES this button, so reading it afterwards would assert the
    // opposite fact. `index.html` carries the `disabled` attribute and the completion handler in
    // `transferBoot.ts` is the only thing that clears it.
    const saveDisabled = await cdp.eval('document.getElementById("transfer-save").disabled');
    if (saveDisabled === true) {
      ok(check('saveDisabled'), 'Save starts disabled, with nothing yet received to save');
    } else {
      no(check('saveDisabled'), 'Save was enabled before any transfer had completed',
        `disabled: ${saveDisabled}`);
    }

    // ===== noFile: Start with nothing staged is refused, and NOTHING is sent ==================
    //
    // THE DANGEROUS GUARD IN THIS FEATURE, which is why "nothing was sent" is asserted and not
    // just "the status line complained". `transferBoot.ts` records the hazard: the operator can
    // TYPE a name into `Local file` without ever using Browse, the keywords are then complete,
    // and the gateway has NO BYTES -- and "nothing staged" means "an empty upload" on that side
    // by design, so under `Exist=replace` the host dataset would be overwritten with nothing.
    //
    // EVERY FIELD SET BY REAL INPUT. `direction` moves by TYPE-AHEAD on a focused `<select>` --
    // a real `s` keystroke, which is how a keyboard operator picks `send` -- rather than by
    // assigning `.value`, so `transferBoot.ts`'s `change` listener and `transferUi.ts`'s
    // `cycle` both run. The two text fields are typed character by character, so each keystroke
    // goes through `render`'s focus-and-caret restoration; that rebuild is per keystroke, and a
    // single `insertText` would hide a regression in it.
    await clickCenter('#transfer-localFile');
    for (const ch of 'typed.txt') await typeChar(ch);
    await cdp.eval('document.getElementById("transfer-direction").focus()');
    await typeChar('s');
    await new Promise((r) => { setTimeout(r, 400); });
    const direction = await cdp.eval('document.getElementById("transfer-direction").value');
    await clickCenter('#transfer-hostFile');
    for (const ch of 'A.B') await typeChar(ch);
    await new Promise((r) => { setTimeout(r, 400); });
    const typedFields = await cdp.eval(
      '[document.getElementById("transfer-localFile").value,'
      + ' document.getElementById("transfer-hostFile").value]');
    if (direction !== 'send' || typedFields[0] !== 'typed.txt' || typedFields[1] !== 'A.B') {
      no(check('noFile'), 'the form could not be filled in by real keystrokes',
        `direction=${direction} localFile=${JSON.stringify(typedFields[0])} `
        + `hostFile=${JSON.stringify(typedFields[1])}`);
    } else {
      const before = await sentCount();
      await clickCenter('#transfer-start');
      const said = await waitForStatus((t) => t !== '' && !t.startsWith('Choose a local file'));
      const after = await sentCount();
      // THE SUBSTRING AND NOT THE WHOLE SENTENCE, so rewording the message does not redden this
      // -- `transferBoot.ts`'s refusal is "choose a local file with Browse first".
      const refusedLocally = /Browse/.test(said);
      if (refusedLocally && after === before) {
        ok(check('noFile'),
          `Start with nothing staged was refused locally (${JSON.stringify(said)}) and sent 0 messages`);
      } else {
        no(check('noFile'), 'an unstaged Start was not refused locally, or it sent something',
          `status: ${JSON.stringify(said)}, messages sent: ${after - before}`);
      }
    }

    // ===== browseCancel: a dismissed chooser leaves the form usable ===========================
    //
    // `Page.setInterceptFileChooserDialog` with `cancel: true` makes Chromium DISMISS the chooser
    // instead of showing it, which is what a real operator pressing Escape produces -- and a
    // chooser that actually opened under Xvfb would be a modal nobody can click, i.e. a hang.
    // Verified here 2026-10-07: `Page.fileChooserOpened` fires and no dialog appears.
    //
    // WHAT THIS CHECK CAN AND CANNOT SEE, stated because it is weaker than its neighbours.
    // `transferBoot.ts` assigns `fileInput.oncancel` to resolve the promise `browseLocal` awaits,
    // and without it a dismissed chooser leaves that promise PENDING FOREVER -- Browse unusable
    // for the page's life. This check proves the handler is ASSIGNED and that the form still
    // works after a dismissal; whether Chromium's cancel-intercept fires a `cancel` EVENT at all
    // was measured as NO (2026-10-07: a wrapped `oncancel` setter recorded assigned=1, fired=0
    // after an intercepted dismissal). So the pending-promise consequence is NOT what is being
    // observed here, and this comment says so rather than claiming it.
    await cdp.cmd('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true });
    const eventsBefore = cdp.events.length;
    await clickCenter('#transfer-browse');
    await new Promise((r) => { setTimeout(r, 1200); });
    const sawChooser = cdp.events.slice(eventsBefore)
      .some((e) => e.method === 'Page.fileChooserOpened');
    // READ AFTER the click, because it is assigned inside `browse()` -- which only runs when
    // Browse is pressed. MEASURED 2026-10-07: `null` before any Browse, `function` after one.
    const cancelHandler = await cdp.eval(
      'typeof document.getElementById("transfer-file").oncancel');
    // AND THE TYPED NAME MUST SURVIVE, which is `transferUi.ts`'s own rule: `undefined` from the
    // dialog means "the operator changed their mind", and overwriting the field with it would
    // destroy work for a misclick.
    const keptName = await cdp.eval('document.getElementById("transfer-localFile").value');
    await cdp.cmd('Page.setInterceptFileChooserDialog', { enabled: false });
    if (sawChooser && cancelHandler === 'function' && keptName === 'typed.txt') {
      ok(check('browseCancel'),
        'a dismissed chooser left oncancel assigned and the typed name intact');
    } else {
      no(check('browseCancel'), 'the dismissed-chooser path is not wired as the form needs',
        `chooser opened: ${sawChooser}, oncancel: ${cancelHandler}, `
        + `localFile: ${JSON.stringify(keptName)}`);
    }

    // ===== liveRefusal: a real submit, really sent, really refused ============================
    //
    // A RECEIVE, because a receive is the one direction that needs no staged bytes: `submit`
    // sends `transferStart` and returns, so this reaches the socket with nothing faked. The
    // gateway then refuses it for real -- `--replay` never assigns `this.telnet`, so
    // `is3270Mode()` is false and `startTransfer` answers `not in 3270 mode` before the host is
    // told anything. That refusal travels back as a `transferDone {ok:false}`, through
    // `onTransfer` and `boot.onMessage`, onto the status line. BOTH DIRECTIONS OF THE WIRE AND
    // THE WHOLE INBOUND PATH, with nothing injected.
    await cdp.eval('document.getElementById("transfer-direction").focus()');
    await typeChar('r');
    await new Promise((r) => { setTimeout(r, 400); });
    const backToReceive = await cdp.eval('document.getElementById("transfer-direction").value');
    const sentBeforeLive = await cdp.eval('JSON.stringify(window.__tn3270Probe.sent)');
    // READ BEFORE THE CLICK AND REPORTED ON FAILURE, so a status line this check never changed
    // cannot be mistaken for an answer. The previous check leaves `choose a local file with
    // Browse first` on it, which the wait below already declines to accept -- this records it.
    const statusBeforeLive = await statusText();
    await clickCenter('#transfer-start');
    /*
      THE EXACT REFUSAL, AND MATCHING IT EXACTLY IS THE POINT.

      `not in 3270 mode` is x3270's own `ftUnableNot3270` string, produced at
      `frontend/src/transferRun.ts:90-93` -- which runs IN THE GATEWAY. So the status line
      carrying it proves the round trip: the browser's `transferStart` reached `startTransfer`,
      and its answer came back through `transferDone {ok:false}`, `onTransfer` and
      `boot.onMessage`.

      THE PHRASE DOES OCCUR IN A SERVED MODULE, which is worth stating rather than claiming
      otherwise: `frontend/dist/keypadView.js:117` has `does in plain TN3270 mode` inside a
      COMMENT (checked 2026-10-07 across all seven modules `httpstatic.ts` serves from this
      package plus the four mapped ones). It is not a string any browser-side code can put on
      this status line, and the full `not in 3270 mode` appears in none of them -- which is why
      this matches the whole phrase and not a loose `/3270 mode/`.
    */
    const refusal = await waitForStatus((t) => t.includes('not in 3270 mode'));
    const sentAfterLive = JSON.parse(await cdp.eval('JSON.stringify(window.__tn3270Probe.sent)'));
    const started = sentAfterLive.filter((m) => m.includes('"transferStart"'));
    if (backToReceive === 'receive' && started.length === 1
      && refusal.includes('not in 3270 mode')) {
      ok(check('liveRefusal'),
        `the browser sent transferStart and the gateway answered ${JSON.stringify(refusal)}`);
    } else {
      no(check('liveRefusal'), "a real submit did not produce the gateway's own refusal",
        `status before the click: ${JSON.stringify(statusBeforeLive)}, `
        + `direction: ${backToReceive}, transferStart messages: ${started.length}, `
        + `status after: ${JSON.stringify(refusal)}, sent before: ${sentBeforeLive}`);
    }

    // ===== progress: the three inbound kinds each reach the form (INJECTED) ===================
    //
    // THE ONLY INJECTED CHECK IN THIS FILE, and the header's "WHAT IS REAL AND WHAT IS INJECTED"
    // section is the full account. In short: the three messages are encoded by the GATEWAY'S OWN
    // `encodeServerMessage` and handed to the page's real `onmessage`, so `inflate`,
    // `JSON.parse`, the kind dispatch, `transferData`'s `atob` decode and `boot.onMessage` all
    // run unmodified -- but no host sent them, and this check's `ok` line says `(injected)`.
    //
    // `hold` IS SET FIRST, and without it this check cannot work: `transferUi.ts`'s `progress()`
    // DROPS its text when `isRunning` is false, and the gateway's `not in 3270 mode` refusal
    // clears that flag the moment it arrives. Holding the outgoing `transferStart` leaves the
    // form armed -- `transferring` on the status line -- with no host involved at all.
    await cdp.eval('window.__tn3270Probe.hold = true');
    await clickCenter('#transfer-start');
    const armed = await waitForStatus((t) => t === 'transferring');
    const feed = async (msg) => {
      const b64 = encodeServerMessage(msg).toString('base64');
      await cdp.eval(`window.__tn3270Probe.feed(${JSON.stringify(b64)})`);
      await new Promise((r) => { setTimeout(r, 400); });
    };
    // A DISTINCTIVE STRING, so a status line that merely still says `transferring` cannot pass.
    // `transferGateway.ts` relays progress text verbatim and both emitters are `${n} bytes`.
    await feed({ kind: 'transferProgress', text: '4096 bytes' });
    const sawProgress = await statusText();
    await feed({
      kind: 'transferData', seq: 0, total: INJECTED_BYTES.length, bytes: INJECTED_BYTES,
    });
    // MID-TRANSFER, Save must still be disabled: the bytes are staged but the transfer has not
    // ended, and `transferBoot.ts` enables the button only on `transferDone`.
    const saveMidData = await cdp.eval('document.getElementById("transfer-save").disabled');
    // THE NEGATIVE HALF OF THE AFFORDANCE, read before the ending arrives: Save must NOT hold the
    // focus mid-transfer. Without this a blanket `focus()` anywhere in the file would pass the
    // check below, and the affordance is specifically about the COMPLETION.
    const focusedMidData = await cdp.eval('document.activeElement?.id');
    await feed({ kind: 'transferDone', ok: true, bytes: INJECTED_BYTES.length });
    const sawDone = await statusText();
    const saveAfterDone = await cdp.eval('document.getElementById("transfer-save").disabled');
    /*
      THE AFFORDANCE: a completed receive NAMES Save on the status line and gives it the FOCUS, so
      Enter saves. Both come from one `hasUnsaved()` read in `transferBoot.ts`, which is what stops
      the text and the button's enabled state from disagreeing.

      `activeElement?.id` RATHER THAN THE LABEL, deliberately: the button reads `Save…` with a real
      U+2026, which is easy to mistype in a harness and would fail for the wrong reason.
    */
    const focusedAfterDone = await cdp.eval('document.activeElement?.id');
    /*
      A RULE THAT ACTUALLY PAINTS IS ASSERTED, AND THE RING IS STILL NOT ASSERTED TO BE VISIBLE.

      ## THIS ASSERTION ALREADY CAUGHT A REAL DEFECT, which is why it is phrased this way

      It was first written as `matches(':focus-visible')`, because that is the pseudo-class
      `ui.css` styles for every other button. IT FAILED on the first run -- `:focus-visible
      matched: false` with the focus correctly on `#transfer-save`. `:focus-visible` is decided by
      the UA's heuristic about the user's LAST INPUT MODALITY, not by how the focus was set, and
      the operator reaches a completed transfer by CLICKING Start. So the autofocus was landing
      with NO RING PAINTED -- invisible focus, the exact defect the autofocus exists to cure.
      `ui.css` now gives `#transfer-save` a plain `:focus` rule as well, for that reason alone.

      SO THE CHECK IS `getComputedStyle(...).outlineStyle`, NOT A PSEUDO-CLASS MATCH. Matching
      `:focus` would be trivially true for any focused element and would prove nothing about a
      stylesheet that forgot to style it; reading the resolved `outline` asks the question that
      matters -- IS A RING APPLIED TO THIS BUTTON RIGHT NOW -- and would fail again if the
      modality heuristic, the selector, or the rule's specificity ever changed.

      It is the FIRST computed-style read in this repo's harnesses, which otherwise verify CSS
      behaviourally (hit-testing, `elementFromPoint`). That is a deliberate narrow exception:
      nothing else can distinguish "focused" from "focused and visibly so".

      WHAT IT STILL CANNOT DO, said plainly because this file's convention is that an unqualified
      claim was witnessed: `outlineStyle: solid` is not "a human can see it". Whether a 2px
      `Highlight` outline READS clearly against the overlay's `Canvas` background is a rendering
      judgement, and this project has recorded that apparent rendering bugs are sometimes the
      emulator rather than the code. The user eyeballs that; this harness does not pretend to.
    */
    const ringStyle = await cdp.eval(
      'getComputedStyle(document.getElementById("transfer-save")).outlineStyle');
    const ringWidth = await cdp.eval(
      'getComputedStyle(document.getElementById("transfer-save")).outlineWidth');
    const ringPaints = ringStyle === 'solid' && ringWidth !== '0px';
    /*
      `done: N bytes` IS `transferUi.ts`'s OWN FORMAT (`finished()`), and the N asserted is the one
      the injected `transferDone` carried -- so a form that printed a constant cannot pass.

      `startsWith` RATHER THAN THE EXACT EQUALITY THIS LINE USED TO BE. `transferBoot.ts` now
      appends its own hint, so an `===` against the bare format would fail by construction. The
      PREFIX is still pinned exactly, which keeps the whole point of the old check -- the shared
      module's format and the real byte count -- and the suffix is asserted separately below.
    */
    const doneOk = sawDone.startsWith(`done: ${INJECTED_BYTES.length} bytes`)
      && sawDone.includes('press Save');
    if (armed === 'transferring' && sawProgress === '4096 bytes' && doneOk
      && saveMidData === true && saveAfterDone === false
      && focusedMidData !== 'transfer-save' && focusedAfterDone === 'transfer-save'
      && ringPaints === true) {
      ok(check('progress'),
        `progress reached the form (${JSON.stringify(sawProgress)}), then `
        + `${JSON.stringify(sawDone)}, and the ${INJECTED_BYTES.length} received bytes enabled, `
        + `named and FOCUSED Save, with a ${ringWidth} ${ringStyle} outline resolved on it`);
    } else {
      no(check('progress'),
        'the three inbound transfer kinds did not all reach the form, or Save was not offered',
        `armed: ${JSON.stringify(armed)}, after progress: ${JSON.stringify(sawProgress)}, `
        + `after done: ${JSON.stringify(sawDone)}, Save disabled mid-data: ${saveMidData}, `
        + `Save disabled after done: ${saveAfterDone}, focus mid-data: `
        + `${JSON.stringify(focusedMidData)}, focus after done: `
        + `${JSON.stringify(focusedAfterDone)}, outline: ${ringStyle} ${ringWidth}`);
    }

    // ===== keyboard: Ctrl-B opens it, and the regions REFLOW rather than stacking ============
    //
    // THE DEFECT THIS EXISTS FOR WAS FOUND BY THE USER'S SCREENSHOTS, not by any test: the five
    // regions were appended as plain divs with NO horizontal layout, so they stacked into a column
    // at every width. A unit test cannot see that -- it has no layout engine -- so the assertion
    // has to be a real browser measuring real boxes.
    //
    // TWO WIDTHS, BECAUSE ONE PROVES NOTHING. Wide: the regions sit side by side, so the main
    // block and the numeric pad share a row (different x, same y). Narrow: the numpad REFLOWS
    // below, so its y increases. A `display: block` regression fails the wide half; a layout that
    // could not reflow at all fails the narrow half.
    {
      // Resize the viewport through CDP rather than the window, so this does not depend on a
      // window manager being present under Xvfb.
      const setWidth = async (width) => {
        await cdp.cmd('Emulation.setDeviceMetricsOverride',
          { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await new Promise((r) => { setTimeout(r, 250); });
      };
      const boxOf = (id) => cdp.eval(
        `(() => { const el = document.getElementById(${JSON.stringify(id)});`
        + ' if (el === null) return null;'
        + ' const r = el.getBoundingClientRect();'
        + ' return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })()');

      // Ctrl-B, the full keyboard. `CDP_CTRL` is CDP's own Control bit, as the keypad phase uses.
      await cdp.cmd('Input.dispatchKeyEvent',
        { type: 'keyDown', modifiers: CDP_CTRL, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
      await cdp.cmd('Input.dispatchKeyEvent',
        { type: 'keyUp', modifiers: CDP_CTRL, key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 });
      await new Promise((r) => { setTimeout(r, 400); });

      const shown = await cdp.eval(
        '!document.getElementById("keyboard-overlay").hidden');
      const capCount = await cdp.eval(
        'document.querySelectorAll("#keyboard-overlay button[data-key]").length');

      await setWidth(1400);
      const wideMain = await boxOf('keyboard-main');
      const wideNum = await boxOf('keyboard-numpad');
      await setWidth(520);
      const narrowMain = await boxOf('keyboard-main');
      const narrowNum = await boxOf('keyboard-numpad');
      // Put the viewport back, so later checks in this run are not measuring a 520px window.
      await cdp.cmd('Emulation.clearDeviceMetricsOverride');

      /*
        TWO MORE THINGS ONLY A REAL LAYOUT CAN PROVE, both found by the user on screenshots.

        THE LEFT SPECIAL BAR MUST BE ON THE FAR LEFT. It was ordered LAST, which put Attn/Clear on
        the far RIGHT -- a wrap-priority decision applied to the wrong property, since `order`
        governs position. Asserted as "left of the main block", which is where the hardware has it.

        THE UP ARROW MUST SIT ABOVE THE DOWN ARROW. Its row is offset by one key unit in the table
        and a flex row ignored that, packing it flush left so the inverted-T read as an L. Measured
        on the CAPS rather than on the row, because the cap position is what an operator sees.
      */
      /*
        MEASURE REAL TEXT, BECAUSE TWO ESTIMATES WERE BOTH WRONG.

        `keyboard3279.test.ts` models label width as `chars * ratio * fontSize`, and I guessed that
        ratio twice -- 0.56, then 0.75 -- and the user's screenshots showed clipping both times.
        A unit test cannot do better: there is no font in vitest. THIS harness has a real browser,
        so it reports what the font actually measures, and the unit test's constant is calibrated
        from this number rather than from an average for prose.

        PRINTED EVERY RUN, pass or fail. It is diagnostic rather than an assertion: the assertion
        is `overflowing` below, which asks the browser directly which caps are clipped.
      */
      /*
        DOES THE FONT ACTUALLY HAVE OUR ARROW GLYPHS, OR IS IT FALLING BACK?

        The table uses a dozen glyphs from the Arrows block (U+2190..U+21FF) -- two-headed arrows,
        arrows to bar, white arrows, an arrow with a stroke. A font without them renders a
        TOFU BOX or silently substitutes from another family, and either looks like a bug in the
        keyboard rather than in the font.

        MEASURED BY COMPARING WIDTHS: `measureText` on the glyph against `measureText` on U+FFFD
        (the replacement character) in the SAME font. A missing glyph usually measures identically
        to the fallback notdef box, so an equal width is the signal. Not conclusive on its own --
        a font could coincidentally match -- so the ZERO-width case is checked too, which means
        the glyph produced nothing at all.
      */
      /*
        NO ARROW-GLYPH COVERAGE CHECK, AND THE REASON IS WORTH MORE THAN THE CHECK WOULD HAVE BEEN.

        The table draws a dozen glyphs from Unicode's Arrows block, and a font lacking one renders
        a tofu box -- so a check seemed worthwhile. TWO METHODS WERE TRIED AND BOTH WERE VACUOUS,
        each proved so by inserting a private-use codepoint (U+E000) that no font can render:

         - COMPARING ADVANCE WIDTHS to U+FFFD's, on the theory that a missing glyph falls back to
           the notdef box. Measured: the absent codepoint is 5.40px and U+FFFD is 9.23px, so the
           comparison matched nothing. It passed the absent glyph.
         - `document.fonts.check(font, text)`, which looks like the right API. It reports whether
           the FAMILY is available, not whether it covers the characters, so it returned true for
           the absent glyph too. It passed as well.

        A real check needs per-character coverage, which the DOM does not expose -- it would mean
        rasterising each glyph and comparing pixels, and this harness has no golden for that.

        SO THE COVERAGE IS HANDLED WHERE IT CAN BE: `ui.css` names explicit symbol fallbacks after
        `system-ui` (Segoe UI Symbol, Apple Symbols, Noto Sans Symbols 2, DejaVu Sans), per-glyph
        fallback being something CSS does natively. **A TOFU BOX IS A THING THE USER WILL SEE
        IMMEDIATELY**, which is the honest reason not to spend a third attempt here -- unlike the
        clipped labels, which hid behind `overflow: hidden` for three rounds.
      */

      /*
        THE INSERT CAP'S GLYPH IS OUTSIDE THE ARROWS BLOCK, so it is worth one width check.

        `U+2041 CARET INSERTION POINT` lives in General Punctuation, which the symbol fallbacks in
        `ui.css` were chosen for Arrows coverage rather than for. A WIDTH OF ZERO means the glyph
        produced nothing at all -- the one failure mode a width CAN detect reliably, unlike the
        notdef comparison this harness already recorded as vacuous.
      */
      /*
        COMPARED AGAINST A GLYPH KNOWN TO BE PRESENT, which is what makes this check real.

        A plain `w > 0` passes a near-blank fallback: U+2041 measured 2.3px here against 7.5px for
        U+21E4, and 2.3px is not zero. The RATIO is the signal -- a glyph the font genuinely has
        measures comparably to its neighbours, and a fallback box does not.

        This is the one font question a width CAN answer. Per-character COVERAGE cannot be probed
        from the DOM at all, which the note above this records after two vacuous attempts.
      */
      /*
        THE RETURN KEY IS A PLAIN TWO-ROW RECTANGLE WITH AN OVERSIZED GAP BESIDE IT.

        THE USER'S DECISION, 2026-10-23, AFTER SEEING THE L ON A SCREENSHOT (`vkey10.png`): the
        inverted-L is not wanted. It reads as a key with a vertical bar through it, and the half of
        it that overhangs the backslash cannot be clicked -- the `{` below needs the box to stay
        narrow, so the overhang was PAINT ONLY. "Something that looks like a key but is dead" is
        worse than a wider gap, so the gap is the answer: the cap is a rectangle, and the 0.25-unit
        space between it and the backslash is simply left empty and larger than every other gap.

        THREE THINGS ARE MEASURED, and the first two are the user's words made into numbers:

        1. THE GAP BELOW MATCHES THE ORDINARY ROW GAP. Checked against the SHIFT ROW rather than
           against a constant, because the arithmetic -- 2 caps plus the 1 gap between their rows
           -- is exactly what was once wrong (`4px`, the horizontal gap doubled).

        2. THE GAP TO ITS LEFT IS OVERSIZED, compared against the row's OWN ordinary gap rather
           than a literal. "Oversized compared to all the others" is a comparison, so the check
           is one: the narrowest gap between any other pair of caps in that row is the baseline,
           and the Return's must be several times it.

        3. NOTHING IS PAINTED INTO THAT GAP. The L was a `::before`, so `content` must now be
           `none`.

        ## MUTATION-PROVED, ONE AT A TIME, EACH WITH THE BUILD CHECKED

          `ui.css` height back to `* 4px`            `gap below=0px`   FAIL   (clause 1)
          the `::before` restored                    `paint=""`        FAIL   (clause 3)
          `keyboard3279.ts` Return `width: 1.5`      `gap left=2px`    FAIL   (clause 2)

        AND ONE MUTANT SURVIVED, WHICH IS THE INTERESTING RESULT: moving the Return's table `x`
        from 13.75 to 13.5 changed NOTHING -- `gap left` stayed 10px and every check still passed.
        That is correct behaviour, not a hole: `ui.css` positions the tall cap `absolute; right: 0`,
        so its `x` is never read and its WIDTH alone sets its left edge. Worth writing down because
        the `x` is heavily commented in the table as the thing that stops the `{` overlap -- and it
        is not: the width is. A future edit that "fixes" the `x` will do nothing, and the brace
        check cannot see that `x` either.
      */
      const returnShape = await cdp.eval(`(() => {
        const tall = document.querySelector('#keyboard-main button[style*="--kb-h"]');
        if (tall === null) return 'no tall cap';
        const shift = document.querySelector('#keyboard-main button[data-key^="Shift (left"]');
        if (shift === null) return 'no shift cap';
        const t = tall.getBoundingClientRect();
        const sh = shift.getBoundingClientRect();
        const gapBelow = Math.round(sh.top - t.bottom);
        /*
          THE ROW'S OWN GAPS, so "oversized" is relative to the thing it is oversized against.
          The Return is the last cap in its row and every other gap in that row is the ordinary
          one, so the narrowest of those is the baseline a human would compare it to.
        */
        const row = tall.parentElement;
        const caps = [...row.querySelectorAll('button')]
          .map((b) => b.getBoundingClientRect())
          .sort((a, b) => a.left - b.left);
        let ordinary = Infinity;
        for (let i = 1; i < caps.length - 1; i += 1) {
          ordinary = Math.min(ordinary, Math.round(caps[i].left - caps[i - 1].right));
        }
        const last = caps.length - 1;
        const gapLeft = Math.round(caps[last].left - caps[last - 1].right);
        const paint = getComputedStyle(tall, '::before').content;
        return 'gap below=' + gapBelow + 'px gap left=' + gapLeft
          + 'px ordinary=' + ordinary + 'px paint=' + paint;
      })()`);
      /*
        `>= 3 *` RATHER THAN `> `: an oversized gap the user would call oversized is not one pixel
        wider than its neighbours. At this pitch the real numbers are 9px against 2px.
      */
      const returnMeasures = /^gap below=(\d+)px gap left=(\d+)px ordinary=(\d+)px paint=(.*)$/
        .exec(returnShape);
      const returnOk = returnMeasures !== null
        && Number(returnMeasures[1]) === Number(returnMeasures[3])
        && Number(returnMeasures[2]) >= 3 * Number(returnMeasures[3])
        && returnMeasures[4] === 'none';

      const insertGlyph = await cdp.eval(`(() => {
        const el = document.querySelector('#keyboard-cursor button[data-key^="Insert"]');
        if (el === null) return 'no insert cap';
        const style = getComputedStyle(el);
        const c = document.createElement('canvas').getContext('2d');
        c.font = style.fontSize + ' ' + style.fontFamily;
        const w = c.measureText(el.textContent).width;
        // Compared against a glyph KNOWN to be present, so a suspiciously narrow result is
        // visible rather than merely non-zero.
        const ref = c.measureText('\u21E4').width;
        const ok = w > ref * 0.5;
        return (ok ? 'renders at ' : 'TOO NARROW at ')
          + w.toFixed(1) + 'px vs ' + ref.toFixed(1) + 'px for a known glyph';
      })()`);

      const metrics = await cdp.eval(`(() => {
        const c = document.createElement('canvas').getContext('2d');
        const out = [];
        for (const f of [6, 7, 8, 10]) {
          c.font = f + 'px system-ui, sans-serif';
          out.push(f + 'px: PF13=' + c.measureText('PF13').width.toFixed(1)
            + ' per-char=' + (c.measureText('PF13').width / 4 / f).toFixed(2));
        }
        return out.join('  ');
      })()`);

      /*
        AND THE REAL ASSERTION: ASK THE BROWSER WHICH CAPS ARE CLIPPED.

        `scrollWidth > clientWidth` is how an element reports that `overflow: hidden` is eating
        its content -- which is exactly the silent failure the user kept catching on screenshots
        and no test could see. This needs no font metric, no ratio and no estimate: it is the
        browser saying "this did not fit".
      */
      const overflowing = await cdp.eval(`(() => {
        const bad = [];
        for (const b of document.querySelectorAll('#keyboard-overlay button[data-key]')) {
          if (b.scrollWidth > b.clientWidth + 1) {
            bad.push(b.getAttribute('data-key') + ' (' + b.scrollWidth + '>' + b.clientWidth + ')');
          }
        }
        return bad.join(', ');
      })()`);


      /*
        THE NUMERIC PAD'S COLUMNS MUST LINE UP, which is what a multi-unit cap's gap arithmetic
        buys. The user caught this: the double-width `0` was 2px narrow (a width-n cap was
        `n * pitch` with no allowance for the n-1 gaps it spans), so `.` did not sit under `3` and
        `Ent` did not sit under `-`. Measured on left edges, within 2px for sub-pixel rounding.
      */
      const capX = (key) => cdp.eval(
        `(() => { const el = document.querySelector(`
        + `'#keyboard-overlay button[data-key="' + ${JSON.stringify(key)} + '"]');`
        + ' if (el === null) return null;'
        + ' return Math.round(el.getBoundingClientRect().x); })()');
      const xThree = await capX('3');
      const xPeriod = await capX('. (numeric pad)');
      const xMinus = await capX('- (numeric pad)');
      const xEnter = await capX('Enter (numeric pad)');
      const numpadAligned = xThree !== null && xPeriod !== null
        && xMinus !== null && xEnter !== null
        /*
          EXACT, NOT WITHIN 2px -- AND THE TOLERANCE WAS THE BUG IN THIS CHECK.

          It was `<= 2`, and the mutant it exists to kill (dropping the gap absorption from a
          multi-unit cap's width) is off by EXACTLY 2px per extra unit. So the first version of
          this assertion PASSED against the defect, reporting `. at 702 under 3 at 704` as a
          success. Measured, not reasoned: I ran the mutant and watched it go green.

          These are integer pixel positions from `Math.round`, and two caps in the same grid either
          share a column or do not. A tolerance here buys nothing and hides a 2px-per-unit class of
          error -- which is the whole family of defect this check is for.
        */
        && xPeriod === xThree && xEnter === xMinus;

      /*
        THE MAIN BLOCK MUST BE A RECTANGLE, which is what the user asked for and what no unit test
        can confirm: the table's arithmetic says every row is 15 units, but whether the RENDERED
        rows share a right edge depends on the gap absorption, the row-spanning Return and the
        stagger all being right together.

        MEASURED AS THE SPREAD OF ROW RIGHT EDGES. A row's right edge is its last cap's right edge
        -- except for the home row, whose right edge comes from the TALL Return cap positioned
        absolutely against the row above. So the tall cap is counted for every row it covers, which
        is exactly how the table models it.
      */
      const rowEdges = await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('#keyboard-main .keyboard-row')];
        const tall = document.querySelector('#keyboard-main button[style*="--kb-h"]');
        const tallRight = tall === null ? null : tall.getBoundingClientRect().right;
        return JSON.stringify(rows.map((r, i) => {
          const caps = [...r.querySelectorAll('button')];
          let right = Math.max(...caps.map((c) => c.getBoundingClientRect().right));
          // The row BELOW a tall cap has no cap of its own at that x, so it inherits that edge.
          if (tallRight !== null && tallRight > right) right = tallRight;
          return Math.round(right);
        }));
      })()`);
      const edges = JSON.parse(rowEdges);
      const rectangle = edges.length === 5
        && Math.max(...edges) - Math.min(...edges) <= 2;

      /*
        AND `Z` MUST CENTRE BETWEEN `A` AND `S` -- the user's own test for the stagger, and the
        reason the left Shift is 2.25 units rather than 1.25.
      */
      const centreOf = (key) => cdp.eval(
        `(() => { const el = document.querySelector(`
        + `'#keyboard-overlay button[data-key="' + ${JSON.stringify(key)} + '"]');`
        + ' if (el === null) return null; const r = el.getBoundingClientRect();'
        + ' return Math.round(r.x + r.width / 2); })()');
      const cA = await centreOf('A');
      const cS = await centreOf('S');
      const cZ = await centreOf('Z');
      const staggered = cA !== null && cS !== null && cZ !== null
        && Math.abs(cZ - (cA + cS) / 2) <= 2;

      /*
        THE `{` CAP MUST BE CLICKABLE, which is what the Return key's NARROW WIDTH buys.

        The user spotted that the two-row Return overlapped it: the home row's content runs 0.25
        units further right than the QWERTY row's, so a tall cap wide enough to meet the backslash
        above covers 7px of `{`. The Return is sized to the smaller, non-overlapping rectangle
        instead -- see the Return-shape check above, and `keyboard3279.ts` on the geometry.

        GEOMETRY, NOT A HIT TEST -- AND THE HIT TEST WAS THE WRONG TOOL, MEASURED.

        This check first used `elementFromPoint` at the brace cap's right edge, back when a
        `clip-path` was cutting a notch, and a mutant that REMOVED the clip still PASSED:
        hit-testing HONOURS a clip-path for pointer events, so the notched and un-notched cases
        both reported the brace. The check proved the clip worked by assuming it worked -- the same
        shape of mistake as the 2px tolerance that let the numpad defect through. The clip is long
        gone; the lesson is why this compares boxes and is kept for that reason.

        SO THIS COMPARES BOXES: the tall Return's left edge must not come left of the brace cap's
        right edge. That is exactly the overlap the user saw, and it is true or false regardless of
        what any cap paints.
      */
      const braceHitTest = await cdp.eval(`(() => {
        const b = document.querySelector('#keyboard-overlay button[data-key="} {"]');
        if (b === null) return 'no brace cap';
        const tall = document.querySelector('#keyboard-main button[style*="--kb-h"]');
        if (tall === null) return 'no tall cap';
        const r = b.getBoundingClientRect();
        const t = tall.getBoundingClientRect();
        const overlap = Math.round(r.right - t.left);
        return overlap > 0
          ? ('OVERLAPS by ' + overlap + 'px; brace right=' + Math.round(r.right)
             + ' tall left=' + Math.round(t.left) + ' tall width=' + Math.round(t.width))
          : 'clear';
      })()`);
      const braceClickable = braceHitTest === 'clear';

      const pfBox = await boxOf('keyboard-pf');
      const barBox = await boxOf('keyboard-special-left');
      const upBox = await cdp.eval(
        '(() => { const el = document.querySelector('
        + '\'#keyboard-cursor button[data-key="Cursor up"]\');'
        + ' if (el === null) return null; const r = el.getBoundingClientRect();'
        + ' return { x: Math.round(r.x), y: Math.round(r.y) }; })()');
      const downBox = await cdp.eval(
        '(() => { const el = document.querySelector('
        + '\'#keyboard-cursor button[data-key="Cursor down"]\');'
        + ' if (el === null) return null; const r = el.getBoundingClientRect();'
        + ' return { x: Math.round(r.x), y: Math.round(r.y) }; })()');

      const barOnLeft = barBox !== null && wideMain !== null && barBox.x < wideMain.x;
      const pfCentred = pfBox !== null && wideMain !== null
        && Math.abs((pfBox.x + pfBox.w / 2) - (wideMain.x + wideMain.w / 2)) <= 20;
      // WITHIN 3px, not exact: sub-pixel rounding on a calc() is normal and not a defect.
      const arrowsAligned = upBox !== null && downBox !== null
        && Math.abs(upBox.x - downBox.x) <= 3 && upBox.y < downBox.y;

      const sideBySide = wideMain !== null && wideNum !== null
        && wideNum.x > wideMain.x && Math.abs(wideNum.y - wideMain.y) < 20
        && barOnLeft && arrowsAligned && overflowing === ''
        // THE PF STRIP IS CENTRED OVER THE MAIN BLOCK, the user's other request. Measured on
        // CENTRES rather than edges, which is what "centred" means, and within 20px because the
        // strip is 12 units against the main block's 15 and the arithmetic is in `calc`.
        && pfCentred && numpadAligned && rectangle && staggered && braceClickable
        && insertGlyph.startsWith('renders') && returnOk;
      const reflowed = narrowMain !== null && narrowNum !== null
        && narrowNum.y > narrowMain.y;

      if (shown === true && capCount > 110 && sideBySide && reflowed) {
        ok(check('keyboard'),
          `Ctrl-B drew ${capCount} caps; at 1400px the numpad sits beside the main block `
          + `(x ${wideMain.x} -> ${wideNum.x}, same row), at 520px it reflows below `
          + `(y ${narrowMain.y} -> ${narrowNum.y}); the special bar is left of it `
          + `(x ${barBox?.x} < ${wideMain.x}) and the arrows form an inverted T `
          + `(up x ${upBox?.x}, down x ${downBox?.x}); the PF strip is centred over it `
          + `(centres ${Math.round((pfBox?.x ?? 0) + (pfBox?.w ?? 0) / 2)} vs `
          + `${Math.round(wideMain.x + wideMain.w / 2)}); the numpad lines up `
          + `(. at ${xPeriod} under 3 at ${xThree}, Ent at ${xEnter} under - at ${xMinus}); `
          + `the main block is a RECTANGLE (row right edges ${edges.join(', ')}) with Z centred `
          + `between A and S (${cZ} vs ${(cA + cS) / 2}); the Return leaves { clickable; `
          + `NO cap is clipped; the Insert glyph ${insertGlyph}; the Return is a plain two-row `
          + `RECTANGLE with an oversized gap beside it and nothing painted into it `
          + `(${returnShape})`);
      } else {
        no(check('keyboard'),
          'the full keyboard did not open, or its regions do not lay out side by side and reflow',
          `shown: ${shown}, caps: ${capCount}, `
          + `wide main: ${JSON.stringify(wideMain)}, wide numpad: ${JSON.stringify(wideNum)}, `
          + `narrow main: ${JSON.stringify(narrowMain)}, narrow numpad: ${JSON.stringify(narrowNum)}, `
          + `special bar: ${JSON.stringify(barBox)} (must be LEFT of main), `
          + `up: ${JSON.stringify(upBox)}, down: ${JSON.stringify(downBox)} (x must match), `
          + `pf: ${JSON.stringify(pfBox)} (centre must match main's), `
          + `numpad x: 3=${xThree} .=${xPeriod} -=${xMinus} Ent=${xEnter} (columns must align), `
          + `main row right edges: ${edges.join(', ')} (must be equal), `
          + `A=${cA} S=${cS} Z=${cZ} (Z must centre between A and S), `
          + `at the { cap's right edge the browser finds: ${braceHitTest} (must be the { cap, `
          + 'not the Return key), '
          + `CLIPPED CAPS: ${overflowing === '' ? 'none' : overflowing}; `
          + `Insert glyph: ${insertGlyph}; Return shape: ${returnShape} `
          + '(want the gap below EQUAL to the row gap, the gap to its left at least 3x it, '
          + 'and paint=none -- a plain rectangle, not an L). ' + metrics);
      }

      /*
        AND NOW THE FUNCTIONAL HALF, WHICH NO CHECK IN THIS FILE COVERED UNTIL 2026-10-23.

        EVERYTHING ABOVE MEASURES LAYOUT, and that is not a reading of the code -- it is a
        MEASUREMENT. `keyboardUi.ts`'s sole `deps.sendAction(action)` was replaced with
        `void action;`, which makes every cap dead, and this phase still reported 8/8 GREEN with
        all ten layout properties satisfied. A keyboard can be laid out perfectly and be entirely
        dead. The keypad phase's rule applies verbatim: sample one key from EVERY region, "so no
        block can go dead unseen".

        ASSERTED ON TWO INDEPENDENT WITNESSES, both of them real:

         - `window.__tn3270Probe.sent`, the array of every string the page handed to
           `WebSocket.send`, from the wrapper installed before any page script ran. This is the
           BROWSER's side of the wire.
         - THE GATEWAY'S OWN STDOUT. `--log-actions` is in `SERVER_ARGV`, and `web/src/main.ts`
           prints `action: <json>` for every decoded `{kind:'action'}` frame. So the action is read
           back from the process at the FAR END of the socket, after `decodeClientMessage`
           validated it -- not from the page that sent it.

        THE FULL ACTION OBJECT IS COMPARED, NOT ITS `kind`. Matching only `"pf"` would pass a cap
        that sent `{kind:'pf', n:7}`, and a mis-wired cap sending its NEIGHBOUR's action is the
        defect this check is most likely to meet. The expected JSON is written out here rather than
        imported, deliberately: importing the table would make this harness agree with the table by
        construction and assert nothing about what crosses the wire.

        ## BOTH WITNESSES EARN THEIR KEEP, AND THAT IS MEASURED RATHER THAN ARGUED

        Two further mutants were run to ask whether either half is decoration:

         - `keyboard3279.ts` `pfRow`'s `n: first + i + 1` -- every cap keeps its own label and name,
           so the keyboard still LOOKS right and `PF3` sends PF4's AID. `keyboardCaps` FAILED,
           reporting `PF3 MISSED (sent {"kind":"pf","n":4})`. A `kind`-only comparison would have
           passed it, which is why the whole object is compared.
         - `bridgecore.ts` `kind: 'action'` -> `kind: 'actin'` in the socket send. The page still
           hands the socket a string containing the right action JSON, so THE BROWSER-SIDE PROBE
           WAS SATISFIED FOR ALL FIVE CAPS -- and the gateway logged nothing, because
           `decodeClientMessage` dropped every frame. Only the far-end witness caught it.
      */
      const sentJson = () => cdp.eval('JSON.stringify(window.__tn3270Probe.sent)');
      const capSelector = (name) => `#keyboard-overlay button[data-key=${JSON.stringify(name)}]`;
      /**
       * WHAT THE BROWSER FINDS AT A CAP'S CENTRE, which is what `clickCenter` will actually hit.
       *
       * `clickCenter` computes a point and lets Chromium hit-test it, so a cap covered by another
       * fixed overlay is NOT clicked -- and the transfer form is still open at this point, fixed at
       * the top left, while this overlay is docked at the bottom. If the two ever overlap, the
       * click would land on the form and the cap would look dead. That failure mode must be
       * REPORTED as a covered cap rather than counted as a missing action, so it is measured.
       */
      const coveredBy = (name) => cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(capSelector(name))});
        if (el === null) return 'NO SUCH CAP';
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        if (hit === el) return '';
        return hit === null
          ? 'OUTSIDE THE VIEWPORT'
          : ('COVERED BY ' + (hit.id !== '' ? '#' + hit.id : hit.tagName.toLowerCase()));
      })()`);
      /**
       * Click a cap BY NAME and return only what the page sent as a result.
       *
       * BY NAME AND NOT BY LABEL, because several legends are glyphs, the spacebar's label is
       * empty and two Shift caps share a legend -- `data-key` carries `cap.name`, which
       * `keyboard3279.ts` keeps unique across all 118 caps.
       */
      const clickCap = async (name) => {
        const before = JSON.parse(await sentJson()).length;
        const covered = await coveredBy(name);
        if (covered !== '') return { sent: [], covered };
        await clickCenter(capSelector(name));
        await new Promise((r) => { setTimeout(r, 150); });
        return { sent: JSON.parse(await sentJson()).slice(before), covered: '' };
      };

      // ONE CAP PER REGION -- all five of them, so no region can go dead unseen. The `want` is the
      // EXACT action JSON, as `bridgecore.ts` embeds it in `{"kind":"action","action":...}`.
      const CAP_CASES = [
        { name: 'PF3', want: '{"kind":"pf","n":3}' },                 // region: pf
        { name: 'Enter', want: '{"kind":"enter"}' },                  // region: main
        { name: 'Cursor up', want: '{"kind":"up"}' },                 // region: cursor
        { name: '7', want: '{"kind":"type","text":"7"}' },            // region: numpad
        { name: 'Attention', want: '{"kind":"attn"}' },               // region: special-left
      ];
      const capResults = [];
      // The gateway's log so far, so only lines this block provokes are read back from it below.
      const serverBefore = serverOut.length;
      let capsSentOk = true;
      for (const kase of CAP_CASES) {
        const { sent, covered } = await clickCap(kase.name);
        if (covered !== '') {
          capsSentOk = false;
          capResults.push(`${kase.name} ${covered}`);
          continue;
        }
        const hit = sent.some((s) => s.includes(kase.want));
        if (!hit) capsSentOk = false;
        capResults.push(`${kase.name}${hit ? '' : ` MISSED (sent ${JSON.stringify(sent)})`}`);
      }
      /*
        AND THE SAME FIVE READ BACK OFF THE GATEWAY'S STDOUT, which is the half the page cannot
        fake. A browser-side probe proves the page tried; this proves the frame arrived, decoded
        and was understood as that action at the other end of the socket.

        WAITED FOR RATHER THAN READ STRAIGHT AWAY. `serverOut` is appended by a `'data'` handler on
        a pipe from ANOTHER PROCESS, so the last cap's line may not have been delivered to this
        one yet when the loop ends -- a flake that would read as a missing action. Bounded, and the
        loop exits as soon as all five are present.
      */
      const loggedSince = () => serverOut.slice(serverBefore).split('\n')
        .filter((l) => l.startsWith('action: '))
        .map((l) => l.slice('action: '.length));
      let loggedActions = loggedSince();
      for (let waited = 0; waited < 4000; waited += 100) {
        if (CAP_CASES.every((k) => loggedActions.includes(k.want))) break;
        await new Promise((r) => { setTimeout(r, 100); });
        loggedActions = loggedSince();
      }
      const notLogged = CAP_CASES
        .filter((k) => !loggedActions.includes(k.want))
        .map((k) => k.name);
      const capsOk = capsSentOk && notLogged.length === 0;

      /*
        AN INERT CAP SENDS NOTHING. The inert caps are `disabled` with NO click handler at all --
        deliberately, because `keyboardUi.ts` says a handler that returned early would be a second
        place for the no-op to be wrong. So this asserts the `disabled` attribute is doing its job:
        a cap that lost it would send an action this emulator cannot honour.

        A UNIT TEST CANNOT ASK THIS, AND THE MEASUREMENT IS BLUNTER THAN THE ARGUMENT. Giving the
        Caps Lock cap `action: { kind: 'attn' }` in `keyboard3279.ts` left THE WHOLE SUITE GREEN --
        109 files, 2577 tests, not one failure -- while this check failed with `it sent
        [{"kind":"action","action":{"kind":"attn"}}]`. The table's own test counts inert caps and
        does not pin WHICH caps are inert, so a cap quietly becoming actionable has no unit witness
        at all; whether `disabled` stops a real mouse event at a real cap's centre is a question
        only a browser answers.
      */
      const inert = await clickCap('Caps Lock (not implemented: see the header)');
      const inertOk = inert.covered === '' && inert.sent.length === 0;

      /*
        THE ONE-SHOT SHIFT, THROUGH THE REAL DOM, and it is here because a defect in exactly this
        logic reached the user on 2026-10-23: Shift was STICKY for 40 of the 60 character caps,
        because the consuming branch keyed off `shiftLabel !== undefined` -- false for every
        letter, since `A` shifted is still `A`. Every unit test of the day passed.

        THREE CLICKS AND THE THIRD IS THE ONE THAT MATTERS. Shift itself must send NOTHING (it is
        pure surface state, which is why its table entry has no action at all); the `2` cap then
        sends its SHIFTED legend `@`; and the same cap clicked again sends a plain `2`, because the
        arm was spent. Without that third click a LATCH would pass.
      */
      const shiftArmed = await clickCap('Shift (left, one-shot)');
      const shifted = await clickCap('@ 2');
      const after = await clickCap('@ 2');
      const shiftCovered = [shiftArmed, shifted, after].map((r) => r.covered).join('');
      const shiftOk = shiftCovered === ''
        && shiftArmed.sent.length === 0
        && shifted.sent.some((s) => s.includes('{"kind":"type","text":"@"}'))
        && after.sent.some((s) => s.includes('{"kind":"type","text":"2"}'));
      const shiftStory = `Shift sent ${JSON.stringify(shiftArmed.sent)}, `
        + `then ${JSON.stringify(shifted.sent)}, then ${JSON.stringify(after.sent)}`
        + (shiftCovered === '' ? '' : ` [${shiftCovered}]`);

      if (capsOk) {
        ok(check('keyboardCaps'),
          `one cap from every region reached the GATEWAY as its exact action: ${capResults.join(', ')} `
          + `-- logged by the gateway itself as ${loggedActions.join(' ')}`);
      } else {
        no(check('keyboardCaps'), "a region's caps are not reaching the gateway",
          `clicked ${capResults.join(', ')}; the gateway logged ${JSON.stringify(loggedActions)}, `
          + `so these never arrived: ${notLogged.length === 0 ? 'none' : notLogged.join(', ')}`);
      }

      if (inertOk) {
        ok(check('keyboardInert'),
          'an inert cap (Caps Lock) sent nothing at all, as `disabled` must make it');
      } else {
        no(check('keyboardInert'), 'an INERT cap sent an action, so it is not really inert',
          `it sent ${JSON.stringify(inert.sent)}`
          + (inert.covered === '' ? '' : ` and the cap was not clickable: ${inert.covered}`));
      }

      if (shiftOk) {
        ok(check('keyboardShift'),
          `Shift sent nothing itself, then @ then 2 -- armed, spent, back to plain (${shiftStory})`);
      } else {
        no(check('keyboardShift'), 'the one-shot Shift did not arm-then-spend',
          `${shiftStory} (want: nothing sent on Shift, then {"kind":"type","text":"@"}, `
          + 'then {"kind":"type","text":"2"} -- a second @ would mean Shift LATCHED)');
      }
    }

    /*
      ============================================================================================
      ===== webCopy AND webPaste: THE BROWSER'S OWN CLIPBOARD, BOTH DIRECTIONS ===================
      ============================================================================================

      ## WHAT HAD NO REAL-BROWSER COVER AT ALL BEFORE THIS BLOCK

      `gui/scripts/select.mjs` drives a real drag and reads the real clipboard -- in the ELECTRON
      CLIENT, where copy crosses IPC to `clipboard.writeText` in main. The gateway's route shares
      none of that: `main.ts`'s `copy` arm answers with a `copyText` SERVER MESSAGE, `bridgecore.ts`
      dispatches it to `deps.onCopyText`, `bridge.ts` hands it to `writeClipboard`, and
      `navigator.clipboard` is what actually writes. The paste direction has no Electron twin at
      ALL -- `forwardPaste`'s `PASTE_HOSTS` gate exists precisely to keep that listener out of the
      GUI, where `applyAction`'s throw would freeze the main process.

      ## IT RELOADS FIRST, AND ON A FRESH SESSION, FOR TWO SEPARATELY MEASURED REASONS

      Stated where it happens rather than here -- see the comment on the reload below. In short: the
      reload is what clears the two open overlays off the screen the drag needs, and dropping the
      stored session id is what gets a 3270 session whose buffer and cursor the twelve checks above
      have not already written to. The probe's socket wrapper survives either, being installed
      per-document.

      ## THE TWO WITNESSES, AND WHY THE SECOND ONE IS NOT THE HARNESS'S OWN ECHO

      The keyboard phase's rule, applied here. A page-side probe alone was satisfied by a mutant
      there, and the same shape is available here -- `window.__tn3270Probe.sent` would show a
      well-formed `copy` frame however badly the gateway answered it.

       - THE GATEWAY'S OWN STDOUT, for both directions. `--log-actions` prints `action: <json>` for
         every DECODED frame, and the `copy` arm additionally prints an UNGATED `copy: N chars`.
       - For copy, THE REAL OS CLIPBOARD, read back through `navigator.clipboard.readText()`. This
         is the far end of the whole chain and the harness never wrote the value: a SENTINEL is put
         on the clipboard first, so "the clipboard still holds what we put there" is a failure and
         not a pass. This task's plan expected `onCopyText` to have to be INSTRUMENTED instead,
         because "`navigator.clipboard` cannot be read back in a headless Xvfb Chromium without a
         permission grant" -- MEASURED FALSE HERE (see the measurement note below), so the stronger
         witness is used and nothing is instrumented. The production `onCopyText` runs unmodified.
       - For paste, THE SCREEN ITSELF, read back by copying it. The pasted text reaches the buffer
         through `applyPaste` -> `pasteString` in the GATEWAY, and the only way to see it from here
         is a second round trip: a repaint, a new draw list, a fresh `copy` action and the
         gateway's own `extractText`. A paste that was logged but typed nothing fails this.

      ## WHAT IS MEASURED ABOUT `navigator.clipboard`, WHICH TASK 4 LEFT OPEN

      MEASURED 2026-10-26, this page over `http://127.0.0.1:<port>` under Xvfb Chromium
      (Electron 44.3.0, URL mode):

        window.isSecureContext             true
        typeof navigator.clipboard         'object'
        typeof navigator.clipboard.writeText  'function'
        typeof navigator.clipboard.readText   'function'
        permissions clipboard-read / -write   'granted' / 'granted'
        writeText()                        resolves, and readText() reads the value back

      So Chromium treats `127.0.0.1` as a SECURE CONTEXT on plain `http`, which is why
      `writeClipboard`'s `clip !== undefined` branch is the one that runs here. THE OTHER BRANCH IS
      STILL NOT COVERED BY ANY BROWSER RUN, and cannot be from loopback: it needs a LAN address,
      where `navigator.clipboard` is absent -- which is the asymmetry `bridgecore.ts`'s docstring
      exists for and the deployment this gateway is actually for. `writeClipboard`'s unit tests are
      what cover it. BOTH VALUES ARE ASSERTED BELOW rather than only noted here, because a
      successful clipboard write does not by itself say which branch produced it.

      NO `execCommand` FALLBACK IS ADDED and none is implied: `document.execCommand('copy')` was
      measured here too and returned FALSE in this page, so a speculative fallback would have been
      a dead path. `bridgecore.ts`'s refusal to guess stands.

      ## THE MUTATIONS THESE TWO WERE PROVED AGAINST, EACH APPLIED, BUILT, RUN AND REVERTED

       - `bridge.ts` `onCopyText: () => {}`. 110 files and 2603 unit tests ALL PASSED; `webCopy`
         failed with the gateway's own `copy: 18 chars` line present and the clipboard still
         holding the sentinel. This is the pair's reason for existing.
       - `main.ts` with the whole `copy` arm deleted. `webCopy` failed -- and the gateway PROCESS
         DIED on `applyAction does not handle copy`, taking the session with it, which is the
         two-branch rule's hazard caught from the outside.
       - `forwardKeys.ts` with the `deps.on('paste', ...)` registration removed. `webPaste` failed
         with the gateway logging NOTHING and the payload nowhere on the screen; `webCopy` stayed
         GREEN, which is what says the copy check does not depend on the paste one.
       - `forwardKeys.ts` with `if (text === '') return;` deleted. `webPaste` failed at 12/13,
         reporting `the page sent [{"kind":"paste","text":""}]` -- so the empty-clipboard control
         below is a real kill and not decoration. `webCopy` stayed green.
       - `selection.ts`'s `hidden` handling dropped: SURVIVED at 13/13 here. See the table entry.

      ## AND THE THREE THE REAL CHORD ADDED, 2026-10-27, each applied, force-rebuilt and reverted

      These are the mutations `__tn3270Copy()` could not reach, because they are in the GESTURE
      rather than in the path behind it. Each was built with `npx tsc --build --force
      packages/canvas` -- a restored backup has an OLDER mtime, so a plain `tsc --build` sees
      nothing to do and `dist/` silently keeps the mutant, the trap recorded at the focus-emulation
      note below.

       - `keys.ts` with the `requestCopy` branch MOVED BELOW the case-folded
         `CTRL[e.key.toLowerCase()]` lookup. `webCopy` failed at 11/13, reporting
         `the CHORD raised no copy frame at all` with the page having sent
         `{"kind":"action","action":{"kind":"clear"}}` and the gateway having logged
         `action: {"kind":"clear"}` four times -- the fold doing exactly what `keys.ts` says it
         does. The clipboard kept its sentinel.
       - `renderer.ts` with the `action.kind === 'requestCopy'` arm MOVED BELOW
         `clearSelection()`. `webCopy` failed at 11/13 with a DIFFERENT signature, which is what
         makes the two distinguishable: the page sent `[]` -- NOTHING at all -- because
         `copySelection()` found `anchor === null` and returned false. The gateway logged nothing.
       - `renderer.ts` with the arm made `copySelection(); clearSelection(); return;` -- MY OWN
         THIRD MUTATION, aimed at the survival assertion rather than at either plan-named one, and
         the most informative of the three. It is a copy that FULLY SUCCEEDS and then destroys the
         selection, so the first half of this check is entirely green: the right text on the
         clipboard, `action: {"kind":"copy",...}` and `copy: 18 chars` both logged, one drag
         attempt. ONLY the survival clause failed, at 12/13, reporting
         `THE SECOND COPY sent [], left the clipboard reading "...-second"`. **ALL 2614 UNIT TESTS
         IN 110 FILES PASSED ON IT**, `renderer-imports.test.ts`'s order pin INCLUDED -- that test
         asserts `clearSelection()` appears after the arm, and here it does, twice. So this check
         is the only witness in the repo for `copySelection`'s "an operator who copies twice gets
         the same text twice" contract, and that is why the second press earns its place.

      BOTH PLAN-NAMED MUTATIONS ALSO FAIL `webPaste`, COLLATERALLY AND NOT AS PROOF, for the reason
      the next section gives: `webPaste`'s screen witness reads back through `copyCells`, which is
      the COPY path and now goes through the chord. The third one does NOT -- `webPaste` stayed
      green on it at 12/13 -- because a copy that works once is all that witness needs.

      ## THE DEPENDENCE RUNS ONE WAY, AND THE COLLATERAL FAILURE IS NOT THE PROOF

      This file's header states the rule for phase two's earlier mutants and it applies here:
      `webPaste` ALSO FAILS on `bridge.ts onCopyText: () => {}` (measured: 11/13, not 12/13),
      because its second witness reads the screen back through `copyCells` -- which is the COPY
      path. The failure is honest about itself now (it names the clause, and the clause it names is
      `the payload is NOT on the screen afterwards`), but a reader must not take it as evidence
      about the paste listener: in that run the gateway logged
      `action: {"kind":"paste","text":"TN3270-PASTE-PROBE"}` perfectly and the paste WORKED.

      THAT DEPENDENCE GOT WIDER WHEN `copyCells` STARTED DRIVING THE CHORD, 2026-10-27, and it is
      worth stating rather than leaving to be rediscovered: `webPaste`'s screen witness now needs
      the COPY GESTURE to work as well as the copy path, so BOTH gesture mutations above redden it
      too (measured: 11/13 on each, with `the payload is NOT on the screen afterwards` and a
      perfect `action: {"kind":"paste",...}` line in the log). The alternative was to leave
      `webPaste` calling `__tn3270Copy()` for its read-back, which would have kept the two checks
      independent -- REJECTED, because it would mean this file read the screen back by a route no
      operator has, and the `action:` line already isolates paste by itself.

      SO THE `action:` LINE IS THE HALF THAT ISOLATES PASTE, and the screen read-back is the half
      that proves it did something. The reverse dependence does not exist -- `webCopy` survived
      every paste-side mutation -- so a `webCopy`-only failure means the copy path or the copy
      GESTURE, a `webPaste`-only failure means the paste path, and BOTH failing means one of the
      copy ones. `webCopy`'s own clause list is what then says which.
    */
    {
      /*
        A RELOAD WITH THE STORED SESSION ID REMOVED, SO THIS BLOCK GETS A FRESH 3270 SESSION.

        BOTH HALVES OF THAT ARE LOAD-BEARING AND THE SECOND ONE WAS MEASURED THE HARD WAY.

        THE RELOAD is what clears the overlays. The selection gesture and the paste listener are
        both on `window` and both act on the SCREEN, and at this point two overlays are open: the
        transfer form, fixed at the top left, and the keyboard, docked along the bottom.
        `clickCenter`'s rule applies to a cell exactly as it does to a cap -- Chromium hit-tests the
        point, so a drag starting under the form would press the FORM. Both overlays start hidden on
        every page load (the no-persistence decision), so a reload clears them without this harness
        having to assert anything about a close button. MEASURED after it: `elementFromPoint` at
        cells (0,0) and (23,79) both find `#screen`.

        REMOVING `tn3270.sessionId` IS WHAT MAKES THE SESSION FRESH, and it is why the paste's
        landing place is assertable at all. `bridgecore.ts`'s `onopen` sends `hello` WITH the
        stored id, so a plain reload REATTACHES to the session every check above has been driving
        -- and those checks have typed into the buffer and moved the cursor (the keypad phase's
        `7`, `@` and `2`, plus the `type` actions the transfer form's fields leak through
        `renderer.ts`'s window listener). `browser-shot.mjs` records the mechanism this exploits: a
        `hello` with no session id creates a SECOND replayed session, which cannot see the first's
        state.

        `sessionStorage`, NOT `localStorage`, AND THE DIFFERENCE IS NOT COSMETIC. `bridge.ts` passes
        `storage: sessionStorage` to `createBridge`. Clearing `localStorage` here was MEASURED to
        do exactly nothing: the reload sent `{"kind":"hello","sessionId":"..."}` as before and the
        old session came back. The frame to watch for is the `hello` the page sends -- it must have
        NO `sessionId` member.
      */
      await cdp.eval("window.sessionStorage.removeItem('tn3270.sessionId')");
      await cdp.cmd('Page.reload');
      await new Promise((r) => { setTimeout(r, 4000); });

      /**
       * The screen's own extent, asked of the renderer rather than assumed from the model.
       *
       * `__tn3270CellCenter` returns null past the last column and past the OIA row, so walking
       * out until it does is the renderer's own answer to "how big is the screen" -- and it is
       * reported on failure, because a run whose page never got a frame would otherwise fail with
       * "NO SUCH CELL" and say nothing about why. MEASURED 2026-10-26 on this fixture: rows 0..23,
       * columns 0..79, i.e. a 3278-2 with the OIA excluded, which is what `cellAt` promises.
       */
      let lastRow = -1;
      let lastCol = -1;
      for (let r = 0; r < 100; r += 1) {
        if (await cdp.eval(`window.__tn3270CellCenter(${r}, 0) === null`) === true) break;
        lastRow = r;
      }
      for (let c = 0; c < 300; c += 1) {
        if (await cdp.eval(`window.__tn3270CellCenter(0, ${c}) === null`) === true) break;
        lastCol = c;
      }
      const extent = `the renderer reports rows 0..${lastRow}, columns 0..${lastCol}`;

      /**
       * A REAL DRAG from one CELL to another, by cell and never by pixel.
       *
       * `__tn3270CellCenter` is the renderer's own inverse of `cellAt`, which is why this harness
       * holds no copy of the geometry -- the same argument `select.mjs` makes for the GUI and this
       * file's header makes for the keypad's labels. The intermediate `mouseMoved` is not padding:
       * `mousedown` sets anchor AND focus to the same cell, so without a move the rectangle would
       * be 1x1 and `isEmptyRect` would refuse it -- a drag that never moved would look like a
       * selection that was never made.
       */
      const dragCells = async (fromRow, fromCol, toRow, toCol) => {
        const a = JSON.parse(await cdp.eval(
          `JSON.stringify(window.__tn3270CellCenter(${fromRow}, ${fromCol}))`));
        const b = JSON.parse(await cdp.eval(
          `JSON.stringify(window.__tn3270CellCenter(${toRow}, ${toCol}))`));
        if (a === null || b === null) return `NO SUCH CELL (${fromRow},${fromCol})-(${toRow},${toCol})`;
        // WHAT THE BROWSER FINDS AT THE PRESS POINT, for the reason `coveredBy` gives above: a
        // cell under an overlay would be pressed on the OVERLAY, and that must be reported as a
        // covered screen rather than counted as a selection that did not happen.
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
        await new Promise((r) => { setTimeout(r, 250); });
        return '';
      };

      /**
       * Drag, press the REAL Copy chord, and read the REAL clipboard back.
       *
       * ## A SENTINEL GOES ON THE CLIPBOARD FIRST, AND EVERY COPY GETS ITS OWN
       *
       * It is what makes the read an assertion rather than a coincidence: an unchanged clipboard is
       * indistinguishable from a successful write unless the prior value is known and different.
       * `main.ts` deliberately sends NOTHING for an empty copy -- so "the clipboard was not
       * touched" is a real outcome of this product and has to be told apart from a copy that
       * worked. `sentinel` is a PARAMETER rather than one module constant precisely because the
       * survival check below copies TWICE: a second copy that did nothing would be invisible if the
       * clipboard still held the first copy's text.
       *
       * ## THE REAL CHORD, NOT THE PAGE GLOBAL -- AND THAT IS NEW ON 2026-10-27
       *
       * THIS USED TO CALL `window.__tn3270Copy()`, and its comment said -- correctly, at the time
       * -- that the page bound no copy gesture at all, so only the human's keystroke was being
       * substituted. **THAT IS NO LONGER TRUE.** `canvas/src/keys.ts` now claims `Ctrl-Shift-C`
       * (and `Cmd-Shift-C`) as `{kind:'requestCopy'}`, `renderer.ts` intercepts that kind before
       * `clearSelection()` and calls `copySelection()`, so there IS a keystroke to deliver and it
       * is delivered: a plain `Input.dispatchKeyEvent` pair, the same command `webPaste` uses.
       *
       * STRICTLY STRONGER THAN THE GLOBAL, which is the whole reason to change it. The global
       * entered BELOW the keymap and below the keydown listener, so it covered the rect building,
       * `sendAction`, the socket, the gateway and the clipboard -- and NOTHING about whether an
       * operator could reach any of it. The chord covers the BINDING as well: `actionForKey`'s
       * branch ORDER (it must precede the case-folded `CTRL` lookup, or `Ctrl-Shift-C` folds to
       * Clear) and `renderer.ts`'s arm order (it must precede `clearSelection()`, or the rect is
       * destroyed a moment before it is read). Both of those mutations leave the build green, the
       * types sound and 2614 unit tests passing; both are measured to fail HERE.
       *
       * THE GLOBAL IS NOW UNCOVERED BY THIS FILE, which is a real trade and is stated rather than
       * glossed: `__tn3270Copy` is still the Electron menu's route, and `gui/scripts/select.mjs`
       * is what drives it. `renderer.ts` keeps the global as a one-line delegation to the same
       * `copySelection()` this chord reaches, so the two routes cannot diverge in the rect they
       * build -- only in how they are triggered, and each trigger now has its own harness.
       *
       * ## WHAT A GREEN RUN HERE IS NOT EVIDENCE ABOUT
       *
       * THE ELECTRON COPY ACCELERATOR IS THE SAME CHORD ON LINUX (`gui/src/menu.ts`'s
       * `copyAccelerator`), and this run says nothing about whether the two double-fire. Not
       * because the question is uninteresting but because THIS HARNESS HAS NO MENU TO COLLIDE
       * WITH: `main.ts` returns out of `app.whenReady()` at the end of its `TN3270_GUI_URL` branch,
       * and `Menu.setApplicationMenu` is ~550 lines further down, in the branch that builds a
       * Session. VERIFIED 2026-10-27 in the BUILT `gui/dist/main.js`: the URL-mode `return` is at
       * `:396` and `setApplicationMenu` at `:968`. So the chord this check presses has exactly one
       * claimant, which is why it is a clean test of the page binding -- and why the overlap
       * remains what Task 4 of this feature recorded it as: unmeasurable from this repo, needing a
       * human on a real desktop.
       */
      const SENTINEL = 'tn3270-harness-sentinel-not-a-copy';
      /** What `writeClipboard` said, if it said anything. Its only channel is `console.warn`. */
      const clipWarns = () => cdp.eval(
        "JSON.stringify(window.__tn3270Probe.warns.filter((w) => w.startsWith('copy: ')))");
      /*
        NO FOCUS EMULATION HERE, AND THE REMOVED LINE IS WORTH A NOTE BECAUSE OF WHY IT WAS ADDED.

        An `Emulation.setFocusEmulationEnabled` call stood here for one commit, on the theory that
        `navigator.clipboard.writeText` -- which rejects with `NotAllowedError: Document is not
        focused` when the page lacks focus -- needed help under an Xvfb with no window manager.
        IT WAS CARGO. REMOVED AND RE-MEASURED 2026-10-26: both checks still pass, `webCopy` on its
        FIRST drag attempt with `writeClipboard` warning about nothing. So focus is not a problem
        this harness has, and the call was prophylaxis against a failure that never happened here.

        IT WAS ALSO ADDED ON A WRONG DIAGNOSIS, which is the durable half of this note. `webCopy`
        had failed on a build whose copy path was untouched, and the focus call looked like the
        cause because the symptom was a clipboard that did not change. It was not: `hasFocus()` was
        already true, nothing had warned, a direct `writeText`/`readText` round trip worked, and the
        page's inflated inbound frames showed `{"kind":"copyText","text":" MENU\n OPTION ===>"}`
        ARRIVING with no clipboard write after it. The real cause was a STALE `dist/` -- this task's
        mutation runner reverted `bridge.ts` by restoring a copy with an OLDER mtime, so
        `tsc --build` saw nothing to do and `dist/bridge.js` still held `onCopyText: () => {}`.
        That is this repo's recorded `tsc`-orphan shape met from the other direction, and the
        staleness guard at the top of this file cannot catch it BECAUSE THE MTIME WENT BACKWARDS.
        `npx tsc --build --force` is what cleared it.

        AND NOT ADDING IT BACK IS THE MORE INFORMATIVE CHOICE, not merely the tidier one: a real
        focus rejection now fails LOUDLY, because `copyWarnings.length === 0` is asserted and
        `writeClipboard` reports exactly that case through the warn channel this probe captures.
        A prophylactic call would hide the one failure it was supposed to guard against.
      */
      /**
       * ONE PRESS OF THE REAL CHORD, over a fresh sentinel, WITHOUT TOUCHING THE SELECTION.
       *
       * SEPARATED FROM THE DRAG ON PURPOSE, and that separation is the survival assertion's whole
       * mechanism: the second copy must press the chord against the selection the FIRST one read,
       * so it cannot re-drag. A helper that dragged again would prove a new selection works and
       * say nothing about whether the old one lived.
       *
       * `copied` IS THE PAGE'S OWN `copy` FRAME AND NOT A RETURN VALUE, which is forced rather
       * than chosen: a keystroke returns nothing. `renderer.ts`'s arm DISCARDS `copySelection()`'s
       * boolean deliberately (a keystroke has nobody to tell), so the observable that replaces it
       * is the socket send `copySelection()` makes -- which is exactly the same condition the old
       * boolean reported, since the function returns false precisely when it sends nothing. Read
       * off the probe's `sent` log, which is the product's own `send` call and not something this
       * harness manufactured.
       *
       * IT IS STILL NOT THE WITNESS THE CHECK PASSES ON. The gateway's log line and the real
       * clipboard are, below; this one decides whether the documented repaint race needs a retry.
       */
      const chordCopy = async (sentinel) => {
        const written = await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(sentinel)})
          .then(() => '').catch((e) => String(e))`);
        const sentBefore = await cdp.eval('window.__tn3270Probe.sent.length');
        const keysBefore = await cdp.eval('window.__tn3270Probe.keys.length');
        // THE CHORD. `KeyC` is the field the branch matches on; see `press`'s own note for why a
        // missing `code` would deliver an event that cannot fire it.
        await press('C', 'KeyC', 67, CDP_CTRL | CDP_SHIFT);
        // Bounded, and it exits as soon as the frame appears: the keystroke, the keymap, the arm
        // and `sendAction` are all synchronous, but the probe is read over CDP.
        let frames = [];
        for (let waited = 0; waited < 3000; waited += 100) {
          frames = JSON.parse(await cdp.eval(
            `JSON.stringify(window.__tn3270Probe.sent.slice(${sentBefore}))`));
          if (frames.some((f) => f.includes('"kind":"copy"'))) break;
          await new Promise((r) => { setTimeout(r, 100); });
        }
        // WHAT THE PAGE ACTUALLY RECEIVED, for the diagnosis `PROBE_SOURCE`'s note explains: it
        // separates "the chord did not fire" from "the harness sent the wrong event".
        const keys = JSON.parse(await cdp.eval(
          `JSON.stringify(window.__tn3270Probe.keys.slice(${keysBefore}))`));
        const copied = frames.some((f) => f.includes('"kind":"copy"'));
        if (!copied) return { written, copied, clip: sentinel, frames, keys };
        // The write is a round trip to the gateway and back through a promise, so it is waited
        // for rather than slept past: bounded, and it exits as soon as the sentinel is gone.
        let clip = sentinel;
        for (let waited = 0; waited < 6000 && clip === sentinel; waited += 150) {
          await new Promise((r) => { setTimeout(r, 150); });
          clip = await cdp.eval(
            "navigator.clipboard.readText().then((t) => t).catch((e) => 'REJECTED ' + String(e))");
        }
        return { written, copied, clip, frames, keys };
      };

      const copyOnce = async (sentinel, fromRow, fromCol, toRow, toCol) => {
        const dragged = await dragCells(fromRow, fromCol, toRow, toCol);
        if (dragged !== '') return { problem: dragged };
        return { problem: '', ...(await chordCopy(sentinel)) };
      };
      /**
       * `copyOnce`, RETRIED WHEN A REPAINT CLEARED THE SELECTION UNDER THE DRAG.
       *
       * ## THIS IS A REAL RACE IN THE PRODUCT AND NOT A FLAKY HARNESS, WHICH IS WHY IT IS NAMED
       *
       * `renderer.ts`'s `onFrame` handler calls `clearSelection()` on EVERY frame, deliberately: a
       * highlight over text the host has just changed would offer a copy of something the operator
       * never saw. So an inbound frame that lands between the `mouseup` and the chord wipes the
       * selection, and `copySelection()` correctly finds `anchor === null` and sends nothing --
       * nothing was selected by then.
       *
       * MEASURED 2026-10-26: that is EXACTLY what happens to the drag after the paste, every time,
       * because the gateway's `paste` arm calls `repaint()` unconditionally and that frame is in
       * flight while this harness is dragging. The first attempt returned `copied=false` with the
       * sentinel untouched; a second attempt immediately after returned the screen WITH the
       * payload on it. (That run drove `__tn3270Copy()` rather than the chord, and the race is
       * identical either way: both end at the same `copySelection()`, which is the single place
       * that reads `anchor`. Re-measured through the chord on 2026-10-27 -- still 2 attempts for
       * the post-paste drag, still 1 for the plain one.)
       *
       * RETRIED ONLY ON `copied === false` -- i.e. on NO `copy` FRAME HAVING BEEN SENT, which is
       * the narrow signal for this one cause -- so an empty or wrong clipboard is NOT retried and
       * a genuinely broken copy still fails rather than being slept over. The attempt count is
       * reported either way.
       *
       * EACH ATTEMPT GETS A FRESH SENTINEL, and it has to: a retry that reused the last one would
       * be unable to tell a successful write from a clipboard nobody touched -- the same reason the
       * survival check below uses two.
       *
       * AN OPERATOR MEETS THIS TOO, AND IT IS NOT HARMLESS FOR THEM -- a claim that it was stood
       * here for one commit and is WITHDRAWN. It said an operator "would press Copy after the
       * screen settled, because they are selecting something they can see", which does not follow:
       * the clear fires on EVERY frame, not only on frames that touch the selected cells, and a
       * live host sends frames nobody can anticipate (an unsolicited Write from a running job, a
       * status-line update, a timed panel refresh). So the operator's sequence is drag, reach for
       * Copy, a host frame arrives, and the selection is silently gone -- with `copySelection()`
       * returning `false`, which `renderer.ts`'s `requestCopy` arm deliberately treats as not worth
       * a message. Silence, repeatedly, on a busy panel. The chord makes this WORSE rather than
       * better for the operator, which is worth naming: the gesture is now reachable, so they will
       * actually meet it.
       *
       * THE RACE IS PRE-EXISTING AND NOT THIS FEATURE'S: the `clearSelection()` on every frame has
       * been there since `07104cb`, 2026-10-05, and the Electron GUI has it identically. So it is
       * not fixed or narrowed here -- that is a design question about the clear POLICY, not about
       * this harness.
       *
       * THIS IS THE WRONG PLACE FOR THAT NOTE AND IT IS DELIBERATELY NOT THE ONLY PLACE. Nobody
       * reading `renderer.ts`'s selection policy will look in a web harness's retry helper, so the
       * operator-facing half belongs beside the clear itself and in `docs/live-testing.md`. RAISED
       * with the task rather than written here, so it lands as one decision instead of a comment
       * that only this file's readers ever see.
       */
      const copyCells = async (fromRow, fromCol, toRow, toCol) => {
        let last = { problem: 'never attempted' };
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          last = await copyOnce(`${SENTINEL}-try${attempt}`, fromRow, fromCol, toRow, toCol);
          last.attempts = attempt;
          last.sentinel = `${SENTINEL}-try${attempt}`;
          if (last.problem !== '' || last.copied === true) return last;
          // A frame cleared it. Let the next one arrive before trying again.
          await new Promise((r) => { setTimeout(r, 500); });
        }
        return last;
      };

      /** Every `action:` line the gateway has logged since a mark, and the `copy:` lines too. */
      const logsSince = (mark) => serverOut.slice(mark).split('\n').filter((l) => l !== '');
      /**
       * Wait for a line the gateway should have printed, bounded.
       *
       * `serverOut` is filled by a `'data'` handler on a pipe from ANOTHER PROCESS, so a read
       * taken the instant after an action is sent can legitimately see nothing -- the flake the
       * keyboard phase documents and waits out for the same reason.
       */
      const waitForLog = async (mark, matches, ms = 6000) => {
        for (let waited = 0; waited < ms; waited += 100) {
          if (logsSince(mark).some(matches)) break;
          await new Promise((r) => { setTimeout(r, 100); });
        }
        return logsSince(mark);
      };

      // ===== webCopy ===========================================================================
      //
      // THE EXACT TEXT, NOT MERELY THAT SOMETHING WAS COPIED, which is the correction `select.mjs`
      // records against its own plan: a non-empty clipboard passes against an off-by-one
      // rectangle, a transposed row/column or text taken from the wrong row entirely. The fixture
      // is a REPLAY, so the screen is fixed and the strings can be spelled out -- row 0 is
      // `" MENU"` and row 1 is `" OPTION ===>"`, with the trailing blanks trimmed PER LINE, which
      // is `extractText`'s rule and is what makes a copied column paste usefully.
      //
      // THE TWO-ROW RECTANGLE DELIBERATELY, for `select.mjs`'s reason: only a multi-row case
      // proves the rectangle is normalized and joined in the right order, and it is the case where
      // a row/column transposition stops being invisible.
      const COPY_WANT = ' MENU\n OPTION ===>';
      const secure = await cdp.eval('window.isSecureContext');
      const clipApi = await cdp.eval('typeof navigator.clipboard');
      const copyMark = serverOut.length;
      const copyRun = await copyCells(0, 0, 1, 11);
      const copyLogs = copyRun.problem === ''
        ? await waitForLog(copyMark, (l) => l.startsWith('copy: '))
        : [];
      // BOTH GATEWAY LINES, and they say different things. The `action:` line is the frame as
      // `decodeClientMessage` understood it -- the rect, which is the browser's half. The `copy:`
      // line is the gateway's own account of what `extractText` produced from its OWN screen, and
      // it is UNGATED in production precisely because it carries a COUNT and never the text.
      const copyAction = copyLogs.find((l) => l.startsWith('action: {"kind":"copy"'));
      const copyChars = copyLogs.find((l) => l.startsWith('copy: '));
      /*
        ===== AND THE SELECTION SURVIVED, PROVED BY COPYING A SECOND TIME WITHOUT RE-DRAGGING =====

        THIS IS THE ONLY END-TO-END WITNESS FOR `renderer.ts`'s `clearSelection()` EXEMPTION, and
        no unit test in this repo can reach it: `renderer.ts` touches `window` at module load, so
        nothing imports it, and `renderer-imports.test.ts` can only pin the ORDER OF TWO LINES in
        the built text. That test would still pass on an emit whose arm ran first and whose
        `copySelection` had been broken some other way; this presses the real chord twice and reads
        the real clipboard both times.

        WHAT THE SECOND PRESS DISTINGUISHES, SPELLED OUT BECAUSE THE NAIVE VERSION PROVES NOTHING.
        If `requestCopy` were intercepted BELOW `clearSelection()`, the first press would clear and
        then copy an empty rect -- so the FIRST assertion already fails and this one is moot. The
        case this one exists for is subtler: anything that clears the selection AS A SIDE EFFECT OF
        A SUCCESSFUL COPY. `copySelection()` promises not to ("an operator who copies twice gets
        the same text twice", its own docstring), and the GUI's menu route depends on the same
        promise. A clear added there -- or an arm rewritten to `clearSelection(); copySelection();`
        in the other order -- leaves press one green and press two sending nothing at all.

        A FRESH SENTINEL BETWEEN THE TWO IS WHAT MAKES IT AN ASSERTION. With one sentinel, a second
        copy that did nothing would leave the first copy's text on the clipboard and read as a
        success -- the "unchanged clipboard is indistinguishable from a successful write" trap this
        file already uses a sentinel for once. So `chordCopy` takes the sentinel as a parameter and
        this call passes a different one.

        NO SECOND DRAG, deliberately, and it is the entire point: re-dragging would build a NEW
        selection and prove only that a second copy works, which is not the question.

        NOT RETRIED, unlike the first copy. The repaint race `copyCells` documents would make a
        retry here ambiguous -- "no frame sent" would mean either a cleared-by-us selection (the
        defect) or a cleared-by-a-host-frame one (the race), and a retry cannot tell them apart
        because a retry CANNOT re-drag. The first copy's own retry loop is what absorbs the race:
        this runs immediately after a copy that just succeeded, with no `repaint()` provoked in
        between (`main.ts`'s `copy` arm sends a `copyText` message and returns; it does not
        repaint), so a frame in that window would have to be unsolicited -- which a REPLAY session
        never sends, having no host. If this ever flakes on a live fixture, the fix is to assert the
        pair atomically, not to retry.
      */
      const againMark = serverOut.length;
      const copyAgain = copyRun.copied === true
        ? await chordCopy(`${SENTINEL}-second`)
        : { copied: false, clip: '(the first copy never happened)', frames: [], keys: [] };
      const againLogs = copyRun.copied === true
        ? await waitForLog(againMark, (l) => l.startsWith('copy: '))
        : [];
      const againChars = againLogs.find((l) => l.startsWith('copy: '));
      /*
        AND THE SENTINEL WRITE ITSELF IS ASSERTED, which was a gap in the first draft of this check.

        `chordCopy` returns `written` -- `''` or the rejection string from
        `navigator.clipboard.writeText`. Not asserting it would hand the survival check a FALSE PASS
        in the one case the sentinel exists to rule out: if writing `...-second` failed, the
        clipboard would still hold the FIRST copy's text, `clip === COPY_WANT` would be true, and a
        second press that did absolutely nothing would read as a success. The sentinel only
        discriminates if it actually landed. Asserted for BOTH presses, since the first one's
        sentinel has the same job.

        PROVED BY A CONTROL RUN RATHER THAN BY READING IT, 2026-10-27, because a guard nobody has
        seen fail is a guard nobody has tested: the second sentinel's write was replaced with
        `Promise.resolve('CONTROL: refused')`, which does not touch the clipboard. `webCopy` failed
        at 12/13 -- AND ITS FIRST DRAFT BLAMED THE PRODUCT, reporting only
        `the SELECTION DID NOT SURVIVE`. That is why the clause list below names the HARNESS fault
        first and says the survival clause is MEASURELESS rather than failed; re-measured after the
        split, the same control reports the harness's fault first. Control reverted.
      */
      const secondSentinelLanded = copyAgain.written === '';
      const survived = copyAgain.copied === true
        && secondSentinelLanded
        && copyAgain.clip === COPY_WANT
        && againChars === `copy: ${COPY_WANT.length} chars`;
      // AND `writeClipboard` MUST HAVE WARNED ABOUT NOTHING. Its two failure routes -- no API, and
      // a browser that refused -- are reported only through the injected `warn`, which `bridge.ts`
      // wires to `console.warn`. A clipboard holding the right text while that function complained
      // would mean something other than the route under test put it there. READ AFTER BOTH COPIES,
      // so a second press that warned cannot slip past.
      const copyWarnings = JSON.parse(await clipWarns());
      /*
        WHICH CLAUSE FAILED, NAMED -- the correction `webPaste` below records against its own first
        draft, applied here before it can cost anyone the same wrong diagnosis. This conjunction is
        now a conjunction of several independent things over TWO presses of a chord -- NOT COUNTED
        HERE ON PURPOSE, since a count in prose is the thing that goes stale when a clause is added
        (it went stale once inside this very commit). The list below is its own inventory.

        AND "the clipboard reads X" IS A MEASURED VALUE RATHER THAN A DIAGNOSIS: with the keys.ts
        branch moved after the `CTRL` lookup the clipboard reads the SENTINEL and the gateway logs
        `{"kind":"clear"}`, which names neither the chord nor the fold unless something says so.
      */
      const dragFailed = copyRun.problem !== undefined && copyRun.problem !== '';
      // THE DRAG'S OWN FAILURE SHORT-CIRCUITS THE REST, rather than being listed alongside the
      // consequences of it. A covered screen leaves `copied` undefined and the clipboard holding
      // the sentinel, so every clause below would fire and the reader would have to work out which
      // one was the cause -- the fixed-width/summary-line family again.
      const copyWhy = dragFailed ? [copyRun.problem] : [
        secure === true && clipApi === 'object' ? ''
          : 'this page has NO clipboard API, so nothing below could have worked',
        copyRun.written === '' ? ''
          : 'the HARNESS could not even put its sentinel on the clipboard, so nothing below '
            + `discriminates anything: ${String(copyRun.written)}`,
        copyRun.copied === true ? ''
          : 'the CHORD raised no copy frame at all -- either keys.ts does not claim '
            + 'Ctrl-Shift-C (check it precedes the case-folded CTRL lookup) or renderer.ts does '
            + 'not intercept requestCopy before clearSelection()',
        copyAction !== undefined && copyChars === `copy: ${COPY_WANT.length} chars` ? ''
          : 'the gateway did not log the copy it should have',
        copyRun.clip === COPY_WANT ? '' : 'the clipboard does NOT hold the selected text',
        // THE HARNESS'S OWN FAULT FIRST, AND NAMED AS SUCH -- MEASURED, not foreseen. A control run
        // that made the SECOND sentinel write fail reported only `the SELECTION DID NOT SURVIVE`,
        // blaming the product for a broken harness. The survival clause cannot mean anything if
        // the sentinel it discriminates with never landed, so this clause precedes it and says
        // whose fault it is.
        secondSentinelLanded ? ''
          : 'the HARNESS could not put its SECOND sentinel on the clipboard, so the survival '
            + `clause below is meaningless rather than failed: ${String(copyAgain.written)}`,
        survived && secondSentinelLanded ? ''
          : 'the SELECTION DID NOT SURVIVE the first copy: a second chord over a '
            + 'fresh sentinel did not copy the same text again',
        copyWarnings.length === 0 ? '' : 'writeClipboard complained',
      ].filter((s) => s !== '');
      const copyOk = copyWhy.length === 0;
      if (copyOk) {
        ok(check('webCopy'),
          'a REAL Ctrl+Shift+C (nothing synthesized, no page global called) over a real drag of '
          + `cells (0,0)-(1,11) put ${JSON.stringify(copyRun.clip)} on the REAL OS clipboard, over `
          + `${JSON.stringify(copyRun.sentinel)}; the gateway logged ${JSON.stringify(copyAction)} `
          + `and ${JSON.stringify(copyChars)}. THE SELECTION SURVIVED: a second Ctrl+Shift+C with `
          + `NO new drag, over ${JSON.stringify(`${SENTINEL}-second`)}, copied the same text again `
          + `and the gateway logged ${JSON.stringify(againChars)}. isSecureContext=${secure}, `
          + `navigator.clipboard=${clipApi}, writeClipboard warned about nothing `
          + `(${copyRun.attempts} drag attempt(s))`);
      } else {
        no(check('webCopy'), `the browser's copy path is broken: ${copyWhy.join('; ')}`,
          dragFailed ? `${copyRun.problem}; ${extent}`
            : `after ${copyRun.attempts} attempt(s) the chord sent `
              + `${JSON.stringify(copyRun.frames)} (want a {"kind":"copy"...} frame) and the page's `
              + `keydown listener saw ${JSON.stringify(copyRun.keys)} (want one event with `
              + 'code:"KeyC", shiftKey:true and exactly one of ctrlKey/metaKey -- anything else '
              + 'here is a HARNESS fault, not the product\'s); the clipboard reads '
              + `${JSON.stringify(copyRun.clip)} (want ${JSON.stringify(COPY_WANT)}; `
              + `${JSON.stringify(copyRun.sentinel)} means it was never written), the gateway `
              + `logged ${JSON.stringify(copyLogs)} (want an action: {"kind":"copy"...} line and `
              + `"copy: ${COPY_WANT.length} chars"). THE SECOND COPY sent `
              + `${JSON.stringify(copyAgain.frames)}, left the clipboard reading `
              + `${JSON.stringify(copyAgain.clip)} and the gateway logged `
              + `${JSON.stringify(againLogs)}. isSecureContext=${secure}, `
              + `navigator.clipboard=${clipApi}; writeClipboard warned `
              + `${await clipWarns()}; ${extent}`);
      }

      // ===== webPaste ==========================================================================
      //
      // A REAL `Ctrl+V`, AND THAT IS THE LABEL IT EARNED. This task's plan allowed for a
      // synthesized `ClipboardEvent` labeled `injected` if a real chord could not be driven, and
      // listed `Input.insertText` as the thing that does not work. MEASURED 2026-10-26, in this
      // page: a plain `Input.dispatchKeyEvent` Ctrl+V pair DOES fire a `paste` event with
      // `isTrusted: true` carrying the real clipboard text, and the gateway logs the action. So
      // nothing here is synthesized and the check is `live`. (A synthesized `ClipboardEvent` was
      // measured too and also reaches the gateway -- with `isTrusted: false`, which is exactly why
      // it is not what is used: it would pass against a build whose real chord was broken.)
      //
      // `Ctrl+V` IS UNCLAIMED BY `keys.ts`, which is why this works at all and is worth writing
      // down: `actionForKey`'s CTRL table has no `v`, so the renderer's `keydown` listener does not
      // `preventDefault()` it, and Chromium's own pipeline goes on to produce the paste. Binding
      // Ctrl-V in that table would silently take this capability away -- and this check is what
      // would notice.
      const PASTE_PAYLOAD = 'TN3270-PASTE-PROBE';
      const pasteMark = serverOut.length;
      const clipWrite = await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(PASTE_PAYLOAD)})
        .then(() => '').catch((e) => String(e))`);
      await new Promise((r) => { setTimeout(r, 300); });
      // The focus goes to the document body, so the paste's target is not a form control --
      // `forwardPaste` skips INPUT/TEXTAREA/SELECT by design, and the transfer form has those.
      await cdp.eval('document.body.focus(); window.focus();');
      await press('v', 'KeyV', 86, CDP_CTRL);
      const pasteLogs = await waitForLog(pasteMark, (l) => l.startsWith('action: {"kind":"paste"'));
      const pasteAction = pasteLogs.find((l) => l.startsWith('action: {"kind":"paste"'));
      /*
        AND THE SECOND WITNESS: THE TEXT IS ON THE SCREEN, read back by copying it.

        This is the half the page cannot fake and the half a logged action does not prove. The
        gateway's `paste` arm calls `applyPaste` -> `pasteString`, which writes into the SESSION's
        buffer; an arm that logged the action and typed nothing -- or typed it somewhere else --
        satisfies the log line above completely. Seeing it requires the whole return path: the
        repaint, a new frame over the socket, a new draw list, a fresh real drag, and the gateway's
        own `extractText` over its own screen.

        THE WHOLE SCREEN IS COPIED AND NOT A PREDICTED ROW, and the reason is a division of
        labor rather than an unknown. The session IS fresh by the time this runs -- the reload
        above drops `tn3270.sessionId`, so the page sends a bare `hello` and the gateway builds a
        new replayed session, which is exactly what makes the fixture's screen deterministic again.
        (An earlier draft of this paragraph said the opposite, blaming a SHARED session for an
        unpredictable cursor. That described the state before the `sessionStorage` fix two comments
        up, and it survived the fix -- the summary-line-outlives-its-correction shape this project
        has recorded. Corrected 2026-10-26.)

        SO: CONTAINMENT ANYWHERE ON THE SCREEN, AND THE ROW IS REPORTED RATHER THAN ASSERTED,
        because WHERE a paste lands is `pasteString`'s rule and not this harness's claim.
        `paste.test.ts` pins the cursor behavior on a screen it controls, which is where that
        belongs; what cannot be tested there is whether a real browser's clipboard reaches the
        buffer at all, and that is the only thing asserted here. The payload is a distinctive
        string, so containment cannot be satisfied by anything the fixture paints -- and the row it
        was found on is printed in the `ok` line, so a future change of cursor rules is VISIBLE
        here without this check having to be rewritten to care.
      */
      const pasteCopy = await copyCells(0, 0, lastRow, lastCol);
      const landed = pasteCopy.problem === '' && typeof pasteCopy.clip === 'string'
        && pasteCopy.clip.includes(PASTE_PAYLOAD);
      const landedRow = landed
        ? pasteCopy.clip.split('\n').findIndex((l) => l.includes(PASTE_PAYLOAD))
        : -1;
      /*
        AND THE EMPTY CLIPBOARD, WHICH IS ONLY MEANINGFUL BECAUSE THE POSITIVE CASE PASSED FIRST.

        `forwardPaste` declines an empty clipboard before any action is sent, deliberately -- a
        paste that would type nothing must not cost the operator their selection. On its own that
        is an ASSERTION THAT PROVES NOTHING: "no action was raised" is satisfied just as well by a
        build with no paste listener at all. It earns its place only as the second half of a pair
        whose first half is a positive control in the SAME RUN on the SAME chord, which is why
        `pasteOk` below requires both and why this is not a check of its own.
      */
      const emptyMark = serverOut.length;
      const sentBeforeEmpty = await cdp.eval('window.__tn3270Probe.sent.length');
      await cdp.eval("navigator.clipboard.writeText('').then(() => '').catch((e) => String(e))");
      await new Promise((r) => { setTimeout(r, 300); });
      await cdp.eval('document.body.focus(); window.focus();');
      await press('v', 'KeyV', 86, CDP_CTRL);
      await new Promise((r) => { setTimeout(r, 1200); });
      const sentOnEmpty = JSON.parse(await cdp.eval(
        `JSON.stringify(window.__tn3270Probe.sent.slice(${sentBeforeEmpty}))`));
      const loggedOnEmpty = logsSince(emptyMark).filter((l) => l.includes('"paste"'));
      const emptyQuiet = sentOnEmpty.length === 0 && loggedOnEmpty.length === 0;

      /*
        WHICH CLAUSE FAILED, NAMED -- BECAUSE THE UNNAMED VERSION MISREPORTED A REAL KILL.

        `pasteOk` is a conjunction of four independent things, and the failure message used to
        print all four values and let the reader work it out. MEASURED while re-running the
        mutations for review: with `forwardKeys.ts`'s `if (text === '') return;` guard deleted, the
        message read `the screen after the paste reads "... TN3270-PASTE-PROBE ..." (want it to
        contain "TN3270-PASTE-PROBE" somewhere)` -- quoting text that plainly DID contain it, while
        the actual failure was the empty-clipboard clause four lines further on. A reader would have
        chased the wrong half. This is the fixed-width/summary-line family: the remedy has to be
        first, and the measured value is not a diagnosis.
      */
      const pasteWhy = [
        clipWrite === '' ? '' : 'the harness could not even write the clipboard',
        pasteAction === undefined ? 'the gateway never logged a paste action' : '',
        landed ? '' : 'the payload is NOT on the screen afterwards',
        emptyQuiet ? '' : 'an EMPTY clipboard still raised a paste, so the empty guard is gone',
      ].filter((s) => s !== '');
      const pasteOk = pasteWhy.length === 0;
      if (pasteOk) {
        ok(check('webPaste'),
          'a REAL Ctrl+V (isTrusted, nothing synthesized) reached the gateway as '
          + `${JSON.stringify(pasteAction)}, and the text is ON THE SCREEN afterwards -- copying `
          + `the whole screen back finds ${JSON.stringify(PASTE_PAYLOAD)} on row ${landedRow}, `
          + `which reads ${JSON.stringify(pasteCopy.clip.split('\n')[landedRow])} `
          + `(${pasteCopy.attempts} drag attempt(s)); an EMPTY `
          + 'clipboard then raised nothing at all, which that positive control is what makes '
          + 'meaningful');
      } else {
        no(check('webPaste'), `the browser's paste path is broken: ${pasteWhy.join('; ')}`,
          `clipboard write: ${clipWrite === '' ? 'ok' : clipWrite}, `
          + `the gateway logged ${JSON.stringify(pasteLogs)}, `
          + `the screen after the paste reads ${JSON.stringify(pasteCopy.clip ?? pasteCopy.problem)} `
          + `(want it to contain ${JSON.stringify(PASTE_PAYLOAD)} somewhere), `
          + `and on an EMPTY clipboard the page sent ${JSON.stringify(sentOnEmpty)} with the `
          + `gateway logging ${JSON.stringify(loggedOnEmpty)} (want both empty); ${extent}`);
      }
    }

    /**
     * A RENDERER EXCEPTION IS A FAILURE EVEN IF EVERY CHECK ABOVE PASSED.
     *
     * `browser-shot.mjs` makes this part of its pass condition and for the same reason: a
     * module that threw halfway can leave enough of the page working to satisfy a specific
     * assertion. `renderer[3]` is main's forwarding of a console ERROR
     * (`gui/src/main.ts`'s `console-message` hook).
     *
     * ONE EXCLUSION, AND IT IS NOT THE PRODUCT'S. Electron's own sandbox bundle logs
     * `startupData is null` on every URL-mode run in this environment, because there is no
     * preload in that mode -- measured on every probe written for this task, and present in
     * phase one's runs too. Matched narrowly by its own text so a real renderer error cannot hide
     * behind it.
     */
    const rendererErrors = childOut.split('\n')
      .filter((l) => l.startsWith('renderer[3]'))
      .filter((l) => !l.includes('sandboxed_renderer.bundle.js script failed to run')
        && !l.includes("Cannot destructure property 'preloadScripts'"));
    if (rendererErrors.length > 0) {
      bad += 1;
      console.log('FAIL     the renderer logged errors during phase two');
      for (const l of rendererErrors) console.log(`         ${l}`);
    }
  } catch (err) {
    bad += 1;
    console.log(`FAIL     phase two could not be driven: ${err.message}`);
    process.stdout.write(childOut);
  } finally {
    cdp?.close();
    child?.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  }

  /**
   * EVERY CHECK IN THE TABLE MUST HAVE REPORTED. Without this, a `throw` partway through -- or an
   * early `return` added later -- would leave the untouched checks counted as neither pass nor
   * fail, and the total below would read as a pass on a run that stopped early. The same
   * zero-length false-green family `CASES` guards against.
   */
  for (const c of TRANSFER_CHECKS) {
    if (!done.has(c.name)) {
      bad += 1;
      console.log(`FAIL     ${c.name}: never ran, so it proves nothing`);
      console.log(`         what it should have checked: ${c.what}`);
      console.log(`         the mutant it exists to kill: ${c.mutant}`);
    }
  }
  return bad;
}

/** The gateway, started here and torn down in the `finally` below whatever happens. */
const server = spawn(process.execPath, [webMain, ...SERVER_ARGV], { encoding: 'utf8' });
let serverOut = '';
server.stdout.setEncoding('utf8');
server.stderr.setEncoding('utf8');
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

let failed = 0;
/**
 * Phase two's tally, and whether it ran at all.
 *
 * TWO VARIABLES AND NOT ONE, because `0` is ambiguous: it is both "every check passed" and "the
 * phase never started". The second reading is reachable -- anything thrown above reaches the
 * `finally` and skips the call -- and a run that printed `7/7` for a phase that did nothing is
 * precisely the stale-zero false green the rest of this file guards against.
 */
let transferFailures = 0;
let transferRan = false;
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

  /**
   * PHASE TWO, ALWAYS RUN, even when phase one failed.
   *
   * Not short-circuited on `failed`, deliberately: the two phases drive different things -- one
   * the keypad's clicks over the wire, the other the transfer form's own behaviour -- and a
   * reader diagnosing a broken page is better served by both accounts than by the first one and
   * silence. It also keeps the final count honest about how many checks EXIST.
   */
  transferFailures = await runTransferPhase(url);
  transferRan = true;
} finally {
  server.kill('SIGKILL');
}

/**
 * THE COUNT, WITH BOTH PHASES NAMED SEPARATELY.
 *
 * Phase one is one assertion over nine clicks -- the whole ordered sequence compared at once --
 * so it is not nine out of nine of anything and is not reported as a fraction. Phase two is a
 * table, so it is. A single blended number would hide which half regressed.
 */
const transferPassed = TRANSFER_CHECKS.length - transferFailures;
console.log(`\nkeypad clicks: ${failed === 0 ? 'ok' : 'FAILED'} (${CASES.length} buttons, one ordered sequence)`);
console.log(`transfer form: ${transferPassed}/${TRANSFER_CHECKS.length} checks`
  + `${transferRan ? '' : '  (PHASE TWO NEVER RAN)'}`);
// `!transferRan` IS ITS OWN FAILURE. A `throw` above reaches the `finally` and skips the call, so
// without this the line above would print `7/7` for a phase that never started -- `transferFailures`
// is 0 until it is assigned, which is the stale-zero shape this repo has recorded before.
process.exit(failed !== 0 || transferFailures > 0 || !transferRan ? 1 : 0);
