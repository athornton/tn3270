import { describe, it, expect } from 'vitest';
import { TelnetOpt, EnvironGroup, EnvironQual } from '../src/constants.js';
import { parseEnvironSend } from '../src/newenviron.js';

/** ASCII to bytes, for building request bodies. */
const a = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/**
 * RFC 1572's codes, taken from x3270's include/arpa_telnet.h:122-125 rather than from
 * the RFC text, because that header is what the traces we drive were produced against.
 */
describe('NEW-ENVIRON constants', () => {
  it('is telnet option 39', () => {
    expect(TelnetOpt.NEW_ENVIRON).toBe(39);
  });

  it('has RFC 1572 s four group codes', () => {
    expect(EnvironGroup.VAR).toBe(0);
    expect(EnvironGroup.VALUE).toBe(1);
    expect(EnvironGroup.ESC).toBe(2);
    expect(EnvironGroup.USERVAR).toBe(3);
  });

  it('has its OWN IS and SEND, not TERMINAL-TYPE s', () => {
    // IS=0 and SEND=1 are the same VALUES that TelnetSubopt already defines for
    // TERMINAL-TYPE (RFC 1091). That is a coincidence of encoding, not a shared
    // meaning, and this project has been bitten by exactly that confusion before --
    // see constants.ts's note on XAH.DEFAULT versus XA.RESET, both 0x00 and unrelated.
    // Asserting the values here is what lets a reader see they are deliberate.
    expect(EnvironQual.IS).toBe(0);
    expect(EnvironQual.SEND).toBe(1);
    expect(EnvironQual.INFO).toBe(2);
  });
});

describe('parseEnvironSend', () => {
  it('parses the three-uservar request from devname_success.trc', () => {
    // The real bytes, from that trace's line 87:
    //   fffa27 01 03 "IBMELF" 03 "IBMAPPLID" 03 "DEVNAME" fff0
    // The body handed to us excludes the option byte and the SEND qualifier.
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, ...a('IBMELF'),
      EnvironGroup.USERVAR, ...a('IBMAPPLID'),
      EnvironGroup.USERVAR, ...a('DEVNAME'),
    ]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.USERVAR, name: 'IBMELF' },
      { group: EnvironGroup.USERVAR, name: 'IBMAPPLID' },
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ]);
  });

  it('parses the single-uservar request the host repeats', () => {
    const body = Uint8Array.from([EnvironGroup.USERVAR, ...a('DEVNAME')]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ]);
  });

  it('treats a group byte with NO name as "the whole group"', () => {
    const body = Uint8Array.from([EnvironGroup.VAR, EnvironGroup.USERVAR]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ]);
  });

  it('EXPANDS AN EMPTY BODY INTO BOTH GROUPS, which is "send everything"', () => {
    // x3270 checks `state == EE_BASE` after the loop and fakes one VAR and one USERVAR
    // request (telnet_new_environ.c:453-470). A client that returned an empty list here
    // would answer a host asking for everything with nothing at all -- and the reply
    // would still be well-formed, so nothing downstream would notice.
    //
    // NOT JUST THE C SOURCE -- A RECORDED HOST DOES THIS. `s3270/Test/dbcs-wrap.trc:103`
    // has the host send a bare `fffa2701fff0` (SEND, empty body); x3270's reply at :108
    // dumps every VAR and USERVAR it holds (also seen in `lu.trc`, `target.trc`,
    // `korean.trc`). A measured host outranks the reference implementation's source.
    expect(parseEnvironSend(new Uint8Array(0))).toEqual([
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ]);
  });

  it('distinguishes VAR from USERVAR', () => {
    const body = Uint8Array.from([EnvironGroup.VAR, ...a('USER')]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.VAR, name: 'USER' },
    ]);
  });

  it('un-escapes an ESC in a name', () => {
    // ESC means "the next byte is literal", so a name containing byte 0x03 arrives as
    // ESC 0x03 and must parse back to a one-character name.
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, EnvironGroup.ESC, EnvironGroup.USERVAR,
    ]);
    const got = parseEnvironSend(body)!;
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe(String.fromCharCode(EnvironGroup.USERVAR));
  });

  it('REFUSES a body that does not begin with a group byte', () => {
    // x3270's EE_BASE returns NULL for anything but VAR or USERVAR. Malformed, not
    // truncated: there is nothing to salvage.
    expect(parseEnvironSend(Uint8Array.from(a('DEVNAME')))).toBeNull();
    expect(parseEnvironSend(Uint8Array.of(EnvironGroup.VALUE))).toBeNull();
  });
});
