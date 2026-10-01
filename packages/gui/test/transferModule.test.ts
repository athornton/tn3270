import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The transfer window loads `transferForm.js` DIRECTLY in a browser context, by relative path
 * from `transfer.html`. That is only possible because the compiled module has no runtime
 * imports -- exactly the justification `packages/canvas/src/hittest.ts` carries for being its
 * own module.
 *
 * MEASURED 2026-10-01: 9139 bytes, zero `import` statements, zero `require` calls. (The spec
 * recorded 9141 on 2026-09-30; the ellipsis-ligature fix moved it by two bytes, which is why
 * the SIZE is not asserted and the IMPORTS are.) That is a
 * FACT WITH A DATE, not an invariant: the day someone adds a runtime import to
 * `transferForm.ts`, this window goes blank with no error in any console -- the signature this
 * repo has now met five separate ways. So the premise is asserted, not assumed.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(guiDir));
const formJs = join(repoRoot, 'packages', 'frontend', 'dist', 'transferForm.js');

describe('transferForm.js is servable to a browser', () => {
  it('has no runtime imports, so a file:// page can load it by relative path', () => {
    const src = readFileSync(formJs, 'utf8');
    // Static `import`/`export ... from` both emit a specifier a browser must resolve. A bare
    // one (`@tn3270/core`) cannot be resolved without a bundler.
    const specifiers = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]!);
    expect(specifiers, `transferForm.js must import nothing at runtime, found: ${specifiers.join(', ')}`)
      .toEqual([]);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it('still exports the functions the transfer window needs', () => {
    const src = readFileSync(formJs, 'utf8');
    for (const name of [
      'TRANSFER_FIELDS', 'newTransferForm', 'cycleField', 'setFieldText',
      'applicable', 'formKeywords', 'moveField',
    ]) {
      expect(src, `transferForm.js must export ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
