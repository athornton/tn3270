import type { Keyboard, Screen } from '@tn3270/core';

/** What a paste did. `reason` is present only when the paste stopped early. */
export interface PasteResult {
  readonly typed: number;
  readonly dropped: number;
  readonly reason?: 'keyboard locked' | 'wrapped past the start';
}

export interface PasteOptions {
  /** Observability hook for tests; production passes nothing. */
  readonly onAid?: (aid: number) => void;
}

/**
 * Paste text into the screen, with x3270's measured semantics.
 *
 * ## IT LIVES IN `frontend` BECAUSE EVERY FRONT END WANTS THE SAME RULES
 *
 * The graph is `core <- frontend <- { cli, tui, canvas, gui, web }`, so `frontend` is the one place
 * all four front ends can consume. Keeping these rules here is what stops them being written twice,
 * and the keyboard is INJECTED so this is testable with no Electron and no Session.
 *
 * ## THE RULES ARE MEASURED FROM `Common/kybd.c`, NOT RECALLED
 *
 * Every line below was read in the reference, not remembered:
 *
 * | Input | While pasting | Outside pasting | Line |
 * |---|---|---|---|
 * | `\n` | Newline, i.e. next unprotected field | **Enter, an AID** | `:3928`, `:3957` |
 * | `\n` after a wrap | **suppressed** | -- | `:3929` |
 * | `\b` | Left | Left | `:3914` |
 * | `\f` | a **SPACE** | **Clear, an AID** | `:3918`, `:3920` |
 * | `\r` | **dropped** | Newline | `:3963-3967` |
 * | `\t` | Tab | Tab | `:3968` |
 *
 * The two rows with a different meaning inside a paste are the ones that matter, and both would
 * have been guessed wrong: `\n` as Enter would SUBMIT a half-filled panel to a live host, and `\f`
 * as Clear would WIPE the screen mid-paste. `\r` is dropped so that CRLF text does not gain a
 * stray character per line -- the `\n` after it carries the meaning.
 *
 * This is the `auto_skip` default path; OVERLAY-PASTE MODE IS NOT IMPLEMENTED, and not asking for
 * it is what keeps that branch unreachable -- the same reasoning that kept BIND-IMAGE unrequested
 * in stage 2b.
 *
 * ## NO ENTER IS EVER SYNTHESIZED
 *
 * `\n` becomes `Enter_action` in the reference ONLY WHEN NOT PASTING (`:3957`). Enter submits the
 * screen; quietly submitting a half-filled panel to a live host is not a trade this makes. The
 * test asserts it as an ABSENCE, through `onAid`, because "no AID was sent" is the property.
 */
export function pasteString(
  keyboard: Keyboard, screen: Screen, text: string, opts: PasteOptions = {},
): PasteResult {
  const cols = screen.cols;
  const startAddr = screen.cursor;
  let lastAddr = screen.cursor;
  let lastRow = Math.floor(screen.cursor / cols);
  let justWrapped = false;
  let typed = 0;

  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    // THE KEYBOARD LOCK IS FATAL TO THE REMAINDER, matching the reference: "it isn't possible to
    // unlock the keyboard from a string, so if the keyboard is locked, it's fatal"
    // (`kybd.c:3874-3880`). We report how many got in rather than dropping it silently.
    if (keyboard.oia.isInhibited()) {
      return { typed, dropped: chars.length - i, reason: 'keyboard locked' };
    }
    // A CURSOR THAT WRAPPED PAST WHERE IT STARTED ABORTS (`kybd.c:3886`), or a long paste
    // circles the screen and overwrites what it already typed.
    if (screen.cursor < startAddr && i > 0) {
      return { typed, dropped: chars.length - i, reason: 'wrapped past the start' };
    }

    // ROW TRACKING FOR `justWrapped` (`kybd.c:3898-3906`): if the cursor moved to a different row
    // on its own -- because filling a field wrapped it -- the wrap has already done a newline's
    // job, and the next `\n` must be swallowed.
    if (lastAddr !== screen.cursor) {
      lastAddr = screen.cursor;
      const row = Math.floor(screen.cursor / cols);
      justWrapped = row !== lastRow;
      lastRow = row;
    }

    const ch = chars[i]!;
    switch (ch) {
      case '\n':
        // SUPPRESSED AFTER A WRAP. Without this every line after the first FULL one lands ONE
        // FIELD LATE, which presents as a core keyboard fault rather than a paste bug.
        if (!justWrapped) keyboard.newline();
        lastRow = Math.floor(screen.cursor / cols);
        justWrapped = false;
        break;
      case '\b':
        keyboard.left();
        break;
      case '\f':
        if (!keyboard.type(' ')) return { typed, dropped: chars.length - i };
        typed += 1;
        break;
      case '\t':
        keyboard.tab();
        break;
      case '\r':
        // DROPPED, not typed and not Enter: CRLF text would otherwise put a stray character in
        // every field. The `\n` that follows carries the meaning.
        break;
      default:
        if (!keyboard.type(ch)) return { typed, dropped: chars.length - i };
        typed += 1;
        break;
    }
  }
  return { typed, dropped: 0 };
}
