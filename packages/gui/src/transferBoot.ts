import { caretAfterEdit, createTransferUi, type UiField } from './transferUi.js';
import type { TransferFieldId } from '@tn3270/frontend';

/**
 * The browser entry point: real elements in, `createTransferUi` out.
 *
 * DELIBERATELY THIN AND DELIBERATELY UNTESTED, the same split as `renderer.ts` against
 * `blit.ts`. Everything decidable lives in `transferUi.ts`, which a unit test can reach
 * because its DOM is injected; this file is the part that cannot be unit-tested at all
 * (there is no `document` under vitest, and jsdom is not a dependency), so it must contain
 * no decision worth testing. If you find yourself adding an `if` about WHAT THE FORM MEANS
 * here, it belongs in `transferUi.ts`. The two `if`s that remain below are about real
 * elements -- focus and enablement -- which `transferUi.ts` cannot see by construction.
 *
 * `window.tn3270transfer` is the preload's bridge. A DIFFERENT NAME from the canvas
 * window's `window.tn3270`, and that is not cosmetic: `contextBridge.exposeInMainWorld`
 * defines a NON-WRITABLE property, so two bridges sharing a name in one process is a
 * measured hazard already recorded in `main.ts:161-164`.
 */
declare global {
  interface Window {
    tn3270transfer: {
      browse(direction: string): Promise<string | undefined>;
      submit(keywords: readonly string[]): Promise<{ ok: boolean; error?: string }>;
      cancel(): void;
      onProgress(fn: (text: string) => void): void;
      onDone(fn: (r: { ok: boolean; error?: string; bytes?: number }) => void): void;
    };
  }
}

const bridge = window.tn3270transfer;
const fields = document.querySelector<HTMLDivElement>('#fields');
const status = document.querySelector<HTMLDivElement>('#status');
const startBtn = document.querySelector<HTMLButtonElement>('#start');
const cancelBtn = document.querySelector<HTMLButtonElement>('#cancel');
if (fields === null || status === null || startBtn === null || cancelBtn === null) {
  throw new Error('transfer.html is missing one of #fields, #status, #start, #cancel');
}

/**
 * The running state, mirrored here because `render` cannot ask the UI for it.
 *
 * ## DO NOT REPLACE THIS WITH `ui?.running()` -- IT THROWS
 *
 * `createTransferUi` calls `redraw()` before it returns (`transferUi.ts:152`), so `render` runs
 * SYNCHRONOUSLY while `const ui` is still in its temporal dead zone. Optional chaining does NOT
 * protect against a TDZ: `ui?.running()` throws `ReferenceError: Cannot access 'ui' before
 * initialization` exactly as `ui.running()` would, because `?.` guards `null`/`undefined` and a
 * TDZ binding is neither -- reading it at all is the error. Verified 2026-10-01 by running the
 * `const x = f(cb)` / `cb` reads `x?.y` shape under node: it throws.
 *
 * The cost of getting this wrong is the worst failure shape in this repo: the first render throws,
 * the module never finishes evaluating, no listener is ever attached, and the window is BLANK with
 * nothing in any console pointing at the cause.
 *
 * A mirrored flag has no such hazard, and it is not a second source of truth: `setRunning` is the
 * only writer and `transferUi.ts` is the only caller of `setRunning`, so this follows the UI
 * rather than racing it.
 */
let running = false;

/**
 * The control that had focus, so a rebuild does not throw the caret on the floor.
 *
 * `field` is a `TransferFieldId` and not a `string`: the values only ever come from `UiField.id`,
 * so the selector interpolation below cannot be fed anything outside that 10-member union. That
 * was already true incidentally; this makes it structural, which is what keeps it true.
 *
 * `role` distinguishes the two controls that can share one field. `localFile` draws BOTH an input
 * and a Browse button, so the id alone is ambiguous -- and a selector matching on the id alone
 * returns the input, which is why a redraw with Browse focused used to land focus on `<body>`.
 */
