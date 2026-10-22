# The full 122-key 3279 keyboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the GUI and the web gateway a second virtual-input surface on `Ctrl-B`: a full 122-key 3279 keyboard laid out like the real hardware, with working one-shot Shift and visibly inert keys for the ones we cannot action.

**Architecture:** A new `KEYBOARD_3279` table in `packages/frontend` owns the layout as data (regions, rows, offsets and widths in *key units*). A new shared view in `packages/canvas` builds it into a DOM through the same injected-dependency pattern `keypadUi.ts` uses, and owns the one-shot Shift state so it is unit-testable without a browser. Both DOM front ends mount it; the TUI and `KEYPAD_KEYS` are untouched.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes` on), vitest for units, Xvfb+Electron for `clicks.mjs`, CDP-driven Electron for `browser-clicks.mjs`, plain CSS in the shared `packages/gui/ui.css`.

**Spec:** `docs/superpowers/specs/2026-10-22-full-keyboard-design.md`

---

## Read this before Task 1

**THE REPO BEATS THIS PLAN.** This project has repeatedly found that most execution-time defects
were in the plan's own literal code. Re-derive every citation. If the repo disagrees, the repo wins
and you say so in your report rather than making the code match the plan.

**THE SINGLE HIGHEST-RISK ITEM, AND IT KILLS THE GATEWAY RATHER THAN FAILING A TEST.**
`web/src/main.ts` calls `applyAction` **outside any try** in a socket `data` handler, and
`applyAction` will throw on the new `toggleKeyboard` kind by design. `protocol.ts` states the rule:
a new action kind is **either refused at decode or intercepted in `main.ts`, in the same change
that introduces it.** That file records a commit that took neither branch. **Task 4 does all four
halves together and must not be split.**

**FOUR FACTS, VERIFIED 2026-10-22. Re-check them:**

1. `{ kind: 'type'; text: string }` already exists in the `Action` union (`keymap.ts:116`) and is
   what the real-keyboard path produces (`canvas/src/keys.ts:155`). **No new action kind is needed
   for any character key.**
2. `KeypadKey.row` and `.col` are **dead** — `canvas/src/keypad.ts` no longer exists. Verify with
   `grep -rn "\.row\|\.col" packages/*/src | grep -i keypad` before Task 2 deletes them.
3. The taken `Ctrl` chords are `C R U ] A D F K T` (`bindings.ts`'s `BINDING_INTENT` and
   `canvas/src/keys.ts`'s `CTRL` agree). **`B` is free.**
4. `createKeypadUi(deps: KeypadDeps)` in `packages/canvas/src/keypadUi.ts` is the pattern to copy:
   an injected DOM abstraction (`create`/`append`/`setText`/`setTitle`/`setAttr`/`onClick`/
   `sendAction`), which is what lets the existing keypad be unit-tested with no jsdam. **jsdom is
   deliberately not a dependency of this repo.**

**ELECTRON HARNESSES LEAK PROCESSES.** Repeated runs left 72 Electron processes contending for one
Xvfb display, after which `browser-clicks` reported `0/7` and `bridge.js did not load` —
indistinguishable from a regression. **Run `pkill -9 -f "node_modules/electron"; sleep 3` between
every browser-harness run**, one harness per shell invocation (`pkill` returns non-zero when
nothing matched, which aborts a `for` loop or `&&` chain — end such a command with `exit 0`).

**THE LEGENDS MUST COME FROM THE PHOTOGRAPH, NOT FROM THIS PLAN.** `$HOME/s-l960.png`. Several caps
are genuinely unreadable at that resolution. Task 1 says which ones this plan is confident about and
which need checking, and **where you cannot read a legend, leave the key inert with its `name` set
and say so in your report** — an invented legend on a historical keyboard is exactly the kind of
plausible-but-wrong detail this project keeps catching. Useful crop recipe:

```bash
python3 -I -c "
from PIL import Image
im=Image.open('$HOME/s-l960.png')
im.crop((165,415,620,580)).resize((1365,495),Image.LANCZOS).save('/tmp/kb-main.png')"
```

**BUDGET NOTE.** This plan may be executed across more than one session. Tasks 1-3 are pure data
and pure logic with no DOM; Tasks 4-6 wire the front ends; Task 7 is the gate and the docs. **Each
task ends green and committed, so stopping between any two is safe.**

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/frontend/src/keyboard3279.ts` | The 122-key layout AS DATA: regions, rows, key units, labels, actions | **Create** |
| `packages/frontend/src/index.ts` | Public surface | Export the table and its types |
| `packages/frontend/src/keypad.ts` | `KEYPAD_KEYS` | Delete the dead `row`/`col` fields (Task 2) |
| `packages/frontend/src/keymap.ts` | `Action` union, chord tables | Add `toggleKeyboard`; map `Ctrl-B` |
| `packages/frontend/src/bindings.ts` | `BINDING_INTENT` | One row for `Ctrl-B` |
| `packages/frontend/src/actions.ts` | `applyAction` | Throw on `toggleKeyboard`, like `toggleKeypad` |
| `packages/canvas/src/keys.ts` | Browser `KeyboardEvent` → `Action` | `b: { kind: 'toggleKeyboard' }` |
| `packages/canvas/src/keyboardUi.ts` | Build the keyboard into a DOM; **own the one-shot Shift** | **Create** |
| `packages/web/src/keyboardOverlay.ts` | Show/hide for the web surface | **Create** (or generalise `keypadOverlay.ts`) |
| `packages/web/src/bridge.ts` | Mount it, intercept the chord client-side | Modify |
| `packages/web/src/bridgecore.ts` | `toggleKeyboard?: () => void` dep | Modify |
| `packages/web/src/protocol.ts` | Accept the kind at decode | Modify |
| `packages/web/src/main.ts` | `return` before `applyAction` for the kind | Modify |
| `packages/web/static/index.html` | `#keyboard-overlay` element | Modify |
| `packages/gui/src/keyboardBoot.ts` | The GUI window's renderer entry | **Create** |
| `packages/gui/keyboard.html` | The GUI window's page | **Create** |
| `packages/gui/src/main.ts` | Open/close the window, menu item, intercept | Modify |
| `packages/gui/ui.css` | Keyboard geometry + the inert style | Modify |
| `packages/tui/**` | — | **UNTOUCHED** |

---

## Task 1: `KEYBOARD_3279`, the layout as data

**Files:**
- Create: `packages/frontend/src/keyboard3279.ts`
- Modify: `packages/frontend/src/index.ts`
- Test: `packages/frontend/test/keyboard3279.test.ts`

- [ ] **Step 1: Read the photograph before writing a line**

```bash
cd ~/git/tn3270
python3 -I -c "
from PIL import Image
im=Image.open('$HOME/s-l960.png')
im.crop((20,270,910,620)).resize((1335,525),Image.LANCZOS).save('/tmp/kb-whole.png')
im.crop((165,415,620,580)).resize((1365,495),Image.LANCZOS).save('/tmp/kb-main.png')
im.crop((55,415,165,585)).resize((440,680),Image.LANCZOS).save('/tmp/kb-left.png')
im.crop((610,410,740,580)).resize((390,510),Image.LANCZOS).save('/tmp/kb-mid.png')
im.crop((160,320,560,400)).resize((1200,240),Image.LANCZOS).save('/tmp/kb-pf.png')"
```

Then LOOK at all five. **What this plan is confident of, from the photograph:**

- **`pf`**: two rows of twelve. `PF13`-`PF24` ON TOP, `PF1`-`PF12` below. That ordering matches
  `KEYPAD_KEYS`' own (`pfRow(0, 13)` then `pfRow(1, 1)`) and c3270's
  (`Common/c3270/keypad.labels:2` and `:4`). **Do not "fix" it.**
- **`special-left`**, two columns × five rows: `Attn` `Clear` / `Cursr Sel` (blank) / `Esc`
  `Print Screen` / `Scroll Lock` `Pause` / **two blank caps**.
- **`cursor`** cluster: `Dup`+`PA1` and `Field Mark`+`PA2` on top; then a left-arrow-ish key, a
  `Home`-ish house glyph, and a third glyph; then the four arrows in an inverted-T.
- **`numpad`**: `7 8 9` / `4 5 6` / `1 2 3` / `0`, with `Space`-ish, `Tab`-ish, `-`, and `Enter`
  down the right side.
- **`main`**: five rows. Number row `1`-`0` with `|@#$%¬&*()` above them, then `_`/`-` and `+`/`=`,
  then Backspace. QWERTY row begins with a Tab key and ends `!`/`¢`, `|`/`\`. Home row begins with
  a lock glyph, `A`-`L`, then `:`/`;` and `"`/`'`. Bottom row begins with a Shift showing `>`/`<`,
  `Z`-`M`, then `,`/`;`-ish, `.`/`:`-ish, `?`/`/`, and a second Shift. Last row: `Reset`, `Alt`,
  spacebar, `Alt`, a blank, `Enter`.

**WHAT THIS PLAN IS *NOT* CONFIDENT OF — verify or leave inert:** the exact punctuation legends on
the right-hand ends of the QWERTY, home and bottom rows; the `0` cap (obscured); the three glyph
keys above the arrows; the numpad's right-hand column. **A legend you cannot read is a key with
`label` set to what you CAN see, `action: undefined`, and a note in your report.** Do not guess
3270 punctuation from a PC keyboard — the layouts differ (`¬` on 6 is the giveaway).

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { KEYBOARD_3279, KEYBOARD_REGIONS, type KeyCap } from '../src/keyboard3279.js';

describe('KEYBOARD_3279', () => {
  it('has a cap for every key on a 122-key unit, give or take the blanks', () => {
    // NOT asserted as exactly 122: the photograph's unit has blank caps and this table draws
    // them, so the count is a property of the LAYOUT rather than a target to hit. A range
    // catches "half the table is missing" without pretending to a precision we lack.
    expect(KEYBOARD_3279.length).toBeGreaterThanOrEqual(110);
    expect(KEYBOARD_3279.length).toBeLessThanOrEqual(130);
  });

  it('puts every cap in a declared region', () => {
    for (const cap of KEYBOARD_3279) {
      expect(KEYBOARD_REGIONS, `${cap.name} region`).toContain(cap.region);
    }
  });

  it('gives the PF region 24 keys, PF13-24 ABOVE PF1-12', () => {
    // The order matches KEYPAD_KEYS and c3270. Pinning the first label of each row rather than
    // only the count, which is what catches a silent reversal.
    const pf = KEYBOARD_3279.filter((k) => k.region === 'pf');
    expect(pf).toHaveLength(24);
    const row0 = pf.filter((k) => k.row === 0);
    const row1 = pf.filter((k) => k.row === 1);
    expect(row0[0]?.label).toBe('PF13');
    expect(row1[0]?.label).toBe('PF1');
  });

  it('NEVER carries toggleKeypad, toggleKeyboard or quit', () => {
    // applyAction THROWS on all three, so a drawn button for any of them would be a button whose
    // only effect is to throw -- and toggleKeyboard's would toggle the surface it is drawn on.
    for (const cap of KEYBOARD_3279) {
      expect(['toggleKeypad', 'toggleKeyboard', 'quit'], cap.name)
        .not.toContain(cap.action?.kind);
    }
  });

  it('NO TWO CAPS OVERLAP within a region row, and that is arithmetic a photograph cannot check',
    () => {
      const seen = new Map<string, Array<{ from: number; to: number; name: string }>>();
      for (const cap of KEYBOARD_3279) {
        const key = `${cap.region}:${cap.row}`;
        const list = seen.get(key) ?? [];
        list.push({ from: cap.x, to: cap.x + cap.width, name: cap.name });
        seen.set(key, list);
      }
      for (const [where, list] of seen) {
        list.sort((a, b) => a.from - b.from);
        for (let i = 1; i < list.length; i++) {
          expect(list[i]!.from, `${where}: ${list[i - 1]!.name} overlaps ${list[i]!.name}`)
            .toBeGreaterThanOrEqual(list[i - 1]!.to);
        }
      }
    });

  it('gives every cap a positive width and a non-negative offset', () => {
    for (const cap of KEYBOARD_3279) {
      expect(cap.width, `${cap.name} width`).toBeGreaterThan(0);
      expect(cap.x, `${cap.name} x`).toBeGreaterThanOrEqual(0);
    }
  });

  it('names every cap, including the inert ones, for the tooltip and for a screen reader', () => {
    for (const cap of KEYBOARD_3279) {
      expect(cap.name.length, `${JSON.stringify(cap.label)} has no name`).toBeGreaterThan(0);
    }
  });

  it('gives a shiftLabel to exactly the dual-glyph caps, and none to the rest', () => {
    // A letter has no shiftLabel: `A` sends 'A' unshifted on a 3270 typewriter keyboard, and a
    // shiftLabel of 'A' would make Shift a no-op that still consumed the arm.
    const q = KEYBOARD_3279.find((k) => k.label === 'Q');
    expect(q?.shiftLabel).toBeUndefined();
    const dual = KEYBOARD_3279.filter((k) => k.shiftLabel !== undefined);
    expect(dual.length, 'the number row alone is a dozen dual-glyph caps')
      .toBeGreaterThanOrEqual(10);
    for (const cap of dual) {
      expect(cap.action?.kind, `${cap.name} has a shiftLabel but is not a typed character`)
        .toBe('type');
    }
  });

  it('carries Xfer on one of the two blank special caps, and leaves the other blank', () => {
    // The user's own suggestion, and there is precedent: KEYPAD_KEYS already carries Xfer as a
    // deliberate non-3270 addition.
    const xfer = KEYBOARD_3279.filter((k) => k.action?.kind === 'transferForm');
    expect(xfer).toHaveLength(1);
    expect(xfer[0]?.region).toBe('special-left');
  });

  it('leaves Cursor Select INERT, which is deferred rather than forgotten', () => {
    // AID.SELECT exists in core but the key needs the field-intensity parse and belongs with the
    // light-pen work -- `keypad.ts` records the same decision for the compact keypad.
    const sel = KEYBOARD_3279.find((k) => k.name.toLowerCase().includes('cursor select'));
    expect(sel, 'Cursor Select must be DRAWN, not omitted').toBeDefined();
    expect(sel?.action).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/keyboard3279.test.ts 2>&1 | tail -8
```

Expected: failure to resolve `../src/keyboard3279.js`.

- [ ] **Step 4: Write the module**

Create `packages/frontend/src/keyboard3279.ts`. The header must carry the WHY, in this project's
idiom — a reader needs to know why this is a second table:

```ts
import type { Action } from './keymap.js';

/**
 * The 122-key 3279 keyboard, as DATA.
 *
 * ## WHY A SECOND TABLE RATHER THAN AN EXTENSION OF `KEYPAD_KEYS`
 *
 * The two answer different questions. `KEYPAD_KEYS` is "which keys are hard to type" -- 48 entries,
 * consumed by all three front ends, and the TUI renders it as a name-and-chord LIST in a
 * 29-column overlay. This is "what does a 3279 keyboard look like" -- ~122 entries with real
 * geometry, consumed only by the two DOM front ends, because the TUI cannot draw a keyboard:
 * c3270's own keypad is 78 columns wide and that front end refuses to draw below 24x80.
 *
 * `keypadView.ts` set this precedent for the same reason -- `KEYPAD_KEYS`' cell coordinates were
 * the wrong model for a DOM layout -- and its header's argument applies here with more force: the
 * layout is WRITTEN DOWN, not derived, because deriving it would make it agree with itself by
 * construction and be unable to catch a change.
 *
 * ## THE GEOMETRY IS IN KEY UNITS, NOT PIXELS
 *
 * One unit is one standard cap. `Enter`, the spacebar and several others are wider, so a cap
 * carries `x` and `width` in units and the CSS multiplies by whatever pitch it picks. Pixels here
 * would freeze a font size into a data table.
 *
 * ## LEGENDS COME FROM THE PHOTOGRAPH, AND SOME ARE UNREADABLE
 *
 * Transcribed from `s-l960.png`. This is the 3270 TYPEWRITER layout and it is NOT a PC one --
 * `not` sign on 6 and `|` on 1 are the giveaways -- so a legend must never be inferred from a PC
 * keyboard. Where the photograph could not be read, the cap is INERT with its `name` set, and
 * says so at the entry. That is better than a plausible invention: this project has a recorded
 * habit of catching exactly that kind of detail.
 */
