import type { Action } from './keymap.js';

/**
 * The 122-key 3279 keyboard, as DATA.
 *
 * ## WHY A SECOND TABLE RATHER THAN AN EXTENSION OF `KEYPAD_KEYS`
 *
 * The two answer different questions. `KEYPAD_KEYS` is "which keys are hard to type" -- 48 entries,
 * consumed by all three front ends, and the TUI renders it as a name-and-chord LIST in a
 * 29-column overlay. This is "what does a 3279 keyboard look like" -- ~122 entries with real
 * geometry, consumed only by the two DOM front ends, because the TUI cannot draw a keyboard:
 * c3270's own keypad is 78 columns wide and that front end refuses to draw below 24x80. The user
 * said so directly when asking for this: "the TUI on the other hand is much more restrictive, so
 * I am not suggesting a full virtual keyboard for it."
 *
 * `keypadView.ts` set this precedent for the same reason -- `KEYPAD_KEYS`' cell coordinates were
 * the wrong model for a DOM layout -- and its header's argument applies here with more force: the
 * layout is WRITTEN DOWN, not derived, because deriving it would make it agree with itself by
 * construction and be unable to catch a change.
 *
 * ## THE GEOMETRY IS IN KEY UNITS, NOT PIXELS
 *
 * One unit is one standard cap. `Enter`, the spacebar and several others are wider, so a cap
 * carries `x` and `width` in units and the CSS multiplies by whatever pitch it picks. Pixels here
 * would freeze a font size into a data table.
 *
 * ## THE TRANSCRIPTION WAS AUDITED AND CORRECTED AGAINST A SECOND KEYBOARD
 *
 * **The user spotted the hole on 2026-10-22: "the keyboard picture is clearly missing the 0/) so
 * maybe some of the other keys are also supposed to have caps that have been lost."** They were
 * right, and the audit it triggered found FIVE wrong pairs plus one physically blank cap. They
 * then supplied a sharp photograph of an **IBM 4978** -- a different 122-key 3279 layout with the
 * same typewriter character set -- which settled every one.
 *
 * **WHAT WAS WRONG, because the pattern of error is the useful part:**
 *
 *  - **`6` carried a NOT SIGN; it is a CENT SIGN.** I read a blurred cap and then justified it
 *    with EBCDIC reasoning about the logical-not operator. The reasoning was sound and still
 *    produced the wrong glyph, because it explained a reading instead of testing one.
 *  - **The cap right of `P` carried `cent`/`!`; it is `!`/`NOT SIGN`.** So both glyphs were real
 *    and both were in the wrong places -- the most misleading kind of error, since each looked
 *    defensible alone.
 *  - **The home row's third cap carried `(`/`)`; it is `{`/`}`.** Flagged as suspect because it
 *    duplicated `9`/`0`.
 *  - **The bottom row carried `,`/`;` and `.`/`:`; they are `,`/`'` and `.`/`:`.** Flagged for
 *    duplicating the home row's `;`/`:`.
 *  - **`1` and `\` both claimed a solid `|`.** The backslash cap is a BROKEN bar (U+00A6), which
 *    EBCDIC distinguishes.
 *  - **`0`'s cap is genuinely BLANK on the first unit** -- no legend at all under maximum zoom,
 *    while `_`/`-` beside it is legible, so it is missing or worn smooth. `)` was inferred from
 *    the `9`/`(` pattern and the 4978 then confirmed it.
 *
 * **TWO LESSONS WORTH KEEPING.** First, a glyph pair appearing TWICE on one keyboard is a
 * reliable detector: it found three of the five. Second, **the detector's PREDICTIONS were
 * unreliable** -- the audit guessed `,`/`<` and `.`/`>` from PC-adjacent habit and was wrong, so
 * guessing at a correction would have shipped a second error that no longer smelled. Duplication
 * tells you WHERE to look, not WHAT the answer is.
 *
 * **STILL UNRESOLVED: five caps the first photograph could not resolve and the 4978 cannot
 * settle, because that keyboard's furniture differs** -- two glyphs flanking `Home` in the cursor
 * cluster, and three in the numeric pad's right-hand column. They remain INERT with `unread` in
 * their names, which a test enforces. The 4978 also has keys this layout lacks (a `~`/`\` cap, a
 * bullet over plus-minus, `LINE DUP`/`FIELD DUP`/`REP`), and NONE were transplanted: the two units
 * agree on the character set where both have a key, and that is exactly how far a cross-check
 * can be trusted.
 *
 * ## LEGENDS COME FROM THE PHOTOGRAPH, AND THIS IS NOT A PC KEYBOARD
 *
 * Transcribed from `s-l960.png`, an IBM 122-key terminal keyboard. It is the 3270 TYPEWRITER
 * layout: the number row reads `| @ # $ % not & * ( )` over `1`-`0`, so `6` carries a NOT SIGN
 * where a PC has `^`, and `1` carries `|` where a PC has `!`. **Never infer a legend from a PC
 * keyboard.** Where the photograph could not be resolved, the cap is INERT with its `name` set and
 * says so at the entry -- an invented legend on historical hardware is exactly the
 * plausible-but-wrong detail this project keeps catching.
 *
 * ## WHAT IS DELIBERATELY NOT HERE
 *
 * No `toggleKeypad`, `toggleKeyboard` or `quit` on any cap: `applyAction` throws on all three, so
 * a drawn button would be a button whose only effect is to throw -- and `toggleKeyboard`'s would
 * toggle the surface it is drawn on. Pinned by this table's own test.
 */

