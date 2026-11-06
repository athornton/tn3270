# @tn3270/gui — the Electron client

An Electron TN3270 emulator with a canvas renderer that blits glyphs from an atlas baked
out of x3270's own 3270 bitmap font, at integer scale with antialiasing off.

```sh
npm install -g @tn3270/gui
```

**This needs Electron's binary, roughly 100 MB.** Electron 44 fetches it the first time
it is used rather than during `npm install`, so your first `tn3270-gui` prints "Downloading
Electron binary..." and takes a while: that is the download, not a hang. If it fails (no
network, a proxy, a wrong `ELECTRON_MIRROR`), `tn3270-gui` says so; fix the network and run
it again. There is no slimmer, native-only build yet; that is planned as a follow-up.

```sh
tn3270-gui -insecure -model 3278-4-E HOST:PORT
```

It takes the TUI's flags unchanged (`-model`, `--terminal-type`, `-oversize`, `-tn3270e
on|off`, the TLS set) because all three interactive front ends parse them with the same
code. See the root README's *Using the GUI* section
(https://github.com/athornton/tn3270#readme) for keys, the keypad, the keyboard window
and copy/paste.

Electron's own switches (`--no-sandbox`, `--disable-gpu`, ...) can be given on the same
command line; they go to Chromium, not to the TN3270 flag parser.

### Linux: the sandbox

`tn3270-gui` leaves Chromium's sandbox ON. npm cannot install Electron's `chrome-sandbox`
helper setuid root, but Chromium does not need it where unprivileged user namespaces are
allowed (most distributions), and runs sandboxed. Where they are blocked — Ubuntu 23.10 and
later, through AppArmor, and some hardened kernels — Electron aborts with *"The SUID sandbox
helper binary was found, but is not configured correctly"*, and `tn3270-gui` prints two
ways out:

- as root, make the helper what Chromium expects (keeps the sandbox):
  `chown root:root <path>/chrome-sandbox && chmod 4755 <path>/chrome-sandbox` — the path is
  in the message, under the global `node_modules/@tn3270/gui/node_modules/electron/dist/`;
- or run without the sandbox: `tn3270-gui --no-sandbox ...`. In normal use the app loads
  only its own bundled pages, but a sandbox is defence in depth against a
  renderer bug, and this switches it off. The launcher never does this for you.

### Displays and signals

It needs a display: on a headless Linux box, run it under `xvfb-run`. Without a GPU, add
`--disable-gpu`. SIGINT, SIGTERM and SIGHUP sent to `tn3270-gui` are forwarded to Electron,
and Electron is killed if the launcher exits first; a SIGKILL cannot be forwarded by
anything, so kill Electron's own PID if you need that. On Windows (not yet tested), stopping
the launcher terminates Electron outright.
