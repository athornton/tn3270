import type { Rgb } from '@tn3270/core';
import type { AtlasGeometry, DrawList } from './drawlist.js';
import { actionForKey } from './keys.js';
import { blit, bestScale, centre, tintKey, type Ctx2D } from './blit.js';

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
 * `./blit.js` and `./keys.js`, whose own imports are all `import type` and thus erased.
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

  canvas.width = within.width;
  canvas.height = within.height;
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
