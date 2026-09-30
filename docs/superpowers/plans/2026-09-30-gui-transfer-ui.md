# GUI IND$FILE Transfer UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Electron GUI a working IND$FILE transfer form in its own window, with a native file dialog for the local file, reusing the shared form model and transfer driver unchanged.

**Architecture:** Two windows, two preloads, one `Session`. The canvas window and its four-function bridge are not touched, so `renderer.ts` stays shared with the web gateway. A new `BrowserWindow` loads `transfer.html`, whose browser-side logic imports the already-self-contained `transferForm.js` by relative path and talks to main over its own five-function `contextBridge`. `main.ts` owns both windows and drives `startTransfer` from `@tn3270/frontend`.

**Tech Stack:** TypeScript (NodeNext), Electron 44, vitest (node environment, **no DOM**), `@tn3270/frontend` for the model and driver, `@tn3270/node-files` for file I/O.

**Spec:** `docs/superpowers/specs/2026-09-30-gui-transfer-ui-design.md`

---

## Read this before Task 1

Six facts, each measured on 2026-09-30. Do not re-derive them, and do not trust this plan over the
source: **if the code disagrees with this plan, the code wins and the plan is wrong.** Previous
features here found forty-odd defects each, nearly all in the plan.

1. **`packages/frontend/dist/transferForm.js` is 9141 bytes with ZERO runtime imports and zero
   `require` calls.** That is the entire basis for serving it to a browser context. Task 3 pins it.
2. **`packages/gui/tsconfig.json` has `"lib": ["ES2023"]` and NO DOM.** Browser-side code will not
   typecheck there until Task 2 adds it. `packages/canvas` and `packages/web` both carry
   `["ES2023", "DOM", "DOM.Iterable"]`.
3. **vitest runs `environment: 'node'`** (`vitest.config.ts`). There is no `document` in any test, so
   browser-side logic must take its DOM **injected**, the way `packages/web/src/bridgecore.ts` takes
   its socket injected. Do not reach for jsdom; it is not a dependency here.
4. **`packages/gui` does NOT depend on `@tn3270/node-files`.** Task 2 adds it.
5. **`tsconfig` `include` does NOT match `.cts` by default** — `packages/gui/tsconfig.json` lists
   `"src/**/*.cts"` explicitly. A new `.cts` file needs no change, but note that
   `'preload.cts'.endsWith('.ts')` is FALSE, which has already caused one false green here.
6. **An ESM preload cannot load.** It fails with "Cannot use import statement outside a module" and
   the bridge silently never appears. Preloads are `.cts` → `.cjs`.

**Run the build before vitest.** Workspace packages resolve to `dist/`, so testing before rebuilding
tests a stale artifact — this repo has 22 tests' worth of history on that.

**Baseline to beat:** 2156 tests in 82 files, `npm run build` and `npm run typecheck` clean.

## File Structure

| File | Responsibility |
|---|---|
| `packages/gui/package.json` | **Modify**: add `@tn3270/node-files` dependency |
| `packages/gui/tsconfig.json` | **Modify**: add DOM libs; add `../node-files` reference |
| `packages/gui/src/transferUi.ts` | **Create**: browser-side form logic, DOM **injected**, no workspace runtime imports |
| `packages/gui/src/transferBoot.ts` | **Create**: the browser entry point — real elements in, `createTransferUi` out; deliberately holds no decisions |
| `packages/gui/transfer.html` | **Create**: the window's markup; loads `transferBoot.js` |
| `packages/gui/src/transferPreload.cts` | **Create**: the transfer window's `contextBridge`, five functions |
| `packages/gui/src/transferWindow.ts` | **Create**: window creation, the close guard, and the main-side IPC handlers |
| `packages/gui/src/main.ts` | **Modify**: intercept `transferForm`, wire the window, cancel on quit |
| `packages/gui/test/transferUi.test.ts` | **Create**: form logic against a fake DOM |
| `packages/gui/test/transferWindow.test.ts` | **Create**: close-guard and lifecycle logic, Electron faked |
| `packages/gui/test/transferModule.test.ts` | **Create**: the served-module graph closure and zero-imports guards |
| `packages/gui/scripts/transfer.mjs` | **Create**: by-hand Electron harness |
| `packages/gui/test/transfer-harness-flags.test.ts` | **Create**: pins the harness's invocation |

---

### Task 1: A failing guard that `transferForm.js` is servable

This premise is the foundation of the whole design, so it gets pinned before anything depends on it.

**Files:**
- Test: `packages/gui/test/transferModule.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gui/test/transferModule.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The transfer window loads `transferForm.js` DIRECTLY in a browser context, by relative path
 * from `transfer.html`. That is only possible because the compiled module has no runtime
 * imports -- exactly the justification `packages/canvas/src/hittest.ts` carries for being its
 * own module.
 *
 * MEASURED 2026-09-30: 9141 bytes, zero `import` statements, zero `require` calls. That is a
 * FACT WITH A DATE, not an invariant: the day someone adds a runtime import to
 * `transferForm.ts`, this window goes blank with no error in any console -- the signature this
 * repo has now met five separate ways. So the premise is asserted, not assumed.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(guiDir));
const formJs = join(repoRoot, 'packages', 'frontend', 'dist', 'transferForm.js');

describe('transferForm.js is servable to a browser', () => {
  it('has no runtime imports, so a file:// page can load it by relative path', () => {
    const src = readFileSync(formJs, 'utf8');
    // Static `import`/`export ... from` both emit a specifier a browser must resolve. A bare
    // one (`@tn3270/core`) cannot be resolved without a bundler.
    const specifiers = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]/g)]
      .map((m) => m[1]!);
    expect(specifiers, `transferForm.js must import nothing at runtime, found: ${specifiers.join(', ')}`)
      .toEqual([]);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });

  it('still exports the functions the transfer window needs', () => {
    const src = readFileSync(formJs, 'utf8');
    for (const name of [
      'TRANSFER_FIELDS', 'newTransferForm', 'cycleField', 'setFieldText',
      'applicable', 'formKeywords', 'moveField',
    ]) {
      expect(src, `transferForm.js must export ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
```

- [ ] **Step 2: Build, then run the test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/gui/test/transferModule.test.ts
```

Expected: **PASS** (both tests). This task pins an existing property rather than driving new code, so
green here is correct. If it FAILS, stop: the design's premise has expired and the spec's
served-module decision must be revisited before continuing.

- [ ] **Step 3: Verify the guard is falsifiable**

Prove the first test can fail, so it is not vacuous:

```bash
cd ~/git/tn3270 && cp packages/frontend/dist/transferForm.js /tmp/tf.bak \
  && printf "import { AID } from '@tn3270/core';\n" | cat - packages/frontend/dist/transferForm.js > /tmp/tf.new \
  && cp /tmp/tf.new packages/frontend/dist/transferForm.js \
  && npx vitest run packages/gui/test/transferModule.test.ts 2>&1 | tail -20
```

Expected: the first test FAILS, naming `@tn3270/core`. Then restore:

```bash
cd ~/git/tn3270 && cp /tmp/tf.bak packages/frontend/dist/transferForm.js \
  && npx vitest run packages/gui/test/transferModule.test.ts
```

Expected: PASS again.

- [ ] **Step 4: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/test/transferModule.test.ts
git commit -m "test: pin that transferForm.js is servable to a browser context

The transfer window loads it by relative path from a file:// page, which works
only because the compiled module has no runtime imports -- measured at 9141 bytes,
zero imports, zero requires. That is a fact with a date rather than an invariant,
and the failure mode when it expires is a blank window with no error anywhere, so
it is asserted before anything depends on it.

Mutation-verified: prepending a bare-specifier import reddens it by name.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 2: Make `packages/gui` able to hold browser code and read files

Pure configuration, and it must land before any code that needs it — otherwise the next task's
failure is a confusing type error rather than a missing feature.

**Files:**
- Modify: `packages/gui/package.json`
- Modify: `packages/gui/tsconfig.json`

- [ ] **Step 1: Add the dependency and the DOM libs**

Edit `packages/gui/package.json`, adding one line to `dependencies` (keep alphabetical order):

```json
  "dependencies": {
    "@tn3270/canvas": "0.1.0",
    "@tn3270/core": "0.1.0",
    "@tn3270/frontend": "0.1.0",
    "@tn3270/node-files": "0.1.0"
  },
```

Edit `packages/gui/tsconfig.json`. Add the DOM libs and the new project reference:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": [
      "ES2023",
      "DOM",
      "DOM.Iterable"
    ]
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.cts"
  ],
  "references": [
    {
      "path": "../core"
    },
    {
      "path": "../frontend"
    },
    {
      "path": "../canvas"
    },
    {
      "path": "../node-files"
    }
  ]
}
```

Why DOM: `transferUi.ts` manipulates elements, and this package had `["ES2023"]` only — no
`HTMLElement`, no `document`. `packages/canvas` and `packages/web` both already carry these exact
libs, so this follows the established pattern rather than inventing one.

- [ ] **Step 2: Install and verify the workspace link**

```bash
cd ~/git/tn3270 && npm install 2>&1 | tail -3 && ls -l node_modules/@tn3270/node-files
```

Expected: a symlink into `packages/node-files`.

- [ ] **Step 3: Build and typecheck**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck
```

Expected: both clean, no output but the npm banner.

- [ ] **Step 4: Run the full suite to prove nothing regressed**

