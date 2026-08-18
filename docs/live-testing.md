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
- **Logon sequence fixed 2026-08-17.** The scripts now reach CMS `Ready;` and log
  off cleanly; the old ones stalled at `CP READ` because of three host behaviors
  documented under *The logon sequence*. The committed VM fixture and golden still
  come from the old, pre-CMS run and are due to be re-recorded.
- **MVS 3.8J TK5 — pre-logon capture recorded 2026-08-17.** TK5 Update 5 on
  `localhost:3271`. We negotiate, render the TK5 logo and VTAM's USS logon panel,
  and VTAM answers us. Fixture `mvs-tk5-vtam-logon.trace` + golden; no credentials
  in it. **TSO is not reached: this TSO rejects the terminal type `IBM-3278-2` that
  we hardcode.** Not a TN3270E problem — `IBM-3278-2-E` reaches TSO with the TN3270E
  option never negotiated. See the Recording log. `record-mvs.txt` remains a draft.

## Step 1 — Confirm the host is reachable

Substitute the real host and port (do not guess; get these from whoever
stood up the Hercules instance):

**There is no way to probe this port without Hercules logging an error, short of
completing the telnet negotiation.** Read the source before trying to be clever
here — `console.c:2955-2989` in the Aethra build (`~/git/aethra/console.c`, the one
running on this box) loops on `recv()` and will not leave that loop until it has
learned the client's **terminal type**:

```c
if ((rc = recv( csock, buf, sizeof( buf ), 0 )) > 0) { ... telnet_recv(...); }
else {
    if (rc == 0) WRMSG( HHC02908, "E", ... );   // "Connection closed during negotiations"
    else         WRMSG( HHC02909, "E", ... );   // "Recv() error during negotiations: %s"
    disconnect_telnet_client( tn ); return NULL;
}
} while (1 && !tn->ttype[0] && !tn->neg_fail && !tn->send_err && !tn->overflow);
```

So *any* disconnect before the `TERMINAL-TYPE IS` subnegotiation is an error, and
the only choice is which error. Which one you get depends on whether Hercules'
greeting was left **unread** in the client's receive queue, because abandoning
unread data is what makes Linux send RST instead of FIN. **Measured against the
real host** in a labelled four-phase run (consecutive client IDs 302-305, each
phase isolated by 15 s of silence):

| what the client does | close | message |
|---|---|---|
| `cat < /dev/null > /dev/tcp/HOST/PORT` — greeting abandoned unread | RST | `HHC02909E Recv() error … reset by peer`, `console.c(2974)` |
| open, `recv()` the greeting, `shutdown(SHUT_WR)` | FIN | `HHC02908E Connection closed during negotiations`, `console.c(2971)` |
| negotiate through `ttype`, then close | after negotiation | `HHC02914I … ttype = 'IBM-3278-2'` then `HHC01022I`, **no error** |

A local mimic of the server got the first row backwards, predicting `HHC02908E`
for the one-liner on the theory that its FIN outruns the greeting. Against the real
host it is `HHC02909E`: the greeting does land first, so there *is* unread data to
abandon. The mimic was not faithful enough — Hercules writes its greeting from
inside libtelnet during the first `recv()`, and the timing that produces cannot be
reproduced by a hand-rolled `accept()`/`send()`/`recv()` loop. Trust the labelled
run against the real host over the mimic.

Use the bash one-liner. It is the simplest thing that answers the question, and
"which flavour of cosmetic error appears" is not worth extra machinery:

```bash
timeout 5 bash -c 'cat < /dev/null > /dev/tcp/HOST/PORT' && echo reachable || echo unreachable
```

Expected output: `reachable`. If you get `unreachable`, stop here — do not
proceed to record a fixture against a host that isn't actually listening, and
do not substitute a different (e.g. public) host to make progress. There is
no substitute for the real Hercules instance for this task.

**Expect one `HHC02909E` per probe, and do not chase it.** It is
cosmetic: no session is harmed and the port really is reachable. If you want a
probe that leaves the console clean, run the real client — verified to produce
`HHC02914I … ttype = 'IBM-3278-2'` followed by a clean `HHC01022I` and no error at
all, both for a full session and for a bare connect-and-quit:

```bash
printf 'Connect(HOST:PORT)\nWait(3270Mode,20)\nWait(Settle,10)\nScreenText\nQuit\n' \
  | node packages/cli/dist/main.js
```

**Our client is measured clean, not merely argued clean.** In the four-phase run
above, both phases that used the real client produced only informational messages:

