# TUI Front End and 3279 Colour Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store the extended attributes hosts already send us, resolve them into concrete 3279 colours, and ship `packages/tui` — a c3270-style terminal client usable on a box with no X.

**Architecture:** Three layers, each independently testable. (1) `Screen` gains three parallel typed arrays for foreground, background and highlighting, written by new SA/SFE handling in `execute.ts` and surfaced on the existing `Cell` at the `snapshot()` boundary. (2) A new pure `render.ts` resolves protocol attributes into `ResolvedCell[]`, owning the manual's default-colour and `0xF7` rules so no front end reimplements them. (3) `packages/tui` consumes `ResolvedCell[]`, quantises to whatever colour depth `tput` reports, and translates terminal keys into the `Keyboard` actions the core already owns.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), vitest, npm workspaces. **No new dependencies** — colour depth comes from shelling out to `tput`, not from a library.

**Spec:** `docs/superpowers/specs/2026-08-19-tui-and-colour-design.md` — read it first. It records why each decision was made, which two rules are protocol rather than preference, and what is deliberately out of scope.

---

## Before you start

**Baseline:** branch `main`, **695 tests passing**, `npm run typecheck` clean, working tree clean. Verify with `npm test` before Task 1; if it is not green, stop and report rather than building on a broken base.

**Build command is `npm run build`, NOT `npm run build --workspaces`** — the latter fails on the data-only fixtures package.

**The project's standing rule, which this plan depends on:** verify every wire constant against `~/3270/ref/pages.txt` (greppable text of GA23-0059) or x3270's source at `~/src/suite3270-4.5/`, never from memory and never by copying this plan. **If a byte in this plan disagrees with the manual, the manual wins and the plan is wrong** — say so rather than making the test match the plan. This rule has already caught six defects in the stage 2a plan and four in this spec during its own review.

**Two specific traps this plan inherits, both already paid for:**

1. **The colour table in the manual is OCR-damaged.** Table 4-7 (`pages.txt:3527-3541`) prints `X'FB'` **twice**, for both Black and Purple, and renders F7 as `X'F?'`. The correct values are Black `0xF8` and Purple `0xFB`, confirmed against `~/src/suite3270-4.5/include/3270ds.h:313-328`. Task 2 requires you to check all sixteen against that header.

2. **Never count orders in a trace with a hex grep.** `grep -oE "28 42"` matches SBA/RA address bytes and payload data, and misses orders split across a `+` continuation line. It gave 97 where the parser gives 101, and it hid the twelve `0x00` resets entirely. Use `node packages/cli/scripts/count-orders.mjs`, which is committed for exactly this reason.

**Do not implement Programmable Symbol Sets.** Attribute type `0x43` (character set) stays parsed-and-dropped, and `setAttributeIgnored` must keep counting what is still genuinely ignored — a zero there has to keep meaning "we never saw one" rather than "we stopped looking".

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `packages/core/src/palette.ts` | The sixteen 3279 colour identifications and their RGB values. Pure data plus a lookup. Core-side because the GUI needs the same RGB for canvas. |
| `packages/core/src/render.ts` | Resolve a `ScreenSnapshot` into `ResolvedCell[]`: SA/SFE override, base-attribute fallback, the `0x00` and `0xF7` rules, `mode3279`. Pure. |
| `packages/core/test/palette.test.ts` | All sixteen entries pinned against `3270ds.h`. |
| `packages/core/test/render.test.ts` | One test per resolution rule, plus the TK5 fixture replay. |
| `packages/core/test/sa.test.ts` | SA running state: composite, per-write reset, Clear reset, SF reset, EW/EWA reset. |
| `packages/tui/package.json` | Workspace manifest for the TUI package. |
| `packages/tui/tsconfig.json` | Project reference to core, matching the CLI's. |
| `packages/tui/src/colours.ts` | Depth detection (`tput`, `COLORTERM`, override) and quantisation of a palette entry to an ANSI SGR string. |
| `packages/tui/src/render.ts` | `ResolvedCell[]` → ANSI, with dirty-cell diffing. Owns the screen-too-small check. |
| `packages/tui/src/keymap.ts` | Terminal byte sequences → named core actions. No 3270 semantics. |
| `packages/tui/src/app.ts` | Wires `Session` events to the renderer; owns the run loop and raw-mode teardown. |
| `packages/tui/src/main.ts` | argv, TCP transport, entry point. |
| `packages/tui/test/colours.test.ts` | Quantisation at each of the four depths; detection precedence. |
| `packages/tui/test/keymap.test.ts` | Sequence → action mapping, including the ambiguous-Escape case. |
| `packages/tui/test/render.test.ts` | ANSI emission and dirty-cell diffing. |

**Modify:**

| File | Change |
|---|---|
| `packages/core/src/constants.ts` | Add `XA` attribute types, `XAH` highlighting values, and `XAC_DEFAULT`. |
| `packages/core/src/screen.ts` | Three parallel arrays; extend `Cell` and `snapshot()`; reset attributes in `clear()`, `setFieldAttribute()` and `eraseAllUnprotected()`. |
| `packages/core/src/stream/execute.ts` | SA running state as a per-type map; apply to written characters; seed SFE field attributes; reset per write command. |
| *(`packages/core/src/stream/parse.ts` — **no change needed**, see below)* | — |
| `packages/core/src/queryreply.ts` | Add Color (`0x86`) and Highlighting (`0x87`) capability entries. |
| `packages/core/src/index.ts` | Export `palette.ts` and `render.ts`. |
| `packages/cli/src/runner.ts` | `ScreenJson` gains resolved colours, so the CLI can see them without a TUI. |
| `package.json` | Add `packages/tui` to typecheck. |
| `docs/HANDOFF.md` | Update state at the end. |

**THE PARSER NEEDS NO CHANGES, which is worth stating because an earlier draft of this
plan said it did.** Verified by reading it: `parse.ts:74` already emits
`{ kind: 'sfe', pairs }` with **every** type-value pair decoded (`:265-268`), and
`:72` already emits `{ kind: 'deferred', order: Order.SA, data }` with SA's 2-byte
type/value payload intact (`:245`). Both carriers are fully parsed today and the
information is discarded *downstream*, in `execute.ts`. So this is an executor change
only — do not restructure the parser, and if you find yourself wanting to, re-read
those lines first.

**Ordering rationale:** constants → palette → storage → SA execution → resolution → Query Reply → TUI. Each task builds on committed, tested work below it, and the whole core half is done and provable against the committed TK5 fixture before any terminal code exists.

---

## Task 1: Attribute type and value constants

**Files:**
- Modify: `packages/core/src/constants.ts` (append after the `FA` block, which ends at line 279)
- Test: `packages/core/test/constants.test.ts`

Extended attributes are carried by two orders we already parse. This task only names the bytes; nothing consumes them yet.

- [ ] **Step 1: Verify every value against x3270 before writing anything**

Run:
```bash
grep -n "XA_HIGHLIGHTING" -A 6 ~/src/suite3270-4.5/include/3270ds.h
grep -n "XA_FOREGROUND" -A 4 ~/src/suite3270-4.5/include/3270ds.h
```

Expected output, and the plan is wrong if it differs:
```
240:#define XA_HIGHLIGHTING	0x41
241:#define  XAH_DEFAULT	0x00
242:#define  XAH_NORMAL	0xf0
243:#define  XAH_BLINK	0xf1
244:#define  XAH_REVERSE	0xf2
245:#define  XAH_UNDERSCORE	0xf4
246:#define  XAH_INTENSIFY	0xf8
247:#define XA_FOREGROUND	0x42
248:#define  XAC_DEFAULT	0x00
249:#define XA_CHARSET	0x43
250:#define XA_BACKGROUND	0x45
```

Note `0xf8` intensify — there are **six** highlighting values, not four. An earlier draft of the spec stopped at underscore.

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/constants.test.ts`:

```ts
describe('extended attribute types and values', () => {
  it('names the attribute types from 3270ds.h:240-250', () => {
    expect(XA.RESET).toBe(0x00);
    expect(XA.HIGHLIGHTING).toBe(0x41);
    expect(XA.FOREGROUND).toBe(0x42);
    expect(XA.CHARSET).toBe(0x43);
    expect(XA.BACKGROUND).toBe(0x45);
  });

  it('names all six highlighting values, including intensify', () => {
    expect(XAH.DEFAULT).toBe(0x00);
    expect(XAH.NORMAL).toBe(0xf0);
    expect(XAH.BLINK).toBe(0xf1);
    expect(XAH.REVERSE).toBe(0xf2);
    expect(XAH.UNDERSCORE).toBe(0xf4);
    expect(XAH.INTENSIFY).toBe(0xf8);
  });

  it('XA.RESET is a TYPE meaning reset-all, distinct from XAC_DEFAULT as a VALUE', () => {
    // Both are 0x00 and conflating them is a real bug: as a type it means "return
    // every character attribute to default" (pages.txt:2991); as a value under
    // XA.FOREGROUND it means "device default colour". The TK5 fixture contains
    // twelve of the former.
    expect(XA.RESET).toBe(XAC_DEFAULT);
    expect(XA.RESET).not.toBe(XA.FOREGROUND);
  });
});
```

Add `XA`, `XAH`, `XAC_DEFAULT` to the existing import from `../src/constants.js`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/constants.test.ts -t "extended attribute"`
Expected: FAIL — `XA is not defined`.

- [ ] **Step 4: Implement**

Append to `packages/core/src/constants.ts`:

```ts
/**
 * Extended attribute types, carried by SA (X'28') and as SFE type-value pairs.
 * x3270's include/3270ds.h:240-250.
 *
 * `RESET` is 0x00 AS A TYPE and means "return every character attribute type to
 * its default" — the manual: "The attribute type X'00' is always supported by
 * the SA order" (pages.txt:2991). Do not confuse it with `XAC_DEFAULT`, which is
 * 0x00 as a VALUE under FOREGROUND/BACKGROUND and means "device default colour".
 * Both appear in the committed TK5 fixture (101 FOREGROUND, 12 RESET), so a
 * conflation is not hypothetical.
 *
 * CHARSET is named but deliberately NOT implemented — it selects Programmable
 * Symbol Sets, which are out of scope. It stays counted by setAttributeIgnored.
 */
export const XA = {
  RESET: 0x00,
  HIGHLIGHTING: 0x41,
  FOREGROUND: 0x42,
  CHARSET: 0x43,
  BACKGROUND: 0x45,
} as const;

/** Highlighting values for `XA.HIGHLIGHTING`. 3270ds.h:241-246. */
export const XAH = {
  DEFAULT: 0x00,
  NORMAL: 0xf0,
  BLINK: 0xf1,
  REVERSE: 0xf2,
  UNDERSCORE: 0xf4,
  INTENSIFY: 0xf8,
} as const;

/** Colour value meaning "the device default", per Query Reply (Color). 3270ds.h:248. */
export const XAC_DEFAULT = 0x00;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/test/constants.test.ts`
Expected: PASS, and the pre-existing constants tests still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/constants.ts packages/core/test/constants.test.ts
git commit -m "Name the extended attribute types and highlighting values"
```

---

## Task 2: The 3279 palette

**Files:**
- Create: `packages/core/src/palette.ts`
- Create: `packages/core/test/palette.test.ts`
- Modify: `packages/core/src/index.ts`

Sixteen colour identifications and their RGB values. This lives in core, not the TUI, because the GUI needs the same RGB values for canvas fills and the web front end will need them for CSS.

- [ ] **Step 1: Verify all sixteen against x3270, because the manual's table is OCR-damaged**

Run:
```bash
sed -n '3527,3541p' ~/3270/ref/pages.txt
grep -n -A 16 "HOST_COLOR_NEUTRAL_BLACK" ~/src/suite3270-4.5/include/3270ds.h
```

The manual's Table 4-7 prints **`X'FB'` twice** — for Black and again for Purple — and renders F7 as `X'F?'`. x3270's header gives the unambiguous ordering: index 0-15 maps to `0xF0`-`0xFF` contiguously, so Black is `0xF8` and Purple is `0xFB`. **If your reading of either source disagrees with the table below, stop and report it.**

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/palette.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { COLOUR_NAMES, PALETTE_3279, colourRgb, Colour } from '../src/palette.js';

describe('3279 palette', () => {
  it('maps all sixteen identifications contiguously from 0xF0', () => {
    const codes = Object.keys(PALETTE_3279).map(Number).sort((a, b) => a - b);
    expect(codes).toEqual([
      0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7,
      0xf8, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff,
    ]);
  });

  it('names them per 3270ds.h:313-328, with Black 0xF8 and Purple 0xFB', () => {
    // The manual's Table 4-7 OCRs BOTH of these as X'FB'. This test is the
    // guard against transcribing that damage.
    expect(COLOUR_NAMES[0xf8]).toBe('black');
    expect(COLOUR_NAMES[0xfb]).toBe('purple');
    expect(COLOUR_NAMES[0xf0]).toBe('neutral-black');
    expect(COLOUR_NAMES[0xf7]).toBe('neutral-white');
  });

  it('names the seven base 3279 colours at their architected codes', () => {
    expect(COLOUR_NAMES[Colour.BLUE]).toBe('blue');
    expect(COLOUR_NAMES[Colour.RED]).toBe('red');
    expect(COLOUR_NAMES[Colour.PINK]).toBe('pink');
    expect(COLOUR_NAMES[Colour.GREEN]).toBe('green');
    expect(COLOUR_NAMES[Colour.TURQUOISE]).toBe('turquoise');
    expect(COLOUR_NAMES[Colour.YELLOW]).toBe('yellow');
    expect(COLOUR_NAMES[Colour.WHITE]).toBe('white');
    expect(Colour.BLUE).toBe(0xf1);
    expect(Colour.GREEN).toBe(0xf4);
  });

  it('gives every entry an RGB triple', () => {
    for (const code of Object.keys(PALETTE_3279).map(Number)) {
      const rgb = colourRgb(code);
      expect(rgb).toHaveLength(3);
      for (const c of rgb) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });

  it('throws on a code outside 0xF0-0xFF rather than guessing', () => {
    // A malformed attribute must be caught by the resolver, which substitutes a
    // default; it must never reach here and silently produce black.
    expect(() => colourRgb(0x99)).toThrow(/not a 3279 colour/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/palette.test.ts`
Expected: FAIL — cannot resolve `../src/palette.js`.

- [ ] **Step 4: Implement**

Create `packages/core/src/palette.ts`:

```ts
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
 * Table 4-7 (GA23-0059 p. 4-20, pages.txt:3527-3541) prints `X'FB'` TWICE, for
 * both Black and Purple, and renders F7 as `X'F?'`. The codes are in fact
 * contiguous 0xF0-0xFF, so Black is 0xF8 and Purple 0xFB — confirmed against
 * x3270's include/3270ds.h:313-328, whose HOST_COLOR_* run 0..15 in the same
 * order. palette.test.ts pins both of the damaged entries.
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
```

