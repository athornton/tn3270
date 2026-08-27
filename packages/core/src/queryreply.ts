import { AID, Qcode, ReqTyp, Sfid, XAH } from './constants.js';
import { Colour } from './palette.js';

/**
 * Query Reply, the answer to a host's Read Partition (Query).
 *
 * Built from a CAPABILITY LIST rather than a hardcoded byte blob, so
 * advertising something later is one list entry and the Summary unit cannot
 * disagree with what is actually sent.
 *
 * Every unit here is one we honour, which is the rule that decides what goes in.
 * Stage 2a shipped the minimal honest set — Summary, Usable Area, Implicit
 * Partition — and deliberately withheld Color and Highlighting because they
 * invite the SA orders it did not implement. Now that SA and the four-level
 * colour resolution are in, the two are honest and are advertised.
 *
 * ADVERTISING THEM IS NOT WHAT MAKES HOST COLOUR ARRIVE. MVS 3.8j TK5 sends SA
 * colour whether or not we ask — the committed trace fixture has 113 SA orders
 * against a client that advertised neither unit — so these two are for
 * correctness with better-behaved hosts, not a prerequisite. x3270 sends ten
 * units; we still send five. See the stage 2a design doc.
 */

export interface ScreenGeometry {
  /** The DEFAULT (Erase/Write) size. */
  readonly rows: number;
  readonly cols: number;
  /**
   * The ALTERNATE (Erase/Write Alternate) size. Absent means "same as default",
   * which is a model 2 and what every caller predating alternate-size support
   * means.
   *
   * WHICH UNITS USE WHICH, verified against x3270's sf.c rather than guessed,
   * because getting it inconsistent would advertise two different maxima in one
   * reply: Usable Area is the MAXIMUM (`sf.c:718-719` writes maxCOLS/maxROWS),
   * BUFFSZ is the MAXIMUM product (`sf.c:731`, which x3270 itself labels
   * "questionable"), and only Implicit Partition carries both -- default then
   * alternate (`sf.c:919-922`).
   */
  readonly alternate?: { readonly rows: number; readonly cols: number };
}

/** The alternate size, defaulting to the default size. */
function alt(g: ScreenGeometry): { readonly rows: number; readonly cols: number } {
  return g.alternate ?? { rows: g.rows, cols: g.cols };
}

export interface Capability {
  readonly qcode: number;
  /**
   * Unit body AFTER `L L SFID QCODE` — the builder writes that prefix.
   *
   * `all` is EVERY capability we support, NOT the subset being sent in this
   * particular reply. Only Summary reads it, and that distinction is the whole
   * point: see the note on `summary` below.
   */
  readonly params: (geometry: ScreenGeometry, all: readonly Capability[]) => number[];
  /**
   * Does a plain Read Partition (Query) return this unit?
   *
   * This is Table 6-1's "Query" column (p. 6-21, pages.txt:8584+), and it is
   * genuinely per-reply rather than universal: Begin/End of File is "No X'9F'
   * No Yes" (pages.txt:8587) and Graphic Symbol Sets is "No X'B6' No Yes"
   * (pages.txt:8604) — returned for All, never for a Query or an Equivalent.
   *
   * REQUIRED, not optional-defaulting-to-true, deliberately. All three units we
   * ship today are "Yes", so a default would be correct for every existing
   * entry and silently wrong for the first "No" someone adds — and the failure
   * would be invisible: an Equivalent reply carrying a unit a Query would never
   * return, which is exactly the regression this field exists to prevent. A
   * required field makes the author look the row up in Table 6-1 and turns
   * forgetting into a compile error.
   */
  readonly returnedForQuery: boolean;
}

/**
 * What the host asked for, distilled from the parsed Read Partition.
 *
 * Lives here rather than in stream/sf.ts because the RULES for turning it into
 * units live here, next to the capability list they filter. stream/sf.ts owns
 * the bytes; this owns the meaning.
 */
export type QueryRequest =
  /** Read Partition TYPE=0x02. */
  | { readonly kind: 'query' }
  /** Read Partition TYPE=0x03. reqtyp is already masked to bits 0-1. */
  | { readonly kind: 'queryList'; readonly reqtyp: number; readonly qcodes: readonly number[] };

/**
 * Big-endian 16-bit, range-checked.
 *
 * Throwing rather than masking, which is what encodeAddress and encodeAttribute
 * do at comparable boundaries. Masking was silently wrong in three ways that all
 * produced a plausible-looking record a host would act on: a negative cols
 * emitted X'FFFF', which the telnet layer then IAC-doubles into wire garbage; a
 * fractional geometry truncated W/H while BUFFSZ kept the fraction, so the reply
 * contradicted itself; and a params list over 65531 bytes wrapped L.
 *
 * This does NOT reject zero, and must not: X'0000' is a legal value for several
 * fields in this reply (the reserved base bytes, and BUFFSZ on a partitioned
 * device per p. 6-104). A zero screen DIMENSION is separately illegal, and
 * buildQueryReply enforces that where it belongs.
 */
const u16 = (n: number): number[] => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new RangeError(`not a 16-bit value: ${n}`);
  }
  return [(n >> 8) & 0xff, n & 0xff];
};

