import type { Rgb } from '@tn3270/core';
import type { AtlasGeometry } from './geometry.js';
import type { DrawList } from './drawlist.js';
import { actionForKey } from './keys.js';
import { blit, bestScale, centre, tintKey, type Ctx2D } from './blit.js';
import { hitTestAt, type KeypadButton } from './hittest.js';

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
 * The atlas is coverage, not colour. Each colour gets one pre-tinted copy, built on first
 * use and kept: a 3279 has sixteen colours, so the cache is bounded by the palette rather
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
// is a flat colour.
const ctx = real as unknown as Ctx2D;

let atlas: AtlasMessage | undefined;
let blank: ReadonlySet<number> = new Set();
let last: DrawList | undefined;
/**
 * The keypad button under the finger right now, if any.
 *
 * PURELY RENDERER-LOCAL, and deliberately: see the highlight at the end of `paint`. Cleared by
 * `release()`, on `mouseup` anywhere in the window and on `blur`, so no way of ending a press can
 * leave the highlight stuck on.
 */
let pressed: KeypadButton | undefined;
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

/** One tinted atlas per colour: coverage written into the alpha channel. */
function tintOf(colour: Rgb): ImageBitmap | undefined {
  if (atlas === undefined) return undefined;
  const key = tintKey(colour);
  const got = tints.get(key);
  if (got !== undefined) return got;
  if (building.has(key)) return undefined;
  building.add(key);

  const w = atlas.geometry.cols * atlas.geometry.cellWidth;
  const h = atlas.geometry.cellHeight;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < atlas.coverage.length; i++) {
    data[i * 4] = colour[0];
    data[i * 4 + 1] = colour[1];
    data[i * 4 + 2] = colour[2];
    data[i * 4 + 3] = atlas.coverage[i]!;
  }
  void createImageBitmap(new ImageData(data, w, h)).then((bmp) => {
    tints.set(key, bmp);
    building.delete(key);
    // A colour arriving late must not leave a hole: repaint once it is ready.
    if (last !== undefined) paint(last);
  });
  return undefined;
}

function paint(list: DrawList): void {
  last = list;
  if (atlas === undefined || canvas === null) return;   // nothing to draw with yet

  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(list, within);
  const at = centre(list, within, scale);

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
   * `bestScale` floors at 1 and `centre` clamps its offsets at 0, so neither of them saves this.
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
    tinted: (colour: Rgb): unknown | undefined => tintOf(colour),
  };
  blit(ctx, list, options);

  // The OIA goes through the SAME blitter and atlas -- see the note on DrawList.oia. Passed
  // as a one-row list so the blitter's only job stays "draw these cells".
  if (list.oia !== undefined) {
    blit(ctx, { cells: list.oia.cells, width: list.width, height: list.height }, options);
  }

  // The keypad goes through the SAME blitter and atlas as the screen and the OIA -- one drawing
  // primitive, three regions -- and for the same reason the OIA does (`drawlist.ts:53-61`).
  // `list.width`/`list.height` and not the region's own: `blit` reads only `cells` (`blit.ts:98-105`),
  // and the cells' coordinates are in the WHOLE DRAWING's scale-1 space, including the region's `y`
  // offset, so `keypad.width`/`keypad.height` would describe a surface these cells do not live in.
  if (list.keypad !== undefined) {
    blit(ctx, { cells: list.keypad.cells, width: list.width, height: list.height }, options);
  }

  // PURELY LOCAL, and deliberately: over a WebSocket a round trip for a press highlight would lag
  // visibly behind the finger. Nothing about it reaches the host -- only the action does.
  //
  // Drawn LAST so it sits over the label, and gated on `list.keypad` as well as on `pressed`: a
  // frame with the keypad off must draw nothing extra even if a press is still outstanding.
  // `fillRect` is on `Ctx2D` already (`blit.ts:35`), so no cast and no widening.
  //
  // `includes` is an IDENTITY check and not a search: `pressed` is always an element of some frame's
  // `buttons`, so this asks "of THIS frame's?". Without it, a frame whose geometry changed while a
  // button was held -- a host that switches model, so the keypad's `y` moves -- would highlight a
  // rectangle no button occupies until the release.
  if (pressed !== undefined && list.keypad !== undefined && list.keypad.buttons.includes(pressed)) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(
      at.x + pressed.x * scale, at.y + pressed.y * scale,
      pressed.w * scale, pressed.h * scale,
    );
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
window.tn3270.onFrame((list) => { errored = false; paint(list); });

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
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // Read the module state ONCE: everything below must agree about which frame was clicked.
  const list = last;
  if (errored || list?.keypad === undefined) return;
  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(list, within);
  // The arithmetic is `hitTestAt`'s, not this file's, and DELIBERATELY: nothing can execute a line
  // of this module (`index.ts:8-10`), so the inverse lives where `keypad.test.ts` can mutate it.
  const button = hitTestAt(
    list.keypad.buttons, e.offsetX, e.offsetY, centre(list, within, scale), scale,
  );
  if (button === undefined) return;           // a gap, or the screen: not ours
  pressed = button;
  paint(list);                                // draw the highlight immediately
  window.tn3270.sendAction(button.action);
});

