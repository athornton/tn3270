# DFT file transfer (transfer stage 2) — design

**Date:** 2026-09-24
**Status:** design, approved in brainstorming. **Task 1 (the DDM advertisement and the live probe) is
BUILT AND RUN — `9f92816`.** The state machine, the inbound plumbing and the Read Modified hook are
not started.
**Scope of THIS spec:** DFT as a second transfer protocol in `core`, advertised behind a new `-ddm`
flag defaulting **off**, reachable from the transfer form and the `Transfer` command that already
exist. **Not in scope:** flipping the default to DFT (a later, cheap commit once measured), the GUI
form (stage 3), the web gateway (stage 4).

Predecessor: `docs/superpowers/specs/2026-09-22-interactive-file-transfer-design.md`, stage 1, which
is complete, merged and live-verified on both hosts in both directions.

## Why this stage exists

CUT transfer works only on a 24x80 screen. `frames.ts` throws `CutFrameError` on any other geometry
(`requireCutGeometry`), because the CUT frame layout is a set of fixed offsets into a 1920-cell
buffer and offset 1919 — `O_SF` — is the frame-detection test. The user's own working setting is
`-model 3278-4-E`, which is 43x80, so **on their usual setup a CUT transfer is refused**, and the
refusal can only be fixed by restarting the client (`-model` is parsed once at launch; runtime
model-switching is roadmap item 10, unbuilt).

DFT removes the constraint at its root. Measured 2026-09-22 and re-confirmed 2026-09-24:
`ft_dft.c` has **zero** screen-buffer references (`grep -c "ea_buf\|ctlr_add\|ROWS\|COLS"` = 0,
against **25** in `ft_cut.c`) and no mention of 1920, 24x80, or geometry anywhere. It moves data
through structured fields, not the display buffer. 749 lines against `ft_cut.c`'s 762.

## THE FINDING THAT RESHAPED THIS SPEC: DFT IS GATED ON A QUERY REPLY WE DO NOT SEND

Measured 2026-09-24 from x3270 4.5 and the IBM manual.

**The client does not choose CUT or DFT. The host does.** `ft_cut.c:440` calls `ft_running(true)`
and `ft_dft.c:175` calls `ft_running(false)`; that boolean **reports** which protocol arrived, it
does not select one. `fts.is_cut` is read in exactly one place, `ft.c:556`, to print "CUT" or "DFT"
in the completion message.

A host offers DFT only if the client advertised **Query Reply (Distributed Data Management), QCODE
`0x95`**. x3270 sends it unconditionally from `sf.c:890 do_qr_ddm`, registered in its reply table at
`sf.c:90`. The manual states the direction of causality at `pages.txt:9806-9810`: the reply
"indicates the Distributed Data Management (DDM) subsets supported" and "is transmitted inbound in
reply to a Read Partition structured field specifying Query or Query List".

**We do not send it.** `DEFAULT_CAPABILITIES` is `[summary, usableArea, color, highlighting,
implicitPartition]` (`queryreply.ts:449`), and `0x95` appears nowhere in `packages/core` outside two
unrelated CUT codec tables.

### THE PREDICTION WAS RUN AND CONFIRMED, 2026-09-24: MVS/TSO OFFERS DFT

The probe below was executed the same day this spec was written, commit `9f92816`. **The recorded
claim that "both Hercules hosts speak CUT" was a property of OUR ADVERTISEMENT, not of the hosts.**

Same script, same client build, same session shape; one byte of advertisement the only variable:

| Host | `-ddm off` | `-ddm on` |
|---|---|---|
| **MVS 3.8j TK5** | 0 × `0xd0`, 249 bytes round-tripped over CUT | **4 × `0xd0`**, both transfers time out at 0 bytes |
| **VM/370 MECAFF** | 249 bytes round-tripped over CUT | 249 bytes round-tripped over CUT, **0 × `0xd0`** |

