# tn3270

A TN3270 terminal emulator for macOS and Linux, in TypeScript.

No good graphical 3270 client has existed for the Mac since Brown University's
tn3270, which stopped being usable somewhere around the transition to OS X. The
options since have been x3270 under X11, commercial Windows emulators, or a
terminal-mode client in a window that does not know it is pretending to be a
3278. This project is an attempt at the client that ought to exist: a real 3270
data-stream implementation with a native-feeling GUI, correct enough that a host
cannot tell it from the hardware.

**Status: there is a working GUI, a working terminal client, a scripting CLI, and a
browser gateway.**
The protocol core, an s3270-compatible scripting CLI, extended data stream with Query
Reply, 3279 colour, `IND$FILE` file transfer, TLS, screen models 2–5, TN3270E, a
c3270-style TUI, an Electron GUI and a browser gateway are all done, and everything but
TN3270E is verified against two live hosts — VM/370 and MVS 3.8j.

**There are FOUR front ends**: the scripting CLI, the TUI, the Electron GUI, and the web
gateway, which serves the GUI's own renderer to a browser over a WebSocket.

**It is not yet something you can hand to someone else.** There is no packaging, so no
`.app` to download; the GUI has no connect dialog, menus or preferences, and takes its host on
the command line like the other front ends. The mouse does exactly one thing — press the
virtual keypad's buttons — and nothing else: no click-to-place-cursor, no drag-to-select, no
light pen. See *What is not implemented* below, which is the honest part of this file.

## What works today

**A usable terminal client, driven interactively against both live hosts.**

```sh
node packages/tui/dist/main.js -insecure -model 3278-2-E 127.0.0.1:3271
```

`-insecure` is there because TLS is on by default and Hercules cannot speak it; against
a modern host you would leave it off. See *TLS*.

- **MVS 3.8j (TK5)** — logs on to TSO, reaches ISPF's primary option menu, pages
  through the tutorial, exits and logs off cleanly. Reproduced on four separate
  userids.
- **VM/370 (VM/CE 1.2)** — logs on, reaches CMS, has `QUERY DISK A` answered *by CMS*
  with its disk table, and logs off with CP's own `LOGOFF AT` accounting. That last
  part is the difference between being understood and being tolerated.

**3279 colour is real and proven on the wire, not just in unit tests.** TK5's ISPF
menu renders five distinct foreground colours where the base-attribute map can only
produce four — two of them (turquoise, neutral-white) come from the host's SA/SFE
extended attributes and would have been silently discarded before. The SA orders we
parse are **byte-for-byte identical to s3270's** on the same panel, checked as a
colour-capable 3279.

**`IND$FILE` file transfer works on both hosts, in both directions**, CUT mode, with a
binary round-tripping byte-identically each way.

**There is a GUI.** `packages/gui` is an Electron window with a canvas renderer that
blits glyphs from an atlas baked out of x3270's own 3270 bitmap font, at integer scale with
antialiasing off — the authentic 3278/3279 face, and deterministic enough that screenshots
can be compared byte for byte. It renders live screens from both Hercules systems, sizes
itself to the model the host negotiates, and takes typed input. `Ctrl-]` quits, because
Ctrl-C is the Clear AID.

```sh
npm run build
./node_modules/.bin/electron packages/gui/dist/main.js -insecure -model 3278-4-E HOST:PORT
```

It takes the TUI's flags unchanged — `-model`, `--terminal-type`, `-tn3270e on|off`, the TLS
set, and the full `[prefix:][LU,LU@]host[:port]` shape — because all three of those front ends
parse them with the same code (`packages/frontend`). `-scheme` is the one flag not shared with
the CLI, since a script-driven client has nothing to render; see *Using the TUI*. The web
gateway takes a deliberately smaller set; see *Using the web gateway*.

**And there is a browser gateway.** `packages/web` serves that same canvas renderer — the
same file, not a copy — to a browser, with a WebSocket where the Electron app has IPC:

```sh
npm run build
node packages/web/dist/main.js -insecure -model 3278-4-E HOST:PORT
```

Loopback by default, a cross-origin upgrade refused, and `wss://` in-process given
`--tls-cert`, so a terminating proxy is optional rather than required. The access token is
**off** by default and paired with that loopback bind — `--auth on` turns it on and prints
it in the URL, and is what you want the moment you `--bind` anything wider. It renders live screens from both Hercules systems, and a
session outlives its socket for `--grace` seconds so a reload reattaches instead of logging
on again. **Without `--tls-cert`, keystrokes — including passwords — cross the network in
the clear**, which it says out loud on startup. Full flag list and the security notes:
`packages/web/README.md`.

That the renderer is genuinely shared rather than merely similar is checked in pixels:
`packages/web/scripts/browser-shot.mjs` compares the served page against the Electron app's
own screenshot golden and requires them to be identical, with and without the keypad shown.

**There is a virtual keypad, and four keys that had no way to be pressed.** `Ctrl-K` shows and
hides a 47-button keypad in the Electron GUI and in a browser — PF1–PF24, PA1–PA3, and the
special keys a PC keyboard has not got — drawn through the same glyph atlas as the screen, so it
looks like a 3270 rather than like a native widget. Each key is **inverse video**, a black label on a
white block, on a grid spaced by a blank row between key rows and a blank column at the end of every
key: one cell tall and butted together, the blocks would merge into bars instead of reading as keys. It is a third region of the draw list,
appended *below* the screen and the status line, so showing it never moves or covers a row the
host wrote: the Electron window grows to fit and a browser page scrolls. Clicking a button fires
exactly the action its label names; a click anywhere else is ignored.

The TUI has no mouse, so `Ctrl-K` there opens a **keyboard-navigable list** of the same 47 keys
instead — arrows move (`k`/`w` and `j`/`s` too), Enter fires, `Esc` closes — with each key's chord shown beside it, read
from the same binding table the keymap is checked against so the on-screen help cannot drift. Every
line is padded to one width, so the list is an opaque block rather than 47 ragged lines with the
host's screen showing through the chord column.

Four 3270 keys became reachable in the process, having been implemented in `core` with no way to
press them: **Dup** (`Ctrl-D`), **Field Mark** (`Ctrl-F`), **Sys Req** and **Newline**. The last
two get no chord — see *Using the TUI*. **Sys Req now puts bytes on the wire against a classic
host**, as a four-byte test request read rather than the AID you would expect; it has no live
witness yet. See *What is not implemented*.

**On a headless Linux box** you also need an X server and two Chromium flags, neither of
which a Mac wants: `--no-sandbox` because the sandbox needs privileges a shared box may not
grant, and `--disable-gpu` because without GL a hidden window HANGS rather than failing.
`docs/live-testing.md` has the full recipe under *The Electron GUI against both hosts*.

**TN3270E negotiates end to end** — device type, functions, the 5-byte header, SNA
responses, SYSREQ and LU selection — but against real s3270 and an in-repo TN3270E
server, **not against a live host**. Neither Hercules system offers the option at all,
and the one real host that does — public z/VM 4.4, probed 2026-09-17 — **offers it and
then withdraws it** after our device-type request, so what has a live witness is the
*offer* and our *fallback*, not a completed negotiation. **That withdrawal is the host's
own non-conformance, not ours** — real s3270 was refused by it identically — but that
exonerates the implementation rather than verifying it. See *TN3270E* and *Verification*.

Inbound records are **byte-identical to real x3270** (s3270 4.5ga6) in 5 of 6 records;
the sixth differs by design, where s3270 blocks on a hardcoded `Wait(InputField)`.

These terminal harnesses come with it, because "it looked right" is not a result
(the GUI and browser ones are listed under *Verification*):

- `packages/tui/scripts/live-drive.py <tk5|vm>` drives the TUI against a real host over
  a pty and reconstructs what was actually drawn. It counts reverse-video cells and
  solid blocks, and reports whether it confirmed its own logoff.
- `packages/tui/scripts/pty-smoke.py` does the same host-free against a local minimal
  TN3270 server: 12 checks, including that your terminal still echoes afterwards.
- `packages/cli/scripts/drive-playback.py` replays **recorded real hosts** through
  x3270's own `playback -b`, which asserts our replies byte for byte with no host and
  no network. It needs a built suite3270 alongside this repo; 10 of 10 traces pass.

## Build and test

