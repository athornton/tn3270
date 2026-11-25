### Bug fixes

- **The model's 3278/3279 prefix is now the color mode, as in x3270.** `-model 3279-N` (or a bare
  `N`) is a color 3279, and `-model 3278-N` is a mono 3278 drawn in green. **An explicit `3278-`
  model used to draw in color, and now draws mono**: use `3279-N` for color. The first `3278-`
  model in a run prints a notice saying so. The default is now `3279-2-E`.
- A color model 2 or 3 is advertised as `IBM-3279-N`, as x3270 does, instead of always
  `IBM-3278-N`. Checked live against MVS 3.8j TSO and VM/370.

### New features

- `-mono` makes any model a mono 3278, in the GUI, the TUI, the CLI and the web gateway, and is
  saved by the GUI's and TUI's preferences.