TK5 answered `WriteStructuredField unknownSF(0x40,3B) unknownSF(0xd0,38B)` and again at 32B. Both
frames decode as **`TR_OPEN_REQ` (`0x0012`)**, and their lengths **`0x29` and `0x23` are exactly the
two `dft_open_request` accepts** (`ft_dft.c:146-157`) — predicted from the source before any host was
touched, then sent by a real host in a single session. The name field is ASCII **`FT:DATA`**, not
`FT:MSG`, so `message_flag` is false and these are real file opens: the branch distinction below is
live, not theoretical.

**VM's null result is equally a measurement, not an absence of testing.** Our unit
`00 0c 81 95 00 00 40 00 40 00 01 01` was on the wire 16 times and Summary listed `0x95`, against
four Read Partitions from VM. MECAFF saw DDM and declined it.

**So stage 2 HAS a live witness, on TSO — and CUT keeps its witnesses on both hosts, because the flag
defaults off.** The roadmap's "DFT has no live path here" is retired.

**The failing `-ddm on` transfer on TK5 IS the positive result**, because no DFT parser exists yet.
Judging the probe by whether the transfer succeeded would have inverted the finding. This is the same
rule the Sys Req live run needed: judge by trace.

### The risk this creates, and why the flag defaults off

CUT is the one part of this project's transfer work with exhaustive live witnesses: both hosts, both
directions, mid-flight cancellation, the geometry refusal, the `LRECL` asymmetry. **If advertising
DDM silently moves both hosts onto DFT, every one of those results becomes a statement about a code
path real hosts here no longer take.** Same shape as the documented lesson that a flipped default's
blast radius includes the tests and evidence that depended on the old one.

So DDM advertisement is **opt-in** until DFT has its own live evidence. **The user's decision,
2026-09-24: `-ddm` in all four front ends, default off, and once tested we switch to DFT as the
default.** The flag is not a permanent hedge; it is what makes the probe safe and what lets *both*
engines be driven against *both* hosts, which is the only route by which DFT gets verified here.

A practical virtue of the flag: it allows the same transfer, on the same host, run twice, differing
in **one byte of advertisement**. That is what makes the probe's result attributable.

## Architecture — four units, mirroring how CUT was built

| Unit | File | Purpose |
|---|---|---|
| Wire constants | `core/src/ft/dftFrames.ts` | Six host request types, four PC replies, the other headers, the error codes — each citing its `#define` in `ft_dft_ds.h` |
| State machine | `core/src/ft/dft.ts` | Frames in, reply bytes out. No I/O, no `Session`, **no `Screen`** |
| DDM advertisement | `core/src/queryreply.ts` | A new `ddm` capability, QCODE `0x95` |
| Inbound plumbing | `core/src/stream/sf.ts`, `stream/execute.ts`, `session.ts` | A `transferData` variant on the `StructuredField` union, and its dispatch |

### The asymmetry with CUT, which is why this is a new unit and not an extension

**CUT is screen-shaped; DFT is record-shaped.** `CutTransfer` takes a `Screen`, parses a frame out of
it, writes a response back into it, and returns an AID to press. `DftTransfer` never sees a `Screen`
at all: it takes the `SF_TRANSFER_DATA` payload and returns the bytes of a structured field to send.

So the two engines **share** `TransferRequest`, `FtHostType`, `Dialect`, `dialectFor`,
`parseTransferKeywords`, `transferCommand` and the whole transfer form — all of which already live in
`packages/frontend` — and **share no frame logic whatsoever**. Nothing in `ft/frames.ts` or
`ft/cut.ts` is touched by this work.

### Wire constants, from `ft_dft_ds.h`

Host requests: `TR_OPEN_REQ 0x0012`, `TR_CLOSE_REQ 0x4112`, `TR_SET_CUR_REQ 0x4511`,
`TR_GET_REQ 0x4611`, `TR_INSERT_REQ 0x4711`, `TR_DATA_INSERT 0x4704`.
PC replies: `TR_GET_REPLY 0x4605`, `TR_NORMAL_REPLY 0x4705`, `TR_ERROR_REPLY 0x08` (low 8 bits),
`TR_CLOSE_REPLY 0x4109`.
Other headers: `TR_RECNUM_HDR 0x6306`, `TR_ERROR_HDR 0x6904`, `TR_NOT_COMPRESSED 0xc080`,
`TR_BEGIN_DATA 0x61`. Error codes: `TR_ERR_EOF 0x2200`, `TR_ERR_CMDFAIL 0x0100`.

