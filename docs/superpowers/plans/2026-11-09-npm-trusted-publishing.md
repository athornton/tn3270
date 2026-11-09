# npm trusted publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pushed `vX.Y.Z` tag publishes the eight `@tn3270/*` tarballs its CI run built, after one approval in the GitHub environment `npm`, over OIDC with provenance, and proves it by reading the registry back.

**Architecture:** Spec: `docs/superpowers/specs/2026-11-09-npm-trusted-publishing-design.md` (read it first). One new script, `scripts/publish.mjs`, with `--dry-run` / `--check` / `--publish` modes; it must be DEPENDENCY-FREE because the release jobs run without `npm ci`, so the package discovery and tar reader it needs move out of `scripts/pack.mjs` (which imports `@tn3270/canvas` via `packages/gui/scripts/bundleVerify.mjs`) into two small shared modules. `.github/workflows/package.yml` gains a tag trigger, a dry-run step, and two jobs.

**Tech Stack:** Node ESM scripts (`.mjs` with `.d.mts` types for the tests), vitest (tests live in `packages/core/test`, as `setVersion.test.ts` does for `scripts/set-version.mjs`), GitHub Actions.

## THE SOURCE BEATS THIS PLAN

Plan code is a draft. Before each task read the files it names; where the repo disagrees, follow the repo, keep the intent, and say so in the commit message. Gate per task, repo root: `npm run build && npm run typecheck && npx vitest run` (vitest does not typecheck). Commit messages end with a blank line, `Generated with AI`, a blank line, `Co-Authored-By: SLAC AI`.

## File map

| File | Responsibility |
|---|---|
| `scripts/workspaces.mjs` (+ `.d.mts`) | NEW: `publishedPackages()`, `tarballName()` — moved from `scripts/pack.mjs`, no imports beyond node: |
| `scripts/tarball.mjs` (+ `.d.mts`) | NEW: `readTar(tgz)` → `Map<entryPath, Buffer>`; `pack.mjs`'s `tarEntries` becomes a wrapper |
| `scripts/pack.mjs` | imports and RE-EXPORTS the moved functions (install-smoke.mjs imports them from here) |
| `scripts/publish.mjs` (+ `.d.mts`) | NEW: the release logic and its three modes |
| `packages/core/test/publish.test.ts` | NEW: unit tests |
| `.github/workflows/package.yml` | tag trigger; `--dry-run` step; `release-check` and `publish` jobs |
| `packages/core/test/workflow.test.ts` | NEW: pins the release wiring in package.yml |
| `docs/releasing.md`, README *Remaining* 14, `docs/HANDOFF.md` | docs |

---

### Task 1: dependency-free `workspaces.mjs` and `tarball.mjs`

**Files:** Create `scripts/workspaces.mjs`, `scripts/workspaces.d.mts`, `scripts/tarball.mjs`, `scripts/tarball.d.mts`; modify `scripts/pack.mjs`; test `packages/core/test/publish.test.ts`.

- [ ] **Step 1: failing tests** — create `packages/core/test/publish.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readTar } from '../../../scripts/tarball.mjs';
import { publishedPackages, tarballName } from '../../../scripts/workspaces.mjs';

/** A minimal ustar archive, gzipped: what `npm pack` writes, for the entries given. */
export function makeTgz(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);       // checksum field as spaces while summing
    h[156] = 0x30;                  // '0': regular file
    h.write('ustar\0' + '00', 257);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('readTar', () => {
  it('returns each entry s bytes by path', () => {
    const d = mkdtempSync(join(tmpdir(), 'tar-'));
    try {
      const p = join(d, 'x.tgz');
      writeFileSync(p, makeTgz({ 'package/package.json': '{"name":"@tn3270/core"}', 'package/LICENSE': 'MIT' }));
      const t = readTar(p);
      expect([...t.keys()]).toEqual(['package/package.json', 'package/LICENSE']);
      expect(t.get('package/LICENSE')!.toString()).toBe('MIT');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('workspaces', () => {
  it('finds the eight published packages, and names their tarballs as npm pack does', () => {
    const names = publishedPackages().map(({ m }) => m.name).sort();
    expect(names).toEqual(['@tn3270/canvas', '@tn3270/cli', '@tn3270/core', '@tn3270/frontend',
      '@tn3270/gui', '@tn3270/node-files', '@tn3270/tui', '@tn3270/web']);
    expect(tarballName({ name: '@tn3270/node-files', version: '0.1.1' })).toBe('tn3270-node-files-0.1.1.tgz');
  });
});
```

