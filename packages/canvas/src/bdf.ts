/**
 * Parse a BDF bitmap font into fixed-size glyph bitmaps.
 *
 * WHY A PARSER RATHER THAN A FONT FILE. x3270's `3270.bdf` IS the authentic 3278/3279
 * face, and its glyphs are indexed in EBCDIC CG order -- so our cells, which already hold
 * EBCDIC, need no translation, and APL comes free where a Unicode monospace font would
 * have none. It is also what makes rendering deterministic: bitmaps at integer scale have
 * no hinting and no subpixel antialiasing to vary between machines, which is what lets
 * screenshot goldens be trusted.
 *
 * EVERY GLYPH IS NORMALISED TO THE FONT BOUNDING BOX, padded from its own BBX offsets.
 * The atlas is then a plain grid and the blitter needs no per-glyph metrics. A BDF glyph
 * may be smaller than the box and offset within it; ignoring that shifts characters by a
 * pixel or two, which reads as a subtly wrong font rather than as a bug.
 *
 * This font measures 9x14 with `FONTBOUNDINGBOX 9 14 0 -3` and declares `CHARS 431`.
 */
export interface Glyph {
  /** `height` rows of `width` bits, 1 = ink. Row 0 is the top. */
  readonly rows: readonly Uint8Array[];
}

export interface BdfFont {
  readonly width: number;
  readonly height: number;
  /** By ENCODING, which for page 0 of this font is the EBCDIC code point. */
  readonly glyphs: ReadonlyMap<number, Glyph>;
}

export function parseBdf(text: string): BdfFont {
  const box = /^FONTBOUNDINGBOX (-?\d+) (-?\d+) (-?\d+) (-?\d+)$/m.exec(text);
  if (box === null) throw new Error('BDF has no FONTBOUNDINGBOX');
  const width = Number(box[1]);
  const height = Number(box[2]);
  const boxX = Number(box[3]);
  const boxY = Number(box[4]);

  const glyphs = new Map<number, Glyph>();
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (!lines[i]!.startsWith('STARTCHAR')) { i++; continue; }

    let encoding: number | undefined;
    let bbx: [number, number, number, number] | undefined;
    const hex: string[] = [];
    let inBitmap = false;

    for (i++; i < lines.length && !lines[i]!.startsWith('ENDCHAR'); i++) {
      const line = lines[i]!.trim();
      if (line.startsWith('ENCODING')) { encoding = Number(line.split(/\s+/)[1]); continue; }
      if (line.startsWith('BBX')) {
        const p = line.split(/\s+/).slice(1).map(Number);
        bbx = [p[0]!, p[1]!, p[2]!, p[3]!];
        continue;
      }
      if (line === 'BITMAP') { inBitmap = true; continue; }
      if (inBitmap && line !== '') hex.push(line);
    }

    // A glyph with no ENCODING is not addressable, and -1 is BDF's "unencoded".
    if (encoding !== undefined && encoding >= 0 && bbx !== undefined) {
      glyphs.set(encoding, normalise(hex, bbx, width, height, boxX, boxY));
    }
  }
  if (glyphs.size === 0) throw new Error('BDF contained no encoded glyphs');
  return { width, height, glyphs };
}

/**
 * Place a glyph's own bounding box inside the font's, padding with zeroes.
 *
 * BDF y-offsets are measured UP from the baseline while bitmap rows run DOWN from the
 * top, so the vertical placement is a subtraction, not an addition. Getting that
 * backwards flips glyphs about the baseline and looks like a font bug rather than an
 * arithmetic one.
 *
 * Each BITMAP row is padded to a whole number of BYTES, so the significant bits sit at
 * the TOP of that padded width -- for a 9-pixel-wide glyph the row is 16 bits and pixel 0
 * is bit 15, not bit 8.
 */
function normalise(
  hex: readonly string[],
  [gw, gh, gx, gy]: [number, number, number, number],
  width: number, height: number, boxX: number, boxY: number,
): Glyph {
  const rows: Uint8Array[] = Array.from({ length: height }, () => new Uint8Array(width));
  const top = (height + boxY) - (gy + gh);
  const left = gx - boxX;
  const padded = Math.ceil(gw / 8) * 8;

  for (let r = 0; r < gh && r < hex.length; r++) {
    const bits = BigInt(`0x${hex[r] ?? '0'}`);
    const y = top + r;
    if (y < 0 || y >= height) continue;
    for (let c = 0; c < gw; c++) {
      const x = left + c;
      if (x < 0 || x >= width) continue;
      if (((bits >> BigInt(padded - 1 - c)) & 1n) === 1n) rows[y]![x] = 1;
    }
  }
  return { rows };
}