export const KEYBOARD_REGIONS = [
  'pf', 'special-left', 'main', 'cursor', 'numpad',
] as const;

export type KeyboardRegion = typeof KEYBOARD_REGIONS[number];

export interface KeyCap {
  /** What is printed on the cap, unshifted. `''` for a genuinely blank cap. */
  readonly label: string;
  /**
   * The shifted legend, on a dual-glyph cap only.
   *
   * ABSENT ON A LETTER, deliberately: `A` sends 'A' unshifted on this keyboard, so a `shiftLabel`
   * of 'A' would make Shift a no-op that still consumed its one-shot arm.
   */
  readonly shiftLabel?: string;
  /**
   * What the cap does, or `undefined` for an INERT cap -- a key that exists on the hardware and
   * will never do anything here. Drawn rather than omitted: a gap where `Esc` belongs is less
   * honest than a key that is plainly scenery. See `ui.css` for the styling and why it is not the
   * house `opacity: 0.5`.
   */
  readonly action?: Action | undefined;
  readonly region: KeyboardRegion;
  /** Row within the region, from 0 at the top. */
  readonly row: number;
  /** Left edge in KEY UNITS, within the region's row. */
  readonly x: number;
  /** Width in KEY UNITS. 1 is a standard cap. */
  readonly width: number;
  /** What this key is called in words: the tooltip, and the accessible name. */
  readonly name: string;
}
```

Then build the table. **Use small local helpers rather than 122 hand-written literals** — the PF
rows, the letter rows and the numpad are all regular, and a helper makes the irregular caps the
visible ones:

```ts
/** A plain typed character: one unit wide, named after itself. */
const ch = (
  label: string, region: KeyboardRegion, row: number, x: number,
  shiftLabel?: string,
): KeyCap => ({
  label,
  ...(shiftLabel === undefined ? {} : { shiftLabel }),
  action: { kind: 'type', text: label },
  region, row, x, width: 1,
  name: shiftLabel === undefined ? label : `${label} / ${shiftLabel}`,
});