```
HHC02915I client 302 COMM: Connection received
HHC02914I 0:02C8 COMM: client 302 negotiations complete; ttype = 'IBM-3278-2'
HHC01018I 0:02C8 COMM: client 127.0.0.1 devtype 3270: connected
/21:36:58 GRAF 2C8 LOGON  AS CMSUSER  USERS = 005
/21:37:00 GRAF 2C8 LOGOFF AS CMSUSER  USERS = 004
HHC01022I 0:02C8 COMM: client 127.0.0.1 devtype 3270: connection closed by client
```

Note `HHC01022I` is *informational* — `console.c:2629` logs it when `recv()` returns
0, i.e. a clean client FIN, which is the normal way a session ends. It is not an
error despite sitting next to error messages in the log. The client closes with
`sock.destroy()` (`packages/cli/src/runner.ts:36`), an abrupt close, but by then
`ttype` is long known and the negotiation loop has been left, so it produces this
same clean pairing — confirmed by a bare connect-and-quit (client 305) that logged
`HHC02914I` + `HHC01022I` and nothing else.

**A `2909`/`2908` interleaved with your session's messages is very likely a
separate connection, not yours.** Client IDs increment per connection and are the
reliable way to tell: in the run above, one full session and three other
connections came out as 302, 303, 304, 305 with nothing unaccounted for. Match on
the ID, not on adjacency in the log — an earlier investigation burned real time
because an `HHC01022I` (our clean close) sat directly above an `HHC02915I` +
`HHC02909E` for an entirely different client, which reads as one event and is two.

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
- **Result (re-recorded 2026-08-17 after the logon fix):** 77 commands, **0 errors,
  0 program checks**, and the session **reaches CMS**. It logs on, IPLs CMS, gets
  `Ready;`, has `QUERY TERMINAL` answered *by CMS* (`AUTOCR OFF, MORE 050 010,
  HOLD ON, TIMESTAMP OFF`), and logs off cleanly with CP's own accounting
  (`CONNECT= 00:00:02 VIRTCPU= …`, `LOGOFF AT 21:48:27`). A CMS command getting a
  CMS answer is the proof we are genuinely past CP, not merely tolerated by it.
- **Fixture:** `packages/fixtures/traces/vm370-logon-logoff.trace` (391 lines),
  golden at `packages/fixtures/screens/vm370-logon-logoff.txt`.
- **Redaction:** the one sent record containing the password was replaced with a
  comment line. Verified zero occurrences of the password's EBCDIC bytes remain
  anywhere in the file. The fixture is replay-faithful only up to the password
  prompt.

  Note the password happens to equal the userid on this system, so the same byte
  sequence also appears legitimately inside `LOGON CMSUSER` and the host's echo of
  it. Those are the userid — not secret, and already in the script — so only the
  bare-password record was redacted. **A naive `grep -c` for those bytes will
  therefore report hits on a correctly-redacted fixture;** check whether each hit
  is preceded by the `LOGON` verb before concluding anything. The host does *not*
  echo the password itself, because the prompt's field is nondisplay (`SF(0x4d)`),
  so unlike the previous capture there is only one record to redact rather than two.

**What this capture exercises** that the previous one could not: the `VM READ`
state, the CMS IPL, disk-access and disk-substitution messages, a `MORE...` pause
released by `Clear`, and a CMS command with a CMS reply. The old capture stalled at
`CP READ` and its golden showed `restart` plus `DMKCFC001E ?CP: QUERY` — both
artifacts of the logon bug described under *The logon sequence*, not host quirks as
previously recorded here.

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
addresses only fitting a 32×80 screen while we identified as `IBM-3278-2`.

**Cause found 2026-08-17: another client taught the host that geometry.** The
client the user actually runs is **`zti`** — the terminal interface shipped by the
`tnz` package (console script `tnz.zti:main`), with the protocol implemented in
`tnz/tnz.py`. Naming matters here only because the *behaviour* below lives in the
library while the *command you type* is `zti`; `~/git/tnz` is the source for both.

It advertises terminal type **`IBM-DYNAMIC`** and answers Read Partition (Query)
with an Implicit Partitions Query Reply whose alternate size comes from the
**terminal window height** — `tnz/tnz.py:265-282` picks `32×80` for any terminal
with at least 32 lines. The user's was 41. VM remembered that for `GRAF 2C8` and
later drove our session with it. `SBA(2399)`/`EUA(→2539)` fit 2560 cells, not 1920.

Two consequences for testing here:

- **Watch for cross-client contamination on a shared device.** Every connection on
  this box lands on `GRAF 2C8`, so a `zti` session from a tall terminal can change
  what the host sends *us* on a later connection. If unexplained out-of-range
  addresses reappear, check what else has touched that device before suspecting our
  parser.
