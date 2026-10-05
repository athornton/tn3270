/**
 * The 48 keys of `KEYPAD_KEYS` grouped for a DOM layout.
 *
 * ## WHY A SECOND GROUPING RATHER THAN `KeypadKey.row`/`col`
 *
 * Those two are CELL COORDINATES for a blitter. `KeypadKey.col` is a left edge in character
 * cells, `KEYPAD_KEY_WIDTH` cells per key (6, so twelve of them span 72 and fit inside an
 * 80-column screen -- `keypad.ts`'s own note on the constant), and `row` is an index into
 * `canvas/src/keypad.ts`'s `DRAWN_ROW` = `[0, 2, 4, 6, 8]`, which spreads the five table rows
 * over nine drawn ones so that no two buttons touch vertically. Both numbers exist to satisfy a
 * character grid that a DOM layout does not have: there is no column budget, and the blank
 * separator row exists because a one-cell-tall inverse-video button would otherwise merge into
 * the one above it (measured, same file) -- a problem CSS does not have either.
 *
 * Read the other way round, the cell coordinates ENCODE the clusters without naming them -- the
 * gap at column 18 on rows 2-4 "is NOT free space: it separates the Tab/BkTab clusters
 * deliberately" (`keypad.ts`, on `Xfer`). This file names what those gaps mean, so a reader does
 * not have to reconstruct the intent from column numbers, and so the blocks survive the deletion
 * of the canvas keypad that Task 9 of this feature performs.
 *
 * `row`/`col` are LEFT ALONE on `KeypadKey`, neither deleted nor annotated: `canvas/src/keypad.ts`
 * still reads both and is still shipping, so they are live fields, not legacy ones. They become
 * dead only when that file is deleted, and deleting fields from a 48-row table in the same change
 * that rewrites two front ends mixes two risks. (The plan's draft of this header called them
 * "marked deprecated"; nothing in `keypad.ts` says that, and saying it here would have been a
 * comment describing a state of the code that does not exist.)
 *
 * ## THE GROUPING IS WRITTEN DOWN, NOT DERIVED
 *
 * Deriving blocks from `col` gaps would make this agree with the canvas layout by construction,
 * and so unable to disagree -- the same argument `KEYPAD_ROWS` already makes for itself in
 * `keypad.ts`. It would also tie a DOM layout to a table that Task 9 is about to stop being the
 * authority on. Written down, a key that falls out of every block is a test failure, and a key
 * in two blocks is a test failure too -- see `keypadView.test.ts`, whose first case is the whole
 * protection against a dropped or doubled button.
 *
 * The blocks are therefore ALLOWED to disagree with the canvas rows, and they deliberately do.
 * The canvas has `Reset` at row 2 column 60 and `Enter` at row 3 column 60 -- a right-hand column
 * holding two keys with nothing in common but their column -- and `Xfer` at row 4 column 48,
 * placed there because, in its own note's words, `NewLn` "ended at 48, so this takes 48 ... still
 * inside 72 and still NO NEW ROW". That is a column budget talking, not a grouping. Here `Reset`
 * joins the modal keys whose state it clears, and `Enter`/`Xfer` get a block of their own.
 *
 * ## NO DOM, NO ELECTRON
 *
 * Pure data and pure functions, for the same reason `transferForm.ts` is: `vitest.config.ts` sets
 * `environment: 'node'`, there is no `document` in any test in this repo and jsdom is not a
 * dependency. Everything worth testing about the grouping is testable without an element. The
 * views that consume this (the GUI's keypad window, the web gateway's overlay) take their DOM
 * injected.
 */

import { KEYPAD_KEYS, type KeypadKey } from './keypad.js';

export interface KeypadBlock {
  /**
   * Stable identifier, used as a DOM id suffix and in tests. Lowercase and hyphenated because it
   * ends up in an `id` attribute and in a CSS selector.
   */
  readonly id: string;
  /** Visible heading, in words, shown above the block's buttons. */
  readonly title: string;
  readonly keys: readonly KeypadKey[];
}

