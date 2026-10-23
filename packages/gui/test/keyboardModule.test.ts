import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * EVERY SPECIFIER THE KEYBOARD WINDOW'S MODULE GRAPH USES MUST BE ANSWERED BY ITS IMPORT MAP.
 *
 * ## WHY THIS IS A DIFFERENT TEST FROM `keypadModule.test.ts`, NOT A COPY OF IT
 *
 * That test forbids EVERY bare `@tn3270/` specifier in the keypad's graph, because `keypad.html`
 * maps exactly two and the graph is supposed to close inside `frontend/dist`. **THE KEYBOARD'S
 * GRAPH DELIBERATELY DOES NOT CLOSE THAT WAY.** `keyboardUi.ts` imports
 * `@tn3270/frontend/dist/keyboard3279.js` by DEEP PATH, and its own header records that this is
 * FORCED: `web/static/index.html` already resolves the bare `@tn3270/frontend` to
 * `keypadView.js`, one specifier cannot name two files, and that module exports no
 * `KEYBOARD_3279`.
 *
 * So a blanket ban would be the wrong property here and would fail on correct code. THE RIGHT
 * PROPERTY IS A ROUND TRIP: walk the built graph, collect every specifier a browser would have to
 * resolve, and require the document's own map to answer each one -- then require each ANSWER to
 * exist on disk.
 *
 * ## THE FAILURE THIS CATCHES IS A BLANK WINDOW WITH NO ERROR
 *
 * An unmapped bare specifier is unresolvable in a browser and there is NO BUNDLER here. The
 * measured symptom is recorded in `canvas/src/keyboardUi.ts`: the module fails to evaluate, so
 * nothing downstream is assigned, and the console blames an unrelated file
 * (`Cannot read properties of undefined (reading 'onAtlas')`). This repo has met that shape five
 * separate ways, which is why it is a test and not a comment.
 *
 * ## IT READS THE BUILT JAVASCRIPT, DELIBERATELY
 *
 * `import type` erases at compile time, so the SOURCE would show imports that do not exist at run
 * time and miss none that do. Only `dist/` answers the question a browser asks -- and the one
 * import that erases here (`keymap.js`, type-only) is mapped anyway, because mapping it costs a
 * line and a future edit turning it into a value import would otherwise blank the window.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packagesDir = dirname(guiDir);

/** Every specifier in a built module, as written. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [
    ...[...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!),
  ];
}

/** The `imports` object out of a document's import map. */
function importMapOf(html: string): Record<string, string> {
  const block = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  expect(block, 'keyboard.html has no import map at all').not.toBeNull();
  return (JSON.parse(block![1]!) as { imports: Record<string, string> }).imports;
}

describe('the keyboard window s module graph', () => {
  it('was built (run npm run build first)', () => {
    for (const f of [
      join(packagesDir, 'canvas', 'dist', 'keyboardUi.js'),
      join(packagesDir, 'frontend', 'dist', 'keyboard3279.js'),
      join(guiDir, 'dist', 'keyboardBoot.js'),
    ]) {
      expect(existsSync(f), `missing ${f}`).toBe(true);
    }
  });

  it('has every @tn3270 specifier in the graph ANSWERED by keyboard.html s import map', () => {
    const map = importMapOf(readFileSync(join(guiDir, 'keyboard.html'), 'utf8'));
    /*
      WALKED TRANSITIVELY FROM THE BOOT MODULE, which is what the browser actually fetches first.
      An entry point importing a clean-looking leaf that itself imports core is exactly the shape
      that slips through a check on the entry point alone -- the same walker argument
      `keypadModule.test.ts` and `canvas/test/renderer-imports.ts` both make.

      The queue holds ABSOLUTE paths, because this graph crosses three packages: a relative
      specifier resolves against the importing file's own directory, and treating them all as
      names relative to one `dist/` -- which is what the keypad's single-package walker can do --
      would silently stop following at the first package boundary and find nothing.
    */
    const seen = new Set<string>();
    const queue = [join(guiDir, 'dist', 'keyboardBoot.js')];
    const unmapped: string[] = [];
    const missing: string[] = [];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!existsSync(file)) continue;
      for (const spec of importsOf(file)) {
        if (spec.startsWith('.')) { queue.push(resolve(dirname(file), spec)); continue; }
        // `node:` is fatal in a browser however it arrives, and no map entry makes it legal.
        if (spec.startsWith('node:')) { unmapped.push(`${file} -> ${spec}`); continue; }
        const answer = map[spec];
        if (answer === undefined) { unmapped.push(`${spec} (imported by ${file})`); continue; }
        /*
          AND THE ANSWER MUST EXIST. A map entry pointing at a path that is not there is the same
          blank window as no entry at all -- resolved relative to the DOCUMENT, which is how a
          browser resolves a map address: against the document's base URL, not the importer's.
        */
        const target = resolve(guiDir, answer);
        if (!existsSync(target)) missing.push(`${spec} -> ${answer} (${target})`);
        queue.push(target);
      }
    }
    expect(unmapped, 'these specifiers would be unresolvable and blank the keyboard window')
      .toEqual([]);
    expect(missing, 'these map entries point at files that do not exist').toEqual([]);
    /*
      NAMED EDGES, so a walker that silently stopped following cannot pass the two scans above by
      finding nothing. `seen.size > 1` could not tell "followed everything" from "followed one
      step" -- and this walk crossing TWO package boundaries is the whole reason it is written the
      hard way.
    */
    expect([...seen].some((f) => f.endsWith('keyboardUi.js')),
      'the walk never reached canvas/dist/keyboardUi.js').toBe(true);
    expect([...seen].some((f) => f.endsWith('keyboard3279.js')),
      'the walk never reached frontend/dist/keyboard3279.js').toBe(true);
  });

  it('does NOT map the package barrel, which pulls node: builtins in through tls.js', () => {
    /*
      Asserted as its own case because it is the specific mistake someone would make: mapping
      `@tn3270/frontend` to `../frontend/dist/index.js` for convenience, which reaches `tls.js`
      and its `node:net`/`node:tls`/`node:fs`. The walk above would catch the resulting `node:`
      imports; this names the cause at the map instead of at the leaf.
    */
    const map = importMapOf(readFileSync(join(guiDir, 'keyboard.html'), 'utf8'));
    for (const [spec, answer] of Object.entries(map)) {
      expect(answer, `${spec} points at a package barrel`).not.toMatch(/dist\/index\.js$/);
    }
  });
});
