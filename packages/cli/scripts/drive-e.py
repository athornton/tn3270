#!/usr/bin/env python3
"""
Drive OUR client against e-server.py, in every configuration that matters.

WHY THIS EXISTS, AND WHY IT IS THE SECOND HALF OF SOMETHING. e-server.py was
validated against real s3270 4.5ga6 in six configurations BEFORE our client was ever
pointed at it (results in docs/live-testing.md, "TN3270E harness validation"). That
order is not interchangeable: a harness never shown to satisfy a known-good client
cannot say which side is wrong when ours fails. This script is the other half --
point the validated instrument at us and assert.

Stage 2b is the first stage of this project with NO live-host verification path.
Neither Hercules system offers TN3270E: both open IAC DO TERMINAL-TYPE and go on to
BINARY and EOR, never mentioning option 40, measured on both hosts accepting and
refusing. So this harness is the verification, and docs/live-testing.md is careful to
say so -- "verified against x3270, not against a live host". When real z/VM or z/OS
access arrives, the four questions in that file's "TN3270E against a real host"
section are what it is for.

`-insecure` IS MANDATORY on every invocation below. TLS is on by default and this
harness speaks plaintext, and the failure is not an error but a HANG: a plaintext
server writes IAC DO TERMINAL-TYPE and waits, and OpenSSL reads that leading 0xff as
a record content type and blocks for a length that never comes. That default flip
silently broke every harness in this repo once already, unnoticed for two days,
because a script outside `npm test` is exempt from every change. The argv here is
pinned by packages/tui/test/harness-flags.test.ts for exactly that reason -- so this
file cannot rot the same way twice.

    python3 packages/cli/scripts/drive-e.py [--node PATH] [--port-base N] [-v]

Exit 0 means every check passed. Any failure prints the harness log for the case
that failed, because the wire bytes are the only useful thing at that point.
"""
import argparse
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
E_SERVER = os.path.join(HERE, 'e-server.py')
CLI = os.path.join(REPO, 'packages', 'cli', 'dist', 'main.js')

# TLS is ON by default; this harness is plaintext. See the module docstring: without
# this the run does not fail, it HANGS. Kept as one constant so the guard test has a
# single thing to pin.
REQUIRED_FLAGS = ['-insecure']


class Case:
    """One configuration: how the server is set up, and what our client should do."""

    def __init__(self, name, server_args, client_args, script, expect,
                 wire=(), absent=()):
        self.name = name
        self.server_args = server_args
        self.client_args = client_args
        self.script = script
        #: The harness's own verdict, as an exit code. 0 is its OK line.
        self.expect = expect
        #: Substrings that MUST appear in the harness log.
        self.wire = wire
        #: Substrings that must NOT appear. An assertion about what we did not send is
        #: the only way to pin a deliberate omission such as BIND-IMAGE.
        self.absent = absent


#: `-model 3278-2-E` throughout: the terminal type is what carries the `-E` extended
#: data stream claim into both the TERMINAL-TYPE reply and the DEVICE-TYPE request.
MODEL = ['-model', '3278-2-E']

CASES = [
    Case(
        'full grant',
        ['--grant', 'responses,sysreq,contention-resolution'],
        MODEL,
        # Wait(InputField) as well as Wait(3270Mode), and the second one is NOT
        # redundant: 3270 mode is reached when the option negotiation finishes, which is
        # before the host's Erase/Write carrying the field has arrived. Without it
        # String() intermittently fails as "input inhibited" -- observed here, passing
        # on one run and failing on the next.
        'Connect(127.0.0.1:{port})\nWait(3270Mode,8)\nWait(InputField,4)\n'
        'String(HI)\nEnter\nQuit\n',
        expect=0,
        wire=[
            # The DEVICE-TYPE REQUEST byte for byte, which is where the asymmetric
            # operand order would show up: 02 07, never 02 08.
            '[020749424d2d333237382d322d45]',
            "device-type 'IBM-3278-2-E'",
            'NEGOTIATION COMPLETE',
            # The inbound record carries a header and the AID behind it, not the AID
            # first -- the whole point of the outbound header work.
            'first byte (AID) 0x7d',
        ],
        # BIND-IMAGE is 0x00 and would appear as the first function byte. s3270 sends
        # 030700020405; we deliberately send 0307020405. Pinned as an ABSENCE, because
        # asserting our own bytes would not catch us starting to ask for it.
        absent=['[030700020405]'],
    ),
    Case(
        'basic TN3270E, no functions granted',
        ['--grant', ''],
        MODEL,
        'Connect(127.0.0.1:{port})\nWait(3270Mode,8)\nQuit\n',
        expect=0,
        wire=['NEGOTIATION COMPLETE'],
    ),
    Case(
        'LU list: the first name is requested',
        ['--grant', 'responses'],
        MODEL,
        'Connect("MYLU01,BACKUPLU@127.0.0.1:{port}")\nWait(3270Mode,8)\nQuit\n',
        expect=0,
        wire=["lu='MYLU01'", 'NEGOTIATION COMPLETE'],
    ),
    Case(
        'LU list: every name tried in order, then backoff',
        ['--reject', 'inv-name'],
        MODEL,
        'Connect("MYLU01,BACKUPLU@127.0.0.1:{port}")\nWait(Settle,3)\nQuit\n',
        expect=0,
        wire=["lu='MYLU01'", "lu='BACKUPLU'", 'client REFUSED TN3270E'],
    ),
    Case(
        '-tn3270e off refuses the option outright',
        ['--expect-refuse'],
        MODEL + ['-tn3270e', 'off'],
        'Connect(127.0.0.1:{port})\nWait(Settle,2)\nQuit\n',
        expect=0,
        wire=['client REFUSED TN3270E'],
        # It must refuse WITHOUT first asking for a device type.
        absent=['DEVICE_TYPE REQUEST'],
    ),
    Case(
        'the N: host prefix refuses it too, per connection',
        ['--expect-refuse'],
        MODEL,
        'Connect(N:127.0.0.1:{port})\nWait(Settle,2)\nQuit\n',
        expect=0,
        wire=['client REFUSED TN3270E'],
        absent=['DEVICE_TYPE REQUEST'],
    ),
    Case(
        'ALWAYS-RESPONSE is answered positively',
        ['--grant', 'responses', '--response-flag', '2'],
        MODEL,
        'Connect(127.0.0.1:{port})\nWait(3270Mode,8)\nWait(Settle,2)\nQuit\n',
        expect=0,
        # RESPONSE(02) POSITIVE(00) with the seq copied back. Measured from real s3270
        # in harness config F: 02 00 00 00 00 00.
        wire=['NEGOTIATION COMPLETE', 'DATA-TYPE=RESPONSE'],
    ),
]