**Transcribe these from the header, not from this table** — see
`verify-wire-constants-against-sources`. The table exists so the plan can be written, not so the
constants can be copied without checking.

## Data flow

Host sends `WriteStructuredField` carrying SFID `0xd0` (`SF_TRANSFER_DATA`, dispatched by x3270 at
`sf.c:175`). Then:

1. `parseStructuredFields` yields a new `{ kind: 'transferData'; payload: Uint8Array }` variant.
2. `execute.ts`'s `WriteStructuredField` case surfaces it the way it already surfaces `sfReply` — as
   **a request for the session to answer**, not as a screen mutation. This keeps `execute` pure,
   which is what it already is.
3. `Session` routes the payload to the active `DftTransfer` and sends the returned reply as
   `AID_SF` + one structured field through the existing `sendInbound`.

`dft_open_request` writes exactly six bytes for its acknowledgement (`ft_dft.c:182-190`:
`AID_SF`, length 5, `SF_TRANSFER_DATA`, then `0x0009`), so the reply shape is small and fixed.

### Two details that are easy to miss, and are therefore their own tasks

**1. The Read Modified hook.** `ctlr.c:761` and `ctlr.c:987` **both** short-circuit to
`dft_read_modified()` when the AID is `AID_SF` (the guard is the line before each call), flushing a
retained upload buffer (`ft_dft.c:713-725`, guarded on `dft_savebuf_len`). Two call sites in x3270,
in the two read paths.
Ours needs the equivalent. **A transfer that omits it stalls on upload only — downloads would pass**,
which is precisely the shape of defect that ships.

**2. `Open` has two legal lengths and one special name.** `dft_open_request` accepts `len == 0x23`
(name at +25) or `len == 0x29` (record size at +27 via `GET16`, name at +31), and calls `dft_abort`
with `ftDftUnknownOpen` on anything else (`ft_dft.c:146-157`). The name is 7 bytes, trailing spaces
trimmed. **A name equal to `OPEN_MSG`, which is the literal string `"FT:MSG"` (`ft_dft.c:53`), means
"this is a message, not a file"** — x3270 sets
`message_flag` and does **not** call `ft_running` — so that branch must not start a transfer.
`dft_eof` is cleared, `recnum` set to 1, `dft_ungetc_count` to 0.

## The `-ddm` flag

`-ddm on|off`, **single-dashed** (it is an inherited client flag, not a gateway flag), default
**off**, in all four arg parsers: `cli/src/main.ts`, `tui/src/main.ts`, `gui/src/args.ts`,
`web/src/args.ts`. Plumbed as `SessionOptions.ddm`, following `-bind-image` exactly — the
established pattern for "a capability we advertise", already proven across all four front ends.

Off means the `ddm` capability is filtered out of the Query Reply, so a host **cannot** choose DFT.
The existing `returnedForQuery` mechanism in `queryreply.ts` is the filter point.

**INLIM/OUTLIM** come from a buffer size defaulting to **16384** (`DFT_BUF`, `globals.h:417`),
bounded **256..32767** (`DFT_MIN_BUF`/`DFT_MAX_BUF`, `globals.h:419-420`, applied by
`set_dft_buffersize`, `ft_dft.c:728-748`). The reply also carries `NSS=01, DDMSS=01` (`sf.c:906`),
where DDMSS `0x01` is "DDM Copy Subset 1" — the only defined value (`pages.txt:9844-9848`).

**`BufferSize` is already a parsed-but-ignored `Transfer` keyword** (`frontend/src/transfer.ts:317`).
This is what makes it mean something, and it is the natural home for the number rather than a second
flag. Note x3270 reads the per-transfer value when a transfer is active and the resource default
otherwise (`sf.c:893-898`).

## Error handling

