import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cp037, Colour } from '@tn3270/core';
import { KEYPAD_KEYS, KEYPAD_ROWS, KEYPAD_KEY_WIDTH, SCHEMES, schemeRgb } from '@tn3270/frontend';
import { keypadRegion, KEYPAD_ROWS_TALL, type KeypadRegion } from '../src/keypad.js';
// From `hittest.js`, not `keypad.js`: the renderer hit-tests in the BROWSER, so this function lives
// in the one keypad module with no runtime import. See hittest.ts, and the graph assertion in
// `renderer-imports.test.ts`.
import { hitTest, hitTestAt, type KeypadButton } from '../src/hittest.js';
import type { AtlasGeometry, DrawCell } from '../src/geometry.js';
import { ebcdicToCg, CG_BOXSOLID } from '../src/cg.js';

/**
 * The REAL atlas, exactly as `drawlist.test.ts`'s own `atlas` const does it (`:12-14`).
 *
 * The plan's sketch fabricated `{ cellWidth: 9, cellHeight: 14, cols: 431, index: {} } as never`.
 * Two problems: no test file in this repo is typechecked, so `as never` would hide a wrong shape
 * silently; and an EMPTY `index` makes every glyph lookup miss, so every cell would carry the same
 * fallback column and the CG-map assertion below could not fail.
 */
const atlas: AtlasGeometry = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'atlas.json'), 'utf8'));

const scheme = SCHEMES.default!;
const region = () => keypadRegion(atlas, scheme, 0);

/** The cells drawn inside one button, in emission order. All five of them, since the change. */
const labelCells = (r: KeypadRegion, b: KeypadButton): readonly DrawCell[] =>
  r.cells.filter((c) => c.y === b.y && c.x >= b.x && c.x < b.x + b.w);

/**
 * How wide the PAINTED block is, in cells: one less than the key, the last cell being the separator
 * column. Written here as `- 1` and not as a copy of the source's own constant, which is private.
 */
const BLOCK = KEYPAD_KEY_WIDTH - 1;

/**
 * How many pad cells precede a centred label in its 5-cell block.
 *
 * This DOES restate the implementation's expression, and only the whole-layout loop below uses it,
 * where the alternative is 47 hand-written offsets. The independent statement of the same rule is
 * `centres the label, so a one-character arrow sits in the middle of its block`, which writes the
 * offsets down for four label lengths and would fail if this helper and the source were wrong
 * together.
 */
const centreOffset = (label: string): number => Math.floor((BLOCK - label.length) / 2);

