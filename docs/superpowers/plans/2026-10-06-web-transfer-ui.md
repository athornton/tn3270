# Web gateway transfer UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the web gateway's browser front end an IND$FILE transfer form, with the file bytes travelling over the WebSocket so "local file" means the operator's machine rather than the gateway's.

**Architecture:** `transferUi.ts` moves from `packages/gui` to `packages/canvas` so both front ends share one view (the keypad's precedent). File bytes cross the socket as chunked base64 in new message kinds, reassembled by the gateway against a declared total and handed to the **unmodified** `startTransfer` through a small in-memory `TransferFiles`. Uploads are capped at 10 MB; `transferForm` stops being refused at decode.

**Tech Stack:** TypeScript 7, vitest (`environment: 'node'`, no DOM anywhere), Node 26, raw WebSocket implementation in `packages/web`, Xvfb + Electron + Chromium harnesses for real-browser cover.

**Spec:** `docs/superpowers/specs/2026-10-06-web-transfer-ui-design.md`. Read it first; this plan implements its eight decisions and does not re-argue them.

---

## Read this before Task 1 — the traps this codebase has already recorded

Four hazards govern most of the decisions below. Violating any one produces a **blank page with no error in any console**, which this repo has hit repeatedly.

1. **NEVER import the `@tn3270/canvas` or `@tn3270/frontend` package barrel from browser code.** Both barrels reach `tls.js` and its `node:net`/`node:tls`/`node:fs`. `packages/frontend/test/keypadModule.test.ts` pins this. Browser modules import the *specific* module file.
2. **The web gateway serves browser modules FLAT at `/`**, and every module in the import graph must be reachable by URL. A 404 on a transitive import means the *importing* module never executes, so the error surfaces in the next script and names the wrong file (`httpstatic.ts:42-52` records the measurement).
3. **The import map in `packages/web/static/index.html` already binds `@tn3270/canvas` → `./keypadUi.js`.** One specifier cannot name two files, so a second shared module needs its own specifier (Task 4 handles this).
4. **`packages/web/src/bridgecore.ts` must keep exactly four functions** — `onAtlas`, `onFrame`, `onError`, `sendAction`. Its header says: *"If this file grows a fifth function, the renderer has stopped being shared."* Transfer plumbing goes **beside** it as a separate object, never inside that interface.

Run the full gate after each task:

```bash
npm run build && npm run typecheck && npx vitest run
```

`vitest` does **not** typecheck and a suite can pass over a stale `dist/`, so the build is not optional.

---

## File Structure

**Moved:**
- `packages/gui/src/transferUi.ts` → `packages/canvas/src/transferUi.ts` (behaviour unchanged)
- `packages/gui/test/transferUi.test.ts` → `packages/canvas/test/transferUi.test.ts`

**Created:**
- `packages/web/src/transferChunk.ts` — chunking and reassembly arithmetic. Pure, no DOM, no socket.
- `packages/web/src/transferBridge.ts` — browser-side transfer plumbing: file read, chunk send, save sink. Beside `bridgecore.ts`, not inside it.
- `packages/web/src/transferOverlay.ts` — overlay visibility and lifecycle, modelled on `keypadOverlay.ts`.
- `packages/web/src/transferBoot.ts` — browser entry point: real elements in, `createTransferUi` out. Mirrors `gui/src/transferBoot.ts`.
- `packages/web/test/transferChunk.test.ts`
- `packages/web/test/transferBridge.test.ts`
- `packages/web/test/transferOverlay.test.ts`

**Modified:**
- `packages/canvas/src/index.ts` — export the moved module for TypeScript
- `packages/canvas/src/assets.ts:56-58` — add `transferUi.js` to `BROWSER_MODULES`
- `packages/gui/src/transferBoot.ts:1` — import from `@tn3270/canvas/dist/transferUi.js`
- `packages/gui/transfer.html:18-20` — import map gains the canvas entry
- `packages/web/src/protocol.ts` — new message kinds; `transferForm` leaves the refusal list
- `packages/web/src/httpstatic.ts` — serve the new modules and `transferForm.js`
- `packages/web/src/main.ts` — reassembly, the 10 MB gate, `startTransfer`, progress relay
- `packages/web/static/index.html` — overlay markup and import map entries
- `packages/web/static/ui.css` — overlay rules (or `packages/gui/ui.css` if shared; check which `httpstatic` serves)
- `packages/web/test/integration.test.ts:116` — `transferForm` leaves `REFUSED`
- `packages/web/scripts/browser-clicks.mjs` — drive the form in a real browser
- `packages/frontend/src/transferRun.ts:97` — correct the stale "would take hours" comment

---

## Task 1: Move `transferUi.ts` to `packages/canvas`

The riskiest task, because it touches a working, live-verified GUI feature. It is first so that a regression surfaces before anything is built on top. **Behaviour must not change at all.**

**Files:**
- Create: `packages/canvas/src/transferUi.ts` (moved content)
- Create: `packages/canvas/test/transferUi.test.ts` (moved content)
- Delete: `packages/gui/src/transferUi.ts`, `packages/gui/test/transferUi.test.ts`
- Modify: `packages/canvas/src/index.ts`, `packages/gui/src/transferBoot.ts:1`, `packages/gui/transfer.html:18-20`

- [ ] **Step 1: Confirm the module is portable before moving it**

The move is only safe because this file imports nothing Electron-specific and nothing from a package barrel.

Run:
```bash
cd ~/git/tn3270
sed -n '1,4p' packages/gui/src/transferUi.ts
grep -c "electron" packages/gui/src/transferUi.ts
```

Expected: the import block names only `@tn3270/frontend`, and the grep prints `0`.

If `electron` appears anywhere, STOP and report — the spec's central premise is wrong.

- [ ] **Step 2: Record the baseline test count**

Run:
```bash
npx vitest run packages/gui/test/transferUi.test.ts 2>&1 | grep "Tests "
```

Expected: a line like `Tests  N passed (N)`. **Write N down.** The same N must pass from the new location in Step 6 — that is the evidence the move preserved behaviour.

- [ ] **Step 3: Move both files with git, preserving history**

```bash
cd ~/git/tn3270
git mv packages/gui/src/transferUi.ts packages/canvas/src/transferUi.ts
git mv packages/gui/test/transferUi.test.ts packages/canvas/test/transferUi.test.ts
```

`git mv`, not copy-and-delete: the file carries long explanatory comments whose authorship is worth keeping greppable.

- [ ] **Step 4: Point the moved test at its new neighbour**

The test imports via a relative path, which still resolves — but confirm it.

Run:
```bash
sed -n '2p' packages/canvas/test/transferUi.test.ts
```

Expected: `import { caretAfterEdit, createTransferUi, type UiDeps, type UiField } from '../src/transferUi.js';`

If the path differs, edit it to exactly that.

- [ ] **Step 5: Add the file header note explaining why it lives here**

Insert this immediately after the import block in `packages/canvas/src/transferUi.ts`, before the existing `/**` docblock:

```typescript
/**
 * MOVED HERE FROM `packages/gui` on 2026-10-06, for the same reason `keypadUi.ts` lives here:
 * `packages/web` needs this view and cannot depend on an Electron app. The move was
 * behaviour-preserving and the test came with it unchanged, which is the evidence.
 *
 * IT IMPORTS ONLY `@tn3270/frontend`, and must keep doing so. Electron's `dialog` and `ipcRenderer`
 * reach this form through `UiDeps` -- whose `browse()` and `submit()` are already
 * `Promise`-returning, which is why a browser needs no change to the interface at all. The GUI's
 * `browse()` resolves to a PATH; the web's resolves to a `File.name`. This module shows the string
 * and submits it, and cannot tell the difference.
 */
```

- [ ] **Step 6: Run the moved test and compare to the baseline**

Run:
```bash
npx tsc --build --force packages/canvas
npx vitest run packages/canvas/test/transferUi.test.ts 2>&1 | grep "Tests "
```

Expected: `Tests  N passed (N)` with **the same N from Step 2**. A different number means the move changed something.

- [ ] **Step 7: Export the module from the canvas barrel, for TypeScript only**

In `packages/canvas/src/index.ts`, append after the existing `keypadUi` exports (currently lines 58-59):

```typescript
// The transfer form's view, shared by the Electron transfer WINDOW and the web gateway's in-pane
// OVERLAY -- here for the same reason `keypadUi.ts` is, and moved here on the same day the web
// gateway needed it.
//
// EXPORTED FOR TYPESCRIPT, WHICH IS NOT HOW THE BROWSER GETS IT, exactly as the keypad note above
// says: both front ends' import maps name `canvas/dist/transferUi.js` DIRECTLY, because this
// barrel reaches `drawlist.js` and `@tn3270/core` -- a bare specifier that blanks the window.
export { createTransferUi, caretAfterEdit } from './transferUi.js';
export type { UiDeps, UiField, TransferUi } from './transferUi.js';
```

- [ ] **Step 8: Repoint the GUI's consumer**

In `packages/gui/src/transferBoot.ts`, replace line 1:

```typescript
import {
  caretAfterEdit, createTransferUi, type UiField,
} from '@tn3270/canvas/dist/transferUi.js';
```

**The deep path is deliberate and is not a shortcut** — it is what `canvas/src/index.ts` instructs, because the barrel pulls `@tn3270/core` and blanks the window.

- [ ] **Step 9: Add the canvas entry to the GUI's import map**

In `packages/gui/transfer.html`, replace the import map at line 19:

```html
{ "imports": {
    "@tn3270/frontend": "../frontend/dist/transferForm.js",
    "@tn3270/canvas": "../canvas/dist/transferUi.js"
} }
```

A relative path resolved against this document, which works because an Electron window loads from `file://` where `..` is a real directory. **A served page has no such thing** — see `httpstatic.ts:100-106`, and Task 4.

- [ ] **Step 10: Run the full gate**

Run:
```bash
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
```

Expected: build and typecheck exit 0, total test count **unchanged from before this task** (the tests moved, they did not multiply).

- [ ] **Step 11: Prove the real GUI transfer window still works**

The unit tests cannot see the import map or the module graph. This harness can, and the blank-page family is exactly what it catches.

Run:
```bash
node packages/gui/scripts/transfer.mjs 2>&1 | tail -5
```

Expected: `10/10`. **If this fails, the move broke the GUI** — check the import map and `BROWSER_MODULES` before going further.

- [ ] **Step 12: Commit**

```bash
git add -A packages/canvas packages/gui
git commit -m "refactor: move transferUi to packages/canvas, for the web gateway

Same reason keypadUi.ts lives there: packages/web needs this view and cannot
depend on an Electron app. Behaviour-preserving -- the test moved unchanged
and reports the same count from its new location.

The GUI now imports canvas/dist/transferUi.js DIRECTLY rather than through
the package barrel, which reaches @tn3270/core and blanks the window, and
transfer.html's import map gains the matching entry.

Verified: transfer.mjs 10/10 against the real Electron window, which is the
only cover the import map has.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: Chunking arithmetic

Pure functions, no socket and no DOM, so the ordering and cap rules are testable in isolation. The spec's *8 KB trap* is the constraint: `MAX_MESSAGE_BYTES` is 8192 and an oversize inbound frame **closes the socket**, so chunks must stay well under it.

**Files:**
- Create: `packages/web/src/transferChunk.ts`
- Test: `packages/web/test/transferChunk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/transferChunk.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  CHUNK_BYTES, MAX_TRANSFER_BYTES, chunkBytes, ChunkReassembler,
} from '../src/transferChunk.js';

