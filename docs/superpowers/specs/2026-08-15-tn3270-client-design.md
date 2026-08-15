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
5. **Programmable Symbol Sets** — host-loadable glyph bitmaps, and with them the
   first real images on the display (see *3279 Graphics* below)

PS is a committed deliverable, not a maybe. It is placed after TN3270E because
it depends on it: PS is loaded via structured fields, and the host will not send
those until Query Reply has advertised the capability. Its position relative to
IND$FILE and printer sessions is a preference, not a constraint — it can move
earlier if wanted, so long as it stays after TN3270E.

Multi-session support and additional EBCDIC code pages are not staged
separately; stage 1 leaves stubs (see *Forward-Compatibility Stubs*) so they
become incremental work whenever wanted.

### 3279 Graphics — Programmable Symbol Sets, and later GDDM

The emulator should reach the fidelity of what real 3279 hardware could display.
The reference point is the primitive GIF viewer Rick Troth wrote for his own 3279
around 1992.

**Programmable Symbol Sets are in scope as stage 4 item 5** (above). GDDM vector
graphics remain unscheduled beyond that.

Components, in dependency order:

- **WSF Query Reply** advertising capability (usage, character sets, implicit
  partition, alphanumeric/graphic partitions). Required first: the host sends
  nothing graphical until the terminal has said it can receive it. Lands with
  TN3270E.
- **Programmable Symbol Sets (PS)** — host-loadable character cell bitmaps,
  delivered by the Load Programmable Symbols structured field. This is exactly
  how a GIF viewer on real hardware worked: the image was decomposed into custom
  glyphs, loaded into PS stores, then "typed" onto the screen as characters
  selected via `GE`. Cheapest path to real images and the historically faithful
  one. **Committed.**
- **GDF (Graphics Data Format) order parsing** — the vector primitives GDDM
  emits inside structured fields. Not scheduled.
- **Vector rendering** into the display. Not scheduled; follows GDF.

What PS support concretely requires, once Query Reply exists: parsing the Load
PS structured field; PS *stores* as a session-level resource (multiple loadable
sets, selected per-cell); the renderer drawing a cell from a loaded bitmap rather
than the font — which is precisely what the tagged cell-content variant in
*Forward-Compatibility Stubs* preserves; and `GE`-prefixed character references
resolving to a PS store rather than the codepage. Cell bitmaps are small
monochrome or 4-color rasters at the 3279's cell resolution, so rendering them is
a `putImageData`-class operation, not a new graphics pipeline.

Honest limitation: on real hardware this was bounded by 3279 cell resolution and
a small number of loadable sets. Troth's viewer was primitive because the
terminal was. Matching that fidelity is achievable; exceeding it substantially
means going beyond what the hardware did, which is a separate conversation.

Nothing in stage 1 precludes this. Three stage-1 and stage-2 decisions actively
enable it: `GE` (0x08) is parsed rather than rejected, so the graphic-escape path
exists and is exactly how PS glyphs get selected; `WSF` (0xF3) is recognized,
skipped, and traced, so the bytes carrying both PS loads and GDDM graphics
already route to a known place instead of desynchronizing the stream; and cell
content is a tagged variant, so a cell can later hold a loaded bitmap without
rewriting the renderer. Those stubs are the future entry points.

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
- Four options and commands per RFC 1576 need explicit handling rather than a
  blanket refusal, because real hosts use them mid-session:
  `3270-REGIME` → WONT (few servers support it; the host then falls back to the
  normal TERMINAL-TYPE path); `TIMING-MARK` → WONT (hosts use it as a liveness
  probe, and a *response* of some kind is what they need);
  `SUPPRESS-GO-AHEAD` → WILL; and `IAC NOP` → ignored silently, no reply.
  `ECHO` may be negotiated repeatedly during a pre-3270 NVT-mode login; stage 1
  answers WILL/DONT as asked without implementing NVT-mode local echo.
- Telnet option numbers (RFC 1576 §3): `BINARY` 0, `TERMINAL-TYPE` 24,
  `EOR` 25. Commands (RFC 854): `SE` 240, `NOP` 241, `BREAK` 243, `SB` 250,
  `WILL` 251, `WONT` 252, `DO` 253, `DONT` 254, `IAC` 255; `EOR` is 239.
  Subnegotiation codes (RFC 1091): `IS` 0, `SEND` 1 — so the terminal-type reply
  is `IAC SB 24 0 'I' 'B' 'M' '-' '3' '2' '7' '8' '-' '2' IAC SE` in ASCII.
- IAC doubling on output; `IAC IAC` → single `0xFF` on input; records delimited
  by `IAC EOR`.
