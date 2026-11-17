### Bug fixes

- The packaged GUI app (the macOS app, the Windows installer, the AppImage and the `.deb`) no
  longer ignores its first command-line argument: `TN3270 host` connects to `host` instead of
  opening the Connect dialog, and `TN3270 -model 3278-4-E host` no longer fails with "more than
  one host given". Launching from npm (`tn3270-gui`) was not affected.
- `Ctrl-]` quits only when one of TN3270's own windows has focus. It was registered as a
  system-wide shortcut, so typing `Ctrl-]` in any other application (telnet's escape key, for
  one) quit TN3270. It now follows the same rule as the terminal window always has: Control with
  the `]` key, so on a layout where `]` needs AltGr (German, French) it does not quit; use the
  window's close button or the menu instead.
