# Releasing

Manual, for now. There is no tag-triggered publish: `docs/superpowers/specs/2026-11-05-packaging-design.md`
section on publishing says that waits for npm trusted publishing to be set up, and nothing here
changes that decision. This is the procedure until then.

## Prerequisites

- An npm account with publish rights on the `@tn3270` org (the user owns it) and 2FA enabled —
  `npm publish` of a new package under a scoped org asks for a one-time code.
- `npm whoami` succeeds, and `npm access ls-packages @tn3270` (once anything has been published)
  shows you with write access.
- A clean working tree on the branch you are releasing from, with CI green on it (see *Where the
  artifacts come from* below).

## 1. Bump the version

All nine workspaces (eight published `@tn3270/*` packages plus the private root) move in
lockstep — `scripts/set-version.mjs` rewrites every manifest's own `"version"`, every
`@tn3270/*` dependency range, and `packages/core/src/index.ts`'s `VERSION` literal, computing
every file's new contents before writing any of them so a malformed manifest cannot leave the
tree half-bumped.

```sh
npm run version:set -- X.Y.Z
npm install        # updates package-lock.json to match
```

Commit the result and tag it:

```sh
git add -A
git commit -m "release: X.Y.Z"
git tag vX.Y.Z
```

## 2. Get the tarballs

Either take them from a green CI run's `npm-tarballs` artifact (`.github/workflows/package.yml`
uploads it from the `ubuntu-latest` job only, so the tarballs are not duplicated across runners),
or build them yourself:

```sh
npm run build
npm run bundle:gui
npm run pack:npm      # writes artifacts/npm/*.tgz, deleting any older ones first
```

`pack:npm` (`scripts/pack.mjs`) refuses before packing anything if `packages/gui/app/BUNDLED` is
missing, if any `dist/` holds a compiled file whose source is gone, or if any published package's
`dist/` is older than its own `src/` — so a tarball that exists is a tarball built from the source
it claims to be.

If `artifacts/npm/` exists, check the names it actually produced:

```sh
ls artifacts/npm
```

Otherwise, the naming is `npm pack`'s own: `@tn3270/<name>@<version>` becomes
`tn3270-<name>-<version>.tgz` (the `@` dropped, the `/` replaced with `-`).

## 3. Publish, in dependency order

The four library packages have no stable API and exist only because the front ends depend on
them, but npm still needs their tarball published before anything that names them as a
dependency. Each package's own `dependencies` (checked in every `packages/*/package.json`) gives
the order: `frontend` depends on `core`; `node-files` depends on `frontend`; `canvas` depends on
`core` and `frontend`; every front end (`cli`, `tui`, `web`, `gui`) depends on some combination of
all four. Publishing `core`, `frontend`, `node-files`, `canvas` in that order satisfies every one
of those edges before any front end needs it:

```sh
npm publish artifacts/npm/tn3270-core-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-frontend-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-node-files-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-canvas-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-cli-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-tui-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-web-X.Y.Z.tgz
npm publish artifacts/npm/tn3270-gui-X.Y.Z.tgz
```

Every manifest already sets `publishConfig.access: public` (checked by
`packages/core/test/manifests.test.ts`), so `npm publish` needs no `--access` flag even though
these are scoped packages.

## 4. Verify, on a clean machine

```sh
npm install -g @tn3270/tui
tn3270 --bogus     # exits 2, prints a usage error naming "unrecognized argument"
npm install -g @tn3270/gui
tn3270-gui ...     # first run prints "Downloading Electron binary..." and fetches it
```

That is the same shape `scripts/install-smoke.mjs` already checks against the unpublished
tarballs in CI — this step is the same check against the real registry.

## 5. Native artifacts

electron-builder's output (macOS universal `.dmg`/`.zip`, Linux x64 and arm64 AppImage/`.deb`,
a Windows x64 NSIS installer) is **not** published anywhere automatically. For now:

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

## Tag-triggered publishing

Not set up. A push of a `vX.Y.Z` tag does not publish anything by itself; everything above is run
by hand until npm trusted publishing (OIDC, no long-lived token in CI) is configured for this org.
