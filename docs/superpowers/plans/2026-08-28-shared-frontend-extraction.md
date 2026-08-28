# Shared front-end library extraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `packages/frontend` and move the front-end rules that `cli` and `tui`
already share — host-argument parsing, TLS flags, the session factory, the keymap and the
action dispatch — into it, so the coming Electron GUI consumes one copy instead of a
third.

**Architecture:** A new composite-TypeScript workspace package between `core` and the
front ends, giving `core ← frontend ← { cli, tui, gui }`. Nothing changes behaviour: this
is a move, and the existing suite is the evidence.

**Tech Stack:** TypeScript 7 project references, npm workspaces, vitest.

---

## READ THIS BEFORE TASK 1

**This plan is mostly a REFACTOR, and refactors invert the usual TDD order.** For a task
that only moves code, there is no failing test to write first — the correct verification
is that **the existing 1202 tests pass with their assertions unchanged**. Writing a new
test that asserts "the import still works" would be a tautology. Where this plan does add
new code (Tasks 6 and 7), it is test-first in the normal way, and says so.

**Two rules that come from this project's own history, so do not skip them:**

1. **No re-export shims.** When a symbol moves out of `cli`, delete it from
   `packages/cli/src/index.ts`. Leaving a second path to the same symbol is precisely the
   drift this refactor exists to prevent — `splitTarget` sat beside the `hostspec.ts` that
   superseded it for a day and the two front ends disagreed the whole time.
2. **Find importers by grepping, not by trusting this plan's file lists.** The lists here
   were accurate on 2026-08-28. Each task includes the grep. **The source beats the task
   text**; if they disagree, the source is right and the plan is wrong.

**The baseline to hold.** Before starting, record it:

```bash
cd ~/git/tn3270
npx vitest run 2>&1 | tail -3
npm run typecheck && npm run build
```

Expected: `Test Files 41 passed (41)`, `Tests 1202 passed (1202)`, typecheck and build
silent. **If this is not what you see, stop** — every task below verifies against it.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/frontend/package.json` | Manifest, depends on `@tn3270/core` only |
| `packages/frontend/tsconfig.json` | Composite project referencing `../core` |
| `packages/frontend/src/index.ts` | Public surface of the shared library |
| `packages/frontend/src/hostspec.ts` | `[prefix:][LU,LU@]host[:port]` parsing — moved from `cli` |
| `packages/frontend/src/tls.ts` | TLS flags, `tcpConnect`, error messages — moved from `cli` |
| `packages/frontend/src/session.ts` | `defaultSession` — extracted from `cli/src/runner.ts` |
| `packages/frontend/src/keymap.ts` | Terminal byte sequences → `Action` — moved from `tui` |
| `packages/frontend/src/actions.ts` | `Action` dispatch onto `Session`/`Keyboard` — extracted from `tui/src/app.ts` |
| `packages/frontend/src/bindings.ts` | Binding-intent table: which key means which action |

Tests live in `packages/frontend/test/` and are discovered automatically —
`vitest.config.ts` already globs `packages/*/test/**/*.test.ts`, so **no vitest config
change is needed**. The root `typecheck` script does need the new package added.

---

## Task 1: Create the empty package and wire it into the build

**Files:**
- Create: `packages/frontend/package.json`
- Create: `packages/frontend/tsconfig.json`
- Create: `packages/frontend/src/index.ts`
- Modify: `package.json` (the `typecheck` script)

- [ ] **Step 1: Create the manifest**

`packages/frontend/package.json`. Copied from `packages/cli/package.json` minus the `bin`
entry — this is a library, not a command.

```json
{
  "name": "@tn3270/frontend",
  "version": "0.1.0",
  "license": "MIT",
  "author": "Adam Thornton <athornton@gmail.com>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js"
  },
  "dependencies": {
    "@tn3270/core": "0.1.0"
  },
  "scripts": {
    "build": "tsc --build"
  }
}
```

- [ ] **Step 2: Create the tsconfig**

`packages/frontend/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **Step 3: Create a placeholder public surface**

`packages/frontend/src/index.ts`. It needs at least one export or `tsc` emits an empty
module and the package cannot be imported:

