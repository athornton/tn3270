# GitHub release and scriv changelog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The tag run that publishes to npm also creates the GitHub release `vX.Y.Z` with the run's installers, a `SHA256SUMS`, and notes = fixed header + the version's scriv section + GitHub's generated commit list + a compare link; `release-check` refuses a version with no changelog section or with uncollected fragments.

**Architecture:** Spec: `docs/superpowers/specs/2026-11-09-github-release-and-changelog-design.md` — read it all, including "Measured, not assumed". scriv is used via `uvx scriv` locally and pinned `scriv==1.8.1` in CI. One new dependency-free script, `scripts/release-notes.mjs`, holds every rule (testable); the workflow only glues it to `scriv print`, `gh api .../releases/generate-notes` and `gh release`.

**Tech Stack:** scriv 1.8.1, Node ESM scripts (+ `.d.mts`), vitest in `packages/core/test` (as `publish.test.ts`), GitHub Actions, gh CLI.

## THE SOURCE BEATS THIS PLAN

Plan code is a draft; read the files a task names first. Gate per task from the repo root: `npm run build && npm run typecheck && npx vitest run` (baseline 3251). Commit messages end with a blank line, `Generated with AI`, a blank line, `Co-Authored-By: SLAC AI`. Use `/usr/bin/gh` (a conda shim shadows `gh`); `uvx` is `~/.local/bin/uvx`.

## Facts (measured 2026-11-09)

- The installers a tag run uploads, for version V (from run 42691997098): `TN3270-V-mac-universal.dmg`, `TN3270-V-mac-universal.zip` (artifact `gui-macos-latest`), `TN3270-V-linux-x86_64.AppImage`, `TN3270-V-linux-amd64.deb` (`gui-ubuntu-latest`), `TN3270-V-linux-arm64.AppImage`, `TN3270-V-linux-arm64.deb` (`gui-ubuntu-24.04-arm`), `TN3270-V-win-x64.exe` (`gui-windows-latest`). The name template is `artifactName` in `packages/gui/electron-builder.cjs`.
- scriv facts: the spec's "Measured" section.

---

### Task 1: scriv configuration and the seeded `CHANGELOG.md`

**Files:** Create `changelog.d/scriv.ini`, `changelog.d/_template.md.jinja`, `CHANGELOG.md`.

- [ ] `changelog.d/scriv.ini` and `_template.md.jinja` exactly as in the spec (the ini with its comment and `%%`).
- [ ] `CHANGELOG.md`: `# Changelog`, a short paragraph (fragments live in `changelog.d/`, one per functional change via `uvx scriv create`; `uvx scriv collect --version X.Y.Z` at release; see `docs/releasing.md`), the line `<!-- scriv-insert-here -->` (scriv's default insert marker — check `scriv`'s docs/source for the exact default and use it, so `collect` inserts new entries ABOVE the seeded ones), then entries newest first for 0.1.3, 0.1.2 (one line: never published, skipped), 0.1.1 and 0.1.0, each in scriv's exact output shape (`<a id='changelog-X.Y.Z'></a>`, `## X.Y.Z (YYYY-MM-DD)`, `### <category>` subsections from the configured list, `- ` items). Summarise from `docs/releasing.md` *Release history* and the README: 0.1.0 (first npm release: packages, native installers, unsigned); 0.1.1 (Connect dialog retry; TUI no-host prompt; 30 s plaintext connect deadline; down/misspelled host is not a TLS failure; Node floor 20.19); 0.1.3 (published by the tag workflow with provenance; no user-facing change). Plain functional language, the user's audience.
- [ ] Verify with real scriv: `~/.local/bin/uvx scriv print --version 0.1.3` prints the 0.1.3 entry and exits 0; `--version 0.1.1` likewise; `--version 9.9.9` exits 2. Then in a THROWAWAY COPY of the repo (`cp -r` to /tmp, not the checkout): `uvx scriv create`, fill a category, `uvx scriv collect --version 0.1.4` — the new entry must land above 0.1.3 and the seeded entries be untouched. Record the outputs.
- [ ] Commit `changelog: scriv configuration, and CHANGELOG.md seeded with 0.1.0-0.1.3`.

### Task 2: `scripts/release-notes.mjs` — the rules, pure

**Files:** Create `scripts/release-notes.mjs`, `scripts/release-notes.d.mts`, `packages/core/test/releaseNotes.test.ts`.

