import { describe, it, expect } from 'vitest';
import { BINDING_INTENT } from '@tn3270/frontend';
import { actionForKey, type KeyLike } from '../src/keys.js';

/** The subset of KeyboardEvent this maps on. Constructing a real one needs a DOM. */
const ev = (init: Partial<KeyLike> & { key: string }): KeyLike =>
  ({ code: '', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init });

describe('actionForKey', () => {
  it('maps Enter, Tab and the arrows', () => {
    expect(actionForKey(ev({ key: 'Enter' }))).toEqual({ kind: 'enter' });
    expect(actionForKey(ev({ key: 'Tab' }))).toEqual({ kind: 'tab' });
    expect(actionForKey(ev({ key: 'ArrowLeft' }))).toEqual({ kind: 'left' });
    expect(actionForKey(ev({ key: 'ArrowUp' }))).toEqual({ kind: 'up' });
  });

  it('maps Ctrl-C to CLEAR, not to an interrupt', () => {
    // The binding that surprises everyone and is nonetheless correct: a 3270 user needs
    // Clear constantly to dismiss VM's MORE... state.
    expect(actionForKey(ev({ key: 'c', ctrlKey: true }))).toEqual({ kind: 'clear' });
    expect(actionForKey(ev({ key: 'C', ctrlKey: true }))).toEqual({ kind: 'clear' });
  });

  it('maps Ctrl-] to quit, which is the way out', () => {
    expect(actionForKey(ev({ key: ']', ctrlKey: true }))).toEqual({ kind: 'quit' });
  });

  it('maps F1-F12 to PF1-PF12 and shifted to PF13-PF24', () => {
    expect(actionForKey(ev({ key: 'F3' }))).toEqual({ kind: 'pf', n: 3 });
    expect(actionForKey(ev({ key: 'F12' }))).toEqual({ kind: 'pf', n: 12 });
    expect(actionForKey(ev({ key: 'F1', shiftKey: true }))).toEqual({ kind: 'pf', n: 13 });
    expect(actionForKey(ev({ key: 'F12', shiftKey: true }))).toEqual({ kind: 'pf', n: 24 });
  });

  it('maps a printable character to a type action, preserving case', () => {
    expect(actionForKey(ev({ key: 'A' }))).toEqual({ kind: 'type', text: 'A' });
    expect(actionForKey(ev({ key: 'a' }))).toEqual({ kind: 'type', text: 'a' });
    expect(actionForKey(ev({ key: ' ' }))).toEqual({ kind: 'type', text: ' ' });
  });

  it('returns null for a bare modifier, rather than typing its name', () => {
    // Without this, holding Shift types the string "Shift" into the field.
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']) {
      expect(actionForKey(ev({ key })), key).toBeNull();
    }
  });

  it('returns null for a key it does not know, rather than guessing', () => {
    expect(actionForKey(ev({ key: 'F13' }))).toBeNull();
    expect(actionForKey(ev({ key: 'AudioVolumeUp' }))).toBeNull();
    expect(actionForKey(ev({ key: 'ScrollLock' }))).toBeNull();
  });

  it('does not turn a Meta or Alt chord into typed text', () => {
    // Cmd-Q must not type "q" into the field on the way to quitting, and Alt chords
    // belong to the window manager.
    expect(actionForKey(ev({ key: 'q', metaKey: true }))).toBeNull();
    expect(actionForKey(ev({ key: 'f', altKey: true }))).toBeNull();
  });

  it('maps Ctrl-Shift-C and Cmd-Shift-C to a copy REQUEST, on e.code', () => {
    // Two chords, no platform detection, because neither is ambiguous on either platform --
    // and MEASURED is why Cmd gets a binding at all rather than being left to the browser:
    // in a real Chromium window with NO DOM selection (our case, since the canvas selection is
    // `renderer.ts` module state and not a Range), Ctrl-C fires a native `copy` event and Cmd-C
    // fires NONE. So macOS copies nothing from a canvas without this. The measurement is
    // recorded once, in the branch's own docstring in `keys.ts`.
    //
    // `requestCopy` and NOT `copy`: `copy` carries a rect and this function is pure. See that
    // union member's own note.
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', metaKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
  });

  it('keeps plain Ctrl-C as CLEAR, which is the property the fold protected', () => {
    // A REGRESSION GUARD, AND IT PASSED BEFORE THE BRANCH EXISTED -- stated so, because a test
    // that was already green proves nothing about the change and everything about what the
    // change must not break. The CTRL lookup is case-folded so that Ctrl-Shift-C ALSO meant
    // Clear; this takes the shifted form for copy and must leave the unshifted one alone. Clear
    // is an AID a 3270 operator needs constantly, and `menu.ts:58-69` records REJECTING any
    // binding that makes it conditional on invisible state.
    expect(actionForKey(ev({ key: 'c', ctrlKey: true }))).toEqual({ kind: 'clear' });
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', ctrlKey: true }))).toEqual({ kind: 'clear' });
  });

  it('leaves Ctrl-Shift-R and Ctrl-Shift-U folded, so copy is the ONE exception', () => {
    // The other half of the fold's job, and the half the rewritten comment at the lookup now
    // claims outright. Without this, "Ctrl-Shift-C is the only shifted chord that is not its
    // unshifted self" is an assertion nothing checks -- a branch that matched `KeyR` as well
    // would redden here and nowhere else.
    expect(actionForKey(ev({ key: 'R', code: 'KeyR', ctrlKey: true }))).toEqual({ kind: 'reset' });
    expect(actionForKey(ev({ key: 'R', code: 'KeyR', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'reset' });
    expect(actionForKey(ev({ key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'eraseInput' });
  });

  it('does NOT claim Shift-V in either spelling, because paste is the native event', () => {
    // A REGRESSION GUARD, AND IT ALSO PASSED BEFORE THE BRANCH EXISTED. Claiming it would make
    // `renderer.ts` call preventDefault -- it calls it only for keys this mapper claimed -- and
    // that is the whole of the web front end's paste: `forwardPaste` listens for the native
    // `paste` EVENT, which exists because `keys.ts` never claimed Ctrl-V. So the new branch must
    // be narrow enough not to drag the V key in with the C key.
    expect(actionForKey(ev({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(actionForKey(ev({ key: 'V', code: 'KeyV', metaKey: true, shiftKey: true }))).toBeNull();
  });

  it('matches the PHYSICAL key, so a layout or a caps lock cannot break it', () => {
    // NEITHER SPELLING OF `e.key` WOULD DO, which is why this is on `e.code`:
    //
    //  - `e.key.toLowerCase()`, as the CTRL table uses, is the fold itself -- it is what makes
    //    Ctrl-Shift-C indistinguishable from Ctrl-C, so the one chord that needs Shift as its
    //    discriminator cannot be matched through it.
    //  - raw `e.key === 'C'` assumes Shift+KeyC yields 'C'. Shift INVERTS caps lock, so an
    //    operator with caps lock on reports `key: 'c'` with `shiftKey: true` -- the same hazard
    //    `tui/src/app.ts:91-94` records for its own case-folded list -- and `e.key` is the
    //    layout-dependent shifted form besides (`KeyLike.code`'s note: macOS Option-1 reports
    //    '¡', which is how an e.key binding works on Linux and fails on a Mac).
    //
    // A bogus `key` with the right `code` must still map:
    expect(actionForKey(ev({ key: 'Ç', code: 'KeyC', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
    // The caps-lock shape specifically -- lowercase `key`, Shift held:
    expect(actionForKey(ev({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'requestCopy' });
    // THE CONVERSE -- the right letter on the WRONG physical key -- AND THE PLAN FOR THIS TASK
    // EXPECTED `null` FOR IT, WHICH IS WRONG AND WAS MEASURED SO. The copy branch does decline
    // it, but declining means falling through to the case-folded CTRL lookup, which reads
    // `e.key.toLowerCase()` and so still answers Clear -- exactly as it did before this branch
    // existed. That is the right answer and not a leak: the physical key is what this branch
    // matches on, and what the fold does afterwards is the fold's pre-existing behavior.
    //
    // So the Cmd spelling is the one that isolates the branch, since a Meta chord reaches no
    // table at all. Both are asserted: together they say the branch keyed off `code` and nothing
    // downstream of it changed.
    expect(actionForKey(ev({ key: 'C', code: 'KeyX', ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: 'clear' });
    expect(actionForKey(ev({ key: 'C', code: 'KeyX', metaKey: true, shiftKey: true })))
      .toBeNull();
  });

  it('leaves Ctrl-Alt-Shift-C and Ctrl-Cmd-Shift-C to the window', () => {
    // THE FILE'S OWN RULE -- "a Meta or Alt chord belongs to the window or the OS, never to the
    // field", on the bail below the Alt branch -- and already asserted for the keypad toggle in
    // 'leaves Cmd-K and Ctrl-Alt-K to the window, as it does every other chord'. Cited by its
    // words and not by a line number, which the new branch above would have shifted anyway.
    // The Alt-K branch spells it `!ctrlKey && !metaKey`
    // for exactly this reason, so the copy branch excludes Alt AND excludes the ctrl+meta
    // overlap rather than taking any chord that half-matches.
    //
    // `!altKey` is also what keeps the Windows AltGr path intact: Windows reports AltGr as
    // ctrlKey+altKey, so an AltGr chord over KeyC must fall through to `layoutCharacter` and not
    // be eaten here.
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', ctrlKey: true, altKey: true, shiftKey: true })))
      .toBeNull();
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', ctrlKey: true, metaKey: true, shiftKey: true })))
      .toBeNull();
    // And a bare Shift-C is still typed text, not a copy: the chord needs one of Ctrl or Cmd.
    expect(actionForKey(ev({ key: 'C', code: 'KeyC', shiftKey: true })))
      .toEqual({ kind: 'type', text: 'C' });
  });

  it('ignores an unmapped Ctrl chord instead of typing the letter', () => {
    // Ctrl-Z has no 3270 meaning here. Falling through to `type` would put a bare "z"
    // in the field, which is worse than doing nothing.
    expect(actionForKey(ev({ key: 'z', ctrlKey: true }))).toBeNull();
  });

  it('satisfies the shared BINDING_INTENT table for every key it names', () => {
    // The point of that table: the terminal keymap and this mapper are checked against one
    // written-down intent, so a key added to one front end is visibly missing from the
    // other.
    const named: Record<string, KeyLike> = {
      Enter: ev({ key: 'Enter' }),
      'Ctrl-C': ev({ key: 'c', ctrlKey: true }),
      'Ctrl-]': ev({ key: ']', ctrlKey: true }),
      'Ctrl-R': ev({ key: 'r', ctrlKey: true }),
      'Ctrl-U': ev({ key: 'u', ctrlKey: true }),
      Tab: ev({ key: 'Tab' }),
      'Shift-Tab': ev({ key: 'Tab', shiftKey: true }),
      Backspace: ev({ key: 'Backspace' }),
      Delete: ev({ key: 'Delete' }),
      End: ev({ key: 'End' }),
      F1: ev({ key: 'F1' }),
      F3: ev({ key: 'F3' }),
      F12: ev({ key: 'F12' }),
      'Shift-F1': ev({ key: 'F1', shiftKey: true }),
      Up: ev({ key: 'ArrowUp' }),
      Down: ev({ key: 'ArrowDown' }),
      Left: ev({ key: 'ArrowLeft' }),
      Right: ev({ key: 'ArrowRight' }),
      Home: ev({ key: 'Home' }),
      'Alt-1': ev({ key: '1', code: 'Digit1', altKey: true }),
      'Alt-2': ev({ key: '2', code: 'Digit2', altKey: true }),
      'Alt-3': ev({ key: '3', code: 'Digit3', altKey: true }),
      'Ctrl-A': ev({ key: 'a', code: 'KeyA', ctrlKey: true }),
      Insert: ev({ key: 'Insert', code: 'Insert' }),
      // The keypad-era three. Spelled as the CTRL chord in every case, including Ctrl-K: the
      // table names ONE key per action, and the canvas front ends' extra Alt-K is an addition
      // this loop cannot express. It is asserted directly in 'the keypad toggle' below.
      'Ctrl-D': ev({ key: 'd', code: 'KeyD', ctrlKey: true }),
      'Ctrl-F': ev({ key: 'f', code: 'KeyF', ctrlKey: true }),
      'Ctrl-K': ev({ key: 'k', code: 'KeyK', ctrlKey: true }),
      // Ctrl-B, the full keyboard, 2026-10-22. Its BINDING_INTENT row gives NO `terminal`
      // sequence, because the TUI has no such surface -- but this mapper is a CANVAS front end's
      // and must name it, which is exactly what this loop is for.
      'Ctrl-B': ev({ key: 'b', code: 'KeyB', ctrlKey: true }),
      // Ctrl-T joins them: the GUI now HAS the dialog, so the exemption below is gone and this
      // chord is checked against `BINDING_INTENT` like every other.
      'Ctrl-T': ev({ key: 't', code: 'KeyT', ctrlKey: true }),
      // Ctrl-Shift-C, the copy gesture, 2026-10-27. Spelled with SHIFT and on `code`, which is
      // what distinguishes it from the 'Ctrl-C' row above: both rows would otherwise be the same
      // keystroke, since the CTRL lookup is case-folded. Its macOS pair Cmd-Shift-C is the extra
      // this loop cannot express -- the table names one key per action -- and is asserted in
      // 'maps Ctrl-Shift-C and Cmd-Shift-C to a copy REQUEST', exactly as Alt-K is.
      'Ctrl-Shift-C': ev({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
    };
    // key -> why the GUI cannot express it. A RECORD, not a list, so an exemption without a
    // written reason does not type-check. The hole this replaced was exactly an unexamined
    // one-line dismissal ("Alt-1, a terminal-only spelling" -- it is not), so "you must say
    // why" is enforced by the shape rather than by a comment asking nicely. NO LONGER EMPTY.
    // NOW EMPTY AGAIN, and `Ctrl-T` is why. Its exemption said in as many words that it "SHOULD BE
    // DELETED when that lands", so this is that deletion: the GUI has a transfer window, `keys.ts`
    // maps the chord, and `checked` goes back up by one -- which is the mechanism that stopped the
    // exemption being forgotten silently. The entry had become actively WRONG rather than merely
    // stale: it claimed the canvas front ends had nowhere to put the form, and for one commit
    // between Task 7's window and this fix the GUI had the window and not the keystroke.
    const TERMINAL_ONLY: Readonly<Record<string, string>> = {};
    let checked = 0;
    for (const b of BINDING_INTENT) {
      const key = named[b.key];
      if (key === undefined) {
        expect(Object.hasOwn(TERMINAL_ONLY, b.key), `BINDING_INTENT has ${b.key} and the GUI does not`)
          .toBe(true);
        continue;
      }
      expect(actionForKey(key), b.key).toEqual(b.action);
      checked++;
    }
    // NOT redundant with the allowlist above: that check only runs when named[b.key] is
    // undefined, so it can never notice a STALE TERMINAL_ONLY entry -- one that claims a key
    // is unmappable when `named` actually has it, which the loop would otherwise validate and
    // count without complaint. This line catches exactly that mismatch (verified by mutation:
    // listing an already-mapped key as exempt makes `checked` come in one HIGHER than this
    // formula expects, and the allowlist check never even looks at it, since named[b.key] is
    // defined). It does NOT catch a key vanishing from BINDING_INTENT itself -- also verified
    // by mutation -- because the loop walks that same array, so both sides shrink together;
    // that is not this test's job. Still exact rather than a floor: with TERMINAL_ONLY empty,
    // every entry must be checked, and a floor would silently tolerate a wrongly-exempted one.
    expect(checked).toBe(BINDING_INTENT.length - Object.keys(TERMINAL_ONLY).length);
  });
});

describe('the keys the GUI could not reach at all', () => {
  it('maps Alt+digit to PA1-3', () => {
    expect(actionForKey(ev({ key: '1', code: 'Digit1', altKey: true })))
      .toEqual({ kind: 'pa', n: 1 });
    expect(actionForKey(ev({ key: '2', code: 'Digit2', altKey: true })))
      .toEqual({ kind: 'pa', n: 2 });
    expect(actionForKey(ev({ key: '3', code: 'Digit3', altKey: true })))
      .toEqual({ kind: 'pa', n: 3 });
  });

  it('matches on e.code, because macOS Option-1 reports key "¡"', () => {
    // THE trap on the reporter's machine. An e.key-based binding works on Linux and
    // silently fails on a Mac, which is the worst of both.
    expect(actionForKey(ev({ key: '¡', code: 'Digit1', altKey: true })))
      .toEqual({ kind: 'pa', n: 1 });
    expect(actionForKey(ev({ key: '™', code: 'Digit2', altKey: true })))
      .toEqual({ kind: 'pa', n: 2 });
  });

  it('does not turn Alt+other into a PA or into text', () => {
    expect(actionForKey(ev({ key: '4', code: 'Digit4', altKey: true }))).toBeNull();
    expect(actionForKey(ev({ key: 'f', code: 'KeyF', altKey: true }))).toBeNull();
  });

  it('types the character an AltGr layout puts behind an Alt chord', () => {
    // THE BUG THIS DESCRIBES: on a German, Spanish or Nordic layout `{` is AltGr+7 and `}`
    // is AltGr+0 -- and `[`, `]`, `@`, `\`, `~` are AltGr chords too. The Alt branch above
    // returned null for every one of them, so a whole class of layout could not type a
    // brace into a field at all. Invisible to every test here before this one, because they
    // were all written on a US layout where `{` is Shift+[.
    //
    // AltGraph is the discriminator, NOT altKey: `getModifierState('AltGraph')` is true for
    // Windows AltGr and for macOS Option (MDN, KeyboardEvent.getModifierState), which is
    // exactly the set of events that carry a layout character. Windows reports AltGr as
    // ctrlKey+altKey, so the plain `altKey` test cannot tell it from a real Ctrl-Alt chord.
    const altGraph = (init: Partial<KeyLike> & { key: string }): KeyLike =>
      ({ ...ev(init), getModifierState: (m: string) => m === 'AltGraph' });

    // Windows DE: AltGr reports as ctrlKey + altKey.
    expect(actionForKey(altGraph({ key: '{', code: 'Digit7', altKey: true, ctrlKey: true })))
      .toEqual({ kind: 'type', text: '{' });
    expect(actionForKey(altGraph({ key: '}', code: 'Digit0', altKey: true, ctrlKey: true })))
      .toEqual({ kind: 'type', text: '}' });
    expect(actionForKey(altGraph({ key: '@', code: 'KeyQ', altKey: true, ctrlKey: true })))
      .toEqual({ kind: 'type', text: '@' });
    // macOS DE: Option alone.
    expect(actionForKey(altGraph({ key: '{', code: 'Digit8', altKey: true })))
      .toEqual({ kind: 'type', text: '{' });
    expect(actionForKey(altGraph({ key: '}', code: 'Digit9', altKey: true })))
      .toEqual({ kind: 'type', text: '}' });
  });

  it('still sends PA1 and the keypad toggle on a MAC, where Option sets AltGraph too', () => {
    // THE REGRESSION THE FIRST VERSION OF THIS FIX SHIPPED, caught by driving the built
    // module rather than by this file: macOS sets AltGraph for Option (MDN), so an
    // AltGraph-first branch made Option-1 type "¡" instead of sending PA1, and Option-K type
    // "˚" instead of toggling the keypad. Exactly the Linux-passes/Mac-breaks shape that the
    // note on KeyLike.code exists to warn about.
    //
    // This is why layoutCharacter is a FALLBACK: bindings are matched first, and only a
    // keystroke no binding claimed is reconsidered as a character.
    const macOption = (init: Partial<KeyLike> & { key: string }): KeyLike =>
      ({ ...ev(init), getModifierState: (m: string) => m === 'AltGraph' });

    expect(actionForKey(macOption({ key: '¡', code: 'Digit1', altKey: true })))
      .toEqual({ kind: 'pa', n: 1 });
    expect(actionForKey(macOption({ key: '™', code: 'Digit2', altKey: true })))
      .toEqual({ kind: 'pa', n: 2 });
    expect(actionForKey(macOption({ key: '˚', code: 'KeyK', altKey: true })))
      .toEqual({ kind: 'toggleKeypad' });
    // Option-Shift-K as well, since c3270 binds both cases.
    expect(actionForKey(macOption({ key: '', code: 'KeyK', altKey: true, shiftKey: true })))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('still honors the PA keys and Alt-K when AltGraph is NOT set', () => {
    // The regression this guards: AltGr is a layout shift, Alt+digit is a PA key, and both
    // arrive with altKey set. Only AltGraph separates them, so the PA keys must keep working
    // for a plain Alt chord -- these are the same assertions as above, restated here because
    // the AltGraph branch is new code in front of them.
    expect(actionForKey(ev({ key: '1', code: 'Digit1', altKey: true })))
      .toEqual({ kind: 'pa', n: 1 });
    expect(actionForKey(ev({ key: 'k', code: 'KeyK', altKey: true })))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('does not type a multi-character key name just because AltGraph is set', () => {
    // A dead key reports `key: 'Dead'` and a function key `key: 'F5'`; with AltGraph held
    // those must not become typed text. The single-code-point rule is what prevents it.
    const altGraph = (init: Partial<KeyLike> & { key: string }): KeyLike =>
      ({ ...ev(init), getModifierState: (m: string) => m === 'AltGraph' });
    expect(actionForKey(altGraph({ key: 'Dead', code: 'BracketLeft', altKey: true }))).toBeNull();
    expect(actionForKey(altGraph({ key: 'F5', code: 'F5', altKey: true }))).toBeNull();
    // A bare AltGraph keypress is still a modifier and still types nothing.
    expect(actionForKey(altGraph({ key: 'AltGraph', code: 'AltRight', altKey: true }))).toBeNull();
  });

  it('keeps Ctrl chords working, and does not let a Ctrl-Alt chord type a letter', () => {
    // Without AltGraph set, Ctrl+Alt is not a layout shift. It must stay null rather than
    // typing, which is what the pre-existing Alt bail did for it.
    expect(actionForKey(ev({ key: 'f', code: 'KeyF', altKey: true, ctrlKey: true }))).toBeNull();
    // And a plain Ctrl chord is untouched by any of this.
    expect(actionForKey(ev({ key: 'c', code: 'KeyC', ctrlKey: true }))).toEqual({ kind: 'clear' });
  });

  it('leaves Cmd-digit alone, because that is where menu accelerators live', () => {
    // The reporter has left-Option mapped to Command at the OS level, so this arrives as a
    // metaKey chord. Binding it would collide with the menus on the roadmap.
    expect(actionForKey(ev({ key: '1', code: 'Digit1', metaKey: true }))).toBeNull();
  });

  it('maps Ctrl-A to Attn and Insert to the insert toggle', () => {
    expect(actionForKey(ev({ key: 'a', code: 'KeyA', ctrlKey: true })))
      .toEqual({ kind: 'attn' });
    expect(actionForKey(ev({ key: 'Insert', code: 'Insert' })))
      .toEqual({ kind: 'toggleInsert' });
  });
});

describe('the keypad toggle', () => {
  it('is Ctrl-K', () => {
    // c3270's own terminal binding (Common/fb-c3270:191), and the one the TUI uses too.
    expect(actionForKey({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('is ALSO Alt-K, which is what c3270 uses on Windows', () => {
    // Common/fb-c3270:48-49. A terminal could not honor that without going down the ESC
    // path; a real KeyboardEvent carries no such ambiguity, so both work here.
    expect(actionForKey({ key: 'k', code: 'KeyK', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'toggleKeypad' });
    // Alt-Shift-K too, as c3270 binds both `k` and `K`.
    expect(actionForKey({ key: 'K', code: 'KeyK', ctrlKey: false, altKey: true, metaKey: false, shiftKey: true }))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('matches Alt-K on e.code, because macOS Option-K reports key "˚"', () => {
    // THE SAME TRAP as Option-1 reporting "¡", one row up in this file. The plan for this task
    // asked for `e.key.toLowerCase() === 'k'`, which works on Linux, fails on a Mac and passes
    // every test written on Linux -- the precise defect that left the PA keys unreachable.
    expect(actionForKey({ key: '˚', code: 'KeyK', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'toggleKeypad' });
  });

  it('does not fire on Alt+digit, which is still a PA key', () => {
    // The Alt branch gained a case; the keys already in it must be untouched by it.
    expect(actionForKey({ key: '1', code: 'Digit1', ctrlKey: false, altKey: true, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'pa', n: 1 });
  });

  it('leaves Cmd-K and Ctrl-Alt-K to the window, as it does every other chord', () => {
    // The `!metaKey`/`!ctrlKey` guards on both branches. Cmd-K is where menu accelerators
    // live, and neither branch may claim a chord the other half-matches.
    expect(actionForKey({ key: 'k', code: 'KeyK', ctrlKey: false, altKey: false, metaKey: true, shiftKey: false }))
      .toBeNull();
    expect(actionForKey({ key: 'k', code: 'KeyK', ctrlKey: true, altKey: true, metaKey: false, shiftKey: false }))
      .toBeNull();
  });

  it('maps Ctrl-D and Ctrl-F the same way the terminal does', () => {
    // Common/fb-c3270:186-187. Written out one per line, not looped over a pair table, so a
    // dup/fieldMark transposition in `CTRL` reddens both with the key named.
    expect(actionForKey({ key: 'd', code: 'KeyD', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'dup' });
    expect(actionForKey({ key: 'f', code: 'KeyF', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }))
      .toEqual({ kind: 'fieldMark' });
  });
});
