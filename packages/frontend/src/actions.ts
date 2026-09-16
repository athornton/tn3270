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
      // this case is what makes it reachable. It sends Telnet IAC AO, and is a no-op when the
      // host did not negotiate the SYSREQ function.
      //
      // SYSREQ IS AN AID ARCHITECTURALLY -- 0xf0 (`constants.ts:477`, x3270 `3270ds.h:307`),
      // and x3270 does send it with `key_AID` on a non-E session (`kybd.c:2857`). It is only
      // THIS path that is not an AID send: `Session.sysreq` implements the TN3270E form.
      case 'sysreq': session.sysreq(); break;
      // Typed CHARACTERS, not AIDs: they write one EBCDIC control byte into the buffer and
      // set MDT -- see the keyboard methods and kybd.c:2788,2825.
      //
      // What routing them through `sendAID` would ACTUALLY do, traced rather than assumed:
      // 0x1c and 0x1e are not in `AID`, `VALID_AIDS` is built from its values
      // (`constants.ts:544`), and `sendAID` throws `RangeError` before it even checks for a
      // connection (`session.ts:609-611`) -- which the `catch` below swallows. So the outcome
      // is NOT a wrong byte on the wire but a key that does nothing at all, silently. Same
      // class of defect, worse diagnosability.
      case 'dup': k.dup(); break;
      case 'fieldMark': k.fieldMark(); break;
      // Read-then-set rather than a stored flag: `Keyboard.insertMode` is the one truth and
      // the OIA reads it too, so a second copy here could disagree with what is displayed.
      case 'toggleInsert': k.setInsertMode(!k.insertMode); break;
      // EXHAUSTIVENESS, WITH NO RUNTIME FOOTPRINT. `satisfies never` is a type-level assertion
      // that every member has been handled above: it emits `default: action;` and nothing else, so
      // an unrecognised `kind` arriving from untrusted JSON is still the silent no-op that
      // `web/src/protocol.ts` relies on. What it buys is two compile errors instead of two silent
      // defects: a new `Action` member with no case, and -- the one that matters -- DELETING EITHER
      // GUARD ABOVE without adding a case, which would otherwise turn `quit` or `toggleKeypad` back
      // into the silent no-op this file's docstring calls the least diagnosable outcome available.
      // Prose alone did not prevent that; TS1360 does.
      default: action satisfies never;
    }
  } catch (err) {
    void err;
  }
}
