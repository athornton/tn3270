# Fetch-Ahead Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make web copy work on every gesture (`Ctrl-Shift-C`, `Cmd-C`, Edit > Copy) at every address, including plain `http` at a LAN address, by fetching the selection's text when a drag ends and handing it to the browser's own `copy` event synchronously.

**Architecture:** A DOM-free `copyCache` in `packages/canvas` holds the prefetched text, keyed by rectangle and a generation counter. The browser asks the gateway with a new top-level `selection` message and gets `selectionText` back. The `copy` listener sets that text on `clipboardData`. `Ctrl-Shift-C` raises the event with `document.execCommand('copy')`. Every gesture falls back to today's async `copy` → `copyText` path when the cache is empty.

**Tech Stack:** TypeScript 7 (`tsc --build`), vitest 3 (`environment: 'node'`, no jsdom), Electron 44's Chromium driven over CDP for the browser harnesses, Node 26.

**Spec:** `docs/superpowers/specs/2026-11-02-fetch-ahead-copy-design.md` (commit `04dfa30`).

---

## Read this before any task

- **The source beats this plan.** Every snippet below was derived from the repo at `583a731`, but
  line numbers move and this project's history records plan code being wrong more often than right.
  Before each edit, READ the surrounding code, and match its comment density and idiom. If a
  quoted "old" block does not match the file exactly, stop and reconcile; do not force it.
- **Branch:** `git switch -c fetch-ahead-copy` from `main` (which must be at or after `583a731`).
- **Every commit message ends with:**
  ```
  Generated with AI

  Co-Authored-By: SLAC AI
  ```
- **Commands run from the repo root** `~/git/tn3270`. A wrong directory makes `npx` fetch a
  different tool and report plausible nonsense.
- **vitest does not typecheck.** Run `npm run build` before believing a green suite.
- **Harnesses run SERIALLY**, never two Electrons at once. After any mutation revert, rebuild with
  `npx tsc --build --force packages/<pkg>`; a restored file can have an older mtime, leaving a
  stale `dist/`. **Never `pkill -f electron` from the Bash tool**; it matches its own shell.
- The `my grep`/`find` in this environment may be ugrep/bfs; use `git grep` for anything whose
  flags matter.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/canvas/src/copyCache.ts` | create | Prefetched text, keyed by rect and generation. No DOM. |
| `packages/canvas/test/copyCache.test.ts` | create | Its unit tests. |
| `packages/web/src/protocol.ts` | modify | `selection` (client→server) and `selectionText` (server→client); shared rect check. |
| `packages/web/test/protocol.test.ts` | modify | Decode and encode cases. |
| `packages/web/src/main.ts` | modify | Answer `selection` above the action guard. |
| `packages/web/test/integration.test.ts` | modify | Real-socket cases for `selection`. |
| `packages/web/src/bridgecore.ts` | modify | `BridgeApi.fetchSelection?`, the pending map, `selectionText` routing. |
| `packages/web/test/bridgecore.test.ts` | modify | Its cases. |
| `packages/canvas/src/forwardKeys.ts` | modify | `forwardCopy` sets cached text, or falls back. |
| `packages/canvas/test/forwardKeys.test.ts` | modify | Rewritten `forwardCopy` cases. |
| `packages/canvas/src/renderer.ts` | modify | Own the cache: prefetch on drag end, invalidate, `execCommand` in the chord arm. |
| `packages/web/scripts/browser-clicks.mjs` | modify | Witnesses for the cached path, a fallback check. |
| `packages/web/scripts/browser-lan-copy.mjs` | create | The non-secure-context check, at a LAN address. |
| `packages/web/scripts/read-clipboard.cjs` | create | Reads the OS clipboard from a separate Electron main process. |
| `README.md`, `docs/HANDOFF.md`, `docs/live-testing.md` | modify | What the operator can now do, and the owed live pass. |

---

### Task 1: `copyCache`

**Files:**
- Create: `packages/canvas/src/copyCache.ts`
- Test: `packages/canvas/test/copyCache.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { createCopyCache } from '../src/copyCache.js';

const R = { top: 0, left: 0, bottom: 1, right: 11 };
const OTHER = { top: 2, left: 0, bottom: 3, right: 11 };

