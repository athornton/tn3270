/**
 * Which keys the virtual keypad and the TUI overlay offer, as DATA.
 *
 * ## ONE TABLE, TWO FRONT-END FAMILIES
 *
 * This lives in `frontend` because both package graphs reach it: `canvas` already imports from
 * here (`canvas/src/keys.ts:1` takes `Action`, `canvas/src/drawlist.ts:46` takes `schemeRgb`), and
 * so the Electron GUI and the web gateway get it; `tui` imports from here too. A copy in `canvas`
 * would be out of the TUI's reach, and two lists of 47 keys drift silently.
 *
 * Nothing here is geometry in PIXELS and nothing here draws: `row` and `col` are in CELLS, and
 * `canvas/src/keypad.ts` owns the cells-to-pixels arithmetic and the button rectangles.
 *
 * ## WHERE THE KEY SET COMES FROM
 *
 * c3270 ships a character-cell keypad, and its callback table is the authoritative list of what a
 * 3270 keypad is expected to carry: `Common/c3270/keypad.callbacks:1-44` is exactly PA1-3, Attn,
 * Erase EOF, Erase Input, Sys Req, Clear, Home, Cursor Select, Compose, Insert, Delete, Dup,
 * Field Mark, Tab, Reset, Back Tab, Newline, Enter and PF1-24 -- 44 keys. This table is that set
 * with two dropped and five added: 44 - 2 + 5 = 47.
 *
 * **Dropped by decision.** *Cursor Select*: `AID.SELECT` exists, but the key needs the
 * field-intensity parse and belongs with the light-pen work. *Compose*: it is x3270's own input
 * method, not a 3270 key. Those two are now the whole of it: the arithmetic above read `44 - 3 + 5
 * = 46` while Newline was the third dropped key, and it is dropped no longer.
 *
 * **Newline is HERE, and it was the branch's one open question.** It is on c3270's keypad,
 * `Keyboard.newline()` has existed in core (`core/src/keyboard.ts:348`) and the CLI could already
 * call it as `Newline()` (the `Newline` case in `cli/src/runner.ts`) -- but no interactive front end could reach it,
 * and this table inherited its absence from a spec that dropped it without noticing. That is the
 * same shape as `Session.sysreq()` before this branch: a capability with no interactive route,
 * which is precisely what this feature exists to fix, so its absence was never a decision like the
 * two above. Raised with the user 2026-09-16 and decided by them: add it. Row 4 ended at column 36
 * with `BkSp`, so it takes column 42 for a right edge of 48, well inside 72 and needing no new row
 * -- which is why the Electron window does not resize and only the keypad golden moved.
 *
 * **It has NO CHORD, in any front end.** c3270 binds Ctrl-J (`Common/fb-c3270:190`, and `:100` in
 * its _WIN32 keymap), and Ctrl-J is `\n` -- already `enter` in the terminal keymap, for terminals
 * that send LF for Return. See the note on the `newline` member of the `Action` union in
 * `keymap.ts`, and the user's 2026-09-14 call recorded there. So the keypad button and the TUI
 * overlay ARE its keyboard route, and its chord column in the overlay is deliberately blank --
 * exactly as Sys Req's is, and for a documented reason rather than an omission.
 *
 * **Added.** The four cursor arrows and Backspace. c3270's keypad has none of these -- there are
 * no cursor callbacks in `keypad.callbacks`, and the arrow glyphs its layout draws are Tab, Back
 * Tab and Newline (`Common/c3270/keypad.full:8-11`), not cursor keys. c3270 can leave them out
 * because it is driven from a real keyboard that has them; a keypad that can be driven by MOUSE
 * ALONE cannot, or a mouse user could never move the cursor.
 *
 * That same misreading is why `NewLn` is LETTERS: the glyph c3270 draws for Newline is `<-+`, which
 * this table's first version took for a cursor arrow. Every label here is an abbreviation in words
 * -- `ErEOF`, `BkTab`, `FldMk`, `SysRq` -- so `NewLn` is the house style, and `NL` would be the one
 * label a reader has to be told the meaning of. Both fit the 5-character limit; this one is legible.
 *
 * No typewriter keys, though: a keypad earns its space by offering what a PC keyboard lacks, and a
 * clickable QWERTY would duplicate the hardware and eat the area the 3270 display needs.
 *
 * ## WHERE THE ARRANGEMENT COMES FROM
 *
 * A 122-key tn327x keyboard, in the way that matters for muscle memory: PF keys in a 2x12 block
 * across the top, modal keys in a left-hand cluster, cursor and edit keys on the right. PF13-24
 * sits ABOVE PF1-12, which is c3270's order too (`Common/c3270/keypad.labels:2` and `:4`).
 *
 * The TUI overlay ignores `row` and `col` and lists the keys in table order.
 */

