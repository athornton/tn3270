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

**Packaging is out.** All four front ends are on npm (since 0.1.0, 2026-11-08; released by tag
from GitHub Actions with provenance since 0.1.3), and native installers (macOS, Linux, Windows) are
built and smoke-tested in CI on five runners. **From the next release, the macOS app is
signed**: a Developer ID, notarized and stapled. The Windows installer stays unsigned (a
Microsoft Store MSIX, which Microsoft signs, is planned), and so do the Linux packages. Releases
up to 0.1.4, and every CI artifact from main and PRs, are unsigned. See *Installing* below and
`docs/releasing.md`.
Started with no arguments, the GUI now opens a Connect dialog (host, model, TLS) instead of refusing to run; given a host it still
takes it on the command line exactly as the other front ends do. It also has a menu bar — Edit for
copy and paste, View for the keypad and keyboard, and Model for the model and oversize (picked while
disconnected, applied at the next connect; `Alt-M` pops it up; its first item, Disconnect,
drops the host session so the choices free up). The mouse presses keypad
buttons and selects text for copying, and nothing else: no click-to-place-cursor and no light
pen. See *What is not implemented* below, which is
the honest part of this file.

## Installing

**On npm since 0.1.0 (2026-11-08), currently 0.1.4 (2026-11-10, the first with a GitHub release;
published by the tag workflow, with provenance, since 0.1.3); the native installers come from a
green run of `.github/workflows/package.yml`, and the macOS app is signed from the next release**
(see `docs/releasing.md`).

```sh
npm install -g @tn3270/cli    # tn3270-cli -- the s3270-style scripting client
npm install -g @tn3270/tui    # tn3270     -- the c3270-style terminal client
npm install -g @tn3270/web    # tn3270-web -- the browser gateway
npm install -g @tn3270/gui    # tn3270-gui -- the Electron GUI
```

**Not root?** `-g` writes to npm's global prefix, which is a system directory for a packaged Node.
Either point the prefix at your home directory once (`npm config set prefix ~/.npm-global`, then
put `~/.npm-global/bin` on `PATH`), or install without `-g` and run the commands from that
directory with `npx` (`npx tn3270 host`, `npx tn3270-gui`) or as `./node_modules/.bin/tn3270`. A
plain `npm install` does not touch `PATH`. Without root the GUI on Linux may also need
`--no-sandbox` (see the sandbox note below).

Each package declares `"engines": {"node": ">=20.19"}` (Node 20.19 is what Debian 13 packages; CI
tests it, and Node 22 on every packaging runner). `@tn3270/gui` additionally needs Electron's
own ~100 MB binary, which Electron 44 downloads on first use rather than during `npm install` — the
first `tn3270-gui` prints `Downloading Electron binary...` and takes a while; that is the download,
not a hang. See `packages/gui/README.md`.

**Native installers** (macOS universal `.dmg`/`.zip`, Linux x64 and arm64 AppImage/`.deb`, a
Windows x64 NSIS installer) come from `npm run package:gui` via electron-builder. **From 0.1.4 on,
each version's GitHub release** (the repository's *Releases* page, tag `vX.Y.Z`) carries all seven,
built and tested by that tag's CI run, with a `SHA256SUMS` beside them (`sha256sum -c SHA256SUMS`
on Linux, `shasum -a 256 -c SHA256SUMS` on macOS; `--ignore-missing` to check only the ones you
downloaded) and notes quoting that version's `CHANGELOG.md` entry. Earlier versions' installers
were CI artifacts only. **From the next release, a release's mac app is signed**: the
`TN3270.app` in the `.dmg` and `.zip` with a Developer ID, notarized and stapled (the `.dmg` file
itself is not signed, by design). **The Windows installer is not signed**, in a release or
anywhere else: a Microsoft Store (MSIX) route, which Microsoft signs, is planned, and the NSIS
`.exe` stays on the GitHub release for people who prefer it. The Linux packages are not signed.
The CI checks every mac and Windows artifact's signature state on every run
(`scripts/verify-signatures.mjs`). **Unsigned mac builds:** releases up to 0.1.4, and every CI
artifact from main, PRs and branch pushes. For those, macOS Gatekeeper blocks
a downloaded unsigned app, and the way through is System Settings → Privacy & Security → *Open
Anyway* after the first blocked launch, or `xattr -dr com.apple.quarantine
/Applications/TN3270.app`. **Checked by hand by the user on 2026-11-08:** on Apple Silicon the
fully unsigned build runs once permitted through *Open Anyway* (a cumbersome step, but not a
refusal), and the Linux arm64 `.deb`, Linux x64 AppImage and Windows 11 installer all just run,
each through the Connect dialog. electron-builder's `identity: null` (the unsigned config) means
no signature was applied, not an ad-hoc one. On the (unsigned) Windows installer, SmartScreen
warns, and *More info → Run anyway* gets past it.

**Minimum OS**, from Electron 44.10.2's own stated platform support
(`node_modules/electron/README.md`, "Platform support"): macOS Ventura (13) and up; Windows 10 and
up; Linux distributions still supported by both Chromium and the distro maker. The macOS figure is
also what the built app declares: `LSMinimumSystemVersion` 13.0 in the CI-built universal
`TN3270.app` (measured 2026-11-06). Windows 10 and the Linux statement are Electron's claim, not
measured against this build.

**Starting `tn3270-gui` with no host opens a Connect dialog** — host (the same
`[prefix:][LU,LU@]host[:port]` the command line takes), model (default `3278-2-E`), and a TLS
checkbox (on by default; untick it for a plaintext host such as Hercules). **The dialog stays open
until a connect succeeds** (2026-11-08; it used to close on the first press and have no way back —
see *Connecting over TLS*). Pressing Connect shows `Connecting to HOST:PORT...`, the host exactly
as typed, on the dialog's own error line while the attempt is in flight — up to the 10-second TLS
handshake deadline, or the 30-second connect deadline for a **plaintext** attempt (added
2026-11-09: before it, a host that merely drops packets was given up on only by the OS's own TCP
timeout, around two minutes on Linux) — and Quit still works throughout. A failure is shown on that same line, never in the terminal
window — the TLS-against-a-plaintext-host case reads `Untick TLS in the Connect dialog: ...`,
naming the checkbox right beside it — and the host, model and TLS fields keep what you typed, so
fixing the one thing that was wrong and pressing Connect again **retries the SAME session** with
whatever you changed. **Quit, Escape and closing the dialog all quit the app until a connect has
succeeded**, including mid-attempt: the in-flight connect dies with the process. Once connected,
the dialog closes and is never used again this run — a dropped connection goes through the
ordinary reconnect path, and switching host mid-session is `File` → `Connect…` (roadmap item 15,
not built). **`--terminal-type` on the command line** fixes the terminal type for the session's
life, so after the first attempt the dialog's Model control is disabled (its title says why)
rather than offer a choice a retry would ignore.

**On Linux, `tn3270-gui` leaves Chromium's sandbox on.** npm cannot install `chrome-sandbox` setuid
root, which only matters on systems that block unprivileged user namespaces (Ubuntu 23.10+ under
AppArmor, some hardened kernels); there, Electron aborts and `tn3270-gui` prints two fixes: `chown
root:root` and `chmod 4755` on the `chrome-sandbox` binary the message names, or add `--no-sandbox`
to the command line. See `packages/gui/README.md`.

**The icon** is our own drawing of a 3270-family terminal: the CRT hood jutting forward over a
set-back base, a separate keyboard, and the screen in the 3279's seven colors, with no text.
`packages/gui/resources/icon.svg` is the source; `node packages/gui/scripts/render-icon.mjs`
re-renders the 1024x1024 `icon.png` (window icon; electron-builder makes the `.icns` and `.ico`
from it) and the Linux set `icons/16x16.png` ... `512x512.png`, each drawn from the SVG at its own
size. Commit the PNGs with any change to the SVG.

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
own screenshot golden and requires them to be identical.

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
npm test           # 2959 tests, 119 files
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

The flags are the TUI's, unchanged — `-model`, `--terminal-type`, `-oversize`, `-tn3270e on|off`,
the TLS set, and the full `[prefix:][LU,LU@]host[:port]` shape. (`-oversize auto` measures the
display here; see *Oversize*.) That is not a coincidence or a
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

### The keyboard

**`Ctrl-B` opens the full 122-key keyboard window**, and **View → Keyboard** does it too. Where the
keypad is 48 buttons of the keys a PC has not got, this is the whole 3279 typewriter — 118 caps,
every one read off a photograph of real hardware rather than guessed. Like the keypad it OPENS
rather than toggling, pressing the chord again brings the open window forward instead of stacking a
second one, and it is not remembered between runs. The web gateway has the same keyboard on the
same chord, as an opaque overlay rather than a window; opening either surface there closes the
other.

