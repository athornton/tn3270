#!/usr/bin/env node
/**
 * Publishes the `@tn3270/*` tarballs a CI run built, or checks that it could
 * (`docs/superpowers/specs/2026-11-09-npm-trusted-publishing-design.md`).
 *
 *   node scripts/publish.mjs --dry-run DIR    every push: the checks minus the tag, `npm publish --dry-run`
 *                                             of each version not already on the registry
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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTar } from './tarball.mjs';
import { publishedPackages, tarballName } from './workspaces.mjs';

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
  let m;
  try { m = JSON.parse(json.toString('utf8')); } catch (err) {
    throw new Error(`${basename(path)}'s package/package.json is not JSON: ${err.message}`);
  }
  if (typeof m?.name !== 'string' || typeof m?.version !== 'string') {
    throw new Error(`${basename(path)}'s package/package.json has no string name and version: repack it`);
  }
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
 *
 * TIMED OUT, headers and body both (the signal covers `json()` too): undici's own defaults are
 * ~300 s each, so one stalled request would outlast the whole read-back budget many times over.
 */
export async function registryShasum(fetchFn, name, version, { timeoutMs = 15_000 } = {}) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2F')}?write=true`;
  const r = await fetchFn(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
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
 * rounds `delayMs` apart AND no longer than `deadlineMs` of wall clock (default: ten minutes
 * either way; the clock bounds it when fetches are slow, each up to `timeoutMs`), and returns
 * the names still wrong (`[]`: all there). A failed fetch counts as "not there yet" for that
 * round, not as a crash. Once the deadline passes, nothing more is fetched.
 */
export async function verifyReadBack(fetchFn, tarballs, version,
  // TEN minutes, not two: the v0.1.4 run's read-back gave up at two (2026-11-10) while the registry
  // recorded core, web and gui 2.5-3 minutes after `npm publish` had reported them -- all eight were
  // in fact published, identical, and the re-run's read-back passed at once. Still inside the
  // publish job's timeout-minutes (20) with the publishes themselves (~3 minutes).
  { attempts = 60, delayMs = 10_000, deadlineMs = 600_000, timeoutMs = 15_000, sleep = realSleep, now = Date.now } = {}) {
  const end = now() + deadlineMs;
  let pending = [...tarballs];
  for (let i = 1; i <= attempts; i++) {
    const still = [];
    for (const t of pending) {
      if (now() >= end) { still.push(t); continue; }
      let sha;
      try { sha = await registryShasum(fetchFn, t.name, version, { timeoutMs }); } catch { sha = undefined; }
      if (sha !== t.sha1) still.push(t);
    }
    pending = still;
    if (pending.length === 0) return [];
    if (i === attempts || now() + delayMs >= end) break;
    await sleep(delayMs);
  }
  return pending.map((t) => t.name);
}

/** npm 11's refusal of a version already on the registry, as measured 2026-11-09 (npm 11.20). */
export const ALREADY_PUBLISHED = /cannot publish over the previously published version/i;

const USAGE = 'usage: node scripts/publish.mjs --dry-run|--check|--publish DIR';

class Refusal extends Error {}

/** Every `.tgz` in `dir`, read; checked, ordered. Throws a Refusal listing every problem. */
function loadRelease(dir, tag) {
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.tgz')).sort(); } catch (err) {
    throw new Refusal(`cannot read ${dir}: ${err.message}`);
  }
  const tarballs = [];
  const unreadable = [];
  for (const f of files) {
    // ABSOLUTE, because the path goes to `npm publish`: a relative `tarballs/x.tgz` (one slash) is
    // GitHub shorthand to npm, which then tries `git ls-remote` on github.com/tarballs/x.tgz.git.
    // That is how the 0.1.2 tag run's publish failed (2026-11-09; nothing was published).
    try { tarballs.push(readTarball(resolve(dir, f))); } catch (err) { unreadable.push(`${f}: ${err.message}`); }
  }
  if (unreadable.length > 0) throw new Refusal(unreadable.join('\n'));
  const { version, problems } = checkRelease({ tag, tarballs, expectedNames: publishedPackages().map(({ m }) => m.name) });
  if (problems.length > 0) throw new Refusal(problems.join('\n'));
  let order;
  try { order = publishOrder(tarballs); } catch (err) { throw new Refusal(err.message); }
  return { version, order };
}

/** `--check`'s answer: each tarball in order with its decision. Throws a Refusal on any conflict. */
async function plan(order, version, fetchFn) {
  const decided = [];
  for (const t of order) {
    let sha;
    try { sha = await registryShasum(fetchFn, t.name, version); } catch (err) {
      throw new Refusal(`cannot read ${t.name} from the registry: ${err.message}`);
    }
    decided.push({ t, decision: decide(t.sha1, sha), sha });
  }
  const conflicts = decided.filter((d) => d.decision === 'conflict');
  if (conflicts.length > 0) {
    throw new Refusal(conflicts.map(({ t, sha }) =>
      `${t.name}@${version} is already on the registry with other contents (shasum ${sha}, this tarball ${t.sha1}): `
      + 'a published version cannot be replaced, so release a new version').join('\n'));
  }
  return decided;
}

/**
 * The three modes, with everything outside the process injected: `env` (`GITHUB_REF_NAME`,
 * `GITHUB_REF_TYPE`, `GITHUB_ACTIONS`), `fetchFn`, `run(args, { capture }) -> { status, output }`
 * (an `npm` invocation; `output` is only collected with `capture`), `sleep`, `log`. Returns the exit status: 0, or 1 with every problem logged.
 */
