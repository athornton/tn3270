import type { Rgb } from '@tn3270/core';
import type { AtlasGeometry } from './geometry.js';
import type { DrawList } from './drawlist.js';
import { actionForKey } from './keys.js';
import { forwardCopy, forwardPaste, isEditableTarget } from './forwardKeys.js';
import { blit, bestScale, center, tintKey, type Ctx2D } from './blit.js';
// FROM THE MODULE AND NOT FROM THE BARREL (`./index.js`), which would be the natural reach and
// would BLANK THIS WINDOW WITH NO ERROR: the barrel re-exports `drawlist.js`, which value-imports
// `@tn3270/core`, and a browser has no bundler to resolve a bare specifier.
// `renderer-imports.test.ts` walks this file's built graph to catch exactly that. `selection.ts`
// itself is safe here -- its only workspace import is an `import type`, which erases.
import { normalizeRect, movedPastThreshold, type CellAddr, type CellRect } from './selection.js';
// The same rule as `selection.js` above, and served from `BROWSER_MODULES` for the same reason.
// `copyCache.ts`'s only import is `import type { CellRect }`, which erases.
import { createCopyCache } from './copyCache.js';

/**
 * The renderer: a canvas, key events, and nothing else.
 *
 * ## EVERY RUNTIME IMPORT HERE IS RELATIVE, AND THAT IS A HARD CONSTRAINT
 *
 * This file is loaded by the browser as a module from `file://`. A browser cannot resolve a
 * bare specifier like `@tn3270/core`, and this project has no bundler -- measured, not
 * assumed: an earlier version imported `drawList` and died with "Failed to resolve module
 * specifier", leaving a blank window and no clue anywhere. So the draw list arrives finished
 * over IPC, the atlas arrives as bytes over IPC, and the only runtime imports are
 * `./blit.js`, `./keys.js`, `./selection.js`, `./forwardKeys.js` and `./copyCache.js`, whose own
 * imports are either `import type` and thus erased or (for `forwardKeys.js`) `./keys.js`, already
 * here. EACH ONE IS ALSO LISTED IN `BROWSER_MODULES` (`assets.ts`), without which the web front end
 * serves a 404 for it and the canvas goes black instead -- measured twice now, for
 * `selection.js` and again for `forwardKeys.js` on 2026-10-23. ADDING AN IMPORT HERE IS A CHANGE
 * TO THE WEB GATEWAY, and the test that fails on the omission lives in `web`, so run the whole
 * suite rather than this package's.
 *
 * IF YOU ADD A RUNTIME IMPORT FROM A WORKSPACE PACKAGE HERE, THE WINDOW GOES BLANK.
 * Compute it in main and send the result instead.
 *
 * ## THE TINT CACHE
 *
 * The atlas is coverage, not color. Each color gets one pre-tinted copy, built on first
 * use and kept: a 3279 has sixteen colors, so the cache is bounded by the palette rather
 * than by the screen. Tinting per cell would be 1920 composites a frame.
 */

/** What the preload bridge puts on `window`. See preload.cts. */
declare global {
  interface Window {
    tn3270: {
      onAtlas(fn: (atlas: AtlasMessage) => void): void;
      onFrame(fn: (list: DrawList) => void): void;
      onError(fn: (message: string) => void): void;
      sendAction(action: unknown): void;
      /** OPTIONAL: the gateway's bridge has it, Electron's preload does not. See bridgecore.ts. */
      fetchSelection?(rect: CellRect): Promise<string>;
      /** OPTIONAL, the same way: a failed clipboard write, painted as a notice. See bridgecore.ts. */
      onCopyFailed?(fn: (message: string) => void): void;
    };
  }
}

interface AtlasMessage {
  geometry: AtlasGeometry;
  /** Structured-cloned, so this arrives as a Uint8Array. */
  coverage: Uint8Array;
  blank: number[];
}

const canvas = document.querySelector<HTMLCanvasElement>('#screen');
if (canvas === null) throw new Error('no #screen canvas in the document');
const real = canvas.getContext('2d');
if (real === null) throw new Error('no 2D context: the window cannot draw');
// `Ctx2D` narrows `fillStyle` to string so blit.ts needs no DOM types and stays testable
// with a recorder. Sound because nothing here assigns a gradient or a pattern: a 3270 cell
// is a flat color.
const ctx = real as unknown as Ctx2D;

let atlas: AtlasMessage | undefined;
let blank: ReadonlySet<number> = new Set();
let last: DrawList | undefined;
/**
 * The selection, in CELL coordinates, with `anchor` where the drag began and `focus` where it is
 * now. Both null means no selection.
 *
 * RENDERER-LOCAL AND DELIBERATELY NOT IN THE `DrawList`: the draw list comes from main, and
 * selection is a display concern the renderer owns. Main learns about it only when a copy is asked
 * for, and then only as a RECTANGLE -- it cannot learn the text from here, because a `DrawCell`
 * carries a CG-order atlas glyph and no character. (Contrast the KEYPAD, which IS in the draw
 * list -- because `gui/src/main.ts` sizes the window from `list.height`, so a renderer-owned
 * keypad would be clipped.)
 *
 * `dragging` is separate from "has a selection" ON PURPOSE: the mouse release ends the drag but
 * must KEEP the selection, because the operator presses Copy afterwards. Clearing on release would
 * make every copy impossible.
 *
 * `pressAt` AND `moved` DECIDE CLICK OR DRAG, 2026-11-03. `pressAt` is where the button went down,
 * in `clientX`/`clientY`; `moved` latches true once the pointer has gone `movedPastThreshold` from
 * it, and only then is there a selection -- see `selectedRect()`. Before this the rule was the
 * rectangle's SIZE (`isEmptyRect`: 1x1 is a click), which made a single character unselectable.
 */
let anchor: CellAddr | null = null;
let focus: CellAddr | null = null;
let dragging = false;
let pressAt: { x: number; y: number } | null = null;
let moved = false;
/**
 * The selection's prefetched text, 2026-11-02 -- see `copyCache.ts`. Invalidated exactly where the
 * selection dies, which is `clearSelection()` below and a new press on the screen, so a frame from
 * the host (whose `onFrame` calls `clearSelection()`) can never leave text for a vanished screen.
 *
 * ONLY EVER FILLED ON THE GATEWAY'S PAGE: `prefetchSelection` returns at once when the bridge has
 * no `fetchSelection`, which is the Electron GUI's normal `file:` window, so there it stays empty
 * and every copy gesture takes the path it took before this existed. Electron's `TN3270_GUI_URL`
 * mode is NOT that case: it loads the gateway's page with the gateway's bridge (no preload), so
 * the cache fills and `copyByChord` runs `execCommand` there. That is web behaviour by design --
 * the window is a browser on the gateway, and its copy reaches the gateway's `selection` arm.
 */