/**
 * Self-defining parameter: `L SDPID <params>`, where L counts itself.
 *
 * Derived, not hand-written, for the same reason buildQueryReply derives the
 * outer length. Hardcoding X'0B' means a later SDP edit has to remember to
 * update a magic number, and nothing but the x3270 fixture would notice.
 */
const sdp = (id: number, params: number[]): number[] => [2 + params.length, id, ...params];

/**
 * Summary (QCODE 0x80), GA23-0059 p. 6-96 for the format, p. 6-20 for the rule.
 *
 * Format is just the generic Query Reply header plus a list: "4-N LIST List of
 * supported QCODES" (pages.txt:11421, p. 6-96). That page's QCODE row is OCR
 * rubble — "3 QCODE x·ao· Identifies this Query Reply as Summary"
 * (pages.txt:11419) — which is another reason 0x80 comes from the prose.
 *
 * Every device must support it — "All 3270 data stream devices or workstations
 * must support the Summary Query Reply, QCODE = X '80'" (pages.txt:8568-8569,
 * p. 6-20; note the OCR spaces inside X '80') — and it lists the QCODEs of all
 * supported replies INCLUDING its own: "(The QCODE for the Summary Query Reply
 * itself is also included in the list.)" (pages.txt:8572-8573). That falls out
 * of mapping the capability list, which is the point of deriving it.
 *
 * Do not take Summary's QCODE from Table 6-1: that row OCRs as "Summary Yes
 * X'BO' Yes Yes" (pages.txt:8635), and 0xB0 is a real QCODE (Segment) so the
 * damage is not self-evident. See the note on Qcode in constants.ts.
 *
 * SUMMARY LISTS EVERYTHING WE SUPPORT, NOT WHAT THIS PARTICULAR REPLY CARRIES.
 * That is the opposite of what the Query List brief for this work assumed, and
 * the sources are unambiguous on it — twice over:
 *
 *  1. The manual defines the content as total capability, not reply contents:
 *     "The Summary Query Reply provides / a list of the QCODEs of all the Query
 *     Replies supported by the 3270 data stream / device or workstation."
 *     (pages.txt:8570-8572, p. 6-20; emphasis on "all ... supported").
 *  2. The next sentence gives the REASON, and it is a functional one rather
 *     than a matter of taste: "The Summary Query Reply provides the host with
 *     the only / indication of support of functions where the associated Query
 *     Reply is returned in / reply to a Query List = QCODE List or All."
 *     (pages.txt:8574-8576.) Summary is how a host discovers what it may ASK
 *     for next. Narrowing the list to the current reply would make a QCODE-List
 *     reply advertise a device that supports only what was just requested, and
 *     a host walking Summary to plan a second request would never learn about
 *     the rest.
 *
 * x3270 agrees and does not vary by request: do_qr_summary loops the whole
 * reply table (sf.c:699-708), `for (i = 0; i < NSR; i++) ... *obptr++ =
 * replies[i].code`, with no reference to the QCODE list that selected it. So a
 * QCODE-List request for just 0x81 gets an x3270 Summary listing all eleven.
 *
 * This is why Capability.params receives `all` — the full support list — and
 * not the subset being sent. Do NOT "fix" that to the subset: it would look
 * more self-consistent and would be wrong.
 *
 * SUMMARY IS ALSO ALWAYS SENT, whatever the request. p. 6-96 states it as an
 * unconditional rule: "The Summary Query Reply must always be sent inbound in
 * reply to a Read Partition / structured field specifying Query, or Query List
 * (QCODE List=X'80', / Equivalent, or All)." (pages.txt:11409-11411.) Note that
 * covers QCODE List, so a list naming only 0x81 still gets Summary. buildReply
 * enforces this; see the note there, which is also where x3270's narrower
 * behaviour is recorded.
 */
const summary: Capability = {
  qcode: Qcode.SUMMARY,
  returnedForQuery: true, // Table 6-1: "Summary Yes ... Yes Yes" (pages.txt:8635)
  params: (_geometry, all) => all.map((c) => c.qcode),
};

/**
 * Usable Area (QCODE 0x81), GA23-0059 p. 6-101.
 *
 * L L SFID QCODE FLAGS FLAGS W W H H UNITS Xr(4) Yr(4) AW AH BUFFSZ(2).
 * "Bytes 0 through 20 must always be included in the Usable Area Query Reply
 * Base. Bytes 21 through 26 (parameters BUFFSZ and XMIN, YMIN, XMAX, YMAX) must
 * be present if any self-defining parameters are included."
 * (pages.txt:11645-11647, p. 6-102.)
 *
 * We send NO self-defining parameters and set no VCP flag, so by that rule
 * BUFFSZ is optional for us — p. 6-104 says "If there are no self-defining
 * parameters, no variable character cell parameters, and the BUFFSZ parameter is
 * not applicable, then both the BUFFSZ and the XMIN, YMIN, XMAX, YMAX can be
 * omitted" (pages.txt:11783-11785). We include it anyway: BUFFSZ IS applicable
 * to us, because p. 6-104 scopes it to exactly our case — "It applies only to a
 * device that does not support partitions" (pages.txt:11779-11780) — and we
 * support no partitions. Including it is also what x3270 does and what this host
 * accepted. Total 23 bytes = x3270's L=0x17.
 *
 * The fixed values are x3270's (Common/sf.c:711-732, do_qr_usable_area), which
 * this host accepted.
 * They are dimensional constants of the device, not capability claims, so
 * copying them advertises nothing we do not honour. Each is checked against the
 * manual's byte table below.
 */
