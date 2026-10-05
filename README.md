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
Reply, 3279 color, `IND$FILE` file transfer, TLS, screen models 2–5, TN3270E, a
c3270-style TUI, an Electron GUI and a browser gateway are all done, and everything but
TN3270E is verified against two live hosts — VM/370 and MVS 3.8j. (`IND$FILE` is reachable
from the **TUI and the GUI** as well as the CLI — `Ctrl-T` opens a transfer form in the TUI and a
transfer window in the GUI. The **browser** is the one front end that still cannot transfer, and
deliberately: see *What is not implemented*.)

**There are FOUR front ends**: the scripting CLI, the TUI, the Electron GUI, and the web
gateway, which serves the GUI's own renderer to a browser over a WebSocket.

**It is not yet something you can hand to someone else.** There is no packaging, so no
`.app` to download; the GUI has no connect dialog and no preferences, and takes its host on the
command line like the other front ends. It does now have a menu bar — Edit for copy and paste,
View for the keypad. The mouse presses keypad buttons and selects text for copying, and nothing
else: no click-to-place-cursor and no light pen. See *What is not implemented* below, which is
the honest part of this file.

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

**3279 color is real and proven on the wire, not just in unit tests.** TK5's ISPF
menu renders five distinct foreground colors where the base-attribute map can only
produce four — two of them (turquoise, neutral-white) come from the host's SA/SFE
extended attributes and would have been silently discarded before. The SA orders we
parse are **byte-for-byte identical to s3270's** on the same panel, checked as a
color-capable 3279.

**`IND$FILE` file transfer works on both hosts, in both directions, in BOTH PROTOCOLS**, with a
binary round-tripping byte-identically each way. **`Ctrl-T` opens a transfer form in the TUI and a
transfer window in the GUI**; the browser still cannot reach it. **The GUI's window has NOT been
driven against a live host** — see *Using the GUI* and `docs/live-testing.md`.

**DFT MODE WORKS, AND THE HOST CHOOSES IT — 2026-09-29.** Both engines are built for every
transfer and the first inbound frame decides, because the client does not select the protocol:
x3270's `ft_running` merely *reports* which one arrived (`ft.c:556`). **Live against MVS 3.8j
TK5 at 43x80: 11 DFT frames, zero CUT frames, 249 bytes byte-identical both directions.** That
geometry matters — **CUT needs a 24x80 screen and refuses anything else**, so a 43x80 transfer
is only possible over DFT, and until this landed a `-model 3278-4-E` session could not transfer
a file at all. The 24x80 requirement is still real but it is now raised **when CUT is chosen**
rather than before the host is asked, which is the one behavior change: a CUT-only host at
43x80 is primed before we find out, and VM/370's MECAFF refuses with its own text in about a
second. **DDM is advertised BY DEFAULT as of 2026-09-29**, so a DFT-capable host will choose
DFT; `-ddm off` restores the CUT-only behavior. See *Using the CLI*.

One honest limit remains: **`Lrecl` is silently ignored for `Recfm=V` on VM/CMS** — confirmed on
the wire 2026-09-24 by a three-case run where `RECFM V LRECL 80` and `RECFM V` alone are
indistinguishable while `RECFM F LRECL 80` differs, so the keyword demonstrably reaches
the host and CMS simply disregards it. TSO honors it as a *maximum* (`VB 1024` measured
through the form). So a `V 80` readback on CMS is not confirmation the field took effect,
and the field stays enabled because disabling it would make a real TSO attribute
unexpressible.

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

**There is a keypad of 48 buttons, two of which had no other way to be pressed.** `Ctrl-K` opens
it — PF1–PF24, PA1–PA3, and the special keys a PC keyboard has not got. In the **Electron GUI** it
is a separate window you can leave open beside the terminal; in a **browser** it is an opaque
overlay over the page, because a tab cannot open an OS window. Either way the buttons are **real
HTML controls** with tooltips naming what each key does, grouped under headings, and styled like a
native application rather than like a 3270.

**It was drawn into the canvas until 2026-10-06** — inverse-video blocks blitted through the
screen's own glyph atlas, as a third region of the draw list below the status line. That looked
like a 3270 and the author's verdict on it was *ugly*, and *modal in an annoying way*: it toggled,
and was awkward to leave up while working. A separate window is non-modal by construction, which
is the complaint answered structurally rather than tuned. The keypad **no longer grows the window
or scrolls the page**, since it is not part of the drawing at all.

Clicking a button fires exactly the action its label names. **`Sys Req` and `Newline` have no
keyboard chord in any front end**, so for those two the button is the only route there is; `Dup`
and `Field Mark` do have chords (`Ctrl-D`/`Ctrl-F`), so losing their buttons would cost the mouse
and not the keyboard.

The TUI has no mouse, so `Ctrl-K` there opens a **keyboard-navigable list** of the same 48 keys
instead — arrows move (`k`/`w` and `j`/`s` too), Enter fires, `Esc` closes — with each key's chord shown beside it, read
from the same binding table the keymap is checked against so the on-screen help cannot drift. Every
line is padded to one width, so the list is an opaque block rather than 48 ragged lines with the
host's screen showing through the chord column.

Four 3270 keys became reachable in the process, having been implemented in `core` with no way to
press them: **Dup** (`Ctrl-D`), **Field Mark** (`Ctrl-F`), **Sys Req** and **Newline**. The last
two get no chord — see *Using the TUI*. **Sys Req now puts bytes on the wire against a classic
host**, as a test request read heading (`01 6c 61 02`) followed by any modified field data, rather
than the AID you would expect. **All four are live-verified on both Hercules hosts** — Sys Req and
Dup as of 2026-09-21, Field Mark and Newline 2026-09-24 — but no *keypad button* has been
clicked at a host: the runs drove the CLI, which shares `applyAction` with the button but not the
click plumbing. See *What is not implemented*.

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
npm test           # 2253 tests, 89 files
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

### The keypad

**`Ctrl-K` opens the keypad window**, and `Alt-K` does the same — `Ctrl-K` is c3270's terminal
binding (`Common/fb-c3270:191`) and `Alt-K` is how its Windows keymap spells the same command, so
both are honored here rather than one being a divergence. **View → Keypad** does it too, which is
what makes the thing discoverable: a chord nothing on screen mentions is not an affordance. x3270
uses a keyboard icon in its own toolbar for the same purpose.

**It OPENS rather than toggling**, and the window's own close button closes it. That is deliberate:
the old in-canvas keypad toggled, and being hard to leave up was half the objection to it. Pressing
`Ctrl-K` again brings the window forward rather than stacking a second one.

**It is not remembered between runs.** x3270 does remember, through its `keypadOn` resource, and
this does not: reopening is one keystroke, and a keypad that reappears unbidden costs window space
to someone who did not want it this session. That is a decision rather than a missing feature, and
it is explicitly not on the list of things a preferences store should bring.

**Every button carries a tooltip** naming what the key does, from the same `BINDING_INTENT` table
the TUI's keypad list reads. 22 of the 48 keys have no prose entry there and 15 more have an entry
with no note, so the tooltip falls back to the key's short name — which means nothing is ever
blank, and no description had to be invented for a PF key whose meaning is the host's business.

### Copy and paste

**Drag across the screen to select, then copy from the Edit menu.** The accelerators are
**platform-split, and that is forced rather than stylistic: `Ctrl-C` is the Clear AID** and stays
Clear everywhere. So it is **`Cmd-C` / `Cmd-V` on macOS**, where `Cmd` is free, and
**`Ctrl-Shift-C` / `Ctrl-Shift-V` on Linux and Windows** — the convention gnome-terminal and VS
Code's terminal adopted for exactly this collision. "Ctrl-C copies when something is selected" was
considered and rejected: it makes a destructive AID conditional on invisible state, and its failure
mode is a missed Clear on a locked `MORE...` screen.