```bash
cd ~/git/tn3270 && npx vitest run 2>&1 | grep -E "Test Files|Tests "
```

Expected: `83 passed` (82 + this task's new file), `2158 passed` (2156 baseline + Task 1's two).

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/package.json packages/gui/tsconfig.json package-lock.json
git commit -m "build: packages/gui gains DOM libs and node-files

Two prerequisites for a transfer window, both genuine additions rather than
oversights. The GUI has never done file I/O, so it had no @tn3270/node-files
dependency; and its tsconfig carried lib ES2023 with NO DOM, so browser-side code
could not typecheck there at all. packages/canvas and packages/web both already
carry ES2023 + DOM + DOM.Iterable, so this follows them.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 3: The form's browser-side logic, with the DOM injected

vitest has no DOM, so this module never touches a global `document`. It takes the handful of
operations it needs, exactly as `bridgecore.ts` takes its socket.

**Files:**
- Create: `packages/gui/src/transferUi.ts`
- Test: `packages/gui/test/transferUi.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gui/test/transferUi.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTransferUi, type UiDeps, type UiField } from '../src/transferUi.js';

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

  it('leaves the field alone when the dialog is cancelled', async () => {
    const deps = fakeDeps();
    deps.browse = vi.fn(async () => undefined);
    const ui = createTransferUi(deps);
    ui.type('localFile', '/typed/path');
    await ui.browseLocal();
    expect(ui.values().localFile, 'a cancelled dialog must not erase a typed path')
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

  it('shows a local refusal on the form and does NOT go running', async () => {
    const deps = fakeDeps();
    deps.submit = vi.fn(async () => ({ ok: false as const, error: 'keyboard locked' }));
    const ui = createTransferUi(deps);
    await ui.start();
    expect(deps.setStatus).toHaveBeenCalledWith('keyboard locked');
    expect(deps.setRunning).not.toHaveBeenCalledWith(true);
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
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/gui/test/transferUi.test.ts 2>&1 | tail -12
```

Expected: FAIL — cannot resolve `../src/transferUi.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/gui/src/transferUi.ts`:

```typescript
import {
  TRANSFER_FIELDS, applicable, cycleField, formKeywords, newTransferForm, setFieldText,
  type TransferFieldId, type TransferFormState, type TransferValues,
} from '@tn3270/frontend';

/**
 * The transfer form's browser-side logic, with the DOM INJECTED.
 *
 * ## WHY THE DOM IS INJECTED AND NOT REACHED FOR
 *
 * `vitest.config.ts` sets `environment: 'node'`, so there is no `document` in any test in this
 * repo and jsdom is not a dependency. The same constraint produced the same shape in
 * `packages/web/src/bridgecore.ts`, which takes its socket as a dependency: the logic worth
 * testing -- which fields are shown, what the model holds, what is submitted -- needs no real
 * element, and injecting the few operations that do keeps every line of it reachable from a
 * unit test.
 *
 * ## THE MODEL IS THE AUTHORITY, AND THE CLEARING MUST HAPPEN THERE
 *
 * Every edit goes through `cycleField`/`setFieldText` from `@tn3270/frontend`, whose
 * `clearInapplicable` iterates to a fixed point because the applicability rules CHAIN. Doing
 * the hiding in the DOM and keeping the value here would let this front end submit a keyword
 * the TUI would have wiped -- two front ends disagreeing about what reaches a live host.
 *
 * ## THIS FILE IS LOADED BY A BROWSER, SO ITS ONLY IMPORT MUST STAY RESOLVABLE
 *
 * `transfer.html` loads the compiled `transferUi.js` from a `file://` page, and the import
 * above is rewritten to a relative path at build time by the html's own import map --- see
 * `transfer.html`. `packages/frontend/dist/transferForm.js` has NO runtime imports of its own
 * (measured: 9141 bytes, zero), which is what makes that legal. `transferModule.test.ts` pins
 * both halves. If you add a second workspace import here, the window goes BLANK WITH NO ERROR.
 */

/** One field as the view needs it: what to draw, and what it currently holds. */
export interface UiField {
  readonly id: TransferFieldId;
  readonly label: string;
  readonly kind: 'cycle' | 'text' | 'numeric';
  readonly value: string;
  /** For a cycle field, the values it offers here; empty otherwise. */
  readonly options: readonly string[];
}

/** Everything this module needs from the outside world. */
export interface UiDeps {
  /** Draw these fields, in this order. Called on every change. */
  render(fields: readonly UiField[]): void;
  /** The status line: an error, a progress report, or the help. */
  setStatus(text: string): void;
  /** Enable or disable the inputs, per the running state. */
  setRunning(running: boolean): void;
  /** Open a native file dialog. Resolves to a path, or undefined if cancelled. */
  browse(direction: string): Promise<string | undefined>;
  /** Hand the keywords to main. A local refusal comes back as `ok: false`. */
  submit(keywords: readonly string[]): Promise<{ ok: boolean; error?: string }>;
  /** Abort a running transfer. */
  cancel(): void;
}

export interface TransferUi {
  values(): TransferValues;
  running(): boolean;
  cycle(id: TransferFieldId, delta: number): void;
  type(id: TransferFieldId, text: string): void;
  browseLocal(): Promise<void>;
  start(): Promise<void>;
  requestCancel(): void;
  progress(text: string): void;
  finished(result: { ok: boolean; error?: string; bytes?: number }): void;
}

const HELP = 'Choose a local file and name the host file, then Start.';

export function createTransferUi(deps: UiDeps): TransferUi {
  let state: TransferFormState = newTransferForm();
  let isRunning = false;

  /** Every applicable field, in tab order, with its current value and options. */
  const view = (): UiField[] => {
    const out: UiField[] = [];
    for (const f of TRANSFER_FIELDS) {
      if (!applicable(f.id, state.values)) continue;
      // The VM/Recfm asymmetry lives in the model's own cycle logic, so the options offered
      // here are derived by asking it rather than by re-filtering the table.
      const options = f.kind === 'cycle' ? offered(f.id) : [];
      out.push({
        id: f.id, label: f.label, kind: f.kind, value: state.values[f.id], options,
      });
    }
    return out;
  };

  /**
   * The values a cycle field offers, obtained by CYCLING THE MODEL rather than reading the
   * table.
   *
   * `valuesFor` is private to `transferForm.ts`, and the one state-dependent rule -- VM does
   * not offer `Recfm=undefined` -- lives inside it. Cycling from the current value until it
   * returns collects exactly what the model will accept, so this cannot drift from that rule.
   * Bounded by the field's own length, so a model that stopped wrapping cannot loop forever.
   */
  const offered = (id: TransferFieldId): string[] => {
    const field = TRANSFER_FIELDS.find((f) => f.id === id);
    if (field === undefined) return [];
    const seen: string[] = [];
    let probe = state;
    for (let i = 0; i < field.values.length + 1; i++) {
      const v = probe.values[id];
      if (seen.includes(v)) break;
      seen.push(v);
      probe = cycleField(probe, id, 1);
    }
    return seen;
  };

  const redraw = (): void => { deps.render(view()); };

  const show = (): void => {
    if (state.error !== undefined) { deps.setStatus(state.error); return; }
    deps.setStatus(HELP);
  };

  redraw();
  show();

  return {
    values: () => state.values,
    running: () => isRunning,

    cycle(id, delta) {
      if (isRunning) return;
      state = cycleField(state, id, delta);
      redraw();
      show();
    },

    type(id, text) {
      if (isRunning) return;
      state = setFieldText(state, id, text);
      redraw();
      show();
    },

    async browseLocal() {
      if (isRunning) return;
      // The DIRECTION decides which dialog, which is why it is passed rather than inferred in
      // main: a send must choose an existing file (Open) and a receive names a destination
      // (Save). The dialog deliberately does NOT set `Exist` -- see the spec.
      const chosen = await deps.browse(state.values.direction);
      // A CANCELLED DIALOG MUST NOT ERASE A TYPED PATH. `undefined` is "the user changed their
      // mind", and overwriting the field with it would destroy work for a misclick.
      if (chosen === undefined) return;
      state = setFieldText(state, 'localFile', chosen);
      redraw();
      show();
    },

    async start() {
      // A SECOND START WHILE ONE RUNS IS IGNORED, matching the TUI: two transfers would
      // interleave two machines' frames on one screen, and the host is answering only one.
      if (isRunning) return;
      const result = await deps.submit(formKeywords(state));
      if (!result.ok) {
        // A LOCAL REFUSAL LEAVES THE FORM OPEN AND POPULATED. Nothing reached the host, so the
        // user's next move is to fix one field -- a form that reset would make them retype ten.
        state = { ...state, error: result.error ?? 'transfer refused' };
        show();
        return;
      }
      isRunning = true;
      deps.setRunning(true);
      deps.setStatus('transferring...');
    },

    requestCancel() {
      if (!isRunning) return;
      deps.cancel();
    },

    progress(text) {
      if (!isRunning) return;
      deps.setStatus(text);
    },

    finished(result) {
      isRunning = false;
      deps.setRunning(false);
      if (result.ok) {
        deps.setStatus(`done: ${result.bytes ?? 0} bytes`);
        return;
      }
      deps.setStatus(result.error ?? 'transfer failed');
    },
  };
}
```

- [ ] **Step 4: Build and run the tests**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/gui/test/transferUi.test.ts 2>&1 | tail -12
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Mutation-check the two assertions that matter most**

The clearing test and the cancelled-dialog test both guard against a real cross-front-end bug, so
prove each can fail.

```bash
cd ~/git/tn3270 && cp packages/gui/src/transferUi.ts /tmp/ui.bak
# (a) make a cancelled dialog overwrite the field
sed -i 's|      if (chosen === undefined) return;|      if (false) return;|' packages/gui/src/transferUi.ts
npm run build >/dev/null 2>&1; npx vitest run packages/gui/test/transferUi.test.ts 2>&1 | grep -E "×|Tests "
cp /tmp/ui.bak packages/gui/src/transferUi.ts
# (b) bypass the model on a numeric edit
sed -i "s|      state = setFieldText(state, id, text);|      state = { ...state, values: { ...state.values, [id]: text } };|" packages/gui/src/transferUi.ts
npm run build >/dev/null 2>&1; npx vitest run packages/gui/test/transferUi.test.ts 2>&1 | grep -E "×|Tests "
cp /tmp/ui.bak packages/gui/src/transferUi.ts && npm run build >/dev/null 2>&1
```

Expected: (a) reddens the cancelled-dialog test; (b) reddens the non-digit test. Then the restore
leaves all 11 green — confirm:

```bash
cd ~/git/tn3270 && npx vitest run packages/gui/test/transferUi.test.ts 2>&1 | grep -E "Tests "
```

- [ ] **Step 6: Typecheck and commit**

```bash
cd ~/git/tn3270 && npm run typecheck && git add packages/gui/src/transferUi.ts packages/gui/test/transferUi.test.ts
git commit -m "feat: the transfer form's browser-side logic, with the DOM injected

