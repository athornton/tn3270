# Palette Schemes, Unreachable Keys, and the Default Terminal Type — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every front end one palette registry with four selectable schemes, bind the 3270 keys that were implemented but unreachable, and make the default terminal type work on MVS.

**Architecture:** A new `packages/frontend/src/palette.ts` holds four schemes, each carrying both a 16-colour RGB table and a 16-slot ANSI map; the TUI and GUI both resolve colour through it and both parse `-scheme`. The keys are table entries in three existing files plus two new `Action` kinds. The default terminal type is one constant and four test expectations.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, npm workspaces (`core <- frontend <- {cli, tui, gui}`), Electron 44 for the GUI, Xvfb for headless capture.

**Spec:** `docs/superpowers/specs/2026-09-14-shared-palette-and-unreachable-keys-design.md`

---

## Read this before Task 1

Five facts that will otherwise cost you an hour each. All measured, not inferred.

1. **`npm run build` MUST precede `vitest` whenever you change `packages/frontend`.** The other
   packages resolve it to its built `dist/index.js`. Testing before rebuilding fails ~22 tests
   in a way that reads as a broken refactor. Use `npm run build`, **not**
   `npm run build --workspaces`.
2. **Never add a runtime (value) import of a workspace package to a file the Electron RENDERER
   loads.** A browser cannot resolve `@tn3270/core`; there is no bundler, and the window goes
   blank **with no error**. `renderer.ts` and `keys.ts` and `blit.ts` are renderer-side.
   `main.ts` and `drawlist.ts` are main-side and may import freely. Task 4 adds a test for this.
   `import type` is fine anywhere — it erases.
3. **The 3270 font is in CG order, not EBCDIC.** Irrelevant to this plan, but do not "fix" the
   `ebcdicToCg` calls you will see in `drawlist.ts`.
4. **Headless Electron needs `--no-sandbox --disable-gpu`**, and `show: false` HANGS without
   `--disable-gpu`. Start Xvfb with `nohup` and check for the socket with
   `[ -S /tmp/.X11-unix/X99 ]` — do **not** guard with `pgrep -f "Xvfb :99"`, which matches the
   shell command containing that string.
5. **Run the whole suite, not one file, before each commit.** The baseline is **1283 tests in 51
   files, all passing**. Any other number means something in this plan went wrong.

---

## File Structure

**Created:**
- `packages/frontend/src/palette.ts` — the scheme registry: the `Scheme` type, four schemes, `resolveScheme`, `schemeRgb`, `DEFAULT_SCHEME`. Sole owner of "what RGB and which ANSI slot".
- `packages/frontend/test/palette.test.ts` — registry completeness, per-scheme distinctness, alias and error behaviour.
- `packages/gui/test/renderer-imports.test.ts` — guards the renderer's runtime import graph.

**Modified:**
- `packages/core/src/constants.ts:545` — `TERMINAL_TYPE` becomes `IBM-3278-2-E`.
- `packages/core/src/palette.ts:5-7` — corrected comment; the table becomes the `3279` scheme's data.
- `packages/core/src/termtype.ts:126,132-138` / `queryreply.ts:357` — comments naming the old default.
- `packages/frontend/src/keymap.ts` — `Action` gains `attn`, `toggleInsert`; table gains `\x01`, `\x1b[2~`.
- `packages/frontend/src/actions.ts` — two new cases.
- `packages/frontend/src/bindings.ts` — PA3, Attn, Insert.
- `packages/frontend/src/index.ts` — export the registry.
- `packages/tui/src/colours.ts` — `TUI_PALETTE` and `ANSI_16` deleted; `sgrFor` takes a scheme.
- `packages/tui/src/render.ts` — `TerminalRenderer` takes a scheme.
- `packages/tui/src/app.ts` — threads the scheme.
- `packages/tui/src/main.ts` — parses `-scheme`, threads it, usage text.
- `packages/gui/src/drawlist.ts` — `drawList` takes a scheme.
- `packages/gui/src/args.ts` — parses `-scheme`.
- `packages/gui/src/main.ts` — passes the scheme to `drawList`.
- `packages/gui/src/keys.ts` — PA via `e.code`, `Ctrl-A`, `Insert`.
- `packages/gui/test/keys.test.ts` — the guard hole closed.
- `packages/gui/scripts/shot.mjs` — a second golden case for `green`.
- `packages/cli/scripts/record-vm.txt` — explicit `-model 3278-2`.
- `packages/fixtures/x3270/README.md` + `tso-query-reply.txt` header — stale claims.
- `README.md` — three passages.

---

### Task 1: The palette scheme registry

**Files:**
- Create: `packages/frontend/src/palette.ts`
- Create: `packages/frontend/test/palette.test.ts`
- Modify: `packages/frontend/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/frontend/test/palette.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/palette.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/palette.js"`.

- [ ] **Step 3: Write the registry**

Create `packages/frontend/src/palette.ts`:

```ts
import { Colour, type Colour3279, type Rgb, PALETTE_3279 } from '@tn3270/core';

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
 * scheme's identity, which is why `ANSI_16` moved out of the TUI to sit here.
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

/** Declaration order, which is also the order the usage text lists them. */
export const SCHEME_NAMES: readonly string[] = Object.freeze(Object.keys(SCHEMES));

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

/** Re-exported so a consumer needs one import for "the palette". */
export { Colour };
```

- [ ] **Step 4: Correct core's now-false comment**

`packages/core/src/palette.ts:5-7` claims "The TUI quantises these, the GUI will fill canvas
cells with them ... One table, three consumers." The first clause has been false since the TUI
shipped its own table, and **that stale comment is why this drifted** — it described an
intention nobody had checked. Replace those lines:

```ts
 * IN CORE BECAUSE IT IS THE ARCHITECTED MEANING, not because it is what gets drawn.
 * This table answers "which colour IS code F1" and is pinned to GA23-0059 below. What a
 * front end actually paints comes from the scheme registry in `packages/frontend/palette.ts`,
 * where this table is the `3279` scheme's data — and where the READABLE default lives, since
 * the pure `#0000ff` blue below is close to illegible on black.
 *
 * An earlier version of this comment said the TUI quantised these values and the GUI would
 * fill cells with them. The first half was false from the day the TUI shipped its own table,
 * and the resulting drift is what a user reported on 2026-09-14: two front ends, two blues.
```

- [ ] **Step 5: Export it from the package**

In `packages/frontend/src/index.ts`, append after the `BINDING_INTENT` block:

```ts
// The display palettes. Shared because a front end's colours are a presentation choice that
// must not differ BETWEEN front ends -- the GUI drew core's saturated primaries while the
// TUI had its own gentler table, and a user reported the blue as unreadable. Core keeps the
// architected meaning; this decides what gets drawn.
export { SCHEMES, SCHEME_NAMES, DEFAULT_SCHEME, resolveScheme, schemeRgb } from './palette.js';
export type { Scheme, Slot } from './palette.js';
```

- [ ] **Step 6: Build, then run the test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/palette.test.ts
```

Expected: PASS, 13 tests. If it fails on the import, you skipped the build.

- [ ] **Step 7: Run the whole suite**

```bash
cd ~/git/tn3270 && npx vitest run
```

Expected: 1283 passed plus the new file's tests — the registry is additive so far and nothing
else consumes it yet.

- [ ] **Step 8: Commit**

```bash
cd ~/git/tn3270 && git add packages/frontend/src/palette.ts packages/frontend/test/palette.test.ts packages/frontend/src/index.ts packages/core/src/palette.ts
git commit -m "feat(frontend): four palette schemes, each carrying its own ANSI slot map"
```

---

### Task 2: The TUI draws from the registry, and parses `-scheme`

**Files:**
- Modify: `packages/tui/src/colours.ts`
- Modify: `packages/tui/src/render.ts:146,182,194,389-390`
- Modify: `packages/tui/src/app.ts:74-86,130-143`
- Modify: `packages/tui/src/main.ts:25-41,103-113,183,220-232`
- Modify: `packages/tui/test/colours.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/tui/test/colours.test.ts`, change the import line to:

```ts
import { describe, expect, it } from 'vitest';
import { Colour } from '@tn3270/core';
import { SCHEMES, resolveScheme } from '@tn3270/frontend';
import { detectDepth, sgrFor, type Depth } from '../src/colours.js';

const DEFAULT = SCHEMES.default!;
```

Then add this block at the end of the file:

```ts
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
```

