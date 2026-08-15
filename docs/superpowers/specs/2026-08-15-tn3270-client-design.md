# tn3270 Client — Design

**Date:** 2026-08-15
**Status:** Approved design; implementation not started

## Purpose

Build a standalone graphical TN3270 client for macOS and Linux. No good Mac 3270
client has existed since Brown tn3270 stopped being developed; this aims to fill
that gap.

The application must be a graphical, standalone app — not terminal-based. It need
not be truly native.

## Guiding Principle

**When a behavior is undefined or ambiguous, do what x3270 does.** x3270 is the
de facto reference implementation and the client the primary user currently uses.
This resolves most small questions without further design work. Deliberate
divergences from x3270 must be documented.

## Scope and Staging

Work proceeds in stages. Stage 1 is the immediate deliverable; later stages are
secondary goals to be tackled in order after stage 1 is complete.

### Stage 1 — Core protocol, trace, headless driver (no GUI)

Basic TN3270 against an 80×24 IBM-3278-2. Telnet negotiation, 3270 datastream
parsing and execution, screen buffer with field attributes, AID generation and
inbound replies, EBCDIC translation, byte-level tracing, and an s3270-style
headless CLI. Verified live against Hercules running MVS 3.8J or VM/370 R6.

No GUI. Screen state is inspected as text. This is deliberate: the protocol is
proven correct against a real host before any pixels exist.

### Stage 2 — GUI shell

Electron window, canvas renderer with the authentic 3278/3279 look, OIA status
line, x3270 keymap, cursor and field navigation, connect dialog. First version
usable by a human.

### Stage 3 — Packaging

Signed and notarized macOS `.app`; Linux AppImage and deb. Config file and
preferences UI.

### Stage 4+ — Secondary goals, in order

1. TLS connections (modern z/OS on port 992, certificate handling)
2. TN3270E: negotiated screen size, extended attributes
3. IND$FILE file transfer
4. Printer sessions (LU1/LU3, 3287 emulation)

Multi-session support and additional EBCDIC code pages are not staged
separately; stage 1 leaves stubs (see *Forward-Compatibility Stubs*) so they
become incremental work whenever wanted.

### Out of Scope

Retro CRT shader effects (scanlines, phosphor glow). Pure presentation, easily
added later, no protocol impact.

## Technology Choice

**Electron + TypeScript.**

Rationale:

- One language across protocol core, CLI, and UI.
- Node provides TLS, sockets, and file I/O for IND$FILE with no extra deps.
- `electron-builder` makes signed/notarized Mac builds a solved problem. This is
  the actual hard part of shipping a Mac app, and the promise "download a `.app`
  that works" is central to the project's purpose.
- **Full testability in the headless development environment.** Verified during
  design: real Electron 43 runs under Xvfb on the dev box and
  `webContents.capturePage()` produces correct PNGs. Both protocol *and*
  rendering can be regression-tested by the developer, not only by the user.

Alternatives considered:

- *Python + PySide6:* better text rendering and a closer-to-native feel, but Mac
  packaging (PyInstaller/py2app plus notarization) is fragile in exactly the way
  that matters most here, with no bundle-size advantage.
- *Truly native (Swift/AppKit + GTK/Qt):* best Mac feel, but two UIs to maintain
  and no Swift toolchain in the dev environment, making every Mac-side iteration
  a round trip through the user. Native was not a requirement.

Accepted costs of Electron: ~150 MB bundle; Chromium keyboard handling needs
care for Option/dead keys and Cmd chords; canvas text rendering needs explicit
attention to stay crisp.

## Development Environment

The development box is headless: no `DISPLAY`, no system X server, no Rust/Go/
Swift/Java. Node 26 and Python 3.14 are present; npm and PyPI are reachable.