/**
 * The one key with this label, or a throw.
 *
 * THROWS RATHER THAN SKIPS. A typo'd label here would otherwise silently drop a button from the
 * window, and the test's "exactly once" case would report it as a count mismatch somewhere in a
 * flattened list of 48 rather than at the typo. For `SysRq` and `NewLn` a dropped button is worse
 * than cosmetic: those two have NO chord in ANY front end -- `keymap.ts` records "Sys Req gets NO
 * chord: c3270 defines none in either keymap", and `keypad.ts` records the same for Newline, whose
 * c3270 chord Ctrl-J is already `enter` in the terminal keymap -- so the keypad button and the
 * TUI overlay are their only interactive route at all.
 *
 * `Dup` and `FldMk` are often listed with those two (the spec's "four otherwise-unreachable
 * keys"), but they are not in the same position TODAY: both have Ctrl-D/Ctrl-F in the terminal
 * keymap (`keymap.ts:190-191`, from `Common/fb-c3270:186-187`) and in the GUI/web key mapper
 * (`canvas/src/keys.ts:77-78`). Losing their button would cost them the mouse, not the keyboard.
 */
const byLabel = (label: string): KeypadKey => {
  const key = KEYPAD_KEYS.find((k) => k.label === label);
  if (key === undefined) throw new Error(`no keypad key labelled ${label}`);
  return key;
};

/** Twelve consecutive PF keys, by label, so a renumbering of the table cannot reorder them. */
const pfRange = (from: number): readonly KeypadKey[] =>
  Array.from({ length: 12 }, (_, i) => byLabel(`PF${from + i}`));

