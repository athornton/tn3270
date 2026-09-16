import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cp037 } from '@tn3270/core';
import { KEYPAD_KEYS, KEYPAD_ROWS, KEYPAD_KEY_WIDTH, SCHEMES } from '@tn3270/frontend';
import { keypadRegion, hitTest, KEYPAD_ROWS_TALL } from '../src/keypad.js';
import type { AtlasGeometry } from '../src/drawlist.js';
import { ebcdicToCg } from '../src/cg.js';

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
      const mine = r.cells.filter((c) => c.y === b.y && c.x >= b.x && c.x < b.x + b.w);
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
    const bs = region().buttons;
    const enter = bs.find((b) => b.label === 'Enter')!;
    const cells = region().cells.filter((c) => c.y === enter.y
      && c.x >= enter.x && c.x < enter.x + enter.w);
    for (let i = 0; i < 'Enter'.length; i++) {
      const ebcdic = cp037.fromUnicode('Enter'[i]!);
      expect(cells[i]!.glyph).toBe(atlas.index[ebcdicToCg(ebcdic)]);
      expect(cells[i]!.glyph).not.toBe(atlas.index[ebcdic]);
    }
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
    // Rows 2 and 3 stop at cell 66 and row 4 at 42, and there are two 6-cell gutters inside each
    // cluster row. A hit test that rounded a click to the nearest key would return a button here.
    const r = keypadRegion(atlas, scheme, 350);
    const row4 = r.y + 5 * atlas.cellHeight;
    expect(hitTest(r.buttons, 42 * atlas.cellWidth, row4)).toBeUndefined();
    expect(hitTest(r.buttons, 18 * atlas.cellWidth, row4)).toBeUndefined();
    expect(hitTest(r.buttons, 18 * atlas.cellWidth, r.y + 3 * atlas.cellHeight)).toBeUndefined();
  });
});
