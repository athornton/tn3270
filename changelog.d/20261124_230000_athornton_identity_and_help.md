### New features

- `--help` (or `-?`) and `--version` (or `-v`) in the GUI, the TUI, the CLI and the web gateway,
  each as the lone argument, as x3270 has them. Each front end's usage now lists every flag it
  accepts, including `-charset`.
- The GUI's window title, and the web gateway's browser tab, name the host first, then the model:
  `vm.example:3270 [LU01] — TN3270 3278-2-E`, or `TN3270 — not connected`.
- Help → About TN3270 in the GUI (the app menu's About on macOS) shows the version, the
  configuration and the live connection status, with a Copy button.