**The on-screen `Shift` is a one-shot.** Click it and the next character cap you click is sent
shifted, which also re-letters every dual-glyph cap to its shifted legend; the arm survives a PF
key, and is spent by that next character, by a second press of `Shift`, or by the surface closing.
It is NOT a latch and it is not Caps Lock — `Caps Lock` is inert, because on a 3270 keyboard the
letter caps send the same character either way.

**Both windows accept the physical keyboard too.** Typing or pressing a chord while the keypad or
keyboard window has focus reaches the session exactly as it would from the terminal window — you do
not have to click back to the terminal first. The on-screen `Shift` is a separate one-shot from
your physical Shift key: it arms on a click and is spent by the next character you click.

### Copy and paste

**Drag across the screen to select, then copy — from the Edit menu (the app's, or the browser's
in the web gateway), or with the keyboard in either front end.** The accelerators are **platform-split, and that is forced rather
than stylistic: `Ctrl-C` is the Clear AID** and stays Clear everywhere. So it is **`Cmd-C` /
`Cmd-V` on macOS**, where `Cmd` is free, and **`Ctrl-Shift-C` / `Ctrl-Shift-V` on Linux and
Windows** — the convention gnome-terminal and VS Code's terminal adopted for exactly this
collision. "Ctrl-C copies when something is selected" was considered and rejected: it makes a
destructive AID conditional on invisible state, and its failure mode is a missed Clear on a locked
`MORE...` screen.

**A press becomes a selection once the pointer moves 4 pixels**, roughly the browser's own drag
threshold, even if it never leaves the cell it started on. So **a single character can be
selected**: press on it, nudge, release. A plain click with ordinary hand jitter selects nothing,
so clicking the screen does not arm a copy. (Until 2026-11-03 the rule was the rectangle's size,
and the smallest selection was two cells.) Machine-checked in both front ends: GUI `select.mjs`
and `browser-clicks`'s `webSingleCell` and `webClickNoCopy`.

**IN THE BROWSER EVERY COPY GESTURE WORKS: `Cmd-C` on a Mac, the browser's Edit > Copy, and the
chord `Ctrl-Shift-C` (`Cmd-Shift-C` on a Mac).** `Ctrl-C` is still Clear there too, so on Linux and
Windows the keyboard route is the shifted chord. The browser once had the chord alone, and the
history is measured: the 3270 selection is the emulator's own state rather than a DOM text
selection, so with no `copy` listener `Cmd-C` copied nothing in any browser tried (2026-10-28),
and once a listener existed Firefox's Edit > Copy was still refused for want of a keystroke's user
activation (2026-11-02), until the fetch below made the menu work (2026-11-03).

