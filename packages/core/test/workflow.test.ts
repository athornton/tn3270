import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pins the release wiring in .github/workflows/package.yml (npm trusted publishing plan, Task 4),
// by reading the file as text rather than a YAML parser: a parser would need a dependency this
// repo otherwise avoids in scripts/, and the properties below are about to-the-letter strings
// (`environment: npm`, the exact `if:` guard) that a round-tripped YAML object would obscure.
const workflowPath = fileURLToPath(new URL('../../../.github/workflows/package.yml', import.meta.url));
const wf = readFileSync(workflowPath, 'utf8');

/** The text of one top-level job block: from `  <name>:` up to (not including) the next one. */
function jobBlock(name: string): string {
  const lines = wf.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `no top-level job named ${name} in package.yml`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i]!)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

describe('package.yml release wiring', () => {
  it('triggers on a vX.Y.Z tag push, alongside the branch pushes', () => {
    expect(wf).toMatch(/tags:\s*\[['"]v\*\.\*\.\*['"]\]/);
  });

  it('runs a publish dry run on every push, in the npm leg of the matrix job', () => {
    expect(jobBlock('package')).toMatch(/if:\s*matrix\.npm[\s\S]*?publish\.mjs --dry-run/);
  });

  it('release-check: needs package, no environment, gated on the tag ref', () => {
    const block = jobBlock('release-check');
    expect(block).toMatch(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(block).toMatch(/needs:\s*package\b/);
    expect(block).not.toMatch(/\benvironment:/);
    expect(block).toMatch(/publish\.mjs --check/);
  });

  it('publish: needs release-check, environment npm, OIDC permission, gated on the tag ref', () => {
    const block = jobBlock('publish');
    expect(block).toMatch(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(block).toMatch(/needs:\s*release-check\b/);
    expect(block).toMatch(/environment:\s*npm\b/);
    expect(block).toMatch(/id-token:\s*write/);
    expect(block).toMatch(/publish\.mjs --publish/);
  });

  it('both npm release jobs have a timeout-minutes', () => {
    expect(jobBlock('release-check')).toMatch(/timeout-minutes:\s*\d+/);
    expect(jobBlock('publish')).toMatch(/timeout-minutes:\s*\d+/);
  });

  it('publish serializes on a concurrency group, without cancelling an in-flight run', () => {
    const block = jobBlock('publish');
    expect(block).toMatch(/concurrency:\s*\n\s*group:\s*npm-publish/);
    expect(block).toMatch(/cancel-in-progress:\s*false/);
  });

  it('the trusted-publisher binding names this file and the npm environment in a comment', () => {
    // Pinned on the comment's own heading: `environment: npm` in the job body would satisfy a
    // looser match even after the comment were deleted (review, 2026-11-09).
    const at = wf.indexOf('# NAMES THAT MUST NOT CHANGE');
    expect(at, 'the NAMES THAT MUST NOT CHANGE comment').toBeGreaterThanOrEqual(0);
    const comment = wf.slice(at, wf.indexOf('\n\n', at));
    expect(comment).toMatch(/package\.yml/);
    expect(comment).toMatch(/\bnpm\b/);
  });

  it('the every-push dry run uses the SAME directory the release jobs download into', () => {
    // npm reads `dir/x.tgz` differently by its slashes (one slash is GitHub shorthand): the 0.1.2
    // tag run failed on `tarballs/x.tgz` while the dry run, on `artifacts/npm/x.tgz`, passed.
    const dry = /publish\.mjs --dry-run (\S+)/.exec(jobBlock('package'))?.[1];
    for (const job of ['release-check', 'publish']) {
      const block = jobBlock(job);
      expect(block, job).toMatch(new RegExp(`path: ${dry}\\b`));
      expect(block, job).toMatch(new RegExp(`publish\\.mjs --(check|publish) ${dry}\\b`));
    }
  });

  it('release-check pre-flights the GitHub release: installers and changelog, before publish', () => {
    // Before publish's approval: npm publish cannot be undone, and github-release runs after it.
    const block = jobBlock('release-check');
    expect(block).toMatch(/pattern:\s*'gui-\*'/);
    expect(block).toMatch(/merge-multiple:\s*true/);
    const dir = /pattern:\s*'gui-\*',\s*merge-multiple:\s*true,\s*path:\s*(\S+?)\s*\}/.exec(block)?.[1];
    expect(dir, 'the gui-* download path').toBeDefined();
    expect(block).toMatch(new RegExp(`release-notes\\.mjs --check-installers ${dir} "\\$\\{GITHUB_REF_NAME#v\\}"`));
    expect(block).toMatch(/scriv==1\.8\.1/);
    expect(block).toMatch(/release-notes\.mjs --check-changelog "\$\{GITHUB_REF_NAME#v\}"/);
  });

  it('github-release: needs publish, contents: write only, full history, no environment', () => {
    const block = jobBlock('github-release');
    expect(block).toMatch(/if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/);
    expect(block).toMatch(/needs:\s*publish\b/);
    // As a key (its comment says "No environment:" in prose).
    expect(block).not.toMatch(/^\s*environment:/m);
    expect(block).toMatch(/timeout-minutes:\s*\d+/);
    expect(block).toMatch(/fetch-depth:\s*0\b/);
    // Exactly one permission line under `permissions:`, and it is contents: write.
    const perms = /\n    permissions:\n((?:      \S.*\n)+)/.exec(block)?.[1];
    expect(perms, 'a permissions: block').toBeDefined();
    expect(perms!.trimEnd().split('\n').map((l) => l.trim())).toEqual(['contents: write']);
    expect(block).toMatch(/release-notes\.mjs --compose installers/);
    expect(block).toMatch(/release-notes\.mjs --verify-release installers/);
    // gh needs the token on every step that runs it.
    for (const step of block.split(/\n      - /).filter((s) => /\bgh |release-notes\.mjs --(compose|verify-release)/.test(s))) {
      expect(step).toMatch(/GH_TOKEN:\s*'\$\{\{ github\.token \}\}'/);
    }
  });

  it('scriv is installed before vitest; the release-notes dry run comes after package:gui', () => {
    const block = jobBlock('package');
    const steps = block.split(/\n      - /);
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
    const gui = at(/run: npm run package:gui\b/);
    const scriv = at(/run: pipx install scriv==1\.8\.1/);
    const vitest = at(/run: npx vitest run\b/);
    const dry = at(/run: node scripts\/release-notes\.mjs --dry-run artifacts\/gui\b/);
    expect(gui, 'package:gui').toBeGreaterThanOrEqual(0);
    // Before vitest, so the real-scriv tests run in CI instead of skipping (review, 2026-11-10).
    expect(scriv, 'scriv install').toBeGreaterThanOrEqual(0);
    expect(scriv, 'scriv install before vitest').toBeLessThan(vitest);
    expect(dry, 'release-notes dry run after package:gui').toBeGreaterThan(gui);
    expect(dry, 'release-notes dry run after the scriv install').toBeGreaterThan(scriv);
    // In the npm leg (ubuntu-latest, which also packages): one job, not every runner.
    expect(steps[scriv]).toMatch(/^if:\s*matrix\.npm\n/);
    expect(steps[dry]).toMatch(/^if:\s*matrix\.npm\n/);
  });

  it('github-release creates, or on a re-run repairs, the release in the right order', () => {
    const steps = jobBlock('github-release').split(/\n      - /);
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
    const scriv = at(/run: pipx install scriv==1\.8\.1/);
    const download = at(/download-artifact@[\s\S]*pattern:\s*'gui-\*'/);
    const compose = at(/release-notes\.mjs --compose installers/);
    const create = at(/gh release create /);
    const verify = at(/release-notes\.mjs --verify-release installers/);
    for (const [name, i] of Object.entries({ scriv, download, compose, create, verify })) {
      expect(i, name).toBeGreaterThanOrEqual(0);
    }
    expect([scriv, download, compose, create, verify]).toEqual([...[scriv, download, compose, create, verify]].sort((a, b) => a - b));
    const step = steps[create]!;
    expect(step).toMatch(/gh release create "\$GITHUB_REF_NAME" --verify-tag .*--notes-file release-notes\.md installers\/\*/);
    // The re-run branch: upload BEFORE the edit, and the edit publishes a draft left by a create
    // killed mid-upload -- `edit` alone keeps a draft a draft, and the read-back sees only published
    // releases (review of gh's release/create/create.go, 2026-11-10).
    const upload = step.indexOf('gh release upload "$GITHUB_REF_NAME" installers/* --clobber');
    const edit = step.indexOf('gh release edit "$GITHUB_REF_NAME" --notes-file release-notes.md --draft=false');
    expect(upload, 'upload --clobber').toBeGreaterThanOrEqual(0);
    expect(edit, 'edit --draft=false').toBeGreaterThan(upload);
  });

  it('publish asserts Node and npm versions rather than reinstalling npm over itself', () => {
    const block = jobBlock('publish');
    expect(block).not.toMatch(/npm install -g npm/);
    expect(block).toMatch(/npm >= 11\.5\.1/);
  });
});
