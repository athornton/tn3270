# tn3270

A TN3270 terminal emulator for macOS and Linux, in TypeScript.

No good graphical 3270 client has existed for the Mac since Brown University's
tn3270, which stopped being usable somewhere around the transition to OS X. The
options since have been x3270 under X11, commercial Windows emulators, or a
terminal-mode client in a window that does not know it is pretending to be a
3278. This project is an attempt at the client that ought to exist: a real 3270
data-stream implementation with a native-feeling GUI, correct enough that a host
cannot tell it from the hardware.

**Status: there is a working terminal client.** The protocol core, an
s3270-compatible scripting CLI, extended data stream with Query Reply, 3279 colour,
`IND$FILE` file transfer and a c3270-style TUI are all done and verified against two
live hosts — VM/370 and MVS 3.8j. The Electron GUI is next. See *What is not
implemented* below, which is the honest part of this file.

## What works today

**A usable terminal client, driven interactively against both live hosts.**

```sh
node packages/tui/dist/main.js -model 3278-2-E 127.0.0.1:3271
```

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

Inbound records are **byte-identical to real x3270** (s3270 4.5ga6) in 5 of 6 records;
the sixth differs by design, where s3270 blocks on a hardcoded `Wait(InputField)`.

Two test harnesses come with it, because "it looked right" is not a result:

- `packages/tui/scripts/live-drive.py <tk5|vm>` drives the TUI against a real host over
  a pty and reconstructs what was actually drawn. It counts reverse-video cells and
  solid blocks, and reports whether it confirmed its own logoff.
- `packages/tui/scripts/pty-smoke.py` does the same host-free against a local minimal
  TN3270 server: 12 checks, including that your terminal still echoes afterwards.

## Build and test

Developed and tested on Node 26. `package.json` declares no `engines` floor and
no other version has been tried; the code targets ES2023 with `NodeNext` modules
and imports only `node:fs`, `node:net` and `node:readline`, so Node 18+ ought to
work, but that is inference rather than a tested claim.

```sh
npm install
npm run build      # NOT `npm run build --workspaces`, which fails on the
                   # data-only fixtures package
npm test           # 1037 tests, 37 files
npm run typecheck
```

## Using the TUI

```sh
node packages/tui/dist/main.js [-model M] [--terminal-type T] [--colors N] \
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
erases input, `F1`–`F12` are PF1–12 and `Shift+F1`–`F12` are PF13–24, and `Esc` `1`/`2`/`3`
are PA1/PA2/PA3. Arrow keys are bound in **both** encodings, CSI and SS3, because
terminfo reports only the application-mode one and any layer can flip the mode.

Colours are zti's, not core's: the shared palette in `packages/core` keeps saturated
primaries, and the TUI renders the gentler values zti uses because they read better in a
terminal. Quantisation to 16 colours is an explicit table rather than nearest-RGB — with
any realistic palette, blue and turquoise both fall nearest to cyan and would collide.

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

**A plaintext host does not refuse TLS — it goes quiet.** Hercules sends `IAC DO TN3270E`
and waits, which OpenSSL reads as the start of a record and then blocks for a length that
never comes. So there is a 10-second handshake deadline, and every TLS failure names the
flag that would fix it:

```
127.0.0.1:3270 accepted the connection but never completed a TLS handshake. If it
does not speak TLS — a Hercules or other vintage system — use -insecure.
```

Design and measurements: `docs/superpowers/specs/2026-08-25-tls-support-design.md`.

## Using the CLI

The CLI reads s3270-style commands on stdin, one per line, and writes an
s3270-style status line plus `ok`/`error` after each. `#` comments and blank
lines are ignored.

```sh
printf 'Connect(127.0.0.1:3270)\nWait(3270Mode,20)\nWait(Settle,10)\nScreenText\nQuit\n' \
  | node packages/cli/dist/main.js
```

Or run a script file:

```sh
node packages/cli/dist/main.js < packages/cli/scripts/record-vm.txt
```

**Commands.** `Connect` `Disconnect` `Quit` · `String` `Enter` `Clear` `PF` `PA`
`Attn` `Reset` · `Up` `Down` `Left` `Right` `Home` `Tab` `BackTab` `Newline`
`MoveCursor` · `BackSpace` `Delete` `Insert` `EraseEOF` `EraseInput` ·
`ScreenText` `ScreenJson` `Ascii` `Snap` · `Trace` `TraceText` `Replay` · `Transfer`
· `Wait`

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
packages/cli       s3270-style scripting CLI
packages/tui       c3270-style terminal front end, plus the live/pty harnesses
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

Remaining, in the order the author wants it:

5. **TN3270E proper** — the telnet option (40): DEVICE-TYPE/FUNCTIONS subnegotiation,
   the data header, BIND/UNBIND, SNA responses, device-name (LU) selection. Separated
   from item 2 deliberately: measurement shows TSO needs neither the option nor any of
   this, so bundling them would have delayed a working TSO session for no benefit.
6. **Electron GUI**, then **a webserver serving the same front end**.
7. **Programmable Symbol Sets** — its hard dependency is item 2's Query Reply (the host
   sends no PS structured fields until the capability is advertised), not TN3270E as
   earlier drafts of the spec assumed.
8. Also on the roadmap, position not yet fixed: **packaging** for macOS and Linux,
   **TLS**, and **printer sessions**. TLS may well deserve to jump the queue — a 3270
   client that cannot do TLS is unusable against anything modern.

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
- **No TN3270E.** Base TN3270 only: no device-name negotiation, no BIND/UNBIND, no SNA
  response handling, no printer sessions. Measured, not assumed: neither VM/370 nor
  MVS 3.8j TSO negotiates the option in any run, which is why the client gets this far
  without it.
- **No GUI yet.** There is a terminal front end (`packages/tui`) and a scripting CLI,
  but no window. Electron is next.
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
- **No mouse support** in the TUI.

The TUI has two limits worth knowing before you run it:

- **It needs at least 24 rows and 80 columns**, and refuses smaller rather than drawing
  a misleading partial screen. At exactly 24 rows it drops the status line and keeps the
  screen, which is what c3270 does. Given more room it centres the screen and draws a
  border.
- **Its cursor colour is best-effort.** OSC 12 is not universally implemented, so the
  shape is set via DECSCUSR as well; a terminal that ignores both still shows its own
  cursor.

## Verification

`npm test` and `npm run typecheck` are the fast gate; the interesting checks are the
ones against real systems, because most of the defects this project has found were only
visible there.

| check | result |
|---|---|
| `npm test` | **pass** — 952 tests, 34 files |
| `npm run typecheck`, `npm run build` | **pass** — silent |
| conformance vs a real x3270 capture | **pass** — 5 of 6 inbound records byte-identical, the sixth differing by design |
| `pty-smoke.py` (no host needed) | **pass** — 12/12, including that ECHO is restored after exit |
| TUI vs MVS 3.8j TK5, live | **pass** — ISPF menu, tutorial paged, clean `LOGOFF` |
| TUI vs VM/370, live | **pass** — CMS answers `QUERY DISK A`, CP reports `LOGOFF AT` |
| `IND$FILE` both hosts, both directions | **pass** — binary round-trips byte-identically |

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
