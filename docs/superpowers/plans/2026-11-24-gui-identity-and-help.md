# 15b sub-project A: identity and help — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `--help`/`--version` in all four front ends, a host-first window title in the GUI and
the browser tab, and one live About window in the GUI.

**Architecture:** core gains `Session.connectionInfo()` and a `'connection'` event. `frontend`
gains three pure helpers: `infoFlag`, `versionText` and `windowTitle`. Each front end calls them.
The GUI's About window is a child window built like Keypad's. The web gateway sends a `title`
message, and the page sets `document.title`.

**Tech Stack:** TypeScript, vitest, Electron 44, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-24-gui-identity-and-help-design.md`.

**THE SOURCE BEATS THIS PLAN.** Read at `2858932` on 2026-11-24. Re-read each file before
changing it; where the repo disagrees with this plan, the repo wins, so report the difference.
**vitest does not typecheck:** run `npm run build && npm run typecheck && npx vitest run` after
every task.

## Facts established while planning (2026-11-24)

- **Argv entry points:**
  - CLI: `parseArgs(process.argv.slice(2))` at `cli/src/main.ts:228`.
  - TUI: `run(argv, …)` at `tui/src/main.ts:116`, called from `:186`.
  - Web: `run(argv)` at `web/src/main.ts:717`. Its try/catch exits 2 on `UsageError`.
  - GUI: `userArgv(process.argv, process.defaultApp)` (`gui/src/electronSwitches.ts:54`) is
    called inside `app.whenReady()` at `gui/src/main.ts:518`, after the window exists.
    `--help`/`--version` must be handled BEFORE any window is created: call `userArgv` at
    module top level, before `app.whenReady()`.
- **TLS is not visible to core.** The connection is opened by `frontend`'s `tcpConnect`
  (`defaultSession`). So `connectionInfo()` has no `tls` field; each front end adds TLS from its
  own resolved `TlsOptions` (`kind === 'plaintext'` means off). **This deviates from spec
  section 4**, which put `tls` in core. The peer-name detail in spec section 3 is dropped:
  nothing records it today.
- **Core state:** the target is `private target` (`core/src/session.ts:370`), set at `:884`. The
  terminal type is `this.ttype ?? this.opts.terminalType` (`:895`). The LU is `this.e.lu` after
  TN3270E negotiation completes (`:1381-1388`), and `this.e` is cleared at `:1434`. Bytes in
  arrive at `conn.onData` (`:907`) and bytes out leave via `write: (b) => conn.write(b)`
  (`:898`). `recordCount()` (`:1132`) is the inbound record count. **Records out has no
  counter, so it's dropped from the spec's field list** rather than invented.
- **Events emitted today:** `screen`, `alarm`, `connect`, `disconnect`, `geometry`,
  `connectSettled`, `transferEnd`, `transferProgress`.
- **Web:** server messages are `ServerMessage` in `web/src/protocol.ts:29-121`, encoded by
  `encodeServerMessage` (`:176`, JSON). The browser side handles them in
  `web/src/bridgecore.ts` (the `alarm` branch at `:700` is the pattern: shape-check, drop if
  malformed). Per-socket session listeners are set in `web/src/main.ts` near `:301`.
- **GUI:** child windows follow the Keypad pattern (`gui/src/main.ts:893-935`): a module-level
  `let …Win`, focus if it's open, `new BrowserWindow({ parent: win, … preload })`, and clear the
  variable on `'closed'`. The menu is `buildMenuTemplate(platform, handlers, geometry)` in
  `gui/src/menu.ts:333`. On macOS it starts with `{ role: 'appMenu' }` (`:444`). There is no
  Help menu yet.
- **Versions:** every `package.json` says `0.1.4`, licence `MIT`. `LICENSE` holds the text.
  Whether the build records a commit hash is **unchecked**: in Task 2, grep the build scripts
  (`scripts/`, each `package.json`) for one. If there's none, omit the Build line, as the spec
  says.

## Files

- Modify `packages/core/src/session.ts`; test `packages/core/test/session.test.ts`.
- Create `packages/frontend/src/identity.ts` (`infoFlag`, `versionText`, `windowTitle`); test
  `packages/frontend/test/identity.test.ts`; export from `packages/frontend/src/index.ts`.
- Modify each front end's entry point and usage: `cli/src/main.ts`, `tui/src/main.ts`,
  `web/src/main.ts` + `web/src/args.ts`, `gui/src/main.ts` + `gui/src/args.ts`; tests in each
  front end's existing args/main test file.
- Create `packages/gui/about.html` and `packages/gui/src/aboutPreload.cts` (copy the file layout,
  extension and build wiring of `keypad.html` / `keypadPreload` exactly, whatever they are);
  modify `gui/src/main.ts` and `gui/src/menu.ts`; test `packages/gui/test/menu.test.ts` and a new
  `packages/gui/test/about.test.ts`.
- Modify `web/src/protocol.ts`, `web/src/bridgecore.ts`, `web/src/main.ts`.
- Docs: `README.md`, `docs/parity/checklist.yaml` (then `node scripts/parity.mjs render`),
  `docs/live-testing.md`, `docs/HANDOFF.md`, a `changelog.d/` fragment.

---

### Task 1: `Session.connectionInfo()` and the `'connection'` event

- [ ] **Step 1: Failing tests** in `core/test/session.test.ts`, using the file's `newSession()`
  and `conn.host(...)` helpers:
  1. Before connecting: `connectionInfo()` is
     `{ connected: false, host: undefined, port: undefined, lu: undefined, tn3270e: false,
     terminalType: <the default>, since: undefined, bytesIn: 0, bytesOut: 0, recordsIn: 0 }`.
     Read the actual default terminal type from the code, not from this plan.
  2. After `connect('localhost', 3270)`: `connected: true`, `host: 'localhost'`, `port: 3270`,
     and `since` is a `Date`.
  3. After `conn.host(T.IAC, T.DO, O.TTYPE)`, `bytesIn` is 3 and `bytesOut` equals
     `conn.sent.length`.
  4. A `'connection'` listener fires on connect and on disconnect, and NOT on a data chunk.
  5. After TN3270E negotiation completes with an LU, `lu` is that LU, `tn3270e` is true, and
     `'connection'` fired. Copy the negotiation bytes from an existing TN3270E test in this file;
     grep `DEVICE_TYPE` or `IS`.
  6. After `disconnect()`: `connected: false` and `lu: undefined`. The counters keep their last
     values; the next `connect()` resets them to 0.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Add private `bytesIn`, `bytesOut` and `since`, reset in `connect()`
  just after `this.target = …`. Count in `conn.onData` AFTER its `this.conn !== conn` guard, so a stale connection's bytes don't
  count, and in the `write` callback. Add:

```ts
/** What the About window and the window title show. Counters reset on each connect. */
export interface ConnectionInfo {
  readonly connected: boolean;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly lu: string | undefined;
  readonly tn3270e: boolean;
  readonly terminalType: string | undefined;
  readonly since: Date | undefined;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly recordsIn: number;
}
```

  `connectionInfo()` builds it from `this.target`, `this.e`, `this.isConnected()`, the
  counters and `this.recordCount()`. Check that `recordCount()` resets per connection; if it
  doesn't, say so in the doc comment. Emit `'connection'` right after each existing
  `emit('connect')` and `emit('disconnect')`, and where TN3270E negotiation completes
  (`:1383`) and where `this.e` is cleared (`:1434`). Export `ConnectionInfo` from core's entry.
- [ ] **Step 4: Run, pass; build; typecheck.**
- [ ] **Step 5: Commit:** `core: Session.connectionInfo() and a 'connection' event`.

### Task 2: The shared helpers

**Files:** create `packages/frontend/src/identity.ts`, test `packages/frontend/test/identity.test.ts`.

- [ ] **Step 1: Failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import { infoFlag, versionText, windowTitle } from '../src/identity.js';

describe('infoFlag', () => {
  it.each([['--help', 'help'], ['-?', 'help'], ['--version', 'version'], ['-v', 'version']])(
    'a lone %s is %s', (a, want) => { expect(infoFlag([a])).toBe(want); });
  it('mixed with anything else, it is not an info flag (x3270.c:497-506)', () => {
    expect(infoFlag(['--help', 'vm'])).toBeUndefined();
    expect(infoFlag(['vm', '--version'])).toBeUndefined();
    expect(infoFlag([])).toBeUndefined();
  });
});

describe('versionText', () => {
  const t = versionText('cli', { node: 'v22.1.0', openssl: '3.0.13' });
  it('names the front end and version first', () => {
    expect(t.split('\n')[0]).toBe('tn3270-cli 0.1.4');
  });
  it('lists the code pages from core, default first', () => {
    expect(t).toContain('Code pages: bracket (default), cp037');
  });
  it('has Node and TLS, and Electron only when given', () => {
    expect(t).toContain('Node v22.1.0');
    expect(t).toContain('TLS: OpenSSL 3.0.13');
    expect(t).not.toContain('Electron');
    expect(versionText('gui', { node: 'v22.1.0', openssl: '3', electron: '44.3.0' }))
      .toContain('Electron v44.3.0');
  });
  it('ends with the licence', () => { expect(t).toMatch(/MIT/); });
});

describe('windowTitle', () => {
  it('connected: host first', () => {
    expect(windowTitle({ connected: true, host: 'vm.example', port: 3270, lu: undefined, terminalType: 'IBM-3278-2-E' }))
      .toBe('vm.example:3270 — TN3270 3278-2-E');
  });
  it('with an LU', () => {
    expect(windowTitle({ connected: true, host: 'h', port: 23, lu: 'LU01', terminalType: 'IBM-3279-4-E' }))
      .toBe('h:23 [LU01] — TN3270 3279-4-E');
  });
  it('not connected', () => {
    expect(windowTitle({ connected: false, host: 'h', port: 23, lu: undefined, terminalType: undefined }))
      .toBe('TN3270 — not connected');
  });
});
```

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement** `identity.ts`. `infoFlag(argv)` returns `'help' | 'version' |
  undefined`. `versionText(frontend, { node, openssl, electron? })` takes the versions as
  arguments, so tests are deterministic; callers pass `process.versions`. It reads the version and
  licence from `frontend`'s own `package.json`: use the import style `frontend` already uses for
  JSON if it has one (grep `package.json` imports). Otherwise `createRequire(import.meta.url)`.
  The code pages come from `CODE_PAGE_NAMES`, with ` (default)` after `DEFAULT_CODE_PAGE.name`.
  The copyright line is `Copyright (c) 2026 Adam Thornton; MIT licence`, matching `LICENSE`'s
  line 3; read it from `LICENSE` if packaging ships that file, otherwise hard-code it and add a
  test that compares it with `LICENSE`. The build line: see *Facts*. `windowTitle(info)` takes a
  `Pick<ConnectionInfo, 'connected' | 'host' | 'port' | 'lu' | 'terminalType'>` and strips a
  leading `IBM-` from the terminal type. Export all three from `frontend`'s index.
