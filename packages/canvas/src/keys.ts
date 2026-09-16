import type { Action } from '@tn3270/frontend';

/**
 * Chromium `KeyboardEvent` to a named 3270 action.
 *
 * The GUI's counterpart to the terminal keymap, and deliberately NOT derived from it: that
 * table is measured byte sequences and this one matches `key` names, so a shared
 * abstraction over both would be an untested third thing. What IS shared is the `Action`
 * vocabulary from `@tn3270/frontend`, and `BINDING_INTENT` there records which key is meant
 * to do what -- `keys.test.ts` checks this mapper against it, so a key added to one front
 * end is visibly missing from the other.
 *
 * ## RETURNS null RATHER THAN GUESSING
 *
 * An unknown key must do nothing. Falling through to `type` would put the literal string
 * "AudioVolumeUp" into a field, and a bare `Shift` would type "Shift" -- both worse than
 * ignoring the key. An unmapped Ctrl chord is likewise dropped rather than typing its
 * letter: Ctrl-Z has no 3270 meaning, and inserting a bare "z" is not a reasonable guess.
 *
 * ## Ctrl-C IS CLEAR, Ctrl-] QUITS
 *
 * Correct for a 3270 and surprising to everyone: Clear is an AID a user needs constantly to
 * dismiss VM's `MORE...` state, so the usual instinct for escaping cannot be the way out.
 * The window says so at startup, as the TUI's banner does.
 */
export interface KeyLike {
  readonly key: string;
  /**
   * The PHYSICAL key. Load-bearing for Alt chords: on macOS, Option-1 reports
   * `key === '¡'`, so an `e.key` binding works on Linux and fails on a Mac.
   */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** Keys whose `key` value is a name rather than a character. */
const NAMED: Readonly<Record<string, Action>> = Object.freeze({
  Enter: { kind: 'enter' },
  ArrowLeft: { kind: 'left' },
  ArrowRight: { kind: 'right' },
  ArrowUp: { kind: 'up' },
  ArrowDown: { kind: 'down' },
  Home: { kind: 'home' },
  Backspace: { kind: 'backspace' },
  Delete: { kind: 'delete' },
  // vt220 Select/End bound to EraseEOF, following c3270 -- a CHOICE, not a derivation.
  End: { kind: 'eraseEOF' },
  // x3270's Toggle(insertMode), fb-x3270:210.
  Insert: { kind: 'toggleInsert' },
});

/**
 * Modifier keys arrive as key events in their own right and mean nothing alone.
 * Without this, holding Shift types "Shift" into the field.
 */
const MODIFIERS: ReadonlySet<string> = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph', 'NumLock', 'ScrollLock',
]);

/**
 * The Ctrl chords a 3270 uses. Anything else with Ctrl held is dropped.
 *
 * `d`, `f` and `k` are c3270's own, from the keymap a terminal build reads:
 * `Ctrl<Key>d: Dup()`, `Ctrl<Key>f: FieldMark()`, `Ctrl<Key>k: Keypad()`
 * (Common/fb-c3270:186-187, :191). Matching the terminal keymap here is the point -- an
 * operator moving between the TUI and a window should not have to learn two sets.
 */
const CTRL: Readonly<Record<string, Action>> = Object.freeze({
  c: { kind: 'clear' },
  r: { kind: 'reset' },
  u: { kind: 'eraseInput' },
  ']': { kind: 'quit' },
  a: { kind: 'attn' },
  d: { kind: 'dup' },
  f: { kind: 'fieldMark' },
  k: { kind: 'toggleKeypad' },
});

/** Physical digit keys that carry the PA keys when Alt is held. Same shape as CTRL. */
const PA_CODES: Readonly<Record<string, Action>> = Object.freeze({
  Digit1: { kind: 'pa', n: 1 },
  Digit2: { kind: 'pa', n: 2 },
  Digit3: { kind: 'pa', n: 3 },
});

export function actionForKey(e: KeyLike): Action | null {
  if (MODIFIERS.has(e.key)) return null;

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    // Case-folded because Ctrl-Shift-C still means Clear, and browsers report the shifted
    // letter. `?? null` is what drops Ctrl-Z rather than typing "z".
    return CTRL[e.key.toLowerCase()] ?? null;
  }
  // The PA keys, on Alt+digit as x3270 and c3270 both have them (Common/fb-c3270:43-45).
  // Matched on e.code and not e.key: see the note on KeyLike.code. Checked BEFORE the bail
  // below, which is what used to make every PA key unreachable in this front end. The
  // `!ctrlKey && !metaKey` guard leaves Ctrl-Alt-digit and Cmd-Alt-digit falling through to
  // that bail as `null`, unchanged from before this patch.
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    // Alt-K is how c3270's _WIN32 keymap spells `Keypad()` (Common/fb-c3270:48-49, which binds
    // both `k` and `K`), so it is honoured here alongside the Ctrl-K its terminal keymap uses
    // (:191). A terminal cannot have both -- Alt-K arrives there as `ESC k` and this project
    // keeps new bindings off the ESC path -- but a real KeyboardEvent carries no such ambiguity.
    //
    // `e.code`, NOT `e.key.toLowerCase()`, and for the reason the note on `KeyLike.code` gives:
    // Option-K on macOS reports `key === '˚'`, exactly as Option-1 reports `'¡'`. A `key`-based
    // test here would work on Linux, fail on a Mac and pass every test written on Linux --
    // the same defect that once made the PA keys unreachable. Matching the physical key also
    // makes Alt-Shift-K work, as c3270's pair of `k`/`K` bindings does.
    //
    // Checked BEFORE PA_CODES so a future Alt entry in that table cannot shadow it silently.
    if (e.code === 'KeyK') return { kind: 'toggleKeypad' };
    return PA_CODES[e.code] ?? null;
  }

  // A Meta or Alt chord belongs to the window or the OS, never to the field. Cmd-digit is
  // deliberately NOT a PA: that is where menu accelerators live.
  if (e.metaKey || e.altKey) return null;

  if (e.key === 'Tab') return e.shiftKey ? { kind: 'backTab' } : { kind: 'tab' };

  const fn = /^F(\d{1,2})$/.exec(e.key);
  if (fn !== null) {
    const n = Number(fn[1]);
    if (n < 1 || n > 12) return null;          // F13+ is not a 3270 key
    // Shifted Fn is PF(n+12), the c3270 convention the terminal keymap also follows.
    return { kind: 'pf', n: e.shiftKey ? n + 12 : n };
  }

  const named = NAMED[e.key];
  if (named !== undefined) return named;

  // Exactly one code point means a printable key; `key` is already the shifted form.
  if ([...e.key].length === 1) return { kind: 'type', text: e.key };
  return null;
}