A userspace GUI toolchain was installed during design via a static `micromamba`
into `~/micromamba/envs/gui` — no root required. It provides Chromium's and
Electron's shared-library dependencies (glib, nss/nspr, the libX* set, atk,
at-spi2, libxkbcommon, libgbm, gtk3, libcups), fontconfig with fonts, and Xvfb.

Invocation for GUI work and tests:

```sh
GUI=$HOME/micromamba/envs/gui
export LD_LIBRARY_PATH=$GUI/lib
export FONTCONFIG_PATH=$GUI/etc/fonts FONTCONFIG_FILE=$GUI/etc/fonts/fonts.conf
$GUI/bin/Xvfb :99 -screen 0 1280x1024x24 &
export DISPLAY=:99
```

Verified working: headless Chromium canvas → PNG; Electron `BrowserWindow`
under Xvfb → PNG, with correct colors and glyphs.

The test host is a user-provided Hercules instance running MVS 3.8J or VM/370
R6, reachable from the development box over the network.

## Architecture

Single repository, npm workspaces (npm is already present in the dev
environment), four packages. The core has no UI dependency; the UI has no
network code.

```
packages/
  core/      pure TS; no deps beyond node:net and node:tls
  cli/       s3270-style headless driver — a real deliverable and the test harness
  app/       Electron main + preload + renderer
  fixtures/  recorded traces and golden screens from the live host
```

### Core Modules

Each module is a separate file with one responsibility and a narrow interface.

| Module | Responsibility | Interface |
|---|---|---|
| `telnet.ts` | RFC 854 option negotiation, IAC unescaping, EOR record framing | bytes in → records out |
| `stream/parse.ts` | Split a record into command + WCC + order/data tokens | record → token list |
| `stream/execute.ts` | Apply tokens to the buffer (SBA/SF/RA/EUA/IC/PT…) | tokens + buffer → mutated buffer |
| `screen.ts` | Cell array, field attributes, derived field list, cursor | `cellAt`, `fieldAt`, `toText()` |
| `keyboard.ts` | 3270 *actions* (not keys): Enter, PF*n*, Tab, EraseEOF, insert-mode typing | action + screen → screen edits |
| `inbound.ts` | Build Read-Modified / Read-Buffer replies: AID, cursor, MDT fields | AID → bytes |
| `codepage.ts` | EBCDIC↔Unicode, table-driven | byte ↔ string |
| `trace.ts` | Timestamped hex + annotated log of every byte, both directions | subscriber on the byte path |
| `session.ts` | State machine binding the above to a socket; emits screen-change events | `connect()`, `send(action)`, `on('screen')` |

**Key boundary:** `Session` never touches a pixel; the renderer never touches a
socket. The renderer receives an immutable screen snapshot and returns named
actions. The same core is therefore driven by the CLI, by tests, and by Electron
IPC without three divergent code paths.

### Two Structural Decisions

**The screen buffer is the single source of truth, held as a flat typed array of
cells plus a parallel attribute array** — as real hardware does it — *not* as a
list of field objects. Field boundaries are *derived* by scanning for attribute
positions. Emulators that store fields as objects get subtly wrong behavior when
a host overwrites a field attribute mid-stream, which both MVS and CICS do.

**Parse and execute are separate** so that "did we understand this datastream"
can be tested apart from "did we apply it correctly," and so the trace can
annotate a stream without mutating state.

## Protocol Scope — Stage 1

Target device: **IBM-3278-2**, 80×24 (1920 cells), basic 3270 mode, no extended
attributes on the wire.

### Telnet Layer

- Negotiate `TERMINAL-TYPE` (RFC 1091) → respond `IBM-3278-2`; `BINARY` both
  directions; `END-OF-RECORD` both directions. These three make it tn3270 rather
  than plain telnet.
- Refuse all other options with DONT/WONT — notably `TN3270E` in stage 1, so a
  host offering more still yields a clean basic-mode session.
- IAC doubling on output; `IAC IAC` → single `0xFF` on input; records delimited
  by `IAC EOR`.