vitest runs environment: 'node' and jsdom is not a dependency here, so this module
never reaches for a global document -- it takes the five operations it needs, the
same shape bridgecore.ts uses for its socket and for the same reason: every line
stays reachable from a unit test.

Every edit goes through the SHARED model's cycleField/setFieldText, so
clearInapplicable does the clearing. That is the point rather than a convenience:
a value hidden here but retained would be submitted as a keyword the TUI would
have wiped, which is two front ends disagreeing about what reaches a live host.

The cycle options are collected by CYCLING the model rather than reading the field
table, because the one state-dependent rule -- VM does not offer Recfm=undefined --
lives inside the model's private valuesFor and would otherwise be written twice.

Mutation-verified twice: making a cancelled dialog overwrite the field reddens the
typed-path test, and bypassing setFieldText on a numeric edit reddens the
non-digit test.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 4: The window's markup

**Files:**
- Create: `packages/gui/transfer.html`

- [ ] **Step 1: Write the HTML**

Create `packages/gui/transfer.html`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>File Transfer</title>
<!--
  The import map is what lets `transferUi.js` say `@tn3270/frontend` while a browser resolves it.
  A bare specifier is unresolvable in a browser and there is NO BUNDLER here: the window would go
  blank with no error, which this repo has met five separate ways. The map points that one
  specifier at `packages/frontend/dist/transferForm.js`, which has no runtime imports of its own
  (measured: 9141 bytes, zero) -- so the graph closes at one file.

  This reaches across packages exactly as `index.html` does for `../canvas/dist/renderer.js`, and
  carries the same caveat: it assumes `gui` and `frontend` stay siblings on disk, which is true in
  the workspace and false in an asar bundle. Packaging has to rewrite both.
-->
<script type="importmap">
{ "imports": { "@tn3270/frontend": "../frontend/dist/transferForm.js" } }
</script>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px system-ui, sans-serif; margin: 0; padding: 12px 14px; }
  h1 { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
  .row { display: grid; grid-template-columns: 90px 1fr auto; gap: 6px 8px;
         align-items: center; margin-bottom: 6px; }
  label { text-align: right; color: GrayText; }
  input, select { font: inherit; padding: 2px 4px; min-width: 0; }
  input[disabled], select[disabled] { opacity: 0.5; }
  #status { margin: 10px 0 12px; min-height: 2.4em; white-space: pre-wrap;
            color: GrayText; }
  #status.error { color: #c0392b; font-weight: 600; }
  #buttons { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: inherit; padding: 3px 12px; }
</style>
</head>
<body>
  <h1>File Transfer (IND$FILE)</h1>
  <div id="fields"></div>
  <div id="status"></div>
  <div id="buttons">
    <button id="cancel" disabled>Cancel</button>
    <button id="start">Start</button>
  </div>
  <script type="module" src="./dist/transferBoot.js"></script>
</body></html>
```

- [ ] **Step 2: Verify the referenced paths exist**

```bash
cd ~/git/tn3270/packages/gui && ls ../frontend/dist/transferForm.js && echo "import map target OK"
```

Expected: the path lists. (`dist/transferBoot.js` does not exist yet — Task 5 creates it.)

- [ ] **Step 3: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/transfer.html
git commit -m "feat: the transfer window's markup

An import map points the one bare specifier at frontend/dist/transferForm.js,
because a browser cannot resolve @tn3270/frontend and there is no bundler -- the
failure would be a blank window with no error. The graph closes at one file
because that module has no runtime imports of its own.

Reaches across packages exactly as index.html does for canvas/dist/renderer.js,
and carries the same packaging caveat: it assumes the two packages stay siblings
on disk, which an asar bundle breaks.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 5: The boot module and the preload

Two small files: the browser-side glue that wires `createTransferUi` to real elements, and the
`contextBridge` it talks through.

**Files:**
- Create: `packages/gui/src/transferBoot.ts`
- Create: `packages/gui/src/transferPreload.cts`

- [ ] **Step 1: Write the boot module**

Create `packages/gui/src/transferBoot.ts`:

```typescript
import { createTransferUi, type UiField } from './transferUi.js';
import type { TransferFieldId } from '@tn3270/frontend';

/**
 * The browser entry point: real elements in, `createTransferUi` out.
 *
 * DELIBERATELY THIN AND DELIBERATELY UNTESTED, the same split as `renderer.ts` against
 * `blit.ts`. Everything decidable lives in `transferUi.ts`, which a unit test can reach
 * because its DOM is injected; this file is the part that cannot be unit-tested at all
 * (there is no `document` under vitest), so it must contain no decisions worth testing.
 * If you find yourself adding an `if` here, it belongs in `transferUi.ts`.
 *
 * `window.tn3270transfer` is the preload's bridge. A DIFFERENT NAME from the canvas
 * window's `window.tn3270`, and that is not cosmetic: `contextBridge.exposeInMainWorld`
 * defines a NON-WRITABLE property, so two bridges sharing a name in one process is a
 * measured hazard already recorded in `main.ts`.
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

const ui = createTransferUi({
  render(list: readonly UiField[]) {
    fields.replaceChildren();
    for (const f of list) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = f.label;
      row.append(label);

      if (f.kind === 'cycle') {
        const select = document.createElement('select');
        for (const opt of f.options) {
          const o = document.createElement('option');
          o.value = opt;
          // An empty value is a REAL state meaning "I did not ask", distinct from every
          // named value -- `transferForm.ts` explains why a two-state toggle would lose it.
          o.textContent = opt === '' ? '(host default)' : opt;
          if (opt === f.value) o.selected = true;
          select.append(o);
        }
        select.disabled = ui?.running() ?? false;
        select.addEventListener('change', () => {
          // Routed through the model as a CYCLE to the chosen value, so `clearInapplicable`
          // runs. Distance is computed from the options this field currently offers.
          const from = f.options.indexOf(f.value);
          const to = f.options.indexOf(select.value);
          if (from >= 0 && to >= 0 && to !== from) ui.cycle(f.id, to - from);
        });
        row.append(select);
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = f.value;
        input.disabled = ui?.running() ?? false;
        input.addEventListener('input', () => { ui.type(f.id, input.value); });
        row.append(input);
      }

      if (f.id === 'localFile') {
        const browse = document.createElement('button');
        browse.textContent = 'Browse…';
        browse.disabled = ui?.running() ?? false;
        browse.addEventListener('click', () => { void ui.browseLocal(); });
        row.append(browse);
      } else {
        row.append(document.createElement('span'));
      }
      fields.append(row);
    }
  },
  setStatus(text: string) {
    status.textContent = text;
  },
  setRunning(running: boolean) {
    startBtn.disabled = running;
    cancelBtn.disabled = !running;
    for (const el of fields.querySelectorAll('input, select, button')) {
      (el as HTMLInputElement).disabled = running;
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

export type { TransferFieldId };
```

- [ ] **Step 2: Write the preload**

Create `packages/gui/src/transferPreload.cts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The transfer window's bridge. A `.cts` FILE ON PURPOSE -- an ESM preload fails with "Cannot
 * use import statement outside a module" and the bridge then silently never appears, leaving a
 * window that does nothing and no error anywhere. See `preload.cts` for the same note.
 *
 * ## FIVE FUNCTIONS HERE DOES NOT BREAK THE FOUR-FUNCTION RULE
 *
 * That rule (`packages/web/src/bridgecore.ts:5-6`) is about the CANVAS bridge, whose width is
 * what lets `renderer.ts` be reused UNMODIFIED by the web gateway. This is a different window
 * with a different surface. Widening the canvas bridge to carry transfers instead would force
 * the browser front end to stub functions it cannot implement -- there is no native file dialog
 * in a browser, and the gateway's filesystem is not the operator's.
 *
 * ## THE NAME IS DIFFERENT FROM THE CANVAS WINDOW'S, DELIBERATELY
 *
 * `exposeInMainWorld` defines a NON-WRITABLE property. `main.ts` records the measured failure
 * from a name collision ("Cannot assign to read only property 'tn3270'"), so this is
 * `tn3270transfer` and not an addition to `tn3270`.
 *
 * `contextIsolation` stays on and `nodeIntegration` off. This window handles file paths and
 * sits in front of a logged-on host session, so it is the last place to grant Node access.
 */