/**
 * Drop the press highlight.
 *
 * `mouseup` ON THE WINDOW covers a release outside the button, and outside the window too: Chromium
 * takes native mouse capture on `mousedown`, so the release is still delivered here. `blur` covers
 * what capture cannot -- focus lost while the button is held, by Alt+Tab, an X grab or a lock screen,
 * or a native context menu opening over it. Damage either way is highlight-only, since `pressed` is
 * never read on the action path, but it would persist INDEFINITELY: `paint` redraws the highlight on
 * every later frame.
 */
function release(): void {
  if (pressed === undefined) return;
  pressed = undefined;
  if (last !== undefined) paint(last);
}

window.addEventListener('mouseup', release);
window.addEventListener('blur', release);

window.addEventListener('resize', () => { if (last !== undefined) paint(last); });

/**
 * TEST SEAM, and the only thing in this file that exists for a test.
 *
 * Returns the CENTRE of a named button in viewport pixels, so `gui/scripts/clicks.mjs` can click it
 * without knowing the layout, the scale or the offset. Returning COORDINATES rather than firing the
 * action is what keeps the seam honest: the click still goes in through Chromium's input pipeline,
 * so `mousedown`, the primary-button guard, `hitTestAt`, `sendAction` and the IPC hop are all still
 * under test. A seam that called `sendAction` here would skip exactly the plumbing that has never
 * run in a test.
 *
 * NOT A FIFTH BRIDGE FUNCTION. `bridgecore.ts` says a fifth function in the bridge means the
 * renderer has stopped being shared between Electron and the browser; this is a `window` global,
 * which both hosts get for free because both load this file, and neither has to implement it.
 *
 * VIEWPORT pixels only because both pages put the canvas box at the viewport origin -- `margin:0`
 * on `html,body` and `display:block` on the canvas, in `gui/index.html` and
 * `web/static/index.html`. The arithmetic below is the canvas's own space, the same space `paint`
 * draws in and `mousedown` reads `offsetX` in; a body margin, or a scrolled `overflow:auto` page,
 * would put a term between the two that only the caller could add.
 *
 * `null` FOR BOTH "no keypad" AND "no such label", deliberately not distinguished: main reports it
 * as `NO BUTTON`, and both causes are a mistake in the CALLER -- clicking before showing the keypad,
 * or naming a key that is not in the table -- rather than a failure of the path under test. Note it
 * does NOT consult `errored`: this answers where the button IS, and whether a click on it is
 * refused while an error message is up is behaviour for the click path to decide.
 */
(window as unknown as { __tn3270ButtonCentre: (label: string) => { x: number; y: number } | null })
  .__tn3270ButtonCentre = (label) => {
    // Read the module state ONCE, as the `mousedown` listener does: the scale, the offset and the
    // button must all come from the same frame.
    const list = last;
    if (list?.keypad === undefined) return null;
    const button = list.keypad.buttons.find((b) => b.label === label);
    if (button === undefined) return null;
    const within = { width: window.innerWidth, height: window.innerHeight };
    const scale = bestScale(list, within);
    const at = centre(list, within, scale);
    return {
      x: at.x + (button.x + button.w / 2) * scale,
      y: at.y + (button.y + button.h / 2) * scale,
    };
  };

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
