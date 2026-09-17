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
MEASURED 2026-09-17, EACH OF WHICH CAN MANUFACTURE A FALSE PASS:

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

THE STRUCTURAL LIMIT, AND IT IS A DESIGN CHOICE OF OURS, NOT A DEFECT:
**ALL 46 traces with an emulator side request BIND-IMAGE in FUNCTIONS** (`07 00 ...`);
we deliberately do not (`packages/core/src/tn3270e.ts` REQUESTED_FUNCTIONS -- granting
it and receiving no BIND makes a real client hang, measured). So in every trace that
reaches FUNCTIONS, our 10-byte `fffa280307020405fff0` meets an expected 11-byte
`fffa28030700020405fff0` and the match stops there, one block short. That was
confirmed to be the ONLY difference by temporarily adding BIND_IMAGE and re-running:
the FUNCTIONS block then matched byte-for-byte and play advanced to the next
expectation. The temporary change was reverted; do not commit it to make these pass.

WHAT THAT LEAVES, AND IT IS WORTH HAVING: every trace still proves our WILL TN3270E,
our DEVICE-TYPE REQUEST and (where the host refuses) our whole backoff, against a real
host's bytes. `wont-tn3270e.trc` is the one that goes furthest on the TN3270E path,
because its host answers WONT before FUNCTIONS is ever reached.

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

# TLS is ON by default and playback speaks plaintext. Without this the run does not
# fail, it HANGS: a plaintext peer's leading 0xff is read as a TLS record type and
# OpenSSL blocks for a length that never comes. Same trap as every other harness here,
# and the reason packages/tui/test/harness-flags.test.ts pins this argv.
REQUIRED_FLAGS = ['-insecure']


class Case:
    """One trace, and what our client must be seen to send while playing it."""

    def __init__(self, trace, model, blocks, expect_bytes=(), stop_reason='',
                 mismatch_ok=False):
        #: Path relative to the suite3270 source root.
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


BIND_IMAGE_STOP = (
    'we do not request BIND-IMAGE by design, so our 10-byte FUNCTIONS REQUEST '
    'meets this trace\'s expected 11-byte one'
)

CASES = [
    # The furthest any trace gets on the TN3270E path: this host sends WONT 40 after
    # our DEVICE-TYPE, so FUNCTIONS never arbitrates and our backoff to classic
    # TN3270 is what gets compared. Recorded against a real VTAM (SC0TCP01).
    Case('s3270/Test/wont-tn3270e.trc', '3278-4-E', 2,
         expect_bytes=('fffb28', 'fffa28020749424d2d333237382d342d45fff0'),
         stop_reason=BIND_IMAGE_STOP),

    # A real host that GRANTS contention resolution. Model 2, so it also pins that our
    # DEVICE-TYPE carries the model the flag asked for.
    Case('s3270/Test/contention-resolution.trc', '3278-2-E', 2,
         expect_bytes=('fffb28', 'fffa28020749424d2d333237382d322d45fff0'),
         stop_reason=BIND_IMAGE_STOP),

    # IBM Link, a commercial VTAM host, via c3270. Same shape, different host, and it
    # is the trace whose host sends BIND then UNBIND then another BIND.
    Case('c3270/Test/ibmlink2.trc', '3278-2-E', 2,
         expect_bytes=('fffb28', 'fffa28020749424d2d333237382d322d45fff0'),
         stop_reason=BIND_IMAGE_STOP),

    # SSCP-LU data: the host drives an SSCP-LU session before binding. Model 2.
    Case('s3270/Test/sscp-lu.trc', '3278-2-E', 2,
         expect_bytes=('fffb28',),
         stop_reason=BIND_IMAGE_STOP),

    # Model 4 against a real host, so the geometry in DEVICE-TYPE is exercised too.
    Case('s3270/Test/bid.trc', '3278-4-E', 2,
         expect_bytes=('fffa28020749424d2d333237382d342d45fff0',),
         stop_reason=BIND_IMAGE_STOP),
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
    trace = os.path.join(suite, case.trace)
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
