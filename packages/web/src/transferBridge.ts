import { MAX_TRANSFER_BYTES, ChunkReassembler, chunkBytes } from './transferChunk.js';

/**
 * The browser side of file transfer: read a local file out, write a received file in.
 *
 * ## BESIDE `bridgecore.ts` AND NOT INSIDE IT
 *
 * That module's header states the rule: `onAtlas`/`onFrame`/`onError`/`sendAction` are
 * `BridgeApi`'s REQUIRED width, the part of it `renderer.ts` relies on, and `renderer.ts` is reused
 * UNMODIFIED by the Electron GUI. A fifth REQUIRED member would mean the renderer had stopped being
 * shared. `BridgeApi` did grow a fifth member on 2026-11-02, `fetchSelection`, and a sixth on
 * 2026-11-03, `onCopyFailed`; both are OPTIONAL for exactly that reason: `preload.cts` implements
 * neither, and the renderer tests for each first.
 * Transfer plumbing is a separate object with its own dependencies, exactly as `keypadOverlay.ts`
 * sits beside it.
 *
 * `BridgeDeps` DID grow, by one optional `onTransfer` callback, and that is a different surface --
 * see the note this file's sibling carries on `toggleKeypad`, which made the argument first.
 * `BridgeDeps` is what the browser ENTRY POINT hands in; the renderer never sees it.
 *
 * ## EVERY BROWSER CAPABILITY IS INJECTED
 *
 * `vitest.config.ts` sets `environment: 'node'`: there is no `document`, no `File`, no `Blob` and
 * no `URL.createObjectURL` in any test in this repo, and jsdom is not a dependency. The same
 * constraint produced the same shape in `bridgecore.ts` (its socket) and `transferUi.ts` (its
 * DOM): the download sink is a dependency, which is what lets a unit test see every byte that
 * would have been downloaded, and every download that must not happen.
 *
 * `btoa` IS THE ONE CAPABILITY NOT INJECTED, deliberately: it is the convention this socket
 * already uses in the other direction (`bridgecore.ts:155` decodes the atlas with
 * `atob`), it is universal in browsers, and Node has had both as globals since 16 -- measured
 * present under this repo's test runner, which is what lets the encoder be asserted directly
 * rather than through a fake.
 */

export interface TransferBridgeDeps {
  /** Put one JSON text on the socket. */
  readonly send: (text: string) => void;
  /**
   * Download a received file: the `<a download>` route, which works in every browser.
   *
   * ## THE ONLY ROUTE, AND THERE IS NO `savePicker` ANY MORE (2026-11-12)
   *
   * This dep used to have a sibling, `savePicker`, wrapping `showSaveFilePicker`. It was removed
   * with the Save button: a receive now downloads AS IT COMPLETES, and `showSaveFilePicker` needs
   * transient user activation, which the click on Start has spent by the time `transferDone`
   * arrives. Firefox and Safari never had a picker at all (CONFIRMED LIVE 2026-10-22: the first
   * real operator was in Firefox over `https://` and took this route), so the browser's own
   * download behaviour now applies everywhere: the Downloads folder, or a prompt if the operator
   * configured one.
   *
   * **A SAVE DIALOG STILL DOES NOT PROVE ANYTHING ABOUT THE ROUTE.** Firefox's *always ask where
   * to save files* preference prompts on this anchor click too, and that dialog was once recorded
   * in `live-testing.md` as evidence of the picker.
   */
  readonly saveFallback: (name: string, bytes: Uint8Array) => void;
}

/**
 * TWO ARMS, SO `error` NARROWS, and this is not a style preference -- it is the shape this repo
 * converted away from twice in two days. `transferChunk.ts:61` records the first (`AcceptResult`)
 * and `protocol.ts:35` the second (`transferDone`): under `{ ok: boolean; error?: string }`, the
 * message a caller just branched on inside `if (!res.ok)` is still `string | undefined`, so every
 * reader needs a non-null assertion to print it.
 *
 * `UiDeps.submit` in `transferUi.ts:182` declares the loose shape, and this still satisfies it --
 * a missing optional property is assignable. NOT that it can be handed over DIRECTLY, though:
 * `sendFile` takes three parameters and `UiDeps.submit` takes one, so a direct assignment fails
 * with `TS2322: Target signature provides too few arguments`. The form gets a wrapping arrow, as
 * `gui/src/transferBoot.ts:250` already does for the Electron side. Only the RESULT shape is
 * shared; the call shape is the boot file's to adapt.
 */