- **To pin `zti` to 80×24, export `SESSION_PS_SIZE=2`** before starting it
  (verified: `_util.py` maps `"2" → (24, 80)`, `"3" → (32, 80)`, `"4" → (43, 80)`).
  The terminal *type* cannot be changed — `terminal_type` is hardcoded to
  `IBM-DYNAMIC` at `tnz/tnz.py:177` with nothing reading an override — so size is
  the available control. Setting it also makes the advertised geometry independent
  of your window size, which is worth doing before any comparison run regardless.

To reproduce the 32×80 condition deliberately, run `zti` from a terminal ≥32 lines
and then connect with our client. See the spec's *Outbound* section.

### MVS 3.8J — a system now EXISTS, but nothing is recorded yet

**Discovered 2026-08-17: MVS 3.8j TK5 (Update 5) is running on `localhost:3271`.**
A second Hercules instance (`conf/tk5.cnf`, cwd
`~/Emulators/S370/mvs-tk5`) is up alongside the VM/370 one on 3270. Its
`CNSLPORT` defaults to 3270, so it took 3271 because VM/370 already held 3270 —
do not assume the port; check `ss -ltn` and the running processes.

What has been established, read-only, without logging on:

- We connect, negotiate, and render its greeting correctly on first contact —
  the TK5 banner with the ASCII cat, credits, and `Device number : 0:00C0`.
- That greeting is **all protected**: 25 `SF(0x60)` plus 8 `SF(0xe8)`, no
  unprotected field and no `IC` order anywhere in the 5 startup records. So TK5
  opens with a dismissal screen needing an Enter, structurally the same as VM's
  banner — the `record-mvs.txt` script, which types `LOGON APPLID(TSO)` as its
  *first* input, will therefore lose it exactly as `record-vm.txt` did. Fix it the
  same way before running it.

**TSO logon on this system rejects the terminal type `IBM-3278-2`. It does NOT
require TN3270E.** Established by a controlled experiment against the live host —
same script, same byte-identical inbound records, only the advertised terminal type
varying. The fourth row is the one that matters:

| client | terminal type | TN3270E? | result |
|---|---|---|---|
| s3270 | `IBM-3278-2-E` | yes | **reaches TSO**: `HERC02 LOGON IN PROGRESS`, `Welcome to the TSO system on TK5R` |
| s3270, `S:` host prefix | `IBM-3278-2` | no | `IKT00405I SCREEN ERASURE CAUSED BY ERROR RECOVERY PROCEDURE` |
| ours | `IBM-3278-2` | no | `IKT00405I` — identical |
| s3270, `S:` prefix + `-oversize 80x24` | **`IBM-DYNAMIC`** | **no** | **reaches TSO** — `Welcome to the TSO system on TK5R` |
| `zti` (the `tnz` package) | `IBM-DYNAMIC` | no (off by default) | reaches TSO, ISPF, clean logoff (per the user, `HERC02/CUL8TR`) |

Row 4 isolates the variable. The `S:` prefix sets `HOST_FLAG(STD_DS_HOST)`, which
suppresses the `-E` suffix in `create_3270_termtype()` (`telnet.c:2095-2110`), and
`-oversize` makes that same function return `IBM-DYNAMIC` (`telnet.c:2100-2101`).
Verified on the wire: `fffa1800 49424d2d44594e414d4943 fff0` = `IBM-DYNAMIC`, and
**zero** `fffb28`/`fffd28` — no TN3270E negotiation anywhere in the successful run.
`zti` corroborates: `use_tn3270e` defaults to `False` (`tnz/tnz.py:91`) and is only
enabled by `SESSION_TN_ENHANCED` (`ati.py:2654-2656`), which the user has not set.

So `IBM-3278-2` is the thing this TSO rejects, and either `-E` or `IBM-DYNAMIC` gets
past it. Our client is not at fault in its data stream — our inbound records are
byte-identical to the ones s3270 sends when it succeeds
(`7d 5b f8 11 5b 6b c8 c5 d9 c3 f0 f2 61 c3 e4 d3 f8 e3 d9` + field blanks).

**This took three passes to get right, and the intermediate answers are worth keeping
because each was wrong in a different way.**

- **Pass 1: "TSO needs a Query Reply we don't send."** Right about the requirement,
  but asserted before checking whether the Query was even being sent to us — it
  isn't, with our ttype.
- **Pass 2: "TSO requires TN3270E."** Wrong. It rested on rows 1-3 below, which are
  equally consistent with "the ttype string matters"; the `S:` prefix changes the
  `-E` suffix *and* suppresses the TN3270E option together, so it could not separate
  them. Row 4 (`-oversize` forcing `IBM-DYNAMIC` with `S:` still set) isolated it.
  Vary one thing at a time — especially when the convenient conclusion points at a
  feature you have not built.
