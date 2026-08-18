import { AID, Order, isShortReadAID, ADDRESS_CODE_TABLE } from './constants.js';
import { encodeAddress } from './address.js';
import type { Screen } from './screen.js';

/**
 * Build the inbound (terminal to host) byte stream.
 *
 * IAC doubling is NOT done here — that is the telnet layer's job, so these
 * functions produce pure 3270 data and stay easy to test.
 */

/**
 * Read Modified / Read Modified All.
 *
 * GA23-0059-07: a short read transfers "only an AID byte". x3270 confirms:
 * ctlr_read_modified writes the AID and jumps to rm_done for PA1-3 and Clear
 * when `all` is false. Read Modified All suppresses the short read, and
 * Selector Pen sends the cursor but no field data.
 */
export function buildReadModified(screen: Screen, aid: number, all: boolean): Uint8Array {
  const out: number[] = [aid];

  if (!all && isShortReadAID(aid)) {
    return Uint8Array.from(out); // AID alone
  }

  out.push(...encodeAddress(screen.cursor, screen.size));

  // Selector Pen reports position only.
  const sendData = all || aid !== AID.SELECT;
  if (!sendData) return Uint8Array.from(out);

  // UNFORMATTED SCREEN: there are no fields to iterate, so walk the whole buffer
  // and send every non-null character, with no SBA orders at all. x3270 does
  // exactly this in ctlr_read_modified's `else` branch (ctlr.c:997-1057): it
  // loops from address 0 emitting `ea_buf[baddr].ec` wherever that is nonzero.
  //
  // This is not a corner case. VM/370's logon screen is unformatted — verified
  // against a live VM/CE 1.2 host, which sends its logo with zero field
  // attributes — so without this branch everything the operator types before the
  // first formatted panel is silently dropped and LOGON never reaches CP.
  if (!screen.isFormatted()) {
    for (let a = 0; a < screen.size; a++) {
      const ebcdic = screen.cellAt(a).ebcdic;
      if (ebcdic !== 0x00) out.push(ebcdic);
    }
    return Uint8Array.from(out);
  }

  for (const field of screen.fields()) {
    if (!all && !field.modified) continue;

    const data: number[] = [];
    let a = field.start;
    for (let n = 0; n < field.length; n++) {
      data.push(screen.cellAt(a).ebcdic);
      a = screen.inc(a);
    }
    // Trailing nulls are not transmitted; embedded ones are.
    while (data.length > 0 && data[data.length - 1] === 0x00) data.pop();

    // A modified field ALWAYS gets its SBA, even with no content left after
    // trimming. x3270 writes the SBA the moment it finds a modified field, before
    // examining any content (ctlr.c:822-829): `if (FA_IS_MODIFIED(...)) { ...
    // *obptr++ = ORDER_SBA; ENCODE_BADDR(obptr, baddr); ...`.
    //
    // Verified by byte-comparison against real x3270 driving the same VM/370 host
    // through an identical script: pressing Enter on a modified empty field, it
    // sent `7d 5b 60 11 5b 60` (AID, cursor, SBA(1760)) where we sent
    // `7d 5b 60` and omitted the SBA. The SBA tells the host WHICH field the
    // operator cleared, which is information the host cannot otherwise recover.
    out.push(Order.SBA, ...encodeAddress(field.start, screen.size), ...data);
  }

  return Uint8Array.from(out);
}

/**
 * Encode a field attribute for transmission inbound.
 *
 * The attribute goes out through the same 64-entry code table as a 12-bit
 * address, after masking off the two "printable" high bits. x3270 does exactly
 * this in both places it sends an attribute inbound:
 *   ctlr.c:1112-1114  `fa = ea_buf[baddr].fa & ~FA_PRINTABLE; ... code_table[fa]`
 *   ctlr.c:1248       `code_table[ea_buf[baddr].fa & ~FA_PRINTABLE]`
 *
 * So a protected field is 0x60 on the wire, not 0x20. FA_PRINTABLE is 0xC0 and
 * the defined bits (protect, numeric, intensity, MDT) all fall inside 0x3D, so
 * masking with 0x3F is equivalent to x3270's `& ~FA_PRINTABLE` for every
 * attribute a host can send, and keeps the index inside the 64-entry table.
 */
export function encodeAttribute(attr: number): number {
  const encoded = ADDRESS_CODE_TABLE[attr & 0x3f];
  if (encoded === undefined) throw new Error(`unencodable attribute 0x${attr.toString(16)}`);
  return encoded;
}

/**
 * Read Buffer: the entire buffer, with each field attribute rendered as an SF
 * order followed by the attribute value, and every other position as its
 * character byte.
 */
export function buildReadBuffer(screen: Screen, aid: number): Uint8Array {
  const out: number[] = [aid, ...encodeAddress(screen.cursor, screen.size)];
  for (let a = 0; a < screen.size; a++) {
    const attr = screen.attributeAt(a);
    if (attr !== null) {
      out.push(Order.SF, encodeAttribute(attr));
    } else {
      out.push(screen.cellAt(a).ebcdic);
    }
  }
  return Uint8Array.from(out);
}
