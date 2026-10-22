import { describe, it, expect } from 'vitest';
import {
  KEYBOARD_3279, KEYBOARD_REGIONS, SHIFT_NAME, type KeyCap,
} from '../src/keyboard3279.js';

describe('KEYBOARD_3279', () => {
  it('has a cap for every key on a 122-key unit, give or take the blanks', () => {
    // NOT asserted as exactly 122: the photographed unit has blank caps and this table draws them,
    // so the count is a property of the LAYOUT rather than a target to hit. A range catches "half
    // the table is missing" without pretending to a precision the photograph cannot support.
    expect(KEYBOARD_3279.length).toBeGreaterThanOrEqual(110);
    expect(KEYBOARD_3279.length).toBeLessThanOrEqual(130);
  });

  it('puts every cap in a declared region', () => {
    for (const cap of KEYBOARD_3279) {
      expect(KEYBOARD_REGIONS, `${cap.name} region`).toContain(cap.region);
    }
  });

  it('gives the PF region 24 keys, PF13-24 ABOVE PF1-12', () => {
    // The order matches KEYPAD_KEYS and c3270's keypad.labels. Pinning the first label of each row
    // rather than only the count is what catches a silent reversal.
    const pf = KEYBOARD_3279.filter((k) => k.region === 'pf');
    expect(pf).toHaveLength(24);
    expect(pf.filter((k) => k.row === 0)[0]?.label).toBe('PF13');
    expect(pf.filter((k) => k.row === 1)[0]?.label).toBe('PF1');
  });

  it('NEVER carries toggleKeypad, toggleKeyboard or quit', () => {
    // applyAction throws on all three, so a drawn button for any would be a button whose only
    // effect is to throw -- and toggleKeyboard's would toggle the surface it is drawn on.
    for (const cap of KEYBOARD_3279) {
      const kind = cap.action?.kind;
      if (kind === undefined) continue;
      expect(['toggleKeypad', 'toggleKeyboard', 'quit'], cap.name).not.toContain(kind);
    }
  });

  it('NO TWO CAPS OVERLAP within a region row, which is arithmetic a photograph cannot check',
    () => {
      const rows = new Map<string, Array<{ from: number; to: number; name: string }>>();
      for (const cap of KEYBOARD_3279) {
        const where = `${cap.region}:${cap.row}`;
        const list = rows.get(where) ?? [];
        list.push({ from: cap.x, to: cap.x + cap.width, name: cap.name });
        rows.set(where, list);
      }
      for (const [where, list] of rows) {
        list.sort((a, b) => a.from - b.from);
        for (let i = 1; i < list.length; i++) {
          expect(
            list[i]!.from,
            `${where}: ${list[i - 1]!.name} (to ${list[i - 1]!.to}) overlaps `
            + `${list[i]!.name} (from ${list[i]!.from})`,
          ).toBeGreaterThanOrEqual(list[i - 1]!.to);
        }
      }
    });

  it('gives every cap a positive width and a non-negative offset', () => {
    for (const cap of KEYBOARD_3279) {
      expect(cap.width, `${cap.name} width`).toBeGreaterThan(0);
      expect(cap.x, `${cap.name} x`).toBeGreaterThanOrEqual(0);
    }
  });

  it('names every cap, including the blank and inert ones', () => {
    // The name is the tooltip AND the accessible name, so a blank cap still needs one -- a screen
    // reader announcing an unnamed button is the failure this prevents.
    for (const cap of KEYBOARD_3279) {
      expect(cap.name.length, `${JSON.stringify(cap.label)} has no name`).toBeGreaterThan(0);
    }
  });

  it('keeps every region within a sane width, so no row can silently run off the surface', () => {
    // The real unit is about 24 key units across at its widest (the main block). A row that
    // exceeded that by much would mean a transcription slip rather than a design choice.
    for (const cap of KEYBOARD_3279) {
      expect(cap.x + cap.width, `${cap.name} ends past 24 units`).toBeLessThanOrEqual(24);
    }
  });

  describe('the character caps', () => {
    it('sends the UNSHIFTED text, with the shifted legend carried separately', () => {
      const two = KEYBOARD_3279.find((k) => k.label === '2');
      expect(two?.action).toEqual({ kind: 'type', text: '2' });
      expect(two?.shiftLabel).toBe('@');
    });

    it('gives a LETTER no shiftLabel, so Shift cannot be a no-op that eats its own arm', () => {
      for (const label of ['Q', 'A', 'Z', 'M']) {
        const cap = KEYBOARD_3279.find((k) => k.label === label);
        expect(cap?.shiftLabel, `${label} must have no shiftLabel`).toBeUndefined();
      }
    });

    it('only ever puts a shiftLabel on a typed character', () => {
      for (const cap of KEYBOARD_3279.filter((k) => k.shiftLabel !== undefined)) {
        expect(cap.action?.kind, `${cap.name} has a shiftLabel but is not a typed character`)
          .toBe('type');
      }
    });

    it('carries the 3270 TYPEWRITER number row, not a PC one', () => {
      // THE NOT SIGN ON 6 IS THE PROOF. A PC keyboard has `^` there, and `!` on 1 where this has
      // `|`. Pinned because inferring these legends from a PC keyboard is the single easiest way
      // to get this table subtly wrong.
      const shiftOf = (label: string): string | undefined =>
        KEYBOARD_3279.find((k) => k.label === label)?.shiftLabel;
      expect(shiftOf('6')).toBe('¬');   // NOT SIGN, not circumflex
      expect(shiftOf('1')).toBe('|');        // not '!'
      expect(shiftOf('7')).toBe('&');
      expect(shiftOf('8')).toBe('*');
    });
  });

  describe('the keys that cannot work', () => {
    it('draws Cursor Select INERT, deferred rather than forgotten', () => {
      // AID.SELECT exists in core, but keypad.ts records the key as dropped by decision: it needs
      // the field-intensity parse and belongs with the light-pen work.
      const sel = KEYBOARD_3279.find((k) => k.name.toLowerCase().startsWith('cursor select'));
      expect(sel, 'Cursor Select must be DRAWN, not omitted').toBeDefined();
      expect(sel?.action).toBeUndefined();
    });

    it('draws the PC-only keys INERT rather than omitting them', () => {
      for (const label of ['Esc', 'Print Screen', 'Scroll Lock', 'Pause', 'Alt']) {
        const cap = KEYBOARD_3279.find((k) => k.label === label);
        expect(cap, `${label} must be drawn`).toBeDefined();
        expect(cap?.action, `${label} must be inert`).toBeUndefined();
      }
    });

    it('names every inert cap with a REASON, so a tooltip can explain the grey', () => {
      // An inert cap the operator cannot interrogate is just a broken button. Every one says
      // either why it will never work, or that its legend could not be read.
      const inert = KEYBOARD_3279.filter(
        (k) => k.action === undefined && !k.name.startsWith(SHIFT_NAME) && k.name !== 'blank',
      );
      expect(inert.length, 'there should be several inert caps').toBeGreaterThan(3);
      for (const cap of inert) {
        expect(
          /not a 3270 key|not implemented|unread/.test(cap.name),
          `${JSON.stringify(cap.name)} does not say WHY it is inert`,
        ).toBe(true);
      }
    });
  });

  describe('the additions and the one-shot Shift', () => {
    it('carries Xfer on one of the two blank special caps', () => {
      // The user's suggestion, and KEYPAD_KEYS already carries Xfer as a deliberate non-3270 key.
      const xfer = KEYBOARD_3279.filter((k) => k.action?.kind === 'transferForm');
      expect(xfer).toHaveLength(1);
      expect(xfer[0]?.region).toBe('special-left');
    });

    it('has TWO Shift caps, both named so one state drives both, and NEITHER with an action', () => {
      // Shift is pure surface state: arming it sends nothing anywhere, which is why it has no
      // Action and why the union needs no `shift` member. `keyboardUi.ts` matches on the name.
      const shifts = KEYBOARD_3279.filter((k) => k.name.startsWith(SHIFT_NAME));
      expect(shifts).toHaveLength(2);
      for (const cap of shifts) {
        expect(cap.action, 'Shift must raise no action').toBeUndefined();
        expect(cap.label).toBe('Shift');
      }
    });

    it('binds Return to NEWLINE and keeps Enter separate, which is the 3270 distinction', () => {
      // Enter is the AID that submits the screen; Newline moves to the next input field. keymap.ts
      // records that no TUI chord could express Newline because Ctrl-J IS 0x0a -- a cap has no
      // such spelling problem, which is half the reason this surface is worth having.
      const newline = KEYBOARD_3279.filter((k) => k.action?.kind === 'newline');
      expect(newline).toHaveLength(1);
      const enter = KEYBOARD_3279.filter((k) => k.action?.kind === 'enter');
      expect(enter.length, 'Enter is on the main block AND the numeric pad').toBe(2);
    });
  });

  describe('the caps whose SIZE or NAME a human noticed and the arithmetic did not', () => {
    it('makes the spacebar WIDE, which no overlap test can catch', () => {
      /*
        THE OVERLAP TEST IS BLIND TO A CAP THAT IS TOO SMALL -- a 1-unit spacebar overlaps nothing
        and passes every assertion above. This was a REAL defect in the first draft of the table,
        found by rendering it as ASCII art and looking at it. The lesson is recorded here because
        the next transcription slip will be the same shape.
      */
      const space = KEYBOARD_3279.find((k) => k.name === 'Space');
      expect(space, 'the spacebar must exist and be findable by NAME').toBeDefined();
      expect(space?.width, 'a one-unit spacebar is not a spacebar').toBeGreaterThanOrEqual(5);
      expect(space?.action).toEqual({ kind: 'type', text: ' ' });
    });

    it('NEVER names a cap with whitespace alone', () => {
      // A cap named `" "` is invisible to a screen reader and unfindable by a harness, which is
      // exactly what the spacebar was before it was fixed.
      for (const cap of KEYBOARD_3279) {
        expect(cap.name.trim().length, `${JSON.stringify(cap.label)} has a whitespace-only name`)
          .toBeGreaterThan(0);
      }
    });

    it('gives the wide caps widths that match the hardware', () => {
      // Enter, Tab and Newline are visibly wider than one cap in the photograph. Pinned loosely
      // -- the point is that they are NOT one unit, not an exact figure from a tape measure.
      const wide = ['Enter', 'Tab', 'Newline', 'Backspace'];
      for (const name of wide) {
        const cap = KEYBOARD_3279.find((k) => k.name === name);
        expect(cap, `${name} must exist`).toBeDefined();
        expect(cap!.width, `${name} should be wider than a standard cap`).toBeGreaterThan(1);
      }
    });

    it('DISAMBIGUATES the caps that appear twice, so a harness can address either', () => {
      // `Enter` is on the main block AND the numeric pad; `0` and `.` likewise. Two buttons with
      // one name is a harness that cannot say which it clicked.
      const names = KEYBOARD_3279.map((k) => k.name).filter((n) => n !== 'blank');
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      expect([...new Set(dupes)], 'only the two Shift caps may share a name prefix').toEqual([]);
    });
  });

  describe('the transcription audit, so doubt survives in the test suite', () => {
    it('keeps the FIVE unreadable caps inert and named, rather than guessed at', () => {
      // These are the ones the reference photograph could not resolve at all. They stay inert
      // until a better source turns up; GUESSING a legend on historical hardware is the failure
      // this file's header exists to prevent.
      const unread = KEYBOARD_3279.filter((k) => /unread/.test(k.name));
      expect(unread, 'five caps were unreadable in the reference photograph').toHaveLength(5);
      for (const cap of unread) {
        expect(cap.action, `${cap.name} must stay inert`).toBeUndefined();
      }
    });

    it('DOES NOT INVENT a legend for the blank 0 cap -- it is inferred, and says so', () => {
      /*
        THE USER FOUND THIS, 2026-10-22: "the keyboard picture is clearly missing the 0/) so maybe
        some of the other keys are also supposed to have caps that have been lost."

        Confirmed under maximum zoom: that cap carries NO legend while `_`/`-` beside it is
        legible, so it is missing or worn smooth. `)` was inferred from the `9`/`(` pattern.

        This test does not assert the inference is RIGHT -- nothing here can. It asserts the cap is
        still present and still paired, so a future correction has somewhere to land and cannot
        quietly delete the key instead.
      */
      const zero = KEYBOARD_3279.find((k) => k.label === '0' && k.region === 'main');
      expect(zero, 'the 0 key must exist even though its cap is blank').toBeDefined();
      expect(zero?.shiftLabel).toBe(')');
    });

    it('NEVER repeats a shifted glyph, which is the smell that found four suspect pairs', () => {
      /*
        A GLYPH PAIR APPEARING TWICE ON ONE KEYBOARD IS ALMOST ALWAYS A TRANSCRIPTION ERROR, and
        that reasoning is what flagged `(`/`)` on the home row (duplicating `9`/`0`) and `,`/`;`
        plus `.`/`:` on the bottom row (duplicating the home row's `;`/`:`).

        THIS TEST IS CURRENTLY EXPECTED TO FAIL-BY-DESIGN IF THE SUSPECTS ARE LEFT AS THEY ARE, so
        it is written as a KNOWN-BAD LIST rather than a blanket rule: the duplicates that exist are
        named, and any NEW duplicate fails. When a better source arrives, correct the data and
        shrink this list -- do not widen it.
      */
      const KNOWN_SUSPECT = [')', ';', ':'];
      const shifted = KEYBOARD_3279
        .map((k) => k.shiftLabel)
        .filter((v): v is string => v !== undefined);
      const dupes = [...new Set(shifted.filter((v, i) => shifted.indexOf(v) !== i))];
      for (const d of dupes) {
        expect(
          KNOWN_SUSPECT,
          `${JSON.stringify(d)} is a NEW duplicated shifted glyph -- almost certainly a `
          + 'transcription error; see the header audit',
        ).toContain(d);
      }
    });
  });

  it('is frozen, so no consumer can reorder the hardware', () => {
    expect(Object.isFrozen(KEYBOARD_3279)).toBe(true);
    expect(() => (KEYBOARD_3279 as KeyCap[]).push(
      { label: 'X', region: 'main', row: 0, x: 0, width: 1, name: 'X' },
    )).toThrow();
  });
});