interface FocusMemo {
  readonly field: TransferFieldId;
  readonly role: 'value' | 'browse';
  readonly start: number | null;
  readonly end: number | null;
  /**
   * What the element was DISPLAYING when its caret was read -- including the keystroke the
   * browser had already applied but the model had not yet seen. `caretAfterEdit` needs it to tell
   * how much the model dropped; without it the caret sits one position right after a refused
   * keystroke, which is the measured bug this field exists to fix.
   */
  readonly typed: string;
}

/**
 * Remember where the caret was before `render` destroys the element holding it.
 *
 * NOT A NICETY. `render` is called on EVERY model change and rebuilds `#fields` from scratch, and
 * a text field routes every keystroke through the model -- so without this, typing one character
 * into `Local file` removes the focused input from the document, focus falls back to `<body>`, and
 * the second character goes nowhere. The form would be unusable for its main job: naming two
 * files. The repair has to live here because it is about real elements, which `transferUi.ts` is
 * built never to touch.
 *
 * ## A `const` ARROW AND NOT A `function`, FOR TWO REASONS
 *
 * A hoisted `function` can be called before the null guard above runs, so TypeScript discards the
 * narrowing inside one: `restoreFocus` as a `function` fails with "'fields' is possibly 'null'"
 * (measured -- it was the one typecheck error this file produced). An arrow assigned after the
 * guard keeps it.
 *
 * And both must be declared ABOVE `const ui`, because `render` calls them synchronously during
 * `createTransferUi`. That is the same temporal-dead-zone constraint documented at `running`:
 * being a `const` is only safe here because the initializer has already run by then.
 */
const rememberFocus = (): FocusMemo | undefined => {
  const active = document.activeElement;
  const tagged = active instanceof HTMLInputElement || active instanceof HTMLSelectElement
    || active instanceof HTMLButtonElement;
  if (!tagged) return undefined;
  // Written by `render` from `UiField.id`, so the cast restates what the markup guarantees rather
  // than asserting anything new. An untagged element (the Start and Cancel buttons live outside
  // `#fields` and carry no `data-field`) returns undefined above.
  const field = active.dataset['field'] as TransferFieldId | undefined;
  if (field === undefined) return undefined;
  const role = active.dataset['role'] === 'browse' ? 'browse' : 'value';
  if (active instanceof HTMLInputElement) {
    return {
      field, role, start: active.selectionStart, end: active.selectionEnd, typed: active.value,
    };
  }
  // A `<select>` and a `<button>` have no caret. A null start tells `caretAfterEdit` not to
  // compute one, and `restoreFocus` does no caret work for either.
  return { field, role, start: null, end: null, typed: '' };
};

/** Put focus and caret back on the control that had them, if it is still drawn. */
const restoreFocus = (memo: FocusMemo | undefined): void => {
  if (memo === undefined) return;
  // BOTH attributes, because `localFile` draws two controls and matching on the field alone
  // returns the input -- which is how a redraw with Browse focused used to drop focus to `<body>`.
  const el = fields.querySelector(
    `[data-field="${memo.field}"][data-role="${memo.role}"]`,
  );
  if (el instanceof HTMLButtonElement) { el.focus(); return; }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement)) return;
  el.focus();
  if (!(el instanceof HTMLInputElement)) return;
  // The arithmetic is `caretAfterEdit`'s, in `transferUi.ts`, because it is a pure function of
  // three values and a unit test cannot reach this file (there is no `document` under vitest).
  // The inline version here was wrong: see that function's docstring for the measurement.
  const { start, end } = caretAfterEdit(memo, memo.typed, el.value);
  el.setSelectionRange(start, end);
};

