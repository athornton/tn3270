# Handoff — state as of 2026-08-24

Written to let a fresh session resume without re-deriving anything. Read this,
then `docs/superpowers/specs/2026-08-15-tn3270-client-design.md` (the spec) and
`docs/live-testing.md` (the live-host runbook and log).

## Where things stand

Branch **`tui-and-colour`** (not yet merged; `main` holds stages 1 and 2a),
**909 tests passing in 34 files**, `npm run typecheck` clean, `npm run build`
works, working tree clean.

**THERE IS NOW A WORKING TERMINAL CLIENT.** `packages/tui` is a c3270-style front
end: `node packages/tui/dist/main.js [-model M] [--colors N] host[:port]`. Colour
is stored per cell, resolved through the four-level precedence, quantised to
whatever the terminal supports, and drawn with dirty-cell diffing. The plan is
`docs/superpowers/plans/2026-08-19-tui-and-colour.md`, and
`...-tui-and-colour-PROGRESS.md` carries the findings — read that second file
before touching this work, because most of what cost time is in it rather than here.

**ALL SIXTEEN TASKS ARE DONE, INCLUDING TASK 14's LIVE VERIFICATION.** The TUI was
driven against both Hercules systems on 2026-08-25 and logged off cleanly from
both: **VM/370 10 of 10 steps** (CMS answered `QUERY DISK A` with its disk table,
CP closed with `LOGOFF AT` and its own accounting) and **MVS 3.8j TK5 8 of 8**
(ISPF primary option menu fully rendered, `USERID : HERC04`, `TERMINAL : 3277`,
then `X` to TSO `READY` and a clean `LOGOFF`). Full write-up, including the six
things that cost time, in `docs/live-testing.md` under *TUI and colour results*.

**Colour is proven live: five distinct foreground colours on TK5's ISPF menu**
(green 779, turquoise 416, white 339, neutral-white 322, blue 64), where
`DEFAULT_COLOURS` can only produce four — and turquoise and neutral-white are not
in that map at all, so they came from the host's SA/SFE attributes. The fixture
replay still reproduces its own numbers exactly, so resolution has not moved.

**All four TK5 userids are free.** HERC01-03 were stranded by early harness runs
(quitting the TUI does not log off, and the harness had no teardown yet) and **the
user cleared them from the MVS console on 2026-08-25** — nothing reachable from a
TN3270 client can do it, so that remains the recovery route if it happens again.
The teardown now always runs on a failed flow, and the TK5 flow has since been
**reproduced three times, 8 of 8 steps each, on HERC04, HERC01 and HERC02, with the
userid verified free after every run.**

**Two harnesses, both reusable:**

