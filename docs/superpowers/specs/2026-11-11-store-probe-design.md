# Store stand-ins as an early warning ("store probe") — design

Date: 2026-11-11. Status: approved in conversation, awaiting written-spec review.

## Where this sits

The user's 2026-11-11 decisions:

- Windows goes to the **Microsoft Store** as an MSIX, which Microsoft signs. The user has a
  Partner Center (Store) developer account. Azure Artifact Signing is abandoned (code signing spec,
  amendment 2026-11-11). The **unsigned NSIS `.exe` stays a GitHub release artifact**.
- macOS goes to the **Mac App Store** as well.
- **Nothing goes into either store before feature parity with x3270.** The 026 punch is optional.
- **Store releases are a chosen subset of GitHub releases**, not every version.

The work is split into three pieces, in this order:

1. **Store probe (this spec).** Every CI run builds stand-ins that reproduce each store's
   confinement, and launches them, so a feature that breaks under the sandbox or MSIX fails the
   PR that adds it. Nothing is submitted.
2. **Parity checklist.** Each x3270 feature is marked ours, missing or deliberately skipped. This
   is the store gate. It is a separate spec.
3. **Submission.** Name reservation, real identities, the `mas` target with its certificates and
   provisioning profile, how a release is marked for the stores, and listings. It is a separate
   spec, written when parity is near. Option A from the conversation applies there: the tag run
   builds the store packages, and the user uploads them by hand.

## Goal

On every CI run (PRs and main pushes), the `macos-latest` and `windows-latest` jobs build and
launch a store stand-in. The stand-in must:

- prove that its confinement is really in effect;
- pass the same two checks as `scripts/package-smoke.mjs`: replay the trace and draw the golden,
  and with no host, have the Connect dialog connect.

The stand-ins are never uploaded or released.

## Facts (electron-builder 26.18.0, `node_modules/app-builder-lib`)

- The `appx` target (`out/targets/AppxTarget.js`) builds on Windows with `makeappx.exe pack` from
  electron-builder's bundled Windows SDK tools. It names its output with the `appx` extension.
  It needs `identityName`, `publisher` and `publisherDisplayName`, which must match Partner Center
  at submission (piece 3).
- The default manifest (`templates/appx/appxmanifest.xml`) declares
  `EntryPoint="Windows.FullTrustApplication"`. So the MSIX is not a strict sandbox: it gets
  package identity, and AppData and registry writes are redirected. The macOS App Sandbox is the
  strict one.
- electron-builder ships **no** Mac App Store entitlements (`templates/` holds only
  `entitlements.mac.plist`), so we provide our own.
- The appx options include `customExtensionsPath`, which adds XML to the manifest's `Extensions`.

## Design

### 1. What gets built

- **macOS (`macos-latest`, every run).** After `package:gui`, `scripts/store-probe.mjs` copies
  `TN3270.app` from the universal zip and ad-hoc re-signs the copy with
  `codesign --force --deep -s -` and two new entitlements files:
  - `packages/gui/resources/entitlements.mas.plist`: `com.apple.security.app-sandbox`,
    `com.apple.security.network.client` (outbound telnet and TLS),
    `com.apple.security.files.user-selected.read-write` (the file-transfer dialogs), and the JIT
    entitlements Electron needs (`cs.allow-jit`, `cs.allow-unsigned-executable-memory`, as in the
    Developer ID file);
  - `packages/gui/resources/entitlements.mas.inherit.plist`: `app-sandbox` and `inherit`, for
    Electron's helper processes.

  The helpers are signed with the inherit file and the main app with the main file. The exact
  order and flags follow what @electron/osx-sign does for `mas`, read from its source in
  `node_modules` and not from memory.
  **To measure first:** that macOS enforces the App Sandbox for an ad-hoc-signed app launched
  from the runner's shell. Section 2's container check is the measurement.
- **Windows (`windows-latest`, every run).** `electron-builder.cjs` gains an `appx` target next to
  `nsis` (x64), with **placeholder** identity values that are named as placeholders in the config
  and replaced in piece 3:
  - `identityName` `TN3270.Probe`;
  - `publisher` `CN=TN3270 Store Probe`;
  - `publisherDisplayName` `TN3270 store probe`.

  A `customExtensionsPath` file adds a `uap5:AppExecutionAlias` named `tn3270-gui.exe`, because
  the smoke passes command-line arguments, and an alias is the documented way to start a packaged
  app with arguments and package identity. The probe then:
  1. makes a throwaway self-signed certificate in the job (`New-SelfSignedCertificate`, subject
     equal to the placeholder publisher, code-signing EKU);
  2. signs the `.appx` with `signtool` from electron-builder's bundled kit;
  3. imports the certificate into `LocalMachine\TrustedPeople` on that runner only;
  4. runs `Add-AppxPackage`.
- **Never uploaded.** No `upload-artifact` path matches the `.appx` or the sandboxed copy, so the
  GitHub release and the workflow artifacts are unchanged.
  The `.appx` is written into `artifacts/gui/` beside the `.exe`. The `gui-windows-latest` upload
  lists extensions explicitly (`*.exe` and so on), so it is not picked up. If it ever were,
  `release-notes.mjs` `checkInstallers` refuses any `unexpected file` in a release, which is a
  second guard. The `appx` target also lengthens `package:gui` on Windows; that time counts
  toward section 3's cost figure. The NSIS `.exe`, the verifier and the
  signing are untouched.

