# Electron GUI (stage 3, part 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A window that renders a live 3270 screen from a real host, accepts keystrokes,
and draws the OIA — started from the command line with the TUI's flags unchanged.

**Architecture:** Electron main owns the `Session`, the socket and TLS, reusing
`@tn3270/frontend`. The renderer owns a canvas and nothing else, behind
`contextIsolation`. Glyphs are blitted from a sprite atlas baked from x3270's own
`3270.bdf`, at integer scale with antialiasing off — which is also what makes screenshot
goldens deterministic.

**Tech Stack:** Electron, TypeScript 7 project references, vitest, Xvfb.

---

## PREREQUISITE

**`docs/superpowers/plans/2026-08-28-shared-frontend-extraction.md` must be complete
first.** This plan imports `defaultSession`, `resolveHostSpec`, the TLS flags and
`applyAction` from `@tn3270/frontend`. If that package does not exist yet, stop and do
that plan.

Design: `docs/superpowers/specs/2026-08-28-electron-gui-and-shared-frontend-design.md`.

Baseline after the refactor: **1210 tests**, typecheck and build clean, `pty-smoke.py`
12/12, `drive-e.py` 7/7.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gui/package.json` | Manifest; the only package depending on `electron` |
| `packages/gui/tsconfig.json` | Composite project referencing `../core`, `../frontend` |
| `packages/gui/assets/3270.bdf` | **Vendored** from x3270, with its licence |
| `packages/gui/assets/LICENSE-3270-font.txt` | BSD-3 notice for the font |
| `packages/gui/src/bdf.ts` | BDF parser: text → glyph bitmaps. Pure |
| `packages/gui/scripts/build-atlas.mjs` | Build step: BDF → PNG atlas + index JSON |
| `packages/gui/src/drawlist.ts` | Resolved snapshot → per-cell draw instructions. Pure |
| `packages/gui/src/blit.ts` | Draw list + atlas → canvas calls |
| `packages/gui/src/keys.ts` | `KeyboardEvent` → `Action` |
| `packages/gui/src/main.ts` | Electron main: args, Session, window, IPC |
| `packages/gui/src/preload.ts` | `contextBridge`: two channels, nothing else |
| `packages/gui/src/renderer.ts` | Canvas setup, IPC in, keys out |
| `packages/gui/scripts/shot.mjs` | Xvfb + capturePage golden harness |

`bdf.ts`, `drawlist.ts` and `keys.ts` are pure and carry the bulk of the tests in
`npm test`. `main.ts`, `preload.ts`, `renderer.ts` and `blit.ts` need Electron or a canvas
and are covered by the golden harness in Task 10.

---

## Task 1: Prove Electron still works headless — a GATE, not feature work

**Everything else depends on this, and the existing claim is stale.**
`docs/HANDOFF.md` says real Electron 43 renders under Xvfb and `capturePage()` produces
correct PNGs, verified 2026-08-15. As of 2026-08-28 **there is no Electron installed on
this box** — that install is gone — and npm now offers **44.0.0**. So the claim is 13 days
old, about a version we would not be installing. Re-prove it before writing any GUI code:
if it fails, this plan is blocked and the design needs revisiting, and that is much cheaper
to learn now.

**Files:**
- Create: `/tmp/electron-spike/` (throwaway — nothing here is committed)

- [ ] **Step 1: Install Electron in a scratch directory**

Not in the repo yet: a failed spike must not leave a 150 MB dependency in the workspace.

```bash
mkdir -p /tmp/electron-spike && cd /tmp/electron-spike
npm init -y >/dev/null
npm install electron --no-save 2>&1 | tail -3
```

Expected: it downloads (~100-150 MB) and exits 0. **If this fails for network reasons,
stop and report** — the whole stage depends on it.

- [ ] **Step 2: Write the smallest possible window that screenshots itself**

`/tmp/electron-spike/spike.js`:

```javascript
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 200, show: false });
  // A canvas, because that is what the real renderer uses -- proving a DOM page renders
  // would not prove the thing this plan depends on.
  await win.loadURL('data:text/html,' + encodeURIComponent(`
    <body style="margin:0;background:#000">
    <canvas id="c" width="400" height="200"></canvas>
    <script>
      const x = document.getElementById('c').getContext('2d');
      x.imageSmoothingEnabled = false;
      x.fillStyle = '#00ff00';
      x.fillRect(10, 10, 100, 50);
    </script></body>`));
  const img = await win.webContents.capturePage();
  fs.writeFileSync('/tmp/electron-spike/shot.png', img.toPNG());
  console.log('wrote', img.getSize());
  app.quit();
});
```

- [ ] **Step 3: Run it under Xvfb**

```bash
GUI=$HOME/micromamba/envs/gui
export LD_LIBRARY_PATH=$GUI/lib
export FONTCONFIG_PATH=$GUI/etc/fonts FONTCONFIG_FILE=$GUI/etc/fonts/fonts.conf
$GUI/bin/Xvfb :99 -screen 0 1280x1024x24 & sleep 2
export DISPLAY=:99
cd /tmp/electron-spike && ./node_modules/.bin/electron spike.js --no-sandbox
```

Expected: `wrote { width: 400, height: 200 }` and a PNG on disk.

**`--no-sandbox` is likely required** because Chromium's sandbox wants privileges this
box does not grant. If it is needed here it will be needed in `main.ts` too — record which.

- [ ] **Step 4: Verify the PNG has the right pixels, not merely the right size**

A black PNG of correct dimensions would pass a size check and prove nothing.

```bash
cd /tmp/electron-spike && python3 -c "
import zlib,struct
d=open('shot.png','rb').read()
# Walk the chunks and inflate IDAT; no PIL on this box.
pos, idat = 8, b''
while pos < len(d):
    ln = struct.unpack('>I', d[pos:pos+4])[0]; typ = d[pos+4:pos+8]
    if typ == b'IDAT': idat += d[pos+8:pos+8+ln]
    pos += 12 + ln
