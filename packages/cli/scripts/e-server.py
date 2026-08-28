#!/usr/bin/env python3
"""
A TN3270E server, for testing a TN3270E client when no host will speak it.

WHY THIS EXISTS. Neither Hercules system available to this project offers TN3270E:
both open with IAC DO TERMINAL-TYPE and go on to BINARY and EOR, and never mention
option 40 whatever the client answers (measured 2026-08-27, both hosts, accepting
and refusing). So stage 2b has no live host to be verified against, and the
counterparty has to be built -- the same move tls-proxy.mjs made for TLS rather than
installing stunnel.

HOW IT IS KEPT HONEST. This harness is validated against real s3270 first, and only
then pointed at our own client. A harness that has never been shown to satisfy a
known-good client proves nothing about ours: when our client failed we would not
know which side was wrong. See docs/HANDOFF.md lesson 8 -- "a mimic of the real
system is a hypothesis, not evidence" -- which cost four attempts to learn on a
different question. Validation results are recorded in docs/live-testing.md.

  node/s3270 side:  s3270 -model 3278-2 C:127.0.0.1:PORT
  our side:         node packages/cli/dist/main.js -insecure -model 3278-2-E

The C: prefix is required for s3270 or it hangs on the connect screen
(stdinscript.c:437). -insecure is required for ours: TLS is on by default and this
harness speaks plaintext.

Every wire constant here is from RFC 2355 (~/3270/ref/rfc2355.txt) section 3 for the
operations and section 8.1 for the header. THE OPERAND ORDER IS ASYMMETRIC: the
server sends SEND DEVICE-TYPE (08 02) and the client replies DEVICE-TYPE REQUEST
(02 07). Sending 02 08 makes real s3270 log "DEVICE-TYPE ??8" and then stall -- no
reject, no error, nothing. That mistake was made while building this file.
"""
import argparse
import socket
import sys
import time

IAC, SB, SE, EOR, AO = 255, 250, 240, 239, 245
DO, DONT, WILL, WONT = 253, 254, 251, 252
OPT_TN3270E = 40

# RFC 2355 section 3.
OP = {
    'ASSOCIATE': 0x00, 'CONNECT': 0x01, 'DEVICE_TYPE': 0x02, 'FUNCTIONS': 0x03,
    'IS': 0x04, 'REASON': 0x05, 'REJECT': 0x06, 'REQUEST': 0x07, 'SEND': 0x08,
}
OP_NAME = {v: k for k, v in OP.items()}

REASON = {
    'conn-partner': 0x00, 'device-in-use': 0x01, 'inv-associate': 0x02,
    'inv-name': 0x03, 'inv-device-type': 0x04, 'type-name-error': 0x05,
    'unknown-error': 0x06, 'unsupported-req': 0x07,
}

# CONTENTION-RESOLUTION (0x05) is NOT in RFC 2355; it is a later extension that
# x3270 requests anyway (telnet.c:953).
FUNC = {
    'bind-image': 0x00, 'data-stream-ctl': 0x01, 'responses': 0x02,
    'scs-ctl-codes': 0x03, 'sysreq': 0x04, 'contention-resolution': 0x05,
}
FUNC_NAME = {v: k for k, v in FUNC.items()}

# RFC 2355 section 8.1.1.
DT_NAME = {
    0x00: '3270-DATA', 0x01: 'SCS-DATA', 0x02: 'RESPONSE', 0x03: 'BIND-IMAGE',
    0x04: 'UNBIND', 0x05: 'NVT-DATA', 0x06: 'REQUEST', 0x07: 'SSCP-LU-DATA',
    0x08: 'PRINT-EOJ',
}
CMD_NAME = {WILL: 'WILL', WONT: 'WONT', DO: 'DO', DONT: 'DONT'}


def log(msg):
    print(msg, flush=True)


def double_iac(body):
    """Double every 0xff. Required for the header too: RFC 2355 section 8.1.4 says a
    0xff inside SEQ-NUMBER "should be doubled to 0xffff before sending and stripped
    back to 0xff upon receipt; this is standard IAC escaping"."""
    out = bytearray()
    for b in body:
        out.append(b)
        if b == IAC:
            out.append(IAC)
    return bytes(out)


