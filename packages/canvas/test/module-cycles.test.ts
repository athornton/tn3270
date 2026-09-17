import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No module in this package may import another that imports it back.
 *
 * ## WHY THIS IS A TEST AND NOT A COMMENT
 *
 * This package has had TWO import cycles, and neither of them broke anything on the day it
 * landed. `column()` lived in `drawlist.ts` while `keypad.ts` needed it, so `keypad.ts`
 * value-imported `drawlist.ts` and `drawlist.ts` value-imported `keypad.ts` back; moving
 * `column()` into `cg.ts` (Task 6) fixed that one and left a SECOND, type-only cycle behind --
 * `cg.ts` took `AtlasGeometry` from `drawlist.ts` while `drawlist.ts` value-imported `column`.
 * `tsc --build` resolves both and `import type` erases, so the whole suite stayed green through
 * both. A cycle here is a latent hazard rather than a live failure: it decides module
 * initialisation ORDER, so the day one of these type imports becomes a value import -- a
 * constant, an enum, a helper -- the reward is a `TDZ`/`undefined` at module load, in a browser,
 * with no bundler and no error in any console. This project has met that exact silence four
 * separate ways.
 *
 * So the cycle is caught HERE, at the point it is introduced, rather than at the point it
 * becomes fatal.
 *
 * ## SOURCE FIRST, BUILT OUTPUT SECOND, AND THE SOURCE HALF IS THE LOAD-BEARING ONE
 *
 * `import type` ERASES, so a scan of `dist/*.js` cannot see a type-position cycle at all -- it
 * would not have caught either half of the one this file was written for. The `src` scan does,
 * because it reads the TypeScript. The `dist` scan is kept as the independent second statement:
 * its edges are a SUBSET of the source's, so it can only agree -- unless the source regex has
 * stopped matching a form (a multi-line specifier, say), and then the two disagree and the
 * subset assertion below says so.
 *
 * The walker sees static `import ... from '...'` / `export ... from '...'`, bare `import '...'`
 * and dynamic `import('...')`, for RELATIVE specifiers only: a cycle needs two modules of this
 * package, and `@tn3270/` or `node:` cannot be one of them. It does NOT see a specifier built at
 * runtime from a variable -- no regex can, as `renderer-imports.test.ts` says of its own walker.
 */
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(pkgDir, 'src');
const distDir = join(pkgDir, 'dist');

/**
 * The relative specifiers one file names, resolved onto sibling file names.
 *
 * `./cg.js` becomes `cg.ts` when reading source, because NodeNext source imports the OUTPUT
 * name. An edge to a name the directory does not hold is dropped rather than kept as a phantom
 * node: it would be a broken import, which the build catches and this file must not report as a
 * cycle.
 */
function edgesOf(text: string, from: string, present: ReadonlySet<string>, ext: string): string[] {
  const out = new Set<string>();
  const add = (spec: string): void => {
    const file = spec.replace(/^\.\//, '').replace(/\.js$/, ext);
    if (file !== from && present.has(file)) out.add(file);
  };
  for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) add(m[1]!);
  for (const m of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) add(m[1]!);
  return [...out];
}

function graphOf(dir: string, ext: string): Map<string, string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith(ext) && !f.endsWith(`.d${ext}`));
  const present = new Set(files);
  const graph = new Map<string, string[]>();
  for (const f of files) {
    graph.set(f, edgesOf(readFileSync(join(dir, f), 'utf8'), f, present, ext));
  }
  return graph;
}

/**
 * One cycle, as the path that closes it, or `null` when the graph is acyclic.
 *
 * Returns the PATH and not a boolean: "packages/canvas/src has an import cycle" is a diagnosis
 * whoever reads it then has to redo by hand, and the whole value of catching this early is that
 * the message names the two modules to look at.
 */
function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const walk = (node: string): void => {
    if (cycle !== null) return;
    if (state.get(node) === 'open') {
      cycle = [...stack.slice(stack.indexOf(node)), node];
      return;
    }
    if (state.get(node) === 'done') return;
    state.set(node, 'open');
    stack.push(node);
    for (const next of graph.get(node) ?? []) walk(next);
    stack.pop();
    state.set(node, 'done');
  };
  for (const node of [...graph.keys()].sort()) walk(node);
  return cycle;
}

describe('the canvas package import graph', () => {
  const src = graphOf(srcDir, '.ts');

  it('is acyclic in SOURCE, type imports included', () => {
    const cycle = findCycle(src);
    expect(cycle === null ? '' : `import cycle: ${cycle.join(' -> ')}`).toBe('');
  });

  it('was scanned for real, so the acyclic result above is not vacuous', () => {
    // Named edges, exactly as `renderer-imports.test.ts` names the renderer's three: a walker that
    // silently stopped matching would return an empty graph and pass the cycle check trivially.
    // These four are chosen to cover every FORM the scan has to see.
    expect([...src.keys()], 'the source scan found no modules').toContain('drawlist.ts');
    // A plain value import, and the edge that made both historical cycles.
    expect(src.get('drawlist.ts'), 'drawlist -> keypad').toContain('keypad.ts');
    expect(src.get('keypad.ts'), 'keypad -> cg').toContain('cg.ts');
    // A TYPE-ONLY import, which is the form a `dist` scan cannot see and the one both cycles
    // hid behind. If this stops matching, the source half of this file proves nothing.
    expect(src.get('cg.ts'), 'cg -> geometry (import type)').toContain('geometry.ts');
    // An `export ... from` re-export, which is the only shape `index.ts` has.
    expect(src.get('index.ts'), 'index -> hittest (export from)').toContain('hittest.ts');
    // And the direction that must NOT exist, stated positively so the extraction cannot quietly
    // come back: the shared drawing types are a LEAF, imported by everything and importing
    // nothing.
    expect(src.get('geometry.ts'), 'geometry must import no sibling').toEqual([]);
  });

  it('is acyclic in the BUILT output too, whose edges are the ones that run', () => {
    const dist = graphOf(distDir, '.js');
    expect([...dist.keys()], 'no dist/*.js -- run npm run build').toContain('drawlist.js');
    const cycle = findCycle(dist);
    expect(cycle === null ? '' : `runtime import cycle: ${cycle.join(' -> ')}`).toBe('');
    // Every runtime edge must also be a source edge. Not a restatement of the cycle check: it is
    // what makes the two halves comparable, so a source regex that stopped matching a form shows
    // up here as a dist edge with no source counterpart rather than as a green vacuous scan.
    for (const [file, edges] of dist) {
      const from = file.replace(/\.js$/, '.ts');
      for (const edge of edges) {
        expect(src.get(from) ?? [], `dist ${file} imports ${edge}, source does not`)
          .toContain(edge.replace(/\.js$/, '.ts'));
      }
    }
  });

  it('leaves dist/cg.js and dist/hittest.js with NO imports at all', () => {
    // Both are pure arithmetic over their arguments and both say in their own docstrings that this
    // is why they can be used from anywhere -- `hittest.js` is SERVED to the browser
    // (`BROWSER_MODULES`, `assets.ts:39`) and `cg.js` is imported by `keypad.js`, which the
    // renderer must not reach. Their `import type` lines erase; a value import would not, and the
    // cycle checks above cannot see the difference because a one-way edge is not a cycle.
    for (const file of ['cg.js', 'hittest.js']) {
      const text = readFileSync(join(distDir, file), 'utf8');
      expect(text.match(/^import\b.*$/gm) ?? [], `${file} must import nothing`).toEqual([]);
    }
  });
});
