import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The keypad window's browser-side graph must be resolvable by a browser.
 *
 * ## THE FAILURE THIS CATCHES IS A BLANK WINDOW WITH NO ERROR
 *
 * `keypad.html` loads `dist/keypadBoot.js` as a module and carries an import map with exactly ONE
 * entry, `@tn3270/frontend` -> `../frontend/dist/keypadView.js`. So every bare specifier in this
 * window's graph must be that one string: a browser has no bundler, an unmapped bare specifier
 * 404s, and the window comes up with a title and nothing else. This repo has met that shape five
 * separate ways, which is why it is a test and not a comment.
 *
 * `transferModule.test.ts` is the precedent and pins the same property for the transfer window;
 * `frontend/test/keypadModule.test.ts` pins the far side of this same map entry.
 *
 * ## IT READS THE BUILT JAVASCRIPT, DELIBERATELY
 *
 * `import type` erases at compile time, so the SOURCE shows imports a browser never fetches and
 * hides none that it does. Only `dist/` answers the question a browser actually asks.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(guiDir, 'dist');

/** Every specifier in a built module, static and dynamic. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [
    ...[...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
  ];
}

/** The import map's entries, read out of the document rather than restated. */
function mappedSpecifiers(): string[] {
  const html = readFileSync(join(guiDir, 'keypad.html'), 'utf8');
  const block = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (block === null) throw new Error('keypad.html has no import map');
  const parsed = JSON.parse(block[1]!) as { imports?: Record<string, string> };
  return Object.keys(parsed.imports ?? {});
}

describe('the keypad window s browser graph', () => {
  it('was built (run npm run build first)', () => {
    for (const f of ['keypadBoot.js', 'keypadUi.js']) {
      expect(existsSync(join(distDir, f)), `missing dist/${f}`).toBe(true);
    }
    expect(existsSync(join(distDir, 'keypadPreload.cjs')),
      'missing dist/keypadPreload.cjs -- an ESM preload cannot load, so this must be .cjs')
      .toBe(true);
  });

  it('uses only specifiers the import map actually resolves', () => {
    /**
     * THE WHOLE POINT, and it compares against the map READ FROM THE DOCUMENT rather than against
     * a hardcoded `'@tn3270/frontend'`. Restating the string here would be a second copy of the
     * reference that passes while the map is wrong -- which is the bug class itself.
     *
     * Walked transitively from the entry point, because a clean-looking module importing a second
     * one that reaches core is exactly what would slip past a check on the entry alone.
     */
    const mapped = mappedSpecifiers();
    expect(mapped, 'the import map is empty').not.toEqual([]);

    const seen = new Set<string>();
    const queue = ['keypadBoot.js'];
    const offenders: string[] = [];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const file = join(distDir, name);
      if (!existsSync(file)) continue;
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) { queue.push(spec.replace(/^\.\//, '')); continue; }
        // `node:` is as fatal in a browser as an unmapped package, and would arrive the same way.
        if (!mapped.includes(spec)) offenders.push(`${name} -> ${spec}`);
      }
    }
    expect(offenders, 'these are unresolvable in a browser and would blank the keypad window')
      .toEqual([]);
    // NAMED EDGE, so a walker that silently stopped following cannot pass the scan above by
    // finding nothing at all.
    expect(seen.has('keypadUi.js'), 'keypadUi.js was not reached from keypadBoot.js').toBe(true);
  });

  it('keeps the preload OUT of that graph, because it is not a module', () => {
    // `keypadPreload.cjs` is loaded by Electron from an absolute path in main, not imported by
    // the page. If it ever appeared in the page's graph that would mean someone had imported it,
    // which cannot work: it calls `contextBridge`, which exists only in a preload context.
    const graph = importsOf(join(distDir, 'keypadBoot.js'))
      .concat(importsOf(join(distDir, 'keypadUi.js')));
    expect(graph.some((s) => s.includes('keypadPreload'))).toBe(false);
  });
});
