import { describe, it, expect } from 'vitest';
import { parseStructuredFields } from '../src/stream/sf.js';
import { Session, type Connection, type SessionOptions } from '../src/session.js';
import { DftTransfer } from '../src/ft/dft.js';
import { TelnetCmd as T, TelnetOpt as O, TelnetSubopt as S, Qcode } from '../src/constants.js';
import { ddmCapability } from '../src/queryreply.js';

describe('parseStructuredFields, SF_TRANSFER_DATA', () => {
  it('yields a transferData variant, not an unknownSf', () => {
    // A 6-byte field: length 0x0006, SFID 0xd0, then 3 payload bytes.
    const sf = parseStructuredFields(Uint8Array.of(0x00, 0x06, 0xd0, 0x00, 0x12, 0xff));
    expect(sf).toHaveLength(1);
    expect(sf[0]!.kind).toBe('transferData');
  });

  it('strips the length bytes and the SFID, which is the offset contract', () => {
    // THE test for the -3. The host declares 6; we must see 3 payload bytes.
    const sf = parseStructuredFields(Uint8Array.of(0x00, 0x06, 0xd0, 0x00, 0x12, 0xff));
    const field = sf[0]!;
    if (field.kind !== 'transferData') throw new Error('wrong variant');
    expect([...field.payload]).toEqual([0x00, 0x12, 0xff]);
  });

  it('reproduces the live probe\'s own lengths: 0x29 field -> 38-byte payload', () => {
    // TK5 sent field lengths 0x29 and 0x23 and our trace reported 38B and 32B.
    // That measurement is what this assertion encodes.
    for (const [declared, expected] of [[0x29, 38], [0x23, 32]] as const) {
      const field = new Uint8Array(declared);
      field[0] = (declared >> 8) & 0xff;
      field[1] = declared & 0xff;
      field[2] = 0xd0;
      const sf = parseStructuredFields(field);
      const f = sf[0]!;
      if (f.kind !== 'transferData') throw new Error('wrong variant');
      expect(f.payload).toHaveLength(expected);
    }
  });

  it('COPIES the payload, so a retained one cannot be mutated behind us', () => {
    // dft.ts keeps received chunks, and Session keeps a transfer across records.
    // A subarray would alias the inbound buffer; this asserts the copy by mutating
    // the source afterwards. Without it, `Uint8Array.from` could be "simplified"
    // to a subarray and nothing would fail here.
    const buf = Uint8Array.of(0x00, 0x06, 0xd0, 0x00, 0x12, 0xff);
    const sf = parseStructuredFields(buf);
    const f = sf[0]!;
    if (f.kind !== 'transferData') throw new Error('wrong variant');
    buf[3] = 0x99;
    buf[4] = 0x99;
    expect([...f.payload]).toEqual([0x00, 0x12, 0xff]);
  });

  it('yields several transferData fields from one record, in order', () => {
    // One WriteStructuredField may carry more than one field. Distinct payloads so
    // a dropped or reordered field is visible.
    const sf = parseStructuredFields(Uint8Array.of(
      0x00, 0x05, 0xd0, 0x00, 0x12,
      0x00, 0x05, 0xd0, 0x41, 0x12,
    ));
    expect(sf).toHaveLength(2);
    expect(sf.map((f) => f.kind)).toEqual(['transferData', 'transferData']);
    const payloads = sf.map((f) => (f.kind === 'transferData' ? [...f.payload] : null));
    expect(payloads).toEqual([[0x00, 0x12], [0x41, 0x12]]);
  });
});

/** An in-memory connection that records what the session sends. */
class FakeConnection implements Connection {
  sent: number[] = [];
  closed = false;
  onData: ((b: Uint8Array) => void) | undefined;
  onClose: (() => void) | undefined;
  onError: ((e: Error) => void) | undefined;

  write(b: Uint8Array): void { this.sent.push(...b); }
  close(): void { this.closed = true; this.onClose?.(); }