Developed and tested on Node 26. `package.json` declares no `engines` floor and
no other version has been tried; the code targets ES2023 with `NodeNext` modules and its
runtime imports are only `node:child_process`, `node:crypto`, `node:fs`, `node:http`,
`node:https`, `node:net`, `node:path`, `node:readline`, `node:tls`, `node:url` and
`node:zlib` — taken from the BUILT output, so the type-only `node:stream` is excluded. All
are long-standing, so Node 18+ ought to work for the client, but that is inference rather
than a tested claim. **The test suite needs more than the client does**: `integration.test.ts`
drives the gateway with Node's own built-in `WebSocket`, which is what makes it an independent
check of our hand-rolled framing, and that global is only unflagged from Node 22.
Only `packages/gui` depends on anything outside the standard library, and its dependency is
Electron. **`packages/web` adds none** — Node has a WebSocket client but no server, so the
framing is hand-rolled behind a seam that a `ws` wrapper could replace wholesale. The package
graph is `core <- frontend <- { cli, tui }` and `core <- canvas <- { gui, web }`.

```sh
npm install        # pulls Electron, which is ~230 MB of binary
npm run build      # NOT `npm run build --workspaces`, which fails on the
                   # data-only fixtures package
npm test           # 1869 tests, 74 files
npm run typecheck
```

`npm run build` also bakes the GUI's glyph atlas out of the vendored bitmap font, so it is
not optional before running the GUI. Note that `npm install` may not run Electron's own
postinstall depending on your npm's script-approval settings, in which case the binary is
fetched on first launch instead — "Downloading Electron binary..." is that, not a hang.

## Using the GUI

```sh
npm run build
./node_modules/.bin/electron packages/gui/dist/main.js -insecure -model 3278-4-E HOST:PORT
```

The flags are the TUI's, unchanged — `-model`, `--terminal-type`, `-tn3270e on|off`, the TLS
set, and the full `[prefix:][LU,LU@]host[:port]` shape. That is not a coincidence or a
promise to keep them in step: all three front ends parse them with the same code in
`packages/frontend`. `-scheme` is the one flag that is not shared with the CLI, since a
script-driven client has nothing to render; see *Using the TUI* for what it picks between.

**`Ctrl-]` quits. `Ctrl-C` does NOT** — it is the Clear AID, which a 3270 user needs
constantly to dismiss VM's `MORE...` state. `Ctrl-R` is Reset, `Ctrl-U` is EraseInput,
`Ctrl-A` is Attn, `Ctrl-D` is **Dup**, `Ctrl-F` is **Field Mark**, `Insert` toggles insert mode,
F1–F12 are PF1–PF12 and shifted F1–F12 are
PF13–PF24, following c3270. **PA1/PA2/PA3 are `Option`/`Alt` + `1`/`2`/`3`** — matched on the
physical key, so they work whatever your Option key is configured to type. On a Mac where
left-Option is remapped to Command, use right-Option: `Cmd`-digit is deliberately left for
menu accelerators.

`Ctrl-D` and `Ctrl-F` are c3270's own bindings (`Common/fb-c3270:186-187`). **Dup writes EBCDIC
`0x1C` and then performs a TAB** — the manual's own wording, p. 7-12 — which is the opposite of
what x3270's auto-skip suppression looks like on its own; **Field Mark writes `0x1E` and advances
like an ordinary typed character.** A numeric field accepts Dup and refuses Field Mark, per the
manual's permitted set (p. 4-13).

**`Ctrl-K` shows and hides the virtual keypad**, and `Alt-K` does the same — `Ctrl-K` is c3270's
terminal binding (`Common/fb-c3270:191`) and `Alt-K` is how its Windows keymap spells the same
command, so both are honoured here rather than one being a divergence. The window grows and
shrinks to fit; nothing above the keypad moves. **Clicking a button is the only thing the mouse
does.** A press highlight is drawn locally and never reaches the host, so it cannot lag behind
your finger over a WebSocket.

**Sys Req and Newline have no chord, in any front end, and that is deliberate.** c3270 defines no
Sys Req chord either; Newline's would be `Ctrl-J`, which *is* `\n` (0x0a) and already means Enter
in a terminal — one byte cannot be both, and turning Return into a cursor move is not a trade
worth making. The keypad button is their route, which is a large part of why the keypad exists.

**While disconnected, `Enter` and `Ctrl-C` (Clear) reconnect to the same host and port**, and send
nothing. VM prints `Press Enter or Clear to continue` in the instant a `LOGOFF` drops the line, on
the last screen it ever painted — and until now both keys did nothing whatever, because a
disconnected `sendAID` throws and the shared dispatch swallows it. The status line says so too:
`X Disconnected -- press Enter to reconnect`, and only once there is a host to go back to, so a
replayed trace does not offer a key that cannot work. **This is a deliberate divergence from
x3270**, which binds no key to its `Reconnect()` action; the TLS decision, the port and any `N:` or
`LU@` from the original host argument are all replayed, never re-derived, and a second press while
the first attempt is still dialling is refused rather than opening a second socket.

**The window sizes itself to the screen the host negotiates**, at the largest whole-number
scale that fits 80% of your display. Whole numbers only: the font is a bitmap, and a
fractional scale would smear it. A model 4 is 43 rows, and the host decides that *after*
connecting — VM sends Erase/Write Alternate — so the window may grow a moment after the
first paint.

The glyphs come from x3270's own 3270 bitmap font, baked into a sprite atlas by
`npm run build`, drawn with antialiasing off. That is what makes it look like a 3278 rather
than a terminal in a window, and it is also why screenshots of it can be compared byte for
byte (`packages/gui/scripts/shot.mjs`).

**What it does not have yet:** no connect dialog, no menus, no preferences, and no packaging —
so the host goes on the command line and there is no `.app` to double-click. **The mouse presses
keypad buttons and does nothing else**: clicking the screen does not place the cursor, dragging
does not select text, and there is no light pen. **What is implemented but not yet verified
against a live host:** the PF and
Clear keys (they travel the same path as ordinary typing, which *is* verified end to end),
the `Ctrl-]` quit, and the in-window error message for a failed connection. **Attn is a
Telnet BREAK, measured against VM/370's pre-logon banner with no visible reaction** — a real
null result, not a gap in testing; whether CP responds once logged into CMS is a different,
untested state. **PA1/PA2 are verified on one half and not the other, and the two halves
should not be merged back together:** the CLI's `PA(n)` command makes the identical
`sendAID` call the GUI's `Alt-1`/`Alt-2` bindings make, and driving it against MVS's ISPF
got a real, quoted, distinct reaction to each — `ISP088E ... TERMINATED DUE TO ATTENTION
INTERRUPT` for PA1, a bare `READY` redisplay for PA2 — so our AID bytes and the host's
reaction to them are settled. The local half is settled too — first by **hand**: the author
reported PA1 working from a real keypress in the app against MVS on 2026-09-15, and now by a
guard as well. `actionForKey` maps Alt+digit and is unit-tested against a synthetic key-like
object; the plumbing from a real keypress to that mapper — the renderer's `keydown` listener,
the IPC hop,
`ipcMain` — is guarded by `packages/gui/scripts/keys.mjs`, which sends **18 chords as real
Chromium key events and asserts the 16 actions that must arrive, in order, plus two that must
not**. It is **not part of `npm test`** (it spawns Electron): run it by hand,
`node packages/gui/scripts/keys.mjs`, as you would `shot.mjs` or `pty-smoke.py`. `npm test`
only pins its invocation. Its failure has been observed rather than assumed — breaking the
renderer's `keydown` listener leaves the suite green and reddens only the harness.

**The mouse path has the same kind of guard, for the same reason.**
`packages/gui/scripts/clicks.mjs` shows the keypad with a real `Ctrl-K`, then clicks **9 buttons
by label** with real Chromium mouse events and asserts the 10 actions that must arrive in order
(the toggle plus one per button). Its value is the plumbing — `mousedown`, the primary-button
guard, the scale-and-offset inverse, `hitTest`, `sendAction`, IPC, `applyAction` — none of which
any unit test can execute, because `renderer.ts` throws at module load outside a browser. Proved
as a mutation: a bare `return` at the top of the `mousedown` listener leaves build, typecheck and
every test clean — 1643 of them, as the suite stood when that mutation was measured — while every
keypad button is dead, and only this harness reddens. Like `keys.mjs` it is not part of `npm test`;
`npm test` pins its invocation.

**On a headless Linux box** add `--no-sandbox --disable-gpu` and point `DISPLAY` at an X
server; a Mac needs neither. Without `--disable-gpu` a hidden window hangs rather than
failing, which reads as a broken build. Full recipe: `docs/live-testing.md`, *The Electron GUI
against both hosts*.