describe('keypadRegion', () => {
  it('produces one button per key in the table', () => {
    expect(region().buttons).toHaveLength(KEYPAD_KEYS.length);
  });

  it('is KEYPAD_ROWS_TALL rows high, in scale-1 pixels', () => {
    const r = keypadRegion(atlas, scheme, 350);
    expect(r.y).toBe(350);
    expect(r.height).toBe(KEYPAD_ROWS_TALL * atlas.cellHeight);
  });

  it('offsets every button by the region y it was given', () => {
    // The keypad sits BELOW the screen and the OIA, so a region built at y=350 must not emit a
    // button at y=0 -- that would put the keypad over the host's first row.
    const r = keypadRegion(atlas, scheme, 350);
    for (const b of r.buttons) expect(b.y).toBeGreaterThanOrEqual(350);
  });

  it('has no two buttons overlapping', () => {
    const bs = region().buttons;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!;
        const b = bs[j]!;
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x
          || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint, `${a.label} overlaps ${b.label}`).toBe(true);
      }
    }
  });

  it('keeps every button inside the declared width', () => {
    const r = region();
    for (const b of r.buttons) expect(b.x + b.w).toBeLessThanOrEqual(r.width);
  });

  it('declares exactly the extent its buttons occupy', () => {
    // BOTH the containment checks are one-sided and the height assertion above is tautological --
    // it compares `height` against the same constant that computes it. Measured: `KEYPAD_ROWS_TALL
    // = 7` and `width: 13 * KEYPAD_KEY_WIDTH * cellWidth` each left all 20 of the earlier tests
    // green. `DrawList.height` is what sizes the Electron window (`gui/src/main.ts`), which is the
    // whole reason the keypad is in the draw list, so an OVER-declared extent is exactly what this
    // geometry exists to pin; today it would surface only as a golden diff, two tasks later.
    const r = keypadRegion(atlas, scheme, 350);
    expect(r.y + r.height).toBe(Math.max(...r.buttons.map((b) => b.y + b.h)));
    expect(r.width).toBe(Math.max(...r.buttons.map((b) => b.x + b.w)));
  });

  it('keeps every button inside the declared HEIGHT, and none above the region', () => {
    // The plan checked width containment and not height, which leaves the table-row-to-drawn-row
    // map unpinned in the one direction it can go wrong: a row the map does not cover yields a
    // NaN y, and NaN silently fails every hit test rather than throwing.
    const r = keypadRegion(atlas, scheme, 350);
    for (const b of r.buttons) {
      expect(b.y, b.label).toBeGreaterThanOrEqual(r.y);
      expect(b.y + b.h, b.label).toBeLessThanOrEqual(r.y + r.height);
    }
  });

  it('leaves a blank separator row BETWEEN EVERY PAIR of key rows', () => {
    // 5 key rows with a gap after all but the last is 9 drawn rows, the keys on the EVEN ones and a
    // separator on each of the 4 odd ones -- drawn 1, 3, 5 and 7. That is why KEYPAD_ROWS_TALL is 9
    // for a 5-row table, and NOTHING else here can see it: collapsing the map to [0,1,2,3,4] keeps
    // every button disjoint, inside the width and inside the height.
    //
    // WRITTEN DOWN, not derived from the region. "Which rows hold no button" would be satisfied by
    // the collapsed map too, since drawn rows 5-8 would then be the empty ones -- a check that
    // cannot fail for the mutation it exists to catch.
    const r = keypadRegion(atlas, scheme, 350);
    expect(KEYPAD_ROWS_TALL).toBe(2 * KEYPAD_ROWS.length - 1);
    for (const drawnRow of [1, 3, 5, 7]) {
      const gapY = r.y + drawnRow * atlas.cellHeight;
      for (const b of r.buttons) expect(b.y, `${b.label} on gap row ${drawnRow}`).not.toBe(gapY);
      for (let x = 0; x < r.width; x += atlas.cellWidth) {
        expect(hitTest(r.buttons, x, gapY), `x=${x} on gap row ${drawnRow}`).toBeUndefined();
      }
      expect(r.cells.some((c) => c.y === gapY), `cells on gap row ${drawnRow}`).toBe(false);
    }
  });

  it('never puts two buttons in vertically-touching rows', () => {
    // THE PROPERTY THE INVERSE-VIDEO STYLING ACTUALLY NEEDS, stated on the buttons rather than on
    // the row map. A key is one cell tall and is drawn as a solid white block across five of its six
    // cells, so two buttons sharing a column with `a.y + a.h === b.y` draw ONE block two cells tall
    // -- which is what naive inverse video looked like, and why it was rejected. Disjointness cannot
    // catch it: touching rectangles are disjoint.
    const bs = region().buttons;
    for (const a of bs) {
      for (const b of bs) {
        if (a === b) continue;
        const sameColumns = a.x < b.x + b.w && b.x < a.x + a.w;
        if (!sameColumns) continue;
        expect(a.y + a.h, `${a.label} touches ${b.label}`).not.toBe(b.y);
      }
    }
  });

  it('draws PF13-24 ABOVE PF1-12, and starts at the region y', () => {
    // c3270's order (`Common/c3270/keypad.labels:2` and `:4`), recorded in the header of
    // `frontend/src/keypad.ts`. A transposed row map keeps every button disjoint, so only an
    // assertion about WHICH row is where can catch it.
    //
    // PF1 is TWO cell rows down, not one: table row 1 is drawn at row 2 because a separator sits
    // between them. This is the second thing the collapsed map reddens.
    const bs = keypadRegion(atlas, scheme, 350).buttons;
    const pf = (label: string) => bs.find((b) => b.label === label)!;
    expect(pf('PF13').y).toBe(350);
    expect(pf('PF1').y).toBe(350 + 2 * atlas.cellHeight);
    expect(pf('PF13').y).toBeLessThan(pf('PF1').y);
  });

  it('draws every cell INVERSE: black ink on white paper', () => {
    // THE STYLING ITSELF. `blit` fills `cell.bg` over the whole cell and then stamps the glyph
    // tinted `cell.fg`, so black-on-white IS a reverse-video cell -- no new field, no new glyph.
    // These are the OIA's own two colours exchanged, and not two arbitrary ones.
    const r = region();
    const ink = schemeRgb(scheme, Colour.NEUTRAL_BLACK);
    const paper = schemeRgb(scheme, Colour.NEUTRAL_WHITE);
    // Otherwise the assertions below would hold for a keypad drawn in one colour on itself.
    expect(ink).not.toEqual(paper);
    expect(r.cells.length).toBeGreaterThan(0);
    for (const c of r.cells) {
      expect(c.fg, `fg of ${c.x},${c.y}`).toEqual(ink);
      expect(c.bg, `bg of ${c.x},${c.y}`).toEqual(paper);
      // And nothing else may paint `fg`: `underline` or `cursor` would now draw a BLACK bar across
      // the bottom of a white key, which would read as a border nobody asked for.
      expect([c.underline, c.cursor, c.blink, c.intensify], `flags of ${c.x},${c.y}`)
        .toEqual([false, false, false, false]);
    }
  });

  it('paints a FULL BLOCK of cells for every key, not just its label', () => {
    // Inverse video makes the CELL paint the button, so a short label must still fill the block or
    // the key is a white patch the width of its text -- and `^`, `v`, `<`, `>` would each be a lone
    // 9x14 speck with no click target. 47 keys x 5 cells = 235.
    const r = region();
    expect(r.cells).toHaveLength(KEYPAD_KEYS.length * BLOCK);
    expect(r.cells).toHaveLength(47 * 5);
    // Strictly MORE than the labels themselves need -- 199 characters over 47 keys -- and the
    // difference is the padding, which is the point of the change.
    expect(r.cells.length)
      .toBeGreaterThan(KEYPAD_KEYS.reduce((n, k) => n + k.label.length, 0));
  });

  it('LEAVES THE LAST CELL OF EVERY KEY UNPAINTED, as a separator column', () => {
    // The blank rows' argument on the other axis, and it is just as load-bearing. The 12 PF keys sit
    // at columns 0, 6, 12 ... 66 with NO GUTTER between them, so painting all six cells of each makes
    // the twelve white blocks a single 648-pixel white bar and no key is a rectangle any more.
    // MEASURED: that is what the first capture of this change looked like.
    //
    // The button is still 6 cells wide -- the hit rectangle covers the separator, so a click there
    // still works the key -- which is exactly why NOTHING else in this file can see this: the
    // rectangles, the hit tests, the gutters and the declared extent are all unchanged by it.
    const r = keypadRegion(atlas, scheme, 350);
    for (const b of r.buttons) {
      const lastCellX = b.x + b.w - atlas.cellWidth;
      expect(r.cells.some((c) => c.y === b.y && c.x === lastCellX), `${b.label} separator column`)
        .toBe(false);
      // and the cell before it IS painted, or "unpainted" could be satisfied by drawing nothing
      expect(r.cells.some((c) => c.y === b.y && c.x === lastCellX - atlas.cellWidth), b.label)
        .toBe(true);
    }
  });

  it("fills each button with its own 5 cells, left to right", () => {
    // The count assertion above cannot tell 47 correctly-placed blocks from 47 blocks piled on one
    // key: this pins x, y and ORDER against the button the cells belong to.
    const r = keypadRegion(atlas, scheme, 350);
    for (const b of r.buttons) {
      const mine = labelCells(r, b);
      expect(mine, b.label).toHaveLength(BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        expect(mine[i]!.x, `${b.label}[${i}]`).toBe(b.x + i * atlas.cellWidth);
      }
      // The label's characters sit at the centred offset, and every other cell is a SPACE rather
      // than a repeat of a label character or a leftover from the key before.
      const space = atlas.index[ebcdicToCg(cp037.fromUnicode(' '))];
      for (let i = 0; i < BLOCK; i++) {
        const ch = b.label[i - centreOffset(b.label)];
        const want = ch === undefined ? space : atlas.index[ebcdicToCg(cp037.fromUnicode(ch))];
        expect(mine[i]!.glyph, `${b.label} cell ${i}`).toBe(want);
      }
    }
  });

  it('centres the label, so a one-character arrow sits in the middle of its block', () => {
    // HAND-DERIVED rather than a restatement of the implementation's expression. The block is FIVE
    // cells, which is odd, so a 1-character label starts at cell 2 with two blanks either side --
    // exactly centred -- a 3-character at 1, and a 4- or 5-character at 0. Left-aligning instead
    // would put every one of these at 0, which is the mutation this catches.
    const r = region();
    const space = atlas.index[ebcdicToCg(cp037.fromUnicode(' '))];
    const startOf = (label: string) => {
      const b = r.buttons.find((c) => c.label === label)!;
      return labelCells(r, b).findIndex((c) => c.glyph !== space);
    };
    expect(startOf('^'), '^').toBe(2);
    expect(startOf('v'), 'v').toBe(2);
    expect(startOf('PA1'), 'PA1').toBe(1);
    expect(startOf('Ins'), 'Ins').toBe(1);
    expect(startOf('Home'), 'Home').toBe(0);
    expect(startOf('Enter'), 'Enter').toBe(0);
  });

  it('looks labels up through the CG MAP, like the screen and the OIA', () => {
    // The font is in CG order, not EBCDIC order (`cg.ts:8-45`). A label indexed by its EBCDIC byte
    // would draw a different glyph, which only a screenshot golden would catch. This must agree
    // with the screen and the OIA -- `column()` in `cg.ts` is the one copy, imported by all three.
    //
    // `+ centreOffset` because the six cells now include the centring pad. `Enter` is 5 characters
    // in a 6-cell key so its offset is 0 today, and the term is written anyway: without it this test
    // would silently start comparing pad cells if the alignment ever moved.
    const r = region();
    const enter = r.buttons.find((b) => b.label === 'Enter')!;
    const cells = labelCells(r, enter);
    const at = centreOffset('Enter');
    for (let i = 0; i < 'Enter'.length; i++) {
      const ebcdic = cp037.fromUnicode('Enter'[i]!);
      expect(cells[at + i]!.glyph).toBe(atlas.index[ebcdicToCg(ebcdic)]);
      expect(cells[at + i]!.glyph).not.toBe(atlas.index[ebcdic]);
    }
  });

  it('takes the glyph from the atlas INDEX, and not from the CG code itself', () => {
    // THE ASSERTION THAT PINS THE `column()` REUSE. The atlas `index` is a SPARSE PACKING, not the
    // identity: its encodings run 0..543 with holes, and 175 of its 431 entries differ from their CG
    // code -- the first being CG 257 -> column 256. Against the real atlas this is unobservable,
    // because all 44 distinct label characters land in the identity region below 256, so the
    // rejected `cg % atlas.cols` left every other test in this file green. A deliberately shifted
    // index makes the two calculations disagree for every character. It matters beyond hygiene:
    // `keypad.ts` ranks box-drawing borders as the first font fallback, and the box-drawing glyphs
    // are where the non-identity entries live.
    const shift = 1000;
    const shifted: AtlasGeometry = {
      cellWidth: atlas.cellWidth,
      cellHeight: atlas.cellHeight,
      cols: atlas.cols,
      index: Object.fromEntries(
        Object.keys(atlas.index).map((cg) => [Number(cg), Number(cg) + shift])),
    };
    const r = keypadRegion(shifted, scheme, 0);
    const enter = r.buttons.find((b) => b.label === 'Enter')!;
    const cells = labelCells(r, enter);
    const at = centreOffset('Enter');
    for (let i = 0; i < 'Enter'.length; i++) {
      const cg = ebcdicToCg(cp037.fromUnicode('Enter'[i]!));
      expect(cells[at + i]!.glyph).toBe(cg + shift);
      expect(cells[at + i]!.glyph).not.toBe(cg % shifted.cols);
    }
  });

  it('falls back to boxsolid for a label character the atlas has no glyph for', () => {
    // The other half of `column()`: a miss must not become an out-of-range column, which would
    // sample whichever glyph sits next along and read as corruption. No current label character can
    // miss, and nor can the space the centring pads with, so an atlas carrying boxsolid ALONE is the
    // only way to assert it -- and it also fails under `cg % atlas.cols`, which has no fallback at
    // all.
    const bare: AtlasGeometry = {
      cellWidth: atlas.cellWidth,
      cellHeight: atlas.cellHeight,
      cols: atlas.cols,
      index: { [CG_BOXSOLID]: 7 },
    };
    const cells = keypadRegion(bare, scheme, 0).cells;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.glyph === 7)).toBe(true);
  });

  it('carries the action AND the label onto the button, unchanged', () => {
    // Task 3 pins label against action in `frontend/test/keypad.test.ts`. That map is worth
    // nothing if this file re-derives one from the other, so check the pair survives the copy.
    const bs = region().buttons;
    for (const key of KEYPAD_KEYS) {
      const b = bs.find((c) => c.label === key.label)!;
      expect(b, key.label).toBeDefined();
      expect(b.action).toEqual(key.action);
    }
  });

  it('draws every declared table row', () => {
    // KEYPAD_ROWS exists so an emptied row is a failure rather than a silently shorter keypad.
    const ys = new Set(keypadRegion(atlas, scheme, 350).buttons.map((b) => b.y));
    expect(ys.size).toBe(KEYPAD_ROWS.length);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(region())).toBe(JSON.stringify(region()));
  });
});

