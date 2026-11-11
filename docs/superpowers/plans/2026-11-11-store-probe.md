# Store Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every CI run, `macos-latest` launches an App-Sandboxed copy of the app and
`windows-latest` launches an installed MSIX of it. Each must prove its confinement and pass
package-smoke's two checks. Neither is ever uploaded.

**Architecture:** package-smoke's two checks move into a shared module so that the probe runs the
very same checks on new routes. The app gains one seam, `TN3270_GUI_PROBE=1`, which reports its
own confinement: macOS's `APP_SANDBOX_CONTAINER_ID` and Electron's `process.windowsStore`. That
makes the identity proof come from inside the process. `scripts/store-probe.mjs` builds each route,
staging inputs inside the macOS container, and judges.

**Tech Stack:** electron-builder 26.18.0 (`appx` target, makeappx), codesign ad-hoc, PowerShell
(`New-SelfSignedCertificate`, `Add-AppxPackage`), signtool from electron-builder's bundled kit,
vitest, plain Node ESM.

**ORDER: Task 1, then Task 0, then Tasks 2-8.** The spike (Task 0) uses Task 1's seam, so that
the spike also measures the in-process confinement signals.

**Spec:** `docs/superpowers/specs/2026-11-11-store-probe-design.md`. **Branch:** `store-probe`, cut
from `origin/main` at `db5a93d`.

**THE SOURCE BEATS THIS PLAN.** The code here is a draft: re-read every file a task touches, follow
the repository where they disagree, and record the difference in the commit message. Run each
shell step as one command with a timeout. Use `/usr/bin/gh`, not `gh` (a conda shim shadows it).
`grep`/`find` may be ugrep/bfs; use `/usr/bin/grep` if flags misbehave. Commit messages end, after
a blank line, with:

```
Generated with AI

Co-Authored-By: SLAC AI
```

## Facts already measured (2026-11-11)

- `AppxTarget.js:344` resolves `customExtensionsPath` against `appInfo.appDir`, which is the bundle
  directory `packages/gui/app`, NOT `resources/`. Pass an ABSOLUTE path (`path.join(__dirname, ...)`).
- `templates/appx/appxmanifest.xml` declares the `foundation`, `uap`, `desktop` and `rescap`
  namespaces, and **not** `uap5` (or `uap3`). The Application uses
  `EntryPoint="Windows.FullTrustApplication"` and `Executable="app\TN3270.exe"` (line 170:
  `app\\${productFilename}.exe`).
- With no certificate, the appx is unsigned and its publisher is `appx.publisher`
  (`AppxTarget.js:164-165`).
- The appx output uses the `appx` extension. The `artifactName` template
  `${productName}-${version}-${os}-${arch}.${ext}` makes it `TN3270-<v>-win-x64.appx`.
- `scripts/package-smoke.mjs` holds the two checks (`drawsGolden` ~193, `dialogConnects` ~227) and
  `start`/`stop`/`switches` (~140-190). They are module-private, keyed on the `linux`/`win` host
  flags, and use the env seams `TN3270_GUI_REPLAY`/`TN3270_GUI_SHOT`/`TN3270_GUI_SHOT_MS`/`TN3270_GUI_CONNECT`.
- The `gui-<os>` upload lists `*.AppImage *.deb *.dmg *.zip *.exe` explicitly.
- `release-notes.mjs` `checkInstallers` rejects any unexpected file in a release.

## File structure

