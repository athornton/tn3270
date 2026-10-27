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
  /**
   * `KeyboardEvent.getModifierState`. OPTIONAL, and the optionality is the point: a real
   * event always has it, but `Electron.sendInputEvent` synthesizes events that do not, and
   * `keyspec.ts` documents that an unrecognized spelling arrives as `key: ''` with no
   * methods at all. Code here must therefore treat its absence as "no AltGraph", never
   * call it unguarded.
   */
  readonly getModifierState?: (modifier: string) => boolean;
}

/**
 * Does this event carry a LAYOUT CHARACTER -- a character reachable only through a
 * layout-shift modifier?
 *
 * ## THE BUG THIS FIXES
 *
 * On a German, Spanish or Nordic layout the C programmer's characters live behind AltGr:
 * `{` is AltGr+7, `}` is AltGr+0, and `[`, `]`, `@`, `\` and `~` are AltGr chords too. Those
 * arrive with `altKey` set, so the Alt branch below dropped every one of them and a whole
 * class of keyboard could not type a brace into a field at all.
 *
 * `getModifierState('AltGraph')` is the portable signal (MDN,
 * `KeyboardEvent.getModifierState`): true for **Windows AltGr**, for **macOS Option**, and
 * for the **GTK level-3/5 shift** on Linux. Plain `altKey` cannot stand in for it, because
 * Windows reports AltGr AS ctrlKey+altKey -- so a `ctrlKey && altKey` test would swallow
 * genuine Ctrl-Alt chords, and an `altKey` test would steal Alt+digit from the PA keys.
 *
 * ## WHY THIS IS A FALLBACK AND NOT A BRANCH TAKEN FIRST
 *
 * MEASURED, and the first version of this fix got it wrong: on **macOS, Option sets
 * AltGraph too**, so checking it before the bindings made Option-1 type `¡` instead of
 * sending PA1 and Option-K type `˚` instead of toggling the keypad. That is precisely the
 * defect the notes on `KeyLike.code` and the PA tests already warn about -- a change that
 * works on Linux and silently breaks a Mac -- and the existing tests passed through it
 * because none of them set `getModifierState`.
 *
 * So the order is: **every binding gets its chance first**, and only a keystroke that no
 * binding claimed is reconsidered as a layout character. Option-1 still reaches PA1,
 * AltGr+7 still types `{`, because `Digit7` is in no table.
 *
 * NOT DRIVEN BY THE Xvfb HARNESS, and `keys.mjs` cannot be extended to cover it:
 * `sendInputEvent`'s modifier list (`electron.d.ts:8961`) has no `altgr`, so there is no way
 * to synthesize one of these events from the harness. `keys.test.ts` is the whole of the
 * cover, which is why it states both platforms' shapes explicitly.
 */
function layoutCharacter(e: KeyLike): Action | null {
  if (e.getModifierState?.('AltGraph') !== true) return null;
  // The same single-code-point rule the printable path uses, so a dead key (`key: 'Dead'`)
  // or an F-key with AltGr held still types nothing.
  if ([...e.key].length === 1) return { kind: 'type', text: e.key };
  return null;
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
  // The full 122-key keyboard, 2026-10-22. Free in both mappers -- the taken chords are
  // C R U ] A D F K T -- and claiming it also suppresses Firefox's bookmarks sidebar, which is
  // correct: `renderer.ts` calls `preventDefault` only for keys we claimed, so claiming it is
  // what makes it ours. Intercepted CLIENT-SIDE in both DOM front ends, exactly as `toggleKeypad`
  // is, and the gateway returns before `applyAction` for it -- see `web/src/main.ts`.
  b: { kind: 'toggleKeyboard' },
  /**
   * Ctrl-T, the transfer form -- `BINDING_INTENT`'s own spelling, now that the GUI has a dialog.
   *
   * THE GUI HAD THIS CHORD DEAD WHILE THE WINDOW WORKED, which is how this was found: a real
   * Electron run with `TN3270_GUI_KEYS=Ctrl+T` printed `keys: sent Ctrl+T` and NO `action:` line
   * at all, where a click on the `Xfer` keypad button opened the window fine. The keypad route
   * went through `KEYPAD_KEYS` and never through this table, so the one that was missing was also
   * the one no harness drove.
   *
   * ACCEPTED BY THE WEB FRONT END TOO, since this mapper is shared, and that is safe rather than
   * merely tolerable: `protocol.ts:129-131` REJECTS the kind at decode with a per-client `error`
   * frame, and `web/src/main.ts:151-154` answers a decode failure on that one socket without
   * touching the session or the process. The browser could already produce this kind from the
   * `Xfer` button it draws today, so this adds a second route to an answer that already exists --
   * no new failure mode, and the refusal names its reason. When stage 4 gives the gateway a
   * transfer path that rejection becomes an interception, and this entry needs no change.
   */
  t: { kind: 'transferForm' },
});