describe('hitTest', () => {
  const bs = region().buttons;
  const first = bs[0]!;

  it('finds the button under a point inside it', () => {
    expect(hitTest(bs, first.x + 1, first.y + 1)?.label).toBe(first.label);
  });

  it('includes the top-left corner and EXCLUDES the bottom-right', () => {
    // Half-open, so adjacent buttons cannot both claim a pixel. This is the assertion that
    // catches an off-by-one, and the reason the mutation check below exists.
    expect(hitTest(bs, first.x, first.y)?.label).toBe(first.label);
    expect(hitTest(bs, first.x + first.w, first.y)?.label).not.toBe(first.label);
    expect(hitTest(bs, first.x, first.y + first.h)?.label).not.toBe(first.label);
  });

  it('returns undefined outside every button', () => {
    expect(hitTest(bs, -1, -1)).toBeUndefined();
    expect(hitTest(bs, 100000, 100000)).toBeUndefined();
  });

  it('never returns two buttons for one point', () => {
    for (const b of bs) {
      const mid = { x: b.x + Math.floor(b.w / 2), y: b.y + Math.floor(b.h / 2) };
      const matches = bs.filter((c) => mid.x >= c.x && mid.x < c.x + c.w
        && mid.y >= c.y && mid.y < c.y + c.h);
      expect(matches).toHaveLength(1);
    }
  });

  it('finds the button a click lands on, for all 47 of them', () => {
    // The happy-path test above uses one button, and one button cannot tell a right-answer hit
    // test from one that always returns `buttons[0]`.
    for (const b of bs) {
      expect(hitTest(bs, b.x + Math.floor(b.w / 2), b.y + Math.floor(b.h / 2)), b.label)
        .toEqual(b);
    }
  });

  it('misses the columns the clusters leave blank', () => {
    // A hit test that rounded a click to the nearest key would return a button in a gutter. Table
    // rows 2 and 3 (drawn 4 and 6, since table row r is drawn at 2r) each have THREE 6-cell gutters
    // -- at cells 18, 42 and 54, since their keys sit at 0,6,12,24,30,36,48,60 -- and they stop at
    // cell 66. Table row 4 (drawn 8) has one gutter, at 18, and stops at 48: its keys are
    // 0,6,12,24,30,36 and NOW 42, which is `NewLn`. Cell 42 on that row was in the list below until
    // Newline took it, and this test is what noticed -- the only assertion anywhere that a keypad
    // column is EMPTY. Every gutter is probed at its first and last cell.
    const r = keypadRegion(atlas, scheme, 350);
    const at = (cell: number, drawnRow: number) =>
      hitTest(r.buttons, cell * atlas.cellWidth, r.y + drawnRow * atlas.cellHeight);
    for (const drawnRow of [4, 6]) {
      for (const cell of [18, 23, 42, 47, 54, 59, 66, 71]) {
        expect(at(cell, drawnRow), `cell ${cell} on drawn row ${drawnRow}`).toBeUndefined();
      }
    }
    for (const cell of [18, 23, 48, 71]) {
      expect(at(cell, 8), `cell ${cell} on drawn row 8`).toBeUndefined();
    }
    // And the other side of the same change: the cell that STOPPED being a gutter must now be a
    // button, or moving a key to 42 and forgetting to probe it would read as a pass above.
    expect(at(42, 8)?.label, 'cell 42 on drawn row 8').toBe('NewLn');
  });
});

