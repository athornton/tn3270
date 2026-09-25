# Handoff — state as of 2026-09-25

Written to let a fresh session resume without re-deriving anything. Read this,
then `docs/superpowers/specs/2026-08-15-tn3270-client-design.md` (the spec) and
`docs/live-testing.md` (the live-host runbook and log).

## START HERE — NEXT ACTION, 2026-09-25

**ON BRANCH `dft-file-transfer`, PUSHED, 24 commits, tree clean. `main` is at `b37ffdf`, untouched.
2075 tests in 81 files, build and typecheck clean.** Tasks 1-9 of
`docs/superpowers/plans/2026-09-24-dft-file-transfer.md` are **done**; the full gate was re-run this
session: conformance+golden 12/12, `drive-playback.py` 10/10, `pty-smoke.py` 12/12, `drive-e.py`
10/10, `shot.mjs` 3/3, `keys.mjs` 18/16, `clicks.mjs` 9/10, `browser-shot.mjs` 2/2,
`browser-keys.mjs` 13/11.

**NEXT ACTION: WRITE AND EXECUTE A NEW TASK THAT WIRES `Transfer()` TO DFT. NOTHING SELECTS IT
TODAY.** The DFT engine, the structured-field plumbing and the Read Modified hook are all built and
verified, but `Session.startDftTransfer` has **no caller outside tests** and `runner.ts` constructs a
`CutTransfer` unconditionally, refusing non-24x80 at `runner.ts:454` before a byte goes out. The live
run against TK5 at 43x80 therefore produced **zero DFT frames** — it never reached the wire. Tasks 10,
11 and 12 all depend on that run, so the whole tail is blocked. **This is a gap in the plan, not a
defect in the code**, and it survived nine tasks because every engine test calls `startDftTransfer`
itself — the tests supply the call the product is missing.

**The design decision that task turns on, and it is already answered by x3270: THE CLIENT DOES NOT
CHOOSE THE PROTOCOL — THE HOST DOES.** `ft_running(true/false)` merely *reports* which arrived
(`ft_cut.c:440`, `ft_dft.c:175`, read once at `ft.c:556`). So the honest shape is a transfer that can
be either, with the first inbound frame deciding — which means `runner.ts`'s poll loop cannot assume
CUT frames, and the existing 24x80 refusal must stay reachable for a CUT-only host. Also still set by
nothing: `Transfer()`'s `BufferSize` keyword and `SessionOptions.dftBufferSize`. All four front ends
reach transfers now, so the choice belongs in shared code rather than in `runner.ts` alone. The full
blocker note, with all four open decisions, is at the top of Task 10 in the plan.

**Then Task 10 proper.** `packages/cli/scripts/dft-tso.txt` is committed, correct as written, and
carries its own judging criteria. **Judge it by TRACE:** `FileTransferData(0x0012,38B)` is the line to
grep for — DFT frames now name their request type, where the `-ddm` probe could only report
`unknownSF(0xd0,38B)`. A successful transfer proves nothing on its own now that both protocols end in
a transferred file. **VM/370 was DOWN this session (port 3270 closed; only TK5 on 3271 was up), so the
VM control — "DDM advertised does not break a CUT host" — is still unmeasured.**

**Read the AS BUILT section of every task 4-9 before re-deriving anything.** They record a real bug
that shipped in Task 3 with green tests (the `Open` offsets are NOT x3270's minus 3 — `GET16` does not
advance its pointer, so `dft_open_request` receives a pointer already at struct offset 3), four
mutation checks that passed **vacuously** while their targets were load-bearing, and that `TRANS03` is
a **prefix** match rather than equality — an equality test would have reported every successful live
transfer as a failure.

## SUPERSEDED — NEXT ACTION as of 2026-09-24

**`main` is at `d1e3919`, pushed, the only branch, tree clean, no stashes.** The `ddm-probe` branch
was merged `--no-ff` and deleted local and remote; the docs commits after it went straight to
`main`, which is the precedent for docs-only work here.

**THE DFT SPEC IS WRITTEN AND ITS TASK 1 — THE PROBE — IS BUILT, RUN AND MERGED.** Spec
`docs/superpowers/specs/2026-09-24-dft-file-transfer-design.md`. Gate on the merge commit:
typecheck clean, **1971 tests in 78 files, unchanged** — a default-off capability has zero blast
radius, and confirming that *is* the test.

**NEXT ACTION, IN ORDER.** (1) **The user still owes the spec a review.** (2) Then write the
implementation plan with `writing-plans`. The state machine (`core/src/ft/dft.ts`), the wire
constants, the inbound plumbing and the Read Modified hook are **not started**.

**THE FINDING, MEASURED NOT PREDICTED, AND IT CORRECTED TWO SPECS AND THE README: MVS/TSO OFFERS
DFT.** "Both Hercules hosts speak CUT" was a property of *our advertisement*, not of the hosts. The
client does not choose CUT or DFT — the host does, on seeing a Query Reply (DDM) unit, QCODE
`0x95`, which **we had never sent**. The probe held everything constant but that one byte of
advertisement: TK5 with `-ddm off` round-tripped 249 bytes over CUT with zero `0xd0` frames, and
with `-ddm on` sent **four**, decoding as `TR_OPEN_REQ` at exactly the two lengths
`dft_open_request` accepts, and both transfers timed out at 0 bytes. VM/370's MECAFF declines and
stays on CUT, so it is the control. **So stage 2 has a live witness on TSO after all** — TK5 is the
reference host, VM the control.

**TWO TRAPS THIS PROVED, both worth carrying.** (1) **The FAILING transfer is the POSITIVE result
today, and the direction INVERTS once a parser exists** — afterwards both paths end in a
transferred file and only the trace tells them apart. Judge by trace. (2) **`Trace(on)` alone puts
nothing in the log; `TraceText` is required** — without it the VM run's "no `0x95`" reading was
about our own logging, not about VM. **Verify your own advertisement reached the wire before
concluding anything about a host.**

**WHAT `-ddm` IS AND IS NOT.** Single-dashed, **default off**, all four front ends, following
`-bind-image` exactly. Default off is what preserves CUT's live witnesses on both hosts. It is a
**measurement instrument, not a feature**: turning it on makes a host offer a protocol we cannot
parse. It flips to default-on once DFT works. **It has NO unit test** — zero of the 78 test files
mention DDM — so its only evidence is the two committed probe scripts
(`packages/cli/scripts/ddm-probe-{vm,tso}.txt`) and the unchanged test count. Pinning the unit's
bytes is a stage-2 task. **`SessionOptions.dftBufferSize` exists and nothing sets it**; wiring it
to `Transfer`'s already-parsed-and-ignored `BufferSize` keyword is also stage 2.

## The 2026-09-23 state, for the work below

**MERGED AND PUSHED: `main` was at `35273d7`, the only branch, tree clean.** All 10 tasks done, and
the FULL GATE was re-run on the merge commit itself -- build/typecheck clean, **1971 tests in 78
files**, and **all eight by-hand harnesses** (`shot.mjs` 3/3, `keys.mjs`, `clicks.mjs`,
`browser-keys.mjs`, `browser-shot.mjs` 2/2, `pty-smoke.py` 12/12, `drive-e.py` 10/10,
`drive-playback.py` 10/10). The `synthetic-ispf-keypad` golden was regenerated for the 48th `Xfer`
button, confirmed by eye first. Spec
`docs/superpowers/specs/2026-09-22-interactive-file-transfer-design.md`, plan
`docs/superpowers/plans/2026-09-23-interactive-file-transfer-tui.md`.
**EVERY TASK CARRIES AN `AS BUILT` SECTION — READ THOSE BEFORE RE-DERIVING ANYTHING THE PLAN
CLAIMS.** They record roughly twenty defects, and the split is worth knowing: **the plan's prose was
usually right about the design and wrong about the details**, and **three of the defects were in my
own tests rather than in the code** — a test that passed against the very bug it named.

**WHAT SHIPPED: `IND$FILE` IS REACHABLE FROM AN INTERACTIVE FRONT END FOR THE FIRST TIME.** `Ctrl-T`
in the TUI opens a ten-field form; `Enter` starts the transfer, `Esc` closes it, and closing
mid-transfer **aborts** rather than abandoning. New: `packages/node-files` (a package holding only
`TransferFiles` over `node:fs`), `frontend/src/transferForm.ts` (the pure model, shared so stage 3's
GUI is a renderer and not a rewrite), `frontend/src/transfer.ts` (the validator, MOVED out of `cli`),
`tui/src/transferOverlay.ts` and `tui/src/transferRun.ts`, plus a public `CutTransfer.cancel` in
core.

**THE GATE, MEASURED ON THE BRANCH (not on a merge commit yet — that is Task 10):** build and
typecheck clean, **1970 tests in 78 files** (from 1869 in 74), `pty-smoke.py` **12/12 exit 0**.
**LIVE-VERIFIED ON BOTH HOSTS IN BOTH DIRECTIONS — VM/CMS 2026-09-23 (29/29 steps), MVS/TSO
2026-09-24 (26/26).** The same 249-byte binary round-tripped **byte-identically** on each, with the
hosts' own `LISTFILE`/`LISTDS` as independent checks (`V 80` on CMS, `VB 1024 BLKSIZE 1028 PS` on
TSO). Reproduce with `live-drive.py vmxfer` / `tsoxfer`, both committed, then `cmp`. **An earlier
draft of this section said NO FILE HAD CROSSED A REAL HOST; that is now false.**
**MID-FLIGHT CANCELLATION IS ALSO VERIFIED, 2026-09-24**, which was the last unwitnessed piece:
cancelling a 200KB upload at 17641 of 204800 bytes made MECAFF's `IND$FILE` answer
`>> TRANS99 - Protocol error` and **return CMS to `Ready;`** -- the host left transfer mode, which is
the entire purpose of aborting rather than abandoning. 249 bytes is far too fast to interrupt; the
size was chosen from measurement (~15 ms/frame locally, 1.727x codec expansion on random data, so
200 KB is ~185 frames and ~2.8 s per direction). Harness:
`packages/tui/scripts/cancel-transfer.py vm|tso` -- **verified on BOTH hosts**, and the observable
DIFFERS: MECAFF announces `>> TRANS99 - Protocol error` where Rayborn's FFTP on TSO says nothing at
all and simply returns to `READY`. **So "the host printed an error" is NOT the test; "the next
command is obeyed" is.** **An aborted upload leaves a PARTIAL file on BOTH hosts**, which is correct
and worth expecting rather than discovering.
**Three things to carry into any future live transfer run.** Use `-model 3278-2-E`; CUT accepts no
other geometry. **Prove the session's state before trusting a result** — `QUERY DISK A` must answer
`Ready;` on VM (`?CP: QUERY` means the reconnect trap and a void run), and TSO must be at `READY`,
where `IND$FILE` runs as a plain command with no ISPF panel involved. And **compare bytes, not the
status line**: the form says `done: N bytes transferred` either way, so a transfer that reports
success and writes a wrong file is the failure mode to look for.

**FOUR FINDINGS FROM THIS BRANCH THAT GENERALISE, all measured:**
1. **A test can pass against the bug it names.** Three times here. A truncation test asserted
   `not.toContain('>\n')` over joined lines and the truncation marker was the document's final
   character; an "Enter must not reach the host" test spied on `sendAID` while an unconnected
   session takes the `reconnectInstead` path and never calls it; and a selection-repair test
   asserted a field that is applicable in every state. **Assert on the line, not the document;
   check the path the call actually takes on THIS object; and bisect a boundary rather than testing
   one grossly-wrong value.**
2. **A mutation helper MUST ASSERT ITS TARGET WAS FOUND.** Two "passes" in one sweep were silent
   no-matches, i.e. a false "this code is not load-bearing" — the most misleading result a mutation
   check can give.
