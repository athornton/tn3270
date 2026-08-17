# Stage 2a — Extended Data Stream, Query Reply, and a Configurable Terminal Type

Design settled 2026-08-17. Goal: **make MVS 3.8j TSO reachable.** Stage 1 reaches
CMS on VM/370 but dies on TK5 with `IKT00405I SCREEN ERASURE CAUSED BY ERROR
RECOVERY PROCEDURE`, because we advertise `IBM-3278-2` and this TSO wants the `-E`
(extended data stream) form — and claiming `-E` makes TSO send a Read Partition
(Query) it then waits on.

Prerequisite reading: `docs/HANDOFF.md`, and `docs/live-testing.md` for the
measurements behind every claim here. The `-E` suffix in a terminal-type string is
**not** the TN3270E telnet option (40); conflating the two produced a wrong
diagnosis once already. TN3270E is stage 2b and TSO needs none of it.

## Scope

In scope:

1. **Configurable terminal type.** The **default stays `IBM-3278-2`** so the existing
   VM/370 conformance runs and their committed goldens keep passing unchanged; the TSO
   run passes `-model 3278-2-E` explicitly. Changing the default is a separate
   decision, deliberately not taken here.
2. **Answer Read Partition (Query)** with three Query Reply units: Summary (0x80),
   Usable Area (0x81), Implicit Partitions (0xA6).
3. **SFE (Start Field Extended)** implemented as a field-defining order.
4. **SA and MF** left as parse-and-ignore, but *counted and traced*.
5. Correcting two stale paragraphs in `docs/live-testing.md`.

Explicitly **not** in scope, stated so it is not later mistaken for delivered:

- **Alternate geometry / mid-session resize.** We advertise a geometry; we do not
  switch between two. The handoff's "alternate screen geometry" bullet is therefore
  only *partly* delivered by 2a.
- **SA and MF semantics** (see the contingency below).
- **Query List** (Read Partition TYPE=0x03).
- **TN3270E telnet option 40** — stage 2b.

### Contingency, agreed up front

If the live run shows this subset is not enough — TK5 rejecting the 3-unit reply, or
the SA/MF counters showing TK5 actually using those orders — **the response is to
fold 2a and 2b together and implement the full extended data stream plus TN3270E
option 40 in one stage**, rather than growing 2a incrementally. That decision is
made in advance so a failing acceptance test does not turn into scope drift.

## Decisions, and why

### Geometry: advertise 24×80 as both default and alternate

Not a compromise — the manual *prescribes* it. GA23-0059 p. 6-72 on the Implicit
Partition Sizes SDP (`pages.txt:10548-10549`): "If the device does not have an
alternate screen size, the value for the alternate screen size must be that of the
default size."

This is also the geometry in the known-accepted exchange. Decoding x3270's Usable
Area unit from `packages/fixtures/x3270/tso-query-reply.txt` gives W=80, H=24,
BUFFSZ=0x0780=1920, and its Implicit Partitions unit gives 80×24 default and 80×24
alternate. s3270 was run `-model 3278-2`, advertised exactly this, and reached TSO.

**So the open question "does TSO need a larger screen?" is already answered: no.**
Corroborating: the ISPF primary option menu in the captured session reports
`TERMINAL: 3277`, and a 3277 is a 24×80 device with no alternate size at all. The
27×132 in the `zti` capture was `zti` offering its own window size
(`tnz/tnz.py:265-282`), which the host then used — the same mechanism as the VM/370
32×80 surprise, seen from the cooperative end.

Keeping geometry fixed also holds the number of variables at one. The TSO diagnosis
took three passes precisely because more than one thing changed at a time. If the
run reaches ISPF at 24×80, Query Reply is proven with the resize path untouched.

An address beyond 1920 remains a program check. That is the honest failure and must
not be "fixed" by wrapping.

### Query Reply units: the minimal honest set

Summary, Usable Area, Implicit Partitions — and nothing else. x3270 sends ten units
including Color (0x86) and Highlighting (0x87), which are exactly the capabilities
that invite the SA orders we are deferring. Advertising them would have the host
behave correctly while our screen went wrong.

Every unit we send is one we honour. The fixture itself warns that x3270 "sends more
reply units than TSO necessarily requires, and the minimum acceptable subset is
untested", and the project rule is to verify wire constants against the manual rather
than copy them. If TK5 wants more, the failure is informative and the fix is one
entry in the capability list.

### SFE in, SA/MF out

SFE **defines a field**, so ignoring one leaves the screen without that field's
structure and inbound Read Modified cannot find it — a structural error, not a
cosmetic one. SA and MF are decorations by comparison. Splitting here keeps the
stage near its stated size while removing the one failure mode that could make the
acceptance test unpassable for a reason unrelated to Query Reply.

