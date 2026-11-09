import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changelogProblems, checkInstallers, composeNotes, expectedInstallers, installersFor, previousTag, sha256sums,
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
});
