import { describe, expect, it, vi } from 'vitest';
import { Screen } from '../src/screen.js';
import { resolve } from '../src/render.js';
import { Colour, PALETTE_3279 } from '../src/palette.js';
import { XA, XAH, FA, XA_3270 } from '../src/constants.js';
import { encodeAddress } from '../src/address.js';
import { cp037 } from '../src/codepage.js';
import { parseRecord } from '../src/stream/parse.js';
import { execute } from '../src/stream/execute.js';

/** Every architected colour identification — what `colourRgb` accepts. */
const PALETTE_KEYS = new Set(Array.from({ length: 16 }, (_, i) => 0xf0 + i));

/** A screen with one field of the given attribute, and a character at addr 1. */
function fielded(attr: number): Screen {
  const s = new Screen();
  s.setFieldAttribute(0, attr);
  s.setChar(1, 0xc1);
  return s;
}

// ---- record-level helpers, for the tests that must prove the whole chain ----

/** Build and run a write record, returning the screen it produced. */
function run(bytes: number[], screen = new Screen()): Screen {
  execute(screen, parseRecord(Uint8Array.from(bytes)));
  return screen;
}

/** Write, WCC 0x40 — a WCC with no bit that matters to resolution. */
const W = [0xf1, 0x40];

/** SBA to `addr` on a 1920-cell buffer. */
function sba(addr: number): number[] {
  return [0x11, ...encodeAddress(addr, 1920)];
}

/** An SFE at the current address: basic attribute plus extended type-value pairs. */
function sfe(basic: number, ...pairs: number[]): number[] {
  const n = 1 + pairs.length / 2;
  return [0x29, n, XA_3270, basic, ...pairs];
}

describe('resolve: base field attribute fallback (rule 2)', () => {
  it('unprotected normal is green', () => {
    const r = resolve(fielded(FA.PRINTABLE).snapshot());
    expect(r[1]!.fg).toBe(Colour.GREEN);
  });

  it('unprotected intensified is red', () => {
    const r = resolve(fielded(FA.PRINTABLE | FA.INT_HIGH_SEL).snapshot());
    expect(r[1]!.fg).toBe(Colour.RED);
  });

  it('protected normal is blue', () => {
    const r = resolve(fielded(FA.PRINTABLE | FA.PROTECT).snapshot());
    expect(r[1]!.fg).toBe(Colour.BLUE);
  });

  it('protected intensified is white', () => {
    const r = resolve(fielded(FA.PRINTABLE | FA.PROTECT | FA.INT_HIGH_SEL).snapshot());
    expect(r[1]!.fg).toBe(Colour.WHITE);
  });

  it('an unformatted screen is green', () => {
    // "If there are no field attributes in the character buffer, that is, the
    // buffer is unformatted ... If a character attribute specifies default for a
    // particular property, the device default for that property is used"
    // (pages.txt:3378-3382). Our Query Reply (Color) default is green, matching
    // x3270's `*obptr++ = 0xf0 + HOST_COLOR_GREEN` (sf.c do_qr_color), which is
    // also what `color_from_fa(0)` yields.
    const s = new Screen();
    s.setChar(0, 0xc1);
    expect(resolve(s.snapshot())[0]!.fg).toBe(Colour.GREEN);
  });

  it('the base map is selected by the FA bits, not by field order', () => {
    // Two fields with different base attributes on one screen. A resolver that
    // used the FIRST field, or a single global attribute, passes every test
    // above and fails this one.
    const s = new Screen();
    s.setFieldAttribute(0, FA.PRINTABLE);                 // green
    s.setChar(1, 0xc1);
    s.setFieldAttribute(10, FA.PRINTABLE | FA.PROTECT);   // blue
    s.setChar(11, 0xc2);
    const r = resolve(s.snapshot());
    expect(r[1]!.fg).toBe(Colour.GREEN);
    expect(r[11]!.fg).toBe(Colour.BLUE);
  });

  it('the LAST data cell of a field is governed by that field', () => {
    // A field's run is `length + 1` cells -- the attribute byte plus its data.
    // Mutation testing found that an off-by-one making it `length` leaves the
    // last data cell of EVERY field unowned, which silently greens it. Every
    // other test here writes near the START of a field, so all of them survived
    // it. This one asserts the far end of two adjacent fields.
    const s = new Screen();
    s.setFieldAttribute(0, FA.PRINTABLE | FA.PROTECT);   // blue: cells 1..9
    s.setFieldAttribute(10, FA.PRINTABLE);               // green: cells 11..1919
    for (let i = 0; i < 1920; i++) if (!s.isFieldAttribute(i)) s.setChar(i, 0xc1);
    const r = resolve(s.snapshot());
    expect(r[9]!.fg, 'last cell of the protected field').toBe(Colour.BLUE);
    expect(r[1919]!.fg, 'last cell of the buffer').toBe(Colour.GREEN);
    // And no cell anywhere is left unowned. `hidden` is the cheapest witness:
    // an unowned cell sees attribute 0x00, whose intensity is not 0x0C, so this
    // catches the same off-by-one through a second property.
    const hiddenScreen = new Screen();
    hiddenScreen.setFieldAttribute(0, FA.PRINTABLE | FA.INT_ZERO_NSEL);
    expect(resolve(hiddenScreen.snapshot()).every((c) => c.hidden)).toBe(true);
  });

  it('cells before the first field belong to the LAST field, which wraps', () => {
    // The buffer is a ring: the field whose attribute is highest in the buffer
    // owns everything up to the first attribute. x3270's `find_field_attribute`
    // scans backwards with wrap (ctlr.c). A resolver that walks fields forwards
    // without wrapping leaves these cells unowned and greens them.
    const s = new Screen();
    s.setFieldAttribute(10, FA.PRINTABLE | FA.PROTECT);   // blue, wraps to cell 0
    s.setChar(0, 0xc1);
    expect(resolve(s.snapshot())[0]!.fg).toBe(Colour.BLUE);
  });
});

