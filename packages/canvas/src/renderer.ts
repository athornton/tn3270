import type { Rgb } from '@tn3270/core';
import type { AtlasGeometry } from './geometry.js';
import type { DrawList } from './drawlist.js';
import { actionForKey } from './keys.js';
import { blit, bestScale, center, tintKey, type Ctx2D } from './blit.js';
// FROM THE MODULE AND NOT FROM THE BARREL (`./index.js`), which would be the natural reach and
// would BLANK THIS WINDOW WITH NO ERROR: the barrel re-exports `drawlist.js`, which value-imports
// `@tn3270/core`, and a browser has no bundler to resolve a bare specifier.
// `renderer-imports.test.ts` walks this file's built graph to catch exactly that. `selection.ts`
// itself is safe here -- its only workspace import is an `import type`, which erases.
import { normalizeRect, isEmptyRect, type CellAddr } from './selection.js';

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
 * `./blit.js`, `./keys.js` and `./hittest.js`, whose own imports are all `import type` and
 * thus erased. Each of the three is also listed in `BROWSER_MODULES` (`assets.ts:39`),
 * without which the web front end serves a 404 for it and the canvas goes black instead.
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
 */
let anchor: CellAddr | null = null;
let focus: CellAddr | null = null;
let dragging = false;

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
   * GATED ON `isEmptyRect`, so a plain click -- which sets anchor and focus to the same cell -- draws
   * nothing. Without that every click would flash a one-cell block.
   *
   * THE GOLDENS MUST NOT MOVE because of this. `shot.mjs`'s three cases have no selection, so this
   * block cannot execute in them; if a golden does move, that is a real failure meaning the
   * highlight draws when nothing is selected, and NOT a golden to regenerate.
   *
   * LAST, after the keypad and its press wash, for the same reason the press highlight is last
   * among those: it sits over what it marks. It cannot stray onto the keypad or the OIA anyway --
   * `cellAt` bounds every cell it returns to the screen region.
   */
  if (anchor !== null && focus !== null) {
    const rect = normalizeRect(anchor, focus);
    if (!isEmptyRect(rect) && atlas !== undefined) {
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
}

window.tn3270.onAtlas((message) => {
  atlas = message;
  blank = new Set(message.blank);
  // This repaint also PAINTS OVER an error message, so the click guard lifts with it -- inside the
  // `if`, because with no frame yet there is nothing to paint and the message stays up.
  if (last !== undefined) { errored = false; paint(last); }
});

// A frame means the session is drawing again, so whatever `onError` put up is both gone and stale.
//
// AND IT INVALIDATES THE SELECTION, because a new frame means the cells those coordinates named
// now hold different text. Keeping the highlight across a repaint would offer the operator a copy
// of text that is no longer there -- and main extracts from the CURRENT snapshot, so the rectangle
// would silently pick up whatever replaced it.
window.tn3270.onFrame((list) => { errored = false; clearSelection(); paint(list); });

window.tn3270.onError((message) => {
  // Failures must be VISIBLE: someone who double-clicked a .app has no console. This is the
  // one place canvas text is used, deliberately -- an error message is our own chrome, is
  // never compared against a golden, and must stay readable at any window size.
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
});

window.addEventListener('keydown', (e) => {
  const action = actionForKey(e);
  if (action === null) return;
  // preventDefault only for keys we CLAIMED, so shortcuts we do not use keep working and
  // Tab does not move focus out of the canvas.
  e.preventDefault();
  // ANY KEYSTROKE THAT DOES SOMETHING INVALIDATES THE SELECTION, because the screen is about to
  // change under it and a highlight over changed text would offer a copy of something never seen.
  //
  // AFTER the `action === null` return above, so a key we did NOT claim leaves the selection alone:
  // the Copy accelerator itself arrives as a keystroke, and clearing on unclaimed keys would wipe
  // the selection a moment before main asked for it. (On macOS the accelerator is consumed by the
  // menu before the page sees it; on Linux `Ctrl+Shift+C` is not in `actionForKey`'s table, so it
  // lands here as an unclaimed key. Either way the selection must survive it.)
  clearSelection();
  window.tn3270.sendAction(action);
});

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
 * back subtracts `at` and divides by `scale` -- exactly what `hitTestAt` does for a keypad button.
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
  if (errored || list === undefined) return;
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
  anchor = cell;
  focus = cell;
  dragging = true;
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

window.addEventListener('mouseup', release);
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
  const cell = cellAt(e.offsetX, e.offsetY, list);
  if (cell === null) return;
  // Repaint ONLY when the cell actually changed. A mousemove fires per pixel, and repainting the
  // whole canvas 14 times per cell crossed is work the highlight cannot show.
  if (focus !== null && focus.row === cell.row && focus.col === cell.col) return;
  focus = cell;
  paint(list);
});

window.addEventListener('resize', () => { if (last !== undefined) paint(last); });

/**
 * Copy the current selection, or do nothing and say so.
 *
 * A `window` GLOBAL, NOT A FIFTH BRIDGE FUNCTION -- `bridgecore.ts` records that a fifth function
 * means the renderer has stopped being shared between Electron and the browser, and both hosts get
 * a global for free because both load this file. Same mechanism as `__tn3270ButtonCenter` below.
 *
 * IT SENDS THE RECTANGLE AND NOT THE TEXT, which is forced rather than chosen: this file only ever
 * sees a `DrawList`, whose cells carry a CG-order atlas glyph and NO character. Main holds
 * `resolve(snapshot)`, where `text` and `hidden` both live, so main extracts.
 *
 * RETURNS A BOOLEAN so the harness and the menu can tell "nothing was selected" from "copied",
 * rather than both looking like silence. Main's Copy handler calls this through
 * `executeJavaScript`; a false means the operator pressed Copy with no selection, which is not an
 * error worth a message.
 */
(window as unknown as { __tn3270Copy: () => boolean }).__tn3270Copy = (): boolean => {
  if (anchor === null || focus === null) return false;
  const rect = normalizeRect(anchor, focus);
  if (isEmptyRect(rect)) return false;
  window.tn3270.sendAction({ kind: 'copy', rect });
  return true;
};

/**
 * TEST SEAM: the viewport-pixel center of a SCREEN CELL, or `null`.
 *
 * The twin of `__tn3270ButtonCenter` below and it exists for the same reason: `select.mjs` drives a
 * real drag through Chromium's input pipeline, and it must name CELLS rather than pixels, because a
 * pixel list in the harness would be a second copy of the geometry that would pass while the
 * geometry was wrong. Returning coordinates rather than setting `anchor`/`focus` directly is what
 * keeps `mousedown`, `mousemove`, `cellAt` and the highlight all under test.
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