- [ ] **Step 2: run, see it fail** (modules missing): `npx vitest run packages/core/test/publish.test.ts`.
- [ ] **Step 3: implement.** Move `publishedPackages` and `tarballName` (with their doc comments) from `scripts/pack.mjs` into `scripts/workspaces.mjs` (it needs only `node:fs`, `node:path`, `node:url`; compute `packagesDir` from its own `import.meta.url`). Move the body of `pack.mjs`'s `tarEntries` into `scripts/tarball.mjs` as `readTar(tgz)` returning `Map<string, Buffer>` (the entry's data is the `size` bytes after its header). In `pack.mjs`: `import { publishedPackages, tarballName } from './workspaces.mjs'; export { publishedPackages, tarballName };` and `export function tarEntries(tgz) { return [...readTar(tgz).keys()]; }`. Write the two `.d.mts` files (see `scripts/set-version.d.mts` for the pattern):

```ts
// workspaces.d.mts
export interface Manifest { name: string; version: string; private?: boolean; files?: string[]; dependencies?: Record<string, string> }
export function publishedPackages(): Array<{ dir: string; m: Manifest }>;
export function tarballName(m: { name: string; version: string }): string;
// tarball.d.mts
export function readTar(tgz: string): Map<string, Buffer>;
```

- [ ] **Step 4: gate**, plus `npm run bundle:gui && npm run pack:npm && node scripts/install-smoke.mjs` (5/5) — pack and install-smoke must behave exactly as before. Confirm `scripts/workspaces.mjs` and `scripts/tarball.mjs` import nothing but `node:` modules: `command grep -n "^import" scripts/workspaces.mjs scripts/tarball.mjs`.
- [ ] **Step 5: commit** `scripts: dependency-free workspaces.mjs and tarball.mjs, shared with pack.mjs`.

### Task 2: `publish.mjs` — the logic, pure

**Files:** Create `scripts/publish.mjs`, `scripts/publish.d.mts`; extend `packages/core/test/publish.test.ts`.

The functions (export each; `main` comes in Task 3):

```js
/** A tarball's identity: manifest name/version/@tn3270 deps, and the sha1 the registry records as dist.shasum. */
export function readTarball(path) -> { path, name, version, deps, sha1 }
/** Dependency order over the set's own @tn3270 deps; ties alphabetical. Throws on a cycle or a dep outside the set. */
export function publishOrder(tarballs) -> tarballs[]
/** Every rule a release must pass; `tag` undefined means dry-run (no tag rule). */
export function checkRelease({ tag, tarballs, expectedNames }) -> { version, problems: string[] }
/** The registry's dist.shasum for name@version, or undefined if absent; uncached (?write=true). */
export async function registryShasum(fetchFn, name, version) -> string | undefined
/** 'publish' when absent, 'skip' when identical, 'conflict' when different. */
export function decide(localSha1, registrySha1) -> 'publish' | 'skip' | 'conflict'
/** Polls until every tarball's version is on the registry with its sha1; returns the names still wrong. */
export async function verifyReadBack(fetchFn, tarballs, version, { attempts = 24, delayMs = 5000, sleep }) -> string[]
```

`checkRelease` problems (each a full sentence naming the fix): tag not `v` + `\d+.\d+.\d+`; tarball names not exactly `expectedNames`; a tarball's version not the release version (for dry-run: the versions disagree among themselves); a file not named `tarballName(manifest)`; an `@tn3270/*` dependency not pinned to exactly the version.