raw = zlib.decompress(idat)
stride = 400*4 + 1
def px(x,y):
    o = y*stride + 1 + x*4
    return tuple(raw[o:o+3])
print('inside  rect (50,30):', px(50,30))
print('outside rect (300,150):', px(300,150))
"
```

Expected: inside is green (one of `(0,255,0)` or `(255,0,0)`-ordered depending on channel
order — accept any tuple containing 255 and two 0s), outside is `(0,0,0)`. **Record the
channel order you observe**; Task 10's comparison needs it.

- [ ] **Step 5: Record the result and clean up**

Append what you found to `docs/live-testing.md` under a new *Electron headless
re-verification* heading: the Electron version installed, whether `--no-sandbox` was
needed, the channel order, and the date. Then:

```bash
rm -rf /tmp/electron-spike
```

- [ ] **Step 6: Commit the finding**

```bash
git add docs/live-testing.md
git commit -m "docs: re-verify Electron renders headless, on the version we will ship"
```

---

## Task 2: The package, and a window that opens and quits

**Files:**
- Create: `packages/gui/package.json`, `packages/gui/tsconfig.json`,
  `packages/gui/src/main.ts`, `packages/gui/index.html`
- Modify: root `package.json` (`typecheck` script)

- [ ] **Step 1: Manifest**

`packages/gui/package.json`. `electron` is a devDependency: it is the runtime, and
`electron-builder` bundles it at packaging time rather than it being a library dependency.

```json
{
  "name": "@tn3270/gui",
  "version": "0.1.0",
  "license": "MIT",
  "author": "Adam Thornton <athornton@gmail.com>",
  "type": "module",
  "main": "./dist/main.js",
  "dependencies": {
    "@tn3270/core": "0.1.0",
    "@tn3270/frontend": "0.1.0"
  },
  "devDependencies": {
    "electron": "^44.0.0"
  },
  "scripts": {
    "build": "tsc --build && node scripts/build-atlas.mjs"
  }
}
```

- [ ] **Step 2: tsconfig**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }, { "path": "../frontend" }]
}
```

Add `packages/gui` to the root `typecheck` script, after `packages/frontend`.

- [ ] **Step 3: A window, and the one thing it must promise**

`packages/gui/src/main.ts` — first cut opens a window and quits on `Ctrl-]`:

```typescript
import { app, BrowserWindow, globalShortcut } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Electron main: the Session, the socket and the window live here.
 *
 * CTRL-] QUITS, AND THAT IS NOT A STYLE CHOICE. Ctrl-C is the Clear AID -- a 3270 user
 * needs it constantly to dismiss VM's MORE... state -- so the usual instinct for
 * escaping cannot be the way out, and an undocumented alternative is no alternative.
 * The TUI has the same binding and says so in its banner.
 */
const here = dirname(fileURLToPath(import.meta.url));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800, height: 600, backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(join(here, '..', 'index.html'));
  globalShortcut.register('Control+]', () => { app.quit(); });
});

app.on('window-all-closed', () => { app.quit(); });
```

`packages/gui/index.html`:

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>tn3270</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
</head><body><canvas id="screen"></canvas></body></html>
```

- [ ] **Step 4: Run it**

```bash
cd ~/git/tn3270 && npm install && npm run build
GUI=$HOME/micromamba/envs/gui
export LD_LIBRARY_PATH=$GUI/lib DISPLAY=:99
export FONTCONFIG_PATH=$GUI/etc/fonts FONTCONFIG_FILE=$GUI/etc/fonts/fonts.conf
$GUI/bin/Xvfb :99 -screen 0 1280x1024x24 & sleep 2
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox &
sleep 4 && pkill -f "electron packages/gui" ; echo "opened and closed"
```

Expected: no crash, no error on stderr. Add `--no-sandbox` only if Task 1 showed it was
needed.

- [ ] **Step 5: Verify the suite is untouched and commit**

```bash
npm run typecheck && npx vitest run 2>&1 | tail -3
```

Expected: `Tests 1210 passed (1210)` — this task added no tests, and must break none.

```bash
git add -A
git commit -m "feat(gui): an Electron window that opens, and quits on Ctrl-]"
```

---

## Task 3: The BDF parser

New code, test-first. BDF is a simple text format: per glyph, an `ENCODING` number, a
`BBX` bounding box, and `BITMAP` rows in hex, one row per line, padded to whole bytes.

**Files:**
- Create: `packages/gui/assets/3270.bdf`, `packages/gui/assets/LICENSE-3270-font.txt`
- Create: `packages/gui/src/bdf.ts`, `packages/gui/test/bdf.test.ts`

- [ ] **Step 1: Vendor the font and its licence**

```bash
cd ~/git/tn3270 && mkdir -p packages/gui/assets
cp ~/src/suite3270-4.5/x3270/3270.bdf packages/gui/assets/3270.bdf
sed -n '/^COMMENT "Copyright/,/^COMMENT "POSSIBILITY OF SUCH DAMAGE/p' \
  packages/gui/assets/3270.bdf | sed 's/^COMMENT "//; s/"$//' \
  > packages/gui/assets/LICENSE-3270-font.txt