contextBridge.exposeInMainWorld('tn3270transfer', {
  /** Open a native file dialog. Resolves to a path, or undefined if the user cancelled. */
  browse: (direction: string): Promise<string | undefined> =>
    ipcRenderer.invoke('transfer:browse', direction) as Promise<string | undefined>,
  /**
   * Hand the form's keywords to main.
   *
   * `invoke`, not `send`, because a LOCAL refusal is the answer: `startTransfer` checks 3270
   * mode, the keyboard lock, the field and the file BEFORE the host is told anything, and the
   * form must show that without the round trip going through `onDone` -- which fires only for
   * transfers that actually started.
   */
  submit: (keywords: readonly string[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('transfer:submit', keywords) as Promise<{ ok: boolean; error?: string }>,
  /** Abort a running transfer. Fire-and-forget: the outcome arrives through `onDone`. */
  cancel: (): void => { ipcRenderer.send('transfer:cancel'); },
  onProgress: (fn: (text: string) => void): void => {
    ipcRenderer.on('transfer:progress', (_e, text: string) => { fn(text); });
  },
  onDone: (fn: (r: { ok: boolean; error?: string; bytes?: number }) => void): void => {
    ipcRenderer.on('transfer:done', (_e, r) => { fn(r); });
  },
});
```

- [ ] **Step 3: Build and verify BOTH compiled outputs exist**

```bash
cd ~/git/tn3270 && npm run build && ls -l packages/gui/dist/transferBoot.js packages/gui/dist/transferPreload.cjs
```

Expected: both files. **`.cjs` is what matters** — if `transferPreload.js` appeared instead, the
`.cts` extension was wrong and the preload will not load.

- [ ] **Step 4: Verify the boot module's import graph closes**

```bash
cd ~/git/tn3270 && grep -E "^\s*(import|export).*from" packages/gui/dist/transferBoot.js
```

Expected: exactly two specifiers — `./transferUi.js` and `@tn3270/frontend`. The first is relative;
the second is what `transfer.html`'s import map resolves. Anything else must be added to the map or
the window goes blank.

- [ ] **Step 5: Typecheck and commit**

```bash
cd ~/git/tn3270 && npm run typecheck && npx vitest run 2>&1 | grep -E "Test Files|Tests "
git add packages/gui/src/transferBoot.ts packages/gui/src/transferPreload.cts
git commit -m "feat: the transfer window's boot module and its own preload

transferBoot.ts is deliberately thin and deliberately untested, the same split as
renderer.ts against blit.ts: everything decidable is in transferUi.ts, whose DOM is
injected, so this file holds no decision worth a test. There is no document under
vitest, so a decision here would be unreachable by any test at all.

The bridge is `window.tn3270transfer`, NOT an addition to `window.tn3270`:
exposeInMainWorld defines a non-writable property and main.ts already records the
measured collision failure. Five functions here does not breach the four-function
rule, which governs the CANVAS bridge -- widening that one would force the browser
to stub a native file dialog it cannot have.

submit is invoke rather than send because a LOCAL refusal is its answer:
startTransfer checks 3270 mode, the lock, the field and the file before the host is
told, and onDone fires only for transfers that actually started.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 6: The window, and the close guard

**Files:**
- Create: `packages/gui/src/transferWindow.ts`
- Test: `packages/gui/test/transferWindow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gui/test/transferWindow.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTransferController, type TransferDeps } from '../src/transferWindow.js';

/**
 * Electron is FAKED, entirely. `BrowserWindow`, `dialog` and `ipcMain` cannot be constructed
 * outside an Electron process, and the logic worth testing here is not Electron's -- it is the
 * close guard, the one-transfer rule and the guarantee that `cancel` is reached on every path
 * that ends a transfer.
 *
 * THAT LAST ONE IS WHY THIS FILE EXISTS. `packages/core/src/session.ts` has been fixed THREE
 * times for the shape "one teardown path clears the state and another does not" (`Session.e` on
 * the REJECT path, `IAC DONT TN3270E`, and `handleClose` not clearing `dft`). A window adds new
 * ways to end a transfer -- the red button, Cmd-W, Cmd-Q -- so the fourth instance is waiting
 * here unless it is asserted.
 */
function deps(over: Partial<TransferDeps> = {}): TransferDeps & {
  readonly sent: Array<[string, unknown]>;
} {
  const sent: Array<[string, unknown]> = [];
  const base: TransferDeps = {
    send: (channel, payload) => { sent.push([channel, payload]); },
    showWindow: vi.fn(),
    closeWindow: vi.fn(),
    focusCancel: vi.fn(),
    openDialog: vi.fn(async () => '/tmp/open.txt'),
    saveDialog: vi.fn(async () => '/tmp/save.txt'),
    startTransfer: vi.fn(() => ({ ok: true, cancel: vi.fn() })),
    buildCommand: vi.fn((keywords: readonly string[]) => ({
      request: { direction: 'receive', localFile: '/tmp/a', hostFile: 'A', exist: 'keep' },
      command: `IND$FILE GET A (${keywords.join(' ')}`,
    })),
    ...over,
  };
  return Object.assign(base, { sent });
}

describe('createTransferController', () => {
  it('picks the OPEN dialog for a send and the SAVE dialog for a receive', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.browse('send');
    expect(d.openDialog).toHaveBeenCalled();
    expect(d.saveDialog).not.toHaveBeenCalled();
    await c.browse('receive');
    expect(d.saveDialog).toHaveBeenCalled();
  });

  it('reports a keyword validation error as a local refusal, telling the host nothing', async () => {
    const d = deps({
      buildCommand: vi.fn(() => { throw new Error('missing LocalFile'); }),
    });
    const c = createTransferController(d);
    const r = await c.submit(['Direction=receive']);
    expect(r).toEqual({ ok: false, error: 'missing LocalFile' });
    expect(d.startTransfer, 'a validation failure must not reach the host').not.toHaveBeenCalled();
  });

  it('passes a driver refusal straight through, without going running', async () => {
    const d = deps({ startTransfer: vi.fn(() => ({ ok: false, error: 'keyboard locked' })) });
    const c = createTransferController(d);
    const r = await c.submit(['Direction=receive']);
    expect(r).toEqual({ ok: false, error: 'keyboard locked' });
    expect(c.running()).toBe(false);
  });

  it('is running once the driver accepted, and refuses a second submit', async () => {
    const d = deps();
    const c = createTransferController(d);
    expect((await c.submit([])).ok).toBe(true);
    expect(c.running()).toBe(true);
    const second = await c.submit([]);
    expect(second.ok).toBe(false);
    expect(d.startTransfer).toHaveBeenCalledTimes(1);
  });

  it('REFUSES to close while running, and focuses Cancel instead', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    expect(c.shouldPreventClose()).toBe(true);
    c.onCloseAttempt();
    expect(d.focusCancel).toHaveBeenCalled();
    expect(d.closeWindow).not.toHaveBeenCalled();
  });

  it('allows the close once nothing is running', async () => {
    const d = deps();
    const c = createTransferController(d);
    expect(c.shouldPreventClose()).toBe(false);
    await c.submit([]);
    c.finish({ ok: true, bytes: 5 });
    expect(c.shouldPreventClose()).toBe(false);
  });

  it('CANCELS on quit rather than blocking it', async () => {
    const cancel = vi.fn();
    const d = deps({ startTransfer: vi.fn(() => ({ ok: true, cancel })) });
    const c = createTransferController(d);
    await c.submit([]);
    c.shutdown();
    expect(cancel, 'quit must tell the host, not leave it waiting for a frame').toHaveBeenCalled();
  });

  it('shutdown is safe with no transfer running', () => {
    const d = deps();
    const c = createTransferController(d);
    expect(() => { c.shutdown(); }).not.toThrow();
  });

  it('forwards progress and the final result to the window', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    // The driver's callbacks were handed to it by the controller; drive them as it would.
    const opts = (d.startTransfer as unknown as { mock: { calls: Array<[{
      onProgress: (t: string) => void; onDone: (r: { ok: boolean }) => void;
    }]> } }).mock.calls[0]![0];
    opts.onProgress('128 bytes');
    expect(d.sent).toContainEqual(['transfer:progress', '128 bytes']);
    opts.onDone({ ok: true });
    expect(d.sent.some(([ch]) => ch === 'transfer:done')).toBe(true);
    expect(c.running()).toBe(false);
  });

  it('a completion through the driver clears running, so the window can close', async () => {
    const d = deps();
    const c = createTransferController(d);
    await c.submit([]);
    const opts = (d.startTransfer as unknown as { mock: { calls: Array<[{
      onDone: (r: { ok: boolean }) => void;
    }]> } }).mock.calls[0]![0];
    opts.onDone({ ok: false, error: 'aborted' });
    expect(c.running()).toBe(false);
    expect(c.shouldPreventClose()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
cd ~/git/tn3270 && npx vitest run packages/gui/test/transferWindow.test.ts 2>&1 | tail -8
```

Expected: FAIL — cannot resolve `../src/transferWindow.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/gui/src/transferWindow.ts`:

```typescript
import type { StartTransferOptions, TransferRequest, TransferRun } from '@tn3270/frontend';

/**
 * The transfer window's main-side logic, with Electron INJECTED.
 *
 * `BrowserWindow`, `dialog` and `ipcMain` cannot be constructed outside an Electron process, and
 * none of the decisions here are Electron's: which dialog a direction wants, whether a close may
 * proceed, and -- the one that earns this file -- that `cancel` is reached on EVERY path that
 * ends a transfer.
 *
 * ## THE TEARDOWN RULE, WRITTEN DOWN BECAUSE IT HAS BITTEN THIS PROJECT THREE TIMES
 *
 * `packages/core/src/session.ts` has been fixed three times for one shape: *one teardown path
 * clears the state and another does not* (`Session.e` cleared only on the REJECT path, then
 * `IAC DONT TN3270E` taking a generic arm, then `handleClose` not clearing `dft`). A window adds
 * new ways for a transfer to end that a TUI overlay never had -- the red button, Cmd-W, Cmd-Q,
 * the session closing underneath. Every one of them must reach `cancel`, because ABANDONING a
 * transfer leaves the host's program waiting for a frame that never comes, where ABORTING tells
 * it to stop.
 *
 * `TransferRun.cancel` already knows the hard parts and needs no help: it defers to the engine
 * for a DFT transfer that has started, discards one that lost the protocol race without sending
 * anything, and refuses a CUT abort at a geometry with no frame layout to write into. So this
 * file adds no cancellation logic -- only the guarantee that the existing one is called.
 */

export interface TransferDeps {
  /** Send to the transfer window's renderer. */
  send(channel: 'transfer:progress' | 'transfer:done', payload: unknown): void;
  showWindow(): void;
  closeWindow(): void;
  /** Focus the Cancel button, the only route out of a running transfer. */
  focusCancel(): void;
  /** Native Open dialog: resolves to a path, or undefined if cancelled. */
  openDialog(): Promise<string | undefined>;
  /** Native Save dialog: resolves to a path, or undefined if cancelled. */
  saveDialog(): Promise<string | undefined>;
  /**
   * `startTransfer` from `@tn3270/frontend`, ALREADY BOUND to this process's session and files.
   *
   * NARROWER THAN `StartTransferOptions` ON PURPOSE, and the plan got this wrong once: that
   * interface REQUIRES `session` and `files` (`transferRun.ts:65-75`), which this controller
   * does not have and must not have -- it is the Electron-free half. Taking the full type here
   * would force a lying `as StartTransferOptions` cast at the call site. `main.ts` owns the
   * session and closes over both, so the two omitted fields are supplied there.
   */
  startTransfer(opts: Omit<StartTransferOptions, 'session' | 'files'>): TransferRun;
  /** `transferCommand` from `@tn3270/frontend`. THROWS on invalid keywords. */
  buildCommand(keywords: readonly string[]): { request: TransferRequest; command: string };
}

export interface TransferController {
  running(): boolean;
  browse(direction: string): Promise<string | undefined>;
  submit(keywords: readonly string[]): Promise<{ ok: boolean; error?: string }>;
  requestCancel(): void;
  /** Called when the transfer ends, however it ends. */
  finish(result: { ok: boolean; error?: string; bytes?: number }): void;
  /** True while a close must be refused. */
  shouldPreventClose(): boolean;
  onCloseAttempt(): void;
  /** App quit, or the session going away: cancel rather than block. */
  shutdown(): void;
}

export function createTransferController(deps: TransferDeps): TransferController {
  let run: TransferRun | undefined;
  let isRunning = false;

  const finish = (result: { ok: boolean; error?: string; bytes?: number }): void => {
    isRunning = false;
    run = undefined;
    deps.send('transfer:done', result);
  };

  return {
    running: () => isRunning,

    async browse(direction) {
      // A SEND must choose a file that exists; a RECEIVE names a destination that need not.
      // The dialog returns a PATH ONLY and never sets `Exist`: that is a three-way choice
      // (`keep`/`replace`/`append`) whose `append` has no dialog equivalent at all, so letting
      // the chooser decide would make a legal transfer unexpressible. See the spec.
      return direction === 'send' ? deps.openDialog() : deps.saveDialog();
    },

    async submit(keywords) {
      // ONE SESSION, ONE TRANSFER. Two would interleave two machines' frames on one screen and
      // the host is answering only one of them.
      if (isRunning) return { ok: false, error: 'a transfer is already running' };

      // THE VALIDATOR IS THE AUTHORITY, and it throws. `transferForm.ts` states the rule: the
      // form collects strings and `parseTransferKeywords` decides. Catching here is what lets
      // the form show the validator's own message rather than a guess of ours.
      let built;
      try {
        built = deps.buildCommand(keywords);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      // NO CAST. `TransferDeps.startTransfer` is declared as
      // `Omit<StartTransferOptions, 'session' | 'files'>` precisely so these four fields are the
      // whole of what this Electron-free half supplies; `main.ts` adds the session and the files.
      const started = deps.startTransfer({
        request: built.request,
        command: built.command,
        onProgress: (text) => { deps.send('transfer:progress', text); },
        onDone: (result) => { finish(result); },
      });

      // A LOCAL REFUSAL MEANS THE HOST WAS TOLD NOTHING, and `onDone` will never fire for it --
      // `startTransfer` returns `{ ok: false, error }` for everything checkable locally (3270
      // mode, the keyboard lock, the input field, the source file, the destination). So the
      // answer goes back through this return value and the form stays open and populated.
      if (!started.ok) {
        return { ok: false, error: started.error ?? 'transfer refused' };
      }

      run = started;
      isRunning = true;
      return { ok: true };
    },

    requestCancel() {
      // `cancel` is absent when the run never started; calling it is the only route out of a
      // running transfer, since the window refuses to close.
      run?.cancel?.();
    },

    finish,

    shouldPreventClose: () => isRunning,

    onCloseAttempt() {
      // REFUSED, NOT QUEUED. An accidental Cmd-W or red button must not abandon a transfer, so
      // the close does nothing except point at the one control that ends it properly.
      deps.focusCancel();
    },

    shutdown() {
      // QUIT CANCELS, IT DOES NOT BLOCK. The window may refuse a close; it may not make the
      // application unquittable. Cancelling first is what tells the host to leave transfer mode
      // rather than leaving its program waiting for a frame -- the abort/abandon distinction
      // this module's docstring turns on.
      run?.cancel?.();
      run = undefined;
      isRunning = false;
    },
  };
}
```

- [ ] **Step 4: Build and run the tests**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/gui/test/transferWindow.test.ts 2>&1 | tail -12
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-check the teardown guarantee**

The `shutdown`-cancels assertion is the one protecting against this project's recurring bug, so
prove it fails when the call is removed.

```bash
cd ~/git/tn3270 && cp packages/gui/src/transferWindow.ts /tmp/tw.bak
sed -i '0,/^      run?.cancel?.();$/! s|^      run?.cancel?.();$|      // removed|' packages/gui/src/transferWindow.ts
npm run build >/dev/null 2>&1; npx vitest run packages/gui/test/transferWindow.test.ts 2>&1 | grep -E "×|Tests "
cp /tmp/tw.bak packages/gui/src/transferWindow.ts && npm run build >/dev/null 2>&1
npx vitest run packages/gui/test/transferWindow.test.ts 2>&1 | grep -E "Tests "
```

Expected: the mutation reddens **CANCELS on quit rather than blocking it**; the restore returns all
10 to green. If the mutation leaves everything green, the test is asserting nothing and must be
fixed before proceeding — the edit must be confirmed to have landed on `shutdown`'s call and not
`requestCancel`'s.

- [ ] **Step 6: Typecheck and commit**

```bash
cd ~/git/tn3270 && npm run typecheck && git add packages/gui/src/transferWindow.ts packages/gui/test/transferWindow.test.ts
git commit -m "feat: the transfer window's controller, with Electron injected

BrowserWindow, dialog and ipcMain cannot be constructed outside an Electron
process, and none of the decisions here are Electron's: which dialog a direction
wants, whether a close may proceed, and that cancel is reached on every path that
ends a transfer.

THAT LAST ONE IS WHY THIS FILE EXISTS AS ITS OWN MODULE. session.ts has been fixed
three times for the shape 'one teardown path clears the state and another does
not', and a window adds ways to end a transfer that a TUI overlay never had: the
red button, Cmd-W, Cmd-Q, the session closing underneath. Quit CANCELS rather than
blocking, because the window may refuse a close but may not make the app
unquittable -- and abandoning leaves the host waiting for a frame where aborting
tells it to stop.

No new cancellation logic: TransferRun.cancel already defers for a started DFT
transfer, discards a protocol-race loser silently, and refuses a CUT abort at a
geometry with no frame layout. This only guarantees it is called.

Mutation-verified: deleting shutdown's cancel reddens the quit test specifically.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 7: Wire it into `main.ts`

**Files:**
- Modify: `packages/gui/src/main.ts`

- [ ] **Step 1: Add the imports**

At the top of `packages/gui/src/main.ts`, extend the two existing import statements. The `electron`
import gains `dialog`; the `@tn3270/frontend` import gains `startTransfer` and `transferCommand`:

```typescript
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen } from 'electron';
import {
  applyAction, defaultSession, describeTlsError, resolveScheme, startTransfer, transferCommand,
  type Action,
} from '@tn3270/frontend';
import { nodeTransferFiles } from '@tn3270/node-files';
import { createTransferController } from './transferWindow.js';
```

- [ ] **Step 2: Create the window lazily, after the session exists**

Insert this immediately after the `let showKeypad = false;` line (around `main.ts:277`), so it can
close over `session`:

```typescript
  /**
   * The transfer window, created on first request and reused after that.
   *
   * LAZY because most sessions never transfer a file, and an Electron window costs a renderer
   * process. Reused rather than recreated so that reopening mid-transfer shows the RUNNING
   * state instead of a fresh form -- two submits would interleave two machines' frames on one
   * screen.
   */
  let transferWin: BrowserWindow | undefined;
  let transfer: ReturnType<typeof createTransferController> | undefined;

  const openTransferWindow = async (): Promise<void> => {
    if (transferWin !== undefined && !transferWin.isDestroyed()) {
      transferWin.show();
      transferWin.focus();
      return;
    }
    const tw = new BrowserWindow({
      width: 460,
      height: 420,
      useContentSize: true,
      title: 'File Transfer',
      // A CHILD of the terminal window so it travels with it, but NOT modal: the operator may
      // want to look at the screen behind it, and a 3270 transfer is typed at a command prompt
      // they may need to see.
      parent: win,
      modal: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        // `.cjs`, compiled from transferPreload.cts: an ESM preload cannot load.
        preload: join(here, 'transferPreload.cjs'),
      },
    });
    transferWin = tw;
    // Same forwarding as the main window: a renderer that throws otherwise produces a window
    // that does nothing with no explanation anywhere.
    tw.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      process.stdout.write(`transfer[${level}] ${sourceId}:${line} ${message}\n`);
    });
    tw.webContents.on('did-fail-load', (_e, code, desc, url) => {
      process.stdout.write(`transfer window failed to load ${url}: ${code} ${desc}\n`);
    });

    transfer = createTransferController({
      send: (channel, payload) => {
        if (!tw.isDestroyed()) tw.webContents.send(channel, payload);
      },
      showWindow: () => { tw.show(); },
      closeWindow: () => { tw.close(); },
      focusCancel: () => { tw.webContents.focus(); },
      openDialog: async () => {
        const r = await dialog.showOpenDialog(tw, {
          title: 'Send which file?',
          properties: ['openFile'],
        });
        return r.canceled ? undefined : r.filePaths[0];
      },
      saveDialog: async () => {
        const r = await dialog.showSaveDialog(tw, { title: 'Receive into which file?' });
        return r.canceled ? undefined : r.filePath;
      },
      startTransfer: (opts) => startTransfer({ ...opts, session, files: nodeTransferFiles }),
      buildCommand: (keywords) => transferCommand(keywords),
    });

    // THE CLOSE GUARD. `preventDefault` on `close` is what makes an accidental Cmd-W or red
    // button unable to abandon a running transfer; Cancel is the only route out.
    tw.on('close', (e) => {
      if (transfer?.shouldPreventClose() === true) {
        e.preventDefault();
        transfer.onCloseAttempt();
      }
    });
    tw.on('closed', () => {
      transferWin = undefined;
      transfer = undefined;
    });

    await tw.loadFile(join(here, '..', 'transfer.html'));
  };

  ipcMain.handle('transfer:browse', async (_e, direction: string) =>
    transfer === undefined ? undefined : transfer.browse(direction));
  ipcMain.handle('transfer:submit', async (_e, keywords: readonly string[]) =>
    transfer === undefined
      ? { ok: false, error: 'the transfer window is not open' }
      : transfer.submit(keywords));
  ipcMain.on('transfer:cancel', () => { transfer?.requestCancel(); });

  /**
   * A QUIT CANCELS A RUNNING TRANSFER RATHER THAN BEING BLOCKED BY IT.
   *
   * The window refuses a close while running; it must not make the application unquittable.
   * Cancelling here is what tells the host to leave transfer mode -- walking away leaves its
   * program waiting for a frame that never comes.
   */
  app.on('before-quit', () => { transfer?.shutdown(); });
