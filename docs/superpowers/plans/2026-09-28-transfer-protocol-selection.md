# Transfer Protocol Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the HOST choose CUT or DFT file transfer, so `Session.startDftTransfer` finally has a
caller and DFT can reach a real mainframe.

**Architecture:** A non-throwing detector in `core` decides which protocol arrived; both drivers build
both engines over one source buffer, register the DFT one before priming the host, and commit to
whichever declares itself first. The up-front geometry gate moves from "before the host is involved"
to "once we know it is CUT". `transferRun.ts` moves from `packages/tui` to `packages/frontend` first,
so the DFT arm is written twice (one blocking driver, one event-driven) rather than four times.

**Tech Stack:** TypeScript, vitest, npm workspaces. Packages: `core`, `frontend`, `cli`, `tui`.

**Spec:** `docs/superpowers/specs/2026-09-25-transfer-protocol-selection-design.md` — approved by the
user 2026-09-28. Read it before Task 1; this plan does not restate its reasoning.

---

## READ THIS FIRST — five facts that will cost you time otherwise

1. **`npm run build` MUST precede `vitest`.** Every package resolves to its built `dist/index.js`.
   Testing before rebuilding after a cross-package move fails in a way that looks like a broken
   refactor. After a `git checkout`, also run `npx tsc --build --force packages/gui` or the GUI
   staleness guard reddens on mtimes alone.
2. **`vitest` DOES NOT TYPECHECK.** A green suite can sit over a failing `npm run build`. Run both.
3. **`isCutFrame` THROWS at 43x80** (`frames.ts:350` → `requireCutGeometry`). That is why Task 2
   exists. Do not "fix" `isCutFrame`.
4. **Mutation-check every test that claims to pin a guard.** Four mutations passed *vacuously* on the
   DFT branch. The plan marks the required ones; treat an un-reddening mutation as a finding, not a
   formality.
5. **THE SOURCE BEATS THIS PLAN.** If `frames.ts`, `dft.ts` or x3270 contradicts a line here, the
   source is right and the plan is wrong — say so in the task's AS BUILT note. Roughly forty defects
   on the last three branches were in the plan, not the code.

## Baseline before Task 1

Branch `dft-file-transfer`, **2085 tests in 81 files**, build and typecheck clean. Confirm with
`npm run build && npm test` before starting; if the count differs, reconcile before writing code.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `packages/core/src/ft/detect.ts` | **Create.** `looksLikeCutFrame` — the non-throwing detector | 2 |
| `packages/core/src/index.ts` | **Modify.** Export `./ft/detect.js` | 2 |
| `packages/core/src/session.ts` | **Modify.** `cancelDftTransfer()`; clear `dft` in `handleClose` | 3 |
| `packages/frontend/src/transferRun.ts` | **Create** by moving from `packages/tui/src/` | 4 |
| `packages/tui/src/transferRun.ts` | **Delete** (moved) | 4 |
| `packages/frontend/src/index.ts` | **Modify.** Export the moved module | 4 |
| `packages/tui/src/transferOverlay.ts` | **Modify.** Import from `@tn3270/frontend` | 4 |
| `packages/frontend/src/transferRun.ts` | **Modify.** Drop the geometry gate; DFT arm | 5, 6 |
| `packages/cli/src/runner.ts` | **Modify.** Same, in the blocking idiom | 7, 8 |

---

### Task 1: Confirm the baseline and read the spec

**Files:** none modified.

- [ ] **Step 1: Verify the tree and the test count**

```bash
cd ~/git/tn3270
git branch --show-current          # expect: dft-file-transfer
git status --short                 # expect: empty (a .nfs* file is harmless)
npm run build && npm test 2>&1 | grep -E "Test Files|Tests  "
```

Expected: `Test Files 81 passed (81)`, `Tests 2085 passed (2085)`, no build errors.

- [ ] **Step 2: Read the spec end to end**

`docs/superpowers/specs/2026-09-25-transfer-protocol-selection-design.md`, 323 lines. Pay particular
attention to *Deciding* (the check-state-before-waiting rule) and *The accepted regression*.

- [ ] **Step 3: Read the two things the spec says are already built**

`packages/core/src/ft/frames.ts:312-356` (`requireCutGeometry`, `isCutFrame`) and
`packages/core/src/session.ts:355-366` (`startDftTransfer`, the `dftTransfer` getter). Confirm for
yourself that `handleClose` does **not** clear `this.dft` — that is Task 3's bug.

No commit for this task.

---

### Task 2: `looksLikeCutFrame` — the non-throwing detector

**Files:**
- Create: `packages/core/src/ft/detect.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/ft/detect.test.ts` (create) — **note the `ft/` subdirectory; the CUT tests live there, not in the flat `test/`**

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/ft/detect.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Screen } from '../../src/screen.js';
import { looksLikeCutFrame } from '../../src/ft/detect.js';
import { isCutFrame, CutFrameError, O_SF, CUT_SCREEN_SIZE } from '../../src/ft/frames.js';

/**
 * 0x7c is the byte the real TK5 host plants at O_SF: protected (0x20) and numeric
 * (0x10), which is FA_IS_SKIP. Copied from `frames.test.ts`'s `markCutFrame` rather
 * than rebuilt from `FA.PROTECT | FA.NUMERIC`, so both files agree with the fixture.
 */
const CUT_FRAME_ATTR = 0x7c;

/** A 24x80 screen carrying a CUT frame. */
function cutFrame24x80(): Screen {
  const s = new Screen();
  expect(s.size).toBe(CUT_SCREEN_SIZE);
  s.setFieldAttribute(O_SF, CUT_FRAME_ATTR);
  return s;
}

/** A 24x80 screen that is NOT a CUT frame: no attribute at O_SF at all. */
function plain24x80(): Screen {
  return new Screen();
}

/**
 * The same auto-skip attribute, on a model-4 (43x80) screen.
 *
 * `resize` is the only thing allowed to change the buffer's shape; a bare
 * `new Screen()` is always 24x80 (every model's DEFAULT size is 24x80 -- the model
 * sets only the ALTERNATE).
 */
function cutFrameShaped43x80(): Screen {
  const s = new Screen({ alternateRows: 43, alternateCols: 80 });
  s.resize(43, 80);
  s.setFieldAttribute(O_SF, CUT_FRAME_ATTR);
  return s;
}