import type { Action } from './keymap.js';

export interface KeypadKey {
  /** At most 5 characters: see the test. Longer labels overflow into the next key. */
  readonly label: string;
  /**
   * Never `quit` or `toggleKeypad`. `applyAction` throws on both, so a button for either would be
   * a button whose only effect is to throw -- and `applyAction`'s swallow would hide it. See the
   * note on `toggleKeypad` in keymap.ts, and the test that pins it.
   */
  readonly action: Action;
  /** For the TUI overlay and for accessibility: what this key is called in words. */
  readonly name: string;
}

const pfRow = (from: number): KeypadKey[] => Array.from({ length: 12 }, (_, i) => ({
  label: `PF${from + i}`,
  action: { kind: 'pf', n: from + i },
  name: `PF${from + i}`,
}));

export const KEYPAD_KEYS: readonly KeypadKey[] = Object.freeze([
  ...pfRow(13),
  ...pfRow(1),

  { label: 'PA1', action: { kind: 'pa', n: 1 }, name: 'PA1' },
  { label: 'PA2', action: { kind: 'pa', n: 2 }, name: 'PA2' },
  { label: 'PA3', action: { kind: 'pa', n: 3 }, name: 'PA3' },
  { label: 'Home', action: { kind: 'home' }, name: 'Home' },
  { label: '^', action: { kind: 'up' }, name: 'Cursor up' },
  { label: 'Ins', action: { kind: 'toggleInsert' }, name: 'Insert mode' },
  { label: 'Dup', action: { kind: 'dup' }, name: 'Dup' },
  { label: 'Reset', action: { kind: 'reset' }, name: 'Reset' },

  { label: 'Attn', action: { kind: 'attn' }, name: 'Attention' },
  { label: 'SysRq', action: { kind: 'sysreq' }, name: 'System Request' },
  { label: 'Clear', action: { kind: 'clear' }, name: 'Clear' },
  { label: '<', action: { kind: 'left' }, name: 'Cursor left' },
  { label: 'v', action: { kind: 'down' }, name: 'Cursor down' },
  { label: '>', action: { kind: 'right' }, name: 'Cursor right' },
  { label: 'FldMk', action: { kind: 'fieldMark' }, name: 'Field Mark' },
  { label: 'Enter', action: { kind: 'enter' }, name: 'Enter' },

  { label: 'ErEOF', action: { kind: 'eraseEOF' }, name: 'Erase EOF' },
  { label: 'ErInp', action: { kind: 'eraseInput' }, name: 'Erase Input' },
  { label: 'Tab', action: { kind: 'tab' }, name: 'Tab' },
  { label: 'BkTab', action: { kind: 'backTab' }, name: 'Back Tab' },
  { label: 'Del', action: { kind: 'delete' }, name: 'Delete' },
  { label: 'BkSp', action: { kind: 'backspace' }, name: 'Backspace' },
  // The 47th key, and the only one on this row past `BkSp`: row 4 ended at column 36, so this
  // takes 42 for a right edge of 48 -- inside 72, and NO NEW ROW, which is what keeps the Electron
  // window the same size and leaves the two non-keypad goldens byte-identical.
  { label: 'NewLn', action: { kind: 'newline' }, name: 'Newline' },
  // The 48th key, and the FIRST whose action `applyAction` throws on -- see the note on
  // `KeypadKey.action`, which this key made it necessary to rewrite. A transfer needs arguments,
  // so the button opens a form; the front end intercepts it exactly as it intercepts Ctrl-T.
  //
  // `NewLn` ended at 48, so this takes 48 for a right edge of 54 -- still inside 72 and still NO
  // NEW ROW, so the Electron window keeps its size and only the keypad golden moves. The gap at
  // column 18 is NOT free space: it separates the Tab/BkTab clusters deliberately.
  { label: 'Xfer', action: { kind: 'transferForm' }, name: 'File Transfer' },
]);
