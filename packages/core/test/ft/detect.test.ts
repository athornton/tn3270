import { describe, it, expect } from 'vitest';
import { Screen } from '../../src/screen.js';
import { looksLikeCutFrame } from '../../src/ft/detect.js';
import { isCutFrame, CutFrameError, O_SF, CUT_SCREEN_SIZE } from '../../src/ft/frames.js';

/**
 * 0x7c is the byte the real TK5 host plants at O_SF: protected (0x20) and numeric
 * (0x10), which is FA_IS_SKIP. Taken from `frames.test.ts`'s `markCutFrame` rather
 * than composed from `FA.PROTECT | FA.NUMERIC`, so both files agree with the fixture
 * and with the masks-never-equality reasoning in `isCutFrame`.
 */
const CUT_FRAME_ATTR = 0x7c;

/** A 24x80 screen carrying a CUT frame. */
function cutFrame24x80(): Screen {
  const s = new Screen();
  expect(s.size).toBe(CUT_SCREEN_SIZE);
  s.setFieldAttribute(O_SF, CUT_FRAME_ATTR);
  return s;
}

/** A 24x80 screen that is NOT a CUT frame: no attribute at O_SF at all. */
function plain24x80(): Screen {
  return new Screen();
}

/**
 * A model-4 (43x80) screen.
 *
 * `resize` is the only thing allowed to change the buffer's shape, and a bare
 * `new Screen()` is always 24x80 -- every model's DEFAULT size is 24x80 and the model
 * sets only the ALTERNATE.
 */
function screen43x80(): Screen {
  const s = new Screen({ alternateRows: 43, alternateCols: 80 });
  expect(s.resize(43, 80)).toBe(true);
  expect(s.size).not.toBe(CUT_SCREEN_SIZE);
  return s;
}

describe('looksLikeCutFrame', () => {
  it('agrees with isCutFrame on a real frame at 24x80', () => {
    const s = cutFrame24x80();
    expect(isCutFrame(s)).toBe(true);
    expect(looksLikeCutFrame(s)).toBe(true);
  });

  it('agrees with isCutFrame on a non-frame at 24x80', () => {
    const s = plain24x80();
    expect(isCutFrame(s)).toBe(false);
    expect(looksLikeCutFrame(s)).toBe(false);
  });

  it('RETURNS FALSE at 43x80 where isCutFrame THROWS', () => {
    // THE ENTIRE REASON THIS FUNCTION EXISTS. A protocol decider must be able to ask
    // "is this CUT?" at any geometry, because under host-chooses-the-protocol we do
    // not know the geometry is legal until after the host has answered. `isCutFrame`
    // cannot answer that question at 43x80 -- it can only fail.
    const s = screen43x80();
    s.setFieldAttribute(O_SF, CUT_FRAME_ATTR);
    expect(() => isCutFrame(s)).toThrow(CutFrameError);
    expect(looksLikeCutFrame(s)).toBe(false);
  });

  it('returns false at 43x80 for a screen with nothing at O_SF either', () => {
    // The geometry check short-circuits BEFORE the attribute test, so the answer does
    // not depend on what happens to be at that address on a bigger buffer.
    const s = screen43x80();
    expect(looksLikeCutFrame(s)).toBe(false);
  });
});