const usableArea: Capability = {
  qcode: Qcode.USABLE_AREA,
  // Table 6-1: "Usable Area Yes X'81' Yes Yes" (pages.txt:8638) — that row is
  // OCR-clean, unlike Summary's.
  returnedForQuery: true,
  params: (geometry) => [
    // FLAGS byte 4. Bits 4-7 are ADDR; X'1' = "12/14-bit addressing allowed"
    // (pages.txt:11601). PP, HC and the reserved bits are all zero: we are a
    // display, not a page printer and not a hard copy device. This is a real
    // claim and we honour it — address.ts decodeAddress handles both the 14-bit
    // binary and 12-bit coded forms and rejects the reserved 10 flag.
    0x01,
    // FLAGS byte 5. VCP=0 (variable cells not supported — which is why no
    // XMIN/YMIN/XMAX/YMAX follow BUFFSZ), CHAR=0 (matrix character),
    // CELLUNITS=0. NOTE the manual's CELLUNITS wording, pages.txt:11612-11614:
    // B'0' means bytes 6-9 are in CELLS, B'1' means pels. So W and H below are
    // cell counts, which is what makes 80x24 correct there.
    0x00,
    // The MAXIMUM, not the default: x3270 writes maxCOLS/maxROWS here
    // (sf.c:718-719). Reporting the default would tell a host the alternate size
    // it is about to be offered does not fit in the usable area.
    ...u16(alt(geometry).cols), // 6-7  W: width of usable area, in cells
    ...u16(alt(geometry).rows), // 8-9  H: height of usable area, in cells
    // 10 UNITS. The manual's values are "X'OO' Inches" / "X'01' Millimeters"
    // (pages.txt:11619-11620; the O in X'OO' is OCR of a zero). So 0x01 does
    // mean millimetres, matching x3270's own comment "units (mm)" (sf.c:720).
    //
    // KNOWN INCONSISTENCY, inherited deliberately from x3270 and NOT a typo
    // here. This byte says millimetres, but the Xr/Yr fractions below are
    // inch-scaled, so the pair does not describe a physical device. Worked out:
    // Xr = 10/741 is 1/74.1, i.e. 74.1 pel centres per unit; at 9 pels per cell
    // and 80 cells that is 9.7 units across. Read as INCHES the screen is
    // 9.7 x 5.2 in, an 11-inch diagonal, which is a real 3279-2. Read as
    // MILLIMETRES it is 9.7 x 5.2 mm, which is absurd. The manual's own worked
    // example settles the scale: "UNITS X'OO' / Xr X' 00020091 ' (2/145 inch)"
    // for a device with "72.5 pels/inch horizontally" (pages.txt:11762-11765),
    // and 2/145 is exactly 1/72.5 — the same inches-per-pel form as 10/741.
    //
    // Left as-is on purpose: these four values are byte-identical to what this
    // host ACCEPTED from x3270, they are inert until someone implements
    // graphics (x3270 flags them "If we ever implement graphics, these will need
    // to change", sf.c:724-727), and changing UNITS to 0x00 would trade a
    // documented inconsistency for an undocumented deviation from the reference.
    // Anyone doing graphics work must revisit UNITS and Xr/Yr together.
    0x01,
    // 11-14 Xr: "Distance between points in X direction as a fraction, measured
    // in UNITS, with 2-byte numerator and 2-byte denominator" (pages.txt:11626).
    // 0x000a / 0x02e5 = 10/741. x3270's Xr_3279_2 = 0x000a02e5 (sf.c:56).
    // NOTE it is the PAIR 10 and 741, not one 32-bit quantity — reading it as
    // a single number is the mistake to avoid.
    0x00, 0x0a, 0x02, 0xe5,
    // 15-18 Yr: same numerator/denominator form in the Y direction.
    // 0x0002 / 0x006f = 2/111, i.e. 55.5 pel centres per unit. x3270's
    // Yr_3279_2 = 0x0002006f (sf.c:57).
    0x00, 0x02, 0x00, 0x6f,
    // 19 AW: "Number of X units in default cell" (pages.txt:11632). "X units"
    // are the pel pitches defined by Xr, so this is 9 pels of cell width — NOT
    // a count of millimetres or inches. x3270's SW_3279_2 = 0x09 (sf.c:54).
    0x09,
    // 20 AH: "Number of Y units in default cell" (pages.txt:11633), so 12 pels
    // of cell height. 9x12 is the standard 3279 cell. SH_3279_2 = 0x0c (sf.c:55).
    0x0c,
    // 21-22 BUFFSZ: "Character buffer size (bytes)" (pages.txt:11634). Cells
    // and bytes coincide for a non-DBCS display of this size. x3270 writes
    // maxCOLS*maxROWS here and flags it "buffer, questionable" (sf.c:731).
    ...u16(alt(geometry).rows * alt(geometry).cols),
  ],
};

