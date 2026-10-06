# IND$FILE transfer UI for the web gateway — design

**Status: designed, not built. 2026-10-06.** Scope is the **web gateway only**. Roadmap item (0c).
The Electron GUI's transfer window already exists and is not modified; this spec gives the browser
the same capability over the WebSocket, which is what `packages/web/src/protocol.ts` currently
refuses.

Its predecessor is `2026-09-30-gui-transfer-ui-design.md`, whose *What this does not do* names this
work and its decision: **real browser file I/O**, so "local file" means the operator's machine
rather than the gateway's.

## The decisions the user made, 2026-10-06

Recorded first because the design follows from them and none is derivable from the code:

1. **Whole file in gateway memory is acceptable**, with a **10 MB cap**.
2. **A larger transfer is refused ON PURPOSE, and the operator must be told that** — not a
   mysterious failure, and (see *The 8 KB trap*) not a dropped connection.
3. **The form is an OVERLAY in the same pane, like the keypad** — not a second window.
4. **Web copy/paste is the NEXT step after this**, before packaging. It stays a separate spec.

## What makes this smaller than it looks

Three things already exist, and finding them changed the shape of this design:

- **`gui/src/transferUi.ts` imports ONLY `@tn3270/frontend`.** No Electron, no DOM — the DOM is
  injected through `UiDeps`, and its `browse()` and `submit()` are **already `Promise`-returning**.
  So the form's logic is portable as-is, and the asynchrony the browser needs is already in the
  interface. **It moves to `packages/canvas`** beside `keypadUi.ts`, which is where the other view
  shared by both front ends lives. The GUI keeps using it unchanged.
- **`keypadUi.ts:81` already prefixes its element ids** with the comment that they *"share a
  document with the transfer form's in the web overlay's case"*. The collision this spec would
  otherwise have introduced was pre-empted.
- **`keypadOverlay.ts` is the overlay precedent**, with its `position: fixed` and opaque-background
  rules documented as load-bearing: a sibling in normal flow would displace the canvas and break
  click arithmetic in *both* front ends through the shared renderer.

## The sync/async problem, and why `TransferFiles` does not change

`TransferFiles` (`frontend/src/transfer.ts:46`) is **synchronous** — `exists`, `read`, `write`,
`append` all return values. Browser file I/O is asynchronous. But no `TransferFiles` call happens
mid-transfer:

- **Send reads once, up front** (`transferRun.ts:102`), *before the host is told anything*. A read
  failure means nothing has reached the wire.
- **Receive writes once, at the end** (`transferRun.ts:335` for DFT, `:401` for CUT), with all
  bytes already in memory. Both engines are identical here, and `CutTransfer` deliberately takes
  the bytes up front **so it can answer a retransmit**.

So the bytes cross the socket **outside** `startTransfer`, and the gateway hands it a small
in-memory `TransferFiles` over a buffer it already holds. **`TransferFiles`, `startTransfer`,
`transferRun.ts`, both engines and `renderer.ts` are all untouched.**

Rejected: making `TransferFiles` async (ripples into the TUI, the GUI and the timer logic — the
code with the most live-host evidence behind it, to buy streaming nothing uses), and a chunked
streaming protocol (fights CUT's up-front retransmit buffer to solve a problem CUT's throughput
makes theoretical).

## THE 8 KB TRAP — the constraint that shapes the protocol

`wsserver.ts:19` sets `MAX_MESSAGE_BYTES = 8192`, and an oversize inbound frame **closes the
socket** (`:106`, `:114`) with no message. Its own comment gives the reason, which is not
arbitrary: one process serves up to **16 sessions** (`args.ts:132`), and a large synchronous
`type` would stall every other operator's session.

**A 10 MB upload therefore cannot be one message, and must not be raised to 10 MB globally** —
that would re-open the exhaustion the cap exists to refuse, for all 16 sessions at once.

So file bytes travel as **chunked base64 in a dedicated message kind**, each chunk comfortably
under the cap, reassembled by the gateway against a declared total. The cap stays 8192 for
everything else. Chunking here is a **transport** detail only — the engine still gets one complete
buffer, so this is not approach C.

## Architecture

```
packages/canvas
  src/transferUi.ts        MOVED from packages/gui, unchanged in behaviour
packages/web
  src/transferOverlay.ts   visibility + lifecycle, modelled on keypadOverlay.ts
  src/protocol.ts          new message kinds; `transferForm` stops being refused
  src/bridgecore.ts        intercepts transferForm client-side, owns the chunker
  src/main.ts              reassembly, the 10 MB gate, startTransfer, progress relay
  static/ui.css            overlay rules, reusing the keypad's fixed/opaque pattern
```

