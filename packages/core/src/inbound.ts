import { AID, Order, isShortReadAID } from './constants.js';
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
    if (!all && data.length === 0) continue;

    out.push(Order.SBA, ...encodeAddress(field.start, screen.size), ...data);
  }

  return Uint8Array.from(out);
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
      out.push(Order.SF, attr);
    } else {
      out.push(screen.cellAt(a).ebcdic);
    }
  }
  return Uint8Array.from(out);
}
