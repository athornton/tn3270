/**
 * Terminal byte sequences to NAMED 3270 actions.
 *
 * This module decides nothing about 3270 semantics. It answers one question --
 * "which named action did the user just press?" -- and `Keyboard` in core owns
 * everything that follows: field-aware typing, tab, EraseEOF, insert mode, and
 * the keyboard-lock rules. So the action names here are deliberately the same
 * ones the CLI's command table uses, and adding a key is a table entry.
 *
 * ## WHERE THESE SEQUENCES CAME FROM
 *
 * All of them were measured with `tput -T xterm-256color <cap>` on the
 * development box rather than taken from memory or from the plan. Two
 * corrections to the plan came out of that, both the same shape:
 *
 * **The arrow keys and Home have TWO encodings each, and terminfo reports the
 * one the plan did not.** `tput kcuu1` gives `\x1bOA` (SS3) and `tput khome`
 * gives `\x1bOH`, while the plan's tests used `\x1b[A` and `\x1b[H` (CSI). Both
 * are correct: xterm sends CSI in normal cursor mode and SS3 once DECCKM is set,
 * and `smkx` is exactly `\x1b[?1h\x1b=`. terminfo documents the application-mode
 * form because it assumes `smkx` has been sent. Since any layer -- us, tmux,
 * screen -- can flip that mode, BOTH are in the table. Supporting one would lose
 * the arrow keys outright, depending on the terminal.
 *
 * The function keys needed no correction: `kf1`-`kf24` matched the plan exactly,
 * including the irregularity worth knowing about -- F7-F11 are `18/19/20/21/23~`,
 * with **no `22~`** -- and shifted Fn is `;2` with PF(n+12), the c3270
 * convention.
 *
 * ## PARTIAL VERSUS NULL IS THE INTERESTING PART
 *
 * A lone ESC is both a legal keypress and the first byte of every function key,
 * so it cannot be resolved from the buffer alone. This module reports that fact
 * and refuses to guess; `app.ts` owns the timer that breaks the tie. Guessing
 * here would either eat the following keystroke or emit a spurious PA.
 */

import { PF_AIDS } from '@tn3270/core';

export type Action =
  | { kind: 'pf'; n: number }
  | { kind: 'pa'; n: number }
  | { kind: 'enter' }
  | { kind: 'clear' }
  | { kind: 'reset' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'home' }
  | { kind: 'tab' }
  | { kind: 'backTab' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'eraseEOF' }
  | { kind: 'eraseInput' }
  | { kind: 'type'; text: string }
  | { kind: 'quit' };

/**
 * Sentinel: these bytes are a valid PREFIX of a longer sequence, so the caller
 * must wait for more input rather than acting or discarding.
 *
 * Returning `null` instead would conflate "wait" with "impossible", and the
 * caller's two correct responses to those are opposite: keep buffering, versus
 * throw the bytes away. A bare ESC is the case that matters -- it is a legal key
 * AND the start of every function key, and only a timeout can tell them apart.
 * app.ts owns that timer; this module stays pure.
 */
export const PARTIAL = Symbol('partial');

/**
 * The PF sequences, `tput kf1`..`kf24`. PF(n) for F(n), PF(n+12) for Shift+F(n).
 * Note the gap: there is no `22~`.
 */
const PF_KEYS: readonly (readonly [string, number])[] = [
  ['\x1bOP', 1], ['\x1bOQ', 2], ['\x1bOR', 3], ['\x1bOS', 4],
  ['\x1b[15~', 5], ['\x1b[17~', 6], ['\x1b[18~', 7], ['\x1b[19~', 8],
  ['\x1b[20~', 9], ['\x1b[21~', 10], ['\x1b[23~', 11], ['\x1b[24~', 12],
  ['\x1b[1;2P', 13], ['\x1b[1;2Q', 14], ['\x1b[1;2R', 15], ['\x1b[1;2S', 16],
  ['\x1b[15;2~', 17], ['\x1b[17;2~', 18], ['\x1b[18;2~', 19], ['\x1b[19;2~', 20],
  ['\x1b[20;2~', 21], ['\x1b[21;2~', 22], ['\x1b[23;2~', 23], ['\x1b[24;2~', 24],
];

