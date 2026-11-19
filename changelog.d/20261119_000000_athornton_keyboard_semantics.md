### Bug fixes

- The keyboard now follows x3270's lock rules in every front end. Keys pressed while the host
  holds the keyboard (after Enter, before the first screen) are queued and run when it unlocks,
  shown by a `T` in the status line; Reset with keys queued discards them first. An operator
  error (`X Protected`, `X Numeric`, `X Overflow`) locks the keyboard: further keys are dropped
  with the bell until Reset or a cursor move (Tab, BackTab, Home, the arrows, EraseEOF,
  EraseInput) clears it. Keys pressed during a file transfer are dropped.
- Insert mode ends on every AID, on Reset and when the host restores the keyboard, and an insert
  uses any NUL after the cursor in the field. The keypad's Ins button sets insert mode on.
- Backspace closes up the field (x3270's Erase) instead of leaving a gap; Delete and EraseEOF
  work on an unformatted screen.
- A letter typed in a numeric field is accepted, as x3270 does by default (`numericLock` off).
- Attn sends Telnet IP on a bound TN3270E session, and shows `X -f` on an unbound one, as
  x3270 does; a classic session still gets BREAK.

### Other changes

- **CLI, incompatible:** `BackSpace()` now only moves the cursor left, as s3270's does; the new
  `Erase()` is the destructive form. `Insert()` sets insert mode on; the new `ToggleInsert()`
  toggles. Enter, Clear, PF, PA, Attn and SysReq no longer fail on a locked or disconnected
  session; as in s3270 they are queued or dropped.
