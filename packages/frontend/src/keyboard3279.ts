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
 * ## A THIRD SOURCE, AND IT MATCHES THIS LAYOUT EXACTLY
 *
 * The user then supplied a photograph of an **IBM 3270 PC** whose keyboard is the SAME layout as
 * the first: PF13-24 above PF1-12, the two-column special bar, `Dup`/`PA1` and `Field Mark`/`PA2`
 * in the cursor cluster, the same arrow arrangement. From it:
 *
 *  - **`PA3` was recorded as BLANK and is not** -- the cap reads `PA3`, completing the set beside
 *    the PA1 and PA2 that ride the Dup and Field Mark caps.
 *
 * **AND IT CONTAINS A TRAP WORTH THE WARNING: its NUMERIC PAD IS A PC's.** `7`/`Home`, `8`/up,
 * `9`/`PgUp`, with `Esc`/`NumLk`/`ScrLk` above -- because a 3270 PC is a PC with 3270 emulation.
 * A keyboard that agrees everywhere else and differs silently in exactly the place you need is
 * the worst kind of cross-check, so NOTHING was taken from it there.
 *
 * **THE NUMERIC PAD WAS SETTLED FROM THE ORIGINAL PHOTOGRAPH INSTEAD, at 6x: `Space`, a FIELD TAB
 * arrow, `-` and `Enter` down the right-hand column.** Three of the five `unread` caps had been
 * resolvable all along -- **I gave up on the zoom too early**, which is the lesson that belongs
 * next to them.
 *
 * ## EVERY CAP IS NOW READ -- ZERO UNREADABLE, AND THE ROUTE IS THE LESSON
 *
 * The last two flanked `Home` and had survived all three photographs. They fell to a **10x crop of
 * the FIRST image with contrast and an unsharp mask**: an arrow pointing left into a bar and one
 * pointing right into a bar, the standard 3270 back-tab and field-tab glyphs, flanking Home
 * exactly as the cluster's logic predicts.
 *
 * **THE PIXELS WERE ALWAYS SUFFICIENT; THE PROCESSING WAS NOT.** Plain LANCZOS upscaling left them
 * a smudge through two rounds of "still unreadable", while sharpening resolved them in one. The
 * rule for next time: **exhaust the image you have before asking for another one.**
 *
 * Unreadable caps went 5 -> 2 -> 0 in a day, and the test that tracked the count is now inverted:
 * zero is the FLOOR, and an `unread` cap reappearing means a key was marked unreadable rather
 * than read.
 *
 * The 4978 also has keys this layout lacks (a `~`/`\` cap, a bullet over plus-minus,
 * `LINE DUP`/`FIELD DUP`/`REP`), and none were transplanted: two units agree on the character set
 * where both have a key, and that is exactly how far a cross-check can be trusted.
 *
 * ## LEGENDS COME FROM THE PHOTOGRAPH, AND THIS IS NOT A PC KEYBOARD
 *
 * Transcribed from `s-l960.png`, an **IBM 5271 Converged Keyboard** -- the user identified it on
 * 2026-10-22, and the name matters more than it looks: "122-key 3279 keyboard" describes several
 * distinct units, while *Converged Keyboard* names ONE, a 122-key Model F sold with the 3270 PC
 * and the 3179/3180 terminals. Deskthority's Model F page confirms the family and says the layout
 * "was arguably inspired by the DEC LK201, and seems to have been the basis for the layout of the
 * later Model M Enhanced Keyboard" -- but carries no cap-level legends, so it cannot settle the
 * two caps still open.
 *
 * **SEARCH FOR `5271 Converged Keyboard` RATHER THAN FOR A DESCRIPTION** if a fourth source is
 * ever wanted. That is the lesson of the identification: the two caps still unread are unread
 * because I was searching by appearance, and a part number is a key into documentation that a
 * description is not. It is the 3270 TYPEWRITER
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
  /**
   * Height in KEY UNITS, for a cap that spans rows. Absent means 1.
   *
   * ADDED 2026-10-22 FOR THE RETURN KEY, which the sharp reference photograph shows spanning the
   * QWERTY and home rows -- and that span is what makes the main block a RECTANGLE rather than a
   * ragged stack. Without it row 2 ends 1.25 units short of row 1.
   *
   * A TALL CAP IS DECLARED ON ITS TOP ROW and is simply absent from the rows beneath, so a row's
   * own width calculation does not have to know about it. `keyboardUi.ts` renders the span with a
   * grid-row rule; the row below leaves the space empty by having no cap at that `x`.
   */
  readonly height?: number;
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

/** A typed character outside the main block, with an explicit name. */
const ch2 = (
  label: string, region: KeyboardRegion, row: number, x: number, name: string,
): KeyCap => ({
  label, action: { kind: 'type', text: label }, region, row, x, width: 1, name,
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
  // `Shft`, NOT `Shift`: the LEFT cap is 1.25 units, which is 31px usable, and five capitals at
  // the main block's 10px type need ~38px. The real keyboard prints `Shift` in full because its
  // cap is physically wider than one unit of this layout's pitch; four characters is the honest
  // abbreviation at this size. The NAME stays `Shift (...)`, which is what the view's `data-key`
  // and both harnesses address -- a label is presentation, a name is the identifier.
  label: 'Shft',
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
    THE PF STRIP: TWO ROWS ABOVE THE MAIN KEYBOARD, PF13-24 ON TOP OF PF1-12.

    ## THE POSITION IS A DECISION, NOT THE ONLY OPTION -- CONFIRMED BY THE USER 2026-10-22

    **"There's also a common layout that puts PF13-24 in a block to the right of the numeric
    keypad but I prefer the two rows above the main keyboard."** Both arrangements shipped on real
    3270-family hardware, and this one is what the reference 5271 has -- so the two-band layout in
    `ui.css` (PF strip across the top, the other four regions in a row beneath) is matching the
    photographed unit AND the user's stated preference, which happen to agree.

    **RECORDED BECAUSE IT WOULD OTHERWISE LOOK LIKE AN UNEXAMINED DEFAULT.** Someone who knows the
    right-hand-block variant could "fix" this toward it in good faith; they should know it was
    considered and declined. If it is ever wanted as an OPTION, the change is in the view's band
    assignment (`keyboardUi.ts` decides which band a region joins, from its name) and not in this
    table -- the geometry here is per-region, so a PF block beside the numpad needs no new
    coordinates, only a different container.

    ## THE ROW ORDER WITHIN THE STRIP

    PF13-24 above PF1-12 is the hardware's order in the photograph, and it matches both
    `KEYPAD_KEYS` (which opens `pfRow(0, 13)` then `pfRow(1, 1)`) and c3270
    (`Common/c3270/keypad.labels:2` and `:4`). Reversing it would be a silent relearn for anyone
    used to either. The table's test pins the first label of each row rather than only the count,
    which is what catches that.
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
  /*
    THE LEFT SPECIAL BAR -- REWRITTEN 2026-10-22, AND FOUR OF ITS CAPS WERE SIMPLY WRONG.

    I had `Esc`, `Print Screen`, `Scroll Lock` and `Pause` here: PC keys, read off a blurred
    photograph and believed because they looked like a plausible PC-ish column. The sharp reference
    (`DSC08836-scaled.jpeg`) shows what is actually there, and it is all 3270:

      Attn  | Clear
      Cursr | (blank)
      Sel   |
      Ex Sel| Erase EOF
      Print | Test          <- `Test` is the SHIFTED legend on a blank cap
      (blk) | (blk)

    **TWO OF THEM ARE FUNCTIONS WE ALREADY IMPLEMENT**, so they become LIVE KEYS rather than grey
    scenery: `Erase EOF` is `eraseEOF`, which the compact keypad has carried all along as `ErEOF`.
    That is the most valuable thing this photograph bought -- not geometry, but two working keys
    where I had drawn dead ones.

    `Ex Sel` IS *NOT* IMPLEMENTED, and the distinction matters: it is Erase Input on some units and
    a field-select on others, and `keypad.ts` records Erase Input as `ErInp` separately. Rather
    than guess which this cap is, it stays inert with its real name -- the same discipline the
    unreadable caps got.

    `Print`'s SHIFTED LEGEND IS `Ident`, and the blank cap beside it carries `Test`. Both were read
    by the user on this photograph. Neither has an action here, so they are recorded as legends on
    inert caps: documented as existing and unimplemented rather than silently absent.

    `Attn`'s OWN SHIFTED LEGEND IS STILL UNREADABLE even here -- it is front-printed and blurred in
    every photograph so far -- as is the row-1 blank's. Those two remain unidentified.
  */
  key('Attn', { kind: 'attn' }, 'special-left', 0, 0, 1, 'Attention'),
  key('Clr', { kind: 'clear' }, 'special-left', 0, 1, 1, 'Clear'),
  dead('Cur\nSel', 'special-left', 1, 0, 1, 'Cursor Select (not implemented: light-pen work)'),
  dead('', 'special-left', 1, 1, 1, 'blank, right of Cursor Select'),
  dead('Ex\nSel', 'special-left', 2, 0, 1, 'Ex Sel (not implemented: ambiguous function)'),
  // A REAL 3270 FUNCTION WE IMPLEMENT -- the compact keypad has carried it as `ErEOF` all along.
  key('Ers\nEOF', { kind: 'eraseEOF' }, 'special-left', 2, 1, 1, 'Erase EOF'),
  {
    label: 'Prnt',
    shiftLabel: 'Idnt',
    action: undefined,
    region: 'special-left', row: 3, x: 0, width: 1,
    name: 'Print (shifted: Ident, not implemented)',
  },
  {
    label: '',
    shiftLabel: 'Test',
    action: undefined,
    region: 'special-left', row: 3, x: 1, width: 1,
    name: 'blank (shifted: Test, not implemented)',
  },
  /*
    THE TWO BLANK CAPS AT THE BOTTOM, AND `Xfer` GOES BACK ON ONE OF THEM.

    It had moved to the cursor cluster's third cap on the user's reasoning that the cap had no
    unshifted function -- but this photograph IDENTIFIES that cap: it carries the
    `a`-with-a-squiggle glyph, which is delete-to-end-of-line. So it is a real key after all, and
    `Xfer` returns here, to a cap this file has CONFIRMED blank under maximum zoom.
  */
  key('Xfer', { kind: 'transferForm' }, 'special-left', 4, 0, 1, 'File transfer'),
  dead('', 'special-left', 4, 1, 1, 'blank, bottom right of the special bar'),

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
  // BACKSPACE IS 3 UNITS, which is what closes row 0 at 15 -- and the photograph shows it as the
  // widest cap on that row, running to the right edge above the Return key.
  key('←', { kind: 'backspace' }, 'main', 0, 12, 3, 'Backspace'),

  /*
    ROWS 1-4, AS A TRUE RECTANGLE -- REWRITTEN 2026-10-22 FROM A SHARP REFERENCE PHOTOGRAPH
    (`DSC08836-scaled.jpeg`), which is the same 5271 and finally legible.

    ## EVERY ROW ENDS AT EXACTLY 15 UNITS, AND THAT IS WHY

    The block used to end at 14, 15, 13.75, 13.5 and 14 units -- ragged by up to 1.5 units, which
    the user saw immediately: "can we make the main keyboard an actual rectangle?" A real keyboard
    is a rectangle because its leading keys STAGGER and its edge keys are WIDE, not because it has
    dead space, so that is what this now models.

    ## THE STAGGER IS MEASURED, NOT EYEBALLED

    `Z` MUST CENTRE BETWEEN `A` AND `S`, which the user named as the test. With Caps at 1.75 units
    `A` centres at 2.25 and `S` at 3.25, so `Z` must centre at 2.75 -- which a 2.25-unit left
    Shift gives exactly. Tab 1.5, Caps 1.75, Shift 2.25 is the classic ANSI-ish progression and it
    falls out of that one requirement rather than being copied from a PC.

    ## THE RETURN KEY SPANS TWO ROWS, WHICH IS WHAT CLOSES THE RECTANGLE

    The photograph shows the bent-arrow Return as one tall cap covering the QWERTY and home rows,
    with a SEPARATE small `Enter` on the bottom row. Without the span, row 2 ends 1.25 units short
    and no amount of widening the punctuation keys looks right. `height: 2` is declared on its top
    row and the home row simply has no cap at that `x` -- see `KeyCap.height`.
  */

  // ROW 1: Tab, QWERTY, two punctuation caps, and the TALL Return.
  key('→|', { kind: 'tab' }, 'main', 1, 0, 1.5, 'Tab'),
  ...letters('QWERTYUIOP', 1, 1.5),
  // `!` over a NOT SIGN -- confirmed again on this photograph, right of `P`.
  ch('¬', 1, 11.5, '!'),
  // A BROKEN BAR (U+00A6) over the backslash, distinct from the solid `|` on the `1` key.
  ch('\\', 1, 12.5, '¦'),
  /*
    RETURN, TWO ROWS TALL AND 1.5 UNITS WIDE.

    `newline`, NOT `enter`, and that is the 3270 distinction this table has carried from the start:
    `Enter` is the AID that submits the screen and has its own cap on row 4 (and another on the
    numeric pad); this one moves the cursor to the next input field. `keymap.ts` records that no
    TUI chord could express Newline because Ctrl-J IS 0x0a -- a cap has no such spelling problem,
    which is half the reason this surface is worth having.
  */
  {
    label: '↵',
    action: { kind: 'newline' },
    /*
      x=13.75 AND 1.25 UNITS WIDE, WHICH IS GEOMETRY RATHER THAN DECORATION.

      It was x=13.5, width 1.5 -- and that OVERLAPPED the `{` cap below it by 0.25 units, because
      the home row's content runs further right than the QWERTY row's (13.75 against 13.5, Caps
      being 1.75 where Tab is 1.5). The user saw the `{` lose its border.

      A `clip-path` notch in `ui.css` was the first fix and it was NOT ENOUGH: a clip changes what
      is PAINTED and not what the box covers, so the Return still sat on top of the `{`. The
      harness said `OVERLAPS by 6px` once it compared boxes instead of hit-testing.

      STARTING AT 13.75 REMOVES THE OVERLAP AND KEEPS THE RECTANGLE: the home row is 13.75 + 1.25
      = 15, and the QWERTY row is 13.5 of content, a 0.25-unit gap, then the same 1.25 = 15. That
      gap is real on the hardware too -- the QWERTY row's punctuation does not reach as far right
      as the home row's, which is exactly why the key is L-shaped.
    */
    region: 'main', row: 1, x: 13.75, width: 1.25, height: 2,
    name: 'Newline',
  },

  // ROW 2: Caps (inert), ASDFGHJKL, three punctuation caps. The Return above covers 13.5-15.
  dead('⇪', 'main', 2, 0, 1.75, 'Caps Lock (not implemented: see the header)'),
  ...letters('ASDFGHJKL', 2, 1.75),
  ch(';', 2, 10.75, ':'),
  ch('\'', 2, 11.75, '"'),
  ch('{', 2, 12.75, '}'),

  /*
    ROW 3: a 2.25-UNIT SHIFT, ZXCVBNM, three punctuation caps, and a WIDE right Shift.

    BOTH SHIFT CAPS DRIVE THE SAME ONE-SHOT STATE -- neither is distinguishable to us, and they are
    matched by NAME in `canvas/src/keyboardUi.ts`. The left cap's printed legend is `>`/`<` on the
    hardware; it is drawn as `Shft` so the surface reads as a keyboard rather than a puzzle.
  */
  shift(3, 0, 2.25, 'left'),
  ...letters('ZXCVBNM', 3, 2.25),
  ch(',', 3, 9.25, '\''),
  ch('.', 3, 10.25, ':'),
  ch('/', 3, 11.25, '?'),
  shift(3, 12.25, 2.75, 'right'),

  /*
    ROW 4: Reset, Alt, the spacebar, Alt, a blank, and `Enter`.

    `Reset` CARRIES `DvCntl` AS ITS SHIFTED LEGEND -- front-printed on the cap, read on this
    photograph and identified by the user as Device Control. We have no action for it, so it is
    recorded as a `shiftLabel` on a cap whose unshifted function we DO implement: pressing Shift
    re-letters it, and clicking it still sends `reset`. That is honest -- the shifted function is
    documented as existing and unimplemented, rather than silently absent.
  */
  {
    label: 'Reset',
    shiftLabel: 'DvCn',
    action: { kind: 'reset' },
    region: 'main', row: 4, x: 0, width: 1.5,
    name: 'Reset (shifted: Device Control, not implemented)',
  },
  dead('Alt', 'main', 4, 1.5, 1.25, 'Alt, left (not a 3270 key)'),
  {
    label: '', action: { kind: 'type', text: ' ' },
    region: 'main', row: 4, x: 2.75, width: 7, name: 'Space',
  },
  dead('Alt', 'main', 4, 9.75, 1.25, 'Alt, right (not a 3270 key)'),
  dead('', 'main', 4, 11, 1.25, 'blank, right of the spacebar'),
  key('Enter', { kind: 'enter' }, 'main', 4, 12.25, 2.75, 'Enter'),

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
  /*
    THE CURSOR CLUSTER, AS A DIAMOND -- REWRITTEN 2026-10-22 FROM THE SHARP REFERENCE.

    The user prefers this to the modern inverted-T and the photograph shows why: the arrows sit in
    a 3x3 diamond with a CENTRE CAP between them, which is what the hardware actually has.

      Dup/PA1 | FieldMark/PA2 | PA3
      BackTab | Home          | DelEOL
              | up            |
      left    | (centre)      | right
              | down          |

    ## WHAT THIS PHOTOGRAPH IDENTIFIED, ALL OF IT NEW

     - THE THIRD CAP OF ROW 1 is the `a`-with-a-squiggle glyph, which the user read as
       delete-to-end-of-line. We have no such action -- `delete` is a single character and
       `eraseEOF` erases to the end of the FIELD, not the line -- so it is inert with its real
       name. **AND THAT IS WHY `Xfer` MOVED OFF IT**: it is a real key, not a spare.
     - THE CENTRE CAP carries a DIAGONAL ARROW, which the user read as cursor-to-top-left. That is
       plausibly `Home` -- but `Home` already has its own cap two rows up, and a keyboard does not
       usually spend two caps on one function. Inert, with the ambiguity recorded rather than
       guessed away.
     - THE SHIFTED LEGENDS ON LEFT AND RIGHT ARE DOUBLE ARROWS, which the user read as
       beginning/end of line. No action exists for either, so they are `shiftLabel`s on live cursor
       keys: Shift re-letters the cap, and clicking still moves the cursor one position. The
       shifted function is documented as existing and unimplemented.
  */
  key('Dup\nPA1', { kind: 'dup' }, 'cursor', 0, 0, 1, 'Dup'),
  key('Fld\nMrk\nPA2', { kind: 'fieldMark' }, 'cursor', 0, 1, 1, 'Field Mark'),
  key('PA3', { kind: 'pa', n: 3 }, 'cursor', 0, 2, 1, 'PA3'),

  /*
    REVERSE TAB: `U+21E4 LEFTWARDS ARROW TO BAR`, AND THE DIRECTION WAS MIRRORED BEFORE.

    I had `←|` -- bar on the RIGHT, as if the arrow left a tab stop. The user caught it and the
    reference photograph is unambiguous: the BAR IS AT THE LEFT with the arrowhead terminating
    into it, because you are going back TO a tab stop, not back FROM one. The semantics were
    backwards, not just the drawing.
  */
  key('⇤', { kind: 'backTab' }, 'cursor', 1, 0, 1, 'Back Tab (cursor cluster)'),
  /*
    `U+21A5 UPWARDS ARROW FROM BAR` FOR INSERT -- AND THIS CAP WAS MISIDENTIFIED AS `Home`.

    The glyph is a lowercase `a` beneath a WIDE CARET, which the user reads as Insert; the caret is
    the classic insertion mark and the `a` is the character being inserted. I had drawn it as a
    house and called it Home, which was a guess from the shape alone.

    `toggleInsert` IS AN ACTION WE HAVE, so this becomes a working key rather than scenery -- the
    compact keypad carries it as `Ins`.

    THE GLYPH IS AN APPROXIMATION, NOT A TRANSCRIPTION: there is no Unicode point for an `a` under
    a caret, so this is the closest available stand-in, and an SVG of the real mark is the someday
    fix.

    `U+2041 CARET INSERTION POINT`, AND IT IS THE THIRD CHOICE -- the first two were rejected for
    different reasons, which is why all three are recorded.

     1. `U+21A5 UPWARDS ARROW FROM BAR` was mine, and it is the wrong SHAPE: a thin solid arrow
        with a bar at its foot, where a 12x crop of the cap shows a wide HOLLOW caret.
     2. `U+21E7 UPWARDS WHITE ARROW` was the user's suggestion and matches the shape exactly --
        but **U+21E7 IS THE SHIFT KEY**, universally, and this keyboard HAS two Shift caps. A
        glyph that means Shift on a key that means Insert is worse than one that merely looks
        wrong: it is actively misleading, and the shape being right makes the confusion more
        likely rather than less.
     3. `U+2041 CARET INSERTION POINT` is the proofreader's insertion mark, so right shape and right
        meaning -- and it DOES NOT RENDER. Measured in the harness: 2.3px against 7.5px for a
        glyph known to be present, i.e. a near-blank fallback. General Punctuation is not what the
        symbol fonts in `ui.css` were chosen for.
     4. `U+2303 UP ARROWHEAD` measures 7.5px, exactly matching the reference glyph, and it is a
        hollow caret that means "control/up" rather than Shift. Right shape, available, and
        unclaimed on this keyboard.

    THE LESSON IS THAT A GLYPH HAS THREE PROPERTIES and all of them matter: what it looks like,
    what it already means elsewhere, and whether the font actually has it. Choice 1 failed the
    first, choice 2 the second, choice 3 the third.

    STILL AN APPROXIMATION: the hardware draws an `a` tucked under the caret's apex, and no
    Unicode point does that. An SVG remains the someday fix.
  */
  key('⌃', { kind: 'toggleInsert' }, 'cursor', 1, 1, 1, 'Insert (approximate glyph)'),
  /*
    `U+219B RIGHTWARDS ARROW WITH STROKE` FOR DELETE CHARACTER, SHIFTED TO TWO OF THEM.

    The cap is a lowercase `a` with a squiggle struck diagonally up-and-right, and its shifted
    legend is visibly LONGER -- the user reads it as the squiggle running through three `a`s, i.e.
    the same operation extended to the end of the line.

    I HAD `U+232B ERASE TO THE LEFT`, WHICH WAS WRONG IN MEANING: the user points out the stroke
    goes up and to the RIGHT, so this deletes forward, not backward. `delete` is exactly that
    action and we have it, so the unshifted key is LIVE; the shifted form is
    delete-to-end-of-line, which we do NOT have, and the doubled glyph records it the way the
    doubled arrows record start/end of line on the cursor keys.

    BOTH GLYPHS ARE APPROXIMATIONS, not transcriptions -- no Unicode point draws an `a` with a
    diagonal strike. Doubling for the shifted form follows the hardware's own idiom and this
    table's existing one.
  */
  {
    label: '↛', shiftLabel: '↛↛', action: { kind: 'delete' },
    region: 'cursor', row: 1, x: 2, width: 1,
    name: 'Delete character (shifted: delete to end of line, not implemented)',
  },

  // THE DIAMOND. `up` is centred on its own row; `left`, the centre cap and `right` share the
  // next; `down` is centred below. The row offsets come from the table and `keyboardUi.ts`
  // renders them -- see its note on `padding-left`.
  {
    label: '↑', action: { kind: 'up' },
    region: 'cursor', row: 2, x: 1, width: 1, name: 'Cursor up',
  },
  {
    label: '←', shiftLabel: '↞', action: { kind: 'left' },
    region: 'cursor', row: 3, x: 0, width: 1,
    name: 'Cursor left (shifted: start of line, not implemented)',
  },
  dead('↖', 'cursor', 3, 1, 1, 'diagonal arrow, function unidentified'),
  {
    label: '→', shiftLabel: '↠', action: { kind: 'right' },
    region: 'cursor', row: 3, x: 2, width: 1,
    name: 'Cursor right (shifted: end of line, not implemented)',
  },
  {
    label: '↓', action: { kind: 'down' },
    region: 'cursor', row: 4, x: 1, width: 1, name: 'Cursor down',
  },

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
  /*
    THE NUMERIC PAD'S RIGHT-HAND COLUMN -- READ AT LAST, 2026-10-22, FROM THE ORIGINAL PHOTOGRAPH.

    These three were inert with `unread` names because I could not resolve them. A 6x crop of the
    SAME image settles all three: `Space`, a FIELD TAB arrow, and `-`, with `Enter` below. **The
    pixels were always there; I gave up on the zoom too early**, which is worth recording next to
    the entries it cost.

    A SECOND KEYBOARD CONFIRMED NOTHING HERE, and that is the interesting part: the IBM 3270 PC
    (the layout this one otherwise matches exactly) has a PC NUMPAD in this position -- 7/Home,
    8/up, 9/PgUp, with Esc/NumLk/ScrLk above. It is a PC with 3270 emulation, so its numpad is a
    PC's. Transplanting those legends would have been the worst kind of cross-check: a keyboard
    that agrees everywhere else, differing silently in exactly the place I needed.
  */
  key('Spc', { kind: 'type', text: ' ' }, 'numpad', 0, 3, 1, 'Space (numeric pad)'),
  // FIELD TAB, the same `→|` glyph the main block's Tab carries.
  key('→|', { kind: 'tab' }, 'numpad', 1, 3, 1, 'Tab (numeric pad)'),
  ch2('-', 'numpad', 2, 3, '- (numeric pad)'),
  key('Ent', { kind: 'enter' }, 'numpad', 3, 3, 1, 'Enter (numeric pad)'),
]);
