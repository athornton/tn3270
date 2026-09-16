import type { Rgb } from '@tn3270/core';
import type { AtlasGeometry, DrawList } from './drawlist.js';
import { actionForKey } from './keys.js';
import { blit, bestScale, centre, tintKey, type Ctx2D } from './blit.js';
import { hitTest, type KeypadButton } from './hittest.js';

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
 * PURELY RENDERER-LOCAL, and deliberately: see the highlight at the end of `paint`. Cleared on
 * `mouseup` anywhere in the window, not just on the canvas, so a release outside the button that
 * was pressed cannot leave the highlight stuck on.
 */
let pressed: KeypadButton | undefined;

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
  // primitive, three regions -- and for the same reason the OIA does (`drawlist.ts:61-69`).
  // `list.width`/`list.height` and not the region's own: `blit` reads only `cells` (`blit.ts:97-104`),
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
  // `fillRect` is on `Ctx2D` already (`blit.ts:34`), so no cast and no widening.
  if (pressed !== undefined && list.keypad !== undefined) {
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
  if (last !== undefined) paint(last);
});

window.tn3270.onFrame(paint);

window.tn3270.onError((message) => {
  // Failures must be VISIBLE: someone who double-clicked a .app has no console. This is the
  // one place canvas text is used, deliberately -- an error message is our own chrome, is
  // never compared against a golden, and must stay readable at any window size.
  if (canvas === null || real === null) return;
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
 * `offsetX`/`offsetY` and NOT `clientX - getBoundingClientRect().left`. Both are element-relative,
 * so both survive page scrolling -- which the web front end has, since `paint` sizes the canvas to
 * the drawing and `web/static/index.html:10` is `overflow:auto`. `offsetX` is the simpler of the two
 * and needs no rect. Neither is right if the canvas is ever given a CSS size that differs from its
 * attribute size, because both are then in CSS pixels of a stretched box; both pages style the
 * canvas `display:block` and nothing else, so the two spaces are the same and no ratio is needed.
 *
 * Primary button only. `mousedown` fires for the right and middle buttons too, and a keypad that
 * sent `clear` or a PF key to a live host on a right-click -- while the context menu opened over
 * it -- would be a misfire the operator never asked for.
 */
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // Read the module state ONCE: everything below must agree about which frame was clicked.
  const list = last;
  if (list?.keypad === undefined) return;
  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(list, within);
  const at = centre(list, within, scale);
  const x = (e.offsetX - at.x) / scale;
  const y = (e.offsetY - at.y) / scale;
  const button = hitTest(list.keypad.buttons, x, y);
  if (button === undefined) return;           // a gap, or the screen: not ours
  pressed = button;
  paint(list);                                // draw the highlight immediately
  window.tn3270.sendAction(button.action);
});

window.addEventListener('mouseup', () => {
  if (pressed === undefined) return;
  pressed = undefined;
  if (last !== undefined) paint(last);
});

window.addEventListener('resize', () => { if (last !== undefined) paint(last); });

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
