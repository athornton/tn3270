import { CP037_TO_UNICODE } from './codepages/cp037.js';

/** EBCDIC substitute character — used for anything we cannot map. */
const EBCDIC_SUB = 0x3f;

/**
 * A single-byte EBCDIC code page. Table-driven so that CP285, CP297, CP500 and
 * friends are data files rather than code changes.
 */
export class CodePage {
  readonly name: string;
  private readonly toUni: readonly number[];
  private readonly fromUni: Map<number, number>;

  constructor(name: string, toUnicodeTable: readonly number[]) {
    if (toUnicodeTable.length !== 256) {
      throw new Error(`code page ${name}: table must have 256 entries, got ${toUnicodeTable.length}`);
    }
    for (let b = 0; b < 256; b++) {
      const cp = toUnicodeTable[b]!;
      if (!Number.isInteger(cp) || cp < 0 || cp > 0x10ffff) {
        throw new Error(
          `code page ${name}: entry for byte 0x${b.toString(16).padStart(2, '0')} is not a valid code point: ${cp}`,
        );
      }
    }
    this.name = name;
    this.toUni = toUnicodeTable;
    this.fromUni = new Map();
    // Iterate high to low so the lowest EBCDIC byte is written last and
    // therefore wins, for any Unicode char with more than one representation.
    // Deterministic.
    for (let b = 255; b >= 0; b--) {
      this.fromUni.set(toUnicodeTable[b]!, b);
    }
  }

  /** EBCDIC byte to a single-character string. */
  toUnicode(byte: number): string {
    const cp = this.toUni[byte & 0xff];
    return String.fromCodePoint(cp!);
  }

  /** A single character to its EBCDIC byte, or the substitute if unmappable. */
  fromUnicode(char: string): number {
    const cp = char.codePointAt(0);
    if (cp === undefined) return EBCDIC_SUB;
    return this.fromUni.get(cp) ?? EBCDIC_SUB;
  }

  decode(bytes: Uint8Array): string {
    let out = '';
    for (const b of bytes) out += this.toUnicode(b);
    return out;
  }

  encode(text: string): Uint8Array {
    // Normalize to NFC first: decomposed input (e.g. macOS keyboard/paste
    // delivering 'e' + combining acute instead of precomposed 'e-acute')
    // would otherwise expand to two cells for one visible character and
    // shift every following column.
    const chars = Array.from(text.normalize('NFC'));
    const out = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) out[i] = this.fromUnicode(chars[i]!);
    return out;
  }
}

export const cp037 = new CodePage('cp037', CP037_TO_UNICODE);

/** Registry, so a session can select a page by name. */
export const CODE_PAGES = new Map<string, CodePage>([['cp037', cp037]]);

export function getCodePage(name: string): CodePage {
  const cp = CODE_PAGES.get(name);
  if (!cp) throw new Error(`unknown code page: ${name}`);
  return cp;
}
