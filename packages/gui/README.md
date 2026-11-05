# @tn3270/gui — the Electron client

An Electron TN3270 emulator with a canvas renderer that blits glyphs from an atlas baked
out of x3270's own 3270 bitmap font, at integer scale with antialiasing off.

```sh
npm install -g @tn3270/gui
```

**This downloads Electron, roughly 100 MB, as part of install.** There is no slimmer,
native-only build yet; that is planned as a follow-up, not something this package does
today.

```sh
tn3270-gui -insecure -model 3278-4-E HOST:PORT
```

It takes the TUI's flags unchanged (`-model`, `--terminal-type`, `-oversize`, `-tn3270e
on|off`, the TLS set) because all three interactive front ends parse them with the same
code. See the root README's *Using the GUI* section
(https://github.com/athornton/tn3270#readme) for keys, the keypad, the keyboard window
and copy/paste.

**Note on this release:** the `tn3270-gui` launcher is a stub as of this version — the
real one ships in a follow-up. Running it prints a message and exits nonzero.