const copyCache = createCopyCache();
/**
 * Set by `forwardCopy`'s `onHandled` whenever its listener took a copy event. Read only by
 * `copyByChord`, to learn whether its `execCommand('copy')` reached that listener.
 *
 * DECLARED HERE, ABOVE EVERY CLOSURE THAT TOUCHES IT, so it has no temporal dead zone to reason
 * about: a `let` does not hoist the way the function declarations that read it do.
 */
let copyHandled = false;

/**
 * Forget the selection. One function and not two assignments at four call sites, so a later edit
 * cannot clear one half and leave the other -- this project has been bitten five times by
 * one-path-clears-and-another-doesn't, most recently when closing a parent window skipped the
 * child's close handler.
 */
function clearSelection(): void {
  anchor = null;
  focus = null;
  dragging = false;
  pressAt = null;
  moved = false;
  copyCache.invalidate();
}

/**
 * The current selection's rectangle, or `null` when there is none.
 *
 * THE ONE PREDICATE FOR "IS THERE A SELECTION", read by the highlight in `paint`, by
 * `prefetchSelection`, by `copySelection` and by `cachedSelection`, so the four can never disagree
 * -- a highlight with nothing to copy, or a copy of a rectangle nobody can see. Until 2026-11-03
 * three of them each called `isEmptyRect` on their own `normalizeRect`, and `cachedSelection` did
 * not, which was harmless only because the cache is never filled for an empty rect.
 *
 * `moved` IS PART OF IT, and that is the whole fix: a press that has not left the threshold is a
 * click, whatever the rectangle, and a press that has is a selection even when it never left its
 * cell. A function and not a cached value, so it cannot go stale against the three variables.
 */
function selectedRect(): CellRect | null {
  if (anchor === null || focus === null || !moved) return null;
  return normalizeRect(anchor, focus);
}
/**
 * True while the canvas holds an ERROR MESSAGE rather than a screen.
 *
 * `onError` repaints the canvas as text but leaves `last` alone, so without this a click at a
 * button's former position still passed the keypad guard: it sent the action into a session that is
 * failing or already gone, and its `paint(last)` WIPED THE ONLY EXPLANATION OF THE FAILURE off the
 * screen, restoring a stale one. Someone who double-clicked a `.app` has no console to recover it
 * from -- the same argument `onError` itself is written on.
 */
let errored = false;
/**
 * True while what `errored` covers is only a COPY NOTICE (`onCopyFailed`), not a real error.
 * 2026-11-03.
 *
 * A notice keeps the selection and its cached text -- nothing on the screen changed -- so three
 * things may lift it that must never lift a real error: a later copy that succeeds repaints the
 * screen with its highlight, a press on the canvas dismisses it and starts a drag, and a drag's
 * prefetch is not refused. A real error (`onError`) always sets this false, so a socket-closed
 * message is never painted over by a copy or a click.
 */
let noticeOnly = false;

const tints = new Map<string, ImageBitmap>();
const building = new Set<string>();

/** One tinted atlas per color: coverage written into the alpha channel. */
function tintOf(color: Rgb): ImageBitmap | undefined {
  if (atlas === undefined) return undefined;
  const key = tintKey(color);
  const got = tints.get(key);
  if (got !== undefined) return got;
  if (building.has(key)) return undefined;
  building.add(key);

  const w = atlas.geometry.cols * atlas.geometry.cellWidth;
  const h = atlas.geometry.cellHeight;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < atlas.coverage.length; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = atlas.coverage[i]!;
  }
  void createImageBitmap(new ImageData(data, w, h)).then((bmp) => {
    tints.set(key, bmp);
    building.delete(key);
    // A color arriving late must not leave a hole: repaint once it is ready.
    if (last !== undefined) paint(last);
  });
  return undefined;
}

