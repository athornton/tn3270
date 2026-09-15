import type { Action } from './keymap.js';

/**
 * Which key means which action, stated once in words.
 *
 * NOT A CODE GENERATOR, and deliberately so. The terminal keymap is a table of measured
 * byte sequences and the GUI's mapper will match Chromium `KeyboardEvent`s; deriving
 * either from this would mean re-expressing a live-verified table in a form nothing has
 * tested. What this gives instead is one place to read the INTENT, plus a test that the
 * terminal keymap agrees with it -- so a key added to one front end is visibly absent
 * from the other.
 *
 * `terminal` is the byte sequence the terminal keymap should return this action for, or
 * `undefined` where the binding is GUI-only or where the terminal encodes it in more
 * than one way. The arrows and Home have BOTH SS3 (`ESC O A`) and CSI (`ESC [ A`) forms
 * because any layer -- us, tmux, screen -- can flip DECCKM, so naming one of the two here
 * would assert less than `keymap.test.ts` already does and would imply the other is
 * wrong.
 *
 * Ctrl-C is Clear and NOT an interrupt, which is correct for a 3270 and surprising to
 * everyone: a 3270 user needs Clear constantly to dismiss VM's `MORE...` state. Ctrl-]
 * is therefore the way out, and every front end must say so on startup -- an
 * undocumented escape hatch is no escape hatch.
 */
export interface Binding {
  /** How a user would describe the key. */
  readonly key: string;
  readonly action: Action;
  /** The terminal byte sequence, where a single canonical one exists. */
  readonly terminal?: string;
  /** Why this binding, where it is not obvious. */
  readonly note?: string;
}

export const BINDING_INTENT: readonly Binding[] = Object.freeze([
  { key: 'Enter', action: { kind: 'enter' }, terminal: '\r' },
  {
    key: 'Ctrl-C', action: { kind: 'clear' }, terminal: '\x03',
    note: 'the Clear AID, not an interrupt: it dismisses VM\'s MORE... state',
  },
  {
    key: 'Ctrl-]', action: { kind: 'quit' }, terminal: '\x1d',
    note: 'the way out, because Ctrl-C is Clear. Say so on startup.',
  },
  { key: 'Ctrl-R', action: { kind: 'reset' }, terminal: '\x12' },
  { key: 'Ctrl-U', action: { kind: 'eraseInput' }, terminal: '\x15' },
  { key: 'Tab', action: { kind: 'tab' }, terminal: '\t' },
  { key: 'Shift-Tab', action: { kind: 'backTab' }, terminal: '\x1b[Z' },
  { key: 'Backspace', action: { kind: 'backspace' }, terminal: '\x7f' },
  { key: 'Delete', action: { kind: 'delete' }, terminal: '\x1b[3~' },
  {
    key: 'End', action: { kind: 'eraseEOF' }, terminal: '\x1b[4~',
    note: 'vt220 Select/End, bound to EraseEOF as a CHOICE following c3270 -- not a '
      + 'terminfo-derived mapping',
  },
  { key: 'F1', action: { kind: 'pf', n: 1 }, terminal: '\x1bOP' },
  { key: 'F3', action: { kind: 'pf', n: 3 }, terminal: '\x1bOR' },
  {
    key: 'F12', action: { kind: 'pf', n: 12 }, terminal: '\x1b[24~',
    note: 'the function keys are irregular: F7-F11 are 18/19/20/21/23~, with no 22~',
  },
  {
    key: 'Shift-F1', action: { kind: 'pf', n: 13 }, terminal: '\x1b[1;2P',
    note: 'Shift+F(n) is PF(n+12), the c3270 convention',
  },
  {
    key: 'Alt-1', action: { kind: 'pa', n: 1 }, terminal: '\x1b1',
    note: 'the PA keys have no terminal equivalent, so ESC-digit, as c3270 does. The GUI '
      + 'matches e.code (Digit1), NOT e.key: on macOS Option-1 reports key "¡".',
  },
  { key: 'Alt-2', action: { kind: 'pa', n: 2 }, terminal: '\x1b2' },
  { key: 'Alt-3', action: { kind: 'pa', n: 3 }, terminal: '\x1b3' },
  {
    key: 'Ctrl-A', action: { kind: 'attn' }, terminal: '\x01',
    note: 'c3270\'s own default (Common/fb-c3270:83). A Telnet BREAK, not an AID.',
  },
  {
    key: 'Insert', action: { kind: 'toggleInsert' }, terminal: '\x1b[2~',
    note: 'x3270\'s Toggle(insertMode) (fb-x3270:210); `tput kich1` measured \\x1b[2~',
  },

  // Sequence-less on purpose: two encodings each. See the header note on DECCKM.
  { key: 'Up', action: { kind: 'up' } },
  { key: 'Down', action: { kind: 'down' } },
  { key: 'Left', action: { kind: 'left' } },
  { key: 'Right', action: { kind: 'right' } },
  { key: 'Home', action: { kind: 'home' } },
]);
