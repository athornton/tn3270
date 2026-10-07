import { describe, it, expect, vi } from 'vitest';
import {
  createTransferBridge, type SaveSink, type TransferBridgeDeps,
} from '../src/transferBridge.js';
import { CHUNK_BYTES, MAX_TRANSFER_BYTES } from '../src/transferChunk.js';
// THE REAL FRAME CAP, IMPORTED RATHER THAN RESTATED, for the same reason
// `transferChunk.test.ts:8` imports it: the whole point of `CHUNK_BYTES` is that an encoded chunk
// PLUS its JSON envelope fits under this number, and that property is this module's to keep --
// `transferChunk.ts` sizes the payload, but the envelope is built here.
import { MAX_MESSAGE_BYTES } from '../src/wsserver.js';

/**
 * A fake socket and two fake save sinks, because vitest runs `environment: 'node'`.
 *
 * `vitest.config.ts` sets `environment: 'node'`, so there is no `File`, no `Blob`, no
 * `URL.createObjectURL` and no `showSaveFilePicker` in any test in this repo, and jsdom is not a
 * dependency. Every browser capability the bridge uses is therefore a dependency, which is the
 * same shape `bridgecore.ts` uses for its socket -- and what makes BOTH save routes drivable
 * here. `btoa` is the one exception and it is not injected: Node has had it as a global since 16,
 * measured present on this repo's node 26.
 */
function deps(over: Partial<TransferBridgeDeps> = {}): {
  d: TransferBridgeDeps; sent: string[]; saved: { name: string; bytes: Uint8Array }[];
} {
  const sent: string[] = [];
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const d: TransferBridgeDeps = {
    send: (text) => { sent.push(text); },
    savePicker: undefined,
    saveFallback: (name, bytes) => { saved.push({ name, bytes }); },
    ...over,
  };
  return { d, sent, saved };
}

