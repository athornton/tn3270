/**
 * Bake 3270.bdf into a glyph atlas: one row of cells, indexed by CG code.
 *
 * GENERATED, NEVER COMMITTED. A committed binary derived from a committed source is two
 * things to keep in step, and this project has been bitten by a second copy of a rule
 * before -- `splitTarget` beside `hostspec.ts`. `npm run build` regenerates it, and
 * `dist/` is gitignored.
 *
 * ALPHA-ONLY OUTPUT: the atlas stores COVERAGE, and colour is applied per cell at blit
 * time from the resolved 3279 palette. Baking colour in would need one atlas per colour,
 * and a 3279 has sixteen.
 *
 * INDEXED BY CG CODE, NOT EBCDIC. The font is in Character Generator order -- see
 * `src/cg.ts` for the map and why the design's original claim was wrong. Encodings run
 * 0..543 and are sparse (431 glyphs, 175 of them above 255), because pages 1 and 2 hold
 * APL and DEC line-drawing. So the index is a code->column MAP rather than the code being
 * the column: a 544-wide dense atlas would waste a fifth of itself on holes, and more to
 * the point a missing code must be a lookup MISS rather than silently sampling whatever
 * glyph happens to sit at that column.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBdf } from '../dist/bdf.js';

const here = dirname(fileURLToPath(import.meta.url));
const font = parseBdf(readFileSync(join(here, '..', 'assets', '3270.bdf'), 'utf8'));

const codes = [...font.glyphs.keys()].sort((a, b) => a - b);
const index = {};
codes.forEach((code, i) => { index[code] = i; });

const cols = codes.length;
const stride = cols * font.width;
const atlas = new Uint8Array(stride * font.height);
codes.forEach((code, i) => {
  const g = font.glyphs.get(code);
  for (let y = 0; y < font.height; y++) {
    const row = g.rows[y];
    const base = y * stride + i * font.width;
    for (let x = 0; x < font.width; x++) atlas[base + x] = row[x] ? 255 : 0;
  }
});

mkdirSync(join(here, '..', 'dist'), { recursive: true });
writeFileSync(join(here, '..', 'dist', 'atlas.bin'), atlas);
writeFileSync(join(here, '..', 'dist', 'atlas.json'), JSON.stringify({
  cellWidth: font.width, cellHeight: font.height, cols, index,
}));
console.log(
  `atlas: ${cols} glyphs, ${font.width}x${font.height} cells, ${atlas.length} bytes`);