const ui = createTransferUi({
  render(list: readonly UiField[]) {
    const memo = rememberFocus();
    fields.replaceChildren();
    for (const f of list) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = f.label;
      row.append(label);

      if (f.kind === 'cycle') {
        const select = document.createElement('select');
        select.dataset['field'] = f.id;
        select.dataset['role'] = 'value';
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt;
          // An empty value is a REAL state meaning "I did not ask", distinct from every
          // named value -- `transferForm.ts` explains why a two-state toggle would lose it.
          o.textContent = opt === '' ? '(host default)' : opt;
          if (opt === f.value) o.selected = true;
          select.append(o);
        }
        select.disabled = running;
        select.addEventListener('change', () => {
          // Routed through the model as a CYCLE to the chosen value, so `clearInapplicable`
          // runs. Distance is computed from the options this field currently offers, which is
          // sound because `UiField.options` comes from `transferUi.ts`'s `offered()` -- the same
          // list, in the same order, that `cycleField` will index into.
          const from = f.options.indexOf(f.value);
          const to = f.options.indexOf(select.value);
          if (from >= 0 && to >= 0 && to !== from) ui.cycle(f.id, to - from);
        });
        row.append(select);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset['field'] = f.id;
        input.dataset['role'] = 'value';
        input.value = f.value;
        input.disabled = running;
        input.addEventListener('input', () => { ui.type(f.id, input.value); });
        row.append(input);
      }

      if (f.id === 'localFile') {
        const browse = document.createElement('button');
        browse.textContent = 'Browse…';
        // TAGGED SO FOCUS SURVIVES ITS OWN REDRAW, which is reachable on this button's main path:
        // click Browse, the dialog resolves, `browseLocal` redraws, this element is destroyed.
        // Measured before the tag: focus landed on `<body>`. `data-role` is what keeps it distinct
        // from the `localFile` input sharing the id.
        browse.dataset['field'] = f.id;
        browse.dataset['role'] = 'browse';
        browse.disabled = running;
        browse.addEventListener('click', () => { void ui.browseLocal(); });
        row.append(browse);
      } else {
        row.append(document.createElement('span'));
      }
      fields.append(row);
    }
    restoreFocus(memo);
  },
  setStatus(text: string) {
    status.textContent = text;
  },
  /**
   * Push the running state to the DOM, and to the flag `render` reads.
   *
   * ## WHY `render` STILL CONSULTS `running` -- DEFENSE IN DEPTH, NOT THE PRIMARY GUARD
   *
   * The interleaving this covers is `browseLocal`'s: it checks `isRunning` before its `await
   * deps.browse(...)` and redraws after, so a dialog that is not modal to this window lets the
   * operator press Start while it is open and a late resolution rebuild every control mid-transfer.
   * Measured in real Electron with a deferred `browse`.
   *
   * THE PRIMARY FIX IS IN `transferUi.ts`: a second `isRunning` check immediately after that await,
   * which also stops the two worse halves of the same bug (a redraw's `show()` clobbering the live
   * progress line, and `setFieldText` mutating the model mid-transfer). With that in place, this
   * assignment is arguably unreachable -- almost every render happens while idle, since `cycle` and
   * `type` return early when running and `start`/`progress`/`finished` never redraw.
   *
   * KEPT ANYWAY, DELIBERATELY. It is the enablement third of the hazard, and a pair like this is
   * invisible to single mutation: removing either half leaves the other half's tests green, which
   * this repo has now recorded twice. So neither half should be deleted on the evidence of a green
   * suite. The same note is on the post-await check in `transferUi.ts`, at the other end of the
   * pair, because whoever deletes one will be reading only that end.
   */
  setRunning(isRunning: boolean) {
    running = isRunning;
    startBtn.disabled = isRunning;
    cancelBtn.disabled = !isRunning;
    for (const el of fields.querySelectorAll('input, select, button')) {
      (el as HTMLInputElement).disabled = isRunning;
    }
  },
  browse: (direction: string) => bridge.browse(direction),
  submit: (keywords: readonly string[]) => bridge.submit(keywords),
  cancel: () => { bridge.cancel(); },
});

startBtn.addEventListener('click', () => { void ui.start(); });
cancelBtn.addEventListener('click', () => { ui.requestCancel(); });
bridge.onProgress((text) => { ui.progress(text); });
bridge.onDone((r) => { ui.finished(r); });