/**
 * Implicit Partition (QCODE 0xA6), GA23-0059 p. 6-71.
 *
 * NESTED, and the nesting is easy to get wrong. The BASE is
 * `L L SFID QCODE FLAGS FLAGS` with bytes 4-5 "FLAGS X'OOOO' Reserved"
 * (pages.txt:10528, p. 6-71 — those O characters are OCR of zeros), and the
 * Sizes-for-Display self-defining parameter sits inside it (p. 6-72):
 * `L=X'OB' SDPID=X'01' FLAGS=X'OO' WD WD HD HD WA WA HA HA`
 * (pages.txt:10558-10566). 6 + 11 = 17, which is x3270's L=0x11. Omitting the
 * two reserved bytes shifts every byte after them.
 *
 * SDPID 0x01 is display-specific: the printer form of this parameter is
 * "SDPID X'03'" at p. 6-73 (pages.txt:10596), so 0x01 is not a generic "sizes"
 * tag and picking it is a claim that we are a display.
 *
 * Alternate equals default deliberately: p. 6-72 requires that a device with no
 * alternate screen size report the default as its alternate — "If the device
 * does not have an alternate screen size, the value for the alternate screen
 * size must be that of the default screen size." (pages.txt:10548-10549).
 * Stage 2a does not implement mid-session resize, so claiming a second size
 * would be a lie the host would act on.
 *
 * NOTE we differ from x3270 in DERIVATION, not in bytes: x3270 hardcodes the
 * default as literal 80 and 24 (sf.c:919-920) and uses maxCOLS/maxROWS for the
 * alternate. Its two alternate comments are also swapped — sf.c:921 writes
 * maxCOLS labelled "alternate height", sf.c:922 writes maxROWS labelled
 * "alternate width" — so do not read those labels as authority for the field
 * order; the manual's WA-then-HA table is. We drive all four from the geometry,
 * which equals x3270's output at 24x80 and stays self-consistent off it.
 */
const implicitPartition: Capability = {
  qcode: Qcode.IMPLICIT_PARTITION,
  // Table 6-1: "Implicit Partition Yes X'A6' Yes Yes" (pages.txt:8608).
  returnedForQuery: true,
  params: (geometry) => [
    0x00, 0x00, // base bytes 4-5 FLAGS: reserved, X'0000'
    // SDPID X'01', then FLAGS and the four sizes. L comes out as X'0B' — the
    // manual's value — because sdp() counts itself: 2 + 9.
    ...sdp(0x01, [
      0x00, // SDP FLAGS: reserved
      ...u16(geometry.cols), ...u16(geometry.rows), // WD HD — default
      ...u16(alt(geometry).cols), ...u16(alt(geometry).rows), // WA HA — alternate
    ]),
  ],
};

/**
 * Color (QCODE 0x86), GA23-0059 p. 6-36 (pages.txt:9198+, NOT p. 6-38).
 *
 * Body after the header: `FLAGS NP` then NP (CAV, CI) pairs
 * (pages.txt:9214-9225).
 *
 *  - FLAGS is zero. Its only defined bit is PRTBLK, "Printer only - black ribbon
 *    is loaded" (pages.txt:9217-9221); we are a display and everything else in
 *    the byte is reserved. x3270 calls it "no options" (sf.c:743).
 *  - NP = 16, x3270's color_max (sf.c:738).
 *  - THE FIRST PAIR IS MANDATORY AND IS NOT AN IDENTITY: "All devices that send
 *    Query Reply (Color) are required to have the values CAV1 = X' 00', Cl 1 =
 *    value associated with the device default color, as the first entry"
 *    (pages.txt:9268-9270). CAV1 = X'00' is XAC_DEFAULT, the "device default"
 *    colour VALUE — the same 0x00 render.ts's usableColour rejects so that
 *    resolution falls through to the base map. CI1 must name a real colour, and
 *    may be anything "except X' 00'" (pages.txt:9266-9267).
 *  - CI1 IS GREEN, not white and not black. x3270 writes `0xf0 +
 *    HOST_COLOR_GREEN` = 0xF4 (sf.c:746, 3270ds.h:317), and p. 6-36's colour
 *    table gives "Green X'F4'" (pages.txt:9251). Taken from Colour.GREEN rather
 *    than written as a literal because it must agree with render.ts: level 4
 *    resolves an ordinary unprotected normal-intensity field to GREEN, so the
 *    advertised default is the colour we actually paint.
 *  - The remaining fifteen are IDENTITY pairs, 0xF1..0xFF. The manual allows
 *    either identity or the device default — "The device must either display the
 *    color whose color identifier is the same as the color attribute value or
 *    display the device default color" (pages.txt:9236-9238) — and identity is
 *    the honest answer here, because PALETTE_3279 has an entry for every one of
 *    the fifteen.
 *
 * WE ALWAYS ADVERTISE THE IDENTITY, where x3270 emits 0x00 as the CI outside
 * mode3279 (sf.c:747-754). Our own capture was taken in that monochrome state,
 * so the fixture reads `00 f4 f1 00 f2 00 ...` — a real divergence, not an
 * oversight, and the reason is structural: x3270's mode3279 is a MODEL choice
 * that also selects its terminal type ("327" + '9' vs '8', model.c:135-137,
 * telnet.c:2104), so for x3270 the negotiation and the rendering travel
 * together. Ours do not. TERMINAL_TYPE is IBM-3278-2 regardless, and render.ts's
 * mode3279 is a per-render presentation flag with no path into this module.
 * Gating on it would make the same session advertise different colour support
 * depending on a rendering option the host cannot see.
 *
 * It also stays TRUE under mode3279: false, which is why the divergence is safe
 * rather than merely convenient. CI does not mean "I will light this pixel"; it
 * identifies "the colors that are displayed or printed ... for each of the
 * accepted color attribute values" (pages.txt:9233-9235), and Screen stores the
 * CAV per cell whatever a later renderer chooses to do with it.
 *
 * NO Default Background Color self-defining parameter. x3270 can append a 4-byte
 * `04 02 00 f0` when its screen has a background colour and appres.qr_bg_color is
 * set (sf.c:756-765); the captured x3270 did not, and neither do we — we have no
 * settable default background to report.
 */