- **Pass 3, current: the ttype is the trigger and Query Reply is the requirement.**
  Both, in sequence. Reached by diffing the *whole* successful exchange against the
  failing one rather than just the outcome, which is what should have been done first.

The rows below are what isolated the trigger. All runs had **zero** `fffb28`/`fffd28`
in the trace, so the TN3270E telnet option is not involved in any of this:

**Full causal chain, third and final version.** Two things are true in sequence, and
each earlier attempt at this had one half:

1. **The terminal type is the trigger.** With `IBM-3278-2` the host never sends a
   Query at all. With `-E` or `IBM-DYNAMIC` it does.
2. **Query Reply is the requirement.** Claiming extended data stream makes TSO ask
   `WriteStructuredField ReadPartition(0xff) Query`, and it expects an answer.

From s3270's successful `IBM-3278-2-E` trace, in order:

```
> ttype IBM-3278-2-E                     (negotiation)
> 6dffef                                 (Clear)
> 7d5bf8...c8c5d9c3f0f161...             (userid/password — identical to ours)
< EraseWrite ... SetBufferAddress(24,80)
< WriteStructuredField ReadPartition(0xff) Query          <-- TSO asks
> QueryReply(Summary, UsableArea, AlphanumericPartitions, CharacterSets,
            Color, Highlighting, ReplyModes, DDM, RPQNames)   <-- s3270 answers
  → $HASP100 / IEF125I HERC02 - LOGGED ON
```

With `IBM-3278-2` that Query step never happens; instead the host logs
`IKT108I RECEIVE ERROR … SENSE=00000200` and `IEA000I 0C0,IOE` (an I/O error on the
device) and the session dies at `IKT00405I`.

**So advertising `-E` without implementing Query Reply would move the failure, not
fix it** — TSO would start asking and we would not reply. The work is: make the
terminal type configurable *and* answer Read Partition. The user's own `zti` session
confirms the successful shape end to end, with no `IKT108I` and no `IEA000I` anywhere:

```
HHC02914I 0:00C0 COMM: client 13 negotiations complete; ttype = 'IBM-DYNAMIC'
LGN001I TSO logon in progress at VTAM terminal CUU0C0
$HASP100 HERC02   ON TSOINRDR
$HASP373 HERC02   STARTED
IEF125I HERC02 - LOGGED ON - TIME=23.23.05
IEF126I HERC02 - LOGGED OFF - TIME=23.23.16
$HASP395 HERC02   ENDED   /  $HASP250 HERC02  IS PURGED
```

| ttype advertised | TN3270E negotiated | reaches TSO |
|---|---|---|
| `IBM-3278-2` | no | **no** — `IKT00405I` |
| `IBM-3278-2-E` | no | **yes** |
| `IBM-3279-2-E` | no | **yes** |
| `IBM-DYNAMIC` | no | **yes** |

So the whole failure is that we advertise `IBM-3278-2` and this TSO wants the `-E`
form. The `-E` suffix here means *extended data stream* — a 3270 capability claim in
the terminal-type string — which is a different thing from the TN3270E telnet option
(40), and conflating the two is what produced the wrong diagnosis above.

Beware a confound when re-running these: TSO answers a second logon for a
live session with `IKJ56425I LOGON REJECTED, USERID HERC02 IN USE`, which is *not*
the `IKT00405I` failure and means the ttype was accepted. One run was briefly scored
as a failure for this reason. Use a different userid per run (`HERC01`, `HERC02`,
`HERC03`, `HERC04`) or log off properly.

**Consequence for us:** two pieces of work, in this order.

1. **Answer Read Partition (Query)** with at least Usable Area (`0x81`) and Implicit
   Partitions (`0xA6`); s3270 also sends Summary, Alphanumeric Partitions, Character
   Sets, Color, Highlighting, Reply Modes, DDM and RPQ Names, and the minimum this
   TSO accepts is untested.
2. **Make the terminal type configurable** and advertise `IBM-3278-2-E`.

Doing 2 without 1 moves the failure rather than fixing it. Doing 1 first is
harmless — nothing asks us today, since `IBM-3278-2` never elicits a Query.

Then expect fallout, because claiming extended data stream invites extended orders:
SA/SFE/MF are parsed and ignored today (`execute.ts:204`), and SFE *defines a field*,
so a host that uses it would leave our screen without that structure. `IBM-DYNAMIC`
additionally invites host-driven alternate geometry — the 32×80 case above, which
stage 1 reports as a program check.

