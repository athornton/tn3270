/**
 * The web gateway's FULL KEYBOARD: an opaque, bottom-docked overlay in the same pane.
 *
 * ## A SIBLING OF `keypadOverlay.ts`, NOT A GENERALISATION OF IT
 *
 * The two share four rules and differ in one, and that one is why this is a second small file
 * rather than a parameter added to the first: **this surface has an `onHide`**, because closing it
 * must disarm the one-shot Shift (`keyboardUi.ts`). Giving the keypad an optional callback it never
 * uses would make both files harder to read than having two, and the keypad may be deleted
 * outright later -- the user wants both surfaces "at least for now" and may drift to this one
 * alone, so nothing here depends on that file existing.
 *
 * ## THE FOUR RULES IT KEEPS, ALL FOR THE REASONS THE KEYPAD'S VERSION RECORDS
 *
 *  - HIDDEN AT THE START, in code as well as in the markup's `hidden` attribute. Either alone is
 *    removable by someone who sees the other, and this also covers a REATTACHING client, which the
 *    gateway's own rule says must not inherit a previous session's display state.
 *  - BUILT LAZILY AND EXACTLY ONCE. 117 buttons at page load would cost every session for the few
 *    that open it, and rebuilding per toggle is invisible work that ALSO discards focus.
 *  - `hide()` ASSIGNS rather than toggles, so a second close cannot re-show.
 *  - OPAQUE, via `background: Canvas` in `ui.css`. `keypadOverlay.ts` records that opacity is
 *    load-bearing: the TUI's keypad once let host text bleed into its chord column, and a 3270
 *    screen behind 117 buttons is a denser background still.
 *
 * ## IT DOES NOT KNOW ABOUT THE KEYPAD
 *
 * "Opening one closes the other" is the CALLER's rule, in `bridge.ts`, which holds both. Putting it
 * here would make each overlay depend on the other and give the pair two places to disagree about
 * which is open.
 */

export interface KeyboardOverlayDeps {
  readonly element: HTMLElement;
  /**
   * Fill the overlay with the keyboard. Called AT MOST ONCE, lazily, on the first toggle.
   *
   * Injected rather than imported so this module needs no DOM at all: the caller owns the real
   * `document` and this owns the visibility rules -- the same split `keypadOverlay.ts` and
   * `bridgecore.ts` both use.
   */
  readonly build: () => void;
  /**
   * Called whenever the surface becomes hidden, by either route.
   *
   * THE ONE THING THIS OVERLAY HAS THAT THE KEYPAD'S DOES NOT, and the sixth of the user's Shift
   * rules is why: a keyboard reopened later must not still be holding a Shift nobody remembers
   * pressing. `bridge.ts` passes `ui.disarmShift`.
   *
   * CALLED ON EVERY TRANSITION TO HIDDEN, including a `toggle()` that closes and a `hide()` on an
   * already-hidden element -- the latter being harmless, since disarming twice is disarming once.
   * Not called when `toggle()` OPENS it.
   */
  readonly onHide: () => void;
}

export interface KeyboardOverlay {
  /** Show if hidden, hide if shown. Builds the buttons on the first call. */
  toggle(): void;
  /** Hide it. Idempotent, so a second close cannot re-show. */
  hide(): void;
  /** Is it currently shown? `bridge.ts` reads this to close the other surface. */
  visible(): boolean;
}

export function createKeyboardOverlay(deps: KeyboardOverlayDeps): KeyboardOverlay {
  let built = false;

  deps.element.hidden = true;

  const ensureBuilt = (): void => {
    if (built) return;
    deps.build();
    built = true;
  };

  return {
    toggle: () => {
      ensureBuilt();
      const nowHidden = !deps.element.hidden;
      deps.element.hidden = nowHidden;
      if (nowHidden) deps.onHide();
    },
    hide: () => {
      deps.element.hidden = true;
      deps.onHide();
    },
    visible: () => !deps.element.hidden,
  };
}