## Using the TUI

```sh
node packages/tui/dist/main.js [-model M] [--terminal-type T] [--colors N] [-scheme S] \
    [-insecure] [-noverifycert] [-cafile FILE] host[:port]
```

`-model 3278-2-E` is usually what you want: TSO rejects a plain `IBM-3278-2`. Port
defaults to 23. Models 2–5 are accepted, with or without `-E`; see *Screen models*.
`--colors` takes `0|8|16|256|16m|auto`, where `auto` asks terminfo and
`0` is monochrome because you said so — the distinction matters, since it is how the
monochrome path gets tested on a colour terminal.

**`Ctrl-]` quits. `Ctrl-C` does not** — it is the Clear AID, which a 3270 user needs
constantly, so a hint line says so. Given a spare row (27 or more for a 24-row screen)
it is drawn dim above the screen and **stays there**; in a shorter window it is printed
once before raw mode starts instead. Never both. Vertical slack is spent in priority
order — OIA, bottom border, hint, top border — so at exactly 27 rows the hint takes the
row the top border would have had, on the same reasoning that gives the OIA precedence
over the bottom border: functional beats decorative. `Ctrl-R` is Reset, `Ctrl-U`
erases input, `Ctrl-A` is Attn, `Insert` toggles insert mode, `F1`–`F12` are PF1–12 and
`Shift+F1`–`F12` are PF13–24, and **`Esc` `1`/`2`/`3` are PA1/PA2/PA3.** A lone `Esc` is not
held immediately — it arms the same 50ms timer as an unfinished function-key sequence, so a
split arrow or function key that completes within the timeout still resolves normally.
Only once the timer expires is the `Esc` promoted to a Meta prefix, and even then it
combines with just the next byte, and only to complete a PA; anything else and the `Esc` is
dropped. Arrow keys are bound in **both** encodings, CSI and SS3, because terminfo reports
only the application-mode one and any layer can flip the mode.

**Disconnected, `Enter` and `Ctrl-C` reconnect** to the same host, port and per-host options
rather than sending their AID — see *Using the GUI* for the whole rule; the behaviour is shared
code and identical in all three interactive front ends.

**`Ctrl-D` is Dup and `Ctrl-F` is Field Mark**, both c3270's own bindings
(`Common/fb-c3270:186-187`). Dup writes EBCDIC `0x1C` and then TABs — the manual's own wording,
p. 7-12 — and Field Mark writes `0x1E` and advances like a typed character; a numeric field takes
Dup and refuses Field Mark (manual p. 4-13).

**`Ctrl-K` opens the special-keys list.** A terminal has no mouse, so this is the TUI's answer to
the canvas front ends' keypad: the same 47 keys as a scrolling list over the top-left of the
screen, arrows to move, `Enter` to fire the marked key, `Esc` or `Ctrl-K` again to close. `Ctrl-K`
is c3270's own binding for its keypad (`Common/fb-c3270:191`), not a divergence. While the list is
open **it owns the keyboard** — nothing falls through to the field behind it — and the window
follows the selection rather than showing only the first screenful, or everything past `Attention`
(**Sys Req** and **Newline** included) would be unreachable. That is the point of the list: those
two are the keys with no chord anywhere, and this is their only keyboard route. Each line shows
the key's chord where it has one, read from the same `BINDING_INTENT` table the keymap is checked
against, so 22 of the 47 correctly show a blank rather than a guess.

**The list is opaque, and that took fixing.** Every line is padded to one width — 27 columns: the
selection mark, the name column, a two-space gap and the widest chord — so the 3270 screen behind
it never shows through. It used to draw each line at its natural length, and the 22 lines with no
chord therefore ended at the name: on a pty against a host whose first row read `HELLO TN3270`, the
PF16 line rendered as `  PF16 TN3270`, which reads as though `TN3270` were PF16's chord. Against a
real MVS or VM screen every chordless line would have invented one that way. The selected line is
a full-width reverse-video bar for the same reason.

**`k`/`w` also move up and `j`/`s` down**, in either case, while the list is open. Bare letters are
bindable nowhere else in this emulator — everywhere else a letter is data you type into a field —
and they are safe here only because the list already owns and swallows the whole keyboard, so they
replace a no-op. `h`, `l`, `a` and `d` are deliberately left swallowed: the list is one column, so
there is nothing for left and right to do. Case-folding diverges from vi, where `K` is not `k`,
because caps lock must not make the list unnavigable.

**Colours come from one shared table in `packages/frontend`, and `-scheme` picks which.**
`default` is the readable one — zti's own values for F0–F7 (eight codes), x3270's for the
rest — and it is what every front end draws unless told otherwise. `3279` is
core's own saturated table: **our own choice of primaries, not a phosphor measurement** —
the manual names each colour without fixing its chromaticity, and a real 3279 matched
neither this table nor x3270's — kept because someone comparing against the architected
meaning may want the unambiguous version. `x3270` is that emulator's own `rgbmap`, for
comparing against it. `green` is a monochrome 3278, **the only one of the four with any
claim to authenticity**, because a 3278 had no colour at all — colour was a 3279 feature —
and `greenscreen` is accepted as an alias for it, x3270's own spelling. Quantisation to 16
colours is an explicit per-scheme table rather than nearest-RGB: with any pleasant palette,
blue and turquoise both land nearest ANSI cyan and would collide.

## Screen models

`-model 3278-N` and `-model 3278-N-E` accept N of 2, 3, 4 or 5.

| Model | Alternate size |
|---|---|
| 2 | 24×80 |
| 3 | 32×80 |
| 4 | 43×80 |
| 5 | 27×132 |

**Pick the model your host's device is defined as.** The host does not adapt to us:
VM/370 takes a display's geometry from its own DMKRIO configuration, so a device
defined there as a 3278-4 is sent 43 rows whatever we advertise — and a model-2 client
on that device ends up with a locked keyboard and no fields rather than a small screen.
Verified live; see `docs/live-testing.md`.

**The model does not change the screen you get on connect.** Every model's *default*
size is 24×80; the model number sets the *alternate* size, and the host switches between
them with Erase/Write and Erase/Write Alternate. So `-model 3278-4` starts at 24×80 and
becomes 43×80 only if the host asks. This is x3270's model exactly — `ROWS = defROWS =
MODEL_2_ROWS` unconditionally (`ctlr.c:341`), with only `altROWS = maxROWS` varying
(`ctlr.c:345`) — and it is **not** TN3270E, which `ctlr.c:558-561` switches size without
reference to.

`-E` is an extended-data-stream claim, not a size: `3278-4` and `3278-4-E` have identical
geometry.

Observed live on VM/370: the host sends Erase/Write for its logo at 24×80, then
Erase/Write Alternate to move to 43×80 — the architected sequence, both halves in one
session.

The TUI re-places and repaints when the host resizes the screen, and suspends with a
message if your window can no longer hold it, exactly as it does for a terminal resize.
A `--terminal-type` string is sent verbatim and does **not** set a geometry — we cannot
know what an arbitrary string implies, so use `-model` if you want the buffer to match
what you claim.

## Connecting over TLS

**TLS is the default.** Give no flag and the connection is encrypted and the host's
certificate chain verified against the system trust store.

| Flag | Effect |
|---|---|
| *(none)* | TLS, chain verified |
| `-cafile FILE` | TLS, verified against that PEM instead of the system store |
| `-noverifycert` | TLS, chain not verified. `-no-verify` is accepted too |
| `-insecure` | no TLS at all |

`-insecure` is what the Hercules systems need — neither VM/370 nor MVS 3.8j can speak
TLS. s3270's `L:host` prefix is accepted and stripped, since TLS is already the default;
asking for it while also passing `-insecure` is an error rather than a silent downgrade.
The default port stays 23 even with `L:`, matching s3270: quietly redirecting to 992
would open a connection somewhere you did not type.

**Prefer `-cafile` over `-noverifycert` for a self-signed host.** Both connect, but
pinning the host's own certificate still *authenticates* it and so still detects a
man-in-the-middle; `-noverifycert` authenticates nothing. There is a script to make a
test certificate, and a proxy to put TLS in front of a host that lacks it:

```sh
node packages/cli/scripts/gen-test-certs.mjs /tmp/certs
node packages/cli/scripts/tls-proxy.mjs --to 127.0.0.1:3271 --listen 19271 \
    --cert /tmp/certs/cert.pem --key /tmp/certs/key.pem
