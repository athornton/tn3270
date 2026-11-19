/**
 * An OPERATOR action: what a key, a keypad button or a script action asks the keyboard to do.
 * `Session.run` is the only route by which one reaches the screen or the host, because that is
 * where x3270's lock rules live (Common/kybd.c, enq_xta and OERR_CLEAR_OR_ENQ).
 *
 * Field names (`text` on `type`, `n` on `pf`/`pa`) are chosen to match
 * `frontend/src/keymap.ts`'s `Action` exactly, so that union can be built as
 * `KeyAction | <front-end-only kinds>` without renaming anything (Task 9).
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
  | { kind: 'attn' } | { kind: 'sysreq' }
  // ADDED (Task 10): the CLI's `BackSpace()`, s3270's non-destructive cursor-left
  // (`BackSpace_action`, Common/kybd.c:2285), kept as its OWN kind rather than reused as
  // `{ kind: 'left' }` because the two do NOT behave alike under every lock state, which the
  // task's own instruction asked to be checked rather than assumed: `Left_action` (kybd.c:2140)
  // wraps its body in `OERR_CLEAR_OR_ENQ`, which under a PURE operator-error lock clears it
  // and then moves the cursor; `BackSpace_action` instead does `if (kybdlock) { enq_ta(...);
  // return true; }` unconditionally, and `enq_ta` -> `enq_xta` (kybd.c:270-291) DROPS an
  // operator error with the bell rather than clearing it (its "operator error" test runs
  // before its "queue" one, and there is no clear anywhere in that path). So a `BackSpace()`
  // against `X Protected` must drop-and-alarm, not clear-and-move, which is exactly the
  // "every other action" bucket `Session.run` already has -- hence NOT added to `OERR_CLEARS`
  // below. Under a host lock (no OERR) both land in the same typeahead queue either way
  // (`enq_xta`'s queueing branch and `OERR_CLEAR_OR_ENQ`'s `enq_ta` call are the same
  // function), so the only observable difference is the OERR case.
  | { kind: 'backSpaceLeft' };

/**
 * What `run` did with an action.
 *
 * The CLI's `String()`, `Dup()` and `FieldMark()` turn `dropped`/`refused` into their own
 * errors. `Enter()`, `Clear()`, `PF()`, `PA()`, `Attn()` and `SysReq()` do NOT (Task 10):
 * s3270's own action functions for all six (`Common/kybd.c`: `Enter_action`, `PF_action:929`,
 * `PA_action`, `Clear_action`, `Attn_action:982`, `SysReq_action:2849`) call `enq_ta`/`enq_xta`
 * under ANY lock -- not connected, an operator error, or a host lock alike -- and then `return
 * true` regardless; the one thing that fails any of them is `check_argc`'s argument-shape
 * check, which this runner does its own way before ever calling `run`. Every other `KeyAction`
 * kind reaching `run` from the CLI also discards the result, the same way `applyAction`
 * (frontend) discards it for a key press.
 */
export type RunResult = 'done' | 'queued' | 'dropped' | 'refused';

/**
 * The actions x3270 wraps in OERR_CLEAR_OR_ENQ (kybd.c:146): under an operator error ONLY, they
 * clear it and then act. Every other action is dropped with the alarm (enq_xta, kybd.c:285).
 * x3270's DeleteField, DeleteWord, FieldEnd and PreviousWord are also in that set; we have none.
 *
 * Not yet consulted by `Session.run` -- that is Task 3's `oerrLock` branch -- but declared here,
 * with Task 1's type, because it is a fact about what a `KeyAction` IS (one responsibility, per
 * the plan's file map), not about how `run` behaves.
 */
export const OERR_CLEARS: ReadonlySet<KeyAction['kind']> = new Set([
  'tab', 'backTab', 'home', 'up', 'down', 'left', 'right', 'eraseEOF', 'eraseInput',
]);
