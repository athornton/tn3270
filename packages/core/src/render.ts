/**
 * Resolve protocol attributes into concrete colours for a renderer.
 *
 * ## WHY THIS IS IN CORE AND NOT IN EACH FRONT END
 *
 * Storage says what the host sent. This says what colour a cell IS, and its
 * rules are datastream semantics rather than rendering taste:
 *
 *   - A character with no attribute of its own falls back to its FIELD's
 *     extended attribute before reaching the base map (pages.txt:3383-3387).
 *   - A colour VALUE of 0x00 means "the device default indicated in Query Reply
 *     (Color)" (GA23-0059 p. 4-20, pages.txt:3544-3546) -- NOT black.
 *   - 0xF7 is the Neutral colour identification, and means "the colour comes
 *     from a triple-plane character set"; with a single-plane or nonloadable set
 *     it takes the single colour Query Reply (Color) gives for F7
 *     (pages.txt:3546-3549). Ours is the identity, so F7 stays F7 -- see the
 *     note on that below, which corrects an error in the plan.
 *
 * Reimplemented in the TUI, the GUI and a web front end, those would diverge
 * three ways. So they live here, once, and every front end consumes
 * `ResolvedCell[]`.
 *
 * This module is PURE: no I/O, no Session, no terminal. It takes a snapshot and
 * returns an array. That is what makes every rule above independently testable.
 *
 * ## THE PRECEDENCE, WHICH IS THE WHOLE POINT
 *
 * For each cell, in order:
 *
 *   1. the CHARACTER's own extended attribute (`cell.fg`), if usable
 *   2. the FIELD's extended attribute, read from the cell at the governing
 *      field's `attrAddr` -- where `execute.ts` stores an SFE's pairs
 *   3. the base-attribute map, `defaultColour` below
 *   4. `mode3279 === false` overrides all three with green
 *
 * Level 2 is the manual's conflict-resolution rule: "If there are field
 * attributes in the character buffer and if a character attribute specifies
 * default for any character property (color, highlighting, or character set),
 * the character is displayed using the value of that property established for
 * the field in the extended field attribute. Otherwise, the character attribute
 * overrides the field attribute" (p. 4-16, pages.txt:3383-3387).
 *
 * x3270 does exactly this two-step, per property, in both of its renderers:
 *
 *     if (ea_buf[baddr].fg)         { ix = ea_buf[baddr].fg & 0x0f; ... }
 *     else if (ea_buf[fa_addr].fg)  { ix = ea_buf[fa_addr].fg & 0x0f; ... }
 *     else                          { fg = default_color_from_fa(fa); }
 *
 * (`c3270/screen.c:1139-1150`, with the same shape for bg at :1153-1158 and for
 * gr at :1166-1171; the print path is `fprint_screen.c:754-758` falling back to
 * the `fa_fg` it set from the FA cell at :581-585.) Note that the fallback
 * covers BACKGROUND AND HIGHLIGHTING TOO, not just foreground -- the manual says
 * "any character property", and treating it as foreground-only would leave an
 * SFE's reverse-video field flat.
 *
 * The unformatted case is the manual's other bullet: "If there are no field
 * attributes in the character buffer, that is, the buffer is unformatted, then
 * the character attributes are always used ... If a character attribute
 * specifies default for a particular property, the device default for that
 * property is used" (pages.txt:3378-3382). Level 2 is vacuous there (no field)
 * and level 3 with an attribute of 0x00 gives green, which IS our device
 * default -- the same value x3270 reports as CAV 0x00 in Query Reply (Color)
 * (`sf.c` `do_qr_color`: `*obptr++ = 0xf0 + HOST_COLOR_GREEN`).
 */

import { FA, XAH } from './constants.js';
// CodePage is a CLASS, not an interface, so it is a plain import. Its
// byte-to-string method is `toUnicode(byte)`.
import { cp037, CodePage } from './codepage.js';
import { Colour, PALETTE_3279, type Colour3279 } from './palette.js';
import type { ScreenSnapshot } from './screen.js';