Finally, every existing `sgrFor(...)` call in this file needs the new fourth argument. There
are calls at roughly lines 69-70, 77-78, 89, 101-103, 107-109, 113-114, 121, 133, 141-142.
Append `, DEFAULT` to each — e.g. `sgrFor(Colour.GREEN, 16777216, 'fg')` becomes
`sgrFor(Colour.GREEN, 16777216, 'fg', DEFAULT)`. The loop at line 121 becomes
`expect(() => sgrFor(code, d, 'fg', DEFAULT)).not.toThrow();` and the one at 133
`new Set(base.map((c) => sgrFor(c, depth, 'fg', DEFAULT)))`.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/tui/test/colours.test.ts
```

Expected: FAIL — `Expected 3 arguments, but got 4` from the type checker, or wrong values.

- [ ] **Step 3: Rewrite `colours.ts` to take a scheme**

In `packages/tui/src/colours.ts`: delete the `TUI_PALETTE` constant **and its whole doc
comment** (they move to `frontend/src/palette.ts`, already done in Task 1), delete the
`ANSI_16` constant **and its doc comment**, change the import line, and replace `sgrFor`.

Replace the import at the top:

```ts
import { execFileSync } from 'node:child_process';
import { type Colour3279 } from '@tn3270/core';
import { type Scheme } from '@tn3270/frontend';
```

Add this note where `TUI_PALETTE` used to be:

```ts
/**
 * ## THE PALETTES LIVE IN `@tn3270/frontend`, NOT HERE
 *
 * They used to be this file's `TUI_PALETTE` and `ANSI_16`, and that was the defect: the GUI
 * drew core's saturated primaries while the TUI drew zti's gentler ones, so the same session
 * had two different blues and one of them was unreadable on black. Both tables are now
 * scheme data in `frontend/src/palette.ts`, including the slot map — a monochrome-green
 * scheme has to quantise onto green slots, so "which of sixteen slots" is scheme data too.
 *
 * What stays here is genuinely terminal-specific and belongs to no other front end:
 * terminfo depth detection, the 6x6x6 cube, and the SGR strings themselves.
 */
```

Replace `sgrFor` entirely:

```ts
/**
 * The SGR parameter string for one colour, e.g. `38;5;46`. Empty when monochrome.
 * The caller wraps it in `\x1b[...m`.
 */
