import { actionForKey, type KeyLike } from './keys.js';
import type { Action } from '@tn3270/frontend';

/**
 * Forward a window's real keystrokes to the 3270 session.
 *
 * ## WHY THIS EXISTS: THE GUI'S CHILD WINDOWS WERE DEAF
 *
 * `renderer.ts` has the product's ONLY other `keydown` listener and it lives in the CANVAS
 * window. The GUI's keypad and keyboard are separate `BrowserWindow`s, so with either focused the
 * physical keyboard did nothing at all -- not a dropped chord, silence. The user met it the day
 * the keyboard window shipped: a window full of keys is an invitation to type.
 *
 * **The web gateway never had this problem and needs nothing from this module.** Its surfaces are
 * `<div>` overlays in the canvas page, so one `window` listener already covers them. The
 * asymmetry is Electron's, and it is the GUI's alone.
 *
 * ## INJECTED DEPS, LIKE `keypadUi.ts` AND `keyboardUi.ts`
 *
 * Nothing here touches a real `window`: the caller supplies `on` and `sendAction`. That is what
 * lets this be unit-tested in `environment: 'node'` with a hand-rolled fake, and jsdom is
 * deliberately not a dependency of this repo.
 *
 * ## IT IMPORTS ONLY `keys.js`, WHICH IS THE WHOLE REASON IT IS A NEW FILE
 *
 * The obvious alternative was to export the listener from `renderer.ts`. That file value-imports
 * `blit.js` and `selection.js`, so a child window importing it would drag the whole rasteriser
 * into a document that has no canvas -- and every new specifier needs its own entry in two import
 * maps. `keys.js` has ZERO runtime imports, so each window's graph grows by exactly one file.
 */
export interface ForwardKeysDeps {
  /** Register the listener. The real caller passes `window.addEventListener`. */
  readonly on: (type: string, handler: (e: never) => void) => void;
  /** Deliver an action. The real caller passes its window's bridge. */
  readonly sendAction: (action: Action) => void;
}

/**
 * Is this event's target a thing the operator is typing INTO?
 *
 * ## EXTRACTED FROM `renderer.ts` RATHER THAN COPIED, 2026-10-23
 *
 * That file had this inline and now imports it. Two copies of a rule that must agree is how they
 * diverge, and this one is load-bearing: MEASURED 2026-10-07, without it typing into the web
 * gateway's transfer form sent every character TO THE MAINFRAME and left the field empty, because
 * `actionForKey` claims any single-code-point key as `{kind:'type'}` without knowing what was
 * focused, and the `preventDefault` that follows suppressed the character locally.
 *
 * ## CHECKED HERE AND NOT INSIDE `actionForKey`
 *
 * `keys.ts` is deliberately DOM-free -- `KeyLike` carries six scalars and no target, which is what
 * lets its cases run without jsdom. The target is a property of the EVENT, so the code that owns
 * real events owns this question.
 *
 * ## `BUTTON` IS DELIBERATELY NOT IN THE LIST
 *
 * Every cap on both surfaces is a `<button>`, and one of them holds focus after every click. A
 * predicate widened to "any form control" would make the keyboard window deaf again the moment an
 * operator clicked a key -- which is the exact bug this module exists to fix. The list is the
 * three TEXT-ENTRY tags plus `contentEditable`, and nothing else.
 */
export function isEditableTarget(
  target: { tagName?: unknown; isContentEditable?: unknown } | null,
): boolean {
  const tag = typeof target?.tagName === 'string' ? target.tagName : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || target?.isContentEditable === true;
}

/** The shape this module reads off a real `KeyboardEvent`. */
type KeyEventLike = KeyLike & {
  readonly target: { tagName?: unknown; isContentEditable?: unknown } | null;
  readonly preventDefault: () => void;
};

/**
 * Install the listener. Called once per window, at load.
 *
 * ALL CHORDS WORK EVERYWHERE, which is the user's decision of 2026-10-23 and not an oversight:
 * `Ctrl-B` pressed in the keyboard window raises `toggleKeyboard`, which `main.ts` answers by
 * showing and focusing the window that is already open -- a harmless self-focus.
 * `openKeyboardWindow` is idempotent precisely so a repeated chord cannot stack a second window.
 * Special-casing the two toggle chords would add a second place for the rule to be wrong.
 */
export function forwardKeys(deps: ForwardKeysDeps): void {
  deps.on('keydown', (raw: never) => {
    const e = raw as unknown as KeyEventLike;
    if (isEditableTarget(e.target)) return;
    const action = actionForKey(e);
    if (action === null) return;
    // `preventDefault` ONLY for keys we CLAIMED, so shortcuts we do not use keep working and Tab
    // does not move focus out of the window. `renderer.ts` makes the same call for the same reason.
    e.preventDefault();
    deps.sendAction(action);
  });
}
