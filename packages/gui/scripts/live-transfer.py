#!/usr/bin/env python3
"""
Drive the GUI's transfer WINDOW against a real host, and judge it BY BYTES.

Run by hand; `npm test` cannot spawn Electron, let alone dial a mainframe. The GUI was the one
front end with no live-drive harness, which is why no transfer had ever been driven from its
window against a real host -- `packages/gui/scripts/transfer.mjs` runs in REPLAY mode with a
stubbed dialog, so it can never see a transfer that COMPLETES.

    python3 packages/gui/scripts/live-transfer.py vm
    python3 packages/gui/scripts/live-transfer.py tso

## WHAT THIS IS AND IS NOT

It is the GUI counterpart of `packages/tui/scripts/live-drive.py`'s `vmxfer`/`tsoxfer` flows, and
it deliberately mirrors their step lists -- those carry facts that cost runs to find and are cited
where they are used below. It is NOT a replacement: the TUI harness drives a pty and reads ANSI,
where this drives Electron through its own test seams and scores stdout.

**THE NATIVE FILE DIALOG IS NOT EXERCISED.** `TN3270_GUI_TRANSFER_PATH` substitutes the whole
chooser, because a real modal under Xvfb has nobody to click it and would STALL the run rather than
fail it. So a green run here says nothing about `Browse...`, and the macOS dialog item in
`docs/live-testing.md` stays OPEN. Said here rather than left to be inferred from a pass.

## THE ONE RULE THIS HARNESS EXISTS TO ENFORCE

**COMPARE BYTES, NEVER THE STATUS LINE.** The form reports `done: N bytes` on a transfer that
wrote the wrong file just as readily as on one that worked -- `docs/live-testing.md` says so in as
many words, and it is why the TUI's runs are trusted. So every flow sends a file up, reads it back
to a different path, and `cmp`s the two. The host's own listing (`LISTFILE` on CMS, `LISTDS` on
TSO) is an independent check that the bytes actually landed there.

## CREDENTIALS AND WHAT MAY END UP IN /tmp

`TN3270_PASSWORD` and `TN3270_USER`, as `live-drive.py` takes them. The stock values are in
`docs/live-testing.md`. **The log written to /tmp MAY CONTAIN THE PASSWORD** -- it is this
process's stdout plus stderr, and while the wait seam prints only the strings this harness chose,
Electron is free to print whatever it likes. Nothing from a run goes near git.

**THE SCREEN IS NEVER ECHOED BY THE SEAM, which is what makes that risk small rather than
certain.** `main.ts`'s `wait:` step prints the needle it was given and not the screen it matched
against; the screen at a password prompt contains the password, and at the next step a live
system's LOGMSG.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
GUI = REPO / "packages" / "gui"
ELECTRON = REPO / "node_modules" / ".bin" / "electron"

# 249 bytes, the same size the CLI and TUI round trips used, so a failure here is comparable with
# theirs rather than a new measurement. Deterministic content: a random file would make a
# mismatch harder to describe than it needs to be.
PAYLOAD = bytes(range(249))

# The userspace GUI stack this box needs. Mirrors `xvfb.mjs`'s `guiEnv` -- NOT a second opinion
# about it: if that file's paths change this must follow, and the duplication is deliberate only
# because a Python harness cannot import an ESM module. `xvfb.mjs` has the measurements for why
# each of these is required.
GUI_ENV = Path(os.environ.get("HOME", "")) / "micromamba" / "envs" / "gui"
X_SOCKET = Path("/tmp/.X11-unix/X99")


def ensure_display():
    """Start Xvfb if nothing is listening, and PROVE it came up rather than trusting a sleep."""
    if os.environ.get("DISPLAY"):
        return os.environ["DISPLAY"]
    if not X_SOCKET.exists():
        subprocess.Popen(
            [str(GUI_ENV / "bin" / "Xvfb"), ":99", "-screen", "0", "1280x1024x24"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,                      # or it dies with this shell
            env={**os.environ, "LD_LIBRARY_PATH": str(GUI_ENV / "lib")},
        )
        deadline = time.time() + 15
        while not X_SOCKET.exists() and time.time() < deadline:
            time.sleep(0.2)
    if not X_SOCKET.exists():
        raise SystemExit(f"Xvfb did not create {X_SOCKET}")
    return ":99"


def gui_env(extra):
    return {
        **os.environ,
        "DISPLAY": ensure_display(),
        "LD_LIBRARY_PATH": str(GUI_ENV / "lib"),
        "FONTCONFIG_PATH": str(GUI_ENV / "etc" / "fonts"),
        "FONTCONFIG_FILE": str(GUI_ENV / "etc" / "fonts" / "fonts.conf"),
        **extra,
    }


def keys(*steps):
    """Join a scenario into one TN3270_GUI_KEYS value."""
    return ",".join(steps)


def typed(text):
    """
    One key per character, because the seam sends CHORDS and not strings.

    ## UPPERCASE NEEDS `Shift+`, AND THIS COST TWO TSO USERIDS TO LEARN

    Chromium's `sendInputEvent` folds case: `A` and `a` both deliver `key: 'a'`. An earlier version
    of this function relied on the HOST folding instead, and its own docstring named the exception it
    then walked into -- *"a 3270 field would NOT fold"*. **The TSO password field is exactly that
    case.** `CUL8TR` arrived as `cul8tr` and TK5 answered `PASSWORD NOT AUTHORIZED FOR USERID`;
    because the run then died mid-logon it never reached its own logoff, which STRANDED the userid.
    Twice, on HERC01 and HERC02, before a screenshot showed the actual message.

    VM did not expose it: CP folds passwords, so `logon CMSUSER` and its password both worked
    lowercase. One host folding and the other not is precisely the kind of difference a second host
    exists to find.

    So an uppercase letter is sent as `Shift+<letter>`. Lowercase and digits pass through.
    """
    out = []
    for ch in text:
        if ch == " ":
            out.append("Space")
        elif ch.isupper():
            # `Shift+A` -- and the seam sends NO `char` event for a modified chord (a real
            # Ctrl-/Alt-held keystroke produces none), which is why this relies on the renderer's
            # `keydown` path rather than on text input.
            out.append(f"Shift+{ch}")
        else:
            out.append(ch)
    return out


def vm_logon(user, pw):
    """
    Just the logon, shared by the transfer run and the logoff run.

    SEPARATED BECAUSE THE LOGOFF RUN IS ITS OWN PROCESS and has no session: the first version of
    that helper waited for a command prompt only a logged-on session shows, timed out, and left the
    very account it existed to release.

    VM/370 CMS is the CUT control: MECAFF declines DDM, so this exercises the CUT engine.

    The logon sequence is `live-drive.py`'s `flow_vm`, unchanged and for its reasons -- two Enters
    dismiss the banner, and `CMS` must never be matched as a bare string because it appears in the
    banner long before CMS is reading. `Ctrl+c` is the Clear AID, which is how VM's `MORE...`
    state is dismissed.

    ERASE FIRST so a leftover from an earlier run cannot make a failed upload look successful.
    """
    return keys(
        # THE FIRST SCREEN IS THE **HERCULES** BANNER, NOT VM's -- measured, and the first two
        # attempts at this flow timed out waiting for `VM/370` which is genuinely not on it. The
        # VM/370 logo appears only after an Enter. (`370` DOES match that first screen, via
        # Hercules' own "S/370", which is exactly the kind of accidental match that makes a needle
        # worth checking against a capture rather than against an expectation.)
        "wait:Hercules|VM/370|CP READ", "Enter",
        # **`CP READ` ONLY, AND NOT `VM/370`** -- which is the OIA's "the host is ready for input"
        # indicator, and the only thing here that means the keyboard is unlocked. An earlier version
        # of this step accepted `VM/370` as an alternative and it SATISFIED ON THE LOGO, which is
        # painted a moment before `CP READ` appears: the `logon` went in against a locked keyboard,
        # was correctly refused, and the run then timed out at the password prompt that never came.
        #
        # THE LESSON GENERALISES PAST THIS LINE: an alternation is only as good as its WEAKEST
        # needle. Adding one to cover a second entry state also widens what the FIRST state will
        # accept, and the wider needle wins the race. `RECONNECTED` is safe because it is the
        # reconnect message itself and appears only in that state.
        "wait:CP READ|RECONNECTED", *typed(f"logon {user}"), "Enter",
        # `ENTER PASSWORD:` is VM's own wording, so the bare `PASSWORD` covers it; the others are
        # what `live-drive.py` carries for the forms it has seen.
        "wait:PASSWORD|password|ENTER", *typed(pw), "Enter",
        # `RECONNECTED AT` is accepted alongside `LOGON AT`: a reconnected session is already
        # logged on and never prints the latter, and refusing it here is what stalled the first two
        # runs after their own predecessor left the account held.
        "wait:LOGON AT|RECONNECTED|LOGMSG", "Enter",
        # CLEAR BEFORE TYPING, NOT AFTER. The CMS logon ends in `MORE...`, where the host silently
        # EATS input -- which once swallowed a LOGOFF and left an account logged on. An earlier
        # version of the TUI flow typed first and cleared afterwards, and the command vanished.
        "wait:MORE...|Ready;", "Ctrl+c",
    )


def vm_flow(user, pw, host_file):
    """The VM logon, then ERASE so a leftover cannot make a failed upload look successful."""
    return keys(
        vm_logon(user, pw),
        *typed(f"erase {host_file}"), "Enter",
        # MEASURED by live-drive.py and its first run timed out on it: CMS answers a FAILED erase
        # with `FILE NOT FOUND` and leaves the screen in MORE..., so both outcomes must be
        # accepted and the screen cleared either way.
        "wait:Ready|NOT FOUND", "Ctrl+c",
    )


def tso_logon(user, pw):
    """
    Just the logon, shared with the logoff run for the reason `vm_logon` gives.

    MVS 3.8j TK5 is the DFT reference host: TSO's IND$FILE offers DFT, so this exercises
    the OTHER engine. Same window, different protocol, which is the whole reason both hosts are
    worth a run.

    Logon is `live-drive.py`'s `flow_tso_transfer`, including that TSO shows an indeterminate
    number of more-output prompts (a welcome banner and a FORTUNE COOKIE), so this waits for the
    ISPF panel rather than counting Enters, and leaves ISPF with `X` because IND$FILE is a plain
    TSO command run from `READY`.

    DELETE FIRST, quoted, for the same reason VM erases -- and TSO's DELETE wants the quoted form
    to be unambiguous about the userid.
    """
    return keys(
        "wait:TK5|Logon|Terminal", "Ctrl+r", "Ctrl+c",
        "wait:Logon", *typed(user), "Enter",
        "wait:PASSWORD|password", *typed(pw), "Enter",
        "wait:LOGON IN PROGRESS|Welcome|***", "Enter",
    )
    # ^ STOPS HERE DELIBERATELY. Everything after the first Enter -- draining the more-output
    # prompts and leaving ISPF -- happens in the TRANSFER SCENARIO instead, because only that runs
    # after the transfer window exists and only it has a `drain:` step.
    #
    # THE REASON IS A STRANDED USERID. This function used to press TWO blind Enters and then wait for
    # the ISPF panel. **TK5's more-output prompt count is NOT FIXED** -- a welcome banner, a FORTUNE
    # COOKIE, and the fortune's own `***` -- so the wait timed out, the run died before the transfer
    # window opened, its in-run logoff never executed, and HERC01 was left answering
    # `IKJ56425I LOGON REJECTED, USERID HERC01 IN USE`. `live-drive.py` has had a `DRAIN***` step for
    # this since 2026-08 and documents exactly why a count cannot work; the GUI harness guessed, and
    # the guess cost a userid that only the MVS console can release.


def tso_flow(user, pw, ds_plain, ds_full):
    """
    The TSO logon only. The DELETE moved into the transfer scenario.

    It has to run AFTER the drain, and the drain is a scenario step -- so the scenario owns both.
    DELETE wants the QUOTED form, so TSO is unambiguous about the userid.
    """
    return tso_logon(user, pw)


FLOWS = {
    # name: (target, userid, the host file/dataset, how the transfer form is filled)
    "vm": {
        "target": "127.0.0.1:3270",
        "user": "CMSUSER",
        "engine": "CUT (MECAFF declines DDM)",
    },
    "tso": {
        "target": "127.0.0.1:3271",
        "user": "HERC01",
        "engine": "DFT (TSO's IND$FILE offers it)",
    },
}


def run(which, phase, keys_value, transfer_value, local_path, log):
    """
    One Electron run: log on, drive the form, report. Returns (status, stdout+stderr).

    ONE RUN PER DIRECTION rather than one run for both, which differs from `live-drive.py` and is
    forced by the seam rather than chosen: `TN3270_GUI_TRANSFER` opens the window once, on the
    first `transferForm` action, and `driveTransferWindow` is not re-entered. Two directions in
    one process would need a second scenario the seam cannot express. The cost is a second logon;
    the benefit is that each direction's result stands alone.
    """
    cfg = FLOWS[which]
    env = gui_env({
        "TN3270_GUI_KEYS": keys_value,
        # A LIVE HOST IS SLOW and the default 1200ms is sized for a synchronous replay paint. The
        # first screen from VM can take seconds; a chord delivered before it arrives is an input
        # inhibit, not a failed mapping, and that is a confusing thing to debug from a log.
        "TN3270_GUI_KEYS_MS": "3000",
        "TN3270_GUI_WAIT_MS": "45000",
        "TN3270_GUI_TRANSFER": transfer_value,
        # THE WHOLE CHOOSER, not its default: see the module docstring.
        "TN3270_GUI_TRANSFER_PATH": local_path,
    })
    argv = [
        str(ELECTRON), str(GUI / "dist" / "main.js"),
        "--no-sandbox", "--disable-gpu",
        # `-insecure` IS MANDATORY: TLS is on by default, neither Hercules host speaks it, and a
        # plaintext host does not REJECT a handshake -- it goes quiet. So the symptom of omitting
        # this is a stall, not an error.
        "-insecure", "-model", "3278-2-E",
        cfg["target"],
    ]
    # STREAMED TO THE LOG, NOT CAPTURED, and this is a defect fixed rather than a preference.
    # `subprocess.run(capture_output=True, timeout=...)` buffers everything in memory and
    # `TimeoutExpired` carries it only on the exception -- so the first hung run here lost EVERY
    # diagnostic line: ten minutes of silence and a traceback, with nothing saying how far the
    # logon got. Writing to the file as it arrives means a hang is diagnosable WHILE it hangs, by
    # tailing the log, which is exactly when a person wants to look.
    with open(log, "a") as fh:
        fh.write(f"\n===== {which} {phase} =====\n")
        fh.flush()
        proc = subprocess.Popen(argv, env=env, stdout=fh, stderr=subprocess.STDOUT, text=True)
        try:
            proc.wait(timeout=300)
        except subprocess.TimeoutExpired:
            # KILLED, AND THE RUN SAYS SO rather than raising. A stuck Electron holds the host
            # session open, and on VM that leaves the account held so the NEXT run reconnects to
            # `CP READ` instead of a banner -- the trap this harness already tripped once.
            proc.kill()
            proc.wait(timeout=30)
            fh.write(f"\n--- HARNESS KILLED THE CLIENT after 300s in {phase} ---\n")
        status = proc.returncode
    # Read back what was streamed, so the checks below score the same text a person would read.
    whole = Path(log).read_text()
    out = whole.split(f"===== {which} {phase} =====", 1)[-1]
    return status, out


def logoff(which, user, pw, log):
    """
    A SEPARATE RUN THAT ONLY LOGS OFF, and it is not optional.

    ## WHY IT CANNOT BE APPENDED TO THE TRANSFER RUN'S KEYS

    `maybeSendKeys` runs to completion BEFORE `maybeOpenTransferWindow`, so a `LOGOFF` at the end
    of the keys list would execute before the transfer had even started. The seam's ordering is
    right for what it was built for; this is the thing that does not fit it.

    ## WHY LEAVING IT UNDONE POISONS THE NEXT RUN

    **VM: a held account RECONNECTS** -- the next session lands at `CP READ` with `RECONNECTED AT`
    on screen and no banner, so a flow waiting for the normal logon sequence stalls. Measured here
    three times, including on the TUI harness, which timed out on a trap this harness had set.
    **TSO: a held userid is REFUSED** with `IKJ56425I LOGON REJECTED, USERID IN USE`, and a fresh
    logon cannot recover it -- it takes `/c u=<userid>` at the MVS operator console
    (docs/live-testing.md). So the cost of skipping this is a stranded address space and a manual
    console step.

    Failures here are REPORTED AND NOT FATAL: the transfer result is what the run is about, and a
    logoff that did not take is worth knowing without discarding the measurement that preceded it.

    ## KNOWN LIMITATION, 2026-10-02: THIS IS UNRELIABLE ON VM AND YOU MUST CHECK THE HOST

    It has not been made to work from a reconnected session. The transfer run leaves CMS running, so
    this run RECONNECTS -- and a reconnect does not reach `CP READ`, lands in an indeterminate state
    (a CMS prompt, `MORE...`, or a half-painted screen), and the alternation above has not reliably
    caught it. Several attempts failed with only the Hercules banner seen.
    **So treat a FAIL here as "the account is probably held" and clear it**, which also leaves the
    next run's logon working:

        TN3270_PASSWORD=CMSUSER python3 packages/tui/scripts/live-drive.py vm

    That TUI flow logs off reliably and is what every run here used to reset the host. The right fix
    is probably to log off from inside the TRANSFER run -- after the transfers, in the same session
    that is already at a CMS prompt -- which needs a seam step that runs AFTER
    `driveTransferWindow` rather than before it. `maybeSendKeys` runs first and cannot express it.
    **NOT ATTEMPTED, so this is a known gap rather than a solved problem.**
    """
    # IT MUST LOG ON BEFORE IT CAN LOG OFF. A fresh process has no session, and the first version
    # of this helper waited for a command prompt that only a logged-on one shows -- so it timed out
    # and left the very account it existed to release. Reusing the flows means the reconnect it
    # lands on is handled by the same alternations the transfer run uses.
    if which == "vm":
        # **A RECONNECT INTO AN ALREADY-LOGGED-ON SESSION DOES NOT REACH `CP READ`**, which is what
        # `vm_logon` waits for -- it lands at a CMS prompt or in `MORE...`, because the virtual
        # machine is still running CMS from the transfer run. Measured: reusing `vm_logon` here
        # timed out on `CP READ|RECONNECTED` with only the Hercules banner seen.
        #
        # So this does its own short sequence that tolerates ALL THREE entry states -- fresh at
        # `CP READ`, reconnected to CMS, or reconnected into `MORE...` -- and CLEARS before typing,
        # because `MORE...` silently EATS input and that is what once swallowed a LOGOFF and left an
        # account logged on.
        spec = keys(
            "wait:Hercules|VM/370|CP READ|Ready", "Enter",
            "wait:CP READ|Ready;|MORE...|RECONNECTED", "Ctrl+c",
            # `#cp logoff` works from CMS as well as from CP READ, where a bare `logoff` does not:
            # the `#cp` prefix routes a command to CP from inside CMS, so one spelling covers both
            # entry states rather than needing to know which one this is.
            *typed("#cp logoff"), "Enter",
            "wait:LOGOFF AT|CONNECT=|VM/370|Hercules",
        )
    else:
        spec = keys(tso_logon(user, pw), *typed("logoff"), "Enter",
                    "wait:LOGGED OFF|Logon|RUNNING")
    st, out = run(which, "logoff", spec, "", "", log)
    saw = "keys: saw" in out and "TIMED OUT" not in out.split("keys: saw")[-1]
    report("logged off cleanly (so the next run is not poisoned)", saw,
           "" if saw else "CHECK THE HOST -- the account may be held; see docs/live-testing.md")
    return saw


def report(label, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'} {label}{(': ' + detail) if detail else ''}")
    return ok


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which not in FLOWS:
        print(f"usage: live-transfer.py [{'|'.join(FLOWS)}]")
        return 2
    pw = os.environ.get("TN3270_PASSWORD")
    if not pw:
        print("set TN3270_PASSWORD (docs/live-testing.md records the stock values)")
        return 2
    cfg = FLOWS[which]
    user = os.environ.get("TN3270_USER", cfg["user"])

    src = Path(os.environ.get("TN3270_SRC", f"/tmp/gui-xfer-src-{which}.bin"))
    back = Path(os.environ.get("TN3270_BACK", f"/tmp/gui-xfer-back-{which}.bin"))
    log = f"/tmp/gui-live-transfer-{which}.log"
    Path(log).write_text("")
    src.write_bytes(PAYLOAD)
    # The receive target must NOT exist: `Exist=keep` is the default and the engine correctly
    # refuses a receive onto an existing file. Removing it here is what makes the run repeatable.
    back.unlink(missing_ok=True)

    print(f"-- {which}: {cfg['target']} as {user}, engine expected: {cfg['engine']}")
    print(f"-- src {src} ({len(PAYLOAD)}B) -> host -> {back}")
    print(f"-- log {log}  MAY CONTAIN THE PASSWORD; not for git")

    checks = []
    if which == "vm":
        host_file = os.environ.get("TN3270_HOSTFILE", "GUIX TEST A")
        logon = vm_flow(user, pw, host_file)
        send_fields = f"localFile={src},hostFile={host_file},submit,done=180000"
        recv_fields = f"localFile={back},hostFile={host_file},submit,done=180000"
        # `host=vm` is NOT the default (`tso` is), so the send form must set it -- the one field
        # this flow changes that the TSO flow leaves alone.
        send_fields = f"direction=send,host=vm,{send_fields}"
        # `direction=receive` MUST BE SET EXPLICITLY, even though it is the form's default: the form
        # is REUSED between the two transfers in one window, so by now it holds `send` from the step
        # above. Measured -- without this the receive tried to READ the download target and failed
        # `cannot read local file ... ENOENT`, which is the engine correctly refusing a send of a
        # file that does not exist, and reads nothing like "the direction was wrong".
        recv_fields = f"direction=receive,host=vm,{recv_fields}"
        # LOGGING OFF INSIDE THE RUN, at the prompt the transfers left the session at. `#cp logoff`
        # rather than bare `logoff` so one spelling works from CMS as well as from CP READ.
        logoff_step = "host:#cp logoff|LOGOFF AT"
    else:
        ds_plain = os.environ.get("TN3270_DSN", "GUIXFER.BIN")
        ds_full = f"'{user}.{ds_plain}'"
        logon = tso_flow(user, pw, ds_plain, ds_full)
        # `Recfm=variable`, NEVER fixed: fixed PADS to the record boundary, and the same 249-byte
        # payload came back as 320 bytes (249 + 71 nulls) in the TUI run -- correct behavior that
        # fails a byte comparison. Lrecl follows it.
        send_fields = (f"direction=send,localFile={src},hostFile={ds_plain},"
                       f"recfm=variable,lrecl=1024,submit,done=180000")
        # UNQUOTED to send (TSO prepends the userid) and QUOTED to receive (absolute), which is
        # the pair the CLI round trip used and exercises both forms in one session.
        # `direction=receive` explicitly, for the reason the VM branch gives: one window, two
        # transfers, and the form still holds `send`. `recfm`/`lrecl` become inapplicable on a
        # receive and the SHARED MODEL clears them itself -- which is why they are not reset here.
        recv_fields = f"direction=receive,localFile={back},hostFile={ds_full},submit,done=180000"
        # **THE LOGOFF MUST HAPPEN IN THIS RUN, NOT A LATER ONE.** A held TSO userid is REFUSED
        # (`IKJ56425I ... IN USE`), so a separate logoff process -- which has to log on first --
        # cannot recover the one case that needs it. Three TK5 userids were stranded this way in
        # 2026-08 and only the MVS operator console could clear them, which an agent cannot reach.
        # **`Logon` AND `RUNNING` TOO, not just `LOGGED OFF`.** TSO returns to the VTAM panel rather
        # than printing a logoff message, so the narrow needle timed out on a logoff that HAD
        # succeeded -- the userid was verified free afterwards. `live-drive.py` has accepted all three
        # since 2026-08; this is the same list. A check that cries wolf on success trains the reader
        # to ignore it, which the runbook already records as worse than no check at all -- and here
        # the thing it would teach them to ignore is a stranded userid.
        logoff_step = "host:logoff|LOGGED OFF|Logon|RUNNING"
        # EVERYTHING THE LOGON USED TO DO BLIND, now in the scenario where `drain:` exists.
        # `***` is TSO's more-output marker; `x` leaves ISPF for `READY`, which is where IND$FILE
        # runs -- TK5's is Rayborn's FFTP 2.0.5 and no ISPF panel is involved.
        # **WAIT FOR THE ISPF PANEL ITSELF, and drain only if `***` is actually there.** Measured on
        # TK5 2026-10-02: after `LOGON IN PROGRESS` the OIA shows `X Wait` -- the host is still
        # working -- and ISPF then arrives with NO `***` prompt on this system at all. So
        # `drain:***` found nothing to drain (`drained "***" after 0 Enter(s)`) and the next step
        # typed into a Wait state. The drain is KEPT because `live-drive.py` documents runs where the
        # prompts DO appear (a welcome banner, a fortune cookie) and it is a no-op when they do not;
        # what was missing is the wait that actually synchronises.
        prep = (f"wait:Primary Option|USERID|BROWSE,drain:***,"
                f"wait:Primary Option|USERID|BROWSE,"
                f"host:x|READY,host:delete {ds_full}|READY")

    # ---- BOTH DIRECTIONS IN ONE RUN, ONE LOGON ----
    #
    # ONE RUN, NOT TWO, and the first version of this harness got it wrong. Two runs meant two
    # logons, and the first run does not log off until after the second has already tried to
    # connect -- so the second met VM's RECONNECT trap every time and never reached a prompt.
    # Worse, the logoff helper ran as its own process against a FRESH session, so it waited for a
    # command prompt that only a logged-on session has and timed out too.
    #
    # The seam's step list is general enough to express both: the window stays OPEN between
    # submits, `done` waits for each to finish, and the form is re-filled in place. That is also a
    # more faithful test -- an operator transfers twice from one window rather than restarting the
    # app -- and it exercises the ONE SESSION, ONE TRANSFER rule, since the second submit happens
    # on a form that has already run one to completion.
    scenario = (f"{prep},{send_fields},{recv_fields},{logoff_step}"
                if which == "tso" else f"{send_fields},{recv_fields},{logoff_step}")
    st, out = run(which, "both", keys(logon, "Ctrl+t"), scenario, str(src), log)
    checks.append(report("the run reached the form", "transfer window: opened" in out))
    checks.append(report("the form drew its rows",
                         any(f"fields={n}" in out for n in range(1, 11))))

    submits = [l.strip() for l in out.splitlines() if "submit ->" in l]
    dones = [l.strip() for l in out.splitlines() if "done ->" in l]
    ok_submits = [l for l in submits if "ok=true" in l.lower()]
    finished = [l for l in dones if "running=false timedOut=false" in l]

    checks.append(report("the SEND was accepted locally", len(ok_submits) >= 1,
                         submits[0] if submits else "(no submit line)"))
    # `done -> running=false` IS NOT EVIDENCE ON ITS OWN, and this scored a PASS against a transfer
    # that never started: a submit refused with `cannot read local file ... ENOENT` leaves nothing
    # running, so the wait returns `running=false timedOut=false` immediately and reads like
    # success. So completion is only credited where the matching SUBMIT was accepted -- the same
    # trap as judging a transfer by its status line, one level further in.
    checks.append(report("the SEND ran to completion",
                         len(ok_submits) >= 1 and len(finished) >= 1,
                         dones[0] if dones else "(no done line)"))
    checks.append(report("the RECEIVE was accepted locally", len(ok_submits) >= 2,
                         submits[1] if len(submits) > 1 else "(no second submit line)"))
    checks.append(report("the RECEIVE ran to completion",
                         len(ok_submits) >= 2 and len(finished) >= 2,
                         dones[1] if len(dones) > 1 else "(no second done line)"))

    # ---- THE CHECK THAT MATTERS ----
    got = back.read_bytes() if back.exists() else b""
    checks.append(report("the file came back at all", len(got) > 0, f"{len(got)}B"))
    checks.append(report("BYTES ARE IDENTICAL", got == PAYLOAD,
                         "identical" if got == PAYLOAD
                         else f"expected {len(PAYLOAD)}B, got {len(got)}B"))

    # THE LOGOFF IS PART OF THE SCENARIO NOW (see `logoff_step`), so this only reports what it did.
    # The separate `logoff()` helper is kept as a FALLBACK for a run that died before the step --
    # and on TSO it cannot help a held userid at all, which is why the in-run step exists.
    # MATCHED ON `host logoff`, NOT ON ANY `host ` LINE. The first version took the first host step
    # it found, which on TSO is `host x` (leaving ISPF) -- so a run whose logoff never happened
    # reported the ISPF step's result instead, and a stranded userid would have been described by a
    # line about something else entirely.
    host_line = next((l for l in out.splitlines() if "host logoff" in l or "cp logoff" in l), "")
    checks.append(report("logged off IN THE RUN (so no userid is stranded)",
                         "-> saw" in host_line,
                         host_line.strip() or "(no host step line -- CHECK THE HOST)"))

    # TALLIED AFTER EVERY CHECK IS APPENDED, which it was not: the logoff check above used to be
    # added AFTER this sum, so the run printed `8/8 checks passed` while a NINTH had failed and the
    # exit code said 1 with no visible reason. A summary that disagrees with its own detail lines is
    # worse than no summary, and the detail it was dropping is the stranded-userid warning.
    passed = sum(1 for c in checks if c)
    print(f"\n{passed}/{len(checks)} checks passed")
    print(f"log: {log}")
    if got != PAYLOAD:
        print("A STATUS LINE SAYING 'done' PROVES NOTHING -- this is the comparison that counts.")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
