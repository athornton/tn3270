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
import { colourRgb, type Colour3279 } from '@tn3270/core';

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
 * The eight ANSI colours, as RGB, for nearest-match at 8 and 16 colours.
 * Index is the ANSI colour number: 0 black, 1 red, 2 green, 3 yellow, 4 blue,
 * 5 magenta, 6 cyan, 7 white.
 */
const ANSI_8: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [170, 0, 0], [0, 170, 0], [170, 85, 0],
  [0, 0, 170], [170, 0, 170], [0, 170, 170], [170, 170, 170],
];

function nearestAnsi(r: number, g: number, b: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI_8.length; i++) {
    const [ar, ag, ab] = ANSI_8[i]!;
    // Squared Euclidean distance in RGB. Crude, but the 3279's palette is
    // saturated primaries and this separates all seven base colours -- which
    // colours.test.ts asserts rather than assumes.
    const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** Is this colour bright enough to want the 90-97 range at 16 colours? */
function isBright(r: number, g: number, b: number): boolean {
  return Math.max(r, g, b) > 170;
}

/**
 * The SGR parameter string for one colour, e.g. `38;5;46`. Empty when monochrome.
 * The caller wraps it in `\x1b[...m`.
 */
export function sgrFor(code: Colour3279, depth: Depth, which: 'fg' | 'bg'): string {
  if (depth === 0) return '';
  let rgb: readonly [number, number, number];
  try {
    rgb = colourRgb(code);
  } catch {
    // render.ts should never hand us an invalid code, but a throw here would
    // take down the whole screen for one bad cell.
    return '';
  }
  const [r, g, b] = rgb;

  if (depth === 16777216) {
    return `${which === 'fg' ? 38 : 48};2;${r};${g};${b}`;
  }
  if (depth === 256) {
    return `${which === 'fg' ? 38 : 48};5;${cube256(r, g, b)}`;
  }
  const base = nearestAnsi(r, g, b);
  if (depth === 16 && isBright(r, g, b)) {
    return String((which === 'fg' ? 90 : 100) + base);
  }
  return String((which === 'fg' ? 30 : 40) + base);
}
