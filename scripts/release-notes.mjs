#!/usr/bin/env node
/**
 * The GitHub release's rules: which installers it carries, their `SHA256SUMS`, the previous
 * release tag, the notes, and whether the changelog is ready
 * (`docs/superpowers/specs/2026-11-09-github-release-and-changelog-design.md`).
 *
 * DEPENDENCY-FREE: the release jobs run it with no `npm ci`, so it imports `node:` modules only.
 */

/**
 * Each packaging runner's installers, by the `process.platform`/`process.arch` that builds them,
 * as `[suffix]` after `TN3270-<version>-`. The names are electron-builder's `artifactName`
 * (`${productName}-${version}-${os}-${arch}.${ext}`, `packages/gui/electron-builder.cjs`), as the
 * 0.1.3 tag run (42691997098) uploaded them: the AppImage says `x86_64` where the .deb says
 * `amd64`, and the macOS pair is one universal build, whichever Mac arch makes it.
 */
const SUFFIXES = {
  'darwin-arm64': ['mac-universal.dmg', 'mac-universal.zip'],
  'darwin-x64': ['mac-universal.dmg', 'mac-universal.zip'],
  'linux-x64': ['linux-x86_64.AppImage', 'linux-amd64.deb'],
  'linux-arm64': ['linux-arm64.AppImage', 'linux-arm64.deb'],
  'win32-x64': ['win-x64.exe'],
};

/** Every suffix once, in the order the release lists them. */
const ALL_SUFFIXES = [...new Set(Object.values(SUFFIXES).flat())];

const PRODUCT = 'TN3270';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The seven installers a tag run must carry for version `v`. */
export function expectedInstallers(v) {
  return ALL_SUFFIXES.map((s) => `${PRODUCT}-${v}-${s}`);
}

/** The installers a runner on `platform`/`arch` builds for version `v`; `[]` for one that builds none. */
export function installersFor(v, platform, arch) {
  return (SUFFIXES[`${platform}-${arch}`] ?? []).map((s) => `${PRODUCT}-${v}-${s}`);
}

/** `TN3270-<version>-<a known suffix>` -> the version, else undefined. */
function installerVersion(file) {
  for (const s of ALL_SUFFIXES) {
    const prefix = `${PRODUCT}-`;
    const tail = `-${s}`;
    if (file.startsWith(prefix) && file.endsWith(tail) && file.length > prefix.length + tail.length) {
      return file.slice(prefix.length, -tail.length);
    }
  }
  return undefined;
}

/**
 * Problems with the files found for version `v`, each a sentence naming the fix: an `expected`
 * one missing, an installer for another version, any other file. `expected` defaults to all
 * seven; a dry run on one runner passes its own share (`installersFor`).
 */
export function checkInstallers(files, v, expected = expectedInstallers(v)) {
  const problems = [];
  for (const name of expected) {
    if (!files.includes(name)) {
      problems.push(`missing ${name}: npm run package:gui did not make it, or its gui-* artifact was not downloaded; re-run the failed packaging job`);
    }
  }
  for (const f of files) {
    if (expected.includes(f)) continue;
    const fv = installerVersion(f);
    if (fv !== undefined && fv !== v) {
      problems.push(`${f} is for version ${fv}, not ${v}: run npm run version:set -- ${v}, then rebuild`);
    } else {
      problems.push(`unexpected file ${f}: only the installers belong in the release (SHA256SUMS is written here, over them)`);
    }
  }
  return problems;
}

/** `sha256  name` lines, sorted by name (bytewise), newline-terminated: `sha256sum -c` compatible. */
export function sha256sums(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, sha256 }) => `${sha256}  ${name}\n`)
    .join('');
}

