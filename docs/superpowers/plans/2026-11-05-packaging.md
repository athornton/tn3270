# Packaging (milestone A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every front end installable from npm tarballs and runnable through `$PATH` on Linux, macOS and Windows; the GUI also shipped as unsigned native artifacts that open a connect dialog when double-clicked.

**Architecture:** Plain-Node front ends (cli, tui, web) ship their `tsc` output and rely on normal npm resolution, after removing every runtime path that assumes the monorepo layout. The GUI is bundled by esbuild into a self-contained `packages/gui/app/`, which is the single input to both the npm package (via a small launcher) and electron-builder. A GitHub Actions matrix (four runners) builds, tests, packs, installs from tarballs and smoke-runs every executable.

**Tech Stack:** TypeScript 7 (`tsc --build`), vitest 3, Node ≥22, Electron 44.3.0, esbuild 0.28, electron-builder 26, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-05-packaging-design.md`.

---

## READ THIS FIRST (for every implementer)

1. **The repository beats this plan.** The code blocks below are drafts written from a reading of
   the repo on 2026-11-05. Before writing each task, re-read the files it names. Where the plan
   and the source disagree, the source wins; report the disagreement in your task summary. (In
   the last big plan, 13 of ~17 defects were in the plan's own literal code.)
2. **`grep` and `find` in this shell are ugrep and bfs**, with different flags; ugrep inverts
   `-z`. Use `command grep` if a result looks impossible.
3. **Never `pkill -f electron`**: it matches its own shell. Kill by PID.
4. **Stale `dist`:** if a harness refuses with `dist is OLDER than src`, run
   `npx tsc --build --force packages/<pkg>` for each package; a root `--force` does not work
   (there is no root `tsconfig.json`).
5. **Typecheck matters:** vitest does not typecheck. Every task's gate is
   `npm run build && npm run typecheck && npx vitest run`, all exit 0.
6. **Baseline (measured 2026-11-05 on `main` at `a563fce`):** 2960 tests in 119 files.
7. Work on branch **`packaging`**, created from `main`. Commit after each task with the
   attribution lines from the session's system reminder.

## File map

| Path | New/Mod | Responsibility |
|---|---|---|
| `packages/node-files/src/isMain.ts` | new | `isMain(metaUrl, argv1?)`: is this module the program being run |
| `packages/node-files/src/index.ts` | mod | re-export `isMain` |
| `packages/tui/src/main.ts:392` | mod | use `isMain` |
| `packages/web/src/main.ts:1,729` | mod | shebang; use `isMain` |
| `packages/web/package.json` | mod | depend on `@tn3270/node-files`; tsconfig reference |
| `packages/web/src/httpstatic.ts:173,205` | mod | no `../../` paths: `ui.css` from own dist, frontend via resolver |
| `packages/web/scripts/copy-ui-css.mjs` | new | build step: copy `gui/ui.css` → `web/dist/ui.css` |
| `packages/*/package.json` | mod | `files`, `engines`, `repository`, `description`, `publishConfig` |
| `packages/*/README.md` | new | short per-package README (cli/tui/web/gui real; libs one paragraph) |
| `test/manifests.test.ts` | new | manifest invariants across all packages |
| `vitest.config.ts` | mod | include `test/**/*.test.ts` |
| `scripts/set-version.mjs` | new | lockstep version bump |
| `scripts/pack.mjs` | new | `npm pack` each publishable workspace into `artifacts/npm/` |
| `scripts/install-smoke.mjs` | new | install tarballs into a temp prefix, run each bin via `PATH` |
| `packages/gui/src/appRoot.ts` | new | where the GUI's HTML/preloads/atlas live in `dist` vs `app` layout |
| `packages/gui/src/main.ts` | mod | use `appRoot`; connect dialog startup branch |
| `packages/canvas/src/assets.ts` | mod | atlas directory overridable for the bundle |
| `packages/gui/scripts/bundle.mjs` | new | esbuild → `packages/gui/app/` |
| `packages/gui/bin/tn3270-gui.mjs` | new | npm launcher: spawn Electron on `app/main.js` |
| `packages/gui/src/connectForm.ts` | new | pure `dialogToArgv` |
| `packages/gui/connect.html`, `src/connectBoot.ts`, `src/connectPreload.cts` | new | the dialog window |
| `packages/frontend/src/tls.ts:145` | mod | `describeTlsError(..., remedy)` variant naming the checkbox |
| `packages/gui/scripts/xvfb.mjs` + `shot/keys/clicks.mjs` | mod | `TN3270_GUI_MAIN=app` selects the bundle |
| `packages/gui/scripts/connect.mjs` | new | dialog harness |
| `packages/gui/electron-builder.yml` | new | native artifact config |
| `.github/workflows/package.yml` | new | CI matrix |
| `docs/releasing.md` | new | manual publish procedure |
| `.gitignore` | mod | `artifacts/`, `packages/gui/app/` |

---

### Task 0: Measure the suite on all four runners before changing anything

**Files:** Create: `.github/workflows/package.yml` (baseline form; Task 14 replaces its body)

The spec requires the failures on macOS/Windows to be measured, not guessed. This task needs a
push to GitHub, which is **outward-facing: ask the user before pushing the branch.**

- [ ] **Step 1: Create branch**

```bash
cd ~/git/tn3270 && git switch -c packaging main
```

- [ ] **Step 2: Write the baseline workflow**

```yaml
name: package
on:
  push:
    branches: [main, packaging]
  pull_request:
  workflow_dispatch:
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, ubuntu-24.04-arm, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npx vitest run --reporter=default --reporter=junit --outputFile=vitest-junit.xml
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: vitest-${{ matrix.os }}, path: vitest-junit.xml }
```

Check before trusting it: the `build` script for canvas runs `node scripts/build-atlas.mjs`,
which must work on Windows (path joins only, by inspection); `npm ci` needs the lockfile in sync
(`npm ci` locally first).

Also check: whether GitHub still offers an Intel macOS runner (`macos-15-intel` or similar) as of
today — read <https://github.com/actions/runner-images>. If yes, add it to the matrix here; the
spec says a native x64 run replaces the Rosetta one.

- [ ] **Step 3: Commit, ask the user, push the branch**

```bash
git add .github/workflows/package.yml
git commit -m "ci: baseline matrix -- build, typecheck, vitest on four runners"
# ONLY after the user agrees:
git push -u origin packaging
```

Note the memory *lsst-stack-shadows-gh*: a broken conda `gh` shim may print an error on a
successful push; verify with `git fetch && git status -sb`. Use `/usr/bin/gh run watch` to follow.

- [ ] **Step 4: Record the measurement**

For each runner record: build/typecheck pass or fail, and the exact failing test names from the
junit artifact. Write them into a new section *CI baseline, 2026-11-05* in `docs/HANDOFF.md`.
**Do not fix anything in this task.** If Windows build itself fails, record the first error.

- [ ] **Step 5: Triage the failures into a list appended to this plan as Task 0b**

Each failing test gets one of: (a) a real portability bug in `src/` → fix in Task 0b with a test;
(b) a test assumption (POSIX path literal, `/tmp`, pty, `chmod`) → `it.skipIf(process.platform
=== 'win32')` **with a comment stating the reason**. Never delete a test, never add retries.
Report the list to the user before Task 0b.

---

### Task 1: `isMain` — a main-module check that survives npm's bin shims

**Files:**
- Create: `packages/node-files/src/isMain.ts`, `packages/node-files/test/isMain.test.ts`
- Modify: `packages/node-files/src/index.ts`, `packages/tui/src/main.ts:392`,
  `packages/web/src/main.ts` (line 1, line 729), `packages/web/package.json`,
  `packages/web/tsconfig.json` (add `{ "path": "../node-files" }` reference)

`node-files` depends on `frontend`; `web` already depends on `frontend`, so adding `node-files`
creates no cycle. Check `packages/node-files/tsconfig.test.json` exists (it does per the root
`typecheck:tests` script).

- [ ] **Step 1: Write the failing test**

```ts
// packages/node-files/test/isMain.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMain } from '../src/isMain.js';