- **Records may arrive split across TCP segments, so framing must be buffered.**
  This is the most common source of "works on localhost, fails on a real
  network" bugs.

### Outbound (host → terminal)

Commands: `Write` (0xF1), `Erase/Write` (0xF5), `Erase/Write Alternate` (0x7E),
`Erase All Unprotected` (0x6F), `Read Buffer` (0xF2), `Read Modified` (0xF6),
`Read Modified All` (0x6E). WCC bits: reset, keyboard restore, reset MDT, alarm.

Orders: `SF` (0x1D), `SBA` (0x11), `IC` (0x13), `PT` (0x05), `RA` (0x3C),
`EUA` (0x12), `GE` (0x08 — parsed and skipped).

Buffer addresses in **both 12-bit and 14-bit forms**; the encoding depends on
buffer size and hosts mix them.

For a 3278-2 the alternate screen size equals the default, so in stage 1
`Erase/Write Alternate` behaves identically to `Erase/Write`. It is implemented
as a distinct command anyway, since TN3270E gives the two different behavior.

### Inbound (terminal → host)

AID byte + 12-bit cursor address + for each modified field an `SBA` + address +
field contents. `Read Buffer` returns the entire buffer with attributes.

**Short-read AIDs** (Clear, PA1–PA3) send AID + cursor only, with no field data.
Getting this wrong hangs sessions.

### Structured Fields

Stage 1 parses the `WSF` command (0xF3) only far enough to **recognize and
cleanly skip it**, logging it in the trace. Full structured-field support —
including Query Reply, by which a host asks what the terminal can do — arrives
with TN3270E.

Rationale: MVS 3.8J and VM/370 do not require it, but a modern host will send
one, and silently mis-parsing it desynchronizes the stream, whereas skipping it
cleanly does not.

### Explicitly Deferred

Extended attributes (SFE/MF/SA), color and highlighting on the wire, graphic
escapes beyond skipping, TN3270E headers and device-name negotiation, printer
LUs, TLS, alternate screen sizes.

## Error Handling

Three distinct failure classes, handled differently rather than collapsed into
"connection error":

1. **Protocol violations** (unknown order, address past buffer end) → raise a
   3270 **program check**, display `X PROG` *nnn* in the OIA exactly as real
   hardware and x3270 do, and **keep the session up**. Real hosts do emit
   occasional garbage; a client that dies on it is useless.

   The core carries this as an *OIA state object* on the session — not as
   rendered text — so stage 1 has somewhere to put it before a GUI exists. The
   CLI surfaces it through the s3270 keyboard-state status field and through
   `ScreenJson`; the stage 2 renderer formats the same object into the OIA line.
2. **Transport failures** (reset, TLS failure, DNS) → session ends,
   `X Disconnected` shown, reconnect offered.
3. **Internal bugs** (our own assertion failures) → never swallowed. They fail
   tests loudly, and in the app surface a dialog with the trace file path.

## Headless CLI Driver

Modeled on `s3270`: documented, already spoken by automation in this space, and
compatible with existing scripts and expect-style harnesses.

Line-oriented on stdin. Each command emits `data:`-prefixed lines, then a
one-line status, then `ok` or `error` — s3270's exact protocol. The 12-field
status line (keyboard state, screen formatting, field protection, connection
state, model, rows, cols, cursor row, cursor col, window id, timing) is s3270's,
verbatim.

Stage 1 commands: `Connect(host:port)`, `Disconnect`, `String("...")`, `Enter`,
`Clear`, `PF(n)`, `PA(n)`, `Tab`, `BackTab`, `Home`, `Newline`, `EraseEOF`,
`Reset`, `MoveCursor(r,c)`, `Ascii()` / `Ascii(r,c,len)`, `Snap`,
`Wait(Output|Unlock|3270Mode)`, `Quit`, `Trace(on|off,file)`.

Extensions beyond s3270, documented as such:

