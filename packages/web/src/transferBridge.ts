import { MAX_TRANSFER_BYTES, ChunkReassembler, chunkBytes } from './transferChunk.js';

/**
 * The browser side of file transfer: read a local file out, write a received file in.
 *
 * ## BESIDE `bridgecore.ts` AND NOT INSIDE IT
 *
 * That module's header states the rule: *"If this file grows a fifth function, the renderer has
 * stopped being shared."* `onAtlas`/`onFrame`/`onError`/`sendAction` is `BridgeApi`, the whole of
 * what `renderer.ts` consumes, and `renderer.ts` is reused UNMODIFIED by the Electron GUI.
 * Transfer plumbing is a separate object with its own dependencies, exactly as `keypadOverlay.ts`
 * sits beside it.
 *
 * `BridgeDeps` DID grow, by one optional `onTransfer` callback, and that is a different surface --
 * see the note this file's sibling carries on `toggleKeypad`, which made the argument first.
 * `BridgeDeps` is what the browser ENTRY POINT hands in; the renderer never sees it.
 *
 * ## EVERY BROWSER CAPABILITY IS INJECTED
 *
 * `vitest.config.ts` sets `environment: 'node'`: there is no `document`, no `File`, no `Blob`, no
 * `URL.createObjectURL` and no `showSaveFilePicker` in any test in this repo, and jsdom is not a
 * dependency. The same constraint produced the same shape in `bridgecore.ts` (its socket) and
 * `transferUi.ts` (its DOM). `savePicker` being `undefined` IS the feature-detection result,
 * injected rather than read from `window` at the call site -- which is what lets a unit test drive
 * BOTH save routes. The fallback is the one at risk of rotting, because a developer on
 * Chrome-over-localhost always gets the picker.
 *
 * `btoa` IS THE ONE CAPABILITY NOT INJECTED, deliberately: it is the convention this socket
 * already uses in the other direction (`bridgecore.ts:133` decodes the atlas with
 * `atob`), it is universal in browsers, and Node has had both as globals since 16 -- measured
 * present under this repo's test runner, which is what lets the encoder be asserted directly
 * rather than through a fake.
 */

/**
 * A disk-backed sink: a `FileSystemWritableFileStream`, narrowed to what this uses.
 *
 * Declared here rather than taken from `lib.dom` because the File System Access types are not in
 * the DOM lib this package compiles with (`tsconfig.json` names `DOM` and `DOM.Iterable`;
 * `FileSystemWritableFileStream` is in neither as of TypeScript 7.0). `transferBoot.ts` will cast
 * the real handle to this shape at the single point that touches `globalThis`.
 */
export interface SaveSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface TransferBridgeDeps {
  /** Put one JSON text on the socket. */
  readonly send: (text: string) => void;
  /**
   * Open a save dialog, or `undefined` when the browser has none.
   *
   * `showSaveFilePicker` is Chrome/Edge/Opera desktop only -- NO Firefox, NO Safari desktop or
   * iOS, nothing on mobile -- and needs a secure context, which a LAN gateway on plain http does
   * not have. See the spec's *The save dialog, and where it is not available*. So `undefined` is
   * the COMMON case for this gateway, not an edge one, which is why `saveFallback` is required
   * and this is not.
   */
  readonly savePicker?: (suggestedName: string) => Promise<SaveSink>;
  /** A plain `Blob` download, which works everywhere. REQUIRED, for the reason just above. */
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
 * a missing optional property is assignable, so `sendFile` can be handed straight to the form.
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

export interface TransferBridge {
  sendFile(name: string, bytes: Uint8Array, keywords: readonly string[]): Promise<SendResult>;
  acceptData(seq: number, total: number, bytes: Uint8Array): ReceiveResult;
  save(name: string): Promise<void>;
  hasUnsaved(): boolean;
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
   * base64 one chunk, THE ONLY CORRECT WAY TO DO IT IN A BROWSER.
   *
   * NO `Buffer`: this module is served to the browser by `httpstatic.ts`, where `Buffer` does not
   * exist. The server decodes with `Buffer.from(s, 'base64')` in `protocol.ts:298`, which is the
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
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      const out = inbound.accept(seq, bytes);
      // NOT CLEARED ON FAILURE -- see `inbound`'s declaration. The latch is in the object.
      if (!out.ok) return { ok: false, error: out.error };
      // `complete()` AND NOT `out.done` -- equivalent here, and `ReceiveResult` records why it is
      // still the right question to ask.
      if (inbound.complete()) { complete = inbound.bytes(); inbound = undefined; }
      return { ok: true };
    },

    async save(name) {
      const bytes = complete;
      // NOTHING TO SAVE IS NOT AN ERROR. The overlay enables its Save button off `hasUnsaved()`,
      // but this runs from a click handler where a throw is an unhandled rejection, and a second
      // click that lost the race to the button's own disabling must be inert.
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
      // THE ONLY RESET PATH, and it has to clear `inbound` as well as `complete`: without that a
      // latched refusal would make the overlay refuse every later transfer for the session, since
      // `acceptData` deliberately keeps the dead reassembler. A cancelled transfer's partial
      // bytes are dropped on purpose -- leaving them saveable would let a Save click write a
      // truncated download of a file the operator abandoned.
      inbound = undefined;
      complete = undefined;
      deps.send(JSON.stringify({ kind: 'transferCancel' }));
    },
  };
}