```typescript
/**
 * Rules shared by every front end: the host argument, the TLS flags, the session
 * factory, the keymap and the action dispatch.
 *
 * WHY THIS PACKAGE EXISTS. Two front ends already shared these by importing them from
 * `@tn3270/cli`, which was the wrong home the moment a third front end appeared: a GUI
 * has no business depending on the s3270 line protocol to find out what `-insecure`
 * means. Both defects fixed on 2026-08-28 were one rule with two homes -- `splitTarget`
 * beside `hostspec.ts`, and `-insecure` drifting between the two arg parsers until
 * `harness-flags.test.ts` pinned it.
 *
 * WHAT DOES NOT BELONG HERE. Anything a front end owns because of HOW it presents:
 * ANSI generation, SGR depth, canvas geometry, the s3270 reply format. If a symbol here
 * would be used by exactly one front end, it is in the wrong package.
 */

/** Placeholder so the module is non-empty until Task 2 lands. Removed there. */
export const FRONTEND_PACKAGE = '@tn3270/frontend';
```

- [ ] **Step 4: Add the package to the typecheck script**

In the root `package.json`, the `typecheck` script names its projects explicitly. Change:

```json
    "typecheck": "tsc --build packages/core packages/cli packages/tui"
```

to:

```json
    "typecheck": "tsc --build packages/core packages/frontend packages/cli packages/tui"
```

- [ ] **Step 5: Install the workspace link**

```bash
cd ~/git/tn3270 && npm install
```

Expected: npm adds `node_modules/@tn3270/frontend` as a symlink. No package downloads.

- [ ] **Step 6: Verify nothing broke**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
```

Expected: silent typecheck and build; `Tests 1202 passed (1202)`. The count is unchanged
because no test moved yet.

- [ ] **Step 7: Commit**

```bash
git add packages/frontend package.json package-lock.json
git commit -m "build: add the empty @tn3270/frontend package"
```

---

## Task 2: Move `hostspec.ts`

**Files:**
- Create: `packages/frontend/src/hostspec.ts` (moved)
- Delete: `packages/cli/src/hostspec.ts`
- Create: `packages/frontend/test/hostspec.test.ts` (moved)
- Delete: `packages/cli/test/hostspec.test.ts`
- Modify: `packages/frontend/src/index.ts`, `packages/cli/src/index.ts`,
  `packages/cli/src/runner.ts`, `packages/cli/package.json`, `packages/cli/tsconfig.json`

- [ ] **Step 1: Find every importer, rather than trusting this list**

```bash
cd ~/git/tn3270
grep -rn "hostspec\|parseHostSpec\|resolveHostSpec\|ResolvedHost" \
  packages/*/src packages/*/test --include="*.ts"
```

On 2026-08-28 this reported: `cli/src/runner.ts` (imports `resolveHostSpec`),
`cli/src/index.ts` (re-exports both), `cli/test/hostspec.test.ts`, `cli/test/tls.test.ts`
(imports `resolveHostSpec` directly from `../src/hostspec.js`), and comments in
`cli/src/tls.ts` and `tui/src/main.ts`. **Work from your grep output, not from this
sentence.**

- [ ] **Step 2: Move the files with git, so history follows**

```bash
cd ~/git/tn3270
git mv packages/cli/src/hostspec.ts packages/frontend/src/hostspec.ts
git mv packages/cli/test/hostspec.test.ts packages/frontend/test/hostspec.test.ts
```

- [ ] **Step 3: Make `cli` depend on `frontend`**

`packages/cli/package.json` — add the dependency:

```json
  "dependencies": {
    "@tn3270/core": "0.1.0",
    "@tn3270/frontend": "0.1.0"
  },
```

`packages/cli/tsconfig.json` — add the project reference:

```json
  "references": [{ "path": "../core" }, { "path": "../frontend" }]
```

Then `npm install` to link it.

- [ ] **Step 4: Export it from `frontend`**

Replace the placeholder in `packages/frontend/src/index.ts`:

```typescript
export { parseHostSpec, resolveHostSpec } from './hostspec.js';
export type { HostSpec, ResolvedHost } from './hostspec.js';
```

Delete the `FRONTEND_PACKAGE` placeholder line and its comment.

- [ ] **Step 5: Update the importers**

`packages/cli/src/runner.ts` — change:

```typescript
import { resolveHostSpec } from './hostspec.js';
```

to:

```typescript
import { resolveHostSpec } from '@tn3270/frontend';
```

`packages/cli/src/index.ts` — DELETE these lines entirely. Do not replace them with a
re-export from `frontend`; that is the shim rule:

```typescript
// Host-argument shape, shared for the same reason the TLS flags are: `N:` and an LU
// list must mean the same thing in both front ends. See resolveHostSpec.
export { parseHostSpec, resolveHostSpec } from './hostspec.js';
export type { HostSpec, ResolvedHost } from './hostspec.js';
```

`packages/frontend/test/hostspec.test.ts` — its import already reads `../src/hostspec.js`
and is correct in the new location, so **leave it alone**. This is the point: assertions
unchanged.

`packages/cli/test/tls.test.ts` — change its `resolveHostSpec` import to
`@tn3270/frontend`.

- [ ] **Step 6: Verify**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
```

