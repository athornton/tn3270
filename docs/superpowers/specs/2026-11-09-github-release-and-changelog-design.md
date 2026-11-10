# GitHub release with the installers, and a scriv changelog — design

2026-11-09. Agreed in conversation, choice by choice: the release is cut AFTER `publish` succeeds
(option 1 of 2); the notes are a fixed header + the version's scriv changelog section + GitHub's
generated commit list + a compare link (the user's choice, combining options 1 and 2 of 3, and
including the commit list); scriv itself, not changesets or an in-repo script (option 1 of 3),
configured with the user's own settings from their other projects, under `[tool.scriv]` in
`changelog.d/scriv.ini` so it can move into a `pyproject.toml` unchanged in shape.

## Goal

The tag run that publishes `@tn3270/*` X.Y.Z to npm also creates the GitHub release `vX.Y.Z`,
carrying the native installers that same run built and tested, a `SHA256SUMS` over them, and notes
whose functional summary comes from scriv changelog fragments written with each change.

## Measured, not assumed (scriv 1.8.1 via `uvx`, gh 2.46, 2026-11-09)

- `[tool.scriv]` is read from `changelog.d/scriv.ini`. The user's settings work there with ONE
  change: configparser interpolates `%`, so `strftime('%Y-%m-%d')` must be written
  `strftime('%%Y-%%m-%%d')` in the ini file (single `%` raised `InterpolationSyntaxError`). Moved
  into a `pyproject.toml` (TOML, no interpolation) it goes back to single `%` — verified with
  `scriv[toml]`. A comment at the top of `scriv.ini` says so.
- `scriv create` writes a fragment from the user's template; `scriv collect --version X.Y.Z` writes
  `## X.Y.Z (YYYY-MM-DD)` (with an `<a id='changelog-X.Y.Z'></a>` anchor) into `CHANGELOG.md`,
  keeping only the filled-in categories, and deletes the fragments.
- `scriv print --version X.Y.Z` prints just that section on STDOUT (its "Extracting entry..." chatter
  goes to stderr) and exits 2 for a version with no section.
- `gh release create` documents that `--notes` are PREPENDED to `--generate-notes` output. Rather
  than depend on that flag interplay, the job composes ONE notes file itself, so the result is
  predictable and testable.
- **`releases/generate-notes` lists merged PULL REQUESTS, not commits** (measured during
  implementation): for v0.1.1...v0.1.3 its `body` was only `**Full Changelog**: <compare URL>`,
  because this repository merges by push and has no pull requests. So the commit list is
  `git log --first-parent --format=%s%x00%h vPREV..vX.Y.Z` (5 lines for v0.1.1..v0.1.3 -- the
  `Merge X -- ...` subjects, the release commits, one direct commit -- where a plain `git log` gives
  17, every branch's plans and specs included), each subject markdown-escaped: GitHub's renderer
  swallowed `<userid>` in 2d0041c's subject as an HTML tag, a leading `#` makes a heading, and a
  bare `@login` would notify that user. GitHub's list is still asked for, and shown only when it
  lists something.
- The release REST API (`repos/{repo}/releases/tags/{tag}`) gives each asset a `digest`,
  `sha256:<hex>`, on assets uploaded since GitHub began computing it; older assets have `null`
  (measured on cli/cli: v2.103.3 has digests, v2.46.0 has none).

## Changelog files

- `changelog.d/scriv.ini`:

  ```ini
  # scriv configuration, under [tool.scriv] so it can move into a pyproject.toml as-is -- EXCEPT
  # that this ini file must write strftime's percent signs doubled (%%Y), because configparser
  # interpolates %. In pyproject.toml (TOML) they go back to single (%Y).
  [tool.scriv]
  categories =
      Backwards-incompatible changes
      New features
      Bug fixes
      Other changes
  entry_title_template = {{ version }} ({{ date.strftime('%%Y-%%m-%%d') }})
  format = md
  md_header_level = 2
  new_fragment_template = file:changelog.d/_template.md.jinja
  skip_fragments = _template.md.jinja
  ```

- `changelog.d/_template.md.jinja`: the user's template, verbatim.
- `CHANGELOG.md`: a title, a one-paragraph note (fragments in `changelog.d/`, collected at release
  by scriv), and hand-written entries for 0.1.0, 0.1.1 and 0.1.3 in scriv's own format (anchor +
  `## X.Y.Z (date)` + category subsections), summarising `docs/releasing.md`'s release history;
  0.1.2 noted as skipped. Written so `scriv print --version 0.1.3` extracts the 0.1.3 entry.

## The habit, and the release step

- **With each functional change**: `uvx scriv create`, fill in the categories that apply, delete the
  rest, commit the fragment with the change.
- **At release**: `npm run version:set -- X.Y.Z`, `npm install`, `uvx scriv collect --version
  X.Y.Z`, commit (`release: X.Y.Z`), push, CI green, push the tag, approve.

## `release-check` gains two refusals (before the approval)

It installs scriv pinned (`pipx run scriv==1.8.1`, or `pip install scriv==1.8.1`; the runner has
both) and refuses unless:

1. `scriv print --version X.Y.Z` exits 0 with output holding at least one `- item` line — the
   changelog has this version, and not just an untouched template's headings and bare `-`s;
2. `changelog.d/` contains no fragments other than `scriv.ini` and `_template.md.jinja` — nothing
   was written and then left uncollected.