describe('looksLikeCutFrame', () => {
  it('agrees with isCutFrame on a real frame at 24x80', () => {
    const s = cutFrame24x80();
    expect(isCutFrame(s)).toBe(true);
    expect(looksLikeCutFrame(s)).toBe(true);
  });

  it('agrees with isCutFrame on a non-frame at 24x80', () => {
    const s = plain24x80();
    expect(isCutFrame(s)).toBe(false);
    expect(looksLikeCutFrame(s)).toBe(false);
  });

  it('RETURNS FALSE at 43x80 where isCutFrame THROWS', () => {
    // THE ENTIRE REASON THIS FUNCTION EXISTS. A driver must be able to ask "is this
    // CUT?" at any geometry, because under host-chooses-the-protocol we do not know
    // the geometry is legal until after the host has answered.
    const s = cutFrameShaped43x80();
    expect(() => isCutFrame(s)).toThrow(CutFrameError);
    expect(looksLikeCutFrame(s)).toBe(false);
  });

  it('returns false at 43x80 for a screen with nothing at O_SF either', () => {
    const s = new Screen({ alternateRows: 43, alternateCols: 80 });
    s.resize(43, 80);
    expect(looksLikeCutFrame(s)).toBe(false);
  });
});
```

**These helpers were checked against the real APIs** (`Screen` constructor `screen.ts:163`,
`resize` `:205`, `setFieldAttribute` `:355`; `O_SF` `frames.ts:69`, `CUT_SCREEN_SIZE` `:72`,
`CutFrameError` `:291`) and against `packages/core/test/ft/frames.test.ts:86-100`, whose
`blankScreen` and `markCutFrame` this mirrors. If anything still differs, the source wins.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/ft/detect.test.ts
```

Expected: FAIL — cannot resolve `../src/ft/detect.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/ft/detect.ts`:

```typescript
import { CUT_SCREEN_SIZE, isCutFrame } from './frames.js';
import type { Screen } from '../screen.js';

/**
 * Does this screen LOOK like a CUT frame? Never throws, whatever the geometry.
 *
 * ## WHY THIS IS NOT JUST `isCutFrame`
 *
 * `isCutFrame` calls `requireCutGeometry`, which THROWS `CutFrameError` on any screen
 * that is not 24x80 (`frames.ts:312`). That is correct for STEPPING a transfer — the
 * frame offsets are meaningless on another geometry, and computing them anyway would
 * read fields that mean something else. But it makes `isCutFrame` unable to answer the
 * question a protocol DECIDER has to ask.
 *
 * Under host-chooses-the-protocol we do not learn the geometry is legal until the host
 * has already answered, so the decider must be askable at 43x80 and get `false` rather
 * than an exception. Hence: new function for DECIDING, `isCutFrame` unchanged for
 * STEPPING.
 *
 * The geometry check is FIRST and returns `false`, so `isCutFrame` is only ever reached
 * on a screen it accepts. Delegating the rest rather than re-implementing the
 * attribute test is deliberate — two copies of "what is a CUT frame" would drift, and
 * the masks-never-equality reasoning in `isCutFrame` is load-bearing (a live TK5 frame
 * plants 0x7c where x3270 stores 0xfc).
 */
export function looksLikeCutFrame(screen: Screen): boolean {
  if (screen.size !== CUT_SCREEN_SIZE) return false;
  return isCutFrame(screen);
}
```

Then add to `packages/core/src/index.ts`, beside the other `ft/` exports (around line 24-28):

```typescript
export * from './ft/detect.js';
```

- [ ] **Step 4: Run the test and the suite**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/ft/detect.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: MUTATION CHECK — required, this is the whole point of the file**

Temporarily make `looksLikeCutFrame` throw instead of returning false:

```typescript
export function looksLikeCutFrame(screen: Screen): boolean {
  return isCutFrame(screen);          // MUTATION: drop the geometry guard
}
```

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/ft/detect.test.ts
```

Expected: the 43x80 tests FAIL with `CutFrameError`. **If they pass, the test is not exercising the
43x80 path — fix the test before proceeding.** Then revert the mutation and re-run to green.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/core/src/ft/detect.ts packages/core/src/index.ts packages/core/test/ft/detect.test.ts
git commit -F - <<'EOF'
feat(core): looksLikeCutFrame, a CUT detector that answers at any geometry

isCutFrame throws CutFrameError on anything but 24x80, so it cannot answer "is this
CUT?" -- it can only fail. Under host-chooses-the-protocol the decider must be askable
before we know the geometry is legal, so this returns false where that throws.

isCutFrame is UNCHANGED and still throws: new function for deciding, old one for
stepping. The geometry check runs first and delegates the rest, so there is one
definition of what a CUT frame is -- the masks-never-equality reasoning there is
load-bearing (live TK5 plants 0x7c where x3270 stores 0xfc).

Mutation-verified: dropping the geometry guard reddens the 43x80 tests.

Generated with AI

Co-Authored-By: SLAC AI
EOF
```

---

### Task 3: `Session.cancelDftTransfer()`, and `handleClose` clearing `dft`

**Files:**
- Modify: `packages/core/src/session.ts`
- Test: `packages/core/test/dftSession.test.ts`

The `handleClose` half is a **latent bug from the DFT work, independent of this design**: it clears
`conn`, `telnet` and `e` but not `dft`. This project has fixed that exact shape twice already
(`Session.e` cleared only on the REJECT path; `IAC DONT TN3270E` clearing the option but not
`tn3270eNegotiated`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/dftSession.test.ts`. **Read the top of that file first and reuse its
existing session/connection helpers** rather than the illustrative names below.

```typescript
describe('a registered DFT transfer is releasable', () => {
  it('cancelDftTransfer clears it', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'send', data: new Uint8Array([1, 2, 3]) }));
    expect(session.dftTransfer).toBeDefined();

    session.cancelDftTransfer();

    expect(session.dftTransfer).toBeUndefined();
  });

  it('is a no-op when nothing is registered', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(() => session.cancelDftTransfer()).not.toThrow();
    expect(session.dftTransfer).toBeUndefined();
  });

  it('a dropped connection cannot strand one', async () => {
    // THE LATENT BUG, independent of protocol selection: handleClose clears conn,
    // telnet and e but not dft, so a transfer registered on one connection would
    // still be registered on the next -- and answerRead would replay its retained
    // frame to a host that knows nothing about it.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'send', data: new Uint8Array([1, 2, 3]) }));

    conn.close();

    expect(session.dftTransfer).toBeUndefined();
  });
});
```

Add `DftTransfer` to that file's imports from `../src/ft/dft.js` if it is not already there.

- [ ] **Step 2: Run and watch both fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/dftSession.test.ts -t "releasable"
```

Expected: FAIL — `session.cancelDftTransfer is not a function`, and after adding the method, the
`handleClose` test still fails.

- [ ] **Step 3: Implement both**

In `packages/core/src/session.ts`, immediately after the `dftTransfer` getter (around line 365):

```typescript
  /**
   * Release a registered DFT transfer without telling the host anything.
   *
   * FOR THE LOSER OF A PROTOCOL RACE, which is the only caller: `Transfer()` registers a
   * DFT transfer before priming the host, because the first `0xd0` can arrive from inside
   * record handling before any driver code runs again. When the host answers with a CUT
   * frame instead, that registration must go — otherwise `answerRead` would keep replaying
   * its retained frame at a host running a CUT transfer.
   *
   * SENDS NOTHING, and that is the difference from `DftTransfer.cancel()`. A cancel
   * negotiates an end with a host that is mid-transfer; this discards an engine the host
   * never spoke to. Synthesising an abort here would put bytes on the wire that no
   * captured session contains — the same rule `transferRun.ts` gives for not inventing one
   * from a timeout.
   *
   * Idempotent: a no-op when nothing is registered, so a driver need not track whether it
   * has already committed.
   */
  cancelDftTransfer(): void {
    this.dft = undefined;
  }
```

