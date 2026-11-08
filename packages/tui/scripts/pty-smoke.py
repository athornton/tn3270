#!/usr/bin/env python3
"""
End-to-end smoke test for the TUI over a REAL pty, against a local fake host.

## WHY THIS EXISTS

Task 13's own acceptance step is "run it against a real host, quit, and confirm
the terminal still echoes". Both Hercules systems are IPLed by hand by the user
and were down, so this is the honest substitute: it exercises the parts unit
tests structurally cannot -- a real TTY, real raw mode, a real socket, and the
terminal's state AFTER the process exits.

That last check is the point. `restore()` being called is what the unit tests
prove; that the tty is actually usable afterwards is a different claim, and the
failure mode (a shell with no echo, recoverable only by typing `stty sane`
blind) is the most user-hostile one this package can ship.

## WHAT THE FAKE HOST IS

A minimal TN3270 server: the standard negotiation (TERMINAL-TYPE, then EOR and
BINARY both ways), then one Erase/Write carrying plain and colored fields. It is
NOT a substitute for a live host -- it cannot tell us what MVS or VM actually
send -- and Task 14 remains outstanding. It tells us the client draws, accepts
keystrokes and cleans up.

Run: python3 packages/tui/scripts/pty-smoke.py
Exit status 0 means every assertion held; failures are printed.

## --oversize-auto

    python3 packages/tui/scripts/pty-smoke.py --oversize-auto

A separate run (the default one above is untouched): the TUI with `-oversize auto` in a 41x100
pty. It asserts the host was told `IBM-DYNAMIC`; that the size measured was 40 rows by 100
columns (the terminal less the status row) -- seen by the host writing with Erase/Write
ALTERNATE, which puts the client on its alternate size, and the OIA then landing on row 41
column 1 (by its own `ESC[0m` prefix, not a border), which only a 40x100 screen in a 41x100 terminal gives; and that a resize to 51x132
says `applies at the next reconnect` within 2 s. FakeHost sends no Read Partition Query, so the
Query Reply the size really travels in is NOT read here; geometry.test/session tests cover it.
No reconnect either: FakeHost accepts once, and Session's unit tests cover re-measuring.

## --prompt

    python3 packages/tui/scripts/pty-smoke.py --prompt

A separate run: the TUI started with NO ARGUMENTS at a real tty, which is what makes it prompt
(`packages/tui/src/connectPrompt.ts`, spec docs/superpowers/specs/2026-11-08-tui-connect-prompt-
design.md). One sub-run answers the Host/Model/TLS questions with TLS on against a plaintext
`PromptFakeHost` (TERMINAL-TYPE negotiation, like `FakeHost.run`, but serving TWO connections in
turn on the same port, since round 2 answers Enter and keeps round 1's host): round 1's TLS
handshake stalls against the plaintext host and fails with the prompt's own wording
(`Answer n to TLS: ...`); round 2 declines TLS and the negotiation that follows, and the quit
afterwards, are checked exactly as the default run's. Two further short sub-runs check Ctrl-C: at
the very first `Host: ` question (exit 1, a newline, nothing connected) and while `Connecting to
...` is in flight against a listener that accepts and never speaks a byte -- the TLS handshake
waits its own timeout -- which must say `cancelled; waiting for the connection attempt to end`
and still exit 1 once that timeout is reached. All three leave the tty sane (ECHO restored).
"""

import os
import pty
import re
import select
import socket
import struct
import sys
import termios
import threading
import time

IAC, SB, SE, WILL, WONT, DO, DONT, EOR_CMD = 255, 250, 240, 251, 252, 253, 254, 239
OPT_BINARY, OPT_TTYPE, OPT_EOR = 0, 24, 25
TT_IS, TT_SEND = 0, 1