  /** Test helper: pretend the host sent these bytes. */
  host(...bytes: number[]): void { this.onData?.(Uint8Array.from(bytes)); }

  /** Negotiate into 3270 mode the way a real host does. */
  negotiate(): void {
    this.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    this.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    this.host(T.IAC, T.DO, O.EOR, T.IAC, T.WILL, O.EOR);
    this.host(T.IAC, T.DO, O.BINARY, T.IAC, T.WILL, O.BINARY);
    this.sent = [];
  }
}

function newSession(opts: Partial<SessionOptions> = {}) {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn, ...opts });
  return { session, conn };
}

/**
 * The bytes of a WriteStructuredField record carrying one DFT frame, as a host
 * sends them: WSF command, then `L L SFID payload`, then IAC EOR.
 * The declared length counts itself and the SFID, hence +3.
 */
function wsfBytes(payload: number[]): number[] {
  const len = payload.length + 3;
  return [0xf3, (len >> 8) & 0xff, len & 0xff, 0xd0, ...payload, 0xff, 0xef];
}

/** An Open payload, for driving a real transfer through the session. */
function openPayload(name = 'FT:DATA'): number[] {
  // Field is 0x23 bytes; the payload we pass to wsfBytes excludes L L SFID, so
  // 0x20 bytes, with the name at payload offset 25. See dftFrames.ts on why 25.
  const p = new Array<number>(0x23 - 3).fill(0x00);
  p[0] = 0x00;
  p[1] = 0x12;
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) p[25 + i] = padded.charCodeAt(i);
  return p;
}

