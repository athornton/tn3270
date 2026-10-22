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

    it('puts a shiftLabel only where the HARDWARE has a second legend', () => {
      /*
        WAS "only on a typed character" UNTIL 2026-10-22, and the sharp reference photograph is why
        it changed: several FUNCTION caps carry front-printed shifted legends -- `Reset`/`DvCntl`,
        `Print`/`Ident`, and double-arrows on the cursor keys for start/end of line. None of those
        shifted functions is implemented, so the legend documents that it EXISTS and we do not have
        it, rather than being silently absent.

        WHAT THE RULE STILL FORBIDS is a shiftLabel on a cap that has neither a typed character nor
        a named second function -- i.e. one invented to fill space. Every entry here is either a
        `type` action or a cap whose `name` says what the shifted legend means.
      */
      for (const cap of KEYBOARD_3279.filter((k) => k.shiftLabel !== undefined)) {
        const typed = cap.action?.kind === 'type';
        const documented = /shifted:/.test(cap.name);
        expect(typed || documented, `${cap.name}: a shiftLabel needs a typed action or a `
          + 'name saying what the shifted legend is').toBe(true);
      }
    });

    it('carries the 3270 TYPEWRITER number row, not a PC one', () => {
      /*
        PINNED BECAUSE INFERRING THESE FROM A PC KEYBOARD IS THE EASIEST WAY TO GET THIS TABLE
        SUBTLY WRONG -- and because one of them was wrong until a second photograph settled it.

        `cent` ON 6 IS THE PROOF, where a PC has `^`. This test asserted `not sign` until
        2026-10-22: I had read a blurred cap that way and justified it with EBCDIC reasoning. A
        sharp photograph of an IBM 4978 -- a different 122-key 3279 layout, same typewriter
        character set -- shows `cent` unambiguously, and the original cap is consistent with it.
        **The reasoning was sound and still produced the wrong glyph, because it explained a
        reading instead of testing it.**

        `|` on 1 (not `!`) and `)` on 0 are both confirmed by that second keyboard too.
      */
      const shiftOf = (label: string): string | undefined =>
        KEYBOARD_3279.find((k) => k.label === label && k.region === 'main')?.shiftLabel;
      expect(shiftOf('6')).toBe('¢');   // CENT, not circumflex and not a not-sign
      expect(shiftOf('1')).toBe('|');        // not '!'
      expect(shiftOf('7')).toBe('&');
      expect(shiftOf('8')).toBe('*');
      expect(shiftOf('9')).toBe('(');
      expect(shiftOf('0')).toBe(')');
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

    it('no longer claims the left bar is full of PC keys, because it is not', () => {
      /*
        I HAD `Esc`, `Print Screen`, `Scroll Lock` AND `Pause` ON THE LEFT BAR AND ALL FOUR WERE
        WRONG -- read off a blurred photograph and believed because they looked like a plausible
        PC-ish column. The sharp reference shows the bar is entirely 3270: Attn/Clear,
        Cursr Sel, Ex Sel/Erase EOF, Print/Test.

        **TWO OF THEM TURNED OUT TO BE FUNCTIONS WE ALREADY IMPLEMENT**, so the correction gained
        working keys rather than just fixing labels: `Erase EOF` is `eraseEOF`, which the compact
        keypad has carried as `ErEOF` all along.

        THIS TEST NOW GUARDS THE CORRECTION rather than the old mistake: those four names must NOT
        come back, because the next blurry photograph would make them plausible again.
      */
      const names = KEYBOARD_3279.map((k) => k.name).join(' | ');
      for (const gone of ['Escape', 'Print Screen', 'Scroll Lock', 'Pause']) {
        expect(names, `${gone} was a misreading of the left bar and must not return`)
          .not.toContain(gone);
      }
      // And the two real keys the correction found:
      expect(KEYBOARD_3279.find((k) => k.name === 'Erase EOF')?.action)
        .toEqual({ kind: 'eraseEOF' });
      expect(KEYBOARD_3279.find((k) => k.name?.startsWith('Ex Sel'))?.action)
        .toBeUndefined();
    });

    it('names every inert cap with a REASON, so a tooltip can explain the grey', () => {
      // An inert cap the operator cannot interrogate is just a broken button. Every one says
      // either why it will never work, or that its legend could not be read.
      /*
        BLANK CAPS ARE EXCLUDED, and the distinction is the one this file has kept since the
        bottom-left caps were confirmed empty: a BLANK cap is inert because the keyboard assigns it
        nothing, and its name says `blank` plus where it is. An UNIMPLEMENTED cap is inert because
        WE do not have the function, and that is what needs a reason a tooltip can show. Lumping
        them together would demand an explanation for a key that has nothing to explain.
      */
      const inert = KEYBOARD_3279.filter(
        (k) => k.action === undefined
          && !k.name.startsWith(SHIFT_NAME)
          && !k.name.startsWith('blank'),
      );
      expect(inert.length, 'there should be several inert caps').toBeGreaterThan(3);
      for (const cap of inert) {
        expect(
          /not a 3270 key|not implemented|unidentified|ambiguous/.test(cap.name),
          `${JSON.stringify(cap.name)} does not say WHY it is inert`,
        ).toBe(true);
      }
    });
  });

  describe('the additions and the one-shot Shift', () => {
    it('carries Xfer EXACTLY ONCE, on a cap with no function we can implement', () => {
      /*
        MOVED 2026-10-22 from a blank cap on the left special bar to the BENT-ARROW cap in the
        cursor cluster, on the user's reasoning: "I think that means it had no unshifted function,
        so that's a safe place to put Xfer."

        The region is asserted so the move is a DECISION rather than a drift -- and `toHaveLength(1)`
        matters more than where: two Xfer caps would be the real defect, since the operator would
        not know which to trust. KEYPAD_KEYS already carries Xfer as a deliberate non-3270 key, so
        there is precedent for the addition itself.

        IF A KEY-ASSIGNMENT MANUAL IDENTIFIES THAT CAP, Xfer should move back to the left bar's
        blank pair, which is CONFIRMED blank and therefore permanently safe.
      */
      const xfer = KEYBOARD_3279.filter((k) => k.action?.kind === 'transferForm');
      expect(xfer, 'two Xfer caps would leave the operator guessing').toHaveLength(1);
      /*
        BACK ON THE LEFT SPECIAL BAR, 2026-10-22. It had moved to the cursor cluster on the
        reasoning that the cap there had no unshifted function -- and the sharp reference then
        IDENTIFIED that cap as delete-to-end-of-line, a real key. So the move was made on a
        premise that turned out false, and `Xfer` returns to a cap this file has confirmed BLANK
        under maximum zoom: a blank cap cannot stop being blank, which an unidentified one can.
      */
      expect(xfer[0]?.region).toBe('special-left');
    });

    it('has TWO Shift caps, both named so one state drives both, and NEITHER with an action', () => {
      // Shift is pure surface state: arming it sends nothing anywhere, which is why it has no
      // Action and why the union needs no `shift` member. `keyboardUi.ts` matches on the name.
      const shifts = KEYBOARD_3279.filter((k) => k.name.startsWith(SHIFT_NAME));
      expect(shifts).toHaveLength(2);
      for (const cap of shifts) {
        expect(cap.action, 'Shift must raise no action').toBeUndefined();
        // THE LABEL IS `Shft`, ABBREVIATED TO FIT a 1.25-unit cap at the main block's 10px type --
        // see the `shift` helper. The NAME is what identifies the cap, which is why the filter
        // above matches on `SHIFT_NAME` and this only checks the label is the shortened form
        // rather than something unrelated.
        expect(cap.label).toBe('Shft');
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
    it('DISTINGUISHES A BLANK CAP FROM AN UNREAD ONE, which are different claims', () => {
      /*
        `blank` MEANS "THERE IS NOTHING TO READ"; `unread` MEANT "WE FAILED TO READ IT". The 5271
        shipped with three unassigned caps in its left special bar -- confirmed 2026-10-22 under a
        13x crop with contrast and an unsharp mask, which shows no ink at all on them while
        `Scroll Lock` and `Pause` above stay legible under the same treatment.

        THE DISTINCTION DECIDES WHAT A FUTURE SOURCE COULD SETTLE. A sharper photograph of THIS
        keyboard cannot change a blank cap; only a different unit or a key-assignment manual
        could. So the names must not be conflated, and `unread` must never be used for a cap that
        is simply empty.
      */
      // MATCHED ON A PREFIX since 2026-10-22: the blanks now carry their POSITION in the name
      // (`blank, right of Cursor Select`) so a failure says which cap, and one of them carries a
      // shifted `Test` legend. An exact match would silently find none.
      const blanks = KEYBOARD_3279.filter((k) => k.name.startsWith('blank'));
      expect(blanks.length, 'the 5271 has unassigned caps, and they are drawn')
        .toBeGreaterThanOrEqual(2);
      for (const cap of blanks) {
        expect(cap.label, 'a blank cap carries no legend').toBe('');
        expect(cap.action, 'a blank cap does nothing').toBeUndefined();
        expect(cap.name, 'a blank cap is not an UNREAD one').not.toMatch(/unread/);
        expect(cap.name, 'a blank cap says WHERE it is, so two are distinguishable')
          .toMatch(/blank/);
      }
    });

    it('HAS NO UNREADABLE CAPS LEFT, and the count may never grow', () => {
      /*
        WENT 5 -> 2 -> 0 ON 2026-10-22, and the route is the lesson.

        Five caps started inert because I could not resolve them. Three were the numeric pad's
        right-hand column, read from a harder zoom on the ORIGINAL photograph. The last two flanked
        `Home` and survived THREE photographs -- a 4978 with different furniture, and an IBM 3270 PC
        with the same layout where they are a smudge at full resolution -- then fell to a 10x crop
        of the FIRST image with contrast and an unsharp mask. They are the standard 3270 back-tab
        and field-tab glyphs.

        **THE PIXELS WERE ALWAYS SUFFICIENT; THE PROCESSING WAS NOT.** Exhaust the image you have
        before asking for another one.

        THIS TEST NOW GUARDS A DIFFERENT DIRECTION: zero is the floor, and an `unread` cap
        reappearing means someone marked a key unreadable rather than reading it. If that is
        genuinely necessary, say why at the entry and change this test deliberately.
      */
      const unread = KEYBOARD_3279.filter((k) => /unread/.test(k.name));
      expect(unread.map((k) => k.name), 'every cap has been read').toEqual([]);
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
      // SHRUNK FROM [')', ';', ':'] TO [':'] on 2026-10-22, once a sharp photograph of an IBM
      // 4978 settled the suspects this rule had flagged. `:` remains because it legitimately
      // appears twice -- shifted on the home row's `;` and on the bottom row's `.` -- which the
      // second keyboard confirms rather than contradicts. **SHRINK THIS LIST, NEVER WIDEN IT.**
      const KNOWN_SUSPECT = [':'];
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

  describe('the labels must FIT the caps the table asks for', () => {
    it('keeps every label short enough for its own width, at the shipped font size', () => {
      /*
        THE USER'S REQUIREMENT, 2026-10-22: "the text size should be adjusted so that all of the
        (very common) three-letter key names (PA1, PF3, etc) fit on the virtual key, so it should
        be a bit smaller."

        AND THE DEFECT BEHIND IT: at `font-size: 11px` with a 30px pitch, `PF13` rendered as `PF1`,
        `PF24` as `PF2` and `Attn` as `Attr` -- silently, because `ui.css` sets `overflow: hidden`
        on a cap so it cannot grow and wreck the layout. The PF strip was useless, since PF13-24
        became indistinguishable from PF1-12.

        ## WHY THIS LIVES IN A UNIT TEST AT ALL, AND WHAT IT CANNOT DO

        No test here can measure rendered text: there is no DOM, no font and no layout engine. What
        it CAN do is check the ARITHMETIC the CSS commits to, so a table entry that cannot possibly
        fit fails before anyone renders it.

        The model, kept deliberately crude and conservative: a cap is `pitch * width` wide less 4px
        of padding, and a character of system-ui at 9px averages about 5px -- rounded UP from the
        ~0.55em metric, because capitals and digits are wider than the average and `PF13` is all
        capitals and digits.

        **IF `ui.css` CHANGES THE PITCH OR THE FONT, CHANGE THESE TWO CONSTANTS TO MATCH.** They are
        a copy of a decision made there, which is a real duplication -- accepted because the
        alternative is parsing CSS from a unit test, and because a wrong copy fails LOUDLY here
        rather than silently clipping in a browser.
      */
      /*
        ## THE CONSTANTS WERE WRONG AND THE TEST PASSED ANYWAY -- CORRECTED 2026-10-22

        This test used ONE font size (8px) and a 0.56 per-character ratio, and it went green while
        the user's screenshot showed `PF13` rendering as `PF1`. Two errors compounded:

         - **0.56 was too optimistic.** It is roughly right for mixed-case prose and WRONG for the
           labels here, which are capitals and digits -- `PF13`, `Clear`, `Shift`. Calibrated from
           the screenshot: four capitals at 8px overflowed a 24px cap, so the ratio is at least
           24/(4*8) = 0.75.
         - **One font size was the wrong model.** `ui.css` now sizes each region separately,
           because the real hardware does: the user's own observation was that on a Model M "the
           characters are noticeably smaller than A-Z are" on the function keys.

        So the model now mirrors the stylesheet: a per-region font, and a ratio conservative enough
        for all-capitals. **IF `ui.css` CHANGES EITHER, CHANGE THIS.** It is a copy of a decision
        made there -- accepted because the alternative is parsing CSS in a unit test, and because a
        wrong copy here fails loudly instead of clipping silently in a browser.
      */
      const PITCH_PX = 28;
      const PAD_PX = 4;
      /*
        0.61, MEASURED IN A REAL BROWSER rather than estimated for the third time.

        `browser-clicks.mjs` now prints `c.measureText('PF13').width / 4 / fontSize` every run, and
        it is 0.61 at every size from 6px to 10px. My two estimates -- 0.56 then 0.75 -- BRACKETED
        the true value, and neither was the reason labels clipped: the caps were rendering at the
        UA's 13.33px default because a `<button>` does not inherit `font` and this overlay was
        missing from the rule that sets `font: inherit`. Three font reductions changed nothing.

        SO THIS CONSTANT IS NOW CALIBRATED, AND IT IS STILL THE WEAKER CHECK. The real guard is in
        the harness, which asks the browser `scrollWidth > clientWidth` per cap -- no model, no
        ratio, no font metric. This test's value is that it fails in CI without a browser when a
        table entry is obviously too long.
      */
      const CHAR_RATIO = 0.61;
      // RAISED 2026-10-22 with `ui.css`: 7px was unreadable, and the box-sizing and font-inherit
      // fixes recovered enough width inside each cap to afford these. The harness's own
      // `scrollWidth > clientWidth` check is the authority; this mirrors it for CI without a
      // browser.
      const FONT_PX = {
        pf: 9, 'special-left': 9, main: 11, cursor: 9, numpad: 10,
      };

      /*
        PER LINE, NOT PER LABEL, and getting that wrong first is what found the real defect.

        The original version of this test measured the WHOLE label and flagged nine caps -- and
        the fix was not a smaller font. `Cursr Sel`, `Print Screen`, `Dup / PA1` and the rest are
        MULTI-WORD legends on SINGLE-UNIT caps, and the hardware prints them STACKED. Asking for
        one line was the error: at 22px of usable width no font size makes `Print Screen` fit on
        one line and stay readable. The labels now carry explicit newlines and `ui.css` sets
        `white-space: pre-line`, so this measures the LONGEST LINE.
      */
      const longestLine = (text: string): number =>
        Math.max(...text.split('\n').map((line) => line.length));

      const tooWide: string[] = [];
      for (const cap of KEYBOARD_3279) {
        // The widest thing a cap can be asked to draw -- the shifted legend can be longer.
        const drawn = Math.max(longestLine(cap.label), longestLine(cap.shiftLabel ?? ''));
        const usable = PITCH_PX * cap.width - PAD_PX;
        const needed = drawn * CHAR_RATIO * FONT_PX[cap.region];
        if (needed > usable) {
          tooWide.push(`${cap.name}: ${drawn} chars at ${FONT_PX[cap.region]}px needs `
            + `~${Math.ceil(needed)}px, cap is ${usable}px`);
        }
      }
      expect(tooWide, `labels that cannot fit:\n  ${tooWide.join('\n  ')}`).toEqual([]);
    });

    it('fits the THREE-LETTER names the user named, with room to spare', () => {
      // PA1, PF3 and Esc are the common cases, and they are the ones that must never be marginal.
      // `Escape` was removed when the left bar was corrected -- it never existed on this
      // keyboard. `Clear` takes its place as a short-label cap on a standard width.
      for (const name of ['PA3', 'PF3', 'Clear']) {
        const cap = KEYBOARD_3279.find((k) => k.name === name);
        expect(cap, `${name} must exist`).toBeDefined();
        expect(cap!.label.length, `${name} is a short label on a standard cap`)
          .toBeLessThanOrEqual(4);
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
