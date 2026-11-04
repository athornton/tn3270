# Oversize, `IBM-DYNAMIC` and Local Model-Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator choose a screen larger than the model's (`-oversize <cols>x<rows> | auto | none`), advertise it as `IBM-DYNAMIC`, and change model and oversize while disconnected, taking effect at the next connect.

**Architecture:** A pure `core/src/geometry.ts` resolves model + oversize (+ a front end's measure function for `auto`) into a terminal type and two screen sizes. `Session` holds that setting instead of fixing geometry at construction, and resolves it at the top of every `connect()` (so `reconnect()` too), resizing its existing `Screen` in place. Front ends add the flag, a measure function, and (step 2) a picker.

**Tech Stack:** TypeScript 7 (strict, `exactOptionalPropertyTypes`), vitest (node env, no DOM), Electron 44, a hand-rolled WebSocket gateway, Python pty/telnet harnesses.

**Spec:** `docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md`. **Read it first.**

---

## READ THIS BEFORE ANY TASK

1. **The source beats this plan.** Every code block below is a DRAFT written from a reading of the
   repo on 2026-11-04. This project has measured that plan code is wrong often (13 of ~17 defects in
   one earlier stage were in the plan's literal code). Before writing a step, open the file you are
   changing, read the code AND the comments around the lines you touch, and adapt. If the plan and
   the source disagree, the source wins, and you say so in your report.
2. **Every test must fail first, for the stated reason.** Run it, read the failure, confirm it is
   the failure the step predicts and not an import error.
3. **Mutation-check what matters.** Where a step says *mutation-check*, break the line it names,
   confirm a test goes red, restore it. Report the result.
4. **Gate after each task:** `npm run build && npm run typecheck && npm test`. `typecheck` checks
   the tests too, since `3bc3257` on `typecheck-tests`. **If that branch is not yet merged into
   `oversize`, merge it first** (`git merge typecheck-tests`); it is a fast-forward-able branch off
   `main` and this plan assumes test files are typechecked.
5. **Never `pkill -f electron`** from Bash; it matches its own shell. Clean up by PID.
6. Commit messages end with:
   ```
   Generated with AI

   Co-Authored-By: SLAC AI
   ```
7. **Size order:** the FLAG is `<cols>x<rows>` (x3270's order, `model.c:343`). New MESSAGES name
   sizes in words, `62 rows by 160 columns`. Internally everything is `{ rows, cols }`.

## AMENDED AFTER TASK 1 (2026-11-04) -- READ BEFORE TASKS 2-15

Task 1's review changed `geometry.ts`'s API. **The code blocks in Tasks 2-15 still show the old
shape; translate them.**

- `measure` is NOT a field of `GeometrySetting`. It is `resolveGeometry(setting, measure?)`'s second
  argument. `GeometrySetting` is plain data (`model`, `terminalType`, `oversize`) so that
  `setGeometry(next)` and the web `setGeometry` message cannot drop it. **So `Session` takes the
  measure function as its own option, `SessionOptions.measure`, kept for the session's lifetime,
  and `defaultSession`'s geometry options object carries `{ setting, measure }`.**
- `ResolvedGeometry.oversize` (boolean) is renamed **`dynamic`**.
- An oversize on a model WITHOUT `-E` is REFUSED (`OversizeError`). Wherever a task below shows
  `-model 3278-2` with an oversize, use `3278-2-E`.
- Messages: parse refusal is `-oversize takes <cols>x<rows>, auto or none, not "..."`; the cell
  limit is `oversize CxR refused: use at most 16383 cells -- that is N`.
- `measure()` output is validated in `geometry.ts` (positive integers, else "no window size
  known"), so front-end measures need not clamp, but must still return integers.

Read `packages/core/src/geometry.ts` itself before starting any task; it is the source.

## File map

| File | Change |
|---|---|
| `packages/core/src/geometry.ts` | **new**: `Oversize`, `GeometrySetting`, `parseOversize`, `resolveGeometry`, `describeSize` |
| `packages/core/src/index.ts` | export `geometry.js` |
| `packages/core/src/termtype.ts` | comment update only (the out-of-scope note) |
| `packages/core/src/session.ts` | `geometry`/`measure` options, `setGeometry`, `geometrySetting`, `lastGeometryNotice`, resolve in `connect()`, `'geometry'` event, mutable `modelAlternate`, resolved terminal type for telnet and TN3270E |
| `packages/core/test/geometry.test.ts` | **new** |
| `packages/core/test/oversize-session.test.ts` | **new**: Session-level behaviour |
| `packages/frontend/src/session.ts` | `defaultSession` takes a trailing `geometry` options object |
| `packages/frontend/src/oversizeFlag.ts` | **new**: shared `-oversize` flag parse + the `--terminal-type` conflict check |
| `packages/frontend/src/actions.ts`, `keymap.ts`, `bindings.ts` | `geometryMenu` action kind (step 2) |
| `packages/cli/src/main.ts`, `runner.ts`, `commands.ts` | `-oversize`, `Set(...)` |
| `packages/tui/src/main.ts`, `app.ts` | `-oversize`, terminal measure, resize notice |
| `packages/gui/src/args.ts`, `main.ts`, `menu.ts` | `-oversize`, display measure, Model menu |
| `packages/web/src/args.ts`, `main.ts`, `protocol.ts`, `bridgecore.ts`, `bridge.ts`, `geometryOverlay.ts` (**new**), `static/index.html`, `packages/gui/ui.css` | `-oversize`, viewport, picker overlay |
| `packages/canvas/src/keys.ts` | `Alt-M` |
| `packages/cli/scripts/e-server.py` | `--query` flag: send Read Partition Query and log the reply |
| `packages/tui/scripts/pty-smoke.py` | oversize-auto + resize checks |
| `README.md`, `docs/HANDOFF.md`, `docs/live-testing.md` | docs |

---

# STEP 1 — oversize and `IBM-DYNAMIC`

### Task 1: `core/src/geometry.ts`, the pure resolver

**Files:**
- Create: `packages/core/src/geometry.ts`
- Modify: `packages/core/src/index.ts` (add `export * from './geometry.js';` after `termtype.js`)
- Modify: `packages/core/src/termtype.ts:40-44` (comment)
- Test: `packages/core/test/geometry.test.ts`

Reads `KNOWN_MODELS`/`lookUpModel` semantics from `termtype.ts`: reuse `resolveTerminalType` and
`resolveAlternateSize` rather than re-implementing the model table.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  parseOversize, resolveGeometry, describeSize, MAX_OVERSIZE_CELLS, OversizeError,
} from '../src/geometry.js';

describe('parseOversize', () => {
  it('reads <cols>x<rows>, x3270 order, so 160x62 is 62 rows by 160 columns', () => {
    expect(parseOversize('160x62')).toEqual({ kind: 'fixed', rows: 62, cols: 160 });
    expect(parseOversize('132X27')).toEqual({ kind: 'fixed', rows: 27, cols: 132 });
  });
  it('reads auto and none, case-free', () => {
    expect(parseOversize('AUTO')).toEqual({ kind: 'auto' });
    expect(parseOversize('none')).toEqual({ kind: 'none' });
  });
  it.each(['', '80', '80x', 'x24', '80x24x1', '80 x 24', '-80x24', '80.5x24', '0x24', '80x0'])(
    'refuses %j with the expected form in the message', (bad) => {
      expect(() => parseOversize(bad)).toThrow(OversizeError);
      expect(() => parseOversize(bad)).toThrow(/<cols>x<rows>, auto or none/);
    });
});

describe('resolveGeometry, none', () => {
  it('is the model, unchanged: its terminal type and its alternate', () => {
    const g = resolveGeometry({ model: '3278-4-E', oversize: { kind: 'none' } });
    expect(g).toEqual({
      terminalType: 'IBM-3278-4-E', default: { rows: 24, cols: 80 },
      alternate: { rows: 43, cols: 80 }, oversize: false,
    });
  });
  it('with no model is the product default, IBM-3278-2-E at 24x80', () => {
    const g = resolveGeometry({ oversize: { kind: 'none' } });
    expect(g.terminalType).toBe('IBM-3278-2-E');
    expect(g.alternate).toEqual({ rows: 24, cols: 80 });
  });
  it('passes a raw --terminal-type through and keeps 24x80, as resolveAlternateSize does', () => {
    const g = resolveGeometry({ terminalType: 'IBM-3279-5', oversize: { kind: 'none' } });
    expect(g.terminalType).toBe('IBM-3279-5');
    expect(g.alternate).toEqual({ rows: 24, cols: 80 });
  });
});

describe('resolveGeometry, fixed', () => {
  it('is IBM-DYNAMIC with the oversize as the alternate, default still 24x80', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } });
    expect(g).toEqual({
      terminalType: 'IBM-DYNAMIC', default: { rows: 24, cols: 80 },
      alternate: { rows: 62, cols: 160 }, oversize: true,
    });
  });
  it('is IBM-DYNAMIC even for a model without -E, as x3270 (telnet.c:2100)', () => {
    expect(resolveGeometry({ model: '3278-2', oversize: { kind: 'fixed', rows: 30, cols: 100 } })
      .terminalType).toBe('IBM-DYNAMIC');
  });
  it('accepts exactly the model size and exactly 16383 cells', () => {
    expect(resolveGeometry({ model: '3278-4', oversize: { kind: 'fixed', rows: 43, cols: 80 } })
      .alternate).toEqual({ rows: 43, cols: 80 });
    expect(MAX_OVERSIZE_CELLS).toBe(0x3fff);
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 127, cols: 129 } }))
      .not.toThrow(); // 16383
  });
  it('refuses fewer columns than the model, remedy first', () => {
    expect(() => resolveGeometry({ model: '3278-5', oversize: { kind: 'fixed', rows: 30, cols: 100 } }))
      .toThrow(/^oversize 100x30 refused: use at least 132x27 -- model 3278-5 is 27 rows by 132 columns$/);
  });
  it('refuses fewer rows than the model', () => {
    expect(() => resolveGeometry({ model: '3278-4', oversize: { kind: 'fixed', rows: 40, cols: 100 } }))
      .toThrow(/use at least 80x43/);
  });
  it('refuses more than 16383 cells, naming the limit', () => {
    expect(() => resolveGeometry({ oversize: { kind: 'fixed', rows: 128, cols: 128 } }))
      .toThrow(/^oversize 128x128 refused: 16384 cells is more than the 16383 a 14-bit address reaches$/);
  });
  it('refuses oversize together with --terminal-type', () => {
    expect(() => resolveGeometry({ terminalType: 'IBM-3278-2', oversize: { kind: 'fixed', rows: 30, cols: 80 } }))
      .toThrow(/-oversize and --terminal-type cannot both be given/);
  });
});

