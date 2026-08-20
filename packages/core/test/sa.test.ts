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

  it('a colour VALUE of 0x00 does not reset the other types, unlike a TYPE of 0x00', () => {
    // XAC_DEFAULT means "device default colour" and is a legitimate value the
    // host can set; SA type 0x00 means "reset everything". Both are 0x00 and
    // they are NOT the same operation.
    //
    // NOTE the assertion is about what SURVIVES, not about storage: XAC_DEFAULT is
    // itself 0x00, which is Screen's "unspecified" sentinel, so cellAt(0).fg is
    // undefined here. That is deliberate, not a gap -- screen.ts:113-116 argues
    // XAC_DEFAULT should fall through to the base field attribute rather than be
    // stored as a colour, which is exactly what an unspecified fg does. What this
    // test pins is that setting it did not clear the BLINK beside it.
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
    // (p. 4-16, pages.txt:3388-3391). x3270 gets this because it stamps
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

  it('SURVIVES a plain SF, which is not one of the four reset triggers', () => {
    // SA state is CHARACTER-scoped and an SF is a FIELD-level event, so an SF must
    // not clear it. The manual's reset list is closed: "A new SA order changes it.
    // / Another write type command is sent. / The Clear key is pressed. / Power at
    // the display is switched off" (pages.txt:2977-2980), then "These FOUR actions
    // all return the established set ... to their default value" (:2981-2982). SF
    // is not among them, and SA applies to "subsequently interpreted characters in
    // the data stream" (:2969-2971) -- an SF does not stop them being subsequent.
    //
    // x3270's ORDER_SF zeroes the FA cell's colour (ctlr.c:1486-1487) and never
    // touches default_fg/bg/gr, whose only assignments are write-command reset
    // (:1414-1416) and the SA order (:1905, :1917).
    //
    // AN EARLIER VERSION CALLED resetSa HERE, misreading "sets the associated
    // extended field attribute to its default value" (:2869-2870) as covering
    // character state too. Nothing caught it, in either direction, which is why
    // this test exists.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1,               // char at 0, red
      0x1d, 0xc0,         // plain SF at 1
      0xc2,               // char at 2 -- still red, the SA is still in force
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
    // But the SF's own cell takes no colour: that IS the field-level rule.
    expect(s.cellAt(1).fg).toBeUndefined();
  });

  it('survives an SFE too, for the same reason', () => {
    // The mirror of the leak test below. An SFE changes the FIELD level and must
    // neither seed the running state nor clear it.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1,
      0x29, 0x01, 0xc0, 0xc0,   // plain SFE at 1
      0xc2,                     // char at 2 -- still red
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
    expect(s.cellAt(1).fg).toBeUndefined();
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

  it('what it counts and what it applies agree, type by type', () => {
    // THE COUNTER MUST NOT DISAGREE WITH THE BEHAVIOUR. Rather than restate the
    // list of implemented types -- which is the duplication this pins against --
    // this derives "did we apply it" from the screen and compares it to
    // setAttributeIgnored for every type in Table 4-6 plus a few reserved bytes.
    //
    // An arm added to the applying side but not the counting side, or vice versa,
    // fails here whatever the type is.
    const types = [
      XA.RESET, XA.HIGHLIGHTING, XA.FOREGROUND, XA.CHARSET, XA.BACKGROUND,
      0xc1, 0xc2, 0x46, 0x99, 0xff,   // VALIDATION, OUTLINING, TRANSPARENCY, junk
    ];
    for (const type of types) {
      // A first SA sets a known colour; the SA under test then either changes the
      // running state (applied) or does not (ignored). A non-zero, non-default
      // value so that "applied" is observable for every implemented type.
      const s = new Screen();
      const r = execute(s, parseRecord(Uint8Array.from([
        ...W, ...SBA0,
        0x28, XA.FOREGROUND, Colour.RED,
        0x28, type, Colour.BLUE,
        0xc1,
      ])));
      const cell = s.cellAt(0);
      // "Applied" means the second SA changed something about the cell: it either
      // reset the red, or set a colour/highlighting of its own.
      const applied = cell.fg !== Colour.RED || cell.bg !== undefined
        || cell.gr !== undefined;
      const counted = r.setAttributeIgnored > 0;
      expect(applied, `type 0x${type.toString(16)}: applied`).toBe(!counted);
    }
  });
});

describe('SFE stores extended attributes at the FIELD level, and only there', () => {
  // SFE'S ATTRIBUTES ARE FIELD-SCOPED, so the executor stores them in exactly one
  // place -- the field-attribute cell -- and does NOT stamp them onto the field's
  // characters. Characters reach them through the fallback: "If there are field
  // attributes in the character buffer and if a character attribute specifies
  // default for any character property (color, highlighting, or character set), the
  // character is displayed using the value of that property established for the
  // field in the extended field attribute" (p. 4-16, pages.txt:3383-3387).
  //
  // SO THESE TESTS ASSERT THE FA CELL, NOT THE CHARACTER CELLS. An earlier version
  // of this file asserted the characters, because SFE used to seed the running SA
  // state as well. That seeding was a real bug -- see the leak test at the bottom --
  // and removing it is what moved these assertions. RESOLVING a character to its
  // field's colour is Task 5's job in render.ts, via this stored fallback; storing
  // it correctly is this task's, and is all these tests can honestly check.

  it('puts a colour pair on the field-attribute cell, not on the characters', () => {
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,  // SFE: basic + fg
      0xc1, 0xc2,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
    // The characters carry no attribute of their own; they inherit at render time.
    expect(s.cellAt(1).fg).toBeUndefined();
    expect(s.cellAt(2).fg).toBeUndefined();
  });

  it('a plain SF after a coloured SFE does not inherit its colour', () => {
    // "If the display receives an SF order, it sets the associated extended field
    // attribute to its default value" (pages.txt:2869-2870), and Task 3's
    // setFieldAttribute change. Each field's own FA cell is checked, so this pins
    // that the second field starts clean rather than copying the first.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x1d, 0xc0,        // plain SF at 2
      0xc2,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(2).fg).toBeUndefined();
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
    expect(s.cellAt(0).gr).toBe(XAH.REVERSE);
    expect(s.cellAt(2).gr).toBeUndefined();
  });

  it('a later plain SFE does not inherit an earlier SFE colour', () => {
    // Same rule as SF: an SFE that specifies no colour leaves its own FA cell at
    // default rather than taking the previous field's.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x29, 0x01, 0xc0, 0xc0,   // SFE at 2 with only the basic attribute
      0xc2,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(2).fg).toBeUndefined();
  });

  it('a character-level SA sets a character attribute where SFE sets a field one', () => {
    // THE TWO LEVELS ARE STORED SEPARATELY, which is what lets the manual's
    // precedence rule work at all: "Otherwise, the character attribute overrides
    // the field attribute" (pages.txt:3386-3387).
    //
    // What the executor guarantees, and all this can check: the field's yellow is
    // on the FA cell; the character written before the SA has NO attribute of its
    // own (so it will inherit yellow); the character written after has red. That
    // the RENDERED result is yellow then red is Task 5's to prove via the fallback
    // -- this test deliberately stops at the storage boundary rather than
    // pretending to check a colour nothing here resolves.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc2,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);   // field level
    expect(s.cellAt(1).fg).toBeUndefined();       // inherits the field
    expect(s.cellAt(2).fg).toBe(Colour.RED);      // overrides the field
  });

  it('a repeated pair type resolves to the last one', () => {
    // "All attribute types and values are checked for validity. If the same
    // attribute type-value pair appears more than once, the last specification for
    // a repeated attribute type takes effect" (p. 4-5, pages.txt:2899-2901).
    const s = run([
      ...W, ...SBA0,
      0x29, 0x03, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW, XA.FOREGROUND, Colour.PINK,
      0xc1,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.PINK);
  });

  it('an X-00 pair type in an SFE is rejected, NOT treated as a reset', () => {
    // TYPE-vs-VALUE again, and in the one place the two orders genuinely differ:
    // "The attribute type X'00' can appear only in the SA order" (p. 4-18,
    // pages.txt:3456). In an SFE it is therefore an invalid type, and invalid types
    // "are rejected" (pages.txt:2897-2898) -- ignored, leaving the other pairs to
    // stand. x3270's SFE arm for XA_ALL advances past it without touching
    // efa_fg/bg/gr (ctlr.c:1869-1871), where its SA arm for the same type zeroes
    // all five defaults (ctlr.c:1915-1921).
    //
    // An earlier draft of this file asserted the opposite, on the plan's word. The
    // yellow must survive on the field.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x03, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW, XA.RESET, 0x00,
      0xc1,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
  });

  it('does NOT leak a field colour across a field boundary reached by SBA', () => {
    // THE BUG THAT REMOVED SFE'S RUNNING-STATE SEEDING, and the reason SFE's
    // attributes are field-scoped rather than carried in the SA state.
    //
    // An SBA (or PT) can move the write address into a DIFFERENT, ALREADY-EXISTING
    // field without passing an SF or SFE. A field-scoped attribute held in the
    // character-scoped running state has the wrong lifetime: nothing clears it at
    // the boundary, so it follows the address and lands on characters of a field
    // the host defined with no colour at all.
    //
    // Note this is legitimate for a real SA order, which is character-scoped and
    // applies to "subsequently interpreted characters in the data stream"
    // (p. 4-6, pages.txt:2969-2971) wherever they land -- see the SA tests above.
    // The bug was specific to conflating SFE's field scope with SA's character
    // scope.
    const s = run([
      ...W,
      0x11, 0x40, 0x4a, 0x1d, 0xc0,   // SBA 10, plain SF -- field at 10, NO colour
      ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,   // SFE at 0, yellow
      0xc1,                            // char at 1, inside the yellow field
      0x11, 0x40, 0x4b, 0xc2,          // SBA 11, char at 11 -- inside the PLAIN field
    ]);
    // Cell 11 belongs to the plain field at 10 and must carry no colour.
    expect(s.cellAt(11).fg).toBeUndefined();
    // And its field genuinely is the uncoloured one, so the assertion is not vacuous.
    expect(s.fieldAt(11)?.attrAddr).toBe(10);
    expect(s.cellAt(10).fg).toBeUndefined();
    // The yellow field is untouched and still carries its own colour.
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
  });
});

describe('the extended FIELD attribute survives what the character level cannot', () => {
  // These pin the field level against the two ways it could go missing. The basic
  // "SFE puts its pairs on the FA cell" cases are in the describe above.

  it('puts highlighting and background there as well, not just foreground', () => {
    // x3270 writes all of them to the FA cell, immediately after its pair loop and
    // before it increments past the attribute position (ctlr.c:1886-1891).
    const s = run([
      ...W, ...SBA0,
      0x29, 0x03, 0xc0, 0xc0, XA.BACKGROUND, Colour.BLUE, XA.HIGHLIGHTING, XAH.REVERSE,
      0xc1,
    ]);
    expect(s.cellAt(0).bg).toBe(Colour.BLUE);
    expect(s.cellAt(0).gr).toBe(XAH.REVERSE);
  });

  it('a plain SF leaves no extended field attribute', () => {
    const s = run([...W, ...SBA0, 0x1d, 0xc0, 0xc1]);
    expect(s.cellAt(0).fg).toBeUndefined();
  });

  it('KEEPS the field colour when a later record overwrites a character mid-field', () => {
    // THE REASON THE FIELD LEVEL MUST BE STORED AT ALL, and the defect this test
    // exists to prevent.
    //
    // A second record that overwrites one character mid-field, with no SFE and no
    // SA, correctly clears that character's own attribute -- "whenever a character
    // is overwritten by a new character ... the old character attribute is
    // overwritten by the character attribute of the new character"
    // (pages.txt:3388-3391) -- and must then have something to fall back on.
    // Without the field level, the colour would be gone from the buffer entirely.
    const s = new Screen();
    run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1, 0xc2, 0xc3,
    ], s);
    run([...W, 0x11, 0x40, 0x42, 0xc9], s);   // SBA to 2, overwrite the middle char

    expect(s.cellAt(2).fg).toBeUndefined();
    // The FIELD still carries the colour, so it is recoverable at render time.
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
    // And the field is still the same field, governing the overwritten cell.
    expect(s.fieldAt(2)?.attrAddr).toBe(0);
  });

  it('survives a second write command, unlike the running SA state', () => {
    // The running state resets per write command (pages.txt:2978); the field level
    // is buffer content and must NOT. A record that writes elsewhere entirely
    // leaves the field's colour in place.
    const s = new Screen();
    run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
    ], s);
    run([...W, 0x11, 0x40, 0x4b, 0xc2], s);   // second Write, SBA 11, far away
    expect(s.cellAt(0).fg).toBe(Colour.YELLOW);
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

  it('EUA leaves a PROTECTED cell attributes alone, not just its character', () => {
    // A PROTECTION control, not an address control. The test above proves EUA stops
    // at its stop address; it says nothing about protection, because every cell in
    // it is unprotected. Without this assertion, clearing attributes
    // unconditionally -- while leaving the NULL correctly guarded -- passes the
    // entire suite. Verified: that mutation failed 0 of 740 tests before this test
    // existed.
    //
    // The manual makes the protected case explicit twice in two lines: "Field
    // attributes and extended field attributes are not affected by EUA. Character
    // attributes for every character CHANGED TO NULLS are reset to their defaults"
    // (p. 4-11, pages.txt:3165-3166) -- so a cell that is not changed to nulls
    // keeps its attributes. x3270 likewise only touches unprotected cells, its
    // `else if (!FA_IS_PROTECTED(current_fa))` (ctlr.c:1711-1714).
    const s = new Screen();
    run([
      ...W, ...SBA0,
      0x1d, 0xc0 | 0x20,            // SF protected at 0, so 1.. is protected
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1, 0xc2,                   // protected chars at 1 and 2, both red
      0x11, 0x40, 0x41,             // SBA to 1
      0x12, 0x40, 0x43,             // EUA, stop 3 -- covers the protected cells
    ], s);
    // Protected, so neither the character nor its attributes may change.
    expect(s.cellAt(1).ebcdic).toBe(0xc1);
    expect(s.cellAt(1).fg).toBe(Colour.RED);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
  });

  it('EUA still clears an UNPROTECTED cell inside a formatted screen', () => {
    // The complement of the test above, so neither can pass by EUA simply never
    // clearing anything on a formatted screen.
    const s = new Screen();
    run([
      ...W, ...SBA0,
      0x1d, 0xc0,                   // SF unprotected at 0
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1, 0xc2,
      0x11, 0x40, 0x41,
      0x12, 0x40, 0x43,
    ], s);
    expect(s.cellAt(1).ebcdic).toBe(0x00);
    expect(s.cellAt(1).fg).toBeUndefined();
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
