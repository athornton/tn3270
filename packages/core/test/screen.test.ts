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

  it('rejects degenerate geometry', () => {
    expect(() => new Screen({ rows: 0, cols: 80 })).toThrow(RangeError);
    expect(() => new Screen({ rows: 24, cols: 0 })).toThrow(RangeError);
    expect(() => new Screen({ rows: 24.5, cols: 80 })).toThrow(RangeError);
  });

  it('rejects out-of-range and non-integer addresses in the public accessors', () => {
    const s = new Screen();
    expect(() => s.cellAt(-1)).toThrow(RangeError);
    expect(() => s.cellAt(1920)).toThrow(RangeError);
    expect(() => s.cellAt(5.5)).toThrow(RangeError);
    expect(() => s.setChar(1920, 0xc1)).toThrow(RangeError);
    expect(() => s.setFieldAttribute(1920, 0)).toThrow(RangeError);
    expect(() => s.attributeAt(1920)).toThrow(RangeError);
    expect(() => s.isFieldAttribute(1920)).toThrow(RangeError);
    expect(() => s.fieldAt(1920)).toThrow(RangeError);
    expect(() => s.setMDT(1920)).toThrow(RangeError);
    expect(() => s.rowText(0)).toThrow(RangeError);
    expect(() => s.rowText(25)).toThrow(RangeError);
  });

  it('rejects out-of-range row/col in fromRowCol, which is where CLI input becomes an address', () => {
    const s = new Screen();
    expect(() => s.fromRowCol(0, 1)).toThrow(RangeError);
    expect(() => s.fromRowCol(25, 1)).toThrow(RangeError);
    expect(() => s.fromRowCol(1, 0)).toThrow(RangeError);
    expect(() => s.fromRowCol(1, 81)).toThrow(RangeError);
  });

  it('handles a non-24x80 geometry across row/col conversion, text rendering and field wrap', () => {
    const s = new Screen({ rows: 43, cols: 80 });
    expect(s.toRowCol(3439)).toEqual({ row: 43, col: 80 });
    expect(s.fromRowCol(43, 80)).toBe(3439);
    expect(s.rowText(43)).toHaveLength(80);
    s.setFieldAttribute(3439, FA.PROTECT);
    const f = s.fieldAt(0);
    expect(f!.attrAddr).toBe(3439);
    expect(f!.start).toBe(0);
    expect(f!.length).toBe(3439);
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

  it('rowText blanks every attribute position in the row, not just the first', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    s.setFieldAttribute(1, FA.PROTECT);
    s.setChar(2, 0xc2);
    s.setFieldAttribute(3, 0);
    expect(s.rowText(1).slice(0, 4)).toBe('A B ');
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

  it('overwriting a field attribute with a character collapses two fields into one', () => {
    const s = new Screen();
    s.setFieldAttribute(10, FA.PROTECT);
    s.setFieldAttribute(20, 0);
    expect(s.fields()).toHaveLength(2);
    s.setChar(10, 0xc1); // destroys the boundary between the two fields
    const fs = s.fields();
    expect(fs).toHaveLength(1);
    expect(fs[0]!.attrAddr).toBe(20);
    // The merged field now spans everything except the one attribute at 20.
    expect(fs[0]!.length).toBe(1919);
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

  it('a single field attribute governs the entire rest of the buffer', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    const fs = s.fields();
    expect(fs).toHaveLength(1);
    expect(fs[0]!.length).toBe(1919);
  });

  it('an attribute at the last address governs address 0, wrapped', () => {
    const s = new Screen();
    s.setFieldAttribute(1919, FA.PROTECT);
    const f = s.fieldAt(0);
    expect(f!.attrAddr).toBe(1919);
    expect(f!.start).toBe(0);
    expect(f!.length).toBe(1919);
  });

  it('two adjacent attributes produce a zero-length field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setFieldAttribute(1, 0);
    const f = s.fieldAt(0)!; // fieldAt on the attribute address itself
    expect(f.attrAddr).toBe(0);
    expect(f.length).toBe(0);
    // start points AT the next attribute, not at a data cell.
    expect(f.start).toBe(1);
    expect(s.isFieldAttribute(f.start)).toBe(true);
  });

  it('fieldAt on an attribute position returns that attribute\'s own field', () => {
    const s = new Screen();
    s.setFieldAttribute(10, FA.PROTECT);
    s.setFieldAttribute(20, 0);
    const f = s.fieldAt(10);
    expect(f!.attrAddr).toBe(10);
  });

  it('isFormatted and fields stay in agreement across a series of mutations', () => {
    const s = new Screen();
    expect(s.isFormatted()).toBe(s.fields().length > 0);
    s.setFieldAttribute(5, FA.PROTECT);
    expect(s.isFormatted()).toBe(s.fields().length > 0);
    s.setFieldAttribute(50, 0);
    expect(s.isFormatted()).toBe(s.fields().length > 0);
    s.setChar(5, 0xc1); // destroys one of the two attributes
    expect(s.isFormatted()).toBe(s.fields().length > 0);
    s.setChar(50, 0xc2); // destroys the last attribute
    expect(s.isFormatted()).toBe(s.fields().length > 0);
    expect(s.isFormatted()).toBe(false);
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

  it('autoSkip requires protected AND numeric, not either alone', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT); // protected only
    s.setFieldAttribute(10, FA.NUMERIC); // numeric only
    s.setFieldAttribute(20, FA.PROTECT | FA.NUMERIC); // both
    expect(s.fieldAt(1)!.autoSkip).toBe(false);
    expect(s.fieldAt(11)!.autoSkip).toBe(false);
    expect(s.fieldAt(21)!.autoSkip).toBe(true);
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

  it('setMDT is a no-op on an address that is not a field attribute', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0);
    s.setMDT(5); // not an attribute address
    expect(s.fieldAt(1)!.modified).toBe(false);
  });

  it('clearAllMDT resets MDT unconditionally, including protected fields (WCC reset-MDT)', () => {
    // Read Modified filters on MDT alone, with no protection check, so a
    // protected field left carrying MDT would leak data to the host.
    const s = new Screen();
    s.setFieldAttribute(0, FA.MODIFY);
    s.setFieldAttribute(100, FA.PROTECT | FA.MODIFY);
    s.clearAllMDT();
    expect(s.fieldAt(1)!.modified).toBe(false);
    expect(s.fieldAt(101)!.modified).toBe(false);
  });

  it('clearUnprotectedMDT leaves protected fields alone (Erase Input)', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.MODIFY);
    s.setFieldAttribute(100, FA.PROTECT | FA.MODIFY);
    s.clearUnprotectedMDT();
    expect(s.fieldAt(1)!.modified).toBe(false);
    expect(s.fieldAt(101)!.modified).toBe(true);
  });

  it('decodes attribute bits from a realistic host byte with the high bits set', () => {
    // Real hosts set the base-architecture "printable" bits (0xC0); a clean
    // FA.PROTECT constant never exercises that. 0xE1 = printable | protect | MDT.
    const s = new Screen();
    s.setFieldAttribute(0, 0xe1);
    const f = s.fieldAt(1)!;
    expect(f.protected).toBe(true);
    expect(f.modified).toBe(true);
    expect(f.numeric).toBe(false);
    // The raw byte is preserved unnormalized.
    expect(f.attr).toBe(0xe1);
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

  it('Erase All Unprotected clears an unformatted screen entirely', () => {
    // An unformatted buffer is, by definition, entirely unprotected (x3270
    // ctlr.c:1443-1445): a host that prints a banner before its first SF (as
    // VM/370 does) still expects EAU to blank the screen.
    const s = new Screen();
    s.setChar(5, 0xc1);
    s.cursor = 42;
    s.eraseAllUnprotected();
    expect(s.cellAt(5)!.ebcdic).toBe(0x00);
    expect(s.isFormatted()).toBe(false);
  });

  it('Erase All Unprotected nulls a field that wraps past the end of the buffer', () => {
    const s = new Screen();
    s.setFieldAttribute(1918, 0); // unprotected, wraps: start=1919, then 0
    s.setChar(1919, 0xc1);
    s.setChar(0, 0xc2);
    s.eraseAllUnprotected();
    expect(s.cellAt(1919)!.ebcdic).toBe(0x00);
    expect(s.cellAt(0)!.ebcdic).toBe(0x00);
  });
});

describe('field partition invariants', () => {
  // These exist because a hand-rolled membership check (start <= a < start+length)
  // fooled me into reporting a bug against a live host that did not exist. That
  // check omits the attribute byte itself — `start` is attrAddr + 1 — and also
  // ignores wrap. Per GA23-0059-07 a field is "the field attribute position PLUS
  // the character positions up to, but not including, the next field attribute",
  // so the attribute byte belongs to its own field. Always ask fieldAt().
  it('fields partition the whole buffer with no gaps or overlaps', () => {
    for (const attrs of [[0], [5], [1919], [0, 20], [10, 11], [1899], [0, 960, 1919]]) {
      const s = new Screen();
      for (const a of attrs) s.setFieldAttribute(a, 0x00);
      const owner = new Map<number, number>();
      for (const f of s.fields()) {
        owner.set(f.attrAddr, f.attrAddr);
        let a = f.start;
        for (let n = 0; n < f.length; n++) {
          expect(owner.has(a), `address ${a} claimed twice`).toBe(false);
          owner.set(a, f.attrAddr);
          a = s.inc(a);
        }
      }
      expect(owner.size, `attrs ${attrs} did not cover the buffer`).toBe(s.size);
    }
  });

  it('the attribute byte belongs to its own field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setFieldAttribute(20, 0x00);
    for (const f of s.fields()) {
      expect(s.fieldAt(f.attrAddr)!.attrAddr).toBe(f.attrAddr);
    }
  });

  it('fieldAt is never null anywhere on a formatted screen', () => {
    const s = new Screen();
    s.setFieldAttribute(1759, 0x00); // only attribute, high address
    for (const a of [0, 1, 1758, 1759, 1760, 1919]) {
      expect(s.fieldAt(a), `fieldAt(${a}) was null`).not.toBeNull();
    }
    // Address 0 is governed by the wrapping field, as x3270's
    // find_field_attribute also reports.
    expect(s.fieldAt(0)!.attrAddr).toBe(1759);
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

  it('isolates cursor, fields and formatted from later mutation, not just cells', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.cursor = 3;
    const snap = s.snapshot();
    s.cursor = 999;
    s.setFieldAttribute(50, 0); // adds a field
    s.setChar(0, 0xc1); // destroys the field the snapshot saw
    expect(snap.cursor).toBe(3);
    expect(snap.fields).toHaveLength(1);
    expect(snap.fields[0]!.attrAddr).toBe(0);
    expect(snap.formatted).toBe(true);
  });

  it('freezes cell and field objects so mutation throws or is a no-op', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    const snap = s.snapshot();
    expect(Object.isFrozen(snap.cells)).toBe(true);
    expect(Object.isFrozen(snap.cells[0])).toBe(true);
    expect(Object.isFrozen(snap.fields)).toBe(true);
    expect(Object.isFrozen(snap.fields[0])).toBe(true);
  });
});