describe('resolveGeometry, auto', () => {
  const auto = { kind: 'auto' } as const;
  it('takes exactly what fits, not a snapped size', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto, measure: () => ({ rows: 50, cols: 133 }) });
    expect(g.alternate).toEqual({ rows: 50, cols: 133 });
    expect(g.terminalType).toBe('IBM-DYNAMIC');
    expect(g.notice).toBeUndefined();
  });
  it('falls back to the model when the window is too small, and says so', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto, measure: () => ({ rows: 22, cols: 80 }) });
    expect(g).toMatchObject({ terminalType: 'IBM-3278-2-E', alternate: { rows: 24, cols: 80 }, oversize: false });
    expect(g.notice).toBe('oversize auto: window fits 22 rows by 80 columns, less than model '
      + '3278-2-E\'s 24 rows by 80 columns; using the model');
  });
  it('falls back when nothing can be measured yet', () => {
    const g = resolveGeometry({ model: '3278-2-E', oversize: auto, measure: () => undefined });
    expect(g.oversize).toBe(false);
    expect(g.notice).toBe('oversize auto: no window size known; using the model');
  });
  it('cuts rows past 16383 cells, keeping the width, and notes it as a clamp', () => {
    const g = resolveGeometry({ oversize: auto, measure: () => ({ rows: 200, cols: 200 }) });
    expect(g.alternate).toEqual({ rows: 81, cols: 200 }); // floor(16383 / 200)
    expect(g.clamp).toBe('oversize auto: window fits 200 rows by 200 columns; cut to 81 rows, the 14-bit address limit');
  });
  it('refuses auto with no measure function, asking for a fixed size', () => {
    expect(() => resolveGeometry({ oversize: auto }))
      .toThrow(/^oversize auto needs a window to measure; give -oversize <cols>x<rows> instead$/);
  });
});

