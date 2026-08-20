import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQueryReply, buildNullQueryReply, buildReply, DEFAULT_CAPABILITIES,
  type Capability,
} from '../src/queryreply.js';
import { AID, Qcode, ReqTyp, Sfid, XAH } from '../src/constants.js';
import { Colour, colourRgb } from '../src/palette.js';

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

/**
 * The BODY of one unit, i.e. what follows `L L SFID QCODE`.
 *
 * Built on `units` rather than being a second walker, so the length-consistency
 * check above applies to every lookup. Throws on a missing QCODE instead of
 * returning undefined: a test that silently asserted against an absent unit is
 * the failure mode this project has hit repeatedly.
 */
function unitBody(reply: Uint8Array, qcode: number): number[] {
  const found = units(reply).filter((u) => u[3] === qcode);
  if (found.length !== 1) {
    throw new Error(`expected exactly one unit 0x${qcode.toString(16)}, found ${found.length}`);
  }
  return Array.from(found[0]!.subarray(4));
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

  it('sends exactly the five units we honour', () => {
    // WAS THREE. Color and Highlighting joined the list once SA execution and
    // render.ts's colour resolution made them honest; the order is the wire order
    // and is asserted, because units go out in capability-list order.
    const parsed = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    expect(parsed).toHaveLength(5);
    // Every unit is SFID 0x81 (Query Reply) with its QCODE in byte 3.
    expect(parsed.map((u) => u[2])).toEqual(new Array(5).fill(Sfid.QUERY_REPLY));
    expect(parsed.map((u) => u[3])).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.COLOR, Qcode.HIGHLIGHTING,
      Qcode.IMPLICIT_PARTITION,
    ]);
  });

  it('declares unit lengths that walk exactly to the end of the record', () => {
    // units() throws if the declared lengths do not land on the record end, so
    // the walk itself is the assertion. The expected sizes are pinned here so a
    // changed unit has to be changed deliberately: Summary is 4 + 5 QCODEs,
    // Usable Area is the 23-byte base, Color is 4 + 2 + 32, Highlighting is
    // 4 + 1 + 10, Implicit Partition is 6 + 11.
    const parsed = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    expect(parsed.map((u) => u.length)).toEqual([9, 23, 38, 15, 17]);
    for (const u of parsed) {
      expect((u[0]! << 8) | u[1]!).toBe(u.length);
    }
    // Color's L and Highlighting's L against x3270's captured values, which is
    // the independent check on the two new arithmetic sums: the fixture's units
    // are `00 26 81 86` (38) and `00 0f 81 87` (15).
    expect(parsed[2]!.length).toBe(0x26);
    expect(parsed[3]!.length).toBe(0x0f);
  });

  it('derives the Summary QCODE list from the capability list itself', () => {
    // p. 6-20, verbatim (pages.txt:8571-8573): "(The QCODE for the Summary
    // Query Reply itself is also included in the list.)" So Summary lists the
    // QCODEs of every reply supported INCLUDING its own. Deriving the list from
    // the capability list means it cannot disagree with what we send.
    const summary = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[0]!;
    expect(Array.from(summary.subarray(4))).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.COLOR, Qcode.HIGHLIGHTING,
      Qcode.IMPLICIT_PARTITION,
    ]);

    // The assertion above passes just as happily against a HARDCODED list, so on
    // its own it does not test the word "derives" in this test's name — which is
    // the whole reason this module is a capability list and not a byte blob.
    // Verified: replacing summary.params with a written-out list left the suite
    // green. Growing the list is what distinguishes the two: a hardcoded Summary
    // cannot mention a capability it was not written with.
    //
    // The synthetic QCODE here is 0x83, Text Partitions ("Text Partitions Yes
    // X'83' Yes Yes", pages.txt:8636). It was 0x86 until Color took that code —
    // which would have made this test append a SECOND 0x86 to a list that already
    // had one, so the "grown" reply carried a duplicate QCODE and the assertion
    // still passed. The QCODE chosen here must be one DEFAULT_CAPABILITIES does
    // not already contain; that is what the length check below enforces.
    const extra: Capability = { qcode: 0x83, returnedForQuery: true, params: () => [] };
    expect(DEFAULT_CAPABILITIES.map((c) => c.qcode)).not.toContain(extra.qcode);
    const grown = units(buildQueryReply([...DEFAULT_CAPABILITIES, extra], GEOMETRY));
    expect(Array.from(grown[0]!.subarray(4))).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.COLOR, Qcode.HIGHLIGHTING,
      Qcode.IMPLICIT_PARTITION, 0x83,
    ]);
    // And the new unit is really emitted, so Summary is not promising a reply
    // that never arrives — the drift this design exists to prevent.
    expect(grown).toHaveLength(6);
    expect(grown[5]![3]).toBe(0x83);
  });

  it('encodes Usable Area per GA23-0059 p. 6-101', () => {
    // By QCODE. Index 1 still happens to be right, but the Implicit Partition
    // tests below broke on exactly this pattern when the list grew.
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))
      .find((u) => u[3] === Qcode.USABLE_AREA)!;
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
    // Found BY QCODE rather than by position. It used to be index 2 and is now 4,
    // because Color and Highlighting were inserted before it — a positional index
    // silently reads a different unit when the list grows, which is exactly how
    // this test failed against the Color unit's bytes rather than reporting a
    // moved index.
    const ip = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))
      .find((u) => u[3] === Qcode.IMPLICIT_PARTITION)!;
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
    // By QCODE, not by position — see the note in the SDP-nesting test above.
    const sdp = Uint8Array.from(unitBody(
      buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY), Qcode.IMPLICIT_PARTITION)).subarray(2);
    expect(Array.from(sdp.subarray(3, 7))).toEqual(Array.from(sdp.subarray(7, 11)));
  });

  it('reflects a different geometry in both the reply and the buffer size', () => {
    // Geometry is a parameter, not a constant, even though 2a only ships 24x80.
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, { rows: 32, cols: 80 }))
      .find((u) => u[3] === Qcode.USABLE_AREA)!;
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
    // units and ours carries five, so the whole records CANNOT be equal. What
    // is comparable is the units we both send, and those are worth
    // comparing because this host accepted x3270's.
    //
    // ONE UNIT IS EXEMPTED, AND ONLY IN NAMED BYTES: Color. See the exemption
    // below, which spells out which bytes may differ and asserts everything else
    // is identical, rather than skipping the unit.
    //
    // WHAT THIS DOES NOT COVER: that our five-unit SUBSET is acceptable to
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
    // Both new units are in the capture, so neither is compared vacuously. This
    // is the guard that keeps the loop below from passing by finding nothing.
    expect(byQcode.has(Qcode.COLOR)).toBe(true);
    expect(byQcode.has(Qcode.HIGHLIGHTING)).toBe(true);
    for (const ours of ourUnits) {
      const qcode = ours[3]!;
      if (qcode === Qcode.SUMMARY) continue; // lists ten QCODEs for them, five for us
      const theirUnit = byQcode.get(qcode)!;
      if (qcode === Qcode.COLOR) {
        // THE ONE DELIBERATE DIVERGENCE, exempted by NAMED BYTES rather than by
        // skipping the unit, so everything else in it is still pinned.
        //
        // The capture was taken with x3270 in monochrome mode, where its CI is
        // 0x00 for every pair after the mandatory default (sf.c:747-754). We
        // always advertise the identity — see the long note on `color` in
        // queryreply.ts for why the gate does not transfer to us. So the fifteen
        // CI bytes at odd offsets from 8 may differ and nothing else may.
        expect(ours).toHaveLength(theirUnit.length); // same L, same pair count
        for (let i = 0; i < ours.length; i++) {
          const isDivergentCi = i >= 9 && i < ours.length && (i - 9) % 2 === 0;
          if (isDivergentCi) {
            // Pinned in BOTH directions, which is what makes this an exemption
            // and not a hole: theirs is 0x00, ours is the CAV that precedes it.
            expect(theirUnit[i], `their CI at ${i}`).toBe(0x00);
            expect(ours[i], `our CI at ${i}`).toBe(ours[i - 1]);
          } else {
            expect(ours[i], `Color byte ${i} differs from x3270`).toBe(theirUnit[i]);
          }
        }
        continue;
      }
      expect(Array.from(ours), `unit 0x${qcode.toString(16)} differs from x3270`)
        .toEqual(Array.from(theirUnit));
    }
  });
});