And in `handleClose`, beside the other connection-scoped teardown (next to `this.pendingAid = AID.NONE;`):

```typescript
    // A DFT transfer belongs to the CONNECTION that was carrying it. Without this a
    // transfer registered on one connection stays registered on the next, and
    // `answerRead`'s retained-frame replay would answer a host that knows nothing about
    // it. THIRD TIME THIS SHAPE HAS BEEN FIXED HERE — `Session.e` once cleared only on
    // the REJECT path, and `IAC DONT TN3270E` once cleared the option but not
    // `tn3270eNegotiated`. One teardown path clears the state and another does not.
    this.dft = undefined;
```

- [ ] **Step 4: Run and verify green**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftSession.test.ts
```

Expected: PASS, all tests in the file.

- [ ] **Step 5: MUTATION CHECK — required, the spec names this one explicitly**

Remove the `this.dft = undefined;` line from `handleClose`, rebuild, re-run.

Expected: the *"a dropped connection cannot strand one"* test FAILS. **The spec says: "that test must
fail without the fix or it is testing nothing."** Revert and re-run to green.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/core/src/session.ts packages/core/test/dftSession.test.ts
git commit -F - <<'EOF'
feat(core): cancelDftTransfer, and handleClose finally clears `dft`

Two additions the protocol decider needs. cancelDftTransfer releases a registered
transfer that LOST a protocol race, sending nothing -- it discards an engine the host
never spoke to, which is a different thing from DftTransfer.cancel negotiating an end
with one that is mid-transfer.

The handleClose half is a LATENT BUG FROM THE DFT WORK, independent of this design: it
cleared conn, telnet and e but not dft, so a transfer registered on one connection
stayed registered on the next and answerRead would replay its retained frame to a host
that knew nothing about it. THIRD TIME THIS SHAPE HAS BEEN FIXED HERE, after Session.e
and IAC DONT TN3270E.

Mutation-verified: removing the handleClose line reddens its test.

Generated with AI

Co-Authored-By: SLAC AI
EOF
```

---

### Task 4: MOVE `transferRun.ts` to `packages/frontend` — no behaviour change

**Files:**
- Create: `packages/frontend/src/transferRun.ts` (moved, byte-identical but for imports)
- Delete: `packages/tui/src/transferRun.ts`
- Modify: `packages/frontend/src/index.ts`, `packages/tui/src/transferOverlay.ts`
- Move: `packages/tui/test/transferRun.test.ts` → `packages/frontend/test/transferRun.test.ts`

**This task changes NO behaviour.** It is what keeps the DFT arm at two writings instead of four, and
the spec says it is independently valuable regardless of the rest. Verified cheap: the file imports
only `@tn3270/core` and `@tn3270/frontend`, and takes `TransferFiles` as a **type**, so the move
carries no new dependency.

- [ ] **Step 1: Record the pre-move hash**

```bash
cd ~/git/tn3270 && sha256sum packages/tui/src/transferRun.ts
```

Write the hash into the commit message later. This is the same discipline the `canvas` extraction used.

- [ ] **Step 2: Move the file and its test with `git mv`**

```bash
cd ~/git/tn3270
git mv packages/tui/src/transferRun.ts packages/frontend/src/transferRun.ts
ls packages/tui/test/transferRun.test.ts && git mv packages/tui/test/transferRun.test.ts packages/frontend/test/transferRun.test.ts
```

If the test file lives elsewhere or under another name, find it first:
`grep -rln "startTransfer" packages/tui/test/ packages/frontend/test/`.

- [ ] **Step 3: Fix the imports in the moved file**

`packages/frontend/src/transferRun.ts` currently reads:

```typescript
import type { TransferFiles, TransferRequest } from '@tn3270/frontend';
```

A package cannot import itself. Change it to relative imports:

```typescript
import type { TransferFiles, TransferRequest } from './transfer.js';
```

**Verify those two types actually live in `frontend/src/transfer.ts`** — `grep -n "TransferFiles\|TransferRequest" packages/frontend/src/*.ts` — and point the import at wherever they really are. The
`@tn3270/core` import line is unchanged.

Add to `packages/frontend/src/index.ts`:

```typescript
export * from './transferRun.js';
```

- [ ] **Step 4: Fix the consumer**

In `packages/tui/src/transferOverlay.ts` (and any other TUI file that imports it — find them with
`grep -rn "transferRun" packages/tui/src/`), change:

```typescript
import { startTransfer, type TransferRun } from './transferRun.js';
```

to:

```typescript
import { startTransfer, type TransferRun } from '@tn3270/frontend';
```

Also fix the moved test's imports: `../src/transferRun.js` still resolves, but any
`@tn3270/frontend` type import inside it must become relative for the same self-import reason.

- [ ] **Step 5: Build, then test — in that order**

```bash
cd ~/git/tn3270 && npm run build && npm test 2>&1 | grep -E "Test Files|Tests  |FAIL"
```

Expected: `Tests 2085 passed`, unchanged — **a move must not change the count.** If the build fails
on a missing export, the `index.ts` line is wrong; if tests fail, you tested before building.

- [ ] **Step 6: Verify the move was content-preserving**

```bash
cd ~/git/tn3270
git show HEAD:packages/tui/src/transferRun.ts > /tmp/before.ts
diff /tmp/before.ts packages/frontend/src/transferRun.ts
```

Expected: **only the import lines differ.** If anything else shows up, you edited logic during a move
— revert that part and do it in Task 5 or 6 where it belongs.

- [ ] **Step 7: Assert the dependency graph is not inverted**

```bash
cd ~/git/tn3270 && grep -rn "@tn3270/cli\|@tn3270/tui" packages/frontend/src/ packages/frontend/test/
```

Expected: **no output.** `frontend` must not import `cli` or `tui` — that would invert
`core ← frontend ← { cli, tui, canvas, gui, web }`. If the moved test needs a front end's arg parser,
leave that test behind in `packages/tui/test/` rather than inverting the graph.

- [ ] **Step 8: Commit**

```bash
cd ~/git/tn3270
git add -A packages/
git commit -F - <<'EOF'
refactor: move transferRun.ts from tui to frontend, byte-identical but for imports

The non-blocking transfer driver sat in packages/tui for historical reasons. Its own
header says it exists because "a TUI cannot block" -- equally true of a GUI and a web
gateway, both of which already declare @tn3270/frontend.

THIS IS WHAT KEEPS THE DFT ARM AT TWO WRITINGS RATHER THAN FOUR. There are two genuine
control flows, not four: the CLI's blocking poll-until-done (the s3270 line protocol
cannot report a completion arriving after its `ok`) and one event-driven driver that
TUI, GUI and web all want.

NO BEHAVIOUR CHANGE. Verified by diffing against the pre-move content: only the import
lines differ. Test count unchanged at 2085, and frontend still imports neither cli nor
tui, so the dependency graph is not inverted.

Independently valuable: this is the right home for the file whether or not protocol
selection proceeds.

Generated with AI

Co-Authored-By: SLAC AI
EOF
```

