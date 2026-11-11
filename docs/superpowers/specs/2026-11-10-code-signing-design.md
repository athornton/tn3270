# Code signing for release installers — design

Date: 2026-11-10. Status: approved in conversation, awaiting written-spec review.

## Goal

Release builds ship a **signed, notarized, stapled macOS app** and a **signed Windows
installer and app**, so users get past Gatekeeper and SmartScreen without the *Open Anyway* /
*Run anyway* steps. Only the macOS and Windows installers change. Linux artifacts and the npm
packages are not touched.

## Decisions (from the user, 2026-11-10)

- **Windows: Azure Artifact Signing** (formerly Trusted Signing), through electron-builder's
  `win.azureSignOptions`. It is not a CA certificate and not a Store account.
- **macOS notarization: an App Store Connect API key** (`.p8`, Key ID, Issuer ID), not an Apple ID
  and app-specific password.
- **Nothing has been created yet** on either side. The docs include a setup walkthrough.
- **Only release builds are signed.** That means `vX.Y.Z` tag pushes, plus `workflow_dispatch` when
  its new `sign` input is true. Pushes to main and PRs stay unsigned. Credentials live in a new
  GitHub environment, `signing`, which has **no required reviewer** (the `npm` environment's
  approval is still the release's single human gate).
- **Approach 1:** electron-builder's built-in signing, inside the existing `macos-latest` and
  `windows-latest` matrix jobs, with no separate signing job and no custom sign hooks. The
  existing package smoke then launches the **signed** artifacts.

## Facts checked against electron-builder 26.18.0 (`node_modules/app-builder-lib`)

- Notarization runs only if `APPLE_API_KEY` (a **path** to the `.p8`), `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER` are all set (`mac/MacTargetHelper.js` `getNotarizeOptions`). If none are set,
  it is **skipped silently**. A partial set throws.
- Notarization runs on the **`.app`** right after signing (`macPackager.js`, `notarizeIfProvided`
  after `doSign`), before the dmg and zip targets are built. So the app inside both containers is
  already notarized and stapled.
- `dmg.sign` defaults to `false`, and the scheme says signing the dmg "will lead to unwanted errors
  in combination with notarization". We keep the default: **the dmg is not signed**.
- Hardened runtime defaults to on for non-MAS builds. The default entitlements file
  (`templates/entitlements.mac.plist`) grants `allow-jit`, `allow-unsigned-executable-memory` and
  `disable-library-validation`. We use it as it is and do not add a file of our own.
- `win.azureSignOptions` requires `endpoint`, `codeSigningAccountName`, `certificateProfileName`
  and `publisherName`. Signing installs the `TrustedSigning` PowerShell module and runs
  `Invoke-TrustedSigning` on each file (`codeSign/windowsSignAzureManager.js`). If the key is
  present, **every** Windows build signs, so the key must only appear in signing mode.
- On macOS, `CSC_LINK` (a base64 `.p12`) plus `CSC_KEY_PASSWORD` is imported into a temporary
  keychain.

## Design

### 1. One switch in `packages/gui/electron-builder.cjs`

`TN3270_SIGN=1` turns signing mode on. Any other value, or no value, means unsigned mode.

- **Unsigned mode (the default; every local build and every non-release CI run):** this is
  today's config, unchanged. `mac.identity: null`, no `azureSignOptions`, and
  `mac.notarize: false`, so a stray `APPLE_*` variable cannot start notarization by accident.
- **Signing mode:** `mac.identity` is left unset, so the `CSC_LINK` keychain supplies it.
  Notarization is left on. `win.azureSignOptions` is built from environment variables. Before
  returning the config, the file **throws an error naming every missing variable** for the
  platform being built. On mac those are `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
  `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. On Windows they are `AZURE_SIGNING_ENDPOINT`,
  `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and `AZURE_SIGNING_PUBLISHER`. This closes the
  silent-notarization-skip gap at config time.

The decision logic lives in a small pure function (`signingConfig(env, platform)` or similar).
It takes the environment as an argument, so it is unit-testable without electron-builder.

### 2. CI (`.github/workflows/package.yml`)

- The global `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` stays. In signing mode, the mac job overrides
  it to `true` at step level.
- Each matrix entry gets `sign: true` on `macos-latest` and `windows-latest` only. The
  `macos-26-intel` job stays unsigned: it exists to launch the x64 slice and is never uploaded.
- A job-level `signing` expression is true when `matrix.sign` is set **and** (the ref is a `v*` tag
  **or** the run is a dispatch with `inputs.sign == true`). When it is true, the job runs in
  `environment: signing`. When it is false, the job uses no environment. **The plan's first task
  measures** whether an empty-string `environment:` really means "no environment" on GitHub. If it
  does not, the plan uses the fallback of two job definitions sharing one steps file.
- **Mac signing-mode steps:** write the `.p8` from secret `APPLE_API_KEY_P8` into `$RUNNER_TEMP`
  and export its path as `APPLE_API_KEY`. Set `CSC_LINK` and `CSC_KEY_PASSWORD` from secrets
  (`MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` and `APPLE_TEAM_ID` (read by
  the verifier) from environment variables, and `TN3270_SIGN=1`.
- **Windows signing-mode steps:** run `azure/login` with OIDC, using `AZURE_CLIENT_ID`,
  `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` environment variables and no client secret. The job
  gains `permissions: id-token: write`, and the federated credential's subject is
  `repo:athornton/tn3270:environment:signing`. The `AZURE_SIGNING_*` values come from environment
  variables; none of them are secret, since they appear in every signature. Then `TN3270_SIGN=1`.
  `Invoke-TrustedSigning`'s credential chain is expected to pick up the Azure CLI login. **That is
  an expectation, not a measurement:** the first signed dispatch run proves it. If it fails, the
  fallback is a client secret through `EnvironmentCredential` (`AZURE_CLIENT_SECRET`).
- **Environment `signing`:** deployment refs restricted to tags `v*.*.*` and branch `main`. While
  this branch is being proven, a temporary rule for `signing` is added and then removed at merge.
- `workflow_dispatch` gains a boolean input `sign`, default `false`.

### 3. Verification: `scripts/verify-signatures.mjs`, fail-closed both ways

A dependency-free script with two modes, `--expect signed` and `--expect unsigned`, run on
`artifacts/gui`.

- **macOS:** mount the dmg read-only and unzip the zip into a temporary directory. For **each**
  contained `TN3270.app`, run `codesign --verify --deep --strict`, read
  `codesign -dv --verbose=4` (Authority must start with `Developer ID Application:` and must name
  `APPLE_TEAM_ID`, with `flags` including `runtime`), run `spctl -a -t exec -vv` (accepted, source
  Notarized Developer ID) and `xcrun stapler validate`. The dmg itself is checked to exist and is
  not required to be signed.
- **Windows:** `Get-AuthenticodeSignature` (through `pwsh`, as JSON) on the NSIS installer. It
  also extracts the installer's `app-64.7z` with electron-builder's cached 7zz (as was done to check
  the icon) and runs the same check on `TN3270.exe` inside. Status must be `Valid`, and the signer
  subject must contain `AZURE_SIGNING_PUBLISHER`.
- **`--expect unsigned`** requires each check above to *fail* in the expected way (no signature, or
  an ad-hoc/linker signature on Apple silicon). It runs on **every** non-signing push and PR on the
  mac and Windows jobs, so the verifier is proven to reject unsigned builds on every push, not
  just once.
- Which mode runs is decided by **the ref, not by the `signing` expression**. On a `v*` tag the
  step always runs with `--expect signed`, so a broken `signing` expression fails the tag run
  instead of shipping unsigned installers. On a dispatch with `sign`, it uses `--expect signed`.
  Everywhere else it uses `--expect unsigned`.
- Output parsing (codesign's `-dv` text, the Authenticode JSON) lives in pure functions with unit
  tests built from real captured output. The captures come from the first signed run and are
  committed as fixtures.

`release-check` already `needs: package`, so a failed verification blocks npm publish and the
GitHub release with no new wiring.

### 4. Docs

- `docs/releasing.md`: a **setup walkthrough**, with each step showing where to click:
  - Apple: CSR in Keychain Access → Developer ID Application certificate → export `.p12` →
    App Store Connect API key (Developer role) → secrets and variables.
  - Azure: Artifact Signing account → identity validation (done) → certificate profile → app
    registration + role *Artifact Signing Certificate Profile Signer* on the profile → federated
    credential for environment `signing` → variables.
  - A table of every secret and variable in environment `signing`, with what reads each one.
  - Rotating and revoking the certificate, key and app registration.
  - The *Unsigned-app notes* section is rewritten: release installers are signed, and CI artifacts
    from main and PRs are not, so the workarounds still apply to those.
- README and HANDOFF: replace the "UNSIGNED" claims, scoped to release installers. Fix the
  README's stale "currently 0.1.3" while there (0.1.4 is out).
- A scriv fragment for the next release.

## Testing

- Unit: `signingConfig` in both modes, missing-variable errors per platform, and that unsigned
  mode sets `identity: null`, `notarize: false` and no `azureSignOptions`. Also the verifier's
  parsers, from captured fixtures.
- Continuous: the `--expect unsigned` verifier run on every push (see section 3).
- Proof before merge: a `workflow_dispatch` with `sign: true` on this branch, with the verifier
  passing `--expect signed` and the package smoke launching the signed app on both OSes.
- Mutation: with credentials present, break one input (for example, unset `APPLE_API_ISSUER` in
  the dispatch) and confirm the job fails at config time with the variable named. Do this once
  and record it.
- **Owed live (the user):** download the signed release dmg, zip and exe on a real Mac and a
  real Windows box and confirm there is no Gatekeeper or SmartScreen warning. SmartScreen
  reputation for a new Artifact Signing identity may still warn at first. If so, record it and
  do not treat it as a defect.

## Known gaps and risks

- The x64 slice of the signed universal app is checked by `codesign`/`spctl` but **not
  launched**, because the Intel job builds its own unsigned copy.
- The dmg is unsigned by design. If a current macOS warns on opening it after download, the
  follow-up is to sign and notarize the dmg with `notarytool` after the build. That is out of
  scope unless the live check shows it is needed.
- Azure Artifact Signing is billed per signing account (the Basic tier has a monthly signature
  quota). Release-only signing keeps use to a handful of signatures per release (the app exe, the
  uninstaller, the installer, and any other `.exe` electron-builder signs; counted on the first run).

## Out of scope

Linux signing (AppImage/deb GPG), the Microsoft Store/MSIX, auto-update signature verification,
and signing the dmg.

## Amendment 2026-11-11: Windows CI signing dropped

**Decision (the owner, 2026-11-11):** Windows is not signed in CI. The design above signed the
NSIS installer through Azure Artifact Signing, but the owner has no Azure subscription and has
decided not to use Azure. Windows is instead to ship through the **Microsoft Store as an MSIX**,
which Microsoft signs: a later, separately designed project (this spec's *Out of scope* listed
it). The unsigned NSIS `.exe` stays a GitHub release artifact for people who prefer it.

**Why it had to change now, not later:** with `sign: true` on `windows-latest`, every `v*` tag run
would have run `azure/login` with no Azure app behind it, failed the package job, and so blocked
the release, because `release-check` `needs: package`.

**What changes** (supersedes the Windows parts of sections 2-4 and of *Testing*):

- `windows-latest` loses `sign: true` and gets a new matrix key, `verify: unsigned`. A separate
  verify step (`if: matrix.verify`) runs `verify-signatures.mjs --expect ${{ matrix.verify }}` on
  every run, tags included, so a half-configured signing setup that signs anyway is a failure.
  macOS is unchanged: `sign: true` on `macos-latest`, and its verify mode still comes from the ref
  and the dispatch input alone, never `matrix.sign`.
- The `azure/login` step, the `AZURE_SIGNING_*` env on package:gui and the verify step, and the
  package job's `id-token: write` (azure/login was its only user; `publish` has its own) are
  removed.
- Kept, inert and unit-tested: `signing.cjs`'s win32 branch (`azureSignOptions`) and the
  verifier's Windows `signed` mode. Both say in their comments that CI does not use them.
- The release-notes header says the Windows installer is unsigned, with SmartScreen's *More info
  → Run anyway*. The docs move the Azure walkthrough to an *Abandoned* note
  (`docs/releasing.md`).
- The *Owed live* check is now the signed mac dmg and zip only; the Azure billing risk under
  *Known gaps* no longer applies.

macOS signing is unaffected and proven: CI run 42959265358 signed, notarized, stapled, verified
and launched the app.
