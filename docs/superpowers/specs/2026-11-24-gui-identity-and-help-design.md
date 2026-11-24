# 15b sub-project A: identity and help — design

2026-11-24. README *Staging* 15b, split into three sub-projects with the user: **A, identity and
help (this spec)**; B, preferences and appearance; C, connecting from a running window. A first
because it is independent and small. Approved by the user 2026-11-24.

Parity rows: `cmdline-help`, `version-flag`, `window-title`, `about-version`, `about-config`,
`about-status`. None exists today except macOS's stock About panel. All four front ends reject
`--help` and `--version` as unknown arguments (checked 2026-11-24 for CLI, TUI and web; the GUI
row says the same).

## Decisions (the user's, 2026-11-24)

- `--help` and `--version` go in **all four** front ends, not only the GUI.
- **One About window** with three sections (not x3270's three panels, not native message boxes).
- The title puts the **host first**. `Title()` is **skipped** for the GUI, which has no script
  interface.

## 1. `--help` and `--version`, all four front ends

- **Shared:** `packages/frontend/src/infoFlags.ts`. It handles exactly x3270's rule
  (`x3270/x3270.c:497-506`): only a **lone** argument counts. `--help` or `-?` prints that front
  end's usage to stdout and exits 0. `--version` or `-v` prints the version block and exits 0.
  With other arguments, they fall through to normal parsing and stay usage errors, as they do
  today. In x3270 they reach its general option parser instead; that difference is accepted.
- **Usage text:** the GUI's `USAGE` and the TUI's usage line exist; the CLI and web gateway get one
  each. **A test per front end checks that every flag its parser accepts appears in its usage**,
  so the two cannot drift.
- **The version block** (one function, shared by `--version` and the About window):

  ```
  tn3270-<frontend> 0.1.4
  Build: <commit>            (only if the build records one; otherwise omitted, never invented)
  Node v<x>; Electron v<y>   (Electron in the GUI only)
  TLS: OpenSSL <process.versions.openssl>
  Code pages: bracket (default), cp037
  Copyright ... ; licence: <SPDX id from package.json>
  ```

  The code page line comes from core's `CODE_PAGE_NAMES`, not a literal.
- **The packaged GUI** must behave the same as `npm` runs, because the packaged app's argv path
  differs (`a5aa71e`). A test covers the packaged argv shape.

## 2. Window title: GUI and the web gateway's browser tab

- `windowTitle(info)` in `frontend`, a pure function:
  - connected: `host:port — TN3270 <model>`, plus ` [LU]` when an LU is bound
  - not connected: `TN3270 — not connected`
- The host goes first because taskbars and tabs truncate from the right, and the host is what
  tells several windows apart.
- The GUI sets `BrowserWindow.setTitle` on every `'connection'` event (section 4). The gateway
  sends the title to its page, which sets `document.title`. Today it is the literal `tn3270` in
  both `packages/gui/index.html` and `packages/web/static/index.html`.
- Parity: `window-title` covers the title; x3270's `Title()` (`x3270/screen.c:6732`) is recorded
  as **skipped** for the GUI, reason: no script interface, the user's decision 2026-11-24.

## 3. About window (GUI)

- **Help → About TN3270 on every platform.** On macOS the app menu's About opens the same window,
  instead of Electron's stock panel. A second click focuses the open window rather than opening
  another, as the Keypad window does.
- Built like the existing child windows (Keypad, Keyboard, File Transfer in `gui/src/main.ts`).
  Three sections:
  1. **Version and licence:** the version block, plus the text of `LICENSE`.
  2. **Configuration:** model and size; 3279 color or 3278 mono mode; terminal type; code page
     and CGCSGID; font (the built-in atlas); color scheme; keymap.
  3. **Connection status:** host, port, LU, TLS (on or off, and the verified peer name when
     there is one), TN3270E bound or not, bytes and records in each direction, connected-since.
     **Live:** updated on each `'connection'` event and at most once a second for the counters
     while the window is open.
- Text is selectable. A **Copy** button copies the whole window as plain text, for bug reports.

## 4. Core: `Session.connectionInfo()` and a `'connection'` event

- Today the target is private (`session.ts:370`) and only `recordCount()` is public.
- `connectionInfo()` returns
  `{ connected, host, port, lu, tls, tn3270e, since, bytesIn, bytesOut, recordsIn, recordsOut }`.
  Byte counters are added where the connection is read and written. Records come from the
  existing count plus an outbound one.
- `'connection'` fires whenever any field except the counters changes: connect, BIND or unbind
  (the LU), disconnect.

**AMENDED WHILE PLANNING (2026-11-24):** core never sees TLS, because `frontend`'s `tcpConnect`
opens the connection. So `connectionInfo()` has no `tls`; each front end adds it from its own
resolved TLS options. There is no outbound record counter and no recorded TLS peer name, so
`recordsOut` and the peer name are dropped rather than invented. `terminalType` is added, for
the title's model.

## Testing

- **Unit:** `infoFlags` (lone versus mixed, each alias); each front end's exit code and stdout for
  `--help` and `--version`; the usage-covers-every-flag check; `windowTitle` (connected, with an
  LU, disconnected); `connectionInfo` counters and the `'connection'` event against the existing
  fake connection in `core/test/session.test.ts`.
- **GUI:** the About window's content from a fake session's info, and the Copy text.
- **Live (Xvfb + VM/370, the rebuilt toolchain):** the title before and after connecting; the
  About window's status section with real counters; `--help` and `--version` from the built
  binaries. The web gateway's tab title, if a browser can be driven (see `TN3270_GUI_URL`).
- **Parity:** the six rows above, each with evidence.

## Out of scope

`suppressHost`, which waits for sub-project B's config file; `min-version`; online help; any
title or About in the TUI or CLI.