export const KEYBOARD_REGIONS = [
  'pf', 'special-left', 'main', 'cursor', 'numpad',
] as const;

export type KeyboardRegion = typeof KEYBOARD_REGIONS[number];

export interface KeyCap {
  /** What is printed on the cap, unshifted. `''` for a genuinely blank cap. */
  readonly label: string;
  /**
   * The shifted legend, on a dual-glyph cap only.
   *
   * ABSENT ON A LETTER, deliberately: `A` sends `A` unshifted on this keyboard, so a `shiftLabel`
   * of `A` would make Shift a no-op that still consumed its one-shot arm.
   */
  readonly shiftLabel?: string;
  /**
   * What the cap does, or `undefined` for an INERT cap -- a key that exists on the hardware and
   * will never do anything here.
   *
   * DRAWN RATHER THAN OMITTED, at the user's direction: a gap where `Esc` belongs is less honest
   * than a key that is plainly scenery. `ui.css` styles these in `GrayText` on a recessed cap
   * rather than with the house `opacity: 0.5`, and says there why.
   */
  readonly action?: Action | undefined;
  readonly region: KeyboardRegion;
  /** Row within the region, from 0 at the top. */
  readonly row: number;
  /** Left edge in KEY UNITS, within the region's row. */
  readonly x: number;
  /** Width in KEY UNITS. 1 is a standard cap. */
  readonly width: number;
  /** What this key is called in words: the tooltip, and the accessible name. */
  readonly name: string;
}

/**
 * A plain typed character.
 *
 * `{ kind: 'type' }` ALREADY EXISTS and is what the real-keyboard path produces
 * (`canvas/src/keys.ts`), so no new action kind was needed for any character cap -- which is most
 * of why this table was cheap to add.
 *
 * THE CONDITIONAL SPREAD IS REQUIRED, not stylistic: `exactOptionalPropertyTypes` is on in
 * `tsconfig.base.json`, under which `shiftLabel: undefined` does NOT satisfy `shiftLabel?: string`.
 */
const ch = (
  label: string, row: number, x: number, shiftLabel?: string,
): KeyCap => ({
  label,
  ...(shiftLabel === undefined ? {} : { shiftLabel }),
  action: { kind: 'type', text: label },
  region: 'main', row, x, width: 1,
  name: shiftLabel === undefined ? label : `${shiftLabel} ${label}`,
});

/** An inert cap: drawn, named, and does nothing. */
const dead = (
  label: string, region: KeyboardRegion, row: number, x: number, width: number, name: string,
): KeyCap => ({ label, action: undefined, region, row, x, width, name });