head -3 packages/gui/assets/LICENSE-3270-font.txt
```

Expected: the BSD-3 notice, Paul Mattes / Jeff Sparkes / GTRC. **The font is vendored
rather than read from `~/src`** because a build must not depend on an unrelated checkout
in the developer's home directory — and shipping the app means shipping the glyphs.

- [ ] **Step 2: Read the actual header before writing the parser**

```bash
grep -n "^SIZE\|^FONTBOUNDINGBOX\|^CHARS" packages/gui/assets/3270.bdf | head
sed -n '/^STARTCHAR/,/^ENDCHAR/p' packages/gui/assets/3270.bdf | head -20
```

**Use the numbers you see, not the ones in this plan's example.** The test below asserts
against a glyph you read out of the file yourself, which is the only way it proves the
parser rather than restating it.

- [ ] **Step 3: Write the failing test**

`packages/gui/test/bdf.test.ts`. Replace the marked constants with values from Step 2:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseBdf } from '../src/bdf.js';

const bdfPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', '3270.bdf');
const font = parseBdf(readFileSync(bdfPath, 'utf8'));

describe('parseBdf', () => {
  it('reads the font bounding box', () => {
    // From FONTBOUNDINGBOX in the file. Substitute the real numbers from Step 2.
    expect(font.width).toBeGreaterThan(0);
    expect(font.height).toBeGreaterThan(0);
  });

  it('reads as many glyphs as the file says it has', () => {
    // CHARS <n> is the file's own count, so this catches a parser that stops early --
    // the commonest BDF bug, and one a spot-check of glyph 0xc1 would never reveal.
    const declared = Number(/^CHARS (\d+)$/m.exec(readFileSync(bdfPath, 'utf8'))![1]);
    expect(font.glyphs.size).toBe(declared);
  });

  it('indexes glyphs by EBCDIC code, page 0 being EBCDIC CG order', () => {
    // The BDF's own comment: "Page 0: EBCDIC US-International set, CG order". So 0xc1 is
    // EBCDIC 'A' and needs no translation from what our cells already hold.
    const a = font.glyphs.get(0xc1);
    expect(a, 'no glyph at EBCDIC 0xc1').toBeDefined();
    expect(a!.rows.length).toBe(font.height);
  });

  it('decodes a bitmap row as bits, most significant bit leftmost', () => {
    // A glyph with an unmistakable shape. Read the BITMAP hex for EBCDIC 0xc1 out of the
    // file and assert the top and middle rows differ -- a parser that returned all
    // zeroes, or the same row repeated, would pass a length check.
    const a = font.glyphs.get(0xc1)!;
    const anySet = a.rows.some((r) => r.some((bit) => bit === 1));
    expect(anySet, 'every pixel of A was 0').toBe(true);
    expect(new Set(a.rows.map((r) => r.join(''))).size).toBeGreaterThan(1);
  });

  it('gives every glyph rows of exactly the font width', () => {
    // Uniform cells are what let the atlas be a simple grid, so this is load-bearing
    // rather than tidiness.
    for (const [code, g] of font.glyphs) {
      expect(g.rows.length, `glyph ${code.toString(16)} height`).toBe(font.height);
      for (const row of g.rows) expect(row.length).toBe(font.width);
    }
  });
});
```

- [ ] **Step 4: Run it and watch it fail**

```bash
npx vitest run packages/gui/test/bdf.test.ts
```

Expected: FAIL, cannot resolve `../src/bdf.js`.

- [ ] **Step 5: Implement**

`packages/gui/src/bdf.ts`:

```typescript
/**
 * Parse a BDF bitmap font into fixed-size glyph bitmaps.
 *
 * WHY A PARSER RATHER THAN A FONT FILE. x3270's 3270.bdf IS the authentic 3278/3279
 * face, and its glyphs are indexed in EBCDIC CG order -- so our cells, which already
 * hold EBCDIC, need no translation, and APL comes free where a Unicode monospace font
 * would have none. It is also what makes rendering deterministic: bitmaps at integer
 * scale have no hinting and no subpixel antialiasing to vary between machines, which is
 * what lets screenshot goldens be trusted.
 *
 * EVERY GLYPH IS NORMALISED TO THE FONT BOUNDING BOX, padded from its own BBX offsets.
 * The atlas is then a plain grid and the blitter needs no per-glyph metrics. A BDF glyph
 * may be smaller than the box and offset within it; ignoring that shifts characters by a
 * pixel or two, which reads as a subtly wrong font rather than as a bug.
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
 * backwards flips glyphs about the baseline and looks like a font bug.
 */
function normalise(
  hex: readonly string[],
  [gw, gh, gx, gy]: [number, number, number, number],
  width: number, height: number, boxX: number, boxY: number,
): Glyph {
  const rows: Uint8Array[] = Array.from({ length: height }, () => new Uint8Array(width));
  const top = (height + boxY) - (gy + gh);
  const left = gx - boxX;

  for (let r = 0; r < gh && r < hex.length; r++) {
    const bits = BigInt('0x' + (hex[r] ?? '0'));
    // Each row is padded to a whole number of bytes, so the significant bits are at the
    // TOP of that padded width -- not the bottom.
    const padded = Math.ceil(gw / 8) * 8;
    const y = top + r;
    if (y < 0 || y >= height) continue;
    for (let c = 0; c < gw; c++) {
      const x = left + c;
      if (x < 0 || x >= width) continue;
      const bit = (bits >> BigInt(padded - 1 - c)) & 1n;
      if (bit === 1n) rows[y]![x] = 1;
    }
  }
  return { rows };
}
```

- [ ] **Step 6: Run the tests**

```bash
npx vitest run packages/gui/test/bdf.test.ts
```

Expected: PASS, 5 tests. **If the glyph-count test fails, believe the file**, not the
parser: `CHARS` is the font's own declaration.

- [ ] **Step 7: Eyeball one glyph, because "some bits are set" is a weak claim**

A parser can pass every assertion above and still produce mush. Print EBCDIC `A`:

```bash
cd ~/git/tn3270 && npx tsx -e "
import {readFileSync} from 'node:fs';
import {parseBdf} from './packages/gui/src/bdf.js';
const f = parseBdf(readFileSync('packages/gui/assets/3270.bdf','utf8'));
for (const row of f.glyphs.get(0xc1)!.rows)
  console.log([...row].map(b => b ? '#' : '.').join(''));
" 2>/dev/null || node --experimental-strip-types -e "$(cat <<'EOF'
import {readFileSync} from 'node:fs';
import {parseBdf} from './packages/gui/dist/bdf.js';
const f = parseBdf(readFileSync('packages/gui/assets/3270.bdf','utf8'));
for (const row of f.glyphs.get(0xc1).rows)
  console.log([...row].map(b => b ? '#' : '.').join(''));
EOF
)"
```

