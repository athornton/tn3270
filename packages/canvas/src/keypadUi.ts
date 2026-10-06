import { KEYPAD_BLOCKS, tooltipFor, type Action } from '@tn3270/frontend';

/**
 * The keypad's browser-side view, with the DOM INJECTED.
 *
 * ## IT LIVES IN `canvas` BECAUSE BOTH FRONT ENDS NEED IT, AND THAT WAS A CORRECTION
 *
 * It was written in `packages/gui` first, which was wrong and would not have compiled for the web
 * gateway: `packages/web` does not depend on `@tn3270/gui` and must not -- that package is an
 * Electron app, with `electron` imports and a `.cts` preload. `canvas` is the package whose own
 * docstring says it exists for exactly this, "the canvas presentation layer, shared by the
 * Electron GUI and the web gateway", and it already depends on `frontend` where `KEYPAD_BLOCKS`
 * lives. Found when wiring the web overlay, i.e. one task later than it should have been.
 *
 * NOTE THE PACKAGE NAME IS NOW SLIGHTLY WRONG FOR THIS FILE and that is accepted: nothing here
 * touches a canvas. `canvas` is the shared-presentation package, and a `frontend`-level home
 * would be worse -- that package's docstring explicitly excludes "anything a front end owns
 * because of HOW it presents", and a DOM is precisely that.
 *
 * ## WHY THE DOM IS INJECTED AND NOT REACHED FOR
 *
 * `vitest.config.ts` sets `environment: 'node'`, so there is no `document` in any test in this
 * repo and jsdom is not a dependency. The logic worth testing -- which buttons exist, what each
 * one sends, what tooltip it carries -- needs no real element, and injecting the few operations
 * that do keeps every line of it reachable from a unit test.
 *
 * ## PRIMITIVES, NOT A `render(fields)` CALLBACK, AND THE DIFFERENCE IS MEASURABLE
 *
 * `transferUi.ts` made the other choice: it hands its boot file a `render(fields)` callback and
 * lets THAT file build elements. The cost shows up in the line counts -- `transferBoot.ts` runs to
 * several hundred lines no test can execute, comparable in size to the `transferUi.ts` that every
 * test CAN -- and the boot file is exactly where this project's one shipped blank-window bug lived
 * (a TDZ read on an uninitialised `const`, which optional chaining does not guard).
 *
 * (Exact counts were cited here until 2026-10-06 and went stale the first time either file gained
 * a comment. The ratio is the argument; the integers were never the argument.)
 *
 * Injecting `create`/`append`/`setText`/`setAttr`/`onClick` instead moves the element building
 * into this file, where `keypadUi.test.ts` asserts all 48 buttons and all 48 actions against a
 * fake DOM, and leaves `keypadBoot.ts` as a handful of one-line adapters. The tradeoff is a wider
 * deps interface; the gain is that the one thing that must not be wrong -- which action each
 * button sends -- is pinned by a test rather than by a human looking at a window.
 *
 * ## A BROWSER LOADS THIS, AND AN IMPORT MAP IS WHAT MAKES THAT LEGAL
 *
 * The import above is a BARE SPECIFIER and stays one in the emitted JS -- `tsc` rewrites nothing.
 * `keypad.html` carries an import map resolving it to `../frontend/dist/keypadView.js`, whose
 * runtime graph closes at `keypad.js` and `bindings.js` (each with zero imports of their own,
 * measured 2026-10-06 and pinned by `frontend/test/keypadModule.test.ts`).
 *
 * SO DO NOT ADD A SECOND WORKSPACE IMPORT TO THIS FILE, and never import the package BARREL: it
 * reaches `tls.js`, whose `node:net`/`node:tls`/`node:fs` no browser can resolve, and the failure
 * arrives as a BLANK WINDOW WITH NO ERROR in any console. This repo has met that shape five ways.
 */
export interface KeypadDeps {
  /** The element the blocks are appended to. */
  readonly root: HTMLElement;
  readonly create: (tag: string) => HTMLElement;
  readonly append: (parent: HTMLElement, child: HTMLElement) => void;
  readonly setText: (el: HTMLElement, text: string) => void;
  readonly setTitle: (el: HTMLElement, title: string) => void;
  readonly setAttr: (el: HTMLElement, name: string, value: string) => void;
  readonly onClick: (el: HTMLElement, fn: () => void) => void;
  /** Fire a keypad action at the session. */
  readonly sendAction: (action: Action) => void;
}

/**
 * Build the keypad into `deps.root`.
 *
 * ONE BUTTON PER KEY, DRIVEN BY `KEYPAD_BLOCKS`, so `packages/frontend` stays the single
 * authority on which keys exist and what each does. This file decides nothing about that -- which
 * is why a key added to the table appears here with no edit, and why a key REMOVED from it
 * disappears from both front ends at once.
 *
 * NOT IDEMPOTENT, and it does not need to be: both callers build once. The GUI window builds at
 * load; the web overlay builds lazily on its first toggle and then never again (rebuilding 48
 * buttons per keystroke would be invisible work that also discards focus).
 */
export function createKeypadUi(deps: KeypadDeps): void {
  for (const block of KEYPAD_BLOCKS) {
    const section = deps.create('div');
    deps.setAttr(section, 'class', 'keypad-block');
    // PREFIXED, because these ids share a document with the transfer form's in the web overlay's
    // case and with nothing today in the window's -- but `keypad-cursor` cannot collide where
    // `cursor` might.
    deps.setAttr(section, 'id', `keypad-${block.id}`);

    const heading = deps.create('h2');
    deps.setText(heading, block.title);
    deps.append(section, heading);

    const keys = deps.create('div');
    deps.setAttr(keys, 'class', 'keypad-keys');
    for (const key of block.keys) {
      const button = deps.create('button');
      // `type=button` EXPLICITLY: a bare <button> inside a form defaults to type=submit. There is
      // no form in the keypad window today, and this is what stops a later one turning a PF key
      // into a page reload.
      deps.setAttr(button, 'type', 'button');
      // THE HANDLE THE HARNESS USES. `clicks.mjs` queries by label, deliberately -- a coordinate
      // list would be a second copy of the layout and would pass while the layout was wrong. Held
      // in an attribute SEPARATE from the visible text so that giving the arrows real icons later
      // cannot break the query.
      deps.setAttr(button, 'data-label', key.label);
      deps.setText(button, key.label);
      // `name` always, plus `BINDING_INTENT`'s note where one exists -- see `tooltipFor`. 22 of
      // the 48 keys have no entry and 15 more have an entry with no note, so a tooltip that
      // demanded prose would leave most of the window bare.
      deps.setTitle(button, tooltipFor(key));
      // THE CLOSURE CAPTURES `key`, which is the whole correctness question in this file: a loop
      // that hoisted the handler would wire all 48 buttons to the last key. `for...of` gives a
      // fresh binding per iteration, and `keypadUi.test.ts` presses all 48 and compares the whole
      // action sequence rather than spot-checking.
      deps.onClick(button, () => { deps.sendAction(key.action); });
      deps.append(keys, button);
    }
    deps.append(section, keys);
    deps.append(deps.root, section);
  }
}