/** An inert cap: drawn, named, and does nothing. */
const dead = (
  label: string, region: KeyboardRegion, row: number, x: number, width: number, name: string,
): KeyCap => ({ label, action: undefined, region, row, x, width, name });
```

**`exactOptionalPropertyTypes` IS ON**, so a conditional spread is required for optional
properties — `shiftLabel: undefined` does not satisfy `shiftLabel?: string`. The `ch` helper above
already does it that way; copy that shape rather than fighting the compiler.

For a dual-glyph cap the `action` must send the **unshifted** text, with `shiftLabel` carrying the
other; Task 3's Shift logic is what substitutes it.

- [ ] **Step 5: Export it**

In `packages/frontend/src/index.ts`, beside the existing `KEYPAD_BLOCKS` export:

```ts
export { KEYBOARD_3279, KEYBOARD_REGIONS } from './keyboard3279.js';
export type { KeyCap, KeyboardRegion } from './keyboard3279.js';
```

- [ ] **Step 6: Build, typecheck, run**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5
npm run typecheck 2>&1 | grep -iE "error TS" | head -5
npx vitest run packages/frontend/test/keyboard3279.test.ts 2>&1 | tail -6
```

Expected: build and typecheck clean, every case green. **`npm run build` before believing any test
result** — vitest does not typecheck, and this repo has recorded 15 green tests over a failed build.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend/src/keyboard3279.ts packages/frontend/src/index.ts \
        packages/frontend/test/keyboard3279.test.ts
git commit -m "feat(frontend): KEYBOARD_3279, a 122-key layout as data

A second table beside KEYPAD_KEYS rather than an extension of it: the two
answer different questions, and keypadView.ts set that precedent. Geometry
is in KEY UNITS so the CSS owns the pitch.