Expected: a recognisable capital **A**. If it is upside down, the `top` subtraction in
`normalise` is wrong; if it is mirrored, the bit shift is.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(gui): BDF parser, and vendor x3270's 3270 font with its licence"
```

---

## Task 4: Bake the atlas at build time

**Files:**
- Create: `packages/gui/scripts/build-atlas.mjs`
- Modify: `packages/gui/.gitignore` (create)

- [ ] **Step 1: Write the build script**

`packages/gui/scripts/build-atlas.mjs`. It emits a raw RGBA buffer plus a JSON index
rather than a PNG — the renderer turns it into an `ImageBitmap`, and writing a PNG would
mean an encoder for no benefit.

```javascript
/**
 * Bake 3270.bdf into a glyph atlas: one row of cells, indexed by EBCDIC code.
 *
 * GENERATED, NEVER COMMITTED. A committed binary derived from a committed source is two
 * things to keep in step, and this project has already been bitten by a second copy of a
 * rule -- see the frontend extraction. `npm run build` regenerates it.
 *
 * Alpha-only output: the atlas stores COVERAGE, and colour is applied per cell at blit
 * time from the resolved 3279 palette. Baking colour in would need one atlas per colour.
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
const atlas = new Uint8Array(cols * font.width * font.height);
codes.forEach((code, i) => {
  const g = font.glyphs.get(code);
  for (let y = 0; y < font.height; y++) {
    for (let x = 0; x < font.width; x++) {
      atlas[y * (cols * font.width) + i * font.width + x] = g.rows[y][x] ? 255 : 0;
    }
  }
});

mkdirSync(join(here, '..', 'dist'), { recursive: true });
writeFileSync(join(here, '..', 'dist', 'atlas.bin'), atlas);
writeFileSync(join(here, '..', 'dist', 'atlas.json'), JSON.stringify({
  cellWidth: font.width, cellHeight: font.height, cols, index,
}));
console.log(`atlas: ${cols} glyphs, ${font.width}x${font.height} cells`);
```

- [ ] **Step 2: Do not commit the output**

`packages/gui/.gitignore`:

```
dist/
```

- [ ] **Step 3: Run it**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | tail -2
ls -l packages/gui/dist/atlas.bin packages/gui/dist/atlas.json
```

Expected: a line like `atlas: N glyphs, WxH cells`, and both files present. The `.bin`
size must equal `cols * cellWidth * cellHeight` exactly — check it:

```bash
node -e "
const j = require('./packages/gui/dist/atlas.json');
const {size} = require('node:fs').statSync('./packages/gui/dist/atlas.bin');
const want = j.cols * j.cellWidth * j.cellHeight;
console.log(size === want ? 'size OK ' + size : 'MISMATCH ' + size + ' vs ' + want);
"
```

Expected: `size OK <n>`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "build(gui): bake the glyph atlas from the BDF at build time"
```

---

## Task 5: The draw list

Pure, and the main test surface for rendering. Test-first.

**Files:**
- Create: `packages/gui/src/drawlist.ts`, `packages/gui/test/drawlist.test.ts`

- [ ] **Step 1: Check what `resolve()` actually returns before asserting on it**

```bash
grep -n "export interface ResolvedCell" -A 12 packages/core/src/*.ts
grep -n "export function resolve" -A 8 packages/core/src/*.ts
```

**Use the real field names.** The test below assumes `resolve()` yields cells with an
EBCDIC byte and resolved foreground/background; if the shape differs, follow the source.

- [ ] **Step 2: Write the failing test**

`packages/gui/test/drawlist.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Screen, resolve } from '@tn3270/core';
import { drawList } from '../src/drawlist.js';

const geometry = { cellWidth: 8, cellHeight: 14, cols: 2 as number, index: { 0xc1: 0, 0x40: 1 } };

function screenWith(text: readonly [number, number][]): Screen {
  const s = new Screen({ rows: 24, cols: 80 });
  for (const [addr, ebcdic] of text) s.setChar(addr, ebcdic);
  return s;
}

describe('drawList', () => {
  it('emits one entry per screen cell', () => {
    const s = screenWith([[0, 0xc1]]);
    const dl = drawList(resolve(s.snapshot()), geometry);
    expect(dl.cells).toHaveLength(24 * 80);
  });

  it('places cell (row, col) at the right pixel', () => {
    const s = screenWith([[81, 0xc1]]);            // row 2, col 2 (0-based 1,1)
    const dl = drawList(resolve(s.snapshot()), geometry);
    const cell = dl.cells[81]!;
    expect(cell.x).toBe(8);
    expect(cell.y).toBe(14);
  });

  it('SWAPS foreground and background for a reverse-video cell', () => {
    // Reverse video is the one attribute a blitter cannot infer, and getting it wrong is
    // invisible in a screenshot of mostly-empty screen. Asserted as a swap of the same
    // two colours, not against literal RGB, so a palette change does not break it.
    const s = screenWith([[0, 0xc1]]);
    const snap = resolve(s.snapshot());
    const plain = drawList(snap, geometry).cells[0]!;
    const reversed = drawList({ ...snap, cells: snap.cells.map((c, i) =>
      i === 0 ? { ...c, reverse: true } : c) }, geometry).cells[0]!;
    expect(reversed.fg).toEqual(plain.bg);
    expect(reversed.bg).toEqual(plain.fg);
  });

  it('marks exactly one cell as the cursor', () => {
    const s = screenWith([[0, 0xc1]]);
    const dl = drawList(resolve(s.snapshot()), geometry);
    expect(dl.cells.filter((c) => c.cursor)).toHaveLength(1);
  });

  it('falls back to the space glyph for a code the atlas lacks', () => {
    // A host may send any byte. A missing glyph must draw a space, not crash and not
    // draw garbage from the next atlas cell -- an out-of-range index would sample the
    // neighbouring glyph, which looks like corruption rather than a missing character.
    const s = screenWith([[0, 0x07]]);             // not in this test's index
    const dl = drawList(resolve(s.snapshot()), geometry);
    expect(dl.cells[0]!.glyph).toBe(geometry.index[0x40]);
  });

  it('reports the pixel size of the whole screen', () => {
    const s = screenWith([]);
    const dl = drawList(resolve(s.snapshot()), geometry);
    expect(dl.width).toBe(80 * 8);
    expect(dl.height).toBe(24 * 14);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run packages/gui/test/drawlist.test.ts
```

Expected: FAIL, cannot resolve `../src/drawlist.js`.

- [ ] **Step 4: Implement**

`packages/gui/src/drawlist.ts`:

```typescript
import type { Rgb } from '@tn3270/core';

/**
 * Turn a resolved screen snapshot into per-cell draw instructions.
 *
 * PURE, and that is the point: this is where reverse video, the cursor and colour are
 * decided, and it is testable with no canvas, no Xvfb and no Electron. `render.ts` in the
 * TUI is built the same way -- it returns a string and lets the caller write it -- and
 * that is what made the TUI's output diffable and its tests fast. Putting these decisions
 * inside a canvas call would put every one of them behind a screenshot.
 *
 * `glyph` is an ATLAS INDEX here, but the field is deliberately the only thing a cell
 * says about its appearance, so a Programmable Symbol Set cell can later carry a
 * host-supplied bitmap through the same structure -- the `dispatch on Cell.kind`
 * constraint from HANDOFF, honoured at the one place it has to be.
 */
