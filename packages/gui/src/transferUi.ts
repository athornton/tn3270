import {
  TRANSFER_FIELDS, applicable, cycleField, formKeywords, newTransferForm, setFieldText,
  type TransferFieldId, type TransferFormState, type TransferValues,
} from '@tn3270/frontend';

/**
 * The transfer form's browser-side logic, with the DOM INJECTED.
 *
 * ## WHY THE DOM IS INJECTED AND NOT REACHED FOR
 *
 * `vitest.config.ts` sets `environment: 'node'`, so there is no `document` in any test in this
 * repo and jsdom is not a dependency. The same constraint produced the same shape in
 * `packages/web/src/bridgecore.ts`, which takes its socket as a dependency: the logic worth
 * testing -- which fields are shown, what the model holds, what is submitted -- needs no real
 * element, and injecting the few operations that do keeps every line of it reachable from a
 * unit test.
 *
 * ## THE MODEL IS THE AUTHORITY, AND THE CLEARING MUST HAPPEN THERE
 *
 * Every edit goes through `cycleField`/`setFieldText` from `@tn3270/frontend`, whose
 * `clearInapplicable` iterates to a fixed point because the applicability rules CHAIN. Doing
 * the hiding in the DOM and keeping the value here would let this front end submit a keyword
 * the TUI would have wiped -- two front ends disagreeing about what reaches a live host.
 *
 * ## A BROWSER LOADS THIS, AND AN IMPORT MAP IS WHAT MAKES THAT LEGAL
 *
 * The import above is a BARE SPECIFIER and stays one in the emitted JS -- deliberately, not by
 * omission. `tsc` rewrites nothing (measured 2026-10-01: `dist/transferUi.js` line 1 carries
 * `from '@tn3270/frontend'`, and it is the file's ONLY runtime import, the type-only ones
 * having been erased).
 *
 * `transfer.html` carries an import map that resolves that specifier to
 * `../frontend/dist/transferForm.js`. The browser applies the map BEFORE it fetches anything,
 * so `packages/frontend/dist/index.js` -- the package barrel -- is never requested, and
 * `tls.js`'s `node:net`/`node:tls`/`node:fs` imports, which no browser can resolve, are never
 * reached. All six names imported here are exported directly by `transferForm.js` (verified),
 * so the one map entry satisfies the whole list.
 *
 * `transferForm.js` has ZERO runtime imports of its own (9139 bytes, measured 2026-10-01), so
 * the module graph closes at that single file. That is a FACT WITH A DATE, not an invariant:
 * `transferModule.test.ts` pins the property, and the day it expires this window goes blank
 * with no error in any console.
 *
 * SO DO NOT ADD A SECOND WORKSPACE IMPORT TO THIS FILE. The map has one entry; a new bare
 * specifier would resolve to nothing, and the failure arrives as a blank window rather than as
 * an error. Anything else this module needs comes in through `UiDeps`.
 *
 * No unit test in this file can detect any of that -- a fake DOM cannot fail to resolve a
 * module. The window must be LOADED and seen to paint, which is Task 8's Electron harness's
 * job; a blank-window-with-no-error is this repo's most-repeated failure, met five separate
 * ways already.
 */

/** One field as the view needs it: what to draw, and what it currently holds. */
export interface UiField {
  readonly id: TransferFieldId;
  readonly label: string;
  readonly kind: 'cycle' | 'text' | 'numeric';
  readonly value: string;
  /** For a cycle field, the values it offers here; empty otherwise. */
  readonly options: readonly string[];
}

/**
 * Where the caret belongs after a rebuild, as a PURE FUNCTION OF THREE VALUES.
 *
 * ## WHY THIS LIVES HERE AND NOT IN `transferBoot.ts`
 *
 * It was in `transferBoot.ts`, inline, and it was WRONG -- measured in real Electron: `Lrecl`
 * holding `800`, caret at 1, type a non-digit `x`, and the caret ended at 2 when it should have
 * been 1. Unreachable by any test, because `transferBoot.ts` cannot be imported without a
 * `document`. It is arithmetic on three values and needs no element at all, so it belongs on this
 * side of the injected-DOM boundary, where the rest of the decidable logic already is and where a
 * unit test can reach it. `transferBoot.ts` keeps only the `setSelectionRange` call.
 *
 * This module rather than a new sibling file: a sibling would add an edge to the browser's import
 * graph, and every blank-window failure this repo has met came from that graph. Here there is no
 * new edge -- `transferBoot.ts` already imports this file. The file's stated job is "browser-side
 * logic with the DOM injected", and a caret calculation with its element removed is exactly that.
 *
 * ## THE CONTRACT IS DEFINED BY LENGTH DIFFERENCE, NOT BY "ACCEPTED" OR "REFUSED"
 *
 * This function cannot know WHY the two strings differ, so it does not try. The caller supplies:
 *
 * - `remembered`: the caret as the browser reported it, which is AFTER the browser applied the
 *   keystroke and BEFORE the model saw it. That off-by-one-keystroke capture is the whole bug.
 * - `typed`: what the input was DISPLAYING at that moment, i.e. including that keystroke.
 * - `shown`: what the rebuilt element will display, i.e. what the model now holds.
 *
 * The caret moves left by however much the model dropped: `typed.length - shown.length`. An
 * accepted edit drops nothing and the caret stays where the browser put it. A refused edit drops
 * exactly the characters the browser had inserted, so the caret lands where it was before them.
 *
 * DEFINING IT AS "REFUSED MEANS BACK EXACTLY ONE" WOULD BE WRONG, and not only for the obvious
 * reason that a paste inserts many. It is also not implementable: `rememberFocus` reads the input
 * AFTER the keystroke, so it never observes the pre-keystroke string that such a rule would have
 * to compare against. The length difference is both correct for a paste and derivable from what
 * can actually be observed.
 *
 * ## WHAT IT DOES NOT HANDLE
 *
 * A model that CHANGED a value rather than accepting or refusing it -- same length, different
 * characters, or a rewrite that inserts as much as it removes. `setFieldText` and `cycleField`
 * only ever accept wholesale or return the state untouched, so no such edit exists today. If one
 * is ever added, this returns a caret that is numerically in range and semantically meaningless,
 * which is a real limit and not a safe one. Stated rather than papered over.
 */