/**
 * The name BOTH Shift caps carry, and the way the view recognises them.
 *
 * ## SHIFT HAS NO `Action`, AND THAT IS THE DESIGN RATHER THAN A GAP
 *
 * It is PURE SURFACE STATE: arming it sends nothing to the host, nothing crosses the socket or the
 * IPC boundary, and the `Action` union needs no `shift` member. So its cap is INERT as far as this
 * table is concerned (`action: undefined`) and `canvas/src/keyboardUi.ts` gives it behaviour by
 * matching this exact name.
 *
 * MATCHED BY NAME RATHER THAN BY LABEL, because the left cap's printed legend in the photograph is
 * `>`/`<` rather than the word -- and because BOTH caps must drive the SAME one-shot state, neither
 * being distinguishable to us. `SHIFT_NAME` is exported so the view cannot drift from a string
 * literal typed twice.
 *
 * IT IS NOT STYLED AS AN INERT CAP even though `action` is `undefined`: the view sets
 * `data-shift="true"` on it, and `ui.css` keys the grey scenery style off `[disabled]`, which the
 * view does NOT set here. An inert cap and an actionable-but-actionless cap look different on
 * purpose.
 */
export const SHIFT_NAME = 'Shift';

const shift = (row: number, x: number, width: number, side: string): KeyCap => ({
  label: 'Shift',
  action: undefined,
  region: 'main', row, x, width,
  // The side is in the name for the tooltip and for a screen reader, but `keyboardUi.ts` matches
  // on the PREFIX, so both caps drive one state.
  name: `${SHIFT_NAME} (${side}, one-shot)`,
});

/** An actionable cap that is not a typed character. */
const key = (
  label: string, action: Action, region: KeyboardRegion,
  row: number, x: number, width: number, name: string,
): KeyCap => ({ label, action, region, row, x, width, name });

/** `PF13`-`PF24` on top, `PF1`-`PF12` below -- see the note at the `pf` block. */
const pfRow = (row: number, first: number): KeyCap[] => Array.from(
  { length: 12 },
  (_, i) => key(
    `PF${first + i}`, { kind: 'pf', n: first + i }, 'pf', row, i, 1, `PF${first + i}`,
  ),
);

/** One row of letters, evenly spaced from `x`. */
const letters = (text: string, row: number, x: number): KeyCap[] =>
  [...text].map((c, i) => ch(c, row, x + i));