Legends transcribed from the reference photograph. This is the 3270
typewriter layout, not a PC one, so no legend is inferred from a PC
keyboard; the ones the photograph could not resolve are inert with their
names set and say so at the entry.

The overlap test is the one a photograph cannot replace.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: Delete the dead `row`/`col` fields

**Files:**
- Modify: `packages/frontend/src/keypad.ts`
- Modify: `packages/frontend/src/keypadView.ts` (its header predicts this deletion)
- Test: whatever asserts them

- [ ] **Step 1: PROVE they are dead before deleting anything**

```bash
cd ~/git/tn3270
ls packages/canvas/src/keypad.ts        # expect: No such file
grep -rn "\.row\b" packages/*/src/*.ts | grep -iv transfer | grep -i keypad
grep -rn "KEYPAD_KEY_WIDTH\|DRAWN_ROW" packages/ --include=*.ts | grep -v node_modules
grep -rn "\.row\|\.col" packages/*/test/keypad*.ts
```

**If ANY consumer turns up, STOP and skip this task**, reporting what you found. The whole
justification is that `canvas/src/keypad.ts` was deleted in the keypad-window work and
`keypadView.ts`'s header says these fields *"become dead only when that file is deleted"*.

- [ ] **Step 2: Delete the fields and their docstrings**

Remove `row` and `col` from the `KeypadKey` interface and from all 48 entries (and from `pfRow`'s
construction). Update `keypadView.ts`'s header: the section arguing the fields are *"LEFT ALONE…
still live fields, not legacy ones"* is now false and must say they were deleted, with the reason.

- [ ] **Step 3: Build, typecheck, full suite**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5
npm run typecheck 2>&1 | grep -iE "error TS" | head -5
npx vitest run 2>&1 | tail -5
```

Expected: clean, and the suite green. **The compiler is the real check here** — a surviving reader
of either field is a type error, not a test failure.

- [ ] **Step 4: Commit separately from the feature**

```bash
git add -A packages/frontend
git commit -m "refactor(frontend): delete KeypadKey.row and .col, which are dead

They were cell coordinates for canvas/src/keypad.ts, which no longer exists --
keypadView.ts's header predicted they would become dead when that file went,
and it has. Proven by grep and by the compiler before deleting.

Separate from the keyboard feature on purpose: a deletion from a 48-row table
and a new 122-row table are two risks, and mixing them is how one hides the
other.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: `keyboardUi.ts` — the shared view, and the one-shot Shift

**Files:**
- Create: `packages/canvas/src/keyboardUi.ts`
- Modify: `packages/canvas/src/index.ts`
- Test: `packages/canvas/test/keyboardUi.test.ts`

- [ ] **Step 1: Read the pattern you are copying**

```bash
cd ~/git/tn3270 && sed -n '55,140p' packages/canvas/src/keypadUi.ts
sed -n '1,30p' packages/canvas/test/keypadUi.test.ts
```

`KeypadDeps` injects the DOM (`create`/`append`/`setText`/`setTitle`/`setAttr`/`onClick`/
`sendAction`). **Copy that shape.** It is what lets the keypad be tested on all 48 pairs with no
jsdom, and jsdom is deliberately not a dependency here.

- [ ] **Step 2: Write the failing tests — the Shift rules are the interesting half**

```ts
import { describe, it, expect, vi } from 'vitest';
import { createKeyboardUi, type KeyboardDeps } from '../src/keyboardUi.js';
import type { Action } from '@tn3270/frontend/dist/keymap.js';

/** A fake DOM, because vitest runs `environment: 'node'` and there is no `document`. */
function fakeDeps(): KeyboardDeps & {
  readonly sent: Action[];
  readonly els: Array<{ tag: string; attrs: Record<string, string>; text: string;
                        clicks: Array<() => void> }>;
} {
  const sent: Action[] = [];
  const els: Array<{ tag: string; attrs: Record<string, string>; text: string;
                     clicks: Array<() => void> }> = [];
  const mk = (tag: string): HTMLElement => {
    const rec = { tag, attrs: {} as Record<string, string>, text: '', clicks: [] as Array<() => void> };
    els.push(rec);
    return rec as unknown as HTMLElement;
  };
  const rec = (el: HTMLElement) => el as unknown as (typeof els)[number];
  return {
    sent,
    els,
    root: mk('div'),
    create: mk,
    append: () => {},
    setText: (el, text) => { rec(el).text = text; },
    setTitle: (el, title) => { rec(el).attrs['title'] = title; },
    setAttr: (el, name, value) => { rec(el).attrs[name] = value; },
    onClick: (el, fn) => { rec(el).clicks.push(fn); },
    sendAction: (a) => { sent.push(a); },
  };
}

/** Click the first button whose label text matches. */
function click(deps: ReturnType<typeof fakeDeps>, label: string): void {
  const el = deps.els.find((e) => e.tag === 'button' && e.text === label);
  if (el === undefined) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  for (const fn of el.clicks) fn();
}

describe('createKeyboardUi', () => {
  it('draws a button per cap and sends a cap action on click', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    click(deps, 'PF3');
    expect(deps.sent).toEqual([{ kind: 'pf', n: 3 }]);
  });

  it('MARKS AN INERT CAP DISABLED AND SENDS NOTHING FOR IT', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    const esc = deps.els.find((e) => e.tag === 'button' && e.text === 'Esc');
    expect(esc?.attrs['disabled']).toBeDefined();
    click(deps, 'Esc');
    expect(deps.sent, 'an inert cap must raise no action at all').toEqual([]);
  });

  it('does NOT mark an actionable cap disabled', () => {
    const deps = fakeDeps();
    createKeyboardUi(deps);
    const pf3 = deps.els.find((e) => e.tag === 'button' && e.text === 'PF3');
    expect(pf3?.attrs['disabled']).toBeUndefined();
  });

  describe('the one-shot Shift', () => {
    it('sends the SHIFTED text for the next character, then disarms', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, 'Shift');
      click(deps, '2');                 // the cap is 2 with @ above it
      expect(deps.sent).toEqual([{ kind: 'type', text: '@' }]);
      click(deps, '2');                 // disarmed: back to unshifted
      expect(deps.sent).toEqual([{ kind: 'type', text: '@' }, { kind: 'type', text: '2' }]);
    });

    it('A KEY WITH NO shiftLabel DOES NOT CONSUME THE ARM', () => {
      // 3270 has no shifted PF3, and silently eating the arm would make the modifier feel broken.
      // THIS IS THE RULE MOST LIKELY TO BE GOT WRONG, so it is asserted in both directions.
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, 'Shift');
      click(deps, 'PF3');
      expect(deps.sent).toEqual([{ kind: 'pf', n: 3 }]);
      click(deps, '2');
      expect(deps.sent[1], 'shift must have SURVIVED the PF key')
        .toEqual({ kind: 'type', text: '@' });
    });

    it('disarms when Shift is pressed again, so a misclick is undoable', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, 'Shift');
      click(deps, 'Shift');
      click(deps, '2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '2' }]);
    });

    it('raises NO action of its own: Shift is pure surface state', () => {
      const deps = fakeDeps();
      createKeyboardUi(deps);
      click(deps, 'Shift');
      expect(deps.sent, 'nothing may cross the socket or IPC when Shift is pressed').toEqual([]);
    });

    it('reports its armed state, so a caller can paint the cap and reset on close', () => {
      const deps = fakeDeps();
      const ui = createKeyboardUi(deps);
      expect(ui.shiftArmed()).toBe(false);
      click(deps, 'Shift');
      expect(ui.shiftArmed()).toBe(true);
      ui.disarmShift();
      expect(ui.shiftArmed()).toBe(false);
      click(deps, '2');
      expect(deps.sent).toEqual([{ kind: 'type', text: '2' }]);
    });
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/canvas/test/keyboardUi.test.ts 2>&1 | tail -8
```