node packages/tui/dist/main.js -model 3278-2-E -cafile /tmp/certs/cert.pem 127.0.0.1:19271
```

**A plaintext host does not refuse TLS — it goes quiet.** Hercules sends
`IAC DO TERMINAL-TYPE` (`ff fd 18`) and waits, which OpenSSL reads as the start of a record and then blocks for a length that
never comes. So there is a 10-second handshake deadline, and every TLS failure names the
flag that would fix it:

```
127.0.0.1:3270 accepted the connection but never completed a TLS handshake. If it
does not speak TLS — a Hercules or other vintage system — use -insecure.
```

Design and measurements: `docs/superpowers/specs/2026-08-25-tls-support-design.md`.

## TN3270E

**TN3270E is on by default**, and backs off by itself: a host that refuses the option,
or rejects our device type, leaves the session running as traditional TN3270 rather
than failing. That is what makes on-by-default safe, and it is measured rather than
assumed — see *Verification*.

| Flag or prefix | Effect |
|---|---|
| *(none)* | offer TN3270E; fall back to base TN3270 if the host declines |
| `-tn3270e off` | never offer it; answer `IAC WONT TN3270E` |
| `-tn3270e on` | the default, stated explicitly |
| `N:host` | no TN3270E **for that host**, s3270's spelling |
| `LU@host` | request a specific LU by name |
| `LUA,LUB@host` | request each in turn as rejections come back |
| `-bind-image on\|off` | request the BIND-IMAGE function (default **on**); `off` means the gate below never closes, because it is conditional on the host having *agreed* the function |
| `-bind-limit on\|off` | range-check a BIND's geometry against `-model` before honouring it (default **on**, matching x3270's `bind_limit` resource, `Common/glue.c:458`); `off` honours an out-of-range BIND anyway |
| `-devname NAME` | offer telnet option 39 (NEW-ENVIRON) and answer a host's `DEVNAME` request with `NAME`. **Trailing `=` characters become a counter**: `foo===` yields `foo001`, `foo002`, … a fresh name per request, because a host refuses a name already in use. Absent, option 39 is **refused outright** — the feature is dark unless asked for |

The host argument's full shape is `[prefix:][LU,LU@]host[:port]`. In the CLI an LU list
must be **quoted** — `Connect("LUA,LUB@host")` — because the LU separator and the
action-argument separator are both commas; unquoted, s3270 itself answers `Connect()
requires 1 argument`, and so do we. Prefixes that would change what goes on the wire
but are not implemented (`A:`, `C:`, `P:`, `S:`, `T:`, `Y:`) are **refused by name**
rather than ignored, each pointing at the flag to use instead where there is one.

`N:` and an LU list belong to a *connection*, not to the process, so a CLI script may
connect to a plain host and then to a TN3270E one and be right about both.

**We ask for BIND-IMAGE, RESPONSES, SYSREQ and CONTENTION-RESOLUTION.** Grant
BIND-IMAGE and send no BIND, and real s3270 never enters 3270 mode at all: the
Erase/Write is delivered and silently ignored (x3270's `telnet.c:2339`, and the gate
at `:2681` that drops 3270 data until `tn3270e_bound`). That hazard is real and we do
not deny it — but 29 of 29 hosts in x3270's own trace collection that grant
BIND-IMAGE send a BIND in the same turn as FUNCTIONS (counted by bytes across all 71
traces, not by grepping decoded `< BIND` lines, which older traces do not carry), and
the advertise-then-stay-silent case exists only in our own `e-server.py`, which we
configured to do it. So we ask for the function and refuse to inherit the hang
instead: a 3270-DATA record that arrives before any BIND is **retained, not dropped**,
and a **5-second timeout** (`-bind-image` cannot change the duration, only whether the
gate exists at all) executes it at our own geometry if no BIND shows up. x3270 has no
such timeout and would simply sit there.

**Why 5 seconds and not one round-trip.** Every host in x3270's traces binds
immediately, so a much shorter deadline would satisfy all of them — but some of this
client's users are on real 370-class hardware (P/370s and similar), not an emulator,
and that hardware is slow and has no other working client. A short timeout would
punish exactly the users who can least afford it. The constant is `NO_BIND_TIMEOUT_MS`
in `packages/core/src/bind.ts` and is deliberately easy to find for anyone who needs it
longer.

**A BIND may resize the screen mid-session, and we honour it — geometry included.**
`-bind-limit on` (the default) range-checks a BIND's rows/cols against `-model` before
applying them, matching x3270's `bind_limit` resource: the upper bound is the
configured model, the lower bound is 24x80 (model 2). **On a model-2 session those two
bounds are the same number**, so a BIND asking for anything other than exactly 24x80 is
refused and our own geometry stands. **This is a safety rail, not a missing feature**:
with the limit on, BIND can only ever *narrow* a larger model toward 24x80, never grow
one past what `-model` configured — growing past the model is a separate, unbuilt
feature (`-oversize`)'s job, and letting BIND do it here would silently turn this
feature into that one. A user who sees a refused BIND while running `-model 3278-2`
has not found a bug; `-bind-limit off` honours the BIND's geometry anyway. UNBIND
reverts the screen to the model's own geometry, not to whatever the previous BIND left
it at.

CONTENTION-RESOLUTION (`0x05`) is not in RFC 2355 at all — x3270 requests it anyway,
and so do we.

### Naming a session with `-devname`

Some hosts identify a session by a **device name** rather than by an SNA LU, and ask for
it over telnet option 39, NEW-ENVIRON (RFC 1572), as a `DEVNAME` uservar. That is a
second, independent route to what TN3270E's `CONNECT` does with `LU@host` — different
hosts use different ones, and this client now does both.

```sh
node packages/tui/dist/main.js -insecure -devname 'foo===' HOST:PORT
```

**Trailing `=` characters become a counter, and that is the point of the feature.** A
host refuses a device name already in use, then asks again — so `foo===` offers `foo001`,
then `foo002`, then `foo003`, a fresh candidate per request, three digits wide. `foo=`
gives one digit and nine tries. A template with no `=` is a fixed name. The counter
**saturates rather than wrapping** once the digits are exhausted: re-offering a name the
host has already refused is the one thing this mechanism exists to avoid. All of that is
measured off x3270's own recorded traces rather than reasoned about — `devname_failure.trc`
shows `foo9` sent twice at the ceiling.

**Option 39 is refused outright unless `-devname` is given.** Without it we answer
`IAC WONT NEW-ENVIRON`, so nothing about an existing session's negotiation changes.

**What goes on the wire, and one privacy consequence to know about.** Asked for the
variables it knows, this client answers `USER`, `DEVNAME`, `IBMELF`, `IBMAPPLID` and
`CODEPAGE`. **`USER` is your local account name**, resolved from `$USER`, then `$USERNAME`,
then the literal `UNKNOWN`. x3270 sends it unconditionally and so do we, for
compatibility — but it only ever leaves the machine if you asked for option 39 in the
first place by passing `-devname`, and only to a host that asks for it. `IBMELF` is sent
as `YES` because x3270 sends it; **what it claims is genuinely undocumented** in x3270's
source, so we match the bytes without asserting a meaning. `CODEPAGE` is `037`, derived
from the code page actually in use rather than hardcoded.

A variable a host asks for and we do not have is answered with **the name and no value
byte at all**, which on the wire is distinguishable from a variable whose value is empty —
emitting an empty value would claim we have something we do not.

Two things worth knowing:

- **BINARY and EOR are implied by TN3270E, not negotiated** (RFC 2355 §4, confirmed on
  the wire). A client that requires them to be agreed the classic way would negotiate
  TN3270E perfectly and then discard every record.
- **The 5-byte header is data**, so a `0xff` in its SEQ-NUMBER must be IAC-doubled
  (§8.1.4). With RESPONSES agreed the counter advances, so that byte arrives after 255
  records — reachable in a long session, not theoretical.

**One deliberate difference from s3270, still an open question (found 2026-09-17).**
`-model 3278-2` makes us send the bare `IBM-3278-2` as the TN3270E DEVICE-TYPE. **s3270 sends
`IBM-3278-2-E` there whatever the model** — it appends `-E` unless extended data stream is
off or the `S:` prefix is used, so `-model` reaches only its TERMINAL-TYPE. RFC 2355 permits
both, and `-model 3278-2` meaning "not extended" arguably makes the bare form the more honest
one, so this is **recorded as a decision to make rather than a bug**; no host has been
observed caring. With no `-model` flag both clients send `IBM-3278-2-E`.

Design and every measurement:
`docs/superpowers/specs/2026-08-27-stage2b-tn3270e-design.md`.

## Using the CLI

The CLI reads s3270-style commands on stdin, one per line, and writes an
s3270-style status line plus `ok`/`error` after each. `#` comments and blank
lines are ignored.