class EServer:
    def __init__(self, args):
        self.args = args
        self.granted = []
        self.negotiated = False
        self.sock = None
        self.responses_agreed = False

    # ---- sending -------------------------------------------------------------

    def send_raw(self, data, desc):
        self.sock.sendall(data)
        log(f"  -> {desc}\n     [{data.hex()}]")

    def send_cmd(self, cmd, opt):
        self.send_raw(bytes([IAC, cmd, opt]), f"IAC {CMD_NAME[cmd]} TN3270E")

    def send_subneg(self, body, desc):
        """IAC SB TN3270E <doubled body> IAC SE. The brackets are commands and stay
        single; the body is a subnegotiation parameter and is doubled (RFC 855)."""
        self.send_raw(
            bytes([IAC, SB, OPT_TN3270E]) + double_iac(body) + bytes([IAC, SE]),
            f"IAC SB TN3270E {desc} IAC SE")

    def send_record(self, data_type, payload, response_flag=0, seq=0):
        header = bytes([data_type, 0x00, response_flag, (seq >> 8) & 0xff, seq & 0xff])
        self.send_raw(
            double_iac(header + payload) + bytes([IAC, EOR]),
            f"TN3270E {DT_NAME.get(data_type, hex(data_type))} "
            f"response-flag=0x{response_flag:02x} seq={seq} + IAC EOR")

    # ---- the negotiation -----------------------------------------------------

    def on_will_tn3270e(self):
        # VERB FIRST: SEND (0x08) then DEVICE-TYPE (0x02). x3270 pins the layout at
        # telnet.c:2199, where the test is `sbbuf[2] == TN3270E_OP_DEVICE_TYPE`.
        self.send_subneg(bytes([OP['SEND'], OP['DEVICE_TYPE']]), "SEND DEVICE-TYPE")

    def on_device_type_request(self, body):
        rest = body[2:]
        sep = rest.find(bytes([OP['CONNECT']]))
        want_type = (rest if sep == -1 else rest[:sep]).decode('ascii', 'replace')
        want_lu = None if sep == -1 else rest[sep + 1:].decode('ascii', 'replace')
        log(f"     ** client asked for device-type {want_type!r} lu={want_lu!r}")

        if self.args.reject:
            code = REASON[self.args.reject]
            self.send_subneg(
                bytes([OP['DEVICE_TYPE'], OP['REJECT'], OP['REASON'], code]),
                f"DEVICE-TYPE REJECT REASON {self.args.reject}")
            return

        name = self.args.device_name.encode('ascii')
        lu = self.args.lu.encode('ascii')
        self.send_subneg(
            bytes([OP['DEVICE_TYPE'], OP['IS']]) + name + bytes([OP['CONNECT']]) + lu,
            f"DEVICE-TYPE IS {self.args.device_name} CONNECT {self.args.lu}")

    def on_functions_request(self, body):
        asked = list(body[2:])
        log(f"     ** client asked for functions "
            f"{[FUNC_NAME.get(f, hex(f)) for f in asked]}")
        self.granted = [f for f in asked if f in self.args.grant]
        self.responses_agreed = FUNC['responses'] in self.granted
        self.send_subneg(
            bytes([OP['FUNCTIONS'], OP['IS']]) + bytes(self.granted),
            f"FUNCTIONS IS {[FUNC_NAME.get(f, hex(f)) for f in self.granted]}")
        self.negotiated = True
        log(f"     ** NEGOTIATION COMPLETE, granted "
            f"{[FUNC_NAME.get(f, hex(f)) for f in self.granted] or '(none: basic TN3270E)'}")
        self.after_negotiation()

    def after_negotiation(self):
        time.sleep(0.3)
        # BIND-IMAGE. Sending one matters ONLY when bind-image was granted: with it
        # granted and no BIND sent, a client is entitled never to enter 3270 mode,
        # and real s3270 does exactly that (telnet.c:2339). That is the measurement
        # behind not requesting the function at all.
        if self.args.send_bind and FUNC['bind-image'] in self.granted:
            self.send_record(0x03, bytes([0x31, 0x01, 0x03, 0xb1, 0x90]))
            time.sleep(0.3)
        # Erase/Write, WCC reset+unlock, SBA(0,0), unprotected field, Insert Cursor.
        payload = bytes([0xf5, 0xc3, 0x11, 0x40, 0x40, 0x1d, 0x40, 0x13])
        self.send_record(0x00, payload, response_flag=self.args.response_flag)

    # ---- receiving -----------------------------------------------------------

    def on_inbound_record(self, rec):
        if len(rec) < 5:
            log(f"  ** INBOUND RECORD TOO SHORT for a header, {len(rec)} bytes "
                f"[{rec.hex()}]")
            return
        dt, rf, respf = rec[0], rec[1], rec[2]
        seq = (rec[3] << 8) | rec[4]
        log(f"  ** INBOUND {len(rec)} bytes [{rec.hex()}]")
        log(f"     header: DATA-TYPE={DT_NAME.get(dt, hex(dt))}(0x{dt:02x}) "
            f"REQUEST-FLAG=0x{rf:02x} RESPONSE-FLAG=0x{respf:02x} SEQ={seq}")
        if len(rec) > 5:
            log(f"     payload [{rec[5:].hex()}]  first byte (AID) 0x{rec[5]:02x}")

    def run(self):
        srv = socket.socket()
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(('127.0.0.1', self.args.port))
        srv.listen(1)
        log(f"-- listening on 127.0.0.1:{self.args.port}, "
            f"granting {[FUNC_NAME[f] for f in self.args.grant] or '(nothing)'} --")
        srv.settimeout(self.args.timeout)
        try:
            self.sock, _ = srv.accept()
        except socket.timeout:
            log("-- FAIL: nothing connected --")
            return 2
        self.sock.settimeout(2)
        log("-- connected --")
        self.send_cmd(DO, OPT_TN3270E)

        # Un-doubled inbound record accumulator, and a tiny telnet state machine.
        pending = bytearray()
        sb = bytearray()
        state = 'data'
        refused = False
        deadline = time.time() + self.args.timeout
        while time.time() < deadline:
            try:
                chunk = self.sock.recv(8192)
            except socket.timeout:
                continue
            if not chunk:
                break
            for c in chunk:
                if state == 'data':
                    if c == IAC:
                        state = 'iac'
                    else:
                        pending.append(c)
                elif state == 'iac':
                    if c == IAC:
                        pending.append(IAC)      # un-double
                        state = 'data'
                    elif c == EOR:
                        self.on_inbound_record(bytes(pending))
                        pending.clear()
                        state = 'data'
                    elif c == SB:
                        sb.clear()
                        state = 'sb'
                    elif c in CMD_NAME:
                        state = ('cmd', c)
                    elif c == AO:
                        log("  <- IAC AO  ** SYSREQ **")
                        state = 'data'
                    else:
                        log(f"  <- IAC 0x{c:02x}")
                        state = 'data'
                elif isinstance(state, tuple):
                    cmd = state[1]
                    log(f"  <- IAC {CMD_NAME[cmd]} "
                        f"{'TN3270E' if c == OPT_TN3270E else c}")
                    if c == OPT_TN3270E and cmd == WILL:
                        self.on_will_tn3270e()
                    elif c == OPT_TN3270E and cmd == WONT:
                        log("     ** client REFUSED TN3270E")
                        refused = True
                        deadline = 0
                    state = 'data'
                elif state == 'sb':
                    if c == IAC:
                        state = 'sbiac'
                    else:
                        sb.append(c)
                elif state == 'sbiac':
                    if c == SE:
                        self.on_subneg(bytes(sb))
                        state = 'data'
                    else:
                        sb.append(c)     # IAC IAC inside a subnegotiation
                        state = 'sb'

        self.sock.close()
        srv.close()
        # WITH --reject, A REFUSAL IS THE CORRECT OUTCOME, NOT A FAILURE. This is the
        # backoff path: the client is supposed to answer a DEVICE-TYPE REJECT with
        # WONT TN3270E and carry on as traditional tn3270, which real s3270 does.
        # An earlier version of this function reported exit 3 there, i.e. it called
        # conforming behaviour a failure -- which would have inverted the meaning of
        # the one test that exercises backoff.
        if self.args.reject:
            if refused:
                log("-- OK: client refused TN3270E after REJECT, as it should --")
                return 0
            log("-- FAIL: client did NOT back off after a DEVICE-TYPE REJECT --")
            return 5
        # THE SAME INVERSION, on the other route to a legitimate refusal. A client run
        # with `-tn3270e off`, or against an `N:` host, is SUPPOSED to answer WONT --
        # so without --expect-refuse the harness calls the correct outcome exit 3 and
        # any script driving it has to special-case the failure it just asked for.
        if self.args.expect_refuse:
            if refused:
                log("-- OK: client refused TN3270E, as it was told to --")
                return 0
            log("-- FAIL: client accepted TN3270E when it was told not to --")
            return 6
        if refused:
            log("-- FAIL: client refused TN3270E (pass --expect-refuse if that was intended) --")
            return 3
        if not self.negotiated:
            log("-- FAIL: negotiation never completed --")
            return 4
        log("-- OK: negotiation completed --")
        return 0

    def on_subneg(self, sb):
        if not sb or sb[0] != OPT_TN3270E:
            log(f"  <- IAC SB (not TN3270E) [{sb.hex()}]")
            return
        body = sb[1:]
        names = ' '.join(OP_NAME.get(b, hex(b)) for b in body[:2])
        log(f"  <- IAC SB TN3270E {names} [{body.hex()}]")
        if len(body) >= 2 and body[0] == OP['DEVICE_TYPE'] and body[1] == OP['REQUEST']:
            self.on_device_type_request(body)
        elif len(body) >= 2 and body[0] == OP['FUNCTIONS'] and body[1] == OP['REQUEST']:
            self.on_functions_request(body)
        elif len(body) >= 2 and body[0] == OP['FUNCTIONS'] and body[1] == OP['IS']:
            log(f"     ** client confirmed FUNCTIONS IS "
                f"{[FUNC_NAME.get(f, hex(f)) for f in body[2:]]}")
            if not self.negotiated:
                self.granted = list(body[2:])
                self.negotiated = True
                self.after_negotiation()
        else:
            log("     ** unrecognised TN3270E subnegotiation")