Expected: cannot resolve `../src/keyboardUi.js`.

- [ ] **Step 4: Implement it**

`packages/canvas/src/keyboardUi.ts`, returning an object so the caller can read and reset the Shift
state:

```ts
export interface KeyboardUi {
  /** Is the one-shot Shift armed? For painting the cap. */
  shiftArmed(): boolean;
  /** Clear it. Called when the surface closes. */
  disarmShift(): void;
}
```

The click handler per cap, which is the whole of the new logic:

```ts
      deps.onClick(button, () => {
        /*
          THE ONE-SHOT SHIFT, AND THE ORDER OF THESE THREE CHECKS IS THE SPECIFICATION.

          The user's words: "if you hit it the next regular character you type acts as if you'd
          shifted it, and then shift unselects. Basically the same as Caps Lock but it unsets
          itself after the next character."

          1. The Shift cap itself TOGGLES the arm and sends NOTHING. Pure surface state: no
             action crosses the socket or IPC, and the `Action` union needs no `shift` member.
          2. An INERT cap does nothing and -- deliberately -- does not touch the arm either.
          3. A cap WITH a `shiftLabel` consumes the arm and sends the shifted text.
          4. A cap WITHOUT one (PF3, Enter, an arrow) sends its own action and LEAVES THE ARM
             ALONE. 3270 has no shifted PF3, and eating the arm there would make the modifier
             feel broken -- this is the rule most likely to be implemented wrongly, and the test
             asserts it in both directions.
        */
        if (isShift) { shifted = !shifted; paintShift(); return; }
        if (cap.action === undefined) return;
        if (cap.shiftLabel !== undefined && shifted) {
          shifted = false;
          paintShift();
          deps.sendAction({ kind: 'type', text: cap.shiftLabel });
          return;
        }
        deps.sendAction(cap.action);
      });
```

Group the caps by `region` then `row`, emit one `<div class="keyboard-row">` per row, and set
`data-key` to the cap's `name` so the harnesses can find a key without matching on a glyph that
might be unreadable. Set `type="button"` explicitly — a bare `<button>` inside a form defaults to
`submit`, which `keypadUi.ts` already guards against for the same reason.

Identify the Shift caps by `name`, and **both left and right Shift must drive the same state**:
neither is distinguishable to us.

- [ ] **Step 5: Export, build, run**

Add to `packages/canvas/src/index.ts`:

```ts
export { createKeyboardUi } from './keyboardUi.js';
export type { KeyboardDeps, KeyboardUi } from './keyboardUi.js';
```

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5
npm run typecheck 2>&1 | grep -iE "error TS" | head -5
npx vitest run packages/canvas/test/keyboardUi.test.ts 2>&1 | tail -6
```

- [ ] **Step 6: MUTATION-PROVE the Shift rule that matters**

```bash
cd ~/git/tn3270
# Make a no-shiftLabel cap consume the arm -- i.e. clear `shifted` unconditionally.
#   Edit the handler so the PF branch also sets `shifted = false`, rebuild, and run:
npm run build >/dev/null 2>&1 && npx vitest run packages/canvas/test/keyboardUi.test.ts 2>&1 | tail -4
#   EXPECTED: 'A KEY WITH NO shiftLabel DOES NOT CONSUME THE ARM' FAILS. Restore and rebuild.
```

**Record the result in the commit.** A green test over the behaviour it claims to pin is a thing
this repo has recorded twice.

- [ ] **Step 7: Commit**

```bash
git add packages/canvas/src/keyboardUi.ts packages/canvas/src/index.ts \
        packages/canvas/test/keyboardUi.test.ts
git commit -m "feat(canvas): the shared keyboard view, with a one-shot Shift

Copies keypadUi.ts's injected-DOM pattern, so this is unit-tested with no
jsdom -- which is deliberately not a dependency of this repo.

The one-shot Shift is the only genuinely new logic in the feature: arm it and
the next character sends its shifted legend, then it disarms. A cap with NO
shiftLabel does NOT consume the arm, because 3270 has no shifted PF3 and
eating it there would make the modifier feel broken. Mutation-proved: making
that branch consume the arm turns the test red.

Shift raises no action at all -- pure surface state, nothing crosses the
socket, and the Action union needs no new member.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: `toggleKeyboard`, the action and ALL FOUR GUARDS

**Files:**
- Modify: `packages/frontend/src/keymap.ts`, `bindings.ts`, `actions.ts`
- Modify: `packages/canvas/src/keys.ts`
- Modify: `packages/web/src/protocol.ts`, `main.ts`
- Test: `packages/web/test/integration.test.ts`, `packages/frontend/test/*`

**DO NOT SPLIT THIS TASK.** `main.ts` calls `applyAction` outside any try in a socket `data`
handler, so a kind that exists without its intercept **ends the gateway process** on the first
browser keystroke. `protocol.ts` records a commit that violated exactly this.

- [ ] **Step 1: Read the rule and the precedent**

```bash
cd ~/git/tn3270
grep -n -B10 -A6 "toggleKeypad" packages/web/src/main.ts | head -40
grep -n "REFUSED\|SWALLOWED" packages/web/test/integration.test.ts
grep -n -A8 "toggleKeypad" packages/frontend/src/actions.ts | head -20
```

Note `REFUSED = ['quit', 'copy']` and `SWALLOWED = ['toggleKeypad', 'transferForm']`. **A kind in
neither list is the bug that pair exists to catch.**

- [ ] **Step 2: Add the union member**

In `packages/frontend/src/keymap.ts`, beside `toggleKeypad`:

```ts
  // The front end's own FULL KEYBOARD surface, and `applyAction` throws on it exactly as it does
  // on `toggleKeypad` and `quit`: what a surface looks like is the front end's business. It lives
  // in this union so the chord, the GUI's menu item and `BINDING_INTENT` can all name it the way
  // every other action is named.
  //
  // NOT because a cap needs it: neither `KEYPAD_KEYS` nor `KEYBOARD_3279` may contain it, since a
  // drawn button for it would be a button that toggles the surface it is drawn on.
  | { kind: 'toggleKeyboard' }
```

- [ ] **Step 3: Map `Ctrl-B` in both mappers**

`packages/canvas/src/keys.ts`, in `CTRL`:

```ts
  b: { kind: 'toggleKeyboard' },
```

`packages/frontend/src/bindings.ts`, in `BINDING_INTENT`:

```ts
  {
    key: 'Ctrl-B', action: { kind: 'toggleKeyboard' }, terminal: '\x02',
    note: 'opens the FULL 122-key keyboard in the GUI and the web gateway. The TUI has no such '
      + 'surface -- it renders the compact keypad as a list, because it cannot draw a keyboard '
      + 'inside 24x80 -- so this row documents an intent two of the four front ends implement',
  },
```

**`terminal: '\x02'` is Ctrl-B's byte — AND THE TUI QUESTION IS ALREADY ANSWERED, 2026-10-22.**

**`keymap.ts`'s `buildTable()` IS HAND-WRITTEN AND DOES NOT READ `BINDING_INTENT`** (that file
mentions the constant once, in a comment). So adding a `BINDING_INTENT` row **cannot** give the TUI
a `Ctrl-B` binding: the TUI's key table only gains a chord when `buildTable` calls `t.set` for it,
and **`buildTable` MUST NOT be given one** — `applyAction` throws on `toggleKeyboard` and the TUI
has no such surface to open.

**`0x02` is free in `buildTable`.** Its own comment records the taken control bytes as
`01 03 04 06 0b 12 15 1d 7f`, and `02` is not among them. **Leave it free anyway.**

**BUT THERE IS A REAL SIDE EFFECT TO HANDLE.** `tui/src/keypadOverlay.ts` reads `BINDING_INTENT` to
print a chord beside each key name — its header says *"THE CHORDS COME FROM `BINDING_INTENT`, NOT
FROM A SECOND LIST"*. A bare new row would therefore make `Ctrl-B` appear in the **TUI's** overlay
as a hint for a surface that front end does not have.

**Check what that overlay does with a row whose action matches no `KEYPAD_KEYS` entry** before
adding the row:

```bash
grep -n -B4 -A14 "BINDING_INTENT" packages/tui/src/keypadOverlay.ts
```

`toggleKeyboard` is in neither key table (Task 1's test pins that), so the overlay most likely never
looks it up and nothing appears — in which case the row is harmless and the `note` is simply
documentation. **If it DOES surface, drop the `BINDING_INTENT` row entirely**: the chord still works
in both DOM front ends via `canvas/src/keys.ts`, and a hint for a key that does nothing in the TUI
is worse than an undocumented intent. Say which you found in your report.

- [ ] **Step 4: Make `applyAction` throw on it**

In `packages/frontend/src/actions.ts`, extend the existing `quit`/`toggleKeypad` guard to cover
`toggleKeyboard`, and extend the header comment that explains why those throw rather than being
ignored.

- [ ] **Step 5: The gateway's two halves, together**

`packages/web/src/protocol.ts`: **accept** the kind at decode. It is a legitimate browser action,
intercepted client-side, so refusing it would refuse a chord the browser may press. Add a comment
pointing at the `main.ts` intercept as the other branch of the two-branch rule.

`packages/web/src/main.ts`, beside the `toggleKeypad` line:

```ts
      // INTERCEPTED, NOT APPLIED, exactly as `toggleKeypad` is: this surface is the BROWSER's and
      // the gateway holds nothing for it. `applyAction` THROWS on the kind, and this call is
      // outside any try in a socket data handler, so deleting this line ends the process on the
      // first Ctrl-B. The other branch of `protocol.ts`'s two-branch rule is the decode
      // acceptance, which landed in this same change.
      if (msg.action.kind === 'toggleKeyboard') return;
```

- [ ] **Step 6: Add it to `SWALLOWED`**

In `packages/web/test/integration.test.ts`:

```ts
const SWALLOWED: readonly string[] = ['toggleKeypad', 'transferForm', 'toggleKeyboard'];
```

- [ ] **Step 7: Build, typecheck, full suite**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5
npm run typecheck 2>&1 | grep -iE "error TS" | head -5
npx vitest run 2>&1 | tail -5
```

Expected: green. A new union member will produce type errors anywhere a `switch` is exhaustive —
**those are the compiler telling you where the kind must be handled**, not noise to cast away.

- [ ] **Step 8: MUTATION-PROVE the intercept, because its failure is a dead process**

```bash
cd ~/git/tn3270
# Comment out the `if (msg.action.kind === 'toggleKeyboard') return;` line, rebuild, then:
npx vitest run packages/web/test/integration.test.ts 2>&1 | tail -5
#   EXPECTED: the SWALLOWED assertion FAILS -- and note WHAT it reports, because the real-world
#   symptom of this bug is a gateway that EXITS rather than a test that fails.
# Restore, rebuild, confirm green.
```

- [ ] **Step 9: Commit**

```bash
git add -A packages/frontend packages/canvas packages/web
git commit -m "feat: toggleKeyboard on Ctrl-B, with all four guards in one commit

protocol.ts's two-branch rule: a new action kind is either refused at decode
or intercepted in main.ts, in the SAME change. main.ts calls applyAction
outside any try in a socket data handler and applyAction throws on this kind
by design, so an unguarded one ends the gateway process rather than failing a
test -- which protocol.ts records a commit having done.

So this commit carries all four halves: the union member, the Ctrl-B mapping
in both mappers, the decode acceptance, the main.ts interception, and
integration.test.ts's SWALLOWED entry, which is where 'which branch was
taken' is asserted.

Ctrl-B was verified free against BINDING_INTENT and canvas/src/keys.ts's CTRL
table: the taken chords are C R U ] A D F K T.

Mutation-proved: removing the intercept turns the SWALLOWED assertion red.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: The web gateway's surface

**Files:**
- Create: `packages/web/src/keyboardOverlay.ts`
- Modify: `packages/web/src/bridge.ts`, `bridgecore.ts`, `static/index.html`
- Modify: `packages/gui/ui.css`
- Test: `packages/web/test/keyboardOverlay.test.ts`

- [ ] **Step 1: Read what you are generalising**

```bash
cd ~/git/tn3270
cat packages/web/src/keypadOverlay.ts
grep -n -A20 "createKeypadOverlay" packages/web/src/bridge.ts | head -30
```

