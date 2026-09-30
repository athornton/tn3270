/**
 * The 3279 color palette: sixteen architected color identifications and the
 * RGB each one renders as.
 *
 * IN CORE BECAUSE IT IS THE ARCHITECTED MEANING, not because it is what gets drawn.
 * This table answers "which color IS code F1" and is pinned to GA23-0059 below. What a
 * front end actually paints comes from the scheme registry in `packages/frontend/palette.ts`,
 * where this table is the `3279` scheme's data — and where the READABLE default lives, since
 * the pure `#0000ff` blue below is close to illegible on black.
 *
 * An earlier version of this comment said the TUI quantised these values and the GUI would
 * fill cells with them. The first half was false from the day the TUI shipped its own table,
 * and the resulting drift is what a user reported on 2026-09-14: two front ends, two blues.
 *
 * ## THE MANUAL'S TABLE IS OCR-DAMAGED — DO NOT TRANSCRIBE IT LITERALLY
 *
 * Table 4-7 (GA23-0059 p. 4-20, pages.txt:3524-3541) prints `X'FB'` TWICE,
 * for both Black and Purple, and renders the second Neutral (F7) as `X'F?'`.
 * The codes are in fact contiguous 0xF0-0xFF, so Black is 0xF8 and Purple
 * 0xFB — confirmed two ways: (1) the same table is reprinted, undamaged, in
 * Chapter 6's "Query Reply (Color)" section (p. 6-37, pages.txt:9244-9260),
 * where line 9253 reads `Black X'F8'` — though that reprint went through the
 * same OCR pipeline, so it corroborates rather than independently confirms;
 * and (2) x3270's include/3270ds.h:313-328, whose HOST_COLOR_* run 0..15 in
 * the same order (HOST_COLOR_BLACK == 8, HOST_COLOR_PURPLE == 11), which
 * *is* an independent source. palette.test.ts pins both of the damaged
 * entries.
 *
 * ## THE RGB VALUES ARE OUR OWN CHOICE, DELIBERATELY NOT X3270'S
 *
 * x3270's own default 3279 rendering (c3270/screen.c:213-229, `rgbmap[16]`)
 * uses muted, named-CSS-ish colors: e.g. blue is `0x1e90ff` (dodger blue),
 * turquoise is `0x00ffff`, black is `0x2f4f4f` (dark slate grey — x3270's own
 * comment there reads "alas, this may be gray"). Measured against a standard
 * 16-color ANSI palette, x3270's blue and turquoise both quantise to the
 * same slot, collapsing two of the seven base colors into one. Task 10
 * (terminal quantisation) depends on all seven base colors staying visually
 * distinct at both 16 and 256 colors, so this table instead uses saturated
 * primaries/secondaries (pure red, green, blue, cyan, magenta, yellow, plus
 * black and white) that survive quantisation at both depths. These are a
 * presentation choice, not architecture: the manual specifies which color
 * each code IS, not its exact chromaticity, and a real 3279's phosphors
 * matched none of these precisely — ours or x3270's.
 *
 * All sixteen RGB triples are pairwise distinct (palette.test.ts), so no two
 * architecturally-different color identifications alias to the same pixel.
 */

/** The seven base 3279 colors, by architected code. Table 4-7. */
export const Color = {
  NEUTRAL_BLACK: 0xf0,
  BLUE: 0xf1,
  RED: 0xf2,
  PINK: 0xf3,
  GREEN: 0xf4,
  TURQUOISE: 0xf5,
  YELLOW: 0xf6,
  NEUTRAL_WHITE: 0xf7,
  BLACK: 0xf8,
  DEEP_BLUE: 0xf9,
  ORANGE: 0xfa,
  PURPLE: 0xfb,
  PALE_GREEN: 0xfc,
  PALE_TURQUOISE: 0xfd,
  GREY: 0xfe,
  WHITE: 0xff,
} as const;

/** A 3279 color identification, 0xF0-0xFF. */
export type Color3279 = number;

/**
 * `GREY` AND `'grey'` KEEP THE BRITISH SPELLING DELIBERATELY. DO NOT "FINISH" THE
 * AMERICANISATION HERE.
 *
 * Everything else in this repo was moved to US spellings on 2026-09-30, which leaves these two
 * looking like something the sweep missed. They are not: **`grey` is x3270's own canonical
 * spelling**, measured in its source rather than assumed —
 *
 *  - `Common/glue.c:1041-1042`: `{ "Grey", HOST_COLOR_GREY }` and then
 *    `{ "Gray", HOST_COLOR_GREY }, /* alias *\/` — x3270's own comment marks which is which.
 *  - `Common/see.c:310` and `Common/fprint_screen.c:118` both emit `grey`.
 *
 * These names are an INTERFACE to the reference implementation, not prose: this project is
 * conformance-tested against real s3270, and a name that appears in a trace or a comparison has
 * to match what x3270 writes. Americanising it would be a gratuitous divergence in the one place
 * where matching the reference is the whole point. The same reasoning is why the wire constants
 * elsewhere are never "tidied" — see `docs/live-testing.md` on conformance.
 */
export const COLOR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0xf0: 'neutral-black',
  0xf1: 'blue',
  0xf2: 'red',
  0xf3: 'pink',
  0xf4: 'green',
  0xf5: 'turquoise',
  0xf6: 'yellow',
  0xf7: 'neutral-white',
  0xf8: 'black',
  0xf9: 'deep-blue',
  0xfa: 'orange',
  0xfb: 'purple',
  0xfc: 'pale-green',
  0xfd: 'pale-turquoise',
  // x3270's spelling, not a missed rename. See the note above.
  0xfe: 'grey',
  0xff: 'white',
});

export type Rgb = readonly [number, number, number];

export const PALETTE_3279: Readonly<Record<number, Rgb>> = Object.freeze({
  // Neutral black/white and Black/White are architecturally distinct codes
  // (a host can choose either), so they get distinct RGB despite both being
  // "black-ish" or "white-ish" -- see the OCR-damage note above.
  0xf0: [0x1a, 0x1a, 0x1a], // neutral-black: near-black, not pure black
  0xf1: [0x00, 0x00, 0xff],
  0xf2: [0xff, 0x00, 0x00],
  0xf3: [0xff, 0x00, 0xff],
  0xf4: [0x00, 0xff, 0x00],
  0xf5: [0x00, 0xff, 0xff],
  0xf6: [0xff, 0xff, 0x00],
  0xf7: [0xe0, 0xe0, 0xe0], // neutral-white: near-white, not pure white
  0xf8: [0x00, 0x00, 0x00], // black: pure black
  0xf9: [0x00, 0x00, 0x80],
  0xfa: [0xff, 0x80, 0x00],
  0xfb: [0x80, 0x00, 0xff],
  0xfc: [0x80, 0xff, 0x80],
  0xfd: [0x80, 0xff, 0xff],
  0xfe: [0x80, 0x80, 0x80],
  0xff: [0xff, 0xff, 0xff], // white: pure white
});

/** RGB for a color identification. Throws rather than guessing. */
export function colorRgb(code: Color3279): Rgb {
  const rgb = PALETTE_3279[code];
  if (rgb === undefined) {
    throw new RangeError(`0x${code.toString(16)} is not a 3279 color (expected 0xF0-0xFF)`);
  }
  return rgb;
}
