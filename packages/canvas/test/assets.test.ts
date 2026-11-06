import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_FILES, isCanvasSourceDist, readAtlas } from '../src/assets.js';

/**
 * `readAtlas`'s missing-atlas message must fit WHERE it looked.
 *
 * The rebuild-canvas hint is right for canvas's own `dist` and wrong for a bundled or installed
 * GUI, which passes its own directory and has no canvas package to rebuild. Each layout is built
 * in a temp directory, so no test deletes this tree's own built atlas.
 */

/** A temp `root/<pkgDir>/<sub>` with `package.json` named `name`, and `src/` when `withSrc`. */
function layout(name: string, sub: string, withSrc: boolean): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'atlas-layout-'));
  const pkg = join(root, 'pkg');
  mkdirSync(join(pkg, sub), { recursive: true });
  if (withSrc) mkdirSync(join(pkg, 'src'));
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name }));
  return { root, dir: join(pkg, sub) };
}

describe('readAtlas: which hint, by layout', () => {
  const cases = [
    { what: "canvas's dist in a source checkout", name: '@tn3270/canvas', sub: 'dist', src: true, rebuild: true },
    { what: 'an INSTALLED canvas (dist, no src)', name: '@tn3270/canvas', sub: 'dist', src: false, rebuild: false },
    { what: "the GUI bundle's app/ (assets.ts inlined there)", name: '@tn3270/gui', sub: 'app', src: false, rebuild: false },
    { what: "the GUI bundle's app/ in a checkout", name: '@tn3270/gui', sub: 'app', src: true, rebuild: false },
    { what: "another package's dist", name: '@tn3270/gui', sub: 'dist', src: true, rebuild: false },
  ];
  for (const c of cases) {
    it(`${c.what}: ${c.rebuild ? 'rebuild canvas' : 'install incomplete'}`, () => {
      const { root, dir } = layout(c.name, c.sub, c.src);
      try {
        expect(isCanvasSourceDist(dir)).toBe(c.rebuild);
        expect(() => readAtlas(dir)).toThrow(c.rebuild
          ? '@tn3270/canvas has not been built: run npm run build -w @tn3270/canvas'
          : `the glyph atlas is missing from ${dir}: this install is incomplete`);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  it("this checkout's own canvas dist counts as a source dist", () => {
    expect(isCanvasSourceDist(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'))).toBe(true);
  });
});
describe('readAtlas', () => {
  it('names the directory, and not a canvas rebuild, when given a directory of its own', () => {
    const d = mkdtempSync(join(tmpdir(), 'atlas-'));
    try {
      expect(() => readAtlas(d)).toThrow(`the glyph atlas is missing from ${d}: this install is incomplete`);
      expect(() => readAtlas(d)).not.toThrow(/npm run build/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('ATLAS_FILES names the two files build-atlas.mjs writes', () => {
    // The bake script cannot import the compiled constant (it runs before/independently of tsc's
    // output being trusted), so this is the check that its spelling and the constant agree.
    const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-atlas.mjs'), 'utf8');
    for (const f of Object.values(ATLAS_FILES)) expect(script).toContain(`'${f}'`);
  });
});
