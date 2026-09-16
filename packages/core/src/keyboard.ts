import { cp037, type CodePage } from './codepage.js';
import { EBCDIC_DUP, EBCDIC_FIELD_MARK } from './constants.js';
import { Oia, KeyboardState } from './oia.js';
import type { Screen, Field } from './screen.js';

/**
 * 3270 keyboard actions over a screen buffer.
 *
 * Operates on ACTIONS (Enter, Tab, EraseEOF), never on physical keys — mapping
 * keys to actions is the GUI's job in stage 2, and the CLI's job here. Every
 * method that can be refused returns false and records why in the OIA rather
 * than throwing, because an input inhibit is a normal operating condition.
 */
export class Keyboard {
  insertMode = false;

  constructor(
    private readonly screen: Screen,
    readonly oia: Oia,
    private readonly codePage: CodePage = cp037,
  ) {}

  // ---- typing ----

  /** Type one character. Returns false if the keyboard is inhibited. */
  type(char: string): boolean {
    const s = this.screen;

    // A HOST-IMPOSED LOCK REFUSES THE KEYSTROKE OUTRIGHT, and leaves the state
    // alone for the host to clear.
    //
    // Before this guard nothing enforced any lock on typing: only the CLI's
    // Wait(Settle) and Wait(InputField) consulted isInhibited (runner.ts:334,
    // :364, both `if (this.session.oia.isInhibited()) return false;`), so a
    // caller reaching Keyboard.type directly could write into a screen the host
    // had frozen — and after answering a Query that is precisely the screen it
    // would be writing into. An unenforced state is not a fix.
    //
    // x3270 refuses on ANY lock bit and it is the first thing key_Character
    // does: `if (kybdlock) { ... enq_fta(key_Character_wrapper, ...); return
    // true; }` (Common/kybd.c:1201-1210), the DBCS twin key_WCharacter doing
    // the same at kybd.c:1489-1497. It parks the keystroke on the typeahead
    // queue rather than discarding it — a queue we do not have, so we refuse
    // and return false, which is this class's documented contract for a
    // refusal.
    //
    // OPERATOR ERRORS ARE EXCLUDED, and must be, or the exclusion breaks two
    // shipped behaviours: "refuses a letter in a numeric field" types '5'
    // successfully straight after the refused 'A', and the auto-skip test types
    // on after a full field. x3270 draws the same line, clearing KL_OERR_MASK
    // and continuing where a host lock would have deferred — see
    // OERR_CLEAR_OR_ENQ (kybd.c:147-158), whose two arms are exactly
    // `kybdlock_clr(KL_OERR_MASK, action)` versus `enq_ta(action, ...)`.
    // Semantically: an operator error is the operator's own to correct with the
    // next keystroke, whereas AwaitingFirstWrite, EnterInhibit, SystemWait and
    // ProgramCheck are the host's to release.
    if (this.oia.isInhibited() && !this.oia.isOperatorError()) return false;

    const field = s.fieldAt(s.cursor);

    if (field !== null) {
      if (field.protected) {
        this.oia.inhibit(KeyboardState.ProtectedField);
        return false;
      }
      if (field.numeric && !/[0-9.\-+,]/.test(char)) {
        this.oia.inhibit(KeyboardState.Numeric);
        return false;
      }
    }

    const ebcdic = this.codePage.fromUnicode(char);

    if (this.insertMode && field !== null) {
      if (!this.shiftRight(field, s.cursor)) {
        this.oia.inhibit(KeyboardState.Overflow);
        return false;
      }
    }

    s.setChar(s.cursor, ebcdic);
    if (field !== null) s.setMDT(field.attrAddr);
    this.advanceAfterType(field);
    return true;
  }

  /** Type a string, stopping at the first refusal. */
  typeString(text: string): boolean {
    for (const ch of text) {
      if (!this.type(ch)) return false;
    }
    return true;
  }