---

## PROGRESS — 2026-09-29

**Tasks 1-5 are DONE and committed. Task 6 is next and nothing about it has started.**

| Task | State | Commit |
|---|---|---|
| 1 baseline | done, no commit | — |
| 2 `looksLikeCutFrame` | done, mutation-verified | `7af6ef5` |
| 3 `cancelDftTransfer` + `handleClose` | done, both mutations verified | `bbeccb9` |
| 4 the move to `frontend` | done, no logic change | `e79b50f` |
| 5 both engines, gate deleted | done, four mutations verified | `6ed8e76` |
| 6-9 | **not started** | — |

**2097 tests in 82 files** (from 2093), build and typecheck clean.

### THREE THINGS TASK 6 MUST KNOW, all measured in Task 5

1. **`dft.data` DOES NOT EXIST and Task 6's snippet uses it.** `DftTransfer` exposes
   `result`/`complete`/`isMessage`/`retainedFrame`/`transferred` and nothing else
   (`dft.ts:175-183`). A received payload comes back on **`result.data`**, since `TransferResult`'s
   success arm is `{ ok: true; data?: Uint8Array }` (`ft/transfer.ts:98-100`). So
   `onTransferEnd` should read `result.data ?? new Uint8Array(0)` — and note it must capture
   `result` BEFORE the narrowing, exactly as `finish` already documents for the union.
2. **BOTH of Task 6's test snippets name `packages/frontend/test/transferRun.test.ts`, which does
   not exist.** The tests are in **`packages/tui/test/transferRun.test.ts`** and must stay there:
   they assert on a rendered 54-column status line through `tui`'s own `transferLines`, and
   `frontend` cannot import `tui`. Reuse that file's existing harness (`makeSession`, `in3270`,
   `withSpy`, `withField`, `fakeFiles`, `aReceive`, `aSend`, `base`) rather than writing the
   plan's `connected24x80`/`sendOptions` factories, which do not exist either.
3. **`session.ddmAdvertised` still does not exist** — unchanged from the note below. Add the
   one-line getter over `this.opts.ddm`, with a test, inside Task 6's commit.

**`CUT_SCREEN_SIZE` is still imported in `transferRun.ts`** — the plan expected it to become
unused, but Task 5's `cancel` guard needs it and so does Task 6's timeout table.

### THE DEFECT TASK 5 INTRODUCED, fixed in the same commit — read this before Task 7

**The geometry gate was load-bearing for `cancel`, not only for stepping.**
`CutTransfer.cancel` writes the response area through `writeResponse` → `requireCutGeometry`,
which **throws `CutFrameError` on any geometry but 24x80** (`frames.ts:314`). The gate had made
that line unreachable at 43x80; deleting it let the throw escape uncaught into the TUI's
form-close path. `cancel` now reports at a non-CUT geometry instead of aborting, and sends no PF2
— there is no frame layout to write into and the host never said it was running CUT.

**TASK 7 HAS THE SAME HAZARD IN `runner.ts`**, which also builds a `CutTransfer` and can cancel
it. Check every `CutTransfer` method the CLI can reach at a non-24x80 geometry, not just `step`.

**SEVEN PLAN DEFECTS FOUND SO FAR, all by reading the code the plan described** — the pattern this
project keeps hitting, so expect more in Tasks 6-9 (three of the seven are in Task 6's own text,
listed above):

1. **Task 2's test path was wrong**: the CUT tests live in `packages/core/test/ft/`, not the flat
   `test/`. Corrected before writing.
2. **Task 4's consumer was wrong**: it is `tui/src/app.ts:29`, not `transferOverlay.ts`.
3. **Task 4's export style was wrong**: `frontend/src/index.ts` uses explicit named exports
   throughout, not `export *`. The index doubles as documentation of what is shared, so the
   convention matters.
4. **Task 4's test file could NOT move**, and the plan's step 7 anticipated exactly this. It asserts
   on a rendered 54-column status line through `tui`'s own `transferLines`, so it stays in
   `tui/test/` importing `startTransfer` from `@tn3270/frontend`. That direction is fine; only the
   reverse inverts the graph.
5. **Task 5's and Task 6's `request` literal omits `host`, `mode` and `cr`**, which
   `TransferRequest` requires (`transfer.ts:74-85`). It would not have compiled.
6. **Task 5's and Task 6's test path is `frontend/test/`, which does not exist** — defect 4 above,
   recurring in every task written before it was found.
7. **Task 6's `dft.data` does not exist.** See the Task 6 notes above.

**AND ONE FINDING THAT IS NOT A PLAN DEFECT BUT COST THE SAME TIME.** Deleting a test that asserts
a refusal is not a one-line change: the 43x80 case in *"EVERY local refusal happens before the host
is told"* would have gone on **passing**, on the unformatted-screen refusal one check further down,
while no longer testing geometry at all. A vacuous pass, of exactly the kind this branch keeps
finding. **When a gate is deleted, check whether each of its tests now passes for a different
reason** rather than trusting that a green suite means the expectation was updated.

**Two things Task 5 should know before it starts:**

- `startTransfer`'s options type is **`StartTransferOptions`** and it is now exported from
  `@tn3270/frontend` (added to the index in Task 4). The Task 5 test snippet's `sendOptions` factory
  can import it from `../src/transferRun.js`.
- **`session.ddmAdvertised` still does not exist.** Task 6's timeout message needs it. Add a
  one-line getter on `Session` returning `this.opts.ddm === true`, with a test, and commit it inside
  Task 6.

---

### Task 5: `frontend/transferRun.ts` — drop the geometry gate, build both engines

**Files:**
- Modify: `packages/frontend/src/transferRun.ts`
- Test: `packages/frontend/test/transferRun.test.ts`

This task makes the driver protocol-agnostic *up to the point of deciding*. Task 6 adds the DFT arm.

- [ ] **Step 1: Write the failing test**

Append to `packages/frontend/test/transferRun.test.ts`:

