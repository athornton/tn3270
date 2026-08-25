import { describe, expect, it, vi } from 'vitest';
import { Screen } from '../src/screen.js';
import { resolve } from '../src/render.js';
import { Colour, PALETTE_3279 } from '../src/palette.js';
import { XA, XAH, FA, XA_3270 } from '../src/constants.js';
import { encodeAddress } from '../src/address.js';
import { cp037, CodePage } from '../src/codepage.js';
import { parseRecord } from '../src/stream/parse.js';
import { execute } from '../src/stream/execute.js';
import { replayFixture, countDeferredOrders } from './helpers/trace.js';

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
    //
    // This briefly returned BLACK instead, to get a black-looking background in the
    // TUI. That was the wrong layer: core is the faithful model, and how neutral
    // black LOOKS is a front end's business. packages/tui now renders F0 as pure
    // black in its own palette, exactly as zti does, so core needs no divergence.
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

  // (A test asserting `.not.toBe(Colour.GREEN)` on this same record used to sit
  // here. Removed: the test above asserts `.toBe(Colour.YELLOW)` on identical
  // input, which is strictly stronger, so it could only ever fail alongside it.
  // The base map for an unprotected normal field IS green, which is what makes
  // yellow there proof that level 2 beat level 3.)

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

  it("a character's own background overrides the field's", () => {
    // THE MANUAL'S SECOND CLAUSE, FOR BACKGROUND: "Otherwise, the character
    // attribute overrides the field attribute" (pages.txt:3386-3387). Review
    // found background's two levels could be SWAPPED with the whole suite green
    // -- every bg test set the field's colour and left the character's unset, so
    // nothing distinguished which of the two won when both were present. The
    // equivalent swap already failed for fg and gr; only bg was unpinned.
    const s = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE, XA.BACKGROUND, Colour.BLUE),
      0x28, XA.BACKGROUND, Colour.PINK,
      0xc1,
    ]);
    expect(s.cellAt(1).bg, 'the character must really carry its own bg').toBe(Colour.PINK);
    expect(resolve(s.snapshot())[1]!.bg).toBe(Colour.PINK);
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

// ---------------------------------------------------------------------------
// THE X'00' RULE, PINNED THROUGH HAND-BUILT SNAPSHOTS AND NOT THROUGH A Screen.
//
// `Screen` stores "unspecified" as the byte 0, so `cellAt` OMITS the property
// when it is zero -- see the `fgs`/`bgs`/`grs` comment in screen.ts, where the
// sentinel is justified precisely because XAC_DEFAULT renders the same as
// nothing-set. The consequence for testing is sharp: BOTH routes into a Screen
// collapse an explicit 0x00 to *absent*, so neither can pin this rule.
//
//   setExtended(1, { fg: 0x00 })            -> snapshot cell has no `fg`
//   SA X'42' X'00' through parse+execute    -> the same
//
// An earlier version of this file asserted the rule three times through those
// routes. Every assertion was TRUE but VACUOUS: instrumenting the `code === 0x00`
// branch showed ZERO hits across the whole file, and mutating it to return black
// -- the exact error the manual forbids -- left all 49 tests green.
//
// `resolve` is an exported pure function of a ScreenSnapshot, so a hand-built
// snapshot carrying an explicit zero is a legitimate input and the only way to
// reach the branch. Same reasoning, and same precedent, as the attribute-position
// test below.
// ---------------------------------------------------------------------------

/**
 * A 1x3 snapshot: a field attribute at 0 with optional extended attributes, and
 * two data cells at 1 and 2 whose own attributes the caller supplies.
 */
function handBuilt(
  attr: number,
  fieldExt: { fg?: number; bg?: number; gr?: number },
  cellExt: { fg?: number; bg?: number; gr?: number },
): import('../src/screen.js').ScreenSnapshot {
  return {
    rows: 1,
    cols: 3,
    cursor: 0,
    cells: [
      { kind: 'char', ebcdic: 0x00, ...fieldExt },  // the field-attribute cell
      { kind: 'char', ebcdic: 0xc1, ...cellExt },   // 'A', the cell under test
      { kind: 'char', ebcdic: 0xc2 },
    ],
    fields: [
      {
        attrAddr: 0, start: 1, length: 2, attr,
        protected: (attr & FA.PROTECT) !== 0,
        numeric: false, autoSkip: false,
        intensified: (attr & FA.INTENSITY) === FA.INT_HIGH_SEL,
        hidden: (attr & FA.INTENSITY) === FA.INT_ZERO_NSEL,
        modified: false,
      },
    ],
    formatted: true,
  };
}

