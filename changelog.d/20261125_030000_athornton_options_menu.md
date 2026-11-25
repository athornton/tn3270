### Bug fixes

- **A mono (3278) session now draws intensified fields bold**, as x3270 does. Every mono cell is
  green, so before this an intensified field looked exactly like a normal one.

### New features

- The GUI has an **Options** menu, as x3270's: **Color Scheme** (switching live), **Color Mode**
  (3279 color or 3278 mono, at the next connect), **Highlight Bold** and **Fixed Cursor Color**,
  all saved by Save Changed Options.
- `-highlightbold` draws intensified fields bold in 3279 mode, in the GUI, the TUI (SGR bold) and
  the web gateway; `-cursorcolor` draws the cursor red, in the GUI and the web gateway. Both are
  saved by the GUI's preferences, and `-highlightbold` by the TUI's.