| File | Responsibility |
|---|---|
| `.github/workflows/package.yml` | Task 0: a temporary `spike` job (removed in Task 8). Task 7: the `store probe` step |
| `packages/gui/src/probe.ts` (new) + `main.ts` hook | `TN3270_GUI_PROBE=1` → one `probe: ...` stdout line |
| `scripts/package-checks.mjs` (new) | `drawsGolden`, `dialogConnects`, `start`, `stop`, `switches`, moved out of package-smoke and parameterised by route |
| `scripts/package-smoke.mjs` | imports the checks; behaviour unchanged |
| `packages/gui/resources/entitlements.mas.plist`, `entitlements.mas.inherit.plist` (new) | sandbox entitlements |
| `packages/gui/resources/appx-extensions.xml` (new) | the `tn3270-gui.exe` app execution alias |
| `packages/gui/electron-builder.cjs` | `win.target` += appx x64, the `appx` placeholder identity |
| `scripts/store-probe.mjs` + `.d.mts` (new) | pure judges, route builders, `main(argv, io)` |
| `packages/core/test/storeProbe.test.ts`, `packages/core/test/fixtures/store-probe/` (new) | tests and fixtures |
| `packages/gui/test/probe.test.ts`, `packages/gui/test/signing.test.ts` (extend) | seam and config tests |
| `packages/core/test/workflow.test.ts` | pins the probe step |
| `docs/releasing.md`, `docs/HANDOFF.md`, README, `changelog.d/` | the rule, cost, results |

---

### Task 0: measurement spike in CI (ASK THE USER before the first push)

The two unknowns that would sink the design, measured before anything is built on them:
1. Does macOS enforce the App Sandbox for an ad-hoc-signed copy run from the shell? Can inputs
   staged in its container be read, and does the golden still match?
2. Does `makeappx` accept an inline-namespaced `uap5` alias? Does an alias launch pass arguments
   and environment and run with package identity?

**Files:** modify `.github/workflows/package.yml` (a temporary job), and create
`scripts/spike/mac-sandbox.sh` and `scripts/spike/win-appx.ps1`. All three are removed in Task 8.

- [ ] **Step 1: Add the job.** Add a top-level job `spike` with
  `if: github.event_name == 'workflow_dispatch' && inputs.spike`, a new boolean dispatch input
  `spike` (default false), `strategy.matrix.os: [macos-latest, windows-latest]`, and
  `timeout-minutes: 45`. Its steps: checkout, setup-node 22 with the npm cache, `npm ci`,
  `npm run build`, `npm run package:gui -- --mac` (macOS) or `-- --win --x64` (Windows), then the
  OS's spike script.
  On Windows, run `package:gui` with these extra flags after `--win --x64`:
  `-c.win.target=appx -c.appx.identityName=TN3270.Probe "-c.appx.publisher=CN=TN3270 Store Probe" "-c.appx.publisherDisplayName=TN3270 store probe" -c.appx.customExtensionsPath=%GITHUB_WORKSPACE%/scripts/spike/appx-extensions.xml`.
  Use the shell's own form of the variable: `pwsh` is `$env:GITHUB_WORKSPACE`. If electron-builder
  rejects `-c.` overrides together with a config file, write a temporary `--config` JS file that
  `require`s `electron-builder.cjs` and overrides those keys, and record which you used.
- [ ] **Step 2: `scripts/spike/mac-sandbox.sh`** (bash, `set -euxo pipefail`). Every launch is
  bounded with a background `kill -9` after 120 s, because macOS has no `timeout(1)`.