**Selection is RECTANGULAR**, not linear. A 3270 panel is columnar — datasets, LRECLs and option
lists sit in columns — so the common want is one column of a list without the labels either side,
and linear selection on a fixed grid has a question with no good answer: whether to include the
trailing spaces at the end of every row. x3270 selects rectangularly on a 3270 screen for the same
reason. **Trailing whitespace is trimmed per LINE**, which is what makes a copied column paste
usefully; interior spaces are kept, because they carry the panel's alignment.

**A non-display field contributes a SPACE, never its character.** Password fields cannot be copied
out, by construction rather than by convention — the check is mutation-verified in the test suite.

**Paste types the text in; it never presses Enter.** A newline in pasted text means *next field*,
not *submit* — which is what x3270's own paste does (`Common/kybd.c:3928`, where `\n` becomes
`Enter_action` only when **not** pasting). Quietly submitting a half-filled panel to a live host is
not a trade this makes. A form feed types a space, where outside a paste it would be Clear and would
wipe the screen; a carriage return is dropped, so CRLF text does not gain a stray character per
line. If a field fills up or refuses a character the paste stops and the status line says how much
got in.

**The selection is cleared by any keystroke that does something, and by every repaint from the
host** — a highlight over changed text would offer you a copy of something that is no longer there.

**The web gateway has NEITHER copy nor paste yet**, and refuses both. The reason is whose machine
the bytes are on: the gateway would extract the text onto its own filesystem, not yours, and
returning it to your browser needs a protocol message that does not exist yet. Both are committed
before packaging — see the roadmap. **Clicking a keypad button and selecting text are the only
things the mouse does**; the light pen is not implemented, and text selection is deliberately not
built on it (see *Remaining* for why that distinction matters).

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
so the host goes on the command line and there is no `.app` to double-click. **On the 3270 canvas the
mouse presses keypad buttons and does nothing else**: clicking the screen does not place the cursor,
dragging does not select text, and there is no light pen. (The *transfer* window is ordinary HTML, so
the mouse works normally there — that is a separate window, not the canvas.) **What is implemented
but not yet verified against a live host:** the PF and
Clear keys (they travel the same path as ordinary typing, which *is* verified end to end),
the `Ctrl-]` quit, the in-window error message for a failed connection, and **the whole transfer
window** — see *File transfer* above. **Attn is a
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
`ipcMain` — is guarded by `packages/gui/scripts/keys.mjs`, which sends **19 chords as real
Chromium key events and asserts the 17 actions that must arrive, in order, plus two that must
not** (`Ctrl+Z` and `F13`). **The nineteenth is `Ctrl+T`, and this list exists to have caught it and
did not**: the chord was dead — `canvas/src/keys.ts` had no `t` in its CTRL table — while the `Xfer`
keypad button opened the window fine, because the keypad route never goes through that table. The
harness only found it once the chord was added to the list. It is **not part of `npm test`** (it spawns Electron): run it by hand,
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

### File transfer (IND$FILE)

Press `Ctrl-T`, or click `Xfer` on the keypad, to open the transfer window. Choose a local
file with `Browse…`, name the host file, and press Start. `Direction=send` offers an Open panel;
`receive` offers a Save panel.

**It is a second `BrowserWindow` with real HTML controls, not a canvas view** — so inside it the
mouse and the keyboard behave as they do in any window, which is the whole reason it is not drawn on
the 3270 canvas. The canvas window's preload stays at four functions, so `renderer.ts` goes on being
shared with the browser gateway unchanged.

The host decides which protocol is used — CUT or DFT — and the window drives both, **reporting a
running byte count on each**. CUT reports per frame; DFT reports per accepted data frame, through
`Session`'s `transferProgress` event.

**THAT USED TO SAY DFT WAS SILENT BY DESIGN, AND IT WAS A BUG RATHER THAN A DESIGN.** `onProgress`
was reached only from the CUT frame handler, and the same gap meant nothing re-armed the 30-second
per-frame deadline during a DFT transfer — so **any DFT transfer longer than 30 seconds was killed by
a timer meant to detect a stalled CUT host**, with the doubly-misleading message `stalled: no CUT
frame from the host within 30s`. Found 2026-10-02 by a 200 KB live run; 249-byte files had always
finished inside the window. See `docs/live-testing.md`, *A 200 KB DFT transfer was killed by CUT's
stall detector*.

**While a transfer is running, the transfer window refuses its own close** — the red button and
`Cmd-W` are both prevented, the window is brought forward, and `Cancel` is left as the only enabled
control. Cancel tells the host to leave transfer mode rather than abandoning it mid-frame. **Two
other ways out do not refuse, they cancel**, and they must not be read as the same guard: quitting
the app (`Ctrl-]` or `Cmd-Q`) cancels a running transfer first and then quits, rather than becoming
unquittable; and closing the TERMINAL window destroys the transfer window with it, which also
cancels — Electron fires the child's `closed` **without** its `close`, so the refusal never runs on
that path and a separate hook does the cancelling. **If the session drops underneath**, the transfer
is cancelled too, so the window does not sit refusing every close on a dead session.

`Exist` is yours to set and the Save panel deliberately does not set it: `append` has no equivalent
in a file chooser, so the three-way choice (`keep`/`replace`/`append`) stays explicit. Canceling
either panel leaves whatever you had typed in the Local file field alone.

**NOT YET DRIVEN AGAINST A LIVE HOST.** The *protocol* is live-verified on both hosts in both
directions and in both modes (see *Verification*), and this window's Electron wiring is covered by
`packages/gui/scripts/transfer.mjs` — 10 checks, under Xvfb, in replay mode with the native dialog
**stubbed**, because a real modal under Xvfb has nobody to click it. The four close/cancel paths
described above were each driven by hand under Xvfb with a **fake** transfer, which proves `cancel`
is reached on each and nothing about the bytes it then sends. **BOTH OF THOSE GAPS ARE NOW CLOSED, 2026-10-02.** A real transfer through this front end is
live-verified against VM/CMS -- 249 bytes both directions, byte-identical, reproduced twice
(`packages/gui/scripts/live-transfer.py vm`) -- and **the user verified the native dialog on macOS by
hand, in ASCII mode**, which no scripted run here has ever used. Both logs and the four remaining
open items are in `docs/live-testing.md` — *The transfer window's four teardown paths* for what was
driven with a fake transfer, and *The GUI transfer window* for the live results. **Still open there:
TSO/DFT from any platform**, the close guard against a transfer actually in flight, and the progress
line against real byte counts.

## Using the TUI

```sh
node packages/tui/dist/main.js [-model M] [--terminal-type T] [--colors N] [-scheme S] \
    [-insecure] [-noverifycert] [-cafile FILE] host[:port]
```

`-model 3278-2-E` is usually what you want: TSO rejects a plain `IBM-3278-2`. Port
defaults to 23. Models 2–5 are accepted, with or without `-E`; see *Screen models*.
`--colors` takes `0|8|16|256|16m|auto`, where `auto` asks terminfo and
`0` is monochrome because you said so — the distinction matters, since it is how the
monochrome path gets tested on a color terminal.

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
rather than sending their AID — see *Using the GUI* for the whole rule; the behavior is shared
code and identical in all three interactive front ends.

**`Ctrl-D` is Dup and `Ctrl-F` is Field Mark**, both c3270's own bindings
(`Common/fb-c3270:186-187`). Dup writes EBCDIC `0x1C` and then TABs — the manual's own wording,
p. 7-12 — and Field Mark writes `0x1E` and advances like a typed character; a numeric field takes
Dup and refuses Field Mark (manual p. 4-13).

