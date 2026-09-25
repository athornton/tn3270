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