/**
 * Color (QCODE 0x86), GA23-0059 p. 6-36 (pages.txt:9198+).
 *
 * NOTE the page: the plan for this work cited p. 6-38, which is wrong. The
 * unit's section header is at pages.txt:9198 on the page whose footer reads
 * "6-36 3270 Data Stream Programmer's Reference", and the manual's own
 * cross-references agree — "see 'Query Reply (Color)' on page 6-36"
 * (pages.txt:3558, :3988).
 */
describe('Color query reply', () => {
  it('reports 16 colours with green as the required default entry', () => {
    const body = unitBody(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY),
      Qcode.COLOR);
    // p. 6-36's table (pages.txt:9214-9225): byte 4 FLAGS, byte 5 NP, then NP
    // (CAV, CI) pairs.
    //
    // FLAGS: bit 1 is PRTBLK, "Printer only - black ribbon is loaded"
    // (pages.txt:9217-9221), and every other bit is reserved. We are a display,
    // so the whole byte is zero. x3270 writes it as "no options" (sf.c:743).
    expect(body[0]).toBe(0x00);
    // NP = "Length of color attribute list (NP = number of GAV/COLOR pairs)"
    // (pages.txt:9222-9223; "GAV" is OCR of "CAV"). 16 pairs, x3270's
    // color_max (sf.c:738, :744).
    expect(body[1]).toBe(0x10);
    // THE FIRST PAIR IS MANDATORY AND IS NOT AN IDENTITY. p. 6-36: "All devices
    // that send Query Reply (Color) are required to have the values CAV1 =
    // X' 00', Cl 1 = value associated with the device default color, as the
    // first entry in the GAV/Cl pairs list." (pages.txt:9268-9270.) So CAV1 is
    // 0x00 — the "device default" colour value, our XAC_DEFAULT — and CI1 must
    // name a real colour.
    expect(body[2]).toBe(0x00);
    // GREEN, not white and not black. x3270 writes `0xf0 + HOST_COLOR_GREEN`
    // with HOST_COLOR_GREEN = 4 (sf.c:746, 3270ds.h:317), i.e. 0xF4, and
    // p. 6-36's colour table gives "Green X'F4'" (pages.txt:9251).
    //
    // This is the byte that has to agree with render.ts, and asserting the
    // constant rather than the literal is what keeps the two honest: level 4 of
    // render's resolution yields Colour.GREEN for an ordinary unprotected
    // normal-intensity field, so what we advertise as the default is what we
    // actually paint.
    expect(body[3]).toBe(Colour.GREEN);
    expect(Colour.GREEN).toBe(0xf4);
    // The manual also forbids the reverse mapping: "The CAV(n) value of X'OO'
    // can have an associated Cl(n) value of any of the defined values except
    // X' 00'." (pages.txt:9266-9267.)
    expect(body[3]).not.toBe(0x00);

    // Then fifteen IDENTITY pairs, 0xF1..0xFF — "The device must either display
    // the color whose color identifier is the same as the color attribute value
    // or display the device default color" (pages.txt:9236-9238), and identity
    // is the first of those. Every one of these is a real claim we honour:
    // PALETTE_3279 has an entry for each, so render.ts's usableColour accepts it
    // rather than falling through to a default.
    for (let i = 0; i < 15; i++) {
      const cav = 0xf1 + i;
      expect(body[4 + i * 2]).toBe(cav);
      expect(body[5 + i * 2]).toBe(cav);
      // Not a restatement of the line above: this asserts the palette can render
      // what the pair promises. A CAV we advertise identity for but cannot paint
      // would be a lie the host acts on.
      expect(() => colourRgb(cav)).not.toThrow();
    }
    // 2 header bytes + 16 pairs. NOT 4 + 30, which the plan's expected length
    // said: the plan counted from the start of the UNIT (including L L SFID
    // QCODE) while indexing from the start of the BODY, so its two numbers
    // disagreed with each other by four.
    expect(body).toHaveLength(2 + 32);
  });

  it('advertises identity pairs where x3270 in monochrome mode advertises 0x00', () => {
    // A DELIBERATE DIVERGENCE, asserted so it cannot be "fixed" by accident.
    // x3270's loop emits the identity only under mode3279 and 0x00 otherwise
    // (sf.c:747-754), and our own x3270 capture was taken in that monochrome
    // state — packages/fixtures/x3270/tso-query-reply.txt has `00 f4 f1 00 f2
    // 00 ...`, every CI after the default being 0x00.
    //
    // We always advertise the identity, and the reason is structural rather than
    // stylistic: x3270's mode3279 is a MODEL choice that also picks its terminal
    // type ("327" + '9' vs '8', model.c:135-137, telnet.c:2104), so for x3270 the
    // two travel together. Ours does not: TERMINAL_TYPE is IBM-3278-2 regardless
    // (constants.ts) and render.ts's mode3279 is a per-render presentation flag
    // with no path to this module. Gating on it would mean the same session
    // advertising different colour support depending on a rendering option, which
    // is not something a Query Reply is allowed to depend on.
    //
    // The claim also stays true under mode3279: false, because 0x00 does not mean
    // "no colour" — p. 6-36 says CI "identif[ies] the colors that are displayed"
    // and lets a device answer with "the device default color"
    // (pages.txt:9236-9238). Advertising identity says we distinguish the
    // sixteen, which we do — Screen stores the CAV per cell whatever the renderer
    // later does with it.
    const body = unitBody(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY),
      Qcode.COLOR);
    // Every CI after the mandatory default pair is nonzero. This is the
    // assertion that fails if someone ports x3270's `else *obptr++ = 0x00`.
    const cis = [...Array(15).keys()].map((i) => body[5 + i * 2]);
    expect(cis).not.toContain(0x00);
  });

  it('omits the Default Background Color self-defining parameter x3270 can append', () => {
    // x3270 appends a 4-byte SDP `04 02 00 f0` when its screen has a background
    // colour AND appres.qr_bg_color is set (sf.c:756-765). We do not, and this
    // pins that: the unit is exactly the base list with nothing after it, so a
    // length of 2 + 32 leaves no room for an SDP. Ours is the same choice the
    // captured x3270 made — the fixture's Color unit is L=0x26 = 38 = 4 + 2 + 32,
    // with no trailing SDP.
    const body = unitBody(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY),
      Qcode.COLOR);
    expect(body).toHaveLength(34);
  });
});