```

- [ ] **Step 3: Intercept the `transferForm` action**

In the existing `ipcMain.on('action', ...)` handler (`main.ts:357`), add one arm immediately after
the `toggleKeypad` arm:

```typescript
    // INTERCEPTED HERE for the same reason as `quit` and `toggleKeypad`: `applyAction` THROWS on
    // it, because a transfer dialog is the front end's own business. A front end that forgot
    // this arm would die on the keystroke rather than being silently inert -- which is the
    // property that throw exists to give.
    if (action.kind === 'transferForm') { void openTransferWindow(); return; }
```

- [ ] **Step 4: Build, typecheck, and run the whole suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: build and typecheck clean; `85 passed` (82 + transferModule + transferUi + transferWindow); `2179 passed` (2156 + 2 + 11 + 10).

- [ ] **Step 5: Confirm the GUI still starts and the canvas window is unaffected**

```bash
cd ~/git/tn3270 && node packages/gui/scripts/xvfb.mjs 2>/dev/null; \
  TN3270_GUI_SHOT=/tmp/shot-after.png ./node_modules/.bin/electron packages/gui/dist/main.js \
  --no-sandbox --disable-gpu -insecure -model 3278-2-E 127.0.0.1:3270 2>&1 | tail -5
```

Expected: a `sha256` line and no `did-fail-load`. This proves the new `ipcMain` handlers and the
extra imports did not break startup — the canvas path is untouched but shares the process.

- [ ] **Step 6: Run the existing golden harness, which must still match**

```bash
cd ~/git/tn3270 && npx tsc --build --force packages/gui && node packages/gui/scripts/shot.mjs 2>&1 | tail -5
```

Expected: `3/3`. The `--force` rebuild is mandatory — the GUI staleness guard reddens on mtimes
alone after a `git checkout`, and this task touched `packages/gui`.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/src/main.ts
git commit -m "feat: wire the transfer window into the GUI

The transferForm action is now intercepted beside quit and toggleKeypad, for the
same reason all three are: applyAction THROWS on them, so a front end that forgot
the arm dies on the keystroke instead of being silently inert.

The window is LAZY (most sessions never transfer a file, and a window costs a
renderer process) and REUSED (reopening mid-transfer must show the running state,
not a fresh form). It is a child of the terminal window but NOT modal: a 3270
transfer is typed at a command prompt the operator may need to see.

The close guard is a preventDefault on 'close', which is what makes an accidental
Cmd-W unable to abandon a transfer; and before-quit CANCELS, because the window may
refuse a close but may not make the app unquittable.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 8: A by-hand Electron harness, and the test that keeps it honest

`npm test` cannot drive Electron, so this follows `clicks.mjs`/`keys.mjs`: a script run by hand, plus
a unit test pinning the flags whose absence would disable it **silently**.

**Files:**
- Create: `packages/gui/scripts/transfer.mjs`
- Test: `packages/gui/test/transfer-harness-flags.test.ts`

- [ ] **Step 1: Write the harness**

Create `packages/gui/scripts/transfer.mjs`:

```javascript
#!/usr/bin/env node
/**
 * Drive the transfer WINDOW under Xvfb and assert what it did. Run by hand; `npm test` cannot.
 *
 * ## IT NEVER REACHES A HOST, AND THAT IS A PRIVACY REQUIREMENT
 *
 * A transfer form carries a path and sits in front of a logged-on session. `TN3270_GUI_REPLAY`
 * exists because a golden taken from a live logon can contain a typed password and goldens live
 * in git forever; the same argument applies to anything this harness prints. So it runs in
 * REPLAY mode against a committed trace, which can reach no host at all.
 *
 * ## THE DIALOG IS STUBBED, BECAUSE A NATIVE CHOOSER CANNOT BE DRIVEN HEADLESSLY
 *
 * `TN3270_GUI_TRANSFER_PATH` makes `openDialog`/`saveDialog` resolve to that path without
 * showing anything. Without it this harness would hang on a modal nobody can click -- a stall,
 * not an error, which is the shape this repo keeps writing comments about.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const guiDir = dirname(here);
const repoRoot = dirname(dirname(guiDir));

// `-insecure` because default-on TLS against a plaintext host HANGS rather than failing;
// `--no-sandbox` and `--disable-gpu` because this box has no GL and `show: false` STALLS
// without the latter. All three are pinned by transfer-harness-flags.test.ts.
const ARGV = [
  join(guiDir, 'dist', 'main.js'),
  '--no-sandbox', '--disable-gpu',
  '-insecure', '-model', '3278-2-E',
  '127.0.0.1:3270',
];

const trace = join(repoRoot, 'packages', 'fixtures', 'x3270', 'tso-query-reply.txt');

const child = spawn(join(repoRoot, 'node_modules', '.bin', 'electron'), ARGV, {
  cwd: repoRoot,
  env: {
    ...process.env,
    DISPLAY: process.env.DISPLAY ?? ':99',
    TN3270_GUI_REPLAY: trace,
    // Open the transfer window, fill it, and submit -- all without a host.
    TN3270_GUI_TRANSFER: 'open,path=/tmp/harness-transfer.bin,host=HARNESS.DATA,submit',
    TN3270_GUI_TRANSFER_PATH: '/tmp/harness-transfer.bin',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (b) => { out += b.toString(); });
child.stderr.on('data', (b) => { out += b.toString(); });

// THREE ORDERED BAILS, because a signal death leaves stdout INTACT and `status !== 0` skips it:
// a crashed client once passed this repo's checks that way.
child.on('error', (err) => {
  process.stderr.write(`failed to spawn electron: ${err.message}\n`);
  process.exit(1);
});
child.on('close', (code, signal) => {
  process.stdout.write(out);
  if (signal !== null) {
    process.stderr.write(`electron died on ${signal}\n`);
    process.exit(1);
  }
  const checks = [
    ['window opened', /transfer window: opened/],
    ['fields rendered', /transfer window: fields=\d+/],
    ['local path set', /transfer window: localFile=\/tmp\/harness-transfer\.bin/],
    ['host file set', /transfer window: hostFile=HARNESS\.DATA/],
    ['submit refused without a host', /transfer window: submit -> ok=false/],
    ['no did-fail-load', /^(?!.*transfer window failed to load).*$/s],
  ];
  let passed = 0;
  for (const [name, re] of checks) {
    const ok = re.test(out);
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
    if (ok) passed++;
  }
  process.stdout.write(`${passed}/${checks.length} checks passed (exit ${code})\n`);
  process.exit(passed === checks.length ? 0 : 1);
});
```

- [ ] **Step 2: Write the flags test**

Create `packages/gui/test/transfer-harness-flags.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the TRANSFER harness's invocation, which `npm test` cannot run.
 *
 * Same reasoning as `clicks-harness-flags.test.ts`: a harness outside the fast gate is exempt
 * from every change until somebody remembers it, and `pty-smoke.py` sat at 1 of 12 for two days
 * proving it. This reads the script as TEXT and pins the things whose absence would disable it
 * SILENTLY -- and silence is the hazard, because this is the only cover anywhere for the
 * transfer window's Electron wiring.
 */
