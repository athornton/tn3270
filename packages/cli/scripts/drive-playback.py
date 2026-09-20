#!/usr/bin/env python3
"""
Drive OUR client against x3270's `playback -b` and the traces it ships.

WHY THIS IS A DIFFERENT ORACLE FROM e-server.py, AND STRICTLY STRONGER IN ONE WAY.
`e-server.py` is a server WE wrote from RFC 2355 and x3270's source, so it can only
check what we thought to encode; a shared misreading passes it. `playback -b` replays
a RECORDED REAL HOST -- several of the traces below came off commercial VTAM systems
and one off a university VM -- and asserts, byte for byte, that the emulator's replies
match what a known-good client really sent. No network and no host is involved, which
is why this can run in a sandbox where TN3270E has never once completed against a
reachable host.

READ THIS BEFORE TRUSTING A GREEN RUN -- THREE PROPERTIES OF THE INSTRUMENT, ALL
MEASURED 2026-09-17 AND RECONFIRMED 2026-09-18 after Task 11/12 added BIND-IMAGE to
our FUNCTIONS REQUEST, EACH OF WHICH CAN MANUFACTURE A FALSE PASS:

1. `playback` EXITS 0 WHETHER OR NOT IT MATCHED ANYTHING. `Common/playback.c:373` is
   literally `exit(0); /* needs to be smarter */` at the end of the bidirectional
   loop. A mismatch exits 2 from `:961`, but a run that matched NOTHING and hit
   `Socket EOF` also exits 0. So this harness asserts on the `Matched N bytes from
   emulator` lines, and a case that expects N blocks and gets fewer FAILS. Never
   reduce this to a returncode check.

2. IT ONLY EVER COMPARES WHAT THE TRACE ALREADY CONTAINS. A trace that stops after
   negotiation proves nothing about the datastream, and 16 of the 71 shipped traces
   have NO emulator side at all (host recordings for renderer tests), so `-b` against
   them asserts exactly nothing. The `blocks` figure per case below is the evidence;
   it is not a threshold to be relaxed when something reddens.

3. A TRACE IS A RECORDING OF ONE CLIENT VERSION, NOT A SPEC. `sruvm.trc` and
   `rpqnames.trc` were recorded by c3270 v3.3.10alpha1 (2009) and expect
   `IBM-3279-4-E` in TERMINAL-TYPE. TODAY'S s3270 4.5ga6 SENDS `IBM-3278-4-E` THERE
   AND MISMATCHES THEM IDENTICALLY TO US -- verified by running the known-good binary
   against them, which is the only reason we know it is the trace and not our client.
   Modern s3270 needs `-xrm '*wrongTerminalName: true'` to satisfy them. They are
   therefore EXCLUDED, with the reason recorded, rather than left to fail.

THE OLD STRUCTURAL LIMIT IS GONE (measured 2026-09-18, superseding the 2026-09-17 note
below that used to live here). Task 11/12 added BIND-IMAGE to
`packages/core/src/tn3270e.ts` REQUESTED_FUNCTIONS, so our FUNCTIONS REQUEST is now
the SAME 11 bytes `fffa28030700020405fff0` that every one of these traces expects,
where it used to be a 10-byte `fffa280307020405fff0` that fell one block short before
FUNCTIONS could even be compared. All five of the pre-existing cases below now match
one MORE block than before (3 instead of 2) as a direct result -- see each `Case`'s
`stop_reason` for the specific reason it stops where it now does; none of the five
old traces goes past FUNCTIONS, for reasons that differ per trace (a host WONT, a
host waiting on a keystroke the harness's short script never drives, or a BID reply
we do not implement) and are documented case by case rather than with one blanket
excuse.

WHAT NEW EVIDENCE THIS ADDS: `s3270/Test/sscp-lu-data.trc` (copied into
`packages/fixtures/x3270/`, see the `Case` below for why) is a real host that grants
BIND-IMAGE, so it is the one trace here that gets PAST FUNCTIONS to an actual
recorded BIND -- 4 matched blocks where the other five stop at 3.

TASK 8 (2026-09-20): NEW-ENVIRON (telnet option 39, Tasks 6/7) now exists, so all
FOUR devname_*.trc traces that motivated it are drivable and each match 9 blocks --
further than every case above INCLUDING sscp-lu-data.trc, because NEW-ENVIRON's
per-request DEVNAME exchanges interleave with TN3270E's own steps. `devname_success.trc`
was this feature's original motivating trace and is NO LONGER EXCLUDED; see the
`Case` block comment above the four devname_*.trc entries for the measured account
(template per trace, USER/CODEPAGE absence, the iteration-count check, and why none
of them needs `mismatch_ok`).

    python3 packages/cli/scripts/drive-playback.py [--playback PATH] [--node PATH] [-v]

Exit 0 means every case matched at least its expected number of blocks with no
mismatch. Any failure prints that case's playback log, because the wire bytes are the
only useful thing at that point.
"""
import argparse
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CLI = os.path.join(REPO, 'packages', 'cli', 'dist', 'main.js')

