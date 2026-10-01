import { describe, it, expect, vi } from 'vitest';
import { caretAfterEdit, createTransferUi, type UiDeps, type UiField } from '../src/transferUi.js';

/**
 * A fake DOM, because vitest runs `environment: 'node'` and there is no `document`.
 *
 * The same shape as `packages/web/test/bridgecore.test.ts`'s fake socket and for the same
 * reason: the logic worth testing is which fields are shown, what values the model holds and
 * what gets submitted -- none of which needs a real element. jsdom is deliberately not a
 * dependency of this repo.
 */
function fakeDeps(): UiDeps & { readonly rendered: UiField[][]; readonly submitted: string[][] } {
  const rendered: UiField[][] = [];
  const submitted: string[][] = [];
  return {
    rendered,
    submitted,
    render: (fields) => { rendered.push([...fields]); },
    setStatus: vi.fn(),
    setRunning: vi.fn(),
    browse: vi.fn(async () => '/tmp/chosen.txt'),
    submit: vi.fn(async (keywords: readonly string[]) => {
      submitted.push([...keywords]);
      return { ok: true as const };
    }),
    cancel: vi.fn(),
  };
}

describe('createTransferUi', () => {
  it('renders every applicable field and no inapplicable one', () => {
    const deps = fakeDeps();
    createTransferUi(deps);
    const first = deps.rendered[0]!;
    const ids = first.map((f) => f.id);
    // A fresh form is Direction=receive, Mode=binary: `recfm`/`lrecl`/`blksize` need a send
    // and `cr` needs ascii, so all four are inapplicable.
    expect(ids).toContain('direction');
    expect(ids).toContain('localFile');
    expect(ids).toContain('hostFile');
    expect(ids).not.toContain('recfm');
    expect(ids).not.toContain('cr');
  });

  it('shows Recfm once Direction is send, via the SHARED model', () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    ui.cycle('direction', 1);
    const ids = deps.rendered[deps.rendered.length - 1]!.map((f) => f.id);
    expect(ids).toContain('recfm');
  });

  it('CLEARS an inapplicable value in the model, not merely hides it', () => {
    // The whole reason the model does the clearing: a value hidden but retained would be
    // submitted as a keyword the TUI would have wiped, so the two front ends would differ on
    // what they send to a live host.
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    ui.cycle('direction', 1);          // send: recfm applicable
    ui.cycle('recfm', 1);              // recfm = fixed
    expect(ui.values().recfm).toBe('fixed');
    ui.cycle('direction', 1);          // back to receive: recfm inapplicable
    expect(ui.values().recfm).toBe('');
  });

  it('refuses a non-digit in a numeric field, through setFieldText', () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    ui.cycle('direction', 1);
    ui.cycle('recfm', 1);              // lrecl becomes applicable
    ui.type('lrecl', '80');
    expect(ui.values().lrecl).toBe('80');
    ui.type('lrecl', '8x');
    expect(ui.values().lrecl, 'a non-digit must be refused, not accepted and failed at submit')
      .toBe('80');
  });

  it('puts a browsed path into the local file field', async () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    await ui.browseLocal();
    expect(ui.values().localFile).toBe('/tmp/chosen.txt');
  });

  it('leaves the field alone when the dialog is canceled', async () => {
    const deps = fakeDeps();
    deps.browse = vi.fn(async () => undefined);
    const ui = createTransferUi(deps);
    ui.type('localFile', '/typed/path');
    await ui.browseLocal();
    expect(ui.values().localFile, 'a canceled dialog must not erase a typed path')
      .toBe('/typed/path');
  });

  it('asks for an OPEN dialog on a send and a SAVE dialog on a receive', async () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    await ui.browseLocal();
    expect(deps.browse).toHaveBeenCalledWith('receive');
    ui.cycle('direction', 1);
    await ui.browseLocal();
    expect(deps.browse).toHaveBeenLastCalledWith('send');
  });

  it('submits the model keywords, not the DOM', async () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    ui.type('localFile', '/tmp/a');
    ui.type('hostFile', 'MY.DATASET');
    await ui.start();
    const sent = deps.submitted[0]!;
    expect(sent).toContain('Direction=receive');
    expect(sent).toContain('LocalFile=/tmp/a');
    expect(sent).toContain('HostFile=MY.DATASET');
    // Unset optional fields contribute NOTHING, which is what lets the host choose.
    expect(sent.some((k) => k.startsWith('Recfm='))).toBe(false);
  });

  /**
   * A LOCAL REFUSAL LEAVES THE FORM IDLE -- ASSERTED ON THE END STATE, NOT ON THE CALL HISTORY.
   *
   * This used to read `expect(deps.setRunning).not.toHaveBeenCalledWith(true)`, which encoded the
   * IMPLEMENTATION rather than the property: it was true only because `start()` armed the running
   * state AFTER awaiting the submit, and that ordering was a defect in its own right -- a completion
   * arriving during the await was overwritten by the submit that started it, leaving a SUCCESSFUL
   * transfer reporting as permanently in progress (see `transferUi.ts`'s `start`, and
   * `transferSeamIpc.test.ts` for the composed reproduction).
   *
   * `start()` now announces the transfer before the await, so a refusal legitimately passes through
   * `setRunning(true)` and back to `setRunning(false)`. The thing an operator can actually tell apart
   * is WHERE IT ENDS UP: nothing running, the controls re-enabled, and the refusal on the status
   * line. A transient `true` is invisible -- it is one synchronous turn with no paint between.
   */
  it('shows a local refusal on the form and ENDS UP not running', async () => {
    const deps = fakeDeps();
    deps.submit = vi.fn(async () => ({ ok: false as const, error: 'keyboard locked' }));
    const ui = createTransferUi(deps);
    await ui.start();
    expect(deps.setStatus).toHaveBeenCalledWith('keyboard locked');
    expect(ui.running(), 'a refused transfer is not running').toBe(false);
    // THE LAST WORD TO THE DOM must re-enable the form. A refusal that left the controls disabled
    // would freeze the window for its whole life, which is the failure the early arming exists to
    // prevent -- so this is the assertion that keeps the fix from moving the bug one path over.
    const said = vi.mocked(deps.setRunning).mock.calls.map((c) => c[0]);
    expect(said[said.length - 1], 'the controls must be re-enabled after a refusal').toBe(false);
  });

  it('IGNORES a second start while one is running', async () => {
    // Two submits would interleave two machines' frames on one screen; the TUI refuses a
    // second Enter for exactly this reason (`app.ts:submitTransfer`).
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    await ui.start();
    await ui.start();
    expect(deps.submitted.length).toBe(1);
  });

  it('accepts a start again once the transfer has finished', async () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    await ui.start();
    ui.finished({ ok: true, bytes: 10 });
    await ui.start();
    expect(deps.submitted.length).toBe(2);
  });

  /**
   * A REFUSAL'S MESSAGE DOES NOT OUTLIVE THE SUBMIT THAT SUCCEEDED.
   *
   * `show()` gives `state.error` precedence over the help, and only an ACCEPTED edit clears it
   * (`setFieldText`/`cycleField` write `error: undefined`). So a refused submit followed by a
   * successful one leaves the message in the state, and the first edit the model REJECTS
   * returns that state unchanged -- resurfacing a complaint about a transfer that has already
   * finished. A rejected edit is the trigger precisely because an accepted one would clear it
   * by accident, which is what would make this intermittent in the window.
   *
   * NOT a symptom during the transfer: `start()` calls `setStatus('transferring')` directly,
   * and `cycle`/`type`/`browseLocal` all return early while running, so no `show()` runs then.
   */
  it('does not resurface a stale refusal after a later submit succeeded', async () => {
    const deps = fakeDeps();
    let refuse = true;
    deps.submit = vi.fn(async (keywords: readonly string[]) => {
      deps.submitted.push([...keywords]);
      return refuse ? { ok: false as const, error: 'keyboard locked' } : { ok: true as const };
    });
    const ui = createTransferUi(deps);
    ui.cycle('direction', 1);                  // send
    ui.cycle('recfm', 1);                      // fixed, so lrecl is applicable
    await ui.start();                          // refused: error is set
    refuse = false;
    await ui.start();                          // accepted
    ui.finished({ ok: true, bytes: 10 });

    vi.mocked(deps.setStatus).mockClear();
    // REJECTED by `setFieldText`, so the state comes back identical -- the one edit that cannot
    // clear a stale error by accident.
    ui.type('lrecl', '8x');
    const said = vi.mocked(deps.setStatus).mock.calls.map((c) => c[0]);
    expect(said, 'a rejected edit after a successful transfer must not reprint the old refusal')
      .not.toContain('keyboard locked');
    expect(said).toContain('Choose a local file and name the host file, then Start.');
  });

  /**
   * A CYCLE FIELD'S OPTIONS KEEP THE MODEL'S TABLE ORDER WHATEVER THE CURRENT VALUE IS.
   *
   * Not in the plan's test list, and it caught a real defect in the plan's `offered`: the
   * options are collected by cycling the model from the CURRENT value, so a naive collector
   * returns the list ROTATED -- `['variable', 'undefined', '', 'fixed']` once Recfm is
   * variable. A `<select>` built from that reorders its own menu every time the user picks
   * something, which is the view misbehaving rather than the model. Cycling is still how the
   * values are discovered (the VM rule lives in the model's private `valuesFor`), but the
   * result is put back into `TRANSFER_FIELDS` order before the view sees it.
   */
  it('offers a cycle field its values in TABLE order, not rotated by the current value', () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    ui.cycle('direction', 1);                 // send: recfm applicable
    const optionsNow = (): readonly string[] => {
      const last = deps.rendered[deps.rendered.length - 1]!;
      return last.find((f) => f.id === 'recfm')!.options;
    };
    expect(optionsNow()).toEqual(['', 'fixed', 'variable', 'undefined']);
    ui.cycle('recfm', 1);                     // fixed
    ui.cycle('recfm', 1);                     // variable
    expect(ui.values().recfm).toBe('variable');
    expect(optionsNow(), 'the menu must not reorder itself as the user picks from it')
      .toEqual(['', 'fixed', 'variable', 'undefined']);
  });

  /**
   * THE VM ASYMMETRY REACHES THE VIEW, because the options are obtained by asking the model.
   *
   * `transferForm.ts`'s `valuesFor` is private and drops `Recfm=undefined` on VM, since
   * `transfer.ts` records that CMS supports only fixed and variable. Re-filtering the field
   * table here would be that rule's second home -- the exact drift the shared model exists to
   * prevent -- so this pins that the view never offers a value the model would refuse.
   */
  it('does not offer Recfm=undefined on VM, without re-stating the rule', () => {
    const deps = fakeDeps();
    const ui = createTransferUi(deps);
    ui.cycle('direction', 1);                 // send
    ui.cycle('host', 1);                      // vm
    expect(ui.values().host).toBe('vm');
    const last = deps.rendered[deps.rendered.length - 1]!;
    expect(last.find((f) => f.id === 'recfm')!.options)
      .toEqual(['', 'fixed', 'variable']);
  });

  /**
   * The interleaving a reviewer measured in real Electron: Start pressed while the native file
   * dialog is open, then the dialog resolves LATE, into a running transfer.
   *
   * The `await` in `browseLocal` is a suspension point, so the check before it proves nothing about
   * the state after it. Without the second check the late resolution did two visible wrongs: the
   * redraw's `show()` painted the idle help text over a live progress line, and `setFieldText`
   * mutated the form model while the host was mid-transfer.
   */
  it('IGNORES a dialog that resolves after a transfer has started', async () => {
    const deps = fakeDeps();
    // A browse that does not resolve until the test says so, which is what makes the window
    // between the two checks observable at all.
    let release: (path: string) => void = () => {};
    deps.browse = vi.fn(() => new Promise<string | undefined>((res) => { release = res; }));
    const ui = createTransferUi(deps);

    const browsing = ui.browseLocal();
    await ui.start();
    ui.progress('128 bytes');
    expect(ui.running()).toBe(true);

    release('/tmp/picked.txt');
    await browsing;

    // The live progress line must still be the last thing the status shows.
    const statuses = vi.mocked(deps.setStatus).mock.calls.map((c) => c[0]);
    expect(statuses[statuses.length - 1]).toBe('128 bytes');
    // And the model must be untouched: a path arriving mid-transfer is a path for the NEXT one.
    expect(ui.values().localFile).toBe('');
  });
});