const guiDir = dirname(dirname(fileURLToPath(import.meta.url)));
const harness = readFileSync(join(guiDir, 'scripts', 'transfer.mjs'), 'utf8');

describe('the transfer harness', () => {
  it('keeps the three flags without which it hangs or lies', () => {
    const argv = /^const ARGV = \[[^\]]*\]/m.exec(harness);
    expect(argv, 'no ARGV list found in transfer.mjs').not.toBeNull();
    expect(argv![0]).toContain("'-insecure'");
    expect(argv![0]).toContain("'--no-sandbox'");
    expect(argv![0]).toContain("'--disable-gpu'");
  });

  it('runs in REPLAY mode, so it can reach no host', () => {
    // A transfer form carries a path and sits in front of a logged-on session. Replay is what
    // makes anything this harness prints safe to look at -- the same argument that keeps
    // goldens away from live logons.
    expect(harness).toMatch(/TN3270_GUI_REPLAY/);
  });

  it('stubs the native dialog, or it would hang on a modal nobody can click', () => {
    expect(harness).toMatch(/TN3270_GUI_TRANSFER_PATH/);
  });

  it('bails on a SIGNAL death before looking at the exit code', () => {
    // `spawnSync` on a signal death gives status=null with stdout INTACT, so a `status !== 0`
    // check skips it and a crashed process passes. Measured in this repo.
    const closeBody = /child\.on\('close'[\s\S]*?\n\}\);/.exec(harness);
    expect(closeBody, 'no close handler found').not.toBeNull();
    const signalAt = closeBody![0].indexOf('signal !== null');
    const checksAt = closeBody![0].indexOf('const checks');
    expect(signalAt, 'no signal check in the close handler').toBeGreaterThan(-1);
    expect(signalAt, 'the signal bail must come BEFORE the checks are scored')
      .toBeLessThan(checksAt);
  });
});
```

- [ ] **Step 3: Run the flags test**

```bash
cd ~/git/tn3270 && npx vitest run packages/gui/test/transfer-harness-flags.test.ts 2>&1 | tail -8
```

Expected: PASS, 4 tests.

- [ ] **Step 4: Note what is NOT yet implemented, and stop**

`TN3270_GUI_TRANSFER` and `TN3270_GUI_TRANSFER_PATH` are consumed by nothing yet — the harness will
fail every check. That is deliberate and it is the next task's work. **Do not implement the seam
here**: this task's deliverable is the harness and its guard, and a seam added in the same commit
would make the guard's first green untrustworthy.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && chmod +x packages/gui/scripts/transfer.mjs
git add packages/gui/scripts/transfer.mjs packages/gui/test/transfer-harness-flags.test.ts
git commit -m "test: a by-hand transfer harness, and the test that keeps it honest

npm test cannot drive Electron, so this follows clicks.mjs and keys.mjs: a script
run by hand plus a unit test pinning the flags whose absence disables it SILENTLY.
A harness outside the fast gate is exempt from every change until somebody
remembers it, and pty-smoke.py sat at 1 of 12 for two days proving it.

It runs in REPLAY mode and can reach no host, which is a privacy requirement
rather than convenience: a transfer form carries a path and sits in front of a
logged-on session. The native dialog is stubbed because a modal nobody can click
would HANG rather than fail.

The harness does not pass yet -- its seam is the next task. Committed separately so
the guard's first green is not the same commit as the thing it guards.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 9: The test seam the harness needs

**Files:**
- Modify: `packages/gui/src/main.ts`

- [ ] **Step 1: Add the two seam variables to `SEAM`**

In the `SEAM` object (`main.ts:73-127`), add two entries before the closing `});`:

```typescript
  /**
   * A SIXTH TEST SEAM: `TN3270_GUI_TRANSFER='open,path=/tmp/f,host=A.B,submit'` drives the
   * transfer window without a mouse.
   *
   * Comma-separated steps, applied in order, so one variable expresses a whole scenario and the
   * harness needs no IPC of its own. Like `TN3270_GUI_CLICKS` it names WHAT to do rather than
   * where to click: a coordinate list would be a second copy of the layout and would pass while
   * the layout was wrong.
   */
  transfer: process.env['TN3270_GUI_TRANSFER'] ?? '',
  /**
   * What the native file dialog should return, INSTEAD OF SHOWING.
   *
   * Separate from `transfer` above because it substitutes a MODAL, and a modal nobody can click
   * does not fail -- it HANGS, which is the failure shape this project has met in four other
   * places. Empty means show the real dialog.
   */
  transferPath: process.env['TN3270_GUI_TRANSFER_PATH'] ?? '',
