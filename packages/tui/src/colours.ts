/**
 * Colour depth detection and quantisation of the 3279 palette to ANSI.
 *
 * ## DETECTION USES `tput`, NOT NODE'S BUILTIN, AND THAT IS A MEASURED CHOICE
 *
 * `tty.WriteStream.getColorDepth` is TERM-string heuristics, not terminfo, and it
 * is wrong in exactly the cases this feature exists to detect. Measured on the
 * development box, Node v26.7.0.
 *
 * `getColorDepth` returns BITS of depth, not a colour count — documented as 1, 4,
 * 8 or 24, and confirmed here at both ends (`TERM=dumb` gives 1, and
 * `COLORTERM=truecolor` gives 24). So its `4` below means sixteen colours. The
 * raw return is shown first, with the count it implies in brackets:
 *
 *   terminal            tput        getColorDepth      truth
 *   xterm-256color      256         8  [256]           256
 *   screen-256color     256         4  [16]   <-- wrong  256
 *   xterm-direct        16777216    4  [16]   <-- wrong  16777216
 *   xterm               8           4  [16]   <-- wrong  8
 *   vt100               -1          4  [16]   <-- wrong  none
 *
 * `tput` is right on all five; `getColorDepth` is right on one. So anything under
 * GNU screen would lose colour, a direct-colour terminal would be capped at 16,
 * and a vt100 would be sent colour it cannot show. The `terminfo` npm package does
 * parse the real binary database, but it is v0.1.1, last published 2016, one
 * maintainer -- not a dependency worth taking against a project policy of no deps
 * beyond node:net and node:tls. `tput` is POSIX and ships with the database it
 * reads.
 *
 * Detection is a DEFAULT, not a verdict: terminfo entries are sometimes
 * conservative, and the monochrome path has to be testable on a colour terminal.
 * Hence the override.
 */

import { execFileSync } from 'node:child_process';
import { type Colour3279 } from '@tn3270/core';

/**
 * ## THE TUI HAS ITS OWN PALETTE, AND IT IS ZTI'S
 *
 * Core's `PALETTE_3279` stays as it is -- it is the shared model, and a future GUI or
 * web front end may want different values again. This table is the TUI's presentation
 * choice, on the user's call: zti's colours are more pleasant in a terminal than core's
 * saturated primaries, and zti is the client being compared against.
 *
 * F0-F7 are **zti's own values**, read from `tnz/zti.py:2813-2820` where they are
 * declared in curses' 0-1000 scale and converted here to 0-255 (`green_rgb =
 * (141, 847, 188)` -> `(36, 216, 48)`). Independently confirmed on the wire: a captured
 * zti session emits `38;2;35;215;47` for green, `38;2;120;144;239` for blue and
 * `38;2;87;239;239` for turquoise, which is this table to within rounding.
 *
 * **zti defines only these eight**, because it advertises only F1-F7 in its Color Query
 * Reply (`tnz/tnz.py:4329-4340`, `NP = 8`) and so is never sent the rest. We advertise
 * all sixteen, so F8-FF have to come from somewhere: they are **x3270's** `rgbmap`
 * (`c3270/screen.c:213-229`), the other reference implementation.
 *
 * NOTE F0 NEUTRAL-BLACK IS PURE BLACK HERE, as it is in zti. Core keeps 0x1a1a1a for
 * it. This is why core needs no divergence to give a black-looking background: the
 * default background resolves to F0, and F0 renders black.
 */
