import { describe, it, expect } from 'vitest';
import type { Session } from '@tn3270/core';
import type { StartTransferOptions, TransferRun } from '@tn3270/frontend';
import type { ServerMessage } from '../src/protocol.js';
import { createGatewayTransfer } from '../src/transferGateway.js';
import { CHUNK_BYTES, MAX_TRANSFER_BYTES } from '../src/transferChunk.js';

/**
 * The gateway's transfer half, driven with an INJECTED `startTransfer`.
 *
 * ## WHY THIS SEAM EXISTS AT ALL, WHICH IS A MEASUREMENT AND NOT A PREFERENCE
 *
 * `integration.test.ts` cannot reach the interesting half. Every gateway in that suite runs under
 * `--replay`, and `Session.replay` builds its own local `TelnetLayer` rather than assigning
 * `this.telnet` (`core/src/session.ts:1626-1668`), so `is3270Mode()` is FALSE on a replayed
 * session -- MEASURED 2026-10-07 against all four fixture traces, every one of them
 * `is3270Mode false`. `startTransfer`'s very first guard is `if (!session.is3270Mode())`
 * (`transferRun.ts:90`), so a real `startTransfer` behind a real socket can only ever take its
 * EARLIEST refusal. The receive path, the progress relay, the chunk-out, the zero-byte receive and
 * the cancel are all unreachable there -- and therefore unmutatable there too.
 *
 * So the deps are injected, exactly as `transferBridge.ts` injects its browser capabilities and
 * for the same reason that file records: `vitest.config.ts` sets `environment: 'node'`, and
 * whatever cannot be had in-process is injected rather than reached for. `integration.test.ts`
 * then proves the WIRING over a real socket, which is the half only a socket can show.
 */

/** A `Session` is only ever handed through to the injected `startTransfer`, so a stub suffices. */
const fakeSession = (): Session => ({} as unknown as Session);

/**
 * Records what reached the socket, and captures the options `startTransfer` was handed.
 *
 * `opts` is the important half. The four-method in-memory `TransferFiles` is the whole point of
 * this feature, and the only way to assert that `read` hands back the operator's own bytes and
 * `write` captures what the host returned is to hold the object the driver was given and call it.
 */
function harness(run: TransferRun = { ok: true }, opt: {
  /**
   * Call `onDone` from INSIDE `startTransfer`, before it returns.
   *
   * NOT A CONTRIVANCE: a whole DFT transfer can begin and finish inside
   * `session.sendAID(AID.ENTER)`'s record handling, which `transferRun.ts:429-444` registers its
   * listeners before precisely so that works, and `tui/test/transferRun.test.ts` drives that case
   * against a real `Session`. This is the only way to reproduce it behind an injected driver, and
   * without it the generation guard in `start` is INERT TO MUTATION -- measured 2026-10-07:
   * replacing `if (run !== undefined && mine === generation) run = started;` with a bare
   * `run = started;` left all 306 cases in this package green.
   */
  readonly doneInside?: { ok: boolean; error?: string; bytes?: number };
} = {}) {
  const sent: ServerMessage[] = [];
  let opts: StartTransferOptions | undefined;
  let calls = 0;
  let repaints = 0;
  const gw = createGatewayTransfer({
    send: (msg) => { sent.push(msg); },
    repaint: () => { repaints += 1; },
    startTransfer: (o) => {
      calls += 1;
      opts = o;
      if (opt.doneInside !== undefined) o.onDone(opt.doneInside);
      return run;
    },
  });
  return {
    gw, sent,
    get opts(): StartTransferOptions {
      if (opts === undefined) throw new Error('startTransfer was never called');
      return opts;
    },
    get calls(): number { return calls; },
    get repaints(): number { return repaints; },
    kinds: (): string[] => sent.map((m) => m.kind),
    /** Stage `bytes` as a well-formed chunk stream, the way `transferBridge.sendFile` does. */
    stage(bytes: Uint8Array): void {
      for (let at = 0, seq = 0; at < bytes.length; at += CHUNK_BYTES, seq += 1) {
        gw.chunk(seq, bytes.length, bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length)));
      }
    },
  };
}

const SEND = ['Direction=send', 'LocalFile=local.txt', 'HostFile=HOST.FILE'] as const;
const RECEIVE = ['Direction=receive', 'LocalFile=local.txt', 'HostFile=HOST.FILE'] as const;

/** The failure arm of `transferDone`, narrowed so `error` is a `string` rather than asserted. */
function failure(msg: ServerMessage): string {
  if (msg.kind !== 'transferDone') throw new Error(`expected transferDone, got ${msg.kind}`);
  if (msg.ok) throw new Error('expected the failure arm of transferDone');
  return msg.error;
}

