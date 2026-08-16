import { describe, it, expect } from 'vitest';
import { Screen } from '../src/screen.js';
import { Keyboard } from '../src/keyboard.js';
import { Oia, KeyboardState } from '../src/oia.js';
import { FA } from '../src/constants.js';

/** Screen with an unprotected field at 0 (data 1-9) and a protected one at 10. */
function twoFields(): Screen {
  const s = new Screen();
  s.setFieldAttribute(0, 0x00);
  s.setFieldAttribute(10, FA.PROTECT);
  s.cursor = 1;
  return s;
}

function kb(s: Screen) {
  return new Keyboard(s, new Oia());
}

describe('typing', () => {
  it('types a character into an unprotected field and advances', () => {
    const s = twoFields();
    const k = kb(s);
    expect(k.type('A')).toBe(true);
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
    expect(s.cursor).toBe(2);
  });

  it('sets the MDT of the field it typed into', () => {
    const s = twoFields();
    kb(s).type('A');
    expect(s.fieldAt(1)!.modified).toBe(true);
  });

  it('refuses to type into a protected field and reports an input inhibit', () => {
    const s = twoFields();
    s.cursor = 11;
    const k = kb(s);
    expect(k.type('A')).toBe(false);
    expect(s.cellAt(11).ebcdic).toBe(0x00);
    expect(k.oia.keyboard).toBe(KeyboardState.ProtectedField);
  });

  it('refuses a letter in a numeric field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.NUMERIC);
    s.cursor = 1;
    const k = kb(s);
    expect(k.type('A')).toBe(false);
    expect(k.type('5')).toBe(true);
    expect(s.cellAt(1).ebcdic).toBe(0xf5);
  });

  it('refuses to type on an unformatted screen only where protected', () => {
    // With no fields at all, everything is writable.
    const s = new Screen();
    s.cursor = 0;
    expect(kb(s).type('A')).toBe(true);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
  });

  it('auto-skips to the next unprotected field when a field fills up', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);       // field 1..1 (one cell)
    s.setFieldAttribute(2, FA.PROTECT | FA.NUMERIC); // auto-skip field
    s.setFieldAttribute(5, 0x00);       // next typable field, data at 6
    s.cursor = 1;
    const k = kb(s);
    k.type('A');
    expect(s.cursor).toBe(6);
  });

  it('inserts rather than overwrites in insert mode', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    s.setChar(2, 0xc2);
    s.cursor = 1;
    const k = kb(s);
    k.insertMode = true;
    expect(k.type('X')).toBe(true);
    expect(s.cellAt(1).ebcdic).toBe(0xe7); // X
    expect(s.cellAt(2).ebcdic).toBe(0xc1); // A pushed right
    expect(s.cellAt(3).ebcdic).toBe(0xc2); // B pushed right
  });

  it('refuses an insert that would overflow the field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(3, FA.PROTECT); // field data is 1-2 only
    s.setChar(1, 0xc1);
    s.setChar(2, 0xc2);
    s.cursor = 1;
    const k = kb(s);
    k.insertMode = true;
    expect(k.type('X')).toBe(false);
    expect(k.oia.keyboard).toBe(KeyboardState.Overflow);
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
  });

  it('types a whole string, respecting protection', () => {
    const s = twoFields();
    const k = kb(s);
    expect(k.typeString('AB')).toBe(true);
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
    expect(s.cellAt(2).ebcdic).toBe(0xc2);
  });
});