- **Records may arrive split across TCP segments, so framing must be buffered.**
  This is the most common source of "works on localhost, fails on a real
  network" bugs.

### Outbound (host → terminal)

Commands: `Write` (0xF1), `Erase/Write` (0xF5), `Erase/Write Alternate` (0x7E),
`Erase All Unprotected` (0x6F), `Read Buffer` (0xF2), `Read Modified` (0xF6),
`Read Modified All` (0x6E). WCC bits: reset, keyboard restore, reset MDT, alarm.

**Each command has two encodings and both must be accepted.** The values above
are the SNA-style codes that a TN3270 host normally sends; the non-SNA/channel
codes for the same commands are `W` 0x01, `RB` 0x02, `NOP` 0x03, `EW` 0x05,
`RM` 0x06, `EWA` 0x0D, `RMA` 0x0E, `EAU` 0x0F, `WSF` 0x11. x3270 accepts either
(`case CMD_EW: case SNA_CMD_EW:` and so on throughout `ctlr.c`), so we do too.
Note that non-SNA `WSF` (0x11) collides numerically with the `SBA` *order* — they
are distinguishable only by position, command byte versus order byte, which is
one more reason parse and execute are separate. Also note non-SNA `NOP` (0x03)
is a 3270 command distinct from Telnet `IAC NOP`.

Orders: `SF` (0x1D), `SBA` (0x11), `IC` (0x13), `PT` (0x05), `RA` (0x3C),
`EUA` (0x12), `GE` (0x08 — parsed and skipped). Deferred orders, recognized so
they can be skipped by length rather than mis-executed: `SA` (0x28),
`SFE` (0x29), `MF` (0x2C).

All command and order codes above are verified against the hexadecimal index in
GA23-0059-07 Appendix F.

Field attribute bits (GA23-0059-07 Table 4-4), which drive both protection logic
and the base-color mapping: bit 2 protected; bit 3 numeric (bits 2+3 both set →
auto-skip); bits 4–5 `00` normal / `01` selector-pen detectable / `10`
intensified / `11` nondisplay; bit 6 reserved, always 0; bit 7 MDT.

WCC bits (Table 3-2): bit 1 reset, bit 4 start-printer, bit 5 sound-alarm,
bit 6 keyboard-restore, bit 7 reset-MDT. Bits 2–3 are printer-only. Stage 1
honors reset-MDT, keyboard-restore, and alarm; start-printer returns no printer
available.

Buffer addresses in **both 12-bit and 14-bit forms**; the encoding depends on
buffer size and hosts mix them. Per GA23-0059-07, the top two bits of the first
address byte are flags: `00` → a 14-bit binary address in the remaining 14 bits;
`01` or `11` → a 12-bit address formed from the low 6 bits of each byte;
`10` → **reserved, and receipt must reject the datastream** (i.e. a program
check, per *Error Handling*).

Outbound, addresses are generated 14-bit when the buffer exceeds 4096 cells and
12-bit otherwise — for an 80×24 screen (1920 cells) that means 12-bit, with the
6-bit values mapped through the standard 64-entry code table (`0x40, 0xC1…0xC9,
0x4A…0x4F, 0x50, 0xD1…`), matching x3270's `ENCODE_BADDR` and `code_table`.

For a 3278-2 the alternate screen size equals the default, so in stage 1
`Erase/Write Alternate` behaves identically to `Erase/Write`. It is implemented
as a distinct command anyway, since TN3270E gives the two different behavior.

### Inbound (terminal → host)

AID byte + 12-bit cursor address + for each modified field an `SBA` + address +
field contents. `Read Buffer` returns the entire buffer with attributes.

