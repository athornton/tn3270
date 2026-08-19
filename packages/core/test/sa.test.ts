import { describe, expect, it } from 'vitest';
import { Screen } from '../src/screen.js';
import { parseRecord } from '../src/stream/parse.js';
import { execute } from '../src/stream/execute.js';
import { XA, XAH } from '../src/constants.js';
import { Colour } from '../src/palette.js';

/** Build and run a write record, returning the screen it produced. */
function run(bytes: number[], screen = new Screen()): Screen {
  execute(screen, parseRecord(Uint8Array.from(bytes)));
  return screen;
}

// Write, WCC 0, then whatever the caller wants. 0xf1 is Write; 0x40 is a WCC
// with no bits that matter here.
const W = [0xf1, 0x40];
/** SBA to address 0: 0x11 then the 12-bit encoding of 0. */
const SBA0 = [0x11, 0x40, 0x40];

describe('SA sets character attributes on subsequent characters', () => {
  it('applies to characters written after it, and not before', () => {
    const s = run([
      ...W, ...SBA0,
      0xc1,                                    // 'A' before any SA
      0x28, XA.FOREGROUND, Colour.RED,         // SA fg=red
      0xc2,                                    // 'B' after
    ]);
    expect(s.cellAt(0).fg).toBeUndefined();
    expect(s.cellAt(1).fg).toBe(Colour.RED);
  });

  it('persists across many characters until changed', () => {
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1, 0xc2, 0xc3,
      0x28, XA.FOREGROUND, Colour.BLUE,
      0xc4,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(1).fg).toBe(Colour.RED);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
    expect(s.cellAt(3).fg).toBe(Colour.BLUE);
  });

  it('is a COMPOSITE by type: setting colour leaves highlighting alone', () => {
    // pages.txt:2995-2996. Modelling SA state as a single value instead of a
    // per-type map silently drops attributes, and this is the test that catches it.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.HIGHLIGHTING, XAH.REVERSE,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1,
    ]);
    expect(s.cellAt(0).gr).toBe(XAH.REVERSE);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
  });

  it('handles background as well as foreground', () => {
    const s = run([
      ...W, ...SBA0,
      0x28, XA.BACKGROUND, Colour.BLUE,
      0xc1,
    ]);
    expect(s.cellAt(0).bg).toBe(Colour.BLUE);
  });

  it('SA type 0x00 resets ALL character attributes to default', () => {
    // The twelve occurrences in the TK5 fixture are this case.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0x28, XA.HIGHLIGHTING, XAH.BLINK,
      0xc1,
      0x28, XA.RESET, 0x00,
      0xc2,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(0).gr).toBe(XAH.BLINK);
    expect(s.cellAt(1).fg).toBeUndefined();
    expect(s.cellAt(1).gr).toBeUndefined();
  });

  it('SA type 0x00 resets background too, not just foreground and highlighting', () => {
    // Pins all three, because "reset every type" with one type forgotten is the
    // shape of bug that leaves a stale background nobody notices on a dark
    // screen. x3270 zeroes fg, bg AND gr for XA_ALL (ctlr.c:1916-1920).
    const s = run([
      ...W, ...SBA0,
      0x28, XA.BACKGROUND, Colour.BLUE,
      0x28, XA.RESET, 0x00,
      0xc1,
    ]);
    expect(s.cellAt(0).bg).toBeUndefined();
  });

  it('a colour VALUE of 0x00 is stored, unlike a reset TYPE of 0x00', () => {
    // XAC_DEFAULT means "device default colour" and is a legitimate value the
    // host can set; SA type 0x00 means "reset everything". Both are 0x00 and
    // they are NOT the same operation.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.HIGHLIGHTING, XAH.BLINK,
      0x28, XA.FOREGROUND, 0x00,   // fg := device default, highlighting UNTOUCHED
      0xc1,
    ]);
    expect(s.cellAt(0).gr).toBe(XAH.BLINK);
  });

  it('RESETS at the start of every write command', () => {
    // "Another write type command is sent" (pages.txt:2978). x3270 zeroes
    // default_fg/bg/gr at the top of write processing, ctlr.c:1414-1416.
    const s = new Screen();
    run([...W, ...SBA0, 0x28, XA.FOREGROUND, Colour.RED, 0xc1], s);
    run([...W, 0x11, 0x40, 0x41, 0xc2], s);   // second Write, SBA to 1
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(1).fg).toBeUndefined();
  });

  it('a rewritten character loses the attributes of the character it replaced', () => {
    // NOT covered by the reset-per-command test above, which writes the second
    // record to a DIFFERENT address and so never exercises overwriting.
    //
    // "Character attributes are associated with a character and not with the
    // character's position in the buffer. Thus, whenever a character is
    // overwritten by a new character (or cleared or erased), the old character
    // attribute is overwritten by the character attribute of the new character"
    // (p. 4-16, pages.txt:3388-3390). x3270 gets this because it stamps
    // default_fg unconditionally (ctlr.c:2141) and ctlr_add_fg assigns rather
    // than merges, normalising any non-0xFx value to 0 (ctlr.c:2852-2861).
    //
    // Screen.setExtended MERGES, so the executor must clear before stamping. An
    // applySa that returns early when the SA state is empty leaves the red here.
    const s = new Screen();
    run([...W, ...SBA0, 0x28, XA.FOREGROUND, Colour.RED, 0xc1], s);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    run([...W, ...SBA0, 0xc2], s);   // same address, no SA in effect
    expect(s.cellAt(0).fg).toBeUndefined();
  });

  it('an overwrite drops a stale attribute of a type the new SA does not mention', () => {
    // The per-type version of the rule above: highlighting set in one record
    // must not survive a record that sets only colour at the same address.
    const s = new Screen();
    run([...W, ...SBA0, 0x28, XA.HIGHLIGHTING, XAH.BLINK, 0xc1], s);
    expect(s.cellAt(0).gr).toBe(XAH.BLINK);
    run([...W, ...SBA0, 0x28, XA.FOREGROUND, Colour.RED, 0xc2], s);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(0).gr).toBeUndefined();
  });

  it('applies SA state to RA-filled characters too', () => {
    // RA writes characters; they are "subsequently interpreted characters" and
    // must carry the running attributes like any other.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.PINK,
      0x3c, 0x40, 0x43, 0xc1,     // RA to address 3, fill 'A'
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.PINK);
    expect(s.cellAt(2).fg).toBe(Colour.PINK);
  });

  it('applies SA state to a graphic-escaped character', () => {
    // x3270 stamps default_fg/bg/gr on a GE character exactly as on ordinary
    // text (ctlr.c:1739-1741).
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.TURQUOISE,
      0x08, 0xc1,                 // GE 'A'
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.TURQUOISE);
  });

  it('still counts genuinely unimplemented SA types as ignored', () => {
    // CHARSET is out of scope (PS). setAttributeIgnored must keep counting it,
    // or a zero there stops meaning "we never saw one".
    const r = execute(new Screen(), parseRecord(Uint8Array.from([
      ...W, ...SBA0, 0x28, XA.CHARSET, 0xf1, 0xc1,
    ])));
    expect(r.setAttributeIgnored).toBe(1);
  });

  it('counts an SA type it does not recognise at all', () => {
    // Table 4-6 has rows we deliberately do not name (VALIDATION 0xC1,
    // OUTLINING 0xC2, TRANSPARENCY 0x46). They must fall to the counted default
    // arm, not be silently swallowed.
    const r = execute(new Screen(), parseRecord(Uint8Array.from([
      ...W, ...SBA0, 0x28, 0xc2, 0xf0, 0xc1,
    ])));
    expect(r.setAttributeIgnored).toBe(1);
  });

  it('does NOT count the SA types it now implements', () => {
    const r = execute(new Screen(), parseRecord(Uint8Array.from([
      ...W, ...SBA0, 0x28, XA.FOREGROUND, Colour.RED, 0xc1,
    ])));
    expect(r.setAttributeIgnored).toBe(0);
  });

  it('counts none of the four implemented types, individually', () => {
    // One record per type, so a missing arm cannot hide behind another's zero.
    for (const type of [XA.RESET, XA.FOREGROUND, XA.BACKGROUND, XA.HIGHLIGHTING]) {
      const r = execute(new Screen(), parseRecord(Uint8Array.from([
        ...W, ...SBA0, 0x28, type, 0x00, 0xc1,
      ])));
      expect(r.setAttributeIgnored, `type 0x${type.toString(16)}`).toBe(0);
    }
  });
});

