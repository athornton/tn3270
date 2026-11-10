import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  changelogProblems, checkInstallers, commitList, composeNotes, escapeMarkdown, expectedInstallers, installersFor, main, previousTag, runCommand, sha256sums,
  type RunResult,
} from '../../../scripts/release-notes.mjs';

/** The seven names run 42691997098 uploaded, for 0.1.3, with the version swapped. */
const SEVEN = (v: string) => [
  `TN3270-${v}-mac-universal.dmg`,
  `TN3270-${v}-mac-universal.zip`,
  `TN3270-${v}-linux-x86_64.AppImage`,
  `TN3270-${v}-linux-amd64.deb`,
  `TN3270-${v}-linux-arm64.AppImage`,
  `TN3270-${v}-linux-arm64.deb`,
  `TN3270-${v}-win-x64.exe`,
];

describe('release-notes.mjs', () => {
  describe('expectedInstallers', () => {
    it('is the seven a tag run uploads, named by electron-builder', () => {
      expect([...expectedInstallers('0.1.4')].sort()).toEqual(SEVEN('0.1.4').sort());
    });
  });

  describe('installersFor', () => {
    it("gives each packaging runner's own share of the seven", () => {
      expect(installersFor('0.1.4', 'linux', 'x64')).toEqual(['TN3270-0.1.4-linux-x86_64.AppImage', 'TN3270-0.1.4-linux-amd64.deb']);
      expect(installersFor('0.1.4', 'linux', 'arm64')).toEqual(['TN3270-0.1.4-linux-arm64.AppImage', 'TN3270-0.1.4-linux-arm64.deb']);
      expect(installersFor('0.1.4', 'darwin', 'arm64')).toEqual(['TN3270-0.1.4-mac-universal.dmg', 'TN3270-0.1.4-mac-universal.zip']);
      expect(installersFor('0.1.4', 'darwin', 'x64')).toEqual(installersFor('0.1.4', 'darwin', 'arm64'));
      expect(installersFor('0.1.4', 'win32', 'x64')).toEqual(['TN3270-0.1.4-win-x64.exe']);
    });

    it('is empty for a platform no runner packages', () => {
      expect(installersFor('0.1.4', 'freebsd', 'x64')).toEqual([]);
    });
  });

  describe('checkInstallers', () => {
    it('passes exactly the seven, in any order', () => {
      expect(checkInstallers([...SEVEN('0.1.4')].reverse(), '0.1.4')).toEqual([]);
    });

    it('names a missing installer', () => {
      const p = checkInstallers(SEVEN('0.1.4').filter((f) => !f.endsWith('.exe')), '0.1.4');
      expect(p).toHaveLength(1);
      expect(p[0]).toMatch(/^missing TN3270-0\.1\.4-win-x64\.exe: /);
    });

    it('names an extra file', () => {
      const p = checkInstallers([...SEVEN('0.1.4'), 'TN3270-0.1.4-linux-x86_64.AppImage.blockmap'], '0.1.4');
      expect(p).toHaveLength(1);
      expect(p[0]).toMatch(/^unexpected file TN3270-0\.1\.4-linux-x86_64\.AppImage\.blockmap: /);
    });

    it('names an installer for another version, once, as that and not as an extra', () => {
      const files = SEVEN('0.1.4').map((f) => (f.endsWith('.deb') && f.includes('amd64') ? f.replace('0.1.4', '0.1.3') : f));
      const p = checkInstallers(files, '0.1.4');
      expect(p).toEqual([
        expect.stringMatching(/^missing TN3270-0\.1\.4-linux-amd64\.deb: /),
        expect.stringMatching(/^TN3270-0\.1\.3-linux-amd64\.deb is for version 0\.1\.3, not 0\.1\.4: .*version:set -- 0\.1\.4/),
      ]);
    });

    it('checks against a given subset (a dry run on one platform) and still refuses foreign installers', () => {
      const linux = installersFor('0.1.4', 'linux', 'x64');
      expect(checkInstallers(linux, '0.1.4', linux)).toEqual([]);
      expect(checkInstallers([linux[0]!], '0.1.4', linux)).toEqual([expect.stringMatching(/^missing TN3270-0\.1\.4-linux-amd64\.deb: /)]);
      expect(checkInstallers([...linux, 'notes.txt'], '0.1.4', linux)).toEqual([expect.stringMatching(/^unexpected file notes\.txt: /)]);
    });
  });

  describe('sha256sums', () => {
    const entries = [
      { name: 'b.deb', sha256: 'b'.repeat(64) },
      { name: 'B.exe', sha256: 'c'.repeat(64) },
      { name: 'a.dmg', sha256: 'a'.repeat(64) },
    ];

    it('is `sha256  name` lines sorted by name (bytewise), newline-terminated', () => {
      expect(sha256sums(entries)).toBe(`${'c'.repeat(64)}  B.exe\n${'a'.repeat(64)}  a.dmg\n${'b'.repeat(64)}  b.deb\n`);
    });

    it('is what sha256sum -c accepts, over real files', (ctx) => {
      if (spawnSync('sha256sum', ['--version']).status !== 0) {
        ctx.skip('no sha256sum on this machine (macOS and Windows runners): the format test above still ran');
      }
      const d = mkdtempSync(join(tmpdir(), 'sums-'));
      try {
        const files = { 'TN3270-0.1.4-win-x64.exe': 'exe bytes', 'TN3270-0.1.4-linux-amd64.deb': 'deb bytes\n' };
        for (const [n, text] of Object.entries(files)) writeFileSync(join(d, n), text);
        const sums = sha256sums(Object.entries(files).map(([name, text]) => ({ name, sha256: createHash('sha256').update(text).digest('hex') })));
        writeFileSync(join(d, 'SHA256SUMS'), sums);
        const ok = spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: d, encoding: 'utf8' });
        expect(ok.stdout).toBe('TN3270-0.1.4-linux-amd64.deb: OK\nTN3270-0.1.4-win-x64.exe: OK\n');
        expect(ok.status).toBe(0);
        // And it is really checking: one changed byte fails it.
        writeFileSync(join(d, 'TN3270-0.1.4-win-x64.exe'), 'exe bytez');
        expect(spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: d }).status).not.toBe(0);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });
  });

  describe('previousTag', () => {
    it('is the highest release tag lower than the version', () => {
      expect(previousTag(['v0.1.0', 'v0.1.1', 'v0.1.3', 'v0.1.4'], '0.1.4')).toBe('v0.1.3');
    });

    it('compares numerically, not as strings, and ignores order', () => {
      expect(previousTag(['v0.10.0', 'v0.9.0', 'v0.2.0'], '0.11.0')).toBe('v0.10.0');
      expect(previousTag(['v1.0.0', 'v0.9.9'], '1.0.1')).toBe('v1.0.0');
    });

    it('ignores higher tags and tags that are not vX.Y.Z', () => {
      expect(previousTag(['v0.1.3', 'v0.2.0', 'v0.1.5', 'latest', 'v0.1.4-rc1', 'v0.1.x', 'x0.1.2'], '0.1.4')).toBe('v0.1.3');
    });

    it('is undefined for the first release', () => {
      expect(previousTag(['v0.1.0'], '0.1.0')).toBeUndefined();
      expect(previousTag([], '0.1.0')).toBeUndefined();
    });

    it('refuses a version that is not X.Y.Z', () => {
      expect(() => previousTag(['v0.1.0'], 'v0.1.1')).toThrow(/X\.Y\.Z/);
    });
  });

  describe('composeNotes', () => {
    const SCRIV = '### New features\n\n- A thing users can see.\n\n### Bug fixes\n\n- A thing that broke, fixed.\n';
    const COMMITS = '- release: 0.1.4 (abc1234)\n- the fix (def5678)\n';
    const notes = composeNotes({ version: '0.1.4', repo: 'athornton/tn3270', previous: 'v0.1.3', scriv: SCRIV, commits: COMMITS });

    it('has the header, then What changed, then Commits, then the compare link, in that order', () => {
      const at = (s: string) => notes.indexOf(s);
      expect(at('## Installing')).toBeGreaterThan(-1);
      expect(at('## Installing')).toBeLessThan(at('## What changed'));
      expect(at('## What changed')).toBeLessThan(at('## Commits'));
      expect(at('## Commits')).toBeLessThan(at('**Full changelog**'));
      expect(notes.trimEnd().split('\n').at(-1)).toBe('**Full changelog**: https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4');
      expect(notes.endsWith('\n')).toBe(true);
      // Each heading after a blank line, or markdown runs it into the paragraph above.
      for (const h of ['## What changed', '## Commits', '**Full changelog**']) expect(notes).toContain(`\n\n${h}`);
    });

    it('carries the scriv text and the commit list verbatim, each under its heading', () => {
      expect(notes).toContain(`## What changed\n\n${SCRIV}`);
      expect(notes).toContain(`## Commits\n\n${COMMITS}`);
    });

    it('puts the version into every npm install command', () => {
      for (const p of ['cli', 'tui', 'web', 'gui']) expect(notes).toContain(`npm install -g @tn3270/${p}@0.1.4`);
      expect(notes).not.toMatch(/npm install -g @tn3270\/\w+(?!@0\.1\.4)\s/);
    });

    it('says the installers are unsigned, and how to verify the checksums and provenance', () => {
      expect(notes).toMatch(/unsigned/i);
      expect(notes).toContain('Open Anyway');
      expect(notes).toContain('Run anyway');
      expect(notes).toContain('sha256sum -c SHA256SUMS');
      expect(notes).toContain('shasum -a 256 -c SHA256SUMS');
      expect(notes).toContain('npm audit signatures');
    });

    it('names each installer for this version', () => {
      for (const f of expectedInstallers('0.1.4')) expect(notes).toContain(f);
    });

    it("adds GitHub's generated pull-request list when it has one, without its own compare link", () => {
      const pulls = "## What's Changed\n* Fix a thing by @someone in https://github.com/athornton/tn3270/pull/7\n\n"
        + '**Full Changelog**: https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4';
      const n = composeNotes({ version: '0.1.4', repo: 'athornton/tn3270', previous: 'v0.1.3', scriv: SCRIV, commits: COMMITS, pulls });
      expect(n).toContain('## Pull requests\n\n* Fix a thing by @someone in https://github.com/athornton/tn3270/pull/7\n');
      expect(n.indexOf('## Commits')).toBeLessThan(n.indexOf('## Pull requests'));
      expect(n.match(/Full [Cc]hangelog/g)).toHaveLength(1);
    });

    it("omits the pull-request section when only GitHub's generator comment and compare link are left", () => {
      const n = composeNotes({
        version: '0.1.4', repo: 'athornton/tn3270', previous: 'v0.1.3', scriv: SCRIV, commits: COMMITS,
        pulls: '<!-- Release notes generated using configuration in .github/release.yml at v0.1.4 -->\n\n'
          + '**Full Changelog**: https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4',
      });
      expect(n).toBe(notes);
    });

    it('links the README of the repository it is given', () => {
      const n = composeNotes({ version: '0.1.4', repo: 'someone/fork', previous: 'v0.1.3', scriv: SCRIV, commits: COMMITS });
      expect(n).toContain('(https://github.com/someone/fork#installing)');
      expect(n).not.toContain('athornton');
    });

    it("omits the pull-request section when GitHub's list is only its compare link (no pull requests: this repo, measured)", () => {
      const n = composeNotes({
        version: '0.1.4', repo: 'athornton/tn3270', previous: 'v0.1.3', scriv: SCRIV, commits: COMMITS,
        pulls: '**Full Changelog**: https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4',
      });
      expect(n).not.toContain('## Pull requests');
      expect(n).toBe(notes);
    });
  });

  describe('changelogProblems', () => {
    const ok = { version: '0.1.4', scrivExit: 0, scrivText: '### Bug fixes\n\n- x\n', fragmentDir: 'changelog.d', entries: ['scriv.ini', '_template.md.jinja'] };

    it('accepts a section and only scriv.ini and the template', () => {
      expect(changelogProblems(ok)).toEqual([]);
    });

    it('refuses a version with no section (scriv print exits 2), naming the fix', () => {
      const p = changelogProblems({ ...ok, scrivExit: 2, scrivText: '' });
      expect(p).toEqual([expect.stringMatching(/no entry for 0\.1\.4.*scriv collect --version 0\.1\.4/)]);
    });

    it('refuses any other scriv failure as that, not as a missing section', () => {
      const p = changelogProblems({ ...ok, scrivExit: 127, scrivText: '' });
      expect(p).toEqual([expect.stringMatching(/exited 127.*installed/)]);
    });

    it('refuses a section with no item: an untouched template collects to headings and bare dashes', () => {
      const untouched = '### Backwards-incompatible changes\n\n-\n\n### New features\n\n-\n\n### Bug fixes\n\n-\n\n### Other changes\n\n-\n';
      expect(changelogProblems({ ...ok, scrivText: untouched })).toEqual([expect.stringMatching(/entry for 0\.1\.4 has no item/)]);
      expect(changelogProblems({ ...ok, scrivText: '### Bug fixes\n\nSome prose, no list.\n' })).toHaveLength(1);
      expect(changelogProblems({ ...ok, scrivText: '### Bug fixes\n\n* starred\n' })).toEqual([]);
      expect(changelogProblems({ ...ok, scrivText: '### Bug fixes\n\n-\n- a real one\n' })).toEqual([]);
    });

    it('refuses a blank section', () => {
      expect(changelogProblems({ ...ok, scrivText: ' \n\n' })).toEqual([expect.stringMatching(/entry for 0\.1\.4 is empty/)]);
    });

    it('refuses a fragment left in changelog.d, naming it', () => {
      const p = changelogProblems({ ...ok, entries: [...ok.entries, '20261109_221219_athornton_gh_release.md'] });
      expect(p).toEqual([expect.stringMatching(/uncollected .*changelog\.d.*20261109_221219_athornton_gh_release\.md.*scriv collect/)]);
    });

    it('reports both problems at once', () => {
      expect(changelogProblems({ ...ok, scrivExit: 2, scrivText: '', entries: [...ok.entries, 'a.md'] })).toHaveLength(2);
    });
  });

  describe('escapeMarkdown and commitList', () => {
    it('neutralises HTML, headings, emphasis, links, tables, strikes and mentions', () => {
      // `@` is broken with an EMPTY HTML COMMENT, not a backslash: measured through GitHub's renderer
      // (gfm, context athornton/tn3270, 2026-11-10), `\\@athornton` and `&#64;athornton` still
      // render as user-mention links; `@<!-- -->athornton` renders as plain text and copies cleanly.
      expect(escapeMarkdown('#x <y> @z *w*')).toBe('\\#x &lt;y&gt; @<!-- -->z \\*w\\*');
      expect(escapeMarkdown('a & b [l](u) `c` _u_ |t| ~s~ \\')).toBe('a &amp; b \\[l\\](u) \\`c\\` \\_u\\_ \\|t\\| \\~s\\~ \\\\');
    });

    it('a subject that starts like a list item cannot nest a list (measured: `- `, `+ `, `1. ` did)', () => {
      expect(escapeMarkdown('- dash')).toBe('\\- dash');
      expect(escapeMarkdown('+ plus')).toBe('\\+ plus');
      expect(escapeMarkdown('1. one')).toBe('1\\. one');
      expect(escapeMarkdown('12) twelve')).toBe('12\\) twelve');
      // Only at the START: the same characters mid-subject are left alone.
      expect(escapeMarkdown('a - b + c 1. d')).toBe('a - b + c 1. d');
    });

    it('keeps a real subject whose <userid> GitHub would swallow as a tag (2d0041c)', () => {
      expect(commitList('docs: /c u=<userid> frees a held TSO userid on TK5, and HERC01 is free again\x002d0041c\n'))
        .toBe('- docs: /c u=&lt;userid&gt; frees a held TSO userid on TK5, and HERC01 is free again (2d0041c)\n');
    });

    it('makes one bullet per line, hash last, and a leading # cannot become a heading', () => {
      expect(commitList('#x <y> @z *w*\x00abc1234\nrelease: 0.1.4\x00def5678\n\n'))
        .toBe('- \\#x &lt;y&gt; @<!-- -->z \\*w\\* (abc1234)\n- release: 0.1.4 (def5678)\n');
      expect(commitList('')).toBe('');
    });
  });

  describe('runCommand', () => {
    it('returns the exit status and stdout, running in cwd', () => {
      const d = mkdtempSync(join(tmpdir(), 'runcmd-'));
      try {
        const r = runCommand(process.execPath, ['-e', 'process.stdout.write(process.cwd()); process.exit(3)'], { cwd: d });
        expect(r.status).toBe(3);
        expect(realpathSync(r.stdout)).toBe(realpathSync(d));
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    });

    it('is 127, with empty stdout, for a command that cannot start', () => {
      expect(runCommand('no-such-command-for-release-notes', [], { cwd: tmpdir() })).toEqual({ status: 127, stdout: '' });
    });
  });

  describe('main', () => {
    const SCRIV_0_1_4 = '### Bug fixes\n\n- The fix users see.\n';
    let roots: string[] = [];
    afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); roots = []; });

    /**
     * A repository root (package.json at `version`, changelog.d with `fragments` beside scriv.ini
     * and the template) and an installers directory holding `installers`, each file its own name
     * as content. `run` fakes scriv (an entry for each of `sections`, else exit 2), git (tags
     * `tags`, the log) and gh (generate-notes `pulls`, release view `assets`), recording each call.
     */
    function io(opts: {
      version?: string; installers?: string[]; fragments?: string[]; sections?: Record<string, string>;
      tags?: string[]; pulls?: string; assets?: unknown[] | ((dir: string) => unknown[]); tag?: string; refType?: string; actions?: boolean;
      env?: Record<string, string>; fail?: string; platform?: string; arch?: string;
    } = {}) {
      const root = mkdtempSync(join(tmpdir(), 'relnotes-'));
      roots.push(root);
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: opts.version ?? '0.1.4' }));
      mkdirSync(join(root, 'changelog.d'));
      for (const f of ['scriv.ini', '_template.md.jinja', ...(opts.fragments ?? [])]) writeFileSync(join(root, 'changelog.d', f), '');
      const dir = join(root, 'installers');
      mkdirSync(dir);
      for (const f of opts.installers ?? expectedInstallers('0.1.4')) writeFileSync(join(dir, f), f);
      const sections = opts.sections ?? { '0.1.4': SCRIV_0_1_4 };
      const calls: { cmd: string; args: string[]; cwd: string }[] = [];
      const logs: string[] = [];
      const run = (cmd: string, args: string[], { cwd }: { cwd: string }): RunResult => {
        calls.push({ cmd, args, cwd });
        const line = [cmd, ...args].join(' ');
        if (opts.fail !== undefined && line.includes(opts.fail)) return { status: 1, stdout: '' };
        const scriv = args.indexOf('print');
        if (scriv >= 0 && args[scriv + 1] === '--version') {
          const text = sections[args[scriv + 2]!];
          return text === undefined ? { status: 2, stdout: '' } : { status: 0, stdout: text };
        }
        if (cmd === 'git' && args[0] === 'tag') return { status: 0, stdout: (opts.tags ?? ['v0.1.0', 'v0.1.1', 'v0.1.3', 'v0.1.4']).join('\n') + '\n' };
        if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: 'release: 0.1.4\0abc1234\nthe fix\0def5678\n' };
        if (args.includes('releases/generate-notes') || args.some((a) => a.endsWith('/releases/generate-notes'))) {
          return { status: 0, stdout: JSON.stringify({ name: 'v0.1.4', body: opts.pulls ?? '**Full Changelog**: https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4' }) };
        }
        if (args[0] === 'api' && args[1] === `repos/athornton/tn3270/releases/tags/${opts.tag}`) {
          const assets = typeof opts.assets === 'function' ? opts.assets(dir) : opts.assets ?? [];
          return { status: 0, stdout: JSON.stringify({ tag_name: opts.tag, assets }) };
        }
        throw new Error(`unexpected command: ${line}`);
      };
      const env: Record<string, string> = { GITHUB_REPOSITORY: 'athornton/tn3270', ...opts.env };
      if (opts.tag !== undefined) { env.GITHUB_REF_NAME = opts.tag; env.GITHUB_REF_TYPE = opts.refType ?? 'tag'; }
      if (opts.actions) env.GITHUB_ACTIONS = 'true';
      return {
        root, dir, calls, logs,
        args: { env, run, log: (l: string) => { logs.push(l); }, root, platform: opts.platform ?? 'linux', arch: opts.arch ?? 'x64' },
      };
    }

    it('refuses a bad mode, a missing argument or an extra one, with the usage', () => {
      for (const argv of [[], ['--publish', 'x'], ['--compose'], ['--compose', 'a', 'b'], ['--check-installers', 'd'], ['--check-installers', 'd', '0.1.4', 'x']]) {
        const x = io();
        expect(main(argv, x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/^release-notes: refused: usage: /)]);
      }
    });

    describe('--check-changelog', () => {
      it('passes a version with an entry and no fragments, running scriv print in the root', () => {
        const x = io();
        expect(main(['--check-changelog', '0.1.4'], x.args)).toBe(0);
        expect(x.calls).toEqual([{ cmd: 'scriv', args: ['print', '--version', '0.1.4'], cwd: x.root }]);
      });

      it('refuses a version with no entry, naming the fix', () => {
        const x = io();
        expect(main(['--check-changelog', '0.1.5'], x.args)).toBe(1);
        expect(x.logs).toEqual(['release-notes: refused: CHANGELOG.md has no entry for 0.1.5: run uvx scriv collect --version 0.1.5 and commit it']);
      });

      it('refuses a fragment left uncollected, naming it', () => {
        const x = io({ fragments: ['20261109_x.md'] });
        expect(main(['--check-changelog', '0.1.4'], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/^release-notes: refused: uncollected fragments in changelog\.d: 20261109_x\.md: /)]);
      });

      it('takes the scriv command from SCRIV, split on spaces', () => {
        const x = io({ env: { SCRIV: ' uvx  scriv ' } });
        expect(main(['--check-changelog', '0.1.4'], x.args)).toBe(0);
        expect(x.calls[0]).toMatchObject({ cmd: 'uvx', args: ['scriv', 'print', '--version', '0.1.4'] });
      });

      it('refuses a tag-shaped argument, saying how to strip the v', () => {
        const x = io();
        expect(main(['--check-changelog', 'v0.1.4'], x.args)).toBe(1);
        expect(x.logs[0]).toContain('GITHUB_REF_NAME#v');
        expect(x.calls).toEqual([]);
      });
    });

    describe('--compose', () => {
      it('writes SHA256SUMS over the seven and release-notes.md, with the previous tag found from git', () => {
        const x = io({ tag: 'v0.1.4' });
        expect(main(['--compose', x.dir], x.args)).toBe(0);
        const sums = readFileSync(join(x.dir, 'SHA256SUMS'), 'utf8');
        expect(sums).toBe(sha256sums(expectedInstallers('0.1.4').map((name) => ({ name, sha256: createHash('sha256').update(name).digest('hex') }))));
        const notes = readFileSync(join(x.root, 'release-notes.md'), 'utf8');
        expect(notes).toBe(composeNotes({
          version: '0.1.4', repo: 'athornton/tn3270', previous: 'v0.1.3', scriv: SCRIV_0_1_4,
          commits: '- release: 0.1.4 (abc1234)\n- the fix (def5678)\n',
        }));
        expect(x.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual([
          'scriv print --version 0.1.4',
          'git tag --merged v0.1.4 --list v*.*.*',
          'git log --first-parent --format=%s%x00%h v0.1.3..v0.1.4',
          'gh api repos/athornton/tn3270/releases/generate-notes -f tag_name=v0.1.4 -f previous_tag_name=v0.1.3',
        ]);
        expect(x.calls.every((c) => c.cwd === x.root)).toBe(true);
        expect(x.logs.at(-1)).toMatch(/v0\.1\.4 over v0\.1\.3: 7 installers, wrote .*SHA256SUMS and .*release-notes\.md$/);
      });

      it("carries GitHub's pull-request list when there is one", () => {
        const x = io({ tag: 'v0.1.4', pulls: "## What's Changed\n* PR by @a in https://github.com/athornton/tn3270/pull/1\n\n**Full Changelog**: x" });
        expect(main(['--compose', x.dir], x.args)).toBe(0);
        expect(readFileSync(join(x.root, 'release-notes.md'), 'utf8')).toContain('## Pull requests\n\n* PR by @a');
      });

      it('rewrites a SHA256SUMS already there (a re-run) instead of refusing it as an extra file', () => {
        const x = io({ tag: 'v0.1.4' });
        writeFileSync(join(x.dir, 'SHA256SUMS'), 'stale\n');
        expect(main(['--compose', x.dir], x.args)).toBe(0);
        expect(readFileSync(join(x.dir, 'SHA256SUMS'), 'utf8')).not.toContain('stale');
      });

      it('refuses a missing installer, and writes nothing', () => {
        const x = io({ tag: 'v0.1.4', installers: expectedInstallers('0.1.4').slice(1) });
        expect(main(['--compose', x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/^release-notes: refused: missing TN3270-0\.1\.4-mac-universal\.dmg: /)]);
        expect(existsSync(join(x.dir, 'SHA256SUMS'))).toBe(false);
        expect(existsSync(join(x.root, 'release-notes.md'))).toBe(false);
      });

      it('refuses a version with no changelog entry, before any network', () => {
        const x = io({ tag: 'v0.1.4', sections: {} });
        expect(main(['--compose', x.dir], x.args)).toBe(1);
        expect(x.logs[0]).toMatch(/no entry for 0\.1\.4/);
        expect(x.calls.some((c) => c.cmd === 'gh')).toBe(false);
      });

      it('refuses when no earlier release tag is an ancestor', () => {
        const x = io({ tag: 'v0.1.4', tags: ['v0.1.4'] });
        expect(main(['--compose', x.dir], x.args)).toBe(1);
        expect(x.logs[0]).toMatch(/no release tag below v0\.1\.4 is an ancestor of it .*fetch-depth: 0/);
      });

      it('refuses a failing generate-notes call, naming the token', () => {
        const x = io({ tag: 'v0.1.4', fail: 'generate-notes' });
        expect(main(['--compose', x.dir], x.args)).toBe(1);
        expect(x.logs[0]).toMatch(/generate-notes .* exited 1: set GH_TOKEN/);
      });

      it('refuses without a tag push: no ref, a branch named like a tag, a tag not vX.Y.Z', () => {
        const none = io();
        expect(main(['--compose', none.dir], none.args)).toBe(1);
        expect(none.logs[0]).toMatch(/GITHUB_REF_NAME is not set/);
        const branch = io({ tag: 'v0.1.4', refType: 'branch' });
        expect(main(['--compose', branch.dir], branch.args)).toBe(1);
        expect(branch.logs[0]).toMatch(/GITHUB_REF_TYPE is "branch", not "tag"/);
        const odd = io({ tag: 'v0.1.4-rc1' });
        expect(main(['--compose', odd.dir], odd.args)).toBe(1);
        expect(odd.logs[0]).toMatch(/is not v \+ a version X\.Y\.Z/);
        expect([...none.calls, ...branch.calls, ...odd.calls]).toEqual([]);
      });
    });

    it('--compose lists the first-parent history of a REAL git repo: merges and direct commits, not branch commits', (ctx) => {
      if (spawnSync('git', ['--version']).status !== 0) ctx.skip('no git on this machine');
      const x = io({ tag: 'v0.1.4' });
      const git = (...a: string[]) => {
        const r = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a],
          { cwd: x.root, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
      };
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'first');
      git('tag', 'v0.1.3');
      git('checkout', '-q', '-b', 'feature');
      git('commit', '-q', '--allow-empty', '-m', 'plan: a branch commit');
      git('commit', '-q', '--allow-empty', '-m', 'spec: another branch commit');
      git('checkout', '-q', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'docs: /c u=<userid> on main');
      git('merge', '-q', '--no-ff', 'feature', '-m', 'Merge feature -- the thing users get');
      git('commit', '-q', '--allow-empty', '-m', 'release: 0.1.4');
      git('tag', 'v0.1.4');
      const h = (rev: string) => git('rev-parse', '--short', rev);
      // git is real; scriv and gh stay fake.
      const fake = x.args.run;
      const run = (cmd: string, args: string[], o: { cwd: string }) => (cmd === 'git' ? runCommand(cmd, args, o) : fake(cmd, args, o));
      expect(main(['--compose', x.dir], { ...x.args, run })).toBe(0);
      const notes = readFileSync(join(x.root, 'release-notes.md'), 'utf8');
      expect(notes).toContain(`## Commits\n\n- release: 0.1.4 (${h('HEAD')})\n- Merge feature -- the thing users get (${h('HEAD~1')})\n`
        + `- docs: /c u=&lt;userid&gt; on main (${h('HEAD~2')})\n\n`);
      expect(notes).not.toContain('branch commit');
      expect(notes).not.toMatch(/- first/);
      expect(notes).toContain('compare/v0.1.3...v0.1.4');
    });

    it('--compose and --verify-release refuse without GITHUB_REPOSITORY, before running anything', () => {
      for (const mode of ['--compose', '--verify-release']) {
        const x = io({ tag: 'v0.1.4', env: { GITHUB_REPOSITORY: '' } });
        expect(main([mode, x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/GITHUB_REPOSITORY is "", not owner\/name/)]);
        expect(x.calls).toEqual([]);
      }
    });

    describe('--verify-release', () => {
      const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
      /** The API's assets for what is in `dir`: uploaded, at its size, with GitHub's digest (or null, as older assets have). */
      const assetsOf = (dir: string, { digest = true } = {}) => [...expectedInstallers('0.1.4'), 'SHA256SUMS'].map((name) => ({
        name, size: readFileSync(join(dir, name)).length, state: 'uploaded', digest: digest ? `sha256:${sha(join(dir, name))}` : null,
      }));
      const withSums = <T extends { dir: string }>(x: T): T => { writeFileSync(join(x.dir, 'SHA256SUMS'), 'sums\n'); return x; };

      it('passes when the release holds exactly the files, at their sizes and digests, asking the REST API', () => {
        const x = withSums(io({ tag: 'v0.1.4', assets: (d) => assetsOf(d) }));
        expect(main(['--verify-release', x.dir], x.args)).toBe(0);
        expect(x.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual(['gh api repos/athornton/tn3270/releases/tags/v0.1.4']);
        expect(x.logs.at(-1)).toMatch(/v0\.1\.4 holds exactly the 8 files/);
      });

      it('refuses an asset of the right size whose digest differs', () => {
        const x = withSums(io({ tag: 'v0.1.4', assets: (d) => assetsOf(d).map((a) => (a.name.endsWith('.exe') ? { ...a, digest: `sha256:${'0'.repeat(64)}` } : a)) }));
        expect(main(['--verify-release', x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/the release's TN3270-0\.1\.4-win-x64\.exe has digest sha256:0{64}, not sha256:[0-9a-f]{64}: /)]);
      });

      it('falls back to the size where GitHub gives no digest (null), and still refuses a wrong size there', () => {
        const ok = withSums(io({ tag: 'v0.1.4', assets: (d) => assetsOf(d, { digest: false }) }));
        expect(main(['--verify-release', ok.dir], ok.args)).toBe(0);
        const bad = withSums(io({ tag: 'v0.1.4', assets: (d) => assetsOf(d, { digest: false }).map((a) => (a.name.endsWith('.exe') ? { ...a, size: 1 } : a)) }));
        expect(main(['--verify-release', bad.dir], bad.args)).toBe(1);
        expect(bad.logs).toEqual([expect.stringMatching(/the release's TN3270-0\.1\.4-win-x64\.exe is 1 bytes, not \d+: /)]);
      });

      it('refuses a missing asset, a wrong size, one not uploaded, and an extra one, each named', () => {
        const x = withSums(io({
          tag: 'v0.1.4',
          assets: (d) => {
            const [, zip, app, ...others] = assetsOf(d);
            return [{ ...zip!, size: 1 }, { ...app!, state: 'starter' }, ...others, { name: 'old.txt', size: 3, state: 'uploaded', digest: null }];
          },
        }));
        expect(main(['--verify-release', x.dir], x.args)).toBe(1);
        // In the local files' sorted order, then the extras.
        expect(x.logs).toEqual([
          expect.stringMatching(/the release's TN3270-0\.1\.4-linux-x86_64\.AppImage is "starter", not uploaded: /),
          'release-notes: refused: the release has no TN3270-0.1.4-mac-universal.dmg: re-run the github-release job',
          expect.stringMatching(/^release-notes: refused: the release's TN3270-0\.1\.4-mac-universal\.zip is 1 bytes, not 30: /),
          expect.stringMatching(/the release has old\.txt, which this run did not make: delete it/),
        ]);
      });

      it('refuses an empty local file even when the release matches it', () => {
        const x = withSums(io({ tag: 'v0.1.4', assets: (d) => assetsOf(d) }));
        writeFileSync(join(x.dir, 'TN3270-0.1.4-win-x64.exe'), '');
        expect(main(['--verify-release', x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual(['release-notes: refused: TN3270-0.1.4-win-x64.exe is empty here: re-run the packaging job that made it']);
      });

      it('refuses a directory without SHA256SUMS, before asking GitHub', () => {
        const x = io({ tag: 'v0.1.4' });
        expect(main(['--verify-release', x.dir], x.args)).toBe(1);
        expect(x.logs[0]).toMatch(/has no SHA256SUMS: run --compose first/);
        expect(x.calls).toEqual([]);
      });
    });

    describe('--check-installers', () => {
      it('passes the seven (and a SHA256SUMS beside them), with no tag and no command run', () => {
        const x = io();
        writeFileSync(join(x.dir, 'SHA256SUMS'), 'x\n');
        expect(main(['--check-installers', x.dir, '0.1.4'], x.args)).toBe(0);
        expect(x.calls).toEqual([]);
        expect(x.logs).toEqual([`release-notes: ${x.dir} holds exactly the 7 installers of 0.1.4`]);
      });

      it('refuses a missing installer and an extra file, each named', () => {
        const x = io({ installers: [...expectedInstallers('0.1.4').slice(1), 'stray.txt'] });
        expect(main(['--check-installers', x.dir, '0.1.4'], x.args)).toBe(1);
        expect(x.logs).toEqual([
          expect.stringMatching(/^release-notes: refused: missing TN3270-0\.1\.4-mac-universal\.dmg: /),
          expect.stringMatching(/^release-notes: refused: unexpected file stray\.txt: /),
        ]);
      });

      it('refuses installers of another version, and a tag-shaped version', () => {
        const x = io();
        expect(main(['--check-installers', x.dir, '0.1.5'], x.args)).toBe(1);
        expect(x.logs.filter((l) => /is for version 0\.1\.4, not 0\.1\.5/.test(l))).toHaveLength(7);
        const y = io();
        expect(main(['--check-installers', y.dir, 'v0.1.4'], y.args)).toBe(1);
        expect(y.logs[0]).toContain('GITHUB_REF_NAME#v');
      });
    });

    describe('--dry-run', () => {
      const LINUX = installersFor('0.1.4', 'linux', 'x64');

      it("checks this runner's installers, prints SHA256SUMS and the notes, and passes", () => {
        const x = io({ installers: [...LINUX, 'TN3270-0.1.4-linux-x86_64.AppImage.blockmap', 'builder-debug.yml'] });
        mkdirSync(join(x.dir, 'linux-unpacked'));
        expect(main(['--dry-run', x.dir], x.args)).toBe(0);
        const out = x.logs.join('\n');
        for (const f of LINUX) expect(out).toContain(`  ${createHash('sha256').update(f).digest('hex')}  ${f}`);
        expect(out).not.toContain('blockmap');
        expect(out).toContain(`  ## What changed\n  \n  ${SCRIV_0_1_4.split('\n')[0]}`);
        expect(out).not.toMatch(/WARNING/);
        expect(x.logs.at(-1)).toBe('release-notes: dry run of 0.1.4 passed');
        // No tag, no network, and nothing written.
        expect(x.calls.map((c) => c.cmd)).toEqual(['scriv']);
        expect(existsSync(join(x.dir, 'SHA256SUMS'))).toBe(false);
        expect(existsSync(join(x.root, 'release-notes.md'))).toBe(false);
      });

      it('takes the version from the root package.json', () => {
        const x = io({ version: '0.1.3', installers: installersFor('0.1.3', 'linux', 'x64'), sections: { '0.1.3': '### Other changes\n\n- y\n' } });
        expect(main(['--dry-run', x.dir], x.args)).toBe(0);
        expect(x.calls[0]!.args).toEqual(['print', '--version', '0.1.3']);
      });

      it('WARNS, and does not fail, for a missing entry and a leftover fragment; annotates on Actions', () => {
        const x = io({ sections: {}, fragments: ['20261109_x.md'], installers: LINUX, actions: true });
        expect(main(['--dry-run', x.dir], x.args)).toBe(0);
        expect(x.logs.filter((l) => l.startsWith('release-notes: WARNING: '))).toEqual([
          expect.stringMatching(/no entry for 0\.1\.4/),
          expect.stringMatching(/uncollected fragments in changelog\.d: 20261109_x\.md/),
        ]);
        expect(x.logs.filter((l) => l.startsWith('::warning::'))).toHaveLength(2);
        expect(x.logs.join('\n')).toContain('(no CHANGELOG.md entry for 0.1.4 yet');
      });

      it('warns without the annotation off Actions', () => {
        const x = io({ sections: {}, installers: LINUX });
        expect(main(['--dry-run', x.dir], x.args)).toBe(0);
        expect(x.logs.some((l) => l.startsWith('::warning::'))).toBe(false);
        expect(x.logs.some((l) => l.startsWith('release-notes: WARNING: '))).toBe(true);
      });

      it("FAILS for a missing installer of this runner's, or one for another version", () => {
        const x = io({ installers: [LINUX[0]!] });
        expect(main(['--dry-run', x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/refused: missing TN3270-0\.1\.4-linux-amd64\.deb/)]);
        const y = io({ installers: [...LINUX, 'TN3270-0.1.3-linux-amd64.deb'] });
        expect(main(['--dry-run', y.dir], y.args)).toBe(1);
        expect(y.logs).toEqual([expect.stringMatching(/refused: TN3270-0\.1\.3-linux-amd64\.deb is for version 0\.1\.3/)]);
      });

      it('expects the installers of the platform it runs on', () => {
        const x = io({ installers: installersFor('0.1.4', 'linux', 'arm64'), platform: 'linux', arch: 'arm64' });
        expect(main(['--dry-run', x.dir], x.args)).toBe(0);
        const y = io({ installers: LINUX, platform: 'linux', arch: 'arm64' });
        expect(main(['--dry-run', y.dir], y.args)).toBe(1);
      });

      it('FAILS when scriv cannot run at all: that is a broken step, not a normal gap', () => {
        const x = io({ installers: LINUX, fail: 'scriv' });
        expect(main(['--dry-run', x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/refused: scriv print --version 0\.1\.4 exited 1: is scriv installed/)]);
      });
    });
  });

  /*
    THE REAL SCRIV, on the real CHANGELOG.md: the seeded entries are in a shape scriv reads, and
    its exit 2 for a missing version -- which changelogProblems relies on -- is what it does. Skips
    where no scriv runs (the vitest legs of CI do not install it).
  */
  describe('with the real scriv', () => {
    const REPO = resolve(import.meta.dirname, '../../..');
    const HOME = process.env.HOME ?? '';
    /*
      PROBED ONCE, LAZILY, AND BOUNDED: in the first test that needs it, not at collection, each
      candidate given 20 s (an offline uvx without scriv cached fails fast or times out there, never
      stalling the suite). Pinned as CI pins it.
    */
    let probed: string[] | undefined | null = null;
    const found = () => {
      if (probed === null) {
        probed = [process.env.SCRIV, 'scriv', `${HOME}/.local/bin/uvx scriv==1.8.1`, 'uvx scriv==1.8.1']
          .filter((c): c is string => c !== undefined && c.trim() !== '')
          .map((c) => c.trim().split(/\s+/))
          .find(([cmd, ...pre]) => {
            const r = spawnSync(cmd!, [...pre, '--version'], { encoding: 'utf8', timeout: 20_000 });
            return r.status === 0 && /version 1\.8\.1\b/.test(r.stdout);
          });
      }
      return probed;
    };
    const NONE = 'no scriv 1.8.1 here (tried $SCRIV, scriv, ~/.local/bin/uvx scriv==1.8.1, uvx scriv==1.8.1): CI installs it in the release jobs only';
    const scriv = (...args: string[]) => spawnSync(found()![0]!, [...found()!.slice(1), ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });

    it('extracts each seeded entry, and exits 2 for a version not there', (ctx) => {
      if (found() === undefined) ctx.skip(NONE);
      const r = scriv('print', '--version', '0.1.3');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^### Other changes\n\n- The first release published to npm by the project's own tag workflow/);
      for (const v of ['0.1.2', '0.1.1', '0.1.0']) expect(scriv('print', '--version', v).status).toBe(0);
      expect(scriv('print', '--version', '0.1.1').stdout).toContain('### New features');
      expect(scriv('print', '--version', '9.9.9').status).toBe(2);
    }, 120_000);

    it('drives --check-changelog end to end with runCommand, in a copy of the changelog', (ctx) => {
      if (found() === undefined) ctx.skip(NONE);
      const root = mkdtempSync(join(tmpdir(), 'relnotes-real-'));
      try {
        cpSync(join(REPO, 'CHANGELOG.md'), join(root, 'CHANGELOG.md'));
        mkdirSync(join(root, 'changelog.d'));
        // Only the configuration: this branch's own uncollected fragments must not decide the test.
        for (const f of ['scriv.ini', '_template.md.jinja']) cpSync(join(REPO, 'changelog.d', f), join(root, 'changelog.d', f));
        const logs: string[] = [];
        const args = { env: { SCRIV: found()!.join(' ') }, run: runCommand, log: (l: string) => { logs.push(l); }, root };
        expect(main(['--check-changelog', '0.1.3'], args)).toBe(0);
        expect(main(['--check-changelog', '0.1.4'], args)).toBe(1);
        expect(logs.at(-1)).toBe('release-notes: refused: CHANGELOG.md has no entry for 0.1.4: run uvx scriv collect --version 0.1.4 and commit it');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
