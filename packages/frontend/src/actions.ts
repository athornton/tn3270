import { AID, PA_AIDS, PF_AIDS, type Session } from '@tn3270/core';
import type { Action } from './keymap.js';

/**
 * Apply one named action to a session.
 *
 * ## THIS FILE DECIDES NOTHING ABOUT 3270 SEMANTICS
 *
 * The field-aware typing rules, the tab order, the keyboard lock and the AID semantics
 * all live in core and are tested there. If a branch here grows logic, that logic is in
 * the wrong package. It is shared because it is the one translation every front end
 * needs and none of them should own: the CLI's command table, the TUI's keymap and the
 * GUI's KeyboardEvent mapper all produce these same names.
 *
 * ## `quit` IS NOT HANDLED HERE, AND THROWS RATHER THAN BEING IGNORED
 *
 * Teardown is the front end's: the TUI restores raw mode on every exit path, the GUI
 * closes a window. Silently ignoring `quit` would leave a front end that forgot to check
 * for it simply unquittable, and that failure would show up as a hang rather than an
 * error. Callers test for it before delegating.
 *
 * ## A REJECTED ACTION IS SWALLOWED
 *
 * Not connected, or a program check, is normal operation rather than a crash — and the
 * OIA already says why, so the caller's redraw shows it. `typeString` is different again:
 * it REPORTS refusal by returning false rather than throwing, so there is nothing to
 * catch and nothing to do.
 */
export function applyAction(session: Session, action: Action): void {
  if (action.kind === 'quit') {
    throw new Error('applyAction does not handle quit: the front end owns its own teardown');
  }
  const k = session.keyboard;
  try {
    switch (action.kind) {
      case 'type': k.typeString(action.text); break;
      case 'enter': session.sendAID(AID.ENTER); break;
      case 'clear': session.sendAID(AID.CLEAR); break;
      case 'pf': session.sendAID(PF_AIDS[action.n - 1]!); break;
      case 'pa': session.sendAID(PA_AIDS[action.n - 1]!); break;
      case 'reset': k.reset(); break;
      case 'left': k.left(); break;
      case 'right': k.right(); break;
      case 'up': k.up(); break;
      case 'down': k.down(); break;
      case 'home': k.home(); break;
      case 'tab': k.tab(); break;
      case 'backTab': k.backTab(); break;
      case 'backspace': k.backspace(); break;
      case 'delete': k.deleteChar(); break;
      case 'eraseEOF': k.eraseEOF(); break;
      case 'eraseInput': k.eraseInput(); break;
      case 'attn': session.sendAttn(); break;
      // Read-then-set rather than a stored flag: `Keyboard.insertMode` is the one truth and
      // the OIA reads it too, so a second copy here could disagree with what is displayed.
      case 'toggleInsert': k.setInsertMode(!k.insertMode); break;
    }
  } catch (err) {
    void err;
  }
}
