import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * The bundled `app/` documents reference only files INSIDE `app/`.
 *
 * A SECOND COPY OF A CHECK `scripts/bundle.mjs` ALREADY RUNS, on purpose and with a known limit.
 * The bundle refuses to finish if any of this fails, which is the real gate: it runs every time
 * an `app/` is produced. This test exists so a hand-edited or partially-copied `app/` is caught
 * by the ordinary suite too. It SKIPS when there is no bundle -- which in the plain
 * `npm run build && npx vitest run` gate is always, because nothing there runs `bundle:gui` --
 * so a green here with the skip says nothing about the bundle, and is not claimed to.
 *
 * Unlike `uiAssets.test.ts` this checks EVERY `src`/`href` from any tag, not only `<link>` and
 * `<script>`: in the bundle anything at all that reaches out of `app/` is a broken install.
 */
const app = join(dirname(dirname(fileURLToPath(import.meta.url))), 'app');
const bundled = existsSync(join(app, 'BUNDLED'));

describe.skipIf(!bundled)('the bundled app/ (skipped: no packages/gui/app/BUNDLED; run npm run bundle:gui)', () => {
  const docs = bundled ? readdirSync(app).filter((f) => f.endsWith('.html')) : [];

  it('has every document main.ts loads', () => {
    expect(docs.sort()).toEqual(['connect.html', 'index.html', 'keyboard.html', 'keypad.html', 'transfer.html']);
  });

  it('carries no import map and references nothing outside app/', () => {
    for (const doc of docs) {
      const html = readFileSync(join(app, doc), 'utf8');
      expect(html, `${doc} kept an import map`).not.toMatch(/type\s*=\s*"importmap"/);
      const refs = [...html.matchAll(/\s(?:src|href)\s*=\s*"([^"]*)"/g)].map((m) => m[1]!);
      expect(refs.length, `${doc} references nothing`).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref, `${doc} -> ${ref}`).not.toContain('../');
        expect(ref, `${doc} -> ${ref} is not app-relative`).toMatch(/^\.\//);
        expect(existsSync(resolve(app, ref)), `${doc} -> ${ref} is not in app/`).toBe(true);
      }
    }
  });

  it('has a manifest Electron can start from', () => {
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(pkg['type']).toBe('module');
    expect(existsSync(join(app, String(pkg['main'])))).toBe(true);
    for (const f of ['atlas.json', 'atlas.bin', 'preload.cjs', 'ui.css']) {
      expect(existsSync(join(app, f)), f).toBe(true);
    }
  });
});
