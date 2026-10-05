import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Every stylesheet and script an HTML surface asks for must EXIST on disk.
 *
 * ## WHY THIS IS A TEST AND NOT A HARNESS CHECK
 *
 * MEASURED 2026-10-06, while extracting `ui.css` out of `transfer.html`: pointing that document
 * at `./nonexistent.css` leaves `transfer.mjs` at a full **10/10**. The Xvfb harness drives
 * BEHAVIOR -- it fills fields, submits, and reads the outcome -- and an unstyled window behaves
 * identically to a styled one. So the one failure mode this extraction introduced is the one
 * nothing in the gate could see: the whole feature works, and looks like a 1993 form.
 *
 * That is the same shape as the recorded blank-window family, one notch less severe: a missing
 * MODULE kills the window silently, a missing STYLESHEET merely disfigures it silently.
 *
 * ## IT PARSES THE HTML RATHER THAN LISTING THE FILES
 *
 * Naming `ui.css` here would be a second copy of the reference and would pass while the `href`
 * was wrong -- which is the entire bug class. Reading the attribute out of the document and
 * resolving it the way a browser would is what makes this answer the real question.
 *
 * Only RELATIVE paths are checked. An absolute URL would be a remote asset, which no surface
 * here has and which this test should not start permitting by accident.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Every `href`/`src` in a document, as written. */
function assetRefs(html: string): string[] {
  return [
    ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]!),
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!),
  ];
}

/**
 * The documents this package serves to a renderer.
 *
 * `index.html` IS INCLUDED even though it is the canvas page with no shared CSS: it carries the
 * renderer's own `<script src>`, which is exactly the blank-window case, and a page added to this
 * package later should land in this list rather than be forgotten.
 */
const DOCUMENTS = ['index.html', 'transfer.html'];

describe('the GUI s HTML surfaces', () => {
  it('reference only assets that EXIST, resolved as a browser would', () => {
    for (const doc of DOCUMENTS) {
      const path = join(guiDir, doc);
      expect(existsSync(path), `${doc} itself is missing`).toBe(true);
      const refs = assetRefs(readFileSync(path, 'utf8'));
      // A document with NO refs at all would pass this loop vacuously, so the count is asserted
      // too -- both of these pages load at least a script.
      expect(refs.length, `${doc} references no assets, which cannot be right`)
        .toBeGreaterThan(0);
      for (const ref of refs) {
        if (!ref.startsWith('.')) continue;          // not a relative file
        const target = resolve(dirname(path), ref);
        expect(existsSync(target), `${doc} -> ${ref} does not exist (${target})`).toBe(true);
      }
    }
  });

  it('keeps the transfer window on the SHARED stylesheet, not an inlined copy', () => {
    // The user's requirement is that the transfer window and the keypad look alike, and one
    // stylesheet is how that is enforced rather than hoped for. A re-inlined `<style>` block
    // would pass the existence check above while silently re-forking the chrome.
    const html = readFileSync(join(guiDir, 'transfer.html'), 'utf8');
    expect(html).toContain('href="./ui.css"');
    expect(html, 'transfer.html has re-inlined its CSS').not.toMatch(/<style>/);
  });
});