describe('resolve: the 0x00 and 0xF7 rules (rules 4 and 5)', () => {
  it("an explicit fg of 0x00 falls through to the FIELD's colour, NOT to black", () => {
    // "The X'00' value selects the device default color indicated in the Query
    // Reply (Color) structured field" (pages.txt:3544-3546) -- it is a
    // fall-through, and emphatically not the colour black, which has its own
    // identifications (0xF0 neutral black, 0xF8 black).
    //
    // Composed with the conflict rule: a character "specifying default" takes the
    // value "established for the field in the extended field attribute"
    // (pages.txt:3383-3387). So 0x00 must land on LEVEL 2, not skip past it to
    // the base map -- which is why the field here is protected (base map: blue)
    // while its extended attribute is yellow. Only the correct behaviour yields
    // yellow: black fails, and skipping level 2 gives blue.
    const snap = handBuilt(FA.PRINTABLE | FA.PROTECT, { fg: Colour.YELLOW }, { fg: 0x00 });
    expect(snap.cells[1]!.fg, 'the explicit zero must survive into the input').toBe(0x00);
    expect(resolve(snap)[1]!.fg).toBe(Colour.YELLOW);
  });

  it('an explicit fg of 0x00 with no field colour falls through to the base map', () => {
    // The same fall-through continuing to level 3 when level 2 has nothing:
    // a protected, unintensified field is blue (fprint_screen.c:81-88).
    const snap = handBuilt(FA.PRINTABLE | FA.PROTECT, {}, { fg: 0x00 });
    expect(snap.cells[1]!.fg).toBe(0x00);
    expect(resolve(snap)[1]!.fg).toBe(Colour.BLUE);
  });

  it("an explicit bg of 0x00 falls through to the FIELD's background", () => {
    // The manual's rule is per PROPERTY -- "any character property" -- so
    // background behaves identically, and x3270 mirrors the two-step for bg at
    // c3270/screen.c:1153-1158.
    const snap = handBuilt(FA.PRINTABLE, { bg: Colour.BLUE }, { bg: 0x00 });
    expect(snap.cells[1]!.bg).toBe(0x00);
    expect(resolve(snap)[1]!.bg).toBe(Colour.BLUE);
  });

  it('an explicit FIELD colour of 0x00 falls through to the base map', () => {
    // The rule applies at level 2 as well: a field whose extended attribute says
    // "device default" contributes nothing, and the base map decides.
    const snap = handBuilt(FA.PRINTABLE | FA.PROTECT, { fg: 0x00 }, {});
    expect(snap.cells[0]!.fg).toBe(0x00);
    expect(resolve(snap)[1]!.fg).toBe(Colour.BLUE);
  });

  it('0x00 is a fall-through even if the palette gains a 0x00 entry', async () => {
    // The `code === 0x00` check and the palette-membership check reject 0x00
    // independently, and they encode DIFFERENT rules that merely agree today:
    // this one is the architected meaning of X'00' (pages.txt:3544-3546), the
    // other is "unrenderable byte". Add a 0x00 swatch to the palette -- a
    // device-default swatch is an entirely plausible change -- and only the
    // explicit check stops the protocol rule inverting into "0x00 paints that
    // swatch", overriding a field colour the host did set.
    //
    // Unlike the earlier version of this test, the input carries a REAL explicit
    // zero, so it reaches the branch and the stub is relevant to it.
    //
    // TWO WAYS THIS TEST HAS ALREADY FAILED TO TEST ANYTHING, hence the two guard
    // assertions. (1) A version mutating the export with defineProperty silently
    // did nothing, because PALETTE_3279 is Object.freeze'd -- so it goes through
    // the module registry instead. (2) `vi.doMock` alone was not enough either:
    // `render.js` is statically imported at the top of this file and therefore
    // already cached against the REAL palette, so re-importing it returned the
    // identical module object and the stub never reached it. `vi.resetModules()`
    // must come BEFORE the re-import, and the second guard below asserts we really
    // did get a fresh module rather than the cached one.
    const snap = handBuilt(FA.PRINTABLE, { fg: Colour.YELLOW }, { fg: 0x00 });

    vi.doMock('../src/palette.js', async () => {
      const actual = await vi.importActual<typeof import('../src/palette.js')>('../src/palette.js');
      return {
        ...actual,
        PALETTE_3279: Object.freeze({ ...actual.PALETTE_3279, 0x00: [0x11, 0x22, 0x33] }),
      };
    });
    try {
      vi.resetModules();
      const { resolve: mocked } = await import('../src/render.js');
      const palette = await import('../src/palette.js');
      expect(palette.PALETTE_3279[0x00], 'the stub must apply or this proves nothing')
        .toEqual([0x11, 0x22, 0x33]);
      expect(mocked, 'must be a FRESH render module, not the statically cached one')
        .not.toBe(resolve);
      expect(mocked(snap)[1]!.fg).toBe(Colour.YELLOW);
    } finally {
      vi.doUnmock('../src/palette.js');
      vi.resetModules();
    }
    // And the real palette is untouched, so no later test inherits the stub.
    expect(PALETTE_3279[0x00]).toBeUndefined();
    expect(resolve(snap)[1]!.fg).toBe(Colour.YELLOW);
  });

  it('a Screen collapses 0x00 to absent, which is why the tests above bypass it', () => {
    // Pins the storage-layer fact that made the earlier tests vacuous, so that if
    // `Screen` ever starts preserving an explicit zero -- distinguishing
    // "unspecified" from XAC_DEFAULT -- this fails and points here. It is the
    // reason the four tests above hand-build their snapshots, and that reason
    // should not be able to rot silently.
    const s = fielded(FA.PRINTABLE | FA.PROTECT);
    s.setExtended(1, { fg: 0x00 });
    expect(s.snapshot().cells[1]!.fg).toBeUndefined();
    // Both routes: an SA order carrying 0x00 collapses the same way.
    const viaRecord = run([
      ...W, ...sba(0),
      ...sfe(FA.PRINTABLE | FA.PROTECT, XA.FOREGROUND, Colour.YELLOW),
      0x28, XA.FOREGROUND, 0x00,
      0xc1,
    ]);
    expect(viaRecord.snapshot().cells[1]!.fg).toBeUndefined();
    // Absent and explicit-zero must nonetheless RESOLVE the same -- which is the
    // whole justification for the sentinel (screen.ts, on `fgs`/`bgs`/`grs`).
    expect(resolve(viaRecord.snapshot())[1]!.fg).toBe(Colour.YELLOW);
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

  it("an unrecognised highlighting value FALLS THROUGH to the field's, not over it", () => {
    // THE BUG THIS PINS, which review found and I reproduced: highlighting used to
    // gate level 1 on NON-ZERO where fg and bg gate it on RENDERABLE. So the same
    // malformed byte behaved oppositely one property apart -- a cell carrying
    // gr = 0x99 in a reverse-video field had its reverse SUPPRESSED, while a cell
    // carrying fg = 0x99 in a yellow field correctly fell THROUGH to yellow.
    //
    // Falling through is what the manual requires, and it says so for values as
    // well as types: "Attribute types and values that are unknown or cannot be
    // maintained and returned inbound by an implementation are rejected. All
    // attribute types and values are checked for validity" (pages.txt:2897-2899).
    // A rejected value was never established, so the field's highlighting stands.
    //
    // Hand-built because the point is the resolver's policy, and this states it as
    // a single invariant across all three properties.
    const snap = handBuilt(
      FA.PRINTABLE,
      { gr: XAH.REVERSE, fg: Colour.YELLOW, bg: Colour.BLUE },
      { gr: 0x99, fg: 0x99, bg: 0x99 },
    );
    const c = resolve(snap)[1]!;
    expect(c.reverse, 'garbage gr must not suppress the field reverse').toBe(true);
    expect(c.fg, 'garbage fg falls through, as it always did').toBe(Colour.YELLOW);
    expect(c.bg, 'garbage bg falls through, as it always did').toBe(Colour.BLUE);
  });

  it('XAH.NORMAL is a real value that OVERRIDES the field, not a fall-through', () => {
    // The counterpart to the test above, and the reason `usableHighlight` rejects
    // only XAH.DEFAULT and not XAH.NORMAL. X'F0' is "Normal (as determined by the
    // 3270 field attribute)" (pages.txt:3489-3495) -- an explicit instruction to
    // show no extended highlighting, which is NOT the same as saying nothing.
    // A character set to Normal inside a reverse-video field must come out plain.
    const snap = handBuilt(FA.PRINTABLE, { gr: XAH.REVERSE }, { gr: XAH.NORMAL });
    const c = resolve(snap)[1]!;
    expect(c.reverse).toBe(false);
    expect([c.blink, c.underscore, c.intensify]).toEqual([false, false, false]);
    // Where XAH.DEFAULT, being "the default action of the device"
    // (pages.txt:10329-10331), does fall through and the field's reverse stands.
    expect(resolve(handBuilt(FA.PRINTABLE, { gr: XAH.REVERSE }, { gr: XAH.DEFAULT }))[1]!.reverse)
      .toBe(true);
  });

  it('an unrecognised FIELD highlighting value falls through to no highlighting', () => {
    const snap = handBuilt(FA.PRINTABLE, { gr: 0x99 }, {});
    const c = resolve(snap)[1]!;
    expect([c.blink, c.reverse, c.underscore, c.intensify]).toEqual([false, false, false, false]);
  });

  it('X-00 is one of the six valid highlighting values yet must not act as one', () => {
    // WHY THIS EXISTS: `usableHighlight` rejects XAH.DEFAULT twice over -- by an
    // explicit clause, and by 0x00 not being a member of the HIGHLIGHTS set. So
    // deleting the explicit clause changes nothing today and no test can kill it,
    // exactly as for the colour 0x00 check. Mutation testing confirmed that.
    //
    // The risk the clause guards is specific and realistic: X'00' IS one of the
    // six architecturally valid highlighting values (pages.txt:10313-10325), so a
    // future reader completing HIGHLIGHTS from the manual would add it -- and
    // without the clause, a character's X'00' would then override its field's
    // highlighting with nothing, inverting the manual's rule.
    //
    // This test pins the OBSERVABLE rule the clause defends, stated so that it
    // fails if either enforcement is removed while the other is loosened: X'00'
    // must behave like an absent attribute and NOT like XAH.NORMAL, even though
    // both are valid values and both end up showing no highlight.
    const field = { gr: XAH.REVERSE };
    const viaDefault = resolve(handBuilt(FA.PRINTABLE, field, { gr: XAH.DEFAULT }))[1]!;
    const viaAbsent = resolve(handBuilt(FA.PRINTABLE, field, {}))[1]!;
    const viaNormal = resolve(handBuilt(FA.PRINTABLE, field, { gr: XAH.NORMAL }))[1]!;
    // X'00' is indistinguishable from saying nothing at all...
    expect(viaDefault.reverse).toBe(viaAbsent.reverse);
    expect(viaDefault.reverse).toBe(true);
    // ...and distinguishable from X'F0', which suppresses the field's highlight.
    expect(viaNormal.reverse).toBe(false);
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
    expect(resolve(s.snapshot())).toHaveLength(s.size);
    // The blank at the attribute position is asserted by the test below, which
    // pins it against a byte actually sitting under the attribute; asserting it
    // here as well only re-tested `setFieldAttribute` nulling the cell.
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
    // MUST USE A CODE PAGE THAT DISAGREES WITH THE DEFAULT. An earlier version
    // passed `{ codePage: cp037 }` -- which IS the default -- and asserted 'A',
    // so hardcoding cp037 and discarding `opts.codePage` left it green. It
    // asserted the right thing and pinned nothing.
    //
    // codepage.ts exports only cp037, so this builds a stub whose table maps
    // every byte to a distinguishable character. Any assertion that passes with
    // this stub and with cp037 alike would be worthless, so 'Z' is chosen
    // precisely because cp037 decodes 0xC1 as 'A'.
    const alwaysZ = new CodePage('always-Z', new Array<number>(256).fill(0x5a /* 'Z' */));
    const s = fielded(FA.PRINTABLE);
    expect(resolve(s.snapshot(), { codePage: alwaysZ })[1]!.text).toBe('Z');
    // And the default really is cp037, so the option is a genuine override.
    expect(resolve(s.snapshot())[1]!.text).toBe('A');
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

describe('the live TK5 ISPF fixture', () => {
  // THE ONLY EVIDENCE IN THIS SUITE THAT COMES FROM A REAL HOST. Everything else
  // in this file is a hand-built screen or a hand-assembled record, which proves
  // the rules are implemented as written but cannot prove a host actually sends
  // what we think it sends. This block replays 895 lines of MVS 3.8j TK5 traffic
  // captured 2026-08-18 and asserts colour survives the whole chain: telnet
  // negotiation -> framer -> parseRecord -> execute -> Screen -> resolve.
  //
  // EVERY NUMBER BELOW WAS MEASURED against the converted fixture, not guessed.
  // If yours differ, THE CONVERSION DIFFERS -- investigate that rather than
  // adjusting the expectation. Regenerate the fixture with the sed command in its
  // own header comment.
  //   28 fields; 532 of 1920 cells with a character-level fg; resolved fg counts
  //   white 793, blue 618, red 329, neutral-white 144, yellow 36 (= 1920).
  const FIXTURE = 'mvs-tk5-tso-ispf.trace';

  it('replays at all -- the negative control this task exists because of', () => {
    // THE FIXTURE WAS UNREPLAYABLE AS ORIGINALLY COMMITTED. It is raw CLI stdout
    // with a `data: ` prefix on every line, so zero lines matched parseTrace's
    // regex and replay produced an empty screen -- 0 fields, 1920 uniformly green
    // cells -- WITHOUT ERRORING. Assert the screen is FORMATTED first, so a
    // regression in the conversion fails here and loudly rather than surfacing as
    // a subtly wrong colour count below.
    const s = replayFixture(FIXTURE);
    expect(s.screen.isFormatted()).toBe(true);
    // Exact, not `> 20`: 28 is a fact about this capture, and a loose bound would
    // still pass if a change silently dropped a quarter of the fields.
    expect(s.screen.fields()).toHaveLength(28);
  });

  it('carries real character-level colour, not just base-attribute colour', () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL GAP. Before this work every
    // SA order was parsed and discarded, so this count was 0 for the whole life of
    // the project. It counts cells whose OWN fg is set -- storage, before any
    // resolution -- which is the narrowest place the SA path can be observed.
    const s = replayFixture(FIXTURE);
    let withFg = 0;
    for (let i = 0; i < s.screen.size; i++) {
      if (s.screen.cellAt(i).fg !== undefined) withFg++;
    }
    expect(withFg).toBe(532);

    // AND NOTHING ELSE ARRIVED, which is as much a finding as the 532. TK5 sends
    // only SA type X'42'; no background and no highlighting, so these must be 0.
    // Pinning the zeros means a future capture that DOES carry them fails here and
    // gets looked at, instead of quietly widening what this test appears to cover.
    let withBg = 0;
    let withGr = 0;
    for (let i = 0; i < s.screen.size; i++) {
      const c = s.screen.cellAt(i);
      if (c.bg !== undefined) withBg++;
      if (c.gr !== undefined) withGr++;
    }
    expect(withBg).toBe(0);
    expect(withGr).toBe(0);
  });

  it('uses colours the base-attribute map alone could not produce', () => {
    // THIS IS THE TEST THAT DISTINGUISHES "COLOUR RESOLVED" FROM "COLOUR RECEIVED".
    // DEFAULT_COLOURS in render.ts has exactly four entries -- green, red, blue,
    // white -- so those four can appear on a screen where every SA order was thrown
    // away. Neutral-white and yellow CANNOT: nothing but a character-level
    // attribute from an SA order can put them there. A test asserting merely "more
    // than one colour" would pass on a screen with no SA support whatsoever.
    const s = replayFixture(FIXTURE);
    const fromDefaults = new Set<number>([Colour.GREEN, Colour.RED, Colour.BLUE, Colour.WHITE]);
    const counts = new Map<number, number>();
    for (const c of resolve(s.screen.snapshot())) counts.set(c.fg, (counts.get(c.fg) ?? 0) + 1);

    expect(counts.get(Colour.NEUTRAL_WHITE)).toBe(144);
    expect(counts.get(Colour.YELLOW)).toBe(36);

    const beyond = [...counts.keys()].filter((c) => !fromDefaults.has(c));
    expect(beyond.sort()).toEqual([Colour.YELLOW, Colour.NEUTRAL_WHITE]);

    // The whole distribution, so a change in ANY of the four precedence levels
    // moves a number here rather than hiding inside a `toBeGreaterThan`.
    expect(Object.fromEntries([...counts].map(([k, n]) => [k.toString(16), n]))).toEqual({
      ff: 793, // white  -- protected intensified fields, via the base map
      f1: 618, // blue   -- protected normal fields, via the base map
      f2: 329, // red    -- SA X'42' X'F2'
      f7: 144, // neutral-white -- SA, unreachable from the base map
      f6: 36,  // yellow        -- SA, unreachable from the base map
    });
    // Every cell accounted for: the counts partition the buffer.
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(s.screen.size);

    // AND mode3279:false must flatten all of it back to green -- the same real
    // screen driven through the monochrome gate, which no hand-built fixture can
    // show is reachable from actual host traffic.
    const mono = new Set(resolve(s.screen.snapshot(), { mode3279: false }).map((c) => c.fg));
    expect([...mono]).toEqual([Colour.GREEN]);
  });

  it('pins the SA order counts, so a parser regression fails loudly', () => {
    // Without this, a change that stopped recognising SA would show up only as a
    // quietly monochrome screen -- exactly the failure mode this block exists to
    // end. Counts come from the PARSER, never a hex grep: see
    // packages/cli/scripts/count-orders.mjs and its header for why a grep over
    // "28 42" is wrong in both directions at once.
    const counts = countDeferredOrders(FIXTURE);
    expect(counts.sa).toBe(113);
    expect(counts.mf).toBe(0);
    expect(counts.byType.get(0x42)).toBe(101); // foreground colour
    expect(counts.byType.get(0x00)).toBe(12);  // reset character attributes
    // No OTHER SA type appears, so 101 + 12 is the whole of the 113 and the two
    // named types cannot drift apart from the total unnoticed.
    expect([...counts.byType.keys()].sort()).toEqual([0x00, 0x42]);
    // The reassembly itself, because a change there would move every count above
    // in step and leave this test green while measuring a different byte stream.
    expect(counts.records).toBe(25);
    expect(counts.parsed).toBe(21);
  });

  it('confirms the fixture has NO SFE orders, so the field level is uncovered', () => {
    // NOT A FORMALITY. This is the assertion that documents what the suite does NOT
    // prove. All 113 SA orders are character-level, so no field-attribute cell in
    // this capture carries extended attributes, and resolve()'s SECOND precedence
    // level -- the field-level fallback -- gets no coverage from real host traffic
    // at all. That is precisely why that class of defect went unnoticed for so long.
    // Real coverage needs a capture from a host that sends SFE; none is committed.
    //
    // If a future fixture DOES contain SFE, this test failing is the signal to go
    // and add genuine field-level coverage -- not to relax the assertion.
    // [[check-what-a-comparison-covers]]
    const counts = countDeferredOrders(FIXTURE);

    // EVERY OTHER ASSERTION IN THIS TEST IS "EXPECT NOTHING", WHICH AN EMPTY PARSE
    // SATISFIES FOR FREE. Replaying the UNCONVERTED fixture reassembles 0 records
    // and derives 0 fields, so `sfe === 0` and the loop below both held while
    // measuring nothing whatsoever -- this was the ONE test of the five that stayed
    // GREEN against the broken fixture, which makes it the exact trap this project
    // has been bitten by three times. So anchor the absence to a POSITIVE fact
    // first: the parse really happened and really saw the orders.
    expect(counts.parsed).toBe(21);
    expect(counts.sa).toBe(113);

    // Now the absence means something.
    expect(counts.sfe).toBe(0);

    // AND THE CONSEQUENCE, ASSERTED DIRECTLY rather than left as prose: not one
    // field-attribute cell carries an extended attribute. This is what "the field
    // level is uncovered" MEANS, and unlike the SFE count it is measured at the
    // storage layer, so it would still hold if SFE were parsed but not stored.
    const s = replayFixture(FIXTURE);
    const fields = s.screen.fields();
    // Guard the loop for the same reason: `for (const f of [])` asserts nothing.
    expect(fields).toHaveLength(28);
    for (const f of fields) {
      const cell = s.screen.cellAt(f.attrAddr);
      expect(cell.fg, `field at ${f.attrAddr}`).toBeUndefined();
      expect(cell.bg, `field at ${f.attrAddr}`).toBeUndefined();
      expect(cell.gr, `field at ${f.attrAddr}`).toBeUndefined();
    }
  });
});