- **The text is fetched when the drag ends**, so by the time you copy it is already in the page,
  and the copy writes it synchronously. That is what makes the browser's menu work in Chromium,
  where it is machine-checked (Firefox's Edit > Copy is not yet witnessed), and it is also why
  **copy works over plain `http` at a LAN address**, which has no secure context and no clipboard
  API.
- **A copy pressed faster than that fetch** falls back to asking the gateway for the text, which
  needs a secure context. On a plain-`http` LAN page it then paints
  `copy failed: use https (--tls-cert) or localhost ...` instead of copying (an early Edit > Copy in
  Firefox can be refused with `NotAllowedError` the same way). **That message is a notice: it keeps
  your selection**, so press copy again, with no re-drag, and it works once the fetch has answered
  (the gateway logs `selection: sent N chars to the browser`); the screen comes back with the
  selection highlighted. It holds until the screen changes: a host frame, a keystroke or a paste
  clears the selection as always, and a click on the screen dismisses the notice and starts a new
  drag. Machine-checked in Chromium by `browser-clicks`'s `webCopyRetry`.
- **Right-click offers only "Copy Image"**, because the screen is a canvas.

The Chromium half of this is machine-checked at a real plain-`http` LAN address, on the OS
clipboard. **`Cmd-C` in Safari and Firefox on a Mac is live-witnessed** (2026-11-03), at a
plain LAN address and over a localhost tunnel; the browser's Edit > Copy in those two awaits
a live pass.

Paste is the opposite case and needs no chord: **`Ctrl-V` / `Cmd-V` work in the browser through
the page's own `paste` event**, because the emulator never claims those chords and the browser
delivers the text itself.

**`Ctrl-Shift-V` pastes too — in Chromium, but not in Firefox on Linux** (both confirmed in the
real browsers), and the difference is the browser's rather than ours. We claim neither chord and accept any `paste` event the browser raises,
so the shifted form works exactly where the browser raises one: Chromium does for both, while
Firefox reserves `Ctrl-Shift-V` for paste-as-plain-text in editable contexts and a 3270 screen
offers it nothing editable. This is not fixable by binding the chord — the only way to paste from an
arbitrary keystroke is `navigator.clipboard.readText()`, which prompts in Chromium and does not
exist in Firefox at all. Binding it would be worse than leaving it: claiming the chord means calling
`preventDefault` on it, which would suppress the paste that currently works in Chromium.

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

**The selection is cleared by any keystroke that does something, by every repaint from the
host, and by an error message painted over the screen** — a highlight over changed text would offer you a copy of something that is no longer
there. **The copy chord is the one exception**, for the obvious reason: clearing on it would
destroy the rectangle it is about to send, so copying would reliably copy nothing. You can copy the
same selection twice.

**A consequence worth knowing, because it looks like a bug and is not:** the clear on a host
repaint does not check whether the repaint touched your selection. A 3270 host sends frames you did
not ask for — an unsolicited write from a running job, a status-line update, a timed panel refresh
— so a frame arriving between your drag and your copy discards the selection, and the copy then
does nothing and says nothing. On a busy panel you may have to select and copy again. The
alternative — keeping a highlight over text the host has changed underneath it — was judged worse,
since it offers a copy of something you never saw.

**The web gateway has BOTH copy and paste** (2026-10-27). It did not for a long time, and the
reason is worth keeping: a copy has to extract the text on the gateway's machine, where the screen
buffer lives, and then get it back to *your* clipboard — which needed a protocol message that did
not exist. It exists now, so the selected text travels back over the WebSocket when the drag ends,
and the page writes your own clipboard when you copy.

**The one limit left on a plain-`http` LAN address is the fast copy above.** Writing a clipboard
asynchronously requires a **secure context**: `localhost` has one even over plain `http`, a LAN
address over `http` does not. Only the fallback writes asynchronously, so it is the only thing
that can be refused, and it says so on the screen rather than failing silently. Serving over
`https` (the gateway has `--tls-cert`) or reaching it on loopback removes even that.

**Clicking a keypad button and selecting text are the only things the mouse does**; the light pen
is not implemented, and text selection is deliberately not built on it (see *Remaining* for why
that distinction matters).

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

**What it does not have yet:** a preferences store, and `File` → `Connect…` for a session already
running. A launch with no host opens a Connect dialog instead of refusing to run (see *Installing*);
a launch given a host still takes it on the command line. It does have a menu bar (Edit for
copy and paste, View for the keypad and keyboard, Model for the model and oversize -- disabled while
connected or connecting, applied at the next connect, and popped up by `Alt-M`). The Model menu
starts with **Disconnect**, enabled only while connected, which drops the host session so a choice
can be made without waiting for the host to drop the line (`Enter` or `Clear` then reconnects with
it; a connect attempt still in flight cannot be cancelled, so the item stays disabled until it
settles). Then it offers the eight models, then oversize None, Auto and the `-oversize` size given at startup, if
any. **A model choice can reset the oversize to None** when the oversize cannot go with that model
(a non-`-E` model, or a fixed size smaller than the model), and the window says so; pick a model
the size fits and then the size again to get it back. **A `--terminal-type` session has no Model
menu**: its terminal type is fixed, so there is nothing to choose. **On the 3270 canvas the mouse does one thing: dragging selects
a rectangle of text for copying** (see *Copy and paste*). Clicking the screen does not place the
cursor and there is no light pen. The keypad is not on the canvas at all: it is real HTML buttons, in
its own window in the GUI and an overlay in the browser, so the mouse works on it normally, as it does
in the *transfer* window. **The browser has the Model menu too, as an overlay: `Alt-M`** opens a
picker with the same choices from the gateway, disabled while connected or connecting, and a
choice applies at the next connect; its **Disconnect** button, like the menu's item, drops the
host session while connected. The same model-resets-oversize rule applies, and the picker
says so (see `packages/web/README.md`). **What is implemented
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

**The form opens on `send`, and the direction names both of its endpoints** —
`send: local to host` and `receive: host to local`, rather than the bare words.

> ### `Direction` DEFAULTS TO `send`, WHICH IS NOT WHAT x3270 DOES
>
> x3270 defaults to **receive**. We default to **send**, in the form *and* in a scripted
> `Transfer(...)` that omits `Direction=`. The reason: people are far more likely to use
> `IND$FILE` to get something *into* a historic S/370 system than to get it out — until VM has a
> TCP/IP stack, this client's main job is putting software onto these machines, and few people
> develop software locally on a VM or MVS guest.
>
> **If you are porting a script from x3270, or from a tn3270 build before 2026-10-22, a
> `Transfer(...)` with no `Direction=` now means the opposite of what it did** — and under
> `Exist=replace` that overwrites a host dataset rather than a local file. **Name `Direction=`
> explicitly in every script.** Nothing in `packages/cli/scripts/` relied on the default, so no
> shipped script changed meaning, but yours might.
>
> This is the second deliberate divergence from x3270 in the same keyword block. The other is
> `Mode`, which defaults to `binary` where x3270 sets `ascii_flag` true: a wrong ascii default
> silently corrupts a load module, while a wrong explicit choice is visible in the command.

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
node packages/tui/dist/main.js [-model M] [--terminal-type T] [-oversize <cols>x<rows>|auto|none] \
    [--colors N] [-scheme S] [-insecure] [-noverifycert] [-cafile FILE] host[:port]
```

`-model 3278-2-E` is usually what you want: TSO rejects a plain `IBM-3278-2`. Port
defaults to 23. Models 2–5 are accepted, with or without `-E`; see *Screen models*.
`--colors` takes `0|8|16|256|16m|auto`, where `auto` asks terminfo and
`0` is monochrome because you said so — the distinction matters, since it is how the
monochrome path gets tested on a color terminal.

**`tn3270` with no host, run AT A TERMINAL, prompts for one instead of the usage error**
(2026-11-08), the TUI's counterpart of the GUI's Connect dialog:

```
$ tn3270
Host: hercules:3270
Model [3278-2-E]:
TLS [Y/n]:
Connecting to hercules:3270...
Answer n to TLS: hercules:3270 accepted the connection but never completed a TLS handshake, ...
Host [hercules:3270]:
Model [3278-2-E]:
TLS [Y/n]: n
Connecting to hercules:3270...
```

and then the full-screen terminal starts exactly as `tn3270 host` would. **Defaults are the last
answers** — round 1's come from the command line's `-model` and TLS flags (or the product
defaults), and every later round's are what was typed the round before, so a retry is Enter until
the field that needs changing. Host has no default on round 1, and an empty answer re-asks. An
unknown model is answered with the list of known names and re-asked; TLS takes `y`/`yes`/`n`/`no`
in any case, or Enter for the default. **A host starting with `-` is refused** before Model or TLS
are even asked. A failed connect prints the failure and starts a new round, with the last round's
answers as this round's defaults — the TLS-plaintext-host cases read `Answer n to TLS: ...` here,
a third wording alongside `-insecure` on the command line and `Untick TLS in the Connect dialog` in
the GUI. **`Ctrl-D` (EOF) or `Ctrl-C` at any prompt quits**, exit status 1 — nothing was
connected — and `Ctrl-C` while a connect is already in flight (the attempt cannot be aborted)
prints `cancelled; waiting for the connection attempt to end` and waits for it rather than
appearing to ignore the keystroke. Other flags still apply: `tn3270 -scheme green --colors 16`
prompts too, and both are used once the session starts. **This only happens at a real terminal** —
stdin and stdout must both be TTYs. A script or a pipe on either end still gets the usage error,
exit 2, with no host, exactly as before; a script never meets a prompt. An unknown `-model` given
on the command line is still a usage error regardless of a terminal being present.

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
what you claim. Past the model's size, see *Oversize* below.

## Oversize (`-oversize`)

**`-oversize <cols>x<rows>|auto|none`**, in every front end, after x3270's flag of the same name.
**The order is x3270's, columns first** (`Common/model.c:343`): `-oversize 160x62` is **62 rows
by 160 columns**. Our own messages say a size in words ("62 rows by 160 columns") rather than
repeat that order. Absent, or `none`, means the model's own alternate size, as before.

```sh
node packages/tui/dist/main.js -insecure -model 3278-4-E -oversize 160x62 HOST:PORT
node packages/tui/dist/main.js -insecure -oversize auto HOST:PORT
```

**Any oversize is advertised as `IBM-DYNAMIC`**, as TERMINAL-TYPE and as the TN3270E device type,
and the size itself goes to the host in the Query Reply (Usable Area and Implicit Partition).
The default size stays 24x80; the oversize is the ALTERNATE, so a host still reaches it with
Erase/Write Alternate. **It needs an extended (`-E`) model**, since a Query Reply is part of the
extended data stream. The default with no `-model` is `3278-2-E`, which already is one.
`-bind-limit on` then bounds a BIND by the oversize rather than by the model.

**`auto` measures the window, at each connect and reconnect only:**

| front end | what `auto` measures |
|---|---|
| TUI | the terminal, less one row for the status line: a 41x100 terminal asks for 40 rows by 100 columns |
| GUI | the display's work area, at the scale the window would pick anyway (80% of the work area, the model's scale), less the OIA row |
| web gateway | the browser's viewport at scale 1, less the OIA row, sent by the page in `hello` and kept up to date by later resizes |
| CLI | **refused**: there is no window to measure. Give `<cols>x<rows>` |

**A resize mid-session does NOT change the live screen.** The host learned the size from the
Query Reply and will not ask again, so the new size applies at the NEXT reconnect. The TUI says
so on its message line (`window now fits 50 rows by 132 columns; applies at the next reconnect`).
The GUI and the gateway apply it silently at the next connect. **In the TUI, resizing and then
reconnecting is how you change size while running**: it has no Model menu and no key for one, and
its model is set by `-model` only. The other front ends can also change model and oversize while
disconnected: the GUI's Model menu and the browser's `Alt-M` picker (see *Using the GUI*, and
`packages/web/README.md`), and the CLI's `Set()` (see *Using the CLI*). The menu and the picker
each have a **Disconnect** to get there without the host's help.

**When `auto` cannot apply, the session falls back to the model and says so on stderr.** That
covers a window smaller than the model, no window size known, or a window too wide to keep the
model's rows inside 16383 cells. The gateway prefixes each line with the first 8 characters of
the session id. A window that is merely too TALL for 16383 cells is not refused: it is cut to
fewer rows, which is noted in the trace only, not on stderr.

**Refused before anything connects**, with a usage error:

- `-oversize` together with `--terminal-type`, since an oversize is advertised as `IBM-DYNAMIC`;
- a non-`-E` model (`use -model 3278-4-E`). x3270 drops the oversize silently here; we refuse;
- a fixed size below the model's alternate (`160x20` on any model; `100x40` on a model 4, which
  is 43 rows);
- more than 16383 cells, the 14-bit address limit;
- `auto` in the CLI.

**`--replay` (the gateway) and `TN3270_GUI_REPLAY` (the GUI) ignore it**, because a replay never
connects, and only a connect resolves the geometry.

**What has been checked:** our Query Reply against real s3270 4.5 run with the same
`-oversize 160x62`. The Usable Area and Implicit Partition bytes are identical (see
`docs/live-testing.md`, "Oversize conformance against real s3270"). The TUI's `auto` has been run
in a real pty (`pty-smoke.py --oversize-auto`), and the GUI's under Xvfb. **Live: VM/370 (VM/CE)
honours it** -- with `-oversize 160x62`, MECAFF's `EE` switches the screen to 160x62 and leaving it
returns to 80x24 (2026-11-04). The web gateway at a fixed 160x62 works in Firefox and Safari on a Mac
(2026-11-05), and `-oversize auto` sizes the session from the browser window (EE came up about
180 columns wide). TSO and a modern host are
still owed; `docs/live-testing.md` lists them.

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

That same failure is worded for the GUI's Connect dialog (`Untick TLS in the Connect dialog: ...`,
naming the checkbox beside it) and the TUI's no-host prompt (`Answer n to TLS: ...`) — see
*Installing* and *Using the TUI*.

**A plaintext connect has a deadline too: 30 seconds** (`CONNECT_TIMEOUT_MS`, since 2026-11-09).
A host that silently drops packets used to be given up on only by the OS's TCP retries, around
two minutes on Linux. Now it is `cannot connect to HOST:PORT: no answer within 30 s
(CONNECT_TIMEOUT)` — measured against the blackholed TEST-NET address 192.0.2.1: exit 1 after
31 s. It is a connect deadline only, disarmed the moment the socket connects, so an idle session
is never dropped by it.

**A host that is down or misspelled is not a TLS problem, even with TLS on.** Refused, no such
host, unreachable and timed-out connects happen before any TLS byte is exchanged, so every front
end words them as `cannot connect to HOST:PORT: connection refused (ECONNREFUSED)` or `no such
host (ENOTFOUND)`, never `TLS connection to ... failed` (since 2026-11-09; before, only a
plaintext attempt was worded that way). A reset or a stall during the handshake is still a TLS
failure, and says so.

**Reconnect always replays the LAST EXPLICIT TLS choice, never a keystroke, menu or host
frame.** On the command line that choice is fixed for the run — there is nothing else to replay.
In the GUI, it is the Connect dialog's latest press of Connect: a dropped session's `Enter` or
`Clear` reconnects with whatever TLS the dialog last used, including a retry that changed it. In
the TUI, each round of the no-host prompt builds a fresh session, so the choice in force for
*that* session is simply the round that connected it; `Ctrl-C`/`Enter` to reconnect once running
replay that same choice, not whatever a later round might have asked. `Session.reconnect()`'s own
comment (`packages/core/src/session.ts`, "THE TLS TRAP") is the one place this is pinned precisely
— read it before changing anything that touches TLS or reconnect.

Design and measurements: `docs/superpowers/specs/2026-08-25-tls-support-design.md`,
`docs/superpowers/specs/2026-11-08-connect-dialog-retry-design.md` and
`docs/superpowers/specs/2026-11-08-tui-connect-prompt-design.md`.

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
one past what `-model` configured. Growing past the model is `-oversize`'s job (see
*Oversize*; with an oversize, the upper bound is the oversize), and letting BIND do it here
would silently turn this feature into that one. A user who sees a refused BIND while running `-model 3278-2`
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

`-oversize <cols>x<rows>` works here as in the other front ends; **`-oversize auto` is refused**
with a usage error, since a script has no window to measure. See *Oversize*.

**Commands.** `Connect` `Disconnect` `Reconnect` `Quit` · `String` `Enter` `Clear` `PF` `PA`
`Attn` `Reset` `SysReq` · `Up` `Down` `Left` `Right` `Home` `Tab` `BackTab` `Newline`
`MoveCursor` · `BackSpace` `Delete` `Insert` `EraseEOF` `EraseInput` `Dup` `FieldMark` ·
`ScreenText` `ScreenJson` `Ascii` `Snap` · `Trace` `TraceText` `Replay` · `Transfer`
· `Wait` · `Set`

**`Set(model,<model>)`, `Set(oversize,<spec>)`, or both as one call,
`Set(model,<model>,oversize,<spec>)`** change the model and/or the oversize while running,
applied at the next `Connect()`/`Reconnect()` — x3270's `Set` action (`Common/toggles.c:637-641`),
narrowed to the two names this CLI has, and to one or two pairs: there is no third name to chain
on, and no `name=value` or query (`Set(name)`) form the way x3270's `Toggle`/`Set` also support,
and no `-defer`. **Both names in one call matters, not just convenience:** the model and the
oversize are validated TOGETHER (an oversize must fit the model, and needs an extended, `-E`,
model), so some destinations are refused by every single-step path yet reachable in one `Set`
call — e.g. going from model 5 oversized to 140x30 to model 4 at 80x45, where `Set(model,...)`
alone is refused against the old oversize and `Set(oversize,...)` alone is refused against the
old model's floor. The name is case-insensitive; the value is validated eagerly, the same way
`-model`/`-oversize` are, so a bad model, a non-`-E` model under an oversize, or
`Set(oversize,auto)` (no window here to measure) is refused immediately rather than at the next
connect, and the setting is left unchanged. `Set(...)` is refused while connected
(`disconnect first; ...`), while a connection attempt is still in flight (`wait for the
connection attempt to finish; ...`), and on a
session started with `--terminal-type`, which has no model or oversize to change.
**Unlike the GUI's Model menu and the web picker, `Set(model,...)` alone never resets the
oversize** to make the pair fit: those two front ends apply `applyGeometryChoice`'s reset rule
for a one-field pick, but `Set()`'s own model-and-oversize validation (above) means a model given
without its oversize is checked against whatever oversize is already set and refused outright if
the pair does not fit — give both in one call instead, e.g. `Set(model,3278-5-E,oversize,none)`.

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

**`Ctrl-B` gives the full 122-key keyboard here, as the same kind of overlay.** The keypad and
the keyboard close each other, and the `Alt-M` model picker closes, and is closed by, the keypad,
the keyboard and the transfer form — two opaque surfaces claiming the page at once is a state the
operator cannot read. All of these are intercepted CLIENT-SIDE and never reach the gateway, which
holds no state for any of them.

**Clicking a button is an ordinary action** — the same message a keystroke sends, so **nothing
about the protocol changed** to add it. The overlay floats over the screen rather than growing the
page, and starts hidden on every page load, so a client reattaching to a running session never
inherits whatever the last one had open. A model 4 taller than the viewport scrolls.

**`Ctrl-T` (or the keypad's `Xfer`) opens the `IND$FILE` transfer form, as an overlay.** Both
directions. The file's bytes travel over the WebSocket, so "local file" is the browser's machine,
and the gateway never touches its own disk. The options are the CLI's `Transfer()` keywords (the
form omits `BufferSize`); the cap is 10 MB each way, staged in memory; one transfer runs per
session at a time. The host chooses CUT or DFT, as in every front end; `-ddm off` forces CUT. A
received file is saved through `showSaveFilePicker` in a Chromium-family browser in a secure
context, and through an `<a download>` link elsewhere. Live-verified on VM/370 (CUT) from Firefox,
2026-10-22; DFT from a browser is not yet live-witnessed (`docs/live-testing.md`).

**A browser pressing `Enter` or `Clear` on a disconnected session makes the GATEWAY redial the
mainframe.** That is the intended reading: the `Session` is server-side, so it is the server's own
socket that comes back, and the browser cannot name a host — the action carries no argument and the
target is the one the gateway was started with. The host, port and TLS decision are the server's
throughout, which is also why a client that reattaches to a session someone else started can only
ever reconnect it to the same place.

Its own options are double-dashed (`--listen`, `--bind`, `--auth`, `--token`, `--grace`,
`--max-sessions`, `--allow-origin`, `--tls-cert`, `--tls-key`, `--tls-chain`, and the harness
flags `--replay` and `--log-actions`); the client options it inherits keep s3270's single dash
(`-insecure`, `-cafile`, `-noverifycert`, `-verifycert`, `-model`, `-oversize`, `-scheme`,
`-bind-image`, `-bind-limit`, `-ddm`, `-devname`). `-oversize auto`
measures each browser's viewport, separately for each session; see *Oversize*. **`--scheme` is refused as an
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
someone else is currently attached to gets a new session instead of a handover.

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
packages/core        protocol: telnet framing, 3270 parse/execute, screen, keyboard, OIA,
                     color resolution, Query Reply, IND$FILE (CUT and DFT), trace
packages/frontend    rules every front end shares: host argument, TLS flags, session factory,
                     keymap, action dispatch, binding intent, keypad and 3279 keyboard tables,
                     transfer form and driver, paste
packages/node-files  Node file and process helpers (isMain, IND$FILE file I/O) for the front ends
packages/canvas      canvas renderer, glyph atlas, keymap-to-action layer, and the HTML views
                     (keypad, 122-key keyboard, transfer form) shared by the GUI and the gateway
packages/cli         s3270-style scripting CLI
packages/gui         Electron GUI: canvas renderer over a 3270 bitmap-font atlas, plus HTML
                     child windows for connect, keypad, keyboard and IND$FILE transfer
packages/tui         c3270-style terminal front end, plus the live/pty harnesses
packages/web         browser gateway: the same renderer and views over a WebSocket, with
                     IND$FILE and copy/paste carried on the socket
packages/fixtures    recorded traces, golden screens, x3270 reference captures
scripts/             packing, publishing, release notes, package smoke and store probe
docs/                spec, plans, live-host runbook, releasing, GOCA notes, handoff
```

Start with `docs/HANDOFF.md`. The design spec is
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`; the later specs and the plans are in
`docs/superpowers/specs/` and `docs/superpowers/plans/`, and `docs/live-testing.md` is both the
runbook for recording against a real host and the log of what was found doing so.

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

The history behind each item — who decided what, when, and why the order changed — is in
`docs/HANDOFF.md` and `docs/readme-history.md`.

Done (numbers are the ones the rest of the docs cite):

- **1. Protocol core + s3270-style CLI.** *Using the CLI*.
- **2. Extended data stream + Query Reply** — configurable terminal type, five Query Reply units,
  SFE; what MVS/TSO requires. *Using the CLI*.
- **Alternate screen sizes**, models 3, 4 and 5, live-verified; the geometry rides in the
  terminal-type string, so they never depended on TN3270E.
- **3. `IND$FILE`**, both directions: CUT on both hosts, DFT on TSO. *File transfer (IND$FILE)*.
- **4. 3279 color and the TUI.** *Using the TUI*.
- **5. TLS**, on by default, with s3270's option spellings and its default inverted; verified
  through an in-repo proxy and against `pubvm.org` port 623. *Connecting over TLS*.
- **6. TN3270E**, including BIND-IMAGE and BIND/UNBIND; witnessed by recorded hosts only.
  *TN3270E*, *Verification*.
- **7. The Electron GUI**, live on both hosts, with a TSO logon completed. *Using the GUI*.
- **8. The web gateway**, the GUI's renderer over a WebSocket, live on both hosts. *Using the web
  gateway*.
- **9. The keypad**, in the GUI, the browser and (as a list) the TUI, and the 122-key keyboard in
  the GUI and the browser; Dup, Field Mark, Sys Req and Newline are reachable. Text selection is
  not the light pen: *What is not implemented*.
- **9a. Interactive `IND$FILE`** in all three interactive front ends: the TUI's `Ctrl-T` form, the
  GUI's transfer window, and the browser's form over the WebSocket (2026-10-22). DFT is chosen by
  the host and lifts CUT's 24x80 limit. *File transfer (IND$FILE)*, *Using the web gateway*.
- **Copy and paste**, GUI and browser. *Copy and paste*.
- **11 and 12. Oversize + `IBM-DYNAMIC`, and model switching** — merged 2026-11-05 (`17129ce`).
  *Oversize*.
- **13. Packaging**: npm packages and native installers for macOS, Linux and Windows, merged
  2026-11-06 (`5669a3a`). *Installing*.
- **14. Close out packaging**: npm trusted publishing with provenance (proven by 0.1.3), GitHub
  releases with seven installers and `SHA256SUMS` (proven by 0.1.4, the latest release), macOS
  signing and notarization (merged `db5a93d`; releases after 0.1.4 are signed), and the CI store
  probe (merged `559ea78`). The Windows `.exe` is unsigned and stays so. `docs/releasing.md`.

Item 10, Programmed Symbols, is now item 19.

Remaining, in the order the author wants it (agreed 2026-11-06; the stores added 2026-11-11):

**Next: x3270 parity, then the stores.** A checklist of x3270 features marked ours, missing or
deliberately skipped; it gates any submission. Then the Mac App Store and the Microsoft Store as an
MSIX (Microsoft signs it). Nothing is submitted before parity.

15. **The rest of the GUI ("milestone B").** `File` → `Connect…` in a running window, recent
   hosts, a config file and preferences, light and dark modes, font choice. See *What is not
   implemented*.
16. **Code pages.** Only `cp037` exists (`packages/core/src/codepages/cp037.ts`), which is wrong for
   any host outside the US: 273 (Germany/Austria), 285 (UK), 297 (France), 500 (international),
   1047 (z/OS Unix), the 1140-family euro pages, and so on. Self-contained, and a correctness gap
   rather than a feature. **DBCS** (Japanese, Chinese and Korean hosts) is a separate, larger item
   and is not scheduled.
17. **Click-to-place-cursor, then the light pen.** Own spec; see *What is not implemented*.
18. **Text printing**: a printer-LU session, SCS and LU3, to a file, a PDF or the print dialog;
   reference x3270's `pr3287`. See *What is not implemented*.
19. **Programmed Symbols, tested with our own `gif2ps`.** See *Graphics* below and *What is not
   implemented*.
20. **Printer graphics through Programmed Symbols, if it is real** — GDDM on 3270 printers with
   the PS feature (some 3287 and 3268 models); check against GDDM's documentation or the GDDM host.
21. **GOCA vector graphics, after Programmed Symbols**, tested against the GDDM-licensed host. See
   *Graphics* below.
22. **Stretch goals.** (a) The "3270 super-terminal": antialiased fonts, any font, GOCA rendered as
   SVG. (b) **5250 support**: RFC 1205 (TN5250) is the spec, the user's System/36 emulator the host.

**Also open, not scheduled above.** The gaps are in *What is not implemented*; these are the ones
it does not list. `forwardKeys` forwards action kinds from the GUI's child windows unfiltered. On
Linux at a forced scale factor 2, glyph edges are blended where Retina macOS doubles cleanly (found
2026-11-06, not investigated). Accessibility (screen readers, keyboard-only use of the dialog and
menus) and auto-update have never been looked at. Live witnesses still owed beyond those that
section names: a modern z/OS or z/VM host (real TN3270E, `IBM-DYNAMIC`, BIND size 0x03 —
`pubvm.org` does not fill this: probed 2026-11-08, it negotiates TTYPE, EOR and BINARY only), and
the CLI's `Set()` with a reconnect against VM.

### Graphics: the fidelity target, and the plan (Programmed Symbols, then GOCA)

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
`GOPHERT GIF` in the archive is a test image, not the viewer.

**VMGIF HAS SINCE BEEN FOUND — BUT AS OBJECT MODULES ONLY.** It is on disk at
`$HOME/vmgif`, dated April 1993: `VMGIF.MODULE.T1` at 84600 bytes, the wrapper execs,
`HELPCMS`, and `TONETABL` — its palette/dither table, which is the most directly useful
piece. **There is no source.** **AND IT CANNOT RUN WITHOUT GDDM — MEASURED 2026-11-06 from the
module itself:** GDDM's application interface stub is linked in with its build tag beside it
(`ADMASLV 91067 V2R3.0 PL77871`, GDDM V2R3, linked March 1991); the loader table resolves `FSINN`,
`GSWIN`, `GSSEG` and twenty-odd `ADM*` entry points to that stub, which passes them to GDDM's
resident code; and its own messages assume GDDM (`Sorry, GDDM could not open the device`, `This is
not a graphics device`, saving to `ADMGDF`). The wrapper EXEC loads nothing because sites provided
GDDM as a shared segment. So VMGIF runs only on a GDDM host, which is what the plan below now has.
Disassembling it is probably unnecessary: decoding GIF from the published spec is no harder than
reverse-engineering a 1993 implementation once Programmed Symbols can push pixels, so VMGIF is best
treated as a *behavioral* reference — evidence of what a 3279 could be made to do, and a palette to
compare against.

**The plan: Programmed Symbols first, then GOCA.**

- **Programmed Symbols (item 19).** On a 3279, all-points-addressable graphics *was* PS: the host
  loads pixel patterns into loadable symbol sets and then writes characters from them, which is how
  the era's viewers worked underneath. The emulator needs the Load PS structured field, the
  symbol-set selection attribute, and drawing host-supplied cell bitmaps. The GUI's blitter already
  draws bitmaps, so this is an addition rather than a second renderer. Its hard dependency is the
  Query Reply (the host sends no PS structured fields until the capability is advertised), not
  TN3270E. **The offline test vehicle is our own `gif2ps`**: decode a GIF, map it onto the 3279
  palette, cut it into cells, reuse identical cells, and emit the PS loads and screen writes as a
  trace, replayed through the existing seams and screenshot goldens, or served by a fake host.
  **Before planning, read the 3279's PS capacity from GA23-0059, not memory**: the number of
  loadable sets and symbols per set, cell size per model, and the color-plane format, which
  together cap how many unique cells an image can use.
- **GOCA (item 21).** The 3179-G and 3192-G accept vector orders in structured fields and
  rasterize locally, so GOCA is a terminal capability; GDDM is the host software that drives it,
  not something this client depends on. `docs/goca-reference-notes.md` holds the research.
- **The live host for both is a GDDM-licensed system the author has found.** It is the check
  `gif2ps` cannot be: GDDM's own output, first through Programmed Symbols and then as GOCA, and
  VMGIF itself. GDDM drives the same primitives, so nothing built for Programmed Symbols is wasted.

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
  `Session.sysreq()` (`core/src/session.ts:1886`) *does* branch on `inTn3270e()` and check the
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
- **NEW-ENVIRON sends five variables; `CHARSET` and `KBDTYPE` are not among them.** Option 39
  is implemented (see *Naming a session with `-devname`*), but only for the variables a host has actually been
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
  at all**, so the witness for FUNCTIONS, BIND-IMAGE and BIND is a *recording* instead:
  x3270's `playback -b` replaying `packages/fixtures/x3270/sscp-lu-data.trc`, one of x3270's
  own test traces, recorded against x3270's test target (`Common/Test/target/target.py`)
  rather than a production host. That target grants BIND-IMAGE and sends a BIND (PLU name
  `IBM0SMAA`, MaxSec-RU 1024, MaxPri-RU 3840, default 24x80, alternate 43x80). Bytes and next
  steps: `docs/live-testing.md`, *TN3270E against a real host*. Still missing: a live UNBIND
  with `BIND_FORTHCOMING`, which no trace or reachable host has produced.

  **A HOST WITHDRAWING TN3270E IS HANDLED BOTH WAYS ROUND, and that took two fixes.** The
  correct byte is `IAC DONT TN3270E`, which a real z/VM 4.4 sends and which tears the
  negotiation down at both layers. Some real hosts send `IAC WONT TN3270E` instead — x3270
  carries a special case for them named, verbatim, *"Ugly hack for hosts that send WONT
  TN3270E instead of DONT TN3270E"* (`Common/telnet.c:1879-1889`) — and until `e789b4f` we
  answered that form with **nothing at all**, because option 40 is something *we* do and the
  handler only reacted to options the *host* does. Both now route through one teardown, and
  the second has a recorded-host witness in `wont-tn3270e.trc`.
- **On the CANVAS the mouse does TEXT SELECTION and nothing else.** A press on the screen starts a
  rectangular selection for copy, in the GUI and in the web gateway alike (the gateway used to
  refuse `copy`, because it would have extracted onto its own machine rather than yours; since
  2026-10-27 the text travels back to the browser — see *Copy and paste*). A press off the screen region — the status line, past the last
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
- **Sys Req over TN3270E (`IAC AO`) has no witness**: neither Hercules system offers TN3270E.
  The classic path (a TEST REQUEST READ heading, not AID `0xf0`) is live-verified on both hosts;
  see *Verification*. On an inhibited keyboard the key is refused, where x3270 would queue it.
- **No keypad button has been clicked at a host, and Dup's TAB is unwitnessed.** All four special
  keys are live-verified from the CLI, which shares `applyAction` with the button but not the HTML
  button's click handler and its IPC hop; Dup's TAB needs a multi-field panel, which needs a logon.
- **`IND$FILE` works in every front end, but nothing reads the host's `RC=` line.** `Ctrl-T`
  opens a form in the TUI, a transfer window in the GUI and an overlay in the browser; the
  browser's bytes travel over the WebSocket, so its local file is on the operator's machine, not
  the gateway's. Closing a form mid-transfer aborts, so the host leaves transfer mode. CUT needs
  24x80; DFT (`-ddm on`) works at any size. The gap: when TSO's `IND$FILE` exits `RC=12` the host
  has already left transfer mode, but we wait out the 30 s frame timeout and then say the host
  "may still be transferring" (`frontend/src/transferRun.ts`, and its copy in
  `cli/src/runner.ts`). Live witnesses for every front end: *Verification*.
- **The GUI is a first slice, not a finished app.** `packages/gui` renders live 3270
  screens from both Hercules systems and takes typed input (see *Verification*). It has a menu
  bar and a Connect dialog for a launch with no host, but still **no preferences store** and no
  `File` → `Connect…` for a session already running — a launch given a host still takes it, and
  every flag, from the command line, exactly as the TUI does. Packaging exists (see *Installing*):
  on npm since 0.1.0, the macOS app signed from the next release (unsigned up to 0.1.4; Windows
  and Linux installers unsigned).
- **The web gateway is a first slice too, and shares fewer flags.** It renders live screens
  from both Hercules systems and takes typed input (see *Verification*), but like the GUI it has
  **no connect dialog, no menus and no preferences**. It also does **not**
  accept `--terminal-type` or `-tn3270e`, and of the host argument it honors only `host:port` —
  an LU list and `N:` are refused by name rather than ignored. A screen taller than the browser
  viewport **scrolls**; it does not reflow, and it will not scale fractionally, because integer
  scaling is a design rule. There is no session list or admin view: sessions are addressed only
  by the id the browser keeps in `sessionStorage`.
- **No Programmed Symbols and no graphics.** `XA.CHARSET` (`0x43`) is parsed and dropped. The
  plan is Programmed Symbols first, tested with our own `gif2ps`, then GOCA, tested against a
  GDDM-licensed host the author has found (*Staging*, items 19-21). `Cell` is already a tagged
  variant so that a renderer dispatches on `kind` rather than assuming a font lookup; that
  variant exists for nothing but PS.
- **No printer sessions.** There is no printer-LU session and no SCS decoder, and the TN3270E
  printer functions (SCS-CTL-CODES, DATA-STREAM-CTL) are never requested. *Staging*, item 18.
- **MF orders are parsed, counted and not applied.** Modify Field would alter an
  existing field's attributes in place. TK5's ISPF sends **zero** of them, measured, so
  deferring it has cost nothing so far; `modifyFieldIgnored` in the parse result is how
  you find out if that changes.
- **A model or oversize change applies at the next connect, never to the live screen.** The GUI's
  Model menu, the browser's `Alt-M` picker and the CLI's `Set()` all refuse while connected or
  connecting (see *Oversize*). The menus offer only fixed choices: a new size is a new `-oversize`
  (or `Set(oversize,...)` in the CLI). The TUI has no chooser for a running session; it changes
  size by being resized and reconnected, and its model by `-model` or, when started with no host,
  the connect prompt's `Model` question. VM/370 honours an oversize live; TSO, a
  modern host, and a menu or picker choice renegotiating against a live host are still owed
  (`docs/live-testing.md`).
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

CI (`.github/workflows/package.yml`) runs on pushes to `main`, release tags and pull requests.
Every leg runs `npm run build`, `npm run typecheck`, vitest and `install-smoke.mjs`.
`ubuntu-latest` and the Node 20.19 leg run `pty-smoke.py` in all three modes. `ubuntu-latest` runs
the GUI harnesses `shot keys clicks select transfer connect seam-errors`, each on `dist/` and on
the bundled app (`TN3270_GUI_MAIN=app`). Every leg that builds installers runs `package-smoke.mjs`
on them. `verify-signatures.mjs` runs on macOS (`signed` on a release, `unsigned` otherwise) and on
Windows (always `unsigned`). `store-probe.mjs` runs on macOS and Windows (`docs/releasing.md`,
*Store probe*). The `browser-*.mjs` harnesses, `drive-e.py`, `drive-playback.py` and every
live-host row below are run by hand, not in CI.

| check | result |
|---|---|
| `npm test` | **pass** — run it for the current count; the figure is not kept here because it went stale within days |
| `npm run typecheck`, `npm run build` | **pass** — silent |
| conformance vs a real x3270 capture | **pass** — 5 of 6 inbound records byte-identical, the sixth differing by design |
| `pty-smoke.py` (no host needed) | **pass** — 12/12, including that ECHO is restored after exit |
| `pty-smoke.py --oversize-auto` | **pass** — 7/7 (2026-11-04): in a 41x100 pty the host is told `IBM-DYNAMIC`, an Erase/Write Alternate puts the OIA on row 41, so 40 rows by 100 columns was measured, and a resize to 51x132 says `applies at the next reconnect` naming 50 rows by 132 columns. Mutation-checked (measuring 2 rows or 0 rows short fails it). The Query Reply is NOT read here (its fake host sends no Read Partition), and no reconnect is driven |
| `pty-smoke.py --prompt` | **runs in CI** — the TUI started with no arguments at a real pty: a TLS answer against a plaintext host fails in the prompt's own words and the retry without TLS connects; `Ctrl-C` at the first question and during a connect both exit 1; ECHO is restored after every sub-run |
| oversize Query Reply vs real s3270 4.5 | **pass, NOT a live host** — with `-oversize 160x62` both ask for `IBM-DYNAMIC`, and the Usable Area and Implicit Partition bytes are identical (`e-server.py --query`) |
| `browser-shot.mjs` — served page vs the GUI's own goldens | **pass** — **1 of 1 case** pixel-identical against the GUI's own golden, which is what says the renderer is shared and not merely similar. (It was 2 cases until 2026-10-06: the keypad case went when the keypad became HTML, since a window of system-font controls is not a pixel the canvas owns) |
| `browser-keys.mjs` — real chords through a real browser | **pass** — 14 chords, 10 actions in order over a WebSocket, **4** asserted absences (`Ctrl+K`, `Alt+M`, `Ctrl+Z`, `F13`) — `Ctrl+K` and `Alt+M` because the keypad toggle and the model picker are intercepted client-side and never reach the gateway (measured 2026-11-05) |
| `keys.mjs` — real Chromium key events in Electron | **pass** — 25 chords, 23 actions in order, 2 asserted absences (`Ctrl+Z`, `F13`), and **2 Model menu popups**, one per `Alt+M` (measured 2026-11-05). One `Alt+M` is on the canvas and one in the keyboard window with its own liveness probe, since `forwardKeys` forwards `geometryMenu` unfiltered and `applyAction` throws on it. **Four of those steps go to a CHILD window** (`kbd:` steps, 2026-10-27): before them no harness here could deliver a keystroke to the keypad or keyboard window at all, which is exactly why a `Ctrl-Shift-C` pressed there froze the main process with the whole suite green — `forwardKeys` forwards any action unfiltered and those windows load their own boot files, not `renderer.js`. Each pair is a chord plus an `attn` LIVENESS PROBE, because a frozen client and a correctly dropped chord both produce no action line. It carries `Ctrl+T`, which **this list exists to have caught and did not**: the chord was dead until 2026-10-01 while the `Xfer` keypad button worked. `Ctrl+B` joined 2026-10-23 for the same reason — it is the GUI's only witness for the keyboard chord, the web's being `browser-clicks.mjs` |
| `transfer.mjs` — the GUI's transfer window under Xvfb | **pass** — **10 of 10 checks**: the window opens, the form draws its 7 applicable rows, a local path and a host file reach the model, submit is refused with `not in 3270 mode`, **the form still takes an edit after that refusal** — the 10th, added 2026-10-01 because a form frozen by a mis-ordered IPC completion passed all nine others — every step was understood, no load failure, no renderer throw, and the client exits on its own. Replay mode with the **native dialog stubbed** — a real modal under Xvfb has nobody to click it and would stall rather than fail. **This is not a live-host check and must not be read as one** |
| `clicks.mjs` — real mouse events at real keypad buttons | **pass** — 9 buttons clicked by label in the GUI's keypad window, 10 actions in order (the `Ctrl-K` toggle plus one per button). No unit test reaches the HTML button's click handler and its IPC hop. The mutation once recorded for this row (a dead canvas `mousedown` listener, 2026-09-16) was measured on the canvas keypad deleted on 2026-10-06 and has not been re-measured on the HTML one |
| `select.mjs` — a real drag on the GUI canvas | **runs in CI** — a real `mouseDown`/`mouseMove`/`mouseUp` through Chromium, the renderer's `cellAt`, the IPC hop and `clipboard.writeText`, then the OS clipboard read back and compared with the exact expected text of a replayed screen. Making the `mousedown` selection branch return early leaves build, typecheck and vitest clean and fails only here |
| `connect.mjs` — the GUI's startup Connect dialog | **runs in CI** — the form is filled through the DOM and submitted with the page's own button; each case gets its own throwaway server, and a plaintext case passes only on `IAC WILL TERMINAL-TYPE` coming back, which a TLS client cannot send. Every Electron PID it started is asserted gone afterwards |
| `seam-errors.mjs` — a test seam whose file cannot be read or written | **runs in CI** (added 2026-11-12) — each case must exit non-zero, within a time bound, with one stderr line naming the path and the error code. It guards the CI failure where an unreadable `TN3270_GUI_REPLAY` trace left the sandboxed client hanging until the job killed it |
| `browser-clicks.mjs` — the served page's clicks, keyboard layout and transfer form | **pass** — 9 keypad buttons in one ordered sequence read back off the gateway's own action log, plus **20 of 20** phase-two checks (measured 2026-11-05): **two on the `Alt-M` model picker** (`picker`: it opens with the current model checked and closes the keypad, `Alt+M` shuts it, a click sends `setGeometry` and the gateway's reply checks the new model, an arrow key moves focus and sends nothing, `Enter` applies, `Alt+M` closes it with a radio focused, and its Disconnect button sits first, disabled on a never-connected replay session; `pickerClosed`, last: the gateway closes the socket under the open picker, which then says so and disables everything), seven on the transfer form, **four on the keyboard**, and **seven on copy and paste**. The copy one drives the REAL `Ctrl-Shift-C` through Chromium's input pipeline rather than calling the page's copy global, so it covers the BINDING as well as the path behind it, and it asserts the real OS clipboard over a sentinel — then presses the chord a SECOND time over a fresh sentinel to prove the selection SURVIVED, which is the only end-to-end witness that a copy does not destroy the rectangle it just sent. Since 2026-11-03 it and `webNativeCopy` (the browser's own copy command) witness the text prefetched at drag end, with no copy frame sent, and `webCopyFallback` holds the prefetch back to witness the older asynchronous path, which a correct run otherwise never reaches; `webCopyRetry` makes that path's write fail, then proves a second press on the same selection copies once the prefetch answers. `webSingleCell` drags inside ONE cell and copies that one character, and `webClickNoCopy` proves a click that moved under 4 px copies nothing. Mutation-measured (2026-10-27): an arm that copies and then clears passed every one of the then 2614 unit tests and the built-artifact ordering pin, and fails only here. One of those four is the keyboard's **ten measured layout properties** over a resized real browser: 118 caps drawn, side-by-side at 1400px and reflowed below at 520px, the special bar left of the main block, the arrow cluster's diamond (up and down sharing a column), the centred PF strip, numpad column alignment, the main block a true rectangle (five equal row right edges) with `Z` centred between `A` and `S`, the Return a plain two-row rectangle with an oversized gap and nothing painted into it, and **no cap clipped**. Every one of those exists because the user found the defect on a screenshot and vitest, having no layout engine, could not see it. **The other three are FUNCTIONAL, added 2026-10-23, and the ten above measured NOT ONE ACTION before them** — proved by mutation, since making every cap dead left all ten green at 8/8. `keyboardCaps` clicks one cap from EVERY region (PF3, Enter, Cursor up, `7`, Attention) and compares the **full action object**, not just its kind — an off-by-one `n` on the PF row keeps every label right and would pass a kind-only check; `keyboardInert` asserts an inert cap (`Caps Lock`) sends nothing at all; `keyboardShift` arms the one-shot, gets `@`, and gets a plain `2` on the next click, because a latch bug in exactly that logic reached the user with every unit test green. **Each cap is asserted on TWO independent witnesses** — what the page sent over the socket and the gateway's own `--log-actions` output after decoding — because a mutation renaming the IPC frame kind in `bridgecore.ts` satisfied the browser-side probe for all five caps and was caught **only** by the gateway's log |
| `browser-lan-copy.mjs` — copy at a plain-`http` LAN address | **pass** — **2 of 2** (measured 2026-11-03): the page is loaded at the machine's own LAN address, where `isSecureContext` is false and there is no `navigator.clipboard`, and a drag then `Ctrl+Shift+C`, and a drag then Meta+C with the `copy` command, each put the text on the OS clipboard, read back from a separate Electron. Chromium only; Firefox and Safari there are a live-pass item. With no LAN IPv4 it exits 77, **SKIPPED, which is not a pass** |
| web gateway vs VM/370, live | **pass** — 42 of 43 rows agree with the CLI; the 43rd is the cursor, at exactly 9x3 ink pixels |
| web gateway vs MVS 3.8j TK5, live | **pass** — 24 of 24 rows agree |
| web gateway reattachment, live | **pass** — same session returned inside the grace window, a new one after it |
| TUI vs MVS 3.8j TK5, live | **pass** — ISPF menu, tutorial paged, clean `LOGOFF` |
| TUI vs VM/370, live | **pass** — CMS answers `QUERY DISK A`, CP reports `LOGOFF AT` |
| `IND$FILE` both hosts, both directions | **pass** — binary round-trips byte-identically. **From the CLI**; the TUI's form drives the same `CutTransfer` and the same command builder, and has its own live row below |
| the TUI's `Ctrl-T` transfer form vs VM/CMS, live | **pass — 2026-09-23** — 29 of 29 steps, both directions, a 249-byte binary **round-tripping byte-identically**, and CMS's own `LISTFILE` confirming the file the form wrote (`V 80`, 4 records). The form renders opaquely over a live screen and `Recfm` correctly appears on the send and not the receive. **The run found a real defect no unit test could: the 24x80 refusal was 109 characters against a 54-column status line and lost every word of its remedy** |
| the same form vs MVS/TSO, live | **pass — 2026-09-24** — 26 of 26 steps, both directions, the same binary **round-tripping byte-identically**, and TSO's own `LISTDS` reporting `VB 1024 BLKSIZE 1028 PS`. Exercises the other dialect (`RECFM(V) LRECL(1024)` parenthesised) and **both TSO quoting conventions in one session** — unquoted on the send, so TSO prepends the userid, quoted on the receive. `Blksize` is drawn here and was absent on VM, which is the applicability rule checked against two real hosts rather than a fixture. Both TSO quoting conventions in one session |
| the GUI transfer window vs VM/CMS and MVS/TSO, live | **pass — 2026-10-02** — `packages/gui/scripts/live-transfer.py`, both directions, 249 bytes byte-identical on each host: CUT on VM (8 of 8 checks), DFT on TSO (9 of 9). Driven by hand against TSO again on 2026-10-27. `docs/live-testing.md`, *The GUI transfer window* |
| the browser transfer overlay vs VM/CMS, live | **pass — 2026-10-22, by hand** — Firefox on a different machine from the gateway, through a reverse proxy, both directions, 249 bytes byte-identical. CUT only: TSO/DFT has not been driven from a browser. No harness can do this one, because a `DrawCell` carries a glyph index and no character |
| `Lrecl` with `Recfm=V` on CMS | **pass — 2026-09-24** — three cases in one session: `RECFM V LRECL 80` and `RECFM V` alone both store `V 80`, while `RECFM F LRECL 80` stores `F 80`. **The third case is what makes the first two evidence**, since without it "the two V cases match" cannot distinguish a host ignoring the keyword from a client never sending it. The 1000-byte payload was deliberately not a multiple of 80 |
| mid-flight cancellation vs VM/CMS, live | **pass — 2026-09-24** — canceling a 200KB upload at **17641 of 204800 bytes** made MECAFF's `IND$FILE` answer `>> TRANS99 - Protocol error` and return CMS to `Ready;`: **the host left transfer mode**, which is the whole purpose of aborting rather than abandoning. The final count was 24261, not 204800, which is what proves it was mid-flight rather than before the first frame or after the last. **An aborted upload leaves a PARTIAL file on the host** — correct, since the host wrote what it received |
| the same, vs MVS/TSO, live | **pass — 2026-09-24** — canceled at **15430 of 204800**, final count 23162, and TSO returned to `READY`. **The observable differs and the difference is instructive**: MECAFF announces `>> TRANS99 - Protocol error`, while Rayborn's FFTP says **nothing at all** and simply ends. So *"the host printed an error"* is not the test — *"the next command is obeyed"* is, which both `ERASE`/`DELETE` show. A partial file is left on both |
| TLS vs both hosts, live | **pass** — verified chain via `-cafile` through the in-repo proxy; default TLS at a plaintext host fails in 10 s naming `-insecure` rather than hanging |
| model 4 (43×80) vs VM/370, live | **pass** — host sends `f5` (Erase/Write, 24×80) then `7e` (Erase/Write **Alternate**, 43×80); 41 fields, no program checks |
| GUI vs VM/370 and MVS 3.8j, live | **pass** — renders both; ink compared row-by-row against the CLI's own view of the same host (42/43 and 24/24, the one difference being the cursor); typed input proved end to end through real key events |
| GUI screenshot goldens under Xvfb | **pass** — **2 of 2 cases** from a replayed synthetic trace, reproducible across consecutive runs; raw-bitmap hash, not the PNG. The cases are the default scheme and the `green` scheme. (This row has twice been out of date in both directions: it said "1 case" while there were three, then "3 of 3" after the keypad case was **deleted** on 2026-10-06 — the keypad became HTML controls, and a capture of system fonts is not a pixel the canvas owns) |
| Sys Req vs both hosts, live | **pass, classic path — 2026-09-21** — both predicted forms appeared, one per host: VM's unformatted screen sent the heading plus modified buffer data (`01 6c 61 02 / 11 5b 60`), TK5's formatted panel the heading alone, **no `f0` in either** and no ETX. **VM/370 acts on it** (`RUNNING` → `CP READ`, a second Read Partition, a repaint) where MVS ignores it. The TN3270E `IAC AO` path is still unwitnessed and unobtainable here. **The control run matters: a first attempt ended at 0.003s against the real run's 0.457s and would have credited Sys Req with a transition it could not have caused** |
| Dup vs MVS 3.8j TK5, live | **partial — 2026-09-21** — `0x1c` reached the host with the MDT set (an unmodified field is not transmitted at all) and TSO answered `INPUT NOT RECOGNIZED`, i.e. it read the field and rejected it. **The TAB half is NOT witnessed**: that panel has one unprotected field, where plain `Tab` does not move either — measured in the same session, not assumed |
| Field Mark, Newline vs both hosts, live | **pass — 2026-09-24** — each against a matched control. `docs/live-testing.md`, *Field Mark and Newline against VM/370 and TK5* |
| any keypad **button** vs a live host | **NOT DONE** — the live runs drove the CLI, which shares `applyAction` with the button but not the HTML button's click handler and its IPC hop. The click path is offline-only (`clicks.mjs`, `browser-clicks.mjs`) |
| TN3270E vs real s3270 + in-repo server | **pass, but NOT against a live host** — 10 configurations via `drive-e.py` (7 pre-existing plus 3 for BIND-IMAGE: a granted BIND-IMAGE followed by a size-code BIND, a granted BIND-IMAGE with no BIND — the only end-to-end exercise of the 5s timeout — and `-bind-image off` omitting the function from FUNCTIONS REQUEST). Our `DEVICE-TYPE REQUEST` is byte-identical to s3270's; `FUNCTIONS REQUEST` is now byte-identical too, BIND-IMAGE included |
| TN3270E vs **recorded sessions**, via x3270's `playback -b` | **pass — 10 of 10 traces**, host-free, by `drive-playback.py`. Replays ten recordings: five against other hosts (two commercial VTAM systems among them) and five against x3270's own test target (`Common/Test/target/target.py`) and asserts our replies byte for byte: `WILL TN3270E`, `DEVICE-TYPE REQUEST` with the right model, `FUNCTIONS REQUEST` including BIND-IMAGE, and the full backoff where the host answers `WONT`. Mutation-verified — corrupting the device type or reversing the DEVICE-TYPE operand order reddened all six original traces, and **that operand-order bug is one real s3270 accepts silently**. **Four of those six stop at FUNCTIONS** (a scripted keystroke this harness's short script never drives, or a BID reply we do not implement — see `docs/live-testing.md` for which reason applies to which trace), matching 3 blocks each. **Two get further, and both are new.** `sscp-lu-data.trc` reaches a **real BIND** — 4 blocks (3, 19, 11, 8 bytes), PLU name `IBM0SMAA` — giving BIND parsing its first witness from a recording rather than our own server (the recording is of x3270's test target). `wont-tn3270e.trc` reaches **5 blocks** (3, 19, 11, 3, 3): its host withdraws TN3270E with `WONT` rather than `DONT`, and since `e789b4f` we answer `WONT` and fall back to classic TN3270 as real s3270 does, so that trace is the witness for **that** fix. It stops on a `wrongTerminalName` color-digit divergence that is not our defect. **And since NEW-ENVIRON landed, FOUR MORE traces are drivable and each matches NINE blocks** — `devname_success.trc`, `devname_failure.trc`, `devname_change1.trc`, `devname_change2.trc` — further than every other case here, because option 39's per-request `DEVNAME` exchanges interleave with TN3270E's own steps. `devname_success.trc` was the trace this project originally wanted as its BIND witness and could not drive at all; it now reaches a real BIND with PLU `IBM0SMAJ`. **Mutation-verified to cover the iteration mechanism, not merely the negotiation:** disabling the device-name counter's increment reddens all four with values like `bar0` for `bar1` |
| TN3270E vs a real host (z/VM 4.4, `evievm.pubvm.org:23`), live | **PARTIAL, 2026-09-17 — and the refusal is the HOST's fault** — the host offers option 40 unprompted and sends `SEND DEVICE-TYPE` itself, then answers our request with `IAC DONT TN3270E`; **our backoff reached its logon screen, which is the first live witness for that path.** ~~With no s3270 available for comparison we cannot say which side is wrong.~~ **s3270 4.5ga6 was built here and refused identically in all four recorded device-type variants after a byte-identical request; the host sends no TN3270E subnegotiation at all where RFC 2355 §7.1.5 requires a `DEVICE-TYPE REJECT`. So our client is EXONERATED — and NOT verified:** the negotiation does not complete, so FUNCTIONS, responses and BIND remain untried against any host, and this host cannot try them |

Both Hercules systems are IPLed by hand by the author; `docs/live-testing.md` is both
the runbook and the log of what was found doing it, including the failures. That last
part is deliberate — the write-ups record the author's own diagnostic mistakes,
and they are the most reusable thing in the file.

## License

MIT. See [LICENSE](LICENSE).

**Five fixture files are not ours and are redistributed under x3270's BSD-3-Clause licence**:
`sscp-lu-data.trc` and the four `devname_*.trc` in `packages/fixtures/x3270/` are x3270's own test
traces, copied verbatim from suite3270-4.5, and its notice is reproduced in full in
[`packages/fixtures/x3270/LICENSE-x3270.md`](packages/fixtures/x3270/LICENSE-x3270.md). Everything
else in `packages/fixtures/` was made by this project (recordings by this client or by s3270 against
hosts the author runs, and synthetic traces) and is covered by the MIT licence.

The rest of the reference material this project was built against is **not** redistributed here:
IBM's GA23-0059 3270 Data Stream Programmer's Reference, x3270's source (Paul Mattes,
BSD-3-Clause), tnz/zti, and the host-side `IND$FILE` implementations.
