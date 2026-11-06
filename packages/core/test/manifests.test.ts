import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/index.js';

const packagesDir = fileURLToPath(new URL('../../', import.meta.url)); // packages/
interface Manifest {
  name: string; version: string; private?: boolean; files?: string[];
  bin?: Record<string, string>; engines?: { node?: string };
  publishConfig?: { access?: string }; repository?: unknown; description?: string;
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string>;
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
      for (const field of ['dependencies', 'devDependencies'] as const) {
        for (const [dep, range] of Object.entries(m[field] ?? {})) {
          if (dep.startsWith('@tn3270/')) expect(range, `${m.name} -> ${dep}`).toBe(v);
        }
      }
    }
  });

  // Task 4's bump script edits every manifest's version field; this line is the one thing that
  // is NOT a manifest field, so a bump that misses it would otherwise pass the test above.
  it('core/src/index.ts VERSION matches the root version', () => {
    expect(VERSION).toBe(root.version);
  });

  // electron-builder.cjs reads `electronVersion` from this field; a range there would hand the
  // builder a range, and the packaged Electron could differ from the one the harnesses test.
  it("gui's electron dependency is an exact version", () => {
    const gui = manifests.find(({ m }) => m.name === '@tn3270/gui')!.m;
    expect(gui.dependencies?.['electron']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('no published package depends on @tn3270/fixtures', () => {
    for (const { m } of published) expect(m.dependencies?.['@tn3270/fixtures'], m.name).toBeUndefined();
  });

  it('every bin source starts with a shebang, and its target is under a shipped directory', () => {
    for (const { dir, m } of published) {
      for (const [name, target] of Object.entries(m.bin ?? {})) {
        const top = target.replace(/^\.\//, '').split('/')[0]!;
        expect(m.files, `${name}: ${target} is not shipped`).toContain(top);
        const source = top === 'dist'
          ? join(packagesDir, dir, target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'))
          : join(packagesDir, dir, target);
        expect(readFileSync(source, 'utf8').startsWith('#!/usr/bin/env node'), `${name}: ${source}`).toBe(true);
      }
    }
  });

  it('names the four executables', () => {
    const bins = Object.assign({}, ...published.map(({ m }) => m.bin ?? {}));
    expect(Object.keys(bins).sort()).toEqual(['tn3270', 'tn3270-cli', 'tn3270-gui', 'tn3270-web']);
  });
});
