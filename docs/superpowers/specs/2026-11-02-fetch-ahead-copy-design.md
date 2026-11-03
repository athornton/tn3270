# Fetch-ahead copy — design, 2026-11-02

Make web copy work **on every gesture, at every address**: `Ctrl-Shift-C`, `Cmd-C`, and the
browser's Edit > Copy, over `https`, `localhost` AND plain `http` at a LAN address. The user chose
this scope ("B") over menu-copy-only on 2026-11-02.

## The defect this closes

Copy today is asynchronous. The page sends `{kind:'copy', rect}`, the gateway extracts and answers
`copyText`, and only then does the bridge call `navigator.clipboard.writeText`. Two live passes,
2026-11-02, found where that fails:

- **Plain `http` at a LAN address**: not a secure context, so `navigator.clipboard` is
  `undefined`. Every gesture fails, and the canvas paints the `copy failed: use https ...`
  refusal (fix 1 of the same day).
- **Firefox Edit > Copy**, even on a secure page: the `copy` event fires and `forwardCopy` runs, but
  by the time the text returns, `writeText` is refused with `NotAllowedError: Clipboard write was
  blocked due to lack of user activation`. A keystroke grants activation; a browser menu does not.

Right-click offers only "Copy Image" because the screen is a canvas. That is out of scope: no
`copy` event is raised, and fixing it would mean a custom context menu.

## The mechanism, measured before it was designed

The browser's own copy path — `clipboardData.setData` inside a `copy` event, then
`preventDefault` — needs **neither a secure context nor the async Clipboard API**. It needs the
text to exist SYNCHRONOUSLY when the event fires.

MEASURED 2026-11-02, Electron 44.3.0's Chromium under Xvfb, a standalone probe page at
`http://192.168.70.115:<port>/` (`isSecureContext === false`, `navigator.clipboard` undefined), OS
clipboard read back from Electron's main process (`clipboard.readText()` returns a PROMISE in this
Electron; a first reader that did not await it printed `{}` for everything, including a known
sentinel, and was discarded):

| trigger | `copy` event | OS clipboard after |
|---|---|---|
| `Ctrl-Shift-C` keydown handler calls `document.execCommand('copy')`, listener `setData`s | fired, `isTrusted`, writable | **the set text** |
| `Meta-Shift-C`, same | fired, `isTrusted`, writable | **the set text** |
| `execCommand('copy')` with NO user gesture | not fired, returns `false` | unchanged |

**Firefox and Safari are UNMEASURED** — neither is installed here. They are the live pass.

So the text must be in the page BEFORE the gesture. The page asks for it when the drag ends.

## Where the round trip is

Browser ↔ gateway, over the page's existing WebSocket. The host is NOT involved: the gateway
extracts from its own screen snapshot. On a LAN that is milliseconds, and a LAN is exactly where
the non-secure case lives. Through a distant proxy it can be hundreds of milliseconds, but that
path is `https`, where the FALLBACK (today's async path) already works — the user verified it in
four browsers. A gesture that beats the round trip on plain `http` over a slow link paints the
refusal; that configuration already draws a startup warning for sending passwords in the clear.

## Components

### 1. `canvas/src/copyCache.ts` — new, DOM-free

Owns the prefetched text and nothing else. Pure state, so it is unit-tested under
`environment: 'node'` like `selection.ts`.

```ts
export interface CopyCache {
  /** A drag ended on `rect`. Returns the generation the answer must carry. */
  begin(rect: Rect): number;
  /** The answer for generation `gen`. Ignored unless `gen` is still current. */
  accept(gen: number, text: string): void;
  /** The selection is gone or the screen changed. Any pending answer becomes stale. */
  invalidate(): void;
  /** The text for `rect`, or `undefined` if it has not arrived or `rect` is not what was asked. */
  take(rect: Rect): string | undefined;
}
```

`take` does not consume: the selection survives a copy (the `webCopy` survival clause), so a
second copy must find the same text. It compares `rect` to the requested rect, so a cache filled
for one selection can never answer for another.

### 2. The bridge — one OPTIONAL function on `BridgeApi`

```ts
fetchSelection?(rect: Rect): Promise<string>;
```

`bridgecore.ts` implements it with an internal `seq`, sends
`{kind:'selection', seq, rect}`, and resolves on `{kind:'selectionText', seq, text}`. Answers
that come back out of order or after a close are dropped. `preload.cts` (Electron) does NOT
provide it, so the renderer never prefetches there — which matters because an uncaught THROW
inside an `ipcMain.on` listener FREEZES Electron's main process (measured 2026-10-26, `forwardPaste`'s
docstring). *(Corrected 2026-11-03: this sentence said "an unhandled `ipcMain` kind", which is not
what was measured.)*