```typescript
// `StartTransferOptions` and `Session` are types the factory below annotates with.
// Both are exported already -- `StartTransferOptions` from transferRun.ts:51, which
// Task 4's `export *` carries -- so this needs no new export.
import type { StartTransferOptions } from '../src/transferRun.js';
import type { Session } from '@tn3270/core';

/**
 * One options factory for every selection test, so no test carries a placeholder.
 *
 * `onDone` is overridable because two tests need to await the outcome; the rest only
 * care whether `startTransfer` refused up front.
 */
function sendOptions(
  session: Session,
  onDone: (r: { ok: boolean; error?: string; bytes?: number }) => void = () => {},
): StartTransferOptions {
  return {
    session,
    files: fakeFiles({ 'local.txt': new Uint8Array([1, 2, 3]) }),
    request: {
      direction: 'send',
      localFile: 'local.txt',
      hostFile: 'REMOTE TXT A',
      exist: 'keep',
    },
    command: 'IND$FILE PUT REMOTE TXT A',
    onProgress: () => {},
    onDone,
  };
}

describe('protocol selection: the geometry gate is gone', () => {
  it('does not refuse a 43x80 session before the host is asked', () => {
    // THE ONE DELETION. Today this returns { ok: false } naming -model 3278-2-E,
    // before a byte reaches the host. Under host-chooses-the-protocol we cannot know
    // CUT was chosen until the host answers, so the check moves to the decision point.
    const { session } = connected43x80();
    const run = startTransfer(sendOptions(session));

    expect(run.ok).toBe(true);
  });

  it('still refuses when not in 3270 mode, at any geometry', () => {
    // The other local checks are UNCHANGED and must stay reachable. Order matters:
    // this used to be reported only after geometry passed.
    const { session } = notNegotiated43x80();
    const run = startTransfer(sendOptions(session));
    expect(run.ok).toBe(false);
    expect(run.error).toContain('not in 3270 mode');
  });

  it('registers the DFT transfer BEFORE the host is primed', () => {
    // A fast host's first 0xd0 arrives from inside record handling, before any driver
    // code runs again. If registration happened after sendAID(ENTER) it could be lost
    // to that race, and handleTransferData would drop the frame.
    const { session } = connected24x80();
    startTransfer(sendOptions(session));
    expect(session.dftTransfer).toBeDefined();
  });
});
```

**Write the four helpers (`connected43x80`, `notNegotiated43x80`, `connected24x80`, `fakeFiles`)
using whatever the existing tests in this file already use** — read the file's top and reuse its
harness rather than inventing a second one. `request`'s field names above must match
`TransferRequest` in `packages/frontend/src/transfer.ts`; read it and correct them if they differ.

- [ ] **Step 2: Run and watch it fail**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/transferRun.test.ts -t "geometry gate is gone"
```

Expected: FAIL — the 43x80 case returns `ok: false` with the `-model 3278-2-E` message, and
`session.dftTransfer` is `undefined`.

- [ ] **Step 3: Delete the geometry gate and register both engines**

In `packages/frontend/src/transferRun.ts`, **delete** the whole `if (session.screen.size !== CUT_SCREEN_SIZE) { ... }`
block (the one whose comment begins "GEOMETRY, before anything else"). Replace it with nothing — the
`is3270Mode` check becomes the first check.

Keep that block's hard-won message text somewhere: it moves to the timeout table in Task 6. **Do not
lose the "remedy leads" wording** — it exists because a live run truncated it at 54 columns.

Then, where `const transfer = new CutTransfer({...})` is built, build both and register the DFT one:

```typescript
  // BOTH ENGINES, over the SAME source buffer. The host chooses the protocol, not us
  // (x3270's `ft_running` merely REPORTS which arrived, ft.c:556), so we cannot know
  // which we need until the first frame lands. Both need their source bytes up front
  // anyway -- CUT to answer a retransmit, DFT to answer a GET -- so this is one extra
  // object over one Uint8Array, not a second copy.
  const cut = new CutTransfer({
    direction: request.direction,
    ...(source !== undefined ? { data: source } : {}),
  });
  const dft = new DftTransfer({
    direction: request.direction,
    ...(source !== undefined ? { data: source } : {}),
  });

  // REGISTERED BEFORE THE HOST IS TOLD ANYTHING, and the order is load-bearing: a fast
  // host's first 0xd0 arrives from inside `handleRecord`, before any driver code runs
  // again, and `handleTransferData` needs a registered transfer at that moment. Doing
  // this after sendAID(ENTER) would lose the first frame of a fast transfer to a race.
  session.startDftTransfer(dft);
```

Rename the existing `transfer` references in the CUT path to `cut`. Add `DftTransfer` to the
`@tn3270/core` import, and drop `CUT_SCREEN_SIZE` if nothing else uses it (the compiler will say).

Update the module header's *ORDER OF OPERATIONS* section: it currently claims geometry comes before
3270 mode and that the order is load-bearing for that reason. Replace that paragraph with:

```
 * The checks are in the CLI's order. Geometry is NO LONGER AMONG THEM: under
 * host-chooses-the-protocol we cannot know CUT was chosen until the host answers, so the
 * 24x80 demand moved to the decision point (see `docs/superpowers/specs/
 * 2026-09-25-transfer-protocol-selection-design.md`). The accepted cost is that a CUT-only
 * host at 43x80 is now primed before we find out; measured on VM/370, MECAFF refuses with
 * its own text in about a second and CMS recovers itself, so nothing wedges.
```

- [ ] **Step 4: Run and verify**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/transferRun.test.ts
```

Expected: the three new tests PASS. **Some existing tests in this file will now fail** — any that
asserted the 43x80 refusal. Those are expectation updates, not regressions: change them to assert the
new behaviour, and keep one that pins the *message text* for the timeout path in Task 6.

- [ ] **Step 5: Full suite**

```bash
cd ~/git/tn3270 && npm run build && npm test 2>&1 | grep -E "Test Files|Tests  |FAIL"
```

Expected: green. **`conformance.test.ts` and `golden.test.ts` (12) and the whole CUT suite must pass
untouched** — the spec's own words: "If the CUT path changes behaviour at 24x80, this design is
wrong."

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/frontend/
git commit -F - <<'EOF'
feat(frontend): transferRun builds both engines and drops the geometry gate

The one deletion this design makes. A 43x80 session is no longer refused before the
host is asked, because under host-chooses-the-protocol we cannot know CUT was chosen
until the host answers -- x3270's ft_running merely REPORTS which protocol arrived
(ft.c:556) and it has no selection logic at all.

Both engines are now built over ONE source buffer, which costs one object rather than a
second copy since both need their bytes up front anyway (CUT to answer a retransmit,
DFT to answer a GET). The DFT engine is registered BEFORE the host is primed: a fast
host's first 0xd0 arrives from inside handleRecord before any driver code runs again, so
registering after sendAID(ENTER) would lose it to a race.

The whole CUT suite, conformance and golden pass untouched, which is the real safety net
here.

Generated with AI

