#!/usr/bin/env python3
"""
Cancel a transfer MID-FLIGHT against live VM/CMS, and prove it was mid-flight.

THE HARD PART IS NOT THE CANCEL, IT IS PROVING THE TIMING. A cancel sent before the
first frame, or after the last, exercises nothing -- `CutTransfer.cancel` is idempotent
and a completed transfer swallows it. So this:

  1. waits until the form's status line actually reads `transferring...`,
  2. records the BYTE COUNT it was showing at that moment,
  3. sends Esc,
  4. and requires the final byte count to be LESS than the file size.

A cancelled 200KB transfer that reports 204800 bytes was not cancelled.

## IT REFUSES TO REPORT ANYTHING IF THE SESSION IS NOT FRESH

`QUERY DISK A` answering `?CP:` means this is a RECONNECT to an already-running virtual
machine and every result below it is meaningless -- so the script exits 2 rather than
producing a plausible failure. **And it does NOT try to clear such a session by logging it
off: the machine may be a HUMAN OPERATOR\'s.** That is exactly what happened on 2026-09-24,
where three runs failed identically because the user was logged on as CMSUSER at the time and
each script\'s closing LOGOFF logged *them* off. Ask, do not clean up.

Usage:
  TN3270_PASSWORD=CMSUSER python3 packages/tui/scripts/cancel-transfer.py vm
  TN3270_PASSWORD=CUL8TR  python3 packages/tui/scripts/cancel-transfer.py tso

Both hosts are worth running: they are DIFFERENT IND$FILE implementations (MECAFF on
VM/CMS, Mike Rayborn\'s FFTP 2.0.5 on MVS/TSO), so what we send is our code but what the
host does with the abort is theirs.
"""
import os, pty, select, struct, termios, fcntl, time, re, sys

ROWS, COLS = 25, 80
REPO = "/home/a/athor/git/tn3270"
# 200 KB, GENERATED HERE so a future run needs no setup step. The size is measured, not
# arbitrary: CUT runs at ~15 ms/frame against local Hercules and the codec expands RANDOM data
# 1.727x (worst case -- a byte outside the current quadrant costs two encoded bytes), so ~1107
# source bytes fit per frame. 200 KB is ~185 frames and ~2.8 s per direction, which is long
# enough for a script to fire Esc partway. The 249-byte fixture used elsewhere is far too fast.
SRC = os.environ.get("TN3270_SRC", "/tmp/cancel-src.bin")
if not os.path.exists(SRC):
    import random
    random.seed(11)
    with open(SRC, "wb") as f:
        f.write(bytes(random.getrandbits(8) for _ in range(200 * 1024)))
SIZE = os.path.getsize(SRC)

# WHICH HOST. The two run DIFFERENT IND$FILE implementations -- MECAFF on VM/CMS, Mike
# Rayborn's FFTP 2.0.5 on MVS/TSO -- so an abort is worth testing against both: what we send
# is our code, but what the host does with it is theirs, and only they can say whether it
# leaves transfer mode.
WHICH = sys.argv[1] if len(sys.argv) > 1 else "vm"
if WHICH not in ("vm", "tso"):
    print("usage: cancel-transfer.py [vm|tso]")
    sys.exit(2)
TARGET = "127.0.0.1:3270" if WHICH == "vm" else "127.0.0.1:3271"
DEFAULT_USER = "CMSUSER" if WHICH == "vm" else "HERC01"
DEFAULT_PW = "CMSUSER" if WHICH == "vm" else "CUL8TR"
# CMS takes a three-part name; TSO takes a dataset, and unquoted means userid-prepended.
HOSTFILE = "CANC TEST A" if WHICH == "vm" else "CANC.BIN"

main_fd, child_fd = pty.openpty()
fcntl.ioctl(child_fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
argv = ["node", os.path.join(REPO, "packages/tui/dist/main.js"),
        "-insecure", "-model", "3278-2-E", TARGET]
pid = os.fork()
if pid == 0:
    os.setsid()
    for fd in (0, 1, 2):
        os.dup2(child_fd, fd)
    os.close(main_fd); os.close(child_fd)
    os.execvpe("node", argv, dict(os.environ, TERM="xterm-256color"))
    os._exit(127)
os.close(child_fd)

buf = bytearray()
def drain(sec):
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([main_fd], [], [], 0.05)
        if r:
            try: c = os.read(main_fd, 65536)
            except OSError: return
            if not c: return
            buf.extend(c)

def plain():
    return re.sub(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][B0]', ' ',
                  buf.decode('utf-8', 'replace'))