export const KEYBOARD_3279: readonly KeyCap[] = Object.freeze([
  /*
    THE PF STRIP: PF13-24 ABOVE PF1-12.

    That is the hardware's order in the photograph, and it matches both `KEYPAD_KEYS` (which opens
    `pfRow(0, 13)` then `pfRow(1, 1)`) and c3270 (`Common/c3270/keypad.labels:2` and `:4`).
    Reversing it here would be a silent relearn for anyone used to either. The table's test pins
    the first label of each row rather than only the count, which is what catches that.
  */
  ...pfRow(0, 13),
  ...pfRow(1, 1),

  /*
    THE LEFT SPECIAL BAR: two columns, five rows.

    `Attn` and `Clear` are real 3270 keys and work. `Cursr Sel` is a real 3270 key that does NOT:
    `AID.SELECT` exists in core, but `keypad.ts` records the key as dropped by decision because it
    "needs the field-intensity parse and belongs with the light-pen work". It is drawn inert, and
    its tooltip is the place that says it is deferred rather than impossible.

    `Esc`, `Print Screen`, `Scroll Lock` and `Pause` are PC keys present on this 122-key unit and
    are not 3270 functions. They get no action because they SHOULD not have one.

    THE TWO BLANK CAPS AT THE BOTTOM carry `Xfer` and nothing. The user spotted them -- "since
    there are two unlabelled keys on the left hand special-key bar, one of those could get the
    `Xfer` label" -- and there is precedent: `KEYPAD_KEYS` already carries `Xfer` as a deliberate
    non-3270 addition, and `keypad.ts` argues a transfer button "is a perfectly sensible thing to
    click" even though `applyAction` throws on the kind, because the front end intercepts it
    exactly as it intercepts the chord.
  */
  key('Attn', { kind: 'attn' }, 'special-left', 0, 0, 1, 'Attention'),
  key('Clear', { kind: 'clear' }, 'special-left', 0, 1, 1, 'Clear'),
  dead('Cursr Sel', 'special-left', 1, 0, 1, 'Cursor Select (not implemented: light-pen work)'),
  dead('', 'special-left', 1, 1, 1, 'blank'),
  dead('Esc', 'special-left', 2, 0, 1, 'Escape (not a 3270 key)'),
  dead('Print Screen', 'special-left', 2, 1, 1, 'Print Screen (not a 3270 key)'),
  dead('Scroll Lock', 'special-left', 3, 0, 1, 'Scroll Lock (not a 3270 key)'),
  dead('Pause', 'special-left', 3, 1, 1, 'Pause (not a 3270 key)'),
  key('Xfer', { kind: 'transferForm' }, 'special-left', 4, 0, 1, 'File transfer'),
  dead('', 'special-left', 4, 1, 1, 'blank'),

  /*
    THE MAIN BLOCK, five rows.

    ROW 0, the number row: `| @ # $ % not & * ( )` over `1`-`0`, then `_`/`-`, `+`/`=`, Backspace.
    THE NOT SIGN ON 6 IS THE PROOF THIS IS A 3270 LAYOUT and not a PC one; a PC has `^` there.
    `1` carries `|`, where a PC has `!`.
  */
  ch('1', 0, 0, '|'),
  ch('2', 0, 1, '@'),
  ch('3', 0, 2, '#'),
  ch('4', 0, 3, '$'),
  ch('5', 0, 4, '%'),
  /*
    `cent` OVER `6`, CORRECTED 2026-10-22 FROM A SECOND PHOTOGRAPH.

    I first read this as U+00AC NOT SIGN off a blurred cap, and reasoned about EBCDIC to justify
    it. A sharp photograph of another 122-key 3279 -- an IBM 4978, a DIFFERENT layout but the same
    typewriter character set -- shows `cent` unambiguously over `6`, and re-zooming the original
    cap is consistent with that rather than with a not-sign.

    TWO KEYBOARDS AGREEING BEATS ONE BLURRED CAP PLUS AN ARGUMENT, which is the lesson: the
    EBCDIC reasoning was sound and still produced the wrong glyph, because it explained a reading
    rather than testing it.
  */
  ch('6', 0, 5, '¢'),
  ch('7', 0, 6, '&'),
  ch('8', 0, 7, '*'),
  ch('9', 0, 8, '('),
  /*
    `)` OVER `0` -- NO LONGER AN INFERENCE, CONFIRMED 2026-10-22.

    The cap is BLANK on the first reference unit (no legend at all under maximum zoom, while
    `_`/`-` beside it is legible, so it is missing or worn smooth), and `)` was originally guessed
    from the `9`/`(` pattern. A sharp photograph of an IBM 4978 shows `)` over `0` directly, so
    the guess is now a reading -- from a different keyboard, which is worth stating.
  */
  ch('0', 0, 9, ')'),
  ch('-', 0, 10, '_'),
  /*
    `+` OVER `=`, CONFIRMED by the 4978's own `+`/`=` cap -- though note that keyboard carries an
    EXTRA cap to the right of it, a bullet over plus-minus, which this one does not have. Two
    122-key 3279 keyboards, two different furniture layouts; the CHARACTER SET agrees where both
    have the key, which is exactly how far a cross-check can be trusted.
  */
  ch('=', 0, 11, '+'),
  key('←', { kind: 'backspace' }, 'main', 0, 12, 2, 'Backspace'),

  // ROW 1: Tab, QWERTY, then `!`/`cent` and `|`/`\`, and the tall Enter.
  key('→|', { kind: 'tab' }, 'main', 1, 0, 1.5, 'Tab'),
  ...letters('QWERTYUIOP', 1, 1.5),
  // U+00A2 CENT SIGN over `!`, read off the cap right of `P`.
  /*
    `!` OVER `not sign` -- CORRECTED 2026-10-22, AND THIS IS WHERE THE NOT SIGN ACTUALLY LIVES.

    Recorded as `cent`/`!` off a blurred cap. The sharp 4978 photograph shows this position as an
    EXCLAMATION MARK over a NOT SIGN, and `cent` belongs on `6` instead -- so the two glyphs I had
    were both real and both in the WRONG PLACES, which is the most misleading kind of
    transcription error: each one looked defensible on its own.

    THE DUPLICATE-GLYPH TEST IS WHAT SURFACED IT. Once `6` was corrected to `cent`, this cap's
    `cent` became a repeat and the rule flagged it immediately.
  */
  ch('¬', 1, 11.5, '!'),
  // A BROKEN BAR (U+00A6) OVER THE BACKSLASH, NOT THE SOLID `|` ON THE `1` KEY. The two were
  // flattened into one until the repeated-shifted-glyph test caught it, and the sharp 4978
  // photograph then CONFIRMED the distinction independently -- its own cap here is unmistakably a
  // broken bar over a backslash. EBCDIC distinguishes the two bars, so this is a real difference
  // and not a rendering artefact of either photograph.
  ch('\\', 1, 12.5, '¦'),
  // THE RETURN KEY IS `newline`, NOT `enter`, AND THAT IS THE 3270 DISTINCTION. `Enter` is the AID
  // that submits the screen and lives on its own cap in the bottom row (and in the numpad); this
  // one moves the cursor to the next input field. `keymap.ts` records at length that no TUI chord
  // could express this because Ctrl-J IS 0x0a, "and the keypad button and the TUI overlay are
  // Newline's routes" -- a cap has no such spelling problem.
  key('↵', { kind: 'newline' }, 'main', 1, 13.5, 1.5, 'Newline'),

  // ROW 2: a lock glyph, ASDFGHJKL, then `:`/`;`, `"`/`'`, `)`/`(`.
  dead('⇪', 'main', 2, 0, 1.75, 'Caps Lock (not implemented: see the header)'),
  ...letters('ASDFGHJKL', 2, 1.75),
  ch(';', 2, 10.75, ':'),
  ch('\'', 2, 11.75, '"'),
  /*
    `}` OVER `{` -- CORRECTED 2026-10-22 FROM A SHARP SECOND PHOTOGRAPH, and this was the suspect
    the audit called "most likely wrong of the four".

    It was recorded as `(`/`)`, duplicating the pair on `9`/`0`. That duplication is what made it
    suspect, and the smell was right: an IBM 4978's home row shows this cap as a BRACKET PAIR,
    perfectly legible. The audit's guess -- "a backtick/tilde or a bracket pair" -- named the
    answer without being able to confirm it.
  */
  ch('{', 2, 12.75, '}'),

  /*
    ROW 3: Shift, ZXCVBNM, then `,`/`;`-ish, `.`/`:`-ish, `/`/`?`, and the right Shift.

    BOTH SHIFT CAPS DRIVE THE SAME ONE-SHOT STATE -- neither is distinguishable to us. They are
    identified by NAME in `canvas/src/keyboardUi.ts`, which is why both are called `Shift`.

    THE LEFT SHIFT SHOWS `>`/`<` ON ITS CAP in the photograph, which is a legend rather than a
    second function: the cap is a Shift. Drawn as `Shift` so the surface reads as a keyboard and
    not a puzzle.
  */
  shift(3, 0, 1.25, 'left'),
  ...letters('ZXCVBNM', 3, 1.25),
  /*
    `'` OVER `,` AND `:` OVER `.` -- CORRECTED 2026-10-22, AND THE AUDIT'S PREDICTION WAS WRONG TOO.

    These were recorded as `,`/`;` and `.`/`:`, duplicating the home row's `;`/`:`. The audit
    flagged them and predicted `,`/`<` and `.`/`>`, reasoning from PC-adjacent habit. A sharp 4978
    photograph shows an APOSTROPHE over the comma and a COLON over the period.

    SO THE SMELL WAS A RELIABLE DETECTOR AND THE PREDICTION WAS NOT. Keep both halves of that:
    duplication FOUND the error, and guessing the correction would have shipped a second wrong
    answer that no longer smelled.
  */
  ch(',', 3, 8.25, '\''),
  ch('.', 3, 9.25, ':'),
  // `?` OVER `/`, CONFIRMED by the 4978's own cap. (That keyboard also carries a `~`/`\` cap to
  // its right, which this layout does not appear to have -- the two units differ in furniture even
  // where their character set agrees, so it is NOT transplanted here.)
  ch('/', 3, 10.25, '?'),
  shift(3, 11.25, 2.25, 'right'),

  // ROW 4: Reset, Alt, the spacebar, Alt, a blank, Enter.
  key('Reset', { kind: 'reset' }, 'main', 4, 0, 1.5, 'Reset'),
  dead('Alt', 'main', 4, 1.5, 1.25, 'Alt, left (not a 3270 key)'),
  /*
    THE SPACEBAR IS SEVEN UNITS AND NAMED, which `ch()` could not express: that helper builds a
    one-unit cap named after its own label, and a cap named `" "` is invisible to a screen reader
    and unfindable by a harness. Found by RENDERING the table as ASCII rather than by any
    assertion -- the overlap arithmetic was perfectly happy with a 1-unit spacebar, because a
    too-SMALL cap overlaps nothing. `keyboard3279.test.ts` now pins the width and the name.
  */
  {
    label: '', action: { kind: 'type', text: ' ' },
    region: 'main', row: 4, x: 2.75, width: 7, name: 'Space',
  },
  dead('Alt', 'main', 4, 9.75, 1.25, 'Alt, right (not a 3270 key)'),
  dead('', 'main', 4, 11, 1.25, 'blank'),
  key('Enter', { kind: 'enter' }, 'main', 4, 12.25, 1.75, 'Enter'),

  /*
    THE CURSOR CLUSTER.

    `Dup`+`PA1` and `Field Mark`+`PA2` are DOUBLE-LEGEND CAPS on the hardware -- the lower legend
    is the key's alternate function. We bind the UPPER one, because `Dup` and `Field Mark` are
    typed characters this client implements (`keymap.ts`: "Dup and Field Mark are TYPED CHARACTERS,
    not AIDs") while PA1/PA2 already have caps in the keypad and chords of their own. The lower
    legend is drawn in the label so the cap matches the photograph.

    THE THREE GLYPH KEYS ABOVE THE ARROWS COULD NOT BE READ at this resolution -- a left-pointing
    arrow, a house-like glyph and a third mark. They are INERT with descriptive names, per this
    file's header rule, and are the first thing to fix if a better photograph turns up.
  */
  key('Dup / PA1', { kind: 'dup' }, 'cursor', 0, 0, 1, 'Dup'),
  key('Field Mark / PA2', { kind: 'fieldMark' }, 'cursor', 0, 1, 1, 'Field Mark'),
  dead('', 'cursor', 0, 2, 1, 'blank'),
  dead('←', 'cursor', 1, 0, 1, 'unread glyph, left of the Home key'),
  key('⌂', { kind: 'home' }, 'cursor', 1, 1, 1, 'Home'),
  dead('', 'cursor', 1, 2, 1, 'unread glyph, right of the Home key'),
  key('↑', { kind: 'up' }, 'cursor', 2, 1, 1, 'Cursor up'),
  key('←', { kind: 'left' }, 'cursor', 3, 0, 1, 'Cursor left'),
  key('↓', { kind: 'down' }, 'cursor', 3, 1, 1, 'Cursor down'),
  key('→', { kind: 'right' }, 'cursor', 3, 2, 1, 'Cursor right'),

  /*
    THE NUMERIC KEYPAD.

    The digits are typed characters. The right-hand column could not be fully resolved: the top
    cap reads like `Space`, below it a tab-like glyph, then `-`, then a tall `Enter`. `Enter` is
    legible and is bound; the other three are INERT with descriptive names rather than guessed.
  */
  // `ch()` builds a `main` cap, so the region is overridden here rather than adding a parameter
  // for one caller. The digits are the same typed characters as the main block's.
  ...[...'789'].map((c, i) => ({ ...ch(c, 0, i), region: 'numpad' as const })),
  ...[...'456'].map((c, i) => ({ ...ch(c, 1, i), region: 'numpad' as const })),
  ...[...'123'].map((c, i) => ({ ...ch(c, 2, i), region: 'numpad' as const })),
  { ...ch('0', 3, 0), region: 'numpad' as const, width: 2, name: '0 (numeric pad)' },
  { ...ch('.', 3, 2), region: 'numpad' as const, name: '. (numeric pad)' },
  dead('Space', 'numpad', 0, 3, 1, 'unread cap, top right of the numeric pad'),
  dead('', 'numpad', 1, 3, 1, 'unread glyph, right of 6'),
  dead('-', 'numpad', 2, 3, 1, 'unread cap, right of 3'),
  key('Enter', { kind: 'enter' }, 'numpad', 3, 3, 1, 'Enter (numeric pad)'),
]);