describe('chunkBytes', () => {
  it('splits a buffer into chunks no larger than CHUNK_BYTES', () => {
    const src = new Uint8Array(CHUNK_BYTES * 2 + 17).fill(7);
    const chunks = chunkBytes(src);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.length).toBe(CHUNK_BYTES);
    expect(chunks[2]!.length).toBe(17);
  });

  it('leaves room under the 8192-byte frame cap once base64 expands it', () => {
    // base64 is 4 bytes out per 3 in. The JSON envelope adds its own overhead, so the
    // encoded chunk must be comfortably under MAX_MESSAGE_BYTES, not merely under it.
    const encodedSize = Math.ceil(CHUNK_BYTES / 3) * 4;
    expect(encodedSize).toBeLessThan(6000);
  });

  it('returns one empty-safe chunk list for an empty file', () => {
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
  });
});

describe('ChunkReassembler', () => {
  it('reassembles chunks in order into the declared total', () => {
    const r = new ChunkReassembler(5);
    expect(r.accept(0, new Uint8Array([1, 2, 3]))).toEqual({ ok: true, done: false });
    expect(r.accept(1, new Uint8Array([4, 5]))).toEqual({ ok: true, done: true });
    expect(r.bytes()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('rejects a chunk that arrives out of sequence, rather than guessing', () => {
    const r = new ChunkReassembler(5);
    r.accept(0, new Uint8Array([1, 2, 3]));
    const out = r.accept(5, new Uint8Array([4, 5]));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/out of sequence/);
  });

  it('rejects a duplicate sequence number', () => {
    const r = new ChunkReassembler(5);
    r.accept(0, new Uint8Array([1, 2, 3]));
    const out = r.accept(0, new Uint8Array([9, 9, 9]));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/out of sequence/);
  });

  it('rejects bytes exceeding the declared total', () => {
    const r = new ChunkReassembler(4);
    const out = r.accept(0, new Uint8Array([1, 2, 3, 4, 5]));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/exceeds declared/);
  });

  it('refuses a declared total over the 10 MB cap, naming both numbers', () => {
    // Decision 2: the refusal must be explicit, so the message carries the limit AND the
    // size. A fixed-width or truncated message would eat the remedy.
    expect(() => new ChunkReassembler(MAX_TRANSFER_BYTES + 1))
      .toThrow(/10485761 bytes exceeds the 10485760-byte limit/);
  });

  it('is not done until every declared byte has arrived', () => {
    const r = new ChunkReassembler(10);
    expect(r.accept(0, new Uint8Array([1, 2, 3]))).toEqual({ ok: true, done: false });
    expect(r.bytes()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/test/transferChunk.test.ts`
Expected: FAIL — `Failed to resolve import "../src/transferChunk.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/transferChunk.ts`:

```typescript
/**
 * Chunking and reassembly for socket-carried transfer bytes.
 *
 * ## WHY THE BYTES ARE CHUNKED AT ALL
 *
 * `wsserver.ts:19` caps an inbound message at `MAX_MESSAGE_BYTES` = 8192 and an oversize frame
 * CLOSES THE SOCKET with no message (`:106`, `:114`). That cap is not arbitrary: one process
 * serves up to 16 sessions (`args.ts:132`) and a large synchronous `type` would stall every
 * other operator's session. So a 10 MB upload cannot be one message, AND THE CAP MUST NOT BE
 * RAISED GLOBALLY -- doing so would re-open the exhaustion it exists to refuse, for all 16
 * sessions at once.
 *
 * ## THIS IS TRANSPORT ONLY, NOT A STREAMING ENGINE
 *
 * The reassembled buffer is handed to `startTransfer` whole. `CutTransfer` holds its source up
 * front SO IT CAN ANSWER A RETRANSMIT (`core/src/ft/transfer.ts:220`, `:226`), so a genuinely
 * streaming upload would have to buffer anyway. Streaming the DOWNLOAD direction is a separate,
 * easier job and is deliberately deferred -- see the spec's *Streaming the download*.
 */

/**
 * Source bytes per chunk.
 *
 * 4096 and not 8192: base64 expands 3 bytes to 4, so 4096 source bytes encode to 5464, which
 * leaves ~2.7 KB for the JSON envelope under the 8192 frame cap. Choosing a number that only
 * fits BEFORE encoding is the mistake this constant exists to avoid.
 */
export const CHUNK_BYTES = 4096;

/** Decision 1: 10 MB, and the number is exact so the refusal message can quote it. */
export const MAX_TRANSFER_BYTES = 10 * 1024 * 1024;

/** Split a buffer into wire-sized chunks. An empty source yields no chunks. */
export function chunkBytes(src: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < src.length; at += CHUNK_BYTES) {
    out.push(src.subarray(at, Math.min(at + CHUNK_BYTES, src.length)));
  }
  return out;
}

export interface AcceptResult {
  readonly ok: boolean;
  /** True once every declared byte has arrived. */
  readonly done?: boolean;
  readonly error?: string;
}

/**
 * Reassembles chunks against a total declared up front.
 *
 * STRICT SEQUENCING, AND IT REFUSES RATHER THAN REPAIRS. A gap, a duplicate or an overrun
 * abandons the transfer with a message the operator sees. It does NOT close the socket: a
 * malformed sequence is an operator-visible refusal, not a protocol violation, and closing
 * would take the whole 3270 session with it.
 */
export class ChunkReassembler {
  private readonly parts: Uint8Array[] = [];
  private received = 0;
  private next = 0;

  constructor(private readonly declared: number) {
    if (declared > MAX_TRANSFER_BYTES) {
      // DECISION 2: refused ON PURPOSE and the operator is told so. Both numbers appear, and
      // the limit comes second so a truncated line still shows what was attempted.
      throw new Error(
        `transfer of ${declared} bytes exceeds the ${MAX_TRANSFER_BYTES}-byte limit; `
        + 'the gateway stages the whole file in memory, so larger transfers are refused',
      );
    }
    if (declared < 0 || !Number.isInteger(declared)) {
      throw new Error(`declared total must be a non-negative integer, got ${declared}`);
    }
  }

  accept(seq: number, bytes: Uint8Array): AcceptResult {
    if (seq !== this.next) {
      return { ok: false, error: `chunk ${seq} arrived out of sequence, expected ${this.next}` };
    }
    if (this.received + bytes.length > this.declared) {
      return {
        ok: false,
        error: `chunk ${seq} exceeds declared total: `
          + `${this.received + bytes.length} > ${this.declared}`,
      };
    }
    this.parts.push(bytes);
    this.received += bytes.length;
    this.next += 1;
    return { ok: true, done: this.received === this.declared };
  }

  /** The joined bytes, or undefined while incomplete. */
  bytes(): Uint8Array | undefined {
    if (this.received !== this.declared) return undefined;
    const out = new Uint8Array(this.declared);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/test/transferChunk.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full gate**

Run: `npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4`
Expected: all green, total count up by 8.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/transferChunk.ts packages/web/test/transferChunk.test.ts
git commit -m "feat(web): chunking and reassembly for socket-carried transfer bytes

MAX_MESSAGE_BYTES is 8192 and an oversize inbound frame CLOSES THE SOCKET, so
a 10 MB upload cannot be one message -- and the cap must not be raised, since
one process serves 16 sessions and that is what it protects.

CHUNK_BYTES is 4096 rather than 8192 because base64 expands 3 bytes to 4:
4096 source bytes encode to 5464, leaving room for the JSON envelope. A size
that only fits before encoding is the mistake the constant documents.

The reassembler refuses rather than repairs -- gap, duplicate or overrun
abandons the transfer with an operator-visible message, and never closes the
socket, which would take the 3270 session with it.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: Protocol messages, and `transferForm` stops being refused

**Files:**
- Modify: `packages/web/src/protocol.ts`
- Test: `packages/web/test/protocol.test.ts`, `packages/web/test/integration.test.ts:116`

- [ ] **Step 1: Write the failing test**

Append to `packages/web/test/protocol.test.ts`:

```typescript
describe('transfer messages', () => {
  it('accepts a transferChunk with its sequence, declared total and base64 bytes', () => {
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 3, bytes: 'AQID',
    }));
    expect(msg.kind).toBe('transferChunk');
    if (msg.kind !== 'transferChunk') throw new Error('narrowing');
    expect(msg.seq).toBe(0);
    expect(msg.total).toBe(3);
    expect(msg.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a transferChunk whose bytes are not a string', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 3, bytes: 42,
    }))).toThrow(/bytes must be a base64 string/);
  });

  it('rejects a transferChunk with a non-integer seq', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferChunk', seq: 1.5, total: 3, bytes: 'AQID',
    }))).toThrow(/seq must be a non-negative integer/);
  });

  it('accepts transferStart with its keyword list', () => {
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 'LocalFile=x'],
    }));
    if (msg.kind !== 'transferStart') throw new Error('narrowing');
    expect(msg.keywords).toEqual(['Direction=send', 'LocalFile=x']);
  });

  it('rejects transferStart whose keywords are not all strings', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 7],
    }))).toThrow(/keywords must be an array of strings/);
  });

  it('accepts transferCancel', () => {
    expect(decodeClientMessage(JSON.stringify({ kind: 'transferCancel' })).kind)
      .toBe('transferCancel');
  });

  it('NO LONGER refuses the transferForm action', () => {
    // It was refused because a browser transfer would have written to the GATEWAY's disk.
    // Socket-carried file I/O is exactly what removes that reason.
    const msg = decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'transferForm' },
    }));
    expect(msg.kind).toBe('action');
  });

  it('STILL refuses copy and quit, which are refused for other reasons', () => {
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'copy' },
    }))).toThrow();
    expect(() => decodeClientMessage(JSON.stringify({
      kind: 'action', action: { kind: 'quit' },
    }))).toThrow();
  });

  it('round-trips transferProgress and transferDone as server messages', () => {
    // `inflateSync(encodeServerMessage(...))` is this suite's own idiom for a server message —
    // see its `round-trips a frame message` case. There is no decode helper and none is wanted.
    const prog = { kind: 'transferProgress' as const, text: '512 bytes' };
    expect(JSON.parse(inflateSync(encodeServerMessage(prog)).toString())).toEqual(prog);
    const done = { kind: 'transferDone' as const, ok: true, bytes: 249 };
    expect(JSON.parse(inflateSync(encodeServerMessage(done)).toString())).toEqual(done);
  });

  it('encodes transferData bytes as base64, the way the atlas message does', () => {
    const msg = {
      kind: 'transferData' as const, seq: 0, total: 3, bytes: new Uint8Array([1, 2, 3]),
    };
    const wire = JSON.parse(inflateSync(encodeServerMessage(msg)).toString());
    expect(wire.bytes).toBe('AQID');
  });
});
```

`inflateSync` is already imported at the top of that file for the existing round-trip cases; if
your editor reports it missing, add it to the existing `node:zlib` import rather than a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/test/protocol.test.ts`
Expected: FAIL — the transfer kinds are unknown, and `transferForm` still throws.

