import { describe, it, expect } from 'vitest';
import {
  forwardKeys, forwardPaste, isEditableTarget,
  type ForwardKeysDeps, type ForwardPasteDeps,
} from '../src/forwardKeys.js';
import type { Action } from '@tn3270/frontend';

/** A `keydown` event, as much of one as `actionForKey` and the predicate actually read. */
const ev = (o: {
  key: string; code?: string; ctrl?: boolean; alt?: boolean; meta?: boolean; shift?: boolean;
  tag?: string; editable?: boolean;
}): unknown => ({
  key: o.key,
  code: o.code ?? '',
  ctrlKey: o.ctrl === true,
  altKey: o.alt === true,
  metaKey: o.meta === true,
  shiftKey: o.shift === true,
  target: o.tag === undefined && o.editable === undefined
    ? null
    : { tagName: o.tag, isContentEditable: o.editable === true },
  preventDefault: () => {},
});

/**
 * A fake window, because vitest runs `environment: 'node'`: there is no `window` to listen on.
 *
 * The same injected-deps shape as `keyboardUi.test.ts`'s fake DOM and for the same reason -- what
 * is worth testing is which actions get forwarded and whether the default was prevented, neither
 * of which needs a real event loop. jsdom is deliberately not a dependency of this repo.
 */
function fake(): {
  deps: ForwardKeysDeps;
  readonly sent: Action[];
  readonly prevented: unknown[];
  fire: (e: unknown) => void;
} {
  const sent: Action[] = [];
  const prevented: unknown[] = [];
  let handler: ((e: unknown) => void) | undefined;
  return {
    sent,
    prevented,
    fire: (e) => {
      if (handler === undefined) throw new Error('forwardKeys registered no handler');
      // The real DOM calls `preventDefault` ON the event; the fake records which events had it
      // called, so "only claimed keys are prevented" is checkable.
      handler({ ...(e as object), preventDefault: () => { prevented.push(e); } });
    },
    deps: {
      on: (_type, fn) => { handler = fn as (e: unknown) => void; },
      sendAction: (a) => { sent.push(a); },
    },
  };
}

describe('forwardKeys', () => {
  it('forwards a claimed chord as its action', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'a', code: 'KeyA', ctrl: true }));
    expect(f.sent).toEqual([{ kind: 'attn' }]);
  });

  it('forwards a plain character as a type action', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'A', code: 'KeyA' }));
    expect(f.sent).toEqual([{ kind: 'type', text: 'A' }]);
  });

  it('forwards NOTHING for a key no table claims', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'z', code: 'KeyZ', ctrl: true }));
    expect(f.sent, 'Ctrl-Z is deliberately unclaimed').toEqual([]);
  });

  /*
    PREVENTDEFAULT ONLY FOR CLAIMED KEYS, asserted in BOTH directions.

    `renderer.ts` records why: preventing everything would break shortcuts we do not use and would
    stop Tab moving focus. A test that only checked the claimed case would pass an implementation
    that prevented every key.
  */
  it('prevents the default for a claimed key', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'a', code: 'KeyA', ctrl: true }));
    expect(f.prevented.length, 'a claimed key must be ours').toBe(1);
  });

  it('does NOT prevent the default for an unclaimed key', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'z', code: 'KeyZ', ctrl: true }));
    expect(f.prevented.length, 'an unclaimed key must reach the browser').toBe(0);
  });

  /*
    A FORM CONTROL IS SKIPPED EVEN WHEN THE KEY IS CLAIMED, which is the half that matters: a
    plain letter IS claimed (`{kind:'type'}`), so an implementation missing this check would send
    every character an operator typed into a field to the mainframe AND suppress it locally --
    exactly the live bug `renderer.ts` records from 2026-10-07.
  */
  it('skips an event aimed at a form control, claimed or not', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const f = fake();
      forwardKeys(f.deps);
      f.fire(ev({ key: 'A', code: 'KeyA', tag }));
      expect(f.sent, `${tag} must be left alone`).toEqual([]);
      expect(f.prevented.length, `${tag} must keep its default`).toBe(0);
    }
  });

  it('skips a contentEditable target too', () => {
    const f = fake();
    forwardKeys(f.deps);
    f.fire(ev({ key: 'A', code: 'KeyA', tag: 'DIV', editable: true }));
    expect(f.sent).toEqual([]);
  });

  it('listens for keydown and nothing else', () => {
    const types: string[] = [];
    forwardKeys({ on: (type) => { types.push(type); }, sendAction: () => {} });
    expect(types).toEqual(['keydown']);
  });
});