/**
 * Highlighting (QCODE 0x87), GA23-0059 p. 6-65 (pages.txt:10304+).
 *
 * NOTE the page: the plan cited p. 6-53. The section header sits on the page
 * whose footer reads "Chapter 6. Inbound Structured Fields 6-65"
 * (pages.txt:10320), and the manual's own contents list says "Query Reply
 * (Highlighting) 6-65" (pages.txt:7764).
 */
describe('Highlighting query reply', () => {
  it('reports the five pairs x3270 does, with DEFAULT mapping to NORMAL', () => {
    const body = unitBody(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY),
      Qcode.HIGHLIGHTING);
    // p. 6-65's table (pages.txt:10343-10345): byte 4 NP = "Number of
    // attribute-value/action pairs", then (Vi, Ai) pairs. Five, matching
    // x3270's `*obptr++ = 5; /* report on 5 pairs */` (sf.c:773).
    expect(body).toEqual([
      0x05,
      // DEFAULT -> NORMAL, not DEFAULT -> DEFAULT. The manual requires the
      // X'00' entry — "If a device accepts the highlight attribute, then it must
      // accept attribute value X' 00' (default specification)"
      // (pages.txt:10312-10313) — and it makes the mapping meaningful: "The code
      // X' 00' indicates that the device action for the corresponding attribute
      // value is the same as the action for the attribute value X '00' (the
      // default action of the device)" (pages.txt:10329-10331). We answer with
      // NORMAL instead, which names the action outright. x3270 does the same
      // (sf.c:774-775).
      XAH.DEFAULT, XAH.NORMAL,
      // Then four identities. Each is a claim render.ts honours: it sets exactly
      // one of blink/reverse/underscore/intensify by equality against these.
      XAH.BLINK, XAH.BLINK,
      XAH.REVERSE, XAH.REVERSE,
      XAH.UNDERSCORE, XAH.UNDERSCORE,
      XAH.INTENSIFY, XAH.INTENSIFY,
    ]);
    // NP must equal the number of pairs actually present, or the host mis-parses
    // the rest of the record. Derived here rather than restated.
    expect(body[0]).toBe((body.length - 1) / 2);
  });

  it('advertises only highlighting values render.ts can act on', () => {
    // The honesty check, and the reason the list is five and not six values.
    // p. 6-65 fixes the valid set as X'00', X'F0', X'F1', X'F2', X'F4', X'F8'
    // (pages.txt:10314-10325) — six values, five of which are ACTIONS. We
    // advertise every one of them as an accepted attribute value, and render.ts
    // resolves each: NORMAL/DEFAULT to no highlight, and the other four to their
    // own flag.
    const body = unitBody(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY),
      Qcode.HIGHLIGHTING);
    const accepted = [...Array(5).keys()].map((i) => body[1 + i * 2]);
    expect(accepted).toEqual([
      XAH.DEFAULT, XAH.BLINK, XAH.REVERSE, XAH.UNDERSCORE, XAH.INTENSIFY,
    ]);
    // INTENSIFY is the one to watch: Chapter 4's highlighting table omits X'F8'
    // entirely (pages.txt:3487-3498) and only this unit's section lists it
    // (pages.txt:10310-10325). See the trap note on XAH in constants.ts.
    expect(accepted).toContain(0xf8);
    // Every advertised value is a value SA can carry, so nothing here is
    // unreachable from the wire.
    expect(new Set(accepted).size).toBe(5);
  });
});

