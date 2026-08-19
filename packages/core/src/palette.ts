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
 * Table 4-7 (GA23-0059 p. 4-19/4-20, pages.txt:3524-3541) prints `X'FB'`
 * TWICE, for both Black and Purple, and renders the second Neutral (F7) as
 * `X'F?'`. The codes are in fact contiguous 0xF0-0xFF, so Black is 0xF8 and
 * Purple 0xFB — confirmed two ways: (1) the same table is reprinted intact in
 * Chapter 6's "Query Reply (Color)" section (p. 221, pages.txt:9244-9260),
 * where line 9253 reads `Black X'F8'`; and (2) x3270's include/3270ds.h:
 * 313-328, whose HOST_COLOR_* run 0..15 in the same order (HOST_COLOR_BLACK
 * == 8, HOST_COLOR_PURPLE == 11). palette.test.ts pins both of the damaged
 * entries.
 *
 * RGB values follow x3270's default 3279 rendering. They are a presentation
 * choice, not architecture: the manual specifies which colour each code IS, not
 * its exact chromaticity, and a real 3279's phosphors matched none of these
 * precisely.
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
  0xf0: [0x00, 0x00, 0x00],
  0xf1: [0x00, 0x00, 0xff],
  0xf2: [0xff, 0x00, 0x00],
  0xf3: [0xff, 0x00, 0xff],
  0xf4: [0x00, 0xff, 0x00],
  0xf5: [0x00, 0xff, 0xff],
  0xf6: [0xff, 0xff, 0x00],
  0xf7: [0xff, 0xff, 0xff],
  0xf8: [0x00, 0x00, 0x00],
  0xf9: [0x00, 0x00, 0x80],
  0xfa: [0xff, 0x80, 0x00],
  0xfb: [0x80, 0x00, 0xff],
  0xfc: [0x80, 0xff, 0x80],
  0xfd: [0x80, 0xff, 0xff],
  0xfe: [0x80, 0x80, 0x80],
  0xff: [0xff, 0xff, 0xff],
});

/** RGB for a colour identification. Throws rather than guessing. */
export function colourRgb(code: Colour3279): Rgb {
  const rgb = PALETTE_3279[code];
  if (rgb === undefined) {
    throw new RangeError(`0x${code.toString(16)} is not a 3279 colour (expected 0xF0-0xFF)`);
  }
  return rgb;
}