const color: Capability = {
  qcode: Qcode.COLOR,
  // Table 6-1: "Color Yes X'86' Yes Yes" (pages.txt:8589).
  returnedForQuery: true,
  params: () => {
    // NP is DERIVED from the list below, not written as 0x10, for the same
    // reason sdp() counts itself and buildQueryReply derives L: a hand-written
    // count is a magic number that a later edit to the pairs would leave stale,
    // and a host that trusts NP would then mis-parse the rest of the record.
    const pairs = [[0x00, Colour.GREEN]];
    for (let cav = 0xf1; cav <= 0xff; cav++) pairs.push([cav, cav]);
    return [0x00, pairs.length, ...pairs.flat()];
  },
};

/**
 * Highlighting (QCODE 0x87), GA23-0059 p. 6-65 (pages.txt:10304+, NOT p. 6-53).
 *
 * Body after the header: `NP` then NP (Vi, Ai) pairs — "NP Number of
 * attribute-value/action pairs", "Vi Data stream attribute value accepted",
 * "Ai Data stream action" (pages.txt:10343-10345).
 *
 * Five pairs, matching x3270's do_qr_highlighting (sf.c:769-784), and the first
 * is DEFAULT -> NORMAL rather than DEFAULT -> DEFAULT. Both halves of that are
 * required reading:
 *
 *  - The X'00' entry is compulsory: "If a device accepts the highlight
 *    attribute, then it must accept attribute value X' 00' (default
 *    specification)." (pages.txt:10312-10313.)
 *  - Answering NORMAL names the action outright. An action of X'00' would mean
 *    "the device action for the corresponding attribute value is the same as the
 *    action for the attribute value X '00' (the default action of the device)"
 *    (pages.txt:10329-10331) — true but circular. x3270 answers XAH_NORMAL
 *    (sf.c:774-775) and so do we.
 *
 * The other four are identities, and each is a claim render.ts honours: it sets
 * exactly one of blink/reverse/underscore/intensify by equality against these
 * values. Exclusivity is the architecture's, not ours: "This structured field
 * indicates that the device supports highlighting on an exclusive basis. That
 * is, one and only one of the highlight values can be applied to a field or
 * character location." (pages.txt:10326-10328.)
 *
 * INTENSIFY (X'F8') is the value to double-check rather than the one to doubt:
 * Chapter 4's highlighting table omits it entirely (pages.txt:3487-3498) and only
 * this unit's section lists it (pages.txt:10314-10325). See the trap note on XAH
 * in constants.ts.
 */
const highlighting: Capability = {
  qcode: Qcode.HIGHLIGHTING,
  // Table 6-1: "Highlighting Yes X'87' Yes Yes" (pages.txt:8605).
  returnedForQuery: true,
  params: () => {
    // Derived NP again — see the note in `color`.
    const pairs: number[][] = [
      [XAH.DEFAULT, XAH.NORMAL],
      [XAH.BLINK, XAH.BLINK],
      [XAH.REVERSE, XAH.REVERSE],
      [XAH.UNDERSCORE, XAH.UNDERSCORE],
      [XAH.INTENSIFY, XAH.INTENSIFY],
    ];
    return [pairs.length, ...pairs.flat()];
  },
};

/**
 * What we advertise. Adding a unit is one entry here.
 *
 * ORDER IS WIRE ORDER: buildQueryReply emits units in list order, so inserting
 * Color and Highlighting before Implicit Partition changed the inbound byte
 * stream. That is deliberate and it matches the order x3270 sends (its reply
 * table runs 0x80, 0x81, ..., 0x86, 0x87, ..., 0xa6, sf.c:82-92), which is also
 * ascending QCODE. The manual imposes no requirement — "There is no requirement
 * as to the order of the QCODES ... or the order that the requested Query
 * Replies are / returned" (pages.txt:8534-8539) — so this is for comparability
 * with x3270 captures, not conformance.
 */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  summary, usableArea, color, highlighting, implicitPartition,
];

