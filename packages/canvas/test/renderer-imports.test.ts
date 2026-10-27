import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The renderer's runtime graph must contain no workspace import.
 *
 * A browser cannot resolve a bare specifier like `@tn3270/core`; there is no bundler. The
 * failure mode is what makes this worth a test: the window goes BLANK WITH NO ERROR, and
 * nothing in the suite notices. `drawList` runs in main for exactly this reason, and this
 * pins the boundary rather than trusting a comment to be read.
 *
 * `import type` is invisible here because it erases at compile time -- which is why this
 * test reads the BUILT javascript rather than the TypeScript source.
 *
 * The walker sees static `import ... from '...'` / `export ... from '...'` and dynamic
 * `import('...')`, in both their relative-specifier (followed into the graph) and
 * `@tn3270/`-specifier (flagged as an offender) forms. It does NOT see a specifier built at
 * runtime from a variable (e.g. `import(pkgName)`) -- no regex can, and catching that would
 * need real bundler-grade analysis, not a text scan.
 */
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(pkgDir, 'dist');

/** Every local module reachable from an entry point, following relative imports. */
function graphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(resolvePath(dirname(file), m[1]!));
    }
    for (const m of text.matchAll(/import\(\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(resolvePath(dirname(file), m[1]!));
    }
  }
  return [...seen];
}