Co-Authored-By: SLAC AI
EOF
```

---

### Task 6: `frontend/transferRun.ts` — the DFT arm and the decision

**Files:**
- Modify: `packages/frontend/src/transferRun.ts`
- Test: `packages/frontend/test/transferRun.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('protocol selection: deciding', () => {
  it('a CUT frame commits to CUT and cancels the DFT registration', async () => {
    const { session, conn } = connected24x80();
    startTransfer(sendOptions(session));
    expect(session.dftTransfer).toBeDefined();

    hostWritesCutFrame(conn);      // helper: paint an auto-skip attribute at O_SF

    expect(session.dftTransfer).toBeUndefined();
  });

  it('a DFT host completes with ZERO screen events', async () => {
    // THE TEST THAT CATCHES THE SPIN-TO-TIMEOUT BUG. A DFT transfer writes no screen
    // at all, so a driver waking only on `screen` would spin to its timeout on a
    // perfectly healthy transfer. Assert the COUNT is zero, not merely that it worked.
    const { session, conn } = connected24x80();
    let screens = 0;
    session.on('screen', () => { screens++; });
    let resolve!: (r: { ok: boolean; error?: string; bytes?: number }) => void;
    const done = new Promise<{ ok: boolean; error?: string; bytes?: number }>((r) => { resolve = r; });

    startTransfer(sendOptions(session, resolve));
    hostRunsWholeDftTransfer(conn);   // helper: OPEN, GET, DATA, CLOSE, EOF

    const result = await done;
    expect(result).toMatchObject({ ok: true });
    expect(screens).toBe(0);
  });

  it('notices a DFT transfer that finished BEFORE the first wait', async () => {
    // CHECK STATE FIRST, THEN WAIT. A whole DFT transfer can begin and finish inside
    // record handling; a driver that only subscribes has already missed it and hangs
    // in a way that looks exactly like the spin-to-timeout bug.
    const { session, conn } = connected24x80();
    // Drive the entire transfer synchronously from inside startTransfer's own call
    // stack, so no listener registered afterwards could have seen it.
    const result = await startTransferAndCompleteSynchronously(session, conn);
    expect(result).toMatchObject({ ok: true });
  });
});
```

Write the three helpers (`hostWritesCutFrame`, `hostRunsWholeDftTransfer`,
`startTransferAndCompleteSynchronously`) against the DFT frame fixtures the Task 4-9 engine tests
already use — find them with `grep -rn "TR_OPEN_REQ\|0xd0" packages/core/test/dftFrames.test.ts
packages/core/test/dftSession.test.ts`. `sendOptions` is the factory defined in Task 5; reuse it.

- [ ] **Step 2: Run and watch them fail**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/transferRun.test.ts -t "deciding"
```

Expected: FAIL — the CUT case leaves `dftTransfer` defined, and both DFT cases time out or never
resolve.

- [ ] **Step 3: Implement the decision**

In the `onScreen` handler, replace `if (!isCutFrame(session.screen)) return;` with:

```typescript
    // DECIDE, using the non-throwing detector: at this point the geometry may be
    // anything, because no check upstream demanded 24x80 any more.
    if (!looksLikeCutFrame(session.screen)) {
      // The host is painting something that is not a CUT frame. Keep waiting, but
      // REMEMBER we saw it -- the timeout message distinguishes "nothing at all" from
      // "screens, none of them a frame", and those want different diagnoses.
      sawNonFrameScreen = true;
      return;
    }
    // CUT HAS WON. Release the DFT registration before stepping, so a stray inbound
    // read cannot replay a retained frame at a host now running CUT.
    if (!committed) {
      committed = 'cut';
      session.cancelDftTransfer();
    }
```

Declare beside the other run state:

```typescript
  let committed: 'cut' | 'dft' | undefined;
  let sawNonFrameScreen = false;
```

Add the DFT completion handler, and **check state before waiting**:

```typescript
  /**
   * DFT finished. `Session` has already cleared its own reference and fired
   * `transferEnd`; we read the outcome from the engine reference we kept.
   */
  const onTransferEnd = (): void => {
    if (ended) return;
    committed = 'dft';
    const result = dft.result ?? { ok: false, error: 'DFT transfer ended without a result' };
    if (result.ok && request.direction === 'receive') {
      const bytes = dft.data ?? new Uint8Array(0);
      try {
        if (request.exist === 'append') files.append(request.localFile, bytes);
        else files.write(request.localFile, bytes);
      } catch (err) {
        finish({
          ok: false,
          error: `transfer complete but could not write ${request.localFile}: `
            + `${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    finish(result);
  };
```

**Read `DftTransfer`'s real surface first** — `packages/core/src/ft/dft.ts:175-192` has
`get result()`, `get complete()`, `get transferred()`. If there is no `data` accessor for a received
payload, find how the engine hands bytes back and use that; do not invent an accessor.

Register it beside the screen listener, and **then immediately test whether it already happened**:

```typescript
  session.on('screen', onScreen);
  session.on('transferEnd', onTransferEnd);
  session.sendAID(AID.ENTER);

  // CHECK STATE BEFORE WAITING. A whole DFT transfer can begin AND FINISH inside
  // `sendAID`'s record handling -- the frames arrive from `onRecord` and nothing yields
  // to us in between -- so a driver that only subscribes has already missed it. The
  // symptom is a hang indistinguishable from the spin-to-timeout bug this driver exists
  // to avoid.
  if (dft.complete) {
    onTransferEnd();
    return { ok: true };
  }
```

Add `session.off('transferEnd', onTransferEnd);` to `finish`, beside the existing
`session.off('screen', onScreen);` — a leaked listener per transfer is invisible except as wasted
CPU, which is why `Session.listenerCount` exists.

Finally, the timeout message. Replace the single message with the spec's table, **action first**
because the TUI status line is 54 columns and truncates:

```typescript
  const timeout = (why: string): void => {
    // THE RECOVERY COMES FIRST. Measured: the TUI's status line is 54 columns and
    // truncates, and an earlier version put the one actionable phrase past the cut.
    let extra = '';
    if (sawNonFrameScreen && session.screen.size !== CUT_SCREEN_SIZE) {
      // FALLBACK ONLY. Measured on VM/370: MECAFF answers `IND$FILE requires a MECAFF
      // connected 3270 terminal` and CMS recovers in ~1s, so the host's own text
      // usually arrives and IS BETTER THAN OURS. This row is for a host that goes quiet.
      extra = ` (host may want 24x80; this session is ${session.screen.rows}x${session.screen.cols})`;
    } else if (!sawNonFrameScreen && !session.ddmAdvertised) {
      // Earns its place: forgetting `-ddm on` will be the commonest failure once DFT
      // works, because a DFT-only host cannot choose DFT unless we advertised 0x95.
      extra = ' (DDM was not advertised; a host that speaks only DFT needs -ddm on)';
    }
    finish({
      ok: false,
      error: `press Attn or Clear: host may still be transferring. `
        + `${why}, ${cut.bytesTransferred} bytes${extra}`,
    });
  };
```

**`session.ddmAdvertised` does not exist.** Either add a trivial getter on `Session` returning
`this.opts.ddm === true` (preferred — one line, and the driver has no other route to it) or thread the
flag through `StartTransferOptions`. Whichever you choose, **write the test for it**; if you add the
getter, that is a fourth small `Session` change and belongs in this task's commit.

- [ ] **Step 4: Run and verify**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/transferRun.test.ts
```

Expected: all PASS.

- [ ] **Step 5: MUTATION CHECK 1 — the `transferEnd` wake signal**

Comment out `session.on('transferEnd', onTransferEnd);` **and** the `if (dft.complete)` block.
Rebuild, re-run.

Expected: the DFT tests FAIL (hang to timeout). Revert both.

- [ ] **Step 6: MUTATION CHECK 2 — `cancelDftTransfer()` on CUT commitment**