/**
 * The complete inbound record: AID 0x88 then each unit, length-prefixed.
 *
 * One AID for the whole set, not one per unit: "If the structured field is one
 * of a set of Query Reply structured fields, only the first is preceded by an
 * AID of X'88'." (pages.txt:8648-8649, p. 6-22.)
 *
 * The AID is 0x88, which is AID.SF. It is NOT AID.QREPLY (0x61), whose name in
 * that same enum reads as though it belonged here. 0x61 is the AID on a Read
 * Modified or Read Buffer that a Read Partition triggers — x3270 passes
 * AID_QREPLY to ctlr_read_modified and ctlr_read_buffer (sf.c:314, :324, :332),
 * never to a Query Reply. Different case entirely.
 *
 * Returns pure 3270 data. IAC doubling is the telnet layer's job (telnet.ts:82,
 * in sendRecord), which matters here because 0xFF appears in real reply content
 * — see the Color unit in the x3270 fixture.
 */
export function buildQueryReply(
  capabilities: readonly Capability[],
  geometry: ScreenGeometry,
  /**
   * Everything the device supports, when that differs from what is being SENT.
   *
   * Only Summary reads it, and it exists because Summary's content is defined as
   * total capability rather than reply contents — "a list of the QCODEs of all
   * the Query Replies supported by the 3270 data stream / device or workstation"
   * (pages.txt:8570-8572, p. 6-20). Without this parameter a QCODE-List reply's
   * Summary would advertise only the units that request happened to select, and
   * a host walking Summary to plan its next request would never learn the rest
   * — the exact failure p. 6-20 warns about when it calls Summary "the only /
   * indication of support" for QCODE-List-returned functions (pages.txt:8574).
   *
   * DEFAULTS TO `capabilities`, which is right for the plain-Query path where
   * the two are the same list, and keeps this a compatible addition.
   */
  supported: readonly Capability[] = capabilities,
): Uint8Array {
  // Nonzero is a GEOMETRY rule, not an encoding rule, so u16 is the wrong place
  // for it: X'0000' is a legitimate 16-bit field elsewhere in this very reply
  // (p. 6-104 has BUFFSZ "set to zero" for a partitioned device, and X'0000'
  // is the required value of the two reserved base bytes). What is illegal is a
  // zero SCREEN dimension — p. 6-72, "Default and alternate values must be
  // nonzero" — and a zero would otherwise sail through u16 unnoticed.
  // The alternate is checked too, and by the same rule: p. 6-72 says "Default and
  // alternate values must be nonzero", so a zero alternate is exactly as illegal
  // as a zero default and would otherwise sail through u16 unnoticed.
  for (const [name, value] of [
    ['rows', geometry.rows], ['cols', geometry.cols],
    ['alternate.rows', alt(geometry).rows], ['alternate.cols', alt(geometry).cols],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`geometry.${name} must be a positive integer, got ${value}`);
    }
  }
  const out: number[] = [AID.SF];
  for (const cap of capabilities) {
    // `supported`, NOT `capabilities`: see the parameter's own note. Passing the
    // subset here is the bug that makes a QCODE-List Summary under-report, and
    // it is invisible on the plain-Query path where the two lists are equal.
    const params = cap.params(geometry, supported);
    // Length covers the two length bytes, SFID, QCODE and the parameters.
    const length = 4 + params.length;
    out.push(...u16(length), Sfid.QUERY_REPLY, cap.qcode, ...params);
  }
  return Uint8Array.from(out);
}

/**
 * The Null Query Reply: "we support none of the QCODEs you listed."
 *
 * Five bytes on the wire, four of them the structured field. The unit's own
 * table, p. 6-77 (pages.txt:10768-10771), is fully legible for once:
 *
 *     0-1  L      X'0004'  Length of this structured field
 *     2    SFID   X'81'    Identifies this structured field as a Query Reply
 *     3    QCODE  X'FF'    Identifies this Query Reply as Null
 *
 * so the field is `00 04 81 ff` and buildQueryReply's AID.SF precedes it, giving
 * `88 00 04 81 ff`. Note L=4 with NO parameter bytes, which is why the Null
 * capability's params returns the empty array and why buildQueryReply's
 * `4 + params.length` produces the manual's value without a special case.
 *
 * BUILT THROUGH THE SAME PATH AS EVERY OTHER REPLY, not hand-assembled. x3270
 * does the same — do_qr_null's entire body is a trace line (sf.c:688-692), with
 * the framing supplied by do_query_reply's common `obptr += 2; *obptr++ =
 * SFID_QREPLY; *obptr++ = code` and its length fixup (sf.c:658-684). One framing
 * path means the AID, the SFID and the length arithmetic cannot drift between
 * this reply and the others.
 *
 * The 0xFF is CONTENT and gets IAC-doubled by the telnet layer on its way out,
 * exactly as the 0xFF in x3270's Color unit does. That is sendRecord's job
 * (telnet.ts:82), not ours; a caller comparing these bytes to a wire capture
 * must un-double first.
 */
