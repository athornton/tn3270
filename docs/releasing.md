# Releasing

**Tag-triggered, as of 2026-11-09** (`docs/superpowers/specs/2026-11-09-npm-trusted-publishing-design.md`,
`docs/superpowers/plans/2026-11-09-npm-trusted-publishing.md`). Pushing a `vX.Y.Z` tag runs
`.github/workflows/package.yml`'s six matrix jobs on the tagged commit, then `release-check`
(fails a bad tag or a mismatched tarball set before anyone is asked to approve anything) and
`publish` (waits for one approval in the GitHub environment `npm`, then publishes over OIDC — no
npm token anywhere — and reads the registry back to prove every package actually landed), then
`github-release` (creates the GitHub release `vX.Y.Z` with the run's native installers, a
`SHA256SUMS` and notes built from `CHANGELOG.md`; see *The GitHub release* below). The
*Fallback* section below, run by hand, is what this replaces; keep it until the one-time setup's
last step (disallowing tokens) has happened on every package.

**npm publishing is proven end to end by release 0.1.3** (*Release history*). **The GitHub
release is not yet proven**: that is release 0.1.4, the first tag run with the `github-release`
job (`docs/superpowers/specs/2026-11-09-github-release-and-changelog-design.md`).

## One-time setup (done, 2026-11-09)

1. The GitHub environment `npm` (created with `gh api`): required reviewer `athornton`,
   self-review allowed (the same person pushes the tag and approves), deployments limited to
   tags matching `v*.*.*`.
2. On npmjs.com, each of the eight `@tn3270/*` packages' Settings → Trusted publishing → GitHub
   Actions: owner `athornton`, repository `tn3270`, workflow `package.yml`, environment `npm`.
   Done by the user, 2026-11-09: npm publish ON, dist-tag OFF, stage publish ON.
3. **Still to do, now that the first CI publish has actually worked** (0.1.3): on each package,
   Publishing access → "Require two-factor authentication and disallow tokens". Trusted
   publishers keep working after this; it is what finally retires the *Fallback* below, since a
   token-based `npm publish` would then be refused.

Renaming `.github/workflows/package.yml` or the `npm` GitHub environment breaks every one of the
eight trusted-publisher entries above — they name this file and that environment literally, not
"the packaging workflow" — with no warning until the next tag push fails.

## The changelog: a fragment with each change

`CHANGELOG.md` says what changed for users in each release; its entries are written by
[scriv](https://scriv.readthedocs.io/) (configuration `changelog.d/scriv.ini`, fragment template
`changelog.d/_template.md.jinja`), and the GitHub release's notes quote the version's entry.

- **With each functional change**, in the same commit: `uvx scriv create` writes a new fragment in
  `changelog.d/` from the template. Fill in the categories that apply (*Backwards-incompatible
  changes*, *New features*, *Bug fixes*, *Other changes*) with `- ` items in plain language for
  the user, delete the rest, and commit the fragment with the change. A change nobody using the
  packages or the installers would notice needs no fragment.
- **At release** (*Procedure*, step 1): `uvx scriv collect --version X.Y.Z` gathers every fragment
  into a new `## X.Y.Z (date)` entry at the top of `CHANGELOG.md`, keeping only the filled-in
  categories, and deletes the fragments. Read the entry, edit it if it needs it, commit it with the
  version bump.

`uvx` is uv's (`~/.local/bin/uvx` here); CI installs `scriv==1.8.1` with `pipx`.

## Procedure

1. **Bump the version.** All nine workspaces (eight published `@tn3270/*` packages plus the
   private root) move in lockstep — `scripts/set-version.mjs` rewrites every manifest's own
   `"version"`, every `@tn3270/*` dependency range, and `packages/core/src/index.ts`'s `VERSION`
   literal, computing every file's new contents before writing any of them so a malformed
   manifest cannot leave the tree half-bumped.

   ```sh
   npm run version:set -- X.Y.Z
   npm install        # updates package-lock.json to match
   uvx scriv collect --version X.Y.Z    # the changelog fragments become CHANGELOG.md's X.Y.Z entry
   ```

   `release-check` refuses a tag whose version has no `CHANGELOG.md` entry (or an entry with no
   `- ` item), and one with fragments left in `changelog.d/`, so skipping `collect` stops the
   release before the approval rather than after.

2. **Commit and push.**

   ```sh
   git add -A
   git commit -m "release: X.Y.Z"
   git push
   ```

3. **Wait for CI to go green** on that commit's `package` workflow run (all six matrix jobs).

4. **Tag it and push the tag.**

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   The tag push re-triggers `package.yml`: the six matrix jobs run again on the tagged commit
   (so the tarballs `release-check` and `publish` use come from a run that tested that exact
   commit under the tag), then `release-check`, then `publish`, then `github-release`.

   `release-check` refuses, before anyone is asked to approve: a tag that is not the manifests'
   version, or a tarball set that is not the eight packages at it (`publish.mjs --check`); a
   `gui-*` artifact set that is not exactly the seven installers of that version
   (`release-notes.mjs --check-installers`); and a changelog not ready for it (`release-notes.mjs
   --check-changelog`, above). All three are checked there because `npm publish` cannot be undone
   and `github-release` only runs after it.

5. **Approve.** In the Actions tab, the `publish` job run is waiting on the `npm` environment's
   required reviewer. Review it, approve it.