Remove the `session.cancelDftTransfer()` call from `onScreen`. Rebuild, re-run.

Expected: the *"commits to CUT and cancels the DFT registration"* test FAILS. **The spec is explicit:
"If nothing does, the call is decoration and should be deleted rather than kept."** Report that in AS
BUILT if so. Revert.

- [ ] **Step 7: MUTATION CHECK 3 — check-state-before-waiting**

Remove only the `if (dft.complete) { ... }` block, leaving the listener. Rebuild, re-run.

Expected: the *"finished BEFORE the first wait"* test FAILS. If it passes, the test is not actually
completing the transfer inside the call stack — **fix the test**, because this is the ambiguity the
spec resolved explicitly.

- [ ] **Step 8: Full suite, then commit**

```bash
cd ~/git/tn3270 && npm run build && npm test 2>&1 | grep -E "Test Files|Tests  |FAIL"
```

```bash
cd ~/git/tn3270
git add packages/frontend/ packages/core/
git commit -F - <<'EOF'
feat(frontend): the DFT arm -- transferRun now waits for either protocol

The first frame decides. A CUT frame commits to CUT and releases the DFT registration;
a DFT transfer completes through `transferEnd` with the engine reference the driver
kept. Both converge on the same write-the-file/report-N-bytes tail, so Exist= and the
completion message stay in one place.

TWO NON-OBVIOUS THINGS, both from the spec and both mutation-verified:

1. A DFT transfer produces ZERO screen events, so a driver waking only on `screen`
   would spin to its timeout on a HEALTHY transfer. The test asserts the screen count
   is zero rather than merely that the transfer worked.
2. CHECK STATE BEFORE WAITING. A whole DFT transfer can begin and finish inside
   sendAID's record handling, so a driver that only subscribes has already missed it --
   and hangs in a way indistinguishable from the bug in (1). `if (dft.complete)` runs
   before any wait is entered.

The timeout message now reports what was OBSERVED, and its 43x80 row is a FALLBACK
only: measured on VM/370, MECAFF refuses with its own text in ~1s and CMS recovers
itself, and the host's text beats ours whenever it exists.

Generated with AI

Co-Authored-By: SLAC AI
EOF
```

---

### Task 7: `cli/runner.ts` — the same change in the blocking idiom

**Files:**
- Modify: `packages/cli/src/runner.ts`
- Test: `packages/cli/test/commands.test.ts` (or wherever `Transfer()` is tested — find with
  `grep -rln "Transfer(" packages/cli/test/`)

The CLI keeps its blocking poll loop; the spec is explicit that collapsing the two drivers is a
line-protocol behaviour change and out of scope.

- [ ] **Step 1: Write the failing tests**

Mirror Task 5 and 6's cases in the CLI's idiom, over its existing `FakeConnection` harness:

```typescript
describe('Transfer() protocol selection', () => {
  it('does not refuse 43x80 before the host is asked', async () => {
    // Today: throws "CUT file transfer needs a 24x80 screen" at runner.ts:454.
  });

  it('a DFT host completes, and the poll loop does not wait for a screen', async () => {
    // The CLI's loop waits on `this.outputCount` changing. A DFT transfer never
    // changes it, so without a second wake signal this spins to transferMs.
  });

  it('a CUT host at 24x80 is byte-for-byte unchanged', async () => {
    // The real safety net. Assert on the WIRE, not just on success.
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/cli/test/ -t "protocol selection"
```

- [ ] **Step 3: Implement**

In `packages/cli/src/runner.ts`:

1. **Delete** the `if (this.session.screen.size !== 1920) { throw ... }` block at ~line 450, and
   update the method doc above it (which lists geometry among the local checks).
2. Build both engines and register the DFT one before `primeAndType`, exactly as Task 5 did.
3. In `runTransferFrames`, add the second wake condition. The inner wait is currently:

```typescript
      while (this.outputCount === processedOutput || !isCutFrame(this.session.screen)) {
```

It must also break when DFT has finished, and must use the non-throwing detector:

```typescript
      // TWO WAKE SIGNALS NOW. The loop polls `outputCount`, which a DFT transfer never
      // changes -- it writes no screen at all -- so a healthy DFT run would spin to
      // `transferMs` without this. `looksLikeCutFrame`, not `isCutFrame`, because the
      // geometry gate above is gone and the old one throws at 43x80.
      while (!dft.complete
        && (this.outputCount === processedOutput || !looksLikeCutFrame(this.session.screen))) {
```

and immediately after the wait, before stepping CUT:

```typescript
      if (dft.complete) return dft.result ?? { ok: false, error: 'DFT transfer ended without a result' };
```

4. **Check state before the loop is entered**, for the same reason as Task 6: a whole DFT transfer can
   finish inside `sendAID(ENTER)`'s record handling. Put the check between `sendAID` and the loop.
5. On the first CUT frame, `this.session.cancelDftTransfer()`.
6. Extend the timeout message with the same observed-state rows.

- [ ] **Step 4: Verify, and mutation-check the wake signal**

```bash
cd ~/git/tn3270 && npm run build && npm test 2>&1 | grep -E "Test Files|Tests  |FAIL"
```

Then remove `!dft.complete` from the `while` condition, rebuild, re-run: the DFT CLI test must
FAIL (spin to timeout). Revert.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/cli/
git commit -F - <<'EOF'
feat(cli): Transfer() waits for either protocol, in the blocking idiom

Same change as the event-driven driver, in the CLI's poll loop. The geometry gate at
runner.ts:454 is gone; both engines are built over one buffer and the DFT one is
registered before the host is primed.

THE POLL LOOP NEEDED A SECOND WAKE CONDITION. It waits on `outputCount` changing, and a
DFT transfer never changes it -- it writes no screen at all -- so a HEALTHY DFT run
would have spun to transferMs. Mutation-verified by removing `!dft.complete` from the
while condition.

`looksLikeCutFrame` replaces `isCutFrame` in the wait, because with the geometry gate
gone the old one would throw at 43x80 from inside the loop.

The two drivers are deliberately NOT collapsed: that changes the s3270 line protocol's
behaviour, which transferRun.ts's header documents as the reason they diverge.

Generated with AI

