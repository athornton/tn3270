# Keyboard semantics (15a part 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the keyboard behave as x3270's does under a lock (typeahead queue, oerrLock), and fix
insert mode, the erase keys, numericLock and Attn — in core, so every front end gets it.

**Architecture:** A new `Session.run(action)` in `packages/core` is the only route for operator
actions; it drops, queues, clears-then-acts or acts, following x3270's `enq_xta` and
`OERR_CLEAR_OR_ENQ`. The queue drains after each host write. `Keyboard`'s methods stay the
immediate operations; `applyAction` (GUI, browser, TUI) and the CLI runner call `run`.

**Tech Stack:** TypeScript, vitest, npm workspaces. Build `npm run build`, typecheck
`npm run typecheck`, test `npx vitest run` (from the repo root — never from another cwd).

**Spec:** `docs/superpowers/specs/2026-11-18-keyboard-semantics-design.md`. Read it first.

---

## Rules for every task (read before Task 1)

- **The source beats this plan.** The code blocks below are drafts written against the tree at
  `39e110b`. Re-read the file you are editing before each step (`keyboard.ts`, `session.ts`,
  `oia.ts`, `actions.ts`, `runner.ts` are all heavily commented; the answer to a question is often
  in a comment above the line). Where x3270 is cited, read `~/src/suite3270-4.5` (read it as
  text only: never build it, never `cd` into it to run anything). If the source and this plan
  disagree, follow the source and say so in your report.
- **TDD:** write the failing test, watch it fail for the right reason, implement, watch it pass.
- **Existing tests that change:** when a task's behaviour change makes an existing test fail, do
  not weaken it silently. List every such test in your report with the spec line that justifies
  the new expectation, and rewrite it to assert the new behaviour.
- **Before reporting done:** `npm run build && npm run typecheck && npx vitest run` all clean
  (vitest does not typecheck). Report the test count.
- **Comments:** this codebase cites x3270 by file and function/line in its comments; follow that
  style for new rules, briefly.
- Commit after each task with a message in the repo's style (`core: ...`, `cli: ...`), ending
  with:

  ```
  Generated with AI

  Co-Authored-By: SLAC AI
  ```

## File map

- `packages/core/src/keyAction.ts` (new): the `KeyAction` union and the classification sets
  (`OERR_CLEARS`). One responsibility: what an operator action is.
- `packages/core/src/session.ts`: `run`, the queue, the drain, Reset's half reset, insert off on
  AID/restore, `transferring`, Attn.
- `packages/core/src/keyboard.ts`: `erase`, unformatted `deleteChar`/`eraseEOF`, insert room,
  `numericLock`, removing `type`'s operator-error exception.
- `packages/core/src/oia.ts`: `typeahead` flag and its `T`.
- `packages/core/src/telnet.ts`: `sendInterrupt` (IAC IP).
- `packages/core/src/index.ts`: export `KeyAction`.
- `packages/frontend/src/keymap.ts`, `actions.ts`, `keypad.ts`: reuse `KeyAction`, route through
  `run`, keypad Ins sets insert on.
- `packages/frontend/src/transferRun.ts`, `packages/cli/src/runner.ts`: set `transferring`.
- `packages/cli/src/runner.ts`: route through `run`; `BackSpace()`, `Erase()`, `Insert()`,
  `ToggleInsert()`.
- Tests beside each: `packages/core/test/keyboard.test.ts`, `packages/core/test/session.test.ts`
  (or a new `packages/core/test/typeahead.test.ts` for Tasks 2-4, using the same `FakeConnection`
  pattern as `session.test.ts` — copy it, do not export it from the existing test file),
  `packages/frontend/test/actions.test.ts`, `packages/cli/test/*`.

---

### Task 1: `KeyAction`, `Session.run` (unlocked path) and the `T` indicator

**Files:** create `packages/core/src/keyAction.ts`; modify `session.ts`, `oia.ts`, `index.ts`;
test `packages/core/test/typeahead.test.ts`.

- [ ] **Step 1: the type.** `keyAction.ts`:

```ts
/**
 * An OPERATOR action: what a key, a keypad button or a script action asks the keyboard to do.
 * `Session.run` is the only route by which one reaches the screen or the host, because that is
 * where x3270's lock rules live (Common/kybd.c, enq_xta and OERR_CLEAR_OR_ENQ).
 */
export type KeyAction =
  | { kind: 'type'; text: string }
  | { kind: 'enter' } | { kind: 'clear' }
  | { kind: 'pf'; n: number } | { kind: 'pa'; n: number }
  | { kind: 'reset' }
  | { kind: 'up' } | { kind: 'down' } | { kind: 'left' } | { kind: 'right' }
  | { kind: 'home' } | { kind: 'tab' } | { kind: 'backTab' } | { kind: 'newline' }
  | { kind: 'backspace' } | { kind: 'delete' } | { kind: 'eraseEOF' } | { kind: 'eraseInput' }
  | { kind: 'dup' } | { kind: 'fieldMark' }
  | { kind: 'insert' } | { kind: 'toggleInsert' }
  | { kind: 'attn' } | { kind: 'sysreq' };

/** What `run` did with an action. The CLI turns `dropped`/`refused` into its errors. */
export type RunResult = 'done' | 'queued' | 'dropped' | 'refused';

/**
 * The actions x3270 wraps in OERR_CLEAR_OR_ENQ (kybd.c:146): under an operator error ONLY, they
 * clear it and then act. Every other action is dropped with the alarm (enq_xta, kybd.c:285).
 * x3270's DeleteField, DeleteWord, FieldEnd and PreviousWord are also in that set; we have none.
 */
export const OERR_CLEARS: ReadonlySet<KeyAction['kind']> = new Set([
  'tab', 'backTab', 'home', 'up', 'down', 'left', 'right', 'eraseEOF', 'eraseInput',
]);
```

  Check `frontend/src/keymap.ts`'s `Action`: its `type`, `pf`, `pa` members must have exactly these
  field names (`text`, `n`). If they differ, use the existing names here.

- [ ] **Step 2: failing tests** (`typeahead.test.ts`): on an unlocked, connected, formatted screen,
  `run({kind:'type',text:'AB'})` returns `'done'` and the cells hold A, B; `run({kind:'tab'})`
  moves the cursor; `run({kind:'enter'})` puts an AID on the wire; on a session that is not
  connected, `run({kind:'type',...})` returns `'dropped'` and changes nothing. `oia.typeahead =
  true` makes `oia.toText()` contain a standalone `T` part; false omits it.

- [ ] **Step 3: implement.** `Oia`: `typeahead = false;` and in `toText()` push `'T'` after the
  keyboard-state part when it is true (re-read the width-budget comment in `toText` and check
  the worst case still fits 80; `session.test.ts` asserts that bound). `Session`:

```ts
  run(action: KeyAction): RunResult {
    if (!this.isConnected()) return 'dropped';
    return this.perform(action);
  }

  /** The immediate operation, no lock rules: Keyboard's methods and the AID senders. */
  private perform(action: KeyAction): RunResult {
    const k = this.keyboard;
    switch (action.kind) {
      case 'type': return k.typeString(action.text) ? 'done' : 'refused';
      case 'enter': this.sendAID(AID.ENTER); return 'done';
      case 'clear': this.sendAID(AID.CLEAR); return 'done';
      case 'pf': this.sendAID(pfAID(action.n)); return 'done';
      case 'pa': this.sendAID(paAID(action.n)); return 'done';
      case 'reset': k.reset(); return 'done';
      case 'up': k.up(); return 'done';
      // ... every other kind, mapping to the Keyboard method applyAction uses today
      case 'dup': return k.dup() ? 'done' : 'refused';
      case 'fieldMark': return k.fieldMark() ? 'done' : 'refused';
      case 'insert': k.setInsertMode(true); return 'done';
      case 'toggleInsert': k.setInsertMode(!k.insertMode); return 'done';
      case 'attn': this.sendAttn(); return 'done';
      case 'sysreq': this.sysreq(); return 'done';
      default: return action satisfies never;
    }
  }
```

  `pfAID`/`paAID` throw on a bad `n` — let it throw (the callers already catch or report it).
  Export `KeyAction`, `RunResult`, `OERR_CLEARS` from `index.ts`.

- [ ] **Step 4:** tests pass; full gate; commit `core: Session.run, the one route for operator actions`.

### Task 2: the typeahead queue under a host lock, and its drain

**Files:** `session.ts`; test `typeahead.test.ts`.

