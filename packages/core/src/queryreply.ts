import { AID, Qcode, Sfid } from './constants.js';

/**
 * Query Reply, the answer to a host's Read Partition (Query).
 *
 * Built from a CAPABILITY LIST rather than a hardcoded byte blob, so
 * advertising something later is one list entry and the Summary unit cannot
 * disagree with what is actually sent.
 *
 * Stage 2a advertises the minimal honest set: Summary, Usable Area, Implicit
 * Partition. x3270 sends ten, including Color and Highlighting — which would
 * invite the SA orders stage 2a deliberately does not implement. Every unit
 * here is one we honour. See the stage 2a design doc.
 */

export interface Geometry {
  rows: number;
  cols: number;
}

export interface Capability {
  qcode: number;
  /** Unit body AFTER `L L SFID QCODE` — the builder writes that prefix. */
  params: (geometry: Geometry, all: readonly Capability[]) => number[];
}

/** Big-endian 16-bit. */
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

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
 */
const summary: Capability = {
  qcode: Qcode.SUMMARY,
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
    ...u16(geometry.cols), // 6-7  W: width of usable area, in cells
    ...u16(geometry.rows), // 8-9  H: height of usable area, in cells
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
    ...u16(geometry.rows * geometry.cols),
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
  params: (geometry) => [
    0x00, 0x00,   // base bytes 4-5 FLAGS: reserved, X'0000'
    0x0b,         // SDP L: length of this self-defining parameter
    0x01,         // SDP SDPID: Implicit Partition Sizes for Display Devices
    0x00,         // SDP FLAGS: reserved
    ...u16(geometry.cols), ...u16(geometry.rows), // WD HD — default
    ...u16(geometry.cols), ...u16(geometry.rows), // WA HA — alternate == default
  ],
};

/** What stage 2a advertises. Adding a unit is one entry here. */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  summary, usableArea, implicitPartition,
];

/**
 * The complete inbound record: AID 0x88 then each unit, length-prefixed.
 *
 * One AID for the whole set, not one per unit: "If the structured field is one
 * of a set of Query Reply structured fields, only the first is preceded by an
 * AID of X'88'." (pages.txt:8648-8649, p. 6-22.)
 *
 * Returns pure 3270 data. IAC doubling is the telnet layer's job (telnet.ts:82,
 * in sendRecord), which matters here because 0xFF appears in real reply content
 * — see the Color unit in the x3270 fixture.
 */
export function buildQueryReply(
  capabilities: readonly Capability[],
  geometry: Geometry,
): Uint8Array {
  const out: number[] = [AID.SF];
  for (const cap of capabilities) {
    const params = cap.params(geometry, capabilities);
    // Length covers the two length bytes, SFID, QCODE and the parameters.
    const length = 4 + params.length;
    out.push(...u16(length), Sfid.QUERY_REPLY, cap.qcode, ...params);
  }
  return Uint8Array.from(out);
}