- [ ] **Step 3: Add the message types**

In `packages/web/src/protocol.ts`, extend the two unions:

```typescript
export type ServerMessage =
  | { kind: 'atlas'; geometry: AtlasGeometry; coverage: Uint8Array; blank: readonly number[] }
  | { kind: 'frame'; list: DrawList }
  | { kind: 'error'; message: string }
  | { kind: 'session'; id: string }
  // Transfer progress and completion. `ServerMessage` was `frame | error | session | atlas`
  // until now; web copy will be the next thing to widen it, as the handoff records.
  | { kind: 'transferProgress'; text: string }
  | { kind: 'transferDone'; ok: boolean; error?: string; bytes?: number }
  // A receive's bytes, chunked the same way an upload's are, then terminated by `transferDone`.
  | { kind: 'transferData'; seq: number; total: number; bytes: Uint8Array };

export type ClientMessage =
  | { kind: 'hello'; sessionId?: string }
  | { kind: 'action'; action: Action }
  | { kind: 'transferChunk'; seq: number; total: number; bytes: Uint8Array }
  | { kind: 'transferStart'; keywords: readonly string[] }
  | { kind: 'transferCancel' };
```

- [ ] **Step 4: Encode the binary-carrying kinds as base64**

Find the `encodeServerMessage` body (it already special-cases `atlas`) and extend the same way:

```typescript
export function encodeServerMessage(msg: ServerMessage): Buffer {
  // `coverage` is bytes and JSON has no way to hold them, so the atlas message carries base64.
  // `transferData` carries file bytes for exactly the same reason and in the same shape.
  const wire = msg.kind === 'atlas'
    ? { ...msg, coverage: Buffer.from(msg.coverage).toString('base64') }
    : msg.kind === 'transferData'
      ? { ...msg, bytes: Buffer.from(msg.bytes).toString('base64') }
      : msg;
  return deflateSync(Buffer.from(JSON.stringify(wire)));
}
```

- [ ] **Step 5: Decode the client kinds**

In `decodeClientMessage`, after the existing `action` branch, add:

```typescript
  if (kind === 'transferChunk') {
    const { seq, total, bytes } = raw as { seq?: unknown; total?: unknown; bytes?: unknown };
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      throw new Error('transferChunk seq must be a non-negative integer');
    }
    if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
      throw new Error('transferChunk total must be a non-negative integer');
    }
    if (typeof bytes !== 'string') {
      throw new Error('transferChunk bytes must be a base64 string');
    }
    return { kind: 'transferChunk', seq, total, bytes: new Uint8Array(Buffer.from(bytes, 'base64')) };
  }
  if (kind === 'transferStart') {
    const { keywords } = raw as { keywords?: unknown };
    if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== 'string')) {
      throw new Error('transferStart keywords must be an array of strings');
    }
    return { kind: 'transferStart', keywords: keywords as readonly string[] };
  }
  if (kind === 'transferCancel') return { kind: 'transferCancel' };
```

- [ ] **Step 6: Stop refusing `transferForm`, and rewrite the comment**

Replace the `transferForm` refusal block (around `protocol.ts:146`) with:

```typescript
    // `transferForm` IS NOW ACCEPTED, 2026-10-06. It was refused because a browser-initiated
    // transfer would have moved bytes between the host and the GATEWAY's filesystem rather than
    // the operator's -- and socket-carried file I/O is precisely what removes that reason. The
    // bytes now arrive as `transferChunk` messages and leave as `transferData`, so "local file"
    // means the operator's machine.
    //
    // `copy` AND `quit` STAY REFUSED and their reasons are unchanged: `quit` would stop the
    // gateway, and `copy` would extract text onto the SERVER's clipboard. Web copy is the next
    // roadmap item and will remove the second one the same way this removed this one.
    //
    // THE REFUSAL THAT REMAINS IS LOAD-BEARING: `applyAction` throws on `copy`, and
    // `web/src/main.ts` calls it outside any try in a socket data handler, so deleting that
    // refusal ends the gateway process on the first browser copy.
```

- [ ] **Step 7: Remove `transferForm` from the integration test's refusal list**

In `packages/web/test/integration.test.ts`, change line 116:

```typescript
const REFUSED: readonly string[] = ['quit', 'copy'];
```

Then update the docblock above it: the sentence saying `transferForm` is refused is now wrong. Change "THREE MEMBERS NOW" to "TWO MEMBERS NOW, since `transferForm` left on 2026-10-06 when socket-carried file I/O landed", and keep the `copy`/`quit` reasoning intact.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run packages/web/test/protocol.test.ts packages/web/test/integration.test.ts`
Expected: PASS. The integration test asserting the refusal list must now pass with two members.

- [ ] **Step 9: Run the full gate**

Run: `npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add packages/web/src/protocol.ts packages/web/test/protocol.test.ts packages/web/test/integration.test.ts
git commit -m "feat(web): transfer protocol messages, and transferForm stops being refused

transferForm was refused because a browser transfer would have written to the
GATEWAY's disk rather than the operator's. Socket-carried file I/O is exactly
what removes that reason, so it now decodes like any other action.

copy and quit STAY refused, unchanged, and that refusal is load-bearing:
applyAction throws on copy and main.ts calls it outside any try in a socket
data handler, so deleting it would end the gateway process on the first
browser copy. The integration test's REFUSED list drops to two members, which
is the assertion that this landed.

transferData carries receive bytes as base64 for the same reason the atlas
message carries coverage that way: JSON cannot hold bytes.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: Serve the browser modules, and give the overlay its specifier

**This is the task most likely to produce a blank page**, so it is isolated and has its own real-browser check. The hazard is trap 3: the import map already binds `@tn3270/canvas` to `keypadUi.js`.

**Files:**
- Modify: `packages/canvas/src/assets.ts:56-58`, `packages/web/src/httpstatic.ts`, `packages/web/static/index.html`
- Test: `packages/web/test/httpstatic.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/web/test/httpstatic.test.ts`:

```typescript
describe('transfer modules', () => {
  it('serves every browser module the transfer overlay needs', () => {
    // `resolveAsset` is this suite's own entry point — it is what the existing cases use, and
    // it answers for one URL path at a time. There is no map-returning helper.
    for (const path of [
      '/transferUi.js', '/transferBoot.js', '/transferOverlay.js',
      '/transferBridge.js', '/transferChunk.js',
    ]) {
      expect(resolveAsset(path), path).toBeDefined();
    }
  });

  it('serves transferForm.js, which transferUi.js imports for its field table', () => {
    // The import-graph closure rule this file already tests for the keypad: a 404 on a
    // transitive import means the IMPORTING module never executes, and the error surfaces in
    // the next script naming the wrong file.
    expect(resolveAsset('/transferForm.js')).toBeDefined();
  });

  it('lists transferUi.js in BROWSER_MODULES, which is what makes it served', () => {
    // `httpstatic.ts` DERIVES its canvas entries from that list rather than retyping them, so
    // this is the assertion that one edit reaches the server.
    expect(BROWSER_MODULES).toContain('transferUi.js');
  });
});
```

`resolveAsset` and `BROWSER_MODULES` are both already imported at the top of that file
(`httpstatic.test.ts:5-6`). Read a neighbouring case before writing these — if `resolveAsset`
returns something other than a defined/undefined value for a path, match how the existing
assertions check it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/test/httpstatic.test.ts`
Expected: FAIL — those four paths are absent.

- [ ] **Step 3: Add `transferUi.js` to the canvas asset list**

In `packages/canvas/src/assets.ts`, change the `BROWSER_MODULES` array (line 57):

```typescript
export const BROWSER_MODULES: readonly string[] = Object.freeze([
  'renderer.js', 'blit.js', 'keys.js', 'selection.js', 'keypadUi.js', 'transferUi.js',
]);
```

This list is what `canvas` publishes for browser consumers, and `httpstatic.ts` derives from it rather than retyping it — so this one edit makes the gateway serve the file.

- [ ] **Step 4: Serve this package's new browser modules**

In `packages/web/src/httpstatic.ts`, extend the module loop (currently line 53):

```typescript
  for (const module of [
    'bridge.js', 'bridgecore.js', 'keypadOverlay.js',
    // The transfer form, 2026-10-06. `transferBridge.js` is imported by `bridge.js` and
    // `transferBoot.js` by `transferOverlay.js`, so all three must be reachable by URL or the
    // chain breaks at the first missing link -- the measured failure recorded above.
    'transferOverlay.js', 'transferBoot.js', 'transferBridge.js', 'transferChunk.js',
  ]) {
    built.set(`/${module}`, { file: join(here, module), type: JS });
  }
```

- [ ] **Step 5: Serve `transferForm.js` from the frontend package**

In the same file, extend the frontend module loop (currently line 124):

```typescript
  // `transferForm.js` joined 2026-10-06 for the transfer overlay. It is SAFE by the same test
  // as its neighbours: zero imports at all, which is why the GUI's own import map points
  // straight at it.
  for (const module of ['keypadView.js', 'keypad.js', 'bindings.js', 'transferForm.js']) {
    built.set(`/${module}`, { file: join(frontendDist, module), type: JS });
  }
