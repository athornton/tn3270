import { describe, it, expect } from 'vitest';
import { DftTransfer } from '../src/ft/dft.js';
import { DftRequest } from '../src/ft/dftFrames.js';

/**
 * An Open payload, short form, as OUR parser sees it (field less 3 bytes).
 *
 * **The name goes at payload offset 25, NOT 22** — `dft_open_request` is handed a
 * pointer already at struct offset 3, so the Open's offsets are x3270's unchanged.
 * Getting this wrong shipped a real bug in Task 3 (fixed in `c0cdfad`); see the
 * long note in `dftFrames.ts`. Built as the whole FIELD and sliced, so the layout
 * is written the way the wire is and not the way the parser happens to read it.
 */
function open(name = 'FT:DATA'): Uint8Array {
  const field = new Uint8Array(0x23);
  field[0] = 0x00;
  field[1] = 0x23;
  field[2] = 0xd0;
  field[3] = 0x00;
  field[4] = 0x12;                        // TR_OPEN_REQ at struct offset 3
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) field[3 + 25 + i] = padded.charCodeAt(i);
  return field.subarray(3);
}

/**
 * A `Data Insert` payload carrying `data`.
 *
 * Layout after the request type, from `struct data_buffer` (`ft_dft.c:59-67`):
 * compress indicator (2), begin-data (1), data length (2), then the data. These
 * ARE x3270's offsets minus 3, because `dft_data_insert` is given `data_bufr`
 * itself — the struct base — unlike the Open. The length field is the data length
 * PLUS 5 (`ft_dft.c:236` `my_length -= 5`).
 */
function dataInsert(data: number[]): Uint8Array {
  return Uint8Array.of(
    0x47, 0x04,                                  // TR_DATA_INSERT
    0xc0, 0x80,                                  // TR_NOT_COMPRESSED
    0x61,                                        // TR_BEGIN_DATA
    ((data.length + 5) >> 8) & 0xff, (data.length + 5) & 0xff,
    ...data,
  );
}

/**
 * A `Data Insert` payload with `trailing` junk bytes AFTER the declared data.
 *
 * **This exists because `dataInsert` alone cannot falsify the `-5`.** A payload
 * that ends exactly where its data ends makes an over-read invisible:
 * `subarray(7, 7 + length)` silently clamps at the buffer end, so reading 5 bytes
 * too many yields the same bytes and the mutation check passed 24/24 while the
 * subtraction was gone. Real frames need not end at the data — a host may pad, and
 * the declared length is what says where the data stops.
 *
 * With trailing bytes present, dropping the `-5` captures them and the assertion
 * fails on content. That is the difference between a test that pins the arithmetic
 * and one that merely exercises it.
 */
function dataInsertPadded(data: number[], trailing: number[]): Uint8Array {
  return Uint8Array.of(
    0x47, 0x04,
    0xc0, 0x80,
    0x61,
    ((data.length + 5) >> 8) & 0xff, (data.length + 5) & 0xff,
    ...data,
    ...trailing,
  );
}

/** A bare request with no extra fields. */
function bare(type: number): Uint8Array {
  return Uint8Array.of((type >> 8) & 0xff, type & 0xff);
}

/** ASCII bytes, which is what the host's message frames carry. */
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