function paint(list: DrawList): void {
  last = list;
  if (atlas === undefined || canvas === null) return;   // nothing to draw with yet

  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(list, within);
  const at = center(list, within, scale);

  /**
   * THE CANVAS IS AT LEAST AS BIG AS THE DRAWING, NEVER JUST THE VIEWPORT.
   *
   * MEASURED against live VM/370 through the web gateway, 2026-09-16: a model-4 screen is 43 rows,
   * which with the OIA is 44 x 14 = 616px, and in an 800x600 viewport the OIA row was **entirely off
   * the bottom of the capture** -- the whole operator status line gone, silently, with no error
   * anywhere. That is the same bug the Electron GUI hit on ITS first live run, and there main can fix
   * it by resizing the window. A BROWSER PAGE CANNOT RESIZE ITS WINDOW, so the renderer has to stop
   * losing the data instead: sizing the canvas to the drawing lets the page scroll to reach it.
   *
   * `bestScale` floors at 1 and `center` clamps its offsets at 0, so neither of them saves this.
   *
   * NO EFFECT ON ELECTRON, which is why it is safe to change a file both front ends share: main sets
   * the content size to exactly `list.width * scale` by `list.height * scale`, so the `max` picks the
   * viewport and this line does what it always did. Both GUI goldens still match byte for byte.
   */
  canvas.width = Math.max(within.width, list.width * scale);
  canvas.height = Math.max(within.height, list.height * scale);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const options = {
    atlas: atlas.geometry,
    scale,
    offsetX: at.x,
    offsetY: at.y,
    blank,
    // undefined skips the glyph this frame; tintOf repaints when the bitmap is ready.
    tinted: (color: Rgb): unknown | undefined => tintOf(color),
  };
  blit(ctx, list, options);

  // The OIA goes through the SAME blitter and atlas -- see the note on DrawList.oia. Passed
  // as a one-row list so the blitter's only job stays "draw these cells".
  if (list.oia !== undefined) {
    blit(ctx, { cells: list.oia.cells, width: list.width, height: list.height }, options);
  }

  // THE KEYPAD'S BLIT AND ITS PRESS HIGHLIGHT WERE HERE AND ARE GONE, 2026-10-06. Neither front
  // end draws a keypad into the canvas now -- Electron opens a window of real HTML controls, the
  // browser shows an overlay -- so `DrawList` has no `keypad` region to blit and there is no
  // `pressed` button to wash over. The zero-latency press feedback that block existed for is now
  // the browser's own `:active` styling, which costs no round trip either.
  //
  // What went with it: a `KeypadButton | undefined` module-local, an identity check against the
  // current frame's buttons (so a model switch mid-press could not highlight a stale rectangle),
  // and the `rgba(0,0,0,0.35)` wash that had to be re-derived once already when `keypad.ts` moved
  // to inverse video. None of it has a consumer; see the note in `index.ts`.

  /**
   * THE SELECTION HIGHLIGHT, inverse video over the selected cells.
   *
   * `difference` COMPOSITION RATHER THAN A FIXED INVERSE COLOR, which is what makes one line work
   * for every palette scheme: it inverts whatever is already under it, so there is no per-scheme
   * inverse table to keep in step with `palette.ts`. Drawn as an OVERLAY and not by re-blitting the
   * glyphs, so a selection can never change which character is on screen.
   *
   * GATED ON `selectedRect()`, so a plain click -- a press the pointer did not move past
   * `movedPastThreshold` -- draws nothing. Without that every click would flash a one-cell block.
   * A drag that moved but stayed in one cell DOES draw its cell: that is a one-character selection.
   *
   * THE GOLDENS MUST NOT MOVE because of this. `shot.mjs`'s three cases have no selection, so this
   * block cannot execute in them; if a golden does move, that is a real failure meaning the
   * highlight draws when nothing is selected, and NOT a golden to regenerate.
   *
   * LAST, after the keypad and its press wash, for the same reason the press highlight is last
   * among those: it sits over what it marks. It cannot stray onto the keypad or the OIA anyway --
   * `cellAt` bounds every cell it returns to the screen region.
   */
  const rect = selectedRect();
  if (rect !== null && atlas !== undefined) {
    const g = atlas.geometry;
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(
      at.x + rect.left * g.cellWidth * scale,
      at.y + rect.top * g.cellHeight * scale,
      (rect.right - rect.left + 1) * g.cellWidth * scale,
      (rect.bottom - rect.top + 1) * g.cellHeight * scale,
    );
    ctx.restore();
  }
}

window.tn3270.onAtlas((message) => {
  atlas = message;
  blank = new Set(message.blank);
  // This repaint also PAINTS OVER an error message, so the click guard lifts with it -- inside the
  // `if`, because with no frame yet there is nothing to paint and the message stays up.
  if (last !== undefined) { errored = false; noticeOnly = false; paint(last); }
});

// A frame means the session is drawing again, so whatever `onError` put up is both gone and stale.
//
// AND IT INVALIDATES THE SELECTION, because a new frame means the cells those coordinates named
// now hold different text. Keeping the highlight across a repaint would offer the operator a copy
// of text that is no longer there -- and main extracts from the CURRENT snapshot, so the rectangle
// would silently pick up whatever replaced it.
window.tn3270.onFrame((list) => { errored = false; noticeOnly = false; clearSelection(); paint(list); });

/**
 * Paint `message` in red over the whole canvas. The ONE painter for both `onError` and
 * `onCopyFailed`, so the two cannot drift in how a message looks.
 *
 * Failures must be VISIBLE: someone who double-clicked a .app has no console. This is the
 * one place canvas text is used, deliberately -- an error message is our own chrome, is
 * never compared against a golden, and must stay readable at any window size.
 *
 * Sets `errored`, so stray clicks cannot act on a screen the operator cannot see; the caller
 * decides `noticeOnly` and the selection.
 */
function paintMessage(message: string): void {
  if (canvas === null || real === null) return;
  errored = true;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  real.fillStyle = '#000';
  real.fillRect(0, 0, canvas.width, canvas.height);
  real.fillStyle = '#ff5555';
  real.font = '15px monospace';
  let y = 40;
  for (const line of wrap(message, Math.max(20, Math.floor(canvas.width / 9)))) {
    real.fillText(line, 20, y);
    y += 21;
  }
}

window.tn3270.onError((message) => {
  // A REAL ERROR: the screen the operator was looking at is gone or failing.
  noticeOnly = false;
  // THE SELECTION DIES WITH THE SCREEN IT DESCRIBED, and its prefetched text with it (`941949d`).
  // The message paints over the whole canvas, so the highlight is no longer visible -- yet without
  // this, Cmd-C or the chord after a socket close would copy cached text from a screen the
  // operator can no longer see. Nothing needs the selection to survive: the mousedown guard
  // refuses new drags while a real error is up, and the next frame would clear it anyway.
  //
  // THIS RUNS IN THE ELECTRON GUI TOO, which registers `onError` through `preload.cts` and paints
  // its own failures here; there it clears a selection that `__tn3270Copy` (the Edit menu) could
  // otherwise still read. UNCHANGED for real errors by 2026-11-03's fix, which moved only the
  // web gateway's "copy failed" reports off this path, onto `onCopyFailed` below.
  clearSelection();
  paintMessage(message);
});

/*
  A FAILED COPY IS A NOTICE, NOT A SCREEN FAILURE, 2026-11-03. Only the web gateway's bridge has
  this (`bridgecore.ts`'s `onCopyFailed`); Electron copies through IPC and never reports this way.

  IT KEEPS THE SELECTION AND ITS CACHED TEXT, and that is the fix. A copy pressed before the
  prefetch answered takes the async fallback, which on a plain-`http` LAN page has no clipboard
  API -- and Firefox's Edit > Copy made then is refused with `NotAllowedError` the same way. The
  remedy is to press copy again once the prefetch has landed, when the cached path needs no secure
  context. Through `onError` the second press found `clearSelection()` had run: no selection, no
  text, nothing copied, and a re-drag refused while `errored`.

  WHAT STILL INVALIDATES THE SELECTION is everything that really changes the screen, none of
  which is touched here: every frame (`onFrame`), every claimed key, a paste, a new press.
*/
window.tn3270.onCopyFailed?.((message) => {
  // AN ERROR ALREADY UP STAYS THE STORY: a copy notice must not downgrade a socket-closed message
  // into something a click dismisses. Unreachable today (a closed socket answers no copy), kept so
  // the invariant does not rest on that.
  if (errored && !noticeOnly) return;
  noticeOnly = true;
  paintMessage(message);
});