describe('resolve: explicit colour wins (rule 1)', () => {
  it('an SA foreground overrides the base mapping', () => {
    const s = fielded(FA.PRINTABLE);          // would be green
    s.setExtended(1, { fg: Colour.PINK });
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.PINK);
  });

  it('an explicit background is used', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { bg: Colour.BLUE });
    expect(resolve(s.snapshot())[1]!.bg).toBe(Colour.BLUE);
  });

  it('the default background is neutral black', () => {
    // x3270 has no base-attribute map for background: it falls to a fixed
    // neutral black (c3270/screen.c:1158 `bg = cmap[HOST_COLOR_NEUTRAL_BLACK]`).
    expect(resolve(fielded(FA.PRINTABLE).snapshot())[1]!.bg).toBe(Colour.NEUTRAL_BLACK);
  });
});

// ---------------------------------------------------------------------------
// THE FIELD'S EXTENDED ATTRIBUTE: the level between the character's own and the
// base map. Built by running real records through execute() rather than by
// calling setExtended by hand, because the value of these tests is that they
// prove the WHOLE chain — parse, execute's field-scoped SFE storage, and this
// resolver's fallback. A hand-built screen would pin only the last link.
// ---------------------------------------------------------------------------

describe('resolve: the field extended attribute is the second level', () => {
  it('a character with no attribute of its own takes the field SFE colour', () => {
    // "If there are field attributes in the character buffer and if a character
    // attribute specifies default for any character property (color,
    // highlighting, or character set), the character is displayed using the
    // value of that property established for the field in the extended field
    // attribute" (p. 4-16, pages.txt:3383-3387).
    //
    // x3270: `if (ea_buf[baddr].fg) ... else if (ea_buf[fa_addr].fg) ...`
    // (c3270/screen.c:1139-1146), and the same two-step in the print path
    // (fprint_screen.c:754-758 falling back to the fa_fg set at :581-585).
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
      0xc1, 0xc2, // characters at 1 and 2, with no SA of their own
    ]);
    // Precondition: the executor really did leave these cells attribute-free,
    // so the yellow below can only have come from the fallback.
    expect(s.cellAt(1).fg).toBeUndefined();
    expect(s.cellAt(2).fg).toBeUndefined();

    const r = resolve(s.snapshot());
    expect(r[1]!.fg).toBe(Colour.YELLOW);
    expect(r[2]!.fg).toBe(Colour.YELLOW);
  });

  it('the field colour beats the base map, which would have said green', () => {
    // The mutation-proofing pair for the test above: an unprotected normal field
    // resolves to green from the base map, so a resolver that skipped level 2
    // would give green here rather than yellow.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
      0xc1,
    ]);
    expect(resolve(s.snapshot())[1]!.fg).not.toBe(Colour.GREEN);
  });

  it("a character's own SA still overrides the field's colour", () => {
    // "Otherwise, the character attribute overrides the field attribute"
        // (pages.txt:3386-3387).
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
      0xc1,                                 // 1: field yellow
      0x28, XA.FOREGROUND, Colour.PINK,
      0xc2,                                 // 2: character pink
    ]);
    const r = resolve(s.snapshot());
    expect(r[1]!.fg).toBe(Colour.YELLOW);
    expect(r[2]!.fg).toBe(Colour.PINK);
  });

  it('a character whose own colour was overwritten falls back to the field, not to green', () => {
    // THIS IS THE CASE THE FALLBACK EXISTS FOR. "whenever a character is
    // overwritten by a new character ... the old character attribute is
    // overwritten by the character attribute of the new character"
    // (pages.txt:3388-3391), so a second record that rewrites one cell mid-field
    // with no SA clears that cell's own colour. Without level 2 the cell would
    // come out green — one colourless hole between coloured neighbours, inside a
    // field the host still defines as yellow.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
      0x28, XA.FOREGROUND, Colour.PINK,
      0xc1, 0xc2, 0xc3,                     // 1,2,3 all pink characters
    ]);
    expect(resolve(s.snapshot())[2]!.fg).toBe(Colour.PINK);

    run([...W, ...sba(2), 0xe9], s);        // rewrite cell 2 with no SA at all
    expect(s.cellAt(2).fg).toBeUndefined(); // its own colour is genuinely gone

    const r = resolve(s.snapshot());
    expect(r[2]!.fg).toBe(Colour.YELLOW);   // the field's, not the base map's
    expect(r[1]!.fg).toBe(Colour.PINK);     // neighbours keep their own
    expect(r[3]!.fg).toBe(Colour.PINK);
  });

  it('background falls back to the field too', () => {
    // Same rule, same source: the manual says "any character property", and
    // x3270 mirrors the fg two-step for bg at c3270/screen.c:1153-1158.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.BACKGROUND, Colour.BLUE),
      0xc1,
    ]);
    expect(s.cellAt(1).bg).toBeUndefined();
    expect(resolve(s.snapshot())[1]!.bg).toBe(Colour.BLUE);
  });

  it('highlighting falls back to the field too', () => {
    // "When a character is assigned a highlighting property using the character
    // attribute, the character's property overrides (for that character) the
    // property defined by the extended field attribute" (pages.txt:3476-3478) —
    // so where the character assigns none, the field's stands. x3270:
    // `if (ea_buf[baddr].gr) ... else if (ea_buf[fa_addr].gr) ... else gr = 0`
    // (c3270/screen.c:1166-1171).
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.HIGHLIGHTING, XAH.REVERSE),
      0xc1,
    ]);
    expect(s.cellAt(1).gr).toBeUndefined();
    expect(resolve(s.snapshot())[1]!.reverse).toBe(true);
  });

  it("a character's own highlighting overrides the field's", () => {
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.HIGHLIGHTING, XAH.REVERSE),
      0x28, XA.HIGHLIGHTING, XAH.UNDERSCORE,
      0xc1,
    ]);
    const r = resolve(s.snapshot());
    expect(r[1]!.underscore).toBe(true);
    expect(r[1]!.reverse).toBe(false);
  });

  it('the field colour does not leak into the next field', () => {
    // The fallback is scoped to the field that OWNS the cell. A resolver that
    // carried the last-seen extended attribute forward across an attribute
    // position — rather than looking it up per cell — passes every test above
    // and colours this cell yellow.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
      0xc1,                                       // 1: in the yellow field
      ...sba(10), 0x1d, FA.PRINTABLE,             // plain SF at 10, no colour
      0xc2,                                       // 11: in the plain field
    ]);
    const r = resolve(s.snapshot());
    expect(r[1]!.fg).toBe(Colour.YELLOW);
    expect(r[11]!.fg).toBe(Colour.GREEN);
  });

  it('the field attribute cell itself shows its own extended colour', () => {
    // x3270 resolves the FA position with baddr == fa_addr
    // (`calc_attrs(baddr, baddr, fa)`, c3270/screen.c:1451), and the print path
    // reads fa_fg straight off it (fprint_screen.c:581-585). It falls out of a
    // per-cell lookup for free, because the FA cell's own field is itself.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
    ]);
    expect(resolve(s.snapshot())[0]!.fg).toBe(Colour.YELLOW);
  });
});

