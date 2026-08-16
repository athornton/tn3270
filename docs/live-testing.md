# Live-host testing runbook

**Status as of this writing: no live recording has happened yet.** Nothing in
this document below the "Executed so far" line has been run. This is a
runbook for Task 16 (live host verification) — prepared so that, once a
Hercules instance is reachable, the remaining steps are a matter of running
the commands below rather than designing them from scratch.

## Executed so far

- Nothing. There is no Hercules instance configured for this project yet.
- `packages/cli/scripts/record-mvs.txt` and `packages/cli/scripts/record-vm.txt`
  exist as starting-point scripts (see Task 16 in the stage-1 plan) but have
  never been run against a real host, and are expected to need adjustment
  once real panel text is visible.
- `packages/fixtures/traces/` and `packages/fixtures/screens/` contain only
  the synthetic fixture from Task 15 (`synthetic-ispf-like.*`). No real-host
  trace or golden exists.

Everything from here down is the procedure to follow when a host becomes
available — write down what actually happened as you go, in the "Recording
log" section at the bottom, rather than leaving this file purely aspirational.

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

## Recording log (fill in when recording actually happens)

This section is intentionally empty placeholders. Fill in one entry per
recording session.

### Host details

- Hercules host/port (MVS):
- Hercules host/port (VM/370), if different:
- Host OS build (e.g. TK4- version, TK5 version, or custom):
- Date recorded:
- Hercules version / config notes:

### Per-fixture notes

For each `packages/fixtures/traces/*.trace` file added from a live host,
record here:

- Fixture name:
- Which script produced it (`record-mvs.txt`, `record-vm.txt`, or a
  hand-adjusted variant — if adjusted, note what changed and why):
- What it exercises (e.g. "VTAM logon through ISPF primary menu and logoff"):
- Any redacted records (line numbers, what was redacted):
- Any host quirks encountered (unexpected panel text, non-default APPLID,
  timing sensitivity, program checks found and fixed):
- Whether a VM/370 companion fixture exists and, if not, why (host not
  available, CMS image not provisioned, etc.):
