import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setVersion } from '../../../scripts/set-version.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('setVersion', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  /**
   * Builds a minimal copy of the parts of the real tree `setVersion` touches:
   * the root manifest, a couple of workspace manifests (one with an internal
   * dep to bump, one with a non-internal dep that must survive untouched),
   * and core's `src/index.ts`. `cpSync` of a single file into a directory
   * that does not exist yet fails, so each destination directory is made
   * first.
   */
  function fixture(): string {
    dir = mkdtempSync(join(tmpdir(), 'set-version-'));
    const root = dir;
    cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));

    for (const pkg of ['cli', 'gui', 'core']) {
      mkdirSync(join(root, 'packages', pkg), { recursive: true });
      cpSync(
        join(repoRoot, 'packages', pkg, 'package.json'),
        join(root, 'packages', pkg, 'package.json'),
      );
    }
    mkdirSync(join(root, 'packages', 'core', 'src'), { recursive: true });
    cpSync(
      join(repoRoot, 'packages', 'core', 'src', 'index.ts'),
      join(root, 'packages', 'core', 'src', 'index.ts'),
    );
    return root;
  }

  function readJson(root: string, ...parts: string[]): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, ...parts), 'utf8'));
  }

  /** Every regular file under `root`, as path (relative to root) -> raw content. */
  function snapshot(root: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.set(p.slice(root.length), readFileSync(p, 'utf8'));
      }
    };
    walk(root);
    return files;
  }

  it('sets root, cli and gui versions, and bumps cli\'s internal dep but not gui\'s electron pin', () => {
    const root = fixture();
    const before = readJson(root, 'packages', 'gui', 'package.json');
    const electronBefore = (before.dependencies as Record<string, string>).electron;

    const written = setVersion(root, '0.2.0');

    expect(readJson(root, 'package.json').version).toBe('0.2.0');
    expect(readJson(root, 'packages', 'cli', 'package.json').version).toBe('0.2.0');
    expect(readJson(root, 'packages', 'gui', 'package.json').version).toBe('0.2.0');

    const cliDeps = readJson(root, 'packages', 'cli', 'package.json').dependencies as Record<string, string>;
    expect(cliDeps['@tn3270/core']).toBe('0.2.0');

    const guiDeps = readJson(root, 'packages', 'gui', 'package.json').dependencies as Record<string, string>;
    expect(guiDeps.electron).toBe(electronBefore);
    expect(guiDeps.electron).not.toBe('0.2.0');

    // root + cli + gui + core manifests, plus core/src/index.ts
    expect(written).toBe(5);
  });

  it("rewrites core's VERSION literal in src/index.ts", () => {
    const root = fixture();
    setVersion(root, '0.2.0');
    const indexTs = readFileSync(join(root, 'packages', 'core', 'src', 'index.ts'), 'utf8');
    expect(indexTs).toContain("export const VERSION = '0.2.0';");
    expect(indexTs).not.toContain("'0.1.0'");
  });

  it('throws mentioning "semver" on a non-semver version', () => {
    const root = fixture();
    expect(() => setVersion(root, 'v1')).toThrow(/semver/);
    expect(() => setVersion(root, '1.2')).toThrow(/semver/);
  });

  it('accepts a prerelease version', () => {
    const root = fixture();
    expect(() => setVersion(root, '0.2.0-rc.1')).not.toThrow();
    expect(readJson(root, 'package.json').version).toBe('0.2.0-rc.1');
  });

  it('throws if the VERSION literal is missing from index.ts, rather than silently skipping it', () => {
    const root = fixture();
    writeFileSync(join(root, 'packages', 'core', 'src', 'index.ts'), "export const NOT_VERSION = '0.1.0';\n");
    expect(() => setVersion(root, '0.2.0')).toThrow(/VERSION/);
  });

  it('throws if a manifest has no "version" field, rather than silently skipping it', () => {
    const root = fixture();
    writeFileSync(join(root, 'packages', 'cli', 'package.json'), JSON.stringify({ name: '@tn3270/cli' }));
    expect(() => setVersion(root, '0.2.0')).toThrow(/version/);
  });

  // Regression: a first implementation wrote each file as it validated it, so an error partway
  // through the loop (root and some packages already rewritten, a later one malformed) left the
  // tree half-bumped -- exactly the state the exact-pin internal deps cannot tolerate. Reproduced
  // by breaking the LAST manifest the function would reach (gui, written after cli and core in
  // `manifestPaths`) and confirming every file on disk, not just the broken one, is untouched:
  // every rewrite must be computed and validated before any file is written.
  it('leaves every file byte-identical when one manifest (even the last one visited) is bad', () => {
    const root = fixture();
    writeFileSync(join(root, 'packages', 'gui', 'package.json'), JSON.stringify({ name: '@tn3270/gui' }));
    const before = snapshot(root);

    expect(() => setVersion(root, '0.2.0')).toThrow(/version/);

    const after = snapshot(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, content] of before) {
      expect(after.get(path), path).toBe(content);
    }
  });
});