Expected: `Test Files 41 passed (41)`, `Tests 1202 passed (1202)` — the same numbers.
A test file moved between packages but the glob covers both, so the count does not move.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move hostspec into @tn3270/frontend"
```

---

## Task 3: Move `tls.ts`

`tls.test.ts` covers two different things — the flag/prefix rules that are moving, and
`Runner` behaviour that is not — so the file is **split**, not moved.

**Files:**
- Create: `packages/frontend/src/tls.ts` (moved)
- Delete: `packages/cli/src/tls.ts`
- Create: `packages/frontend/test/tls.test.ts` (the flag and prefix cases)
- Modify: `packages/cli/test/tls.test.ts` (keeps the Runner cases)
- Modify: `packages/frontend/src/index.ts`, `packages/cli/src/index.ts`,
  `packages/cli/src/runner.ts`, `packages/cli/src/main.ts`, `packages/tui/src/main.ts`

- [ ] **Step 1: Find every importer**

```bash
cd ~/git/tn3270
grep -rn "from '\./tls\.js'\|from '\.\./src/tls\.js'\|takeTlsFlag\|resolveTls\|tcpConnect\|describeTlsError\|TLS_USAGE\|DEFAULT_TLS\|TlsOptions\|TlsFlags" \
  packages/*/src packages/*/test --include="*.ts"
```

- [ ] **Step 2: Move the module**

```bash
git mv packages/cli/src/tls.ts packages/frontend/src/tls.ts
```

- [ ] **Step 3: Export from `frontend`**

Append to `packages/frontend/src/index.ts`:

```typescript
// The TLS flags: every front end parses the same ones and must resolve them by the same
// rules. `tcpConnect` comes too, because it is the one transport all of them need.
export {
  takeTlsFlag, resolveTls, tcpConnect, describeTlsError,
  DEFAULT_TLS, HANDSHAKE_TIMEOUT_MS, TLS_USAGE,
} from './tls.js';
export type { TlsFlags, TlsOptions } from './tls.js';
```

- [ ] **Step 4: Update importers**

- `packages/cli/src/runner.ts`: `from './tls.js'` → `from '@tn3270/frontend'`.
- `packages/cli/src/main.ts`: same change for whatever it imports (the grep in Step 1
  shows exactly which symbols).
- `packages/cli/src/index.ts`: DELETE the `./tls.js` export block and its comment. No shim.
- `packages/tui/src/main.ts`: it currently takes `takeTlsFlag`, `resolveTls`, `TLS_USAGE`,
  `TlsFlags`, `TlsOptions` (and `resolveHostSpec`, `defaultSession`) from
  `@tn3270/cli`. Move the TLS and hostspec names to `@tn3270/frontend`, leaving
  `defaultSession` on `@tn3270/cli` **until Task 4 moves it**. Two import statements for
  one task is fine; Task 4 collapses them.
- `packages/tui/package.json` and `tsconfig.json`: add the `@tn3270/frontend` dependency
  and project reference, then `npm install`.

- [ ] **Step 5: Split the test file**

Create `packages/frontend/test/tls.test.ts` and move into it, VERBATIM, the `describe`
blocks that test the moved code: the TLS flag parsing, `describeTlsError`, and
`s3270's L: host prefix` **except** its final case. Fix the import paths to
`../src/tls.js` and `../src/hostspec.js`.

Two cases stay in `packages/cli/test/tls.test.ts` because they exercise `Runner`, which is
not moving:

- `is refused by the runner on an -insecure session, where the host arrives later`
- anything else constructing a `Runner` or a `Session`