/**
 * The click arithmetic, AT SCALE 3 WITH A NON-ZERO CENTRING OFFSET, and that is the whole point.
 *
 * `paint` draws a scale-1 coordinate at `offset + coordinate * scale` (`blit.ts:106-107`), so a click
 * must subtract the offset and DIVIDE by the scale. At scale 1 with no centring, multiplying instead
 * of dividing and dropping the offset altogether are BOTH INVISIBLE -- and scale 1 with no centring
 * is exactly what both screenshot harnesses run at, since `browser-shot.mjs` sizes the viewport from
 * the golden. `renderer.ts` cannot be unit-tested at all (`index.ts:8-10`), so this describe is the
 * only thing in the suite that can fail for either mistake.
 *
 * BOTH MUTATIONS WERE RUN against these assertions, verbatim:
 *   `* scale` for `/ scale`    -> two failures, the first being "finds the button under the centre of
 *                                every button": `PF13: expected undefined to deeply equal
 *                                { x: +0, y: 350, w: 54, h: 14, ... }`.
 *   dropping `- at.x`/`- at.y` -> the centre probes still PASS -- `at.x / scale` is 13.3 scale-1
 *                                pixels of slop inside a 54-wide button -- and only the
 *                                last-device-pixel test fails: `PF13: expected { x: 54, y: 364, ... }
 *                                to deeply equal { x: +0, y: 350, ... }`, i.e. PF2. THAT is why the
 *                                edge probe is here and not just the centre one.
 */
