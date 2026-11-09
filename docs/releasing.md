# Releasing

**Tag-triggered, as of 2026-11-09** (`docs/superpowers/specs/2026-11-09-npm-trusted-publishing-design.md`,
`docs/superpowers/plans/2026-11-09-npm-trusted-publishing.md`). Pushing a `vX.Y.Z` tag runs
`.github/workflows/package.yml`'s six matrix jobs on the tagged commit, then `release-check`
(fails a bad tag or a mismatched tarball set before anyone is asked to approve anything) and
`publish` (waits for one approval in the GitHub environment `npm`, then publishes over OIDC — no
npm token anywhere — and reads the registry back to prove every package actually landed). The
*Fallback* section below, run by hand, is what this replaces; keep it until the one-time setup's
last step (disallowing tokens) has happened on every package.

**Proof this works end to end is still owed**: release 0.1.2, tagged and approved by the user,
with the registry checked against that tag's CI tarballs.

## One-time setup (done, 2026-11-09)

1. The GitHub environment `npm` (created with `gh api`): required reviewer `athornton`,
   self-review allowed (the same person pushes the tag and approves), deployments limited to
   tags matching `v*.*.*`.
2. On npmjs.com, each of the eight `@tn3270/*` packages' Settings → Trusted publishing → GitHub
   Actions: owner `athornton`, repository `tn3270`, workflow `package.yml`, environment `npm`.
   Done by the user, 2026-11-09: npm publish ON, dist-tag OFF, stage publish ON.
3. **Still to do, after the first CI publish has actually worked** (0.1.2): on each package,
   Publishing access → "Require two-factor authentication and disallow tokens". Trusted
   publishers keep working after this; it is what finally retires the *Fallback* below, since a
   token-based `npm publish` would then be refused.

Renaming `.github/workflows/package.yml` or the `npm` GitHub environment breaks every one of the
eight trusted-publisher entries above — they name this file and that environment literally, not
"the packaging workflow" — with no warning until the next tag push fails.

## Procedure

1. **Bump the version.** All nine workspaces (eight published `@tn3270/*` packages plus the
   private root) move in lockstep — `scripts/set-version.mjs` rewrites every manifest's own
   `"version"`, every `@tn3270/*` dependency range, and `packages/core/src/index.ts`'s `VERSION`
   literal, computing every file's new contents before writing any of them so a malformed
   manifest cannot leave the tree half-bumped.

   ```sh
   npm run version:set -- X.Y.Z
   npm install        # updates package-lock.json to match
   ```

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
   commit under the tag), then `release-check`, then `publish`.

5. **Approve.** In the Actions tab, the `publish` job run is waiting on the `npm` environment's
   required reviewer. Review it, approve it.

6. **Read the summary line.** `publish.mjs --publish`'s last line of output is
   `published X.Y.Z: N new, M already there, registry verified` — printed only once every
   tarball's `dist.shasum` has actually been read back from the registry. That line, not the exit
   code and not "npm publish didn't print an error", is the proof the 0.1.1 near-miss (below)
   shows was missing the first time: a release is not done until this line says so.

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

- **0.1.2 was never published; the version is skipped.** It was the first release by tag: the
  run (42672755833) passed all six jobs and `release-check`, the user approved `publish`, and
  `publish.mjs` then handed npm `tarballs/tn3270-core-0.1.2.tgz` -- a relative path with ONE slash,
  which npm reads as GitHub shorthand, so it tried `git ls-remote ssh://git@github.com/tarballs/
  tn3270-core-0.1.2.tgz.git` and failed. Nothing reached the registry (core failed first, and the
  script stops at the first failure). A re-run replays the tagged commit's script, so it could not
  be fixed in place; the fix (absolute paths, and the every-push dry run moved to the release jobs'
  `tarballs/` directory) went to `main` and the `v0.1.2` tag was deleted. The run also met a GitHub
  Actions outage (incident from 18:12 UTC): attempt 1 created only three of the six matrix jobs.
- **0.1.3**, 2026-11-09: the first release published by the tag workflow. Same contents as 0.1.2
  would have had (no user-facing change from 0.1.1 beyond the release machinery).

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
a Windows x64 NSIS installer) is **not** published anywhere automatically, by either path above.
For now:

- take them from the green CI run's `gui-<os>` artifacts (one per uploading runner: `ubuntu-latest`,
  `ubuntu-24.04-arm`, `macos-latest`, `windows-latest` — `macos-26-intel` builds the same universal
  mac app and does not re-upload it);
- attach them to a GitHub release by hand.

There is no automated upload to a release page yet, and no auto-update.

## Unsigned-app notes, for whoever is attaching or receiving these

Every native artifact is unsigned this milestone (`CSC_IDENTITY_AUTO_DISCOVERY: false` in CI,
`identity: null` in `packages/gui/electron-builder.cjs`) — that disables mac code signing outright,
it is not the same as an ad-hoc signature. Signing and notarization arrive with an Apple Developer
ID; ad-hoc signing is the fallback under consideration before then.

- **macOS**: Gatekeeper blocks a downloaded unsigned app. The route on current macOS is System
  Settings → Privacy & Security → *Open Anyway* after the first blocked launch, or
  `xattr -dr com.apple.quarantine /Applications/TN3270.app`. Checked by the user on 2026-11-08 on
  Apple Silicon: the fully unsigned build runs once permitted via *Open Anyway* — cumbersome, but
  not refused, so ad-hoc signing is not needed as a fallback.
- **Windows**: SmartScreen flags the installer; *More info → Run anyway* gets past it.

## Release history

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
- **0.1.2**: not yet released. This will be the first release through the `publish` workflow job
  above — its entry here should record the tag, the run id, the approver, and the
  `published X.Y.Z: ...` summary line, the same way the entries above record the manual
  equivalents.