/**
 * A `paste` event, as much of one as `forwardPaste` actually reads.
 *
 * `clipboardData` IS NULLABLE ON THE REAL EVENT and a case below passes `null` for it, which is
 * not hypothetical tidiness: `lib.dom` types `ClipboardEvent.clipboardData` as
 * `DataTransfer | null`, so the `?.` in the implementation is load-bearing rather than defensive.
 *
 * `getData` HONORS ITS FORMAT ARGUMENT, and that is a FIX rather than fidelity for its own sake.
 * It ignored the argument at first, and MEASURED: mutating the implementation's
 * `getData('text/plain')` to `getData('text/html')` left all 22 tests GREEN. A real `DataTransfer`
 * returns `''` for a format it does not hold, so that mutant is a paste that silently does
 * nothing in production -- the exact class of defect this file's other cases exist to catch. A
 * fake that ignores an argument cannot test the argument.
 */
const pasteEv = (o: {
  text?: string | null; tag?: string; editable?: boolean;
}): unknown => ({
  target: o.tag === undefined && o.editable === undefined
    ? null
    : { tagName: o.tag, isContentEditable: o.editable === true },
  clipboardData: o.text === null
    ? null
    : { getData: (fmt: string) => (fmt === 'text/plain' ? o.text ?? '' : '') },
});

/**
 * A fake window for the paste half. Same shape and same reason as `fake()` above: vitest runs
 * `environment: 'node'`, so there is no `window` and no `location` to read a protocol off.
 *
 * `protocol` DEFAULTS TO `https:` -- a host that DOES install -- so each test states only the
 * thing it is about. The gate itself is asserted by the cases that pass it explicitly.
 */
function fakePaste(protocol = 'https:'): {
  deps: ForwardPasteDeps;
  readonly sent: Action[];
  readonly prevented: unknown[];
  readonly types: string[];
  readonly cleared: number[];
  fire: (e: unknown) => void;
} {
  const sent: Action[] = [];
  const prevented: unknown[] = [];
  const types: string[] = [];
  const cleared: number[] = [];
  let handler: ((e: unknown) => void) | undefined;
  return {
    sent,
    prevented,
    types,
    cleared,
    fire: (e) => {
      if (handler === undefined) throw new Error('forwardPaste registered no handler');
      handler({ ...(e as object), preventDefault: () => { prevented.push(e); } });
    },
    deps: {
      on: (type, fn) => { types.push(type); handler = fn as (e: unknown) => void; },
      sendAction: (a) => { sent.push(a); },
      protocol,
      // RECORDS THE ORDER, not just the fact: `cleared.push(sent.length)` is what makes "cleared
      // only once the paste was claimed" checkable, since a clear BEFORE the send reads as 0.
      clearSelection: () => { cleared.push(sent.length); },
    },
  };
}