6. **Read the summary line.** `publish.mjs --publish`'s last line of output is
   `published X.Y.Z: N new, M already there, registry verified` — printed only once every
   tarball's `dist.shasum` has actually been read back from the registry. That line, not the exit
   code and not "npm publish didn't print an error", is the proof the 0.1.1 near-miss (below)
   shows was missing the first time: a release is not done until this line says so.

7. **Check the GitHub release.** `github-release` needs no second approval (the one on `publish`
   covers it). Its last line, `release-notes: vX.Y.Z holds exactly the 8 files of installers, each
   at its size and (where GitHub gives one) digest`, is printed only after the release has been
   read back. Look at the release page once: the notes, the seven installers and `SHA256SUMS`.

## The GitHub release

The `github-release` job (`needs: publish`, so a release never exists without its npm packages;
`contents: write`, its only write permission; no environment of its own) runs
`scripts/release-notes.mjs`, which holds every rule and is unit-tested
(`packages/core/test/releaseNotes.test.ts`):

- **Assets**: the run's `gui-*` artifacts, downloaded together — `TN3270-X.Y.Z-mac-universal.dmg`
  and `.zip`, `-linux-x86_64.AppImage`, `-linux-amd64.deb`, `-linux-arm64.AppImage`,
  `-linux-arm64.deb`, `-win-x64.exe` — exactly those seven, and `SHA256SUMS` over them
  (`sha256sum -c SHA256SUMS` compatible), written by `--compose`.
- **Notes** (`--compose`, written to `release-notes.md`): a fixed header (the `npm install -g`
  lines at X.Y.Z, which installer is for which system, a signing note, how to verify
  `SHA256SUMS` and the npm provenance). **Fixed for the first signed release**:
  `scripts/release-notes.mjs` now writes "**Signed.**", naming the Developer ID signature,
  notarization and stapling on macOS, Azure Artifact Signing on Windows, and that the Linux
  AppImage and `.deb` are not signed; the *Open Anyway*/*Run anyway* workarounds are gone from the
  header, and `packages/core/test/releaseNotes.test.ts` requires the new wording instead. `## What
  changed`, the version's `CHANGELOG.md` entry
  verbatim (`scriv print --version X.Y.Z`); `## Commits`, `git log --first-parent` since the
  previous release tag (the highest lower `vA.B.C` tag that is an ancestor), each subject
  markdown-escaped; `## Pull requests`, GitHub's generated list, only when it lists any (this
  repository merges by push, so usually not); and one compare link.
- **Create or update**: `gh release create vX.Y.Z --verify-tag` the first time; on a re-run,
  where the release already exists, `gh release edit` (the notes) and `gh release upload
  --clobber` (the assets).
- **Read back** (`--verify-release`): the release's assets must be exactly the local files, each
  uploaded, at the local size and, where GitHub reports a `digest`, the local sha256.

Every push also runs `release-notes.mjs --dry-run artifacts/gui` in the `ubuntu-latest` job,
after packaging: the same composition for that runner's own installers, no tag and no network,
with changelog problems (no entry for the current version, uncollected fragments) printed as
warnings — normal between releases.

## If the `publish` job fails

Diagnose from the log (`gh run view <id> --log`, or the Actions UI). `publish.mjs --publish` is
safe to re-run: a version already on the registry with identical bytes is skipped, not
re-published, and the first real failure names which packages were never attempted.

**The right recovery is "Re-run failed jobs", never "Re-run all jobs".** "Re-run all jobs" reruns
`package` too, which repacks the tarballs from scratch (`npm run pack:npm`) — and a freshly
packed tarball need not be byte-identical to the one `release-check` and `publish` already
validated (see below), so re-running everything can hand `publish` a *different* tarball than the
one the tag's original CI run tested, defeating the entire point of this design: that the
published bytes are exactly the ones CI built and tested. "Re-run failed jobs" keeps the original
run's `npm-tarballs` artifact and re-runs only the failed job (and anything after it) against it;
the re-run `publish` waits for approval again.

**A defect in the workflow file itself cannot be fixed by re-running:** a re-run replays the YAML
at the tagged commit. Fix it on `main` and release a new patch version, or publish the original
run's artifact by hand (*Fallback* below).

**If `github-release` fails** (npm publishing has already succeeded): "Re-run failed jobs" again.
It re-runs only that job, with no second approval (`publish` holds the environment). The job is
safe to repeat — it finds the release it may have half-made, even one left a DRAFT by a create
killed mid-upload, re-uploads every asset with `--clobber`, then rewrites the notes with
`--draft=false` — and it uses the run's original `gui-*` artifacts, the installers that run
tested. Its read-back names an asset on the release that this run did not make
(`gh release delete-asset vX.Y.Z NAME` removes it).

**If the `github-release` job itself is broken** (its YAML or `scripts/release-notes.mjs` at the
tagged commit), a re-run cannot help, and npm already holds X.Y.Z. Cut the release by hand from
the run's own artifacts, in a checkout of the tag:

```sh
gh run download RUN_ID -R athornton/tn3270 -p 'gui-*' -D installers   # then flatten installers/*/* into installers/
GITHUB_REF_NAME=vX.Y.Z GITHUB_REF_TYPE=tag GITHUB_REPOSITORY=athornton/tn3270 \
  node scripts/release-notes.mjs --compose installers        # needs scriv 1.8.1 on PATH, and gh logged in
gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file release-notes.md installers/*
GITHUB_REF_NAME=vX.Y.Z GITHUB_REF_TYPE=tag GITHUB_REPOSITORY=athornton/tn3270 \
  node scripts/release-notes.mjs --verify-release installers
```

## Why a tarball packed on a dev box can't match CI's byte-for-byte

`npm pack` writes each file's mode bits, read from the filesystem, into the tarball. A developer's
shell commonly has a umask that leaves ordinary files at `0640` (owner read/write, group read, no
world access); GitHub-hosted runners run with umask `022`, giving `0644`. Same file contents,
different tar header bytes, different sha1 for the whole `.tgz` — and the sha1 of the whole file
is exactly what `registryShasum`/`verifyReadBack` compare against the registry's `dist.shasum`.

So a tarball packed locally is not a substitute for CI's artifact, even from an identical commit,
even with identical source: `release-check`/`publish` would see it as a *different* release (not
missing, not identical — `decide()`'s `'conflict'`) if the registry already holds CI's bytes, or
it would simply be unverifiable against what CI tested. **Whenever a manual publish is standing in
for the automated path — recovering from a problem, or before the one-time setup above is
finished — the tarballs must be the tag's own green CI run's `npm-tarballs` artifact**, downloaded
and published as-is, never packed fresh on whatever machine is doing the publishing.

## Fallback: publish by hand

Until every package's "Require two-factor authentication and disallow tokens" (One-time setup,
step 3) is set, a token-based manual publish still works, so keep this as a fallback.

### Prerequisites

- An npm account with publish rights on the `@tn3270` org (the user owns it) and 2FA enabled —
  `npm publish` of a new package under a scoped org asks for a one-time code.
- `npm whoami` succeeds, and `npm access ls-packages @tn3270` (once anything has been published)
  shows you with write access.
- A clean working tree on the branch you are releasing from, with CI green on it.

### 1. Get the tarballs

**From the tag's own green CI run's `npm-tarballs` artifact** (`.github/workflows/package.yml`
uploads it from the `ubuntu-latest` job only, so the tarballs are not duplicated across runners) —
see *Why a tarball packed on a dev box can't match CI's byte-for-byte* above for why this is not
optional once a release has a tag. (Before the first tag/CI run for a version exists at all —
e.g. testing this procedure itself — build locally instead: `npm run build && npm run bundle:gui
&& npm run pack:npm`, writing `artifacts/npm/*.tgz`.)

`pack:npm` (`scripts/pack.mjs`) refuses before packing anything if `packages/gui/app/BUNDLED` is
missing, if any `dist/` holds a compiled file whose source is gone, or if any published package's
`dist/` is older than its own `src/` — so a tarball that exists is a tarball built from the source
it claims to be.

It also refuses, after packing, any tarball without `package/LICENSE`. npm packs a LICENSE only
from the package's own directory, so each `packages/*/LICENSE` is a tracked copy of the root one
(`packages/core/test/manifests.test.ts` fails if a copy differs). Edit the root `LICENSE` and
copy it into every package in the same commit.

Check the names actually produced:

```sh
ls artifacts/npm
```

The naming is `npm pack`'s own: `@tn3270/<name>@<version>` becomes
`tn3270-<name>-<version>.tgz` (the `@` dropped, the `/` replaced with `-`).

### 2. Publish, in dependency order

First a dry run of each, which publishes nothing and lists what would go up — check that
`LICENSE` is in every list:

```sh
for t in core frontend node-files canvas cli tui web gui; do
  npm publish --dry-run artifacts/npm/tn3270-$t-X.Y.Z.tgz
