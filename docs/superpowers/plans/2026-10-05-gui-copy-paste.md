# GUI Copy and Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Electron GUI rectangular mouse selection with clipboard copy, and clipboard paste that types into the host with x3270's measured semantics.

**Architecture:** The renderer owns the mouse gesture and the selection highlight and sends a **rectangle** (never text — a draw list has no characters); main extracts text from `resolve(snapshot)`, where `text` and `hidden` both live, and writes the OS clipboard. Paste never touches the renderer: main reads the clipboard and drives a pure `pasteString` over `session.keyboard`. The four-function preload bridge is unchanged.

**Tech Stack:** TypeScript (`exactOptionalPropertyTypes` on), Electron 44, vitest, Xvfb-driven by-hand harnesses.

---

## Read this before Task 1 — six measured facts

These cost real time to establish. **Do not re-derive them, and do not trust a plan over the source
if the two disagree** — this project has had plans carry forty-odd defects into implementation, and
the implementers who checked the source are the ones who caught them.

1. **`DrawCell` HAS NO TEXT.** It is `{x, y, glyph, fg, bg, cursor, underline, blink, intensify}`
   (`canvas/src/drawlist.ts:111-121`). `glyph` is a CG-order atlas column, and `:114` has already
   replaced a hidden cell's glyph with a blank. **The renderer therefore cannot extract text** —
   it sends coordinates, main extracts. Reversing CG indices would be a second copy of `cg.ts`.
2. **Main already has the resolved cells.** `main.ts:687` calls `drawList(snapshot, resolve(snapshot), …)`
   every frame, so extraction needs no new plumbing.
3. **`ResolvedCell.text` is STILL THE REAL CHARACTER when `hidden` is set** — deliberately not
   pre-redacted (`core/src/render.ts:105-120`). `hidden` is "the ONLY thing standing between a
   password field and the screen."
4. **`Ctrl-C` is already `{kind:'clear'}`** (`canvas/src/keys.ts:72`) and must stay so.
5. **`Action` is a discriminated union in `frontend/src/keymap.ts:43`**, and `applyAction`
   (`frontend/src/actions.ts:42`) throws on actions a front end must own (`quit`, `toggleKeypad`,
   `transferForm`). A new `copy` action belongs in that throwing group.
6. **`renderer.ts` cannot be imported by vitest at all** — it is a browser entry point that throws at
   module load, and the barrel deliberately does not export it (`canvas/src/index.ts`). Anything in
   that file is covered ONLY by an Xvfb harness. Put logic in importable modules.

**Build discipline:** `vitest` does NOT typecheck, and the GUI/web packages resolve to `dist/`. Run
`npm run build` before believing any suite, and after a `git checkout` run
`npx tsc --build --force packages/gui packages/web` or the staleness guards redden on mtimes alone.

**Create a branch before Task 1:** `git checkout -b gui-copy-paste`. The last five features each ran
on one and merged `--no-ff`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/canvas/src/selection.ts` **(new)** | Pure: normalize a rectangle; extract text from `ResolvedCell[]`. No DOM, no Electron. |
| `packages/canvas/test/selection.test.ts` **(new)** | Unit tests for the above, including the password case. |
| `packages/frontend/src/paste.ts` **(new)** | Pure: x3270 paste semantics over an injected `Keyboard`. |
| `packages/frontend/test/paste.test.ts` **(new)** | Unit tests for every character rule and both aborts. |
| `packages/frontend/src/keymap.ts` | Add `{kind:'copy', …}` to `Action`. |
| `packages/frontend/src/actions.ts` | `applyAction` throws on `copy`, like `transferForm`. |
| `packages/canvas/src/renderer.ts` | Mouse gesture, selection state, highlight, `sendAction`. |
| `packages/gui/src/menu.ts` **(new)** | The application menu and its platform-split accelerators. |
| `packages/gui/test/menu.test.ts` **(new)** | Pin the accelerators and the focus guard by name. |
| `packages/gui/src/main.ts` | Handle the `copy` action; clipboard read/write; install the menu. |
| `packages/gui/scripts/select.mjs` **(new)** | Xvfb harness: real drag → real `copy` action → clipboard. |
| `packages/gui/test/select-harness-flags.test.ts` **(new)** | Pin the harness's argv, as `keys`/`clicks` do. |

---

## Task 1: `selection.ts` — rectangle normalization

**Files:**
- Create: `packages/canvas/src/selection.ts`
- Create: `packages/canvas/test/selection.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeRect, type CellRect } from '../src/selection.js';

describe('normalizeRect', () => {
  it('orders a top-left to bottom-right drag', () => {
    expect(normalizeRect({ row: 2, col: 5 }, { row: 7, col: 20 }))
      .toEqual({ top: 2, left: 5, bottom: 7, right: 20 });
  });

  it('ALL FOUR DRAG DIRECTIONS give the same rectangle', () => {
    // The whole point of normalizing: dragging up-left must select what dragging down-right does.
    const want: CellRect = { top: 2, left: 5, bottom: 7, right: 20 };
    expect(normalizeRect({ row: 7, col: 20 }, { row: 2, col: 5 })).toEqual(want);   // up-left
    expect(normalizeRect({ row: 2, col: 20 }, { row: 7, col: 5 })).toEqual(want);   // down-left
    expect(normalizeRect({ row: 7, col: 5 }, { row: 2, col: 20 })).toEqual(want);   // up-right
  });

  it('a single cell normalizes to a 1x1 rectangle', () => {
    expect(normalizeRect({ row: 3, col: 3 }, { row: 3, col: 3 }))
      .toEqual({ top: 3, left: 3, bottom: 3, right: 3 });
  });
});

describe('isEmptyRect', () => {
  it('calls a 1x1 rectangle EMPTY, so a stray click is not a selection', () => {
    // A click with no drag must not arm a one-character copy.
    expect(isEmptyRect({ top: 3, left: 3, bottom: 3, right: 3 })).toBe(true);
  });

  it('calls a wider or taller rectangle non-empty', () => {
    expect(isEmptyRect({ top: 3, left: 3, bottom: 3, right: 4 })).toBe(false);
    expect(isEmptyRect({ top: 3, left: 3, bottom: 4, right: 3 })).toBe(false);
  });
});
```

Add `isEmptyRect` to the import line of the first block:
`import { normalizeRect, isEmptyRect, type CellRect } from '../src/selection.js';`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/canvas/test/selection.test.ts`
Expected: FAIL — `Failed to resolve import "../src/selection.js"`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * Rectangular selection geometry, pure and renderer-agnostic.
 *
 * ## WHY RECTANGULAR AND NOT LINEAR
 *
 * A 3270 panel is COLUMNAR -- datasets, LRECLs and option lists sit in columns, and the common
 * want is one column of a list without the labels either side of it. Linear selection on a fixed
 * grid also has a question with no good answer: whether to include the trailing spaces at the end
 * of each row. x3270 selects rectangularly by default on a 3270 screen.
 */

/** A cell address in screen coordinates. Row and column are 0-based. */
export interface CellAddr {
  readonly row: number;
  readonly col: number;
}

