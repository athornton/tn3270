#!/usr/bin/env node
/**
 * The GitHub release's rules: which installers it carries, their `SHA256SUMS`, the previous
 * release tag, the notes, and whether the changelog is ready
 * (`docs/superpowers/specs/2026-11-09-github-release-and-changelog-design.md`).
 *
 *   node scripts/release-notes.mjs --check-changelog X.Y.Z   release-check: refuse a version with no
 *                                                            CHANGELOG.md entry, or uncollected fragments
 *   node scripts/release-notes.mjs --check-installers DIR X.Y.Z
 *                                                            release-check, before npm publish: DIR holds
 *                                                            exactly the seven installers of X.Y.Z
 *   node scripts/release-notes.mjs --compose DIR             github-release: check DIR's installers, write
 *                                                            DIR/SHA256SUMS, and release-notes.md in the
 *                                                            REPOSITORY ROOT (not the cwd; the same in CI)
 *   node scripts/release-notes.mjs --verify-release DIR      github-release, last: the release's assets are
 *                                                            exactly DIR's files, by size and digest
 *   node scripts/release-notes.mjs --dry-run DIR             every push: the same, for this runner's own
 *                                                            installers, no tag and no network; changelog
 *                                                            problems are WARNINGS (normal between releases)
 *
 * `scriv` is env SCRIV (split on spaces: `SCRIV="uvx scriv"` works), default `scriv`; `gh` is env
 * GH, default `gh`. Both, and `git`, run in the repository root, where scriv finds
 * `changelog.d/scriv.ini`.
 *
 * DEPENDENCY-FREE: the release jobs run it with no `npm ci`, so it imports `node:` modules only.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** The fixed part of every release's notes, for `repo` (owner/name). */