- [ ] **Step 5: Export it**

Add to `packages/core/src/index.ts`, after the `codepage.js` line:

```ts
export * from './palette.js';
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npx vitest run packages/core/test/palette.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/palette.ts packages/core/src/index.ts packages/core/test/palette.test.ts
git commit -m "Add the 3279 palette, with the two OCR-damaged codes pinned"
```

---

## Task 3: Per-cell attribute storage in `Screen`

**Files:**
- Modify: `packages/core/src/screen.ts`
- Test: `packages/core/test/screen.test.ts`

Three parallel typed arrays, following the file's existing "flat arrays, fields derived" decision. The struct appears only at the `snapshot()` boundary, where consumers live — see the spec's note on x3270's `struct ea` versus `tnz`'s parallel planes.

**Four reset rules land here, and all four are in the manual.** Two are new methods; two are additions to methods that already exist.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/screen.test.ts`:

```ts
describe('extended attribute storage', () => {
  it('defaults every cell to no extended attributes', () => {
    const s = new Screen();
    const c = s.cellAt(0);
    expect(c.fg).toBeUndefined();
    expect(c.bg).toBeUndefined();
    expect(c.gr).toBeUndefined();
  });

  it('stores and returns foreground, background and highlighting', () => {
    const s = new Screen();
    s.setChar(5, 0xc1);
    s.setExtended(5, { fg: 0xf2, bg: 0xf1, gr: 0xf4 });
    const c = s.cellAt(5);
    expect(c.fg).toBe(0xf2);
    expect(c.bg).toBe(0xf1);
    expect(c.gr).toBe(0xf4);
  });

  it('setExtended merges rather than replacing, so one type does not clear another', () => {
    // The manual's composite rule (pages.txt:2995-2997): the applied set is a
    // composite BY ATTRIBUTE TYPE. Setting colour must not wipe highlighting.
    const s = new Screen();
    s.setExtended(5, { gr: 0xf1 });
    s.setExtended(5, { fg: 0xf2 });
    expect(s.cellAt(5).gr).toBe(0xf1);
    expect(s.cellAt(5).fg).toBe(0xf2);
  });

  it('clearExtended returns one cell to defaults', () => {
    const s = new Screen();
    s.setExtended(5, { fg: 0xf2, bg: 0xf1, gr: 0xf4 });
    s.clearExtended(5);
    const c = s.cellAt(5);
    expect(c.fg).toBeUndefined();
    expect(c.bg).toBeUndefined();
    expect(c.gr).toBeUndefined();
  });

  it('clear() resets extended attributes as well as characters', () => {
    // EW/EWA "resets any extended field attributes and character attributes
    // associated with the nulled characters to their default values"
    // (pages.txt:2988-2991). clear() is also what the Clear AID calls
    // (session.ts:350-353), which is the manual's fourth SA reset trigger.
    const s = new Screen();
    s.setExtended(5, { fg: 0xf2 });
    s.clear();
    expect(s.cellAt(5).fg).toBeUndefined();
  });

  it('setFieldAttribute clears the attribute cell own extended attributes', () => {
    // "If the display receives an SF order, it sets the associated extended
    // field attribute to its default value" (pages.txt:2874-2875). A field
    // following a coloured one must not inherit colour it was never given.
    const s = new Screen();
    s.setExtended(10, { fg: 0xf2, gr: 0xf1 });
    s.setFieldAttribute(10, 0xc0);
    expect(s.cellAt(10).fg).toBeUndefined();
    expect(s.cellAt(10).gr).toBeUndefined();
  });

  it('eraseAllUnprotected clears extended attributes in unprotected fields only', () => {
    const s = new Screen();
    s.setFieldAttribute(0, 0xc0);          // unprotected
    s.setFieldAttribute(10, 0xe0);         // protected
    s.setChar(5, 0xc1);
    s.setExtended(5, { fg: 0xf2 });
    s.setChar(15, 0xc2);
    s.setExtended(15, { fg: 0xf3 });
    s.eraseAllUnprotected();
    expect(s.cellAt(5).fg).toBeUndefined();
    expect(s.cellAt(15).fg).toBe(0xf3);    // protected field survives
  });

  it('snapshot carries extended attributes and is frozen', () => {
    const s = new Screen();
    s.setChar(5, 0xc1);
    s.setExtended(5, { fg: 0xf2 });
    const snap = s.snapshot();
    expect(snap.cells[5]!.fg).toBe(0xf2);
    expect(() => {
      (snap.cells[5] as { fg?: number }).fg = 0xf1;
    }).toThrow();
  });

  it('omits absent attributes from the snapshot rather than defaulting them', () => {
    // Absence is protocol-meaningful: it means "fall through to the base field
    // attribute", which is NOT the same as any concrete colour. Storing 0x00
    // here would erase the distinction, because 0x00 as a VALUE means
    // "device default" and would resolve identically -- but only by accident.
    const s = new Screen();
    s.setChar(5, 0xc1);
    const snap = s.snapshot();
    expect('fg' in snap.cells[5]!).toBe(false);
  });

  it('setExtended rejects an out-of-range address', () => {
    const s = new Screen();
    expect(() => s.setExtended(-1, { fg: 0xf2 })).toThrow(RangeError);
    expect(() => s.setExtended(s.size, { fg: 0xf2 })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/screen.test.ts -t "extended attribute storage"`
Expected: FAIL — `s.setExtended is not a function`.

- [ ] **Step 3: Extend the `Cell` type and `ScreenSnapshot`**

In `packages/core/src/screen.ts`, replace the `Cell` declaration (line 21) and its comment:

```ts
/**
 * Cell content is a tagged variant. Stage 1 had exactly one case; Programmable
 * Symbol Sets (a committed stage 4 deliverable) will add
 * `{ kind: 'ps', store, index }`, and consumers must dispatch on `kind` rather
 * than assume a code page lookup.
 *
 * The three extended attributes are OPTIONAL and their absence is meaningful:
 * it means "this cell specifies nothing, fall through to the base field
 * attribute". That is not the same as any concrete colour, so do not default
 * them to 0x00 — `render.ts` needs the distinction. This mirrors x3270's
 * `struct ea` (include/globals.h:364-374), which likewise carries the character
 * and its attributes together.
 */
export type Cell = {
  kind: 'char';
  ebcdic: number;
  /** Foreground colour identification, 0xF0-0xFF. Absent means unspecified. */
  fg?: number;
  /** Background colour identification, 0xF0-0xFF. Absent means unspecified. */
  bg?: number;
  /** Highlighting value (`XAH.*`). Absent means unspecified. */
  gr?: number;
};

/** The subset of a cell's attributes a caller may set. See `Screen.setExtended`. */
export interface ExtendedAttributes {
  fg?: number;
  bg?: number;
  gr?: number;
}
```

- [ ] **Step 4: Add the three arrays and the accessors**

In the `Screen` class, after the `attrs` declaration (line 80), add:

```ts
  /**
   * Extended attributes, one array each, parallel to `chars`.
   *
   * 0 means "unspecified" and is distinguishable from every real value because
   * every architected colour is 0xF0-0xFF and every highlighting value is 0x00
   * (default) or 0xF0-0xF8 — so 0 is never a value a host can set. Storing
   * `XAH.DEFAULT` (0x00) explicitly is therefore impossible here, which is
   * correct: "default" and "unspecified" resolve identically, and SA type 0x00
   * clears back to unspecified rather than writing a value.
   */
  private readonly fgs: Uint8Array;
  private readonly bgs: Uint8Array;
  private readonly grs: Uint8Array;
```

In the constructor, after `this.attrs = ...`:

```ts
    this.fgs = new Uint8Array(this.size);
    this.bgs = new Uint8Array(this.size);
    this.grs = new Uint8Array(this.size);
```

Replace `cellAt` (line 139-142) with:

```ts
  cellAt(addr: number): Cell {
    this.check(addr);
    const cell: Cell = { kind: 'char', ebcdic: this.chars[addr]! };
    // Conditional assignment, not `fg: x || undefined`: the property must be
    // ABSENT when unspecified, because `'fg' in cell` is how a consumer asks.
    if (this.fgs[addr]! !== 0) cell.fg = this.fgs[addr]!;
    if (this.bgs[addr]! !== 0) cell.bg = this.bgs[addr]!;
    if (this.grs[addr]! !== 0) cell.gr = this.grs[addr]!;
    return cell;
  }

  /**
   * Merge extended attributes into one cell.
   *
   * MERGE, NOT REPLACE, because the manual's composite rule requires it: "The
   * set of type-value pairs applied during character processing is a composite,
   * by attribute type, of the last value specified in previously encountered SA
   * orders" (p. 4-7, pages.txt:2995-2997). An SA setting colour must leave a
   * previously set highlighting alone. Pass `clearExtended` to reset.
   */
  setExtended(addr: number, ext: ExtendedAttributes): void {
    this.check(addr);
    if (ext.fg !== undefined) this.fgs[addr] = ext.fg & 0xff;
    if (ext.bg !== undefined) this.bgs[addr] = ext.bg & 0xff;
    if (ext.gr !== undefined) this.grs[addr] = ext.gr & 0xff;
  }

  /** Return one cell's extended attributes to "unspecified". */
  clearExtended(addr: number): void {
    this.check(addr);
    this.fgs[addr] = 0;
    this.bgs[addr] = 0;
    this.grs[addr] = 0;
  }
```

- [ ] **Step 5: Wire the three reset rules**

In `setChar` (line 149), leave the extended attributes ALONE — a character written into a cell picks up whatever SA state the executor applies, and the executor calls `setExtended` itself. Add this comment above the method body so nobody "fixes" it:

```ts
    // Deliberately does NOT touch fgs/bgs/grs. The executor decides what
    // extended attributes a written character carries (it holds the running SA
    // state) and calls setExtended right after this. Clearing here would
    // discard them a moment later.
```

In `setFieldAttribute` (line 172), add after `this.chars[addr] = 0x00;`:

```ts
    // "If the display receives an SF order, it sets the associated extended
    // field attribute to its default value" (p. 4-4, pages.txt:2874-2875). SFE
    // overrides this by calling setExtended AFTER this returns; a plain SF must
    // leave the position clean, or a field following a coloured one inherits
    // colour the host never gave it.
    this.clearExtended(addr);
```

In `clear()` (line 268), add after `this.attrs.fill(NOT_ATTR);`:

```ts
    // EW/EWA "resets any extended field attributes and character attributes
    // associated with the nulled characters to their default values"
    // (pages.txt:2988-2991). This is also the path the Clear AID takes
    // (session.ts:350-353), which is the manual's fourth SA reset trigger --
    // "The Clear key is pressed" (pages.txt:2980). So implementing it here
    // satisfies both rules at once.
    this.fgs.fill(0);
    this.bgs.fill(0);
    this.grs.fill(0);
```

In `eraseAllUnprotected()`, inside the per-cell loop, after `this.chars[a] = 0x00;`:

```ts
        this.fgs[a] = 0;
        this.bgs[a] = 0;
        this.grs[a] = 0;
```

- [ ] **Step 6: Carry them into `snapshot()`**

Replace the cell-building line inside `snapshot()` (line 391):

```ts
      cells[i] = Object.freeze(this.cellAt(i));
```

This reuses `cellAt`'s conditional-property logic rather than duplicating it, which is what keeps the "absent means unspecified" invariant in one place.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run packages/core/test/screen.test.ts && npm run typecheck`
Expected: PASS, all pre-existing screen tests included, typecheck clean.

- [ ] **Step 8: Run the whole suite — this touches a load-bearing type**

Run: `npm test`
Expected: 695 + 11 new = 706 passing, 0 failing. `Cell` gained only optional members, so no existing consumer should break; if one does, read the failure rather than casting it away.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/screen.ts packages/core/test/screen.test.ts
git commit -m "Store extended attributes per cell, with the manual's four reset rules"
```

---

## Task 4: SA running state in the executor

**Files:**
- Modify: `packages/core/src/stream/execute.ts`
- Create: `packages/core/test/sa.test.ts`

**This is the task most likely to ship a bug**, so every rule in the manual's list gets its own test. The rules, from p. 4-6 (`pages.txt:2969-2984`), quoted in the spec:

> An SA order alters the set of character attribute type-value pairs to be applied to all subsequent characters until one of the following occurs: • A new SA order changes it. • Another write type command is sent. • The Clear key is pressed. • Power at the display is switched off.

Reset trigger 3 (Clear) is already satisfied by Task 3's change to `clear()`. Trigger 4 is a power switch. So this task implements triggers 1 and 2, plus the composite rule and SFE seeding.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/sa.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Screen } from '../src/screen.js';
import { parseRecord } from '../src/stream/parse.js';
import { execute } from '../src/stream/execute.js';
import { Command, Order, XA, XAH, Colour } from '../src/constants.js';

/** Build and run a write record, returning the screen it produced. */
function run(bytes: number[], screen = new Screen()): Screen {
  execute(screen, parseRecord(Uint8Array.from(bytes)));
  return screen;
}

// Write, WCC 0, then whatever the caller wants. 0xf1 is Write; 0x40 is a WCC
// with no bits that matter here.
const W = [0xf1, 0x40];
/** SBA to address 0: 0x11 then the 12-bit encoding of 0. */
const SBA0 = [0x11, 0x40, 0x40];

describe('SA sets character attributes on subsequent characters', () => {
  it('applies to characters written after it, and not before', () => {
    const s = run([
      ...W, ...SBA0,
      0xc1,                                    // 'A' before any SA
      0x28, XA.FOREGROUND, Colour.RED,         // SA fg=red
      0xc2,                                    // 'B' after
    ]);
    expect(s.cellAt(0).fg).toBeUndefined();
    expect(s.cellAt(1).fg).toBe(Colour.RED);
  });

  it('persists across many characters until changed', () => {
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1, 0xc2, 0xc3,
      0x28, XA.FOREGROUND, Colour.BLUE,
      0xc4,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(1).fg).toBe(Colour.RED);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
    expect(s.cellAt(3).fg).toBe(Colour.BLUE);
  });

  it('is a COMPOSITE by type: setting colour leaves highlighting alone', () => {
    // pages.txt:2995-2997. Modelling SA state as a single value instead of a
    // per-type map silently drops attributes, and this is the test that catches it.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.HIGHLIGHTING, XAH.REVERSE,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc1,
    ]);
    expect(s.cellAt(0).gr).toBe(XAH.REVERSE);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
  });

  it('handles background as well as foreground', () => {
    const s = run([
      ...W, ...SBA0,
      0x28, XA.BACKGROUND, Colour.BLUE,
      0xc1,
    ]);
    expect(s.cellAt(0).bg).toBe(Colour.BLUE);
  });

  it('SA type 0x00 resets ALL character attributes to default', () => {
    // The twelve occurrences in the TK5 fixture are this case.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.RED,
      0x28, XA.HIGHLIGHTING, XAH.BLINK,
      0xc1,
      0x28, XA.RESET, 0x00,
      0xc2,
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(0).gr).toBe(XAH.BLINK);
    expect(s.cellAt(1).fg).toBeUndefined();
    expect(s.cellAt(1).gr).toBeUndefined();
  });

  it('a colour VALUE of 0x00 is stored, unlike a reset TYPE of 0x00', () => {
    // XAC_DEFAULT means "device default colour" and is a legitimate value the
    // host can set; SA type 0x00 means "reset everything". Both are 0x00 and
    // they are NOT the same operation.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.HIGHLIGHTING, XAH.BLINK,
      0x28, XA.FOREGROUND, 0x00,   // fg := device default, highlighting UNTOUCHED
      0xc1,
    ]);
    expect(s.cellAt(0).gr).toBe(XAH.BLINK);
  });

  it('RESETS at the start of every write command', () => {
    // "Another write type command is sent" (pages.txt:2977). x3270 zeroes
    // default_fg/bg/gr at the top of write processing, ctlr.c:1414-1416.
    const s = new Screen();
    run([...W, ...SBA0, 0x28, XA.FOREGROUND, Colour.RED, 0xc1], s);
    run([...W, 0x11, 0x40, 0x41, 0xc2], s);   // second Write, SBA to 1
    expect(s.cellAt(0).fg).toBe(Colour.RED);
    expect(s.cellAt(1).fg).toBeUndefined();
  });

  it('applies SA state to RA-filled characters too', () => {
    // RA writes characters; they are "subsequently interpreted characters" and
    // must carry the running attributes like any other.
    const s = run([
      ...W, ...SBA0,
      0x28, XA.FOREGROUND, Colour.PINK,
      0x3c, 0x40, 0x43, 0xc1,     // RA to address 3, fill 'A'
    ]);
    expect(s.cellAt(0).fg).toBe(Colour.PINK);
    expect(s.cellAt(2).fg).toBe(Colour.PINK);
  });

  it('still counts genuinely unimplemented SA types as ignored', () => {
    // CHARSET is out of scope (PS). setAttributeIgnored must keep counting it,
    // or a zero there stops meaning "we never saw one".
    const r = execute(new Screen(), parseRecord(Uint8Array.from([
      ...W, ...SBA0, 0x28, XA.CHARSET, 0xf1, 0xc1,
    ])));
    expect(r.setAttributeIgnored).toBe(1);
  });

  it('does NOT count the SA types it now implements', () => {
    const r = execute(new Screen(), parseRecord(Uint8Array.from([
      ...W, ...SBA0, 0x28, XA.FOREGROUND, Colour.RED, 0xc1,
    ])));
    expect(r.setAttributeIgnored).toBe(0);
  });
});

describe('SFE seeds field-level extended attributes', () => {
  it('applies a colour pair to the characters in the field', () => {
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,  // SFE: basic + fg
      0xc1, 0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(2).fg).toBe(Colour.YELLOW);
  });

  it('a plain SF after a coloured SFE does not inherit its colour', () => {
    // pages.txt:2874-2875, and Task 3's setFieldAttribute change.
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x1d, 0xc0,        // plain SF
      0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(3).fg).toBeUndefined();
  });

  it('a character-level SA overrides the field-level SFE colour', () => {
    const s = run([
      ...W, ...SBA0,
      0x29, 0x02, 0xc0, 0xc0, XA.FOREGROUND, Colour.YELLOW,
      0xc1,
      0x28, XA.FOREGROUND, Colour.RED,
      0xc2,
    ]);
    expect(s.cellAt(1).fg).toBe(Colour.YELLOW);
    expect(s.cellAt(2).fg).toBe(Colour.RED);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/sa.test.ts`
Expected: FAIL. Most assertions get `undefined` where a colour is expected.

- [ ] **Step 3: Add the SA state type**

In `packages/core/src/stream/execute.ts`, after the imports, add:

```ts
/**
 * The running character-attribute state an SA order maintains.
 *
 * A MAP BY TYPE, not a single value, because the manual requires a composite:
 * "The set of type-value pairs applied during character processing is a
 * composite, by attribute type, of the last value specified in previously
 * encountered SA orders" (p. 4-7, pages.txt:2995-2997). One value would make an
 * SA colour silently clear a preceding SA highlighting.
 *
 * Lives for one write command and is discarded: "Another write type command is
 * sent" returns the set to defaults (pages.txt:2977), which x3270 does by zeroing
 * default_fg/bg/gr at the top of write processing (ctlr.c:1414-1416). The Clear
 * key -- the manual's third trigger -- resets it through Screen.clear() instead,
 * because Clear originates locally rather than in a datastream.
 */
interface SaState {
  fg?: number;
  bg?: number;
  gr?: number;
}
```

- [ ] **Step 4: Thread the state through the token loop**

`applyToken` is currently a free function taking `(screen, token, addr)`. Give it the state as a fourth parameter. In the token loop in `execute`, before it begins:

```ts
  // Fresh per write command; see SaState. This is reset trigger 2.
  const sa: SaState = {};
```

and change the call site to pass `sa`.

- [ ] **Step 5: Apply the state where characters are written**

In `applyToken`'s `'data'` case, replace the loop body:

```ts
    case 'data': {
      let a = addr;
      for (const b of token.bytes) {
        screen.setChar(a, b);
        applySa(screen, a, sa);
        a = screen.inc(a);
      }
      wroteSinceOrder = true;
      return a;
    }
```

Do the same inside the `'ra'` case's fill loop and the `'ge'` case, wherever `setChar` is called on a position the host is filling with data.

**`'eua'` and `'pt'` must CLEAR rather than stamp — also corrected after implementation.** An earlier version of this plan said "do not apply it in `'eua'`, which nulls rather than writes." Half right: EUA must not *stamp* the running state, but it must *clear* what is there, because Task 3 made `setChar` leave extended attributes alone and so nulling a cell would otherwise leave its colour behind. The manual says so directly: "Field attributes and extended field attributes are not affected by EUA. **Character attributes for every character changed to nulls are reset to their defaults**" (`pages.txt:3165-3166`). PT is the same case (`pages.txt:3090-3091`; x3270 `ctlr.c:1555-1560`), gated on `wroteSinceOrder` since a PT following an order leaves the buffer unmodified.

Add the helper beside `applyToken`:

```ts
/**
 * Stamp the running SA state onto a cell just written.
 *
 * Called after `setChar`, never before: `setChar` deliberately leaves extended
 * attributes alone (see its comment) precisely so this can run second.
 *
 * CLEAR THEN SET — an ASSIGNMENT, not a merge. See the warning below.
 */
function applySa(screen: Screen, addr: number, sa: SaState): void {
  screen.clearExtended(addr);
  screen.setExtended(addr, sa);
}
```

> **⚠️ CORRECTED 2026-08-19 AFTER IMPLEMENTATION FOUND A REAL BUG HERE.** An earlier
> version of this plan wrote `applySa` as an early return plus a merge:
>
> ```ts
> if (sa.fg === undefined && sa.bg === undefined && sa.gr === undefined) return;
> screen.setExtended(addr, sa);   // WRONG
> ```
>
> That is silently incorrect, because Task 3's `setExtended` **merges** (rightly — the
> composite rule needs it). So a cell overwritten by a later record with no SA in effect
> **keeps the previous record's colour**. Stale colour on rewritten cells, no error.
>
> The manual is explicit and was sitting there the whole time: "Character attributes are
> associated with a character and not with the character's position in the buffer. Thus,
> whenever a character is overwritten by a new character (or cleared or erased), the old
> character attribute is overwritten by the character attribute of the new character"
> (**`pages.txt:3388-3391`**). x3270 has no such hazard: it stamps all three
> unconditionally (`ctlr.c:2141-2143`) through `ctlr_add_fg`, which **assigns**
> (`ea_buf[baddr].fg = color`, `ctlr.c:2865`).
>
> **The plan's own reset-per-write-command test does not catch this**, because it writes
> the second record to a *different address* and so never exercises an overwrite.
> Verified: reverting `applySa` to the early-return form fails exactly two tests, both of
> which had to be added — "a rewritten character loses the attributes of the character it
> replaced" and "an overwrite drops a stale attribute of a type the new SA does not
> mention". Keep both.

- [ ] **Step 6: Handle the SA order itself**

Replace the `'deferred'` case:

```ts
    case 'deferred': {
      if (token.order === Order.MF) return addr;  // still unimplemented; counted

      // SA. token.data is [type, value] (parse.ts:245).
      const [type, value] = [token.data[0]!, token.data[1]!];
      switch (type) {
        case XA.RESET:
          // "The attribute type X'00' is always supported by the SA order"
          // (pages.txt:2991) and means reset every type to its default. Twelve
          // of these are in the committed TK5 fixture.
          delete sa.fg;
          delete sa.bg;
          delete sa.gr;
          return addr;
        case XA.FOREGROUND: sa.fg = value; return addr;
        case XA.BACKGROUND: sa.bg = value; return addr;
        case XA.HIGHLIGHTING: sa.gr = value; return addr;
        default:
          // CHARSET and anything else: still genuinely unimplemented.
          return addr;
      }
    }
```

The counter in the token loop must now count **only** the types still dropped. Change that arm:

```ts
      if (token.kind === 'deferred') {
        switch (token.order) {
          case Order.SA: {
            const type = token.data[0]!;
            const implemented = type === XA.RESET || type === XA.FOREGROUND
              || type === XA.BACKGROUND || type === XA.HIGHLIGHTING;
            if (!implemented) result.setAttributeIgnored++;
            break;
          }
          case Order.MF: result.modifyFieldIgnored++; break;
          default: { const _never: never = token.order; void _never; }
        }
      }
```

- [ ] **Step 7: Seed SFE's field-level attributes**

Replace the `'sfe'` case's ending. Keep the existing `findLast` for the basic attribute, then:

```ts
      const basic = token.pairs.findLast((p) => p.type === XA_3270);
      screen.setFieldAttribute(addr, basic?.value ?? 0x00);

      // Extended pairs seed the RUNNING SA STATE, which then applies to every
      // character this field contains. That is how a field-level attribute and a
      // character-level SA compose: the field sets the baseline, a later SA in
      // the same record overrides it, and the next SF/SFE replaces the baseline.
      // Note setFieldAttribute above has already cleared the attribute cell's own
      // extended attributes (pages.txt:2874-2875), so this cannot leak backwards.
      for (const p of token.pairs) {
        if (p.type === XA.FOREGROUND) sa.fg = p.value;
        else if (p.type === XA.BACKGROUND) sa.bg = p.value;
        else if (p.type === XA.HIGHLIGHTING) sa.gr = p.value;
        // NO `XA.RESET` ARM HERE -- see the warning below.
      }
      return screen.inc(addr);
```

Add `XA` to the `constants.js` import at the top of the file.

> **⚠️ CORRECTED 2026-08-20. An earlier version of this plan had a fourth arm in that loop
> treating an SFE pair of type `XA.RESET` as a reset of the running state. That is
> BACKWARDS**, and it was implemented and pinned with a test before the error was caught.
> The manual: "The attribute type X'00' can appear only in the SA order"
> (`pages.txt:3456`), and for SFE specifically, "Attribute types and values that are
> unknown or cannot be maintained and returned inbound by an implementation are
> **rejected**" (`pages.txt:2897-2898`). In an SFE it is an invalid type and must be
> **ignored**, leaving the other pairs standing.
>
> x3270 draws exactly this distinction: its SFE arm for `XA_ALL` traces and advances past
> without touching any `efa_*` (`ctlr.c:1869-1871`), while its SA arm zeroes all five
> defaults (`ctlr.c:1915-1921`). As the plan originally had it, a trailing `X'00'` pair
> would have **silently discarded a colour the host set in the same order**.

**ALSO store the pairs on the field-attribute cell**, which is the storage half of the
eighth rule (see the amendment at the top of Task 5). Order matters:
`setFieldAttribute(addr, basic)` first — it clears that cell's extended attributes — then
`setExtended(addr, {...pairs})`, then seed the running state. x3270 does the same, writing
`efa_fg` and siblings while `buffer_addr` is still on the attribute position
(`ctlr.c:1886-1889`, incrementing at `:1891`).

- [ ] **Step 8: Reset on a plain SF too**

In the `'sf'` case, the running state must drop back to the field's own baseline — a plain SF specifies no extended attributes, so they go to default:

```ts
    case 'sf':
      screen.setFieldAttribute(addr, token.attr);
      // A plain SF sets the extended field attribute to its default
      // (pages.txt:2874-2875), so the running state returns to unspecified.
      delete sa.fg;
      delete sa.bg;
      delete sa.gr;
      return screen.inc(addr);
```

- [ ] **Step 9: Run the tests**

Run: `npx vitest run packages/core/test/sa.test.ts && npm run typecheck`
Expected: PASS on all 14, typecheck clean.

- [ ] **Step 10: Run the whole suite**

Run: `npm test`
Expected: all passing. The executor's existing tests assert `setAttributeIgnored` counts; **if one now fails because it used a colour SA type, that test's expectation is what changed, not the behaviour** — update it and say so in the commit.

- [ ] **Step 11: Verify against the real fixture, which is the point of all this**

Run:
```bash
npm run build && node packages/cli/scripts/count-orders.mjs
```
Expected: `SA total: 113  MF total: 0`, `0x42 -> 101`, `0x00 -> 12` — unchanged, since this counts what the parser sees. Then confirm the executor now consumes them:

```bash
node -e "
const {Screen} = require('./packages/core/dist/screen.js');
" 2>/dev/null || echo "(ESM: use the import form below)"
```

Write a scratch check with `import`, replay the fixture through a `Screen`, and assert at least one cell has a non-undefined `fg`. Do not commit the scratch file; Task 6 makes this a permanent test.

- [ ] **Step 12: Commit**

```bash
git add packages/core/src/stream/execute.ts packages/core/test/sa.test.ts
git commit -m "Implement SA and SFE colour as running character-attribute state"
```

---

## Task 5: `render.ts` — resolve attributes into concrete colours

**Files:**
- Create: `packages/core/src/render.ts`
- Create: `packages/core/test/render.test.ts`
- Modify: `packages/core/src/index.ts`

Storage answers "what did the host say". This answers "what colour is this cell", and it must live in **one** place: two of its five rules are datastream semantics with citations, and reimplemented per front end they would diverge three ways.

> **⚠️ AMENDED 2026-08-20: THIS TASK HAS A SIXTH RULE, AND THE DRAFT BELOW CANNOT
> EXPRESS IT.** Review of Task 4 found that the manual requires a **two-level** lookup:
>
> > If there are field attributes in the character buffer and if a character attribute
> > specifies default for any character property (color, highlighting, or character set),
> > **the character is displayed using the value of that property established for the
> > field in the extended field attribute.** Otherwise, the character attribute overrides
> > the field attribute. (`pages.txt:3383-3387`)
>
> So an SFE's colour belongs to the FIELD, and a character with no attribute of its own
> falls back to it — *before* reaching the base-attribute map. Task 4 now stores field
> extended attributes on the **field-attribute cell**, the way x3270 does
> (`ctlr.c:1886-1889`), and x3270 resolves it per cell as
> `if (xea[i].fg) fg_color = xea[i].fg & 0x0f; else fg_color = fa_fg;`
> (`fprint_screen.c:754-758`).
>
> **The precedence is therefore four levels, not three:**
>
> 1. the cell's own extended attribute (`cell.fg`), if usable
> 2. **the field's extended attribute — read from the cell at `field.attrAddr`** ← NEW
> 3. the base-attribute map (`defaultColour`)
> 4. `mode3279 === false` → green, overriding everything
>
> The drafted `resolve()` below reads `cell.fg` and falls straight through to
> `defaultColour(attr)`, with no term for level 2 — so **add it**, and add tests: a
> character in an SFE-coloured field with no attribute of its own takes the field's
> colour; and a character whose colour was cleared by an overwrite falls back to the
> field's rather than to green. Everything else in this task is unchanged, and
> `ResolvedCell`'s shape is unaffected — this changes how a colour is derived, not what a
> renderer consumes.
>
> Full write-up in the spec under *THE EIGHTH RULE*.
>
> **THREE MORE CORRECTIONS, from implementing this task (2026-08-20):**
>
> 1. **Level 2 applies to background and highlighting too, not just foreground.** The
>    manual says "any character property (color, highlighting, or character set)", and
>    x3270 mirrors its fg two-step for bg (`c3270/screen.c:1153-1158`) and gr
>    (`:1166-1171`). A foreground-only fallback leaves an SFE's reverse-video field flat.
> 2. **`mode3279 === false` must gate BACKGROUND as well as foreground** — x3270 puts its
>    whole colour block behind `if (mode3279 || ...)` (`c3270/screen.c:1126`) — but must
>    **NOT** gate highlighting: a 3278 blinks and reverses perfectly well, and x3270
>    computes `gr` after its colour branch closes.
> 3. **`0xF7` must NOT be remapped to white.** See the corrected rule 5 in the spec; the
>    draft below has this fixed.

- [ ] **Step 1: Confirm the base-attribute mapping against x3270**

Run: `sed -n '75,96p' ~/src/suite3270-4.5/Common/fprint_screen.c`

Expected: `field_colors[4]` = GREEN (default), RED (intensified), BLUE (protected), WHITE (protected+intensified), selected by `DEFCOLOR_MAP(f)` = `((f & FA_PROTECT) >> 4) | ((f & FA_INT_HIGH_SEL) >> 3)`, and a `mode3279` gate returning GREEN unconditionally when false. **That gate is rule 3 and it is easy to miss.**

- [ ] **Step 2: Write the failing tests**

Create `packages/core/test/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Screen } from '../src/screen.js';
import { resolve } from '../src/render.js';
import { Colour } from '../src/palette.js';
import { XAH, FA } from '../src/constants.js';

/** A screen with one field of the given attribute, and a character at addr 1. */
function fielded(attr: number): Screen {
  const s = new Screen();
  s.setFieldAttribute(0, attr);
  s.setChar(1, 0xc1);
  return s;
}

describe('resolve: base field attribute fallback (rule 2)', () => {
  it('unprotected normal is green', () => {
    const r = resolve(fielded(FA.PRINTABLE).snapshot());
    expect(r[1]!.fg).toBe(Colour.GREEN);
  });

  it('unprotected intensified is red', () => {
    const r = resolve(fielded(FA.PRINTABLE | FA.INT_HIGH_SEL).snapshot());
    expect(r[1]!.fg).toBe(Colour.RED);
  });

  it('protected normal is blue', () => {
    const r = resolve(fielded(FA.PRINTABLE | FA.PROTECT).snapshot());
    expect(r[1]!.fg).toBe(Colour.BLUE);
  });

  it('protected intensified is white', () => {
    const r = resolve(fielded(FA.PRINTABLE | FA.PROTECT | FA.INT_HIGH_SEL).snapshot());
    expect(r[1]!.fg).toBe(Colour.WHITE);
  });

  it('an unformatted screen is green', () => {
    const s = new Screen();
    s.setChar(0, 0xc1);
    expect(resolve(s.snapshot())[0]!.fg).toBe(Colour.GREEN);
  });
});

describe('resolve: explicit colour wins (rule 1)', () => {
  it('an SA foreground overrides the base mapping', () => {
    const s = fielded(FA.PRINTABLE);          // would be green
    s.setExtended(1, { fg: Colour.PINK });
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.PINK);
  });

  it('an explicit background is used', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { bg: Colour.BLUE });
    expect(resolve(s.snapshot())[1]!.bg).toBe(Colour.BLUE);
  });

  it('the default background is neutral black', () => {
    expect(resolve(fielded(FA.PRINTABLE).snapshot())[1]!.bg).toBe(Colour.NEUTRAL_BLACK);
  });
});

describe('resolve: mode3279 false makes everything green (rule 3)', () => {
  it('ignores the base mapping', () => {
    // x3270 fprint_screen.c:91-94 returns HOST_COLOR_GREEN unconditionally when
    // not in 3279 mode. A 3278 is monochrome hardware.
    const r = resolve(fielded(FA.PRINTABLE | FA.PROTECT).snapshot(), { mode3279: false });
    expect(r[1]!.fg).toBe(Colour.GREEN);
  });

  it('ignores an explicit SA colour too', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { fg: Colour.PINK });
    expect(resolve(s.snapshot(), { mode3279: false })[1]!.fg).toBe(Colour.GREEN);
  });

  it('still honours highlighting, which is not colour', () => {
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { gr: XAH.REVERSE });
    const r = resolve(s.snapshot(), { mode3279: false });
    expect(r[1]!.reverse).toBe(true);
    expect(r[1]!.fg).toBe(Colour.GREEN);
  });
});

describe('resolve: the 0x00 and 0xF7 rules (rules 4 and 5)', () => {
  it('a colour value of 0x00 means device default, NOT black', () => {
    // "The X'00' value selects the device default color indicated in the Query
    // Reply (Color) structured field" (pages.txt:3544-3546). So it falls through
    // to the base mapping -- here a protected field, so blue.
    const s = fielded(FA.PRINTABLE | FA.PROTECT);
    s.setExtended(1, { fg: 0x00 });
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.BLUE);
  });

  it('0xF7 stays 0xF7 -- it is Neutral, a distinct colour, NOT white', () => {
    // CORRECTED 2026-08-20. The manual routes X'F7' through Query Reply (Color)
    // (pages.txt:3544-3550), and OUR reply gives F7 an identity pair, so F7
    // resolves to F7. It is listed separately from White 0xFF in Table 4-7, has
    // its own RGB in palette.ts, and x3270 keeps HOST_COLOR_NEUTRAL_WHITE (7)
    // distinct from HOST_COLOR_WHITE (15), special-casing F7 nowhere. Remapping
    // would collapse two colours a host deliberately chose between.
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { fg: 0xf7 });
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.NEUTRAL_WHITE);
    expect(resolve(s.snapshot())[1]!.fg).not.toBe(Colour.WHITE);
  });

  it('a malformed colour falls through to the default rather than throwing', () => {
    // A bad byte from a host must not take the client down. colourRgb() throws
    // on an unknown code, so resolve must never hand it one.
    const s = fielded(FA.PRINTABLE);
    s.setExtended(1, { fg: 0x99 });
    expect(() => resolve(s.snapshot())).not.toThrow();
    expect(resolve(s.snapshot())[1]!.fg).toBe(Colour.GREEN);
  });
});

describe('resolve: highlighting', () => {
  it('maps each value to its flag', () => {
    const cases: [number, 'blink' | 'reverse' | 'underscore' | 'intensify'][] = [
      [XAH.BLINK, 'blink'],
      [XAH.REVERSE, 'reverse'],
      [XAH.UNDERSCORE, 'underscore'],
      [XAH.INTENSIFY, 'intensify'],
    ];
    for (const [value, flag] of cases) {
      const s = fielded(FA.PRINTABLE);
      s.setExtended(1, { gr: value });
      expect(resolve(s.snapshot())[1]![flag], `${flag} for 0x${value.toString(16)}`).toBe(true);
    }
  });

  it('XAH.NORMAL and XAH.DEFAULT set no flags', () => {
    for (const value of [XAH.NORMAL, XAH.DEFAULT]) {
      const s = fielded(FA.PRINTABLE);
      s.setExtended(1, { gr: value });
      const c = resolve(s.snapshot())[1]!;
      expect([c.blink, c.reverse, c.underscore, c.intensify]).toEqual([false, false, false, false]);
    }
  });
});

describe('resolve: text and hidden fields', () => {
  it('translates EBCDIC to a Unicode string', () => {
    expect(resolve(fielded(FA.PRINTABLE).snapshot())[1]!.text).toBe('A');
  });

  it('renders a null as a space', () => {
    const s = fielded(FA.PRINTABLE);
    expect(resolve(s.snapshot())[2]!.text).toBe(' ');
  });

  it('marks hidden fields so a renderer can suppress the text', () => {
    const s = fielded(FA.PRINTABLE | FA.INT_ZERO_NSEL);
    expect(resolve(s.snapshot())[1]!.hidden).toBe(true);
  });

  it('returns one entry per cell, including attribute positions', () => {
    const s = fielded(FA.PRINTABLE);
    const r = resolve(s.snapshot());
    expect(r).toHaveLength(s.size);
    // The attribute position itself displays as a blank.
    expect(r[0]!.text).toBe(' ');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/core/test/render.test.ts`
Expected: FAIL — cannot resolve `../src/render.js`.

- [ ] **Step 4: Implement**

Create `packages/core/src/render.ts`:

```ts
/**
 * Resolve protocol attributes into concrete colours for a renderer.
 *
 * ## WHY THIS IS IN CORE AND NOT IN EACH FRONT END
 *
 * Storage says what the host sent. This says what colour a cell IS, and two of
 * its rules are datastream semantics rather than rendering taste:
 *
 *   - A colour VALUE of 0x00 means "the device default indicated in Query Reply
 *     (Color)" (GA23-0059 p. 4-19, pages.txt:3544-3546) -- NOT black.
 *   - 0xF7 means "the colour comes from a triple-plane character set", and with a
 *     single-plane or nonloadable set it takes the single colour Query Reply
 *     (Color) gives for F7, i.e. white on a display (pages.txt:3548-3554).
 *
 * Reimplemented in the TUI, the GUI and a web front end, those would diverge
 * three ways. So they live here, once, and every front end consumes
 * `ResolvedCell[]`.
 *
 * This module is PURE: no I/O, no Session, no terminal. It takes a snapshot and
 * returns an array. That is what makes every rule above independently testable.
 */

import { FA, XAH } from './constants.js';
// CodePage is a CLASS, not an interface, so it is a plain import. Its
// byte-to-string method is `toUnicode(byte)` -- verified, see step 5.
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
  /** Highlighting 0xF8. Distinct from the base attribute's intensified bit. */
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
   * fprint_screen.c:91-94). A 3278 is monochrome hardware and must not be
   * colourised just because a host sent an attribute it should not have.
   */
  mode3279?: boolean;
  codePage?: CodePage;
}

/**
 * The 3279 default colour map: which colour a cell takes from its base field
 * attribute when nothing more specific applies.
 *
 * x3270's `field_colors[4]` with its `DEFCOLOR_MAP` index
 * (fprint_screen.c:80-88): bit 1 is PROTECT, bit 0 is INT_HIGH_SEL.
 */
const DEFAULT_COLOURS: readonly Colour3279[] = [
  Colour.GREEN, // unprotected, normal
  Colour.RED,   // unprotected, intensified
  Colour.BLUE,  // protected, normal
  Colour.WHITE, // protected, intensified
];

function defaultColour(attr: number, mode3279: boolean): Colour3279 {
  if (!mode3279) return Colour.GREEN;
  const index = ((attr & FA.PROTECT) !== 0 ? 2 : 0) | ((attr & FA.INT_HIGH_SEL) !== 0 ? 1 : 0);
  return DEFAULT_COLOURS[index]!;
}

/**
 * Is `code` a colour we can actually render?
 *
 * 0x00 is excluded deliberately: it is legal on the wire and means "device
 * default", so it must fall through to the default map rather than being treated
 * as a value. An unrecognised byte falls through the same way -- a malformed
 * attribute from a host must never reach `colourRgb`, which throws.
 */
function usableColour(code: number | undefined): boolean {
  if (code === undefined || code === 0x00) return false;
  return PALETTE_3279[code] !== undefined;
}

export function resolve(snap: ScreenSnapshot, opts: ResolveOptions = {}): ResolvedCell[] {
  const mode3279 = opts.mode3279 ?? true;
  const codePage = opts.codePage ?? cp037;

  // Which field governs each cell, computed once by walking the field list
  // rather than calling fieldAt() per cell -- that is O(n) each and would make
  // resolution O(n^2) on a 1920-cell screen redrawn on every host record.
  const attrOf = new Int16Array(snap.cells.length).fill(-1);
  if (snap.fields.length > 0) {
    for (const f of snap.fields) {
      let a = f.attrAddr;
      for (let n = 0; n <= f.length; n++) {
        attrOf[a] = f.attr;
        a = (a + 1) % snap.cells.length;
      }
    }
  }

  const out: ResolvedCell[] = new Array(snap.cells.length);
  for (let i = 0; i < snap.cells.length; i++) {
    const cell = snap.cells[i]!;
    const attr = attrOf[i]! >= 0 ? attrOf[i]! : 0x00;
    const isAttrPosition = snap.fields.some((f) => f.attrAddr === i);

    const gr = cell.gr ?? XAH.DEFAULT;
    out[i] = {
      text: isAttrPosition || cell.ebcdic === 0x00 ? ' ' : codePage.toUnicode(cell.ebcdic),
      fg: mode3279 && usableColour(cell.fg)
        ? cell.fg!   // NO 0xF7 remap -- see the correction note
        : defaultColour(attr, mode3279),
      bg: mode3279 && usableColour(cell.bg)
        ? cell.bg!   // NO 0xF7 remap -- see the correction note
        : Colour.NEUTRAL_BLACK,
      blink: gr === XAH.BLINK,
      reverse: gr === XAH.REVERSE,
      underscore: gr === XAH.UNDERSCORE,
      intensify: gr === XAH.INTENSIFY,
      hidden: (attr & FA.INTENSITY) === FA.INT_ZERO_NSEL,
    };
  }
  return out;
}
```

**Note on `isAttrPosition`:** `snap.fields.some(...)` inside the loop is O(fields) per cell. On a 1920-cell screen with ~100 fields that is 192,000 comparisons per redraw, which is measurable. Build a `Set` of attribute addresses before the loop instead:

```ts
  const attrPositions = new Set(snap.fields.map((f) => f.attrAddr));
```

and test with `attrPositions.has(i)`. Do it that way; the `some()` form above is shown only so the intent is unambiguous.

- [ ] **Step 5: Confirm the code page API, which is already verified but check anyway**

Run: `grep -nE "^  [a-zA-Z]+\(" packages/core/src/codepage.ts`

Expected: `toUnicode(byte)`, `fromUnicode(char)`, `decode(bytes)`, `encode(text)` — so the per-byte method is **`toUnicode`**, and `CodePage` is a **class** (line 10), not an interface. The code above uses both correctly; this step exists because an earlier draft of this plan wrote `decodeByte` and `type CodePage`, neither of which exists. If your grep disagrees with this list, the plan is stale and your grep wins.

- [ ] **Step 6: Export it**

Add to `packages/core/src/index.ts`, after the `palette.js` line:

```ts
export * from './render.js';
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npx vitest run packages/core/test/render.test.ts && npm run typecheck`
Expected: PASS on all 22, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/render.ts packages/core/src/index.ts packages/core/test/render.test.ts
git commit -m "Resolve extended attributes into concrete 3279 colours"
```

---

## Task 6: Prove it against the committed TK5 fixture

**Files:**
- Modify: `packages/core/test/render.test.ts`

**This is the test that would have caught the whole gap**, and it needs no host. The fixture is already on disk and contains 101 foreground SA orders.

> **⚠️ WHAT THIS TASK CANNOT PROVE, measured 2026-08-20: the TK5 fixture contains ZERO SFE
> orders.** All 113 of its SA orders are character-level, so no field-attribute cell in it
> carries extended attributes and **the field-level fallback (the eighth rule) gets no
> coverage here at all.** That is exactly why that whole class of defect went unnoticed —
> the trace we regression-test against never exercises the field level.
>
> So this task proves the **character** level against real host traffic and leaves the
> **field** level unit-tested only. Say so in the commit message rather than letting a
> green Task 6 read as covering both. Real coverage needs a trace from a host that sends
> SFE; none is committed today. This is [[check-what-a-comparison-covers]] again: a passing
> comparison proves nothing about behaviour its inputs never exercise.

- [ ] **Step 1: Find how existing tests replay a fixture**

Run: `grep -rn "mvs-tk5-tso-ispf\|readFileSync" packages/core/test/*.test.ts | head`

Reuse that helper rather than writing a second trace parser. If the existing one is in a test-local helper, import it; if it is inline, extract it to `packages/core/test/helpers/trace.ts` as part of this task and update its original caller.

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/render.test.ts`:

```ts
describe('the live TK5 ISPF fixture', () => {
  it('produces coloured cells, not a monochrome screen', () => {
    // The fixture carries 101 SA foreground orders and 12 resets -- counted with
    // packages/cli/scripts/count-orders.mjs, NOT with a hex grep, which gives
    // the wrong answer twice over. Before this work every one was discarded.
    const screen = replayFixture('mvs/mvs-tk5-tso-ispf.trace');
    const resolved = resolve(screen.snapshot());
    const distinct = new Set(resolved.map((c) => c.fg));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('uses a colour the base-attribute map alone could not produce', () => {
    // The default map yields only green, red, blue and white. A fifth colour
    // proves the SA orders actually reached the screen, which a test asserting
    // merely "more than one colour" would not.
    const screen = replayFixture('mvs/mvs-tk5-tso-ispf.trace');
    const fromDefaults = new Set([Colour.GREEN, Colour.RED, Colour.BLUE, Colour.WHITE]);
    const seen = new Set(resolve(screen.snapshot()).map((c) => c.fg));
    const beyond = [...seen].filter((c) => !fromDefaults.has(c) && c !== Colour.NEUTRAL_BLACK);
    expect(beyond.length).toBeGreaterThan(0);
  });

  it('pins the SA order counts, so a parser regression fails loudly', () => {
    // Without this, a change that stopped recognising SA would show up only as a
    // quietly monochrome screen -- which is exactly the failure mode this whole
    // task exists to end.
    const counts = countDeferredOrders('mvs/mvs-tk5-tso-ispf.trace');
    expect(counts.sa).toBe(113);
    expect(counts.mf).toBe(0);
    expect(counts.byType.get(0x42)).toBe(101);
    expect(counts.byType.get(0x00)).toBe(12);
  });
});
```

- [ ] **Step 3: Add the two helpers**

`replayFixture` and `countDeferredOrders` go in `packages/core/test/helpers/trace.ts`. `countDeferredOrders` is the same logic as `packages/cli/scripts/count-orders.mjs` — **port it, do not re-derive it**, and note in a comment that the script and the helper must agree. Record reassembly is the part to copy exactly: inbound records start with `<` and continue on `+` lines, and a record beginning `0xff` is telnet negotiation rather than a 3270 record.

- [ ] **Step 4: Run it**

Run: `npx vitest run packages/core/test/render.test.ts`
Expected: PASS. **If the counts come out other than 113/101/12, believe the script over the plan** — run `node packages/cli/scripts/count-orders.mjs`, use what it reports, and say in the commit that the plan's numbers were stale.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/render.test.ts packages/core/test/helpers/trace.ts
git commit -m "Pin TK5's colour against the fixture that was proving nothing before"
```

---

## Task 7: Advertise Color and Highlighting in Query Reply

**Files:**
- Modify: `packages/core/src/constants.ts` (the `Qcode` block, line 170)
- Modify: `packages/core/src/queryreply.ts`
- Test: `packages/core/test/queryreply.test.ts`

A well-behaved host sends extended attributes only to a client that says it has them. Two new capability entries — the list exists so this is one entry each, not a refactor.

**Note the asymmetry, and do not "fix" it:** TK5 already sends us SA colour *without* our advertising anything, which the fixture proves. So these units are for correctness with better-behaved hosts, not a prerequisite for the colour in Task 6. Nothing in this task should change the fixture's behaviour.

- [ ] **Step 1: Read x3270's two unit bodies, which are the reference**

Run:
```bash
sed -n '/^do_qr_highlighting/,/^}/p' ~/src/suite3270-4.5/Common/sf.c
sed -n '/^do_qr_color/,/^}/p' ~/src/suite3270-4.5/Common/sf.c
```

Expected — Highlighting is a count of pairs then five (attribute-value, action-value) pairs; Color is options byte, count, then a default pair and fifteen identity pairs:

```
Highlighting:  05  00 f0  f1 f1  f2 f2  f4 f4  f8 f8
Color:         00  10  00 f4  f1 f1 f2 f2 ... ff ff
```

Two details to carry over exactly: Highlighting reports **5** pairs and its first pair is `XAH_DEFAULT → XAH_NORMAL`; Color's default pair is `0x00 → 0xF4` (**green**, not white or black), and its count byte is `0x10` = 16.

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/queryreply.test.ts`:

```ts
describe('Color (QCODE 0x86)', () => {
  it('reports 16 colours with green as the default, matching x3270 sf.c:735-755', () => {
    const bytes = buildReply({ kind: 'query' }, GEOMETRY_24X80, DEFAULT_CAPABILITIES);
    const unit = findUnit(bytes, Qcode.COLOR);
    // L L SFID QCODE then: options, count, then 16 pairs.
    expect(unit[0]).toBe(0x00);        // no options
    expect(unit[1]).toBe(0x10);        // 16 colours
    expect(unit[2]).toBe(0x00);        // the default entry...
    expect(unit[3]).toBe(0xf4);        // ...is GREEN
    // Then fifteen identity pairs, 0xf1..0xff.
    for (let i = 0; i < 15; i++) {
      expect(unit[4 + i * 2]).toBe(0xf1 + i);
      expect(unit[5 + i * 2]).toBe(0xf1 + i);
    }
    expect(unit).toHaveLength(4 + 30);
  });
});

describe('Highlighting (QCODE 0x87)', () => {
  it('reports the five supported pairs, matching x3270 sf.c:/do_qr_highlighting/', () => {
    const bytes = buildReply({ kind: 'query' }, GEOMETRY_24X80, DEFAULT_CAPABILITIES);
    const unit = findUnit(bytes, Qcode.HIGHLIGHTING);
    expect([...unit]).toEqual([
      0x05,
      XAH.DEFAULT, XAH.NORMAL,
      XAH.BLINK, XAH.BLINK,
      XAH.REVERSE, XAH.REVERSE,
      XAH.UNDERSCORE, XAH.UNDERSCORE,
      XAH.INTENSIFY, XAH.INTENSIFY,
    ]);
  });
});

describe('Summary lists the two new units', () => {
  it('includes 0x86 and 0x87', () => {
    // Summary's params are `all.map(c => c.qcode)`, so this is really a test
    // that both were added to DEFAULT_CAPABILITIES rather than only defined.
    const bytes = buildReply({ kind: 'query' }, GEOMETRY_24X80, DEFAULT_CAPABILITIES);
    const summary = findUnit(bytes, Qcode.SUMMARY);
    expect([...summary]).toContain(Qcode.COLOR);
    expect([...summary]).toContain(Qcode.HIGHLIGHTING);
  });
});
```

`findUnit(bytes, qcode)` — return the unit body after its `L L SFID QCODE` prefix. If the test file already has such a helper (it very likely does, for the three existing units), **use that one**; do not add a second.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/core/test/queryreply.test.ts -t "Color"`
Expected: FAIL — `Qcode.COLOR` is undefined.

- [ ] **Step 4: Add the two QCODEs**

In `packages/core/src/constants.ts`, inside the `Qcode` object, after `USABLE_AREA`:

```ts
  /** Color. Table 6-1 "Color Yes X'86' Yes Yes" — x3270 sf.c:86. */
  COLOR: 0x86,
  /** Highlighting. Table 6-1 "Highlighting Yes X'87' Yes Yes" — x3270 sf.c:80. */
  HIGHLIGHTING: 0x87,
```

**Verify both against Table 6-1 before writing them**, since `returnedForQuery` in the next step depends on that row: `grep -n "Highlighting" ~/3270/ref/pages.txt | head`. If the OCR of either row is unreadable, say so and use x3270's table as the authority — it lists both with a `single_fn`, which is only reachable from a plain Query.

- [ ] **Step 5: Implement the two capabilities**

In `packages/core/src/queryreply.ts`, before `DEFAULT_CAPABILITIES`:

```ts
/**
 * Color (QCODE 0x86), GA23-0059 p. 6-38. Body: options, count, then `count`
 * (attribute-value, colour-identification) pairs.
 *
 * Ported from x3270's `do_qr_color` (Common/sf.c:735-755). Two details worth
 * stating because they are not guessable:
 *
 *  - The DEFAULT pair is `0x00 -> 0xF4`, i.e. green. That is the answer to "what
 *    does a colour value of 0x00 mean", and it is what makes render.ts's rule 4
 *    consistent with what we advertise: we tell the host the default is green and
 *    our default map yields green for an ordinary unprotected field.
 *  - The remaining fifteen are IDENTITY pairs, 0xF1..0xFF. x3270 emits 0x00 as
 *    the value instead when not in 3279 mode; we always advertise colour because
 *    the terminal type we send decides whether a host uses it, and a TUI on a
 *    monochrome terminal still resolves colours internally (render.ts's
 *    mode3279 flag is a RENDERING choice, not a negotiation one).
 */
const color: Capability = {
  qcode: Qcode.COLOR,
  returnedForQuery: true,
  params: () => {
    const out = [0x00, 0x10, 0x00, Colour.GREEN];
    for (let c = 0xf1; c <= 0xff; c++) out.push(c, c);
    return out;
  },
};

/**
 * Highlighting (QCODE 0x87), GA23-0059 p. 6-53. Body: pair count, then
 * (attribute-value, action-value) pairs.
 *
 * Ported from x3270's `do_qr_highlighting`. Five pairs, and the first is
 * `DEFAULT -> NORMAL` rather than `DEFAULT -> DEFAULT`: the host asks "if I send
 * you X'00', what do you do", and the answer is "render it normally".
 */
const highlighting: Capability = {
  qcode: Qcode.HIGHLIGHTING,
  returnedForQuery: true,
  params: () => [
    0x05,
    XAH.DEFAULT, XAH.NORMAL,
    XAH.BLINK, XAH.BLINK,
    XAH.REVERSE, XAH.REVERSE,
    XAH.UNDERSCORE, XAH.UNDERSCORE,
    XAH.INTENSIFY, XAH.INTENSIFY,
  ],
};
```

Then extend the list:

```ts
export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  summary, usableArea, color, highlighting, implicitPartition,
];
```

**Order matters for the goldens.** Units go out in list order, so inserting before `implicitPartition` changes the byte stream. That is intended — but it means the next step is not optional.

Add `XAH` and `Colour` to the imports (`Colour` from `./palette.js`).

- [ ] **Step 6: Run the tests, and expect conformance goldens to move**

Run: `npm test`

Expected: the three new tests pass. **Any golden or conformance test asserting the exact Query Reply bytes will now fail, because we send two more units.** That is a real change to what we put on the wire, not a regression — but confirm each failure is only the added units before updating any golden, and say in the commit which goldens moved and why. If a golden fails for a reason *other* than the two new units, stop and report it.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add packages/core/src/constants.ts packages/core/src/queryreply.ts packages/core/test/queryreply.test.ts
git commit -m "Advertise Color and Highlighting in Query Reply"
```

---

## Task 8: Surface resolved colour through the CLI

**Files:**
- Modify: `packages/cli/src/runner.ts` (the `ScreenJson` case, line 254)
- Test: `packages/cli/test/runner.test.ts`

Before any terminal code exists, make the colour visible from the existing CLI. This is what lets a live host be checked in Task 13 without trusting the TUI's rendering at the same time.

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/runner.test.ts`. The file's helper is **`newRunner()`** (line 27), returning `{ runner, session, conn }`, and commands are driven with **`await runner.run('...')`**, which returns the whole reply as a **string** — not an object with a `data` array. So the JSON line has to be picked out of that string:

```ts
describe('ScreenJson colour', () => {
  it('reports resolved colour per cell', async () => {
    const { runner, session } = newRunner();
    // A protected, unintensified field: the 3279 default map renders it BLUE.
    session.screen.setFieldAttribute(0, FA.PRINTABLE | FA.PROTECT);
    session.screen.setChar(1, 0xc1);

    const reply = await runner.run('ScreenJson');
    // Data lines are prefixed "data: "; the JSON is the only one here.
    const line = reply.split('\n').find((l) => l.startsWith('data: '))!;
    const json = JSON.parse(line.slice('data: '.length));

    expect(json.resolved).toBeDefined();
    expect(json.resolved).toHaveLength(1920);
    expect(json.resolved[1].fg).toBe(Colour.BLUE);
    expect(json.resolved[1].text).toBe('A');
  });

  it('still reports the raw cells alongside the resolved ones', async () => {
    // A conformance comparison needs the bytes; a human debugging colour needs
    // the resolution. Dropping either makes one of those impossible.
    const { runner, session } = newRunner();
    session.screen.setChar(0, 0xc1);
    const reply = await runner.run('ScreenJson');
    const line = reply.split('\n').find((l) => l.startsWith('data: '))!;
    const json = JSON.parse(line.slice('data: '.length));
    expect(json.cells[0].ebcdic).toBe(0xc1);
    expect(json.resolved[0].text).toBe('A');
  });
});
```

Import `FA` and `Colour` from `@tn3270/core`. **Confirm the `data: ` prefix** against how the file's other `ScreenText`/`ScreenJson` tests read output — if they strip it differently, match them rather than this.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/cli/test/runner.test.ts -t "ScreenJson colour"`
Expected: FAIL — `json.resolved` is undefined.

- [ ] **Step 3: Implement**

In `packages/cli/src/runner.ts`, in the `ScreenJson` case, add `resolved` to the emitted object:

```ts
      case 'ScreenJson': {
        const snap = s.screen.snapshot();
        data.push(JSON.stringify({
          rows: snap.rows,
          cols: snap.cols,
          cursor: snap.cursor,
          formatted: snap.formatted,
          oia: s.oia.toText(),
          fields: snap.fields,
          cells: snap.cells,
          // Resolved colours alongside the raw cells, not instead of them: a
          // conformance comparison needs the bytes, a human debugging colour
          // needs the resolution, and dropping either would make one of those
          // impossible.
          resolved: resolve(snap),
        }));
        return;
      }
```

Import `resolve` from `@tn3270/core`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/cli/test/runner.test.ts && npm run typecheck`
Expected: PASS. **`ScreenJson`'s output is asserted by other tests** — if one compares the whole JSON object, it will now fail on the added key; update it and note that the key was added deliberately.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runner.ts packages/cli/test/runner.test.ts
git commit -m "Report resolved colour from ScreenJson"
```

---

## Task 9: The `packages/tui` skeleton

**Files:**
- Create: `packages/tui/package.json`
- Create: `packages/tui/tsconfig.json`
- Create: `packages/tui/src/main.ts`
- Modify: `package.json` (the `typecheck` script, line 13)

Scaffolding only, so later tasks have somewhere to land and typecheck runs over them.

- [ ] **Step 1: Create the manifest, mirroring the CLI's exactly**

`packages/tui/package.json`:

```json
{
  "name": "@tn3270/tui",
  "version": "0.1.0",
  "license": "MIT",
  "author": "Adam Thornton <athornton@gmail.com>",
  "type": "module",
  "bin": { "tn3270": "./dist/main.js" },
  "dependencies": { "@tn3270/core": "0.1.0", "@tn3270/cli": "0.1.0" },
  "scripts": { "build": "tsc --build" }
}
```

**It depends on `@tn3270/cli` deliberately**, for one thing only: `defaultSession()` (`cli/src/runner.ts:82`), which wraps the TCP `Connection` adapter. Duplicating that socket code in the TUI would give us two transports to keep in step. If that dependency later feels wrong, the fix is to move `tcpConnect` into its own package — not to copy it.

`packages/tui/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }, { "path": "../cli" }]
}
```

- [ ] **Step 2: Add it to typecheck**

In the root `package.json`:

```json
    "typecheck": "tsc --build packages/core packages/cli packages/tui",
```

- [ ] **Step 3: A main.ts that does nothing yet but compiles**

`packages/tui/src/main.ts`:

```ts
#!/usr/bin/env node
/**
 * c3270-style terminal front end.
 *
 * Argument parsing and process wiring only; the screen lives in app.ts. See
 * docs/superpowers/specs/2026-08-19-tui-and-colour-design.md.
 */

export function main(argv: readonly string[]): number {
  void argv;
  process.stderr.write('tn3270 TUI: not implemented yet\n');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
```

- [ ] **Step 4: Install and verify the workspace resolves**

Run: `npm install && npm run build && npm run typecheck`
Expected: all clean. `npm install` links the new workspace; without it the `@tn3270/cli` dependency will not resolve.

- [ ] **Step 5: Commit**

```bash
git add packages/tui package.json package-lock.json
git commit -m "Scaffold packages/tui"
```

---

## Task 10: Colour depth detection and quantisation

**Files:**
- Create: `packages/tui/src/colours.ts`
- Create: `packages/tui/test/colours.test.ts`

Four tiers, chosen from the terminal's actual capability. **Detection is `tput`, not Node's builtin** — the spec has the measurements showing why.

- [ ] **Step 1: Reproduce the measurement before implementing, so you trust the choice**

Run:
```bash
for t in xterm-256color screen-256color xterm-direct xterm vt100; do
  printf "%-18s tput=%s\n" "$t" "$(tput -T$t colors 2>/dev/null || echo -1)"
done
node -e "const t=require('node:tty');const f=t.WriteStream.prototype.getColorDepth;
for (const x of ['xterm-256color','screen-256color','xterm-direct','xterm','vt100'])
  console.log(x.padEnd(18), 'node=' + f.call({}, {TERM:x}));"
```

Expected: `tput` gives 256 / 256 / 16777216 / 8 / -1, while Node gives 8 / **16** / **16** / 16 / **16**. Node is wrong on three of the five, including both cases that matter (screen, direct colour). **If your run disagrees, report it before proceeding** — the whole design of this module rests on it.

- [ ] **Step 2: Write the failing tests**

Create `packages/tui/test/colours.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Colour } from '@tn3270/core';
import { detectDepth, sgrFor, type Depth } from '../src/colours.js';

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
  it('24-bit emits exact RGB', () => {
    // Green is 0x00ff00.
    expect(sgrFor(Colour.GREEN, 16777216, 'fg')).toBe('38;2;0;255;0');
    expect(sgrFor(Colour.GREEN, 16777216, 'bg')).toBe('48;2;0;255;0');
  });

  // ⚠️ EVERY NUMBER IN THIS DESCRIBE BLOCK IS DERIVED FROM `PALETTE_3279`.
  // They were computed against the palette as first written in Task 2, whose
  // RGB values were then CHANGED during review: `neutral-black`/`black` and
  // `neutral-white`/`white` had each been given identical values, which loses
  // information a host deliberately sent, so all four were made distinct.
  //
  // The seven base colours (blue, red, pink, green, turquoise, yellow, white)
  // were not among the four changed, so these numbers should still hold — but
  // WHITE (0xFF) is one of the seven AND was one of the four, so re-derive
  // rather than assume. Read the committed `PALETTE_3279` and recompute:
  //   24-bit: `38;2;r;g;b`
  //   256:    16 + 36*round(r/255*5) + 6*round(g/255*5) + round(b/255*5)
  //   16:     (bright ? 90 : 30) + nearest ANSI-8 index, bright = max>170
  // If a number below disagrees with that arithmetic, the PLAN is stale and
  // your derivation wins. Say so rather than adjusting the implementation.

  it('256 emits a cube index', () => {
    const sgr = sgrFor(Colour.GREEN, 256, 'fg');
    expect(sgr).toMatch(/^38;5;\d+$/);
    const index = Number(sgr.split(';')[2]);
    // The 6x6x6 cube starts at 16; pure green is 16 + 36*0 + 6*5 + 0 = 46.
    expect(index).toBe(46);
  });

  it('16 emits a standard ANSI code', () => {
    // Bright green is 92; the 3279's green is full-intensity.
    expect(sgrFor(Colour.GREEN, 16, 'fg')).toBe('92');
    expect(sgrFor(Colour.BLUE, 16, 'fg')).toBe('94');
    expect(sgrFor(Colour.RED, 16, 'fg')).toBe('91');
  });

  it('8 emits only the non-bright range', () => {
    expect(sgrFor(Colour.GREEN, 8, 'fg')).toBe('32');
    expect(sgrFor(Colour.BLUE, 8, 'fg')).toBe('34');
    expect(sgrFor(Colour.RED, 8, 'fg')).toBe('31');
  });

  it('monochrome emits nothing at all', () => {
    expect(sgrFor(Colour.RED, 0, 'fg')).toBe('');
    expect(sgrFor(Colour.RED, 0, 'bg')).toBe('');
  });

  it('maps all sixteen palette entries at every depth without throwing', () => {
    const depths: Depth[] = [0, 8, 16, 256, 16777216];
    for (let code = 0xf0; code <= 0xff; code++) {
      for (const d of depths) {
        expect(() => sgrFor(code, d, 'fg')).not.toThrow();
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
      const seen = new Set(base.map((c) => sgrFor(c, depth, 'fg')));
      expect(seen.size, `depth ${depth}`).toBe(base.length);
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/tui/test/colours.test.ts`
Expected: FAIL — cannot resolve `../src/colours.js`.

- [ ] **Step 4: Implement**

Create `packages/tui/src/colours.ts`:

```ts
/**
 * Colour depth detection and quantisation of the 3279 palette to ANSI.
 *
 * ## DETECTION USES `tput`, NOT NODE'S BUILTIN, AND THAT IS A MEASURED CHOICE
 *
 * `tty.WriteStream.getColorDepth` is TERM-string heuristics, not terminfo, and it
 * is wrong in exactly the cases this feature exists to detect. Measured on the
 * development box:
 *
 *   terminal            tput        getColorDepth   truth
 *   xterm-256color      256         8               256
 *   screen-256color     256         16    <-- wrong 256
 *   xterm-direct        16777216    16    <-- wrong 24-bit
 *   xterm               8           16              8
 *   vt100               -1          16    <-- wrong none
 *
 * So anything under GNU screen would lose colour and a direct-colour terminal
 * would be capped at 16. The `terminfo` npm package does parse the real binary
 * database, but it is v0.1.1, last published 2016, one maintainer -- not a
 * dependency worth taking against a project policy of no deps beyond node:net
 * and node:tls. `tput` is POSIX and ships with the database it reads.
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
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/tui/test/colours.test.ts && npm run typecheck`

Expected: PASS.

**Every numeric assertion in these tests was executed against the exact algorithm above before this plan was written**, so they should hold as given: cube index 46 for green, ANSI 92/94/91 for green/blue/red at 16 colours, 32 for green at 8, and all seven base 3279 colours distinct at 16 **and** 256. That means a failure here is a real discrepancy in your implementation rather than a stale number in the plan — read it rather than adjusting the expectation.

The two most valuable assertions are the cube index and the seven-distinct check. `16 + 36*step(r) + 6*step(g) + step(b)` with `step(0)=0, step(255)=5` gives `16 + 0 + 30 + 0 = 46`. If two base colours ever collapse to one ANSI code, the `ANSI_8` table or `isBright` needs adjusting; **do not weaken the test.**

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/colours.ts packages/tui/test/colours.test.ts
git commit -m "Detect colour depth with terminfo and quantise the 3279 palette"
```

---

## Task 11: ANSI rendering with dirty-cell diffing

**Files:**
- Create: `packages/tui/src/render.ts`
- Create: `packages/tui/test/render.test.ts`

`ResolvedCell[]` in, ANSI out. Pure string production — no writing to stdout, so it is fully testable.

- [ ] **Step 1: Write the failing tests**

Create `packages/tui/test/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Colour, type ResolvedCell } from '@tn3270/core';
import { TerminalRenderer, tooSmall } from '../src/render.js';

/** A 2x3 grid of plain green cells, with `text` from a string. */
function grid(text: string, rows = 2, cols = 3): ResolvedCell[] {
  return [...text].map((ch) => ({
    text: ch, fg: Colour.GREEN, bg: Colour.NEUTRAL_BLACK,
    blink: false, reverse: false, underscore: false, intensify: false, hidden: false,
  })).slice(0, rows * cols);
}

describe('tooSmall', () => {
  it('rejects a terminal narrower or shorter than the screen plus a status row', () => {
    expect(tooSmall({ rows: 24, cols: 80 }, { rows: 24, cols: 80 })).toBe(true);  // no room for OIA
    expect(tooSmall({ rows: 25, cols: 80 }, { rows: 24, cols: 80 })).toBe(false);
    expect(tooSmall({ rows: 25, cols: 79 }, { rows: 24, cols: 80 })).toBe(true);
    expect(tooSmall({ rows: 30, cols: 132 }, { rows: 27, cols: 132 })).toBe(false);
  });
});

describe('TerminalRenderer', () => {
  it('emits the text of every cell on the first paint', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const out = r.paint(grid('ABCDEF'), 0, 'status');
    expect(out).toContain('ABC');
    expect(out).toContain('DEF');
  });

  it('emits nothing for an unchanged repaint', () => {
    // The whole point of diffing: a host that rewrites an identical screen must
    // not make the terminal flicker.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'status');
    const second = r.paint(cells, 0, 'status');
    expect(second).toBe('');
  });

  it('emits only the changed cell on a small change', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    r.paint(grid('ABCDEF'), 0, 'status');
    const out = r.paint(grid('ABCDEX'), 0, 'status');
    expect(out).toContain('X');
    expect(out).not.toContain('ABC');
  });

  it('repaints when the cursor moves, even with identical cells', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'status');
    expect(r.paint(cells, 4, 'status')).not.toBe('');
  });

  it('repaints when the status line changes', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    r.paint(cells, 0, 'X Wait');
    expect(r.paint(cells, 0, 'ok')).toContain('ok');
  });

  it('emits no colour escapes at all when monochrome', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    cells[0]!.fg = Colour.RED;
    const out = r.paint(cells, 0, 'status');
    expect(out).not.toMatch(/\x1b\[3[0-9]/);
    expect(out).not.toMatch(/\x1b\[38;/);
  });

  it('emits a colour escape when the colour changes mid-row', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const cells = grid('ABCDEF');
    cells[1]!.fg = Colour.RED;
    const out = r.paint(cells, 0, 'status');
    expect(out).toMatch(/\x1b\[38;5;\d+m/);
  });

  it('does not repeat an identical SGR for adjacent cells', () => {
    // Six cells of one colour must not produce six escape sequences; that
    // triples the bytes written on every redraw over a slow link.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const out = r.paint(grid('ABCDEF'), 0, 'status');
    const escapes = out.match(/\x1b\[38;5;\d+m/g) ?? [];
    expect(escapes.length).toBeLessThanOrEqual(2);  // at most one per row
  });

  it('renders a hidden cell as blank without emitting its text', () => {
    // A password field must not be readable from the terminal scrollback.
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 0 });
    const cells = grid('ABCDEF');
    cells[0]!.hidden = true;
    const out = r.paint(cells, 0, 'status');
    expect(out).not.toContain('A');
  });

  it('emits the highlighting attributes it supports', () => {
    const r = new TerminalRenderer({ rows: 2, cols: 3, depth: 256 });
    const cells = grid('ABCDEF');
    cells[0]!.underscore = true;
    cells[1]!.reverse = true;
    cells[2]!.blink = true;
    const out = r.paint(cells, 0, 'status');
    expect(out).toContain('4');   // SGR 4 underline
    expect(out).toContain('7');   // SGR 7 reverse
    expect(out).toContain('5');   // SGR 5 blink
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/tui/test/render.test.ts`
Expected: FAIL — cannot resolve `../src/render.js`.

- [ ] **Step 3: Implement**

Create `packages/tui/src/render.ts`. The design points that matter:

- **Diff against the previously painted cells**, keyed by index, and emit a cursor-position escape only when the run of changes breaks. This is the "redraw only dirty cells" rule the GUI section already committed to, applied to a terminal.
- **Track the current SGR state** across cells so an unchanged colour emits nothing.
- **The status line is row `rows + 1`**, outside the 1920-cell buffer, exactly as the spec requires for the OIA.

```ts
/**
 * Turn resolved cells into ANSI, writing as few bytes as possible.
 *
 * PURE: returns a string, never touches stdout. app.ts does the writing. That is
 * what makes the diffing testable, and diffing is not optional -- a host that
 * repaints an identical screen must not make the terminal flicker, and over a
 * 300-baud-equivalent link the byte count is the frame rate.
 *
 * The status line is drawn on the row BELOW the screen buffer, so a 24-row 3270
 * needs 25 terminal rows. The OIA is not part of the 1920 cells (spec: "the OIA
 * is drawn outside the screen buffer") and is owned here, not by Screen.
 */

import { sgrFor, type Depth } from './colours.js';
import type { ResolvedCell } from '@tn3270/core';

export interface Geometry { rows: number; cols: number; }

/** Does the 3270 screen plus its status row fit in the terminal? */
export function tooSmall(terminal: Geometry, screen: Geometry): boolean {
  return terminal.rows < screen.rows + 1 || terminal.cols < screen.cols;
}

interface RendererOptions extends Geometry { depth: Depth; }

const ESC = '\x1b[';

export class TerminalRenderer {
  private readonly rows: number;
  private readonly cols: number;
  private readonly depth: Depth;
  private previous: ResolvedCell[] | undefined;
  private previousCursor = -1;
  private previousStatus = '';

  constructor(opts: RendererOptions) {
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.depth = opts.depth;
  }

  /** Force the next paint to redraw everything, e.g. after a terminal resize. */
  invalidate(): void {
    this.previous = undefined;
    this.previousStatus = '';
  }

  paint(cells: readonly ResolvedCell[], cursor: number, status: string): string {
    const parts: string[] = [];
    let sgr = '';          // the SGR currently in effect on the terminal
    let lastWritten = -2;  // index of the previously emitted cell

    for (let i = 0; i < cells.length && i < this.rows * this.cols; i++) {
      const cell = cells[i]!;
      const old = this.previous?.[i];
      if (old !== undefined && sameCell(old, cell)) continue;

      // Move the cursor only when this cell does not directly follow the last
      // one we wrote. A full-screen change therefore emits one position escape.
      if (i !== lastWritten + 1) {
        const row = Math.floor(i / this.cols) + 1;
        const col = (i % this.cols) + 1;
        parts.push(`${ESC}${row};${col}H`);
      }

      const want = this.cellSgr(cell);
      if (want !== sgr) {
        parts.push(`${ESC}${want || '0'}m`);
        sgr = want;
      }
      parts.push(cell.hidden ? ' ' : cell.text);
      lastWritten = i;
    }

    if (status !== this.previousStatus) {
      parts.push(`${ESC}${this.rows + 1};1H${ESC}0m${status}${ESC}K`);
      sgr = '';
      this.previousStatus = status;
    }

    // The terminal's own cursor goes where the 3270 cursor is, so a user sees it
    // in the field they are typing into.
    if (parts.length > 0 || cursor !== this.previousCursor) {
      const row = Math.floor(cursor / this.cols) + 1;
      const col = (cursor % this.cols) + 1;
      parts.push(`${ESC}${row};${col}H`);
    }

    this.previous = cells.slice();
    this.previousCursor = cursor;
    return parts.join('');
  }

  /** The full SGR parameter list for one cell: colours plus highlighting. */
  private cellSgr(cell: ResolvedCell): string {
    const params: string[] = [];
    if (cell.blink) params.push('5');
    if (cell.reverse) params.push('7');
    if (cell.underscore) params.push('4');
    if (cell.intensify) params.push('1');
    const fg = sgrFor(cell.fg, this.depth, 'fg');
    const bg = sgrFor(cell.bg, this.depth, 'bg');
    if (fg) params.push(fg);
    if (bg) params.push(bg);
    return params.join(';');
  }
}

function sameCell(a: ResolvedCell, b: ResolvedCell): boolean {
  return a.text === b.text && a.fg === b.fg && a.bg === b.bg
    && a.blink === b.blink && a.reverse === b.reverse
    && a.underscore === b.underscore && a.intensify === b.intensify
    && a.hidden === b.hidden;
}
```

**The method is named `cellSgr`, not `sgrFor`**, deliberately: `sgrFor` is the imported function from `colours.ts` and a method of the same name would shadow it confusingly at every call site.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/tui/test/render.test.ts && npm run typecheck`
Expected: PASS. The "at most one escape per row" test may need the run-length logic tightened; if a legitimate implementation emits two per row, adjust the bound and say why — but if it emits one per *cell*, that is the bug the test is for.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/render.ts packages/tui/test/render.test.ts
git commit -m "Render resolved cells to ANSI, diffing to avoid flicker"
```

---

## Task 12: Keymap

**Files:**
- Create: `packages/tui/src/keymap.ts`
- Create: `packages/tui/test/keymap.test.ts`

Terminal bytes to **named actions** — the same names the CLI's command table uses, so the TUI implements no 3270 semantics of its own. `Keyboard` already owns field-aware typing, tab, EraseEOF, insert mode and the lock rules.

- [ ] **Step 1: Write the failing tests**

Create `packages/tui/test/keymap.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lookup, PARTIAL, type Action } from '../src/keymap.js';

/** Feed a string as bytes and expect exactly one action. */
function one(seq: string): Action {
  const r = lookup(Uint8Array.from([...seq].map((c) => c.charCodeAt(0))));
  expect(r).not.toBe(PARTIAL);
  expect(r).not.toBeNull();
  return r as Action;
}

describe('function keys', () => {
  it('maps xterm F1-F4 (SS3) to PF1-PF4', () => {
    expect(one('\x1bOP')).toEqual({ kind: 'pf', n: 1 });
    expect(one('\x1bOQ')).toEqual({ kind: 'pf', n: 2 });
    expect(one('\x1bOR')).toEqual({ kind: 'pf', n: 3 });
    expect(one('\x1bOS')).toEqual({ kind: 'pf', n: 4 });
  });

  it('maps CSI-tilde F5-F12 to PF5-PF12', () => {
    expect(one('\x1b[15~')).toEqual({ kind: 'pf', n: 5 });
    expect(one('\x1b[17~')).toEqual({ kind: 'pf', n: 6 });
    expect(one('\x1b[24~')).toEqual({ kind: 'pf', n: 12 });
  });

  it('maps shifted F1-F12 to PF13-PF24', () => {
    // c3270's convention: Shift+Fn is PF(n+12).
    expect(one('\x1b[1;2P')).toEqual({ kind: 'pf', n: 13 });
    expect(one('\x1b[24;2~')).toEqual({ kind: 'pf', n: 24 });
  });
});

describe('navigation and editing', () => {
  it('maps the arrow keys', () => {
    expect(one('\x1b[A')).toEqual({ kind: 'up' });
    expect(one('\x1b[B')).toEqual({ kind: 'down' });
    expect(one('\x1b[C')).toEqual({ kind: 'right' });
    expect(one('\x1b[D')).toEqual({ kind: 'left' });
  });

  it('maps Return to Enter and Tab to field navigation', () => {
    expect(one('\r')).toEqual({ kind: 'enter' });
    expect(one('\t')).toEqual({ kind: 'tab' });
    expect(one('\x1b[Z')).toEqual({ kind: 'backTab' });
  });

  it('maps Backspace and Delete', () => {
    expect(one('\x7f')).toEqual({ kind: 'backspace' });
    expect(one('\x1b[3~')).toEqual({ kind: 'delete' });
  });

  it('maps Home and End of field', () => {
    expect(one('\x1b[H')).toEqual({ kind: 'home' });
    expect(one('\x1b[4~')).toEqual({ kind: 'eraseEOF' });
  });

  it('maps Ctrl-U to erase input', () => {
    expect(one('\x15')).toEqual({ kind: 'eraseInput' });
  });
});

describe('the AIDs that are not function keys', () => {
  it('maps Ctrl-C to Clear, NOT to interrupt', () => {
    // Raw mode must intercept it: Clear is a 3270 AID a user needs constantly
    // (it is how MORE... is dismissed), and there is a documented way out below.
    expect(one('\x03')).toEqual({ kind: 'clear' });
  });

  it('maps Ctrl-] to quit, which is the documented escape hatch', () => {
    expect(one('\x1d')).toEqual({ kind: 'quit' });
  });

  it('maps Escape-2 and Escape-1 to PA2 and PA1', () => {
    expect(one('\x1b2')).toEqual({ kind: 'pa', n: 2 });
    expect(one('\x1b1')).toEqual({ kind: 'pa', n: 1 });
  });

  it('maps Ctrl-R to Reset', () => {
    expect(one('\x12')).toEqual({ kind: 'reset' });
  });
});

describe('ordinary characters', () => {
  it('passes printable ASCII through as typed text', () => {
    expect(one('A')).toEqual({ kind: 'type', text: 'A' });
    expect(one(' ')).toEqual({ kind: 'type', text: ' ' });
    expect(one('~')).toEqual({ kind: 'type', text: '~' });
  });
});

describe('the ambiguous-Escape problem', () => {
  it('reports a bare Escape as PARTIAL, not as an action', () => {
    // A lone ESC is indistinguishable from the start of a sequence until either
    // more bytes arrive or a timeout fires. Guessing wrong either eats the next
    // keystroke or emits a spurious PA. app.ts resolves it with a timer.
    expect(lookup(Uint8Array.from([0x1b]))).toBe(PARTIAL);
  });

  it('reports an incomplete CSI as PARTIAL', () => {
    expect(lookup(Uint8Array.from([0x1b, 0x5b]))).toBe(PARTIAL);
    expect(lookup(Uint8Array.from([0x1b, 0x5b, 0x31]))).toBe(PARTIAL);  // "\x1b[1"
  });

  it('returns null for a sequence that can never match', () => {
    // Distinct from PARTIAL: the caller must DISCARD these, not keep waiting.
    expect(lookup(Uint8Array.from([0x1b, 0x5b, 0xff]))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/tui/test/keymap.test.ts`
Expected: FAIL — cannot resolve `../src/keymap.js`.

- [ ] **Step 3: Implement**

Create `packages/tui/src/keymap.ts` with an `Action` union covering every `kind` the tests use — `pf`, `pa`, `enter`, `clear`, `reset`, `up`, `down`, `left`, `right`, `home`, `tab`, `backTab`, `backspace`, `delete`, `eraseEOF`, `eraseInput`, `type`, `quit` — a table of exact byte sequences, and:

```ts
/**
 * Sentinel: these bytes are a valid PREFIX of a longer sequence, so the caller
 * must wait for more input rather than acting or discarding.
 *
 * Returning `null` instead would conflate "wait" with "impossible", and the
 * caller's two correct responses to those are opposite: keep buffering, versus
 * throw the bytes away. A bare ESC is the case that matters -- it is a legal key
 * AND the start of every function key, and only a timeout can tell them apart.
 * app.ts owns that timer; this module stays pure.
 */
export const PARTIAL = Symbol('partial');
```

`lookup(bytes)` returns `Action | typeof PARTIAL | null`. **Build the table from terminfo where practical** rather than hardcoding xterm's: `tput -T$TERM kf5` gives F5's real sequence. The hardcoded xterm table is the fallback, because terminfo entries for shifted function keys are inconsistent in practice — say which source each entry came from in a comment.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run packages/tui/test/keymap.test.ts && npm run typecheck`
Expected: PASS on all. **If a sequence in this plan disagrees with `infocmp -T xterm-256color`, trust infocmp** and note the correction — these were written from the xterm convention, not measured on this box.

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src/keymap.ts packages/tui/test/keymap.test.ts
git commit -m "Map terminal key sequences to named 3270 actions"
```

---

## Task 13: The application — wiring, raw mode, and safe teardown

**Files:**
- Create: `packages/tui/src/app.ts`
- Modify: `packages/tui/src/main.ts`

Where the pieces meet. **The one non-negotiable requirement: raw mode must be restored on every exit path.** A TUI that dies leaving the terminal with no echo is the most user-hostile failure available here, and it is easy to ship.

- [ ] **Step 1: Write `app.ts`**

```ts
/**
 * The run loop: Session events in, ANSI out, keystrokes back.
 *
 * ## RAW MODE MUST BE RESTORED ON EVERY EXIT PATH
 *
 * Normal quit, Ctrl-], an uncaught exception, an unhandled rejection, SIGINT,
 * SIGTERM, SIGHUP. A terminal left in raw mode has no echo and no line editing,
 * and the user's only recovery is `stty sane` typed blind. `restore()` is
 * therefore idempotent and registered on all of those.
 *
 * Ctrl-C is deliberately NOT an interrupt: it is the Clear AID, which a 3270 user
 * needs constantly (it dismisses VM's MORE... state). Ctrl-] quits instead, and
 * the startup banner says so -- an undocumented escape hatch is no escape hatch.
 */

import { resolve, type Session } from '@tn3270/core';
import { detectDepth, type Depth } from './colours.js';
import { TerminalRenderer, tooSmall } from './render.js';
import { lookup, PARTIAL, type Action } from './keymap.js';

/** How long to wait before deciding a lone ESC really was Escape. */
const ESC_TIMEOUT_MS = 50;

export interface AppOptions {
  session: Session;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  depth?: Depth;
  mode3279?: boolean;
}

export class App {
  private readonly session: Session;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly renderer: TerminalRenderer;
  private readonly mode3279: boolean;
  private buffer: number[] = [];
  private escTimer: NodeJS.Timeout | undefined;
  private restored = false;
  private quitting = false;

  constructor(opts: AppOptions) {
    this.session = opts.session;
    this.stdin = opts.stdin;
    this.stdout = opts.stdout;
    this.mode3279 = opts.mode3279 ?? true;
    const screen = { rows: this.session.screen.rows, cols: this.session.screen.cols };
    this.renderer = new TerminalRenderer({
      ...screen,
      depth: opts.depth ?? detectDepth(),
    });
  }

  /** Enter raw mode, register teardown, and start drawing. */
  start(): void {
    const term = { rows: this.stdout.rows ?? 0, cols: this.stdout.columns ?? 0 };
    const screen = { rows: this.session.screen.rows, cols: this.session.screen.cols };
    if (tooSmall(term, screen)) {
      // Refuse rather than draw a misleading partial screen -- the same choice
      // Transfer() makes when the geometry is wrong.
      throw new Error(
        `terminal is ${term.cols}x${term.rows}; a ${screen.cols}x${screen.rows} ` +
        `screen plus its status line needs at least ${screen.cols}x${screen.rows + 1}`,
      );
    }

    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdout.write('\x1b[?1049h\x1b[2J');   // alternate screen buffer, cleared

    // EVERY exit path. `restore` is idempotent.
    const bail = (err?: unknown): never => {
      this.restore();
      if (err !== undefined) process.stderr.write(`${String(err)}\n`);
      process.exit(err === undefined ? 0 : 1);
    };
    process.on('exit', () => this.restore());
    process.on('uncaughtException', bail);
    process.on('unhandledRejection', bail);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => bail());
    }

    this.session.on('screen', () => this.draw());
    this.session.on('disconnect', () => { this.draw(); });
    this.stdin.on('data', (b: Buffer) => this.onInput(b));
    this.renderer.invalidate();
    this.draw();
  }

  /** Restore the terminal. Safe to call any number of times. */
  restore(): void {
    if (this.restored) return;
    this.restored = true;
    this.stdout.write('\x1b[?1049l');          // leave the alternate buffer
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
  }

  private draw(): void {
    const cells = resolve(this.session.screen.snapshot(), { mode3279: this.mode3279 });
    const out = this.renderer.paint(cells, this.session.screen.cursor, this.session.oia.toText());
    if (out !== '') this.stdout.write(out);
  }

  private onInput(bytes: Buffer): void {
    this.buffer.push(...bytes);
    this.pump();
  }

  /**
   * Drain the buffer, acting on each complete sequence.
   *
   * A PARTIAL result starts a timer rather than blocking: a lone ESC is both a
   * legal key and the prefix of every function key, and only elapsed time
   * distinguishes them. Without the timer, pressing Escape would appear to do
   * nothing until the next keypress -- and would then consume it.
   */
  private pump(): void {
    if (this.escTimer !== undefined) {
      clearTimeout(this.escTimer);
      this.escTimer = undefined;
    }
    while (this.buffer.length > 0) {
      const result = lookup(Uint8Array.from(this.buffer));
      if (result === PARTIAL) {
        this.escTimer = setTimeout(() => {
          // Timed out: treat the buffered bytes as literal and move on rather
          // than leaving them stuck forever.
          this.buffer = [];
        }, ESC_TIMEOUT_MS);
        return;
      }
      if (result === null) {
        this.buffer.shift();   // unmatchable byte; discard exactly one
        continue;
      }
      this.buffer = [];
      this.apply(result);
    }
  }

  /**
   * Perform one action.
   *
   * NOTE how thin this is: every branch delegates to `Keyboard` or `Session`.
   * The field-aware typing rules, the tab order, the keyboard lock and the AID
   * semantics all live in core and are already tested there. If a branch here
   * grows logic, that logic is in the wrong package.
   */
  private apply(action: Action): void {
    const k = this.session.keyboard;
    try {
      switch (action.kind) {
        case 'quit': this.quitting = true; this.restore(); process.exit(0); break;
        case 'type': k.typeString(action.text); break;
        case 'enter': this.session.sendAID(AID.ENTER); break;
        case 'clear': this.session.sendAID(AID.CLEAR); break;
        case 'pf': this.session.sendAID(PF_AIDS[action.n - 1]!); break;
        case 'pa': this.session.sendAID(PA_AIDS[action.n - 1]!); break;
        case 'reset': k.reset(); break;
        case 'left': k.left(); break;
        case 'right': k.right(); break;
        case 'up': k.up(); break;
        case 'down': k.down(); break;
        case 'home': k.home(); break;
        case 'tab': k.tab(); break;
        case 'backTab': k.backTab(); break;
        case 'backspace': k.backspace(); break;
        case 'delete': k.deleteChar(); break;
        case 'eraseEOF': k.eraseEOF(); break;
        case 'eraseInput': k.eraseInput(); break;
      }
    } catch (err) {
      // A rejected action (keyboard locked, not connected) is normal operation,
      // not a crash. The OIA already says why, and draw() shows it.
      void err;
    }
    this.draw();
  }
}
```

**Two things to fix as you write it, both deliberate:** `AID`, `PF_AIDS` and `PA_AIDS` need importing from `@tn3270/core` (check the real export names — the CLI uses them at `runner.ts:180-189`), and `this.quitting` is assigned but never read, so either use it to guard `draw()` after quit or delete the field. Do not leave a dead private.

- [ ] **Step 2: Finish `main.ts`**

Parse `--colors 0|8|16|256|16m`, `-model`, `--terminal-type`, and a `host:port` argument; build the session with `defaultSession(terminalType)` from `@tn3270/cli`; connect; construct `App` and `start()`. Print a one-line banner **before** entering raw mode saying `Ctrl-] quits, Ctrl-C is Clear` — the escape hatch must be documented where a first-time user sees it.

- [ ] **Step 3: Build and try it against a real host**

Run:
```bash
npm run build
node packages/tui/dist/main.js -model 3278-2-E 127.0.0.1:3270
```

Expected: the VM/370 logon screen, in colour if your terminal supports it. Press `Ctrl-]` to quit, then confirm the terminal still echoes — type `echo hello` and check you can see it.

**If the terminal is broken after quitting, that is the highest-priority bug in this task.** Fix it before anything else, and add whichever exit path you missed to the list in `start()`.

- [ ] **Step 4: Commit**

```bash
git add packages/tui/src
git commit -m "Wire the TUI run loop, with raw mode restored on every exit path"
```

---

## Task 14: Live verification against both hosts

**Files:**
- Modify: `docs/live-testing.md`

The core half is proven against a fixture; this proves the whole stack against hosts. **Both Hercules systems must be IPLed** — the user does that by hand.

- [ ] **Step 1: Check the hosts are reachable, without trusting `ss`**

Run:
```bash
for p in 3270 3271; do timeout 5 bash -c "echo > /dev/tcp/127.0.0.1/$p" 2>/dev/null \
  && echo "port $p OPEN" || echo "port $p CLOSED"; done
```

**`ss` and `netstat` report no listeners in this sandbox even when the ports are open** — use this probe. If either is closed, stop and ask the user to IPL it.

- [ ] **Step 2: Capture TK5's ISPF panel through the CLI, where colour is now visible**

Run the committed `record-mvs.txt` with `-model 3278-2-E`, then extract the resolved colours from the `ScreenJson` line and count how many distinct foreground colours the ISPF primary option menu uses. Expect **more than the four** the base-attribute map can produce; that is the live counterpart of Task 6's fixture test.

- [ ] **Step 3: Compare against `zti`, on a real tty**

`zti` renders colour and is the reference for *which* colour a cell should be. **Capture it under `script`, not a pipe:** its gate is `self.colors >= 8 && sys.stdin.isatty()` (`~/git/tnz/tnz/tnz.py:251-253`), and `self.colors` defaults to 768 (`:94`), so `isatty()` is the only thing that can fail. A piped capture reports no colour and would "prove" we emit too much.

**`zti` is NOT a reference for quantisation** — it has no depth tiering at all (`zti.py` reduces the question to a boolean `min(tns.colors, self.colors) >= 8` at `:1560`, `:3134`, `:3180`). So compare *which colour*, not which ANSI code.

- [ ] **Step 4: Drive the TUI interactively against both hosts**

VM/370 (`127.0.0.1:3270`) and TK5 (`127.0.0.1:3271`). For each: log on, navigate a panel, log off cleanly.

**Read `docs/HANDOFF.md` on the VM reconnect trap first.** A VM account left logged on is not "busy" — the next `LOGON` reconnects to the still-running machine, lands at `CP READ`, and every command then goes to CP (`?CP: ...`). Log off cleanly or the next run is contaminated.

- [ ] **Step 5: Record the results**

Add a *TUI and colour results* section to `docs/live-testing.md`: which hosts, which terminal and depth, how many distinct colours appeared, and anything that differed from the fixture. **Record what did NOT work too** — an absent finding is the one that costs a future session real time.

- [ ] **Step 6: Commit**

```bash
git add docs/live-testing.md
git commit -m "Record live TUI and colour results against both hosts"
```

---

## Task 15: Mutation-test the resolution rules

**Files:**
- Modify: `packages/core/test/render.test.ts` (only if a mutant survives)
- Modify: `packages/core/test/sa.test.ts` (likewise)

The spec requires this and it is not optional: **review on the stage 2a work found two tests that passed with the behaviour they claimed to pin deleted.** The colour rules are exactly that shape — an assertion can look right and pin nothing, because so many paths produce green.

This is a manual pass, not a tool. For each mutation: make the edit, run the named test file, confirm **at least one test fails**, then revert the edit.

- [ ] **Step 1: Mutate each resolution rule in turn and confirm a test dies**

| # | Mutation in `render.ts` | Must break |
|---|---|---|
| 1 | Delete the `mode3279` guard in `defaultColour`, so it always uses the table | the two `mode3279: false` tests |
| 2 | Change `DEFAULT_COLOURS` index order, e.g. swap `BLUE` and `WHITE` | the protected/protected-intensified tests |
| 3 | Make `usableColour` accept `0x00` | the "0x00 means device default" test |
| 4 | Remap `0xf7` to `Colour.WHITE` (the plan's original error) | the `0xF7`-stays-Neutral test |
| 5 | Make `usableColour` return `true` unconditionally | the malformed-colour test (should now throw) |
| 6 | Change `hidden` to compare against `FA.INT_HIGH_SEL` | the hidden-field test |
| 7 | Map `blink` from `XAH.REVERSE` instead of `XAH.BLINK` | the highlighting table test |

- [ ] **Step 2: Mutate each SA rule and confirm a test dies**

| # | Mutation in `execute.ts` | Must break |
|---|---|---|
| 8 | Make the SA state a single value instead of a per-type map | the composite test |
| 9 | Hoist `const sa = {}` out of `execute` to module scope | the per-write-command reset test |
| 10 | Make `XA.RESET` clear only `fg` | the reset test |
| 11 | Call `applySa` **before** `setChar` | every colour test (setChar does not clear, so this may SURVIVE — see below) |
| 12 | Delete the `delete sa.*` lines from the `'sf'` case | the plain-SF test |
| 13 | Delete the extended-pair loop from the `'sfe'` case | the SFE colour tests |

- [ ] **Step 3: If any mutant SURVIVES, the test suite has a hole — fix the test, not the mutant**

Mutation 11 is the one most likely to survive, and if it does that is informative rather than fine: it means no test distinguishes attribute-then-character from character-then-attribute. Add one — write a cell twice in the same record with different SA state between the writes, and assert the second write's colour wins.

**Record every survivor and what you added**, in the commit message. A mutation that survived and was then covered is the most valuable finding this task can produce.

- [ ] **Step 4: Confirm the suite is green with all mutations reverted**

Run: `git diff --stat packages/core/src` — expected: **empty**. If it is not, a mutation was left in. Then `npm test`.

- [ ] **Step 5: Commit (only if tests were added)**

```bash
git add packages/core/test
git commit -m "Close the holes mutation testing found in the colour rules"
```

---

## Task 16: Update the handoff

**Files:**
- Modify: `docs/HANDOFF.md`
- Modify: `docs/superpowers/specs/2026-08-19-tui-and-colour-design.md` (if measurement contradicted it)

- [ ] **Step 1: Run the full suite and record the real numbers**

Run: `npm test && npm run typecheck && npm run build`
Expected: all green. Note the actual test count — do not guess it.

- [ ] **Step 2: Rewrite the handoff's state paragraph**

Cover: extended attributes stored and resolved; the TUI as a usable client; which hosts it was driven against; the test count; and **what is still not done** — PS (`0x43` still dropped), MF colour, the web front end, the Electron GUI, mouse support.

- [ ] **Step 3: Correct the spec if any measurement contradicted it**

The spec is a design record, not scripture. If the ANSI mapping needed adjusting, or a keymap sequence was wrong, or `zti` behaved differently than described, **fix the spec and say so in the commit** — the project's convention is that documents get corrected rather than left stale, and four such corrections were made to this spec during its own review.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "Update the handoff: colour and the TUI are done"
```

---

## Verification Summary

| What | How | Where |
|---|---|---|
| Palette correctness | All 16 entries pinned against `3270ds.h`, both OCR-damaged codes explicitly | Task 2 |
| Attribute storage | Round-trip per cell; absence stays absent; snapshot frozen | Task 3 |
| The four reset rules | One test each: write command, Clear, plain SF, EW/EWA | Tasks 3, 4 |
| The composite rule | An SA colour does not clear an SA highlighting | Task 4 |
| SA type 0x00 vs value 0x00 | Distinct tests; the fixture contains twelve of the former | Tasks 1, 4 |
| Resolution rules 1-5 | One test per rule, plus `mode3279` false and a malformed colour | Task 5 |
| **The gap that started this** | TK5 fixture produces colour beyond the four-colour default map | Task 6 |
| Query Reply bytes | Both units byte-compared with x3270's `sf.c` | Task 7 |
| Quantisation | Four depths; all 16 codes; seven base colours stay distinct | Task 10 |
| Depth detection | Override > COLORTERM > terminfo > monochrome; probe failure survivable | Task 10 |
| Diffing | Unchanged repaint emits nothing; one changed cell emits one cell | Task 11 |
| Hidden fields | Text never emitted, so a password is not in the scrollback | Task 11 |
| Ambiguous Escape | `PARTIAL` distinct from `null`; timer resolves it | Tasks 12, 13 |
| Raw mode safety | Restored on quit, exception, rejection, and three signals | Task 13 |
| Live hosts | Both systems, interactively, logged off cleanly | Task 14 |
| **Do the tests actually pin anything** | 13 mutations, each must break a named test | Task 15 |

**The single most important test in this plan is Task 6's**: it replays a fixture that has been on disk since 2026-08-18, carrying 101 foreground colour orders that were silently discarded the whole time. Everything else guards behaviour we are adding; that one guards the gap we did not know we had.