describe('forwardPaste', () => {
  it('sends the clipboard text as a paste action', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: 'HELLO' }));
    expect(f.sent).toEqual([{ kind: 'paste', text: 'HELLO' }]);
  });

  /*
    `paste` AND NOT `type`, asserted on the KIND rather than only on the text.

    `keymap.ts` records the reason and it is not stylistic: `type` reaches `Keyboard.typeString`,
    which sends every `\n` and `\f` into the field AS A CHARACTER with the MDT set, so the next AID
    carries the corruption to the host as field data. An implementation that sent `{kind:'type'}`
    would pass a text-only assertion while doing exactly that, so the kind is the test.
  */
  it('sends multi-line text as ONE paste action, never as a type', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: 'LOGON\nUSER\fX' }));
    expect(f.sent).toEqual([{ kind: 'paste', text: 'LOGON\nUSER\fX' }]);
  });

  it('prevents the default once it has claimed the paste', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: 'HELLO' }));
    expect(f.prevented.length, 'a claimed paste is ours').toBe(1);
  });

  /*
    A FORM CONTROL IS SKIPPED, which is the case with a measured live bug behind it: the gateway's
    transfer form has real text inputs, this listener is on `window`, and the 2026-10-07 bug in
    the OTHER direction sent every character typed into that form to the mainframe and left the
    field empty. BOTH halves are asserted -- nothing sent AND the default left alone -- because an
    implementation that returned after `preventDefault` would swallow the operator's paste locally
    while appearing to skip it.
  */
  it('skips a paste aimed at a form control, and leaves its default alone', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const f = fakePaste();
      forwardPaste(f.deps);
      f.fire(pasteEv({ text: 'HELLO', tag }));
      expect(f.sent, `${tag} must be left alone`).toEqual([]);
      expect(f.prevented.length, `${tag} must keep its native paste`).toBe(0);
      expect(f.cleared, `${tag} must not cost the selection`).toEqual([]);
    }
  });

  it('skips a contentEditable target too', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: 'HELLO', tag: 'DIV', editable: true }));
    expect(f.sent).toEqual([]);
    expect(f.prevented.length).toBe(0);
  });

  /*
    AN EMPTY CLIPBOARD IS NOT A PASTE, and the half that matters is the SELECTION: an empty paste
    types nothing and warns about nothing, so claiming it would take the operator's highlight away
    with no visible cause -- a copy they were about to make, lost to a stray chord.

    A `null` `clipboardData` is the same non-event by a different route, and it is the shape
    `lib.dom` says the real event can have.
  */
  it('does nothing at all for an empty clipboard', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: '' }));
    expect(f.sent).toEqual([]);
    expect(f.prevented.length, 'an empty paste must keep its default').toBe(0);
    expect(f.cleared, 'an empty paste must not cost the selection').toEqual([]);
  });

  it('does nothing when the event carries no clipboardData at all', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: null }));
    expect(f.sent).toEqual([]);
    expect(f.prevented.length).toBe(0);
  });

  /*
    THE SELECTION IS CLEARED, AND ONLY AFTER THE PASTE IS CLAIMED.

    `renderer.ts`'s `keydown` listener records why both halves matter: the screen is about to
    change, so a highlight over changed text would offer a copy of something never seen -- but a
    clear on a paste we DECLINED would wipe a selection for nothing, which is why the skip cases
    above assert `cleared` is empty. `toEqual([0])` pins the ORDER too: the clear happens with
    zero actions sent, i.e. BEFORE the send, matching the keydown listener's sequence.
  */
  it('clears the selection before sending, since the screen is about to change', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    f.fire(pasteEv({ text: 'HELLO' }));
    expect(f.cleared).toEqual([0]);
  });

  it('listens for paste and nothing else', () => {
    const f = fakePaste();
    forwardPaste(f.deps);
    expect(f.types).toEqual(['paste']);
  });

  /*
    THE SAFETY GATE, AND IT IS THE MOST IMPORTANT TEST IN THIS FILE.

    `renderer.ts` is loaded by TWO front ends -- `gui/index.html` pulls the same `renderer.js` into
    the Electron GUI -- and only the web gateway answers `{kind:'paste'}`. MEASURED 2026-10-26 on
    Electron 44.3.0: a `paste` event reaches an Electron page by five routes (`Ctrl+V`,
    `Ctrl+Shift+V`, `Shift+Insert`, middle-click, `webContents.paste()`), and the resulting throw
    in `applyAction` FREEZES the main process event loop rather than merely logging -- a heartbeat
    timer stopped dead and the process needed killing.

    ASSERTED AS A MISSING LISTENER, NOT AS AN INERT ONE, which is why `types` is checked and not
    just `sent`: a registered-but-returning handler would satisfy a send-only assertion and would
    be one careless edit away from being the hazard again. `fire` throwing is the second half of
    the same statement.
  */
  it('installs NO listener on file:, the Electron GUI, where a paste action freezes main', () => {
    const f = fakePaste('file:');
    forwardPaste(f.deps);
    expect(f.types, 'file: must get no paste listener at all').toEqual([]);
    expect(() => { f.fire(pasteEv({ text: 'HELLO' })); }).toThrow(/registered no handler/);
  });

  it('installs on http: and https:, and on nothing else', () => {
    for (const protocol of ['http:', 'https:']) {
      const f = fakePaste(protocol);
      forwardPaste(f.deps);
      expect(f.types, `${protocol} is the web gateway`).toEqual(['paste']);
    }
    // The hosts a `renderer.js` could plausibly be loaded from that are NOT the gateway. `file:`
    // is the Electron GUI and has its own case above; the rest would each be a new front end, and
    // a new front end must ARRIVE at this list deliberately rather than inherit a paste path.
    for (const protocol of ['file:', 'app:', 'chrome-extension:', 'data:', 'about:', '']) {
      const f = fakePaste(protocol);
      forwardPaste(f.deps);
      expect(f.types, `${protocol} must not raise a paste action`).toEqual([]);
    }
  });
});

describe('isEditableTarget', () => {
  // EXPORTED AND TESTED DIRECTLY because `renderer.ts` imports it: it is a shared rule now, not a
  // private detail, and a change there must fail here rather than in a browser.
  it('is true for the three form tags and for contentEditable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isEditableTarget({ tagName }), tagName).toBe(true);
    }
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for a plain element, for null, and for a missing tagName', () => {
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });

  it('is false for a BUTTON, which every cap on these surfaces is', () => {
    // THE CASE THAT WOULD BREAK THE FEATURE if the predicate were widened to "any control":
    // the keyboard window is 118 buttons, and one of them has focus after every click.
    expect(isEditableTarget({ tagName: 'BUTTON' })).toBe(false);
  });
});