export interface ResolvedCell {
  /** What to draw. A space for nulls and for field-attribute positions. */
  text: string;
  /** Concrete 3279 colour identification. Never undefined, never invalid. */
  fg: Colour3279;
  bg: Colour3279;
  blink: boolean;
  reverse: boolean;
  underscore: boolean;
  /**
   * Highlighting 0xF8 ALONE. Deliberately NOT the base attribute's intensified
   * bit: "A highlighting property specified by the extended field attribute does
   * not affect the intensify property specified by the field attribute"
   * (pages.txt:3474-3475), and an intensified FIELD is already carried here as
   * colour, by `defaultColour` returning red or white.
   *
   * x3270's equivalent is wider -- `(gr & GR_INTENSIFY) || FA_IS_HIGH(fa)`
   * (c3270/screen.c:1183) -- because curses gives it A_BOLD as its only
   * brightness lever and it uses bold for both. We have real colour, so folding
   * the two would make an intensified field bold AND red, double-signalling one
   * protocol fact. A renderer wanting x3270's look can OR in its own test.
   */
  intensify: boolean;
  /** Field intensity 0x0C: a renderer must not draw the text at all. */
  hidden: boolean;
}

export interface ResolveOptions {
  /**
   * Is this a colour device? Defaults to true.
   *
   * When false EVERY cell is green regardless of what the host sent, which is
   * x3270's behaviour (`color_from_fa` returns HOST_COLOR_GREEN unconditionally,
   * fprint_screen.c:90-94). A 3278 is monochrome hardware and must not be
   * colourised just because a host sent an attribute it should not have.
   *
   * Applies to BACKGROUND as well as foreground, and x3270 is the reason: its
   * whole colour block is inside `if (mode3279 || ...)` (c3270/screen.c:1126),
   * so a mono device reaches neither `ea_buf[baddr].fg` nor `.bg`. Colouring the
   * background of a green-only screen would be worse than useless -- green on
   * blue is what a host meant for a colour terminal.
   */
  mode3279?: boolean;
  codePage?: CodePage;
}

/**
 * The 3279 default colour map: which colour a cell takes from its base field
 * attribute when neither it nor its field specifies one.
 *
 * x3270's `field_colors[4]` with its `DEFCOLOR_MAP` index
 * (fprint_screen.c:81-88): bit 1 is PROTECT, bit 0 is INT_HIGH_SEL.
 *
 * NO `mode3279` PARAMETER, unlike x3270's `color_from_fa`, which takes the gate
 * inside itself (fprint_screen.c:90-94) because it is the only colour path its
 * print renderer has. Here the gate has to sit at the call site instead: it
 * overrides levels 1 and 2 as well, and those never reach this function. An
 * earlier version had the check in BOTH places, so deleting the one here changed
 * nothing and no test could tell — mutation testing found it. One gate, one
 * place, and `mode3279: false` is now the only thing that can produce green
 * without consulting this table.
 */
const DEFAULT_COLOURS: readonly Colour3279[] = [
  Colour.GREEN, // unprotected, normal
  Colour.RED,   // unprotected, intensified
  Colour.BLUE,  // protected, normal
  Colour.WHITE, // protected, intensified
];

function defaultColour(attr: number): Colour3279 {
  const index = ((attr & FA.PROTECT) !== 0 ? 2 : 0) | ((attr & FA.INT_HIGH_SEL) !== 0 ? 1 : 0);
  return DEFAULT_COLOURS[index]!;
}

