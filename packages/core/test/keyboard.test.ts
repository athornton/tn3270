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

  it('BackTab does not park the cursor on an attribute byte of a zero-length field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);   // field A: data 1..9
    s.setFieldAttribute(10, 0x00);  // zero-length unprotected field: next attr immediately follows
    s.setFieldAttribute(11, 0x00);  // field B: data starts at 12
    s.cursor = 10; // parked on the zero-length field's own attribute byte
    const k = kb(s);
    k.backTab();
    expect(s.isFieldAttribute(s.cursor)).toBe(false);
    const fieldCountBefore = s.fields().length;
    k.type('A');
    expect(s.fields().length).toBe(fieldCountBefore); // field boundary at 11 must survive
  });

  it('Tab does not park the cursor on an attribute byte of a zero-length field', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);   // field A: data 1..9
    s.setFieldAttribute(10, 0x00);  // zero-length unprotected field: next attr immediately follows
    s.setFieldAttribute(11, 0x00);  // field B: data starts at 12
    s.cursor = 10; // parked on the zero-length field's own attribute byte
    const k = kb(s);
    k.tab();
    expect(s.isFieldAttribute(s.cursor)).toBe(false);
    const fieldCountBefore = s.fields().length;
    k.type('A');
    expect(s.fields().length).toBe(fieldCountBefore); // field boundary at 11 must survive
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

  it('renders enter-inhibit as x3270 does', () => {
    // x3270 folds KL_ENTER_INHIBIT into "X Wait" in every one of its four
    // status renderers — `} else if (kybdlock & (KL_ENTER_INHIBIT | KL_BID)) {
    // other_msg = "X Wait";` (c3270/screen.c:2385-2386, and identically
    // Common/vstatus.c:279-280, x3270/status.c:643, wc3270/screen.c:3122).
    const o = new Oia();
    o.connected = true;
    o.inhibit(KeyboardState.EnterInhibit);
    expect(o.toText()).toContain('X Wait');
  });
});

describe('enter-inhibit refuses input', () => {
  // GA23-0059 p. 5-53 step 1 of Read Partition processing (pages.txt:6413):
  // "1. The enter-inhibit condition is raised." A state nobody enforces is not
  // a fix, so these assert through the Keyboard, not just the Oia.
  it('refuses to type while inhibited, and leaves the buffer untouched', () => {
    const s = twoFields();
    const k = kb(s);
    k.oia.inhibit(KeyboardState.EnterInhibit);
    expect(k.type('A')).toBe(false);
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cursor).toBe(1);
    // And the state is NOT overwritten by an operator-error state: the refusal
    // must leave the host-imposed inhibit in place for the host to clear.
    expect(k.oia.keyboard).toBe(KeyboardState.EnterInhibit);
  });

  it('refuses typeString on the very first character', () => {
    const s = twoFields();
    const k = kb(s);
    k.oia.inhibit(KeyboardState.EnterInhibit);
    expect(k.typeString('AB')).toBe(false);
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(2).ebcdic).toBe(0x00);
  });

  it('refuses to type while awaiting the first write', () => {
    // The pre-existing lock had the same unenforced gap. x3270 refuses on ANY
    // kybdlock bit, not a chosen subset: key_Character's first act is
    // `if (kybdlock) { ... enq_fta(...); return true; }` (kybd.c:1201-1210) —
    // it queues the keystroke as typeahead rather than applying it.
    const s = twoFields();
    const k = kb(s);
    k.oia.inhibit(KeyboardState.AwaitingFirstWrite);
    expect(k.type('A')).toBe(false);
    expect(s.cellAt(1).ebcdic).toBe(0x00);
  });

  it('lets the operator type again once Reset clears the inhibit', () => {
    // Reset is the operator's own escape. It is NOT the protocol's clear for
    // enter-inhibit (that is the host's next write), but x3270's do_reset
    // clears every bit but KL_BID when explicit (kybd.c:2062), so an operator
    // who presses Reset is not stuck.
    const s = twoFields();
    const k = kb(s);
    k.oia.inhibit(KeyboardState.EnterInhibit);
    expect(k.type('A')).toBe(false);
    k.reset();
    expect(k.type('A')).toBe(true);
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
  });

  it('still reports an operator error when the keyboard was unlocked', () => {
    // The guard must not swallow the operator-error path: a protected-field
    // refusal from an UNLOCKED keyboard still has to set X Protected.
    const s = twoFields();
    s.cursor = 11;
    const k = kb(s);
    expect(k.type('A')).toBe(false);
    expect(k.oia.keyboard).toBe(KeyboardState.ProtectedField);
  });
});