- `ScreenText` — the whole screen as plain text, one line per screen row (24 in
  stage 1), for eyeballing.
- `ScreenJson` — cells, attributes, and field list as JSON, for tests.
- `Replay(tracefile)` — drive the core from a recorded trace with no socket.
  This is what makes the fixture corpus runnable.

Two specific requirements, both tested:

- `Wait(Unlock)` needs a timeout with a sane default (x3270 uses ~30 s), or
  scripts hang forever against a host that never unlocks the keyboard.
- `String()` must respect insert mode, field protection, and auto-skip — this is
  where "type into a panel" either works or silently corrupts input.

**This CLI is a deliverable, not scaffolding.** It is how the implementation is
verified against Hercules, how CI replays fixtures, and a requested feature in
its own right. Same binary; no test-only code path.

## GUI Design — Stage 2

### Process Split

The Electron main process hosts `Session` and owns the socket; no network code
runs in a renderer. The renderer uses `contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`, and communicates over a preload
bridge exposing exactly two channels: screen snapshots out, named actions in.
Consequence: a hostile host can do no more than draw wrong characters.

### Rendering

A single `<canvas>` drawn as a character grid. Compute an integer cell size from
font metrics and snap the grid to device pixels so glyphs never land on
half-pixels; redraw only dirty cells.

Default theme is the authentic 3278/3279 look: black background, the full
seven-color 3279 palette (green, white, red, blue, pink, turquoise, yellow) plus
their intensified variants, and a block cursor. **The whole palette is
implemented from the start**, even though extended attributes arrive later.

In stage 1 (basic mode, no extended attributes on the wire) the color of a cell
derives from its base field attribute using the standard 3279 base mapping:
unprotected-normal → green, unprotected-intensified → red,
protected-normal → blue, protected-intensified → white. When extended attributes
land, the remaining palette entries become directly addressable by the host.
Because the palette exists from day one, that change touches only attribute
decoding, not the renderer.

A bottom **OIA** line carries the real indicators: `4 A` system-connected,
`X Wait` / `X PROG nnn` / `X -f`, the insert-mode caret, and shift/keyboard-lock
state. The OIA is drawn *outside* the 1920-cell screen buffer — the window is
25 character rows tall for a 24-row screen — and is owned by the renderer, not
the buffer.

