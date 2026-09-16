import { AID, pfAID, paAID, type Session } from '@tn3270/core';
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
 * ## `quit` AND `toggleKeypad` ARE NOT HANDLED HERE, AND THROW RATHER THAN BEING IGNORED
 *
 * Teardown is the front end's: the TUI restores raw mode on every exit path, the GUI
 * closes a window. Silently ignoring `quit` would leave a front end that forgot to check
 * for it simply unquittable, and that failure would show up as a hang rather than an
 * error. Callers test for it before delegating.
 *
 * `toggleKeypad` is the same shape. Showing or hiding a keypad is a display decision no
 * `Session` knows anything about: the Electron main process and the gateway's server each
 * hold the flag and rebuild the frame, and the TUI opens a list overlay instead. The
 * switch below treats an unrecognised kind as a NO-OP, so ignoring it would leave a front
 * end that forgot to intercept it presenting a button or a chord that does nothing at
 * all -- the least diagnosable outcome available. So it throws.
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
  // THE SAME REASONING AS `quit`, and the same failure mode if it were ignored instead --
  // see the docstring above. Note this is OUTSIDE the `try`, as `quit` is: the catch-all
  // below would swallow the throw and hand back the silent no-op it exists to prevent.
  if (action.kind === 'toggleKeypad') {
    throw new Error('applyAction does not handle toggleKeypad: the front end owns its own display');
  }
  const k = session.keyboard;
  try {
    switch (action.kind) {
      case 'type': k.typeString(action.text); break;
      case 'enter': session.sendAID(AID.ENTER); break;
      case 'clear': session.sendAID(AID.CLEAR); break;
      // `pfAID`/`paAID`, NOT `PF_AIDS[action.n - 1]!`. The index form put a bogus 0x00 AID on the
      // wire to a live mainframe for an out-of-range `n`, because `undefined` coerces to 0 inside
      // `Uint8Array.from`. These throw instead, and the `catch` below means nothing is sent at all.
      case 'pf': session.sendAID(pfAID(action.n)); break;
      case 'pa': session.sendAID(paAID(action.n)); break;
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
      // `Session.sysreq()` has existed since stage 2b with no front end able to call it;
      // this case is what makes it reachable. Not an AID either -- it is TN3270E's SYSREQ,
      // and a no-op when the host did not negotiate the function.
      case 'sysreq': session.sysreq(); break;
      // Typed CHARACTERS, not AIDs: they write one EBCDIC control byte into the buffer and
      // set MDT -- see the keyboard methods and kybd.c:2788,2825. Routing either through
      // `sendAID` would put a byte on the wire that means something else entirely.
      case 'dup': k.dup(); break;
      case 'fieldMark': k.fieldMark(); break;
      // Read-then-set rather than a stored flag: `Keyboard.insertMode` is the one truth and
      // the OIA reads it too, so a second copy here could disagree with what is displayed.
      case 'toggleInsert': k.setInsertMode(!k.insertMode); break;
    }
  } catch (err) {
    void err;
  }
}
