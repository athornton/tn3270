import { describe, it, expect } from 'vitest';
import {
  createTransferBridge, endTransfer, type TransferBridge, type TransferBridgeDeps, type TransferEnd,
} from '../src/transferBridge.js';
import { CHUNK_BYTES, MAX_TRANSFER_BYTES } from '../src/transferChunk.js';
// THE REAL FRAME CAP, IMPORTED RATHER THAN RESTATED, for the same reason
// `transferChunk.test.ts:8` imports it: the whole point of `CHUNK_BYTES` is that an encoded chunk
// PLUS its JSON envelope fits under this number, and that property is this module's to keep --
// `transferChunk.ts` sizes the payload, but the envelope is built here.
import { MAX_MESSAGE_BYTES } from '../src/wsserver.js';

/**
 * A fake socket and a fake download sink, because vitest runs `environment: 'node'`.
 *
 * `vitest.config.ts` sets `environment: 'node'`, so there is no `File`, no `Blob` and no
 * `URL.createObjectURL` in any test in this repo, and jsdom is not a dependency. Every browser
 * capability the bridge uses is therefore a dependency, which is the same shape `bridgecore.ts`
 * uses for its socket. `btoa` is the one exception and it is not injected: Node has had it as a
 * global since 16, measured present on this repo's node 26.
 *
 * THERE IS NO `savePicker` TO FAKE, AND THE OLD PICKER TESTS ARE DELETED, NOT SKIPPED. The
 * `showSaveFilePicker` route was removed on 2026-11-12 (the spec's "`savePicker` is not called"
 * became "there is no `savePicker`"): a receive downloads as it completes, the picker needs
 * transient user activation the completion does not have, and `TransferBridgeDeps` no longer
 * declares the dep. `saveFallback` is the only route, which is what every case below drives.
 */
function deps(over: Partial<TransferBridgeDeps> = {}): {
  d: TransferBridgeDeps; sent: string[]; saved: { name: string; bytes: Uint8Array }[];
} {
  const sent: string[] = [];
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const d: TransferBridgeDeps = {
    send: (text) => { sent.push(text); },
    saveFallback: (name, bytes) => { saved.push({ name, bytes }); },
    ...over,
  };
  return { d, sent, saved };
}

