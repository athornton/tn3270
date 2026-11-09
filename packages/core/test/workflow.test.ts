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

  it('both release jobs have a timeout-minutes', () => {
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

  it('publish asserts Node and npm versions rather than reinstalling npm over itself', () => {
    const block = jobBlock('publish');
    expect(block).not.toMatch(/npm install -g npm/);
    expect(block).toMatch(/npm >= 11\.5\.1/);
  });
});
