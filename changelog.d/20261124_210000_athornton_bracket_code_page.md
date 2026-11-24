### Bug fixes

- The default host code page is now x3270's `bracket`, so `[` and `]` are sent and shown as
  EBCDIC 0xAD and 0xBD, as x3270 does, rather than cp037's 0xBA and 0xBB. A host that shows Ý
  and ¨ where you typed brackets expects cp037: use `-codepage cp037`.

### New features

- `-codepage NAME` (alias `-charset`) chooses the host code page in the GUI, the TUI, the web
  gateway and the CLI: `bracket` (the default) or `cp037`, with x3270's aliases for them
  (`oldibm`, `37`, `us`, and so on). An unknown name is refused at startup.