/** Physical digit keys that carry the PA keys when Alt is held. Same shape as CTRL. */
const PA_CODES: Readonly<Record<string, Action>> = Object.freeze({
  Digit1: { kind: 'pa', n: 1 },
  Digit2: { kind: 'pa', n: 2 },
  Digit3: { kind: 'pa', n: 3 },
});

export function actionForKey(e: KeyLike): Action | null {
  if (MODIFIERS.has(e.key)) return null;

  /**
   * COPY, on `Ctrl-Shift-C` (Linux, Windows) and `Cmd-Shift-C` (macOS). 2026-10-27.
   *
   * ## BEFORE THE `CTRL` LOOKUP, AND THAT ORDER IS THE WHOLE TRICK
   *
   * That lookup is case-folded, so `Ctrl-Shift-C` used to mean Clear just as `Ctrl-C` does --
   * DRIVEN, not assumed: both returned `{kind:'clear'}` before this branch existed. Taking the
   * shifted form for copy therefore requires getting in first; a `copy` entry in `CTRL` could not
   * work at all. Plain `Ctrl-C` is untouched and still Clear, which is the property the fold
   * exists to protect, and the comment on the lookup now says which of the two jobs it still has.
   *
   * ## WHY NOT THE NATIVE `copy` EVENT, WHICH IS HOW PASTE WORKS
   *
   * MEASURED, Electron 44.3.0 under Xvfb, in a real Chromium window with NO text selected in the
   * document -- our case, since the canvas selection is `renderer.ts`'s module-level
   * `anchor`/`focus` (`:88-89`) and not a DOM Range; there is no `getSelection` or `createRange`
   * call anywhere in `packages/canvas` or `packages/web`:
   *
   *     Ctrl-C        -> copy event FIRES, clipboardData present
   *     Cmd-C         -> no copy event
   *     Ctrl-Shift-C  -> no copy event
   *
   * So the native copy gesture on Linux is `Ctrl-C` -- the Clear AID -- and adopting it the way
   * paste adopted the native `paste` event would collide with the one binding this project has
   * decided must stay Clear on every platform. `menu.ts:56-72` records that decision AND records
   * rejecting the conditional form, "Ctrl-C copies when a selection exists and Clears when it does
   * not", because it makes a DESTRUCTIVE AID depend on invisible state. Paste got a free ride
   * because `keys.ts` never claimed `Ctrl-V`; copy gets none, so it needs an explicit chord.
   *
   * The same measurement is why macOS needs a binding rather than the browser default: `Cmd-C`
   * copies NOTHING from a canvas. A `null` from this mapper means "we declined it", never "the
   * platform handles it" -- the reading that made an earlier claim in this feature wrong.
   *
   * ## `requestCopy`, NOT `copy`
   *
   * `copy` carries a rect and this function is a pure function of one key event, so it cannot
   * see a selection -- the union member's own note in `frontend/src/keymap.ts` has the detail.
   * The renderer, which holds the rectangle, is what turns the intent into a real `copy`.
   *
   * ## `e.code`, AND NEITHER SPELLING OF `e.key` WOULD DO
   *
   * `e.key.toLowerCase()` is the fold itself: it is what makes `Ctrl-Shift-C` indistinguishable
   * from `Ctrl-C`, so the one chord whose discriminator IS Shift cannot be matched through it.
   * Raw `e.key === 'C'` fails differently -- `e.key` is the shifted, LAYOUT-DEPENDENT form, the
   * hazard `KeyLike.code`'s note records, and Shift inverts caps lock, so an operator with caps
   * lock on reports `key: 'c'` with `shiftKey` set. Matching the physical key is what `Alt-K`
   * above does, and for the same reason.
   *
   * ## THE MODIFIER GUARDS
   *
   * `!altKey` leaves `Ctrl-Alt-Shift-C` with the window manager, following this file's rule that
   * an Alt or Meta chord is the OS's. It is also what keeps the Windows AltGr path intact: Windows
   * reports AltGr as ctrlKey+altKey, so an AltGr chord over `KeyC` must fall through to
   * `layoutCharacter` below rather than be eaten here.
   *
   * `ctrlKey !== e.metaKey` IS AN EXCLUSIVE OR AND NOT A LOOSE `(ctrlKey || metaKey)`, which is
   * the form the plan for this task proposed. It demands EXACTLY ONE of the two, so it rejects
   * both edges a disjunction would admit: `Ctrl-Cmd-Shift-C`, a chord belonging to the OS by the
   * same rule the bail below states -- and NEITHER modifier, where a bare `Shift-C` must stay
   * typed text. The Alt-K branch spells the same exclusion `!ctrlKey && !metaKey`, because no
   * branch here may claim a chord another one half-matches.
   */
  if (e.shiftKey && !e.altKey && e.ctrlKey !== e.metaKey && e.code === 'KeyC') {
    return { kind: 'requestCopy' };
  }

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    // Case-folded so that Ctrl-Shift-R, Ctrl-Shift-U and every other entry here reach their
    // unshifted meaning -- caps lock, or a held shift, must not make a chord inert. `Ctrl-Shift-C`
    // is now the ONE exception and is claimed by the copy branch above, which is why that branch
    // has to run first; plain `Ctrl-C` is still Clear. `?? null` is what drops Ctrl-Z rather than
    // typing "z".
    return CTRL[e.key.toLowerCase()] ?? null;
  }
  // The PA keys, on Alt+digit as x3270 and c3270 both have them (Common/fb-c3270:43-45).
  // Matched on e.code and not e.key: see the note on KeyLike.code. Checked BEFORE the bail
  // below, which is what used to make every PA key unreachable in this front end. The
  // `!ctrlKey && !metaKey` guard leaves Ctrl-Alt-digit and Cmd-Alt-digit falling through to
  // that bail, where they are `null` unless AltGraph says the keystroke is a layout
  // character -- which is how Windows AltGr+7, reported as ctrlKey+altKey, reaches `{`.
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    // Alt-K is how c3270's _WIN32 keymap spells `Keypad()` (Common/fb-c3270:48-49, which binds
    // both `k` and `K`), so it is honored here alongside the Ctrl-K its terminal keymap uses
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
    // `??` and not `return ... ?? null`: a key no PA entry claims may still be a layout
    // character. This is the macOS Option path -- Option-1 matched `Digit1` above and never
    // reaches here, while Option-8 on a German Mac has no binding and types `{`.
    return PA_CODES[e.code] ?? layoutCharacter(e);
  }

  // A Meta or Alt chord belongs to the window or the OS, never to the field. Cmd-digit is
  // deliberately NOT a PA: that is where menu accelerators live.
  //
  // THE WINDOWS AltGr PATH ENDS HERE, because Windows reports AltGr as ctrlKey+altKey and so
  // misses both branches above. A genuine Ctrl-Alt chord has no AltGraph state and still
  // returns null, which is what keeps Ctrl-Alt-K with the window manager.
  if (e.metaKey || e.altKey) return layoutCharacter(e);

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
