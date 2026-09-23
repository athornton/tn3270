# Interactive `IND$FILE` transfer in the TUI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the TUI a `Ctrl-T` form that runs a CUT `IND$FILE` transfer, so file transfer is reachable from an interactive front end for the first time.

**Architecture:** The host-independent half of `cli/src/transfer.ts` moves to `packages/frontend`; `nodeTransferFiles` moves to a new `packages/node-files`. A pure form model (`frontend/src/transferForm.ts`) owns fields, cycle order and applicability; `tui/src/transferOverlay.ts` renders it; `app.ts` routes keys through a second overlay state that is mutually exclusive with the keypad's. The transfer itself reuses `CutTransfer` unchanged, driven by an event-driven engine in the TUI rather than the CLI's `await`-blocking loop.

**Tech Stack:** TypeScript (project references, `tsc --build`), vitest, Node ESM. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-22-interactive-file-transfer-design.md`

---

## Read this before Task 1

**THE SOURCE BEATS THIS PLAN.** Forty-six defects were found executing the keypad plan and nearly all were in the plan, not the code. If a line number, a type or an assertion here disagrees with the file in front of you, the file is right — fix the plan as you go and say so in your commit message.

**Five environment facts that each cost a session before:**

1. **`npm run build` MUST precede `vitest` after any cross-package move.** `@tn3270/frontend` resolves to its built `dist/index.js`. Testing before rebuilding once failed 22 tests in a way that looked like a broken refactor.
2. **Pin the working directory.** Use `./node_modules/.bin/vitest` from the repo root. A bare `npx vitest` from elsewhere downloads a *different* vitest (measured: 5.0.1 against the workspace's 3.2.7) and reports plausible non-evidence.
3. **`vitest` does not typecheck.** Run `npm run typecheck` before believing a green suite.
4. **`npm run build`, not `npm run build --workspaces`** — the latter fails on the data-only fixtures package.
5. **A `git checkout` reddens the GUI/web staleness guards** by rewriting mtimes. If you touch those packages: `npx tsc --build --force packages/gui packages/web`.

**Baseline to beat:** `main` at `19c973c`, **1869 tests in 74 files**, build and typecheck clean, tree clean.

**Work on a branch.** `git checkout -b interactive-transfer-tui` before Task 1. The last five features each ran on one and merged `--no-ff`.

---

## File Structure

**New files:**

| path | responsibility |
|---|---|
| `packages/frontend/src/transfer.ts` | The host-independent half moved out of `cli/src/transfer.ts`: types, `Dialect`, `dialectFor`, `parseTransferKeywords`, `transferCommand`, `TransferFiles`, `TransferOptionError`, `IND_FILE`. No Node, no filesystem, no terminal. |
| `packages/frontend/src/transferForm.ts` | The pure form model: field list, values, cycle order, `applicable`, `cycleValue`, `setText`, `formKeywords`. No rendering, no state outside the object it returns. |
| `packages/node-files/` (package) | Exactly one thing: `nodeTransferFiles`, the `TransferFiles` implementation over `node:fs`. |
| `packages/tui/src/transferOverlay.ts` | Renders the form model to lines, like `keypadOverlay.ts`. Pure. Owns `TRANSFER_MIN` and its own `transferFits`. |
| `packages/tui/src/transferRun.ts` | The event-driven transfer engine: the CLI's `runTransferFrames` loop re-expressed as a `screen`-event stepper with timeouts. |

**Modified:**

| path | change |
|---|---|
| `packages/cli/src/transfer.ts` | Reduced to a re-export-free shell — deleted entirely; its remaining consumers import from `@tn3270/frontend`. |
| `packages/cli/src/runner.ts` | Imports the moved symbols from `@tn3270/frontend`. |
| `packages/cli/src/main.ts` | `nodeTransferFiles` deleted; imported from `@tn3270/node-files`. |
| `packages/frontend/src/keymap.ts` | `Action` gains `{ kind: 'transferForm' }`. |
| `packages/frontend/src/actions.ts` | `applyAction` throws on `transferForm`, as it does on `quit`/`toggleKeypad`. |
| `packages/frontend/src/keypad.ts` | A `Xfer` key added to `KEYPAD_KEYS` — gives stage 3 the GUI button for free. |
| `packages/frontend/src/bindings.ts` | `Ctrl-T` → `transferForm` in `BINDING_INTENT`. |
| `packages/frontend/src/index.ts` | Exports the new modules. |
| `packages/tui/src/app.ts` | A second overlay state, mutually exclusive with the keypad's. |
| `packages/tui/src/main.ts` | Constructs `nodeTransferFiles` and passes it to `App`. |
| `packages/core/src/ft/transfer.ts` | A public `cancel(screen)` method. |
| `package.json` (root) | `packages/node-files` added to the `typecheck` script. |
| `packages/cli/tsconfig.json`, `packages/tui/tsconfig.json` | `references` entries for `../node-files`. |

---

## Task 1: Move the host-independent half of `transfer.ts` into `frontend`

Pure refactor. No behaviour changes. **This task's regression guard is the existing test suite** — the ten keyword rules must behave identically after the move.

**Files:**
- Create: `packages/frontend/src/transfer.ts`
- Delete: `packages/cli/src/transfer.ts`
- Modify: `packages/frontend/src/index.ts`, `packages/cli/src/runner.ts`, `packages/cli/src/main.ts`
- Move: `packages/cli/test/transfer.test.ts` → `packages/frontend/test/transfer.test.ts`

- [ ] **Step 1: Record the baseline so the move can be proven inert**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run --reporter=basic 2>&1 | tail -5
```

Expected: `Tests  1869 passed (1869)`, `Test Files  74 passed (74)`. Write the number down; Task 1 must end at the same total.

- [ ] **Step 2: Move the file with git so history follows it**

```bash
cd /home/a/athor/git/tn3270
git mv packages/cli/src/transfer.ts packages/frontend/src/transfer.ts
git mv packages/cli/test/transfer.test.ts packages/frontend/test/transfer.test.ts
```

- [ ] **Step 3: Fix the moved file's imports**

`packages/frontend/src/transfer.ts` imports from `@tn3270/core`:

```typescript
import { AckAid, type TransferDirection } from '@tn3270/core';
```

That import is already correct — `frontend` depends on `core`. **Verify nothing else in the file reaches for `node:` or a `cli`-relative path:**

```bash
grep -n "node:\|from '\./" packages/frontend/src/transfer.ts
```

Expected: no output. If there is any, the module was not as host-independent as the spec claimed — stop and report it rather than papering over it.

- [ ] **Step 4: Add the exports to `frontend/src/index.ts`**

Append to `packages/frontend/src/index.ts`:

```typescript
// IND$FILE transfer's host-independent half: keyword validation and command construction.
// Here rather than in `cli` because the TUI must be able to validate a transfer request and
// `tui` deliberately does not depend on `cli` -- severing that dependency was the point of
// creating this package. The Node-coupled half (`TransferFiles` over `node:fs`) is in
// `@tn3270/node-files`, so this stays safe for the browser bundles in `gui` and `web`.
export {
  parseTransferKeywords, transferCommand, dialectFor,
  TSO_DIALECT, VM_DIALECT, TransferOptionError, IND_FILE,
} from './transfer.js';
export type {
  TransferFiles, TransferRequest, Dialect,
  FtHostType, FtMode, FtCr, FtExist, FtRecfm,
} from './transfer.js';
```

- [ ] **Step 5: Update the moved test's imports**

In `packages/frontend/test/transfer.test.ts`, change any import of the old path to the new one:

```bash
cd /home/a/athor/git/tn3270
grep -n "from '.*transfer" packages/frontend/test/transfer.test.ts | head
```

Rewrite each to `from '../src/transfer.js'`. **Do NOT import from `@tn3270/frontend`'s built entry point in its own package's tests** — that would test `dist` rather than `src` and go stale.

- [ ] **Step 6: Update `cli`'s import sites — no shims**

```bash
cd /home/a/athor/git/tn3270
grep -rn "from './transfer.js'\|from '\./transfer'" packages/cli/src/
```

Each hit becomes an import from `@tn3270/frontend`. In `packages/cli/src/runner.ts` the symbols used are `transferCommand`, `TransferFiles` and `TransferOptionError` (check with the grep above — take the actual list, not this one). In `packages/cli/src/main.ts` it is `TransferFiles`.

**No re-export shim in `cli`.** Imports are updated at their sites, as for the `hostspec.ts`/`tls.ts` move.

- [ ] **Step 7: Build, then test — in that order**

```bash
cd /home/a/athor/git/tn3270
npm run build && npm run typecheck
```

Expected: both silent. Then:

```bash
./node_modules/.bin/vitest run --reporter=basic 2>&1 | tail -5
```

Expected: **still 1869 tests passing in 74 files.** The file count is unchanged because a test file moved rather than being added. A different total means the move was not inert — find out why before continuing.

- [ ] **Step 8: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "refactor: move transfer validation from cli to frontend

$(printf '%s' 'The TUI needs parseTransferKeywords and transferCommand, and tui does not
depend on cli by design. Pure move: 1869 tests before and after, no behaviour
change. The Node-coupled nodeTransferFiles stays in cli until the next commit
gives it a package of its own.

Generated with AI

Co-Authored-By: SLAC AI')"
```

---

## Task 2: Create `packages/node-files`

**Files:**
- Create: `packages/node-files/package.json`, `packages/node-files/tsconfig.json`, `packages/node-files/src/index.ts`, `packages/node-files/test/nodeFiles.test.ts`
- Modify: `packages/cli/src/main.ts`, `packages/cli/tsconfig.json`, `package.json` (root)

- [ ] **Step 1: Write `packages/node-files/package.json`**

Copy `frontend`'s shape. Read it first to match the field order and versions exactly:

```bash
cat packages/frontend/package.json
```

Then write `packages/node-files/package.json` with name `@tn3270/node-files`, `"type": "module"`, `main`/`types`/`exports` pointing at `dist`, a `build` script of `tsc --build`, and one dependency on `@tn3270/frontend` at whatever version `frontend`'s siblings use.

- [ ] **Step 2: Write `packages/node-files/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../frontend" }]
}
```

Check it against `packages/frontend/tsconfig.json` and match that file's actual shape where they differ.

- [ ] **Step 3: Write the failing test**

Create `packages/node-files/test/nodeFiles.test.ts`. This must touch a REAL filesystem — the whole reason the package exists is the `node:fs` coupling, so an in-memory double would test nothing.

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeTransferFiles } from '../src/index.js';

describe('nodeTransferFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tn3270-nf-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips bytes through write and read', () => {
    const p = join(dir, 'a.bin');
    // Includes 0x00 and 0xff: these are file BYTES and nothing in the path may
    // decode them. A string round trip would pass while corrupting binaries.
    const bytes = new Uint8Array([0x00, 0x41, 0xff, 0x0a, 0x1a]);
    nodeTransferFiles.write(p, bytes);
    expect(Array.from(nodeTransferFiles.read(p))).toEqual(Array.from(bytes));
  });

  it('reports existence, and a DIRECTORY exists', () => {
    expect(nodeTransferFiles.exists(join(dir, 'missing'))).toBe(false);
    writeFileSync(join(dir, 'there'), 'x');
    expect(nodeTransferFiles.exists(join(dir, 'there'))).toBe(true);
    // A directory exists. The Exist=keep check would otherwise wave a directory
    // through and fail later inside write() with an EISDIR the operator cannot read.
    mkdirSync(join(dir, 'sub'));
    expect(nodeTransferFiles.exists(join(dir, 'sub'))).toBe(true);
  });

  it('write TRUNCATES and append EXTENDS', () => {
    const p = join(dir, 'b.bin');
    nodeTransferFiles.write(p, new Uint8Array([1, 2, 3]));
    nodeTransferFiles.write(p, new Uint8Array([9]));
    expect(Array.from(readFileSync(p))).toEqual([9]);
    nodeTransferFiles.append(p, new Uint8Array([8, 7]));
    expect(Array.from(readFileSync(p))).toEqual([9, 8, 7]);
  });

  it('append CREATES a missing file rather than throwing', () => {
    // Exist=append against a file that is not there is a legitimate first transfer.
    const p = join(dir, 'fresh.bin');
    nodeTransferFiles.append(p, new Uint8Array([5]));
    expect(Array.from(readFileSync(p))).toEqual([5]);
  });

  it('read returns a plain Uint8Array view, not a pooled Buffer', () => {
    const p = join(dir, 'c.bin');
    writeFileSync(p, Buffer.from([1, 2]));
    const got = nodeTransferFiles.read(p);
    // `readFileSync` returns a Buffer, which IS a Uint8Array but carries extra
    // methods and a pooled backing store. A fresh view is constructed so nothing
    // downstream can be surprised by either.
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(got)).toBe(false);
  });

  it('read throws on a missing file', () => {
    // The runner turns this into "cannot read local file X", so it must throw
    // rather than return empty -- an empty file is a legitimate transfer.
    expect(() => nodeTransferFiles.read(join(dir, 'nope'))).toThrow();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/node-files 2>&1 | tail -15
```

Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 5: Write the implementation by MOVING it**

Create `packages/node-files/src/index.ts`. Take the body from `packages/cli/src/main.ts:132` verbatim, including its comment — this is a move, and the comment records why `Uint8Array` rather than a string:

```typescript
/**
 * The `TransferFiles` implementation over `node:fs`.
 *
 * ITS OWN PACKAGE, and not part of `frontend`, for two reasons that both matter later:
 * the browser bundles (`gui`, `web`) must never acquire a `node:fs` import, and stage 4's
 * web gateway needs a DIFFERENT implementation of this same interface, whose "filesystem"
 * is an upload/download pair rather than a disk. Both front ends that do have a disk
 * (`cli`, `tui`) share this one, so a filesystem bug has exactly one home.
 *
 * `Uint8Array`, never a string: these are file BYTES, and the whole point of the binary
 * default is that nothing in the path decodes them. `readFileSync` with no encoding
 * returns a Buffer, which IS a Uint8Array, but a fresh view is constructed so nothing
 * downstream can be surprised by Buffer's extra methods or by its pooled backing store.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import type { TransferFiles } from '@tn3270/frontend';

export const nodeTransferFiles: TransferFiles = {
  exists: (path) => existsSync(path),
  read: (path) => new Uint8Array(readFileSync(path)),
  write: (path, bytes) => { writeFileSync(path, bytes); },
  append: (path, bytes) => { appendFileSync(path, bytes); },
};
```

- [ ] **Step 6: Wire the four mechanical steps — two of which fail SILENTLY**

(a) Add to `packages/cli/tsconfig.json`'s `references` array:

```json
{ "path": "../node-files" }
```

(b) Add `packages/node-files` to the ROOT `package.json`'s `typecheck` script, **after `packages/frontend`** so build order is right:

```json
"typecheck": "tsc --build packages/core packages/frontend packages/node-files packages/canvas packages/cli packages/tui packages/gui packages/web"
```

**A package missing from that list is silently exempt from typechecking** — the same class of gap as a harness that is not in `npm test`. `workspaces: ["packages/*"]` picks the new package up for `build` automatically, which is exactly what hides the omission.