  /**
   * The Dup key: write 0x1c, set MDT, then TAB.
   *
   * THE TAB IS THE PART THAT LOOKS WRONG AND IS RIGHT. `kybd.c:1435` suppresses
   * key_Character's auto-skip for a keyboard-generated Dup — `if (auto_skip &&
   * (pasting || (ebc != EBC_dup)))`, commented "for all pasted data (even DUP),
   * and for all keyboard-generated data except DUP" — so it is easy to conclude
   * that Dup advances one position and stops. It does not: `Dup_action` moves the
   * cursor itself once key_Character returns (`kybd.c:2788-2792`),
   *
   *     if (key_Character(EBC_dup, false, false, oerr_fail, &consumed)) {
   *         if (consumed) { cursor_move(next_unprotected(cursor_addr)); }
   *
   * so the NET effect of the key is always a move to the next unprotected field,
   * from anywhere in the field. The manual states it directly (p. 7-12,
   * pages.txt:12637-12638): "Operation of this key causes a X'1C' code to be
   * entered into the presentation space, a Tab key operation to be performed, and
   * the MDT bit to be set to 1." It is what the key MEANS — "duplicate the rest
   * of this field from the previous record" leaves nothing more to type here.
   *
   * What the suppression buys is that the tab happens ONCE. `advanceAfterType`
   * already tabs at the end of a field, so advancing first and tabbing after
   * would skip a whole field when Dup is pressed in the last cell. That is
   * exactly what x3270 avoids by starting `next_unprotected` from the field
   * attribute instead of from the next field's first data cell.
   *
   * `tab()` is the faithful equivalent of `next_unprotected` (ctlr.c:518-539)
   * here: both look for the next unprotected field of non-zero width, both wrap,
   * and both fall back to address 0 when there is none. Its extra `!autoSkip`
   * filter costs nothing, an auto-skip field being protected by definition.
   */
  dup(): boolean {
    return this.writeControl(EBCDIC_DUP, {
      cursorAfter: 'tab',
      // A NUMERIC FIELD TAKES DUP, and it is the manual's list that says so rather
      // than x3270's byte test. The permitted set names DUP explicitly (p. 4-13,
      // pages.txt:3261-3262): "Numeric fields are limited to numeric characters,
      // the minus and decimal sign characters, and the duplicate (DUP) control."
      // Duplicating the previous record's date in a numeric data-entry field is
      // the key's whole purpose, so refusing it there would break the one thing it
      // is for.
      //
      // x3270's numeric test permits only EBC_0..EBC_9, plus, minus, period and
      // comma (kybd.c:1232-1238) and so refuses DUP as well — but it is gated on
      // `appres.numeric_lock`, which defaults to ResFalse (x3270/resources.c:337),
      // so stock x3270 refuses NEITHER Dup nor Field Mark here. That byte set is
      // the shape of the numeric-lock feature, not a ruling on DUP; the manual is,
      // so the manual wins.
      allowedInNumericField: true,
    });
  }

  /**
   * The Field Mark key: write 0x1e and advance like any other typed character.
   *
   * `kybd.c:2825` is a bare `return key_Character(EBC_fm, ...)` with nothing after
   * it, so FM gets the ordinary typed-character advance — right, because a field
   * mark marks a boundary INSIDE a field, so there may well be more to type after
   * it. The manual (p. 7-13, pages.txt:12653-12655): the field mark character
   * "informs the application program of the end of a field in an unformatted
   * buffer or subfield in a formatted buffer" — quoted with its OCR repaired, the
   * scan reading "formatted butter", so do not grep for the clean phrase.
   *
   * THE MANUAL CORROBORATES THE ASYMMETRY BY OMISSION, which is worth more than
   * the x3270 code alone: its Field Mark paragraph describes the byte and the MDT
   * bit and names NO cursor operation, where Dup's paragraph one page earlier
   * spells out "a Tab key operation to be performed". Two keys documented side by
   * side, one given a tab and the other not.
   */
  fieldMark(): boolean {
    return this.writeControl(EBCDIC_FIELD_MARK, {
      cursorAfter: 'advance',
      // Field Mark is NOT in the manual's permitted set for a numeric field; see
      // the note on `dup()` for the set and for why we enforce it at all.
      allowedInNumericField: false,
    });
  }