export const KEYPAD_BLOCKS: readonly KeypadBlock[] = Object.freeze([
  // PF13-24 ABOVE PF1-12. That is `KEYPAD_KEYS`' own order -- it opens `pfRow(0, 13)` then
  // `pfRow(1, 1)` -- and its header cites c3270 for the same arrangement
  // (`Common/c3270/keypad.labels:2` and `:4`). Reversing it here would be a silent relearn for
  // anyone used to the shipped keypad, which is why the test pins the first label of each row
  // rather than just the count.
  { id: 'pf-high', title: 'PF13-24', keys: pfRange(13) },
  { id: 'pf-low', title: 'PF1-12', keys: pfRange(1) },
  {
    // The INTERRUPT keys: each one reaches the host OUTSIDE the ordinary read-modified exchange.
    // PA1-3 and Clear go as short-read AIDs; `SysRq` is Telnet IAC AO on a TN3270E session that
    // agreed the SYSREQ function and a TEST REQUEST READ on a classic one (`actions.ts:109-120`
    // records both forms); and `Attn` is TELNET BREAK.
    //
    // `Attn` IS `IAC BREAK` AND NOT `IAC IP`. Stated this loudly because the first version of
    // this comment said IP, and because the two are a real pair of Telnet commands that a reader
    // can plausibly swap. MEASURED: `Telnet.sendAttn()` is `Uint8Array.of(T.IAC, T.BREAK)` with
    // the trace label `'Attn (IAC BREAK)'` (`core/src/telnet.ts:225-230`), both it and
    // `Session.sendAttn()` (`core/src/session.ts:1616`) carry the docstring "The 3270 Attn key is
    // Telnet BREAK (RFC 1576 §8), not an AID", three tests assert the exact two bytes
    // (`core/test/telnet.test.ts:448`, `core/test/session.test.ts:493`,
    // `cli/test/runner.test.ts:373`) and a fourth pins that it never reaches `sendAID`
    // (`frontend/test/actions.test.ts:119`), and `T.IP` is
    // referenced NOWHERE in this repository (`grep -rn 'T\.IP\b' packages/*/src` -> no hits).
    // x3270 draws the same distinction: `Attn_action` calls `net_break` for `{IAC, BREAK}`, while
    // `IAC IP` is `net_interrupt` behind a SEPARATE `Interrupt()` action this project does not
    // implement. So IP is not a loose synonym here; it is a different command backing a different
    // key. `actions.ts:108` is a bare `case 'attn': session.sendAttn(); break;` with no wire note,
    // which is why the citation for this half points at core and not at the dispatch.
    //
    // None of the six is the ordinary "submit this screen" that `Enter` is, which is why `Enter`
    // is not in this block despite also being an AID. `Reset` is the odd one, and it is here
    // deliberately: `Keyboard.reset()` (`core/src/keyboard.ts:434`) only calls `oia.reset()`, and
    // the input-inhibit state it clears is the state a host error and the AID keys leave you in.
    //
    // THAT IS AN AFFINITY, NOT A RULE, and the stronger version of it is false: `Enter` and all
    // 24 PF keys raise `SystemWait` through the same `sendAID` path from OTHER blocks
    // (`session.ts:1553`), the three operator-error inhibits come from typing into a protected or
    // numeric field rather than from any key here, and `Attn` -- which IS in this block -- does
    // not touch the OIA at all (`session.ts:1617-1620` goes straight to the Telnet layer). Reset
    // is grouped with the keys whose kind of trouble it answers; it is not claimed that this
    // block is the only way to need it.
    id: 'attention',
    title: 'Attention',
    keys: ['PA1', 'PA2', 'PA3', 'Attn', 'SysRq', 'Clear', 'Reset'].map(byLabel),
  },
  {
    // Everything that MOVES THE CURSOR without altering the buffer. `NewLn` is a cursor move in
    // 3270 terms and nothing else: `Keyboard.newline()` (`core/src/keyboard.ts:348`) is documented
    // "first unprotected cell at or after the start of the next line" and its whole body assigns
    // `s.cursor`. It belongs here, not beside `Enter`, which its name invites a reader to assume.
    //
    // The four arrows are `^ v < >` because that is what `KEYPAD_KEYS` labels them, and the
    // labels are the button text. `keypad.ts` records why they exist at all: c3270's keypad has
    // no cursor callbacks, but a keypad drivable by MOUSE ALONE needs them or a mouse user could
    // never move the cursor -- which is exactly the DOM keypad's case too.
    id: 'cursor',
    title: 'Cursor',
    keys: ['Home', '^', 'v', '<', '>', 'Tab', 'BkTab', 'NewLn'].map(byLabel),
  },
  {
    // Everything that CHANGES THE BUFFER locally, with no transmission to the host. `Dup` and
    // `FldMk` are here because they are TYPED CHARACTERS and not AIDs -- see the note on the
    // `Action` union in `keymap.ts` -- so a user hunting them under "Attention" beside PA1 would
    // be looking in the wrong place.
    //
    // `Ins` toggles a mode rather than editing, and it is the mode that decides what `Dup` and
    // `FldMk` write into -- the only two keys here that go through `writeControl`
    // (`core/src/keyboard.ts:127` and `:165`). NOT "what every other key in this block does",
    // which an earlier draft of this comment claimed: `insertMode` is read in exactly two places,
    // `type()` (`keyboard.ts:74`) and `writeControl()` (`:223`), and `Del` (`:413`), `BkSp`
    // (`:398`), `ErEOF` (`:369`) and `ErInp` (`:393`) never read it. Four of the six are
    // unaffected by the toggle, so `Ins` earns its place here by editing the buffer like the
    // rest and not by governing them.
    id: 'editing',
    title: 'Editing',
    keys: ['Ins', 'Del', 'BkSp', 'ErEOF', 'ErInp', 'Dup', 'FldMk'].map(byLabel),
  },
  {
    // The two keys that SUBMIT OR START SOMETHING: `Enter` transmits the modified fields, `Xfer`
    // starts a file transfer. Both reach the host, neither is an interrupt, which is what keeps
    // them out of the `attention` block.
    //
    // `Xfer` IS THE ONE KEY IN THIS TABLE WHOSE ACTION `applyAction` REFUSES -- `actions.ts:57`,
    // "applyAction does not handle transferForm: the front end owns its own dialog" -- so a
    // button wired straight through to `applyAction` is a button that only throws. Whoever
    // renders this block must give it the same treatment that front end already gives Ctrl-T,
    // and THAT DIFFERS BY FRONT END rather than being one rule: the Electron GUI opens a
    // window (`gui/src/main.ts:924`) and the TUI opens an overlay (`tui/src/app.ts:672`), but
    // the web gateway deliberately REJECTS it with an error frame naming the kind
    // (`web/src/protocol.ts:146`), because a browser-initiated transfer would write to the
    // gateway's filesystem and not the operator's. The web keypad therefore still shows the
    // button -- the rejection is the feedback, and `protocol.ts` says so in as many words.
    id: 'send',
    title: 'Send',
    keys: ['Enter', 'Xfer'].map(byLabel),
  },
]);
