import { describe, it, expect } from 'vitest';
import {
  Tn3270eOp, Tn3270eReason, Tn3270eFunc, Tn3270eDataType,
  Tn3270eRequestFlag, Tn3270eResponseFlag, Tn3270eSense,
} from '../src/constants.js';
import {
  encodeHeader, decodeHeader, carriesDatastream, TN3270E_HEADER_BYTES,
  initialState, negotiate, REQUESTED_FUNCTIONS, type Tn3270eState,
} from '../src/tn3270e.js';

/**
 * Values are RFC 2355 §3 (rfc2355.txt:317-347) and §8.1 (rfc2355.txt:969-1095),
 * cross-checked against x3270's include/tn3270e.h. Where the two disagree it is
 * noted on the constant itself; do not "fix" one to match the other without
 * reading both, because the disagreements are real rather than typos.
 */
describe('TN3270E wire constants', () => {
  it('names the subnegotiation operations', () => {
    expect(Tn3270eOp).toEqual({
      ASSOCIATE: 0x00, CONNECT: 0x01, DEVICE_TYPE: 0x02, FUNCTIONS: 0x03,
      IS: 0x04, REASON: 0x05, REJECT: 0x06, REQUEST: 0x07, SEND: 0x08,
    });
  });

  it('names the reason codes', () => {
    expect(Tn3270eReason).toEqual({
      CONN_PARTNER: 0x00, DEVICE_IN_USE: 0x01, INV_ASSOCIATE: 0x02,
      INV_NAME: 0x03, INV_DEVICE_TYPE: 0x04, TYPE_NAME_ERROR: 0x05,
      UNKNOWN_ERROR: 0x06, UNSUPPORTED_REQ: 0x07,
    });
  });

  it('names the functions, including the non-RFC extension', () => {
    expect(Tn3270eFunc).toEqual({
      BIND_IMAGE: 0x00, DATA_STREAM_CTL: 0x01, RESPONSES: 0x02,
      SCS_CTL_CODES: 0x03, SYSREQ: 0x04, CONTENTION_RESOLUTION: 0x05,
    });
  });

  it('does not claim function 6 exists', () => {
    // x3270 defines TN3270E_FUNC_SNA_SENSE = 6, which RFC 2355 §3 does not list. We
    // neither request nor grant it, and an inbound 6 is dropped as unrecognized per
    // §7.2.2 -- so defining it would imply support we do not have.
    expect(Object.values(Tn3270eFunc)).not.toContain(6);
  });

  it('names the data types', () => {
    expect(Tn3270eDataType).toEqual({
      DATA_3270: 0x00, SCS_DATA: 0x01, RESPONSE: 0x02, BIND_IMAGE: 0x03,
      UNBIND: 0x04, NVT_DATA: 0x05, REQUEST: 0x06, SSCP_LU_DATA: 0x07,
      PRINT_EOJ: 0x08,
    });
  });

  it('does not claim data type 0x09 exists', () => {
    // x3270 defines TN3270E_DT_BID = 0x09; RFC 2355 §8.1.1 stops at 0x08. An
    // inbound 0x09 is traced and dropped like any other type we do not implement.
    expect(Object.values(Tn3270eDataType)).not.toContain(0x09);
  });

  it('names the one REQUEST-FLAG value RFC 2355 defines', () => {
    // §8.1.2 lists ERR-COND-CLEARED and nothing else. x3270 additionally has
    // SEND_DATA 0x01, KEYBOARD_RESTORE 0x02 and SIGNAL 0x04 -- all of which are
    // only meaningful on a DATA-TYPE of REQUEST, which stage 2b does not handle.
    // THIS LIST IS NOT EXHAUSTIVE OF WHAT A HOST MAY SEND, only of what we send.
    expect(Tn3270eRequestFlag).toEqual({ ERR_COND_CLEARED: 0x00 });
  });

  it('names the header response flags, overloaded by data type', () => {
    expect(Tn3270eResponseFlag).toEqual({
      NO_RESPONSE: 0x00, ERROR_RESPONSE: 0x01, ALWAYS_RESPONSE: 0x02,
      POSITIVE_RESPONSE: 0x00, NEGATIVE_RESPONSE: 0x01,
    });
  });

  it('gives POSITIVE_RESPONSE and NO_RESPONSE the same value, deliberately', () => {
    // Not a copy-paste error. §8.1.3 defines the field's meaning by DATA-TYPE: on
    // 3270-DATA it says whether a response is wanted, on RESPONSE it says whether
    // this IS a positive one. Both spellings are kept because reading
    // `NO_RESPONSE` on an outbound record and `POSITIVE_RESPONSE` on a response is
    // what makes each call site say what it means.
    expect(Tn3270eResponseFlag.POSITIVE_RESPONSE).toBe(Tn3270eResponseFlag.NO_RESPONSE);
    expect(Tn3270eResponseFlag.NEGATIVE_RESPONSE).toBe(Tn3270eResponseFlag.ERROR_RESPONSE);
  });

  it('names the two sense codes a display session can reach', () => {
    // §10.4.1 (rfc2355.txt:1440-1462). x3270 also has INTERVENTION_REQUIRED 0x01
    // and COMPONENT_DISCONNECTED 0x03, whose RFC wording is "printer is not ready"
    // and "printer is powered off or not connected" -- unreachable from a display,
    // so omitted until the printer session lands.
    expect(Tn3270eSense).toEqual({ DEVICE_END: 0x00, COMMAND_REJECT: 0x00, OP_CHECK: 0x02 });
  });
});