**`Ctrl-K` opens the special-keys list.** A terminal has no mouse, so this is the TUI's answer to
the canvas front ends' keypad: the same 48 keys as a scrolling list over the top-left of the
screen, arrows to move, `Enter` to fire the marked key, `Esc` or `Ctrl-K` again to close. `Ctrl-K`
is c3270's own binding for its keypad (`Common/fb-c3270:191`), not a divergence. While the list is
open **it owns the keyboard** — nothing falls through to the field behind it — and the window
follows the selection rather than showing only the first screenful, or everything past `Attention`
(**Sys Req** and **Newline** included) would be unreachable. That is the point of the list: those
two are the keys with no chord anywhere, and this is their only keyboard route. Each line shows
the key's chord where it has one, read from the same `BINDING_INTENT` table the keymap is checked
against, so 22 of the 48 correctly show a blank rather than a guess.

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

**`Ctrl-T` opens the file-transfer form**, which is the TUI's answer to the same problem the list
solves for keys: `IND$FILE` needs arguments, so it needs somewhere to type them. Ten fields —
direction, host dialect, the two file names, mode, exist, and the four record attributes — with
`Tab` and `Shift-Tab` to move, left and right to change a cycle field, `Enter` to start and `Esc`
to close. **It owns the keyboard exactly as the keypad list does, and that is what makes the text
fields possible at all**: a printable byte is data typed at the host everywhere else, so a filename
could not be entered without the interception. The two overlays are **mutually exclusive** — either
key closes the other — because two things owning the keyboard is a state the operator cannot read.
**Inapplicable fields are not drawn**: `Recfm` only on a send, `Lrecl` only once `Recfm` is set,
`Blksize` not on VM, `Cr` only in ascii mode — and a value that becomes inapplicable is **cleared**
rather than kept invisibly, since a hidden value that breaks a later submit names a keyword the
operator never typed. **The form never validates.** It collects strings and hands them to the same
`parseTransferKeywords` the CLI uses, so a refusal shows the validator's own message with the form
still open and nothing retyped; a form and a script cannot drift on what is legal.
**`Esc` mid-transfer ABORTS** — `CutTransfer.cancel` writes the response area and presses PF2, so
the host leaves transfer mode rather than waiting for a frame that will never come.

**Colors come from one shared table in `packages/frontend`, and `-scheme` picks which.**
`default` is the readable one — zti's own values for F0–F7 (eight codes), x3270's for the
rest — and it is what every front end draws unless told otherwise. `3279` is
core's own saturated table: **our own choice of primaries, not a phosphor measurement** —
the manual names each color without fixing its chromaticity, and a real 3279 matched
neither this table nor x3270's — kept because someone comparing against the architected
meaning may want the unambiguous version. `x3270` is that emulator's own `rgbmap`, for
comparing against it. `green` is a monochrome 3278, **the only one of the four with any
claim to authenticity**, because a 3278 had no color at all — color was a 3279 feature —
and `greenscreen` is accepted as an alias for it, x3270's own spelling. Quantisation to 16
colors is an explicit per-scheme table rather than nearest-RGB: with any pleasant palette,
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
| `-bind-limit on\|off` | range-check a BIND's geometry against `-model` before honoring it (default **on**, matching x3270's `bind_limit` resource, `Common/glue.c:458`); `off` honors an out-of-range BIND anyway |
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

**A BIND may resize the screen mid-session, and we honor it — geometry included.**
`-bind-limit on` (the default) range-checks a BIND's rows/cols against `-model` before
applying them, matching x3270's `bind_limit` resource: the upper bound is the
configured model, the lower bound is 24x80 (model 2). **On a model-2 session those two
bounds are the same number**, so a BIND asking for anything other than exactly 24x80 is
refused and our own geometry stands. **This is a safety rail, not a missing feature**:
with the limit on, BIND can only ever *narrow* a larger model toward 24x80, never grow
one past what `-model` configured — growing past the model is a separate, unbuilt
feature (`-oversize`)'s job, and letting BIND do it here would silently turn this
feature into that one. A user who sees a refused BIND while running `-model 3278-2`
has not found a bug; `-bind-limit off` honors the BIND's geometry anyway. UNBIND
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
first place by passing `-devname`, and only to a host that asks for it. `CODEPAGE` is
`037`, derived from the code page actually in use rather than hardcoded.

**`IBMELF: YES` advertises the Express Logon Feature, and we cannot currently honor
it.** ELF replaces an interactive logon with a **client certificate**: the host's TN3270
server validates it, obtains a passticket, and logs you on without a userid or password
crossing the network. IBM is explicit that the session "must be configured for SSL with
client authentication" for it to work — so a client certificate is a prerequisite, and
**this client has no client-certificate support at all** (see *What is not implemented*).
A host acting on our `YES` would ask for a certificate we cannot produce. We send it
because x3270 sends it unconditionally and a host keying off its presence should see the
same bytes from both — but **no host has been tried**, because none reachable from here
implements ELF. `IBMAPPLID` is ELF's other half, the application ID; we send `None`,
which is consistent with not supporting it. If client certificates are ever built, these
two variables are what make ELF reachable.

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
error already *is* s3270's behavior for a scripted call. **`SysReq()` answers `ok` whatever
happens** — it reports no refusal, because the key exists on the keyboard whatever the host
granted. What it sends depends on the session: a test request read heading plus any modified field
data against a classic host such as either Hercules system, Telnet `IAC AO` under TN3270E. There is no
command for the keypad toggle: a script-driven client has no renderer, which is why `-scheme` is
absent here too.

**`Transfer`** is `IND$FILE`, and it works on both hosts in both directions and in both protocols —
the host chooses CUT or DFT.
**The TUI and the GUI reach it too, through `Ctrl-T`** — the same validator and the same command
builder, so a form, a window and a script cannot disagree about what is legal. The browser is the
one front end that cannot; see *What is not implemented*.
Two things that will otherwise cost you an afternoon: quote CMS file names, because the
argument splitter breaks on spaces (`HostFile="PROFILE EXEC A"`), and use
`-model 3278-2-E` — MECAFF's `IND$FILE` refuses a plain `IBM-3278-2` outright. See
`packages/cli/scripts/transfer-vm.txt`.

**`-ddm on` IS HOW YOU GET DFT, AND IT IS NOW SAFE TO PASS WHILE TRANSFERRING A FILE.** Earlier
versions of this README said the opposite — "do not pass `-ddm on` while transferring a file",
because a host that took the offer sent `Open` requests we could not parse and both directions
timed out at 0 bytes. **That is fixed as of 2026-09-29**: DFT is implemented and the transfer
drivers build both engines, so whichever protocol the host chooses is handled. The flag advertises
the Query Reply (DDM) unit, QCODE `0x95`, and **the client does not choose CUT or DFT — the host
does**, on seeing that unit.

| Flag | Effect |
|---|---|
| *(none)* | **the default as of 2026-09-29: DDM IS advertised**, so a DFT-capable host chooses DFT |
| `-ddm off` | advertise nothing, so every host falls back to CUT — how pre-2026-09-29 CUT runs reproduce |
| `-ddm on` | advertise DDM, QCODE `0x95`, built to match x3270's `do_qr_ddm` (`sf.c:899-906`). **A host may then answer in DFT, which now works** — and is the only way to transfer at a geometry other than 24x80 |

**THE DEFAULT FLIPPED ON 2026-09-29, which was always the plan and is the user's call.** It shipped
off on 2026-09-24 because DFT did not work yet — advertising it made a host offer a protocol we could
not parse, so every transfer would have broken. DFT now works and is live-verified, so the flag has
done its job as a measurement instrument and DFT is the better default: it is faster, and it is the
only protocol that works at a geometry other than 24x80.

**What that costs, stated plainly: the CUT path gets less live exercise than it did**, because a
DFT-capable host will now pick DFT. CUT is still fully implemented and is still the only option
against a CUT-only host such as VM/370's MECAFF. **`-ddm off` restores the old behavior exactly**,
which is what keeps every pre-flip CUT measurement in `docs/live-testing.md` reproducible — and there
is a test pinning that, because if it ever broke, that evidence would become unverifiable rather than
merely old.