```

- [ ] **Step 6: Give the transfer modules their own import-map specifiers**

In `packages/web/static/index.html`, replace the import map (line 35):

```html
<script type="importmap">
{
  "imports": {
    "@tn3270/canvas": "./keypadUi.js",
    "@tn3270/frontend": "./keypadView.js",
    "@tn3270/canvas/dist/transferUi.js": "./transferUi.js",
    "@tn3270/frontend/dist/transferForm.js": "./transferForm.js"
  }
}
</script>
```

**WHY TWO MORE SPECIFIERS RATHER THAN CHANGING THE EXISTING TWO:** one specifier cannot name two
files, and `@tn3270/canvas` is already bound to `keypadUi.js` for the keypad overlay. The deep
paths are the same strings `tsc` resolves for the GUI, so the browser and the compiler agree.

- [ ] **Step 7: Make the moved module's import match the map**

`transferUi.ts` imports `@tn3270/frontend`, which the map binds to `keypadView.js` — the **wrong**
file for this module. Change its import in `packages/canvas/src/transferUi.ts` to the deep path:

```typescript
import {
  TRANSFER_FIELDS, applicable, cycleField, formKeywords, newTransferForm, setFieldText,
  type TransferFieldId, type TransferFormState, type TransferValues,
} from '@tn3270/frontend/dist/transferForm.js';
```

**This is the subtle part of the whole task.** With the bare specifier, the browser resolves
`@tn3270/frontend` to `keypadView.js`, which does not export `TRANSFER_FIELDS` — a module-resolution
failure that presents as a blank page. The GUI is unaffected because its own map gains the matching
entry in Task 1 Step 9; verify both still work in Step 9 below.

- [ ] **Step 8: Run the tests**

Run: `npm run build && npx vitest run packages/web/test/httpstatic.test.ts`
Expected: PASS.

- [ ] **Step 9: Prove BOTH front ends still load a real browser**

Run:
```bash
npm run build
node packages/gui/scripts/transfer.mjs 2>&1 | tail -3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
```

Expected: `10/10`, `1/1`, `9/9`. **Any blank-page regression shows up here and nowhere else.** If
`browser-shot.mjs` reports a black canvas or an `onAtlas` error, a module 404'd — check the served
list against the import map.

- [ ] **Step 10: Commit**

```bash
git add -A packages/canvas packages/web
git commit -m "feat(web): serve the transfer modules, with their own import specifiers

The import map already bound @tn3270/canvas to keypadUi.js for the keypad
overlay, and one specifier cannot name two files -- so the transfer form gets
deep-path specifiers matching the strings tsc already resolves.

THE SUBTLE PART: transferUi.ts imported @tn3270/frontend bare, which the map
binds to keypadView.js -- a module with no TRANSFER_FIELDS export. That is a
resolution failure presenting as a blank page, so the import is now the deep
path and both front ends' maps name it.

BROWSER_MODULES gains transferUi.js, and httpstatic derives from that list
rather than retyping it, so one edit serves the file. transferForm.js joins
the served frontend modules; it is safe by the same test as its neighbours,
having zero imports at all.

Verified in real browsers, which is the only place this class of failure
shows: transfer.mjs 10/10, browser-shot 1/1, browser-clicks 9/9.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: The browser-side transfer bridge

File reading, chunk sending, and the save sink. Beside `bridgecore.ts`, never inside it (trap 4).

**Files:**
- Create: `packages/web/src/transferBridge.ts`
- Test: `packages/web/test/transferBridge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/transferBridge.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTransferBridge, type TransferBridgeDeps } from '../src/transferBridge.js';
import { MAX_TRANSFER_BYTES } from '../src/transferChunk.js';

/** A fake socket and sink, because vitest runs `environment: 'node'`. */
function deps(over: Partial<TransferBridgeDeps> = {}): {
  d: TransferBridgeDeps; sent: string[]; saved: { name: string; bytes: Uint8Array }[];
} {
  const sent: string[] = [];
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const d: TransferBridgeDeps = {
    send: (text) => { sent.push(text); },
    savePicker: undefined,
    saveFallback: (name, bytes) => { saved.push({ name, bytes }); },
    ...over,
  };
  return { d, sent, saved };
}

describe('sending a local file', () => {
  it('chunks the bytes and then sends transferStart', async () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    await b.sendFile('x.c', new Uint8Array([1, 2, 3]), ['Direction=send', 'LocalFile=x.c']);
    const kinds = sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toEqual(['transferChunk', 'transferStart']);
    const first = JSON.parse(sent[0]!);
    expect(first.seq).toBe(0);
    expect(first.total).toBe(3);
    expect(first.bytes).toBe('AQID');
  });

  it('refuses a file over 10 MB in the BROWSER, before sending anything', async () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    const big = new Uint8Array(MAX_TRANSFER_BYTES + 1);
    const out = await b.sendFile('big.bin', big, ['Direction=send']);
    expect(out.ok).toBe(false);
    // Decision 2: the operator is told the limit AND the size, on purpose.
    expect(out.error).toMatch(/10485761 bytes/);
    expect(out.error).toMatch(/10485760-byte limit/);
    expect(sent, 'nothing may be sent for a refused file').toEqual([]);
  });

  it('sends an empty file as transferStart with no chunks', async () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    await b.sendFile('empty', new Uint8Array(0), ['Direction=send']);
    expect(sent.map((s) => JSON.parse(s).kind)).toEqual(['transferStart']);
  });
});

describe('receiving into the browser', () => {
  it('uses the save picker when one is available', async () => {
    const writes: Uint8Array[] = [];
    const closed = vi.fn();
    const savePicker = vi.fn(async () => ({
      write: async (b: Uint8Array) => { writes.push(b); },
      close: closed,
    }));
    const { d, saved } = deps({ savePicker });
    const b = createTransferBridge(d);
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    b.acceptData(1, 4, new Uint8Array([3, 4]));
    await b.save('out.bin');
    expect(savePicker).toHaveBeenCalledWith('out.bin');
    expect(writes).toEqual([new Uint8Array([1, 2, 3, 4])]);
    expect(closed).toHaveBeenCalled();
    expect(saved, 'the fallback must not also run').toEqual([]);
  });

  it('falls back to a plain download when there is no picker', async () => {
    const { d, saved } = deps({ savePicker: undefined });
    const b = createTransferBridge(d);
    b.acceptData(0, 2, new Uint8Array([9, 8]));
    await b.save('out.bin');
    expect(saved).toEqual([{ name: 'out.bin', bytes: new Uint8Array([9, 8]) }]);
  });

  it('reports unsaved bytes, so dismissing the overlay can warn', async () => {
    const { d } = deps();
    const b = createTransferBridge(d);
    expect(b.hasUnsaved()).toBe(false);
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    expect(b.hasUnsaved()).toBe(true);
    await b.save('out.bin');
    expect(b.hasUnsaved()).toBe(false);
  });

  it('refuses out-of-sequence received data rather than writing a corrupt file', () => {
    const { d } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    const out = b.acceptData(7, 4, new Uint8Array([3, 4]));
    expect(out.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/web/test/transferBridge.test.ts`
Expected: FAIL — `Failed to resolve import "../src/transferBridge.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/transferBridge.ts`:

```typescript
import {
  CHUNK_BYTES, MAX_TRANSFER_BYTES, ChunkReassembler, chunkBytes,
} from './transferChunk.js';

/**
 * The browser side of file transfer: read a local file out, write a received file in.
 *
 * ## BESIDE `bridgecore.ts` AND NOT INSIDE IT
 *
 * That module's header states the rule: *"If this file grows a fifth function, the renderer has
 * stopped being shared."* `onAtlas`/`onFrame`/`onError`/`sendAction` is the renderer's whole
 * bridge, and `renderer.ts` is reused UNMODIFIED by the Electron GUI. Transfer plumbing is a
 * separate object with its own dependencies, exactly as `keypadOverlay.ts` sits beside it.
 *
 * ## EVERY BROWSER CAPABILITY IS INJECTED
 *
 * `vitest.config.ts` sets `environment: 'node'`: there is no `document`, no `File`, no
 * `showSaveFilePicker` in any test in this repo, and jsdom is not a dependency. The same
 * constraint produced the same shape in `bridgecore.ts` (its socket) and `transferUi.ts` (its
 * DOM). `savePicker` being `undefined` IS the feature-detection result, injected rather than
 * read from `window` at the call site -- which is what lets a unit test drive BOTH save routes.
 * The fallback is the one at risk of rotting, because a developer on Chrome-over-localhost
 * always gets the picker.
 */

/** A disk-backed sink: `FileSystemWritableFileStream`, narrowed to what this uses. */
export interface SaveSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface TransferBridgeDeps {
  /** Put one JSON text on the socket. */
  send(text: string): void;
  /**
   * Open a save dialog, or `undefined` when the browser has none.
   *
   * `showSaveFilePicker` is Chrome/Edge/Opera desktop only -- NO Firefox, NO Safari desktop or
   * iOS, nothing on mobile -- and needs a secure context, which a LAN gateway on plain http
   * does not have. See the spec's *The save dialog, and where it is not available*.
   */
  savePicker?: (suggestedName: string) => Promise<SaveSink>;
  /** A plain `Blob` download, which works everywhere. */
  saveFallback(name: string, bytes: Uint8Array): void;
}

export interface SendResult { readonly ok: boolean; readonly error?: string }

export interface TransferBridge {
  sendFile(name: string, bytes: Uint8Array, keywords: readonly string[]): Promise<SendResult>;
  acceptData(seq: number, total: number, bytes: Uint8Array): { ok: boolean; error?: string };
  save(name: string): Promise<void>;
  hasUnsaved(): boolean;
  cancel(): void;
}

export function createTransferBridge(deps: TransferBridgeDeps): TransferBridge {
  let inbound: ChunkReassembler | undefined;
  let complete: Uint8Array | undefined;

  const b64 = (bytes: Uint8Array): string => {
    // `btoa` over a binary string: the browser has no Buffer, and a spread into
    // String.fromCharCode would blow the argument limit on a 4 KB chunk's worth of args.
    let s = '';
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  };

  return {
    async sendFile(name, bytes, keywords) {
      if (bytes.length > MAX_TRANSFER_BYTES) {
        // REFUSED IN THE BROWSER, BEFORE A SINGLE CHUNK GOES OUT -- decision 2. The gateway
        // re-checks the declared total because a client is not to be trusted, but the operator
        // should learn this without the round trip.
        return {
          ok: false,
          error: `${name} is ${bytes.length} bytes, over the ${MAX_TRANSFER_BYTES}-byte limit; `
            + 'the gateway stages the whole file in memory, so larger transfers are refused',
        };
      }
      const chunks = chunkBytes(bytes);
      for (let i = 0; i < chunks.length; i++) {
        deps.send(JSON.stringify({
          kind: 'transferChunk', seq: i, total: bytes.length, bytes: b64(chunks[i]!),
        }));
      }
      // AFTER the chunks, always: the gateway stages bytes and starts on this message, so
      // arriving first would start a transfer over an empty buffer.
      deps.send(JSON.stringify({ kind: 'transferStart', keywords }));
      return { ok: true };
    },

    acceptData(seq, total, bytes) {
      if (inbound === undefined) inbound = new ChunkReassembler(total);
      const out = inbound.accept(seq, bytes);
      if (!out.ok) { inbound = undefined; return out; }
      if (out.done === true) { complete = inbound.bytes(); inbound = undefined; }
      return out;
    },

    async save(name) {
      const bytes = complete;
      if (bytes === undefined) return;
      if (deps.savePicker !== undefined) {
        const sink = await deps.savePicker(name);
        await sink.write(bytes);
        // `close()` IS WHAT COMMITS IT. MDN: "No changes are written to the actual file on disk
        // until the stream has been closed" -- the writes land in a temp file, which is what
        // makes this sink disk-backed rather than another buffer in memory.
        await sink.close();
      } else {
        deps.saveFallback(name, bytes);
      }
      complete = undefined;
    },

    hasUnsaved() { return complete !== undefined; },

    cancel() {
      inbound = undefined;
      complete = undefined;
      deps.send(JSON.stringify({ kind: 'transferCancel' }));
    },
  };
}

/** Re-exported so `transferBoot.ts` need not import two modules for one constant. */
export { CHUNK_BYTES, MAX_TRANSFER_BYTES };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/web/test/transferBridge.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Run the full gate**

Run: `npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/transferBridge.ts packages/web/test/transferBridge.test.ts
git commit -m "feat(web): the browser side of file transfer