describe('SFE seeds field-level extended attributes', () => {
  it('applies a colour pair to the characters in the field', () => {
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,  // SFE: basic + fg
      0xc1, 0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(2).fg).toBe(Colour.YELLOW);
  });

  it('a plain SF after a coloured SFE does not inherit its colour', () => {
    // pages.txt:2869-2870, and Task 3's setFieldAttribute change.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x1d, 0xc0,        // plain SF
      0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(3).fg).toBeUndefined();
  });

  it('a plain SF also drops a highlighting the previous SFE established', () => {
    // The SF reset is by TYPE-set, not just colour: "it sets the associated
    // extended field attribute to its default value" (pages.txt:2869-2870), and
    // highlighting is one of those attributes.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.HIGHLIGHTING, XAH.REVERSE,
      0xc1,
      0x1d, 0xc0,
      0xc2,
    ]);
    expect(s.cellAt(1).gr).toBe(XAH.REVERSE);
    expect(s.cellAt(3).gr).toBeUndefined();
  });

  it('a later plain SFE does not inherit an earlier SFE colour', () => {
    // Same rule as SF, via the pair loop: an SFE that specifies no colour
    // leaves the running state at its default rather than the previous field's.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x29, 0x01, 0xc0, 0xc0,   // SFE with only the basic attribute
      0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(3).fg).toBeUndefined();
  });

  it('a character-level SA overrides the field-level SFE colour', () => {
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
  });

  it('an SFE RESET pair clears what an earlier pair in the same order set', () => {
    // p. 4-5: "If the same attribute type-value pair appears more than once, the
    // last specification for a repeated attribute type takes effect"
    // (pages.txt:2899-2901) -- so the pairs are applied in order, and a trailing
    // X'00' type wins over the colour before it.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x03, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW, XA.RESET, 0x00,
      0xc1,
    ]);
    expect(s.cellAt(1).fg).toBeUndefined();
  });
});

