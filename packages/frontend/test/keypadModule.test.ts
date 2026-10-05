import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The keypad modules a BROWSER loads must stay resolvable without a bundler.
 *
 * ## WHAT THIS PROTECTS, AND WHY IT IS NOT HYPOTHETICAL
 *
 * `gui/keypad.html` (Task 5) carries an import map resolving `@tn3270/frontend` to
 * `keypadView.js`, so that module's whole runtime graph has to CLOSE inside
 * `packages/frontend/dist`. A runtime import of anything else -- most dangerously the package
 * BARREL, which reaches `tls.js` and its `node:net`/`node:tls`/`node:fs` -- is a specifier no
 * browser can resolve, and the failure arrives as a BLANK WINDOW WITH NO ERROR in any console.
 * This repo has met that shape five separate ways, which is why it is a test and not a comment.
 *
 * `transferModule.test.ts` is the precedent and pins the identical property for
 * `transferForm.js`.
 *
 * ## IT READS THE BUILT JAVASCRIPT, DELIBERATELY
 *
 * `import type` erases at compile time, so the SOURCE would show imports that do not exist at
 * run time and miss none that do. Only `dist/` answers the question a browser asks.
 *
 * ## A FACT WITH A DATE, NOT AN INVARIANT
 *
 * Measured 2026-10-06: `keypad.js` and `bindings.js` each had ZERO runtime imports, and
 * `keypadView.js` imported exactly those two. Nothing stops a future edit adding a third -- and
 * if that third reaches core, the window goes blank. That is what this file exists to catch, so
 * it asserts the CLOSURE rather than the two names: a new leaf is fine if it is itself clean.
 */
const frontendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(frontendDir, 'dist');

/** Every relative specifier in a built module, as written. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [
    ...[...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
  ];
}

describe('the keypad modules a browser loads', () => {
  it('were built (run npm run build first)', () => {
    for (const f of ['keypadView.js', 'keypad.js', 'bindings.js']) {
      expect(existsSync(join(distDir, f)), `missing dist/${f}`).toBe(true);
    }
  });

  it('reach NO workspace package anywhere in the graph', () => {
    /**
     * THE WHOLE POINT. A bare `@tn3270/...` specifier in any module a browser fetches is
     * unresolvable there. Walked transitively rather than checked on the entry point, because
     * the entry point importing a clean-looking leaf that itself imports core is exactly the
     * shape that would slip through -- the same walker argument `canvas/test/renderer-imports.ts`
     * makes for the renderer.
     */
    const seen = new Set<string>();
    const queue = ['keypadView.js'];
    const offenders: string[] = [];
    while (queue.length > 0) {
      const name = queue.pop()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const file = join(distDir, name);
      if (!existsSync(file)) continue;
      for (const spec of importsOf(file)) {
        if (spec.startsWith('@tn3270/')) { offenders.push(`${name} -> ${spec}`); continue; }
        // `node:` is equally fatal in a browser, and `tls.js` is how it would arrive.
        if (spec.startsWith('node:')) { offenders.push(`${name} -> ${spec}`); continue; }
        if (spec.startsWith('.')) queue.push(spec.replace(/^\.\//, ''));
      }
    }
    expect(offenders, 'these run in the browser and would blank the keypad window').toEqual([]);
    // NAMED EDGES, so a walker that silently stopped following cannot pass the scan above by
    // finding nothing. `length > 1` could not tell "found everything" from "found something".
    expect(seen.has('keypad.js'), 'keypad.js not reached').toBe(true);
    expect(seen.has('bindings.js'), 'bindings.js not reached').toBe(true);
  });

  it('does NOT reach the package barrel, which pulls node: builtins in through tls.js', () => {
    // Asserted as its own case because it is the specific mistake someone would make: importing
    // from `../src/index.js` for convenience. `index.js` re-exports `tls.js`, whose `node:net`,
    // `node:tls` and `node:fs` imports no browser can resolve.
    for (const name of ['keypadView.js', 'keypad.js', 'bindings.js']) {
      const specs = importsOf(join(distDir, name));
      expect(specs, `${name} imports the barrel`).not.toContain('./index.js');
    }
  });
});
