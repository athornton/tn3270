# tn3270

A TN3270 terminal emulator for macOS and Linux, in TypeScript.

No good graphical 3270 client has existed for the Mac since Brown University's
tn3270, which stopped being usable somewhere around the transition to OS X. The
options since have been x3270 under X11, commercial Windows emulators, or a
terminal-mode client in a window that does not know it is pretending to be a
3278. This project is an attempt at the client that ought to exist: a real 3270
data-stream implementation with a native-feeling GUI, correct enough that a host
cannot tell it from the hardware.

**Status: stage 1 (protocol core + scriptable CLI) is complete. There is no GUI
yet.** See *What is not implemented* below, which is the honest part of this file.

## What works today

The protocol core and an s3270-compatible scripting CLI. Verified against a live
VM/370 (VM/CE 1.2 under Hercules): the client negotiates telnet, identifies as
`IBM-3278-2`, logs on, IPLs CMS, drives full-screen panels, types into fields,
sends Enter/Clear/PF/PA, reads modified fields back, and logs off — with CMS
answering a CMS command, which is the difference between being understood and
being tolerated.

Inbound records are **byte-identical to real x3270** (s3270 4.5ga6) for every
keystroke case the comparison covers: typed field data, Enter on a
modified-but-empty field, Clear as a short read, and LOGOFF.

## Build and test

Developed and tested on Node 26. `package.json` declares no `engines` floor and
no other version has been tried; the code targets ES2023 with `NodeNext` modules
and imports only `node:fs`, `node:net` and `node:readline`, so Node 18+ ought to
work, but that is inference rather than a tested claim.

```sh
npm install
npm run build      # NOT `npm run build --workspaces`, which fails on the
                   # data-only fixtures package
npm test           # 318 tests
npm run typecheck
```

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
`ScreenText` `ScreenJson` `Ascii` `Snap` · `Trace` `TraceText` `Replay` · `Wait`

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
packages/core      protocol: telnet framing, 3270 parse/execute, screen, keyboard, OIA, trace
packages/cli       s3270-style scripting CLI
packages/fixtures  recorded traces, golden screens, x3270 reference captures
docs/              spec, plan, live-host runbook, handoff
```

Start with `docs/HANDOFF.md`. The design spec is
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`, the stage-1 plan is
in `docs/superpowers/plans/`, and `docs/live-testing.md` is both the runbook for
recording against a real host and the log of what was found doing so.

## Staging

1. **Protocol core + CLI** — done.
2. **Electron GUI** — next.
3. **Packaging** for macOS and Linux.
4. **TLS**, then **TN3270E**, then **IND$FILE**, then printer support, then
   Programmable Symbol Sets. PS follows IND$FILE by preference and TN3270E by
   necessity.

GDDM vector graphics are unscheduled. The fidelity target for graphics is Rick
Troth's 3279 GIF viewer from around 1992.

## What is not implemented

Stated plainly, because a 3270 emulator that quietly does three-quarters of the
job is worse than one that says which quarter is missing.

- **No GUI.** Stage 1 is a library and a scripting CLI. There is no window.
- **No TLS.** Cleartext only, so this is not safe over an untrusted network.
- **No TN3270E.** Base TN3270 only: no device-name negotiation, no BIND/UNBIND, no
  SNA response handling, no printer sessions.
- **Terminal type is hardcoded to `IBM-3278-2`, which is why TSO on MVS is
  unreachable.** Two linked gaps, measured against MVS 3.8j TK5 with the TN3270E
  telnet option never negotiated in any run:
  - Advertising `IBM-3278-2` fails with `IKT00405I SCREEN ERASURE CAUSED BY ERROR
    RECOVERY PROCEDURE`, while `IBM-3278-2-E`, `IBM-3279-2-E` and `IBM-DYNAMIC` all
    reach TSO. Our inbound records are byte-identical to s3270's successful ones.
  - But claiming the `-E` (extended data stream) suffix makes TSO send
    `WriteStructuredField ReadPartition(0xff) Query` and wait for a Query Reply,
    which we do not answer. So the terminal type is the *trigger* and Query Reply is
    the *requirement*: changing the string alone would move the failure, not fix it.

  VM/370 exercises neither, which is how stage 1 got this far. Fixing it means
  answering Read Partition and then making the terminal type configurable — and
  expecting extended orders and alternate geometries we do not yet handle.
- **No extended attributes.** SA, SFE and MF orders are parsed for length and
  then ignored, so colour, highlighting and character sets are recognised but not
  rendered. Note this is more than cosmetic: SFE *defines a field*, so a host that
  used it would leave our screen without that field's structure. Neither VM/370 nor
  MVS 3.8j sends these, which is why stage 1 gets away with it.
- **No Programmable Symbol Sets** and no graphics.
- **No Query Reply.** Write Structured Field is parsed but never answered, so we
  cannot advertise a screen geometry. Two measured consequences: a host that has
  learned an alternate size from a different client on the same device may drive us
  with addresses outside 80×24 (stage 1 reports that as a program check rather than
  silently wrapping), and **TSO on MVS waits on a Read Partition Query we never
  answer** — see the terminal-type entry above, which is the same problem seen from
  the other end. See the spec's *Outbound* section; this is measured, not theory.
- **80×24 only.** `Screen` takes its geometry as a parameter, so this is a
  configuration limit rather than a structural one.
- **MVS reaches VTAM but not TSO.** Everything else above was verified against
  VM/370. On MVS 3.8j TK5 we negotiate, render the TK5 logo and VTAM's USS logon
  panel correctly, and VTAM answers us — but TSO rejects our hardcoded terminal
  type, per the entry above, so `packages/cli/scripts/record-mvs.txt` remains a
  draft and there is no TSO fixture. Details in `docs/live-testing.md`.

## Stage 1 completion check

Run 2026-08-17. The plan defines four checks; three pass and one cannot pass yet.

| check | result |
|---|---|
| `npm test` | **pass** — 318 tests, 18 files |
| `npm run typecheck` | **pass** — silent |
| `npx vitest run …/conformance.test.ts` | **pass** — 2 tests, running against a real x3270 capture, not skipped |
| `record-mvs.txt` → 0 errors | **fails: 10 errors** |

The MVS check fails for an environmental reason, not a client defect. The TK5
instance on hand is running Hercules but MVS was never IPLed — it was started with
`hercules -f conf/tk5.cnf` rather than TK5's `./mvs` launcher, so
`HERCULES_RC=scripts/ipl.rc` was never set and the `ipl 390` in it never ran. The
terminal therefore sits on the Hercules connection banner and answers nothing: our
Enter goes out and **zero** host records come back. Devices `00C0-00C6` are VTAM
terminals, and with no MVS there is no VTAM to reply.

The equivalent check against VM/370 does pass, with the fixed script:

```sh
$ node packages/cli/dist/main.js < packages/cli/scripts/record-vm.txt | grep -c '^error$'
0
```

77 commands, 0 errors, 0 program checks, reaching CMS `Ready;`.

So stage 1 meets the spec's success criterion on the host that exists, and the
one unmet check is waiting on a system to be IPLed rather than on code.

## License

Not yet chosen.
