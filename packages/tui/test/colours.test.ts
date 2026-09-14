import { describe, expect, it } from 'vitest';
import { Colour } from '@tn3270/core';
import { SCHEMES, resolveScheme } from '@tn3270/frontend';
import { detectDepth, sgrFor, type Depth } from '../src/colours.js';

const DEFAULT = SCHEMES.default!;

describe('detectDepth', () => {
  it('prefers an explicit override over everything', () => {
    expect(detectDepth({ override: 16, env: { TERM: 'xterm-direct' }, probe: () => 256 })).toBe(16);
    expect(detectDepth({ override: 0, env: { TERM: 'xterm-256color' }, probe: () => 256 })).toBe(0);
  });

  it('uses the terminfo probe when there is no override', () => {
    expect(detectDepth({ env: { TERM: 'xterm-256color' }, probe: () => 256 })).toBe(256);
    expect(detectDepth({ env: { TERM: 'xterm' }, probe: () => 8 })).toBe(8);
  });

  it('treats a failed probe as monochrome', () => {
    // tput exits non-zero on an unknown terminal and prints -1 for vt100.
    expect(detectDepth({ env: { TERM: 'vt100' }, probe: () => -1 })).toBe(0);
    expect(detectDepth({ env: { TERM: 'nonesuch' }, probe: () => -1 })).toBe(0);
  });

  it('lets COLORTERM raise the result to 24-bit', () => {
    // Many truecolor terminals still advertise TERM=xterm-256color and signal
    // 24-bit only through COLORTERM. Terminfo alone would cap them at 256.
    expect(detectDepth({
      env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      probe: () => 256,
    })).toBe(16777216);
    expect(detectDepth({
      env: { TERM: 'xterm-256color', COLORTERM: '24bit' },
      probe: () => 256,
    })).toBe(16777216);
  });

  it('never lets COLORTERM LOWER the result', () => {
    expect(detectDepth({
      env: { TERM: 'xterm-direct', COLORTERM: '' },
      probe: () => 16777216,
    })).toBe(16777216);
    // A COLORTERM that is present but names something SMALLER must be ignored
    // rather than believed. The empty-string case above cannot catch a
    // regression that lowers, because its expected value is already the
    // maximum -- so this is the assertion that makes the claim real.
    expect(detectDepth({
      env: { TERM: 'xterm-direct', COLORTERM: '256color' },
      probe: () => 16777216,
    })).toBe(16777216);
    expect(detectDepth({
      env: { TERM: 'xterm-256color', COLORTERM: '8' },
      probe: () => 256,
    })).toBe(256);
  });

  it('survives a probe that throws, e.g. tput absent', () => {
    // A missing binary must never be fatal.
    expect(detectDepth({
      env: { TERM: 'xterm-256color' },
      probe: () => { throw new Error('ENOENT'); },
    })).toBe(0);
  });
});