function parse(v) {
  const m = SEMVER.exec(v);
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The highest `vA.B.C` tag lower than `version` (`X.Y.Z`, no `v`) among `tags` -- which the
 * caller takes from `git tag --merged vX.Y.Z`, so all are ancestors -- or undefined if none.
 * Numeric, so v0.10.0 is above v0.9.0; anything not exactly `vA.B.C` (an `-rc1`) is ignored.
 */
export function previousTag(tags, version) {
  const self = parse(version);
  if (self === undefined) throw new Error(`version ${JSON.stringify(version)} is not X.Y.Z`);
  let best;
  for (const t of tags) {
    const p = t.startsWith('v') ? parse(t.slice(1)) : undefined;
    if (p === undefined || compare(p, self) >= 0) continue;
    if (best === undefined || compare(p, best.p) > 0) best = { t, p };
  }
  return best?.t;
}

/** The fixed part of every release's notes. */
function header(version) {
  const [dmg, zip, appX64, debX64, appArm, debArm, exe] = expectedInstallers(version);
  return [
    '## Installing',
    '',
    'From npm (any system with Node 20.19 or later):',
    '',
    '```sh',
    `npm install -g @tn3270/tui@${version}    # tn3270     -- the terminal client`,
    `npm install -g @tn3270/cli@${version}    # tn3270-cli -- the scripting client`,
    `npm install -g @tn3270/web@${version}    # tn3270-web -- the browser gateway`,
    `npm install -g @tn3270/gui@${version}    # tn3270-gui -- the Electron GUI`,
    '```',
    '',
    'Not root? See *Installing* in the [README](https://github.com/athornton/tn3270#installing) for a',
    'per-user npm prefix, or `npx`.',
    '',
    'Or the GUI as a native installer, attached below:',
    '',
    `- macOS (Apple silicon and Intel): \`${dmg}\`, or \`${zip}\``,
    `- Linux x64: \`${appX64}\`, or \`${debX64}\` for Debian and Ubuntu`,
    `- Linux arm64: \`${appArm}\`, or \`${debArm}\` for Debian and Ubuntu`,
    `- Windows x64: \`${exe}\``,
    '',
    '**The installers are unsigned.** macOS blocks the first launch: then System Settings → Privacy &',
    'Security → *Open Anyway*. Windows SmartScreen warns: *More info* → *Run anyway*.',
    '',
    '**Verifying.** In the directory you downloaded to, with `SHA256SUMS` beside the installers:',
    '`sha256sum -c SHA256SUMS` (Linux) or `shasum -a 256 -c SHA256SUMS` (macOS); add',
    '`--ignore-missing` to check only the ones you downloaded. The npm packages carry SLSA',
    'provenance attestations from this repository\'s release workflow: `npm audit signatures` in a',
    'project that installed them verifies them.',
    '',
  ].join('\n');
}

/** GitHub's generated notes minus their own `**Full Changelog**` line; '' when nothing else is left. */
function pullList(body) {
  return (body ?? '')
    .split('\n')
    .filter((l) => !/^\*\*Full Changelog\*\*:/.test(l))
    .join('\n')
    .replace(/^## What's Changed\n/m, '')
    .trim();
}

/**
 * The release notes, in markdown: the fixed header; `## What changed` with `scriv print`'s text
 * verbatim; `## Commits` with the commit list; `## Pull requests` with GitHub's generated list,
 * only when it holds one; and ONE compare link.
 *
 * WHY BOTH LISTS. The design took the commit list from GitHub's `releases/generate-notes`. MEASURED
 * 2026-11-09 for v0.1.1...v0.1.3: its `body` was the compare link alone -- it lists merged PULL
 * REQUESTS, and this repository merges by push -- so the commit list is `git log`'s, and GitHub's
 * appears beside it whenever there are pull requests to list.
 */
export function composeNotes({ version, repo, previous, scriv, commits, pulls }) {
  const parts = [
    header(version),
    `## What changed\n\n${scriv.replace(/\s+$/, '')}\n`,
    `## Commits\n\n${commits.replace(/\s+$/, '')}\n`,
  ];
  const prs = pullList(pulls);
  if (prs !== '') parts.push(`## Pull requests\n\n${prs}\n`);
  parts.push(`**Full changelog**: https://github.com/${repo}/compare/${previous}...v${version}\n`);
  return parts.join('\n');
}

/** What `changelog.d/` may hold between releases: scriv's config and the fragment template. */
const NOT_FRAGMENTS = ['scriv.ini', '_template.md.jinja'];

/**
 * Changelog-readiness problems for `version`, each naming the fix: `scriv print --version` exited
 * `scrivExit` with `scrivText` on stdout (2 is scriv 1.8.1's "Unable to find version", measured);
 * `entries` are the names in `fragmentDir`, where anything but `NOT_FRAGMENTS` is a fragment
 * written and never collected.
 */
export function changelogProblems({ version, scrivExit, scrivText, fragmentDir, entries }) {
  const problems = [];
  if (scrivExit === 2) {
    problems.push(`CHANGELOG.md has no entry for ${version}: run uvx scriv collect --version ${version} and commit it`);
  } else if (scrivExit !== 0) {
    problems.push(`scriv print --version ${version} exited ${scrivExit}: is scriv installed (pipx install scriv==1.8.1), and is this the repository root?`);
  } else if (scrivText.trim() === '') {
    problems.push(`CHANGELOG.md's entry for ${version} is empty: fill it in, or write fragments and collect them`);
  }
  const fragments = entries.filter((e) => !NOT_FRAGMENTS.includes(e)).sort();
  if (fragments.length > 0) {
    problems.push(`uncollected fragments in ${fragmentDir}: ${fragments.join(', ')}: run uvx scriv collect --version ${version} (or delete them) and commit`);
  }
  return problems;
}
