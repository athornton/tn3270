# Packaging — design (roadmap item (c), milestone A)

Date: 2026-11-05. Status: approved in brainstorming, awaiting spec review.

## Goal

Every front end installable and runnable on macOS, Linux and Windows without a checkout:

- `npm install -g @tn3270/<front end>` puts an executable on `$PATH`.
- The Electron GUI is also shipped as unsigned native artifacts, and a double-click launch
  opens a minimal connect dialog instead of a window that cannot connect anywhere.

"Works on an OS" means a CI job on that OS installed the packed tarballs and ran each
executable through `$PATH`. Building alone does not count.

## Decisions taken (and why)

| Decision | Choice | Reason |
|---|---|---|
| Milestone scope | Pipeline + startup connect dialog | Pipeline first so bundling failures are shaken out before new UI; dialog added because it is cheap at startup and makes the obvious launch work |
| Distribution of non-GUI front ends | npm packages, not standalone binaries | User preference; `npm install` + an executable on `$PATH` |
| npm names | `@tn3270/*` (org secured by the user 2026-11-05) | Already the workspace names; no import renames. Unscoped `tn3270` is taken on npm |
| GUI distribution | Both npm and native artifacts | npm route is nearly free once the pipeline exists |
| macOS architecture | Universal, one app | The usual pattern; keeps older Intel Macs usable. Both slices smoke-tested |
| Signing | None this milestone | No Apple Developer ID yet (user is getting one); signing joins milestone B |
| GUI self-containment | esbuild bundle in `packages/gui/app/` | The pages load `../canvas/dist/...` by monorepo layout, which breaks under npm and inside an asar; electron-builder also mishandles workspaces |
| Where builds run | GitHub Actions matrix + one local `npm run package` | Repo is public, runners free; local script for iteration here |
| Publishing | Manual `npm publish` by the user | Tag-triggered publish waits for npm trusted publishing to be set up |

## 1. What ships

### npm packages

Ten workspaces, all `@tn3270/*`, versioned **in lockstep** (all `0.1.0` now; first publish is
`0.1.0`; one script bumps every manifest and every internal dependency together). Internal
dependencies stay exact versions, so a mixed set cannot resolve.

| Package | Executable | Ships |
|---|---|---|
| `@tn3270/cli` | `tn3270-cli` | `dist/` |
| `@tn3270/tui` | `tn3270` | `dist/` |
| `@tn3270/web` | `tn3270-web` | `dist/`, `static/` |
| `@tn3270/gui` | `tn3270-gui` | `app/` (the bundle), `bin/` (the launcher) |
| `@tn3270/core`, `frontend`, `canvas`, `node-files` | — | `dist/` (canvas's `dist/` includes the baked atlas) |
| `@tn3270/fixtures` | — | stays `private`, never published |

Every published manifest gains: a `files` allow-list (no `src/`, tests, tsbuildinfo, scripts),
`engines.node` `>=22`, `repository`, `description`, `publishConfig.access: public`, and a short
package README. The library packages are published because the front ends depend on them; they
are not documented as public APIs.

### Fixes each executable needs to survive installation

Found by reading the code, 2026-11-05:

- `packages/web/src/main.ts` has **no shebang**; installed as a bin it would be run by the shell.
- `packages/tui/src/main.ts:392` and `packages/web/src/main.ts:729` start only when
  `import.meta.url === \`file://${process.argv[1]}\``. Through an npm symlink, a Windows `.cmd`
  shim, or any path with backslashes or a drive letter, that is false and **the program exits
  silently having done nothing**. Both are replaced by one shared `isMain(import.meta.url)` in
  `@tn3270/node-files` (Node-only, already a dependency of tui; web gains it), which compares
  `realpathSync(fileURLToPath(url))` against `realpathSync(process.argv[1])` and returns false
  rather than throwing when `argv[1]` is absent or unresolvable.
- `packages/cli/src/main.ts` calls `main()` unconditionally (line 257), which is correct for a
  bin and stays as is; verify during the plan that no test imports that module.

### `tn3270-gui` launcher

`packages/gui/bin/tn3270-gui.mjs`: resolves the Electron binary via the `electron` package's
default export (the path string), spawns it on `app/main.js` with the user's arguments and
`stdio: 'inherit'`, forwards SIGINT/SIGTERM to the child, and exits with the child's code (or
re-raises its signal). Electron is the gui package's one runtime `dependency` (moved from
`devDependencies`). The child is killed if the launcher exits first — the orphan in memory note
*electron-harness-leaks-look-like-regressions* was exactly a wrapper that did not do this.