(c) In `packages/cli/src/main.ts`: delete the `nodeTransferFiles` definition and its comment, delete the now-unused `node:fs` imports **only if nothing else in the file uses them** (check: `grep -n "existsSync\|readFileSync\|writeFileSync\|appendFileSync" packages/cli/src/main.ts`), and import it instead:

```typescript
import { nodeTransferFiles } from '@tn3270/node-files';
```

(d) Add `@tn3270/node-files` to `packages/cli/package.json`'s dependencies.

- [ ] **Step 7: Install the new workspace, build, typecheck, test**

```bash
cd /home/a/athor/git/tn3270
npm install
npm run build && npm run typecheck
./node_modules/.bin/vitest run --reporter=basic 2>&1 | tail -5
```

Expected: build and typecheck silent; **1875 tests in 75 files** (1869 + 6 new). If the count is 1869, vitest is not picking the new package up — check `vitest.config.ts`'s include globs.

- [ ] **Step 8: Prove the typecheck wiring is real, not assumed**

This is the silent-failure step, so falsify it rather than trusting it:

```bash
cd /home/a/athor/git/tn3270
# Introduce a deliberate type error in the new package.
printf '\nexport const broken: number = "not a number";\n' >> packages/node-files/src/index.ts
npm run typecheck 2>&1 | tail -5
```

Expected: **a type error naming `packages/node-files/src/index.ts`.** If typecheck passes, step 6(b) did not take effect and the package is exempt. Then revert:

```bash
cd /home/a/athor/git/tn3270
git checkout packages/node-files/src/index.ts 2>/dev/null || sed -i '$ d' packages/node-files/src/index.ts
npm run typecheck
```

Expected: silent. (The `git checkout` only works if the file is already committed; the `sed` fallback drops the appended line. Verify the file ends at the `nodeTransferFiles` object either way.)

- [ ] **Step 9: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "feat(node-files): one home for TransferFiles over node:fs

$(printf '%s' 'A new package rather than a duplicate in the TUI, per the user 2026-09-22. It
holds exactly one thing, moved from cli/src/main.ts:132, and cli and tui both
depend on it. Deliberately NOT in frontend: the browser bundles must not acquire
a node:fs import, and stage 4 needs a different implementation of the same
interface.

Its test touches a real tmpdir, since the node:fs coupling is the whole reason
the package exists -- including that append CREATES a missing file and that
exists() is true for a DIRECTORY, which the Exist=keep check would otherwise
wave through into an unreadable EISDIR.

The typecheck wiring was FALSIFIED rather than assumed: the root package.json
names every package explicitly, so a new one is silently exempt until added.
Verified by introducing a type error and watching typecheck catch it.

Generated with AI

Co-Authored-By: SLAC AI')"
```

---

## Task 3: The `transferForm` action, its chord and its keypad key

**Files:**
- Modify: `packages/frontend/src/keymap.ts`, `packages/frontend/src/actions.ts`, `packages/frontend/src/bindings.ts`, `packages/frontend/src/keypad.ts`
- Test: `packages/frontend/test/actions.test.ts`, `packages/frontend/test/keypad.test.ts`, `packages/frontend/test/bindings.test.ts`

- [ ] **Step 1: Write the failing test for `applyAction`'s refusal**

Append to `packages/frontend/test/actions.test.ts`:

```typescript
it('THROWS on transferForm, because the front end owns its own dialog', () => {
  // The same contract as `quit` and `toggleKeypad`: a front end that forgot to own
  // its own display must fail LOUDLY rather than showing a dead button. `applyAction`'s
  // own caller swallows the throw into the OIA, so a silent return here would be a
  // button whose only effect is nothing at all.
  const session = makeSession();
  expect(() => applyAction(session, { kind: 'transferForm' }))
    .toThrow(/does not handle transferForm/);
});
```

Use whatever session helper the file already uses — read the top of `actions.test.ts` and match it; do not invent `makeSession` if it is called something else.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/frontend/test/actions.test.ts 2>&1 | tail -15
```

Expected: FAIL — a type error on `'transferForm'` not being in `Action`, or a thrown `satisfies never` mismatch.

- [ ] **Step 3: Add the union member**

In `packages/frontend/src/keymap.ts`, add to the `Action` union alongside `toggleKeypad`:

```typescript
  // OPENS A DIALOG, so like `toggleKeypad` and `quit` it is NOT dispatched by
  // `applyAction` -- see the throw there. A transfer needs arguments (a local path, a
  // direction, a host file name), which is what makes it the first action that cannot
  // be a keystroke: every other member of this union is complete in itself.
  | { kind: 'transferForm' }
```

- [ ] **Step 4: Add the throw**

In `packages/frontend/src/actions.ts`, beside the `toggleKeypad` guard:

```typescript
  if (action.kind === 'transferForm') {
    throw new Error('applyAction does not handle transferForm: the front end owns its own dialog');
  }
```

- [ ] **Step 5: Run the test**

```bash
cd /home/a/athor/git/tn3270
npm run build && ./node_modules/.bin/vitest run packages/frontend 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 6: Add the keypad key and the chord**

In `packages/frontend/src/keypad.ts`, add to `KEYPAD_KEYS` after the `NewLn` entry:

```typescript
  { label: 'Xfer', action: { kind: 'transferForm' }, row: 4, col: 48, name: 'File Transfer' },
```

**Column 48 is worked out, not guessed.** `KEYPAD_KEY_WIDTH` is 6, and row 4 is occupied at 0, 6, 12, 24, 30, 36 and 42 (`ErEOF`, `ErInp`, `Tab`, `BkTab`, `Del`, `BkSp`, `NewLn`). `NewLn` ends at 48, so 48 is the next free left edge and the right edge becomes 54 — inside the 72 the layout budgets, so **the Electron window does not resize and only the keypad golden moves**, which is the same outcome adding `NewLn` had.

**The gap at column 18 is NOT free space** — it separates the `Tab`/`BkTab` clusters deliberately. Do not fill it.

**The keypad key is what gives stage 3 the GUI button for free**: the GUI writes a renderer and the button is already in the table.

**NOTE: this contradicts `KeypadKey`'s own doc comment**, which says the action is "never `quit` or `toggleKeypad`" because `applyAction` throws on both. `transferForm` also throws. Check `packages/frontend/test/keypad.test.ts` for a test pinning that rule — if one exists, it will redden, and the right fix is to update the rule to "never an action no front end owns", not to remove the key. Read the test and decide; report what you found.

In `packages/frontend/src/bindings.ts`, add:

```typescript
  { key: 'Ctrl-T', action: { kind: 'transferForm' }, note: 'open the file-transfer form' },
```

Match the existing entries' exact field names and note style. **`Ctrl-T` (`0x14`) is free**: unbound in both halves of `Common/fb-c3270` (c3270 binds no transfer key at all), and absent from our keymap, whose taken control bytes are `01 03 04 06 0b 12 15 1d 7f`.

- [ ] **Step 7: Build and run the whole frontend suite**

```bash
cd /home/a/athor/git/tn3270
npm run build && npm run typecheck && ./node_modules/.bin/vitest run packages/frontend 2>&1 | tail -12
```

Expected: PASS. If `keypad.test.ts` reddens on the label width (labels are "at most 5 characters") check `Xfer` is 4 — it is. If it reddens on the action rule, see step 6's note.

- [ ] **Step 8: Verify the TUI keypad overlay picks the chord up with NO edit to the overlay**

This is the property the `BINDING_INTENT` indirection buys, and it was measured rather than assumed for `Ctrl-D`/`Ctrl-F`:

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/tui 2>&1 | tail -10
```

Expected: PASS, and the overlay now has a 48th row showing `File Transfer` / `Ctrl-T`. If a TUI test pins the row count at 47, update it to 48 — that is a real count change, not a rot.

- [ ] **Step 9: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "feat(frontend): a transferForm action, Ctrl-T, and a keypad key

$(printf '%s' 'The first Action that cannot be a keystroke: a transfer needs a local path, a
direction and a host file name, so it opens a dialog. applyAction THROWS on it,
exactly as it does on quit and toggleKeypad, so a front end that forgot to own
its own dialog fails loudly instead of showing a dead button.

Ctrl-T (0x14) is verified free: unbound in BOTH halves of Common/fb-c3270 --
c3270 binds no transfer key at all, so there is no reference spelling to match --
and absent from our keymap, whose taken control bytes are 01 03 04 06 0b 12 15
1d 7f.

The keypad key is what makes stage 3 cheap: the GUI writes a renderer and the
button is already in the table. The TUI overlay picked the chord up with no edit
to that file, which is the property BINDING_INTENT exists for.

Generated with AI

Co-Authored-By: SLAC AI')"
```

---

### AS BUILT, Task 3 — four consequences outside `frontend` that this plan MISSED

All four were found by running the full suite rather than the per-package ones. **Per-package runs
are not a gate on this repo**: `vitest run packages/frontend` and `packages/tui` were both green
while four tests in `canvas` and `web` were red.

1. **A REMOTELY-TRIGGERABLE GATEWAY KILL.** `web/src/main.ts` calls `applyAction` outside any try
   inside a socket `data` handler, where a throw ends the process and every operator's session. The
   keypad button makes it reachable from a click. Closed by a **rejection in `protocol.ts`**, the
   first of its documented two branches, because a browser must not have the action at all yet —
   stage 4 must settle whose filesystem a browser transfer writes to. Mutation-verified.
   `integration.test.ts`'s `REFUSED` list gained a member and its comment records how to remove it.
2. **`bindings.test.ts` caught the intent declared without the byte bound** — `BINDING_INTENT` had
   `Ctrl-T` while `keymap.ts`'s table did not. Add both.
3. **`canvas/test/keys.test.ts` has a `TERMINAL_ONLY` record requiring a written reason** for any
   `BINDING_INTENT` key the canvas mapper cannot express. `Ctrl-T` is a genuine exemption until
   stage 3; the entry must name the condition for its own deletion.
4. **Keypad geometry: 48 keys is 240 cells, and cell 48 stopped being a gutter.** Two tests in
   `canvas/test/keypad.test.ts`. The blank-column assertion is the only one anywhere that a keypad
   column is EMPTY and has now caught this twice.

**And one rule needed rewriting rather than working around:** `keypad.test.ts`'s "never carries an
action a front end must intercept" became false, since `transferForm` throws *and* is a legitimate
key. The real rule is whether a *button* makes sense.

**`actions.test.ts` also requires three edits, not one:** the refusal test, a dispatch-table row, and
the exact `ROWS.length` count (25 → 26). Its exhaustiveness test compares the table against a
runtime scan of the union's declaration, so a member without a row fails by design.

---

## Task 4: The form model — fields, defaults, cycle order

**Files:**
- Create: `packages/frontend/src/transferForm.ts`, `packages/frontend/test/transferForm.test.ts`
- Modify: `packages/frontend/src/index.ts`

The model is PURE: a total function of its arguments, holding no state and touching no terminal. Same split as the keypad — `frontend` owns the data, the TUI renders it.

- [ ] **Step 1: Write the failing test for the field table and defaults**

Create `packages/frontend/test/transferForm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  TRANSFER_FIELDS, newTransferForm, cycleField, setFieldText, applicable,
  type TransferFormState,
} from '../src/transferForm.js';

describe('TRANSFER_FIELDS', () => {
  it('lists the ten fields in tab order', () => {
    expect(TRANSFER_FIELDS.map((f) => f.id)).toEqual([
      'direction', 'host', 'localFile', 'hostFile', 'mode',
      'exist', 'cr', 'recfm', 'lrecl', 'blksize',
    ]);
  });

  it('gives every field a label no wider than the widest, so a column can be computed', () => {
    for (const f of TRANSFER_FIELDS) expect(f.label.length).toBeGreaterThan(0);
  });
});

describe('newTransferForm', () => {
  it('starts at receive, tso, binary, keep, with Cr and Recfm UNSET', () => {
    const s = newTransferForm();
    expect(s.values.direction).toBe('receive');
    expect(s.values.host).toBe('tso');
    expect(s.values.mode).toBe('binary');
    expect(s.values.exist).toBe('keep');
    // UNSET is a distinct intention from any value: it emits no keyword at all and
    // lets the host choose, which is the CLI behaviour that works on both hosts.
    expect(s.values.cr).toBe('');
    expect(s.values.recfm).toBe('');
    expect(s.values.localFile).toBe('');
    expect(s.values.hostFile).toBe('');
    expect(s.values.lrecl).toBe('');
    expect(s.values.blksize).toBe('');
  });

  it('starts with the first field selected and no error', () => {
    const s = newTransferForm();
    expect(s.selected).toBe(0);
    expect(s.error).toBeUndefined();
  });
});

describe('cycleField', () => {
  it('cycles direction both ways and WRAPS', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    expect(s.values.direction).toBe('send');
    s = cycleField(s, 'direction', 1);
    expect(s.values.direction).toBe('receive');   // wrapped
    s = cycleField(s, 'direction', -1);
    expect(s.values.direction).toBe('send');      // wraps backwards too
  });

  it('cycles Recfm through THREE states, unset included', () => {
    // Not an F/V toggle: unset emits no RECFM and lets the host choose, which is a
    // different wire command from RECFM V. Starting at unset preserves "I did not ask
    // for record attributes" as an intention.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);          // Recfm applies only on a send
    const seen: string[] = [s.values.recfm];
    for (let i = 0; i < 3; i++) { s = cycleField(s, 'recfm', 1); seen.push(s.values.recfm); }
    expect(seen).toEqual(['', 'fixed', 'variable', 'undefined']);
    s = cycleField(s, 'recfm', 1);
    expect(s.values.recfm).toBe('');            // wrapped back to unset
  });

  it("omits Recfm's U when Host is vm, because CMS has only fixed and variable", () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'host', 1);
    expect(s.values.host).toBe('vm');
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) { s = cycleField(s, 'recfm', 1); seen.push(s.values.recfm); }
    expect(seen).toEqual(['fixed', 'variable', '']);   // no 'undefined'
  });

  it('is a no-op on a text field', () => {
    const s = newTransferForm();
    expect(cycleField(s, 'localFile', 1).values.localFile).toBe('');
  });
});

