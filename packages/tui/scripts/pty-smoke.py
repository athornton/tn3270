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
BINARY both ways), then one Erase/Write carrying plain and coloured fields. It is
NOT a substitute for a live host -- it cannot tell us what MVS or VM actually
send -- and Task 14 remains outstanding. It tells us the client draws, accepts
keystrokes and cleans up.

Run: python3 packages/tui/scripts/pty-smoke.py
Exit status 0 means every assertion held; failures are printed.
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


def screen_record():
    """Erase/Write with two fields: a plain one and a red one."""
    out = bytearray()
    out += b"\xf5\xc3"                      # EW, WCC = reset + restore keyboard
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

    def __init__(self):
        super().__init__()
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
                        conn.sendall(screen_record() + bytes([IAC, EOR_CMD]))
                        sent_screen = True
        try:
            conn.close()
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
    argv = ["node", os.path.join(repo, "packages/tui/dist/main.js"),
            "--colors", "256", f"127.0.0.1:{host.port}"]
    pid = os.fork()
    if pid == 0:
        os.setsid()
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
            time.sleep(0.5)
            os.write(main_fd, b"\x1d")       # Ctrl-] quits
            typed = True
        if typed and b"\x1b[?1049l" in bytes(captured):
            break

    time.sleep(0.4)
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
        ("emitted a 256-colour SGR", re.search(rb"\x1b\[[\d;]*38;5;\d+", out) is not None),
        ("echoed the typed characters back to the screen", b"XYZ" in out),
        ("drew a status line", b"\x1b[25;1H" in out),
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


if __name__ == "__main__":
    sys.exit(main())