describe('sending a local file', () => {
  it('chunks the bytes and then sends transferStart', async () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    const out = await b.sendFile('x.c', new Uint8Array([1, 2, 3]), ['Direction=send', 'LocalFile=x.c']);
    expect(out.ok).toBe(true);
    // THE ORDER IS THE ASSERTION, not a side effect of it: the gateway stages bytes on
    // `transferChunk` and STARTS on `transferStart`, so a start that arrived first would transfer
    // an empty buffer and report success.
    const kinds = sent.map((s) => JSON.parse(s).kind);
    expect(kinds).toEqual(['transferChunk', 'transferStart']);
    const first = JSON.parse(sent[0]!);
    expect(first.seq).toBe(0);
    expect(first.total).toBe(3);
    expect(first.bytes).toBe('AQID');
    expect(JSON.parse(sent[1]!).keywords).toEqual(['Direction=send', 'LocalFile=x.c']);
  });

  it('numbers chunks from zero and declares the WHOLE total on each one', async () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    await b.sendFile('big.c', new Uint8Array(CHUNK_BYTES * 2 + 5).fill(9), ['Direction=send']);
    const chunks = sent.slice(0, -1).map((s) => JSON.parse(s) as {
      seq: number; total: number; bytes: string;
    });
    expect(chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    // `total` IS THE FILE'S SIZE ON EVERY CHUNK, not the chunk's own length: that is what
    // `ChunkReassembler`'s constructor is handed, so a per-chunk length here would build a
    // reassembler expecting 4096 bytes and refuse chunk 1 as an overrun.
    expect(chunks.map((c) => c.total)).toEqual([CHUNK_BYTES * 2 + 5, CHUNK_BYTES * 2 + 5, CHUNK_BYTES * 2 + 5]);
    // The last chunk is the remainder, and base64 is what the gateway decodes.
    expect(Buffer.from(chunks[2]!.bytes, 'base64')).toHaveLength(5);
    expect([...Buffer.from(chunks[2]!.bytes, 'base64')]).toEqual([9, 9, 9, 9, 9]);
  });

  it('encodes a full chunk correctly, which a naive btoa of a Uint8Array does NOT', async () => {
    // MEASURED 2026-10-06: `btoa(String(bytes))` stringifies to "1,2,3" and `btoa(bytes)` does the
    // same, so both produce base64 of the DECIMAL TEXT -- a silently corrupt file rather than an
    // error. This asserts the real round trip over a full-sized chunk, with every byte value
    // present, because 0x80-0xff are where a `TextEncoder`-shaped mistake would show up.
    const src = new Uint8Array(CHUNK_BYTES);
    for (let i = 0; i < src.length; i += 1) src[i] = i & 0xff;
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    await b.sendFile('bytes.bin', src, ['Direction=send']);
    const decoded = new Uint8Array(Buffer.from(JSON.parse(sent[0]!).bytes as string, 'base64'));
    expect(decoded).toEqual(src);
  });

  it('keeps a worst-case chunk frame under the real MAX_MESSAGE_BYTES', async () => {
    // AN OVERSIZE FRAME CLOSES THE SOCKET WITH NO MESSAGE (`wsserver.ts:106`, `:114`), taking the
    // whole 3270 session, so this is the envelope half of `CHUNK_BYTES`'s justification --
    // `transferChunk.test.ts` pins the encoded PAYLOAD, and the JSON built here is what rides with
    // it. The widest `total` possible is the 10 MB ceiling, and the widest `seq` goes with it.
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    const src = new Uint8Array(CHUNK_BYTES * 2);
    await b.sendFile('x', src, ['Direction=send']);
    // Substitute the widest field values a real transfer can carry, then measure the frame.
    const widest = JSON.stringify({
      ...JSON.parse(sent[0]!), seq: MAX_TRANSFER_BYTES / CHUNK_BYTES - 1, total: MAX_TRANSFER_BYTES,
    });
    expect(Buffer.byteLength(widest)).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(MAX_MESSAGE_BYTES - Buffer.byteLength(widest)).toBeGreaterThan(2000);
  });

  it('refuses a file over 10 MB in the BROWSER, before sending anything', async () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    const big = new Uint8Array(MAX_TRANSFER_BYTES + 1);
    const out = await b.sendFile('big.bin', big, ['Direction=send']);
    expect(out.ok).toBe(false);
    // Decision 2: the operator is told the limit AND the size, on purpose.
    expect(out.ok === false && out.error).toMatch(/10485761 bytes/);
    expect(out.ok === false && out.error).toMatch(/10485760-byte limit/);
    expect(sent, 'nothing may be sent for a refused file').toEqual([]);
  });

  it('sends a file of exactly the limit, so the refusal is not off by one', async () => {
    // The boundary in the direction that matters: `>` rather than `>=`, checked against the one
    // size a legitimate operator can be refused by a typo in this comparison.
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    const out = await b.sendFile('exact.bin', new Uint8Array(MAX_TRANSFER_BYTES), ['Direction=send']);
    expect(out.ok).toBe(true);
    expect(sent).toHaveLength(MAX_TRANSFER_BYTES / CHUNK_BYTES + 1);
  });

  it('sends an empty file as transferStart with no chunks', async () => {
    // `chunkBytes` emits no chunks for an empty source, so this is the one case where the start
    // message travels alone. It must still go: an empty local file is a legal transfer.
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    await b.sendFile('empty', new Uint8Array(0), ['Direction=send']);
    expect(sent.map((s) => JSON.parse(s).kind)).toEqual(['transferStart']);
  });
});

