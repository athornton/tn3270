import {
  caretAfterEdit, createTransferUi, type TransferUi, type UiField,
} from '@tn3270/canvas/dist/transferUi.js';
import type { TransferFieldId } from '@tn3270/frontend/dist/transferForm.js';
import { createTransferBridge, type SaveSink } from './transferBridge.js';

/**
 * The browser entry point for the transfer form: real elements in, a wired overlay out.
 *
 * ## EVERYTHING DECIDABLE LIVES ELSEWHERE
 *
 * `gui/src/transferBoot.ts` states the rule this follows: if a branch here is about the MODEL it
 * belongs in `transferUi.ts`, and what remains is about real elements -- focus, caret, enablement,
 * and the two browser capabilities that have no Node equivalent. That is why this file has no unit
 * test and `transferUi.test.ts`, `transferBridge.test.ts` and `transferOverlay.test.ts` do:
 * `vitest.config.ts` sets `environment: 'node'`, there is no `document` in any test in this repo,
 * and jsdom is not a dependency. The cover for this file is the real-browser harness
 * (`packages/web/scripts/browser-clicks.mjs`), the same split `renderer.ts` has against `blit.ts`.
 *
 * ## THE DEEP IMPORT SPECIFIERS ARE REQUIRED, AND A BARE ONE WOULD BLANK THE PAGE
 *
 * `@tn3270/canvas/dist/transferUi.js`, never the bare `@tn3270/canvas`: `static/index.html`'s
 * import map already binds that bare key to `./keypadUi.js` for the keypad overlay, and an
 * import-map key without a trailing `/` matches EXACTLY -- so one specifier cannot name two files.
 * The bare `@tn3270/frontend` is likewise bound to `./keypadView.js`, which does not export
 * `TransferFieldId`'s module at all. Both deep keys are already in that map (added 2026-10-06
 * ahead of this file), and both resolve for `tsc` and Node too: `frontend`'s `exports` declares
 * the `./dist/transferForm.js` subpath, and `canvas` has no `exports` field at all.
 *
 * `import type` from `transferForm.js` ERASES at build, so it adds no edge to the browser's import
 * graph -- verified on the built output below rather than assumed, because a module that 404s
 * stops the IMPORTING module from running and the error then surfaces in the next script, naming
 * the wrong file.
 *
 * ## WHAT THIS FILE DOES NOT IMPORT, DELIBERATELY
 *
 * `transferOverlay.ts`. The overlay is constructed in `bridge.ts`, which owns the real `document`
 * and must build it BEFORE `createBridge` so the `showTransfer` dep has something to call -- see
 * that file's construction-order section. Taking the overlay as a caller's concern keeps this
 * function free of that ordering constraint entirely.
 */
export interface TransferBoot {
  /** Hand the three gateway transfer messages in, already parsed. */
  onMessage(msg: { kind: string } & Record<string, unknown>): void;
  /** Does a completed receive still need saving? For the overlay's close warning. */
  hasUnsaved(): boolean;
}

