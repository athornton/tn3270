#!/usr/bin/env python3
"""
Drive the TUI against a LIVE host over a real pty, and check what it drew.

## WHY A SCRIPT AND NOT JUST TYPING

Task 14 asks for the TUI to be driven interactively against both Hercules
systems. An agent has no terminal, so "interactively" has to mean a pty with a
keystroke script -- and that is better than hand-typing anyway, because the two
things that go wrong here are both timing-sensitive and need to be reproducible:

- **The keyboard is locked until the host writes** (`AwaitingFirstWrite`), so
  anything typed too early is correctly refused and looks like a broken client.
  Every step therefore waits for TEXT THE HOST SENT, never for a fixed delay.
- **An account left logged on is a trap on BOTH hosts.** VM RECONNECTS rather than
  refusing, landing at `CP READ` where every command goes to CP; MVS answers
  `IKJ56425I LOGON REJECTED, USERID ... IN USE` and needs an operator to clear it.
  Quitting the TUI does NOT log off, so a flow that fails partway leaves the
  account held. This script therefore always attempts its logoff steps, and says
  whether it got there.

## YOU CANNOT GREP THE OUTPUT STREAM -- RECONSTRUCT THE SCREEN

**This is the bug that made the first version of this script report a false
failure**, and it is inherent to the thing being tested. `TerminalRenderer` emits
only CHANGED cells, so the text on screen is NOT a contiguous byte string in the
output: a redrawn `USERID` can arrive as `USER`, a cursor-position escape, then
`ID`, because the two halves were dirty and the middle was not. Substring
searching the stream therefore misses text that is plainly on the screen -- it
found the panel during the initial full paint and lost it on every later diff.

So this parses the ANSI stream into a 25x80 grid and searches THAT. Which is also
the stronger test: it verifies what a user would actually see, and it lets the
per-cell foreground colours be compared against the CLI's `ScreenJson`.

## THE PASSWORD IS NOT IN THIS FILE

Pass it in the environment. MVS 3.8j echoes it to the screen UNMASKED, so it lands
in the raw capture under /tmp; redact before committing any of it.

Usage:
  TN3270_PASSWORD=CUL8TR python3 packages/tui/scripts/live-drive.py tk5
  TN3270_PASSWORD=CMSUSER python3 packages/tui/scripts/live-drive.py vm
"""

import os
import pty
import re
import select
import struct
import sys
import termios
import fcntl
import time

CTRL_R, CTRL_C, CTRL_BRACKET, CR = b"\x12", b"\x03", b"\x1d", b"\r"
PF3 = b"\x1bOR"          # tput kf3; ISPF END
ROWS, COLS = 25, 80

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))