describe('TN3270E header codec', () => {
  it('is five bytes', () => {
    // RFC 2355 §8.1, and x3270's EH_SIZE (include/tn3270e.h).
    expect(TN3270E_HEADER_BYTES).toBe(5);
  });

  it('encodes the outbound header real s3270 sends', () => {
    // Captured 2026-08-27: the inbound record after String(HI) Enter began
    // 00 00 00 00 00, and s3270's own trace logged
    // "SENT TN3270E(3270-DATA NO-RESPONSE 0)".
    const h = encodeHeader({
      dataType: Tn3270eDataType.DATA_3270,
      requestFlag: 0,
      responseFlag: Tn3270eResponseFlag.NO_RESPONSE,
      seq: 0,
    });
    expect([...h]).toEqual([0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it('encodes the positive response real s3270 sends', () => {
    // Also measured, config F of the harness validation: asked for ALWAYS-RESPONSE,
    // s3270 replied with a 6-byte record 02 00 00 00 00 00 -- this header plus one
    // 0x00 sense byte. The seq is copied from the message being answered.
    const h = encodeHeader({
      dataType: Tn3270eDataType.RESPONSE,
      requestFlag: 0,
      responseFlag: Tn3270eResponseFlag.POSITIVE_RESPONSE,
      seq: 0,
    });
    expect([...h]).toEqual([0x02, 0x00, 0x00, 0x00, 0x00]);
  });

  it('writes SEQ-NUMBER big-endian', () => {
    // §8.1.4: "must be sent in network byte order ("big endian")".
    const h = encodeHeader({
      dataType: Tn3270eDataType.DATA_3270, requestFlag: 0,
      responseFlag: Tn3270eResponseFlag.NO_RESPONSE, seq: 0x1234,
    });
    expect([...h]).toEqual([0x00, 0x00, 0x00, 0x12, 0x34]);
  });

  it('does NOT double 0xff itself — escaping belongs to the telnet layer', () => {
    // §8.1.4 does require a 0xff in SEQ-NUMBER to be doubled, and it will be: the
    // header is prepended to the payload and the whole record goes through
    // doubleIac() in telnet.ts. Doing it here as well would double it twice, and
    // would also corrupt any record whose 3270 payload contains a 0xff. The
    // end-to-end escaping is pinned at the session level, not here.
    const h = encodeHeader({
      dataType: Tn3270eDataType.DATA_3270, requestFlag: 0,
      responseFlag: Tn3270eResponseFlag.NO_RESPONSE, seq: 0x00ff,
    });
    expect([...h]).toEqual([0x00, 0x00, 0x00, 0x00, 0xff]);
  });

  it('keeps every field inside its own byte, whatever it is handed', () => {
    // This pins the OBSERVABLE CONTRACT, not the mechanism, and the distinction was
    // established by mutation: deleting the `& 0xff` from encodeHeader does NOT make
    // this fail, because Uint8Array.of() already truncates mod 256. So the explicit
    // masks in encodeHeader are documentation of intent rather than load-bearing
    // code, and this test would not catch their removal.
    //
    // It is kept anyway, because what matters to a host is that an over-large field
    // cannot bleed into its neighbour -- and that would break the day encodeHeader
    // is rewritten to build a number[] or write into a DataView, neither of which
    // truncates for you.
    const h = encodeHeader({
      dataType: 0x1_00, requestFlag: 0x1_00, responseFlag: 0x1_00, seq: 0x1_0000,
    });
    expect([...h]).toEqual([0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it('decodes a header, leaving the payload to the caller', () => {
    const rec = Uint8Array.of(0x00, 0x00, 0x02, 0x00, 0x07, 0x7d, 0x40, 0xc2);
    expect(decodeHeader(rec)).toEqual({
      dataType: Tn3270eDataType.DATA_3270,
      requestFlag: 0x00,
      responseFlag: Tn3270eResponseFlag.ALWAYS_RESPONSE,
      seq: 0x0007,
    });
  });

  it('round-trips the recorded inbound record', () => {
    // 00000000007d40c2c8c9, measured from s3270 in five harness configurations.
    const rec = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00,
      0x7d, 0x40, 0xc2, 0xc8, 0xc9);
    const h = decodeHeader(rec)!;
    expect([...encodeHeader(h)]).toEqual([...rec.subarray(0, TN3270E_HEADER_BYTES)]);
    expect([...rec.subarray(TN3270E_HEADER_BYTES)]).toEqual([0x7d, 0x40, 0xc2, 0xc8, 0xc9]);
  });

  it('returns null for a record too short to hold a header', () => {
    // Four bytes is not a truncated 3270-DATA message, it is a malformed one. Null
    // rather than a throw, so the caller can trace and drop it: a client cannot
    // correct a host, and an exception here would surface as a program check the
    // host never caused.
    expect(decodeHeader(Uint8Array.of(0, 0, 0, 0))).toBeNull();
    expect(decodeHeader(new Uint8Array())).toBeNull();
  });

  it('accepts a header with no data portion', () => {
    // §8 allows <TN3270E Header><IAC EOR> with no data, which is how PRINT-EOJ
    // arrives and how a bare RESPONSE could.
    expect(decodeHeader(Uint8Array.of(0x08, 0, 0, 0, 0))).toEqual({
      dataType: Tn3270eDataType.PRINT_EOJ, requestFlag: 0, responseFlag: 0, seq: 0,
    });
  });

  it('recognises only 3270-DATA as carrying an executable datastream', () => {
    // The gate that keeps a bind image or an unbind reason code out of the 3270
    // executor, where it would produce a spurious program check.
    expect(carriesDatastream(Tn3270eDataType.DATA_3270)).toBe(true);
    for (const dt of [
      Tn3270eDataType.SCS_DATA, Tn3270eDataType.RESPONSE, Tn3270eDataType.BIND_IMAGE,
      Tn3270eDataType.UNBIND, Tn3270eDataType.NVT_DATA, Tn3270eDataType.REQUEST,
      Tn3270eDataType.SSCP_LU_DATA, Tn3270eDataType.PRINT_EOJ, 0x09,
    ]) {
      expect(carriesDatastream(dt)).toBe(false);
    }
  });
});

/** A subnegotiation parameter string: ASCII to bytes. */
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);

describe('TN3270E negotiation — DEVICE-TYPE', () => {
  it('requests exactly RESPONSES, SYSREQ and CONTENTION-RESOLUTION', () => {
    // BIND-IMAGE is deliberately absent. Granted BIND-IMAGE and sent no BIND, real
    // s3270 never enters 3270 mode -- measured three ways, docs/live-testing.md
    // *TN3270E harness validation*. Not asking is what makes that unreachable.
    expect([...REQUESTED_FUNCTIONS]).toEqual([
      Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ, Tn3270eFunc.CONTENTION_RESOLUTION,
    ]);
    expect([...REQUESTED_FUNCTIONS]).not.toContain(Tn3270eFunc.BIND_IMAGE);
  });

  it('omits both printer functions, which belong to the printer stage', () => {
    expect([...REQUESTED_FUNCTIONS]).not.toContain(Tn3270eFunc.SCS_CTL_CODES);
    expect([...REQUESTED_FUNCTIONS]).not.toContain(Tn3270eFunc.DATA_STREAM_CTL);
  });

  it('answers SEND DEVICE-TYPE with DEVICE-TYPE REQUEST and the terminal type', () => {
    // Captured from real s3270:
    //   host  ff fa 28 08 02 ff f0
    //   s3270 ff fa 28 02 07 "IBM-3278-2-E" ff f0
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus: [] });
    const r = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE));
    expect([...r.reply!]).toEqual([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST, ...ascii('IBM-3278-2-E'),
    ]);
    expect(r.next.phase).toBe('awaitingDeviceType');
    expect(r.effect).toBeUndefined();
  });

  it('appends CONNECT <lu> when an LU was named', () => {
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus: ['TESTLU01'] });
    const r = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE));
    expect([...r.reply!]).toEqual([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST, ...ascii('IBM-3278-2-E'),
      Tn3270eOp.CONNECT, ...ascii('TESTLU01'),
    ]);
  });

  it('rejects the misordered SEND DEVICE-TYPE that cost real time', () => {
    // 02 08 instead of 08 02. Real s3270 answered this with "DEVICE-TYPE ??8" and
    // then stalled -- no reject, no error, nothing. Silence is the right response to
    // a body we cannot parse, and tolerating it would mean negotiating against a
    // server no other client can talk to.
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus: [] });
    const r = negotiate(st, Uint8Array.of(Tn3270eOp.DEVICE_TYPE, Tn3270eOp.SEND));
    expect(r.reply).toBeUndefined();
    expect(r.next.phase).toBe('idle');
    expect(r.effect).toBeUndefined();
  });

  it('on DEVICE-TYPE IS, records the device and LU and asks for functions', () => {
    // Captured: ff fa 28 02 04 "IBM-3278-2-E" 01 "TESTLU01" ff f0
    let st = initialState({ terminalType: 'IBM-3278-2-E', lus: ['TESTLU01'] });
    st = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
    const r = negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'),
      Tn3270eOp.CONNECT, ...ascii('TESTLU01'),
    ]));
    expect(r.next.deviceType).toBe('IBM-3278-2-E');
    expect(r.next.lu).toBe('TESTLU01');
    expect([...r.reply!]).toEqual([
      Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, ...REQUESTED_FUNCTIONS,
    ]);
    expect(r.next.phase).toBe('awaitingFunctions');
  });

  it('accepts DEVICE-TYPE IS with no CONNECT clause', () => {
    // §7.1.4 does not require the clause. `lu` stays undefined rather than becoming
    // an empty string: "no LU reported" and "an LU called nothing" are different
    // facts, and only one of them should show in the OIA.
    let st = initialState({ terminalType: 'IBM-3278-2-E', lus: [] });
    st = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
    const r = negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3279-2-E'),
    ]));
    expect(r.next.deviceType).toBe('IBM-3279-2-E');
    expect(r.next.lu).toBeUndefined();
  });

  it('reports the LU the SERVER named, not the one we asked for', () => {
    // A server may assign something other than the requested resource, and the OIA
    // must show what we actually got. x3270 keeps the two apart the same way
    // (reported_lu vs try_lu).
    let st = initialState({ terminalType: 'IBM-3278-2-E', lus: ['WANTED'] });
    st = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
    const r = negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'),
      Tn3270eOp.CONNECT, ...ascii('ASSIGNED'),
    ]));
    expect(r.next.lu).toBe('ASSIGNED');
  });

  it('treats an empty CONNECT name as no LU rather than as an empty one', () => {
    let st = initialState({ terminalType: 'IBM-3278-2-E', lus: [] });
    st = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
    const r = negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'), Tn3270eOp.CONNECT,
    ]));
    expect(r.next.lu).toBeUndefined();
  });

  it('ignores a body it does not recognise, without changing state', () => {
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus: [] });
    const r = negotiate(st, Uint8Array.of(0x7e, 0x7f));
    expect(r.reply).toBeUndefined();
    expect(r.effect).toBeUndefined();
    expect(r.next).toEqual(st);
  });

  it('ignores an empty body rather than reading past the end of it', () => {
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus: [] });
    const r = negotiate(st, new Uint8Array());
    expect(r.reply).toBeUndefined();
    expect(r.next).toEqual(st);
  });

  it('leaves the state it was handed untouched', () => {
    // negotiate() returns a new state rather than mutating: the session keeps the
    // old one until it has decided what to do with the result, and a test that
    // drives two branches from one state must not have the first poison the second.
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus: ['LUA'] });
    const before = JSON.stringify(st);
    negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE));
    expect(JSON.stringify(st)).toBe(before);
  });
});

