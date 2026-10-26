import { createBridge, socketUrl, writeClipboard, type BridgeApi } from './bridgecore.js';
import { createKeypadOverlay } from './keypadOverlay.js';
import { createKeyboardOverlay } from './keyboardOverlay.js';
// FROM THE MODULE AND NOT FROM `@tn3270/canvas`'s BARREL, which would blank this page: the barrel
// reaches `drawlist.js` and `@tn3270/core`, and a browser has no bundler for a bare specifier.
// `index.html`'s import map resolves this one name to `canvas/dist/keypadUi.js`, whose only
// runtime import is `@tn3270/frontend` -- the second map entry.
import { createKeypadUi } from '@tn3270/canvas';
/*
  A DEEP PATH, NOT THE BARE SPECIFIER, AND THAT IS FORCED RATHER THAN CHOSEN.

  `static/index.html`'s import map resolves `@tn3270/canvas` to `keypadUi.js` alone -- ONE
  SPECIFIER CANNOT NAME TWO FILES -- so importing `createKeyboardUi` from the bare specifier
  resolves to a module that does not export it. The browser then fails to evaluate THIS module,
  and the only symptom is `window.tn3270` never being assigned: measured on the way in as a blank
  canvas, `bridge.js did not load`, and `Cannot read properties of undefined (reading 'onAtlas')`.
  `transferUi.js` is imported by deep path for exactly the same reason.
*/
import { createKeyboardUi, type KeyboardUi } from '@tn3270/canvas/dist/keyboardUi.js';
// The transfer form's two halves, BOTH BY DEEP RELATIVE PATH into this package: they are served
// flat at `/` beside this module (`httpstatic.ts`'s own-package loop), so `./` is what resolves
// in the browser and needs no import-map entry. `transferBoot.js`'s own imports are what need
// the map's two deep keys.
import { bootTransfer } from './transferBoot.js';
import { createTransferOverlay } from './transferOverlay.js';

/**
 * The few lines that touch real browser globals. Everything testable is in `bridgecore.ts`.
 *
 * The socket URL keeps the page's own scheme and host, so a TLS gateway gets `wss:` with no flag
 * and no configuration. The token rides in the cookie the page was served with, so it is not in
 * this URL and not in the address bar.
 *
 * ## WHY `window.tn3270` IS REACHED THROUGH A CAST AND NOT A `declare global`
 *
 * `renderer.ts` already augments `Window` with `tn3270`, but it does so in `packages/canvas` and
 * the barrel there deliberately does NOT export it -- it is a browser entry point that throws at
 * module load outside a browser. So nothing in `packages/web` imports the file carrying that
 * augmentation, and it is not in scope here. Re-declaring it would not help either: a second
 * `declare global` for the same property must be structurally IDENTICAL, and the renderer's
 * version is typed in its own `AtlasMessage`/`DrawList` while this bridge deals in `unknown`
 * payloads, so the two would collide as "subsequent property declarations must have the same type".
 * The cast keeps the augmentation single-sourced in the package that owns the renderer.
 */
/**
 * RESOLVED AGAINST THE DOCUMENT, so a reverse-proxy prefix survives. The arithmetic and the
 * measurement that forced it live in `bridgecore.ts`'s `socketUrl`, which is unit-tested; this
 * file cannot be, because it touches browser globals at module load.
 */
const socket = new WebSocket(socketUrl(location.href));
socket.binaryType = 'arraybuffer';

/** Inflate one binary message. Measured: the server sends zlib-wrapped deflate, so 'deflate'. */
async function inflate(data: unknown): Promise<string> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(data as ArrayBuffer));
  void writer.close();
  return new Response(stream.readable).text();
}

/**
 * The keypad overlay, built here because this is the file that owns the real `document`.
 *
 * ## THE SAME VIEW AS THE ELECTRON KEYPAD WINDOW, IN A DIFFERENT CONTAINER
 *
 * `createKeypadUi` is shared (`packages/canvas`), so the 48 buttons, their labels, their tooltips
 * and which action each sends are identical in both front ends by construction rather than by
 * two tables agreeing. What differs is only the container: a `BrowserWindow` there, an overlay
 * over this pane here -- because a browser tab cannot open an OS window the operator can place
 * beside the terminal.
 *
 * ## DECLARED BEFORE THE BRIDGE, AND THAT ORDER IS LOAD-BEARING
 *
 * `createBridge` takes `toggleKeypad` as a dep, so the overlay has to exist first. Getting this
 * backwards is a TDZ read on a `const`, which this project has already shipped once in
 * `transferBoot.ts` -- and the recorded finding is that OPTIONAL CHAINING DOES NOT GUARD IT:
 * `overlay?.toggle()` would still throw. So the declaration order IS the guard.
 *
 * ## A MISSING ELEMENT IS A HARD FAILURE, NOT A DEAD CHORD
 *
 * `index.html` carries `#keypad-overlay` and `#keypad-keys`; if either is gone, every `Ctrl-K`
 * would silently do nothing, which looks like a protocol fault and is not one. Thrown rather
 * than logged so it reaches the console with a file and a line.
 */