class AnsiScreen:
    """
    Just enough of a terminal to reconstruct what the TUI drew.

    Handles what TerminalRenderer actually emits and nothing more: absolute cursor
    positioning, SGR (recorded per cell, for the colour comparison), erase-to-EOL,
    erase-screen, and the alternate-buffer switches. Anything else is skipped
    rather than guessed at -- an unrecognised sequence here would silently corrupt
    the grid, so `unknown` is counted and reported.
    """

    def __init__(self):
        self.grid = [[" "] * COLS for _ in range(ROWS)]
        self.fg = [[None] * COLS for _ in range(ROWS)]
        self.row = self.col = 0
        self.cur_fg = None
        self.cur_rev = False
        self.rev = [[False] * COLS for _ in range(ROWS)]
        self.unknown = 0
        self.pending = b""

    def feed(self, chunk):
        """
        ## AN ESCAPE SEQUENCE CAN BE SPLIT ACROSS TWO READS, AND THAT MUST BE BUFFERED
        #
        A socket read boundary has nothing to do with sequence boundaries, so a
        chunk can end on a bare `\\x1b` with `[38;5;188;48;5;59m` arriving next
        time. The first version of this parser handled each chunk independently:
        the trailing ESC failed to match, was counted `unknown` and skipped, and
        the following chunk's parameters were then written into the grid AS TEXT.
        The symptom was a line of the ISPF panel reading a literal
        `[38;5;188;48;5;59m  Summary of changes made in TK5`.
        #
        That is a defect in THIS HARNESS, not in the TUI -- the client emitted a
        perfectly good sequence -- but it corrupts the grid the assertions read, so
        it could just as easily have produced a false failure as a visible oddity.
        Incomplete tails are therefore held over to the next call.
        """
        data = self.pending + chunk
        self.pending = b""
        # If the tail looks like the start of an unfinished escape sequence, hold it.
        m = re.search(rb"\x1b\[?[0-9;?]*$", data)
        if m and m.start() > len(data) - 12:
            self.pending = data[m.start():]
            data = data[:m.start()]
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == 0x1B:
                # OSC (\x1b]...BEL or ST) -- cursor colour, and its reset. Consumed
                # rather than counted: the client legitimately emits these, and an
                # `unknown` counter that always shows noise is a counter nobody reads.
                osc = re.match(rb"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", data[i:])
                if osc:
                    i += osc.end()
                    continue
                # DECSCUSR, `\x1b[<n> q` -- note the SPACE before the final byte, which
                # the CSI pattern below will not match.
                cursor = re.match(rb"\x1b\[[0-9;]* q", data[i:])
                if cursor:
                    i += cursor.end()
                    continue
                m = re.match(rb"\x1b\[([0-9;?]*)([A-Za-z])", data[i:])
                if not m:
                    self.unknown += 1
                    i += 1
                    continue
                params, final = m.group(1), m.group(2)
                if final == b"H":
                    parts = params.split(b";")
                    self.row = max(0, int(parts[0] or 1) - 1)
                    self.col = max(0, int(parts[1] or 1) - 1) if len(parts) > 1 else 0
                elif final == b"m":
                    ps = [x for x in params.split(b";") if x != b""]
                    if not ps or b"0" in ps[:1]:
                        self.cur_fg = None
                        self.cur_rev = False
                    mm = re.search(rb"38;5;(\d+)", params)
                    if mm:
                        self.cur_fg = int(mm.group(1))
                    if b"7" in ps:
                        self.cur_rev = True
                    if b"27" in ps:
                        self.cur_rev = False
                elif final == b"K":
                    if self.row < ROWS:
                        for c in range(self.col, COLS):
                            self.grid[self.row][c] = " "
                elif final == b"J":
                    self.grid = [[" "] * COLS for _ in range(ROWS)]
                elif final in (b"h", b"l"):
                    pass
                else:
                    self.unknown += 1
                i += m.end()
                continue
            if b in (0x0D, 0x0A):
                if b == 0x0D:
                    self.col = 0
                else:
                    self.row = min(ROWS - 1, self.row + 1)
                i += 1
                continue
            if 0x20 <= b <= 0x7E:
                if self.row < ROWS and self.col < COLS:
                    self.grid[self.row][self.col] = chr(b)
                    self.fg[self.row][self.col] = self.cur_fg
                    self.rev[self.row][self.col] = self.cur_rev
                self.col += 1
                if self.col >= COLS:
                    self.col = 0
                    self.row = min(ROWS - 1, self.row + 1)
                i += 1
                continue
            i += 1

    def text(self):
        return "\n".join("".join(r) for r in self.grid)

    def colours(self):
        seen = {}
        for r in range(ROWS - 1):            # exclude the status row
            for c in range(COLS):
                if self.grid[r][c] != " ":
                    seen[self.fg[r][c]] = seen.get(self.fg[r][c], 0) + 1
        return seen


