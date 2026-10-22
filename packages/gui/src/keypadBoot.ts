import { createKeypadUi } from '@tn3270/canvas';

/**
 * The keypad window's entry point: the real DOM, handed to the testable view.
 *
 * ## EVERY LINE HERE IS UNTESTABLE, AND THAT IS WHY THERE ARE SO FEW OF THEM
 *
 * `vitest.config.ts` sets `environment: 'node'`, so nothing in this repo can execute a line of
 * this file -- it reads `document` in its module body. `keypadUi.ts` holds every decision; this
 * only adapts primitives.
 *
 * THAT SPLIT IS THE LESSON FROM `transferBoot.ts`, which took the other side of the same choice
 * and runs to several hundred untestable lines as a result (an exact count stood here until
 * 2026-10-06, and rotted the next time that file gained a comment) -- and which shipped this project's one BLANK WINDOW
 * bug, a TDZ read on an uninitialised `const`. The recorded finding from that is exact:
 * **optional chaining does not guard a TDZ read** (`ui?.x` still throws), so there is no clever
 * guard in this file -- just two hard failures with messages, and a `const` declared after
 * everything that reads it.
 *
 * The other half of that lesson: an untestable boot file must be LOADED to be believed, never
 * reasoned about. Task 8's Xvfb harness is what loads this one.
 *
 * ## THE THROWS REACH A HUMAN, WHICH IS WHY THEY ARE THROWS
 *
 * `main.ts` forwards this window's `console-message` to stdout as `keypad[level]`, so an
 * uncaught throw here prints with a file and line rather than vanishing. A silent `return` would
 * leave a window with a title and no buttons -- indistinguishable from a styling bug, and the
 * exact shape this repo keeps meeting.
 */
const root = document.getElementById('keys');
if (root === null) {
  throw new Error('keypad window: #keys is missing from keypad.html');
}

/**
 * The preload's bridge, read ONCE into a local.
 *
 * NOT RE-READ PER CLICK, deliberately: `contextBridge.exposeInMainWorld` defines a non-writable
 * property, so it cannot change under us, and reading it here means a missing preload fails at
 * LOAD time with the message below rather than on the operator's first button press.
 */
const bridge = (window as unknown as {
  tn3270keypad?: { sendAction: (action: unknown) => void };
}).tn3270keypad;
if (bridge === undefined) {
  // A MISSING BRIDGE IS A LOUD FAILURE AND NOT A DEAD KEYPAD. The preload is a `.cjs` loaded by
  // absolute path from main; if it failed to load, every one of the 48 buttons would silently do
  // nothing -- which looks like a protocol problem and is not one.
  throw new Error('keypad window: the tn3270keypad bridge is absent (preload failed to load?)');
}

createKeypadUi({
  root,
  create: (tag) => document.createElement(tag),
  append: (parent, child) => { parent.appendChild(child); },
  setText: (el, text) => { el.textContent = text; },
  setTitle: (el, title) => { el.title = title; },
  setAttr: (el, name, value) => { el.setAttribute(name, value); },
  onClick: (el, fn) => { el.addEventListener('click', fn); },
  sendAction: (action) => { bridge.sendAction(action); },
});