describe('Summary lists the two new units', () => {
  it('names Color and Highlighting, so they were added to the list and not just defined', () => {
    // Summary's params are `all.map(c => c.qcode)`, so this is really an
    // assertion about DEFAULT_CAPABILITIES: a capability defined but left out of
    // the list would pass every byte-level test above (they build from
    // DEFAULT_CAPABILITIES, so it would be absent and unitBody would throw) —
    // but this is the check that states the intent directly.
    const summary = unitBody(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY),
      Qcode.SUMMARY);
    expect(summary).toContain(Qcode.COLOR);
    expect(summary).toContain(Qcode.HIGHLIGHTING);
    // And Summary agrees with what is actually sent, which is the drift this
    // module's design exists to prevent. Asserted as set equality against the
    // real unit list rather than a written-out constant.
    const sent = units(buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY))
      .map((u) => u[3]!);
    expect(summary).toEqual(sent);
  });
});

/**
 * REQTYP selection, GA23-0059 p. 6-20 and p. 5-52.
 *
 * These assert on QCODES, not on unit bytes: the bytes of each unit are already
 * covered above and by the x3270 comparison, and what is under test here is
 * WHICH units are chosen.
 */
describe('Query List selection', () => {
  /** The QCODEs of a reply, in order, so a selection is one assertion. */
  function qcodesOf(reply: Uint8Array): number[] {
    return units(reply).map((u) => u[3]!);
  }

  /**
   * Every unit a plain Query returns, in wire order.
   *
   * DERIVED from DEFAULT_CAPABILITIES rather than written out, which is the point:
   * these tests are about WHICH units are selected, not about how many exist, and
   * a hand-written list means every future capability edits five unrelated tests.
   * The two below are the checks that keep the derivation from being vacuous —
   * one pins the count so a capability silently dropped from the list would fail
   * here, the other pins the order Summary-first.
   */
  const QUERY_SET = DEFAULT_CAPABILITIES.filter((c) => c.returnedForQuery).map((c) => c.qcode);

  /**
   * Two real QCODEs we do not support, for the "host asked for what we lack" cases.
   *
   * Image, "Image No X'82' No Yes" (pages.txt:8607), and Line Type, "Line Type No
   * X'B2' No Yes" (pages.txt:8610). Real codes rather than invented ones, so the
   * tests exercise the intersection the manual describes rather than a value no
   * host would send.
   *
   * These WERE 0x86 and 0x87 — Color and Highlighting — until this task advertised
   * both. That is the trap: three tests here took "unsupported" as a standing fact
   * about those two codes, and advertising them turned each into a different test
   * than its name claimed. The unsupportedness is now asserted, once, below.
   */
  const UNSUPPORTED = [0x82, 0xb2] as const;

  it('uses QCODEs we really do not support for the negative cases', () => {
    // The premise every UNSUPPORTED test rests on, checked in one place so that
    // advertising either code later fails HERE with a clear reason rather than
    // quietly hollowing out three tests elsewhere.
    const supported = DEFAULT_CAPABILITIES.map((c) => c.qcode);
    for (const qcode of UNSUPPORTED) expect(supported).not.toContain(qcode);
  });

  it('returns all five units a plain Query asks for', () => {
    expect(QUERY_SET).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.COLOR, Qcode.HIGHLIGHTING,
      Qcode.IMPLICIT_PARTITION,
    ]);
  });

  it('answers the real VM/370 MECAFF request with every unit', () => {
    // THE CASE THAT UNBLOCKS VM/CMS FILE TRANSFER. Captured live:
    // 00 07 01 ff 03 80 00 — REQTYP 0x80 = B'10' All, with a one-byte QCODE
    // list [0x00]. Built here from the same values the parser produces for those
    // bytes; the byte-level parse is asserted in sf.test.ts.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.ALL, qcodes: [0x00] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual(QUERY_SET);
    // And it is a well-formed record, not just a right-shaped list: same AID as
    // every other reply.
    expect(reply[0]).toBe(AID.SF);
  });

  it('ignores the QCODE list under REQTYP=All', () => {
    // "The Query List = All can contain a / QCODE list. However, the QCODE list
    // is ignored" (pages.txt:8554-8557); p. 5-52 puts it as "the All flag
    // overrides the list" (pages.txt:6388-6389).
    //
    // THE LIST HERE CHANGED WITH THIS TASK, and the reason is the whole point of
    // the test. It used to name Color and Highlighting as QCODEs "we do NOT
    // support", so an implementation that intersected instead of ignoring would
    // return the Null reply. We support both now, and leaving them here would
    // have quietly gutted the test: an intersecting implementation would return
    // [0x86, 0x87] and only the ORDER would have differed from the full set.
    //
    // Replaced with UNSUPPORTED — see its note above — so the discrimination
    // survives. Measured against a deliberately-intersecting selectCapabilities,
    // this yields [0xff].
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.ALL, qcodes: [...UNSUPPORTED] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual(QUERY_SET);
  });

  it('returns the plain-Query set for REQTYP=Equivalent', () => {
    // "Requests the 3270 device or workstation to return / the same Query
    // Replies that would be returned in reply to a Query" (pages.txt:8545-
    // 8547). Asserted as EQUAL TO the plain-Query reply rather than against a
    // written-out list, so the two cannot drift apart.
    const equivalent = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.EQUIVALENT, qcodes: [] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    const plain = buildReply({ kind: 'query' }, DEFAULT_CAPABILITIES, GEOMETRY);
    expect(Array.from(equivalent)).toEqual(Array.from(plain));
  });

  it('returns ONLY the listed units for REQTYP=QCODE List — no unrequested Summary', () => {
    // "the 3270 data stream device or / workstation returns all the requested
    // Query / Replies (QCODES listed) that are supported" (pages.txt:10768-
    // 10770). ONLY those.
    //
    // An earlier version of this test expected a forced Summary, reading p. 6-96's
    // "QCODE List=X'80'" (pages.txt:11409-11411) as a REQTYP. It is not — it is
    // SUMMARY'S OWN QCODE, i.e. "when the list names 0x80". The manual repeats the
    // same boilerplate per unit with that unit's code: the Null reply reads
    // `QCODE List=X'FF'` (pages.txt:10745-10746) and Begin/End of File
    // `QCODE List=X'9F'` (pages.txt:8801-8802). x3270 agrees and sends only what
    // was listed (Common/sf.c:268-277).
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [Qcode.USABLE_AREA] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual([Qcode.USABLE_AREA]);
    expect(qcodesOf(reply)).not.toContain(Qcode.SUMMARY);
    expect(qcodesOf(reply)).not.toContain(Qcode.IMPLICIT_PARTITION);
  });

  it('keeps Summary listing every capability, not just the units sent', () => {
    // THE POINT THIS PROJECT'S BRIEF FOR THIS WORK GOT WRONG, so it is asserted
    // rather than assumed. p. 6-20: "The Summary Query Reply provides / a list
    // of the QCODEs of all the Query Replies supported by the 3270 data stream /
    // device or workstation." (pages.txt:8570-8572) — supported, not sent. The
    // reason is the sentence after: Summary is "the only / indication of support
    // of functions where the associated Query Reply is returned in / reply to a
    // Query List = QCODE List or All" (pages.txt:8574-8576), so a host walks it
    // to decide what to ask for NEXT. x3270 agrees: do_qr_summary loops its whole
    // reply table (sf.c:699-708) with no reference to the request.
    //
    // So a two-unit request whose Summary IS asked for still advertises all five.
    // (Summary has to be requested: we no longer force it in unasked — see the
    // QCODE-List test above for why that was wrong.)
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST,
        qcodes: [Qcode.SUMMARY, Qcode.USABLE_AREA] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    const summaryUnit = units(reply)[0]!;
    expect(summaryUnit[3]).toBe(Qcode.SUMMARY);
    expect(Array.from(summaryUnit.subarray(4))).toEqual(QUERY_SET);
    // The teeth: this reply SENDS two units and its Summary names five. Without
    // that gap the assertion above would hold for a Summary that (wrongly) listed
    // only what was sent, which is the exact defect this test exists for.
    expect(qcodesOf(reply)).toHaveLength(2);
    expect(QUERY_SET.length).toBeGreaterThan(2);
  });

  it('sends Summary exactly once when the list names it', () => {
    // "the 3270 device or / workstation does not return duplicate Query Replies"
    // (pages.txt:8542-8544). Trivial now that Summary is never force-prepended,
    // but kept: it is the regression test for reintroducing that behaviour.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [Qcode.SUMMARY] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual([Qcode.SUMMARY]);
  });

  it('de-duplicates a repeated QCODE', () => {
    // "It is not invalid for a particular QCODE to appear / more than once in
    // the list. However, regardless of / how many times it appears, the 3270
    // device or / workstation does not return duplicate Query / Replies."
    // (pages.txt:8540-8544.)
    const reply = buildReply(
      {
        kind: 'queryList',
        reqtyp: ReqTyp.QCODE_LIST,
        qcodes: [Qcode.USABLE_AREA, Qcode.USABLE_AREA, Qcode.USABLE_AREA],
      },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual([Qcode.USABLE_AREA]);
  });

  it('ignores unsupported QCODEs in a list that also names a supported one', () => {
    // "All QCODE values in the list are valid. Those QCODEs not supported are /
    // ignored." (pages.txt:6395-6396.) The manual's own worked example, p. 6-77:
    // a device supporting A, B, C asked for A, X, Z "does not send the Null Query
    // Reply. It sends the Query Reply for / feature A only." (pages.txt:10755-
    // 10757.)
    //
    // The unsupported pair is Image (0x82) and Line Type (0xB2), asserted
    // unsupported by UNSUPPORTED below. It was 0x86/0x87 until this task
    // advertised those, at which point the request named three SUPPORTED QCODEs
    // and the test asserted a reply of one — it failed loudly rather than
    // silently, but the lesson is the same: the "unsupported" premise has to be
    // checked, not assumed.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST,
        qcodes: [UNSUPPORTED[0]!, Qcode.USABLE_AREA, UNSUPPORTED[1]!] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual([Qcode.USABLE_AREA]);
  });

  it('returns the Null Query Reply when it supports nothing requested', () => {
    // p. 6-77's example 2: "A device supports features A, B, and C. / The host
    // queries for features X, Y, and Z. / The device sends the Null Query Reply"
    // (pages.txt:10758-10761).
    //
    // BYTE-EXACT, because the whole unit is four bytes and every one is fixed by
    // p. 6-77's table (pages.txt:10768-10771): L=X'0004', SFID=X'81',
    // QCODE=X'FF'. The leading 0x88 is the AID that precedes any Query Reply.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [...UNSUPPORTED] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(Array.from(reply)).toEqual([AID.SF, 0x00, 0x04, Sfid.QUERY_REPLY, 0xff]);
    // NOT a lone Summary. Summary alone would also carry "none of what you
    // asked", but by a form no host must read that way, and p. 6-77 names the
    // Null reply specifically.
    expect(qcodesOf(reply)).toEqual([Qcode.NULL]);
  });

  it('returns the Null Query Reply for an empty QCODE list', () => {
    // p. 5-52: "If the value / is B'00' but no list is present (count field is
    // valid), a Null Query Reply is / returned." (pages.txt:6377-6379.) x3270
    // short-circuits the same case at sf.c:258-262, `if (buflen < 7) ...
    // do_query_reply(QR_NULL)`.
    //
    // Note this is NOT the same as "send everything", which a permissive reading
    // of "the only Query Replies being requested are those specified" might
    // suggest. An empty list requests nothing, and nothing is supported of it.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(Array.from(reply)).toEqual([AID.SF, 0x00, 0x04, Sfid.QUERY_REPLY, 0xff]);
  });

  it('builds the same Null reply through the standalone helper', () => {
    // buildNullQueryReply exists for callers that have already decided; it must
    // not be a second, drifting copy of the framing.
    expect(Array.from(buildNullQueryReply(GEOMETRY)))
      .toEqual(Array.from(buildReply(
        { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [] },
        DEFAULT_CAPABILITIES, GEOMETRY)));
  });

  it('throws on the reserved REQTYP rather than inventing a reply', () => {
    // p. 5-51 (pages.txt:6361): "B'11' Reserved". x3270 returns PDS_BAD_CMD
    // (sf.c:301-303). Unreachable from a live session — stream/sf.ts screens it
    // before it becomes an sfReply — so this asserts the assertion.
    expect(() => buildReply(
      { kind: 'queryList', reqtyp: 0xc0, qcodes: [] }, DEFAULT_CAPABILITIES, GEOMETRY))
      .toThrow(RangeError);
  });
});