describe('resolve: mode3279 false makes everything green (rule 3)', () => {
  it('ignores the base mapping', () => {
    // x3270 fprint_screen.c:90-94 returns HOST_COLOR_GREEN unconditionally when
    // not in 3279 mode. A 3278 is monochrome hardware.
    const r = resolve(fielded(FA.PRINTABLE | FA.PROTECT).snapshot(), { mode3279: false });
    expect(r[1]!.fg).toBe(Colour.GREEN);
  });

  it('ignores an explicit SA colour too', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { fg: Colour.PINK });
    expect(resolve(s.snapshot(), { mode3279: false })[1]!.fg).toBe(Colour.GREEN);
  });

  it("ignores the field's extended colour too", () => {
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW, XA.BACKGROUND, Colour.BLUE),
      0xc1,
    ]);
    const r = resolve(s.snapshot(), { mode3279: false });
    expect(r[1]!.fg).toBe(Colour.GREEN);
    expect(r[1]!.bg).toBe(Colour.NEUTRAL_BLACK);
  });

  it('ignores an explicit background', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { bg: Colour.BLUE });
    expect(resolve(s.snapshot(), { mode3279: false })[1]!.bg).toBe(Colour.NEUTRAL_BLACK);
  });

  it('still honours highlighting, which is not colour', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { gr: XAH.REVERSE });
    const r = resolve(s.snapshot(), { mode3279: false });
    expect(r[1]!.reverse).toBe(true);
    expect(r[1]!.fg).toBe(Colour.GREEN);
  });
});