- [ ] **Step 1: failing tests** — append to `publish.test.ts` (import the functions from `../../../scripts/publish.mjs`; build tarballs with `makeTgz` into a temp dir; a manifest helper `man(name, version, deps)` → JSON):
  - `publishOrder` on the real eight's dependency shape (core; frontend→core; node-files→frontend; canvas→core,frontend; cli/tui→core,frontend,node-files; web/gui→canvas,core,frontend,node-files) yields exactly `core, frontend, canvas, node-files, cli, gui, tui, web`, and every package appears after all its deps;
  - a cycle (a→b, b→a) throws naming both; a dep outside the set throws naming it;
  - `checkRelease`: a clean set with tag `v0.1.2` → no problems, version `0.1.2`; tag `0.1.2`, `v0.1`, `v0.1.2-rc1` refused; a missing tarball, an extra one, a version mismatch, a bad file name, a dep pinned `^0.1.2` — each refused with its own message; dry-run (tag undefined) with mixed versions refused;
  - `decide`: undefined→publish, equal→skip, different→conflict;
  - `registryShasum` with a fake fetch: 404 → undefined; versions missing the version → undefined; present → its shasum; asserts the URL is `https://registry.npmjs.org/@tn3270%2Fcore?write=true`;
  - `verifyReadBack` with a fake fetch whose answer is wrong twice then right → `[]` after 3 attempts (fake `sleep` records the calls); always wrong → the names, after `attempts` tries.
- [ ] **Step 2: run, see them fail.**
- [ ] **Step 3: implement** in `scripts/publish.mjs` (imports: `node:crypto`, `node:fs`, `node:path`, `node:url`, `node:child_process` (Task 3), `./tarball.mjs`, `./workspaces.mjs` — nothing else). `readTarball` reads `package/package.json` via `readTar`, sha1 over the whole `.tgz` file. Write `scripts/publish.d.mts`.
- [ ] **Step 4: gate. Step 5: mutation checks** (revert each): order without the topological step (input order) → the order test fails; `decide` treating different as skip → its test fails; `verifyReadBack` with no retry → the retry test fails.
- [ ] **Step 6: commit** `scripts: publish.mjs release logic -- order, checks, registry read-back`.

### Task 3: `publish.mjs` modes

**Files:** Modify `scripts/publish.mjs`; extend tests.

- [ ] **Step 1: implement `main(argv, { env, fetchFn, run, sleep, log })`** (injected for tests; the module-level guard calls it with the real `process.env`, `fetch`, a `spawnSync('npm', args, { stdio: 'inherit' })` runner returning the exit status, a real `sleep`, and `console.log`; exit status 0 on success, 1 on any refusal with the problems printed). Modes, all taking the tarball directory as the second argument:
  - `--dry-run DIR`: `checkRelease` with no tag; print the order; `run(['publish', '--dry-run', path])` for each in order; any non-zero → fail.
  - `--check DIR`: tag from `env.GITHUB_REF_NAME` (missing → refused); `checkRelease`; then for each tarball `decide(sha1, await registryShasum(...))`; any `conflict` → fail naming it; print the plan (`publish` / `skip` per package, in order).
  - `--publish DIR`: everything `--check` does, then in order `run(['publish', path])` unless `skip`; the first non-zero stops (fail, naming it and that the rest were not attempted); then `verifyReadBack`; any name left → fail listing them; else print `published X.Y.Z: <n> new, <m> already there, registry verified`.
- [ ] **Step 2: tests** for `main` with fakes (no network, no npm): dry-run runs `publish --dry-run` 8× in dependency order; `--check` without `GITHUB_REF_NAME` fails; a conflict fails before any `run`; `--publish` skips identical, publishes absent, stops at the first failing `run` (later ones never called), and fails when the read-back never matches; success path prints the summary.
- [ ] **Step 3: real dry run** against real tarballs: `npm run bundle:gui && npm run pack:npm && node scripts/publish.mjs --dry-run artifacts/npm` — prints the order and eight `npm publish --dry-run` reports, exit 0. And `GITHUB_REF_NAME=v0.1.1 node scripts/publish.mjs --check artifacts/npm` against the live registry: plan says `skip` for all eight ONLY IF the local tarballs equal the published 0.1.1 bytes — if they don't (local pack differs from CI's), it must say `conflict`, which is the correct refusal; record which you saw.
- [ ] **Step 4: gate, mutation** (the publish loop not stopping on failure → its test fails). **Commit** `scripts: publish.mjs --dry-run, --check, --publish`.

