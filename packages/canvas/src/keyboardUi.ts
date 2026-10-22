/*
  A DEEP PATH, NOT THE BARE SPECIFIER, AND IT IS FORCED. `web/static/index.html`'s import map
  resolves `@tn3270/frontend` to `keypadView.js` -- ONE SPECIFIER CANNOT NAME TWO FILES -- and that
  module exports no `KEYBOARD_3279`. Importing it bare makes THIS module fail to evaluate in the
  browser, and the only symptom is `window.tn3270` never being assigned: measured as a blank
  canvas with `Cannot read properties of undefined (reading 'onAtlas')` in the console, and `0/7`
  from `browser-clicks.mjs`, which reads like a total regression rather than a bad import.

  `transferUi.ts` imports `@tn3270/frontend/dist/transferForm.js` for exactly the same reason, and
  every such path needs its OWN entry in that import map.
*/
import {
  KEYBOARD_3279, SHIFT_NAME, type KeyCap,
} from '@tn3270/frontend/dist/keyboard3279.js';
import type { Action } from '@tn3270/frontend/dist/keymap.js';

/**
 * The full 122-key 3279 keyboard, built into a DOM.
 *
 * ## THE SAME INJECTED-DOM SHAPE AS `keypadUi.ts`, FOR THE SAME REASON
 *
 * Nothing here touches a real `document`: the caller supplies `create`/`append`/`setText` and the
 * rest. That is what lets this be unit-tested in `environment: 'node'` with a hand-rolled fake,
 * and jsdom is deliberately not a dependency of this repo. `KEYBOARD_3279` in `packages/frontend`
 * stays the single authority on which keys exist, what each does and where it sits -- this file
 * decides none of that, so a cap corrected in the table appears here with no edit.
 *
 * ## THIS FILE OWNS EXACTLY ONE PIECE OF BEHAVIOUR: THE ONE-SHOT SHIFT
 *
 * Everything else is layout. The Shift rules are the user's, verbatim: *"if you hit it the next
 * regular character you type acts as if you'd shifted it, and then shift unselects. Basically the
 * same as Caps Lock but it unsets itself after the next character."* They live HERE rather than in
 * the table or in either front end because they are logic, and logic in a shared view is logic
 * both front ends get and one test covers -- the same split `transferUi.ts` uses.
 */

export interface KeyboardDeps {
  /** The element the regions are appended to. */
  readonly root: HTMLElement;
  readonly create: (tag: string) => HTMLElement;
  readonly append: (parent: HTMLElement, child: HTMLElement) => void;
  readonly setText: (el: HTMLElement, text: string) => void;
  readonly setTitle: (el: HTMLElement, title: string) => void;
  readonly setAttr: (el: HTMLElement, name: string, value: string) => void;
  readonly removeAttr: (el: HTMLElement, name: string) => void;
  readonly onClick: (el: HTMLElement, fn: () => void) => void;
  /** Fire a key's action at the session. */
  readonly sendAction: (action: Action) => void;
}

export interface KeyboardUi {
  /** Is the one-shot Shift armed? For a caller that wants to paint something of its own. */
  shiftArmed(): boolean;
  /**
   * Clear the arm.
   *
   * CALLED WHEN THE SURFACE CLOSES, which is the sixth of the user's rules: a keyboard reopened
   * later must not still be holding a Shift nobody remembers pressing. The overlay's `onHide`
   * is the caller.
   */
  disarmShift(): void;
}

/** Is this the Shift cap? Matched on the name PREFIX, so left and right both qualify. */
const isShiftCap = (cap: KeyCap): boolean => cap.name.startsWith(SHIFT_NAME);

/**
 * Build the keyboard into `deps.root` and return its Shift state.
 *
 * NOT IDEMPOTENT, and it does not need to be: both callers build once. The GUI window builds at
 * load; the web overlay builds lazily on its first toggle and then never again -- rebuilding 117
 * buttons per keystroke would be invisible work that also discards focus.
 */
