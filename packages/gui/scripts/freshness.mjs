/**
 * `tsc --build`'s output-vs-source freshness check, shared by `bundle.mjs` (which must refuse to
 * bundle a stale `dist/`, BEFORE writing anything) and `xvfb.mjs`'s `staleness()` (which must
 * refuse to let a harness RUN one). One implementation, because the dist-mode check already
 * drifted once across `keys.mjs`, `clicks.mjs` and `transfer.mjs` before it was centralised into
 * `xvfb.mjs` -- and bundling is exactly the same question asked at a different moment (build
 * time instead of run time), so it gets the same answer rather than a fourth copy.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Newest mtime among files under `dir` (recursive) whose name ends with one of `suffixes`. */
export function newest(dir, ...suffixes) {
  return Math.max(...readdirSync(dir, { recursive: true })
    .filter((f) => suffixes.some((s) => f.endsWith(s)))
    .map((f) => statSync(join(dir, f)).mtimeMs));
}

/**
 * Whether `packagesRoot/<pkg>/dist` is fresh enough to trust, for every `pkg` in `pkgs`, checked
 * PER PACKAGE and not as one `max` across all of them -- a fresh `gui` build would otherwise mask
 * a stale `canvas` one, since `gui`'s newer output would win the max over `canvas`'s newer source.
 * Returns the first problem found, as `{ why, forceHint }`, or `undefined` if every package's
 * `dist` is at least as new as its own `src`.
 *
 * `.cts`/`.cjs` ARE NAMED EXPLICITLY ON BOTH SIDES, and the first version of this check did not:
 * `'preload.cts'.endsWith('.ts')` is FALSE, so the source side skipped every preload entirely --
 * the one surviving route to a green run (or a green bundle) over a stale IPC bridge.
 *
 * `forceHint` IS SEPARATE FROM THE REMEDY'S BASE COMMAND, deliberately: `bundle.mjs`'s remedy is
 * `npm run build`, dist-mode harnesses' is also `npm run build`, but app-mode harnesses' is
 * `npm run build && npm run bundle:gui` -- three different base commands for the same underlying
 * problem, each caller's to choose. The hint itself -- `tsc --build --force packages/<pkg>` for a
 * content-preserving `touch`, e.g. right after `git checkout` -- is the same in all three, so it
 * is built once here and appended by the caller.
 */
export function distStaleness(packagesRoot, pkgs) {
  for (const pkg of pkgs) {
    const root = join(packagesRoot, pkg);
    if (!existsSync(join(root, 'dist'))) {
      return { why: `there is no packages/${pkg}/dist, so there is nothing built to run`, forceHint: '' };
    }
    if (newest(join(root, 'dist'), '.js', '.cjs') < newest(join(root, 'src'), '.ts', '.cts')) {
      return {
        why: `packages/${pkg}/dist is OLDER than packages/${pkg}/src, so this run would test stale code`,
        forceHint: `  (if that reports everything up to date, only a timestamp moved: ` +
          `npx tsc --build --force packages/${pkg})`,
      };
    }
  }
  return undefined;
}