describe('the renderer bundle', () => {
  it('was built (run npm run build first)', () => {
    expect(existsSync(join(distDir, 'renderer.js')), `missing ${distDir}/renderer.js`).toBe(true);
  });

  it('imports no workspace package anywhere in its runtime graph', () => {
    const graph = graphFrom(join(distDir, 'renderer.js'));
    // Not `length > 1`: that cannot distinguish "found everything" from "found something",
    // and a walker that silently stopped following edges would still pass it. Naming the
    // real edges means a missed one fails here rather than turning the offender scan below
    // into a scan of nothing.
    expect(graph.some((f) => f.endsWith('keys.js')), 'keys.js not reached').toBe(true);
    expect(graph.some((f) => f.endsWith('blit.js')), 'blit.js not reached').toBe(true);
    // The third real edge. It was `hittest.js` until 2026-10-06, since the renderer hit-tested a
    // keypad click itself; that module went with the canvas keypad, and `selection.js` -- which the
    // copy/paste gesture added -- is now the third thing the renderer reaches. Named for the same
    // reason as the other two: an unnamed edge is one the walker may quietly stop following.
    expect(graph.some((f) => f.endsWith('selection.js')), 'selection.js not reached').toBe(true);
    const offenders: string[] = [];
    for (const file of graph) {
      const text = readFileSync(file, 'utf8');
      if (/(?:from|import)\s*['"]@tn3270\//.test(text)) offenders.push(file);
      else if (/import\(\s*['"]@tn3270\//.test(text)) offenders.push(file);
    }
    expect(offenders, 'these run in the renderer and would blank the window').toEqual([]);
  });

  /*
    THE PASTE GATE'S CALL SITE, AND IT IS HERE BECAUSE NOTHING ELSE COULD SEE IT. 2026-10-26.

    `forwardPaste` (`forwardKeys.ts`) will not install its `paste` listener unless the protocol it
    is HANDED is the web gateway's, and 11 unit tests drive that gate directly. What no unit test
    can reach is whether `renderer.ts` hands it the REAL one: the call site touches `location`, so
    it cannot be imported under `environment: 'node'`.

    MEASURED, which is why this exists at all: replacing `protocol: location.protocol` with a
    literal `protocol: 'https:'` and rebuilding leaves THE WHOLE SUITE GREEN -- 110 files, 2602
    tests. That mutant re-arms the hazard the gate was added for, since the Electron GUI's page is
    `file:` and would then install a listener whose `paste` action freezes the main process.

    A TEXT ASSERTION ON THE BUILT ARTIFACT, following the `selection.js` case below, which reads
    `dist/` as text for its own reason. The alternative considered and REJECTED was a `Ctrl+v`
    negative case in `gui/scripts/keys.mjs`, which looked closer to the original measurement and
    is a worse test: MEASURED both ways, it depends on the X11 CLIPBOARD HAVING CONTENT. With an
    empty clipboard the mutant passes it (`ok 21 chords`, because an empty paste is declined
    before any action is sent); with a clipboard primed by a second live Electron it does catch
    the mutant, but by HANGING -- the frozen client ignored SIGTERM and the harness died of
    `ETIMEDOUT` rather than reporting. A check that needs an X selection owner and fails by
    timeout is not one CI can rely on.

    SCOPED TO THE CALL AND NOT TO THE FILE, deliberately, and VERIFIED in both directions rather
    than eyeballed: `renderer.js`'s own comment block contains the words `location.protocol` as
    PROSE, so a bare substring scan PASSES on the mutated call site -- checked, the mutant text
    still matches `/location\.protocol/`. That is the precise mistake the `selection.js` case
    below records under "MATCHED ON THE IMPORT FORM".

    THE BOUND IS `{0,400}?` AND NOT `[^)]*`, which was the first attempt and was wrong: the
    object's own `on:` member is an arrow taking `(type, handler)`, so a no-close-paren class
    cannot reach `protocol:` at all and the assertion FAILED ON A CORRECT BUILD. A counted bound
    keeps the match inside the `forwardPaste({...})` argument -- measured at 210 characters in the
    current emit, so 400 is roughly double -- without caring what punctuation the members contain.
    If a member is ever added that pushes the call past the bound, this goes red on a correct
    build, which is the safe direction to fail in.
  */
  it('passes the DOCUMENT\'s protocol into the paste gate, not a literal', () => {
    const text = readFileSync(join(distDir, 'renderer.js'), 'utf8');
    expect(
      /forwardPaste\(\{[\s\S]{0,400}?protocol:\s*location\.protocol/.test(text),
      'renderer.js must pass `location.protocol` to forwardPaste: the gate that keeps a paste '
      + 'action out of the Electron GUI (where it FREEZES the main process) is only real if the '
      + 'renderer hands it the document\'s own protocol. A literal here re-arms that hazard and '
      + 'no other test in the repo can see it.',
    ).toBe(true);
  });

  /*
    THE ORDER OF TWO LINES IS THE WHOLE BEHAVIOR OF COPY, 2026-10-27.

    `renderer.ts`'s keydown listener clears the selection on every CLAIMED key, because a key that
    changes the screen invalidates a highlight drawn over the old text. `requestCopy` is the one
    claimed kind that changes nothing, and it is the one kind that READS the selection -- so it
    must be intercepted BEFORE `clearSelection()`. Below that call it still compiles, still
    typechecks, and copies nothing at all every time: `copySelection()` would find
    `anchor === null` and return false WITHOUT SENDING A FRAME, so the gesture becomes silently
    inert. (That is `copySelection()` and not `__tn3270Copy` -- the global is the Electron menu's
    route and is not on the keydown path at all; both end at the same body, which is why the
    distinction never changes the outcome, only who is to blame.) MEASURED from the outside
    2026-10-27: `browser-clicks.mjs` reported the page sending `[]` and the gateway logging
    nothing.

    A TEXT ASSERTION ON THE BUILT ARTIFACT, following the two cases above, and for the same reason:
    `renderer.ts` touches `window` at module load, so no unit test can import it and observe the
    listener. The ordering is only visible in the emit.

    COMMENTS ARE STRIPPED BEFORE THE SCAN, which is the correction this test's first draft needed.
    The plan proposed a bare `js.indexOf('requestCopy')`, and the arm's OWN comment block explains
    the hazard at length and therefore contains the word `requestCopy` as prose -- several times,
    and ABOVE the code. A bare substring scan would have found that prose, measured its position
    as the "arm", and passed on a build where the arm had been deleted outright. The same mistake
    is recorded under "MATCHED ON THE IMPORT FORM" below and for `location.protocol` above; this is
    its third appearance in this file, which is why the stripper is shared from here on.

    Stripping is safe on THIS emit rather than in general: verified that no string or template
    literal in `renderer.js` contains `//` or an opening block-comment marker, so there is nothing
    for a naive stripper to mistake for a comment. `tsc` emits no minification and renames no
    members, so `action.kind === 'requestCopy'` survives verbatim.

    MATCHED ON THE COMPARISON AND NOT THE BARE WORD, so the thing being pinned is the ARM -- a
    dispatch on the kind -- and not any mention of it.

    WHAT THIS TEST DOES NOT COVER, MEASURED 2026-10-27 RATHER THAN REASONED. It pins an ORDER, so
    it is satisfied by any emit in which the arm precedes a `clearSelection()` -- INCLUDING one
    whose arm is `copySelection(); clearSelection(); return;`. That mutant is a copy that succeeds
    and then destroys the selection, breaking `copySelection`'s "an operator who copies twice gets
    the same text twice" contract, and it left ALL 2614 TESTS IN 110 FILES GREEN, this one among
    them. `web/scripts/browser-clicks.mjs`'s `webCopy` is the only thing that failed: it presses
    the real chord twice over two different clipboard sentinels, which is the assertion an order
    scan cannot make. Stated here so nobody reads this test as cover for selection SURVIVAL -- it
    covers only that the arm is reachable with a selection still in hand.
  */
  it('intercepts requestCopy BEFORE clearSelection, or copy copies nothing', () => {
    const js = readFileSync(join(distDir, 'renderer.js'), 'utf8');
    // Block comments first, then line comments: the reverse order lets a `//` inside a block
    // comment truncate that block's opening line and leave its body behind as "code".
    const code = js
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    const arm = code.search(/action\.kind\s*===\s*['"]requestCopy['"]/);
    expect(
      arm,
      'renderer.js must dispatch on `action.kind === \'requestCopy\'` in the keydown listener: '
      + 'the chord is claimed by actionForKey, applyAction THROWS on the kind (which freezes the '
      + 'Electron main process) and the web gateway refuses it at decode, so a front end that '
      + 'does not consume it here has a broken copy gesture at best.',
    ).toBeGreaterThan(-1);

    const clear = code.indexOf('clearSelection()', arm);
    expect(
      clear,
      'and `clearSelection()` must come AFTER that arm. Below the arm the selection survives the '
      + 'copy; above it the rectangle is destroyed a moment before it is read, and the gesture '
      + 'copies nothing while every type check still passes.',
    ).toBeGreaterThan(arm);
  });

  it('confirms drawlist.js is NOT in that graph, since it imports core and frontend', () => {
    // This is implied by the offender scan above, since drawlist.js's own @tn3270/core import
    // would already be caught if drawlist.js ever entered the graph. It earns its place anyway:
    // if it fails, it names the regression precisely -- palette or draw-list work moved into
    // the renderer -- rather than leaving whoever broke it to work backward from a generic
    // offender list.
    const graph = graphFrom(join(distDir, 'renderer.js'));
    expect(graph.some((f) => f.endsWith('drawlist.js'))).toBe(false);
  });

  it('can import selection.js, whose whole graph is itself', () => {
    /*
      THIS TEST WAS ABOUT `hittest.js` UNTIL 2026-10-06, and the property it pins is worth keeping
      even though its subject changed. The keypad's hit test was the one part of `keypad.ts` the
      RENDERER needed, and importing it from `keypad.js` would have pulled in `drawlist.js`,
      `@tn3270/core` and `@tn3270/frontend` -- MEASURED during review, when both assertions failed.
      It therefore lived in its own module whose only import was an erasing `import type`.

      `selection.js` is in exactly that position now: the renderer needs `normalizeRect` and
      `isEmptyRect`, its only import is `import type { ResolvedCell }`, and taking them from the
      barrel instead would blank the window. The point of pinning it HERE rather than trusting the
      offender scan above is that the scan reports a generic list, where this names the module --
      and that it fails as a RED TEST rather than as a blank window.
    */
    const graph = graphFrom(join(distDir, 'selection.js'));
    expect(graph.map((f) => f.replace(`${distDir}/`, ''))).toEqual(['selection.js']);
    // MATCHED ON THE IMPORT FORM, not on the bare string `@tn3270/`, and that is a correction the
    // switch of subject forced: `selection.js`'s own docstring EXPLAINS the hazard and so contains
    // `@tn3270/core` as prose. The old `hittest.js` happened not to mention it, so a substring
    // test passed there and would fail here for the wrong reason -- rejecting a file whose only
    // offence is documenting the rule it obeys.
    const text = readFileSync(join(distDir, 'selection.js'), 'utf8');
    const specifiers = [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers, 'selection.js must import nothing at runtime').toEqual([]);
  });
});
