import { type Colour3279, type Rgb, PALETTE_3279 } from '@tn3270/core';

/**
 * The display palettes every front end draws from, and the ANSI slots they quantise to.
 *
 * ## WHY THIS IS NOT CORE'S TABLE
 *
 * Core's `PALETTE_3279` answers "which colour IS code F1" — the architected meaning, pinned
 * to GA23-0059 with notes on the OCR damage in its tables. It is not a presentation choice,
 * and its own comment says the RGB values are "OUR OWN CHOICE, DELIBERATELY NOT X3270'S":
 * saturated primaries, picked so that seven base colours survive quantisation to sixteen
 * ANSI slots. On a black background its pure `#0000ff` blue is close to illegible, which is
 * what a user reported from the Electron GUI on 2026-09-14. The GUI had been drawing from
 * core while the TUI had quietly had its own gentler table since it shipped.
 *
 * So this module owns presentation for ALL front ends, and core keeps the meaning. Core's
 * table is not orphaned by that: it is the `3279` scheme's data.
 *
 * ## A SCHEME CARRIES ITS SLOT MAP, NOT JUST RGB
 *
 * `green` is what forces this, and the RGB-only shape looks sufficient right up to the
 * moment it fails: with one shared slot map, a green session would render green at
 * truecolour and blue/red/yellow on a sixteen-colour terminal. The slot map is part of a
 * scheme's identity, which is why it is scheme data here rather than the TUI's private
 * `ANSI_16` table.
 *
 * Quantisation ITSELF stays in the TUI — `detectDepth`, the 6x6x6 cube, the SGR strings.
 * That is genuinely terminal-specific. Which slot a colour belongs in is not.
 *
 * ## WHY THE SLOTS ARE A TABLE AND NOT NEAREST-RGB
 *
 * Nearest-RGB made the palette responsible for sixteen-colour distinctness, and with any
 * pleasant palette blue and turquoise both land nearest ANSI cyan and collapse into one
 * slot — measured for both references: x3270's `#1e90ff` and zti's `(120,144,240)` each
 * quantise to bright cyan, exactly like their turquoise. Deciding the slot explicitly
 * separates "what colour is this" from "which of sixteen slots does it occupy".
 */

/** `[ansiIndex, bright]`. */
export type Slot = readonly [number, boolean];

export interface Scheme {
  readonly rgb: Readonly<Record<number, Rgb>>;
  readonly ansi16: Readonly<Record<number, Slot>>;
}

/**
 * The slot map the three COLOUR schemes share.
 *
 * Keyed by colour code rather than derived from RGB, so it is correct for all three
 * regardless of how saturated their values are.
 */
const COLOUR_SLOTS: Readonly<Record<number, Slot>> = Object.freeze({
  0xf0: [0, false], 0xf1: [4, true],  0xf2: [1, true],  0xf3: [5, true],
  0xf4: [2, true],  0xf5: [6, true],  0xf6: [3, true],  0xf7: [7, true],
  0xf8: [0, false], 0xf9: [4, false], 0xfa: [3, true],  0xfb: [5, false],
  0xfc: [2, true],  0xfd: [6, false], 0xfe: [7, false], 0xff: [7, true],
});

/**
 * `default`: zti's colours for F0-F7, x3270's for F8-FF.
 *
 * F0-F7 are **zti's own values**, read from `tnz/zti.py:2813-2820` where they are declared
 * in curses' 0-1000 scale and converted here to 0-255 (`green_rgb = (141, 847, 188)` ->
 * `(36, 216, 48)`). Independently confirmed on the wire: a captured zti session emits
 * `38;2;35;215;47` for green, `38;2;120;144;239` for blue and `38;2;87;239;239` for
 * turquoise, which is this table to within rounding.
 *
 * **zti defines only those eight**, because it advertises only F1-F7 in its Color Query
 * Reply (`tnz/tnz.py:4329-4340`, `NP = 8`) and so is never sent the rest. We advertise all
 * sixteen, so F8-FF come from x3270's `rgbmap` (`c3270/screen.c:213-229`).
 *
 * NOTE F0 NEUTRAL-BLACK IS PURE BLACK HERE, as it is in zti; core keeps `0x1a1a1a`. This is
 * why nothing needs a divergence to get a black-looking background: the default background
 * resolves to F0, and F0 renders black.
 */
