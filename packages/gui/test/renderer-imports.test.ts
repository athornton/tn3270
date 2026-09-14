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
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(guiDir, 'dist');

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
});