Exports (dependency-free: `node:` modules only, plus `./workspaces.mjs` if needed):

```js
/** The seven installers a tag run must carry for version v (names from electron-builder's artifactName). */
export function expectedInstallers(v) -> string[]
/** Problems with the files found: missing, extra, wrong version. */
export function checkInstallers(files, v) -> string[]
/** `sha256  name` lines, sorted by name, newline-terminated: `sha256sum -c` compatible. */
export function sha256sums(entries /* [{ name, sha256 }] */) -> string
/** The highest vA.B.C tag lower than vX.Y.Z among `tags` (all ancestors of vX.Y.Z); undefined if none. */
export function previousTag(tags, version) -> string | undefined
/** The release notes markdown: header, '## What changed' + scriv text, '## Commits' + generated, compare link. */
export function composeNotes({ version, repo, previous, scriv, commits }) -> string
/** Changelog-readiness problems: no section for the version; fragments left in changelog.d. */
export function changelogProblems({ scrivExit, scrivText, fragmentDir, entries }) -> string[]
```

The fixed header content is the spec's "The fixed header" list, in markdown; `composeNotes` puts the version into every install command (`npm install -g @tn3270/tui@X.Y.Z` etc.).

- [ ] **Tests first** (`releaseNotes.test.ts`, importing `../../../scripts/release-notes.mjs`): `expectedInstallers('0.1.4')` equals the seven names from *Facts*; `checkInstallers` names a missing one, an extra one, and a wrong-version one; `sha256sums` output is sorted, two spaces, trailing newline, and — written with real files to a temp dir — passes `sha256sum -c` (skip that one assertion with a reason if `sha256sum` is absent, as on macOS/Windows runners; the format assertions still run); `previousTag(['v0.1.0','v0.1.1','v0.1.3','v0.1.4'], '0.1.4')` → `v0.1.3`, ignores non-semver tags and higher ones, returns undefined for the first release; `composeNotes` yields the sections in order with the scriv text verbatim and `https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4`; `changelogProblems` refuses scriv exit 2, blank output, and a leftover fragment, and accepts `scriv.ini` + `_template.md.jinja` only.
- [ ] See them fail; implement; gate; mutations (each reverted): `previousTag` returning the highest overall; `checkInstallers` ignoring extras; `changelogProblems` not counting fragments → their tests fail. Commit `scripts: release-notes.mjs -- installers, SHA256SUMS, previous tag, notes`.

### Task 3: `release-notes.mjs` modes

**Files:** Modify `scripts/release-notes.mjs`; extend tests.

`main(argv, { env, run, log })` (injected `run(cmd, args) -> { status, stdout }` for scriv/gh/git; real one via `spawnSync`), modes:

- `--check-changelog VERSION`: runs `scriv print --version VERSION` (command from env `SCRIV`, default `scriv`), lists `changelog.d/`, `changelogProblems` → exit 1 with the problems, else 0. Used by `release-check`.
- `--compose DIR`: VERSION from `GITHUB_REF_NAME` (`vX.Y.Z`; also require `GITHUB_REF_TYPE=tag`); `checkInstallers` over DIR's files; writes `DIR/SHA256SUMS`; `previousTag` from `git tag --merged GITHUB_REF_NAME --list 'v*.*.*'` (refuse if undefined — not expected for this repo); scriv text via `scriv print`; commits via `gh api repos/$GITHUB_REPOSITORY/releases/generate-notes -f tag_name=... -f previous_tag_name=...` → JSON `.body`; writes `release-notes.md` (path printed).
- `--dry-run DIR`: no tag, no network: VERSION from the root `package.json`; `SHA256SUMS` over the installers DIR has (only presence of names for THIS platform is checked); scriv section if present, else a placeholder; commits placeholder; prints the composed notes' first lines and WARNINGs (not failures) for `changelogProblems`; `::warning::` under `GITHUB_ACTIONS`.
- [ ] Tests with a fake `run` for each mode (incl. a missing-section warning in dry-run, a refusal in `--check-changelog`, and `--compose` writing both files). Real dry run: `npm run package:gui -- --linux --x64` is slow — instead create dummy files named for 0.1.3's Linux x64 installers in a temp dir and run `node scripts/release-notes.mjs --dry-run <dir>`; also `SCRIV="$HOME/.local/bin/uvx scriv" node scripts/release-notes.mjs --check-changelog 0.1.3` → exit 0, and `--check-changelog 0.1.4` → exit 1 naming the missing section. Gate. Commit `scripts: release-notes.mjs --check-changelog, --compose, --dry-run`.