def run_case(case, port, node, verbose):
    """Start the server, run the client, return (ok, harness_log)."""
    # `-u`, because readiness is detected by reading the server's own first log line
    # and a block-buffered pipe would not deliver it until the process exited.
    server = subprocess.Popen(
        [sys.executable, '-u', E_SERVER, '--port', str(port), *case.server_args],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    # WAIT FOR THE SERVER'S OWN "listening" LINE, and do NOT probe the port to find
    # out. e-server.py serves exactly one connection: a test connect is accepted as
    # THE client, so the probe closes the listener and the real client then gets
    # ECONNREFUSED while the log claims something connected. That cost the first run of
    # this script all seven cases, and it looked like a client failure rather than a
    # harness one -- which is the whole reason the harness is validated separately.
    preamble = ''
    deadline = time.monotonic() + 15
    while 'listening on' not in preamble and time.monotonic() < deadline:
        line = server.stdout.readline()
        if line == '':
            break
        preamble += line

    script = case.script.format(port=port)
    client = subprocess.run(
        [node, CLI, *REQUIRED_FLAGS, *case.client_args],
        input=script, capture_output=True, text=True, timeout=60)

    try:
        log = preamble + (server.communicate(timeout=30)[0] or '')
    except subprocess.TimeoutExpired:
        server.kill()
        log = preamble + (server.communicate()[0] or '')
    code = server.returncode

    problems = []
    if code != case.expect:
        problems.append(f'harness exit {code}, expected {case.expect}')
    for want in case.wire:
        if want not in log:
            problems.append(f'missing from the wire log: {want!r}')
    for unwanted in case.absent:
        if unwanted in log:
            problems.append(f'present but should NOT be: {unwanted!r}')

    if verbose:
        sys.stdout.write(log)
        sys.stdout.write(client.stdout)
    return problems, log, client


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--node', default='node', help='node binary to run our client with')
    p.add_argument('--port-base', type=int, default=4950,
                   help='first port to use; each case takes the next one')
    p.add_argument('-v', '--verbose', action='store_true',
                   help='print the wire log for every case, not just failures')
    args = p.parse_args()

    if not os.path.exists(CLI):
        print(f'!! {CLI} is missing. Run `npm run build` first.', file=sys.stderr)
        return 2

    failed = 0
    for i, case in enumerate(CASES):
        port = args.port_base + i
        try:
            problems, log, client = run_case(case, port, args.node, args.verbose)
        except subprocess.TimeoutExpired:
            # Worth its own message: a hang here is the signature of the TLS trap, not
            # of a protocol disagreement. See the module docstring.
            print(f'TIMEOUT  {case.name}')
            print('         a hang rather than a failure usually means the client '
                  'tried TLS against this plaintext harness -- check -insecure')
            failed += 1
            continue

        if problems:
            failed += 1
            print(f'FAIL     {case.name}')
            for why in problems:
                print(f'         - {why}')
            if not args.verbose:
                print('--- harness log ---')
                sys.stdout.write(log)
                print('--- our client ---')
                sys.stdout.write(client.stdout)
                sys.stdout.write(client.stderr)
        else:
            print(f'ok       {case.name}')

    print(f'\n{len(CASES) - failed}/{len(CASES)} checks passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