#: Where the user's suite3270 build lives. Overridable, because it is outside this
#: repo and its object directory is toolchain-specific.
DEFAULT_SUITE = os.path.expanduser('~/src/suite3270-4.5')
DEFAULT_PLAYBACK = os.path.join(
    DEFAULT_SUITE, 'obj', 'x86_64-conda-linux-gnu', 'playback', 'playback')

#: IN THE REPO, unlike DEFAULT_SUITE above: the `playback` BINARY has to live outside
#: this repo (it is a build product of a hand-built suite3270 checkout, and its object
#: directory is toolchain-specific -- see DEFAULT_PLAYBACK), but a TRACE is a small
#: data file with no build step, so there is no reason to make a fresh checkout of
#: suite3270 a precondition for a case that isn't drawn from the user's `--suite`. Any
#: `Case` whose `trace` names a file under here (see `Case.__init__` and
#: `run_case`'s path resolution) is resolved against FIXTURES instead of `suite`.
FIXTURES = os.path.join(REPO, 'packages', 'fixtures', 'x3270')

# TLS is ON by default and playback speaks plaintext. Without this the run does not
# fail, it HANGS: a plaintext peer's leading 0xff is read as a TLS record type and
# OpenSSL blocks for a length that never comes. Same trap as every other harness here,
# and the reason packages/tui/test/harness-flags.test.ts pins this argv.
REQUIRED_FLAGS = ['-insecure']


class Case:
    """One trace, and what our client must be seen to send while playing it."""

    def __init__(self, trace, model, blocks, expect_bytes=(), stop_reason='',
                 mismatch_ok=False, root='suite', devname=None):
        #: Path relative to `root`.
        self.trace = trace
        self.model = model
        #: MINIMUM number of `Matched N bytes` blocks. Measured, not aspirational.
        self.blocks = blocks
        #: Hex strings that must appear as matched emulator data.
        self.expect_bytes = expect_bytes
        #: Why the match stops where it does -- documentation, not an assertion.
        self.stop_reason = stop_reason
        #: True only where a mismatch is the CORRECT outcome and s3270 shares it.
        self.mismatch_ok = mismatch_ok
        #: 'suite' resolves against the `--suite` CLI arg (a hand-built suite3270
        #: checkout, outside this repo); 'fixtures' resolves against FIXTURES, the
        #: in-repo `packages/fixtures/x3270/` directory. See FIXTURES's comment for
        #: why a trace, unlike the `playback` binary itself, does not need to live in
        #: the user's suite3270 checkout at all.
        self.root = root
        #: `-devname` template to pass our client (e.g. 'foo==='), or None to leave
        #: option 39 refused. Threaded into `client_argv` the same way `model` is --
        #: see `run_case`. The four devname_*.trc traces each pin a DIFFERENT
        #: template (read off their own recorded `Command:` line, not guessed): the
        #: iteration WIDTH the host's own recording used has to match ours, or the
        #: DEVNAME uservar values diverge for a reason that is a harness setup
        #: mistake, not a client bug.
        self.devname = devname


# Every one of the five traces below now sends the SAME 11-byte FUNCTIONS REQUEST as
# s3270 (measured 2026-09-18, after Task 11/12 added BIND-IMAGE to REQUESTED_FUNCTIONS
# in tn3270e.ts) and so all now match one block further than before: 3 matched blocks
# where they used to stop at 2, one block short of FUNCTIONS. None of them reaches a
# BIND -- each stops for its own reason, given per case below -- so `sscp-lu-data.trc`
# further down is what actually demonstrates the oracle getting past FUNCTIONS.

