import type { Session } from '@tn3270/core';
import { transferCommand, type StartTransferOptions, type TransferRun } from '@tn3270/frontend';
import type { ServerMessage } from './protocol.js';
import { ChunkReassembler, chunkBytes } from './transferChunk.js';

/**
 * The gateway half of socket-carried file transfer: stage, run, relay.
 *
 * ## THE DESIGN POINT, IN FOUR METHODS
 *
 * `startTransfer` is UNMODIFIED and so are `transferRun.ts` and both transfer engines. What makes
 * a browser transfer move the OPERATOR's files rather than the gateway's is the `TransferFiles`
 * built in `start` below: `read` hands back the bytes that arrived over the socket, `write`
 * captures what the host returned, and NEITHER TOUCHES THE GATEWAY'S DISK. That is the whole
 * feature. `@tn3270/node-files` -- the `node:fs` implementation the CLI, TUI and GUI use -- is
 * deliberately not imported here.
 *
 * IT STAYS SYNCHRONOUS, which is what lets a `TransferFiles` be in-memory at all: no call happens
 * mid-transfer. A send reads ONCE up front, before the host is told anything
 * (`transferRun.ts:102`, above `sendAID(ENTER)` at `:444`), and a receive writes ONCE at the end
 * with every byte already in memory (`:335` for DFT, `:401` for CUT).
 *
 * ## WHY THIS IS A MODULE AND NOT TWENTY LINES INSIDE `main.ts`'s CONNECTION CLOSURE
 *
 * The plan called for the latter, and it would have been UNTESTABLE. Every gateway in
 * `integration.test.ts` runs under `--replay`, and `Session.replay` builds its own local
 * `TelnetLayer` rather than assigning `this.telnet` (`core/src/session.ts:1626-1668`), so
 * `is3270Mode()` is FALSE on every replayed session -- MEASURED 2026-10-07 against all four
 * fixture traces. `startTransfer`'s first guard is exactly that (`transferRun.ts:90`), so a real
 * `startTransfer` behind a real socket can only ever take its earliest refusal: the receive path,
 * the progress relay, the chunk-out, the zero-byte receive and the cancel would all have been
 * unreachable, and so unmutatable.
 *
 * Injecting `startTransfer` is what makes them testable, and it is the shape three siblings
 * already use for the same reason -- `transferBridge.ts` for its browser capabilities,
 * `gui/src/transferWindow.ts:69` for this very function, `bridgecore.ts` for its socket.
 *
 * ## EVERY REFUSAL LEAVES THE SOCKET OPEN
 *
 * A malformed chunk, an over-cap total, a bad keyword list, a short upload: all are reported as
 * `transferDone {ok:false, error}` and NONE closes the connection. Closing would take the
 * operator's whole 3270 session with it, which is a wildly disproportionate answer to a mistyped
 * `HostFile`. This is `ChunkReassembler`'s own posture (`transferChunk.ts:72-78`) carried up a
 * layer.
 */

export interface GatewayTransferDeps {
  /** Put one message on this connection's socket. */
  readonly send: (msg: ServerMessage) => void;
  /**
   * Ask for a frame, because a transfer TYPES INTO THE SCREEN and nothing else will notice.
   *
   * MEASURED 2026-10-07 on a replayed session: `primeAndType`'s three keyboard calls --
   * `home()`, `eraseEOF()`, `typeString(command)` (`transferRun.ts:524-575`) -- changed the screen
   * buffer and emitted ZERO `screen` events. So this socket's three session listeners see nothing
   * and the browser shows a screen without the IND$FILE command on it until the host next speaks.
   * `main.ts`'s action path already carries exactly this measurement for a local action; this is
   * the same fact reached by a second door.
   */
  readonly repaint: () => void;
  /**
   * `startTransfer` from `@tn3270/frontend`, injected rather than imported -- see the header.
   *
   * `gui/src/transferWindow.ts:69` declares the same dep for the same reason, with `session` and
   * `files` already bound. Here they are NOT bound: `session` arrives per `start` (the connection
   * only has one after `hello`) and `files` is this module's whole point.
   */
  readonly startTransfer: (opts: StartTransferOptions) => TransferRun;
}