/** A `savePicker` that records what was written and whether it was closed. */
function fakePicker(): {
  picker: (name: string) => Promise<SaveSink>; writes: Uint8Array[]; closed: () => number;
} {
  const writes: Uint8Array[] = [];
  let closes = 0;
  return {
    picker: vi.fn(async (): Promise<SaveSink> => ({
      write: async (b) => { writes.push(b); },
      close: async () => { closes += 1; },
    })),
    writes,
    closed: () => closes,
  };
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
  it('uses the save picker when one is available', async () => {
    const { picker, writes, closed } = fakePicker();
    const { d, saved } = deps({ savePicker: picker });
    const b = createTransferBridge(d);
    b.acceptData(0, 4, new Uint8Array([1, 2]));
    b.acceptData(1, 4, new Uint8Array([3, 4]));
    await b.save('out.bin');
    expect(picker).toHaveBeenCalledWith('out.bin');
    // ONE WRITE OF THE JOINED BYTES: the chunks are reassembled before the sink sees them.
    expect(writes).toEqual([new Uint8Array([1, 2, 3, 4])]);
    // `close()` IS WHAT COMMITS THE FILE TO DISK, so a missing close is a save that silently
    // leaves nothing behind -- asserted rather than assumed for that reason.
    expect(closed()).toBe(1);
    expect(saved, 'the fallback must not also run').toEqual([]);
  });

  it('falls back to a plain download when there is no picker', async () => {
    // THE ROUTE AT RISK OF ROTTING: a developer on Chrome-over-localhost always gets the picker,
    // so nothing but this case exercises the fallback. `savePicker === undefined` IS the feature
    // detection result, injected rather than read from `window` precisely so this test exists.
    const { d, saved } = deps({ savePicker: undefined });
    const b = createTransferBridge(d);
    b.acceptData(0, 2, new Uint8Array([9, 8]));
    await b.save('out.bin');
    expect(saved).toEqual([{ name: 'out.bin', bytes: new Uint8Array([9, 8]) }]);
  });

  it('reports unsaved bytes, so dismissing the overlay can warn', async () => {
    const { d } = deps();
    const b = createTransferBridge(d);
    expect(b.hasUnsaved()).toBe(false);
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    expect(b.hasUnsaved()).toBe(true);
    await b.save('out.bin');
    expect(b.hasUnsaved()).toBe(false);
  });

  it('does not report unsaved bytes while a transfer is still incomplete', () => {
    // The overlay's close button asks this, and a true here would warn about losing a file that
    // does not exist yet -- the partial bytes are not saveable and `save()` writes nothing.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 8, new Uint8Array([1, 2]));
    expect(b.hasUnsaved()).toBe(false);
    expect(saved).toEqual([]);
  });

  it('saves nothing, rather than throwing, when there is nothing to save', async () => {
    // Reachable from the overlay: the Save button is enabled off `hasUnsaved()`, but a second
    // click on a button whose disabling lost a race must not throw out of an event handler.
    const { picker } = fakePicker();
    const { d, saved } = deps({ savePicker: picker });
    const b = createTransferBridge(d);
    await b.save('out.bin');
    expect(picker).not.toHaveBeenCalled();
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

  it('accepts a second transfer after the first was saved', () => {
    // The overlay is reused for the whole session, so the bridge has to be good for more than one
    // receive: completion clears the reassembler, which is what lets sequence numbers restart.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 2, new Uint8Array([1, 2]));
    void b.save('one.bin');
    expect(b.acceptData(0, 2, new Uint8Array([3, 4])).ok).toBe(true);
    expect(b.hasUnsaved()).toBe(true);
    void b.save('two.bin');
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
    // DROPPED ON PURPOSE: a cancelled transfer's bytes are not a file the operator asked for, and
    // leaving them saveable would let a Save click write a truncated download.
    expect(b.hasUnsaved()).toBe(false);
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

describe('the save paths that can fail, which had no cover until 2026-10-07', () => {
  /** A file staged and ready to save, as a completed receive leaves it. */
  function staged(over: Partial<TransferBridgeDeps> = {}) {
    const { d, saved } = deps(over);
    const b = createTransferBridge(d);
    b.acceptData(0, 3, new Uint8Array([1, 2, 3]));
    return { b, saved };
  }

  it('reports a rejecting write as a failure, and still CLOSES the sink', async () => {
    // Measured before the fix: `close()` was never called, leaking the picker's temp file, and
    // the rejection escaped a method called from a click handler.
    const closed = vi.fn(async () => {});
    const { b } = staged({
      savePicker: async (): Promise<SaveSink> => ({
        write: async () => { throw new Error('disk full'); },
        close: closed,
      }),
    });
    const out = await b.save('x.bin');
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error('narrowing');
    expect(out.error).toMatch(/could not save x\.bin/);
    expect(out.error).toMatch(/disk full/);
    expect(closed, 'a failed write must still close the sink').toHaveBeenCalled();
    // RETRYABLE: the host is out of transfer mode, so these bytes are the only copy.
    expect(b.hasUnsaved()).toBe(true);
  });

  it('reports a rejecting close, because that is the call that COMMITS the file', async () => {
    const { b } = staged({
      savePicker: async (): Promise<SaveSink> => ({
        write: async () => {},
        close: async () => { throw new Error('commit failed'); },
      }),
    });
    const out = await b.save('x.bin');
    expect(out.ok).toBe(false);
    expect(b.hasUnsaved()).toBe(true);
  });

  it('treats an ABORTED dialog as ok, since dismissing the picker is the common case', async () => {
    // `showSaveFilePicker` rejects with AbortError whenever the operator dismisses it. Before the
    // fix this was an unhandled rejection in the console; it must be quiet AND keep the bytes.
    const abort = new Error('user dismissed');
    abort.name = 'AbortError';
    const { b } = staged({ savePicker: async () => { throw abort; } });
    const out = await b.save('x.bin');
    expect(out.ok, 'an aborted dialog is not a failure to report').toBe(true);
    expect(b.hasUnsaved(), 'and the file is still there to save').toBe(true);
  });

  it('reports a throwing fallback, the route every non-Chrome browser takes', async () => {
    const { b } = staged({
      saveFallback: () => { throw new Error('no object URL'); },
    });
    const out = await b.save('x.bin');
    expect(out.ok).toBe(false);
    expect(b.hasUnsaved()).toBe(true);
  });

  it('is INERT on a concurrent double-save against an ASYNC picker', async () => {
    // THE RACE THE OLD GUARD MISSED. `complete` was cleared after two awaits, so two clicks
    // landing together each saw bytes: measured TWO dialogs, two writes, two closes, one file
    // saved twice. The sequential case was already inert and the fallback is synchronous, so the
    // only two paths a test drove were the two that could not fail.
    let opened = 0;
    const writes: number[] = [];
    const { b } = staged({
      savePicker: async (): Promise<SaveSink> => {
        opened += 1;
        await new Promise((r) => { setTimeout(r, 5); });
        return { write: async (by) => { writes.push(by.length); }, close: async () => {} };
      },
    });
    const [a, c] = await Promise.all([b.save('x.bin'), b.save('x.bin')]);
    expect(opened, 'only one dialog may open').toBe(1);
    expect(writes).toEqual([3]);
    expect(a.ok && c.ok).toBe(true);
    expect(b.hasUnsaved()).toBe(false);
  });

  it('REFUSES a chunk whose declared total contradicts the transfer, and latches', async () => {
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
    await b.save('x.bin');
    expect(saved, 'nothing may reach the disk').toEqual([]);
  });
});

describe('a zero-byte receive, which no chunk can announce', () => {
  it('is saveable through finishEmpty, where before it was SILENCE', () => {
    // `chunkBytes` emits nothing for an empty source, so the gateway sends `transferDone` with no
    // `transferData`: acceptData never runs. Measured 2026-10-07 before the fix -- hasUnsaved()
    // false, save() wrote nothing, and an operator downloading an empty host dataset saw nothing
    // happen at all.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    expect(b.hasUnsaved()).toBe(false);
    b.finishEmpty();
    expect(b.hasUnsaved(), 'an empty file is a real, saveable result').toBe(true);
    return b.save('empty.bin').then(() => {
      expect(saved).toEqual([{ name: 'empty.bin', bytes: new Uint8Array(0) }]);
    });
  });

  it('REFUSES to invent an empty file over a receive that staged real bytes', () => {
    // The contradiction guard: a gateway claiming "done, and empty" after sending chunks is
    // wrong about something, and inventing a 0-byte file would discard what did arrive.
    const { d, saved } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 3, new Uint8Array([1, 2, 3]));   // completes, stages 3 bytes
    b.finishEmpty();
    expect(b.hasUnsaved()).toBe(true);
    return b.save('x.bin').then(() => {
      // THE REAL BYTES, not the empty file finishEmpty would have substituted.
      expect(saved).toEqual([{ name: 'x.bin', bytes: new Uint8Array([1, 2, 3]) }]);
    });
  });

  it('does not clobber a PARTIAL receive either', () => {
    const { d } = deps();
    const b = createTransferBridge(d);
    b.acceptData(0, 9, new Uint8Array([1, 2, 3]));   // incomplete: 3 of 9
    b.finishEmpty();
    expect(b.hasUnsaved(), 'a partial transfer is not an empty one').toBe(false);
  });
});
