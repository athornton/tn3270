import type { Session } from '@tn3270/core';
import type { Action } from './keymap.js';

/**
 * Apply one named action to a session.
 *
 * ## THIS FILE DECIDES NOTHING ABOUT 3270 SEMANTICS
 *
 * The field-aware typing rules, the tab order, the keyboard lock and the AID semantics all live
 * in core and are tested there. If a branch here grows logic, that logic is in the wrong
 * package. It is shared because it is the one translation every front end needs and none of
 * them should own: the CLI's command table, the TUI's keymap and the GUI's KeyboardEvent mapper
 * all produce these same names.
 *
 * ## EVERY `KeyAction` KIND GOES THROUGH `Session.run`, AND NOTHING ELSE HERE DOES
 *
 * `Session.run` (`core/src/session.ts`) is the keyboard-semantics feature's "one way in": it is
 * where a key is dropped while disconnected, queued behind a host lock (the OIA's typeahead `T`),
 * cleared-then-acted under an operator error, or performed immediately -- see its own docstring
 * for the order, which mirrors x3270's `enq_xta`. Before this task (keyboard-semantics Task 9)
 * this function held its OWN switch, one case per `KeyAction` kind, each calling a `Keyboard` or
 * `Session` method directly -- which is exactly how an operator's keystroke bypassed every lock
 * rule `run` now enforces: a GUI, browser or TUI key reached the keyboard a script's `String()`
 * or `Enter()` never could, because only the CLI runner went through `run` before this. That
 * switch's INDIVIDUAL CASE BODIES, and the defects their commentary recorded (an out-of-range
 * `pf`/`pa` number coercing to AID 0x00, Dup/FieldMark not being AIDs, Sys Req's two wire forms,
 * Newline's plausible-swap neighbours), are gone from here: every case below is `session.run(
 * action)`, and `core/src/session.ts`'s `perform` is the switch that still has one case per
 * kind, reached by exactly the same route for every caller -- a key, a keypad button, or a
 * script action. The switch below still exists, but only to single out `enter`/`clear` for
 * `reconnectInstead` and to keep the `satisfies never` exhaustiveness check (see the note above
 * the `try`'s `default` arm). `frontend/test/actions.test.ts` still pins the old defects' shape;
 * they just redden a different file's test now.
 *
 * ## `quit` AND SEVEN OTHER FRONT-END-ONLY KINDS ARE NOT HANDLED HERE, AND THROW RATHER THAN
 * BEING IGNORED
 *
 * Teardown is the front end's: the TUI restores raw mode on every exit path, the GUI closes a
 * window. Silently ignoring `quit` would leave a front end that forgot to check for it simply
 * unquittable, and that failure would show up as a hang rather than an error. `toggleKeypad`,
 * `toggleKeyboard`, `geometryMenu`, `transferForm`, `copy`, `paste` and `requestCopy` are the
 * same shape for their own reasons, each explained where it guards below and on its member of
 * the `Action` union in `keymap.ts`. None of the eight is a `KeyAction`, so none of them could
 * reach `session.run` even by accident -- `KeyAction`'s type excludes them structurally, which
 * is what makes the exhaustiveness note on the switch's `default` arm below a compile-time
 * guarantee rather than a style preference.
 *
 * ## `enter` AND `clear` DEPEND ON THE CONNECTION STATE, WHICH NOTHING ELSE HERE DOES
 *
 * On a DISCONNECTED session they reconnect to the last host instead of sending their AID. That is a
 * divergence from x3270 and the one piece of state-dependent dispatch in this file, so it has its own
 * commentary: see `reconnectInstead` below, and do not touch either case without reading it.
 *
 * ## A REJECTED ACTION IS SWALLOWED
 *
 * Not connected, an operator error, a host lock, or a program check, is normal operation rather
 * than a crash — and the OIA already says why (`X Protected`, the typeahead `T`, ...), so the
 * caller's redraw shows it. `session.run`'s `RunResult` (`'done' | 'queued' | 'dropped' |
 * 'refused'`) is discarded here for the same reason `typeString`'s old boolean return was: it
 * REPORTS rather than throws, so there is nothing to catch and nothing to do. `pfAID`/`paAID`
 * still THROW on an out-of-range number, from inside `session.run`'s `perform`, and the `catch`
 * below still swallows that the same way it always has.
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
  // THE FOURTH OF THE SAME SHAPE, and outside the `try` for the reason the three above give: the
  // catch-all would swallow the throw and hand back the silent no-op it exists to prevent.
  //
  // What a clipboard IS differs per front end, which is why this cannot be dispatched here: the
  // Electron GUI has an OS clipboard, the gateway has the operator's browser at the far end of a
  // socket, and the CLI and TUI have neither. The action carries a RECTANGLE rather than text
  // because the renderer that raises it has no characters to send -- see the union member.
  if (action.kind === 'copy') {
    throw new Error('applyAction does not handle copy: the front end owns its own clipboard');
  }
  // THE FIFTH OF THE SAME SHAPE, 2026-10-22, and outside the `try` for the reason the four above
  // give. The full 122-key keyboard is a surface, and which surface -- an Electron window or an
  // in-pane overlay -- is the front end's business, exactly as the keypad's is. Two of the four
  // front ends have one at all; the TUI cannot draw a keyboard inside 24x80 and the CLI has no
  // interactive surface.
  if (action.kind === 'toggleKeyboard') {
    throw new Error(
      'applyAction does not handle toggleKeyboard: the front end owns its own display',
    );
  }
  /*
    THE SIXTH OF THE SAME SHAPE, 2026-10-23, and outside the `try` for the reason the five above
    give: a kind whose meaning depends on WHOSE MACHINE it lands on, so the front end owns it.
    `copy` reads that machine's clipboard; `paste` writes from it.

    IT COULD BE HANDLED HERE AND IS NOT, WHICH IS A POLICY CHOICE RATHER THAN A CONSTRAINT -- said
    plainly because the spec for this feature first claimed the opposite. `pasteString` needs a
    `Screen` as well as a `Keyboard`, and this function HAS both: `session` carries them, and
    `gui/src/main.ts` already calls `pasteString(session.keyboard, session.screen, text)`. What
    rules it out is the pattern -- `quit`, `toggleKeypad`, `toggleKeyboard`, `transferForm` and
    `copy` all throw here for the same reason, and a front end that forgot the arm fails loudly
    rather than being silently inert.

    AND THERE IS A SECOND, CONCRETE REASON, which the policy one should not be allowed to hide:
    `pasteString` RETURNS `{typed, dropped, reason?}`, and `applyAction` returns `void` inside a
    `try` that swallows everything. Dispatching it here would discard the one report that says a
    paste stopped early -- on a keyboard lock, or a wrap past the start -- which is the whole
    reason that return type exists.

    BOTH DOM FRONT ENDS THEN SHARE ONE HELPER (`pasteAction.ts`, Task 2), so the GUI's rules stop
    being private to its menu handler and the browser is not a second copy of them.
  */
  if (action.kind === 'paste') {
    throw new Error('applyAction does not handle paste: the front end owns its own clipboard');
  }
  /*
    THE SEVENTH OF THE SAME SHAPE, 2026-10-27, and outside the `try` for the reason the six above
    give: the catch-all would swallow the throw and hand back the silent no-op it exists to prevent.

    ITS REASON IS NOT "WHOSE MACHINE", WHICH IS WHAT MAKES IT A SEVENTH GUARD RATHER THAN A COPY OF
    THE FIFTH AND SIXTH. `copy` and `paste` are the front end's because a clipboard belongs to the
    operator; this kind is the front end's because the SELECTION does. It carries no rect at all,
    and the rectangle is exactly what a copy needs: it lives in `canvas/src/renderer.ts`'s
    module-level `anchor`/`focus`, which this function cannot reach and which `actionForKey` --
    pure, given one key event -- cannot reach either. So the chord raises the intent and the
    renderer converts it to a real `copy`.

    SO THIS IS AN UNSATISFIABLE REQUEST HERE AND NOT MERELY AN UNWELCOME ONE, which is why it
    throws rather than being handled: there is no argument this function could supply.
  */
  if (action.kind === 'requestCopy') {
    throw new Error(
      'applyAction does not handle requestCopy: only the renderer knows the selection',
    );
  }
  /*
    THE EIGHTH OF THE SAME SHAPE, 2026-11-04, and outside the `try` for the reason the seven above
    give: the catch-all would swallow the throw and hand back the silent no-op it exists to prevent.

    ITS REASON IS `toggleKeyboard`'S: the model/oversize chooser is a SURFACE -- a native menu in the
    Electron GUI, a DOM overlay in the browser -- and which surface is the front end's business. The
    TUI and CLI have none (one resizes, the other has `Set(model,...)`), so no `Session` ever needs
    to see the kind. What the operator then CHOOSES is not this action at all.
  */
  if (action.kind === 'geometryMenu') {
    throw new Error(
      'applyAction does not handle geometryMenu: the front end owns its own display',
    );
  }
  try {
    switch (action.kind) {
      // ENTER AND CLEAR MEAN TWO DIFFERENT THINGS, AND WHICH ONE IS DECIDED BY `isConnected()`.
      // Read the block comment below before touching either case: "Enter submits the screen,
      // except when it doesn't" is the whole of what a maintainer needs to be told here. The
      // reconnect is checked BEFORE `session.run`, not inside it: `run` has no concept of a
      // disconnected session doing anything other than dropping the action, because the
      // reconnect is this file's own divergence from x3270, not one of `run`'s lock rules.
      case 'enter':
      case 'clear':
        if (reconnectInstead(session)) break;
        session.run(action);
        break;
      // EVERY OTHER `KeyAction` KIND, THROUGH `Session.run` AND NOTHING ELSE (keyboard-semantics
      // Task 9). Before this task each of these 22 cases called a `Keyboard` or `Session` method
      // directly -- `k.left()`, `session.sendAID(pfAID(action.n))`, `k.dup()`, and so on -- which
      // is exactly how a GUI, browser or TUI key bypassed every lock rule `run` now enforces: a
      // key typed under a host lock reached the buffer when only the CLI runner went through
      // `run` first. `core/src/session.ts`'s `perform` is that switch now, one case per
      // `KeyAction` kind, reached by the identical route whether the caller is a key, a keypad
      // button, or a script action; its own comments carry the per-kind detail that used to live
      // here (the out-of-range `pf`/`pa` number that once coerced to AID 0x00, Dup/FieldMark
      // being typed characters and not AIDs, Sys Req's two wire forms). `actions.test.ts` still
      // pins the behaviour; it reads `session.ts`'s source for it now, not this switch's.
      // `backSpaceLeft` ADDED (Task 10): the CLI's `BackSpace()` only -- no key or keypad
      // button produces it (see `keyAction.ts`'s comment on the kind) -- but `KeyAction` is
      // shared, so this switch must stay exhaustive over it like every other member.
      case 'type': case 'pf': case 'pa': case 'reset':
      case 'up': case 'down': case 'left': case 'right': case 'home': case 'tab': case 'backTab':
      case 'newline': case 'backspace': case 'delete': case 'eraseEOF': case 'eraseInput':
      case 'dup': case 'fieldMark': case 'insert': case 'toggleInsert': case 'attn': case 'sysreq':
      case 'backSpaceLeft':
        session.run(action);
        break;
      // EXHAUSTIVENESS, WITH NO RUNTIME FOOTPRINT. `satisfies never` is a type-level assertion
      // that every member has been handled above: it emits `default: action;` and nothing else, so
      // an unrecognized `kind` arriving from untrusted JSON is still the silent no-op that
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
 * "reconnect" appears nowhere in that file. x3270 reaches this behavior two other ways — the
 * `Reconnect()` ACTION (`Common/host.c`, which we also expose, as the CLI's `Reconnect()`), and the
 * `reconnect` RESOURCE (`Common/glue.c`) that redials automatically. We follow x3270 where it has an
 * answer; here it has one for scripts and none for a keyboard, and this is the gap that fills.
 *
 * ## WHY HERE, AND NOT IN EACH FRONT END
 *
 * `applyAction` is the one translation the TUI, the GUI and the browser share, and the behavior is
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