/**
 * TWO HOOKS FOR THE HARNESS, and nothing else on `window`.
 *
 * `executeJavaScript` is how main drives this window without a mouse, the same way
 * `__tn3270ButtonCenter` lets `clicks.mjs` click a keypad button by label (`canvas/src/renderer.ts`).
 * They go through the SAME `ui` object a real click does, so a scenario cannot pass while the wiring
 * is broken -- which is exactly what a hook that manipulated the DOM directly would allow.
 *
 * ## THEY ADD NO DECISION TO THIS FILE, WHICH WAS THE CONSTRAINT
 *
 * This module's discipline is that it holds no decision worth testing, because no test can reach it.
 * The plan for these hooks broke that: its `__tn3270Submit` inferred success by STRING-MATCHING the
 * status line for `'transferring'` -- a literal duplicated out of `transferUi.ts`, a judgement about
 * what the form means, and unreachable by any test. `ui.running()` answers the same question
 * directly, is a method on the object already in hand, and is unit-tested at its own end
 * (`transferUi.test.ts`). So both hooks only READ `ui` and the DOM; nothing here decides anything.
 *
 * ## EACH RETURNS WHAT THE MODEL ACTUALLY HOLDS, NOT WHAT IT WAS ASKED FOR
 *
 * `__tn3270SetField` returns `ui.values()[id]` AFTER the edit, so a value the model refused -- a
 * non-digit into `Lrecl`, a cycle field, an id outside `TransferFieldId` -- comes back as what is
 * really there and the seam's report says so. A hook returning `void` would let a scenario pass over
 * a form that ignored every step.
 *
 * `__tn3270Submit` returns `running()` AND the status text: `running()` is the fact, and the text is
 * WHICH refusal, which is what distinguishes `not in 3270 mode` from a validator complaint from 'the
 * transfer window is not open'. Both come from the same places a user reads.
 */
declare global {
  interface Window {
    __tn3270SetField(id: string, text: string): string;
    __tn3270FieldKind(id: string): string;
    __tn3270CycleField(id: string, to: string): string;
    __tn3270Submit(): Promise<{ ok: boolean; status: string }>;
    __tn3270AwaitDone(budgetMs: number): Promise<{
      running: boolean; status: string; timedOut: boolean;
    }>;
  }
}

window.__tn3270SetField = (id: string, text: string): string => {
  /**
   * THE CAST IS UNAVOIDABLE AND IT IS NARROW. `executeJavaScript` hands over a `string` -- the
   * boundary is JSON over IPC, where no union survives -- so something has to assert it, and
   * asserting it here is better than widening `TransferUi.type` to take any string and losing the
   * union everywhere else.
   *
   * IT IS NOT UNCHECKED, which is what makes it safe: `setFieldText` looks the id up in
   * `FIELD_BY_ID` and returns the state UNTOUCHED when it misses (`transferForm.ts:142-143`), and
   * `values()[id]` on an unknown key is `undefined`. So a bad id is a visible empty echo rather than
   * a crash or a silent success.
   */
  ui.type(id as TransferFieldId, text);
  return ui.values()[id as TransferFieldId] ?? '';
};

/**
 * Which kind of control a field is DRAWN as: `cycle`, `text`, or `''` if it is not on screen.
 *
 * READ FROM THE DOM, not from `TRANSFER_FIELDS`, and for two reasons. The weaker one is the import
 * graph: this file's only runtime import is `./transferUi.js` and `transfer.html`'s import map has
 * ONE entry, so pulling the field table in here would need a second -- and an unresolved specifier
 * blanks this window with no error in any console, which is this repo's most-repeated failure.
 *
 * The stronger one is that the DOM is the better oracle. `render` draws a `<select>` for
 * `kind === 'cycle'` and an `<input>` for everything else, so asking the document answers "what did
 * the form actually draw" rather than "what does the table say it should have". A field the form
 * failed to draw reports `''`, which is a visible failure rather than a confident answer about a
 * control that is not there.
 */
window.__tn3270FieldKind = (id: string): string => {
  const el = fields.querySelector(`[data-field="${id}"][data-role="value"]`);
  if (el instanceof HTMLSelectElement) return 'cycle';
  if (el instanceof HTMLInputElement) return 'text';
  return '';
};