describe('isMain', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  function fixture(): { real: string; url: string } {
    dir = mkdtempSync(join(tmpdir(), 'ismain-'));
    const real = join(dir, 'main.js');
    writeFileSync(real, '');
    return { real, url: pathToFileURL(real).href };
  }

  it('is true when argv[1] is the module itself', () => {
    const { real, url } = fixture();
    expect(isMain(url, real)).toBe(true);
  });

  it('is true when argv[1] is a SYMLINK to the module -- how npm installs a bin on POSIX', () => {
    const { real, url } = fixture();
    const link = join(dir!, 'tn3270');
    try { symlinkSync(real, link); } catch { return; } // Windows without symlink privilege
    expect(isMain(url, link)).toBe(true);
  });

  it('is false when the module is imported by another program', () => {
    const { url } = fixture();
    const other = join(dir!, 'other.js');
    writeFileSync(other, '');
    expect(isMain(url, other)).toBe(false);
  });

  it('is false, not a throw, when argv[1] is absent or does not exist', () => {
    const { url } = fixture();
    expect(isMain(url, undefined)).toBe(false);
    expect(isMain(url, join(dir!, 'nope.js'))).toBe(false);
  });

  it('is true for an argv[1] spelled with a different but equivalent path', () => {
    const { real, url } = fixture();
    expect(isMain(url, join(dir!, '.', 'main.js'))).toBe(true);
    expect(isMain(url, real.replace(/main\.js$/, '../' + real.split(/[\\/]/).at(-2) + '/main.js'))).toBe(true);
  });
});
```

The old check fails cases 2 and 5 (it compares URL strings), and on Windows it fails case 1 too
(`file:///C:/...` vs `file://C:\...`).

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run packages/node-files/test/isMain.test.ts`
Expected: FAIL, cannot resolve `../src/isMain.js`.

- [ ] **Step 3: Implement**

```ts
// packages/node-files/src/isMain.ts
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `metaUrl` is the program Node was asked to run.
 *
 * REPLACES `import.meta.url === \`file://${process.argv[1]}\``, which the TUI and the web gateway
 * used, and which is FALSE for every installed copy: npm installs a bin as a symlink on POSIX
 * and as a `.cmd` shim on Windows, so `argv[1]` names the link, not the file; and on Windows a
 * path has a drive letter and backslashes that no `file://` concatenation reproduces. The
 * program then exits 0 having done nothing. Comparing REAL paths handles all three.
 *
 * `argv1` is a parameter only so the tests need not mutate `process.argv`.
 */
