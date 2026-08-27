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