describe('staging the operator\'s bytes', () => {
  it('stages a whole file and hands it to startTransfer as the source', () => {
    const h = harness();
    const file = new Uint8Array([1, 2, 3, 4, 5]);
    h.stage(file);
    // NOTHING IS SENT FOR A GOOD CHUNK, and the silence is an assertion rather than an absence of
    // one: a per-chunk acknowledgement would be a message the browser half must learn to ignore,
    // and `transferBridge.sendFile` sends every chunk and then `transferStart` without waiting
    // for any reply at all (`transferBridge.ts:213-227`).
    expect(h.kinds()).toEqual([]);
    h.gw.start(SEND, fakeSession());
    // THE WHOLE POINT OF THE FEATURE, asserted through the object the driver was handed: `read`
    // returns what crossed the socket, so "local file" means the operator's machine and nothing
    // touches the gateway's disk.
    expect(h.opts.files.read('local.txt')).toEqual(file);
  });

  it('spans more than one chunk, so the reassembly is real rather than a single-chunk pass', () => {
    const h = harness();
    // 1.5 chunks: the join is exercised, and the LAST chunk is short by design -- which is the one
    // length no shortfall check may refuse.
    const file = new Uint8Array(CHUNK_BYTES + CHUNK_BYTES / 2);
    for (let i = 0; i < file.length; i += 1) file[i] = i & 0xff;
    h.stage(file);
    h.gw.start(SEND, fakeSession());
    expect(h.opts.files.read('local.txt')).toEqual(file);
  });

  it('refuses a declared total over the 10 MB cap, reporting the constructor\'s throw', () => {
    // `ChunkReassembler`'s CONSTRUCTOR is where that cap lives, and it THROWS
    // (`transferChunk.ts:108-115`). Unhandled, that is an exception out of a socket 'data'
    // handler -- which `wsserver.ts:30-34` records as ending the PROCESS and taking every other
    // operator's session with it.
    const h = harness();
    h.gw.chunk(0, MAX_TRANSFER_BYTES + 1, new Uint8Array([1]));
    expect(failure(h.sent[0]!)).toMatch(/exceeds the 10485760-byte limit/);
  });

  it('refuses the START after an over-cap chunk, rather than sending an EMPTY file', () => {
    /*
      A DEFECT IN THE FIRST VERSION OF THIS MODULE, FOUND BY SELF-REVIEW AND MEASURED 2026-10-07.

      A refusal from `ChunkReassembler`'s CONSTRUCTOR is different in kind from one from `accept`,
      and the difference is exactly the thing the latch exists to protect. `accept` leaves a
      LATCHED OBJECT behind, so `start` sees `staging !== undefined` and refuses. A throwing
      constructor assigns NOTHING -- `staging ??= new ChunkReassembler(total)` never completes --
      so `staging` stays `undefined`, which this module reads as "nothing was ever staged" and
      treats as the legal zero-byte upload.

      MEASURED against the built `dist`: refuse a 20 MB declared total, then `transferStart`, and
      `startTransfer` WAS CALLED with a zero-length source. The operator asks to send a 20 MB file,
      is correctly told it is too large, and the gateway then uploads an EMPTY FILE to their host
      dataset -- under `Exist=replace`, DESTROYING it -- and reports success. That is the
      empty-file-under-a-success-message failure this repo has a standing rule about, reached by
      the one door the latch does not cover.

      So a construction refusal POISONS the connection's staging explicitly. The same applies to
      the non-integer total the same constructor throws on.
    */
    const h = harness();
    h.gw.chunk(0, MAX_TRANSFER_BYTES + 1, new Uint8Array([1]));
    expect(failure(h.sent[0]!)).toMatch(/exceeds the 10485760-byte limit/);
    h.gw.start(SEND, fakeSession());
    expect(h.calls, 'an over-cap refusal must not be followed by an empty transfer').toBe(0);
    expect(failure(h.sent[1]!)).toMatch(/refused/);
  });

  it('refuses the START after a chunk whose declared total was not an integer', () => {
    // The constructor's OTHER throw (`transferChunk.ts:105-107`), which `protocol.ts` cannot
    // pre-empt: it bounds `total` as a non-negative integer but deliberately leaves the RANGE to
    // that constructor, so `Infinity` arrives here as a number that passes decode. Same poisoning,
    // same reason -- the throw stages nothing, and nothing staged would mean an empty upload.
    const h = harness();
    h.gw.chunk(0, Number.POSITIVE_INFINITY, new Uint8Array([1]));
    expect(failure(h.sent[0]!)).toMatch(/non-negative integer/);
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(0);
  });

  it('clears the poison on cancel, so a refused upload does not disable the connection', () => {
    // The poison must be as resettable as the staging it stands in for, or an operator who picked
    // too large a file once is refused for the life of the socket -- which on this gateway means
    // until they reload and lose their 3270 session's window.
    const h = harness();
    h.gw.chunk(0, MAX_TRANSFER_BYTES + 1, new Uint8Array([1]));
    h.gw.cancel();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(1);
    expect(h.opts.files.read('local.txt')).toEqual(new Uint8Array([1, 2]));
  });

  it('refuses a chunk out of sequence', () => {
    const h = harness();
    h.gw.chunk(0, 4, new Uint8Array([1, 2]));
    h.gw.chunk(9, 4, new Uint8Array([3, 4]));
    expect(failure(h.sent[0]!)).toMatch(/out of sequence, expected 1/);
  });

  it('refuses a chunk whose bytes overrun the declared total', () => {
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2, 3, 4]));
    expect(failure(h.sent[0]!)).toMatch(/exceeds declared total/);
  });

  it('refuses every later chunk once one has been refused, rather than silently restarting', () => {
    /*
      `ChunkReassembler` LATCHES, for the reason its own docstring gives: "a half-rejected
      reassembler that still completes is a corrupt file delivered as a success". THAT LATCH LIVES
      IN THE OBJECT, so dropping the object on a refusal UNDOES IT -- the next chunk 0 builds a
      fresh reassembler and is in sequence again, and the operator uploads a file missing every
      chunk that was dropped in between.

      THE DRAFT OF THIS TASK SET `staging = undefined` ON THE REFUSAL PATH, which is exactly that
      bug; `transferBridge.ts:153-162` records the first draft of the BROWSER half making the same
      mistake. Here it is worse than there, because `start` distinguishes "nothing was ever staged"
      (a legal zero-byte upload, below) from "staging exists and is not complete" -- so a cleared
      reassembler would turn a refused upload into an EMPTY one reported as a success.
    */
    const h = harness();
    h.gw.chunk(0, 4, new Uint8Array([1, 2]));
    h.gw.chunk(9, 4, new Uint8Array([3, 4]));             // refused, and latches
    h.gw.chunk(1, 4, new Uint8Array([3, 4]));             // the chunk that WOULD have completed it
    expect(failure(h.sent[1]!)).toMatch(/already abandoned by an earlier bad chunk/);
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(0);
    expect(failure(h.sent[2]!)).toMatch(/incomplete/);
  });
});