describe('Dup and Field Mark', () => {
  /**
   * Three adjacent unprotected fields: A (attr 0, data 1-9), B (attr 10, data
   * 11-19) and C (attr 20, data 21-...). Three, not two, because the Dup tests
   * below have to tell "moved to the next field" apart from "moved to the field
   * after that" — with only two fields those two answers coincide.
   */
  function threeFields(): Screen {
    const s = new Screen();
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(10, 0x00);
    s.setFieldAttribute(20, 0x00);
    return s;
  }

  /** Both keys and the byte each writes, so a failure names the one that broke. */
  const bothKeys: [string, (k: Keyboard) => boolean, number][] = [
    ['Dup', (k) => k.dup(), 0x1c],
    ['Field Mark', (k) => k.fieldMark(), 0x1e],
  ];

  /**
   * Both are TYPED CHARACTERS, not AIDs: x3270 implements them as
   * `key_Character(EBC_dup/EBC_fm, ...)` at kybd.c:2788 and :2825. The bytes are
   * EBC_dup = 0x1c and EBC_fm = 0x1e, from 3270ds.h:364-365.
   */
  it('write 0x1c and 0x1e into the buffer', () => {
    const a = threeFields();
    a.cursor = 3;
    expect(kb(a).dup()).toBe(true);
    expect(a.cellAt(3).ebcdic).toBe(0x1c);

    const b = threeFields();
    b.cursor = 3;
    expect(kb(b).fieldMark()).toBe(true);
    expect(b.cellAt(3).ebcdic).toBe(0x1e);
  });

  it('set MDT, because the host must see the field changed', () => {
    for (const [name, press] of bothKeys) {
      const s = threeFields();
      s.cursor = 3;
      expect(s.fieldAt(3)!.modified, name).toBe(false);
      press(kb(s));
      expect(s.fieldAt(3)!.modified, name).toBe(true);
    }
  });

  /**
   * THE NON-OBVIOUS ONE, and it is the OPPOSITE way round from "Dup does not
   * auto-skip".
   *
   * kybd.c:1435 does suppress key_Character's auto-skip for a keyboard Dup —
   * `if (auto_skip && (pasting || (ebc != EBC_dup)))`, commented "for all pasted
   * data (even DUP), and for all keyboard-generated data except DUP" — but that
   * is not the whole key. Dup_action goes on to move the cursor itself
   * (kybd.c:2788-2792):
   *
   *     if (key_Character(EBC_dup, false, false, oerr_fail, &consumed)) {
   *         if (consumed) { cursor_move(next_unprotected(cursor_addr)); }
   *
   * so the NET effect of the Dup key is always a tab to the next unprotected
   * field, from anywhere in the field. The manual says so in one sentence
   * (GA23-0059 p. 7-12, pages.txt:12637-12638): "Operation of this key causes a
   * X'1C' code to be entered into the presentation space, a Tab key operation to
   * be performed, and the MDT bit to be set to 1." That is what Dup is FOR — it
   * tells the program "duplicate the rest of this field", so there is nothing
   * left to type in the field and the operator is finished with it.
   *
   * Field Mark marks a boundary WITHIN a field, so it advances one position like
   * any other typed character (kybd.c:2825 passes it to key_Character and does
   * nothing afterwards).
   */
  it('Dup performs a Tab operation and Field Mark just advances', () => {
    const a = threeFields();
    a.cursor = 3; // mid-field, six data cells still to its right
    kb(a).dup();
    expect(a.cursor).toBe(11); // start of field B

    const b = threeFields();
    b.cursor = 3;
    kb(b).fieldMark();
    expect(b.cursor).toBe(4); // one position on, still inside field A
  });

  /**
   * The OTHER half of the rule above, and the one a bare `cursor = inc(cursor)`
   * would silently satisfy: at the last data cell of a field, Field Mark must run
   * the auto-skip, because it is an ordinary typed character and that is what
   * `type()` does there. Position 10 is field B's ATTRIBUTE byte — parking the
   * cursor on one is the bug `advanceAfterType` exists to prevent, and the next
   * keystroke there would destroy the field boundary.
   *
   * Pinning this is the point of the whole task: Dup's cursor rule and Field
   * Mark's differ, so both directions have to be falsifiable, not just Dup's.
   */
  it('Field Mark at the end of a field auto-skips like any typed character', () => {
    const s = threeFields();
    s.cursor = 9; // last data cell of field A; 10 is field B's attribute
    kb(s).fieldMark();
    expect(s.cellAt(9).ebcdic).toBe(0x1e);
    expect(s.cursor).toBe(11); // field B's first data cell, not the attribute at 10
    expect(s.isFieldAttribute(s.cursor)).toBe(false);

    // And the same screen and position with `type()` agrees, which is the actual
    // claim: Field Mark's advance IS the typed-character advance.
    const t = threeFields();
    t.cursor = 9;
    kb(t).type('A');
    expect(t.cursor).toBe(s.cursor);
  });

  /**
   * What the auto-skip suppression at kybd.c:1435 actually buys, and the reason
   * `dup()` must not advance BEFORE tabbing. At the last data cell of a field,
   * `advanceAfterType` already tabs to the next field — as the test above
   * asserts — so a Dup that ran it and then tabbed again would land two fields
   * away, skipping field B entirely. x3270 avoids that by suppressing the
   * auto-skip so that `next_unprotected` starts from the field attribute rather
   * than from the next field's first data cell.
   */
  it('Dup at the end of a field lands on the next field, not the one after', () => {
    const s = threeFields();
    s.cursor = 9; // last data cell of field A; 10 is field B's attribute
    kb(s).dup();
    expect(s.cursor).toBe(11); // B, not C at 21
  });

  /**
   * AN UNFORMATTED SCREEN, where there is no field to protect, no MDT to set and
   * no field to tab into. The whole buffer is writable by definition, so both keys
   * write — and the cursor lands where x3270's does, which is the part that looks
   * accidental and is not.
   *
   * Dup ends up at address 0. That is `next_unprotected`'s documented answer when
   * there is no unprotected field: "Returns the address following the unprotected
   * attribute byte, or 0 if no nonzero-width unprotected field can be found"
   * (ctlr.c:518-521), and x3270 reaches it the same way — key_Character's
   * auto-skip loop `while (ea_buf[baddr].fa)` never runs on a screen with no
   * attributes, so Dup_action calls next_unprotected on a buffer that has none.
   * Our `tab()` spells the same fallback as `if (fields.length === 0) cursor = 0`.
   * Pinned because it is agreement between two independently written fallbacks,
   * and a change to either would otherwise break it silently.
   *
   * Field Mark just advances, x3270's auto-skip loop having nothing to skip.
   */
  it('write into an unformatted screen, Dup homing and Field Mark advancing', () => {
    const d = new Screen();
    d.cursor = 5;
    expect(kb(d).dup()).toBe(true); // and the absent field does not throw
    expect(d.cellAt(5).ebcdic).toBe(0x1c);
    expect(d.cursor).toBe(0);

    const fm = new Screen();
    fm.cursor = 5;
    expect(kb(fm).fieldMark()).toBe(true);
    expect(fm.cellAt(5).ebcdic).toBe(0x1e);
    expect(fm.cursor).toBe(6);
  });

  it('are refused in a protected field, with the reason in the OIA', () => {
    for (const [name, press] of bothKeys) {
      const s = twoFields();
      s.cursor = 11; // inside the protected field at 10
      const k = kb(s);
      expect(press(k), name).toBe(false);
      expect(s.cellAt(11).ebcdic, name).toBe(0x00);
      expect(s.cursor, name).toBe(11);
      expect(k.oia.keyboard, name).toBe(KeyboardState.ProtectedField);
    }
  });

  /**
   * A NUMERIC FIELD TAKES DUP AND REFUSES FIELD MARK, which is the manual's list
   * and not x3270's byte test.
   *
   * GA23-0059 p. 4-13 (pages.txt:3261-3262): "Numeric fields are limited to
   * numeric characters, the minus and decimal sign characters, and the duplicate
   * (DUP) control." DUP is IN the permitted set — duplicating the previous
   * record's date or account number in a numeric data-entry field is the key's
   * whole purpose — and Field Mark is not.
   *
   * x3270's numeric test permits only EBC_0..EBC_9, plus, minus, period and
   * comma (kybd.c:1232-1238), so it happens to refuse DUP as well. We do not
   * follow it there: that test is gated on `appres.numeric_lock`, which defaults
   * to ResFalse (x3270/resources.c:337), so x3270 out of the box refuses neither
   * — the byte set is the shape of the numeric-lock feature rather than a
   * considered ruling on DUP.
   *
   * The Dup half asserts the FULL key, not just a non-refusal: permitting it has
   * to leave a working Dup, so the byte, the MDT bit and the tab are all checked.
   * Each half gets its own screen, so neither depends on the other's leftover OIA
   * state.
   */
  it('permit Dup in a numeric field and refuse Field Mark there', () => {
    const numericThenTypable = (): Screen => {
      const s = new Screen();
      s.setFieldAttribute(0, FA.NUMERIC); // numeric, unprotected: data 1-9
      s.setFieldAttribute(10, 0x00);      // an ordinary field to tab into: data 11-
      s.cursor = 3;
      return s;
    };

    const fm = numericThenTypable();
    const kfm = kb(fm);
    expect(kfm.fieldMark()).toBe(false);
    expect(kfm.oia.keyboard).toBe(KeyboardState.Numeric);
    expect(fm.cellAt(3).ebcdic).toBe(0x00);
    expect(fm.fieldAt(3)!.modified).toBe(false);

    const d = numericThenTypable();
    expect(kb(d).dup()).toBe(true);
    expect(d.cellAt(3).ebcdic).toBe(0x1c);
    expect(d.fieldAt(3)!.modified).toBe(true);
    expect(d.cursor).toBe(11); // and it still tabs
  });

  /**
   * Insert mode pushes the field right first, exactly as for a typed character.
   * x3270 makes no exception for these two bytes: key_Character's `ins_prep` call
   * is reached whatever `ebc` is (kybd.c:1365-1366, the SBCS case).
   *
   * Both keys, because Dup's insert path is `shiftRight` followed by `tab()` and
   * nothing else exercises that combination. The cursor is deliberately left out:
   * where it ends up is the two keys' own rule, asserted above.
   */
  it('insert rather than overwrite in insert mode', () => {
    for (const [name, press, byte] of bothKeys) {
      const s = threeFields();
      s.setChar(1, 0xc1);
      s.setChar(2, 0xc2);
      s.cursor = 1;
      const k = kb(s);
      k.insertMode = true;
      expect(press(k), name).toBe(true);
      expect(s.cellAt(1).ebcdic, name).toBe(byte);
      expect(s.cellAt(2).ebcdic, name).toBe(0xc1); // A pushed right
      expect(s.cellAt(3).ebcdic, name).toBe(0xc2); // B pushed right
    }
  });

  it('are refused when an insert would overflow the field', () => {
    for (const [name, press] of bothKeys) {
      const s = new Screen();
      s.setFieldAttribute(0, 0x00);
      s.setFieldAttribute(3, FA.PROTECT); // field data is 1-2 only, and both are full
      s.setChar(1, 0xc1);
      s.setChar(2, 0xc2);
      s.cursor = 1;
      const k = kb(s);
      k.insertMode = true;
      expect(press(k), name).toBe(false);
      expect(k.oia.keyboard, name).toBe(KeyboardState.Overflow);
      expect(s.cellAt(1).ebcdic, name).toBe(0xc1);
    }
  });

  it('are refused while the host holds the keyboard locked', () => {
    for (const [name, press] of bothKeys) {
      const s = threeFields();
      s.cursor = 3;
      const k = kb(s);
      k.oia.inhibit(KeyboardState.SystemWait);
      expect(press(k), name).toBe(false);
      expect(s.cellAt(3).ebcdic, name).toBe(0x00);
      expect(s.cursor, name).toBe(3);
      // The host-imposed lock survives, for the host to clear. See Keyboard.type.
      expect(k.oia.keyboard, name).toBe(KeyboardState.SystemWait);
    }
  });
});