describe('setFieldText', () => {
  it('appends to a text field', () => {
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', 'a.bin');
    expect(s.values.localFile).toBe('a.bin');
  });

  it('is a no-op on a cycle field', () => {
    // Typing into a cycle field must not invent a value the validator has never seen:
    // the form collects strings but it does not get to make them up.
    const s = newTransferForm();
    expect(setFieldText(s, 'direction', 'sideways').values.direction).toBe('receive');
  });

  it('accepts only digits in a numeric field', () => {
    let s = newTransferForm();
    s = setFieldText(s, 'lrecl', '80');
    expect(s.values.lrecl).toBe('80');
    s = setFieldText(s, 'lrecl', '80x');
    expect(s.values.lrecl).toBe('80');   // the x is refused, not appended
  });

  it('allows Lrecl up to five digits, because TSO datasets reach 32760', () => {
    // 5 wide, not 3: positiveInt has no upper bound and a narrow field would
    // silently prevent valid transfers.
    let s = newTransferForm();
    s = setFieldText(s, 'lrecl', '32760');
    expect(s.values.lrecl).toBe('32760');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/frontend/test/transferForm.test.ts 2>&1 | tail -10
```

Expected: FAIL — cannot resolve `../src/transferForm.js`.

- [ ] **Step 3: Write `packages/frontend/src/transferForm.ts`**

```typescript
/**
 * The file-transfer form's MODEL: fields, values, cycle order and applicability.
 *
 * PURE, and the same split as the keypad: `frontend/src/keypad.ts` owns the button table
 * while `tui/src/keypadOverlay.ts` renders it. Here the model is the data and
 * `tui/src/transferOverlay.ts` draws it, which is what makes stage 3 (the GUI) cheap --
 * it writes a renderer and reuses all of this.
 *
 * ## THE CENTRAL RULE: THIS FORM NEVER VALIDATES
 *
 * It collects STRINGS and hands them to `parseTransferKeywords`. The applicability rules
 * below are ERGONOMICS -- they stop a user entering a doomed combination -- but authority
 * lives in exactly one place. If these rules and the validator's ever disagree, THE
 * VALIDATOR WINS and the user sees its message. That is what keeps the TUI and the CLI
 * from drifting on what is legal, and it means this form cannot invent a legal-looking
 * combination the engine rejects.
 *
 * ## WHY UNSET IS A VALUE
 *
 * `Cr` and `Recfm` start at `''`, and that is not the same as any of their values: an
 * unset `Recfm` emits no `RECFM` keyword at all and lets the host choose, which is the
 * current CLI behaviour that works on both hosts. A two-state F/V toggle would make "I did
 * not ask for record attributes" unexpressible.
 */

import type { FtHostType } from './transfer.js';

/** Which field. The ids are the tab order. */
export type TransferFieldId =
  | 'direction' | 'host' | 'localFile' | 'hostFile' | 'mode'
  | 'exist' | 'cr' | 'recfm' | 'lrecl' | 'blksize';

/** How a field takes input. `cycle` uses left/right; the others take printables. */
export type TransferFieldKind = 'cycle' | 'text' | 'numeric';

export interface TransferField {
  readonly id: TransferFieldId;
  readonly label: string;
  readonly kind: TransferFieldKind;
  /**
   * For a cycle field, the values in cycle order, `''` included where unset is legal.
   * Empty for text and numeric fields.
   *
   * `recfm`'s list here is the TSO one; `cycleField` drops `undefined` for VM. That
   * asymmetry lives in the cycle function rather than in two tables, so the VM rule has
   * one home.
   */
  readonly values: readonly string[];
  /** Visible width for a text or numeric field. */
  readonly width: number;
}

/**
 * The fields in tab order.
 *
 * `lrecl` is 5 WIDE, NOT 3: `positiveInt` has no upper bound and TSO datasets
 * legitimately reach 32760, so a narrow field would silently prevent valid transfers.
 */
export const TRANSFER_FIELDS: readonly TransferField[] = [
  { id: 'direction', label: 'Direction', kind: 'cycle', values: ['receive', 'send'], width: 0 },
  { id: 'host', label: 'Host', kind: 'cycle', values: ['tso', 'vm'], width: 0 },
  { id: 'localFile', label: 'Local file', kind: 'text', values: [], width: 40 },
  { id: 'hostFile', label: 'Host file', kind: 'text', values: [], width: 40 },
  { id: 'mode', label: 'Mode', kind: 'cycle', values: ['binary', 'ascii'], width: 0 },
  { id: 'exist', label: 'Exist', kind: 'cycle', values: ['keep', 'replace', 'append'], width: 0 },
  { id: 'cr', label: 'Cr', kind: 'cycle', values: ['', 'auto', 'remove', 'add', 'keep'], width: 0 },
  { id: 'recfm', label: 'Recfm', kind: 'cycle', values: ['', 'fixed', 'variable', 'undefined'], width: 0 },
  { id: 'lrecl', label: 'Lrecl', kind: 'numeric', values: [], width: 5 },
  { id: 'blksize', label: 'Blksize', kind: 'numeric', values: [], width: 5 },
];

const FIELD_BY_ID = new Map(TRANSFER_FIELDS.map((f) => [f.id, f]));

/** Every field's current string. `''` means unset, for every kind. */
export type TransferValues = Record<TransferFieldId, string>;

export interface TransferFormState {
  readonly values: TransferValues;
  /** Index into `TRANSFER_FIELDS`. */
  readonly selected: number;
  /** The validator's message, when a submit was refused. Cleared on the next edit. */
  readonly error?: string;
}

export function newTransferForm(): TransferFormState {
  return {
    values: {
      direction: 'receive', host: 'tso', localFile: '', hostFile: '',
      mode: 'binary', exist: 'keep', cr: '', recfm: '', lrecl: '', blksize: '',
    },
    selected: 0,
  };
}

/**
 * The values a cycle field offers, given the rest of the form.
 *
 * The ONE state-dependent case is `recfm` on VM: `transfer.ts` records that "CMS supports
 * fixed and variable", so `undefined` is not offered there. Kept here rather than as a
 * second table so the rule has one home.
 */
function valuesFor(id: TransferFieldId, values: TransferValues): readonly string[] {
  const field = FIELD_BY_ID.get(id);
  if (field === undefined) return [];
  if (id === 'recfm' && values.host === 'vm') {
    return field.values.filter((v) => v !== 'undefined');
  }
  return field.values;
}

/**
 * Move a cycle field by `delta`, wrapping, and clear anything the move made inapplicable.
 *
 * A no-op on a text or numeric field, so a caller may route left/right unconditionally.
 */
export function cycleField(
  state: TransferFormState, id: TransferFieldId, delta: number,
): TransferFormState {
  const field = FIELD_BY_ID.get(id);
  if (field === undefined || field.kind !== 'cycle') return state;
  const options = valuesFor(id, state.values);
  const at = options.indexOf(state.values[id]);
  // A value the current options no longer contain (Recfm=U when Host flipped to vm)
  // reads as index -1, and `(-1 + 1) % n` is 0 -- so it lands on the first option
  // rather than throwing. That is the same repair `clearInapplicable` performs.
  const next = options[(((at + delta) % options.length) + options.length) % options.length];
  return clearInapplicable({
    ...state,
    values: { ...state.values, [id]: next ?? '' },
    error: undefined,
  });
}

/** Replace a text or numeric field's contents. A no-op on a cycle field. */
export function setFieldText(
  state: TransferFormState, id: TransferFieldId, text: string,
): TransferFormState {
  const field = FIELD_BY_ID.get(id);
  if (field === undefined || field.kind === 'cycle') return state;
  // A numeric field takes digits only. Refusing the character is better than accepting it
  // and failing at submit: the validator's `positiveInt` would reject it, but the user
  // would not find out until they pressed Enter.
  if (field.kind === 'numeric' && !/^[0-9]*$/.test(text)) return state;
  if (text.length > field.width && field.kind === 'numeric') return state;
  return { ...state, values: { ...state.values, [id]: text }, error: undefined };
}

/**
 * Is this field meaningful, given the rest of the form?
 *
 * All five rules are derived from the validator's own behaviour, cited where they come
 * from. An inapplicable field is not drawn and cannot be selected.
 */
export function applicable(id: TransferFieldId, values: TransferValues): boolean {
  switch (id) {
    // On a receive the dataset already exists, and x3270 silently drops these
    // (`ft.c:702`). Silently dropping is exactly what a form should make visible.
    case 'recfm':
      return values.direction === 'send';
    // `Lrecl=80` with no `Recfm` "emits nothing at all" (`ft.c:704,721-726`), so the
    // field would be a lie while Recfm is unset.
    case 'lrecl':
      return values.direction === 'send' && values.recfm !== '';
    // CMS files have no block size.
    case 'blksize':
      return values.direction === 'send' && values.recfm !== '' && values.host !== 'vm';
    // Carriage-return translation is meaningless on a binary transfer.
    case 'cr':
      return values.mode === 'ascii';
    default:
      return true;
  }
}

/**
 * Clear every value a state change has made inapplicable.
 *
 * INAPPLICABLE VALUES ARE CLEARED, NOT RETAINED INVISIBLY. A hidden value that breaks a
 * later submit is the worse failure: the user cannot see the field, cannot edit it, and
 * gets a validator error naming a keyword they never typed.
 */
function clearInapplicable(state: TransferFormState): TransferFormState {
  const values = { ...state.values };
  for (const f of TRANSFER_FIELDS) {
    if (!applicable(f.id, values) && values[f.id] !== '') {
      // Cycle fields whose unset value is not `''` (direction, host, mode, exist) are
      // never inapplicable, so this only ever clears an optional field.
      values[f.id] = '';
    }
  }
  // Recfm=U surviving a flip to Host=vm is the other repair: the value stays legal for
  // TSO, so `applicable` does not catch it, but the VM dialect cannot express it.
  if (values.host === 'vm' && values.recfm === 'undefined') values.recfm = '';
  return { ...state, values };
}

/**
 * The form as `Transfer()` keywords, ready for `parseTransferKeywords`.
 *
 * Only applicable, non-empty fields are emitted, so an unset `Recfm` contributes nothing
 * and the host chooses -- which is the whole reason unset is a distinct state.
 */
export function formKeywords(state: TransferFormState): string[] {
  const out: string[] = [];
  const keyword: Partial<Record<TransferFieldId, string>> = {
    direction: 'Direction', host: 'Host', localFile: 'LocalFile', hostFile: 'HostFile',
    mode: 'Mode', exist: 'Exist', cr: 'Cr', recfm: 'Recfm',
    lrecl: 'Lrecl', blksize: 'Blksize',
  };
  for (const f of TRANSFER_FIELDS) {
    const value = state.values[f.id];
    if (value === '' || !applicable(f.id, state.values)) continue;
    out.push(`${keyword[f.id]}=${value}`);
  }
  return out;
}

/** The next selectable field index in `delta`'s direction, skipping inapplicable ones. */
export function moveField(state: TransferFormState, delta: number): TransferFormState {
  const n = TRANSFER_FIELDS.length;
  let at = state.selected;
  for (let i = 0; i < n; i++) {
    at = (((at + delta) % n) + n) % n;
    const field = TRANSFER_FIELDS[at];
    if (field !== undefined && applicable(field.id, state.values)) {
      return { ...state, selected: at };
    }
  }
  return state;
}
```

**The keyword map above is verified against the validator, so do not re-derive it — but do check these four facts still hold**, because they are what make it correct:

1. **Keywords are case-folded** (`const lower = keyword.toLowerCase()`), so `LocalFile=` and `localfile=` are the same keyword. The map's casing is cosmetic.
2. **`Recfm`'s accepted values are `default|fixed|variable|undefined`.** The form offers the last three plus unset; `default` is x3270's spelling for "unspecified" and the form expresses that as absence instead, which is the same thing — `parseTransferKeywords` maps `default` to `undefined`.
3. **A repeated keyword THROWS** rather than last-wins, so `formKeywords` must emit each field at most once. It iterates `TRANSFER_FIELDS`, which has unique ids, so it does.
4. **The validator REJECTS three combinations x3270 silently drops** — the DCB group on a receive, `Lrecl`/`Blksize` without `Recfm`, and `Blksize` or `Recfm=undefined` on VM. **`applicable` covers all three**, which is why `formKeywords` filters by it rather than emitting everything non-empty. That correspondence is the point of the "produces keywords the validator accepts" test: if a rule drifts, that test reddens rather than a user meeting the error.

- [ ] **Step 4: Run the tests**

```bash
cd /home/a/athor/git/tn3270
npm run build && ./node_modules/.bin/vitest run packages/frontend/test/transferForm.test.ts 2>&1 | tail -10
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Add the applicability tests, one per rule**

Append to `packages/frontend/test/transferForm.test.ts`:

```typescript
describe('applicable', () => {
  const v = (over: Partial<TransferFormState['values']> = {}) =>
    ({ ...newTransferForm().values, ...over });

  it('hides Recfm on a receive, because the dataset already exists', () => {
    expect(applicable('recfm', v({ direction: 'receive' }))).toBe(false);
    expect(applicable('recfm', v({ direction: 'send' }))).toBe(true);
  });

  it('disables Lrecl while Recfm is unset, because it would emit nothing', () => {
    expect(applicable('lrecl', v({ direction: 'send', recfm: '' }))).toBe(false);
    expect(applicable('lrecl', v({ direction: 'send', recfm: 'fixed' }))).toBe(true);
  });

  it('KEEPS Lrecl for Recfm=V, because TSO honours it as the MAXIMUM record length', () => {
    // MEASURED LIVE ON BOTH HOSTS 2026-09-22, and they disagree. TSO: `RECFM V LRECL 80`
    // stored VB 80 against VB 255 without it. VM/CMS: both V cases stored V 80, so CMS
    // ignores it -- but disabling the field would make a real TSO attribute unexpressible
    // to satisfy a VM quirk. x3270 agrees: both its branches gate LRECL on
    // `recfm != DEFAULT_RECFM` only, with no V check (ft.c:721-726, ft.c:763-766).
    expect(applicable('lrecl', v({ direction: 'send', recfm: 'variable' }))).toBe(true);
  });

  it('hides Blksize on VM, because CMS files have no block size', () => {
    expect(applicable('blksize', v({ direction: 'send', recfm: 'fixed', host: 'vm' }))).toBe(false);
    expect(applicable('blksize', v({ direction: 'send', recfm: 'fixed', host: 'tso' }))).toBe(true);
  });

  it('hides Cr unless the mode is ascii', () => {
    expect(applicable('cr', v({ mode: 'binary' }))).toBe(false);
    expect(applicable('cr', v({ mode: 'ascii' }))).toBe(true);
  });
});

describe('clearing on transition', () => {
  it('CLEARS Lrecl when Recfm returns to unset, rather than retaining it invisibly', () => {
    // A hidden value that breaks a later submit is the worse failure: the user cannot see
    // the field and gets an error naming a keyword they never typed.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);         // send
    s = cycleField(s, 'recfm', 1);             // fixed
    s = setFieldText(s, 'lrecl', '80');
    expect(s.values.lrecl).toBe('80');
    s = cycleField(s, 'recfm', -1);            // back to unset
    expect(s.values.lrecl).toBe('');
  });

  it('CLEARS Blksize when Host flips to vm', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'recfm', 1);
    s = setFieldText(s, 'blksize', '6160');
    s = cycleField(s, 'host', 1);              // vm
    expect(s.values.blksize).toBe('');
  });

  it('REPAIRS Recfm=U when Host flips to vm, since CMS cannot express it', () => {
    // `applicable` does not catch this -- U stays legal for a send -- so it is a separate
    // repair. Without it the form would submit `Recfm=undefined` to the VM dialect.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = cycleField(s, 'recfm', 3);             // undefined
    expect(s.values.recfm).toBe('undefined');
    s = cycleField(s, 'host', 1);
    expect(s.values.recfm).toBe('');
  });

  it('CLEARS Cr when the mode returns to binary', () => {
    let s = newTransferForm();
    s = cycleField(s, 'mode', 1);              // ascii
    s = cycleField(s, 'cr', 1);                // auto
    expect(s.values.cr).toBe('auto');
    s = cycleField(s, 'mode', 1);              // binary
    expect(s.values.cr).toBe('');
  });
});

describe('formKeywords', () => {
  it('emits nothing for an unset optional field, so the host chooses', () => {
    const s = newTransferForm();
    const kw = formKeywords(s);
    expect(kw.join(' ')).not.toMatch(/Recfm|Lrecl|Blksize|Cr=/);
  });

  it('produces keywords the validator accepts', () => {
    // The CENTRAL RULE in one assertion: whatever this form emits, the one authority on
    // what is legal must accept. If these ever disagree the validator wins.
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', '/tmp/a.bin');
    s = setFieldText(s, 'hostFile', 'A.BIN');
    expect(() => parseTransferKeywords(formKeywords(s))).not.toThrow();
  });

  it('produces a valid send with record attributes', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    s = setFieldText(s, 'localFile', '/tmp/a.bin');
    s = setFieldText(s, 'hostFile', 'A.BIN');
    s = cycleField(s, 'recfm', 1);
    s = setFieldText(s, 'lrecl', '80');
    const { request, command } = transferCommand(formKeywords(s));
    expect(request.direction).toBe('send');
    expect(request.recfm).toBe('fixed');
    expect(request.lrecl).toBe(80);
    expect(command).toContain('IND$FILE PUT');
  });
});
```

Add `parseTransferKeywords` and `transferCommand` to the file's imports, from `'../src/transfer.js'`.

- [ ] **Step 6: Run and fix**

```bash
cd /home/a/athor/git/tn3270
npm run build && ./node_modules/.bin/vitest run packages/frontend/test/transferForm.test.ts 2>&1 | tail -20
```

Expected: PASS. The last three are the ones most likely to fail — they cross into the real validator, which is the point. If `formKeywords` produces a spelling `parseTransferKeywords` refuses, **the validator is right**; fix the map.

- [ ] **Step 7: Mutation-check each applicability rule independently**

Each of the five must be independently falsifiable: breaking one should redden exactly one test. A rule that passes vacuously is worse than a missing one, because it certifies.

For each of the five cases in `applicable`, in turn: change its `return` to `return true`, run `./node_modules/.bin/vitest run packages/frontend/test/transferForm.test.ts`, record which tests redden, and revert. **Write the five results into the commit message.** If any mutation leaves the suite green, that rule has no test and you must add one.

- [ ] **Step 8: Export from `frontend/src/index.ts`**

```typescript
// The transfer form's model. Pure data and pure functions, so the TUI and (stage 3) the
// GUI render the same form without a second field table to drift.
export {
  TRANSFER_FIELDS, newTransferForm, cycleField, setFieldText,
  applicable, formKeywords, moveField,
} from './transferForm.js';
export type {
  TransferFieldId, TransferFieldKind, TransferField, TransferValues, TransferFormState,
} from './transferForm.js';
```

- [ ] **Step 9: Build, typecheck, full suite, commit**

```bash
cd /home/a/athor/git/tn3270
npm run build && npm run typecheck && ./node_modules/.bin/vitest run --reporter=basic 2>&1 | tail -5
git add -A
git commit -m "feat(frontend): the transfer form's model, pure and validator-deferring

$(printf '%s' 'Fields, defaults, cycle order and applicability -- no rendering, no state. Same
split as the keypad: frontend owns the data, the front end draws it, which is
what makes stage 3 a renderer rather than a rewrite.

THE FORM NEVER VALIDATES. It collects strings and hands them to
parseTransferKeywords; the applicability rules are ergonomics only, and if the
two ever disagree the validator wins. A test asserts that whatever the form
emits, the validator accepts.

Recfm is a THREE-state cycle because unset emits no keyword and lets the host
choose -- a different wire command from RECFM V. Lrecl is 5 wide, not 3: TSO
datasets reach 32760. Lrecl STAYS enabled for Recfm=V, which was measured on
both hosts rather than reasoned about: TSO honours it as the maximum record
length (VB 80 against VB 255), VM ignores it, and disabling it would make a real
TSO attribute unexpressible to satisfy a VM quirk.

Inapplicable values are CLEARED on transition, not retained invisibly -- a
hidden value that breaks a later submit names a keyword the user never typed.
Recfm=U needs a SEPARATE repair when Host flips to vm, because it stays legal
for a send and applicable() does not catch it.

All five applicability rules mutation-checked independently:
[REPLACE THIS LINE with your five measured results from step 7 -- one line per
rule, naming which test reddened. Do not write "all five verified": the value is
in which test caught which rule, and a summary cannot be checked later.]

Generated with AI

Co-Authored-By: SLAC AI')"
```

### AS BUILT, Task 4 — four defects in this plan's own code, each falsified before fixing

Gate after: build/typecheck clean, **1903 tests in 76 files** (from 1877/75). Commit `ea8ee15`.

1. **`clearInapplicable` NEEDED A FIXED-POINT LOOP.** The rules CHAIN and the single pass above
   is wrong. Measured: single-pass reddens the new "CASCADES the VM repair too" test, because
   the `Recfm=U` repair ran *after* the loop and so could never cascade to the `Lrecl` it had
   licensed — the form would have submitted `Lrecl=80` with no `Recfm` and met the validator's
   *"Lrecl and Blksize need Recfm as well"*. The sibling receive cascade passes single-pass only
   **by luck of table order** (`recfm` at index 7 is cleared before `lrecl` at 8 is tested);
   reorder `TRANSFER_FIELDS` and it breaks. Both cascade tests are new; nothing else covers
   rule chaining.
2. **`error?: string` DOES NOT TYPECHECK** against this plan's own `error: undefined` writes under
   `exactOptionalPropertyTypes` — 2 errors, at the plan's own lines. It must be
   `error?: string | undefined`. **Task 7 needs this too**, at `app.ts`'s
   `{ ...this.transferState, error: run.error }`, where `run.error` is `string | undefined`.
3. **The keyword map must be a TOTAL `Record`, not `Partial<Record<>>`.** Measured: with `Partial`,
   dropping `direction` from the map **compiles cleanly** and emits the keyword `undefined=receive`
   at runtime; with `Record` it is TS2741 at build. The validator cannot save us here — it never
   sees a field name it recognises.
4. **The plan's `import type { FtHostType }` is unused** and was dropped. The module refers to no
   type from `transfer.ts`.

**And a counting correction for step 7: `applicable` has FOUR cases, not five.** The fifth rule is
the separate `Recfm=U`-on-VM repair inside `clearInapplicable`, which is what the fifth mutation
check must target (delete it outright; 2 tests redden).

**Measured mutation matrix** — each `return true`, build, run, revert:

| rule | tests reddened |
|---|---|
| `recfm` | 2 — "hides Recfm on a receive", the receive cascade |
| `lrecl` | 4 — "disables Lrecl while Recfm is unset", "CLEARS Lrecl when Recfm returns to unset", both cascades |
| `blksize` | 3 — "hides Blksize on VM", "CLEARS Blksize when Host flips to vm", the receive cascade |
| `cr` | 2 — "hides Cr unless the mode is ascii", "CLEARS Cr when the mode returns to binary" |
| VM repair (deleted) | 2 — "REPAIRS Recfm=U when Host flips to vm", the VM cascade |

No rule passed vacuously.

---

## Task 5: `CutTransfer.cancel` — a public method, not a visibility change

**Files:**
- Modify: `packages/core/src/ft/transfer.ts`
- Test: `packages/core/test/ft/transfer.test.ts` (check the actual path first)

**THE SPEC UNDERSTATES THIS ONE.** It says `abort` "exists and already sends the right thing but is `private` — expose it." That is not sufficient: `private abort(screen, status, error)` is the *internal error path*, reached from ten call sites that each already hold a `CutFrameError` status and message. A user cancellation has neither, and dropping the `private` would put an internal signature with two arguments the caller cannot sensibly supply into the public API. So this task adds a **wrapper** that picks the status and the message.

- [ ] **Step 1: Read the existing helpers you will reuse**

The test file is `packages/core/test/ft/transfer.test.ts`. It already has `cutScreen()` at `:65` — a 24x80 `Screen` with the CUT structured field in place — plus `controlCodeScreen`, `dataScreen` and friends. **Use `cutScreen()`; do not build a screen by hand.**

```bash
cd /home/a/athor/git/tn3270
sed -n '60,95p' packages/core/test/ft/transfer.test.ts
grep -n "RO_FRAME_TYPE\|RO_REASON_CODE\|ResponseFrameType" packages/core/test/ft/transfer.test.ts | head -5
```

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/ft/transfer.test.ts`:

```typescript
describe('cancel, the operator-initiated abort', () => {
  it('writes an abort response and returns PF2, so the host leaves transfer mode', () => {
    // A user closing the form mid-transfer must ABORT rather than abandon, or the host
    // program is left waiting for a CUT frame that will never come -- and the operator's
    // next keystroke then goes into a host that is not listening for it.
    const transfer = new CutTransfer({ direction: 'receive' });
    const screen = cutScreen();
    const step = transfer.cancel(screen);
    expect(step.ack).toBe(AckAid.ABORT);          // PF2: an abort WE initiate
    expect(step.done?.ok).toBe(false);
    expect(step.done?.status).toBe(StatusCode.ABORT_XMIT);
  });

  it('writes the response into the RESPONSE AREA, where the host reads it', () => {
    // The status must actually reach the buffer, not merely be reported in the step: the
    // host learns of the abort from these cells and from nothing else.
    const transfer = new CutTransfer({ direction: 'receive' });
    const screen = cutScreen();
    transfer.cancel(screen);
    expect(screen.cellAt(RO_FRAME_TYPE).ebcdic)
      .toBe(cp037.encode(ResponseFrameType.CONTROL_CODE)[0]);
    expect(screen.cellAt(RO_REASON_CODE).ebcdic).not.toBe(0);
  });

  it('is IDEMPOTENT: a second cancel sends no second AID', () => {
    // A form closing as a transfer completes must not put a second PF2 on the wire: the
    // host has already left transfer mode and would read it as input into whatever panel
    // it painted next.
    const transfer = new CutTransfer({ direction: 'receive' });
    const screen = cutScreen();
    transfer.cancel(screen);
    const again = transfer.cancel(screen);
    expect(again.ack).toBeUndefined();
    expect(again.done).toBeUndefined();
  });

  it('cancelling after a NORMAL completion is also inert', () => {
    // The same guard from the other side: the transfer ended on its own and the form is
    // only now being closed.
    const transfer = new CutTransfer({ direction: 'receive' });
    // Drive it to completion the way this file's other tests do -- an EOF data frame.
    transfer.step(eofDataScreen(0));
    const after = transfer.cancel(cutScreen());
    expect(after.ack).toBeUndefined();
  });
});
```

**The second test's exact assertion depends on how `writeResponse` encodes the frame type** — read `writeResponse` in `frames.ts` and the existing response-area assertions in this file, and match them. If the file already has a helper for reading the response area, use it. The claim to pin is "the status reached the buffer", not any particular spelling.

**The fourth test assumes `eofDataScreen(0)` completes a receive.** Check against the file's existing EOF test: if a receive needs a data frame first, add it. If completion takes more steps than is convenient, drop this test and say so — the third one already pins idempotence.

- [ ] **Step 3: Run it to verify it fails**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/core/test/ft 2>&1 | tail -15
```

Expected: FAIL — `cancel` is not a function.

- [ ] **Step 4: Implement `cancel`**

In `packages/core/src/ft/transfer.ts`, beside `abort`, add a public method. `abort` itself stays `private`:

```typescript
  /**
   * Cancel at the operator's request: abort the transfer and tell the host.
   *
   * ## WHY THIS WRAPS `abort` RATHER THAN `abort` BEING MADE PUBLIC
   *
   * `abort` is the INTERNAL error path. Its ten callers each already hold a
   * `CutFrameError`'s status and message, so its signature takes both -- and an
   * operator cancelling has neither. Exposing `abort` would put two arguments in the
   * public API that no caller outside this file can sensibly supply, and the natural
   * wrong guess (status 0, an empty message) is one the host would read as a protocol
   * fault rather than a cancellation.
   *
   * `SC_ABORT_XMIT` is the status x3270 uses for a client-side abort, and `AckAid.ABORT`
   * (PF2) is the AID: `run_action(AnPF, IA_FT, "2", NULL)` (ft_cut.c:674). Note the
   * asymmetry recorded at the top of this file -- a HOST-initiated abort is acknowledged
   * with Enter, not PF2; PF2 is only for an abort WE initiate, which is exactly this.
   *
   * IDEMPOTENT. A closed form racing a completing transfer must not put a second PF2 on
   * the wire: the host has already left transfer mode and would read it as input into
   * whatever panel it painted next.
   */
  cancel(screen: Screen): TransferStep {
    if (this.finished) return {};
    return this.abort(screen, StatusCode.ABORT_XMIT, MSG.CANCELLED);
  }
```

**Three things to check against the real file rather than trusting the sketch:**

1. **Is there a `finished` flag?** `finish()` exists (`abort` returns `this.finish(...)`), so some completion state is tracked. Find what it is called and test that. If there is none, add one — `private finished = false;` set in `finish()` — and say so in the commit.
2. **`MSG.CANCELLED` may not exist.** Check the `MSG` table. x3270's own string is `ftUserCancel`/`ftCutUserCancel` — grep `fb-common` in `~/src/suite3270-4.5` for the exact text and add an entry matching the table's style. Do not invent a message where x3270 has one.
3. **`StatusCode.ABORT_XMIT`** — confirm the spelling; the file uses `StatusCode.ABORT_XMIT` at its other call sites.

- [ ] **Step 5: Run the tests**

```bash
cd /home/a/athor/git/tn3270
npm run build && ./node_modules/.bin/vitest run packages/core 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 6: Mutation-check the idempotence guard**

Remove the `if (this.finished) return {};` line, run the test, and confirm the second-cancel test reddens. Revert. If it stays green, the test is not pinning what it claims.

- [ ] **Step 7: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "feat(core): a public CutTransfer.cancel for operator cancellation

$(printf '%s' 'The spec said abort "is private -- expose it", and that was not enough. abort is
the INTERNAL error path: its ten callers each hold a CutFrameError status and
message, and an operator cancelling has neither, so making it public would put
two arguments in the API that no outside caller can supply. The natural wrong
guess -- status 0, empty message -- is one the host reads as a protocol fault
rather than a cancellation.

cancel() wraps it with SC_ABORT_XMIT and PF2, which is the asymmetry this file
already documents: a HOST-initiated abort is acked with Enter, PF2 only for an
abort WE initiate.

IDEMPOTENT, and mutation-verified: a form closing as a transfer completes must
not put a second PF2 on the wire, because the host has already left transfer
mode and would read it as input into the next panel.

Generated with AI

Co-Authored-By: SLAC AI')"
```

### AS BUILT, Task 5 — the plan named the WRONG STATUS CODE

Gate after: build/typecheck clean, **1910 tests in 76 files** (from 1903). Commit `5f3c8eb`.
Six tests, not four.

1. **`SC_ABORT_FILE`, NOT `SC_ABORT_XMIT`.** x3270 uses `ABORT_FILE` at **both** of its
   user-cancel sites — `cut_abort(get_message("ftUserCancel"), SC_ABORT_FILE)` at
   `ft_cut.c:509` and `:610` — and reserves `ABORT_XMIT` for transmission faults, which is what
   every other abort in `transfer.ts` is. `StatusCode.ABORT_FILE` already existed, unused.
   Reporting a transmission error for an operator's change of mind misstates the cause in the
   host's own log.
2. **The message is `MSG.USER_CANCEL = 'Transfer canceled by user'`** (`ftUserCancel`,
   `fb-common:35`), added beside `ftHostCancel` and `ftCutRetransmit`. The American spelling is
   x3270's.
3. **There is no `finished` flag — it is `this.outcome`**, and the post-completion return must be
   **`{ done: this.outcome }`, not the plan's `{}`**. That is what `step` already returns after the
   end (`:318-321`), and **Task 8's engine reads `done`**; `{}` would make a post-completion cancel
   look like a transfer still running. After a NORMAL completion the surviving `done` is the
   SUCCESS, not the cancellation.
4. **The response-area assertion compares a RAW BYTE**, not `cp037.encode(...)` as step 2 wrote:
   `ResponseFrameType` values are EBCDIC control bytes already (`CONTROL_CODE` is `0xc3`) and
   `writeResponse` `setChar`s them directly. Every other such assertion here (`:824`, `:924`,
   `:979`) compares raw.
5. **`eofDataScreen(0)` does NOT complete a receive** — it only acks (`:237`), because the EOF
   sentinel ends the DATA and the host still sends a control code. Drive `SC_XFER_COMPLETE`.
6. Two tests beyond the plan's four: the buffer is untouched on a second cancel (idempotence on the
   SCREEN, not just the return value), and `result` reports the cancellation.

**Recorded in the method comment: we send IMMEDIATELY where x3270 DEFERS.** `ft_do_cancel`
(`ft.c:1209-1225`) sets `FT_ABORT_WAIT` and writes nothing until the host's next frame. A front end
closing a form has no later frame to wait for and must not leave the host primed — which is also
why **Task 8's `CANCELS by aborting` test can expect the AID synchronously**.

**→ TASK 8 NEEDS AN EDIT:** any assertion there on the cancel status must say `ABORT_FILE`.

---

## Task 6: The TUI overlay renderer

**Files:**
- Create: `packages/tui/src/transferOverlay.ts`, `packages/tui/test/transferOverlay.test.ts`

Follows `keypadOverlay.ts` exactly: pure, no state, no drawing. Returns lines; `app.ts` owns the state and `render.ts` paints.

- [ ] **Step 1: Write the failing test**

Create `packages/tui/test/transferOverlay.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { newTransferForm, cycleField, setFieldText } from '@tn3270/frontend';
import { transferLines, transferFits, TRANSFER_MIN } from '../src/transferOverlay.js';

describe('TRANSFER_MIN', () => {
  it('is at most 24x80, so it never refuses a terminal the session accepted', () => {
    // `tooSmall` (render.ts) already demands 24x80 before a session runs, and the
    // smallest 3270 screen IS 24x80. A minimum above that would be a refusal an
    // operator could provoke on a terminal the session itself was happy with.
    expect(TRANSFER_MIN.rows).toBeLessThanOrEqual(24);
    expect(TRANSFER_MIN.cols).toBeLessThanOrEqual(80);
  });

  it('is tall enough for every line the form can draw', () => {
    // Recomputed here rather than derived in the module, so the two can DISAGREE --
    // deriving it would make it correct by construction and unable to catch a change.
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);      // send: the most fields
    s = cycleField(s, 'recfm', 1);          // reveals Lrecl and Blksize
    s = cycleField(s, 'mode', 1);           // ascii: reveals Cr
    expect(transferLines(s, 'idle', undefined).length).toBeLessThanOrEqual(TRANSFER_MIN.rows);
  });
});

describe('transferFits', () => {
  it('accepts a terminal at the minimum and refuses one below it', () => {
    expect(transferFits({ rows: TRANSFER_MIN.rows, cols: TRANSFER_MIN.cols })).toBe(true);
    expect(transferFits({ rows: TRANSFER_MIN.rows - 1, cols: TRANSFER_MIN.cols })).toBe(false);
    expect(transferFits({ rows: TRANSFER_MIN.rows, cols: TRANSFER_MIN.cols - 1 })).toBe(false);
  });
});

describe('transferLines', () => {
  it('marks the selected field and no other', () => {
    const s = newTransferForm();
    const lines = transferLines(s, 'idle', undefined);
    expect(lines.filter((l) => l.startsWith('>'))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith('>'))).toContain('Direction');
  });

  it('is OPAQUE: every line is the same width', () => {
    // The keypad overlay learned this the hard way -- a trimEnd() let host text through
    // into the chord column, inventing a chord for 22 keys that have none. Here the leak
    // would put host cells where a field value goes, which reads as a value the user did
    // not type.
    const s = newTransferForm();
    const lines = transferLines(s, 'idle', undefined);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
  });

  it('omits an inapplicable field entirely rather than drawing it blank', () => {
    const s = newTransferForm();                  // receive, binary
    const text = transferLines(s, 'idle', undefined).join('\n');
    expect(text).not.toContain('Recfm');
    expect(text).not.toContain('Cr');
  });

  it('shows a field once it becomes applicable', () => {
    let s = newTransferForm();
    s = cycleField(s, 'direction', 1);
    const text = transferLines(s, 'idle', undefined).join('\n');
    expect(text).toContain('Recfm');
  });

  it('shows a text field value', () => {
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', '/tmp/a.bin');
    expect(transferLines(s, 'idle', undefined).join('\n')).toContain('/tmp/a.bin');
  });

  it('shows the error when one is set, and the form stays drawn', () => {
    // A validation error keeps the form OPEN with the message shown, rather than closing
    // and discarding what was typed.
    const s = { ...newTransferForm(), error: 'Transfer(): missing LocalFile' };
    const text = transferLines(s, 'idle', undefined).join('\n');
    expect(text).toContain('missing LocalFile');
    expect(text).toContain('Direction');
  });

  it('shows progress while running', () => {
    const s = newTransferForm();
    const text = transferLines(s, 'running', '512 bytes').join('\n');
    expect(text).toContain('512 bytes');
  });

  it('TRUNCATES a long value rather than widening the box', () => {
    // A 300-character path must not make the overlay wider than the terminal; the
    // alternative is a line that wraps and corrupts every row below it.
    let s = newTransferForm();
    s = setFieldText(s, 'localFile', '/x'.repeat(200));
    const lines = transferLines(s, 'idle', undefined);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(TRANSFER_MIN.cols);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/tui/test/transferOverlay.test.ts 2>&1 | tail -10
```

Expected: FAIL — cannot resolve `../src/transferOverlay.js`.

- [ ] **Step 3: Read `keypadOverlay.ts` and follow it**

```bash
cd /home/a/athor/git/tn3270
sed -n '40,145p' packages/tui/src/keypadOverlay.ts
```

Note in particular: `OVERLAY_MIN` is **written down rather than derived** so the constant and the renderer can disagree and a test can catch it; `LINE_WIDTH` uses `padEnd` alone so nothing can silently lose its tail; the width lives in the module because it is the only place that knows all the lines.

- [ ] **Step 4: Write `packages/tui/src/transferOverlay.ts`**

```typescript
/**
 * The file-transfer form, rendered to lines.
 *
 * PURE, exactly like `keypadOverlay.ts`: nothing draws, nothing holds state, nothing reads
 * the terminal. `app.ts` owns the form state and `render.ts` paints the lines it is handed.
 * The MODEL is `frontend/src/transferForm.ts` -- fields, values and applicability live
 * there so that stage 3's GUI reuses them and cannot drift.
 *
 * ## EVERY LINE IS THE SAME WIDTH, AND THAT IS NOT COSMETIC
 *
 * The keypad overlay learned this from a live host: one `.trimEnd()` let the screen's own
 * cells show through to the right of a short line, LANDING IN THE CHORD COLUMN and reading
 * as a chord the key had not got. Here the same leak would put host text where a field's
 * value goes -- a value the operator did not type, in a form they are about to submit. So
 * every line is padded to `LINE_WIDTH` and the overlay is opaque.
 *
 * Values are TRUNCATED to their field width. A 300-character path must not widen the box
 * past the terminal, because the line would wrap and corrupt every row below it.
 */

import {
  TRANSFER_FIELDS, applicable, type TransferFormState, type TransferValues,
} from '@tn3270/frontend';
import type { Geometry } from './render.js';

/** How the transfer is going, which decides the status line. */
export type TransferPhase = 'idle' | 'running' | 'done' | 'failed';

/** Widest label, for the label column. Computed, never hardcoded. */
const LABEL_WIDTH = Math.max(...TRANSFER_FIELDS.map((f) => f.label.length));

/** Widest value column any field asks for: the text fields' `width`, or a cycle's longest value. */
const VALUE_WIDTH = Math.max(
  ...TRANSFER_FIELDS.map((f) => (f.kind === 'cycle'
    ? Math.max(...f.values.map((v) => (v === '' ? 1 : v.length)))
    : f.width)),
);

/** Mark and space, the label column, a two-space gap, and the value column. */
const LINE_WIDTH = 2 + LABEL_WIDTH + 2 + VALUE_WIDTH;

/**
 * The smallest terminal this form will open in.
 *
 * Written down rather than derived from `transferLines`, for the reason `OVERLAY_MIN`
 * gives: deriving it would make it correct by construction and unable to catch a change
 * in either. `transferOverlay.test.ts` recomputes it.
 *
 * `rows` is a title, up to ten fields, a blank and a status line, with one cell of frame
 * each side. `cols` is `LINE_WIDTH` plus that frame. **Both stay at or below 24x80**, the
 * floor `tooSmall` already imposes on the session, so this can never refuse a terminal the
 * session itself accepted -- the same property `OVERLAY_MIN` has, and for the same reason.
 */
export const TRANSFER_MIN: Geometry = { rows: 15, cols: LINE_WIDTH + 2 };

/** Will the form fit? */
export function transferFits(terminal: Geometry): boolean {
  return terminal.rows >= TRANSFER_MIN.rows && terminal.cols >= TRANSFER_MIN.cols;
}

/** A value as drawn: unset shows a dash, and everything is truncated to the column. */
function shown(id: string, values: TransferValues): string {
  const raw = values[id as keyof TransferValues] ?? '';
  const text = raw === '' ? '-' : raw;
  return text.length > VALUE_WIDTH ? text.slice(0, VALUE_WIDTH - 1) + '>' : text;
}

/**
 * The form as lines: a title, one line per APPLICABLE field, then a status line.
 *
 * An inapplicable field is omitted entirely rather than drawn blank or greyed -- the TUI
 * has one attribute to spend and a blank row invites a user to try to type in it.
 *
 * `selected` indexes `TRANSFER_FIELDS`, not the lines, so the caller never has to know
 * which fields are currently hidden.
 */
export function transferLines(
  state: TransferFormState,
  phase: TransferPhase,
  progress: string | undefined,
): readonly string[] {
  const lines: string[] = [];
  lines.push('  File Transfer (IND$FILE)'.padEnd(LINE_WIDTH));

  for (const [index, field] of TRANSFER_FIELDS.entries()) {
    if (!applicable(field.id, state.values)) continue;
    const mark = index === state.selected ? '>' : ' ';
    lines.push(
      `${mark} ${field.label.padEnd(LABEL_WIDTH)}  ${shown(field.id, state.values)}`
        .padEnd(LINE_WIDTH),
    );
  }

  lines.push(''.padEnd(LINE_WIDTH));
  lines.push(statusLine(state, phase, progress).padEnd(LINE_WIDTH));
  return lines;
}

/**
 * The bottom line: the error if there is one, else the progress, else the key help.
 *
 * The error OUTRANKS the help, because a refused submit must not look like an idle form --
 * and it is truncated rather than wrapped, since a wrapped line would push the form's own
 * rows off whatever window the caller took.
 */
function statusLine(
  state: TransferFormState, phase: TransferPhase, progress: string | undefined,
): string {
  if (state.error !== undefined) return truncate(state.error);
  if (phase === 'running') return truncate(`transferring... ${progress ?? ''} (Esc cancels)`);
  if (phase === 'done') return truncate(`done: ${progress ?? ''}`);
  if (phase === 'failed') return truncate(progress ?? 'failed');
  return truncate('Tab/arrows move  left/right change  Enter start  Esc cancel');
}

const truncate = (s: string): string =>
  s.length > LINE_WIDTH ? s.slice(0, LINE_WIDTH - 1) + '>' : s;
```

- [ ] **Step 5: Run the tests**

```bash
cd /home/a/athor/git/tn3270
npm run build && ./node_modules/.bin/vitest run packages/tui/test/transferOverlay.test.ts 2>&1 | tail -15
```

Expected: PASS, 11 tests. If `TRANSFER_MIN.cols` exceeds 80, the value column is too wide — the text fields ask for 40 each, so `VALUE_WIDTH` is 40 and `LINE_WIDTH` is about 54. Check the arithmetic rather than inflating the constant.

- [ ] **Step 6: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "feat(tui): render the transfer form to lines, opaque and pure

$(printf '%s' 'Follows keypadOverlay.ts: pure, no state, no drawing -- app.ts owns the state and
render.ts paints. TRANSFER_MIN is written down rather than derived, so the
constant and the renderer can DISAGREE and the test can catch it, and it stays
at or below 24x80 so it can never refuse a terminal the session accepted.

Every line is padded to one width. That is not cosmetic: the keypad overlay
learned from a live host that one trimEnd() lets the screen show through into a
column, and here the leak would put host text where a field VALUE goes -- in a
form the operator is about to submit. Values truncate rather than widening the
box, because a wrapped line corrupts every row below it.

An inapplicable field is omitted entirely rather than drawn blank: the TUI has
one attribute to spend, and a blank row invites a user to type in it.

Generated with AI

Co-Authored-By: SLAC AI')"
```

### AS BUILT, Task 6 — the plan's help string did not fit, and the test for it was vacuous

Gate after: build/typecheck clean, **1924 tests in 77 files** (from 1910). Commit `272c3bf`.
14 tests, not 11. **Measured geometry: `LABEL_WIDTH` 10, `VALUE_WIDTH` 40, `LINE_WIDTH` 54,
`TRANSFER_MIN` 15x56, tallest form 13 lines** — the step-5 arithmetic note was right.

1. **`'Tab/arrows move  left/right change  Enter start  Esc cancel'` IS 59 CHARACTERS against a
   `LINE_WIDTH` of 54**, so it rendered as `... Enter start  Esc >` — cutting off the key that
   closes the form, on the one line whose job is saying which keys work. Replaced with a named
   `HELP` constant, `'Tab moves  <-/-> change  Enter start  Esc close'` (46). The module comment
   records **why the help is the one status line that must FIT rather than truncate**: everything
   else there arrives from outside (a validator message, a path, a host abort) where truncation is
   the only option.
2. **MY FIRST TEST FOR IT WAS VACUOUS and mutation caught it.** `not.toContain('>\n')` over the
   joined lines **passed with the oversized string restored** — the status line is the LAST line,
   so the marker it sought was the document's final character with no newline after it. Assert on
   the last line itself. **The boundary was BISECTED: 53 and 54 pass, 55 fails.** And require
   `Esc (close|cancel)`, not a bare `Esc` — the oversized string was cut off mid-word right after
   `Esc`.
3. Two tests beyond the plan's eleven: **opacity in every phase and with an error** (the status
   line is the only variable-length line, so `idle` alone exercises one of its five branches), and
   truncation of a long **error** as well as a long value.
4. `shown` takes a `TransferFieldId`, not a `string`, so a caller cannot pass a non-field and
   silently get the dash that means "unset".

**Mutation matrix:** field-line `padEnd` → 2 red (both opacity tests); status-line `padEnd` → 2 red;
value truncation → 1 red; the `applicable` filter → 1 red; the plan's help → 1 red *after* the test
was fixed and **0 before**.

---

## Task 7: Key routing in `app.ts`

**Files:**
- Modify: `packages/tui/src/app.ts`
- Test: `packages/tui/test/app.test.ts` (check the real name)

The form is a second overlay state, **mutually exclusive** with the keypad's: opening one closes the other. Routing follows `overlayShown` exactly — that interception is what makes a text field possible at all, since a bare letter is bindable nowhere else in this emulator.

- [ ] **Step 1: Read the existing overlay plumbing end to end**

```bash
cd /home/a/athor/git/tn3270
sed -n '195,235p;380,410p;585,625p;640,700p;740,775p' packages/tui/src/app.ts
```

Note: `overlayShown` intercepts at `app.ts:403`; `draw()` passes `overlayWindow()` at `:390`; `closeOverlay` deliberately does NOT empty `overlayPending`, because the byte that closed the list is still at its front and dropping it is a silent lost keystroke.

- [ ] **Step 2: Write the failing tests**

`packages/tui/test/app.test.ts` already has everything needed: `harness(rows = 25, cols = 80)` returning `{ app, session, stdin, stdout, host }`, and `cellText(session, index)` for one cell's resolved text straight off the real screen. **Input arrives through `stdin.listener`, not a method on `App`** — the app registers a `data` handler in `start()`. So every test calls `app.start()` first and then `h.stdin.listener!(bytes)`.

Add to `packages/tui/test/app.test.ts`:

```typescript
describe('the transfer form', () => {
  /** Start an app and return a function that feeds it bytes, as a terminal would. */
  function started(rows = 25, cols = 80) {
    const h = harness(rows, cols);
    h.app.start();
    return { ...h, send: (...bytes: number[]) => h.stdin.listener!(Uint8Array.from(bytes)) };
  }

  const CTRL_T = 0x14;
  const CTRL_K = 0x0b;

  it('opens on Ctrl-T', () => {
    const h = started();
    h.send(CTRL_T);
    expect(h.app.transferOpen).toBe(true);
  });

  it('is MUTUALLY EXCLUSIVE with the keypad list', () => {
    // Two overlays both owning the keyboard is a state the user cannot read: the one they
    // cannot see swallows everything they type.
    const h = started();
    h.send(CTRL_K);
    expect(h.app.overlayOpen).toBe(true);
    h.send(CTRL_T);
    expect(h.app.overlayOpen).toBe(false);
    expect(h.app.transferOpen).toBe(true);
    h.send(CTRL_K);
    expect(h.app.transferOpen).toBe(false);
    expect(h.app.overlayOpen).toBe(true);
  });

  it('OWNS the keyboard: a printable does NOT reach the screen', () => {
    // The whole reason the form can have a text field at all. Without the interception,
    // `a` is a character typed at the host -- and a fresh Session already accepts typing
    // (this file's makeSession comment records that `typeString('A')` lands in cell 0),
    // so this assertion is against the real keyboard rather than a mock.
    const h = started();
    const before = cellText(h.session, 0);
    h.send(CTRL_T);
    h.send(0x61, 0x62);                              // "ab"
    expect(cellText(h.session, 0)).toBe(before);     // nothing reached the host
  });

  it('types into a text field once one is selected', () => {
    const h = started();
    h.send(CTRL_T);
    h.send(0x09);                                    // Tab: Direction -> Host
    h.send(0x09);                                    // Tab: Host -> Local file
    h.send(0x61, 0x2e, 0x62, 0x69, 0x6e);            // "a.bin"
    expect(h.app.transferValues.localFile).toBe('a.bin');
  });

  it('refuses a printable in a CYCLE field rather than inventing a value', () => {
    // The form collects strings but does not get to make them up: a typed value the
    // validator has never seen would fail at submit naming a keyword the user did type.
    const h = started();
    h.send(CTRL_T);
    h.send(0x78);                                    // "x" with Direction selected
    expect(h.app.transferValues.direction).toBe('receive');
  });

  it('Backspace deletes the last character', () => {
    const h = started();
    h.send(CTRL_T);
    h.send(0x09, 0x09);
    h.send(0x61, 0x62);
    h.send(0x7f);                                    // DEL
    expect(h.app.transferValues.localFile).toBe('a');
  });

  it('left and right cycle a cycle field', () => {
    const h = started();
    h.send(CTRL_T);
    h.send(0x1b, 0x5b, 0x43);                        // CSI C = right
    expect(h.app.transferValues.direction).toBe('send');
    h.send(0x1b, 0x5b, 0x44);                        // CSI D = left
    expect(h.app.transferValues.direction).toBe('receive');
  });

  it('A SPLIT ARROW MUST NOT CLOSE THE FORM', () => {
    // `\x1b` and `[C` can arrive in SEPARATE reads -- the delivery this file's own escHeld
    // tests record a regression for, so it is not hypothetical. Closing on the first byte
    // would make the right arrow close the form on any terminal that splits, which the
    // user can neither predict nor see.
    const h = started();
    h.send(CTRL_T);
    h.send(0x1b);
    expect(h.app.transferOpen).toBe(true);
    h.send(0x5b, 0x43);
    expect(h.app.transferOpen).toBe(true);
    expect(h.app.transferValues.direction).toBe('send');
  });

  it('a LONE Esc that outlives the window closes it', () => {
    // Fake timers, as this file's other ESC tests do: a real 50ms sleep makes the suite
    // slower and flaky on a loaded box.
    vi.useFakeTimers();
    try {
      const h = started();
      h.send(CTRL_T);
      h.send(0x1b);
      expect(h.app.transferOpen).toBe(true);
      vi.advanceTimersByTime(60);
      expect(h.app.transferOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AUTOREPEAT COALESCED INTO ONE READ moves more than once', () => {
    // A slow link delivers `\x1b[C\x1b[C` as a single read, which no whole-chunk
    // comparison recognises -- the field would appear to stop changing while the key was
    // held. Two rights from `receive` wrap back to `receive`, so assert three.
    const h = started();
    h.send(CTRL_T);
    h.send(0x1b, 0x5b, 0x43, 0x1b, 0x5b, 0x43, 0x1b, 0x5b, 0x43);
    expect(h.app.transferValues.direction).toBe('send');
  });
});
```

**Check this file's existing ESC tests for whether they use `vi.useFakeTimers`** and match them; the import of `vi` is already at the top. If they use real sleeps, follow that instead — consistency with the file beats this plan's preference.

- [ ] **Step 2a: Settle the too-small refusal by arithmetic, not by assertion**

`TRANSFER_MIN.cols` is `LINE_WIDTH + 2`, and `LINE_WIDTH` is `2 + LABEL_WIDTH + 2 + VALUE_WIDTH`. With `VALUE_WIDTH = 40` (the text fields' width) and `LABEL_WIDTH = 10` (`Direction`, `Local file`), that is `2 + 10 + 2 + 40 + 2 = 56` — comfortably inside 80. `TRANSFER_MIN.rows` is 15, inside 24.

**So the refusal is UNREACHABLE from a live session, exactly like the keypad list's**, because `tooSmall` already demands 24x80 and the smallest 3270 screen is 24x80. Compute the real numbers from your implementation and confirm this. Then:

- Write the test as a **direct call to `transferFits`** (already done in Task 6), not as an app-level scenario that cannot occur.
- **Document it as unreachable** in `transferOverlay.ts`, the way `OVERLAY_MIN` is documented, rather than implying a check an operator can provoke.
- **Do not inflate `TRANSFER_MIN` to make the branch reachable.** That is explicitly the wrong fix here and the keypad's comment says so.

If your arithmetic gives a `cols` above 80, the value column is too wide — reduce the text fields' width rather than accepting a form that cannot open.

- [ ] **Step 3: Run to verify they fail**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/tui 2>&1 | tail -15
```

Expected: FAIL — `transferOpen` is not a property.

- [ ] **Step 4: Implement the state and the routing**

In `packages/tui/src/app.ts`:

(a) Fields, beside `overlayShown`:

```typescript
  private transferShown = false;
  private transferState = newTransferForm();
  private transferPhase: TransferPhase = 'idle';
  private transferProgress: string | undefined;
  private transferPending: number[] = [];
  private transferTimer: ReturnType<typeof setTimeout> | undefined;
```

(b) Test accessors, beside `get overlayOpen()`:

```typescript
  get transferOpen(): boolean { return this.transferShown; }
  /** For tests: the form's current values. */
  get transferValues(): TransferValues { return this.transferState.values; }
```

(c) The interception, immediately after the `overlayShown` one at `:403`:

```typescript
    if (this.transferShown) { this.consumeTransferKey(bytes); return; }
```

(d) `draw()` must pass the form's lines. It currently passes `this.overlayShown ? this.overlayWindow() : undefined`. Make that pick whichever overlay is open — they are mutually exclusive, so at most one contributes:

```typescript
      this.overlayShown ? this.overlayWindow()
        : this.transferShown ? transferLines(this.transferState, this.transferPhase, this.transferProgress)
        : undefined,
```

(e) `toggleTransfer`, modelled on `toggleOverlay` — including the `suspended` guard, for the same reason: opening while suspended would leave the form invisible and yet owning the keyboard.

```typescript
  /** Open the transfer form, or close an open one. The keypad list closes if it is up. */
  private toggleTransfer(): void {
    if (this.transferShown) { this.closeTransfer(); return; }
    if (this.suspended) return;
    // MUTUALLY EXCLUSIVE with the keypad list. Two overlays both owning the keyboard is a
    // state the user cannot read: the one they cannot see swallows what they type.
    if (this.overlayShown) this.closeOverlay();
    if (!transferFits(this.terminal())) {
      this.showMessage('terminal too small for the transfer form');
      return;
    }
    this.transferShown = true;
    this.transferState = newTransferForm();
    this.transferPhase = 'idle';
    this.transferProgress = undefined;
    this.draw();
  }
```

**A running transfer must not be abandoned by a close** — see Task 8, which adds the abort to `closeTransfer`. For now:

```typescript
  private closeTransfer(): void {
    this.transferShown = false;
    this.clearTransferTimer();
    this.draw();
  }
```

(f) `consumeTransferKey` and `transferKey`, modelled on `consumeOverlayKey`/`overlayKey`. The ESC handling must be the **same shape**: hold an incomplete prefix for `ESC_TIMEOUT_MS`, and only a lone ESC that outlives the window closes.

```typescript
  /**
   * Read the bytes as the form's, one key at a time.
   *
   * ## A SPLIT ARROW MUST NOT READ AS ESCAPE
   *
   * The same hazard `consumeOverlayKey` documents, and not hypothetical: `\x1b` and `[C`
   * can arrive in separate reads. Closing on the first would make the right arrow close
   * the form on any terminal that splits. So an incomplete prefix is HELD with the same
   * 50ms window `pump()` uses, and only a lone ESC that outlives it closes.
   *
   * ## ONE READ, SEVERAL KEYS
   *
   * A loop rather than a match on the chunk: autorepeat coalesced by a slow link delivers
   * `\x1b[C\x1b[C` as one read, and a whole-chunk comparison would see the field stop
   * changing while the key was held.
   */
  private consumeTransferKey(bytes: Uint8Array): void {
    for (const b of bytes) this.transferPending.push(b);
    this.clearTransferTimer();

    while (this.transferShown && this.transferPending.length > 0) {
      const taken = this.transferKey(this.transferPending);
      if (taken === 0) { this.holdTransferPrefix(); return; }
      this.transferPending.splice(0, taken);
    }

    if (this.transferPending.length > 0) {
      // Bytes that shared a read with the keystroke that CLOSED the form belong to the
      // screen again. Dropping them is the silent lost keystroke `pump()` exists to
      // prevent, and it is safe now that `transferShown` is false.
      for (const b of this.transferPending) this.buffer.push(b);
      this.transferPending = [];
      this.pump();
    }
  }

  /** Act on the ONE key at the front, returning bytes consumed, or 0 for an unresolved prefix. */
  private transferKey(pending: readonly number[]): number {
    const b = pending[0];
    if (b !== ESC) {
      if (b === OVERLAY_CR || b === OVERLAY_LF) this.submitTransfer();
      else if (b === TRANSFER_TOGGLE) this.closeTransfer();
      else if (b === OVERLAY_TOGGLE) { this.closeTransfer(); this.toggleOverlay(); }
      else if (b === TAB) this.moveTransfer(1);
      else if (b === BACKSPACE || b === DEL) this.backspaceTransfer();
      else if (b !== undefined && b >= 0x20 && b < 0x7f) this.typeTransfer(b);
      return 1;
    }
    if (pending.length === 1) return 0;
    if (pending[1] === OVERLAY_CSI || pending[1] === OVERLAY_SS3) {
      if (pending.length === 2) return 0;
      // BackTab arrives as CSI Z, which is three bytes like the arrows.
      if (pending[2] === OVERLAY_UP) this.moveTransfer(-1);
      else if (pending[2] === OVERLAY_DOWN) this.moveTransfer(1);
      else if (pending[2] === TRANSFER_RIGHT) this.cycleTransfer(1);
      else if (pending[2] === TRANSFER_LEFT) this.cycleTransfer(-1);
      else if (pending[2] === TRANSFER_BACKTAB) this.moveTransfer(-1);
      return 3;
    }
    this.closeTransfer();
    return 1;
  }
```

Define the byte constants beside the existing `OVERLAY_*` ones, reusing those where they already exist:

```typescript
const TRANSFER_TOGGLE = 0x14;   // Ctrl-T
const TAB = 0x09;
const BACKSPACE = 0x08;
const DEL = 0x7f;
const TRANSFER_RIGHT = 0x43;    // CSI C
const TRANSFER_LEFT = 0x44;     // CSI D
const TRANSFER_BACKTAB = 0x5a;  // CSI Z
```

**Check which of these already exist** (`ESC`, `OVERLAY_CR`, `OVERLAY_LF`, `OVERLAY_CSI`, `OVERLAY_SS3`, `OVERLAY_UP`, `OVERLAY_DOWN`, `OVERLAY_TOGGLE`) and reuse rather than redefining. Two constants for one byte is exactly the drift this codebase keeps eliminating.

(g) The small movers:

```typescript
  private moveTransfer(delta: number): void {
    this.transferState = moveField(this.transferState, delta);
    this.draw();
  }

  private cycleTransfer(delta: number): void {
    const field = TRANSFER_FIELDS[this.transferState.selected];
    if (field === undefined) return;
    this.transferState = cycleField(this.transferState, field.id, delta);
    // A CYCLE CAN HIDE THE FIELD THAT IS SELECTED, and then the selection points at
    // something the user cannot see: flipping Mode from ascii to binary hides Cr, and Cr
    // may be the selected field, since cycling it is what the user was just doing. Left
    // alone, the next keystroke would edit an invisible field. `moveField(1)` then
    // `moveField(-1)` would land back on it, so the repair is to move FORWARD only when
    // the current selection has become inapplicable -- `moveField` already skips
    // inapplicable fields, so one call is the whole fix.
    const still = TRANSFER_FIELDS[this.transferState.selected];
    if (still !== undefined && !applicable(still.id, this.transferState.values)) {
      this.transferState = moveField(this.transferState, 1);
    }
    this.draw();
  }

  private typeTransfer(byte: number): void {
    const field = TRANSFER_FIELDS[this.transferState.selected];
    if (field === undefined || field.kind === 'cycle') return;
    const current = this.transferState.values[field.id];
    this.transferState = setFieldText(
      this.transferState, field.id, current + String.fromCharCode(byte),
    );
    this.draw();
  }

  private backspaceTransfer(): void {
    const field = TRANSFER_FIELDS[this.transferState.selected];
    if (field === undefined || field.kind === 'cycle') return;
    const current = this.transferState.values[field.id];
    this.transferState = setFieldText(this.transferState, field.id, current.slice(0, -1));
    this.draw();
  }

  private holdTransferPrefix(): void {
    this.transferTimer = setTimeout(() => {
      this.transferTimer = undefined;
      const lone = this.transferPending.length === 1 && this.transferPending[0] === ESC;
      this.transferPending = [];
      if (lone && this.transferShown) this.closeTransfer();
    }, ESC_TIMEOUT_MS);
  }

  private clearTransferTimer(): void {
    if (this.transferTimer === undefined) return;
    clearTimeout(this.transferTimer);
    this.transferTimer = undefined;
  }
```

**Add a test for that repair**, because it is a real state and nothing above reaches it:

```typescript
it('MOVES THE SELECTION off a field a cycle just hid', () => {
  // Flipping Mode to binary hides Cr -- and Cr may be the selected field, since cycling it
  // is what the user was doing. Left alone, the next keystroke edits an invisible field.
  const h = started();
  h.send(CTRL_T);
  h.send(0x09, 0x09, 0x09, 0x09);                  // Tab to Mode
  h.send(0x1b, 0x5b, 0x43);                        // right: ascii, revealing Cr
  h.send(0x09);                                    // Tab to Exist
  h.send(0x09);                                    // Tab to Cr (now applicable)
  h.send(0x1b, 0x5b, 0x43);                        // right: Cr = auto
  expect(h.app.transferValues.cr).toBe('auto');
  // Now go back to Mode and turn ascii off, which hides Cr underneath the selection.
  h.send(0x1b, 0x5b, 0x5a, 0x1b, 0x5b, 0x5a);      // BackTab x2, to Mode
  h.send(0x1b, 0x5b, 0x43);                        // right: binary
  const selected = TRANSFER_FIELDS[h.app.transferSelected];
  expect(selected).toBeDefined();
  expect(applicable(selected!.id, h.app.transferValues)).toBe(true);
});
```

Add a `get transferSelected(): number` accessor. **Count the Tabs against your real field order** — the sketch above assumes `direction, host, localFile, hostFile, mode` puts Mode four Tabs in, and that `Cr` sits after `Exist`; verify both against `TRANSFER_FIELDS` and `applicable`, since inapplicable fields are SKIPPED by `moveField` and the Tab count is therefore not the raw index.

(h) Route the action. Find where `toggleKeypad` is dispatched from the keymap and add `transferForm` beside it, calling `toggleTransfer()`.

(i) `submitTransfer` — Task 8 fills this in. For now:

```typescript
  private submitTransfer(): void {
    // Task 8 runs the transfer. Validation first, so the form can show an error.
  }
```

- [ ] **Step 5: Run the tests**

```bash
cd /home/a/athor/git/tn3270
npm run build && npm run typecheck && ./node_modules/.bin/vitest run packages/tui 2>&1 | tail -15
```

Expected: PASS except the submit-dependent ones, which Task 8 covers.

- [ ] **Step 6: Mutation-check the interception**

The whole feature rests on the form owning the keyboard. Comment out the `if (this.transferShown)` line added in (c), run the suite, and confirm the "OWNS the keyboard" test reddens — a printable would otherwise reach the host. Revert.

- [ ] **Step 7: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "feat(tui): route keys to the transfer form, exclusively with the keypad

$(printf '%s' 'A second overlay state following overlayShown exactly. That interception is what
makes a text field possible at all: a bare letter is bindable nowhere else in
this emulator, and a filename needs every printable character -- mutation-
verified by removing the guard and watching a keystroke reach the host.

MUTUALLY EXCLUSIVE with the keypad list: opening either closes the other. Two
overlays both owning the keyboard is a state the user cannot read, because the
one they cannot see swallows what they type.

The ESC handling is the same shape as the overlay path, including the 50ms hold:
\x1b and [C can arrive in SEPARATE reads, so closing on the first byte would
make the right arrow close the form on any terminal that splits. And the bytes
that shared a read with the closing keystroke re-enter the ordinary path rather
than being dropped, which is the silent lost keystroke pump() exists to prevent.

Generated with AI

Co-Authored-By: SLAC AI')"
```

---

## Task 8: Run the transfer

**Files:**
- Create: `packages/tui/src/transferRun.ts`, `packages/tui/test/transferRun.test.ts`
- Modify: `packages/tui/src/app.ts`, `packages/tui/src/main.ts`

**The CLI's loop cannot be reused as-is.** `runTransferFrames` is `async` and polls with `await new Promise(r => setTimeout(r, 10))` inside a `for(;;)`, which suits a script that blocks until the transfer ends. The TUI must keep redrawing the screen underneath — in CUT mode a transfer *is* screen traffic — so the same state machine is driven from the `screen` event instead.

- [ ] **Step 1: Read the CLI's loop and its guards**

```bash
cd /home/a/athor/git/tn3270
sed -n '446,500p;628,660p' packages/cli/src/runner.ts
```

The order of operations is the error-handling rule and must be preserved: keywords, geometry, 3270 mode, the source file, the destination — **then** the host is told anything. A local error after the host has been primed leaves it sitting in transfer mode waiting for a client that has given up.

- [ ] **Step 2: Write the failing test**

Create `packages/tui/test/transferRun.test.ts`. Drive it with a fake session; do not reach for a host.

```typescript
import { describe, it, expect, vi } from 'vitest';
import { startTransfer } from '../src/transferRun.js';

describe('startTransfer', () => {
  it('REFUSES a screen that is not 24x80, and names the remedy', () => {
    // The refusal must say what to do about it, because the remedy is a RESTART: -model
    // is parsed once at launch and runtime model-switching does not exist. A message that
    // only reports the geometry leaves a user at -model 3278-4-E stuck with no way out
    // from inside the running client.
    const { session, aids } = withSpy(makeSession(43, 80));
    const r = startTransfer({ session, files: fakeFiles(), request: aReceive(), command: 'x',
      onProgress: () => {}, onDone: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/24x80/);
    expect(r.error).toMatch(/43x80/);            // the CURRENT geometry
    expect(r.error).toMatch(/-model 3278-2-E/);  // the remedy
    expect(r.error).toMatch(/DFT/);              // and that it is coming
  });

  it('refuses when not in 3270 mode', () => {
    const { session, aids } = withSpy(makeSession(24, 80));
    vi.spyOn(session, 'is3270Mode').mockReturnValue(false);
    const r = startTransfer({ session, files: fakeFiles(), request: aReceive(), command: 'x',
      onProgress: () => {}, onDone: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in 3270 mode/);
  });

  it('refuses a receive onto an existing file with Exist=keep, BEFORE telling the host', () => {
    // A local error must fail before the host command is typed, or the host is left in
    // transfer mode waiting for a client that has already given up.
    const { session, aids } = withSpy(makeSession(24, 80));
    const files = fakeFiles({ '/tmp/a.bin': new Uint8Array([1]) });
    const r = startTransfer({ session, files, request: aReceive('/tmp/a.bin'), command: 'x',
      onProgress: () => {}, onDone: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file exists/);
    expect(aids).toEqual([]);                    // nothing reached the host
  });

  it('refuses a send whose source cannot be read, BEFORE telling the host', () => {
    const { session, aids } = withSpy(makeSession(24, 80));
    const r = startTransfer({ session, files: fakeFiles(), request: aSend('/tmp/missing'),
      command: 'x', onProgress: () => {}, onDone: () => {} });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot read local file/);
    expect(aids).toEqual([]);
  });

  it('primes the command and sends Enter when every local check passes', () => {
    const { session, aids } = withSpy(makeSession(24, 80));
    const r = startTransfer({ session, files: fakeFiles(), request: aReceive(),
      command: 'IND$FILE GET A.BIN', onProgress: () => {}, onDone: () => {} });
    expect(r.ok).toBe(true);
    expect(screenText(session)).toContain('IND$FILE GET A.BIN');
    expect(aids).toEqual([AID.ENTER]);
  });

  it('times out rather than hanging when no frame arrives', async () => {
    vi.useFakeTimers();
    const { session, aids } = withSpy(makeSession(24, 80));
    let done: { ok: boolean; error?: string } | undefined;
    startTransfer({ session, files: fakeFiles(), request: aReceive(), command: 'x',
      onProgress: () => {}, onDone: (d) => { done = d; }, frameMs: 1000, totalMs: 5000 });
    await vi.advanceTimersByTimeAsync(1200);
    expect(done?.ok).toBe(false);
    expect(done?.error).toMatch(/within/);
    // The host may STILL be in transfer mode, and the message must say so -- otherwise
    // the user's next keystroke goes into a host waiting for a CUT frame.
    expect(done?.error).toMatch(/Attn or Clear/);
    vi.useRealTimers();
  });

  it('CANCELS by aborting, so the host leaves transfer mode', () => {
    const { session, aids } = withSpy(makeSession(24, 80));
    const run = startTransfer({ session, files: fakeFiles(), request: aReceive(), command: 'x',
      onProgress: () => {}, onDone: () => {} });
    expect(run.ok).toBe(true);
    run.cancel!();
    // PF2: an abort WE initiate. Abandoning instead would leave the host program waiting.
    expect(aids).toEqual([AID.ENTER, AckAid.ABORT]);
  });

  it('REMOVES its screen listener when the transfer ends', () => {
    // A leaked listener per transfer is invisible except as wasted CPU, which is why
    // Session.listenerCount exists at all.
    const { session, aids } = withSpy(makeSession(24, 80));
    const before = session.listenerCount('screen');
    const run = startTransfer({ session, files: fakeFiles(), request: aReceive(), command: 'x',
      onProgress: () => {}, onDone: () => {} });
    run.cancel!();
    expect(session.listenerCount('screen')).toBe(before);
  });
});
```

**Use a REAL `Session` with a fake `Connection`, not a hand-written session double.** `packages/tui/test/app.test.ts:15-22` already does exactly this and its comment gives the reason: a fresh unconnected `Session` already accepts typing and has a real `Screen`, `Keyboard`, `oia`, and real `on`/`off`/`listenerCount`, so the test exercises the real objects rather than proving `startTransfer` calls the method the test told it to expect. Copy that helper:

```typescript
import { AID, AckAid, Session, type Connection } from '@tn3270/core';
import type { TransferFiles, TransferRequest } from '@tn3270/frontend';

/** A real Session with a fake socket, per app.test.ts's makeSession. */
function makeSession(rows = 24, cols = 80): Session {
  const conn: Connection = {
    write: () => {}, close: () => {},
    onData: undefined, onClose: undefined, onError: undefined,
  };
  // The alternate size is what decides the buffer; check `defaultSession`/`Session`'s
  // options for the exact spelling and pass 24x80 or 43x80 accordingly.
  return new Session({ connect: () => conn, alternateRows: rows, alternateCols: cols });
}

/** An in-memory TransferFiles, which is what the injected interface exists for. */
function fakeFiles(initial: Record<string, Uint8Array> = {}): TransferFiles & { files: Map<string, Uint8Array> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p),
    read: (p) => {
      const got = files.get(p);
      if (got === undefined) throw new Error(`ENOENT: ${p}`);
      return got;
    },
    write: (p, bytes) => { files.set(p, bytes); },
    append: (p, bytes) => {
      const old = files.get(p) ?? new Uint8Array(0);
      const out = new Uint8Array(old.length + bytes.length);
      out.set(old); out.set(bytes, old.length);
      files.set(p, out);
    },
  };
}

const aReceive = (localFile = '/tmp/a.bin'): TransferRequest => ({
  direction: 'receive', localFile, hostFile: 'A.BIN',
  host: 'tso', mode: 'binary', cr: 'auto', exist: 'keep',
});

const aSend = (localFile = '/tmp/a.bin'): TransferRequest => ({
  ...aReceive(localFile), direction: 'send',
});
```

Plus the two helpers the test bodies above use:

```typescript
/**
 * Record the AIDs a session is asked to send.
 *
 * A SPY, not a fake session: `startTransfer` must drive the real Screen and Keyboard, and
 * the only thing worth intercepting is the wire. `sendAID` rather than `conn.write` because
 * this asserts WHICH AID we asked for -- reading it back out of a framed record would be
 * asserting the telnet layer, which has its own tests.
 */
function withSpy(session: Session): { session: Session; aids: number[] } {
  const aids: number[] = [];
  vi.spyOn(session, 'sendAID').mockImplementation((aid: number) => { aids.push(aid); });
  return { session, aids };
}

/** The whole screen as text, for checking the command was typed into it. */
function screenText(session: Session): string {
  return resolve(session.screen.snapshot(), {}).map((c) => c.text).join('');
}
```

Import `resolve` from `@tn3270/core`, as `app.test.ts` does.

**Two things to sort out against the real types:**

1. **How a `Session` is given a 43-row screen.** Check `Session`'s constructor options and `defaultSession`'s signature — the alternate size is passed as an object in some places (`{ rows, cols }`) and as separate fields in others. **And a model 4's DEFAULT size is still 24x80**: the model sets only the ALTERNATE, and EW/EWA switch between them. So constructing a 43-row session may need an explicit `useAlternateSize()` or an EWA, not just the constructor option — otherwise the geometry test passes because the screen is 24x80 for a reason unrelated to the one it claims. **Verify `session.screen.size` is 3440 before asserting the refusal**, or the test proves nothing.
2. **`mockImplementation` on `sendAID` suppresses the real send.** That is what makes `aids` clean, but it also means nothing reaches the screen buffer from an AID — fine here, because these tests are about the local checks and the ordering, not about frame exchange. If a test ever needs both, use `vi.spyOn(...)` without `mockImplementation` and read `aids` alongside the real effect.

A real `Session` also makes the "removes its screen listener" test meaningful, because `listenerCount` is real. That method exists *so the leak is observable* — wasted CPU is not something an assertion can otherwise see.

- [ ] **Step 3: Run to verify it fails**

```bash
cd /home/a/athor/git/tn3270
./node_modules/.bin/vitest run packages/tui/test/transferRun.test.ts 2>&1 | tail -10
```

Expected: FAIL — cannot resolve `../src/transferRun.js`.

- [ ] **Step 4: Write `packages/tui/src/transferRun.ts`**

Port the CLI's logic, keeping its order of operations and its comments' reasoning. The shape:

```typescript
/**
 * Drive a CUT transfer from the TUI, event-driven rather than blocking.
 *
 * ## WHY NOT REUSE THE CLI'S LOOP
 *
 * `Runner.runTransferFrames` is `async` and polls inside a `for(;;)` with a 10ms sleep,
 * which suits a script that blocks until the transfer ends -- the s3270 line protocol has
 * no way to report a completion arriving after its `ok`. A TUI cannot block: the screen
 * underneath must keep repainting, and in CUT mode a transfer IS screen traffic, so the
 * user watches the frames go by. Same `CutTransfer`, same steps, driven from the `screen`
 * event instead of a sleep.
 *
 * ## THE ORDER OF OPERATIONS IS THE ERROR-HANDLING RULE
 *
 * Everything checkable locally is checked BEFORE the host is told anything: the geometry,
 * 3270 mode, the keyboard lock, the source file, the destination. A local error after the
 * host has been primed leaves it sitting in transfer mode waiting for a client that has
 * already given up -- which the operator then has to break out of by hand.
 */
```

Export:

```typescript
export interface TransferRun {
  readonly ok: boolean;
  readonly error?: string;
  /** Abort and tell the host. Absent when the run never started. */
  readonly cancel?: () => void;
}

export interface StartTransferOptions {
  /** `Session` from `@tn3270/core`, which is what `App` already holds (`app.ts:161`). */
  session: Session;
  files: TransferFiles;
  request: TransferRequest;
  command: string;
  onProgress: (text: string) => void;
  onDone: (result: { ok: boolean; error?: string; bytes?: number }) => void;
  frameMs?: number;
  totalMs?: number;
}

export function startTransfer(opts: StartTransferOptions): TransferRun;
```

The geometry refusal message is specified by the spec and must say all four things:

```typescript
    if (session.screen.size !== CUT_SCREEN_CELLS) {
      // NAMES THE REMEDY, not just the problem. `-model` is parsed once at launch
      // (`main.ts`) and runtime model-switching does not exist -- it is an unbuilt roadmap
      // item -- so a user at `-model 3278-4-E` cannot fix this from inside the running
      // client. A message that only reported the geometry would leave them stuck.
      return {
        ok: false,
        error: `CUT file transfer needs a 24x80 screen; this session is `
          + `${session.screen.rows}x${session.screen.cols}. `
          + `Restart with -model 3278-2-E, or wait for DFT.`,
      };
    }
```

**`core` already exports the constant: `CUT_SCREEN_SIZE = 1920` at `packages/core/src/ft/frames.ts:72`** ("The only screen size CUT works on: 24 * 80"). Import it rather than writing `1920` again — `runner.ts:454` compares against the literal, which is the drift this avoids:

```typescript
import { CUT_SCREEN_SIZE, isCutFrame } from '@tn3270/core';
```

Check it is re-exported from `core`'s index; if it is not, add it, since this is its second consumer.

The stepper replaces the CLI's poll loop. Register one `screen` listener, and **remove it on every exit path**:

```typescript
  const onScreen = (): void => {
    if (!isCutFrame(session.screen)) return;
    const step = transfer.step(session.screen);
    if (step.ack !== undefined) session.sendAID(step.ack);
    if (step.done !== undefined) finish(step.done);
  };
  session.on('screen', onScreen);
```

`finish` must `session.off('screen', onScreen)` and clear both timers before calling `onDone`. **A leaked listener per transfer is invisible except as wasted CPU**, which is why `Session.listenerCount` exists.

Keep the CLI's two timers: a per-frame deadline and an overall one, with its exact message including "the host may still be in transfer mode (press Attn or Clear)".

For a successful `receive`, write the bytes through `files` — `append` for `Exist=append`, else `write` — exactly as `runner.ts:508-515` does.

- [ ] **Step 5: Run the tests**

```bash
cd /home/a/athor/git/tn3270
npm run build && npm run typecheck && ./node_modules/.bin/vitest run packages/tui/test/transferRun.test.ts 2>&1 | tail -15
```

Expected: PASS, 8 tests.

- [ ] **Step 6: Wire `submitTransfer` in `app.ts`**

```typescript
  /**
   * Validate the form and start the transfer.
   *
   * A VALIDATION ERROR KEEPS THE FORM OPEN with the message shown, rather than closing and
   * discarding what was typed -- the user's next move is to fix one field, and a form that
   * vanished would make them retype all ten.
   */
  private submitTransfer(): void {
    if (this.transferPhase === 'running') return;
    let command: string;
    let request: TransferRequest;
    try {
      ({ request, command } = transferCommand(formKeywords(this.transferState)));
    } catch (err) {
      // THE VALIDATOR'S message, not one of ours: it is the single authority on what is
      // legal, and paraphrasing it here is how the TUI and the CLI would start to drift.
      this.transferState = {
        ...this.transferState,
        error: err instanceof Error ? err.message : String(err),
      };
      this.draw();
      return;
    }
    if (this.files === undefined) {
      this.transferState = { ...this.transferState, error: 'no file system available' };
      this.draw();
      return;
    }
    const run = startTransfer({
      session: this.session, files: this.files, request, command,
      onProgress: (text) => { this.transferProgress = text; this.draw(); },
      onDone: (result) => {
        this.transferPhase = result.ok ? 'done' : 'failed';
        this.transferProgress = result.ok
          ? `${result.bytes ?? 0} bytes transferred` : result.error;
        this.transferRun = undefined;
        this.draw();
      },
    });
    if (!run.ok) {
      this.transferState = { ...this.transferState, error: run.error };
      this.draw();
      return;
    }
    this.transferRun = run;
    this.transferPhase = 'running';
    this.transferProgress = undefined;
    this.draw();
  }
```

Add `private transferRun: TransferRun | undefined;` and a `files` constructor option.

**And make `closeTransfer` abort a running transfer** — this is the point the spec is explicit about:

```typescript
  private closeTransfer(): void {
    // CLOSING MID-TRANSFER ABORTS RATHER THAN ABANDONING. Walking away leaves the host
    // program waiting for a CUT frame that will never come, and the operator's next
    // keystroke then goes into a host that is not listening for it.
    if (this.transferRun?.cancel !== undefined) this.transferRun.cancel();
    this.transferRun = undefined;
    this.transferShown = false;
    this.transferPhase = 'idle';
    this.clearTransferTimer();
    this.draw();
  }
```

- [ ] **Step 7: Pass the filesystem in from `main.ts`**

In `packages/tui/src/main.ts`, import `nodeTransferFiles` from `@tn3270/node-files` and pass it into `App`. Add `@tn3270/node-files` to `packages/tui/package.json`'s dependencies and `{ "path": "../node-files" }` to `packages/tui/tsconfig.json`'s `references`.

- [ ] **Step 8: Add the app-level submit tests**

Append to the TUI app test file:

```typescript
it('keeps the form OPEN and shows the validator message on a bad submit', () => {
  const { app } = makeApp();
  app.onInput(Uint8Array.of(0x14));
  app.onInput(Uint8Array.of(0x0d));        // Enter with both file fields empty
  expect(app.transferOpen).toBe(true);     // not closed
  expect(app.transferError).toMatch(/Transfer\(\)/);
});
```

Add a `get transferError()` accessor returning `this.transferState.error`.

- [ ] **Step 9: Build, typecheck, full suite, commit**

```bash
cd /home/a/athor/git/tn3270
npm run build && npm run typecheck && ./node_modules/.bin/vitest run --reporter=basic 2>&1 | tail -5
git add -A
git commit -m "feat(tui): run the transfer, event-driven, aborting on close

$(printf '%s' 'The CLI loop could not be reused: it is async and polls inside a for(;;), which
suits a script that blocks until the transfer ends. A TUI cannot block -- in CUT
mode a transfer IS screen traffic, so the screen underneath must keep
repainting. Same CutTransfer, same steps, driven from the screen event.

The order of operations is preserved because it is the error-handling rule:
geometry, 3270 mode, keyboard lock, source, destination -- then the host. A local
error after the host is primed leaves it in transfer mode waiting for a client
that has given up.

The 24x80 refusal NAMES THE REMEDY, which is a restart: -model is parsed once at
launch and runtime model-switching is an unbuilt roadmap item, so a user at
-model 3278-4-E cannot fix this from inside the client. Reporting only the
geometry would leave them stuck.

Closing mid-transfer ABORTS rather than abandoning, and the screen listener is
removed on every exit path -- a leaked listener is invisible except as wasted
CPU, which is why Session.listenerCount exists.

Generated with AI

Co-Authored-By: SLAC AI')"
```

---

## Task 9: Documentation

**Files:**
- Modify: `README.md`, `docs/HANDOFF.md`, `docs/live-testing.md`

- [ ] **Step 1: Fix the README's four places**

`433f62d` added the "IND$FILE IS SCRIPT-ONLY" entry across four places, and **all four are now wrong**. Find them:

```bash
cd /home/a/athor/git/tn3270
grep -n "script-only\|SCRIPT-ONLY\|no interactive front end" README.md
```

Each needs updating to "reachable from the TUI; the GUI and browser are stages 3 and 4". **Check the status blurb, the feature summary, the CLI command entry and the *What is not implemented* bullet** — this project's recurring documentation defect is that a fix reaches the prose body and never the heading, blurb or expected-count that summarises it.

Add to the TUI's key list: `Ctrl-T` opens the transfer form. Add the two honest limits:
- **CUT needs 24x80**, so a session at `-model 3278-4-E` refuses and names the restart.
- **`Lrecl` is silently ignored for `Recfm=V` on VM**, measured, so a `V 80` readback is not confirmation the input took effect.

- [ ] **Step 2: Update the roadmap item**

The README's "Remaining, in the order the author wants it" list needs the transfer stages. Stage 1 is done; 2 (DFT), 3 (GUI) and 4 (web gateway) remain.

- [ ] **Step 3: Rewrite `docs/HANDOFF.md`'s START HERE**

Replace its opening section with the state after this branch: what shipped, the new packages, the gate numbers measured on the merge commit, and what is NOT verified (no live run yet, if Task 10 has not happened). Leave superseded text in place and mark it, which is this file's practice.

- [ ] **Step 4: Commit**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "docs: IND$FILE is reachable from the TUI, and four stale README claims

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 10: The full gate, then the live run

- [ ] **Step 1: Force-rebuild and run the whole fast gate**

```bash
cd /home/a/athor/git/tn3270
npx tsc --build --force packages/gui packages/web
npm run build && npm run typecheck
./node_modules/.bin/vitest run --reporter=basic 2>&1 | tail -5
```

Expected: build and typecheck silent; the test total up from 1869 by however many this branch added (roughly 1910+ in 78 files). **Record the real number** — a plan's predicted count is not evidence.

- [ ] **Step 2: Run every by-hand harness**

None is in `npm test`. All must pass:

```bash
cd /home/a/athor/git/tn3270
node packages/gui/scripts/shot.mjs            # 3/3 goldens
node packages/gui/scripts/keys.mjs            # 18 chords, 16 actions
node packages/gui/scripts/clicks.mjs          # 9 buttons, 10 actions
node packages/web/scripts/browser-keys.mjs    # 13 chords, 11 actions
node packages/web/scripts/browser-shot.mjs    # 2/2 cases
python3 packages/tui/scripts/pty-smoke.py     # 12/12
python3 packages/cli/scripts/drive-playback.py # 10/10
python3 packages/cli/scripts/drive-e.py       # 10/10
```

Xvfb must be running for the first five: start it with `nohup` and **prove the socket** with `[ -S /tmp/.X11-unix/X99 ]` — never `pgrep -f "Xvfb :99"`, which matches the shell command containing the pattern. `drive-playback.py` needs the out-of-tree suite3270 build and `source /opt/lsst/software/stack/loadLSST.bash`.

**The keypad key added in Task 3 may move `clicks.mjs`'s expectations and the keypad golden.** A 48th button changes the keypad's drawn width or row content, so `shot.mjs`'s `synthetic-ispf-keypad` golden and `browser-shot.mjs`'s second case may legitimately need regenerating. **Regenerate only after confirming by eye that the change is the new button and nothing else** — a golden updated on faith is a golden that asserts nothing.

- [ ] **Step 3: The live run**

Against VM at `-model 3278-2-E`, the only geometry CUT accepts. The committed `packages/cli/scripts/transfer-vm.txt` round trip is the oracle: **the form must produce the same transfer.**

**Prove the session's state before trusting the run.** Type `QUERY DISK A` first: `Ready;` means CMS and the run counts, `?CP: QUERY` means the account was left logged on, the run is void, and you are in the VM reconnect trap. **Reach `LOGOFF`** and check the log for `LOGOFF AT` — a failed transfer never reaches its own logoff and hands the trap to the next run.

Quote `HostFile` on CMS (`HostFile="PROFILE EXEC A"`): the argument splitter treats spaces as separators.

Record in `docs/live-testing.md`: the file, both directions, byte-identical or not, and the exact form input. **A transfer that reports success and writes a wrong file is the failure mode to check for** — compare bytes, not the status line.

- [ ] **Step 4: Commit the live results, then merge**

```bash
cd /home/a/athor/git/tn3270
git add -A
git commit -m "docs: the TUI transfer form against live VM/CMS

Generated with AI

Co-Authored-By: SLAC AI"
```

Then merge with `--no-ff`, as the last five features did, and **re-run the whole gate on the merge commit itself** — not only on the branch. A merge rewrites mtimes, so force-rebuild `packages/gui packages/web` first or the staleness guards redden on mtimes alone.

---

## Self-review against the spec

Checked each spec section against a task:

| spec section | task |
|---|---|
| Where the shared code moves | Task 1 |
| The form model lives in `frontend`, the renderer in the TUI | Tasks 4, 6 |
| Fields (all ten, with defaults and widths) | Task 4 step 3 |
| `Host` is explicit, no detection | Task 4 (a `host` cycle field; no detection code anywhere) |
| Applicability from the validator's rules (five) | Task 4 steps 5, 7 |
| Inapplicable values CLEARED | Task 4 step 5, `clearInapplicable` |
| THE CENTRAL RULE: the form never validates | Task 4 (`formKeywords` → `parseTransferKeywords`; the "produces keywords the validator accepts" test), Task 8 (`submitTransfer` surfaces the validator's own message) |
| `Lrecl` with `Recfm=V` stays enabled | Task 4 step 5, the explicit test with both hosts' measurements |
| Key routing, `Ctrl-T`, `overlayShown`, ESC through the timer | Tasks 3, 7 |
| `overlayFits` gets a sibling | Task 6 (`TRANSFER_MIN`, `transferFits`) |
| Lifecycle: four states, error keeps form open | Tasks 6 (phases), 8 (`submitTransfer`) |
| 24x80 check at submit, naming the remedy | Task 8 step 4 and its first test |
| Progress while running | Tasks 6 (status line), 8 (`onProgress`) |
| Cancellation needs a public method | Task 5 — **and the plan corrects the spec here**: a wrapper, not a visibility change |
| The filesystem seam / `packages/node-files` | Task 2, including the falsified typecheck wiring |
| Testing (all six bullets) | Tasks 2, 4, 6, 7, 8, 10 |
| Out of scope (DFT, GUI, web, Space/Units/Avblock, file browser) | Nothing in any task touches them |

**One spec correction, recorded in Task 5:** the spec's "expose it" for `CutTransfer.abort` is insufficient — `abort` is the internal error path with a two-argument signature no external caller can supply. The plan adds a `cancel(screen)` wrapper instead and explains why.

**Two places the plan deliberately tells the implementer to resolve something rather than guessing:** the `KeypadKey` doc-comment rule that `transferForm` contradicts (Task 3 step 6), and whether `cycleTransfer` can leave the selection on a now-inapplicable field (Task 7 step 4(g) — it can).