**An earlier note in the spec said alternate-geometry support "belongs with the
Query Reply work rather than strictly with TN3270E, and `zti` does it without
TN3270E."** That is now confirmed on the wire from three directions: `zti` reaches
TSO with `use_tn3270e = False`, s3270 does the whole Query exchange with zero
`fffb28`/`fffd28`, and the Query is what TSO actually waits on.

Corroborating host-side evidence, from the Hercules console at *every* one of our
connects, before we type anything:

```
IKT108I RECEIVE ERROR,RPLRTNCD=04,RPLFDB2=03,SENSE=00000200,WAITING FOR RECONNECT CUU0C0
LGN001I TSO logon in progress at VTAM terminal CUU0C0
```

**A theory that was wrong, recorded so it is not re-derived — but note the
correction below it:** pass 2's explanation was that the Query is "a *consequence*
of TN3270E negotiation, not the cause", on the evidence that a successful
`HERC02/CUL8TR` run reached TSO with no Query in the exchange and that our own
sessions received no WSF at all (zero structured-field tokens).

**That last sentence used to read "Query Reply is still worth implementing, but it
is not what blocks TSO." That was wrong, and stage 2a proved it wrong on the wire.**
The reason we saw no WSF is that we advertised `IBM-3278-2`, which never elicits a
Query — absence of the Query was a consequence of our own ttype, not evidence about
what TSO needs. Once we advertise `IBM-3278-2-E`, TSO *does* send
`WriteStructuredField ReadPartition(pid=0xff,type=0x02)` and waits on it, and
answering it is exactly what reaches ISPF (2026-08-18 run, `packages/fixtures/mvs/mvs-tk5-tso-ispf.trace`).
So the ttype is the trigger and Query Reply is the requirement, as pass 3 concluded;
TN3270E is needed for neither.

Also ruled out, each by experiment rather than argument:

- **Trailing blanks.** We send the field's 128 EBCDIC blanks back with the userid.
  So does s3270, byte for byte; the host fills the field with `0x40` and x3270's
  `ctlr.c:831` transmits every non-zero `ec`. Not a difference.
- **Pacing.** s3270 waits ~2 s after `Clear` before typing. Matching that pacing
  changed nothing.
- **Logon syntax.** The manual's procedure (`doc/MVS_TK4-_v100_Users_Manual.pdf`,
  *Logon to TSO*) is: RESET then CLEAR on the first connection to a terminal
  address this IPL, then the **bare userid** at the cursor. `TSO` and
  `LOGON HERC01` both get `INPUT NOT RECOGNIZED` from VTAM's USS table.
  `HERC02/CUL8TR` in one field works and skips the password prompt.

**Credentials, from that manual** (not guesses): `HERC01`/`CUL8TR` fully authorized
with RAKF table access, `HERC02`/`CUL8TR` fully authorized without it,
`HERC03` and `HERC04`/`PASS4U` regular users, `IBMUSER`/`IBMPASS` for recovery only.

### The target sequence, and a geometry trap in it

A working `zti` session was captured with `script -B` (2026-08-17) and transcribed
into `packages/cli/scripts/record-mvs.txt`. The sequence:

| screen size | step |
|---|---|
| 24×80 | Hercules banner → `Reset` `Clear` → VTAM USS panel (`Logon ===>`) |
| 24×80 | bare userid `HERC02` + Enter |
| **27×132** | `ENTER CURRENT PASSWORD FOR HERC02-` → password + Enter |
| 27×132 | `HERC02 LOGON IN PROGRESS`, `Welcome to the TSO system on TK5R`, `***` |
| 27×132 | Enter → a fortune cookie, `***` |
| 27×132 | Enter → **ISPF primary option menu** (`USERID: HERC02`, `TERMINAL: 3277`) |
| 27×132 | `X` + Enter → `CLST020 LIST data set not allocated`, then TSO `READY` |
| 27×132 | `LOGOFF` + Enter → `HERC02 LOGGED OFF TSO` |
| 24×80 | `******`, then the VTAM panel again |

**The screen size changes mid-session, at the password prompt, and reverts at
logoff.** That 27×132 was not TSO's choice: `zti` advertised it, derived from the
operator's **171×41 terminal window** (`tnz/tnz.py:265-282` selects 27×132 for ≥27
rows and ≥132 columns — checked, 41 and 171 hit exactly that branch), and TSO used
what the client offered. 27×132 is 3564 cells, well past 80×24's 1920.

Two consequences worth internalising before implementing Query Reply:

- **What we answer the Query with determines the geometry we then have to handle.**
  Reply 24×80 and the session should stay 24×80 throughout; offer more and the host
  will address beyond 1920 cells, which stage 1 reports as a program check. That
  program check is the honest failure and must not be "fixed" by wrapping.