describe('receiving into the browser', () => {
  it('delivers a completed receive ONCE, under the given name, with byte-identical data', () => {
    // ONE CALL OF THE JOINED BYTES: the chunks are reassembled before the sink sees them.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    b.acceptData(1, 4, new Uint8Array([3, 4]));
    const out = b.deliver('nap.h');
    expect(out).toEqual({ ok: true, bytes: 4 });
    expect(saved).toEqual([{ name: 'nap.h', bytes: new Uint8Array([1, 2, 3, 4]) }]);
  });

  it('holds nothing after delivery, so a second deliver downloads nothing', () => {
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    expect(b.hasUnsaved()).toBe(false);
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    expect(b.hasUnsaved(), 'held between the last chunk and the delivery').toBe(true);
    b.deliver('out.bin');
    expect(b.hasUnsaved()).toBe(false);
    const again = b.deliver('out.bin');
    expect(again.ok).toBe(false);
    expect(saved, 'one download, not two').toHaveLength(1);
  });

  it('does not report unsaved bytes while a transfer is still incomplete', () => {
    // The overlay's close button asks this, and a true here would warn about losing a file that
    // does not exist yet -- the partial bytes are not deliverable.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 8, new Uint8Array([1, 2]));
    expect(b.hasUnsaved()).toBe(false);
    expect(saved).toEqual([]);
  });

  it('REPORTS an empty-handed deliver as an error, rather than a quiet success', () => {
    // It used to be a quiet no-op, for a Save button's double click. `deliver` is called only for
    // a receive the gateway called successful, so nothing staged means the file did not arrive
    // whole -- and `ok` would put `downloaded as ...` over a download that never happened.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 8, new Uint8Array([1, 2]));      // 2 of 8 bytes
    const out = b.deliver('part.bin');
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/part\.bin did not arrive whole/);
    expect(saved).toEqual([]);
  });

  it('refuses out-of-sequence received data rather than writing a corrupt file', () => {
    const { d } = deps();
    const b = createTransferBridge(d);
    expect(b.acceptData(0, 4, new Uint8Array([1, 2])).ok).toBe(true);
    const out = b.acceptData(7, 4, new Uint8Array([3, 4]));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/out of sequence/);
  });

  it('LATCHES the refusal: a correct chunk after a bad one does not resurrect the transfer', () => {
    /**
     * THE TRAP `ChunkReassembler`'S OWN DOCSTRING RECORDS, one level up.
     *
     * That class latches internally -- "a half-rejected reassembler that still completes is a
     * corrupt file delivered as a success" -- but the latch only holds if this bridge KEEPS the
     * object after a refusal. Discarding it on the failure path (`inbound = undefined`) looks
     * like tidy cleanup and silently restores the exact bug the latch was added to close: the
     * next chunk builds a fresh reassembler, chunk 0 is in sequence again, and a file missing
     * everything the operator never noticed was dropped is saved as a success.
     *
     * So the sequence here is the one that distinguishes the two implementations: refuse chunk 7,
     * then send a perfectly well-formed chunk 0 and 1 for the same total.
     */
    const { d } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    expect(b.acceptData(7, 4, new Uint8Array([3, 4])).ok).toBe(false);
    const after = b.acceptData(0, 4, new Uint8Array([1, 2]));
    expect(after.ok, 'a discarded reassembler would accept this as a fresh transfer').toBe(false);
    expect(after.ok === false && after.error).toMatch(/abandoned/);
    expect(b.hasUnsaved()).toBe(false);
  });

  it('refuses a declared total the reassembler will not accept, rather than throwing', () => {
    // `new ChunkReassembler(total)` THROWS on a total over the 10 MB cap or a non-integer, and
    // this is called from the socket's message handler -- inside the async chain in
    // `bridgecore.ts`'s `onmessage`, where a throw is an unhandled rejection with nothing in the
    // operator's view. The gateway is the sender today, but a client validating what the server
    // declares is the same rule `protocol.ts` applies in the other direction.
    const { d } = deps();
    const b = createTransferBridge(d);
    const out = b.acceptData(0, MAX_TRANSFER_BYTES + 1, new Uint8Array([1]));
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.error).toMatch(/10485760-byte limit/);
    const bad = createTransferBridge(deps().d).acceptData(0, 1.5, new Uint8Array([1]));
    expect(bad.ok === false && bad.error).toMatch(/non-negative integer/);
  });

  it('accepts a second transfer after the first was delivered', () => {
    // The overlay is reused for the whole session, so the bridge has to be good for more than one
    // receive: completion clears the reassembler, which is what lets sequence numbers restart.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    b.deliver('one.bin');
    expect(b.acceptData(0, 2, new Uint8Array([3, 4])).ok).toBe(true);
    expect(b.hasUnsaved()).toBe(true);
    b.deliver('two.bin');
    expect(saved.map((s) => s.name)).toEqual(['one.bin', 'two.bin']);
  });
});