describe('TN3270E negotiation — FUNCTIONS', () => {
  /** Drive a state to 'awaitingFunctions' the way a real server would. */
  function atFunctions(lus: readonly string[] = []): Tn3270eState {
    let st = initialState({ terminalType: 'IBM-3278-2-E', lus });
    st = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
    return negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'),
    ])).next;
  }

  it('accepts a FUNCTIONS IS subset in SILENCE, and completes', () => {
    // Measured: after the harness granted RESPONSES and SYSREQ, real s3270 sent
    // NOTHING further and its trace logged "TN3270E option negotiation complete."
    // An echo here would still appear to work against a tolerant server, which is
    // why the silence is asserted rather than assumed.
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ,
    ));
    expect(r.reply).toBeUndefined();
    expect(r.next.phase).toBe('negotiated');
    expect([...r.next.agreed]).toEqual([Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ]);
    expect(r.effect).toEqual({
      kind: 'complete', agreed: [Tn3270eFunc.RESPONSES, Tn3270eFunc.SYSREQ],
    });
  });

  it('completes on an empty function list — "basic TN3270E"', () => {
    // RFC 2355 §9 names this mode explicitly and calls the null function-list legal.
    // Treating it as an error would refuse a conforming server; the harness proved a
    // real client accepts it (config D).
    const r = negotiate(atFunctions(), Uint8Array.of(Tn3270eOp.FUNCTIONS, Tn3270eOp.IS));
    expect(r.next.phase).toBe('negotiated');
    expect([...r.next.agreed]).toEqual([]);
    expect(r.effect).toEqual({ kind: 'complete', agreed: [] });
  });

  it('backs off when FUNCTIONS IS ADDS a function we never asked for', () => {
    // x3270: "Host illegally added function(s)" (telnet.c:2327), which abandons
    // TN3270E outright rather than trying to reconcile. BIND-IMAGE is the case that
    // matters: a server forcing it on us is exactly the one that could then hang the
    // session by never sending a BIND.
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES, Tn3270eFunc.BIND_IMAGE,
    ));
    expect(r.next.phase).toBe('backedOff');
    expect(r.reply).toBeUndefined();
    expect(r.effect).toEqual({
      kind: 'backoff', why: 'host illegally added function(s)',
    });
  });

  it('answers a host-initiated FUNCTIONS REQUEST subset with FUNCTIONS IS', () => {
    // telnet.c:2287-2301. NO REAL SERVER HAS EVER EXERCISED THIS PATH for us -- it
    // is implemented from x3270's source, and whether any host initiates is one of
    // the four questions for the future real-host probe.
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, Tn3270eFunc.RESPONSES,
    ));
    expect([...r.reply!]).toEqual([
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES,
    ]);
    expect(r.next.phase).toBe('negotiated');
    expect(r.effect).toEqual({ kind: 'complete', agreed: [Tn3270eFunc.RESPONSES] });
  });

  it('counter-offers the intersection when a host REQUESTs more than we do', () => {
    // telnet.c:2306-2311: b8_and, then send REQUEST again. Negotiation CONTINUES
    // rather than completing, so no effect is emitted yet -- emitting 'complete'
    // here would put the session in 3270 mode before the host has agreed.
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST,
      Tn3270eFunc.RESPONSES, Tn3270eFunc.SCS_CTL_CODES,
    ));
    expect([...r.reply!]).toEqual([
      Tn3270eOp.FUNCTIONS, Tn3270eOp.REQUEST, Tn3270eFunc.RESPONSES,
    ]);
    expect(r.next.phase).toBe('awaitingFunctions');
    expect(r.effect).toBeUndefined();
  });

  it('drops an unrecognized function code rather than failing', () => {
    // §7.2.2: "If in the process of functions negotiation an unrecognized function
    // code is recieved, the recipient should simply remove that function code from
    // the list and continue normal functions negotiation." [sic -- the RFC's typo]
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES, 0x7f,
    ));
    expect(r.next.phase).toBe('negotiated');
    expect([...r.next.agreed]).toEqual([Tn3270eFunc.RESPONSES]);
  });

  it('drops an unknown code BEFORE judging whether the list added anything', () => {
    // Order matters. If the unknown code were judged first it would look like an
    // addition and trigger backoff, turning a conforming server into a refused one.
    // x3270 decodes into a bitmap (which cannot hold an unknown bit) before
    // comparing, which has the same effect.
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, 0x7f,
    ));
    expect(r.next.phase).toBe('negotiated');
    expect(r.effect?.kind).toBe('complete');
  });

  it('treats function 6 as unknown, since we do not define it', () => {
    // x3270 has TN3270E_FUNC_SNA_SENSE = 6 and RFC 2355 does not. We drop it, which
    // must not be mistaken for an illegal addition.
    const r = negotiate(atFunctions(), Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES, 6,
    ));
    expect(r.next.phase).toBe('negotiated');
    expect([...r.next.agreed]).toEqual([Tn3270eFunc.RESPONSES]);
  });

  it('keeps the device type and LU across the FUNCTIONS exchange', () => {
    // Regression guard: the spread in the FUNCTIONS arm must not drop what
    // DEVICE-TYPE IS recorded, or the status line loses the LU at the last moment.
    let st = initialState({ terminalType: 'IBM-3278-2-E', lus: ['TESTLU01'] });
    st = negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
    st = negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'),
      Tn3270eOp.CONNECT, ...ascii('TESTLU01'),
    ])).next;
    const r = negotiate(st, Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.RESPONSES,
    ));
    // Assert the transition happened FIRST. Without this the test passes vacuously
    // against an unimplemented FUNCTIONS arm, which returns the state untouched and
    // therefore trivially "keeps" both fields -- observed while writing it.
    expect(r.next.phase).toBe('negotiated');
    expect(r.next.deviceType).toBe('IBM-3278-2-E');
    expect(r.next.lu).toBe('TESTLU01');
  });
});