```

- [ ] **Step 2: Make the dialogs respect the stub**

In `openTransferWindow`, replace the two dialog implementations added in Task 7 with:

```typescript
      openDialog: async () => {
        // THE STUB SUBSTITUTES THE WHOLE DIALOG, never merely its default. A real modal under
        // Xvfb has nobody to click it and would hang the harness.
        if (SEAM.transferPath !== '') return SEAM.transferPath;
        const r = await dialog.showOpenDialog(tw, {
          title: 'Send which file?',
          properties: ['openFile'],
        });
        return r.canceled ? undefined : r.filePaths[0];
      },
      saveDialog: async () => {
        if (SEAM.transferPath !== '') return SEAM.transferPath;
        const r = await dialog.showSaveDialog(tw, { title: 'Receive into which file?' });
        return r.canceled ? undefined : r.filePath;
      },
```

- [ ] **Step 3: Report what the window did, and drive the scenario**

Add this at the end of `openTransferWindow`, after the `await tw.loadFile(...)` line:

```typescript
    if (SEAM.transfer === '') return;
    // OBSERVABLE ONLY UNDER THE SEAM. These lines are what the harness scores, and they must
    // not print in a normal run: a `localFile=` line carries a path, and this window has been
    // opened in front of a live session.
    process.stdout.write('transfer window: opened\n');
    for (const step of SEAM.transfer.split(',')) {
      const [name, value] = step.includes('=') ? step.split('=', 2) : [step, undefined];
      if (name === 'open') continue;                    // already open
      if (name === 'path' && value !== undefined) {
        await tw.webContents.executeJavaScript(
          `window.__tn3270SetField('localFile', ${JSON.stringify(value)})`);
        process.stdout.write(`transfer window: localFile=${value}\n`);
      } else if (name === 'host' && value !== undefined) {
        await tw.webContents.executeJavaScript(
          `window.__tn3270SetField('hostFile', ${JSON.stringify(value)})`);
        process.stdout.write(`transfer window: hostFile=${value}\n`);
      } else if (name === 'submit') {
        const r = await tw.webContents.executeJavaScript('window.__tn3270Submit()') as
          { ok: boolean; error?: string };
        process.stdout.write(
          `transfer window: submit -> ok=${r.ok}${r.error === undefined ? '' : ` error=${r.error}`}\n`);
      }
    }
    const count = await tw.webContents.executeJavaScript(
      'document.querySelectorAll("#fields .row").length') as number;
    process.stdout.write(`transfer window: fields=${count}\n`);
```

- [ ] **Step 4: Expose the two test hooks from the boot module**

Append to `packages/gui/src/transferBoot.ts`:

```typescript
/**
 * TWO HOOKS FOR THE HARNESS, and nothing else on `window`.
 *
 * `executeJavaScript` is how main drives this window without a mouse, the same way
 * `__tn3270ButtonCentre` lets `clicks.mjs` click a keypad button by label. They go through the
 * SAME `ui` object a real click does, so a scenario cannot pass while the wiring is broken --
 * which is exactly what a hook that manipulated the DOM directly would allow.
 */
