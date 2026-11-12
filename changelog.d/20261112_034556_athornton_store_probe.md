### Bug fixes

- The GUI's replay and screenshot test seams (`TN3270_GUI_REPLAY`, `TN3270_GUI_SHOT`) now exit 1
  with a one-line message when the trace cannot be read or the shot cannot be written, instead of
  hanging with the window open.
- `scripts/package-smoke.mjs` no longer idles about two minutes after its last check before
  exiting.

### Other changes

- CI builds and launches sandboxed Mac App Store and MSIX stand-ins of the GUI on every run, so a
  change that breaks under either store's confinement fails its own run. Nothing is submitted or
  uploaded.
