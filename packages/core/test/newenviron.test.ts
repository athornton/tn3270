import { describe, it, expect } from 'vitest';
import { TelnetOpt, EnvironGroup, EnvironQual } from '../src/constants.js';

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