/**
 * Is `code` a colour we can actually render?
 *
 * 0x00 is excluded deliberately: it is legal on the wire and means "device
 * default", so it must fall through to the NEXT LEVEL rather than being treated
 * as a value. An unrecognised byte falls through the same way -- a malformed
 * attribute from a host must never reach `colourRgb`, which throws.
 *
 * THE 0x00 CHECK IS REDUNDANT TODAY AND KEPT ON PURPOSE. Deleting it changes no
 * behaviour, because 0x00 is not a key of `PALETTE_3279` either, so the second
 * line rejects it too. It stays because the two lines encode DIFFERENT rules that
 * happen to agree: this one is the architected meaning of X'00'
 * (pages.txt:3544-3546), the other is "unrenderable byte". If `PALETTE_3279` ever
 * gained a 0x00 entry -- a device-default swatch is an entirely plausible change
 * -- the protocol rule would silently invert into "0x00 paints that swatch",
 * overriding a field colour the host did set. `render.test.ts` stubs exactly that
 * future in and pins the rule, so this line is load-bearing under the change it
 * is defending against, even though no test can kill it today.
 *
 * Note this returns a value rather than a boolean, so callers can chain levels
 * with `??` and cannot accidentally use an unusable code.
 *
 * 0xF7 IS USABLE AND IS RETURNED UNCHANGED. The plan drafted `cell.fg === 0xf7 ?
 * Colour.WHITE : cell.fg`, and that is wrong twice over. (1) 0xF7 is itself an
 * architected colour identification, Neutral, distinct from White 0xFF -- Table
 * 4-7 lists both (pages.txt:3527-3541), palette.ts gives them distinct RGB on
 * purpose, and x3270 keeps them as separate slots HOST_COLOR_NEUTRAL_WHITE (7)
 * and HOST_COLOR_WHITE (15) (3270ds.h:313-328). (2) The rule the draft was
 * reaching for -- "If a single-plane or nonloadable character set is referenced,
 * the color defaults to the single color specified for the X'F7' value by Query
 * Reply (Color)" (pages.txt:3547-3549) -- resolves through OUR Query Reply
 * (Color), whose F7 entry is the identity pair F7->F7, exactly as x3270 sends
 * (`sf.c` `do_qr_color`, and Task 7's unit). So the correct single colour for F7
 * is F7. The manual's "defined as White for a display" (pages.txt:3542-3543)
 * describes what that phosphor LOOKS like, and is not an instruction to
 * substitute the other code. x3270 special-cases F7 nowhere.
 */
function usableColour(code: number | undefined): Colour3279 | undefined {
  if (code === undefined || code === 0x00) return undefined;
  return PALETTE_3279[code] !== undefined ? code : undefined;
}