export interface AtlasGeometry {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly cols: number;
  readonly index: Readonly<Record<number, number>>;
}

export interface DrawCell {
  readonly x: number;
  readonly y: number;
  readonly glyph: number;
  readonly fg: Rgb;
  readonly bg: Rgb;
  readonly cursor: boolean;
  readonly underline: boolean;
}

export interface DrawList {
  readonly cells: readonly DrawCell[];
  readonly width: number;
  readonly height: number;
}

/** EBCDIC space. The fallback for any code the atlas has no glyph for. */
const EBCDIC_SPACE = 0x40;

export function drawList(
  snapshot: { readonly rows: number; readonly cols: number; readonly cursor: number;
              readonly cells: readonly { readonly ebcdic: number; readonly fg: Rgb;
                readonly bg: Rgb; readonly reverse?: boolean;
                readonly underline?: boolean }[] },
  atlas: AtlasGeometry,
): DrawList {
  const cells: DrawCell[] = [];
  for (let i = 0; i < snapshot.cells.length; i++) {
    const c = snapshot.cells[i]!;
    const row = Math.floor(i / snapshot.cols);
    const col = i % snapshot.cols;
    const glyph = atlas.index[c.ebcdic] ?? atlas.index[EBCDIC_SPACE] ?? 0;
    // Reverse video swaps the pair rather than picking a fixed inverse: the cell's own
    // colours are what a 3279 inverts.
    const reverse = c.reverse === true;
    cells.push({
      x: col * atlas.cellWidth,
      y: row * atlas.cellHeight,
      glyph,
      fg: reverse ? c.bg : c.fg,
      bg: reverse ? c.fg : c.bg,
      cursor: i === snapshot.cursor,
      underline: c.underline === true,
    });
  }
  return {
    cells,
    width: snapshot.cols * atlas.cellWidth,
    height: snapshot.rows * atlas.cellHeight,
  };
}
```

- [ ] **Step 5: Run the tests**

```bash
npx vitest run packages/gui/test/drawlist.test.ts
```

Expected: PASS, 6 tests. If `resolve()`'s cell shape differs from the parameter type
above, **fix the type to match core** rather than casting.

- [ ] **Step 6: Verify the whole suite and commit**

```bash
npm run typecheck && npx vitest run 2>&1 | tail -3
git add -A
git commit -m "feat(gui): pure draw list from a resolved snapshot"
```

---

## Task 6: `KeyboardEvent` → `Action`

Test-first. It sits beside the terminal keymap conceptually but lives here, because
Chromium events are the GUI's business — the shared thing is the `Action` vocabulary.

**Files:**
- Create: `packages/gui/src/keys.ts`, `packages/gui/test/keys.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gui/test/keys.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { actionForKey } from '../src/keys.js';

/** The subset of KeyboardEvent this maps on. Constructing a real one needs a DOM. */
const ev = (init: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) =>
  ({ ctrlKey: false, altKey: false, metaKey: false, ...init });