Co-Authored-By: SLAC AI
EOF
```

---

### Task 8: Full gate, and the live runs

**Files:** none modified unless the gate finds something.

- [ ] **Step 1: The offline gate, all of it**

```bash
cd ~/git/tn3270
npx tsc --build --force packages/gui      # or the staleness guard reddens on mtimes
npm run build && npm test 2>&1 | grep -E "Test Files|Tests  |FAIL"
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
python3 packages/cli/scripts/drive-playback.py 2>&1 | tail -2
python3 packages/cli/scripts/drive-e.py 2>&1 | tail -2
export DISPLAY=:99; unset HTTP_PROXY http_proxy HTTPS_PROXY https_proxy
[ -S /tmp/.X11-unix/X99 ] || (nohup Xvfb :99 -screen 0 1280x1024x24 >/tmp/xvfb.log 2>&1 &)
node packages/gui/scripts/shot.mjs 2>&1 | tail -2
node packages/gui/scripts/keys.mjs 2>&1 | tail -2
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2
```

Expected, matching the 2026-09-28 baseline: build/typecheck clean, `pty-smoke` 12/12,
`drive-playback` 10/10, `drive-e` 10/10, `shot` 3/3, `keys` 18 chords/16 actions, `clicks` 9
buttons/10 actions, `browser-shot` 2/2, `browser-keys` 13 chords/11 actions.

**`--no-proxy-server` / unsetting the proxy vars is mandatory** — with `HTTP_PROXY` set, Chromium
routes even loopback through the proxy, ignores `no_proxy`, and fails totally silently.

- [ ] **Step 2: The DFT live run on TK5 — this is DFT plan Task 10**

```bash
cd ~/git/tn3270
node packages/cli/dist/index.js -insecure -ddm on -model 3278-4-E -trace /tmp/dft-tso.trace \
  -script packages/cli/scripts/dft-tso.txt 127.0.0.1:3271
```

**JUDGE IT BY TRACE, NOT BY THE FILE.** Both protocols now end in a transferred file, so success
proves nothing about which ran:

```bash
grep -c "FileTransferData" /tmp/dft-tso.trace     # expect: > 0 for DFT
```

That trace line exists because adding the `transferData` variant broke an exhaustive switch in
`parse.ts`, which is what forced DFT frames to be named rather than logged as `unknownSF(0xd0,38B)`.

- [ ] **Step 3: The VM CUT control — prove no regression**

```bash
node packages/cli/dist/index.js -insecure -model 3278-2-E -trace /tmp/cut-vm.trace \
  -script packages/cli/scripts/transfer-vm.txt 127.0.0.1:3270
```

Expected: a successful CUT round-trip with **zero** `FileTransferData` lines.

**THE VM RECONNECT TRAP WILL COST YOU A FALSE FAILURE IF YOU IGNORE IT.** A VM account left logged on
*reconnects* rather than refusing, landing the script at `CP READ` where CP answers `?CP: IND$FILE`
and runs nothing — a 0-byte timeout that looks exactly like our bug. The script must prove its state
(`QUERY DISK A` → `Ready;` means CMS; `?CP: QUERY` means the run is void) and you must check the log
for `LOGOFF AT` before trusting a rerun. **And if the machine is reconnected, ASK THE USER before
logging it off — the session may be theirs, not yours.**

- [ ] **Step 4: Record both runs in the runbook**

Append to `docs/live-testing.md` with the date, the exact commands, and the trace evidence — the
`FileTransferData` count for each. State plainly if either run did not happen.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add docs/live-testing.md
git commit -m "docs: live runs for protocol selection -- DFT on TK5, CUT control on VM

Judged by trace, not by the transferred file: both protocols now end in a file, so only
the FileTransferData line distinguishes them.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 9: Update the DFT plan and HANDOFF, then finish the branch

**Files:**
- Modify: `docs/superpowers/plans/2026-09-24-dft-file-transfer.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Mark DFT Task 10 unblocked and done**

The top of Task 10 in the DFT plan carries the blocker note this whole spec answers. Replace it with
an AS BUILT section: what selected DFT, the trace evidence, and anything the plan got wrong.

- [ ] **Step 2: Add an AS BUILT note to every task in THIS plan**

Record defects found in the plan itself. **Expect several** — on the last three branches nearly all
defects were in the plan rather than the code, and that is the point of telling implementers the
source beats the plan.

- [ ] **Step 3: Update `docs/HANDOFF.md`**

Its *START HERE* currently says the next step is `writing-plans` for this spec. Replace with the real
state: test count, what shipped, what the live runs proved, and what remains (DFT Tasks 11-12, the
`BufferSize`/`dftBufferSize` pair that must agree, and a transfer UI for GUI/web).

- [ ] **Step 4: Offer the merge**

Use `superpowers:finishing-a-development-branch`. **Re-run the full gate ON THE MERGE COMMIT, not just
the branch** — that is this project's standing rule, and `--no-ff` is how the last five features
merged.

**Note for whoever merges:** `main` already carries the pending-AID commit (`43d1a85`) and this branch
carries the graphics docs; the two hold different halves of 2026-09-28's work deliberately. Check
`git merge-base` before merging anything to `main` — branching off the wrong base once already dragged
44 unfinished commits onto it.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| `core/src/ft/detect.ts`, non-throwing contract | 2 |
| `isCutFrame` unchanged and still throwing | 2 (stated), 5/7 (callers switched) |
| `Session.cancelDftTransfer()` | 3 |
| `handleClose` clearing `dft` | 3 |
| `transferRun.ts` move, done FIRST | 4 |
| Graph assertion: `frontend` imports neither `cli` nor `tui` | 4 step 7 |
| Hash-verify the move | 4 steps 1, 6 |
| Geometry check deleted; other local checks keep order | 5 |
| Both engines over one buffer; register before priming | 5 |
| The deciding table (CUT / DFT / other screen) | 6 |
| Check state before waiting | 6, 7 |
| Zero-`screen`-events assertion | 6 |
| Timeout table with observed state | 6, 7 |
| `-ddm on` row | 6 |
| Cancel while uncommitted, nothing on the wire | **GAP — see below** |
| Mutation: remove `transferEnd` wake | 6 step 5, 7 step 4 |
| Mutation: remove `cancelDftTransfer()` | 6 step 6 |
| Mutation: make `looksLikeCutFrame` throw | 2 step 5 |
| CUT suite / conformance / golden untouched | 5 step 5, 7 step 4, 8 step 1 |
| Live: DFT on TK5, CUT control on VM, judged by trace | 8 |

**One gap found and closed here rather than left implicit:** the spec's *Cancellation* paragraph
requires that cancelling while **uncommitted** abandons the wait, reports cancelled, and **synthesises
no abort** — and its test list names "Cancel while uncommitted → reports cancelled and nothing goes on
the wire." Add this to **Task 6** as a fourth test and a branch in the returned `cancel`:

```typescript
    cancel: (): void => {
      if (ended) return;
      if (committed === undefined) {
        // UNCOMMITTED: there is no engine to talk to. Abandon the wait and report.
        // NO SYNTHESISED ABORT -- an abort writes the response area and presses PF2 from
        // a frame CutTransfer has parsed, so fabricating one puts bytes on the wire that
        // no captured session contains.
        session.cancelDftTransfer();
        finish({ ok: false, error: 'transfer canceled by user' });
        return;
      }
      if (committed === 'dft') {
        // DFT defers its abort to the next inbound frame, matching x3270 -- a deliberate
        // divergence documented in dft.ts.
        dft.cancel();
        return;
      }
      const step = cut.cancel(session.screen);
      if (step.ack !== undefined) session.sendAID(step.ack);
      finish(step.done ?? { ok: false, error: 'transfer canceled by user' });
    },
```

Its test must assert the wire is **empty** after the cancel, not merely that the run reported
cancelled.