# EBCDIC cp037 for the text the host writes. The three letter runs are NOT
# contiguous -- A-I is C1-C9, J-R is D1-D9, S-Z is E2-E9 -- and digits are F0-F9.
E = {c: b for c, b in zip(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789",
    list(range(0xC1, 0xCA)) + list(range(0xD1, 0xDA)) + list(range(0xE2, 0xEA))
    + [0x40] + list(range(0xF0, 0xFA)),
)}


def ebcdic(text):
    return bytes(E[ch] for ch in text.upper())


def addr12(a):
    """12-bit buffer address, the two-byte form the manual's Appendix uses."""
    hi = "\x40\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\x4a\x4b\x4c\x4d\x4e\x4f"
    hi += "\x50\xd1\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\x5a\x5b\x5c\x5d\x5e\x5f"
    hi += "\x60\x61\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\x6a\x6b\x6c\x6d\x6e\x6f"
    hi += "\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\x7a\x7b\x7c\x7d\x7e\x7f"
    return bytes([ord(hi[(a >> 6) & 0x3F]), ord(hi[a & 0x3F])])


def screen_record(alternate=False):
    """Erase/Write with two fields: a plain one and a red one.

    `alternate` sends Erase/Write ALTERNATE (0x7E) instead, for --oversize-auto: the client then
    switches to its alternate size, which is the one `-oversize auto` measured."""
    out = bytearray()
    out += b"\x7e\xc3" if alternate else b"\xf5\xc3"  # EW/EWA, WCC = reset + restore keyboard
    out += b"\x11" + addr12(0)              # SBA row 1 col 1
    out += b"\x1d\xf0"                      # SF, protected/intensified-ish
    out += ebcdic("HELLO TN3270")
    out += b"\x11" + addr12(80)             # SBA row 2 col 1
    out += b"\x29\x02\xc0\xf0\x42\xf2"      # SFE: basic attr + FOREGROUND red
    out += ebcdic("RED FIELD")
    out += b"\x11" + addr12(160)            # SBA row 3: an input field
    out += b"\x1d\x40"                      # SF, unprotected (0x20 clear)
    # IC, or the cursor stays at address 0 -- inside the PROTECTED first field --
    # and every keystroke is correctly refused, which looks exactly like a broken
    # input path. The first version of this script omitted it and "typing does
    # nothing" was the result.
    out += b"\x13"
    return bytes(out)


class FakeHost(threading.Thread):
    daemon = True

    def __init__(self, alternate=False):
        super().__init__()
        self.alternate = alternate
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.inbound = bytearray()
        self.ttype = None

    def run(self):
        conn, _ = self.sock.accept()
        conn.sendall(bytes([IAC, DO, OPT_TTYPE]))
        deadline = time.time() + 10
        sent_screen = False
        while time.time() < deadline:
            r, _, _ = select.select([conn], [], [], 0.3)
            if r:
                data = conn.recv(4096)
                if not data:
                    break
                self.inbound += data
                # TERMINAL-TYPE: once the client says WILL, ask for the string.
                if bytes([IAC, WILL, OPT_TTYPE]) in data:
                    conn.sendall(bytes([IAC, SB, OPT_TTYPE, TT_SEND, IAC, SE]))
                if bytes([IAC, SB, OPT_TTYPE, TT_IS]) in bytes(self.inbound):
                    blob = bytes(self.inbound)
                    i = blob.index(bytes([IAC, SB, OPT_TTYPE, TT_IS])) + 4
                    j = blob.index(bytes([IAC, SE]), i)
                    self.ttype = blob[i:j].decode("ascii", "replace")
                    if not sent_screen:
                        # Now negotiate the 3270 data stream both ways.
                        conn.sendall(bytes([IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR,
                                            IAC, DO, OPT_BINARY, IAC, WILL, OPT_BINARY]))
                        time.sleep(0.3)
                        conn.sendall(screen_record(self.alternate) + bytes([IAC, EOR_CMD]))
                        sent_screen = True
        try:
            conn.close()
        except OSError:
            pass


