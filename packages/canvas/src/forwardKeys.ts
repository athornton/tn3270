import { actionForKey, type KeyLike } from './keys.js';
import type { Action } from '@tn3270/frontend';

/**
 * Forward a window's real keystrokes -- and, in the browser, its real pastes -- to the session.
 *
 * TWO LISTENERS WITH DIFFERENT AUDIENCES, which is worth knowing before reading either: the
 * `keydown` half (`forwardKeys`) exists for the GUI's CHILD WINDOWS and runs in every front end,
 * while the `paste` half (`forwardPaste`) is for the WEB GATEWAY and refuses to install anywhere
 * else. They share `isEditableTarget` and nothing else. The paragraph below is the first half's
 * history; `forwardPaste`'s own docstring carries the second's, including the measurement that
 * makes its gate load-bearing.
 *
 * ## WHY THIS EXISTS: THE GUI'S CHILD WINDOWS WERE DEAF
 *
 * `renderer.ts` has the product's only other `keydown` listener and it lives in the CANVAS
 * window. The GUI's keypad and keyboard are separate `BrowserWindow`s, so with either focused the
 * physical keyboard did nothing at all -- not a dropped chord, silence. The user met it the day
 * the keyboard window shipped: a window full of keys is an invitation to type.
 *
 * **The web gateway never had THIS KEYDOWN problem and needs `forwardKeys` itself for nothing.**
 * Its surfaces are `<div>` overlays in the canvas page, so one `window` listener already covers
 * them. That asymmetry is Electron's, and it is the GUI's alone.
 *
 * (SCOPED TO `forwardKeys`, 2026-10-26, because this line said the gateway "needs nothing from
 * this module" and that became false while the diff that falsified it never touched it: the
 * gateway already imported `isEditableTarget` from here, and now takes `forwardPaste` too. This
 * is the summary-line-outlives-its-correction shape -- the heading five lines above was written
 * in the same edit and contradicted this one.)
 *
 * ## INJECTED DEPS, LIKE `keypadUi.ts` AND `keyboardUi.ts`
 *
 * Nothing here touches a real `window`: the caller supplies `on` and `sendAction`. That is what
 * lets this be unit-tested in `environment: 'node'` with a hand-rolled fake, and jsdom is
 * deliberately not a dependency of this repo.
 *
 * ## IT IMPORTS ONLY `keys.js`, WHICH IS THE WHOLE REASON IT IS A NEW FILE
 *
 * The obvious alternative was to export the listener from `renderer.ts`. That file value-imports
 * `blit.js` and `selection.js`, so a child window importing it would drag the whole rasteriser
 * into a document that has no canvas -- and every new specifier needs its own entry in two import
 * maps. `keys.js` has ZERO runtime imports, so each window's graph grows by exactly one file.
 */
export interface ForwardKeysDeps {
  /** Register the listener. The real caller passes `window.addEventListener`. */
  readonly on: (type: string, handler: (e: never) => void) => void;
  /** Deliver an action. The real caller passes its window's bridge. */
  readonly sendAction: (action: Action) => void;
}

/**
 * Is this event's target a thing the operator is typing INTO?
 *
 * ## EXTRACTED FROM `renderer.ts` RATHER THAN COPIED, 2026-10-23
 *
 * That file had this inline and now imports it. Two copies of a rule that must agree is how they
 * diverge, and this one is load-bearing: MEASURED 2026-10-07, without it typing into the web
 * gateway's transfer form sent every character TO THE MAINFRAME and left the field empty, because
 * `actionForKey` claims any single-code-point key as `{kind:'type'}` without knowing what was
 * focused, and the `preventDefault` that follows suppressed the character locally.
 *
 * ## CHECKED HERE AND NOT INSIDE `actionForKey`
 *
 * `keys.ts` is deliberately DOM-free -- `KeyLike` carries six scalars and no target, which is what
 * lets its cases run without jsdom. The target is a property of the EVENT, so the code that owns
 * real events owns this question.
 *
 * ## `BUTTON` IS DELIBERATELY NOT IN THE LIST
 *
 * Every cap on both surfaces is a `<button>`, and one of them holds focus after every click. A
 * predicate widened to "any form control" would make the keyboard window deaf again the moment an
 * operator clicked a key -- which is the exact bug this module exists to fix. The list is the
 * three TEXT-ENTRY tags plus `contentEditable`, and nothing else.
 */