CASES = [
    # The furthest any trace gets on the TN3270E path in the sense of NEGOTIATION
    # ALTERNATIVES exercised: this host answers our WILL TN3270E, our DEVICE-TYPE, and
    # our (now 11-byte) FUNCTIONS REQUEST with `RCVD WONT TN3270E` -- x3270's own
    # trace confirms real s3270 replies `SENT WONT TN3270E` and falls back to classic
    # TN3270 (DO TERMINAL TYPE, etc: wont-tn3270e.trc lines 88-97). Recorded against a
    # real VTAM (SC0TCP01).
    #
    # THE GAP THIS CASE ONCE DOCUMENTED IS FIXED, and this case is now the witness for
    # the fix. It used to stop at 3 blocks: our `St.Wont` handler only fired for options
    # in `hisOpts` (options the HOST does), while TN3270E lives in `myOpts` (options WE
    # do), so a host withdrawing it with WONT instead of DONT got no reply at all and
    # playback saw `Socket EOF` waiting for one. x3270 carries the same special case and
    # names it, verbatim, "Ugly hack for hosts that send WONT TN3270E instead of DONT
    # TN3270E" (Common/telnet.c:1879-1889).
    #
    # Now we answer `ff fc 28` and fall back to classic TN3270 exactly as real s3270
    # does, so this case reaches FIVE blocks: WILL TN3270E, DEVICE-TYPE REQUEST,
    # FUNCTIONS REQUEST, **WONT TN3270E**, and then WILL TERMINAL-TYPE on the classic
    # path. The 4th and 5th are what the fix bought, and they are asserted below so a
    # regression cannot quietly return to silence.
    #
    # IT STOPS ON A KNOWN DIVERGENCE THAT IS NOT OUR BUG -- rule 3 above, a trace
    # records one client version. At the 6th block we send our TERMINAL-TYPE as
    # `IBM-3278-4-E`; the recorded x3270 sent `IBM-3279-4-E` (line 105), the COLOUR
    # digit, while still sending `IBM-3278-4-E` for its TN3270E DEVICE-TYPE (line 78).
    # That is `wrongTerminalName`: `telnet.c:2104` uses the colour digit when
    # `model_num < 4` OR the resource is set, and this recording is a model 4 with it
    # set (`Model 3279-4-E` in the trace header). Whether to match it is an open
    # question recorded in docs/live-testing.md, not a defect to fix here.
    # `mismatch_ok=True` is NEW for this case and is the narrow thing to check if this
    # ever regresses. Before the fix the run ended in `Socket EOF` -- playback waiting
    # forever for a reply we never sent -- which produces no mismatch line at all, so the
    # flag was not needed. Now we DO reply, get four blocks further, and stop on the
    # terminal-type divergence below, which IS a mismatch and IS the correct outcome for
    # our configuration. The five `expect_bytes` are what keeps this honest: the flag
    # tolerates the stopping point, it does not excuse the blocks before it, and a
    # regression to silence would fail on `fffc28` being absent rather than passing
    # quietly.
    Case('s3270/Test/wont-tn3270e.trc', '3278-4-E', 5,
         expect_bytes=('fffb28', 'fffa28020749424d2d333237382d342d45fff0',
                       'fffa28030700020405fff0', 'fffc28', 'fffb18'),
         mismatch_ok=True,
         stop_reason=(
             'we answer WONT TN3270E and fall back to classic TN3270 correctly, then '
             'send TERMINAL-TYPE `IBM-3278-4-E` where this recording sent the colour '
             'digit `IBM-3279-4-E` -- x3270 s `wrongTerminalName` (telnet.c:2104), a '
             'version/resource divergence and not a defect; see the comment above')),

    # A real host that GRANTS contention resolution and BIND-IMAGE, then drives a
    # keyboard Enter() to log on. Model 2, so it also pins that our DEVICE-TYPE
    # carries the model the flag asked for.
    Case('s3270/Test/contention-resolution.trc', '3278-2-E', 3,
         expect_bytes=('fffb28', 'fffa28020749424d2d333237382d322d45fff0',
                       'fffa28030700020405fff0'),
         stop_reason=(
             "the host's next expectation (18 bytes of 3270 data) is s3270 typing "
             "'l tso' and pressing Enter after a human-timed pause; this harness's "
             "short scripted Wait(3270Mode,8)+Quit never drives that keystroke, so "
             'the trace legitimately has more to prove than this harness exercises')),

    # IBM Link, a commercial VTAM host, via c3270. Same shape, different host, and it
    # is the trace whose host sends BIND then UNBIND then another BIND, then a BID.
    Case('c3270/Test/ibmlink2.trc', '3278-2-E', 3,
         expect_bytes=('fffb28', 'fffa28020749424d2d333237382d322d45fff0',
                       'fffa28030700020405fff0'),
         stop_reason=(
             "the host's next expectation (8 bytes) is our POSITIVE-RESPONSE to a "
             'TN3270E(BID ALWAYS-RESPONSE) the host sends after its second BIND; our '
             'client has no TN3270E_DT_BID (0x09) handling -- constants.ts models '
             "Tn3270eDataType only up through PRINT-EOJ (0x08), matching x3270's own "
             'header (include/tn3270e.h) but not our own coverage of it')),

    # SSCP-LU data: the host drives an SSCP-LU session before binding, then the same
    # keyboard-driven 'l tso' Enter() as contention-resolution.trc.
    Case('s3270/Test/sscp-lu.trc', '3278-2-E', 3,
         expect_bytes=('fffb28', 'fffa28030700020405fff0'),
         stop_reason=(
             "the host's next expectation (18 bytes of 3270 data) is the same "
             "scripted 'l tso' Enter() as contention-resolution.trc, which this "
             "harness's short Wait(3270Mode,8)+Quit script never drives")),

    # Model 4 against a real host, so the geometry in DEVICE-TYPE is exercised too.
    # Same BID limitation as ibmlink2.trc, from the same host family.
    Case('s3270/Test/bid.trc', '3278-4-E', 3,
         expect_bytes=('fffa28020749424d2d333237382d342d45fff0',
                       'fffa28030700020405fff0'),
         stop_reason=(
             "the host's next expectation (8 bytes) is our POSITIVE-RESPONSE to a "
             'TN3270E(BID ALWAYS-RESPONSE) the host sends after its BIND; see '
             "ibmlink2.trc's stop_reason for the same unimplemented TN3270E_DT_BID "
             '(0x09)')),

    # THE PAYOFF CASE: a real host that grants BIND-IMAGE and sends an actual BIND,
    # giving BIND/UNBIND parsing a real-host witness for the first time (both Hercules
    # test hosts refuse TN3270E option 40, and public z/VM 4.4 withdraws it before
    # negotiation completes -- see docs cited elsewhere in this repo).
    #
    # devname_success.trc WAS EXCLUDED HERE UNTIL TASK 8 (see the old note, now
    # replaced) BECAUSE NEW-ENVIRON DID NOT EXIST YET. Tasks 6/7 have since built it,
    # so this trace and its three siblings below are now driven directly -- see each
    # `devname_*` Case below, which supersedes this comment's old "not viable" claim.
    #
    # `sscp-lu-data.trc` REMAINS HERE TOO because it demonstrates something the four
    # devname_*.trc traces do not: a host NARROWING the requested function set
    # (`FUNCTIONS REQUEST BIND-IMAGE` alone) rather than granting everything asked,
    # which is a distinct code path (`negotiate()`'s `addsNothing` branch) from the
    # "host accepts our exact FUNCTIONS REQUEST" shape every devname_*.trc below
    # exercises instead. `s3270 -trace -geometry +64+19`, no `-devname`, connects to
    # x3270's own local test target (`Common/Test/target/target.py`, localhost:8021 --
    # confirmed by the "x3270 test target" banner text inside the trace itself, the
    # same public open-source infra the devname_*.trc traces also used; neither is a
    # private or sensitive live host). Recorded by x3270 v4.3pre1.
    #
    # WHAT IT ADDS OVER THE FIVE CASES ABOVE, measured 2026-09-18 by direct playback
    # run: 4 matched blocks (3, 19, 11, 8 bytes) where the five above stop at 3 --
    # this is the ONE trace here that gets past FUNCTIONS. The 4th block is the host
    # NARROWING the function set (`FUNCTIONS REQUEST BIND-IMAGE` alone, 8 bytes,
    # `fffa28030700fff0`) and our correctly adopting the common subset (`FUNCTIONS IS
    # BIND-IMAGE`, 8 bytes, `fffa28030400fff0`) -- exercising the `addsNothing`
    # counter-offer-acceptance branch in tn3270e.ts's `negotiate()` against a REAL
    # host that intentionally grants less than we asked for, not just the trivial
    # "host grants everything" path the other cases would have exercised had they
    # reached FUNCTIONS at all.
    #
    # The BIND that follows (recorded, not compared by this Case -- see below) is PLU
    # name 'IBM0SMAA', MaxSec-RU 1024, MaxPri-RU 3840, default screen 24x80, alternate
    # 43x80. The trace's own next expectation after that BIND is an SSCP-LU-DATA reply
    # to a scripted `Enter()` typing "foo" (`0700000000869696ffef`, 10 bytes) which
    # this harness's short Wait(3270Mode,8)+Quit script never drives -- exactly the
    # same class of "short script, not a client gap" stop as contention-resolution.trc
    # and sscp-lu.trc above, not a fifth thing to explain.
    Case('sscp-lu-data.trc', '3278-4-E', 4,
         # fffa28030700fff0 (8 bytes) is the HOST's counter-offer, not ours -- it is
         # not in expect_bytes because that list is asserted against MATCHED EMULATOR
         # data only (see run_case's `emul` extraction). Our own 8-byte reply to it,
         # fffa28030400fff0 (FUNCTIONS IS BIND-IMAGE), is what is asserted below.
         expect_bytes=('fffa28030700020405fff0', 'fffa28030400fff0'),
         stop_reason=(
             "the host's next expectation (10 bytes) is our SSCP-LU-DATA reply to a "
             "scripted Enter() typing 'foo', which this harness's short "
             'Wait(3270Mode,8)+Quit script never drives -- the 4 blocks asserted here '
             'are everything up through the real BIND'),
         root='fixtures'),

    # THE FOUR DEVNAME TRACES -- Task 8's payoff, and the reason NEW-ENVIRON (Tasks
    # 6/7) exists at all: "-devname foo===" answers a host's DEVNAME uservar with an
    # ITERATING name, `foo001`, `foo002`, ... , because a real host refuses a name
    # already in use. All four are DRIVABLE, not merely attempted, and all four match
    # substantially FURTHER than sscp-lu-data.trc above (9 blocks, not 4) because
    # option 39 negotiation interleaves with TN3270E's own steps and this harness's
    # `expect_bytes` was measured directly rather than assumed from the plan.
    #
    # EACH TRACE'S -devname TEMPLATE WAS READ OFF ITS OWN `Command:` LINE, not
    # guessed: `grep 'Command:' devname_*.trc` shows `-devname foo===` for _success,
    # `-devname foo=` for _failure and _change1 (identical templates; the traces
    # differ only in whether the host later refuses a name), and _change2 opens with
    # no `-devname` at all -- ITS FIRST LINE is `s3stdin read 'set devname bar='`, an
    # in-session `Set("devname", "bar=")` macro command BEFORE the `Connect()`, so its
    # effective template is `bar=`, confirmed by the trace's own later
    # `VALUE "bar1"`/`"bar2"`/... USERVAR replies. This harness has no scripted
    # `Set()` step, but `-devname bar=` at process start reaches the identical
    # DeviceName state the trace's `Set()`-before-`Connect()` does, because
    # `buildEnviron()` (session.ts:326) is called fresh from `connect()`, after any
    # `Set()` a real caller might have issued -- there is nothing "connect-time" about
    # x3270's `Set()` that a start-time flag cannot reproduce for this harness's single
    # scripted connect.
    #
    # USER AND CODEPAGE, THE TWO KNOWN RECORDED-VALUE TRAPS (see the module docstring's
    # rule 3 and dbcs-wrap.trc's USER=pdm/CODEPAGE=1027): grepped all four traces for
    # `USERVAR "USER"`/`VAR "USER"`/`"CODEPAGE"`/an empty-body SEND (which expands to
    # "every variable" per newenviron.ts's parseEnvironSend) -- NONE of the four asks
    # for anything but `IBMELF`, `IBMAPPLID`, `DEVNAME`, confirmed by
    # `grep -oE 'USERVAR "[A-Z]+"' devname_*.trc | sort -u` returning exactly those
    # three names across all four files. So `$USER` (`athor` on this box, never
    # hardcoded) and our derived CODEPAGE=037 are never on the wire in these four
    # cases and cannot cause a version-specific mismatch the way they would in a trace
    # that asked for either.
    #
    # THE ITERATION-COUNT CONCERN (does a mid-trace reconnect reset x3270's counter
    # where ours wouldn't, or vice versa): NONE of the four traces reconnects mid-trace
    # -- each has exactly one `cstate [not-connected] -> [resolving]` and, where the
    # trace ends with one, exactly one `RCVD disconnect` at the very end (grepped all
    # four for `RCVD DO TN3270E`, `cstate [not-connected]` and `RCVD disconnect`). A
    # single playback run is a single connect, so `DeviceName`'s per-connect reset
    # (session.ts:317-324, matching x3270's own `environ_init` being called from every
    # `host_connect()`) never fires mid-run and the counter stays in lockstep with the
    # trace's own `foo00N`/`fooN`/`barN` sequence for as many DEVNAME requests as this
    # harness's script survives to see.
    #
    # ALL FOUR REACH THE SAME STOPPING POINT for the same reason: the harness script is
    # `Connect() ; Wait(3270Mode,8) ; Quit`, and 3270-mode arrives right after the BIND
    # (block 9's `FUNCTIONS IS BIND-IMAGE` reply, followed immediately by the BIND
    # itself and an EraseWrite that Wait(3270Mode) is satisfied by) -- so `Quit` fires
    # before the host's NEXT scripted DEVNAME SEND, and playback logs `Socket EOF`
    # waiting for our reply to a request our client never receives because it has
    # already disconnected. That is the SAME "short script, not a client gap" shape as
    # contention-resolution.trc, sscp-lu.trc and sscp-lu-data.trc above -- not a fifth
    # kind of stop to invent an explanation for.
    #
    # `mismatch_ok` IS NOT NEEDED ON ANY OF THE FOUR: every one of the 9 asserted
    # blocks matches byte-for-byte with zero `Emulator data mismatch` lines (measured
    # directly, not inferred from the block count), because none of the three trap
    # variables (USER, CODEPAGE, wrongTerminalName's colour digit -- these are Model
    # 4/3278-4-E traces like wont-tn3270e.trc, but TERMINAL-TYPE is never reached
    # before Quit fires) is ever exercised.
    Case('devname_success.trc', '3278-4-E', 9,
         expect_bytes=(
             'fffb28', 'fffb27',
             'fffa28020749424d2d333237382d342d45fff0',
             # USERVAR "IBMELF" VALUE "YES" USERVAR "IBMAPPLID" VALUE "None" USERVAR
             # "DEVNAME" VALUE "foo001" SE -- split across two playback reads (the
             # trace's own `> 0x0`/`> 0x20` split), so two separate hex strings here.
             'fffa27000349424d454c46015945530349424d4150504c4944014e6f6e650344',
             '45564e414d4501666f6f303031fff0',
             'fffa28030700020405fff0',
             'fffa2700034445564e414d4501666f6f303032fff0',
             'fffa28030400fff0',
             'fffa2700034445564e414d4501666f6f303033fff0'),
         stop_reason=(
             'Wait(3270Mode,8) is satisfied right after the BIND that follows block 9 '
             '(PLU IBM0SMAJ, MaxSec-RU 1024, MaxPri-RU 3840, default 24x80, alternate '
             '43x80 -- the real BIND this trace was chosen for), so Quit fires before '
             "the host's 4th DEVNAME SEND (which the trace itself would answer "
             '"foo004"); playback logs Socket EOF waiting for that 10th reply, the same '
             'short-script stop as sscp-lu-data.trc above'),
         root='fixtures', devname='foo==='),

    # SAME NEGOTIATION SHAPE AS devname_success.trc UP TO THE POINT THIS HARNESS'S
    # SCRIPT QUITS -- the trace's DISTINGUISHING content (the host refusing a name
    # already in use, `foo9` repeated at devname_failure.trc:255-257 rather than
    # advancing to `foo10`) happens AFTER our client has already disconnected, so this
    # case cannot exercise a refusal any more than sscp-lu.trc's cases above exercise
    # their own post-Quit content. It is still real, independent evidence: template
    # width `foo=` (single-digit forever, per `DeviceName`'s own doc comment on
    # template parsing) produces different bytes than `foo===`'s zero-padded
    # `foo001`, and this trace is the one witness for that width.
    Case('devname_failure.trc', '3278-4-E', 9,
         expect_bytes=(
             'fffb28', 'fffb27',
             'fffa28020749424d2d333237382d342d45fff0',
             'fffa27000349424d454c46015945530349424d4150504c4944014e6f6e650344',
             '45564e414d4501666f6f31fff0',
             'fffa28030700020405fff0',
             'fffa2700034445564e414d4501666f6f32fff0',
             'fffa28030400fff0',
             'fffa2700034445564e414d4501666f6f33fff0'),
         stop_reason=(
             "same short-script stop as devname_success.trc's Case above -- "
             'Wait(3270Mode,8) is satisfied right after this trace\'s own BIND (PLU '
             "IBM0SMAA) and Quit fires before the host's later DEVNAME requests, which "
             'is where this trace records the refusal (`foo9` repeated rather than '
             '`foo10`) that gives it its name; that refusal is real recorded content '
             'this harness does not reach, not a defect in reaching it'),
         root='fixtures', devname='foo='),

    # IDENTICAL byte-for-byte to devname_failure.trc up to this harness's stopping
    # point (`diff` of the two traces' RCVD/SENT lines shows the only difference in
    # range is the CONNECT LU name IBM0TE00 vs IBM0TE01, which is not on our side of
    # the wire) -- both use template `foo=` and both are s3270 recordings against the
    # same test target. Kept as its own Case anyway because the plan named it
    # separately and because "identical to a sibling trace" is itself a fact worth a
    # passing case recording, not a reason to skip driving it.
    Case('devname_change1.trc', '3278-4-E', 9,
         expect_bytes=(
             'fffb28', 'fffb27',
             'fffa28020749424d2d333237382d342d45fff0',
             'fffa27000349424d454c46015945530349424d4150504c4944014e6f6e650344',
             '45564e414d4501666f6f31fff0',
             'fffa28030700020405fff0',
             'fffa2700034445564e414d4501666f6f32fff0',
             'fffa28030400fff0',
             'fffa2700034445564e414d4501666f6f33fff0'),
         stop_reason=(
             "same short-script stop as devname_failure.trc's Case above -- identical "
             'reasoning, identical template'),
         root='fixtures', devname='foo='),

    # THE ONE TRACE WHOSE TEMPLATE IS NOT ON ITS OWN `Command:` LINE: this recording
    # is a LIVE s3270 SESSION where `Set("devname", "bar=")` runs as a scripted step
    # BEFORE `Connect("localhost:8021")` (trc lines 1-16, 18-27) rather than a
    # `-devname` flag at s3270's own invocation -- s3270 was started with no
    # `-devname` at all and the template was set interactively. See the Case block
    # comment above (the one spanning all four devname_*.trc traces) for why a
    # start-time `-devname bar=` flag reaches the same DeviceName state this
    # harness needs, given it has no scripted `Set()` step of its own.
    Case('devname_change2.trc', '3278-4-E', 9,
         expect_bytes=(
             'fffb28', 'fffb27',
             'fffa28020749424d2d333237382d342d45fff0',
             'fffa27000349424d454c46015945530349424d4150504c4944014e6f6e650344',
             '45564e414d450162617231fff0',
             'fffa28030700020405fff0',
             'fffa2700034445564e414d450162617232fff0',
             'fffa28030400fff0',
             'fffa2700034445564e414d450162617233fff0'),
         stop_reason=(
             "same short-script stop as the other three devname_*.trc Cases above -- "
             "this trace's own BIND is PLU IBM0SMAC"),
         root='fixtures', devname='bar='),
]