/** An inclusive rectangle of cells. */
export interface CellRect {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * Two cell addresses into an inclusive rectangle.
 *
 * Normalizing is what makes all four drag directions behave identically: an up-left drag selects
 * exactly what the equivalent down-right drag does.
 */
export function normalizeRect(anchor: CellAddr, focus: CellAddr): CellRect {
  return {
    top: Math.min(anchor.row, focus.row),
    left: Math.min(anchor.col, focus.col),
    bottom: Math.max(anchor.row, focus.row),
    right: Math.max(anchor.col, focus.col),
  };
}

/**
 * Is this rectangle too small to be a selection?
 *
 * A 1x1 rectangle is a CLICK, not a drag, and treating it as a selection would arm a
 * one-character copy on every stray click -- including the clicks that place the cursor.
 */
export function isEmptyRect(rect: CellRect): boolean {
  return rect.top === rect.bottom && rect.left === rect.right;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/canvas/test/selection.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/canvas/src/selection.ts packages/canvas/test/selection.test.ts
git commit -m "feat: rectangular selection geometry, normalized in all four drag directions"
```

---

## Task 2: `selection.ts` — text extraction, and the password rule

**Files:**
- Modify: `packages/canvas/src/selection.ts`
- Modify: `packages/canvas/test/selection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/canvas/test/selection.test.ts`:

```typescript
import { extractText } from '../src/selection.js';
import type { ResolvedCell } from '@tn3270/core';

/** A 4x10 grid of resolved cells from a string per row, padded with spaces. */
function grid(rows: readonly string[], cols = 10): ResolvedCell[] {
  const out: ResolvedCell[] = [];
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      out.push({
        text: row[c] ?? ' ',
        fg: 1, bg: 0, blink: false, reverse: false,
        underscore: false, intensify: false, hidden: false,
      } as ResolvedCell);
    }
  }
  return out;
}