describe('Session DFT plumbing', () => {
  it('ignores a frame with no transfer in flight, and does NOT throw', async () => {
    // A host can send this at any time. handleRecord rethrows non-protocol errors
    // as our own bug and drops the connection, so a throw here would be a
    // remotely-triggerable disconnect.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(() => conn.host(...wsfBytes([0x00, 0x12]))).not.toThrow();
    expect(session.isConnected()).toBe(true);
  });

  it('TRACES the no-transfer case distinctly, which is the only thing that guard does', async () => {
    // THE GUARD IS UNFALSIFIABLE WITHOUT THIS. Replacing it with `this.dft!` left
    // all 13 tests green, because the catch below swallows the resulting TypeError
    // and the observable outcome -- no reply, still connected -- is identical. The
    // two paths differ ONLY in the trace, so the trace is what has to be asserted.
    //
    // It matters because the messages mean different things to whoever reads the
    // log: "no transfer in progress" is a host doing something unexpected, while
    // "DFT frame rejected: ..." is a frame we could not parse. Collapsing them
    // would send a future live-run diagnosis down the wrong path.
    const { session, conn } = newSession();
    session.trace.setEnabled(true);
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(...wsfBytes([0x00, 0x12]));
    const notes = session.trace.lines().filter((l) => l.includes('SF_TRANSFER_DATA'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('no transfer in progress');
    expect(session.trace.lines().some((l) => l.includes('rejected'))).toBe(false);
  });

  it('traces a malformed frame as REJECTED, not as an absent transfer', async () => {
    const { session, conn } = newSession();
    session.trace.setEnabled(true);
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.host(...wsfBytes([0x00]));
    expect(session.trace.lines().some((l) => l.includes('DFT frame rejected'))).toBe(true);
    expect(session.trace.lines().some((l) => l.includes('no transfer in progress'))).toBe(false);
  });

  it('traces an unimplemented request type, so it is not a silent stall', async () => {
    // `step.unsupported` is dead code without this: nothing else reads it, and an
    // unimplemented request would be a stall with an empty log. x3270 logs
    // Unsupported(0x%04x) for the same reason.
    const { session, conn } = newSession();
    session.trace.setEnabled(true);
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.host(...wsfBytes(openPayload()));
    conn.sent = [];
    conn.host(...wsfBytes([0x99, 0x99]));
    expect(session.trace.lines().some((l) => l.includes('0x9999') && l.includes('not implemented')))
      .toBe(true);
    expect(conn.sent).toEqual([]);              // and still nothing on the wire
  });

  it('does not throw on a malformed frame either; it ends the transfer', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    // One byte: too short for a request type, so parseDftFrame throws inside.
    expect(() => conn.host(...wsfBytes([0x00]))).not.toThrow();
    expect(session.dftTransfer).toBeUndefined();
    expect(session.isConnected()).toBe(true);
  });

  it('puts the engine\'s reply ON THE WIRE, which is the whole point of the task', async () => {
    // The plan's two tests only assert that nothing broke. This asserts the
    // plumbing actually plumbs: an Open in, an OpenAck out. Without it every
    // refusal could pass while no reply ever reached the host -- the shape of
    // defect this repo has recorded as a harness that scores a client that never
    // started.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.host(...wsfBytes(openPayload()));
    // The OpenAck, then IAC EOR that sendInbound appends.
    expect(conn.sent).toEqual([0x88, 0x00, 0x05, 0xd0, 0x00, 0x09, 0xff, 0xef]);
  });

  it('runs a whole download through the session and hands over the bytes', async () => {
    // End to end over real wire bytes: Open, data, Close, Open(FT:MSG), TRANS03.
    // This is the only test that exercises the arrival ORDER through the session,
    // and it is what proves one transfer survives its own Close in situ rather
    // than only in a unit test of the engine.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    const transfer = new DftTransfer({ direction: 'receive' });
    session.startDftTransfer(transfer);

    const dataInsert = (bytes: number[]): number[] => [
      0x47, 0x04, 0xc0, 0x80, 0x61,
      ((bytes.length + 5) >> 8) & 0xff, (bytes.length + 5) & 0xff, ...bytes,
    ];

    conn.host(...wsfBytes(openPayload()));
    conn.host(...wsfBytes(dataInsert([0x41, 0x42])));
    conn.host(...wsfBytes(dataInsert([0x43])));
    conn.host(...wsfBytes([0x41, 0x12]));                    // Close
    conn.host(...wsfBytes(openPayload('FT:MSG')));
    conn.host(...wsfBytes(dataInsert([...'TRANS03'].map((c) => c.charCodeAt(0)))));

    expect(transfer.result).toEqual({ ok: true, data: Uint8Array.of(0x41, 0x42, 0x43) });
    // Cleared on completion, so a later stray frame is ignored rather than fed to
    // a finished transfer.
    expect(session.dftTransfer).toBeUndefined();
    expect(session.isConnected()).toBe(true);
  });

  it('delivers SEVERAL frames from ONE record, not just the first', async () => {
    // transferData is an array for this reason. If the session took only the first
    // field, the second record's data would vanish with no error anywhere -- a
    // silently truncated file.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    const transfer = new DftTransfer({ direction: 'receive' });
    session.startDftTransfer(transfer);
    conn.host(...wsfBytes(openPayload()));
    conn.sent = [];
    // Two Data Inserts in ONE WriteStructuredField record.
    const di = (bytes: number[]): number[] => {
      const p = [0x47, 0x04, 0xc0, 0x80, 0x61,
        ((bytes.length + 5) >> 8) & 0xff, (bytes.length + 5) & 0xff, ...bytes];
      return [(p.length + 3 >> 8) & 0xff, (p.length + 3) & 0xff, 0xd0, ...p];
    };
    conn.host(0xf3, ...di([0x41]), ...di([0x42]), 0xff, 0xef);
    // Two acks, records 1 and 2, each followed by IAC EOR.
    expect(conn.sent.filter((b) => b === 0x88)).toHaveLength(2);
    expect(transfer.transferred).toBe(2);
  });

  it('emits transferEnd when a transfer finishes', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    let ended = 0;
    session.on('transferEnd', () => { ended++; });
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.host(...wsfBytes(openPayload('FT:MSG')));
    expect(ended).toBe(0);
    const di = [0x47, 0x04, 0xc0, 0x80, 0x61, 0x00, 0x0c,
      ...[...'TRANS03'].map((c) => c.charCodeAt(0))];
    conn.host(...wsfBytes(di));
    expect(ended).toBe(1);
  });

  it('answers a host Get with our data, the upload direction through the session', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(
      new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41, 0x42, 0x43) }));
    conn.host(...wsfBytes(openPayload()));
    conn.sent = [];
    conn.host(...wsfBytes([0x46, 0x11]));                    // TR_GET_REQ
    expect(conn.sent).toEqual([
      0x88, 0x00, 0x13, 0xd0, 0x46, 0x05, 0x63, 0x06, 0x00, 0x00, 0x00, 0x01,
      0xc0, 0x80, 0x61, 0x00, 0x08, 0x41, 0x42, 0x43, 0xff, 0xef,
    ]);
  });

  it('sends NOTHING for a Set Cursor arriving through the session', async () => {
    // The silence has to survive the plumbing too: a session that acknowledged
    // everything would undo dft.ts's careful refusal and put unsolicited bytes on
    // the wire to a live mainframe.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.host(...wsfBytes(openPayload()));
    conn.sent = [];
    conn.host(...wsfBytes([0x45, 0x11]));                    // TR_SET_CUR_REQ
    expect(conn.sent).toEqual([]);
    expect(session.dftTransfer).toBeDefined();               // still in flight
  });
});

