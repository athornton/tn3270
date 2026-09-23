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
 * ## `enter` AND `clear` DEPEND ON THE CONNECTION STATE, WHICH NOTHING ELSE HERE DOES
 *
 * On a DISCONNECTED session they reconnect to the last host instead of sending their AID. That is a
 * divergence from x3270 and the one piece of state-dependent dispatch in this file, so it has its own
 * commentary: see `reconnectInstead` below, and do not touch either case without reading it.
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
  // THE THIRD OF THE SAME SHAPE, and outside the `try` for the same reason as the two above.
  // A transfer needs arguments, so this action opens a form rather than doing anything, and
  // what a form looks like is the front end's business -- a terminal draws an overlay, a GUI
  // will draw a window. A front end that bound the chord and forgot the dialog gets a loud
  // failure instead of a key that appears to do nothing.
  if (action.kind === 'transferForm') {
    throw new Error('applyAction does not handle transferForm: the front end owns its own dialog');
  }
  const k = session.keyboard;
  try {
    switch (action.kind) {
      case 'type': k.typeString(action.text); break;
      // ENTER AND CLEAR MEAN TWO DIFFERENT THINGS, AND WHICH ONE IS DECIDED BY `isConnected()`.
      // Read the block comment below before touching either line: "Enter submits the screen,
      // except when it doesn't" is the whole of what a maintainer needs to be told here.
      case 'enter':
        if (reconnectInstead(session)) break;
        session.sendAID(AID.ENTER);
        break;
      case 'clear':
        if (reconnectInstead(session)) break;
        session.sendAID(AID.CLEAR);
        break;
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
      // BESIDE `tab`/`backTab` because it is the same kind of thing: a local cursor move, not an
      // AID. `Keyboard.newline()` has existed since stage 1 (`core/src/keyboard.ts:348`) and the
      // CLI could already call it as `Newline()` (that case in `cli/src/runner.ts`) -- this
      // case is what makes it reachable from an interactive front end, the same shape of gap
      // `Session.sysreq()` had. It has NO CHORD: see the note on the union member.
      case 'newline': k.newline(); break;
      case 'backspace': k.backspace(); break;
      case 'delete': k.deleteChar(); break;
      case 'eraseEOF': k.eraseEOF(); break;
      case 'eraseInput': k.eraseInput(); break;
      case 'attn': session.sendAttn(); break;
      // `Session.sysreq()` has existed since stage 2b with no front end able to call it;
      // this case is what makes it reachable. TWO FORMS, and `Session.sysreq` picks: Telnet
      // IAC AO on a TN3270E session that agreed the SYSREQ function, and a TEST REQUEST READ
      // -- the four bytes SOH `%` `/` STX plus modified field data -- on a classic one. The
      // classic form is what both of this project's live hosts get, since neither offers
      // TN3270E. Refused silently either way; see that method for every refusal.
      //
      // SYSREQ IS AN AID ARCHITECTURALLY -- `AID.SYSREQ` 0xf0 in `@tn3270/core`'s constants,
      // x3270 `3270ds.h:307` -- and x3270 does route it through `key_AID` on a non-E session
      // (`kybd.c:2864`). IT IS STILL NEVER THE BYTE ON THE WIRE FOR THIS KEY: the AID selects
      // the heading and is then discarded. Cited by name, not line: `constants.ts` moves.
      case 'sysreq': session.sysreq(); break;
      // Typed CHARACTERS, not AIDs: they write one EBCDIC control byte into the buffer and
      // set MDT -- see the keyboard methods and kybd.c:2788,2825.
      //
      // What routing them through `sendAID` would ACTUALLY do, traced rather than assumed:
      // 0x1c and 0x1e are not in `AID`, `VALID_AIDS` is built from its values
      // (`constants.ts`, by name: the line moves), and `sendAID` throws `RangeError` before it
      // even checks for a connection (`Session.sendAID`'s AID-byte check, by name: the line
      // moves) -- which the `catch` below swallows. So the outcome is NOT a wrong byte on the
      // wire but a key that does nothing at all, silently. Same class of defect, worse
      // diagnosability.
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

/**
 * ON A DISCONNECTED SESSION, ENTER AND CLEAR RECONNECT TO THE SAME HOST INSTEAD OF SUBMITTING.
 *
 * Returns `true` when it has TAKEN OVER the keypress, i.e. when the caller must not send its AID.
 *
 * ## THIS IS THE SUBTLE THING IN THIS FILE. READ IT BEFORE CHANGING EITHER CASE
 *
 * One key with two meanings is exactly the kind of thing that surprises a maintainer, so state it
 * plainly: while `session.isConnected()` is false, `enter` and `clear` open a socket and send
 * NOTHING, and while it is true they are the AID senders they have always been. No other action
 * kind is state-dependent, and none should become so without a reason as concrete as this one.
 *
 * WHY IT IS WORTH IT. VM/370 prints "Press Enter or Clear to continue" the instant a LOGOFF drops
 * the connection, and that message is on the LAST SCREEN THE HOST EVER SENT, still sitting there
 * under an `X Disconnected` OIA. Both keys previously did nothing at all: `sendAID` throws 'not
 * connected' and the catch above swallows it, so the operator's own reading of the screen was
 * simply wrong, with no feedback of any kind. The OIA now says so too (`X Disconnected -- press
 * Enter to reconnect`, gated on there being a host to go back to).
 *
 * ## A DELIBERATE DIVERGENCE FROM x3270
 *
 * x3270 has no such binding, and that was checked rather than assumed: `Enter_action` and
 * `Clear_action` (`Common/kybd.c`) branch only on the keyboard lock and on NVT mode, and the word
 * "reconnect" appears nowhere in that file. x3270 reaches this behaviour two other ways — the
 * `Reconnect()` ACTION (`Common/host.c`, which we also expose, as the CLI's `Reconnect()`), and the
 * `reconnect` RESOURCE (`Common/glue.c`) that redials automatically. We follow x3270 where it has an
 * answer; here it has one for scripts and none for a keyboard, and this is the gap that fills.
 *
 * ## WHY HERE, AND NOT IN EACH FRONT END
 *
 * `applyAction` is the one translation the TUI, the GUI and the browser share, and the behaviour is
 * identical in all three; three copies would be three chances for one to drift. IT IS DELIBERATELY
 * NOT IN THE CLI, which does not use this function: a script's `Enter()` must not silently open a
 * socket, and s3270 spells the deliberate act `Reconnect()`.
 *
 * ## THE PROMISE, WHICH IS THE PART THAT CAN BREAK A PROCESS
 *
 * `applyAction` is SYNCHRONOUS and `Session.reconnect()` is not. The promise is deliberately not
 * returned and not awaited — a signature change would reach every caller in four front ends, and
 * two of them (`gui/src/main.ts`'s `ipcMain` handler, `web/src/main.ts`'s `onText`) are event
 * handlers with nothing above them to await it — so the rejection MUST be contained here. An
 * unhandled rejection terminates the process on modern Node, and in the gateway that means every
 * other operator's session goes with it: `web/src/wsserver.ts` records that a throw in a socket
 * handler ends the process, and this project has already hung one process on an unawaited promise.
 * `web/src/main.ts` contains its own initial connect the same way, `void session.connect(...)
 * .catch(...)`.
 *
 * SWALLOWED, LIKE EVERY OTHER REFUSAL IN THIS FILE, and the reason it is not silent: `reconnect()`
 * records the failure in the session's `lastError()` and traces it before rethrowing, and the OIA
 * still reads `press Enter to reconnect` — which remains the operator's correct next move, because
 * a host that refused a socket once may take one now. The two synchronous refusals `reconnect()`
 * raises (already connected, no previous host) arrive as a rejected promise too, since it is
 * `async`, so this one `catch` covers all three and the front ends' unconditional repaint is
 * unaffected either way.
 */
function reconnectInstead(session: Session): boolean {
  if (session.isConnected()) return false;
  // `void` on the call as well as the `catch`, so no lint rule can be satisfied by removing the
  // catch instead of the void -- the catch is the load-bearing half.
  void session.reconnect().catch((err: unknown) => { void err; });
  return true;
}
