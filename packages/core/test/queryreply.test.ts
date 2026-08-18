import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQueryReply, DEFAULT_CAPABILITIES, type Capability } from '../src/queryreply.js';
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
  // The slice above USES the declared length, so `declared === u.length` is true
  // by construction for every unit but the last — asserting it proves almost
  // nothing on its own. This is the check with teeth: walking by the declared
  // lengths must land exactly on the end of the record. A unit that overstates
  // its length runs past the end, one that understates leaves a tail, and both
  // land here. See the project's "check what a comparison covers" note.
  if (i !== reply.length) {
    throw new Error(`unit lengths overran: ended at ${i} of ${reply.length}`);
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

  it('declares unit lengths that walk exactly to the end of the record', () => {
    // units() throws if the declared lengths do not land on the record end, so
    // the walk itself is the assertion. The expected sizes are pinned here so a
    // changed unit has to be changed deliberately: Summary is 4 + 3 QCODEs,
    // Usable Area is the 23-byte base, Implicit Partition is 6 + 11.
    const parsed = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    expect(parsed.map((u) => u.length)).toEqual([7, 23, 17]);
    for (const u of parsed) {
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

    // The assertion above passes just as happily against a HARDCODED list, so on
    // its own it does not test the word "derives" in this test's name — which is
    // the whole reason this module is a capability list and not a byte blob.
    // Verified: replacing summary.params with () => [0x80, 0x81, 0xa6] left all
    // nine tests green. Growing the list is what distinguishes the two: a
    // hardcoded Summary cannot mention a capability it was not written with.
    const extra: Capability = { qcode: 0x86, params: () => [] };
    const grown = units(buildQueryReply([...DEFAULT_CAPABILITIES, extra], GEOMETRY));
    expect(Array.from(grown[0]!.subarray(4))).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.IMPLICIT_PARTITION, 0x86,
    ]);
    // And the new unit is really emitted, so Summary is not promising a reply
    // that never arrives — the drift this design exists to prevent.
    expect(grown).toHaveLength(4);
    expect(grown[3]![3]).toBe(0x86);
  });

  it('encodes Usable Area per GA23-0059 p. 6-101', () => {
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[1]!;
    // L L SFID QCODE FLAGS FLAGS W W H H UNITS Xr(4) Yr(4) AW AH BUFFSZ(2)
    expect(ua.length).toBe(23);
    expect(ua[4]).toBe(0x01);                   // FLAGS: ADDR = 12/14-bit
    expect(ua[5]).toBe(0x00);                   // FLAGS: matrix char, cell units
    expect((ua[6]! << 8) | ua[7]!).toBe(80);    // W
    expect((ua[8]! << 8) | ua[9]!).toBe(24);    // H
    expect((ua[21]! << 8) | ua[22]!).toBe(1920); // BUFFSZ = 80 * 24

    // The fixed device metrics, asserted individually so that a future edit
    // fails naming the byte rather than just "unit 0x81 differs from x3270".
    //
    // UNITS: if this assertion is what failed, you have probably "fixed" the
    // millimetres-versus-inches inconsistency described at length in the KNOWN
    // INCONSISTENCY comment in queryreply.ts. Read that comment before changing
    // it. 0x01 (millimetres) disagrees with the inch-scaled Xr/Yr below, and it
    // is kept anyway because these exact bytes are what the live host accepted
    // from x3270. Changing UNITS alone makes the record differ from the only
    // known-good reference we have.
    expect(ua[10]).toBe(0x01);
    // Xr = 10/741 and Yr = 2/111, each a 2-byte numerator over a 2-byte
    // denominator — not one 32-bit number.
    expect(Array.from(ua.subarray(11, 15))).toEqual([0x00, 0x0a, 0x02, 0xe5]);
    expect(Array.from(ua.subarray(15, 19))).toEqual([0x00, 0x02, 0x00, 0x6f]);
    expect(ua[19]).toBe(0x09); // AW: 9 pel-pitch units per cell
    expect(ua[20]).toBe(0x0c); // AH: 12 — the standard 3279 9x12 cell
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

  it('refuses a geometry it cannot encode honestly', () => {
    // Masking instead of throwing produced a plausible-looking record in each of
    // these cases, which is worse than an error because the host acts on it.
    //
    // Zero violates p. 6-72's "Default and alternate values must be nonzero" —
    // the rule the alternate-size test above only quotes. NOTE a 16-bit range
    // check does NOT catch this one: 0 encodes fine, so the guard has to live in
    // buildQueryReply as a geometry rule. Measured before fixing: rows 0 emitted
    // a full 48-byte record with WD/HD = X'0000'.
    expect(() => buildQueryReply(DEFAULT_CAPABILITIES, { rows: 0, cols: 80 })).toThrow(RangeError);
    expect(() => buildQueryReply(DEFAULT_CAPABILITIES, { rows: 24, cols: 0 })).toThrow(RangeError);
    // Negative masked to X'FFFF', which the telnet layer would then IAC-double.
    expect(() => buildQueryReply(DEFAULT_CAPABILITIES, { rows: 24, cols: -1 })).toThrow(RangeError);
    // Fractional truncated W/H to 24 while BUFFSZ kept 1960, so the reply
    // contradicted itself.
    expect(() => buildQueryReply(DEFAULT_CAPABILITIES, { rows: 24.5, cols: 80 }))
      .toThrow(RangeError);
    // BUFFSZ is rows * cols, so an over-large screen wraps the product even when
    // each dimension fits.
    expect(() => buildQueryReply(DEFAULT_CAPABILITIES, { rows: 9999, cols: 9999 }))
      .toThrow(RangeError);
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
