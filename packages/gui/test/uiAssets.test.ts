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
 *
 * `keypad.html` joined when the keypad window was built. Note what this checks for it and what it
 * does NOT: that its `./ui.css` and `./dist/keypadBoot.js` exist on disk, NOT that the bare
 * specifier inside that module resolves -- the import map is a different mechanism and
 * `keypadModule.test.ts` walks it. Two tests because they catch two unrelated failures, both of
 * which look identical from outside: a window with nothing in it.
 */
const DOCUMENTS = ['index.html', 'transfer.html', 'keypad.html', 'keyboard.html'];

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

  /**
   * BOTH KEYBOARD SURFACES MUST CARRY `.keyboard-surface`, AND THIS IS THE ONLY CHEAP CHECK OF IT.
   *
   * `ui.css` splits the keyboard's rules in two (2026-10-23): `.keyboard-surface` holds the
   * KEYBOARD -- the pitch, the font, every cap's width calc -- and `#keyboard-overlay` holds only
   * the web page's framing of it. The Electron window carries the class with none of the framing,
   * which is what the split exists for.
   *
   * SO A SURFACE MISSING THE CLASS LOSES `--kb-pitch` and every cap computes its width from an
   * undefined variable. That is NOT a blank window: it is a visibly wrong keyboard, which is the
   * harder failure to read -- and `.ui-surface button { padding: 3px 12px }` still applies, so it
   * looks like a styled keyboard rather than an unstyled one.
   *
   * MEASURED, not assumed: dropping the class from `index.html` fails `browser-clicks.mjs`'s
   * keyboard phase outright. That harness is the real cover, because it measures the RENDERED
   * geometry in a browser; this test is the fast one that names the cause, and it is also the only
   * cover the GUI document has until Task 7's harness phase exists.
   */
  it('puts .keyboard-surface on BOTH keyboard surfaces, the window and the web overlay', () => {
    const win = readFileSync(join(guiDir, 'keyboard.html'), 'utf8');
    expect(win, 'keyboard.html lost .keyboard-surface, so the caps have no pitch')
      .toMatch(/class="[^"]*keyboard-surface/);
    /*
      THE WEB PAGE TOO, FROM THIS TEST, because the class is a CONTRACT WITH `ui.css` and that
      file lives in `packages/gui`. Checking only the document in this package would leave the
      other half of the same contract to a harness -- and `packages/web` has no unit test that
      reads its HTML at all.
    */
    const web = readFileSync(
      join(dirname(guiDir), 'web', 'static', 'index.html'), 'utf8');
    expect(web, 'index.html lost .keyboard-surface, so the caps have no pitch')
      .toMatch(/id="keyboard-overlay"[^>]*class="[^"]*keyboard-surface/);
  });

  /**
   * THE SPLIT ITSELF, asserted on `ui.css` rather than on either document.
   *
   * The two tests above say the surfaces claim the class. This says the class is worth claiming:
   * the pitch must be declared ON `.keyboard-surface`, because that is the half that is easiest to
   * get wrong -- `--kb-pitch` LOOKS like framing (it sets how big the thing is) and is not. On the
   * id it would be absent in the Electron window and every width calc there would resolve against
   * nothing.
   */
  it('declares --kb-pitch on the CLASS, so both surfaces get it', () => {
    const css = readFileSync(join(guiDir, 'ui.css'), 'utf8');
    const classBlock = /\.keyboard-surface\s*\{([^}]*)\}/.exec(css);
    expect(classBlock, 'ui.css has no .keyboard-surface block at all').not.toBeNull();
    expect(css, '--kb-pitch is not declared anywhere').toContain('--kb-pitch:');
    // THE DECLARATION'S OWN BLOCK, not merely its presence in the file: the whole defect being
    // guarded is the pitch sitting in the WRONG selector, which a file-wide match cannot see.
    const pitchOwner = /([^{}]+)\{[^}]*--kb-pitch:/.exec(css);
    expect(pitchOwner?.[1], '--kb-pitch must be declared on .keyboard-surface, not on the overlay')
      .toContain('.keyboard-surface');
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