describe('the Read Modified hook', () => {
  /** A session with a retained upload frame: negotiated, opened, one Get answered. */
  async function uploading() {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    const transfer = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    session.startDftTransfer(transfer);
    conn.host(...wsfBytes(openPayload()));  // Open
    conn.host(...wsfBytes([0x46, 0x11]));   // Get -> retains a frame
    expect(transfer.retainedFrame).toBeDefined();   // the premise, asserted
    conn.sent = [];
    return { session, conn, transfer };
  }

  it('replays the retained upload frame instead of reading the screen', async () => {
    // x3270 short-circuits to dft_read_modified when the AID is AID_SF, at BOTH
    // read sites: ctlr.c:760 in ctlr_read_modified and ctlr.c:986 in
    // ctlr_read_buffer. Omitting this stalls UPLOADS ONLY -- downloads never take
    // this path -- which is why it gets its own task and its own test.
    const { conn, transfer } = await uploading();
    conn.host(0xf6, 0xff, 0xef);            // Read Modified
    // The retained frame, then IAC EOR that sendInbound appends.
    expect(conn.sent.slice(0, transfer.retainedFrame!.length))
      .toEqual([...transfer.retainedFrame!]);
  });

  it('replays on a Read Buffer too, the second of x3270\'s two sites', async () => {
    const { conn, transfer } = await uploading();
    conn.host(0xf2, 0xff, 0xef);            // Read Buffer
    expect(conn.sent.slice(0, transfer.retainedFrame!.length))
      .toEqual([...transfer.retainedFrame!]);
  });

  it('replays the SAME frame twice, without advancing the upload', async () => {
    // A replay must not consume more source: the host is asking again for what it
    // already asked for. If the hook read from the engine instead of the retained
    // bytes, the second read would deliver the NEXT chunk and the file would be
    // corrupt -- with both reads "succeeding".
    const { conn, transfer } = await uploading();
    const before = transfer.transferred;
    conn.host(0xf6, 0xff, 0xef);
    const first = [...conn.sent];
    conn.sent = [];
    conn.host(0xf6, 0xff, 0xef);
    expect([...conn.sent]).toEqual(first);
    expect(transfer.transferred).toBe(before);
  });

  it('reads the screen normally when there is no retained frame', async () => {
    // A DOWNLOAD retains nothing, so the hook must not swallow an ordinary read.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.sent = [];
    conn.host(0xf6, 0xff, 0xef);
    expect(conn.sent[0]).not.toBe(0x88);    // AID.SF -- i.e. not a replay
    expect(conn.sent.length).toBeGreaterThan(0);   // it DID answer
  });

  it('reads the screen normally with NO transfer at all', async () => {
    // The commonest case by far, and the one a wrong guard would break for every
    // user who never transfers a file. `this.dft?.retainedFrame` must be undefined
    // rather than throwing.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent = [];
    conn.host(0xf6, 0xff, 0xef);
    expect(conn.sent[0]).not.toBe(0x88);
    expect(conn.sent.length).toBeGreaterThan(0);
  });
});