describe('cursor placement helpers', () => {
  it('firstUnprotectedStart skips zero-length fields', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0); // unprotected, but zero-length (next is attr 1)
    s.setFieldAttribute(1, FA.PROTECT); // protected
    s.setFieldAttribute(10, 0); // unprotected, has room
    expect(s.firstUnprotectedStart()).toBe(11);
  });

  it('firstUnprotectedStart returns null when nothing is typable', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    expect(s.firstUnprotectedStart()).toBeNull();
    expect(new Screen().firstUnprotectedStart()).toBeNull();
  });

  it('typableFields excludes protected, auto-skip and zero-length fields', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT); // excluded: protected
    s.setFieldAttribute(10, FA.PROTECT | FA.NUMERIC); // excluded: auto-skip
    s.setFieldAttribute(20, 0); // included
    s.setFieldAttribute(1919, 0); // excluded: zero-length (wraps to attr 0)
    const fs = s.typableFields();
    expect(fs.map((f) => f.attrAddr)).toEqual([20]);
  });
});

describe('forEachCellWithField', () => {
  it('carries the governing field forward across the swept range', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setFieldAttribute(10, 0);
    const seen: { addr: number; attrAddr: number | null; isAttr: boolean }[] = [];
    s.forEachCellWithField(0, 20, (addr, field, isAttr) => {
      seen.push({ addr, attrAddr: field?.attrAddr ?? null, isAttr });
    });
    expect(seen).toHaveLength(20);
    expect(seen[0]).toEqual({ addr: 0, attrAddr: 0, isAttr: true });
    expect(seen[5]).toEqual({ addr: 5, attrAddr: 0, isAttr: false });
    expect(seen[10]).toEqual({ addr: 10, attrAddr: 10, isAttr: true });
    expect(seen[15]).toEqual({ addr: 15, attrAddr: 10, isAttr: false });
  });

  it('reports a null field on an unformatted screen', () => {
    const s = new Screen();
    const fields: (number | null)[] = [];
    s.forEachCellWithField(0, 3, (_addr, field) => fields.push(field?.attrAddr ?? null));
    expect(fields).toEqual([null, null, null]);
  });

  it('wraps past the end of the buffer', () => {
    const s = new Screen();
    const addrs: number[] = [];
    s.forEachCellWithField(1918, 2, (addr) => addrs.push(addr));
    expect(addrs).toEqual([1918, 1919, 0, 1]);
  });
});