```bash
#!/usr/bin/env bash
# SPIKE (store-probe plan Task 0): removed in Task 8. Measures the App Sandbox on an ad-hoc copy.
set -euxo pipefail
W="$RUNNER_TEMP/spike"; rm -rf "$W"; mkdir -p "$W"
ditto -x -k artifacts/gui/TN3270-*-mac-universal.zip "$W"
APP="$W/TN3270.app"; EXE="$APP/Contents/MacOS/TN3270"
cat > "$W/main.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.files.user-selected.read-write</key><true/>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
EOF
cat > "$W/inherit.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.app-sandbox</key><true/>
<key>com.apple.security.inherit</key><true/>
</dict></plist>
EOF
# Inside-out: dylibs and frameworks plain, helper apps with inherit, the app last with main.
find "$APP/Contents/Frameworks" -name '*.dylib' -print0 | xargs -0 -n1 codesign --force -s -
# --deep on frameworks only: Electron Framework.framework nests executables (Helpers/chrome_crashpad_handler).
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0 | xargs -0 -n1 codesign --force --deep -s -
find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.app' -print0 | xargs -0 -n1 codesign --force -s - --entitlements "$W/inherit.plist"
codesign --force -s - --entitlements "$W/main.plist" "$APP"
codesign -d --entitlements :- "$APP" || true
codesign --verify --deep --strict --verbose=2 "$APP" || true
bounded() { "$@" & local p=$!; ( sleep 120; kill -9 "$p" 2>/dev/null ) & local k=$!; wait "$p"; local rc=$?; kill "$k" 2>/dev/null || true; return $rc; }
C="$HOME/Library/Containers/io.github.athornton.tn3270"
# 1: launch with nothing to do, then kill after 20 s; does the container appear?
"$EXE" --disable-gpu & P=$!; sleep 20; kill -9 "$P" || true
ls -la "$C" "$C/Data" || echo "NO CONTAINER"
# 2: the golden, with the trace and user data INSIDE the container.
cp packages/fixtures/traces/synthetic-ispf-like.trace "$C/Data/" || echo "STAGE FAILED"
TN3270_GUI_PROBE=1 TN3270_GUI_REPLAY="$C/Data/synthetic-ispf-like.trace" TN3270_GUI_SHOT="$C/Data/shot.png" TN3270_GUI_SHOT_MS=2500 \
  bounded "$EXE" --disable-gpu --force-device-scale-factor=1 --force-color-profile=srgb --user-data-dir="$C/Data/ud" -insecure -model 3278-2-E 127.0.0.1:1 || echo "golden launch rc=$?"
cat "$C/Data/shot.png.sha256" || true; cat packages/gui/test/golden/synthetic-ispf.sha256
# 3: NEGATIVE -- the same trace OUTSIDE the container must NOT be readable if the sandbox is real.
TN3270_GUI_REPLAY="$PWD/packages/fixtures/traces/synthetic-ispf-like.trace" TN3270_GUI_SHOT="$C/Data/shot2.png" TN3270_GUI_SHOT_MS=2500 \
  bounded "$EXE" --disable-gpu --user-data-dir="$C/Data/ud2" -insecure -model 3278-2-E 127.0.0.1:1 || echo "outside launch rc=$?"
ls -la "$C/Data" || true
```

- [ ] **Step 3: `scripts/spike/appx-extensions.xml`**, an inline namespace on the element:

```xml
<uap5:Extension xmlns:uap5="http://schemas.microsoft.com/appx/manifest/uap/windows10/5" Category="windows.appExecutionAlias" Executable="app\TN3270.exe" EntryPoint="Windows.FullTrustApplication">
  <uap5:AppExecutionAlias>
    <uap5:ExecutionAlias Alias="tn3270-gui.exe" />
  </uap5:AppExecutionAlias>
</uap5:Extension>
```

  Check this namespace URI and the element names against Microsoft's
  [uap5:AppExecutionAlias](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-uap5-appexecutionalias)
  page before the push, and correct this text if they differ.
