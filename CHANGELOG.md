# Changelog

What changed for users in each release of the `@tn3270/*` packages and the native installers.
Changes not yet released are fragments in [`changelog.d/`](changelog.d/), one per functional
change, written with `uvx scriv create`; at release `uvx scriv collect --version X.Y.Z` gathers
them into a new entry at the top of this file. See `docs/releasing.md`.

<!-- scriv-insert-here -->

<a id='changelog-0.1.4'></a>
## 0.1.4 (2026-11-10)

### Other changes

- Each release now has a GitHub release page carrying the GUI's native installers (macOS, Linux
  x64 and arm64, Windows), the same files the release's CI run built and tested, with a
  `SHA256SUMS` file to check your download against, and notes saying what changed.
- The project now keeps this changelog, `CHANGELOG.md`.

<a id='changelog-0.1.3'></a>
## 0.1.3 (2026-11-09)

### Other changes

- The first release published to npm by the project's own tag workflow rather than by hand. Each
  package now carries an npm provenance attestation, which `npm audit signatures` verifies.
- No user-facing change from 0.1.1.

<a id='changelog-0.1.2'></a>
## 0.1.2 (2026-11-09) — not released

### Other changes

- Never published: the release failed before anything reached npm, and the version is skipped.

<a id='changelog-0.1.1'></a>
## 0.1.1 (2026-11-09)

### New features

- The TUI (`tn3270`) asks for a host when started at a terminal without one.

### Bug fixes

- The GUI's Connect dialog stays open when a connection fails, so you can correct the host and
  retry instead of starting over.
- Connecting to a plaintext host that doesn't answer now gives up after 30 seconds, instead of
  after the system's TCP timeout (about two minutes on Linux).
- A host that is down or misspelled is reported as a failure to connect, even with TLS on, rather
  than as a TLS problem.

### Other changes

- The minimum Node version is lowered from 22 to 20.19 (what Debian 13 packages).

<a id='changelog-0.1.0'></a>
## 0.1.0 (2026-11-08)

### New features

- First release on npm: `@tn3270/cli` (an s3270-style scripting client), `@tn3270/tui` (a
  c3270-style terminal client), `@tn3270/web` (a browser gateway) and `@tn3270/gui` (an Electron
  GUI), with the libraries they share.
- Native installers for the GUI, built by CI: macOS universal `.dmg`/`.zip`, Linux x64 and arm64
  AppImage and `.deb`, and a Windows x64 installer. They are unsigned: macOS needs *Open Anyway*
  in System Settings, Privacy & Security, and Windows SmartScreen needs *More info*, *Run anyway*.