Both are checked by a new mode of a small dependency-free script (below), so they are unit-tested
and run on every push in a WARNING form (see "Every push").

It also runs `release-notes.mjs --check-installers DIR X.Y.Z` over the run's downloaded `gui-*`
artifacts (no network): the installer-set rule below, BEFORE the approval and `npm publish`, which
cannot be undone -- so a missing or extra installer stops the release before anything is public.

## New job `github-release` (after `publish`)

`needs: publish`, `if: startsWith(github.ref, 'refs/tags/v')`, `runs-on: ubuntu-latest`,
`permissions: { contents: write }` (this job only), `timeout-minutes: 15`, no environment (the user's
one approval on `publish` already covers it). Steps:

1. Checkout with `fetch-depth: 0` (tags and history, for the previous tag).
2. Download the run's `gui-*` artifacts (`pattern: gui-*`, `merge-multiple: true`) — the macOS
   universal `.dmg`/`.zip`, Linux x64 and arm64 `.AppImage`/`.deb`, Windows x64 `.exe`.
3. `node scripts/release-notes.mjs` (new, dependency-free; tested):
   - refuses unless the expected set of files is present (one of each kind listed above, each named
     with version X.Y.Z), and writes `SHA256SUMS` (`sha256  filename`, sorted, `sha256sum -c`
     compatible);
   - finds the PREVIOUS release tag: the highest `vA.B.C` tag that is an ancestor of this tag and
     lower than it (`git tag --merged`), so the commit list is X.Y.Z's own and never falls back
     to the whole history (no previous tag: refuse);
   - composes `release-notes.md`, in the repository root (the job's working directory), from: the
     fixed header; `scriv print --version X.Y.Z`'s output under `## What changed`; under
     `## Commits`, `git log --first-parent` vPREV..vX.Y.Z, one escaped `- subject (hash)` per line
     (see "Measured"); under `## Pull requests`, only when it lists any,
     `gh api repos/{repo}/releases/generate-notes -f tag_name=vX.Y.Z -f previous_tag_name=vPREV`'s
     `body` minus its own compare line and HTML comments; and ONE
     `**Full changelog**: https://github.com/{repo}/compare/vPREV...vX.Y.Z`.
4. Create or update the release: if `gh release view vX.Y.Z` fails, `gh release create vX.Y.Z
   --verify-tag --title "vX.Y.Z" --notes-file release-notes.md <files> SHA256SUMS`; otherwise (a
   re-run) `gh release edit vX.Y.Z --notes-file release-notes.md` and `gh release upload vX.Y.Z
   <files> SHA256SUMS --clobber`.
5. Read back (`release-notes.mjs --verify-release`): `gh api repos/{repo}/releases/tags/vX.Y.Z`
   lists exactly the expected files plus `SHA256SUMS`, each uploaded, non-empty, at the local size,
   and -- where GitHub gives a `digest` -- with the local file's sha256; fail otherwise.

### The fixed header

- npm: `npm install -g @tn3270/tui` (and `cli`, `web`, `gui`) at X.Y.Z, with a pointer to the
  README's non-root install note.
- Which installer for which system (one line each).
- **Unsigned** (until the Apple Developer ID arrives): macOS — System Settings → Privacy & Security
  → *Open Anyway*; Windows — SmartScreen *More info → Run anyway*.
- Verifying: `sha256sum -c SHA256SUMS` (Linux), `shasum -a 256 -c SHA256SUMS` (macOS).
- npm provenance: the packages carry SLSA attestations; `npm audit signatures` verifies them.

## Every push

The `--dry-run` leg (ubuntu-latest) also runs `node scripts/release-notes.mjs --dry-run`: it
composes the notes for the CURRENT manifest version from local data (scriv section if present,
a placeholder commit list, no network), builds `SHA256SUMS` over that job's own
`artifacts/gui/` installers (that leg builds the Linux x64 ones only, so the expected-set rule is
applied to what that platform produces), and prints a WARNING — not a failure — when the version has
no changelog section or uncollected fragments exist (normal between releases).

## Signing later

When the Apple Developer ID arrives, macOS signing and notarization happen in the macOS matrix job
before its artifact is uploaded; this job then picks up signed files unchanged. Out of scope here.

## Testing

- `release-notes.mjs` unit tests: the expected-file-set rule (missing, extra, wrong version); the
  `SHA256SUMS` format (round-trips through `sha256sum -c` in a test); previous-tag selection
  (ancestor, highest lower, none → refuse); notes composition (sections in order, the scriv text
  verbatim, the compare URL, escaped commit subjects, `--first-parent` against a real temporary git
  repository); the release-check refusals (no section, a section with no item, a leftover fragment;
  the installer set); the read-back (size, digest, `null` digest falling back to size).
- `workflow.test.ts`: `github-release` needs `publish`, has `contents: write` and no other write
  permission, fetch-depth 0; `release-check` runs the changelog and installer checks.
- The `CHANGELOG.md` seed: `scriv print --version 0.1.3` extracts it (a test runs scriv if
  available, else is skipped with a reason; CI has it).
- **Proof**: release 0.1.4, with at least one real fragment: the GitHub release exists, its assets
  match the run's artifacts byte for byte and `SHA256SUMS` verifies them, and its notes contain the
  scriv section and a commit list starting after v0.1.3.

## Documentation

`docs/releasing.md` (the fragment habit, the release step with `scriv collect`, what the release
job does, re-run behaviour), README (*Installing*: installers from the GitHub release page; item 14),
HANDOFF.
