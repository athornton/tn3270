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

/**
 * THE FIVE IPC CHANNEL NAMES MUST AGREE ACROSS THREE FILES, and nothing else checks that.
 *
 * `transferPreload.cts` names all five, `main.ts` registers the three the renderer calls, and
 * `transferWindow.ts` sends the two that go the other way. They are STRING LITERALS in three
 * separate files -- `TransferDeps.send`'s parameter type pins the two outbound ones to the
 * controller's own spelling, but nothing relates either side to the preload's.
 *
 * The failure mode of a typo is the one this whole window has met five ways already: `invoke` on
 * an unregistered channel rejects with "No handler registered for 'transfer:submit'", so Start
 * does nothing and the form reports an error that names an internal channel; a misspelled
 * `transfer:progress` is worse, because `ipcRenderer.on` simply never fires and the operator
 * watches a transfer report no progress at all, with nothing in any console. Neither is visible
 * to a unit test of either half, and neither is visible to `tsc`.
 *
 * SOURCE TEXT, like the servability check above, because that is what a test outside Electron can
 * reach: `ipcMain` and `contextBridge` cannot be constructed here.
 */
describe('the transfer window IPC channels agree across main, preload and controller', () => {
  const read = (...parts: string[]): string =>
    readFileSync(join(guiDir, ...parts), 'utf8');
  /** Every `transfer:<name>` literal in a file, deduplicated. */
  const channels = (src: string): string[] =>
    [...new Set([...src.matchAll(/'(transfer:[a-z]+)'/g)].map((m) => m[1]!))].sort();

  const PRELOAD = ['transfer:browse', 'transfer:cancel', 'transfer:done',
    'transfer:progress', 'transfer:submit'];

  it('the preload bridges exactly the five channels the two sides implement', () => {
    expect(channels(read('src', 'transferPreload.cts'))).toEqual(PRELOAD);
  });

  it('main registers every channel the renderer CALLS, and no others', () => {
    // The three inbound ones. `transfer:done` and `transfer:progress` travel the other way --
    // `webContents.send` is reached through `TransferDeps.send`, so main never names them.
    expect(channels(read('src', 'main.ts')))
      .toEqual(['transfer:browse', 'transfer:cancel', 'transfer:submit']);
  });

  it('the controller sends exactly the two channels the renderer LISTENS on', () => {
    expect(channels(read('src', 'transferWindow.ts')))
      .toEqual(['transfer:done', 'transfer:progress']);
  });

  it('together the two sides cover the preload exactly, with nothing left dangling', () => {
    const served = [...new Set([
      ...channels(read('src', 'main.ts')),
      ...channels(read('src', 'transferWindow.ts')),
    ])].sort();
    expect(served, 'a channel in the preload that nobody implements is a silently dead control')
      .toEqual(PRELOAD);
  });
});

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