describe('copyCache, the prefetched text a copy event hands over synchronously', () => {
  it('has nothing until the answer arrives, then the text for that rect', () => {
    const c = createCopyCache();
    const gen = c.begin(R);
    expect(c.take(R)).toBeUndefined();
    c.accept(gen, ' MENU\n OPTION ===>');
    expect(c.take(R)).toBe(' MENU\n OPTION ===>');
  });

  // A cache filled for one selection must never answer for another: the copy would put text the
  // operator did not select on their clipboard.
  it('answers only for the rect that was asked about', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    expect(c.take(OTHER)).toBeUndefined();
    expect(c.take({ ...R })).toBe('TEXT');
  });

  // THE INTERLEAVING THE GENERATION EXISTS FOR. A new frame clears the selection (invalidate),
  // and the answer extracted from the OLD request arrives after it. It must be dropped even
  // though the operator has since dragged the SAME rect again over a changed screen.
  it('drops an answer that arrives after invalidate, even for the same rect', () => {
    const c = createCopyCache();
    const stale = c.begin(R);
    c.invalidate();
    const fresh = c.begin(R);
    c.accept(stale, 'OLD SCREEN');
    expect(c.take(R)).toBeUndefined();
    c.accept(fresh, 'NEW SCREEN');
    expect(c.take(R)).toBe('NEW SCREEN');
  });

  it('drops an answer superseded by a newer begin', () => {
    const c = createCopyCache();
    const first = c.begin(R);
    const second = c.begin(OTHER);
    c.accept(first, 'FIRST');
    expect(c.take(R)).toBeUndefined();
    expect(c.take(OTHER)).toBeUndefined();
    c.accept(second, 'SECOND');
    expect(c.take(OTHER)).toBe('SECOND');
  });

  // The selection survives a copy, so a second copy must find the same text.
  it('does not consume on take', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    expect(c.take(R)).toBe('TEXT');
    expect(c.take(R)).toBe('TEXT');
  });

  it('forgets on invalidate', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), 'TEXT');
    c.invalidate();
    expect(c.take(R)).toBeUndefined();
  });

  // An all-blank rectangle extracts ''. Caching it would make a copy SET '' and cancel the
  // default, blanking the clipboard, where today's path sends nothing for an empty copy
  // (`web/src/main.ts`'s `copy` arm) and leaves the clipboard alone. Not caching it routes that
  // copy to the fallback, which keeps today's behavior.
  it('does not cache an empty answer', () => {
    const c = createCopyCache();
    c.accept(c.begin(R), '');
    expect(c.take(R)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/canvas/test/copyCache.test.ts`
Expected: FAIL, `Failed to resolve import "../src/copyCache.js"`.

- [ ] **Step 3: Implement**

```ts
import type { CellRect } from './selection.js';

/**
 * THE PREFETCHED TEXT OF THE CURRENT SELECTION, so a `copy` event can hand it over synchronously.
 * 2026-11-02.
 *
 * WHY IT EXISTS: the browser's own copy path (`clipboardData.setData` inside a `copy` event) needs
 * no secure context and no user-activation window, but it needs the text NOW, and only the gateway
 * can extract it. So the renderer asks when a drag ends and keeps the answer here. See
 * `docs/superpowers/specs/2026-11-02-fetch-ahead-copy-design.md` for the measurement behind it.
 *
 * DOM-FREE AND STATE-ONLY, like `selection.ts`, so it is tested under `environment: 'node'`.
 *
 * THE GENERATION, NOT TIMING, IS WHAT KEEPS A STALE ANSWER OUT. `invalidate()` and every `begin()`
 * bump it, and `accept` drops any answer whose generation is not current -- including one for the
 * same rect over a screen that has since changed.
 */
export interface CopyCache {
  /** A drag ended on `rect`. Returns the generation its answer must carry. */
  begin(rect: CellRect): number;
  /** The answer for generation `gen`. Ignored unless `gen` is still current, or if `text` is empty. */
  accept(gen: number, text: string): void;
  /** The selection is gone or the screen changed. A pending answer becomes stale. */
  invalidate(): void;
  /** The text for `rect`, or `undefined`. Does not consume: the selection survives a copy. */
  take(rect: CellRect): string | undefined;
}

export function createCopyCache(): CopyCache {
  let gen = 0;
  let asked: CellRect | undefined;
  let text: string | undefined;
  const same = (a: CellRect, b: CellRect): boolean =>
    a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right;
  return {
    begin(rect) {
      gen += 1;
      asked = { ...rect };
      text = undefined;
      return gen;
    },
    accept(g, t) {
      // EMPTY IS NOT CACHED: see the test. An all-blank copy then falls back, which sends nothing.
      if (g !== gen || t === '') return;
      text = t;
    },
    invalidate() {
      gen += 1;
      asked = undefined;
      text = undefined;
    },
    take(rect) {
      if (asked === undefined || text === undefined || !same(asked, rect)) return undefined;
      return text;
    },
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run packages/canvas/test/copyCache.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Mutation-check the generation**

Change `if (g !== gen || t === '') return;` to `if (t === '') return;`, rerun, and expect the
`drops an answer that arrives after invalidate` and `superseded` cases to FAIL. Restore the file.

- [ ] **Step 6: Commit**

```bash
git add packages/canvas/src/copyCache.ts packages/canvas/test/copyCache.test.ts
git commit -m "feat(canvas): copyCache, the prefetched selection text a copy event needs

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 2: Protocol — `selection` and `selectionText`

**Files:**
- Modify: `packages/web/src/protocol.ts` (the `ServerMessage` union near `| { kind: 'copyText'; text: string }`, the `ClientMessage` union at `export type ClientMessage =`, the `copy` rect check inside `decodeClientMessage`, and the tail before `if (kind === 'transferCancel')`)
- Test: `packages/web/test/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('encodeServerMessage', ...)`:

```ts
  it('round-trips selectionText, the prefetched answer to a selection', () => {
    const msg: ServerMessage = { kind: 'selectionText', seq: 7, text: ' MENU\n OPTION ===>' };
    const back = JSON.parse(inflateSync(encodeServerMessage(msg)).toString());
    expect(back).toEqual({ kind: 'selectionText', seq: 7, text: ' MENU\n OPTION ===>' });
  });
```

Add inside `describe('decodeClientMessage', ...)`:

```ts
  it('accepts a selection, a top-level message and not an action', () => {
    const rect = { top: 0, left: 0, bottom: 1, right: 11 };
    expect(decodeClientMessage(JSON.stringify({ kind: 'selection', seq: 3, rect })))
      .toEqual({ kind: 'selection', seq: 3, rect });
    // ONLY THE FOUR FIELDS SURVIVE, so nothing a client adds rides into extractText.
    expect(decodeClientMessage(JSON.stringify({
      kind: 'selection', seq: 3, rect: { ...rect, extra: 'x' },
    }))).toEqual({ kind: 'selection', seq: 3, rect });
  });

  /*
    THE SAME FIELD RULE AS `copy`, for the same measured reason: this is answered in the socket
    handler, where a throw from `extractText(cells, cols, undefined)` ends the gateway process and
    every operator's session. The seq is checked too, because the browser matches the answer on it.
  */
  it('REFUSES a selection whose fields would throw or mismatch in the socket handler', () => {
    const rect = { top: 0, left: 0, bottom: 1, right: 11 };
    const bad: readonly unknown[] = [
      { kind: 'selection', rect },                              // no seq
      { kind: 'selection', seq: -1, rect },
      { kind: 'selection', seq: 1.5, rect },
      { kind: 'selection', seq: '1', rect },
      { kind: 'selection', seq: 1 },                            // no rect
      { kind: 'selection', seq: 1, rect: null },
      { kind: 'selection', seq: 1, rect: { top: 0, left: 0, bottom: 1 } },
      { kind: 'selection', seq: 1, rect: { top: 0, left: 0, bottom: 1.5, right: 9 } },
    ];
    for (const m of bad) {
      expect(() => decodeClientMessage(JSON.stringify(m)), JSON.stringify(m))
        .toThrow(/selection (seq|needs a rect|rect )/);
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/web/test/protocol.test.ts`
Expected: the decode cases FAIL with `unknown client message kind selection`. The encode case
fails at `npm run build`, not under vitest, because `ServerMessage` lacks the kind.

- [ ] **Step 3: Implement**

In the `ServerMessage` union, directly after `| { kind: 'copyText'; text: string }`:

```ts
  /*
    THE PREFETCHED TEXT OF A SELECTION, 2026-11-02 -- the answer to the client's `selection`. Same
    extraction as `copyText` (hidden fields become spaces), sent when a drag ends rather than when a
    copy is requested, so the browser can hand it to its own `copy` event synchronously. `seq`
    echoes the request's, which is how the bridge matches the answer to its promise.
  */
  | { kind: 'selectionText'; seq: number; text: string }
```

In the `ClientMessage` union, after `| { kind: 'transferCancel' }` (moving the `;`):

```ts
  | { kind: 'transferCancel' }
  /*
    A PREFETCH, NOT AN ACTION, 2026-11-02: a top-level kind beside the transfer ones because the
    operator did nothing to the session. Answered with `selectionText`; changes no screen.
  */
  | { kind: 'selection'; seq: number; rect: { top: number; left: number; bottom: number; right: number } };
```

Above `export function decodeClientMessage`, add the shared rect check:

```ts
/**
 * THE FOUR RECT FIELDS, CHECKED ONCE FOR BOTH KINDS THAT CARRY ONE. `copy` and `selection` both
 * reach `extractText` in the socket handler, so both need the rule `copy`'s note below records:
 * a missing rect throws there, and a FRACTIONAL one silently extracts nothing. `what` keeps each
 * kind's error naming itself. Returns a fresh object with only the four fields.
 */
function checkRect(rect: unknown, what: string): {
  top: number; left: number; bottom: number; right: number;
} {
  if (typeof rect !== 'object' || rect === null) throw new Error(`${what} needs a rect object`);
  const r = rect as Record<string, unknown>;
  for (const k of ['top', 'left', 'bottom', 'right']) {
    if (typeof r[k] !== 'number' || !Number.isInteger(r[k])) {
      throw new Error(`${what} rect ${k} must be an integer`);
    }
  }
  return {
    top: r['top'] as number, left: r['left'] as number,
    bottom: r['bottom'] as number, right: r['right'] as number,
  };
}
```

Replace the body of the `if (aKind === 'copy') { ... }` block. Keep the long comment above it, and
keep the comment about `typeof` redundancy by moving its sense into `checkRect`'s docstring if it
is not already covered:

```ts
    if (aKind === 'copy') {
      checkRect((action as { rect?: unknown }).rect, 'copy');
    }
```

Before `if (kind === 'transferCancel') return { kind: 'transferCancel' };`:

```ts
  if (kind === 'selection') {
    const { seq, rect } = raw as { seq?: unknown; rect?: unknown };
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      throw new Error('selection seq must be a non-negative integer');
    }
    return { kind: 'selection', seq, rect: checkRect(rect, 'selection') };
  }
```

- [ ] **Step 4: Run the tests and the build**

Run: `npx vitest run packages/web/test/protocol.test.ts && npm run build`
Expected: PASS, including the existing `REFUSES a copy whose rect would make extractText throw`
case (its regex `/copy (needs a rect|rect )/` must still match). The build FAILS in
`web/src/main.ts` only if a `switch` there is exhaustive over `ClientMessage`. If it fails
anywhere else, stop and read the error before going on.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/protocol.ts packages/web/test/protocol.test.ts
git commit -m "feat(web): selection and selectionText, the prefetch protocol

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 3: The gateway answers `selection`

**Files:**
- Modify: `packages/web/src/main.ts` (beside `if (msg.kind === 'transferCancel') { transfer.cancel(); return; }`)
- Test: `packages/web/test/integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new `describe` block after `describe('the gateway end to end', ...)`'s closing `});`. It
uses the file's existing `start()` and `collect()` helpers. The expected text is the fixture's
rows 0-1, columns 0-11, the same string `browser-clicks.mjs`'s `COPY_WANT` spells out:

```ts
describe('the selection prefetch', () => {
  /** Handshake, then every message after it, so "nothing else was sent" is checkable. */
  async function attached(): Promise<{ ws: WebSocket; after: Array<Record<string, unknown>> }> {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;
    const after: Array<Record<string, unknown>> = [];
    ws.addEventListener('message', (e) => {
      after.push(JSON.parse(inflateSync(Buffer.from(e.data as ArrayBuffer)).toString()));
    });
    return { ws, after };
  }

  it('answers with the extracted text and the request seq, and repaints NOTHING', async () => {
    const { ws, after } = await attached();
    ws.send(JSON.stringify({
      kind: 'selection', seq: 41, rect: { top: 0, left: 0, bottom: 1, right: 11 },
    }));
    for (let waited = 0; waited < 40 && after.length === 0; waited += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    // A FURTHER WINDOW, because a repaint after the answer is the defect and it would land late.
    await new Promise((r) => { setTimeout(r, 250); });
    ws.close();
    expect(after).toEqual([{ kind: 'selectionText', seq: 41, text: ' MENU\n OPTION ===>' }]);
  });

  it('refuses a malformed selection with an error frame, and keeps serving', async () => {
    const { ws, after } = await attached();
    ws.send(JSON.stringify({ kind: 'selection', seq: 1 }));
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
    for (let waited = 0; waited < 80 && after.length < 2; waited += 1) {
      await new Promise((r) => { setTimeout(r, 25); });
    }
    ws.close();
    expect(after.map((m) => m['kind'])).toEqual(['error', 'frame']);
    expect(String(after[0]!['message'])).toMatch(/selection needs a rect/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/web/test/integration.test.ts -t "selection prefetch"`
Expected: the first case FAILS with `after` equal to `[]` (the decoded `selection` falls through
`if (msg.kind !== 'action') return;`). The second may already pass, because the refusal comes
from Task 2's decoder. That is fine: it pins the survival.

- [ ] **Step 3: Implement**

In `web/src/main.ts`, directly after
`if (msg.kind === 'transferCancel') { transfer.cancel(); return; }` and before
`if (msg.kind !== 'action') return;`:

```ts
      /*
        THE SELECTION PREFETCH, 2026-11-02, and it must sit above the guard below for the reason the
        transfer kinds give. The browser asks when a drag ends, so its own `copy` event can set the
        text synchronously -- see `canvas/src/copyCache.ts`. The SAME extraction as `copy`, so a
        hidden field still contributes spaces. NO REPAINT: nothing on the screen changed, and the
        ordering argument in the spec depends on frames being sent only for real screen changes.

        THE LOG LINE SAYS "selection", NOT "copy". A prefetch is not a copy and the operator may never
        copy; on the cached path a copy never reaches this process at all.
      */
      if (msg.kind === 'selection') {
        const snapshot = session.screen.snapshot();
        const text = extractText(resolve(snapshot), snapshot.cols, msg.rect);
        conn.sendBinary(encodeServerMessage({ kind: 'selectionText', seq: msg.seq, text }));
        process.stdout.write(`selection: sent ${text.length} chars to the browser\n`);
        return;
      }
```

- [ ] **Step 4: Run the tests and the build**

Run: `npm run build && npx vitest run packages/web/test/integration.test.ts`
Expected: PASS, the whole file, including the existing action-kind enumeration.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/main.ts packages/web/test/integration.test.ts
git commit -m "feat(web): the gateway answers a selection prefetch without repainting

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 4: The bridge — `fetchSelection`

**Files:**
- Modify: `packages/web/src/bridgecore.ts` (the header's `BridgeApi` paragraph, `interface BridgeApi`, `createBridge`'s `onclose` and `onmessage`, and its returned object)
- Test: `packages/web/test/bridgecore.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe('createBridge', ...)`, before the `reports an unexpected close` case:

```ts
  it('fetchSelection sends the rect with a seq and resolves on the matching answer', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const rect = { top: 0, left: 0, bottom: 1, right: 11 };
    const got = api.fetchSelection!(rect);
    const sent = JSON.parse(socket.sent[0]!) as { kind: string; seq: number; rect: unknown };
    expect(sent.kind).toBe('selection');
    expect(sent.rect).toEqual(rect);
    deliver(socket, { kind: 'selectionText', seq: sent.seq, text: 'HELLO' });
    await expect(got).resolves.toBe('HELLO');
  });

  it('matches answers by seq, so two in flight cannot swap', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const a = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 });
    const b = api.fetchSelection!({ top: 1, left: 0, bottom: 1, right: 1 });
    const [sa, sb] = socket.sent.map((s) => (JSON.parse(s) as { seq: number }).seq);
    deliver(socket, { kind: 'selectionText', seq: sb, text: 'B' });
    deliver(socket, { kind: 'selectionText', seq: sa, text: 'A' });
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  it('drops an answer nobody asked for, and sends it to no renderer handler', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const errors: string[] = [];
    const frames: unknown[] = [];
    api.onError((m) => errors.push(m));
    api.onFrame((f) => frames.push(f));
    deliver(socket, { kind: 'selectionText', seq: 999, text: 'NOBODY' });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(errors).toEqual([]);
    expect(frames).toEqual([]);
  });

  // A CLOSE REJECTS WHAT IS PENDING, so a prefetch never waits forever on a dead socket. The
  // caller (`renderer.ts`) catches, and the cache stays empty, so every gesture falls back.
  it('rejects pending fetches when the socket closes', async () => {
    const socket = fakeSocket();
    const api = createBridge({
      socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d),
    });
    const got = api.fetchSelection!({ top: 0, left: 0, bottom: 0, right: 1 });
    socket.onclose?.();
    await expect(got).rejects.toThrow(/closed/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/web/test/bridgecore.test.ts`
Expected: the four new cases FAIL with `api.fetchSelection is not a function`.

- [ ] **Step 3: Implement**

In `interface BridgeApi`, after `sendAction(action: unknown): void;`:

```ts
  /**
   * Ask the gateway for the text under `rect`, ahead of any copy. 2026-11-02.
   *
   * OPTIONAL, AND THAT IS WHAT KEEPS `renderer.ts` SHARED: Electron's `preload.cts` does not
   * provide it, so the renderer tests for it and prefetches only where it exists. An unhandled
   * `ipcMain` kind freezes Electron's main process (measured 2026-10-26), so Electron must never be
   * sent a `selection`.
   *
   * THE RECT IS SPELLED INLINE, not imported as `CellRect`, because this module is served to the
   * browser unbundled and must not grow a bare-specifier import -- even a type-only one is one
   * careless edit from a runtime one.
   */
  fetchSelection?(rect: { top: number; left: number; bottom: number; right: number }): Promise<string>;
```

In the file header, replace the sentence `If \`BridgeApi\` grows a fifth function, the renderer
has stopped being shared and something is wrong.` with:

```
 * `BridgeApi` grew a fifth member on 2026-11-02, `fetchSelection`, and it is OPTIONAL for exactly
 * this reason: `preload.cts` does not implement it, the renderer tests for it, and so the renderer
 * is still shared unmodified. A fifth REQUIRED member would mean it had stopped being shared.
```

Inside `createBridge`, after `const queue: ...`:

```ts
  // THE PREFETCHES IN FLIGHT, by seq. Answers arrive in order on one socket, but matching on the
  // seq rather than on arrival order is what makes that an observation instead of an assumption.
  let nextSeq = 0;
  const waiting = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
```

Replace the `onclose` assignment:

```ts
  deps.socket.onclose = () => {
    for (const w of waiting.values()) w.reject(new Error('the gateway connection closed'));
    waiting.clear();
    dispatch('error', 'The connection to the gateway closed. Reload to reconnect.');
  };
```

In `onmessage`, directly after the `copyText` branch:

```ts
      // THE PREFETCH ANSWER, 2026-11-02. NOT through `dispatch`, for `copyText`'s reason above. An
      // answer with no waiter -- or a non-string text, which only a broken gateway sends -- is
      // dropped: the cache then stays empty, and a copy falls back to the async path.
      if (msg.kind === 'selectionText') {
        const seq = msg['seq'];
        const w = typeof seq === 'number' ? waiting.get(seq) : undefined;
        if (w !== undefined && typeof msg['text'] === 'string') {
          waiting.delete(seq as number);
          w.resolve(msg['text']);
        }
        return;
      }
```

In the returned object, after `sendAction`'s closing `},`:

```ts
    fetchSelection: (rect) => new Promise<string>((resolve, reject) => {
      nextSeq += 1;
      waiting.set(nextSeq, { resolve, reject });
      deps.socket.send(JSON.stringify({ kind: 'selection', seq: nextSeq, rect }));
    }),
```

- [ ] **Step 4: Run the tests and the build**

Run: `npm run build && npx vitest run packages/web/test/bridgecore.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check the seq match**

Replace `waiting.get(seq)` with `waiting.values().next().value`, rerun, and expect
`matches answers by seq` to FAIL. Restore the file.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/bridgecore.ts packages/web/test/bridgecore.test.ts
git commit -m "feat(web): the bridge prefetches a selection, matched by seq

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 5: `forwardCopy` uses the cache

**Files:**
- Modify: `packages/canvas/src/forwardKeys.ts` (`CopyEventLike`, `ForwardCopyDeps`, `forwardCopy` and its docstring's `## NO \`preventDefault\`, EVER` section)
- Test: `packages/canvas/test/forwardKeys.test.ts` (`fakeCopy`, `copyEv` and the whole `describe('forwardCopy, ...')` block)

- [ ] **Step 1: Rewrite the tests**

Replace `fakeCopy`, `copyEv` and the `forwardCopy` describe block with:

```ts
/**
 * A fake window for the copy half. `cached` is what the renderer's cache holds for the current
 * selection, and `hasSelection` is what the fallback `copySelection` returns.
 */
function fakeCopy(protocol = 'https:', cached: string | undefined = undefined): {
  deps: ForwardCopyDeps;
  readonly fallbacks: number[];
  readonly handled: number[];
  readonly prevented: unknown[];
  readonly types: string[];
  fire: (e: unknown) => void;
} {
  const fallbacks: number[] = [];
  const handled: number[] = [];
  const prevented: unknown[] = [];
  const types: string[] = [];
  let handler: ((e: unknown) => void) | undefined;
  return {
    fallbacks,
    handled,
    prevented,
    types,
    fire: (e) => {
      if (handler === undefined) throw new Error('forwardCopy registered no handler');
      handler({ ...(e as object), preventDefault: () => { prevented.push(e); } });
    },
    deps: {
      on: (type, fn) => { types.push(type); handler = fn as (e: unknown) => void; },
      protocol,
      cached: () => cached,
      copySelection: () => { fallbacks.push(fallbacks.length); return true; },
      onHandled: () => { handled.push(handled.length); },
    },
  };
}

/** A `copy` event. `set` records what the listener put on `clipboardData`. */
const copyEv = (o: {
  tag?: string; editable?: boolean; noData?: boolean; set?: Array<[string, string]>;
} = {}): unknown => ({
  target: o.tag === undefined && o.editable === undefined
    ? null
    : { tagName: o.tag, isContentEditable: o.editable === true },
  clipboardData: o.noData === true ? null : {
    setData: (format: string, data: string) => { o.set?.push([format, data]); },
  },
});

describe('forwardCopy, the browser\'s own copy gesture (Cmd-C, Edit > Copy)', () => {
  /*
    THE CACHED PATH, 2026-11-02, and the reason it works where the async one cannot: the text is
    set on the event's own clipboardData INSIDE the event, which needs no secure context and no
    activation window. preventDefault is what makes the browser write that data, and it is correct
    here because real data was set.
  */
  it('sets the cached text on the event and cancels its default', () => {
    const f = fakeCopy('https:', ' MENU\n OPTION ===>');
    forwardCopy(f.deps);
    const set: Array<[string, string]> = [];
    f.fire(copyEv({ set }));
    expect(set).toEqual([['text/plain', ' MENU\n OPTION ===>']]);
    expect(f.prevented).toHaveLength(1);
    expect(f.fallbacks).toEqual([]);
    expect(f.handled).toHaveLength(1);
  });

  /*
    NO CACHED TEXT: THE ASYNC FALLBACK, AND NO preventDefault. Cancelling with nothing set asks the
    browser to write an EMPTY clipboardData. Chromium was measured not to blank the clipboard on
    that; Firefox and Safari were not, so the rule stands as a precaution and this case is its only
    cover -- the browser harness runs Chromium and stays green on the mutant.
  */
  it('falls back to the async copy with nothing cached, and never cancels then', () => {
    const f = fakeCopy('https:', undefined);
    forwardCopy(f.deps);
    const set: Array<[string, string]> = [];
    f.fire(copyEv({ set }));
    expect(set).toEqual([]);
    expect(f.prevented).toEqual([]);
    expect(f.fallbacks).toHaveLength(1);
    expect(f.handled).toHaveLength(1);
  });

  it('falls back when the event carries no clipboardData', () => {
    const f = fakeCopy('https:', 'TEXT');
    forwardCopy(f.deps);
    f.fire(copyEv({ noData: true }));
    expect(f.prevented).toEqual([]);
    expect(f.fallbacks).toHaveLength(1);
  });

  it('skips a copy aimed at a form control, so the transfer form copies its own text', () => {
    for (const target of [{ tag: 'INPUT' }, { tag: 'TEXTAREA' }, { editable: true }]) {
      const f = fakeCopy('https:', 'TEXT');
      forwardCopy(f.deps);
      const set: Array<[string, string]> = [];
      f.fire(copyEv({ ...target, set }));
      expect(set, JSON.stringify(target)).toEqual([]);
      expect(f.prevented, JSON.stringify(target)).toEqual([]);
      expect(f.fallbacks, JSON.stringify(target)).toEqual([]);
      // NOT HANDLED: the chord arm must then fall back itself, rather than believe it copied.
      expect(f.handled, JSON.stringify(target)).toEqual([]);
    }
  });

  it('listens for copy and nothing else', () => {
    const f = fakeCopy();
    forwardCopy(f.deps);
    expect(f.types).toEqual(['copy']);
  });

  it('installs on http: and https: only, never on file:, the Electron GUI', () => {
    for (const protocol of ['http:', 'https:']) {
      const f = fakeCopy(protocol);
      forwardCopy(f.deps);
      expect(f.types, protocol).toEqual(['copy']);
    }
    for (const protocol of ['file:', 'app:', 'chrome-extension:', 'data:', 'about:', '']) {
      const f = fakeCopy(protocol);
      forwardCopy(f.deps);
      expect(f.types, `${protocol} must not install a copy listener`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/canvas/test/forwardKeys.test.ts`
Expected: the cached-path case FAILS (`set` is `[]`, and `fallbacks` has one entry), and the build
would reject `cached`/`onHandled` as unknown deps.

- [ ] **Step 3: Implement**

Replace `CopyEventLike` and `ForwardCopyDeps`:

```ts
/** The shape this module reads off a real `copy` `ClipboardEvent`. */
type CopyEventLike = {
  readonly target: { tagName?: unknown; isContentEditable?: unknown } | null;
  readonly clipboardData?: { setData: (format: string, data: string) => void } | null;
  readonly preventDefault: () => void;
};

export interface ForwardCopyDeps {
  /** Register the listener. The real caller passes `window.addEventListener`. */
  readonly on: (type: string, handler: (e: CopyEventLike) => void) => void;
  /** `location.protocol`, gated on exactly as `ForwardPasteDeps.protocol` is. */
  readonly protocol: string;
  /** The prefetched text for the CURRENT selection, or `undefined`. See `copyCache.ts`. */
  readonly cached: () => string | undefined;
  /** The renderer's own `copySelection`: the async fallback, the path `Ctrl-Shift-C` used to take. */
  readonly copySelection: () => boolean;
  /**
   * Called once for every copy this listener took responsibility for, by either path. The
   * `Ctrl-Shift-C` arm reads it to know whether its `execCommand('copy')` reached here, and falls
   * back itself if not -- a browser that silently ignores `execCommand` still copies.
   */
  readonly onHandled: () => void;
}
```

Replace `forwardCopy`'s body:

```ts
export function forwardCopy(deps: ForwardCopyDeps): void {
  if (!PASTE_HOSTS.has(deps.protocol)) return;
  deps.on('copy', (e) => {
    // The transfer form's text fields must copy their own selection, not the screen's.
    if (isEditableTarget(e.target)) return;
    deps.onHandled();
    const text = deps.cached();
    if (text !== undefined && e.clipboardData) {
      // THE SYNCHRONOUS PATH: no secure context needed, no activation window. `preventDefault` is
      // what makes the browser write the data just set -- correct here, and only here.
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      return;
    }
    // Nothing prefetched yet: today's async path. NO `preventDefault`, for the reason in the
    // docstring. The return value is discarded, as the keydown arm discards it.
    deps.copySelection();
  });
}
```

In `forwardCopy`'s docstring, rewrite the first paragraph and the `## NO \`preventDefault\`, EVER`
section so that they describe the two paths. Keep the existing measurements, rename the heading to
`## \`preventDefault\` ONLY WHEN TEXT WAS SET`, and add one sentence pointing to `copyCache.ts`.
Leave the `Ctrl-C` and gate sections as they are.

- [ ] **Step 4: Run the tests (expect a build failure in the renderer)**

Run: `npx vitest run packages/canvas/test/forwardKeys.test.ts`
Expected: PASS. `npm run build` now FAILS in `renderer.ts`, because its `forwardCopy({...})` call
lacks `cached`/`onHandled`. That is Task 6's first edit. Do NOT commit a broken build: go
straight on to Task 6 and commit the two tasks together.

---

### Task 6: The renderer owns the cache

**Files:**
- Modify: `packages/canvas/src/renderer.ts`

No unit test can import this file (it touches `window` at module load). It is covered by
`test/renderer-imports.test.ts`'s order pin, by Task 7's `browser-clicks` checks and by Task 8's
LAN check. Write it, build it, and let those prove it.

- [ ] **Step 1: The imports and the window type**

Change `import { normalizeRect, isEmptyRect, type CellAddr } from './selection.js';` to:

```ts
import { normalizeRect, isEmptyRect, type CellAddr, type CellRect } from './selection.js';
import { createCopyCache } from './copyCache.js';
```

In `declare global { interface Window { tn3270: { ... } } }`, after `sendAction(action: unknown): void;`:

```ts
      /** OPTIONAL: the web gateway's bridge has it, Electron's preload does not. See bridgecore.ts. */
      fetchSelection?(rect: CellRect): Promise<string>;
```

- [ ] **Step 2: The cache, invalidated where the selection dies**

Directly after `let dragging = false;`:

```ts
/**
 * The selection's prefetched text, 2026-11-02 -- see `copyCache.ts`. Invalidated exactly where the
 * selection dies, which is `clearSelection()` below and a new press, so a frame from the host (whose
 * `onFrame` calls `clearSelection()`) can never leave text for a screen that is gone.
 */
const copyCache = createCopyCache();
```

Change `clearSelection` to:

```ts
function clearSelection(): void {
  anchor = null;
  focus = null;
  dragging = false;
  copyCache.invalidate();
}
```

In the canvas `mousedown` listener, directly before `anchor = cell;`, add `copyCache.invalidate();`.

- [ ] **Step 3: Prefetch when a drag ends**

Replace

```ts
window.addEventListener('mouseup', release);
```

with

```ts
/**
 * A drag that ENDED ON A REAL RECTANGLE asks the gateway for its text, so a later copy event can set
 * it synchronously. Only on `mouseup`: `blur` also releases, but nobody selected anything by
 * switching windows. A plain click (an empty rect) asks for nothing.
 *
 * THE `catch` IS LOAD-BEARING. `fetchSelection` rejects when the socket closes, and an unhandled
 * rejection is this repo's most-recorded silent failure. A failed prefetch leaves the cache empty,
 * and every gesture then falls back -- so nothing is painted here.
 */
function prefetchSelection(): void {
  const fetchSelection = window.tn3270.fetchSelection;
  if (fetchSelection === undefined || anchor === null || focus === null) return;
  const rect = normalizeRect(anchor, focus);
  if (isEmptyRect(rect)) return;
  const gen = copyCache.begin(rect);
  fetchSelection.call(window.tn3270, rect)
    .then((text) => { copyCache.accept(gen, text); })
    .catch(() => { /* the cache stays empty; every gesture falls back */ });
}

window.addEventListener('mouseup', () => {
  const ended = dragging;
  release();
  if (ended) prefetchSelection();
});
```

- [ ] **Step 4: The cached text for the current selection, and the chord**

Directly after `function copySelection(): boolean { ... }`, add:

```ts
/** The prefetched text for the CURRENT selection, or `undefined`. */
function cachedSelection(): string | undefined {
  if (anchor === null || focus === null) return undefined;
  return copyCache.take(normalizeRect(anchor, focus));
}

/** Set by `forwardCopy` whenever it handled a copy event. Read only by `copyByChord`. */
let copyHandled = false;

/**
 * `Ctrl-Shift-C` / `Cmd-Shift-C`. 2026-11-02.
 *
 * WITH TEXT CACHED, raise the browser's own `copy` event with `execCommand('copy')`, inside this
 * keystroke's activation, so `forwardCopy` can set the text synchronously -- which is what makes
 * the chord work at a plain-`http` LAN address. MEASURED in a non-secure Chromium page: the event
 * fires `isTrusted` and its data lands on the OS clipboard. `execCommand` is deprecated but has no
 * replacement for raising a copy event from script.
 *
 * FALLS BACK to `copySelection()` -- today's async path -- when nothing is cached, when
 * `execCommand` throws or returns false, or when the event never reached `forwardCopy`. So a
 * browser that ignores the call still copies, exactly as it did before this.
 *
 * ONLY WITH TEXT CACHED, and that is not an optimization. The cache is filled only where the bridge
 * has `fetchSelection` (the web gateway), so in the Electron GUI this never calls `execCommand` at
 * all, and the page's default copy of an empty DOM selection never runs there.
 */
function copyByChord(): void {
  if (cachedSelection() !== undefined) {
    copyHandled = false;
    try { document.execCommand('copy'); } catch { /* fall through to the fallback */ }
    if (copyHandled) return;
  }
  copySelection();
}
```

In the keydown listener, change the arm. The renderer-imports test pins
`action.kind === 'requestCopy'` appearing before `clearSelection()`, so keep the condition text
exactly:

```ts
  if (action.kind === 'requestCopy') { copyByChord(); return; }
```

Then update that arm's long comment block. `copySelection` is now the fallback and `copyByChord` is
what runs; the ordering argument is unchanged, because both read the selection.

- [ ] **Step 5: Wire `forwardCopy`**

Replace the `forwardCopy({...})` call with:

```ts
forwardCopy({
  on: (type, handler) => { window.addEventListener(type, handler as (e: Event) => void); },
  protocol: location.protocol,
  cached: cachedSelection,
  copySelection,
  onHandled: () => { copyHandled = true; },
});
```

`copyHandled`, `cachedSelection` and `copySelection` are declared further down the file than this
call. The arrow functions capture them as bindings, so they are read when the listener runs, not
when the call is made. Function declarations hoist, but **`let copyHandled` does NOT**: if the
`onHandled` arrow ever ran before the module body reached that line, it would throw a TDZ
error. It cannot, because the listener only fires on a real copy event, long after the
module has finished loading. Record that in one line beside the call, as `browser-clicks.mjs`
records its own `serverOut` TDZ argument.

- [ ] **Step 6: Build, unit suite, order pin**

Run: `npm run build && npx vitest run`
Expected: build exit 0; all tests PASS, including `renderer-imports.test.ts`'s
`intercepts requestCopy BEFORE clearSelection` and Task 5's `forwardKeys.test.ts`.

- [ ] **Step 7: Commit Tasks 5 and 6 together**

```bash
git add packages/canvas/src/forwardKeys.ts packages/canvas/test/forwardKeys.test.ts packages/canvas/src/renderer.ts
git commit -m "feat(canvas): copy sets prefetched text synchronously, on every gesture

The copy listener sets the cached text on the event's clipboardData and
cancels its default; Ctrl-Shift-C raises that event with execCommand('copy')
inside its own keystroke. Neither needs a secure context. With nothing cached,
both fall back to the async copy -> copyText path unchanged.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 7: `browser-clicks` witnesses the cached path, and a fallback check

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs` (`PROBE_SOURCE`, `TRANSFER_CHECKS`, `chordCopy`, the `webCopy` clauses, the `webNativeCopy` block, and a new `webCopyFallback` block before `// ===== webPaste`)

Under the new path a cached copy sends NO `{kind:'copy'}` frame, so three things in this harness
become wrong. Each one changes as follows.

- [ ] **Step 1: Run the harness first, to measure what breaks**

Run: `npm run build && node packages/web/scripts/browser-clicks.mjs > /tmp/bc-before.log 2>&1; tail -3 /tmp/bc-before.log`
Expected: `webCopy` and `webNativeCopy` FAIL, because the copy frame and the `copy:` log line are
gone. Record the exact failure lines; Step 6 compares against them.

- [ ] **Step 2: A probe switch that holds the prefetch**

In `PROBE_SOURCE`, change `const H = { sent: [], hold: false, sock: null, warns: [], keys: [] };` to
add `holdSelection: false`. In the wrapped `s.send`, after the `transferStart` hold line, add:

```js
      if (H.holdSelection && text.includes('"kind":"selection"')) return;
```

and document it in the comment above, beside `hold`. It is how the fallback check gets an empty
cache in the real product.

- [ ] **Step 3: `chordCopy`'s success signal**

`copied` currently means "the page sent a `copy` frame", and `copyCells` retries on
`copied === false`. On the cached path no frame is sent. Replace the frame-polling loop and the early
return with one bounded loop that waits for EITHER a `copy` frame OR the clipboard leaving the
sentinel:

```js
        let frames = [];
        let clip = sentinel;
        for (let waited = 0; waited < 6000; waited += 150) {
          frames = JSON.parse(await cdp.eval(
            `JSON.stringify(window.__tn3270Probe.sent.slice(${sentBefore}))`));
          clip = await cdp.eval(
            "navigator.clipboard.readText().then((t) => t).catch((e) => 'REJECTED ' + String(e))");
          if (clip !== sentinel) break;
          await new Promise((r) => { setTimeout(r, 150); });
        }
        const keys = JSON.parse(await cdp.eval(
          `JSON.stringify(window.__tn3270Probe.keys.slice(${keysBefore}))`));
        const viaFallback = frames.some((f) => f.includes('"kind":"copy"'));
        // COPIED means the clipboard left the sentinel, by EITHER path. A frame that cleared the
        // selection under the drag leaves it untouched and sends nothing, which is what the retry
        // in `copyCells` is for -- the same narrow signal as before, measured on the product's
        // effect rather than on one path's wire traffic.
        const copied = clip !== sentinel;
        return { written, copied, clip, frames, keys, viaFallback };
```

Update `chordCopy`'s and `copyCells`' docstrings where they say "`copied` IS THE PAGE'S OWN `copy`
FRAME". Keep the reasoning; change only the signal.

**And `copyOnce` must wait for the prefetch to land before it presses anything.** `dragCells`
sleeps 250 ms after the release, and nothing guarantees the `selectionText` answer is back by then.
A chord pressed before it is a legitimate fallback copy, and the `webCopy` fallback clause would
then fail intermittently on correct code. So between the drag and the chord, wait for the
gateway's `selection:` line, bounded at 2 s:

```js
      const copyOnce = async (sentinel, fromRow, fromCol, toRow, toCol) => {
        const mark = serverOut.length;
        const dragged = await dragCells(fromRow, fromCol, toRow, toCol);
        if (dragged !== '') return { problem: dragged };
        // THE PREFETCH MUST LAND FIRST, or the chord takes the fallback and the cached path is not
        // what got measured. Bounded, and a timeout is not a failure: with the prefetch HELD
        // (webCopyFallback) the line never comes, which is that check's whole setup.
        await waitForLog(mark, (l) => l.startsWith('selection: '), 2000);
        // AND ITS ANSWER MUST BE IN THE PAGE: the log line is written just after the answer is sent,
        // so it can precede the page's decode by one inflate. One short beat covers it.
        await new Promise((r) => { setTimeout(r, 100); });
        return { problem: '', ...(await chordCopy(sentinel)) };
      };
```

`waitForLog` and `logsSince` are declared below `copyOnce` in the file today. Both are `const`
arrow functions, so they are in the TDZ until their line runs. `copyOnce` is only CALLED after
both are defined, but move the two helpers above `copyOnce` anyway, so the order is not
load-bearing.

- [ ] **Step 4: `webCopy`'s clauses**

The gateway witness becomes the PREFETCH line logged at drag end, and the cached path must be the
one that ran, or a broken cache would hide behind the fallback. Change:

- `copyLogs`' wait predicate to `(l) => l.startsWith('selection: ')`, and `copyChars` to find that line;
- the clause `copyAction !== undefined && copyChars === \`copy: sent ${COPY_WANT.length} chars to the browser\``
  to two clauses:

```js
        copyChars === `selection: sent ${COPY_WANT.length} chars to the browser` ? ''
          : 'the gateway did not log the selection prefetch for the drag',
        copyRun.viaFallback !== true && copyAgain.viaFallback !== true ? ''
          : 'a copy took the ASYNC FALLBACK, so the prefetched text was not used -- check '
            + 'renderer.ts prefetchSelection and copyByChord',
```

- `survived`'s `againChars === ...` term: delete it. The second copy is cached, sends nothing and
  logs nothing. `copyAgain.clip === COPY_WANT` is the witness.
- `copyAction`: delete it and its uses. Under the cached path no `action: {"kind":"copy"` line is
  logged.
- The `webCopy` table entry's `what` and `mutant`. Its mutants now include
  `renderer.ts  delete prefetchSelection()'s call in the mouseup listener` (fails the fallback
  clause) and `renderer.ts  copyByChord without execCommand` (same). Move
  `bridge.ts  onCopyText: () => {}` to `webCopyFallback`, because the cached path never reaches it.

- [ ] **Step 5: `webNativeCopy` and the new `webCopyFallback`**

In `webNativeCopy`, delete the `nativeFrames ... "kind":"copy"` clause and the `nativeChars` clause.
Add one requiring `!nativeFrames.some((f) => f.includes('"kind":"copy"'))`, with the message
`'the native copy took the async fallback, not the prefetched text'`. Keep the clipboard clause
and the whole `Ctrl+C` negative.

Add a `TRANSFER_CHECKS` entry between `webCopy` and `webNativeCopy`, the order it runs in:

```js
  {
    name: 'webCopyFallback',
    kind: 'live',
    what: 'with the prefetch HELD so the cache is empty, Ctrl+Shift+C still copies by the async '
      + 'path: a {kind:copy} frame, the gateway\'s copy: line, and the text on the REAL clipboard',
    mutant: 'bridge.ts  onCopyText: () => {}  OR  renderer.ts  copyByChord without its '
      + 'copySelection() fallback',
  },
```

and its block, **between the end of `webCopy` and `// ===== webNativeCopy`, NOT before
`webPaste`.** The position matters. `webNativeCopy` ends with a `Ctrl+C` negative, which sends
Clear and blanks the screen. Placed after that, the fallback's row-0 copy would extract the empty
string, which the gateway answers with nothing, and the check would fail on correct code. The
consequence goes the other way too: the fallback REPLACES `webCopy`'s selection, so `webNativeCopy`
must now open with its own fresh drag of `(0,0)-(1,11)`, followed by the same `selection:` wait
`copyOnce` uses. Without that drag it would copy the fallback's row and fail on `COPY_WANT`. Add
the drag, and change the comment that says it runs "AGAINST THE SELECTION webCopy LEFT".

```js
      // ===== webCopyFallback ==================================================================
      //
      // THE ASYNC PATH, WHICH THE CACHED ONE NOW HIDES. Every copy above was served from the
      // prefetch, so `copySelection` -> `copy` -> `copyText` -> `writeClipboard` ran nowhere. This
      // holds the page's `selection` frame so the cache stays empty, then copies a DIFFERENT
      // rectangle (row 0 only) so nothing cached from webCopy could answer for it.
      await cdp.eval('window.__tn3270Probe.holdSelection = true;');
      const fbMark = serverOut.length;
      const fbRun = await copyCells(0, 0, 0, 11);
      await cdp.eval('window.__tn3270Probe.holdSelection = false;');
      const fbLogs = await waitForLog(fbMark, (l) => l.startsWith('copy: '));
      const FB_WANT = ' MENU';
      const fbWhy = fbRun.problem !== '' ? [fbRun.problem] : [
        fbRun.viaFallback === true ? '' : 'no {kind:copy} frame was sent, so the fallback did not run',
        fbLogs.some((l) => l === `copy: sent ${FB_WANT.length} chars to the browser`) ? ''
          : 'the gateway did not log the fallback copy',
        fbRun.clip === FB_WANT ? '' : 'the clipboard does NOT hold the selected text',
        logsSince(fbMark).some((l) => l.startsWith('selection: ')) ? 'the HELD prefetch reached the '
          + 'gateway anyway, so the cache may not have been empty and this proves nothing' : '',
      ].filter((w) => w !== '');
      if (fbWhy.length === 0) {
        ok(check('webCopyFallback'), `with the prefetch held, Ctrl+Shift+C sent a copy frame, the `
          + `gateway logged copy: sent ${FB_WANT.length} chars, and the clipboard reads `
          + `${JSON.stringify(fbRun.clip)} (${fbRun.attempts} drag attempt(s))`);
      } else {
        no(check('webCopyFallback'), `the async copy fallback is broken: ${fbWhy.join('; ')}`,
          `the page sent ${JSON.stringify(fbRun.frames)}, the clipboard reads `
          + `${JSON.stringify(fbRun.clip)}, the gateway logged ${JSON.stringify(logsSince(fbMark))}; `
          + `${extent}`);
      }
```

Before trusting `FB_WANT`, check it against the fixture: it is row 0 of COPY_WANT, which is
`' MENU'`. If `copyCells(0, 0, 0, 11)` yields something else, the fixture is the authority; correct
the constant and say why in a comment.

- [ ] **Step 6: Run the harness**

Run: `npm run build && node packages/web/scripts/browser-clicks.mjs > /tmp/bc.log 2>&1; grep -E "^FAIL|checks" /tmp/bc.log`
Expected: `transfer form: 15/15 checks`.

- [ ] **Step 7: Mutation-prove the new clauses, one at a time, building and reverting each**

| mutant | expected |
|---|---|
| `renderer.ts`: in the mouseup listener, delete `if (ended) prefetchSelection();` | `webCopy` FAILS on the fallback clause; `webNativeCopy` FAILS |
| `renderer.ts`: `copyByChord` with the `execCommand` line deleted | `webCopy` FAILS on the fallback clause |
| `renderer.ts`: `clearSelection` without `copyCache.invalidate()` | run it and RECORD the result. The replay screen does not change between drags, so this may survive here. If it does, say so in the `webCopy` mutant text, and rely on Task 1's unit test |
| `bridge.ts`: `onCopyText: () => {}` | `webCopyFallback` FAILS; `webCopy` stays GREEN |
| `forwardKeys.ts`: delete `e.preventDefault();` in the cached path | `webCopy` FAILS: the default copies an empty DOM selection, and the clipboard keeps the sentinel. Measure it; if it survives, record that instead |

After each, `npx tsc --build --force packages/canvas packages/web`. Record every result in the
check's comment, including the survivors.

- [ ] **Step 8: Commit**

```bash
git add packages/web/scripts/browser-clicks.mjs
git commit -m "test(web): browser-clicks witnesses the cached copy path, and the fallback

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 8: The LAN check — `browser-lan-copy.mjs`

**Files:**
- Create: `packages/web/scripts/read-clipboard.cjs`
- Create: `packages/web/scripts/browser-lan-copy.mjs`

**A deliberate departure from the spec**, which named this `webLanCopy` inside `browser-clicks`. It
is a separate script, not a 16th phase of a 3000-line file, because it needs its own gateway bound to
`0.0.0.0` and its own clipboard witness. The witness is MEASURED, 2026-11-02: a SEPARATE Electron
main process reads another live process's X11 clipboard with `await clipboard.readText()`. In
Electron 44, `readText` returns a Promise; a reader that does not await it prints `{}`. The
clipboard EMPTIES when its owner exits, so the reader runs while the browser is still alive.

- [ ] **Step 1: The reader**

`packages/web/scripts/read-clipboard.cjs`:

```js
// Prints the OS clipboard as one JSON line, from its own Electron main process. The page under test
// has no clipboard API (that is the point of the check), so it cannot read its own result back.
// AWAITED: clipboard.readText() returns a Promise in Electron 44, and an unawaited one prints {}.
const { app, clipboard } = require('electron');
app.whenReady().then(async () => {
  process.stdout.write(`CLIP=${JSON.stringify(await clipboard.readText())}\n`);
  app.exit(0);
});
```

- [ ] **Step 2: The check**

`packages/web/scripts/browser-lan-copy.mjs`. Model it on `browser-clicks.mjs`'s phase two, and
reuse its idioms: `openCdp` copied verbatim with its comment, the `DevToolsActivePort` discovery,
and the `ELECTRON_ARGV`. The script must:

1. Pick a non-loopback IPv4 from `os.networkInterfaces()`. With none, print
   `SKIPPED  no non-loopback IPv4 address, so a non-secure context cannot be reached from here`
   and exit 0. Say in the header that SKIPPED is not a pass.
2. Spawn the gateway:
   `node packages/web/dist/main.js --replay <trace> --listen 0 --bind 0.0.0.0 127.0.0.1:3270`,
   using the fixture `browser-clicks.mjs` uses, and read the port off its `serving ...` line.
3. Launch the GUI in URL mode at `http://<lan>:<port>/` with `--remote-debugging-port=0`.
4. Assert `isSecureContext === false` and `typeof navigator.clipboard === 'undefined'`, or FAIL
   with `the page IS a secure context, so this check would prove nothing`.
5. Read the clipboard before copying, with `read-clipboard.cjs`, and FAIL if it already equals
   `COPY_WANT`. It never should, and it is the only way the "after" value could be stale.
6. **`lanChord`**: drag `(0,0)-(1,11)` with `window.__tn3270CellCenter` and the same three-event
   drag as `dragCells`. Wait for the gateway's `selection: sent 18 chars` line. Press
   `Ctrl+Shift+C` with `Input.dispatchKeyEvent` `keyDown`/`keyUp`, `code: 'KeyC'` and
   `modifiers: 2 | 8`. Then read the clipboard, polling for up to 3 s. PASS if it equals
   `' MENU\n OPTION ===>'`.
7. **`lanCommand`**: drag `(0,0)-(0,11)`, wait for its `selection:` line, and press `Meta+C` with
   `commands: ['copy']` on the `rawKeyDown` (the Edit-menu equivalent, as `webNativeCopy` does).
   PASS if the clipboard equals `' MENU'`.
8. Print `lan copy: N/2 checks` and exit non-zero on any failure. Kill the browser and the gateway
   in a `finally`.

- [ ] **Step 3: Run it**

Run: `node packages/web/scripts/browser-lan-copy.mjs`
Expected: `lan copy: 2/2 checks` (this machine has `192.168.70.115`).

- [ ] **Step 4: Mutation-prove it**

Rebuild the canvas package with `copyByChord`'s `execCommand` line deleted. Expect `lanChord` to
FAIL with the clipboard unchanged, because the fallback has no clipboard API here. Revert and
`npx tsc --build --force packages/canvas`. Then rebuild with `forwardCopy`'s cached branch removed,
expect BOTH checks to fail, and revert.

- [ ] **Step 5: Commit**

```bash
git add packages/web/scripts/read-clipboard.cjs packages/web/scripts/browser-lan-copy.mjs
git commit -m "test(web): copy works at a plain-http LAN address, witnessed on the OS clipboard

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md` (the `### Copy and paste` section)
- Modify: `docs/live-testing.md`, `docs/HANDOFF.md`

- [ ] **Step 1: README**

In `### Copy and paste`, rewrite the `IN THE BROWSER THE COPY CHORD IS ...` paragraph and its two
bullets. They now say that `Cmd-C` and Edit > Copy work in the browser, and they explain the
measured reason it once did not. Add one paragraph:

- copy works over plain `http` at a LAN address too, because the text is fetched when the drag ends;
- a copy pressed faster than that fetch, on a plain-`http` LAN page, paints the
  `copy failed: use https ...` refusal, and pressing it again works;
- right-click offers only "Copy Image", because the screen is a canvas.

Keep `Ctrl-C` as Clear and the rest of the section as is. Then reread the whole section for any
sentence the change has falsified, its heading included.

- [ ] **Step 2: `docs/live-testing.md`**

Under the copy-and-paste section, add the owed pass: in Firefox, Safari and Chromium, at a
plain-`http` LAN address AND over localhost, try `Ctrl-Shift-C`/`Cmd-Shift-C`, `Cmd-C`, and
Edit > Copy. Each should paste the selected text elsewhere. The gateway logs `selection: sent N
chars` at drag end and, on the cached path, NO `copy:` line. Mark the earlier menu-copy note as
superseded by this design.

- [ ] **Step 3: `docs/HANDOFF.md`**

Add a dated START HERE entry: what shipped, the final test count, every harness result, which
mutants survived and why, and the owed live pass.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/live-testing.md docs/HANDOFF.md
git commit -m "docs: copy works on every gesture and at every address

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 10: The full gate, then the user's live pass

- [ ] **Step 1: Build, typecheck, unit suite**

Run: `npx tsc --build --force packages/core packages/frontend packages/node-files packages/canvas packages/cli packages/tui packages/gui packages/web && npm run typecheck && npx vitest run`
Expected: exit 0 each. The test count rises from 2623 by the new cases. Report the exact number.

- [ ] **Step 2: Every harness, serially**

```bash
for s in browser-clicks browser-keys browser-shot browser-lan-copy; do node packages/web/scripts/$s.mjs > /tmp/$s.log 2>&1; echo "$s exit=$?"; done
for s in keys clicks select shot transfer; do node packages/gui/scripts/$s.mjs > /tmp/gui-$s.log 2>&1; echo "gui $s exit=$?"; done
python3 $(git ls-files '*pty-smoke.py')
```

Expected: all exit 0; `browser-clicks` 15/15, `browser-lan-copy` 2/2, GUI `select` 3/3 (the
Electron copy path is untouched, and this proves it), `pty-smoke` 12 PASS.

- [ ] **Step 3: Hand the user the live pass from Task 9 Step 2, and wait.** Do not merge until they
report.