function header(version, repo) {
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
    `Not root? See *Installing* in the [README](https://github.com/${repo}#installing) for a`,
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

/**
 * GitHub's generated notes minus their own `**Full Changelog**` line, `## What's Changed` heading
 * and HTML comments (`<!-- Release notes generated using configuration ... -->`, which renders as
 * nothing); '' when nothing else is left.
 */
function pullList(body) {
  return (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\*\*Full Changelog\*\*:/.test(l))
    .join('\n')
    .replace(/^## What's Changed\n/m, '')
    .trim();
}

/**
 * `text` safe as markdown prose: `&`, `<`, `>` as entities (a `<userid>` would be an HTML tag and
 * vanish), and `\ ` * _ [ ] # | ~ @` backslash-escaped (no emphasis, link, heading, table, strike
 * or `@login` mention -- a mention would NOTIFY that user).
 */
export function escapeMarkdown(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#|~]/g, (c) => `\\${c}`)
    // A leading list marker would nest a list inside the bullet (measured through GitHub's renderer).
    .replace(/^([-+])(?=\s)/, '\\$1').replace(/^(\d+)([.)])(?=\s)/, '$1\\$2')
    // `@` LAST, and broken with an EMPTY HTML COMMENT -- after the `<`/`>` escaping, so the comment
    // is not escaped itself. A backslash does NOT stop a mention: measured 2026-11-10 through
    // GitHub's renderer, `\\@athornton` and `&#64;athornton` still render as user-mention links
    // (and would notify), while `@<!-- -->athornton` renders as plain text and copies cleanly.
    .replace(/@/g, '@<!-- -->');
}

/** `git log --format=%s%x00%h` -> `- subject (hash)` lines, each subject escaped. */
export function commitList(gitLog) {
  return gitLog.split('\n').filter((l) => l !== '').map((l) => {
    const nul = l.lastIndexOf('\0');
    const [subject, hash] = nul < 0 ? [l, ''] : [l.slice(0, nul), l.slice(nul + 1)];
    return `- ${escapeMarkdown(subject)}${hash !== '' ? ` (${hash})` : ''}\n`;
  }).join('');
}

/**
 * The release notes, in markdown: the fixed header; `## What changed` with `scriv print`'s text
 * verbatim; `## Commits` with the commit list (markdown already: `commitList`'s); `## Pull requests` with GitHub's generated list,
 * only when it holds one; and ONE compare link.
 *
 * WHY BOTH LISTS. The design took the commit list from GitHub's `releases/generate-notes`. MEASURED
 * 2026-11-09 for v0.1.1...v0.1.3: its `body` was the compare link alone -- it lists merged PULL
 * REQUESTS, and this repository merges by push -- so the commit list is `git log --first-parent`'s
 * (the merges' own descriptive subjects, not every branch commit), and GitHub's appears beside it
 * whenever there are pull requests to list.
 */
export function composeNotes({ version, repo, previous, scriv, commits, pulls }) {
  const parts = [
    header(version, repo),
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
  } else if (!/^[ \t]*[-*][ \t]+\S/m.test(scrivText)) {
    // An untouched template collects to its headings and bare `-` lines. `[ \t]`, not `\s`: across
    // lines, `\s+` would read a bare `-`, a blank line and the next `### heading` as an item.
    problems.push(`CHANGELOG.md's entry for ${version} has no item (no "- something" line): write one under the category it belongs to`);
  }
  const fragments = entries.filter((e) => !NOT_FRAGMENTS.includes(e)).sort();
  if (fragments.length > 0) {
    problems.push(`uncollected fragments in ${fragmentDir}: ${fragments.join(', ')}: run uvx scriv collect --version ${version} (or delete them) and commit`);
  }
  return problems;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUMS = 'SHA256SUMS';
const NOTES = 'release-notes.md';
/** The upload patterns of the `package` job's `gui-*` artifacts (`.github/workflows/package.yml`). */
const INSTALLER_EXT = ['.AppImage', '.deb', '.dmg', '.zip', '.exe'];

const USAGE = 'usage: node scripts/release-notes.mjs --check-changelog X.Y.Z | --check-installers DIR X.Y.Z | --compose DIR | --verify-release DIR | --dry-run DIR';

class Refusal extends Error {}

/** `env[name]` as a command and its leading arguments, `fallback` if unset or blank. */
function command(env, name, fallback) {
  const words = (env[name] ?? '').trim().split(/\s+/).filter((w) => w !== '');
  return words.length > 0 ? words : [fallback];
}

/** The regular files in `dir`, sorted. Refuses an unreadable directory. */
function filesIn(dir) {
  try {
    return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort();
  } catch (err) {
    throw new Refusal(`cannot read ${dir}: ${err.message}`);
  }
}

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `scriv print --version v`, and changelog.d's entries: the inputs of `changelogProblems`. */
function changelogState(v, { env, run, root }) {
  const [cmd, ...pre] = command(env, 'SCRIV', 'scriv');
  const r = run(cmd, [...pre, 'print', '--version', v], { cwd: root });
  let entries;
  try { entries = readdirSync(join(root, 'changelog.d')); } catch (err) {
    throw new Refusal(`cannot read changelog.d: ${err.message}`);
  }
  return { version: v, scrivExit: r.status, scrivText: r.stdout, fragmentDir: 'changelog.d', entries };
}

/** The tag this run is for, as `{ tag, version }`: a tag push only. */
function tagOf(env, mode) {
  const tag = env.GITHUB_REF_NAME;
  if (tag === undefined || tag === '') {
    throw new Refusal(`GITHUB_REF_NAME is not set: ${mode} runs on a tag push, which sets it to the tag`);
  }
  // A BRANCH named v0.1.4 has that GITHUB_REF_NAME too.
  if (env.GITHUB_REF_TYPE !== 'tag') {
    throw new Refusal(`GITHUB_REF_TYPE is ${JSON.stringify(env.GITHUB_REF_TYPE ?? '')}, not "tag": ${mode} runs on a tag push only`);
  }
  const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (m === null) throw new Refusal(`tag ${JSON.stringify(tag)} is not v + a version X.Y.Z: tag a release as e.g. v0.1.4`);
  return { tag, version: m[1] };
}

/** `run`, refusing a non-zero exit with what was run. */
function must(run, cmd, args, root, why) {
  const r = run(cmd, args, { cwd: root });
  if (r.status !== 0) throw new Refusal(`${[cmd, ...args].join(' ')} exited ${r.status}: ${why}`);
  return r.stdout;
}

/** The installers' `SHA256SUMS` text, for `files` in `dir`. */
function sumsOver(dir, files) {
  return sha256sums(files.map((name) => ({ name, sha256: sha256Of(join(dir, name)) })));
}

/**
 * The five modes, with everything outside the process injected: `env` (`GITHUB_REF_NAME`,
 * `GITHUB_REF_TYPE`, `GITHUB_REPOSITORY`, `GITHUB_ACTIONS`, `SCRIV`, `GH`), `run(cmd, args, { cwd })
 * -> { status, stdout }` (scriv, git, gh; stderr is the caller's), `log`, and optionally `root`
 * (the repository: changelog.d, package.json, and where --compose writes release-notes.md) and the
 * `platform`/`arch` whose installers a dry run expects. Returns the exit status: 0, or 1 with
 * every problem logged.
 */
export function main(argv, { env, run, log, root = ROOT, platform = process.platform, arch = process.arch }) {
  const [mode, arg, ...rest] = argv;
  try {
    const arity = { '--check-changelog': 1, '--check-installers': 2, '--compose': 1, '--verify-release': 1, '--dry-run': 1 }[mode];
    if (arity === undefined || argv.length !== 1 + arity) throw new Refusal(USAGE);

    if (mode === '--check-installers') {
      // release-check, BEFORE npm publish (which cannot be undone): the run made all seven.
      const v = rest[0];
      if (!SEMVER.test(v)) throw new Refusal(`${JSON.stringify(v)} is not a version X.Y.Z (no v): pass e.g. "\${GITHUB_REF_NAME#v}"`);
      const files = filesIn(arg).filter((f) => f !== SUMS);
      const bad = checkInstallers(files, v);
      if (bad.length > 0) throw new Refusal(bad.join('\n'));
      log(`release-notes: ${arg} holds exactly the ${files.length} installers of ${v}`);
      return 0;
    }

    if (mode === '--check-changelog') {
      if (!SEMVER.test(arg)) throw new Refusal(`${JSON.stringify(arg)} is not a version X.Y.Z (no v): pass e.g. "\${GITHUB_REF_NAME#v}"`);
      const problems = changelogProblems(changelogState(arg, { env, run, root }));
      if (problems.length > 0) throw new Refusal(problems.join('\n'));
      log(`release-notes: CHANGELOG.md has an entry for ${arg}, and no fragment is left uncollected`);
      return 0;
    }

    if (mode === '--dry-run') {
      let version;
      try { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch (err) {
        throw new Refusal(`cannot read the root package.json's version: ${err.message}`);
      }
      const mine = installersFor(version, platform, arch);
      if (mine.length === 0) throw new Refusal(`no installers are built on ${platform}-${arch}: run the dry run on a packaging runner`);
      // Only the installers: electron-builder leaves blockmaps, unpacked trees and its debug yml here too.
      const files = filesIn(arg).filter((f) => INSTALLER_EXT.some((e) => f.endsWith(e)));
      const bad = checkInstallers(files, version, mine);
      if (bad.length > 0) throw new Refusal(bad.join('\n'));
      const state = changelogState(version, { env, run, root });
      // A missing entry is normal between releases; a scriv that does not run is a broken step.
      if (state.scrivExit !== 0 && state.scrivExit !== 2) throw new Refusal(changelogProblems(state)[0]);
      for (const p of changelogProblems(state)) {
        log(`release-notes: WARNING: ${p}`);
        if (env.GITHUB_ACTIONS === 'true') log(`::warning::${p}`);
      }
      const scriv = state.scrivExit === 0 && state.scrivText.trim() !== ''
        ? state.scrivText
        : `(no CHANGELOG.md entry for ${version} yet: \`uvx scriv collect --version ${version}\` writes it at release)`;
      const notes = composeNotes({
        version, repo: env.GITHUB_REPOSITORY || 'athornton/tn3270', previous: 'vPREVIOUS', scriv,
        commits: '(a tag run lists the commits since the previous release tag here)',
      });
      log(`release-notes: dry run of ${version}, ${platform}-${arch}: ${SUMS} would be`);
      for (const l of sumsOver(arg, files).trimEnd().split('\n')) log(`  ${l}`);
      log(`release-notes: and ${NOTES}:`);
      for (const l of notes.trimEnd().split('\n')) log(`  ${l}`);
      log(`release-notes: dry run of ${version} passed`);
      return 0;
    }

    const { tag, version } = tagOf(env, mode);
    const gh = command(env, 'GH', 'gh');
    const repo = env.GITHUB_REPOSITORY;
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Refusal(`GITHUB_REPOSITORY is ${JSON.stringify(repo ?? '')}, not owner/name: Actions sets it`);

    if (mode === '--compose') {
      // A re-run's own SHA256SUMS is rewritten, not checked as an installer.
      const files = filesIn(arg).filter((f) => f !== SUMS);
      const bad = checkInstallers(files, version);
      if (bad.length > 0) throw new Refusal(bad.join('\n'));
      const state = changelogState(version, { env, run, root });
      const problems = changelogProblems(state);
      if (problems.length > 0) throw new Refusal(problems.join('\n'));
      const tags = must(run, 'git', ['tag', '--merged', tag, '--list', 'v*.*.*'], root,
        'check out with fetch-depth: 0, so the tags and history are there').split('\n').map((t) => t.trim()).filter((t) => t !== '');
      const previous = previousTag(tags, version);
      if (previous === undefined) {
        throw new Refusal(`no release tag below ${tag} is an ancestor of it (tags merged: ${tags.join(', ') || 'none'}): check out with fetch-depth: 0`);
      }
      const scriv = state.scrivText;
      // --first-parent: the mainline -- merges (whose subjects describe the branch), release
      // commits, direct commits -- not every commit of every merged branch, plans and specs included.
      // NUL-separated, so no subject can be mistaken for the hash.
      const commits = commitList(must(run, 'git', ['log', '--first-parent', '--format=%s%x00%h', `${previous}..${tag}`], root, 'cannot list the commits'));
      const [ghCmd, ...ghPre] = gh;
      const answer = must(run, ghCmd, [...ghPre, 'api', `repos/${repo}/releases/generate-notes`,
        '-f', `tag_name=${tag}`, '-f', `previous_tag_name=${previous}`], root, 'set GH_TOKEN, and give the job contents: write');
      let pulls;
      try { pulls = JSON.parse(answer).body; } catch (err) { throw new Refusal(`generate-notes did not answer JSON: ${err.message}`); }
      if (typeof pulls !== 'string') throw new Refusal('generate-notes answered no string body');
      writeFileSync(join(arg, SUMS), sumsOver(arg, files));
      const notesPath = join(root, NOTES);
      writeFileSync(notesPath, composeNotes({ version, repo, previous, scriv, commits, pulls }));
      log(`release-notes: ${tag} over ${previous}: ${files.length} installers, wrote ${join(arg, SUMS)} and ${notesPath}`);
      return 0;
    }

    // --verify-release: what the release holds, read back (the REST API, for `digest`), against
    // what was handed to it.
    const local = filesIn(arg);
    if (!local.includes(SUMS)) throw new Refusal(`${arg} has no ${SUMS}: run --compose first`);
    const [ghCmd, ...ghPre] = gh;
    const answer = must(run, ghCmd, [...ghPre, 'api', `repos/${repo}/releases/tags/${tag}`], root, 'is the release there, and GH_TOKEN set?');
    let assets;
    try { assets = JSON.parse(answer).assets; } catch (err) { throw new Refusal(`the release API did not answer JSON: ${err.message}`); }
    if (!Array.isArray(assets)) throw new Refusal('the release API answered no assets list');
    const problems = [];
    const remote = new Map(assets.map((a) => [a?.name, a]));
    for (const f of local) {
      const a = remote.get(f);
      const size = statSync(join(arg, f)).size;
      if (a === undefined) problems.push(`the release has no ${f}: re-run the github-release job`);
      else if (a.state !== 'uploaded') problems.push(`the release's ${f} is ${JSON.stringify(a.state)}, not uploaded: re-run the github-release job`);
      else if (a.size !== size) problems.push(`the release's ${f} is ${a.size} bytes, not ${size}: re-run the github-release job (it uploads with --clobber)`);
      // `digest` ("sha256:<hex>") is GitHub's own hash of the stored asset; null on assets uploaded
      // before GitHub computed one (measured: cli/cli v2.46.0's), where the size has to do.
      else if (typeof a.digest === 'string' && a.digest !== `sha256:${sha256Of(join(arg, f))}`) {
        problems.push(`the release's ${f} has digest ${a.digest}, not sha256:${sha256Of(join(arg, f))}: re-run the github-release job (it uploads with --clobber)`);
      }
      if (size === 0) problems.push(`${f} is empty here: re-run the packaging job that made it`);
    }
    for (const name of remote.keys()) {
      if (!local.includes(name)) problems.push(`the release has ${name}, which this run did not make: delete it (gh release delete-asset ${tag} ${name})`);
    }
    if (problems.length > 0) throw new Refusal(problems.join('\n'));
    log(`release-notes: ${tag} holds exactly the ${local.length} files of ${arg}, each at its size and (where GitHub gives one) digest`);
    return 0;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    for (const line of err.message.split('\n')) log(`release-notes: refused: ${line}`);
    return 1;
  }
}

/**
 * `cmd args...` in `cwd`, stdout captured, stderr passed through (scriv's "Extracting entry..."
 * chatter, git's and gh's errors). A command that cannot start is status 127, its error on stderr.
 */
export function runCommand(cmd, args, { cwd }) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) {
    process.stderr.write(`release-notes: cannot run ${cmd}: ${r.error.message}\n`);
    return { status: 127, stdout: '' };
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2), { env: process.env, run: runCommand, log: console.log });
}
