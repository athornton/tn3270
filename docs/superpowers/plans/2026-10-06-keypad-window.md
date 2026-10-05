# Keypad in Real Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the canvas-drawn keypad with real HTML controls in both front ends — a detached `BrowserWindow` for the GUI, an opaque in-pane overlay for the web gateway — styled like the transfer window, then delete the canvas keypad code that no longer has a consumer.

**Architecture:** One presentation-neutral model in `frontend` (grouping + tooltips), one shared stylesheet, two thin DOM views over it. Both views raise the SAME `Action` values the canvas keypad raised, so no protocol or dispatch change is needed. The canvas keypad's geometry and hit-testing are deleted LAST, after both replacements work.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes` on), Electron 44, vitest, Xvfb-driven by-hand harnesses.

---

## Read this before Task 1 — eight measured facts

These cost real time to establish. **Do not re-derive them, and do not trust this plan over the
source if the two disagree** — the copy/paste feature's plan carried nine defects into
implementation and the source caught every one.

1. **THE ORDER IS REPLACEMENTS FIRST, DELETION LAST, and that is not a style preference.** The spec
   makes "the four otherwise-unreachable keys keep a route" non-negotiable — **Sys Req, Dup, Field
   Mark, Newline** have no other route in any interactive front end. Deleting the canvas keypad
   before the replacements work would leave them unreachable mid-branch, with `clicks.mjs` unable to
   pass either way. Tasks 1-8 build; Tasks 9-10 delete.
2. **`frontend/dist/keypad.js` AND `bindings.js` EACH HAVE ZERO RUNTIME IMPORTS** (8209 and 5052
   bytes, measured 2026-10-06). That is what makes the one-entry import map legal in a browser, and
   it is a **FACT WITH A DATE, not an invariant** — `transferModule.test.ts` pins the same property
   for the transfer form, and the day it expires the window goes **blank with no error in any
   console**. Task 2 pins it for these two.
3. **`BINDING_INTENT` COVERS 26 OF THE 48 KEYS.** The 22 without are PF14-24, PF2-11, `SysRq` and
   `NewLn` (measured). Every key *does* have a `name`. Match on the ACTION, not the label:
   `BINDING_INTENT` entries carry `{key, action, terminal, note}` and their `key` is a chord like
   `'Ctrl-C'`, not a keypad label.
4. **A `.cts` PRELOAD, COMPILED TO `.cjs`.** An ESM preload fails with "Cannot use import statement
   outside a module" and the bridge then **silently never appears** — a window that does nothing,
   no error anywhere (`transferPreload.cts`).
5. **THE EXPOSED BRIDGE NAME MUST BE UNIQUE.** `exposeInMainWorld` defines a NON-WRITABLE property,
   and a collision is a measured hard failure: "Cannot assign to read only property 'tn3270' of
   object '#<Window>'". The transfer window is `tn3270transfer`; this one is `tn3270keypad`.
6. **IN THE WEB, `toggleKeypad` IS HANDLED SERVER-SIDE TODAY** (`web/src/main.ts:223`), because the
   keypad is in the draw list the server builds. **A DOM overlay is client-side, so `Ctrl-K` must
   stop crossing the socket** — handled in `bridgecore.ts`'s `sendAction`, exactly as `quit`
   already is. Task 7. **Do NOT remove the gateway's server-side intercept**: `integration.test.ts`
   sends every `Action` kind as a raw frame, and `applyAction` still throws on `toggleKeypad`, so
   removing it reopens the process-ending hole that cost a commit once already.
7. **THE CANVAS MUST STAY AT THE VIEWPORT ORIGIN.** `main.ts:1234` records that the click path
   depends on `html,body{margin:0}` and `canvas{display:block}` — "give the page a body margin and
   every click here misses by it". The overlay is **absolutely positioned over** the canvas, never
   a sibling that displaces it. The GUI's `index.html` is `overflow:hidden`; the web's is
   `overflow:auto`, deliberately, and neither changes.
8. **`vitest.config.ts` SETS `environment: 'node'`.** There is no `document` in any test in this
   repo and jsdom is not a dependency, so every DOM view here takes its DOM **injected**, exactly
   as `transferUi.ts` does. Logic worth testing needs no real element.

**Build discipline:** `vitest` does NOT typecheck, and the GUI/web packages resolve to `dist/`. Run
`npm run build` before believing any suite, and after a `git checkout` run
`npx tsc --build --force packages/gui packages/web` or the staleness guards redden on mtimes alone.

**Baseline to beat, measured on `edba237`:** build and typecheck clean, **2312 tests in 93 files**,
`shot.mjs` 3/3, `keys.mjs` 19/17, `clicks.mjs` 9/10, `transfer.mjs` 10/10, `select.mjs` 3/3,
`browser-shot.mjs` 2/2, `browser-keys.mjs` 13/11, `pty-smoke.py` 12 PASS / 0 FAIL.

**Create a branch before Task 1:** `git checkout -b keypad-window`. Confirm `git merge-base` equals
`main` first; the last six features each ran on one and merged `--no-ff`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/frontend/src/keypadView.ts` **(new)** | Pure: group the 48 keys into DOM blocks; compose tooltip text. No DOM. |
| `packages/frontend/test/keypadView.test.ts` **(new)** | Unit tests, including the 22-key `BINDING_INTENT` gap. |
| `packages/frontend/src/index.ts` | Export the above. |
| `packages/frontend/test/keypadModule.test.ts` **(new)** | Pin that `keypad.js`/`bindings.js` have zero runtime imports. |
| `packages/gui/ui.css` **(new)** | The shared stylesheet. Served to the web too. |
| `packages/gui/keypad.html` **(new)** | The GUI keypad window's document + import map. |
| `packages/gui/src/keypadUi.ts` **(new)** | DOM-injected view: build buttons, wire clicks. |
| `packages/gui/test/keypadUi.test.ts` **(new)** | Unit tests over a fake DOM. |
| `packages/gui/src/keypadPreload.cts` **(new)** | `tn3270keypad` bridge: one function. |
| `packages/gui/src/keypadBoot.ts` **(new)** | Browser entry: real DOM into `keypadUi`. |
| `packages/gui/src/main.ts` | Open/close the window; `Ctrl-K` and a menu item; the seam. |
| `packages/web/static/index.html` | The overlay element and its script. |
| `packages/web/src/keypadOverlay.ts` **(new)** | Toggle + build the overlay over the canvas. |
| `packages/web/src/bridgecore.ts` | Intercept `toggleKeypad` client-side. |
| `packages/web/src/httpstatic.ts` | Serve `ui.css` and the overlay module. |
| `packages/gui/scripts/clicks.mjs` | Rewired: DOM query by label. |
| **Deletions, Task 9** | `canvas/src/keypad.ts`, `canvas/src/hittest.ts`, `canvas/test/keypad.test.ts`, `gui/test/golden/synthetic-ispf-keypad.*` |

---

## Task 1: `keypadView.ts` — grouping the 48 keys

**Files:**
- Create: `packages/frontend/src/keypadView.ts`
- Create: `packages/frontend/test/keypadView.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { KEYPAD_BLOCKS } from '../src/keypadView.js';
import { KEYPAD_KEYS } from '../src/keypad.js';