/**
 * The caret arithmetic, which was inline in `transferBoot.ts` and wrong there.
 *
 * Every case below is a pure computation, which is the point: the version this replaced could not
 * be reached by any test, because `transferBoot.ts` needs a `document` to import.
 */
describe('caretAfterEdit', () => {
  it('leaves the caret where the browser put it when the model ACCEPTED the edit', () => {
    // `80` with the caret after the `0`, type `0`: the model takes it, nothing was dropped.
    expect(caretAfterEdit({ start: 3, end: 3 }, '800', '800')).toEqual({ start: 3, end: 3 });
  });

  it('puts the caret BACK ONE when the model refused a keystroke MID-STRING', () => {
    // THE MEASURED BUG, in real Electron: `lrecl` holding `800`, caret at 1, type a non-digit.
    // The browser has already made the input read `8x00` with the caret at 2; the model refuses,
    // so the element will show `800` again and the caret belongs at 1, where the user left it.
    // The old code clamped to `value.length` only, so 2 was within range and survived untouched.
    expect(caretAfterEdit({ start: 2, end: 2 }, '8x00', '800')).toEqual({ start: 1, end: 1 });
  });

  it('puts the caret back one when the model refused a keystroke at the END', () => {
    // This case passed by LUCK under the old clamp: the caret was past `value.length`, so clamping
    // happened to land it in the right place. That is why the mid-string case above is the one
    // that proves the fix.
    expect(caretAfterEdit({ start: 4, end: 4 }, '800x', '800')).toEqual({ start: 3, end: 3 });
  });

  it('handles a refused PASTE, which drops more than one character', () => {
    // Why the contract is a length difference and not "back exactly one".
    expect(caretAfterEdit({ start: 6, end: 6 }, '80abc0', '800')).toEqual({ start: 3, end: 3 });
  });

  it('sends a null caret to the end of the text', () => {
    // A `<select>` or a `<button>`: no caret to preserve, and the end is the least surprising
    // place to leave one.
    expect(caretAfterEdit({ start: null, end: null }, '', 'variable'))
      .toEqual({ start: 8, end: 8 });
  });

  it('keeps a selection RANGE, shifted by what was dropped', () => {
    expect(caretAfterEdit({ start: 2, end: 5 }, '8x0000', '80000'))
      .toEqual({ start: 1, end: 4 });
  });

  it('clamps into range rather than returning a position the DOM would reject', () => {
    // Defensive: no caller produces this today, but a caret past the new text must not escape --
    // `setSelectionRange` would silently clamp, and a position below zero is simply meaningless.
    expect(caretAfterEdit({ start: 9, end: 9 }, '800', '800')).toEqual({ start: 3, end: 3 });
    expect(caretAfterEdit({ start: 0, end: 0 }, '800', '800')).toEqual({ start: 0, end: 0 });
  });

  it('never returns a NEGATIVE position when the model dropped more than the caret', () => {
    // `clearInapplicable` can empty a field outright, so `shown` may be shorter than the caret's
    // own offset -- here the model dropped two characters from under a caret at 1, which is -1
    // before clamping. `setSelectionRange(-1, ...)` is not an error the DOM reports; it silently
    // treats it as 0, so without the lower bound this would be a wrong caret nothing complains
    // about. Added because the lower bound survived mutation with only the test above.
    expect(caretAfterEdit({ start: 1, end: 1 }, '80', '')).toEqual({ start: 0, end: 0 });
  });
});