const overlayEl = document.getElementById('keypad-overlay');
const keysEl = document.getElementById('keypad-keys');
if (overlayEl === null || keysEl === null) {
  throw new Error('bridge: #keypad-overlay or #keypad-keys is missing from index.html');
}

const overlay = createKeypadOverlay({
  element: overlayEl,
  // BUILT LAZILY, on the first toggle only -- see `createKeypadOverlay`. Most sessions never open
  // the keypad, and rebuilding per toggle would also discard focus.
  build: () => {
    createKeypadUi({
      root: keysEl,
      create: (tag) => document.createElement(tag),
      append: (parent, child) => { parent.appendChild(child); },
      setText: (el, text) => { el.textContent = text; },
      setTitle: (el, title) => { el.title = title; },
      setAttr: (el, name, value) => { el.setAttribute(name, value); },
      onClick: (el, fn) => { el.addEventListener('click', fn); },
      /**
       * THROUGH THE BRIDGE, so a keypad press takes exactly the path a keystroke does: the same
       * `sendAction`, the same socket, the same server handler. Nothing about the keypad is a
       * special case on the wire, which is why this feature adds no protocol message.
       *
       * ## THIS READS `bridge` BEFORE ITS DECLARATION, AND IT IS SAFE FOR ONE SPECIFIC REASON
       *
       * `bridge` is a `const` declared BELOW, so the reference is inside the temporal dead zone
       * at the point this arrow is created -- and `tsc` does not flag it, because the read is
       * inside a closure rather than at the top level. What makes it correct is WHEN the closure
       * runs: `build` is invoked only on the FIRST TOGGLE, i.e. the operator's first `Ctrl-K`,
       * which cannot happen before module evaluation finishes and `bridge` is assigned.
       *
       * MEASURED rather than assumed, because this project has already shipped one blank window
       * from a TDZ read and the recorded finding is that OPTIONAL CHAINING DOES NOT GUARD IT:
       * a closure capturing a later `const` returns fine when called after initialisation and
       * throws `ReferenceError: Cannot access 'x' before initialization` when called before.
       *
       * SO DO NOT CALL `build` EAGERLY. Dropping the laziness in `createKeypadOverlay` -- say to
       * "simplify" it by building at construction -- would move this call above `bridge`'s
       * declaration and blank the page with a ReferenceError. The laziness is load-bearing twice
       * over: it also keeps 48 buttons off the sessions that never ask for them.
       */
      sendAction: (action) => { bridge.sendAction(action); },
    });
  },
});

/**
 * THE FULL 122-KEY KEYBOARD, `Ctrl-B`, a second surface beside the keypad.
 *
 * The user asked for BOTH -- "I like Ctrl-K for the quick special-keys overlay like we have now.
 * Maybe Ctrl-B for the full keyboard?" -- and may later keep only this one, so nothing here
 * depends on the keypad existing.
 *
 * A HARD FAILURE on a missing element, for the reason the keypad's own check gives: a missing
 * element would make every `Ctrl-B` silently do nothing, which looks like a protocol fault and is
 * not one.
 */
const keyboardEl = document.getElementById('keyboard-overlay');
if (keyboardEl === null) {
  throw new Error('bridge: #keyboard-overlay is missing from index.html');
}

/**
 * The keyboard's Shift state, which `onHide` needs and `build` produces.
 *
 * ASSIGNED INSIDE `build` AND READ ONLY FROM `onHide`, which is safe in both directions: `onHide`
 * cannot run before the surface has been shown, and showing it is what builds it. A `let` rather
 * than a `const` because the value does not exist until the operator's first `Ctrl-B` -- and the
 * laziness is load-bearing for the TDZ reason the keypad's `sendAction` records at length.
 */
let keyboardUi: KeyboardUi | undefined;