describe('resolve: the 0x00 and 0xF7 rules (rules 4 and 5)', () => {
  it('a colour value of 0x00 means device default, NOT black', () => {
    // "The X'00' value selects the device default color indicated in the Query
    // Reply (Color) structured field" (pages.txt:3544-3546). So it falls through
    // to the base mapping -- here a protected field, so blue.
    const s = fielded(FA.PRINTABLE | FA.PROTECT);
    s.setExtended(1, { fg: 0x00 });
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.BLUE);
  });

  it("a character's 0x00 falls through to the FIELD's colour, not past it", () => {
    // The two rules compose: 0x00 means "default for this property", and the
    // manual's conflict rule says a character specifying default takes the
    // field's value (pages.txt:3383-3387). So 0x00 must land on level 2, not
    // skip to the base map.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE | FA.PROTECT, XA.FOREGROUND, Colour.YELLOW),
      0x28, XA.FOREGROUND, 0x00,   // explicit "device default" on the character
      0xc1,
    ]);
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.YELLOW);
  });

  it('0x00 falls through even if the palette gains a 0x00 entry', async () => {
    // WHY THIS TEST EXISTS: the 0x00 rule is enforced twice in render.ts -- once
    // explicitly, and again by 0x00 not being a key of PALETTE_3279. Mutation
    // testing showed the explicit check can be DELETED with every other test in
    // this file still passing, because the second enforcement covers for it. But
    // the two encode DIFFERENT rules that merely agree today: X'00' means "device
    // default" as a matter of protocol (pages.txt:3544-3546), where the palette
    // lookup only means "renderable". Add a 0x00 swatch to the palette -- a
    // device-default swatch is an entirely plausible change -- and the protocol
    // rule would silently invert into "0x00 paints that swatch", overriding a
    // field colour the host did set.
    //
    // So this stubs exactly that future in and asserts the protocol rule still
    // holds. It has to go through the module registry rather than mutating the
    // export: PALETTE_3279 is Object.freeze'd, so an earlier version of this test
    // that used defineProperty silently failed to apply its own stub. Hence the
    // guard assertion below, which is what caught that.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.FOREGROUND, Colour.YELLOW),
      0x28, XA.FOREGROUND, 0x00,   // explicit "device default" on the character
      0xc1,
    ]);
    const snap = s.snapshot();

    vi.doMock('../src/palette.js', async () => {
      const actual = await vi.importActual<typeof import('../src/palette.js')>('../src/palette.js');
      return {
        ...actual,
        PALETTE_3279: Object.freeze({ ...actual.PALETTE_3279, 0x00: [0x11, 0x22, 0x33] }),
      };
    });
    try {
      const { resolve: mocked } = await import('../src/render.js');
      const palette = await import('../src/palette.js');
      expect(palette.PALETTE_3279[0x00], 'the stub must apply or this proves nothing')
        .toEqual([0x11, 0x22, 0x33]);
      expect(mocked(snap)[1]!.fg).toBe(Colour.YELLOW);
    } finally {
      vi.doUnmock('../src/palette.js');
      vi.resetModules();
    }
    // And the real palette is untouched, so no later test inherits the stub.
    expect(PALETTE_3279[0x00]).toBeUndefined();
    expect(resolve(snap)[1]!.fg).toBe(Colour.YELLOW);
  });

  it("a FIELD colour of 0x00 falls through to the base map", () => {
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE | FA.PROTECT, XA.FOREGROUND, 0x00),
      0xc1,
    ]);
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.BLUE);
  });

  it('0xF7 is neutral white, and is a real colour rather than a fall-through', () => {
    // "The X'F7' value indicates that the color is defined by a triple-plane
    // character set. If a single-plane or nonloadable character set is
    // referenced, the color defaults to the single color specified for the
    // X'F7' value by Query Reply (Color)" (pages.txt:3546-3549). Programmable
    // Symbol Sets are out of scope, so ours is always single-plane, and OUR
    // Query Reply (Color) maps F7 to F7 -- the identity pairs x3270 also sends
    // (sf.c do_qr_color). 0xF7 IS the Neutral colour identification, which
    // palette.ts renders as near-white; "defined as White for a display"
    // (pages.txt:3542-3543) describes how that phosphor looks, and is NOT an
    // instruction to substitute the distinct White identification 0xFF.
    //
    // x3270 special-cases F7 nowhere: `fg_color = xea[i].fg & 0x0f` gives it
    // HOST_COLOR_NEUTRAL_WHITE (7), its own palette slot, distinct from
    // HOST_COLOR_WHITE (15) (3270ds.h:313-328). Collapsing the two here would
    // undo the distinction palette.ts was built to preserve.
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { fg: 0xf7 });
    const r = resolve(s.snapshot());
    expect(r[1]!.fg).toBe(Colour.NEUTRAL_WHITE);
    expect(r[1]!.fg).not.toBe(Colour.GREEN);        // not a fall-through
    expect(r[1]!.fg).not.toBe(Colour.WHITE);        // not remapped to 0xFF
  });

  it('a malformed colour falls through to the default rather than throwing', () => {
    // A bad byte from a host must not take the client down. colourRgb() throws
    // on an unknown code, so resolve must never hand it one.
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { fg: 0x99 });
    expect(() => resolve(s.snapshot())).not.toThrow();
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.GREEN);
  });

  it('a malformed background falls through to neutral black', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { bg: 0x99 });
    expect(resolve(s.snapshot())[1]!.bg).toBe(Colour.NEUTRAL_BLACK);
  });

  it("a malformed colour on the FIELD falls through too, and not to the character's", () => {
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE | FA.PROTECT, XA.FOREGROUND, 0x99),
      0xc1,
    ]);
    expect(() => resolve(s.snapshot())).not.toThrow();
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.BLUE);
  });

  it('every resolved colour is one colourRgb accepts', () => {
    // The invariant behind all of the above, stated once: whatever a host sends,
    // a renderer can hand fg and bg straight to colourRgb. Sweeps every byte.
    const s = new Screen();
    s.setFieldAttribute(0, FA.PRINTABLE);
    for (let b = 0; b <= 0xff; b++) {
      s.setExtended(1, { fg: b, bg: b, gr: b });
      const c = resolve(s.snapshot())[1]!;
      expect(PALETTE_KEYS.has(c.fg), `fg for 0x${b.toString(16)}`).toBe(true);
      expect(PALETTE_KEYS.has(c.bg), `bg for 0x${b.toString(16)}`).toBe(true);
    }
  });
});

