### Bug fixes

- A file transfer the host never starts (for example TSO's `IND$FILE` ending `RC=12`, or MECAFF's
  `IND$FILE requires a MECAFF connected 3270 terminal`) now fails with x3270's wording,
  `transfer did not start within 30s`, and quotes up to five rows the host wrote after the command
  (the rest are counted), so the host's own reason is in the message. It used to say the host "may
  still be transferring" or "may still be in transfer mode", which was false: no transfer had
  started. `press Attn or Clear` now leads only while the keyboard is still
  locked. The wait is still 30 s, as in x3270. This applies in the CLI, TUI, GUI and web gateway.