describe('cancel', () => {
  it('sends transferCancel and drops any partial or unsaved bytes', () => {
    const { d, sent } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    expect(b.hasUnsaved()).toBe(true);
    b.cancel();
    expect(sent.map((s) => JSON.parse(s).kind)).toEqual(['transferCancel']);
    // DROPPED ON PURPOSE: a cancelled transfer's bytes are not a file the operator asked for.
    expect(b.hasUnsaved()).toBe(false);
    expect(b.deliver('x.bin').ok, 'nothing left to download').toBe(false);
  });

  it('clears a LATCHED refusal, so cancel is the way back to a usable form', () => {
    // The only reset path: `acceptData` keeps the dead reassembler so the latch holds, so without
    // this the overlay would be stuck refusing every subsequent transfer for the session.
    const { d } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    expect(b.acceptData(7, 4, new Uint8Array([3, 4])).ok).toBe(false);
    b.cancel();
    expect(b.acceptData(0, 4, new Uint8Array([1, 2])).ok).toBe(true);
  });
});

describe('the delivery that can fail', () => {
  /** A file staged and ready to deliver, as a completed receive leaves it. */
  function staged(over: Partial<TransferBridgeDeps> = {}) {
    const { d, saved } = deps(over);
    const b = createTransferBridge(d);
    b.acceptData(0, 3, new Uint8Array([1, 2, 3]));
    return { b, saved };
  }

  it('reports a throwing download sink, and KEEPS the bytes', () => {
    // Synchronous, so there is no abort case: the picker's `AbortError` arm went with the picker.
    const { b } = staged({
      saveFallback: () => { throw new Error('no object URL'); },
    });
    const out = b.deliver('x.bin');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('narrowing');
    expect(out.error).toMatch(/could not download x\.bin/);
    expect(out.error).toMatch(/no object URL/);
    // RESTORED: the host is out of transfer mode, so these bytes are the only copy, and the
    // overlay's close guard must still ask before they are dropped.
    expect(b.hasUnsaved()).toBe(true);
  });

  it('REFUSES a chunk whose declared total contradicts the transfer, and latches', () => {
    // Measured before the fix: `total` rode on every chunk and was read only from the first, so a
    // 6-byte receive whose chunk 0 said 6 and chunk 1 said 2 saved a TRUNCATED FILE AS A SUCCESS.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    expect(b.acceptData(0, 6, new Uint8Array([1, 2, 3])).ok).toBe(true);
    const bad = b.acceptData(1, 2, new Uint8Array([4, 5, 6]));
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error('narrowing');
    expect(bad.error).toMatch(/declares total 2, but the transfer declared 6/);
    expect(b.hasUnsaved(), 'a contradicted transfer must not be saveable').toBe(false);
    // LATCHED: a sender that contradicts itself has disqualified the whole transfer.
    expect(b.acceptData(1, 6, new Uint8Array([4, 5, 6])).ok).toBe(false);
    b.deliver('x.bin');
    expect(saved, 'nothing may reach the disk').toEqual([]);
  });
});

describe('a zero-byte receive, which no chunk can announce', () => {
  it('is deliverable through finishEmpty, where before it was SILENCE', () => {
    // `chunkBytes` emits nothing for an empty source, so the gateway sends `transferDone` with no
    // `transferData`: acceptData never runs. Measured 2026-10-07 before the fix -- hasUnsaved()
    // false, the save wrote nothing, and an operator downloading an empty host dataset saw
    // nothing happen at all.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    expect(b.hasUnsaved()).toBe(false);
    b.finishEmpty();
    expect(b.hasUnsaved(), 'an empty file is a real, deliverable result').toBe(true);
    expect(b.deliver('empty.bin')).toEqual({ ok: true, bytes: 0 });
    expect(saved).toEqual([{ name: 'empty.bin', bytes: new Uint8Array(0) }]);
  });

  it('REFUSES to invent an empty file over a receive that staged real bytes', () => {
    // The contradiction guard: a gateway claiming "done, and empty" after sending chunks is
    // wrong about something, and inventing a 0-byte file would discard what did arrive.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 3, new Uint8Array([1, 2, 3]));   // completes, stages 3 bytes
    b.finishEmpty();
    expect(b.hasUnsaved()).toBe(true);
    b.deliver('x.bin');
    // THE REAL BYTES, not the empty file finishEmpty would have substituted.
    expect(saved).toEqual([{ name: 'x.bin', bytes: new Uint8Array([1, 2, 3]) }]);
  });

  it('does not clobber a PARTIAL receive either', () => {
    const { d } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 9, new Uint8Array([1, 2, 3]));   // incomplete: 3 of 9
    b.finishEmpty();
    expect(b.hasUnsaved(), 'a partial transfer is not an empty one').toBe(false);
  });
});

