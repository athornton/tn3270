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
5. **The local file's NAME is the default** shown in the form — the browser has no paths to offer.
6. **A SAVE DIALOG for a receive, where the browser has one**, with a plain download as the
   fallback. See *The save dialog and where it is not available*.

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
streaming engine. The case against streaming is **not** that CUT is too slow for large files — see
*Throughput*, where that turns out to be false — but that `CutTransfer` is **built around holding
the source up front so it can answer a retransmit**. Streaming would have to buffer anyway or
rework retransmit, for a 10 MB ceiling that fits in memory by decision 1.

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
- **BOTH SAVE ROUTES, and the fallback is the one at risk.** The picker route is what a developer on
  Chrome-over-localhost exercises by default, so the `Blob` download is the path that can rot
  unnoticed. Feature detection is injected (a dependency, not a bare `'showSaveFilePicker' in
  window` read at the call site) so a unit test can drive **both** branches, and
  `browser-clicks.mjs` asserts the fallback explicitly rather than whichever route the harness
  browser happens to take.
- **A real file round trip** through the browser against live VM/370 CMS, end to end, byte-identical
  — matching what `docs/live-testing.md` already records for the GUI. Use a **small** file: the
  existing live evidence is a 249-byte binary, and the round trip proves the plumbing regardless of
  size. **The 10 MB gate is checked offline**, because it is arithmetic on a declared total and a
  real 10 MB transfer would exercise only patience (see *Throughput*).

## What this does not do

- **No web copy/paste.** Decision 4: it is the next step. `copy` stays in `REFUSED`, and **that
  refusal is load-bearing** — the handoff records that without it the first browser copy ends the
  gateway process, because `applyAction` throws on the kind outside any try in a socket handler.
- **No streaming, no resume, no queue, no concurrent transfers.** One session, one transfer, as the
  GUI has it.
- **No raised global frame cap.** 8192 stays for every other message kind.
- **`MAX_MESSAGE_BYTES` is not made configurable.** A flag inviting an operator to raise it would
  re-open the exhaustion it prevents.

## Throughput — what 10 MB actually costs

**The only measured figures this project has** (`docs/live-testing.md:413`, from the 2026-09-24
mid-flight cancellation run): **CUT runs at ~15 ms/frame locally** and **its codec expands random
data 1.727x**. Everything below is derived from those two numbers plus the frame capacities, and is
stated as derived rather than measured.

A CUT upload frame holds `O_UP_MAX` = **1912 encoded** bytes (`frames.ts:239`, `O_SF - O_UP_DATA`
= 1919 − 7), so ~1107 source bytes per frame after the 1.727x expansion. A DFT frame carries
`dftBufferSize − 27`, default **16384** (`queryreply.ts:447`), so ~16357.

| Engine | per frame | at 15 ms/frame (local) | 10 MB |
|---|---|---|---|
| CUT | ~1107 source bytes | ~72 KiB/s | **~2.4 min** |
| DFT | ~16357 bytes | ~1065 KiB/s | **~10 s** |

**THE "HOURS" CLAIM IN AN EARLIER DRAFT OF THIS SPEC WAS WRONG, and so is the one in
`transferRun.ts:97`** — "a file big enough to matter would take hours over CUT". At the measured
local frame rate, 10 MB over CUT is minutes. That comment predates any throughput measurement and
should be corrected when something next touches that file; it is not load-bearing for any decision,
but it is quotable and wrong.

**THE RATE IS FRAME-LATENCY-BOUND, NOT BANDWIDTH-BOUND**, which is why the 15 ms matters more than
any byte count: each frame is a screen round trip. The 15 ms is **Hercules on this machine** — a
genuinely remote host at ~100 ms RTT would give roughly **11 KiB/s on CUT (10 MB ≈ 16 min)** and
**160 KiB/s on DFT (≈ 1 min)**. So the honest statement is: **10 MB is tolerable on DFT, tedious on
CUT, and the cap is about gateway memory rather than time.**

That is also the real justification for decision 1 — 16 sessions × 10 MB staged in one process is
160 MB of worst-case resident buffer, and *that* is what the cap bounds.

## The Browse control, and why the file NAME is the right default

A real `<input type="file">` needs a user gesture, which an overlay button supplies. But
`UiDeps.browse()` returns a **path**, and the browser has none: `File.name` is the bare filename
and the full path is withheld on purpose. So the web's `browse()` resolves to **`File.name`** for
display while the bytes are stashed beside it, and **`UiDeps` is unchanged** — the GUI keeps
returning a path, the web returns a name, and `transferUi.ts` neither knows nor cares because it
only ever shows the string and submits it.

**The name is also what the HOST side wants defaulted.** An operator uploading `BRACE.C` almost
always wants a host file named after it, and a path prefix would be noise on a system with no
directories (CMS has `FILENAME FILETYPE FILEMODE`, not paths). The host field stays **typed and
editable** either way — the GUI spec's decision 2, unchanged here, because only the host knows its
own dataset naming.

## The save dialog, and where it is not available

**Decision 6 is a save dialog where one exists, and a download where one does not.** Both paths
ship; the dialog is not a later enhancement.

`showSaveFilePicker()` is the only web API that genuinely prompts for a location. **MEASURED from
caniuse's File System Access data and MDN, 2026-10-06:**

| Browser | `showSaveFilePicker` |
|---|---|
| Chrome 105+, Edge 105+, Opera 91+ (desktop) | **yes** |
| **Firefox** (all versions) | **no** |
| **Safari**, desktop and iOS (all versions) | **no** |
| **Chrome for Android**, Firefox for Android, Samsung Internet | **no** |

So roughly **30% of global usage**, and — the part that matters for this project — **no Safari and
no Firefox, and nothing on mobile at all**. A Mac operator in Safari is squarely in the unsupported
set, and this project exists because its author wanted a Mac 3270 client.

**TWO FURTHER CONDITIONS, either of which disables it even on Chrome:**

1. **It requires a SECURE CONTEXT.** TLS is **optional**: `main.ts:83` builds a plain
   `node:http` server unless `--tls-cert`/`--tls-key` are given, and `main.ts:275` prints an
   `http://` URL in that case. **`localhost` counts as a secure context even over plain HTTP**, and
   the gateway binds loopback by default (`main.ts:24`), so the common local run keeps the dialog.
   It is the *other* supported configuration — a LAN gateway on `http://<host>:<port>` reached from
   another machine — where the dialog disappears **on every browser, Chrome included**. That is
   also the configuration where the operator's machine is genuinely not the gateway's, i.e. the
   whole reason this feature exists.
2. **It requires transient user activation.** The save must be initiated from the operator's click,
   which means **the picker cannot be opened when the transfer completes** — by then the click that
   started it is spent. So a receive ends with an enabled **Save** button in the overlay, and the
   operator's click on *that* opens the dialog.

**The fallback is a plain `Blob` download** — an anchor with `download=<filename>`, which works
everywhere and lands the file in the browser's download directory without asking. Feature detection
is a single `'showSaveFilePicker' in window` test, and the overlay says which route it will take so
the operator is never surprised about where the file went.

**Where the bytes wait meanwhile:** a completed receive is held in the browser as a `Blob` until the
operator saves it, and that is the one place a 10 MB file sits in browser memory. Dismissing the
overlay with unsaved bytes must warn rather than silently discard — the same shape of rule as the
GUI's "the window refuses to close while a transfer runs".

## Open questions

None outstanding. The two from the first draft are resolved above as decisions 5 and 6.