describe('orders that null characters also reset those characters attributes', () => {
  it('the EUA order clears the attributes of the cells it nulls', () => {
    // "Field attributes and extended field attributes are not affected by EUA.
    // Character attributes for every character changed to nulls are reset to
    // their defaults" (p. 4-11, pages.txt:3165-3166).
    //
    // This is NOT the same rule as stamping the SA state, which EUA must not do
    // -- EUA nulls rather than writes. Screen.setChar deliberately no longer
    // touches extended attributes, so nulling alone leaves stale colour behind.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1, 0xc2, 0xc3,
      0x11, 0x40, 0x40,           // SBA back to 0
      0x12, 0x40, 0x42,           // EUA, stop address 2
    ]);
    expect(s.cellAt(0).fg).toBeUndefined();
    expect(s.cellAt(1).fg).toBeUndefined();
    // Address 2 is at/after the stop address, so it is untouched -- the positive
    // control that proves the assertions above are not vacuous.
    expect(s.cellAt(2).fg).toBe(Colour.RED);
  });

  it('the PT order clears the attributes of the cells it nulls', () => {
    // "The PT order resets the character attribute to its default value for each
    // character set to nulls" (p. 4-9, pages.txt:3090-3091). x3270 zeroes fg, bg
    // and gr alongside the null (ctlr.c:1555-1560).
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1, 0xc2, 0xc3,
      0x05,                       // PT, and the data before it means it nulls
    ]);
    // Unformatted, so PT finds no unprotected field and nulls the whole buffer.
    expect(s.cellAt(0).ebcdic).toBe(0x00);
    expect(s.cellAt(0).fg).toBeUndefined();
    expect(s.cellAt(1).fg).toBeUndefined();
  });

  it('PT does not null, or clear, when it follows an order rather than data', () => {
    // The positive control for the test above: PT immediately after an order
    // "the buffer is not modified" (pages.txt:3089), so the attributes stand.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1,
      0x11, 0x40, 0x41,           // SBA to 1: an order, so wroteSinceOrder resets
      0x05,                       // PT
    ]);
    expect(s.cellAt(0).ebcdic).toBe(0xc1);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
  });
});