describe('finishEmpty must not invent a file over a REFUSED chunk', () => {
  it('stays inert when a chunk was refused by the reassembler CONSTRUCTOR', () => {
    // THE FOURTH INSTANCE OF THIS FEATURE'S DATA-DESTRUCTION CLASS, found 2026-10-07.
    // `finishEmpty()` bails when `inbound` or `complete` is set -- but a chunk refused by
    // `ChunkReassembler`'s constructor leaves `inbound` UNDEFINED, because `acceptData`'s `try`
    // returns the error without assigning. So "nothing staged" looked like the legal zero-byte
    // receive, `hasUnsaved()` went true, the (since removed) Save button was enabled, and clicking
    // it downloaded a 0-byte file while the status line correctly said the transfer had been
    // refused.
    //
    // The caller's own guard (`transferBoot.ts` holds the refusal and skips `finishEmpty`) is the
    // primary fix; this pins the lower half so the two cannot drift apart.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    const out = b.acceptData(0, 11 * 1024 * 1024, new Uint8Array([1, 2, 3]));
    expect(out.ok).toBe(false);
    // A caller that forgets to check — which is exactly what shipped — must still get nothing.
    b.finishEmpty();
    expect(b.hasUnsaved(), 'a refused receive is not an empty file').toBe(false);
    b.deliver('REPORT.TXT');
    expect(saved, 'nothing may reach the disk').toEqual([]);
  });
});

describe('TransferBridgeDeps has no savePicker', () => {
  it('rejects one at the type level, so the removed route cannot come back unnoticed', () => {
    // `npm run typecheck:tests` checks this file: if `savePicker` were declared again, the
    // `@ts-expect-error` below would be unused and the typecheck would fail.
    const d: TransferBridgeDeps = {
      send: () => {},
      saveFallback: () => {},
      // @ts-expect-error -- removed 2026-11-12; `saveFallback` is the only download route.
      savePicker: undefined,
    };
    expect(Object.keys(d)).toContain('saveFallback');
  });
});

/**
 * `endTransfer`: what `transferBoot.ts` does with `transferDone`.
 *
 * Driven through a REAL bridge and a recording sink, so "downloaded" means `saveFallback` ran,
 * with these bytes, under this name -- not that some flag was set.
 */