`bridgecore.ts` has a **recorded four-function limit** (*"if this file grows a fifth function, the
renderer has stopped being shared"*). That rule is about the **renderer's** bridge — `onAtlas`,
`onFrame`, `onError`, `sendAction`. The transfer plumbing must therefore NOT widen that interface;
it goes alongside as its own object, the same way the keypad overlay sits beside it rather than
inside it.

## Protocol

New `ClientMessage` kinds:

- `{kind:'transferChunk', seq, total, bytes}` — base64, `total` in bytes declared on `seq: 0`.
- `{kind:'transferStart', request}` — the validated keyword list, after the last chunk.
- `{kind:'transferCancel'}`

New `ServerMessage` kinds:

- `{kind:'transferProgress', text}` — relays `onProgress`.
- `{kind:'transferDone', ok, error?, bytes?}` — for a **receive**, carries the data as chunks of
  the same shape, then this terminator.

`ServerMessage` is currently `atlas | frame | error | session`; the handoff notes that web copy
will need a server→client text message too, so this is the second consumer of that widening and
the first to do it.

## Error handling

- **Over 10 MB:** refused in the **browser, before a single chunk is sent**, with an explicit
  message naming the limit and the file's size — decision 2. The gateway re-checks the declared
  total and refuses with the same wording, because a client is not to be trusted; neither path
  closes the socket.
- **Chunk sequence broken** (gap, duplicate, bytes exceeding the declared total): the gateway
  abandons the staged buffer and sends `transferDone {ok:false}`. Still no socket close — this is
  an operator-visible refusal, not a protocol violation.
- **Transfer fails mid-flight:** unchanged. `transferRun.ts` already distinguishes "transfer
  complete but could not write", which the browser must surface verbatim rather than flatten to
  "failed".
- **Socket drops mid-transfer:** the session's grace timer (`graceMs`, default 60 s) already keeps
  the 3270 session alive. Any staged upload buffer is **discarded on detach**, so a reattaching
  client cannot resume into a half-filled buffer.

## Testing

- **Unit:** `transferUi.test.ts` moves with its subject and must keep passing unchanged — that is
  the evidence the move was behaviour-preserving. New tests for the chunker (ordering, the cap,
  a broken sequence) and for reassembly, all DOM-free per `vitest.config.ts`'s `environment: 'node'`.
- **`integration.test.ts`:** `transferForm` **leaves the `REFUSED` list** (`:116`). `quit` and
  `copy` stay. The list shrinking is the assertion that this landed.
- **`browser-clicks.mjs`:** extended to open the overlay and drive the form in a real browser. The
  handoff records that this harness found four defects the unit suite could not see, including a
  15px canvas displacement — **the overlay work is exactly the kind of change that regresses there**,
  so this is not optional cover.
- **A real file round trip** through the browser against live VM/370 CMS, end to end, byte-identical
  — matching what `docs/live-testing.md` already records for the GUI. The 10 MB refusal is checked
  offline; a 10 MB CUT transfer would take hours and proves nothing the gate does not.

## What this does not do

- **No web copy/paste.** Decision 4: it is the next step. `copy` stays in `REFUSED`, and **that
  refusal is load-bearing** — the handoff records that without it the first browser copy ends the
  gateway process, because `applyAction` throws on the kind outside any try in a socket handler.
- **No streaming, no resume, no queue, no concurrent transfers.** One session, one transfer, as the
  GUI has it.
- **No raised global frame cap.** 8192 stays for every other message kind.
- **`MAX_MESSAGE_BYTES` is not made configurable.** A flag inviting an operator to raise it would
  re-open the exhaustion it prevents.

## Open questions

1. **Where does the overlay's Browse control get its file?** A real `<input type="file">` needs a
   user gesture, which an overlay button supplies — but the GUI's `UiDeps.browse()` returns a
   *path* and the browser has none. The likely answer is that the web's `browse()` resolves to the
   file's **name** for display while the bytes are stashed separately, leaving `UiDeps` intact.
   Worth confirming during planning rather than assuming.
2. **Does the receive direction need a save dialog, or is a plain download acceptable?** A download
   lands in the browser's download directory without asking. The File System Access API would
   prompt, but is not available in every browser this gateway might serve.