- **This is the same mechanism as the VM/370 32×80 surprise**, seen from the
  cooperative end rather than as cross-client contamination. There, `zti` taught the
  host a geometry and the host later drove *us* with it. Here the client offers a
  geometry and the host uses it immediately. One mechanism, two symptoms.

Two more details from the transcript, both easy to get wrong: **ISPF starts
automatically** from this account's `ISPLOGON` proc — nothing is typed to launch it,
just an Enter past the `***` — and `TERMINAL: 3277` on the ISPF panel is ISPF's own
notion of the terminal, not the telnet terminal type we negotiated.

**A TK5/TSO fixture is no longer blocked — it exists.** An earlier version of this
paragraph said it was "blocked until TN3270E lands", which was wrong twice over: the
blocker was stage 2a (ttype + Query Reply), and TN3270E is not needed at all. The
full session is committed at `packages/fixtures/mvs/mvs-tk5-tso-ispf.trace`
(2026-08-18): Hercules banner, VTAM USS panel, logon, ISPF primary option menu,
clean logoff. 0 errors, 0 program checks.

**Redaction is a two-place job, and the second place is easy to miss.** The password
appears as EBCDIC on the wire (`c3 e4 d3 f8 e3 d9`) *and* as plaintext in a
`ScreenText` dump, because MVS 3.8j echoes the password to the screen with no
masking. Grep for both before committing a re-record.

## Stage 2a results — TSO reached, 2026-08-18

**The acceptance test passes, and it is REPRODUCED — twice, on two different
userids, across a TK5 re-IPL.** `packages/cli/scripts/record-mvs.txt` run with
`-model 3278-2-E` against TK5 on `localhost:3271` reaches the ISPF primary option
menu (`TERMINAL: 3277`) and logs off cleanly to the VTAM panel. 0 errors, 0 program
checks, no `IKT00405I`, no `IKJ56425I`. Run 1 used `HERC02`, run 2 used `HERC01`
after the host was re-IPLed. Fixture (run 1):
`packages/fixtures/mvs/mvs-tk5-tso-ispf.trace`.

Reproducing mattered: the **first** connection to a terminal address after an IPL
takes a different path (the all-protected Hercules banner needing RESET+CLEAR), so a
single run on an already-warmed address would not have shown that the cold path also
works. It does.

What was measured, as distinct from what was assumed:

| Question | Answer | Evidence |
|---|---|---|
| Does the 3-unit Query Reply suffice? | **Yes** | Session proceeds past the Query to ISPF; host never re-queries or rejects |
| Does TSO need a screen bigger than 24×80? | **No** | Every status line reads `24 80`; ISPF reports `TERMINAL: 3277`, which has no alternate size; no address exceeded 1920 |
| Does TK5's ISPF send SA? | **Yes — 113 as HERC02, 92 as HERC01** | `ignored orders: SA=…` trace lines, summed |
| Does TK5's ISPF send MF? | **No, zero on both runs** | same |
| Is TN3270E needed? | **No** | no `fffb28`/`fffd28` anywhere in the run |

**The geometry answer settles a question that had been open since the 32×80
surprise.** The host uses whatever geometry the client advertises; it has no
requirement of its own. The 27×132 in the earlier `zti` capture was `zti` offering
its window size, exactly as the `tnz/tnz.py:265-282` reading predicted. Alternate-size
support is therefore *not* a prerequisite for TSO and remains unimplemented.

**The SA count is why the MF deferral was safe here, and it was measured rather than
hoped.** 113 SA orders are parsed and dropped, costing only colour and highlighting;
zero MF orders means nothing relied on the field-modifying behaviour stage 2a omits.
Had MF appeared, the pre-agreed response was to fold 2a and 2b together. The counters
were shown able to report a *presence* (a unit test asserts non-zero on a synthetic
SA/MF record) before this run's zero was trusted — stage 1 lesson 7 applied
deliberately.

**One known divergence from x3270, found during implementation and not fixed.** We do
not raise the enter-inhibit condition after answering a Query, which GA23-0059 p. 5-53
(`pages.txt:6412`) makes step 1 of Read Partition processing and which x3270 implements
in `query_reply_end()` (`Common/sf.c:929`). For TSO the behaviour coincides — it queries
before any write, so we stay locked either way — but a *mid-session* Query would leave
the keyboard unlocked over a screen the host considers frozen. See the stage 2a spec.

## Conformance against real x3270 — 2026-08-17

**Result: 5 of 6 inbound records byte-identical**, reproduced three times, with
the sixth differing for a known and harmless reason.

