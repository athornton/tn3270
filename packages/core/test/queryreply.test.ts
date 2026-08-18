import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQueryReply, DEFAULT_CAPABILITIES } from '../src/queryreply.js';
import { AID, Qcode, Sfid } from '../src/constants.js';

const GEOMETRY = { rows: 24, cols: 80 };

/** Split a reply body (after the AID) into its length-prefixed units. */
function units(reply: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 1; // skip the AID
  while (i < reply.length) {
    const len = (reply[i]! << 8) | reply[i + 1]!;
    // A unit cannot be shorter than L L SFID QCODE. Without this guard a
    // desynchronized stream yields len === 0, i never advances, and the loop
    // allocates until the test worker dies of heap exhaustion rather than
    // reporting anything. Fail loudly instead.
    if (len < 4) throw new Error(`bogus unit length ${len} at offset ${i}`);
    out.push(reply.subarray(i, i + len));
    i += len;
  }
  return out;
}

describe('query reply', () => {
  it('starts with the Query Reply AID', () => {
    // GA23-0059 p. 6-22 (NOT 6-19, which is the Read Partition side): "When a
    // Query Reply is used in the 3270 data stream, it is preceded by an Al D of
    // X' 88'." (pages.txt:8646-8647; "Al D" is OCR of "AID"). The next sentence
    // is why the AID appears once and not per unit: "If the structured field is
    // one of a set of Query Reply structured fields, only the first is preceded
    // by an AID of X'88'."
    expect(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY)[0]).toBe(AID.SF);
    expect(AID.SF).toBe(0x88);
  });

  it('sends exactly the three units we honour', () => {
    const parsed = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    expect(parsed).toHaveLength(3);
    // Every unit is SFID 0x81 (Query Reply) with its QCODE in byte 3.
    expect(parsed.map((u) => u[2])).toEqual([Sfid.QUERY_REPLY, Sfid.QUERY_REPLY, Sfid.QUERY_REPLY]);
    expect(parsed.map((u) => u[3])).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.IMPLICIT_PARTITION,
    ]);
  });

  it('every unit declares a length matching its actual byte count', () => {
    for (const u of units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))) {
      expect((u[0]! << 8) | u[1]!).toBe(u.length);
    }
  });

  it('derives the Summary QCODE list from the capability list itself', () => {
    // p. 6-20, verbatim (pages.txt:8571-8573): "(The QCODE for the Summary
    // Query Reply itself is also included in the list.)" So Summary lists the
    // QCODEs of every reply supported INCLUDING its own. Deriving the list from
    // the capability list means it cannot disagree with what we send.
    const summary = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[0]!;
    expect(Array.from(summary.subarray(4))).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.IMPLICIT_PARTITION,
    ]);
  });

  it('encodes Usable Area per GA23-0059 p. 6-101', () => {
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[1]!;
    // L L SFID QCODE FLAGS FLAGS W W H H UNITS Xr(4) Yr(4) AW AH BUFFSZ(2)
    expect(ua.length).toBe(23);
    expect((ua[6]! << 8) | ua[7]!).toBe(80);    // W
    expect((ua[8]! << 8) | ua[9]!).toBe(24);    // H
    expect((ua[21]! << 8) | ua[22]!).toBe(1920); // BUFFSZ = 80 * 24
  });

  it('nests the Sizes-for-Display SDP inside the Implicit Partition base', () => {
    const ip = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[2]!;
    // Base is 6 bytes (L L SFID QCODE + two RESERVED flag bytes, p. 6-71),
    // then an 11-byte SDP (p. 6-72). Dropping the reserved bytes shifts
    // everything after them.
    expect(ip.length).toBe(17);
    expect(ip[4]).toBe(0x00);
    expect(ip[5]).toBe(0x00);
    const sdp = ip.subarray(6);
    expect(sdp[0]).toBe(0x0b); // L
    expect(sdp[1]).toBe(0x01); // SDPID: Sizes for Display Devices
    expect((sdp[3]! << 8) | sdp[4]!).toBe(80);  // WD
    expect((sdp[5]! << 8) | sdp[6]!).toBe(24);  // HD
    expect((sdp[7]! << 8) | sdp[8]!).toBe(80);  // WA — equals default
    expect((sdp[9]! << 8) | sdp[10]!).toBe(24); // HA — equals default
  });

  it('advertises the alternate size as the default, which the manual requires', () => {
    // p. 6-72, quoted verbatim (pages.txt:10548-10549): "If the device does not
    // have an alternate screen size, the value for the alternate screen size
    // must be that of the default screen size." The same page also requires
    // "Default and alternate values must be nonzero."
    const sdp = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[2]!.subarray(6);
    expect(Array.from(sdp.subarray(3, 7))).toEqual(Array.from(sdp.subarray(7, 11)));
  });

  it('reflects a different geometry in both the reply and the buffer size', () => {
    // Geometry is a parameter, not a constant, even though 2a only ships 24x80.
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, { rows: 32, cols: 80 }))[1]!;
    expect((ua[8]! << 8) | ua[9]!).toBe(32);
    expect((ua[21]! << 8) | ua[22]!).toBe(2560);
  });

  it('matches x3270 byte-for-byte on the units we both send', () => {
    // SCOPE, and read this before extending the test: x3270's reply carries ten
    // units and ours carries three, so the whole records CANNOT be equal. What
    // is comparable is the three units we both send, and those are worth
    // comparing because this host accepted x3270's.
    //
    // WHAT THIS DOES NOT COVER: that our three-unit SUBSET is acceptable to
    // TSO. Nothing offline can show that; only the live run in task 10 can.
    // A passing test here plus a failing live run is a coherent outcome, not a
    // contradiction.
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(
      join(here, '..', '..', 'fixtures', 'x3270', 'tso-query-reply.txt'), 'utf8');
    const theirs = Uint8Array.from(
      text.split('\n')
        .filter((l) => l.startsWith('> '))
        .flatMap((l) => l.slice(2).trim().split(/\s+/))
        .map((h) => parseInt(h, 16))
        .filter((b) => !Number.isNaN(b)),
    );
    // The fixture is the WIRE capture, so two layers of telnet framing have to
    // come off before the bytes are comparable to what buildQueryReply returns.
    //
    // 1. The record ends with IAC EOR (ff ef), a terminator, not content.
    // 2. Content 0xff is IAC-DOUBLED on the wire. x3270's Color unit contains a
    //    real 0xff, so the capture holds `ff ff` there. 183 wire bytes - 2 for
    //    IAC EOR - 1 for the doubled IAC = 180 bytes of record, which is what
    //    parses into exactly ten units. Skipping this step desynchronizes the
    //    length walk at the Color unit and is precisely the failure mode the
    //    fixture's own header warns about.
    const framed = theirs.subarray(0, theirs.length - 2);
    const undoubled: number[] = [];
    for (let i = 0; i < framed.length; i++) {
      undoubled.push(framed[i]!);
      if (framed[i] === 0xff && framed[i + 1] === 0xff) i++;
    }
    const theirUnits = units(Uint8Array.from(undoubled));
    expect(theirUnits).toHaveLength(10); // guards the un-doubling above
    const byQcode = new Map(theirUnits.map((u) => [u[3]!, u]));

    const ourUnits = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    for (const ours of ourUnits) {
      const qcode = ours[3]!;
      if (qcode === Qcode.SUMMARY) continue; // lists ten QCODEs for them, three for us
      expect(Array.from(ours), `unit 0x${qcode.toString(16)} differs from x3270`)
        .toEqual(Array.from(byQcode.get(qcode)!));
    }
  });
});