`packages/cli/test/tls-harness.test.ts` spawns the openssl proxy and tests `tcpConnect`
against it. **Move it to `packages/frontend/test/tls-harness.test.ts`** — it follows its
subject. Check whether it references `packages/cli/scripts/tls-proxy.mjs` by relative
path; if so, the path must be updated to reach across packages, and the scripts stay in
`packages/cli/scripts` (they are invoked by the CLI's own runbook).

- [ ] **Step 6: Verify, and expect the SAME test total**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
```

Expected: `Tests 1202 passed (1202)`. **A changed total means a test was dropped or
duplicated in the split — find it before committing.** That is the one real risk in this
task.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move the TLS flags into @tn3270/frontend"
```

---

## Task 4: Move `defaultSession`

`defaultSession` is the only part of `packages/cli/src/runner.ts` that is not the s3270
command loop, and it is what a front end needs to build a `Session` on the real transport.

**Files:**
- Create: `packages/frontend/src/session.ts`
- Modify: `packages/cli/src/runner.ts` (remove `defaultSession`, import it instead),
  `packages/cli/src/index.ts`, `packages/cli/src/main.ts`, `packages/tui/src/main.ts`,
  `packages/frontend/src/index.ts`

- [ ] **Step 1: Find its users**

```bash
grep -rn "defaultSession" packages/*/src packages/*/test --include="*.ts"
```

- [ ] **Step 2: Create the new module**

`packages/frontend/src/session.ts`. Move the whole `defaultSession` function and **its
entire doc comment** across — the comment explains why `tls` defaults to `DEFAULT_TLS`
rather than plaintext, which is a security argument and must not be left behind:

```typescript
import { Session } from '@tn3270/core';
import { tcpConnect, DEFAULT_TLS, type TlsOptions } from './tls.js';

/**
 * A session whose socket is TLS unless told otherwise.
 *
 * `tls` defaults to `DEFAULT_TLS` — verified TLS — because that is the product
 * default, and a default argument that meant plaintext would make every caller
 * that forgot the parameter silently insecure. `-insecure` passes
 * `{ kind: 'plaintext' }` explicitly.
 */
export function defaultSession(
  terminalType?: string,
  tls: TlsOptions = DEFAULT_TLS,
  /**
   * The model's ALTERNATE screen size, from `resolveAlternateSize`. Absent leaves
   * the session a model 2, where the alternate size equals the default 24x80.
   */
  alternate?: { readonly rows: number; readonly cols: number },
  /**
   * Offer TN3270E. Absent means the product default, which is ON -- matching x3270,
   * and safe because the negotiation backs off to traditional tn3270 on a reject.
   */
  tn3270e?: boolean,
): Session {
  return new Session({
    connect: (h, p) => tcpConnect(h, p, tls),
    ...(terminalType ? { terminalType } : {}),
    ...(tn3270e === undefined ? {} : { tn3270e }),
    ...(alternate !== undefined
      ? { alternateRows: alternate.rows, alternateCols: alternate.cols }
      : {}),
  });
}
```

- [ ] **Step 3: Delete it from `runner.ts`**

Remove the function and its comment from `packages/cli/src/runner.ts`. `runner.ts` no
longer needs `DEFAULT_TLS`; check whether it still uses `tcpConnect` and `TlsOptions`
(it does, for `RunnerOptions`), and keep only what remains referenced. The compiler will
tell you — an unused import is an error under this tsconfig.

- [ ] **Step 4: Export and re-point**

Append to `packages/frontend/src/index.ts`:

```typescript
export { defaultSession } from './session.js';
```

In `packages/cli/src/index.ts`, change `export { defaultSession, Runner } from
'./runner.js';` to `export { Runner } from './runner.js';` — again, **no shim** for
`defaultSession`.

Update `packages/cli/src/main.ts` and `packages/tui/src/main.ts` to import
`defaultSession` from `@tn3270/frontend`. The TUI's two import statements from Task 3 now
collapse into one from `@tn3270/frontend` plus whatever it still needs from
`@tn3270/cli` — which, after this task, may be nothing. **If it is nothing, remove the
`@tn3270/cli` dependency from `packages/tui/package.json` and the project reference from
its tsconfig.** That is the refactor paying off, and leaving a dead dependency edge would
hide it.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
```

Expected: `Tests 1202 passed (1202)`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move defaultSession into @tn3270/frontend"
```

---

## Task 5: Move `keymap.ts`

**MOVE IT, DO NOT REWRITE IT.** Its 212 lines were measured with `tput -T
xterm-256color` on this box, and two entries exist because measurement contradicted the
plan: arrows and Home have both SS3 (`\x1bOA`) and CSI (`\x1b[A`) encodings and both must
stay, and F7-F11 are `18/19/20/21/23~` with no `22~`. Re-deriving it into an
encoding-neutral form would risk a live-verified table for nothing. The GUI will get a
**separate** `KeyboardEvent` mapper beside it, not a shared abstraction over it.

**Files:**
- Create: `packages/frontend/src/keymap.ts` (moved)
- Delete: `packages/tui/src/keymap.ts`
- Create: `packages/frontend/test/keymap.test.ts` (moved)
- Delete: `packages/tui/test/keymap.test.ts`
- Modify: `packages/frontend/src/index.ts`, `packages/tui/src/app.ts`

- [ ] **Step 1: Find importers**

```bash
grep -rn "keymap\|lookup\|MAX_SEQUENCE_LENGTH\|PARTIAL\|printableRun\|isValidPf\|type Action" \
  packages/*/src packages/*/test --include="*.ts"
```

Expect `tui/src/app.ts` and `tui/test/keymap.test.ts`. Note `app.test.ts` may import
`Action` too.

- [ ] **Step 2: Move**

```bash
git mv packages/tui/src/keymap.ts packages/frontend/src/keymap.ts
git mv packages/tui/test/keymap.test.ts packages/frontend/test/keymap.test.ts
```

- [ ] **Step 3: Export from `frontend`**

Append to `packages/frontend/src/index.ts`:

```typescript
// The terminal keymap. Shared for its ACTION VOCABULARY, which every front end needs;
// the byte-sequence table itself is terminal-specific and the GUI has its own mapper
// beside it. See keymap.ts on why the table is moved rather than generalised.
export { lookup, printableRun, isValidPf, PARTIAL, MAX_SEQUENCE_LENGTH } from './keymap.js';
export type { Action } from './keymap.js';
```

- [ ] **Step 4: Update `tui/src/app.ts`**

Change:

```typescript
import { lookup, MAX_SEQUENCE_LENGTH, PARTIAL, printableRun, type Action } from './keymap.js';
```

to:

```typescript
import { lookup, MAX_SEQUENCE_LENGTH, PARTIAL, printableRun, type Action } from '@tn3270/frontend';
```

The moved test's import (`../src/keymap.js`) is already correct in its new home.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
```

Expected: `Tests 1202 passed (1202)`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move the terminal keymap into @tn3270/frontend"
```

---

## Task 6: Extract the action dispatch

**New code, so this one IS test-first.** The dispatch currently lives inside
`App.apply()` at `packages/tui/src/app.ts:372-407`, mixed with two things a shared
function must not own: the `quit` case, which restores the terminal and calls
`host.exit(0)`, and the `draw()` at the end.

**The `quit` case does not move.** Teardown is the front end's: the TUI restores raw mode,
and the GUI will close a window. The front end tests for `quit` itself and delegates
everything else.

**Files:**
- Create: `packages/frontend/src/actions.ts`
- Create: `packages/frontend/test/actions.test.ts`
- Modify: `packages/tui/src/app.ts`, `packages/frontend/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/frontend/test/actions.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Session, AID, type Connection } from '@tn3270/core';
import { applyAction } from '../src/actions.js';

class FakeConnection implements Connection {
  sent: number[] = [];
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;
  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.onClose?.(); }
}

function newSession() {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn });
  return { session, conn };
}

describe('applyAction', () => {
  it('sends the Enter AID', async () => {
    const { session, conn } = newSession();
    await session.connect('h', 23);
    conn.sent = [];
    applyAction(session, { kind: 'enter' });
    expect(conn.sent).toContain(AID.ENTER);
  });

  it('sends PF3 as its own AID, not PF1 plus an offset', () => {
    // The `n - 1` index is the kind of thing that survives a move looking correct and
    // being wrong by one, so the AID is asserted by value.
    const { session, conn } = newSession();
    applyAction(session, { kind: 'pf', n: 3 });
    expect(conn.sent[0]).toBe(0xf3);        // PF3
  });

  it('types into the screen through the keyboard', () => {
    const { session } = newSession();
    applyAction(session, { kind: 'type', text: 'HI' });
    // No assertion about the wire: typing is local until an AID is sent. The keyboard
    // owns whether it was allowed, and it says so in the OIA.
    expect(session.oia.toText()).toBeTypeOf('string');
  });

  it('SWALLOWS a rejected action rather than throwing', () => {
    // A rejected action -- not connected, program check -- is normal operation, not a
    // crash. This is the behaviour the TUI relied on, and moving the dispatch must not
    // turn it into an exception that reaches the run loop.
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'enter' })).not.toThrow();
  });

  it('REFUSES to handle quit, which is the front end s own business', () => {
    // Teardown differs per front end: the TUI restores raw mode, the GUI closes a
    // window. A shared dispatch that silently ignored `quit` would make a front end
    // that forgot to check it simply unquittable, so it throws instead.
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'quit' })).toThrow(/quit/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run packages/frontend/test/actions.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/actions.js"`.

- [ ] **Step 3: Implement**

`packages/frontend/src/actions.ts`:

```typescript
import { AID, PA_AIDS, PF_AIDS, type Session } from '@tn3270/core';
import type { Action } from './keymap.js';

/**
 * Apply one named action to a session.
 *
 * ## THIS FILE DECIDES NOTHING ABOUT 3270 SEMANTICS
 *
 * The field-aware typing rules, the tab order, the keyboard lock and the AID semantics
 * all live in core and are tested there. If a branch here grows logic, that logic is in
 * the wrong package. It is shared because it is the one translation every front end
 * needs and none of them should own: the CLI's command table, the TUI's keymap and the
 * GUI's KeyboardEvent mapper all produce these same names.
 *
 * ## `quit` IS NOT HANDLED HERE, AND THROWS RATHER THAN BEING IGNORED
 *
 * Teardown is the front end's: the TUI restores raw mode on every exit path, the GUI
 * closes a window. Silently ignoring `quit` would leave a front end that forgot to check
 * for it simply unquittable, and that failure would show up as a hang rather than an
 * error. Callers test for it before delegating.
 *
 * ## A REJECTED ACTION IS SWALLOWED
 *
 * Not connected, or a program check, is normal operation rather than a crash — and the
 * OIA already says why, so the caller's redraw shows it. `typeString` is different again:
 * it REPORTS refusal by returning false rather than throwing, so there is nothing to
 * catch and nothing to do.
 */
export function applyAction(session: Session, action: Action): void {
  if (action.kind === 'quit') {
    throw new Error('applyAction does not handle quit: the front end owns its own teardown');
  }
  const k = session.keyboard;
  try {
    switch (action.kind) {
      case 'type': k.typeString(action.text); break;
      case 'enter': session.sendAID(AID.ENTER); break;
      case 'clear': session.sendAID(AID.CLEAR); break;
      case 'pf': session.sendAID(PF_AIDS[action.n - 1]!); break;
      case 'pa': session.sendAID(PA_AIDS[action.n - 1]!); break;
      case 'reset': k.reset(); break;
      case 'left': k.left(); break;
      case 'right': k.right(); break;
      case 'up': k.up(); break;
      case 'down': k.down(); break;
      case 'home': k.home(); break;
      case 'tab': k.tab(); break;
      case 'backTab': k.backTab(); break;
      case 'backspace': k.backspace(); break;
      case 'delete': k.deleteChar(); break;
      case 'eraseEOF': k.eraseEOF(); break;
      case 'eraseInput': k.eraseInput(); break;
    }
  } catch (err) {
    void err;
  }
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run packages/frontend/test/actions.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Export it**

Append to `packages/frontend/src/index.ts`:

```typescript
export { applyAction } from './actions.js';
```

- [ ] **Step 6: Rewrite `App.apply` to delegate**

In `packages/tui/src/app.ts`, replace the body of `apply` with:

```typescript
  private apply(action: Action): void {
    if (action.kind === 'quit') {
      this.quitting = true;
      this.restore();
      this.host.exit(0);
      return;                    // no draw: the terminal is no longer ours
    }
    applyAction(this.session, action);
    this.draw();
  }
```

Add `applyAction` to the `@tn3270/frontend` import. Then remove whatever is now unused —
`AID`, `PF_AIDS`, `PA_AIDS` are likely no longer referenced in `app.ts`, and the tsconfig
makes an unused import an error, so the compiler will name them.

Keep the doc comment above `apply` that explains the swallow and the "logic here is in the
wrong package" rule, trimmed to what still applies locally.

- [ ] **Step 7: Verify the TUI is unchanged**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
```

Expected: `Tests 1207 passed (1207)` — 1202 plus the five new ones. **`app.test.ts` must
pass untouched**: it is the evidence that delegating did not change behaviour, and if it
needed editing, something moved that should not have.

- [ ] **Step 8: Prove the extraction against the real terminal**

The unit tests do not cover raw mode or the run loop, and this task touched the keystroke
path of a live-verified front end:

```bash
npm run build && python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -14
```

Expected: 12 PASS lines, including `echoed the typed characters back to the screen` —
which is the one that exercises `apply` end to end.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract the action dispatch into @tn3270/frontend"
```

---

## Task 7: The binding-intent table

One place that states which key means which action, in words rather than encodings, so
that the GUI's mapper and the terminal keymap can be checked against the same intent. It
is **documentation with a test**, not a code generator: neither front end derives its
table from it.

**Files:**
- Create: `packages/frontend/src/bindings.ts`
- Create: `packages/frontend/test/bindings.test.ts`
- Modify: `packages/frontend/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/frontend/test/bindings.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { BINDING_INTENT } from '../src/bindings.js';
import { lookup, PARTIAL } from '../src/keymap.js';

const bytes = (s: string): Uint8Array =>
  Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 0xff));