#: Traces deliberately NOT driven, each with the measured reason. Kept in the file
#: because "we did not test it" and "it cannot be tested" are different claims, and an
#: unexplained absence invites someone to add it and see a failure they misread.
EXCLUDED = {
    's3270/Test/sruvm.trc':
        'recorded by c3270 v3.3.10alpha1 (2009); expects IBM-3279-4-E in '
        'TERMINAL-TYPE. Modern s3270 4.5ga6 sends IBM-3278-4-E and mismatches it '
        'identically to us -- measured. Needs -xrm wrongTerminalName: true.',
    's3270/Test/rpqnames.trc':
        'same 2009 c3270 recording and same TERMINAL-TYPE mismatch; additionally '
        'asserts RPQ NAMES in a Query Reply, which we do not implement.',
    's3270/Test/ft_cut.trc':
        'classic TN3270 (no option 40), but recorded with mode3279 so TERMINAL-TYPE '
        'is IBM-3279-2-E where ours is IBM-3278-2-E. x3270 builds 3279 for '
        'TERMINAL-TYPE and 3278 for DEVICE-TYPE (Common/model.c:135-138, '
        'Common/telnet.c:2103-2106,2122); we always send 3278. See docs.',
    'b3270/Test/*.trc, s3270/Test/930.trc and 15 others':
        'host-only recordings with no emulator side at all, so `-b` asserts nothing.',
    # NOTE: devname_success.trc, devname_failure.trc, devname_change1.trc and
    # devname_change2.trc are NO LONGER LISTED HERE (Task 8, 2026-09-20). Until
    # NEW-ENVIRON existed (Tasks 6/7) they mismatched at once -- see the git history of
    # this dict for the exact old wording -- but all four are now drivable and have
    # their own Case entries above. Leaving the stale entry beside a working case was
    # exactly the mistake this dict's own module comment warns against.
}


