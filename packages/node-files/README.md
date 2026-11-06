# @tn3270/node-files

Internal to the tn3270 client: Node-specific file and process helpers (such as detecting
whether a module is running as the program entry point) shared by the CLI, TUI, GUI and
web front ends. It has no stable public API and is not meant to be depended on directly —
use one of the front ends instead: `@tn3270/cli`, `@tn3270/tui`, `@tn3270/gui`, or
`@tn3270/web`. See https://github.com/athornton/tn3270#readme.