`createKeypadOverlay` already owns: hidden at start, lazy first build, idempotent hide, and the
no-persistence rule for a reattaching client. **Keep all four.**

- [ ] **Step 2: Write the failing test**

Model it on `packages/web/test/keypadOverlay.test.ts` — same `fakeEl()` shape:

```ts
  it('starts hidden, builds once, and toggles', () => {
    const el = fakeEl();
    let built = 0;
    const o = createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => { built += 1; },
      onHide: () => {},
    });
    expect(el.hidden).toBe(true);
    o.toggle();
    expect(el.hidden).toBe(false);
    expect(built).toBe(1);
    o.toggle();
    o.toggle();
    expect(built, 'built lazily and then never again').toBe(1);
  });

  it('CALLS onHide WHEN IT CLOSES, which is how the one-shot Shift is disarmed', () => {
    const el = fakeEl();
    let hidden = 0;
    const o = createKeyboardOverlay({
      element: el as unknown as HTMLElement, build: () => {}, onHide: () => { hidden += 1; },
    });
    o.toggle();
    o.hide();
    expect(hidden).toBe(1);
  });
```

- [ ] **Step 3: Implement it, then wire `bridge.ts`**

`bridgecore.ts` gains `readonly toggleKeyboard?: () => void;` with a comment matching
`toggleKeypad`'s, and `sendAction` intercepts the kind client-side exactly as it does
`toggleKeypad`. `bridge.ts` creates the overlay, mounts `createKeyboardUi` lazily into it, and
**closes the keypad when the keyboard opens and vice versa** — two overlapping opaque overlays
would be unreadable.

**Mind the TDZ.** `bridge.ts` records that `transferBoot.ts` once shipped a blank page because a
`const` was read during a synchronous first render while still in its temporal dead zone, and
`optional chaining does not guard a TDZ`. Pass closures, do not read the other overlay's binding
eagerly.

`static/index.html` gains `<div id="keyboard-overlay" hidden></div>` **after** `<canvas id="screen">`,
matching where `#transfer-overlay` sits.

- [ ] **Step 4: The CSS, including the inert style**

In `packages/gui/ui.css`:

```css
/*
  THE FULL KEYBOARD, BOTTOM-DOCKED, because it cannot be anything else: the reference hardware is
  2.6:1 and about 24 key units across, so at a readable pitch it is as wide as a 24x80 screen.
  Corner-anchoring it is not an option the geometry allows.

  `position: fixed` LIKE THE OTHER TWO OVERLAYS, and load-bearing for the reason this file records
  above: the click path's `offsetX` arithmetic assumes the canvas sits at the viewport origin, and
  a sibling in normal flow would push it down and break the OTHER front end's clicks through the
  shared renderer.

  OPAQUE, like the keypad. `keypadOverlay.ts` records that opacity is load-bearing -- the TUI's
  keypad once let host text bleed into its chord column -- and 122 buttons over a 3270 screen is a
  denser background still.

  THE PITCH IS ONE CUSTOM PROPERTY so the layout scales from one edit, and the table's key units
  multiply by it.
*/
#keyboard-overlay {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  overflow: auto;
  background: Canvas;
  color: CanvasText;
  padding: 8px 10px;
  --kb-pitch: 30px;
  font-size: 11px;
}

#keyboard-overlay[hidden] { display: none; }

.keyboard-row { display: flex; gap: 2px; margin-bottom: 2px; }

/*
  AN INERT CAP, AND IT IS DELIBERATELY NOT THE HOUSE `opacity: 0.5`.

  That pattern is used three times in this file for DISABLED CONTROLS, and it means "not right now
  -- try again when a transfer finishes". An inert 3279 key means something different: "this exists
  on the hardware and will never do anything here". Same visual, two incompatible promises.

  AND THE LABEL MUST STAY READABLE, which is the functional reason rather than an aesthetic one:
  half the value of drawing `Cursr Sel` at all is seeing WHERE IT SITS on the hardware, and 0.5
  opacity on a small cap at this layout's font size could make `Print Screen` unreadable -- which
  defeats the faithfulness the whole surface exists for.

  The `disabled` ATTRIBUTE is still set by `keyboardUi.ts`, so clicks do nothing and keyboard and
  screen-reader behaviour are correct. Only the styling departs. DO NOT "fix" this into
  consistency with the rule above.
*/
#keyboard-overlay button[disabled] {
  color: GrayText;
  background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
  border-style: inset;
  opacity: 1;
}

/* The armed one-shot Shift, so the state is visible rather than remembered. */
#keyboard-overlay button[data-armed='true'] {
  border-style: inset;
  background: Highlight;
  color: HighlightText;
}
```

- [ ] **Step 5: Build and run the browser harness**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5
npx vitest run 2>&1 | tail -4
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/electron" >/dev/null 2>&1; sleep 3; exit 0
```

Expected: the existing phases still pass. This task adds no new phase; Task 7 does.

- [ ] **Step 6: Commit**

```bash
git add -A packages/web packages/gui/ui.css
git commit -m "feat(web): the full keyboard as a bottom-docked overlay on Ctrl-B

Generalises keypadOverlay.ts's four rules rather than writing a second copy:
hidden at start, lazy first build, idempotent hide, and no state inherited by
a reattaching client. Its new onHide is what disarms the one-shot Shift.

Opening one surface closes the other -- two overlapping opaque overlays would
be unreadable.

The inert-cap style is deliberately NOT the house opacity: 0.5, and the rule
says why at length: that pattern means 'not right now' and an inert 3279 key
means 'never', and 0.5 on a small cap at this font could make Print Screen
unreadable, which defeats the point of drawing it.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 6: The GUI's window

**Files:**
- Create: `packages/gui/keyboard.html`, `packages/gui/src/keyboardBoot.ts`
- Modify: `packages/gui/src/main.ts`

- [ ] **Step 1: Read the keypad window's three parts**

```bash
cd ~/git/tn3270
cat packages/gui/keypad.html
cat packages/gui/src/keypadBoot.ts
grep -n -B6 -A20 "toggleKeypad" packages/gui/src/main.ts | head -50
```

- [ ] **Step 2: Copy that shape for the keyboard**

`keyboard.html` mirrors `keypad.html` (same `ui.css` link, a `#keyboard-root`, the boot script).
`keyboardBoot.ts` mirrors `keypadBoot.ts`: build `createKeyboardUi` with a real-DOM `KeyboardDeps`
and send actions over the existing IPC channel.

**One real difference to get right:** `main.ts` must treat the keyboard window like the keypad
window for lifecycle — and `closing a parent skips the child close` is a recorded defect in this
file: Electron fires only `closed` on the child, so a guard that assumes `close` runs is bypassed.
**Read the keypad window's teardown and copy it exactly**, including whatever it does on the main
window's close.

