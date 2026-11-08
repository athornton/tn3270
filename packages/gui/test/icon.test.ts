import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutFor } from '../src/appRoot.js';
import { ICON_SOURCE, LINUX_ICON_DIR, LINUX_ICON_SIZES } from '../scripts/bundleVerify.mjs';

/**
 * The application icon: one tracked PNG feeding the window icon and every installer's icon.
 *
 * Nothing at runtime notices a missing or wrong icon -- Electron falls back to its own, and so
 * does electron-builder's search when the configured name is not found -- so each link of the
 * chain is pinned here: the file's shape, the builder configuration naming it, the unbundled
 * layout reaching it, and every window passing it.
 */
const gui = dirname(dirname(fileURLToPath(import.meta.url)));

/** The PNG at `rel` (under packages/gui) is n x n, 8-bit RGBA, read from its IHDR. */
function expectRgbaPng(rel: string, n: number): void {
  const png = readFileSync(join(gui, rel));
  expect(png.subarray(0, 8), rel).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString('latin1'), rel).toBe('IHDR');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)], rel).toEqual([n, n]);
  expect(png[24], `${rel} bit depth`).toBe(8);
  expect(png[25], `${rel} colour type (6 = truecolour with alpha)`).toBe(6);
}

describe('the application icon', () => {
  it('is a 1024x1024 RGBA PNG (mac .icns needs at least 512x512; the tile corners need alpha)', () => {
    expectRgbaPng(ICON_SOURCE, 1024);
  });

  it('has a Linux set of every hicolor size, each its own size', () => {
    for (const n of LINUX_ICON_SIZES) expectRgbaPng(join(LINUX_ICON_DIR, `${n}x${n}.png`), n);
    expect(Math.max(...LINUX_ICON_SIZES)).toBeLessThanOrEqual(512); // hicolor has no 1024x1024
  });

  it('is the file and the set electron-builder is configured with', () => {
    const cfg = createRequire(import.meta.url)(join(gui, 'electron-builder.cjs')) as {
      icon?: string; directories?: { buildResources?: string }; linux?: { icon?: string };
    };
    const res = cfg.directories?.buildResources ?? '';
    expect(join(res, cfg.icon ?? '')).toBe(ICON_SOURCE);
    expect(join(res, cfg.linux?.icon ?? '')).toBe(LINUX_ICON_DIR);
  });

  it('is what the unbundled layout hands the windows', () => {
    expect(layoutFor(join(gui, 'dist')).icon).toBe(join(gui, ICON_SOURCE));
  });

  it('is passed to every BrowserWindow main.ts creates', () => {
    const src = readFileSync(join(gui, 'src', 'main.ts'), 'utf8');
    const windows = [...src.matchAll(/new BrowserWindow\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => m[1]!);
    expect(windows.length).toBeGreaterThanOrEqual(5);
    for (const w of windows) expect(w, w.slice(0, 80)).toMatch(/\n\s*icon: layout\.icon,/);
  });
});