export function sgrFor(
  code: Colour3279, depth: Depth, which: 'fg' | 'bg', scheme: Scheme,
): string {
  if (depth === 0) return '';
  const rgb = scheme.rgb[code];
  const slot = scheme.ansi16[code];
  if (rgb === undefined || slot === undefined) {
    // render.ts should never hand us an invalid code, but a throw here would take down the
    // whole screen for one bad cell.
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
```

- [ ] **Step 4: Thread the scheme through the renderer**

In `packages/tui/src/render.ts`, add to the import at line 18:

```ts
import { sgrFor, type Depth } from './colours.js';
import { type Scheme } from '@tn3270/frontend';
```

In `RendererOptions` (line 146), after `depth: Depth;`:

```ts
  /** Which palette to draw. `App` resolves it from `-scheme`. */
  scheme: Scheme;
```

Beside the `private readonly depth: Depth;` field (line 182):

```ts
  private readonly scheme: Scheme;
```

In the constructor beside `this.depth = opts.depth;` (line 194):

```ts
    this.scheme = opts.scheme;
```

And at lines 389-390:

```ts
    const fg = sgrFor(cell.fg, this.depth, 'fg', this.scheme);
    const bg = sgrFor(cell.bg, this.depth, 'bg', this.scheme);
```

- [ ] **Step 5: Thread it through `App`**

In `packages/tui/src/app.ts`, add `Scheme` and `resolveScheme` to the existing
`@tn3270/frontend` import, then in `AppOptions` (after `depth?: Depth;` at line 79):

```ts
  /** Which palette to draw. Absent means the readable default. */
  scheme?: Scheme;
```

And in the constructor's `new TerminalRenderer({...})` (line 137), after the `depth:` line:

```ts
      scheme: opts.scheme ?? resolveScheme(),
```

- [ ] **Step 6: Parse `-scheme` in `main.ts`**

In `packages/tui/src/main.ts`, add to the `@tn3270/frontend` import: `resolveScheme`,
`SCHEME_NAMES`, and `type Scheme`. Then in `TuiArgs` (after the `colors?: Depth;` entry):

```ts
  /** `-scheme`. Absent means the readable default. */
  scheme?: Scheme;
```

In the `switch` in `parseArgs`, beside `case '--colors'`:

```ts
      case '-scheme': {
        if (value === undefined) {
          throw new UsageError(`-scheme needs a value: ${SCHEME_NAMES.join(', ')}`);
        }
        // resolveScheme throws RangeError listing the valid names; rethrow as a UsageError
        // so the front end reports it the same way it reports every other bad flag.
        try {
          args.scheme = resolveScheme(value);
        } catch (err) {
          throw new UsageError(err instanceof Error ? err.message : String(err));
        }
        i++;
        break;
      }
```

In the usage string (line 183), insert `[-scheme S] ` after `[--colors N] `:

```ts
      `usage: tn3270 [-model M] [--terminal-type T] [--colors N] [-scheme S] `
      + `[-tn3270e on|off] ${TLS_USAGE} [prefix:][LU,LU@]host[:port]`,
```

And in the `new App({...})` call (line 227), beside the `depth` line:

```ts
    ...(args.scheme !== undefined ? { scheme: args.scheme } : {}),
```

- [ ] **Step 7: Build and run the TUI tests**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/tui
```

Expected: PASS. If `render.test.ts` complains about a missing `scheme` in `RendererOptions`,
add `scheme: resolveScheme(),` to the options object each failing test constructs.

- [ ] **Step 8: Add a flag test**

The `parseArgs` tests live in **`packages/tui/test/main.test.ts`** — there is no `args.test.ts`
in this package. Append there:

```ts
  it('parses -scheme, case-insensitively, and rejects an unknown name by listing them', () => {
    expect(parseArgs(['-scheme', 'green', 'h']).scheme).toBe(SCHEMES.green);
    expect(parseArgs(['-scheme', 'GreenScreen', 'h']).scheme).toBe(SCHEMES.green);
    expect(parseArgs(['h']).scheme).toBeUndefined();
    expect(() => parseArgs(['-scheme', 'solarized', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-scheme', 'solarized', 'h'])).toThrow(/default, 3279, x3270, green/);
    expect(() => parseArgs(['-scheme', 'h'])).toThrow(UsageError);
  });
```

Add `SCHEMES` to that file's `@tn3270/frontend` import.

- [ ] **Step 9: Run the whole suite**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run
```

Expected: all pass, count above 1283.

- [ ] **Step 10: Commit**

```bash
cd ~/git/tn3270 && git add packages/tui packages/frontend
git commit -m "feat(tui): draw from the shared scheme registry, selectable with -scheme"
```

---

### Task 3: The GUI draws from the registry, and parses `-scheme`

**Files:**
- Modify: `packages/gui/src/drawlist.ts:1-3,77-82,94-95,136-140`
- Modify: `packages/gui/src/args.ts:1-4,23-36,38-40,54-76`
- Modify: `packages/gui/src/main.ts:182-184`
- Modify: `packages/gui/test/drawlist.test.ts`, `packages/gui/test/blit.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gui/test/drawlist.test.ts` already has the setup you need — **use it rather than
building your own.** It loads the real atlas from `dist/atlas.json` (so `AtlasGeometry` is
`{ cellWidth, cellHeight, cols, index }`, not something you construct), and has two helpers:

```ts
function screenWith(chars: readonly [number, number][]): Screen {
  const s = new Screen({ rows: 24, cols: 80 });      // OBJECT arg, not positional
  for (const [addr, ebcdic] of chars) s.setChar(addr, ebcdic);
  return s;
}

const listFor = (s: Screen, oia?: string) => {
  const snap = s.snapshot();
  return drawList(snap, resolve(snap), atlas, oia);
};
```

**Change `listFor` to take a scheme, and every existing call in the file keeps working:**

```ts
const listFor = (s: Screen, scheme: Scheme = SCHEMES.default!, oia?: string) => {
  const snap = s.snapshot();
  return drawList(snap, resolve(snap), atlas, scheme, oia);
};
```

Any existing call that passed OIA text positionally — `listFor(s, 'X Wait')` — must become
`listFor(s, SCHEMES.default!, 'X Wait')`. Find them with
`grep -n "listFor(.*,'" packages/gui/test/drawlist.test.ts`.

Add `import { SCHEMES, schemeRgb, type Scheme } from '@tn3270/frontend';` and append:

```ts
describe('drawList honours the scheme it is given', () => {
  it("draws the scheme's blue, not core's", () => {
    // The bug this change fixes: the GUI resolved through core's colourRgb, whose blue is
    // pure #0000ff and unreadable on black. A default 3279 field is green, so recolour one
    // cell by hand rather than relying on the default attribute.
    const s = screenWith([[0, 0xc1]]);
    const snap = s.snapshot();
    const recoloured = resolve(snap).map((c, i) =>
      i === 0 ? { ...c, fg: Colour.BLUE } : c);

    const readable = drawList(snap, recoloured, atlas, SCHEMES.default!);
    const saturated = drawList(snap, recoloured, atlas, SCHEMES['3279']!);

    expect(readable.cells[0]!.fg).toEqual([120, 144, 240]);
    expect(saturated.cells[0]!.fg).toEqual([0, 0, 255]);
  });

  it('draws the default green field colour from the scheme', () => {
    expect(listFor(screenWith([[0, 0xc1]]), SCHEMES.default!).cells[0]!.fg)
      .toEqual([36, 216, 48]);                       // zti green
    expect(listFor(screenWith([[0, 0xc1]]), SCHEMES.x3270!).cells[0]!.fg)
      .toEqual([0x32, 0xcd, 0x32]);                  // x3270 limegreen
  });

  it("draws the OIA in the scheme too, not in core's colours", () => {
    // The OIA is our chrome, so no host byte says what colour it is -- but it must not be
    // the one scheme-independent thing on screen.
    const list = listFor(screenWith([[0, 0xc1]]), SCHEMES.green!, 'X Wait');
    const oia = list.cells[list.cells.length - 1]!;
    expect(oia.fg).toEqual([0, 255, 0]);             // green's LIME for neutral-white
    expect(oia.bg).toEqual([0, 0, 0]);
  });
});
```

Note the existing test at line ~45 asserts `dl.cells[0]!.fg` equals `colourRgb(Colour.GREEN)`.
That value changes, so update it to `schemeRgb(SCHEMES.default!, Colour.GREEN)`.

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/gui/test/drawlist.test.ts
```

Expected: FAIL — `Expected 3-4 arguments, but got 4-5`.

- [ ] **Step 3: Make `drawList` take a scheme**

In `packages/gui/src/drawlist.ts`, change the imports (drop `colourRgb`, keep the rest):

```ts
import {
  cp037, Colour, type Rgb, type ResolvedCell, type ScreenSnapshot,
} from '@tn3270/core';
import { schemeRgb, type Scheme } from '@tn3270/frontend';
import { ebcdicToCg, CG_BOXSOLID } from './cg.js';
```

> **This file runs in the MAIN process only.** `renderer.js` reaches it through `import type`
> alone, which erases, so the value import above cannot reach the browser. Task 4 pins that.

Change the signature at line 77 — **the scheme goes before the optional `oiaText`**, or an
existing caller passing OIA text would silently pass it as the scheme:

```ts
export function drawList(
  snapshot: ScreenSnapshot,
  resolved: readonly ResolvedCell[],
  atlas: AtlasGeometry,
  scheme: Scheme,
  oiaText?: string,
): DrawList {
```

At lines 94-95:

```ts
    const fg = schemeRgb(scheme, r.reverse ? r.bg : r.fg);
    const bg = schemeRgb(scheme, r.reverse ? r.fg : r.bg);
```

Thread it into `oiaCells` — change its signature and body:

```ts
function oiaCells(
  text: string, y: number, cols: number, atlas: AtlasGeometry, scheme: Scheme,
): readonly DrawCell[] {
  const fg = schemeRgb(scheme, Colour.NEUTRAL_WHITE);
  const bg = schemeRgb(scheme, Colour.NEUTRAL_BLACK);
```

and update its call site inside `drawList` (find it with `grep -n "oiaCells(" packages/gui/src/drawlist.ts`) to pass `scheme` as the fifth argument.

- [ ] **Step 4: Parse `-scheme` in the GUI**

In `packages/gui/src/args.ts`, add to the `@tn3270/frontend` import: `resolveScheme`,
`SCHEME_NAMES`, `type Scheme`. Add to `GuiArgs`:

```ts
  /** `-scheme`. Absent means the readable default. */
  scheme?: Scheme;
```

Update `USAGE`:

```ts
export const USAGE =
  `usage: tn3270-gui [-model M] [--terminal-type T] [-scheme S] [-tn3270e on|off] `
  + `${TLS_USAGE} [prefix:][LU,LU@]host[:port]`;
```

And add a case beside `-model`:

```ts
      case '-scheme': {
        if (value === undefined) {
          throw new UsageError(`-scheme needs a value: ${SCHEME_NAMES.join(', ')}`);
        }
        try {
          args.scheme = resolveScheme(value);
        } catch (err) {
          throw new UsageError(err instanceof Error ? err.message : String(err));
        }
        i++;
        break;
      }
```

Also correct the file's header comment, which currently says the GUI deliberately has no
colour flag — that is now only half true:

```ts
 * Deliberately NOT the same as the TUI in one respect: there is no `--colors`. A canvas has
 * no terminfo depth to detect; it draws 24-bit RGB straight from the scheme. `-scheme` IS
 * shared, because which palette to draw is not a terminal question.
```

- [ ] **Step 5: Pass it from main**

In `packages/gui/src/main.ts`, add `resolveScheme` to the `@tn3270/frontend` import, and near
where `args` is available add:

```ts
  // Resolved once: a scheme is fixed for the process, and re-resolving per frame would put a
  // string lookup in the paint path.
  const scheme = args.scheme ?? resolveScheme();
```

Then update the `drawList` call (line 182):

```ts
    const list = drawList(
      snapshot, resolve(snapshot), geometry, scheme, oia === '' ? undefined : oia,
    );
```

- [ ] **Step 6: Fix the other GUI tests**

`packages/gui/test/blit.test.ts` uses `colourRgb` at lines 155 and 161 and calls `drawList`.
Change its import from `colourRgb` to `SCHEMES`/`schemeRgb` from `@tn3270/frontend`, replace
`colourRgb(X)` with `schemeRgb(SCHEMES.default!, X)`, and add `SCHEMES.default!` as the fourth
argument to every `drawList(...)` call in both GUI test files.

- [ ] **Step 7: Build and run the GUI tests**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/gui
```

Expected: PASS.

- [ ] **Step 8: Assert the cross-front-end property, which is the actual requirement**

Neither front end's own tests can state it — each only checks itself. Put this in
`packages/frontend/test/palette.test.ts`, because that is the package **both** front ends
derive from, and a test there needs no cross-package import:

```ts
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
```

> **Why not compare `sgrFor` output directly to a `DrawList` here?** That would need
> `packages/frontend` to import `tui` and `gui`, inverting the package graph this project
> restructured to get right — `frontend`'s tests must not import either front end. The
> TUI-side half is covered by `colours.test.ts`'s per-scheme `sgrFor` assertions (Task 2) and
> the GUI-side half by `drawlist.test.ts`'s scheme assertions (this task, Step 1). Together
> they close the loop without inverting the graph.

- [ ] **Step 9: Run the whole suite and commit**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run
git add packages/gui packages/frontend
git commit -m "feat(gui): draw from the shared scheme registry, selectable with -scheme"
```

---

### Task 4: Guard the renderer's import graph

**Files:**
- Create: `packages/gui/test/renderer-imports.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The renderer's runtime graph must contain no workspace import.
 *
 * A browser cannot resolve a bare specifier like `@tn3270/core`; there is no bundler. The
 * failure mode is what makes this worth a test: the window goes BLANK WITH NO ERROR, and
 * nothing in the suite notices. `drawList` runs in main for exactly this reason, and this
 * pins the boundary rather than trusting a comment to be read.
 *
 * `import type` is invisible here because it erases at compile time -- which is why this
 * test reads the BUILT javascript rather than the TypeScript source.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(guiDir, 'dist');

/** Every local module reachable from an entry point, following relative imports. */
function graphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      queue.push(resolvePath(dirname(file), m[1]!));
    }
  }
  return [...seen];
}

describe('the renderer bundle', () => {
  it('was built (run npm run build first)', () => {
    expect(existsSync(join(distDir, 'renderer.js')), `missing ${distDir}/renderer.js`).toBe(true);
  });

  it('imports no workspace package anywhere in its runtime graph', () => {
    const graph = graphFrom(join(distDir, 'renderer.js'));
    expect(graph.length).toBeGreaterThan(1);   // guard against an empty scan passing
    const offenders: string[] = [];
    for (const file of graph) {
      const text = readFileSync(file, 'utf8');
      if (/(?:from|import)\s*['"]@tn3270\//.test(text)) offenders.push(file);
    }
    expect(offenders, 'these run in the renderer and would blank the window').toEqual([]);
  });

  it('confirms drawlist.js is NOT in that graph, since it imports core and frontend', () => {
    // If this ever fails, someone moved palette or draw-list work into the renderer and the
    // window is about to go blank.
    const graph = graphFrom(join(distDir, 'renderer.js'));
    expect(graph.some((f) => f.endsWith('drawlist.js'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/gui/test/renderer-imports.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 3: Verify the test can actually fail (mutation check)**

**CORRECTED 2026-09-14 — the obvious version of this check falsely PASSES.** Adding only
`import { SCHEMES } from '@tn3270/frontend';` is not enough: with no `isolatedModules` or
`verbatimModuleSyntax` in `tsconfig.base.json`, **`tsc` elides a value import that is never
referenced**, so it never reaches `dist/renderer.js` and the guard correctly sees nothing.
Measured twice, by the implementer and again by the reviewer.

So the binding must be **used**. Temporarily add both lines to the top of
`packages/gui/src/renderer.ts`:

```ts
import { SCHEMES } from '@tn3270/frontend';
console.log('schemes', Object.keys(SCHEMES).length);
```

then `npm run build` and rerun the test.

Expected: FAIL, naming `renderer.js` as the sole offender —
`expected [ Array(1) ] to deeply equal []`.

**This is not a hole in the guard, and it is worth understanding why before you move on:** an
elided import is absent from the shipped bundle, so it cannot blank the window either. The
guard's coverage matches the real risk exactly — what breaks the renderer is an import that
survives to runtime, and that is precisely what fails here. **Then revert it:**

```bash
cd ~/git/tn3270 && git checkout packages/gui/src/renderer.ts && npm run build
```

A guard nobody has watched fail is not a guard.

- [ ] **Step 4: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/test/renderer-imports.test.ts
git commit -m "test(gui): pin the renderer's runtime graph against workspace imports"
```

---

### Task 5: Re-baseline the goldens, and add a green one

**Files:**
- Modify: `packages/gui/scripts/shot.mjs:49-60`
- Modify: `packages/gui/test/golden/synthetic-ispf.png` + its `.sha256`
- Create: `packages/gui/test/golden/synthetic-ispf-green.png` + `.sha256`

- [ ] **Step 1: Start Xvfb**

```bash
cd ~/git/tn3270 && nohup Xvfb :99 -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 &
sleep 2 && [ -S /tmp/.X11-unix/X99 ] && echo "XVFB UP" || echo "XVFB FAILED"
```

Expected: `XVFB UP`. Do **not** use `pgrep -f "Xvfb :99"` to check — it matches its own
command line.

- [ ] **Step 2: Add the green case**

In `packages/gui/scripts/shot.mjs`, the `CASES` array (line 51) gains a second entry
alongside `synthetic-ispf`. Copy the existing entry's shape exactly, changing only the name
and adding the flag:

```js
  {
    name: 'synthetic-ispf-green',
    trace: join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace'),
    host: '127.0.0.1:3270',
    extraArgv: ['-scheme', 'green'],
  },
```

and where the case is spawned (line 85), thread that through:

```js
  const result = spawnSync(electron, [main, ...ARGV, ...(kase.extraArgv ?? []), kase.host], {
```

- [ ] **Step 3: Re-baseline and INSPECT**

```bash
cd ~/git/tn3270 && DISPLAY=:99 node packages/gui/scripts/shot.mjs --update
```

Then confirm what changed is only colour.

> **CORRECTED 2026-09-14 — the "compare ink-pixel sets" script below is WRONG for this
> re-baseline and will always report `MOVED`.** It defines ink as "any non-pure-black pixel",
> but the OLD golden's background is F0 neutral-black `#1a1a1a`, so the entire old background
> counted as ink (242,873 px) while the new pure-black background is correctly excluded. It
> also silently swallows a **hardcoded canvas-clear fill** (`renderer.ts:100-101`, a solid
> 594x14 = 8,316 px rectangle drawn before any cell and belonging to no F-code), which was
> `(0,0,0)` all along and becomes indistinguishable from the new background.
>
> **Do the ground-truth replay below instead.** The difference matters: "does *some*
> consistent old→new colour mapping exist" is inferred from the images and can be satisfied by
> a coincidental swap of two equal-population colours, whereas replaying the mapping the code
> is *supposed* to implement checks the images against the source of truth. Both were run on
> this re-baseline; the replay gave **0 mismatches across all 252,000 pixels**.

```bash
cd ~/git/tn3270 && git show HEAD:packages/gui/test/golden/synthetic-ispf.png > /tmp/golden-before.png
python3 - <<'PY'
import zlib
from struct import unpack

# Transcribed BY HAND from the two sources, which is the point -- old from
# packages/core/src/palette.ts (PALETTE_3279), new from packages/frontend/src/palette.ts
# (DEFAULT_RGB). Do not generate this from the images; that is what makes it ground truth.
TABLE = {
    (0x1a,0x1a,0x1a): (0,0,0),          # F0 neutral-black -> pure black
    (0x00,0x00,0xff): (120,144,240),    # F1 blue -> zti blue  <-- the reported defect
    (0xff,0x00,0x00): (240,24,24),      # F2 red
    (0xff,0x00,0xff): (255,0,255),      # F3 pink (unchanged)
    (0x00,0xff,0x00): (36,216,48),      # F4 green -> zti green
    (0x00,0xff,0xff): (88,240,240),     # F5 turquoise
    (0xff,0xff,0x00): (255,255,0),      # F6 yellow (unchanged)
    (0xe0,0xe0,0xe0): (255,255,255),    # F7 neutral-white -> pure white
    (0x00,0x00,0x80): (0,0,205),        # F9 deep blue
    (0xff,0x80,0x00): (255,165,0),      # FA orange
    (0x80,0x00,0xff): (160,32,240),     # FB purple
    (0x80,0xff,0x80): (144,238,144),    # FC pale green
    (0x80,0xff,0xff): (150,205,205),    # FD pale turquoise
    (0x80,0x80,0x80): (119,136,153),    # FE grey
    (0xff,0xff,0xff): (245,245,245),    # FF white
}
# F8 black is DELIBERATELY ABSENT. Old F8 is (0,0,0), which in this golden is also the
# canvas-clear fill -- so an old (0,0,0) pixel is ambiguous between "F8 cell, should become
# (47,79,79)" and "canvas clear, must stay (0,0,0)". This golden contains no F8 cells, so
# (0,0,0) maps to itself via the identity default below. IF A FUTURE GOLDEN PAINTS F8, this
# replay cannot disambiguate from pixels alone and must be driven from the draw list instead.

def pixels(path):
    """Decode to a list of rows of (r,g,b). Handles PNG filter types 0-4: these rows use
    1, 2 and 4, and a decoder handling only type 0 reports every pixel black -- which has
    produced a false 'the canvas is blank' reading in this project before."""
    d = open(path, 'rb').read()
    i, w, h, idat = 8, None, None, b''
    while i < len(d):
        ln = unpack('>I', d[i:i+4])[0]
        typ = d[i+4:i+8]
        if typ == b'IHDR': w, h = unpack('>II', d[i+8:i+16])
        elif typ == b'IDAT': idat += d[i+8:i+8+ln]
        i += 12 + ln
    raw, stride, prev, pos, out = zlib.decompress(idat), w*3, bytearray(w*3), 0, []
    for _ in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        for x in range(stride):
            a = line[x-3] if x >= 3 else 0
            b = prev[x]
            c = prev[x-3] if x >= 3 else 0
            if f == 1:   line[x] = (line[x] + a) & 0xff
            elif f == 2: line[x] = (line[x] + b) & 0xff
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 0xff
            elif f == 4:
                pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xff
        out.append([tuple(line[x:x+3]) for x in range(0, stride, 3)])
        prev = line
    return out

old = pixels('/tmp/golden-before.png')
new = pixels('packages/gui/test/golden/synthetic-ispf.png')
assert len(old) == len(new) and len(old[0]) == len(new[0]), 'DIMENSIONS CHANGED'

bad = []
for y, (orow, nrow) in enumerate(zip(old, new)):
    for x, (o, n) in enumerate(zip(orow, nrow)):
        want = TABLE.get(o, o)          # unknown colours must stay put
        if n != want: bad.append((x, y, o, want, n))
print(f'pixels={len(old)*len(old[0])} mismatches={len(bad)}')
for row in bad[:5]: print('  (x,y)=%s,%s old=%s expected=%s actual=%s' % row)
print('GROUND TRUTH CONFIRMED' if not bad else 'MISMATCH <-- STOP AND DIAGNOSE')
PY
```

Expected: `mismatches=0` and `GROUND TRUTH CONFIRMED`. That proves both halves at once —
every colour changed to exactly what the new palette specifies, **and** nothing moved, since a
moved glyph would put an unexpected colour at some coordinate.

**A mismatch means stop and diagnose, not re-baseline again.**

The superseded script is kept below only because its failure is instructive: a verification
heuristic that buckets pixels by "blackness" cannot survive a change to what black means.

<details><summary>Superseded ink-set comparison — do not rely on it</summary>

Compare ink-pixel **sets** — where ink is, not what colour it is:

```bash
cd ~/git/tn3270 && git show HEAD:packages/gui/test/golden/synthetic-ispf.png > /tmp/golden-before.png
python3 - <<'PY'
import zlib
from struct import unpack

def ink(path):
    """The set of (x, y) with any non-black pixel. Handles PNG filters 0-4 --
    these rows use 1, 2 and 4, and a reader that only does 0 reports every pixel
    black, which once produced a false 'canvas is blank' reading."""
    d = open(path, 'rb').read()
    i, w, h, idat = 8, None, None, b''
    while i < len(d):
        ln = unpack('>I', d[i:i+4])[0]
        typ = d[i+4:i+8]
        if typ == b'IHDR':
            w, h = unpack('>II', d[i+8:i+16])
        elif typ == b'IDAT':
            idat += d[i+8:i+8+ln]
        i += 12 + ln
    raw = zlib.decompress(idat)
    stride, out, prev, pos = w * 3, set(), bytearray(w * 3), 0
    for y in range(h):
        f = raw[pos]; pos += 1
        line = bytearray(raw[pos:pos+stride]); pos += stride
        for x in range(stride):
            a = line[x-3] if x >= 3 else 0
            b = prev[x]
            c = prev[x-3] if x >= 3 else 0
            if f == 1:   line[x] = (line[x] + a) & 0xff
            elif f == 2: line[x] = (line[x] + b) & 0xff
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 0xff
            elif f == 4:
                pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 0xff
        for x in range(0, stride, 3):
            if line[x] or line[x+1] or line[x+2]:
                out.add((x // 3, y))
        prev = line
    return out

before = ink('/tmp/golden-before.png')
after = ink('packages/gui/test/golden/synthetic-ispf.png')
print(f'ink pixels before={len(before)} after={len(after)}')
print('IDENTICAL INK POSITIONS' if before == after
      else f'MOVED: +{len(after-before)} -{len(before-after)}  <-- STOP AND DIAGNOSE')
PY
```

It reports `MOVED: +0 -242873` here, which is a **false positive** for the reasons given
above. Kept for the lesson, not for use.

</details>

- [ ] **Step 4: Confirm the green golden is actually green**

```bash
cd ~/git/tn3270 && python3 -c "
import zlib,struct
d=open('packages/gui/test/golden/synthetic-ispf-green.png','rb').read()
print('PNG is', len(d), 'bytes')
" && ls -l packages/gui/test/golden/
```

Then open both goldens and check by eye that the green one has no blue, red or yellow ink
anywhere, and a black background. This is the one check no assertion in this plan makes.

- [ ] **Step 5: Run the whole suite and commit**

```bash
cd ~/git/tn3270 && npx vitest run
git add packages/gui/scripts/shot.mjs packages/gui/test/golden
git commit -m "test(gui): re-baseline the golden for the new palette, and add a green one"
```

---

### Task 6: `attn` and `toggleInsert` actions, and the intent table

**Files:**
- Modify: `packages/frontend/src/keymap.ts:40-58,101-123`
- Modify: `packages/frontend/src/actions.ts:36-58`
- Modify: `packages/frontend/src/bindings.ts:35-78`
- Modify: `packages/frontend/test/keymap.test.ts`, `packages/frontend/test/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/frontend/test/keymap.test.ts`:

```ts
describe('the keys that were implemented in core but bound nowhere', () => {
  it('maps Ctrl-A to Attn, as c3270 does', () => {
    // Common/fb-c3270:83. Session.sendAttn() has existed since stage 1 and no key reached it.
    expect(lookup(Uint8Array.of(0x01))).toEqual({ kind: 'attn' });
  });

  it('maps the Insert key to an insert-mode toggle, as x3270 does', () => {
    // fb-x3270:210, Toggle(insertMode). `tput kich1` measures \x1b[2~ on this box.
    expect(lookup(new TextEncoder().encode('\x1b[2~'))).toEqual({ kind: 'toggleInsert' });
  });

  it('still resolves the three PA keys', () => {
    expect(lookup(new TextEncoder().encode('\x1b1'))).toEqual({ kind: 'pa', n: 1 });
    expect(lookup(new TextEncoder().encode('\x1b2'))).toEqual({ kind: 'pa', n: 2 });
    expect(lookup(new TextEncoder().encode('\x1b3'))).toEqual({ kind: 'pa', n: 3 });
  });
});
```

Append to `packages/frontend/test/actions.test.ts`. **The helper there is `newSession()`, not
`makeSession()`** — that name belongs to the TUI's app test. Add `vi` to the vitest import:

```ts
describe('applyAction: the newly-bound actions', () => {
  it('sends Attn as a Telnet BREAK, not an AID', () => {
    // Session.sendAttn() -> telnet BREAK, RFC 1576 section 8. Attn is NOT an AID, so this
    // must not go anywhere near sendAID.
    const { session } = newSession();
    const attn = vi.spyOn(session, 'sendAttn');
    const aid = vi.spyOn(session, 'sendAID');
    applyAction(session, { kind: 'attn' });
    expect(attn).toHaveBeenCalledOnce();
    expect(aid).not.toHaveBeenCalled();
  });

  it('toggles insert mode both ways', () => {
    const { session } = newSession();
    expect(session.keyboard.insertMode).toBe(false);
    applyAction(session, { kind: 'toggleInsert' });
    expect(session.keyboard.insertMode).toBe(true);
    applyAction(session, { kind: 'toggleInsert' });
    expect(session.keyboard.insertMode).toBe(false);
  });

  it('keeps the OIA in step with insert mode, since it reads the same flag', () => {
    const { session } = newSession();
    applyAction(session, { kind: 'toggleInsert' });
    expect(session.oia.insertMode).toBe(true);
  });
});
```

`newSession()` returns an object — check whether it is `{ session, conn }` or the session
itself (`grep -n "function newSession" -A 6 packages/frontend/test/actions.test.ts`) and
destructure to match.

- [ ] **Step 2: Run them and confirm they fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend
```

Expected: FAIL — the `Action` type has no `attn`, and `lookup` returns `null` for `\x01`.

- [ ] **Step 3: Extend the `Action` union**

In `packages/frontend/src/keymap.ts`, add to the union (after `| { kind: 'eraseInput' }`):

```ts
  | { kind: 'attn' }
  | { kind: 'toggleInsert' }
```

- [ ] **Step 4: Add the table entries**

In `buildTable()`, beside the existing control keys:

```ts
  // Attn is c3270's Ctrl-A (Common/fb-c3270:83). It is a Telnet BREAK, not an AID.
  t.set('\x01', { kind: 'attn' });
```

and beside the `\x1b[4~` entry:

```ts
  // The Insert key toggles insert mode, as x3270 does (fb-x3270:210). MEASURED:
  // `tput kich1` is `\x1b[2~` on the development box.
  t.set('\x1b[2~', { kind: 'toggleInsert' });
```

- [ ] **Step 5: Dispatch them**

In `packages/frontend/src/actions.ts`, add to the `switch`:

```ts
      case 'attn': session.sendAttn(); break;
      // Read-then-set rather than a stored flag: `Keyboard.insertMode` is the one truth and
      // the OIA reads it too, so a second copy here could disagree with what is displayed.
      case 'toggleInsert': k.setInsertMode(!k.insertMode); break;
```

- [ ] **Step 6: Record the intent**

In `packages/frontend/src/bindings.ts`, add to `BINDING_INTENT` after the `Alt-2` entry:

```ts
  { key: 'Alt-3', action: { kind: 'pa', n: 3 }, terminal: '\x1b3' },
  {
    key: 'Ctrl-A', action: { kind: 'attn' }, terminal: '\x01',
    note: 'c3270\'s own default (Common/fb-c3270:83). A Telnet BREAK, not an AID.',
  },
  {
    key: 'Insert', action: { kind: 'toggleInsert' }, terminal: '\x1b[2~',
    note: 'x3270\'s Toggle(insertMode) (fb-x3270:210); `tput kich1` measured \\x1b[2~',
  },
```

Also amend the `Alt-1` note, which is about to become misleading — the GUI matches these on
`e.code`, not on the byte sequence:

```ts
  {
    key: 'Alt-1', action: { kind: 'pa', n: 1 }, terminal: '\x1b1',
    note: 'the PA keys have no terminal equivalent, so ESC-digit, as c3270 does. The GUI '
      + 'matches e.code (Digit1), NOT e.key: on macOS Option-1 reports key "¡".',
  },
```

- [ ] **Step 7: Build, test, commit**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run
git add packages/frontend
git commit -m "feat(frontend): bind Attn and Insert, and record PA3 in the intent table"
```

---

### Task 7: The GUI binds PA, Attn and Insert — and its guard stops skipping

**Files:**
- Modify: `packages/gui/src/keys.ts:34-46,56-91`
- Modify: `packages/gui/test/keys.test.ts:66-101`

- [ ] **Step 1: Write the failing test**

Append to `packages/gui/test/keys.test.ts`:

```ts
describe('the keys the GUI could not reach at all', () => {
  it('maps Alt+digit to PA1-3', () => {
    expect(actionForKey(ev({ key: '1', code: 'Digit1', altKey: true })))
      .toEqual({ kind: 'pa', n: 1 });
    expect(actionForKey(ev({ key: '2', code: 'Digit2', altKey: true })))
      .toEqual({ kind: 'pa', n: 2 });
    expect(actionForKey(ev({ key: '3', code: 'Digit3', altKey: true })))
      .toEqual({ kind: 'pa', n: 3 });
  });

  it('matches on e.code, because macOS Option-1 reports key "¡"', () => {
    // THE trap on the reporter's machine. An e.key-based binding works on Linux and
    // silently fails on a Mac, which is the worst of both.
    expect(actionForKey(ev({ key: '¡', code: 'Digit1', altKey: true })))
      .toEqual({ kind: 'pa', n: 1 });
    expect(actionForKey(ev({ key: '™', code: 'Digit2', altKey: true })))
      .toEqual({ kind: 'pa', n: 2 });
  });

  it('does not turn Alt+other into a PA or into text', () => {
    expect(actionForKey(ev({ key: '4', code: 'Digit4', altKey: true }))).toBeNull();
    expect(actionForKey(ev({ key: 'f', code: 'KeyF', altKey: true }))).toBeNull();
  });

  it('leaves Cmd-digit alone, because that is where menu accelerators live', () => {
    // The reporter has left-Option mapped to Command at the OS level, so this arrives as a
    // metaKey chord. Binding it would collide with the menus on the roadmap.
    expect(actionForKey(ev({ key: '1', code: 'Digit1', metaKey: true }))).toBeNull();
  });

  it('maps Ctrl-A to Attn and Insert to the insert toggle', () => {
    expect(actionForKey(ev({ key: 'a', code: 'KeyA', ctrlKey: true })))
      .toEqual({ kind: 'attn' });
    expect(actionForKey(ev({ key: 'Insert', code: 'Insert' })))
      .toEqual({ kind: 'toggleInsert' });
  });
});
```

Also extend the `ev` helper at the top of the file to carry `code`:

```ts
const ev = (init: Partial<KeyLike> & { key: string }): KeyLike =>
  ({ code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init });
```

- [ ] **Step 2: Close the guard's hole in the same file**

Replace the `satisfies the shared BINDING_INTENT table` test's skip logic. Add the new keys to
`named`:

```ts
      'Alt-1': ev({ key: '1', code: 'Digit1', altKey: true }),
      'Alt-2': ev({ key: '2', code: 'Digit2', altKey: true }),
      'Alt-3': ev({ key: '3', code: 'Digit3', altKey: true }),
      'Ctrl-A': ev({ key: 'a', code: 'KeyA', ctrlKey: true }),
      Insert: ev({ key: 'Insert', code: 'Insert' }),
```

and replace the loop body:

```ts
    // An explicit allowlist, EMPTY on purpose. The old `continue` skipped anything it had no
    // spelling for, with a comment calling Alt-1 "a terminal-only spelling" -- it is not,
    // and that is exactly how the GUI shipped with no PA keys at all. Now an intent entry
    // the GUI cannot express FAILS here until it is either bound or listed below with a
    // reason.
    const TERMINAL_ONLY: readonly string[] = [];
    let checked = 0;
    for (const b of BINDING_INTENT) {
      const key = named[b.key];
      if (key === undefined) {
        expect(TERMINAL_ONLY, `BINDING_INTENT has ${b.key} and the GUI does not`)
          .toContain(b.key);
        continue;
      }
      expect(actionForKey(key), b.key).toEqual(b.action);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(24);
```

- [ ] **Step 3: Run and confirm it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/gui/test/keys.test.ts
```

Expected: FAIL — `code` is not on `KeyLike`, and Alt chords return `null`.

- [ ] **Step 4: Implement**

In `packages/gui/src/keys.ts`, add `code` to `KeyLike`:

```ts
export interface KeyLike {
  readonly key: string;
  /**
   * The PHYSICAL key. Load-bearing for Alt chords: on macOS, Option-1 reports
   * `key === '¡'`, so an `e.key` binding works on Linux and fails on a Mac.
   */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}
```

Add `Insert` to `NAMED`:

```ts
  // x3270's Toggle(insertMode), fb-x3270:210.
  Insert: { kind: 'toggleInsert' },
```

Add `a` to `CTRL`:

```ts
  a: { kind: 'attn' },
```

And in `actionForKey`, insert the Alt-digit branch **before** the Meta/Alt bail:

```ts
export function actionForKey(e: KeyLike): Action | null {
  if (MODIFIERS.has(e.key)) return null;

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    // Case-folded because Ctrl-Shift-C still means Clear, and browsers report the shifted
    // letter. `?? null` is what drops Ctrl-Z rather than typing "z".
    return CTRL[e.key.toLowerCase()] ?? null;
  }

  // The PA keys, on Alt+digit as x3270 and c3270 both have them (Common/fb-c3270:43-45).
  // Matched on e.code and not e.key: see the note on KeyLike.code. Checked BEFORE the bail
  // below, which is what used to make every PA key unreachable in this front end.
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const pa = PA_CODES[e.code];
    return pa !== undefined ? { kind: 'pa', n: pa } : null;
  }

  // A Meta or Alt chord belongs to the window or the OS, never to the field. Cmd-digit is
  // deliberately NOT a PA: that is where menu accelerators live.
  if (e.metaKey || e.altKey) return null;
  ...
```

with the table beside `CTRL`:

```ts
/** Physical digit keys that carry the PA keys when Alt is held. */
const PA_CODES: Readonly<Record<string, number>> = Object.freeze({
  Digit1: 1, Digit2: 2, Digit3: 3,
});
```

- [ ] **Step 5: Make the real renderer pass `code`**

`renderer.ts` builds a `KeyLike` from the DOM event. Find it:

```bash
cd ~/git/tn3270 && grep -n "actionForKey" -B 8 packages/gui/src/renderer.ts
```

If it passes the `KeyboardEvent` directly, nothing is needed — `code` is already on it. If it
constructs an object field by field, add `code: e.code`. **This is the step whose omission
would make every new test pass while the app stayed broken.**

- [ ] **Step 6: Verify against real Chromium key events**

```bash
cd ~/git/tn3270 && npm run build
[ -S /tmp/.X11-unix/X99 ] || (nohup Xvfb :99 -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 & sleep 2)
DISPLAY=:99 grep -n "TN3270_GUI_KEYS" -A 20 packages/gui/src/main.ts | head -30
```

Read how `TN3270_GUI_KEYS` builds events, then drive an Alt-1 through it — that seam uses
`sendInputEvent`, the only way to exercise the renderer's own keydown listener. A unit test on
`actionForKey` cannot prove the listener passes `code` through.

- [ ] **Step 7: Run the whole suite and commit**

```bash
cd ~/git/tn3270 && npx vitest run
git add packages/gui
git commit -m "fix(gui): bind PA1-3, Attn and Insert, and stop the intent guard skipping"
```

---

### Task 8: The TUI holds a lone ESC as a Meta prefix

**Files:**
- Modify: `packages/tui/src/app.ts:353-362`
- Modify: `packages/tui/test/app.test.ts:408-439` — the existing `describe('the ambiguous Escape')`

> **One existing test WILL break, and it is not a nuisance — read this first.**
> `app.test.ts:430` (`'clears an armed ESC timer on restore, so exit does not hang'`) feeds a
> lone `\x1b` and asserts `vi.getTimerCount()` is `1`. After this change a lone ESC arms **no
> timer at all**, so that count is `0`. Its *purpose* — proving a pending timer cannot keep the
> event loop alive past `restore()` — is still valid and still needs covering, so it moves to a
> **truncated sequence**, which does still arm a timer. And the new fact (a held ESC arms
> nothing, which is a *stronger* exit guarantee than before) gets pinned alongside it.
>
> The harness is `h.app.onInput(Uint8Array)` — **not** `h.stdin.push` — and this describe block
> already uses `vi.useFakeTimers()`, so use `vi.advanceTimersByTime`, not a real sleep.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('the ambiguous Escape')` block in
`packages/tui/test/app.test.ts` (it already has `beforeEach(() => { vi.useFakeTimers(); })`):

```ts
  it('resolves Esc then 1 as PA1 however long the gap is', () => {
    // THE REPORTED BUG, 2026-09-14 from a Mac: ESC_TIMEOUT_MS is 50 and a human takes
    // hundreds of ms, so the ESC was discarded and the digit then arrived as ordinary text
    // -- `Esc 1` typed "1". No existing test could catch it: every keymap test hands
    // lookup() a complete `\x1b1`, which is exactly the case that already worked.
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');

    h.app.onInput(Uint8Array.from([0x1b]));
    vi.advanceTimersByTime(5000);                     // a hundred timeouts' worth
    h.app.onInput(Uint8Array.from([0x31]));           // '1'

    expect(sent).toHaveBeenCalledWith(AID.PA1);
    expect(cellText(h.session, 0)).toBe(' ');         // and NOT typed into the field
  });

  it('arms no timer for a lone ESC, which is a stronger exit guarantee than clearing one', () => {
    const h = harness();
    h.app.start();
    h.app.onInput(Uint8Array.from([0x1b]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still discards a TRUNCATED sequence after the timeout', () => {
    // The protection that must survive: `\x1b[` with nothing following is not a Meta prefix,
    // and leaving `[` behind would type a literal bracket into the field.
    const h = harness();
    h.app.start();
    h.app.onInput(new TextEncoder().encode('\x1b['));
    expect(vi.getTimerCount()).toBe(1);               // this one DOES arm a timer
    vi.advanceTimersByTime(100);
    h.app.onInput(new TextEncoder().encode('A'));

    // 'A' is typed as text, NOT resolved as a right-arrow from the stale `\x1b[` prefix.
    expect(cellText(h.session, 0)).toBe('A');
    expect(h.session.screen.cursor).not.toBe(0);
  });

  it('types a digit normally when no ESC came first', () => {
    const h = harness();
    h.app.start();
    const sent = vi.spyOn(h.session, 'sendAID');
    h.app.onInput(Uint8Array.from([0x31]));
    expect(sent).not.toHaveBeenCalled();
    expect(cellText(h.session, 0)).toBe('1');
  });
```

Add `AID` to the file's `@tn3270/core` import.

- [ ] **Step 2: Move the exit-hang test onto a truncated sequence**

Replace the body of the existing `'clears an armed ESC timer on restore, so exit does not hang'`
test — same purpose, different input, plus a note so nobody "restores" the old version:

```ts
  it('clears an armed ESC timer on restore, so exit does not hang', () => {
    // A pending timer keeps the event loop alive, so the process would sit for
    // ESC_TIMEOUT_MS after the terminal was already restored.
    //
    // DRIVEN BY A TRUNCATED SEQUENCE, not a lone ESC, since 2026-09-14: a lone ESC is now
    // HELD as a Meta prefix and arms no timer, so it can no longer set this up. The
    // truncated case is the one that still arms one, and the assertion is unchanged.
    const h = harness();
    h.app.start();
    h.app.onInput(new TextEncoder().encode('\x1b['));
    expect(vi.getTimerCount()).toBe(1);
    h.app.restore();
    expect(vi.getTimerCount()).toBe(0);
  });
```

- [ ] **Step 3: Run and confirm the expected failures**

```bash
cd ~/git/tn3270 && npx vitest run packages/tui/test/app.test.ts
```

Expected: FAIL on `'resolves Esc then 1 as PA1'` (no PA1 sent — the ESC was discarded) and on
`'arms no timer for a lone ESC'` (count is 1, not 0). The other new ones pass already.

- [ ] **Step 4: Implement**

In `packages/tui/src/app.ts`, replace the timeout block at the end of `pump()`:

```ts
      // Every prefix was PARTIAL and the buffer is exhausted: wait for more.
      //
      // A LONE ESC IS HELD, NOT TIMED OUT. It is the Meta prefix -- PA1/PA2/PA3 are ESC-1/2/3
      // -- and a human pressing Esc then 1 takes hundreds of milliseconds, so a 50ms discard
      // meant the PA keys only ever worked when a terminal sent `\x1b1` as ONE burst, i.e.
      // via Option-as-Meta. Reported from a Mac 2026-09-14: `Esc 1` typed the digit.
      //
      // The cost is real and small: a bare Escape with no follow-up leaves one byte buffered,
      // and the next keystroke is consumed by the failed `\x1b`+key lookup. On a 3270 that
      // costs nothing, because Escape has no meaning of its own and was already discarded.
      if (bytes.length === 1 && bytes[0] === 0x1b) return;

      this.escTimer = setTimeout(() => {
        this.escTimer = undefined;
        // A TRUNCATED sequence is still DISCARDED, not typed: an unfinished `\x1b[?` is not
        // text the user asked to send, and leaving `[` behind would type a bracket into the
        // field. Only the lone-ESC case above is held.
        this.buffer = [];
      }, ESC_TIMEOUT_MS);
      return;
```

- [ ] **Step 5: Run and confirm it passes**

```bash
cd ~/git/tn3270 && npx vitest run packages/tui/test/app.test.ts
```

Expected: PASS, including the two pre-existing tests in that block —
`'does nothing at all until the timer fires'` and `'completes the sequence when the rest
arrives in time'` are both still correct under the new behaviour and must **not** be edited.
If either fails, the change went further than intended.

- [ ] **Step 6: Check the exit path still works**

An armed timer keeps the event loop alive after the terminal is restored (`app.ts:200-204`).
The lone-ESC branch arms no timer, so there is nothing new to clear — but confirm the
host-free smoke harness still exits cleanly, since that is what would catch a hang:

```bash
cd ~/git/tn3270 && npm run build && python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -20
```

Expected: 12 of 12, including that ECHO survives exit. A hang here means the buffered ESC is
holding the loop open — it should not, but this is the harness that would tell you.

- [ ] **Step 7: Run the whole suite and commit**

```bash
cd ~/git/tn3270 && npx vitest run
git add packages/tui
git commit -m "fix(tui): hold a lone ESC as a Meta prefix, so Esc-1 really is PA1"
```

---

### Task 9: The default terminal type becomes `IBM-3278-2-E`

**Files:**
- Modify: `packages/core/src/constants.ts:545`
- Modify: `packages/core/test/termtype.test.ts:13`, `telnet.test.ts:64,77`, `session.test.ts:760`
- Modify: `packages/core/src/termtype.ts:126,132-138`, `queryreply.ts:357`, `cli/src/main.ts:122`
- Modify: `packages/cli/scripts/record-vm.txt`

- [ ] **Step 1: Flip the constant**

In `packages/core/src/constants.ts:545`:

```ts
export const TERMINAL_TYPE = 'IBM-3278-2-E';
```

- [ ] **Step 2: Run the suite and confirm EXACTLY the expected four failures**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run 2>&1 | grep -E "^ FAIL|Tests "
```

Expected, measured in advance:

```
 FAIL  packages/core/test/session.test.ts > terminal type negotiation > negotiates IBM-3278-2 when no terminal type is given
 FAIL  packages/core/test/telnet.test.ts > option negotiation > answers a terminal-type query with IBM-3278-2 in ASCII
 FAIL  packages/core/test/telnet.test.ts > option negotiation > advertises an ASCII-only terminal type
 FAIL  packages/core/test/termtype.test.ts > terminal type resolution > defaults to IBM-3278-2, unchanged from stage 1
      Tests  4 failed | 1279 passed
```

**If `conformance.test.ts` or `golden.test.ts` is in that list, STOP.** The spec's premise is
that neither is coupled to the default, and if that is wrong the flip needs rethinking rather
than a test edit.

- [ ] **Step 3: Update the four expectations**

`packages/core/test/termtype.test.ts:13` — and rename the test, since "unchanged from stage 1"
is now false:

```ts
  it('defaults to IBM-3278-2-E, which is what MVS TSO requires', () => {
    // Changed 2026-09-14: a bare IBM-3278-2 gets IKT00405I from MVS 3.8j TSO and no logon
    // (termtype.ts header). Both live systems accept -E, so the default that works on both
    // is the one a user who read no manual should get.
    expect(resolveTerminalType({})).toBe('IBM-3278-2-E');
    expect(resolveTerminalType({})).toBe(TERMINAL_TYPE);
  });
```

`telnet.test.ts:64` and `:77` — change the expected payload string to `'IBM-3278-2-E'` and the
test names to match. `session.test.ts:760` — same. Read each in context; they assert the exact
ASCII the subnegotiation carries.

- [ ] **Step 4: Correct the comments that now misdescribe reality**

`packages/core/src/termtype.ts`, replacing lines 125-138:

```ts
  // The default comes from TERMINAL_TYPE, not from KNOWN_MODELS['3278-2-E']. Both spell
  // IBM-3278-2-E today, but TERMINAL_TYPE is the single source of truth that telnet.ts
  // already defaults to (`opts.terminalType ?? TERMINAL_TYPE`), so the two default paths
  // cannot drift. KNOWN_MODELS is a convenience list of what a user may ask for by number;
  // editing it must never change what a session with no options negotiates.
  //
  // WHY -E IS THE DEFAULT, changed 2026-09-14. A bare IBM-3278-2 is REJECTED by MVS 3.8j
  // TSO with IKT00405I and no logon -- documented at the top of this file since stage 2a and
  // reproduced live through the GUI. Both live systems accept -E, so the flagless default is
  // the one that works on both. `-model 3278-2` still asks for the bare type.
  //
  // AN EARLIER COMMENT HERE CLAIMED THIS WAS LOAD-BEARING FOR THE VM/370 CONFORMANCE
  // COMPARISON. It is not, and the difference was measured rather than argued: flipping this
  // constant fails exactly four expectation tests, while conformance.test.ts and
  // golden.test.ts pass untouched. The offline comparison filters negotiation out of what it
  // diffs (conformance.test.ts, `isNegotiation`), and the live script pins `-model 3278-2`
  // explicitly (packages/cli/scripts/conformance-vm.txt). A stale prohibition costs as much
  // as a missing one.
```

`packages/core/src/queryreply.ts:357` — the clause "TERMINAL_TYPE is IBM-3278-2 regardless"
becomes:

```ts
 * together. Ours do not: TERMINAL_TYPE is IBM-3278-2-E regardless of mode3279, and
```

`packages/cli/src/main.ts:122` — update the "the same IBM-3278-2" phrasing to `IBM-3278-2-E`.

- [ ] **Step 5: Pin the fixture recorder**

`packages/cli/scripts/record-vm.txt` records the committed VM fixture and passes no `-model`,
so after the flip a re-record would negotiate `-E` and no longer reproduce
`vm370-conformance-model2.trace`. Add `-model 3278-2` to its documented invocation, with the
reason:

```
# -model 3278-2 is REQUIRED here and is not a preference. The committed fixture is
# vm370-conformance-model2.trace, recorded against a bare IBM-3278-2. The default became
# IBM-3278-2-E on 2026-09-14, so without this flag a re-record would negotiate something
# else and silently stop matching the capture it is supposed to reproduce.
```

- [ ] **Step 6: Run the whole suite**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/core packages/cli
git commit -m "feat(core): default to IBM-3278-2-E, which is what MVS TSO accepts"
```

---

### Task 10: Documentation

**Files:**
- Modify: `README.md:123-125,140,168-170,173-175`
- Modify: `packages/fixtures/x3270/README.md:8-13`
- Modify: `packages/fixtures/x3270/tso-query-reply.txt:5-6`

- [ ] **Step 1: The GUI's key list (`README.md:123-125`)**

Add the new keys:

```markdown
**`Ctrl-]` quits. `Ctrl-C` does NOT** — it is the Clear AID, which a 3270 user needs
constantly to dismiss VM's `MORE...` state. `Ctrl-R` is Reset, `Ctrl-U` is EraseInput,
`Ctrl-A` is Attn, `Insert` toggles insert mode, F1–F12 are PF1–PF12 and shifted F1–F12 are
PF13–PF24, following c3270. **PA1/PA2/PA3 are `Option`/`Alt` + `1`/`2`/`3`** — matched on the
physical key, so they work whatever your Option key is configured to type. On a Mac where
left-Option is remapped to Command, use right-Option: `Cmd`-digit is deliberately left for
menu accelerators.
```

- [ ] **Step 2: Correct the false claim at `README.md:140`**

It currently lists the GUI's "PA" keys as implemented-but-unverified. They were not
implemented. Change that sentence to name what is actually in that state:

```markdown
**What is implemented but not yet verified against a live host:** the PF and Clear keys (they
travel the same path as ordinary typing, which *is* verified end to end), Attn (a Telnet
BREAK — whether VM/370 acts on it is unmeasured), the `Ctrl-]` quit, and the in-window error
message for a failed connection. **PA1/PA2 need a host that acts on them**, which realistically
means ISPF on MVS.
```

- [ ] **Step 3: The TUI's key list (`README.md:168-170`)**

`Esc 1/2/3` is only true after Task 8, so it ships with the honest detail:

```markdown
`Ctrl-R` is Reset, `Ctrl-U` erases input, `Ctrl-A` is Attn, `Insert` toggles insert mode,
`F1`–`F12` are PF1–12 and `Shift+F1`–`F12` are PF13–24, and **`Esc` `1`/`2`/`3` are
PA1/PA2/PA3** — a lone `Esc` is held as a Meta prefix rather than timed out, so pressing the
two keys a second apart works and no Option-as-Meta configuration is needed. A truncated
escape sequence is still discarded after 50 ms.
```

- [ ] **Step 4: Rewrite the palette paragraph (`README.md:173-175`)**

It currently says the shared palette is in `packages/core` and only the TUI renders gentler
values. Both halves are now false:

```markdown
**Colours come from one shared table in `packages/frontend`, and `-scheme` picks which.**
`default` is the readable one — zti's values for the seven base colours, x3270's for the rest
— and it is what every front end draws unless told otherwise. `3279` is the saturated
alternative: **our own choice of primaries, not a phosphor measurement**, kept because the
manual names each colour without fixing its chromaticity and someone may want the unambiguous
version. `x3270` is that emulator's own `rgbmap`, for comparing against it. `green` is a
monochrome 3278, which is the only one of the four with a claim to authenticity — colour was a
3279 feature. Quantisation to 16 colours is an explicit per-scheme table rather than
nearest-RGB: with any pleasant palette, blue and turquoise both land nearest ANSI cyan.
```

- [ ] **Step 5: Correct the stale fixture claims**

`packages/fixtures/x3270/README.md:8-13` and the header of `tso-query-reply.txt` both say the
exchange "is what our client cannot yet perform, and the reason TSO is unreachable". Query
Reply landed in stage 2a and TSO has since been logged into. In both files, replace that
clause with:

```
# SUPERSEDED CLAIM, corrected 2026-09-14: this header used to say the exchange was one our
# client "cannot yet perform, and the reason TSO is unreachable". Query Reply landed in stage
# 2a, and a live GUI session has since logged on to TSO at 43 rows -- which TSO only reaches
# after this Query is answered. Kept as the byte-level reference for what a real accepted
# answer looks like on this host, not as a description of a gap.
```

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add README.md packages/fixtures
git commit -m "docs: the new keys, the four schemes, and two stale fixture claims"
```

---

### Task 11: Live verification

Nothing here is a unit test, and none of it may be reported as passing without the output in
hand. **The user's Hercules systems must be running** — they IPL them by hand. `ss`/`netstat`
show no listeners in this sandbox; probe with `/dev/tcp` instead.

- [ ] **Step 1: Confirm the hosts are up**

```bash
cd ~/git/tn3270 && for p in 3270 3271; do
  (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null && echo "$p OPEN" || echo "$p CLOSED"
done
```

If both are closed, stop and ask the user to IPL them. Do not proceed and report "verified".

- [ ] **Step 2: The default with NO `-model` at all — the case that was broken**

```bash
cd ~/git/tn3270 && npm run build
node packages/tui/dist/main.js -insecure --colors 256 127.0.0.1:3271
```

Expected: a TSO logon panel, **not** `IKT00405I`. Then the same against `127.0.0.1:3270` for
VM/370, which should be unaffected. Quit with `Ctrl-]`.

- [ ] **Step 3: Confirm the Query Reply exchange in a trace**

The spec requires this to be *seen*, not inferred from a working logon.

```bash
cd ~/git/tn3270 && grep -rn "trace" packages/tui/src/main.ts packages/cli/src/main.ts | head
```

Use whichever trace flag the CLI exposes, connect to MVS with no `-model`, and confirm the
capture contains the host's Write Structured Field / Read Partition (`f3 ... 01 ... 02`) and
our Query Reply answering it. Record the byte offsets in `docs/live-testing.md`.

- [ ] **Step 4: Blue is legible in the GUI**

```bash
cd ~/git/tn3270 && [ -S /tmp/.X11-unix/X99 ] || (nohup Xvfb :99 -screen 0 1920x1080x24 >/tmp/xvfb.log 2>&1 & sleep 2)
DISPLAY=:99 ./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox --disable-gpu \
  -insecure -model 3278-4-E 127.0.0.1:3270
```

Compare rendered ink row by row against what the CLI reports from the same host — the method
that verified the GUI originally. Then repeat with `-scheme 3279` and `-scheme green` and
confirm all three differ as designed.

- [ ] **Step 5: Attn against VM/370 — measure, do not assume**

Connect to VM/370, press `Ctrl-A`, and record what happens. Attn is a Telnet BREAK
(RFC 1576 §8); whether CP acts on it here is **unmeasured**, and the answer belongs in
`docs/live-testing.md` either way. A null result is a result.

- [ ] **Step 6: Write up what was and was not verified**

Add a section to `docs/live-testing.md` covering: the no-flag default on both hosts, the Query
Reply trace offsets, the three schemes, and Attn's measured behaviour. **State plainly that
PA1/PA2 end-to-end is the user's check on their Mac** — the keys can be shown to produce the
right AID here, but only a host that acts on them proves the binding useful.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add docs/live-testing.md
git commit -m "docs(live): the no-flag default, the schemes, and Attn measured on both hosts"
```

---

## Verification checklist

- [ ] `npm run build && npx vitest run` — all pass, count > 1283
- [ ] `npx tsc --noEmit -p packages/frontend && npx tsc --noEmit -p packages/tui && npx tsc --noEmit -p packages/gui`
- [ ] `python3 packages/tui/scripts/pty-smoke.py` — 12 of 12
- [ ] `DISPLAY=:99 node packages/gui/scripts/shot.mjs` — both goldens match without `--update`
- [ ] The renderer-import guard was watched to FAIL (Task 4 Step 3), not merely to pass
- [ ] Task 9 Step 2 saw exactly the four predicted failures and no others
- [ ] The re-baselined golden's ink-pixel set is identical to the old one