The advertised LIMIN/LIMOUT default to 16384, bounded 256..32767, and **`Transfer(BufferSize=N)`
sets them** — clamped by `boundDftBufferSize` after x3270's `ft_dft.c:740-747`.

**IT IS ONE NUMBER: the size advertised to the host and the size we chunk by are the same value,
read from the in-flight transfer.** That is x3270's design too — `do_qr_ddm` takes
`ftc->dft_buffersize` from the running transfer and falls back to the default only when none is
running (`sf.c:890-897`). It matters because **the host sizes its side from what we advertise**,
measured live on TK5: `BufferSize=512` moved MVS's own `Open` record size to **495** (= 512 − 17,
the DFT frame overhead) while un-keyworded transfers in the same session stayed at 16367. Before
this was wired the two could differ by 32× — advertising 512 while chunking by 16384.

`BufferSize` is the one transfer keyword that **never reaches the `IND$FILE` command**: it sizes our
frames, not the host's dataset, so unlike `Recfm`/`Lrecl`/`Blksize` it is legal on a receive and on
VM. It is CLI-only — the TUI form has no field for it, deliberately, because the form's width is
derived from its field labels and a longer one would shift the status line's 54-column budget.
`SessionOptions.dftBufferSize` remains the programmatic default and is still reachable from no flag.

The unit is inserted in ascending-QCODE order rather than appended, so a capture stays
comparable with x3270's. The flag exists because it is what *measured* which hosts offer DFT:
MVS/TSO does and VM/370's MECAFF does not, which was invisible until we sent the unit at all.
Design and wire bytes: `docs/superpowers/specs/2026-09-24-dft-file-transfer-design.md`; the
protocol-selection design is
`docs/superpowers/specs/2026-09-25-transfer-protocol-selection-design.md`.

**The advertisement's own evidence is still a live probe rather than a unit test.** `-ddm` has no
test that pins its bytes directly; what covers it is `dftSession.test.ts`'s
*the DDM advertisement through a Session* suite, which drives a real Read Partition and asserts
`0x95` is on the wire with the flag on and absent with it off — added later than the flag itself.
**And it is witnessed live**: the 2026-09-29 TK5 run shows `00 0c 81 95` in answer to the host's
own `ReadPartition`. Note that **a host may issue no Query at all** — VM did not on that day's
control run — so check `grep -c "81 95"` in a trace before reading it as evidence about DDM.

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

**`Ctrl-K` (or `Alt-K`) opens the keypad here too, as an OPAQUE OVERLAY over the page** — a browser
tab cannot open an OS window the way the Electron GUI does, so the pane is what it has. Opaque
rather than translucent on purpose: the TUI's keypad overlay once let host text leak through into
its chord column, and reading 48 buttons over a 3270 screen is the same problem waiting to happen.
A `Close` button dismisses it, and so does `Ctrl-K` again.

**Clicking a button is an ordinary action** — the same message a keystroke sends, so **nothing
about the protocol changed** to add it. The keypad itself is now **entirely client-side**: the
toggle never reaches the gateway, which holds no keypad state at all. It used to be a region of the
draw list the server built, with a flag held **per connection** rather than per session — because a
3270 session deliberately outlives its socket, so a keypad forced on whoever attaches next,
possibly a different person, is not a preference worth inheriting. That reasoning survived the
move: the overlay starts hidden on every page load, which is the same rule one layer up.

**The screen no longer grows when the keypad opens**, since the overlay floats over it rather than
being appended below. A model 4 taller than the viewport still scrolls, as it always did.

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
argument's full `[prefix:][LU,LU@]host[:port]` shape it honors only `host:port`: an **LU
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
                   color resolution, Query Reply, IND$FILE, trace
packages/frontend  rules every front end shares: host argument, TLS flags, session
                   factory, keymap, action dispatch, binding intent, the keypad key table
packages/canvas    the canvas renderer, glyph atlas, keymap-to-action layer and the virtual
                   keypad's layout and hit-testing, shared by the GUI and the web gateway
packages/cli       s3270-style scripting CLI
packages/gui       Electron GUI: canvas renderer over a 3270 bitmap-font atlas, plus a second
                   HTML BrowserWindow for IND$FILE transfers (its own preload and boot module)
packages/tui       c3270-style terminal front end, plus the live/pty harnesses
packages/web       browser gateway: the same renderer, served over a WebSocket
packages/fixtures  recorded traces, golden screens, x3270 reference captures
docs/              spec, plans, live-host runbook, handoff
```

Start with `docs/HANDOFF.md`. The design spec is
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`, the stage-1 plan is
in `docs/superpowers/plans/`, and `docs/live-testing.md` is both the runbook for
recording against a real host and the log of what was found doing so.

**Spelling is US English** throughout — identifiers, comments and docs. **Three exceptions are
deliberate, and each one looks like something a sweep missed:**

- **`Color.GREY` and `COLOR_NAMES[0xfe] = 'grey'`.** `grey` is x3270's own canonical spelling:
  `Common/glue.c:1041-1042` lists `{"Grey", HOST_COLOR_GREY}` and then `{"Gray", ...}` marked
  `/* alias */` in x3270's own comment, and `see.c` and `fprint_screen.c` both emit `grey`. These
  names are an interface to the implementation this client is conformance-tested against, so
  matching it beats internal consistency. `packages/core/src/palette.ts` carries the full note.
- **`licence` where it refers to IBM's licence for GA23-0059** — quoted external wording.
- **`colour` inside `packages/fixtures/**/*.trace` header comments** — those files are recorded
  evidence, carrying their own regeneration command, and editing prose inside a capture is churn.

## Staging

Done:

1. **Protocol core + s3270-style CLI.**
2. **Extended data stream + Query Reply** — configurable terminal type, five Query
   Reply units, SFE. This is what MVS/TSO requires, and it was reprioritised ahead of
   the GUI because MVS 3.8j is expected to be the largest group of users.
3. **`IND$FILE`** (CUT mode), both hosts, both directions.
4. **3279 color and the TUI** — per-cell extended attributes, four-level color
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
   then by `packages/gui/scripts/keys.mjs`, which drives 19 real Chromium chords and asserts 17
   ordered actions plus two required absences. What remains untested is only the *packaged* app,
   because there is no packaging yet.

8. **A webserver serving the same front end** over HTTP — done, and verified against both
   live hosts. `packages/web` serves the GUI's own canvas renderer to a browser over a
   WebSocket; the canvas layer moved to `packages/canvas`, which both front ends now share.
   That the renderer is genuinely shared rather than merely similar is checked in pixels
   against the Electron app's own screenshot golden. See *Using the web gateway*.

9. **A menu of special keys, and a show/hide virtual keypad** — done. Requested 2026-09-14 and
   moved ahead of Programmable Symbol Sets on 2026-09-15. `Ctrl-K` shows a clickable 48-button
   keypad in the Electron GUI and in a browser, and opens a keyboard-navigable list of the same
   keys in the TUI, which has no mouse. It brought canvas hit-testing with it, and made **Dup,
   Field Mark, Sys Req and Newline** reachable — four keys `core` could do and no interactive
   front end could press. Proven with real mouse events (`clicks.mjs`) and in pixels, identically
   in Electron and in the browser. **THE CANVAS KEYPAD THIS DESCRIBES WAS REPLACED ON 2026-10-06**
   by real HTML controls in both front ends, and the canvas hit-testing it brought was deleted
   with it — the author's verdict on the drawn version was *ugly* and *modal*. The 48 keys, their
   actions and the TUI's list are unchanged; `clicks.mjs` still proves nine of them by label, now
   through DOM clicks. The pixel half of that proof is gone, because HTML in system fonts is not
   reproducible the way a blitted atlas is. At the time this was written the mouse did keypad buttons and
   nothing else; **drag-to-select landed later, for the GUI's copy and paste** (see *Using the
   GUI*). **Click-to-place-cursor and the light pen are still absent**, and text selection is
   **not** the light pen: `lightpen_select()` sends an AID and sets MDT, so a selection built on it
   would transmit on every copy attempt. x3270 keeps the two apart deliberately, and so does this
   implementation — the selection path sends no AID at all. **Sys Req was
   reachable but inert on this branch until the classic path landed**; it now sends a test
   request read, **live-verified on both hosts 2026-09-21** — see *What is not implemented*.