function buildTable(): Map<string, Action> {
  const t = new Map<string, Action>();
  for (const [seq, n] of PF_KEYS) t.set(seq, { kind: 'pf', n });

  // Cursor keys and Home, BOTH encodings -- see the header note on DECCKM.
  t.set('\x1b[A', { kind: 'up' });
  t.set('\x1b[B', { kind: 'down' });
  t.set('\x1b[C', { kind: 'right' });
  t.set('\x1b[D', { kind: 'left' });
  t.set('\x1bOA', { kind: 'up' });
  t.set('\x1bOB', { kind: 'down' });
  t.set('\x1bOC', { kind: 'right' });
  t.set('\x1bOD', { kind: 'left' });
  t.set('\x1b[H', { kind: 'home' });
  t.set('\x1bOH', { kind: 'home' });

  t.set('\x1b[Z', { kind: 'backTab' });   // tput kcbt
  t.set('\x1b[3~', { kind: 'delete' });   // tput kdch1
  t.set('\x7f', { kind: 'backspace' });   // tput kbs
  t.set('\t', { kind: 'tab' });
  t.set('\r', { kind: 'enter' });
  t.set('\n', { kind: 'enter' });         // some terminals send LF for Return

  // `\x1b[4~` is vt220 Select/End. Bound to EraseEOF as a deliberate CHOICE,
  // following c3270; it is not a terminfo-derived mapping.
  t.set('\x1b[4~', { kind: 'eraseEOF' });

  // Control keys. Ctrl-C is Clear, not interrupt: Clear is an AID a 3270 user
  // needs constantly (it dismisses MORE...), and Ctrl-] is the way out.
  t.set('\x03', { kind: 'clear' });
  t.set('\x12', { kind: 'reset' });
  t.set('\x15', { kind: 'eraseInput' });
  t.set('\x1d', { kind: 'quit' });

  // The PA keys have no terminal equivalent, so ESC-digit, as c3270 does.
  t.set('\x1b1', { kind: 'pa', n: 1 });
  t.set('\x1b2', { kind: 'pa', n: 2 });
  t.set('\x1b3', { kind: 'pa', n: 3 });
  return t;
}

const TABLE: ReadonlyMap<string, Action> = buildTable();

/** Every prefix of every table key, so PARTIAL is a lookup and not a scan. */
const PREFIXES: ReadonlySet<string> = (() => {
  const s = new Set<string>();
  for (const key of TABLE.keys()) {
    for (let i = 1; i < key.length; i++) s.add(key.slice(0, i));
  }
  return s;
})();

/** Printable ASCII, the only thing a 3270 field accepts as typed text. */
function isPrintable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/**
 * The action for a buffer of terminal input.
 *
 * `PARTIAL` means "a longer sequence may still arrive"; `null` means "discard".
 * The caller must treat those differently -- see the note on PARTIAL.
 */
export function lookup(bytes: Uint8Array): Action | typeof PARTIAL | null {
  // An empty buffer is not a prefix of anything; returning PARTIAL here would
  // park the reader in a waiting state that only a timeout could leave.
  if (bytes.length === 0) return null;

  const seq = String.fromCharCode(...bytes);
  const exact = TABLE.get(seq);
  if (exact !== undefined) return exact;

  // A complete match is checked FIRST, so a key that is also a live prefix
  // resolves rather than waits.
  //
  // NO TEST CAN CURRENTLY PIN THIS ORDER, verified by mutation: swapping these
  // two blocks leaves all 25 tests green, because no key in TABLE is a proper
  // prefix of another one. (The near misses are not prefixes: `\x1b[15~` and
  // `\x1b[15;2~` diverge at `~` versus `;`, and PA1's `\x1b1` differs from
  // `\x1b[1;2P` at the second byte.) The order is kept because it becomes
  // load-bearing the moment a terminal needs a key that IS a prefix of another
  // -- then exact-first is the difference between acting and hanging until the
  // ESC timer fires. Do not write a test claiming to pin it as it stands.
  if (PREFIXES.has(seq)) return PARTIAL;

  // A run of printable bytes is typed text. Handling the whole run rather than
  // one byte keeps paste working without the caller re-entering per byte.
  let printable = true;
  for (const b of bytes) {
    if (!isPrintable(b)) { printable = false; break; }
  }
  if (printable) return { kind: 'type', text: seq };

  return null;
}

/**
 * Is this a PF number the architecture defines? Guards a hand-built action.
 *
 * The upper bound is `PF_AIDS.length`, NOT a literal 24: core's table of AID
 * bytes is the authority on how many PF keys exist, and a second hardcoded 24
 * here would be a copy to keep in step for no benefit.
 */
export function isValidPf(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= PF_AIDS.length;
}