### Task 4: the workflow

**Files:** Modify `.github/workflows/package.yml`, `packages/core/test/workflow.test.ts`.

- [ ] In the `package` job's `matrix.npm` leg, after the publish dry run: `- run: pipx install scriv==1.8.1` (or `pip install --user`; check what ubuntu-latest has) then `node scripts/release-notes.mjs --dry-run artifacts/gui` — AFTER `package:gui` has produced `artifacts/gui` (check step order; move the step after packaging if needed).
- [ ] `release-check`: after its checks, install scriv pinned and `node scripts/release-notes.mjs --check-changelog "${GITHUB_REF_NAME#v}"`.
- [ ] New job, after `publish`:

```yaml
  github-release:
    # The GitHub release, with this run's installers. After publish: a release never exists
    # without its npm packages. The approval on publish covers it (no environment of its own).
    if: startsWith(github.ref, 'refs/tags/v')
    needs: publish
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v7
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v7
        with: { node-version: '22' }
      - run: pipx install scriv==1.8.1
      - uses: actions/download-artifact@v8
        with: { pattern: 'gui-*', merge-multiple: true, path: installers }
      - run: node scripts/release-notes.mjs --compose installers
        env: { GH_TOKEN: '${{ github.token }}' }
      - name: Create or update the release
        env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
            gh release edit "$GITHUB_REF_NAME" --notes-file release-notes.md
            gh release upload "$GITHUB_REF_NAME" installers/* --clobber
          else
            gh release create "$GITHUB_REF_NAME" --verify-tag --title "$GITHUB_REF_NAME" --notes-file release-notes.md installers/*
          fi
      - name: Read the release back
        env: { GH_TOKEN: '${{ github.token }}' }
        run: node scripts/release-notes.mjs --verify-release installers
```

  Add a `--verify-release DIR` mode in Task 3's style (or here, with tests): `gh release view TAG --json assets` must list exactly DIR's files (installers + `SHA256SUMS`), each `size` equal to the local file's size; fail otherwise. Check `download-artifact@v8`'s `pattern`/`merge-multiple` inputs in its README.
- [ ] `workflow.test.ts`: `github-release` needs `publish`, has `contents: write` and no other write permission, `fetch-depth: 0`, no `environment:`; `release-check` runs `--check-changelog`; the dry-run leg runs `release-notes.mjs --dry-run`. Update the workflow header comment (the third job, and why it has no environment).
- [ ] Gate. Commit `ci: cut the GitHub release with the installers after publish`.

### Task 5: docs

- [ ] `docs/releasing.md`: the fragment habit (`uvx scriv create` with each functional change); the release step now includes `uvx scriv collect --version X.Y.Z`; what `release-check` refuses; the `github-release` job (assets, `SHA256SUMS`, notes composition, re-run = edit + `--clobber`); FIX the *Release history* — it is out of order (0.1.2/0.1.3 inserted above 0.1.0) and still has a stale "0.1.2: not yet released ... will be the first release through the publish workflow" entry (~L257): make it chronological and remove the stale line; point at `CHANGELOG.md` for functional summaries.
- [ ] README *Installing*: the installers are on the GitHub release page for each version (with `SHA256SUMS`); item 14 updated. HANDOFF START HERE. Summary-line grep: `command grep -n -i "not yet released\|github release\|changelog" README.md docs/*.md | head -30`.
- [ ] A changelog fragment for THIS work, via `uvx scriv create` (category "Other changes": releases now come with a GitHub release carrying the installers and checksums, and a changelog). Commit `docs: the GitHub release and the changelog habit`.

### Task 6: branch gate and CI

- [ ] `npm ci && npm run build && npm run typecheck && npx vitest run`; push `gh-release`; `/usr/bin/gh workflow run package.yml --ref gh-release`; all six jobs green; the ubuntu-latest log shows the release-notes dry run (and its expected WARNING that the current version 0.1.3... — note: 0.1.3 HAS a section, and THIS branch has one uncollected fragment from Task 5, so expect exactly the leftover-fragment warning); `release-check`, `publish`, `github-release` skipped. The 0.1.4 proof release is the user's call.