export function isEditableTarget(
  target: { tagName?: unknown; isContentEditable?: unknown } | null,
): boolean {
  const tag = typeof target?.tagName === 'string' ? target.tagName : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    || target?.isContentEditable === true;
}

/** The shape this module reads off a real `KeyboardEvent`. */
type KeyEventLike = KeyLike & {
  readonly target: { tagName?: unknown; isContentEditable?: unknown } | null;
  readonly preventDefault: () => void;
};

/**
 * Install the listener. Called once per window, at load.
 *
 * ALL CHORDS WORK EVERYWHERE, which is the user's decision of 2026-10-23 and not an oversight:
 * `Ctrl-B` pressed in the keyboard window raises `toggleKeyboard`, which `main.ts` answers by
 * showing and focusing the window that is already open -- a harmless self-focus.
 * `openKeyboardWindow` is idempotent precisely so a repeated chord cannot stack a second window.
 * Special-casing the two toggle chords would add a second place for the rule to be wrong.
 */
export function forwardKeys(deps: ForwardKeysDeps): void {
  deps.on('keydown', (raw: never) => {
    const e = raw as unknown as KeyEventLike;
    if (isEditableTarget(e.target)) return;
    const action = actionForKey(e);
    if (action === null) return;
    // `preventDefault` ONLY for keys we CLAIMED, so shortcuts we do not use keep working and Tab
    // does not move focus out of the window. `renderer.ts` makes the same call for the same reason.
    e.preventDefault();
    deps.sendAction(action);
  });
}

/** The shape this module reads off a real `ClipboardEvent`. */
type PasteEventLike = {
  readonly target: { tagName?: unknown; isContentEditable?: unknown } | null;
  readonly clipboardData?: { getData: (format: string) => string } | null;
  readonly preventDefault: () => void;
};

export interface ForwardPasteDeps {
  /**
   * Register the listener. The real caller passes `window.addEventListener`.
   *
   * THE HANDLER IS TYPED `PasteEventLike` AND NOT `never`, WHICH DIVERGES FROM `ForwardKeysDeps`
   * ABOVE ON PURPOSE. `never` costs the listener body its type checking: every field read has to
   * go through a `raw as unknown as ...` cast, and after that cast the compiler cannot tell
   * `clipboardData` from a typo. Naming the shape instead means `tsc` checks the body, and it
   * costs nothing elsewhere -- `PasteEventLike` is a local type that emits fine into the `.d.ts`,
   * and this file still pulls in no DOM lib types. The renderer's own
   * `handler as (e: Event) => void` is unavoidable either way (`TS2769` with `never`, `TS2345`
   * with this), so the count of casts goes from two to one rather than to zero.
   */
  readonly on: (type: string, handler: (e: PasteEventLike) => void) => void;
  /** Deliver the action. The real caller passes its window's bridge. */
  readonly sendAction: (action: Action) => void;
  /**
   * `location.protocol` of the document installing this. THE WHOLE SAFETY GATE; see below.
   *
   * PASSED IN RATHER THAN READ HERE for the reason the module header gives about every other
   * capability: these tests run under `environment: 'node'`, where there is no `location` at all,
   * and a gate nothing can drive is a gate nobody has checked.
   */
  readonly protocol: string;
  /**
   * Forget the renderer's selection, called ONLY once a paste has been claimed.
   *
   * A HOOK AND NOT AN IMPORT, because the selection is `renderer.ts`-local state by that file's
   * own deliberate design -- it is not in the `DrawList` and main cannot see it. This module
   * stays DOM-free and state-free, which is what keeps it testable.
   */
  readonly clearSelection: () => void;
}