- [ ] **Step 1: failing tests.**
  - After `run({kind:'enter'})` (keyboard now `SystemWait`), `run({kind:'type',text:'X'})` returns
    `'queued'`, the screen is unchanged and `oia.typeahead` is true.
  - A host write with WCC keyboard-restore then runs it: `X` is in the field, `typeahead` false,
    and one `'screen'` event follows the drained action (assert the screen text after the write).
  - Queued `type X`, `enter`, `type Y`: the restore runs `X` and the Enter (an AID goes on the
    wire containing X); `Y` is still queued and `typeahead` still true; a second restore runs `Y`.
  - Queued under `AwaitingFirstWrite` (connect, negotiate, no write yet): the first write drains.
  - Queued under `EnterInhibit` and `MinusFunction` (both non-OERR in x3270, so they queue).
  - Disconnect (`conn.close()`) empties the queue and clears `typeahead`; a later restore on a new
    connection runs nothing.
  - `session.transferring = true` with a host lock: `run` returns `'dropped'`, emits `'alarm'`,
    queues nothing.

- [ ] **Step 2: implement.**

```ts
  /** x3270's ta_head/ta_tail (kybd.c:270). Owned by the connection: emptied in handleClose. */
  private readonly typeahead: KeyAction[] = [];

  /**
   * Set by a transfer driver for the whole of a transfer (x3270's KL_FT): operator keys are
   * dropped with the alarm rather than queued to land on the host's READY screen afterwards.
   */
  transferring = false;

  run(action: KeyAction): RunResult {
    if (!this.isConnected()) return 'dropped';
    if (!this.oia.isInhibited()) return this.perform(action);
    // Task 3 adds the operator-error branch HERE, before the host-lock branch.
    if (this.transferring) { this.emit('alarm'); return 'dropped'; }
    this.typeahead.push(action);
    this.oia.typeahead = true;
    return 'queued';
  }

  /** x3270's `while (run_ta())` after a host write (ctlr.c:2654). */
  private drainTypeahead(): void {
    let ran = false;
    while (this.typeahead.length > 0 && !this.oia.isInhibited()) {
      const next = this.typeahead.shift()!;
      this.oia.typeahead = this.typeahead.length > 0;
      try { this.perform(next); } catch { /* as applyAction: a throwing key does nothing */ }
      ran = true;
    }
    if (ran) this.emit('screen');
  }
```

  Call `drainTypeahead()` in `handleRecord` straight after the `this.emit('screen')` that ends a
  3270 data record (re-read that method: there may be more than one record path — the SSCP-LU and
  NVT paths — and x3270 drains only after a 3270 write, `ctlr_write`; drain on 3270 writes only).
  In `handleClose`, empty the array and clear `oia.typeahead` with the rest of the per-connection
  state. `alarm` here is the same event `result.alarm` emits; check whether that path also sets
  `oia.alarm = true` and whether a dropped key should (x3270's `ring_bell` only rings — do not
  set the OIA flag unless the source says x3270 does).

- [ ] **Step 3:** pass; gate; commit `core: queue operator actions under a host lock, run them at unlock`.

### Task 3: operator-error lock (oerrLock)

**Files:** `session.ts`, `keyboard.ts`; tests `typeahead.test.ts`, `keyboard.test.ts`.

- [ ] **Step 1: failing tests.** Put the cursor in a protected field and `run` a `type`: the OIA
  is `X Protected`. Then:
  - each of `type`, `backspace`, `delete`, `newline`, `dup`, `fieldMark`, `enter`, `pf 1`,
    `attn`, `sysreq`, `insert`, `toggleInsert` returns `'dropped'`, emits `'alarm'`, changes
    no cell, puts nothing on the wire, leaves `X Protected` up;
  - each of `tab`, `backTab`, `home`, `up`, `down`, `left`, `right`, `eraseEOF`, `eraseInput`
    clears the error AND acts (e.g. `tab` from the protected field lands in the next unprotected
    field and the keyboard is unlocked);
  - `reset` clears it (already true; keep a test);
  - the same for `X Numeric` once Task 7 exists — write it for `Overflow` now (insert mode on, a
    full field, type: `X Overflow` — re-check how the overflow is raised).
  - In `keyboard.test.ts`: `Keyboard.type` straight after a refusal is now refused too (it is the
    immediate op; the lock rule moved to `run`). Find the existing tests that type after a
    refusal ("refuses a letter in a numeric field" then '5'; the auto-skip test) — they now need
    a `reset()` or a cursor move between, or must go through `run` with a clearing key. Report each.

