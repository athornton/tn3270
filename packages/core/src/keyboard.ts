import { cp037, type CodePage } from './codepage.js';
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
   * Move on after typing. At the end of a field, skip to the next typable one —
   * this is what makes "type into a panel" work.
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