def parse_funcs(text):
    if text == '':
        return []
    out = []
    for name in text.split(','):
        key = name.strip().lower()
        if key not in FUNC:
            raise argparse.ArgumentTypeError(
                f"unknown function {name!r}; known: {', '.join(sorted(FUNC))}")
        out.append(FUNC[key])
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--port', type=int, required=True)
    p.add_argument('--grant', type=parse_funcs, default=[FUNC['responses'], FUNC['sysreq']],
                   help='comma-separated function names to grant, or "" for basic TN3270E')
    p.add_argument('--send-bind', action='store_true',
                   help='send a BIND after negotiation (only meaningful with bind-image granted)')
    p.add_argument('--expect-refuse', action='store_true',
                   help='a WONT TN3270E from the client is the PASS condition, not a '
                        'failure: use for -tn3270e off and for N: hosts')
    p.add_argument('--reject', choices=sorted(REASON),
                   help='reject the DEVICE-TYPE request with this reason')
    p.add_argument('--response-flag', type=lambda s: int(s, 0), default=0,
                   help='RESPONSE-FLAG on the 3270-DATA record: 0 none, 1 error, 2 always')
    p.add_argument('--device-name', default='IBM-3278-2-E')
    p.add_argument('--lu', default='TESTLU01')
    p.add_argument('--timeout', type=float, default=10.0)
    args = p.parse_args()
    return EServer(args).run()


if __name__ == '__main__':
    sys.exit(main())