describe('TN3270E negotiation — REJECT, LU fallback and backoff', () => {
  /** Drive to 'awaitingDeviceType' with the given LU list. */
  function atDeviceType(lus: readonly string[]): Tn3270eState {
    const st = initialState({ terminalType: 'IBM-3278-2-E', lus });
    return negotiate(st, Uint8Array.of(Tn3270eOp.SEND, Tn3270eOp.DEVICE_TYPE)).next;
  }

  const reject = (reason?: number): Uint8Array => Uint8Array.from(
    reason === undefined
      ? [Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REJECT]
      : [Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REJECT, Tn3270eOp.REASON, reason],
  );

  it('retries the NEXT LU on a rejection that is not UNSUPPORTED-REQ', () => {
    // telnet.c:2270-2273: next_lu(), then tn3270e_request() again.
    const r = negotiate(atDeviceType(['LUA', 'LUB']), reject(Tn3270eReason.DEVICE_IN_USE));
    expect(r.next.luIndex).toBe(1);
    expect([...r.reply!]).toEqual([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.REQUEST, ...ascii('IBM-3278-2-E'),
      Tn3270eOp.CONNECT, ...ascii('LUB'),
    ]);
    expect(r.effect).toBeUndefined();
  });

  it('does NOT resend the LU that was just rejected', () => {
    // The retry must build its request from the UPDATED state. Reading the old
    // luIndex resends the same name forever against a host that keeps saying no --
    // an infinite exchange rather than a failure, which is far worse to diagnose.
    const r = negotiate(atDeviceType(['LUA', 'LUB']), reject(Tn3270eReason.DEVICE_IN_USE));
    expect([...r.reply!]).not.toEqual(expect.arrayContaining(ascii('LUA')));
  });

  it('walks the whole LU list in order, one rejection at a time', () => {
    let st = atDeviceType(['LUA', 'LUB', 'LUC']);
    const asked: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = negotiate(st, reject(Tn3270eReason.DEVICE_IN_USE));
      st = r.next;
      if (r.reply) {
        const body = [...r.reply];
        const at = body.indexOf(Tn3270eOp.CONNECT);
        asked.push(String.fromCharCode(...body.slice(at + 1)));
      }
    }
    expect(asked).toEqual(['LUB', 'LUC']);
    expect(st.phase).toBe('backedOff');
  });

  it('backs off on UNSUPPORTED-REQ even with LUs left to try', () => {
    // telnet.c:2263-2267 checks the reason BEFORE next_lu(). UNSUPPORTED-REQ is about
    // the request type rather than the resource, so another LU cannot help and
    // retrying would be noise on the wire.
    const r = negotiate(atDeviceType(['LUA', 'LUB']), reject(Tn3270eReason.UNSUPPORTED_REQ));
    expect(r.next.phase).toBe('backedOff');
    expect(r.reply).toBeUndefined();
    expect(r.effect).toEqual({ kind: 'backoff', why: 'host rejected request type' });
  });

  it('backs off once the LU list is exhausted', () => {
    const r = negotiate(atDeviceType(['LUA']), reject(Tn3270eReason.DEVICE_IN_USE));
    expect(r.next.phase).toBe('backedOff');
    expect(r.effect).toEqual({ kind: 'backoff', why: 'host rejected resource(s)' });
  });

  it('backs off on a rejection when no LU was ever named', () => {
    // x3270's "Device type rejected" (telnet.c:2276). With no list there is nothing
    // to retry, so this must not loop resending the same request.
    const r = negotiate(atDeviceType([]), reject(Tn3270eReason.INV_DEVICE_TYPE));
    expect(r.next.phase).toBe('backedOff');
    expect(r.reply).toBeUndefined();
    expect(r.effect).toEqual({ kind: 'backoff', why: 'device type rejected' });
  });

  it('distinguishes "resource rejected" from "device type rejected"', () => {
    // x3270 emits different messages depending on whether an LU list existed, and
    // the distinction is what tells an operator whether to fix the LU name or the
    // model. Asserting both spellings keeps them from collapsing into one.
    expect(negotiate(atDeviceType(['LUA']), reject(Tn3270eReason.DEVICE_IN_USE))
      .effect).toEqual({ kind: 'backoff', why: 'host rejected resource(s)' });
    expect(negotiate(atDeviceType([]), reject(Tn3270eReason.DEVICE_IN_USE))
      .effect).toEqual({ kind: 'backoff', why: 'device type rejected' });
  });

  it('treats a REJECT with no REASON clause as a rejection, not a parse error', () => {
    // §7.1.5 shows REASON present, but a truncated body must not throw and must not
    // be mistaken for success -- reading body[3] off the end yields undefined, which
    // must not compare equal to UNSUPPORTED-REQ or to anything else meaningful.
    const r = negotiate(atDeviceType([]), reject());
    expect(r.next.phase).toBe('backedOff');
    expect(r.effect?.kind).toBe('backoff');
  });

  it('backs off on an unknown reason code rather than ignoring it', () => {
    const r = negotiate(atDeviceType([]), reject(0x5a));
    expect(r.next.phase).toBe('backedOff');
    expect(r.effect?.kind).toBe('backoff');
  });

  it('reaches backedOff from the FUNCTIONS phase too', () => {
    // The two backoff routes -- an illegal added function and a device-type reject --
    // must land in the same terminal phase, because the session's handling of it is
    // one code path (send WONT, forget the option, stay reachable as classic tn3270).
    let st = atDeviceType([]);
    st = negotiate(st, Uint8Array.from([
      Tn3270eOp.DEVICE_TYPE, Tn3270eOp.IS, ...ascii('IBM-3278-2-E'),
    ])).next;
    const r = negotiate(st, Uint8Array.of(
      Tn3270eOp.FUNCTIONS, Tn3270eOp.IS, Tn3270eFunc.BIND_IMAGE,
    ));
    expect(r.next.phase).toBe('backedOff');
  });
});