export function caretAfterEdit(
  remembered: { readonly start: number | null; readonly end: number | null },
  typed: string,
  shown: string,
): { start: number; end: number } {
  const clamp = (n: number): number => Math.max(0, Math.min(n, shown.length));
  // A `<select>` has a null selection, and so does an input the browser declined to report one
  // for. The end of the text is the least surprising place for a caret nobody specified.
  if (remembered.start === null) return { start: shown.length, end: shown.length };
  const dropped = typed.length - shown.length;
  const start = clamp(remembered.start - dropped);
  const end = clamp((remembered.end ?? remembered.start) - dropped);
  // A collapsed caret is the common case and an inverted range is not expressible, so a selection
  // whose ends crossed under clamping collapses to its start rather than throwing in the DOM.
  return { start, end: Math.max(start, end) };
}

/** Everything this module needs from the outside world. */
export interface UiDeps {
  /** Draw these fields, in this order. Called on every change. */
  render(fields: readonly UiField[]): void;
  /** The status line: an error, a progress report, or the help. */
  setStatus(text: string): void;
  /** Enable or disable the inputs, per the running state. */
  setRunning(running: boolean): void;
  /** Open a native file dialog. Resolves to a path, or undefined if canceled. */
  browse(direction: string): Promise<string | undefined>;
  /** Hand the keywords to main. A local refusal comes back as `ok: false`. */
  submit(keywords: readonly string[]): Promise<{ ok: boolean; error?: string }>;
  /** Abort a running transfer. */
  cancel(): void;
}

export interface TransferUi {
  values(): TransferValues;
  running(): boolean;
  cycle(id: TransferFieldId, delta: number): void;
  type(id: TransferFieldId, text: string): void;
  browseLocal(): Promise<void>;
  start(): Promise<void>;
  requestCancel(): void;
  progress(text: string): void;
  finished(result: { ok: boolean; error?: string; bytes?: number }): void;
}

const HELP = 'Choose a local file and name the host file, then Start.';