const nullReply: Capability = {
  qcode: Qcode.NULL,
  // Table 6-1 gives Null "No X'FF' No No" (pages.txt:8612) — it is returned in
  // response to no request type as a matter of SUPPORT. It reaches the wire only
  // by the explicit "nothing matched" path in buildReply, never by enumeration,
  // which is why it is absent from DEFAULT_CAPABILITIES and why this is false.
  returnedForQuery: false,
  params: () => [],
};

export function buildNullQueryReply(geometry: ScreenGeometry): Uint8Array {
  // No `supported` argument: the Null reply carries no Summary, so nothing reads
  // it. The default (equal to the sent list) is inert here.
  return buildQueryReply([nullReply], geometry);
}

/**
 * Choose the units to send for a Query or a Query List, then build the reply.
 *
 * THE ONE ENTRY POINT the session should use. The three REQTYP versions are
 * p. 6-20's table (pages.txt:8526-8560) and x3270's dispatch is sf.c:244-305.
 *
 * WHY SUMMARY IS FORCED IN, and where we knowingly differ from x3270. p. 6-96 is
 * unconditional: "The Summary Query Reply must always be sent inbound in reply
 * to a Read Partition / structured field specifying Query, or Query List (QCODE
 * List=X'80', / Equivalent, or All)." (pages.txt:11409-11411.) x3270 does NOT
 * honour that for a QCODE List — its filter is a plain membership test,
 * sf.c:268-272:
 *
 *     for (i = 0; i < NSR; i++) {
 *         if (memchr(&buf[6], (char)replies[i].code, buflen-6) && ...) {
 *             do_query_reply(replies[i].code);
 *
 * so a list naming only 0x81 gets 0x81 alone and no Summary. We follow the
 * MANUAL here rather than x3270, for the reason p. 6-20 gives: Summary is "the
 * only / indication of support of functions where the associated Query Reply is
 * returned in / reply to a Query List = QCODE List or All"
 * (pages.txt:8574-8576) — omit it and a host has no way to discover what else to
 * ask for. It is also strictly safer: an extra Summary is a unit the host asked
 * about implicitly and can ignore, whereas a missing one removes information.
 *
 * This does mean a QCODE-List reply can carry a unit that was not listed. That
 * is intended and is not a duplicate-reply violation; the no-duplicates rule
 * (pages.txt:8542-8544) is about sending the SAME QCODE twice, which the
 * de-duplication below prevents.
 *
 * A note on what "matching" means for the QCODE list: p. 5-52 says "All QCODE
 * values in the list are valid. Those QCODEs not supported are / ignored."
 * (pages.txt:6395-6396) — an unsupported QCODE is skipped, never an error. So
 * there is no validation of the host's list, only intersection.
 */