```sh
printf 'Connect(127.0.0.1:3270)\nWait(3270Mode,20)\nWait(Settle,10)\nScreenText\nQuit\n' \
  | node packages/cli/dist/main.js -insecure
```

Or run a script file:

```sh
node packages/cli/dist/main.js -insecure < packages/cli/scripts/record-vm.txt
```

`Connect()` routes through the same TLS decision as the command line, so the flag goes
on the invocation and cannot be written into the script.

**Commands.** `Connect` `Disconnect` `Reconnect` `Quit` · `String` `Enter` `Clear` `PF` `PA`
`Attn` `Reset` `SysReq` · `Up` `Down` `Left` `Right` `Home` `Tab` `BackTab` `Newline`
`MoveCursor` · `BackSpace` `Delete` `Insert` `EraseEOF` `EraseInput` `Dup` `FieldMark` ·
`ScreenText` `ScreenJson` `Ascii` `Snap` · `Trace` `TraceText` `Replay` · `Transfer`
· `Wait`

**`Reconnect()` takes no argument and dials the last host again**, and it is the CLI's only route
to that: **`Enter()` here does NOT reconnect**, unlike the interactive front ends' Enter key,
because a script that types Enter into a dead session must not silently open a socket to a
mainframe. s3270 has the action under this name, so a script written for it works; both refusals
are s3270's own words — `Reconnect(): Already connected` and `Reconnect(): No previous host to
connect to`.

`Dup`, `FieldMark` and `SysReq` are conformance rather than symmetry: s3270 has all three by
these names (`Common/kybd.c:223`, `:230`, `:254`), so a script written for it should not fail
here. All three take no arguments — s3270's optional `FailOnError`/`NoFailOnError` on `Dup` and
`FieldMark` is refused by name rather than accepted and ignored, because failing on an operator
error already *is* s3270's behaviour for a scripted call. **`SysReq()` answers `ok` whatever
happens** — it reports no refusal, because the key exists on the keyboard whatever the host
granted. What it sends depends on the session: a four-byte test request read against a classic
host such as either Hercules system, Telnet `IAC AO` under TN3270E. There is no
command for the keypad toggle: a script-driven client has no renderer, which is why `-scheme` is
absent here too.

**`Transfer`** is `IND$FILE`, CUT mode, and it works on both hosts in both directions.
Two things that will otherwise cost you an afternoon: quote CMS file names, because the
argument splitter breaks on spaces (`HostFile="PROFILE EXEC A"`), and use
`-model 3278-2-E` — MECAFF's `IND$FILE` refuses a plain `IBM-3278-2` outright. See
`packages/cli/scripts/transfer-vm.txt`.

**`Wait(condition[,seconds])`** takes `3270Mode`, `Output`, `Unlock`, `Settle`,
or `InputField`. Which one you want is not obvious and gets hosts wrong in
practice — `Settle` is usually right on a connect-time screen, because a host may
send several records for one logical screen and may open on a fully protected
panel that `InputField` will wait out forever. `packages/cli/scripts/record-vm.txt`
documents a real case of this at length.

**A status line saying `ok` means the command was accepted, not that the host did
what you wanted.** Read the `ScreenText` output. A script of blind `Enter`s can
report `ok` throughout while silently failing a logon.

## Using the web gateway

```sh
npm run build
node packages/web/dist/main.js -insecure -model 3278-4-E HOST:PORT
```

It prints the URL to open. With the default (no token) that is just the address:

```
serving 127.0.0.1:3270 at http://127.0.0.1:8270/
```

and with `--auth on` the token is in it, once:

```
serving 127.0.0.1:3270 at http://127.0.0.1:8270/?t=4f3c...
```

The browser then draws the screen with the GUI's own renderer — literally the same file — over a
WebSocket instead of Electron's IPC. Frames are whole and deflated; measured, a 24x80
draw list is 237220 bytes of JSON and 6760 compressed, which is why dirty-cell diffing is
deliberately not part of the design.

**`Ctrl-K` (or `Alt-K`) shows the virtual keypad here too, and clicking a button is an ordinary
action** — the same message a keystroke sends, so **nothing about the protocol changed** to add
it. The flag is held **per connection**, not per session: a 3270 session deliberately outlives its
socket so a reload reattaches, and a keypad forced on whoever attaches next — possibly a different
person, whose screen would come back six rows taller than they left it — is not a preference worth
inheriting. A reattaching client therefore starts with the keypad hidden. A screen plus keypad
taller than the viewport **scrolls**, which is what the browser already did for a model 4.

**A browser pressing `Enter` on a disconnected session makes the GATEWAY redial the mainframe.**
That is the intended reading: the `Session` is server-side, so it is the server's own socket that
comes back, and the browser cannot name a host — the action carries no argument and the target is
the one the gateway was started with. The host, port and TLS decision are the server's throughout,
which is also why a client that reattaches to a session someone else started can only ever
reconnect it to the same place.

Its own options are double-dashed (`--listen`, `--bind`, `--grace`, `--allow-origin`,
`--tls-cert`); the client options it inherits keep s3270's single dash (`-insecure`,
`-cafile`, `-noverifycert`, `-verifycert`, `-model`, `-scheme`). **`--scheme` is refused as an
unknown flag** — that asymmetry is deliberate, since those flags mean the same thing in every
front end.

**It shares FEWER client flags than the other three, and refuses the rest by name rather than
ignoring them.** `--terminal-type` and `-tn3270e` are not accepted at all, so a gateway
session always offers TN3270E and takes its terminal type from `-model`. Of the host
argument's full `[prefix:][LU,LU@]host[:port]` shape it honours only `host:port`: an **LU
list** and the **`N:`** prefix are refused, because both are properties of one connection and
this serves many sessions from a single command line. `L:` is accepted, since TLS to the host
is already the default — but `L:` together with `-insecure` is refused as a silent
downgrade.

What makes it safe to run out of the box is the **loopback bind**, and the two things you
should change before widening it:

- **no token by default** — `--auth on` requires one. Anything that can reach the port can
  otherwise type at your mainframe, so binding wider without it is the combination the
  gateway warns about on startup;
- **plaintext unless you say otherwise** — without `--tls-cert` every keystroke, passwords
  included, crosses the network in the clear, and it says so too.

The two are not substitutes: TLS protects the traffic, the token protects access.

A cross-origin WebSocket upgrade is refused. Behind a reverse proxy that rewrites `Host`,
which is nginx's and Apache's default, name what the browser actually sees with
`--allow-origin` or every legitimate browser will be refused.

A session outlives its socket by `--grace` seconds (60 by default), so a reload or a wifi
handoff reattaches to the running 3270 session instead of dropping it. An id naming a session
someone else is currently attached to is refused a handover.

See `packages/web/README.md` for every flag and `docs/live-testing.md` under *The web gateway
against both hosts* for what was measured against VM/370 and MVS.

## Trace format

`Trace(on)` records the wire; `TraceText` emits it. Each line is
`<seconds>.<millis> <dir> <hex bytes>`, where `dir` is `<` received, `>` sent,
`=` a decoded note, and `+` a continuation of the previous record:

```
0.001 < ff fa 18 01 ff f0
0.001 > ff fa 18 00 49 42 4d 2d 33 32 37 38 2d 32 ff f0  # TERMINAL-TYPE IS IBM-3278-2
0.004 < f5 c2 11 5b 5f 1d 4d 13 12 5d 6b 11 5b 5f 1d c1
0.004 + 11 5d 6b 1d 60 d9 e4 d5 d5 c9 d5 c7 40 40 40 e5
0.004 = # EraseWrite WCC=0xc2 SBA(1759) SF(0x4d) IC ...
```

Traces replay as test fixtures (`packages/fixtures/traces/`) against golden
screens (`packages/fixtures/screens/`). Note this is **not** x3270's trace
format; `packages/core/src/x3270trace.ts` parses that separately for conformance
comparison.

**Traces contain typed passwords in EBCDIC.** Redact before committing anything
derived from a real session — procedure in `docs/live-testing.md`.

## Layout

```
packages/core      protocol: telnet framing, 3270 parse/execute, screen, keyboard, OIA,
                   colour resolution, Query Reply, IND$FILE, trace
packages/frontend  rules every front end shares: host argument, TLS flags, session
                   factory, keymap, action dispatch, binding intent, the keypad key table
