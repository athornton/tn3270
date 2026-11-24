import { CP037_TO_UNICODE } from './codepages/cp037.js';
import { BRACKET_TO_UNICODE } from './codepages/bracket.js';

/** EBCDIC substitute character — used for anything we cannot map. */
const EBCDIC_SUB = 0x3f;

/**
 * A single-byte EBCDIC code page. Table-driven so that CP285, CP297, CP500 and
 * friends are data files rather than code changes.
 */
export class CodePage {
  readonly name: string;
  /**
   * The page's CGCSGID, as x3270's table entry declares it (both cp037 and bracket say 37). Its
   * low 16 bits are what NEW-ENVIRON's CODEPAGE reports (`telnet_new_environ.c:255-260`).
   */
  readonly cgcsgid: number;
  private readonly toUni: readonly number[];
  private readonly fromUni: Map<number, number>;

  constructor(name: string, toUnicodeTable: readonly number[], cgcsgid: number) {
    if (!Number.isInteger(cgcsgid) || cgcsgid < 0 || cgcsgid > 0xffffffff) {
      throw new Error(`code page ${name}: cgcsgid is not a 32-bit unsigned integer: ${cgcsgid}`);
    }
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
    this.cgcsgid = cgcsgid;
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

export const cp037 = new CodePage('cp037', CP037_TO_UNICODE, 37);

/** x3270's default (`Common/codepage.c:358`). CGCSGID 37, as x3270's table entry declares. */
export const bracket = new CodePage('bracket', BRACKET_TO_UNICODE, 37);

/** The page a session uses when none is chosen: x3270's default. */
export const DEFAULT_CODE_PAGE = bracket;

/** Registry, so a session can select a page by name. */
export const CODE_PAGES = new Map<string, CodePage>([['bracket', bracket], ['cp037', cp037]]);

/** Canonical names, default first: what `-codepage` accepts besides the aliases. */
export const CODE_PAGE_NAMES: readonly string[] = [...CODE_PAGES.keys()];

/** x3270's aliases for these two pages (`Common/unicode.c:381-422`). */
const ALIASES = new Map<string, string>([
  ['cp37', 'cp037'], ['us', 'cp037'], ['us-intl', 'cp037'],
  ['oldibm', 'bracket'], ['bracket437', 'bracket'],
]);

/** A page by canonical name or x3270 alias, ignoring case. Throws, remedy first, if unknown. */
export function resolveCodePage(name: string): CodePage {
  // All digits gets a 'cp' prefix first, so '037' -> 'cp037' and '37' -> 'cp37' -> alias
  // (x3270 canonical_codepage, Common/unicode.c:791-793; set_uni :685-687). Case is ignored
  // as set_uni's strcasecmp ignores it (:691, :702).
  const lower = name.toLowerCase();
  const key = /^[0-9]+$/.test(lower) ? `cp${lower}` : lower;
  const cp = CODE_PAGES.get(ALIASES.get(key) ?? key);
  if (!cp) throw new Error(`use one of ${CODE_PAGE_NAMES.join(', ')} (got '${name}')`);
  return cp;
}