window.addEventListener('keydown', (e) => {
  /**
   * A KEYSTROKE AIMED AT A REAL FORM CONTROL IS NOT FOR THE 3270 SCREEN.
   *
   * MEASURED 2026-10-07 by the `browser-clicks.mjs` transfer phase, which found this as a live
   * bug: typing into the web gateway's transfer form sent every character TO THE MAINFRAME and
   * left the field empty. This listener is on `window`, so it sees events whose target is
   * `#transfer-localFile`; `actionForKey` claims any single-code-point key as `{kind:'type'}`
   * without knowing what was focused; and the `preventDefault()` below then suppressed the
   * character the operator was trying to type. Proved three ways -- no `input` event at all, the
   * gateway's own action log showing `{"kind":"type","text":"a"}` for a letter typed into a text
   * field, and the character arriving correctly once propagation stopped at the overlay.
   *
   * NOT A WEB-ONLY FIX. `renderer.js` is loaded by `gui/index.html` too, and the Electron GUI's
   * windows are separate `BrowserWindow`s only by luck of this feature's design -- the keypad
   * overlay already puts real `<button>`s in the SAME document as the canvas, and a future
   * in-window control would have hit this immediately.
   *
   * CHECKED BEFORE `actionForKey` RATHER THAN INSIDE IT, because `keys.ts` is deliberately
   * DOM-free: `KeyLike` carries six scalar fields and no target, which is what lets its 26 cases
   * run under `environment: 'node'` with no jsdom. The target is a property of the EVENT, so the
   * code that owns real events owns this question.
   *
   * The predicate counts `isContentEditable` for completeness; nothing here uses it today.
   */
  // THE PREDICATE NOW LIVES IN `forwardKeys.ts` and is shared with the GUI's child windows, which
  // need the identical rule. The long note above is why it exists; this is now the only copy.
  if (isEditableTarget(e.target as { tagName?: unknown; isContentEditable?: unknown } | null)) {
    return;
  }
  const action = actionForKey(e);
  if (action === null) return;
  // preventDefault only for keys we CLAIMED, so shortcuts we do not use keep working and
  // Tab does not move focus out of the canvas.
  e.preventDefault();
  /*
    COPY IS INTERCEPTED HERE AND MUST NOT FALL THROUGH TO `clearSelection()`.

    `requestCopy` is an INTENT and not a wire action: `actionForKey` raises it from
    `Ctrl-Shift-C` / `Cmd-Shift-C` knowing only that keys were pressed, and this file is the only
    place that knows WHICH CELLS are selected. `copyByChord` consumes it, so the kind never reaches
    `sendAction`: with the selection's text prefetched it raises the browser's own `copy` event and
    `forwardCopy` sets the text synchronously (2026-11-02), and otherwise it falls back to
    `copySelection`, which turns it into the real `{kind:'copy', rect}` as before.

    THE ORDER OF THESE LINES IS THE BEHAVIOR. Every other claimed key clears the selection, because
    the screen is about to change and a highlight over changed text would offer a copy of something
    never seen. A copy changes NOTHING and is the one claimed kind that READS the selection -- so
    clearing first would destroy the rectangle a moment before building it, and the prefetched
    text with it (`clearSelection()` invalidates the cache). `copyByChord` would find nothing
    cached, and `copySelection` would find `anchor === null`, return false and copy nothing.
    Both paths read the selection, so the argument is unchanged by the cache. Moving this arm below
    `clearSelection()` STILL COMPILES AND STILL TYPECHECKS while silently breaking the gesture,
    which is why `test/renderer-imports.test.ts` pins the order in the built artifact.

    NO RESULT IS KEPT, unlike the global's boolean: `copyByChord` returns nothing. A chord pressed
    with nothing selected is not worth a message -- the menu item needs to tell that
    from "copied" because a harness asserts on it; a keystroke has nobody to tell.

    A FRONT END THAT FORGOT THIS ARM FAILS LOUDLY RATHER THAN BEING SILENTLY INERT, which is why
    the kind has no handler downstream: `applyAction` THROWS on `requestCopy` and the web gateway
    refuses it at decode with a per-client `error` frame. The two-step shape here is the one
    `transferForm` already uses -- a renderer-side intent that becomes a different action -- and
    NOT `toggleKeypad`, which is a single kind terminally intercepted in main.
  */
  if (action.kind === 'requestCopy') { copyByChord(); return; }
  // ANY OTHER KEYSTROKE THAT DOES SOMETHING INVALIDATES THE SELECTION, for the reason above.
  //
  // AFTER the `action === null` return above, so a key we did NOT claim leaves the selection alone:
  // the Copy accelerator itself arrives as a keystroke, and clearing on unclaimed keys would wipe
  // the selection a moment before main asked for it. On macOS the Electron menu consumes that
  // accelerator before the page sees it, so it never reaches this listener at all; a browser has no
  // menu, and there `Ctrl-Shift-C` is CLAIMED and handled by the arm above. (Before 2026-10-27 it
  // was unclaimed on Linux and survived by not being in `actionForKey`'s table. It is in the table
  // now, so the selection survives a copy by the explicit exemption above and not by accident.)
  clearSelection();
  window.tn3270.sendAction(action);
});

/*
  THE BROWSER'S OWN `Ctrl-V`, 2026-10-26.

  THE RULES AND THE SAFETY GATE ARE IN `forwardKeys.ts`, not here, and the gate is the reason this
  is a call rather than an inline `window.addEventListener('paste', ...)`. THIS FILE IS LOADED BY
  TWO FRONT ENDS -- `gui/index.html`'s `<script src="../canvas/dist/renderer.js">` tag pulls this
  same file into the Electron GUI, cited by tag because that document is five lines long -- and
  an ungated listener would raise `{kind:'paste'}` there, where nothing intercepts it and
  `applyAction` throws: MEASURED to FREEZE the main process event loop, not merely log. The
  injected `protocol` is what confines it to the web gateway. Read `forwardPaste`'s docstring
  before changing either side; it records what was measured and the invariant that keeps it true.

  `location.protocol` IS READ HERE AND PASSED IN, because this is the file that owns real browser
  globals -- the same division that keeps `forwardKeys.ts` testable under `environment: 'node'`.
*/
forwardPaste({
  on: (type, handler) => { window.addEventListener(type, handler as (e: Event) => void); },
  sendAction: (action) => { window.tn3270.sendAction(action); },
  protocol: location.protocol,
  clearSelection,
});