class PromptFakeHost(threading.Thread):
    """Like `FakeHost`, but serves MULTIPLE connections in turn on the SAME listening socket.

    `--prompt`'s round 2 answers Enter to the Host question, which keeps round 1's host:port --
    so the two connect attempts (round 1's TLS probe, which stalls against this plaintext host
    and never gets past the first bytes; round 2's real negotiation once TLS is declined) must
    land on one port. `FakeHost.run` accepts exactly once; this loops, serving each connection
    with the same TERMINAL-TYPE-then-EOR-then-BINARY shape as `FakeHost.run`."""

    daemon = True

    def __init__(self):
        super().__init__()
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.ttype = None
        self._stop = False

    def run(self):
        self.sock.settimeout(1.0)
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            self._serve(conn)

    def _serve(self, conn):
        """One connection's negotiation. A round that never speaks TELNET back (round 1's TLS
        ClientHello, which this plaintext host cannot parse) simply sits here until the CLIENT
        gives up and closes -- seen here as `recv` returning no data -- and control returns to
        `run`'s accept loop for the next round."""
        inbound = bytearray()
        try:
            conn.sendall(bytes([IAC, DO, OPT_TTYPE]))
        except OSError:
            return
        conn.settimeout(0.3)
        deadline = time.time() + 11
        sent_screen = False
        while time.time() < deadline and not self._stop:
            try:
                data = conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                break
            if not data:
                break
            inbound += data
            if bytes([IAC, WILL, OPT_TTYPE]) in data:
                conn.sendall(bytes([IAC, SB, OPT_TTYPE, TT_SEND, IAC, SE]))
            if bytes([IAC, SB, OPT_TTYPE, TT_IS]) in bytes(inbound):
                blob = bytes(inbound)
                i = blob.index(bytes([IAC, SB, OPT_TTYPE, TT_IS])) + 4
                j = blob.index(bytes([IAC, SE]), i)
                self.ttype = blob[i:j].decode("ascii", "replace")
                if not sent_screen:
                    conn.sendall(bytes([IAC, DO, OPT_EOR, IAC, WILL, OPT_EOR,
                                        IAC, DO, OPT_BINARY, IAC, WILL, OPT_BINARY]))
                    time.sleep(0.3)
                    conn.sendall(screen_record() + bytes([IAC, EOR_CMD]))
                    sent_screen = True
        try:
            conn.close()
        except OSError:
            pass

    def stop(self):
        self._stop = True
        try:
            self.sock.close()
        except OSError:
            pass


