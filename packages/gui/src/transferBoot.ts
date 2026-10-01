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