3. **DEFENCE-IN-DEPTH PAIRS ARE INVISIBLE TO SINGLE MUTATION.** Two here: `ended`/`clearTimers()` in
   `transferRun`'s `finish` (with both gone `onDone` fires three times and the last overwrites
   "cancelled" with "timed out"), and `app.ts` clearing `transferRun` vs `CutTransfer.cancel`'s own
   idempotence (deleting the app's half keeps the whole TUI suite green; removing both reddens
   CORE's tests). Both are now documented in the tests that cover them, so neither is deleted as
   redundant on the evidence of a green suite.
4. **A MESSAGE THAT DOES NOT FIT LOSES ITS MOST IMPORTANT WORDS, TWICE ON ONE BRANCH.** The TUI
   status line is 54 columns. The keypad-style help string was 59 and lost the key that closes the
   form; the CLI's timeout message is 113 and lost `(press Attn or Clear)` — the one actionable
   phrase, on the one failure where the host may still be mid-transfer. **Put the recovery first,
   and assert on what is drawn rather than what the code returns.**

**SUPERSEDED — everything from here to *The state of the tree* describes MERGED work and was written
for the 2026-09-19 state. The git facts in the next paragraph are stale: `main` has moved and this
branch exists.**

## The 2026-09-19 state, kept as the record of already-merged work

**GIT FACTS, CHECKED THIS DAY, NOT CARRIED FORWARD FROM AN EARLIER NOTE.** **`main` is at
`ed735fd`, pushed, and it is the ONLY branch — local and remote.** Everything earlier drafts of this
section called "not yet merged" is merged: the keypad, Sys Req on the classic path,
reconnect-on-enter, the z/VM probe and verdict, the TN3270E-DONT teardown fix, the playback oracle,
and now **BIND-IMAGE/BIND/UNBIND** (`06232cc`, `--no-ff`, branch deleted). The sections below stand
as the record of that work; none of them is the next action.

**WHAT THE BIND-IMAGE WORK DELIVERED.** The client **requests** TN3270E BIND-IMAGE (it previously
declined it by design), parses BIND and UNBIND, honours BIND's screen geometry within limits, and
gates inbound 3270 data on a BIND arriving — with a 5-second timeout that **executes the withheld
frame** rather than hanging forever as x3270 does. Two new flags, both default on: `-bind-image
on|off`, `-bind-limit on|off`. Design:
`docs/superpowers/specs/2026-09-17-bind-image-and-bind-unbind-design.md`; plan:
`docs/superpowers/plans/2026-09-17-bind-image-and-bind-unbind.md`, annotated with `**AS BUILT:**`
notes on every task that diverged from it — **read those before re-deriving anything the plan
claims; fourteen defects were found executing it and nearly all were in the plan.** Full detail:
`README.md`'s TN3270E section and `docs/live-testing.md`.

**THE `WONT TN3270E` GAP IS FIXED, 2026-09-19 (`e789b4f`).** Earlier drafts of this section recorded
it as a follow-up; it is done. A host withdrawing TN3270E with `IAC WONT TN3270E` — the
wrong-way-round form of the already-fixed `IAC DONT TN3270E` case — used to get **no reply and no
teardown**, because `St.Wont` only reacted to options in `hisOpts` and TN3270E lives in `myOpts`.
That left `tn3270eNegotiated` true, which short-circuits `is3270Mode()`, so we would have gone on
framing TN3270E against a host that had stopped. **Third instance of one shape on this project: a
teardown path that cleared nothing.** Routed through the same `disableTn3270e()` as the other two.
x3270 carries the same special case and names it verbatim — "Ugly hack for hosts that send WONT
TN3270E instead of DONT TN3270E" (`Common/telnet.c:1879-1889`). **The reply is `WONT`, not `DONT`**,
because the option is ours. **Two of the four mutations survived the first draft of its tests**, and
fixing that is most of the commit's value: a guard test used an option the host *had* agreed, so the
`else if` was never reached and dropping the option-40 guard left it green; and the `else if`
ordering turned out **unfalsifiable** (only BINARY and EOR ever enter `hisOpts`, `telnet.ts:446-455`,
so the branches are mutually exclusive by construction) — the test claiming to pin it was replaced
by one pinning that reason.

**IN PROGRESS: BRANCH `new-environ` — NEW-ENVIRON (telnet option 39) and `-devname`, 8 of 10 tasks
done, NOT MERGED.** Spec `docs/superpowers/specs/2026-09-19-new-environ-and-devname-design.md`, plan
`docs/superpowers/plans/2026-09-19-new-environ-and-devname.md`. Chosen over oversize because it is
structurally isolated (one telnet option, one subnegotiation, a string — no geometry, no renderer)
and because it makes EXISTING evidence stronger: **`drive-playback.py` went from 6 of 6 to 10 of 10,
and the four new devname traces each match NINE blocks** where the previous best was four.
**Three findings from x3270's own source, each a bug in the reference we deliberately do not copy:**
its NEW-ENVIRON parser treats `EE_NAME_ESC` as a TERMINAL state (one escape inside a name
permanently disables the delimiter — unreachable in practice, since no trace anywhere contains an
escape byte); its `find_environ` PREFIX-MATCHES (`memcmp` with no length check, so `IBM` matches
`IBMELF`); and `-devname`'s counter SATURATES rather than wrapping, which `devname_failure.trc`
proves on the wire by sending `foo9` twice.

**The whole gate passed on `main` at `ed735fd`, measured 2026-09-19 on the merge commit and again
after the WONT fix:** build and typecheck clean, **1819 tests in 72 files** (the `new-environ` branch
is at **1869 in 74**), `drive-e.py` **10/10**
(including the BIND gate and its timeout), `drive-playback.py` **6 of 6** (**10 of 10** on the
branch), `pty-smoke.py` **12/12**,
`shot.mjs` **3/3**, `keys.mjs` 18 chords/16 actions, `clicks.mjs` 9 buttons/10 actions,
`browser-keys.mjs` 13 chords/11 actions, `browser-shot.mjs` **2/2**.

**TWO RECORDED-HOST WITNESSES NOW, AND BOTH ARE NEW.** `sscp-lu-data.trc` matches 4 blocks and is
the first-ever recorded-host witness for **BIND**. `wont-tn3270e.trc` matches **5 blocks, up from
3**, and is the witness for the WONT fix — it stops on a genuine `wrongTerminalName` divergence
(we send `IBM-3278-4-E`, that recording sent the colour digit `IBM-3279-4-E`), which is why its case
carries `mismatch_ok=True`. **That flag tolerates the stopping point and does not excuse the blocks
before it**: reverting the fix fails with "matched 3 blocks, expected at least 5", verified.
**No live (non-recorded) host has ever completed a TN3270E negotiation**, so BIND/UNBIND's witness
is a recording and not a network host.

**BUILD-STALENESS TRAP, hit again on this merge:** a `git checkout` or merge rewrites mtimes without
changing content, so the GUI **and web** staleness guards redden. Force-rebuild **both**:
`npx tsc --build --force packages/gui packages/web`. Forcing only `packages/gui` is what failed
`browser-keys.mjs` on the first gate attempt after the merge.

**NOTHING IS WAITING ON THE USER.** The next roadmap items are **(4) oversize + `IBM-DYNAMIC`**
(which is really oversize — the advertisement is a by-product; see the out-of-scope section of the
bind-image spec for the measurements), then **local model-switching** (user 2026-09-17, "probably
right after `IBM-DYNAMIC`"; steal x3270's `Common/model.c`), then PS+VMGIF, packaging and the
printer session.

**EVERYTHING BELOW THIS POINT, DOWN TO *THE STATE OF THE TREE*, PREDATES THE BIND-IMAGE BRANCH AND
DESCRIBES ALREADY-MERGED WORK.** It is left as-is except where a specific number or claim about
BIND-IMAGE needed correcting in place (marked where it happens) — the keypad's styling, Sys Req's
byte layout and the z/VM host findings are unaffected by this branch and do not need re-deriving.

**DONE, NOT WAITING: THE KEYPAD'S STYLING.** The user chose **inverse video on a spaced grid** on
2026-09-17, having rejected a proportional font — measured, not argued: Helvetica's capital `I` is a
bare stem, so `ErInp` renders as "Erlnp", and Inter Light puts 0.4% of its ink pixels at full white
against the screen's 100%. Every key is now a 45x14 white block with a black label, with a blank row
between key rows and a blank column at the end of every key. The keypad is 9 cell rows tall rather
than 6, so a model 2 with it shown is **720x476**, and one golden moved (`synthetic-ispf-keypad`).

**THIS FILE PREDICTED THE BLAST RADIUS WRONG, AND THE CORRECTION IS THE USEFUL PART.** It said a
restyle "changes only `canvas/src/keypad.ts`". It also changed `canvas/src/renderer.ts`: the press
highlight was `rgba(255,255,255,0.35)`, which over a now-white button is a **no-op**, so it is black
at the same alpha. That is the one piece of local, zero-latency feedback in the design and nothing
in the suite executes a line of `renderer.ts`, so the colour is **unproven in pixels** — the
appearance was checked by compositing 0.35 black over the regenerated capture, not by photographing
a real press. The rest of the prediction held: the key table, the button rectangles and every hit
test are indeed independent of how a button is drawn, and `clicks.mjs` still passes 9 for 9 with
every hit rectangle moved.

**DONE, NOT WAITING: THE NON-TN3270E SYS REQ PATH.** Authorised by the user 2026-09-17 and
implemented. Sys Req now sends a **test request read** against a classic host, so all four front
ends do something against VM/370 and TK5 where they previously did nothing. **It is IMPLEMENTED and
NOT VERIFIED** — no host has been driven with it. It is on `docs/live-testing.md`'s next-run list.
See *Sys Req on both paths* below for the bytes and the two things about them that are wrong on a
first reading.

**THEN: `IBM-DYNAMIC`, which the user scheduled IMMEDIATELY AFTER THE KEYPAD on 2026-09-16**, then
(4) Programmable Symbol Sets + VMGIF. `IBM-DYNAMIC` is the one remaining TN3270E item with a live
path today: TK5's TSO issues a Read Partition to any `-E` client. **BIND/UNBIND is scheduled and
now built, on the `bind-image` branch — see *START HERE* above.** It and **printer
sessions** had no *live* path ~~at all, both hosts refusing option 40~~ —
**no host that COMPLETES the negotiation is reachable; see the next paragraph, which changes
what "no live path" means without yet removing the obstacle.** ~~And no path at all.~~
**CORRECTED 2026-09-17: "no live path" no longer means "no path". `playback -b` replays a
recorded real host with no network, and the recording it ships INCLUDES A BIND** — so
BIND/UNBIND has a host-free verification path today, described two paragraphs down. Only the
printer session still wants a host.

**A REAL TN3270E-CAPABLE HOST NOW EXISTS, 2026-09-17, IT ONLY HALF WORKS, AND THE HALF THAT
FAILS IS ITS OWN FAULT — measured, not assumed.** The user
obtained access to public z/VM 4.4 at `evievm.pubvm.org:23` (**plaintext, so `-insecure` is
required — without it the client HANGS**) and the committed probe was run, no logon attempted.
**It sends `IAC DO TN3270E` unprompted and asks `SEND DEVICE-TYPE` itself** — both firsts here,
since neither Hercules host ever mentions option 40 — **then withdraws the option (`ff fe 28`)
after our well-formed `DEVICE-TYPE REQUEST`**, identically with and without the `-E` suffix. Our
backoff carried the session to z/VM's logon screen, **so the backoff path finally has a live
witness** — and specifically the `St.Dont` arm of `TelnetLayer.step`
(`packages/core/src/telnet.ts`), a
*different* path from the DEVICE-TYPE REJECT and `-tn3270e off` cases `drive-e.py` drives, and
one nothing had ever exercised because our client never volunteers `WILL 40`. **WRITING ITS
MISSING UNIT TEST FOUND A REAL BUG, 2026-09-17, branch `tn3270e-dont-teardown`:** that arm did
not clear `tn3270eNegotiated`, which short-circuits `is3270Mode()`, so a host withdrawing option
40 *after* the negotiation completed kept the client framing TN3270E — header prepended outbound,
header stripped inbound — against a host that had stopped being TN3270E; `Session.e` had the
identical hole, and a mid-session `DONT` closes no connection so `handleClose()` never ran. Both
teardowns are now single functions (`TelnetLayer.disableTn3270e`, `Session.forgetTn3270e`) reached
by every path, and the arm has ten tests. The live run was clean only because the flag was still
false when the `DONT` arrived. But the negotiation does not complete and **TN3270E
remains functionally unverified against a host**.

**AND WHOSE FAULT THE REFUSAL IS IS NOW SETTLED, LATER THE SAME DAY: IT IS THE HOST'S, AND OUR
CLIENT IS EXONERATED.** ~~There is no s3270 on this box and no compiler to build one, so the
known-good comparison this project's discipline demands could not be run. NEXT STEP: get an LU
name and try `Connect("LUNAME@evievm.pubvm.org:23")`; failing that, an s3270/x3270 trace of that
host from any machine that has one.~~ **BOTH PREMISES OF THAT WERE FALSE AND THE CONCLUSION
INVERTS — do not repeat the reasoning.** `which cc gcc` found nothing only because the LSST
stack's conda environment is not on `PATH`; **`source /opt/lsst/software/stack/loadLSST.bash`
puts gcc 14.4.0 (conda-forge) and GNU Make 4.4.1 there** (this box is an RSP notebook container
and `/opt/lsst` is the stack — **source the script, never paste the raw path, which contains
`lsst-scipipe-13.1.0-exact` and rots at the next stack upgrade**). suite3270 4.5 in
`/home/a/athor/src/suite3270-4.5` was already configured (`--disable-x3270 --disable-x3270if`),
and **`make s3270` took 23 SECONDS, exit 0, TLS included, zero extra flags and zero
workarounds** — `s3270 v4.5ga6`, OpenSSL 3.6.4, at
`obj/x86_64-conda-linux-gnu/s3270/s3270`. `make playback` built too. So the comparison ran:

- **The two DEVICE-TYPE requests are BYTE-IDENTICAL** —
  `fffa28020749424d2d333237382d322d45fff0`, 19 bytes each — and the host's `SEND DEVICE-TYPE`
  and its `DONT` were identical to each. s3270 logged `Aborting TN3270E: negotiated off`.
- **FOUR s3270 device-type variants, all refused**: `IBM-3278-2-E`, `IBM-3278-2-E CONNECT VTAM`,
  `IBM-DYNAMIC`, `IBM-3278-4-E`. **The CONNECT-clause hypothesis is DEAD** — the LU test above
  is no longer diagnostic, so do not spend the favour asking for an LU name for that reason.
- **The decisive argument is conformance:** RFC 2355 §7.1.5 requires an unacceptable device type to
  draw a TN3270E `DEVICE-TYPE REJECT` with a reason code. **This host sends no TN3270E
  subnegotiation at all** — not `IS`, not `REJECT` — and withdraws at the *telnet* layer. That
  is an option advertised with no working implementation behind it.
- **EXONERATED IS NOT VERIFIED, and this host can never verify it.** It abandons before
  FUNCTIONS for s3270 as well as for us, so no `FUNCTIONS REQUEST`, no BIND and no LU name has
  ever been observed from any host. Probe questions 1-3 stay open.

**DONE, 2026-09-17 — `playback -b` IS NOW A COMMITTED HARNESS: `packages/cli/scripts/drive-playback.py`,
then 5 of 5 cases, and it found nothing wrong with our client.** Run it by hand like the other
harnesses (it needs the out-of-tree suite3270 build, so it is NOT in `npm test`); its four
invariants are pinned by `packages/tui/test/harness-flags.test.ts`, which is. What it proved and
what it could NOT, as of 2026-09-17, are different claims, so quote them apart:

- **PROVED, against five different real hosts' recorded bytes** (two commercial VTAM systems
  among them): our `IAC WILL TN3270E`, our `DEVICE-TYPE REQUEST` including the model the flag
  asked for, and — on `wont-tn3270e.trc`, whose host answers `WONT 40` before FUNCTIONS — our
  whole backoff to classic TN3270. **Mutation-verified twice**: corrupting the device-type string
  and reversing the DEVICE-TYPE operand order each turn all six cases red (five when that was written). **The operand-order
  bug is the one real s3270 accepts SILENTLY** (`DEVICE-TYPE ??8`, then a stall), so this is new
  coverage, not a second opinion on what unit tests already catch.
- **NOT PROVED THEN, AND THIS IS NOW STALE — CORRECTED ON THE `bind-image` BRANCH, 2026-09-19:**
  this bullet used to say we decline BIND-IMAGE by design and so every trace mismatches one block
  short of FUNCTIONS. **That decision was reversed**: the hazard (granting BIND-IMAGE and getting
  no BIND hangs a real client) was real but no host in x3270's 71-trace collection ever triggers
  it — so BIND-IMAGE is now requested, and the hang is refused with a 5-second timeout instead of
  by never asking. `devname_success.trc` (`PLU-name 'IBM0SMAJ'`) turned out not to be the witness
  this unlocked — it needs NEW-ENVIRON, which this client does not implement — but
  `sscp-lu-data.trc` (`PLU-name 'IBM0SMAA'`, a different real host) is, reaching 4 matched blocks
  including a real BIND. See `docs/live-testing.md`'s *`playback -b` as an oracle* for the current
  6-of-6 measurement, and the bind-image plan's own AS BUILT notes for the decision record.

**THREE PROPERTIES OF `playback` THAT CAN EACH MANUFACTURE A FALSE PASS, all measured here:**
1. **IT EXITS 0 WHETHER OR NOT IT MATCHED ANYTHING.** `Common/playback.c:373` is literally
   `exit(0); /* needs to be smarter */`. A mismatch exits 2, but a run that matched NOTHING and
   hit `Socket EOF` exits 0 exactly like a perfect run. **Assert on the `Matched N bytes from
   emulator` lines; never on the returncode.** The guard test forbids `pb.returncode`.
2. **It only ever compares what the trace already contains** — and **16 of the 71 shipped traces
   have no emulator side at all** (host recordings for renderer tests), so `-b` against those
   asserts precisely nothing while looking like a pass.
3. **A TRACE IS A RECORDING OF ONE CLIENT VERSION, NOT A SPEC.** `sruvm.trc` and `rpqnames.trc`
   are **c3270 v3.3.10alpha1 (2009)** recordings that expect `IBM-3279-4-E` in TERMINAL-TYPE.
   **Today's s3270 4.5ga6 sends `IBM-3278-4-E` and mismatches them IDENTICALLY to us** — the only
   reason we know the trace is at fault and not our client, and it needed
   `-xrm '*wrongTerminalName: true'` to satisfy them (with it, s3270 gets as far as Query Reply
   and then diverges on its own RPQ names). Excluded by name, with the reason, in the harness.
   **`ft_cut.trc` is excluded for a related reason worth knowing: x3270 builds `3279` for
   TERMINAL-TYPE and `3278` for DEVICE-TYPE** (`Common/model.c:135-138` `create_model`, called
   from `Common/telnet.c:2103-2106` with `force_3278` true only at `:2122`), so a colour model's
   two strings differ by one digit. We always send 3278.

**TWO HARNESS DEFECTS FOUND BY THE HARNESS CLAIMING OUR CLIENT WAS BROKEN — the shape recurs, so
suspect a new harness before the product:**
1. **A readiness CONNECT PROBE IS ACCEPTED AS THE EMULATOR.** `playback` serves one connection at
   a time (`playback.c:350`, then the whole bidirectional loop), so the probe consumed the
   session and the real client was never served: a false **"0 of 5 cases passed"**, its log
   showing one expectation then `Socket EOF` — indistinguishable from our client connecting and
   saying nothing. **This is the same defect that once made `drive-e.py` fail all seven cases.**
   Wait on playback's own announcement instead.
2. **`playback` never `fflush`es that announcement** (`playback.c:283`), so waiting for it on a
   PIPE **hangs forever** — and a chatty trace would deadlock on one pipe buffer anyway. The
   harness gives it a log FILE under `stdbuf -oL`.

**AND ONE ABOUT THE GUARD TEST, which is the [[implementers-should-verify-not-trust-plans]] shape
turned on myself:** its four assertions were each mutation-falsified, but **the first attempt at
the fourth was a silent no-op whose anchor never matched the source**, so it reported "8 passed"
while proving nothing. Asserting the anchor before mutating is what exposed it. A mutation check
that cannot fail is worth less than no mutation check, because it certifies.

**THE ORIGINAL PLAN FOR THIS, kept because its reasoning about WHY this oracle matters still
stands:** ~~NEXT STEP, AND IT IS NOT ANOTHER HOST~~ — USE `playback -b`. It is the project's new
reference oracle and it is **strictly stronger than the in-repo `e-server.py`**: it replays a
**recorded real host** and asserts the client's replies match byte for byte, **with no network
and no host at all**, whereas `e-server.py` was written by us from the RFC and x3270's source
and so can only check what we thought to encode. And `s3270/Test/devname_success.trc` is a
**complete TN3270E negotiation including a real BIND** (`PLU-name 'IBM0SMAJ'`), FUNCTIONS and
all — precisely the region questions 1-3 cover:

```bash
source /opt/lsst/software/stack/loadLSST.bash
cd /home/a/athor/src/suite3270-4.5
obj/x86_64-conda-linux-gnu/playback/playback -b -p 8021 s3270/Test/devname_success.trc &
obj/x86_64-conda-linux-gnu/s3270/s3270 -devname 'foo===' -model 3278-4-E 127.0.0.1:8021
```

That is exactly how the fresh binary was validated before the live comparison was trusted —
**a silently broken build would have produced a false "the host refuses s3270 too"**, the one
failure mode that looks identical to success. It logged `Matched N bytes from emulator`
throughout. **Pointing it at OUR client is the cheapest remaining path to functional TN3270E
verification and should be tried before hunting for another host.** Two known divergences must
be accounted for first or a mismatch will be misread: BIND-IMAGE, which we declined by design at
the time this was written (**reversed on `bind-image`, 2026-09-19 — see *START HERE***), and the
bare DEVICE-TYPE below.

**A REAL DIVERGENCE FROM s3270 — NOW DECIDED BY THE USER, 2026-09-17: WE DO NOT APPEND `-E`
UNCONDITIONALLY, AND THE DIVERGENCE STAYS.** No code changed, because our behaviour was already
this; what changed is that it is now a decision rather than an open question, and it is pinned by
a test. `packages/core/test/tn3270e.test.ts` *sends the terminal type VERBATIM, appending no -E of
its own* asserts the bare `IBM-3278-2` for `-model 3278-2` and separately asserts the reply
contains no `-E` at all. **Mutation-verified**: making `deviceTypeRequest` append `-E` when absent
reddens it. That test exists because **every other test in that file passes a `-E` terminal type**,
so nothing could distinguish "we pass the string through" from "we append `-E`" — and appending it
is the natural way to make one more `playback` block match, which is exactly the pressure it must
resist. The original reasoning follows.

**s3270 appends `-E` to the TN3270E DEVICE-TYPE regardless of model; we do not.**
`tn3270e_request()` calls `create_3270_termtype(true)` (`Common/telnet.c:2121-2122`), which
appends `-E` unless extended data stream is off or the `S:` prefix set `STD_DS_HOST`
(`Common/telnet.c:2106`) — the `-model` suffix reaches only TERMINAL-TYPE. Ours sends
`st.terminalType` verbatim (`packages/core/src/tn3270e.ts:188-194`, the string at `:191`; the
value from `packages/core/src/session.ts:543`). **So under `-model 3278-2` s3270 sends
`IBM-3278-2-E` and we send the bare `IBM-3278-2`.** Two consequences: (1) it **weakened**
yesterday's "the `-E` suffix is not the trigger" test, which varied our request against a form
no known-good client sends — the conclusion holds only because s3270's `-E` form was refused
too; (2) RFC 2355 permits both forms and `-model 3278-2` meaning "not extended" arguably makes
the bare form more honest, so **decide it deliberately rather than aligning with s3270 by
reflex. No code was changed.** ~~Awaiting the user.~~ **DECIDED as above, 2026-09-17: the bare
form stays.** Also for whoever next touches LU plumbing: **s3270 appends the
LU to TERMINAL-TYPE too** — `IBM-3278-2-E@VTAM` (`Common/telnet.c:2019-2024`).

Bytes, the variant table, the toolchain recipe and the four questions with a status each:
`docs/live-testing.md`, *TN3270E against a real host*; recorded against the design in the
spec's *Live host, 2026-09-17* and as testing layer 2b.

### WHAT THE KEYPAD BRANCH DELIVERED

- **A clickable 47-button virtual keypad** in both canvas front ends, toggled by `Ctrl-K` (and
  `Alt-K`), hidden by default. PF1–24, PA1–3 and the special keys, drawn through the same glyph
  atlas and the same blitter as the screen and the OIA — one drawing primitive, three regions — each
  key **inverse video on a spaced grid**, which is the user's choice of 2026-09-17 and needed no
  second font.
- **A keyboard-navigable special-keys list in the TUI**, same 47 keys, same chord `Ctrl-K`, because
  a terminal has no mouse. Arrows move, Enter fires, Esc closes; while it is open **it owns the
  keyboard**, and the window follows the selection rather than showing the first N (first-N would
  leave everything from `Attention` down, Sys Req included, permanently unreachable).
- **Four keys that `core` could do and no interactive front end could press**: **Dup** (`Ctrl-D`),
  **Field Mark** (`Ctrl-F`), **Sys Req** and **Newline** — the last two deliberately chordless.
  Plus `Dup()`, `FieldMark()` and `SysReq()` in the CLI, which is conformance with s3270 rather than
  symmetry.
- **`TN3270_GUI_CLICKS`, a fifth test seam**, and `packages/gui/scripts/clicks.mjs`: real Chromium
  mouse events at buttons addressed **by label**, main asking the renderer where each one is.
- **A third GUI golden and a second `browser-shot` case**, so the keypad is proven pixel-identical
  between Electron and the served page.

**THE ARCHITECTURE, in one paragraph, because it is not obvious and it was decided by one line.**
The key **table** is data in `packages/frontend/src/keypad.ts` (47 keys) — there and not in `canvas`
because **both package graphs reach `frontend` and the TUI cannot import `canvas`**, and two copies
of a 47-key list drift silently. The cell **layout** is `packages/canvas/src/keypad.ts`, in scale-1
pixels throughout. `hitTest`/`hitTestAt`/`KeypadButton` are in `packages/canvas/src/hittest.ts`,
which is **import-free and in `BROWSER_MODULES`** — the renderer needs them and a runtime import of
a workspace package there blanks the window with no error. Shared drawing types moved to the leaf
`packages/canvas/src/geometry.ts` to break the last import cycle. The keypad is a **third
`DrawList` region appended below the screen and the OIA**; see the next section for why that single
fact decided the rest.

**WHO HOLDS THE FLAG: Electron per WINDOW, the gateway per CONNECTION, the TUI opens a list
instead.** `applyAction` **throws** on `toggleKeypad`, exactly as it does on `quit`, so a front end
that forgot to own its own display fails loudly instead of showing a dead button — and
`default: action satisfies never` makes deleting either guard a **compile error** with zero runtime
footprint.

### Sys Req on both paths

**SYS REQ IS IMPLEMENTED FROM EVERY FRONT END ON BOTH PATHS, AND VERIFIED AGAINST NEITHER HOST.**
Keep those two halves apart; the docs used to say "reachable and inert", which was true until
2026-09-17 and is now wrong. `Session.sysreq()` picks by whether the session is TN3270E, which is
exactly what x3270's `SysReq_action` does (`Common/kybd.c:2849-2870`) — it splits on `IN_E` and on
nothing else:

- **TN3270E**: Telnet `IAC AO`. `net_abort()` then tests the SYSREQ function bit itself
  (`Common/telnet.c:3632-3648`), so an E session that declined the function sends **nothing** — and
  specifically not the classic form as a fallback, because x3270 never reaches the `else` arm on an
  E session. **Never exercised live**: neither Hercules host offers TN3270E, both answering
  `IAC WILL TN3270E` with `ff fe 28` = DONT, measured three times. **Still never exercised live
  after 2026-09-17** — z/VM 4.4 at `evievm.pubvm.org:23` does offer option 40, but withdraws it
  before FUNCTIONS, so no session has ever agreed the SYSREQ function bit with a host.
- **CLASSIC**: a **test request read**, which is what both Hercules hosts get.

**THREE THINGS ABOUT THE CLASSIC FORM THAT ARE WRONG ON A FIRST READING.** All three were checked
against `Common/ctlr.c` and `pages.txt` before the code was written; do not re-derive them.

1. **IT IS NOT AID `0xf0`.** x3270 reaches `key_AID(AID_SYSREQ)` (`kybd.c:2864`), which looks like
   it transmits the AID and does not: `ctlr_read_modified` has a dedicated
   `case AID_SYSREQ /* test request */` (`Common/ctlr.c:770-777`) writing `EBC_soh`,
   `EBC_percent`, `EBC_slash`, `EBC_stx` = **`01 6c 61 02`** in place of the AID byte and the
   cursor address. `AID.SYSREQ` exists in our `constants.ts`, selects this heading, and is never
   itself on the wire for this key.
2. **THE MODIFIED FIELD DATA STILL FOLLOWS IT.** The phrase "four-byte record" — which earlier
   drafts of this file and of the README both used — invites the opposite conclusion, and that
   `break` leaves the **switch**, not the function, so the field scan below it runs.
   GA23-0059-07 agrees and settles it: the stream is the heading then "the same as described
   previously for read-modified operations, excluding the 3-byte read heading (AID and cursor
   address)" (`pages.txt:13786-13789`). **The manual and x3270 do not disagree here**; both say
   heading-plus-data.
3. **NO ETX.** The manual's BSC form ends in one (`pages.txt:13780-13785`); the non-SNA form is
   "the same as for the BSC environment, except there is no ETX" (`pages.txt:14180-14184`). ETX is
   BSC block framing. A telnet record ends at `IAC EOR`, which `sendRecord` appends, and the
   heading bytes are none of them `0xff` so IAC doubling never touches them — though it does still
   protect a `0xff` in the field data, by construction, because the record goes out through the
   same `sendRecord` as any AID.

**ON AN INHIBITED KEYBOARD WE REFUSE, WHERE x3270 QUEUES.** It refuses outright on `KL_OIA_MINUS`
and calls `enq_ta` on any other lock (`kybd.c:2858-2864`). **This codebase has no action queue and
one was not invented for a single key**; both become a refusal into the OIA, which `applyAction`
swallows. If an action queue is ever added for other reasons, this is a caller to revisit.

**NO LIVE VERIFICATION WAS RUN FOR THIS FEATURE, deliberately, and the argument has a limit.** A
keypad press produces the same wire bytes as the equivalent keystroke, and those are already
live-verified — but **Dup, Field Mark, Sys Req and Newline have NO live witness at all.** Sys Req
can now get one, which it could not before; the other three still cannot be told apart from
nothing-happened without a host that reacts. Do not let the keypad's verification read as covering
the four keys.

### Four measured facts about these keys that are all counterintuitive

Every one of these was checked against the manual or x3270's source on the branch, and every one
contradicted a first reading. Do not re-derive them and do not "simplify" them back.

1. **THE DUP KEY PERFORMS A TAB.** `kybd.c:1435` really does suppress `key_Character`'s auto-skip
   for a keyboard Dup — but `Dup_action` then calls `cursor_move(next_unprotected(cursor_addr))`
   itself (`kybd.c:2790`), and the manual states the net effect outright (p. 7-12: a X'1C' is
   entered, **a Tab key operation is performed**, and MDT is set). **What the suppression buys is
   that the tab happens ONCE** — our `advanceAfterType` already tabs at the end of a field, so
   advancing first would skip a whole field.
2. **A NUMERIC FIELD TAKES DUP AND REFUSES FIELD MARK.** The manual's permitted set names "the
   duplicate (DUP) control" explicitly (p. 4-13). x3270's byte test refuses DUP too, but is gated on
   `numeric_lock`, which has **no default assignment**, so stock x3270 refuses neither. The manual
   wins.
3. **`Ctrl-K` IS c3270's OWN TERMINAL BINDING — there was never a divergence.** `Common/fb-c3270`
   is split at `#ifdef _WIN32` (`:41`) / `#else` (`:126`), and the non-Windows keymap a terminal
   build reads has `Ctrl<Key>k: Keypad()` at `:191`. `Alt-K` is merely the Windows spelling, which
   is why the canvas front ends take both. **Every citation the spec and plan originally gave —
   `:48`, `:88`, `:93` — was inside the Windows branch.** The ESC-path caution is real and is still
   the reason not to add an `Alt-` binding to the TUI; it just is not why `Ctrl-K` was chosen.
   (**Pre-existing and NOT fixed:** `Ctrl-A` for Attn cites the Windows branch too, and in the
   non-Windows keymap `Ctrl-A` is c3270's *escape prefix* while Attn is the two-key `Ctrl-A a`. So
   that binding is a real divergence nobody knew they were making. Decide it separately.)
4. **NEWLINE HAS NO CHORD, AND THAT IS A SETTLED USER DECISION.** c3270 binds
   `Ctrl<Key>j: Newline()` (`:190`, non-Windows) — but **`Ctrl-J` IS `\n` (0x0a), which the terminal
   keymap already maps to `enter`**. One byte cannot be both, and Enter is the AID that submits the
   screen. Recorded as the user's call on 2026-09-14 in
   `docs/superpowers/specs/2026-09-14-shared-palette-and-unreachable-keys-design.md:84-89`. The
   keypad button and the TUI list ARE Newline's route, exactly as they are Sys Req's.

**ALSO WORTH KNOWING, because it is the honest limit of what the TUI list does:** its "refuses to
open in a terminal too small" behaviour is **UNREACHABLE IN A LIVE SESSION.** `tooSmall`
(`tui/src/render.ts:43`) already refuses anything below 24x80 before a session runs, and the
smallest 3270 screen *is* 24x80 — so every terminal that can reach the list clears `OVERLAY_MIN`
(12x29) comfortably. It is a floor for a caller passing a sub-window, not a refusal an operator can
provoke, and it was encoded as "`OVERLAY_MIN` must never exceed 24x80" rather than by inflating the
minimum to manufacture a reachable refusal.

### What the keypad work established during DESIGN, so it is not re-derived

Checked against sources during design, 2026-09-16. All of it is in the spec's own table; this is the
short version for anyone deciding whether to read further. **THREE OF THESE WERE LATER FOUND WRONG
BY IMPLEMENTERS AND ARE LEFT IN PLACE, MARKED** — this file's practice, because it is what let a
roadmap correction land cleanly once before. The corrected versions are in the four numbered facts
above; read those.

- **`EBC_dup = 0x1c`, `EBC_fm = 0x1e`** (x3270 `include/3270ds.h:364-365`).
- **Dup and Field Mark are typed CHARACTERS, not AIDs** — `Common/kybd.c:2788` and `:2825` both call
  `key_Character(...)`. Nothing about them touches `sendAID`.
- ~~**A keyboard Dup SUPPRESSES auto-skip; a pasted one does not** (`kybd.c:1435`). Our
  `advanceAfterType` IS that auto-skip, so `dup()` must not run it.~~ **WRONG, corrected in Task 1:
  the suppression is real but `Dup_action` then tabs itself, so THE KEY PERFORMS A TAB.** See fact 1
  above. The half that survives is that the tab must happen once, not twice.
- ~~**A numeric field refuses both**, because `key_Character` tests the EBCDIC byte
  (`kybd.c:1232-1238`).~~ **WRONG, corrected in Task 1: a numeric field TAKES Dup and refuses Field
  Mark.** See fact 2 above; x3270's byte test is gated on `numeric_lock`, which is off by default.
- **`Session.sysreq()` has existed since stage 2b with no front end able to call it.** Still true of
  history, and now reachable. ~~And inert here.~~ **No longer inert: the classic path landed
  2026-09-17** and it sends a test request read to both Hercules hosts. See *Sys Req on both paths*.
- ~~**Chords come from c3270's own keymap**: `Ctrl-D` = Dup, `Ctrl-F` = FieldMark
  (`Common/fb-c3270:88`, `:93`); c3270 toggles its keypad with `Alt-K` (`:48`), which reaches a
  terminal as `ESC k`, so the TUI uses `Ctrl-K` instead.~~ **THE CITATIONS ARE ALL IN THE `_WIN32`
  BRANCH and the reasoning was fiction, corrected in Task 4.** The chords are right; `Ctrl-K` is
  c3270's own terminal binding (`:191`) rather than a divergence. See fact 3 above.
- **The key SET is c3270's keypad** — authoritatively `Common/c3270/keypad.callbacks`, **exactly 44
  keys and NO CURSOR ARROWS**; the arrow-looking glyphs in `keypad.full:8-11` are Tab, BackTab and
  Newline. `keypad.labels`/`keypad.full` are its rendering and `keypad.outline` is literal ASCII art
  of one, worth reading.
  **RUNNING c3270 AND LOOKING AT IT, 2026-09-24 — the first direct observation, and it confirms the
  design rather than correcting it.** `~/bin/c3270` v4.5ga6 exists (built here 2026-08-17; the
  toolchain is behind `source /opt/lsst/software/stack/loadLSST.bash`, and **`hash -r` is required
  after sourcing or `command -v make` still reports MISSING with the directory on `PATH`**). Driven
  under a pty against TK5 with `-secure` (its equivalent of our `-insecure`) and toggled with
  **`Ctrl-A k`** — the two-key non-Windows binding at `fb-c3270:136`, *not* `Alt-K`, which is in the
  `_WIN32` half and does nothing here. **The keypad is 16 rows x 78 columns** (`wc -l` / max line
  length of `keypad.outline` and `keypad.labels`, and it renders into rows 1-15 of a 24-row
  terminal). **So "a faithful c3270-style keypad would hide the display" is now MEASURED, not
  inferred** — 16 of 24 rows — which is why the TUI got a navigable list instead. The rendered keys
  are exactly the shipped set including **Sys Req, Dup and Field Mark**.
- ~~**The layout is 46 buttons**, not 43.~~ **47 as shipped**: c3270's 44, minus Cursor Select and
  Compose, plus the four cursor arrows and Backspace. The spec's first draft said 43, Task 3 made it
  46 by also dropping Newline, and Newline was then added on the user's decision — so the count
  moved twice and each time by counting rather than by eye.

### One architectural fact that decides more than it looks like

**`fit()` in `packages/gui/src/main.ts` sizes the window from the DRAW LIST** —
`setContentSize(list.width * scale, list.height * scale)`, currently `main.ts:312`, **and cited by
name here because that line has now moved three times on one branch** (`:290` → `:294` → `:312`).
That is why the keypad is a third `DrawList` region rather than something the renderer owns: a
renderer-owned keypad would leave main unaware the drawing had grown, and the Electron page is
`overflow:hidden` (`gui/index.html:3`), so it would be clipped exactly as model 4's OIA row was. The
alternative was a fifth bridge function, and `bridgecore.ts` states that a fifth function means the
renderer has stopped being shared.

## The state of the tree

**THIS SECTION IS A HISTORICAL SNAPSHOT FROM THE KEYPAD BRANCH, 2026-09-17, AND THE KEYPAD IS
NOW MERGED.** For where the tree stands today, see *START HERE* at the top of this file: `main` is
at `ed735fd` and is the only branch (bind-image is merged and deleted), and the current
count is **1869 tests in 74 files** (on `new-environ`). Nothing below this note was re-derived for that; it is kept as
the record of the keypad branch's own numbers on its own day.

**`main` at `7ca0269`, pushed** — an earlier version of this line said `eb9c306`, which was
`main`'s tip when the paragraph was written and is now one commit behind it. **The branch
`keypad-and-special-keys` is ahead of it and is NOT MERGED — see *START HERE*.** Working tree clean.
(`git rev-list --count main..HEAD` for the number; it is not written down here, for the same reason
`eb9c306` was worth marking.)

**On the branch head: 1688 tests in 71 files**, `npm run typecheck` and `npm run build` clean,
**all three** GUI goldens matching, `pty-smoke.py` 12/12, and all four by-hand harnesses passing
(`keys.mjs` 18 chords / 16 actions, `clicks.mjs` 9 buttons / 10 actions, `browser-keys.mjs` 13
chords / 11 actions, `browser-shot.mjs` 2/2 cases).

**On `main` itself: 1514 tests in 66 files**, two GUI goldens, `browser-keys.mjs` 12 chords / 10
actions, `browser-shot.mjs` one case. Quote whichever you mean; the two sets are six weeks and one
feature apart.

**THE WEB GATEWAY IS DONE AND MERGED** as `d52ee57` (`--no-ff`, 39 commits; branch deleted local and
remote). Roadmap item (3) is closed: all 15 tasks plus the three follow-up questions the user then
answered — the token now defaults OFF, the AID hole is structurally closed in two layers, and
`Session.off()`/`listenerCount()` exist. The whole gate was re-run **on the merge commit itself**,
not only on the branch.
Spec `docs/superpowers/specs/2026-09-15-web-gateway-design.md`, plan
`docs/superpowers/plans/2026-09-15-web-gateway.md` — **the plan is heavily annotated with AS BUILT
notes recording the defects found while executing it, and those annotations are the most valuable
thing in it.** Do not re-derive them.

**FOUR FRONT ENDS NOW**, and the package graph is `core <- frontend <- { cli, tui }` and
`core <- canvas <- { gui, web }`. `packages/web` adds no runtime dependency.

```sh
node packages/web/dist/main.js -insecure -model 3278-4-E 127.0.0.1:3270
```

### What the WEB GATEWAY branch delivered (2026-09-16, merged)

- **`packages/canvas`**, extracted from `packages/gui`: `renderer.ts`, `blit.ts`, `keys.ts`,
  `drawlist.ts`, `cg.ts`, `bdf.ts`, the atlas baker and the BDF font, all moved byte-identical.
  (The keypad branch then added `keypad.ts`, `hittest.ts` and the leaf `geometry.ts`, and the
  package graph inside it is now a DAG pinned by `test/module-cycles.test.ts`.)
- **`packages/web`**: `args`, `wsframe` (RFC 6455), `handshake` (upgrade, token, Origin),
  `protocol` (messages and deflate), `sessions` (registry, detach, grace), `wsserver` (the
  `Connection` seam and the frame-size cap), `httpstatic` (a fixed asset table), `bridgecore` and
  `bridge` (the browser side), and `main` (the server, and the gateway's entry point).
- **`renderer.ts` IS SHARED, AND AS OF THAT BRANCH ITS ONLY CHANGE WAS TWO LINES** — the
  canvas-sizing fix below. Verified by diffing against `main`: every other line of `renderer.ts`, and
  all five of `blit.ts`, `keys.ts`, `drawlist.ts`, `cg.ts` and `bdf.ts`, were byte-identical to the
  pre-branch version. **THE TWO-LINE CLAIM IS NOW HISTORICAL** — the keypad branch added the keypad
  blit, the whole click path and the `__tn3270ButtonCentre` test seam to this file, so do not repeat
  it as current. What is still true, and is the claim worth making, is that the sharing is proven in
  PIXELS rather than asserted: `browser-shot.mjs` compares the served page against the Electron
  app's OWN goldens and they are identical, **in both of its cases** — with the keypad and without.
- **Live-verified against both Hercules systems** — see `docs/live-testing.md`, *The web gateway
  against both hosts*: VM/370 42 of 43 rows agreeing with the CLI (the 43rd is the cursor, at
  exactly 9x3 ink pixels), MVS TK5 24 of 24, two concurrent sessions on two devices, and
  reattachment across a real interruption.

### By-hand harnesses — NOT in `npm test`

**SIX run with no host, and TWO more need one.** ~~There are FIVE now.~~ **The old "FIVE" counted
only the host-free ones and did not say so** — `drive-e.py` and `live-drive.py` are harnesses too,
and an undercount here is how one gets forgotten when a default flips. None is in `npm test`; each
spawns Electron, a browser, a pty or an out-of-tree binary, and what `npm test` carries instead is a
flags test per harness pinning its argv, cases and pass conditions as text so it cannot rot
unnoticed. Figures are as measured on `playback-oracle`, 2026-09-17:

```sh
node packages/gui/scripts/shot.mjs           # 3/3 goldens matched
node packages/gui/scripts/keys.mjs           # ok 18 chords, 16 actions in order
node packages/gui/scripts/clicks.mjs         # ok 9 buttons, 10 actions in order (toggleKeypad + 9)
node packages/web/scripts/browser-keys.mjs   # ok 13 chords, 11 actions in order, over a WebSocket
node packages/web/scripts/browser-shot.mjs   # 2/2 cases matched the GUI's own goldens
python3 packages/tui/scripts/pty-smoke.py    # 12/12, and it needs no X at all
python3 packages/cli/scripts/drive-playback.py  # 5/5 traces; needs the suite3270 build, no host
```

**The `drive-playback.py` figure above is superseded on `bind-image`: 6/6 traces**, the sixth
(`sscp-lu-data.trc`) added as the recorded-host BIND witness. See *START HERE*.

**These two need something this sandbox does not always have**, which is why they are listed apart
rather than folded into a single count:

```sh
python3 packages/cli/scripts/drive-e.py      # 7 configurations against the in-repo e-server.py
python3 packages/tui/scripts/live-drive.py   # needs a LIVE Hercules host on 3270/3271
```

**`browser-shot.mjs` RUNS TWO CASES, NOT ONE.** An earlier version of this line described it as
comparing "served pixels against the GUI golden", singular; it now runs the plain screen *and* the
keypad, each sized from its own golden's PNG header. The keypad case is the one that matters — it
says the keypad the browser draws is the same keypad Electron draws.

All the browser ones pass `--no-proxy-server`, which is MANDATORY here: with `HTTP_PROXY` set,
Chromium routes even a loopback request through the proxy and the failure is completely silent — no
load error, no renderer error, and not one request in the server's log.

**Two false-pass traps these harnesses have already had, both about a STABLE OUTPUT PATH.**
`shot.mjs` scored **3/3 and exit 0 on three stale files** from a previous run, because
`/tmp/tn3270-shot-<case>.png` never changed between runs and the pass condition asked only whether a
capture EXISTED — an Electron that died in 0.24s with "Cannot find module" passed. Both it and
`browser-shot.mjs` now `rmSync` first. And **`process.exit` does not run `finally`**, so
`browser-shot.mjs`'s teardown was skipped by every bail, orphaning a listening gateway with a
replayed session open; it now counts per-case failures and returns instead. **`browser-keys.mjs`
still has that shape and was deliberately left alone** — one line, whenever someone is in there.

### What is NOT done on the gateway

No connect dialog, no menus, no preferences. **The mouse works the keypad's buttons and nothing
else** — no click-to-place-cursor, no drag-to-select, no light pen — which is the same list as the
GUI. A screen larger than the viewport SCROLLS rather than being clipped (see below); it does not
reflow or scale fractionally, because integer scaling is a design rule.

### THE DEFECT LIVE VERIFICATION FOUND, and it is the one worth remembering

**A browser cannot resize its own window, so the GUI's old clipping bug is worse in a page.** A
model-4 screen is 43 rows = 616px with the OIA; in an 800x600 viewport the ENTIRE OIA row fell off
the bottom, silently. Electron fixes this in `main.ts` with `setContentSize`; a page has no such
power, and `bestScale` floors at 1 while `centre` clamps at 0, so neither rescues it.
`canvas/src/renderer.ts` now sizes the canvas to `max(viewport, drawing)` and the web page's CSS is
`overflow:auto`. **Measured both ways: `800x600 scrollable=false` before, `800x616 scrollable=true`
after.** It costs Electron nothing, because main sizes its window to exactly the drawing, and both
GUI goldens still match byte for byte — which is what made changing a SHARED file safe.

### Both earlier questions ANSWERED by the user, 2026-09-16, and done

1. **THE AID HOLE IS NOW STRUCTURALLY IMPOSSIBLE, in two layers.** Core gained `pfAID(n)`/`paAID(n)`,
   which throw a `RangeError` naming a bound taken from the table's own length, and **`Session.sendAID`
   now refuses any byte that is not in `VALID_AIDS`** (built from `AID` itself, so a new key needs no
   second edit). Only TWO call sites indexed the tables unsafely — `frontend/src/actions.ts` and
   `cli/src/runner.ts` — not all four front ends as the question assumed, so the change was much
   cheaper than feared. `runner.ts` also stopped hardcoding 24 and 3.

   **THE MUTATION MATRIX IS THE INTERESTING PART, because it is not what it looks like.** Measured,
   all four combinations, with `{kind:'pf', n:-1}`: both guards → nothing sent; accessor removed →
   nothing sent, `sendAID` refuses `undefined`; backstop removed → nothing sent, `pfAID` throws
   first; **both removed → `[0x00, 0x40, 0x40, 0xff, 0xef]` on the wire, the original defect.** So
   `sendAID`'s check is the load-bearing one and the accessors are the API-level fix that keeps the
   unsafe index unreachable — and `actions.test.ts` pins the pair rather than either, with each guard
   falsified separately in `constants.test.ts` and `session.test.ts`.
2. **THE TOKEN NOW DEFAULTS OFF** (`--auth on` opts in). **Read it together with the loopback bind:**
   out of the box only this machine can reach the port, and a token against your own emulator is
   friction that buys nothing. `main.ts` therefore warns on the COMBINATION — bound off loopback with
   auth off — and not on `--auth off` alone, which would now print on every run and be learned as
   noise. Verified by running all three configurations: loopback+off is silent, `0.0.0.0`+off gives
   both warnings, `0.0.0.0`+on gives only the TLS one. `integration.test.ts` passes `--auth on`
   EXPLICITLY now, because the flip silently removed its token coverage — the "refuses the upgrade
   without a token" case went red, having had nothing left to refuse.

3. **`Session.off()` IS DONE TOO, and the `live` flag it replaces is gone.** Core gained
   `off(event, fn)` — a no-op for an unregistered function, because the gateway calls it on every
   socket close including ones that never reached `hello` — plus **`listenerCount(event)`, which
   exists so the leak is OBSERVABLE**: without it the only symptom is wasted CPU, which no assertion
   can see. `main.ts` now removes its three listeners in `onClose`, BEFORE `detach`, so the grace
   window never holds a session pointing at a socket that has gone.

   **THE TEST FOR IT PASSED VACUOUSLY AT FIRST, and the cause is a trap this branch already
   documented.** It polled `registry.attach(id)` to read the count — but `attach` on an
   ALREADY-ATTACHED id falls through and BUILDS A NEW SESSION, so the second poll read a fresh object
   with zero listeners and the test went green with the leak fully present. `SessionRegistry.peek(id)`
   now exists for observation without mutation, and with it the mutation is caught at the FIRST
   reconnect (`expected 1 to be 0`). **Re-read a registry API's mutation semantics before using it to
   observe anything.**

**No open questions remain.**

### FINDINGS FROM THIS BRANCH THAT NO AMOUNT OF REASONING WOULD HAVE PRODUCED

1. **`packages/gui/scripts/keys.mjs`'s staleness guard went BLIND when its subject moved packages.**
   It compared `gui/dist` against `gui/src`, and `keys.ts`/`renderer.ts` — its entire unique
   coverage — moved to `canvas`. It now iterates both packages **per package**: one `max` across
   both lets a fresh `gui` build mask a stale `canvas` one.
2. **A hostile `{"kind":"pf","n":-1}` put a bogus `0x00` AID byte on the wire to a live mainframe.**
   `PF_AIDS` has 24 entries, so an out-of-range index is `undefined`, the `!` hides it, and
   `Uint8Array.from([undefined])` coerces to `0`. The other three front ends are safe only because
   their `n` comes from a trusted keymap; **the gateway is the first front end where a remote party
   supplies it.**
3. **The session registry's anti-hijacking guard was unasserted.** `found !== undefined &&
   !found.attached` is what stops a leaked id attaching to another operator's logged-on session.
4. **`registry.attach(id)` IS NOT A CHEAP LOOKUP.** Because it reattaches only a DETACHED entry, an
   already-attached id falls through and BUILDS A NEW SESSION. Calling it per action — which the
   plan's own sketch did — would have opened a fresh mainframe connection on every keystroke.
5. **A LOCAL action emits no session event.** `emit('screen')` fires for host data and for a replay,
   but tab, the arrows, Home and a typed character only move the cursor. The gateway must repaint
   unconditionally after `applyAction`, exactly as Electron's main always has.
6. **`vitest` DOES NOT TYPECHECK.** 15 tests passed green while `npm run build` failed on
   `Buffer<ArrayBufferLike>`. Build before believing a suite.
7. **`spawnSync` BLOCKS THE EVENT LOOP, so a harness that reads another child's pipe sees nothing.**
   `browser-keys.mjs` reported the product broken while the product was fine. Any harness of that
   shape has this bug.
8. **The served module graph must be CLOSED.** `bridge.js` imports `./bridgecore.js`, which the
   asset table did not serve: a 404, then a black canvas with no error anywhere. A per-file
   existence check cannot find it, because the missing file is missing from the table.
9. **A review finding that CLAIMED to be verified was false.** `Object.freeze` already preserves
   literal types, so a requested `as const` on `OPCODE` was dead syntax. Re-measure a "verified"
   claim before implementing it.
10. **A wrong working directory produces plausible non-evidence.** A mutation check reported INERT
    because `npx vitest` ran from `packages/` instead of the repo root, found no tests, and printed
    nothing. Pin the cwd in every command.

### Environment notes for whoever resumes

- **Both Hercules systems were UP and verified reachable on 2026-09-15**: VM/370 on `127.0.0.1:3270`
  (22 fields, logo painted) and MVS 3.8j TK5 on `127.0.0.1:3271`. `ss`/`netstat` show nothing in this
  sandbox — probe with `/dev/tcp/127.0.0.1/PORT`.
- **Xvfb does not survive a container restart.** Start it detached and prove the socket:
  `[ -S /tmp/.X11-unix/X99 ]`. Never `pgrep -f "Xvfb :99"`, which matches the shell command
  containing the pattern.
- **A `git checkout` reddens `keys.mjs`'s staleness guard** (it rewrites mtimes without changing
  content, which `npm run build` cannot clear). Now that two packages are watched, the fix is
  `npx tsc --build --force packages/canvas packages/gui`.
- **Pin the working directory in every command.** A bare `npx vitest` from outside the repo silently
  downloads a DIFFERENT vitest (measured: 5.0.1 against the workspace's 3.2.7) and reports plausible
  non-evidence. Use `./node_modules/.bin/vitest`.
- **Do not run two agents that both mutate the same package.** Mutation checks in a shared checkout
  cross-contaminate: two agents reported opposite results for the same mutation, and resolving it
  required re-running it on a quiet tree. Serialize, or give each agent its own worktree.

**MOST RECENT WORK, merged 2026-09-15 as `43ec70d`:** four palette schemes in
`packages/frontend/src/palette.ts` behind a new `-scheme` flag (`default`, `3279`, `x3270`,
`green` — TUI and GUI only; the CLI has no renderer); PA1-3, Attn (`Ctrl-A`) and Insert bound
in both front ends, which had been implemented in `core` and reachable from no key; a fix for
`Esc`-then-`1` typing the digit in the TUI; and the default terminal type changed to
`IBM-3278-2-E`, since MVS TSO rejects the bare form with `IKT00405I`. Design and plan are
`docs/superpowers/specs/2026-09-14-shared-palette-and-unreachable-keys-design.md` and
`docs/superpowers/plans/2026-09-14-palette-schemes-and-unreachable-keys.md`; the live results
are in `docs/live-testing.md`.

**THAT WORK'S ONE SOFT SPOT IS NOW CLOSED, on branch `gui-key-chord-guard`.** The
`TN3270_GUI_KEYS` seam sends modifier chords (`packages/gui/src/keyspec.ts` parses the
spellings), and `packages/gui/scripts/keys.mjs` is a committed harness that drove **15 chords
through real Chromium key events and asserted 13 actions in order, plus two required
absences** (`Ctrl+Z` must not type "z"; `F13` must not become PF13). **It is 18 chords / 16 actions
as of the keypad branch**, which added `Ctrl-D`, `Ctrl-F` and `Ctrl-K`; the figures in this
paragraph are the ones that were measured when the guard was built. **Be precise about what
is newly guarded:** the Alt-digit *mapping* was already unit-tested — `keys.test.ts` calls
`actionForKey` directly, and unbinding `PA_CODES` reddens `npm test` too (3 failures) — so what
this harness adds is the **renderer `keydown` listener, the IPC hop and `ipcMain`'s dispatch**,
the plumbing the original bug lived in. **Its failure has been OBSERVED, not assumed:** adding
`if (e.altKey) return;` to `renderer.ts`'s `keydown` listener leaves `npm test` fully green at
1352 and reddens only `keys.mjs`, which fails all 13 positions. **The keypad branch then repeated
the whole experiment in the MOUSE path** and got the same shape: a bare `return` at the top of
`renderer.ts`'s `mousedown` listener leaves build, typecheck and every test clean — 1643 at the time
of that measurement — while every keypad button is dead, and only `clicks.mjs` reddens.

**`keys.mjs` is NOT part of `npm test`** — it spawns Electron, so run it by hand
(`node packages/gui/scripts/keys.mjs`, expecting `ok       18 chords, 16 actions in order`),
like `shot.mjs`, `clicks.mjs` and `pty-smoke.py`. What `npm test` carries is
`packages/gui/test/keys-harness-flags.test.ts`, which pins that harness's argv, cases and
pass conditions as text so it cannot rot unnoticed. **Read `docs/live-testing.md`, *The GUI's
key chords, and which spellings Chromium accepts*, before touching the seam:** an invalid
`keyCode` is not refused by Chromium, it is delivered as an EMPTY event, and the invalid
spellings are the ones our own keymap makes natural.

**STAGE 2b (TN3270E) IS COMPLETE, AND ITS VERIFICATION IS QUALIFIED.** All 15 plan
tasks are done. The option, DEVICE-TYPE/FUNCTIONS, the 5-byte header, SNA responses,
SYSREQ, LU selection and the `N:` prefix all work end to end — **against real s3270
4.5ga6 and `packages/cli/scripts/e-server.py`, NOT against a live host.** Neither
Hercules system offers option 40; measured on both, accepting and refusing. Do not
quote this result without that qualifier. ~~When a real z/VM or z/OS appears, run the
probe~~ **The probe WAS run, 2026-09-17, against a real z/VM 4.4 — see
`docs/live-testing.md`, *TN3270E against a real host*, and the spec's *Live host,
2026-09-17*. One of the four questions is answered; three are not, because the host
withdraws the option after our `DEVICE-TYPE REQUEST` and the negotiation never reaches
FUNCTIONS. The qualifier above therefore STANDS: TN3270E is still not functionally
verified against a host. What is now verified live is that a host offers option 40, that
it sends `SEND DEVICE-TYPE` itself, and that our backoff reaches a usable session.**
Whether a host sends `FUNCTIONS REQUEST` first is still the largest branch no server has
ever exercised.

**AND THE REFUSAL IS DIAGNOSED, 2026-09-17: THE HOST'S FAULT.** s3270 4.5ga6 was built on this
box — the compiler was always here, behind `source /opt/lsst/software/stack/loadLSST.bash` —
and refused identically in all four recorded device-type variants after sending a byte-identical request; the host
answers with no TN3270E subnegotiation at all where RFC 2355 §7.1.5 requires a `DEVICE-TYPE
REJECT`. **So the qualifier changes shape but does not lift: our client is EXONERATED on that
exchange and still NOT functionally verified.** Never quote the first half without the second.
**The oracle that can lift it is `playback -b`, not a host** — details in *Where things stand*
above. Two known divergences from s3270 to account for before reading any mismatch as a bug:
BIND-IMAGE, declined by design at the time this was written (**reversed on `bind-image`,
2026-09-19 — see *START HERE***), and the bare DEVICE-TYPE under `-model`.

`packages/cli/scripts/drive-e.py` is the committed driver: seven configurations at the time this
was written, **now ten on `bind-image`**, asserting on the harness's exit code and the wire log.
Our `DEVICE-TYPE REQUEST` is byte-identical to s3270's; `FUNCTIONS REQUEST` used to be its list
minus BIND-IMAGE, pinned as an ABSENCE — **on `bind-image`, BIND-IMAGE is pinned as PRESENT
instead, and three of the ten configurations exercise the BIND gate and its timeout.**

**STAGE 3 IS BUILT, 2026-09-14. Both parts.** `packages/frontend` exists (graph is
`core ← frontend ← { cli, tui, gui }`, and `tui` no longer depends on `cli`), and
`packages/gui` is an Electron window that RENDERS LIVE 3270 SCREENS FROM BOTH HERCULES
SYSTEMS and accepts typed input. **1283 tests in 51 files.**

**What the GUI is not, yet:** no connect dialog, no menus, no preferences, no mouse, no
packaging. The host and flags come from the command line exactly as the TUI takes them.
(**"no mouse" was superseded by the keypad branch** — the mouse now presses keypad buttons, and
only keypad buttons. Everything else in this line still holds.)

**Two success criteria are PARTLY met and say so in the spec:** PF/PA/Clear travel the same
verified path as typing but were not exercised live, and no logon was completed (it would arm
VM's reconnect trap and could put a password in a screenshot). `Ctrl-]` and the in-window
error path are implemented but unverified live.

**Read `docs/live-testing.md`, *The Electron GUI against both hosts*, before touching the
renderer.** The verification method matters more than the result: a screenshot can be blank,
clipped, or of the wrong screen and still be a valid PNG, so the GUI's ink was compared ROW
BY ROW against the text the CLI reports from the same host. The one apparent disagreement was
the cursor, identified because its ink count was exactly 9x3 pixels.

**Five traps recorded there and in the commits, each of which cost a run:**
1. An ESM preload cannot load, and the bridge then silently never appears.
2. `include: ["src/**/*.ts"]` does not match `.cts`.
3. A browser cannot resolve `@tn3270/core`; there is no bundler, so `drawList` runs in MAIN.
4. `fetch` on `file://` is blocked, so main ships the atlas over IPC.
5. The first live run CLIPPED the host's data: model 4 needs 616px and the window was 600.

**THE ELECTRON GATE PASSED, 2026-08-28, on Electron 44.0.0** (not the 43 verified back in
August's design, and there was no Electron installed on this box any more — it had to be
re-established). Canvas renders under Xvfb and `capturePage()` returns real pixels. **Three
results that are NOT optional and will waste an afternoon if forgotten:**

- **`--no-sandbox` AND `--disable-gpu` are both required.** There is no GL at all on this
  box (`GLX is not present`).
- **`show: false` HANGS without `--disable-gpu`** — a stall, not an error, the same shape as
  the TLS trap.
- **`capturePage()` returns the CONTENT area**, so a `BrowserWindow` needs
  **`useContentSize: true`** or every screenshot golden silently depends on window chrome
  height and will not reproduce on a Mac.

Start Xvfb with `nohup` and then **check for `/tmp/.X11-unix/X99`**: backgrounding it inside
a command that exits kills it, and the symptom is `Missing X server or $DISPLAY` *with*
`DISPLAY` set. Full write-up in `docs/live-testing.md`, *Electron headless
re-verification*. Note the GUI work needs `npm install electron` (~227 MB); the spike's
copy was deliberately thrown away.

**Three defects fixed on the way, each worth knowing:**

- **TN3270E state outlived its connection.** `Session.e` was cleared only by the REJECT
  backoff path, so a second `Connect()` to a plain host still had `phase: 'negotiated'`
  and corrupted traffic both ways — inbound headers stripped from records that had
  none, outbound headers prepended for a host with no parser for them.
- **`N:` and the LU list were parsed and never applied.** `hostspec.ts` was fully
  tested while `splitTarget` was still what ran. `resolveHostSpec` now owns prefix
  meaning for BOTH front ends; `splitTarget` is deleted rather than left beside it.
- **The prefix letter class was `[A-Za-z]`.** s3270's set is exactly
  `AaCcLlNnPpSsBbYyTt` (`split_host.c:38`), so `Z:host` silently became prefix `Z` plus
  host `host`. Prefixes we do not implement are now refused by name.

**And one lesson that generalises, from the harness rather than the client:** two of the
three failures in the first `drive-e.py` run were the HARNESS's, and both presented as
client bugs — `e-server.py` scored a correct `WONT` refusal as `FAIL`, and the driver's
own readiness probe was accepted as the client (the server serves exactly one
connection), so the real client got `ECONNREFUSED` while the log claimed success. When a
new harness reports that the client is broken, suspect the harness first until it has
been shown to satisfy a known-good client.

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
support **beyond keypad buttons, which the keypad branch added — no click-to-place-cursor, no
drag-to-select, no light pen**; the Electron GUI (stage 3, since DONE); and the web front end
(**also since DONE**). **TN3270E (stage 2b) is
now done** — see *Where things stand*. Within it, BIND/UNBIND, once undone because we declined
BIND-IMAGE by design, **is now built and MERGED to `main` (`06232cc`) — see *START
HERE*** — and the **printer session now has its harness but nothing has
driven it**.

## Roadmap, from the user 2026-08-25

**STATUS AS OF 2026-09-17 — the list below is kept as WRITTEN, not rewritten.** This file's practice
is to leave superseded items in place, because that is what let a correction land cleanly once
before. Read the status here and the reasoning there. **One cell is now stale in a way that would
read as a live bug if left silent: item 1's "except BIND/UNBIND" is superseded by the `bind-image`
branch — BIND/UNBIND is built, see *START HERE*.** The table itself is left as written below.

| item | state |
| --- | --- |
| 1. the rest of TN3270E | **DONE** (stage 2b), except **BIND/UNBIND** and **printer sessions**; `IBM-DYNAMIC` also outstanding |
| 2. the Electron app | **DONE** and merged |
| 3. a webserver serving the same front end | **DONE** and merged, 2026-09-16 |
| 4. Programmable Symbol Sets + VMGIF | not started; **the user moved the keypad ahead of it** on 2026-09-15 |
| 5. packaging | not started |
| 6. TLS | **DONE** and live-verified |
| 7. the printer session | not started |
| 8. real TN3270E + `IBM-DYNAMIC` (added 2026-09-14) | **`IBM-DYNAMIC` IS NEXT** — the user scheduled it immediately after the keypad on 2026-09-16. It has a live path (TK5's Read Partition); the negotiation still does not — both Hercules hosts refuse option 40, and z/VM 4.4 (`evievm.pubvm.org:23`, probed 2026-09-17) offers it and then withdraws it, so the offer and the backoff have live witnesses and a completed negotiation does not |
| 9. keypad / special-keys menu (added 2026-09-14) | **BUILT AND VERIFIED on branch `keypad-and-special-keys`, NOT MERGED.** All 15 tasks, plus the non-TN3270E Sys Req path the user authorised on 2026-09-17; the whole gate passes. Two things wait on the user — the merge and the keypad's styling. See the top of this file |

**So the order from here is: land (9), then `IBM-DYNAMIC` from (8), then (4) PS + VMGIF, with
packaging, the printer session and BIND/UNBIND unscheduled.** The user asked about more TN3270E on
2026-09-16, so BIND/UNBIND and printer sessions may move up — but neither has a live path here.

**THIS LIST IS NOT EXHAUSTIVE, AND THE USER HAS SAID SO EXPLICITLY.** It was first
written down as "I think that will be everything", and was then corrected three times in
as many messages: Programmable Symbol Sets had been forgotten; then "so the above will
not in fact be everything"; then packaging, TLS, printer and PS were all confirmed to
remain. Treat it as an OPEN set, not a definition of done, and **do not infer that
something is out of scope merely because it is absent here.**

The confirmed work. Items 1-4 are in the user's own stated order; 5-7 are confirmed on
the roadmap but their position is not, so the old staging's relative order is used below
as a presumption only:

1. **The rest of TN3270E** — stage 2b: the telnet option (40), DEVICE-TYPE/FUNCTIONS
   subnegotiation, the 5-byte data header, BIND/UNBIND, SNA responses, LU selection.
2. **An Electron app** — stage 3. The renderer constraint to remember: cell content is a
   tagged variant, so dispatch on `kind` rather than assuming a font lookup.
3. **A simple webserver serving the app as well**, i.e. the same front end over HTTP.

4. **Programmable Symbol Sets, and VMGIF.** *Corrected 2026-08-25, minutes after the
   list above: the user had simply FORGOTTEN this, not dropped it.* PS is still wanted.
   Its hard dependency — stage 2a's Query Reply — is already built, as is the reason
   `Cell` is a tagged variant: a renderer must dispatch on `kind` rather than assume a
   font lookup, and PS is the only thing that variant exists for. **VMGIF is in hand at
   `$HOME/vmgif`** (April 1993: `VMGIF.MODULE.T1` 84600 bytes, wrapper execs, HELPCMS,
   and `TONETABL`, its palette/dither table). No source, and disassembly is probably
   unnecessary — decoding GIF from the published spec is no harder than reverse
   engineering a 1993 implementation once PS can push pixels. Treat it as a behavioural
   reference. GDDM is deliberately NOT a dependency (IBM is sunsetting it); the route is
   PS driving the 3279 screen directly.

5. **Packaging** — the old stage 4. Confirmed 2026-08-25. Presumably follows the Electron
   app and the webserver, since it packages them.
6. **TLS.** Confirmed 2026-08-25. Not polish: a 3270 client that cannot do TLS is
   unusable against anything modern, so it may well deserve to move ahead of items 2-4
   — worth asking when 2b lands.
7. **The printer session.** Confirmed 2026-08-25. Its natural companion is TN3270E,
   whose own payoff the spec lists as "LU names, printer sessions and response
   handling", so item 1 may leave this close to free.

**All four of packaging, TLS, printer and PS were explicitly confirmed to remain**, so
nothing from the older staging has been dropped.

**CORRECTED BY THE USER 2026-09-25 — NATIVE VECTOR GRAPHICS IS NOW ON THE ROADMAP, SCHEDULED
AFTER PS.** This supersedes the standing "GDDM vector graphics is deliberately NOT on the
roadmap" decision, and the distinction that resolves it is the user's: **the 3179-G and 3192-G
accept vector orders in Write Structured Field and RASTERIZE LOCALLY.** That is a TERMINAL
capability, so implementing it is not a dependency on GDDM — GDDM is merely the host software
that drives it, and its being sunset says nothing about a terminal-side data stream. The old
reasoning conflated the two. What stays true: we do not depend on GDDM, and PS remains the
prerequisite that gets pixels onto the screen.

**THE ENVELOPE IS IN THE MANUAL WE ALREADY OWN; THE PRIMITIVES ARE NOT.** Verified 2026-09-25
against `~/3270/ref/pages.txt`. Three outbound/inbound structured fields carry it, all three
with `PID`, a 2-bit `SPANF` spanning flag and a 2-bit `MODE`, and a byte 6 `OBJTYP` of `X'00'`
Graphics or `X'01'` Image:

| SFID | Name | Manual |
|---|---|---|
| `X'0F11'` | **Object Control** | `pages.txt:7219` (index `:4445`) |
| `X'0F0F'` | **Object Data** | `pages.txt:7277` (index `:4446`) |
| `X'0F10'` | **Object Picture** | `pages.txt` *Object Picture* (index `:4447`) |

**`Object Picture` has a fourth MODE the other two lack: `B'11'` STORE AND DRAW** — the others
define only `B'00'` immediate and `B'10'` store, with `B'01'` reserved. So Object Picture is the
one that actually renders, and that asymmetry is the first thing to pin in a spec.

**ALL THREE DEFER THEIR CONTENTS: byte 7-n is "Data appropriate to the object type. For the
format and contents of this parameter, refer to the appropriate graphics or image
publications."** The same deferral appears in Query Reply (Segment) `X'B0'`. So the 3270
Programmer's Reference gives us the framing and **none** of the drawing orders, and prycroft6
says the same in as many words. **The architecture to chase is GOCA — *Graphics Object Content
Architecture for Advanced Function Presentation Reference*** — which prycroft6 names explicitly
and which we do NOT have locally. Acquiring it is the real prerequisite; no amount of reading
`pages.txt` will yield a line-drawing opcode.

**THE GDDM LINK THE USER SENT IS A FALSE LEAD, checked 2026-09-25.**
`ibm.com/docs/en/gddm?topic=asvsec-descriptions` is the **GDDM-PGF Vector Symbol Editor** command
reference — interactive `DRAW`/`LINE`/`CURVE`/`STRETCH` commands for authoring custom symbol sets
in a tool, with no hex opcodes and no data-stream format. The user's hypothesis that GDDM
instructions "might map pretty directly" to terminal orders is the right shape of question, but
that page cannot answer it; GOCA can. The z/OS "buffer description structured fields" link is
unrelated — DFSMSrmm API structured field introducers, nothing graphical.

**FOUR QUERY REPLIES GATE IT, and they are all `No / No / Yes` in Table 6-1** — returned for
Query List **All** only, never for a plain Query or an Equivalent list: **Graphic Color `X'B4'`
(`pages.txt:8603`), Graphic Symbol Sets `X'B6'` (`:8604`), Segment `X'B0'`, Line Type `X'B2'`,**
plus `Procedure X'B1'`, `Image X'82'`, `Transparency X'AB'` and `IOCA Auxiliary Device X'AA'`
nearby. **This costs us no rework:** `queryreply.ts` already models exactly that distinction with
`Capability.returnedForQuery`, and `selectCapabilities` already implements the Table 6-1 rules —
so hosting these is adding entries, not changing the capability model. Segment `X'B0'`'s own DATA
is deferred to "the appropriate graphics product publications" as well.

**Terminals: 3179-G, 3192-G, and the 3472 InfoWindow** (prycroft6). It also records that these
carried "the equivalent of the original PS-2 feature", i.e. **PS and vector graphics coexist on
the same hardware** — which is consistent with PS being sequenced first. Three protocol
generations exist and should not be conflated: PS (raster via loadable symbols), native vector
graphics (these structured fields), and Advanced Vector Graphics/PCLK (a PC-client protocol).

**Geometry is NOT hardcoded:** prycroft6 says an application reads **Usable Area** and **Implicit
Partition** to discover the drawing space — both of which we already build and send. No pixel
dimensions for the G-terminals are recorded anywhere we have yet; they are an open measurement.

**Neither x3270 nor c3270 implements any of this** (prycroft6 mentions no emulator, and our own
`sf.c` dispatch has no `0x0F10`/`0x0F0F`/`0x0F11` arm — so unlike every stage so far, **there is
no reference implementation to diff against**, and no Hercules host here drives a G-terminal.
That makes this the first feature with neither an x3270 oracle nor a live witness, which is worth
knowing before it is scheduled: the evidence model that has carried nine stages does not apply.

Sources: `~/3270/ref/pages.txt` (GA23-0059) and
<https://www.prycroft6.com.au/misc/3270grfx.html>.

8. **Real TN3270E, and `IBM-DYNAMIC` screen size.** Added by the user 2026-09-14, position
   not stated. ~~**Blocked on access to a real modern z/VM or z/OS, which the user had still
   not arranged as of 2026-09-14**~~ (first mentioned as being arranged 2026-08-27).
   **ACCESS ARRIVED 2026-09-17** — public z/VM 4.4 at `evievm.pubvm.org:23`, plaintext —
   **and it moved the first half only part way; see *Where things stand* at the top.**
   **The two halves are NOT equally blocked, and the difference is worth acting on:**
   - **Live TN3270E is partly unblocked as of 2026-09-17.** Both Hercules systems *refuse*
     option 40 rather than merely not offering it — send `ff fb 28` and both answer
     `ff fe 28`, measured passively, accepting and refusing. ~~**No client can get TN3270E
     here by any route.**~~ **CORRECTED 2026-09-17: that was true of the two Hercules hosts
     and is no longer true of this box. z/VM 4.4 at `evievm.pubvm.org:23` sends `IAC DO
     TN3270E` unprompted and asks `SEND DEVICE-TYPE`, then withdraws the option after our
     request — so option 40 CAN be reached from here; a COMPLETED negotiation still cannot,
     and the reason is ~~unresolved~~ **the host's own non-conformance, settled later that
     same day by building s3270 here and being refused identically — see *Where things
     stand*.** So
     what item 1 lacks is a live witness, not an implementation: the negotiation is verified
     against real s3270 4.5ga6 and the in-repo `e-server.py`. Quote that qualification every
     time — **the 2026-09-17 run does not lift it; it witnesses the OFFER and the BACKOFF,
     not the negotiation, and "the host's fault" is an exoneration rather than a
     verification.** The genuinely unbuilt parts that a real host would unlock:
     BIND-IMAGE with a real
     BIND (at the time this was written, deliberately not requested — granting it and sending
     no BIND stops s3270 entering 3270 mode at all; **now requested regardless, on the
     `bind-image` branch, with a 5-second timeout instead of a hang — see *START HERE***),
     the printer session, and LU/device names actually being honoured —
     ~~and an LU name is now also the **diagnostic** for why z/VM 4.4 refuses.~~ **THAT LAST
     CLAUSE IS DEAD: s3270 sent `IBM-3278-2-E CONNECT VTAM` to this host and was refused too,
     so an LU name diagnoses nothing here.** And BIND no longer needs a host at all —
     `playback -b`'s recording contains one.
   - **`IBM-DYNAMIC` is NOT blocked in the same way.** Its client-side prerequisite is Read
     Partition (Query) / Query Reply, and **MVS 3.8j TK5's TSO issues one** — captured
     2026-08-17 in `packages/fixtures/x3270/tso-query-reply.txt`, with ttype `IBM-3278-2-E`
     and **TN3270E not negotiated at all**, so the trigger is the `-E` claim and nothing to
     do with option 40. What a modern host would add is a host that *asks* for dynamic
     geometry and honours the answer; the mechanism can be exercised on TK5 today.
     `IBM-DYNAMIC` is currently out of scope by decision (`termtype.ts:40-44`) — it is not a
     model but "ask me via Query Reply", and x3270 sends it only for oversize
     (`telnet.c:2101`).

The method note, because it paid off twice inside one exchange: an end-of-session aside
is not a decision recorded against the spec. This roadmap was written down as a QUESTION
with the superseded items left in place rather than deleted, which is what let the user
catch first the forgotten item and then the false "everything" framing. **Keep asking
what is missing from a list rather than treating a stated list as closed.**

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
  **THE BINARIES ARE UNDER `obj/`, NOT BESIDE THEIR SOURCE — checked 2026-09-24.**
  `obj/x86_64-conda-linux-gnu/s3270/s3270` and `.../playback/playback`, both built
  2026-09-17 with gcc 14.4.0. **`ls s3270/s3270` finds nothing and is NOT evidence
  the tool is unbuilt**; that mistake was made this session. `make s3270 playback`
  answers "Nothing to be done". **`c3270` is at `~/bin/c3270`, v4.5ga6.** All of it
  needs `source /opt/lsst/software/stack/loadLSST.bash` **followed by `hash -r`** —
  without the rehash, `command -v make` reports MISSING even with its directory on
  `PATH`, which is a sharper version of lesson 12 below.
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

- ~~**No compiler**~~, **no X, no root on this box.** A userspace GUI toolchain was built
  with a static micromamba into `~/micromamba/envs/gui` (Chromium/Electron libs,
  gtk3, libcups, fontconfig + fonts, Xvfb). **Re-verified 2026-08-28 on Electron 44.0.0
  with `--no-sandbox --disable-gpu`** — see *Where things stand*. Real Electron renders and
  screenshots under Xvfb. Invocation is in the spec's *Development Environment*.
- **THERE IS A C COMPILER. `which cc gcc` FINDING NOTHING DOES NOT MEAN THERE ISN'T ONE**
  — corrected 2026-09-17, after the "no compiler" clause above cost a day and produced a
  wrong verdict in three documents. This box is an RSP notebook container and the toolchain
  lives in the LSST stack's conda environment, which is not on `PATH` until loaded:

  ```bash
  source /opt/lsst/software/stack/loadLSST.bash   # gcc 14.4.0 (conda-forge), GNU Make 4.4.1
  ```

  **Source that script; never paste the expanded `PATH` entry**, which contains
  `lsst-scipipe-13.1.0-exact` and rots at the next stack upgrade. With it loaded,
  `make s3270` in the already-configured suite3270 tree takes **23 seconds, exit 0, TLS
  included, no extra flags**. `make playback` likewise.

  **The false claim was refutable from THIS FILE.** The next bullet has recorded an s3270
  binary built here since 2026-08-17 — the same day the "no compiler" clause was written, in
  the same document. A stated environment limit was never re-tested against the evidence
  sitting one bullet below it.
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

  **AND THE `-model` SUFFIX DOES NOT REACH THE TN3270E DEVICE-TYPE — added 2026-09-17.**
  `-model 3278-2` gives s3270 a bare `IBM-3278-2` TERMINAL-TYPE but it still sends
  `IBM-3278-2-E` as its DEVICE-TYPE: `tn3270e_request()` calls `create_3270_termtype(true)`
  (`Common/telnet.c:2121-2122`), which appends `-E` unless extended data stream is off or
  `S:` set `STD_DS_HOST` (`Common/telnet.c:2106`). **We send the bare form there; s3270 never
  does.** So `-model` is NOT a way to compare device types, and only `S:` or `-tn3270e off`
  moves that field. An open conformance decision, not a bug — see *Where things stand*.
  Note also **s3270 appends the LU to TERMINAL-TYPE**, `IBM-3278-2-E@VTAM`
  (`Common/telnet.c:2019-2024`), not only to DEVICE-TYPE.
- **`playback` 4.5, built 2026-09-17, at
  `~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/playback/playback` — THE PROJECT'S NEW
  REFERENCE ORACLE.** `playback -b -p PORT file.trc` replays a recorded host **and asserts
  the client's replies match the recording byte for byte** (`Matched N bytes from emulator`),
  needing **no network and no live host**. `usage: playback [-b] [-w] [-p [address:]port]
  file`. Recordings ship in the suite; `s3270/Test/devname_success.trc` is a **complete
  TN3270E negotiation including a real BIND** (`PLU-name 'IBM0SMAJ'`). **Prefer it to the
  in-repo `e-server.py`**, which we wrote ourselves and which can only check what we thought
  to encode. Use it to validate any freshly built s3270 before trusting a comparison — a
  broken build looks exactly like a hostile host.
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
12. **A STATED ENVIRONMENT LIMIT IS A CLAIM, AND IT DECAYS — RE-TEST IT BEFORE BUILDING A
    CONCLUSION ON IT (2026-09-17).** "There is no s3270 binary on this box and no compiler
    to build one" was written into `docs/live-testing.md`, the stage 2b spec and this file,
    and used to reason that we could not tell whether z/VM 4.4's TN3270E refusal was our
    fault — **explicitly recorded as cutting against us**. Both halves were false. The
    compiler was behind `source /opt/lsst/software/stack/loadLSST.bash`, and `make s3270`
    took 23 seconds. **The refutation was already in this file, in two places**: the
    environment bullet giving the path of an s3270 built here on 2026-08-17, and lesson 11
    above saying in as many words that "s3270 was built locally the whole time". The real
    verdict is the opposite of the one recorded: **the host is at fault and our client is
    exonerated.** Two habits, both cheap: when `which X` fails on a box with a scientific
    software stack, look for the stack's activation script before concluding X is absent;
    and when a conclusion rests on "we cannot do Y here", grep the handoff for Y before
    accepting it.
    **IT HAPPENED AGAIN ON 2026-09-24, TO THE SAME PERSON READING THIS SAME FILE, so the
    lesson is restated with the two mechanisms that actually cause it.** I reported that
    building `c3270` was "a toolchain expedition, not a small job" on the evidence of
    `which make gcc cc` — and `~/bin/c3270` had existed since 2026-08-17. **(a) `hash -r`
    IS REQUIRED after sourcing the stack**, or `command -v make` still answers MISSING
    with its directory on `PATH`: the restored shell snapshot carries stale command
    hashes, so even the correct activation looks like it failed. **(b) A built binary may
    not sit beside its source** — `s3270` and `playback` live under
    `obj/x86_64-conda-linux-gnu/`, so `ls s3270/s3270` "proving" they are unbuilt was the
    second false negative in the same five minutes. **Three wrong readings, one cause:
    every one was a search that could only have found the thing in the place I guessed.**

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
