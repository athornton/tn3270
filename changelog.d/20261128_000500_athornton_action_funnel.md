### Bug fixes

- **A key the GUI cannot handle no longer freezes it.** Keys typed in the keypad and keyboard
  windows reach the main process unfiltered. One that the shared key handling refuses is now
  reported (`action dropped: KIND: reason`) and dropped. Before, it froze the app until killed.