**MF's deferral has a real functional cost, named so a passing test is not read as
proof it is harmless:** MF modifies an existing field's attributes, so a host using
MF to flip a field from protected to unprotected mid-panel leaves us with stale
protection and the operator unable to type where they should. Implementing MF
properly needs the extended-attribute model 2b brings. If the counters show TK5
sending MF, that is a fold-into-2b signal.

### Terminal type: `-model` plus a raw override

`-model 3278-2` / `-model 3278-2-E` for legibility next to s3270 in conformance
runs, and `--terminal-type <string>` taking anything verbatim as the escape hatch for
experiments (`IBM-DYNAMIC`, `IBM-3279-2-E`). The mapping table stays deliberately
tiny — only the two models we can honestly claim at 24×80 — and no model→geometry
inference is baked in while geometry is pinned.

## Architecture

Three new units, following the existing `stream/` split: `parse.ts` decodes bytes to
tokens, `execute.ts` applies tokens to a screen, neither does I/O.

- **`packages/core/src/stream/sf.ts`** — parses the inbound WSF payload into typed
  structured-field tokens. Today `parse.ts:92` lumps the whole payload into one
  opaque `structuredFields` token; this splits it on length-prefixed boundaries and
  recognises Read Partition (SFID 0x01). Unknown SFIDs stay opaque and counted, so a
  host sending something unrecognised is a logged no-op, not an error.
