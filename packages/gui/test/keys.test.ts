import { describe, it, expect } from 'vitest';
import { BINDING_INTENT } from '@tn3270/frontend';
import { actionForKey, type KeyLike } from '../src/keys.js';

/** The subset of KeyboardEvent this maps on. Constructing a real one needs a DOM. */
const ev = (init: Partial<KeyLike> & { key: string }): KeyLike =>
  ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init });

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
    // other. Only the entries this mapper can express are checked -- the table also names
    // terminal-only spellings.
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
    };
    let checked = 0;
    for (const b of BINDING_INTENT) {
      const key = named[b.key];
      if (key === undefined) continue;      // e.g. Alt-1, a terminal-only spelling
      expect(actionForKey(key), b.key).toEqual(b.action);
      checked++;
    }
    // Guard against the loop silently checking nothing if a name is ever changed.
    expect(checked).toBeGreaterThanOrEqual(18);
  });
});