// THE BROWSER'S OWN COPY EVENT, `Cmd-C` on macOS, Edit > Copy, and `copyByChord`'s
// `execCommand('copy')`, 2026-11-02. It sets the prefetched text when there is some and falls back
// to `copySelection` when not. Same gate as paste; `forwardCopy`'s docstring says why it cancels
// the event only when text was set, and why `Ctrl-C` cannot reach it and so stays Clear.
// `cachedSelection` and `copySelection` are function declarations further down, and hoist;
// `copyHandled` is declared above, beside the selection, so nothing here touches a TDZ.
forwardCopy({
  on: (type, handler) => { window.addEventListener(type, handler as (e: Event) => void); },
  protocol: location.protocol,
  cached: cachedSelection,
  copySelection,
  onHandled: () => { copyHandled = true; },
  onCopied: copiedFromCache,
});

/**
 * A copy just succeeded from the cache. If only a copy NOTICE is up, take it down and repaint the
 * screen -- the selection is still set, so its highlight draws -- so the operator can SEE that this
 * press worked where the last one failed. 2026-11-03. A real error is never painted over.
 *
 * CALLED INSIDE THE `copy` EVENT, after `setData` and `preventDefault`, and painting there is safe:
 * `paint` is plain synchronous canvas drawing that touches neither the event nor the selection
 * nor the cache, so the clipboard write the browser performs after the handler returns is
 * unaffected by it. Synchronous enough, too: the canvas commits at the next rendering
 * opportunity like any other paint. A glyph whose tint is not built yet is repainted by
 * `tintOf`'s own callback, but every tint was built when the screen was first drawn.
 */
function copiedFromCache(): void {
  if (!errored || !noticeOnly || last === undefined) return;
  errored = false;
  noticeOnly = false;
  paint(last);
}

/**
 * A click on a keypad button.
 *
 * THE INVERSE OF THE DRAWING ARITHMETIC: the draw list is in scale-1 pixels and `paint` multiplies
 * by `scale` and adds the centring offset, so a click subtracts that offset and divides by the
 * scale. Getting it backwards puts the hit some multiple of the scale away from the finger, and at
 * scale 1 it would look correct -- which is why `browser-shot.mjs` runs at a size where the scale is
 * 1 and the click harness must not.
 *
 * `mousedown`, not `click`: the press highlight should appear under the finger, and a `click` only
 * arrives after release.
 *
 * `offsetX`/`offsetY` and NOT `clientX - getBoundingClientRect().left`, and the reason is NOT that
 * one is element-relative and the other is not: it is that `offsetX` and `at` are measured from the
 * SAME ORIGIN, the canvas's own box, so the expression has NO SCROLL TERM AT ALL to get wrong. The
 * web page really does scroll -- `paint` sizes the canvas to the drawing and
 * `web/static/index.html:10` is `overflow:auto` -- and the rect form would reach the same number
 * only because the rect moves with the scroll.
 *
 * Two things a reader will suspect, neither of which is a problem here. `devicePixelRatio`: the
 * backing store and the CSS box are 1:1 at any dpr, because `paint` assigns `canvas.width` from
 * `window.innerWidth`, which is already CSS pixels. A CSS `width`/`height` on the canvas WOULD break
 * this -- `offsetX` would be in CSS pixels of a stretched box and would need a
 * `canvas.width / rect.width` factor, as would the rect form -- and both pages style the canvas
 * `display:block` and nothing else. A `transform: scale()` is NOT that case: `offsetX` stays in the
 * element's own untransformed space, where the rect form does not, so there it is the better API
 * rather than an equally wrong one.
 *
 * Primary button only. `mousedown` fires for the right and middle buttons too, and a keypad that
 * sent `clear` or a PF key to a live host on a right-click -- while the context menu opened over
 * it -- would be a misfire the operator never asked for.
 */
/**
 * A mouse position in the canvas's own space to a SCREEN cell, or `null` if it is not on one.
 *
 * ## THE ARITHMETIC IS `hitTestAt`'s INVERSE, OFFSET AND ALL
 *
 * `paint` multiplies the scale-1 draw list by `scale` and adds the centring offset `at`, so going
 * back subtracts `at` and divides by `scale` -- exactly what `hitTestAt` did for a keypad button,
 * before the canvas keypad (and `hitTestAt` with it) was deleted in favor of a real HTML window.
 * The plan for this feature omitted the offset and divided only by the scale, which is correct ONLY
 * when the drawing exactly fills the viewport: `center` clamps at 0, so in a window wider than the
 * screen every selected cell would be shifted left by the margin, and at scale 1 in a tight window
 * it would look perfect -- the same trap `browser-shot.mjs` runs at scale 1 to expose.
 *
 * `offsetX`/`offsetY` for the reason the `mousedown` handler below documents at length: they and
 * the draw list's `at` are measured from the SAME origin, the canvas's own box, so the expression
 * has no scroll term at all to get wrong.
 *
 * ## THE BOUNDS COME FROM THE DRAW LIST'S REGIONS, NOT FROM A ROW COUNT
 *
 * A selection must cover the 3270 SCREEN and not the OIA or the keypad -- copying the operator
 * status line as if it were host data would be a lie about what is on the screen. The screen's
 * bottom edge is therefore whichever region starts first below it (`oia.y`, else `keypad.y`, else
 * the drawing's full height), which is how `drawlist.ts` computes them in the first place; deriving
 * it from `list.height` alone would include both. Columns come from `list.width`, which IS
 * `cols * cellWidth` by construction.
 */
