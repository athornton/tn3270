#!/usr/bin/env node
/**
 * Publishes the `@tn3270/*` tarballs a CI run built, or checks that it could
 * (`docs/superpowers/specs/2026-11-09-npm-trusted-publishing-design.md`).
 *
 *   node scripts/publish.mjs --dry-run DIR    every push: the checks minus the tag, `npm publish --dry-run`
 *   node scripts/publish.mjs --check DIR      tag push, before the approval: would this release go?
 *   node scripts/publish.mjs --publish DIR    tag push, after it: publish, then read the registry back
 *
 * DEPENDENCY-FREE: the release jobs run it with no `npm ci`, so it imports `node:` modules and
 * the two equally dependency-free `tarball.mjs` and `workspaces.mjs`, nothing else. (`pack.mjs`
 * would pull in `@tn3270/canvas` through `bundleVerify.mjs`.)
 *
 * THE READ-BACK IS THE POINT. The 0.1.1 release's first attempt published nothing, from a machine
 * not logged in to npm, and nobody noticed until the registry was read (`docs/releasing.md`,
 * *Release history*). `--publish` is not done until every package's `dist.shasum` on the registry
 * equals the sha1 of the file it was handed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readTar } from './tarball.mjs';
import { tarballName } from './workspaces.mjs';

const SCOPE = '@tn3270/';

/**
 * A tarball's identity: the name, version and `@tn3270/*` dependencies of its own
 * `package/package.json`, and the sha1 of the whole `.tgz` -- what the registry records as
 * `dist.shasum`, since `npm publish <tgz>` uploads the file's bytes unchanged.
 */
export function readTarball(path) {
  const bytes = readFileSync(path);
  const json = readTar(path).get('package/package.json');
  if (json === undefined) throw new Error(`${basename(path)} has no package/package.json: is it an npm pack tarball?`);
  const m = JSON.parse(json.toString('utf8'));
  // Every field npm installs from. devDependencies are not installed by a consumer.
  const deps = {};
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [n, range] of Object.entries(m[field] ?? {})) if (n.startsWith(SCOPE)) deps[n] = range;
  }
  return { path, name: m.name, version: m.version, deps, sha1: createHash('sha1').update(bytes).digest('hex') };
}

/**
 * Dependency order over the set's own `@tn3270/*` dependencies: Kahn's algorithm, taking the
 * alphabetically first ready package each step, so the order is deterministic. COMPUTED, NOT
 * LISTED, so a new package or a new edge can never be published before what it needs. Throws on a
 * cycle, naming what is in it, and on a dependency outside the set, naming it.
 */
export function publishOrder(tarballs) {
  const byName = new Map(tarballs.map((t) => [t.name, t]));
  for (const t of tarballs) {
    for (const d of Object.keys(t.deps)) {
      if (!byName.has(d)) throw new Error(`${t.name} depends on ${d}, which is not among the tarballs`);
    }
  }
  const order = [];
  const done = new Set();
  const left = new Set(byName.keys());
  while (left.size > 0) {
    const ready = [...left].filter((n) => Object.keys(byName.get(n).deps).every((d) => done.has(d))).sort();
    if (ready.length === 0) {
      throw new Error(`dependency cycle among ${[...left].sort().join(', ')}: none can be published first`);
    }
    const next = ready[0];
    order.push(byName.get(next));
    done.add(next);
    left.delete(next);
  }
  return order;
}

/**
 * Every rule a release must pass, as `{ version, problems }`, each problem a sentence naming the
 * fix. `tag` undefined means a dry run: no tag rule, and the version is the one the tarballs share.
 * `expectedNames` are the package names that must be present, exactly: `publishedPackages()`'s.
 */
export function checkRelease({ tag, tarballs, expectedNames }) {
  const problems = [];
  let version;
  if (tag !== undefined) {
    const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
    if (m === null) problems.push(`tag ${JSON.stringify(tag)} is not v + a version X.Y.Z: tag a release as e.g. v0.1.2`);
    else version = m[1];
  } else {
    const versions = [...new Set(tarballs.map((t) => t.version))].sort();
    if (versions.length === 1) version = versions[0];
    else if (versions.length > 1) {
      problems.push(`the tarballs' versions disagree (${versions.join(', ')}): run npm run version:set -- X.Y.Z, then rebuild and repack`);
    }
  }

  const have = tarballs.map((t) => t.name);
  const missing = expectedNames.filter((n) => !have.includes(n));
  const extra = have.filter((n) => !expectedNames.includes(n));
  const twice = [...new Set(have.filter((n, i) => have.indexOf(n) !== i))];
  if (missing.length > 0) problems.push(`missing tarballs for ${missing.join(', ')}: every published workspace must be packed`);
  if (extra.length > 0) problems.push(`unexpected tarballs for ${extra.join(', ')}: only the published workspaces may be released`);
  if (twice.length > 0) problems.push(`more than one tarball for ${twice.join(', ')}: pack into an empty directory`);
  if (tarballs.length === 0 && expectedNames.length === 0) problems.push('no tarballs and no published workspaces');

  for (const t of tarballs) {
    const file = basename(t.path);
    if (file !== tarballName(t)) problems.push(`${file} holds ${t.name}@${t.version}, which npm pack names ${tarballName(t)}: repack it`);
    if (version !== undefined && tag !== undefined && t.version !== version) {
      problems.push(`${t.name} is at ${t.version}, not the tag's ${version}: run npm run version:set -- ${version}, or fix the tag`);
    }
    if (version === undefined) continue;
    for (const [d, range] of Object.entries(t.deps)) {
      if (range !== version) {
        problems.push(`${t.name} depends on ${d} as ${JSON.stringify(range)}, not exactly ${version}: run npm run version:set -- ${version}`);
      }
    }
  }
  return { version, problems };
}

/**
 * The registry's `dist.shasum` for `name@version`, or undefined if the package or that version is
 * absent. UNCACHED: `?write=true` makes the registry skip its CDN copy, which can lag a publish by
 * minutes. Any failure other than a 404 THROWS: an outage must never read as "not published yet".
 */
export async function registryShasum(fetchFn, name, version) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}?write=true`;
  const r = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (r.status === 404) return undefined;
  if (!r.ok) throw new Error(`registry answered ${r.status} for ${url}`);
  const doc = await r.json();
  return doc?.versions?.[version]?.dist?.shasum;
}

/** 'publish' when the registry lacks it, 'skip' when it has these bytes, 'conflict' when other bytes. */
export function decide(localSha1, registrySha1) {
  if (registrySha1 === undefined) return 'publish';
  return registrySha1 === localSha1 ? 'skip' : 'conflict';
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until every tarball's `version` is on the registry with its sha1, for up to `attempts`
 * rounds `delayMs` apart (default: two minutes), and returns the names still wrong (`[]`: all
 * there). A failed fetch counts as "not there yet" for that round, not as a crash.
 */
export async function verifyReadBack(fetchFn, tarballs, version, { attempts = 24, delayMs = 5000, sleep = realSleep } = {}) {
  let pending = [...tarballs];
  for (let i = 1; i <= attempts; i++) {
    const still = [];
    for (const t of pending) {
      let sha;
      try { sha = await registryShasum(fetchFn, t.name, version); } catch { sha = undefined; }
      if (sha !== t.sha1) still.push(t);
    }
    pending = still;
    if (pending.length === 0) return [];
    if (i < attempts) await sleep(delayMs);
  }
  return pending.map((t) => t.name);
}