- `packages/tui/scripts/live-drive.py <tk5|vm>` — drives the TUI against a live
  host over a pty, reconstructing a 25×80 grid from the ANSI stream (you cannot
  grep a diffing renderer's output; see the doc). Password via
  `TN3270_PASSWORD`, userid via `TN3270_USER`. It always attempts a logoff and
  reports `logoff CONFIRMED` — do not trust a run that says otherwise.
- `packages/tui/scripts/pty-smoke.py` — the host-free version: a real pty against
  a local minimal TN3270 server, ten checks including **ECHO restored on the tty
  after exit**. Use it when Hercules is down; exit 0 means all ten held.

**The screen is CENTRED with a border, 2026-08-25.** A JupyterLab terminal is
essentially never 80x24, so slack is spent in priority order rather than shared out:
vertically screen → OIA → bottom border → top border, horizontally screen → left
border → right border, and whatever remains is split evenly with any odd cell falling
bottom/right. So one spare column gets a left border and one spare row gets the OIA.
The OIA outranks the bottom border deliberately (functional beats decorative) and sits
INSIDE the border. `layout()` in `render.ts` is the pure function that decides all of
it, and its test sweeps 22 heights by 5 widths asserting nothing lands outside the
terminal.

**THE TUI HAS ITS OWN PALETTE (2026-08-25), and core's is untouched.**
`packages/tui/src/colours.ts` uses **zti's** colours for F0-F7 and **x3270's** for
F8-FF, because zti advertises only F1-F7 and defines no more. F0 renders as PURE BLACK
there, as zti does, which is why core needs no divergence for a black background -- an
earlier change to core's default bg has been REVERTED and it is `NEUTRAL_BLACK` again,
faithful to `c3270/screen.c:1158`. Quantisation to 16 colours is now an EXPLICIT TABLE,
not nearest-RGB: both references' blue collides with their turquoise under nearest-RGB,
so the palette was previously carrying a burden that belongs to the quantiser.

**A rendering bug fixed the same day, worth knowing about because the class recurs:
SGR parameters ACCUMULATE.** Emitting the attributes a cell wants does NOT clear the
ones it does not; only 0/22/24/25/27 do. A reverse-video run therefore leaked into
everything after it, and ISPF's tutorial title bar turned 2178 blank cells across three
pages into solid colour blocks. `paint()` now resets before setting. The monochrome path
had accidentally been correct, which is why depth-0 tests never caught it. The cursor is a green steady block via OSC 12 plus
DECSCUSR, restored on exit with OSC 112 and `\x1b[0 q`. **OSC 12 is best-effort**: a
terminal that does not implement it ignores it, which is why the shape is set too.

**Terminal geometry, changed 2026-08-25:** the minimum is now **24x80, not 25x80**,
matching c3270 -- the 3270 screen is mandatory and the OIA is optional, so an 80x24
terminal runs with no status line instead of being refused. **SIGWINCH is handled**:
the client re-measures, repaints in full, and below the minimum suspends with a
message rather than clipping, resuming when the terminal grows. Verified end to end
with a real signal in `pty-smoke.py`.

**Still not done, deliberately:** Programmable Symbol Sets (`XA.CHARSET` 0x43 is
still parsed and dropped, and `Cell` is already a tagged variant so the renderer
can dispatch on `kind` when PS lands); MF orders (parsed, counted as
`modifyFieldIgnored`, never applied — TK5's ISPF sends zero of them); mouse
support; the Electron GUI (stage 3); the web front end; and TN3270E (stage 2b).

**IND$FILE FILE TRANSFER WORKS ON BOTH HOSTS, both directions** — MVS/TSO 2026-08-18,
VM/CMS 2026-08-19 (see the following paragraph). See
`docs/superpowers/specs/2026-08-18-indfile-cut-transfer-design.md` for the whole
design and every measurement. In brief:

- CUT mode, not DFT — established from the host's own source and then from the wire.
- Download: `SYS1.PARMLIB(IEASYS00)`, 1742 bytes, correct with CRLF.
- Upload: a 249-byte binary chosen to stress the quadrant machinery round-tripped
  **byte-identically** with `Recfm=variable`. `Recfm=fixed` pads to the record
  boundary, which is correct behaviour and what VMARC wants (`FBLOCK 80 00`).
- The host program is Mike Rayborn's "Free File Transfer Program" 2.0.5 from the CBT
  tape, installed by the user. It needs `-model 3278-2-E`.
- **Retransmit is unit-tested only, and now we know NEITHER HOST CAN TRIGGER IT**
  (measured 2026-08-19, details in the transfer spec under *Retransmit*). MECAFF's own
  source — fetched off the live system with our client — writes exactly three frame-type
  characters, `'C'`/`'A'`/`'B'` = 0xC3/0xC1/0xC2, and never `0x4c`. TSO's closed-source
  program was tested instead: a build that corrupted the checksum of upload frame 2
  produced an **identical** 5-data-request exchange and a successful transfer, and the
  dataset read back byte-for-byte correct. So both hosts ignore the upload checksum and
  neither ever asks for a retransmit. The path stays unit-tested by necessity, not
  neglect; re-test with the same checksum-corrupting harness if a real IBM VTAM or CICS
  host ever appears.

**VM/CMS TRANSFER NOW WORKS TOO (2026-08-19), both directions.** There was no client
bug: `-model 3278-2-E` is required on VM exactly as on TSO (MECAFF's `IND$FILE` refuses
a plain `IBM-3278-2` with "requires a MECAFF connected 3270 terminal"), and the earlier
"zero outbound records" timeouts were a **contaminated account**, not a frame-loop
fault. `PROFILE EXEC A` downloads correctly at 299 bytes, and the same 249-byte binary
as the TSO test round-trips **byte-identically** with `Recfm=variable`, reproduced twice.
Script: `packages/cli/scripts/transfer-vm.txt`, run with `-model 3278-2-E`.

**The trap that produced three false failures, worth internalising: a VM account left
logged on is not "busy" — the next `LOGON` RECONNECTS to the still-running virtual
machine**, which is past its IPL, so a fixed `Enter`/`Enter`/`Clear` opening lands at
`CP READ` and every later command is read by *CP* (`?CP: IND$FILE`) rather than CMS. The
transfer times out at 0 bytes looking like our fault. A failed transfer also never
reaches its own `LOGOFF`, so it hands the trap to the next run. **Live VM scripts must
prove their state** — `transfer-vm.txt` types `QUERY DISK A` first, where `Ready;` means
CMS and `?CP: QUERY` means the run is void — and you should check the log for `LOGOFF
AT` before trusting a rerun. Also note `HostFile` must be QUOTED on CMS
(`HostFile="PROFILE EXEC A"`), because our argument splitter treats spaces as
separators. Details in that spec.

**Two gaps found during stage 2a have since been closed, and both audits found more
than the stated bug:**

- **Enter-inhibit after a Query** is now raised, per GA23-0059 p. 5-53
  (`pages.txt:6413`) and x3270's `query_reply_end()` (`Common/sf.c:929`), and cleared
  by Write/EW/EWA/EAU exactly as x3270 clears it (`ctlr.c:550`, `:1309`, `:1406`).
  The audit also found that **nothing enforced any keyboard lock on typing** —
  `Keyboard.type` consulted no lock at all, so even the pre-existing
  `AwaitingFirstWrite` was advisory. Now enforced, with operator errors excluded the
  way x3270 excludes `KL_OERR_MASK`. `Wait(Unlock)` was likewise blind to it.
- **IAC is now doubled inside telnet subnegotiation data**, required by RFC 855's
  final paragraph and done by x3270. The audit found three further defects on the
  *escaped*-byte path, all the same shape — it skipped gates the plain-byte path
  honours: escaped IACs bypassed both accumulator ceilings entirely (200k `IAC IAC`
  pairs grew a 1024-cap buffer to 200001), and an escaped IAC was stored regardless
  of 3270 mode, **leaking a banner byte into the head of the first real record** —
  the same class as the bug this module already calls "THE regression test".

**STAGE 2a IS COMPLETE AND PROVEN AGAINST A LIVE HOST.** MVS 3.8j TSO is reachable:
the acceptance script reaches the ISPF primary option menu and logs off cleanly, 0
errors and 0 program checks. **TWO FILES SHARE THIS NAME AND ONLY ONE IS
REPLAYABLE** — `packages/fixtures/traces/mvs-tk5-tso-ispf.trace` is the CANONICAL
form that `Replay()` accepts, and `packages/fixtures/mvs/mvs-tk5-tso-ispf.trace` is
raw CLI output with every line prefixed, which `Replay()` accepts with an `ok` and
then produces an EMPTY SCREEN from. Citing the `mvs/` path here without that caveat
cost a later session a wrong turn: it replayed to 0 fields and 1 colour and briefly
looked like a colour-resolution regression. Use `traces/`. Fixture at
`packages/fixtures/mvs/mvs-tk5-tso-ispf.trace`,
full results in `docs/live-testing.md` under *Stage 2a results*. What shipped:

- **Configurable terminal type** — `-model 3278-2` / `-model 3278-2-E`, plus
  `--terminal-type <string>` as a raw escape hatch. **The default deliberately stays
  `IBM-3278-2`**; the TSO run passes `-model 3278-2-E` explicitly. Note the
  conformance goldens do NOT enforce that default (they replay recorded bytes);
  `telnet.test.ts` does, by pinning the subnegotiation bytes.
- **Query Reply** — five units (Summary 0x80, Usable Area 0x81, Color 0x86,
  Highlighting 0x87, Implicit Partition 0xA6), generated from a capability list so
  adding one is a single entry. The three-unit set was accepted by TK5; Color and
  Highlighting were added once SA execution and colour resolution made them honest.
  Byte-identical to x3270 except in Color's fifteen colour-identifier bytes, where
  our capture was taken with x3270 in monochrome mode and we advertise the identity
  pairs unconditionally — see the note on `color` in `queryreply.ts`.
  **Advertising these did not change what TK5 sends us**: it emits SA colour either
  way, which the trace fixture's 113 SA orders (captured before we advertised
  anything) show.
- **SFE** implemented as a field-defining order, including the case that matters: an
  SFE with no 0xC0 pair still defines a field with the default attribute 0x00.
- **SA and MF** still parsed-and-dropped, but now counted and traced.

**Three questions that were open are now answered by measurement:**

1. **TSO does not need a screen larger than 24×80.** The session stayed 1920 cells
   throughout and ISPF reports `TERMINAL: 3277`, a device with no alternate size. The
   27×132 in the old `zti` capture was `zti` advertising its own window size. So
   alternate-geometry support is not a TSO prerequisite and remains unimplemented.
2. **TK5's ISPF sends 113 SA orders and zero MF orders.** The MF deferral therefore
   cost nothing on this path. Had MF appeared, the pre-agreed response was to fold 2a
   and 2b together.
3. **TN3270E is needed for none of this** — zero `fffb28`/`fffd28` in the whole run.

**One known divergence from x3270, deliberately not fixed:** we do not raise
enter-inhibit after answering a Query, which GA23-0059 p. 5-53 makes step 1 of Read
Partition processing and x3270 implements in `query_reply_end()`. Harmless for TSO
(it queries before any write), but a mid-session Query would leave the keyboard
unlocked over a screen the host considers frozen. Details in the stage 2a spec.

**Stage 1 is COMPLETE.** All 18 tasks of
`docs/superpowers/plans/2026-08-15-stage1-protocol-core.md` are done, `README.md` is
written, and three of the plan's four completion checks pass with real output. The
fourth (`record-mvs.txt` → 0 errors) fails because MVS/TSO needs the extended data
stream terminal type and a Query Reply — that is now **stage 2a**, the next work, not
an environmental problem as an earlier version of this paragraph said. (The TK5 host
*was* un-IPLed at one point; it is IPLed now and TSO is reachable by other clients.)
Stage 1 meets the spec's success criterion against VM/370.

**Priority changed 2026-08-17:** extended data stream + Query Reply comes **before**
the Electron GUI, because MVS 3.8j is expected to be the largest group of users and
TSO does not work without it. See *Next steps* item 4, which is where to start.

### What is proven, not merely tested

- **Live VM/370.** A full scripted session against VM/CE 1.2 under Hercules
  (`localhost:3270`): 77 commands, 0 errors, 0 program checks, reaching CMS. CP
  answers `LOGOFF` with its own timestamp and accounting, which is what proves the
  host understands our inbound stream rather than merely tolerating it.
- **CMS reached.** The corrected script logs on, IPLs CMS, gets `Ready;`, has
  `QUERY TERMINAL` answered *by CMS*, and logs off cleanly — repeatedly.
- **5 of 6 inbound records byte-identical with real x3270**, reproduced three
  consecutive times. s3270 4.5ga6 is built at `~/src/suite3270-4.5` (the user
  built it), so this needs no second machine. Procedure in `docs/live-testing.md`.
  The sixth record is the AID sent on the all-protected connect-time banner, where
  the two clients differ by design (s3270 blocks on a hardcoded `Wait(InputField)`
  at `stdinscript.c:437`); both forms are correct per `ctlr.c:796-830`. The
  earlier "5 of 5" predates the banner-dismissal fix, which added slot 0.
- The host console log shows `ttype = 'IBM-3278-2'` for our connections —
  independent confirmation from the host side. (s3270 shows `IBM-3278-2-E`.)

## The one open problem — RESOLVED 2026-08-17

**`CP READ` vs `VM READ` was a bug in the recording script, not in the client.**
We now reach CMS `Ready;` and log off cleanly, verified repeatedly, with `QUERY
TERMINAL` answered by CMS (`AUTOCR OFF, MORE 050 010, HOLD ON, TIMESTAMP OFF`)
rather than rejected by CP. Full write-up in `docs/live-testing.md` under *The
logon sequence*. In short, three host behaviors:

1. **The first Enter is consumed dismissing the screen, and its text is
   discarded.** The host sends three records within 5 ms of connect, no input
   needed: the all-protected Hercules banner, then the real input field
   (`SF(0x4d) IC` at 1759), then the VM/370 logo over the top. The old script
   typed `LOGON` as its first input, so it was thrown away and everything after
   was off by one — the "password" hit a fresh `CP READ` as a command. Fix: two
   Enters after connect before typing.
2. **Use `Wait(Settle)`, not `Wait(InputField)`, on that first screen.** The
   banner is 19 all-protected fields, so for ~1 ms there is no field to match;
   losing that race costs a full timeout and an `error`. Settle doesn't race.
3. **`MORE...` silently eats input.** We transmit into it (verified on the wire)
   and CMS discards it, which swallowed the `LOGOFF` and left the account logged
   on. Send `Clear` first.

**`restart` was misdiagnosed everywhere.** It is not a marker of an
already-logged-on account; it is CP's reply to any unrecognized token at `CP
READ`, confirmed by typing `FOOBAR` on a freshly logged-off account. That wrong
claim was in this file, `docs/live-testing.md`, and both conformance scripts, and
all four are now corrected.

**The instructive part:** the reasoning that sent this to the user was "our
datastream is byte-identical, so the difference must be timing." The datastream
*was* byte-identical, and the conclusion was still false — the comparison behind
it (`conformance-vm.s3270`) never sends a password at all, so it could not have
been evidence about the logon either way. Check that a comparison actually
exercises what you are attributing to it. The user's answer — that the normal
interactive flow shows no `restart` anywhere — is what turned it from noise into
a symptom.

## Environment facts that took effort to establish

- **No compiler, no X, no root on this box.** A userspace GUI toolchain was built
  with a static micromamba into `~/micromamba/envs/gui` (Chromium/Electron libs,
  gtk3, libcups, fontconfig + fonts, Xvfb). Real Electron 43 renders and
  screenshots under Xvfb. Invocation is in the spec's *Development Environment*.
- **s3270 4.5ga6** at
  `~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/s3270/s3270`. Use
  `-model 3278-2`. By default it advertises the `-E` (extended data stream) ttype
  suffix, so its terminal type differs from ours; that is why conformance excludes
  negotiation. **The `-E` suffix CAN be suppressed** — an earlier note here said it
  could not. Host-prefix and flag controls, all verified on the wire:
  - `S:host` → `HOST_FLAG(STD_DS_HOST)`, drops `-E` → `IBM-3278-2` (matches us).
  - `C:host` → skips the login-macro `Wait(InputField)`; needed or it hangs on
    all-protected connect screens.
  - `-oversize 80x24` → forces `IBM-DYNAMIC` (`telnet.c:2100-2101`).
  - Prefixes stack as `S:C:127.0.0.1:3271`, each with its own colon. Writing them
    together as `SC:...` is a syntax error (`double ':'`) — tested.
  None of these turn on the TN3270E telnet option (40); check for `fffb28`/`fffd28`
  in the trace if you need to know whether TN3270E was actually negotiated.
- **Reference sources on disk.** `~/3270/ref/ga23-0059-07.pdf` plus `pages.txt`
  (greppable extracted text; Appendix F is the hex index). x3270 source at
  `~/src/suite3270-4.5/Common/`. Source for **`zti`** — the client the user actually
  drives, and the terminal interface of the `tnz` package — at `~/git/tnz`:
  readable Python and a third reference implementation. Say `zti` for the command
  and `tnz`/`tnz/tnz.py` for the library; they are the same project.
- `npm run build` — **not** `npm run build --workspaces`, which fails on the
  data-only fixtures package.

## Lessons that cost real time today

1. **Never append repeated test runs to one log file.** Doing so produced 31
   "replies" for 15 commands with a whole disconnected run hiding at the top;
   several intermediate conclusions drawn from that mapping were wrong.
2. **A probe that samples immediately after connect sees only the first record.**
   This host reliably sends three within 5 ms, but "reliably fast" is not
   "synchronous". An 8-connection probe that waited 2.5 s each time was 8-for-8
   consistent where a no-wait probe looked random.
3. **`LOGOFF` at the end of every live script is mandatory**, and the script must
   actually reach a state where `LOGOFF` can be typed — at `MORE...` it is
   silently eaten. A leftover logged-on account breaks the next run and hangs
   s3270 outright. (The original form of this lesson blamed `restart` on the
   account being in use. That was wrong; see item 5.)
4. **Verify a reference claim against the source, not by inference.** The x3270
   trace-direction bug came from reasoning about the datastream tracer when the
   network tracer uses the opposite sense — and the test written to pin it pinned
   the error instead, because it asserted the mapping abstractly rather than
   anchoring to bytes only one side can send.
5. **Check that a comparison exercises the thing you are attributing to it.**
   "Our datastream is byte-identical to s3270's, so the logon difference must be
   timing" was false reasoning from a true premise: the comparison script never
   sends a password. A byte-identical result over records that exclude the
   behavior in question is not evidence about that behavior.
6. **Ask the user what normal looks like, early.** One sentence about the
   interactive flow — no `restart` anywhere — reclassified the central symptom and
   cost nothing. It should have been the first question, not the last.
7. **A probe that reports something's ABSENCE must first be shown able to report
   its presence.** A probe script here lacked `Trace(on)`, so it grepped a log with
   zero trace records and dutifully reported "never", six runs out of six. That
   produced a confident, wrong claim ("the host sends nothing until it gets an
   AID") that survived into committed docs until traced runs contradicted it.
   Sanity-check the negative control.
8. **A mimic of the real system is a hypothesis, not evidence.** The Hercules
   `HHC02908E`/`HHC02909E` question took *four* attempts. Attempts 1-2 were armchair
   TCP reasoning. Attempt 3 was a 12-line Python server mimicking Hercules'
   accept/send/`recv()` loop — it reproduced a clean result 6 times running and was
   still **wrong**, because Hercules emits its greeting from inside libtelnet during
   the first `recv()` and the hand-rolled loop could not reproduce that timing.
   Reproducibility inside a mimic measures the mimic. What finally settled it was a
   labelled run against the real host with 15 s of silence between phases, mapped by
   client ID. When the real system is available, instrument *it*; keep the mimic for
   generating hypotheses, and say which one a claim rests on.
9. **Before blocking on a question, check that its answer could change anything.**
   Both questions escalated to the user were answerable and neither could have
   identified the cause. The console log has no message for a bad password — a
   failed logon is simply an absent `LOGON` line — so it cannot distinguish
   "password rejected" from "LOGON never arrived", which is what had happened. It
   confirms success and diagnoses nothing. Ask what *normal* looks like (that did
   crack it); don't block on a signal that is silent in the failure case.
10. **Diff the whole conversation, not just who won.** The TSO diagnosis took three
    passes because the first two compared *outcomes* between a working client and
    ours — succeeded/failed, plus the one negotiation string that differed. Dumping
    both full exchanges side by side showed the actual mechanism immediately: the
    successful one contains a `WriteStructuredField ReadPartition Query` and a
    `QueryReply` that the failing one never even receives. The answer was sitting in
    a trace already on disk through both wrong passes.
11. **When a working reference client is available, get its trace before theorising.**
    s3270 was built locally the whole time. Every wrong turn today would have been
    caught in minutes by reading its successful exchange rather than reasoning about
    what a host "must" want.

## Bug tally, for calibration

54+ real defects found across the project, 8 critical, **nearly all of them
defects in the plan rather than the implementations**. The live host found five
that no amount of offline testing had: unreachable trace, dropped input on
unformatted screens, missing initial keyboard lock, no way to express "ready for
input", and rejected comment lines. Conformance against x3270 found three more.
Subagents found real plan bugs repeatedly and corrected asserted values three
times; that pushback was the single most valuable part of the process.

## Next steps, in order

1. ~~**Task 18** — README and completion check.~~ **Done.** `README.md` written;
   three of the plan's four checks pass, and the MVS one is blocked on the host
   rather than the code (details in the plan under Task 18, Step 3).
2. ~~**Re-record the VM fixture and golden.**~~ **Done.** The fixture now reaches
   CMS `Ready;` and the golden shows a clean LOGOFF instead of `restart`.
3. ~~**TK5 fixture.**~~ **Partly done; the TSO half is what stage 2a unblocks.** MVS
   3.8j TK5 is up on `localhost:3271` and a pre-logon fixture is committed
   (`mvs-tk5-vtam-logon.trace`): Hercules banner, VTAM's USS logon panel, and an
   `IKT00405I` rejection. Credential-free.

   **Two linked gaps block TSO: the terminal type is the trigger, Query Reply is the
   requirement.** We advertise `IBM-3278-2`; TK5's TSO answers `IKT00405I SCREEN
   ERASURE`. Measured with s3270, TN3270E option never negotiated in any run:
   `IBM-3278-2` fails while `IBM-3278-2-E`, `IBM-3279-2-E` and `IBM-DYNAMIC` reach
   TSO. But diffing the whole successful exchange shows *why*: claiming `-E` makes
   TSO send `WriteStructuredField ReadPartition(0xff) Query` and wait for a Query
   Reply, which s3270 answers and we cannot. With `IBM-3278-2` the Query is never
   sent at all. So changing the ttype alone moves the failure rather than fixing it;
   the order of work is Query Reply first, then a configurable terminal type.

   **This took three passes, and the wrong turns are instructive.** Pass 1 said
   "needs Query Reply" — right requirement, asserted before checking the Query was
   even being sent. Pass 2 said "requires TN3270E" — wrong, because the `S:` prefix
   changes the ttype *and* suppresses the option together, so it never separated
   them; `-oversize` forcing `IBM-DYNAMIC` isolated it. Pass 3 got both halves by
   diffing the full exchange rather than the outcome. Vary one variable at a time,
   and diff the whole conversation, not just who won. Full write-up in
   `docs/live-testing.md`.

   So a TSO fixture is the natural first live test *after* TN3270E lands, not
   before. Credentials, from `doc/MVS_TK4-_v100_Users_Manual.pdf`:
   `HERC01`/`CUL8TR`, `HERC02`/`CUL8TR`, `HERC03`+`HERC04`/`PASS4U`,
   `IBMUSER`/`IBMPASS`. The logon procedure is RESET+CLEAR on first connect to a
   terminal address, then the bare userid — or `HERC02/CUL8TR` in one field, which
   skips the password prompt. `TSO` and `LOGON HERC01` both get `INPUT NOT
   RECOGNIZED`.
4. ~~**STAGE 2a — extended data stream + Query Reply.**~~ **DONE 2026-08-18, verified
   against a live host.** All three pieces shipped: configurable terminal type, Query
   Reply, and SFE. The acceptance test (`packages/cli/scripts/record-mvs.txt` with
   `-model 3278-2-E`) reaches the ISPF primary option menu and logs off cleanly.
   Details above under *Where things stand*, measurements in `docs/live-testing.md`.

   **Alternate geometry was NOT delivered and is not needed for TSO** — we advertise
   24×80 as both default and alternate size, which the manual prescribes for a device
   with no alternate size, and the live run confirmed TSO uses whatever the client
   offers. Mid-session resize is unimplemented.

   **Worth knowing about the process, because it was the most productive part:** six
   real defects were found in the *plan* rather than the implementations, every one by
   an implementer checking a primary source instead of trusting the instruction. The
   plan said reject zero-length structured fields (the manual makes them legal, and
   rejecting would have hung on a Query sent as the last field); said `find` where the
   manual requires last-wins (`findLast`); shipped a test helper that OOMed the vitest
   worker because the fixture is IAC-doubled; asserted the conformance goldens enforce
   the default ttype when they cannot; quoted a manual string that greps to zero hits;
   and omitted IAC-doubling from session-level test bytes, which made a negative test
   pass for the wrong reason. Mutation testing during review also found two tests that
   passed with the behaviour they claimed to pin deleted. **Keep asking implementers to
   verify against `pages.txt` and x3270 rather than accepting the task text.**

5. **Stage 2b — TN3270E proper**, the telnet option (40): DEVICE-TYPE/FUNCTIONS
   subnegotiation, the 5-byte data header, BIND/UNBIND, SNA responses, LU selection.
   **Deliberately after 2a, because TSO needs none of it** — zero `fffb28`/`fffd28`
   in any successful run, and `zti` reaches TSO with `use_tn3270e = False`. Its own
   payoff is LU names, printer sessions and response handling.

6. **Stage 3 — the Electron GUI.** The renderer constraint to remember: cell content
   is a tagged variant, so dispatch on `kind` rather than assuming a font lookup,
   because Programmable Symbol Sets are a committed later deliverable.