describe('DftTransfer, download (receive)', () => {
  it('acknowledges an Open without completing', () => {
    const t = new DftTransfer({ direction: 'receive' });
    const step = t.handle(open());
    expect([...step.reply!]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x00, 0x09]);
    expect(step.done).toBeUndefined();
    expect(t.complete).toBe(false);
  });

  it('collects data and acknowledges each record with an increasing number', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    const first = t.handle(dataInsert([0x41, 0x42]));
    expect([...first.reply!].slice(8)).toEqual([0x00, 0x00, 0x00, 0x01]);
    const second = t.handle(dataInsert([0x43]));
    expect([...second.reply!].slice(8)).toEqual([0x00, 0x00, 0x00, 0x02]);
  });

  it('acknowledges a Close WITHOUT ending the transfer', () => {
    // The obvious guess is that Close finishes a download. It does not.
    // ft_complete is called from exactly three places, all in the message branch
    // of dft_data_insert (ft_dft.c:270, :273, :276); dft_close_request only writes
    // a CloseAck. Completing here would report success before the host said
    // TRANS03 -- before it has committed the file.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41, 0x42]));
    const step = t.handle(bare(DftRequest.CLOSE));
    expect([...step.reply!]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x41, 0x09]);
    expect(step.done).toBeUndefined();
    expect(t.complete).toBe(false);
  });

  it('hands over the received bytes on the host\'s TRANS03 message, in order', () => {
    // The REAL sequence, from message_flag being one flag reset by every Open
    // (ft_dft.c:171-175):
    //   Open(FT:DATA) -> Data... -> Close -> Open(FT:MSG) -> Data(TRANS03)
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41, 0x42]));
    t.handle(dataInsert([0x43]));
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));                 // the SECOND Open, same instance
    const step = t.handle(dataInsert(ascii('TRANS03')));
    expect(step.done).toEqual({ ok: true, data: Uint8Array.of(0x41, 0x42, 0x43) });
    expect(t.complete).toBe(true);
  });

  it('RESETS the record number on every Open, so the message frame is record 1', () => {
    // `recnum = 1` at ft_dft.c:178 runs in dft_open_request unconditionally -- it is
    // the ONLY assignment besides the increments at :214 and :636. So after the
    // second Open the message frame is acked as record 1, NOT as a continuation of
    // the file's numbering.
    //
    // THIS TEST EXISTS BECAUSE DELETING THE RESET LEFT ALL 26 TESTS GREEN. The
    // download sequence has a second Open, so the behaviour is observable; nothing
    // was asserting the number on that final ack. An unfalsified line is not a
    // pinned one.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41]));                    // record 1
    t.handle(dataInsert([0x42]));                    // record 2
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));                        // resets to 1
    const step = t.handle(dataInsert(ascii('TRANS03')));
    expect([...step.reply!].slice(8)).toEqual([0x00, 0x00, 0x00, 0x01]);
  });

  it('acknowledges the completing message frame as well as completing on it', () => {
    // x3270 calls dft_data_ack() at ft_dft.c:250, BEFORE it inspects the text and
    // calls ft_complete at :270. So the final frame carries BOTH a reply and a
    // done -- a step that completed without replying would leave the host's last
    // frame unacknowledged.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const step = t.handle(dataInsert(ascii('TRANS03')));
    expect(step.reply).toBeDefined();
    expect(step.done?.ok).toBe(true);
  });

  it('subtracts 5 from the declared length, so a wrong length truncates visibly', () => {
    // ft_dft.c:236 `my_length -= 5`. A payload declaring 7 carries 2 data bytes.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41, 0x42, 0x43, 0x44]));
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    const done = t.handle(dataInsert(ascii('TRANS03'))).done!;
    expect(done).toEqual({ ok: true, data: Uint8Array.of(0x41, 0x42, 0x43, 0x44) });
  });

  it('STOPS at the declared length and ignores trailing bytes -- pins the -5', () => {
    // THE TEST ABOVE CANNOT FALSIFY THE SUBTRACTION and this one can. Dropping
    // `- LENGTH_OVERHEAD` left all 24 tests green, because every payload the other
    // helper builds ends exactly where its data ends and `subarray` clamps at the
    // buffer end -- so a 5-byte over-read returned the identical bytes. With junk
    // after the data, the over-read swallows it and this fails on content.
    // Mutation-verified in both directions.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsertPadded([0x41, 0x42], [0xde, 0xad, 0xbe, 0xef, 0x99]));
    expect(t.transferred).toBe(2);
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    const done = t.handle(dataInsert(ascii('TRANS03'))).done!;
    expect(done).toEqual({ ok: true, data: Uint8Array.of(0x41, 0x42) });
  });

  it('reads the declared length from offset 5, not from anywhere else', () => {
    // Distinct non-zero bytes at the neighbouring candidate offsets, so a wrong
    // offset reads a REAL value rather than running off the end and coercing to 0 --
    // the same strengthening Task 3's review asked for on parseDftFrame. The
    // compress indicator (0xc080) sits at 2-3 and begin-data (0x61) at 4, so an
    // offset read one or two bytes early would declare 0x8061 or 0x6100 bytes.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    const step = t.handle(dataInsertPadded([0x77], [0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(step.reply).toBeDefined();
    expect(t.transferred).toBe(1);
  });

  it('a second Open for a MESSAGE does not discard the file bytes already received', () => {
    // messageFlag flips on the second Open, and the chunks must survive it. If
    // onOpen cleared them, every download would deliver an empty file while
    // reporting success -- the failure stage 1 warns to look for.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x99]));
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    expect(t.isMessage).toBe(true);
    const done = t.handle(dataInsert(ascii('TRANS03'))).done!;
    expect(done).toEqual({ ok: true, data: Uint8Array.of(0x99) });
  });

  it('treats an FT:MSG Open as a message and NOT as a file transfer', () => {
    const t = new DftTransfer({ direction: 'receive' });
    const step = t.handle(open('FT:MSG'));
    expect(step.reply).toBeDefined();
    expect(t.isMessage).toBe(true);
    expect(t.complete).toBe(false);
  });

  it('completes successfully when a message says TRANS03', () => {
    // ft_dft.c:267-270: END_TRANSFER means ft_complete(NULL), a clean finish.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const step = t.handle(dataInsert(ascii('TRANS03')));
    expect(step.done).toEqual({ ok: true, data: new Uint8Array(0) });
  });

  it('fails with the host\'s own message text when a message is not TRANS03', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const step = t.handle(dataInsert(ascii('TRANS99 - Protocol error')));
    expect(step.done?.ok).toBe(false);
    expect(step.done).toMatchObject({ error: 'TRANS99 - Protocol error' });
  });

  it('truncates a message at a dollar sign, as x3270 does', () => {
    // ft_dft.c:258-265: memchr for '$' becomes the terminator.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    expect(t.handle(dataInsert(ascii('TRANS99 oops$ignored'))).done)
      .toMatchObject({ error: 'TRANS99 oops' });
  });

  it('matches TRANS03 as a PREFIX, because the host appends its own text', () => {
    // x3270 uses memcmp over strlen(END_TRANSFER) (ft_dft.c:268 -- memcmp over strlen), not a full
    // comparison -- so a real host's "TRANS03 file transfer complete" is a
    // SUCCESS. An equality test here would report every successful transfer as a
    // failure carrying the success message as its error, which is the sort of
    // inversion that only shows up against a live host.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const step = t.handle(dataInsert(ascii('TRANS03 file transfer complete')));
    expect(step.done?.ok).toBe(true);
  });

  it('sends NOTHING for Set Cursor and Insert, because x3270 sends nothing', () => {
    // Both x3270 handlers are empty functions that trace and return
    // (ft_dft.c:193-198, :414-419). Replying would put unsolicited bytes on the
    // wire to a live mainframe mid-transfer, so `reply` must be absent -- not an
    // Open ack, which is what an earlier draft of the plan wrongly specified.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    for (const req of [DftRequest.SET_CUR, DftRequest.INSERT]) {
      const step = t.handle(bare(req));
      expect(step.reply).toBeUndefined();
      expect(step.done).toBeUndefined();
    }
    expect(t.complete).toBe(false);
  });

  it('is inert after completion, and keeps reporting the same outcome', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    const done = t.handle(dataInsert(ascii('TRANS03'))).done;
    const after = t.handle(dataInsert([0x41]));
    expect(after.reply).toBeUndefined();
    expect(after.done).toEqual(done);
  });

  it('reports an unknown request type for tracing and sends NOTHING', () => {
    // x3270 traces Unsupported(0x%04x) and breaks (ft_dft.c:131-133). It does not
    // send an error reply, and an earlier draft of this plan wrongly said it did.
    // `unsupported` exists so the caller can trace it: a silent drop with nothing
    // in the log is how an unimplemented request becomes an unexplainable stall.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    const step = t.handle(bare(0x9999));
    expect(step.reply).toBeUndefined();
    expect(step.unsupported).toBe(0x9999);
    expect(step.done).toBeUndefined();
    expect(t.complete).toBe(false);
  });

  it('counts transferred bytes as they arrive, for a progress display', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    expect(t.transferred).toBe(0);
    t.handle(dataInsert([0x41, 0x42, 0x43]));
    expect(t.transferred).toBe(3);
    t.handle(dataInsert([0x44]));
    expect(t.transferred).toBe(4);
  });

  it('tolerates an empty data frame without pushing an empty chunk', () => {
    // A declared length of exactly 5 means zero data bytes. x3270 guards its file
    // write with `if (my_length > 0)` (ft_dft.c:284) and still acknowledges
    // (dft_data_ack at :410 sits OUTSIDE that block, which closes at :407), so an empty frame is acked, not an error.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    const step = t.handle(dataInsert([]));
    expect(step.reply).toBeDefined();
    expect(t.transferred).toBe(0);
    expect(step.done).toBeUndefined();
  });
});