def main():
    host = FakeHost()
    host.start()

    main_fd, child_fd = pty.openpty()
    # A 25x80 window: 24 rows of 3270 plus the status line, the minimum tooSmall
    # accepts. Set BEFORE exec so the child's first stdout.rows is right.
    termios.tcsetattr(child_fd, termios.TCSANOW, termios.tcgetattr(child_fd))
    import fcntl
    fcntl.ioctl(child_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 25, 80, 0, 0))

    before = termios.tcgetattr(child_fd)
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))
    # -insecure IS MANDATORY HERE. TLS is on by default, and FakeHost speaks
    # plaintext TN3270 -- so without it the client correctly refuses to connect and
    # every check below fails against a dead session. It reads like a client bug and
    # is not one.
    argv = ["node", os.path.join(repo, "packages/tui/dist/main.js"),
            "-insecure", "--colors", "256", f"127.0.0.1:{host.port}"]
    pid = os.fork()
    if pid == 0:
        os.setsid()
        # TIOCSCTTY IS REQUIRED FOR SIGWINCH TO ARRIVE. After setsid() the child has
        # no controlling terminal, and dup2()-ing an fd the PARENT opened does not
        # give it one -- so the kernel has nowhere to send window-change signals and
        # TIOCSWINSZ on the master silently does nothing to the child. The resize
        # checks below failed for exactly this reason, looking like a client bug.
        fcntl.ioctl(child_fd, termios.TIOCSCTTY, 0)
        os.dup2(child_fd, 0)
        os.dup2(child_fd, 1)
        os.dup2(child_fd, 2)
        os.close(main_fd)
        os.close(child_fd)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="")
        os.execvpe("node", argv, env)
        os._exit(127)

    os.close(child_fd)
    captured = bytearray()
    raw_seen = False
    deadline = time.time() + 12
    typed = False
    while time.time() < deadline:
        r, _, _ = select.select([main_fd], [], [], 0.3)
        if r:
            try:
                chunk = os.read(main_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            captured += chunk
        # Wait for the HOST'S WRITE, not merely for the alternate screen.
        #
        # An earlier version keyed off `\x1b[?1049h`, which appears on the first
        # paint -- before the host has written anything, when the keyboard is
        # correctly locked with "X Wait" (AwaitingFirstWrite). Every keystroke was
        # then properly refused, and the script reported a broken input path. The
        # client was right and the test was early.
        if not typed and b"HELLO TN3270" in bytes(captured):
            attrs = termios.tcgetattr(main_fd)
            raw_seen = not (attrs[3] & termios.ECHO)
            os.write(main_fd, b"XYZ")        # type into the unprotected field
            typed = True
            time.sleep(0.8)
        # DO NOT QUIT HERE. An earlier version sent Ctrl-] immediately after typing,
        # which meant the resize checks below ran against an already-dead client and
        # reported two honest-looking failures about a feature they never exercised.
        # The quit happens after those checks.
        if typed and b"XYZ" in bytes(captured):
            break

    # RESIZE, end to end. Setting the window size on the master delivers a real
    # SIGWINCH to the child's process group, which is the one part of the resize
    # feature no unit test can reach: the signal itself.
    resize_msg = resize_repaint = False
    if typed:
        def winsize(rows, cols):
            fcntl.ioctl(main_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

        def sip(seconds):
            got = bytearray()
            end2 = time.time() + seconds
            while time.time() < end2:
                r, _, _ = select.select([main_fd], [], [], 0.3)
                if not r:
                    continue
                try:
                    d = os.read(main_fd, 65536)
                except OSError:
                    break
                if not d:
                    break
                got += d
            return bytes(got)

        winsize(20, 80)                      # below the 24-row minimum
        shrunk = sip(2.0)
        resize_msg = b"too small" in shrunk
        winsize(25, 80)                      # back to room for the OIA
        grown = sip(2.5)
        # A full repaint must follow, and the OIA must reappear on row 25.
        resize_repaint = b"HELLO TN3270" in grown and b"\x1b[25;1H" in grown
        captured += shrunk + grown

    os.write(main_fd, b"\x1d")               # Ctrl-] quits
    # Read what the quit produced. The loop above used to break on seeing the
    # alternate-buffer exit, so it was captured for free; now that the quit happens
    # here, it has to be drained explicitly or the teardown assertions see nothing.
    end3 = time.time() + 2.0
    while time.time() < end3:
        r, _, _ = select.select([main_fd], [], [], 0.3)
        if not r:
            continue
        try:
            d = os.read(main_fd, 65536)
        except OSError:
            break
        if not d:
            break
        captured += d
    time.sleep(0.3)
    _, status = os.waitpid(pid, os.WNOHANG)
    after = termios.tcgetattr(main_fd)
    out = bytes(captured)

    checks = [
        ("entered the alternate screen buffer", b"\x1b[?1049h" in out),
        ("left the alternate screen buffer on quit", b"\x1b[?1049l" in out),
        ("raw mode was actually in effect (ECHO off)", raw_seen),
        ("ECHO is restored after exit", bool(after[3] & termios.ECHO)),
        ("negotiated a terminal type", host.ttype is not None),
        ("drew the host's plain text", b"HELLO TN3270" in out),
        ("drew the host's second field", b"RED FIELD" in out),
        ("emitted a 256-color SGR", re.search(rb"\x1b\[[\d;]*38;5;\d+", out) is not None),
        ("echoed the typed characters back to the screen", b"XYZ" in out),
        ("drew a status line", b"\x1b[25;1H" in out),
        ("said 'too small' when shrunk below 24 rows", resize_msg),
        ("repainted in full, with the OIA back, when regrown", resize_repaint),
    ]

    print(f"terminal type the host saw: {host.ttype!r}")
    print(f"bytes captured from the pty: {len(out)}")
    print(f"client sent {len(host.inbound)} bytes inbound")
    ok = True
    for name, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
        ok = ok and passed

    if not ok:
        print("\n--- captured output (repr, first 1500 bytes) ---")
        print(repr(out[:1500]))
    return 0 if ok else 1


def oversize_auto():
    """The --oversize-auto run; see the module docstring. Same fork/TIOCSCTTY/drain shape as
    main(), kept separate so the default run stays exactly what it was."""
    import fcntl
    host = FakeHost(alternate=True)
    host.start()

    main_fd, child_fd = pty.openpty()
    # 41x100 BEFORE exec: `auto` measures at the first connect, from the child's first
    # stdout.rows/columns, so a size set after the fork would race the measurement.
    fcntl.ioctl(child_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 41, 100, 0, 0))
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))
    # -insecure is mandatory for the same reason as in main(): FakeHost speaks plaintext.
    argv = ["node", os.path.join(repo, "packages/tui/dist/main.js"),
            "-insecure", "-oversize", "auto", "--colors", "256", f"127.0.0.1:{host.port}"]
    pid = os.fork()
    if pid == 0:
        os.setsid()
        # TIOCSCTTY or no SIGWINCH reaches the child, and the resize check fails against a client
        # that was never told; see main().
        fcntl.ioctl(child_fd, termios.TIOCSCTTY, 0)
        os.dup2(child_fd, 0)
        os.dup2(child_fd, 1)
        os.dup2(child_fd, 2)
        os.close(main_fd)
        os.close(child_fd)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="")
        os.execvpe("node", argv, env)
        os._exit(127)
    os.close(child_fd)

    def sip(seconds, until=None):
        got = bytearray()
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([main_fd], [], [], 0.3)
            if not r:
                continue
            try:
                d = os.read(main_fd, 65536)
            except OSError:
                break
            if not d:
                break
            got += d
            if until is not None and until in bytes(got):
                break
        return bytes(got)

    # Wait for the host's EWA to be DRAWN, not merely received; the deadline loop, as in main().
    captured = bytearray(sip(12, until=b"HELLO TN3270"))
    drew = b"HELLO TN3270" in captured
    if drew:
        captured += sip(0.8)               # let the OIA paint after the screen
    # `ESC[41;1H ESC[0m`, the OIA's own prefix (render.ts), not merely `ESC[41;1H`: a 39-row
    # screen here puts its BOTTOM BORDER on 41;1, and a bare position check passed that mutant.
    oia_41_1 = b"\x1b[41;1H\x1b[0m" in bytes(captured)
    no_oia_40 = b"\x1b[40;1H\x1b[0m" not in bytes(captured)

    # The resize BEFORE the quit, for the reason main() gives: after it, the client is dead.
    resize_msg = b""
    if drew:
        fcntl.ioctl(main_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 51, 132, 0, 0))
        resize_msg = sip(2.0, until=b"applies at the next reconnect")
        captured += resize_msg

    os.write(main_fd, b"\x1d")               # Ctrl-] quits
    captured += sip(2.0)
    time.sleep(0.3)
    os.waitpid(pid, os.WNOHANG)
    after = termios.tcgetattr(main_fd)
    out = bytes(captured)
    m = re.search(rb"window now fits ([^;]*); applies at the next reconnect", resize_msg)

    checks = [
        ("host was told IBM-DYNAMIC", host.ttype == "IBM-DYNAMIC"),
        ("drew the host's EWA screen", drew),
        ("OIA on 41;1 (and not 40;1): the alternate measured as 40 rows by 100 columns",
         oia_41_1 and no_oia_40),
        ("a resize to 51x132 said 'applies at the next reconnect' within 2 s",
         b"applies at the next reconnect" in resize_msg),
        ("and named 50 rows by 132 columns", m is not None and m.group(1) == b"50 rows by 132 columns"),
        ("left the alternate screen buffer on quit", b"\x1b[?1049l" in out),
        ("ECHO is restored after exit", bool(after[3] & termios.ECHO)),
    ]
    print(f"terminal type the host saw: {host.ttype!r}")
    print(f"bytes captured from the pty: {len(out)}")
    print(f"resize message: {m.group(0).decode() if m else None!r}")
    ok = True
    for name, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
        ok = ok and passed
    if not ok:
        print("\n--- captured output (repr, first 3000 bytes) ---")
        print(repr(out[:3000]))
    return 0 if ok else 1