/**
 * THE HOSTS WHOSE `paste` ACTION SOMEBODY ANSWERS. Nothing else may raise one.
 *
 * `http:`/`https:` is the WEB GATEWAY and only the web gateway: `web/src/main.ts` intercepts
 * `{kind:'paste'}` before `applyAction` and calls `applyPaste`. Electron's own page is `file:`
 * (MEASURED 2026-10-26: a `loadFile` window reports `location.protocol === 'file:'`), and the
 * gateway can never be `file:` -- `socketUrl` builds a `ws:`/`wss:` URL from the document's own
 * href, so a `file:`-loaded page has no socket to send on in the first place.
 */
const PASTE_HOSTS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * A PASTE, from the browser's own `Ctrl-V`. 2026-10-26.
 *
 * ## WHY AN EVENT AND NOT A CHORD OR A BUTTON
 *
 * `navigator.clipboard.readText()` would need a permission prompt in Chromium and does not exist
 * in Firefox. The `paste` event hands over the text with NO prompt in every browser, and the
 * native `Ctrl-V` is already the gesture an operator reaches for -- so this adds no chord to
 * `keys.ts` and needs no menu bar, which a browser tab does not have.
 *
 * ## IT IS INSTALLED ONLY ON THE WEB GATEWAY, AND THAT GATE IS NOT CAUTION -- IT IS A FIX
 *
 * `renderer.ts` IS LOADED BY TWO FRONT ENDS: `web/static/index.html` serves it to a browser, and
 * `gui/index.html`'s `<script type="module" src="../canvas/dist/renderer.js">` pulls the same
 * file into the ELECTRON GUI. (BY TAG AND NOT BY LINE: that document is five lines long, so any
 * comment added to it moves the line -- and `d4fce66` retired this feature's line citations for
 * exactly that.) A `paste` action raised
 * in the GUI reaches `gui/src/main.ts`'s `ipcMain.on('action')`, which intercepts `quit`,
 * `toggleKeypad`, `toggleKeyboard`, `transferForm` and `copy` -- and NOT `paste` -- then falls
 * through to `applyAction`, which THROWS on it by design (`frontend/src/actions.ts`: the front
 * end owns its own clipboard).
 *
 * MEASURED 2026-10-26, Electron 44.3.0 under Xvfb, because the cost of guessing here is the
 * operator's whole session:
 *   1. A `paste` EVENT really does reach the page in an Electron window, by FIVE routes, each
 *      `isTrusted: true` and carrying the real clipboard text: `Ctrl+V`, `Ctrl+Shift+V`,
 *      `Shift+Insert`, a middle-click, and `webContents.paste()`. The menu accelerator does NOT
 *      swallow the keystroke -- a run with no application menu at all saw the same events.
 *   2. An uncaught throw inside an `ipcMain.on` listener does not merely log. It FREEZES THE MAIN
 *      PROCESS EVENT LOOP: a 400ms heartbeat timer logged nothing at all afterwards and the
 *      process had to be killed, where the identical run with the throw removed logged its eight
 *      beats and exited 0. There is no `uncaughtException` handler in `gui/src/main.ts`.
 *   3. AND THE TWO HALVES REALLY DO JOIN UP IN THE SHIPPING CLIENT, which is the measurement
 *      that matters and the only one taken against `packages/gui` itself. With the gate removed
 *      and a live X11 clipboard owner, the real GUI under `TN3270_GUI_KEYS='Ctrl+v,Ctrl+a'`
 *      NEVER EXITED: it ignored its harness's 60s timeout and the SIGTERM that followed, and had
 *      to be `kill -9`ed -- no `action:` line, no `renderer[3]`, just a frozen client. WITH the
 *      gate it exits 0 on the same keys, raises no paste, and the trailing `Ctrl+A` still logs
 *      `{"kind":"attn"}` -- which is the liveness probe, since an absence alone would also be
 *      what a dead process produced.
 * So an UNGATED listener here would have handed every Electron operator a frozen app on `Ctrl+V`.
 * (An X11 selection dies with the process that owns it, so a counterfactual run needs a second
 * Electron alive holding the clipboard -- a first attempt measured an EMPTY clipboard instead and
 * saw no paste at all, which would have read as the hazard being unreachable.)
 *
 * ## WHY THE GUI DOES NOT INSTEAD GET A `paste` ARM, WHICH LOOKS LIKE THE OBVIOUS FIX
 *
 * It would DOUBLE-PASTE on Linux and Windows, and that is measured too. `gui/src/menu.ts` already
 * binds Paste to `Ctrl+Shift+V` off `darwin`, wired to `onPaste` -> `applyPaste`. In the run
 * above, `Ctrl+Shift+V` fired the page's `paste` event AND the menu's `click` -- and
 * `preventDefault()` on the event did NOT suppress the accelerator (`defaultPrevented: true` in
 * the page, `MENU_PASTE_CLICK` immediately after). An arm answering the action would therefore
 * apply the same clipboard twice for one keystroke, into a 3270 field, where a silently
 * half-doubled dataset name may be a VALID DIFFERENT NAME -- the exact failure `pasteAction.ts`
 * is written to avoid.
 *
 * The GUI has a WORKING paste already (that menu item), so the gate costs it nothing today. What
 * it does cost is the GUI's native `Ctrl+V`, which stays unbound there -- deliberately left for
 * the user to decide on, since fixing it means reconciling the accelerator with the event rather
 * than adding a handler.
 *
 * **THE INVARIANTS THE NEXT PERSON MUST NOT BREAK.** The gate is the only thing standing between
 * a stray `paste` event and a frozen main process, and THREE separate things keep it sufficient:
 *   1. `applyAction` still THROWS on `paste`. If that goes, re-measure before widening
 *      `PASTE_HOSTS` -- the throw is what makes a missing arm loud instead of silent.
 *   2. `gui/src/main.ts` still has no `paste` arm. If one is added, the double-paste measured
 *      above applies and the accelerator has to be reconciled first.
 *   3. **THE ELECTRON GUI'S `TN3270_GUI_URL` MODE STAYS A SEPARATE, EARLIER PATH.** This is the
 *      one the gate does NOT cover and the easiest to break by accident, so it is named rather
 *      than left to be rediscovered. That mode is an Electron window loading the gateway over
 *      `http:` -- so it PASSES `PASTE_HOSTS` and does install this listener. VERIFIED 2026-10-26
 *      that it is nonetheless safe, and safe for a reason that is nothing to do with the
 *      protocol: the URL branch `return`s out of `app.whenReady()` BEFORE either
 *      `Menu.setApplicationMenu` or `ipcMain.on('action')` is reached, so that window has no
 *      action listener and no Paste accelerator at all, and its `window.tn3270` is the GATEWAY's
 *      own socket bridge (the Electron preload is deliberately omitted in URL mode), whose
 *      `sendAction` reaches the gateway's real `paste` arm. Correct -- but by STATEMENT ORDER in
 *      another package.
 *      SO: MOVING THE MENU OR THE `ipcMain.on('action')` REGISTRATION ABOVE THAT EARLY RETURN --
 *      an ordinary-looking tidy-up, since both look like setup that belongs at the top -- would
 *      re-arm the freeze for URL mode with this gate untouched and nothing red anywhere. If that
 *      ordering changes, this mode needs its own answer, not a wider allowlist.
 *
 * ## IT MUST SKIP FORM CONTROLS, AND THAT IS MEASURED RATHER THAN CAUTIOUS
 *
 * This listener goes on `window`, and the gateway's transfer form has real text inputs. The
 * 2026-10-07 bug in the other direction is recorded on `renderer.ts`'s `keydown` listener: typing
 * into that form sent every character TO THE MAINFRAME and left the field empty. A paste into the
 * `Local file` field would do exactly the same, so `isEditableTarget` guards both.
 *
 * ## IT SENDS `paste`, NOT `type`
 *
 * `keymap.ts` records the whole reason: `type` reaches `Keyboard.typeString`, which would send
 * every `\n` and `\f` into the field AS A CHARACTER (EBCDIC 0x25 and 0x0c, MDT set), so the next
 * AID carries the corruption to the host as field data. `pasteString`'s x3270 semantics are what
 * the `paste` kind buys. (An earlier draft of this feature's plan said `\n` became ENTER and
 * submitted the panel. That is x3270's `kybd.c`, not this codebase -- `core/src/keyboard.ts` has
 * no AID path at all. Corruption, not submission.)
 *
 * ## A HUGE PASTE DROPS THE CONNECTION, AND IT IS WORTH KNOWING WHERE THAT COMES FROM
 *
 * There is NO LENGTH CHECK HERE and that is deliberate, but the consequence is not obvious from
 * this file. MEASURED 2026-10-26: the JSON envelope around the text is 53 bytes, and
 * `wsserver.ts`'s `MAX_MESSAGE_BYTES` is 8192 -- so a paste of up to 8139 ASCII characters is
 * delivered, 8140 is 8193 bytes, and `parseFrame` throws on the cap. `Connection` answers that by
 * CLOSING THE CLIENT rather than throwing (deliberately: a throw out of a `data` handler would
 * end the gateway process and disconnect every other operator's session), so what the operator
 * sees is "The connection to the gateway closed. Reload to reconnect." -- with nothing said about
 * length, and no `error` frame, because the socket is already gone.
 *
 * SO A MYSTERY DISCONNECT AFTER A BIG PASTE IS THIS, NOT A GATEWAY BUG. The 3270 session itself
 * survives -- the registry's grace window holds it and a reload reattaches -- so the outcome is
 * handled, just by dropping the connection instead of refusing the paste.
 *
 * NO CLIENT-SIDE LENGTH CHECK IS ADDED, and the reason is that it would be a second copy of a
 * limit this file cannot see: `MAX_MESSAGE_BYTES` lives in `packages/web`, the renderer has no
 * import from there (by hard constraint -- see this file's header), and the real budget depends on
 * UTF-8 byte length rather than character count. A threshold hardcoded here would drift from the
 * server's the first time either moved, and would reject pastes the gateway would have accepted.
 * If this is worth fixing it belongs at the GATEWAY, which knows its own cap and can answer with
 * the `error` frame the protocol already has.
 */
export function forwardPaste(deps: ForwardPasteDeps): void {
  // BEFORE `on`, so a host we do not serve gets NO LISTENER AT ALL rather than one that returns.
  // A registered-but-inert listener would be one edit away from being the hazard again, and this
  // way the absence is what the test asserts.
  if (!PASTE_HOSTS.has(deps.protocol)) return;
  deps.on('paste', (e) => {
    if (isEditableTarget(e.target)) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    /*
      AN EMPTY CLIPBOARD IS NOT A PASTE: it would type nothing and warn about nothing, so claiming
      it would take the operator's selection away for no visible reason.

      THE PREDICATE IS `text === ''` AND NOT "TEXT THAT WOULD TYPE NOTHING", which is a NEAR MISS
      deliberately not chased. MEASURED 2026-10-26 against the real `pasteString`: a `'\r'`-only
      or `'\r\r\r'` clipboard returns `{typed: 0, dropped: 0}` with no warning and the cursor
      unmoved -- indistinguishable from empty, so it DOES cost the selection for no visible
      effect, which is the thing the paragraph above says must not happen.

      It is left alone because the obvious tightening is wrong: `'\n'` ALSO types nothing
      (`{typed: 0, dropped: 0}`) and yet is a REAL paste -- measured, it moves the cursor to the
      next unprotected field (0 -> 80 on a fresh 3278-2). So "would type nothing" does not
      separate the two, and any trim that did would be a second copy of `pasteString`'s drop set
      living in a DOM listener, free to drift from the one in `frontend/src/paste.ts`. A
      CR-only clipboard costing a highlight is the cheaper defect.
    */
    if (text === '') return;
    // `preventDefault` ONLY once we have claimed it, matching the `keydown` listeners' rule: a
    // paste we are not handling must keep its default behavior.
    e.preventDefault();
    // ANY ACTION THAT DOES SOMETHING INVALIDATES THE SELECTION, for the reason `renderer.ts`'s
    // `keydown` listener gives at length: the screen is about to change under it, and a highlight
    // over changed text would offer a copy of something never seen. AFTER the two returns above,
    // so a paste we declined leaves the selection alone -- the same ordering, for the same reason.
    deps.clearSelection();
    deps.sendAction({ kind: 'paste', text });
  });
}