- [ ] **Step 4: `scripts/spike/win-appx.ps1`** (`$ErrorActionPreference='Continue'`, so that every
  measurement prints). It must:
  1. list `artifacts\gui` and find `TN3270-*-win-x64.appx`;
  2. `New-SelfSignedCertificate -Type Custom -Subject 'CN=TN3270 Store Probe' -KeyUsage DigitalSignature -CertStoreLocation Cert:\CurrentUser\My -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3','2.5.29.19={text}')`;
  3. export it to a `.pfx` with a random password, and import its public part into
     `Cert:\LocalMachine\TrustedPeople`;
  4. find `signtool.exe` under `$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign` (print what
     is there), then run `signtool sign /fd SHA256 /f <pfx> /p <pw> <appx>`;
  5. `Add-AppxPackage <appx>`, then `Get-AppxPackage TN3270.Probe | Format-List`;
  6. `Get-Command tn3270-gui.exe` (is the alias on PATH, under `%LOCALAPPDATA%\Microsoft\WindowsApps`?);
  7. the golden launch through the alias, with `TN3270_GUI_PROBE=1` and the replay, shot and
     shot-ms env set, the same switches as on mac, the trace from the repo and the shot in
     `$env:RUNNER_TEMP`, under a 120 s `Start-Process -PassThru` / `Wait-Process -Timeout`. Print
     its stdout (`-RedirectStandardOutput`) and the sha256 next to the golden;
  8. the same launch of `<InstallLocation>\app\TN3270.exe` **directly**, to compare its `probe:` line;
  9. cleanup: `Remove-AppxPackage`, and remove the certificate from both stores.
- [ ] **Step 5: Check the order.** Task 1 must already be committed, so that the spike's launches
  print `probe:` lines.
- [ ] **Step 6: Push and dispatch (ask first):**
  `git push -u origin store-probe`, then
  `/usr/bin/gh workflow run package.yml --ref store-probe -f spike=true`. Watch it, and save both
  job logs to `/tmp/spike-<os>.log`.
- [ ] **Step 7: Write down what was measured** in a short section at the end of this plan file,
  "Spike results (run <id>)", with one line per question:
  - the container appeared, yes or no;
  - the sandboxed golden matched, yes or no (with both hashes);
  - the outside read was denied, yes or no (and how it showed);
  - `codesign -d` showed app-sandbox;
  - `makeappx` accepted the alias;
  - the alias was on PATH;
  - the alias launch passed args and env, and its `probe:` line;
  - the direct launch's `probe:` line;
  - the signtool path;
  - each step's duration.

  **STOP and report to the controller.** Tasks 3-6 depend on the answers. If the sandbox is not
  enforced, or the alias does not give identity, the controller takes the spec's fallback (or a
  question to the user) before continuing.

### Task 1: the `TN3270_GUI_PROBE` seam

**Files:**
- Create: `packages/gui/src/probe.ts`
- Modify: `packages/gui/src/main.ts`, at app-ready, where the other `TN3270_GUI_*` seams are read
  (find them with `/usr/bin/grep -n TN3270_GUI_ packages/gui/src/main.ts`)
- Modify: `scripts/package-smoke.mjs` `NO_SEAMS`: add `TN3270_GUI_PROBE: ''`
- Test: `packages/gui/test/probe.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { probeLine } from '../src/probe.js';

describe('probeLine', () => {
  it('reports both confinement signals, unconfined', () => {
    expect(probeLine({}, { windowsStore: undefined, mas: undefined })).toBe('probe: sandbox=none windowsStore=false');
  });
  it('names the macOS sandbox container id when set', () => {
    expect(probeLine({ APP_SANDBOX_CONTAINER_ID: 'io.github.athornton.tn3270' }, { windowsStore: undefined, mas: undefined }))
      .toBe('probe: sandbox=io.github.athornton.tn3270 windowsStore=false');
  });
  it('reports windowsStore true only when Electron says exactly true', () => {
    expect(probeLine({}, { windowsStore: true, mas: undefined })).toBe('probe: sandbox=none windowsStore=true');
  });
  it('an empty container id is none, not an empty name', () => {
    expect(probeLine({ APP_SANDBOX_CONTAINER_ID: '' }, { windowsStore: undefined, mas: undefined })).toBe('probe: sandbox=none windowsStore=false');
  });
});
```

- [ ] **Step 2: Run it and check that it fails:** `npx vitest run packages/gui/test/probe.test.ts`
  should fail on module not found.
- [ ] **Step 3: Write `packages/gui/src/probe.ts`**