function cellAt(offsetX: number, offsetY: number, list: DrawList): CellAddr | null {
  if (atlas === undefined) return null;
  const g = atlas.geometry;
  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(list, within);
  const at = center(list, within, scale);
  const x = (offsetX - at.x) / scale;
  const y = (offsetY - at.y) / scale;
  if (x < 0 || y < 0) return null;
  // THE OIA IS STILL EXCLUDED, which is why this is not simply `list.height`: copying the
  // operator status line as if it were host data would be a lie about what is on the screen.
  // The keypad was a THIRD term here until 2026-10-06, so a selection drag could not run onto
  // it; it left the canvas, and a `?? list.keypad?.y` that can never fire is a reader trap.
  // `select.mjs` is what proves this simplification did not move the bound.
  const screenBottom = list.oia?.y ?? list.height;
  const cols = Math.floor(list.width / g.cellWidth);
  const rows = Math.floor(screenBottom / g.cellHeight);
  const col = Math.floor(x / g.cellWidth);
  const row = Math.floor(y / g.cellHeight);
  if (col >= cols || row >= rows) return null;
  return { row, col };
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // Read the module state ONCE: everything below must agree about which frame was clicked.
  const list = last;
  // A COPY NOTICE DOES NOT BLOCK A PRESS, A REAL ERROR DOES: the notice changed nothing on the
  // screen, so a press on it dismisses it and starts a drag as normal (`paint(list)` below, or the
  // returns, which leave the notice up only for a press off the screen region); a real error
  // still refuses, so the click cannot act on a session that is failing or gone.
  if ((errored && !noticeOnly) || list === undefined) return;
  // A SELECTION DRAG STARTS WHEN THE PRESS IS ON THE SCREEN. The keypad gets first refusal below,
  // so a press on a button is a button press and not the start of a selection -- and this cannot
  // be a separate listener for exactly that reason: two listeners would both act on one press.
  //
  // A PRESS OFF THE SCREEN REGION NOW DOES NOTHING, where it used to fall through to a keypad
  // hit test. `cellAt` returns null for the OIA row and for anything past the last column, and
  // there is no longer a second claimant for those pixels: the keypad left the canvas on
  // 2026-10-06. Nothing to send, so nothing to do.
  const cell = cellAt(e.offsetX, e.offsetY, list);
  if (cell === null) return;
  // A NEW PRESS ON THE SCREEN REPLACES THE SELECTION, so its prefetched text dies with it. After
  // the `cell === null` return, matching the selection: a press on the OIA leaves both alone.
  copyCache.invalidate();
  anchor = cell;
  focus = cell;
  dragging = true;
  // CLIENT COORDINATES FOR THE THRESHOLD, NOT `offsetX`, and the asymmetry with `cellAt` above is
  // deliberate. `offsetX` is relative to the EVENT'S TARGET, and the `mousemove` that compares
  // against this point is on the WINDOW: over the canvas its target is the canvas, but over an
  // overlay or the page margin it is that element, and the two `offsetX`s would be from different
  // origins. `clientX`/`clientY` are viewport-relative whatever the target, so the press and every
  // move are measured from one origin. (A scroll mid-drag would shift them by the scroll; a drag of
  // a few pixels does not scroll the page, and a drag long enough to is past the threshold anyway.)
  pressAt = { x: e.clientX, y: e.clientY };
  moved = false;
  errored = false;
  noticeOnly = false;
  paint(list);
});

/**
 * End a drag.
 *
 * `mouseup` ON THE WINDOW covers a release outside the canvas, and outside the window too:
 * Chromium takes native mouse capture on `mousedown`, so the release is still delivered here.
 * `blur` covers what capture cannot -- focus lost mid-drag by Alt+Tab, an X grab, a lock screen or
 * a native context menu. Without both, `dragging` would latch on and every later `mousemove` would
 * keep extending a selection with no button held.
 *
 * THE SELECTION ITSELF SURVIVES, deliberately: the operator presses Copy after releasing the
 * mouse, so clearing it here would make every copy impossible. Only the drag ends.
 *
 * IT USED TO CLEAR A KEYPAD PRESS HIGHLIGHT TOO, which is why it was called `release` and why it
 * returned early when no button was held -- a shape that once made `dragging = false` dead code
 * when it was appended after that guard. The keypad left the canvas on 2026-10-06 and the guard
 * went with it, leaving the one assignment this function now exists for.
 */
function release(): void {
  dragging = false;
}

/**
 * A drag that ENDED ON A REAL RECTANGLE asks the gateway for its text, so a later copy event can
 * set it synchronously. 2026-11-02. Only on `mouseup`: `blur` also releases, but nobody selected
 * anything by switching windows, and a drag cut short that way just leaves the cache empty -- every
 * gesture then falls back. A plain click (a press that never passed the drag threshold) asks for
 * nothing; a drag within one cell asks for that one character.
 *
 * RETURNS AT ONCE WHERE THE BRIDGE HAS NO `fetchSelection`, which is the Electron GUI: its preload
 * supplies only the four required functions, so there nothing is ever asked for or cached.
 *
 * THE `catch` IS LOAD-BEARING. `fetchSelection` rejects when the socket closes and when a newer
 * request supersedes it, and an unhandled rejection is this repo's most-recorded silent failure.
 * A failed prefetch leaves the cache empty, and every gesture then falls back -- so nothing is
 * painted here.
 */
function prefetchSelection(): void {
  const fetchSelection = window.tn3270.fetchSelection;
  // NOT WHILE A REAL ERROR IS UP: `onError` cleared the selection, and nothing on screen to copy.
  // A copy NOTICE does not block it -- it keeps the selection, and the mousedown that began this
  // drag has already dismissed it.
  if ((errored && !noticeOnly) || fetchSelection === undefined) return;
  const rect = selectedRect();
  if (rect === null) return;
  const gen = copyCache.begin(rect);
  fetchSelection.call(window.tn3270, rect)
    .then((text) => { copyCache.accept(gen, text); })
    .catch(() => { /* the cache stays empty; every gesture falls back */ });
}

// `dragging` IS READ BEFORE `release()` CLEARS IT, so only a release that ends a drag THIS PAGE
// started prefetches. A press off the screen region, on an overlay or outside the window never set
// it, and a stray `mouseup` after a `blur` already ended the drag finds it false.
window.addEventListener('mouseup', () => {
  const ended = dragging;
  release();
  if (ended) prefetchSelection();
});
window.addEventListener('blur', release);

