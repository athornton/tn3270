import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The renderer's runtime graph must contain no workspace import.
 *
 * A browser cannot resolve a bare specifier like `@tn3270/core`; there is no bundler. The
 * failure mode is what makes this worth a test: the window goes BLANK WITH NO ERROR, and
 * nothing in the suite notices. `drawList` runs in main for exactly this reason, and this
 * pins the boundary rather than trusting a comment to be read.
 *
 * `import type` is invisible here because it erases at compile time -- which is why this
 * test reads the BUILT javascript rather than the TypeScript source.
 *
 * The walker sees static `import ... from '...'` / `export ... from '...'` and dynamic
 * `import('...')`, in both their relative-specifier (followed into the graph) and
 * `@tn3270/`-specifier (flagged as an offender) forms. It does NOT see a specifier built at
 * runtime from a variable (e.g. `import(pkgName)`) -- no regex can, and catching that would
 * need real bundler-grade analysis, not a text scan.
 */
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(pkgDir, 'dist');

/** Every local module reachable from an entry point, following relative imports. */
function graphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(resolvePath(dirname(file), m[1]!));
    }
    for (const m of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(resolvePath(dirname(file), m[1]!));
    }
  }
  return [...seen];
}

describe('the renderer bundle', () => {
  it('was built (run npm run build first)', () => {
    expect(existsSync(join(distDir, 'renderer.js')), `missing ${distDir}/renderer.js`).toBe(true);
  });

  it('imports no workspace package anywhere in its runtime graph', () => {
    const graph = graphFrom(join(distDir, 'renderer.js'));
    // Not `length > 1`: that cannot distinguish "found everything" from "found something",
    // and a walker that silently stopped following edges would still pass it. Naming the
    // real edges means a missed one fails here rather than turning the offender scan below
    // into a scan of nothing.
    expect(graph.some((f) => f.endsWith('keys.js')), 'keys.js not reached').toBe(true);
    expect(graph.some((f) => f.endsWith('blit.js')), 'blit.js not reached').toBe(true);
    // The third real edge. It was `hittest.js` until 2026-10-06, since the renderer hit-tested a
    // keypad click itself; that module went with the canvas keypad, and `selection.js` -- which the
    // copy/paste gesture added -- is now the third thing the renderer reaches. Named for the same
    // reason as the other two: an unnamed edge is one the walker may quietly stop following.
    expect(graph.some((f) => f.endsWith('selection.js')), 'selection.js not reached').toBe(true);
    const offenders: string[] = [];
    for (const file of graph) {
      const text = readFileSync(file, 'utf8');
      if (/(?:from|import)\s*['"]@tn3270\//.test(text)) offenders.push(file);
      else if (/import\(\s*['"]@tn3270\//.test(text)) offenders.push(file);
    }
    expect(offenders, 'these run in the renderer and would blank the window').toEqual([]);
  });

  it('confirms drawlist.js is NOT in that graph, since it imports core and frontend', () => {
    // This is implied by the offender scan above, since drawlist.js's own @tn3270/core import
    // would already be caught if drawlist.js ever entered the graph. It earns its place anyway:
    // if it fails, it names the regression precisely -- palette or draw-list work moved into
    // the renderer -- rather than leaving whoever broke it to work backward from a generic
    // offender list.
    const graph = graphFrom(join(distDir, 'renderer.js'));
    expect(graph.some((f) => f.endsWith('drawlist.js'))).toBe(false);
  });

  it('can import selection.js, whose whole graph is itself', () => {
    /*
      THIS TEST WAS ABOUT `hittest.js` UNTIL 2026-10-06, and the property it pins is worth keeping
      even though its subject changed. The keypad's hit test was the one part of `keypad.ts` the
      RENDERER needed, and importing it from `keypad.js` would have pulled in `drawlist.js`,
      `@tn3270/core` and `@tn3270/frontend` -- MEASURED during review, when both assertions failed.
      It therefore lived in its own module whose only import was an erasing `import type`.

      `selection.js` is in exactly that position now: the renderer needs `normalizeRect` and
      `isEmptyRect`, its only import is `import type { ResolvedCell }`, and taking them from the
      barrel instead would blank the window. The point of pinning it HERE rather than trusting the
      offender scan above is that the scan reports a generic list, where this names the module --
      and that it fails as a RED TEST rather than as a blank window.
    */
    const graph = graphFrom(join(distDir, 'selection.js'));
    expect(graph.map((f) => f.replace(`${distDir}/`, ''))).toEqual(['selection.js']);
    // MATCHED ON THE IMPORT FORM, not on the bare string `@tn3270/`, and that is a correction the
    // switch of subject forced: `selection.js`'s own docstring EXPLAINS the hazard and so contains
    // `@tn3270/core` as prose. The old `hittest.js` happened not to mention it, so a substring
    // test passed there and would fail here for the wrong reason -- rejecting a file whose only
    // offence is documenting the rule it obeys.
    const text = readFileSync(join(distDir, 'selection.js'), 'utf8');
    const specifiers = [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers, 'selection.js must import nothing at runtime').toEqual([]);
  });
});