const DEFAULT_RGB: Readonly<Record<number, Rgb>> = Object.freeze({
  0xf0: [0, 0, 0],          // zti: neutral black, PURE black
  0xf1: [120, 144, 240],    // zti blue
  0xf2: [240, 24, 24],      // zti red
  0xf3: [255, 0, 255],      // zti pink
  0xf4: [36, 216, 48],      // zti green
  0xf5: [88, 240, 240],     // zti turquoise
  0xf6: [255, 255, 0],      // zti yellow
  0xf7: [255, 255, 255],    // zti neutral white
  0xf8: [47, 79, 79],       // x3270 black (0x2f4f4f)
  0xf9: [0, 0, 205],        // x3270 deep blue
  0xfa: [255, 165, 0],      // x3270 orange
  0xfb: [160, 32, 240],     // x3270 purple
  0xfc: [144, 238, 144],    // x3270 pale green
  0xfd: [150, 205, 205],    // x3270 pale turquoise
  0xfe: [119, 136, 153],    // x3270 grey
  0xff: [245, 245, 245],    // x3270 white
});

/**
 * `x3270`: that emulator's `rgbmap` in full, `c3270/screen.c:213-229`.
 *
 * For someone comparing our output against x3270, or simply used to its look. Note blue is
 * dodger blue and green is limegreen — x3270 is not saturated either. `default`'s F8-FF are
 * these same values, so only F0-F7 differ between the two.
 */
const X3270_RGB: Readonly<Record<number, Rgb>> = Object.freeze({
  0xf0: [0x1a, 0x1a, 0x1a], // neutral black
  0xf1: [0x1e, 0x90, 0xff], // blue (dodger blue)
  0xf2: [0xff, 0x00, 0x00], // red
  0xf3: [0xff, 0x00, 0xff], // pink
  0xf4: [0x32, 0xcd, 0x32], // green (limegreen)
  0xf5: [0x00, 0xff, 0xff], // turquoise
  0xf6: [0xff, 0xff, 0x00], // yellow
  0xf7: [0xff, 0xff, 0xff], // neutral white
  0xf8: [0x2f, 0x4f, 0x4f], // black ("alas, this may be gray" -- x3270's own comment)
  0xf9: [0x00, 0x00, 0xcd], // deep blue
  0xfa: [0xff, 0xa5, 0x00], // orange
  0xfb: [0xa0, 0x20, 0xf0], // purple
  0xfc: [0x90, 0xee, 0x90], // pale green
  0xfd: [0x96, 0xcd, 0xcd], // pale turquoise
  0xfe: [0x77, 0x88, 0x99], // grey
  0xff: [0xf5, 0xf5, 0xf5], // white
});

/** x3270's GreenScreen shades: `#21a021` normal, `lime` for emphasis. */
const GREEN: Rgb = [0x21, 0xa0, 0x21];
const LIME: Rgb = [0x00, 0xff, 0x00];
const DARK: Rgb = [0, 0, 0];

/**
 * `green`: a monochrome 3278, which is the only "authentic" option here.
 *
 * A 3278 has a green phosphor and no colour at all — colour is a 3279 feature — and we
 * advertise `IBM-3278-2-E`. x3270 ships this as `GreenScreen` (`x3270/fb-x3270:98`).
 *
 * ## IT CANNOT BE TRANSCRIBED FROM X3270, AND THE REASON IS STRUCTURAL
 *
 * x3270's scheme format has a SEPARATE screen background. Verified in
 * `xfer_color_scheme` (`x3270/screen.c:4119-4180`): tokens 0-15 are the IBM colours, 16 is a
 * fallback, **17 is the screen background**, 18 select background, 19-22 attribute colours.
 * So `GreenScreen` sets F0 neutral-black to `#21a021` — green — and gets its dark screen
 * from `grey10` at token 17.
 *
 * **We resolve the background FROM F0**, so copying that table literally would give us a
 * green background. F0 and F8 therefore stay black here. That is a deliberate deviation,
 * not a transcription slip, and `palette.test.ts` pins it.
 *
 * Which codes get LIME follows x3270's own assignment — F2, F7 and FF — i.e. the ones a
 * host uses for emphasis.
 */