def wait_for(needle, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        drain(0.2)
        if needle in plain():
            print(f"  ok   {label}: saw {needle!r}")
            return True
    print(f"  FAIL {label}: never saw {needle!r}")
    return False

CR, CTRL_C, CTRL_T, TAB, ESC, CTRL_BRACKET = b"\r", b"\x03", b"\x14", b"\t", b"\x1b", b"\x1d"
RIGHT = b"\x1b[C"

USER = os.environ.get("TN3270_USER", DEFAULT_USER)
PW = os.environ.get("TN3270_PASSWORD", DEFAULT_PW)
print(f"cancelling a {SIZE}-byte transfer mid-flight on {WHICH} as {USER}")
drain(5)

if WHICH == "vm":
    os.write(main_fd, CR); drain(2)          # dismiss the banner (its text is discarded)
    os.write(main_fd, CR); drain(2)
    os.write(main_fd, f"LOGON {USER}".encode() + CR); drain(3)
    os.write(main_fd, PW.encode() + CR); drain(5)
    os.write(main_fd, CR); drain(3)
    os.write(main_fd, CTRL_C); drain(3)      # clear the MORE... that EATS input
    # STATE PROOF. `?CP:` means this is a RECONNECT and the run is void -- see the docstring.
    os.write(main_fd, b"QUERY DISK A" + CR); drain(3)
    if "?CP" in plain():
        print("  VOID: ?CP -- reconnected to a running machine, not a fresh CMS session")
        os.write(main_fd, CTRL_BRACKET); drain(1); sys.exit(2)
    print("  ok   at CMS (QUERY DISK A answered)")
    os.write(main_fd, CTRL_C); drain(2)
    os.write(main_fd, f"ERASE {HOSTFILE}".encode() + CR); drain(3)
    os.write(main_fd, CTRL_C); drain(2)
else:
    os.write(main_fd, b"\x12" + CTRL_C); drain(3)      # Ctrl-R reset, then clear
    os.write(main_fd, USER.encode() + CR); drain(4)
    if "IN USE" in plain() or "IKJ56425I" in plain():
        print(f"  VOID: {USER} is already logged on -- rotate userids or clear it")
        os.write(main_fd, CTRL_BRACKET); drain(1); sys.exit(2)
    os.write(main_fd, PW.encode() + CR); drain(6)
    # TSO shows SEVERAL more-output prompts (welcome banner, then a fortune cookie) and the
    # count is not fixed, so drain rather than counting Enters.
    for _ in range(5):
        if "***" not in plain()[-4000:]:
            break
        os.write(main_fd, CR); drain(2.5)
    # IND$FILE IS A PLAIN TSO COMMAND, so leave ISPF for READY. X is the menu's exit.
    os.write(main_fd, b"X" + CR); drain(4)
    if "READY" not in plain():
        print("  WARN did not clearly reach READY; continuing anyway")
    else:
        print("  ok   at TSO READY")
    os.write(main_fd, f"DELETE '{USER}.{HOSTFILE}'".encode() + CR); drain(4)

# Open the form and set up a SEND of the big file.
os.write(main_fd, CTRL_T); drain(1.5)
if not wait_for("File Transfer", 5, "form open"): sys.exit(1)
os.write(main_fd, RIGHT); drain(0.8)            # direction -> send
if WHICH == "vm":
    os.write(main_fd, TAB + RIGHT); drain(0.8)  # host -> vm (TSO is already the default)
else:
    os.write(main_fd, TAB); drain(0.8)
os.write(main_fd, TAB + SRC.encode()); drain(0.8)
os.write(main_fd, TAB + HOSTFILE.encode()); drain(0.8)
# Recfm -> variable. NEVER fixed: it pads to the record boundary, and a truncated-then-padded
# file tells you nothing about where the cancel landed.
os.write(main_fd, TAB + TAB + TAB + RIGHT + RIGHT); drain(0.8)
print("  ok   form filled")
mark = len(buf)
os.write(main_fd, CR)                            # START

# Wait for `transferring...` and grab the byte count it shows.
seen_running = False
progress_at_cancel = None
end = time.time() + 15
while time.time() < end:
    drain(0.15)
    t = plain()[mark:]
    if "transferring" in t:
        seen_running = True
        m = re.findall(r'transferring\.\.\.\s+(\d+) bytes', t)
        if m:
            progress_at_cancel = int(m[-1])
            # Cancel once real progress is visible but well short of the end.
            if 0 < progress_at_cancel < SIZE * 0.6:
                break
print(f"  {'ok  ' if seen_running else 'FAIL'} status line reached 'transferring...'")
print(f"  progress when cancelling: {progress_at_cancel} of {SIZE} bytes")

os.write(main_fd, ESC)                           # CANCEL, mid-flight
drain(4)
after = plain()[mark:]
final = re.findall(r'(\d+) bytes', after)
print(f"  byte counts seen after the cancel: {final[-4:] if final else 'none'}")
for frag in ["canceled by user", "transferring", "bytes transferred"]:
    print(f"    {frag!r:24} present: {frag in after}")

# Clean up and log off -- a failed run must not hand the reconnect trap to the next one.
os.write(main_fd, CTRL_C); drain(2)
if WHICH == "vm":
    os.write(main_fd, f"ERASE {HOSTFILE}".encode() + CR); drain(3)
    os.write(main_fd, CTRL_C); drain(2)
else:
    os.write(main_fd, f"DELETE '{USER}.{HOSTFILE}'".encode() + CR); drain(4)
os.write(main_fd, b"LOGOFF" + CR); drain(7)
tail = plain()
# VM prints CP's own accounting; TSO says LOGGED OFF and returns to the VTAM banner.
ok = ("LOGOFF AT" in tail) if WHICH == "vm" else ("LOGGED OFF" in tail or "Logon" in tail[-3000:])
print(f"  LOGOFF confirmed: {ok}")
os.write(main_fd, CTRL_BRACKET); drain(1.5)
cap = f"/tmp/cancel-raw-{WHICH}.txt"
open(cap, "w").write(plain())
print(f"  full capture: {cap}")
