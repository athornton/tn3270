import { describe, it, expect } from 'vitest';
import { pasteString } from '../src/paste.js';
import { Screen, Keyboard, Oia, KeyboardState, resolve } from '@tn3270/core';

/**
 * A 24x80 screen with one big unprotected field, which is what a command prompt looks like.
 * `pasteString` takes the keyboard injected, so no Session and no Electron is involved.
 */
function keyboardAt(cursor = 0): { k: Keyboard; s: Screen } {
  const s = new Screen({ rows: 24, cols: 80 });
  s.setFieldAttribute(0, 0x00);
  s.cursor = cursor === 0 ? 1 : cursor;
  const k = new Keyboard(s, new Oia());
  return { k, s };
}

/**
 * One row of the screen as text, for asserting what landed.
 *
 * VIA `resolve()`, WHICH IS THE ESTABLISHED PATTERN IN THIS REPO
 * (`tui/test/transferRun.test.ts:93-95` does exactly this). The first draft of the plan behind this
 * file decoded `snapshot().cells[].ebcdic` by hand with `String.fromCharCode`, which returns EBCDIC
 * CODE POINTS -- so every assertion against an ASCII literal would have failed while looking like a
 * paste bug. `ResolvedCell.text` is already the character, and it is also what `extractText` reads.
 */
function rowText(s: Screen, row: number): string {
  const snap = s.snapshot();
  const cells = resolve(snap, {});
  return cells.slice(row * snap.cols, (row + 1) * snap.cols).map((c) => c.text).join('');
}

describe('pasteString: printable text', () => {
  it('types the characters and reports them all consumed', () => {
    const { k, s } = keyboardAt();
    const r = pasteString(k, s, 'HELLO');
    expect(r.typed).toBe(5);
    expect(r.dropped).toBe(0);
    expect(r.reason).toBeUndefined();
  });

  it('puts the characters where the cursor was', () => {
    // The counter above would be satisfied by a paste that typed into the wrong place, so the
    // SCREEN is asserted too -- compare the buffer, not the tally.
    const { k, s } = keyboardAt();
    pasteString(k, s, 'HELLO');
    expect(rowText(s, 0).slice(1, 6)).toBe('HELLO');
  });
});

describe('pasteString: the control characters, from kybd.c', () => {
  it('\\f TYPES A SPACE, where outside pasting it would be CLEAR', () => {
    /**
     * THE RULE THAT WOULD HAVE BITTEN. Outside pasting `\f` is Clear -- an AID that WIPES THE
     * SCREEN (`kybd.c:3920`). A form feed in pasted text sending Clear mid-paste would destroy
     * the panel being filled. Pasting changes its meaning (`:3918`), and that asymmetry is
     * explicit in the source.
     */
    const { k, s } = keyboardAt();
    pasteString(k, s, 'A\fB');
    expect(rowText(s, 0).slice(1, 4)).toBe('A B');
  });

  it('\\b moves the cursor LEFT', () => {
    const { k, s } = keyboardAt();
    const before = s.cursor;
    pasteString(k, s, 'AB\b');
    expect(s.cursor).toBe(before + 1);
  });

  it('\\r is DROPPED, so CRLF text does not gain a stray character per line', () => {
    // `kybd.c:3963-3967` runs Newline for `\r` only when NOT pasting. The `\n` that follows
    // carries the meaning, so typing anything here would corrupt every line of Windows-style text.
    const { k, s } = keyboardAt();
    const r = pasteString(k, s, 'AB\r');
    expect(r.typed).toBe(2);
    expect(rowText(s, 0).slice(1, 4)).toBe('AB ');
  });

  it('NEVER synthesizes Enter: \\n is Newline, not an AID', () => {
    /**
     * The reference makes exactly this distinction -- `\n` becomes `Enter_action` ONLY WHEN NOT
     * PASTING (`kybd.c:3957`). Conflating them would submit a half-filled panel to a live host.
     * Asserted as an ABSENCE through a spy, because "no AID was sent" is the property.
     */
    const { k, s } = keyboardAt();
    const aids: number[] = [];
    pasteString(k, s, 'A\nB', { onAid: (a) => aids.push(a) });
    expect(aids).toEqual([]);
  });
});

