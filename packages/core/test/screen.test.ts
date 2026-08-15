import { describe, it, expect } from 'vitest';
import { Screen } from '../src/screen.js';
import { FA } from '../src/constants.js';

describe('geometry', () => {
  it('defaults to an 80x24 model 2', () => {
    const s = new Screen();
    expect(s.rows).toBe(24);
    expect(s.cols).toBe(80);
    expect(s.size).toBe(1920);
  });

  it('accepts other geometries so TN3270E sizes need no code change', () => {
    const s = new Screen({ rows: 43, cols: 80 });
    expect(s.size).toBe(3440);
  });

  it('converts between addresses and row/col, 1-based for display', () => {
    const s = new Screen();
    expect(s.toRowCol(0)).toEqual({ row: 1, col: 1 });
    expect(s.toRowCol(79)).toEqual({ row: 1, col: 80 });
    expect(s.toRowCol(80)).toEqual({ row: 2, col: 1 });
    expect(s.toRowCol(1919)).toEqual({ row: 24, col: 80 });
    expect(s.fromRowCol(1, 1)).toBe(0);
    expect(s.fromRowCol(24, 80)).toBe(1919);
  });

  it('wraps addresses past the end of the buffer', () => {
    const s = new Screen();
    expect(s.inc(0)).toBe(1);
    expect(s.inc(1919)).toBe(0);
    expect(s.dec(0)).toBe(1919);
  });
});

describe('cells', () => {
  it('starts cleared to nulls with no fields', () => {
    const s = new Screen();
    expect(s.isFormatted()).toBe(false);
    expect(s.cellAt(0)).toEqual({ kind: 'char', ebcdic: 0x00 });
  });

  it('stores and reads back a character', () => {
    const s = new Screen();
    s.setChar(5, 0xc1);
    expect(s.cellAt(5)).toEqual({ kind: 'char', ebcdic: 0xc1 });
  });

  it('renders nulls as spaces in text output but keeps them in the buffer', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    expect(s.rowText(1).slice(0, 3)).toBe('A  ');
    expect(s.readBuffer()[1]).toBe(0x00);
  });

  it('produces one text line per row', () => {
    const s = new Screen();
    const lines = s.toText().split('\n');
    expect(lines).toHaveLength(24);
    expect(lines[0]).toHaveLength(80);
  });
});

describe('field attributes', () => {
  it('marks a field attribute position and reports the screen formatted', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    expect(s.isFormatted()).toBe(true);
    expect(s.isFieldAttribute(0)).toBe(true);
    expect(s.attributeAt(0)).toBe(FA.PROTECT);
  });

  it('displays a field attribute position as a space', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    expect(s.rowText(1)[0]).toBe(' ');
  });

  it('finds the field governing a cell by scanning backwards', () => {
    const s = new Screen();
    s.setFieldAttribute(10, FA.PROTECT);
    s.setFieldAttribute(20, 0);
    const f = s.fieldAt(15);
    expect(f).not.toBeNull();
    expect(f!.attrAddr).toBe(10);
    expect(f!.start).toBe(11);
    expect(f!.attr).toBe(FA.PROTECT);
  });

  it('wraps backwards past address 0 when locating a field', () => {
    const s = new Screen();
    s.setFieldAttribute(1900, FA.PROTECT);
    const f = s.fieldAt(5);
    expect(f!.attrAddr).toBe(1900);
  });

  it('returns null for an unformatted screen', () => {
    expect(new Screen().fieldAt(5)).toBeNull();
  });

  it('overwriting a field attribute with a character removes the field', () => {
    // This is the case that breaks emulators which store fields as objects.
    const s = new Screen();
    s.setFieldAttribute(10, FA.PROTECT);
    expect(s.fields()).toHaveLength(1);
    s.setChar(10, 0xc1);
    expect(s.fields()).toHaveLength(0);
    expect(s.isFormatted()).toBe(false);
  });

  it('lists fields in address order with derived extents', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setFieldAttribute(10, 0);
    s.setFieldAttribute(20, FA.PROTECT);
    const fs = s.fields();
    expect(fs.map((f) => f.attrAddr)).toEqual([0, 10, 20]);
    expect(fs[0]!.start).toBe(1);
    expect(fs[0]!.length).toBe(9);
    expect(fs[1]!.length).toBe(9);
    // The last field wraps around to the first attribute.
    expect(fs[2]!.length).toBe(1920 - 21);
  });
});

describe('attribute predicates', () => {
  it('decodes protection, numeric, skip, intensity and MDT', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT | FA.NUMERIC);
    expect(s.fieldAt(1)!.protected).toBe(true);
    expect(s.fieldAt(1)!.numeric).toBe(true);
    expect(s.fieldAt(1)!.autoSkip).toBe(true);

    s.setFieldAttribute(100, FA.INT_HIGH_SEL);
    expect(s.fieldAt(101)!.intensified).toBe(true);
    expect(s.fieldAt(101)!.protected).toBe(false);

    s.setFieldAttribute(200, FA.INT_ZERO_NSEL);
    expect(s.fieldAt(201)!.hidden).toBe(true);

    s.setFieldAttribute(300, FA.MODIFY);
    expect(s.fieldAt(301)!.modified).toBe(true);
  });

  it('sets and clears the modified data tag', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0);
    expect(s.fieldAt(1)!.modified).toBe(false);
    s.setMDT(0);
    expect(s.fieldAt(1)!.modified).toBe(true);
    s.clearAllMDT();
    expect(s.fieldAt(1)!.modified).toBe(false);
  });

  it('clearAllMDT leaves protected fields alone', () => {
    // Erase Input and WCC reset-MDT act on unprotected fields.
    const s = new Screen();
    s.setFieldAttribute(0, FA.MODIFY);
    s.setFieldAttribute(100, FA.PROTECT | FA.MODIFY);
    s.clearAllMDT();
    expect(s.fieldAt(1)!.modified).toBe(false);
    expect(s.fieldAt(101)!.modified).toBe(true);
  });
});

describe('clearing', () => {
  it('erases everything including fields and resets the cursor', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setChar(5, 0xc1);
    s.cursor = 500;
    s.clear();
    expect(s.isFormatted()).toBe(false);
    expect(s.cellAt(5)!.ebcdic).toBe(0x00);
    expect(s.cursor).toBe(0);
  });

  it('erases only unprotected fields for Erase All Unprotected', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0);            // unprotected
    s.setChar(1, 0xc1);
    s.setFieldAttribute(10, FA.PROTECT);  // protected
    s.setChar(11, 0xc2);
    s.setMDT(0);
    s.eraseAllUnprotected();
    expect(s.cellAt(1)!.ebcdic).toBe(0x00);
    expect(s.cellAt(11)!.ebcdic).toBe(0xc2);
    expect(s.fieldAt(1)!.modified).toBe(false);
    // Field attributes themselves survive EAU.
    expect(s.isFieldAttribute(0)).toBe(true);
    expect(s.isFieldAttribute(10)).toBe(true);
  });
});

describe('snapshot', () => {
  it('produces an immutable snapshot the UI can hold', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    s.cursor = 3;
    const snap = s.snapshot();
    expect(snap.rows).toBe(24);
    expect(snap.cols).toBe(80);
    expect(snap.cursor).toBe(3);
    expect(snap.cells[0]).toEqual({ kind: 'char', ebcdic: 0xc1 });
    s.setChar(0, 0xc2);
    // The snapshot must not have changed underneath its holder.
    expect(snap.cells[0]!.ebcdic).toBe(0xc1);
  });
});
