#!/usr/bin/env node
/**
 * `npm pack`s every published workspace into `artifacts/npm/`, for `install-smoke.mjs` and for a
 * manual first publish (`docs/releasing.md`).
 *
 *   node scripts/pack.mjs          (or: npm run pack:npm)
 *
 * NAMED `pack:npm` AT THE ROOT, NOT `pack`: `npm pack` is an npm builtin, and at the root it
 * silently packs the private workspace root into a tarball nobody wants. `npm run pack` and
 * `npm pack` differ by one word; `pack:npm` cannot be mistyped into the builtin.
 *
 * WHAT IT REFUSES, each BEFORE packing anything:
 *  - `packages/gui/app/BUNDLED` missing. `@tn3270/gui`'s `files` is `app`, `bin`, `README.md`, so
 *    without a bundle npm packs a gui with no app in it and reports success.
 *  - A tsc ORPHAN in any `dist/`: a compiled `.js` whose source is gone. `tsc --build` never deletes
 *    output for a removed source, and `files: ["dist"]` ships whatever is there. MEASURED
 *    2026-11-06 on the dev box: `web/dist/__t8sim.js`, `tui/dist/colours.js`,
 *    `tui/dist/transferRun.js` and `cli/dist/transfer.js` were all in the tarballs.
 *
 *  - A `dist/` OLDER THAN ITS OWN `src/`, in any published workspace: `distStaleness()` from
 *    `freshness.mjs`, the same check `bundle:gui` and the GUI harnesses use. FOUND BY REVIEW: edit
 *    a source file, skip `npm run build`, and npm packs yesterday's compiled code without a word.
 *    gui is checked too although it ships `app/`, because `app/` is built from `gui/dist`.
 *
 * `artifacts/npm` IS DELETED FIRST, so a tarball from an earlier run can never be installed as if
 * it were this one's.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { distStaleness } from './freshness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagesDir = join(root, 'packages');
const out = join(root, 'artifacts', 'npm');
const win = process.platform === 'win32';

function die(message) {
  process.stderr.write(`pack: ${message}\n`);
  process.exit(1);
}

/** Every non-private workspace, the same discovery as `packages/core/test/manifests.test.ts`. */
export function publishedPackages() {
  return readdirSync(packagesDir)
    .filter((d) => existsSync(join(packagesDir, d, 'package.json')))
    .map((dir) => ({ dir, m: JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8')) }))
    .filter(({ m }) => m.private !== true);
}

/** The file name `npm pack` gives a manifest: `@tn3270/node-files@0.1.0` -> `tn3270-node-files-0.1.0.tgz`. */
export function tarballName(m) {
  return `${m.name.replace(/^@/, '').replace('/', '-')}-${m.version}.tgz`;
}

/** Compiled suffix -> the source suffixes it can come from. LONGEST FIRST: `.d.ts` before `.ts`. */
const SOURCE_EXT = [
  ['.d.ts', ['.ts']], ['.js.map', ['.ts']], ['.js', ['.ts']],
  ['.d.cts', ['.cts']], ['.cjs.map', ['.cts']], ['.cjs', ['.cts']],
];

/** Compiled files under `dir/dist` with no source under `dir/src`. */
function orphans(dir) {
  const dist = join(packagesDir, dir, 'dist');
  const src = join(packagesDir, dir, 'src');
  if (!existsSync(dist) || !existsSync(src)) return [];
  const found = [];
  for (const f of readdirSync(dist, { recursive: true })) {
    const rule = SOURCE_EXT.find(([e]) => f.endsWith(e));
    if (rule === undefined) continue;
    const stem = f.slice(0, -rule[0].length);
    if (!rule[1].some((s) => existsSync(join(src, stem + s)))) found.push(`packages/${dir}/dist/${f}`);
  }
  return found;
}

function main() {
  const pkgs = publishedPackages();
  if (pkgs.length === 0) die('no published workspaces found under packages/');

  const gui = pkgs.find(({ m }) => m.name === '@tn3270/gui');
  if (gui !== undefined && !existsSync(join(packagesDir, gui.dir, 'app', 'BUNDLED'))) {
    die('packages/gui/app/BUNDLED is missing, so @tn3270/gui would pack with no app: '
      + 'run npm run build && npm run bundle:gui first');
  }
  // Only where `dist` is shipped: gui ships `app/`, which bundle.mjs builds from named entry points.
  const stale = pkgs.filter(({ m }) => m.files?.includes('dist')).flatMap(({ dir }) => orphans(dir));
  if (stale.length > 0) {
    die(`compiled output with no source would be shipped (delete it, or rm -rf the dist and rebuild):\n  `
      + stale.join('\n  '));
  }
  // Every published workspace has a `src`, and `distStaleness` also reports a MISSING `dist`.
  const stalePkg = distStaleness(packagesDir, pkgs.map(({ dir }) => dir));
  if (stalePkg !== undefined) die(`${stalePkg.why}: run npm run build${stalePkg.forceHint}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const { dir, m } of pkgs) {
    // `npm` is `npm.cmd` on Windows, which only a shell can run. The arguments are fixed and
    // contain no spaces, except `out`, which is quoted.
    const r = win
      ? spawnSync(`npm pack --pack-destination "${out}"`, { cwd: join(packagesDir, dir), shell: true, encoding: 'utf8' })
      : spawnSync('npm', ['pack', '--pack-destination', out], { cwd: join(packagesDir, dir), encoding: 'utf8' });
    if (r.error !== undefined || r.status !== 0) {
      die(`npm pack failed in packages/${dir} (${r.error?.message ?? `exit ${r.status}`}):\n${r.stderr}`);
    }
    const name = tarballName(m);
    if (!existsSync(join(out, name))) die(`npm pack in packages/${dir} succeeded but wrote no ${name}`);
    process.stdout.write(`${name}\n`);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