Remaining, in the order the author wants it.

**REORDERED AGAIN 2026-10-05: GUI COPY AND PASTE went first of all of these, ahead of the GUI
keypad window — and is now BUILT** (see *Using the GUI*; the live paste against a real host is the
one piece still unwitnessed). It is a fifth UI item rather than one of the four below:
`docs/superpowers/specs/2026-10-05-gui-copy-paste-design.md` and
`docs/superpowers/plans/2026-10-05-gui-copy-paste.md`. The reason is the user's experience of the
shipped GUI — *neither copying text out of the window nor pasting into it was possible*, which is a
**behaves-like-a-normal-application** gap and so belongs before packaging, on the same argument that
put packaging ahead of graphics. The keypad window is a restyle of something that already works;
this is absent capability. **Text selection here is NOT the light pen** — that distinction is spelled
out two paragraphs above and is why the light pen keeps its own later spec.

**AND THE WEB GATEWAY REACHES PARITY BEFORE PACKAGING, decided by the user the same day:** **web
copy/paste** and the **web transfer form** are both required before any packaging work. Web copy
needs its own spec rather than coming along with the GUI's — a claim the GUI's spec made and
implementation disproved. `sendAction` crossing the WebSocket transmits the *action* for free, but
nothing can return the *text*: the server's only messages to a browser are `frame` and `error`, the
bridge has no clipboard function, and the browser's renderer holds a draw list whose cells carry an
atlas glyph and no character — so the gateway would extract the text onto its own machine rather than
the operator's. Until that lands the gateway **refuses** `copy` at decode, and the refusal is
load-bearing: without it the first browser copy would end the gateway process and every session on
it.

**REORDERED 2026-09-30: the four remaining UI pieces come FIRST, ahead of oversize and everything
after it.** Two features across the two canvas front ends — ~~the GUI transfer UI~~ (**BUILT
2026-10-01**), ~~the GUI keypad window~~ (**BUILT 2026-10-06, and it took the WEB keypad with
it**), then **the web transfer UI**, so one of the original four remains. They were grouped
deliberately rather than by coincidence: the shared halves already exist in `packages/frontend`
(`transferForm.ts` and `transferRun.ts` for transfers, `keypad.ts` for the key table), so doing
them consecutively means the GUI's answer is still in hand when the browser's is written.

**AND THAT GROUPING PAID OFF MORE THAN EXPECTED ON THE KEYPAD: the two front ends landed in ONE
change rather than two.** The plan had the web following later, which is what the idea doc assumed
too — but once the keypad was real HTML controls, the view itself (`keypadUi.ts`) was shared
outright, and the only thing that differed was the container: a window in Electron, an overlay in
the browser. Doing the second front end separately would have meant building that view twice or
extracting it afterwards. The flip side is that the canvas keypad ended up with **no** consumers
rather than one, so it was deleted rather than left for the gateway.

Interleaving these with oversize would have meant deciding twice what a native-window front end
looks like. It also settled everything the **menu bar** touches — the keypad needed one, and so
does the connect dialog — before packaging puts that chrome in front of a first-time user. Items
11 onward keep the order agreed on 2026-09-29.


9a. **Interactive `IND$FILE` — stages 1, 2 and 3 of four are DONE.** The transfer itself was finished and
   live-verified long before any interactive front end could reach it, which is the same shape as
   Sys Req and Newline before item 9. **Stage 1, the TUI's `Ctrl-T` form, is built** — see
   *Using the TUI*. **STAGE 2, DFT, IS DONE AND LIVE — 2026-09-29.** It matters because it is
   **geometry-free**: `ft_dft.c` contains zero screen-buffer references against 25 in `ft_cut.c`, so
   it moves data through structured fields rather than the display, and it is what lifts the 24x80
   restriction CUT imposes. **Measured on MVS 3.8j TK5 at 43x80: 11 DFT frames, zero CUT frames, 249
   bytes byte-identical both directions.** The last piece was not the engine but the *selection* —
   nothing chose DFT, so `startDftTransfer` had no caller outside tests; both drivers now build both
   engines and the first inbound frame decides, because the host chooses and not the client.
   **MVS/TSO DOES offer DFT, measured 2026-09-24** — an earlier version of this line said neither
   Hercules host spoke it. What was really missing was on *our* side: a host offers DFT only to a
   client that advertised the Query Reply (DDM) unit, and we had never sent one. See `-ddm` under
   *Using the CLI* and the wire bytes in `docs/live-testing.md`. VM/370's MECAFF declines it and
   stays on CUT, which makes it the control. **Stage 2 is now COMPLETE**: `Transfer(BufferSize=N)`
   sets the DFT frame size, and it is the SAME number advertised in the DDM Query Reply — verified
   live, `BufferSize=512` moving the host's own `Open` record size to 495.
   **STAGE 3, THE GUI's TRANSFER WINDOW, IS BUILT — 2026-10-01**:
   `docs/superpowers/specs/2026-09-30-gui-transfer-ui-design.md` and
   `docs/superpowers/plans/2026-09-30-gui-transfer-ui.md` (ten tasks, all executed). It was a
   renderer rather than
   a rewrite — the model and the driver were already shared in `packages/frontend`, and the `Xfer`
   keypad button already existed — but **not a CANVAS renderer**, which earlier drafts of this line
   assumed. The user's decision was a **separate `BrowserWindow` with real HTML controls** and a
   native file dialog for the local file: the canvas preload has to stay at four functions for
   `renderer.ts` to keep being shared with the browser, and teaching a canvas text editing, focus and
   a file chooser buys nothing. x3270 puts its own transfer dialog in Xaw widgets for the same reason.
   **Stage 3's live verification LANDED 2026-10-02**: VM/CMS drove the window for real (249 bytes
   both ways, byte-identical, twice) and the user verified the macOS dialog by hand in ASCII mode.
   **TSO/DFT is still unrun.** The work also found that **`Ctrl-T` in the GUI was DEAD** — mapped in
   `frontend` and absent from `canvas/src/keys.ts`, so the chord did nothing while the keypad button
   worked, which is why `keys.mjs` now drives it.
   **Stage 4** is the web gateway, and it is a security decision before it is a UI one: the gateway
   still **refuses** the action, because a browser-initiated transfer would move bytes to the
   gateway's filesystem and not the operator's — **and the refusal message now says that**, where it
   used to blame a missing front end. **The decided answer is real browser file I/O** —
   bytes over the WebSocket, so "local file" means the operator's machine — which is a new protocol
   message pair, chunking and a `TransferFiles` over the socket, and therefore its own spec.
10. **Programmable Symbol Sets** — its hard dependency is item 2's Query Reply (the host
   sends no PS structured fields until the capability is advertised), not TN3270E as
   earlier drafts of the spec assumed. The GUI's blitter was built with this in mind: a PS
   glyph is a host-supplied bitmap, which is exactly what it already draws, so PS should be
   an addition rather than a second renderer.
**THE ORDER HERE IS THE USER'S, 2026-09-29, AND THE REASONING IS WORTH KEEPING.** Packaging came
ahead of all graphics work because *without graphics this is still a useful tool, but without
packaging it is a hard one to RUN*. Then oversize moved ahead of packaging in turn, so that **strange
screen sizes are available in the first packaged build a user ever sees** — a shipped app that cannot
do the geometry an operator's host asks for is a worse first impression than a shipped app with no
vector graphics.