describe('hitTestAt', () => {
  const scale = 3;
  const at = { x: 40, y: 17 };
  // y=350 is where `drawList` puts the region under a 24-row screen and its OIA: 25 * 14.
  const r = keypadRegion(atlas, scheme, 350);
  /** Where a scale-1 point lands on the canvas -- i.e. exactly what `paint` would draw. */
  const onCanvas = (x: number, y: number) => ({ x: at.x + x * scale, y: at.y + y * scale });

  it('finds the button under the centre of every button', () => {
    for (const b of r.buttons) {
      const p = onCanvas(b.x + b.w / 2, b.y + b.h / 2);
      expect(hitTestAt(r.buttons, p.x, p.y, at, scale), b.label).toEqual(b);
    }
  });

  it('finds it from the LAST DEVICE PIXEL of every button, which is what pins the offset', () => {
    // A centre probe cannot catch a dropped offset: `at.x / scale` is 13.3 scale-1 pixels and a
    // button is 54 wide, so the centre of one stays inside it. The last pixel does not -- it lands in
    // the neighbouring button, or outside the keypad at the end of a row.
    for (const b of r.buttons) {
      const p = onCanvas(b.x + b.w, b.y + b.h);
      expect(hitTestAt(r.buttons, p.x - 1, p.y - 1, at, scale), b.label).toEqual(b);
    }
  });

  it('excludes the first device pixel PAST a button on both axes', () => {
    // Half-open survives the scaling: `b.x + b.w` at scale belongs to the neighbour, not to `b`.
    for (const b of r.buttons) {
      const p = onCanvas(b.x + b.w, b.y + b.h);
      expect(hitTestAt(r.buttons, p.x, p.y, at, scale), b.label).not.toEqual(b);
    }
  });

  it('returns undefined for a click before the region starts', () => {
    expect(hitTestAt(r.buttons, at.x - 1, at.y - 1, at, scale)).toBeUndefined();
    expect(hitTestAt(r.buttons, 0, 0, at, scale)).toBeUndefined();
  });

  it('is hitTest itself when the scale is 1 and nothing is centred', () => {
    // Written down because it is the DEGENERATE case, not the interesting one: this assertion is
    // green under both mutations above, which is precisely why the harnesses cannot be the check.
    for (const b of r.buttons) {
      expect(hitTestAt(r.buttons, b.x, b.y, { x: 0, y: 0 }, 1)).toEqual(hitTest(r.buttons, b.x, b.y));
    }
  });
});