const keyboardOverlay = createKeyboardOverlay({
  element: keyboardEl,
  // BUILT LAZILY, on the first toggle only. 117 buttons at page load would cost every session for
  // the few that open the keyboard -- and see the keypad's `sendAction` note on why building
  // eagerly would blank the page by reading `bridge` inside its temporal dead zone.
  build: () => {
    keyboardUi = createKeyboardUi({
      root: keyboardEl,
      create: (tag) => document.createElement(tag),
      append: (parent, child) => { parent.appendChild(child); },
      setText: (el, text) => { el.textContent = text; },
      setTitle: (el, title) => { el.title = title; },
      setAttr: (el, name, value) => { el.setAttribute(name, value); },
      removeAttr: (el, name) => { el.removeAttribute(name); },
      onClick: (el, fn) => { el.addEventListener('click', fn); },
      // THROUGH THE BRIDGE, exactly as the keypad's presses are, so a cap takes the same path a
      // keystroke does: same `sendAction`, same socket, same server handler. This surface adds no
      // protocol message of its own.
      sendAction: (action) => { bridge.sendAction(action); },
    });
  },
  /**
   * CLOSING THE SURFACE DISARMS THE ONE-SHOT SHIFT -- the sixth of the user's rules.
   *
   * A keyboard reopened later must not still be holding a Shift nobody remembers pressing. The
   * `?.` is not a TDZ guard (this project has recorded that optional chaining does not guard one);
   * it covers the real case that `hide()` can be called before the surface was ever built, where
   * there is no Shift to disarm.
   */
  onHide: () => { keyboardUi?.disarmShift(); },
});

/**
 * The transfer overlay's two elements THIS FILE itself touches.
 *
 * A HARD FAILURE, NOT A DEAD BUTTON, for the reason the keypad's own check above gives: a missing
 * element would make every `Xfer` press silently do nothing, which looks like a protocol fault and
 * is not one.
 *
 * ONLY THE TWO USED HERE, AND THAT IS NOT AN OVERSIGHT. `bootTransfer` looks up the other seven
 * itself and throws by NAME on each (`transfer overlay is missing #transfer-fields`), so listing
 * them again here would be a second copy to drift -- and it is called a few lines below, during
 * module evaluation, so a missing field element still fails at LOAD rather than at first click.
 *
 * CHECKED BEFORE EITHER OBJECT IS CONSTRUCTED, which is what lets `transferEl` be an
 * `HTMLElement` rather than a `| null` at the point `createTransferOverlay` takes it.
 */
const transferEl = document.getElementById('transfer-overlay');
const transferClose = document.getElementById('transfer-close');
if (transferEl === null || transferClose === null) {
  throw new Error('bridge: #transfer-overlay or #transfer-close is missing from index.html');
}

/**
 * The transfer form, BUILT BEFORE THE BRIDGE FOR THE SAME REASON THE KEYPAD IS.
 *
 * `createBridge` takes `showTransfer` and `onTransfer` as deps, so both the boot object and the
 * overlay must exist first. Getting this backwards is a TDZ read on a `const`, which this project
 * has already shipped once -- and the recorded finding is that OPTIONAL CHAINING DOES NOT GUARD
 * IT: `boot?.onMessage` would still throw `ReferenceError`. So the declaration order IS the guard,
 * exactly as it is for the keypad overlay above.
 *
 * THE ORDER WITHIN THIS BLOCK IS ALSO FIXED, and it is a two-way dependency resolved by one
 * direction being lazy. `bootTransfer` wires the form's own buttons -- including Close -- so it
 * needs the overlay; the overlay's `hasUnsaved`/`confirmDiscard` need the boot object. The
 * overlay's needs are satisfied through ARROWS called on a later click, while `bootTransfer`
 * builds its handlers at construction, so the boot object is built first and reads the overlay
 * lazily. Reversing it would put an eager `boot.hasUnsaved` read above `boot`'s own declaration.
 *
 * ## `bootTransfer` IS WHAT SENDS, AND IT SENDS TEXT ON THIS SAME SOCKET
 *
 * `transferStart`, `transferChunk` and `transferCancel` are JSON TEXT frames, not actions: they
 * are not part of `Action` and do not go through `sendAction`. `protocol.ts` decodes them from the
 * client's own text messages and `transferGateway.ts` acts on them, which is why this passes the
 * raw `socket.send` rather than anything off the bridge.
 */
const boot = bootTransfer(document, (text) => { socket.send(text); });

const transferOverlay = createTransferOverlay({
  element: transferEl,
  // NOTHING TO BUILD. The overlay's markup is static in `index.html` and its field rows are drawn
  // by `bootTransfer`'s `render`, which has already run once by now (`createTransferUi` redraws
  // before it returns). The keypad's 48 buttons are built lazily because they are expensive and
  // most sessions never ask; ten form rows that are already drawn are not.
  build: () => { /* static markup; see above */ },
  hasUnsaved: () => boot.hasUnsaved(),
  // A COMPLETED RECEIVE HELD IN MEMORY IS LOST BY CLOSING, with the host already out of transfer
  // mode and nothing to retry from -- see `transferOverlay.ts`'s "WHY IT WARNS" section.
  confirmDiscard: () => globalThis.confirm(
    'The transfer finished but the file has not been saved. Close and lose it?',
  ),
});