def flow_tk5(pw, user):
    return [
        ("Hercules banner or VTAM panel", ["TK5", "Logon", "Terminal"], CTRL_R + CTRL_C),
        ("VTAM USS logon panel", ["Logon"], user.encode() + CR),
        ("password prompt", ["PASSWORD", "password"], pw.encode() + CR),
        ("logon banner", ["LOGON IN PROGRESS", "Welcome", "***"], CR),
        # TSO shows TWO more-output prompts before ISPF: the welcome banner, then a
        # FORTUNE COOKIE. The first version of this flow sent one Enter and timed
        # out staring at ASCII cat art, which record-mvs.txt had documented all
        # along ("A fortune cookie, and another ***").
        #
        # DISMISS EVERY more-output PROMPT, however many there are. A fixed settle
        # then one Enter was not enough: the count is not fixed (welcome banner,
        # then a FORTUNE COOKIE, and the fortune's own `***`), and a settle can fire
        # the Enter before the next screen has even arrived. `"DRAIN***"` loops until
        # no `***` remains, which is the only form that does not depend on counting.
        ("dismiss more-output prompts", "DRAIN***", None),
        ("ISPF primary option menu", ["USERID", "BROWSE", "Primary Option"],
         (b"T" + CR) if os.environ.get("TN3270_TUTORIAL") else (b"X" + CR)),
        # Paging the Tutorial is where the SGR-accumulation mottling showed up: its
        # title bar is the only reverse-video run either host sends.
        ("tutorial page 1", ["Tutorial", "tutorial"], CR),
        ("tutorial page 2", None, CR),
        ("tutorial page 3", None, PF3),
        ("back out of the tutorial", None, PF3),
        ("at the menu or READY", None, b"X" + CR),
        ("TSO READY", ["READY", "CLST"], b"LOGOFF" + CR),
        ("logged off", ["LOGGED OFF", "Logon", "RUNNING"], None),
    ]


def flow_vm(pw, user):
    """
    The FIRST Enter is consumed dismissing the all-protected banner and its text is
    discarded, so two are sent before typing anything -- typing LOGON as the first
    input throws it away and puts everything after off by one, the bug that cost an
    earlier session three false failures.
    """
    # ⚠️ NEVER MATCH THE BARE STRING "CMS" HERE. The screen echoes `LOGON CMSUSER`,
    # so "CMS" matches the USERID and fires the step before CMS is anywhere near
    # ready. That is what happened on the second VM run: steps 5 and 6 both matched
    # on `CMSUSER`, the Clear went in early, and `QUERY DISK A` reached CP instead of
    # CMS -- which answered `DISK NOT LOGGED ON` and looked like a client fault.
    # Match `Ready;` (the CMS prompt) or `MORE...` or `CP READ` instead.
    return [
        ("connect banner", ["VM/370", "ONLINE", "370"], CR),
        ("dismiss banner", ["VM/370", "ONLINE", "370"], CR),
        ("at CP READ", ["CP READ", "VM/370"], f"LOGON {user}".encode() + CR),
        ("password prompt", ["PASSWORD", "password", "ENTER"], pw.encode() + CR),
        ("logged on", ["LOGON AT", "LOGMSG"], CR),
        # CLEAR BEFORE TYPING, NOT AFTER. The CMS logon ends in MORE..., where the
        # host silently EATS input -- documented in HANDOFF.md as what swallowed a
        # LOGOFF and left an account logged on. An earlier version of this flow sent
        # QUERY DISK A first and cleared afterwards, so the QUERY was eaten and the
        # step timed out on a screen that plainly read `MORE...`. The client was
        # transmitting correctly the whole time; the ORDER was wrong.
        ("CMS logon complete (MORE...)", ["MORE...", "Ready;"], CTRL_C),
        # Prove which machine is reading: `Ready;` means CMS, `?CP: QUERY` means we
        # are at CP READ on a reconnected session and the run is void.
        ("cleared, at a prompt", None, b"QUERY DISK A" + CR),
        ("QUERY answered by CMS", ["LABEL", "Ready;", "?CP", "NOT LOGGED"], CTRL_C),
        ("cleared again", None, b"LOGOFF" + CR),
        ("logged off", ["LOGOFF AT", "CONNECT=", "VM/370"], None),
    ]