describe('pasteString: just_wrapped, the detail that makes multi-line paste land right', () => {
  it('SUPPRESSES a newline when filling a field already wrapped the cursor to the next ROW', () => {
    /**
     * THE TEST THAT NEEDS A FIELD THAT FILLS TO THE END OF A ROW -- and the fixture here is NOT
     * the one the plan specified, because that one cannot see this property at all.
     *
     * THE PLAN'S FIXTURE WAS TWO 5-CELL FIELDS ON ROW 0, pasting `'ABCDE\nXY'`. Traced against
     * real core: typing 5 characters auto-skips the cursor from 1 to 7, which is STILL ROW 0. The
     * reference keys `just_wrapped` on `BA_TO_ROW(cursor_addr)` (`kybd.c:3898-3906`) -- the ROW,
     * not the field -- so no row changed, nothing is suppressed, and the test would have been
     * asserting the behavior of the ordinary un-suppressed path while claiming to pin the
     * suppression. It would have passed with `justWrapped` deleted entirely.
     *
     * SO: ONE field spanning rows 0 and 1 (attribute at 0, next at 160), filled to the end of row
     * 0. Traced: after 79 characters the cursor is at 80, i.e. ROW 1 -- the wrap has already done
     * a newline's job. A newline from there would move it to 161, ROW 2, which is the
     * ONE-FIELD-LATE defect this suppression exists to prevent and what presents as a core
     * keyboard fault rather than a paste bug.
     */
    const s = new Screen({ rows: 24, cols: 80 });
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(160, 0x00);
    s.cursor = 1;
    const k = new Keyboard(s, new Oia());

    pasteString(k, s, `${'A'.repeat(79)}\nXY`);
    // XY lands at the START OF ROW 1, where the wrap already put the cursor. If the newline were
    // not suppressed it would be on ROW 2 instead, and row 1 would be blank.
    expect(rowText(s, 1).slice(0, 2)).toBe('XY');
    expect(rowText(s, 2).slice(0, 2)).not.toBe('XY');
  });
});

describe('pasteString: the two abort conditions', () => {
  it('DROPS THE REMAINDER when the keyboard is locked, and says how much', () => {
    // The reference calls this fatal: a string cannot unlock a keyboard (`kybd.c:3874-3880`).
    // Reported rather than silent, because a half-applied paste the operator cannot see is worse
    // than a refusal they can.
    const { k, s } = keyboardAt();
    // VERIFIED SIGNATURES: `Keyboard` exposes `readonly oia: Oia` (`core/src/keyboard.ts:19`), and
    // `Oia.inhibit` TAKES A `KeyboardState` (`core/src/oia.ts:85`) -- a bare `inhibit()` does not
    // compile. `SystemWait` is the state a host-busy screen is in.
    k.oia.inhibit(KeyboardState.SystemWait);
    const r = pasteString(k, s, 'HELLO');
    expect(r.typed).toBe(0);
    expect(r.dropped).toBe(5);
    expect(r.reason).toBe('keyboard locked');
  });

  it('reports a SHORT paste when a field refuses mid-string', () => {
    // A numeric field refusing a letter, or a field filling up, stops the paste. What got in is
    // reported -- compare bytes, not the status line, is this project's standing rule.
    const s = new Screen({ rows: 24, cols: 80 });
    s.setFieldAttribute(0, 0x20);         // PROTECTED: nothing can be typed
    s.cursor = 1;
    const k = new Keyboard(s, new Oia());
    const r = pasteString(k, s, 'HELLO');
    expect(r.typed).toBeLessThan(5);
    expect(r.dropped).toBeGreaterThan(0);
  });
});
