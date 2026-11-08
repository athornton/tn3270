/**
 * Regenerates the icon PNGs from `resources/icon.svg`, rasterized by the project's own Electron
 * under Xvfb -- this box has no SVG tool, and Chromium is the renderer the icon was judged in.
 * Each size is drawn from the SVG directly, never downscaled from the 1024.
 *
 *     node packages/gui/scripts/render-icon.mjs
 *
 *  - `resources/icon.png`, 1024x1024: the window icon, and electron-builder's source for the mac
 *    `.icns` and the Windows `.ico`.
 *  - `resources/icons/NxN.png`, 16 to 512: the Linux set (`linux.icon`), installed by the .deb into
 *    `hicolor/NxN/apps`. A lone 1024 is not enough there: hicolor's index.theme (measured in the
 *    micromamba env, 2026-11-08) lists sizes up to 512x512 and no 1024x1024 directory at all.
 *
 * Commit every PNG with the SVG; nothing at build time regenerates them.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINUX_ICON_SIZES } from './bundleVerify.mjs';
import { electron, guiEnv } from './xvfb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const res = join(here, '..', 'resources');

mkdirSync(join(res, 'icons'), { recursive: true });
const wanted = [[join(res, 'icon.png'), 1024],
  ...LINUX_ICON_SIZES.map((n) => [join(res, 'icons', `${n}x${n}.png`), n])];
// Removed first, so a file left from an earlier run cannot pass the check below.
for (const [f] of wanted) rmSync(f, { force: true });
const jobs = wanted.map(([f, n]) => `${f}=${n}`);
const r = spawnSync(electron,
  ['--no-sandbox', '--disable-gpu', join(here, 'renderIconMain.cjs'), join(res, 'icon.svg'), ...jobs],
  { env: guiEnv(), stdio: ['ignore', 'inherit', 'ignore'], timeout: 120_000 });
if (r.status !== 0) {
  console.error(`render-icon: Electron exited ${r.status ?? r.signal}`);
  process.exit(1);
}
// Exit status 0 is not evidence (see renderIconMain.cjs): read each PNG's IHDR back.
let bad = 0;
for (const [f, n] of wanted) {
  let w = 0, h = 0;
  try { const png = readFileSync(f); w = png.readUInt32BE(16); h = png.readUInt32BE(20); } catch { /* missing */ }
  if (w !== n || h !== n) { console.error(`render-icon: ${f} is ${w}x${h}, wanted ${n}x${n}`); bad += 1; }
  else console.log(`render-icon: wrote ${f} (${n}x${n})`);
}
process.exit(bad === 0 ? 0 : 1);