export type SendResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * `acceptData`'s answer, which is NOT `AcceptResult` from `transferChunk.ts`.
 *
 * That type's success arm carries `done`, and this one deliberately does not -- so the overlay
 * cannot build a "wait for `done`" loop. `ChunkReassembler`'s own docstring names the trap:
 * `chunkBytes` emits no chunks for an empty file, so a ZERO-BYTE transfer never calls `accept` at
 * all and nothing ever reports `done: true`. `complete()` is the question to ask, and dropping
 * `done` from this surface is what stops the trap being re-exported.
 *
 * INSIDE `acceptData` THE TWO ARE EQUIVALENT, and that is stated because it was measured rather
 * than assumed: `accept` returns `done: received === declared` and `complete()` is
 * `!failed && received === declared`, with `failed` necessarily false on the success arm, so
 * swapping one for the other changes no behaviour any test can see -- MEASURED 2026-10-06, the
 * mutation leaves all 49 cases green. `complete()` is kept because it is the question that stays
 * correct if `ChunkReassembler` ever grows a way to be complete without a final `accept`, not
 * because today's code differs.
 */
export type ReceiveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** `deliver`'s answer: on success, how many bytes were handed to the download. */
export type DeliverResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly error: string };

export interface TransferBridge {
  sendFile(name: string, bytes: Uint8Array, keywords: readonly string[]): Promise<SendResult>;
  acceptData(seq: number, total: number, bytes: Uint8Array): ReceiveResult;
  /**
   * Download the received file, now. Reports its outcome rather than throwing.
   *
   * CALLED ONCE, BY THE COMPLETION (`endTransfer` below), and synchronous: `saveFallback` is a
   * synchronous anchor click. It used to be `save(name): Promise<SendResult>`, reached from a Save
   * button, because the removed `savePicker` route was async; see `TransferBridgeDeps`.
   *
   * THE BYTES ARE TAKEN AND CLEARED BEFORE THE SINK RUNS, so a second call delivers nothing, and
   * a throwing sink puts them back: `hasUnsaved()` then stays true and the overlay's close guard
   * still asks before they are dropped. They are the only copy -- the host is out of transfer mode.
   *
   * NOTHING STAGED IS AN ERROR here, where it was a quiet no-op for the button: this is only
   * called for a receive the gateway called successful, so nothing to deliver means the file did
   * not arrive whole, and reporting `downloaded as ...` over that would be a success with no file.
   */
  deliver(name: string): DeliverResult;
  /**
   * Is a completed receive being held, undelivered? For the overlay's close guard ONLY.
   *
   * TRUE ONLY TRANSIENTLY since 2026-11-12: `endTransfer` delivers in the same turn the receive
   * completes, so this is true between the last chunk and `transferDone`, and after a `deliver`
   * whose sink threw. Nothing enables a control from it any more; the Save button that did is gone.
   */
  hasUnsaved(): boolean;
  /**
   * Declare a receive finished, for the one case no chunk can announce: a ZERO-BYTE FILE.
   *
   * `ReceiveResult`'s docstring above names this trap and then -- until 2026-10-07 -- left it
   * unhandled. `chunkBytes` emits no chunks for an empty source, so the gateway sends
   * `transferDone` with no `transferData` at all: `acceptData` is never called, nothing is
   * staged, `hasUnsaved()` is false and `save()` writes nothing. An operator downloading an empty
   * host dataset got SILENCE. Measured 2026-10-07, along with the other door being shut too --
   * a gateway that helpfully sent one empty chunk is refused by `ChunkReassembler` with
   * `chunk 0 arrived after all 0 bytes`, so there was no path at all.
   *
   * The caller (`endTransfer` below, on `transferDone`) calls this when a successful receive
   * staged nothing. A transfer that DID stage bytes is untouched, so this cannot mask a
   * half-finished one.
   */
  finishEmpty(): void;
  cancel(): void;
}