### Task 4: the workflow

**Files:** Modify `.github/workflows/package.yml`; create `packages/core/test/workflow.test.ts`.

- [ ] **Step 1:** `on.push` gains `tags: ['v*.*.*']`. In the `package` job, after `- run: npm run pack:npm`, add `- if: matrix.npm` / `run: node scripts/publish.mjs --dry-run artifacts/npm`. Add after the `package` job:

```yaml
  release-check:
    # A tag push only. Outside the npm environment, so a bad tag fails before anyone is asked.
    if: startsWith(github.ref, 'refs/tags/v')
    needs: package
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: '22' }
      - uses: actions/download-artifact@v8
        with: { name: npm-tarballs, path: tarballs }
      - run: node scripts/publish.mjs --check tarballs
  publish:
    # Waits for the npm environment's required reviewer. OIDC: no token anywhere.
    if: startsWith(github.ref, 'refs/tags/v')
    needs: release-check
    runs-on: ubuntu-latest
    environment: npm
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: '24' }
      - run: npm install -g npm@^11.5.1 && npm --version
      - uses: actions/download-artifact@v8
        with: { name: npm-tarballs, path: tarballs }
      - run: node scripts/publish.mjs --publish tarballs
```

Check `actions/download-artifact` v8 downloads artifacts uploaded by `actions/upload-artifact@v7` (read its README/release notes; if not, use the major that does, and say why). Update the workflow header comment: the tag trigger, the two jobs, the `npm` environment (required reviewer, `v*.*.*` tags only), and that npmjs.com's trusted publisher names THIS file, `package.yml`, with environment `npm` — renaming the file or the environment breaks publishing.

- [ ] **Step 2: `workflow.test.ts`** pins, by reading the file as text: the tag trigger; both jobs exist with `if: startsWith(github.ref, 'refs/tags/v')`; `publish` has `environment: npm`, `id-token: write`, `needs: release-check`; `release-check` has `needs: package` and NO `environment:`; the dry-run step exists. Check `packages/core/test/manifests.test.ts`'s Node-floor test still passes (it reads `node:` matrix lines; the new jobs use `node-version:`).
- [ ] **Step 3: gate. Commit** `ci: publish on a v*.*.* tag over OIDC, after the npm environment's approval`.

### Task 5: docs

- [ ] `docs/releasing.md`: the procedure becomes bump (`npm run version:set -- X.Y.Z`, `npm install`), commit, push, CI green, `git tag vX.Y.Z && git push origin vX.Y.Z`, approve the `publish` job in the Actions run (environment `npm`), read its summary line. Keep the manual loop as **Fallback** (with `npm whoami` and `|| break`) until tokens are disallowed. A **One-time setup** section: the `npm` environment (exists, created 2026-11-09 with `gh api`: reviewer `athornton`, self-review allowed, `v*.*.*` tags only); the eight trusted-publisher entries on npmjs.com (owner `athornton`, repo `tn3270`, workflow `package.yml`, environment `npm`; npm publish ON, dist-tag OFF, stage publish ON — done by the user 2026-11-09); and, after the first CI publish, "Require two-factor authentication and disallow tokens" on each package. Replace the *Tag-triggered publishing* "Not set up yet" section.
- [ ] README *Remaining* item 14 and `docs/HANDOFF.md` START HERE: trusted publishing built, proof owed (0.1.2).
- [ ] Check summary lines (`command grep -n -i "tag-triggered\|trusted publishing\|not set up" README.md docs/*.md`). Commit `docs: releasing by tag, approved in the npm environment`.

### Task 6: branch gate and CI

- [ ] `npm ci && npm run build && npm run typecheck && npx vitest run`; `npm run bundle:gui && npm run pack:npm && node scripts/install-smoke.mjs`; `node scripts/publish.mjs --dry-run artifacts/npm`.
- [ ] Push `trusted-publish`, `gh workflow run package.yml --ref trusted-publish`: all six jobs green; the ubuntu-latest log shows the dry-run step's eight reports; `release-check` and `publish` SKIPPED (not a tag). Merging, then the 0.1.2 proof release, are the user's calls.