Add a **View → Keyboard** menu item beside the existing keypad one, for the same discoverability
reason, and intercept `toggleKeyboard` in `main.ts` where `toggleKeypad` is intercepted at `:1028`.

- [ ] **Step 3: Build, typecheck, suite, then the GUI harnesses**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -5
npm run typecheck 2>&1 | grep -iE "error TS" | head -5
npx vitest run 2>&1 | tail -4
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2
pkill -9 -f "node_modules/electron" >/dev/null 2>&1; sleep 3; exit 0
```

- [ ] **Step 4: Commit**

```bash
git add -A packages/gui
git commit -m "feat(gui): a full-keyboard window on Ctrl-B, with a View menu item

Mirrors the keypad window's three parts. Its teardown copies the keypad's
exactly, because this file records that closing a parent skips the child's
close guard -- Electron fires only 'closed'.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 7: Harness cover, the gate, and the docs

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs`, `packages/gui/scripts/clicks.mjs`
- Modify: `docs/live-testing.md`, `docs/HANDOFF.md`, `README.md`

- [ ] **Step 1: Add a `keyboard` phase to `browser-clicks.mjs`**

Follow the existing keypad phase's design: **sample one key from EVERY region**, for the reason that
file already gives — *"so no block can go dead unseen"*. Assert, in a real browser:

1. `Ctrl-B` opens `#keyboard-overlay` (chord via `Input.dispatchKeyEvent`, `CDP_CTRL = 2`).
2. One actionable key per region (`pf`, `main`, `cursor`, `numpad`, and `Xfer` from
   `special-left`) reaches the gateway's log as the right action.
3. **An inert key sends NOTHING** — click `Esc` and assert the log is unchanged.
4. **The one-shot Shift works through the real DOM**: click `Shift`, click `2`, and assert the
   gateway logged `type @`; then click `2` again and assert `type 2`.
5. `Ctrl-K` closes the keyboard and opens the keypad.

Add its `TRANSFER_CHECKS`-style entry with a `mutant` naming what it kills. **`kind` must be
`'live'` only if nothing is injected** — the existing `progress` phase says `injected` because no
host sends its messages, and mislabelling overstates the evidence.

- [ ] **Step 2: Prove the new phase can fail**

```bash
cd ~/git/tn3270
# MUTANT: make an inert cap actionable (give `Esc` an action in keyboard3279.ts), rebuild, run.
npm run build >/dev/null 2>&1 && node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
pkill -9 -f "node_modules/electron" >/dev/null 2>&1; sleep 3
#   EXPECTED: the keyboard phase FAILS on the inert-key check. Restore, rebuild, re-verify.
```

- [ ] **Step 3: The full gate, serially, with a pkill between every browser run**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2; pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | tail -2;     pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/shot.mjs 2>&1 | tail -2;     pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3; pkill -9 -f node_modules/electron; sleep 3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -2
```

**`shot.mjs` AND `browser-shot.mjs` ARE THE ONES TO WATCH.** Neither golden contains an overlay, so
a diff means something leaked into the BASE page — report it and stop rather than regenerating.
**`browser-keys.mjs` matters too:** it asserts the ABSENCE of client-intercepted chords from the
gateway log, so `Ctrl-B` appearing there means the interception broke.

`drive-playback.py` and `drive-e.py` are **not** required: nothing here touches telnet negotiation
or the stream layer. Say so in the commit rather than leaving it implied.

- [ ] **Step 4: Record it**

`docs/live-testing.md`: a new entry stating that **no live host run was needed and why** — every
action this surface raises is one an existing keypad button or chord already raises, so nothing new
reaches the wire, and the inert keys raise nothing at all. State what is covered offline and what
is not: **the LAYOUT'S FIDELITY to the photograph is not machine-checkable**, and the legends that
could not be read are listed.

`docs/HANDOFF.md`: the surface, the chord, the two-surface arrangement, and **that the user may
drift to the keyboard alone** — *"if I find that I don't ever use the little keyboard then maybe we
drift towards A"* — so nothing may make the keypad hard to delete.

`README.md`: `Ctrl-B` beside `Ctrl-K` in the key table, and a sentence on the inert caps so an
operator is not puzzled by greyed keys.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test+docs: real-browser cover for the full keyboard, and the gate

The keyboard phase samples one key from EVERY region, for the reason the
keypad phase gives: so no region can go dead unseen. It also asserts the two
things only a real DOM can show -- an inert cap sends nothing, and the
one-shot Shift sends the shifted legend and then stops.

Mutation-proved by making an inert cap actionable.

No live host run was needed and live-testing.md says why: every action this
surface can raise is one an existing button or chord already raises, so
nothing new reaches the wire. drive-playback.py and drive-e.py were NOT run,
for the same reason.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `KEYBOARD_3279` parallel to `KEYPAD_KEYS`, key units, five regions | 1 |
| Legends from the photograph; unreadable ones inert and reported | 1 Steps 1, 4 |
| `KeypadKey.row`/`.col` deleted (now dead) | 2 |
| Alphanumerics via the existing `{kind:'type'}` | 1 Step 4 (`ch` helper) |
| ~8 inert caps DRAWN, not omitted | 1 (`dead` helper), tests in 1 and 3 |
| `Xfer` on one blank cap, other left blank | 1 Step 2 (test) |
| Inert styling NOT `opacity: 0.5`; label stays readable; `disabled` still set | 5 Step 4 (CSS), 3 Step 2 (the `disabled` test) |
| One-shot Shift, six rules, no-shiftLabel does not consume | 3 Steps 2, 4, 6 |
| Shift raises no action; disarms on close | 3 Step 2; 5 Step 2 (`onHide`) |
| Caps Lock inert | 1 (`dead`) |
| `Ctrl-B`, free, both front ends | 4 Step 3 |
| `toggleKeyboard` throws in `applyAction`; in neither key table | 4 Steps 2, 4; 1 Step 2 (test) |
| THE TWO-BRANCH RULE: decode + intercept + `SWALLOWED`, one commit | 4 Steps 5, 6, 8 |
| Bottom-docked, `position: fixed`, opaque | 5 Step 4 |
| Opening one closes the other | 5 Step 3 |
| TUI untouched | no task touches `packages/tui` except Task 7's pty-smoke RUN |
| Keypad stays easy to delete later | nothing in Tasks 1-6 modifies `keypadUi.ts` or `KEYPAD_BLOCKS` |
| Unit: overlap arithmetic, region membership, no forbidden actions | 1 Step 2 |
| Real browser: one key per region, inert sends nothing, Shift | 7 Step 1 |
| Mutation proof on the intercept and on an inert cap | 4 Step 8, 7 Step 2 |
| Goldens must still match | 7 Step 3 |
| No live run needed, stated explicitly | 7 Steps 3, 4 |
