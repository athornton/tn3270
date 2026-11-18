# Blink, Intensify and the Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The canvas front ends draw blinking and intensified text as x3270 does, and every front end
rings the host's alarm, audibly or (with `-visualbell`) as a flash.

**Architecture:** `canvas/src/blit.ts` learns a `blinkOff` phase and the intensify overstrike; a
small pure `canvas/src/blinker.ts` owns the 500 ms phase timer, which `renderer.ts` drives; the
renderer gains a `flash()` that `window.tn3270.onFlash` triggers. Core's existing `'alarm'` event
is wired in each front end: GUI main (`shell.beep()` or a `flash` IPC), the web gateway (a new
`alarm` message; the page's bridge plays a tone or flashes), and the TUI (BEL, or a DECSCNM flash).

**Tech Stack:** TypeScript 7, vitest 3 (fake timers), Electron 44, the web gateway's WebSocket
protocol, ANSI/DEC terminal sequences.

Spec: `docs/superpowers/specs/2026-11-17-blink-intensify-bell-design.md`.

## READ THIS FIRST (every task)

- **The source beats this plan.** The code below is a draft against `main` at `13e41b2`. Re-read
  every file a task names before editing; where it disagrees, follow the source and say so.
- **Rebuild before dependent tests:** other workspace packages consume `@tn3270/canvas`,
  `@tn3270/frontend` and `@tn3270/core` through their built `dist/`, so run `npm run build` after a
  source change and before running another package's tests. Then `npm run typecheck`, since vitest
  does not typecheck.
- Branch `blink-intensify-bell` (created off `main`, spec committed). Don't push.
- Commit messages end with a blank line, then `Generated with AI` and `Co-Authored-By: SLAC AI`.
- `grep`/`find` are shadowed by ugrep/bfs; use `command grep`. Run npm/npx from `~/git/tn3270`.
- **Measured before planning** (2026-11-17, by replaying `packages/fixtures/traces/*.trace` through
  core): every real host trace sends exactly ONE alarm (VM logon/logoff, TK5 VTAM logon, TSO ISPF);
  NO trace, including the golden's `synthetic-ispf-like.trace`, has a single blinking or
  intensified cell. So the screenshot goldens cannot change, and blink/intensify cannot be
  witnessed from these hosts.

## File structure

| File | Responsibility |
|---|---|
| `packages/canvas/src/blit.ts` | `blinkOff` option; intensify overstrike |
| `packages/canvas/src/blinker.ts` (new) | the blink phase and its timer, pure, injected timers |
| `packages/canvas/src/renderer.ts` | drives the blinker; `flash()`; subscribes `onFlash` |
| `packages/gui/src/args.ts`, `main.ts`, `preload.cts` | `-visualbell`; alarm -> beep or flash |
| `packages/web/src/args.ts`, `protocol.ts`, gateway session wiring, `bridgecore.ts` | `-visualbell`; `alarm` message; tone or flash |
| `packages/tui/src/args.ts`, `app.ts` | `-visualbell`; BEL or DECSCNM flash |

---

### Task 1: `blit` — the blink-off phase and the intensify overstrike

**Files:** Modify `packages/canvas/src/blit.ts` (`BlitOptions` ~:57, `blit` ~:113); test
`packages/canvas/test/blit.test.ts` (its recording `ctx` at ~:29-39: `fills`, `draws`).

- [ ] **Step 1: Write the failing tests** (append to `blit.test.ts`, reusing its recorder, `opts()`
  and list helpers; read them first and adapt names)

```ts
describe('blink and intensify, as x3270 draws them', () => {
  // A one-cell list with a visible glyph; the helpers in this file build lists from a Screen, so
  // build the cell directly here: x, y, glyph, fg, bg, cursor, underline, blink, intensify.
  const one = (over: Partial<DrawCell>): DrawList => ({
    width: atlas.cellWidth, height: atlas.cellHeight,
    cells: [{ x: 0, y: 0, glyph: INKED, fg: { r: 0, g: 255, b: 0 }, bg: { r: 0, g: 0, b: 0 },
      cursor: false, underline: false, blink: false, intensify: false, ...over }],
  });

  it('a blinking cell keeps its background and underline but loses its glyph in the off phase', () => {
    const r = recorder();
    blit(r.ctx, one({ blink: true, underline: true }), { ...opts(), blinkOff: true });
    expect(r.draws).toHaveLength(0);
    expect(r.fills).toHaveLength(2);                 // background, underline
  });

  it('a blinking cell draws normally in the on phase, and blinkOff spares non-blinking cells', () => {
    const r = recorder();
    blit(r.ctx, one({ blink: true }), { ...opts(), blinkOff: false });
    expect(r.draws).toHaveLength(1);
    const q = recorder();
    blit(q.ctx, one({}), { ...opts(), blinkOff: true });
    expect(q.draws).toHaveLength(1);
  });

  it('intensify overstrikes: the same glyph again, one SOURCE pixel (scale device pixels) right', () => {
    const r = recorder();
    blit(r.ctx, one({ intensify: true }), { ...opts(), scale: 3 });
    expect(r.draws).toHaveLength(2);
    expect(r.draws[1]!.sx).toBe(r.draws[0]!.sx);
    expect(r.draws[1]!.dx - r.draws[0]!.dx).toBe(3);
  });
});
```

`INKED` is any atlas column not in `blank` (pick one in the test, e.g. the column for EBCDIC `A`,
or the first index not in `blank`); `DrawCell`/`DrawList` are the types `drawlist.ts` exports
(check the real names).

- [ ] **Step 2:** `npx vitest run packages/canvas/test/blit.test.ts`: the new tests FAIL.
- [ ] **Step 3: Implement.** In `BlitOptions` add

```ts
  /**
   * The blink phase: when true, a cell with `blink` gets its background and underline but no
   * glyph, as x3270's `text_blink_it` blanks it (x3270/screen.c:1411-1435). Absent means "on".
   */
  readonly blinkOff?: boolean;
```

and in `blit`, replace the glyph block with

```ts
    if (!opts.blank.has(cell.glyph) && !(cell.blink && opts.blinkOff === true)) {
      const image = opts.tinted(cell.fg);
      if (image !== undefined) {
        const sx = cell.glyph * atlas.cellWidth;
        ctx.drawImage(image, sx, 0, atlas.cellWidth, atlas.cellHeight, dx, dy, w, h);
        // INTENSIFY IS AN OVERSTRIKE: the glyph again, one source pixel right, as x3270 draws it
        // (x3270/screen.c:2917-2921). Not a bolder font and not a brighter color.
        if (cell.intensify) {
          ctx.drawImage(image, sx, 0, atlas.cellWidth, atlas.cellHeight, dx + scale, dy, w, h);
        }
      }
    }
```

- [ ] **Step 4:** The file passes; `npx vitest run packages/canvas` and `npm run typecheck` clean.
- [ ] **Step 5: Mutate** the `blinkOff` guard away and the `+ scale` to `+ 1`; confirm a test fails
  each time; restore. Report.
- [ ] **Step 6: Commit** `canvas: draw blink's off phase and intensify's overstrike, as x3270 does`.

---

### Task 2: The blink timer, and the renderer driving it

**Files:** Create `packages/canvas/src/blinker.ts`, `packages/canvas/test/blinker.test.ts`; modify
`packages/canvas/src/renderer.ts` (`paint` ~:211 passes `blinkOff`; `onFrame` ~:318).

- [ ] **Step 1: Write the failing tests** (`blinker.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
import { createBlinker, hasBlink, BLINK_MS } from '../src/blinker.js';

const list = (blink: boolean) => ({ width: 1, height: 1, cells: [{ blink } as never] }) as never;

describe('blinker: x3270 text_blink_it (x3270/screen.c:1411-1435)', () => {
  it('is 500 ms, and finds blinking cells in the screen or the OIA', () => {
    expect(BLINK_MS).toBe(500);
    expect(hasBlink(list(true))).toBe(true);
    expect(hasBlink(list(false))).toBe(false);
  });

  it('starts only when a frame has blinkers, flips the phase each tick and repaints', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const b = createBlinker({ repaint });
    b.frame(list(false));
    vi.advanceTimersByTime(2000);
    expect(repaint).not.toHaveBeenCalled();
    expect(b.off).toBe(false);
    b.frame(list(true));
    vi.advanceTimersByTime(500);
    expect(b.off).toBe(true);
    vi.advanceTimersByTime(500);
    expect(b.off).toBe(false);
    expect(repaint).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('a new frame keeps the phase and does not restart the timer; no blinkers stops it, phase on', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const b = createBlinker({ repaint });
    b.frame(list(true));
    vi.advanceTimersByTime(400);
    b.frame(list(true));                  // a host repaint mid-period
    vi.advanceTimersByTime(100);
    expect(b.off).toBe(true);             // ticked at 500 from the FIRST frame, not 900
    b.frame(list(false));
    expect(b.off).toBe(false);            // no blinkers: back to on, so nothing stays blanked
    vi.advanceTimersByTime(5000);
    expect(repaint).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2:** FAIL (module missing).
- [ ] **Step 3: Implement** `blinker.ts`

```ts
/**
 * The blink phase, x3270's `text_blink_it` (x3270/screen.c:1411-1435): every 500 ms the phase
 * flips and the screen repaints, and the timer runs ONLY while some cell blinks. PURE apart from
 * the timers it is given, so vitest can drive it with fake timers; renderer.ts owns the DOM.
 */
import type { DrawList } from './drawlist.js';

export const BLINK_MS = 500;

/** Does this frame contain a blinking cell, in the screen or the OIA? */
export function hasBlink(list: DrawList): boolean {
  return list.cells.some((c) => c.blink) || (list.oia?.cells.some((c) => c.blink) ?? false);
}

export interface Blinker {
  /** True in the off phase: blinking glyphs are not drawn. */
  readonly off: boolean;
  /** Tell it about each painted frame. */
  frame(list: DrawList): void;
}

export function createBlinker(opts: {
  repaint: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): Blinker {
  const setTimer = opts.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let off = false;
  let timer: unknown;
  return {
    get off() { return off; },
    frame(list) {
      if (hasBlink(list)) {
        if (timer === undefined) timer = setTimer(() => { off = !off; opts.repaint(); }, BLINK_MS);
      } else if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
        off = false;
      }
    },
  };
}
```

(Check `DrawList`'s real `oia` shape in `drawlist.ts` and adjust `hasBlink`.)

In `renderer.ts`: create one blinker (`const blinker = createBlinker({ repaint: () => { if (last
!== undefined) paint(last); } });`), call `blinker.frame(list)` in `paint` before blitting, and
pass `blinkOff: blinker.off` in the blit `options`. Make sure the tick's repaint, which calls
`paint(last)`, does not reset anything else (the selection, the notice state): read `paint`'s
callers (`onFrame`, `resize`, the tint callback) and keep the tick on the same path as `resize`.
Add the blinker to the source-text import test if `renderer-imports.test.ts` pins imports.

- [ ] **Step 4:** Tests pass; `npx vitest run packages/canvas`, `npm run build`, `npm run typecheck`.
  Then run the GUI golden (`node packages/gui/scripts/shot.mjs`, see its header for the
  Xvfb setup, also in `docs/live-testing.md` *Typed input, proved end to end*) and confirm it still
  matches: no golden has blink, so it must.
- [ ] **Step 5: Mutate** `off = !off` to `off = true`, and remove the `timer === undefined` guard;
  confirm a test fails each time; restore.
- [ ] **Step 6: Commit** `canvas: blink at x3270's 500 ms, only while something blinks`.

---

### Task 3: The renderer's flash, and the GUI's bell

**Files:** `packages/canvas/src/renderer.ts` (bridge type ~:45-57, a `flash()`), `packages/gui/src/
preload.cts` (`onFlash`), `packages/gui/src/args.ts` (`-visualbell`), `packages/gui/src/main.ts`
(session wiring ~:1335-1339); tests `packages/gui/test/args.test.ts`, a source-text test for the
wiring (pattern: `packages/gui/test/quitChord.test.ts`).

- [ ] **Step 1: Failing tests.** In `args.test.ts`: `parseGuiArgs(['-visualbell', 'vm'])` yields
  `visualBell: true`, and its absence `false` (check the parsed type's real field style). In a new
  `packages/gui/test/bell.test.ts`, source-text assertions over `main.ts`, `preload.cts` and
  `renderer.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

describe('the GUI rings the host alarm (core emits it; x3270 ring_bell, screen.c:5457)', () => {
  it('main beeps, or sends flash with -visualbell', () => {
    const main = read('../src/main.ts');
    expect(main).toMatch(/session\.on\('alarm'[\s\S]{0,400}shell\.beep\(\)/);
    expect(main).toMatch(/session\.on\('alarm'[\s\S]{0,400}webContents\.send\('flash'\)/);
  });
  it('the preload exposes onFlash, and the renderer subscribes it to flash()', () => {
    expect(read('../src/preload.cts')).toMatch(/onFlash[\s\S]{0,200}ipcRenderer\.on\('flash'/);
    expect(read('../../canvas/src/renderer.ts')).toMatch(/onFlash\?\.\(\s*\(\)\s*=>\s*\{?\s*flash\(\)/);
  });
});
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
  - `args.ts`: `case '-visualbell': visualBell = true; continue;` and the field on the result type;
    usage text names it.
  - `renderer.ts`: bridge type gains `onFlash?(fn: () => void): void;`. Add

```ts
/**
 * THE VISUAL BELL: the whole canvas inverted for ~100 ms, then repainted, as x3270's
 * `ring_bell` flashes with `visualBell` set (x3270/screen.c:5457). `difference` against white is
 * an inversion, the composition the selection highlight already uses.
 */
function flash(): void {
  if (canvas === null) return;
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  setTimeout(() => { if (last !== undefined) paint(last); }, 100);
}
window.tn3270.onFlash?.(() => { flash(); });
```

    (check the renderer's real `ctx` name and how the selection highlight sets and restores the
    composition; follow that.)
  - `preload.cts`: `onFlash: (fn) => { ipcRenderer.on('flash', () => { fn(); }); },`.
  - `main.ts`, beside `session.on('screen', send)`:

```ts
  // THE HOST'S ALARM (WCC bit; core emits 'alarm'), rung as x3270's ring_bell does: the system
  // beep, or with -visualbell a flash of the window instead (x3270/screen.c:5457).
  session.on('alarm', () => {
    if (args.visualBell) win.webContents.send('flash'); else shell.beep();
    if (SEAM_ACTIVE) process.stdout.write(`bell: ${args.visualBell ? 'visual' : 'audible'}\n`);
  });
```

    `SEAM_ACTIVE`: true when any test seam is set (find how `main.ts` decides that; `SEAM.keys`,
    `SEAM.replay`, `SEAM.shot`), so harnesses can see the bell and normal runs print nothing. Import
    `shell` from `electron`. Use the real names for the parsed args object and the window.
- [ ] **Step 4:** Tests pass; build; typecheck. **Offline proof:** replay
  `packages/fixtures/traces/vm370-logon-logoff.trace` through the GUI (`TN3270_GUI_REPLAY`, the
  same setup as the golden; see `shot.mjs`) and confirm stdout has exactly one `bell: audible`, and
  `bell: visual` with `-visualbell`. Report the command and output.
- [ ] **Step 5: Mutate** the `-visualbell` branch (always beep) and confirm the offline proof shows
  `audible` with the flag; restore.
- [ ] **Step 6: Commit** `gui: ring the host's alarm, or flash with -visualbell`.

---

### Task 4: The browser's bell

**Files:** `packages/web/src/args.ts`, `protocol.ts` (server messages ~:29-101), the gateway's
per-session wiring (find where the gateway subscribes to `session.on('screen')` and sends `frame`;
likely `sessions.ts` or `main.ts`), `packages/web/src/bridgecore.ts` (`register` ~:467, the API
object ~:606); tests in `packages/web/test/` (find the args, protocol and bridgecore tests).

- [ ] **Step 1: Failing tests.**
  - args: `-visualbell` parses to `visualBell: true` (follow the file's flag style).
  - protocol: `{ kind: 'alarm', visual: true }` round-trips through the encoder/decoder the
    protocol tests use.
  - gateway: a session's `'alarm'` makes the gateway send `{ kind: 'alarm', visual }` to the page
    (use the existing gateway session tests' fake socket).
  - bridgecore: an `alarm` with `visual: true` calls every `onFlash` handler; with `visual: false`
    it plays a tone through an injected/fake `AudioContext` (check how bridgecore is constructed in
    its tests and inject the audio factory the same way), and a throwing or missing `AudioContext`
    is swallowed, never thrown.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement.**
  - protocol: `| { kind: 'alarm'; visual: boolean }` in the server-to-page union, plus whatever
    validation the protocol does for each kind (shape-check it like the others).
  - gateway: on the session's `'alarm'`, send `{ kind: 'alarm', visual: args.visualBell }`.
  - bridgecore: `onFlash: (fn) => { flashFns.push(fn); }`, and an `alarm` handler: `visual` ->
    each flash fn; else a ~100 ms 880 Hz tone:

```ts
function tone(make: () => AudioContext | undefined): void {
  try {
    const ac = make();
    if (ac === undefined) return;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.1;
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.1);
  } catch { /* no audio here, or not allowed yet: a bell is never worth an error */ }
}
```

    Browsers may refuse sound before a user gesture; that is expected and documented, not handled.
- [ ] **Step 4:** Tests pass; build; typecheck; `npx vitest run packages/web`.
- [ ] **Step 5: Commit** `web: ring the host's alarm in the browser, or flash with -visualbell`.

---

### Task 5: The TUI's bell

**Files:** `packages/tui/src/args.ts`, `packages/tui/src/app.ts` (session listeners ~:396-401,
`this.stdout.write`, the `quitting`/`restored`/`suspended` guards); tests
`packages/tui/test/args.test.ts`, `packages/tui/test/app.test.ts` (its `harness()` records stdout).

- [ ] **Step 1: Failing tests** in `app.test.ts` (with the file's harness; fire the alarm the way
  the file fires other session events, or through a host write with the WCC alarm bit `0x04`):
  - an alarm writes `\x07`;
  - with `-visualbell`, it writes `\x1b[?5h` and, after 100 ms (fake timers), `\x1b[?5l`, and no
    `\x07`;
  - nothing is written after quitting (the `quitting` guard, as `draw` has).
  And `args.test.ts`: `-visualbell` parses.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement** in `app.ts`, beside the other `session.on` calls:

```ts
    // THE HOST'S ALARM: BEL, which the terminal sounds or flashes by its own setting; with
    // -visualbell, a reverse-screen flash instead (DECSCNM on, then off), as xterm's own visual
    // bell looks. x3270's ring_bell, screen.c:5457.
    this.session.on('alarm', () => {
      if (this.quitting || this.restored) return;
      if (!this.options.visualBell) { this.stdout.write('\x07'); return; }
      this.stdout.write('\x1b[?5h');
      setTimeout(() => { if (!this.quitting && !this.restored) this.stdout.write('\x1b[?5l'); }, 100);
    });
```

  (use the app's real options field and timer conventions; if it tracks timers for cleanup on
  quit, register this one the same way.)
- [ ] **Step 4:** Tests pass; build; typecheck; `npx vitest run packages/tui`; and
  `python3 packages/tui/scripts/pty-smoke.py` still passes.
- [ ] **Step 5: Commit** `tui: ring the host's alarm, or flash the screen with -visualbell`.

---

### Task 6: Witnesses

**Files:** `docs/live-testing.md` (a new section before `## Step 1 — Confirm the host is reachable`).

- [ ] **Step 1: Live bell, GUI.** Probe `127.0.0.1:3270` and `:3271` (STOP if closed; never start
  Hercules). Connect the GUI to VM with a keys seam that only waits for the logon screen
  (`TN3270_GUI_KEYS='wait:VM/370|CP READ'`), which is where the recorded VM trace rings, and
  confirm stdout's `bell: audible`; again with `-visualbell` for `bell: visual`. If VM does not
  ring at that point live, find where it does in `vm370-logon-logoff.trace` and drive to it without
  logging on, or report that it could not be reached without a logon. Same on TK5 if its trace
  rings before logon.
- [ ] **Step 2: Live bell, TUI.** Drive the TUI against the same host over a pty
  (`packages/tui/scripts/live-drive.py` or a short Python pty script modelled on `pty-smoke.py`) and
  confirm a `\x07` in the captured output; with `-visualbell`, the `\x1b[?5h`/`\x1b[?5l` pair.
- [ ] **Step 3: Offline rendering of blink and intensify.** No host sends either (see READ THIS
  FIRST), so: build a trace with one blinking field and one intensified field (extended highlight
  via SA or SFE; `tools/make-synthetic-fixture.mjs` shows how traces are generated), replay it
  through the GUI with `TN3270_GUI_SHOT`, and compare: the intensified cells carry more ink than the
  same text plain (one source-pixel overstrike), and two captures 250 ms apart differ only in the
  blinking cells' glyphs. Keep the trace as a fixture only if it is small; otherwise build it in the
  test run. Report pixel counts.
- [ ] **Step 4:** Record the section, headed exactly
  `## Blink, intensify and the bell, from the GUI and TUI — 2026-11-17`: what was witnessed live
  (bells), what only offline (blink, intensify), and the browser's bell as covered by tests only
  (no browser harness rings it), or by `packages/web/scripts` if one can.
- [ ] **Step 5: Commit** `docs: witnesses for blink, intensify and the bell`.

---

### Task 7: Docs

- [ ] **Step 1:** README: the GUI, TUI and browser sections gain one line each on the bell and
  `-visualbell`; the browser's notes that a first alarm may be silent until the page has had a
  keypress; *What is not implemented* loses anything these fix. `command grep -n "blink\|bell\|
  intensif\|alarm" README.md` and fix every stale sentence.
- [ ] **Step 2:** Changelog fragment `changelog.d/20261117_230000_athornton_blink_intensify_bell.md`
  under `### Bug fixes` (blink and intensify drawn; the alarm rings) and `### New features`
  (`-visualbell`).
- [ ] **Step 3:** Parity rows: `highlight-bold` (intensify now drawn; re-read the whole row and keep
  any remaining gap, e.g. no `-highlightBold` setting), `bell` (now `ours` if the live bell
  witnesses held; `evidence.live` the Task 6 heading; `-visualbell` is the `visualBell` resource's
  equivalent reach). `node scripts/parity.mjs check`, `render`, and report the gate line.
- [ ] **Step 4:** HANDOFF's *FOUND BY THE CHECKLIST* items 7 (blink/intensify) and 8 (alarm): mark
  them fixed on this branch, as items 1-2 and 10 are marked.
- [ ] **Step 5:** Whole-branch gate: `npm run build && npm run typecheck && npx vitest run`.
- [ ] **Step 6: Commit** `docs: blink, intensify and the bell in the README, changelog, parity and HANDOFF`.