/**
 * The overlay's own Close button, wired here because `transferOverlay` is this file's object.
 *
 * `hide()` AND NOT a toggle, for the reason the keypad's Close button gives below: a toggle would
 * RE-SHOW the form on a double-click, because the first click already hid it. And `hide()` is
 * where the unsaved-file warning lives, so this button is the one path that must go through it.
 */
transferClose.addEventListener('click', () => { transferOverlay.hide(); });

const bridge = createBridge({
  socket,
  storage: sessionStorage,
  inflate,
  // INTERCEPTED CLIENT-SIDE: the keypad is a DOM overlay, so showing it is a local display
  // decision and `toggleKeypad` never reaches the gateway. The server keeps its own intercept
  // regardless, because served code is not code a client is obliged to run.
  /*
    OPENING ONE SURFACE CLOSES THE OTHER, and that rule lives HERE rather than in either overlay:
    putting it inside them would make each depend on the other and give the pair two places to
    disagree about which is open. Two overlapping OPAQUE overlays would be unreadable -- and both
    are opaque for a measured reason, recorded in `keypadOverlay.ts`.

    The close happens BEFORE the toggle, so opening a surface that is already open still closes the
    other rather than leaving both up for one frame.
  */
  toggleKeypad: () => {
    keyboardOverlay.hide();
    overlay.toggle();
  },
  // `Ctrl-B`. INTERCEPTED CLIENT-SIDE, exactly as `toggleKeypad` is: this surface is the browser's
  // and the gateway holds nothing for it. The server keeps its own intercept anyway -- see
  // `web/src/main.ts`, where `applyAction` would otherwise throw outside any try and end the
  // process, since a client is not obliged to run the code we served it.
  toggleKeyboard: () => {
    overlay.hide();
    keyboardOverlay.toggle();
  },
  // THE SAME BARGAIN FOR THE TRANSFER FORM, which is a DOM overlay here too. `main.ts:314` keeps
  // its own intercept, for the reason `bridgecore.ts` sets out at length: `applyAction` THROWS on
  // this kind outside any try in a socket handler, and a client is not obliged to run served code.
  showTransfer: () => { transferOverlay.show(); },
  // The three gateway transfer kinds, narrowed by the boot module -- `bridgecore.ts` declines to
  // narrow a parsed JSON object into a union it never validated, and says so.
  onTransfer: (msg) => { boot.onMessage(msg); },
  /**
   * THE OPERATOR'S OWN CLIPBOARD, which is the entire point of routing the text back here: only
   * the gateway can extract (`protocol.ts`'s `copyText` member says why), so the renderer sends
   * the rectangle and this is where the answer lands.
   *
   * ONE LINE, AND THE TWO BROWSER GLOBALS ARE THE ONLY PART THAT BELONGS IN THIS FILE.
   * `writeClipboard` holds the capability check, the caught rejection and the measurements behind
   * both, in `bridgecore.ts` where a unit test can drive the NO-CLIPBOARD route -- which is the
   * common case for a LAN gateway on plain `http` and would otherwise be the one route nothing
   * covers, exactly as `transferBridge.ts` records for its save dialog.
   *
   * `navigator.clipboard` IS PASSED, NOT READ DOWN THERE, for the reason that file's header gives
   * about every browser capability: the tests run with `environment: 'node'` and have no
   * `navigator` at all. `console.warn` rides along for the same reason.
   */
  onCopyText: (text) => { writeClipboard(navigator.clipboard, text, (m) => { console.warn(m); }); },
});

(window as unknown as { tn3270: BridgeApi }).tn3270 = bridge;

/**
 * The overlay's own Close button.
 *
 * `hide()` AND NOT `toggle()`, which is the whole reason `hide` exists as a separate method: a
 * toggle here would RE-SHOW the keypad on a double-click, because the first click already hid it.
 *
 * REQUIRED, not optional. `Ctrl-K` does toggle, so the keypad is dismissible without this button
 * -- but only by someone who knows the chord, and the button is the discoverable route for an
 * operator who opened the keypad from it in the first place. A missing one is a keypad that
 * covers the screen with no visible way out, so it fails loudly like the other two elements.
 */
const closeEl = document.getElementById('keypad-close');
if (closeEl === null) {
  throw new Error('bridge: #keypad-close is missing from index.html, so the keypad cannot be shut');
}
closeEl.addEventListener('click', () => { overlay.hide(); });


// The token was in the query string on the first load only; the cookie carries it from here, so
// take it out of the address bar and out of any future Referer.
if (location.search !== '') history.replaceState(null, '', location.pathname);