export function isMain(metaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
```

Add `export { isMain } from './isMain.js';` to `packages/node-files/src/index.ts`.

- [ ] **Step 4: Run the test, expect pass**

Run: `npx tsc --build packages/node-files && npx vitest run packages/node-files`
Expected: PASS.

- [ ] **Step 5: Use it in the TUI and the web gateway**

`packages/tui/src/main.ts:392`: replace the condition with `isMain(import.meta.url)`, importing
`isMain` from `@tn3270/node-files` (already a tui dependency). Update the comment at
`packages/tui/test/main.test.ts:7-11`, which describes the old guard.

`packages/web/src/main.ts`: make line 1 `#!/usr/bin/env node`; replace line 729's condition with
`isMain(import.meta.url)`; update the comment above it. Add `"@tn3270/node-files": "0.1.0"` to
`packages/web/package.json` `dependencies` and the tsconfig reference. Run `npm install` so the
workspace link exists.

- [ ] **Step 6: Prove the old failure and the fix through a real symlink**

```bash
npm run build
ln -sf "$PWD/packages/tui/dist/main.js" /tmp/tn3270-link && chmod +x packages/tui/dist/main.js
/tmp/tn3270-link --bogus; echo "exit $?"
```
Expected: `unrecognized argument "--bogus"` and `exit 2`. (Before this task: no output, exit 0 —
measured 2026-11-05.) Repeat for `packages/web/dist/main.js` with `--bogus`: expect the gateway's
usage error and a non-zero exit. Remove `/tmp/tn3270-link`.

- [ ] **Step 7: Gate and commit**

`npm run build && npm run typecheck && npx vitest run` → all 0.

```bash
git add packages/node-files packages/tui packages/web package-lock.json
git commit -m "node-files: isMain, so installed bins run through npm's symlinks and shims"
```

---

### Task 2: The web gateway stops reaching into sibling packages by relative path

**Files:**
- Modify: `packages/web/src/httpstatic.ts:173` (`ui.css`), `:205` (`frontendDist`)
- Create: `packages/web/scripts/copy-ui-css.mjs`
- Modify: `packages/web/package.json` (`build` script), `packages/web/test/httpstatic.test.ts`

Under npm, `packages/web/dist/../../gui/ui.css` does not exist (web does not and cannot depend
on gui, which pulls in Electron), and `../../frontend/dist` points beside `@tn3270/web` rather
than at the installed `@tn3270/frontend`.

- [ ] **Step 1: Write the failing test** (append to `packages/web/test/httpstatic.test.ts`)

```ts
import { readFileSync as readSrc } from 'node:fs';
import { fileURLToPath as toPath } from 'node:url';

describe('no asset path depends on the monorepo layout', () => {
  it('httpstatic.ts names no path that climbs out of its own package', () => {
    const src = readSrc(toPath(new URL('../src/httpstatic.ts', import.meta.url)), 'utf8');
    // Code lines only: the comments legitimately describe the old paths.
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/'\.\.',\s*'\.\.'/);
  });

  it('serves ui.css from this package\'s own dist', () => {
    expect(resolveAsset('/ui.css')!.file).toMatch(/[\\/]web[\\/]dist[\\/]ui\.css$/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (both cases)

Run: `npx vitest run packages/web/test/httpstatic.test.ts`

- [ ] **Step 3: Implement**

`packages/web/scripts/copy-ui-css.mjs`:

```js
/**
 * Copies `packages/gui/ui.css` into this package's `dist/` at build time.
 *
 * ONE SOURCE, A GENERATED COPY: `httpstatic.ts` explains why the file lives in `gui` and why a
 * second COMMITTED copy is wrong. A build output is not a second source -- `dist/` is
 * gitignored and regenerated every build -- and it is the only way an installed `@tn3270/web`
 * can have the file, since this package cannot depend on `@tn3270/gui` (Electron).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
mkdirSync(dist, { recursive: true });
copyFileSync(join(here, '..', '..', 'gui', 'ui.css'), join(dist, 'ui.css'));
```

`packages/web/package.json`: `"build": "tsc --build && node scripts/copy-ui-css.mjs"`.

`httpstatic.ts`: `ui.css` entry becomes `file: join(here, 'ui.css')`. `frontendDist` becomes:

```ts
import { createRequire } from 'node:module';
// `@tn3270/frontend` is a dependency, so Node's resolver finds it wherever npm put it --
// a sibling in the workspace, nested or hoisted in an install. Its `main` is `dist/index.js`.
const frontendDist = dirname(createRequire(import.meta.url).resolve('@tn3270/frontend'));
```

Check first: `@tn3270/frontend`'s `exports` has `"."` → `./dist/index.js`, which `require.resolve`
honours (`require` condition falls back to the plain string export). If resolve throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`, resolve `'@tn3270/frontend/dist/keymap.js'` (exported) instead and
take its `dirname`. Rewrite the long comments at both sites to describe the new mechanism and why,
keeping their history paragraphs.

- [ ] **Step 4: Run, expect PASS**; then the full web suite and the browser harness

Run: `npm run build && npx vitest run packages/web && node packages/web/scripts/browser-shot.mjs`
Expected: all pass; browser-shot 1/1 (it proves the page still renders identically).

- [ ] **Step 5: Gate and commit**

```bash
git add packages/web
git commit -m "web: serve ui.css and frontend modules without monorepo-relative paths"
```

---

### Task 3: Manifests fit for publishing, and a test that keeps them so

**Files:**
- Modify: every `packages/*/package.json` except `fixtures`
- Create: `test/manifests.test.ts`; Modify: `vitest.config.ts`, root `package.json`
  (`typecheck:tests` — add a root `tsconfig.test.json` covering `test/`, or put the test under
  `packages/core/test/` if a root tsconfig is awkward; **pick the latter if in doubt** and adjust
  paths, since every existing tsconfig is per-package)
- Create: `packages/{cli,tui,web,gui}/README.md` (short), `packages/{core,frontend,canvas,node-files}/README.md` (one paragraph each)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/manifests.test.ts  (or test/manifests.test.ts; see Files)
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = fileURLToPath(new URL('../../', import.meta.url)); // packages/
interface Manifest {
  name: string; version: string; private?: boolean; files?: string[];
  bin?: Record<string, string>; engines?: { node?: string };
  publishConfig?: { access?: string }; repository?: unknown; description?: string;
  dependencies?: Record<string, string>; scripts?: Record<string, string>;
}
const manifests = readdirSync(packagesDir)
  .filter((d) => existsSync(join(packagesDir, d, 'package.json')))
  .map((d) => ({ dir: d, m: JSON.parse(readFileSync(join(packagesDir, d, 'package.json'), 'utf8')) as Manifest }));
const published = manifests.filter(({ m }) => m.private !== true);
const root = JSON.parse(readFileSync(join(packagesDir, '..', 'package.json'), 'utf8')) as Manifest;

describe('package manifests', () => {
  it('finds the eight published packages and the private fixtures', () => {
    expect(published.map(({ m }) => m.name).sort()).toEqual([
      '@tn3270/canvas', '@tn3270/cli', '@tn3270/core', '@tn3270/frontend',
      '@tn3270/gui', '@tn3270/node-files', '@tn3270/tui', '@tn3270/web',
    ].sort());
    expect(manifests.find(({ m }) => m.name === '@tn3270/fixtures')!.m.private).toBe(true);
  });

  it.each(published.map(({ dir, m }) => [m.name, dir, m] as const))(
    '%s has files, engines, publishConfig, repository and description', (_n, _d, m) => {
      expect(m.files?.length).toBeGreaterThan(0);
      expect(m.files).not.toContain('src');
      expect(m.engines?.node).toBe('>=22');
      expect(m.publishConfig?.access).toBe('public');
      expect(m.repository).toBeDefined();
      expect(m.description).toBeTruthy();
    });

  it('every package, and the root, is at ONE version, and internal deps pin exactly it', () => {
    const v = root.version;
    for (const { m } of manifests) {
      expect(m.version, m.name).toBe(v);
      for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
        if (dep.startsWith('@tn3270/')) expect(range, `${m.name} -> ${dep}`).toBe(v);
      }
    }
  });

  it('no published package depends on @tn3270/fixtures', () => {
    for (const { m } of published) expect(m.dependencies?.['@tn3270/fixtures'], m.name).toBeUndefined();
  });

  it('every bin source starts with a shebang, and its target is under a shipped directory', () => {
    for (const { dir, m } of published) {
      for (const [name, target] of Object.entries(m.bin ?? {})) {
        const top = target.replace(/^\.\//, '').split('/')[0]!;
        expect(m.files, `${name}: ${target} is not shipped`).toContain(top);
        // dist/X.js comes from src/X.ts; bin/X.mjs is itself the source.
        const source = top === 'dist'
          ? join(packagesDir, dir, target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))
          : join(packagesDir, dir, target);
        expect(readFileSync(source, 'utf8').startsWith('#!/usr/bin/env node'), `${name}: ${source}`).toBe(true);
      }
    }
  });

  it('names the four executables the README promises', () => {
    const bins = Object.assign({}, ...published.map(({ m }) => m.bin ?? {}));
    expect(Object.keys(bins).sort()).toEqual(['tn3270', 'tn3270-cli', 'tn3270-gui', 'tn3270-web']);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (missing fields; no `tn3270-gui` bin)

- [ ] **Step 3: Edit the manifests**

Common fields for each published package (fill `description` per package):

```json
"description": "…",
"repository": { "type": "git", "url": "git+https://github.com/athornton/tn3270.git", "directory": "packages/<dir>" },
"homepage": "https://github.com/athornton/tn3270#readme",
"engines": { "node": ">=22" },
"publishConfig": { "access": "public" },
```

`files`: core, frontend, node-files, cli, tui → `["dist", "README.md"]`; canvas →
`["dist", "README.md"]` (the atlas is in `dist`); web → `["dist", "static", "README.md"]`; gui →
`["app", "bin", "README.md"]`. **gui:** add `"bin": { "tn3270-gui": "./bin/tn3270-gui.mjs" }`,
move `electron` from `devDependencies` to `dependencies` pinned `"44.3.0"` (exact; the bundle is
tested against one Electron), and move the `@tn3270/*` runtime deps to `devDependencies` — the
bundle inlines them, so an npm install must not fetch them. **Re-check** that last claim against
Task 5's bundle before relying on it; until Task 8 creates `bin/tn3270-gui.mjs`, create it as a
stub with the shebang line and `process.exit(1)` so this test can pass now.

`.d.ts` files: `files: ["dist"]` ships `.map` and `.d.ts` too, which is fine.

Add the READMEs: cli/tui/web/gui each say what the command is, `npm install -g @tn3270/<x>`,
the command name, one example invocation copied from the root README, and a link to the root
README. Library packages: one paragraph, "internal to the tn3270 client; no stable API".

- [ ] **Step 4: Run, expect PASS; check what `npm pack` would ship**

```bash
npx vitest run packages/core/test/manifests.test.ts
for p in core frontend node-files canvas cli tui web; do (cd packages/$p && npm pack --dry-run 2>&1 | grep -E "Tarball Contents|tsbuildinfo|src/|test/" ); done
```
Expected: no `src/`, `test/` or `tsbuildinfo` line under any package.

- [ ] **Step 5: Gate, commit**

```bash
git commit -am "packages: publishable manifests, READMEs, and a test that pins them"
```

---

### Task 4: Lockstep version bump

**Files:** Create `scripts/set-version.mjs`, `packages/core/test/setVersion.test.ts`; Modify root `package.json` (`"version:set": "node scripts/set-version.mjs"`)

- [ ] **Step 1: Failing test** — the script exports `setVersion(rootDir, version)` and is run as
a program by the npm script. Test against a temp copy:

```ts
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs script, no declarations
import { setVersion } from '../../../scripts/set-version.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

describe('set-version', () => {
  it('sets every manifest and every internal dependency to the new version, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'setver-'));
    try {
      cpSync(join(repo, 'package.json'), join(dir, 'package.json'));
      for (const p of ['core', 'cli', 'gui', 'fixtures']) {
        cpSync(join(repo, 'packages', p, 'package.json'), join(dir, 'packages', p, 'package.json'), { recursive: true });
      }
      setVersion(dir, '0.2.0');
      const read = (p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
      expect(read('package.json').version).toBe('0.2.0');
      const cli = read('packages/cli/package.json');
      expect(cli.version).toBe('0.2.0');
      expect(cli.dependencies['@tn3270/core']).toBe('0.2.0');
      expect(read('packages/gui/package.json').dependencies.electron).toBe('44.3.0');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a version that is not plain semver', () => {
    expect(() => setVersion(repo, 'v1')).toThrow(/semver/);
  });
});
```

If `@ts-expect-error` fights `typecheck:tests`, add a `scripts/set-version.d.mts` the way
`packages/cli/scripts/tls-proxy.d.mts` does — follow that existing pattern.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```js
#!/usr/bin/env node
/**
 * Sets ONE version on the root and every workspace manifest, and on every `@tn3270/*`
 * dependency, devDependency and peerDependency. Lockstep because internal dependencies are
 * exact: a mixed set cannot resolve. Run `npm install` afterwards to update the lockfile.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../packages/node-files/dist/isMain.js';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function setVersion(rootDir, version) {
  if (!SEMVER.test(version)) throw new Error(`not plain semver: ${JSON.stringify(version)}`);
  const files = [join(rootDir, 'package.json')];
  const pk = join(rootDir, 'packages');
  if (existsSync(pk)) {
    for (const d of readdirSync(pk)) {
      const f = join(pk, d, 'package.json');
      if (existsSync(f)) files.push(f);
    }
  }
  for (const f of files) {
    const m = JSON.parse(readFileSync(f, 'utf8'));
    m.version = version;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const dep of Object.keys(m[field] ?? {})) {
        if (dep.startsWith('@tn3270/')) m[field][dep] = version;
      }
    }
    writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
  }
  return files.length;
}

if (isMain(import.meta.url)) {
  const v = process.argv[2];
  if (v === undefined) { process.stderr.write('usage: npm run version:set -- X.Y.Z\n'); process.exit(2); }
  const n = setVersion(fileURLToPath(new URL('..', import.meta.url)), v);
  process.stdout.write(`set ${n} manifests to ${v}; now run npm install\n`);
}
```

Note: `core/src/index.ts` has `export const VERSION = '0.1.0'`. Either make the script rewrite it
too (and test that), or derive it — **check who reads `VERSION`** (`grep -rn "VERSION" packages/*/src`)
and choose; the manifest test should then also assert it equals the manifest version.

- [ ] **Step 4: PASS; gate; commit** — `git commit -m "scripts: lockstep set-version"`

---

### Task 5: Bundle the GUI into `packages/gui/app/`

**Files:**
- Create: `packages/gui/src/appRoot.ts`, `packages/gui/test/appRoot.test.ts`, `packages/gui/scripts/bundle.mjs`
- Modify: `packages/gui/src/main.ts` (every `join(here, …)`: lines 365, 417, 553, 573, 672, 686, 759, 869 as of `a563fce`), `packages/canvas/src/assets.ts` (`assetDir`/`readAtlas`), root `package.json` (`bundle:gui`), `.gitignore`

**The two layouts.**

| | unbundled (`dist`) | bundled (`app`) |
|---|---|---|
| main | `packages/gui/dist/main.js` | `app/main.js` |
| preloads | `dist/*.cjs` | `app/*.cjs` |
| HTML | `packages/gui/*.html` (= `dist/..`) | `app/*.html` |
| page modules | `../canvas/dist/renderer.js`, `./dist/keypadBoot.js`, import maps into `../canvas`, `../frontend` | `app/renderer.js`, `app/keypadBoot.js`, … flat |
| atlas | `packages/canvas/dist/atlas.{json,bin}` via `assetDir()` | `app/atlas.{json,bin}` |

`appRoot.ts` answers both from one rule: **the bundle writes a marker file `app/BUNDLED`**.

- [ ] **Step 1: Failing test**

```ts
// packages/gui/test/appRoot.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutFor } from '../src/appRoot.js';

describe('layoutFor', () => {
  it('unbundled: documents beside dist, preloads in dist, atlas from canvas', () => {
    const d = mkdtempSync(join(tmpdir(), 'approot-'));
    try {
      mkdirSync(join(d, 'dist'));
      const l = layoutFor(join(d, 'dist'));
      expect(l.bundled).toBe(false);
      expect(l.document('index.html')).toBe(join(d, 'index.html'));
      expect(l.preload('preload.cjs')).toBe(join(d, 'dist', 'preload.cjs'));
      expect(l.atlasDir).toBeUndefined(); // meaning: ask @tn3270/canvas
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('bundled: everything flat beside main.js', () => {
    const d = mkdtempSync(join(tmpdir(), 'approot-'));
    try {
      writeFileSync(join(d, 'BUNDLED'), '');
      const l = layoutFor(d);
      expect(l.bundled).toBe(true);
      expect(l.document('index.html')).toBe(join(d, 'index.html'));
      expect(l.preload('preload.cjs')).toBe(join(d, 'preload.cjs'));
      expect(l.atlasDir).toBe(d);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: FAIL.**

- [ ] **Step 3: Implement `appRoot.ts`**

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where the GUI's files are, given the directory `main.js` runs from.
 *
 * TWO LAYOUTS, ONE RULE. Unbundled (`packages/gui/dist/main.js`) the HTML documents sit one
 * level up and the atlas belongs to `@tn3270/canvas`. Bundled (`app/main.js`, built by
 * `scripts/bundle.mjs`) everything is flat. The bundle writes `BUNDLED` so the answer is a
 * fact on disk rather than a guess from a directory name -- a guess that a packaged app's
 * asar path (`…/app.asar/main.js`) would get wrong.
 */
export interface Layout {
  readonly bundled: boolean;
  document(name: string): string;
  preload(name: string): string;
  /** The atlas directory, or undefined to use `@tn3270/canvas`'s own. */
  readonly atlasDir: string | undefined;
}

export function layoutFor(mainDir: string): Layout {
  const bundled = existsSync(join(mainDir, 'BUNDLED'));
  return {
    bundled,
    document: (name) => bundled ? join(mainDir, name) : join(mainDir, '..', name),
    preload: (name) => join(mainDir, name),
    atlasDir: bundled ? mainDir : undefined,
  };
}
```

`existsSync` works inside asar (Electron patches `fs`). In `main.ts`, create
`const layout = layoutFor(here);` beside `here` (line 52) and replace every
`join(here, '..', X.html)` with `layout.document('X.html')` and every `join(here, 'X.cjs')` with
`layout.preload('X.cjs')`. In `canvas/src/assets.ts`, give `readAtlas` an optional `dir` argument
defaulting to `assetDir()`, and call `readAtlas(layout.atlasDir)` from main. Run the existing GUI
tests and `node packages/gui/scripts/shot.mjs` — the unbundled build must be unchanged (goldens
match).

- [ ] **Step 4: Write `packages/gui/scripts/bundle.mjs`**

```js
/**
 * Bundles the GUI into packages/gui/app/: a directory that runs under Electron with NO
 * node_modules. It is the single input to the npm package and to electron-builder.
 *
 * WHAT IS BUNDLED HOW:
 *  - main.ts           -> app/main.js, ESM, platform node, `electron` external. Inlines core,
 *                         frontend, canvas, node-files.
 *  - *Preload.cts      -> app/*.cjs, CommonJS (an ESM preload cannot load; see preload.cts).
 *  - page modules      -> app/<name>.js, ESM, platform browser, each a self-contained bundle,
 *                         so no import map is needed and the HTML loses its maps.
 *  - HTML, ui.css, atlas.{json,bin} copied; each HTML's <script src> rewritten to ./<name>.js.
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = join(dirname(fileURLToPath(import.meta.url)), '..');
const canvasDist = join(gui, '..', 'canvas', 'dist');
const out = join(gui, 'app');
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

await build({
  entryPoints: [join(gui, 'src', 'main.ts')],
  outfile: join(out, 'main.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['electron'],
  // ESM output that inlines CommonJS needs a real `require`; esbuild's shim throws otherwise.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  sourcemap: true,
});

for (const p of ['preload', 'keypadPreload', 'keyboardPreload', 'transferPreload', 'connectPreload']) {
  await build({
    entryPoints: [join(gui, 'src', `${p}.cts`)],
    outfile: join(out, `${p}.cjs`),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  });
}

/** document -> [ [src as written in the HTML, entry point, output name] ] */
const PAGES = {
  'index.html':    [['../canvas/dist/renderer.js', join(canvasDist, 'renderer.js'), 'renderer.js']],
  'keypad.html':   [['./dist/keypadBoot.js',   join(gui, 'src', 'keypadBoot.ts'),   'keypadBoot.js']],
  'keyboard.html': [['./dist/keyboardBoot.js', join(gui, 'src', 'keyboardBoot.ts'), 'keyboardBoot.js']],
  'transfer.html': [['./dist/transferBoot.js', join(gui, 'src', 'transferBoot.ts'), 'transferBoot.js']],
  'connect.html':  [['./dist/connectBoot.js',  join(gui, 'src', 'connectBoot.ts'),  'connectBoot.js']],
};

for (const [doc, scripts] of Object.entries(PAGES)) {
  let html = readFileSync(join(gui, doc), 'utf8');
  for (const [written, entry, name] of scripts) {
    if (!html.includes(`src="${written}"`)) throw new Error(`${doc}: no <script src="${written}">`);
    await build({ entryPoints: [entry], outfile: join(out, name), bundle: true, platform: 'browser', format: 'esm', target: 'chrome140' });
    html = html.replace(`src="${written}"`, `src="./${name}"`);
  }
  // Bundled modules have no bare specifiers left, so the import map is dead weight -- and a
  // map pointing at ../canvas would be a lie about the layout. Remove it.
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
  writeFileSync(join(out, doc), html);
}

cpSync(join(gui, 'ui.css'), join(out, 'ui.css'));
for (const f of ['atlas.json', 'atlas.bin']) cpSync(join(canvasDist, f), join(out, f));
writeFileSync(join(out, 'package.json'), JSON.stringify({ name: 'tn3270', type: 'module', main: 'main.js' }, null, 2));
writeFileSync(join(out, 'BUNDLED'), 'written by scripts/bundle.mjs; see src/appRoot.ts\n');
process.stdout.write(`bundled into ${out}\n`);
```

**Re-derive before trusting:** the list of preloads, pages and `src=` values against
`packages/gui/*.html` (the `connect.*` entries arrive in Task 9; until then omit them, and add
them in Task 9). The `index.html` renderer's imports (`blit.js`, `copyCache.js`, `forwardKeys.js`,
`keys.js`, `selection.js`) all get inlined. Check `app/package.json`'s `name` — electron-builder
uses `productName` from its own config (Task 12), so `tn3270` here only matters for `app.getName()`
and the user-data directory; check what `app.getName()` returns unbundled today and match it.

Root `package.json`: `"bundle:gui": "node packages/gui/scripts/bundle.mjs"`; add `esbuild`
(`^0.28.2`) to root `devDependencies`. `.gitignore`: `packages/gui/app/`, `artifacts/`.

- [ ] **Step 5: Run the bundle under Electron, by hand once**

```bash
npm run build && npm run bundle:gui
TN3270_GUI_REPLAY=packages/fixtures/traces/synthetic-ispf-like.trace TN3270_GUI_SHOT=/tmp/app-shot-$$.png \
  node -e "const {electron}=await import('./packages/gui/scripts/xvfb.mjs')" # (see Task 6; use xvfb.mjs's guiEnv)
```
Simplest correct route: implement Task 6 first if this is awkward, then run `shot.mjs` with
`TN3270_GUI_MAIN=app`. The pass condition is the same golden hash as the unbundled run.

- [ ] **Step 6: Gate, commit** — `git commit -m "gui: esbuild bundle into app/, one layout rule for both"`

---

### Task 6: Bundle parity — the goldens from `app/`

**Files:** Modify `packages/gui/scripts/xvfb.mjs`, `shot.mjs:35`, `keys.mjs:41`, `clicks.mjs:58`, `select.mjs:40`, `transfer.mjs:56`

- [ ] **Step 1:** In `xvfb.mjs` export

```js
/**
 * The GUI entry point a harness launches: the unbundled dist/main.js by default, the esbuild
 * bundle with TN3270_GUI_MAIN=app. Anything else is refused by name -- a typo silently testing
 * dist would report the bundle as proven.
 */
export function guiMain() {
  const which = process.env.TN3270_GUI_MAIN ?? 'dist';
  if (which === 'dist') return join(here, '..', 'dist', 'main.js');
  if (which === 'app') return join(here, '..', 'app', 'main.js');
  throw new Error(`TN3270_GUI_MAIN must be dist or app, not ${JSON.stringify(which)}`);
}
```

(define `here` in xvfb.mjs if absent). Replace each harness's `const main = join(here, '..', 'dist', 'main.js')`
with `const main = guiMain();`. Each harness's **staleness guard** (e.g. `keys.mjs:285`) compares
`dist` mtimes; for `app` it must compare `app/main.js` against the newest `src` too, or a stale
bundle passes (memory *harness-passes-on-stale-artifacts*). Extend the guard, do not skip it.

- [ ] **Step 2: Prove the guard and the selection work**

```bash
TN3270_GUI_MAIN=bogus node packages/gui/scripts/shot.mjs; echo $?   # non-zero, names the value
touch packages/gui/src/main.ts; TN3270_GUI_MAIN=app node packages/gui/scripts/shot.mjs; echo $?  # refuses: stale app
npm run bundle:gui
for h in shot keys clicks select transfer; do TN3270_GUI_MAIN=app node packages/gui/scripts/$h.mjs || echo "FAIL $h"; done
```
Expected: shot 2/2 matching the **existing** goldens (no `--update`), and every harness's
existing pass count (see `docs/HANDOFF.md` gate table: keys 25 chords/23 actions, clicks, select
3/3, transfer 10/10). Any difference is a bundling defect to fix, not a golden to update.

- [ ] **Step 3: Mutation check** — break the bundle (e.g. delete `app/atlas.bin`) and confirm
`shot.mjs` with `TN3270_GUI_MAIN=app` FAILS. Restore with `npm run bundle:gui`.

- [ ] **Step 4: Gate, commit** — `git commit -m "gui harnesses: TN3270_GUI_MAIN=app runs them against the bundle"`

---

### Task 7: Pack and install-smoke the plain-Node front ends

**Files:** Create `scripts/pack.mjs`, `scripts/install-smoke.mjs`; Modify root `package.json` (`pack`, `smoke`)

**Measure first:** npm resolves the tarballs' `@tn3270/*` dependencies against the registry,
where nothing is published yet. Installing **all tarballs in one `npm install` into a project
prefix** lets npm satisfy each dependency from a co-installed tarball. Verify that before
building on it:

```bash
npm run build && mkdir -p /tmp/packtest && for p in core frontend node-files canvas cli tui web; do (cd packages/$p && npm pack --pack-destination /tmp/packtest); done
d=$(mktemp -d) && (cd $d && npm init -y >/dev/null && npm install /tmp/packtest/*.tgz) && ls $d/node_modules/.bin
```
Expected: `tn3270`, `tn3270-cli`, `tn3270-web` in `.bin`, no registry 404. **If npm 404s on an
internal dependency**, switch the smoke to a throwaway local registry (`npx verdaccio@7` on a
random port, `npm publish --registry`), which also tests the real `npm install -g` path; record
which was needed in the script's header comment.

- [ ] **Step 1: `scripts/pack.mjs`** — runs `npm pack --pack-destination artifacts/npm` in each
non-private workspace (read the list from the manifests, the same way the manifest test does),
**after** `npm run bundle:gui` for gui; prints each tarball name. Deletes `artifacts/npm` first so
an old tarball cannot be installed.

- [ ] **Step 2: `scripts/install-smoke.mjs`** — structure:

```js
/**
 * Installs the packed tarballs into a FRESH temporary prefix and runs every executable BY NAME
 * through PATH -- never by file path -- so npm's symlinks (POSIX) and .cmd shims (Windows) are
 * what is tested. Each check must SEE its executable run; none passes because a file exists.
 *
 *   node scripts/install-smoke.mjs [--only cli,tui,web,gui]
 */
```

Checks (each prints `ok <name>` or `FAIL <name>: <why>`; exit 1 if any fail; print a final
`N/N` count):

1. `tn3270-cli --bogus` → exit 2, stderr contains `unrecognized argument`.
2. `tn3270-cli` with stdin `Replay(<repo>/packages/fixtures/traces/synthetic-ispf-like.trace)\nAscii()\nQuit()\n`
   → stdout contains `data:  MENU` and `OPTION ===>` (measured 2026-11-05: this works with no
   host argument). Pass the trace path as an absolute path. **This replaces the spec's "fake host"
   for the CLI**, because Replay exercises the installed core/frontend/cli end to end without a
   socket; note the deviation in the summary.
3. `tn3270 --bogus` → exit 2 (the TUI; before Task 1 this exited 0 silently).
4. `tn3270-web --listen 0 -insecure 127.0.0.1:1` → read stdout until `serving … at http://…/`,
   parse the URL, `GET /` → 200 HTML; `GET /ui.css` → 200 `text/css`; `GET` each of
   `/renderer.js`, `/bridge.js`, `/keypadView.js`, `/transferForm.js`, `/keymap.js` → 200. Kill by
   PID. (Check the web arg parser accepts `--listen 0` and a host it never dials until a browser
   says hello — read `packages/web/src/main.ts` `run()`.)
5. (Task 8 adds `gui`.)

On Windows, spawn with `shell: true` (a `.cmd` shim cannot be spawned directly) and quote nothing
the shell would mangle. Use `path.delimiter` to build `PATH`. Use `npm prefix`-relative
`node_modules/.bin` (project install) for the bin directory.

- [ ] **Step 3: Run it; then mutation-check it**

```bash
npm run build && node scripts/pack.mjs && node scripts/install-smoke.mjs --only cli,tui,web
```
Expected: `4/4` (or however many checks). Then temporarily revert Task 1's `isMain` in the TUI to
the old `file://` check, rebuild, re-pack, re-run: check 3 must FAIL. Restore. Then remove `static`
from web's `files`, re-pack: check 4 must FAIL. Restore.

- [ ] **Step 4: Gate, commit** — `git commit -m "scripts: pack and install-smoke from tarballs through PATH"`

---

### Task 8: `tn3270-gui` launcher and its smoke check

**Files:** Replace stub `packages/gui/bin/tn3270-gui.mjs`; Modify `scripts/install-smoke.mjs`

- [ ] **Step 1: Implement**

```js
#!/usr/bin/env node
/**
 * `tn3270-gui`: runs the bundled app (../app/main.js) under the Electron that npm installed
 * beside it, with the user's arguments.
 *
 * WHY NOT `electron`'s OWN BIN: that wrapper orphaned the real binary on SIGKILL in this repo's
 * harnesses (memory note electron-harness-leaks-look-like-regressions). This one forwards
 * SIGINT/SIGTERM/SIGHUP, kills the child if the launcher itself exits, and exits with the
 * child's code -- or re-raises its signal, so a shell sees the same death the app had.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = createRequire(import.meta.url)('electron'); // the binary's path, in Node
const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'main.js');
const child = spawn(electron, [main, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: false });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { if (!child.killed) child.kill(sig); });
}
process.on('exit', () => { if (child.exitCode === null && !child.killed) child.kill('SIGTERM'); });
child.on('error', (err) => { process.stderr.write(`tn3270-gui: cannot start Electron: ${err.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => {
  if (signal !== null) { process.removeAllListeners(signal); process.kill(process.pid, signal); }
  else process.exit(code ?? 1);
});
```

On Windows `SIGHUP` registration is allowed; `process.kill(pid, signal)` re-raise is a no-op-ish
— check behaviour there in CI and fall back to `process.exit(1)` if it throws.

- [ ] **Step 2: Add the gui smoke check** to `install-smoke.mjs`:

`tn3270-gui --no-sandbox --disable-gpu -insecure -model 3278-2-E 127.0.0.1:1` with
`TN3270_GUI_REPLAY=<repo>/packages/fixtures/traces/synthetic-ispf-like.trace` and
`TN3270_GUI_SHOT=<fresh mkdtemp path>/shot.png`; on Linux without `DISPLAY`, use `ensureDisplay()`
/ `guiEnv()` from `packages/gui/scripts/xvfb.mjs` (in CI, install `xvfb` via apt and run under
`xvfb-run` instead — the `xvfb.mjs` micromamba path is this dev box's). Pass conditions: exit 0,
stdout has `shot: <that path> WxH`, the `.sha256` file exists, and the bitmap is **not blank**:
compare its hash with the hash of an all-black bitmap of the same size, or better, assert it
equals the `synthetic-ispf` golden hash from `packages/gui/test/golden/` (same argv as `shot.mjs`
case 1 — re-read shot.mjs for its exact argv and env, then that is the strongest check available).

Electron's npm `postinstall` downloads the binary: the smoke run needs the network for that one
download (or `ELECTRON_MIRROR`/cache — CI caches `~/.cache/electron`).

- [ ] **Step 3: Run, mutation-check** (rename `app/atlas.bin` before packing → gui check FAILS),
gate, commit — `git commit -m "gui: tn3270-gui launcher, smoke-tested from the tarball"`

---

### Task 9: `dialogToArgv` — the connect form, as the command line the user would have typed

**Files:** Create `packages/gui/src/connectForm.ts`, `packages/gui/test/connectForm.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from 'vitest';
import { dialogToArgv } from '../src/connectForm.js';
import { parseGuiArgs, UsageError } from '../src/args.js';

describe('dialogToArgv', () => {
  it('a plain host with TLS on is the host, the model, and no -insecure', () => {
    expect(dialogToArgv({ host: 'vm.example:3270', model: '3278-2-E', tls: true }, []))
      .toEqual(['-model', '3278-2-E', 'vm.example:3270']);
  });

  it('TLS off adds -insecure', () => {
    expect(dialogToArgv({ host: '127.0.0.1:3271', model: '3278-4-E', tls: false }, []))
      .toEqual(['-insecure', '-model', '3278-4-E', '127.0.0.1:3271']);
  });

  it('keeps the real command line\'s non-host flags, and lets the form\'s model win', () => {
    expect(dialogToArgv({ host: 'h', model: '3278-2-E', tls: true }, ['-scheme', 'green', '-model', '3278-5']))
      .toEqual(['-scheme', 'green', '-model', '3278-2-E', 'h']);
  });

  it('trims the host, and passes LU and prefix specs through untouched', () => {
    const argv = dialogToArgv({ host: '  L:LUA,LUB@host:992 ', model: '3278-2-E', tls: true }, []);
    expect(argv.at(-1)).toBe('L:LUA,LUB@host:992');
    expect(parseGuiArgs(argv).lus).toEqual(['LUA', 'LUB']);
  });

  it('an empty host is refused BY parseGuiArgs, not by a second validator', () => {
    expect(() => parseGuiArgs(dialogToArgv({ host: '   ', model: '3278-2-E', tls: true }, [])))
      .toThrow(UsageError);
  });

  it('a contradiction the parser catches surfaces as its own message', () => {
    expect(() => parseGuiArgs(dialogToArgv({ host: 'L:host', model: '3278-2-E', tls: false }, [])))
      .toThrow(/-insecure disables TLS/);
  });
});
```

- [ ] **Step 2: FAIL.**

- [ ] **Step 3: Implement**

```ts
/**
 * The connect dialog's form, turned into the argv the user would have typed.
 *
 * ONE PARSER: the result goes through `parseGuiArgs` exactly as a real command line does, so
 * the dialog cannot accept a host the command line refuses or refuse one it accepts. This
 * function validates NOTHING -- an empty host becomes no host argument, and `parseGuiArgs`
 * says what is wrong in the words it always uses.
 */
export interface ConnectForm {
  readonly host: string;
  readonly model: string;
  readonly tls: boolean;
}

/** Flags the form owns; a copy on the real command line is dropped so the form's choice wins. */
const OWNED_WITH_VALUE = new Set(['-model']);
const OWNED_BARE = new Set(['-insecure']);

export function dialogToArgv(form: ConnectForm, commandLine: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < commandLine.length; i++) {
    const a = commandLine[i]!;
    if (OWNED_WITH_VALUE.has(a)) { i++; continue; }
    if (OWNED_BARE.has(a)) continue;
    kept.push(a);
  }
  const host = form.host.trim();
  return [
    ...kept,
    ...(form.tls ? [] : ['-insecure']),
    '-model', form.model,
    ...(host === '' ? [] : [host]),
  ];
}
```

Check against the tests: test 3 expects `['-scheme','green','-model','3278-2-E','h']` — kept
flags first, then the form's. Test 2 expects `-insecure` before `-model` with no kept flags —
consistent. **Check `-insecure`'s exact spelling and whether other TLS flags (`-noverifycert`,
`-cafile`) on the command line should survive** — they should (kept), and a `-cafile` with TLS
unticked becomes a contradiction `resolveTls` reports, which is correct.

The commandLine passed in is argv **with the host absent** (that's when the dialog appears), so
nothing positional needs stripping — but if a future caller passes a host, it would be kept and
`parseGuiArgs` reports "more than one host given", which is the right failure.

- [ ] **Step 4: PASS, gate, commit** — `git commit -m "gui: dialogToArgv, the connect form as a command line"`

---

### Task 10: The connect dialog window, and startup without a host

**Files:**
- Create: `packages/gui/connect.html`, `packages/gui/src/connectBoot.ts`, `packages/gui/src/connectPreload.cts`
- Modify: `packages/gui/src/main.ts` (startup at ~line 420-432; `explain` at ~326), `packages/frontend/src/tls.ts:145`, `packages/frontend/test/tls.test.ts`, `packages/gui/test/uiAssets.test.ts` (`DOCUMENTS`), `packages/gui/scripts/bundle.mjs` (add connect page + preload)

**Read first:** `transfer.html`, `transferBoot.ts`, `transferPreload.cts` and `main.ts`'s
`openTransferWindow` (~line 739-870) — the dialog follows that pattern exactly: contextIsolation,
`.cjs` preload exposing a tiny API, console/`did-fail-load` forwarding, `ui.css`.

**Behaviour:**
1. After `win.loadFile(layout.document('index.html'))`, compute
   `const argv = process.argv.slice(2).filter(not ELECTRON_SWITCHES)`. **If `argv` contains no
   positional argument** (no element that doesn't start with `-` and isn't a flag's value — use
   `parseGuiArgs` itself: it throws `UsageError(USAGE)` exactly when the host is missing; add an
   exported `MissingHostError extends UsageError` thrown at `args.ts`'s `if (args.host === undefined)`
   so main can tell that case from every other usage error), and no test seam is set
   (`SEAM.replay`, `SEAM.url`), open the dialog.
2. The dialog is **modal** over the terminal window (`parent: win, modal: true`), 420×220, title
   `Connect`. Fields: Host (text, autofocus, placeholder `host:port`), Model (`<select>` from
   `KNOWN_MODELS`' keys, default `3278-2-E`), TLS (checkbox, checked), buttons Connect (default,
   Enter) and Quit (Escape). An error line under the fields (`role="alert"`).
3. Connect → preload `invoke('connect:submit', form)` → main runs
   `parseGuiArgs(dialogToArgv(form, argv))`. On `UsageError`, return `{ error: message }` and the
   dialog shows it, keeping focus in Host. On success return `{ ok: true }`, close the dialog,
   and continue the **existing** startup path with those `args` — refactor the code after
   `args = parseGuiArgs(argv)` (line ~428 onward) into `startSession(args, launchedFromDialog)` so
   both routes call one function.
4. Quit, Escape, or closing the dialog → `app.quit()`.
5. If the connect then fails, the failure goes through `fail(explain(err, …))` as today. For a
   dialog launch, TLS remedies must name the checkbox, not the flag:
   `describeTlsError(code, host, port, remedy?: 'flag' | 'dialog')`, default `'flag'`; with
   `'dialog'`, `use -insecure` becomes `untick TLS in the Connect dialog`. **Put the remedy first**
   where the message is shown in a fixed-width line (memory *fixed-width-messages-lose-their-point*).
   Add tests in `packages/frontend/test/tls.test.ts` for both variants of `HANDSHAKE_TIMEOUT` and
   `ERR_SSL_WRONG_VERSION_NUMBER`, and one asserting the default is unchanged.
6. After a failed connect from the dialog, the dialog does **not** reopen (that is milestone B's
   File › Connect…); the window shows the error as it does today. State this in the README.

- [ ] **Step 1:** Add `MissingHostError` + test in `packages/gui/test/args.test.ts`
(`parseGuiArgs([])` and `parseGuiArgs(['-insecure'])` throw `MissingHostError`; `parseGuiArgs(['--bogus'])`
throws a `UsageError` that is NOT a `MissingHostError`). Run → FAIL → implement → PASS.
- [ ] **Step 2:** `describeTlsError` remedy variant, tests first, then implement.
- [ ] **Step 3:** `connect.html` / `connectPreload.cts` / `connectBoot.ts`; add `connect.html` to
`uiAssets.test.ts`'s `DOCUMENTS` (that test checks every `src`/`href` resolves).
- [ ] **Step 4:** `main.ts`: `startSession` extraction (pure move first, commit it alone with the
full gate green and the shot/keys harnesses unchanged — a refactor commit separate from the
feature), then the dialog branch and the `connect:submit` handler. Register the handler only on
the dialog path (registration-once rule at `main.ts:727`).
- [ ] **Step 5:** add `connect` to `bundle.mjs`'s `PAGES` and preloads; `npm run bundle:gui`.
- [ ] **Step 6:** Gate (full), plus every GUI harness unbundled **and** with `TN3270_GUI_MAIN=app`
— nothing that passes a host may change. Commit.

---

### Task 11: `connect.mjs` — the dialog harness

**Files:** Create `packages/gui/scripts/connect.mjs`; Modify `packages/gui/src/main.ts` (a dialog test seam)

**Seam:** `TN3270_GUI_CONNECT='{"host":"…","model":"…","tls":false}'` — when set and the dialog
opens, main fills the dialog's fields **through the DOM** (`webContents.executeJavaScript` setting
the inputs' values and clicking Connect), so the boot file's real submit path runs. Print
`connect: dialog shown`, then `connect: submitted`, then either `connect: error <msg>` (from the
dialog's error line, read back from the DOM) or nothing. Add it to the `SEAM` object with the
"empty string means absent" rule.

**Cases** (each launches with **no host argument**):

1. **Connects:** start a `net.createServer` on port 0 that records `connection` events and the
   first bytes received; form `{host:"127.0.0.1:<port>", model:"3278-2-E", tls:false}`. Pass: the
   server saw a connection within 5 s. (A plaintext telnet client sends nothing until the host
   negotiates, so assert the **connection**, not bytes.)
2. **Bad host stays open:** form `{host:"", …}`. Pass: `connect: error` line contains the
   `parseGuiArgs` usage text (`usage: tn3270-gui`), the process is **still running** 1 s later,
   and the server saw no connection. Then kill by PID.
3. **TLS remedy names the checkbox:** server that accepts and stays silent; form with `tls:true`.
   Pass: the window's error (captured via the existing `error-message` path — check how `fail()`
   reaches stdout; `process.stderr.write` is the line to read) contains `untick TLS`. Allow for
   the handshake timeout (read `HANDSHAKE_TIMEOUT`'s value in `frontend/src/tls.ts`).
4. **A host on the command line skips the dialog:** with a host argument and the seam set, pass
   when `connect: dialog shown` is **absent** and the server sees a connection.

Run under `TN3270_GUI_MAIN=dist` and `=app`. Mutation-check: make main ignore the form's TLS
choice (always TLS) → case 1 fails (TLS client against a silent plaintext server never
connects as telnet — confirm it fails; if it doesn't, the assertion is too weak, strengthen it).

- [ ] Steps: write harness; run → it fails before the seam exists; add the seam; run 4/4 on
both layouts; mutation; gate; commit `gui: connect.mjs harness for the startup dialog`.

---

### Task 12: Native artifacts with electron-builder

**Files:** Create `packages/gui/electron-builder.yml`, `packages/gui/build/icon.png` (see below); Modify root `package.json` (`package:gui`, devDependency `electron-builder@^26.18.0`)

```yaml
# packages/gui/electron-builder.yml
appId: io.github.athornton.tn3270
productName: TN3270
directories:
  app: app            # the esbuild bundle: NO node_modules is collected
  output: ../../artifacts/gui
  buildResources: build