describe('BINDING_INTENT', () => {
  it('names an action for every entry, with no duplicates', () => {
    const keys = BINDING_INTENT.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const b of BINDING_INTENT) expect(b.action.kind).toBeTruthy();
  });

  it('agrees with the TERMINAL keymap wherever the entry gives a sequence', () => {
    // This is the assertion that gives the table teeth. An entry that claims Ctrl-R is
    // Reset, against a keymap that says otherwise, is a contradiction one of the two
    // front ends would inherit.
    for (const b of BINDING_INTENT) {
      if (b.terminal === undefined) continue;
      const got = lookup(bytes(b.terminal));
      expect(got, `${b.key} -> ${b.terminal.replace(/\x1b/g, 'ESC')}`).not.toBe(PARTIAL);
      expect(got, b.key).not.toBeNull();
      expect((got as { kind: string }).kind, b.key).toBe(b.action.kind);
    }
  });

  it('covers Clear, Reset and Enter, the three a 3270 user cannot work without', () => {
    const kinds = BINDING_INTENT.map((b) => b.action.kind);
    for (const needed of ['clear', 'reset', 'enter']) expect(kinds).toContain(needed);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run packages/frontend/test/bindings.test.ts
```

Expected: FAIL — cannot resolve `../src/bindings.js`.

- [ ] **Step 3: Implement**

`packages/frontend/src/bindings.ts`:

```typescript
import type { Action } from './keymap.js';

/**
 * Which key means which action, stated once in words.
 *
 * NOT A CODE GENERATOR, and deliberately so. The terminal keymap is a table of measured
 * byte sequences and the GUI's mapper matches Chromium `KeyboardEvent`s; deriving either
 * from this would mean re-expressing a live-verified table in a form nothing has tested.
 * What this gives instead is one place to read the INTENT, plus a test that the terminal
 * keymap agrees with it -- so a key added to one front end is visibly absent from the
 * other.
 *
 * `terminal` is the byte sequence the terminal keymap should return this action for, or
 * `undefined` where the binding is GUI-only or where the terminal encodes it in more than
 * one way (the arrows have both SS3 and CSI forms, so a single expected sequence would
 * assert less than the keymap's own tests already do).
 *
 * Ctrl-C is Clear and NOT an interrupt, which is correct for a 3270 and surprising to
 * everyone: a 3270 user needs it constantly to dismiss VM's `MORE...` state. Ctrl-] is
 * therefore the way out, and every front end must say so on startup -- an undocumented
 * escape hatch is no escape hatch.
 */
export interface Binding {
  /** How a user would describe the key. */
  readonly key: string;
  readonly action: Action;
  /** The terminal byte sequence, where a single one exists. */
  readonly terminal?: string;
  /** Why this binding, where it is not obvious. */
  readonly note?: string;
}

export const BINDING_INTENT: readonly Binding[] = Object.freeze([
  { key: 'Enter', action: { kind: 'enter' }, terminal: '\r' },
  {
    key: 'Ctrl-C', action: { kind: 'clear' }, terminal: '\x03',
    note: 'the Clear AID, not an interrupt: it dismisses VM\'s MORE... state',
  },
  { key: 'Ctrl-R', action: { kind: 'reset' }, terminal: '\x12' },
  { key: 'Tab', action: { kind: 'tab' }, terminal: '\t' },
  { key: 'Backspace', action: { kind: 'backspace' }, terminal: '\x7f' },
]);
```

**Add entries only where you have checked the keymap agrees.** The test compares each
`terminal` sequence against `lookup`, so a guessed byte fails immediately — which is the
point. Grow the table by reading `keymap.ts`, not from memory.

- [ ] **Step 4: Run the test**

```bash
npx vitest run packages/frontend/test/bindings.test.ts
```

Expected: PASS, 3 tests. **If the second test fails, believe the keymap** — it was
measured with `tput` and this table was typed by hand.

- [ ] **Step 5: Export**

Append to `packages/frontend/src/index.ts`:

```typescript
export { BINDING_INTENT } from './bindings.js';
export type { Binding } from './bindings.js';
```

- [ ] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run build && npx vitest run 2>&1 | tail -3
git add -A
git commit -m "feat(frontend): a binding-intent table, checked against the terminal keymap"
```

---

## Task 8: The final gate

**Files:**
- Modify: `README.md` (the *Layout* section), `docs/HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-08-28-shared-frontend-extraction.md` (check the boxes)

- [ ] **Step 1: Prove no shim survived**

```bash
cd ~/git/tn3270
grep -rn "hostspec\|tls\.js\|keymap" packages/cli/src/index.ts
```

Expected: **no output.** Any hit is a second path to a moved symbol.

```bash
ls packages/cli/src/hostspec.ts packages/cli/src/tls.ts packages/tui/src/keymap.ts 2>&1
```

Expected: three `No such file or directory` errors.

- [ ] **Step 2: Confirm the dependency graph is what the design says**

```bash
grep -A4 '"dependencies"' packages/*/package.json
```

Expected: `frontend` depends on `core` only; `cli` on `core` + `frontend`; `tui` on
`frontend` (and on `cli` only if something still genuinely needs it — see Task 4 Step 4).
**`frontend` must not depend on `cli` or `tui`.** That edge would make the graph cyclic in
spirit even if npm tolerated it.

- [ ] **Step 3: The full gate**

```bash
npm run typecheck && npm run build
npx vitest run 2>&1 | tail -3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | grep -c PASS
python3 packages/cli/scripts/drive-e.py 2>&1 | tail -2
```

Expected, in order: silent; `Tests 1210 passed (1210)`; `12`; `7/7 checks passed`.

**Both harnesses matter here specifically.** `pty-smoke.py` exercises the TUI's keystroke
path, which Task 6 rewrote, and `drive-e.py` exercises the CLI's `Connect()`, which now
reaches `resolveHostSpec` across a package boundary. Neither runs under `npm test`, and
this project's history is that such harnesses go stale unnoticed — `pty-smoke.py` sat at
1/12 for two days when TLS went on by default.

- [ ] **Step 4: Update the Layout section of README**

The `packages/` listing gains a line and the existing ones narrow:

```
packages/core      protocol: telnet framing, 3270 parse/execute, screen, keyboard, OIA,
                   colour resolution, Query Reply, IND$FILE, trace
packages/frontend  rules every front end shares: host argument, TLS flags, session
                   factory, keymap, action dispatch
packages/cli       s3270-style scripting CLI
packages/tui       c3270-style terminal front end, plus the live/pty harnesses
packages/fixtures  recorded traces, golden screens, x3270 reference captures
docs/              spec, plans, live-host runbook, handoff
```

- [ ] **Step 5: Update HANDOFF**

Under *Where things stand*, record: `packages/frontend` exists and what moved into it; the
test count; that the move changed no assertions; and that the Electron GUI (part 2 of the
2026-08-28 design) is the next piece of work, with its plan not yet written.

- [ ] **Step 6: Check every box in this plan and commit**

```bash
git add -A
git commit -m "docs: record the frontend extraction, and the gate it passed"
```

---

## Self-review notes

**Spec coverage.** Part 1 of the design has six requirements and each has a task:
`frontend` created (1); `hostspec` (2); `tls` (3); `defaultSession` (4); `keymap` moved
not rewritten (5, and the prohibition is restated in the task); action dispatch extracted
(6); the binding-intent table (7); no shims and the existing suite unchanged (2-6, proven
in 8). Part 2 of the design — `packages/gui` — is deliberately **not** covered here and
needs its own plan.

**Test-count arithmetic, stated so a discrepancy is a signal rather than a puzzle.**
Tasks 1-5 must leave the total at **1202**: files move between packages and the vitest
glob covers both. Task 6 adds 5, so Task 6's own gate expects **1207**; Task 7 adds 3,
so the final total in Task 8 is **1210**. If a total drifts anywhere else, a test was
dropped in the Task 3 split — that is the likeliest place — and it must be found
before the next commit.

**Known risk.** Task 3 is the only task where a test file is split rather than moved, and
a silently dropped `describe` block is the failure mode. Its Step 6 exists for that.