/**
 * The Table 6-1 "Query" column, which distinguishes Equivalent from All.
 *
 * Every capability we ship today is Query-returnable, so these two request types
 * produce identical output and no test using DEFAULT_CAPABILITIES can tell them
 * apart. That is a fact about our current three units, not about the protocol —
 * Table 6-1 has genuine "No" rows, e.g. "Begin/End of File No X'9F' No Yes"
 * (pages.txt:8587) and "Graphic Symbol Sets No X'B6' No Yes" (pages.txt:8604).
 *
 * So these tests inject a synthetic non-Query-returnable capability. Without
 * them, deleting the returnedForQuery filter from selectCapabilities would leave
 * the whole suite green while silently breaking Equivalent for the first such
 * capability anyone adds — which is precisely the regression the filter exists
 * to prevent, and the reason it is written now rather than later.
 */
describe('a capability a plain Query does not return', () => {
  /** Stands in for Begin/End of File (0x9F), "No ... No Yes" in Table 6-1. */
  const allOnly: Capability = {
    qcode: 0x9f,
    returnedForQuery: false,
    params: () => [],
  };
  const CAPS = [...DEFAULT_CAPABILITIES, allOnly];
  const qcodesOf = (reply: Uint8Array): number[] => {
    const out: number[] = [];
    let i = 1;
    while (i < reply.length) {
      const len = (reply[i]! << 8) | reply[i + 1]!;
      out.push(reply[i + 3]!);
      i += len;
    }
    return out;
  };

  it('is omitted from a plain Query', () => {
    expect(qcodesOf(buildReply({ kind: 'query' }, CAPS, GEOMETRY))).not.toContain(0x9f);
  });

  it('is omitted from an Equivalent with no list', () => {
    // The regression this file exists for: Equivalent means "what a Query would
    // return", so a No row must stay out even though All would include it.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.EQUIVALENT, qcodes: [] }, CAPS, GEOMETRY);
    expect(qcodesOf(reply)).not.toContain(0x9f);
  });

  it('is included in an Equivalent that names it, since the list adds to the set', () => {
    // p. 5-52: Equivalent sends the Query set "in addition to / those QCODEs (if
    // any) that are specified in the QCODE list" (pages.txt:6381-6382).
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.EQUIVALENT, qcodes: [0x9f] }, CAPS, GEOMETRY);
    expect(qcodesOf(reply)).toContain(0x9f);
    // ...and still carries the Query set alongside it, which is the "equivalent
    // PLUS list" half of the rule.
    expect(qcodesOf(reply)).toContain(Qcode.USABLE_AREA);
  });

  it('is included in All', () => {
    // Table 6-1's third column is "Yes" for every row, including the No ones:
    // All means all supported.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.ALL, qcodes: [] }, CAPS, GEOMETRY);
    expect(qcodesOf(reply)).toContain(0x9f);
  });

  it('is included when a QCODE list names it', () => {
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [0x9f] }, CAPS, GEOMETRY);
    // Only 0x9f: a QCODE-List reply carries exactly what was named, and Summary
    // was not. See the QCODE-List test above for why an earlier version of this
    // suite expected a forced Summary here.
    expect(qcodesOf(reply)).toEqual([0x9f]);
  });

  it('is listed in Summary regardless, because Summary reports support', () => {
    // p. 6-20 is explicit that this is Summary's job: it is "the only /
    // indication of support of functions where the associated Query Reply is
    // returned in / reply to a Query List = QCODE List or All"
    // (pages.txt:8574-8576). A capability returned ONLY for All is exactly that
    // case, so omitting it from Summary would make it undiscoverable.
    const reply = buildReply({ kind: 'query' }, CAPS, GEOMETRY);
    // Read through unitBody rather than slicing `reply.subarray(5, 5 + 4)`, which
    // is what this line used to do: that 4 was the Summary body length back when
    // there were three capabilities plus this synthetic one, so adding Color and
    // Highlighting made the slice cover only the first four of six QCODEs and cut
    // 0x9F off the end. A hardcoded window into a derived list is a latent break;
    // the QCODE lookup cannot drift.
    expect(unitBody(reply, Qcode.SUMMARY)).toContain(0x9f);
    // 0x9F is in Summary but NOT in the reply, which is the whole claim. Without
    // this, a Summary listing everything AND a reply carrying everything would
    // pass just as well.
    expect(qcodesOf(reply)).not.toContain(0x9f);
  });
});

// REMOVED: a describe block asserting that a QCODE-List reply prepends the
// CALLER'S Summary capability rather than this module's. That behaviour is gone —
// Summary is no longer forced into a QCODE-List reply at all, because p. 6-96's
// "QCODE List=X'80'" is Summary's own QCODE and not a REQTYP. Nothing replaced it:
// there is no longer a substitution to get wrong.
