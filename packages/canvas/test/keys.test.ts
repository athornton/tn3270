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
    };
    // key -> why the GUI cannot express it. A RECORD, not a list, so an exemption without a
    // written reason does not type-check. The hole this replaced was exactly an unexamined
    // one-line dismissal ("Alt-1, a terminal-only spelling" -- it is not), so "you must say
    // why" is enforced by the shape rather than by a comment asking nicely. EMPTY on purpose.
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
    // Common/fb-c3270:48-49. A terminal could not honour that without going down the ESC
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
