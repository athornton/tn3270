import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

  // Code signing (code signing plan, Task 5; spec section 2). "This run signs", verbatim
  // everywhere it is used; the verify step's mode is the same text WITHOUT `matrix.sign && `.
  const SIGNS = "matrix.sign && (startsWith(github.ref, 'refs/tags/v') || (github.event_name == 'workflow_dispatch' && inputs.sign))";
  const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** The package job's lines that are not comments: prose may name an expression it does not use. */
  const packageCode = () => jobBlock('package').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  /** The matrix entries, from `include:` to the job's `runs-on:`, so no step text is read as one. */
  const matrixEntries = () => {
    const block = jobBlock('package');
    const matrix = block.slice(block.indexOf('        include:\n'), block.indexOf('\n    runs-on:'));
    return matrix.split(/\n          - (?:os|name): /).slice(1);
  };
  const entryName = (e: string) => e.split('\n')[0]!.trim();

  it('marks exactly macos-latest as a signing runner', () => {
    // Windows CI signing is dropped (spec amendment 2026-11-11): a `sign: true` on windows-latest
    // would send every tag run to a signing setup that does not exist, and block the release.
    const entries = matrixEntries();
    expect(entries.length, 'matrix entries').toBe(6);
    const signing = entries.filter((e) => /\n\s+sign:/.test(e)).map(entryName);
    expect(signing).toEqual(['macos-latest']);
    expect(entries.find((e) => entryName(e) === 'macos-latest')).toMatch(/^\s+sign: true$/m);
  });

  it('windows-latest, and only it, verifies in a FIXED mode: unsigned', () => {
    const verifying = matrixEntries().filter((e) => /\n\s+verify:/.test(e));
    expect(verifying.map(entryName)).toEqual(['windows-latest']);
    expect(verifying[0]).toMatch(/^\s+verify: unsigned$/m);
  });

  it('has a boolean sign input on workflow_dispatch, default false', () => {
    // The input's own lines (indented under `      sign:`), so a `default: false` elsewhere cannot pass.
    const m = /\n  workflow_dispatch:\n    inputs:\n(?:      \S.*\n(?:        .*\n)*)*?      sign:\n((?:        .*\n)+)/.exec(wf);
    expect(m, 'workflow_dispatch input sign').not.toBeNull();
    const body = m![1]!.split('\n').map((l) => l.trim());
    expect(body).toContain('type: boolean');
    expect(body).toContain('default: false');
  });

  it('every "this run signs" expression is the one expression, verbatim', () => {
    const block = jobBlock('package');
    // Up to the first `))`, which is where SIGNS ends; a lazy match to ` &&` would stop inside it.
    const uses = [...block.matchAll(/\$\{\{ (matrix\.sign && \(.*?\)\)) && /g)].map((m) => m[1]);
    expect(uses.length).toBe(4); // environment, the .p8 step, TN3270_SIGN, auto-discovery
    for (const u of uses) expect(u).toBe(SIGNS);
    expect(block).toMatch(new RegExp(`\\n    environment: \\$\\{\\{ ${reEscape(SIGNS)} && 'signing' \\|\\| '' \\}\\}\\n`));
    // No fifth, differently written test of the input: those four plus the verify step's mode.
    expect(packageCode().match(/\binputs\.sign\b/g)?.length).toBe(5);
  });

  const verifySteps = () => jobBlock('package').split(/\n      - /).filter((s) => s.includes('verify-signatures.mjs'));

  it('there are exactly two verify steps: the signing runner one, and the fixed-mode one', () => {
    expect(verifySteps().map((s) => s.split('\n')[0])).toEqual(['if: matrix.sign', 'if: matrix.verify']);
  });

  it('the verify step decides its mode from the ref and the input alone, never matrix.sign', () => {
    const step = verifySteps().find((s) => s.startsWith('if: matrix.sign\n'));
    expect(step, 'no verify-signatures step').toBeDefined();
    expect(step).toMatch(/^if: matrix\.sign\n/);
    const run = /run: (.*verify-signatures\.mjs.*)/.exec(step!)![1]!;
    expect(run).not.toMatch(/matrix\.sign/);
    const mode = SIGNS.replace('matrix.sign && ', '');
    expect(run).toBe(`node scripts/verify-signatures.mjs --expect \${{ ${mode} && 'signed' || 'unsigned' }} artifacts/gui`);
  });

  it('the fixed-mode verify step takes its mode from matrix.verify alone, never the ref or the input', () => {
    const step = verifySteps().find((s) => s.startsWith('if: matrix.verify\n'));
    expect(step, 'no fixed-mode verify-signatures step').toBeDefined();
    const run = /run: (.*verify-signatures\.mjs.*)/.exec(step!)![1]!;
    expect(run).toBe('node scripts/verify-signatures.mjs --expect ${{ matrix.verify }} artifacts/gui');
  });

  it('the verify step runs after package:gui and before package-smoke', () => {
    const steps = jobBlock('package').split(/\n      - /);
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
    const gui = at(/run: npm run package:gui\b/);
    const smoke = at(/run: .*node scripts\/package-smoke\.mjs\b/);
    const verifies = steps.flatMap((s, i) => (/run: node scripts\/verify-signatures\.mjs\b/.test(s) ? [i] : []));
    expect(verifies.length, 'verify steps').toBe(2);
    for (const [name, i] of Object.entries({ gui, smoke })) expect(i, name).toBeGreaterThanOrEqual(0);
    for (const verify of verifies) {
      expect(gui).toBeLessThan(verify);
      expect(verify).toBeLessThan(smoke);
    }
  });

  it('the package job reads contents -- nothing else, and no OIDC token', () => {
    // A job-level `permissions:` sets every permission it does not list to none. id-token went
    // with azure/login (Windows signing dropped, spec amendment 2026-11-11).
    const perms = /\n    permissions:\n((?:      \S.*\n)+)/.exec(jobBlock('package'))?.[1];
    expect(perms, 'a permissions: block').toBeDefined();
    expect(perms!.trimEnd().split('\n').map((l) => l.trim())).toEqual(['contents: read']);
  });

  it('wires no Azure signing: no azure/login, no AZURE_* variable', () => {
    expect(packageCode()).not.toMatch(/azure\/login|AZURE_/);
  });
  // Store probe (store-probe plan Task 6 and its overrides). The MAS stand-in and the installed
  // MSIX are built, launched and judged on every run, and NEVER uploaded.
  // Comment lines dropped: a step's chunk ends with the NEXT step's leading comment, whose prose
  // may name what this step must not use.
  const packageSteps = () => jobBlock('package').split(/\n      - /).map((s) => s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'));
  const MAS_BUILD = /run: npm run package:gui -- --mac mas --universal -c\.mac\.identity=null$/m;
  const PROBE_RUN = /run: node scripts\/store-probe\.mjs artifacts\/gui$/m;

  it('probe: true on exactly macos-latest and windows-latest; masbuild: true on macos-latest only', () => {
    const entries = matrixEntries();
    expect(entries.filter((e) => /\n\s+probe:/.test(e)).map(entryName)).toEqual(['macos-latest', 'windows-latest']);
    for (const e of entries.filter((x) => /\n\s+probe:/.test(x))) expect(e).toMatch(/^\s+probe: true$/m);
    const mas = entries.filter((e) => /\n\s+masbuild:/.test(e));
    expect(mas.map(entryName)).toEqual(['macos-latest']);
    expect(mas[0]).toMatch(/^\s+masbuild: true$/m);
  });

  it('the MAS build step: masbuild runners only, identity null, and no signing credentials', () => {
    const steps = packageSteps().filter((s) => /--mac mas\b/.test(s));
    expect(steps.length, 'MAS build steps').toBe(1);
    const step = steps[0]!;
    expect(step).toMatch(/^if: matrix\.masbuild\n/);
    expect(step).toMatch(MAS_BUILD);
    // TN3270_SIGN, CSC_LINK, APPLE_* and a CSC_IDENTITY_AUTO_DISCOVERY override live in the
    // Developer ID package:gui step's env only: here they could sign or notarize the stand-in.
    expect(step).not.toMatch(/TN3270_SIGN|CSC_|APPLE_|secrets\.|\benv:/);
  });

  it('store probe: on every event, ECHO on, after the MAS build and both verifies, before package-smoke and the uploads', () => {
    const steps = packageSteps();
    const probes = steps.flatMap((s, i) => (/run: .*store-probe\.mjs/.test(s) ? [i] : []));
    expect(probes.length, 'store probe steps').toBe(1);
    const probe = probes[0]!;
    const step = steps[probe]!;
    // Exactly `matrix.probe`: no ref, input or event, so pushes, pull requests and tags all run it.
    expect(step.split('\n')[0]).toBe('if: matrix.probe');
    expect(step).not.toMatch(/github\.|inputs\.|startsWith/);
    expect(step).toMatch(/^        name: store probe$/m);
    expect(step).toMatch(PROBE_RUN);
    expect(step).toMatch(/^          STORE_PROBE_ECHO: '1'$/m);
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s));
    const gui = at(/run: npm run package:gui -- \$\{\{ matrix\.builder \}\}/);
    const mas = at(MAS_BUILD);
    const smoke = at(/run: .*node scripts\/package-smoke\.mjs\b/);
    const verifies = steps.flatMap((s, i) => (/run: node scripts\/verify-signatures\.mjs\b/.test(s) ? [i] : []));
    const uploads = steps.flatMap((s, i) => (/uses: actions\/upload-artifact@/.test(s) ? [i] : []));
    for (const [name, i] of Object.entries({ gui, mas, smoke })) expect(i, name).toBeGreaterThanOrEqual(0);
    expect(verifies.length, 'verify steps').toBe(2);
    expect(uploads.length, 'upload steps').toBeGreaterThan(0);
    expect(gui, 'package:gui before the MAS build').toBeLessThan(mas);
    // The MAS build cannot disturb what verify-signatures judges (or the uploaded dmg/zip).
    for (const v of verifies) expect(v, 'verify before the MAS build').toBeLessThan(mas);
    expect(mas, 'MAS build before the probe').toBeLessThan(probe);
    expect(probe, 'probe before package-smoke').toBeLessThan(smoke);
    for (const u of uploads) expect(probe, 'probe before every upload').toBeLessThan(u);
  });

  it('no upload matches the appx or the MAS app; the gui-* upload is exactly the five installer globs', () => {
    const uploads = packageSteps().filter((s) => /uses: actions\/upload-artifact@/.test(s));
    for (const u of uploads) {
      const path = /\n {10}path: ([^|\n].*|\|\n(?: {12}.*\n?)+)/.exec(u)?.[1];
      expect(path, `a path: in ${u.split('\n')[0]}`).toBeDefined();
      expect(path).not.toMatch(/appx|mas|\*\*/i);
    }
    const gui = uploads.find((u) => /name: gui-\$\{\{ matrix\.os \}\}/.test(u));
    expect(gui, 'the gui-* upload').toBeDefined();
    const globs = /\n {10}path: \|\n((?: {12}\S.*\n)+)/.exec(gui!)?.[1]?.trimEnd().split('\n').map((l) => l.trim());
    // Non-recursive, one level: none can descend into artifacts/gui/mas-universal/ (an app
    // directory only, run 43115293433) or match the top-level TN3270-<v>-win-x64.appx.
    expect(globs).toEqual([
      'artifacts/gui/*.AppImage',
      'artifacts/gui/*.deb',
      'artifacts/gui/*.dmg',
      'artifacts/gui/*.zip',
      'artifacts/gui/*.exe',
    ]);
  });

  it('the header documents the probe and masbuild matrix keys', () => {
    const header = wf.slice(0, wf.indexOf('\nname: package\n'));
    expect(header).toMatch(/^#   probe {2,}\S/m);
    expect(header).toMatch(/^#   masbuild {2,}\S/m);
  });

  it('the GUI harness loop runs every harness in packages/gui/scripts (a new one cannot be left out)', () => {
    // Harnesses are the .mjs scripts there that launch the app, minus the build tools. seam-errors
    // was added on 2026-11-12 with the replay-hang fix and was not in the loop until this test.
    const NOT_HARNESSES = new Set(['bundle', 'bundleVerify', 'render-icon', 'xvfb']);
    const dir = fileURLToPath(new URL('../../gui/scripts/', import.meta.url));
    const harnesses = readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).filter((n) => !NOT_HARNESSES.has(n)).sort();
    const loop = /for h in ([a-z -]+); do/.exec(jobBlock('package'));
    expect(loop, 'no `for h in ...; do` harness loop in the package job').not.toBeNull();
    expect(loop![1]!.trim().split(/\s+/).sort()).toEqual(harnesses);
  });
});