describe('KEYPAD_BLOCKS', () => {
  it('accounts for EVERY key exactly once', () => {
    // THE PROPERTY THAT MATTERS: a regrouping must not lose a key. 48 buttons in, 48 out, and
    // no key in two blocks -- which a hand-written grouping can easily do and which would
    // present as a duplicate button rather than as an error.
    const grouped = KEYPAD_BLOCKS.flatMap((b) => b.keys);
    expect(grouped).toHaveLength(KEYPAD_KEYS.length);
    expect(new Set(grouped.map((k) => k.label)).size).toBe(KEYPAD_KEYS.length);
    expect([...grouped].map((k) => k.label).sort())
      .toEqual([...KEYPAD_KEYS].map((k) => k.label).sort());
  });

  it('puts the PF keys in two rows of twelve, in numeric order', () => {
    // PF13-24 ABOVE PF1-12, which is the shipped layout and x3270's: the canvas keypad put
    // row 0 at PF13 deliberately. A DOM layout that reordered them would be a silent relearn
    // for anyone used to the old one.
    const pf = KEYPAD_BLOCKS.filter((b) => b.id === 'pf-high' || b.id === 'pf-low');
    expect(pf).toHaveLength(2);
    expect(pf[0]!.keys.map((k) => k.label)[0]).toBe('PF13');
    expect(pf[0]!.keys).toHaveLength(12);
    expect(pf[1]!.keys.map((k) => k.label)[0]).toBe('PF1');
    expect(pf[1]!.keys).toHaveLength(12);
  });

  it('gives every block a non-empty id and title', () => {
    // The title is a visible heading, so an empty one is a blank label in the window.
    for (const b of KEYPAD_BLOCKS) {
      expect(b.id, 'a block has no id').not.toBe('');
      expect(b.title, `block ${b.id} has no title`).not.toBe('');
      expect(b.keys.length, `block ${b.id} is empty`).toBeGreaterThan(0);
    }
  });

  it('has no block with a duplicate id', () => {
    const ids = KEYPAD_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/frontend/test/keypadView.test.ts`
Expected: FAIL — `Failed to resolve import "../src/keypadView.js"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { KEYPAD_KEYS, type KeypadKey } from './keypad.js';

/**
 * The 48 keys grouped for a DOM layout, and their tooltips.
 *
 * ## WHY A SECOND GROUPING RATHER THAN `KeypadKey.row`/`col`
 *
 * Those two are CELL COORDINATES for a blitter: `col` is a left edge in character cells, six
 * cells per key, sized to fit inside an 80-column screen. A DOM layout has none of those
 * constraints and wants semantic groups instead -- "the PF13-24 row", "the cursor cluster" --
 * which is also what lets the window be laid out by CSS rather than by arithmetic.
 *
 * `row`/`col` are left in place on `KeypadKey` and marked deprecated rather than deleted; see
 * the note there. Deleting fields from a 48-row table in the same change that rewrites two front
 * ends mixes two risks.
 *
 * ## THE GROUPING IS WRITTEN DOWN, NOT DERIVED
 *
 * Deriving blocks from `col` gaps would make this agree with the canvas layout by construction,
 * and so unable to disagree -- the same argument `KEYPAD_ROWS` already makes for itself. Written
 * down, a key that falls out of every block is a test failure.
 */
export interface KeypadBlock {
  /** Stable identifier, used as a DOM id suffix and in tests. */
  readonly id: string;
  /** Visible heading. */
  readonly title: string;
  readonly keys: readonly KeypadKey[];
}

const byLabel = (label: string): KeypadKey => {
  const key = KEYPAD_KEYS.find((k) => k.label === label);
  // THROWS RATHER THAN SKIPS. A typo'd label here would otherwise silently drop a button, and
  // for `SysRq`, `Dup`, `FldMk` or `NewLn` that means a key with NO route in any interactive
  // front end -- the one thing the spec calls non-negotiable.
  if (key === undefined) throw new Error(`no keypad key labelled ${label}`);
  return key;
};

const pfRange = (from: number): readonly KeypadKey[] =>
  Array.from({ length: 12 }, (_, i) => byLabel(`PF${from + i}`));

export const KEYPAD_BLOCKS: readonly KeypadBlock[] = Object.freeze([
  // PF13-24 ABOVE PF1-12, matching the shipped canvas layout and x3270's.
  { id: 'pf-high', title: 'PF13-24', keys: pfRange(13) },
  { id: 'pf-low', title: 'PF1-12', keys: pfRange(1) },
  {
    id: 'attention',
    title: 'Attention',
    keys: ['PA1', 'PA2', 'PA3', 'Attn', 'SysRq', 'Clear', 'Reset'].map(byLabel),
  },
  {
    id: 'cursor',
    title: 'Cursor',
    keys: ['Home', '^', 'v', '<', '>', 'Tab', 'BkTab', 'NewLn'].map(byLabel),
  },
  {
    id: 'editing',
    title: 'Editing',
    keys: ['Ins', 'Del', 'BkSp', 'ErEOF', 'ErInp', 'Dup', 'FldMk'].map(byLabel),
  },
  { id: 'send', title: 'Send', keys: ['Enter', 'Xfer'].map(byLabel) },
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run packages/frontend/test/keypadView.test.ts`
Expected: PASS, 4 tests.

**If the "every key exactly once" test fails**, the block lists above are missing a label or
carrying one twice. The failure names the labels — fix the lists, not the test: that test is the
whole protection against a dropped button.

- [ ] **Step 5: Commit**

```bash
git add packages/frontend/src/keypadView.ts packages/frontend/test/keypadView.test.ts
git commit -m "feat: group the 48 keypad keys for a DOM layout, every key accounted for"
```

---

## Task 2: tooltips, and the module-graph pin

**Files:**
- Modify: `packages/frontend/src/keypadView.ts`
- Modify: `packages/frontend/test/keypadView.test.ts`
- Create: `packages/frontend/test/keypadModule.test.ts`
- Modify: `packages/frontend/src/index.ts`

- [ ] **Step 1: Write the failing tooltip tests**

Append to `packages/frontend/test/keypadView.test.ts`:

```typescript
import { tooltipFor } from '../src/keypadView.js';

describe('tooltipFor', () => {
  it('uses the key NAME for a key with no BINDING_INTENT entry', () => {
    // MEASURED 2026-10-06: BINDING_INTENT has an ENTRY for 26 of the 48 keys. The 22 without are
    // PF14-24, PF2-11, SysRq and NewLn. Those must still get a tooltip, or a third of the window
    // is bare.
    expect(tooltipFor(byLabelInTest('PF14'))).toBe('PF14');
    expect(tooltipFor(byLabelInTest('SysRq'))).toBe('System Request');
  });

  it('uses the key NAME when a binding EXISTS but carries no note', () => {
    /**
     * THE CASE THAT IS NOT THE SAME AS "no entry", AND IT IS THE BIGGER OF THE TWO. `note` is
     * OPTIONAL on `Binding` (`bindings.ts:32`), and MEASURED 2026-10-06, 15 keypad keys match an
     * entry that has none: PF1, PF3, PA2, PA3, Home, the four arrows, Reset, ErInp, Tab, BkTab,
     * Del, BkSp -- most of the cursor cluster among them.
     *
     * So "found a binding" and "has prose" are different questions. Reading `binding.note`
     * after checking only `binding === undefined` throws on all 15.
     */
    expect(tooltipFor(byLabelInTest('Tab'))).toBe('Tab');
    expect(tooltipFor(byLabelInTest('Home'))).toBe('Home');
    expect(tooltipFor(byLabelInTest('<'))).toBe('Cursor left');
  });

  it('APPENDS the BINDING_INTENT note when there is one', () => {
    // `BINDING_INTENT` holds prose nothing currently shows a user, which the idea doc calls the
    // cheapest visible win here. Matched on the ACTION, not the label: its `key` field is a chord
    // like 'Ctrl-C', not a keypad label.
    const tip = tooltipFor(byLabelInTest('Clear'));
    expect(tip.startsWith('Clear')).toBe(true);
    expect(tip).toContain('MORE...');          // from the Clear note
    expect(tip.length).toBeGreaterThan('Clear'.length);
  });

  it('NEVER returns an empty tooltip, for any of the 48', () => {
    // The property, rather than a spot check: a blank `title` attribute is a tooltip that
    // flickers and says nothing, which is worse than none at all.
    for (const key of KEYPAD_KEYS) {
      expect(tooltipFor(key), `${key.label} has no tooltip`).not.toBe('');
    }
  });

  it('never repeats the name when the note already starts with it', () => {
    // Guards the join, not the data: "Enter -- the Enter AID ..." must not come out as
    // "Enter -- Enter -- ...".
    for (const key of KEYPAD_KEYS) {
      expect(tooltipFor(key)).not.toMatch(/^(.+?) -- \1/);
    }
  });
});

/** Local lookup, so the tests do not depend on the module's private helper. */
function byLabelInTest(label: string) {
  const k = KEYPAD_KEYS.find((x) => x.label === label);
  if (k === undefined) throw new Error(`test asked for a missing label ${label}`);
  return k;
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/frontend/test/keypadView.test.ts`
Expected: FAIL — `tooltipFor` is not exported.

- [ ] **Step 3: Implement `tooltipFor`**

Append to `packages/frontend/src/keypadView.ts`:

```typescript
import { BINDING_INTENT } from './bindings.js';

/**
 * Tooltip text for a key: its name, plus the binding note when one exists.
 *
 * ## THE DATA IS UNEVEN AND THIS IS WHERE THAT IS HANDLED
 *
 * MEASURED 2026-10-06: `BINDING_INTENT` has an entry for 26 of the 48 keys. The 22 without are
 * PF14-24, PF2-11, `SysRq` and `NewLn` -- mostly PF keys, whose meaning is HOST-DEPENDENT and
 * cannot honestly be described beyond their number. So `name` is the floor and the note is the
 * bonus; nothing is ever blank, and no prose has to be invented to fill a table.
 *
 * MATCHED ON THE ACTION, NOT THE LABEL. `BINDING_INTENT`'s `key` field is a keyboard chord
 * ('Ctrl-C', 'Enter'), not a keypad label, so matching on it would silently find nothing for most
 * keys -- and "silently finds nothing" is indistinguishable here from "has no note".
 */
export function tooltipFor(key: KeypadKey): string {
  const wanted = JSON.stringify(key.action);
  const binding = BINDING_INTENT.find((b) => JSON.stringify(b.action) === wanted);
  // `note` IS OPTIONAL ON `Binding` (`bindings.ts:32`, `note?: string`), AND 15 KEYPAD KEYS HIT
  // THAT CASE -- measured: PF1, PF3, PA2, PA3, Home, the four arrows, Reset, ErInp, Tab, BkTab,
  // Del, BkSp. So a binding being FOUND does not mean there is prose to show, and the two
  // conditions have to be checked separately. The first draft of this function tested only
  // `binding === undefined` and then read `binding.note.startsWith(...)`, which would have thrown
  // on every one of those 15 -- including Tab, Home and all four arrows, i.e. most of the cursor
  // cluster.
  const note = binding?.note;
  if (note === undefined) return key.name;
  // Do not repeat the name when the note already opens with it.
  if (note.startsWith(key.name)) return note;
  return `${key.name} -- ${note}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx vitest run packages/frontend/test/keypadView.test.ts`
Expected: PASS, 9 tests (4 from Task 1, 5 here).

- [ ] **Step 5: Pin the module graph, which is what keeps a browser window from going blank**

Create `packages/frontend/test/keypadModule.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `keypad.js` and `bindings.js` must stay importable by a BROWSER with no bundler.
 *
 * `gui/keypad.html` carries an import map resolving `@tn3270/frontend` to ONE of these files, so
 * the module graph has to CLOSE there. A runtime import of anything else -- most dangerously the
 * package barrel, which reaches `tls.js` and its `node:net`/`node:tls`/`node:fs` -- is a specifier
 * no browser can resolve, and the failure arrives as a BLANK WINDOW WITH NO ERROR in any console.
 * This repo has met that five separate ways.
 *
 * `transferModule.test.ts` is the precedent and pins the identical property for
 * `transferForm.js`. Measured 2026-10-06: both files below have zero runtime imports.
 */
const frontendDir = dirname(dirname(fileURLToPath(import.meta.url)));

describe('the keypad modules a browser loads', () => {
  it('were built (run npm run build first)', () => {
    for (const f of ['keypad.js', 'bindings.js']) {
      expect(existsSync(join(frontendDir, 'dist', f)), `missing dist/${f}`).toBe(true);
    }
  });

  it('have NO runtime imports at all, so the graph closes at one file', () => {
    // `import type` erases, which is why this reads the BUILT javascript rather than the source.
    for (const f of ['keypad.js', 'bindings.js']) {
      const text = readFileSync(join(frontendDir, 'dist', f), 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      expect(imports, `dist/${f} gained a runtime import`).toEqual([]);
    }
  });
});
```

- [ ] **Step 6: Export from the barrel**

In `packages/frontend/src/index.ts`, beside the existing `KEYPAD_KEYS` export:

```typescript
// The DOM-facing view of the keypad: semantic blocks and tooltip text. Separate from
// `KEYPAD_KEYS` because `row`/`col` there are cell coordinates for a blitter, which a DOM layout
// does not use.
export { KEYPAD_BLOCKS, tooltipFor } from './keypadView.js';
export type { KeypadBlock } from './keypadView.js';
```

- [ ] **Step 7: Run and commit**

```bash
npm run build && npm run typecheck && npx vitest run packages/frontend
git add packages/frontend/src/keypadView.ts packages/frontend/src/index.ts \
        packages/frontend/test/keypadView.test.ts packages/frontend/test/keypadModule.test.ts
git commit -m "feat: keypad tooltips from name plus BINDING_INTENT, with the browser graph pinned"
```

Expected: build and typecheck clean; all frontend tests pass.

---

## Task 3: the shared stylesheet

**Files:**
- Create: `packages/gui/ui.css`
- Modify: `packages/gui/transfer.html`

**Why first, before either view:** the user's requirement is that the keypad and the transfer window
look stylistically similar. `transfer.html` inlines its CSS today; without extracting it now, the
keypad becomes a second copy and the web overlay a third.

- [ ] **Step 1: Create the stylesheet with the transfer window's existing rules**

```css
/*
  Shared chrome for every HTML surface in this project: the transfer window, the GUI keypad
  window, and the web gateway's keypad overlay.

  ## ONE FILE, THREE DOCUMENTS, AND THAT IS THE REQUIREMENT RATHER THAN TIDINESS

  The user's call (2026-10-06) is that the keypad and the transfer window be stylistically
  similar. `transfer.html` inlined these rules, so a second surface meant a second copy and a
  third meant a third -- and three copies of a `font:` declaration diverge the first time one is
  touched.

  ## "NATIVE, NOT X-ISH", CONCRETELY

  The user asked for something that "looks like a native app, not an X-windows app", with a
  pleasant font. That means: `system-ui`, so each platform supplies its own; `color-scheme: light
  dark`, so the OS theme is honored rather than a hardcoded palette; and system color keywords
  like `GrayText` and `Canvas` rather than hex values, so high-contrast and dark modes keep
  working. NOTHING here uses the 3270 atlas -- that is the whole point of moving off the canvas.

  THE 3270 SCREEN ITSELF IS NOT STYLED BY THIS FILE. The canvas is pixels from an atlas and must
  stay that way; `index.html` in both front ends keeps its own two-line style block.
*/

:root { color-scheme: light dark; }

body {
  font: 13px system-ui, sans-serif;
  margin: 0;
  padding: 12px 14px;
}

h1 { font-size: 13px; font-weight: 600; margin: 0 0 10px; }

/* The transfer form's field grid. */
.row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  gap: 6px 8px;
  align-items: center;
  margin-bottom: 6px;
}

label { text-align: right; color: GrayText; }
input, select { font: inherit; padding: 2px 4px; min-width: 0; }
input[disabled], select[disabled] { opacity: 0.5; }

/*
  NO `#status.error` RULE, deliberately -- carried over from `transfer.html` with its reasoning
  intact. `UiDeps.setStatus` takes a BARE STRING, so a help line, a progress report and a
  validator complaint are indistinguishable by the time they reach the DOM; nothing could ever
  add that class, and the rule would be dead CSS promising a color it never paints. Styling an
  error needs the distinction carried across the boundary -- a second argument on `setStatus`, or
  a separate `setError` -- which is a change to `transferUi.ts`'s interface and its tests.
*/
#status { margin: 10px 0 12px; min-height: 2.4em; white-space: pre-wrap; color: GrayText; }

#buttons { display: flex; gap: 8px; justify-content: flex-end; }
button { font: inherit; padding: 3px 12px; }

/* ---- The keypad ---- */

/*
  A block per semantic group from `KEYPAD_BLOCKS`, each a wrapping flex row of buttons. The PF
  blocks hold twelve and are allowed to wrap; the clusters hold seven or eight.

  NO FIXED PIXEL GRID AND NO PER-KEY POSITIONING, which is the substantive difference from the
  canvas keypad: that one computed a left edge in character cells for every key. Here the browser
  lays the buttons out, so a longer label grows its button instead of overflowing into the next
  one -- the `KeypadKey.label` 5-character limit exists for the canvas and is why labels read
  `FldMk` and `BkSp`.
*/
.keypad-block { margin: 0 0 10px; }
.keypad-block > h2 {
  font-size: 11px; font-weight: 600; color: GrayText;
  margin: 0 0 4px; text-transform: uppercase; letter-spacing: 0.04em;
}
.keypad-keys { display: flex; flex-wrap: wrap; gap: 4px; }
.keypad-keys > button { min-width: 3.4em; padding: 3px 6px; }

/*
  THE WEB OVERLAY, which the GUI does not use: in a window the keypad IS the document, but a
  browser tab has only the one pane.

  OPAQUE, NOT TRANSLUCENT, and that is the user's call with a measured reason behind it: the TUI's
  overlay once had host text leak through into its chord column, and opacity was the hard-won fix.
  An overlay that lets the screen show through is a legibility bug waiting to be re-found.

  `position: fixed` AND NOT A SIBLING IN FLOW. `gui/src/main.ts:1234` records that the click path
  depends on the canvas sitting at the viewport origin -- "give the page a body margin and every
  click here misses by it" -- so this must float OVER the canvas and never displace it.
*/
#keypad-overlay {
  position: fixed;
  inset: 0;
  overflow: auto;
  background: Canvas;
  color: CanvasText;
  padding: 12px 14px;
}
#keypad-overlay[hidden] { display: none; }
#keypad-overlay > .keypad-close { position: absolute; top: 8px; right: 10px; }
```

- [ ] **Step 2: Point `transfer.html` at it and delete the inlined copy**

In `packages/gui/transfer.html`, replace the whole `<style>…</style>` block with:

```html
<!--
  THE SHARED STYLESHEET, not an inlined copy. `ui.css` carries these rules verbatim, including the
  note about why there is no `#status.error` rule. The keypad window and the web overlay load the
  same file, which is what the "stylistically similar" requirement actually implies.

  A RELATIVE PATH FROM THIS DOCUMENT, which sits in `packages/gui/` -- the same directory as
  `ui.css`, unlike the import map above, whose address resolves against this document's base URL
  and therefore reaches up into `../frontend/`.
-->
<link rel="stylesheet" href="./ui.css">
```

- [ ] **Step 3: Verify the transfer window still renders**

```bash
npm run build && npx tsc --build --force packages/gui
node packages/gui/scripts/transfer.mjs
```

Expected: **`10/10 checks passed`**. This harness drives the real window under Xvfb, so a
stylesheet that 404s shows up as a failure here rather than as a cosmetic surprise later.

**If it fails with a blank or unstyled window**, the `href` is wrong relative to `transfer.html`'s
own location. `transfer.html` is `packages/gui/transfer.html`; `ui.css` is `packages/gui/ui.css`.

- [ ] **Step 4: Commit**

```bash
git add packages/gui/ui.css packages/gui/transfer.html
git commit -m "refactor: extract the transfer window's CSS into a shared ui.css"
```

---

## Task 4: `keypadUi.ts` — the DOM view, with the DOM injected

**Files:**
- Create: `packages/gui/src/keypadUi.ts`
- Create: `packages/gui/test/keypadUi.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createKeypadUi, type KeypadDeps } from '../src/keypadUi.js';
import { KEYPAD_KEYS } from '@tn3270/frontend';

/**
 * A FAKE DOM, because `vitest.config.ts` sets `environment: 'node'` -- there is no `document` in
 * any test in this repo and jsdom is not a dependency. Same shape as `transferUi.test.ts`: the
 * logic worth testing is which buttons exist and what each sends, and that needs no real element.
 */
interface FakeEl {
  tag: string;
  text: string;
  title: string;
  children: FakeEl[];
  onClick?: () => void;
  attrs: Record<string, string>;
}

function fakeDom(): { deps: KeypadDeps; root: FakeEl; sent: unknown[] } {
  const make = (tag: string): FakeEl =>
    ({ tag, text: '', title: '', children: [], attrs: {} });
  const root = make('div');
  const sent: unknown[] = [];
  const deps: KeypadDeps = {
    root: root as unknown as HTMLElement,
    create: ((tag: string) => make(tag)) as unknown as KeypadDeps['create'],
    append: ((parent: unknown, child: unknown) => {
      (parent as FakeEl).children.push(child as FakeEl);
    }) as KeypadDeps['append'],
    setText: ((el: unknown, text: string) => { (el as FakeEl).text = text; }) as KeypadDeps['setText'],
    setTitle: ((el: unknown, t: string) => { (el as FakeEl).title = t; }) as KeypadDeps['setTitle'],
    setAttr: ((el: unknown, k: string, v: string) => {
      (el as FakeEl).attrs[k] = v;
    }) as KeypadDeps['setAttr'],
    onClick: ((el: unknown, fn: () => void) => { (el as FakeEl).onClick = fn; }) as KeypadDeps['onClick'],
    sendAction: (a) => { sent.push(a); },
  };
  return { deps, root, sent };
}

/** Every button in the tree, depth-first. */
function buttons(el: FakeEl): FakeEl[] {
  return el.tag === 'button' ? [el] : el.children.flatMap(buttons);
}

describe('createKeypadUi', () => {
  it('builds a button for EVERY one of the 48 keys', () => {
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    expect(buttons(root)).toHaveLength(KEYPAD_KEYS.length);
  });

  it('labels each button as the key is labelled', () => {
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    const labels = buttons(root).map((b) => b.text).sort();
    expect(labels).toEqual([...KEYPAD_KEYS].map((k) => k.label).sort());
  });

  it('SENDS THE RIGHT ACTION for the keys nothing else can reach', () => {
    /**
     * Sys Req, Dup, Field Mark and Newline have NO other route in any interactive front end --
     * the spec calls that non-negotiable -- so a label/action transposition here makes a
     * capability unreachable rather than merely mis-wired. The same four `clicks.mjs` covers.
     */
    const { deps, root, sent } = fakeDom();
    createKeypadUi(deps);
    const press = (label: string): void => {
      const b = buttons(root).find((x) => x.text === label);
      if (b === undefined) throw new Error(`no button ${label}`);
      b.onClick!();
    };
    press('SysRq');
    press('Dup');
    press('FldMk');
    press('NewLn');
    expect(sent).toEqual([
      { kind: 'sysreq' }, { kind: 'dup' }, { kind: 'fieldMark' }, { kind: 'newline' },
    ]);
  });

  it('carries a non-empty tooltip on every button', () => {
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    for (const b of buttons(root)) {
      expect(b.title, `${b.text} has no tooltip`).not.toBe('');
    }
  });

  it('gives every button type=button, so none submits anything', () => {
    // A bare <button> inside a form defaults to type=submit. There is no form here today, and
    // this is what keeps a later one from turning a PF key into a page reload.
    const { deps, root } = fakeDom();
    createKeypadUi(deps);
    for (const b of buttons(root)) expect(b.attrs['type']).toBe('button');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/gui/test/keypadUi.test.ts`
Expected: FAIL — cannot resolve `../src/keypadUi.js`.

- [ ] **Step 3: Write the implementation**

```typescript
import { KEYPAD_BLOCKS, tooltipFor, type Action } from '@tn3270/frontend';

/**
 * The keypad's browser-side view, with the DOM INJECTED.
 *
 * ## WHY THE DOM IS INJECTED AND NOT REACHED FOR
 *
 * `vitest.config.ts` sets `environment: 'node'`, so there is no `document` in any test in this
 * repo and jsdom is not a dependency. Exactly the shape `transferUi.ts` arrived at for the same
 * reason: the logic worth testing -- which buttons exist, what each one sends, what tooltip it
 * carries -- needs no real element, and injecting the few operations that do keeps every line
 * reachable from a unit test.
 *
 * ## A BROWSER LOADS THIS, AND AN IMPORT MAP IS WHAT MAKES THAT LEGAL
 *
 * The import above is a BARE SPECIFIER and stays one in the emitted JS -- `tsc` rewrites nothing.
 * `keypad.html` carries an import map resolving it to `../frontend/dist/keypadView.js`.
 *
 * SO DO NOT ADD A SECOND WORKSPACE IMPORT TO THIS FILE, and do not import the package barrel:
 * that reaches `tls.js`, whose `node:net`/`node:tls`/`node:fs` no browser can resolve, and the
 * failure arrives as a BLANK WINDOW WITH NO ERROR. `keypadModule.test.ts` pins the graph.
 */
export interface KeypadDeps {
  readonly root: HTMLElement;
  readonly create: (tag: string) => HTMLElement;
  readonly append: (parent: HTMLElement, child: HTMLElement) => void;
  readonly setText: (el: HTMLElement, text: string) => void;
  readonly setTitle: (el: HTMLElement, title: string) => void;
  readonly setAttr: (el: HTMLElement, name: string, value: string) => void;
  readonly onClick: (el: HTMLElement, fn: () => void) => void;
  readonly sendAction: (action: Action) => void;
}

/**
 * Build the keypad into `deps.root`.
 *
 * ONE BUTTON PER KEY, FROM `KEYPAD_BLOCKS`, so the 48 keys and their actions stay the single
 * authority in `packages/frontend`. This file decides nothing about which keys exist.
 */
export function createKeypadUi(deps: KeypadDeps): void {
  for (const block of KEYPAD_BLOCKS) {
    const section = deps.create('div');
    deps.setAttr(section, 'class', 'keypad-block');
    deps.setAttr(section, 'id', `keypad-${block.id}`);

    const heading = deps.create('h2');
    deps.setText(heading, block.title);
    deps.append(section, heading);

    const keys = deps.create('div');
    deps.setAttr(keys, 'class', 'keypad-keys');
    for (const key of block.keys) {
      const button = deps.create('button');
      // `type=button` EXPLICITLY: a bare <button> inside a form defaults to type=submit. There is
      // no form here today, and this is what stops a later one turning a PF key into a reload.
      deps.setAttr(button, 'type', 'button');
      // THE LABEL IS THE HANDLE THE HARNESS USES. `clicks.mjs` queries BY LABEL, deliberately: a
      // coordinate list would be a second copy of the layout and would pass while the layout was
      // wrong. `data-label` carries it machine-readably so a future icon cannot break the query.
      deps.setAttr(button, 'data-label', key.label);
      deps.setText(button, key.label);
      deps.setTitle(button, tooltipFor(key));
      deps.onClick(button, () => { deps.sendAction(key.action); });
      deps.append(keys, button);
    }
    deps.append(section, keys);
    deps.append(deps.root, section);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && npx vitest run packages/gui/test/keypadUi.test.ts`
Expected: PASS, 5 tests.

**`Action` must be exported from `@tn3270/frontend`** — it is (`index.ts:42`, `export type { Action }`).

- [ ] **Step 5: MUTATION-VERIFY the label/action wiring**

In `keypadUi.ts`, change `deps.sendAction(key.action)` to `deps.sendAction(KEYPAD_BLOCKS[0]!.keys[0]!.action)`.
Rebuild and run the file.

Expected: the *"SENDS THE RIGHT ACTION"* test fails, reporting four `{kind:'pf',n:13}` values.
**Restore and re-run.** Those four keys have no other route anywhere, so a test that could not see
a transposition would be protecting nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/gui/src/keypadUi.ts packages/gui/test/keypadUi.test.ts
git commit -m "feat: a DOM keypad view with the DOM injected, label/action wiring mutation-verified"
```

---

## Task 5: the GUI window — document, preload, boot

**Files:**
- Create: `packages/gui/keypad.html`
- Create: `packages/gui/src/keypadPreload.cts`
- Create: `packages/gui/src/keypadBoot.ts`

**No unit test covers this task.** `keypadBoot.ts` needs a real `document` and the preload needs a
real Electron; both are covered by Task 8's harness. **Keep them thin** and lean on Task 4.

- [ ] **Step 1: The document**

`packages/gui/keypad.html`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Keypad</title>
<!--
  The import map is what lets `keypadUi.js` say `@tn3270/frontend` while a browser resolves it.
  A bare specifier is unresolvable in a browser and there is NO BUNDLER here: the window would go
  blank with no error, which this repo has met five separate ways.

  IT POINTS AT `keypadView.js` AND NOT AT THE BARREL, deliberately. The barrel reaches `tls.js`
  and its `node:net`/`node:tls`/`node:fs` imports, which no browser can resolve.
  `keypadView.js` value-imports `keypad.js` and `bindings.js`, each of which has ZERO runtime
  imports (measured 2026-10-06), so the graph closes at three files -- all of them inside
  `packages/frontend/dist`, all resolvable by relative path from the map's address.
  `keypadModule.test.ts` pins that property, and the day it expires this window goes blank.

  A map address resolves against the DOCUMENT's base URL, not the importing module's, so
  `../frontend/...` is relative to this file in `packages/gui/` even though the importer that says
  `@tn3270/frontend` lives a directory deeper in `packages/gui/dist/`.

  Same cross-package reach as `transfer.html` and `index.html`, and the same caveat: it assumes
  `gui` and `frontend` stay siblings on disk, which is true in the workspace and false in an asar
  bundle. Packaging has to rewrite all three.
-->
<script type="importmap">
{ "imports": { "@tn3270/frontend": "../frontend/dist/keypadView.js" } }
</script>
<link rel="stylesheet" href="./ui.css">
</head>
<body>
  <h1>Keypad</h1>
  <div id="keys"></div>
  <script type="module" src="./dist/keypadBoot.js"></script>
</body></html>
```

- [ ] **Step 2: The preload**

`packages/gui/src/keypadPreload.cts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The keypad window's bridge. A `.cts` FILE ON PURPOSE -- an ESM preload fails with "Cannot use
 * import statement outside a module" and the bridge then silently never appears, leaving a window
 * that does nothing and no error anywhere. See `preload.cts` and `transferPreload.cts`.
 *
 * ## ONE FUNCTION, WHICH IS THE WHOLE SURFACE
 *
 * A keypad press is exactly the `sendAction` the canvas window already has, so this window needs
 * nothing else: no invoke, no reply, no events. It reuses main's EXISTING `ipcMain.on('action')`
 * handler, which is why no new IPC channel appears anywhere in this feature.
 *
 * ## THE NAME IS DIFFERENT FROM BOTH OTHER WINDOWS', DELIBERATELY
 *
 * `exposeInMainWorld` defines a NON-WRITABLE property, and `main.ts:161-164` records the measured
 * failure from a collision ("Cannot assign to read only property 'tn3270' of object
 * '#<Window>'"). The canvas window is `tn3270`, the transfer window `tn3270transfer`, so this is
 * `tn3270keypad`.
 *
 * `contextIsolation` stays on and `nodeIntegration` off: this window sits in front of a logged-on
 * host session and sends it AIDs, so it is the last place to grant Node access.
 */
contextBridge.exposeInMainWorld('tn3270keypad', {
  /** Fire a keypad action at the session. Fire-and-forget: the screen repaints by itself. */
  sendAction: (action: unknown): void => { ipcRenderer.send('action', action); },
});
```

- [ ] **Step 3: The boot file**

`packages/gui/src/keypadBoot.ts`:

```typescript
import { createKeypadUi } from './keypadUi.js';

/**
 * The keypad window's entry point: the real DOM, handed to the testable view.
 *
 * ## EVERY LINE HERE IS UNTESTABLE AND THAT IS WHY THERE ARE SO FEW
 *
 * `vitest.config.ts` is `environment: 'node'`, so nothing in this repo can execute a line of this
 * file -- it reads `document` in its module body. `keypadUi.ts` holds every decision; this only
 * adapts. The transfer window's equivalent shipped a BLANK WINDOW once, from a TDZ read on an
 * uninitialised `const`, and the lesson recorded then applies unchanged: an untestable boot file
 * must be LOADED to be believed, never reasoned about. Task 8's harness loads it.
 *
 * `optional chaining does not guard a TDZ read` -- `ui?.x` still throws on an uninitialised
 * const -- so there is no clever guard here, just a hard failure with a message.
 */
const root = document.getElementById('keys');
if (root === null) throw new Error('keypad window: #keys is missing from keypad.html');

const bridge = (window as unknown as {
  tn3270keypad?: { sendAction: (a: unknown) => void };
}).tn3270keypad;
// A MISSING BRIDGE IS A LOUD FAILURE, not a dead keypad. The preload is a `.cjs` loaded by path;
// if it failed to load, every button would silently do nothing -- the exact shape this project
// has met five ways. The message reaches main through `console-message` forwarding.
if (bridge === undefined) throw new Error('keypad window: the tn3270keypad bridge is absent');

createKeypadUi({
  root,
  create: (tag) => document.createElement(tag),
  append: (parent, child) => { parent.appendChild(child); },
  setText: (el, text) => { el.textContent = text; },
  setTitle: (el, title) => { el.title = title; },
  setAttr: (el, name, value) => { el.setAttribute(name, value); },
  onClick: (el, fn) => { el.addEventListener('click', fn); },
  sendAction: (action) => { bridge.sendAction(action); },
});
```

- [ ] **Step 4: Make sure the preload and the stylesheet get into `dist/`**

Check how `transferPreload.cts` reaches `dist/transferPreload.cjs` and follow it exactly:

```bash
grep -rn "transferPreload" packages/gui/package.json packages/gui/tsconfig.json
ls packages/gui/dist/transferPreload.cjs
```

**`tsc` compiles `.cts` to `.cjs` by itself**, so if `transferPreload.cjs` is in `dist/` with no
build-script step, nothing extra is needed. Verify after a build:

```bash
npm run build && ls packages/gui/dist/keypadPreload.cjs packages/gui/dist/keypadBoot.js
```

Expected: both exist. **If `keypadPreload.cjs` is missing**, read `packages/gui/tsconfig.json`'s
`include` and add the file there rather than inventing a copy step.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run build && npm run typecheck
git add packages/gui/keypad.html packages/gui/src/keypadPreload.cts packages/gui/src/keypadBoot.ts
git commit -m "feat: the GUI keypad window's document, preload and boot"
```

Expected: clean. **No harness yet** — Task 8 is what proves this window opens at all.

---

## Task 6: main opens the window, and `Ctrl-K` means "open"

**Files:**
- Modify: `packages/gui/src/main.ts`

- [ ] **Step 1: Add the window, modeled on `openTransferWindow`**

Beside `transferWin`/`openTransferWindow` (around `main.ts:471`), add:

```typescript
  /**
   * The keypad window, created on first request and reused after that.
   *
   * THE TRANSFER WINDOW'S SHAPE EXACTLY -- a child of the terminal so it travels with it, NOT
   * modal so the operator can see the screen behind it, its own preload, `contextIsolation` on.
   * Read `openTransferWindow` below before changing anything here.
   *
   * ## IT IS NON-MODAL BY CONSTRUCTION, WHICH IS THE COMPLAINT BEING ANSWERED
   *
   * The user's objection to the canvas keypad was that it is "modal in an annoying way" -- it
   * toggled, and was awkward to leave up while working. A separate window has no reason to steal
   * the terminal's keyboard, so it can simply be left open. That is structural rather than tuned.
   *
   * ## NO PERSISTENCE, CONFIRMED ON ITS MERITS
   *
   * x3270 remembers through its `keypadOn` resource (`x3270/x3270.c:264`), and we deliberately do
   * not: the user's words are that "making the user reopen the keypad on each new application
   * start, if they need it, is fine". **This is explicitly NOT on the list of things a future
   * preferences store should bring** -- a keypad that reappears unbidden costs window space to an
   * operator who may not want it this session.
   */
  let keypadWin: BrowserWindow | undefined;
  const openKeypadWindow = async (): Promise<void> => {
    if (keypadWin !== undefined && !keypadWin.isDestroyed()) {
      keypadWin.show();
      keypadWin.focus();
      return;
    }
    const kw = new BrowserWindow({
      width: 560,
      height: 460,
      useContentSize: true,
      title: 'Keypad',
      parent: win,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // `.cjs`, compiled from keypadPreload.cts: an ESM preload cannot load.
        preload: join(here, 'keypadPreload.cjs'),
      },
    });
    keypadWin = kw;
    // THE DEPRECATED FIVE-ARGUMENT FORM, matching both other windows rather than
    // electron.d.ts's preferred shape -- see the long note on the transfer window's handler.
    // `level` is a NUMBER here and a STRING in the new form, and the harnesses grep the literal
    // `renderer[3]`. One spelling, one upgrade to do when the level finally moves.
    kw.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      process.stdout.write(`keypad[${level}] ${sourceId}:${line} ${message}\n`);
    });
    // WITHOUT THIS A FAILED LOAD IS A BLANK WINDOW AND NOTHING ELSE. Measured on the transfer
    // window: `ERR_FAILED (-2) loading transfer.html` is the line that explained it.
    kw.webContents.on('did-fail-load', (_e, code, desc, url) => {
      process.stdout.write(`keypad window failed to load ${url}: ${code} ${desc}\n`);
    });
    kw.on('closed', () => { keypadWin = undefined; });
    await kw.loadFile(join(here, '..', 'keypad.html'));
  };
```

**Read the real names before writing this**: `win`, `here` and `join` all exist in that scope
already — `here` is used for `transferPreload.cjs` and `loadFile` for `transfer.html`. Check how
`openTransferWindow` spells its own `loadFile` path and match it.

- [ ] **Step 2: Make `toggleKeypad` open the window**

In `ipcMain.on('action')`, **replace** the existing `toggleKeypad` arm:

```typescript
    /**
     * `Ctrl-K` NOW OPENS A WINDOW instead of toggling a canvas region.
     *
     * STILL INTERCEPTED HERE, because `applyAction` still throws on it -- showing a keypad is a
     * display decision and this is the front end that owns this display. The action's NAME is
     * unchanged, so `canvas/src/keys.ts`, the keypad's own `Ctrl-K` and `keys.mjs` all keep
     * working with no edit.
     *
     * OPEN, NOT TOGGLE, which is the user's decision: the complaint was that the keypad was
     * modal and awkward to leave up. Closing is the window's own close button. A chord that
     * closed it again would re-create the toggle this feature exists to remove.
     *
     * The rejection is CAUGHT, not awaited: `void` on a rejecting promise is what CREATES an
     * unhandled rejection -- measured on the transfer window, where it buried a `keys: TIMED OUT`
     * line that said what actually went wrong.
     */
    if (action.kind === 'toggleKeypad') {
      openKeypadWindow().catch((err: unknown) => {
        process.stdout.write(`keypad window failed to open: ${explain(err)}\n`);
      });
      return;
    }
```

**Delete** `showKeypad` and its uses in the `send` function's `drawList(...)` call. `drawList`'s
last parameter is the keypad flag; Task 9 removes the parameter itself, so for now pass `false`:

```typescript
    const list = drawList(
      snapshot, resolve(snapshot), geometry, scheme, oia === '' ? undefined : oia, false,
    );
```

- [ ] **Step 3: Add the menu item**

In `menu.ts`'s `buildMenuTemplate`, add a View menu before Edit:

```typescript
  // THE KEYPAD'S MENU ROUTE, which is x3270's model: it puts a keyboard icon in the window's own
  // toolbar (`x3270/keypad.bm`, placed by `menubar.c:604`). A menu item is the Electron-native
  // spelling of the same affordance, and it is what makes the keypad discoverable without
  // knowing the chord -- `Ctrl-K` alone is undiscoverable.
  const view: MenuItemTemplate = {
    label: 'View',
    submenu: [
      {
        label: 'Keypad',
        id: 'keypad',
        accelerator: 'Ctrl+K',
        ...(handlers !== undefined ? { click: handlers.onKeypad } : {}),
      },
    ],
  };
```

Add `onKeypad: () => void` to `MenuHandlers`, and include `view` in both returned arrays:

```typescript
  return platform === 'darwin' ? [{ role: 'appMenu' }, edit, view] : [edit, view];
```

**Update `menu.test.ts`:** its *"includes an app menu on macOS"* test asserts
`buildMenuTemplate('linux')[0]!.label === 'Edit'`, which still holds. Add:

```typescript
  it('offers the keypad on a View menu, on every platform', () => {
    // Ctrl+K alone is undiscoverable; the menu is what makes the keypad findable. Asserted on
    // every platform because the accelerator is NOT platform-split -- unlike copy and paste,
    // Ctrl+K collides with nothing in the 3270 keyboard.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const view = buildMenuTemplate(platform).find((m) => m.label === 'View');
      expect(view, `${platform} has no View menu`).toBeDefined();
      const items = view!.submenu as { label: string; accelerator?: string }[];
      expect(items.find((i) => i.label === 'Keypad')?.accelerator).toBe('Ctrl+K');
    }
  });
```

And wire it in `main.ts`'s `Menu.setApplicationMenu` call:

```typescript
      onKeypad: () => {
        openKeypadWindow().catch((err: unknown) => {
          process.stdout.write(`keypad window failed to open: ${explain(err)}\n`);
        });
      },
```

- [ ] **Step 4: Build, typecheck, and check the goldens MOVED**

```bash
npm run build && npm run typecheck
npx tsc --build --force packages/gui packages/web
node packages/gui/scripts/shot.mjs
```

Expected: **`synthetic-ispf` and `synthetic-ispf-green` still match; `synthetic-ispf-keypad`
FAILS.** That failure is correct and expected — the GUI no longer draws a keypad, so a golden
photographing one cannot match. **Do not regenerate it**; Task 9 deletes it. Record the two that
still match, because those two prove this change did not disturb the screen itself.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: Ctrl-K opens a real keypad window, and a View menu makes it discoverable"
```

---

## Task 7: the web overlay

**Files:**
- Create: `packages/web/src/keypadOverlay.ts`
- Create: `packages/web/test/keypadOverlay.test.ts`
- Modify: `packages/web/static/index.html`
- Modify: `packages/web/src/bridgecore.ts`
- Modify: `packages/web/src/httpstatic.ts`

- [ ] **Step 1: Write the failing test for the toggle**

```typescript
import { describe, it, expect } from 'vitest';
import { createKeypadOverlay } from '../src/keypadOverlay.js';

/** A fake element, for the reason `environment: 'node'` always gives: there is no document. */
function fakeEl(): { hidden: boolean } {
  return { hidden: true };
}

describe('createKeypadOverlay', () => {
  it('starts HIDDEN, so every page load begins with no keypad', () => {
    // The user's decision, confirmed on its merits: no persistence, every start closed. Also the
    // gateway's own rule for a reattaching client -- it must not inherit someone else's keypad.
    const el = fakeEl();
    createKeypadOverlay({ element: el as unknown as HTMLElement, build: () => {} });
    expect(el.hidden).toBe(true);
  });

  it('toggle() shows then hides', () => {
    const el = fakeEl();
    const o = createKeypadOverlay({ element: el as unknown as HTMLElement, build: () => {} });
    o.toggle();
    expect(el.hidden).toBe(false);
    o.toggle();
    expect(el.hidden).toBe(true);
  });

  it('BUILDS THE BUTTONS ONCE, not on every toggle', () => {
    // 48 buttons rebuilt per keystroke is work nobody can see, and it would also discard focus.
    let built = 0;
    const el = fakeEl();
    const o = createKeypadOverlay({
      element: el as unknown as HTMLElement, build: () => { built += 1; },
    });
    o.toggle(); o.toggle(); o.toggle();
    expect(built).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/web/test/keypadOverlay.test.ts`
Expected: FAIL — cannot resolve `../src/keypadOverlay.js`.

- [ ] **Step 3: Implement it**

```typescript
/**
 * The web gateway's keypad: an OPAQUE OVERLAY IN THE SAME PANE, not a second window.
 *
 * ## WHY THE WEB DIFFERS FROM THE GUI, DELIBERATELY
 *
 * The GUI opens a real `BrowserWindow` the operator can place beside the terminal. A browser tab
 * cannot do that -- `window.open` for a palette is a popup-blocked second document with its own
 * WebSocket question -- so the pane is what the web has. The user's call, 2026-10-06.
 *
 * OPAQUE AND NOT TRANSLUCENT, with a measured reason behind it: the TUI's overlay once had host
 * text leak through into its chord column, and opacity was the hard-won fix. An overlay that lets
 * the screen show through is a legibility bug waiting to be re-found. The `background: Canvas` in
 * `ui.css` is that rule.
 *
 * ## IT FLOATS OVER THE CANVAS AND NEVER DISPLACES IT
 *
 * `gui/src/main.ts:1234` records that the click path depends on the canvas sitting at the
 * viewport origin -- "give the page a body margin and every click here misses by it". So the
 * overlay is `position: fixed` (see `ui.css`), not a sibling in flow.
 */
export interface OverlayDeps {
  readonly element: HTMLElement;
  /** Fill the overlay with buttons. Called at most once. */
  readonly build: () => void;
}

export interface KeypadOverlay {
  toggle(): void;
}

export function createKeypadOverlay(deps: OverlayDeps): KeypadOverlay {
  let built = false;
  // HIDDEN AT THE START, which is the no-persistence decision: every page load begins closed.
  deps.element.hidden = true;
  return {
    toggle: () => {
      // BUILT LAZILY AND ONCE. Rebuilding 48 buttons per keystroke is invisible work that would
      // also throw away whatever had focus.
      if (!built) { deps.build(); built = true; }
      deps.element.hidden = !deps.element.hidden;
    },
  };
}
```

- [ ] **Step 4: Stop `toggleKeypad` crossing the socket**

In `packages/web/src/bridgecore.ts`'s `sendAction`, beside the existing `quit` intercept:

```typescript
      /**
       * `toggleKeypad` IS NOW CLIENT-SIDE AND MUST NOT REACH THE SERVER.
       *
       * It used to: the keypad was a region in the draw list the SERVER builds, so
       * `web/src/main.ts` flipped a flag and repainted. A DOM overlay is drawn in the browser, so
       * the server has nothing to do with it and a round trip would be a repaint for no reason.
       *
       * THE SERVER'S OWN INTERCEPT STAYS, and removing it would be a bug rather than a cleanup:
       * `applyAction` still THROWS on this kind, `web/src/main.ts` calls it outside any try inside
       * a socket `data` handler, and `integration.test.ts` sends every `Action` kind as a raw
       * frame. A client is not obliged to run served code, so both halves are needed -- exactly
       * the rule `protocol.ts` writes down, and exactly the hole `toggleKeypad` spent a commit in.
       */
      if ((action as { kind?: unknown }).kind === 'toggleKeypad') {
        deps.toggleKeypad?.();
        return;
      }
```

Add `toggleKeypad?: () => void` to `bridgecore`'s deps interface, and pass it from `bridge.ts`.
**Read `bridge.ts` for how it constructs those deps** — this plan cannot know its local names.

- [ ] **Step 5: Wire the page**

In `packages/web/static/index.html`, add the overlay element **after** the canvas and before the
scripts, plus the stylesheet:

```html
<link rel="stylesheet" href="./ui.css">
...
<!--
  AFTER the canvas in document order, and `position: fixed` in `ui.css` -- so it paints over the
  screen without displacing it. The canvas must stay at the viewport origin: the click path's
  `offsetX` arithmetic depends on it.
-->
<div id="keypad-overlay" hidden>
  <button type="button" class="keypad-close" id="keypad-close">Close</button>
  <h1>Keypad</h1>
  <div id="keypad-keys"></div>
</div>
```

- [ ] **Step 6: Serve `ui.css` and the overlay module**

`packages/web/src/httpstatic.ts` serves cross-package files through `assetDir()`. `ui.css` lives in
`packages/gui/`, which is **not** `assetDir()`. **Read the file and follow its existing pattern for
a path outside `canvas`'s dist**; if there is none, copy `ui.css` into `packages/web/static/` as a
build step rather than inventing a second asset root — and say so in a comment.

**`BROWSER_MODULES` must gain the overlay's module** if the browser imports it by bare path. The
exact-count guard in `httpstatic.test.ts` (5 today) and its hardcoded existence loop both move.

- [ ] **Step 7: Build and run the browser harnesses**

```bash
npm run build && npx tsc --build --force packages/gui packages/web
node packages/web/scripts/browser-shot.mjs
node packages/web/scripts/browser-keys.mjs
```

Expected: `browser-shot` — the `synthetic-ispf` case still matches, the `synthetic-ispf-keypad`
case **FAILS** (correct; Task 9 removes it). `browser-keys` 13/11 unchanged.

- [ ] **Step 8: Commit**

```bash
npm run typecheck && npx vitest run packages/web
git commit -am "feat: an opaque in-pane keypad overlay for the web gateway"
```

---

## Task 8: the Xvfb harness, and `clicks.mjs` rewired

**Files:**
- Modify: `packages/gui/src/main.ts` (a seam)
- Modify: `packages/gui/scripts/clicks.mjs`
- Modify: `packages/gui/test/clicks-harness-flags.test.ts`

**This is the only cover for Tasks 5-7's untestable files**, so it has to be real.

- [ ] **Step 1: Add a DOM-click seam to main**

`TN3270_GUI_CLICKS` currently asks the renderer for a canvas point. The keypad is now a DOM in a
different window, so the seam must click **there**:

```typescript
/**
 * Click a keypad button BY LABEL in the keypad window.
 *
 * BY LABEL, STILL, which is the property worth preserving from the canvas version: a coordinate
 * list would be a second copy of the layout and would pass while the layout was wrong. What
 * changes is only HOW the label is found -- `querySelector('[data-label="..."]')` instead of
 * `__tn3270ButtonCenter` plus canvas arithmetic.
 *
 * `executeJavaScript` RATHER THAN `sendInputEvent`: a DOM button's own `click()` runs the same
 * listener a real press does, and there is no geometry to get wrong. The canvas keypad needed real
 * mouse events because the hit test WAS the thing under test; here the browser does the hit
 * testing and `keypadUi.test.ts` covers the wiring.
 */
async function clickKeypadButton(kw: BrowserWindow, label: string): Promise<boolean> {
  const js = `(() => {
    const b = document.querySelector('[data-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
    if (b === null) return false;
    b.click();
    return true;
  })()`;
  return await kw.webContents.executeJavaScript(js) as boolean;
}
```

Then drive it from `maybeSendClicks`, opening the keypad window first. **Read the existing
`maybeSendClicks` and keep its structure**: the `keysMs` settle, the per-label loop, the
`clicks: NO BUTTON <label>` line for a label that is not found, and the `clicks: sent <spec>` line
at the end. `clicks.mjs` bails on all three.

- [ ] **Step 2: Rewire `clicks.mjs`**

Two changes, and **only** two:

1. `SHOW_KEYPAD = 'Ctrl+K'` still opens the keypad — the chord is unchanged, so this constant and
   its `TN3270_GUI_KEYS: SHOW_KEYPAD` wiring stay exactly as they are.
2. **`expected`'s first entry is still `{kind:'toggleKeypad'}`** — main still logs the action
   before intercepting it, so the chord still produces one logged action. **Verify this** by
   running and reading the actual log; if main's new arm logs differently, fix the arm rather than
   the expectation, because `clicks-harness-flags.test.ts` pins "toggleKeypad as the FIRST action".

The `CASES` table does not change. All 9 labels are real DOM buttons now.

- [ ] **Step 3: Update the harness's own guard test**

`clicks-harness-flags.test.ts` has a test pinning `__tn3270ButtonCentre`-era behavior. Read it and
update only what is now false. **Keep** the by-label assertions and the `toggleKeypad`-first one.

- [ ] **Step 4: Run it, and MUTATE to prove it still bites**

```bash
npm run build && npx tsc --build --force packages/gui
node packages/gui/scripts/clicks.mjs
```

Expected: **`9 buttons, 10 actions in order`**, same as before.

Then mutate: in `keypadUi.ts`, swap `Dup`'s and `FldMk`'s actions by reordering the `editing`
block's labels. Rebuild and re-run. Expected: **positions for those two fail with each other's
action**, which is the measurement the canvas version of this harness recorded. **Restore.**

- [ ] **Step 5: Commit**

```bash
git commit -am "test: clicks.mjs clicks real DOM buttons, still by label, mutation-verified"
```

---

## Task 9: delete the canvas keypad

**Files:**
- Delete: `packages/canvas/src/keypad.ts`, `packages/canvas/src/hittest.ts`,
  `packages/canvas/test/keypad.test.ts`,
  `packages/gui/test/golden/synthetic-ispf-keypad.png`, `….sha256`
- Modify: `packages/canvas/src/index.ts`, `drawlist.ts`, `renderer.ts`, `assets.ts`
- Modify: `packages/gui/scripts/shot.mjs`, `packages/web/scripts/browser-shot.mjs`
- Modify: `packages/web/src/main.ts`, `packages/web/test/httpstatic.test.ts`

**LAST, AND DELIBERATELY.** Both replacements work by now, so the four otherwise-unreachable keys
never lose their route — which the spec calls non-negotiable.

- [ ] **Step 1: Delete, and let the compiler find every caller**

```bash
git rm packages/canvas/src/keypad.ts packages/canvas/src/hittest.ts \
       packages/canvas/test/keypad.test.ts \
       packages/gui/test/golden/synthetic-ispf-keypad.png \
       packages/gui/test/golden/synthetic-ispf-keypad.sha256
npm run build 2>&1 | head -40
```

**The build errors ARE the task list.** Work through them: the barrel's four exports, `drawlist.ts`'s
`keypadRegion` import and `showKeypad` parameter, `renderer.ts`'s `hitTestAt` import and its whole
keypad `mousedown` branch, `assets.ts`'s `hittest.js` entry.

**AND ONE FILE THE BUILD WILL NOT NAME, because test files are not typechecked:
`packages/canvas/test/drawlist.test.ts`.** It imports `KEYPAD_ROWS_TALL` from `../src/keypad.js`
(line 9) and has a `describe('the keypad region')` block of **6 tests** (lines 149-212) asserting
the keypad's height contribution. `vitest` strips types rather than checking them, so this will
fail at RUN time with an unresolved import — after the build looks clean. **Delete that describe
block and the import**, and check the three `list.height` assertions outside it: two of them
(lines ~173, ~179) use `KEYPAD_ROWS_TALL` in their expected value and must lose the term, because
`drawList` no longer adds keypad rows.

**That is 6 tests on top of `keypad.test.ts`'s 32, so the deletion removes 38.** Step 6's
arithmetic says so.

- [ ] **Step 2: Simplify `cellAt`'s bound, which the copy/paste work left depending on the keypad**

In `renderer.ts`, `cellAt` reads:

```typescript
  const screenBottom = list.oia?.y ?? list.keypad?.y ?? list.height;
```

With no keypad in the draw list that middle term can never fire. Replace it:

```typescript
  // THE OIA IS STILL EXCLUDED, which is the whole reason this is not just `list.height`: copying
  // the operator status line as if it were host data would be a lie about what is on the screen.
  // The keypad used to be a third term here; it left with the canvas keypad, and a `??
  // list.keypad?.y` that can never fire is a reader trap.
  const screenBottom = list.oia?.y ?? list.height;
```

**`select.mjs` is what proves this did not break the bound.**

- [ ] **Step 3: Drop the keypad from the two golden harnesses**

In `packages/gui/scripts/shot.mjs`, delete the `synthetic-ispf-keypad` case. In
`packages/web/scripts/browser-shot.mjs`, delete `{ golden: 'synthetic-ispf-keypad', keys: 'Ctrl+K' }`.

**`browser-shot.mjs`'s surviving case still proves `renderer.ts` is genuinely shared** — it
compares the browser's pixels against the GUI's own golden. Add a line saying the keypad is no
longer part of that proof, because it no longer renders in either.

- [ ] **Step 4: `web/src/main.ts` — `showKeypad` goes, the INTERCEPT STAYS**

Delete `let showKeypad = false` and its `drawList` argument. **Do NOT delete**
`if (msg.action.kind === 'toggleKeypad') { … return; }` — keep the `return` and drop only the flag
flip and repaint:

```typescript
      /**
       * STILL INTERCEPTED, AND DELETING THIS WOULD REOPEN A PROCESS-ENDING HOLE.
       *
       * The keypad is a client-side overlay now, so there is nothing for the server to toggle --
       * but `applyAction` still THROWS on this kind, and the call below is outside any try inside
       * a socket `data` handler, where a throw ends the GATEWAY and every other operator's
       * session. `bridgecore.ts` intercepts it client-side, but served code is not code a client
       * is obliged to run, and `integration.test.ts` sends every kind as a raw frame.
       *
       * This is `protocol.ts`'s two-branch rule: a kind `applyAction` refuses needs a rejection
       * there or an interception here. `toggleKeypad` spent a commit in the forbidden "neither".
       */
      if (msg.action.kind === 'toggleKeypad') { repaint?.(); return; }
```

- [ ] **Step 5: Fix the two asset guards**

`httpstatic.test.ts` has an exact-count assertion on `BROWSER_MODULES` and a hardcoded existence
loop including `/hittest.js`. Update both, and **say in the comment what the count means now**.

- [ ] **Step 6: Build, typecheck, full suite — and REPORT THE TEST COUNT HONESTLY**

```bash
npm run build && npm run typecheck
npx tsc --build --force packages/gui packages/web
npx vitest run 2>&1 | tail -5
```

**THE COUNT WILL FALL, AND THE COMMIT MUST SAY SO WITH BOTH NUMBERS SEPARATELY.** The deletion
removes **38 tests**: all **32** in `canvas/test/keypad.test.ts` (measured — `keypadRegion`,
`hitTest`, `hitTestAt`) plus the **6** in `drawlist.test.ts`'s keypad-region block. Tasks 1-7 add
their own. A single net figure hides one of the two — the recorded *merge-totals-hide-lost-tests*
trap, where a count matching one side proves nothing because both sides moved. State it as:
"−38 from the deletion, +N from the new tests, net M against the 2312 baseline."

**The 38 are not bad tests.** `hitTestAt`'s pinned the inverse arithmetic at scale 3 with a
non-zero offset, which no Xvfb harness can reach. They go because their subject does — and the
plan says this rather than letting a reader read the drop as breakage.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: delete the canvas keypad, now that neither front end draws one"
```

---

## Task 10: documentation and the full gate

**Files:**
- Modify: `README.md`, `docs/HANDOFF.md`, `docs/ideas/native-widget-dialogs-idea.md`

- [ ] **Step 1: README**

Update *Using the GUI* and *Using the web gateway*: `Ctrl-K` **opens** (not toggles) a keypad —
a window in the GUI, an in-pane overlay in the browser — with tooltips, and **no persistence, every
start closed**. State that the keypad is no longer drawn on the canvas in either front end.

**THREE STALE CLAIMS TO HUNT, because this file has already outlived two of its own summaries:**
- *"The mouse does keypad buttons and TEXT SELECTION, and nothing else"* — the keypad half is now
  a DOM click, not a canvas one. Both occurrences (feature history, *What is not implemented*).
- Any text describing the keypad as drawn through the 3270 atlas, or as growing the window.
- The golden counts, if named anywhere.

- [ ] **Step 2: Retire the idea doc**

`docs/ideas/native-widget-dialogs-idea.md` is now implemented. Add a header saying so, pointing at
the spec and plan, and **correct its central wrong conclusion in place**: it says this is
"divergence, not deletion" because the web stays canvas-drawn. The user decided otherwise on
2026-10-06, and `canvas/src/keypad.ts` ended up with **no** consumers rather than one.

- [ ] **Step 3: HANDOFF**

New START HERE with the measured gate and **the honest test-count arithmetic**. Then **fix the
title date** — the exact trap this project has recorded twice.

- [ ] **Step 4: Run the FULL gate**

```bash
npm run build && npm run typecheck
npx tsc --build --force packages/gui packages/web
npx vitest run
node packages/gui/scripts/shot.mjs            # NOW 2/2
node packages/gui/scripts/keys.mjs
node packages/gui/scripts/clicks.mjs
node packages/gui/scripts/transfer.mjs
node packages/gui/scripts/select.mjs
node packages/web/scripts/browser-shot.mjs    # NOW 1/1
node packages/web/scripts/browser-keys.mjs
python3 packages/tui/scripts/pty-smoke.py
```

Expected: build/typecheck clean; **`2/2` goldens** (was 3/3); `19/17`; `9/10`; `10/10`; `3/3`
selection; **`1/1` browser-shot** (was 2/2); `13/11`; `12 PASS / 0 FAIL`.

**`drive-playback.py` and `drive-e.py` are NOT required** — nothing here touches telnet negotiation
or the stream layer. Say so explicitly rather than letting "the gate was green" cover a subset.

- [ ] **Step 5: A live check is NOT required, and say why**

Nothing here changes what reaches the host: a button raises the same `Action` it always did.
**But the four otherwise-unreachable keys still have no live witness** — Sys Req, Dup, Field Mark
and Newline — and that was already true before this work. Do not claim this feature changed it.

- [ ] **Step 6: Commit and finish**

```bash
git commit -am "docs: the keypad in real controls, with the gate numbers and the test-count arithmetic"
```

Then use `superpowers:finishing-a-development-branch`. The repo's practice: `--no-ff`, confirm
`git merge-base` equals `main` and that the merge reports exactly this branch's commits, and
**re-run the full gate ON THE MERGE COMMIT**.

---

## Self-review notes

**Spec coverage:** the presentation-neutral model and tooltips (T1, T2), the shared stylesheet
(T3), the GUI DOM view (T4) and its window (T5, T6), `Ctrl-K`-opens plus the menu route (T6), the
web overlay and its client-side toggle (T7), the harness rewire keeping by-label (T8), the deletion
with its three named consequences (T9), docs and the gate (T10). The spec's out-of-scope list is
respected: no preferences, no persistence, no icons, no new placements, no `row`/`col` deletion, no
TUI change.

**TWO DEFECTS IN THIS PLAN WERE FOUND BY CHECKING THE SOURCE BEFORE COMMITTING IT**, which is the
habit this repo has paid for repeatedly — the copy/paste plan carried nine into implementation:

1. **`tooltipFor` WOULD HAVE THROWN ON 15 OF THE 48 KEYS.** `Binding.note` is OPTIONAL
   (`bindings.ts:32`), and the first draft checked only `binding === undefined` before reading
   `binding.note.startsWith(...)`. Measured: 15 keypad keys match an entry that has no note — PF1,
   PF3, PA2, PA3, Home, all four arrows, Reset, ErInp, Tab, BkTab, Del, BkSp, i.e. most of the
   cursor cluster. "Found a binding" and "has prose" are different questions. Fixed, and Task 2 now
   has a test for exactly that path; the whole function was then simulated against the real table,
   confirming every assertion in those tests (no empty tooltip, no doubled name, and the seven
   spot-checked values).
2. **TASK 9's DELETION LIST MISSED `canvas/test/drawlist.test.ts`** — 6 more tests, plus two
   `list.height` assertions that add `KEYPAD_ROWS_TALL`. **A build will not name that file**,
   because test files are not typechecked here, so it would have failed at run time after the build
   looked clean. The deletion total is 38, not 32, and the spec was corrected too rather than left
   to disagree with the plan.

**Known soft spots, flagged rather than hidden:**
- **Task 5 Step 4 and Task 7 Step 6 are genuinely uncertain.** Whether `.cts` reaches `dist/` with
  no build-script change, and how `httpstatic.ts` can serve a file from `packages/gui/`, both need
  reading the real files. Each step says what to read and what to do if the guess is wrong.
- **Task 6 and Task 8 cite `main.ts` local names** (`win`, `here`, `explain`, `maybeSendClicks`'s
  internals) that are verified to exist but whose surrounding structure this plan cannot fully
  know. **Read the source; it wins over this plan.**
- **Task 7 Step 4 needs `bridge.ts`'s dep-construction site**, which is not quoted here.
- **The web overlay has no Xvfb cover of its own.** `browser-keys.mjs` proves chords cross the
  socket; nothing yet clicks an overlay button in a browser. **Task 7 Step 7 is therefore weaker
  evidence than Task 8's**, and if the overlay ships broken this is where it would hide. Consider
  a `browser-clicks.mjs` if the risk feels wrong during execution.
- **`tooltipFor`'s `startsWith` join is a heuristic**, not a rule: it dedupes "Enter -- the Enter
  AID" but would not catch "Clear -- the Clear AID, not an interrupt". The test pins only that no
  tooltip is empty and none doubles its own name verbatim.