Same rule as CUT, already established and tested: **a transfer fault ends the transfer, never the
session.** DFT's abort is `dft_abort` (`ft_dft.c:692`), sending `TR_ERROR_REPLY` with a code.

Two divergences from CUT worth stating so they are not "simplified" into consistency:

- **`ftUserCancel` is reused** for an operator cancellation — the same message string stage 1
  adopted ("Transfer canceled by user", American spelling x3270's, `fb-common:35`).
- **Cancellation is checked on the inbound edge.** `dft_data_insert` tests
  `!message_flag && ft_state == FT_ABORT_WAIT` **before** processing the data
  (`ft_dft.c:225-228`). CUT, by our own deliberate choice, sends the abort immediately where x3270
  defers via `FT_ABORT_WAIT`. For DFT the deferral is natural, because a DFT transfer always has a
  next inbound frame to answer.

## Verification

### Task 1, THE PROBE, IS DONE — `9f92816`, 2026-09-24

**Result above: TSO offers DFT, VM does not.** The probe scripts are committed as
`packages/cli/scripts/ddm-probe-vm.txt` and `ddm-probe-tso.txt`, each carrying its result in its
header. Re-run either as `node packages/cli/dist/main.js -insecure -model 3278-2-E -ddm on|off <
SCRIPT`. Both reach `LOGOFF`, so neither strands a userid.

**Consequences for the rest of the plan, which the original ordering existed to discover:**

- **The implementation plan GAINS live-run tasks on TSO**, and they are the real gate on this
  feature. A DFT engine verified only against synthetic payloads would be the weakest evidence in
  this project's transfer work; now it need not be.
- **TK5 is the reference host**, and it is the one that must be driven at **43x80** — the geometry
  that motivated the whole stage and that CUT refuses.
- **VM is the control.** It exercises the "advertised, declined" path, which is what proves the flag
  does not break a CUT host.

**Judge any re-run by TRACE, not by whether the transfer succeeded** — and note the direction of that
trap has now been measured in both directions. Before a DFT parser exists, success means the host
chose CUT and failure means it chose DFT; once one exists, both end in a transferred file and only
the trace distinguishes `SF_TRANSFER_DATA` frames from CUT screens. Same rule the Sys Req live run
needed.

### Host-free verification

Synthetic `SF_TRANSFER_DATA` payloads driven against `DftTransfer` directly — the approach that let
the entire CUT machine be tested without a host, and the reason `dft.ts` takes no `Session`. Plus a
test that **`-ddm off` puts no `0x95` on the wire**, which is the guard on the default.

### Blast radius — measure it, do not estimate it

Adding a capability changes the Query Reply bytes. So `conformance.test.ts`, `golden.test.ts` and the
playback traces (`drive-playback.py`) must be run **both ways**. With the flag defaulting off this
should be a no-op, and **confirming that it is a no-op is itself the test** — the precedent is the
`-model` default flip, whose blast radius was measured by flipping the constant, building, running
the suite and reverting.

Mutation-check anything claiming to pin the advertisement: the established failure mode here is a
test that passes vacuously because every other test in the file already supplies the value under
test.

## One question deliberately left open

**Whether DFT should honour `Recfm`/`Lrecl`/`Blksize` identically to CUT.** These are `IND$FILE`
command keywords rather than protocol, so they should ride through unchanged — but TSO's DFT `Open`
carries **its own record size** at +27 (`len == 0x29`), which CUT has no equivalent of. Resolve this
**from the wire during implementation**, not by guessing now. Stage 1 established the relevant
asymmetries by live measurement on both hosts (TSO honours `LRECL` with `RECFM V` and reports `VB`;
CMS ignores it and reports `V`), and the same discipline applies here.

## What this spec does not do

- **It does not flip the default to DFT.** The user has decided that happens after the probe; it is a
  one-line change plus whatever the blast-radius measurement turns up.
- **It does not touch the GUI form** (stage 3) or **the gateway** (stage 4, which the user has said
  is a security decision first — `web/src/protocol.ts` currently refuses the `transferForm` action
  outright, and that refusal is mutation-verified).
- **It does not touch `ft/cut.ts` or `ft/frames.ts`.**