done
```

Then for real. The four library packages have no stable API and exist only because the front
ends depend on them, but npm still needs their tarball published before anything that names them
as a dependency. Each package's own `dependencies` (checked in every `packages/*/package.json`)
gives the order: `frontend` depends on `core`; `node-files` depends on `frontend`; `canvas`
depends on `core` and `frontend`; every front end (`cli`, `tui`, `web`, `gui`) depends on some
combination of all four. Publishing `core`, `frontend`, `node-files`, `canvas` in that order
satisfies every one of those edges before any front end needs it.

**A first 0.1.1 attempt published nothing, quietly.** The publishing machine was not logged in
(`npm whoami`: E401), so every `npm publish` in the loop failed, and an `npm unpublish` there
appeared to succeed while the registry did not change; it was noticed only because the registry
was checked afterwards. So: run `npm whoami` before the loop, end each loop body with `|| break`
so the first failure stops it, and check the registry (not the client's output) afterwards:

```sh
npm whoami        # must print the publishing account
for t in core frontend node-files canvas cli tui web gui; do npm publish artifacts/npm/tn3270-$t-X.Y.Z.tgz || break; done
```

Every manifest already sets `publishConfig.access: public` (checked by
`packages/core/test/manifests.test.ts`), so `npm publish` needs no `--access` flag even though
these are scoped packages.

### 3. Verify, on a clean machine

```sh
npm install -g @tn3270/tui
tn3270 --bogus     # exits 2, prints a usage error naming "unrecognized argument"
npm install -g @tn3270/gui
tn3270-gui ...     # first run prints "Downloading Electron binary..." and fetches it
```

That is the same shape `scripts/install-smoke.mjs` already checks against the unpublished
tarballs in CI — this step is the same check against the real registry.

## Native artifacts

electron-builder's output (macOS universal `.dmg`/`.zip`, Linux x64 and arm64 AppImage/`.deb`,
a Windows x64 NSIS installer) is uploaded by each packaging run as `gui-<os>` artifacts (one per
uploading runner: `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest` —
`macos-26-intel` builds the same universal mac app and does not re-upload it). A tag run attaches
them to the GitHub release `vX.Y.Z` (*The GitHub release* above). On a tag run the mac and Windows
installers are signed (*Code signing* below), and the Linux ones never are. There is no auto-update.

## Code signing (release installers)

**Built 2026-11-10 on branch `signing`; not yet run signed.** Spec
`docs/superpowers/specs/2026-11-10-code-signing-design.md`, plan
`docs/superpowers/plans/2026-11-10-code-signing.md`. Two matrix jobs carry `sign: true`:
`macos-latest` (the universal app) and `windows-latest` (the NSIS installer). They sign only on a
`v*` tag push, or on a `workflow_dispatch` with the `sign` input ticked. That run puts the job in
the GitHub environment `signing`, and every other run uses no environment. Every other job, and
every other run of those two, builds exactly as before: unsigned.

- **What decides it.** The package:gui step sets `TN3270_SIGN=1` and `packages/gui/signing.cjs`
  turns on signing mode. Before electron-builder starts, it throws an error naming every missing
  credential: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER` on macOS (with `APPLE_API_KEY` an existing file), and
  `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` and
  `AZURE_SIGNING_PUBLISHER` on Windows. It also sets `forceCodeSigning`, so an identity that cannot
  be found fails the build. Without it, electron-builder skips signing and notarization with no
  error.
- **What gets signed.** On macOS, the `.app` is signed with the Developer ID Application
  certificate (hardened runtime), notarized and stapled before the `.dmg` and `.zip` are built
  from it. **The `.dmg` itself is not signed**, by design: electron-builder's default, which its
  schema says avoids notarization errors. On Windows, electron-builder runs
  `Invoke-TrustedSigning` (the `TrustedSigning` PowerShell module, installed by app-builder-lib
  26.18.0) on each file it signs: the installer and the exes inside it.
- **What checks it.** `scripts/verify-signatures.mjs` runs after packaging on both jobs, on
  **every** run. The ref and the input pick the mode, not `matrix.sign`, so a broken signing
  expression fails a tag run instead of shipping unsigned installers. The mode is `--expect
  signed` on a tag or a signing dispatch, and `--expect unsigned` everywhere else. On macOS it
  checks the `TN3270.app` in both the `.zip` and the `.dmg`: `codesign --verify --deep --strict`,
  a `Developer ID Application: … (APPLE_TEAM_ID)` leaf with that `TeamIdentifier` and the runtime
  flag, `spctl` saying `source=Notarized Developer ID`, and `xcrun stapler validate`. On Windows
  it checks the installer, then silent-installs it as package-smoke does and checks the installed
  `TN3270.exe` and `Uninstall TN3270.exe`, then uninstalls. Each must be `Valid` with a signer
  `CN=` **equal to** `AZURE_SIGNING_PUBLISHER`. Each artifact prints one line,
  `ok <artifact>: signed` or `ok <artifact>: unsigned`. `VERIFY_SIGNATURES_ECHO=1` puts the raw
  tool output in the log.

**Not yet measured. The first signed run settles these. Write the answers here:**

- Whether `Invoke-TrustedSigning` picks up the `azure/login` session. Microsoft documents
  `DefaultAzureCredential`, which includes `AzureCliCredential`, for its signing clients. That page
  covers SignTool's dlib, not the `TrustedSigning` module by name. If it does not, the fallback is a
  client secret through `EnvironmentCredential`: a new `signing` secret `AZURE_CLIENT_SECRET`,
  plus `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` in the package:gui step's
  env, with the `azure/login` step removed. That is a workflow change, planned separately.
- Whether `azure/login` (OIDC, with `subscription-id`) succeeds when the app's only role
  assignment is on a certificate profile, not on the subscription.
- How many signatures a release costs: the number of `Invoke-TrustedSigning` calls in the Windows
  log. Write the count here.
- The exact signed wording of `codesign -dv`, `spctl` and `xcrun stapler validate`, and of the
  unsigned stapler answer. The verifier's patterns, and the fixtures marked PROVISIONAL, are still
  from memory. The run's captures replace them.
- Whether `environment: ''` really means no environment, so that no `signing` deployment is
  recorded on an ordinary push. This is the first push of this branch (plan Task 6).

### One-time setup: Apple

You need the Account Holder role for the certificate and an Admin account in App Store Connect for
the API key. Do this on a Mac, because the private key is made in, and exported from, your login
keychain.

1. **Certificate signing request.** Open Keychain Access (`/Applications/Utilities`) and choose
   **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate
   Authority**. For **User Email Address** use your address, for **Common Name** something like
   `tn3270 Developer ID`, and leave **CA Email Address** empty. Choose **Saved to disk** →
   **Continue**. This writes a `.certSigningRequest` file. The private key stays in the login
   keychain.
2. **Developer ID Application certificate.** Go to developer.apple.com → Account →
   **Certificates, Identifiers & Profiles** → **Certificates** → **+**. Under **Software**, select
   **Developer ID** → **Continue** → **Developer ID Application** → **Continue**. If you are asked
   for a *Developer ID Certificate Intermediary*, choose **G2 Sub-CA (Xcode 11.4.1 or later)**.
   **Choose File** (the CSR) → **Continue** → **Download** (a `.cer`). Double-click the `.cer` and
   it appears under **My Certificates** in the login keychain, named
   `Developer ID Application: <Name> (<TEAMID>)`. A team can hold up to five at a time.
   **Validity:** Apple's *Replace Developer ID certificates* page says "Certificates issued from G2
   are valid for one year and must be renewed annually" (checked 2026-11-10). The plan assumed
   five years. Read the actual expiry date off the certificate in Keychain Access and record it
   under *Rotation* below.
3. **Export the `.p12`.** In Keychain Access → login → **My Certificates**, expand the certificate
   and check that a private key is under it. If there is none, the export holds no key and signing
   fails. Right-click the certificate → **Export** → format **Personal Information Exchange
   (.p12)** → set a password. The base64 of that file is `MAC_CERT_P12_BASE64`, and the password
   is `MAC_CERT_PASSWORD` (commands under *GitHub* below). Delete the `.p12` once both are set.
4. **Team ID.** This is the ten characters in parentheses in the certificate's name:
   `APPLE_TEAM_ID`. The verifier requires the leaf authority to end in `(<TEAMID>)` and
   `TeamIdentifier` to equal it.
5. **App Store Connect API key, for notarization.** Go to appstoreconnect.apple.com → **Users and
   Access** → **Integrations** tab → **App Store Connect API** (left column) → **Team Keys** →
   **Generate API Key** (or **+** if a key already exists). Name it `tn3270-notarize`, set
   **Access** to **Developer**, and click **Generate**. Click **Download API Key** to get
   `AuthKey_<KEYID>.p8`. **It can be downloaded once only.** Apple keeps no copy, so a lost key
   means revoking it and generating another. The file's contents are `APPLE_API_KEY_P8`, the
   key's **Key ID** is `APPLE_API_KEY_ID`, and the **Issuer ID** shown on the same Team Keys page
   is `APPLE_API_ISSUER`. *Not confirmed:* Apple's pages say only that "the key ID and other
   information appear on the page" without placing the Issuer ID, and none of the pages read here
   names the minimum role notarization needs. *Developer* is the plan's choice. If notarization is
   refused for permissions, that is the first thing to check.

### One-time setup: Azure

The identity validation is already approved. You need Contributor (or Owner) on the Artifact
Signing account to create the profile, and Owner or User Access Administrator to assign the role.

1. **Check the validation.** Go to portal.azure.com, search for **Artifact Signing Accounts**, and
   open the account → **Objects** → **Identity validations**. Its status must be **Completed**,
   and it must be a **Public** validation, because only those can back a *Public Trust* profile.
2. **Certificate profile.** In the same account → **Objects** → **Certificate profiles** →
   **Create** → **Public Trust**. Enter a **Certificate Profile Name** (5-100 alphanumeric
   characters, unique in the account): `AZURE_SIGNING_PROFILE`. Leave **Program Type** at *None*.
   For **Verified CN and O**, pick the completed validation. Leave *Include street address* and
   *Include postal code* off unless you want them in every signature. Click **Create**.
   - The account's name is `AZURE_SIGNING_ACCOUNT`.
   - `AZURE_SIGNING_ENDPOINT` is the endpoint of the region the account was created in, in the
     form `https://<region code>.codesigning.azure.net`, for example `https://eus.codesigning.azure.net`
     for East US or `https://wus2.codesigning.azure.net` for West US 2. Microsoft's quickstart has
     the full table. The plan called this the account's *Account URI*, and if the account's
     **Overview** shows one, it should be the same URL. Microsoft's docs give only the region
     table, so check the two against each other. A region mismatch fails signing with
     `403 Forbidden`.
3. **Publisher.** The profile's **Certificate Subject Preview** (also on the profile's page once it
   is created) shows `CN=…`. Everything after `CN=`, up to the comma and exactly as written, is
   `AZURE_SIGNING_PUBLISHER`. electron-builder requires it as `azureSignOptions.publisherName`.
   app-builder-lib 26.18.0 does not pass it to `Invoke-TrustedSigning`, so the verifier is what
   holds it to the certificate: the signer's `CN=` must **equal** it.
4. **App registration.** Go to entra.microsoft.com (or portal → **Microsoft Entra ID**) → **App
   registrations** → **New registration**. Name it `tn3270-signing`, choose single tenant, add no
   redirect URI, and click **Register**. On its **Overview**, **Application (client) ID** is
   `AZURE_CLIENT_ID` and **Directory (tenant) ID** is `AZURE_TENANT_ID`. The ID of the subscription
   holding the Artifact Signing account (portal → **Subscriptions**) is `AZURE_SUBSCRIPTION_ID`.
   Create **no client secret** (but see *Not yet measured*).
5. **Federated credential.** In the app → **Certificates & secrets** → **Federated credentials**
   tab → **Add credential**:
   - **Federated credential scenario:** *GitHub Actions deploying Azure resources*.
   - **Organization** `athornton`, **Repository** `tn3270`.
   - **Entity type** *Environment*, **GitHub environment name** `signing`.
   - **Name** `tn3270-signing-environment`.

   The subject fills itself in as `repo:athornton/tn3270:environment:signing`, with audience
   `api://AzureADTokenExchange`. Click **Add**. A wrong subject is accepted here without complaint
   and only fails at the token exchange, so check that it reads exactly this. Because the
   credential trusts only that environment, a token from any other job is refused.
6. **Role on the certificate profile.** The role is **Artifact Signing Certificate Profile
   Signer**. That is Microsoft's name for it since the rename from Trusted Signing (*Tutorial:
   Assign roles in Artifact Signing*, updated 2026-08-03). Before the rename it was *Trusted
   Signing Certificate Profile Signer*. **Write down the name the portal actually shows.**
   Microsoft's tutorial gives the portal route only at **account** scope (account → **Access
   control (IAM)** → **Add** → **Add role assignment**), which would let the app sign with every
   profile in the account. For the profile alone, it gives the Azure CLI:

   ```sh
   az role assignment create --assignee-object-id <service principal object ID> \
     --assignee-principal-type ServicePrincipal \
     --role "Artifact Signing Certificate Profile Signer" \
     --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>"
   ```

   The service principal's object ID is under **Enterprise applications** → `tn3270-signing` →
   **Object ID**. It is *not* the Object ID on the app registration's Overview. If the profile's
   own page in the portal has **Access control (IAM)**, assigning the role there does the same
   thing.

### One-time setup: GitHub

**The environment** `signing` has **no required reviewer**: a signing run must not wait for
anyone. Its deployment refs are limited to tags `v*.*.*` and branch `main`, plus a **temporary**
`signing` branch rule while this branch is being proven, removed at merge (plan Task 10):

```sh
/usr/bin/gh api -X PUT repos/athornton/tn3270/environments/signing \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
/usr/bin/gh api -X POST repos/athornton/tn3270/environments/signing/deployment-branch-policies -f name='v*.*.*' -f type=tag
/usr/bin/gh api -X POST repos/athornton/tn3270/environments/signing/deployment-branch-policies -f name=main -f type=branch
/usr/bin/gh api -X POST repos/athornton/tn3270/environments/signing/deployment-branch-policies -f name=signing -f type=branch   # TEMPORARY
```

**The secrets.** Set them on the Mac that holds the files. `gh secret set` reads the value from
stdin when there is no `--body`, so no value appears in shell history or in the process list:

```sh
base64 -i tn3270-devid.p12 | /usr/bin/gh secret set MAC_CERT_P12_BASE64 --env signing
/usr/bin/gh secret set MAC_CERT_PASSWORD --env signing          # prompts for the .p12 password
/usr/bin/gh secret set APPLE_API_KEY_P8 --env signing < AuthKey_XXXXXXXXXX.p8
```

**The variables.** None of these are secret. The team ID and the publisher are in every
signature, and the Azure IDs and names grant nothing without a token from this environment's
federated credential.

```sh
/usr/bin/gh variable set APPLE_TEAM_ID           --env signing --body XXXXXXXXXX
/usr/bin/gh variable set APPLE_API_KEY_ID        --env signing --body XXXXXXXXXX
/usr/bin/gh variable set APPLE_API_ISSUER        --env signing --body xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
/usr/bin/gh variable set AZURE_CLIENT_ID         --env signing --body xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
/usr/bin/gh variable set AZURE_TENANT_ID         --env signing --body xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
/usr/bin/gh variable set AZURE_SUBSCRIPTION_ID   --env signing --body xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
/usr/bin/gh variable set AZURE_SIGNING_ENDPOINT  --env signing --body https://<region>.codesigning.azure.net
/usr/bin/gh variable set AZURE_SIGNING_ACCOUNT   --env signing --body <account name>
/usr/bin/gh variable set AZURE_SIGNING_PROFILE   --env signing --body <profile name>
/usr/bin/gh variable set AZURE_SIGNING_PUBLISHER --env signing --body '<CN, exactly>'
```

Check the names (never the values): `/usr/bin/gh secret list --env signing` must list exactly the
3 secrets, and `/usr/bin/gh variable list --env signing` exactly the 10 variables.

| Name | Kind | What it is | Read by (in `.github/workflows/package.yml` unless noted) |
| --- | --- | --- | --- |
| `MAC_CERT_P12_BASE64` | **secret** | base64 of the exported Developer ID Application `.p12` (certificate and private key) | package:gui step, as `CSC_LINK`. electron-builder decodes it into a temporary keychain. `signing.cjs` requires it. |
| `MAC_CERT_PASSWORD` | **secret** | the `.p12` export password | package:gui step, as `CSC_KEY_PASSWORD`. `signing.cjs` requires it. |
| `APPLE_API_KEY_P8` | **secret** | contents of `AuthKey_<KEYID>.p8` | step *notarization key (.p8) into RUNNER_TEMP*, which writes `$RUNNER_TEMP/AuthKey.p8` and exports its **path** as `APPLE_API_KEY`. `signing.cjs` requires that path to exist. Notarization uses it. |
| `APPLE_TEAM_ID` | variable | the ten-character team ID | *verify signatures* step only: the leaf's `(<TEAMID>)` and `TeamIdentifier` must match |
| `APPLE_API_KEY_ID` | variable | the API key's Key ID | package:gui step. `signing.cjs` requires it. Notarization uses it. |
| `APPLE_API_ISSUER` | variable | the Team Keys page's Issuer ID | package:gui step. `signing.cjs` requires it. Notarization uses it. |
| `AZURE_CLIENT_ID` | variable | the app registration's Application (client) ID | *Azure login (OIDC) for Artifact Signing* step (`azure/login`) |
| `AZURE_TENANT_ID` | variable | Directory (tenant) ID | *Azure login* step |
| `AZURE_SUBSCRIPTION_ID` | variable | the subscription holding the Artifact Signing account | *Azure login* step |
| `AZURE_SIGNING_ENDPOINT` | variable | the account region's endpoint, `https://<region>.codesigning.azure.net` | package:gui step → `signing.cjs` → `azureSignOptions.endpoint` → `Invoke-TrustedSigning` |
| `AZURE_SIGNING_ACCOUNT` | variable | the Artifact Signing account name | package:gui step → `signing.cjs` → `codeSigningAccountName` |
| `AZURE_SIGNING_PROFILE` | variable | the certificate profile name | package:gui step → `signing.cjs` → `certificateProfileName` |
| `AZURE_SIGNING_PUBLISHER` | variable | the validated CN, exactly as on the certificate | package:gui step → `signing.cjs` → `publisherName`. Also the *verify signatures* step, where the signer's `CN=` must equal it. |

`azure/login` is pinned to commit `a641126d1b8aa4d1fa005f4f92df94a3a4c4c906` (v3.1.0), not a
tag. It is the workflow's only third-party action, and it is handed an OIDC token. The job's
`id-token: write` permission exists for it.

### A signing proof, without a release

```sh
/usr/bin/gh workflow run package.yml --ref <branch> -f sign=true
/usr/bin/gh run list --workflow package.yml --branch <branch> --limit 1    # then: /usr/bin/gh run watch <id> --exit-status
```

`<branch>` must be one the `signing` environment allows: `main`, or `signing` while its temporary
rule exists. On any other branch, the two signing jobs fail on the environment's branch rule. Expect the mac and Windows jobs green,
with `ok …: signed` for the zip's app, the dmg's app, the installer, `TN3270.exe` and
`Uninstall TN3270.exe`, and package-smoke passing on the signed artifacts. The other four jobs are
unaffected. A dispatch publishes nothing: `release-check`, `publish` and `github-release` run only
on a tag.

### Rotation and revocation

- **Developer ID certificate.** It expires one year after issue according to Apple's page for G2
  (see Apple step 2). Record the real date here at setup. Before it expires, repeat Apple steps
  1-3 and re-set `MAC_CERT_P12_BASE64` and `MAC_CERT_PASSWORD`. Apps signed and notarized before
  the expiry keep installing and running. A new certificate is needed only to sign new builds. To
  **revoke** it (because the `.p12` leaked), go to Certificates, Identifiers & Profiles →
  **Certificates** → the certificate → **Revoke** (Account Holder or Admin). **Revocation is
  retroactive: Apple says a Developer ID app signed with a revoked certificate "can no longer be
  installed nor launch if it's already installed"**. Every released mac build signed with it stops
  working, so revoke only for a compromise, and cut a new release signed with the new certificate.
- **App Store Connect API key.** It has no expiry. Revoke it from **Users and Access** → the API
  keys list → **Revoke Key**. Apple's revocation page still says the **Keys** tab, while its
  key-creation page says **Integrations → App Store Connect API → Team Keys**, so use whichever
  the site shows. Then generate a new key (Apple step 5) and re-set `APPLE_API_KEY_P8`,
  `APPLE_API_KEY_ID` and, if it changed, `APPLE_API_ISSUER`.
- **Azure.** There is no long-lived secret to rotate: every run gets a fresh OIDC token, and
  Artifact Signing's certificates last three days, so each signature carries a timestamp
  (app-builder-lib's default, `http://timestamp.acs.microsoft.com`). To **stop CI from signing**, delete the federated credential (app →
  Certificates & secrets → Federated credentials → delete) or remove the role assignment. Both
  take effect without any repository change. Deleting the certificate profile also "stops any
  signing that's associated with" it. If the client-secret fallback is ever adopted, that secret
  has an expiry and is rotated in the app's **Certificates & secrets → Client secrets**.
- **GitHub.** Removing a secret or variable from the environment makes the next signing run fail at
  package:gui, with `signing.cjs` naming the missing variable. The plan's Task 8 uses that as a
  mutation check.

### Sources (checked 2026-11-10)

- Apple, *Create a certificate signing request*:
  <https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/>
- Apple, *Create Developer ID certificates*:
  <https://developer.apple.com/help/account/certificates/create-developer-id-certificates/>
- Apple, *Replace Developer ID certificates* (G2 Sub-CA choice, one-year validity):
  <https://developer.apple.com/help/account/certificates/replace-developer-id-certificates>
- Apple, *Certificates overview* (Account Holder or Admin creates distribution certificates):
  <https://developer.apple.com/help/account/certificates/certificates-overview/>
- Apple, *Revoke a certificate*: <https://developer.apple.com/help/account/certificates/revoke-a-certificate/>
- Apple, *Developer ID* (revocation stops installed apps):
  <https://developer.apple.com/support/developer-id/>, and *Certificates* (expiry does not):
  <https://developer.apple.com/support/certificates/>
- Apple, *Creating API keys for App Store Connect API* (path, Admin, download once):
  <https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api>,
  and *Revoking API keys*: <https://developer.apple.com/documentation/appstoreconnectapi/revoking-api-keys>
- Apple, *App Store Connect API* help (Team Keys roles):
  <https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/>
- Microsoft, *Quickstart: Set up Artifact Signing* (profiles, regional endpoints; updated
  2026-10-08): <https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>
- Microsoft, *Tutorial: Assign roles in Artifact Signing* (role names, scopes; updated 2026-08-03):
  <https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles>
- Microsoft, *Set up signing integrations* (endpoint must match region, `DefaultAzureCredential`,
  three-day certificates): <https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations>
- Microsoft Entra, *Create a trust relationship … external identity provider* (GitHub federated
  credential fields and subject): <https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust>
- `azure/login` README (OIDC inputs, `id-token: write`): <https://github.com/Azure/login>

The installed electron-builder (app-builder-lib 26.18.0, `node_modules/app-builder-lib/out`) was
read for `CSC_LINK` base64 decoding, the `APPLE_API_*` notarization variables and the
`TrustedSigning` module and `Invoke-TrustedSigning` call (with its default timestamp server).
Microsoft's integrations page now points to a PowerShell module named `ArtifactSigning`, but
app-builder-lib 26.18.0 still installs `TrustedSigning`.

## Unsigned-app notes: CI artifacts, and the dmg

**Release installers are signed** (*Code signing* above) from the first release built with this
setup. **Everything else is unsigned:** the `gui-*` artifacts of a push to main, a PR, any branch
push and a dispatch without `sign`. So are the Linux AppImages and `.deb`s in every case, and any
local `npm run package:gui`. Unsigned mode sets `identity: null` (from `signing.cjs`) and
`CSC_IDENTITY_AUTO_DISCOVERY: false` (the workflow's global env). That disables mac code signing
outright, which is not the same as an ad-hoc signature. The verifier's `--expect unsigned` accepts
either no signature or an ad-hoc one.

**The `.dmg` itself is never signed**, even in a release. That is electron-builder's default, kept
on purpose. The `TN3270.app` inside it, like the one in the `.zip`, is signed, notarized and
stapled. Gatekeeper judges the app, so a signed release needs none of the steps below.

For the unsigned builds, the workarounds still apply:

- **macOS**: Gatekeeper blocks a downloaded unsigned app. The route on current macOS is System
  Settings → Privacy & Security → *Open Anyway* after the first blocked launch, or
  `xattr -dr com.apple.quarantine /Applications/TN3270.app`. Checked by the user on 2026-11-08 on
  Apple Silicon: the fully unsigned build runs once permitted via *Open Anyway*. It is cumbersome,
  but not refused.
- **Windows**: SmartScreen flags the installer, and *More info → Run anyway* gets past it.

## Release history

What changed for users in each release is `CHANGELOG.md`; this records how each was released.

- **0.1.0**, 2026-11-08: tag `v0.1.0` (`c30ad98`), published by hand from CI run 42504570737's
  `npm-tarballs`. Every registry `dist.shasum` matches that artifact's tarball. (A `0.0.0-stage`
  version of each package had gone up 76 s earlier; it was deprecated "not a release" on
  2026-11-09.)
- **0.1.1**, 2026-11-09: tag `v0.1.1` (`e95b932`), published by hand from CI run 42563103808's
  `npm-tarballs`; every registry `dist.shasum` matches. In it: the GUI Connect dialog stays open
  and retries on failure; the TUI prompts for a host when given none at a terminal; a 30 s
  plaintext connect deadline; a down or misspelled host is worded as a connect failure even with
  TLS on; the Node floor is 20.19. Verified from the registry: `@tn3270/tui@0.1.1` installed on
  Node 20.19.2 with no engine warning, and its prompt reached the Hercules VM after a TLS round.
  Published by hand because trusted publishing did not exist yet; see above for why that attempt
  initially published nothing.
- **0.1.2**, 2026-11-09: **never published; the version is skipped.** The first release by tag: the
  run (42672755833) passed all six jobs and `release-check`, the user approved `publish`, and
  `publish.mjs` then handed npm `tarballs/tn3270-core-0.1.2.tgz` -- a relative path with ONE slash,
  which npm reads as GitHub shorthand, so it tried `git ls-remote ssh://git@github.com/tarballs/
  tn3270-core-0.1.2.tgz.git` and failed. Nothing reached the registry (core failed first, and the
  script stops at the first failure). A re-run replays the tagged commit's script, so it could not
  be fixed in place; the fix (absolute paths, and the every-push dry run moved to the release jobs'
  `tarballs/` directory) went to `main` and the `v0.1.2` tag was deleted. The run also met a GitHub
  Actions outage (incident from 18:12 UTC): attempt 1 created only three of the six matrix jobs.
- **0.1.3**, 2026-11-09: **the first release published by the tag workflow**, and the proof of it.
  Tag `v0.1.3` (`ebd2100`), run 42691997098: six jobs and `release-check` green, approved by the
  user, then `published 0.1.3: 8 new, 0 already there, registry verified`. Checked independently
  afterwards: every registry `dist.shasum` equals that run's tarball; the publisher is "GitHub
  Actions", not a user; each version carries an SLSA v1 provenance attestation naming
  `athornton/tn3270`, `.github/workflows/package.yml` at `refs/tags/v0.1.3`, commit `ebd2100`, a
  GitHub-hosted runner and run 42691997098; and `npm audit signatures` on a fresh install of
  `@tn3270/tui@0.1.3` reports verified registry signatures and verified attestations for all four
  packages it pulls in. No user-facing change from 0.1.1 beyond the release machinery.
- **0.1.4**, 2026-11-10: **the first release with a GitHub release**, and the proof of it. Tag
  `v0.1.4` (`64ab680`), run 42747736953. All eight npm packages went up on the first approval
  (each `+ @tn3270/...@0.1.4`, with provenance), but `publish`'s read-back FAILED for core, web and
  gui: the registry recorded them 2.5–3 minutes after `npm publish` reported them, past the old
  2-minute deadline. "Re-run failed jobs" plus a second approval recovered it as designed —
  `publish` skipped all eight as identical, its read-back passed, and `github-release` ran. The
  read-back deadline is now ten minutes (`scripts/publish.mjs`). Verified independently: every
  registry `dist.shasum` equals the run's tarball; the release `v0.1.4` (published, not a draft;
  the repository's latest) holds the seven installers and `SHA256SUMS`, which passes
  `sha256sum -c`, every installer byte-identical to the run's `gui-*` artifact; its notes hold
  the install header, the 0.1.4 `CHANGELOG.md` entry and the first-parent commits since v0.1.3.
  The `macos-26-intel` job had flaked once on `main` for this commit (`hdiutil: couldn't eject ...
  Resource busy` building the `.dmg`; a re-run passed) but passed first time on the tag run.