export function createTransferBridge(deps: TransferBridgeDeps): TransferBridge {
  /**
   * The in-flight receive, and IT IS NOT CLEARED ON A REFUSAL.
   *
   * `ChunkReassembler` LATCHES: after one bad chunk it refuses everything, because -- in its own
   * words -- "a half-rejected reassembler that still completes is a corrupt file delivered as a
   * success". That latch lives in the object, so DISCARDING THE OBJECT HERE WOULD UNDO IT. The
   * first draft of this file did exactly that (`inbound = undefined` on the failure path), which
   * reads as tidy cleanup and silently restores the bug: the next `transferData` builds a fresh
   * reassembler, its chunk 0 is in sequence again, and the operator saves a file missing every
   * chunk that was dropped in between. `cancel()` is the only reset.
   */
  let inbound: ChunkReassembler | undefined;
  let complete: Uint8Array | undefined;
  /**
   * The total the FIRST inbound chunk declared, kept so later chunks can be checked against it.
   *
   * `ChunkReassembler` holds its own copy privately and has no getter, so this is not a second
   * source of truth to drift -- it is the one value this module needs and cannot read back.
   */
  let declared = 0;
  /**
   * Has any inbound chunk been refused in this transfer?
   *
   * SEPARATE FROM THE REASSEMBLER'S OWN LATCH, because a constructor failure never produces a
   * reassembler to latch -- which is precisely the hole `finishEmpty` fell into. Cleared only by
   * `cancel()`, like every other piece of receive state here.
   */
  let refused = false;

  /**
   * base64 one chunk, THE ONLY CORRECT WAY TO DO IT IN A BROWSER.
   *
   * NO `Buffer`: this module is served to the browser by `httpstatic.ts`, where `Buffer` does not
   * exist. The server decodes with `Buffer.from(s, 'base64')` in `protocol.ts:303`, which is the
   * mirror image of this and is correct THERE.
   *
   * AND NOT `btoa(bytes)` OR `btoa(String(bytes))` either, which is the trap worth naming because
   * both RUN. MEASURED 2026-10-06 on node 26: each stringifies the array to `"1,2,3"` and returns
   * `MSwyLDM=` -- valid base64 of the decimal TEXT of the bytes. The server would decode it
   * without complaint and stage a file of ASCII digits and commas, so the failure is a silently
   * corrupt transfer rather than an error anywhere.
   *
   * A LOOP RATHER THAN `String.fromCharCode(...bytes)`, and the honest reason is smaller than the
   * one first written down here. That draft said a spread would "blow the argument limit on a
   * 4 KB chunk's worth of args", which is FALSE: measured 2026-10-06, the spread limit on node 26
   * is between 125000 and 126000 arguments, so today's 4096-byte chunk spreads fine. The loop is
   * kept because it holds for ANY `CHUNK_BYTES` -- including a whole 10 MB file, which does throw
   * `RangeError: Maximum call stack size exceeded` -- so correctness here does not quietly depend
   * on a constant in another module staying small.
   */
  const b64 = (bytes: Uint8Array): string => {
    let s = '';
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  };

  return {
    async sendFile(name, bytes, keywords) {
      if (bytes.length > MAX_TRANSFER_BYTES) {
        // REFUSED IN THE BROWSER, BEFORE A SINGLE CHUNK GOES OUT -- decision 2. The gateway
        // re-checks the declared total because a client is not to be trusted, but the operator
        // should learn this without uploading 10 MB first. The attempted size comes FIRST so a
        // truncated line still shows what was attempted, matching `ChunkReassembler`'s wording.
        return {
          ok: false,
          error: `${name} is ${bytes.length} bytes, over the ${MAX_TRANSFER_BYTES}-byte limit; `
            + 'the gateway stages the whole file in memory, so larger transfers are refused',
        };
      }
      const chunks = chunkBytes(bytes);
      for (let i = 0; i < chunks.length; i += 1) {
        // `total` IS THE FILE'S LENGTH ON EVERY CHUNK, not this chunk's: it is what the gateway
        // hands `new ChunkReassembler(total)`, so a per-chunk length would build a reassembler
        // expecting 4096 bytes and refuse chunk 1 as an overrun of the declared total.
        deps.send(JSON.stringify({
          kind: 'transferChunk', seq: i, total: bytes.length, bytes: b64(chunks[i]!),
        }));
      }
      // AFTER THE CHUNKS, ALWAYS, and this ordering is the one thing in this file a test cannot
      // discover by accident: the gateway stages bytes on `transferChunk` and STARTS on
      // `transferStart`, so a start that arrived first would transfer an empty buffer and report
      // success. Sent even when there are no chunks -- an empty local file is a legal transfer.
      deps.send(JSON.stringify({ kind: 'transferStart', keywords }));
      return { ok: true };
    },

    acceptData(seq, total, bytes) {
      if (inbound === undefined) {
        // CONSTRUCTED INSIDE A `try`, because `ChunkReassembler`'s constructor THROWS on a total
        // that is not a non-negative integer or is over the 10 MB cap -- and this method is
        // called from `bridgecore.ts`'s `onmessage`, inside an async IIFE whose rejection goes
        // nowhere: the operator would see a transfer that stops with nothing in any console. The
        // thrown text is already operator-facing by that class's own decision 2, so it is
        // forwarded rather than replaced.
        try {
          inbound = new ChunkReassembler(total);
          declared = total;
        } catch (err) {
          // THE CONSTRUCTOR FAILURE THAT ASSIGNS NOTHING, which is why `refused` exists.
          refused = true;
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      } else if (total !== declared) {
        // THE DECLARED TOTAL MUST NOT MOVE MID-TRANSFER, and without this check it silently did.
        // `total` rides on EVERY `transferData` and was read only from the first, so a later
        // chunk could claim anything and be ignored.
        //
        // MEASURED 2026-10-07, and the failure was not a stall: a 6-byte receive whose first
        // chunk declared `total: 2` COMPLETED at two bytes, `hasUnsaved()` went true, and `save()`
        // wrote a TRUNCATED FILE AS A SUCCESS. The remaining chunks then failed out of sequence,
        // after the damage was already saveable. That is the one outcome `transferRun.ts` refuses
        // to produce on the host side -- a "complete" that is not the file -- arriving by a
        // different door.
        //
        // Refused rather than repaired, matching `ChunkReassembler`'s own posture, and the
        // reassembler is left LATCHED rather than reset: a sender that contradicts itself has
        // disqualified the whole transfer, not just this chunk.
        inbound.accept(-1, new Uint8Array(0));
        refused = true;
        return {
          ok: false,
          error: `chunk ${seq} declares total ${total}, but the transfer declared ${declared}`,
        };
      }
      const out = inbound.accept(seq, bytes);
      // NOT CLEARED ON FAILURE -- see `inbound`'s declaration. The latch is in the object.
      if (!out.ok) { refused = true; return { ok: false, error: out.error }; }
      // `complete()` AND NOT `out.done` -- equivalent here, and `ReceiveResult` records why it is
      // still the right question to ask.
      if (inbound.complete()) { complete = inbound.bytes(); inbound = undefined; }
      return { ok: true };
    },

    deliver(name) {
      const bytes = complete;
      if (bytes === undefined) {
        return { ok: false, error: `${name} did not arrive whole; nothing was downloaded` };
      }
      complete = undefined;
      try {
        deps.saveFallback(name, bytes);
      } catch (err) {
        // RESTORED: the bytes are still the only copy, so the close guard keeps asking.
        complete = bytes;
        return {
          ok: false,
          error: `could not download ${name}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      return { ok: true, bytes: bytes.length };
    },

    hasUnsaved() { return complete !== undefined; },

    finishEmpty() {
      // ONLY WHEN NOTHING IS IN FLIGHT. A staged partial receive means the gateway said "done"
      // over a transfer that did deliver chunks, which is a contradiction this must not paper
      // over by inventing an empty file -- `acceptData`'s own checks own that case.
      if (inbound !== undefined || complete !== undefined) return;
      // NOR WHEN A CHUNK WAS REFUSED, which the two checks above CANNOT see and which was the
      // fourth instance of this feature's empty-file-as-success class (found 2026-10-07).
      //
      // `acceptData`'s `try` returns a `ChunkReassembler` constructor failure WITHOUT assigning
      // `inbound`, so an over-cap receive left both of those undefined and looked exactly like
      // the legal zero-byte case. Measured: an 11 MB download -- which the gateway had no cap
      // against in that direction -- made `hasUnsaved()` true, enabled Save, and wrote a 0-byte
      // `REPORT.TXT` while the status line correctly said the transfer had been refused.
      //
      // THE CALLER ALSO GUARDS THIS (`transferBoot.ts` holds the refusal and skips the call), and
      // both halves are deliberate: a caller that forgets must still get nothing, because the
      // cost of this one going wrong is an operator's file silently replaced by an empty one.
      if (refused) return;
      complete = new Uint8Array(0);
    },

    cancel() {
      refused = false;
      // THE ONLY RESET PATH, and it has to clear `inbound` as well as `complete`: without that a
      // latched refusal would make the overlay refuse every later transfer for the session, since
      // `acceptData` deliberately keeps the dead reassembler. A cancelled transfer's partial
      // bytes are dropped on purpose -- leaving them deliverable would let a later completion
      // download a truncated copy of a file the operator abandoned.
      inbound = undefined;
      complete = undefined;
      deps.send(JSON.stringify({ kind: 'transferCancel' }));
    },
  };
}

/** What `transferDone` said, plus the boot file's own memory of the run it ends. */
export interface TransferEnd {
  /** `transferDone.ok`. */
  readonly ok: boolean;
  /** `transferDone.error`, already coerced to text by the caller; read only when `ok` is false. */
  readonly error: string;
  /** `transferDone.bytes`, when it carried one. */
  readonly bytes: number | undefined;
  /** The direction captured at submit, or `undefined` for a `transferDone` with no run. */
  readonly direction: 'send' | 'receive' | undefined;
  /** A chunk this run refused, held for the ending; see `transferBoot.ts`'s `receiveError`. */
  readonly refusal: string | undefined;
  /** The download's name, fixed at submit from the submitted `LocalFile=`. */
  readonly saveName: string;
}

/**
 * How a transfer ended: what to hand `TransferUi.finished`, and the status line to put up after
 * it, when the ending has more to say than `finished()`'s shared `done: N bytes`.
 */
export interface TransferEnding {
  readonly result:
    | { readonly ok: true; readonly bytes?: number }
    | { readonly ok: false; readonly error: string };
  readonly status: string | undefined;
}

/**
 * End a transfer: on a successful receive, DOWNLOAD IT, now, under `saveName`.
 *
 * ## HERE, AND NOT IN `transferBoot.ts`, SO A TEST CAN SEE IT
 *
 * That file has no unit test by design (its header: there is no `document` under vitest), and
 * every decision this function makes -- download or not, under which name, and what the operator
 * is told -- is one whose mutation must fail a test. It is a function of the bridge and five
 * values, so it lives beside the bridge, in a module the browser already loads: no new entry in
 * `static/index.html`'s import map or `httpstatic.ts`'s served list.
 *
 * ## THE ORDER OF THE GUARDS IS THE ORDER THEY WERE PAID FOR
 *
 * - **A refused chunk beats the gateway's ok.** The gateway sends its chunks and then
 *   `transferDone {ok:true}` regardless, so a refusal must replace the ok, or the operator reads
 *   success over a download that does not exist. And nothing is downloaded: `deliver` is not even
 *   called. `finishEmpty()` is not called either -- the fourth empty-file-as-success guard, see
 *   `transferBoot.ts`'s note at its call site and this module's `finishEmpty`.
 * - **Only a RECEIVE delivers.** A send that staged nothing is every successful upload there is,
 *   and `finishEmpty()` on one would download an empty copy of the operator's own source.
 * - **A failed `transferDone` delivers nothing**, and shows the gateway's error.
 *
 * `finishEmpty()` RUNS BEFORE `deliver` for the zero-byte receive no chunk can announce; it is
 * inert when anything was staged, still in flight, or refused.
 *
 * NO ELLIPSIS IN THE STATUS TEXT: Fira Code and friends ligate `..` and `...` (`transferUi.ts`).
 */
export function endTransfer(bridge: TransferBridge, end: TransferEnd): TransferEnding {
  if (!end.ok) return { result: { ok: false, error: end.error }, status: undefined };
  if (end.refusal !== undefined) {
    return { result: { ok: false, error: end.refusal }, status: undefined };
  }
  if (end.direction !== 'receive') {
    // BUILT EXPLICITLY RATHER THAN SPREAD: `exactOptionalPropertyTypes` is on, and `bytes` is
    // absent on a `transferDone` that carried none (`protocol.ts`).
    return {
      result: { ok: true, ...(end.bytes !== undefined ? { bytes: end.bytes } : {}) },
      status: undefined,
    };
  }
  bridge.finishEmpty();
  const out = bridge.deliver(end.saveName);
  if (!out.ok) return { result: { ok: false, error: out.error }, status: undefined };
  return {
    result: { ok: true, bytes: out.bytes },
    status: `received ${out.bytes} bytes; downloaded as ${end.saveName}`,
  };
}