```ts
/**
 * The store probe's view from INSIDE the process (store-probe spec, section 2):
 *  - APP_SANDBOX_CONTAINER_ID: macOS sets it in every App-Sandboxed process;
 *  - process.windowsStore: Electron sets it true inside an AppX/MSIX package.
 * Printed only under TN3270_GUI_PROBE=1, as one stdout line scripts/store-probe.mjs judges.
 */
export function probeLine(
  env: Record<string, string | undefined>,
  proc: { windowsStore: boolean | undefined; mas: boolean | undefined },
): string {
  const id = env.APP_SANDBOX_CONTAINER_ID;
  return `probe: sandbox=${id ? id : 'none'} windowsStore=${proc.windowsStore === true}`;
}
```

  `mas` is in the input type so the probe can grow without changing the signature. If the
  reviewer calls that YAGNI, drop it from the type and the tests together.
- [ ] **Step 4: Hook it into `main.ts`:** when `process.env.TN3270_GUI_PROBE === '1'`, run
  `console.log(probeLine(process.env, process as unknown as { windowsStore?: boolean; mas?: boolean }))`
  once, at the point where the other seams print their first line. Follow how those seams write
  to stdout; there may be a helper.
- [ ] **Step 5: Tests, typecheck, then a live run on Linux:**
  `npx vitest run packages/gui/test/probe.test.ts`, then `npm run typecheck`, then `npm run build`.
  Then launch the dist app once under Xvfb with `TN3270_GUI_PROBE=1` and the shot seam, the way
  `packages/gui/scripts/shot.mjs` does (read it). Confirm that stdout has
  `probe: sandbox=none windowsStore=false`.
- [ ] **Step 6: Commit:** `gui: TN3270_GUI_PROBE=1 prints the process's own confinement signals`.

### Task 2: move package-smoke's checks into `scripts/package-checks.mjs` (behaviour unchanged)

**Files:** create `scripts/package-checks.mjs`; modify `scripts/package-smoke.mjs`.

- [ ] **Step 1:** Move `NO_SEAMS`, `switches`, `start`, `winProcessesUnder`, `stop`, `exitedWithin`,
  `drawsGolden`, `dialogConnects` and `CHECKS` into `package-checks.mjs`, as exports. The host
  flags (`linux`, `win`) stay as they are. Add two optional route fields, with defaults that
  reproduce today's behaviour exactly:
  - `route.stage(dir) -> { trace, shot, userData }`: where a check's inputs and outputs live. The
    default is today's: the repository trace, and `shot.png` and `user-data` in the check's
    mkdtemp dir.
  - `route.probe: boolean`: when true, the launch env adds `TN3270_GUI_PROBE: '1'`, and the check
    returns the `probe:` line it saw. That line becomes part of the check's return value, so the
    probe can judge it. Today's routes leave it false.

  `drawsGolden` and `dialogConnects` must use `route.stage` for every path they pass to the app.
- [ ] **Step 2:** `package-smoke.mjs` imports these. Its route builders and `main` are unchanged.
- [ ] **Step 3: Check that nothing changed.** Run `npm run build && npm run package:gui -- --linux --x64`
  (timeout 15 min), then `xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/package-smoke.mjs`.
  The output must be the same `ok` lines as before the move (run it once on `origin/main` first
  and diff the `ok`/`FAIL` lines). If xvfb-run is missing, use the userspace Xvfb the GUI harnesses
  use (`packages/gui/scripts/xvfb.mjs`).
- [ ] **Step 4: Mutation:** make the default `stage` return a wrong trace path, and confirm the
  Linux package smoke FAILs. Revert.
- [ ] **Step 5: Commit:** `scripts: package-smoke's checks move to package-checks.mjs, parameterised by route`.

### Task 3: entitlements, the alias, and the appx target

Only after Task 0's results. Use whatever form of the alias and of the codesign order the spike
proved.