- [ ] **Step 2: implement.** In `run`, before the host-lock branch:

```ts
    if (this.oia.isOperatorError()) {
      if (!OERR_CLEARS.has(action.kind)) { this.emit('alarm'); return 'dropped'; }
      this.oia.reset();       // KL_OERR_MASK cleared: re-read Oia.reset, it must not unlock a host lock
      return this.perform(action);
    }
```

  `MinusFunction` is NOT an operator error (x3270's `KL_OERR_MASK` is PROTECTED, NUMERIC,
  OVERFLOW, DBCS; `KL_OIA_MINUS` is separate) — confirm `isOperatorError()` excludes it.
  Our OIA holds ONE keyboard state, so x3270's "operator error under a host lock" (both bits)
  cannot arise here; say so in a comment rather than modelling it.
  In `Keyboard.type`, remove the `&& !this.oia.isOperatorError()` exception and rewrite its
  comment to say the operator-error rule now lives in `Session.run`.

- [ ] **Step 3:** pass; gate; commit `core: an operator error locks the keyboard until a cursor move or Reset (oerrLock)`.

### Task 4: Reset's half reset, and insert mode off on AID, Reset and restore

**Files:** `session.ts`, `keyboard.ts`; tests.

- [ ] **Step 1: failing tests.**
  - Queue two keys under SystemWait; `run({kind:'reset'})` empties the queue, clears `typeahead`,
    and LEAVES the keyboard `SystemWait` (half reset, `do_reset` kybd.c ~2019). A second Reset
    unlocks.
  - Reset with an empty queue: unlocks and sets insert mode off.
  - Insert on, `run({kind:'enter'})`: insert off. Insert on, host write with keyboard-restore:
    insert off. Insert on, a write WITHOUT restore: insert still on.
  - `run({kind:'insert'})` twice: still on. `toggleInsert` twice: off.

- [ ] **Step 2: implement.** In `run`, handle `reset` FIRST (before the lock tests — Reset is how
  you get out of a lock, so it is never queued or dropped by them):

```ts
    if (action.kind === 'reset') {
      if (this.typeahead.length > 0) {      // x3270's half reset: flush and stop
        this.typeahead.length = 0;
        this.oia.typeahead = false;
        return 'done';
      }
      this.keyboard.setInsertMode(false);   // alwaysInsert default (do_reset)
      this.keyboard.reset();
      return 'done';
    }
```

  Not-connected Reset: insert off, nothing else (do_reset's `!CONNECTED` arm) — so put the
  insert-off before the `isConnected` test for `reset` only. In `sendAID`, `setInsertMode(false)`
  (key_AID, kybd.c:920 — read it; it applies to every AID including internal callers). In
  `handleRecord`'s `keyboardRestore` branch, `setInsertMode(false)` (ctlr.c:2168-2170's
  `do_reset(false)`).

- [ ] **Step 3:** pass; gate; commit `core: Reset flushes typeahead first; insert mode ends on an AID, Reset and restore`.

### Task 5: room to insert

**Files:** `keyboard.ts` (`shiftRight` and the insert branch of `type`); `keyboard.test.ts`.