**And printer sessions moved BACK, behind graphics, for a reason the research already supports:
GDDM drives printers and plotters as output devices, so the printing work is likely CONVOLVED with
vector graphics rather than independent of it.** `docs/goca-reference-notes.md` says the same thing
from the other side: the primary GOCA reference is the **AFP edition, bound to MO:DCA and IPDS —
printers** — and the 3270 binding is what diverges from it. Doing printers first would mean building
an SCS/3287 path and then revisiting it once GOCA lands; doing graphics first means the printer work
can reuse whatever the drawing layer turns out to be. **Cheap is not the same as first.**

11. **Oversize + `IBM-DYNAMIC`.** Really oversize — the advertisement is a by-product. See the
   out-of-scope section of the bind-image spec for the measurements.
12. **Local model-switching**, immediately after it and before packaging. The two belong together:
   both let the *user* do unpredictable things with their window, and in the code both drive the one
   `Screen.resize()` path — which today has four callers, all in `core` and all HOST-driven (EW/EWA
   and BIND/UNBIND). These two add the first CLIENT-driven resizing, so they meet the same questions
   about renderer invalidation and mid-session geometry change; answering those once is the point of
   scheduling them adjacently. x3270's `Common/model.c` is the reference to steal.
   **Neither is well testable against any host reachable from this project** — `IBM-DYNAMIC` has one
   live path (TK5's TSO issues a Read Partition to any `-E` client) and a client-initiated switch has
   none, so expect unit tests, the playback oracle and by-hand GUI runs rather than a live witness.
13. **Packaging, for macOS, Linux AND WINDOWS.** The Windows target is new and is a deliberate
   addition rather than a stretch goal: nothing in this codebase is POSIX-specific. There are **zero
   native dependencies** (every package depends only on other workspace packages, with Electron the
   single external), and the `node:` builtins used are `crypto`, `fs`, `http`, `https`, `net`, `path`,
   `readline`, `stream`, `tls`, `url`, `zlib` — all cross-platform. There is not one
   `process.platform` branch anywhere in `packages/*/src`.
   **That is a claim about the CODE, not a test result: nothing here has ever run on Windows.** A
   Windows machine is available to test a packaged build on, which is all that testing an installer
   needs — so the target is unblocked, but treat "works on Windows" as unverified until an installer
   has actually been run there.
14. **PS + VMGIF** — item 10 above holds its detail and dependency; this is only its position in
   the reordered list — then **vector graphics** (GOCA).
15. **Printer sessions**, last, and deliberately so: they are probably cheap in themselves, but
   likely entangled with the graphics work above. Needs a host that will drive one; see *What is not
   implemented*.

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
PS can push pixels, so VMGIF is best treated as a *behavioral* reference — evidence of
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

- **`Attn` SENDS TELNET BREAK EVEN ON A TN3270E SESSION, WHERE x3270 SENDS `IAC IP`.** Found
  2026-10-06, while reviewing a *comment* about Attn during the keypad work — so it is an
  unverified divergence rather than an observed failure. `Session.sendAttn()` is unconditional
  `IAC BREAK` (`core/src/telnet.ts:227`), which is right for a classic TN3270 session
  (RFC 1576 §8). But x3270's `Attn_action` is documented *"ATTN key, per RFC 2355. **Sends IP,
  regardless**"* and its first branch is `if (IN_E) { if (net_bound()) net_interrupt(0); }`
  (`Common/kybd.c:978-1002`) — `IAC IP`, with `net_break` only on the non-E fallthrough. x3270
  also records that its separate `Interrupt()` action "is now the same as the Attn action"
  (`:1008`), so the two have *converged* there rather than staying distinct.
  **A SECOND CLAIM ABOUT THE CLASSIC BRANCH WAS DRAFTED AND WITHDRAWN, AND THE WITHDRAWAL IS
  WORTH RECORDING.** A newer upstream `Attn_action` sends `ctlr_read_modified(AID_PA1, false)`
  *before* `net_break(0)` — PA1 then BREAK, commented "This is what PCOMM does in plain TN3270
  mode" — which would be a divergence in the branch we *do* take, against the hosts we *do* have.
  **But that line does not exist in suite3270 4.5**, the tree in `~/src/suite3270-4.5` that every
  other x3270 citation in this project is measured against: there the `IN_3270` arm is a bare
  `net_break(0)`, and `grep -rn 'ctlr_read_modified(AID_PA1' Common/*.c` finds nothing. So it is
  a divergence from a *later* x3270 and not from our reference — worth knowing if the pinned
  version ever moves, and a reminder that a citation without a version is not a measurement.
  **The asymmetry inside our own code is the strongest hint this is an oversight:**
  `Session.sysreq()` (`core/src/session.ts:1601`) *does* branch on `inTn3270e()` and check the
  negotiated function, and `sendAttn()` immediately below it does neither. **Nothing tests Attn in
  E mode**, and neither Hercules host here offers TN3270E, so there is no witness either way —
  which is also why it has not been "fixed" on a guess. Whoever takes it needs a TN3270E host.
- **No client certificates.** TLS works (see *Connecting over TLS*), but only for
  authenticating the host. `-certfile`/`-keyfile`/`-clientcert`, `-accepthostname`,
  `-cadir`, DER files, protocol-version pinning and negotiated `START_TLS` are all
  unimplemented. **This is also what blocks IBM's Express Logon Feature**, which uses a
  client certificate to obtain a passticket so no userid or password crosses the network:
  we already advertise `IBMELF: YES` over NEW-ENVIRON because x3270 does, but we could not
  complete the exchange if a host took us up on it. See *Naming a session with `-devname`*.
  Nothing reachable from here implements ELF, so this is an untested gap rather than a
  measured failure.
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
- **On the CANVAS the mouse does TEXT SELECTION and nothing else.** A press on the screen starts a
  rectangular selection for copy (**GUI only** — the web gateway runs the same renderer, so the
  gesture works there, but the gateway refuses the `copy` action because it would extract onto its
  own machine rather than yours). A press off the screen region — the status line, past the last
  column — is ignored, and the right and middle buttons do nothing at all (deliberately: a
  right-click that sent `Clear` to a live host while a context menu opened would be a misfire
  nobody asked for). **Keypad buttons are no longer on the canvas**: since 2026-10-06 they are real
  HTML controls in their own window or overlay, so the browser hit-tests them and this client does
  no coordinate arithmetic for them at all. So there is still **no click-to-place-cursor and no
  light pen**. Whoever takes the light pen: text selection is **not** it, and must not be
  implemented with `lightpen_select()`, which sends an AID and sets MDT — a selection built on that
  would transmit on every copy attempt. x3270 keeps them apart deliberately
  (`wc3270/screen.c:2357`).
- **THE KEYPAD'S APPEARANCE IS NOT VERIFIED BY ANY TEST.** Its BEHAVIOUR is: `clicks.mjs` clicks
  nine buttons by label in the GUI's window, `browser-clicks.mjs` does the same in a served page
  and reads the gateway's own action log back, and `keypadUi.test.ts` pins all 48 label/action
  pairs. But the screenshot golden that used to photograph the drawn keypad was **deleted** rather
  than regenerated when the keypad became HTML — a capture of system-font controls is
  machine-dependent, which is the one thing that stops a golden reproducing, and is why this
  project blits its own atlas for the screen instead of calling `fillText`. If the keypad looks
  wrong, no automated check here will say so.
- **SYS REQ'S CLASSIC PATH IS LIVE-VERIFIED (2026-09-21); ITS TN3270E PATH STILL HAS NO WITNESS.**
  The keypad's `SysRq` button, the TUI overlay's entry and the CLI's `SysReq()` all put bytes on the
  wire against VM/370 and MVS 3.8j, and the key has now been driven at both and the reply read.
  **Both predicted forms appeared, one per host**: VM's unformatted screen sent the heading plus
  modified buffer data (`01 6c 61 02 / 11 5b 60`), TK5's formatted panel the heading alone. No `f0`
  in either record, so `case AID_SYSREQ` ran and not the ordinary-AID path.
  **VM/370 ACTS on a test request** — `RUNNING` → `CP READ`, a second Read Partition and a repaint —
  where MVS ignores it, so a host ignoring the key is legal but not universal. The `IAC AO` path
  needs a host that grants the TN3270E SYSREQ function, which neither Hercules system will ever be.
  Measurements in `docs/live-testing.md`, *Sys Req and Dup against VM/370 and TK5*.
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
- **NO KEYPAD BUTTON HAS BEEN CLICKED AT A HOST, and Dup's TAB is still unwitnessed.** (This bullet
  used to lead with "Field Mark and Newline have no live witness"; both got one on 2026-09-24.)
  All four keys are implemented, and **all four are now witnessed on both hosts** — Sys Req and Dup
  2026-09-21, **Field Mark and Newline 2026-09-24**, each against a matched control (above, and
  `docs/live-testing.md`). **Two narrower gaps the runs did not
  close, recorded so the witness is not read as wider than it is:** they drove the **CLI**, which
  shares `applyAction` with the button but not `mousedown` → `hitTestAt` → IPC, so the click path is
  still offline-only (`clicks.mjs`); and **Dup's TAB is unwitnessed** even though its `0x1c` is not,
  because TK5's logon panel has one unprotected field, where plain `Tab` does not move either. That
  check needs a multi-field panel, which needs a logon. The keypad as a whole needs no live
  verification, because a button press produces the same wire bytes as the equivalent keystroke and
  those *are* live-verified.
