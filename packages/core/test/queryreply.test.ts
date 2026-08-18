import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildQueryReply, buildNullQueryReply, buildReply, DEFAULT_CAPABILITIES,
  type Capability,
} from '../src/queryreply.js';
import { AID, Qcode, ReqTyp, Sfid } from '../src/constants.js';

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
    const extra: Capability = { qcode: 0x86, returnedForQuery: true, params: () => [] };
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

  const ALL_THREE = [Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.IMPLICIT_PARTITION];

  it('answers the real VM/370 MECAFF request with all three units', () => {
    // THE CASE THAT UNBLOCKS VM/CMS FILE TRANSFER. Captured live:
    // 00 07 01 ff 03 80 00 — REQTYP 0x80 = B'10' All, with a one-byte QCODE
    // list [0x00]. Built here from the same values the parser produces for those
    // bytes; the byte-level parse is asserted in sf.test.ts.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.ALL, qcodes: [0x00] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual(ALL_THREE);
    // And it is a well-formed record, not just a right-shaped list: same AID as
    // every other reply.
    expect(reply[0]).toBe(AID.SF);
  });

  it('ignores the QCODE list under REQTYP=All', () => {
    // "The Query List = All can contain a / QCODE list. However, the QCODE list
    // is ignored" (pages.txt:8554-8557); p. 5-52 puts it as "the All flag
    // overrides the list" (pages.txt:6388-6389).
    //
    // The list here asks for Color and Highlighting, which we do NOT support, so
    // an implementation that intersected instead of ignoring would return the
    // Null Query Reply. That makes this a real discrimination, not a tautology:
    // measured against a deliberately-intersecting selectCapabilities, this
    // yields [0xff].
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.ALL, qcodes: [0x86, 0x87] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual(ALL_THREE);
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

  it('returns only the listed units for REQTYP=QCODE List, plus Summary', () => {
    // "the 3270 data stream device or / workstation returns all the requested
    // Query / Replies (QCODES listed) that are supported" (pages.txt:10768-
    // 10770). Summary rides along unlisted because p. 6-96 requires it: "must
    // always be sent inbound in reply to a Read Partition / structured field
    // specifying Query, or Query List (QCODE List=X'80', / Equivalent, or All)"
    // (pages.txt:11409-11411). x3270 omits it here; see the note on buildReply.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [Qcode.USABLE_AREA] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual([Qcode.SUMMARY, Qcode.USABLE_AREA]);
    // Implicit Partition was not asked for and must not appear. Spelled out
    // because the assertion above would also pass if the order merely differed.
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
    // So a one-unit request still advertises all three.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [Qcode.USABLE_AREA] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    const summaryUnit = units(reply)[0]!;
    expect(summaryUnit[3]).toBe(Qcode.SUMMARY);
    expect(Array.from(summaryUnit.subarray(4))).toEqual(ALL_THREE);
  });

  it('does not send Summary twice when the list names it', () => {
    // The always-send rule must not become a duplicate-reply violation: "the
    // 3270 device or / workstation does not return duplicate Query Replies"
    // (pages.txt:8542-8544).
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
    expect(qcodesOf(reply)).toEqual([Qcode.SUMMARY, Qcode.USABLE_AREA]);
  });

  it('ignores unsupported QCODEs in a list that also names a supported one', () => {
    // "All QCODE values in the list are valid. Those QCODEs not supported are /
    // ignored." (pages.txt:6395-6396.) The manual's own worked example, p. 6-77:
    // a device supporting A, B, C asked for A, X, Z "does not send the Null Query
    // Reply. It sends the Query Reply for / feature A only." (pages.txt:10755-
    // 10757.)
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [0x86, Qcode.USABLE_AREA, 0x87] },
      DEFAULT_CAPABILITIES, GEOMETRY);
    expect(qcodesOf(reply)).toEqual([Qcode.SUMMARY, Qcode.USABLE_AREA]);
  });

  it('returns the Null Query Reply when it supports nothing requested', () => {
    // p. 6-77's example 2: "A device supports features A, B, and C. / The host
    // queries for features X, Y, and Z. / The device sends the Null Query Reply"
    // (pages.txt:10758-10761). 0x86 is Color and 0x87 Highlighting, neither of
    // which we advertise.
    //
    // BYTE-EXACT, because the whole unit is four bytes and every one is fixed by
    // p. 6-77's table (pages.txt:10768-10771): L=X'0004', SFID=X'81',
    // QCODE=X'FF'. The leading 0x88 is the AID that precedes any Query Reply.
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [0x86, 0x87] },
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
    expect(qcodesOf(reply)).toEqual([Qcode.SUMMARY, 0x9f]);
  });

  it('is listed in Summary regardless, because Summary reports support', () => {
    // p. 6-20 is explicit that this is Summary's job: it is "the only /
    // indication of support of functions where the associated Query Reply is
    // returned in / reply to a Query List = QCODE List or All"
    // (pages.txt:8574-8576). A capability returned ONLY for All is exactly that
    // case, so omitting it from Summary would make it undiscoverable.
    const reply = buildReply({ kind: 'query' }, CAPS, GEOMETRY);
    const summaryBody = reply.subarray(5, 5 + 4);
    expect(Array.from(summaryBody)).toContain(0x9f);
  });
});

describe('the Summary forced into a QCODE-List reply', () => {
  it("uses the caller's own Summary capability, not a substituted one", () => {
    // selectCapabilities prepends Summary to a QCODE-List reply that did not
    // name it. It must prepend the Summary from the CALLER'S list: substituting
    // this module's private one would silently discard a caller's definition and
    // emit a unit it never asked for. Distinguishable only by content, so this
    // Summary carries a recognisable marker body instead of a QCODE list.
    const marked: Capability = {
      qcode: Qcode.SUMMARY,
      returnedForQuery: true,
      params: () => [0xde, 0xad],
    };
    const caps = [marked, ...DEFAULT_CAPABILITIES.filter((c) => c.qcode !== Qcode.SUMMARY)];
    const reply = buildReply(
      { kind: 'queryList', reqtyp: ReqTyp.QCODE_LIST, qcodes: [Qcode.USABLE_AREA] },
      caps, GEOMETRY);
    // 88, then L L 81 80 de ad — the marker survives, so it was not replaced.
    expect(Array.from(reply.subarray(0, 7)))
      .toEqual([AID.SF, 0x00, 0x06, Sfid.QUERY_REPLY, Qcode.SUMMARY, 0xde, 0xad]);
  });
});