describe('describeSize', () => {
  it('says rows and columns in words', () => {
    expect(describeSize({ rows: 62, cols: 160 })).toBe('62 rows by 160 columns');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/core/test/geometry.test.ts`
Expected: FAIL, `Cannot find module '../src/geometry.js'`.

- [ ] **Step 3: Implement `geometry.ts`**

```ts
import { MODEL_2 } from './constants.js';
import { resolveTerminalType, resolveAlternateSize, type TerminalTypeOptions } from './termtype.js';

/**
 * Oversize: an alternate screen larger than the model's, and the geometry a session negotiates.
 *
 * An emulator extension, not 3270 architecture -- see the spec,
 * docs/superpowers/specs/2026-11-04-oversize-and-model-switching-design.md. The rules are
 * x3270's: `ctlr.c:check_rows_cols` for the limits, `telnet.c:2100` for IBM-DYNAMIC.
 *
 * PURE. The measure function is the caller's; nothing here touches a window or a session.
 */

/** x3270's MAX_ROWS_COLS (include/3270ds.h:456): the cells a 14-bit address reaches. */
export const MAX_OVERSIZE_CELLS = 0x3fff;

export type Oversize =
  | { readonly kind: 'none' }
  | { readonly kind: 'fixed'; readonly rows: number; readonly cols: number }
  | { readonly kind: 'auto' };

export interface Size { readonly rows: number; readonly cols: number }

/** What the operator asked for. `measure` is the front end's, consulted only for `auto`. */
export interface GeometrySetting extends TerminalTypeOptions {
  readonly oversize: Oversize;
  /** Cells the front end can show right now, or undefined if it cannot tell yet. */
  readonly measure?: () => Size | undefined;
}

export interface ResolvedGeometry {
  readonly terminalType: string;
  readonly default: Size;
  readonly alternate: Size;
  /** True when an oversize is in effect, i.e. the terminal type is IBM-DYNAMIC. */
  readonly oversize: boolean;
  /** For the operator: an `auto` that fell back to the model. */
  readonly notice?: string;
  /** For the trace only: an `auto` cut to the 14-bit limit. */
  readonly clamp?: string;
}

export class OversizeError extends Error {
  constructor(message: string) { super(message); this.name = 'OversizeError'; }
}

export function describeSize(s: Size): string {
  return `${s.rows} rows by ${s.cols} columns`;
}

const FORM = 'use <cols>x<rows>, auto or none';

export function parseOversize(text: string): Oversize {
  const t = text.trim().toLowerCase();
  if (t === 'none') return { kind: 'none' };
  if (t === 'auto') return { kind: 'auto' };
  const m = /^([0-9]+)x([0-9]+)$/.exec(t);
  if (m === null) throw new OversizeError(`-oversize ${JSON.stringify(text)}: ${FORM}`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  if (cols === 0 || rows === 0) throw new OversizeError(`-oversize ${text}: zero is not a size; ${FORM}`);
  return { kind: 'fixed', rows, cols };
}

export function resolveGeometry(setting: GeometrySetting): ResolvedGeometry {
  const typeOpts: TerminalTypeOptions = {
    ...(setting.model !== undefined ? { model: setting.model } : {}),
    ...(setting.terminalType !== undefined ? { terminalType: setting.terminalType } : {}),
  };
  const modelTtype = resolveTerminalType(typeOpts);
  const modelAlt = resolveAlternateSize(typeOpts) ?? MODEL_2;
  const def = { rows: MODEL_2.rows, cols: MODEL_2.cols };
  const plain: ResolvedGeometry = { terminalType: modelTtype, default: def, alternate: modelAlt, oversize: false };
  const modelName = setting.model ?? modelTtype.replace(/^IBM-/, '');

  const o = setting.oversize;
  if (o.kind === 'none') return plain;
  if (setting.terminalType !== undefined) {
    throw new OversizeError('-oversize and --terminal-type cannot both be given: an oversize '
      + 'is advertised as IBM-DYNAMIC');
  }

  if (o.kind === 'fixed') {
    const asked = `${o.cols}x${o.rows}`;
    if (o.rows * o.cols > MAX_OVERSIZE_CELLS) {
      throw new OversizeError(`oversize ${asked} refused: ${o.rows * o.cols} cells is more than `
        + `the ${MAX_OVERSIZE_CELLS} a 14-bit address reaches`);
    }
    if (o.rows < modelAlt.rows || o.cols < modelAlt.cols) {
      throw new OversizeError(`oversize ${asked} refused: use at least ${modelAlt.cols}x${modelAlt.rows} `
        + `-- model ${modelName} is ${describeSize(modelAlt)}`);
    }
    return { terminalType: 'IBM-DYNAMIC', default: def, alternate: { rows: o.rows, cols: o.cols }, oversize: true };
  }

  if (setting.measure === undefined) {
    throw new OversizeError('oversize auto needs a window to measure; give -oversize <cols>x<rows> instead');
  }
  const fits = setting.measure();
  if (fits === undefined) {
    return { ...plain, notice: 'oversize auto: no window size known; using the model' };
  }
  if (fits.rows < modelAlt.rows || fits.cols < modelAlt.cols) {
    return { ...plain, notice: `oversize auto: window fits ${describeSize(fits)}, less than model `
      + `${modelName}'s ${describeSize(modelAlt)}; using the model` };
  }
  if (fits.rows * fits.cols > MAX_OVERSIZE_CELLS) {
    const rows = Math.floor(MAX_OVERSIZE_CELLS / fits.cols);
    // A very wide window can clamp BELOW the model's rows (past 682 columns for a model 2). That
    // is the same outcome as a window too small: the model is the floor.
    if (rows < modelAlt.rows) {
      return { ...plain, notice: `oversize auto: window fits ${describeSize(fits)}, too wide to `
        + `keep model ${modelName}'s ${modelAlt.rows} rows inside ${MAX_OVERSIZE_CELLS} cells; using the model` };
    }
    return {
      terminalType: 'IBM-DYNAMIC', default: def, alternate: { rows, cols: fits.cols }, oversize: true,
      clamp: `oversize auto: window fits ${describeSize(fits)}; cut to ${rows} rows, the 14-bit address limit`,
    };
  }
  return { terminalType: 'IBM-DYNAMIC', default: def, alternate: fits, oversize: true };
}
```

**Check against the source before keeping it:**
- `resolveTerminalType` throws `TerminalTypeError` for an unknown model; that must propagate unchanged.
- The clamp case: a measured width alone could exceed 16383 (`cols > 16383`, rows 1). That cannot
  pass the model floor (rows >= 24), so `rows` above is always >= 1 — confirm, and add a test if you
  find otherwise.
- The too-wide fallback above needs its own test: `measure: () => ({ rows: 30, cols: 700 })` ->
  `oversize: false`, notice matching `/too wide/`. Add it to the `auto` block.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run packages/core/test/geometry.test.ts` → PASS.

- [ ] **Step 5: Update the `termtype.ts:40-44` comment.** Replace "Both are deliberately out of
  scope here." with a pointer: oversize and IBM-DYNAMIC now live in `geometry.ts`, which builds on
  this table; this table stays the models only.

- [ ] **Step 6: Mutation-check.** Change `o.rows * o.cols > MAX_OVERSIZE_CELLS` to `>=`; the
  16383-accepted test must fail. Restore. Change `||` to `&&` in the fixed floor check; one of the
  two floor tests must fail. Restore.

- [ ] **Step 7: Gate and commit.**
```bash
npm run build && npm run typecheck && npm test
git add packages/core/src/geometry.ts packages/core/src/index.ts packages/core/src/termtype.ts packages/core/test/geometry.test.ts
git commit -m "core: geometry.ts resolves model and oversize into a terminal type and two sizes"
```

---

### Task 2: `Session` resolves geometry at every connect

**Files:**
- Modify: `packages/core/src/session.ts` (options ~`:40-70`, fields ~`:255-285`, constructor `:342-359`, `connect()` `:573`, telnet layer build `:620`, `handleTn3270eSubneg` `:1007`, `SessionEvent` `:162`)
- Test: `packages/core/test/oversize-session.test.ts`

**Design, re-derived from the source:**
- `SessionOptions` gains `geometry?: GeometrySetting`. When it is given, the existing `terminalType`
  / `alternateRows` / `alternateCols` options must be ABSENT (throw `Error` in the constructor if
  both are given — the front ends will pass only `geometry`). When it is absent, the session behaves
  exactly as today: every existing test constructs sessions the old way and must pass untouched.
- New private `setting: GeometrySetting | undefined` (undefined = legacy options mode).
- `modelAlternate` loses `readonly`; its field comment gains one paragraph: it is the RESOLVED
  alternate for the current connection, set at connect, because x3270's `maxROWS` is the oversize
  when one is set (`ctlr.c:334`). UNBIND and BIND both read it, so both now honour the oversize with
  no change of their own — that is the point.
- New private `ttype: string | undefined` — the resolved terminal type for this connection. Both
  places that read `this.opts.terminalType` (`:620` and `:1007`) read `this.ttype ?? this.opts.terminalType`
  instead. `replay()` (`~:1641`) does not pass a terminal type and is left alone.
- At construction in geometry mode: the screen is the model's geometry (resolve with
  `{ ...setting, oversize: { kind: 'none' } }`), NEVER `auto`'s, per the spec.
- At the top of `connect()`, BEFORE `this.disconnect()` tears anything down and before
  `this.target` is set: if in geometry mode, `const g = resolveGeometry(this.setting)` — a throw
  propagates out of `connect()` with no socket opened and `target` unchanged. Then, **only if
  `g.alternate` or `g.terminalType` differs from what the previous connect resolved**:
  `this.screen.setSizes(g.default, g.alternate); this.screen.useDefaultSize(); this.screen.clear();`
  and `this.modelAlternate = g.alternate; this.ttype = g.terminalType;`. When nothing changed the
  screen is left exactly as today's `connect()` leaves it, because Tasks 5-8 put EVERY front end in
  geometry mode (so the pickers in step 2 work without `-oversize`), and a reconnect at an unchanged
  geometry must not start blanking the screen everywhere. Always: note `g.notice`/`g.clamp` to the
  trace, keep `g.notice` in a new public getter `lastGeometryNotice` (cleared to undefined when
  there is none), and `this.emit('geometry')`.
  **Check:** `reconnect()` calls `connect()`, so it re-resolves for free. Confirm by reading.
- `SessionEvent` gains `'geometry'`.
- `setGeometry(next: GeometrySetting)`: throws `Error('disconnect first; model and oversize apply at
  the next connect')` if `this.conn !== undefined || this.reconnecting`; throws if the session was
  built in legacy mode; validates eagerly by calling `resolveGeometry` with `oversize: none` swapped
  in when `next.oversize.kind === 'auto'` (so a bad model is refused at set time, not at the next
  Enter) and with the real oversize otherwise; then stores it. Does NOT touch the screen.
- `geometrySetting` getter returns the current setting (for the GUI/web pickers to show the
  current choice).

- [ ] **Step 1: Write the failing tests** (copy `FakeConnection`/`negotiate`/`negotiatedName`
  from `packages/core/test/session.test.ts:9-37,1240-1252` — read them there, do not retype from here)

```ts
describe('oversize through a Session', () => {
  const fixed = (rows: number, cols: number) => ({ kind: 'fixed', rows, cols }) as const;

  it('negotiates IBM-DYNAMIC and starts at 24x80 with the oversize as the alternate', async () => {
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn,
      geometry: { model: '3278-2-E', oversize: fixed(62, 160) } });
    await session.connect('h', 23);
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    expect(negotiatedName(conn)).toBe('IBM-DYNAMIC');
    expect([session.screen.rows, session.screen.cols]).toEqual([24, 80]);
    expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
  });

  it('EWA switches to the oversize, and an address past 4096 cells is writable', async () => {
    // build as above, then conn.negotiate(); conn.host(Cmd.EWA, 0x00, T.IAC, T.EOR);
    // expect 62x160 and session.screen.setChar(9000, 0xc1) not to throw.
  });

  it('a too-small fixed oversize rejects connect() and opens no socket', async () => {
    let dialled = 0;
    const session = new Session({ connect: () => { dialled++; return new FakeConnection(); },
      geometry: { model: '3278-4', oversize: fixed(30, 80) } });
    await expect(session.connect('h', 23)).rejects.toThrow(/use at least 80x43/);
    expect(dialled).toBe(0);
  });

  it('auto measures at connect, and again at reconnect', async () => {
    let size = { rows: 40, cols: 100 };
    const conn = new FakeConnection();
    const session = new Session({ connect: () => conn,
      geometry: { oversize: { kind: 'auto' }, measure: () => size } });
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 }); // not measured at construction
    await session.connect('h', 23);
    expect(session.screen.alternateSize).toEqual({ rows: 40, cols: 100 });
    conn.close();
    size = { rows: 50, cols: 132 };
    await session.reconnect();
    expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 });
  });

  it('emits geometry on connect and keeps an auto fallback notice', async () => {
    // auto with measure () => ({rows: 20, cols: 80}); listen for 'geometry'; after connect the
    // listener ran once and session.lastGeometryNotice matches /using the model/.
  });

  it('setGeometry is refused while connected and accepted after', async () => {
    // connect; expect(() => session.setGeometry({...})).toThrow(/^disconnect first/);
    // conn.close(); session.setGeometry({ model: '3278-4-E', oversize: { kind: 'none' } });
    // await session.reconnect(); EWA -> 43x80; negotiatedName -> 'IBM-3278-4-E'.
  });

  it('a reconnect at an UNCHANGED geometry leaves the screen as it was, as today', async () => {
    // geometry {model:'3278-2-E', oversize:{kind:'none'}}; connect; negotiate; write a 'C1' at 0 with
    // the Erase/Write record session.test.ts uses; conn.close(); reconnect;
    // expect(session.screen.cellAt(0).ebcdic).toBe(0xc1).
  });

  it('setGeometry refuses an unknown model at set time, not at the next connect', () => {
    // expect(() => session.setGeometry({ model: '3278-9', oversize: { kind: 'none' } })).toThrow(/unknown model/);
  });

  it('refuses geometry together with the legacy terminalType option', () => {
    expect(() => new Session({ connect: () => new FakeConnection(), terminalType: 'X',
      geometry: { oversize: { kind: 'none' } } })).toThrow();
  });
});
```

Fill in the bodies marked as comments with real code in the style of the first test. Every
assertion in the comments is required.

- [ ] **Step 2: Run, verify each fails for the right reason** (`geometry` is not a known option /
  wrong terminal type), not for a typo.

- [ ] **Step 3: Implement** per the design above. Keep the edits minimal and next to the code they
  belong with; add field comments in the file's existing register (it explains *why*, at length).

- [ ] **Step 4: Run the new file, then the whole core suite.** All of `packages/core/test` must pass
  unchanged — the legacy path is untouched.

- [ ] **Step 5: Mutation-check.** (a) Resolve at construction instead of in `connect()`: the
  reconnect-remeasures test must fail. (b) Leave `:1007` reading `this.opts.terminalType`: Task 3's
  TN3270E test will catch it — note it and re-check after Task 3. (c) Move the resolve below
  `this.target = ...`: add an assertion that a refused connect leaves `reconnect()` throwing `No
  previous host` and confirm it fails under the mutation.

- [ ] **Step 6: Gate and commit.**
```bash
git commit -m "core: Session resolves model and oversize at every connect, and advertises IBM-DYNAMIC"
```

---

### Task 3: the wire — TN3270E device type, Query Reply, BIND, UNBIND

**Files:**
- Test: `packages/core/test/oversize-session.test.ts` (append)
- Modify: `packages/core/src/session.ts` only if a test finds a gap

These are the spec's claims that "no new code is needed". **Prove each one.**

- [ ] **Step 1: Write the tests.** Copy the TN3270E `FakeConnection` with `sb`/`negotiateE`, `bindRecord`,
  `unbindRecord`, `bindBody`, `GRANT_BIND_IMAGE` from `packages/core/test/tn3270e-session.test.ts`
  (`:13-50`, `:501-525`) and the `QUERY`/`lastRecord`/`units` helpers from `session.test.ts:851-873` and
  `queryreply.test.ts:15-30`. Tests:

  1. **TN3270E DEVICE-TYPE REQUEST carries `IBM-DYNAMIC`.** Expect the bytes
     `[T.IAC, T.SB, O.TN3270E, Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST, ...ascii('IBM-DYNAMIC'), T.IAC, T.SE]`
     (mirror `tn3270e-session.test.ts:73-74`).
  2. **Query Reply reports the oversize.** Fixed 62x160, connect, negotiate, send `QUERY`; in the
     reply's Usable Area unit (`Qcode.USABLE_AREA`, 0x81) bytes 6-9 after the unit start are
     `u16(160), u16(62)`; in Implicit Partition (0xA6) the WA/HA pair is `160, 62` and WD/HD is
     `80, 24`. **Find the exact offsets in `queryreply.ts:205-320` and `queryreply.test.ts`, not here.**
  3. **14-bit addressing in our inbound data above 4096 cells.** EWA to 62x160, then
     `session.screen.cursor = 5000` (or the setter the screen really has — check `screen.ts`) and
     `sendAID(AID.ENTER)`; the cursor address bytes are `(5000 >> 8) & 0x3f, 5000 & 0xff`
     (`address.ts:50-51`), i.e. NOT the 12-bit code-table form.
  4. **A `0x03` BIND gives the oversize** (RFC 2355's prescribed BIND for IBM-DYNAMIC): fixed 62x160,
     `negotiateE(GRANT_BIND_IMAGE)`, `bindRecord(bindBody(0x03))` -> `alternateSize` `{62,160}`.
  5. **A `0x7f` BIND within the oversize is accepted** (`bindBody(0x7f, 24, 80, 50, 132)` -> 50x132),
     **one past it is refused** with the trace phrase `BIND alternate 63x160 exceeds model 62x160`
     (read `acceptBindDims`'s exact wording at `bind.ts:269-294`).
  6. **UNBIND reverts to the oversize**, not to 24x80: BIND to 50x132, UNBIND, alternate is 62x160.
  7. **Each connect resets what UNBIND reverts to**: connect with oversize, close, `setGeometry` to
     model 2 none, reconnect, BIND 0x03 -> 24x80.

- [ ] **Step 2: Run.** If all pass first time, that is the expected outcome for 2-6 — but then you
  must **prove they can fail**: for each, name the mutation you made (e.g. Query: make
  `answerQuery` pass `MODEL_2` as the alternate; BIND: make `modelSize()` return `MODEL_2`) and the
  test that went red. Test 1 must fail before Task 2's `:1007` change if you revert it — re-run the
  mutation from Task 2 Step 5(b) now.

- [ ] **Step 3: Gate and commit.**
```bash
git commit -m "core: prove the wire for oversize -- TN3270E device type, Query Reply, 14-bit, BIND 0x03, UNBIND"
```

---

### Task 4: the shared flag, and `defaultSession`

**Files:**
- Create: `packages/frontend/src/oversizeFlag.ts`
- Modify: `packages/frontend/src/session.ts`, `packages/frontend/src/index.ts`
- Test: `packages/frontend/test/oversizeFlag.test.ts`, `packages/frontend/test/session.test.ts` (create if absent — check)

Four front ends parse `-oversize` and must agree: one parser, in `frontend`, the package that
exists to hold rules the front ends share (`gui/src/args.ts:9-12` says so).

- [ ] **Step 1: Tests.**
```ts
import { describe, it, expect } from 'vitest';
import { takeOversizeFlag } from '../src/oversizeFlag.js';

describe('takeOversizeFlag', () => {
  const err = (m: string) => new Error(m);
  it('consumes -oversize and its value', () => {
    const out: { oversize?: unknown } = {};
    expect(takeOversizeFlag(out, '-oversize', '160x62', err)).toBe(1);
    expect(out.oversize).toEqual({ kind: 'fixed', rows: 62, cols: 160 });
  });
  it('ignores other flags', () => {
    expect(takeOversizeFlag({}, '-model', '3278-2', err)).toBeUndefined();
  });
  it('needs a value', () => {
    expect(() => takeOversizeFlag({}, '-oversize', undefined, err))
      .toThrow('-oversize needs a value: <cols>x<rows>, auto or none');
  });
  it('turns a bad value into the caller\'s usage error', () => {
    expect(() => takeOversizeFlag({}, '-oversize', '80', (m) => new RangeError(m))).toThrow(RangeError);
  });
});
```
  Mirror `takeTlsFlag`'s contract (read it in `frontend/src/tls.ts`): returns the number of EXTRA
  argv entries eaten, or `undefined` if the flag is not its own.

- [ ] **Step 2: Fail, implement, pass.**
```ts
import { parseOversize, OversizeError, type Oversize } from '@tn3270/core';

export const OVERSIZE_USAGE = '[-oversize <cols>x<rows>|auto|none]';

export function takeOversizeFlag(
  out: { oversize?: Oversize }, flag: string, value: string | undefined,
  usage: (message: string) => Error,
): number | undefined {
  if (flag !== '-oversize') return undefined;
  if (value === undefined) throw usage('-oversize needs a value: <cols>x<rows>, auto or none');
  try { out.oversize = parseOversize(value); } catch (e) {
    if (e instanceof OversizeError) throw usage(e.message);
    throw e;
  }
  return 1;
}
```

- [ ] **Step 3: `defaultSession` gains a trailing options parameter** — the positional list is
  already eight long; do not add a ninth positional. Read `frontend/src/session.ts` in full first.

```ts
  ddm?: boolean,
  /**
   * Model and oversize, resolved by the SESSION at every connect. When given, the `terminalType`
   * and `alternate` arguments above must be undefined -- the front ends pass one or the other.
   */
  geometry?: GeometrySetting,
): Session {
  return new Session({
    ...,
    ...(geometry === undefined ? {} : { geometry }),
  });
}
```
  Test: `defaultSession(undefined, {kind:'plaintext'}, undefined, ..., { model: '3278-4-E', oversize: {kind:'none'} })`
  yields a session whose `geometrySetting.model` is `'3278-4-E'`. (No socket: do not connect.)

- [ ] **Step 4: Export both from `frontend/src/index.ts`. Gate, commit.**
```bash
git commit -m "frontend: one -oversize parser for every front end; defaultSession takes a geometry setting"
```

---

### Task 5: CLI `-oversize`

**Files:** `packages/cli/src/main.ts`, `packages/cli/test/main.test.ts`

- [ ] **Step 1: Test** (read `main.test.ts` for how `parseArgs` is tested): `parseArgs(['-oversize',
  '160x62', 'h'])` gives `oversize: {kind:'fixed', rows:62, cols:160}`; `-oversize 80` throws
  `UsageError`; `-oversize 160x62 --terminal-type X` throws `UsageError` matching `/cannot both be given/`
  — do this check in `parseArgs` by calling `resolveGeometry({ terminalType, oversize })` only for
  that pair, or by a direct check; pick the one that keeps the message identical to `geometry.ts`'s.
- [ ] **Step 2: Implement.** In `parseArgs` call `takeOversizeFlag` next to `takeTlsFlag`, and add
  `OVERSIZE_USAGE` to the usage line. In `main()`: **unless `--terminal-type` was given**, pass
  `geometry: { model, oversize: args.oversize ?? {kind:'none'} }` to `defaultSession` and leave
  `terminalType`/`alternate` undefined; with `--terminal-type`, keep today's call exactly. This is
  the rule for EVERY front end (Tasks 6-8 too): geometry mode is the normal path, the legacy options
  survive only for a raw terminal type. Confirm `conformance-vm.txt:14-18` still holds: `-model
  3278-2` must still send `IBM-3278-2`. `auto` in the CLI is
  refused by `resolveGeometry` at connect (no measure function) — that is the spec's rule; surface
  it as a usage error at startup instead by checking `oversize.kind === 'auto'` in `parseArgs`, with
  the same message `geometry.ts` uses.
- [ ] **Step 3: Gate, commit** `cli: -oversize`.

---

### Task 6: TUI `-oversize` and its terminal measure

**Files:** `packages/tui/src/main.ts`, `packages/tui/src/app.ts`, `packages/tui/test/main.test.ts`, `packages/tui/test/app.test.ts`

**The measure:** `auto` fits the 3270 screen plus the OIA status row: `rows = terminal.rows - 1`,
`cols = terminal.cols` (`render.ts:139-169`: the status row needs one row of slack, and anything
more is border and hint, which are optional). Read `layout()` and confirm.

- [ ] **Step 1: Tests.**
  - `main.test.ts`: `parseArgs` accepts `-oversize auto` and `-oversize 160x62`; refuses with
    `--terminal-type`.
  - Export a pure `measureTerminal(term: {rows,cols}): Size | undefined` from `app.ts` (or a new
    small module, if `app.ts`'s conventions suggest it): `{rows:51, cols:132}` -> `{rows:50, cols:132}`;
    `{rows:0, cols:0}` (not a TTY) -> `undefined`.
  - `app.test.ts` (read its harness first): with a session built in geometry mode with `auto`, a
    SIGWINCH to a size where `measureTerminal` differs from `session.screen.alternateSize` WHILE
    CONNECTED writes `window now fits 50 rows by 132 columns; applies at the next reconnect` to
    stdout (via `showMessage`). A SIGWINCH to the SAME fit writes no such line. Not in `auto` mode:
    never written.
- [ ] **Step 2: Implement.**
  - `main.ts`: parse the flag (and add `OVERSIZE_USAGE` to the usage line); unless `--terminal-type`
    was given, `defaultSession(..., { model, oversize: args.oversize ?? {kind:'none'}, measure: () =>
    measureTerminal({ rows: process.stdout.rows ?? 0, cols: process.stdout.columns ?? 0 }) })`.
  - After `await session.connect(...)`: if `session.lastGeometryNotice` is set, write it to
    **stderr** before the App starts (it lands in the normal buffer and survives to scrollback).
    Also listen on `'geometry'` inside `App` and `showMessage` the notice once after a reconnect.
  - `app.ts` `onResize()`: after the existing body, if the setting is `auto` and connected, compute
    `measureTerminal(term)`; if it differs from `session.screen.alternateSize`, and differs from the
    last fit announced, `showMessage(...)`. Keep the last-announced fit in a field so repeated
    SIGWINCHes at one size say it once.
- [ ] **Step 3: Gate, commit** `tui: -oversize, measured from the terminal; a resize says when it applies`.

---

### Task 7: GUI `-oversize` and its display measure

**Files:** `packages/gui/src/args.ts`, `packages/gui/src/main.ts`, `packages/gui/test/args.test.ts`

**The measure** (the user's choice B): the display's work area at the scale the window would pick.
`fit()` at `main.ts:~943` uses `bestScale(list, 80% of workAreaSize)`. For `auto`, before the screen
exists, choose the scale the window would pick for the MODEL's screen, then count cells at that
scale:

```ts
/** Cells that fit the display at the scale the window would choose for the model's screen. */
export function measureDisplay(
  area: { width: number; height: number },
  cell: { width: number; height: number },
  model: { rows: number; cols: number },
): { rows: number; cols: number } {
  const within = { width: Math.floor(area.width * 0.8), height: Math.floor(area.height * 0.8) };
  const modelList = { width: model.cols * cell.width, height: (model.rows + 1) * cell.height };
  const scale = bestScale(modelList, within);
  return {
    cols: Math.floor(within.width / (cell.width * scale)),
    rows: Math.floor(within.height / (cell.height * scale)) - 1, // the OIA row
  };
}
```
  Put it in a pure module (`packages/gui/src/measure.ts`) so vitest can reach it with no Electron.
  **Verify the 0.8 and the `+ 1` OIA row against `fit()` and `drawlist.ts:118` before keeping them.**

- [ ] **Step 1: Tests.** `args.test.ts`: the flag parses, conflicts refused. `measure.test.ts`:
  a 1920x1080 work area with the 9x14 cell of `packages/canvas/assets/3270.bdf` (`FONTBOUNDINGBOX 9 14`)
  and model 24x80: within = 1536x864; modelList = 720x350; scale = min(2, 2) = 2; cols = floor(1536/18) = 85;
  rows = floor(864/28) - 1 = 29. So `{rows: 29, cols: 85}`. Assert exactly that, and a 1280x1024 case
  computed the same way by hand in the test's comment.
- [ ] **Step 2: Implement.** Geometry mode unless `--terminal-type`, as in Task 5. In `main.ts` the atlas is read AFTER the session is built (`:444` vs
  `:473`). The measure is only called at connect, which is later, so close over a `let atlas` that
  is assigned by then; **read the ordering at `main.ts:430-480` and `:1389` and confirm `connect`
  runs after `readAtlas`** — if it does not, move the measure's atlas read, not the connect.
  Call `screen.getPrimaryDisplay().workAreaSize` inside the measure (it must be read at connect).
  After a successful connect, print `session.lastGeometryNotice` to stderr if set, and subscribe to
  `'geometry'` to print it on later connects.
- [ ] **Step 3: Gate, commit** `gui: -oversize, measured from the display at the window's own scale`.

---

### Task 8: Web gateway `-oversize` and the viewport

**Files:** `packages/web/src/args.ts`, `packages/web/src/protocol.ts`, `packages/web/src/main.ts`, `packages/web/src/bridgecore.ts`, tests `args.test.ts`, `protocol.test.ts`, `bridgecore.test.ts`, `integration.test.ts`

**Protocol:** `hello` gains an optional `viewport: { width, height }` (CSS pixels). A new client
message `{ kind: 'viewport', width, height }` updates it. Both shape-checked: positive integers,
each at most 100000 (a bound, so a hostile client cannot make the measure produce absurd numbers;
`resolveGeometry` clamps to 16383 cells anyway). Read `protocol.ts`'s two-branch rule docstring
before adding a kind; `viewport` is accepted and intercepted in `main.ts`, never reaches `applyAction`
(it is not an `Action` at all — it is a top-level kind like `selection`).

**Measure:** the gateway keeps the latest viewport PER SESSION (not per socket — a reattached tab
replaces it). `measure = () => vp === undefined ? undefined : { cols: Math.floor(vp.width / atlas.geometry.cellWidth), rows: Math.floor(vp.height / atlas.geometry.cellHeight) - 1 }`.
At scale 1, per the spec.

**The connect ordering problem — read before coding.** Today the registry factory connects at once
(`main.ts:66`), on `hello`, before the page has said anything else. So the viewport must be IN
`hello`, and the factory must receive it. `SessionRegistry.attach(sessionId)` (`sessions.ts:55`) calls
`factory(id)`; thread the viewport through as a second argument to `attach` and `factory`. Read
`sessions.ts` and its tests in full first; keep the reaper and anti-hijack rules exactly as they are.

- [ ] **Step 1: Tests.**
  - `protocol.test.ts`: `hello` with a valid viewport decodes; with `width: -1`, `width: 1.5`,
    `width: '800'`, `width: 200000` each throws; `{kind:'viewport', width: 800, height: 600}` decodes.
  - `bridgecore.test.ts`: `onopen` sends `hello` carrying `deps.viewport()` (add an optional
    `viewport?: () => {width,height}` dep; absent -> no field, so existing tests are unchanged).
  - `integration.test.ts`: start the gateway with `-oversize auto` and `--replay` (no host), send a
    `hello` with `viewport: {width: 1350, height: 980}` and expect no error and a frame. **Replay
    never connects, so it never measures** — the measure itself is tested as a pure function: export
    `measureViewport(vp, cell)` from a small module and test `1350x980` with the 9x14 cell ->
    `{cols: 150, rows: 69}`.
- [ ] **Step 2: Implement** (geometry mode unless `--terminal-type`, as in Task 5) the args flag, the two protocol shapes, `measureViewport`, the registry
  threading, and the `viewport` message handler (store; no reply). In `bridge.ts`, pass
  `viewport: () => ({ width: window.innerWidth, height: window.innerHeight })`, and on `resize`
  (debounced 250 ms) send `{kind:'viewport', ...}`.
  Print `session.lastGeometryNotice` to stderr on `'geometry'`, prefixed with the session id's
  first 8 characters (the gateway serves many sessions).
- [ ] **Step 3: Gate, commit** `web: -oversize, measured from the browser viewport at scale 1`.

---

### Task 9: e-server `--query`, and a conformance capture against s3270

**Files:** `packages/cli/scripts/e-server.py`, `docs/live-testing.md`

The spec's conformance check: s3270 and our client, both `-oversize 160x62`, against the same
scripted host, comparing the terminal type and the Query Reply bytes.

- [ ] **Step 1:** Add `--query` to `e-server.py`: after negotiation, send
  `WSF Read Partition Query` (`f3 00 05 01 ff 02` — IAC-doubled on the wire as `f3 00 05 01 ff ff 02`;
  check against `packages/fixtures/x3270/tso-query-reply.txt`) as a 3270-DATA record, and log the
  inbound reply hex. It must already log the device type asked for (`on_device_type_request`, `:147`).
  Also add `--device-name` usage: pass `--device-name IBM-DYNAMIC` so the IS echoes it.
- [ ] **Step 2: Validate the harness against s3270 first** (the file's own rule, `:11-16`):
```bash
python3 packages/cli/scripts/e-server.py --port 3399 --query --device-name IBM-DYNAMIC > /tmp/ref.log 2>&1 &
~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/s3270/s3270 -oversize 160x62 C:127.0.0.1:3399 <<< 'Wait(3,Seconds)
Quit()'
```
  Expected in `/tmp/ref.log`: `client asked for device-type 'IBM-DYNAMIC'`, then an inbound reply
  starting `88` (AID SF).
- [ ] **Step 3: Our client:**
```bash
python3 packages/cli/scripts/e-server.py --port 3399 --query --device-name IBM-DYNAMIC > /tmp/ours.log 2>&1 &
printf 'Connect(127.0.0.1:3399)\nWait(3,Seconds)\nQuit()\n' | node packages/cli/dist/main.js -insecure -oversize 160x62
```
  (Check the CLI's real `Wait` syntax in `runner.ts` before running.)
- [ ] **Step 4: Compare.** Extract the Usable Area (0x81) and Implicit Partition (0xA6) units from
  both replies. **They will not be byte-identical overall** — x3270 sends more units than we do
  (`tso-query-reply.txt:9-11`). Compare those two units' W/H and WD/HD/WA/HA fields and the
  device-type string. Record both hex dumps and the comparison in `docs/live-testing.md` under a new
  dated heading. If any field differs, STOP and report — do not adjust either side to match.
- [ ] **Step 5: Commit** `e-server: --query; oversize conformance against s3270 recorded`.

---

### Task 10: pty harness, and the step-1 gate

**Files:** `packages/tui/scripts/pty-smoke.py`

- [ ] **Step 1:** Add an optional run (a flag `--oversize-auto`, so the default run is untouched):
  start the TUI with `-oversize auto` in a 41x100 pty. Read `FakeHost.ttype`: it must be
  `IBM-DYNAMIC`. Then resize the pty to 51x132 and expect `applies at the next reconnect` in the
  output within 2 s. (A reconnect check needs the FakeHost to accept twice; if that is more than a
  small change to `FakeHost.run`, leave it to Session's unit test from Task 2 and say so.)
- [ ] **Step 1b: GUI `auto` end to end under Xvfb.** Xvfb here is 1280x1024 (`gui/scripts/xvfb.mjs:41`).
  Run `e-server.py --query --device-name IBM-DYNAMIC` and the GUI with `-insecure -oversize auto`
  against it (read `clicks.mjs` for how a harness launches the GUI with `guiEnv()`). The e-server log
  must show `IBM-DYNAMIC` and a Usable Area W/H equal to `measureDisplay` for the work area
  Electron reports under Xvfb. **Print the work area Electron actually reports** — with no window
  manager it may be the full 1280x1024 — and compute the expectation from that, not from a guess.
  The web viewport's end-to-end equivalent is NOT run: a `--replay` gateway never connects, so never
  measures, and the browser harnesses only run replay gateways. Say so in the report; Task 8's unit
  tests and the integration `hello` test are the cover.

- [ ] **Step 2: The full gate, recorded.** `npm run build && npm run typecheck && npm test`;
  `python3 packages/tui/scripts/pty-smoke.py` and with `--oversize-auto`; `node packages/web/scripts/browser-clicks.mjs`;
  `browser-keys.mjs`; `browser-shot.mjs`; `browser-lan-copy.mjs`; GUI `keys.mjs`, `clicks.mjs`,
  `select.mjs`, `shot.mjs`, `transfer.mjs` (read `docs/HANDOFF.md`'s gate section for how each is
  invoked). Count leaked Electron processes after each (`pgrep -x electron`, never `-f`). Write
  every number down.
- [ ] **Step 3: Docs.** README: the `-oversize` flag in each front end's usage and flags table, the
  `<cols>x<rows>` order called out, `auto`'s per-front-end measure, the fallback, the refusals.
  `docs/HANDOFF.md` START HERE: step 1 done, the gate numbers, and the owed live pass. **Update
  every summary line that states a test count or a state** (title, START HERE heading, README's
  results table).
- [ ] **Step 4: Commit** `docs: oversize step 1 -- flags, gate, owed live pass`.

**STOP HERE and report to the user** before step 2: step 1 is shippable on its own, and the live
pass (VM/370 `-oversize 160x62`, TK5 TSO) can happen now.

---

# STEP 2 — changing model and oversize while running

### Task 11: CLI `Set(model,...)` and `Set(oversize,...)`

**Files:** `packages/cli/src/commands.ts:24-29`, `packages/cli/src/runner.ts`, `packages/cli/test/runner.test.ts`, `packages/cli/test/commands.test.ts`

- [ ] **Step 1: Tests** (read `runner.test.ts` for its session fixture):
  - `Set(model,3278-4-E)` while disconnected -> `ok`; after `Reconnect()`, EWA gives 43x80.
  - `Set(oversize,160x62)` -> ok; `Set(oversize,auto)` -> error `oversize auto needs a window to
    measure...` (the CLI has none); `Set(oversize,none)` -> ok.
  - Either while connected -> error starting `disconnect first`.
  - `Set(colour,x)` -> error `Set() knows model and oversize, not colour`.
  - `Set(model)` (one argument) -> error `Set() needs two arguments: a name and a value`.
  - Started with `--terminal-type` (the legacy path, Task 5), `Set(...)` is refused with
    `Set() cannot change a session started with --terminal-type` — `setGeometry` already throws in
    legacy mode; make the message say that.
- [ ] **Step 2: Implement.** Add `'Set'` to `COMMAND_NAMES`; in `runner.ts`, a `case 'Set'` beside
  `'Reconnect'` (`:219`) calling `s.setGeometry({ ...s.geometrySetting, model })` or `oversize:
  parseOversize(v)`.
- [ ] **Step 3: Gate, commit** `cli: Set(model,...) and Set(oversize,...), applied at the next connect`.

### Task 12: the `geometryMenu` action kind

**Files:** `packages/frontend/src/keymap.ts` (the `Action` union, `:~101`), `packages/frontend/src/actions.ts` (a guard beside `toggleKeyboard`'s, `:75`), `packages/frontend/src/bindings.ts` (an `Alt-M` row, no `terminal` sequence), `packages/canvas/src/keys.ts` (the Alt branch, `:254-271`), `packages/web/src/protocol.ts`, `packages/web/src/main.ts`, `packages/web/test/integration.test.ts` (`SWALLOWED`, `:218`), `packages/frontend/test/actions.test.ts`, `packages/canvas/test/keys.test.ts`

This is the seventh front-end-owned kind. **Follow `toggleKeyboard` exactly** — every site that
names it (`grep -rn toggleKeyboard packages/*/src packages/*/test packages/*/scripts`) gets the
matching `geometryMenu` treatment, and nothing else:

- [ ] **Step 1: Tests first.** `actions.test.ts`: `applyAction(session, {kind:'geometryMenu'})`
  throws `applyAction does not handle geometryMenu: the front end owns its own display`.
  `keys.test.ts`: `{key:'m', code:'KeyM', altKey:true}` -> `{kind:'geometryMenu'}`; with `ctrlKey`
  or `metaKey` also set -> NOT `geometryMenu`. Add `geometryMenu` to `integration.test.ts`'s
  `SWALLOWED` and watch that test fail (the gateway would throw) before Step 2.
- [ ] **Step 2: Implement** each site; `satisfies never` at `actions.ts:199` will tell you if the
  union and the guard disagree. In `keys.ts` add `if (e.code === 'KeyM') return { kind: 'geometryMenu' };`
  directly after the `KeyK` line, with a comment in the file's style naming why `code` and not `key`
  (Option-M is `µ`).
- [ ] **Step 3: Mutation-check:** delete `main.ts`'s new `geometryMenu` return; `integration.test.ts`
  must fail. Restore.
- [ ] **Step 4: Gate, commit** `frontend: geometryMenu, the seventh kind the front end owns; Alt-M`.

### Task 13: GUI Model menu

**Files:** `packages/gui/src/menu.ts`, `packages/gui/src/main.ts`, `packages/gui/test/menu.test.ts`

- [ ] **Step 1: Tests** (`menu.test.ts`, pure template):
  - `MenuItemTemplate` gains `type?: 'radio' | 'separator' | 'submenu'`, `checked?: boolean`,
    `enabled?: boolean` — **check each against Electron's `MenuItemConstructorOptions` so the
    no-cast assignment at `main.ts:1000` still typechecks.**
  - `buildMenuTemplate(platform, handlers, geometry?)` with `geometry = { models: [8 names],
    current: { model: '3278-4-E', oversize: {kind:'auto'} }, startupFixed: {rows:62, cols:160},
    connected: false }` yields a `Model` top-level menu: eight radio items labelled with the model
    names, the current one `checked: true`; a separator; an `Oversize` submenu with radio items
    `None`, `Auto`, `160x62 (62 rows by 160 columns)`, `Auto` checked. With `startupFixed`
    undefined, only `None` and `Auto`. With `connected: true`, the `Model` menu item is
    `enabled: false` (Electron disables a whole submenu that way — verify).
  - Without the `geometry` argument the template is exactly today's (every existing test passes).
- [ ] **Step 2: Implement.** In `main.ts`, rebuild the application menu on `'connect'`,
  `'disconnect'` and after each choice (Electron menus are immutable once built — check; if
  `MenuItem.enabled`/`checked` are writable, prefer mutating by `id`). A click calls
  `session.setGeometry(...)` inside a `try`, and a refusal goes to `fail()` (the `error-message`
  channel). The GUI's own `geometryMenu` action (from `Alt-M` in the canvas) pops the Model menu
  up with `Menu.getApplicationMenu()?.getMenuItemById('model')?.submenu?.popup()` — verify the API.
  Add the `geometryMenu` arm beside `toggleKeyboard`'s at `main.ts:1200`, and in the child-window
  path beside `requestCopy`'s (`:1271`), where it is dropped like `requestCopy`.
- [ ] **Step 3:** GUI `keys.mjs` harness: add `Alt+M` to its chord list with the expectation that
  it reaches no session (read how `toggleKeyboard`'s `Ctrl+B` is asserted at `:1374`).
- [ ] **Step 4: Gate, commit** `gui: a Model menu, picked from lists, disabled while connected`.

### Task 14: Web picker overlay

**Files:** `packages/web/src/geometryOverlay.ts` (**new**), `packages/web/static/index.html`, `packages/gui/ui.css`, `packages/web/src/bridge.ts`, `packages/web/src/bridgecore.ts`, `packages/web/src/protocol.ts`, `packages/web/src/main.ts`, tests `geometryOverlay.test.ts`, `protocol.test.ts`, `integration.test.ts`

**Protocol:**
- client -> server `{ kind: 'setGeometry', model: string, oversize: 'none' | 'auto' | 'startup' }`.
  `startup` means "the fixed size the gateway was started with"; the client never sends a size,
  so a client cannot ask for a geometry the operator who started the gateway did not allow.
  Shape-checked: `model` must be one of `Object.keys(KNOWN_MODELS)` (case-folded), `oversize` one of
  the three; `startup` refused when the gateway has no fixed oversize.
- server -> client `{ kind: 'geometryChoices', models: string[], current: {model, oversize}, startupFixed?: {rows, cols}, connected: boolean }`,
  sent after `atlas` on `hello`, and again on `'connect'`, `'disconnect'` and after a `setGeometry`.
- A refused `setGeometry` (connected, bad value) answers `{kind:'error', message}` as today.

**Overlay:** a sibling of `keyboardOverlay.ts` (read it and its test in full; copy the four
rules: hidden at start in code and markup, built lazily once, `hide()` assigns, opaque). Its DOM
is a list of radio inputs; while `connected` they are `disabled` and a line reads `Disconnect
first; the choice applies at the next connect.` Choosing sends `setGeometry`. Opening it closes the
keypad and the keyboard, and they close it (`bridge.ts:277-288`'s rule).

- [ ] **Step 1: Tests.** `geometryOverlay.test.ts` in the fake-element style of
  `keypadOverlay.test.ts:1-40`: starts hidden; toggles; builds once; `update(choices)` with
  `connected: true` marks every input disabled (through an injected `setDisabled`). Protocol shapes
  as above. `integration.test.ts`: `hello`, then expect a `geometryChoices` message with
  `connected: false` (replay never connects) and eight models; send `setGeometry` with
  `model: '3278-4-E', oversize: 'none'` -> a fresh `geometryChoices` with that current; with
  `model: '3278-9'` -> `error`; with `oversize: 'startup'` on a gateway started without
  `-oversize` -> `error`.
- [ ] **Step 2: Implement.** In `bridgecore.ts`, `geometryMenu` is intercepted like `toggleKeyboard`
  (`:568`) to `deps.toggleGeometry?.()`; `geometryChoices` is delivered to an injected
  `deps.onGeometryChoices?.()` (NOT through `dispatch` — read the comment at `:460-470` for why
  injected handlers bypass the queue).
- [ ] **Step 3: `browser-keys.mjs`:** add `Alt+M` with an asserted ABSENCE from the action log, as
  `Ctrl+K` is (`:108`). **Also check by hand that Chromium delivers `Alt+M` to the page at all** — if
  the harness shows the keydown never reaches it, stop and report; do not pick another chord without
  the user.
- [ ] **Step 4: Gate, commit** `web: a geometry picker on Alt-M, choices from the gateway`.

### Task 15: full gate, docs, and the owed live pass

- [ ] **Step 1:** The whole gate from Task 10 Step 2 again, every number written down.
- [ ] **Step 2:** README: `Set(...)`, the GUI Model menu, the web `Alt-M` picker, and that every
  choice applies at the next connect. `BINDING_INTENT` already carries `Alt-M` from Task 12.
- [ ] **Step 3:** `docs/live-testing.md`: an *OWED* list —
  - VM/370 `-oversize 160x62`: log on, run a full-screen app that issues EWA (FLIST or the MECAFF
    `EE` editor), report the geometry VM actually draws.
  - TK5 TSO: `-oversize 160x62` in the GUI; does TSO's Read Partition get our oversize, and does
    ISPF draw at it?
  - A modern z/VM or z/OS host, when the user has one: the `0x03` BIND path.
  - Web: `Alt-M` reaches the page in Firefox and Safari (Chromium is harness-checked).
- [ ] **Step 4:** `docs/HANDOFF.md` START HERE rewritten for the branch's final state; every
  summary line (title, headings, README counts) updated.
- [ ] **Step 5: Commit** `docs: oversize and model switching -- gate, docs, owed live pass`.
  **Do not merge.** Report to the user.
