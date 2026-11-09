/**
 * Which workspaces are published, and what `npm pack` names their tarballs. MOVED HERE FROM
 * `pack.mjs` (2026-11-09), which re-exports both, because `publish.mjs` needs them too and runs in
 * release jobs that do no `npm ci`: `pack.mjs` imports `packages/gui/scripts/bundleVerify.mjs`,
 * which imports `@tn3270/canvas`, so importing it there fails. NOTHING BUT `node:` IMPORTS HERE.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagesDir = fileURLToPath(new URL('../packages', import.meta.url));

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