const GREEN_RGB: Readonly<Record<number, Rgb>> = Object.freeze({
  0xf0: DARK,  0xf1: GREEN, 0xf2: LIME,  0xf3: GREEN,
  0xf4: GREEN, 0xf5: GREEN, 0xf6: GREEN, 0xf7: LIME,
  0xf8: DARK,  0xf9: GREEN, 0xfa: GREEN, 0xfb: GREEN,
  0xfc: GREEN, 0xfd: GREEN, 0xfe: GREEN, 0xff: LIME,
});

/**
 * Green's own slots: everything visible on ANSI green, the emphasis codes bright.
 *
 * Sharing `COLOUR_SLOTS` would make a sixteen-colour terminal render blue and red from a
 * scheme whose whole point is that it does not have any.
 */
const GREEN_SLOTS: Readonly<Record<number, Slot>> = Object.freeze({
  0xf0: [0, false], 0xf1: [2, false], 0xf2: [2, true],  0xf3: [2, false],
  0xf4: [2, false], 0xf5: [2, false], 0xf6: [2, false], 0xf7: [2, true],
  0xf8: [0, false], 0xf9: [2, false], 0xfa: [2, false], 0xfb: [2, false],
  0xfc: [2, false], 0xfd: [2, false], 0xfe: [2, false], 0xff: [2, true],
});

export const SCHEMES: Readonly<Record<string, Scheme>> = Object.freeze({
  default: Object.freeze({ rgb: DEFAULT_RGB, ansi16: COLOUR_SLOTS }),
  // Core's architected table, which is what makes it a scheme rather than an orphan.
  '3279': Object.freeze({ rgb: PALETTE_3279, ansi16: COLOUR_SLOTS }),
  x3270: Object.freeze({ rgb: X3270_RGB, ansi16: COLOUR_SLOTS }),
  green: Object.freeze({ rgb: GREEN_RGB, ansi16: GREEN_SLOTS }),
});

/**
 * Declaration order, which is also the order the usage text lists them.
 *
 * NOT `Object.keys(SCHEMES)`: the key `'3279'` is a canonical numeric string, and JS
 * enumerates integer-like keys in ascending numeric order BEFORE other string keys
 * regardless of insertion order -- `Object.keys` would yield `['3279', 'default', ...]`.
 * Measured, not theoretical: this is exactly the failure the first test run hit.
 */
export const SCHEME_NAMES: readonly string[] = Object.freeze(['default', '3279', 'x3270', 'green']);

export const DEFAULT_SCHEME = 'default';

/**
 * x3270's spelling for the monochrome scheme, accepted so a user coming from it can type
 * what they already know.
 */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({ greenscreen: 'green' });

/**
 * A scheme by name, defaulting to the readable one.
 *
 * THROWS on an unknown name rather than falling back. A silent fallback would draw the
 * wrong palette and leave the user doubting what they typed.
 */
export function resolveScheme(name?: string): Scheme {
  if (name === undefined) return SCHEMES[DEFAULT_SCHEME]!;
  const key = name.toLowerCase();
  const resolved = SCHEMES[ALIASES[key] ?? key];
  if (resolved === undefined) {
    throw new RangeError(
      `unknown colour scheme ${JSON.stringify(name)}; use one of ${SCHEME_NAMES.join(', ')}`,
    );
  }
  return resolved;
}

/**
 * RGB for a colour identification within a scheme. Throws rather than guessing, matching
 * core's `colourRgb` contract, which `drawlist.ts` already depends on.
 */
export function schemeRgb(scheme: Scheme, code: Colour3279): Rgb {
  const rgb = scheme.rgb[code];
  if (rgb === undefined) {
    throw new RangeError(`0x${code.toString(16)} is not a 3279 colour (expected 0xF0-0xFF)`);
  }
  return rgb;
}