- **`IND$FILE` IS INTERACTIVE IN THE TUI AND THE GUI — THE BROWSER IS THE ONE THAT STILL CANNOT
  TRANSFER A FILE.** (This bullet used to say "the TUI only"; the GUI half landed 2026-10-01.)
  `Ctrl-T` opens a form in the TUI: ten fields, `Tab` and the arrows to move and change,
  `Enter` to start, `Esc` to close, and closing mid-transfer **aborts** rather than abandoning, so
  the host leaves transfer mode. **Three things it did not do yet; two are now done.** ~~(1) CUT
  mode only, so it needs a 24x80 screen.~~ **DONE 2026-09-29 — BOTH PROTOCOLS WORK AND THE HOST
  CHOOSES.** With
  `-ddm on` a DFT host transfers at any geometry, live-verified at 43x80 on TK5; `-ddm on` really
  does get you DFT now, where it used to be a measurement instrument that broke transfers. The
  24x80 requirement survives only for CUT, and is raised when CUT is chosen rather than up front.
  ~~(2) The GUI has the form's model and no renderer for it.~~ **DONE 2026-10-01 — `Ctrl-T` and the
  `Xfer` button open a transfer window**: a separate `BrowserWindow` with real HTML controls and a
  native file dialog, **not a canvas view**, because the canvas preload must
  stay at four functions for `renderer.ts` to keep being shared with the browser, and teaching a
  canvas text editing and focus buys nothing. See *Using the GUI*, *File transfer*. **Its live gap is now
  mostly closed and was never the protocol's:** VM/CMS has driven this window for real and the macOS
  dialog is verified by hand in ASCII mode; **TSO/DFT remains unrun** —
  `docs/live-testing.md`, *The GUI transfer window*.
  (3) **The web gateway STILL REFUSES the action outright, in
  `web/src/protocol.ts`**, and that is deliberate — **and as of 2026-10-01 the refusal gives the
  right reason.** It used to say "the gateway has no transfer UI", which stopped being the reason
  the moment the GUI had one; the reason is that a browser-initiated transfer moves bytes between
  the host and the *gateway's* filesystem, not the operator's machine. **The answer decided on
  2026-09-30 is real browser file I/O** — the bytes travelling over the WebSocket so that "local
  file" means the operator's machine — which needs a new protocol message pair, chunking and a
  `TransferFiles` over the socket, and is its own spec rather than part of the GUI's. The refusal is
  a rejection at **decode** rather than an interception, which is safe because
  `web/src/main.ts:151-154` answers every decode failure with a per-socket `error` frame and a
  `return`; the hazard that needs an interception is one line lower, at the untried `applyAction`.
  **The transfer protocol itself is live-verified on BOTH hosts in both directions** — see
  *Verification*.
- **The GUI is a first slice, not a finished app.** `packages/gui` renders live 3270
  screens from both Hercules systems and takes typed input (see *Verification*), but there
  is **no connect dialog, no menus and no preferences** — the host and
  every flag come from the command line, exactly as the TUI takes them. Packaging is also
  still to come, so there is no `.app` to download yet.
- **The web gateway is a first slice too, and shares fewer flags.** It renders live screens
  from both Hercules systems and takes typed input (see *Verification*), but like the GUI it has
  **no connect dialog, no menus and no preferences**. It also does **not**
  accept `--terminal-type` or `-tn3270e`, and of the host argument it honors only `host:port` —
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
  screen, which is what c3270 does. Given more room it centers the screen and draws a
  border.
- **Its cursor color is best-effort.** OSC 12 is not universally implemented, so the
  shape is set via DECSCUSR as well; a terminal that ignores both still shows its own
  cursor.
- **The special-keys list's "terminal too small" refusal cannot be provoked**, and is documented
  that way rather than claimed as tested behavior. The 24x80 floor above already refuses any
  smaller terminal before a session runs, and the smallest 3270 screen *is* 24x80 — so every
  terminal that can reach the list comfortably clears its 12x29 minimum. The check is a floor for
  a caller that hands the list a sub-window, not something an operator can hit.

## Verification

`npm test` and `npm run typecheck` are the fast gate; the interesting checks are the
ones against real systems, because most of the defects this project has found were only
visible there.