describe('endTransfer: a receive downloads as it completes', () => {
  /** A `transferDone {ok:true}` ending a receive, with the boot file's memory of the run. */
  function end(over: Partial<TransferEnd> = {}): TransferEnd {
    return {
      ok: true, error: 'the transfer failed', bytes: undefined,
      direction: 'receive', refusal: undefined, saveName: 'nap.h', ...over,
    };
  }
  function bridge(): { b: TransferBridge; saved: { name: string; bytes: Uint8Array }[] } {
    const { d, saved } = deps();
    return { b: createTransferBridge(d), saved };
  }

  it('downloads once, under saveName, with identical bytes, and says so', () => {
    const { b, saved } = bridge();
    b.acceptData(0, 3, new Uint8Array([0x4e, 0x41, 0x50]));
    const out = endTransfer(b, end({ bytes: 3 }));
    expect(saved).toEqual([{ name: 'nap.h', bytes: new Uint8Array([0x4e, 0x41, 0x50]) }]);
    expect(out.result).toEqual({ ok: true, bytes: 3 });
    expect(out.status).toBe('received 3 bytes; downloaded as nap.h');
    // NOTHING HELD, so the overlay's close guard does not ask.
    expect(b.hasUnsaved()).toBe(false);
  });

  it('uses the name it is given, not a fixed one', () => {
    // A second name, so a constant that happened to equal the first case's cannot pass both.
    const { b, saved } = bridge();
    b.acceptData(0, 1, new Uint8Array([7]));
    const out = endTransfer(b, end({ saveName: 'sys1.proclib(asmhc)' }));
    expect(saved.map((s) => s.name)).toEqual(['sys1.proclib(asmhc)']);
    expect(out.status).toBe('received 1 bytes; downloaded as sys1.proclib(asmhc)');
  });

  it('downloads a ZERO-BYTE receive, which no chunk announces', () => {
    const { b, saved } = bridge();
    const out = endTransfer(b, end({ saveName: 'empty.h', bytes: 0 }));
    expect(saved).toEqual([{ name: 'empty.h', bytes: new Uint8Array(0) }]);
    expect(out.status).toBe('received 0 bytes; downloaded as empty.h');
  });

  it('downloads NOTHING over a refused chunk, and reports the refusal', () => {
    const { b, saved } = bridge();
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    const refused = b.acceptData(7, 4, new Uint8Array([3, 4]));
    if (refused.ok) throw new Error('the chunk should have been refused');
    const out = endTransfer(b, end({ refusal: refused.error }));
    expect(saved).toEqual([]);
    expect(out.result).toEqual({ ok: false, error: refused.error });
    expect(out.status).toBeUndefined();
  });

  it('downloads NOTHING over a constructor refusal, the fourth empty-file guard', () => {
    // The over-cap receive: nothing staged, `inbound` never assigned, so without the refusal it
    // looks exactly like the legal zero-byte case that `finishEmpty` exists for.
    const { b, saved } = bridge();
    const refused = b.acceptData(0, 11 * 1024 * 1024, new Uint8Array([1]));
    if (refused.ok) throw new Error('the chunk should have been refused');
    const out = endTransfer(b, end({ refusal: refused.error }));
    expect(saved).toEqual([]);
    expect(out.result.ok).toBe(false);
  });

  it('downloads NOTHING when the gateway reports failure, even with bytes staged', () => {
    const { b, saved } = bridge();
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    const out = endTransfer(b, end({ ok: false, error: 'host said no' }));
    expect(saved).toEqual([]);
    expect(out.result).toEqual({ ok: false, error: 'host said no' });
    expect(out.status).toBeUndefined();
  });

  it('downloads NOTHING after a cancel, whichever way the gateway ends it', () => {
    const { b, saved } = bridge();
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    b.cancel();
    expect(endTransfer(b, end({ ok: false, error: 'cancelled' })).result.ok).toBe(false);
    // A `transferDone {ok:true}` that crossed the cancel on the wire. AFTER A CANCEL THE BRIDGE
    // ALONE CANNOT TELL THIS FROM THE LEGAL ZERO-BYTE RECEIVE -- nothing staged, nothing refused
    // -- and measured 2026-11-12 it downloaded a 0-byte `nap.h`. So `transferBoot.ts`'s cancel
    // handler holds a refusal for a cancelled receive, and this is the ending it produces.
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    b.cancel();
    const out = endTransfer(b, end({ refusal: 'transfer cancelled; nothing was downloaded' }));
    expect(out.result).toEqual({ ok: false, error: 'transfer cancelled; nothing was downloaded' });
    expect(saved).toEqual([]);
  });

  it('downloads NOTHING for a partial receive the gateway called done', () => {
    const { b, saved } = bridge();
    b.acceptData(0, 9, new Uint8Array([1, 2, 3]));
    const out = endTransfer(b, end());
    expect(saved).toEqual([]);
    expect(out.result.ok === false && out.result.error).toMatch(/did not arrive whole/);
  });

  it('reports a throwing download sink instead of claiming the download', () => {
    const { d } = deps({ saveFallback: () => { throw new Error('blocked'); } });
    const b = createTransferBridge(d);
    b.acceptData(0, 1, new Uint8Array([1]));
    const out = endTransfer(b, end());
    expect(out.result.ok === false && out.result.error).toMatch(/could not download nap\.h: blocked/);
    expect(out.status).toBeUndefined();
  });

  it('leaves a SEND unchanged: no download, and finished() keeps its own text', () => {
    // A send that staged nothing is every successful upload there is; `finishEmpty()` on one
    // would download an empty copy of the operator's own file.
    const { b, saved } = bridge();
    const out = endTransfer(b, end({ direction: 'send', bytes: 42 }));
    expect(saved).toEqual([]);
    expect(out.result).toEqual({ ok: true, bytes: 42 });
    expect(out.status).toBeUndefined();
    expect(b.hasUnsaved()).toBe(false);
    // And a `transferDone` with no `bytes` stays without one (`exactOptionalPropertyTypes`).
    expect(endTransfer(b, end({ direction: 'send' })).result).toEqual({ ok: true });
  });

  it('downloads nothing for a transferDone with no run behind it', () => {
    const { b, saved } = bridge();
    endTransfer(b, end({ direction: undefined }));
    expect(saved).toEqual([]);
  });
});