Beside bridgecore.ts and not inside it: that module's four functions are the
renderer's whole bridge and renderer.ts is reused unmodified by the GUI, so a
fifth would mean it had stopped being shared.

Every browser capability is INJECTED, including feature detection:
savePicker === undefined IS the detection result, which is what lets a unit
test drive BOTH save routes. The Blob fallback is the one at risk of rotting,
since a developer on Chrome-over-localhost always gets the picker.

Chunks go out BEFORE transferStart, always -- the gateway stages bytes and
starts on that message, so the reverse order would transfer an empty buffer.
A file over 10 MB is refused in the browser before a single chunk is sent,
naming both the size and the limit.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 6: The overlay

Visibility and lifecycle only, modelled directly on `keypadOverlay.ts`.

**Files:**
- Create: `packages/web/src/transferOverlay.ts`
- Test: `packages/web/test/transferOverlay.test.ts`

- [ ] **Step 1: Read the precedent**

Run: `sed -n '1,60p' packages/web/src/keypadOverlay.ts`

Note three things it documents, all of which apply here: the overlay is **opaque** (`background: Canvas`) because host text leaked through the TUI's once; it is `position: fixed` so it never displaces the canvas (a sibling in flow breaks click arithmetic in **both** front ends through the shared renderer); and it builds **lazily, at most once**.

- [ ] **Step 2: Write the failing test**

Create `packages/web/test/transferOverlay.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createTransferOverlay, type TransferOverlayDeps } from '../src/transferOverlay.js';

function fake(over: Partial<TransferOverlayDeps> = {}) {
  const element = { style: { display: 'none' } } as unknown as HTMLElement;
  const build = vi.fn();
  const confirmDiscard = vi.fn(() => true);
  const deps: TransferOverlayDeps = {
    element, build, hasUnsaved: () => false, confirmDiscard, ...over,
  };
  return { deps, element, build, confirmDiscard };
}

describe('createTransferOverlay', () => {
  it('starts hidden and builds nothing until first shown', () => {
    const { deps, element, build } = fake();
    createTransferOverlay(deps);
    expect(element.style.display).toBe('none');
    expect(build).not.toHaveBeenCalled();
  });

  it('builds exactly once, however many times it is shown', () => {
    const { deps, build } = fake();
    const o = createTransferOverlay(deps);
    o.show(); o.hide(); o.show();
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('shows and hides by display', () => {
    const { deps, element } = fake();
    const o = createTransferOverlay(deps);
    o.show();
    expect(element.style.display).toBe('block');
    o.hide();
    expect(element.style.display).toBe('none');
  });

  it('WARNS before discarding a completed transfer nobody saved', () => {
    // The transfer SUCCEEDED and the host is out of transfer mode, so there is nothing to
    // retry from -- the same principle as transferRun.ts refusing to report a "complete"
    // that left no file. Not a memory concern: 10 MB in a browser is nothing.
    const { deps, element, confirmDiscard } = fake({ hasUnsaved: () => true });
    const o = createTransferOverlay(deps);
    o.show();
    o.hide();
    expect(confirmDiscard).toHaveBeenCalled();
    expect(element.style.display).toBe('none');
  });

  it('stays open when the operator declines to discard', () => {
    const { deps, element } = fake({
      hasUnsaved: () => true, confirmDiscard: () => false,
    });
    const o = createTransferOverlay(deps);
    o.show();
    o.hide();
    expect(element.style.display, 'must not close over unsaved bytes').toBe('block');
  });

  it('does not prompt when there is nothing unsaved', () => {
    const { deps, confirmDiscard } = fake({ hasUnsaved: () => false });
    const o = createTransferOverlay(deps);
    o.show(); o.hide();
    expect(confirmDiscard).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/web/test/transferOverlay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

Create `packages/web/src/transferOverlay.ts`:

```typescript
/**
 * The web gateway's transfer form: AN OPAQUE OVERLAY IN THE SAME PANE, like the keypad.
 *
 * ## THE THREE RULES INHERITED FROM `keypadOverlay.ts`, ALL LOAD-BEARING
 *
 * 1. **Opaque, not translucent.** `ui.css` sets `background: Canvas`. The TUI's keypad overlay
 *    once let host text leak through and opacity was the hard-won fix; a form over a 3270
 *    screen is worse, because these are editable fields.
 * 2. **`position: fixed`, so it paints OVER the canvas without displacing it.** `gui/src/main.ts`
 *    records why that is not cosmetic: the click path's `offsetX` arithmetic depends on the
 *    canvas sitting at the viewport origin. A sibling in normal flow would push it down and
 *    break the OTHER front end's clicks too, via the shared renderer. `browser-clicks.mjs` found
 *    exactly that -- `ui.css` styling `body` and displacing the canvas by 15px.
 * 3. **Built lazily, at most once.** Rebuilding the form per keystroke would be invisible work
 *    that also discards focus.
 *
 * ## WHY IT WARNS BEFORE CLOSING
 *
 * A completed receive holds its bytes until the operator saves. Dismissing the overlay then
 * loses a transfer that SUCCEEDED, with the host already out of transfer mode and nothing to
 * retry from -- the same thing `transferRun.ts` refuses to do when it will not report a
 * "complete" that left no file. It is NOT a memory concern: 10 MB in a browser is nothing, which
 * the user said plainly.
 */
export interface TransferOverlayDeps {
  readonly element: HTMLElement;
  /** Fill the overlay. Called AT MOST ONCE, lazily, on first show. */
  readonly build: () => void;
  /** Does a completed transfer still need saving? */
  readonly hasUnsaved: () => boolean;
  /** Ask the operator to confirm losing it. True means close anyway. */
  readonly confirmDiscard: () => boolean;
}

export interface TransferOverlay {
  show(): void;
  hide(): void;
  visible(): boolean;
}