### Native GUI artifacts (electron-builder, unsigned)

| OS | Arch | Artifacts |
|---|---|---|
| macOS | universal (x64 + arm64 in one app) | `.dmg`, `.zip` |
| Linux | x64, arm64 | AppImage, `.deb` |
| Windows | x64 | NSIS installer |

macOS is **universal**, the usual pattern, because Intel Macs stay in service longer as hardware
prices rise and the app uses no OS-specific features. It costs a roughly doubled download (Electron
twice), merged by electron-builder via `@electron/universal`, which our zero native modules make
straightforward. **The oldest macOS supported is Electron 44's floor, not ours**; the plan reads
that floor from Electron's own release notes and states it in the README rather than guessing.

Input is `packages/gui/app/` plus a pinned Electron version; **no `node_modules`** goes into the
app, because the bundle needs none. Command-line arguments work as from npm. The user tests
Linux arm64 on a Raspberry Pi and Windows on their Windows machine.

### Out of scope for this milestone

Signing and notarization; File › Connect… in a running window; preferences, a config file,
recent hosts; auto-update; Homebrew, winget and other package managers; tag-triggered publish.

## 2. Startup connect dialog

- **When:** only when the GUI starts with **no host argument**. With a host, startup is
  unchanged.
- **What:** a small window built like `transfer.html` (own HTML, preload `.cts`, boot file): one
  text field taking the command line's `[prefix:][LU,LU@]host[:port]`, a model dropdown
  (default `3278-2-E`), a TLS checkbox (default on), Connect and Quit.
- **How:** a pure function `dialogToArgv(form): string[]` turns the form into the argument list
  the user would have typed (`-insecure` when TLS is off, `-model X`, the host spec, plus any
  non-host flags given on the real command line, such as `-scheme`). That argv goes through the
  existing `parseGuiArgs` → `buildSession` path. A `UsageError` is shown **in the dialog**, which
  stays open; Quit or closing the dialog quits the app. One parser and one code path, so the
  dialog cannot disagree with the command line.
- **Why only at startup:** the startup block in `main.ts` is documented non-reentrant (IPC
  handlers and the quit hook registered once). Switching hosts in a running window needs those
  hoisted, which is milestone-B work alongside preferences.
- **Remembers nothing.** No recent hosts until there is a config file.
- **TLS hang:** a default-TLS attempt against a plaintext Hercules port hangs rather than
  refusing. The existing in-window error names `-insecure`; for a dialog launch the message
  must instead name the dialog's TLS checkbox, so the remedy matches how the user started
  (`describeTlsError` gains that variant; see memory note *fixed-width-messages-lose-their-point*
  — remedy first).

## 3. Build, CI and testing

### Build steps (root `npm run` scripts; CI runs the same)

1. `build` — unchanged (`tsc` + atlas).
2. `bundle:gui` — `packages/gui/scripts/bundle.mjs` runs esbuild: main process → `app/main.js`
   (ESM, platform node, `electron` external); each preload `.cts` → its `.cjs` (CommonJS); each
   page's boot/renderer module → `app/`; copies `index.html`, `keypad.html`, `keyboard.html`,
   `transfer.html`, the new `connect.html`, `ui.css` and the atlas, rewriting each `<script src>`
   and import map to local paths. `main.ts`'s `join(here, '..', 'index.html')` style lookups must
   resolve in both `dist/` and `app/` layouts; the plan picks one mechanism (a single
   `appRoot()` helper) rather than patching paths per call site. `app/` is gitignored.
3. `pack` — `npm pack` each publishable workspace into `artifacts/npm/` (gitignored).
4. `package:gui` — electron-builder for the host OS/arch into `artifacts/gui/`. esbuild and
   electron-builder become explicit root devDependencies.
5. `package` — 1–4 in order. The local script.

### Tests

**Unit (vitest, part of the normal suite):**

- `isMain`: true through a symlink, true for a Windows-style path where testable, false when
  imported, false with no `argv[1]`.
- `dialogToArgv`: good forms, TLS off, LU and prefix specs, empty and malformed hosts (the
  error must come from `parseGuiArgs`, not a second validator).