export function selectCapabilities(
  request: QueryRequest,
  capabilities: readonly Capability[],
): readonly Capability[] {
  // Query and Equivalent are the same selection, and expressing it once is the
  // point. p. 6-20 defines Equivalent as "Requests the 3270 device or
  // workstation to return / the same Query Replies that would be returned in
  // reply to a Query" (pages.txt:8545-8547), so the two share this filter by
  // DERIVATION rather than by coincidence.
  //
  // FILTERED ON returnedForQuery, not "return everything". Today every entry is
  // true, so this is an identity map and Equivalent equals All — a fact about
  // our current three units, NOT a property of the protocol. Writing the filter
  // now is what stops a later "No" capability (Begin/End of File, say) from
  // silently leaking into an Equivalent reply. Deleting it because it looks like
  // a no-op would reintroduce exactly that bug.
  const queryEquivalent = (): readonly Capability[] =>
    capabilities.filter((c) => c.returnedForQuery);

  if (request.kind === 'query') return queryEquivalent();

  switch (request.reqtyp) {
    case ReqTyp.ALL:
      // "Requests the 3270 data stream device or / workstation to return all the
      // Query Replies / supported. The Query List = All can contain a / QCODE
      // list. However, the QCODE list is ignored" (pages.txt:8553-8557). Hence
      // `capabilities` unfiltered and request.qcodes untouched — the list is not
      // consulted, not even to intersect. p. 5-52 puts it as "the All flag
      // overrides the list" (pages.txt:6388-6389).
      //
      // Unfiltered means All is the one path that may include a unit a Query
      // would not, which is Table 6-1's whole third column.
      return capabilities;

    case ReqTyp.EQUIVALENT: {
      // "Optionally, a list of QCODES / can also be included." (pages.txt:8546-
      // 8547.) Since every unit we have is Query-returnable, that list can add
      // nothing today — the union below is already the whole capability list.
      // It is written as a union anyway so the semantics stay right when a
      // non-Query-returnable capability arrives: p. 5-52 says Equivalent sends
      // the Query set "in addition to / those QCODEs (if any) that are specified
      // in the QCODE list" (pages.txt:6381-6382).
      //
      // Order is preserved from `capabilities`, not from the host's list, so
      // Summary stays first as it does on every other path. The manual permits
      // any order — "There is no requirement as to the order of the QCODES ...
      // or the order that the requested Query Replies are / returned"
      // (pages.txt:8534-8539) — but consistency keeps the tests and traces
      // comparable across request types.
      const listed = new Set(request.qcodes);
      return capabilities.filter((c) => c.returnedForQuery || listed.has(c.qcode));
    }

    case ReqTyp.QCODE_LIST: {
      // "Contains a list of one or more Query Reply / QCODES. The 3270 data
      // stream device or / workstation returns all the requested Query / Replies
      // (QCODES listed) that are supported. If / none of the requested Query
      // Replies are / supported, a Null Query Reply is returned."
      // (pages.txt:8529-8534.)
      //
      // AN EMPTY LIST IS THE NULL CASE, and it arrives here rather than being
      // rejected. p. 5-52 is explicit: "If the value / is B'00' but no list is
      // present (count field is valid), a Null Query Reply is / returned."
      // (pages.txt:6377-6379.) x3270 short-circuits it before even looking,
      // sf.c:258-262:
      //
      //     if (buflen < 7) {
      //         trace_ds(")\n");
      //         do_query_reply(QR_NULL);
      //
      // where buflen < 7 means "no byte 6", i.e. an absent list. We need no
      // special case for it: an empty `listed` matches nothing, `chosen` comes
      // back empty, and the empty check below yields the Null reply. Same
      // output, one path.
      //
      // The Set also delivers the no-duplicates rule for free: a list naming
      // 0x81 three times still yields one unit, because we iterate
      // `capabilities` and test membership rather than iterating the host's list.
      // That is x3270's structure too (its memchr runs per reply, not per listed
      // QCODE) and it is the reason duplicates need no explicit handling.
      const listed = new Set(request.qcodes);
      const chosen = capabilities.filter((c) => listed.has(c.qcode));
      // Nothing matched: the Null Query Reply, and NOT a lone Summary. The
      // always-send-Summary rule from p. 6-96 does not rescue this case, because
      // the Null unit's OWN section, p. 6-77, has a worked example that forbids
      // it — for a device supporting A, B, C asked for X, Y, Z, "The device
      // sends the Null Query Reply because the device does not support any / of
      // the requested features." (pages.txt:10761-10762). A reply of Summary
      // alone would say "supported nothing you asked for" too, but by a form no
      // host is required to read that way. Emit nothing else alongside it
      // either: the unit's whole purpose is to be a bare four-byte negative.
      if (chosen.length === 0) return [nullReply];
      // RETURN EXACTLY WHAT WAS ASKED FOR. No forced Summary.
      //
      // An earlier version of this function prepended Summary unconditionally,
      // reading p. 6-96's "The Summary Query Reply must always be sent inbound in
      // reply to a Read / Partition structured field specifying Query, or Query
      // List (QCODE List=X'80', / Equivalent, or All)" (pages.txt:11409-11411) as
      // "always, whatever the list says". **That reading was wrong.**
      //
      // `X'80'` there is SUMMARY'S OWN QCODE, not a REQTYP value, so the sentence
      // means "when the QCODE list names 0x80". The manual uses the identical
      // boilerplate for every unit with that unit's code substituted — the Null
      // reply says `QCODE List=X'FF'` (pages.txt:10745-10746) and Begin/End of
      // File says `QCODE List=X'9F'` (pages.txt:8801-8802). Reading 0x80 as a
      // request type would force those to mean something incoherent.
      //
      // The tell was internal: the `chosen.length === 0` branch above already
      // reads `X'FF'` correctly as a QCODE, and this branch then read `X'80'` the
      // other way, thirty lines apart in the same function.
      //
      // x3270 gets this right and we now match it: its QCODE-List arm emits only
      // codes found in the host's list, `if (memchr(&buf[6], replies[i].code,
      // buflen-6))`, then the Null reply if none matched (Common/sf.c:268-277).
      // Forcing Summary in would send a unit the host did not ask for.
      return chosen;
    }

    default:
      // B'11' is "Reserved" (pages.txt:6361). x3270 rejects an unknown request
      // type with PDS_BAD_CMD (sf.c:301-303), which is a program check, so the
      // caller raises one rather than inventing a reply. Returning an empty
      // array instead would put a bare AID on the wire, which is not a legal
      // record.
      throw new RangeError(
        `unsupported Query List REQTYP 0x${request.reqtyp.toString(16).padStart(2, '0')}`,
      );
  }
}

/**
 * Build the reply to a Query or Query List in one step.
 *
 * The session calls this and nothing else. Keeping selection and building
 * behind one function means the Null case cannot be reached with a stray AID and
 * no units, and that Summary's "must always be sent" rule has exactly one
 * enforcement point.
 */
export function buildReply(
  request: QueryRequest,
  capabilities: readonly Capability[],
  geometry: ScreenGeometry,
): Uint8Array {
  // The third argument is what keeps Summary honest: the first is the subset
  // being SENT, the third is everything SUPPORTED. They differ for exactly the
  // QCODE-List case, and conflating them was a real defect this function's tests
  // caught. See buildQueryReply's `supported` parameter.
  return buildQueryReply(
    selectCapabilities(request, capabilities), geometry, capabilities);
}