**Files:**
- Create: `packages/gui/resources/entitlements.mas.plist` and
  `packages/gui/resources/entitlements.mas.inherit.plist` (the contents proven in Task 0 Step 2)
- Create: `packages/gui/resources/appx-extensions.xml` (proven in Task 0 Step 3)
- Modify: `packages/gui/electron-builder.cjs`
- Test: `packages/gui/test/signing.test.ts` (append) or a new `packages/gui/test/storeConfig.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('store stand-in config', () => {
  const cfg = createRequire(import.meta.url)(join(gui, 'electron-builder.cjs')) as {
    win: { target: unknown[] }; appx: Record<string, unknown>;
  };
  it('win builds the NSIS exe AND the appx, both x64', () => {
    expect(cfg.win.target).toEqual([{ target: 'nsis', arch: 'x64' }, { target: 'appx', arch: 'x64' }]);
  });
  it('appx identity is the NAMED placeholder until a Store name is reserved (piece 3)', () => {
    expect(cfg.appx).toMatchObject({
      identityName: 'TN3270.Probe', publisher: 'CN=TN3270 Store Probe', publisherDisplayName: 'TN3270 store probe',
    });
  });
  it('the alias file is absolute (AppxTarget resolves it against the bundle dir) and declares tn3270-gui.exe', () => {
    const p = cfg.appx.customExtensionsPath as string;
    expect(isAbsolute(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toMatch(/Alias="tn3270-gui\.exe"/);
  });
  it.each(['entitlements.mas.plist', 'entitlements.mas.inherit.plist'])('%s grants app-sandbox', (f) => {
    expect(readFileSync(join(gui, 'resources', f), 'utf8')).toMatch(/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/);
  });
  it('the main entitlements grant network.client (the Connect check needs it) and no network.server', () => {
    const t = readFileSync(join(gui, 'resources', 'entitlements.mas.plist'), 'utf8');
    expect(t).toMatch(/network\.client<\/key>\s*<true\/>/);
    expect(t).not.toMatch(/network\.server/);
  });
});
```

  (Add `isAbsolute` and `readFileSync` to the imports.)
- [ ] **Step 2: Run it and check that it fails.**
- [ ] **Step 3: Implement it.** In `electron-builder.cjs`, set `win.target` to the two entries.
  Add a top-level `appx` with the three placeholders, `customExtensionsPath: path.join(__dirname, 'resources', 'appx-extensions.xml')`
  (a `require('node:path')`), and a comment that names them as placeholders replaced in piece 3,
  and says the appx is a stand-in that is never uploaded. Then write the three resource files.
- [ ] **Step 4: Run the tests, then `npm run typecheck`, then a Linux package** (which must still
  make the AppImage and the deb), then `npm test`.
- [ ] **Step 5: Commit:** `gui: appx stand-in target and App Sandbox entitlements (placeholders; never uploaded)`.

### Task 4: `store-probe.mjs`, the pure part

**Files:** create `scripts/store-probe.mjs`, `scripts/store-probe.d.mts`,
`packages/core/test/storeProbe.test.ts` and `packages/core/test/fixtures/store-probe/`.

The fixtures are captures from Task 0's logs: the `codesign -d --entitlements` output, the
`Get-AppxPackage` output, and the `probe:` lines. Each carries a `#` provenance header (run id,
date, exit status), the convention in `packages/core/test/fixtures/signatures/`.