packages/canvas    the canvas renderer, glyph atlas, keymap-to-action layer and the virtual
                   keypad's layout and hit-testing, shared by the GUI and the web gateway
packages/cli       s3270-style scripting CLI
packages/gui       Electron GUI: canvas renderer over a 3270 bitmap-font atlas
packages/tui       c3270-style terminal front end, plus the live/pty harnesses
packages/web       browser gateway: the same renderer, served over a WebSocket
packages/fixtures  recorded traces, golden screens, x3270 reference captures
docs/              spec, plans, live-host runbook, handoff
```

Start with `docs/HANDOFF.md`. The design spec is
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`, the stage-1 plan is
in `docs/superpowers/plans/`, and `docs/live-testing.md` is both the runbook for
recording against a real host and the log of what was found doing so.

## Staging

Done:

1. **Protocol core + s3270-style CLI.**
2. **Extended data stream + Query Reply** — configurable terminal type, five Query
   Reply units, SFE. This is what MVS/TSO requires, and it was reprioritised ahead of
   the GUI because MVS 3.8j is expected to be the largest group of users.
3. **`IND$FILE`** (CUT mode), both hosts, both directions.
4. **3279 colour and the TUI** — per-cell extended attributes, four-level colour
   resolution, terminfo-driven depth detection, and a c3270-style front end.
5. **TLS** — and it did jump the queue, for the reason earlier drafts of this section
   predicted: a 3270 client that cannot do TLS is unusable against anything modern.
   **On by default**, with `-cafile`, `-noverifycert` and `-insecure`; s3270's option
   spellings with its default inverted. Verified against both hosts through an in-repo
   TLS proxy, since neither Hercules system can speak it. Client certificates,
   `-accepthostname` and negotiated `START_TLS` are **not** done — see *What is not
   implemented*.

6. **TN3270E proper** — the telnet option (40), DEVICE-TYPE/FUNCTIONS subnegotiation,
   the data header, SNA responses, SYSREQ, device-name (LU) selection, and now
   BIND-IMAGE with BIND/UNBIND. Separated from item 2 deliberately: measurement shows
   TSO needs neither the option nor any of this, so bundling them would have delayed a
   working TSO session for no benefit. **Done, including BIND/UNBIND**, and it remains
   the stage with no *host* verification path for anything past DEVICE-TYPE — neither
   Hercules system offers the option, and the one public host that does withdraws it
   (its own fault: real s3270 is refused too) before FUNCTIONS. What stands in for a
   host is a **recorded** one: x3270's `playback -b` replays a real host's TN3270E
   negotiation including a real BIND, and our client is diffed against it byte for
   byte. See *TN3270E* and *Verification*.

7. **The Electron GUI** — done, and verified against both live hosts. Canvas renderer over
   an atlas baked from x3270's own bitmap font; the window sizes itself to whatever model
   the host negotiates. Not everything about it is live-verified, and the spec says so: PF
   and Clear travel the same path as typing but were not exercised live in this sandbox, and
   no VM logon has been attempted here — that arms VM's reconnect trap and could put a
   password in a screenshot. **An MVS TSO logon has been completed live, though**: through
   the GUI itself, by the user on their own Mac, at 43 rows; and separately in this sandbox
   as `HERC03`, over the CLI's identical AID wire path — which is what confirmed PA1 and PA2
   each get a real, distinct host reaction. See *Using the GUI*. **Both halves of the PA1/PA2
   gap are now closed**: the protocol half by those host reactions, and the local half first by
   hand (the author reported PA1 working from a real keypress against MVS on 2026-09-15) and
   then by `packages/gui/scripts/keys.mjs`, which drives 18 real Chromium chords and asserts 16
   ordered actions plus two required absences. What remains untested is only the *packaged* app,
   because there is no packaging yet.

8. **A webserver serving the same front end** over HTTP — done, and verified against both
   live hosts. `packages/web` serves the GUI's own canvas renderer to a browser over a
   WebSocket; the canvas layer moved to `packages/canvas`, which both front ends now share.
   That the renderer is genuinely shared rather than merely similar is checked in pixels
   against the Electron app's own screenshot golden. See *Using the web gateway*.

9. **A menu of special keys, and a show/hide virtual keypad** — done. Requested 2026-09-14 and
   moved ahead of Programmable Symbol Sets on 2026-09-15. `Ctrl-K` shows a clickable 47-button
   keypad in the Electron GUI and in a browser, and opens a keyboard-navigable list of the same
   keys in the TUI, which has no mouse. It brought canvas hit-testing with it, and made **Dup,
   Field Mark, Sys Req and Newline** reachable — four keys `core` could do and no interactive
   front end could press. Proven with real mouse events (`clicks.mjs`) and in pixels, identically
   in Electron and in the browser. **The mouse does keypad buttons and nothing else.** Text
   selection, click-to-place-cursor and the light pen are all still absent, and text selection is
   **not** the light pen: `lightpen_select()` sends an AID and sets MDT, so drag-to-select would
   transmit on every copy attempt. x3270 keeps the two apart deliberately. **Sys Req was
   reachable but inert on this branch until the classic path landed**; it now sends a test
   request read, still with no live witness — see *What is not implemented*.

Remaining, in the order the author wants it:

10. **Programmable Symbol Sets** — its hard dependency is item 2's Query Reply (the host
   sends no PS structured fields until the capability is advertised), not TN3270E as
   earlier drafts of the spec assumed. The GUI's blitter was built with this in mind: a PS
   glyph is a host-supplied bitmap, which is exactly what it already draws, so PS should be
   an addition rather than a second renderer.
11. Also on the roadmap, position not yet fixed: **packaging** for macOS and Linux, and
   **printer sessions**.

Alternate screen sizes and models 3, 4 and 5 are complete and live-verified, and were merged long
ago — an earlier version of this line said they were sitting unmerged on a branch, which stopped
being true on 2026-08-27. Adding screen sizes turned out not to be part of TN3270E at all — the
geometry rides in the terminal-type string — so it never depended on item 6.

### Graphics: the fidelity target, and why GDDM is not the route

The target is what a real 3279 could display, and the concrete reference is the
GIF viewing Rick Troth was doing on his own 3279 around 1992. **Provenance now
established from Troth himself**, which corrects earlier drafts of these docs:
the viewer was reached through **CMS Gopher** (his, Rice University, 1993 —
`troth@rice.edu`), but Gopher did not contain it. `GOPHER24 FILELIST` says so in
one line:

```
* To display GIFs with CMS Gopher, get the VMGIF package from BLEKUL11.
```

So CMS Gopher dispatched to a separate package, **VMGIF from BLEKUL11** (the VM
system at Katholieke Universiteit Leuven), via a `GOPCLIGV REXX` glue exec.
`GOPHERT GIF` in the archive is a test image, not the viewer. Local copies of
CMS Gopher 2.4.2 are in `$HOME/cmsgopher`; the `.tar.gz` pair yields only
`FILELIST` and `README`, `gop242s.vmarc` unpacks to service patches, and
`gopher24.vmarc` has not been unpacked (`:CFF` compressed members).

**VMGIF HAS SINCE BEEN FOUND — BUT AS OBJECT MODULES ONLY.** It is on disk at
`$HOME/vmgif`, dated April 1993: `VMGIF.MODULE.T1` at 84600 bytes, the wrapper execs,
`HELPCMS`, and `TONETABL` — its palette/dither table, which is the most directly useful
piece. **There is no source.** Disassembling it is probably unnecessary: decoding GIF
from the published spec is no harder than reverse-engineering a 1993 implementation once
PS can push pixels, so VMGIF is best treated as a *behavioural* reference — evidence of
what a 3279 could be made to do, and a palette to compare against.

**VMGIF used GDDM, and we will not.** IBM is sunsetting GDDM and would be
unlikely to license it even to a current paying VM customer, so the route for us
is **Programmable Symbol Sets driving the 3279 screen directly** — decomposing an
image into custom character cells and loading them, which is how the era's
viewers worked underneath anyway. GDDM would need those same primitives beneath
it, so nothing is wasted by starting there.

**A stretch goal, recorded because it is the natural end point:** an open-source
implementation of the GDDM spec targeting VM/370 R6 and MVS 3.8j. That would let
period-authentic graphics software run against these hosts rather than only our
own client. Unscheduled, and much larger than this project.

## What is not implemented

Stated plainly, because a 3270 emulator that quietly does three-quarters of the job is
worse than one that says which quarter is missing.