export function createTransferUi(deps: UiDeps): TransferUi {
  let state: TransferFormState = newTransferForm();
  let isRunning = false;

  /** Every applicable field, in tab order, with its current value and options. */
  const view = (): UiField[] => {
    const out: UiField[] = [];
    for (const f of TRANSFER_FIELDS) {
      if (!applicable(f.id, state.values)) continue;
      // The VM/Recfm asymmetry lives in the model's own cycle logic, so the options offered
      // here are derived by asking it rather than by re-filtering the table.
      const options = f.kind === 'cycle' ? offered(f.id) : [];
      out.push({
        id: f.id, label: f.label, kind: f.kind, value: state.values[f.id], options,
      });
    }
    return out;
  };

  /**
   * The values a cycle field offers, obtained by CYCLING THE MODEL rather than reading the
   * table -- then put back into the table's order.
   *
   * `valuesFor` is private to `transferForm.ts`, and the one state-dependent rule -- VM does
   * not offer `Recfm=undefined` -- lives inside it. Cycling from the current value until it
   * returns collects exactly what the model will accept, so this cannot drift from that rule.
   * Bounded by the field's own length, so a model that stopped wrapping cannot loop forever.
   *
   * THE SORT BACK INTO TABLE ORDER IS NOT COSMETIC. Cycling starts at the CURRENT value, so
   * the raw walk returns the list rotated: Recfm=variable yields
   * `['variable', 'undefined', '', 'fixed']`. A `<select>` built from that would reorder its
   * own menu every time the user picked an item. The cycle discovers WHICH values are legal
   * here; `TRANSFER_FIELDS` decides what order they are shown in.
   */
  const offered = (id: TransferFieldId): string[] => {
    const field = TRANSFER_FIELDS.find((f) => f.id === id);
    if (field === undefined) return [];
    const seen: string[] = [];
    let probe = state;
    for (let i = 0; i < field.values.length + 1; i++) {
      const v = probe.values[id];
      if (seen.includes(v)) break;
      seen.push(v);
      probe = cycleField(probe, id, 1);
    }
    // Filtering the TABLE by what the walk saw, rather than sorting `seen`, is what puts the
    // result in table order. Nothing can be lost: `cycleField` only ever assigns from
    // `valuesFor`, which is `field.values` or a filter of it.
    return field.values.filter((v) => seen.includes(v));
  };

  const redraw = (): void => { deps.render(view()); };

  const show = (): void => {
    if (state.error !== undefined) { deps.setStatus(state.error); return; }
    deps.setStatus(HELP);
  };

  redraw();
  show();

  return {
    values: () => state.values,
    running: () => isRunning,

    cycle(id, delta) {
      if (isRunning) return;
      state = cycleField(state, id, delta);
      redraw();
      show();
    },

    type(id, text) {
      if (isRunning) return;
      state = setFieldText(state, id, text);
      redraw();
      show();
    },

    async browseLocal() {
      if (isRunning) return;
      // The DIRECTION decides which dialog, which is why it is passed rather than inferred in
      // main: a send must choose an existing file (Open) and a receive names a destination
      // (Save). The dialog deliberately does NOT set `Exist` -- see the spec.
      const chosen = await deps.browse(state.values.direction);
      // THE `isRunning` CHECK IS DELIBERATELY DUPLICATED, because the `await` above is a
      // SUSPENSION POINT and the state can change across it. The check before it is not enough:
      // if the native dialog is not modal to this window the operator can press Start while it is
      // open, and a late resolution then lands in the middle of a running transfer. Measured in
      // real Electron with a deferred `browse`: the redraw's `show()` overwrote a live progress
      // line ("128 bytes") with the idle help text, and `setFieldText` mutated the form model
      // while the host was mid-transfer.
      //
      // THIS IS THE PRIMARY GUARD. `transferBoot.ts`'s `render` also reads a running flag when it
      // sets each control's `disabled`, which is now DEFENSE IN DEPTH rather than the primary
      // protection -- it covers the enablement third of the same hazard. Do not delete either half
      // on the evidence of a green suite: this repo has twice recorded that a defense-in-depth pair
      // is invisible to single mutation, because each half alone keeps the other's tests passing.
      if (isRunning) return;
      // A CANCELED DIALOG MUST NOT ERASE A TYPED PATH. `undefined` is "the user changed their
      // mind", and overwriting the field with it would destroy work for a misclick.
      if (chosen === undefined) return;
      state = setFieldText(state, 'localFile', chosen);
      redraw();
      show();
    },

    async start() {
      // A SECOND START WHILE ONE RUNS IS IGNORED, matching the TUI: two transfers would
      // interleave two machines' frames on one screen, and the host is answering only one.
      if (isRunning) return;
      const result = await deps.submit(formKeywords(state));
      if (!result.ok) {
        // A LOCAL REFUSAL LEAVES THE FORM OPEN AND POPULATED. Nothing reached the host, so the
        // user's next move is to fix one field -- a form that reset would make them retype ten.
        state = { ...state, error: result.error ?? 'transfer refused' };
        show();
        return;
      }
      isRunning = true;
      // THE ERROR FROM A PREVIOUS REFUSAL IS CLEARED HERE, because a submit that got through
      // makes the old message false and nothing else would ever clear it. Not during the
      // transfer -- `setStatus('transferring')` below is called directly, and every caller of
      // `show()` returns early while running -- but AFTERWARDS: the first edit the model
      // REJECTS (a non-digit into a numeric field, a cycle on a text field) returns the state
      // unchanged, so `error` is still set and `show()` resurfaces a stale complaint about a
      // transfer that succeeded. An accepted edit happens to clear it, which is what makes the
      // bug intermittent and worth pinning.
      state = { ...state, error: undefined };
      deps.setRunning(true);
      // NO ELLIPSIS: Fira Code and friends ligate `..` and `...`, the same hazard that took the
      // TUI's arrows out of `transferOverlay.ts`'s help line. The present participle carries the
      // sense without it, and `transferOverlay.test.ts` sweeps every phase for the pairs.
      deps.setStatus('transferring');
    },

    requestCancel() {
      if (!isRunning) return;
      deps.cancel();
    },

    progress(text) {
      if (!isRunning) return;
      deps.setStatus(text);
    },

    finished(result) {
      isRunning = false;
      deps.setRunning(false);
      if (result.ok) {
        deps.setStatus(`done: ${result.bytes ?? 0} bytes`);
        return;
      }
      deps.setStatus(result.error ?? 'transfer failed');
    },
  };
}
