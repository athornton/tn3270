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
  | { kind: 'attn' } | { kind: 'sysreq' };

/** What `run` did with an action. The CLI turns `dropped`/`refused` into its errors. */
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