describe('sgrFor: quantisation per depth', () => {
  it('24-bit emits exact RGB, from the TUI palette', () => {
    // ZTI'S GREEN, (36,216,48), not core's saturated 0x00ff00. The TUI has its own
    // palette (see colours.ts): core stays the shared model, and this front end
    // renders the colours zti does, which is what the user compares against. Read
    // from tnz/zti.py:2815 and confirmed on the wire from a captured zti session.
    expect(sgrFor(Colour.GREEN, 16777216, 'fg', DEFAULT)).toBe('38;2;36;216;48');
    expect(sgrFor(Colour.GREEN, 16777216, 'bg', DEFAULT)).toBe('48;2;36;216;48');
  });

  it('renders neutral black as PURE black, as zti does', () => {
    // Why core needs no divergence for a black-looking background: the default
    // background resolves to F0, and F0 is pure black here even though core's
    // palette keeps 0x1a1a1a for it.
    expect(sgrFor(Colour.NEUTRAL_BLACK, 16777216, 'bg', DEFAULT)).toBe('48;2;0;0;0');
    expect(sgrFor(Colour.NEUTRAL_BLACK, 256, 'bg', DEFAULT)).toBe('48;5;16');
  });

  // Every number in this describe block was RE-DERIVED from the committed
  // `PALETTE_3279` before being trusted, because the plan warned its own numbers
  // predated a review that changed four palette entries. All of them held.
  //   24-bit: `38;2;r;g;b`
  //   256:    16 + 36*round(r/255*5) + 6*round(g/255*5) + round(b/255*5)
  //   16:     (bright ? 90 : 30) + nearest ANSI-8 index, bright = max>170

  it('256 emits a cube index', () => {
    const sgr = sgrFor(Colour.GREEN, 256, 'fg', DEFAULT);
    expect(sgr).toMatch(/^38;5;\d+$/);
    const index = Number(sgr.split(';')[2]);
    // 77, not 46: (36,216,48) gives 16 + 36*1 + 6*4 + 1. Worth knowing that BOTH
    // reference clients land on this same cell -- x3270's #32cd32 limegreen and zti's
    // (36,216,48) quantise to 77 alike, where core's pure green gave 46. Two
    // independent implementations agreeing is why this is the right number.
    expect(index).toBe(77);
  });

  it('16 emits a standard ANSI code', () => {
    // Bright green is 92; the 3279's green is full-intensity.
    expect(sgrFor(Colour.GREEN, 16, 'fg', DEFAULT)).toBe('92');
    expect(sgrFor(Colour.BLUE, 16, 'fg', DEFAULT)).toBe('94');
    expect(sgrFor(Colour.RED, 16, 'fg', DEFAULT)).toBe('91');
  });

  it('8 emits only the non-bright range', () => {
    expect(sgrFor(Colour.GREEN, 8, 'fg', DEFAULT)).toBe('32');
    expect(sgrFor(Colour.BLUE, 8, 'fg', DEFAULT)).toBe('34');
    expect(sgrFor(Colour.RED, 8, 'fg', DEFAULT)).toBe('31');
  });

  it('monochrome emits nothing at all', () => {
    expect(sgrFor(Colour.RED, 0, 'fg', DEFAULT)).toBe('');
    expect(sgrFor(Colour.RED, 0, 'bg', DEFAULT)).toBe('');
  });

  it('maps all sixteen palette entries at every depth without throwing', () => {
    const depths: Depth[] = [0, 8, 16, 256, 16777216];
    for (let code = 0xf0; code <= 0xff; code++) {
      for (const d of depths) {
        expect(() => sgrFor(code, d, 'fg', DEFAULT)).not.toThrow();
      }
    }
  });

  it('distinguishes the seven base 3279 colours at 16 and above', () => {
    // The test that would catch a quantisation table collapsing two colours to
    // the same ANSI code -- which is the failure a human would notice first and
    // a test asserting "does not throw" would miss entirely.
    const base = [Colour.BLUE, Colour.RED, Colour.PINK, Colour.GREEN,
                  Colour.TURQUOISE, Colour.YELLOW, Colour.WHITE];
    for (const depth of [16, 256, 16777216] as Depth[]) {
      const seen = new Set(base.map((c) => sgrFor(c, depth, 'fg', DEFAULT)));
      expect(seen.size, `depth ${depth}`).toBe(base.length);
    }
  });

  it('returns nothing for a code outside the palette rather than throwing', () => {
    // render.ts should never produce one, but one bad cell must not take down
    // the whole screen. Pinned because the implementation catches deliberately.
    expect(sgrFor(0x00, 256, 'fg', DEFAULT)).toBe('');
    expect(sgrFor(0xef, 16777216, 'bg', DEFAULT)).toBe('');
  });
});

describe('sgrFor across schemes', () => {
  it('emits the scheme it is given, not a fixed table', () => {
    // The defect this whole change exists to fix: the GUI drew #0000ff while the TUI drew
    // zti's blue. Now both come from a named scheme and this pins the difference.
    expect(sgrFor(Colour.BLUE, 16777216, 'fg', SCHEMES.default!)).toBe('38;2;120;144;240');
    expect(sgrFor(Colour.BLUE, 16777216, 'fg', SCHEMES['3279']!)).toBe('38;2;0;0;255');
    expect(sgrFor(Colour.BLUE, 16777216, 'fg', SCHEMES.x3270!)).toBe('38;2;30;144;255');
  });

  it('renders green as green at BOTH truecolour and sixteen colours', () => {
    // The reason a Scheme carries ansi16. With a shared slot map this second assertion
    // would come back as bright blue (94) from a monochrome-green scheme.
    expect(sgrFor(Colour.BLUE, 16777216, 'fg', SCHEMES.green!)).toBe('38;2;33;160;33');
    expect(sgrFor(Colour.BLUE, 16, 'fg', SCHEMES.green!)).toBe('32');
    expect(sgrFor(Colour.NEUTRAL_WHITE, 16, 'fg', SCHEMES.green!)).toBe('92');
  });

  it('keeps the background black in green, so the screen is not a green wash', () => {
    expect(sgrFor(Colour.NEUTRAL_BLACK, 16777216, 'bg', SCHEMES.green!)).toBe('48;2;0;0;0');
  });

  it('still returns nothing for monochrome or an invalid code', () => {
    expect(sgrFor(Colour.RED, 0, 'fg', DEFAULT)).toBe('');
    expect(sgrFor(0x00, 256, 'fg', DEFAULT)).toBe('');
    expect(sgrFor(0xef, 16777216, 'bg', DEFAULT)).toBe('');
  });
});
