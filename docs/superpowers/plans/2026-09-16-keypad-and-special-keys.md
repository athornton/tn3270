# Virtual Keypad and Special Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clickable virtual keypad to the two canvas front ends, a keyboard-navigable
special-keys overlay to the TUI, and the three 3270 keys the stack cannot currently send — Sys Req,
Dup and Field Mark.

**Architecture:** The keypad is a third `DrawList` region beside the `oia` one that already exists,
built where `drawList` is called (Electron's main, the gateway's server) so window resizing, browser
scrolling and the pixel goldens keep working with no new plumbing. The key *table* lives in
`packages/frontend` because both package graphs reach it; the cell *layout* lives in
`packages/canvas`; the renderer gains only hit-testing. The TUI renders the same table as a list.

**Tech Stack:** TypeScript (ES2023, NodeNext), vitest, Electron 44 under Xvfb, no new runtime
dependencies.

**Read first:** `docs/superpowers/specs/2026-09-16-keypad-and-special-keys-design.md`. Its
*Facts established from sources* table is not optional context — four of those facts change the
implementation, and one (Dup suppressing auto-skip) is invisible from the key's name.

**Verify, do not trust this plan.** Most defects found on the last two branches were in the plan
rather than in the code. If a signature here disagrees with the source, the source wins — say so in
the task's report rather than making the code match the plan.

## EXECUTION ORDER WAS CHANGED, 2026-09-16: RUN 5, 6, 7 BEFORE 4

**As numbered, this plan bound `Ctrl-K` to `toggleKeypad` (Task 4) roughly ten commits before any front
end intercepted it (Tasks 8, 9, 12) — and `applyAction` THROWS on that action. Measured consequences of
the original order:**

**The line numbers in the three bullets below were measured against the tree AS IT WAS when this
section was written, and every one of them has since moved — Tasks 8, 12 and 13 inserted code above
each. They are kept as the historical measurement and each is followed by the current NAME**, which
is the form Task 15's sweep converted them to; see step 3b.

- **TUI: process death on a keystroke.** `tui/src/app.ts:497` called `applyAction` unguarded, from the
  stdin `data` handler. **Now `App.apply` (`app.ts:554`), which intercepts `toggleKeypad` above the
  call**, and `App.fireOverlay` (`:689`), which is reached only from the list.
- **Electron: main-process death on a keystroke.** `gui/src/main.ts:339` called it unguarded inside
  `ipcMain.on('action', ...)`. **Now `main.ts:365`, with the `toggleKeypad` intercept at `:361`.**
- **Web: safe, as it happens.** `decodeClientMessage`'s throw is caught at `web/src/main.ts:134`
  (**now `:150`**) and answered with an `error` frame, so a browser would see a banner rather than a
  dropped session. That safety came from Task 2's rejection at `protocol.ts:114`, which itself had to
  be pulled forward from Task 9 — see Task 2's AS BUILT note. **That rejection is GONE as of Task 9**,
  which replaced it with the real per-connection intercept; `protocol.ts:113-118` is now the comment
  explaining why the kind is deliberately *accepted*, which is a different claim at the same address.

