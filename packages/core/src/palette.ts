/**
 * The 3279 colour palette: sixteen architected colour identifications and the
 * RGB each one renders as.
 *
 * IN CORE, NOT IN A FRONT END, deliberately. The TUI quantises these to whatever
 * the terminal supports, the GUI will fill canvas cells with them, and a web
 * front end will emit them as CSS. One table, three consumers.
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
 * uses muted, named-CSS-ish colours: e.g. blue is `0x1e90ff` (dodger blue),
 * turquoise is `0x00ffff`, black is `0x2f4f4f` (dark slate grey — x3270's own
 * comment there reads "alas, this may be gray"). Measured against a standard
 * 16-colour ANSI palette, x3270's blue and turquoise both quantise to the
 * same slot, collapsing two of the seven base colours into one. Task 10
 * (terminal quantisation) depends on all seven base colours staying visually
 * distinct at both 16 and 256 colours, so this table instead uses saturated
 * primaries/secondaries (pure red, green, blue, cyan, magenta, yellow, plus
 * black and white) that survive quantisation at both depths. These are a
 * presentation choice, not architecture: the manual specifies which colour
 * each code IS, not its exact chromaticity, and a real 3279's phosphors
 * matched none of these precisely — ours or x3270's.
 *
 * All sixteen RGB triples are pairwise distinct (palette.test.ts), so no two
 * architecturally-different colour identifications alias to the same pixel.
 */

/** The seven base 3279 colours, by architected code. Table 4-7. */
export const Colour = {
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

/** A 3279 colour identification, 0xF0-0xFF. */
export type Colour3279 = number;

export const COLOUR_NAMES: Readonly<Record<number, string>> = Object.freeze({
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

/** RGB for a colour identification. Throws rather than guessing. */
export function colourRgb(code: Colour3279): Rgb {
  const rgb = PALETTE_3279[code];
  if (rgb === undefined) {
    throw new RangeError(`0x${code.toString(16)} is not a 3279 colour (expected 0xF0-0xFF)`);
  }
  return rgb;
}