const TUI_PALETTE: Readonly<Record<number, readonly [number, number, number]>> = Object.freeze({
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
 * The 16-colour slot for each 3279 colour, as an explicit table.
 *
 * ## WHY THIS IS A TABLE AND NOT NEAREST-RGB
 *
 * Nearest-RGB matching made the PALETTE responsible for 16-colour distinctness, which
 * is why core's values are saturated primaries: with any realistic palette, blue and
 * turquoise both land nearest ANSI cyan and collapse into one slot. Measured, for both
 * references -- x3270's `#1e90ff` blue and zti's `(120,144,240)` blue each quantise to
 * bright cyan, exactly like their turquoise.
 *
 * Deciding the slot explicitly separates the two questions -- what colour IS this
 * (above) versus which of sixteen slots does it occupy (here) -- so a pleasant palette
 * no longer costs correctness on a 16-colour terminal. `[ansiIndex, bright]`.
 */
const ANSI_16: Readonly<Record<number, readonly [number, boolean]>> = Object.freeze({
  0xf0: [0, false], 0xf1: [4, true],  0xf2: [1, true],  0xf3: [5, true],
  0xf4: [2, true],  0xf5: [6, true],  0xf6: [3, true],  0xf7: [7, true],
  0xf8: [0, false], 0xf9: [4, false], 0xfa: [3, true],  0xfb: [5, false],
  0xfc: [2, true],  0xfd: [6, false], 0xfe: [7, false], 0xff: [7, true],
});

/** Colours the terminal can show. 0 means monochrome. */
export type Depth = 0 | 8 | 16 | 256 | 16777216;

export interface DetectOptions {
  /** `--colors`. Wins over everything, including COLORTERM. */
  override?: Depth;
  env?: Record<string, string | undefined>;
  /** Injected for testing; defaults to shelling out to tput. */
  probe?: (term: string) => number;
}

/** `tput -T<term> colors`, or -1 if that cannot be determined. */
function tputColors(term: string): number {
  const out = execFileSync('tput', ['-T', term, 'colors'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const n = Number.parseInt(out.trim(), 10);
  return Number.isNaN(n) ? -1 : n;
}

function quantiseDepth(colors: number): Depth {
  if (colors >= 16777216) return 16777216;
  if (colors >= 256) return 256;
  if (colors >= 16) return 16;
  if (colors >= 8) return 8;
  return 0;
}

export function detectDepth(opts: DetectOptions = {}): Depth {
  if (opts.override !== undefined) return opts.override;

  const env = opts.env ?? process.env;
  const term = env.TERM ?? '';
  const probe = opts.probe ?? tputColors;

  let depth: Depth = 0;
  try {
    depth = quantiseDepth(probe(term));
  } catch {
    // tput missing, or the terminal is unknown. Monochrome is the safe answer:
    // it renders correctly everywhere, where a wrong guess at 256 emits escape
    // sequences as literal text all over a user's screen.
    depth = 0;
  }

  // COLORTERM can only RAISE the result. A truecolor terminal often advertises
  // TERM=xterm-256color and signals 24-bit only here.
  //
  // "Only raises" is enforced by the SHAPE of this branch, not by the `depth <`
  // clause: the sole assignment is to the maximum depth, and any COLORTERM value
  // other than these two is ignored entirely. The `depth <` clause is therefore
  // REDUNDANT -- deleting it leaves all tests green, verified by mutation. It is
  // kept as a guard for a future edit that maps some COLORTERM value to a LOWER
  // depth, at which point it becomes load-bearing. Do not write a test claiming
  // to pin it; no input can distinguish its presence. What is testable, and is
  // tested, is that a present-but-smaller COLORTERM (`256color`, `8`) never
  // lowers a higher terminfo answer.
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if ((colorterm === 'truecolor' || colorterm === '24bit') && depth < 16777216) {
    depth = 16777216;
  }
  return depth;
}

/** The 6x6x6 cube index for an RGB triple. */
function cube256(r: number, g: number, b: number): number {
  const step = (v: number): number => Math.round((v / 255) * 5);
  return 16 + 36 * step(r) + 6 * step(g) + step(b);
}

/**
 * The SGR parameter string for one colour, e.g. `38;5;46`. Empty when monochrome.
 * The caller wraps it in `\x1b[...m`.
 */
export function sgrFor(code: Colour3279, depth: Depth, which: 'fg' | 'bg'): string {
  if (depth === 0) return '';
  const rgb = TUI_PALETTE[code];
  const slot = ANSI_16[code];
  if (rgb === undefined || slot === undefined) {
    // render.ts should never hand us an invalid code, but a throw here would take
    // down the whole screen for one bad cell.
    return '';
  }
  const [r, g, b] = rgb;

  if (depth === 16777216) {
    return `${which === 'fg' ? 38 : 48};2;${r};${g};${b}`;
  }
  if (depth === 256) {
    return `${which === 'fg' ? 38 : 48};5;${cube256(r, g, b)}`;
  }
  const [index, bright] = slot;
  if (depth === 16 && bright) {
    return String((which === 'fg' ? 90 : 100) + index);
  }
  return String((which === 'fg' ? 30 : 40) + index);
}