- **`packages/core/src/queryreply.ts`** — builds the reply from a **capability
  list**, per the standing directive in the stage 1 design doc ("Query Reply is
  generated from a capability list, not a hardcoded byte blob"). A `Capability[]` of
  `{qcode, encode(geometry) → bytes}`; the builder emits AID 0x88 then each unit, and
  derives **Summary's QCODE list from the list itself** so it cannot drift out of
  sync with what is actually sent.
- **`packages/core/src/termtype.ts`** — model→ttype mapping, with the raw override
  winning.

Wiring: `execute.ts` gains `sfReply?: 'queryReply'` on `ExecuteResult` alongside the
existing `readRequest`, and `session.ts` sends it through the same
`telnet.sendRecord` path `answerRead` already uses (`session.ts:218-224`).

Rejected: building the reply inside `execute.ts`. Fewer files, but `execute` is a
pure screen-mutating function and Query Reply is neither about the screen nor pure
with respect to config.

**No IAC work is needed.** `telnet.ts:82` already doubles outbound IAC and
`telnet.ts:122` un-doubles inbound, so `sf.ts` sees un-doubled bytes and the
fixture's `ff ff` warning is already satisfied.

## Wire formats, verified against GA23-0059

Every constant below was checked against the manual (`~/3270/ref/pages.txt`), not
copied from the capture.

**Read Partition inbound** (p. 5-50f, `pages.txt:6342-6356`; `L L SFID PID TYPE`):
SFID 0x01, PID 0xFF
for query operations, TYPE 0x02 = Query (0x03 = Query List). Reply AID is 0x88.

**Summary (0x80)** — p. 6-20 (`pages.txt:8569`): all devices must support it; it
lists the QCODEs of every Query Reply supported, including its own.

**Usable Area (0x81)** — p. 6-101 (`pages.txt:11579`): `L L SFID QCODE FLAGS FLAGS W W H H UNITS Xr(4)
Yr(4) AW AH BUFFSZ(2)`. Bytes 0–20 are always mandatory; BUFFSZ (21–22) is required
if any self-defining parameter is present. x3270's unit is L=0x17=23, which accounts
for exactly these bytes.

**Implicit Partitions (0xA6)**, Sizes for Display Devices SDP — p. 6-72
(`pages.txt:10541`):
`L=0x0B SDPID=0x01 FLAGS=0x00 WD WD HD HD WA WA HA HA`. Required for all display
devices; default and alternate must both be nonzero.

**SFE (0x29)** — p. 4-4 (`pages.txt:2880`): `29 <pair-count> <type,value>...`. The field-attribute pair
type is **0xC0**, confirmed twice: the manual's attribute-type table gives
`X'C0' 3270 Field attribute`, and x3270's `include/3270ds.h:230` defines
`XA_3270 0xc0`. (The manual's prose example OCRs as `X'C8'`; that is OCR damage, and
the table plus x3270 agree on 0xC0. Worth recording as an instance of the standing
rule paying off.) We honour the 0xC0 pair and parse-and-drop all others (0x41
highlighting, 0x42 colour, 0x43 character set, …).

**The structural case, from the manual rather than inference** — p. 4-5
(`pages.txt:2882`): "If SFE is
sent with no type-value pairs (zero value for number of pairs), defaults are set."
So an SFE with no 0xC0 pair still defines a field, with attribute 0x00 (unprotected,
unintensified, MDT clear). Skipping the field when the pair list lacks 0xC0 would
lose the field entirely — the exact structural failure SFE is being implemented to
avoid.

## Data flow

```
host: f3 00 05 01 ff 02                    (WSF, after telnet un-doubles ff ff)
  telnet.ts     → record framing, IAC undoubling            (exists)
  parse.ts      → command 'WriteStructuredField', payload    (exists)
  sf.ts         → [{kind:'readPartition', pid:0xff, type:0x02}]
  execute.ts    → result.sfReply = 'queryReply'   (screen untouched)
  session.ts    → buildQueryReply(caps, geometry) → telnet.sendRecord
us:   88 <Summary> <UsableArea> <ImplicitPartitions>
```

Three behaviours to get right, each with a tempting wrong alternative:

- **Query Reply does not touch the screen.** No clear, no cursor move, no keyboard
  change. In particular it must **not** set `keyboardRestore`: WSF carries no WCC,
  and the `AwaitingFirstWrite` release at `session.ts:182` keys off host *writes*. A
  Query arriving while we are still locked leaves us locked, because the host has not
  written anything.
- **Only TYPE=0x02 is answered.** Query List (0x03) carries REQTYP and a QCODE list
  needing subsetting rules we have not implemented (p. 6-19, `pages.txt:8502`). It is parsed, counted,
  and deliberately **not** answered — we log it and the host times out, rather than
  sending a reply whose rules we guessed. TK5 sends 0x02; if it ever sends 0x03 the
  trace says so.
- **PID is recorded, not assumed.** The reply carries no PID of its own, but `sf.ts`
  keeps the incoming PID so a non-0xFF Read Partition (a real partition read, which
  we do not support) is distinguishable in the trace from the query case.

## Error handling

Reuse the existing pattern, do not invent one. A malformed structured field — length
below 3, or a length running past the payload end — raises `ParseError`, which
`session.ts:200-208` already maps to `X PROG` with `PROG_INVALID_COMMAND` while
keeping the connection up.

**A zero-length structured field (L=0) is the specific nasty case**, because a naive
loop reads it as "advance by zero" and spins forever. It is a `ParseError`, and it
gets its own test.

## Testing

Four tiers, mirroring the existing suite (18 files, 319 tests at the 2a baseline).
TDD applies: the manual is precise enough to write failing tests first.

**1. Unit tests from the manual, before the code.** Byte layouts asserted against
GA23-0059 with the page cited in each test, not against x3270's capture. Nasty cases
required: zero-length SF; length past payload end; WSF with a trailing partial field;
SFE with no 0xC0 pair; SFE with an unknown pair type; Read Partition with TYPE=0x03;
Read Partition with PID≠0xFF.

**2. One golden-bytes test against the fixture — a comparison, not an oracle.** Our
reply will *not* equal x3270's 183 bytes (3 units against 10), so the assertion is
scoped to what is comparable: parsing the host's Query from the fixture must yield
`{pid:0xff, type:0x02}`, and our three units must be byte-identical to the
corresponding three extracted from x3270's reply, which this host is known to accept.
The test comment must state what it does **not** cover: that our *subset* is
acceptable to TSO is unproven until the live run.

**3. Session-level test through the existing fake host** (`session.test.ts:22`): feed
the Query as a record, assert a reply record goes out, the screen is unchanged, and
keyboard state is **not** restored.

**4. The live run — the real acceptance test.** `packages/cli/scripts/record-mvs.txt`
against TK5 on `localhost:3271` (check the port, do not assume) with
`-model 3278-2-E`. **Done means reaching the ISPF primary option menu and logging off
cleanly**, then committing a redacted fixture and golden — the password appears in
the trace in EBCDIC (`docs/live-testing.md` step 4).

Two stage-1 lessons applied deliberately:

- **A fresh log file per run, never appended** (lesson 1: appending produced 31
  "replies" for 15 commands and several wrong conclusions).
- **Prove the SA/MF counters can report a presence before trusting their absence**
  (lesson 7: a probe lacking `Trace(on)` reported "never" six runs out of six and the
  false claim reached committed docs). Assert the counters non-zero on a synthetic
  SA/MF record first.

Also: use a different userid per run or log off properly. A second logon for a live
session draws `IKJ56425I LOGON REJECTED, USERID IN USE`, which is *not* the
`IKT00405I` failure and has been misscored as one.

## Documentation to correct

`docs/live-testing.md` carries two pass-2 paragraphs that the pass-3 diagnosis and
the 2026-08-17 resequencing superseded:

- **line 479** — "Query Reply is still worth implementing, but it is not what blocks
  TSO." It *is* what blocks TSO, once the ttype is right.
- **line 537** — "So a TK5/TSO fixture is blocked until TN3270E lands." It is blocked
  on 2a, not on TN3270E.

Both are corrected as part of this stage. Given how much of this project's cost came
from stale claims surviving in docs, leaving them would be a known defect.
