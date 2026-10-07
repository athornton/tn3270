/**
 * The web gateway's transfer form: AN OPAQUE OVERLAY IN THE SAME PANE, like the keypad.
 *
 * ## THE THREE RULES INHERITED FROM `keypadOverlay.ts`, ALL LOAD-BEARING
 *
 * 1. **Opaque, not translucent.** `ui.css` sets `background: Canvas` on the overlay (mirroring
 *    `#keypad-overlay`, `packages/gui/ui.css:148`). The TUI's own keypad overlay once let host
 *    text leak through into its chord column, and opacity was the hard-won fix -- a form over a
 *    3270 screen is worse, because these are editable fields rather than read-only chords.
 * 2. **`position: fixed`, so it paints OVER the canvas without displacing it.** `gui/src/main.ts`
 *    records why that is not cosmetic: the click path's `offsetX` arithmetic depends on the
 *    canvas sitting at the viewport origin. A sibling in normal flow would push it down and break
 *    the OTHER front end's clicks too, via the shared renderer -- `browser-clicks.mjs` found
 *    exactly that once, `ui.css` styling `body` and displacing the canvas by 15px.
 * 3. **Built lazily, at most once.** Rebuilding the form per keystroke would be invisible work
 *    that also discards focus: tab to a field, hide, show, and the caret is gone.
 *
 * ## VISIBILITY IS `element.hidden`, NOT `element.style.display`, AND THAT IS LOAD-BEARING
 *
 * `keypadOverlay.ts` sets `deps.element.hidden` throughout, and `packages/gui/ui.css:153` is
 * `#keypad-overlay[hidden] { display: none; }` -- visibility there is driven by the ATTRIBUTE
 * through the stylesheet, with the matching `#transfer-overlay[hidden]` rule for this overlay
 * (Task 8). Writing `style.display` here would bypass that rule and WIN OVER IT by specificity
 * (an inline style beats a stylesheet selector), which is how this surface would silently diverge
 * from the keypad's rather than share its mechanism.
 *
 * ## WHY IT WARNS BEFORE CLOSING, WHICH THE KEYPAD DOES NOT NEED
 *
 * A completed receive holds its bytes until the operator saves (`transferBridge.ts`'s
 * `hasUnsaved()`). Dismissing the overlay then loses a transfer that SUCCEEDED, with the host
 * already out of transfer mode and nothing to retry from -- the same thing
 * `transferRun.ts` (`packages/frontend/src/transferRun.ts:338-340`, `:404-406`) refuses to do
 * when it will not report a "complete" that left no file on disk. It is NOT a memory concern: 10
 * MB held in a browser is nothing beside its normal footprint, which is Decision 8 of the design
 * doc (`docs/superpowers/specs/2026-10-06-web-transfer-ui-design.md:305-306`) -- the warning here
 * is about losing a RESULT, not about holding bytes.
 */
export interface TransferOverlayDeps {
  readonly element: HTMLElement;
  /** Fill the overlay with the form. Called AT MOST ONCE, lazily, on the first show. */
  readonly build: () => void;
  /** Does a completed transfer still need saving? */
  readonly hasUnsaved: () => boolean;
  /** Ask the operator to confirm losing it. True means close anyway. */
  readonly confirmDiscard: () => boolean;
}

export interface TransferOverlay {
  /** Show it. Builds the form on the first call. */
  show(): void;
  /**
   * Hide it -- unless a completed transfer is still unsaved and the operator declines to discard
   * it, in which case this is a no-op and the overlay stays open.
   */
  hide(): void;
  /** Is it currently shown? */
  visible(): boolean;
}

export function createTransferOverlay(deps: TransferOverlayDeps): TransferOverlay {
  let built = false;
  let shown = false;
  // HIDDEN AT THE START, which is the no-persistence decision made explicit in code rather than
  // left to the markup's own `hidden` attribute. Either alone is removable by someone who sees
  // the other; both is cheap. It also covers a REATTACHING client, which the gateway's existing
  // rule says must not inherit a previous session's overlay state -- the same reasoning
  // `keypadOverlay.ts` carries for the keypad, applied here to the transfer form.
  deps.element.hidden = true;

  return {
    show() {
      // BUILT LAZILY AND EXACTLY ONCE, for the reasons the header gives: most sessions never
      // open the transfer form, and rebuilding it per show would discard whatever had focus.
      if (!built) { deps.build(); built = true; }
      shown = true;
      deps.element.hidden = false;
    },
    hide() {
      // A completed, unsaved transfer must not be silently discarded -- see the header's "WHY IT
      // WARNS" section. Declining leaves the overlay exactly as it was: open, with `shown` and
      // `deps.element.hidden` both untouched.
      if (deps.hasUnsaved() && !deps.confirmDiscard()) return;
      shown = false;
      // ASSIGNED, not toggled: `hidden = !hidden` here would make a second close RE-SHOW the
      // overlay, which is exactly what a double-click on the Close button would do. Matches
      // `keypadOverlay.ts`'s `hide()`.
      deps.element.hidden = true;
    },
    visible() { return shown; },
  };
}
