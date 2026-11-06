import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATLAS_FILES, readAtlas } from '../src/assets.js';

/**
 * `readAtlas`'s missing-atlas message must fit WHERE it looked.
 *
 * The rebuild-canvas hint is right for canvas's own `dist` and wrong for a bundled or installed
 * GUI, which passes its own directory and has no canvas package to rebuild. Only the foreign
 * directory is tested here: the own-`dist` case would need deleting a built atlas mid-suite.
 */
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
