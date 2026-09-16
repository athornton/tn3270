import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cp037 } from '@tn3270/core';
import { KEYPAD_KEYS, KEYPAD_ROWS, KEYPAD_KEY_WIDTH, SCHEMES } from '@tn3270/frontend';
import { keypadRegion, KEYPAD_ROWS_TALL, type KeypadRegion } from '../src/keypad.js';
// From `hittest.js`, not `keypad.js`: the renderer hit-tests in the BROWSER, so this function lives
// in the one keypad module with no runtime import. See hittest.ts, and the graph assertion in
// `renderer-imports.test.ts`.
import { hitTest, type KeypadButton } from '../src/hittest.js';
import type { AtlasGeometry, DrawCell } from '../src/drawlist.js';
import { ebcdicToCg, CG_BOXSOLID } from '../src/cg.js';

/**
 * The REAL atlas, exactly as `drawlist.test.ts:11` does it.
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

/** The cells drawn inside one button, in emission order. */
const labelCells = (r: KeypadRegion, b: KeypadButton): readonly DrawCell[] =>
  r.cells.filter((c) => c.y === b.y && c.x >= b.x && c.x < b.x + b.w);

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

  it('leaves the separator row under the PF block EMPTY', () => {
    // The gap is why KEYPAD_ROWS_TALL is 6 for a 5-row table, and NOTHING else here can see it:
    // collapsing the map to [0,1,2,3,4] keeps the buttons disjoint, inside the width and inside
    // the height, so every other test in this file still passes.
    const r = keypadRegion(atlas, scheme, 350);
    const gapY = r.y + 2 * atlas.cellHeight;
    for (const b of r.buttons) expect(b.y, b.label).not.toBe(gapY);
    for (let x = 0; x < r.width; x += atlas.cellWidth) {
      expect(hitTest(r.buttons, x, gapY), `x=${x}`).toBeUndefined();
    }
    expect(r.cells.some((c) => c.y === gapY)).toBe(false);
  });

  it('draws PF13-24 ABOVE PF1-12, and starts at the region y', () => {
    // c3270's order (`Common/c3270/keypad.labels:2` and `:4`), recorded in
    // `frontend/src/keypad.ts:48-49`. A transposed row map keeps every button disjoint, so only an
    // assertion about WHICH row is where can catch it.
    const bs = keypadRegion(atlas, scheme, 350).buttons;
    const pf = (label: string) => bs.find((b) => b.label === label)!;
    expect(pf('PF13').y).toBe(350);
    expect(pf('PF1').y).toBe(350 + atlas.cellHeight);
    expect(pf('PF13').y).toBeLessThan(pf('PF1').y);
  });

  it('emits a cell for every character of every label', () => {
    const total = KEYPAD_KEYS.reduce((n, k) => n + k.label.length, 0);
    expect(region().cells.length).toBeGreaterThanOrEqual(total);
  });

  it("places each label's cells at its own button, left to right", () => {
    // The count assertion above cannot tell a correctly-placed label from 46 labels piled on one
    // key: this pins x, y and ORDER against the button the label belongs to.
    const r = keypadRegion(atlas, scheme, 350);
    for (const b of r.buttons) {
      const mine = labelCells(r, b);
      expect(mine, b.label).toHaveLength(b.label.length);
      for (let i = 0; i < b.label.length; i++) {
        expect(mine[i]!.x, `${b.label}[${i}]`).toBe(b.x + i * atlas.cellWidth);
      }
    }
  });

  it('looks labels up through the CG MAP, like the screen and the OIA', () => {
    // The font is in CG order, not EBCDIC order (`cg.ts:1-30`). A label indexed by its EBCDIC byte
    // would draw a different glyph, which only a screenshot golden would catch. This must agree
    // with `column()` in drawlist.ts -- it is the same function, imported.
    const r = region();
    const enter = r.buttons.find((b) => b.label === 'Enter')!;
    const cells = labelCells(r, enter);
    for (let i = 0; i < 'Enter'.length; i++) {
      const ebcdic = cp037.fromUnicode('Enter'[i]!);
      expect(cells[i]!.glyph).toBe(atlas.index[ebcdicToCg(ebcdic)]);
      expect(cells[i]!.glyph).not.toBe(atlas.index[ebcdic]);
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
    for (let i = 0; i < 'Enter'.length; i++) {
      const cg = ebcdicToCg(cp037.fromUnicode('Enter'[i]!));
      expect(cells[i]!.glyph).toBe(cg + shift);
      expect(cells[i]!.glyph).not.toBe(cg % shifted.cols);
    }
  });

  it('falls back to boxsolid for a label character the atlas has no glyph for', () => {
    // The other half of `column()`: a miss must not become an out-of-range column, which would
    // sample whichever glyph sits next along and read as corruption. No current label can miss, so
    // an atlas carrying boxsolid ALONE is the only way to assert it -- and it also fails under
    // `cg % atlas.cols`, which has no fallback at all.
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

  it('finds the button a click lands on, for all 46 of them', () => {
    // The happy-path test above uses one button, and one button cannot tell a right-answer hit
    // test from one that always returns `buttons[0]`.
    for (const b of bs) {
      expect(hitTest(bs, b.x + Math.floor(b.w / 2), b.y + Math.floor(b.h / 2)), b.label)
        .toEqual(b);
    }
  });

  it('misses the columns the clusters leave blank', () => {
    // A hit test that rounded a click to the nearest key would return a button in a gutter. Table
    // rows 2 and 3 (drawn 3 and 4) each have THREE 6-cell gutters -- at cells 18, 42 and 54, since
    // their keys sit at 0,6,12,24,30,36,48,60 -- and they stop at cell 66. Table row 4 (drawn 5) has
    // one gutter, at 18, and stops at 42. Every gutter is probed at its first and last cell.
    const r = keypadRegion(atlas, scheme, 350);
    const at = (cell: number, drawnRow: number) =>
      hitTest(r.buttons, cell * atlas.cellWidth, r.y + drawnRow * atlas.cellHeight);
    for (const drawnRow of [3, 4]) {
      for (const cell of [18, 23, 42, 47, 54, 59, 66, 71]) {
        expect(at(cell, drawnRow), `cell ${cell} on drawn row ${drawnRow}`).toBeUndefined();
      }
    }
    for (const cell of [18, 23, 42, 71]) {
      expect(at(cell, 5), `cell ${cell} on drawn row 5`).toBeUndefined();
    }
  });
});