describe('starting the run', () => {
  /*
    THE SHORT-CHUNK STALL IS CLOSED HERE, AT `transferStart`, AND THIS IS THE WHOLE OF THE FIX.

    `Buffer.from(s, 'base64')` IS LENIENT -- MEASURED 2026-10-07 on node 26: `'!!!!'` decodes to
    0 bytes, `'AQ!ID'` silently drops the `!` and yields the same three bytes as `'AQID'`, and
    deleting ANY ONE character from an 8-character encoding of 6 bytes yields 5 bytes rather than
    an error. `ChunkReassembler` refuses OVERRUNS only, so a short chunk leaves it merely
    INCOMPLETE and no refusal is owed at that moment -- a short chunk and a chunk with more to
    follow are indistinguishable until the sender says it has finished.

    `transferStart` IS WHEN THE SENDER SAYS SO, and it is unconditional: `transferBridge.sendFile`
    sends every chunk and then `transferStart` whatever happened, "Sent even when there are no
    chunks" (`transferBridge.ts:222-226`). So it is both the EARLIEST point at which short is
    distinguishable from unfinished and a point that always arrives.

    WHY NOT VALIDATE THE BASE64 AT DECODE, which was the other option offered: a decode throw in
    `protocol.ts` is answered as an `error` frame and reaches this module NOT AT ALL, so the chunk
    would leave no trace here -- and the `transferStart` that followed would find nothing staged,
    which is the legal zero-byte upload below. A damaged 6-byte upload would become a SUCCESSFUL
    EMPTY one. Strict validation would have to be paired with poisoning state this module owns,
    which is two mechanisms where the shortfall check is one.

    WHY NOT BOUND THE WAIT: a timer would invent a deadline for a transfer nobody has asked to
    start yet, and `transferRun.ts`'s module header already gives this project's rule for inferred
    deadlines. A client that sends chunks and never a `transferStart` holds memory bounded by the
    10 MB cap until its socket closes and starts nothing -- no progress line, so nothing to stall.
  */
  it('refuses a start whose staged bytes fell SHORT, quoting both numbers', () => {
    const h = harness();
    // A 6-byte file whose only chunk decoded to 5 -- the lenient-base64 shape measured above.
    h.gw.chunk(0, 6, new Uint8Array([1, 2, 3, 4, 5]));
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(0);
    // BOTH NUMBERS, because "incomplete" alone does not tell an operator whether to retry or to
    // suspect their file: 5 of 6 is a damaged chunk, 2 of 99 is a transfer that never ran.
    expect(failure(h.sent[0]!)).toMatch(/incomplete: 5 of 6 bytes/);
  });

  it('refuses a start before the declared bytes have all arrived', () => {
    const h = harness();
    h.gw.chunk(0, 99, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(0);
    expect(failure(h.sent[0]!)).toMatch(/incomplete: 2 of 99 bytes/);
  });

  it('accepts a zero-byte SEND, which is a start with no chunks at all', () => {
    /*
      AN EMPTY LOCAL FILE IS A LEGAL TRANSFER, and this is the only shape it can arrive in.
      `chunkBytes` emits nothing for an empty source, so `transferBridge.sendFile` sends ZERO
      `transferChunk` messages and then `transferStart` -- its own comment says so in as many
      words. There is no "declare a total of 0" message on this protocol and none can be added
      from this side: `ChunkReassembler` would refuse the empty chunk that carried it with
      `chunk 0 arrived after all 0 bytes`, because `complete()` is TRUE AT CONSTRUCTION for a
      declared 0 (`transferChunk.ts:118-127`).

      SO "NOTHING WAS EVER STAGED" MEANS "EMPTY FILE" AND NOTHING ELSE, which only holds because
      a refused chunk LEAVES ITS LATCHED REASSEMBLER IN PLACE -- see the latch case above. That is
      what makes this acceptance safe rather than a hole.
    */
    const h = harness();
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(1);
    expect(h.opts.files.read('local.txt')).toEqual(new Uint8Array(0));
  });

  it('reports transferCommand\'s throw rather than letting it reach the socket handler', () => {
    // The operator typed these keywords, so they get the message. `transferCommand` ->
    // `parseTransferKeywords` throws `TransferOptionError` on an unknown or repeated or missing
    // one (`frontend/src/transfer.ts:439-481`), and this runs inside a socket 'data' handler
    // where an escaping throw ends the gateway process.
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(['Direction=send', 'Nonsense=1'], fakeSession());
    expect(h.calls).toBe(0);
    expect(failure(h.sent[0]!)).toMatch(/unknown option 'Nonsense'/);
  });

  it('reports a MISSING LocalFile, which is the commonest keyword fault', () => {
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(['Direction=send'], fakeSession());
    expect(failure(h.sent[0]!)).toMatch(/missing 'LocalFile'/);
  });

  it('reports startTransfer\'s own early refusal, which never reaches onDone', () => {
    // `startTransfer` returns `{ok:false, error}` for everything checkable locally -- not in 3270
    // mode, a locked keyboard, an unformatted screen, an input field too small -- and `onDone` is
    // NEVER CALLED on that path (`transferRun.ts:80-83`). So the refusal is reported at the CALL
    // SITE or the operator watches a form go quiet with nothing in any console.
    //
    // AND IT IS THE ONLY ARM A REPLAYED GATEWAY CAN TAKE, which is why `integration.test.ts`
    // covers this one over a real socket and this file covers the rest.
    const h = harness({ ok: false, error: 'not in 3270 mode' });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(1);
    expect(failure(h.sent[0]!)).toBe('not in 3270 mode');
  });

  it('repaints after a run starts, because priming the field TYPED into the screen', () => {
    // MEASURED 2026-10-07 on a replayed session: `k.home()`, `k.eraseEOF()` and
    // `k.typeString(...)` -- which is the whole of `primeAndType` (`transferRun.ts:524-575`) --
    // changed the screen buffer and emitted ZERO `screen` events. So this socket's three session
    // listeners see nothing, and the browser would show a screen WITHOUT the IND$FILE command on
    // it until the host next spoke. That is exactly the measurement `main.ts`'s action path
    // already carries for a local action, arriving by a second door.
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    expect(h.repaints).toBe(1);
  });

  it('repaints after an early REFUSAL too, because eraseEOF runs before the refusal can', () => {
    // NOT SYMMETRY FOR ITS OWN SAKE. `primeAndType` calls `k.eraseEOF()` and only THEN
    // `k.typeString`, whose failure is a RETURNED refusal (`transferRun.ts:567-573`) -- so a
    // refused start can leave the operator's field already nulled. Repainting only on success
    // would leave that erasure invisible until the host next wrote.
    const h = harness({ ok: false, error: 'input inhibited while typing the command (X SYSTEM)' });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    expect(h.repaints).toBe(1);
  });

  it('does not repaint when the start never reached startTransfer', () => {
    // A keyword fault and a short staging both refuse BEFORE `primeAndType` can touch the screen,
    // so no frame is owed. Asserting this is what keeps the repaint above a statement about
    // TYPING rather than an unconditional one.
    const h = harness();
    h.gw.chunk(0, 99, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.gw.start(['Direction=send', 'Nonsense=1'], fakeSession());
    expect(h.repaints).toBe(0);
  });

  it('consumes the staged bytes, so a later start cannot resend them', () => {
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.opts.onDone({ ok: true, bytes: 2 });                // the first run is over
    h.gw.start(SEND, fakeSession());
    // A SECOND START IS ACCEPTED -- it is the legal zero-byte upload -- but it must NOT carry the
    // first one's bytes. Resending them would upload a file the operator never chose twice, and
    // under `Exist=replace` the second one would overwrite the host dataset.
    expect(h.calls).toBe(2);
    expect(h.opts.files.read('local.txt')).toEqual(new Uint8Array(0));
  });

  it('refuses a second start while a run is still live, rather than typing over it', () => {
    // `startTransfer` types a command into the screen and registers three session listeners plus
    // two timers. A second one on the same session would type over a transfer in flight and leave
    // two drivers racing for the same frames -- and this module holds ONE `run`, so the first
    // one's `cancel` would be lost and that transfer could never be stopped at all.
    const h = harness({ ok: true, cancel: () => { /* a live run */ } });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.gw.chunk(0, 2, new Uint8Array([3, 4]));
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(1);
    expect(failure(h.sent[h.sent.length - 1]!)).toMatch(/already running/);
  });

  it('is startable again after a run that completed INSIDE startTransfer', () => {
    /*
      `startTransfer` CAN CALL `onDone` BEFORE IT RETURNS. A whole DFT transfer can begin and
      finish inside `session.sendAID(AID.ENTER)`'s record handling -- the listeners are registered
      before that send precisely so it works (`transferRun.ts:429-444`) -- and the next statement
      is `if (ended) return { ok: true };` (`:449`), a run with NO `cancel` because there is
      nothing left to cancel. `gui/src/transferWindow.ts:183-204` records the same hazard and the
      bug it caused there: the assignment AFTER the call armed a flag on a transfer that had
      already ended, and the window then refused every close for the rest of its life.

      HERE THE SAME MISTAKE LATCHES "already running" FOREVER -- the operator's next transfer is
      refused, and every one after it, with no way back short of reloading the page. The guard is
      a generation stamp: the assignment afterwards is conditional on the run still being the one
      this call started.
    */
    // `doneInside` CALLS `onDone` FROM INSIDE THE DRIVER, which is what makes this the real
    // ordering rather than a simulation of it: `onDone` runs, then `start` reaches its assignment.
    // Driving `onDone` after `start` returned would exercise the ordinary path and leave the guard
    // inert -- which it measurably was until this option existed.
    const h = harness({ ok: true }, { doneInside: { ok: true, bytes: 2 } });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    // THE OUTCOME STILL ARRIVES, which is the half that would pass either way -- `onDone` sends it
    // before the assignment can go wrong.
    expect(h.kinds()).toEqual(['transferDone']);
    // AND THE NEXT TRANSFER IS STILL POSSIBLE, which is the half the guard protects. Without it
    // the ended run is reinstated as live and every later start is refused `already running`, for
    // the life of the page.
    h.gw.start(SEND, fakeSession());
    expect(h.calls, 'a run that ended inside startTransfer must not latch "already running"')
      .toBe(2);
  });

  it('is CANCELLABLE after a run that completed inside startTransfer, without throwing', () => {
    // The other side of the same guard: the reinstated run would be `{ok:true}` with no `cancel`
    // on the synchronous path (`transferRun.ts:449`), so a `cancel` arriving afterwards would hit
    // an object whose transfer is over. Inert either way thanks to `run?.cancel?.()`, and asserted
    // so the optional chain cannot be tidied away on the grounds that nothing exercises it.
    const h = harness({ ok: true }, { doneInside: { ok: true, bytes: 2 } });
    h.gw.start(SEND, fakeSession());
    expect(() => { h.gw.cancel(); }).not.toThrow();
  });

  it('hands the driver the command transferCommand built, not the raw keywords', () => {
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start([...SEND, 'Host=vm'], fakeSession());
    expect(h.opts.command).toBe('IND$FILE PUT HOST.FILE (');
    expect(h.opts.request.direction).toBe('send');
    expect(h.opts.request.localFile).toBe('local.txt');
  });

  it('answers exists() with false, because the gateway has no local file to collide with', () => {
    // `startTransfer` refuses a receive when `request.exist === 'keep' && files.exists(...)`
    // (`transferRun.ts:110-114`), which is x3270's `Exist` check. On this gateway there is no
    // gateway-side file for that check to be ABOUT: the destination is the operator's machine,
    // and their own save dialog is what asks about overwriting. Answering true here would refuse
    // every receive that did not pass `Exist=replace`, which is the default.
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    expect(h.opts.files.exists('local.txt')).toBe(false);
  });
});

describe('relaying the run', () => {
  it('relays every progress string the driver emits, verbatim', () => {
    // `transferRun.ts:325` and `:394` both emit `${n} bytes` -- one from `dft.transferred`, one
    // from `cut.bytesTransferred`. VERIFIED 2026-10-07 by reading both call sites. Relayed as-is
    // rather than reformatted, so the gateway holds no second opinion about what a transfer moved.
    const h = harness();
    h.gw.start(SEND, fakeSession());
    h.opts.onProgress('512 bytes');
    h.opts.onProgress('1024 bytes');
    expect(h.sent).toEqual([
      { kind: 'transferProgress', text: '512 bytes' },
      { kind: 'transferProgress', text: '1024 bytes' },
    ]);
  });

  it('reports a successful SEND with its byte count and no data', () => {
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.opts.onDone({ ok: true, bytes: 2 });
    expect(h.sent).toEqual([{ kind: 'transferDone', ok: true, bytes: 2 }]);
  });

  it('reports a successful run that gave NO byte count, without inventing one', () => {
    // `onDone`'s result type has `bytes?: number` and `finish` always supplies it
    // (`transferRun.ts:241`) -- but the TYPE allows absence, and `exactOptionalPropertyTypes`
    // makes `bytes: undefined` a different thing from an absent `bytes`. Spreading the result
    // into the message would send `"bytes":undefined`, which `JSON.stringify` drops anyway; the
    // point is that the two arms of `transferDone` are built explicitly rather than spread, so
    // this compiles at all.
    const h = harness();
    h.gw.start(SEND, fakeSession());
    h.opts.onDone({ ok: true });
    expect(h.sent).toEqual([{ kind: 'transferDone', ok: true }]);
  });

  it('reports a failed run with the driver\'s own error text', () => {
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.opts.onDone({ ok: false, error: 'press Attn or Clear: host may still be transferring' });
    expect(failure(h.sent[0]!)).toMatch(/press Attn or Clear/);
  });

  it('reports a failure that carried NO error text, rather than sending undefined', () => {
    // Same `exactOptionalPropertyTypes` reason as the success arm above, with teeth: the failure
    // arm of `transferDone` declares `error: string` REQUIRED (`protocol.ts:42`), so an absent
    // `error` on the driver's result has to become something. A placeholder, because an `ok:false`
    // with no message at all is the one thing the browser cannot render.
    const h = harness();
    h.gw.start(SEND, fakeSession());
    h.opts.onDone({ ok: false });
    expect(failure(h.sent[0]!)).toMatch(/failed/);
  });

  it('chunks a received file back out as transferData, then terminates it with transferDone', () => {
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    const host = new Uint8Array(CHUNK_BYTES + 3);
    for (let i = 0; i < host.length; i += 1) host[i] = (i * 7) & 0xff;
    // THE HOST'S BYTES ARRIVE THROUGH `files.write`, which is the capture half of the four-method
    // `TransferFiles`: nothing touched the gateway's disk on the way.
    h.opts.files.write('local.txt', host);
    h.opts.onDone({ ok: true, bytes: host.length });

    expect(h.kinds()).toEqual(['transferData', 'transferData', 'transferDone']);
    const parts = h.sent.filter((m) => m.kind === 'transferData');
    // `total` IS THE WHOLE FILE'S LENGTH ON EVERY CHUNK, not this chunk's: it is what
    // `transferBridge.acceptData` hands `new ChunkReassembler(total)`, and that method REFUSES a
    // later chunk whose `total` disagrees with the first (`transferBridge.ts:244-264`), where a
    // per-chunk length would truncate the download and save it as a success.
    expect(parts.map((m) => (m as { total: number }).total)).toEqual([host.length, host.length]);
    expect(parts.map((m) => (m as { seq: number }).seq)).toEqual([0, 1]);
    const joined = new Uint8Array(host.length);
    let at = 0;
    for (const p of parts) {
      const b = (p as { bytes: Uint8Array }).bytes;
      joined.set(b, at); at += b.length;
    }
    expect(joined).toEqual(host);
  });

  it('sends the data BEFORE the done, because the done is what terminates the stream', () => {
    // The browser half stages on `transferData` and finishes on `transferDone`, and Task 8's boot
    // file calls `finishEmpty()` on a done that staged nothing. A done that arrived FIRST would
    // make every receive look empty, and the real chunks would then arrive after the save.
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    h.opts.files.write('local.txt', new Uint8Array([9, 9, 9]));
    h.opts.onDone({ ok: true, bytes: 3 });
    expect(h.kinds().indexOf('transferData')).toBeLessThan(h.kinds().indexOf('transferDone'));
  });

  it('announces a ZERO-BYTE receive with transferDone and NO transferData at all', () => {
    /*
      THE CASE NO CHUNK CAN ANNOUNCE, and both doors were measured shut before this.

      `chunkBytes` emits nothing for an empty source, so there is no `transferData` to carry the
      news. And a gateway that helpfully sent ONE EMPTY CHUNK is refused by the browser's own
      reassembler with `chunk 0 arrived after all 0 bytes` -- `ChunkReassembler.accept`'s first
      length check, since `complete()` is already true at construction for a declared 0. So the
      only correct gateway behaviour is the NEGATIVE one asserted here: send the done, invent no
      chunk. `transferBridge.finishEmpty()` is the browser half, added in Task 5 for exactly this,
      and it fires on a successful done that staged nothing -- which is what this produces.
    */
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    h.opts.files.write('local.txt', new Uint8Array(0));
    h.opts.onDone({ ok: true, bytes: 0 });
    expect(h.sent).toEqual([{ kind: 'transferDone', ok: true, bytes: 0 }]);
  });

  it('sends NO transferData for a receive that FAILED, however many bytes it captured', () => {
    // A failed transfer's partial capture is not a file. `transferRun.ts` already refuses to
    // report a "complete" that is not the file (`:338-347` for DFT, `:404-413` for CUT), and
    // handing the browser a partial download beside an `ok:false` would let a Save click write it
    // anyway -- the same outcome arriving by a different door.
    //
    // A FAILED RECEIVE CAN REALLY HAVE WRITTEN: `transferRun.ts:332-347` calls `files.write`
    // first and only reports the failure if the write itself threw, so a capture followed by a
    // failure is not a contrived combination.
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    h.opts.files.write('local.txt', new Uint8Array([1, 2, 3]));
    h.opts.onDone({ ok: false, error: 'transfer canceled by user' });
    expect(h.kinds()).toEqual(['transferDone']);
  });

  it('treats append as write, because there is no gateway-side file to append to', () => {
    // `Exist=append` makes `transferRun.ts:335`/`:401` call `files.append` instead of
    // `files.write`. On a socket-carried transfer both mean the same thing: the bytes go to the
    // browser, and whether they are appended to anything is that save dialog's business. A
    // `TransferFiles` whose `append` did nothing would make `Exist=append` a receive that
    // captured nothing and reported SUCCESS -- the empty-file-under-a-success-message failure
    // `transferRun.ts:290-298` already records once.
    const h = harness();
    h.gw.start([...RECEIVE, 'Exist=append'], fakeSession());
    expect(h.opts.request.exist).toBe('append');
    h.opts.files.append('local.txt', new Uint8Array([4, 5]));
    h.opts.onDone({ ok: true, bytes: 2 });
    expect(h.kinds()).toEqual(['transferData', 'transferDone']);
    expect((h.sent[0] as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([4, 5]));
  });

  it('does not carry one run\'s received bytes into the next', () => {
    // The capture is per RUN and not per connection. Held per connection, a second receive that
    // the host answered with nothing would re-send the FIRST one's file and the operator would
    // save a stale download under the new name.
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    h.opts.files.write('local.txt', new Uint8Array([1, 2, 3]));
    h.opts.onDone({ ok: true, bytes: 3 });
    h.sent.length = 0;
    h.gw.start(RECEIVE, fakeSession());
    h.opts.onDone({ ok: true, bytes: 0 });
    expect(h.kinds()).toEqual(['transferDone']);
  });

  it('ignores a SECOND onDone for the same run, so one transfer ends once', () => {
    // `transferRun.ts`'s `finish` already guards this with `ended` and says why (`:202-212`), so
    // this is belt and braces over another package's invariant -- and it is cheap, where a second
    // `transferDone` is not: the browser half would report the outcome twice, and a second
    // `transferData` burst would re-stage a file the operator had already saved.
    const h = harness();
    h.gw.start(RECEIVE, fakeSession());
    h.opts.files.write('local.txt', new Uint8Array([7]));
    h.opts.onDone({ ok: true, bytes: 1 });
    h.opts.onDone({ ok: true, bytes: 1 });
    expect(h.kinds()).toEqual(['transferData', 'transferDone']);
  });
});

describe('cancel and detach', () => {
  it('cancels a live run and clears it', () => {
    let canceled = 0;
    const h = harness({ ok: true, cancel: () => { canceled += 1; } });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.gw.cancel();
    expect(canceled).toBe(1);
    // CLEARED, so a second cancel puts no second PF2 on the wire -- the same reason the TUI clears
    // `transferRun` before drawing (`tui/src/app.ts:1088-1091`). `CutTransfer.cancel` is itself
    // idempotent and `transferRun.ts`'s `ended` guard means we do not rely on that.
    h.gw.cancel();
    expect(canceled).toBe(1);
  });

  it('survives a run that has no cancel, which is what a synchronous completion returns', () => {
    // `startTransfer` returns a BARE `{ok:true}` with NO `cancel` when the transfer already
    // finished inside the call (`transferRun.ts:449`). `TransferRun.cancel` is optional for
    // exactly that case (`:61-62`, "Absent when the run never started"), so an unguarded
    // `run.cancel()` is a `TypeError` out of a socket 'data' handler -- which ends the process.
    const h = harness({ ok: true });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    expect(() => { h.gw.cancel(); }).not.toThrow();
  });

  it('is inert with no run at all, and sends nothing', () => {
    // A `transferCancel` can arrive with nothing running: the browser's overlay sends one when
    // the operator closes a form that never started, and `transferBridge.cancel()` sends it
    // unconditionally (`transferBridge.ts:331-340`).
    const h = harness();
    h.gw.cancel();
    expect(h.sent).toEqual([]);
  });

  it('drops staging as well as the run, so a cancelled upload is not resumable', () => {
    // Leaving the staged bytes would let the NEXT `transferStart` -- a different file, a different
    // direction -- upload the file the operator just abandoned.
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.cancel();
    h.gw.start(SEND, fakeSession());
    expect(h.opts.files.read('local.txt')).toEqual(new Uint8Array(0));
  });

  it('drops an INCOMPLETE staging on cancel too, so the next start is not refused forever', () => {
    // The other half of the same clear, and it is the half a latch would break: a cancelled
    // half-upload whose reassembler survived would make every later `transferStart` on this
    // connection refuse as `incomplete`, for the life of the socket.
    const h = harness();
    h.gw.chunk(0, 99, new Uint8Array([1, 2]));
    h.gw.cancel();
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(1);
  });

  it('lets a NEW run start after a cancel, rather than latching "already running"', () => {
    const h = harness({ ok: true, cancel: () => { /* a live run */ } });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.gw.cancel();
    h.gw.chunk(0, 2, new Uint8Array([3, 4]));
    h.gw.start(SEND, fakeSession());
    expect(h.calls).toBe(2);
  });

  it('cancels a live run on discard, so a dropped socket does not leave a host mid-transfer', () => {
    /*
      THE DETACH PATH, AND THE CANCEL IS THE LOAD-BEARING HALF OF IT.

      A gateway `Session` OUTLIVES ITS SOCKET BY DESIGN (`--grace`), so a reload or a wifi handoff
      mid-transfer leaves the driver's three listeners and TWO TIMERS on a live session with
      nobody to report to -- and up to ten minutes later `totalTimer` fires `onDone` into a
      connection that is gone (`transferRun.ts:452-455`). `cancel` is also what TELLS THE HOST,
      which is the difference that file calls aborting rather than abandoning (`:462-474`): walk
      away from a CUT transfer and the host's program waits for a frame that never comes, and the
      reattaching operator finds a session wedged in transfer mode.
    */
    let canceled = 0;
    const h = harness({ ok: true, cancel: () => { canceled += 1; } });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.gw.discard();
    expect(canceled).toBe(1);
  });

  it('sends nothing on discard, because the socket is already gone', () => {
    // `Connection.sendBinary` is a no-op once closed (`wsserver.ts:58-61`), so a `transferDone`
    // here would be harmless -- and it would also be a lie, since nobody is listening and the
    // transfer did not finish. The detach path is silent on purpose.
    const h = harness({ ok: true, cancel: () => { /* a live run */ } });
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));
    h.gw.start(SEND, fakeSession());
    h.sent.length = 0;
    h.gw.discard();
    expect(h.sent).toEqual([]);
  });

  it('ignores a run\'s onDone that arrives AFTER discard, rather than writing to a dead socket', () => {
    /*
      THE STALE-ENDING GUARD, and `reset` bumping the generation is what provides it.

      TODAY THIS IS DEFENSE IN DEPTH OVER ANOTHER PACKAGE'S INVARIANT, stated plainly because the
      case for keeping it rests on that: `transferRun.ts`'s `cancel` always reaches `finish`, and
      `finish`'s own `ended` flag then refuses a second ending (`:202-212`) -- so a correct
      `TransferRun` cannot deliver an `onDone` after its `cancel` has been called, and this is
      measurably inert against the real driver. `gui/src/transferWindow.ts:224-252` makes the same
      argument at length for its own placeholder restore, and reaches the same answer.

      WHY IT IS KEPT RATHER THAN DELETED AS DECORATION, which is the rule `transferRun.ts:434-440`
      applies in the other direction: that deletion was of a condition that was UNFALSIFIABLY
      FALSE within its own file. This one is falsifiable from here, and what it pins is THIS
      module's contract rather than the driver's -- an ending reported after `discard` would send a
      `transferDone` plus a whole `transferData` burst for a connection that has closed, on a
      session the NEXT client reattaches to. The argument for inertness is an audit of a different
      package, and it has to be redone from scratch every time that package changes; this makes it
      structural instead.

      THE `cancel` BELOW IS A NO-OP ON PURPOSE -- it is the shape of a driver whose `cancel` does
      not end the run, which is the only thing this module can actually be sure of about an
      injected dependency.
    */
    const h = harness({ ok: true, cancel: () => { /* a cancel that does not end the run */ } });
    h.gw.start(RECEIVE, fakeSession());
    h.opts.files.write('local.txt', new Uint8Array([1, 2, 3]));
    h.sent.length = 0;
    h.gw.discard();
    h.opts.onDone({ ok: true, bytes: 3 });
    expect(h.sent, 'a run ending after discard must report nothing').toEqual([]);
  });

  it('drops the staged bytes on discard, releasing up to 10 MB at once', () => {
    /*
      WHAT THIS IS AND IS NOT, stated carefully because the obvious claim for it is FALSE.

      It is NOT what stops a reattaching client inheriting a partial upload. THE PER-CONNECTION
      CLOSURE is what does that, structurally: `main.ts` builds one of these objects per upgraded
      socket, so a reattach to the same session id gets a brand-new one and could not reach the old
      buffers however this method behaved. A `discard` that cleared nothing would be invisible to
      any client.

      WHAT IT BUYS IS PROMPTNESS, and the number makes it worth three lines: the cap this module
      enforces is 10 MB, and without this the staged copy is held until the whole `Connection` and
      its handler closure become unreachable -- which on a gateway serving 16 sessions is 160 MB of
      abandoned uploads waiting on a garbage collector.

      SO THE ASSERTION BELOW IS REACHABLE ONLY FROM THIS TEST, deliberately: over a real socket
      nothing can call `start` after `discard`, because `discard` runs from `onClose`. It pins the
      intent rather than a reachable bug, which is the honest description of a promptness clear.
    */
    const h = harness();
    h.gw.chunk(0, 2, new Uint8Array([1, 2]));             // COMPLETE, so this is the worst case
    h.gw.discard();
    h.gw.start(SEND, fakeSession());
    expect(h.opts.files.read('local.txt')).toEqual(new Uint8Array(0));
  });
});

describe('a refused start must leave the file retryable, not consume it', () => {
  it('puts the bytes BACK when startTransfer refuses, so a retry is not an empty file', () => {
    // THE SAME DATA-DESTRUCTION CLASS AS THE `poisoned` FLAG, through a different door, and
    // reachable with ENTIRELY WELL-FORMED MESSAGES. Measured 2026-10-07 before the fix: stage a
    // real 5-byte file, have `startTransfer` refuse it (a locked keyboard is enough), retry the
    // same keywords -- and `startTransfer` was called with ZERO bytes, no refusal sent, reported
    // as success. Under `Exist=replace` that overwrites the operator's dataset with nothing.
    //
    // The honest browser half re-chunks on every send, so it could never trigger this -- which is
    // exactly what would have made it a trap for whoever wired a retry button later.
    const reads: Uint8Array[] = [];
    let refuse = true;
    const gw = createGatewayTransfer({
      send: () => {},
      repaint: () => {},
      startTransfer: (o) => {
        reads.push(o.files.read('local.txt'));
        const out: TransferRun = refuse
          ? { ok: false, error: 'cannot begin transfer: keyboard locked' }
          : { ok: true };
        refuse = false;
        return out;
      },
    });
    gw.chunk(0, 5, new Uint8Array([1, 2, 3, 4, 5]));
    gw.start(SEND, fakeSession());
    expect(reads[0]).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    // The retry: same keywords, no re-staging, as a Reset-and-try-again would send.
    gw.start(SEND, fakeSession());
    expect(reads[1], 'the retry must carry the file, not nothing')
      .toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('puts the bytes BACK when transferCommand throws on a bad keyword', () => {
    // A MISTYPED HostFile IS THE COMMONEST OPERATOR ERROR, so this refusal is the likeliest of
    // all -- and it consumed the file before the keywords were even parsed.
    const reads: Uint8Array[] = [];
    const gw = createGatewayTransfer({
      send: () => {},
      repaint: () => {},
      startTransfer: (o) => { reads.push(o.files.read('local.txt')); return { ok: true }; },
    });
    gw.chunk(0, 3, new Uint8Array([7, 8, 9]));
    gw.start(['Direction=send', 'NoSuchKeyword=x'], fakeSession());
    expect(reads, 'a keyword refusal must not reach startTransfer at all').toEqual([]);
    gw.start(SEND, fakeSession());
    expect(reads[0], 'and the file must still be there').toEqual(new Uint8Array([7, 8, 9]));
  });

  it('still treats a genuinely empty upload as empty, which the restore must not break', () => {
    // The clause only restores a NON-EMPTY source, so the legal zero-byte upload is untouched.
    const h = harness({ ok: false, error: 'nope' });
    h.gw.start(SEND, fakeSession());
    expect(h.opts.files.read('local.txt')).toEqual(new Uint8Array(0));
  });
});

describe('a stale onProgress must not cross a run boundary', () => {
  it('drops progress from a discarded run, as onDone already did', () => {
    // The asymmetry was an oversight: `onDone` was generation-guarded and `onProgress` was not,
    // with the same other-package invariant the only thing protecting it. Measured 2026-10-07 --
    // a run-1 progress string landed on the socket after `discard()`.
    const sent: ServerMessage[] = [];
    let leak: ((text: string) => void) | undefined;
    const gw = createGatewayTransfer({
      send: (m) => { sent.push(m); },
      repaint: () => {},
      startTransfer: (o) => { leak = o.onProgress; return { ok: true }; },
    });
    gw.chunk(0, 2, new Uint8Array([1, 2]));
    gw.start(SEND, fakeSession());
    gw.discard();
    sent.length = 0;
    leak?.('STALE 999 bytes');
    expect(sent, 'a discarded run may not speak').toEqual([]);
  });
});

describe('the TransferFiles call PATTERN, not just its contract', () => {
  it('reads the source AT MOST ONCE, which is what makes a synchronous interface safe', () => {
    // THIS IS THE ASSERTION THAT WOULD HAVE CAUGHT THE CONSUME-BEFORE-REFUSE BUG, and the one the
    // Task 7 implementer named as missing in their own report: the suite asserted what
    // `TransferFiles` RETURNS and never what `startTransfer` DOES with it.
    //
    // The synchronous-interface argument this whole feature rests on is that no `TransferFiles`
    // call happens mid-transfer -- a send reads once up front before the host is told anything
    // (`transferRun.ts:102`). That is an audit of ANOTHER package, so it is pinned here: if
    // `transferRun.ts` ever reads twice, or reads after the host is engaged, this reddens rather
    // than the feature quietly becoming wrong.
    const h = harness();
    h.stage(new Uint8Array([1, 2, 3]));
    h.gw.start(SEND, fakeSession());
    let reads = 0;
    const first = h.opts.files.read('local.txt');
    reads += 1;
    // A SECOND read must return the SAME bytes rather than an empty buffer -- the driver is
    // entitled to re-read its own source, and `CutTransfer` holds it to answer a retransmit.
    const second = h.opts.files.read('local.txt');
    reads += 1;
    expect(second, 'a re-read must not come back empty').toEqual(first);
    expect(reads).toBe(2);
    // AND `exists` MUST STAY FALSE: it governs the local `Exist=keep` check, and a gateway with no
    // disk has nothing for a local file to collide with.
    expect(h.opts.files.exists('local.txt')).toBe(false);
  });
});
