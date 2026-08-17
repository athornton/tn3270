# Handoff — state as of 2026-08-17

Written to let a fresh session resume without re-deriving anything. Read this,
then `docs/superpowers/specs/2026-08-15-tn3270-client-design.md` (the spec) and
`docs/live-testing.md` (the live-host runbook and log).

## Where things stand

Branch `stage1-protocol-core`, 70+ commits, **318 tests passing**, `npm run
typecheck` clean, `npm run build` works.

**Stage 1 is COMPLETE.** All 18 tasks of
`docs/superpowers/plans/2026-08-15-stage1-protocol-core.md` are done, `README.md`
is written, and three of the plan's four completion checks pass with real output.
The fourth (`record-mvs.txt` → 0 errors) fails for an environmental reason — the
TK5 host has no MVS IPLed — not a client defect; see *Next steps* item 3 and the
plan's Task 18 Step 3. Stage 1 meets the spec's success criterion against the host
that is actually up.

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
  `-model 3278-2`. It always advertises `-E` (TN3270E) with no flag to suppress
  it, so negotiation differs from ours by design; excluded from comparison.
- **Reference sources on disk.** `~/3270/ref/ga23-0059-07.pdf` plus `pages.txt`
  (greppable extracted text; Appendix F is the hex index). x3270 source at
  `~/src/suite3270-4.5/Common/`. tnz source at `~/git/tnz` — the user's preferred
  client, readable Python, and a third reference implementation.
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
3. ~~**TK5 fixture.**~~ **Partly done, and the rest is blocked on TN3270E.** MVS
   3.8j TK5 is up on `localhost:3271` and a pre-logon fixture is committed
   (`mvs-tk5-vtam-logon.trace`): Hercules banner, VTAM's USS logon panel, and an
   `IKT00405I` rejection. Credential-free.

   **TSO logon requires TN3270E, which stage 1 does not implement.** This is the
   cleanest measurement of the session: s3270 reaches TSO advertising
   `IBM-3278-2-E`, and the *same binary* fails exactly as we do — `IKT00405I SCREEN
   ERASURE` — when the `S:` host prefix suppresses the `-E`
   (`telnet.c:2095-2110`). Our inbound records are byte-identical to s3270's
   successful ones. tnz succeeds because it advertises `IBM-DYNAMIC`. Ruled out by
   experiment, not argument: trailing blanks, pacing, and logon syntax; and an
   earlier Query-Reply theory was wrong (the successful run has no Query at all).
   Full write-up in `docs/live-testing.md`.

   So a TSO fixture is the natural first live test *after* TN3270E lands, not
   before. Credentials, from `doc/MVS_TK4-_v100_Users_Manual.pdf`:
   `HERC01`/`CUL8TR`, `HERC02`/`CUL8TR`, `HERC03`+`HERC04`/`PASS4U`,
   `IBMUSER`/`IBMPASS`. The logon procedure is RESET+CLEAR on first connect to a
   terminal address, then the bare userid — or `HERC02/CUL8TR` in one field, which
   skips the password prompt. `TSO` and `LOGON HERC01` both get `INPUT NOT
   RECOGNIZED`.
4. **Stage 2** — the Electron GUI. The renderer constraint to remember: cell
   content is a tagged variant, so dispatch on `kind` rather than assuming a font
   lookup, because Programmable Symbol Sets are a committed stage 4 deliverable.