describe('resolve: highlighting', () => {
  it('maps each value to its flag', () => {
    const cases: [number, 'blink' | 'reverse' | 'underscore' | 'intensify'][] = [
      [XAH.BLINK, 'blink'],
      [XAH.REVERSE, 'reverse'],
      [XAH.UNDERSCORE, 'underscore'],
      [XAH.INTENSIFY, 'intensify'],
    ];
    for (const [value, flag] of cases) {
      const s = fielded(FA.PRINTABLE);
      s.setExtended(1, { gr: value });
      expect(resolve(s.snapshot())[1]![flag], `${flag} for 0x${value.toString(16)}`).toBe(true);
    }
  });

  it('sets ONLY the flag for the value given', () => {
    // The pair to the test above: mapping every value to every flag would pass
    // that one. The manual is explicit that highlighting is one-of, not a bit
    // set -- "The field can have only one highlighting property specified by the
    // extended field attribute (such as blink or reverse video but not both)"
    // (pages.txt:3472-3473).
    const all = ['blink', 'reverse', 'underscore', 'intensify'] as const;
    const cases: [number, (typeof all)[number]][] = [
      [XAH.BLINK, 'blink'],
      [XAH.REVERSE, 'reverse'],
      [XAH.UNDERSCORE, 'underscore'],
      [XAH.INTENSIFY, 'intensify'],
    ];
    for (const [value, flag] of cases) {
      const s = fielded(FA.PRINTABLE);
      s.setExtended(1, { gr: value });
      const c = resolve(s.snapshot())[1]!;
      for (const other of all) {
        expect(c[other], `${other} for 0x${value.toString(16)}`).toBe(other === flag);
      }
    }
  });

  it('XAH.NORMAL and XAH.DEFAULT set no flags', () => {
    for (const value of [XAH.NORMAL, XAH.DEFAULT]) {
      const s = fielded(FA.PRINTABLE);
      s.setExtended(1, { gr: value });
      const c = resolve(s.snapshot())[1]!;
      expect([c.blink, c.reverse, c.underscore, c.intensify]).toEqual([false, false, false, false]);
    }
  });

  it('an unrecognised highlighting value sets no flags', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { gr: 0x99 });
    const c = resolve(s.snapshot())[1]!;
    expect([c.blink, c.reverse, c.underscore, c.intensify]).toEqual([false, false, false, false]);
  });

  it('intensify is the 0xF8 highlighting, not the field intensified bit', () => {
    // ResolvedCell.intensify names highlighting X'F8' alone. A field's
    // intensified bit is already carried as colour by the base map (red /
    // white), so a renderer must not read this flag as "is the field bright".
    // Deliberately narrower than x3270's `high`, which ORs in FA_IS_HIGH(fa)
    // (c3270/screen.c:1183, fprint_screen.c:597-599) -- see render.ts.
    const r = resolve(fielded(FA.PRINTABLE | FA.INT_HIGH_SEL).snapshot());
    expect(r[1]!.intensify).toBe(false);
    expect(r[1]!.fg).toBe(Colour.RED);
  });
});