describe('actionForKey', () => {
  it('maps Enter, Tab and the arrows', () => {
    expect(actionForKey(ev({ key: 'Enter' }))).toEqual({ kind: 'enter' });
    expect(actionForKey(ev({ key: 'Tab' }))).toEqual({ kind: 'tab' });
    expect(actionForKey(ev({ key: 'ArrowLeft' }))).toEqual({ kind: 'left' });
  });

  it('maps Ctrl-C to CLEAR, not to an interrupt', () => {
    // The binding that surprises everyone and is nonetheless correct: a 3270 user needs
    // Clear constantly to dismiss VM's MORE... state. BINDING_INTENT in @tn3270/frontend
    // records the same thing for the terminal.
    expect(actionForKey(ev({ key: 'c', ctrlKey: true }))).toEqual({ kind: 'clear' });
  });

  it('maps F1-F12 to PF1-PF12 and shifted to PF13-PF24', () => {
    expect(actionForKey(ev({ key: 'F3' }))).toEqual({ kind: 'pf', n: 3 });
    expect(actionForKey({ ...ev({ key: 'F1' }), shiftKey: true } as never))
      .toEqual({ kind: 'pf', n: 13 });
  });

  it('maps a printable character to a type action', () => {
    expect(actionForKey(ev({ key: 'A' }))).toEqual({ kind: 'type', text: 'A' });
  });

  it('returns null for a bare modifier, rather than typing it', () => {
    // Without this, holding Shift types the string "Shift" into the field.
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) {
      expect(actionForKey(ev({ key })), key).toBeNull();
    }
  });

  it('returns null for a key it does not know, rather than guessing', () => {
    expect(actionForKey(ev({ key: 'F13' }))).toBeNull();
    expect(actionForKey(ev({ key: 'AudioVolumeUp' }))).toBeNull();
  });

  it('does not turn a Ctrl or Meta chord into typed text', () => {
    // Cmd-Q must not type "q" into the field on the way to quitting.
    expect(actionForKey(ev({ key: 'q', metaKey: true }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run packages/gui/test/keys.test.ts
```

Expected: FAIL, cannot resolve `../src/keys.js`.

- [ ] **Step 3: Implement**

`packages/gui/src/keys.ts`:

```typescript
import type { Action } from '@tn3270/frontend';

/**
 * Chromium `KeyboardEvent` to a named 3270 action.
 *
 * The GUI's counterpart to the terminal keymap, deliberately NOT derived from it: that
 * table is measured byte sequences and this one matches `key` names, so a shared
 * abstraction over both would be an untested third thing. What IS shared is the `Action`
 * vocabulary from `@tn3270/frontend`, and `BINDING_INTENT` there records which key is
 * meant to do what so the two can be compared.
 *
 * RETURNS null RATHER THAN GUESSING. An unknown key must do nothing: typing the literal
 * string "AudioVolumeUp" into a field is worse than ignoring it, and a bare `Shift` would
 * otherwise type "Shift".
 */
export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey?: boolean;
}

const NAMED: Readonly<Record<string, Action>> = Object.freeze({
  Enter: { kind: 'enter' },
  Tab: { kind: 'tab' },
  ArrowLeft: { kind: 'left' },
  ArrowRight: { kind: 'right' },
  ArrowUp: { kind: 'up' },
  ArrowDown: { kind: 'down' },
  Home: { kind: 'home' },
  Backspace: { kind: 'backspace' },
  Delete: { kind: 'delete' },
  End: { kind: 'eraseEOF' },
});

/** Modifier keys arrive as key events of their own and mean nothing on their own. */
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

const CTRL: Readonly<Record<string, Action>> = Object.freeze({
  c: { kind: 'clear' },
  r: { kind: 'reset' },
  u: { kind: 'eraseInput' },
});

export function actionForKey(e: KeyLike): Action | null {
  if (MODIFIERS.has(e.key)) return null;

  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    return CTRL[e.key.toLowerCase()] ?? null;
  }
  // A Meta or Alt chord belongs to the window or the OS, never to the field.
  if (e.metaKey || e.altKey) return null;

  const fn = /^F(\d{1,2})$/.exec(e.key);
  if (fn !== null) {
    const n = Number(fn[1]);
    if (n < 1 || n > 12) return null;          // F13+ is not a 3270 key
    // Shifted Fn is PF(n+12), the c3270 convention the terminal keymap also follows.
    return { kind: 'pf', n: e.shiftKey === true ? n + 12 : n };
  }

  const named = NAMED[e.key];
  if (named !== undefined) return named;

  // Exactly one character means a printable key. `key` is already the shifted form.
  if ([...e.key].length === 1) return { kind: 'type', text: e.key };
  return null;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run packages/gui/test/keys.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npx vitest run 2>&1 | tail -3
git add -A
git commit -m "feat(gui): map Chromium key events onto named 3270 actions"
```

---

## Task 7: Main process — arguments, Session, and the window

**Files:**
- Modify: `packages/gui/src/main.ts`
- Create: `packages/gui/test/args.test.ts`
- Create: `packages/gui/src/args.ts`

- [ ] **Step 1: Write the failing argument test**

The flags must be the TUI's, and the way to guarantee that is to parse with the same
shared pieces. `packages/gui/test/args.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseGuiArgs, UsageError } from '../src/args.js';

describe('parseGuiArgs', () => {
  it('takes the same host shape as the other front ends', () => {
    expect(parseGuiArgs(['N:LUA@vm:3270'])).toMatchObject({
      host: 'vm', port: 3270, lus: ['LUA'], tn3270e: false,
    });
  });

  it('accepts -model, -tn3270e and the TLS flags', () => {
    expect(parseGuiArgs(['-model', '3278-4-E', '-insecure', 'vm:3270']))
      .toMatchObject({ model: '3278-4-E', tls: { kind: 'plaintext' } });
  });

  it('refuses L: together with -insecure, as the others do', () => {
    expect(() => parseGuiArgs(['-insecure', 'L:vm:992'])).toThrow(UsageError);
  });

  it('requires a host', () => {
    expect(() => parseGuiArgs([])).toThrow(/usage/i);
  });

  it('refuses an unrecognised flag rather than ignoring it', () => {
    expect(() => parseGuiArgs(['--nonesuch', 'vm'])).toThrow(UsageError);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run packages/gui/test/args.test.ts
```

Expected: FAIL, cannot resolve `../src/args.js`.

- [ ] **Step 3: Implement by delegating**

`packages/gui/src/args.ts` follows `packages/tui/src/main.ts`'s `parseArgs` closely — read
that file and mirror its structure, using `takeTlsFlag`, `resolveTls` and
`resolveHostSpec` from `@tn3270/frontend`, including the `N:` versus `-tn3270e on`
contradiction check and the `L:` versus `-insecure` check. **Do not re-implement the flag
rules**; the whole point of the frontend package is that these come from one place. Export
a `UsageError` and a `GuiArgs` shaped like `TuiArgs` minus `colors`.

- [ ] **Step 4: Run the tests, then wire the Session into main**

```bash
npx vitest run packages/gui/test/args.test.ts
```

Expected: PASS, 5 tests.

Then in `packages/gui/src/main.ts`: parse `process.argv.slice(2)`, build the session with
`defaultSession(resolveTerminalType(...), args.tls, resolveAlternateSize(...), args.tn3270e)`,
connect with `await session.connect(args.host, args.port, lus)`, and on every `screen`
event send `resolve(session.screen.snapshot())` to the renderer over one IPC channel. On
an action from the renderer, check for `quit` and otherwise call `applyAction`.

**Report failures in the WINDOW, not only on stderr.** A user who double-clicked a `.app`
never sees a console, and `describeTlsError` exists precisely so the message names the
flag that fixes it. Load an error page or send the text to the renderer.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npx vitest run 2>&1 | tail -3
git add -A
git commit -m "feat(gui): parse the TUI's flags and drive a real Session"
```

---

## Task 8: Preload and renderer

**Files:**
- Create: `packages/gui/src/preload.ts`, `packages/gui/src/renderer.ts`,
  `packages/gui/src/blit.ts`
- Modify: `packages/gui/src/main.ts`, `packages/gui/index.html`

- [ ] **Step 1: The preload, exposing exactly two channels**

`packages/gui/src/preload.ts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron';

/**
 * The ONLY bridge between the protocol and the canvas: snapshots down, actions up.
 *
 * `contextIsolation` is on and `nodeIntegration` off, so the renderer cannot reach a
 * socket even if it tried. That is not ceremony -- the renderer parses nothing and owns
 * no protocol state, so a compromise there costs a repaint, and widening this surface is
 * what would change that.
 */
contextBridge.exposeInMainWorld('tn3270', {
  onScreen: (fn: (snapshot: unknown) => void) =>
    ipcRenderer.on('screen', (_e, snapshot) => fn(snapshot)),
  sendAction: (action: unknown) => ipcRenderer.send('action', action),
});
```

Add `preload: join(here, 'preload.js')` to the `webPreferences` in `main.ts`.

- [ ] **Step 2: The blitter**

`packages/gui/src/blit.ts` walks a `DrawList` and draws: fill the background rect, then
stamp the glyph from the atlas tinted with `fg`, then invert or block the cursor cell.
`ctx.imageSmoothingEnabled = false` and an integer `scale`.

The atlas is alpha-only coverage, so tinting means either building one tinted copy per
colour in use and caching it, or compositing with `globalCompositeOperation`. **Cache
per colour**: a 3279 has 16 colours at most, so the cache is bounded and small, and
recompositing per cell would be 1920 composites per frame.

- [ ] **Step 3: The renderer**

`packages/gui/src/renderer.ts`: fetch `atlas.bin` and `atlas.json`, build the tinted
caches, size the canvas to `drawList` dimensions times the scale, subscribe to
`window.tn3270.onScreen`, and on each snapshot call `drawList` then `blit`. Attach a
`keydown` listener that calls `actionForKey` and, when it returns non-null, calls
`preventDefault()` and sends the action.

**Choose the scale as the design states**: the largest integer scale whose letterboxed
screen fits within 80% of the display work area, minimum 1×. Centre the result.

- [ ] **Step 4: Run it against a host and look at it**

Bring up Hercules (the user IPLs it by hand), then:

```bash
npm run build
GUI=$HOME/micromamba/envs/gui
export LD_LIBRARY_PATH=$GUI/lib FONTCONFIG_PATH=$GUI/etc/fonts \
  FONTCONFIG_FILE=$GUI/etc/fonts/fonts.conf DISPLAY=:99
$GUI/bin/Xvfb :99 -screen 0 1280x1024x24 & sleep 2
./node_modules/.bin/electron packages/gui/dist/main.js --no-sandbox \
  -insecure -model 3278-2-E 127.0.0.1:3270
```

There is no screen to look at yet — Task 10 adds the screenshot harness, which is how you
actually see this. If you cannot wait, take one capture by hand with the spike from Task 1.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(gui): preload bridge, canvas renderer and glyph blitter"
```

---

## Task 9: Draw the OIA

**Files:**
- Modify: `packages/gui/src/drawlist.ts`, `packages/gui/test/drawlist.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/gui/test/drawlist.test.ts`:

```typescript
describe('the OIA', () => {
  it('is drawn BELOW the screen and is not one of the 1920 cells', () => {
    // The spec is explicit that the OIA lives outside the screen buffer. If it were a
    // cell, a host write could overwrite the status line.
    const s = screenWith([]);
    const dl = drawList(resolve(s.snapshot()), geometry, 'X Wait');
    expect(dl.cells).toHaveLength(24 * 80);
    expect(dl.oia?.text).toBe('X Wait');
    expect(dl.oia!.y).toBe(24 * geometry.cellHeight);
    expect(dl.height).toBe(25 * geometry.cellHeight);
  });

  it('leaves no room for the OIA when no text is given', () => {
    const s = screenWith([]);
    const dl = drawList(resolve(s.snapshot()), geometry);
    expect(dl.oia).toBeUndefined();
    expect(dl.height).toBe(24 * geometry.cellHeight);
  });
});
```

- [ ] **Step 2: Run, watch it fail, implement**

Add an optional third parameter `oiaText?: string` to `drawList`, an `oia?: { text, y }`
to `DrawList`, and one extra cell row of height when it is present. The renderer passes
`session.oia.toText()` — the same source the TUI uses, so the two cannot disagree about
status.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run packages/gui/test/drawlist.test.ts
npm run typecheck && npx vitest run 2>&1 | tail -3
git add -A
git commit -m "feat(gui): draw the OIA below the screen buffer"
```

---

## Task 10: The screenshot harness, and its guard

**Files:**
- Create: `packages/gui/scripts/shot.mjs`
- Create: `packages/gui/test/shot-flags.test.ts`
- Modify: `docs/live-testing.md`

- [ ] **Step 1: Write the harness**

`packages/gui/scripts/shot.mjs`: start Xvfb if `DISPLAY` is unset, launch the GUI against
a host or a replayed trace, `capturePage()`, and compare against
`packages/gui/test/golden/*.png` byte-for-byte, writing the actual image beside the golden
on mismatch. `--update` regenerates goldens.

**Byte-exact is the right comparison here** — bitmap glyphs at integer scale with
antialiasing off are deterministic, which is the second reason the atlas beat `fillText`.
If comparisons prove flaky in practice, **do not add a fuzz tolerance**: find out why, and
if it cannot be made deterministic, demote the goldens to a smoke check that asserts
"not blank" and let the draw-list tests carry the weight. A tolerance that hides a real
one-pixel regression is worse than no golden at all.

- [ ] **Step 2: Guard the invocation, because this script cannot run under `npm test`**

`packages/gui/test/shot-flags.test.ts`, in the spirit of `harness-flags.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * pty-smoke.py sat at 1/12 for two days when TLS went on by default, because a harness
 * outside `npm test` is exempt from every change until someone remembers it. This reads
 * the script as text and pins the flags whose absence would silently disable it.
 */
const script = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'shot.mjs'), 'utf8');

describe('the screenshot harness', () => {
  it('passes -insecure to the client, since Hercules cannot do TLS', () => {
    const argv = script.match(/ARGV = \[[^\]]*\]/s);
    expect(argv, 'no ARGV list found in shot.mjs').not.toBeNull();
    expect(argv![0]).toContain("'-insecure'");
  });

  it('disables image smoothing nowhere but the renderer', () => {
    // A harness that turned smoothing back on would make every golden unreproducible.
    expect(script).not.toContain('imageSmoothingEnabled = true');
  });
});
```

- [ ] **Step 3: Run both, and mutation-check the guard**

```bash
npx vitest run packages/gui/test/shot-flags.test.ts
node packages/gui/scripts/shot.mjs --update && node packages/gui/scripts/shot.mjs
```

Expected: the guard passes; the harness writes goldens, then passes against them.
Then remove `-insecure` from `ARGV`, re-run the guard, confirm it FAILS, and restore it.
**A guard that has never failed has not been tested.**

- [ ] **Step 4: Record it and commit**

```bash
git add -A
git commit -m "test(gui): screenshot goldens under Xvfb, with a guard on the harness argv"
```

---

## Task 11: Live verification and the final gate

**Files:**
- Modify: `README.md`, `docs/HANDOFF.md`, `docs/live-testing.md`,
  `docs/superpowers/specs/2026-08-28-electron-gui-and-shared-frontend-design.md`

- [ ] **Step 1: Drive it against both hosts**

Hercules must be running — the user IPLs it. For each of VM/370 on `3270` and MVS 3.8j on
`3271`: connect, log on, reach CMS or ISPF, type into a field, press Enter, use a PF key,
and log off. Capture a screenshot at the logged-on panel.

**Model 4 is REQUIRED on VM/CE**, not a preference: VM takes geometry from DMKRIO, so a
model-2 client on a 3278-4 device gets a locked keyboard, zero fields and a program check
755. Use `-model 3278-4-E` there.

- [ ] **Step 2: Check the success criteria from the design, honestly**

Go through the six criteria in the design's *Success criteria* section and record which
are met. **A criterion you could not test is recorded as untested, not dropped** — that is
how stage 2b's "byte-identical against both Hercules hosts" row was handled.

- [ ] **Step 3: The full gate**

```bash
npm run typecheck && npm run build
npx vitest run 2>&1 | tail -3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | grep -c PASS
python3 packages/cli/scripts/drive-e.py 2>&1 | tail -2
node packages/gui/scripts/shot.mjs
```

Expected: silent; all tests passing; `12`; `7/7 checks passed`; goldens matching. **The
two older harnesses are in this list on purpose**: this stage added a package and touched
nothing in `cli` or `tui`, so if either regresses, something was shared that should not
have been.

- [ ] **Step 4: Update README**

The *Layout* section gains `packages/gui`; *What works today* gains the GUI with whatever
qualification the live runs earned; *What is not implemented* loses "No GUI yet" and keeps
the dialog, menus, preferences, mouse and packaging as the named remainder; the
*Verification* table gains a GUI row and its test count is refreshed.

- [ ] **Step 5: Update HANDOFF and the spec**

HANDOFF: what works, what is verified and against what, and what stage 4 is. Record
outcomes against the design doc rather than in a session note.

- [ ] **Step 6: Check every box in this plan and commit**

```bash
git add -A
git commit -m "docs: the Electron GUI works, with its verification recorded"
```

---

## Self-review notes

**Spec coverage.** Part 2 of the design maps to tasks as: process model and security
(2, 7, 8); draw list then blit (5, 8); the font and its licence (3); the atlas (4); integer
scaling (8 Step 3); data flow (7, 8); error handling in the window (7 Step 4); `Ctrl-]`
(2); the OIA (9); testing split between `npm test` and goldens (3, 5, 6, 7, 10); live
verification (11). The keymap's GUI half is Task 6.

**One task exists that the design did not call for:** Task 1, re-proving Electron headless.
The design cites a verification from 2026-08-15, and on 2026-08-28 no Electron is installed
on this box and npm offers 44 rather than the 43 that was tested. A 13-day-old claim about
a different version, underpinning every remaining task, is worth one hour to re-establish.

**Deliberately vaguer than the rest:** Tasks 8 Steps 2-3 describe the blitter and renderer
without complete code. They depend on the atlas geometry that Task 4 emits and on the
tinting approach measured in Task 3, and inventing exact code here would be guessing at
numbers the earlier tasks produce. The decisions are stated (cache tinted glyphs per
colour, integer scale, centre, smoothing off); the arithmetic is the implementer's, against
tests that already exist by then.

**Known risks, in order.** Task 1 could fail outright and block everything. Task 3's
`normalise` has two easy-to-invert axes and Step 7 exists to catch both by eye. Task 10's
byte-exact goldens may prove less deterministic than argued, and the task says what to do
instead rather than allowing a tolerance to be quietly added.