electronVersion: 44.3.0
asar: true
files: ["**/*"]
mac:
  target:
    - { target: dmg, arch: universal }
    - { target: zip, arch: universal }
  category: public.app-category.developer-tools
  identity: null       # UNSIGNED this milestone (spec): skip signing explicitly
linux:
  target: [AppImage, deb]
  category: Network
  maintainer: Adam Thornton <athornton@gmail.com>
win:
  target: [nsis]
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
```

Check against electron-builder 26's docs, not memory: that `directories.app` pointing at a
directory with its own `package.json` (written by `bundle.mjs`) makes it skip dependency
collection; whether `electronVersion` is needed when Electron is not in that `package.json` (it
is required then); the `universal` arch spelling; `identity: null` vs `CSC_IDENTITY_AUTO_DISCOVERY=false`.
The `app/package.json` will need `version` (copy from the gui manifest in `bundle.mjs`) and
`description`/`author` for the `.deb`.

**Icon:** none exists. Generate a simple 1024×1024 PNG at build time from the atlas — e.g. the
glyphs `3270` in green on black via `canvas` atlas blitting into a PNG with `zlib` — or ask the
user for one. **Ask the user**; until then, electron-builder's default icon is acceptable and the
summary must say so.

Root scripts:
`"package:gui": "npm run bundle:gui && cd packages/gui && electron-builder --publish never"`;
`"package": "npm run build && npm run bundle:gui && node scripts/pack.mjs && node scripts/install-smoke.mjs && npm run package:gui"`.

- [ ] **Step 1:** Build Linux artifacts here: `npm run package:gui`. Expected: an AppImage and a
`.deb` in `artifacts/gui/`.
- [ ] **Step 2:** Launch the AppImage with the replay seam and `TN3270_GUI_SHOT` under Xvfb
(AppImage needs FUSE; if FUSE is absent here, run it with `--appimage-extract-and-run`), with the
same argv as `shot.mjs` case 1. Pass: the golden hash. Extract the `.deb` (`dpkg-deb -x`) and run
its binary the same way.
- [ ] **Step 3:** Launch the AppImage with **no arguments** and the `TN3270_GUI_CONNECT` seam
from Task 11 case 1. Pass: the server sees a connection. This is the double-click route.
- [ ] **Step 4:** Gate, commit `gui: electron-builder config for dmg/zip (universal), AppImage, deb, nsis`.

---

### Task 13: Packaged-app smoke, every OS

**Files:** Create `scripts/package-smoke.mjs`

For the host OS's artifact in `artifacts/gui/`, launch the packaged executable directly (macOS:
`TN3270.app/Contents/MacOS/TN3270` from the `.zip`, extracted with `ditto -x -k`; Linux: AppImage
with `--appimage-extract-and-run`; Windows: run the NSIS installer silently with `/S /D=<tmp>`,
then `<tmp>\TN3270.exe`), with the shot.mjs case-1 argv, replay seam and a **fresh** shot path.
Pass: golden hash. Then the Task 12 Step 3 dialog check.

**macOS both slices:** run once natively and once as `arch -x86_64 <exe>`; both must hit the
golden. Before that, `lipo -archs <exe>` must print both `x86_64` and `arm64`. If Rosetta is not
installed on the runner (`arch -x86_64 /usr/bin/true` fails), the script must FAIL with
`x64 slice NOT tested: no Rosetta on this runner`, never skip silently (spec). If an Intel runner
exists in the matrix (Task 0), run natively there instead and drop the Rosetta step on it.

**Golden caveat:** goldens were recorded on Linux under Xvfb. macOS/Windows font rasterization
does not apply (the atlas is ours), but **device scale factor** may — a Retina display or Windows
DPI scaling changes the bitmap size. Check what `shot.mjs` does about scale; if the hash cannot
match off Linux, the off-Linux pass condition becomes: correct expected size **and** not equal to
an all-black bitmap, and the summary must say the golden is Linux-only. Measure in CI first; do
not pre-decide.

- [ ] Steps: write, run on Linux here, commit; CI covers the rest (Task 14).

---

### Task 14: The full CI workflow

**Files:** Modify `.github/workflows/package.yml`

Replace Task 0's body:

```yaml
name: package
on:
  push: { branches: [main, packaging] }
  pull_request:
  workflow_dispatch:
jobs:
  package:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: ubuntu-latest,     parity: true }
          - { os: ubuntu-24.04-arm,  parity: false }
          - { os: macos-latest,      parity: false }
          - { os: windows-latest,    parity: false }
    runs-on: ${{ matrix.os }}
    env:
      CSC_IDENTITY_AUTO_DISCOVERY: 'false'
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - uses: actions/cache@v4
        with:
          path: |
            ~/.cache/electron
            ~/.cache/electron-builder
            ~/Library/Caches/electron
            ~/Library/Caches/electron-builder
            ~/AppData/Local/electron/Cache
            ~/AppData/Local/electron-builder/Cache
          key: electron-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y xvfb libfuse2t64
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npx vitest run
      - run: npm run bundle:gui
      - run: node scripts/pack.mjs
      - name: install smoke
        shell: bash
        run: ${{ runner.os == 'Linux' && 'xvfb-run -a ' || '' }}node scripts/install-smoke.mjs
      - if: matrix.parity
        name: bundle parity
        run: |
          for h in shot keys clicks select transfer connect; do
            TN3270_GUI_MAIN=app xvfb-run -a node packages/gui/scripts/$h.mjs
          done
      - run: npm run package:gui
      - name: packaged-app smoke
        shell: bash
        run: ${{ runner.os == 'Linux' && 'xvfb-run -a ' || '' }}node scripts/package-smoke.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: tn3270-${{ matrix.os }}
          path: |
            artifacts/npm/*.tgz
            artifacts/gui/*.dmg
            artifacts/gui/*.zip
            artifacts/gui/*.AppImage
            artifacts/gui/*.deb
            artifacts/gui/*.exe
          if-no-files-found: error
```

Check: the GUI harnesses use `xvfb.mjs`'s micromamba Xvfb when `DISPLAY` is unset — under
`xvfb-run` `DISPLAY` is set, so `ensureDisplay()` returns early; confirm by reading it. Linux arm
runners: `libfuse2t64` package name on 24.04. Upload npm tarballs from one job only if duplicate
names collide across jobs (they're in separately-named artifacts, so they don't). Any
platform-skip from Task 0b stays in force.

- [ ] Steps: write; **ask the user before pushing**; push; watch with `/usr/bin/gh run watch`;
fix failures one at a time with systematic debugging (never by loosening a check); record the
green run's URL and per-job counts in HANDOFF; commit.

---

### Task 15: Docs

**Files:** Create `docs/releasing.md`; Modify `README.md` (top status paragraph at line 26, *Remaining* item 13, a new *Installing* section), `docs/HANDOFF.md`

- [ ] `docs/releasing.md`: prerequisites (npm login with publish rights on `@tn3270`; 2FA);
`npm run version:set -- X.Y.Z && npm install`; commit and tag; take tarballs from the green CI
run (or `npm run build && node scripts/pack.mjs`); publish **in dependency order**: core,
frontend, node-files, canvas, then cli, tui, web, gui — `npm publish artifacts/npm/<file>.tgz`
(`publishConfig.access` already public). Verify: on a clean machine,
`npm install -g @tn3270/tui && tn3270 --bogus` exits 2. Note the unsigned-app instructions
(macOS right-click → Open or `xattr -d com.apple.quarantine /Applications/TN3270.app`; Windows
SmartScreen *More info → Run anyway*). Note tag-triggered publishing waits for npm trusted publishing.
- [ ] README *Installing*: the four `npm install -g` lines and commands; the native downloads
(from the CI run's artifacts until there is a release page); **the minimum macOS**, read from
Electron 44's release notes / `electron/electron` docs (`docs/tutorial/support.md`) — state the
source; the double-click dialog and that it does not reopen after a failed connect. Update line 26's
"There is no packaging" paragraph and item 13. Update *every* summary line that mentions packaging
as future (memory *summary-lines-outlive-their-corrections*: `grep -n -i packag README.md docs/HANDOFF.md`).
- [ ] HANDOFF: START HERE rewritten for the new state; the gate table gains install-smoke,
package-smoke, connect.mjs, and the CI run.
- [ ] Commit. Then **stop and report to the user**: what was verified where, what is owed live
(macOS by hand — Gatekeeper path; Windows installer on the user's machine; Raspberry Pi arm64
AppImage/.deb; the dialog by double-click on each), and the merge question (merging is the
user's call).

---

## Self-review notes (done at writing time)

- **Spec coverage:** npm packages + `files`/engines/etc. (T3); lockstep (T4); shebang + isMain (T1);
  CLI main check (verified: `cli/src/main.ts` calls `main()` unconditionally, correct for a bin;
  `cli/test/*.test.ts` import `parseArgs` from it — **that already runs `main()` under vitest**
  and has been harmless; leave it, out of scope, but mention it in T1's summary); launcher (T8);
  native artifacts incl. universal mac and Linux arm64 (T12, T14); dialog (T9–T11); TLS remedy
  (T10); unit/manifest tests (T1, T3, T9); install smoke (T7, T8); bundle parity (T6); CI (T0,
  T14); risk measured first (T0); releasing.md + macOS floor (T15). Added beyond spec: web
  path fix (T2), found while planning.
- **Deviation from spec:** the CLI smoke uses `Replay()` of a fixture, not a fake host (T7).
- **Types:** `ConnectForm {host, model, tls}`, `dialogToArgv(form, commandLine)`, `layoutFor(dir)
  → Layout {bundled, document, preload, atlasDir}`, `isMain(metaUrl, argv1?)`,
  `setVersion(rootDir, version)`, `MissingHostError extends UsageError`,
  `describeTlsError(code, host, port, remedy?)` — used consistently across tasks.