def _spawn_tui_no_args(main_fd, child_fd):
    """Forks and execs the TUI with NO ARGUMENTS in `child_fd`'s pty -- the one thing every
    `--prompt` sub-run needs, since the prompt only happens with no host on the command line.
    Same setsid/TIOCSCTTY/dup2 shape as main()/oversize_auto(); see main()'s comments for why
    each line is there. Returns the child pid; the parent's copy of `child_fd` is closed here."""
    import fcntl
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))))
    argv = ["node", os.path.join(repo, "packages/tui/dist/main.js")]
    pid = os.fork()
    if pid == 0:
        os.setsid()
        fcntl.ioctl(child_fd, termios.TIOCSCTTY, 0)
        os.dup2(child_fd, 0)
        os.dup2(child_fd, 1)
        os.dup2(child_fd, 2)
        os.close(main_fd)
        os.close(child_fd)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="")
        os.execvpe("node", argv, env)
        os._exit(127)
    os.close(child_fd)
    return pid


def _open_pty(rows=25, cols=80):
    """A fresh pty pair, sized BEFORE exec as main()'s does, so the child's first
    stdout.rows/columns is already right."""
    import fcntl
    main_fd, child_fd = pty.openpty()
    fcntl.ioctl(child_fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    return main_fd, child_fd


def _wait_count(main_fd, captured, pattern, min_count, seconds):
    """Reads from `main_fd` into `captured` (mutated in place) until `pattern` has appeared at
    least `min_count` times or `seconds` elapses. A plain substring check against the whole
    buffer is not enough for `--prompt`: `Model [3278-2-E]: ` and `TLS [Y/n]: ` each appear once
    per round, so the SECOND round's prompt must be counted, not merely found."""
    end = time.time() + seconds
    while time.time() < end:
        if bytes(captured).count(pattern) >= min_count:
            return True
        r, _, _ = select.select([main_fd], [], [], 0.3)
        if not r:
            continue
        try:
            d = os.read(main_fd, 65536)
        except OSError:
            break
        if not d:
            break
        captured.extend(d)
    return bytes(captured).count(pattern) >= min_count


def _drain_until_exit(main_fd, pid, seconds, captured):
    """Reads from `main_fd` into `captured` while waiting (WNOHANG) for `pid` to exit. Returns
    the exit status, or None if it did not exit within `seconds` or did not exit normally."""
    end = time.time() + seconds
    code = None
    while time.time() < end:
        r, _, _ = select.select([main_fd], [], [], 0.2)
        if r:
            try:
                d = os.read(main_fd, 65536)
            except OSError:
                d = b""
            if d:
                captured.extend(d)
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid != 0:
            if os.WIFEXITED(status):
                code = os.WEXITSTATUS(status)
            break
    return code


def prompt_mode():
    """--prompt: the TUI run with NO ARGUMENTS at a real tty, which is what makes it ask for a
    host instead of the usage error (`connectPrompt.ts`). Three independent sub-runs, each its
    own fork and pty; see the module docstring's `--prompt` section for the shape of each."""

    def send(main_fd, s):
        os.write(main_fd, s.encode() if isinstance(s, str) else s)

    checks = []
    report = []

    def check(name, cond):
        checks.append((name, cond))

    # --- sub-run 1: a TLS round that stalls and fails, then a retry that connects and draws ----
    host = PromptFakeHost()
    host.start()
    main_fd, child_fd = _open_pty()
    pid = _spawn_tui_no_args(main_fd, child_fd)
    captured = bytearray()

    check("showed the Host prompt", _wait_count(main_fd, captured, b"Host: ", 1, 5))
    send(main_fd, f"127.0.0.1:{host.port}\r")
    check("showed the Model prompt", _wait_count(main_fd, captured, b"Model [3278-2-E]: ", 1, 5))
    send(main_fd, "\r")
    check("showed the TLS prompt", _wait_count(main_fd, captured, b"TLS [Y/n]: ", 1, 5))
    send(main_fd, "\r")                      # TLS on (default): stalls against a plaintext host

    tls_fail = f"Answer n to TLS: 127.0.0.1:{host.port}".encode()
    check("round 1's stalled TLS handshake failed with the prompt's own wording",
          _wait_count(main_fd, captured, tls_fail, 1, 15))
    host2 = f"Host [127.0.0.1:{host.port}]: ".encode()
    check("started round 2 with round 1's host as the default",
          _wait_count(main_fd, captured, host2, 1, 3))
    send(main_fd, "\r")
    check("round 2's Model prompt", _wait_count(main_fd, captured, b"Model [3278-2-E]: ", 2, 3))
    send(main_fd, "\r")
    check("round 2's TLS prompt", _wait_count(main_fd, captured, b"TLS [Y/n]: ", 2, 3))
    send(main_fd, "n\r")                      # TLS off: round 2 negotiates in plaintext

    # The default run's own drawn-screen assertion: FakeHost's plain-text field, drawn.
    drew = _wait_count(main_fd, captured, b"HELLO TN3270", 1, 12)
    check("round 2 negotiated and the screen drew the host's plain text", drew)
    check("drew the host's second field", _wait_count(main_fd, captured, b"RED FIELD", 1, 2))
    check("drew a status line", _wait_count(main_fd, captured, b"\x1b[25;1H", 1, 2))
    check("entered the alternate screen buffer", b"\x1b[?1049h" in bytes(captured))
    check("negotiated a terminal type", host.ttype is not None)
    raw_seen = not (termios.tcgetattr(main_fd)[3] & termios.ECHO)
    check("raw mode was actually in effect (ECHO off) while connected", raw_seen)

    send(main_fd, b"\x1d")                    # Ctrl-] quits, exactly as the default run checks
    _drain_until_exit(main_fd, pid, 3, captured)
    time.sleep(0.3)
    after = termios.tcgetattr(main_fd)
    check("left the alternate screen buffer on quit", b"\x1b[?1049l" in bytes(captured))
    check("ECHO is restored after exit (the tty is sane)", bool(after[3] & termios.ECHO))
    host.stop()
    report.append(("sub-run 1 (TLS round fails, retry connects)", host.ttype, len(captured)))

    # --- sub-run 2: Ctrl-C at the very first question quits, exit 1, tty sane -------------------
    main_fd2, child_fd2 = _open_pty()
    pid2 = _spawn_tui_no_args(main_fd2, child_fd2)
    captured2 = bytearray()
    check("sub-run 2: showed the Host prompt", _wait_count(main_fd2, captured2, b"Host: ", 1, 5))
    before_ctrlc = len(captured2)
    send(main_fd2, b"\x03")                   # Ctrl-C at Host:
    code2 = _drain_until_exit(main_fd2, pid2, 5, captured2)
    time.sleep(0.2)
    after2 = termios.tcgetattr(main_fd2)
    check("sub-run 2: exited with status 1", code2 == 1)
    check("sub-run 2: wrote a newline so the shell prompt starts clean",
          b"\n" in bytes(captured2)[before_ctrlc:])
    check("sub-run 2: ECHO is restored after exit (the tty is sane)", bool(after2[3] & termios.ECHO))
    report.append(("sub-run 2 (Ctrl-C at Host:)", code2, len(captured2)))

    # --- sub-run 3: Ctrl-C while connecting (a TLS handshake that waits) -------------------------
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    listen_port = listener.getsockname()[1]

    def hold_one_connection():
        try:
            listener.settimeout(15)
            conn, _ = listener.accept()
            # Accepts, then says NOTHING: the TLS handshake on the other end waits its own
            # timeout rather than failing fast, which is the scenario this sub-run needs.
            time.sleep(14)
            try:
                conn.close()
            except OSError:
                pass
        except OSError:
            pass

    holder = threading.Thread(target=hold_one_connection, daemon=True)
    holder.start()

    main_fd3, child_fd3 = _open_pty()
    pid3 = _spawn_tui_no_args(main_fd3, child_fd3)
    captured3 = bytearray()
    check("sub-run 3: showed the Host prompt", _wait_count(main_fd3, captured3, b"Host: ", 1, 5))
    send(main_fd3, f"127.0.0.1:{listen_port}\r")
    check("sub-run 3: showed the Model prompt",
          _wait_count(main_fd3, captured3, b"Model [3278-2-E]: ", 1, 5))
    send(main_fd3, "\r")
    check("sub-run 3: showed the TLS prompt", _wait_count(main_fd3, captured3, b"TLS [Y/n]: ", 1, 5))
    send(main_fd3, "\r")                      # TLS on: the handshake against the silent listener waits
    connecting = f"Connecting to 127.0.0.1:{listen_port}...".encode()
    check("sub-run 3: said Connecting to the listener", _wait_count(main_fd3, captured3, connecting, 1, 5))
    send(main_fd3, b"\x03")                   # Ctrl-C while the handshake is in flight
    check("sub-run 3: said cancelled; waiting for the connection attempt to end",
          _wait_count(main_fd3, captured3, b"cancelled; waiting for the connection attempt to end", 1, 3))
    code3 = _drain_until_exit(main_fd3, pid3, 12, captured3)
    time.sleep(0.2)
    after3 = termios.tcgetattr(main_fd3)
    check("sub-run 3: exited with status 1 once the handshake timed out", code3 == 1)
    check("sub-run 3: ECHO is restored after exit (the tty is sane)", bool(after3[3] & termios.ECHO))
    listener.close()
    report.append(("sub-run 3 (Ctrl-C while connecting)", code3, len(captured3)))

    for name, extra, nbytes in report:
        print(f"{name}: {nbytes} bytes captured, {extra!r}")
    ok = True
    for name, passed in checks:
        print(f"  {'PASS' if passed else 'FAIL'}  {name}")
        ok = ok and passed
    if not ok:
        print("\n--- sub-run 1 captured output (repr, first 2000 bytes) ---")
        print(repr(bytes(captured)[:2000]))
        print("\n--- sub-run 2 captured output (repr) ---")
        print(repr(bytes(captured2)))
        print("\n--- sub-run 3 captured output (repr, first 2000 bytes) ---")
        print(repr(bytes(captured3)[:2000]))
    return 0 if ok else 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--oversize-auto"]:
        sys.exit(oversize_auto())
    if sys.argv[1:] == ["--prompt"]:
        sys.exit(prompt_mode())
    if sys.argv[1:]:
        print("usage: pty-smoke.py [--oversize-auto|--prompt]", file=sys.stderr)
        sys.exit(2)
    sys.exit(main())