describe('resolve: text and hidden fields', () => {
  it('translates EBCDIC to a Unicode string', () => {
    expect(resolve(fielded(FA.PRINTABLE).snapshot())[1]!.text).toBe('A');
  });

  it('renders a null as a space', () => {
    const s = fielded(FA.PRINTABLE);
    expect(resolve(s.snapshot())[2]!.text).toBe(' ');
  });

  it('marks hidden fields so a renderer can suppress the text', () => {
    const s = fielded(FA.PRINTABLE | FA.INT_ZERO_NSEL);
    expect(resolve(s.snapshot())[1]!.hidden).toBe(true);
  });

  it('marks only zero intensity as hidden, not intensified', () => {
    for (const intensity of [FA.INT_NORM_NSEL, FA.INT_NORM_SEL, FA.INT_HIGH_SEL]) {
      const s = fielded(FA.PRINTABLE | intensity);
      expect(resolve(s.snapshot())[1]!.hidden, `0x${intensity.toString(16)}`).toBe(false);
    }
  });

  it('hidden is per field, not per screen', () => {
    const s = new Screen();
    s.setFieldAttribute(0, FA.PRINTABLE | FA.INT_ZERO_NSEL);
    s.setChar(1, 0xc1);
    s.setFieldAttribute(10, FA.PRINTABLE);
    s.setChar(11, 0xc2);
    const r = resolve(s.snapshot());
    expect(r[1]!.hidden).toBe(true);
    expect(r[11]!.hidden).toBe(false);
  });

  it('returns one entry per cell, including attribute positions', () => {
    const s = fielded(FA.PRINTABLE);
    const r = resolve(s.snapshot());
    expect(r).toHaveLength(s.size);
    // The attribute position itself displays as a blank.
    expect(r[0]!.text).toBe(' ');
  });

  it('blanks an attribute position even when a byte sits under it', () => {
    // WHY THIS BUILDS A SNAPSHOT BY HAND: mutation testing showed that deleting
    // the attribute-position test from `text` breaks nothing, because
    // `Screen.setFieldAttribute` also nulls the cell, so `ebcdic === 0x00`
    // blanks it anyway. An earlier version of this test asserted the blank off a
    // real Screen and therefore pinned storage's behaviour, not resolution's.
    //
    // `resolve` is a pure function of a ScreenSnapshot, so the honest way to pin
    // ITS rule is to hand it the state its contract must survive: a cell that is
    // a field attribute AND carries a character byte. A renderer must draw a
    // blank there regardless -- the position holds an attribute, not data.
    const snap: import('../src/screen.js').ScreenSnapshot = {
      rows: 1,
      cols: 2,
      cursor: 0,
      cells: [
        { kind: 'char', ebcdic: 0xc1 },   // 'A' sitting under the attribute
        { kind: 'char', ebcdic: 0xc2 },   // 'B', ordinary data
      ],
      fields: [
        { attrAddr: 0, start: 1, length: 1, attr: FA.PRINTABLE, protected: false,
          numeric: false, autoSkip: false, intensified: false, hidden: false, modified: false },
      ],
      formatted: true,
    };
    const r = resolve(snap);
    expect(r[0]!.text).toBe(' ');
    expect(r[1]!.text).toBe('B');
  });

  it('honours a non-default code page', () => {
    const s = fielded(FA.PRINTABLE);
    // cp037 and cp1047 differ only in the bracket/circumflex region, so a
    // character outside it proves the option is threaded through at all.
    expect(resolve(s.snapshot(), { codePage: cp037 })[1]!.text).toBe('A');
  });

  it('resolves a non-default geometry, one entry per cell', () => {
    const s = new Screen({ rows: 27, cols: 132 });
    s.setFieldAttribute(0, FA.PRINTABLE);
    expect(resolve(s.snapshot())).toHaveLength(27 * 132);
  });

  it('resolves an empty unformatted screen without throwing', () => {
    const s = new Screen();
    const r = resolve(s.snapshot());
    expect(r).toHaveLength(s.size);
    expect(r.every((c) => c.text === ' ' && c.fg === Colour.GREEN)).toBe(true);
  });
});