export interface GatewayTransfer {
  /** One inbound `transferChunk`. Reports a refusal; never throws. */
  chunk(seq: number, total: number, bytes: Uint8Array): void;
  /** One inbound `transferStart`. Reports a refusal; never throws. */
  start(keywords: readonly string[], session: Session): void;
  /** One inbound `transferCancel`: abort any run and drop any staging. */
  cancel(): void;
  /** The connection is going away: abort any run and drop any staging, silently. */
  discard(): void;
}

/**
 * One of these per CONNECTION, built in `main.ts`'s upgrade handler.
 *
 * PER CONNECTION AND NOT PER SESSION, which is the same rule the deleted `showKeypad` flag
 * obeyed and `main.ts:133-144` still records: a gateway `Session` deliberately OUTLIVES its
 * socket so a reload can reattach, so anything held per session is handed to whoever attaches
 * NEXT -- a different window, possibly a different person. A half-staged upload handed over that
 * way would be a file the new operator never chose, transferred under their session.
 *
 * Holding it in a closure makes that STRUCTURAL rather than a clear anybody has to remember: a
 * reattaching client gets a new `Connection`, a new handler closure and a new one of these, so
 * the previous operator's bytes are not merely cleared but UNREACHABLE.
 */
export function createGatewayTransfer(deps: GatewayTransferDeps): GatewayTransfer {
  /**
   * The upload being assembled, AND IT IS NOT CLEARED ON A REFUSAL.
   *
   * `ChunkReassembler` LATCHES: after one bad chunk it refuses everything, because -- in its own
   * words -- "a half-rejected reassembler that still completes is a corrupt file delivered as a
   * success" (`transferChunk.ts:80-85`). THAT LATCH LIVES IN THE OBJECT, so clearing this on the
   * failure path UNDOES IT -- the next chunk 0 builds a fresh reassembler and is in sequence
   * again. The plan's draft for this task did exactly that, and `transferBridge.ts:153-162`
   * records the first draft of the BROWSER half making the identical mistake.
   *
   * IT IS WORSE HERE THAN THERE, which is why this is the first comment in the file. `start`
   * distinguishes "nothing was ever staged" -- a legal zero-byte upload, see there -- from
   * "staging exists and fell short". A cleared reassembler collapses those two, so a REFUSED
   * upload would become an EMPTY one transferred as a success. `cancel` and `discard` are the
   * only resets.
   */
  let staging: ChunkReassembler | undefined;
  /** The completed upload, waiting for the `transferStart` that follows it. */
  let staged: Uint8Array | undefined;
  /**
   * A chunk was refused by `ChunkReassembler`'s CONSTRUCTOR, which leaves no object behind.
   *
   * ## THE ONE DOOR THE LATCH DOES NOT COVER, AND IT WAS A REAL DEFECT
   *
   * `accept`'s refusals leave a LATCHED reassembler in place, which is what lets `start`
   * distinguish "a refused upload" from "nothing was ever staged" -- and the second of those is
   * the legal zero-byte upload (see `start`). A THROWING CONSTRUCTOR assigns nothing:
   * `staging ??= new ChunkReassembler(total)` never completes, so `staging` stays `undefined` and
   * reads as the empty-file case.
   *
   * MEASURED 2026-10-07 against the built `dist`, in the first version of this module: refuse a
   * 20 MB declared total, then send `transferStart`, and `startTransfer` WAS CALLED with a
   * zero-length source. The operator asks to send a 20 MB file, is correctly told it is too large,
   * and the gateway then uploads an EMPTY FILE to their host dataset -- under `Exist=replace`,
   * destroying it -- and reports success. The empty-file-under-a-success-message failure this repo
   * has a standing rule about, arriving through the one gap in the latch.
   *
   * A SEPARATE FLAG RATHER THAN A FAKE REASSEMBLER, because the alternative is worse than it
   * looks: `new ChunkReassembler(0)` would be COMPLETE at construction and stage an empty file,
   * and any other size would make `start`'s message quote a total nobody declared.
   *
   * CLEARED BY `reset` with everything else, so an operator who picked too large a file once is
   * not refused for the life of the socket -- which on this gateway means until they reload and
   * lose the window their 3270 session is in.
   */
  let poisoned = false;
  /** The live run, or `undefined` when nothing is running. */
  let run: TransferRun | undefined;
  /**
   * Which run is current, so a `onDone` that fired INSIDE `startTransfer` cannot be overwritten.
   *
   * `startTransfer` CAN CALL `onDone` BEFORE IT RETURNS: a whole DFT transfer can begin and finish
   * inside `session.sendAID(AID.ENTER)`'s record handling, which is why that call's listeners are
   * registered before it (`transferRun.ts:429-444`), and the statement after it is
   * `if (ended) return { ok: true };` (`:449`) -- a run with no `cancel`, there being nothing left
   * to cancel.
   *
   * `gui/src/transferWindow.ts:183-224` records the bug an unconditional assignment caused there:
   * the flag was armed on a transfer that had already ended, and that window then refused every
   * close for the rest of its life. HERE the same mistake latches `already running` forever, so
   * the operator's next transfer is refused and so is every one after it, with no way back short
   * of reloading the page. The generation makes it structural rather than an ordering convention
   * somebody has to remember.
   */
  let generation = 0;

  const fail = (error: string): void => {
    // A REFUSAL, NOT A PROTOCOL VIOLATION, so the socket stays open -- see the header.
    deps.send({ kind: 'transferDone', ok: false, error });
  };

  /** Abort any run and drop everything staged. Shared by `cancel` and `discard`. */
  const reset = (): void => {
    // `run?.cancel?.()` -- BOTH OPTIONAL CHAINS ARE LOAD-BEARING. `TransferRun.cancel` is
    // declared optional and is genuinely absent on the synchronous-completion path
    // (`transferRun.ts:61-62`, `:449`), so `run.cancel()` is a `TypeError` thrown out of a socket
    // 'data' handler -- which `wsserver.ts:30-34` records as ending the gateway process.
    run?.cancel?.();
    run = undefined;
    generation += 1;
    staging = undefined;
    staged = undefined;
    poisoned = false;
  };

  return {
    chunk(seq, total, bytes) {
      try {
        // THE FIRST CHUNK DECLARES THE TOTAL, and the constructor is where the 10 MB cap is
        // enforced -- it THROWS, both for an over-cap total and for one that is not a
        // non-negative integer (`transferChunk.ts:99-116`), which is why this is inside the try.
        // The thrown text is already operator-facing by that class's decision 2, so it is
        // forwarded rather than replaced.
        staging ??= new ChunkReassembler(total);
      } catch (err) {
        // POISONED, because the throw assigned NOTHING and `undefined` staging means "empty file"
        // to `start`. See `poisoned`, and the measured empty-upload-over-a-destroyed-dataset it
        // records. This must be set before the `fail`, or an exception from `send` would leave the
        // connection refusing nothing.
        poisoned = true;
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      const out = staging.accept(seq, bytes);
      // NOT CLEARED ON FAILURE -- see `staging`'s declaration. The latch is in the object.
      if (!out.ok) { fail(out.error); return; }
      // `complete()` RATHER THAN `out.done`, which is the question that stays correct: a declared
      // total of 0 is complete at construction with no `accept` ever having returned `done`
      // (`transferChunk.ts:118-127`). Unreachable from here today -- `ChunkReassembler` refuses
      // the empty chunk that would carry a declared 0 -- but asking the right question costs
      // nothing, and `transferBridge.ts:265-271` made the same call for the same reason.
      if (staging.complete()) { staged = staging.bytes(); staging = undefined; }
    },

    start(keywords, session) {
      if (run !== undefined) {
        // `startTransfer` types a command into the screen and registers three session listeners
        // plus two timers. A second run on the same session would type OVER a transfer in flight
        // and leave two drivers racing for the same frames -- and this closure holds one `run`,
        // so the first one's `cancel` would be lost and that transfer could never be stopped.
        fail('a transfer is already running on this session; cancel it first');
        return;
      }
      if (poisoned) {
        // A CHUNK WAS REFUSED BY THE CONSTRUCTOR, which left no reassembler for the guard below to
        // see -- so without this the start proceeds as the legal zero-byte upload and sends an
        // EMPTY file. See `poisoned` for the measurement; it is the sharpest bug in this module's
        // history and it was in its first version.
        fail('the staged transfer was refused; send the file again');
        return;
      }
      if (staging !== undefined) {
        /*
          THE SHORT-CHUNK STALL IS CLOSED HERE, AND THIS LINE IS THE WHOLE OF THE FIX.

          `Buffer.from(s, 'base64')` IS LENIENT and `protocol.ts:294-297` says so: it skips what
          it cannot use rather than throwing. MEASURED 2026-10-07 on node 26: `'!!!!'` decodes to
          ZERO bytes, `'AQ!ID'` silently drops the `!` and yields the same three bytes as
          `'AQID'`, and deleting ANY ONE character from the 8-character encoding of 6 bytes yields
          5 bytes with no complaint. `ChunkReassembler` refuses OVERRUNS only, so a short chunk
          leaves it merely INCOMPLETE -- and that is CORRECT at the moment the chunk arrives,
          because a short chunk and a chunk with more to follow are indistinguishable until the
          sender says it has finished.

          `transferStart` IS WHEN THE SENDER SAYS SO. It is the earliest point at which short can
          be told from unfinished, and it ALWAYS ARRIVES: `transferBridge.sendFile` sends every
          chunk and then `transferStart` whatever happened -- "Sent even when there are no
          chunks", `transferBridge.ts:222-226`. Without this the transfer went silent with
          `transferDone` never sent at all: the operator watched a progress line stop, with
          nothing in any console. Task 3's review found that and left it here.

          WHY NOT VALIDATE THE BASE64 AT DECODE, which was the alternative offered. A decode throw
          in `protocol.ts` is answered as an `error` frame and never reaches this module, so the
          chunk would leave NO TRACE here -- and the `transferStart` behind it would find nothing
          staged, which is the legal zero-byte upload below. A damaged 6-byte upload would become
          a successful EMPTY one. Strict validation would have to be paired with poisoning state
          this module owns, which is two mechanisms where this is one. (It is also not free:
          `'AR=='` and `'AQ=A'` both decode to one byte and only the first is canonical, so a
          regex strict enough to catch the second has to be exactly right about padding.)

          WHY NOT BOUND THE WAIT: a timer would invent a deadline for a transfer nobody has asked
          to start, and `transferRun.ts`'s module header gives this project's rule about inferred
          deadlines. A client that sends chunks and never a `transferStart` holds memory bounded
          by the 10 MB cap until its socket closes, and starts nothing -- there is no progress
          line, so there is nothing to stall.

          BOTH NUMBERS ARE QUOTED, because "incomplete" alone does not tell an operator what to
          do: 5 of 6 bytes is a damaged chunk worth retrying, 2 of 99 is a transfer that never
          ran. Neither was readable from outside `ChunkReassembler` -- `received` and `declared`
          are private and there were no getters -- so `progress()` was added there rather than
          recovered here, and its own docstring records why it is one method and not two getters.
        */
        fail(`transfer bytes are incomplete: ${staging.progress()}`);
        return;
      }
      /**
       * The bytes this run will send, TAKEN rather than read: a start consumes its staging.
       *
       * Leaving `staged` set would let a later `transferStart` -- a different file, or a receive
       * the operator has since typed -- upload the previous file again, and under `Exist=replace`
       * overwrite the host dataset with it.
       *
       * AN EMPTY ARRAY WHEN NOTHING WAS STAGED, AND THAT IS NOT A FALLBACK. An empty local file is
       * a legal transfer and this is the only shape it can arrive in: `chunkBytes` emits nothing
       * for an empty source, so `transferBridge.sendFile` sends ZERO chunks and then
       * `transferStart`. There is no "declare a total of 0" message on this protocol and none can
       * be added from this side, because `ChunkReassembler` refuses the empty chunk that would
       * carry it (`chunk 0 arrived after all 0 bytes`, since `complete()` is already true at
       * construction for a declared 0).
       *
       * SO "NOTHING STAGED" MEANS "EMPTY FILE" AND NOTHING ELSE -- which holds for THREE reasons
       * and needed all three. A refused chunk leaves its latched reassembler in place and is
       * caught by the guard above; a refused CONSTRUCTOR sets `poisoned`, also above; and a
       * refused START PUTS THE BYTES BACK, which is the clause below and the one this file
       * originally missed.
       *
       * THAT THIRD DOOR WAS THE SAME DATA-DESTRUCTION BUG AS THE SECOND, reached with entirely
       * well-formed messages. MEASURED 2026-10-07: stage a real 5-byte file, have `startTransfer`
       * refuse it (a locked keyboard is enough), then retry the same keywords -- and
       * `startTransfer` was called with ZERO bytes, no refusal sent, reported as success. Under
       * `Exist=replace` that overwrites the operator's host dataset with nothing. The honest
       * browser half re-chunks on every send so it could not trigger it, which is exactly what
       * would have made it a trap for whoever wired a retry button later.
       */
      const source = staged ?? new Uint8Array(0);
      staged = undefined;
      /** Put the bytes back, so a refused start is retryable instead of destructive. */
      const unconsume = (): void => { if (source.length > 0) staged = source; };

      let request;
      let command;
      try {
        // `transferCommand` THROWS -- `TransferOptionError` on an unknown, repeated, missing or
        // contradictory keyword (`frontend/src/transfer.ts:439-481`). The operator typed those
        // keywords, so they get the message; and this runs inside a socket 'data' handler, where
        // an escaping throw ends the gateway and every other operator's session.
        ({ request, command } = transferCommand(keywords));
      } catch (err) {
        // A MISTYPED HostFile IS THE COMMONEST OPERATOR ERROR, so this is the likeliest refusal
        // of all -- and the bytes must survive it or the retry sends an empty file.
        unconsume();
        fail(err instanceof Error ? err.message : String(err));
        return;
      }

      /**
       * What the host sent back, for a receive. Per RUN and not per connection.
       *
       * Held per connection, a second receive the host answered with nothing would re-send the
       * FIRST one's file and the operator would save a stale download under the new name.
       */
      let received: Uint8Array | undefined;
      generation += 1;
      const mine = generation;
      /** A placeholder, so a synchronous `onDone` finds a run to clear -- see `generation`. */
      run = { ok: true };

      const onDone = (result: { ok: boolean; error?: string; bytes?: number }): void => {
        // ONE ENDING PER RUN. `transferRun.ts`'s `finish` already guards this with `ended` and
        // says why (`:202-212`), so this is belt and braces over another package's invariant --
        // cheap here, where a second `transferDone` is not: the browser half would report the
        // outcome twice, and a second `transferData` burst would re-stage a file the operator had
        // already saved.
        if (mine !== generation) return;
        generation += 1;
        run = undefined;
        if (result.ok && received !== undefined) {
          // CHUNKED OUT THE WAY AN UPLOAD COMES IN, then terminated by `transferDone`. The order
          // is load-bearing: the browser stages on `transferData` and finishes on `transferDone`,
          // and Task 8's boot file calls `finishEmpty()` on a done that staged nothing -- so a
          // done sent FIRST would make every receive look empty and the real chunks would land
          // after the save.
          //
          // NO `transferData` ON A FAILURE, which is the condition above. A failed transfer's
          // partial capture is not a file, and `transferRun.ts` already refuses to report a
          // "complete" that is not the file (`:338-347`, `:404-413`); handing the browser a
          // partial download beside an `ok:false` would let a Save click write it anyway. A
          // failed receive really can have written -- the DFT arm calls `files.write` and only
          // then reports a failure if the write itself threw.
          //
          // AND NOTHING AT ALL FOR A ZERO-BYTE RECEIVE, which is the case no chunk can announce:
          // `chunkBytes` emits none for an empty source, and a gateway that helpfully sent one
          // EMPTY chunk is refused by the browser's reassembler with `chunk 0 arrived after all
          // 0 bytes`. The `transferDone` below is the whole announcement, and
          // `transferBridge.finishEmpty()` is the half that acts on it.
          for (const [seq, part] of chunkBytes(received).entries()) {
            // `total` IS THE WHOLE FILE'S LENGTH ON EVERY CHUNK, not this chunk's: it is what
            // `transferBridge.acceptData` hands `new ChunkReassembler(total)`, and that method
            // refuses a later chunk whose `total` disagrees with the first
            // (`transferBridge.ts:244-264`) -- where a per-chunk length would complete the
            // reassembler early and save a TRUNCATED file as a success.
            deps.send({ kind: 'transferData', seq, total: received.length, bytes: part });
          }
        }
        // BUILT EXPLICITLY RATHER THAN SPREAD, and `tsconfig.base.json`'s
        // `exactOptionalPropertyTypes` is why: `{...result}` is `{ok: boolean, ...}`, which
        // matches NEITHER arm of `transferDone` (`protocol.ts:41-42`), and `error` is REQUIRED on
        // the failure arm while the driver's result type has it optional. So a missing message
        // needs a placeholder -- an `ok:false` with no text is the one thing the browser cannot
        // render.
        deps.send(result.ok
          ? { kind: 'transferDone', ok: true, ...(result.bytes !== undefined ? { bytes: result.bytes } : {}) }
          : { kind: 'transferDone', ok: false, error: result.error ?? 'the transfer failed' });
      };

      const started = deps.startTransfer({
        session,
        /*
          THE WHOLE POINT OF THIS FEATURE, IN FOUR METHODS -- see the module header for why it is
          safe for them to be synchronous.

          `exists` ANSWERS FALSE, and that is a decision rather than a stub. `startTransfer`
          refuses a receive when `request.exist === 'keep' && files.exists(...)`
          (`transferRun.ts:110-114`), which is x3270's `Exist` check (ft.c:666-674). On this
          gateway there is no gateway-side file for that check to be ABOUT: the destination is the
          operator's machine, and their own save dialog is what asks about overwriting. Answering
          true would refuse every receive that did not pass `Exist=replace`, and `keep` is the
          default.

          `append` IS `write`. `Exist=append` makes the driver call it instead (`:335`, `:401`),
          and on a socket-carried transfer the two mean the same thing: the bytes go to the
          browser, and whether they are appended to anything is that save dialog's business. An
          `append` that did nothing would make `Exist=append` a receive that captured nothing and
          reported SUCCESS -- the empty-file-under-a-success-message failure `transferRun.ts`
          already records once (`:290-298`).

          THE PATH ARGUMENT IS IGNORED THROUGHOUT, which is honest: `request.localFile` is a name
          the operator typed for their own machine, and this side has no filesystem to resolve it
          against. It still travels, because the driver quotes it in its own messages.
        */
        files: {
          exists: () => false,
          read: () => source,
          write: (_path, bytes) => { received = bytes; },
          append: (_path, bytes) => { received = bytes; },
        },
        request,
        command,
        // RELAYED VERBATIM. Both emitters are `${n} bytes` -- `transferRun.ts:325` from
        // `dft.transferred` and `:394` from `cut.bytesTransferred` -- and reformatting here would
        // give the gateway a second opinion about what a transfer has moved.
        // GENERATION-GUARDED, LIKE `onDone`. The asymmetry was an oversight rather than a
        // decision: `onDone` carried a guard described as belt and braces over another package's
        // invariant, and the SAME invariant was the only thing protecting this callback.
        //
        // MEASURED 2026-10-07: after `discard()`, a stale `onProgress` still reached `deps.send`,
        // and a run-1 progress string landed on the socket while run 2 was live. Not reachable
        // through a real `startTransfer`, whose own `ended` flag stops it first
        // (`transferRun.ts:323`, `:370`) -- which is precisely why belt and braces is the stated
        // standard for the other one.
        onProgress: (text) => {
          if (mine !== generation) return;
          deps.send({ kind: 'transferProgress', text });
        },
        onDone,
      });

      // CONDITIONAL, and this is the generation guard doing its work: if `onDone` already fired
      // inside the call above, `run` is `undefined` and must STAY undefined. Overwriting it here
      // is the `transferWindow.ts` bug restated -- `already running` latched for the life of the
      // page.
      if (run !== undefined && mine === generation) run = started;

      if (!started.ok) {
        // `startTransfer` CAN REFUSE BEFORE THE HOST IS TOLD ANYTHING -- not in 3270 mode, a
        // locked keyboard, an unformatted screen, an input field too small, a local `Exist`
        // collision -- and `onDone` IS NEVER CALLED on that path (`transferRun.ts:80-83`). So the
        // refusal is reported HERE or it is lost, and the operator watches a form go quiet with
        // nothing in any console.
        //
        // `started.error` IS NOT NARROWED BY `!started.ok`, because `TransferRun` is
        // `{ok: boolean; error?: string; cancel?: ...}` and NOT a discriminated union
        // (`transferRun.ts:58-63`) -- verified 2026-10-07. Hence the `??`, which is the shape
        // `tui/src/app.ts:1095` and `gui/src/transferWindow.ts:342` both live with.
        // BEFORE `fail`, so a throwing `send` cannot lose the bytes on the way out.
        unconsume();
        fail(started.error ?? 'the transfer was refused');
        if (mine === generation) { generation += 1; run = undefined; }
      }
      // A FRAME IS OWED EITHER WAY, and the refusal case is the one worth stating: `primeAndType`
      // calls `k.eraseEOF()` and only THEN `k.typeString`, whose failure is a returned refusal
      // (`transferRun.ts:567-573`) -- so a refused start can leave the operator's field already
      // nulled. Repainting only on success would leave that erasure invisible until the host next
      // wrote. Below both paths, so neither can forget it. See `repaint`'s own measurement.
      deps.repaint();
    },

    cancel() {
      // NOTHING IS SENT. The browser asked for this, so it already knows; and the driver's own
      // `cancel` ends the run through `onDone` ("transfer canceled by user"), which is the
      // `transferDone` the browser gets. A second one from here would report one ending twice.
      reset();
    },

    discard() {
      /*
        THE DETACH PATH. `main.ts` calls this from `onClose`, and the CANCEL inside `reset` is the
        load-bearing half.

        A gateway `Session` OUTLIVES ITS SOCKET BY DESIGN (`--grace`), so a reload or a wifi
        handoff mid-transfer leaves the driver's three listeners and TWO TIMERS on a live session
        with nobody to report to -- and up to ten minutes later `totalTimer` fires `onDone` into a
        connection that is gone (`transferRun.ts:452-455`). `cancel` is also what TELLS THE HOST,
        which is the difference that file calls aborting rather than abandoning (`:462-474`): walk
        away from a CUT transfer and the host's program waits for a frame that never comes, so the
        reattaching operator finds their session wedged in transfer mode.

        THE STAGING CLEAR IS ABOUT PROMPTNESS AND NOT ABOUT ISOLATION, stated carefully because
        the obvious claim for it is false. It is NOT what stops a reattaching client inheriting a
        partial upload -- the per-connection closure does that structurally, since a reattach gets
        a new `Connection` and a new one of these objects and so could not reach the old buffers
        however this behaved. What it buys is releasing up to 10 MB at once instead of holding it
        until the whole handler closure becomes unreachable, which on a gateway serving 16 sessions
        is 160 MB of abandoned uploads waiting on a garbage collector.

        AND IT IS SILENT. `Connection.sendBinary` is already a no-op once closed
        (`wsserver.ts:58-61`), so a `transferDone` here would be harmless -- and it would also be
        a lie, since nobody is listening and the transfer did not finish.
      */
      reset();
    },
  };
}