export function bootTransfer(doc: Document, send: (text: string) => void): TransferBoot {
  const need = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    // NAMED, because a missing element is the blank-page family again: without this the first
    // property access throws `null is not an object` from a line that does not say which id.
    if (el === null) throw new Error(`transfer overlay is missing #${id}`);
    return el as T;
  };

  const fileInput = need<HTMLInputElement>('transfer-file');
  const status = need('transfer-status');
  const fields = need('transfer-fields');
  const saveButton = need<HTMLButtonElement>('transfer-save');
  const startButton = need<HTMLButtonElement>('transfer-start');
  const browseButton = need<HTMLButtonElement>('transfer-browse');
  const cancelButton = need<HTMLButtonElement>('transfer-cancel');

  /**
   * The chosen local file's NAME AND BYTES, read in the browser.
   *
   * A browser has no paths, so there is nothing a later `read(path)` could do: the bytes are
   * captured when the operator picks the file and re-chunked out of this copy on every Start.
   * THAT IS WHAT MAKES A RETRY HONEST, and it is not a stylistic preference --
   * `transferGateway.ts:290-298` records the measured bug on the other side of this wire: a
   * refused start used to CONSUME its staging, so a retry sent an EMPTY file and reported success,
   * which under `Exist=replace` overwrites the operator's host dataset with nothing. That is fixed
   * gateway-side; re-chunking here is why this half could not trigger it in the first place. So
   * there must never be a "resend without re-chunking" shortcut on this path.
   */
  let pending: { name: string; bytes: Uint8Array } | undefined;
  /**
   * The running transfer's direction and local name, captured at submit.
   *
   * `direction` IS LOAD-BEARING AND NOT BOOKKEEPING. `transferDone {ok:true}` is the only ending
   * for both directions, and the two need opposite treatment: a receive that staged nothing is
   * the zero-byte file `finishEmpty()` exists for, while a SEND that staged nothing is every
   * successful upload there is. Calling `finishEmpty()` on a send would make `hasUnsaved()` true
   * and light the Save button for a file the operator had just uploaded -- offering to download
   * an empty copy of their own source, and warning them about discarding it on close.
   */
  let running: { direction: string } | undefined;
  /**
   * The name the received file is offered under, which OUTLIVES THE RUN.
   *
   * Separate from `running` above, and the separation is the fix for a measured ordering trap in
   * this file's first draft: the name lived on `running`, which `transferDone` clears -- so by the
   * time the operator clicked the now-enabled Save button the name was gone and every download was
   * called `download.bin`. The run's identity ends with the run; the file's name has to last as
   * long as the bytes do, which is until the operator saves them or cancels.
   */
  let saveName = 'download.bin';
  /**
   * A chunk this receive refused, remembered so the ENDING can report it.
   *
   * `transferData` failures cannot be left to the status line: the gateway sends its chunks and
   * then `transferDone {ok:true}` regardless (`transferGateway.ts:343-367` -- the chunks are a
   * consequence of a run that already succeeded host-side), so a refused chunk would be followed
   * by `done: N bytes` painting over the complaint. The operator would read success over a
   * download that does not exist, with only a still-disabled Save button as the evidence. So the
   * refusal is held and substituted for the ok at `transferDone`, which is the one report the
   * operator is left looking at.
   */
  let receiveError: string | undefined;

  /**
   * FEATURE DETECTION, READ ONCE AND INJECTED. `showSaveFilePicker` is Chrome/Edge/Opera desktop
   * only and needs a secure context, so a LAN gateway on plain http has no picker on ANY browser
   * -- `transferBridge.ts`'s own dep comment calls `undefined` the COMMON case here rather than an
   * edge one. Passing the result as a dependency rather than reading `globalThis` inside the
   * bridge is what lets a unit test drive both save routes.
   *
   * THE CAST IS THE ONE IN THIS FILE AND IT IS NARROW. `FileSystemWritableFileStream` is in
   * neither `DOM` nor `DOM.Iterable` as of TypeScript 7.0, which is why `SaveSink` is declared in
   * `transferBridge.ts` at all; this is the single point that touches `globalThis` to get one.
   */
  const picker = 'showSaveFilePicker' in globalThis
    ? async (suggestedName: string): Promise<SaveSink> => {
      const handle = await (globalThis as unknown as {
        showSaveFilePicker(o: { suggestedName: string }): Promise<{
          createWritable(): Promise<SaveSink>;
        }>;
      }).showSaveFilePicker({ suggestedName });
      return handle.createWritable();
    }
    : undefined;

  const bridge = createTransferBridge({
    send,
    savePicker: picker,
    /**
     * The `<a download>` route, which works in every browser.
     *
     * A FRESH `Uint8Array` RATHER THAN THE ONE HANDED IN, and that is a type requirement rather
     * than a copy for safety: `BlobPart` is `ArrayBufferView<ArrayBuffer>`, while a
     * `Uint8Array<ArrayBufferLike>` could be backed by a `SharedArrayBuffer`, so
     * `new Blob([bytes])` is rejected -- measured as `TS2322` under this package's lib.
     *
     * `revokeObjectURL` AFTER THE SYNCHRONOUS `click()`, which is the documented order: the click
     * starts the download synchronously, and holding the URL afterwards leaks the whole file for
     * the page's life. The anchor is never appended to the document -- a detached one clicks fine
     * and leaves no stray element over the canvas.
     */
    saveFallback: (name, bytes) => {
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      const a = doc.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  /**
   * The running state, mirrored here because `render` cannot ask the UI for it.
   *
   * ## DO NOT REPLACE THIS WITH `ui?.running()` -- IT THROWS
   *
   * `createTransferUi` calls `redraw()` before it returns (`transferUi.ts:259`), so `render` runs
   * SYNCHRONOUSLY while `const ui` is still in its temporal dead zone, and OPTIONAL CHAINING DOES
   * NOT GUARD A TDZ: `?.` guards `null`/`undefined`, and reading a dead-zone binding at all is the
   * error. Re-verified under node 26 on 2026-10-07 with the `const x = f(cb)` / `cb` reads `x`
   * shape: `ReferenceError: Cannot access 'ui' before initialization`. This project shipped
   * exactly that blank window once (`gui/src/transferBoot.ts` records it), and the cost is the
   * worst failure shape in this repo -- the module never finishes evaluating, no handler is ever
   * attached, and nothing in any console points at the cause.
   *
   * A mirrored flag has no such hazard and is not a second source of truth: `setRunning` is its
   * only writer and `transferUi.ts` is the only caller of `setRunning`.
   */
  let isRunning = false;

  /**
   * The control that had focus, so a rebuild does not throw the caret on the floor.
   *
   * NOT A NICETY, AND THE FORM IS UNUSABLE WITHOUT IT. `render` is called on EVERY model change
   * (`transferUi.ts:269` and `:276` -- `cycle` and `type` both `redraw()`), and it rebuilds
   * `#transfer-fields` from scratch, so without this the first character typed into `Host file`
   * removes the focused input from the document, focus falls back to `<body>`, and the second
   * character goes nowhere. The repair has to live here because it is about real elements, which
   * `transferUi.ts` is built never to touch.
   *
   * `role` DISTINGUISHES THE TWO CONTROLS THAT CAN SHARE ONE FIELD. `localFile` draws both an
   * input and (on a send) the Browse button is wired to it, so the GUI's measurement applies:
   * a selector matching on the id alone returns the input, which is how a redraw with Browse
   * focused used to land focus on `<body>`. Browse lives OUTSIDE `#transfer-fields` here, in the
   * static button row, so it survives a rebuild on its own and only the `value` role is memoed --
   * the attribute pair is kept anyway so the selector cannot become ambiguous if a second control
   * is ever drawn for a field.
   */
  interface FocusMemo {
    readonly field: TransferFieldId;
    readonly role: 'value';
    readonly start: number | null;
    readonly end: number | null;
    /**
     * What the element was DISPLAYING when its caret was read -- including the keystroke the
     * browser had already applied but the model had not yet seen. `caretAfterEdit` needs it to
     * tell how much the model dropped; without it the caret sits one position right after a
     * refused keystroke, which is the measured bug that function exists to fix.
     */
    readonly typed: string;
  }

  const rememberFocus = (): FocusMemo | undefined => {
    const active = doc.activeElement;
    // `instanceof` AGAINST THE REAL CONSTRUCTORS, which is legal here and nowhere else in this
    // feature: this file only ever runs in a browser, so `HTMLInputElement` is a real global.
    if (!(active instanceof HTMLInputElement) && !(active instanceof HTMLSelectElement)) {
      return undefined;
    }
    // Written by `renderFields` from `UiField.id`, so the cast restates what this file's own
    // markup guarantees rather than asserting anything new. An untagged element returns above or
    // below: the five buttons in the static row carry no `data-field`.
    const field = active.dataset['field'] as TransferFieldId | undefined;
    if (field === undefined) return undefined;
    if (active instanceof HTMLInputElement) {
      return {
        field, role: 'value', start: active.selectionStart, end: active.selectionEnd,
        typed: active.value,
      };
    }
    // A `<select>` has no caret. A null start tells `caretAfterEdit` not to compute one, and
    // `restoreFocus` does no caret work for one either.
    return { field, role: 'value', start: null, end: null, typed: '' };
  };

  /** Put focus and caret back on the control that had them, if it is still drawn. */
  const restoreFocus = (memo: FocusMemo | undefined): void => {
    if (memo === undefined) return;
    const el = fields.querySelector(
      `[data-field="${memo.field}"][data-role="${memo.role}"]`,
    );
    if (el instanceof HTMLSelectElement) { el.focus(); return; }
    if (!(el instanceof HTMLInputElement)) return;
    el.focus();
    // The arithmetic is `caretAfterEdit`'s, in `transferUi.ts`, because it is a pure function of
    // three values and no unit test can reach this file. An inline version of it in the GUI's boot
    // module was WRONG -- see that function's docstring for the measurement.
    const { start, end } = caretAfterEdit(memo, memo.typed, el.value);
    el.setSelectionRange(start, end);
  };

  /**
   * Draw the field rows. PURE DOM: which fields exist is `transferUi.ts`'s decision.
   *
   * ## THE HANDLERS ARE PASSED AS CLOSURES, AND THAT IS WHAT KEEPS THIS OFF THE TDZ
   *
   * An earlier draft of this file took the `TransferUi` itself as a parameter -- and reading `ui`
   * to pass it is an eager read, performed during the synchronous first `render` while `const ui`
   * is still in its temporal dead zone. That is the blank page the `isRunning` docstring above
   * measures. These arrows are CREATED then and read `ui` only when a click or an input event
   * fires them, which cannot happen before module evaluation finishes. It is the same shape
   * `bridge.ts` documents for the keypad's lazily-built `sendAction`.
   *
   * `TransferFieldId` RATHER THAN THE `as never` AN EARLIER DRAFT USED: the ids come straight off
   * `UiField.id`, which is already that union, so the real type needs no cast at all.
   */
  const renderFields = (
    list: readonly UiField[],
    on: {
      cycle: (id: TransferFieldId, delta: number) => void;
      type: (id: TransferFieldId, text: string) => void;
    },
  ): void => {
    const memo = rememberFocus();
    fields.replaceChildren();
    for (const f of list) {
      const label = doc.createElement('label');
      label.textContent = f.label;
      label.htmlFor = `transfer-${f.id}`;
      fields.append(label);

      if (f.kind === 'cycle') {
        // A `<select>`, AS THE GUI'S FORM USES, rather than a button that cycles: the options are
        // visible before they are chosen, and `UiField.options` already arrives in table order --
        // `transferUi.ts`'s `offered()` sorts the raw cycle walk back into it precisely so a menu
        // does not reorder itself every time the operator picks an item.
        const select = doc.createElement('select');
        select.id = `transfer-${f.id}`;
        select.dataset['field'] = f.id;
        select.dataset['role'] = 'value';
        for (const opt of f.options) {
          const o = doc.createElement('option');
          o.value = opt;
          // An empty value is a REAL state meaning "I did not ask", distinct from every named
          // value -- `transferForm.ts` explains why a two-state toggle would lose it.
          o.textContent = opt === '' ? '(host default)' : opt;
          if (opt === f.value) o.selected = true;
          select.append(o);
        }
        select.disabled = isRunning;
        select.addEventListener('change', () => {
          // ROUTED THROUGH THE MODEL AS A CYCLE to the chosen value, so `clearInapplicable` runs
          // -- the applicability rules CHAIN, and a value assigned in the DOM would let this front
          // end submit a keyword the TUI would have wiped. Distance is computed from the options
          // this field currently offers, which is sound because they are the same list, in the
          // same order, that `cycleField` will index into.
          const from = f.options.indexOf(f.value);
          const to = f.options.indexOf(select.value);
          if (from >= 0 && to >= 0 && to !== from) on.cycle(f.id, to - from);
        });
        fields.append(select);
      } else {
        const input = doc.createElement('input');
        input.type = 'text';
        input.id = `transfer-${f.id}`;
        input.dataset['field'] = f.id;
        input.dataset['role'] = 'value';
        input.value = f.value;
        input.disabled = isRunning;
        input.addEventListener('input', () => { on.type(f.id, input.value); });
        fields.append(input);
      }
    }
    restoreFocus(memo);
  };

  /** `LocalFile=` without its keyword, which is the name a received file is offered under. */
  const localNameFrom = (keywords: readonly string[]): string => {
    /*
      `LocalFile` AND NOT `HostFile`, which an earlier draft derived the download name from.
      `LocalFile` is what the operator TYPED as the destination, and it is the better answer for
      two reasons: it is their own choice rather than a transliteration of a CMS
      `FILENAME FILETYPE FILEMODE` triple, and it is MANDATORY -- `transferCommand` throws
      "missing 'LocalFile' option" (`frontend/src/transfer.ts:480`) and `formKeywords` omits empty
      values, so a receive with the field blank is refused by the gateway before any byte moves.
      The fallback below is therefore very nearly dead code, kept only so a `save()` reached by
      some other route cannot be handed an empty filename.
    */
    const lf = keywords.find((k) => k.toLowerCase().startsWith('localfile='));
    const value = lf?.slice(lf.indexOf('=') + 1).trim();
    if (value === undefined || value === '') return 'download.bin';
    return value;
  };

  const ui: TransferUi = createTransferUi({
    render: (list) => {
      renderFields(list, {
        cycle: (id, delta) => { ui.cycle(id, delta); },
        type: (id, text) => { ui.type(id, text); },
      });
      // BROWSE IS MEANINGLESS ON A RECEIVE IN A BROWSER, and disabling it is the honest answer.
      // `UiDeps.browse` takes the DIRECTION because the GUI opens an Open dialog for a send and a
      // Save dialog for a receive; a browser has neither for a receive -- there is no path to
      // name, and where the bytes land is the Save button's business after the transfer. An
      // enabled button would open a file CHOOSER asking the operator to pick an existing local
      // file to receive INTO, which is actively misleading. Read off the rendered list rather
      // than kept as a second flag, so it cannot disagree with what is on screen.
      const direction = list.find((f) => f.id === 'direction')?.value;
      browseButton.disabled = isRunning || direction !== 'send';
    },
    setStatus: (text) => { status.textContent = text; },
    /**
     * Push the running state to the DOM, and to the flag `render` reads.
     *
     * `render` STILL CONSULTS `isRunning` for each control's `disabled`, which is DEFENSE IN DEPTH
     * rather than the primary guard: the primary one is the post-await `isRunning` check in
     * `transferUi.ts`'s `browseLocal`, which also stops the two worse halves of the same hazard.
     * Both ends carry a note saying neither half should be deleted on the evidence of a green
     * suite, because a pair like this is invisible to single mutation -- removing either leaves the
     * other's tests passing, which this repo has now recorded twice.
     */
    setRunning: (nowRunning) => {
      isRunning = nowRunning;
      startButton.disabled = nowRunning;
      browseButton.disabled = nowRunning;
      // ENABLED ONLY WHILE ONE RUNS, matching the GUI's form: `requestCancel` is a no-op when
      // nothing is running (`transferUi.ts`), so an always-live Cancel is a button that does
      // nothing most of the time.
      cancelButton.disabled = !nowRunning;
      for (const el of fields.querySelectorAll('input, select')) {
        (el as HTMLInputElement).disabled = nowRunning;
      }
    },
    browse: async (direction) => {
      // SEND ONLY, as the disabling in `render` above already reflects. This is the structural
      // half of that: a direction with no dialog resolves to `undefined`, which `browseLocal`
      // treats as "the operator changed their mind" and leaves the typed field alone.
      if (direction !== 'send') return undefined;
      // A real file input needs a user gesture, which the Browse button supplies. It resolves to
      // the NAME: a browser has no paths, and the name is also the better host-side default on a
      // system whose files are FILENAME FILETYPE FILEMODE rather than paths.
      return new Promise<string | undefined>((resolve) => {
        // ASSIGNED BEFORE THE CLICK, so neither event can fire into an unset handler.
        //
        // BOTH EVENTS ARE HANDLED, AND `oncancel` IS NOT OPTIONAL HERE: a file input fires
        // `change` only when a file was chosen, so a DISMISSED chooser would leave this promise
        // pending forever -- and `browseLocal` awaits it, so the form would be wedged with
        // `Browse` unusable for the page's life. `cancel` on `<input type=file>` is the event
        // that reports the dismissal.
        fileInput.oncancel = () => { resolve(undefined); };
        fileInput.onchange = () => {
          const f = fileInput.files?.[0];
          if (f === undefined) { resolve(undefined); return; }
          void f.arrayBuffer().then((buf) => {
            pending = { name: f.name, bytes: new Uint8Array(buf) };
            resolve(f.name);
          }, (err: unknown) => {
            // A FAILED READ MUST NOT LEAVE THE PROMISE PENDING either, for the reason above --
            // and it must not leave a STALE `pending` behind, or Start would upload the previous
            // file under this one's name.
            pending = undefined;
            status.textContent = `could not read ${f.name}: `
              + `${err instanceof Error ? err.message : String(err)}`;
            resolve(undefined);
          });
        };
        fileInput.click();
      });
    },
    submit: async (keywords) => {
      const direction = keywords.find((k) => k.toLowerCase().startsWith('direction='));
      const isSend = direction?.toLowerCase().endsWith('send') === true;
      const localName = localNameFrom(keywords);
      // CLEARED PER SUBMIT, not per page: a refusal from the previous transfer must not be
      // reported as this one's ending.
      receiveError = undefined;
      running = { direction: isSend ? 'send' : 'receive' };
      if (!isSend) {
        // THE DOWNLOAD'S NAME IS FIXED AT SUBMIT, from the keywords actually submitted, so a
        // field edited after the transfer started cannot rename the file that arrived.
        saveName = localName;
        // A RECEIVE SENDS NO CHUNKS. Nothing is staged, so `transferGateway`'s "nothing staged
        // means an empty upload" reading never applies -- `transferCommand` builds a receive from
        // the keywords and the bytes come back as `transferData`.
        send(JSON.stringify({ kind: 'transferStart', keywords }));
        return { ok: true };
      }
      if (pending === undefined) {
        // REFUSED HERE, AND THIS GUARD IS THE DANGEROUS ONE TO LOSE. The operator can type a name
        // into `Local file` without ever using Browse, in which case the keywords are complete and
        // the gateway has NO BYTES -- and "nothing staged" means "empty file" on that side by
        // design (`transferGateway.ts:272-290`), so the upload would succeed at zero bytes and
        // under `Exist=replace` overwrite the host dataset with nothing.
        return { ok: false, error: 'choose a local file with Browse first' };
      }
      if (pending.name !== localName) {
        // THE BYTES AND THE NAME MUST BE THE SAME FILE'S. Browse sets both together, but the
        // `Local file` field stays editable afterwards, so an operator who picks `A` and then
        // edits the field to `B` would upload A's bytes while every message said B. Refused rather
        // than silently preferring one, because only the operator knows which they meant.
        return {
          ok: false,
          error: `${localName} is not the file you chose (${pending.name}); use Browse again`,
        };
      }
      // RE-CHUNKED FROM THIS BROWSER'S OWN COPY ON EVERY START, which is what makes a retry
      // honest. See `pending`.
      return bridge.sendFile(pending.name, pending.bytes, keywords);
    },
    cancel: () => {
      // `bridge.cancel()` IS THE ONLY RESET for the reassembler, and the recorded refusal goes
      // with it: a cancelled transfer's partial bytes are dropped, so its complaint must not be
      // reported as the NEXT transfer's ending.
      receiveError = undefined;
      bridge.cancel();
    },
  });

  browseButton.addEventListener('click', () => { void ui.browseLocal(); });
  startButton.addEventListener('click', () => { void ui.start(); });
  cancelButton.addEventListener('click', () => { ui.requestCancel(); });
  /**
   * Save, WHICH IS A BUTTON RATHER THAN SOMETHING THE COMPLETION DOES.
   *
   * `showSaveFilePicker` needs TRANSIENT USER ACTIVATION, and the click that started the transfer
   * is spent by the time `transferDone` arrives -- so the dialog cannot be opened from the
   * completion callback at all. The operator's click on THIS button is the activation that opens
   * it. The `<a download>` fallback has no such requirement, but routing both through one button
   * keeps the two paths identical from the form's seat.
   *
   * DISABLED ONLY ON SUCCESS. `save()` reports its own failures (`transferBridge.ts`) and leaves
   * the bytes retryable, so a dismissed dialog or a failed write must leave the button live.
   */
  saveButton.addEventListener('click', () => {
    void bridge.save(saveName).then((r) => {
      if (!r.ok) { status.textContent = r.error; return; }
      saveButton.disabled = bridge.hasUnsaved();
    });
  });

  return {
    hasUnsaved: () => bridge.hasUnsaved(),
    /**
     * The three gateway transfer kinds, narrowed HERE.
     *
     * `BridgeDeps.onTransfer` is typed as the raw `JSON.parse` result, and `bridgecore.ts:76-82`
     * explains why it declines to narrow: this file validates nothing either, but it is the one
     * that knows which kinds it asked for, so the `as`-free field reads below are coerced at the
     * point of use rather than the whole message being asserted into a union it was never checked
     * against.
     */
    onMessage: (msg) => {
      if (msg.kind === 'transferProgress') {
        ui.progress(String(msg['text']));
        return;
      }
      if (msg.kind === 'transferData') {
        // ALREADY A `Uint8Array`. `bridgecore.ts:172-173` decodes `bytes` with `atob` before
        // calling this -- `Buffer` does not exist in a served module -- so decoding again here
        // would turn the bytes into the characters of their own base64 text.
        const out = bridge.acceptData(
          Number(msg['seq']), Number(msg['total']), msg['bytes'] as Uint8Array,
        );
        if (!out.ok) {
          // HELD FOR THE ENDING, not painted now -- see `receiveError`. Shown too, because a
          // refusal mid-burst is worth seeing immediately; `transferDone` is what makes it stick.
          receiveError = out.error;
          status.textContent = out.error;
        }
        return;
      }
      if (msg.kind !== 'transferDone') return;
      const ok = msg['ok'] === true;
      if (ok && running?.direction === 'receive') {
        // THE ZERO-BYTE RECEIVE, which no chunk can announce: `chunkBytes` emits none for an empty
        // source, and a gateway that helpfully sent one empty chunk is refused by the
        // reassembler with `chunk 0 arrived after all 0 bytes`. `finishEmpty()` is inert when
        // anything was staged or is still in flight, so this cannot mask a half-finished receive
        // -- and it is guarded on the DIRECTION because a SEND that staged nothing is every
        // successful upload there is. See `running`.
        bridge.finishEmpty();
      }
      if (ok && receiveError !== undefined) {
        // A SUCCESS THE BROWSER COULD NOT RECEIVE IS NOT A SUCCESS. The run succeeded host-side,
        // so the gateway says so; but a chunk was refused and there is no file to save, and
        // `done: N bytes` over that is the one report the operator must not be left with.
        ui.finished({ ok: false, error: receiveError });
      } else {
        // BUILT EXPLICITLY RATHER THAN SPREAD: `exactOptionalPropertyTypes` is on, and `bytes`
        // is absent on a `transferDone` that carried none (`protocol.ts:41`).
        const bytes = msg['bytes'];
        ui.finished(ok
          ? { ok: true, ...(typeof bytes === 'number' ? { bytes } : {}) }
          : { ok: false, error: String(msg['error'] ?? 'the transfer failed') });
      }
      // ENABLED ONLY NOW, AND THE PICKER IS NOT OPENED HERE -- see the Save handler above.
      saveButton.disabled = !bridge.hasUnsaved();
      running = undefined;
    },
  };
}
