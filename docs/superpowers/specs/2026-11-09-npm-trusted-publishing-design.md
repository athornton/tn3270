# npm trusted publishing from GitHub Actions — design

2026-11-09. Approved in conversation: option 2 of 3 (a GitHub-environment approval gate, then a
direct publish over OIDC). README *Remaining* item 14's last piece. Motivated by the 0.1.1 release,
whose first attempt published nothing from a machine that was not logged in to npm, unnoticed
until the registry was read back (`docs/releasing.md`, *Release history*).

## Goal

Pushing a `vX.Y.Z` tag publishes all eight `@tn3270/*` packages at X.Y.Z — the exact tarballs that
tag's CI run built and tested — after one approval click by the user, with npm provenance and no
long-lived npm token anywhere.

## Facts this rests on (read 2026-11-09, not from memory)

From [npm docs: trusted publishers](https://docs.npmjs.com/trusted-publishers):

- npm CLI ≥ 11.5.1, Node ≥ 22.14.0; GitHub-hosted runners only.
- The job needs `permissions: id-token: write` (and `contents: read`).
- Configured per package on npmjs.com: owner, repository, **workflow filename** (only the file
  name, and it must be the workflow that runs `npm publish` itself, not one that `workflow_call`s
  it), optional environment name.
- Provenance is generated automatically for a public repository and package; no `--provenance`.
- Afterwards each package can be set to "Require two-factor authentication and disallow tokens";
  trusted publishers keep working.

From [npm docs: staged publishing](https://docs.npmjs.com/staged-publishing): staging a NEW package
publishes a public placeholder `0.0.0-stage` — the origin of the `0.0.0-stage` versions the first
0.1.0 publish left (deprecated 2026-11-09). Staged publishing (option 3) was not chosen.

## Already done

The GitHub environment `npm` exists (created 2026-11-09 with `gh api`): required reviewer
`athornton`, self-review allowed (the same person pushes the tag and approves), deployments limited
to tags matching `v*.*.*`.

## Design

### Trigger

`.github/workflows/package.yml` adds `push: tags: ['v*.*.*']`. A tag push runs the existing six
matrix jobs on the tagged commit as any push does, then the two jobs below. On every other event
those two jobs are skipped by `if: startsWith(github.ref, 'refs/tags/v')`.

### Job `release-check` (no environment, no approval)

`needs: package` (all six), `runs-on: ubuntu-latest`. Checks out the repo (for the script),
downloads this run's `npm-tarballs` artifact, and runs `node scripts/publish.mjs --check <dir>`,
which refuses unless:

- the tag is `v` + a version `X.Y.Z`;
- exactly the eight expected tarballs are present (the published workspaces, from the same
  discovery `scripts/pack.mjs` uses), each named `tn3270-<name>-X.Y.Z.tgz`;
- each tarball's own `package/package.json` has `version` X.Y.Z, and every `@tn3270/*` dependency
  in it is pinned to exactly X.Y.Z;
- for each package, the registry does not already hold X.Y.Z with DIFFERENT contents (identical is
  allowed: a re-run).

Being outside the environment, it fails a bad tag immediately, before anyone is asked to approve.

### Job `publish` (environment `npm`: waits for the approval)

`needs: release-check`, `runs-on: ubuntu-latest`, `environment: npm`,
`permissions: { id-token: write, contents: read }`. Node 24 via `actions/setup-node`, then
`npm install -g npm@^11.5.1` with the resulting `npm --version` printed. Downloads the same
artifact and runs `node scripts/publish.mjs --publish <dir>`:

1. **Order** — dependency order computed from the tarballs' manifests (a topological sort over
   `@tn3270/*` dependencies; today `core`, `frontend`, `node-files`, `canvas`, then the front ends),
   not a hard-coded list, so a new package or edge cannot be published before what it needs.
2. **Publish** each with `npm publish <tgz>` (no token: OIDC). A version already on the registry
   with identical contents is SKIPPED, so re-running after a partial failure is safe. The first
   failure stops the job.
3. **Read back** — for each package, fetch the uncached registry document
   (`https://registry.npmjs.org/@tn3270%2F<name>?write=true`) and require `versions[X.Y.Z]` with
   `dist.shasum` equal to the tarball's sha1, retrying for up to ~2 minutes while it propagates.
   Fail naming every package that does not match. This is the check that would have caught the
   0.1.1 non-publish.

### `--dry-run` mode, on every push

`node scripts/publish.mjs --dry-run <dir>` runs the order and the tarball/manifest checks of
`--check` (minus the tag rule: there is no tag) and `npm publish --dry-run` for each tarball. A step
in the `ubuntu-latest` job runs it after `pack:npm` on every push and pull request, so the script
is exercised continuously, not once per release.

### Unit tests (`scripts` are tested from `packages/core/test`, as `setVersion.test.ts` does)

- the dependency order from a set of manifests, including a new package and a cycle (refused);
- the tag / version / pin rules, each refusal named;
- the read-back comparison against a fake registry: match, missing version, different shasum,
  a version appearing only after a retry;
- the "already published identical → skip / different → refuse" rule.

## One-time setup by the user

1. **npmjs.com**, on each of the eight packages, Settings → Trusted publishing → GitHub Actions:
   owner `athornton`, repository `tn3270`, workflow `package.yml`, environment `npm`.
2. **After the first CI publish has worked:** on each package, Publishing access → "Require
   two-factor authentication and disallow tokens".

## Documentation

`docs/releasing.md`: the release is now bump → push → CI green → push the tag → approve the
`publish` job → done; the manual loop is the fallback until step 2 above disallows tokens, after
which it is gone. README *Remaining* item 14 and HANDOFF updated.

## Proof

CI on the branch exercises `--dry-run`. The real witness is release 0.1.2: tagged, approved by the
user, and `npm view @tn3270/core@0.1.2` (or the npmjs.com page) showing a provenance attestation
for this repository's `package.yml`, with every registry shasum equal to the run's tarballs.

## Out of scope

macOS signing and notarization (the user may enroll in the Apple Developer program; that is its
own item), staged publishing, and publishing the native installers to a GitHub release.
