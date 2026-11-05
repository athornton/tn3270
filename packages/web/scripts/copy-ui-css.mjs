/**
 * Copies `packages/gui/ui.css` into this package's `dist/` at build time.
 *
 * ONE SOURCE, A GENERATED COPY: `httpstatic.ts` explains why the file lives in `gui` and why a
 * second COMMITTED copy is wrong. A build output is not a second source -- `dist/` is
 * gitignored and regenerated every build -- and it is the only way an installed `@tn3270/web`
 * can have the file, since this package cannot depend on `@tn3270/gui` (Electron).
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
mkdirSync(dist, { recursive: true });
copyFileSync(join(here, '..', '..', 'gui', 'ui.css'), join(dist, 'ui.css'));