- **No client certificates.** TLS works (see *Connecting over TLS*), but only for
  authenticating the host. `-certfile`/`-keyfile`/`-clientcert`, `-accepthostname`,
  `-cadir`, DER files, protocol-version pinning and negotiated `START_TLS` are all
  unimplemented.
- **NEW-ENVIRON carries a device name and nothing else.** Option 39 is implemented (see
  *Naming a session with `-devname`*), but only for the variables a host has actually been
  recorded asking for: `USER`, `DEVNAME`, `IBMELF`, `IBMAPPLID` and `CODEPAGE`.
  **`CHARSET` and `KBDTYPE` are deliberately absent** — x3270 derives both from a `cgcsgid`
  this client does not model, and inventing values for them would put guesses on the wire.
  A host that sends a bare "send everything" request gets the five we have; four traces in
  x3270's collection do exactly that, so this is a real shape rather than a hypothetical.
  **We also do not send an unsolicited `INFO`**, which RFC 1572 permits and no recorded host
  uses.
- **TN3270E is implemented but NOT verified against a live host.** The option, the
  DEVICE-TYPE/FUNCTIONS subnegotiation, the 5-byte header, SNA responses, SYSREQ and LU
  names all work (see *TN3270E*) — against real s3270 and an in-repo TN3270E server,
  because **neither Hercules system offers the option at all**. Measured on both,
  accepting and refusing: each opens `IAC DO TERMINAL-TYPE` and never mentions option
  40. **A real host has now been tried, 2026-09-17 — public z/VM 4.4 at
  `evievm.pubvm.org:23` — and it got further without getting there.** It sends
  `IAC DO TN3270E` unprompted and asks for our device type, then answers our well-formed
  request with `IAC DONT TN3270E`, identically with and without the `-E` suffix; we fell
  back to base TN3270 and reached its logon screen. **So the offer and our backoff have a
  live witness and the negotiation does not.** ~~And whose fault the refusal is is
  unresolved — there is no s3270 on that machine to compare against.~~ **THE REFUSAL IS THE
  HOST'S FAULT, settled 2026-09-17: s3270 4.5ga6 was built on that machine and refused
  identically in all four recorded device-type variants, after sending a byte-identical request, and the host answers
  with no TN3270E subnegotiation at all where RFC 2355 §7.1.5 requires a `DEVICE-TYPE REJECT`.**
  **That EXONERATES our client on that one exchange; it does NOT verify our TN3270E** — the
  host abandons before FUNCTIONS for s3270 too, so FUNCTIONS, BIND and LU assignment remain
  unwitnessed by any *reachable* host. **No reachable host completes a TN3270E negotiation
  at all**, so the witness for FUNCTIONS, BIND-IMAGE and BIND is a *recorded* host instead:
  x3270's `playback -b` replaying `packages/fixtures/x3270/sscp-lu-data.trc`, a real host
  that grants BIND-IMAGE and sends a real BIND (PLU name `IBM0SMAA`, MaxSec-RU 1024,
  MaxPri-RU 3840, default 24x80, alternate 43x80). Bytes and next steps:
  `docs/live-testing.md`, *TN3270E against a real host*. What is still missing: a **printer
  session**, whose harness now exists, and a live UNBIND with `BIND_FORTHCOMING`, which no
  trace or reachable host has produced.

  **A HOST WITHDRAWING TN3270E IS HANDLED BOTH WAYS ROUND, and that took two fixes.** The
  correct byte is `IAC DONT TN3270E`, which a real z/VM 4.4 sends and which tears the
  negotiation down at both layers. Some real hosts send `IAC WONT TN3270E` instead — x3270
  carries a special case for them named, verbatim, *"Ugly hack for hosts that send WONT
  TN3270E instead of DONT TN3270E"* (`Common/telnet.c:1879-1889`) — and until `e789b4f` we
  answered that form with **nothing at all**, because option 40 is something *we* do and the
  handler only reacted to options the *host* does. Both now route through one teardown, and
  the second has a recorded-host witness in `wont-tn3270e.trc`.
- **The mouse does keypad buttons and NOTHING ELSE**, in both canvas front ends. A `mousedown`
  on a keypad button fires that button's action; a click anywhere else — on the screen, on a gap
  between buttons, or anywhere at all with the keypad hidden — is ignored. So there is **no
  click-to-place-cursor, no drag-to-select and no light pen**, and the right and middle buttons do
  nothing at all (deliberately: a right-click on `Clear` would otherwise send it to a live host
  while the context menu opened over the label). Mouse support is three separate jobs and only
  the first is built. Whoever takes the others: text selection is **not** the light pen, and must
  not be implemented with `lightpen_select()`, which sends an AID and sets MDT — drag-to-select
  would then transmit on every copy attempt. x3270 keeps them apart deliberately
  (`wc3270/screen.c:2357`).
- **SYS REQ IS IMPLEMENTED ON BOTH PATHS AND HAS NO LIVE WITNESS.** Implemented is not verified,
  and this entry is here for the second half. The keypad's `SysRq` button, the TUI overlay's entry
  and the CLI's `SysReq()` now all put bytes on the wire against VM/370 and MVS 3.8j — but nobody
  has yet driven the key at either host and watched what came back. On the next live run: see
  `docs/live-testing.md`.
  **It is not the AID you would expect.** Neither Hercules system offers TN3270E — both answer
  `IAC WILL TN3270E` with `ff fe 28` = DONT, measured three times — so both take the classic path,
  and x3270's classic branch does **not** send AID `0xf0`. `ctlr_read_modified` has a dedicated
  `case AID_SYSREQ /* test request */` (`Common/ctlr.c:770-777`) that emits a **four-byte TEST
  REQUEST READ heading** — `EBC_soh`, `EBC_percent`, `EBC_slash`, `EBC_stx`, i.e. `01 6c 61 02` —
  in place of the AID byte and cursor address. `AID.SYSREQ = 0xf0` exists in our `constants.ts`
  and is never what goes on the wire for this key. The modified field data **does** still follow
  the heading, which the phrase "four-byte record" invites you to get wrong: GA23-0059-07 says the
  stream is "the same as described previously for read-modified operations, excluding the 3-byte
  read heading (AID and cursor address)", and x3270's `break` leaves the switch rather than the
  function. There is no ETX; that is BSC framing, and a telnet record ends at `IAC EOR`.
  On an inhibited keyboard the key is **refused**, where x3270 would queue it — we have no action
  queue and did not invent one for a single key.
- **Dup, Field Mark, Sys Req and Newline have NO live witness.** All four are implemented; none has
  been pressed at a host. They are unit-tested against the
  manual and x3270's source, and the keypad's *plumbing* is proven by harnesses — but no host has
  ever been observed reacting to any of the four. The keypad as a whole needs no live verification,
  because a button press produces the same wire bytes as the equivalent keystroke and those *are*
  live-verified; that argument does not extend to four keys nothing ever pressed at a host.
- **The GUI is a first slice, not a finished app.** `packages/gui` renders live 3270
  screens from both Hercules systems and takes typed input (see *Verification*), but there
  is **no connect dialog, no menus and no preferences** — the host and
  every flag come from the command line, exactly as the TUI takes them. Packaging is also
  still to come, so there is no `.app` to download yet.
- **The web gateway is a first slice too, and shares fewer flags.** It renders live screens
  from both Hercules systems and takes typed input (see *Verification*), but like the GUI it has
  **no connect dialog, no menus and no preferences**. It also does **not**
  accept `--terminal-type` or `-tn3270e`, and of the host argument it honours only `host:port` —
  an LU list and `N:` are refused by name rather than ignored. A screen taller than the browser
  viewport **scrolls**; it does not reflow, and it will not scale fractionally, because integer
  scaling is a design rule. There is no session list or admin view: sessions are addressed only
  by the id the browser keeps in `sessionStorage`.
- **No Programmable Symbol Sets and no graphics.** `XA.CHARSET` (`0x43`) is parsed and
  deliberately dropped. `Cell` is already a tagged variant so that a renderer dispatches
  on `kind` rather than assuming a font lookup — that variant exists for nothing but PS.
- **MF orders are parsed, counted and not applied.** Modify Field would alter an
  existing field's attributes in place. TK5's ISPF sends **zero** of them, measured, so
  deferring it has cost nothing so far; `modifyFieldIgnored` in the parse result is how
  you find out if that changes.
- **No `IBM-DYNAMIC` and no oversize.** Models 2 through 5 work (see *Screen models*),
  but `IBM-DYNAMIC` — "ask me my size via Query Reply" — and x3270's arbitrary
  `-oversize` are not offered. Oversize is an emulator extension rather than 3270
  architecture, and it is the only case that crosses 4096 cells into 14-bit addressing,
  which `address.ts` already handles.
