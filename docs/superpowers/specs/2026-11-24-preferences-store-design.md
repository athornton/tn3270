# 15b sub-project B1: the preferences store (GUI and TUI) — design

2026-11-24. README *Staging* 15b, sub-project B (preferences and appearance), split with the user
into **B1, the preferences store (this spec)**; B2, appearance changed while running (scheme menu,
3278/3279 color mode and `-mono`, highlight-bold, cursor color, font stepping and Snap, light and
dark modes); B3, other emulator fonts, probably deferred. B1 comes first because B2's menus are
only half useful until their choices can be saved. Approved by the user 2026-11-24.

Parity row: `save-options` (missing today: "there is no preferences store").

## Decisions (the user's, 2026-11-24)

- **The TUI gets a store too**, for the options that make sense there. The CLI and the web gateway
  get none: the CLI is scripted, and the gateway is configured by its command line.
- **Our own JSON**, using our flag names. Not x3270's X-resources profile, and no import of one.
- **Separate files** for the GUI and the TUI, not one shared file.
- **Explicit save**, as x3270's Save Changed Options. Not autosave.
- **The stored keys** are the table below, and nothing that weakens TLS.

## 1. The files

| front end | path |
|---|---|
| GUI | `app.getPath('userData')/preferences.json`: `~/.config/TN3270/` (Linux), `~/Library/Application Support/TN3270/` (macOS), `%APPDATA%\TN3270\` (Windows) |
| TUI | `$XDG_CONFIG_HOME/tn3270/tui.json`, else `~/.config/tn3270/tui.json`; `%APPDATA%\tn3270\tui.json` on Windows |

The GUI's path is the one place the Microsoft Store (MSIX) build can write without its writes being
redirected (the parity row's store-probe note; the store probe is `docs/releasing.md:661-668`, which
launches sandboxed stand-ins of both store packages in CI). The row's own citation, `:808`, is stale:
the plan should correct it. A flat JSON object, e.g.
`{ "model": "3278-4-E", "scheme": "green", "codepage": "cp037", "visualbell": true }`. A missing
file means no preferences, not an error.

## 2. Stored keys

| key | type, flag form | GUI | TUI |
|---|---|---|---|
| `model` | string, `-model V` | ✓ | ✓ |
| `oversize` | string, `-oversize V` | ✓ | ✓ |
| `scheme` | string, `-scheme V` | ✓ | ✓ |
| `codepage` | string, `-codepage V` | ✓ | ✓ |
| `visualbell` | boolean, `-visualbell` when true | ✓ | ✓ |
| `colors` | number, `--colors N` | | ✓ |
| `tn3270e`, `bind-image`, `bind-limit`, `ddm` | boolean, `-<key> on\|off` | ✓ | ✓ |
| `cafile` | string, `-cafile PATH` | ✓ | ✓ |

**Refused, with a reason, not merely ignored:**
- `insecure`, `noverifycert`: a saved TLS weakening would apply silently to every connection.
- `host`, `devname`: these belong to a particular host, and wait for sub-project C's host list.
- `terminal-type`: a debugging override, not a preference.

## 3. Loading: the file becomes flags

- `prefsToArgv(json, allowed)` in `frontend`, pure, turns the object into flag tokens: strings and
  numbers as `-flag value`, `on`/`off` booleans as `-flag on|off`, and `visualbell: true` as the
  bare flag (`false` emits nothing, which is the default).
- **The tokens go in front of the real argv**, and the front end's own parser checks them. So the
  values, their checks and their messages are the flags' own, and the order of defaults, file,
  then flags falls out because each parser keeps the last value it sees. **The plan must confirm
  that last-one-wins rule for every stored flag in both parsers** (including the TLS and oversize
  helpers in `frontend`) and fix any flag that doesn't follow it.
- **Errors:**
  - **Bad JSON, a non-object, or a value of the wrong type:** a startup error naming the file and
    the key.
  - **A bad value:** caught by parsing the file's tokens on their own first, so the error says
    `preferences.json: -model …` and can't be blamed on the command line.
  - **An unknown key:** a stderr warning (`preferences.json: ignoring unknown key "colour"`), and
    the key is skipped, so an older version can read a newer file.
  - **A refused key:** a stderr warning saying why, and the key is skipped.
  - **In the GUI**, startup errors appear in the window, as other startup failures do.

## 4. Saving

- **GUI: File → Save Changed Options** (the app menu on macOS). It writes the current value of every
  stored setting that isn't at its built-in default. "Current" means whatever came from a flag,
  the file or a menu, including the Model and Oversize menus' pending choice. The scheme's name is
  carried alongside the resolved `Scheme`, which has no name today.
- **TUI: `-save`** writes the same from the run's file and flags, then carries on.
- **Writes are atomic:** a temporary file in the same directory, then a rename. The directory is
  created if missing.
- **Keys the file has that this version doesn't know are preserved**, merged back in, so a newer
  version's settings survive an older version's save.
- **Success is reported** (`saved 4 settings to <path>`: in the GUI through the window's notice
  path, in the TUI on stderr). **A failure is shown, never swallowed.**

**AMENDED WHILE PLANNING AND BUILDING (2026-11-24):** a save writes what the file, a flag or a
menu set (it inverts the effective tokens with `argvToPrefs`, because a parsed `Scheme` has no
name), not strictly "everything not at its default". A value set explicitly to its default is
kept, and an unset default is still never written. The GUI's Connect dialog now takes its default
model from the startup argv: it always used the built-in default, which dropped a `-model` given
without a host. The store-probe check is recorded as a gap: the probe passes `--user-data-dir`.

## Testing

- **Unit:** `prefsToArgv` (each type, refused and unknown keys, bad JSON); the file-versus-flag
  order for every stored flag in both front ends; `currentPrefs`, what a save writes, including
  leaving defaults out; the atomic write; preserving unknown keys.
- **GUI:** the menu item calls the save handler; save, then a new instance loads it.
- **Live (Xvfb + VM/370):** choose a model in the Model menu, save, restart with no flags, and see
  that model used. In the TUI, `-save` once, then a plain run uses the saved settings.
- **Store probe:** if the probe's drivers (`scripts/store-probe.mjs`) can run a step, make it
  save and reload preferences inside the App Sandbox and MSIX stand-ins. A save that works
  unsandboxed and fails in a store package is exactly what the probe exists to catch. If the
  drivers can't, the plan says so and records the gap.
- **Parity:** `save-options` becomes `ours`. The `gui` text says it's a JSON file, not an x3270
  profile, by the user's choice.

## Out of scope

B2's menus and settings; importing an x3270 profile; the host list and recent hosts (sub-project C);
any store for the CLI or web gateway.
