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
recorded BIND -- 4 matched blocks where the other five stop at 3. `devname_success.trc`
was investigated as the plan's original candidate and found NOT VIABLE: see the
comment above its `Case` for the measured reason.

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
                 mismatch_ok=False, root='suite'):
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
    # devname_success.trc WAS THE PLAN'S ORIGINAL CANDIDATE FOR THIS ROLE AND IS NOT
    # VIABLE. It requires NEW-ENVIRON (telnet option 39) for `-devname`: `RCVD DO
    # NEW-ENVIRON` then `SB NEW-ENVIRON SEND USERVAR "DEVNAME"` before the host will
    # even offer TN3270E's DEVICE-TYPE step. Our client implements no NEW-ENVIRON at
    # all -- no TelnetOpt entry in constants.ts, no handling in telnet.ts -- so a
    # direct run against it (2026-09-18) mismatches after only 1 matched block: we
    # reply `fffc27` (WONT NEW-ENVIRON) where the trace expects `fffb27` (WILL
    # NEW-ENVIRON). Adding NEW-ENVIRON support is out of scope here; this trace is
    # excluded and the reason is on record rather than silently dropped.
    #
    # `sscp-lu-data.trc` IS THE ALTERNATIVE, chosen because it reaches a real BIND
    # WITHOUT NEW-ENVIRON: `s3270 -trace -geometry +64+19`, no `-devname`, connects to
    # x3270's own local test target (`Common/Test/target/target.py`, localhost:8021 --
    # confirmed by the "x3270 test target" banner text inside the trace itself, the
    # same public open-source infra devname_success.trc also used; neither is a
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
    's3270/Test/devname_success.trc':
        "the plan's original candidate for a real-BIND witness case, replaced below "
        'by sscp-lu-data.trc. Requires NEW-ENVIRON (telnet option 39) for '
        "-devname, which our client does not implement at all (no TelnetOpt entry, "
        'no telnet.ts handling). Measured 2026-09-18: mismatches after 1 matched '
        'block, sending WONT NEW-ENVIRON (fffc27) where the trace expects WILL '
        '(fffb27). See sscp-lu-data.trc\'s Case comment for the full account.',
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
