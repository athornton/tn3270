import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { layoutFor } from '../src/appRoot.js';

/**
 * The two places `main.js` can run from, and where each one finds its documents, preloads and atlas.
 *
 * Both cases build a REAL directory rather than mocking `existsSync`, because the rule is "a
 * marker file on disk decides", and a mock would test the mock. The unbundled case deliberately
 * names its main directory `dist` and the bundled case does NOT name it `app` -- the layout must
 * follow the marker, never the directory's name, which an asar path (`.../app.asar`) would defeat.
 */
describe('layoutFor', () => {
  it('unbundled: documents beside dist, preloads in dist, atlas from canvas', () => {
    const d = mkdtempSync(join(tmpdir(), 'approot-'));
    try {
      mkdirSync(join(d, 'dist'));
      const l = layoutFor(join(d, 'dist'));
      expect(l.bundled).toBe(false);
      expect(l.document('index.html')).toBe(join(d, 'index.html'));
      expect(l.preload('preload.cjs')).toBe(join(d, 'dist', 'preload.cjs'));
      expect(l.atlasDir).toBeUndefined();
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

  it('a BUNDLED marker in the PARENT does not make dist bundled', () => {
    // The marker is looked for beside main.js and nowhere else: a stray `BUNDLED` one level up
    // (say, someone copying app/ over packages/gui/) must not flip the unbundled build's lookups.
    const d = mkdtempSync(join(tmpdir(), 'approot-'));
    try {
      mkdirSync(join(d, 'dist'));
      writeFileSync(join(d, 'BUNDLED'), '');
      expect(layoutFor(join(d, 'dist')).bundled).toBe(false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