describe('DftTransfer, cancellation', () => {
  it('defers the abort to the next inbound data frame, as x3270 does', () => {
    // ft_dft.c:225-228: the flag is tested at the TOP of dft_data_insert, so the
    // abort rides out on the next frame rather than being sent immediately. CUT
    // sends immediately by our own deliberate choice, because a front end closing
    // a form has no later frame to wait on; a DFT transfer always has one.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.cancel();
    expect(t.complete).toBe(false);          // nothing sent yet
    const step = t.handle(dataInsert([0x41]));
    expect([...step.reply!]).toEqual([0x88, 0x00, 0x09, 0xd0, 0x47, 0x08, 0x69, 0x04, 0x01, 0x00]);
    expect(step.done).toMatchObject({ ok: false, error: 'Transfer canceled by user' });
  });

  it('borrows the failed request\'s high byte in the abort, so DATA_INSERT gives 0x47', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.cancel();
    expect([...t.handle(dataInsert([0x41])).reply!].slice(4, 6)).toEqual([0x47, 0x08]);
  });

  it('still reads the host\'s own final message after a cancel', () => {
    // `!message_flag &&` in the guard (ft_dft.c:225) is what makes this work: once
    // the host has opened FT:MSG, its text is read rather than refused. That text
    // is the only channel carrying the host's side of the failure.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    t.cancel();
    const step = t.handle(dataInsert(ascii('TRANS99 - canceled')));
    expect(step.done).toMatchObject({ ok: false, error: 'TRANS99 - canceled' });
  });

  it('is idempotent', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.cancel();
    t.cancel();
    expect(t.handle(dataInsert([0x41])).done?.ok).toBe(false);
  });
});