export function resolve(snap: ScreenSnapshot, opts: ResolveOptions = {}): ResolvedCell[] {
  const mode3279 = opts.mode3279 ?? true;
  const codePage = opts.codePage ?? cp037;
  const size = snap.cells.length;

  // Which field governs each cell, precomputed as two parallel arrays: the
  // ADDRESS of that field's attribute byte, and the attribute VALUE. Both are
  // needed and neither substitutes for the other -- level 2 reads the extended
  // attributes stored ON the attribute cell, level 3 reads the attribute bits.
  //
  // Built by walking the field list, NOT by calling `fieldAt` per cell:
  // `fieldAt` scans backwards for an attribute and so is O(size) each, making a
  // full sweep O(size^2) -- ~3.7M operations on a 1920-cell buffer, on every
  // host record. The fields partition the ring, so this walk visits each cell
  // exactly once: O(size + fields) overall. Same reasoning as
  // `Screen.forEachCellWithField` and x3270's `current_fa` tracking
  // (ctlr.c:1809-1816).
  //
  // Int16Array will not do for the addresses: an address can exceed 32767 on a
  // large alternate screen size, and -1 must stay distinguishable. Int32Array is
  // exact for any buffer. `attrOf` holds a byte, so Uint8Array suffices, and
  // 0x00 is a legitimate attribute value (x3270's `START_FIELD(0)` for an SFE
  // with no 0xC0 pair, ctlr.c:1883-1885) -- which is why "no field" is signalled
  // by `attrAddrOf[i] < 0` and never by `attrOf[i] === 0`.
  const attrAddrOf = new Int32Array(size).fill(-1);
  const attrOf = new Uint8Array(size);
  for (const f of snap.fields) {
    // From the attribute byte through the field's data: `length + 1` cells, so
    // the FA cell is governed by its own field. That is what makes the FA
    // position resolve to its own extended colour, matching x3270's
    // `calc_attrs(baddr, baddr, fa)` (c3270/screen.c:1451). It also makes the
    // wrap-around case fall out: the last field's run continues past the end of
    // the buffer to cell 0, so cells before the first attribute are owned by it.
    //
    // No overlap check, and none is needed: `Screen.makeField` computes `length`
    // by scanning forward to the next attribute, so the runs TILE the ring
    // exactly -- every cell is claimed once and only once. Adding an
    // `if (attrAddrOf[a] < 0)` guard is therefore a no-op, which mutation testing
    // confirmed by leaving every test passing; a brute-force check over 400
    // random layouts (768,000 assignments) found zero double-claims. Unconditional
    // assignment is the honest expression of a partition.
    let a = f.attrAddr;
    for (let n = 0; n <= f.length; n++) {
      attrAddrOf[a] = f.attrAddr;
      attrOf[a] = f.attr;
      a = a + 1 === size ? 0 : a + 1;
    }
  }

  // Which cells ARE field attributes. A Set rather than
  // `snap.fields.some(f => f.attrAddr === i)` in the loop: that is O(fields) per
  // cell, ~192,000 comparisons on a 1920-cell screen with 100 fields, per
  // redraw.
  const attrPositions = new Set(snap.fields.map((f) => f.attrAddr));

  const out: ResolvedCell[] = new Array(size);
  for (let i = 0; i < size; i++) {
    const cell = snap.cells[i]!;
    const attrAddr = attrAddrOf[i]!;
    // An unformatted buffer has no field: attribute 0x00 (unprotected, normal)
    // is what the base map should see, and `field` stays undefined so level 2 is
    // skipped. x3270 reaches the same place with its `fa` initialised to 0.
    const field = attrAddr >= 0 ? snap.cells[attrAddr]! : undefined;
    const attr = attrAddr >= 0 ? attrOf[i]! : 0x00;

    // The four levels, per property. `usableColour` returning undefined for both
    // 0x00 and a malformed byte is what makes `??` express the fall-through.
    const fg = mode3279
      ? usableColour(cell.fg) ?? usableColour(field?.fg) ?? defaultColour(attr)
      : Colour.GREEN;
    const bg = mode3279
      ? usableColour(cell.bg) ?? usableColour(field?.bg) ?? Colour.NEUTRAL_BLACK
      : Colour.NEUTRAL_BLACK;

    // Highlighting takes the same two-level fallback and is NOT gated on
    // mode3279 -- blink, reverse and underscore are things a monochrome 3278
    // does, and x3270 computes gr outside its colour block (c3270/screen.c:1166,
    // after the `if (!mode3279 || ...)` branch closes). XAH.DEFAULT being 0x00
    // means "the default action of the device" (pages.txt:10329-10331), i.e. no
    // highlighting, which is why an absent gr and an explicit 0x00 can share the
    // same fall-through.
    const gr = (cell.gr ?? 0x00) !== 0x00 ? cell.gr! : (field?.gr ?? XAH.DEFAULT);

    out[i] = {
      // A field attribute position "displays as a blank" and holds no character
      // (Screen.setFieldAttribute nulls it), and a null is a space.
      text: attrPositions.has(i) || cell.ebcdic === 0x00 ? ' ' : codePage.toUnicode(cell.ebcdic),
      fg,
      bg,
      // Equality, not a bit test: highlighting is a one-of VALUE ("the field can
      // have only one highlighting property ... such as blink or reverse video
      // but not both", pages.txt:3472-3473), unlike x3270's internal GR_* bit
      // field, which is its own compressed form of the same one-of.
      blink: gr === XAH.BLINK,
      reverse: gr === XAH.REVERSE,
      underscore: gr === XAH.UNDERSCORE,
      intensify: gr === XAH.INTENSIFY,
      hidden: (attr & FA.INTENSITY) === FA.INT_ZERO_NSEL,
    };
  }
  return out;
}