AID values (GA23-0059-07 Table 3-4, cross-checked against x3270's `3270ds.h`):
Enter 0x7D; PF1–9 0xF1–0xF9; PF10–12 0x7A/0x7B/0x7C; PF13–21 0xC1–0xC9;
PF22–24 0x4A/0x4B/0x4C; PA1 0x6C, PA2 0x6E, PA3 0x6B; Clear 0x6D;
SysReq 0xF0; Selector pen 0x7E; no-AID 0x60; Query Reply 0x61;
structured field inbound 0x88.

Note that the field address sent in an `SBA` is the address of the **field
attribute + 1** — the first data cell, not the attribute itself.

Attn is not an AID at all: per RFC 1576 §8 it is sent as **Telnet `IAC BREAK`**,
so it belongs to the telnet layer rather than `inbound.ts`.

**Short-read AIDs** (Clear, PA1–PA3) send **the AID byte alone** — no cursor
address and no field data. Verified against GA23-0059-07 ("only an AID byte is
transferred to the application program") and against x3270's
`ctlr_read_modified`, which emits the AID and jumps straight to the end for
`AID_PA1/PA2/PA3/CLEAR`. Getting this wrong hangs sessions.

Two adjacent cases that are *not* the same thing: `Read Modified All` suppresses
the short read (x3270 sets `short_read` only when `!all`), so under RMA those
same AIDs send AID + cursor + fields; and Selector-Pen `SELECT` (0x7E) sends
AID + cursor but no field data — cursor present, data absent.

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
LUs, TLS, alternate screen sizes, and all graphics — Query Reply, Programmable
Symbol Sets, and GDF (see *3279 Graphics*).

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
`Clear`, `PF(n)`, `PA(n)`, `Attn`, `Tab`, `BackTab`, `Home`, `Newline`,
`Left`, `Right`, `Up`, `Down`, `BackSpace`, `Delete`, `Insert`, `EraseEOF`,
`EraseInput`, `Reset`, `MoveCursor(r,c)`, `Ascii()` / `Ascii(r,c,len)`, `Snap`,
`Wait(Output|Unlock|3270Mode)`, `Quit`, `Trace(on|off,file)`.

`Attn` sends Telnet `IAC BREAK` rather than an AID (see *Inbound*). Row and
column arguments are **0-based**, as s3270's are.

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
  table, so CP285/297/500 become data files rather than code changes. The CP037
  table is generated once as a build-time artifact from Python's built-in `cp037`
  codec (verified to round-trip all 256 byte values) and checked in, rather than
  transcribed by hand.
- **`Session` is instantiable more than once, with no module-level state**, so
  multi-session tabs are a UI change rather than a core rewrite.
- **The renderer takes screen dimensions as parameters, never hardcoded 80/24**,
  so TN3270E's negotiated sizes do not touch drawing code.
- **A cell's visual content is a tagged variant, not "a codepoint to look up in
  the font."** In stages 1–2 the only variant is `{kind: 'char', codepoint}`,
  and no other variant need be implemented — but the renderer must dispatch on
  `kind` rather than assuming every cell indexes the font by character. This is
  the one genuine retrofit risk for graphics, and since Programmable Symbol Sets
  are a committed deliverable (stage 4 item 5), the second variant
  `{kind: 'ps', store, index}` is a known future addition rather than a
  hypothetical one; GDF would later add a pixel-region variant. Dispatching from
  the start makes those additions; assuming codepoints makes them a renderer
  rewrite. Cost now is one `switch` with a single case.
- **Query Reply is generated from a capability list, not a hardcoded byte
  blob** (relevant from the TN3270E stage onward). Advertising graphics later
  then means adding a capability entry rather than editing opaque bytes.

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
  Downloaded to `~/3270/ref/ga23-0059-07.pdf` (26 MB, 436 pages, with a usable
  text layer — `pypdf` extracts it; Appendix F is the hexadecimal index and the
  fastest way to check a code). All wire constants in this spec were verified
  against it. Note the OCR mangles some hex digits in tables (`F8`→`FB`,
  `7A`→`?A`), so cross-check anything surprising against x3270's `3270ds.h`.
- GDDM reference — https://publibfp.dhe.ibm.com/epubs/pdf/admk1a00.pdf
- RFC 854 (Telnet), RFC 1091 (Terminal-Type), RFC 1576 (TN3270 current
  practices), RFC 2355 (TN3270E)
- x3270 — behavioral reference implementation
- 3270font — https://github.com/rbanffy/3270font
- *IBM 3270 Information Display System: 3274 Control Unit Description and
  Programmer's Guide* and the GDDM reference above, for the eventual graphics
  work (Programmable Symbol Sets, GDF orders)

Sought but not yet located: Rick Troth's 3279 GIF viewer (~1992, VM/CMS). A web
search from the development environment failed outright — `WebSearch` returned
zero results for every query including trivial control queries, so this is a
tool failure rather than evidence of absence. Worth retrying, or asking the
author. If recovered, its greatest value would be a **recorded datastream** of a
real 3279 loading PS glyphs, which is a better fixture than the source itself.

## Success Criteria

**Stage 1 is complete when:** the CLI can, driven by a script against the live
Hercules host, log on to MVS 3.8J (or VM/370 R6), navigate to a full-screen
application panel, type into fields, press Enter and function keys, observe
correct screen updates, and log off cleanly — with the whole session traced,
replayable as a fixture, and byte-identical inbound streams versus x3270 driving
the same host under the same scripted command list.

**The project is ultimately successful when** a Mac user can download a signed
app, double-click it, connect to a host, and use it without touching a terminal.