### 2. The checks, in `scripts/store-probe.mjs`

The probe reuses `scripts/smoke-lib.mjs` (bounded launches, kill by PID, `judgeShot`). Every launch
passes `CAPTURE_SWITCHES`.

- **Confinement first. Without it nothing else counts.**
  - macOS: `codesign -d --entitlements :- <copy>` must show `com.apple.security.app-sandbox`
    true. After the first launch, `~/Library/Containers/io.github.athornton.tn3270/` must exist.
    If it does not, the app was not sandboxed, and the probe FAILs.
  - Windows: `Get-AppxPackage` must list the package, and its `PackageFamilyName` is recorded.
    The process started through the alias must have package identity, shown by the app reporting
    Electron's `process.windowsStore` as true. **To measure first:** that `process.windowsStore`
    is set for this alias launch, and how the app reports it. Electron documents it as true
    inside an AppX or MSIX. If it is not usable, the fallback is a PowerShell query of the
    process's package full name.
- **Check 1, the golden.** Replay `synthetic-ispf-like.trace` with shot.mjs case 1's argv, and
  match the same golden hash as package-smoke.
  - macOS: the trace and the user-data directory are staged inside the container (`Data/` under
    it) before the replay launch, so the sandbox permits them. The container is created by the
    confinement launch above, which runs first. If staging into it turns out to be impossible
    from outside, the alternative is in the plan, not guessed here.
  - Windows: a full-trust MSIX reads the file system normally. The user-data directory is a fresh
    temporary directory, as in package-smoke.
- **Check 2, the Connect dialog.** Launched with no host, the dialog's submit reaches a throwaway
  telnet server (`IAC WILL TERMINAL-TYPE` in reply to `IAC DO TERMINAL-TYPE`). Under the sandbox
  this is only allowed by `network.client`, which shows the entitlement is necessary and enough.
- **Output and exits.** The probe prints `ok <route>: <check>` or `FAIL <route>: <reason>`. It
  exits 1 on any FAIL and 2 on a setup problem (a tool missing, the alias not registered). It never
  skips silently.
- **Cleanup on every path:** `Remove-AppxPackage`, removing the test certificate from
  `TrustedPeople` and the personal store, removing the container directory, and killing
  processes by PID (never by name).

### 3. CI

- A step `store probe` on `macos-latest` and `windows-latest`, chosen by a matrix key (for example
  `probe: true`). It runs on every event, after `package:gui` and the signature check, and it
  works in a copy, so the signed or unsigned artifacts that get uploaded are never modified.
- It runs on tags too. A tag whose probe fails does not release, because `release-check` needs
  `package`.
- **Cost:** the first green run records the seconds the step adds on each OS, and the docs record
  the figure. That is the user's input for reconsidering "every run".

### 4. The rule, in `docs/releasing.md` and HANDOFF

Any feature that touches files outside the app's own data, starts other processes, or opens a new
kind of network connection adds a probe check here when it lands. Its PR names the entitlement or
capability it needs, or says why it needs none.

## Testing

- **Unit (vitest, any host):** the pure parts of `store-probe.mjs`, with injected I/O, as in
  `verify-signatures.mjs`:
  - parsing the entitlements output;
  - judging the container;
  - parsing the `Get-AppxPackage` and identity output;
  - building each OS's route with `posix` or `win32` paths chosen from the injected platform, so
    a Windows host cannot reproduce run 42844605289's path bug.

  The fixtures start hand-written, are marked provisional, and are replaced by captures from the
  first CI run.
- **`workflow.test.ts`:**
  - the probe step runs on exactly `macos-latest` and `windows-latest`, on every event, after
    `package:gui`;
  - no `upload-artifact` path includes `*.appx` or the sandboxed copy;
  - the NSIS and mac artifact uploads are unchanged.
- **`electron-builder.cjs` tests:** `win.target` holds both `nsis` and `appx`; the appx identity
  values are the named placeholders; the `customExtensionsPath` file exists and declares the alias.
- **Mutation, once each, in CI** (run IDs recorded in the docs):
  - re-sign the macOS copy **without** `app-sandbox`, and the probe must FAIL on the missing
    container;
  - launch the Windows exe from its install directory instead of through the alias, and the
    identity check must FAIL;
  - remove `network.client`, and check 2 must FAIL on macOS.

## Out of scope

- The real `mas` target, the Apple Distribution and Mac Installer Distribution certificates, and
  the provisioning profile.
- Reserving names in Partner Center and App Store Connect, and the real identity values.
- Submission, choosing which releases go to the stores, and store listings (piece 3).
- The x3270 parity checklist (piece 2).
- Feature probes beyond the two smoke checks. They are added by the rule in section 4 as features
  land.

## Risks

- macOS may not enforce the App Sandbox for an ad-hoc-signed app, or may need the entitlements
  applied in a way the plan has to find. The container check catches both, and the plan's first
  task measures it before anything is built on top.
- On a full-trust MSIX, `process.windowsStore` may not reflect an alias launch. The fallback is
  stated in section 2.
- The Windows job grows by an `appx` build, a sign, an install and two launches. The cost is
  measured and reported (section 3).