- [ ] **Step 1: Failing tests** for these exports:
  - `parseProbeLine(stdout) -> { sandbox: string | null, windowsStore: boolean } | null`: the
    LAST `probe:` line. Null when there is none, and also null when the line is malformed (that is
    a FAIL, never "unconfined").
  - `judgeMacConfinement({ entitlements, containerExists, probe }, bundleId) -> string[]`, empty
    when the copy is confined. It requires all of: the entitlements text shows `app-sandbox` true,
    the container directory exists, and `probe.sandbox === bundleId`. Each failure names what was
    missing.
  - `parseAppxPackage(text) -> { name, packageFamilyName, installLocation } | null`, from
    `Get-AppxPackage <name> | ConvertTo-Json -Compress`. This is JSON, not `Format-List`, so the
    probe runs it that way. Task 0 captured `Format-List`, so a JSON capture comes from Task 7.
  - `judgeWinConfinement({ pkg, probe }, identityName) -> string[]`: `pkg` non-null with
    `name === identityName`, and `probe.windowsStore === true`.
  - `macRoute(io)` / `winRoute(io)` build the route objects for `package-checks.mjs`. `macRoute`'s
    `stage` puts the trace, the shot and the user data under
    `<home>/Library/Containers/<bundleId>/Data/probe-<n>/`, with posix paths whatever the host.
    `winRoute` launches `tn3270-gui.exe` with win32 paths whatever the host.

  Each judge needs a passing case built from a real capture, a failing case for each requirement,
  and a malformed-input case. Include the path-separator test, which runs both routes on a Linux
  host and checks `/` and `\`.
- [ ] **Step 2: Run them and watch them fail. Step 3: Implement. Step 4: Run them, then typecheck.**
- [ ] **Step 5: Mutation** (each must fail a test, then revert):
  - drop the container check;
  - accept `sandbox=none`;
  - accept `windowsStore=false`;
  - use host `path.join` in `macRoute`.
- [ ] **Step 6: Commit:** `scripts: store-probe judges and routes`.

### Task 5: `store-probe.mjs`, the drivers and `main`

**Files:** `scripts/store-probe.mjs`, `scripts/store-probe.d.mts`, `packages/core/test/storeProbe.test.ts`.

These turn Task 0's two spike scripts into code. **The spike logs are the specification**: same
commands, same order. Everything goes through an injected `io.run` and `io.fs`, so `main` is
tested on Linux.

- **mac:**
  1. `ditto` the zip into scratch;
  2. re-sign in the proven order with `packages/gui/resources/entitlements.mas*.plist`;
  3. read the entitlements;
  4. make a confinement launch, then check the container;
  5. run `CHECKS` from `package-checks.mjs` on `macRoute` with `probe: true`, and judge each
     check's `probe:` line too;
  6. in a `finally`, remove the container directory (`rm -rf`, posix, with its path asserted to
     be under `~/Library/Containers/`) and the scratch.
- **win:**
  1. create the certificate, export the pfx, trust it, `signtool sign`, `Add-AppxPackage`;
  2. read `Get-AppxPackage` JSON;
  3. run `CHECKS` on `winRoute` with `probe: true`;
  4. in a `finally`: `Remove-AppxPackage`, remove the certificate from both stores, delete the
     pfx. Each cleanup step runs even if the one before it failed, and each failure is logged.
- **Output:** `ok <route>: <check>` / `FAIL <route>: <why>`. Exit 0, 1 on any FAIL, 2 on a setup
  problem (no zip or appx, a tool missing, no signtool found, the alias not on PATH after install).
  `STORE_PROBE_ECHO=1` logs each command and its raw output, as `VERIFY_SIGNATURES_ECHO` does.
- **Timing:** each phase's wall time is printed (`time <phase>: <s>s`), for Task 7's cost figure.

- [ ] **Step 1: Failing `main` tests with a fake `io`:**
  - macOS happy path, with the order of commands asserted;
  - macOS with the container missing → exit 1, naming it;
  - a cleanup that runs after a throw;
  - the container-removal guard refusing a path outside `~/Library/Containers/`;
  - Windows happy path;
  - Windows with the alias not found → exit 2;
  - Windows `Remove-AppxPackage` and both certificate removals all running when `Add-AppxPackage`
    failed.
- [ ] **Step 2: fail; Step 3: implement; Step 4: tests, typecheck, `npm test`.**
- [ ] **Step 5: Mutation:** skip the certificate removal; skip the container guard; take the mac
  path off `posix`. Each must fail a test.
- [ ] **Step 6: Commit:** `scripts: store-probe drivers, mac sandbox copy and Windows MSIX install`.

### Task 6: CI wiring

**Files:** `.github/workflows/package.yml`, `packages/core/test/workflow.test.ts`.

- [ ] **Step 1: Failing tests:**
  - a matrix key `probe: true` on exactly `macos-latest` and `windows-latest`;
  - a step `store probe` with `if: matrix.probe` that runs `node scripts/store-probe.mjs`, after
    `package:gui` and after both verify steps, and before the uploads;
  - its `if:` mentions no ref, input or event, so it runs on every event;
  - no `upload-artifact` `path:` matches `.appx`, and the `gui-*` upload's path list is unchanged
    (pin the exact five patterns);
  - `STORE_PROBE_ECHO: '1'` on the step;
  - the header comment documents `probe`.
- [ ] **Step 2: fail; Step 3: edit the workflow.** Don't remove the Task 0 spike job yet; Task 8
  does that.
- [ ] **Step 4: tests, then YAML validation** (PyYAML `safe_load`), **then `npm test`.**
- [ ] **Step 5: Commit:** `ci: store probe on macos-latest and windows-latest, every run`.

### Task 7: CI proof, fixtures and cost

- [ ] **Step 1:** Push. (The branch already exists from Task 0, so pushing is within what the user
  allowed; ask if it isn't.) Dispatch an unsigned run:
  `/usr/bin/gh workflow run package.yml --ref store-probe -f sign=false`. The workflow does not run
  on pushes to branches other than main.
- [ ] **Step 2: Expected:** all six jobs green. The mac and Windows jobs show `ok mac-sandbox: ...`
  and `ok msix: ...` for both checks, the confinement lines, and the `time` lines.
- [ ] **Step 3:** Replace any hand-made fixture with that run's captures, in particular the
  `Get-AppxPackage` JSON. Commit: `test: store-probe captures from run <id>`.
- [ ] **Step 4: Cost.** Compare the mac and Windows job durations with run 43065643116 (main, the
  last green run without the probe), using `/usr/bin/gh run view <id> --json jobs`. Also add up
  the probe's own `time` lines. Record both in `docs/releasing.md`.
- [ ] **Step 5: The three mutations from the spec, once each, in CI.** Use a temporary commit on
  the branch for each, then revert:
  - the mac copy signed without `app-sandbox` → FAIL on confinement;
  - the Windows launch made direct, not through the alias → FAIL on identity;
  - `network.client` removed → FAIL on the Connect check (mac).

  Record each run ID. Revert each commit, check the tree matches the commit before the mutation,
  and push.

### Task 8: remove the spike, docs, and the merge gate

- [ ] **Step 1:** Delete `scripts/spike/` and the `spike` job and input from `package.yml`. Add a
  test to `workflow.test.ts` that no job named `spike` exists, and that `inputs` has only `sign`.
- [ ] **Step 2: Docs.**
  - In `docs/releasing.md`, a section "Store probe". It covers:
    - what is built and launched on each OS, and that none of it is uploaded;
    - the confinement proofs;
    - Task 0's spike results;
    - the cost figure;
    - the mutation run IDs;
    - **the rule** from spec section 4, verbatim in substance;
    - that the identity values are placeholders until piece 3.
  - HANDOFF: the START HERE entry, plus the three-piece store plan (probe done, parity checklist
    next, submission at parity).
  - README: one line under the roadmap.
  - `scriv create`: an *Other changes* fragment ("CI builds and launches sandboxed App Store and
    MSIX stand-ins").
- [ ] **Step 3: Gate:** `npm ci`, `npm run build`, `npm run typecheck`, `npm test` (each its own
  step). Push, dispatch `sign=false`, and require all green.
- [ ] **Step 4:** Ask the user about merging (`--no-ff`, as before).