declare global {
  interface Window {
    __tn3270SetField(id: string, text: string): void;
    __tn3270Submit(): Promise<{ ok: boolean; error?: string }>;
  }
}

window.__tn3270SetField = (id: string, text: string): void => {
  ui.type(id as TransferFieldId, text);
};
window.__tn3270Submit = async (): Promise<{ ok: boolean; error?: string }> => {
  await ui.start();
  // The form's own status is what a user would see, so the harness reads the same thing.
  const text = document.querySelector('#status')?.textContent ?? '';
  return text.startsWith('transferring') ? { ok: true } : { ok: false, error: text };
};
```

- [ ] **Step 5: Build and run the harness**

```bash
cd ~/git/tn3270 && npx tsc --build --force packages/gui && node packages/gui/scripts/xvfb.mjs 2>/dev/null; \
  node packages/gui/scripts/transfer.mjs 2>&1 | tail -12
```

Expected: `6/6 checks passed`. If `submit -> ok=true` appears instead of `ok=false`, the replay
session is somehow in 3270 mode and the scenario is not testing what it claims — investigate rather
than adjusting the expectation.

- [ ] **Step 6: Confirm the seam prints NOTHING in a normal run**

```bash
cd ~/git/tn3270 && TN3270_GUI_SHOT=/tmp/shot-seam.png ./node_modules/.bin/electron \
  packages/gui/dist/main.js --no-sandbox --disable-gpu -insecure -model 3278-2-E \
  127.0.0.1:3270 2>&1 | grep -c "transfer window:"
```

Expected: `0`. A `localFile=` line in a normal run would print a path from a live session.

- [ ] **Step 7: Full gate, then commit**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck \
  && npx vitest run 2>&1 | grep -E "Test Files|Tests " \
  && node packages/gui/scripts/shot.mjs 2>&1 | tail -2 \
  && node packages/gui/scripts/keys.mjs 2>&1 | tail -2 \
  && node packages/gui/scripts/clicks.mjs 2>&1 | tail -2
```

Expected: clean build and typecheck, `2183 passed` in `86 files` (82 + four new test files), `shot 3/3`, `keys` 18 chords/16
actions, `clicks` 9 buttons/10 actions.

```bash
cd ~/git/tn3270 && git add packages/gui/src/main.ts packages/gui/src/transferBoot.ts
git commit -m "test: a sixth GUI seam drives the transfer window without a mouse

TN3270_GUI_TRANSFER takes comma-separated steps so one variable expresses a whole
scenario, and like TN3270_GUI_CLICKS it names WHAT to do rather than where to
click -- a coordinate list would be a second copy of the layout and would pass
while the layout was wrong. The two window hooks go through the SAME ui object a
real click does, so a scenario cannot pass while the wiring is broken.

TN3270_GUI_TRANSFER_PATH is separate because it substitutes a MODAL: a real dialog
under Xvfb has nobody to click it and would HANG rather than fail.

The reporting lines print ONLY under the seam, and that is a privacy rule rather
than tidiness: a localFile= line carries a path, in a window opened in front of a
live session. Verified that a normal run prints none of them.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 10: Documentation, and the gateway's now-stale refusal

**Files:**
- Modify: `packages/web/src/protocol.ts:129-131`
- Modify: `docs/live-testing.md`
- Modify: `README.md`
- Modify: `docs/HANDOFF.md`

- [ ] **Step 1: Correct the gateway's refusal reason**

The message says "the gateway has no transfer UI", which stops being the reason the moment the GUI
has one. In `packages/web/src/protocol.ts`, replace the `transferForm` rejection and update the
comment above it:

```typescript
    // `transferForm` IS REJECTED, and after 2026-09-30 the REASON is not that no front end has a
    // transfer UI -- the Electron GUI does (`gui/src/transferWindow.ts`). The reason is the one
    // this comment always gave second and must now give first: a browser-initiated transfer
    // would move bytes between the host and the GATEWAY's filesystem, not the operator's.
    //
    // The user's decision (2026-09-30) is that the browser must get REAL browser file I/O --
    // the bytes travelling over the WebSocket so that "local file" means the operator's machine.
    // That needs a new protocol message pair, chunking, and a `TransferFiles` implemented over
    // the socket, and it is its own spec. Until then this stays a rejection rather than an
    // interception, because `applyAction` throws on the kind and an unhandled throw here ends
    // the gateway process and every other operator's session with it.
    if (aKind === 'transferForm') {
      throw new Error(
        'transferForm is not accepted from a client: a browser transfer would write to the '
        + "gateway's filesystem, not yours");
    }
```

- [ ] **Step 2: Run the web tests that assert on that message**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/web 2>&1 | grep -E "Test Files|Tests |×"
```

Expected: if a test pins the old wording it will FAIL — update it to the new wording, keeping its
intent. Do not weaken it to a substring that both messages satisfy.

- [ ] **Step 3: Add the by-hand items to the runbook**

Append to `docs/live-testing.md`:

```markdown
## The GUI transfer window (by hand, 2026-09-30 onward)

The transfer window's Electron wiring is covered by `packages/gui/scripts/transfer.mjs` (6 checks,
replay mode, stubbed dialog). **Three things that harness cannot reach, and they must be said so
rather than implied:**

1. **The native dialog's appearance and behaviour on macOS.** There is no macOS on the build box.
   Check: `Browse…` on a send offers an Open panel that refuses a non-existent file; on a receive it
   offers a Save panel. **The panel must NOT set `Exist`** — pick `replace` in the form and confirm
   the transfer overwrites, then `keep` and confirm it refuses locally without telling the host.
2. **A real transfer, both directions, against TK5 and VM.** The protocol is already live-verified
   (DFT on TK5 at 43x80, CUT on VM); what is new is this front end driving it. Compare BYTES against
   the host's own listing, never the status line — `docs/live-testing.md`'s own rule.
3. **The close guard against a real transfer in flight.** Start a receive of something large enough
   to watch, then try the red button and Cmd-W: both must refuse, and Cancel must abort such that the
   host leaves transfer mode (VM says `TRANS03` or its own abort text; TSO returns to `READY`). Then
   Cmd-Q during a transfer: it must cancel and quit, not hang.
```

- [ ] **Step 4: Document it in the README**

Add to the README's GUI section:

```markdown
### File transfer (IND$FILE)

Press `Ctrl-T`, or click `Xfer` on the virtual keypad, to open the transfer window. Choose a local
file with `Browse…`, name the host file, and press Start. `Direction=send` offers an Open panel;
`receive` offers a Save panel.

The host decides which protocol is used — CUT or DFT — and the window reports progress either way.
While a transfer is running the window refuses to close: use `Cancel`, which tells the host to leave
transfer mode rather than abandoning it mid-frame. Quitting the app cancels a running transfer first.

`Exist` is yours to set and the Save panel deliberately does not set it: `append` has no equivalent
in a file chooser, so the three-way choice stays explicit.
```

- [ ] **Step 5: Update HANDOFF**

Replace the START HERE section of `docs/HANDOFF.md` with the state after this plan, and move item 2
of *what remains* to done, noting that the web half is now the outstanding piece and needs its own
spec.

- [ ] **Step 6: Full gate and commit**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck \
  && npx vitest run 2>&1 | grep -E "Test Files|Tests " \
  && node packages/gui/scripts/shot.mjs 2>&1 | tail -2 \
  && node packages/gui/scripts/transfer.mjs 2>&1 | tail -2 \
  && python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -2
```

Expected: everything green, `pty-smoke.py` 12/12.

```bash
cd ~/git/tn3270 && git add -A
git commit -m "docs: the GUI transfers files, and the gateway's refusal says why it does not

The gateway's rejection message said 'the gateway has no transfer UI', which stops
being true the moment the GUI has one -- so it now gives the reason that was always
the real one: a browser transfer would write to the GATEWAY's filesystem, not the
operator's. The fix for that is real browser file I/O over the WebSocket, which is
its own spec.

The runbook gains the three things the Electron harness cannot reach and says so
plainly: macOS dialog behaviour (no Mac here), a real transfer both directions
compared BY BYTES against the host's listing, and the close guard against a
transfer actually in flight.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## PROGRESS / AS BUILT

*(Each task appends its own notes here as it lands: what differed from the plan, what the mutation
checks showed, and any defect found in this plan rather than in the code. Previous features here
recorded forty-odd such defects each, nearly all in the plan — so an empty section at the end of
implementation means the annotations were skipped, not that the plan was perfect.)*

## Verification checklist for the whole plan

- [ ] `npm run build` clean
- [ ] `npm run typecheck` clean (vitest does NOT typecheck — 15 green tests once sat over a failing build here)
- [ ] `npx vitest run` — 2183 tests in 86 files, up from 2156 in 82
- [ ] `node packages/gui/scripts/shot.mjs` — 3/3, after `npx tsc --build --force packages/gui`
- [ ] `node packages/gui/scripts/keys.mjs` — 18 chords/16 actions
- [ ] `node packages/gui/scripts/clicks.mjs` — 9 buttons/10 actions
- [ ] `node packages/gui/scripts/transfer.mjs` — 6/6
- [ ] `python3 packages/tui/scripts/pty-smoke.py` — 12/12
- [ ] `node packages/web/scripts/browser-shot.mjs` — 2/2 (the gateway is untouched but shares `frontend`)
- [ ] A normal GUI run prints no `transfer window:` line
- [ ] The three by-hand items in `docs/live-testing.md` remain OPEN and are labelled as such