/**
 * Split a Query Reply record into its units: `{ qcode, body }` each.
 *
 * The same walk `queryreply.test.ts` uses, and the reason it is worth copying is the
 * lesson from writing these tests: scanning the raw record for a QCODE byte with
 * indexOf matches payload bytes that happen to equal it. Parse the structure.
 */
function replyUnits(sent: number[]): { qcode: number; body: number[] }[] {
  // The record is the reply followed by IAC EOR, which sendInbound appends.
  //
  // AND EVERY 0xff IN THE PAYLOAD ARRIVES DOUBLED, because 0xff is the telnet escape
  // and sendRecord's doubleIac() escapes it. Undoubling is not optional here: a
  // Query Reply is full of 0xff (Usable Area's flags, Highlighting's pairs), and a
  // walk over the raw bytes reads a doubled pair as part of a length. My first
  // version did exactly that and reported a unit of length 65535, which looked like
  // a product bug and was a test bug. Measured, not guessed: a direct probe showed
  // the real reply is 4 units with Summary growing 9 -> 10 bytes when DDM is on.
  const raw = sent.slice(0, -2);
  const bytes: number[] = [];
  for (let k = 0; k < raw.length; k++) {
    bytes.push(raw[k]!);
    if (raw[k] === 0xff && raw[k + 1] === 0xff) k++;
  }
  const out: { qcode: number; body: number[] }[] = [];
  let i = 1;                                  // skip the AID
  while (i < bytes.length) {
    const len = (bytes[i]! << 8) | bytes[i + 1]!;
    if (len < 4) throw new Error(`bogus unit length ${len} at offset ${i}`);
    out.push({ qcode: bytes[i + 3]!, body: bytes.slice(i + 4, i + len) });
    i += len;
  }
  return out;
}