export function createTransferOverlay(deps: TransferOverlayDeps): TransferOverlay {
  let built = false;
  let shown = false;

  return {
    show() {
      if (!built) { deps.build(); built = true; }
      shown = true;
      deps.element.style.display = 'block';
    },
    hide() {
      if (deps.hasUnsaved() && !deps.confirmDiscard()) return;
      shown = false;
      deps.element.style.display = 'none';
    },
    visible() { return shown; },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/web/test/transferOverlay.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Run the full gate and commit**

```bash
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
git add packages/web/src/transferOverlay.ts packages/web/test/transferOverlay.test.ts
git commit -m "feat(web): the transfer overlay's visibility and lifecycle

Modelled on keypadOverlay.ts and inheriting its three load-bearing rules:
opaque because host text once leaked through the TUI's, position: fixed
because a sibling in flow displaces the canvas and breaks click arithmetic in
BOTH front ends through the shared renderer, and built lazily at most once.

It warns before closing over a completed-but-unsaved transfer: that transfer
SUCCEEDED and the host is out of transfer mode, so there is nothing to retry
from -- the same principle as transferRun.ts refusing to report a complete
that left no file. Not a memory concern.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 7: Gateway-side staging and the transfer run

Where the staged bytes meet the **unmodified** `startTransfer`.

**Files:**
- Modify: `packages/web/src/main.ts`
- Test: `packages/web/test/integration.test.ts`

- [ ] **Step 1: Find the message dispatch and session plumbing**

Run:
```bash
grep -n "decodeClientMessage\|case 'action'\|kind === 'action'\|applyAction" packages/web/src/main.ts | head -10
grep -n "detach\|registry.attach" packages/web/src/main.ts | head -5
```

Note the exact dispatch shape and the per-connection state object — the staging buffer belongs there, **per connection**, so one operator's upload cannot reach another's session.

- [ ] **Step 2: Write the failing test**

Append to `packages/web/test/integration.test.ts`. **This uses the suite's own helpers** — `start()`
at `:52`, `reader(ws)` at `:144` with its `next(what)`/`settle()` pair, and the open-then-`hello`
preamble every end-to-end case here uses. Do not add a parallel harness.

```typescript
describe('socket-carried file transfer', () => {
  /** Open, handshake, and settle — the preamble every case below shares. */
  async function connected(): Promise<{ ws: WebSocket; r: ReturnType<typeof reader> }> {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((res) => ws.addEventListener('open', res, { once: true }));
    const r = reader(ws);
    ws.send(JSON.stringify({ kind: 'hello' }));
    // session + atlas + frame arrive unprompted; settle past them so the next `next()` is ours.
    await r.settle();
    return { ws, r };
  }

  it('refuses a declared total over 10 MB WITHOUT closing the socket', async () => {
    const { ws, r } = await connected();
    ws.send(JSON.stringify({
      kind: 'transferChunk', seq: 0, total: 10 * 1024 * 1024 + 1, bytes: 'AQ==',
    }));
    const msg = await r.next('the oversize transferChunk');
    expect(msg['kind']).toBe('transferDone');
    expect(msg['ok']).toBe(false);
    expect(String(msg['error'])).toMatch(/exceeds the 10485760-byte limit/);
    // THE PROPERTY THAT MATTERS: closing would take the operator's whole 3270 session with it.
    expect(ws.readyState, 'a refusal must not close the socket').toBe(WebSocket.OPEN);
    ws.close();
  });

  it('refuses an out-of-sequence chunk and abandons the staged buffer', async () => {
    const { ws, r } = await connected();
    ws.send(JSON.stringify({ kind: 'transferChunk', seq: 0, total: 4, bytes: 'AQI=' }));
    ws.send(JSON.stringify({ kind: 'transferChunk', seq: 9, total: 4, bytes: 'AwQ=' }));
    const msg = await r.next('the out-of-sequence transferChunk');
    expect(msg['ok']).toBe(false);
    expect(String(msg['error'])).toMatch(/out of sequence/);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('refuses transferStart before the declared bytes have all arrived', async () => {
    const { ws, r } = await connected();
    ws.send(JSON.stringify({ kind: 'transferChunk', seq: 0, total: 99, bytes: 'AQI=' }));
    ws.send(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 'LocalFile=x', 'HostFile=X'],
    }));
    const msg = await r.next('the premature transferStart');
    expect(msg['ok']).toBe(false);
    expect(String(msg['error'])).toMatch(/incomplete/);
    ws.close();
  });

  it('reports startTransfer\'s own refusal, which never reaches onDone', async () => {
    // `startTransfer` returns `{ok:false}` before the host is told anything — not in 3270 mode,
    // a refused field, a local Exist check — and `onDone` is NEVER called in that case
    // (transferRun.ts:81). So the gateway must report it directly or the operator sees nothing.
    const { ws, r } = await connected();
    ws.send(JSON.stringify({ kind: 'transferChunk', seq: 0, total: 2, bytes: 'AQI=' }));
    ws.send(JSON.stringify({
      kind: 'transferStart', keywords: ['Direction=send', 'LocalFile=x', 'HostFile=X'],
    }));
    const msg = await r.next('the transferStart');
    expect(msg['kind']).toBe('transferDone');
    expect(typeof msg['error']).toBe('string');
    ws.close();
  });

  it('rejects a malformed transfer message without killing the session', async () => {
    const { ws, r } = await connected();
    ws.send(JSON.stringify({ kind: 'transferChunk', seq: 0, total: 3, bytes: 42 }));
    const msg = await r.next('the malformed transferChunk');
    // A decode failure answers on this one socket, as `main.ts` already does for any bad frame.
    expect(msg['kind']).toBe('error');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
```

**Note the whole-screen assumption this makes:** `reader`'s `next()` has a 2-second deadline, under
vitest's 5-second per-test timeout, so a kind that never answers fails naming itself. If a case here
legitimately needs longer, raise the **test's** timeout as that helper's comment instructs — do not
raise the reader's deadline.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/web/test/integration.test.ts`
Expected: FAIL — the gateway ignores the transfer kinds, so `nextOfKind('transferDone')` times out.

- [ ] **Step 4: Add the per-connection staging state**

In `packages/web/src/main.ts`, inside the per-connection scope (beside whatever holds the session handle), add:

```typescript
  // PER CONNECTION, not per process: one operator's staged upload must not be reachable from
  // another's session. Discarded on detach for the same reason -- a reattaching client must not
  // resume into a half-filled buffer left by whoever held the id before.
  let staging: ChunkReassembler | undefined;
  let stagedBytes: Uint8Array | undefined;
  let run: TransferRun | undefined;
```

with the imports:

```typescript
import { ChunkReassembler } from './transferChunk.js';
import { startTransfer, transferCommand, type TransferRun } from '@tn3270/frontend';
```

Check the exact export names first:

```bash
grep -n "startTransfer\|transferCommand\|TransferRun" packages/frontend/src/index.ts | head -5
```

- [ ] **Step 5: Handle the three client messages**

In the message dispatch, after the `action` case:

```typescript
      if (msg.kind === 'transferChunk') {
        try {
          // The FIRST chunk declares the total, and the constructor is where the 10 MB cap is
          // enforced -- it throws, which is why this is inside the try.
          if (staging === undefined) staging = new ChunkReassembler(msg.total);
          const out = staging.accept(msg.seq, msg.bytes);
          if (!out.ok) {
            staging = undefined;
            sendServer({ kind: 'transferDone', ok: false, error: out.error });
            return;
          }
          if (out.done === true) { stagedBytes = staging.bytes(); staging = undefined; }
        } catch (err) {
          // A REFUSAL, NOT A PROTOCOL VIOLATION: the socket stays open, because closing it would
          // take the operator's whole 3270 session with it.
          staging = undefined;
          sendServer({
            kind: 'transferDone', ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (msg.kind === 'transferStart') {
        const bytes = stagedBytes;
        stagedBytes = undefined;
        if (bytes === undefined) {
          sendServer({
            kind: 'transferDone', ok: false,
            error: 'transfer bytes are incomplete: no fully staged file to send',
          });
          return;
        }
        let received: Uint8Array | undefined;
        try {
          const { request, command } = transferCommand(msg.keywords);
          run = startTransfer({
            session,
            // THE WHOLE POINT OF THIS FEATURE, in four methods. The bytes came over the socket
            // from the operator's machine, so `read` hands back what they sent and `write`
            // captures what the host returned -- neither touches the gateway's disk.
            //
            // `TransferFiles` IS SYNCHRONOUS AND STAYS SO. No call happens mid-transfer: a send
            // reads once up front before the host is told anything (transferRun.ts:102) and a
            // receive writes once at the end with every byte already in memory (:335, :401).
            files: {
              exists: () => false,
              read: () => bytes,
              write: (_p, b) => { received = b; },
              append: (_p, b) => { received = b; },
            },
            request,
            command,
            onProgress: (text) => { sendServer({ kind: 'transferProgress', text }); },
            onDone: (result) => {
              run = undefined;
              if (result.ok && received !== undefined) {
                // Chunked out the same way an upload comes in, then terminated by transferDone.
                const chunks = chunkBytes(received);
                for (let i = 0; i < chunks.length; i++) {
                  sendServer({
                    kind: 'transferData', seq: i, total: received.length, bytes: chunks[i]!,
                  });
                }
              }
              sendServer({ kind: 'transferDone', ...result });
            },
          });
          if (run.ok === false) {
            // `startTransfer` can refuse before the host is told -- not in 3270 mode, an
            // unreadable field, a local `Exist` check. `onDone` is NEVER called in that case
            // (transferRun.ts:81), so the refusal must be reported here or it is lost.
            sendServer({ kind: 'transferDone', ok: false, error: run.error });
            run = undefined;
          }
        } catch (err) {
          // `transferCommand` throws on a bad keyword list. The operator typed it, so they get
          // the message.
          sendServer({
            kind: 'transferDone', ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      if (msg.kind === 'transferCancel') {
        run?.cancel?.();
        run = undefined;
        staging = undefined;
        stagedBytes = undefined;
        return;
      }
```

Verify `TransferRun`'s refusal shape and its cancel method name before writing this — the union has an `ok: false` arm and a running arm:

```bash
grep -n "interface TransferRun\|type TransferRun" -A 20 packages/frontend/src/transferRun.ts | head -30
```

Adjust the two `run` lines to match exactly what that type offers.

- [ ] **Step 6: Discard staged bytes on detach**

Find the detach/close path for a connection and add:

```typescript
    // A half-staged upload dies with the connection. The 3270 session survives a drop by design
    // (`graceMs`), but a reattaching client must not inherit someone else's partial file.
    staging = undefined;
    stagedBytes = undefined;
```

- [ ] **Step 7: Run the tests**

Run: `npm run build && npx vitest run packages/web/test/integration.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full gate and commit**

```bash
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
git add packages/web/src/main.ts packages/web/test/integration.test.ts
git commit -m "feat(web): stage socket-carried bytes and run the transfer

The staged buffer meets an UNMODIFIED startTransfer through a four-method
in-memory TransferFiles: read hands back what the operator sent, write
captures what the host returned, and neither touches the gateway's disk --
which is the whole point of the feature.

TransferFiles stays SYNCHRONOUS because no call happens mid-transfer: a send
reads once up front before the host is told anything (transferRun.ts:102) and
a receive writes once at the end with every byte already in memory (:335,
:401). So TransferFiles, startTransfer, transferRun and both engines are
untouched.

Staging is PER CONNECTION and discarded on detach: one operator's partial
upload must not be reachable from another's session, and a reattaching client
must not inherit it.

Every refusal leaves the socket OPEN -- closing would take the operator's
whole 3270 session with it. And startTransfer's own early refusals are
reported here, because onDone is never called in that case.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 8: Wire the browser: markup, styles, boot

**Files:**
- Create: `packages/web/src/transferBoot.ts`
- Modify: `packages/web/static/index.html`, the served `ui.css`, `packages/web/src/bridge.ts`

- [ ] **Step 1: Read the GUI's boot module and the served stylesheet**

Run:
```bash
sed -n '1,60p' packages/gui/src/transferBoot.ts
grep -n "ui.css" packages/web/src/httpstatic.ts
grep -n "keypad-overlay" packages/gui/ui.css | head -5
```

`transferBoot.ts` in the GUI is the model: real elements in, `createTransferUi` out, with everything decidable left in `transferUi.ts`. Note which `ui.css` the gateway actually serves — the keypad work extracted a shared one, so add rules there rather than creating a second copy.

- [ ] **Step 2: Add the overlay markup**

In `packages/web/static/index.html`, after the keypad overlay element, add:

```html
<!--
  THE TRANSFER OVERLAY. Same rules as the keypad's, next to it in document order: opaque and
  `position: fixed` in `ui.css`, so it paints over the canvas without displacing it. A sibling
  in normal flow would push the canvas down and break click arithmetic in BOTH front ends
  through the shared renderer -- measured once already, as a 15px displacement from `ui.css`
  styling `body`.

  THE FIELD IDS ARE PREFIXED, which `keypadUi.ts:81` anticipated in writing: these two forms
  share one document here, so `transfer-local` cannot collide where `local` might.
-->
<div id="transfer-overlay" hidden>
  <h2>File transfer</h2>
  <div id="transfer-fields"></div>
  <p id="transfer-status"></p>
  <div id="transfer-buttons">
    <button type="button" id="transfer-browse">Browse…</button>
    <button type="button" id="transfer-start">Start</button>
    <button type="button" id="transfer-save" disabled>Save…</button>
    <button type="button" id="transfer-cancel">Cancel</button>
    <button type="button" id="transfer-close">Close</button>
  </div>
  <input type="file" id="transfer-file" hidden>
</div>
```

**`type="button"` on every button is explicit and load-bearing**: a bare `<button>` inside a form defaults to `type="submit"`, which `keypadUi.ts` documents as the trap that would turn a key into a page reload.

**The `Save…` button exists because the save picker needs transient user activation** — it cannot be opened from the completion callback, since the click that started the transfer is spent by then.

- [ ] **Step 3: Add the overlay styles**

Append to the served `ui.css` (the one `httpstatic.ts` serves — confirmed in Step 1):

```css
/*
 * THE TRANSFER OVERLAY. `position: fixed` and an opaque background, for the two reasons
 * `#keypad-overlay` above gives: a sibling in normal flow displaces the canvas and breaks the
 * click arithmetic in both front ends, and a translucent panel lets host text leak through a
 * surface that here contains EDITABLE FIELDS.
 */
#transfer-overlay {
  position: fixed;
  top: 2rem;
  left: 2rem;
  z-index: 2;
  padding: 1rem;
  background: Canvas;
  border: 1px solid CanvasText;
}
#transfer-overlay[hidden] { display: none; }
#transfer-fields { display: grid; grid-template-columns: auto 1fr; gap: 0.4rem 0.8rem; }
#transfer-buttons { margin-top: 0.8rem; display: flex; gap: 0.5rem; }
```

- [ ] **Step 4: Write the boot module**

Create `packages/web/src/transferBoot.ts`:

```typescript
import { createTransferUi, caretAfterEdit, type UiField } from '@tn3270/canvas/dist/transferUi.js';
import { createTransferBridge, type SaveSink } from './transferBridge.js';
import { createTransferOverlay } from './transferOverlay.js';

/**
 * The browser entry point for the transfer form: real elements in, a wired overlay out.
 *
 * ## EVERYTHING DECIDABLE LIVES ELSEWHERE
 *
 * The GUI's `transferBoot.ts` states the rule this follows: if a branch here is about the MODEL
 * it belongs in `transferUi.ts`, and what remains is about real elements -- focus, enablement,
 * and the two browser capabilities that have no Node equivalent. That is why this file has no
 * unit test and `transferUi.test.ts`, `transferBridge.test.ts` and `transferOverlay.test.ts` do.
 *
 * ## THE DEEP IMPORT SPECIFIERS ARE REQUIRED
 *
 * `@tn3270/canvas/dist/transferUi.js`, not `@tn3270/canvas`: the bare specifier is mapped to
 * `keypadUi.js` for the keypad overlay, and the package BARREL reaches `@tn3270/core` and blanks
 * the window. `index.html`'s import map carries the matching entry.
 */
export function bootTransfer(doc: Document, send: (text: string) => void): {
  show: () => void; onProgress: (t: string) => void;
  onDone: (r: { ok: boolean; error?: string; bytes?: number }) => void;
  onData: (seq: number, total: number, bytes: Uint8Array) => void;
} {
  const need = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    // NAMED, because a missing element is the blank-page family again: without this the first
    // property access throws `null is not an object` from a line that does not say which id.
    if (el === null) throw new Error(`transfer overlay is missing #${id}`);
    return el as T;
  };

  const fileInput = need<HTMLInputElement>('transfer-file');
  const status = need('transfer-status');
  const fields = need('transfer-fields');
  const saveButton = need<HTMLButtonElement>('transfer-save');

  let pending: { name: string; bytes: Uint8Array } | undefined;
  let lastReceivedName = 'download.bin';

  // FEATURE DETECTION, READ ONCE AND INJECTED. `showSaveFilePicker` is Chrome/Edge/Opera desktop
  // only and needs a secure context, so a LAN gateway on plain http has no picker on ANY browser.
  // Passing it as a dependency rather than reading `window` inside the bridge is what lets a unit
  // test drive both routes.
  const picker = 'showSaveFilePicker' in globalThis
    ? async (suggestedName: string): Promise<SaveSink> => {
      const handle = await (globalThis as unknown as {
        showSaveFilePicker(o: { suggestedName: string }): Promise<{
          createWritable(): Promise<SaveSink>;
        }>;
      }).showSaveFilePicker({ suggestedName });
      return handle.createWritable();
    }
    : undefined;

  const bridge = createTransferBridge({
    send,
    savePicker: picker,
    saveFallback: (name, bytes) => {
      const url = URL.createObjectURL(new Blob([bytes]));
      const a = doc.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  const ui = createTransferUi({
    render: (list: readonly UiField[]) => { renderFields(doc, fields, list, ui); },
    setStatus: (text) => { status.textContent = text; },
    setRunning: (running) => {
      need<HTMLButtonElement>('transfer-start').disabled = running;
      need<HTMLButtonElement>('transfer-browse').disabled = running;
    },
    browse: async () => {
      // A real file input needs a user gesture, which the Browse button supplies. It resolves to
      // the NAME: a browser has no paths, and the name is also the better host-side default on a
      // system whose files are FILENAME FILETYPE FILEMODE rather than paths.
      fileInput.click();
      return new Promise<string | undefined>((resolve) => {
        fileInput.onchange = () => {
          const f = fileInput.files?.[0];
          if (f === undefined) { resolve(undefined); return; }
          void f.arrayBuffer().then((buf) => {
            pending = { name: f.name, bytes: new Uint8Array(buf) };
            resolve(f.name);
          });
        };
      });
    },
    submit: async (keywords) => {
      const direction = keywords.find((k) => k.toLowerCase().startsWith('direction='));
      if (direction?.toLowerCase().endsWith('receive') === true) {
        lastReceivedName = fileNameFrom(keywords) ?? lastReceivedName;
        send(JSON.stringify({ kind: 'transferStart', keywords }));
        return { ok: true };
      }
      if (pending === undefined) return { ok: false, error: 'choose a local file first' };
      return bridge.sendFile(pending.name, pending.bytes, keywords);
    },
    cancel: () => { bridge.cancel(); },
  });

  const overlay = createTransferOverlay({
    element: need('transfer-overlay'),
    build: () => { /* markup is static in index.html; nothing to build */ },
    hasUnsaved: () => bridge.hasUnsaved(),
    confirmDiscard: () => globalThis.confirm(
      'The transfer finished but the file has not been saved. Close and lose it?',
    ),
  });

  need('transfer-browse').onclick = () => { void ui.browseLocal(); };
  need('transfer-start').onclick = () => { void ui.start(); };
  need('transfer-cancel').onclick = () => { ui.requestCancel(); };
  need('transfer-close').onclick = () => { overlay.hide(); };
  saveButton.onclick = () => {
    void bridge.save(lastReceivedName).then(() => { saveButton.disabled = true; });
  };

  return {
    show: () => { overlay.show(); },
    onProgress: (t) => { ui.progress(t); },
    onDone: (r) => {
      ui.finished(r);
      // ENABLED ONLY NOW, AND THE PICKER IS NOT OPENED HERE: it needs transient user activation
      // and the click that started the transfer is spent, so the operator's click on THIS button
      // is what opens the dialog.
      saveButton.disabled = !bridge.hasUnsaved();
    },
    onData: (seq, total, bytes) => {
      const out = bridge.acceptData(seq, total, bytes);
      if (!out.ok) status.textContent = out.error ?? 'received data was out of sequence';
    },
  };
}

/** `HostFile=` without its keyword, for naming a download. */
function fileNameFrom(keywords: readonly string[]): string | undefined {
  const hf = keywords.find((k) => k.toLowerCase().startsWith('hostfile='));
  const value = hf?.slice(hf.indexOf('=') + 1).trim();
  if (value === undefined || value === '') return undefined;
  // CMS names are `FILENAME FILETYPE FILEMODE`; a dot reads better as a downloaded filename.
  return value.split(/\s+/).slice(0, 2).join('.').toLowerCase();
}

/** Draw the field rows. Pure DOM: which fields exist is `transferUi.ts`'s decision. */
function renderFields(
  doc: Document,
  host: HTMLElement,
  list: readonly UiField[],
  ui: { cycle: (id: never, d: number) => void; type: (id: never, t: string) => void },
): void {
  host.textContent = '';
  for (const f of list) {
    const label = doc.createElement('label');
    label.textContent = f.label;
    label.htmlFor = `transfer-${f.id}`;
    host.append(label);
    if (f.kind === 'cycle') {
      const button = doc.createElement('button');
      button.type = 'button';
      button.id = `transfer-${f.id}`;
      button.textContent = f.value;
      button.onclick = () => { ui.cycle(f.id as never, 1); };
      host.append(button);
    } else {
      const input = doc.createElement('input');
      input.type = 'text';
      input.id = `transfer-${f.id}`;
      input.value = f.value;
      input.oninput = () => { ui.type(f.id as never, input.value); };
      host.append(input);
    }
  }
}
```

`caretAfterEdit` is imported because the GUI's boot uses it for text fields; if the simple
`oninput` above proves to move the caret, apply it exactly as `gui/src/transferBoot.ts:81` does.

- [ ] **Step 5: Hook it into the bridge**

In `packages/web/src/bridge.ts`, where the keypad overlay is wired, add the transfer equivalent: intercept the `transferForm` action client-side to `show()` the overlay, and route the three new server messages to the returned handlers. Read the keypad's interception first so the shape matches:

```bash
grep -n "toggleKeypad\|keypadOverlay\|createKeypadUi" packages/web/src/bridge.ts
```

**The server's `toggleKeypad` intercept must stay** — the handoff records that deleting it ends the process on the first raw frame.

- [ ] **Step 6: Build and run the real browser harnesses**

Run:
```bash
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
```

Expected: all green, `1/1`, `9/9`. A black canvas means a module 404'd or a specifier is wrong.

- [ ] **Step 7: Commit**

```bash
git add -A packages/web
git commit -m "feat(web): wire the transfer overlay into the browser

Real elements in, createTransferUi out -- everything decidable stays in
transferUi.ts, as the GUI's own boot module does. Deep import specifiers
throughout: the bare @tn3270/canvas is mapped to keypadUi.js and the barrel
blanks the window.

browse() resolves to File.name, because a browser has no paths and the name
is the better host-side default anyway on a system whose files are
FILENAME FILETYPE FILEMODE.

THE SAVE BUTTON IS NOT A CONVENIENCE: showSaveFilePicker needs transient user
activation, so it cannot be opened from the completion callback -- the click
that started the transfer is spent by then. Feature detection is read once and
injected, so both save routes stay unit-testable.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 9: Real-browser cover for the form

`browser-clicks.mjs` found four defects the unit suite could not see, including the 15px canvas displacement. The overlay is exactly the kind of change that regresses there.

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs`

- [ ] **Step 1: Read the harness**

Run: `sed -n '1,70p' packages/web/scripts/browser-clicks.mjs`

Note how it launches, how it asserts actions in order, and how it reports counts.

- [ ] **Step 2: Add the transfer cases**

Extend the harness to, in order: open the overlay (the `Xfer` keypad button or the `transferForm` action), assert the overlay became visible, assert **the canvas did not move** (its bounding rect must be unchanged from before the overlay opened — this is the 15px-displacement regression), fill the host-file field, and assert the `Save…` button starts disabled.

Follow the file's existing assertion style. The canvas-position check is the important one and must be explicit:

```javascript
// THE DISPLACEMENT CHECK, and it is not theoretical: `ui.css` styling `body` once moved the
// canvas 15px and every keypad and selection click missed by that much, silently. The overlay
// is `position: fixed` precisely so this stays true.
const before = await canvasRect(page);
await openTransferOverlay(page);
const after = await canvasRect(page);
assert.deepEqual(after, before, 'the transfer overlay must not displace the canvas');
```

- [ ] **Step 3: Run it**

Run: `node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -5`
Expected: the previous 9 checks plus the new ones, all passing.

- [ ] **Step 4: Mutation-prove the displacement check**

Temporarily give `#transfer-overlay` `position: static` in the served `ui.css`, rebuild, and re-run the harness.

Expected: the displacement assertion **fails**. Restore `position: fixed`, rebuild, confirm it passes again. A check that cannot fail is not cover — and `select.mjs` is recorded as having been mutation-proved the same way.

- [ ] **Step 5: Commit**

```bash
git add packages/web/scripts/browser-clicks.mjs
git commit -m "test(web): real-browser cover for the transfer overlay

This harness found four defects the unit suite could not see, including
ui.css styling body and displacing the canvas by 15px -- which would have put
every keypad and selection click off target, silently. An overlay is exactly
the change that regresses that, so the canvas-position check is explicit.

Mutation-proved: with position: static on the overlay the displacement
assertion fails, which is what makes it cover rather than decoration.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 10: Correct the stale throughput comment

Small, independent, and worth doing while the measurement is fresh.

**Files:**
- Modify: `packages/frontend/src/transferRun.ts:97`

- [ ] **Step 1: Read the comment**

Run: `sed -n '93,99p' packages/frontend/src/transferRun.ts`

It says a file big enough to matter "would take hours over CUT". Measured figures (`docs/live-testing.md:413`: ~15 ms/frame, 1.727x expansion) put 10 MB at **~2.4 minutes** locally over CUT and ~10 seconds over DFT.

- [ ] **Step 2: Replace it**

```typescript
  // The local side. For a send this reads the whole file into memory, which is what the
  // state machine wants anyway: `CutTransfer` takes the bytes up front SO IT CAN ANSWER A
  // RETRANSMIT without re-reading. That, and not throughput, is the reason this is not
  // streamed.
  //
  // AN EARLIER VERSION OF THIS COMMENT SAID a file big enough to matter "would take hours over
  // CUT", which is false and predated any measurement. From live-testing.md:413 -- ~15 ms/frame
  // locally and a 1.727x codec expansion -- CUT moves ~72 KiB/s and DFT ~1065 KiB/s, so 10 MB is
  // ~2.4 minutes and ~10 seconds respectively. The rate is FRAME-LATENCY-BOUND, every frame
  // being a screen round trip, so a remote host at ~100 ms RTT is ~6x slower again.
```

- [ ] **Step 3: Verify and commit**

```bash
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
git add packages/frontend/src/transferRun.ts
git commit -m "docs: correct the 'would take hours over CUT' comment

It predated any measurement and was wrong by about two orders of magnitude.
From live-testing.md:413 -- ~15 ms/frame locally, 1.727x codec expansion --
CUT moves ~72 KiB/s and DFT ~1065 KiB/s, so 10 MB is ~2.4 min and ~10 s.

The real reason the send is not streamed is restated in its place:
CutTransfer holds the source up front to answer a RETRANSMIT.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 11: The live run, and the handoff

**Files:**
- Modify: `docs/live-testing.md`, `docs/HANDOFF.md`

- [ ] **Step 1: Check the host and the userid before anything else**

```bash
(timeout 5 bash -c 'cat < /dev/null > /dev/tcp/localhost/3270' && echo "VM/370 UP") 2>&1
pgrep -af "packages/tui/dist/main.js" | grep -v bash
```

A TUI session of the user's holding `CMSUSER` makes CP answer `DMKLOG054E ALREADY LOGGED ON GRAF 0C0`, and **the line may also still be DIALed into UTS** from other work — in which case `LOGON CMSUSER` is read as a UTS username and silently fails. `SysReq` drops a DIAL and returns the line to CP.

**Do not kill a session that is not yours.** If the userid is held, stop and ask.

- [ ] **Step 2: Start the gateway**

```bash
cd ~/git/tn3270
node packages/web/dist/main.js --port 8017 127.0.0.1:3270 -insecure -model 3278-2
```

Note the printed URL and token. `localhost` is a secure context even over plain http, so the save picker **will** be available in Chromium here — which means the fallback route needs the deliberate check from Task 9 rather than this run.

- [ ] **Step 3: Round-trip a small file through the browser**

Use a **small** file — the existing live evidence is a 249-byte binary and the plumbing is what is being proved:

```bash
head -c 249 /dev/urandom > /tmp/wx.bin
```

Send it to `WEBX DATA A` on CMS, then receive it back to a second local path, then compare:

```bash
cmp /tmp/wx.bin /tmp/wx-back.bin && echo "BYTE-IDENTICAL"
```

Confirm on the host with `LISTFILE WEBX DATA A`, and **erase it afterwards**. End with `LOGOFF`.

- [ ] **Step 4: Record the result in `docs/live-testing.md`**

Add an entry under *Executed so far* stating: the date, both directions, the byte count, that `cmp` was byte-identical, which host and engine (VM/370 CMS, CUT), that the save route exercised was the **picker** (localhost being a secure context) and therefore that the **download fallback remains unwitnessed live**, and that the 10 MB refusal was checked offline rather than live.

**State the gaps explicitly rather than implying them** — this file's convention is that an unqualified claim means it was witnessed.

- [ ] **Step 5: Rewrite the handoff's START HERE section**

Replace the *NEXT ACTION* block with the web transfer UI's outcome: the branch, the commit, the full gate numbers, `transferForm` leaving the `REFUSED` list, and **the next action being (0e) web copy and paste** — which needs the same `ServerMessage` widening this work introduced, and whose refusal in `protocol.ts` is load-bearing until it lands.

Carry forward, in the handoff's own idiom:
- The streaming-download groundwork is recorded in the spec and deliberately deferred.
- `transferUi.ts` now lives in `packages/canvas`; both front ends import it by deep path.
- The import map needs a specifier per shared module, because one specifier cannot name two files.
- The save fallback is not live-verified, and cannot be from a localhost gateway.

- [ ] **Step 6: Final full gate, then commit**

```bash
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2
node packages/gui/scripts/keys.mjs 2>&1 | tail -2
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2
node packages/gui/scripts/select.mjs 2>&1 | tail -2
node packages/gui/scripts/shot.mjs 2>&1 | tail -2
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -2
python3 packages/tui/pty-smoke.py 2>&1 | tail -2
```

`drive-playback.py` and `drive-e.py` are **not** required — nothing here touches telnet negotiation or the stream layer. Say so in the commit rather than leaving it implied.

```bash
git add -A docs
git commit -m "docs: the web transfer UI is live-verified, and the handoff moves to web copy

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review

**Spec coverage.** Decision 1 (10 MB, in-memory) → Tasks 2, 5, 7. Decision 2 (refused on purpose, operator told) → Task 2 Step 3, Task 5 Step 3, Task 7 Step 5. Decision 3 (overlay like the keypad) → Tasks 6, 8. Decision 4 (copy stays separate) → Task 3 Step 6 keeps it refused; Task 11 names it next. Decision 5 (file name default) → Task 8 Step 4 `browse()`. Decision 6 (save dialog + fallback) → Task 5 Steps 1/3, Task 8 Steps 2/4. Decision 7 (buffered first) → no streaming task exists, by design. Decision 8 (Chrome-only sink fine) → Task 5's injected `savePicker`. The 8 KB trap → Task 2. `TransferFiles` unchanged → Task 7 Step 5. `transferForm` leaves `REFUSED` → Task 3 Step 7. Testing section → Tasks 1 Step 11, 9, 11. Throughput correction → Task 10.

**Three invented helper names were found and fixed during this review**, which is worth recording because each would have cost an implementer real time:

- Task 3's test originally called `decodeServerMessageForTest`. **No such helper exists** — this suite's idiom is `JSON.parse(inflateSync(encodeServerMessage(msg)).toString())`, per its own `round-trips a frame message` case. Fixed, and a `transferData` base64 case added alongside.
- Task 4's test originally called `staticAssets()`. **The real entry point is `resolveAsset(path)`**, already imported at `httpstatic.test.ts:6`, answering one path at a time. Fixed, plus a `BROWSER_MODULES` assertion since that list is what makes a file served.
- Task 7's test originally invented `openTestClient`/`nextOfKind`/`closed`. **The real helpers are `start()` (`:52`) and `reader(ws)` (`:144`) with `next(what)`/`settle()`**, and the open-then-`hello` preamble. Fixed to use them, with a shared `connected()` local and a note about the reader's deliberate 2-second deadline.

`TransferRun` was also checked rather than assumed: it is `{ ok: boolean; error?: string; cancel?: () => void }` (`transferRun.ts:58-63`), so Task 7's `run.ok === false` and `run?.cancel?.()` are both correct as written.

**Remaining soft spot, stated plainly.** Task 8's `renderFields` uses `as never` on the field ids rather than re-deriving `TransferFieldId`'s union in this document; tighten it to the real type when writing the file. Task 8 Step 5 also describes the `bridge.ts` wiring in prose rather than code, because the keypad interception it must mirror has to be read first — that is the one step in this plan without complete code, and it is deliberate rather than an omission.

**Type consistency.** `CHUNK_BYTES`, `MAX_TRANSFER_BYTES`, `ChunkReassembler`, `chunkBytes`, `AcceptResult` are defined in Task 2 and used under those names in Tasks 5 and 7. `TransferBridgeDeps`, `SaveSink`, `createTransferBridge` are defined in Task 5 and used in Task 8. `TransferOverlayDeps`, `createTransferOverlay` are defined in Task 6 and used in Task 8. `transferChunk`/`transferStart`/`transferCancel`/`transferProgress`/`transferDone`/`transferData` are defined in Task 3 and used identically in Tasks 5, 7 and 8.
