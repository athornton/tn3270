import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  changelogProblems, checkInstallers, composeNotes, expectedInstallers, installersFor, main, previousTag, runCommand, sha256sums,
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
      tags?: string[]; pulls?: string; assets?: unknown; tag?: string; refType?: string; actions?: boolean;
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
        if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: '- release: 0.1.4 (abc1234)\n- the fix (def5678)\n' };
        if (args.includes('releases/generate-notes') || args.some((a) => a.endsWith('/releases/generate-notes'))) {
          return { status: 0, stdout: JSON.stringify({ name: 'v0.1.4', body: opts.pulls ?? '**Full Changelog**: https://github.com/athornton/tn3270/compare/v0.1.3...v0.1.4' }) };
        }
        if (args[0] === 'release' && args[1] === 'view') return { status: 0, stdout: JSON.stringify({ assets: opts.assets ?? [] }) };
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
      for (const argv of [[], ['--publish', 'x'], ['--compose'], ['--compose', 'a', 'b']]) {
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
          'git log --format=- %s (%h) v0.1.3..v0.1.4',
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

    it('--compose and --verify-release refuse without GITHUB_REPOSITORY, before running anything', () => {
      for (const mode of ['--compose', '--verify-release']) {
        const x = io({ tag: 'v0.1.4', env: { GITHUB_REPOSITORY: '' } });
        expect(main([mode, x.dir], x.args)).toBe(1);
        expect(x.logs).toEqual([expect.stringMatching(/GITHUB_REPOSITORY is "", not owner\/name/)]);
        expect(x.calls).toEqual([]);
      }
    });

    describe('--verify-release', () => {
      /** The release's assets as gh reports them, for what is in `dir`. */
      const assetsOf = (dir: string, files: string[]) => files.map((name) => ({ name, size: readFileSync(join(dir, name)).length, state: 'uploaded' }));

      it('passes when the release holds exactly the files, at their sizes', () => {
        const x = io({ tag: 'v0.1.4' });
        writeFileSync(join(x.dir, 'SHA256SUMS'), 'sums\n');
        const files = [...expectedInstallers('0.1.4'), 'SHA256SUMS'];
        const y = io({ tag: 'v0.1.4', assets: assetsOf(x.dir, files) });
        writeFileSync(join(y.dir, 'SHA256SUMS'), 'sums\n');
        expect(main(['--verify-release', y.dir], y.args)).toBe(0);
        expect(y.calls.map((c) => [c.cmd, ...c.args].join(' '))).toEqual(['gh release view v0.1.4 --repo athornton/tn3270 --json assets']);
        expect(y.logs.at(-1)).toMatch(/v0\.1\.4 holds exactly the 8 files/);
      });

      it('refuses a missing asset, a wrong size, one not uploaded, and an extra one, each named', () => {
        const x = io({ tag: 'v0.1.4' });
        writeFileSync(join(x.dir, 'SHA256SUMS'), 'sums\n');
        const [dmg, zip, app, ...others] = assetsOf(x.dir, [...expectedInstallers('0.1.4'), 'SHA256SUMS']);
        const y = io({ tag: 'v0.1.4', assets: [{ ...zip!, size: 1 }, { ...app!, state: 'starter' }, ...others, { name: 'old.txt', size: 3, state: 'uploaded' }] });
        writeFileSync(join(y.dir, 'SHA256SUMS'), 'sums\n');
        expect(main(['--verify-release', y.dir], y.args)).toBe(1);
        // In the local files' sorted order, then the extras.
        expect(y.logs).toEqual([
          expect.stringMatching(/the release's TN3270-0\.1\.4-linux-x86_64\.AppImage is "starter", not uploaded: /),
          `release-notes: refused: the release has no ${dmg!.name}: re-run the github-release job`,
          expect.stringMatching(new RegExp(`^release-notes: refused: the release's ${zip!.name.replace(/\./g, '\\.')} is 1 bytes, not ${zip!.size}: `)),
          expect.stringMatching(/the release has old\.txt, which this run did not make: delete it/),
        ]);
      });

      it('refuses a directory without SHA256SUMS, before asking GitHub', () => {
        const x = io({ tag: 'v0.1.4' });
        expect(main(['--verify-release', x.dir], x.args)).toBe(1);
        expect(x.logs[0]).toMatch(/has no SHA256SUMS: run --compose first/);
        expect(x.calls).toEqual([]);
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
    const found = [process.env.SCRIV, 'scriv', `${HOME}/.local/bin/uvx scriv`, 'uvx scriv']
      .filter((c): c is string => c !== undefined && c.trim() !== '')
      .map((c) => c.trim().split(/\s+/))
      .find(([cmd, ...pre]) => spawnSync(cmd!, [...pre, '--version'], { stdio: 'ignore', timeout: 60_000 }).status === 0);
    const scriv = (...args: string[]) => spawnSync(found![0]!, [...found!.slice(1), ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });

    it('extracts each seeded entry, and exits 2 for a version not there', (ctx) => {
      if (found === undefined) ctx.skip('no scriv here (tried $SCRIV, scriv, ~/.local/bin/uvx scriv, uvx scriv): CI installs it in the release jobs only');
      const r = scriv('print', '--version', '0.1.3');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^### Other changes\n\n- The first release published to npm by the project's own tag workflow/);
      for (const v of ['0.1.2', '0.1.1', '0.1.0']) expect(scriv('print', '--version', v).status).toBe(0);
      expect(scriv('print', '--version', '0.1.1').stdout).toContain('### New features');
      expect(scriv('print', '--version', '9.9.9').status).toBe(2);
    }, 120_000);

    it('drives --check-changelog end to end with runCommand, in a copy of the changelog', (ctx) => {
      if (found === undefined) ctx.skip('no scriv here (tried $SCRIV, scriv, ~/.local/bin/uvx scriv, uvx scriv): CI installs it in the release jobs only');
      const root = mkdtempSync(join(tmpdir(), 'relnotes-real-'));
      try {
        cpSync(join(REPO, 'CHANGELOG.md'), join(root, 'CHANGELOG.md'));
        mkdirSync(join(root, 'changelog.d'));
        // Only the configuration: this branch's own uncollected fragments must not decide the test.
        for (const f of ['scriv.ini', '_template.md.jinja']) cpSync(join(REPO, 'changelog.d', f), join(root, 'changelog.d', f));
        const logs: string[] = [];
        const args = { env: { SCRIV: found!.join(' ') }, run: runCommand, log: (l: string) => { logs.push(l); }, root };
        expect(main(['--check-changelog', '0.1.3'], args)).toBe(0);
        expect(main(['--check-changelog', '0.1.4'], args)).toBe(1);
        expect(logs.at(-1)).toBe('release-notes: refused: CHANGELOG.md has no entry for 0.1.4: run uvx scriv collect --version 0.1.4 and commit it');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