describe('cursor movement', () => {
  it('moves in four directions with wrapping', () => {
    const s = new Screen();
    const k = kb(s);
    s.cursor = 0;
    k.left();
    expect(s.cursor).toBe(1919);
    k.right();
    expect(s.cursor).toBe(0);
    k.down();
    expect(s.cursor).toBe(80);
    k.up();
    expect(s.cursor).toBe(0);
  });

  it('Home goes to the first unprotected field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PROTECT);
    s.setFieldAttribute(50, 0x00);
    s.cursor = 900;
    kb(s).home();
    expect(s.cursor).toBe(51);
  });

  it('Home goes to address 0 on an unformatted screen', () => {
    const s = new Screen();
    s.cursor = 900;
    kb(s).home();
    expect(s.cursor).toBe(0);
  });

  it('Tab moves to the next unprotected field, wrapping', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(10, FA.PROTECT);
    s.setFieldAttribute(20, 0x00);
    s.cursor = 1;
    const k = kb(s);
    k.tab();
    expect(s.cursor).toBe(21);
    k.tab();
    expect(s.cursor).toBe(1); // wrapped
  });

  it('BackTab moves to the start of the previous unprotected field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(20, 0x00);
    s.cursor = 25;
    const k = kb(s);
    k.backTab();
    expect(s.cursor).toBe(21); // start of the field we are in
    k.backTab();
    expect(s.cursor).toBe(1);  // previous field
  });

  it('Newline moves to the first unprotected cell of the next line', () => {
    const s = new Screen();
    s.setFieldAttribute(80, 0x00);
    s.cursor = 5;
    kb(s).newline();
    expect(s.cursor).toBe(81);
  });
});

describe('erase actions', () => {
  it('EraseEOF nulls from the cursor to the end of the field and sets MDT', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(5, FA.PROTECT);
    for (let a = 1; a <= 4; a++) s.setChar(a, 0xc1);
    s.cursor = 2;
    const k = kb(s);
    k.eraseEOF();
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
    expect(s.cellAt(4).ebcdic).toBe(0x00);
    expect(s.fieldAt(1)!.modified).toBe(true);
  });

  it('EraseEOF is refused in a protected field', () => {
    const s = twoFields();
    s.cursor = 11;
    const k = kb(s);
    k.eraseEOF();
    expect(k.oia.keyboard).toBe(KeyboardState.ProtectedField);
  });

  it('EraseInput clears unprotected fields, resets MDT and homes the cursor', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    s.setMDT(0);
    s.setFieldAttribute(10, FA.PROTECT);
    s.setChar(11, 0xc2);
    s.cursor = 500;
    kb(s).eraseInput();
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(11).ebcdic).toBe(0xc2);
    expect(s.fieldAt(1)!.modified).toBe(false);
    expect(s.cursor).toBe(1);
  });

  it('Backspace moves left and nulls, within the field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setChar(1, 0xc1);
    s.setChar(2, 0xc2);
    s.cursor = 3;
    const k = kb(s);
    k.backspace();
    expect(s.cursor).toBe(2);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
  });

  it('Delete shifts the rest of the field left', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(5, FA.PROTECT);
    s.setChar(1, 0xc1);
    s.setChar(2, 0xc2);
    s.setChar(3, 0xc3);
    s.cursor = 1;
    const k = kb(s);
    k.deleteChar();
    expect(s.cellAt(1).ebcdic).toBe(0xc2);
    expect(s.cellAt(2).ebcdic).toBe(0xc3);
    expect(s.cellAt(3).ebcdic).toBe(0x00);
  });
});

describe('OIA', () => {
  it('starts unlocked and clears an inhibit on Reset', () => {
    const s = twoFields();
    s.cursor = 11;
    const k = kb(s);
    expect(k.oia.keyboard).toBe(KeyboardState.Unlocked);
    k.type('A');
    expect(k.oia.keyboard).toBe(KeyboardState.ProtectedField);
    k.reset();
    expect(k.oia.keyboard).toBe(KeyboardState.Unlocked);
  });

  it('renders a program check as x3270 does', () => {
    const o = new Oia();
    o.programCheck(754);
    expect(o.keyboard).toBe(KeyboardState.ProgramCheck);
    expect(o.toText()).toContain('X PROG754');
  });

  it('shows the connection and wait indicators', () => {
    const o = new Oia();
    expect(o.toText()).toContain('X Disconnected');
    o.connected = true;
    o.tn3270Mode = true;
    expect(o.toText()).toContain('4 A');
    o.waitingForHost = true;
    expect(o.toText()).toContain('X Wait');
  });

  it('reports insert mode', () => {
    const o = new Oia();
    o.insertMode = true;
    expect(o.toText()).toContain('^');
  });
});