| check | result |
|---|---|
| `npm test` | **pass** — 2253 tests, 89 files (measured 2026-10-01 on `gui-transfer-ui`) |
| `npm run typecheck`, `npm run build` | **pass** — silent |
| conformance vs a real x3270 capture | **pass** — 5 of 6 inbound records byte-identical, the sixth differing by design |
| `pty-smoke.py` (no host needed) | **pass** — 12/12, including that ECHO is restored after exit |
| `browser-shot.mjs` — served page vs the GUI's own goldens | **pass** — **2 of 2 cases** pixel-identical, with and without the keypad, which is what says the renderer is shared and not merely similar |
| `browser-keys.mjs` — real chords through a real browser | **pass** — 13 chords, 11 actions in order over a WebSocket, 2 asserted absences |
| `keys.mjs` — real Chromium key events in Electron | **pass** — 19 chords, 17 actions in order, 2 asserted absences (`Ctrl+Z`, `F13`). The 19th is `Ctrl+T`, which **this list exists to have caught and did not**: the chord was dead until 2026-10-01 while the `Xfer` keypad button worked |
| `transfer.mjs` — the GUI's transfer window under Xvfb | **pass** — **10 of 10 checks**: the window opens, the form draws its 6 applicable rows, a local path and a host file reach the model, submit is refused with `not in 3270 mode`, **the form still takes an edit after that refusal** — the 10th, added 2026-10-01 because a form frozen by a mis-ordered IPC completion passed all nine others — every step was understood, no load failure, no renderer throw, and the client exits on its own. Replay mode with the **native dialog stubbed** — a real modal under Xvfb has nobody to click it and would stall rather than fail. **This is not a live-host check and must not be read as one** |
| `clicks.mjs` — real mouse events at real keypad buttons | **pass** — 9 buttons clicked by label, 10 actions in order (the `Ctrl-K` toggle plus one per button). A bare `return` in the `mousedown` listener leaves the whole fast gate green while every button is dead; only this reddens |
| web gateway vs VM/370, live | **pass** — 42 of 43 rows agree with the CLI; the 43rd is the cursor, at exactly 9x3 ink pixels |
| web gateway vs MVS 3.8j TK5, live | **pass** — 24 of 24 rows agree |
| web gateway reattachment, live | **pass** — same session returned inside the grace window, a new one after it |
| TUI vs MVS 3.8j TK5, live | **pass** — ISPF menu, tutorial paged, clean `LOGOFF` |
| TUI vs VM/370, live | **pass** — CMS answers `QUERY DISK A`, CP reports `LOGOFF AT` |
| `IND$FILE` both hosts, both directions | **pass** — binary round-trips byte-identically. **From the CLI**; the TUI's form drives the same `CutTransfer` and the same command builder, and has its own live row below |
| the TUI's `Ctrl-T` transfer form vs VM/CMS, live | **pass — 2026-09-23** — 29 of 29 steps, both directions, a 249-byte binary **round-tripping byte-identically**, and CMS's own `LISTFILE` confirming the file the form wrote (`V 80`, 4 records). The form renders opaquely over a live screen and `Recfm` correctly appears on the send and not the receive. **The run found a real defect no unit test could: the 24x80 refusal was 109 characters against a 54-column status line and lost every word of its remedy** |
| the same form vs MVS/TSO, live | **pass — 2026-09-24** — 26 of 26 steps, both directions, the same binary **round-tripping byte-identically**, and TSO's own `LISTDS` reporting `VB 1024 BLKSIZE 1028 PS`. Exercises the other dialect (`RECFM(V) LRECL(1024)` parenthesised) and **both TSO quoting conventions in one session** — unquoted on the send, so TSO prepends the userid, quoted on the receive. `Blksize` is drawn here and was absent on VM, which is the applicability rule checked against two real hosts rather than a fixture. Both TSO quoting conventions in one session |
| `Lrecl` with `Recfm=V` on CMS | **pass — 2026-09-24** — three cases in one session: `RECFM V LRECL 80` and `RECFM V` alone both store `V 80`, while `RECFM F LRECL 80` stores `F 80`. **The third case is what makes the first two evidence**, since without it "the two V cases match" cannot distinguish a host ignoring the keyword from a client never sending it. The 1000-byte payload was deliberately not a multiple of 80 |
| mid-flight cancellation vs VM/CMS, live | **pass — 2026-09-24** — canceling a 200KB upload at **17641 of 204800 bytes** made MECAFF's `IND$FILE` answer `>> TRANS99 - Protocol error` and return CMS to `Ready;`: **the host left transfer mode**, which is the whole purpose of aborting rather than abandoning. The final count was 24261, not 204800, which is what proves it was mid-flight rather than before the first frame or after the last. **An aborted upload leaves a PARTIAL file on the host** — correct, since the host wrote what it received |
| the same, vs MVS/TSO, live | **pass — 2026-09-24** — canceled at **15430 of 204800**, final count 23162, and TSO returned to `READY`. **The observable differs and the difference is instructive**: MECAFF announces `>> TRANS99 - Protocol error`, while Rayborn's FFTP says **nothing at all** and simply ends. So *"the host printed an error"* is not the test — *"the next command is obeyed"* is, which both `ERASE`/`DELETE` show. A partial file is left on both |
| TLS vs both hosts, live | **pass** — verified chain via `-cafile` through the in-repo proxy; default TLS at a plaintext host fails in 10 s naming `-insecure` rather than hanging |
| model 4 (43×80) vs VM/370, live | **pass** — host sends `f5` (Erase/Write, 24×80) then `7e` (Erase/Write **Alternate**, 43×80); 41 fields, no program checks |
| GUI vs VM/370 and MVS 3.8j, live | **pass** — renders both; ink compared row-by-row against the CLI's own view of the same host (42/43 and 24/24, the one difference being the cursor); typed input proved end to end through real key events |
| GUI screenshot goldens under Xvfb | **pass** — **3 of 3 cases** from a replayed synthetic trace, reproducible across consecutive runs; raw-bitmap hash, not the PNG. (An earlier version of this row said "1 case" and was already two behind: the cases are the default scheme, the `green` scheme, and the keypad shown.) The keypad golden was **read off the image** before it was committed, cell by cell against the baked atlas — a golden cannot validate the baseline it came from |
| Sys Req vs both hosts, live | **pass, classic path — 2026-09-21** — both predicted forms appeared, one per host: VM's unformatted screen sent the heading plus modified buffer data (`01 6c 61 02 / 11 5b 60`), TK5's formatted panel the heading alone, **no `f0` in either** and no ETX. **VM/370 acts on it** (`RUNNING` → `CP READ`, a second Read Partition, a repaint) where MVS ignores it. The TN3270E `IAC AO` path is still unwitnessed and unobtainable here. **The control run matters: a first attempt ended at 0.003s against the real run's 0.457s and would have credited Sys Req with a transition it could not have caused** |
| Dup vs MVS 3.8j TK5, live | **partial — 2026-09-21** — `0x1c` reached the host with the MDT set (an unmodified field is not transmitted at all) and TSO answered `INPUT NOT RECOGNIZED`, i.e. it read the field and rejected it. **The TAB half is NOT witnessed**: that panel has one unprotected field, where plain `Tab` does not move either — measured in the same session, not assumed |
| Field Mark, Newline vs a live host | **NOT DONE** — neither has been pressed at a host. On `docs/live-testing.md`'s next-run list |
| any keypad **button** vs a live host | **NOT DONE** — the 2026-09-21 runs drove the CLI, which shares `applyAction` with the button but not `mousedown` → `hitTestAt` → IPC. The click path remains offline-only (`clicks.mjs`) |
| TN3270E vs real s3270 + in-repo server | **pass, but NOT against a live host** — 10 configurations via `drive-e.py` (7 pre-existing plus 3 for BIND-IMAGE: a granted BIND-IMAGE followed by a size-code BIND, a granted BIND-IMAGE with no BIND — the only end-to-end exercise of the 5s timeout — and `-bind-image off` omitting the function from FUNCTIONS REQUEST). Our `DEVICE-TYPE REQUEST` is byte-identical to s3270's; `FUNCTIONS REQUEST` is now byte-identical too, BIND-IMAGE included |
| TN3270E vs **recorded real hosts**, via x3270's `playback -b` | **pass — 10 of 10 traces**, host-free, by `drive-playback.py`. Replays ten different real hosts (two commercial VTAM systems among them) and asserts our replies byte for byte: `WILL TN3270E`, `DEVICE-TYPE REQUEST` with the right model, `FUNCTIONS REQUEST` including BIND-IMAGE, and the full backoff where the host answers `WONT`. Mutation-verified — corrupting the device type or reversing the DEVICE-TYPE operand order reddens all six, and **that operand-order bug is one real s3270 accepts silently**. **Four of the six stop at FUNCTIONS** (a scripted keystroke this harness's short script never drives, or a BID reply we do not implement — see `docs/live-testing.md` for which reason applies to which trace), matching 3 blocks each. **Two get further, and both are new.** `sscp-lu-data.trc` reaches a **real BIND** — 4 blocks (3, 19, 11, 8 bytes), PLU name `IBM0SMAA` — giving BIND parsing its first real-host witness. `wont-tn3270e.trc` reaches **5 blocks** (3, 19, 11, 3, 3): its host withdraws TN3270E with `WONT` rather than `DONT`, and since `e789b4f` we answer `WONT` and fall back to classic TN3270 as real s3270 does, so that trace is the witness for **that** fix. It stops on a `wrongTerminalName` color-digit divergence that is not our defect. **And since NEW-ENVIRON landed, FOUR MORE traces are drivable and each matches NINE blocks** — `devname_success.trc`, `devname_failure.trc`, `devname_change1.trc`, `devname_change2.trc` — further than every other case here, because option 39's per-request `DEVNAME` exchanges interleave with TN3270E's own steps. `devname_success.trc` was the trace this project originally wanted as its BIND witness and could not drive at all; it now reaches a real BIND with PLU `IBM0SMAJ`. **Mutation-verified to cover the iteration mechanism, not merely the negotiation:** disabling the device-name counter's increment reddens all four with values like `bar0` for `bar1` |
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
