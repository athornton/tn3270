# Transfer protocol selection — design

**Date:** 2026-09-25
**Status:** designed, not started. Blocks Task 10 of `2026-09-24-dft-file-transfer.md`.
**Predecessor:** `docs/superpowers/specs/2026-09-24-dft-file-transfer-design.md`, whose engine,
structured-field plumbing and Read Modified hook are built and verified (plan Tasks 1–9).

## Why this exists

**The DFT engine works and nothing can reach it.** `Session.startDftTransfer` has no caller outside
tests, and `cli/runner.ts` constructs a `CutTransfer` unconditionally, refusing any screen that is
not 24x80 (`runner.ts:454`) before a byte reaches the host. A live run against MVS/TSO at 43x80 on
2026-09-25 therefore produced **zero** `FileTransferData` frames — it never got to the wire.

This is a gap in the DFT plan, not a defect in its code: Tasks 1–9 built the engine and the inbound
path, and no task wired the `Transfer()` action to choose between protocols. **It survived nine
tasks because every engine test calls `startDftTransfer` itself** — the tests supply the call the
product is missing. That is the "plumbing built, switch never thrown" shape, and it is worth naming
because a green suite over an unreachable feature is exactly what it looks like from the inside.

Tasks 10 (live run), 11 (the spec's open `Recfm`/`Lrecl` question) and 12 (merge) all consume Task
10's trace, so the whole tail is blocked behind this.

## The governing fact, from the reference implementation

**The client does not choose the protocol. The host does.** `ft_running(true/false)` merely *reports*
which protocol arrived — `ft_cut.c:440` passes `true`, `ft_dft.c:175` passes `false`, and the flag is
read exactly once, at `ft.c:556`, to print "CUT" or "DFT" in the completion message. x3270 has no
protocol-selection logic at all.

So this design **deletes a guess rather than adding one.** Every alternative considered required the
client to predict something it cannot know: geometry does not imply protocol (VM stays on CUT at
43x80 — measured 2026-09-25), and advertising DDM does not imply the host uses it (VM declines `0x95`
and stays on CUT even with `-ddm on` — also measured, both directions, 249 bytes byte-identical).

## Architecture

A **shared decider in `core`**; the two existing drivers keep their own control flow.

`Transfer()` becomes protocol-agnostic. It builds *both* engines over one source buffer, registers
the DFT one, types `IND$FILE`, and waits for **either** transport to declare itself. The first frame
to arrive decides; the loser is discarded.

Three things move:

1. **The geometry gate moves from "before the host is involved" to "once we know it is CUT."**
2. **`Session` gains a way to release a registered transfer**, and clears one on close.
3. **The CLI loop gains a second wake signal.** It currently wakes only on the `screen` event; a DFT
   transfer writes no screen at all, so a *healthy* DFT run would spin to its timeout.

### Why a decider and not a unifying facade

The two transports do not share a stepping shape. CUT is screen-in / AID-out and is stepped by the
driver; **DFT is payload-in / bytes-out and is already fully driven inside
`Session.handleTransferData`** — the driver does not step it, it waits for it. A facade over both
would be a type with two disjoint halves. The one genuinely shared thing is the *decision*, and the
geometry rule that follows from it.

### Dependency graph, read from the `package.json` files 2026-09-25

```
core ← frontend ← { cli, tui, canvas, gui, web }
                    canvas ← { gui, web }
```

**This corrects a graph recorded earlier as `core ← frontend ← { cli, tui }` and
`core ← canvas ← { gui, web }`.** The omission mattered: it hid the fact that **`gui` and `web`
already declare `@tn3270/frontend`**, so anything placed there is reachable by every front end.

## Components

### 1. `core/src/ft/detect.ts` — new, pure

```ts
export function looksLikeCutFrame(screen: Screen): boolean;
```

Its whole reason for existing is the **non-throwing** contract. `isCutFrame` calls
`requireCutGeometry`, which **throws `CutFrameError`** on anything but 24x80 — so at 43x80 it cannot
answer "is this CUT?", it can only fail. `looksLikeCutFrame` returns `false` for the wrong geometry,
so a driver may ask at any size.

**`isCutFrame` is unchanged and keeps throwing.** That is deliberate: once CUT has won, the geometry
demand is real, and the throw is how existing code refuses to compute frame offsets it cannot. New
function for *deciding*, old one for *stepping*.

### 2. `Session` — two small additions

```ts
cancelDftTransfer(): void;   // release a registered transfer that lost
```

plus **clearing `this.dft` in `handleClose`**. The second is a latent bug in the Task 7 work,
independent of this design: `handleClose` clears `conn`, `telnet` and `e` but not `dft`. **This
project has fixed that exact shape twice** — `Session.e` once cleared only on the REJECT path, and
`IAC DONT TN3270E` once cleared the option but not `tn3270eNegotiated`. One teardown path clears the
state and another does not.

### 3. `tui/src/transferRun.ts` → `frontend/src/transferRun.ts` — a move, done FIRST

Verified cheap before proposing it: the file imports only `@tn3270/core` and `@tn3270/frontend`,
takes `TransferFiles` as a **type** (the interface already lives in `frontend/src/transfer.ts`), and
the concrete `node-files` implementation is injected by each front end. **The move carries no new
dependency.**

The justification is in the file's own header: it exists because *"a TUI cannot block"* — equally
true of a GUI and a web gateway. It is **the non-blocking driver**, sitting in `packages/tui` for
historical reasons.

**This is what keeps the DFT arm from being written four times.** There are two genuine control
flows, not four:

| flow | who needs it | home |
|---|---|---|
| blocking, poll-until-done | CLI only — the s3270 line protocol cannot report a completion arriving after its `ok` | `cli/runner.ts` |
| event-driven, non-blocking | TUI, GUI, web | `frontend/transferRun.ts` |

**The move is independently valuable**: it is the right home for that file whether or not the rest of
this design proceeds.

**Not collapsed to one driver.** Merging the CLI's blocking loop into the event-driven one changes
the line protocol's behaviour, which `transferRun.ts`'s header documents as the reason they diverge.
That is a behaviour change, not plumbing, and is out of scope here.

### 4 and 5. The DFT arm, in each driver

- `cli/runner.ts` — blocking. Must wake on **`transferEnd` as well as `screen`**.
- `frontend/transferRun.ts` — event-driven. Same changes in its idiom; it already has listener
  teardown to follow.

**Untouched:** `CutTransfer`, `DftTransfer`, `dftFrames.ts`, `frames.ts`, `transferForm.ts`.

## Data flow

### Starting (both drivers, same order)

1. Validate keywords — unchanged.
2. Check 3270 mode and keyboard lock — unchanged.
3. Read the local file / check the destination — unchanged.
4. **Geometry is NOT checked here.** The one deletion.
5. Build `CutTransfer` **and** `DftTransfer` over the same source buffer.
6. `session.startDftTransfer(dft)` — **before** the host is told anything, so a fast host cannot
   lose its first frame to a race. `handleTransferData` needs a registered transfer at the moment
   the first `0xd0` arrives, and that arrives from inside the record handler, before any driver code
   runs again.
7. `primeAndType(command)`, `sendAID(ENTER)`. The host is now involved.
8. Wait, uncommitted.

Steps 1–3 keep their existing relative order, which `transferRun.ts` documents as load-bearing:
geometry came *before* 3270 mode because on a model-4 session both are wrong and which message the
operator sees decides what they do. Removing the geometry check does not disturb the rest.

**Both engines need their source bytes up front** — CUT to answer a retransmit, DFT to answer a
`GET` — so building both costs one extra object over the same `Uint8Array`, not a second copy.

### Deciding

| signal | meaning | action |
|---|---|---|
| `screen` event **and** `looksLikeCutFrame` | host chose CUT | `cancelDftTransfer()`, step CUT as today |
| `session.dftTransfer` advanced, or `transferEnd` | host chose DFT | discard the `CutTransfer`; `Session` is already driving |
| `screen` event, not a CUT frame | host is painting something else | keep waiting, **record it** for the timeout message |

**No interleaving.** A host does not switch protocols mid-transfer and neither driver will support
it: a CUT frame arriving after DFT won is ignored as ordinary screen traffic.

**AMBIGUITY RESOLVED EXPLICITLY, because "wake on `transferEnd`" alone is not sufficient:** a whole
DFT transfer can begin *and finish* inside record handling, before the driver's wait is entered — the
frames arrive from `onRecord`, and nothing yields to the driver in between. An event listener
registered after that has already missed it.

So the rule is **check state first, then wait on the event**: before sleeping, a driver must test
whether `session.dftTransfer` is already `undefined` *and* its retained reference has a `result`. A
driver that only subscribes will hang on a fast host, and hang in a way that looks exactly like the
spin-to-timeout bug it was written to avoid. The DFT integration test must therefore cover a transfer
that completes before the first wait, not only one that completes during it.

### Ending

CUT ends on `step.done`, as today. DFT ends when `Session` clears `this.dft` and fires
`transferEnd`; the driver reads `result` from the reference it kept. **Both converge on the same
"write the file / report N bytes" tail**, so `Exist=replace|append` and the completion message stay
in one place.

### The accepted regression: CUT at 43x80

Today `Transfer()` refuses instantly, before the host is involved. Under this design the host is
primed first, `looksLikeCutFrame` stays `false`, and we wait out the timeout — whose message then
names the real cause rather than a generic failure.

**This trade was raised and accepted explicitly.** It is slower and it does prime the host, but the
diagnosis improves and the existing Attn/Clear recovery hint still applies.

**OPEN QUESTION, to be MEASURED rather than guessed (one run):** does a CUT host at 43x80 paint a
recognisable frame at the wrong offsets, or nothing at all? If it paints something, the driver can
fail fast — "a screen arrived, it is not a CUT frame, and we are not 24x80" — instead of waiting the
full timeout. Measurable on VM/370, which is confirmed at 43 rows as of 2026-09-25. **The plan must
measure this; the fast-fail is conditional on the answer.**

## Error handling

**The governing rule, existing and retained:** everything checkable locally is checked before the
host is told anything. This design removes exactly one check from that set and accepts the cost. A
local error *after* priming leaves the host in transfer mode awaiting a client that gave up, which
the operator must then break out of by hand.

**Local failures (before priming):** unchanged — bad keywords, not in 3270 mode, keyboard locked,
unreadable source, destination exists without `Exist=replace`.

**Timeout while uncommitted.** One timeout, existing duration, **no new tunable** — a second
"decide" window was rejected because it would invent a duration with no measurement behind it, and
this project has removed unmeasured sleeps before. The message reports what was observed:

| observed | message |
|---|---|
| nothing at all | *no transfer frame from the host within Ns* + existing Attn/Clear hint |
| screens, none a CUT frame, screen not 24x80 | *the host chose CUT, which needs a 24x80 screen; this session is RxC — restart with `-model 3278-2-E`* |
| screens, none a CUT frame, screen IS 24x80 | today's *no CUT frame …*, unchanged |
| nothing, and DDM not advertised | append *DDM was not advertised; a host that speaks only DFT needs `-ddm on`* |

The last row earns its place: forgetting `-ddm on` will be the commonest failure once DFT works.

**Mid-transfer failures:** unchanged for both engines, and neither is touched.

**A malformed DFT frame is a transfer fault, never a session fault** — already built and tested:
`handleTransferData` catches, traces, clears, fires `transferEnd`. Without that catch it would
escape into `handleRecord`, which rethrows non-protocol errors as our own bug and drops the
connection — a remotely-triggerable disconnect.

**The registered loser:** `cancelDftTransfer()` on CUT commitment, and `handleClose` clearing `dft`
so a dropped connection cannot strand one.

**Cancellation.** CUT sends its abort immediately; DFT defers to the next inbound frame, matching
x3270 — a deliberate divergence documented in `dft.ts`. While **uncommitted**, a cancel has no
engine to talk to: abandon the wait and report cancelled. **No synthesised abort**, for the reason
`transferRun.ts` already gives — an abort writes the response area and presses PF2 from a frame
`CutTransfer` has parsed, so fabricating one puts bytes on the wire that no captured session
contains.

## Testing

**The real safety net is what must keep passing untouched:** the whole CUT suite,
`conformance.test.ts` and `golden.test.ts` (12 tests), `drive-playback.py` (10/10), and the DFT
engine tests from Tasks 4–9. **If the CUT path changes behaviour at 24x80, this design is wrong.**

**`detect.ts`:** `looksLikeCutFrame` returns `false` at 43x80 where `isCutFrame` throws; the two
agree at 24x80 on both a real frame and a non-frame. Mutation: make it throw, and the 43x80 decision
tests must redden — that is the entire reason it exists.

**`Session`:** `cancelDftTransfer()` clears `dftTransfer`; `handleClose` clears it too, **and that
test must fail without the fix** or it is testing nothing.

**The move:** hash-verify `transferRun.ts` byte-identical apart from its import line, as the
`canvas` extraction was. Assert the graph — `frontend`'s tests must not import `cli` or `tui`. Run
`npm run build` **before** `vitest`, since packages resolve to their built `dist/`.

**Integration, per driver, over `FakeConnection`:**

- CUT host wins at 24x80 → DFT cancelled, CUT proceeds, bytes land.
- DFT host wins → the `CutTransfer` is discarded and **the driver notices completion with ZERO
  `screen` events.** Assert the count is zero, not merely that it succeeded — this is the test that
  catches the spin-to-timeout bug.
- CUT host at 43x80 → the timeout message names the geometry, and `isConnected()` is still true.
- No frames, DDM off → the message mentions `-ddm on`.
- Cancel while uncommitted → reports cancelled and **nothing goes on the wire.**

**Two mutation checks are required**, because both defects would otherwise pass a green suite —
**four mutations passed vacuously on the DFT branch**, each reading as "this line is dead" when it
was load-bearing:

1. Remove the `transferEnd` wake signal → the DFT integration test must redden.
2. Remove `cancelDftTransfer()` on CUT commitment → something must fail. **If nothing does, the call
   is decoration and should be deleted rather than kept.**

**Live gate:** the DFT run on TK5 at 43x80 (Task 10), plus VM re-run as the CUT control to prove no
regression. **Judge both by TRACE** — `FileTransferData(0x0012,38B)` is the line to grep — because
after this both protocols end in a transferred file and only the trace distinguishes them. That
trace line exists because adding the `transferData` variant broke an exhaustive switch in
`parse.ts`, which is what forced DFT frames to be named rather than logged as `unknownSF(0xd0,38B)`.

## Out of scope

- **Collapsing the two drivers into one.** A line-protocol behaviour change, not plumbing.
- **A transfer UI for the GUI or web.** They have no driver yet; the move makes one available, and
  giving them the UI is separate work.
- **`Transfer()`'s `BufferSize` keyword and `SessionOptions.dftBufferSize`.** Both parsed and set by
  nothing today. They are one line each and **they must agree**, since the size advertised in the
  DDM Query Reply and the size DFT chunks by are one number — but they are the DFT plan's Task 11
  territory, not selection.
- **Interleaved or switching protocols within one transfer.**
