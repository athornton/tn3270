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
 * **KEYSTROKES AIMED AT THE TRANSFER FORM'S TEXT FIELDS DO NOT REACH THEM; THEY GO TO THE HOST.**
 * `renderer.ts:268`'s `window.addEventListener('keydown', ...)` sees events targeted at
 * `#transfer-localFile`, `actionForKey` claims any single-code-point key as `{kind:'type'}`, and
 * the `e.preventDefault()` that follows suppresses the character -- so the field stays empty and
 * the letter crosses the socket. Proved three ways; the measurements are at `typeChar` below,
 * including `action: {"kind":"type","text":"a"}` in this harness's own gateway log for a letter
 * typed into a form field. **NOT FIXED HERE** -- this commit adds test cover and changes no
 * production code -- and `typeChar`'s docstring records both the workaround that lets these
 * checks reach the form's real logic and exactly what that workaround costs in honesty.
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
    what: 'transferProgress, transferData and transferDone each reach the form',
    mutant: 'bridge.ts  onTransfer: () => {}',
  },
];

if (TRANSFER_CHECKS.length === 0) {
  refuse('TRANSFER_CHECKS is empty, so phase two would assert nothing and still report a pass',
    'restore the five mutants this phase exists to kill');
}

/**
 * Ctrl as `Input.dispatchKeyEvent` spells it, and the keypad label that opens the form.
 *
 * `CDP_CTRL = 2` IS CDP'S OWN BITMASK for the Control modifier (Alt 1, Ctrl 2, Meta 4, Shift 8),
 * which is a different encoding from the Electron `Accelerator` strings `TN3270_GUI_KEYS` takes.
 * The chord it builds is the same `Ctrl+K` phase one delivers, and it reaches
 * `canvas/src/keys.ts`'s `CTRL` table through the renderer's own `keydown` listener: verified by
 * this run, since the keypad opens and its buttons become clickable.
 *
 * `Xfer` IS CLICKED RATHER THAN CHORDED, deliberately, and it is the harder of the two routes:
 * `canvas/src/keys.ts:97` maps Ctrl-T to `transferForm` too, so a chord would prove the key table
 * and the interception together. The BUTTON proves the key table is not involved at all -- the
 * press goes `keypadUi` click handler -> `bridge.sendAction` -> `bridgecore.ts`'s `transferForm`
 * branch -> `deps.showTransfer()`. That is the exact path the `showTransfer: () => {}` mutant
 * breaks, and `frontend/src/keypad.ts:145` is where the label comes from.
 */
const CDP_CTRL = 2;
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
  const H = { sent: [], hold: false, sock: null };
  window.__tn3270Probe = H;
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

    /** One real keystroke pair, entering where `sendInputEvent` does. */
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
      for (const type of ['keyDown', 'char', 'keyUp']) {
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
      if (shown && rows > 1) {
        ok(check('overlay'), `the Xfer button opened the overlay, with ${rows} field rows drawn`);
      } else {
        no(check('overlay'), 'clicking Xfer did not produce a populated transfer overlay',
          `overlay shown: ${shown}, field rows: ${rows}`);
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
    await feed({ kind: 'transferDone', ok: true, bytes: INJECTED_BYTES.length });
    const sawDone = await statusText();
    const saveAfterDone = await cdp.eval('document.getElementById("transfer-save").disabled');
    // `done: N bytes` IS `transferUi.ts`'s OWN FORMAT (`finished()`), and the N asserted is the
    // one the injected `transferDone` carried -- so a form that printed a constant cannot pass.
    const doneOk = sawDone === `done: ${INJECTED_BYTES.length} bytes`;
    if (armed === 'transferring' && sawProgress === '4096 bytes' && doneOk
      && saveMidData === true && saveAfterDone === false) {
      ok(check('progress'),
        `progress reached the form (${JSON.stringify(sawProgress)}), then `
        + `${JSON.stringify(sawDone)}, and the ${INJECTED_BYTES.length} received bytes enabled Save`);
    } else {
      no(check('progress'), 'the three inbound transfer kinds did not all reach the form',
        `armed: ${JSON.stringify(armed)}, after progress: ${JSON.stringify(sawProgress)}, `
        + `after done: ${JSON.stringify(sawDone)}, Save disabled mid-data: ${saveMidData}, `
        + `Save disabled after done: ${saveAfterDone}`);
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