- [ ] **Step 1: failing tests** (x3270 `ins_prep`, kybd.c): a field holding `A B C NUL D E`
  with the cursor on A; typing X in insert mode gives `X A B C D E` (the cells from the cursor up
  to the first NUL shift right one, consuming that NUL; D and E do not move). Field with no NUL
  anywhere after the cursor: `X Overflow`, no change. A NUL
  BEFORE the cursor does not count. Unformatted screen: insert shifts to the first NUL before the
  end of the screen (ins_prep's `faddr == -1` arm); today the insert branch is skipped when
  `field === null` — fix that.
- [ ] **Step 2: implement** by reading `shiftRight` and `ins_prep`/the shift that follows it in
  kybd.c; scan from the cursor to the field's end (or screen end) for the first NUL, shift the
  cells from the cursor up to it right by one. Trailing blanks do NOT count (that is `blankFill`,
  off by default, a separate row).
- [ ] **Step 3:** pass; gate; commit `core: insert mode uses any NUL after the cursor, as x3270's ins_prep`.

### Task 6: the erase keys

**Files:** `keyboard.ts`; `keyboard.test.ts`.

- [ ] **Step 1: failing tests.**
  - `backspace` (x3270 `do_erase`, kybd.c): field `A B C D` with the cursor on C. The cursor
    moves left onto B, B is deleted and the rest of the field closes up: the field reads
    `A C D NUL`, the cursor is on C (B's old address), MDT set.
  - At the field's first cell: nothing changes.
  - In a protected field: `X Protected`. Read `do_erase`: `operator_error` is called WITHOUT
    `return`, so x3270 goes on to `do_left` and `do_delete` (which errors again). Mirror what the
    source does to the cursor and say in a comment what you found.
  - Unformatted screen: `backspace` and `delete` shift the rest of the SCREEN left
    (`do_delete`'s `!formatted` arm: end is the last cell of the buffer), NUL into the last cell.
  - `eraseEOF` unformatted: NUL from the cursor to the end of the screen, not wrapping
    (kybd.c:3034-3039: `while (baddr != 0)`).
  - `deleteChar` formatted keeps today's behaviour (existing tests).
- [ ] **Step 2: implement.** Rename nothing public: `backspace()` becomes the Erase operation
  (`left` then `deleteChar`'s close-up, as `do_erase` calls `do_delete`); `deleteChar` and
  `eraseEOF` get their unformatted arms (`s.fieldAt(...) === null` on a screen with no fields —
  check how `Screen` says "unformatted"; there may be an `isFormatted()` or `fields.length`).
- [ ] **Step 3:** pass (expect the existing "Backspace nulls the cell" tests to change — report
  them); gate; commit `core: Backspace is x3270's Erase; Delete and EraseEOF work unformatted`.

### Task 7: numericLock, off by default

**Files:** `keyboard.ts`; `keyboard.test.ts`.

- [ ] **Step 1: failing tests.** Default `Keyboard`: `A` typed in a numeric field goes in, no
  `X Numeric`. With `keyboard.numericLock = true`: refused with `X Numeric` as today. Add the
  Task 3 `X Numeric` drop test now (with `numericLock = true`).
- [ ] **Step 2: implement.** `numericLock = false;` property on `Keyboard`, documented as x3270's
  resource (x3270/resources.c:336-337, tested at kybd.c:1232; read that test — x3270 may still
  refuse some characters even with numericLock off, e.g. it only accepts digits, `.`, `-`, `,`,
  and DUP when ON; with it OFF check what, if anything, it does). Gate the `X Numeric` refusal on it.
- [ ] **Step 3:** pass (report the changed "refuses a letter in a numeric field" tests); gate;
  commit `core: numericLock off by default, as x3270`.

### Task 8: Attn on TN3270E

**Files:** `telnet.ts`, `session.ts`; tests `telnet.test.ts`, `tn3270e-session.test.ts`.

- [ ] **Step 1: failing tests.** In TN3270E mode, bound (follow how `tn3270e-session.test.ts`
  drives a BIND): `sendAttn()` writes `IAC IP` (0xff 0xf4). TN3270E, unbound: writes nothing,
  OIA `X -f` (`KeyboardState.MinusFunction`), Reset clears it. Classic: `IAC BREAK` as now.
- [ ] **Step 2: implement** `TelnetLayer.sendInterrupt()` (`IAC IP`, traced as `'Attn (IAC IP)'`)
  beside `sendAttn`; in `Session.sendAttn`, branch on `this.inTn3270e()` and `this.bound`
  (x3270 `Attn_action`, kybd.c:982-1002; `net_interrupt`, telnet.c). Check `T.IP` exists in the
  telnet constants; add it (0xf4, RFC 854) if not.
- [ ] **Step 3:** pass; gate; commit `core: Attn sends IAC IP on a TN3270E session, as x3270`.

### Task 9: the interactive front ends route through `run`

**Files:** `packages/frontend/src/keymap.ts`, `actions.ts`, `keypad.ts`; `actions.test.ts`,
`keypad` tests.

- [ ] **Step 1: failing tests.** `applyAction(session, {kind:'type',...})` on a host-locked session
  queues (the screen is unchanged and `session.oia.typeahead` is true). The keypad's Ins button's
  action is `{kind:'insert'}` and pressing it twice leaves insert on. Enter/Clear on a
  disconnected session still reconnect (existing tests stay green).
- [ ] **Step 2: implement.** In `keymap.ts`, build `Action` as `KeyAction | <front-end-only
  kinds>` (import from `@tn3270/core`), removing the duplicated members. In `applyAction`, keep
  the front-end throws and `reconnectInstead`, then `session.run(action)` for everything that is
  a `KeyAction` (a type guard, or the switch's front-end kinds handled first and the rest
  passed through). Keep the `try/catch` and the `satisfies never` exhaustiveness on the
  front-end kinds. Keypad Ins: `{ kind: 'insert' }` (x3270's keypad Ins is `Insert_action`).
  The Insert KEY keeps `toggleInsert`. Check `BINDING_INTENT` and the keypad tests that assert
  the Ins button's action.
- [ ] **Step 3:** run the canvas, tui, gui and web suites too (they consume `Action`); gate;
  commit `frontend: operator actions go through Session.run`.

### Task 10: the CLI routes through `run`, and its action names follow s3270

**Files:** `packages/cli/src/runner.ts`; CLI tests; `transferRun.ts`.

- [ ] **Step 1: failing tests.**
  - `String(x)` on a host-locked session succeeds (queued) and the text lands after the host
    restores; on an operator-error-locked session it fails with `input inhibited`.
  - `BackSpace()` moves the cursor left and changes no cell (s3270 `BackSpace_action`,
    kybd.c:2285); `Erase()` is the destructive close-up.
  - `Insert()` sets insert on (twice: on); `ToggleInsert()` toggles.
  - During a `Transfer()`, `session.transferring` is true; afterwards (success, failure,
    timeout, cancel, disconnect) it is false. Same for the GUI/browser `transferRun.ts`.
- [ ] **Step 2: implement.** Each keyboard case calls `s.run({...})`; `String`, `Dup`,
  `FieldMark` throw their existing messages when the result is `'dropped'` or `'refused'`.
  `Enter`/`Clear`/`PF`/`PA`/`Attn`/`SysReq` go through `run` too. Add `Erase` and
  `ToggleInsert` cases. `transferring`: set it where each driver registers the transfer and
  clear it in ONE place every end path passes through (find it — `transferRun.ts` has an
  `ended` flag and a finish function; the CLI has its own loop). Also clear it in
  `Session.handleClose` so a dropped connection can never leave it stuck. The transfer drivers'
  own `primeAndType`/`sendAID` calls stay direct (not `run`): they must not queue.
  Check the CLI's README action table and its `--help` text name `Erase()`/`ToggleInsert()`.
- [ ] **Step 3:** gate; commit `cli: actions go through Session.run; BackSpace() moves, Erase() erases, as s3270`.

### Task 11: mutation pass

- [ ] For each branch of `run` (not connected, reset half/full, operator error drop, operator
  error clear, transferring drop, queue), of `drainTypeahead` (the `isInhibited` loop test, the
  `typeahead` flag update, the trailing `'screen'`), `OERR_CLEARS` membership (remove one kind at
  a time), the three insert-off sites, `numericLock`'s gate and Attn's three arms: break it, run
  the suite, confirm at least one test fails for the right reason, restore. Work in this checkout
  only, one mutation at a time, `git diff` clean between mutations. Report a table: mutation,
  failing test(s). Add tests for any survivor and commit them.

### Task 12: live witnesses (the controller, not a subagent)

  Through the recording relay, from the GUI, against VM/370 and TK5 (the user starts the hosts):
  typeahead during `X SYSTEM`; an AID queued behind an AID; oerr-lock (protected field, letter
  dropped with the bell, Tab clears); insert off after Enter and Reset; Erase closing up a field;
  Delete and EraseEOF on an unformatted screen. Recorded in `docs/live-testing.md` with the
  relay script and its output.

### Task 13: docs

- Re-read and update `docs/parity/checklist.yaml` rows: typeahead, aid-keys, cursor-movement,
  insert-mode, reset-key, oerr-lock, numeric-lock, attn, erase-backspace, delete-key, erase-eof,
  erase-input (no-setting rows stay `partial`, gap "no setting (15b)"; erase-backspace records
  the c3270 divergence; attn's live is "tests only"); `node scripts/parity.mjs render` and
  `gate`, record the count.
- README *Staging* 15a, *Using the CLI* (`BackSpace()`, `Erase()`, `Insert()`, `ToggleInsert()`),
  the OIA `T`; a `changelog.d` fragment (the CLI `BackSpace()` break called out); HANDOFF.