**Font: 3270font (https://github.com/rbanffy/3270font), bundled.** License
verified during design: BSD 3-Clause, with the SFD source additionally
available under OFL 1.1 — redistribution and bundling are permitted provided
the copyright notice and disclaimer ship with the app. (Its Debian-logo glyph is
CC-BY-SA-3.0 / LGPL-3+; noted for attribution completeness.) The authentic look
is therefore the default with no user setup. Users may still substitute a font.

### Keyboard

x3270 defaults: F1–F12 → PF1–12, Shift+F1–F12 → PF13–24, Return → Enter,
Tab/Shift+Tab → field navigation, Ctrl+U → erase input, and so on. A
Brown tn3270-compatible profile may be added later as an alternate.

Cmd- shortcuts are **additions, never the sole path** to an action, and every
3270 action also appears in a menu with its binding displayed. Reason: on a PC
keyboard attached to a Mac — the primary user has an IBM Model M — Alt sits
where Cmd is expected and there is no Fn key.

Bindings are expressed as **physical key + modifier, not typed character**, so
Option dead-key sequences and non-US layouts do not silently break PF keys, and
a 122-key terminal keyboard can bind real PF13–24 directly.

Documentation must mention macOS's "Use F1, F2, etc. as standard function keys"
setting; without it, F1–F12 never reach the app.

The keymap is loaded from a config file.

### Window

Aspect-preserving window that scales the grid in **integer steps with
letterboxing**, rather than blurry fractional scaling. Connect dialog. A Debug
menu trace toggle writing the same format the CLI produces.

## Forward-Compatibility Stubs

Three, all cheap now and expensive to retrofit:

- **`codepage.ts` is table-driven from the start.** CP037 is merely the first
  table, so CP285/297/500 become data files rather than code changes.
- **`Session` is instantiable more than once, with no module-level state**, so
  multi-session tabs are a UI change rather than a core rewrite.
- **The renderer takes screen dimensions as parameters, never hardcoded 80/24**,
  so TN3270E's negotiated sizes do not touch drawing code.

## Testing Strategy

Five tiers, cheapest first. Tiers 1–4 apply to stage 1; tier 5 arrives with the
GUI. Test-driven development applies: the 3270 datastream reference is precise
enough that failing tests can be written from the manual before each parser
feature.

**1. Unit tests over pure modules** (vitest). Parse, execute, screen, codepage,
and inbound are pure functions over byte arrays. Cases must include the nasty
ones: address wraparound past cell 1919; `RA` with a wrap target; a field
attribute overwritten mid-stream; `IAC IAC` inside field data; a record split
across three chunks; 12- vs 14-bit address encoding.

**2. Golden-screen tests.** Datastream fixture in; a text rendering of the
resulting screen compared against a checked-in `.txt` golden file, with
attributes in a parallel map. These are diff-readable — when a change breaks an
ISPF panel, the broken panel is visible in the test output rather than encoded
in an assertion about cell 743.

**3. Live-host recording.** A recorder mode captures every byte of a real
Hercules session to a trace file, which becomes a replayable fixture in
`packages/fixtures`. Canonical set to record: VTAM/CP logon; TSO logon to
`READY`; ISPF primary menu; ISPF edit with a full-screen field layout; a
`CLEAR`; a PA1 attention; a logoff. Replayed in CI forever, no host needed.
Regression protection derived from a real IBM host rather than from one reading
of GA23-0059.

**4. Round-trip conformance.** For each recorded session, replay the host bytes
into our core and assert the bytes we send back are byte-identical to what
x3270 sent in the original capture, taken from x3270 driving the same host under
`-trace`. Any divergence is either a bug or a documented deliberate difference.
The user has x3270 available, so reference captures are obtainable.

Because a comparison is only meaningful if both clients did the same thing, each
reference capture is produced by a **scripted** `s3270` session whose command
list is checked in beside the trace; our side replays that same command list.
Timing-dependent and genuinely variable bytes (timestamps in the trace envelope,
a host-echoed password field) are excluded by the comparison, and each exclusion
is recorded in the fixture rather than applied silently.

**5. Rendering regression** (stage 2). Electron + Playwright screenshot tests
under the verified Xvfb setup, so rendering is regression-tested and not just
the buffer.

## Reference Documents

- *IBM 3270 Data Stream Programmer's Reference*, GA23-0059-07 —
  https://dn790003.ca.archive.org/0/items/bitsavers_ibm3270GA2amProgrammersReference199206_26297005/GA23-0059-07_3270_Data_Stream_Programmers_Reference_199206.pdf
- GDDM reference — https://publibfp.dhe.ibm.com/epubs/pdf/admk1a00.pdf
- RFC 854 (Telnet), RFC 1091 (Terminal-Type), RFC 1576 (TN3270 current
  practices), RFC 2355 (TN3270E)
- x3270 — behavioral reference implementation
- 3270font — https://github.com/rbanffy/3270font

## Success Criteria

**Stage 1 is complete when:** the CLI can, driven by a script against the live
Hercules host, log on to MVS 3.8J (or VM/370 R6), navigate to a full-screen
application panel, type into fields, press Enter and function keys, observe
correct screen updates, and log off cleanly — with the whole session traced,
replayable as a fixture, and byte-identical inbound streams versus x3270 driving
the same host under the same scripted command list.

**The project is ultimately successful when** a Mac user can download a signed
app, double-click it, connect to a host, and use it without touching a terminal.