FLOWS = {"tk5": ("127.0.0.1:3271", flow_tk5, "HERC01"),
         "vm": ("127.0.0.1:3270", flow_vm, "CMSUSER")}


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "tk5"
    if which not in FLOWS:
        print(f"usage: live-drive.py [{'|'.join(FLOWS)}]")
        return 2
    pw = os.environ.get("TN3270_PASSWORD")
    if not pw:
        print("set TN3270_PASSWORD")
        return 2
    target, flow_fn, default_user = FLOWS[which]
    user = os.environ.get("TN3270_USER", default_user)
    steps = flow_fn(pw, user)

    main_fd, child_fd = pty.openpty()
    fcntl.ioctl(child_fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    argv = ["node", os.path.join(REPO, "packages/tui/dist/main.js"),
            "-model", "3278-2-E", "--colors", "256", target]
    pid = os.fork()
    if pid == 0:
        os.setsid()
        for fd in (0, 1, 2):
            os.dup2(child_fd, fd)
        os.close(main_fd)
        os.close(child_fd)
        os.execvpe("node", argv, dict(os.environ, TERM="xterm-256color", COLORTERM=""))
        os._exit(127)
    os.close(child_fd)

    screen = AnsiScreen()
    everything = bytearray()
    transcript, step = [], 0
    step_started = time.time()
    STEP_TIMEOUT = 40
    panels = []

    def drain(seconds):
        """Read for a while, keeping the screen model current."""
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([main_fd], [], [], 0.3)
            if not r:
                continue
            try:
                c = os.read(main_fd, 65536)
            except OSError:
                return
            if not c:
                return
            everything.extend(c)
            screen.feed(c)

    while step < len(steps):
        label, wait_for, send = steps[step]

        # Loop Enter until TSO stops showing a more-output prompt.
        if wait_for == "DRAIN***":
            for attempt in range(8):
                drain(3.0)
                if "***" not in screen.text():
                    break
                os.write(main_fd, CR)
            transcript.append(
                f"  step {step + 1}/{len(steps)}: {label} -- drained after {attempt + 1} Enter(s)")
            panels.append((label, screen.text(), screen.colours()))
            step += 1
            step_started = time.time()
            continue

        # A step with no text to wait for: settle, then send.
        if wait_for is None:
            drain(3.5)
            transcript.append(f"  step {step + 1}/{len(steps)}: {label} -- settled")
            panels.append((label, screen.text(), screen.colours()))
            if send is not None:
                os.write(main_fd, send)
            step += 1
            step_started = time.time()
            time.sleep(1.5)
            continue

        r, _, _ = select.select([main_fd], [], [], 0.4)
        if r:
            try:
                chunk = os.read(main_fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            everything += chunk
            screen.feed(chunk)

        txt = screen.text()
        if any(w in txt for w in wait_for):
            hit = next(w for w in wait_for if w in txt)
            transcript.append(f"  step {step + 1}/{len(steps)}: {label} -- MATCHED on {hit!r}")
            panels.append((label, txt, screen.colours()))
            if send is not None:
                os.write(main_fd, send)
            step += 1
            step_started = time.time()
            time.sleep(1.5)
            continue

        if time.time() - step_started > STEP_TIMEOUT:
            transcript.append(f"  step {step + 1}/{len(steps)}: {label} -- TIMED OUT")
            panels.append((label + " (TIMEOUT)", txt, screen.colours()))
            break

    # BEST-EFFORT LOGOFF, even when the flow failed partway.
    #
    # Quitting the TUI does not log off, and an account left logged on is a trap on
    # both hosts -- MVS answers IKJ56425I ... IN USE and needs an operator to clear
    # it, VM reconnects at CP READ and voids the next run. The first version of this
    # script omitted this and stranded TWO TK5 userids in one session.
    #
    # Deliberately blunt, because it has to work from whatever screen we stalled on.
    #
    # PF3, NOT `X`. `X` is only valid typed AT the ISPF Option field; sent from
    # anywhere else ISPF answers "Enter END command to terminate ISPF" and stays put
    # -- which is exactly what stranded HERC03. PF3 IS the END command and works from
    # any ISPF panel. Then Clear, because at MORE... the host silently eats input and
    # would swallow the LOGOFF itself.
    #
    # ONLY ON FAILURE. When the flow ran to completion its own last step already
    # confirmed the logoff, and running the teardown anyway typed PF3/LOGOFF into
    # the post-logoff VTAM panel -- which disturbed the screen and made the CHECK
    # fail, so a fully successful run reported `logoff NOT confirmed`. That is worse
    # than useless: the accounts were genuinely free (verified independently), so the
    # flag was training the reader to ignore it.
    logged_off = False
    if step == len(steps):
        logged_off = True
        transcript.append("  teardown: not needed, the flow logged off itself")
    elif step >= 3:                          # got as far as sending a password
        for keys in (PF3, PF3, CR, CTRL_C, b"LOGOFF" + CR, CR):
            os.write(main_fd, keys)
            drain(2.5)
        txt = screen.text()
        logged_off = any(s in txt for s in ("LOGGED OFF", "LOGOFF AT", "Logon", "RUNNING", "VM/370"))
        transcript.append(f"  teardown: logoff {'CONFIRMED' if logged_off else 'NOT confirmed'}")
        panels.append(("after teardown", txt, screen.colours()))

    os.write(main_fd, CTRL_BRACKET)
    time.sleep(1.0)
    while True:
        r, _, _ = select.select([main_fd], [], [], 0.5)
        if not r:
            break
        try:
            c = os.read(main_fd, 65536)
        except OSError:
            break
        if not c:
            break
        everything += c
        screen.feed(c)
    time.sleep(0.3)
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass
    after = termios.tcgetattr(main_fd)

    with open(f"/tmp/live-{which}-raw.bin", "wb") as f:
        f.write(bytes(everything))
    with open(f"/tmp/live-{which}-panels.txt", "w") as f:
        for label, txt, cols in panels:
            f.write(f"===== {label} | colours={ {k: v for k, v in cols.items()} }\n{txt}\n\n")

    print(f"=== {which} as {user}: {step}/{len(steps)} steps matched")
    for line in transcript:
        print(line)
    last_cols = panels[-1][2] if panels else {}
    print(f"foreground codes on the last panel: { {k: v for k, v in sorted(last_cols.items(), key=lambda kv: -kv[1])} }")
    # A BLANK cell in reverse video renders as a solid block of the foreground
    # colour -- exactly the mottling this run is checking for.
    blocks = sum(1 for r in range(ROWS - 1) for c in range(COLS)
                 if screen.rev[r][c] and screen.grid[r][c] == " ")
    revtot = sum(1 for r in range(ROWS - 1) for c in range(COLS) if screen.rev[r][c])
    print(f"reverse-video cells: {revtot}, of which BLANK (solid blocks): {blocks}")
    print(f"unrecognised escape sequences: {screen.unknown}")
    print(f"left the alternate buffer: {b'\x1b[?1049l' in bytes(everything)}")
    print(f"ECHO restored after exit:  {bool(after[3] & termios.ECHO)}")
    print(f"logoff confirmed: {logged_off}")
    print(f"raw: /tmp/live-{which}-raw.bin ({len(everything)}B), panels: /tmp/live-{which}-panels.txt"
          f" -- BOTH MAY CONTAIN THE PASSWORD")
    return 0 if step == len(steps) else 1


if __name__ == "__main__":
    sys.exit(main())
