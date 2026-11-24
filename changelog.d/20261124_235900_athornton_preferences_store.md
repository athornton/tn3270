### New features

- Preferences. In the GUI, File → Save Changed Options (the app menu on macOS) saves the current
  settings, including a model chosen in the Model menu, to `preferences.json` in the app's data
  directory, and later launches start from them. In the TUI, `-save` writes the run's settings to
  `~/.config/tn3270/tui.json`. Flags on the command line still win. TLS weakenings
  (`-insecure`, `-noverifycert`), the host and `-devname` are never stored.

### Bug fixes

- The GUI's Connect dialog now starts with the model given by `-model` (or the preferences file)
  instead of always the built-in default.