/**
 * Extend the selection while the button is held.
 *
 * ON THE WINDOW AND NOT THE CANVAS, matching `mouseup` above: Chromium takes native mouse capture
 * on `mousedown`, so a drag that leaves the canvas still reports here, and a selection that stopped
 * growing at the canvas edge would be a surprise. `cellAt` returns null off the screen region, and
 * the null is IGNORED rather than ending the drag -- dragging out over the keypad and back must
 * keep the selection the operator was building.
 */
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const list = last;
  if (list === undefined) return;
  // THE THRESHOLD FIRST, BEFORE EITHER RETURN BELOW, because both would skip it: the same-cell
  // return is exactly the case a one-character drag lives in, and the off-screen one is a drag
  // that has plainly moved. Latched -- moving back to the press point does not undo a drag, as it
  // does not in a browser's own text selection. `clientX`/`clientY`, matching `pressAt`.
  let crossed = false;
  if (!moved && pressAt !== null && movedPastThreshold(pressAt, { x: e.clientX, y: e.clientY })) {
    moved = true;
    crossed = true;
  }
  const cell = cellAt(e.offsetX, e.offsetY, list);
  if (cell === null) { if (crossed) paint(list); return; }
  // Repaint ONLY when the cell actually changed -- or when this move is the one that turned the
  // press into a drag, which is what makes a one-cell selection's highlight appear. A mousemove
  // fires per pixel, and repainting the whole canvas 14 times per cell crossed is work the
  // highlight cannot show.
  if (!crossed && focus !== null && focus.row === cell.row && focus.col === cell.col) return;
  focus = cell;
  paint(list);
});

window.addEventListener('resize', () => { if (last !== undefined) paint(last); });

/**
 * Copy the current selection, or do nothing and say so.
 *
 * THE ONLY PLACE IN THIS FILE THAT BUILDS A COPY ACTION'S RECTANGLE, and it must stay that way.
 * There are now THREE callers -- the `window.__tn3270Copy` global below, `copyByChord` (the keydown
 * listener's `requestCopy` arm, as its fallback) and `forwardCopy`'s `copy` listener (also as its
 * fallback) -- and the empty-selection rule, the normalization and the action's shape are one
 * decision each. (`prefetchSelection` and `cachedSelection` normalize too, but to key the cache,
 * not to send a copy.) A second copy of this body is a second place for them to drift.
 *
 * NAMED AND HOISTED rather than assigned to a `const`: the keydown listener's arm sits ~200 lines
 * ABOVE this declaration, which a `const` arrow would put in its temporal dead zone at module
 * load. Nothing calls it at load today, so the arrow would also work -- it is declared this way so
 * that it keeps working, matching `clearSelection` above.
 *
 * IT SENDS THE RECTANGLE AND NOT THE TEXT, which is forced rather than chosen: this file only ever
 * sees a `DrawList`, whose cells carry a CG-order atlas glyph and NO character. Main holds
 * `resolve(snapshot)`, where `text` and `hidden` both live, so main extracts.
 *
 * RETURNS A BOOLEAN so the harness and the menu can tell "nothing was selected" from "copied",
 * rather than both looking like silence. Main's Copy handler calls this through
 * `executeJavaScript`; a false means the operator pressed Copy with no selection, which is not an
 * error worth a message.
 *
 * IT DOES NOT CLEAR THE SELECTION, which is the contract the keydown arm depends on -- see that
 * arm's comment. A copy leaves the screen untouched, so the highlight it just read is still an
 * honest description of what is on it, and an operator who copies twice gets the same text twice.
 *
 * THAT LAST SENTENCE WAS MACHINE-CHECKED FROM 2026-10-27 UNTIL THE PREFETCH LANDED, 2026-11-02:
 * `web/scripts/browser-clicks.mjs`'s `webCopy` presses the real chord TWICE over two different
 * clipboard sentinels with no second drag. MEASURED then on the mutant that adds a
 * `clearSelection()` AFTER this call inside the arm: all 2614 unit tests passed and `webCopy` was
 * the only failure. IT NO LONGER EXERCISES THIS FUNCTION: with the text prefetched, both presses
 * take `copyByChord`'s synchronous path and never call `copySelection()`, so what `webCopy` now
 * checks is that the CACHED path keeps the selection. `webCopyFallback` covers THIS function: it
 * holds the prefetch so the cache is empty and presses the chord twice with no re-drag. MEASURED
 * 2026-11-03 on a `clearSelection()` added after the `sendAction` below: `webCopyFallback` fails
 * on its second press, and it is the only check that does. NO UNIT TEST CAN REACH IT -- this file touches `window` at module load, so nothing
 * imports it -- and `test/renderer-imports.test.ts`'s order pin does not cover it either.
 */
function copySelection(): boolean {
  const rect = selectedRect();
  if (rect === null) return false;
  window.tn3270.sendAction({ kind: 'copy', rect });
  return true;
}

/** The prefetched text for the CURRENT selection, or `undefined`. */
function cachedSelection(): string | undefined {
  const rect = selectedRect();
  return rect === null ? undefined : copyCache.take(rect);
}

/**
 * `Ctrl-Shift-C` / `Cmd-Shift-C`. 2026-11-02.
 *
 * WITH TEXT CACHED, raise the browser's own `copy` event with `execCommand('copy')`, inside this
 * keystroke's activation, so `forwardCopy` can set the text synchronously -- which is what makes
 * the chord work at a plain-`http` LAN address. MEASURED in a non-secure Chromium page (Electron
 * 44): the event fires `isTrusted` and its data lands on the OS clipboard; without a user gesture
 * `execCommand('copy')` returns false and nothing happens. `execCommand` is deprecated but has no
 * replacement for raising a copy event from script.
 *
 * FALLS BACK to `copySelection()` -- the async path -- when nothing is cached, when `execCommand`
 * throws or is ignored, or when the event never reached `forwardCopy`'s listener. So a browser
 * that ignores the call still copies, exactly as it did before this. THE SIGNAL IS `copyHandled`,
 * NOT `execCommand`'s RETURN VALUE: that says whether a copy command ran, not whether our listener
 * took it.
 *
 * ONLY WITH TEXT CACHED, and that is not an optimization. The cache is filled only where the bridge
 * has `fetchSelection` (the web gateway), so in the Electron GUI this never calls `execCommand` at
 * all, and the page's default copy of an empty DOM selection never runs there.
 *
 * THE RESIDUAL RISK, NOT YET MEASURED. `copyHandled` says the `copy` EVENT reached our listener,
 * not that the browser then honoured the data it set. A browser that dispatches the event but
 * refuses the clipboard write -- Firefox and Safari are unmeasured -- leaves `copyHandled` true, so
 * this returns without falling back and that copy is lost SILENTLY. The live pass is what will
 * tell; if it happens, the fix belongs here, not in `forwardCopy`.
 */
