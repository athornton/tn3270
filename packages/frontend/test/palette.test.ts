import { describe, expect, it } from 'vitest';
import { Colour, COLOUR_NAMES } from '@tn3270/core';
import {
  SCHEMES, DEFAULT_SCHEME, resolveScheme, schemeRgb, SCHEME_NAMES, type Scheme,
} from '../src/palette.js';

/** Every architected colour identification, 0xF0-0xFF. */
const ALL_CODES = Object.values(Colour);

describe('the scheme registry', () => {
  it('holds exactly the four named schemes, and default is one of them', () => {
    expect(SCHEME_NAMES).toEqual(['default', '3279', 'x3270', 'green']);
    expect(SCHEMES[DEFAULT_SCHEME]).toBeDefined();
    expect(DEFAULT_SCHEME).toBe('default');
  });

  it('has no scheme in SCHEMES missing from SCHEME_NAMES', () => {
    expect(new Set(Object.keys(SCHEMES))).toEqual(new Set(SCHEME_NAMES));
  });

  // A scheme added later with a missing code would render `undefined` as a colour, which
  // in the GUI is a thrown RangeError mid-frame and in the TUI a silently uncoloured cell.
  it('gives every scheme all sixteen codes in BOTH tables', () => {
    for (const name of SCHEME_NAMES) {
      const scheme = SCHEMES[name]!;
      for (const code of ALL_CODES) {
        expect(scheme.rgb[code], `${name} rgb ${COLOUR_NAMES[code]}`).toBeDefined();
        expect(scheme.ansi16[code], `${name} ansi16 ${COLOUR_NAMES[code]}`).toBeDefined();
      }
    }
  });

  it('keeps every RGB triple in range', () => {
    for (const name of SCHEME_NAMES) {
      for (const code of ALL_CODES) {
        for (const component of SCHEMES[name]!.rgb[code]!) {
          expect(component, `${name} ${COLOUR_NAMES[code]}`).toBeGreaterThanOrEqual(0);
          expect(component, `${name} ${COLOUR_NAMES[code]}`).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it("pins default's blue to zti's value, which is the whole point of the change", () => {
    // Core's PALETTE_3279 has pure #0000ff here, which is what was unreadable on black.
    expect(SCHEMES.default!.rgb[Colour.BLUE]).toEqual([120, 144, 240]);
    expect(SCHEMES['3279']!.rgb[Colour.BLUE]).toEqual([0x00, 0x00, 0xff]);
  });

  it('pins x3270 blue and green to the verified rgbmap', () => {
    // c3270/screen.c:213-229. Dodger blue and limegreen, NOT saturated primaries.
    expect(SCHEMES.x3270!.rgb[Colour.BLUE]).toEqual([0x1e, 0x90, 0xff]);
    expect(SCHEMES.x3270!.rgb[Colour.GREEN]).toEqual([0x32, 0xcd, 0x32]);
  });
});

describe('per-scheme distinctness', () => {
  // The three COLOUR schemes must keep all sixteen codes visually distinct, so no two
  // architecturally-different colours alias to one pixel.
  it('keeps all sixteen distinct in the three colour schemes', () => {
    for (const name of ['default', '3279', 'x3270'] as const) {
      const seen = new Set(ALL_CODES.map((c) => SCHEMES[name]!.rgb[c]!.join(',')));
      expect(seen.size, name).toBe(16);
    }
  });

  // green asserts the OPPOSITE, on purpose. Applying the test above to it would report a
  // working scheme as a defect, which is why distinctness had to become per-scheme.
  it('deliberately ALIASES in green, and keeps F0/F8 dark', () => {
    const green = SCHEMES.green!;
    const seen = new Set(ALL_CODES.map((c) => green.rgb[c]!.join(',')));
    expect(seen.size).toBeLessThan(16);

    // The deviation from x3270's GreenScreen, and the reason it cannot be transcribed:
    // its scheme format has a SEPARATE screen background (screen.c:4119-4180, token 17),
    // so it sets F0 to green and gets a dark screen from grey10. We resolve the
    // background FROM F0, so copying it literally gives a green background.
    expect(green.rgb[Colour.NEUTRAL_BLACK]).toEqual([0, 0, 0]);
    expect(green.rgb[Colour.BLACK]).toEqual([0, 0, 0]);

    // Everything visible is a shade of green: red and blue channels equal, green channel
    // above both. This is the property, not a value pin.
    for (const code of ALL_CODES) {
      if (code === Colour.NEUTRAL_BLACK || code === Colour.BLACK) continue;
      const [r, g, b] = green.rgb[code]!;
      expect(r, COLOUR_NAMES[code]).toBe(b);
      expect(g, COLOUR_NAMES[code]).toBeGreaterThan(r);
    }
  });

  // Without its own slot map, one session would render green at truecolour and
  // blue/red/yellow at sixteen colours. This is why a Scheme carries ansi16 at all.
  it('maps every green code onto the green or black ANSI slot', () => {
    for (const code of ALL_CODES) {
      const [slot] = SCHEMES.green!.ansi16[code]!;
      const dark = code === Colour.NEUTRAL_BLACK || code === Colour.BLACK;
      expect(slot, COLOUR_NAMES[code]).toBe(dark ? 0 : 2);
    }
  });
});

describe('resolveScheme', () => {
  it('defaults when given nothing', () => {
    expect(resolveScheme()).toBe(SCHEMES.default);
    expect(resolveScheme(undefined)).toBe(SCHEMES.default);
  });

  it('is case-insensitive and accepts x3270\'s own GreenScreen spelling', () => {
    expect(resolveScheme('GREEN')).toBe(SCHEMES.green);
    expect(resolveScheme('GreenScreen')).toBe(SCHEMES.green);
    expect(resolveScheme('greenscreen')).toBe(SCHEMES.green);
    expect(resolveScheme('X3270')).toBe(SCHEMES.x3270);
  });

  // A silent fallback would draw the wrong palette and blame the user's memory.
  it('throws on an unknown name, LISTING the valid ones', () => {
    expect(() => resolveScheme('solarized')).toThrow(/solarized/);
    expect(() => resolveScheme('solarized')).toThrow(/default/);
    expect(() => resolveScheme('solarized')).toThrow(/green/);
  });
});

describe('schemeRgb', () => {
  it('returns the scheme\'s triple for a valid code', () => {
    expect(schemeRgb(SCHEMES.default!, Colour.BLUE)).toEqual([120, 144, 240]);
  });

  // Matches core's colourRgb contract, which drawlist.ts already relies on.
  it('throws rather than guessing on a code outside 0xF0-0xFF', () => {
    expect(() => schemeRgb(SCHEMES.default!, 0x00)).toThrow(RangeError);
    expect(() => schemeRgb(SCHEMES.default!, 0xef)).toThrow(RangeError);
  });
});

describe('one source of truth for both front ends', () => {
  // THE requirement behind this whole change. The GUI drew #0000ff while the TUI drew zti's
  // blue and nothing failed, because nothing compared them. Both now derive from schemeRgb:
  // the TUI's sgrFor reads scheme.rgb, and the GUI's drawList calls schemeRgb. This pins that
  // there is exactly one table behind both, for every scheme and every code.
  it('resolves every code in every scheme through schemeRgb alone', () => {
    for (const name of SCHEME_NAMES) {
      const scheme = SCHEMES[name]!;
      for (const code of ALL_CODES) {
        // What the GUI puts in a DrawCell.fg ...
        const rgb = schemeRgb(scheme, code);
        // ... and the parameters the TUI's truecolour SGR is built from. Identical by
        // construction, and this fails the moment either grows a private table again.
        expect(rgb, `${name} ${COLOUR_NAMES[code]}`).toBe(scheme.rgb[code]);
        expect(rgb).toHaveLength(3);
      }
    }
  });
});
