import type { Session } from '@tn3270/core';
import { pasteString } from './paste.js';

/** What a paste did, plus the one line an operator should be shown about it. */
export interface PasteOutcome {
  readonly typed: number;
  readonly dropped: number;
  /** Present only when something was lost. At most one, and it is already operator-facing text. */
  readonly warning?: string;
}

/**
 * Apply a clipboard paste to a session, and decide what to tell the operator about it.
 *
 * ## ONE COPY OF THE RULES, BECAUSE TWO FRONT ENDS NEED THE SAME DECISIONS
 *
 * `pasteString` already owns the x3270 semantics -- which control character means what while
 * pasting. What it does NOT own is the policy on top: which outcome deserves a warning, and in
 * which words. Those lived inline in the Electron GUI's `onPaste` menu handler, and the web
 * gateway's browser half is about to need them identically. Two copies of a message that must
 * agree is how they diverge: this project has already watched a fix reach the prose body of a
 * message and never the heading that summarised it. So the GUI now calls this, and the browser
 * will call this, and there is exactly one place where the wording can be changed.
 *
 * ## THE WARNING IS REMEDY-FIRST, AND THAT IS NOT A STYLE PREFERENCE
 *
 * The status line TRUNCATES, and this project has already shipped a message whose only actionable
 * phrase fell past the cut. `paste stopped: keyboard locked ...` tells the operator the thing they
 * can act on -- the host holds the keyboard, wait or reset -- before the arithmetic. The counts
 * come second because they are diagnosis, not remedy.
 *
 * A silently half-applied paste is the worst outcome available here: the operator cannot see how
 * much of a dataset name arrived, and a SHORT one may be a VALID DIFFERENT NAME. That is why the
 * `dropped > 0` arm warns at all, rather than treating a partial paste as success.
 *
 * ## IT DOES NOT REPAINT, AND THE CALLER MUST
 *
 * A paste is a LOCAL action: it emits no `screen` event, so a caller that does not repaint shows
 * nothing until the host next speaks. Measured on the same path for `tab` in the web gateway,
 * where the missing repaint cost a 5-second test timeout. The GUI's `send()` after this call is
 * that repaint and is deliberately UNCONDITIONAL -- the characters that did land must be visible
 * even on the warning paths.
 *
 * In the browser the repaint carries a second job: `onError` BLANKS THE CANVAS to draw its text,
 * and `onFrame` is what clears that state. So the frame is also what dismisses the warning this
 * function returns. Returning the string instead of sending it keeps that ordering the caller's
 * decision, since only the caller knows its own transport.
 *
 * ## WHY THIS IS NOT IN `applyAction`
 *
 * `applyAction` deliberately THROWS on `{kind:'paste'}` -- the clipboard is owned by whoever has
 * one, and in the browser reading it is async and permissioned while `applyAction` is neither.
 * Each front end intercepts the kind before dispatch, reads its own clipboard, and calls this.
 */
export function applyPaste(session: Session, text: string): PasteOutcome {
  const r = pasteString(session.keyboard, session.screen, text);
  const total = r.typed + r.dropped;
  if (r.reason !== undefined) {
    return {
      typed: r.typed, dropped: r.dropped,
      warning: `paste stopped: ${r.reason} after ${r.typed} of ${total} characters`,
    };
  }
  if (r.dropped > 0) {
    return {
      typed: r.typed, dropped: r.dropped,
      warning: `paste short: ${r.typed} of ${total} characters (field full or protected)`,
    };
  }
  return { typed: r.typed, dropped: r.dropped };
}