function copyByChord(): void {
  if (cachedSelection() !== undefined) {
    copyHandled = false;
    try { document.execCommand('copy'); } catch { /* fall through to the fallback */ }
    if (copyHandled) return;
  }
  copySelection();
}

/**
 * The global, unchanged in NAME, SIGNATURE and BEHAVIOR.
 *
 * A `window` GLOBAL, NOT A FIFTH BRIDGE FUNCTION -- `bridgecore.ts` records that a fifth function
 * means the renderer has stopped being shared between Electron and the browser, and both hosts get
 * a global for free because both load this file. Same mechanism `__tn3270ButtonCenter` used,
 * before it was deleted (see the note below).
 *
 * TWO CALL SITES DEPEND ON IT, BOTH IN ELECTRON, and it is a one-line delegation precisely so
 * that the extraction above cannot change what either observes. CITED BY NAME AND NEVER BY LINE,
 * for the reason `test/keys.test.ts` gives where it does the same ("Cited by its words and not by
 * a line number, which the new branch above would have shifted anyway") -- and the reason is not
 * hypothetical here, it is this file's own history: these two were written as `gui/src/main.ts:1020`
 * and `:1747` in `9a6e53e`, and `4d56edb` -- the VERY NEXT COMMIT in the same series -- inserted 41
 * lines above both and silently made them `:1038` and `:1861`. A citation that cannot survive its
 * own feature branch should not be written as a number.
 *
 *  - `gui/src/main.ts`'s menu Copy handler, the `onCopy:` arm of its `buildMenuTemplate` call,
 *    which invokes this through `executeJavaScript('window.__tn3270Copy && window.__tn3270Copy()')`.
 *  - `gui/src/main.ts`'s `TN3270_GUI_SELECT` test seam, the `const copied = await
 *    win.webContents.executeJavaScript('window.__tn3270Copy()')` line -- the route
 *    `gui/scripts/select.mjs` drives, which is NOT the menu.
 *
 * IT WAS THREE UNTIL 2026-10-27, and the third leaving is the point rather than a tidy-up.
 * `web/scripts/browser-clicks.mjs` used to evaluate this global, because the browser had no copy
 * gesture to drive; its `webCopy` check now presses the real `Ctrl-Shift-C` instead, so it covers
 * the keydown arm above and `actionForKey`'s branch as well as this body.
 *
 * SO THIS GLOBAL'S ONLY HARNESS IS NOW `select.mjs`, which is adequate but is a narrower claim
 * than it used to be: nothing in a BROWSER exercises it any more. That is correct -- a browser has
 * no Edit menu to reach it from -- but it means a change to this line is covered by the Electron
 * harness alone.
 */
(window as unknown as { __tn3270Copy: () => boolean }).__tn3270Copy = (): boolean => copySelection();

/**
 * TEST SEAM: the viewport-pixel center of a SCREEN CELL, or `null`.
 *
 * The twin of the now-deleted `__tn3270ButtonCenter` (see the note below), and it exists for the
 * same reason: `select.mjs` drives a real drag through Chromium's input pipeline, and it must name
 * CELLS rather than pixels, because a pixel list in the harness would be a second copy of the
 * geometry that would pass while the geometry was wrong. Returning coordinates rather than setting
 * `anchor`/`focus` directly is what keeps `mousedown`, `mousemove`, `cellAt` and the highlight all
 * under test.
 *
 * THE INVERSE OF `cellAt`, so the two must agree: this adds the offset and multiplies by the
 * scale where `cellAt` subtracts and divides. A harness built on a different expression would be
 * testing its own arithmetic.
 */
(window as unknown as {
  __tn3270CellCenter: (row: number, col: number) => { x: number; y: number } | null;
}).__tn3270CellCenter = (row, col) => {
  const list = last;
  if (list === undefined || atlas === undefined) return null;
  const g = atlas.geometry;
  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(list, within);
  const at = center(list, within, scale);
  // THE OIA IS STILL EXCLUDED, which is why this is not simply `list.height`: copying the
  // operator status line as if it were host data would be a lie about what is on the screen.
  // The keypad was a THIRD term here until 2026-10-06, so a selection drag could not run onto
  // it; it left the canvas, and a `?? list.keypad?.y` that can never fire is a reader trap.
  // `select.mjs` is what proves this simplification did not move the bound.
  const screenBottom = list.oia?.y ?? list.height;
  if (row < 0 || col < 0) return null;
  if (col >= Math.floor(list.width / g.cellWidth)) return null;
  if (row >= Math.floor(screenBottom / g.cellHeight)) return null;
  return {
    x: at.x + (col + 0.5) * g.cellWidth * scale,
    y: at.y + (row + 0.5) * g.cellHeight * scale,
  };
};

/*
  `__tn3270ButtonCenter` WAS HERE AND IS GONE, 2026-10-06.

  It returned the viewport-pixel centre of a named keypad button so `clicks.mjs` could click it
  without knowing the layout, the scale or the offset -- and it was the model for
  `__tn3270CellCenter` above, which survives it. Both front ends' keypads are real HTML controls
  now, so `clicks.mjs` queries `button[data-label=...]` and calls the element's own `click()`:
  the browser does the hit testing, and there are no coordinates to compute or get wrong.

  WORTH KEEPING FROM ITS DOCSTRING, because the properties outlived the function: a test seam
  should return COORDINATES rather than fire the action, so the real input pipeline stays under
  test; a `window` global is NOT a fifth bridge function, which is what let both hosts have it for
  free; and viewport pixels only work because both pages put the canvas box at the viewport origin
  (`margin:0`, `display:block`) -- the constraint `ui.css` had to be scoped around when the web
  overlay landed, having shifted the whole screen 15px by styling `body`.
*/

/** Break a message at word boundaries so an error is readable rather than clipped. */
function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && `${line} ${word}`.length > cols) { out.push(line); line = word; }
    else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') out.push(line);
  return out;
}