export function createKeyboardUi(deps: KeyboardDeps): KeyboardUi {
  /**
   * The one-shot arm. A single boolean, and deliberately not a count or a mode enum: there is one
   * level of Shift on this keyboard and no latch.
   */
  let armed = false;

  /** Every Shift button, so arming can paint both of them. */
  const shiftButtons: HTMLElement[] = [];

  const paintShift = (): void => {
    for (const button of shiftButtons) {
      // AN ATTRIBUTE RATHER THAN A CLASS, so `ui.css` can key off `[data-armed='true']` and a
      // harness can read the state without parsing a class list.
      if (armed) deps.setAttr(button, 'data-armed', 'true');
      else deps.removeAttr(button, 'data-armed');
    }
  };

  // Group the caps by region, then by row, PRESERVING THE TABLE'S ORDER within a row -- the table
  // is frozen and already in left-to-right order, and sorting here would be a second opinion
  // about the layout.
  const regions = new Map<string, Map<number, KeyCap[]>>();
  for (const cap of KEYBOARD_3279) {
    const rows = regions.get(cap.region) ?? new Map<number, KeyCap[]>();
    const row = rows.get(cap.row) ?? [];
    row.push(cap);
    rows.set(cap.row, row);
    regions.set(cap.region, rows);
  }

  for (const [region, rows] of regions) {
    const section = deps.create('div');
    deps.setAttr(section, 'class', 'keyboard-region');
    // PREFIXED, like the keypad's ids: this element shares a document with the transfer form and
    // the keypad in the web overlay's case, and `keyboard-main` cannot collide where `main` might.
    deps.setAttr(section, 'id', `keyboard-${region}`);

    for (const [, caps] of [...rows].sort((a, b) => a[0] - b[0])) {
      const line = deps.create('div');
      deps.setAttr(line, 'class', 'keyboard-row');
      for (const cap of caps) {
        const button = deps.create('button');
        // `type=button` EXPLICITLY: a bare <button> inside a form defaults to type=submit, which
        // would turn a PF key into a page reload if a form ever shared this document.
        deps.setAttr(button, 'type', 'button');
        /*
          THE HANDLE A HARNESS USES IS THE `name`, NOT THE LABEL, and that is a correction this
          table's own history forced: several caps' printed legends are glyphs the reference
          photograph could not resolve, one cap is the SPACEBAR whose label is empty, and `Enter`
          appears twice. A name is unique, readable and stable; a label is none of the three.
        */
        deps.setAttr(button, 'data-key', cap.name);
        // THE WIDTH TRAVELS AS A CUSTOM PROPERTY so `ui.css` multiplies it by one pitch variable.
        // Key units in, pixels decided there -- see `keyboard3279.ts` on why the table holds units.
        deps.setAttr(button, 'style', `--kb-w:${cap.width}`);
        deps.setText(button, cap.label);
        deps.setTitle(button, cap.name);

        if (isShiftCap(cap)) {
          shiftButtons.push(button);
          /*
            SHIFT IS NEITHER `disabled` NOR ACTIONABLE, which is why it is handled before the
            inert branch below. Its `action` is `undefined` in the table -- arming it sends nothing
            anywhere -- but it is a LIVE control, so it must not get the grey scenery styling that
            `[disabled]` selects. An inert cap and an actionless-but-live cap look different on
            purpose.
          */
          deps.setAttr(button, 'data-shift', 'true');
          deps.onClick(button, () => {
            armed = !armed;
            paintShift();
          });
          deps.append(line, button);
          continue;
        }

        if (cap.action === undefined) {
          /*
            AN INERT CAP: DRAWN, DISABLED, AND IT DOES NOT TOUCH THE ARM.

            `disabled` is what makes the click a genuine no-op and keeps keyboard and
            screen-reader behaviour correct; `ui.css` styles it in `GrayText` on a recessed cap
            rather than with the house `opacity: 0.5`, and says there why at length.

            NO CLICK HANDLER AT ALL, deliberately. A handler that returned early would be a second
            place for the no-op to be wrong, and `disabled` already stops the event.
          */
          deps.setAttr(button, 'disabled', '');
          deps.append(line, button);
          continue;
        }

        const action = cap.action;
        const shiftLabel = cap.shiftLabel;
        deps.onClick(button, () => {
          /*
            THE ONE-SHOT SHIFT, AND THE ORDER OF THESE TWO BRANCHES IS THE SPECIFICATION.

            A cap WITH a `shiftLabel` consumes the arm and sends the shifted text. A cap WITHOUT
            one -- a PF key, `Enter`, a cursor arrow -- sends its own action and LEAVES THE ARM
            ALONE.

            THAT SECOND HALF IS THE RULE MOST LIKELY TO BE GOT WRONG, and it is the user's
            explicit intent rather than an edge case nobody considered: 3270 has no shifted `PF3`,
            so eating the arm there would make the modifier feel broken -- press Shift, reach for
            a character, and find it unshifted because a PF key stole the arm on the way. The test
            asserts it in both directions.
          */
          if (shiftLabel !== undefined && armed) {
            armed = false;
            paintShift();
            deps.sendAction({ kind: 'type', text: shiftLabel });
            return;
          }
          deps.sendAction(action);
        });
        deps.append(line, button);
      }
      deps.append(section, line);
    }
    deps.append(deps.root, section);
  }

  return {
    shiftArmed: () => armed,
    disarmShift: () => {
      armed = false;
      paintShift();
    },
  };
}