- **Manifest test** reading every `packages/*/package.json`: each non-private one has `files`,
  `engines`, `publishConfig.access`; every `bin` target's source has a shebang; all versions are
  equal and every internal dependency names exactly that version; no published package depends
  on `@tn3270/fixtures`. This catches the shebang and version-drift defects without a pack.

**Install smoke** (`scripts/install-smoke.mjs`, every OS in CI, and locally):

- Installs the packed tarballs into a **fresh temporary prefix** and runs each executable **by
  name through `$PATH`** (that prefix's bin directory), never by file path, so the npm shims are
  what is tested.
- `tn3270-cli`, `tn3270`, `tn3270-web`, `tn3270-gui`: a usage error on a bad flag exits non-zero
  with the usage text.
- `tn3270-cli` against an in-process fake host: connects and returns `Ascii()` text containing a
  marker string the fake host drew.
- `tn3270-web`: serves `/` and every module in the static table returns 200.
- `tn3270-gui` (Linux under Xvfb; macOS and Windows with their own display): launched with a fake
  host, writes a screenshot through the existing `TN3270_GUI_SHOT` seam to a **fresh path per
  run**, and the image must be non-blank. Per memory note *harness-passes-on-stale-artifacts*, a
  fixed output path would let a GUI that never started pass.
- **macOS universal artifact, both slices:** the packaged app is launched natively (arm64) and
  again as `arch -x86_64` under Rosetta, each producing its own non-blank screenshot, so the x64
  half is proven to start and not merely present. If GitHub still offers an Intel macOS runner
  when the plan is written, the plan adds it and the native x64 run replaces the Rosetta one.
  **Rosetta's lifetime is finite** (macOS 27 is said to be the last release with it); when the
  runner image loses it, the x64 check moves to an Intel runner or to the user's Intel hardware,
  and is never silently dropped.
- Each check fails if its executable does not run; none passes merely because an artifact
  exists.

**Bundle parity (Linux x64 CI job, and locally):** `shot.mjs`, `keys.mjs` and `clicks.mjs` gain
`TN3270_GUI_MAIN=app` to run against `app/main.js`, and must match the **same goldens byte for
byte** as the unbundled build. A new `connect.mjs` harness: start with no host, fill the dialog
through a seam, press Connect, assert the fake host's screen rendered; and a bad host spec shows
the error in the dialog without quitting.

### CI (`.github/workflows/package.yml`)

Triggers: push to `main`, pull requests, `workflow_dispatch`. Matrix:

| Runner | Produces |
|---|---|
| `ubuntu-latest` | Linux x64 npm smoke, bundle parity, AppImage + `.deb` x64 |
| `ubuntu-24.04-arm` | Linux arm64 smoke, AppImage + `.deb` arm64 |
| `macos-latest` (arm64) | macOS smoke on both slices, universal `.dmg` + `.zip` |
| `windows-latest` | Windows smoke, NSIS installer |

Each job: `npm ci`, build, typecheck, vitest, bundle, pack, install smoke, package:gui, upload
`artifacts/`. **Nothing publishes.** `docs/releasing.md` documents the manual first publish:
from a green run's tarballs or a local `npm run pack`, dependencies first
(core → frontend → node-files → canvas → cli, tui, web, gui), `--access public`.

### Known risk, to be measured first in the plan

The full suite has never run on macOS or Windows. Tests assuming POSIX paths, ptys or `/tmp`
may fail there (the Python pty harnesses certainly would, and are Linux-only harnesses, not
vitest). On those runners the job runs vitest and the install smoke; any vitest test found
POSIX-only is marked skipped on that platform **with a stated reason**, never deleted or
retried until green. The plan's first CI task is to run the unchanged suite on all four runners
and record the exact failures before changing anything (memory note
*measure-a-change-before-planning-it*).

## Success criteria

1. All four CI jobs green, each having installed from tarballs and run all four executables
   through `$PATH`.
2. Bundle parity: the GUI goldens match byte for byte from `app/`.
3. Artifacts uploaded by CI: Linux x64 and arm64, macOS universal, Windows x64.
4. A double-clicked GUI shows the connect dialog and connects (harness on Linux; by the user on
   macOS, Windows and a Pi).
5. `docs/releasing.md` lets the user publish 0.1.0 by hand.