- [ ] **Step 4: Run, pass; build.**
- [ ] **Step 5: Commit:** `frontend: infoFlag, versionText and windowTitle`.

### Task 3: `--help` and `--version` in the four front ends

For each front end (one commit each, or one for all four if they're small):

- [ ] **Step 1: Failing tests** in the existing test file (`cli/test/main.test.ts`,
  `tui/test/main.test.ts`, `web/test/args.test.ts`, `gui/test/args.test.ts`):
  1. The front end's info handler, given `['--help']`, writes its usage to stdout and reports
     exit 0. Given `['-v']`, it writes `versionText(...)`. Factor each front end's handling into a
     testable function, e.g. `handleInfoFlag(argv, out): number | undefined` returning the exit
     code, and call it first thing in the entry point.
  2. **Usage covers every flag:** the test reads the front end's parser source
     (`readFileSync` of the `.ts`), collects every `case '-…':` label, and asserts each appears
     in that front end's usage string. This must FAIL today for at least one front end; record
     which in the commit.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** The CLI and web get an exported `USAGE` constant (the web one covers
  its `--listen`-style flags too). The TUI's usage moves from inline in `run()` (`main.ts:122`)
  to an exported `USAGE`, which `run()` still throws. Fix whichever usages miss flags. Each
  entry point calls its handler before any other parsing and exits with the code it returns. In
  the **GUI**, call it at module top level, before `app.whenReady()`, using `userArgv`, then
  `app.exit(code)`. Check the module's other top-level code doesn't open anything first.
- [ ] **Step 4: Run, pass.** Then by hand: `node packages/{cli,tui,web}/dist/main.js --help`,
  `-v`, and `--help vm` (the last must still be a usage error, exit 2).
- [ ] **Step 5: Commit:** `cli, tui, web, gui: --help and --version (x3270's lone-argument rule)`.

### Task 4: The title in the GUI and the browser tab

- [ ] **Step 1: Failing tests.**
  - **GUI:** factor `titleFor(session)` into a small exported function if `main.ts` has no
    testable seam. Test that it returns `windowTitle(session.connectionInfo())`.
  - **Web:** in `web/test/`, follow how the `alarm` message is tested (grep `'alarm'` in
    `web/test`). A session `'connection'` event sends `{ kind: 'title', text }`. Then
    `bridgecore` sets `document.title` from a well-formed `title` message and drops one whose
    `text` isn't a string.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** In the GUI, set `win.setTitle(windowTitle(...))` once at session
  start and on every `'connection'` event. Find where `startSession` subscribes to the session's
  events and add it there. In the web gateway, add `| { kind: 'title'; text: string }` to
  `ServerMessage`, send it on connect of the socket and on each `'connection'` event (beside the
  `alarm` listener near `main.ts:301`), and handle it in `bridgecore.ts` beside the `alarm`
  branch. Leave the static `<title>` in both HTML files as the before-connect value, changed to
  `TN3270 — not connected`.
- [ ] **Step 4: Run, pass; build.**
- [ ] **Step 5: Commit:** `gui, web: the window title names the host first`.

### Task 5: The About window

- [ ] **Step 1: Failing tests.**
  - **`menu.test.ts`:** `buildMenuTemplate` has a Help menu with `About TN3270` (id `about`)
    whose click calls `handlers.onAbout`, on linux and win32. On darwin the app menu's About
    calls the same handler, instead of the `appMenu` role's stock item. Read how the darwin
    `appMenu` is built and replace the role with an explicit submenu that keeps the role's other
    items (Hide, Quit, …).
  - **`about.test.ts`:** a pure `aboutText(info, config, version): string` producing the three
    sections. Test that it contains the version block, a `Configuration` section with the code
    page and CGCSGID (`bracket (CGCSGID 37)`), and a `Connection` section with host, port, LU,
    TLS, TN3270E and the four counters. Disconnected, it says `not connected` and shows no
    counters. This one function is both what the window shows and what Copy copies.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.**
  - **`aboutText`** goes in `gui/src/about.ts`. `config` is
    `{ model, colorMode, terminalType, codePage: { name, cgcsgid }, font, scheme, keymap }`.
    Gather it in `main.ts` from what the GUI already holds; where a value isn't available, show
    `(not known)` rather than guessing, and list those in the commit.
  - **The window:** `openAboutWindow` follows the Keypad pattern (*Facts*). `about.html` shows the
    text in a `<pre>` with `user-select: text`, plus a Copy button. The preload exposes
    `onText(cb)` and `copy()`. Main sends the text on open, on each `'connection'` event and
    once a second while open (clear the interval on `'closed'`).
  - **Copy** writes the same `aboutText` to the clipboard in main, so the copied text is exactly
    the shown text.
- [ ] **Step 4: Run, pass; build.** Open it under Xvfb (Task 7's recipe) to see it render before
  committing.
- [ ] **Step 5: Commit:** `gui: an About window with version, configuration and live connection status`.

### Task 6: Mutation check

Do each by hand, run the relevant tests, and revert. Each must fail a test. Watch for kills by
`ReferenceError` (vitest doesn't typecheck); re-run any such with the import in place.

1. `infoFlag` accepts a non-lone `--help` (drop the length check).
2. `windowTitle` puts the model before the host.
3. `bytesIn` counted before the stale-connection guard.
4. No `'connection'` emit on TN3270E completion.
5. Drop one flag from one front end's `USAGE`.
6. The browser accepts a non-string `title`.
7. `aboutText` omits the LU.

Record the results in the HANDOFF entry.

### Task 7: Docs, parity and the live witness

- [ ] **Live, VM/370:** start the GUI under Xvfb with the rebuilt toolchain (`docs/live-testing.md`,
  under the code page witness: the LSST stack plus `~/micromamba/envs/gui`, and
  `LD_LIBRARY_PATH=$G/lib:$CONDA_PREFIX/lib`). With `TN3270_GUI_SHOT`, capture the title (read it
  with `win.getTitle()`, if the shot seam doesn't show the title bar, by logging it) before and
  after connecting. Open About through the menu (check the click seam `TN3270_GUI_CLICKS` for
  whether it reaches menu items; if it doesn't, log the `aboutText` the window received) and
  check the counters grow. Log `CMSUSER` off afterwards.
- [ ] `--help` and `--version` from the built CLI, TUI, web and GUI binaries; record the output.
- [ ] **Parity:** `cmdline-help`, `version-flag`, `window-title` (with `Title()` noted skipped),
  `about-version`, `about-config`, `about-status`. Rerun `node scripts/parity.mjs check`, then
  `render`, then `gate`, and record the count.
- [ ] **README:** `--help`/`--version` in each *Using …* section, the title, and Help → About. Mark
  15b's A items done in *Staging*. Then grep for stale "no About" or "always tn3270" claims.
- [ ] **Changelog** fragment, **HANDOFF** latest entry. Commit:
  `docs: 15b sub-project A, identity and help`.