describe('extractText', () => {
  it('takes one line per row, clipped to the columns', () => {
    const cells = grid(['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123']);
    const text = extractText(cells, 10, { top: 0, left: 2, bottom: 1, right: 4 });
    expect(text).toBe('CDE\nMNO');
  });

  it('TRIMS TRAILING WHITESPACE PER LINE, not per block', () => {
    // Per-line trimming is what makes a copied COLUMN paste usefully. Trimming the block as a
    // whole would leave ragged leading spaces on every row but the longest.
    const cells = grid(['AB        ', 'CDEF      ']);
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 1, right: 9 })).toBe('AB\nCDEF');
  });

  it('does NOT add a trailing newline', () => {
    const cells = grid(['AB', 'CD']);
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 1, right: 1 })).toBe('AB\nCD');
  });

  it('keeps INTERIOR spaces, which carry a panel\'s column alignment', () => {
    const cells = grid(['A  B      ']);
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 0, right: 5 })).toBe('A  B');
  });

  it('A HIDDEN CELL CONTRIBUTES A SPACE, NOT ITS CHARACTER', () => {
    /**
     * THE RULE THAT MATTERS MOST IN THIS FILE. `hidden` marks a password field, and core calls it
     * "the ONLY thing standing between a password field and the screen" -- while `text` is STILL
     * THE REAL CHARACTER, deliberately not pre-redacted. So extraction that reads `text` without
     * checking `hidden` puts a password on the clipboard, and a copy feature is exactly how a
     * password escapes. This project has already shipped one diagnostic that printed a live
     * password on its first run.
     */
    const cells = grid(['USERPASSWD']);
    for (let c = 4; c < 10; c++) (cells[c] as { hidden: boolean }).hidden = true;
    expect(extractText(cells, 10, { top: 0, left: 0, bottom: 0, right: 9 })).toBe('USER');
  });

  it('clamps a rectangle that runs off the grid rather than reading undefined', () => {
    const cells = grid(['ABCDEFGHIJ']);
    expect(extractText(cells, 10, { top: 0, left: 8, bottom: 5, right: 40 })).toBe('IJ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/canvas/test/selection.test.ts`
Expected: FAIL — `extractText` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/canvas/src/selection.ts`:

```typescript
import type { ResolvedCell } from '@tn3270/core';

/**
 * Clipboard text for a rectangle, from the RESOLVED cells.
 *
 * ## WHY THIS TAKES `ResolvedCell[]` AND NOT A `DrawList`
 *
 * A draw list has no characters. `DrawCell` is `{x, y, glyph, ...}` and `glyph` is a CG-order atlas
 * column (`drawlist.ts:111-121`), so text cannot be recovered from it -- reversing those indices
 * would be a second, drifting copy of `cg.ts`'s mapping. `ResolvedCell` is where `text` lives, and
 * `main.ts:687` already computes it every frame.
 *
 * ## `hidden` IS HONORED HERE AND THAT IS NOT OPTIONAL
 *
 * `ResolvedCell.text` is still the real character when `hidden` is set -- core leaves redaction to
 * the consumer precisely because only the consumer knows what to substitute. A hidden cell yields a
 * SPACE, the same substitution `drawlist.ts:114` makes when drawing. Omitting this check puts a
 * password on the clipboard.
 *
 * Trailing whitespace is trimmed PER LINE, which is what makes a copied column paste usefully;
 * interior spaces are kept, because they carry a panel's alignment.
 */
export function extractText(
  cells: readonly ResolvedCell[], cols: number, rect: CellRect,
): string {
  const rows = Math.ceil(cells.length / cols);
  // CLAMPED, so a rectangle running off the grid yields short lines rather than reading
  // `undefined` out of the array and stringifying it.
  const top = Math.max(0, rect.top);
  const bottom = Math.min(rows - 1, rect.bottom);
  const left = Math.max(0, rect.left);
  const right = Math.min(cols - 1, rect.right);

  const lines: string[] = [];
  for (let row = top; row <= bottom; row++) {
    let line = '';
    for (let col = left; col <= right; col++) {
      const cell = cells[row * cols + col];
      if (cell === undefined) continue;
      line += cell.hidden ? ' ' : cell.text;
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run packages/canvas/test/selection.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: MUTATION-VERIFY the password rule**

Change `line += cell.hidden ? ' ' : cell.text;` to `line += cell.text;`, rebuild, and run the file.

Expected: exactly one failure — *"A HIDDEN CELL CONTRIBUTES A SPACE"*, reporting `USERPASSWD`.
**Restore the line and re-run to confirm green.** A test that cannot fail does not protect anything,
and this is the one test in the feature whose failure mode is a leaked credential.

- [ ] **Step 6: Export from the barrel**

In `packages/canvas/src/index.ts`, beside the existing `hitTest` export:

```typescript
export { normalizeRect, isEmptyRect, extractText } from './selection.js';
export type { CellAddr, CellRect } from './selection.js';
```

- [ ] **Step 7: Commit**

```bash
npm run build && npx vitest run packages/canvas
git add packages/canvas/src/selection.ts packages/canvas/src/index.ts packages/canvas/test/selection.test.ts
git commit -m "feat: extract clipboard text from resolved cells, honoring hidden fields

Mutation-verified: dropping the hidden check reddens exactly the password test."
```

---

## Task 3: the `copy` action

**Files:**
- Modify: `packages/frontend/src/keymap.ts:43-103` (the `Action` union)
- Modify: `packages/frontend/src/actions.ts:42-60` (`applyAction`)
- Modify: `packages/frontend/test/actions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/frontend/test/actions.test.ts`:

```typescript
it('THROWS on copy, because the clipboard is the front end\'s business', () => {
  // The fourth action of this shape, after quit, toggleKeypad and transferForm. A front end that
  // forgot to intercept `copy` must fail LOUDLY rather than silently doing nothing -- which is
  // exactly what the other three document, and the property that throw exists to give.
  const session = makeSession();
  expect(() => applyAction(session, { kind: 'copy', rect: { top: 0, left: 0, bottom: 1, right: 1 } }))
    .toThrow(/copy/);
});
```

(Use whatever `makeSession` helper that file already defines; do not invent a new one.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/frontend/test/actions.test.ts`
Expected: FAIL — a TypeScript error on the unknown `copy` member, or no throw.

- [ ] **Step 3: Add the union member**

In `packages/frontend/src/keymap.ts`, immediately before `| { kind: 'type'; text: string }`:

```typescript
  // THE RECTANGLE, NOT THE TEXT, and that is forced rather than chosen: the renderer only ever
  // receives a `DrawList`, whose `DrawCell` carries a CG-order atlas glyph and NO character
  // (`canvas/src/drawlist.ts:111-121`). So the front end that holds the `Session` extracts the
  // text from `resolve(snapshot)`, where `text` and `hidden` both live. Sending coordinates is
  // also the discipline `keypadButtonCenter` already documents -- it keeps the seam honest.
  //
  // `applyAction` THROWS on this, like `quit`, `toggleKeypad` and `transferForm`: what a clipboard
  // is belongs to the front end, and the GUI has an OS clipboard where the gateway has the
  // operator's browser.
  // SPELLED INLINE AND NOT IMPORTED AS `CellRect`, WHICH IS NOT AN OVERSIGHT: `CellRect` lives in
  // `@tn3270/canvas`, and the graph is `core <- frontend <- { cli, tui, canvas, gui, web }` --
  // `frontend` importing from `canvas` would INVERT it and create a cycle. The four fields are
  // structurally identical, so `extractText(cells, cols, action.rect)` typechecks without a cast.
  // Do not "tidy" this into an import.
  | { kind: 'copy'; rect: { top: number; left: number; bottom: number; right: number } }
```

- [ ] **Step 4: Make `applyAction` throw**

In `packages/frontend/src/actions.ts`, after the `transferForm` guard and OUTSIDE the `try`:

```typescript
  // THE FOURTH OF THE SAME SHAPE, and outside the `try` for the reason the three above give: the
  // catch-all would swallow the throw and hand back the silent no-op it exists to prevent.
  if (action.kind === 'copy') {
    throw new Error('applyAction does not handle copy: the front end owns its own clipboard');
  }
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm run build && npm run typecheck && npx vitest run packages/frontend`
Expected: build and typecheck clean; all frontend tests pass.

**If `applyAction`'s switch now fails exhaustiveness**, that is the type system doing its job —
the throw above must come before the switch, not inside it.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/keymap.ts packages/frontend/src/actions.ts packages/frontend/test/actions.test.ts
git commit -m "feat: a copy action carrying a rectangle, which applyAction refuses"
```

---

## Task 4: `paste.ts` — the character rules

**Files:**
- Create: `packages/frontend/src/paste.ts`
- Create: `packages/frontend/test/paste.test.ts`

**Reference, measured from `~/src/suite3270-4.5/Common/kybd.c`. Verify each line yourself; four
citations in the first draft of the spec were off by a few lines.**

| Input | Action | Line |
|---|---|---|
| `\n` | `Newline_action` — next unprotected field | `:3928` |
| `\n` when `just_wrapped` | **suppressed** | `:3929` |
| `\b` | `Left_action` | `:3914` |
| `\f` | types a **space** | `:3918` |
| `\t` | field tab | |
| printable | per-character type | |

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { pasteString } from '../src/paste.js';
import { Screen, Keyboard, Oia, KeyboardState, resolve } from '@tn3270/core';

/**
 * A 24x80 screen with one big unprotected field, which is what a command prompt looks like.
 * `pasteString` takes the keyboard injected, so no Session and no Electron is involved.
 */
function keyboardAt(cursor = 0): { k: Keyboard; s: Screen } {
  const s = new Screen({ rows: 24, cols: 80 });
  s.setFieldAttribute(0, 0x00);
  s.cursor = cursor === 0 ? 1 : cursor;
  const k = new Keyboard(s, new Oia());
  return { k, s };
}

/**
 * One row of the screen as text, for asserting what landed.
 *
 * VIA `resolve()`, WHICH IS THE ESTABLISHED PATTERN IN THIS REPO
 * (`tui/test/transferRun.test.ts:93-95` does exactly this). The first draft of this plan decoded
 * `snapshot().cells[].ebcdic` by hand with `String.fromCharCode`, which returns EBCDIC CODE POINTS
 * -- so every assertion against an ASCII literal would have failed while looking like a paste bug.
 * `ResolvedCell.text` is already the character, and it is also what `extractText` reads.
 */
function rowText(s: Screen, row: number): string {
  const snap = s.snapshot();
  const cells = resolve(snap, {});
  return cells.slice(row * snap.cols, (row + 1) * snap.cols).map((c) => c.text).join('');
}

describe('pasteString: printable text', () => {
  it('types the characters and reports them all consumed', () => {
    const { k, s } = keyboardAt();
    const r = pasteString(k, s, 'HELLO');
    expect(r).toEqual({ typed: 5, dropped: 0, reason: undefined });
  });
});

describe('pasteString: the control characters, from kybd.c', () => {
  it('\\f TYPES A SPACE, where outside pasting it would be CLEAR', () => {
    /**
     * THE RULE THAT WOULD HAVE BITTEN. Outside pasting `\f` is Clear -- an AID that WIPES THE
     * SCREEN (`kybd.c:3920`). A form feed in pasted text sending Clear mid-paste would destroy
     * the panel being filled. Pasting changes its meaning (`:3918`), and that asymmetry is
     * explicit in the source.
     */
    const { k, s } = keyboardAt();
    pasteString(k, s, 'A\fB');
    expect(rowText(s, 0).slice(1, 4)).toBe('A B');
  });

  it('\\b moves the cursor LEFT', () => {
    const { k, s } = keyboardAt();
    const before = s.cursor;
    pasteString(k, s, 'AB\b');
    expect(s.cursor).toBe(before + 1);
  });

  it('NEVER synthesizes Enter: \\n is Newline, not an AID', () => {
    /**
     * The reference makes exactly this distinction -- `\n` becomes `Enter_action` ONLY WHEN NOT
     * PASTING (`kybd.c:3957`). Conflating them would submit a half-filled panel to a live host.
     * Asserted as an ABSENCE through a spy, because "no AID was sent" is the property.
     */
    const { k, s } = keyboardAt();
    const aids: number[] = [];
    pasteString(k, s, 'A\nB', { onAid: (a) => aids.push(a) });
    expect(aids).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/frontend/test/paste.test.ts`
Expected: FAIL — cannot resolve `../src/paste.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { Keyboard, Screen } from '@tn3270/core';

/** What a paste did. `reason` is present only when the paste stopped early. */
export interface PasteResult {
  readonly typed: number;
  readonly dropped: number;
  readonly reason?: 'keyboard locked' | 'wrapped past the start';
}

export interface PasteOptions {
  /** Observability hook for tests; production passes nothing. */
  readonly onAid?: (aid: number) => void;
}

/**
 * Paste text into the screen, with x3270's measured semantics.
 *
 * ## IT LIVES IN `frontend` BECAUSE EVERY FRONT END WANTS THE SAME RULES
 *
 * The graph is `core <- frontend <- { cli, tui, canvas, gui, web }`, so `frontend` is the one place
 * all four front ends can consume. Keeping these rules here is what stops them being written twice,
 * and the keyboard is INJECTED so this is testable with no Electron and no Session.
 *
 * ## THE RULES ARE MEASURED FROM `Common/kybd.c`, NOT RECALLED
 *
 * `\n` -> Newline, i.e. the next unprotected field (`:3928`), SUPPRESSED when the cursor already
 * wrapped (`:3929`); `\b` -> Left (`:3914`); `\f` -> a SPACE (`:3918`), where outside pasting it is
 * Clear, an AID that wipes the screen (`:3920`). This is the `auto_skip` default path;
 * OVERLAY-PASTE MODE IS NOT IMPLEMENTED, and not asking for it is what keeps that branch
 * unreachable -- the same reasoning that kept BIND-IMAGE unrequested in stage 2b.
 *
 * ## NO ENTER IS EVER SYNTHESIZED
 *
 * `\n` becomes `Enter_action` in the reference ONLY WHEN NOT PASTING (`:3957`). Enter submits the
 * screen; quietly submitting a half-filled panel to a live host is not a trade this makes.
 */
export function pasteString(
  keyboard: Keyboard, screen: Screen, text: string, opts: PasteOptions = {},
): PasteResult {
  const cols = screen.cols;
  const startAddr = screen.cursor;
  let lastAddr = screen.cursor;
  let lastRow = Math.floor(screen.cursor / cols);
  let justWrapped = false;
  let typed = 0;

  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    // THE KEYBOARD LOCK IS FATAL TO THE REMAINDER, matching the reference: "it isn't possible to
    // unlock the keyboard from a string, so if the keyboard is locked, it's fatal"
    // (`kybd.c:3874-3880`). We report how many got in rather than dropping it silently.
    if (keyboard.oia.isInhibited()) {
      return { typed, dropped: chars.length - i, reason: 'keyboard locked' };
    }
    // A CURSOR THAT WRAPPED PAST WHERE IT STARTED ABORTS (`kybd.c:3886`), or a long paste
    // circles the screen and overwrites what it already typed.
    if (screen.cursor < startAddr && i > 0) {
      return { typed, dropped: chars.length - i, reason: 'wrapped past the start' };
    }

    // ROW TRACKING FOR `justWrapped` (`kybd.c:3898-3906`): if the cursor moved to a different row
    // on its own -- because filling a field wrapped it -- the wrap has already done a newline's
    // job, and the next `\n` must be swallowed.
    if (lastAddr !== screen.cursor) {
      lastAddr = screen.cursor;
      const row = Math.floor(screen.cursor / cols);
      justWrapped = row !== lastRow;
      lastRow = row;
    }

    const ch = chars[i]!;
    switch (ch) {
      case '\n':
        // SUPPRESSED AFTER A WRAP. Without this every line after the first FULL one lands ONE
        // FIELD LATE, which presents as a core keyboard fault rather than a paste bug.
        if (!justWrapped) keyboard.newline();
        lastRow = Math.floor(screen.cursor / cols);
        justWrapped = false;
        break;
      case '\b':
        keyboard.left();
        break;
      case '\f':
        if (!keyboard.type(' ')) return { typed, dropped: chars.length - i };
        typed += 1;
        break;
      case '\t':
        keyboard.tab();
        break;
      case '\r':
        // DROPPED, not typed and not Enter: CRLF text would otherwise put a stray character in
        // every field. The `\n` that follows carries the meaning.
        break;
      default:
        if (!keyboard.type(ch)) return { typed, dropped: chars.length - i };
        typed += 1;
        break;
    }
  }
  return { typed, dropped: 0 };
}
```

Note `opts.onAid` is accepted and deliberately unused in the body — **nothing here sends an AID**,
which is the property the test asserts. Keep the parameter so the assertion is meaningful.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run packages/frontend/test/paste.test.ts`
Expected: PASS, 5 tests.

**If `keyboard.oia` is not public**, read `core/src/keyboard.ts` and use whatever the class actually
exposes; take the source over this plan.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: pasteString with x3270's measured control-character rules"
```

---

## Task 5: `paste.ts` — `just_wrapped` and both abort conditions

**Files:**
- Modify: `packages/frontend/test/paste.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('pasteString: just_wrapped, the detail that makes multi-line paste land right', () => {
  it('SUPPRESSES a newline when filling a field already wrapped the cursor', () => {
    /**
     * THE TEST THAT NEEDS A FIELD THAT FILLS. Every single-line test passes without the
     * `justWrapped` logic; only a paste whose first line EXACTLY FILLS its field can see it. The
     * reference tracks the cursor's row and swallows the following `\n` (`kybd.c:3929`), because
     * the wrap already did the newline's job. Without it, line two lands ONE FIELD LATE.
     *
     * Two adjacent 5-cell unprotected fields on row 0, so typing 5 characters wraps into the
     * second one by itself.
     */
    const s = new Screen({ rows: 24, cols: 80 });
    s.setFieldAttribute(0, 0x00);
    s.setFieldAttribute(6, 0x00);
    s.cursor = 1;
    const k = new Keyboard(s, new Oia());

    pasteString(k, s, 'ABCDE\nXY');
    // XY must be in the SECOND field, not the third: the newline was redundant and suppressed.
    expect(rowText(s, 0).slice(7, 9)).toBe('XY');
  });
});

describe('pasteString: the two abort conditions', () => {
  it('DROPS THE REMAINDER when the keyboard is locked, and says how much', () => {
    // The reference calls this fatal: a string cannot unlock a keyboard (`kybd.c:3874-3880`).
    // Reported rather than silent, because a half-applied paste the operator cannot see is worse
    // than a refusal they can.
    const { k, s } = keyboardAt();
    // VERIFIED SIGNATURES: `Keyboard` exposes `readonly oia: Oia` (`core/src/keyboard.ts:19`), and
    // `Oia.inhibit` TAKES A `KeyboardState` (`core/src/oia.ts:85`) -- a bare `inhibit()` does not
    // compile. `SystemWait` is the state a host-busy screen is in.
    k.oia.inhibit(KeyboardState.SystemWait);
    const r = pasteString(k, s, 'HELLO');
    expect(r.typed).toBe(0);
    expect(r.dropped).toBe(5);
    expect(r.reason).toBe('keyboard locked');
  });

  it('reports a SHORT paste when a field refuses mid-string', () => {
    // A numeric field refusing a letter, or a field filling up, stops the paste. What got in is
    // reported -- compare bytes, not the status line, is this project's standing rule.
    const s = new Screen({ rows: 24, cols: 80 });
    s.setFieldAttribute(0, 0x20);         // PROTECTED: nothing can be typed
    s.cursor = 1;
    const k = new Keyboard(s, new Oia());
    const r = pasteString(k, s, 'HELLO');
    expect(r.typed).toBeLessThan(5);
    expect(r.dropped).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify they fail or reveal API mismatches**

Run: `npx vitest run packages/frontend/test/paste.test.ts`

The `justWrapped` test is expected to FAIL if the logic is wrong. The lock test may fail on the
`Oia` API — **read `core/src/oia.ts` and use its real method** (`enterInhibit`, `inhibit(...)` or
similar); the source wins over this plan.

- [ ] **Step 3: Fix the implementation if the suppression test failed**

The row tracking must run BEFORE the switch, and `lastRow` must be re-read after a `newline()`.
If the test fails, trace with a temporary `console.log` of `screen.cursor` per character — do not
guess at the arithmetic.

- [ ] **Step 4: MUTATION-VERIFY the suppression**

Change `if (!justWrapped) keyboard.newline();` to `keyboard.newline();`, rebuild, run.
Expected: the suppression test fails and the others stay green. **Restore and re-run.**

- [ ] **Step 5: Commit**

```bash
npm run build && npx vitest run packages/frontend
git commit -am "test: pin just_wrapped and both paste aborts, mutation-verified"
```

---

## Task 6: the menu, with platform-split accelerators

**Files:**
- Create: `packages/gui/src/menu.ts`
- Create: `packages/gui/test/menu.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { buildMenuTemplate } from '../src/menu.js';

describe('the Edit menu accelerators are PLATFORM-SPLIT', () => {
  it('uses Cmd-C / Cmd-V on macOS, where Cmd is free', () => {
    const t = buildMenuTemplate('darwin');
    const edit = t.find((m) => m.label === 'Edit')!;
    const items = edit.submenu as { label: string; accelerator?: string }[];
    expect(items.find((i) => i.label === 'Copy')?.accelerator).toBe('Cmd+C');
    expect(items.find((i) => i.label === 'Paste')?.accelerator).toBe('Cmd+V');
  });

  it('uses Ctrl-Shift-C / Ctrl-Shift-V elsewhere, BECAUSE Ctrl-C IS CLEAR', () => {
    /**
     * `canvas/src/keys.ts:72` binds `c` to `{kind:'clear'}`, and its docstring explains why:
     * Clear is an AID a user needs constantly to dismiss VM's `MORE...` state, "so the usual
     * instinct for escaping cannot be the way out". Ctrl-Shift-C is what terminal users already
     * expect for exactly this conflict (gnome-terminal, VS Code's terminal).
     */
    const t = buildMenuTemplate('linux');
    const edit = t.find((m) => m.label === 'Edit')!;
    const items = edit.submenu as { label: string; accelerator?: string }[];
    expect(items.find((i) => i.label === 'Copy')?.accelerator).toBe('Ctrl+Shift+C');
    expect(items.find((i) => i.label === 'Paste')?.accelerator).toBe('Ctrl+Shift+V');
  });

  it('NEVER binds a bare Ctrl-C or Cmd-C-to-Clear anywhere in the template', () => {
    // A regression guard with teeth: binding Ctrl+C here would steal Clear from the 3270 keyboard
    // and the theft would be invisible until someone met a MORE... screen.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const flat = JSON.stringify(buildMenuTemplate(platform));
      expect(flat).not.toContain('"Ctrl+C"');
    }
  });

  it('includes an app menu on macOS, which the platform requires', () => {
    // Without one, a Mac window gets no menu bar at all -- not a cosmetic difference.
    expect(buildMenuTemplate('darwin')[0]!.role).toBe('appMenu');
    expect(buildMenuTemplate('linux')[0]!.label).toBe('Edit');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/gui/test/menu.test.ts`
Expected: FAIL — cannot resolve `../src/menu.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * The application menu. THE FIRST ONE THIS APP HAS HAD -- `setApplicationMenu` was never called
 * before copy/paste needed somewhere to live.
 *
 * ## DELIBERATELY NOT THE FINAL MENU STRUCTURE
 *
 * Edit only. The keypad window's toolbar icon and a connect dialog are both roadmapped and will
 * want menus too; guessing their shape now would be a second copy of a decision nobody has taken.
 *
 * ## THE TEMPLATE IS A PURE FUNCTION OF THE PLATFORM, WHICH IS WHY IT IS TESTABLE
 *
 * `process.platform` is read by the CALLER and passed in. A module that read it directly could only
 * be tested on the machine it runs on, and the whole point of the split below is that both halves
 * are asserted on every machine.
 */

/** The platform strings this file distinguishes. `process.platform`'s type. */
export type Platform = 'darwin' | 'linux' | 'win32' | string;

export interface MenuItemTemplate {
  readonly label?: string;
  readonly role?: string;
  readonly accelerator?: string;
  readonly id?: string;
  readonly click?: () => void;
  readonly submenu?: readonly MenuItemTemplate[];
}

/**
 * Copy and paste accelerators.
 *
 * ## `Ctrl-C` STAYS CLEAR ON EVERY PLATFORM
 *
 * `canvas/src/keys.ts:72` binds it to `{kind:'clear'}` and the window says so at startup. Clear is
 * an AID needed constantly to dismiss VM's `MORE...` state. On macOS `Cmd` is free, so the native
 * key is available with no conflict; elsewhere `Ctrl-Shift-C` is the terminal-emulator convention,
 * adopted by gnome-terminal and VS Code's terminal for this very collision.
 *
 * REJECTED, and recorded so it is not revisited: "Ctrl-C copies when a selection exists, Clear when
 * it does not." That makes a DESTRUCTIVE AID conditional on invisible state -- the
 * one-path-does-X-and-another-doesn't shape this project has been bitten by at least five times --
 * and its failure mode is a missed Clear on a locked `MORE...` screen.
 */
export function copyAccelerator(platform: Platform): string {
  return platform === 'darwin' ? 'Cmd+C' : 'Ctrl+Shift+C';
}

export function pasteAccelerator(platform: Platform): string {
  return platform === 'darwin' ? 'Cmd+V' : 'Ctrl+Shift+V';
}

export interface MenuHandlers {
  readonly onCopy: () => void;
  readonly onPaste: () => void;
}

/** The menu template for a platform. Handlers are optional so tests can inspect the shape. */
export function buildMenuTemplate(
  platform: Platform, handlers?: MenuHandlers,
): readonly MenuItemTemplate[] {
  const edit: MenuItemTemplate = {
    label: 'Edit',
    submenu: [
      {
        label: 'Copy',
        id: 'copy',
        accelerator: copyAccelerator(platform),
        ...(handlers !== undefined ? { click: handlers.onCopy } : {}),
      },
      {
        label: 'Paste',
        id: 'paste',
        accelerator: pasteAccelerator(platform),
        ...(handlers !== undefined ? { click: handlers.onPaste } : {}),
      },
    ],
  };
  // AN APP MENU IS MANDATORY ON macOS: without one the window gets NO menu bar at all, which is a
  // behavioral difference rather than a cosmetic one.
  return platform === 'darwin' ? [{ role: 'appMenu' }, edit] : [edit];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run packages/gui/test/menu.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gui/src/menu.ts packages/gui/test/menu.test.ts
git commit -m "feat: an Edit menu whose accelerators dodge Ctrl-C, which is Clear"
```

---

## Task 7: the renderer's selection gesture

**Files:**
- Modify: `packages/canvas/src/renderer.ts` (near the existing `mousedown` at `:279-300`)

**No vitest coverage is possible here** — `renderer.ts` throws at module load outside a browser and
the barrel does not export it. Task 9's harness is its only cover. Keep the logic in this file as
thin as possible and lean on Task 1-2's pure functions.

- [ ] **Step 1: Add selection state and the cell-from-pixel helper**

Add near the top of the module, beside the existing press state:

```typescript
/**
 * The selection, in CELL coordinates, or `null` for none.
 *
 * RENDERER-LOCAL AND DELIBERATELY NOT IN THE `DrawList`: the draw list comes from main, and
 * selection is a display concern the renderer owns. Main learns about it only when a copy is asked
 * for, and then only as a rectangle. (Contrast the KEYPAD, which IS in the draw list -- because
 * `main.ts` sizes the window from `list.height` and a renderer-owned keypad would be clipped.)
 */
let anchor: CellAddr | null = null;
let focus: CellAddr | null = null;
let dragging = false;
```

And the pixel→cell helper, next to the keypad's own arithmetic:

```typescript
/**
 * A mouse position in the canvas's own space to a screen cell.
 *
 * `offsetX`/`offsetY` for the reason `mousedown` already documents: they and the draw list's `at`
 * are measured from the SAME origin, the canvas's box, so the expression has no scroll term to get
 * wrong. Divided by `scale` because the draw list is in scale-1 pixels.
 */
function cellAt(offsetX: number, offsetY: number, list: DrawList): CellAddr | null {
  const g = atlasGeometry;                       // whatever the module already calls it
  if (g === undefined) return null;
  const col = Math.floor((offsetX / scale) / g.cellWidth);
  const row = Math.floor((offsetY / scale) / g.cellHeight);
  const rows = Math.floor(list.height / g.cellHeight);
  if (row < 0 || col < 0 || col >= g.cols || row >= rows) return null;
  return { row, col };
}
```

**Read the file and use its real names** for the scale, the atlas geometry and the current draw
list. This plan cannot know them; the source does.

- [ ] **Step 2: Extend the mouse listeners**

In the existing `mousedown` handler, AFTER the primary-button guard (`:284`) and AFTER the keypad
hit-test has declined:

```typescript
  // A SELECTION DRAG STARTS. The keypad gets first refusal above, so a press on a button is a
  // button press and not the start of a selection -- which is also why this cannot be a separate
  // listener: two listeners would both act on one press.
  const cell = cellAt(e.offsetX, e.offsetY, list);
  if (cell !== null) {
    anchor = cell;
    focus = cell;
    dragging = true;
    paint(list);
  }
```

Add a `mousemove` listener on the window:

```typescript
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const cell = cellAt(e.offsetX, e.offsetY, list);
  if (cell === null) return;
  focus = cell;
  paint(list);
});
```

And extend the existing window `mouseup` (which already exists for the keypad's `release()`):

```typescript
  // THE DRAG ENDS BUT THE SELECTION SURVIVES: the operator presses Copy after releasing the mouse,
  // so clearing here would make every copy impossible.
  dragging = false;
```

- [ ] **Step 3: Clear the selection on the three events the spec names**

In the `keydown` listener, after an action is claimed:

```typescript
  // ANY KEYSTROKE THAT DOES SOMETHING INVALIDATES THE SELECTION, because the screen is about to
  // change under it and a highlight over changed text would copy something never seen.
  anchor = null; focus = null;
```

In `onFrame`:

```typescript
  // A HOST REPAINT INVALIDATES WHAT THE COORDINATES MEANT. Keeping the highlight across a frame
  // would offer the operator a copy of text that is no longer there.
  anchor = null; focus = null;
```

- [ ] **Step 4: Draw the highlight in `paint`**

After the screen cells are blitted and before the OIA:

```typescript
  // INVERSE VIDEO over the selected cells, which is what the keypad already draws through this
  // same atlas -- no new primitive. Drawn as a translucent overlay rather than by re-blitting the
  // glyphs, so a selection cannot change what character is on screen.
  if (anchor !== null && focus !== null) {
    const rect = normalizeRect(anchor, focus);
    if (!isEmptyRect(rect)) {
      ctx.save();
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(
        rect.left * g.cellWidth * scale,
        rect.top * g.cellHeight * scale,
        (rect.right - rect.left + 1) * g.cellWidth * scale,
        (rect.bottom - rect.top + 1) * g.cellHeight * scale,
      );
      ctx.restore();
    }
  }
```

**`difference` composition inverts whatever is under it**, which is what makes this work for any
color scheme without a per-scheme inverse table. If the goldens move because of this, that is a
REAL failure to investigate, not a golden to update: `shot.mjs`'s three cases have no selection, so
this block must not execute in them.

- [ ] **Step 5: Add a copy trigger the renderer can reach**

```typescript
/**
 * Copy the current selection, or do nothing.
 *
 * A `window` GLOBAL, NOT A FIFTH BRIDGE FUNCTION -- `bridgecore.ts` records that a fifth function
 * means the renderer has stopped being shared between Electron and the browser, and both hosts get
 * a global for free because both load this file. Same mechanism as `__tn3270ButtonCenter`.
 */
(window as unknown as { __tn3270Copy: () => boolean }).__tn3270Copy = (): boolean => {
  if (anchor === null || focus === null) return false;
  const rect = normalizeRect(anchor, focus);
  if (isEmptyRect(rect)) return false;
  window.tn3270.sendAction({ kind: 'copy', rect });
  return true;
};
```

- [ ] **Step 6: Build, typecheck, and confirm the goldens have NOT moved**

```bash
npm run build && npm run typecheck
npx tsc --build --force packages/gui packages/web
node packages/gui/scripts/shot.mjs
```

Expected: build and typecheck clean; **`3/3 goldens matched`**. A moved golden here means the
highlight is drawing when nothing is selected.

- [ ] **Step 7: Commit**

```bash
git commit -am "feat: rectangular selection gesture and inverse-video highlight in the renderer"
```

---

## Task 8: main — extract, write the clipboard, and paste

**Files:**
- Modify: `packages/gui/src/main.ts` (the `ipcMain.on('action')` handler at `:755`, and app setup)

- [ ] **Step 1: Handle the `copy` action**

In `ipcMain.on('action', ...)`, beside the existing `toggleKeypad` and `transferForm` intercepts:

```typescript
    // INTERCEPTED HERE for the same reason as `quit`, `toggleKeypad` and `transferForm`:
    // `applyAction` THROWS on it, because what a clipboard is belongs to the front end. This one
    // has an OS clipboard; the gateway has the operator's browser.
    if (action.kind === 'copy') {
      // THE EXTRACTION HAPPENS HERE AND NOT IN THE RENDERER, and that is forced: a `DrawCell`
      // carries a CG-order atlas glyph and no character (`drawlist.ts:111-121`). This side has
      // `resolve(snapshot)`, which is where `text` and `hidden` both live.
      const snapshot = session.screen.snapshot();
      const text = extractText(resolve(snapshot), snapshot.cols, action.rect);
      if (text !== '') clipboard.writeText(text);
      process.stdout.write(`copy: ${text.length} chars\n`);
      return;
    }
```

**`copy: N chars` and NOT the text itself.** The action log is gated behind replay mode precisely
because a `type` action carries typed text; a copy can carry a password, and this line runs in
every mode including against a live host.

- [ ] **Step 2: Write the failing harness-visible behavior check**

There is no unit test for this — it needs Electron's real `clipboard`. Task 9 covers it. Proceed.

- [ ] **Step 3: Install the menu with its handlers**

In `app.whenReady()`, after the window exists:

```typescript
  // THE MENU, AND ITS ITEMS ARE INERT WHILE THE TRANSFER WINDOW HAS FOCUS.
  //
  // AN ACCELERATOR REGISTERED HERE FIRES REGARDLESS OF WHICH WINDOW IS FOCUSED, so with the
  // transfer window open a `Cmd-V` would paste into the SESSION BEHIND IT. That window's fields are
  // HTML inputs and get Chromium's native clipboard behavior for free, so the right answer is to
  // decline rather than to forward. Same family as the recorded
  // closing-a-parent-skips-the-child-close finding: two windows, one global mechanism.
  const transferHasFocus = (): boolean => {
    const tw = transferWin;
    return tw !== undefined && !tw.isDestroyed() && tw.isFocused();
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(
    buildMenuTemplate(process.platform, {
      onCopy: () => {
        if (transferHasFocus()) return;
        void win.webContents.executeJavaScript('window.__tn3270Copy && window.__tn3270Copy()');
      },
      onPaste: () => {
        if (transferHasFocus()) return;
        const text = clipboard.readText();
        if (text === '') return;
        const r = pasteString(session.keyboard, session.screen, text);
        // REPORTED TO THE OPERATOR, REMEDY FIRST, because the status line truncates and this
        // project has already had a message put its only actionable phrase past the cut.
        if (r.reason !== undefined) {
          win.webContents.send('error-message',
            `paste stopped: ${r.reason} after ${r.typed} of ${r.typed + r.dropped} characters`);
        } else if (r.dropped > 0) {
          win.webContents.send('error-message',
            `paste short: ${r.typed} of ${r.typed + r.dropped} characters (field full or protected)`);
        }
        send();                            // repaint, whatever the outcome
      },
    }),
  ) as Electron.Menu);
```

Add the imports: `Menu`, `clipboard` from `electron`; `resolve` from `@tn3270/core` (already
imported); `extractText` from `@tn3270/canvas`; `pasteString` from `@tn3270/frontend`;
`buildMenuTemplate` from `./menu.js`.

**Use the file's real names** for `transferWin`, `win`, `session` and `send` — read them, do not
assume. If `buildMenuTemplate`'s return type does not satisfy Electron's
`MenuItemConstructorOptions[]`, widen `MenuItemTemplate` rather than casting away the error, and do
not add `@ts-expect-error`.

- [ ] **Step 4: Build, typecheck, run everything offline**

```bash
npm run build && npm run typecheck
npx tsc --build --force packages/gui packages/web
npx vitest run
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
node packages/gui/scripts/clicks.mjs
node packages/gui/scripts/transfer.mjs
```

Expected: build/typecheck clean, all tests pass, `3/3`, `19 chords/17 actions`,
`9 buttons/10 actions`, `10/10`.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: main extracts the selection, writes the clipboard, and pastes from it"
```

---

## Task 9: `select.mjs` — the Xvfb harness

**Files:**
- Create: `packages/gui/scripts/select.mjs`
- Create: `packages/gui/test/select-harness-flags.test.ts`

**This is the ONLY cover for Task 7**, so it has to be real: a mutation that disables the
`mousedown` selection branch must fail it.

- [ ] **Step 1: Add a selection seam to main**

```typescript
  /**
   * AN EIGHTH TEST SEAM: `TN3270_GUI_SELECT='2,5,7,20'` drags from one cell to another and copies.
   *
   * CELLS, NOT PIXELS, for the reason `TN3270_GUI_CLICKS` takes labels: a pixel list is a second
   * copy of the geometry that would pass while the geometry was wrong. Main asks the RENDERER to
   * turn cells into viewport pixels, then drives real Chromium mouse events through them -- so
   * `mousedown`, `mousemove`, `cellAt`, the highlight, `__tn3270Copy`, `sendAction`, the IPC hop,
   * `extractText` and `clipboard.writeText` are ALL under test. A seam that called `extractText`
   * directly would skip exactly the plumbing that has never run.
   */
  select: process.env['TN3270_GUI_SELECT'] ?? '',
```

And a `__tn3270CellCenter(row, col)` window global in the renderer, mirroring
`__tn3270ButtonCenter`: it returns the viewport pixel center of a cell, or `null`.

- [ ] **Step 2: Drive the drag in main**

```typescript
async function maybeSelect(win: BrowserWindow): Promise<void> {
  if (SEAM.select === '') return;
  const [top, left, bottom, right] = SEAM.select.split(',').map((n) => Number(n));
  const from = await win.webContents.executeJavaScript(
    `window.__tn3270CellCenter(${top}, ${left})`);
  const to = await win.webContents.executeJavaScript(
    `window.__tn3270CellCenter(${bottom}, ${right})`);
  if (from === null || to === null) {
    process.stdout.write(`select: NO CELL ${SEAM.select}\n`);
    return;
  }
  win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  // A MOVE BETWEEN THEM, because a press and a release at two points is not a drag: `mousemove` is
  // what advances `focus`, and a harness that skipped it would pass against a renderer that never
  // tracked the drag at all.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: to.x, y: to.y, button: 'left' });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 200));
  const copied = await win.webContents.executeJavaScript('window.__tn3270Copy()');
  await new Promise((r) => setTimeout(r, 200));
  // THE CLIPBOARD ITSELF, read back from Electron, which is the only honest end of this path.
  process.stdout.write(`select: copied=${copied} clipboard=${JSON.stringify(clipboard.readText())}\n`);
}
```

- [ ] **Step 3: Write the harness**

```javascript
#!/usr/bin/env node
/**
 * Selection and copy under Xvfb: does a real drag put the right text on the clipboard?
 *
 * ## WHAT THIS COVERS THAT NOTHING ELSE CAN
 *
 * `renderer.ts` is a browser entry point that throws at module load, so the barrel does not export
 * it and NO vitest file can execute a line of it (`canvas/src/index.ts`). The whole selection
 * gesture -- `mousedown`, `mousemove`, `cellAt`, the highlight, `__tn3270Copy` -- lives there.
 *
 * MUTATION TO PROVE IT, and run this before trusting the harness: make the `mousedown` selection
 * branch return early. `npm run build`, `npm run typecheck` and `npm test` all stay clean while
 * this harness reports `copied=false` and an empty clipboard.
 *
 * REPLAY MODE, NOT A LIVE HOST: the expected text must be deterministic, and TK5's panel paints a
 * live clock. Replay also means no password can reach the clipboard during a test.
 */
import { spawnSync } from 'node:child_process';
import { ensureDisplay, guiEnv } from './xvfb.mjs';

const ARGV = ['--no-sandbox', '--disable-gpu', '-insecure', '-model', '3278-2-E'];
const TRACE = 'packages/fixtures/traces/synthetic-ispf-like.trace';

ensureDisplay();

// The fixture's row 0 is known text; assert a SUBSTRING of it rather than the whole row, so the
// test says what it means and does not re-encode the whole fixture.
const CASES = [
  { label: 'one row, a few columns', select: '0,0,0,9' },
  { label: 'two rows', select: '0,0,1,9' },
];

let failures = 0;
for (const kase of CASES) {
  const env = guiEnv({
    TN3270_GUI_REPLAY: TRACE,
    TN3270_GUI_SELECT: kase.select,
  });
  const r = spawnSync('./node_modules/.bin/electron',
    ['packages/gui/dist/main.js', ...ARGV, '127.0.0.1:1'],
    { env, encoding: 'utf8', timeout: 90_000 });
  // THREE ORDERED BAILS -- error, then signal, then status -- because a SIGSEGV gives
  // `status=null, signal='SIGSEGV'` with stdout INTACT, and a bare `status !== 0` check let a
  // crashed client pass in this repo before.
  if (r.error) { console.log(`FAIL ${kase.label}: ${r.error.message}`); failures++; continue; }
  if (r.signal) { console.log(`FAIL ${kase.label}: died on ${r.signal}`); failures++; continue; }
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const line = out.split('\n').find((l) => l.startsWith('select:')) ?? '(no select line)';
  const ok = /copied=true/.test(line) && !/clipboard=""/.test(line);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${kase.label}: ${line}`);
  if (!ok) failures++;
}
console.log(`\n${CASES.length - failures}/${CASES.length} selection cases passed`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 4: Pin the harness's invocation**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = readFileSync(join(guiDir, 'scripts', 'select.mjs'), 'utf8');

describe('select.mjs runs the client the way every other harness does', () => {
  it('passes the three non-optional flags', () => {
    // `--no-sandbox` and `--disable-gpu` are both REQUIRED on this box (there is no GL at all, and
    // `show:false` HANGS without `--disable-gpu`); `-insecure` is required against Hercules and its
    // absence HANGS rather than failing.
    for (const flag of ['--no-sandbox', '--disable-gpu', '-insecure']) {
      expect(harness).toContain(flag);
    }
  });

  it('runs in REPLAY mode, which is what makes the expected text deterministic', () => {
    // And what keeps a live password away from the clipboard during a test.
    expect(harness).toContain('TN3270_GUI_REPLAY');
  });

  it('BAILS ON A SIGNAL BEFORE READING STATUS, so a crash cannot pass', () => {
    // Measured in this repo: a SIGSEGV gives `status=null, signal='SIGSEGV'` with stdout intact,
    // so a `status !== 0` check alone scored a crashed client as a pass.
    const sigAt = harness.indexOf('r.signal');
    const statusAt = harness.indexOf('copied=true');
    expect(sigAt).toBeGreaterThan(-1);
    expect(sigAt).toBeLessThan(statusAt);
  });

  it('sends a mouseMove BETWEEN the press and the release', () => {
    // A press and a release at two points is not a drag. Without the move, `focus` never advances
    // and the harness would pass against a renderer that never tracked the drag.
    expect(harness).toMatch(/mouseDown[\s\S]*mouseMove[\s\S]*mouseUp/);
  });
});
```

**Note:** the last assertion reads `select.mjs`, but the `sendInputEvent` calls live in `main.ts`.
Point the regex at whichever file actually contains them — read both and assert against the real
one. A test asserting a pattern in the wrong file passes vacuously forever.

- [ ] **Step 5: Run the harness and the mutation**

```bash
npm run build && npx tsc --build --force packages/gui
node packages/gui/scripts/select.mjs
```

Expected: `2/2 selection cases passed`.

Then mutate: make the `mousedown` selection branch return before setting `anchor`. Rebuild, re-run.
Expected: both cases FAIL with `copied=false`. **Restore and re-run.**

- [ ] **Step 6: Commit**

```bash
git add packages/gui/scripts/select.mjs packages/gui/test/select-harness-flags.test.ts packages/gui/src/main.ts packages/canvas/src/renderer.ts
git commit -m "test: an Xvfb harness for the selection gesture, mutation-verified"
```

---

## Task 10: documentation and the full gate

**Files:**
- Modify: `README.md`
- Modify: `docs/HANDOFF.md`
- Modify: `docs/live-testing.md`

- [ ] **Step 1: README — document the keys**

Add to the GUI section: the platform-split accelerators, that **`Ctrl-C` remains Clear**, that
selection is **rectangular**, that trailing whitespace is trimmed per line, and that paste treats a
newline as "next field" and never sends Enter. State plainly that **the web gateway has copy but not
paste**.

- [ ] **Step 2: live-testing.md — the paste runbook entry**

A section *Copy and paste in the GUI* recording: the offline harness result, and the live paste
check with its exact steps (log on to TSO, paste a dataset name into ISPF's `Option ===>`, confirm
the characters land). **Name what is NOT verified** rather than leaving it inferred.

- [ ] **Step 3: HANDOFF — move the START HERE**

Record: the feature, its spec and plan paths, the gate numbers, and what remains. Then **fix the
title date**, which is the exact trap this project has recorded twice — a fix reaches the prose body
and never the heading that summarizes it.

- [ ] **Step 4: Run the FULL gate**

```bash
npm run build && npm run typecheck
npx tsc --build --force packages/gui packages/web
npx vitest run
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
node packages/gui/scripts/clicks.mjs
node packages/gui/scripts/transfer.mjs
node packages/gui/scripts/select.mjs
node packages/web/scripts/browser-shot.mjs
node packages/web/scripts/browser-keys.mjs
python3 packages/tui/scripts/pty-smoke.py
```

Expected: build/typecheck clean; all tests pass; `3/3`; `19/17`; `9/10`; `10/10`; `2/2` selection;
`2/2` browser-shot; `13/11` browser-keys; `12 PASS / 0 FAIL`.

**`drive-playback.py` and `drive-e.py` are NOT required** — nothing here touches telnet negotiation
or the stream layer. Say so explicitly rather than letting "the gate was green" cover a subset.

- [ ] **Step 5: The live paste check**

**Probe the userids first** (`HERC01`-`HERC04`; type the userid at the VTAM panel and compare
`IKJ56425I ... IN USE` against `ENTER CURRENT PASSWORD FOR`), and remember a failed TSO run strands
one. Log on, reach ISPF, paste a dataset name into `Option ===>`, and confirm the characters land.

**If it fails, use the offline replay probe BEFORE a second live run** — it settled in one line what
five live hypotheses could not, and costs no userid.

- [ ] **Step 6: Commit and finish**

```bash
git commit -am "docs: copy and paste, with the gate numbers and what is not verified"
```

Then use `superpowers:finishing-a-development-branch`. The repo's practice: `--no-ff`, confirm
`git merge-base` equals `main` and that the merge reports exactly this branch's commits, and
**re-run the full gate ON THE MERGE COMMIT**.

---

## Self-review notes

**Spec coverage:** selection geometry (T1), extraction + `hidden` (T2), the `copy` action and the
four-function bridge (T3, T7 step 5), paste semantics with `just_wrapped` and both aborts (T4, T5),
the menu and platform-split accelerators plus the focus hazard (T6, T8 step 3), the highlight (T7),
clipboard read/write (T8), the gesture harness (T9), docs and the live check (T10). The spec's
out-of-scope list is respected: no light pen, no linear selection, no overlay-paste, no context
menu, no gateway paste.

**Known soft spots, flagged rather than hidden:**
- Task 7 and Task 8 cite names (`scale`, `atlasGeometry`, `transferWin`, `send`) this plan cannot
  know. **Read the source; it wins over the plan.** This project's recorded experience is that
  implementers who verified against the source caught dozens of plan defects.
- The `Oia` API in Task 5 is now VERIFIED, not speculative: `Keyboard.oia` is public
  (`keyboard.ts:19`) and `Oia.inhibit` takes a `KeyboardState` (`oia.ts:85`). The first draft of
  this plan called it with no argument, which would not have compiled.
- Task 9's last assertion may be pointed at the wrong file; the step says so and says how to fix it.
