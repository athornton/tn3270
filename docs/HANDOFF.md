# Handoff — state as of 2026-08-17

Written to let a fresh session resume without re-deriving anything. Read this,
then `docs/superpowers/specs/2026-08-15-tn3270-client-design.md` (the spec) and
`docs/live-testing.md` (the live-host runbook and log).

## Where things stand

Branch `stage1-protocol-core`, 66 commits, **315 tests passing**, `npm run
typecheck` clean, `npm run build` works, working tree clean.

**Stage 1 is functionally complete and verified against a live host.**
Tasks 1–17 of `docs/superpowers/plans/2026-08-15-stage1-protocol-core.md` are
done. Only **Task 18** (README + completion check) remains, and it is unblocked.

### What is proven, not merely tested

- **Live VM/370.** A full scripted session against VM/CE 1.2 under Hercules
  (`localhost:3270`): 43 commands, 0 errors, 0 program checks. CP answered
  `LOGOFF` with its own timestamp, which is what proves the host understands our
  inbound stream rather than merely tolerating it.
- **5 of 5 inbound records byte-identical with real x3270**, reproduced three
  consecutive times. s3270 4.5ga6 is built at `~/src/suite3270-4.5` (the user
  built it), so this needs no second machine. Procedure in `docs/live-testing.md`.
- The host console log shows `ttype = 'IBM-3278-2'` for our connections —
  independent confirmation from the host side. (s3270 shows `IBM-3278-2-E`.)

## The one open problem

**We reach `CP READ`, never `VM READ`.** The password is not being accepted, so
we never IPL CMS. The decisive comparison: **s3270 reaches `RUNNING` where we
reach `CP READ`** on the same host with the same credentials and the same script
shape. Since our datastream is byte-identical for every record we both send, the
difference is *timing or sequence*, not content. The screen shows `restart`
before the password prompt, which may mean CP is treating the connection as a
reconnect rather than a fresh logon.

Two questions were put to the user and are unanswered:

1. When logging on interactively with `zti`, does the screen show `restart`
   before the password prompt, or go straight to asking for a password? That
   distinguishes "normal" from "symptom".
2. Does the host console log show anything when we send the password — a rejected
   logon, a reconnect, an `HCPxxx` message?

**Do not guess at this.** Two wrong conclusions were reached today by reasoning
ahead of the evidence (see *Lessons* below).

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
3. **`LOGOFF` at the end of every live script is mandatory.** CP answers a LOGON
   for an already-logged-on account with `restart` and no input field, so a
   leftover session breaks the *next* run. This presented convincingly as an
   intermittent client-side race for several iterations.
4. **Verify a reference claim against the source, not by inference.** The x3270
   trace-direction bug came from reasoning about the datastream tracer when the
   network tracer uses the opposite sense — and the test written to pin it pinned
   the error instead, because it asserted the mapping abstractly rather than
   anchoring to bytes only one side can send.

## Bug tally, for calibration

54+ real defects found across the project, 8 critical, **nearly all of them
defects in the plan rather than the implementations**. The live host found five
that no amount of offline testing had: unreachable trace, dropped input on
unformatted screens, missing initial keyboard lock, no way to express "ready for
input", and rejected comment lines. Conformance against x3270 found three more.
Subagents found real plan bugs repeatedly and corrected asserted values three
times; that pushback was the single most valuable part of the process.

## Next steps, in order

1. **Task 18** — README and completion check. Unblocked. The README should be
   candid about what is and isn't done: no GUI, no TLS, no TN3270E, no extended
   attributes, no PS, and `VM READ` unresolved.
2. **Resolve `VM READ`** once the user answers, so scripted CMS input works.
3. **Stage 2** — the Electron GUI. The renderer constraint to remember: cell
   content is a tagged variant, so dispatch on `kind` rather than assuming a font
   lookup, because Programmable Symbol Sets are a committed stage 4 deliverable.
4. **MVS 3.8J** whenever the user sets one up. `packages/cli/scripts/record-mvs.txt`
   is prepared but untested; its credentials are TK4-/TK5 defaults.