/**
 * Cycle a cycle field until it reads `to`, and report what it holds.
 *
 * ## WHY `__tn3270SetField` COULD NOT DO THIS, MEASURED
 *
 * It routes through `ui.type` -> `setFieldText`, which is a documented NO-OP on a cycle field
 * (`transferForm.ts`: `field.kind === 'cycle'` returns the state untouched). So
 * `direction=send,host=vm` echoed `direction=receive,host=tso` -- the seam reported the unchanged
 * value honestly, but a scenario that did not read the echo would have sent a RECEIVE to a TSO host
 * while believing it had set both. Found by running it; nothing in the type system objects.
 *
 * ## IT CLICKS THROUGH THE MODEL RATHER THAN ASSIGNING
 *
 * `ui.cycle(id, 1)` is what a real arrow key does, so this cannot set a combination the operator
 * could not reach -- and `clearInapplicable` runs on every step, which is the whole reason the
 * model owns cycling. Assigning the value directly would bypass the rule that makes VM drop
 * `Recfm=undefined`.
 *
 * BOUNDED BY THE NUMBER OF VALUES THE FIELD OFFERS, so an unreachable target stops rather than
 * spinning: the caller sees an echo that is not what it asked for, which is the same visible
 * failure a bad id gives. A fixed bound also covers the case where the target becomes
 * inapplicable mid-walk and the field stops changing.
 */
window.__tn3270CycleField = (id: string, to: string): string => {
  const field = id as TransferFieldId;
  for (let i = 0; i < 12; i++) {
    if (ui.values()[field] === to) break;
    ui.cycle(field, 1);
  }
  return ui.values()[field] ?? '';
};

window.__tn3270Submit = async (): Promise<{ ok: boolean; status: string }> => {
  await ui.start();
  /**
   * `ui.running()` IS THE ANSWER, and the status line is only the explanation.
   *
   * `start()` sets `isRunning` true only after `deps.submit` came back `ok` (`transferUi.ts`), so
   * this is the same fact the form's own enablement is driven from rather than a reading of its
   * prose. The status text is read second, for the diagnosis.
   */
  const status = document.querySelector('#status')?.textContent ?? '';
  return { ok: ui.running(), status };
};

/**
 * Wait for a RUNNING transfer to end, and report the status line it ended on.
 *
 * ## WHY `__tn3270Submit` ALONE WAS NOT ENOUGH, MEASURED AGAINST A LIVE HOST
 *
 * It returns as soon as the submit was ACCEPTED -- `ok: true, status: "transferring"` -- and the
 * seam then quit the app, killing the transfer it had just started. The first live run against
 * VM/CMS reported exactly that and nothing more: a real transfer began and the harness tore the
 * process down mid-flight, so no run could ever observe a COMPLETION. Replay mode hid this
 * perfectly, because there a submit is always refused and there is never anything to wait for.
 *
 * ## IT POLLS `running()`, WHICH IS THE SAME FACT THE FORM'S ENABLEMENT USES
 *
 * `finished()` clears `isRunning` on every ending -- success, failure, cancel, a stale-generation
 * drop -- so this cannot miss one by watching the wrong signal. Reading the status line instead
 * would be reading prose, and the three endings are different strings.
 *
 * ## IT RETURNS `timedOut` RATHER THAN THROWING
 *
 * The caller is `executeJavaScript` across an IPC boundary, where a throw arrives as a rejected
 * promise with a stack from the renderer -- unreadable in a harness log. A flag the seam can print
 * keeps the diagnosis legible, and a transfer still running when the budget expires is a real
 * result worth reporting rather than an error.
 */
window.__tn3270AwaitDone = async (budgetMs: number): Promise<{
  running: boolean; status: string; timedOut: boolean;
}> => {
  const deadline = Date.now() + budgetMs;
  while (ui.running() && Date.now() < deadline) {
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return {
    running: ui.running(),
    status: document.querySelector('#status')?.textContent ?? '',
    timedOut: ui.running(),
  };
};
