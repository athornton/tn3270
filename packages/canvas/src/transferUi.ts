import {
  TRANSFER_FIELDS, applicable, cycleField, formKeywords, newTransferForm, setFieldText,
  type TransferFieldId, type TransferFormState, type TransferValues,
} from '@tn3270/frontend/dist/transferForm.js';

/**
 * MOVED HERE FROM `packages/gui` on 2026-10-06, for the same reason `keypadUi.ts` lives here:
 * `packages/web` needs this view and cannot depend on an Electron app. The move was
 * behaviour-preserving and the test came with it unchanged, which is the evidence.
 *
 * IT IMPORTS ONLY `@tn3270/frontend/dist/transferForm.js`, and must keep doing so -- see the
 * import-map section below for why that is the DEEP path and not the bare package name since
 * 2026-10-06. Electron's `dialog` and `ipcRenderer`
 * reach this form through `UiDeps` -- whose `browse()` and `submit()` are already
 * `Promise`-returning, which is why a browser needs no change to the interface at all. The GUI's
 * `browse()` resolves to a PATH; the web's resolves to a `File.name`. This module shows the string
 * and submits it, and cannot tell the difference.
 */

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
 * The import above is a BARE-PACKAGE-ROOTED DEEP SPECIFIER and stays one, verbatim, in the
 * emitted JS -- deliberately, not by omission. `tsc` rewrites nothing (measured 2026-10-06:
 * `dist/transferUi.js` line 1 carries `from '@tn3270/frontend/dist/transferForm.js'`, and it is
 * the file's ONLY runtime import, the type-only ones having been erased).
 *
 * ## WHY THE DEEP PATH, AND NOT THE BARE `@tn3270/frontend` IT USED TO BE
 *
 * CHANGED 2026-10-06, when `packages/web` became the second consumer. That page's map had
 * ALREADY bound the bare `@tn3270/frontend` to `keypadView.js` for the keypad overlay, and an
 * import-map key without a trailing `/` matches EXACTLY -- so a bare specifier here would have
 * resolved to `keypadView.js`, a module that does not export `TRANSFER_FIELDS`. That is a
 * resolution failure presenting as a BLANK PAGE WITH NO ERROR in any console, which is the
 * failure family this whole docblock is about. One specifier cannot name two files, so the two
 * views are reached by two distinct specifiers.
 *
 * `packages/frontend/package.json`'s `exports` map gained `"./dist/transferForm.js"` in the same
 * change, and it had to: an `exports` map with only `"."` makes every deep path an error, and the
 * probe said so -- `TS2307: Cannot find module '@tn3270/frontend/dist/transferForm.js'` from
 * `tsc`, `ERR_PACKAGE_PATH_NOT_EXPORTED` from Node. A browser never consults `exports`, so this
 * is purely what keeps `tsc`, Node and the browser resolving the one same string.
 *
 * Each consuming document carries an import map that resolves that specifier to
 * `transferForm.js`. The browser applies the map BEFORE it fetches anything, so
 * `packages/frontend/dist/index.js` -- the package barrel -- is never requested, and `tls.js`'s
 * `node:net`/`node:tls`/`node:fs` imports, which no browser can resolve, are never reached. All
 * six names imported here are exported directly by `transferForm.js` (verified), so that single
 * entry satisfies the whole list.
 *
 * TWO DOCUMENTS DO THIS AS OF 2026-10-06: `packages/gui/transfer.html` for the Electron window,
 * and `packages/web/static/index.html` for the gateway. Both carry a key spelling this deep
 * specifier verbatim -- the GUI's was updated in the same change, because its single
 * `@tn3270/frontend` key stopped matching the moment this import grew a subpath, and a key that
 * no longer matches is that blank window again.
 *
 * The two maps are NOT copies of each other. The GUI's addresses name
 * `../frontend/dist/transferForm.js` by relative path, which works only because an Electron
 * window loads from `file://` where `..` is a real directory; a served page has no such thing,
 * so the gateway serves every module FLAT at `/` and its addresses are `./transferForm.js`.
 *
 * `transferForm.js` has ZERO runtime imports of its own (9139 bytes, measured 2026-10-01), so
 * the module graph closes at that single file. That is a FACT WITH A DATE, not an invariant:
 * `transferModule.test.ts` pins the property, and the day it expires this window goes blank
 * with no error in any console.
 *
 * SO DO NOT ADD A SECOND WORKSPACE IMPORT TO THIS FILE. A specifier no map entry names resolves
 * to nothing, and the failure arrives as a blank window rather than as an error -- in BOTH front
 * ends now, and each map would need its own new entry. Anything else this module needs comes in
 * through `UiDeps`.
 *
 * AN EARLIER VERSION OF THIS PARAGRAPH SAID "the map has one entry", which went stale the day
 * this module gained a second consumer; the GUI's map has carried two since 2026-10-06. The
 * advice was always the right advice and its stated reason had quietly stopped being a fact.
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

    /**
     * Submit the form, ANNOUNCING THE TRANSFER BEFORE THE AWAIT RATHER THAN AFTER IT.
     *
     * ## THE INVARIANT: AN ENDING THAT HAS ALREADY ARRIVED MUST NOT BE UNDONE BY THE SUBMIT THAT
     * ## STARTED IT
     *
     * This method used to `await deps.submit(...)` and only THEN arm `isRunning` and paint
     * `transferring`. That is the renderer's copy of the bug `transferWindow.ts`'s `startRun`
     * documents at length, and it is REACHABLE for the same reason: `startTransfer` can call
     * `onDone` BEFORE IT RETURNS -- a whole DFT transfer finishing inside
     * `session.sendAID(AID.ENTER)`'s record handling, `transferRun.ts:377`'s
     * `if (ended) return { ok: true };`, driven against a real `Session` by
     * `tui/test/transferRun.test.ts`'s "notices a DFT transfer that finished BEFORE the first
     * wait". The controller's `finish` then runs INSIDE the `ipcMain.handle` handler and issues
     * `webContents.send('transfer:done', ...)`, and that send reaches the renderer BEFORE the
     * `invoke()` promise resolves -- measured in real Electron 44, 20 runs out of 20.
     *
     * So `finished()` ran first and this method's tail then clobbered it: a transfer that had
     * SUCCEEDED reported as permanently in progress, `Cancel` was dead (this object's
     * `requestCancel` passed its own `isRunning` check and main's answered
     * `if (run === undefined) return;`), and `Start` was dead for the window's life. Measured
     * against the built module: `setRunning false` / `setStatus "done: 3 bytes"` /
     * `setRunning true` / `setStatus "transferring"`, leaving `running() === true`.
     *
     * ## THE FIX IS THE SHAPE THIS MODULE'S OTHER HALF ALREADY USES, WITH NO NEW STATE
     *
     * `isRunning` is armed, and the whole "we are transferring" announcement made, BEFORE the
     * await. The tail is then EMPTY on the success path -- there is nothing left to clobber with
     * -- and `isRunning` doubles as the latch: `finished()` clears it, so the refusal arm below is
     * CONDITIONAL on this submit still being the one the form is waiting for. That is exactly
     * `startRun`'s placeholder-then-conditional-assignment, and it adds no second word for "is a
     * transfer running"; a renderer-side generation counter would have been one more fact to keep
     * in step with main's, and nothing here could falsify it.
     *
     * TWO SIBLING HAZARDS CLOSE WITH IT, both from the same await:
     *
     *  - A `transfer:progress` arriving during the await used to be DROPPED by `progress()`'s
     *    `if (!isRunning) return;`, and then painted over by the tail's `transferring` even if it
     *    had not been. Both ends are fixed: the flag is already armed when it arrives, and the
     *    tail no longer paints.
     *  - A SECOND Start during the await used to pass the guard below -- two `invoke`s for one
     *    button -- and came back as main's 'a transfer is already running', a message about the
     *    operator's OWN transfer. The early arming refuses the second press here instead.
     */
    async start() {
      // A SECOND START WHILE ONE RUNS IS IGNORED, matching the TUI: two transfers would
      // interleave two machines' frames on one screen, and the host is answering only one.
      if (isRunning) return;
      // ARMED, AND ANNOUNCED, BEFORE THE AWAIT. See the docstring: everything this used to do
      // after `deps.submit` resolved is done here, where no ending can have overtaken it. The
      // submit IS in flight, so the form is honestly busy for the duration.
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
      /**
       * A REFUSAL, OR A SUBMIT THAT NEVER ANSWERED AT ALL.
       *
       * The `catch` is NOT decoration, and it is the one liability the early arming above
       * introduces. `deps.submit` is `ipcRenderer.invoke` (`transferPreload.cts`), which REJECTS
       * when main's handler throws -- and `transferWindow.ts`'s `submit` catches only
       * `buildCommand`, so a throw out of `deps.startTransfer` comes back here as a rejection
       * rather than as `{ ok: false }`. Before this method armed the flag early, such a rejection
       * left a form that was merely idle and still usable; with the flag armed it would leave one
       * FROZEN for the window's life, which is C1 reappearing through a different door. Reported
       * as a refusal, because from the form's seat that is what it is: nothing is running, and the
       * operator is owed the reason.
       */
      let refusal: string | undefined;
      try {
        const result = await deps.submit(formKeywords(state));
        if (!result.ok) refusal = result.error ?? 'transfer refused';
      } catch (err) {
        refusal = `transfer refused: ${err instanceof Error ? err.message : String(err)}`;
      }
      // THE LATCH, AND THE WHOLE OF THIS METHOD'S TAIL. A completion that arrived while the
      // submit was in flight has already run `finished()`, which cleared `isRunning`, reported
      // the real outcome and re-enabled the form. Nothing below may speak about this submit
      // after that: the ending is the truth and the submit is merely how it began.
      if (!isRunning) return;
      if (refusal === undefined) return;
      // A LOCAL REFUSAL LEAVES THE FORM OPEN AND POPULATED. Nothing reached the host, so the
      // user's next move is to fix one field -- a form that reset would make them retype ten.
      //
      // AND THE FORM GOES IDLE AGAIN, which is now this arm's job rather than something it never
      // had to do: `isRunning` was armed above, so a refusal that failed to clear it would freeze
      // the form for the window's life -- the very failure the early arming exists to prevent,
      // moved one path over.
      isRunning = false;
      deps.setRunning(false);
      state = { ...state, error: refusal };
      show();
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
