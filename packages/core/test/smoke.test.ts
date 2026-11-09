import { describe, it, expect } from 'vitest';
import { VERSION } from '../src/index.js';

describe('core package', () => {
  it('exports a version string', () => {
    // The SHAPE, not one release's value: `scripts/set-version.mjs` rewrites VERSION but not this
    // file, and a literal here broke the 0.1.1 bump (2026-11-09). That VERSION equals the root
    // manifest's version is manifests.test.ts's job.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
