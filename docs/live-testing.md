# Live-host testing runbook

**Status: a live VM/370 session has been recorded.** See the *Recording log* at
the end of this document for what ran, what it found, and what remains. MVS 3.8J
has not been recorded — no such system exists yet.

This document is both the procedure and the log: the steps below are what to run,
and the Recording log says what happened when they were run.

## Executed so far

- **VM/370 R6 (VM/CE 1.2) on `localhost:3270` — recorded 2026-08-17.** 43
  commands, 0 errors, 0 program checks. Fixture and golden committed. Five real
  bugs found and fixed; one spec claim falsified. Details in the Recording log.
- **MVS 3.8J — not recorded.** No system configured.
  `packages/cli/scripts/record-mvs.txt` is prepared but untested; its credentials
  are TK4-/TK5 defaults that will need checking against whatever build is used.

## Step 1 — Confirm the host is reachable

Substitute the real host and port (do not guess; get these from whoever
stood up the Hercules instance):

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/HOST/PORT' && echo reachable || echo unreachable
```

Expected output: `reachable`. If you get `unreachable`, stop here — do not
proceed to record a fixture against a host that isn't actually listening, and
do not substitute a different (e.g. public) host to make progress. There is
no substitute for the real Hercules instance for this task.

## Step 2 — Record a session

```bash
node packages/cli/dist/main.js < packages/cli/scripts/record-mvs.txt \
  > /tmp/mvs-session.log 2>&1
grep -c "^ok$" /tmp/mvs-session.log
grep -c "^error$" /tmp/mvs-session.log
```

Expected: many `ok` lines, zero `error` lines. That alone is not sufficient
evidence of success — **read the `ScreenText` output for each step in the
log.** A script that clicks through blind Enter presses can produce all-`ok`
status lines while actually failing a logon (wrong password, APPLID not
found, ISPF not installed) if nothing checks the panel content itself. Confirm
each panel is the panel you expect (TSO logon, TSO READY, ISPF primary menu,
etc.) before trusting anything downstream of this step.

If you see `program check` or `X PROG` anywhere in the log:

```bash
grep -n "program check\|X PROG" /tmp/mvs-session.log
```

that is a real bug in the parser or executor surfaced by a real host — the
exact thing this task exists to find. Fix the code, add a unit test that
reproduces the offending record with a minimal synthetic trace, and only then
re-record.

Repeat with `record-vm.txt` for the VM/370 side if that instance is also
available.

## Step 3 — Extract the trace into a fixture

The session log interleaves the s3270-protocol replies with the trace lines
Trace(on) emits. Pull out just the trace lines:

```bash
grep -E "^[0-9]+\.[0-9]{3} [<>=]" /tmp/mvs-session.log > packages/fixtures/traces/mvs-tso-ispf.trace
wc -l packages/fixtures/traces/mvs-tso-ispf.trace
```

## Step 4 — Redact credentials before this goes anywhere near git

**This is not optional. These files are committed to a version-controlled
repository, and git history is effectively permanent** (rewriting history
after the fact to remove a leaked credential is far more painful than not
committing it in the first place, and a `.trace` file is exactly the kind of
artifact that gets copied elsewhere before anyone notices). Find where the
password appears:

```bash
grep -n "HERC01\|CUL8TR" packages/fixtures/traces/mvs-tso-ispf.trace
```

The password is typed by us, so it appears in the `>` (sent) direction,
encoded as EBCDIC bytes inside a 3270 inbound record — it will not look like
readable text in the hex dump, but it is recoverable by anyone who runs it
through the same EBCDIC table we ship. Replace those specific sent records
(not the whole file, not surrounding unrelated records) with a single `#`
comment line noting what was redacted and why, e.g.:

```
# redacted: sent record containing typed TSO password (see docs/live-testing.md)
```

Because the redacted record is removed rather than replaced with fake bytes,
the fixture is **replay-only up to the logon point** — a golden test can
still exercise the pre-logon negotiation and the VTAM/TSO panels, but nothing
that depends on replaying the exact redacted record byte-for-byte. Say this
explicitly in this file's "Recording log" section for each fixture that had a
redaction, so nobody mistakes the truncation for a bug six months from now.

