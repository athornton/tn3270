### New features

- `-visualbell` (the same flag in the GUI, the TUI and the browser) rings the host's alarm as a
  flash instead of a sound: ~100 ms inverted in the GUI and the browser, DECSCNM reverse video in
  the TUI.

### Bug fixes

- Blink and intensify are now drawn in the GUI and the browser, as x3270 draws them: a blinking
  cell's glyph is hidden while its 500 ms off phase is current, and an intensified cell's glyph is
  overstruck one source pixel to the right. The TUI already drew both, through SGR 5 and SGR 1.
- The host's alarm now rings in every front end: the GUI's system beep (`shell.beep()`), a short
  WebAudio tone in the browser, and BEL in the TUI.