describe('DftTransfer, construction', () => {
  it('refuses a send with no data', () => {
    expect(() => new DftTransfer({ direction: 'send' })).toThrow(TypeError);
  });

  it('refuses a receive that was handed data', () => {
    expect(() => new DftTransfer({ direction: 'receive', data: Uint8Array.of(1) }))
      .toThrow(TypeError);
  });

  it('accepts a send with data, from an array or a Uint8Array', () => {
    expect(new DftTransfer({ direction: 'send', data: [1, 2] }).direction).toBe('send');
    expect(new DftTransfer({ direction: 'send', data: Uint8Array.of(1) }).direction).toBe('send');
  });
});

describe('DftTransfer, upload (send)', () => {
  it('answers a Get with a data frame carrying the file bytes', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41, 0x42, 0x43) });
    t.handle(open());
    const step = t.handle(bare(DftRequest.GET));
    const b = [...step.reply!];
    // The whole frame, computed by hand from ft_dft.c:624-641. Pinned entire
    // rather than field-by-field only, because the SF LENGTH is the byte most
    // likely to be wrong: it is 16+data, EXCLUDING the AID (obptr - (obuf+1),
    // ft_dft.c:654-655), while the data still lands at index 17.
    expect(b).toEqual([
      0x88, 0x00, 0x13, 0xd0, 0x46, 0x05, 0x63, 0x06, 0x00, 0x00, 0x00, 0x01,
      0xc0, 0x80, 0x61, 0x00, 0x08, 0x41, 0x42, 0x43,
    ]);
    expect(b[0]).toBe(0x88);                       // AID_SF
    expect(b.slice(1, 3)).toEqual([0x00, 0x13]);   // 3 data + 16, not + 17
    expect(b[3]).toBe(0xd0);                       // SF_TRANSFER_DATA
    expect(b.slice(4, 6)).toEqual([0x46, 0x05]);   // TR_GET_REPLY
    expect(b.slice(6, 8)).toEqual([0x63, 0x06]);   // TR_RECNUM_HDR
    expect(b.slice(8, 12)).toEqual([0x00, 0x00, 0x00, 0x01]);
    expect(b.slice(12, 14)).toEqual([0xc0, 0x80]); // TR_NOT_COMPRESSED
    expect(b[14]).toBe(0x61);                      // TR_BEGIN_DATA
    expect(b.slice(15, 17)).toEqual([0x00, 0x08]); // 3 data bytes + 5
    expect(b.slice(17)).toEqual([0x41, 0x42, 0x43]);
  });

  it('declares a length that EXCLUDES the AID but puts data at index 17', () => {
    // The two numbers that look contradictory and are both right: the header is 17
    // bytes counting the AID, so data starts at 17 (x3270's `bufptr = obuf + 17`,
    // :584), while the declared length omits the AID and is therefore 16 + data.
    // Checked across three sizes so the relationship is pinned, not one instance.
    for (const n of [1, 3, 200]) {
      const t = new DftTransfer({ direction: 'send', data: new Uint8Array(n).fill(0x7b) });
      t.handle(open());
      const b = [...t.handle(bare(DftRequest.GET)).reply!];
      expect((b[1]! << 8) | b[2]!).toBe(n + 16);
      expect(b).toHaveLength(n + 17);
      expect(b.slice(17)).toHaveLength(n);
      expect((b[15]! << 8) | b[16]!).toBe(n + 5);
    }
  });

  it('sends an EOF frame when the source is exhausted, and that is not a failure', () => {
    // ft_dft.c:644-651: HIGH8(TR_GET_REQ), TR_ERROR_REPLY, TR_ERROR_HDR,
    // TR_ERR_EOF. 0x2200 is "get past end of file", which ENDS an upload cleanly.
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    t.handle(bare(DftRequest.GET));
    const eof = t.handle(bare(DftRequest.GET));
    expect([...eof.reply!]).toEqual([
      0x88, 0x00, 0x09, 0xd0, 0x46, 0x08, 0x69, 0x04, 0x22, 0x00,
    ]);
    // EOF does not end the transfer, and neither will the Close that follows it:
    // an upload completes the same way a download does, on the host's own FT:MSG
    // TRANS03. Reporting success at EOF would claim the host had committed the
    // file when we had only finished handing it over.
    expect(eof.done).toBeUndefined();
  });

  it('distinguishes the EOF frame from an ABORT by one byte, the error code', () => {
    // Both are 10 bytes with SF length 9 and differ only in the last two: EOF is
    // 0x2200 (TR_ERR_EOF) and an abort is 0x0100 (TR_ERR_CMDFAIL). Pinned together
    // because confusing them is how a clean end of upload becomes a reported
    // failure -- or worse, an abort gets read by the host as a normal EOF.
    const eofT = new DftTransfer({ direction: 'send', data: new Uint8Array(0) });
    eofT.handle(open());
    const eof = [...eofT.handle(bare(DftRequest.GET)).reply!];

    const abortT = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    abortT.handle(open());
    abortT.cancel();
    const abort = [...abortT.handle(bare(DftRequest.GET)).reply!];

    expect(eof.slice(0, 8)).toEqual(abort.slice(0, 8));   // identical up to the code
    expect(eof.slice(8)).toEqual([0x22, 0x00]);
    expect(abort.slice(8)).toEqual([0x01, 0x00]);
  });

  it('completes an upload on the host\'s message, not at EOF or Close', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    t.handle(bare(DftRequest.GET));
    expect(t.handle(bare(DftRequest.GET)).done).toBeUndefined();   // EOF
    expect(t.handle(bare(DftRequest.CLOSE)).done).toBeUndefined(); // CloseAck
    t.handle(open('FT:MSG'));
    const step = t.handle(dataInsert(ascii('TRANS03')));
    expect(step.done).toEqual({ ok: true });     // no `data` on a send
    expect(t.transferred).toBe(1);
  });

  it('splits a source larger than the buffer across several Gets', () => {
    // CORRECTED FROM THE PLAN, which got this test wrong twice: it used a 100-byte
    // source against a 273-byte frame, so nothing was SPLIT despite the name, and
    // it looked for the EOF header at index 8-10 where it lives at 6-8 (the frame
    // is 88 00 09 d0 46 08 | 69 04 | 22 00, so 8-10 is the error CODE).
    // 600 bytes over 273-byte frames is 3 frames: 273 + 273 + 54.
    const data = new Uint8Array(600).fill(0x5a);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 300 });
    t.handle(open());
    expect([...t.handle(bare(DftRequest.GET)).reply!].slice(17)).toHaveLength(273);
    expect([...t.handle(bare(DftRequest.GET)).reply!].slice(17)).toHaveLength(273);
    expect([...t.handle(bare(DftRequest.GET)).reply!].slice(17)).toHaveLength(54);
    const eof = t.handle(bare(DftRequest.GET));
    expect([...eof.reply!].slice(6, 8)).toEqual([0x69, 0x04]);   // TR_ERROR_HDR
    expect([...eof.reply!].slice(8, 10)).toEqual([0x22, 0x00]);  // TR_ERR_EOF
  });

  it('honours the buffer size, reserving 27 bytes as x3270 does', () => {
    // ft_dft.c:583 `numbytes = ftc->dft_buffersize - 27`.
    const data = new Uint8Array(500).fill(0x01);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 300 });
    t.handle(open());
    expect([...t.handle(bare(DftRequest.GET)).reply!].slice(17)).toHaveLength(273);
    expect(t.transferred).toBe(273);
  });

  it('numbers successive upload frames 1, 2, 3', () => {
    const data = new Uint8Array(600).fill(0x02);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 283 });  // 256 data
    t.handle(open());
    for (const expected of [1, 2, 3]) {
      const b = [...t.handle(bare(DftRequest.GET)).reply!];
      expect(b.slice(8, 12)).toEqual([0x00, 0x00, 0x00, expected]);
    }
    expect(t.transferred).toBe(600);
  });

  it('delivers the source byte for byte across several frames', () => {
    // The property that matters to a user: what arrives is what was sent. Built
    // from a pattern so a dropped, duplicated or reordered chunk shows up.
    const data = Uint8Array.from({ length: 700 }, (_, i) => i & 0xff);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 283 });
    t.handle(open());
    const sent: number[] = [];
    for (;;) {
      const b = [...t.handle(bare(DftRequest.GET)).reply!];
      if (b[5] === 0x08) break;                  // TR_ERROR_REPLY: EOF
      sent.push(...b.slice(17));
    }
    expect(sent).toEqual([...data]);
  });

  it('CLAMPS the buffer size to x3270\'s bounds, so a tiny one cannot starve a frame', () => {
    // set_dft_buffersize bounds every assignment (ft_dft.c:740-747, DFT_MIN_BUF
    // 256), and boundDftBufferSize already existed in queryreply.ts for the DDM
    // advertisement. Reusing it is not tidiness: the size we ADVERTISE to the host
    // and the size we CHUNK by must be the same number, or we promise one frame
    // size and send another.
    const data = new Uint8Array(400).fill(0x03);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 10 });
    t.handle(open());
    // Clamped to 256, so 256-27 = 229 data bytes rather than a frame with no room.
    expect([...t.handle(bare(DftRequest.GET)).reply!].slice(17)).toHaveLength(229);
  });

  it('clamps an over-large buffer size down to DFT_MAX_BUF', () => {
    const t = new DftTransfer({ direction: 'send', data: new Uint8Array(1), bufferSize: 99999 });
    expect(t.bufferSize).toBe(32767);
  });

  it('defaults the buffer size to x3270\'s DFT_BUF', () => {
    const t = new DftTransfer({ direction: 'send', data: new Uint8Array(1) });
    expect(t.bufferSize).toBe(16384);
  });

  it('retains the last upload frame for a Read Modified', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    const sent = t.handle(bare(DftRequest.GET)).reply!;
    expect(t.retainedFrame).toEqual(sent);
  });

  it('retains the EOF frame too, since x3270 saves both branches', () => {
    // The savebuf copy at ft_dft.c:657-663 is AFTER the if/else, so an EOF frame is
    // retained exactly as a data frame is. A Read Modified arriving after EOF must
    // re-send the EOF, not the last data frame -- which would re-send data the host
    // already has.
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    const data = t.handle(bare(DftRequest.GET)).reply!;
    const eof = t.handle(bare(DftRequest.GET)).reply!;
    expect(t.retainedFrame).toEqual(eof);
    expect(t.retainedFrame).not.toEqual(data);
  });

  it('has no retained frame before the first Get', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    expect(t.retainedFrame).toBeUndefined();
  });

  it('does not advance the offset when it replies EOF', () => {
    // An EOF that advanced `offset` would make `transferred` overstate what the
    // host received, which is what a progress display reads.
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41, 0x42) });
    t.handle(open());
    t.handle(bare(DftRequest.GET));
    expect(t.transferred).toBe(2);
    t.handle(bare(DftRequest.GET));
    t.handle(bare(DftRequest.GET));
    expect(t.transferred).toBe(2);
  });

  it('refuses a Get after cancellation, with the user-cancel message', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    t.cancel();
    const step = t.handle(bare(DftRequest.GET));
    expect(step.done).toEqual({ ok: false, error: 'Transfer canceled by user' });
    expect([...step.reply!].slice(4, 6)).toEqual([0x46, 0x08]);
  });
});
