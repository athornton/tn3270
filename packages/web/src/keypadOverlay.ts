/**
 * The web gateway's keypad: an OPAQUE OVERLAY IN THE SAME PANE, not a second window.
 *
 * ## WHY THE WEB DIFFERS FROM THE GUI, DELIBERATELY
 *
 * The Electron GUI opens a real `BrowserWindow` the operator can place beside the terminal. A
 * browser tab cannot do that: `window.open` for a palette is a popup-blocked second document that
 * would need its own WebSocket and its own session. The pane is what the web has, so the keypad
 * floats over it. The user's call, 2026-10-06, and the asymmetry is the answer rather than an
 * inconsistency to tidy away.
 *
 * ## OPAQUE AND NOT TRANSLUCENT, WITH A MEASURED REASON
 *
 * `ui.css` sets `background: Canvas` on `#keypad-overlay`. That is not a default: the TUI's own
 * keypad overlay once had host text leak through into its chord column, and opacity was the
 * hard-won fix. An overlay that lets the screen show through is a legibility bug waiting to be
 * re-found, and a 3270 screen behind 48 buttons is a dense background to read over.
 *
 * ## IT FLOATS OVER THE CANVAS AND NEVER DISPLACES IT
 *
 * `position: fixed` in `ui.css`, which is load-bearing rather than cosmetic: `gui/src/main.ts`
 * records that the click path's `offsetX` arithmetic depends on the canvas sitting at the viewport
 * origin -- "give the page a body margin and every click here misses by it". A sibling in normal
 * flow would push the canvas down and break the OTHER front end's keypad clicks via the shared
 * renderer. Fixed positioning paints over it without moving it.
 *
 * ## NO SESSION STATE, AND NO SERVER ROUND TRIP
 *
 * Until this existed, `toggleKeypad` crossed the WebSocket: the keypad was a region of the draw
 * list the SERVER built, so `web/src/main.ts` flipped a flag and repainted. A DOM overlay is drawn
 * in the browser, so the server has nothing to do with it -- `bridgecore.ts` intercepts the action
 * client-side. The server's own intercept STAYS, for the reason recorded there.
 */
export interface OverlayDeps {
  readonly element: HTMLElement;
  /**
   * Fill the overlay with buttons. Called AT MOST ONCE, lazily, on the first toggle.
   *
   * Injected rather than imported so this module needs no DOM at all: the caller in `bridge.ts`
   * owns the real `document` and this owns the visibility rules, which is the same split
   * `bridgecore.ts` uses for its socket.
   */
  readonly build: () => void;
}

export interface KeypadOverlay {
  /** Show if hidden, hide if shown. Builds the buttons on the first call. */
  toggle(): void;
  /** Hide it. Idempotent, so a second close cannot re-show. */
  hide(): void;
}

export function createKeypadOverlay(deps: OverlayDeps): KeypadOverlay {
  let built = false;
  // HIDDEN AT THE START, which is the no-persistence decision made explicit in code rather than
  // left to the markup's own `hidden` attribute. Either alone is removable by someone who sees
  // the other; both is cheap. It also covers a REATTACHING client, which the gateway's existing
  // rule says must not inherit a previous session's keypad state.
  deps.element.hidden = true;

  /**
   * BUILT LAZILY AND EXACTLY ONCE.
   *
   * Lazily because most sessions never open the keypad and 48 buttons at page load would cost
   * every session for the few that do -- the GUI's window is lazy for the same reason. Once
   * because rebuilding per toggle is invisible work that ALSO discards focus: tab to a button,
   * hide, show, and the caret is gone.
   */
  const ensureBuilt = (): void => {
    if (built) return;
    deps.build();
    built = true;
  };

  return {
    toggle: () => {
      ensureBuilt();
      deps.element.hidden = !deps.element.hidden;
    },
    // ASSIGNED, not toggled: `hidden = !hidden` here would make a second close RE-SHOW the
    // overlay, which is exactly what a double-click on the close button would do.
    hide: () => { deps.element.hidden = true; },
  };
}
