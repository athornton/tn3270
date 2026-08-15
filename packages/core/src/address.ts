import { ADDRESS_CODE_TABLE } from './constants.js';

/**
 * Thrown when a datastream contains an address we must refuse — currently only
 * the reserved 10 flag combination. Callers turn this into a program check.
 */
export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AddressError';
  }
}

/**
 * Decode a two-byte buffer address.
 *
 * GA23-0059-07: the top two bits of the first byte are flags.
 *   00 -> 14-bit binary address in the remaining 14 bits
 *   01 -> 12-bit coded address (low 6 bits of each byte)
 *   10 -> reserved; receipt rejects the datastream
 *   11 -> 12-bit coded address, same as 01
 */
export function decodeAddress(b1: number, b2: number): number {
  const flags = (b1 & 0xc0) >> 6;
  switch (flags) {
    case 0b00:
      return ((b1 & 0x3f) << 8) | (b2 & 0xff);
    case 0b10:
      throw new AddressError(
        `reserved address flag bits 10 in byte 0x${b1.toString(16).padStart(2, '0')}`,
      );
    default:
      // 01 and 11 are both 12-bit coded form.
      return ((b1 & 0x3f) << 6) | (b2 & 0x3f);
  }
}

/**
 * Encode a buffer address for output.
 *
 * Screens of 4096 cells or fewer use 12-bit coded form; larger ones use 14-bit
 * binary. x3270's ENCODE_BADDR switches on `(ROWS * COLS) > 0x1000`.
 */
export function encodeAddress(addr: number, bufferSize: number): Uint8Array {
  const use14Bit = bufferSize > 0x1000;
  const limit = use14Bit ? 0x4000 : 0x1000;
  if (!Number.isInteger(addr) || addr < 0 || addr >= limit) {
    throw new AddressError(`address ${addr} out of range for ${limit}-cell encoding`);
  }
  if (use14Bit) {
    return Uint8Array.of((addr >> 8) & 0x3f, addr & 0xff);
  }
  const hi = ADDRESS_CODE_TABLE[(addr >> 6) & 0x3f]!;
  const lo = ADDRESS_CODE_TABLE[addr & 0x3f]!;
  return Uint8Array.of(hi, lo);
}