**This widens `BridgeApi`, which `bridgecore.ts`'s header says must not move.** It is an OPTIONAL
member, so `preload.cts` and `renderer.ts`'s shared contract still compile unchanged, and the
renderer must test for it before use. The header is amended to say so in the same commit.

### 3. Protocol — two kinds, both top-level messages, not actions

- Client → server: `{kind:'selection', seq: integer, rect: {top,left,bottom,right} integers}`.
  `decodeClientMessage` validates every field (the two-branch rule is not sufficient; see
  `copy`'s rect check, which is reused). A top-level kind rather than an action, beside
  `transferChunk`, because it is not something the operator did to the session.
- Server → client: `{kind:'selectionText', seq, text}`.

`web/src/main.ts` handles `selection` ABOVE the `kind !== 'action'` guard (the transfer kinds'
placement rule): snapshot, `extractText(resolve(snapshot), cols, rect)` — the SAME extraction, so
hidden fields still become spaces — and reply. It does NOT repaint and changes no screen.

It logs `selection: sent N chars to the browser`, NOT a `copy:` line. A prefetch is not a copy, and
the operator may never copy. Under the new path a copy may never reach the gateway at all, so the
gateway can no longer witness copies; the line says exactly what it does know.

### 4. The renderer

- **On a real drag's end** (`mouseup` with `anchor`/`focus` set and `!isEmptyRect`): if
  `fetchSelection` exists, `gen = cache.begin(rect)`, then
  `fetchSelection(rect).then((t) => cache.accept(gen, t))`, with a `catch` (this repo's recorded
  `void`-on-a-rejecting-promise shape). `release()` also runs on window `blur` and on a click that
  never moved; neither prefetches.
- **`clearSelection()` and `mousedown` call `cache.invalidate()`.** `onFrame` already calls
  `clearSelection()`, so a new screen invalidates.
- **`forwardCopy`'s listener**: if `cache.take(rect)` has text, `e.clipboardData.setData(
  'text/plain', text)` and `e.preventDefault()` — correct now, because real data was set (the
  no-`preventDefault` rule of 2026-11-02 was about an EMPTY `clipboardData`, and its unit test is
  rewritten to pin the new rule: prevent if and only if data was set). Otherwise fall back to
  `copySelection()`, today's async path.
- **The `requestCopy` keydown arm (`Ctrl-Shift-C`)**: if `cache.take(rect)` has text, call
  `document.execCommand('copy')`, which raises the `copy` event above inside the keystroke's
  activation. If the cache is empty, or `execCommand` returns `false`, or the listener did not
  consume the event, fall back to `copySelection()`. The listener records consumption in a flag
  the arm reads, so a browser that silently ignores `execCommand` still copies by the old route.
- **`Ctrl-C` stays Clear**, unchanged: claimed and `preventDefault`ed in keydown, so no `copy`
  event is raised.

## Ordering: why a stale answer cannot land

One socket, in order. If the screen changes after the request, the gateway sends the new `frame`
BEFORE the `selectionText` it extracted from that newer screen. The browser processes the frame
first, `clearSelection()` → `invalidate()` bumps the generation, and the late answer is discarded
by `accept`. If the screen changed BEFORE the request was processed, same order, same outcome.
The generation, not timing, is what guarantees it, and a unit test drives that interleaving.

CHECKED against `web/src/main.ts`, not assumed: `send` is registered directly on the session's
`screen`, `connect` and `disconnect` events and writes the frame synchronously, with no debounce,
and every action ends in an unconditional `repaint`. Node runs one handler at a time, so no screen
change can slip between the extraction and its reply. If frames are ever debounced or batched,
this argument has to be re-made.

The BROWSER half needs the same order, and before 2026-11-02 it was not guaranteed: `bridgecore.ts`
started an independent async chain per inbound message, so messages were handled in the order their
`inflate` finished, not the order they arrived. Measured with the bridge's own `inflate`: Electron
44's Chromium never let a small message overtake a large one (0/200 at 6 KB and at 120 KB), but
Node's `DecompressionStream` did (183/200 and 200/200), and Firefox and Safari are unmeasured. The
bridge now chains every message onto the one before it, so it handles them STRICTLY IN ARRIVAL
ORDER, and a `frame` is always handled before the `selectionText` sent after it.

## Error handling

- `fetchSelection` rejects or never answers: the cache stays empty and every gesture falls back.
  Nothing is painted for a failed PREFETCH; the fallback's own reporting (fix 1) still applies.
- A malformed `selection` frame: `decodeClientMessage` throws, the existing per-client `error`
  frame answers, and the socket stays open.
- `execCommand` missing, throwing, or `false`: fallback.

## Testing

- **`copyCache.test.ts`**: begin/accept/take; take with a different rect; invalidate before the
  answer (the stale-answer interleaving above); take does not consume.
- **`protocol.test.ts`**: `selection` decode, each malformed field refused.
- **`bridgecore.test.ts`**: `fetchSelection` sends the frame and resolves on the matching `seq`;
  an out-of-order or post-close answer is dropped; no unhandled rejection.
- **`integration.test.ts`**: the gateway answers `selection` with the expected text, sends NO
  frame, and the session survives a malformed one.
- **`forwardKeys.test.ts`**: the copy listener sets data and prevents only when the cache has text,
  and falls back otherwise.
- **`browser-clicks.mjs`**: `webCopy`'s gateway witness changes from `copy: N chars` to the
  `selection:` line plus the REAL clipboard, which stays the proof. `chordCopy`'s `copied` test —
  "the page sent a `{kind:'copy'}` frame" — becomes FALSE on the new path, because a cached copy
  sends nothing. It is replaced by "a `copy` event was consumed with data", read from the page,
  and the fallback path gets its own case: a gesture made with the cache deliberately empty must
  still send the old `copy` frame and land the text. `webNativeCopy` likewise. A
  new **`webLanCopy`** check loads the gateway at the box's non-loopback address
  (`isSecureContext === false` asserted, so it cannot silently run secure), drags, presses
  `Ctrl-Shift-C`, and reads the OS clipboard back from main. It reports SKIPPED, not passed, when
  the machine has no non-loopback IPv4 address.
- Each new check mutation-proved: drop the prefetch; drop `invalidate` in `clearSelection`; drop
  the `preventDefault`.
- **Live pass, owed by the user**: Firefox and Safari at a plain-`http` LAN address and over
  `localhost`, every gesture including Edit > Copy.

## Out of scope

- Right-click copy (needs a custom context menu).
- The Electron GUI, which copies through its own menu and `clipboard.writeText` in main.
- Removing the async fallback. It is what makes a gesture faster than the round trip still work
  on a secure page, and it is the path four browsers have already verified.

## Amendments, 2026-11-03

- **Inbound messages are handled in arrival order.** `bridgecore.ts` chains every message onto the
  one before it, which the stale-answer argument above needs; recorded under *Ordering*.
- **A failed copy is a notice, not a screen failure.** The fallback's `report` went to
  `dispatch('error')`, and `renderer.ts`'s `onError` clears the selection and its cache, so a copy
  pressed before the prefetch answered (refused on a plain-`http` LAN page, or with
  `NotAllowedError`) could not be retried: the second press found nothing selected. The report now
  goes to a new OPTIONAL `BridgeApi.onCopyFailed`, falling back to `dispatch('error')` where none is
  registered. The renderer paints it as `onError` does but keeps the selection and its cached text;
  a cached copy that then succeeds repaints the screen over the notice, a press on the canvas
  dismisses it and starts a drag, and the prefetch is not refused while it is up. Real errors are
  unchanged. Electron's preload does not implement it and need not. Witnessed by
  `browser-clicks.mjs`'s `webCopyRetry`.