Use the same credential-redaction check on the VM/370 CP LOGON record, and
on the x3270 reference trace from Task 17 if/when that materializes — a
reference capture typed the same password and is just as exposed.

## Step 5 — Generate the golden screen

```bash
cd packages/core
node tools/make-golden.mjs ../fixtures/traces/mvs-tso-ispf.trace > ../fixtures/screens/mvs-tso-ispf.txt
cat ../fixtures/screens/mvs-tso-ispf.txt
```

Read the output before committing it. It should be recognizable as a real
TSO or ISPF screen — field labels in the right places, no garbage characters,
no obviously-wrong attribute rendering. The golden test in
`packages/core/test/golden.test.ts` (Task 15) picks up any new
`packages/fixtures/traces/*.trace` file automatically and requires a matching
`packages/fixtures/screens/*.txt`; there is nothing else to wire up.

Things to check specifically before committing a golden:
- The screen isn't blank (a trace missing its negotiation replays as blank
  rather than failing — `golden.test.ts` has an explicit test for this, but
  eyeball it anyway).
- The cursor position and OIA line in the golden's header comment look
  sane for wherever the trace ends (e.g. sitting in an input field, keyboard
  unlocked).
- Field boundaries look right for whatever panel this is — no field that
  should be one contiguous block of text and appears with the wrong number
  of attribute bytes.

## Step 6 — Run the full suite

```bash
npm test
```

Expected: all existing tests pass, plus a new golden test for each real
fixture added.

## Step 7 — Commit

```bash
git add packages/fixtures packages/cli/scripts docs/live-testing.md
git commit -m "test: add live-host trace fixtures and golden screens from Hercules"
```

Note in the commit message which fixtures are new and which host/OS produced
them.

## Recording log

### VM/370 R6 (VM/CE 1.2) — recorded 2026-08-17

- **Host:** `localhost:3270` under Hercules, user's machine. Unprivileged account
  `CMSUSER`.
- **Script:** `packages/cli/scripts/record-vm.txt`
- **Result:** 43 commands, **0 errors, 0 program checks**. CP answered `LOGOFF`
  with its own timestamp (`LOGOFF AT 18:27:40 GMT MONDAY 08/17/26`), which is the
  proof that our inbound stream is genuinely understood by the host rather than
  merely accepted.
- **Fixture:** `packages/fixtures/traces/vm370-logon-logoff.trace` (217 lines),
  golden at `packages/fixtures/screens/vm370-logon-logoff.txt`.
- **Redaction:** two records containing the password were replaced with comment
  lines — one we sent, one the host echoed back. Verified zero occurrences of the
  password's EBCDIC bytes (`c3 d4 e2 e4 e2 c5 d9`) remain. The fixture is
  replay-faithful only up to the password prompt.

**Quirks of this capture, not bugs.** `DMKCFC001E ?CP: QUERY` is CP rejecting
`QUERY TERMINAL`, which is a CMS command rather than a CP one — a scripting error
in the original run, kept because a rejected command is a useful thing to have in
a fixture. The session stays at `CP READ` and never reaches CMS; that would need
an IPL, which this script does not do.

**Bugs this session found**, none of which were findable offline:

1. The trace was unreachable — `Trace(on)` enabled it but nothing emitted it, so
   recording a fixture at all was impossible. Added `TraceText`.
2. Input on an unformatted screen was silently dropped. VM's logon screen has zero
   field attributes, and we only iterated fields, so `LOGON` never reached CP.
3. No initial keyboard lock, so `Wait(Unlock)` returned immediately after
   `Connect` and scripts typed into a blank buffer.
4. `Wait` could not express "ready for input"; added `Wait(InputField)`.
5. Comment lines in a script file were rejected as unknown commands — 15 spurious
   errors in the first full run.

It also **falsified a spec claim**: this host sent `Erase/Write Alternate` with
addresses only fitting a 32×80 screen while we identified as `IBM-3278-2`. The
host was reconfigured to stay in 80×24 for stage 1; see the spec's *Outbound*
section.

### MVS 3.8J — not yet recorded

No MVS system exists yet. `packages/cli/scripts/record-mvs.txt` is prepared and
untested; treat its credentials as TK4-/TK5 defaults that will need checking.