describe('the DDM advertisement through a Session', () => {
  /**
   * Drive a real Read Partition (Query) from the host and return what we replied.
   *
   * THIS EXISTS BECAUSE THE CONSTANT-LEVEL TESTS CANNOT CATCH THE REAL DEFECT.
   * Measured 2026-09-25: replacing `this.opts.ddm ? withDdm(...) : DEFAULT_CAPABILITIES`
   * with an unconditional `withDdm(...)` left ALL 2071 tests green -- including the six
   * new ones in queryreply.test.ts, which test the CONSTANT and the helper, not the
   * session's choice between them.
   *
   * That mutation is not a cosmetic one. Advertising DDM changes which protocol a
   * LIVE HOST speaks: TK5 offers DFT on seeing 0x95 and stays on CUT without it. So
   * the unfalsified line was the one standing between `npm test` being green and
   * every CUT live witness in this project being invalidated.
   */
  async function queryReplyBytes(opts: Partial<SessionOptions>): Promise<number[]> {
    const { session, conn } = newSession(opts);
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent = [];
    // WriteStructuredField carrying Read Partition: L L SFID=0x01, PID=0xff,
    // TYPE=0x02 (Query).
    //
    // THE PID IS SENT AS `IAC IAC`, NOT A LONE 0xff. 0xff is the telnet escape, so a
    // bare one is consumed by the telnet layer and the record silently never arrives
    // -- which is exactly what happened when this test was first written: all four
    // cases failed with NOTHING on the wire, which reads like a broken product rather
    // than a malformed test input. session.test.ts:859 spells it the same way.
    conn.host(0xf3, 0x00, 0x05, 0x01, T.IAC, T.IAC, 0x02, T.IAC, T.EOR);
    return conn.sent;
  }

  it('puts NO 0x95 on the wire by default, which is what keeps live hosts on CUT', async () => {
    const sent = await queryReplyBytes({});
    expect(sent.length).toBeGreaterThan(0);          // it DID reply
    expect(sent).not.toContain(0x95);
  });

  it('puts 0x95 on the wire with ddm on', async () => {
    const sent = await queryReplyBytes({ ddm: true });
    expect(sent).toContain(0x95);
  });

  it('adds DDM as its own unit AND to the summary, changing nothing else', async () => {
    // MEASURED with a direct probe after two wrong guesses, and the numbers are worth
    // recording: a plain Query reply is 5 units, and `-ddm on` makes it 6 --
    // 0x80(10) 0x81(23) 0x86(38) 0x87(15) 0x95(12) 0xa6(17), against
    // 0x80(9) 0x81(23) 0x86(38) 0x87(15) 0xa6(17) by default.
    //
    // So DDM does two things and both are pinned: it appends its own 12-byte unit
    // BEFORE Implicit Partition (0x95 < 0xa6, so order is preserved), and it adds one
    // byte to the Summary's qcode list. Everything else is byte-identical, which is
    // what makes this an ADDITION rather than a protocol change dressed as one.
    const off = replyUnits(await queryReplyBytes({}));
    const on = replyUnits(await queryReplyBytes({ ddm: true }));
    expect(off.map((u) => u.qcode)).toEqual([0x80, 0x81, 0x86, 0x87, 0xa6]);
    expect(on.map((u) => u.qcode)).toEqual([0x80, 0x81, 0x86, 0x87, 0x95, 0xa6]);

    // The summary lists the qcodes, so it grows by exactly one and stays sorted.
    expect(off[0]!.body).not.toContain(0x95);
    expect(on[0]!.body).toContain(0x95);
    expect(on[0]!.body).toHaveLength(off[0]!.body.length + 1);
    expect([...on[0]!.body]).toEqual([...on[0]!.body].sort((a, b) => a - b));

    // Every other unit is untouched, matched by qcode so a reorder cannot hide.
    for (const u of off.slice(1)) {
      expect(on.find((v) => v.qcode === u.qcode)).toEqual(u);
    }
  });

  it('honours dftBufferSize in the DDM unit it builds, clamped', async () => {
    // SessionOptions.dftBufferSize was documented as existing and set by nothing;
    // this is the first assertion that it reaches a built unit at all. Asserted on
    // ddmCapability rather than on a Query reply, because the DDM unit is announced
    // in the summary and sent when the host ASKS for 0x95 -- so the plain-Query reply
    // above is the wrong place to look for its bytes.
    const size = (n: number): number[] => ddmCapability(n).params();
    // 512 = 0x0200 as LIMIN and LIMOUT, after 2 reserved FLAGS bytes.
    expect(size(512)).toEqual([0x00, 0x00, 0x02, 0x00, 0x02, 0x00, 0x01, 0x01]);
    // 10 clamps up to DFT_MIN_BUF 256 = 0x0100; 99999 clamps down to 32767 = 0x7fff.
    expect(size(10).slice(2, 6)).toEqual([0x01, 0x00, 0x01, 0x00]);
    expect(size(99999).slice(2, 6)).toEqual([0x7f, 0xff, 0x7f, 0xff]);
    // A byte-order error would make 512 read as 2, so the pair is asserted whole.
    expect(size(512)[2]).toBe(0x02);
    expect(size(512)[3]).toBe(0x00);
  });
});
