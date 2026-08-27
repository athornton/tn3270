import { describe, it, expect } from 'vitest';
import {
  Tn3270eOp, Tn3270eReason, Tn3270eFunc, Tn3270eDataType,
  Tn3270eRequestFlag, Tn3270eResponseFlag, Tn3270eSense,
} from '../src/constants.js';

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