  /**
   * Write one EBCDIC control byte as if typed, then move the cursor.
   *
   * DELIBERATELY NOT `type(ch)`: these bytes have no sensible Unicode source
   * character, so routing them through `codePage.fromUnicode` would mean
   * inventing one. It also leaves `type()`'s numeric test — a Unicode regex —
   * untouched, and states the equivalent EBCDIC rule here instead.
   *
   * Everything up to the write is `type()`'s sequence, for the reasons documented
   * there: a host-imposed lock refuses outright while an operator error does not,
   * a protected field is an operator error, and insert mode shifts the field
   * right first.
   *
   * BOTH PER-KEY POLICIES ARE THE CALLER'S, and neither is optional. An earlier
   * version took the cursor rule as a parameter but decided the numeric rule in
   * here by comparing the byte against `EBCDIC_DUP` — so a function promising to
   * write "one EBCDIC control byte" applied a Dup-only exemption to whatever byte
   * it was handed. Table 4-3 has two more members this codebase already names,
   * NUL and SUB, and a later `nul()` routed through here would have been refused
   * in a numeric field — nulls being exactly what an empty numeric cell holds —
   * with nobody having edited this method to cause it. Required fields make that
   * unwritable: a new key cannot compile without stating both answers.
   */
  private writeControl(
    ebcdic: number,
    policy: {
      /** `'tab'` is the manual's own word for what Dup does; `'advance'` is what a typed character does. */
      cursorAfter: 'tab' | 'advance';
      /** Whether a numeric field accepts this byte. Per-KEY, so it cannot be inferred here. */
      allowedInNumericField: boolean;
    },
  ): boolean {
    const s = this.screen;
    if (this.oia.isInhibited() && !this.oia.isOperatorError()) return false;

    const field = s.fieldAt(s.cursor);
    if (field !== null) {
      if (field.protected) {
        this.oia.inhibit(KeyboardState.ProtectedField);
        return false;
      }
      // The caller's flag, not a byte test: which control characters a numeric
      // field accepts is a fact about each KEY and is documented on each one. No
      // character-class test is possible or wanted for a control code.
      if (field.numeric && !policy.allowedInNumericField) {
        this.oia.inhibit(KeyboardState.Numeric);
        return false;
      }
    }

    if (this.insertMode && field !== null) {
      if (!this.shiftRight(field, s.cursor)) {
        this.oia.inhibit(KeyboardState.Overflow);
        return false;
      }
    }

    s.setChar(s.cursor, ebcdic);
    if (field !== null) s.setMDT(field.attrAddr);
    if (policy.cursorAfter === 'tab') this.tab();
    else this.advanceAfterType(field);
    return true;
  }

  /**
   * Move on after typing. At the end of a field, skip to the next typable one —
   * this is what makes "type into a panel" work.
   *
   * NOT byte-for-byte x3270's auto-skip, and the difference is here rather than
   * hidden: x3270's loop (kybd.c:1436-1442) walks off attribute bytes one at a
   * time and stops at the first position that is not one, calling
   * next_unprotected only for a field flagged auto-skip — so it can leave the
   * cursor in a PROTECTED non-auto-skip field, whereas `tab()` always finds a
   * typable one. Dup and Field Mark inherit that difference rather than
   * introduce it; what matters for them is that Field Mark advances exactly as a
   * typed character does, which it does by construction.
   */
  private advanceAfterType(field: Field | null): void {
    const s = this.screen;
    const next = s.inc(s.cursor);
    if (field === null) {
      s.cursor = next;
      return;
    }
    const endOfField = next === field.attrAddr
      || (s.isFieldAttribute(next) && next !== field.attrAddr);
    if (endOfField) {
      this.tab();
    } else {
      s.cursor = next;
    }
  }

  /** Push field contents right from `from`; false if the field would overflow. */
  private shiftRight(field: Field, from: number): boolean {
    const s = this.screen;
    const last = this.lastCellOf(field);
    if (s.cellAt(last).ebcdic !== 0x00) return false; // no room
    let a = last;
    while (a !== from) {
      const prev = s.dec(a);
      s.setChar(a, s.cellAt(prev).ebcdic);
      a = prev;
    }
    return true;
  }

  private lastCellOf(field: Field): number {
    let a = field.start;
    for (let n = 1; n < field.length; n++) a = this.screen.inc(a);
    return a;
  }

  // ---- movement ----

  left(): void { this.screen.cursor = this.screen.dec(this.screen.cursor); }
  right(): void { this.screen.cursor = this.screen.inc(this.screen.cursor); }

  up(): void {
    const s = this.screen;
    s.cursor = (s.cursor - s.cols + s.size) % s.size;
  }

  down(): void {
    const s = this.screen;
    s.cursor = (s.cursor + s.cols) % s.size;
  }

  /**
   * First typable cell, or 0 if there is none.
   *
   * Delegates to the screen so the zero-length-field guard lives in one place:
   * a zero-length field's `start` IS the next field attribute, and parking the
   * cursor there corrupts the buffer on the next keystroke. x3270's
   * next_unprotected (ctlr.c:623-638) skips them for the same reason.
   */
  home(): void {
    this.screen.cursor = this.screen.firstUnprotectedStart() ?? 0;
  }

