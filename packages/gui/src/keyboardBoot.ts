import { createKeyboardUi } from '@tn3270/canvas/dist/keyboardUi.js';

/**
 * The full-keyboard window's entry point: the real DOM, handed to the testable view.
 *
 * ## EVERY LINE HERE IS UNTESTABLE, AND THAT IS WHY THERE ARE SO FEW OF THEM
 *
 * `vitest.config.ts` sets `environment: 'node'`, so nothing in this repo can execute a line of
 * this file -- it reads `document` in its module body. `keyboardUi.ts` holds every decision
 * (including the one-shot Shift, which is the only behaviour in the whole surface); this only
 * adapts primitives. `keypadBoot.ts` is this file's precedent in every respect.
 *
 * THE OTHER HALF OF THAT LESSON: an untestable boot file must be LOADED to be believed, never
 * reasoned about. `clicks.mjs` is what loads this one.
 *
 * ## THE THROWS REACH A HUMAN, WHICH IS WHY THEY ARE THROWS
 *
 * `main.ts` forwards this window's `console-message` to stdout as `keyboard[level]`, so an
 * uncaught throw here prints with a file and line rather than vanishing. A silent `return` would
 * leave a window with a title and no buttons -- indistinguishable from a styling bug, and the
 * exact shape this repo keeps meeting.
 *
 * NO CLEVER GUARD ANYWHERE IN THIS FILE, for the recorded reason: this project's one BLANK WINDOW
 * bug was a TDZ read on an uninitialised `const`, and **optional chaining does not guard a TDZ
 * read** (`ui?.x` still throws). So there are two hard failures with messages, and nothing is
 * declared after something that reads it.
 */
const root = document.getElementById('keyboard-root');
if (root === null) {
  throw new Error('keyboard window: #keyboard-root is missing from keyboard.html');
}

/**
 * The preload's bridge, read ONCE into a local.
 *
 * NOT RE-READ PER CLICK, deliberately: `contextBridge.exposeInMainWorld` defines a non-writable
 * property, so it cannot change under us, and reading it here means a missing preload fails at
 * LOAD time with the message below rather than on the operator's first key press.
 */
const bridge = (window as unknown as {
  tn3270keyboard?: { sendAction: (action: unknown) => void };
}).tn3270keyboard;
if (bridge === undefined) {
  // A MISSING BRIDGE IS A LOUD FAILURE AND NOT A DEAD KEYBOARD. The preload is a `.cjs` loaded by
  // absolute path from main; if it failed to load, every one of the 118 caps would silently do
  // nothing -- which looks like a protocol problem and is not one.
  throw new Error('keyboard window: the tn3270keyboard bridge is absent (preload failed to load?)');
}

/**
 * THE RETURN VALUE IS DISCARDED, AND THAT IS A REAL DIFFERENCE FROM THE WEB SURFACE.
 *
 * `createKeyboardUi` returns a `KeyboardUi` whose `disarmShift()` exists for the sixth of the
 * user's Shift rules: a surface reopened later must not still hold a Shift nobody remembers
 * pressing. The web gateway calls it from its overlay's `onHide`, because hiding an overlay
 * leaves the built DOM in place with its arm intact.
 *
 * A WINDOW HAS NO SUCH STATE TO CLEAR. Closing it DESTROYS the renderer, so reopening runs this
 * module again from scratch and the arm cannot survive -- the rule is satisfied structurally
 * rather than by a handler. Said here rather than left as a dangling expression, because "the
 * return value is ignored" and "the rule is unimplemented" look identical in a diff.
 */
createKeyboardUi({
  root,
  create: (tag) => document.createElement(tag),
  append: (parent, child) => { parent.appendChild(child); },
  setText: (el, text) => { el.textContent = text; },
  setTitle: (el, title) => { el.title = title; },
  setAttr: (el, name, value) => { el.setAttribute(name, value); },
  removeAttr: (el, name) => { el.removeAttribute(name); },
  onClick: (el, fn) => { el.addEventListener('click', fn); },
  sendAction: (action) => { bridge.sendAction(action); },
});