The earlier "5 of 5" was recorded before the scripts were corrected on
2026-08-17. Both scripts now dismiss the connect-time banner, which adds one
record at slot 0 — and that added record is the one that differs. It is the AID
sent on the all-protected Hercules banner, where the two clients legitimately
disagree because s3270 has a hardcoded `Wait(InputField)` in `stdinscript.c:437`
before it reads any command, so it is often still blocked on the banner when we
have already moved on. Both forms are correct per x3270's own `ctlr.c:796-830`
(AID + `ENCODE_BADDR(cursor_addr)`, then only modified fields): `7d 40 40` for a
screen with no modified field, `7d 5b 60 11 5b 60` for the logo's field at 1760.

The five records this comparison exists to check — typed LOGON, Enter on a
modified-but-empty field, Clear as a short read, LOGOFF — all match.

Drive s3270 with the `C:` host prefix (`C:127.0.0.1:3270`). Without it s3270 adds
its login-macro `Wait(InputField)` and hangs outright on banner runs, producing
zero inbound records; `compare-conformance.mjs` warns in that case, and the
warning must not be read as a regression.

s3270 4.5ga6 is built locally at `~/src/suite3270-4.5`, so this needs no second
machine. Both clients drive paired scripts against the same host:

```sh
S=~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/s3270/s3270
$S -model 3278-2 -trace -tracefile /tmp/ref.trace 127.0.0.1:3270 \
    < packages/cli/scripts/conformance-vm.s3270
node packages/cli/dist/main.js < packages/cli/scripts/conformance-vm.txt > /tmp/ours.log
node packages/core/tools/compare-conformance.mjs /tmp/ours.log /tmp/ref.trace
```

The matched records cover Enter with typed field data, Enter on a
modified-but-empty field, Clear (a short read — AID byte alone), and LOGOFF.

**Both scripts MUST end with LOGOFF**, and the session must actually reach a
state where `LOGOFF` can be typed — see the `MORE...` trap below. A leftover
logged-on account makes the next run fail, and it makes s3270 hang outright.

**Correction, 2026-08-17: `restart` has nothing to do with the account being
already logged on.** That claim was in this document, in both conformance
scripts, and in HANDOFF.md, and it was wrong. `restart` is simply CP's reply to
any token it does not recognize as a command at `CP READ`. Verified directly:
typing `FOOBAR` at `CP READ` produces `restart` too, on a freshly logged-off
account. The observed `restart` was CP rejecting the *password* as a command,
because the password had arrived at a `CP READ` prompt — see below.

**Excluded from the comparison, deliberately:** telnet negotiation. s3270 always
advertises `IBM-3278-2-E` and has no flag to suppress TN3270E, so the
terminal-type strings differ by design. The 3270 datastream is what stage 1
implements and what is compared. This difference goes away when TN3270E lands.

## The logon sequence — resolved 2026-08-17

**`CP READ` vs `VM READ` was never a client bug. It was a bug in the recording
script, and the client had been correct all along.** We now reach CMS `Ready;`
and log off cleanly, verified repeatedly. Three host behaviors caused it, none of
them guessable from the datastream alone.

### 1. Three screens arrive in 4 ms, and the first Enter is consumed dismissing them

On connect this host sends **three** records back to back, with no input required,
measured 8 connections out of 8:

| t | record |
|---|---|
| 0.003 s | Hercules/Aethra banner — 19 fields, **all protected** |
| 0.004 s | `EraseWrite` … `SF(0x4d) IC` at 1759 — the real input field |
| 0.005 s | `Write` overlaying the VM/370 logo art |

So the banner is always sent and is then wiped 1 ms later. Which screen a client
appears to "start" on is purely a race against that 1 ms, and `Wait(Settle)`
usually lands after all three.

The Enter that follows is consumed dismissing this screen and **its text is
discarded**. The old script typed `LOGON CMSUSER` as its first input, so the LOGON
was thrown away. Everything after was off by one: what the script thought was the
password arrived at a fresh `CP READ` as a command, CP answered `restart`, and no
password prompt ever appeared. Hence `CP READ` forever.

The fix is two Enters after connect, before typing anything.

**A retracted claim, kept as a warning.** An earlier version of this section said
the host "sends nothing at all until it receives an AID", citing a probe that
waited without typing and never saw the field screen, six runs out of six. That
probe script had no `Trace(on)` line, so it was grepping a log containing zero
trace records — it could only ever report "never", whatever the host did. The
timings above come from traced runs and contradict it. Two lessons, both already
learned once on this project: a probe that reports the *absence* of something must
first be shown capable of reporting its presence, and "reliably fast is not
synchronous" cuts both ways — a 1 ms window looks like solid ground until it
doesn't.

### 2. `Wait(InputField)` cannot work on the first screen

