#!/usr/bin/env node
/**
 * Sets ONE version on the root and every workspace manifest, on every `@tn3270/*`
 * dependency, devDependency and peerDependency, and on core's exported VERSION.
 * Lockstep because internal dependencies are exact: a mixed set cannot resolve.
 * Run `npm install` afterwards to update the lockfile.
 *
 * Rewrites each manifest with targeted regex substitutions rather than
 * JSON.parse + JSON.stringify, so that compact one-line fields untouched by a
 * version bump -- e.g. `"exports": { ".": "./dist/index.js" }` or
 * `"files": ["dist", "README.md"]` -- are left byte-for-byte alone. A full
 * stringify round-trip would reformat those onto multiple lines and turn every
 * bump into a repo-wide formatting diff.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Matches the one top-level `"version": "..."` field a manifest should have. */
const VERSION_FIELD = /"version":\s*"[^"]*"/g;
/** Matches any `"@tn3270/<name>": "<range>"` entry, wherever it is a key -- in
 *  practice always inside dependencies/devDependencies/peerDependencies, since
 *  that is the only place an `@tn3270/*` string appears as an object key rather
 *  than a value (e.g. `"name": "@tn3270/core"` does not match: there, `@tn3270/core`
 *  is the value, with no colon-then-string following it). */
const INTERNAL_DEP = /"(@tn3270\/[A-Za-z0-9_-]+)":\s*"[^"]*"/g;
/** The exact literal `packages/core/src/index.ts` exports for the manifest test. */
const VERSION_LITERAL = /^export const VERSION = '[^']*';$/gm;

function rewriteManifest(path, version) {
  const raw = readFileSync(path, 'utf8');
  const versionMatches = raw.match(VERSION_FIELD) ?? [];
  if (versionMatches.length !== 1) {
    throw new Error(
      `set-version: expected exactly one "version" field in ${path}, found ${versionMatches.length}`,
    );
  }
  let out = raw.replace(VERSION_FIELD, `"version": "${version}"`);
  out = out.replace(INTERNAL_DEP, (_m, name) => `"${name}": "${version}"`);
  writeFileSync(path, out);
}

function rewriteCoreVersion(path, version) {
  const raw = readFileSync(path, 'utf8');
  const matches = raw.match(VERSION_LITERAL) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `set-version: expected exactly one VERSION literal in ${path}, found ${matches.length}`,
    );
  }
  writeFileSync(path, raw.replace(VERSION_LITERAL, `export const VERSION = '${version}';`));
}

/**
 * Sets `version` everywhere it belongs under `rootDir`. Returns the number of
 * files written: the root manifest, every `packages/*\/package.json`
 * (including private ones, which share the lockstep version too), and
 * `packages/core/src/index.ts`.
 */
export function setVersion(rootDir, version) {
  if (!SEMVER.test(version)) {
    throw new Error(`set-version: "${version}" is not a valid semver version (expected X.Y.Z or X.Y.Z-pre)`);
  }

  const manifestPaths = [join(rootDir, 'package.json')];
  const packagesDir = join(rootDir, 'packages');
  if (existsSync(packagesDir)) {
    for (const d of readdirSync(packagesDir)) {
      const p = join(packagesDir, d, 'package.json');
      if (existsSync(p)) manifestPaths.push(p);
    }
  }

  let written = 0;
  for (const p of manifestPaths) {
    rewriteManifest(p, version);
    written++;
  }

  rewriteCoreVersion(join(rootDir, 'packages', 'core', 'src', 'index.ts'), version);
  written++;

  return written;
}

/**
 * Whether this file is the program Node was asked to run.
 *
 * DELIBERATELY inlined rather than importing `isMain` from
 * `@tn3270/node-files`: that package's public entry point is `dist/index.js`,
 * which would make this script depend on a prior build. A version bump is
 * something you may want to run before `npm run build` even exists (e.g. on a
 * fresh clone, or to decide what to build next), so the check has to work
 * without one. The logic matches `packages/node-files/src/isMain.ts` exactly.
 */
function isMainScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainScript()) {
  const version = process.argv[2];
  if (version === undefined) {
    console.error('usage: set-version.mjs X.Y.Z');
    process.exit(2);
  }
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  try {
    const written = setVersion(rootDir, version);
    console.log(`set ${written} files to ${version}; now run npm install`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