  /** Next typable field. Wraps. */
  tab(): void {
    const s = this.screen;
    const fields = s.typableFields();
    if (fields.length === 0) { s.cursor = 0; return; }
    const current = s.fieldAt(s.cursor);
    const after = fields.find((f) => f.attrAddr > (current?.attrAddr ?? -1));
    s.cursor = (after ?? fields[0]!).start;
  }

  /**
   * Start of the field we are in; if already there, the previous typable field.
   */
  backTab(): void {
    const s = this.screen;
    const fields = s.typableFields();
    if (fields.length === 0) { s.cursor = 0; return; }
    const current = s.fieldAt(s.cursor);
    // The fast path — "already inside a typable field, so go to its start" —
    // must require length > 0 as well as unprotected. A zero-length field's
    // `start` IS the next field's attribute byte, so without that check
    // backTab parks the cursor on an attribute and the next keystroke destroys
    // that field's boundary. x3270's BackTab_action guards the same way, with
    // `!ea_buf[nbaddr].fa` in its search loop (kybd.c:1976-1979).
    if (current !== null && !current.protected && current.length > 0
        && s.cursor !== current.start) {
      s.cursor = current.start;
      return;
    }
    const before = [...fields].reverse()
      .find((f) => f.attrAddr < (current?.attrAddr ?? s.size));
    s.cursor = (before ?? fields[fields.length - 1]!).start;
  }

  /** First unprotected cell at or after the start of the next line. */
  newline(): void {
    const s = this.screen;
    const nextLine = (Math.floor(s.cursor / s.cols) + 1) % s.rows * s.cols;
    let a = nextLine;
    for (let n = 0; n < s.size; n++) {
      if (!s.isFieldAttribute(a)) {
        const f = s.fieldAt(a);
        if (f === null || !f.protected) { s.cursor = a; return; }
      }
      a = s.inc(a);
    }
    s.cursor = nextLine;
  }

  moveCursor(addr: number): void {
    this.screen.cursor = ((addr % this.screen.size) + this.screen.size) % this.screen.size;
  }

  // ---- erasing ----

  /** Null from the cursor to the end of the field. */
  eraseEOF(): void {
    const s = this.screen;
    const f = s.fieldAt(s.cursor);
    if (f === null) return;
    if (f.protected) {
      this.oia.inhibit(KeyboardState.ProtectedField);
      return;
    }
    let a = s.cursor;
    while (!s.isFieldAttribute(a)) {
      s.setChar(a, 0x00);
      a = s.inc(a);
      if (a === s.cursor) break; // wrapped the whole buffer
    }
    s.setMDT(f.attrAddr);
  }

  /**
   * Clear every unprotected field, reset their MDT, home the cursor.
   *
   * eraseAllUnprotected already resets MDT on the unprotected fields it clears
   * (manual 3-8), which is the Erase Input rule — unlike WCC reset-MDT, which is
   * unconditional. Do not reach for clearAllMDT here.
   */
  eraseInput(): void {
    this.screen.eraseAllUnprotected();
    this.home();
  }

  backspace(): void {
    const s = this.screen;
    const f = s.fieldAt(s.cursor);
    if (f !== null && f.protected) {
      this.oia.inhibit(KeyboardState.ProtectedField);
      return;
    }
    const prev = s.dec(s.cursor);
    if (s.isFieldAttribute(prev)) return; // at the start of the field
    s.cursor = prev;
    s.setChar(prev, 0x00);
    if (f !== null) s.setMDT(f.attrAddr);
  }

  /** Delete under the cursor, shifting the remainder of the field left. */
  deleteChar(): void {
    const s = this.screen;
    const f = s.fieldAt(s.cursor);
    if (f === null) return;
    if (f.protected) {
      this.oia.inhibit(KeyboardState.ProtectedField);
      return;
    }
    let a = s.cursor;
    while (true) {
      const next = s.inc(a);
      if (s.isFieldAttribute(next) || next === f.attrAddr) {
        s.setChar(a, 0x00);
        break;
      }
      s.setChar(a, s.cellAt(next).ebcdic);
      a = next;
    }
    s.setMDT(f.attrAddr);
  }

  reset(): void {
    this.oia.reset();
  }

  setInsertMode(on: boolean): void {
    this.insertMode = on;
    this.oia.insertMode = on;
  }
}