- **No mouse support** in the TUI. `Ctrl-K`'s special-keys list is the keyboard substitute for
  the canvas front ends' clickable keypad, not a step towards one.

The TUI has three limits worth knowing before you run it:

- **It needs at least 24 rows and 80 columns**, and refuses smaller rather than drawing
  a misleading partial screen. At exactly 24 rows it drops the status line and keeps the
  screen, which is what c3270 does. Given more room it centres the screen and draws a
  border.
- **Its cursor colour is best-effort.** OSC 12 is not universally implemented, so the
  shape is set via DECSCUSR as well; a terminal that ignores both still shows its own
  cursor.
- **The special-keys list's "terminal too small" refusal cannot be provoked**, and is documented
  that way rather than claimed as tested behaviour. The 24x80 floor above already refuses any
  smaller terminal before a session runs, and the smallest 3270 screen *is* 24x80 — so every
  terminal that can reach the list comfortably clears its 12x29 minimum. The check is a floor for
  a caller that hands the list a sub-window, not something an operator can hit.

## Verification

`npm test` and `npm run typecheck` are the fast gate; the interesting checks are the
ones against real systems, because most of the defects this project has found were only
visible there.

| check | result |
|---|---|
| `npm test` | **pass** — 1869 tests, 74 files (measured 2026-09-20 on `new-environ`) |
| `npm run typecheck`, `npm run build` | **pass** — silent |
| conformance vs a real x3270 capture | **pass** — 5 of 6 inbound records byte-identical, the sixth differing by design |
| `pty-smoke.py` (no host needed) | **pass** — 12/12, including that ECHO is restored after exit |
| `browser-shot.mjs` — served page vs the GUI's own goldens | **pass** — **2 of 2 cases** pixel-identical, with and without the keypad, which is what says the renderer is shared and not merely similar |
| `browser-keys.mjs` — real chords through a real browser | **pass** — 13 chords, 11 actions in order over a WebSocket, 2 asserted absences |
| `keys.mjs` — real Chromium key events in Electron | **pass** — 18 chords, 16 actions in order, 2 asserted absences |
| `clicks.mjs` — real mouse events at real keypad buttons | **pass** — 9 buttons clicked by label, 10 actions in order (the `Ctrl-K` toggle plus one per button). A bare `return` in the `mousedown` listener leaves the whole fast gate green while every button is dead; only this reddens |
| web gateway vs VM/370, live | **pass** — 42 of 43 rows agree with the CLI; the 43rd is the cursor, at exactly 9x3 ink pixels |
| web gateway vs MVS 3.8j TK5, live | **pass** — 24 of 24 rows agree |
| web gateway reattachment, live | **pass** — same session returned inside the grace window, a new one after it |
| TUI vs MVS 3.8j TK5, live | **pass** — ISPF menu, tutorial paged, clean `LOGOFF` |
| TUI vs VM/370, live | **pass** — CMS answers `QUERY DISK A`, CP reports `LOGOFF AT` |
| `IND$FILE` both hosts, both directions | **pass** — binary round-trips byte-identically |
| TLS vs both hosts, live | **pass** — verified chain via `-cafile` through the in-repo proxy; default TLS at a plaintext host fails in 10 s naming `-insecure` rather than hanging |
| model 4 (43×80) vs VM/370, live | **pass** — host sends `f5` (Erase/Write, 24×80) then `7e` (Erase/Write **Alternate**, 43×80); 41 fields, no program checks |
| GUI vs VM/370 and MVS 3.8j, live | **pass** — renders both; ink compared row-by-row against the CLI's own view of the same host (42/43 and 24/24, the one difference being the cursor); typed input proved end to end through real key events |
| GUI screenshot goldens under Xvfb | **pass** — **3 of 3 cases** from a replayed synthetic trace, reproducible across consecutive runs; raw-bitmap hash, not the PNG. (An earlier version of this row said "1 case" and was already two behind: the cases are the default scheme, the `green` scheme, and the keypad shown.) The keypad golden was **read off the image** before it was committed, cell by cell against the baked atlas — a golden cannot validate the baseline it came from |
| Dup, Field Mark, Sys Req, Newline vs a live host | **NOT DONE** — no host has been observed reacting to any of the four. Sys Req is no longer inert by construction (it sends a test request read against a classic host), so it is now worth trying: it is on `docs/live-testing.md`'s next-run list |
| TN3270E vs real s3270 + in-repo server | **pass, but NOT against a live host** — 10 configurations via `drive-e.py` (7 pre-existing plus 3 for BIND-IMAGE: a granted BIND-IMAGE followed by a size-code BIND, a granted BIND-IMAGE with no BIND — the only end-to-end exercise of the 5s timeout — and `-bind-image off` omitting the function from FUNCTIONS REQUEST). Our `DEVICE-TYPE REQUEST` is byte-identical to s3270's; `FUNCTIONS REQUEST` is now byte-identical too, BIND-IMAGE included |
| TN3270E vs **recorded real hosts**, via x3270's `playback -b` | **pass — 10 of 10 traces**, host-free, by `drive-playback.py`. Replays ten different real hosts (two commercial VTAM systems among them) and asserts our replies byte for byte: `WILL TN3270E`, `DEVICE-TYPE REQUEST` with the right model, `FUNCTIONS REQUEST` including BIND-IMAGE, and the full backoff where the host answers `WONT`. Mutation-verified — corrupting the device type or reversing the DEVICE-TYPE operand order reddens all six, and **that operand-order bug is one real s3270 accepts silently**. **Four of the six stop at FUNCTIONS** (a scripted keystroke this harness's short script never drives, or a BID reply we do not implement — see `docs/live-testing.md` for which reason applies to which trace), matching 3 blocks each. **Two get further, and both are new.** `sscp-lu-data.trc` reaches a **real BIND** — 4 blocks (3, 19, 11, 8 bytes), PLU name `IBM0SMAA` — giving BIND parsing its first real-host witness. `wont-tn3270e.trc` reaches **5 blocks** (3, 19, 11, 3, 3): its host withdraws TN3270E with `WONT` rather than `DONT`, and since `e789b4f` we answer `WONT` and fall back to classic TN3270 as real s3270 does, so that trace is the witness for **that** fix. It stops on a `wrongTerminalName` colour-digit divergence that is not our defect. **And since NEW-ENVIRON landed, FOUR MORE traces are drivable and each matches NINE blocks** — `devname_success.trc`, `devname_failure.trc`, `devname_change1.trc`, `devname_change2.trc` — further than every other case here, because option 39's per-request `DEVNAME` exchanges interleave with TN3270E's own steps. `devname_success.trc` was the trace this project originally wanted as its BIND witness and could not drive at all; it now reaches a real BIND with PLU `IBM0SMAJ`. **Mutation-verified to cover the iteration mechanism, not merely the negotiation:** disabling the device-name counter's increment reddens all four with values like `bar0` for `bar1` |
| TN3270E vs a real host (z/VM 4.4, `evievm.pubvm.org:23`), live | **PARTIAL, 2026-09-17 — and the refusal is the HOST's fault** — the host offers option 40 unprompted and sends `SEND DEVICE-TYPE` itself, then answers our request with `IAC DONT TN3270E`; **our backoff reached its logon screen, which is the first live witness for that path.** ~~With no s3270 available for comparison we cannot say which side is wrong.~~ **s3270 4.5ga6 was built here and refused identically in all four recorded device-type variants after a byte-identical request; the host sends no TN3270E subnegotiation at all where RFC 2355 §7.1.5 requires a `DEVICE-TYPE REJECT`. So our client is EXONERATED — and NOT verified:** the negotiation does not complete, so FUNCTIONS, responses and BIND remain untried against any host, and this host cannot try them |

Both Hercules systems are IPLed by hand by the author; `docs/live-testing.md` is both
the runbook and the log of what was found doing it, including the failures. That last
part is deliberate — the write-ups record six self-inflicted diagnostic mistakes, and
they are the most reusable thing in the file.

## License

MIT. See [LICENSE](LICENSE).

Note the reference material this project was built against is **not** covered by
that licence and is not redistributed here: IBM's GA23-0059 3270 Data Stream
Programmer's Reference, x3270 (Paul Mattes, BSD-3-Clause), tnz/zti, and the host-side
`IND$FILE` implementations. The `packages/fixtures/` captures are our own recordings
of traffic between this client and hosts the author runs locally.