export async function main(argv, { env, fetchFn, run, sleep, log }) {
  const [mode, dir, ...rest] = argv;
  try {
    if (!['--dry-run', '--check', '--publish'].includes(mode) || dir === undefined || rest.length > 0) {
      throw new Refusal(USAGE);
    }
    if (mode === '--dry-run') {
      const { version, order } = loadRelease(dir, undefined);
      log(`publish: dry run of ${version}, in order: ${order.map((t) => t.name).join(' ')}`);
      // `npm publish --dry-run` RUNS FOR EVERY TARBALL, so every push really exercises it. MEASURED
      // 2026-11-09: npm 11.20 exits 1 on a version already on the registry ("You cannot publish
      // over the previously published versions: 0.1.1."), npm 10.9 exits 0. That one refusal is
      // accepted, and only when the registry says this exact version is there too: every push
      // between a release and the next version bump would fail otherwise.
      let accepted = 0;
      for (const t of order) {
        let sha;
        let registryError;
        try { sha = await registryShasum(fetchFn, t.name, version); } catch (err) { registryError = err.message; }
        if (sha !== undefined && sha !== t.sha1) {
          const warning = `${t.name}@${version} is already on the registry with OTHER contents: `
            + `bump the version (npm run version:set) before tagging, or the release will be refused`;
          log(`publish: WARNING: ${warning}`);
          if (env.GITHUB_ACTIONS === 'true') log(`::warning::${warning}`);
        }
        const { status, output } = run(['publish', '--dry-run', t.path], { capture: true });
        if (status === 0) continue;
        if (sha !== undefined && ALREADY_PUBLISHED.test(output)) {
          log(`publish: ${t.name}@${version} is already on the registry, which this npm refuses even dry: accepted`);
          accepted++;
          continue;
        }
        throw new Refusal(`npm publish --dry-run ${basename(t.path)} exited ${status}`
          + (registryError !== undefined ? ` (and the registry could not be read: ${registryError})` : ''));
      }
      log(`publish: dry run of ${version} passed for all ${order.length}`
        + (accepted > 0 ? `, ${accepted} refused by npm as already published` : ''));
      return 0;
    }

    const tag = env.GITHUB_REF_NAME;
    if (tag === undefined || tag === '') {
      throw new Refusal('GITHUB_REF_NAME is not set: --check and --publish run on a tag push, which sets it to the tag');
    }
    // A BRANCH named v0.1.2 has that GITHUB_REF_NAME too.
    if (env.GITHUB_REF_TYPE !== 'tag') {
      throw new Refusal(`GITHUB_REF_TYPE is ${JSON.stringify(env.GITHUB_REF_TYPE ?? '')}, not "tag": --check and --publish run on a tag push only`);
    }
    const { version, order } = loadRelease(dir, tag);
    const decided = await plan(order, version, fetchFn);
    log(`publish: ${version}, in order:`);
    for (const { t, decision } of decided) log(`  ${decision.padEnd(7)} ${t.name}`);
    if (mode === '--check') return 0;

    let fresh = 0;
    for (const [i, { t, decision }] of decided.entries()) {
      if (decision === 'skip') continue;
      // NOT CAPTURED: a real publish's output streams, and any prompt (web login, OTP) shows.
      const { status } = run(['publish', t.path], { capture: false });
      if (status !== 0) {
        const notTried = decided.slice(i + 1).filter((d) => d.decision !== 'skip').map((d) => d.t.name);
        throw new Refusal(`npm publish ${basename(t.path)} exited ${status}; not attempted: `
          + `${notTried.length > 0 ? notTried.join(', ') : 'nothing (it was the last)'}. Re-run the failed publish job (not all jobs, which rebuilds `
          + 'the tarballs): what did publish is skipped');
      }
      fresh++;
    }
    const wrong = await verifyReadBack(fetchFn, order, version, { sleep });
    if (wrong.length > 0) {
      throw new Refusal(`the registry does not hold ${version} with these tarballs' shasum for: ${wrong.join(', ')}`);
    }
    log(`published ${version}: ${fresh} new, ${order.length - fresh} already there, registry verified`);
    return 0;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    for (const line of err.message.split('\n')) log(`publish: refused: ${line}`);
    return 1;
  }
}

/**
 * `npm args...`. With `capture` (the dry runs, whose output is read) its output is collected and
 * then passed through. Without it, `stdio: 'inherit'`: a real `npm publish` streams as it runs,
 * and a web-login or OTP prompt is visible instead of looking like a hang. `npm` is `npm.cmd` on
 * Windows, which only a shell runs.
 */
function runNpm(args, { capture }) {
  if (!capture) {
    const r = process.platform === 'win32'
      ? spawnSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, { stdio: 'inherit', shell: true })
      : spawnSync('npm', args, { stdio: 'inherit' });
    return { status: r.error !== undefined ? 1 : (r.status ?? 1), output: r.error?.message ?? '' };
  }
  const opts = { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const r = process.platform === 'win32'
    ? spawnSync(`npm ${args.map((a) => `"${a}"`).join(' ')}`, { ...opts, shell: true })
    : spawnSync('npm', args, opts);
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { status: r.error !== undefined ? 1 : (r.status ?? 1), output: r.error !== undefined ? `${output}${r.error.message}` : output };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env, fetchFn: fetch, run: runNpm, sleep: realSleep, log: console.log,
  });
}