The banner is 19 fields, **all protected** — no input field exists on it, and the
host will not send one until it gets an AID. So `Wait(InputField)` here can only
burn its full timeout, emit an `error`, and let the keystroke fire on the way
past. Use `Wait(Settle)`.

### 3. `MORE...` silently eats input

CMS pauses with `MORE...` in the OIA when output fills the screen, and the
welcome banner does exactly that. **We transmit into it** — confirmed on the wire:
a probe typed `ZZTESTZZ` at `MORE...`, our client sent it (`> 7d 5b e8 ... e9 e9
e3 c5 e2 e3 e9 e9`), the host echoed it into the screen buffer, and CMS discarded
it as a command. That is what swallowed the `LOGOFF` and left the account logged
on for the next run. Send `Clear` to release `MORE...` first.

The proof that the fix reaches CMS rather than merely surviving: `QUERY TERMINAL`
is a CMS command, and it now answers `AUTOCR OFF, MORE 050 010, HOLD ON,
TIMESTAMP OFF` instead of `DMKCFC001E ?CP: QUERY`.

### What this cost, and the lesson

The handoff had concluded "our datastream is byte-identical, so the difference is
timing or sequence, not content" and asked the user to investigate the host. Both
halves were wrong in an instructive way. The datastream *was* byte-identical, and
the conclusion drawn from that was still false — because the comparison that
produced it (`conformance-vm.s3270`) **never sends a password at all**; it presses
a bare Enter at the prompt. It could not have been evidence about the logon
sequence either way. Check that a comparison exercises the thing you are
attributing to it.

The user's answer settled it in one line: the normal interactive flow shows no
`restart` anywhere, which made it a symptom rather than background noise.

### Reading the Hercules console log

The user's console log for a healthy interactive logon looks like:

```
/19:54:56 GRAF 2C8 LOGON  AS CMSUSER  USERS = 005
```

Useful for confirming the host's own view: a clean `LOGON AS`, no `HCPxxx` error,
and a timestamp that should match the `LOGON AT` on the screen. `GRAF 2C8` is the
real 3270 device. Every connection we made landed on that same device — `QUERY
CONSOLE` answers `CONS 009 ON GRAF 2C8` (009 is VM's virtual console address), 6
runs out of 6 — so device assignment is *not* a variable to chase here.

**You cannot get timestamps on the live console, so design around it.** `logopt
TIMESTAMP DATESTAMP` exists (`hsccmd.c:920-983`) and is worth setting, but
**tested: it does not change what the interactive console displays** — the
`HHCxxxxx` lines stay unstamped there. It affects `log.txt`, which is not written
until the Hercules session exits. Only CP's own `LOGON`/`LOGOFF` lines carry a time
on the console, because those come from CP rather than from Hercules' message layer.

Two things follow, and they make console correlation tractable:

- **Match on client ID, not on position.** `HHC02915I client NNN` numbers increment
  per connection, so a labelled run maps cleanly onto them (302, 303, 304, 305 for
  four connections) with no timestamps needed at all.
- **Bracket each action with something CP timestamps.** A `LOGON`/`LOGOFF` pair is a
  visible anchor, so ask ordering questions — "which client IDs fall between this
  LOGON and that LOGOFF" — rather than wall-clock ones.

Also note Hercules writes this log to its controlling terminal (its stdout is a
pipe), so an agent cannot read it. It has to be pasted. Ask for a paste of a
*bounded, labelled* run rather than asking the user to count events by eye.

**The console log only ever confirms success, never diagnoses failure.** Per the
user: there is no message for an incorrect password — you simply never get the
`GRAF ... LOGON` line. So its evidential value is one-directional. `LOGON AS`
present means the logon worked; absent means only "no logon happened", which is
equally true of a wrong password, a discarded LOGON command, and a client that
never sent anything.

This is worth stating because that log was one of the two questions the previous
session escalated to the user and then blocked on. It could not have distinguished
the actual cause (the LOGON being discarded by the dismissal screen) from the
suspected one (a rejected password). The console log is a good confirmation tool
and a poor differential one — reach for a trace instead. Note also that Hercules
writes it to its controlling terminal, not to a file, so an agent cannot read it
without the user pasting it.

**Two testing lessons worth keeping:**

- Appending repeated runs to one log file made the evidence unreadable — 31
  "replies" for 15 commands, with a whole disconnected run hiding at the top.
  Use a fresh file per run.
- A probe that connects and samples immediately sees only the first record. This
  host reliably sends three within 5 ms, but "reliably fast" is not "synchronous";
  an 8-connection probe that waited 2.5 s each time was 8-for-8 consistent where
  a no-wait probe looked random.