def free_port():
    """A port the OS says is free. ss/netstat show nothing in this sandbox."""
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_listener(log_path, timeout=10.0):
    """
    Wait until playback has bound its port, WITHOUT CONNECTING TO IT.

    DO NOT "improve" THIS INTO A CONNECT PROBE. `playback` accepts exactly one
    connection at a time (`Common/playback.c:350` accept, then the bidirectional loop
    runs to completion before the next accept), so a probe socket IS ACCEPTED AS THE
    EMULATOR. The real client then gets the next accept, or none, and the log shows a
    single expectation followed by `Socket EOF` -- which reads exactly like our client
    connecting and saying nothing. That cost a full false "0 of 5 cases passed" here,
    and it is the same defect that once made drive-e.py fail all seven of its cases.

    So the readiness signal is playback's own announcement, tailed from its log FILE:
    "Waiting for connection on ADDR, port N." (`playback.c:283`), printed after bind()
    and before accept().

    TWO REASONS THE LOG IS A FILE AND NOT A PIPE, both measured here:
    - `playback.c:283` has NO fflush and stdout to a pipe is FULLY buffered, so the
      readiness line does not arrive until the buffer fills or the process exits. The
      first version of this waited on a pipe and HUNG, forever, on case 1.
    - The chatty traces write megabytes. A 64KB pipe buffer with nobody draining it
      deadlocks playback mid-trace; this repo has already been bitten by exactly one
      pipe buffer's worth of truncation. `stdbuf -oL` makes the file line-buffered so
      readiness appears promptly.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(log_path, 'r', errors='replace') as fh:
                if 'Waiting for connection' in fh.read():
                    return True
        except OSError:
            pass
        time.sleep(0.05)
    return False


def run_case(case, playback, suite, node, verbose):
    """Play one trace at our client. Returns (ok, message, log)."""
    # `case.root` picks the base directory: 'suite' for the traces that still live
    # only in a hand-built suite3270 checkout outside this repo, 'fixtures' for the
    # ones copied into packages/fixtures/x3270/ so they need no such checkout. See
    # FIXTURES's comment for why a trace, unlike the `playback` binary, does not need
    # to be built and so has no reason to require one.
    root = FIXTURES if case.root == 'fixtures' else suite
    trace = os.path.join(root, case.trace)
    if not os.path.exists(trace):
        return False, 'trace not found: %s' % trace, ''

    port = free_port()
    log_fd, log_path = tempfile.mkstemp(prefix='playback-', suffix='.log')
    # `stdbuf -oL`: playback never fflushes its readiness line, so without line
    # buffering it is invisible until the buffer fills. See wait_for_listener.
    stdbuf = shutil.which('stdbuf')
    argv = ([stdbuf, '-oL'] if stdbuf else []) + [
        playback, '-b', '-p', str(port), trace]
    pb = subprocess.Popen(
        argv, stdout=log_fd, stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL, cwd=suite)
    os.close(log_fd)

    def read_log():
        try:
            with open(log_path, 'r', errors='replace') as fh:
                return fh.read()
        except OSError:
            return ''

    # Read playback's own readiness line rather than probing the port -- see the
    # comment in wait_for_listener, which a connect probe silently defeats.
    if not wait_for_listener(log_path, 10.0):
        pb.kill()
        pb.wait(timeout=5)
        out = read_log()
        os.unlink(log_path)
        return False, 'playback never announced a listener on %d' % port, out

    script = '\n'.join([
        'Connect(127.0.0.1:%d)' % port,
        # The trace ends when it ends; 3270Mode may never arrive on a trace whose
        # host refuses TN3270E and whose classic path the recording does not finish.
        # A timeout here is NOT a failure of the case -- the assertion is on the
        # matched blocks -- so the wait is short.
        'Wait(3270Mode,8)',
        'Quit',
        '',
    ])
    client_argv = [node, CLI] + REQUIRED_FLAGS + ['-model', case.model]
    if case.devname is not None:
        client_argv += ['-devname', case.devname]
    try:
        subprocess.run(client_argv, input=script, capture_output=True,
                       text=True, timeout=40)
    except subprocess.TimeoutExpired:
        pb.kill()
        pb.wait(timeout=5)
        out = read_log()
        os.unlink(log_path)
        return False, 'our client did not exit within 40s', out

    # playback loops back to accept() after the trace ends, so it will not exit on its
    # own; end it, then read the log file it has been writing all along.
    try:
        pb.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pb.terminate()
        try:
            pb.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pb.kill()
            pb.wait(timeout=5)
    log = read_log()
    os.unlink(log_path)

    matched = re.findall(r'Matched (\d+) bytes from emulator', log)
    mismatch = 'Emulator data mismatch' in log
    emul = ' '.join(re.findall(r'^emul\s+0x[0-9a-f]+\s+([0-9a-f]+)', log, re.M))

    if mismatch and not case.mismatch_ok:
        return False, 'UNEXPECTED mismatch after %d matched blocks' % len(matched), log
    if len(matched) < case.blocks:
        return (False,
                'matched %d blocks, expected at least %d' % (len(matched), case.blocks),
                log)
    for want in case.expect_bytes:
        if want not in emul:
            return False, 'expected bytes %s never matched' % want, log

    detail = 'matched %d blocks (%s bytes)' % (len(matched), ','.join(matched))
    if verbose and case.stop_reason:
        detail += '; stops because %s' % case.stop_reason
    return True, detail, log


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--playback', default=DEFAULT_PLAYBACK,
                    help='path to the playback binary (default: %s)' % DEFAULT_PLAYBACK)
    ap.add_argument('--suite', default=DEFAULT_SUITE,
                    help='suite3270 source root, holding the traces')
    ap.add_argument('--node', default=shutil.which('node') or 'node')
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()

    if not os.path.exists(args.playback):
        print('playback not built at %s' % args.playback, file=sys.stderr)
        print('Build it with:\n'
              '  source /opt/lsst/software/stack/loadLSST.bash\n'
              '  cd %s && make playback' % args.suite, file=sys.stderr)
        return 1
    if not os.path.exists(CLI):
        print('our client is not built: %s\nRun `npm run build`.' % CLI,
              file=sys.stderr)
        return 1

    failures = 0
    for case in CASES:
        ok, message, log = run_case(case, args.playback, args.suite, args.node,
                                    args.verbose)
        print('%-5s %-38s %s' % ('ok' if ok else 'FAIL',
                                 os.path.basename(case.trace), message))
        if not ok:
            failures += 1
            print('--- playback log for %s ---' % case.trace)
            print(log)
            print('--- end ---')

    print()
    print('%d of %d cases passed' % (len(CASES) - failures, len(CASES)))
    if args.verbose:
        print('\nDeliberately not driven:')
        for trace, why in EXCLUDED.items():
            print('  %s\n      %s' % (trace, why))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