**The fix is ordering, not a patch.** Tasks 5, 6 and 7 (the cell layout, the `DrawList` region, and the
renderer's drawing plus hit-testing) depend on the key TABLE and on `Action`, both of which Tasks 2-3
already landed. **None of them needs a chord.** Running them first means that when Task 4 binds `Ctrl-K`
it can land each front end's real flag in the same commit, with visible effect — instead of either
crashing or shipping a documented dead key for ten commits.

**THE GENERAL RULE, now twice-earned on this branch: a task that makes a throw REACHABLE and the task
that catches it must not be separated. If a plan splits them, reorder the plan or merge the commit —
the gap is a live defect, not a to-do.**

### THE FULL REVISED ORDER: 1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 4, 13, 14, 15

**Task 4 moves to LAST-BUT-THREE, because it is the task that arms the chord.** Every front end must be
able to intercept `toggleKeypad` before any keystroke can produce it: Task 8 gives Electron its flag,
Task 9 gives the gateway its per-connection flag, and Task 12 gives the TUI its overlay. Only then is
binding `Ctrl-K` safe.

**The dependency that forces this, and it is mutual:** Task 12's sketched tests drive the TUI with byte
`0x0b`, which needs Task 4's binding — while Task 4's binding needs Task 12's interception or the TUI
dies on the keystroke. **Resolution: Task 12 tests its interception by dispatching the ACTION directly
(`apply({ kind: 'toggleKeypad' })`), and Task 4 adds the byte-level test when it binds the chord.** So
each task is verifiable at the commit where it lands, and no commit in between has a reachable throw.

**Consequence for Task 8's step 3:** it cannot use `TN3270_GUI_KEYS='Ctrl+K'`, because nothing is bound
yet. Capture the font PNG by **temporarily defaulting `showKeypad = true`**, looking at the image, then
reverting — and say in the report that this is what was done. The chord path gets exercised for real at
Task 4.

---

### Task 1: DUP and Field Mark in core's keyboard

> **AS BUILT (commit `58384ef`). THREE DEFECTS IN THIS TASK'S TEXT, one of them its headline fact.
> Read this before writing any test that touches Dup.**
>
> 1. **`dup()` TABS; it does not "advance one position and stop".** Step 4 below is wrong. `kybd.c:1435`
>    does suppress `key_Character`'s auto-skip for a keyboard Dup, but `Dup_action` then moves the
>    cursor itself (`kybd.c:2790`), and the manual states the net behaviour outright (p. 7-12: "a Tab
>    key operation to be performed"). What the suppression buys is that the tab happens ONCE — our
>    `advanceAfterType` already tabs at end-of-field, so advancing first would skip a whole field.
>    Implemented as `write; setMDT; tab()`, with both halves mutation-checked.
> 2. **A numeric field TAKES Dup and refuses Field Mark.** The manual's permitted set names "the
>    duplicate (DUP) control" explicitly (p. 4-13). x3270's byte test refuses DUP too but is gated on
>    `appres.numeric_lock`, which has no default assignment and is therefore off.
> 3. **The MDT assertion in Step 1 could not work**, though NOT for the reason first recorded here.
>    `screen.cellAt(field.attrAddr).ebcdic & FA.MODIFY` is always 0, because `setFieldAttribute`
>    stores the attribute in `attrs[]` (`screen.ts:394`) and zeroes `chars[]` (`screen.ts:323`).
>    **The first version of this note said it would "pass vacuously"; the reviewer ran it and it
>    FAILS loudly** (`expected +0 to be 1`) — only the *pre*-assertion is vacuous. Used the file's own
>    idiom, `s.fieldAt(3)!.modified`, confirmed non-vacuous by deleting `setMDT`. A wrong diagnosis of
>    a real defect is still worth correcting: "vacuous" and "fails" call for opposite responses.
>
> Also: the constants went beside `Order`, not `PF_AIDS` — they are format control orders, not AIDs.
> The plan's four helper names were dropped for the file's existing `twoFields()`/`kb(s)` idiom plus a
> local `threeFields()`. `writeControl`'s second parameter is `'tab' | 'autoSkip'`, not a boolean,
> because a boolean could not express the correct behaviour. **10 tests, not 6. Suite at 1524.**
> (This line said "7 tests, suite at 1521" until the quality review caught it: `46d6b4b` added three
> more and the commit that rewrote the lines directly above left this one alone. That is the exact
> failure shape this repo keeps hitting — a later fix reaches the prose body and never the count that
> summarises it.)
>
> **Found but NOT fixed, deliberately:** neither `type()` nor `writeControl()` refuses a cursor parked
> *on* a field attribute byte, where x3270 does (`kybd.c:1219`). Parity with `type()` was kept; fixing
> it belongs in its own commit covering both and is not part of this feature.

**Files:**
- Modify: `packages/core/src/constants.ts` (add two constants near `PF_AIDS`)
- Modify: `packages/core/src/keyboard.ts` (add `dup`, `fieldMark`, private `writeControl`)
- Test: `packages/core/test/keyboard.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/keyboard.test.ts`. Match the file's existing helper for building a
screen — read the top of the file and reuse it rather than writing a new one.

```ts
describe('dup and fieldMark', () => {
  /**
   * Both are TYPED CHARACTERS, not AIDs: x3270 implements them as
   * `key_Character(EBC_dup/EBC_fm, ...)` at kybd.c:2788 and :2825. The bytes are
   * EBC_dup = 0x1c and EBC_fm = 0x1e, from 3270ds.h:364-365.
   */
  it('write 0x1c and 0x1e into the buffer', () => {
    const { screen, kbd } = newKeyboardWithUnprotectedField();
    const at = screen.cursor;
    expect(kbd.dup()).toBe(true);
    expect(screen.cellAt(at).ebcdic).toBe(0x1c);

    const at2 = screen.cursor;
    expect(kbd.fieldMark()).toBe(true);
    expect(screen.cellAt(at2).ebcdic).toBe(0x1e);
  });

  it('set MDT, because the host must see the field changed', () => {
    const { screen, kbd, field } = newKeyboardWithUnprotectedField();
    expect(screen.cellAt(field.attrAddr).ebcdic & FA.MODIFY).toBe(0);
    kbd.dup();
    expect(screen.cellAt(field.attrAddr).ebcdic & FA.MODIFY).toBe(FA.MODIFY);
  });

  it('DUP does NOT auto-skip at the end of a field, and Field Mark DOES', () => {
    // THE NON-OBVIOUS ONE. kybd.c:1435 reads
    //   if (auto_skip && (pasting || (ebc != EBC_dup)))
    // commented "for all pasted data (even DUP), and for all keyboard-generated data
    // except DUP". So a keyboard Dup advances one position and stops even if that lands
    // on a field attribute, where an ordinary character would tab to the next field.
    const a = newKeyboardAtLastCellOfField();
    a.kbd.dup();
    expect(a.screen.cursor).toBe(a.screen.inc(a.lastCell));

    const b = newKeyboardAtLastCellOfField();
    b.kbd.fieldMark();
    expect(b.screen.cursor).not.toBe(b.screen.inc(b.lastCell));
  });

  it('are refused in a protected field, with the reason in the OIA', () => {
    const { kbd, oia } = newKeyboardWithProtectedField();
    expect(kbd.dup()).toBe(false);
    expect(oia.isInhibited()).toBe(true);
  });

  it('are refused in a NUMERIC field, because x3270 tests the EBCDIC byte', () => {
    // kybd.c:1232-1238 permits only EBC_0..EBC_9, plus, minus, period and comma. 0x1c
    // and 0x1e are outside that set, so both keys are an operator error there.
    const { kbd } = newKeyboardWithNumericField();
    expect(kbd.dup()).toBe(false);
    expect(kbd.fieldMark()).toBe(false);
  });

  it('are refused while the host holds the keyboard locked', () => {
    const { kbd, oia } = newKeyboardWithUnprotectedField();
    oia.inhibit(KeyboardState.SystemWait);
    expect(kbd.dup()).toBe(false);
  });
});
```

You must write the four helpers (`newKeyboardWithUnprotectedField`,
`newKeyboardAtLastCellOfField`, `newKeyboardWithProtectedField`, `newKeyboardWithNumericField`) in
terms of whatever the file already uses to build a `Screen` and `Keyboard`. Do not invent a second
construction idiom.

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/keyboard.test.ts`
Expected: FAIL, `kbd.dup is not a function`.

- [ ] **Step 3: Add the constants**

In `packages/core/src/constants.ts`, beside the AID tables:

```ts
/**
 * The two EBCDIC control characters the Dup and Field Mark keys write.
 *
 * From x3270's `include/3270ds.h:364-365` (`EBC_dup` 0x1c, `EBC_fm` 0x1e), not from memory.
 *
 * They are CHARACTERS, not AIDs: x3270's Dup and FieldMark actions both call
 * `key_Character(...)` (`Common/kybd.c:2788`, `:2825`), so they go into the buffer and set MDT
 * exactly as a typed letter does. Nothing about them reaches `sendAID`.
 */
export const EBCDIC_DUP = 0x1c;
export const EBCDIC_FIELD_MARK = 0x1e;
```

- [ ] **Step 4: Implement the two keys**

In `packages/core/src/keyboard.ts`, import the constants and add, after `typeString`:

```ts
  /**
   * The Dup key: write 0x1c, and do NOT auto-skip.
   *
   * `kybd.c:1435` is `if (auto_skip && (pasting || (ebc != EBC_dup)))`, commented "for all pasted
   * data (even DUP), and for all keyboard-generated data except DUP". We have no paste path into
   * this method, so the keyboard rule is the only one: advance one position and stop, even if that
   * lands on a field attribute.
   */
  dup(): boolean {
    return this.writeControl(EBCDIC_DUP, false);
  }

  /** The Field Mark key: write 0x1e, and auto-skip like any other typed character. */
  fieldMark(): boolean {
    return this.writeControl(EBCDIC_FIELD_MARK, true);
  }

  /**
   * Write one EBCDIC control byte as if typed.
   *
   * DELIBERATELY NOT `type(ch)`: these bytes have no sensible Unicode source character, so
   * routing them through `codePage.fromUnicode` would mean inventing one. It also keeps
   * `type()`'s numeric test — a Unicode regex, live-verified — untouched, and states the
   * equivalent EBCDIC rule here instead.
   */
  private writeControl(ebcdic: number, autoSkip: boolean): boolean {
    const s = this.screen;
    if (this.oia.isInhibited() && !this.oia.isOperatorError()) return false;

    const field = s.fieldAt(s.cursor);
    if (field !== null) {
      if (field.protected) {
        this.oia.inhibit(KeyboardState.ProtectedField);
        return false;
      }
      // x3270 tests the EBCDIC BYTE and permits only EBC_0..EBC_9, plus, minus, period and
      // comma (kybd.c:1232-1238). 0x1c and 0x1e are outside that set, so a numeric field
      // refuses both — no character-class test is needed or correct here.
      if (field.numeric) {
        this.oia.inhibit(KeyboardState.Numeric);
        return false;
      }
    }

    if (this.insertMode && field !== null) {
      if (!this.shiftRight(field, s.cursor)) {
        this.oia.inhibit(KeyboardState.Overflow);
        return false;
      }
    }

    s.setChar(s.cursor, ebcdic);
    if (field !== null) s.setMDT(field.attrAddr);
    if (autoSkip) this.advanceAfterType(field);
    else s.cursor = s.inc(s.cursor);
    return true;
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/keyboard.test.ts`
Expected: PASS, six new tests.

- [ ] **Step 6: Mutation-check the auto-skip rule**

Change `dup()` to pass `true`, re-run, and confirm the auto-skip test FAILS. Restore. **Report the
observed failure message.** If it does NOT fail, the test is not pinning the rule and must be fixed
before moving on — that assertion is the entire reason this task cites `kybd.c:1435`.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270
git add packages/core/src/constants.ts packages/core/src/keyboard.ts packages/core/test/keyboard.test.ts
git commit -m "feat(core): the Dup and Field Mark keys

Both write an EBCDIC control character rather than sending an AID: x3270
implements them as key_Character(EBC_dup/EBC_fm) at kybd.c:2788 and :2825, and the
bytes are 0x1c and 0x1e from 3270ds.h:364-365.

Dup suppresses auto-skip and Field Mark does not, per kybd.c:1435 -- 'for all
pasted data (even DUP), and for all keyboard-generated data except DUP'. Mutation
checked: making Dup skip reddens that test.

Both are refused in a numeric field, because x3270 tests the EBCDIC byte and
permits only digits, plus, minus, period and comma (kybd.c:1232-1238).

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 2: The four new actions, and the two that front ends must own

> **AS BUILT (`8f14fcb`, `b681a71`, `c94979f`, `6958def`). ONE OF THESE IS A SECURITY FIX AND THE PLAN
> CAUSED IT.**
>
> 1. **THIS PLAN'S TASK ORDERING OPENED A REMOTELY-TRIGGERABLE GATEWAY KILL.** Task 2 makes
>    `applyAction` throw on `toggleKeypad`; Task 9 was to add the gateway's rejection. In between, a
>    48-byte WebSocket frame from any client reached `applyAction` inside a `data` handler with **no
>    `try`** (`web/src/main.ts:186` as measured then; **`:224` now**) — and `wsserver.ts:30-33`
>    documents the consequence itself: "a
>    throw from a 'data' handler is an unhandled exception that would end the process, so one
>    malformed frame from one browser would disconnect everybody else's mainframe session."
>    `protocol.ts` already rejects `quit` for exactly this reason. **Closed in Task 2 instead**
>    (`protocol.ts:114`), leaving Task 9 the flag, the repaint and the `bridgecore.ts` half.
>    **THAT REJECTION WAS A STOP-GAP AND TASK 9 REMOVED IT**, replacing it with the real
>    per-connection intercept above `applyAction`; `protocol.ts:113-118` now explains why the kind is
>    deliberately *accepted*. The two halves landed together so the process-kill window never
>    reopened.
>    **THE GENERAL RULE: when a plan adds a throw in one task and the guard against it in a later
>    task, the gap between them is a live vulnerability, not a to-do.**
> 2. **The `dup`/`fieldMark` test in Step 1 below is VACUOUS — copy it and you inherit the defect.**
>    It calls `applyAction` for both keys before asserting either, so transposing the two switch cases
>    leaves the whole suite green while putting the wrong control byte on the wire and inverting the
>    numeric policy. **All three of the task's original mutation checks DELETED something and none
>    SWAPPED anything; deletion and transposition are different mutation classes, and a spy-based test
>    is far more vulnerable to the second.**
> 3. **`toThrow(/toggleKeypad/)` passed on an unrelated `TypeError`**, because Node's
>    `session.toggleKeypad is not a function` contains the word. Both it and the **pre-existing**
>    `quit` assertion (`/quit/i`, same hole) now match `/does not handle .../`.
> 4. **`default: action satisfies never;` was added and beats the comment it replaces.** Deleting
>    either guard is now a compile error (`TS1360`), where before only prose stood between a
>    maintainer and "the least diagnosable outcome available". **Zero runtime footprint** — the emitted
>    JS is `default: action;`, so an unknown `kind` from untrusted JSON is still a silent no-op and
>    `protocol.ts`'s defence is preserved.
> 5. **The guard MUST sit outside the `try`.** `applyAction`'s `try` wraps the entire switch and its
>    catch swallows errors, so a guard folded into the switch is swallowed and the dead-button no-op
>    returns. Mutation-pinned.
>
> **NO TEST FILE IN THIS REPO IS TYPECHECKED BY ANYTHING** — every `tsconfig.json` includes only
> `src/**/*.ts` and vitest strips types. So a bogus action `kind` or a wrong argument type in a test is
> caught by no tool. This also corrects Step 2's prediction that the new tests "will not compile":
> they compile fine and fail at runtime. **1529 tests.**

**Files:**
- Modify: `packages/frontend/src/keymap.ts` (the `Action` union)
- Modify: `packages/frontend/src/actions.ts` (`applyAction`)
- Test: `packages/frontend/test/actions.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('the keypad-era actions', () => {
  it('sysreq reaches Session.sysreq, which no front end could call before', () => {
    const { session } = newSession();
    const spy = vi.spyOn(session, 'sysreq');
    applyAction(session, { kind: 'sysreq' });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('dup and fieldMark reach the keyboard, not sendAID', () => {
    // They are typed characters. A version that routed them through sendAID would put a
    // bogus AID byte on the wire, which is the class of defect pfAID/VALID_AIDS exist for.
    const { session } = newSession();
    const dup = vi.spyOn(session.keyboard, 'dup');
    const fm = vi.spyOn(session.keyboard, 'fieldMark');
    const aid = vi.spyOn(session, 'sendAID');
    applyAction(session, { kind: 'dup' });
    applyAction(session, { kind: 'fieldMark' });
    expect(dup).toHaveBeenCalledOnce();
    expect(fm).toHaveBeenCalledOnce();
    expect(aid).not.toHaveBeenCalled();
  });

  it('REFUSES toggleKeypad, which is the front end s own business', () => {
    // Same reasoning as `quit`, and the same failure mode: a front end that forgot to
    // intercept this would show a dead button rather than an error. Throwing makes the
    // omission loud. See applyAction's docstring.
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'toggleKeypad' })).toThrow(/toggleKeypad/);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/frontend/test/actions.test.ts`
Expected: FAIL — the union has no such members, so this will not compile under vitest's transform
either. That is fine; the failure is the point.

- [ ] **Step 3: Extend the Action union**

In `packages/frontend/src/keymap.ts`, add to `Action`:

```ts
  | { kind: 'sysreq' }
  | { kind: 'dup' }
  | { kind: 'fieldMark' }
  | { kind: 'toggleKeypad' }
```

- [ ] **Step 4: Implement in applyAction**

In `packages/frontend/src/actions.ts`, extend the guard at the top of the function:

```ts
  if (action.kind === 'quit') {
    throw new Error('applyAction does not handle quit: the front end owns its own teardown');
  }
  // THE SAME REASONING AS `quit`, and the same failure mode if it were ignored instead.
  // Showing or hiding a keypad is a display decision no `Session` knows anything about: the
  // Electron main process and the gateway's server each hold the flag and rebuild the frame, and
  // the TUI opens a list overlay instead. A front end that forgot to intercept this would present
  // a button or a chord that silently does nothing, which is the least diagnosable outcome
  // available -- so it throws.
  if (action.kind === 'toggleKeypad') {
    throw new Error('applyAction does not handle toggleKeypad: the front end owns its own display');
  }
```

and add three cases to the switch, beside `attn`:

```ts
      case 'sysreq': session.sysreq(); break;
      // Typed CHARACTERS, not AIDs -- see the keyboard methods and kybd.c:2788,2825.
      case 'dup': k.dup(); break;
      case 'fieldMark': k.fieldMark(); break;
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/actions.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm nothing else broke**

Run: `cd ~/git/tn3270 && npm test`
Expected: all green. **If `bindings.test.ts` fails because `BINDING_INTENT` no longer covers every
action, that is Task 4's job — note it and continue.** Do not weaken that test to make this task
pass.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270
git add packages/frontend/src/keymap.ts packages/frontend/src/actions.ts packages/frontend/test/actions.test.ts
git commit -m "feat(frontend): sysreq, dup, fieldMark and toggleKeypad actions

Session.sysreq() has existed since stage 2b with no way for any front end to call
it; now it has one. dup and fieldMark go to the keyboard, never to sendAID, since
they are typed characters.

applyAction THROWS on toggleKeypad, exactly as it does on quit and for the same
reason: it is a display decision no Session knows about, and a front end that
forgot to intercept it would show a control that silently does nothing.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 3: The key table, in `packages/frontend`

> **AS BUILT (`5251b49`). THE SIX TESTS BELOW ARE BLIND TO THE LAYOUT THEY CLAIM TO CHECK — measured
> twice, by the implementer and again by the reviewer running the plan's six in isolation.**
>
> The "within 72 columns" test takes only a `max`, so **all six pass** while: two keys share cells
> (`Reset` col 60 → 48), a key sits off the 6-cell boundary (`Home` col 24 → 25), or a key is on a row
> `KEYPAD_ROWS` does not declare (`BkSp` row 4 → 5). **9 tests as built**, adding no-overlap-within-a-row,
> a whole-key column-boundary-and-declared-row check, and `name` non-empty and unique (`name` was
> asserted by nothing, and Task 11 renders it).
>
> **The provenance claim in the doc comment below is WRONG and was rewritten.** c3270's authoritative
> set is `keypad.callbacks` (exactly 44 keys) and **has no cursor arrows**; the arrow-looking glyphs in
> `keypad.full:8-11` are Tab, BackTab and Newline. Ours is that set **minus three, plus five** — it also
> drops **Newline**, and adds the four arrows and Backspace. See the spec's open question on Newline.
>
> **`as const` in `pfRow` is DEAD SYNTAX** beside the explicit `KeypadKey[]` return annotation — either
> mechanism suffices alone, verified by compiling all four combinations. Dropped.
>
> **THE RESIDUAL GAP, and it is not the obvious one: a LABEL/ACTION MISMATCH is invisible to both the
> tests and the goldens.** Swap `Del`'s and `BkSp`'s actions and all nine tests stay green *and the
> drawn pixels are identical*, so Task 14 cannot see it either. Only Task 13 covers it, by clicking a
> label and asserting the action — for **8 of 46 keys**. Positional swaps (two keys trading rows at the
> same column, the whole PF block inverted) do change pixels, so a golden catches them **as drift only**,
> never in the baseline it was generated from. **1538 tests in 67 files.**

**Files:**
- Create: `packages/frontend/src/keypad.ts`
- Modify: `packages/frontend/src/index.ts` (export it)
- Test: `packages/frontend/test/keypad.test.ts`

The table lives here, and not in `packages/canvas`, because `tui` cannot import `canvas` —
the graphs are `core <- frontend <- { cli, tui }` and `core <- canvas <- { gui, web }`. Two copies
of this list would drift, and the drift would be silent.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { KEYPAD_KEYS, KEYPAD_ROWS, type KeypadKey } from '../src/keypad.js';
import { PF_AIDS, PA_AIDS } from '@tn3270/core';

describe('KEYPAD_KEYS', () => {
  it('has 46 keys, which is the layout in the spec', () => {
    expect(KEYPAD_KEYS).toHaveLength(46);
  });

  it('carries every PF and PA key exactly once', () => {
    const pf = KEYPAD_KEYS.filter((k) => k.action.kind === 'pf');
    const pa = KEYPAD_KEYS.filter((k) => k.action.kind === 'pa');
    expect(pf).toHaveLength(PF_AIDS.length);
    expect(pa).toHaveLength(PA_AIDS.length);
    // Numbered 1..24 and 1..3 with no gaps and no repeats.
    expect([...pf].map((k) => (k.action as { n: number }).n).sort((a, b) => a - b))
      .toEqual(Array.from({ length: PF_AIDS.length }, (_, i) => i + 1));
    expect([...pa].map((k) => (k.action as { n: number }).n).sort((a, b) => a - b))
      .toEqual(Array.from({ length: PA_AIDS.length }, (_, i) => i + 1));
  });

  it('has no duplicate labels and no duplicate actions', () => {
    const labels = KEYPAD_KEYS.map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
    const actions = KEYPAD_KEYS.map((k) => JSON.stringify(k.action));
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('never carries an action a front end must intercept', () => {
    // `quit` and `toggleKeypad` both throw inside applyAction. A button for either would be a
    // button that throws, and the swallow in applyAction would hide it.
    for (const k of KEYPAD_KEYS) {
      expect(k.action.kind).not.toBe('quit');
      expect(k.action.kind).not.toBe('toggleKeypad');
    }
  });

  it('labels fit the width the layout reserves', () => {
    // The canvas layout gives each key a fixed cell width; a longer label would overflow into
    // its neighbour, silently, because the blitter clips nothing.
    for (const k of KEYPAD_KEYS) expect(k.label.length).toBeLessThanOrEqual(5);
  });

  it('groups into exactly the rows the layout expects, each within 72 columns', () => {
    expect(KEYPAD_ROWS).toHaveLength(5);
    for (const row of KEYPAD_ROWS) {
      const keys = KEYPAD_KEYS.filter((k) => k.row === row);
      expect(keys.length).toBeGreaterThan(0);
      const widest = Math.max(...keys.map((k) => k.col + 6));
      expect(widest).toBeLessThanOrEqual(72);
    }
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/frontend/test/keypad.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Write the table**

`packages/frontend/src/keypad.ts`:

```ts
import type { Action } from './keymap.js';

/**
 * Which keys the virtual keypad and the TUI overlay offer, as DATA.
 *
 * ## ONE TABLE, TWO FRONT-END FAMILIES
 *
 * This lives in `frontend` because both package graphs reach it: `canvas` (and so the Electron GUI
 * and the web gateway) already imports from here, and so does `tui`. A copy in `canvas` would be
 * out of the TUI's reach, and two lists of 46 keys drift silently.
 *
 * ## WHAT IS NOT HERE, AND WHY
 *
 * No Cursor Select: `AID.SELECT` exists but the key needs the field-intensity parse and belongs
 * with the light-pen work. No Compose: it is x3270's own input method. No typewriter keys: a keypad
 * earns its space by offering what a PC keyboard lacks.
 *
 * The key SET follows c3270's own keypad (`Common/c3270/keypad.labels`); the ARRANGEMENT follows a
 * 122-key tn327x keyboard in the way that matters for muscle memory — PF keys in a 2x12 block
 * across the top, modal keys in a left-hand cluster, cursor and edit keys on the right.
 *
 * `row` and `col` are in CELLS, and `col` is the left edge. The canvas layout turns them into
 * pixels; the TUI overlay ignores them and lists the keys in order.
 */
export interface KeypadKey {
  /** At most 5 characters: see the test. Longer labels overflow into the next key. */
  readonly label: string;
  readonly action: Action;
  /** 0-4. Rows 0 and 1 are the PF block; 2-4 are the clusters. */
  readonly row: number;
  /** Left edge in cells. */
  readonly col: number;
  /** For the TUI overlay and for accessibility: what this key is called in words. */
  readonly name: string;
}

export const KEYPAD_ROWS: readonly number[] = Object.freeze([0, 1, 2, 3, 4]);

/** Each key is 6 cells wide, so 12 of them span 72 — inside an 80-column screen. */
export const KEYPAD_KEY_WIDTH = 6;

const pfRow = (row: number, from: number): KeypadKey[] => Array.from({ length: 12 }, (_, i) => ({
  label: `PF${from + i}`,
  action: { kind: 'pf', n: from + i } as const,
  row,
  col: i * KEYPAD_KEY_WIDTH,
  name: `PF${from + i}`,
}));

export const KEYPAD_KEYS: readonly KeypadKey[] = Object.freeze([
  ...pfRow(0, 13),
  ...pfRow(1, 1),

  { label: 'PA1', action: { kind: 'pa', n: 1 }, row: 2, col: 0, name: 'PA1' },
  { label: 'PA2', action: { kind: 'pa', n: 2 }, row: 2, col: 6, name: 'PA2' },
  { label: 'PA3', action: { kind: 'pa', n: 3 }, row: 2, col: 12, name: 'PA3' },
  { label: 'Home', action: { kind: 'home' }, row: 2, col: 24, name: 'Home' },
  { label: '^', action: { kind: 'up' }, row: 2, col: 30, name: 'Cursor up' },
  { label: 'Ins', action: { kind: 'toggleInsert' }, row: 2, col: 36, name: 'Insert mode' },
  { label: 'Dup', action: { kind: 'dup' }, row: 2, col: 48, name: 'Dup' },
  { label: 'Reset', action: { kind: 'reset' }, row: 2, col: 60, name: 'Reset' },

  { label: 'Attn', action: { kind: 'attn' }, row: 3, col: 0, name: 'Attention' },
  { label: 'SysRq', action: { kind: 'sysreq' }, row: 3, col: 6, name: 'System Request' },
  { label: 'Clear', action: { kind: 'clear' }, row: 3, col: 12, name: 'Clear' },
  { label: '<', action: { kind: 'left' }, row: 3, col: 24, name: 'Cursor left' },
  { label: 'v', action: { kind: 'down' }, row: 3, col: 30, name: 'Cursor down' },
  { label: '>', action: { kind: 'right' }, row: 3, col: 36, name: 'Cursor right' },
  { label: 'FldMk', action: { kind: 'fieldMark' }, row: 3, col: 48, name: 'Field Mark' },
  { label: 'Enter', action: { kind: 'enter' }, row: 3, col: 60, name: 'Enter' },

  { label: 'ErEOF', action: { kind: 'eraseEOF' }, row: 4, col: 0, name: 'Erase EOF' },
  { label: 'ErInp', action: { kind: 'eraseInput' }, row: 4, col: 6, name: 'Erase Input' },
  { label: 'Tab', action: { kind: 'tab' }, row: 4, col: 12, name: 'Tab' },
  { label: 'BkTab', action: { kind: 'backTab' }, row: 4, col: 24, name: 'Back Tab' },
  { label: 'Del', action: { kind: 'delete' }, row: 4, col: 30, name: 'Delete' },
  { label: 'BkSp', action: { kind: 'backspace' }, row: 4, col: 36, name: 'Backspace' },
]);
```

- [ ] **Step 4: Export it**

Add `keypad.js` to `packages/frontend/src/index.ts` following the existing export style there.

- [ ] **Step 5: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/frontend/test/keypad.test.ts`
Expected: PASS, six tests. **If the count is not 46, count the entries rather than editing the
test** — the spec's own first draft said 43 and was wrong, and that was caught by counting.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/frontend/src/keypad.ts packages/frontend/src/index.ts packages/frontend/test/keypad.test.ts
git commit -m "feat(frontend): the keypad key table, as data

46 keys, in frontend rather than canvas because the TUI cannot import canvas and
two copies of this list would drift silently. The key SET follows c3270's own
keypad; the arrangement follows a 122-key tn327x keyboard.

Tested for what a table can get wrong: duplicate labels or actions, a PF or PA
number missing or repeated, a label too long for the width the layout reserves,
and any action a front end has to intercept (quit, toggleKeypad) appearing as a
button that would throw.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 4: Bindings — `BINDING_INTENT`, the TUI keymap, the canvas keymap

> **AS BUILT (`8585c71`, `662009f`; Newline's half in `a039287`). RAN TWELFTH, NOT FOURTH — see the
> reordering section at the top. THIS TASK'S HEADLINE CLAIM WAS FICTION AND THE IMPLEMENTER FOUND IT
> BY READING THE WHOLE FILE.**
>
> 1. **THERE WAS NEVER A DIVERGENCE. `Ctrl-K` IS c3270's OWN TERMINAL BINDING.** `Common/fb-c3270`
>    splits at `#ifdef _WIN32` (`:41`) / `#else` (`:126`) / `#endif` (`:204`), and **every citation
>    this task and the spec gave — `:48`, `:88`, `:93` — is inside the WINDOWS branch.** The
>    non-Windows keymap, which is what a terminal build reads, has `Ctrl<Key>d: Dup()` (`:186`),
>    `Ctrl<Key>f: FieldMark()` (`:187`) and **`Ctrl<Key>k: Keypad()` (`:191`)**. So the whole "the TUI
>    uses `Ctrl-K` *instead of* c3270's `Alt-K`, to stay off the ESC path" paragraph described a
>    departure that does not exist: the outcome was right by accident. `Alt-K` is merely the Windows
>    spelling, which is now why the canvas front ends take both. Dup and Field Mark are
>    `Ctrl-D`/`Ctrl-F` in *both* branches, so those two were right by luck while pointing at the wrong
>    lines. **The ESC-path caution remains true and remains the reason not to add an `Alt-` binding to
>    the TUI; it is just not why `Ctrl-K` was chosen.**
> 2. **THE PLAN'S ALT-K BRANCH WAS THE macOS DEFECT THIS PROJECT HAS ALREADY BEEN BITTEN BY.** It
>    matched `e.key.toLowerCase() === 'k'`, and **Option-K on macOS reports `key === '˚'`** — exactly
>    as Option-1 reports `'¡'`, the case `KeyLike.code`'s own note warns about and that once left the
>    PA keys unreachable. Matched on `e.code` instead, with a test carrying the real macOS `key` value.
> 3. **REMOVING THE `Ctrl-K` ROW FROM `BINDING_INTENT` LEFT ALL 1621 TESTS GREEN.** The keymap still
>    mapped `\x0b`, so only the *written intent* vanished — and `Ctrl-K` is not a keypad button, so not
>    even the TUI list noticed. It joins `Ctrl-D` and `Ctrl-F` in the vanish guard that exists for
>    precisely this.
> 4. **A PRE-EXISTING DIVERGENCE FOUND IN PASSING AND DELIBERATELY NOT FIXED:** `keymap.ts` and
>    `bindings.ts` cite `fb-c3270:83` for `Ctrl-A` = Attn — **also the Windows branch.** In the
>    non-Windows keymap `Ctrl-A` is c3270's *escape prefix* and Attn is the two-key
>    `Ctrl<Key>a <Key>a` (`:182`). So this project's plain `Ctrl-A` for Attn is a real divergence
>    nobody knew they were making. It came in with the palette-schemes work, not with the keypad.
>    Decide it separately.
>
> **What the `BINDING_INTENT` indirection bought, measured:** `Ctrl-D` and `Ctrl-F` appeared in the TUI
> list with **no edit to `keypadOverlay.ts`** — 23 blank chord columns became 21. Sys Req stays
> chordless in both the keymap and `BINDING_INTENT`, pinned by a sweep over all 32 C0 bytes; Step 5's
> question about whether `bindings.test.ts` needed an exemption answered itself, since it does not
> require every `Action` to appear. `keys.mjs` went 15 → 18 chords (it claims to cover every entry of
> `keys.ts`'s `CTRL` table, so the claim would otherwise have gone quietly false) and
> `browser-keys.mjs` gained `Ctrl+K`, the only observable for that chord over the gateway path.
> **1621 tests.**

**Files:**
- Modify: `packages/frontend/src/bindings.ts`
- Modify: `packages/frontend/src/keymap.ts` (the terminal table)
- Modify: `packages/canvas/src/keys.ts` (`CTRL`, plus an Alt branch for `k`)
- Test: `packages/frontend/test/bindings.test.ts`, `packages/frontend/test/keymap.test.ts`,
  `packages/canvas/test/keys.test.ts`

**The chords are c3270's where c3270 has one** (`Common/fb-c3270`): `Ctrl-D` = Dup (`:88`),
`Ctrl-F` = FieldMark (`:93`). c3270 toggles its keypad with `Alt-K` (`:48`), which reaches a
terminal as `ESC k` — and this project keeps new bindings off the ESC path, whose comments in
`app.ts` record two regressions. So the TUI uses `Ctrl-K` and the canvas front ends accept **both**
`Ctrl-K` and `Alt-K`. **Sys Req gets no chord**, because c3270 defines none.

- [ ] **Step 1: Write the failing tests**

In `packages/frontend/test/keymap.test.ts`:

```ts
describe('the keypad-era chords', () => {
  it('maps Ctrl-D to Dup and Ctrl-F to Field Mark, as c3270 does', () => {
    expect(lookup(new Uint8Array([0x04]))).toEqual({ kind: 'dup' });
    expect(lookup(new Uint8Array([0x06]))).toEqual({ kind: 'fieldMark' });
  });

  it('maps Ctrl-K to the keypad toggle', () => {
    expect(lookup(new Uint8Array([0x0b]))).toEqual({ kind: 'toggleKeypad' });
  });

  it('gives Sys Req NO chord, deliberately', () => {
    // c3270 defines none either. It is reachable from the overlay and from the CLI. A chord
    // invented here is one nobody can predict and one this test would have to guess.
    const reachable = [...Array(32).keys()]
      .map((b) => lookup(new Uint8Array([b])))
      .filter((a) => a !== null && a !== undefined && (a as { kind: string }).kind === 'sysreq');
    expect(reachable).toEqual([]);
  });
});
```

In `packages/canvas/test/keys.test.ts`:

```ts
describe('the keypad toggle', () => {
  it('is Ctrl-K', () => {
    expect(actionForKey({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('is ALSO Alt-K, which is what c3270 uses', () => {
    // Free here and unambiguous, because a real KeyboardEvent has no ESC-prefix problem. Alt is
    // already an established modifier in this front end: Alt+digit is PA1-3.
    expect(actionForKey({ key: 'k', code: 'KeyK', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('does not fire on Alt+digit, which is still a PA key', () => {
    expect(actionForKey({ key: '1', code: 'Digit1', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'pa', n: 1 });
  });

  it('maps Ctrl-D and Ctrl-F the same way the terminal does', () => {
    expect(actionForKey({ key: 'd', code: 'KeyD', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'dup' });
    expect(actionForKey({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'fieldMark' });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/frontend/test/keymap.test.ts packages/canvas/test/keys.test.ts`
Expected: FAIL — `lookup` returns null for those bytes, `actionForKey` returns null for those chords.

- [ ] **Step 3: Add the terminal chords**

In `packages/frontend/src/keymap.ts`, beside the existing `t.set` calls:

```ts
  // Dup and Field Mark are c3270's own Ctrl-D and Ctrl-F (Common/fb-c3270:88, :93).
  t.set('\x04', { kind: 'dup' });
  t.set('\x06', { kind: 'fieldMark' });
  // The keypad/overlay toggle. c3270 uses Alt-K (fb-c3270:48), which arrives here as ESC k --
  // and new bindings do not go through the ESC path, whose two regressions are recorded in
  // app.ts. Ctrl-K is free and unambiguous. Sys Req gets no chord: c3270 defines none.
  t.set('\x0b', { kind: 'toggleKeypad' });
```

- [ ] **Step 4: Add the canvas chords**

In `packages/canvas/src/keys.ts`, extend `CTRL`:

```ts
  d: { kind: 'dup' },
  f: { kind: 'fieldMark' },
  k: { kind: 'toggleKeypad' },
```

and, in the Alt branch, accept `k` as well as the PA digits:

```ts
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    // Alt-K is c3270's keypad toggle (fb-c3270:48), free to honour here because a real
    // KeyboardEvent carries no ESC ambiguity. Checked before PA_CODES so a future Alt binding
    // cannot shadow it silently.
    if (e.key.toLowerCase() === 'k') return { kind: 'toggleKeypad' };
    return PA_CODES[e.code] ?? null;
  }
```

- [ ] **Step 5: Record the intent**

In `packages/frontend/src/bindings.ts`, add to `BINDING_INTENT`:

```ts
  {
    key: 'Ctrl-D', action: { kind: 'dup' }, terminal: '\x04',
    note: 'c3270\'s own binding (fb-c3270:88). Writes EBCDIC 0x1c and does NOT auto-skip',
  },
  {
    key: 'Ctrl-F', action: { kind: 'fieldMark' }, terminal: '\x06',
    note: 'c3270\'s own binding (fb-c3270:93). Writes EBCDIC 0x1e and auto-skips normally',
  },
  {
    key: 'Ctrl-K', action: { kind: 'toggleKeypad' }, terminal: '\x0b',
    note: 'shows the keypad (GUI, browser) or the special-keys overlay (TUI). c3270 uses Alt-K, '
      + 'which would be ESC k in a terminal; the canvas front ends accept both',
  },
```

**Sys Req is deliberately absent from `BINDING_INTENT`** — it has no key. If
`bindings.test.ts` asserts that every `Action` appears there, that test needs a documented
exemption for actions with no binding, not a fabricated chord. Read the test before changing it and
say in your report which you did.

- [ ] **Step 6: Run everything**

Run: `cd ~/git/tn3270 && npm run build && npm test`
Expected: all green.

- [ ] **Step 7: Mutation-check one chord**

Remove the `k: { kind: 'toggleKeypad' }` entry from `CTRL`, re-run
`npx vitest run packages/canvas/test/keys.test.ts`, and confirm the Ctrl-K test fails. Restore.

- [ ] **Step 8: Commit**

```bash
cd ~/git/tn3270
git add packages/frontend/src/bindings.ts packages/frontend/src/keymap.ts packages/canvas/src/keys.ts packages/frontend/test packages/canvas/test
git commit -m "feat: chords for Dup, Field Mark and the keypad toggle

Ctrl-D and Ctrl-F are c3270's own defaults (fb-c3270:88,93). The toggle is Ctrl-K
rather than c3270's Alt-K, because Alt-K reaches a terminal as ESC k and this
project keeps new bindings off the ESC path, whose two regressions are recorded in
app.ts; the canvas front ends accept both, since a KeyboardEvent has no such
ambiguity and Alt is already the PA modifier there.

Sys Req gets no chord, as in c3270. It is reachable from the keypad, the TUI
overlay and the CLI.

Generated with AI

Co-Authored-By: SLAC AI"
```

---
### Task 5: The keypad's cell layout, in `packages/canvas`

> **AS BUILT (`3937e79`). THE CODE BELOW CONTAINS A FONT BUG THIS TASK'S OWN PROSE WARNS ABOUT ONE
> PARAGRAPH EARLIER. Do not copy `columnFor`.**
>
> 1. **`column()` was PRIVATE in `drawlist.ts`; it is now exported and must be used.** The plan's
>    `columnFor` computed `cg % atlas.cols`, **a different function**: `atlas.index` is a sparse packed
>    map, **175 of its 431 entries differ from their CG code** (first divergence exactly CG 257 → 256,
>    max CG 543), and `%` also drops the `CG_BOXSOLID` fallback, so an unknown character samples a
>    neighbouring glyph and reads as corruption. Latent only by luck — all 44 distinct label characters
>    land where the index is the identity — **and the spec's own ranked font fallback #1 is box-drawing
>    borders, which is exactly where the non-identity entries live.** Now pinned by two tests against
>    hand-built non-identity atlases.
> 2. **`Colour` comes from `@tn3270/core`, not `@tn3270/frontend`.** The plan's import list would not
>    have compiled.
> 3. **`hitTest` AND `KeypadButton` LIVE IN `hittest.ts`, NOT HERE** — see Task 7 Step 4, whose
>    "`./keypad.js` is relative and fine" was wrong. `dist/hittest.js` is arithmetic with **no import
>    statement at all**, and it is in `BROWSER_MODULES`. Importing `keypad.js` into the renderer instead
>    fails **three** guards: both assertions of `renderer-imports.test.ts` and `httpstatic.test.ts`'s
>    graph-closure walk, the last being the 404-then-black-canvas path.
> 4. **`DRAWN_ROW[key.row]` THROWS rather than `!`-asserting.** `undefined * cellHeight` is `NaN`, and a
>    NaN rectangle draws nowhere and matches no hit test — a silently-lost keypad row.
> 5. **The plan's `as never` atlas fixture is unusable**: `index: {}` makes every glyph lookup miss, so
>    it yields zero signal on any CG-mapping defect. Use the real baked atlas the way `drawlist.test.ts` does (its `atlas` const, `:12-14` — this said
>    `:11`, which is the blank line above the docstring).
>    **A cast in a test fixture is unchecked — no test file in this repo is typechecked.**
>
> **THE PLAN'S 11 TESTS ARE BLIND TO SIX MUTATIONS, measured twice.** All 11 pass while: the blank
> separator row is collapsed, the two PF rows are transposed, label cells sit on the wrong row, every
> label character is drawn on one cell, `hitTest` rounds to the nearest key, and `ebcdicToCg` is dropped.
> Its cell test is `>= total`, its width test ignores height, and **nothing in it asserts which row is
> where** — so the separator row (the whole reason `KEYPAD_ROWS_TALL` is 6 for a 5-row table) and
> c3270's PF13-above-PF1 order were both unpinned. **`width` and `height` were also unpinned in the
> growing direction** (`KEYPAD_ROWS_TALL = 7` and a 13-key width both stayed green), which matters
> because `DrawList.height` sizes the Electron window. **23 tests as built. 1564 in 68 files.**
>
> Fixed in passing: `httpstatic.test.ts` claimed to serve "five files" while listing six paths and
> omitting `/bridgecore.js`. Labels are **left-aligned** in each 6-cell key; centring is one expression,
> and is worth deciding alongside Task 8's font PNG.

**Files:**
- Create: `packages/canvas/src/keypad.ts`
- Modify: `packages/canvas/src/index.ts` (export it)
- Test: `packages/canvas/test/keypad.test.ts`

This turns the table into `DrawCell`s and button rectangles. **Everything is in scale-1 pixels**,
the same space `DrawCell.x/.y` and `oia.y` already use (`drawlist.ts` emits
`x: col * atlas.cellWidth`). Do not introduce cell coordinates here: two conventions in one
structure is how an off-by-one becomes invisible.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { KEYPAD_KEYS } from '@tn3270/frontend';
import { keypadRegion, hitTest, KEYPAD_ROWS_TALL } from '../src/keypad.js';
import { SCHEMES } from '@tn3270/frontend';

const atlas = { cellWidth: 9, cellHeight: 14, cols: 431, index: {} } as never;
const scheme = SCHEMES['default']!;
const region = () => keypadRegion(atlas, scheme, 0);

describe('keypadRegion', () => {
  it('produces one button per key in the table', () => {
    expect(region().buttons).toHaveLength(KEYPAD_KEYS.length);
  });

  it('is KEYPAD_ROWS_TALL rows high, in scale-1 pixels', () => {
    const r = keypadRegion(atlas, scheme, 350);
    expect(r.y).toBe(350);
    expect(r.height).toBe(KEYPAD_ROWS_TALL * atlas.cellHeight);
  });

  it('offsets every button by the region y it was given', () => {
    // The keypad sits BELOW the screen and the OIA, so a region built at y=350 must not emit a
    // button at y=0 -- that would put the keypad over the host's first row.
    const r = keypadRegion(atlas, scheme, 350);
    for (const b of r.buttons) expect(b.y).toBeGreaterThanOrEqual(350);
  });

  it('has no two buttons overlapping', () => {
    const bs = region().buttons;
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!;
        const b = bs[j]!;
        const disjoint = a.x + a.w <= b.x || b.x + b.w <= a.x
          || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(disjoint, `${a.label} overlaps ${b.label}`).toBe(true);
      }
    }
  });

  it('keeps every button inside the declared width', () => {
    const r = region();
    for (const b of r.buttons) expect(b.x + b.w).toBeLessThanOrEqual(r.width);
  });

  it('emits a cell for every character of every label', () => {
    const total = KEYPAD_KEYS.reduce((n, k) => n + k.label.length, 0);
    expect(region().cells.length).toBeGreaterThanOrEqual(total);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(region())).toBe(JSON.stringify(region()));
  });
});

describe('hitTest', () => {
  const bs = region().buttons;
  const first = bs[0]!;

  it('finds the button under a point inside it', () => {
    expect(hitTest(bs, first.x + 1, first.y + 1)?.label).toBe(first.label);
  });

  it('includes the top-left corner and EXCLUDES the bottom-right', () => {
    // Half-open, so adjacent buttons cannot both claim a pixel. This is the assertion that
    // catches an off-by-one, and the reason the mutation check below exists.
    expect(hitTest(bs, first.x, first.y)?.label).toBe(first.label);
    expect(hitTest(bs, first.x + first.w, first.y)?.label).not.toBe(first.label);
    expect(hitTest(bs, first.x, first.y + first.h)?.label).not.toBe(first.label);
  });

  it('returns undefined outside every button', () => {
    expect(hitTest(bs, -1, -1)).toBeUndefined();
    expect(hitTest(bs, 100000, 100000)).toBeUndefined();
  });

  it('never returns two buttons for one point', () => {
    for (const b of bs) {
      const mid = { x: b.x + Math.floor(b.w / 2), y: b.y + Math.floor(b.h / 2) };
      const matches = bs.filter((c) => mid.x >= c.x && mid.x < c.x + c.w
        && mid.y >= c.y && mid.y < c.y + c.h);
      expect(matches).toHaveLength(1);
    }
  });
});
```

Read `packages/canvas/test/drawlist.test.ts` for how it fabricates an `AtlasGeometry` and a
`Scheme`, and reuse that rather than the sketch above if they differ.

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/canvas/test/keypad.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

`packages/canvas/src/keypad.ts`:

```ts
import { cp037 } from '@tn3270/core';
import { KEYPAD_KEYS, KEYPAD_KEY_WIDTH, schemeRgb, Colour, type Action, type Scheme }
  from '@tn3270/frontend';
import { ebcdicToCg } from './cg.js';
import type { AtlasGeometry, DrawCell } from './drawlist.js';

/**
 * The virtual keypad, as cells and rectangles.
 *
 * ## SCALE-1 PIXELS THROUGHOUT
 *
 * The same coordinate space `DrawCell.x/.y` and `oia.y` already use. The renderer multiplies by
 * whatever integer scale it picks at paint time and adds the centring offset, exactly as it does
 * for the screen, so nothing here goes stale on a resize.
 *
 * ## DRAWN THROUGH THE GLYPH ATLAS, NOT WITH `fillText`
 *
 * Labels are EBCDIC-encoded and looked up in the atlas like any other cell. That is what keeps the
 * screenshot goldens byte-reproducible: `fillText` would pull in a system font, and font
 * rasterisation is the machine-dependent thing that stops a golden reproducing. The spec records
 * that the FONT CHOICE is provisional and ranks the fallbacks; note that options 1 and 2 there
 * change only this file.
 */
export interface KeypadButton {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly action: Action;
  readonly label: string;
}

export interface KeypadRegion {
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cells: readonly DrawCell[];
  readonly buttons: readonly KeypadButton[];
}

/** Rows in the table, plus one blank separator under the PF block. */
export const KEYPAD_ROWS_TALL = 6;

/** Which table row sits on which drawn row: row 0,1 are the PF block, then a gap, then 2,3,4. */
const DRAWN_ROW: readonly number[] = Object.freeze([0, 1, 3, 4, 5]);

export function keypadRegion(atlas: AtlasGeometry, scheme: Scheme, y: number): KeypadRegion {
  const fg = schemeRgb(scheme, Colour.NEUTRAL_WHITE);
  const bg = schemeRgb(scheme, Colour.NEUTRAL_BLACK);
  const cells: DrawCell[] = [];
  const buttons: KeypadButton[] = [];

  for (const key of KEYPAD_KEYS) {
    const drawnRow = DRAWN_ROW[key.row]!;
    const bx = key.col * atlas.cellWidth;
    const by = y + drawnRow * atlas.cellHeight;

    buttons.push({
      x: bx,
      y: by,
      w: KEYPAD_KEY_WIDTH * atlas.cellWidth,
      h: atlas.cellHeight,
      action: key.action,
      label: key.label,
    });

    for (let i = 0; i < key.label.length; i++) {
      cells.push({
        x: bx + i * atlas.cellWidth,
        y: by,
        glyph: columnFor(atlas, key.label[i]!),
        fg,
        bg,
        cursor: false,
        underline: false,
        blink: false,
        intensify: false,
      });
    }
  }

  return {
    y,
    width: 12 * KEYPAD_KEY_WIDTH * atlas.cellWidth,
    height: KEYPAD_ROWS_TALL * atlas.cellHeight,
    cells,
    buttons,
  };
}

/** Half-open on the right and bottom, so adjacent buttons cannot both claim a pixel. */
export function hitTest(
  buttons: readonly KeypadButton[], x: number, y: number,
): KeypadButton | undefined {
  return buttons.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);
}

function columnFor(atlas: AtlasGeometry, ch: string): number {
  return ((cg: number) => cg % atlas.cols)(ebcdicToCg(cp037.fromUnicode(ch)));
}
```

**Check `column()` in `drawlist.ts` before writing `columnFor`** — if it is exported, use it; if it
is private, either export it or copy its body exactly. Two different glyph-index calculations would
be a font bug that only a golden would catch.

- [ ] **Step 4: Export and run**

Add `keypad.js` to `packages/canvas/src/index.ts`. Then:

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/canvas/test/keypad.test.ts`
Expected: PASS, eleven tests.

- [ ] **Step 5: Mutation-check the rectangle bounds**

Change `hitTest`'s `x < b.x + b.w` to `x <= b.x + b.w`, re-run, and confirm the half-open test
FAILS. Restore. Then change `by` to omit `y` (`const by = drawnRow * atlas.cellHeight`) and confirm
the offset test FAILS. Restore. **Report both.** An off-by-one here is the single most likely defect
in this task and a happy-path test will not see it.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/canvas/src/keypad.ts packages/canvas/src/index.ts packages/canvas/test/keypad.test.ts
git commit -m "feat(canvas): the keypad's cells and button rectangles

Scale-1 pixels throughout, the same space DrawCell and oia.y already use, so the
renderer's existing scale-and-offset arithmetic applies unchanged. Labels go
through the glyph atlas rather than fillText, which is what keeps the screenshot
goldens byte-reproducible.

hitTest is half-open on the right and bottom so adjacent buttons cannot both claim
a pixel; that boundary and the region's y offset are both mutation-checked, being
the two places an off-by-one would hide.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 6: The keypad as a `DrawList` region

> **AS BUILT. THE HEIGHT ASSERTION IN STEP 1 IS A TAUTOLOGY — measured twice, by the implementer and
> again by the reviewer running the plan's four tests in isolation.**
>
> `expect(list.height).toBe(list.keypad!.y + list.keypad!.height)` restates the implementation's own
> expression, so an **over-declaration survives it**: with `KEYPAD_ROWS_TALL` 6 → 7 the plan's four tests
> **all pass**. So does a constant-derived form like `(25 + KEYPAD_ROWS_TALL) * cellHeight`, because the
> mutation moves the constant. **Only `max(button.y + button.h)` measured against `list.height` catches
> it** — the extent has to be derived from the buttons, not from anything that computes it. **This is the
> same failure mode as Task 5's extent constants, recurring one layer up**, which is why it is worth
> stating as a rule: *pin a declared size against what occupies it, never against the arithmetic that
> declared it.* It matters here because `list.height` sizes the Electron window.
>
> Also: **the step-1 sketches do not compile** — `drawlist.test.ts` has no `snapshot`, `resolved` or
> `scheme` in scope and builds screens with `screenWith([])` / `resolve(snap)` / `SCHEMES.default!`.
> The plan's fourth test does catch cell leakage, but `toEqual` alone would be satisfied by a leak into
> *both* lists, so an explicit `toHaveLength(24 * 80)` was added. Heights verified in **all four**
> combinations (336 / 350 / 420 / 434) plus model-4 43x80. `structuredClone` of the region succeeds, so
> it crosses Electron IPC. **1569 tests in 68 files.**
>
> **AN ESM IMPORT CYCLE APPEARED AND WAS REMOVED STRUCTURALLY.** `keypad.ts` needs `column()` and
> `drawlist.ts` needs `keypadRegion`. The cycle was *safe* — `column` is a hoisted function declaration,
> both entry orders resolve — but **the safety was contingent on a property nothing pinned**: the moment
> either module wants a module-level `const` from the other, it becomes a TDZ `ReferenceError` at import
> time, which in Electron main is a blank window that never quits. `column()` therefore **moved to
> `cg.ts`**, which already owns the CG mapping and `CG_BOXSOLID`, taking `AtlasGeometry` as a **type-only**
> import so no runtime edge is created. Duplicating `column()` was not an option — that is Task 5's font
> bug. A type-level cycle remains and is fine.

**Files:**
- Modify: `packages/canvas/src/drawlist.ts`
- Test: `packages/canvas/test/drawlist.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('the keypad region', () => {
  it('is absent unless asked for, and the height is then screen plus OIA', () => {
    const list = drawList(snapshot, resolved, atlas, scheme, 'OIA');
    expect(list.keypad).toBeUndefined();
    expect(list.height).toBe((snapshot.rows + 1) * atlas.cellHeight);
  });

  it('sits BELOW the screen and the OIA, and grows the height', () => {
    // The order is screen, OIA, keypad. Showing it must never move or cover a row the host
    // wrote -- the same rule the TUI's refusal-to-clip and the GUI's resize come from.
    const list = drawList(snapshot, resolved, atlas, scheme, 'OIA', true);
    expect(list.oia!.y).toBe(snapshot.rows * atlas.cellHeight);
    expect(list.keypad!.y).toBe((snapshot.rows + 1) * atlas.cellHeight);
    expect(list.height).toBe(list.keypad!.y + list.keypad!.height);
  });

  it('sits directly below the screen when there is no OIA', () => {
    const list = drawList(snapshot, resolved, atlas, scheme, undefined, true);
    expect(list.keypad!.y).toBe(snapshot.rows * atlas.cellHeight);
  });

  it('does not change the screen cells or the width', () => {
    const without = drawList(snapshot, resolved, atlas, scheme, 'OIA');
    const with_ = drawList(snapshot, resolved, atlas, scheme, 'OIA', true);
    expect(with_.cells).toEqual(without.cells);
    expect(with_.width).toBe(without.width);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/canvas/test/drawlist.test.ts`
Expected: FAIL — `drawList` takes five parameters and `list.keypad` is undefined.

- [ ] **Step 3: Extend `DrawList` and `drawList`**

Add to the `DrawList` interface, after `oia`:

```ts
  /**
   * The virtual keypad, absent unless the front end asked for it.
   *
   * Present in the DRAW LIST rather than owned by the renderer, and that is decided by
   * `gui/src/main.ts`, which sizes the window from `list.height`. A renderer-owned keypad would
   * leave main unaware the drawing had grown, and the Electron page is `overflow:hidden` -- so the
   * keypad would be clipped, which is exactly the model-4 OIA bug live verification found. The
   * alternative was a fifth bridge function, and `bridgecore.ts` says a fifth function means the
   * renderer has stopped being shared.
   */
  readonly keypad?: KeypadRegion;
```

Extend the signature — **appending, never inserting**, for the reason the existing comment above
`drawList` gives about positional arguments:

```ts
export function drawList(
  snapshot: ScreenSnapshot,
  resolved: readonly ResolvedCell[],
  atlas: AtlasGeometry,
  scheme: Scheme,
  oiaText?: string,
  showKeypad = false,
): DrawList {
```

and replace the return with:

```ts
  const rows = snapshot.rows + (oiaText !== undefined ? 1 : 0);
  const oiaY = snapshot.rows * atlas.cellHeight;
  const keypadY = rows * atlas.cellHeight;
  const keypad = showKeypad ? keypadRegion(atlas, scheme, keypadY) : undefined;
  return {
    cells,
    ...(oiaText !== undefined
      ? {
        oia: {
          text: oiaText,
          y: oiaY,
          cells: oiaCells(oiaText, oiaY, snapshot.cols, atlas, scheme),
        },
      }
      : {}),
    ...(keypad !== undefined ? { keypad } : {}),
    width: snapshot.cols * atlas.cellWidth,
    height: keypad !== undefined ? keypadY + keypad.height : rows * atlas.cellHeight,
  };
}
```

Note `...(keypad !== undefined ? { keypad } : {})` rather than `keypad,` — the workspace has
`exactOptionalPropertyTypes` on, so an explicit `undefined` is a type error.

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/canvas/test/drawlist.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the goldens are untouched**

Run: `cd ~/git/tn3270 && npm test && node packages/gui/scripts/shot.mjs`
Expected: all green, `2/2 goldens matched`. **The keypad defaults to off, so no existing pixel may
change.** If a golden moves, stop: something is emitting the region unasked.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/canvas/src/drawlist.ts packages/canvas/test/drawlist.test.ts
git commit -m "feat(canvas): carry the keypad as a third draw-list region

Beside the oia region that already exists, and below it: the order is screen, OIA,
keypad, so showing the keypad never moves or covers a row the host wrote. The
parameter is appended and defaults to false, so every existing caller and both
screenshot goldens are unaffected.

It lives in the draw list because gui/src/main.ts sizes the window from
list.height. A renderer-owned keypad would leave main unaware the drawing had
grown and be clipped by the page's overflow:hidden.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 7: Draw it, and hit-test a click

> **AS BUILT (`37334bb`, `ee2499d`, plus `abc9943` and `3e20b3e` cleaning up after it). THE PLAN PUT
> THE ONE DANGEROUS LINE IN THE ONE FILE NOTHING IN THIS REPO CAN EXECUTE.**
>
> 1. **THE COORDINATE INVERSION MOVED OUT, INTO `hitTestAt` IN `hittest.ts`.** `renderer.ts` throws at
>    module load outside a browser, so the barrel cannot export it and no unit test runs a line of it —
>    and the measured precedent is that `if (e.altKey) return;` in its `keydown` listener leaves the
>    suite fully green while every Alt chord is dead. `keypad.test.ts` now probes `hitTestAt` **at
>    scale 3 with a non-zero centring offset**, the configuration that makes both plausible mistakes
>    fatal. Both were run: multiplying instead of dividing fails a CENTRE probe, and dropping the
>    offset **passes every centre probe** and fails only the last-device-pixel one — which is why both
>    probes exist. That narrowed Task 13's job to the plumbing.
> 2. **A CLICK ON AN ERROR SCREEN ERASED THE ERROR.** `onError` repaints as text but leaves `last`
>    intact, so a `mousedown` at a button's former position passed the keypad guard, sent the action
>    into a dying session, and its repaint **wiped the only explanation of the failure off the screen**.
>    An `errored` flag — set there, cleared when a frame or an atlas repaints — closes it. Someone who
>    double-clicked a `.app` has no console to recover it from, which is the argument `onError` itself
>    is written on.
> 3. **TWO ADDITIONS BEYOND THE PLAN'S TEXT.** The press is taken on the **primary button only**:
>    `mousedown` fires for the right button too, and a right-click on `Clear` or a PF key would send it
>    to a live host while the context menu opened over the label. And `release()` is bound to **`blur`
>    as well as `mouseup`** — native capture covers a release outside the window, but not Alt+Tab, an X
>    grab or a lock screen, and a stuck highlight would persist on every later frame.
> 4. **THE HIGHLIGHT GUARD ASKS WHETHER `pressed` IS ONE OF *THIS FRAME'S* BUTTONS.** An identity
>    `includes`, not a search: a geometry change under a held button — a host switching model, so the
>    keypad's `y` moves — would otherwise highlight a rectangle no button occupies.
> 5. **`offsetX`/`offsetY` RATHER THAN `clientX - getBoundingClientRect().left`, and the reason is not
>    the obvious one.** It is that `offsetX` and the centring offset are measured from the SAME origin,
>    so the expression has **no scroll term at all to get wrong** — and the web page really does
>    scroll. The docstring records the two things a reader will suspect and why neither bites here
>    (`devicePixelRatio`, and a CSS `width`/`height` on the canvas).
>
> Two structural cleanups this task's import triggered are recorded on Tasks 5 and 6: `column()` moved
> to `cg.ts` (`abc9943`) and the shared types to the leaf `geometry.ts` (`3e20b3e`), the second of
> which removed **two type-position cycles** that `tsc --build` resolved silently and that
> `module-cycles.test.ts` now guards by reading the SOURCE — a `dist`-only scan cannot see an
> `import type`.

**Files:**
- Modify: `packages/canvas/src/renderer.ts`
- Test: none directly — this file is a browser entry point that throws at module load outside a
  browser, which is why `canvas`'s barrel does not export it. Its coverage is Tasks 13 and 14.

**This is the file the goldens and the click harness exist to check.** Keep the change small.

- [ ] **Step 1: Draw the region**

In `paint()`, after the OIA blit:

```ts
  // The keypad goes through the SAME blitter and atlas as the screen and the OIA -- one drawing
  // primitive, three regions. Passed as a one-row-style list because the blitter's only job is
  // "draw these cells".
  if (list.keypad !== undefined) {
    blit(ctx, { cells: list.keypad.cells, width: list.width, height: list.height }, options);
  }
```

- [ ] **Step 2: Hit-test a click**

Add near the `keydown` listener:

```ts
/**
 * A click on a keypad button.
 *
 * THE INVERSE OF THE DRAWING ARITHMETIC: the draw list is in scale-1 pixels and `paint` multiplies
 * by `scale` and adds the centring offset, so a click divides by the scale after subtracting that
 * offset. Getting this backwards puts the hit some multiple of the scale away from the finger, and
 * at scale 1 it would look correct -- which is why `browser-shot.mjs` runs at a size where the
 * scale is 1 and the click harness must not.
 *
 * `mousedown`, not `click`: the press highlight should appear under the finger, and a `click` only
 * arrives after release.
 */
canvas.addEventListener('mousedown', (e) => {
  if (last?.keypad === undefined) return;
  const within = { width: window.innerWidth, height: window.innerHeight };
  const scale = bestScale(last, within);
  const at = centre(last, within, scale);
  const x = (e.offsetX - at.x) / scale;
  const y = (e.offsetY - at.y) / scale;
  const button = hitTest(last.keypad.buttons, x, y);
  if (button === undefined) return;          // a gap, or the screen: not ours
  pressed = button;
  paint(last);                                // draw the highlight immediately
  window.tn3270.sendAction(button.action);
});

window.addEventListener('mouseup', () => {
  if (pressed === undefined) return;
  pressed = undefined;
  if (last !== undefined) paint(last);
});
```

with `let pressed: KeypadButton | undefined;` beside the other module state, and `hitTest` /
`KeypadButton` imported from **`./hittest.js`** — NOT from `./keypad.js`, which drags two workspace
packages into the renderer's graph and is not served to the browser. See Step 4.

- [ ] **Step 3: Draw the press highlight**

In `paint()`, after the keypad blit:

```ts
  // PURELY LOCAL, and deliberately: over a WebSocket a round trip for a press highlight would
  // lag visibly behind the finger. Nothing about it reaches the host.
  if (pressed !== undefined && list.keypad !== undefined) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(
      at.x + pressed.x * scale, at.y + pressed.y * scale,
      pressed.w * scale, pressed.h * scale,
    );
  }
```

`ctx` is narrowed to `Ctx2D`, which types `fillStyle` as a string — check that `fillRect` is on
that interface, and widen `Ctx2D` in `blit.ts` if it is not, rather than casting here.

- [ ] **Step 4: Build and confirm nothing regressed**

Run: `cd ~/git/tn3270 && npm run build && npm test && node packages/gui/scripts/shot.mjs && node packages/gui/scripts/keys.mjs`
Expected: all green, `2/2 goldens matched`, `ok 15 chords, 13 actions in order`.

**THIS PARAGRAPH WAS WRONG AND IS CORRECTED — 2026-09-16, Task 5's review.** It used to say
"`./keypad.js` is relative and fine". **Relative-ness is not graph-cleanliness**, which is the very
point `canvas/src/index.ts:12-16` already makes about `drawlist.js`. `keypad.ts` value-imports
`column` from `drawlist.js` plus `cp037`/`Colour` from `@tn3270/core` and
`KEYPAD_KEYS`/`schemeRgb` from `@tn3270/frontend`, so importing it into the renderer:

1. **fails `renderer-imports.test.ts`** — demonstrated, both assertions, by pulling `dist/drawlist.js`
   and two bare `@tn3270/` specifiers into the renderer's runtime graph; and
2. **is not in `BROWSER_MODULES`** (`assets.ts:39` — this said `:32`; the list has since gained
   `hittest.js`, and the declaration moved when its docstring grew), so the
   browser would 404 the module and paint a black canvas with **no error anywhere** — the closure
   failure this project has already been bitten by once.

**So the hit-test code must live in a dependency-free module of its own.** Task 5 moves `hitTest` and
`KeypadButton` into `packages/canvas/src/hittest.ts` (pure integer arithmetic, zero imports) and adds it
to `BROWSER_MODULES`; `keypadRegion`, `KeypadRegion` and `KEYPAD_ROWS_TALL` stay in `keypad.ts`, which
runs in main. **Import `./hittest.js` here, never `./keypad.js`.** Run
`npx vitest run packages/canvas/test/renderer-imports.test.ts` and confirm it passes — a runtime import
of a workspace package here blanks the window with no error.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/canvas/src/renderer.ts
git commit -m "feat(canvas): draw the keypad and hit-test a click

Three regions through one blitter. The click arithmetic is the exact inverse of the
drawing arithmetic -- subtract the centring offset, divide by the scale -- and
mousedown rather than click, so the press highlight lands under the finger.

The highlight is drawn locally and never leaves the renderer: over a WebSocket a
round trip for it would lag visibly. Only the action itself goes out, through the
sendAction the bridge already has, so there is no protocol change.

Generated with AI

Co-Authored-By: SLAC AI"
```

---
### Task 8: The Electron GUI holds the flag

> **AS BUILT (`086dbbe`). WENT AS PLANNED, and Step 2's question answered itself.**
>
> **`fit()` caches on `` `${list.width}x${list.height}` ``**, so a taller list resizes the window on
> the first frame after a toggle with no change needed — which is exactly what Step 2 asked to be
> verified by reading rather than assumed.
>
> **Step 3's capture was taken the way the reordering section required**, since no chord existed yet:
> the flag was temporarily defaulted to `true`, the shot came back **720x434** — 24 screen rows plus
> the OIA plus six keypad rows at 14px — with the keypad drawn in that band, and it was reverted to
> `false` before committing so both goldens still matched. The chord that reaches this at runtime
> arrived in Task 4.
>
> **The only extra work was citations, and it is the same lesson twice:** this diff moved
> `main.ts:290` to `:294`, invalidating the two places `canvas` cites it — and `web/src/main.ts`'s own
> `:276-277` was found **already stale**, pointing into `fit()`'s comment rather than at the
> `applyAction`/`send` pair it describes. Both retargeted in the same commit. (`:294` then became
> `:312` at Task 13, and Task 15 converted the citation to a NAME.)

**Files:**
- Modify: `packages/gui/src/main.ts`
- Test: `packages/gui/test/` — add to whichever file covers `main.ts`'s argv/seam behaviour; if
  none does, this task's coverage is Tasks 13 and 14, and say so in your report.

- [ ] **Step 1: Hold the flag and intercept the action**

Beside the other per-window state in `app.whenReady()`:

```ts
  // Per WINDOW, not per session: whether the keypad is shown is a property of this display, and
  // `Session` knows nothing about it. Off by default -- the keypad is toggled, not permanent.
  let showKeypad = false;
```

In `ipcMain.on('action', ...)`, before the `quit` check:

```ts
    // INTERCEPTED HERE, like `quit`, because `applyAction` throws on it: showing a keypad is a
    // display decision, and this is the front end that owns this display. Recomputing the frame is
    // what makes the window resize, since `fit` sizes from the draw list.
    if (action.kind === 'toggleKeypad') { showKeypad = !showKeypad; send(); return; }
```

In `send()`, pass the flag:

```ts
    const list = drawList(
      snapshot, resolve(snapshot), geometry, scheme, oia === '' ? undefined : oia, showKeypad,
    );
```

- [ ] **Step 2: Check `fit()` handles a taller list**

Read `fit()`. It keys its resize on the list's dimensions changing, so a taller list should resize
the window on the first frame after a toggle. **Verify by reading it, and report what you find.**
If it caches on `${list.width}x${list.height}` it already works; if it caches on the SCREEN size or
on the model, it will not notice the keypad and must be corrected — the failure would be a keypad
drawn outside the window, invisible, which is the model-4 clipping bug again.

- [ ] **Step 3: Build and drive it by hand**

```bash
cd ~/git/tn3270 && npm run build
[ -S /tmp/.X11-unix/X99 ] || node packages/gui/scripts/xvfb.mjs
TN3270_GUI_REPLAY=packages/fixtures/traces/synthetic-ispf-like.trace \
TN3270_GUI_KEYS='Ctrl+K' TN3270_GUI_SHOT=/tmp/keypad.png TN3270_GUI_SHOT_MS=3000 \
DISPLAY=:99 LD_LIBRARY_PATH=$HOME/micromamba/envs/gui/lib \
FONTCONFIG_PATH=$HOME/micromamba/envs/gui/etc/fonts \
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox --disable-gpu -insecure -model 3278-2-E 127.0.0.1:1
```

Expected: a `shot:` line reporting a capture **720x434** — 24 screen rows plus the OIA plus six
keypad rows, at 14px each. If it reports 720x350 the toggle did not reach main; if it reports
720x434 but the PNG's lower band is black, the region is present and not being drawn.

- [ ] **Step 4: Look at the PNG**

Confirm the keypad is legible and the labels are not overrunning each other. **This is the point at
which the provisional font decision gets its answer** — the spec ranks the fallbacks; if it looks
wrong, report that rather than changing anything, and the user decides.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/src/main.ts
git commit -m "feat(gui): hold the keypad flag and toggle it

Intercepted beside quit, because applyAction throws on toggleKeypad: it is a
display decision and this is the front end that owns this display. Recomputing the
frame is what resizes the window, since fit() sizes from the draw list -- so the
keypad cannot be clipped the way model 4's OIA row was.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 9: The gateway holds one flag per connection

> **AS BUILT (`2fb921c`, `b1fd951`). THE PLAN'S REATTACH TEST WOULD HAVE PASSED AGAINST THE WRONG
> IMPLEMENTATION.**
>
> 1. **THE REATTACH ASSERTION NEEDED A *THIRD* TOGGLE TO MEAN ANYTHING.** With the planned two, the
>    socket closed with the keypad **already hidden** — so the test passed against a
>    `WeakMap<Session, boolean>` in `buildServer`'s scope, i.e. against exactly the session-scoped flag
>    this task exists to avoid. It was satisfied by the *state*, not by the *lifetime*. It now closes
>    with the keypad showing. Likewise the height was pinned to the keypad's own top edge and lowest
>    button rather than to `toBeLessThan`, which any positive number satisfies.
> 2. **THIS TASK'S OWN STATED REASON FOR PER-CONNECTION WAS WRONG, and the corrected one is better.**
>    It claimed two browsers on one session are two *concurrent* windows; they cannot be — `attach`
>    admits only a DETACHED entry (`sessions.ts:61`) and `bridge.ts:35` keeps the id in per-tab
>    `sessionStorage`. The real harm is **sequential inheritance by the next attacher**: a gateway
>    `Session` deliberately outlives its socket, so the next window — possibly a different person —
>    would find its screen six rows taller than it left it. That is what the test drives.
> 3. **Step 5's answer changed the design.** `protocol.ts` did NOT need to leave the kind alone: Task 2
>    had added a stop-gap *rejection* there, and this task **removed it**, replacing it with the
>    per-connection intercept. Both halves landed in one commit so the process-kill window never
>    reopened. `protocol.ts:113-118` now records why the kind is deliberately accepted.
> 4. **`b1fd951` ADDED THE GUARD THE WHOLE EPISODE ARGUED FOR.** `protocol.ts`'s two-file rule was
>    prose with no enforcement, and this branch is the evidence of how fast that decays. Now **every
>    kind in the `Action` union is sent over a live socket**, each must be answered, and **a `tab`
>    after each must still return a frame** — the second half being what a gateway that replies and
>    then dies would otherwise pass. The kind list is **parsed out of the `Action` declaration at
>    runtime** rather than hand-listed, because no test file here is typechecked and a type-level trick
>    would enforce nothing; `quit` gets an expected-refusal branch rather than an exemption, so a
>    rejection that silently stopped happening still fails.

**Files:**
- Modify: `packages/web/src/main.ts`
- Test: `packages/web/test/integration.test.ts`

**Per CONNECTION, not per session.** Two browsers attached at different times are different
operators looking at different windows; one showing a keypad must not force it on the other. The
session outlives the socket, the keypad preference does not.

- [ ] **Step 1: Write the failing test**

```ts
it('toggles the keypad per connection, and does not force it on a reattaching client', async () => {
  const { url } = await start();
  const a = new WebSocket(url);
  await new Promise((r) => a.addEventListener('open', r, { once: true }));
  const first = collect(a, 3);
  a.send(JSON.stringify({ kind: 'hello' }));
  const id = (await first)[0]!['id'] as string;

  // Toggle on: the next frame carries the region.
  const shown = collect(a, 1);
  a.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));
  const withKeypad = (await shown)[0]!['list'] as { keypad?: unknown; height: number };
  expect(withKeypad.keypad).toBeDefined();

  // Toggle off again: gone, and the height goes back.
  const hidden = collect(a, 1);
  a.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));
  const without = (await hidden)[0]!['list'] as { keypad?: unknown; height: number };
  expect(without.keypad).toBeUndefined();
  expect(without.height).toBeLessThan(withKeypad.height);
  a.close();

  // A SECOND connection to the SAME session starts with the keypad hidden. The preference
  // belongs to the window, not to the 3270 session that outlives it.
  const b = new WebSocket(url);
  await new Promise((r) => b.addEventListener('open', r, { once: true }));
  const second = collect(b, 2);
  b.send(JSON.stringify({ kind: 'hello', sessionId: id }));
  const got = await second;
  const frame = got.find((m) => m['kind'] === 'frame')!['list'] as { keypad?: unknown };
  expect(frame.keypad).toBeUndefined();
  b.close();
});

it('does not let an unhandled toggleKeypad reach applyAction', async () => {
  // applyAction THROWS on it. If the server did not intercept it, the throw would land inside
  // applyAction's caller and the button would appear dead -- or worse, kill the connection.
  const { url } = await start();
  const ws = new WebSocket(url);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const first = collect(ws, 3);
  ws.send(JSON.stringify({ kind: 'hello' }));
  await first;
  const next = collect(ws, 1);
  ws.send(JSON.stringify({ kind: 'action', action: { kind: 'toggleKeypad' } }));
  // A frame, not an error message.
  expect((await next)[0]!['kind']).toBe('frame');
  ws.close();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/integration.test.ts`
Expected: FAIL — no `keypad` in the frame.

- [ ] **Step 3: Implement**

In the `upgrade` handler's per-connection scope, beside `repaint` and `stopListening`:

```ts
    // Per CONNECTION. Two browsers on the same 3270 session are two windows, and the session
    // outlives the socket while this preference does not.
    let showKeypad = false;
```

In `send()`, pass it to `drawList` as the sixth argument. In the action branch, before
`applyAction`:

```ts
      // INTERCEPTED, because `applyAction` throws on it. Not a security concern -- it toggles a
      // display -- but it must be handled rather than fall through, or the button is dead.
      if (msg.action.kind === 'toggleKeypad') { showKeypad = !showKeypad; repaint?.(); return; }
```

Note the ordering: this must come **after** the `logActions` write, so the harness still sees the
toggle in the action log, and **before** `applyAction`.

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm `protocol.ts` needs no change**

`decodeClientMessage` deliberately does not enumerate action kinds, and `toggleKeypad` carries no
numeric field to bound, so it passes through unchanged. **Confirm by reading it** and say so; do not
add it to the `quit` refusal, which exists because a browser must not be able to stop the gateway —
toggling its own keypad is not that.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/main.ts packages/web/test/integration.test.ts
git commit -m "feat(web): toggle the keypad per connection

Per connection rather than per session: two browsers on one 3270 session are two
windows, and the session outlives the socket while the preference does not -- a
reattaching client starts with the keypad hidden, which the test pins.

Intercepted before applyAction, which throws on toggleKeypad. protocol.ts needs no
change: it does not enumerate action kinds and there is no number to bound.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 10: `Dup()`, `FieldMark()` and `SysReq()` in the CLI

> **AS BUILT (`7eb6334`, `55dc6c8`). STEP 4's WARNING WAS EXACTLY RIGHT, AND THIS TASK IS WHAT
> DISCOVERED THAT SYS REQ DOES NOTHING HERE.**
>
> 1. **A NAME MUST BE REGISTERED TWICE.** `COMMAND_NAMES` in `commands.ts` is what `parseCommand`
>    validates against, so the `dispatch` half alone leaves every call failing as **"unknown
>    command"** — measured, all seven new tests failed that way before the table entry went in. Now
>    recorded on the table itself so the next command does not repeat it.
> 2. **SYS REQ IS REACHABLE FROM EVERYWHERE AND INERT ON BOTH LIVE HOSTS**, and making it callable is
>    what exposed that. `Session.sysreq()` returns early unless the TN3270E SYSREQ function was
>    negotiated, and neither Hercules host offers TN3270E — both answer `ff fe 28` = DONT. **x3270's
>    non-E path does not send AID `0xf0` either:** `ctlr_read_modified` has a dedicated
>    `case AID_SYSREQ` (`ctlr.c:770`) emitting a **four-byte TEST REQUEST record** and then breaking —
>    no AID byte, no cursor address, no field data. Recorded rather than fixed: core protocol surface,
>    not keypad work. **What must not happen is the docs claiming Sys Req works**, and Task 15's job
>    was to make sure they do not.
> 3. **ONE DELIBERATE DIVERGENCE ON ARGUMENTS, and it is defensible rather than lazy.** `SysReq`
>    really takes none (`check_argc 0,0`, `kybd.c:2852`), but s3270's `Dup` and `FieldMark` take 0
>    **or 1** (`:2769`, `:2807`), the optional argument being `FailOnError`/`NoFailOnError`. Both
>    keywords are **refused** rather than accepted-and-ignored: `oerr_fail = !IA_IS_KEY(ia)` (`:2766`)
>    is true for every scripted call, so failing on an operator error already IS s3270's default here
>    — and accepting `NoFailOnError` while still failing would answer `error` where s3270 answers
>    `ok`. The plan's `Dup(1)` assertion holds either way.
> 4. **Their refusal carries the OIA's reason**, because a numeric field takes Dup and refuses Field
>    Mark, and "X Protected" and "X Numeric" need different fixes.
>
> Three inbound citations retargeted for `runner.ts` growing 40 lines — including `core/keyboard.ts`'s
> `runner.ts:334`/`:364` for `Wait(Settle)`/`Wait(InputField)`, which was **already stale before this
> change** and is now `:691`/`:721`.

**Files:**
- Modify: `packages/cli/src/runner.ts`
- Modify: `packages/cli/src/commands.ts` if it holds a list of known command names — check
- Test: `packages/cli/test/runner.test.ts`

**This is conformance, not symmetry.** s3270 has all three by these names —
`Common/kybd.c:223` (`AnDup`), `:230` (`AnFieldMark`), `:254` (`AnSysReq`) — so a script written for
s3270 should not fail against us.

- [ ] **Step 1: Write the failing tests**

```ts
describe('Dup, FieldMark and SysReq', () => {
  it('Dup() writes 0x1c into the field', async () => {
    const { runner, session } = await connectedRunnerOnAnUnprotectedField();
    const at = session.screen.cursor;
    const out = await runner.run('Dup()');
    expect(out).toMatch(/\nok$/);
    expect(session.screen.cellAt(at).ebcdic).toBe(0x1c);
  });

  it('FieldMark() writes 0x1e', async () => {
    const { runner, session } = await connectedRunnerOnAnUnprotectedField();
    const at = session.screen.cursor;
    await runner.run('FieldMark()');
    expect(session.screen.cellAt(at).ebcdic).toBe(0x1e);
  });

  it('SysReq() reaches Session.sysreq', async () => {
    const { runner, session } = await connectedRunner();
    const spy = vi.spyOn(session, 'sysreq');
    const out = await runner.run('SysReq()');
    expect(spy).toHaveBeenCalledOnce();
    expect(out).toMatch(/\nok$/);
  });

  it('reports a refusal as an error reply, not a crash', async () => {
    // A protected field refuses Dup. The CLI's contract is an `error` reply with the reason.
    const { runner } = await connectedRunnerOnAProtectedField();
    expect(await runner.run('Dup()')).toMatch(/\nerror$/);
  });

  it('takes no arguments', async () => {
    const { runner } = await connectedRunner();
    expect(await runner.run('Dup(1)')).toMatch(/\nerror$/);
  });
});
```

Reuse the file's existing helpers for building a connected runner; the names above are
placeholders for whatever it already has. **Do not add a second way to build a runner.**

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/cli/test/runner.test.ts`
Expected: FAIL — unknown action.

- [ ] **Step 3: Implement**

In `runner.ts`'s `dispatch` switch, beside `case 'Attn':`:

```ts
      // s3270 has all three by these names: Common/kybd.c:223, :230, :254. Dup and FieldMark are
      // typed CHARACTERS -- they go to the keyboard, never to sendAID.
      case 'Dup': {
        if (args.length !== 0) throw new Error('Dup() takes no arguments');
        if (!k.dup()) throw new Error('input inhibited');
        return;
      }
      case 'FieldMark': {
        if (args.length !== 0) throw new Error('FieldMark() takes no arguments');
        if (!k.fieldMark()) throw new Error('input inhibited');
        return;
      }
      case 'SysReq': {
        if (args.length !== 0) throw new Error('SysReq() takes no arguments');
        s.sysreq();
        return;
      }
```

**`toggleKeypad` gets no CLI command**, deliberately: a script-driven client has no renderer, which
is the same reason `-scheme` is absent there.

- [ ] **Step 4: Check the command name list**

If `commands.ts` validates names against a table, add the three there too. **Read it: a name missing
from that table would be rejected before `dispatch` ever saw it**, and the failure would look like
an unimplemented action rather than a missing table entry.

- [ ] **Step 5: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/cli/test/runner.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/cli/src/runner.ts packages/cli/src/commands.ts packages/cli/test/runner.test.ts
git commit -m "feat(cli): Dup(), FieldMark() and SysReq()

Conformance rather than symmetry: s3270 has all three by these names (kybd.c:223,
230, 254), so a script written for it should not fail against us. Dup and FieldMark
go to the keyboard, never to sendAID, being typed characters.

toggleKeypad gets no command: a script-driven client has no renderer, which is why
-scheme is absent there too.

Generated with AI

Co-Authored-By: SLAC AI"
```

---
### Task 11: The TUI's special-keys overlay

> **AS BUILT (`44b4177`, `dcb644f`, `edc814c`). THREE DEPARTURES FROM THE PLAN, EACH BECAUSE THE
> SOURCE DISAGREED WITH IT.**
>
> 1. **THE PLAN'S TWO HEADLINE ASSERTIONS COULD NOT PASS YET.** `Dup  Ctrl-D` and
>    `Field Mark  Ctrl-F` require `BINDING_INTENT` rows that are **Task 4's**, and Task 4 now runs
>    *after* this. Rather than fabricate them, the test asserts the **mechanism over every key** in
>    the table against whatever `BINDING_INTENT` holds — so the two chords appeared the moment Task 4
>    landed, with no edit to the test. That is the property the indirection was bought for, and it was
>    observed rather than assumed.
> 2. **`OVERLAY_MIN.cols` IS 29, NOT 34.** The widest line is 27 cells (mark, space, the 14-character
>    `System Request`, two spaces, the 9-character `Shift-Tab`) plus a cell of frame each side; 34 was
>    five cells of refusal nothing needed. **A too-large minimum only ever refuses, so nothing
>    reddens** — the third over-declaration on this branch after Tasks 5 and 6. Pinned from both
>    directions now.
> 3. **`chordFor` COMPARES ACTIONS STRUCTURALLY, NOT BY `JSON.stringify`.** Stringify compares
>    *serialisations*: reordering `{ kind, n }` in either table would stop matching and show a blank —
>    and **a blank here reads as "no chord exists", a wrong answer indistinguishable from a right
>    one.**
> 4. **THE SWEEP OVER EVERY KEY IS A MIRROR TEST, and `dcb644f` backed it with ground truth.** It
>    recomputes the module's own matching rule, so a rule wrong the same way in both would pass. The
>    two hardcoded lines behind it were `Reset` and `Back Tab`, both `kind`-only, so neither exercised
>    the `n` field — the one place structural matching does any work. **PF13 is the discriminating
>    case**: a lookup matching on `kind` alone hands every PF key the first `pf` row's chord, so PF13
>    would read `F1`. Verified by mutation, and PF1 alone cannot tell the two apart, which is why both
>    are pinned.
>
> **AND THE FINDING THAT CHANGED A SUCCESS CRITERION:** `overlayFits` **cannot return false for any
> terminal a live session runs in**, because `tooSmall` (`tui/src/render.ts:43`) already refuses below
> 24x80 and the smallest 3270 screen *is* 24x80. Criterion 5 claimed a refusal an operator cannot
> provoke. Encoded as "`OVERLAY_MIN` must never exceed 24x80" **rather than by inflating the minimum
> to manufacture a reachable refusal**, which would have been a fabricated success criterion.

**Files:**
- Create: `packages/tui/src/keypadOverlay.ts`
- Test: `packages/tui/test/keypadOverlay.test.ts`

A list, not a keypad. c3270's own keypad is about 16 rows tall and our TUI refuses to draw below 24
rows, so a faithful one would hide most of the 3270 display to show itself. A compact list overlays
a corner and can refuse when even that will not fit.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { KEYPAD_KEYS } from '@tn3270/frontend';
import { overlayLines, overlayFits, moveSelection, OVERLAY_MIN } from '../src/keypadOverlay.js';

describe('overlayLines', () => {
  it('lists every key in the table', () => {
    const lines = overlayLines(0);
    for (const k of KEYPAD_KEYS) {
      expect(lines.join('\n')).toContain(k.name);
    }
  });

  it('shows the chord beside a key that has one, and nothing beside Sys Req', () => {
    // Sys Req deliberately has no chord (c3270 defines none), which is WHY the overlay exists:
    // it is the only keyboard route to it. A blank there is correct, not missing.
    const text = overlayLines(0).join('\n');
    expect(text).toMatch(/Dup\s+Ctrl-D/);
    expect(text).toMatch(/Field Mark\s+Ctrl-F/);
    expect(text).toMatch(/System Request\s*$/m);
  });

  it('marks exactly one line as selected', () => {
    const marked = overlayLines(3).filter((l) => l.startsWith('>'));
    expect(marked).toHaveLength(1);
  });
});

describe('moveSelection', () => {
  it('moves by one and CLAMPS rather than wrapping', () => {
    // Clamped, not wrapped: a wrap at 46 entries means holding an arrow silently cycles past the
    // key you were aiming at, which is worse than stopping.
    expect(moveSelection(0, -1)).toBe(0);
    expect(moveSelection(0, 1)).toBe(1);
    expect(moveSelection(KEYPAD_KEYS.length - 1, 1)).toBe(KEYPAD_KEYS.length - 1);
  });
});

describe('overlayFits', () => {
  it('refuses a terminal too small to hold it', () => {
    // The TUI's rule: never show a partial thing. It refuses the OVERLAY, not the session.
    expect(overlayFits({ rows: OVERLAY_MIN.rows - 1, cols: 80 })).toBe(false);
    expect(overlayFits({ rows: 24, cols: OVERLAY_MIN.cols - 1 })).toBe(false);
    expect(overlayFits({ rows: 24, cols: 80 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/tui/test/keypadOverlay.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement**

`packages/tui/src/keypadOverlay.ts`:

```ts
import { KEYPAD_KEYS, BINDING_INTENT, type Action } from '@tn3270/frontend';
import type { Geometry } from './render.js';

/**
 * The special-keys overlay: the keypad table as a navigable list.
 *
 * ## WHY A LIST AND NOT c3270'S KEYPAD
 *
 * c3270's keypad is about 16 rows tall (`Common/c3270/keypad.outline`). This TUI refuses to draw
 * below 24 rows and centres the screen above that, so a faithful keypad would have to hide most of
 * the 3270 display in order to show itself. A list overlays a corner and can refuse to open at all.
 *
 * ## THE CHORDS COME FROM `BINDING_INTENT`, NOT FROM A SECOND LIST
 *
 * That table already records key-to-action with a note, and there is already a test that the
 * terminal keymap agrees with it. Reading it here means the on-screen help cannot drift from the
 * bindings — which is exactly the kind of documentation that otherwise rots. A key with no chord
 * (Sys Req) shows a blank, which is correct: the overlay is its only keyboard route.
 */
export const OVERLAY_MIN: Geometry = { rows: 12, cols: 34 };

/** Longest name in the table, for column alignment. Computed, never hardcoded. */
const NAME_WIDTH = Math.max(...KEYPAD_KEYS.map((k) => k.name.length));

const chordFor = (action: Action): string => {
  const hit = BINDING_INTENT.find((b) => JSON.stringify(b.action) === JSON.stringify(action));
  return hit?.key ?? '';
};

export function overlayLines(selected: number): readonly string[] {
  return KEYPAD_KEYS.map((k, i) => {
    const mark = i === selected ? '>' : ' ';
    return `${mark} ${k.name.padEnd(NAME_WIDTH)}  ${chordFor(k.action)}`.trimEnd();
  });
}

/** Clamped, never wrapped: see the test for why. */
export function moveSelection(selected: number, delta: number): number {
  return Math.min(KEYPAD_KEYS.length - 1, Math.max(0, selected + delta));
}

export function overlayFits(terminal: Geometry): boolean {
  return terminal.rows >= OVERLAY_MIN.rows && terminal.cols >= OVERLAY_MIN.cols;
}

/** The action the selected line fires. */
export function selectedAction(selected: number): Action {
  return KEYPAD_KEYS[Math.min(KEYPAD_KEYS.length - 1, Math.max(0, selected))]!.action;
}
```

`overlayLines` returns all 46 lines, which is taller than 12 rows. **Scrolling is the caller's
job** — Task 12 passes a window of them. Note this in your report if the split feels wrong; it is
deliberate so this module stays pure and testable.

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/tui/test/keypadOverlay.test.ts`
Expected: PASS, five tests.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/tui/src/keypadOverlay.ts packages/tui/test/keypadOverlay.test.ts
git commit -m "feat(tui): the special-keys overlay, as pure functions

A list rather than c3270's 16-row keypad, which would hide most of a 24-row
display to show itself. Chords are read from BINDING_INTENT rather than a second
list, so the on-screen help cannot drift from the bindings; Sys Req shows a blank
because it has no chord, which is precisely why the overlay is its only keyboard
route.

Selection clamps rather than wrapping: with 46 entries a wrap means holding an
arrow silently cycles past the key you were aiming at.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 12: Wire the overlay into the TUI

> **AS BUILT (`eeb591f`). THE INTERCEPT IS THE WHOLE TASK, AND THE PLAN'S KEY HANDLING WOULD HAVE
> BROKEN THE DOWN ARROW ON HALF OF ALL TERMINALS.**
>
> 1. **A SPLIT ARROW MUST NOT READ AS ESCAPE.** `\x1b` and `[B` can arrive in **separate reads** —
>    that is the delivery `escHeld` exists for — so the plan's `if (seq === '\x1b')` close would make
>    the **down arrow close the list** on any terminal that splits. An incomplete prefix is now held
>    for the same 50ms, **with its own timer and its own pending bytes** rather than perturbing
>    `buffer`/`escHeld`, and only a lone ESC that outlives the window closes. The scan is a **loop**,
>    not a match on the whole chunk, so coalesced autorepeat (`\x1b[B\x1b[B` in one read) moves twice
>    rather than not at all — and a keystroke sharing a read with the closing key is handed back to
>    `pump()` instead of dropped.
> 2. **THE WINDOW FOLLOWS THE SELECTION.** Step 4 offered first-N as an acceptable first cut provided
>    it was reported; it was **not taken**, because first-N leaves everything from `Attention` down —
>    **including Sys Req, whose only keyboard route this is** — permanently unreachable. That is not a
>    limitation worth shipping for the sake of a smaller diff.
> 3. **THE CELL DIFF CANNOT SEE WHAT THE LIST IS DRAWN OVER**, so `paint` invalidates those lines
>    whenever they change. Without that, **closing the list would leave it on screen.**
> 4. **THE FOCUS RULE IS MUTATION-CONFIRMED, and it reddens ten tests, not one.** Removing the
>    `overlayShown` intercept fails the "does not type into the screen" case with
>    `expected 'A' to be ' '`. Without it, letters reach the field behind the list and **AIDs are sent
>    from something the operator was only reading.**
> 5. **The intercept sits in `onInput` ahead of the buffer and `pump()`**, exactly as Step 3 required,
>    so the ESC state machine and its two recorded regressions are untouched.
>
> Step 3's guessed names: the geometry comes from the app's own terminal measurement and the message
> goes through the existing one-line banner slot — read from `app.ts` rather than invented. **`Ctrl-K`
> was NOT bound yet** (Task 4 runs after this), so the tests open the list by dispatching the action;
> Task 4 then added the byte-level `0x0b` test.

**Files:**
- Modify: `packages/tui/src/app.ts`
- Modify: `packages/tui/src/render.ts` (`paint` gains an optional overlay)
- Test: `packages/tui/test/app.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('the special-keys overlay', () => {
  it('opens on Ctrl-K and closes on Esc, without sending anything to the host', () => {
    const { app, conn } = newApp();
    conn.sent = [];
    app.onInput(new Uint8Array([0x0b]));
    expect(app.overlayOpen).toBe(true);
    expect(conn.sent).toEqual([]);
    app.onInput(new Uint8Array([0x1b]));
    expect(app.overlayOpen).toBe(false);
  });

  it('fires the selected action on Enter and closes', () => {
    // Enter must fire the SELECTED key, not the Enter AID: while the overlay is up it belongs to
    // the overlay. Closing afterwards is what stops a second Enter re-firing it.
    const { app, session } = newApp();
    const spy = vi.spyOn(session, 'sysreq');
    app.onInput(new Uint8Array([0x0b]));
    // Move to System Request, wherever it is in the table.
    const target = KEYPAD_KEYS.findIndex((k) => k.action.kind === 'sysreq');
    for (let i = 0; i < target; i++) app.onInput(new Uint8Array([0x1b, 0x5b, 0x42])); // CSI B
    app.onInput(new Uint8Array([0x0d]));
    expect(spy).toHaveBeenCalledOnce();
    expect(app.overlayOpen).toBe(false);
  });

  it('does NOT type into the screen while the overlay is up', () => {
    // The overlay owns the keyboard while open. A letter reaching the field would be a silent
    // corruption of whatever the operator was in the middle of typing.
    const { app, session } = newApp();
    app.onInput(new Uint8Array([0x0b]));
    const before = session.screen.snapshot().cells.map((c) => c.ebcdic).join(',');
    app.onInput(new Uint8Array([0x41]));    // 'A'
    expect(session.screen.snapshot().cells.map((c) => c.ebcdic).join(',')).toBe(before);
  });

  it('refuses to open in a terminal too small to hold it, and says so', () => {
    const { app, stdout } = newApp({ rows: 8, cols: 20 });
    app.onInput(new Uint8Array([0x0b]));
    expect(app.overlayOpen).toBe(false);
    expect(stdout.written.join('')).toMatch(/too small/i);
  });
});
```

`newApp` is whatever `app.test.ts` already uses; add an optional geometry parameter to it if it has
none. `app.overlayOpen` is a new public readonly getter, added for testability the same way
`onInput` is public "so a test needs no real TTY".

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/tui/test/app.test.ts`
Expected: FAIL — no `overlayOpen`.

- [ ] **Step 3: Add overlay state and key handling to `app.ts`**

Add the field and getter:

```ts
  private overlaySelected = 0;
  private overlayShown = false;

  /** Public for tests, like `onInput`: a test should not have to infer this from bytes. */
  get overlayOpen(): boolean { return this.overlayShown; }
```

In `apply()`, before the `quit` check:

```ts
    // The overlay is THIS front end's answer to toggleKeypad: a list, not a keypad. `applyAction`
    // throws on the action, so it must be intercepted here.
    if (action.kind === 'toggleKeypad') { this.toggleOverlay(); return; }
```

Add:

```ts
  /**
   * Open or close the overlay.
   *
   * REFUSES rather than drawing a partial one, which is the rule this front end already applies to
   * a too-small screen. The message goes through the same one-line slot the banner uses.
   */
  private toggleOverlay(): void {
    if (this.overlayShown) {
      this.overlayShown = false;
      this.draw();
      return;
    }
    if (!overlayFits(this.terminalGeometry())) {
      this.showMessage('terminal too small for the special-keys list');
      return;
    }
    this.overlayShown = true;
    this.overlaySelected = 0;
    this.draw();
  }
```

**`terminalGeometry()` and `showMessage()` are names this plan is guessing at.** Read `app.ts` for
how it learns the terminal size and how it writes the banner, and use those. Report what they are
actually called.

In the input path, **before** the keymap lookup, intercept while the overlay is open:

```ts
    // WHILE THE OVERLAY IS OPEN IT OWNS THE KEYBOARD. Falling through to `lookup` would type
    // letters into the field behind it, silently corrupting whatever was half-entered.
    if (this.overlayShown) {
      if (this.consumeOverlayKey(bytes)) return;
    }
```

with:

```ts
  /** Returns true if the bytes were the overlay's. Esc closes, Enter fires, CSI A/B move. */
  private consumeOverlayKey(bytes: Uint8Array): boolean {
    const seq = String.fromCharCode(...bytes);
    if (seq === '\x1b') { this.overlayShown = false; this.draw(); return true; }
    if (seq === '\r' || seq === '\n') {
      const action = selectedAction(this.overlaySelected);
      this.overlayShown = false;
      applyAction(this.session, action);
      this.draw();
      return true;
    }
    if (seq === '\x1b[A' || seq === '\x1bOA') {
      this.overlaySelected = moveSelection(this.overlaySelected, -1);
      this.draw();
      return true;
    }
    if (seq === '\x1b[B' || seq === '\x1bOB') {
      this.overlaySelected = moveSelection(this.overlaySelected, 1);
      this.draw();
      return true;
    }
    // Ctrl-K again closes it, so the same chord is a real toggle.
    if (seq === '\x0b') { this.overlayShown = false; this.draw(); return true; }
    return true;                              // swallow everything else: the overlay has focus
  }
```

**Both SS3 and CSI arrow forms are accepted**, for the reason `bindings.ts` gives: any layer can
flip DECCKM, so naming one form would work in some terminals and not others.

**Do not route these bytes through the ESC state machine.** This intercept sits before it and
returns, so `escHeld` and the 50ms timer are untouched — their comments record two regressions.

- [ ] **Step 4: Draw it**

In `render.ts`, extend `paint`:

```ts
  paint(
    cells: readonly ResolvedCell[],
    cursor: number,
    status: string,
    overlay?: readonly string[],
  ): string {
```

and, after the screen and status are emitted, draw the overlay lines over the screen area — top-left
of the screen region, one line per row, reverse video for the line beginning `>`. Follow whatever
escape-sequence helpers the file already has; **do not hand-write SGR codes if it has a helper.**

In `app.ts`'s `draw()`:

```ts
    const overlay = this.overlayShown
      ? overlayLines(this.overlaySelected).slice(0, this.overlayRows())
      : undefined;
    const out = this.renderer.paint(cells, ..., overlay);
```

The `slice` is the scrolling Task 11 left to the caller: show as many lines as fit, starting at a
window that keeps the selection visible. **A first cut may show the first N lines and clamp the
selection to them; if you do that, say so** — it means keys past line N are unreachable, which is a
real limitation and must not be silently shipped.

- [ ] **Step 5: Run everything**

Run: `cd ~/git/tn3270 && npm run build && npm test && python3 packages/tui/scripts/pty-smoke.py`
Expected: all green, `pty-smoke.py` 12/12.

- [ ] **Step 6: Mutation-check the focus rule**

Remove the `if (this.overlayShown)` intercept, re-run
`npx vitest run packages/tui/test/app.test.ts`, and confirm the "does NOT type into the screen"
test FAILS. Restore. **Report it.** That intercept is the difference between an overlay and a
keylogger for the field behind it.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270
git add packages/tui/src/app.ts packages/tui/src/render.ts packages/tui/test/app.test.ts
git commit -m "feat(tui): open the special-keys overlay on Ctrl-K

While it is open it OWNS the keyboard: without that intercept a letter falls
through to the field behind it and silently corrupts whatever was half-entered,
which the mutation check confirms. Both SS3 and CSI arrow forms are accepted,
because any layer can flip DECCKM.

The intercept sits before the ESC state machine and returns, so escHeld and the
50ms timer are untouched. It refuses to open in a terminal too small to hold it,
following the rule this front end already applies to a too-small screen.

Generated with AI

Co-Authored-By: SLAC AI"
```

---
### Task 13: `TN3270_GUI_CLICKS` — real mouse events at real buttons

> **AS BUILT (`24c36ae`, with `a95dbd2` and `044f9e8` narrowing the task first). THREE PLACES THE PLAN
> AND THE SOURCE DISAGREED, ALL RESOLVED IN THE SOURCE'S FAVOUR.**
>
> 1. **THE SEAM DOES NOT IMPLY THE KEYPAD, AND CANNOT.** Step 1's comment said it turns the keypad on;
>    two on-switches would toggle it back **off**. `clicks.mjs` shows it with a real `Ctrl+K` instead —
>    which is why `toggleKeypad` is the first expected action and why the run reports **one more action
>    than it has buttons**.
> 2. **THE ZERO-LENGTH BAIL IS ON `CASES.length`, NOT `expected.length`.** The latter always holds at
>    least `toggleKeypad`, so it could never redden.
> 3. **`spawnSync` IS CORRECT HERE AND IS PINNED *PRESENT*.** Pinning it absent is
>    `browser-harness-flags.test.ts`'s check, and it belongs to a harness that reads a *second*
>    child's pipe. Copying the wrong guard would have been cargo cult.
>
> **THE MUTATION IS THE POINT AND IT WAS RUN.** A bare `return` at the top of the `mousedown` listener
> leaves `npm run build`, `npm run typecheck` and `npm test` **all clean** while every keypad button is
> dead; `clicks.mjs` fails all the click positions **and passes position 0**, so it says "the keypad
> appeared and the clicks did nothing" rather than merely "something is wrong". (The `e.button !== 0`
> guard was no longer available as the mutation, being a real guard by then — recorded in `a95dbd2`.)
>
> **`maybeSendClicks` CATCHES A REJECTED PROBE rather than letting it hang**: an unhandled rejection
> inside `app.whenReady()` skips `quitIfKeysOnly` and the client sits until the harness timeout — the
> trap `maybeSendKeys` already measured for a bad key spelling.
>
> **ONE CLAIM THIS TASK MADE ABOUT ITSELF WAS TOO STRONG.** Swapping `Dup`'s and `FldMk`'s actions
> fails this harness at two positions — **but it also fails two unit tests**, so the plan's "this is the
> only cover for the label/action pairing" is wrong. The true claim is narrower: **the goldens cannot
> see it, and this is the only place the pairing is checked *through the drawn button*.**
>
> Step 5a's three sizing facts (above) are why this harness runs at scale 1 and does **not** try to
> exercise the centring offset: Task 7 pulled the arithmetic into `hitTestAt` and unit-tested it at
> scale 3 with a non-zero offset, so both fatal mutations already redden `npm test`. `a039287` later
> added a ninth case, `NewLn` — newest button, only one on its row past `BkSp`, and the only one whose
> column had been asserted *empty* until it arrived. **Final figure: `ok 9 buttons, 10 actions in
> order (toggleKeypad + 9)`.**

**Files:**
- Modify: `packages/gui/src/main.ts` (a fifth test seam)
- Create: `packages/gui/scripts/clicks.mjs`
- Create: `packages/gui/test/clicks-harness-flags.test.ts`

**Why this exists.** The click path — canvas `mousedown`, the scale-and-offset inverse, `hitTest`,
`sendAction`, IPC, `applyAction` — is exactly the plumbing no unit test reaches. This is the same
argument the chord guard already won: add `if (e.button !== 0) return;` at the top of the `mousedown`
listener and `npm test` stays fully green while every button is dead. `keys.test.ts` cannot see it,
because it calls `actionForKey` and never touches a mouse.

- [ ] **Step 1: Add the seam**

In `SEAM`:

```ts
  /**
   * A FIFTH TEST SEAM: `TN3270_GUI_CLICKS='PF1,PA2,SysRq'` clicks keypad buttons by LABEL.
   *
   * Labels, not coordinates. A coordinate list would be a second copy of the layout, and it would
   * pass while the layout was wrong — which is the one thing this seam exists to catch. Main asks
   * the renderer for the button's centre and delivers a real `mouseDown`/`mouseUp` pair through
   * `sendInputEvent`, so the click enters at the top of Chromium's input pipeline exactly as
   * `TN3270_GUI_KEYS` does for keys.
   *
   * Implies the keypad: a click seam with the keypad hidden would hit nothing, so this turns it on.
   */
  clicks: process.env['TN3270_GUI_CLICKS'] ?? '',
```

- [ ] **Step 2: Deliver the clicks**

Add, alongside `maybeSendKeys`:

```ts
/**
 * Click each named button, by asking the renderer where it is.
 *
 * THE RENDERER IS ASKED rather than told, because it is the only place that knows the scale and the
 * centring offset it last painted with. Computing them here would duplicate `bestScale`/`centre`
 * and would agree with the renderer right up until one of them changed.
 */
async function maybeSendClicks(win: BrowserWindow): Promise<void> {
  if (SEAM.clicks === '') return;
  await new Promise((r) => setTimeout(r, SEAM.keysMs));
  for (const label of SEAM.clicks.split(',')) {
    const at = await win.webContents.executeJavaScript(
      `window.__tn3270ButtonCentre(${JSON.stringify(label)})`,
    ) as { x: number; y: number } | null;
    if (at === null) {
      process.stdout.write(`clicks: NO BUTTON ${label}\n`);
      continue;
    }
    for (const type of ['mouseDown', 'mouseUp'] as const) {
      win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  // Drained before exiting, for the reason quitIfKeysOnly spells out: a write to a PIPE and an
  // immediate exit delivered exactly 64000 bytes once and lost the last line.
  process.stdout.write(`clicks: sent ${SEAM.clicks}\n`);
}
```

Call it from both the replay branch and the connected path, beside `maybeSendKeys`, and make
`quitIfKeysOnly` treat a clicks-only run the way it treats a keys-only one. **Read that function and
extend its condition rather than adding a second quit path.**

- [ ] **Step 3: Expose the button centre from the renderer**

In `renderer.ts`:

```ts
/**
 * TEST SEAM, and the only thing in this file that exists for a test.
 *
 * Returns the CENTRE of a named button in viewport pixels, so `clicks.mjs` can click it without
 * knowing the layout, the scale or the offset. Returning coordinates rather than firing the action
 * is what keeps the seam honest: the click still goes through Chromium.
 */
(window as unknown as { __tn3270ButtonCentre: (label: string) => { x: number; y: number } | null })
  .__tn3270ButtonCentre = (label) => {
    if (last?.keypad === undefined) return null;
    const button = last.keypad.buttons.find((b) => b.label === label);
    if (button === undefined) return null;
    const within = { width: window.innerWidth, height: window.innerHeight };
    const scale = bestScale(last, within);
    const at = centre(last, within, scale);
    return {
      x: at.x + (button.x + button.w / 2) * scale,
      y: at.y + (button.y + button.h / 2) * scale,
    };
  };
```

- [ ] **Step 4: Write the harness**

`packages/gui/scripts/clicks.mjs`, modelled on `keys.mjs` — **copy its structure, including the
staleness guard over `gui` and `canvas`, the four ordered bails (`error`, then `signal`, then
`status`, then the seam-ran check) and the `renderer[3]` filter.** Differences:

- `ARGV` adds nothing; the seam implies the keypad.
- `CASES` is a list of `{ label, action }` pairs covering at least one button from every cluster,
  and **both** buttons whose actions are new in this branch (`SysRq`, `Dup`, `FldMk`):

```js
const CASES = [
  { label: 'PF1', action: { kind: 'pf', n: 1 } },
  { label: 'PF24', action: { kind: 'pf', n: 24 } },
  { label: 'PA2', action: { kind: 'pa', n: 2 } },
  { label: 'SysRq', action: { kind: 'sysreq' } },
  { label: 'Dup', action: { kind: 'dup' } },
  { label: 'FldMk', action: { kind: 'fieldMark' } },
  { label: 'Enter', action: { kind: 'enter' } },
  { label: 'BkSp', action: { kind: 'backspace' } },
];
```

- The environment sets `TN3270_GUI_REPLAY`, `TN3270_GUI_CLICKS` (the labels, joined) and
  `TN3270_GUI_KEYS: 'Ctrl+K'` — the keypad has to be SHOWN before a click can land on it. Assert the
  ordered action list is `toggleKeypad` followed by each case's action.
- Add a bail on `clicks: NO BUTTON`, which means the label is not in the layout — a typo in `CASES`
  or a renamed key, and it must not be reported as a plumbing failure.

Expected output: `ok 8 buttons, 8 actions in order`.

- [ ] **Step 5: Pin the invocation**

`packages/gui/test/clicks-harness-flags.test.ts`, modelled on `keys-harness-flags.test.ts`: read
`clicks.mjs` as text and pin `--no-sandbox`, `--disable-gpu`, `TN3270_GUI_REPLAY` (so it can reach
no host), the `Ctrl+K` that shows the keypad, `Math.max(expected.length, actual.length)`, the
zero-length bail, the `NO BUTTON` bail, the ordered `error`/`signal`/`status` checks, and the
absence of `spawnSync(`. **Say on each test what its absence would cost.**

- [ ] **Step 5a: WHAT THIS HARNESS DOES AND DOES NOT HAVE TO PROVE — read before sizing anything**

**THE COORDINATE ARITHMETIC IS ALREADY UNIT-TESTED, so this harness does not have to carry it.** Task 7
extracted `hitTestAt(buttons, offsetX, offsetY, at, scale)` into `hittest.ts` — import-free, so it stays
inside the renderer's clean graph — and pinned it at `scale: 3` with `at: {x: 40, y: 17}`, where both
fatal mutations (multiplying instead of dividing, and dropping the centring offset) redden `npm test`.
That was worth doing because of what this file is: **`renderer.ts` is executed by nothing in the suite**,
and the project has measured that `if (e.altKey) return;` in its `keydown` listener leaves the suite
fully green while every Alt chord is dead.

**So this task's job is the PLUMBING, not the geometry**: `mousedown` → the `e.button` guard → `hitTest`
→ `sendAction` → IPC → `applyAction`. That is exactly what the chord guard established as the thing only
a harness can reach, and it is provable at any scale.

**Why the tempting "just run it at scale ≥ 2 with a non-zero offset" is harder than it sounds — three
measured facts, so nobody re-derives them:**

1. **In native Electron mode the centring offset can NEVER be non-zero, at any scale.** `fit()`
   (`main.ts:312`; this said `:290`, one of the four places that number went stale)
   sets the content size to exactly `list.width * scale` × `list.height * scale`, so
   `window.innerWidth === list.width * scale` and `centre` returns `(0,0)` for every model.
   `TN3270_GUI_SIZE` is meaningful **only alongside `url`** (`main.ts:101`), where `fit()` never runs — so
   an offset test must go through the URL seam, `browser-shot.mjs`-style.
2. **720x350 is derived, not chosen.** `xvfb.mjs:26` starts `:99` at `1280x1024`; `fit()` takes 80% of the
   work area and `bestScale(720x350)` there is 1. **Enlarging that screen would change `fit()`'s scale and
   move both GUI goldens**, so do not touch `:99`.
3. **A narrow geometry is NOT the way out.** 40 columns gives `list.width` 360 against a keypad 648 wide,
   so the buttons fall outside the drawing extent — the horizontal overflow Task 6 pinned
   (`keypad.width <= list.width` holds only from 72 columns up). And an 80-column screen with the keypad
   is 720x434, which at scale 2 is 1440x868 and does not fit in 1280 wide.

**If you do want the offset exercised end to end, the honest route is a SECOND Xvfb display** (say `:98`
at 1600x1200) used only by this harness in URL mode, leaving `:99` and the goldens alone —
`xvfb.mjs:40-42` already warns that two harnesses sharing a display number collide. Treat that as
optional: the arithmetic has a unit test, and this harness's value is the plumbing.

Note also that `renderer.ts` now really does contain `if (e.button !== 0) return;` — a deliberate guard,
because `mousedown` fires for the right button too and a right-click on `Clear` would otherwise send it
to a live host while the context menu opened. **So that line is no longer available as this task's
mutation**; use the bare `return;` the next step already specifies.

- [ ] **Step 6: Run it, and mutation-check it**

```bash
cd ~/git/tn3270 && npm run build && node packages/gui/scripts/clicks.mjs
```
Expected: `ok 8 buttons, 8 actions in order`.

Then the mutation that justifies the whole task: add `if (e.button !== 0) return;` — no, use
something that cannot be argued as correct — add `return;` as the first line of the `mousedown`
listener in `renderer.ts`, rebuild, and confirm **`npm test` stays fully green** while `clicks.mjs`
fails all eight positions. Restore with `git checkout` and
`npx tsc --build --force packages/canvas packages/gui`. **Report both halves**: the green suite is
half the finding.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/src/main.ts packages/canvas/src/renderer.ts packages/gui/scripts/clicks.mjs packages/gui/test/clicks-harness-flags.test.ts
git commit -m "test(gui): click real keypad buttons with real mouse events

The click path -- mousedown, the scale-and-offset inverse, hitTest, sendAction, IPC,
applyAction -- is plumbing no unit test reaches. Proof, run as a mutation: a bare
return at the top of the mousedown listener leaves npm test fully green while every
button is dead.

Clicks are addressed BY LABEL and the renderer is asked where the button is, because
it is the only place that knows the scale and offset it last painted with. A
coordinate list here would be a second copy of the layout that passed while the
layout was wrong.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 14: Goldens — the keypad in pixels, in both front ends

> **AS BUILT (`8dd0bae`, `ae225fe`). BOTH SCREENSHOT HARNESSES COULD PASS ON STALE FILES, AND ONE OF
> THEM DID — THAT IS THIS TASK'S REAL FINDING.**
>
> 1. **`shot.mjs` SCORED `3/3 goldens matched` AND EXIT 0 WITH A CLIENT THAT COULD NOT START.**
>    `/tmp/tn3270-shot-<case>.png` is a **stable path across runs** and the pass condition asks only
>    whether a capture EXISTS — so a run that captured nothing compared **the file the last run left
>    there**. Measured by pointing `main` at a nonexistent script: Electron exits in 0.24s with
>    "Cannot find module" and writes nothing, and the harness said 3/3. With two `rmSync` calls it says
>    `0/3` and three `no capture produced` lines. **Found while adding the keypad case, whose stale
>    file would have been the CORRECT keypad image** — so this would have hidden a broken run of
>    exactly the harness this task extends. `browser-shot.mjs` had the same hole and got the same fix.
> 2. **`process.exit` DOES NOT RUN `finally` — measured.** Every bail inside `browser-shot.mjs`'s `try`
>    therefore orphaned a **listening gateway with a replayed session open**, which is precisely what
>    that `finally` says it prevents. Per-case failures now count and return, and the only exits left
>    are before the server exists and after the teardown. **`browser-keys.mjs` has the same shape and
>    was deliberately left alone here** — one line, whenever someone is next in that file.
> 3. **`Ctrl+K` IS PART OF THE CASE, NOT OF THE HARNESS, and the plan was right to insist.** Nothing
>    else can show a keypad — no flag, no URL, no setting, deliberately — so without that chord this
>    golden would have been a byte-identical **duplicate** of `synthetic-ispf` and would have passed
>    while checking nothing new. **MEASURED by deleting the line: hash `0e327b1504bc`, i.e. exactly the
>    first case's golden.** Transposing the keys onto the first case reddens both, with the two hashes
>    exchanged. `TN3270_GUI_KEYS: kase.keys ?? ''` keeps the default EMPTY, so the protection against a
>    stray value in the operator's shell still covers every case that does not ask;
>    `shot-flags.test.ts` pins both halves, because `npm test` cannot run this harness and the failure
>    it would otherwise hide is a **silent re-baseline to a keypad-less screen on the next `--update`**.
> 4. **THE IMAGE WAS READ, NOT MERELY GENERATED — a golden cannot validate the baseline it came from.**
>    Decoded independently (PNG filters 1, 2 and 4 in these rows) and transcribed cell by cell against
>    the baked atlas: **PF13-24 on the top row and PF1-12 below**, which is c3270's order
>    (`Common/c3270/keypad.labels:2` and `:4`); all labels inside their own key's six cells with the
>    rest of each key blank; no inked cell below the OIA that is not part of a label; the cluster gaps
>    at key slots 3, 7 and 9; and **the first 350 rows pixel-identical to `synthetic-ispf`**, so
>    showing the keypad moves nothing above it. Regenerated and read again when `a039287` added
>    `NewLn`.
>
> Step 4's browser case is the assertion that matters and it passes: **2/2, byte-identical**, the
> viewport sized from each golden's own IHDR so the taller keypad case sizes itself.
>
> **THE STYLING IS AN OPEN USER DECISION and it touches exactly one golden.** The user is choosing
> between this atlas look and inverse video on a spaced grid, having rejected a proportional font
> (measured: Helvetica's capital `I` is a bare stem, so `ErInp` reads "Erlnp"). A restyle changes only
> `canvas/src/keypad.ts` and regenerates `synthetic-ispf-keypad` — the table, the rectangles and every
> hit test are independent of how a button is drawn. **Look at the regenerated image, per item 4.**

**Files:**
- Modify: `packages/gui/scripts/shot.mjs` (a third case)
- Modify: `packages/gui/test/shot-flags.test.ts` if it counts the cases
- Modify: `packages/web/scripts/browser-shot.mjs` (a second case)
- Create: `packages/gui/test/golden/synthetic-ispf-keypad.png` and `.sha256`

- [ ] **Step 1: Add the GUI case**

In `shot.mjs`'s `CASES`:

```js
  {
    name: 'synthetic-ispf-keypad',
    trace: join(repo, 'packages', 'fixtures', 'traces', 'synthetic-ispf-like.trace'),
    host: '127.0.0.1:1',
    // Ctrl+K SHOWS the keypad. Without it this would be a duplicate of the first case, and it
    // would pass -- a golden that silently checks nothing new is worse than no golden.
    keys: 'Ctrl+K',
  },
```

`run()` currently sets `TN3270_GUI_KEYS: ''` deliberately, so that a stray value in the caller's
shell cannot type into the goldens. **Keep that protection**: pass `kase.keys ?? ''`, so the default
is still empty and only a case that asks for keys gets them.

- [ ] **Step 2: Generate and inspect**

```bash
cd ~/git/tn3270 && npm run build && node packages/gui/scripts/shot.mjs --update
```
Then look at `packages/gui/test/golden/synthetic-ispf-keypad.png` and confirm it is a 24-row screen,
an OIA row, and a legible keypad. **Do not commit a golden you have not looked at** — a golden of a
blank or clipped keypad would lock in the bug.

**A GOLDEN CANNOT VALIDATE THE BASELINE IT WAS GENERATED FROM. Read these off the image, deliberately,
before committing it** — an error already in the table gets baked into the PNG and its `.sha256`, and
then nothing ever catches it:
- **the PF row order** — PF13-24 on top, PF1-12 below. Task 3 measured that inverting the two blocks
  leaves all nine table tests green, so this image is the only check on it;
- that no two labels overlap or run together, and that the cluster gaps are where the spec draws them;
- **that each label sits over the key it names.** A LABEL/ACTION MISMATCH IS INVISIBLE HERE — swapping
  `Del`'s and `BkSp`'s actions changes no pixel at all — so this image cannot help with that one, and
  Task 13's click-by-label cases are its only cover, for 8 of 46 keys.

- [ ] **Step 3: Confirm it reproduces**

```bash
cd ~/git/tn3270 && node packages/gui/scripts/shot.mjs
```
Expected: `3/3 goldens matched`. Run it twice: a golden that differs between two consecutive runs
means something non-deterministic got in, and the settle time or a blink attribute is the first
suspect.

- [ ] **Step 4: Add the browser case**

Extend `browser-shot.mjs` to take a case list of `{ golden, keys }` and run both:
the existing `synthetic-ispf` with no keys, and `synthetic-ispf-keypad` with `TN3270_GUI_KEYS`
set to `Ctrl+K`. The size still comes from each golden's own PNG header, so the taller keypad case
sizes itself. Expected: both pixel-identical.

**This is the assertion that matters most in this task.** It says the keypad the browser draws is
the same keypad Electron draws, which is what makes one implementation two front ends rather than
two implementations that agree today.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/gui/scripts/shot.mjs packages/gui/test/golden packages/web/scripts/browser-shot.mjs packages/gui/test/shot-flags.test.ts
git commit -m "test: golden the keypad, in Electron and in the browser

A third GUI golden with the keypad shown, and a second browser-shot case proving
the served page draws it identically -- which is what makes this one
implementation serving two front ends rather than two that happen to agree.

shot.mjs keeps clearing TN3270_GUI_KEYS by default, so only a case that asks for
keys gets them and a stray value in the caller's shell still cannot type into a
golden.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 15: Documentation, whole-branch verification, merge

- [ ] **Step 1: Update the docs**

> **AS BUILT (Task 15). THE WHOLE GATE PASSES ON THE BRANCH HEAD AND THE TEST COUNT RECONCILES
> EXACTLY — which, after two branches where it did not, is itself the result. NOT MERGED: the user
> has not authorised it.**
>
> **Gate, verbatim:** build and typecheck clean; **1643 tests in 71 files**;
> `3/3 goldens matched`; `ok       18 chords, 16 actions in order`;
> `ok       9 buttons, 10 actions in order (toggleKeypad + 9)`;
> `ok       13 chords, 11 actions in order, over a WebSocket`;
> `2/2 cases matched the GUI's own goldens`; `pty-smoke.py` 12 PASS / 0 FAIL.
>
> **THE RECONCILIATION, and it closes to zero.** 1643 − 1514 = **+129**, and the per-file sum is
> exactly 129: five NEW files contribute 71 (`canvas/keypad` 28, `frontend/keypad` 11,
> `gui/clicks-harness-flags` 16, `tui/keypadOverlay` 12, `canvas/module-cycles` 4) and ten modified
> files contribute 58 (`tui/app` +16, `core/keyboard` +11, `cli/runner` +7, `canvas/keys` +6,
> `canvas/drawlist` +5, `frontend/actions` +4, `web/integration` +4, `frontend/keymap` +3,
> `canvas/renderer-imports` +1, `gui/shot-flags` +1). Three modified files contribute **zero**
> (`canvas/blit`, `frontend/bindings`, `web/httpstatic`) — each was edited for a citation or a
> retargeted import, not for coverage, which is the honest reason a diff can touch a test file
> without changing the count.
>
> **THE ONE TRAP IN COUNTING THIS: `tui/test/app.test.ts` reports 61 tests from 56 `it(` lines**,
> because `it.each(paths)` expands one line into six over the six teardown paths. The static count is
> a valid oracle for every other file in the repo — verified file by file against vitest's own JSON
> reporter — and for this one only if you remember the multiplier. It is unchanged on both sides, so
> the delta is right either way; a reconciliation that used vitest's number on one side and `grep -c`
> on the other would have shown a phantom gap of 5 and sent someone looking for a defect.
>
> **Step 3a WAS NOT DONE — see its own note below. It is the one part of this task left open.**

- `README.md`: add the keypad and the **four** keys to *What works today* (Newline arrived after this
  step was written); move the keypad OUT of
  *Remaining* in *Staging* (it is item 9 there) and into the done list; update the test count and
  the *Verification* table with the new goldens and `clicks.mjs`; add Dup/Field Mark/Sys Req/Newline
  to the
  key documentation for the TUI and GUI sections. **Remove "no mouse support" for the canvas front
  ends only where it is now false** — the mouse does keypad buttons and nothing else, so say that
  precisely rather than deleting the caveat.

  **AS BUILT: the claim appeared in FOUR places, not one, and only three were false.** The intro
  (`:24`), *Using the GUI* (`:177`) and both bullets in *What is not implemented* (`:649`, `:654`)
  all had to change; **`No mouse support in the TUI` (`:672`) is STILL TRUE** and was kept, with a
  line added saying the `Ctrl-K` list is the keyboard substitute rather than a step towards a mouse.
  The `**Commands.**` list needed `Dup`, `FieldMark` and `SysReq`; **`Newline` was already there**,
  the CLI having had it since stage 1 — which is the whole reason it was worth adding a button for.
  **Three STALE CLAIMS UNRELATED TO THIS BRANCH were found while editing and fixed**, all the same
  shape as the citations: the *Verification* table said the GUI goldens were "1 case" when they had
  been two since the palette work; an *In flight, not on `main`* paragraph still described
  `alternate-screen-size` as pushed-but-unmerged, which stopped being true on 2026-08-27; and two
  places said `renderer.ts` "differs by two lines" from its pre-gateway version, which this branch
  itself made false.
- `packages/web/README.md`: the keypad, its toggle, and that a click is an ordinary action so
  nothing about the protocol changed.
- `docs/HANDOFF.md`: rewrite *Where things stand*.

  **AS BUILT: every harness baseline figure in it was stale, and one was stale in a way that would
  mislead.** `HANDOFF.md:115` described `browser-shot.mjs` as comparing "served pixels against the
  GUI golden", **singular**, when it now runs two cases — and the second is the one that carries the
  keypad claim. The by-hand harness block is now **five harnesses with their current figures**, the
  tree section quotes the branch's numbers and `main`'s **separately and says which is which** (they
  are one feature apart, and conflating them is how a wrong number gets copied), and the `keys.mjs`
  15-chords/13-actions paragraph is marked as the measurement taken when that guard was built rather
  than as current. The `main.ts:290` citation became a NAME.
- `docs/live-testing.md`: **only if you ran against a host.** This feature needs no live
  verification — a keypad press produces the same bytes as the keystroke, and those are already
  live-verified — but if you did drive it against VM or MVS, record what you saw. Sys Req, Dup and
  Field Mark have **no live witness**; say so rather than letting the keypad's verification read as
  covering them.

  **AS BUILT: NO HOST WAS DRIVEN, and the section was written anyway — because the absence needed to
  be on the record rather than inferred from silence.** A new *The virtual keypad and the four new
  keys — NO LIVE RUN* section states the argument for not running one and, more importantly, **where
  that argument stops**: a per-key table showing all four with no live witness, why **Sys Req cannot
  obtain one here** (neither host offers TN3270E, and the non-E TEST REQUEST path is unimplemented),
  and a four-item list of what to run on the first real host that appears — through the keypad
  button, not the CLI, since the CLI path is the one already covered offline.

- [ ] **Step 2: Commit the docs**

```bash
cd ~/git/tn3270
git add README.md packages/web/README.md docs/HANDOFF.md docs/live-testing.md
git commit -m "docs: the virtual keypad, the special-keys overlay, and four new keys

Moves the keypad out of Staging's Remaining list, states the mouse's scope
precisely rather than deleting the no-mouse caveat -- it does keypad buttons and
nothing else -- and records that Sys Req, Dup, Field Mark and Newline have no live
witness.

Generated with AI

Co-Authored-By: SLAC AI"
```

- [ ] **Step 3: The whole gate**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -5
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
node packages/gui/scripts/clicks.mjs
node packages/web/scripts/browser-keys.mjs
node packages/web/scripts/browser-shot.mjs
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
```

Expected: build and typecheck clean; all tests green; `3/3 goldens matched`;
~~`ok 15 chords, 13 actions in order`~~ **`ok 18 chords, 16 actions in order`** (Task 4 added three);
~~`ok 8 buttons, 8 actions in order`~~ **`ok 9 buttons, 10 actions in order (toggleKeypad + 9)`**
(the seam cannot imply the keypad, so the toggle is an action too — Task 13's finding — and `NewLn`
is a ninth case);
~~`ok 12 chords, 10 actions in order, over a WebSocket`~~ **`ok 13 chords, 11 actions in order, over
a WebSocket`** (Task 4 added `Ctrl+K`, the only observable for that chord over the gateway path);
both browser-shot cases identical (**`2/2 cases matched the GUI's own goldens`**);
`pty-smoke.py` 12/12. **ALL MEASURED on the branch head; see the AS BUILT note at the top of this
task.**

**Reconcile the test count rather than editing a number into the docs.** Add up the new tests per
file and check the total against what vitest reports. If they disagree, find out why — the last two
branches both had a real finding hiding in that gap.

- [ ] **Step 3a: `applyAction`'s dispatch table is 59% unfalsifiable — MEASURED, and it is this
      branch's outstanding debt**

> **AS BUILT: NOT DONE. STILL OPEN, AND STILL THE RIGHT THING TO DO.** Task 15's execution brief
> scoped the task to the docs, the gate, the citation sweep, the whole-diff read and this plan's
> annotations, and did not carry this step — so it was neither done nor silently dropped, and it is
> recorded here rather than left to be rediscovered. **Confirmed still open by reading
> `frontend/test/actions.test.ts` at the branch head:** it has 14 tests, and the new ones cover
> `sysreq`, `dup`/`fieldMark` (each spied before the other key is pressed, per Task 2's finding),
> `newline` against the moves it sits beside, and the `toggleKeypad` refusal. **There is no
> data-driven table covering the thirteen, so `left`↔`right`, `tab`↔`backTab`,
> `eraseEOF`↔`eraseInput`, `backspace`↔`deleteChar`, `home`→`reset` and `clear`→`AID.ENTER` remain
> transposable with the suite fully green — now at 1643 rather than 1529.** A reviewer should treat
> this as the one thing worth doing before or immediately after the merge; it is a single test file
> and it touches no production code.

Found by Task 2's quality review, pre-existing, and left alone deliberately so that commit stayed
reviewable. **13 of `applyAction`'s 22 cases have no test asserting their target.** All thirteen were
transposed AT ONCE — `left`↔`right`, `tab`↔`backTab`, `eraseEOF`↔`eraseInput`, `backspace`↔`deleteChar`,
`home`→`reset`, `clear`→`AID.ENTER` — and the suite stayed **fully green at 1529 in 66 files**. Nothing
in the repo, including the TUI and GUI suites, notices that Left moves right, Tab back-tabs and Ctrl-C
sends Enter.

Close it with one data-driven test in `packages/frontend/test/actions.test.ts`: a table of
`[Action, keyof Keyboard]` rows, each row getting its own `newSession()`, spying the expected method
**plus at least its transposition partner**, and asserting before the next row runs. The per-row
isolation is the part that matters — it is exactly what the `dup`/`fieldMark` test got wrong.

**Do not skip this on the grounds that it is pre-existing.** The branch has now been bitten three times
by tests that were not falsifiable, and this table is where the remaining instances live.

- [ ] **Step 3b: Re-check EVERY cross-file line citation on the branch**

**Editing a file that other files cite by line is itself a change to those files**, and this branch has
proved it: Task 6 inserted 36 lines into `drawlist.ts` and silently invalidated three citations in
`keypad.ts` (`105-106` → `124-125`, `60-68` → `65-73`, `146-147` → `176-177`), all of which had been
correct against the parent commit. **Nine other citations were corrected during the branch**, so this is
the dominant recurring defect in a codebase whose house style is to cite by file and line.

Walk every `file.ts:NN` reference added or touched by this branch and confirm it still points at what the
prose says. Prefer citing by **name** (`advanceAfterType`, whose own line moved from `:98` to `:250` on
this branch and whose old number now lands inside `dup()`'s docstring) for anything inside a file that
keeps moving — one citation was already converted for exactly that reason.

> **AS BUILT (Task 15). 38 citations were corrected across the branch before this step, and the sweep
> found SEVEN more, all in `docs/`: `gui/src/main.ts:290` in `HANDOFF.md:61`, in this spec's
> architecture section and in this plan's Task-13 note (the line had moved twice, to `:294` then
> `:312`); `gui/src/main.ts:339` and `web/src/main.ts:134`/`:186` and `tui/src/app.ts:497` in this
> plan's reordering section; `cli/src/runner.ts:219` and `keyboard.ts:98` in the spec; and
> `drawlist.test.ts:11` in this plan and in `canvas/test/keypad.test.ts`. **FOUR were converted to
> NAMES** — `fit()`/`setContentSize`, `advanceAfterType`, `Keyboard.newline` and `drawlist.test.ts`'s
> `atlas` const — because each sits in a file this branch kept editing. **EVERY in-source citation
> added by the branch checked out**, except that one `drawlist.test.ts:11`: the per-commit retargeting
> discipline (`7e58425`, `086dbbe`, `7eb6334`, `24c36ae`, `8585c71` each retarget their own inbound
> citations) held, and the residue was entirely in the two documents nobody was editing per-commit.
> **THE RULE THAT FALLS OUT: a doc that describes code is as much a citation site as the code is, and
> it is the one with no commit to remind you.**

- [ ] **Step 4: Read the whole diff**

> **AS BUILT: DONE, 54 files, +4808 / -171. NOTHING HAD TO BE FIXED — which is worth stating with the
> evidence rather than as a shrug, because every item on this checklist exists because it happened
> once.**
>
> - **No mutation left behind.** `renderer.ts` has its real `if (e.button !== 0) return;` guard and no
>   bare `return`; `keys.ts`'s `CTRL` table has all eight entries; `keyboard.ts`'s `writeControl` and
>   `drawlist.ts`'s `showKeypad` path are intact. Each is the mutation its own task used, so a
>   forgotten restore would have been invisible to `npm test` in three of the four cases.
> - **No `console.log`, no `debugger`, no `TODO`/`FIXME` added anywhere under `packages/*/src`.** The
>   harnesses use `process.stdout.write`, deliberately — see `quitIfKeysOnly` on why a write to a pipe
>   plus an immediate exit once lost the last line.
> - **The click seam IS reachable without `--replay`, and that is CORRECT and consistent.**
>   `maybeSendClicks` is called from both the replay branch and the connected path, exactly as
>   `maybeSendKeys` is; what is gated on replay is the **action LOG**
>   (`logActions = SEAM.keys !== '' && SEAM.replay !== ''`), which is where the privacy control
>   belongs, because a logged `type` action carries the text typed. Gating the seam itself would be a
>   different and weaker rule. It is **not** called from the URL branch, which is documented on the
>   function: in that mode the served page owns the input path.
> - **The two hardcoded numbers in `keypadRegion` are deliberate and documented.** `width: 12 *
>   KEYPAD_KEY_WIDTH * atlas.cellWidth` is written down **rather than measured from the table on
>   purpose**, so a key placed past the right edge fails a test instead of silently widening the
>   window — the same reasoning as Tasks 5 and 6's "pin a declared size against what occupies it". The
>   5-character label limit lives in the table's own doc comment and in a test, not in the layout. The
>   TUI's `NAME_WIDTH` is computed from the table.
> - **No cell coordinates leaked into a pixel file.** `canvas/src/keypad.ts` emits scale-1 pixels
>   only, and takes `key.row`/`key.col` in cells at exactly one place each (`DRAWN_ROW[key.row]` and
>   `key.col * atlas.cellWidth`). `render.ts`'s `overlayParts` uses 1-based terminal rows, which is
>   that file's own convention throughout.
>
> **The two things worth a reviewer's eye, neither a defect:** `__tn3270ButtonCentre` is installed on
> `window` unconditionally rather than behind the seam env var, so it exists in a shipped renderer —
> it returns coordinates only, reaches no `Session` and fires no action, and being a `window` global
> rather than a fifth bridge function is what keeps the renderer shared. And `keypadRegion`'s
> `RangeError` for an undeclared `row` is reachable only from a bad table edit, which is a build-time
> mistake, not a runtime one.

Run: `cd ~/git/tn3270 && git diff main...HEAD`

Look for: a mutation left behind in `renderer.ts`, `keys.ts` or `keyboard.ts`; a stray
`console.log`; the click seam reachable without `--replay`; a hardcoded label width or key count
that should have come from the table; and any place a coordinate is in cells where the rest of the
file uses scale-1 pixels.

- [ ] **Step 5: Ask about the font**

> **AS BUILT: ASKED AND STILL OPEN — the user is choosing between the current x3270-atlas look and
> INVERSE VIDEO ON A SPACED GRID, having already REJECTED a proportional font.** That rejection was
> measured rather than argued, and both measurements are worth keeping: **Helvetica's capital `I` is a
> bare stem, so `ErInp` renders as "Erlnp"** — an abbreviation that becomes a different word is worse
> than an ugly one — and **Inter Light puts 0.4% of its ink pixels at full white against the screen's
> 100%**, so the labels read as greyed-out/disabled beside live host data. `fillText` was never
> reached as an option, which is the outcome the spec's ranking wanted.
>
> **NOTHING WAS RESTYLED**, deliberately: the decision is the user's, and Task 15 documented the code
> as it stands. **A later restyle is cheap and its blast radius is exactly one golden**
> (`synthetic-ispf-keypad`) plus `canvas/src/keypad.ts` — the key table, the button rectangles and
> every hit test are independent of how a button is drawn, which is the property the spec's ranking
> was chosen to preserve. **Look at the regenerated image**, per Task 14's item 4: a golden cannot
> validate the baseline it came from.

The spec records that the x3270 font for keypad labels is **provisional** and the user agreed to try
it and see. By now there are three PNGs of it. **Ask the user to look and decide**, and quote the
spec's ranked fallbacks: restyle within the atlas first (borders and inverse video are available,
431 glyph columns and 137 CG line-drawing glyphs), a second baked bitmap font second, and `fillText`
not at all without deliberately demoting the goldens in writing.

- [ ] **Step 6: Merge, after the user says so**

> **AS BUILT: NOT DONE. THE USER HAS NOT AUTHORISED THE MERGE**, and Task 15 stopped after
> verification and reporting. The branch sits on `main` at `7ca0269`, the tree is clean, and nothing
> was pushed, no
> branch created or deleted, and no existing commit amended. When the go-ahead comes, **re-run the
> whole gate on the merge commit itself** — that is what the last three merges did, and `git checkout`
> reddens the build-staleness guard, so clear it with
> `npx tsc --build --force packages/canvas packages/gui` rather than with `npm run build`.

Do not merge unasked. When told:

```bash
cd ~/git/tn3270
git checkout main
git merge --no-ff <branch> -F /tmp/merge-msg.txt   # -F -, reading from stdin, is NOT supported
git push origin main
git branch -d <branch>
```

Re-run the whole gate **on the merge commit** before pushing, not only on the branch.

---

## Self-review

**Spec coverage**, section by section:

| spec item | task |
| --- | --- |
| Clickable keypad in both canvas front ends | 5, 6, 7, 8, 9 |
| Keyboard-navigable TUI overlay | 11, 12 |
| Sys Req reachable at last | 2 (action), 3 (button), 10 (CLI), 12 (overlay) |
| Dup and Field Mark, 0x1c/0x1e, typed not AID | 1 |
| Dup suppresses auto-skip | 1, step 6 mutation |
| Key table in `frontend`, layout in `canvas` | 3, 5 |
| Keypad as a third `DrawList` region, below the OIA | 6 |
| Hit-testing in the renderer, local press highlight | 7 |
| `Ctrl-K` and `Alt-K`; `Ctrl-D`/`Ctrl-F` from c3270; no Sys Req chord | 4 |
| `toggleKeypad` handled, not silently dropped | 2 (throws), 8, 9, 12 |
| Drawing grows; window resizes; browser scrolls | 6, 8 |
| Overlay refuses in a too-small terminal | 11, 12 |
| Click-to-action proven with real mouse events | 13 |
| Pixel-identical between Electron and browser | 14 |
| Font choice revisited after looking at it | 8 step 4, 15 step 4 |
| CLI `Dup()`/`FieldMark()`/`SysReq()` | 10 |

**Gaps found and closed while reviewing:** the spec's success criterion 5 asks the overlay to list
every special key, but Task 11 returns all 46 lines while the overlay window is 12 rows — Task 12
step 4 now names the scrolling decision explicitly and requires it to be reported rather than
quietly capped, because a silent cap makes keys past line 12 unreachable.

**Type consistency:** `KeypadKey` (Task 3) is `{label, action, row, col, name}`, used by Task 5's
`keypadRegion` and Tasks 11's `overlayLines`. `KeypadButton` (Task 5) is `{x, y, w, h, action,
label}`, produced by `keypadRegion`, consumed by `hitTest` (Task 5), `renderer.ts` (Task 7) and
`__tn3270ButtonCentre` (Task 13). `KeypadRegion` is `{y, width, height, cells, buttons}`, produced
by Task 5 and carried by `DrawList.keypad` in Task 6. `drawList`'s sixth parameter is
`showKeypad = false` in Task 6 and is passed by that name in Tasks 8 and 9.

**Names this plan is guessing at, flagged in place:** `column()`'s visibility in `drawlist.ts`
(Task 5), `fit()`'s cache key (Task 8), the runner test's helpers (Task 10),
`terminalGeometry()`/`showMessage()` in `app.ts` (Task 12), and `render.ts`'s escape-sequence
helpers (Task 12). Each step says to read the source and report the real name.
