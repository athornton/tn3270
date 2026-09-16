# 3270 Web Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the existing 3270 canvas to a web browser over a WebSocket, so several emulated
S/370 systems are reachable from a browser with a decent user experience.

**Architecture:** The canvas layer moves out of `packages/gui` into a new `packages/canvas` shared
by both front ends. A new `packages/web` runs the `Session` and `drawList` server-side exactly as
Electron's main process does, and a served `bridge.js` supplies the same four-function
`window.tn3270` bridge over a WebSocket that `preload.cts` supplies over IPC — so `renderer.ts` is
reused **unmodified**. Frames are binary `deflate(JSON)`.

**Tech Stack:** TypeScript, `node:http`/`node:https`/`node:zlib`/`node:crypto` (no third-party
runtime dependencies), vitest, Electron 44.3.0 + Xvfb for the by-hand browser harnesses.

**Spec:** `docs/superpowers/specs/2026-09-15-web-gateway-design.md`

**Baseline:** branch `web-gateway` off `main` at `7501c27`, carrying the spec commits. `main` has
**1352 tests in 55 files**, typecheck and build clean, both GUI goldens matching, `pty-smoke.py`
12/12.

---

## Facts you must not re-derive (measured 2026-09-15 on this box)

- **A 24×80 frame is 237220 bytes of JSON and 6760 deflated.** An atlas message is 76603 JSON and
  7488 deflated. Both fit a 16-bit WebSocket length field; the 64-bit path is still implemented and
  tested because nothing guarantees a future frame stays small.
- **`DecompressionStream('deflate')` requires the zlib wrapper** (RFC 1950), which is what
  `zlib.deflateSync` emits — first bytes `78 9c`. `zlib.deflateRawSync` emits raw DEFLATE
  (which has NO header — its leading bytes are payload-dependent compressed data, measured `ab 56`,
  `4b 04`, `cb 48`, so there is no signature, only the absence of a valid zlib header) and would need
  `'deflate-raw'`. Mismatch these and every frame silently fails to
  inflate.
- **Node v26.8.2 has a WebSocket CLIENT (`typeof WebSocket === 'function'`) and NO server.** The
  built-in client is the independent oracle for our framing. Its constructor takes ONE argument and
  ignores an options object, so it **cannot be given a CA** — the `wss` test needs its own client.
- **Chromium (Electron 44.3.0) has `DecompressionStream`, `WebSocket`, `sessionStorage` and
  `createImageBitmap`**, and a deflate round-trip through it returned the original JSON.
- **`packages/cli/scripts/gen-test-certs.mjs` exports `generateCerts(dir)` and `haveOpenssl()`**,
  with a SAN carrying both `DNS:localhost` and `IP:127.0.0.1`. Certificates are NEVER committed.
- **Electron on this box needs `--no-sandbox` AND `--disable-gpu`**; without `--disable-gpu` a
  window HANGS rather than failing. Xvfb: start detached and **prove the socket** at
  `/tmp/.X11-unix/X99`; never test with `pgrep -f "Xvfb :99"`, which matches the shell command
  containing the pattern.
- **After moving a module between packages, `npm run build` MUST precede `vitest`** — the package
  resolves to its built `dist/index.js`, and testing a stale artefact looks exactly like a broken
  refactor. This cost 22 apparently-failing tests during the `frontend` extraction.
- **`git checkout` reddens the GUI chord harness's staleness guard** (it rewrites mtimes without
  changing content, which `npm run build` cannot clear). Run `npx tsc --build --force packages/gui`
  after switching branches.
- Both Hercules systems are UP and verified reachable this session: **VM/370 on `127.0.0.1:3270`**
  (22 fields, logo painted) and **MVS 3.8j TK5 on `127.0.0.1:3271`**. Neither offers TN3270E.
  **Do not complete a VM logon** unless the run also logs off: a logged-on VM session makes the
  next `LOGON` *reconnect* past the IPL, landing at `CP READ`, which has already produced three
  false failures here.

---

## File Structure

**`packages/canvas` (new)** — the presentation layer, shared by `gui` and `web`.

| file | responsibility |
| --- | --- |
| `src/renderer.ts` | browser entry: canvas, key events, the `window.tn3270` consumer. MOVED VERBATIM |
| `src/blit.ts` | glyph blitting, scale and centring. MOVED VERBATIM |
| `src/keys.ts` | `KeyboardEvent` → `Action`. MOVED VERBATIM |
| `src/drawlist.ts` | snapshot → draw list. Needs core. MOVED VERBATIM |
| `src/cg.ts` | EBCDIC → CG order. MOVED VERBATIM |
| `src/bdf.ts` | BDF font parsing for the atlas bake. MOVED VERBATIM |
| `src/assets.ts` | NEW: `assetDir()` and `readAtlas()`, so consumers never guess cross-package paths |
| `src/index.ts` | NEW: the package's Node-facing exports. **Must NOT export `renderer.ts`** |
| `scripts/build-atlas.mjs` | MOVED |

**`packages/web` (new)** — the gateway.

| file | responsibility |
| --- | --- |
| `src/wsframe.ts` | RFC 6455 frame parse/serialise. Pure, no sockets |
| `src/handshake.ts` | the `Sec-WebSocket-Accept` computation and upgrade-request validation |
| `src/wsserver.ts` | binds framing to a socket and yields a `Connection`. **The swap-to-`ws` seam** |
| `src/protocol.ts` | message shapes, `encodeServerMessage` (deflate), `decodeClientMessage` |
| `src/sessions.ts` | the registry: create, attach, detach, grace timer, cap |
| `src/httpstatic.ts` | the fixed file table and the token cookie |
| `src/args.ts` | web-only flags |
| `src/main.ts` | entry: wire everything, own the `Session`s |
| `static/index.html` | loads `bridge.js` then `renderer.js` |
| `src/bridgecore.ts` | the bridge's LOGIC, dependency-injected so vitest can run it in node |
| `src/bridge.ts` | the browser shim: real `WebSocket`/`sessionStorage`, then `bridgecore` |
| `scripts/browser-keys.mjs` | by-hand: Electron drives real chords at the served page |
| `scripts/browser-shot.mjs` | by-hand: compares the served page's pixels to the GUI golden |

**Do not touch:** `packages/core`, `packages/frontend`, `packages/cli`, `packages/tui`, and — beyond
the import updates in Task 1 — `packages/gui/src/main.ts`.

---

### Task 1: Extract `packages/canvas`

One atomic change: `gui` breaks until both halves are done. Nothing else goes in this commit.

**Files:**
- Create: `packages/canvas/package.json`, `packages/canvas/tsconfig.json`,
  `packages/canvas/src/index.ts`, `packages/canvas/src/assets.ts`
- Move: `packages/gui/src/{renderer,blit,keys,drawlist,cg,bdf}.ts` →
  `packages/canvas/src/`; `packages/gui/scripts/build-atlas.mjs` → `packages/canvas/scripts/`
- Move: `packages/gui/test/{blit,cg,drawlist,bdf,keys,renderer-imports}.test.ts` →
  `packages/canvas/test/`
- Modify: `packages/gui/src/main.ts` (imports), `packages/gui/index.html` (script paths),
  `packages/gui/package.json`, `packages/gui/tsconfig.json`, root `tsconfig.json` references

- [ ] **Step 1: Create the package files**

`packages/canvas/package.json`:

```json
{
  "name": "@tn3270/canvas",
  "version": "0.1.0",
  "license": "MIT",
  "author": "Adam Thornton <athornton@gmail.com>",
  "type": "module",
  "main": "./dist/index.js",
  "dependencies": {
    "@tn3270/core": "0.1.0",
    "@tn3270/frontend": "0.1.0"
  },
  "scripts": {
    "build": "tsc --build && node scripts/build-atlas.mjs"
  }
}
```

`packages/canvas/tsconfig.json` — note `DOM` in `lib`, which `renderer.ts` and `blit.ts` need:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../core" }, { "path": "../frontend" }]
}
```

- [ ] **Step 2: Move the six modules with `git mv`, unchanged**

```bash
cd ~/git/tn3270
mkdir -p packages/canvas/src packages/canvas/test packages/canvas/scripts
for f in renderer blit keys drawlist cg bdf; do
  git mv packages/gui/src/$f.ts packages/canvas/src/$f.ts
done
git mv packages/gui/scripts/build-atlas.mjs packages/canvas/scripts/build-atlas.mjs
for f in blit cg drawlist bdf keys renderer-imports; do
  git mv packages/gui/test/$f.test.ts packages/canvas/test/$f.test.ts
done
```

**Do not edit the contents of any moved file in this step.** `renderer.ts` in particular must end
up byte-identical; Step 9 verifies that.

- [ ] **Step 3: Write `packages/canvas/src/assets.ts`**

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AtlasGeometry } from './drawlist.js';

/**
 * Where this package's BUILT assets live, and how to read the atlas.
 *
 * WHY THIS EXISTS: two consumers now need `atlas.json`, `atlas.bin` and — for the web front end —
 * the three browser modules as static files. Both previously lived beside `gui`'s own `dist`, so
 * `main.ts` could say `join(here, 'atlas.json')`. A second consumer guessing a relative path into
 * a sibling package's `dist` is how that breaks silently when either package moves, so the
 * package that OWNS the assets answers where they are.
 *
 * Node-side only. The browser never imports this file, and `renderer-imports.test.ts` is what
 * keeps that true.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** This package's built output directory: the atlas and the browser modules. */
export function assetDir(): string {
  return here;
}

/** The three modules a browser must be served, in load order. */
export const BROWSER_MODULES: readonly string[] = Object.freeze([
  'renderer.js', 'blit.js', 'keys.js',
]);

/** Read the baked atlas. Throws if the package was not built. */
export function readAtlas(): { geometry: AtlasGeometry; coverage: Uint8Array } {
  const geometry = JSON.parse(readFileSync(join(here, 'atlas.json'), 'utf8')) as AtlasGeometry;
  const coverage = new Uint8Array(readFileSync(join(here, 'atlas.bin')));
  return { geometry, coverage };
}
```

- [ ] **Step 4: Write `packages/canvas/src/index.ts`**

```ts
/**
 * The canvas presentation layer, shared by the Electron GUI and the web gateway.
 *
 * WHY THIS PACKAGE EXISTS. These modules had two consumers the moment a web front end appeared,
 * and `packages/frontend` is explicitly not their home: its own docstring excludes "anything a
 * front end owns because of HOW it presents: ANSI generation, SGR depth, canvas geometry".
 *
 * `renderer.ts` IS DELIBERATELY NOT EXPORTED HERE. It is a browser ENTRY POINT with side effects
 * -- it queries `#screen` and throws when there is no canvas -- so importing it from Node would
 * throw at module load. Browsers get it as a served file, not as a package export.
 */
export { drawList } from './drawlist.js';
export type { AtlasGeometry, DrawCell, DrawList } from './drawlist.js';
export { blit, blankColumns, bestScale, centre, rgbCss, tintKey } from './blit.js';
export type { Surface, Ctx2D, BlitOptions } from './blit.js';
export { actionForKey } from './keys.js';
export type { KeyLike } from './keys.js';
export { assetDir, readAtlas, BROWSER_MODULES } from './assets.js';
export { EBCDIC_TO_CG } from './cg.js';
export { parseBdf } from './bdf.js';
```

**Check the last two export names against the real files and correct them if they differ** —
`cg.ts` and `bdf.ts` were written before this plan and their export names are what they are.

**AS BUILT: `cg.ts` exports `ebcdicToCg` and `CG_BOXSOLID`, NOT `EBCDIC_TO_CG`.** `parseBdf` was
right. Two further things this plan missed, both found by running it:

- **`packages/gui/assets/3270.bdf` must move to `packages/canvas/assets/`.** `build-atlas.mjs`,
  `bdf.test.ts` and `cg.test.ts` all reach it as `../assets/3270.bdf` relative to themselves, so
  moving it keeps all three working with zero content edits — which is itself the argument that the
  font belongs to `canvas`. Leaving it behind breaks the canvas build and two test files.
- **`packages/gui/package.json`'s build script must drop `&& node scripts/build-atlas.mjs`**, since
  that script moved. Otherwise `npm run build` fails on a missing file.

- [ ] **Step 5: Update `packages/gui`**

`packages/gui/package.json` — add the dependency:

```json
  "dependencies": {
    "@tn3270/canvas": "0.1.0",
    "@tn3270/core": "0.1.0",
    "@tn3270/frontend": "0.1.0"
  },
```

`packages/gui/tsconfig.json` — add the reference:

```json
  "references": [{ "path": "../core" }, { "path": "../frontend" }, { "path": "../canvas" }]
```

In `packages/gui/src/main.ts`, replace the three local imports

```ts
import { drawList, type AtlasGeometry } from './drawlist.js';
import { blankColumns, bestScale } from './blit.js';
```

with one package import, and replace the hand-rolled atlas read with `readAtlas()`:

```ts
import { drawList, blankColumns, bestScale, readAtlas, type AtlasGeometry } from '@tn3270/canvas';
```

The existing atlas-reading lines (`JSON.parse(readFileSync(join(here, 'atlas.json')...)` and the
`atlas.bin` read) become:

```ts
  const { geometry, coverage } = readAtlas();
```

Keep the surrounding comment explaining WHY the atlas is read here and shipped over IPC — it is
still true and still load-bearing.

`packages/gui/index.html` — the renderer now lives in a sibling package:

```html
<script type="module" src="../canvas/dist/renderer.js"></script>
```

- [ ] **Step 6: Update the root tsconfig's project references**

**AS BUILT — this step's first clause has no target: there is no root `tsconfig.json`**, only
`tsconfig.base.json`, which packages extend and which carries no `references`. Reference
registration is therefore fully covered by `packages/gui/tsconfig.json`'s `../canvas` entry plus the
root `typecheck` project list below. **Also required and missing from this plan: `npm install`**, to
create the `node_modules/@tn3270/canvas` symlink — `@tn3270/canvas` does not resolve without it.

Add `canvas` to the `typecheck` script's project list in the root `package.json`, before `gui`:

```json
    "typecheck": "tsc --build packages/core packages/frontend packages/canvas packages/cli packages/tui packages/gui"
```

- [ ] **Step 7: Build, then test — IN THAT ORDER**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -5
```
Expected: build and typecheck clean, **1352 tests in 55 files still passing**. The test COUNT must
not change: this task moves tests, it does not add or remove any. If `vitest` fails with missing
exports from `@tn3270/canvas`, you skipped the build — see the facts section.

- [ ] **Step 8: Prove the GUI still works, pixel for pixel**

```bash
cd ~/git/tn3270
[ -S /tmp/.X11-unix/X99 ] || { nohup ~/micromamba/envs/gui/bin/Xvfb :99 -screen 0 1280x1024x24 >/tmp/xvfb.log 2>&1 & sleep 3; }
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
```
Expected: `2/2 goldens matched` and `ok 15 chords, 13 actions in order`. **A moved golden is a
STOP-and-report condition — never run `--update`.** If `keys.mjs` refuses with `dist/ is OLDER than
src/`, that is the documented `git`-mtime case: `npx tsc --build --force packages/gui`.

- [ ] **Step 8b: THE MOVE BLINDS `keys.mjs`'s STALENESS GUARD — repair it**

**Found while running this task, and it is the defect with teeth.** `packages/gui/scripts/keys.mjs`
refuses to run when `dist/` is older than `src/`, and its docstring records why: `dist/keys.js` was
once found a day older than `src/keys.ts`. But it compared **`gui/dist` against `gui/src`**, and
`keys.ts` and `renderer.ts` — the renderer's `keydown` listener and `actionForKey`, which are this
harness's *entire unique coverage* — have just moved to `canvas`. Post-move it would report `ok` over
exactly the stale code it exists to catch.

Make it iterate both packages, comparing **per package** rather than one `max` across both: a fresh
`gui` build would otherwise mask a stale `canvas` one, because `gui`'s newer output would win the max
over `canvas`'s newer source. Re-pin `packages/gui/test/keys-harness-flags.test.ts` to the stronger
expression — pin the ITERATION over both package names, not two comparisons, so `canvas` cannot be
dropped while the regex still matches — and prove it: `touch packages/canvas/src/keys.ts`, confirm
the harness refuses naming `canvas`, then `npx tsc --build --force packages/canvas packages/gui` and
confirm green again.

This is in scope: it is a direct consequence of the move, and leaving it would silently disarm a
guard whose failure was deliberately observed one branch ago.

- [ ] **Step 9: Prove the moved files are byte-identical**

```bash
cd ~/git/tn3270
for f in renderer blit keys drawlist cg bdf; do
  a=$(git rev-parse HEAD:packages/gui/src/$f.ts)
  b=$(git hash-object packages/canvas/src/$f.ts)
  [ "$a" = "$b" ] && echo "IDENTICAL $f.ts" || echo "CHANGED    $f.ts  ($a vs $b)"
done
```
Expected: `IDENTICAL` for all six. A `CHANGED` line means content was edited during a move, which
this task forbids — revert that file's content and redo it.

- [ ] **Step 10: Commit**

```bash
cd ~/git/tn3270
git add -A
git commit -m "refactor: extract packages/canvas from the GUI

The canvas layer has two consumers now. frontend is explicitly not its home --
its docstring excludes canvas geometry -- so the presentation layer becomes its
own package and the GUI depends on it.

All six modules moved BYTE-IDENTICAL, verified by hash. Both screenshot goldens
still match and the chord harness still passes, which is what makes an
extraction this size checkable rather than hopeful.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 2: `packages/web` skeleton and argument parsing

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/src/args.ts`
- Test: `packages/web/test/args.test.ts`
- Modify: root `tsconfig.json`, root `package.json` typecheck list

- [ ] **Step 1: Write the failing test**

`packages/web/test/args.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseWebArgs, UsageError } from '../src/args.js';

/**
 * The gateway's own flags. The HOST-side flags (-insecure, -cafile, -model, -scheme) are
 * `frontend`'s and are parsed by its helpers; these are the ones that exist only because this
 * front end faces a network.
 *
 * THE TWO TLS DIRECTIONS MUST NOT BLUR. `--tls-cert`/`--tls-key` are how the BROWSER verifies US.
 * `-insecure` and friends are how WE verify the MAINFRAME. A test that confuses them would license
 * a flag that silently downgrades one of the two.
 */
describe('parseWebArgs', () => {
  it('requires a host', () => {
    expect(() => parseWebArgs([])).toThrow(UsageError);
  });

  it('takes host and port from the positional argument', () => {
    const a = parseWebArgs(['127.0.0.1:3270']);
    expect(a.host).toBe('127.0.0.1');
    expect(a.port).toBe(3270);
  });

  it('defaults the listen address to loopback, because exposing it must be deliberate', () => {
    expect(parseWebArgs(['vm:3270']).bind).toBe('127.0.0.1');
    expect(parseWebArgs(['--bind', '0.0.0.0', 'vm:3270']).bind).toBe('0.0.0.0');
  });

  it('defaults the listen port to 8270 and accepts --listen', () => {
    expect(parseWebArgs(['vm:3270']).listen).toBe(8270);
    expect(parseWebArgs(['--listen', '9999', 'vm:3270']).listen).toBe(9999);
  });

  it('generates a token when none is given, and keeps auth on', () => {
    const a = parseWebArgs(['vm:3270']);
    expect(a.auth).toBe(true);
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accepts an explicit token, and --auth off', () => {
    expect(parseWebArgs(['--token', 'sekrit', 'vm:3270']).token).toBe('sekrit');
    expect(parseWebArgs(['--auth', 'off', 'vm:3270']).auth).toBe(false);
  });

  it('refuses --tls-cert without --tls-key rather than downgrading silently', () => {
    expect(() => parseWebArgs(['--tls-cert', '/tmp/c.pem', 'vm:3270'])).toThrow(/--tls-key/);
    expect(() => parseWebArgs(['--tls-key', '/tmp/k.pem', 'vm:3270'])).toThrow(/--tls-cert/);
    const a = parseWebArgs(['--tls-cert', '/tmp/c.pem', '--tls-key', '/tmp/k.pem', 'vm:3270']);
    expect(a.tls).toEqual({ cert: '/tmp/c.pem', key: '/tmp/k.pem' });
  });

  it('defaults grace to 60s and the session cap to 16', () => {
    const a = parseWebArgs(['vm:3270']);
    expect(a.graceMs).toBe(60_000);
    expect(a.maxSessions).toBe(16);
  });

  it('takes a replay trace, which is the hostless test seam', () => {
    expect(parseWebArgs(['--replay', '/tmp/t.trace', 'vm:3270']).replay).toBe('/tmp/t.trace');
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseWebArgs(['--wat', 'vm:3270'])).toThrow(UsageError);
  });
});
```

**AS BUILT — this test list has TWO GAPS, both found in review and both required:**

1. **`--listen 0` must be accepted** (see the note on `positiveInt` below): the integration and TLS
   harnesses depend on an ephemeral port. Add
   `expect(parseWebArgs(['--listen', '0', 'vm:3270']).listen).toBe(0)` with a comment saying why, so
   nobody tightens it back.
2. **Nothing above exercises a HOST-SIDE flag at all** — `-insecure`, `-cafile`, `-model` and
   `-scheme` appear only in the docstring. So `takeTlsFlag`'s integration, which is the one piece of
   arithmetic in the file most likely to carry an off-by-one, has no test. Add the zero-extra-slot
   case (`-insecure`), the one-extra-slot case (`-cafile /tmp/ca.pem`), and `-model`, each asserting
   that **host and port are still correct afterwards** — that is what catches a swallowed argument.
   Then mutation-check by changing `i += eaten` to `i += 0` and confirming the `-cafile` case fails.

- [ ] **Step 2: Run it and confirm it fails to resolve the import**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/args.test.ts`
Expected: FAIL, `Failed to resolve import "../src/args.js"`.

- [ ] **Step 3: Create the package and implement `args.ts`**

`packages/web/package.json`:

```json
{
  "name": "@tn3270/web",
  "version": "0.1.0",
  "license": "MIT",
  "author": "Adam Thornton <athornton@gmail.com>",
  "type": "module",
  "main": "./dist/main.js",
  "dependencies": {
    "@tn3270/canvas": "0.1.0",
    "@tn3270/core": "0.1.0",
    "@tn3270/frontend": "0.1.0"
  },
  "scripts": { "build": "tsc --build" }
}
```

`packages/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../core" }, { "path": "../frontend" }, { "path": "../canvas" }
  ]
}
```

`packages/web/src/args.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { resolveHostSpec, takeTlsFlag, type TlsFlags } from '@tn3270/frontend';

/**
 * The gateway's arguments.
 *
 * ## TWO TLS DIRECTIONS, DELIBERATELY DIFFERENT SPELLINGS
 *
 * `--tls-cert` and `--tls-key` are how THE BROWSER VERIFIES US. `-insecure`, `-cafile`,
 * `-noverifycert` and the `L:` prefix are `frontend`'s and are how WE VERIFY THE MAINFRAME. The
 * long `--tls-` prefix versus s3270's short flags is the whole point: a reader must not be able to
 * mistake one direction for the other. Treat any new flag that could be read either way as a
 * defect.
 *
 * ## AUTH IS ON BY DEFAULT
 *
 * This process types at a mainframe on behalf of whoever reaches it. A token is generated when
 * none is given and printed at startup; `--auth off` exists for a fronting proxy that
 * authenticates, and main.ts warns loudly when it is used.
 */
export class UsageError extends Error {}

export interface WebArgs {
  readonly host: string;
  readonly port: number;
  readonly bind: string;
  readonly listen: number;
  readonly auth: boolean;
  readonly token: string;
  readonly graceMs: number;
  readonly maxSessions: number;
  readonly tls?: { cert: string; key: string; chain?: string };
  readonly replay?: string;
  readonly hostTls: TlsFlags;
  readonly model?: string;
  readonly scheme?: string;
}

/** One flag that takes a value, or throw naming the flag rather than the index. */
function value(argv: string[], i: number, flag: string): string {
  const v = argv[i + 1];
  if (v === undefined) throw new UsageError(`${flag} needs a value`);
  return v;
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${flag} needs a positive integer`);
  return n;
}

// AS BUILT, and this plan contradicted itself here: `--listen` MUST accept 0, because port 0 means
// "let the OS choose" and the integration and TLS harnesses in Tasks 10 and 11 pass `--listen 0` to
// get an ephemeral port. `positiveInt` must NOT be loosened for every flag -- a zero grace window or
// a zero session cap is a misconfiguration and keeps throwing -- so `--listen` gets its own
// non-negative check.

export function parseWebArgs(argv: readonly string[]): WebArgs {
  const rest: string[] = [];
  const hostTls: TlsFlags = {};
  let bind = '127.0.0.1';
  let listen = 8270;
  let auth = true;
  let token: string | undefined;
  let graceMs = 60_000;
  let maxSessions = 16;
  let cert: string | undefined;
  let key: string | undefined;
  let chain: string | undefined;
  let replay: string | undefined;
  let model: string | undefined;
  let scheme: string | undefined;

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    // The host-side TLS flags belong to frontend; it consumes what it recognises.
    if (takeTlsFlag(args, i, hostTls)) { i = takeTlsFlag.lastIndex ?? i; continue; }
    switch (a) {
      case '--bind': bind = value(args, i, a); i += 1; continue;
      case '--listen': listen = positiveInt(value(args, i, a), a); i += 1; continue;
      case '--token': token = value(args, i, a); i += 1; continue;
      case '--auth': {
        const v = value(args, i, a); i += 1;
        if (v !== 'on' && v !== 'off') throw new UsageError('--auth takes on or off');
        auth = v === 'on';
        continue;
      }
      case '--grace': graceMs = positiveInt(value(args, i, a), a) * 1000; i += 1; continue;
      case '--max-sessions': maxSessions = positiveInt(value(args, i, a), a); i += 1; continue;
      case '--tls-cert': cert = value(args, i, a); i += 1; continue;
      case '--tls-key': key = value(args, i, a); i += 1; continue;
      case '--tls-chain': chain = value(args, i, a); i += 1; continue;
      case '--replay': replay = value(args, i, a); i += 1; continue;
      case '-model': model = value(args, i, a); i += 1; continue;
      case '-scheme': scheme = value(args, i, a); i += 1; continue;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown flag ${a}`);
        rest.push(a);
    }
  }

  if (rest.length === 0) throw new UsageError('a host is required, as HOST:PORT');
  if (rest.length > 1) throw new UsageError(`unexpected argument ${rest[1]}`);
  // One TLS half without the other would otherwise start a PLAINTEXT gateway that the operator
  // believes is encrypted, which is worse than refusing.
  if (cert !== undefined && key === undefined) throw new UsageError('--tls-cert needs --tls-key');
  if (key !== undefined && cert === undefined) throw new UsageError('--tls-key needs --tls-cert');

  const resolved = resolveHostSpec(rest[0]!, hostTls);

  return {
    host: resolved.host,
    port: resolved.port,
    bind, listen, auth,
    token: token ?? randomBytes(16).toString('hex'),
    graceMs, maxSessions,
    ...(cert !== undefined && key !== undefined
      ? { tls: { cert, key, ...(chain !== undefined ? { chain } : {}) } } : {}),
    ...(replay !== undefined ? { replay } : {}),
    hostTls,
    ...(model !== undefined ? { model } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
  };
}
```

**`takeTlsFlag`'s real signature must be checked before writing this** — read
`packages/frontend/src/tls.ts`. The sketch above assumes it reports how many arguments it consumed;
if it does not, adapt the loop to whatever it actually does and say so in your report. Do NOT
duplicate `frontend`'s TLS flag parsing here; that drift is exactly what `frontend` exists to
prevent. Likewise use `resolveHostSpec`, never a local split — `splitTarget` was deleted for
being a second home for prefix meaning.

**AS BUILT — both signatures in the sketch above were wrong, and here they are:**

- `takeTlsFlag(flags: TlsFlags, flag: string, value: string | undefined, usageError: (m: string) => Error): number | undefined`
  returns the count of EXTRA argv slots consumed (0 for `-insecure`, 1 for `-cafile FILE`), or
  `undefined` when the flag is not one of its own. There is no `.lastIndex`. The working precedent
  is `packages/cli/src/main.ts` and `packages/tui/src/main.ts`:
  `const eaten = takeTlsFlag(hostTls, a, args[i+1], (m) => new UsageError(m)); if (eaten !== undefined) { i += eaten; continue; }`
- `resolveHostSpec(raw: string, mkError: (m: string) => Error): ResolvedHost` takes an
  error constructor and **never takes TLS flags at all**. It returns
  `{ host, port, lus, tn3270e, tlsRequested }` — five fields, not two.

**A DEFERRED GAP THAT TASK 10 MUST CLOSE, recorded here so it is not lost.** `WebArgs.hostTls`
holds RAW, unresolved flags, and `resolveHostSpec`'s `lus`, `tn3270e` and `tlsRequested` are
currently dropped. Task 10 opens the actual mainframe connection and must therefore:

- resolve `hostTls` into real TLS options the way the other front ends do, rather than passing raw
  flags to `defaultSession`;
- perform the **`L:`-prefix versus `-insecure` contradiction check** that `packages/tui/src/main.ts`
  does at parse time. The recorded reason it exists: `L:` is accepted and stripped, and must be
  REFUSED alongside `-insecure` rather than silently downgrading a connection the operator asked to
  encrypt;
- decide explicitly what a gateway does with `lus` and `tn3270e` — neither Hercules host offers
  TN3270E, so the honest answer may be "pass them through and let the negotiation fail as it does
  for every other front end", but it must be a decision and not an omission.

- [ ] **Step 4: Register the package and run the test**

Add `{ "path": "packages/web" }` to the root `tsconfig.json` references and `packages/web` to the
root `typecheck` script, after `packages/gui`.

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/args.test.ts
```
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add -A
git commit -m "feat(web): the gateway package and its arguments

Auth on by default with a generated token, loopback bind by default, and
--tls-cert without --tls-key refused rather than silently starting a plaintext
gateway the operator believes is encrypted.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 3: `wsframe.ts` — RFC 6455 framing

The highest-risk module in the plan. It is pure and gets tested hard.

**Files:**
- Create: `packages/web/src/wsframe.ts`
- Test: `packages/web/test/wsframe.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web/test/wsframe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseFrame, serializeFrame, OPCODE } from '../src/wsframe.js';

/**
 * RFC 6455 framing, hand-rolled to keep this project's zero-dependency property in the one
 * component that faces a network.
 *
 * WHAT THESE TESTS ARE FOR: the length encoding switches representation at 126 and at 65536, and
 * a client frame MUST be masked while a server frame MUST NOT be. Every one of those is a boundary
 * where an off-by-one produces a stream that looks almost right and desynchronises later --
 * failing far from the cause. `integration.test.ts` then checks the whole thing against Node's
 * built-in WebSocket client, which is an INDEPENDENT implementation; these tests alone would only
 * prove we agree with ourselves.
 */
const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);

/** Build a client frame by hand, so the parser is tested against bytes we control. */
function clientFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]!;
  const head: number[] = [(fin ? 0x80 : 0) | opcode];
  if (payload.length < 126) head.push(0x80 | payload.length);
  else if (payload.length < 65536) head.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
  else {
    head.push(0x80 | 127, 0, 0, 0, 0,
      (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

describe('parseFrame', () => {
  it('returns undefined when the buffer holds less than a whole frame', () => {
    expect(parseFrame(Buffer.from([0x81]))).toBeUndefined();
    const whole = clientFrame(OPCODE.TEXT, Buffer.from('hello'));
    expect(parseFrame(whole.subarray(0, whole.length - 1))).toBeUndefined();
  });

  it('unmasks a short text frame and reports how many bytes it consumed', () => {
    const buf = clientFrame(OPCODE.TEXT, Buffer.from('hello'));
    const f = parseFrame(buf)!;
    expect(f.opcode).toBe(OPCODE.TEXT);
    expect(f.fin).toBe(true);
    expect(f.payload.toString()).toBe('hello');
    expect(f.consumed).toBe(buf.length);
  });

  it('handles the 126-byte boundary, where the length becomes 16-bit', () => {
    for (const n of [125, 126, 127]) {
      const body = Buffer.alloc(n, 0x61);
      const f = parseFrame(clientFrame(OPCODE.BINARY, body))!;
      expect(f.payload.length, `payload for n=${n}`).toBe(n);
      expect(f.payload.equals(body)).toBe(true);
    }
  });

  it('handles the 65536-byte boundary, where the length becomes 64-bit', () => {
    for (const n of [65535, 65536]) {
      const body = Buffer.alloc(n, 0x62);
      const f = parseFrame(clientFrame(OPCODE.BINARY, body))!;
      expect(f.payload.length, `payload for n=${n}`).toBe(n);
    }
  });

  it('leaves a second frame in the buffer rather than consuming it', () => {
    const a = clientFrame(OPCODE.TEXT, Buffer.from('one'));
    const b = clientFrame(OPCODE.TEXT, Buffer.from('two'));
    const f = parseFrame(Buffer.concat([a, b]))!;
    expect(f.consumed).toBe(a.length);
    const g = parseFrame(Buffer.concat([a, b]).subarray(f.consumed))!;
    expect(g.payload.toString()).toBe('two');
  });

  it('REFUSES an unmasked client frame, which the RFC requires', () => {
    // Same bytes with the mask bit cleared and no masking key.
    const buf = Buffer.concat([Buffer.from([0x80 | OPCODE.TEXT, 5]), Buffer.from('hello')]);
    expect(() => parseFrame(buf)).toThrow(/mask/i);
  });

  it('reports a non-final frame so the caller can reassemble', () => {
    const f = parseFrame(clientFrame(OPCODE.TEXT, Buffer.from('par'), false))!;
    expect(f.fin).toBe(false);
    expect(f.opcode).toBe(OPCODE.TEXT);
    const g = parseFrame(clientFrame(OPCODE.CONTINUATION, Buffer.from('tial')))!;
    expect(g.opcode).toBe(OPCODE.CONTINUATION);
  });

  it('parses close, ping and pong', () => {
    for (const op of [OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG]) {
      expect(parseFrame(clientFrame(op, Buffer.alloc(0)))!.opcode).toBe(op);
    }
  });
});

describe('serializeFrame', () => {
  it('does NOT mask, because a server frame must not be masked', () => {
    const out = serializeFrame(OPCODE.BINARY, Buffer.from('abc'));
    expect(out[0]).toBe(0x80 | OPCODE.BINARY);
    expect(out[1]! & 0x80).toBe(0);          // mask bit clear
    expect(out[1]! & 0x7f).toBe(3);
    expect(out.subarray(2).toString()).toBe('abc');
  });

  it('uses the 16-bit length for 126 and above', () => {
    const out = serializeFrame(OPCODE.BINARY, Buffer.alloc(200));
    expect(out[1]! & 0x7f).toBe(126);
    expect(out.readUInt16BE(2)).toBe(200);
    expect(out.length).toBe(4 + 200);
  });

  it('uses the 64-bit length for 65536 and above', () => {
    const out = serializeFrame(OPCODE.BINARY, Buffer.alloc(65536));
    expect(out[1]! & 0x7f).toBe(127);
    expect(Number(out.readBigUInt64BE(2))).toBe(65536);
    expect(out.length).toBe(10 + 65536);
  });

  it('round-trips through the parser when the payload is masked back', () => {
    // A server frame is unmasked, so re-parsing it as a CLIENT frame must be refused -- which is
    // itself the property that keeps the two directions from being confused.
    expect(() => parseFrame(serializeFrame(OPCODE.TEXT, Buffer.from('x')))).toThrow(/mask/i);
  });
});
```

- [ ] **Step 2: Run and confirm the import fails**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/wsframe.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement `packages/web/src/wsframe.ts`**

```ts
/**
 * RFC 6455 frame parsing and serialising. Pure: no sockets, no state beyond the buffer given.
 *
 * WHY HAND-ROLLED: every package in this project declares only workspace siblings, and keeping
 * that property in the one network-facing component was a deliberate call. Framing is
 * well-specified and not security-sensitive the way crypto would be. `wsserver.ts` is the seam
 * that makes adopting the `ws` package a contained change if this disappoints.
 *
 * THE TWO DIRECTIONS ARE NOT SYMMETRIC (§5.1): a client MUST mask every frame and a server MUST
 * NOT. `parseFrame` therefore refuses an unmasked frame -- it only ever reads client frames -- and
 * `serializeFrame` never masks. Getting this backwards produces a stream that desynchronises a
 * few frames later, failing far from the cause.
 */
export const OPCODE = Object.freeze({
  CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa,
});

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  /** Bytes of the input this frame occupied, so the caller can advance its buffer. */
  readonly consumed: number;
}

/**
 * Parse one client frame, or `undefined` if the buffer does not yet hold a whole one.
 *
 * Returning `undefined` rather than throwing on a short buffer is the important half: a TCP read
 * boundary is not a protocol error, and treating it as one would drop a legitimate frame that had
 * merely arrived in two pieces.
 */
export function parseFrame(buf: Buffer): Frame | undefined {
  if (buf.length < 2) return undefined;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let off = 2;

  if (len === 126) {
    if (buf.length < off + 2) return undefined;
    len = buf.readUInt16BE(off);
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return undefined;
    const big = buf.readBigUInt64BE(off);
    // A frame larger than this is a bug or an attack; Buffer cannot hold it anyway.
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame length out of range');
    len = Number(big);
    off += 8;
  }

  if (!masked) throw new Error('client frame is not masked, which RFC 6455 §5.1 requires');
  if (buf.length < off + 4) return undefined;
  const key = buf.subarray(off, off + 4);
  off += 4;
  if (buf.length < off + len) return undefined;

  const payload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) payload[i] = buf[off + i]! ^ key[i % 4]!;
  return { fin, opcode, payload, consumed: off + len };
}

/** Serialise one unmasked server frame. Always final; we never fragment outbound. */
export function serializeFrame(opcode: number, payload: Buffer): Buffer {
  let head: Buffer;
  if (payload.length < 126) {
    head = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([head, payload]);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/wsframe.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the two asymmetry guards**

Change `if (!masked) throw` to `if (false) throw`, re-run, and confirm the unmasked-client-frame
test FAILS. Restore. Then change `0x80 | opcode` in `serializeFrame` to `0x80 | 0x80 | opcode` (set
the mask bit), re-run, and confirm the "does NOT mask" test FAILS. Restore. Report both messages.

**AS BUILT — THE SECOND MUTATION ABOVE IS INERT, AND THAT IS THE POINT.** `0x80 | 0x80 | opcode`
equals `0x80 | opcode`; the mask bit is bit 7 of **byte 1**, which it shares with the 7-bit length
field, while byte 0 holds FIN/RSV/opcode. Applied as written, all 12 tests still pass — so following
this step literally would report a guard as proven while testing nothing. The real mutation sets bit
7 of byte 1 in all three length branches.

**And doing it properly exposed a genuine coverage gap:** the 16-bit and 64-bit serialise tests
asserted only `out[1] & 0x7f`, so they SURVIVED the correct mutation — and per the measured frame
sizes the 16-bit path is the one production traffic actually uses, so the unpinned branch was the
load-bearing one. Both tests now also assert `out[1] & 0x80` is 0.

Two further as-built notes:

- **The `!masked` guard must sit ABOVE the extended-length parse.** As first written it came after,
  so an unmasked frame with a 127 length byte threw `frame length out of range` instead of the mask
  error — sending a person debugging a misbehaving client to the wrong end of the problem. The mask
  bit is fully known from byte 1 and has no dependency on the length parse. A **masked** frame with a
  truncated header must still return `undefined`, because that is a TCP read boundary and not an
  error; that case needs its own test.
- **No tsconfig covers `test/`** — every package uses `include: ["src/**/*.ts"]` — so type errors in
  test files are invisible to `npm run typecheck`. The plan's helper was not
  `noUncheckedIndexedAccess`-clean (`masked[i] ^= mask[i % 4]!` raises TS2532); write test code to the
  same strictness as `src`, since the existing tests are clean under those flags and that is the de
  facto norm.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/wsframe.ts packages/web/test/wsframe.test.ts
git commit -m "feat(web): RFC 6455 frame parse and serialise

Pure and separately testable, because it is the highest-risk part of choosing a
hand-rolled transport. Both length boundaries (126, 65536) and the client/server
masking asymmetry are pinned and mutation-checked.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 4: `handshake.ts` — the upgrade, the token and the Origin rule

**Files:**
- Create: `packages/web/src/handshake.ts`
- Test: `packages/web/test/handshake.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web/test/handshake.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { acceptKey, checkUpgrade } from '../src/handshake.js';

describe('acceptKey', () => {
  it('computes the RFC 6455 example', () => {
    // §1.3's worked example: this is the one value in the spec we can check against.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

/**
 * `checkUpgrade` decides whether to speak WebSocket at all. It returns a reason string when it
 * refuses, so main.ts can log WHICH rule fired -- a gateway that refuses silently is
 * indistinguishable from one that is down.
 */
describe('checkUpgrade', () => {
  const base = {
    headers: {
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      host: 'gw.example:8270',
    } as Record<string, string | undefined>,
    cookies: { tn3270_token: 'sekrit' },
    query: {} as Record<string, string>,
    auth: true,
    token: 'sekrit',
  };

  it('accepts a well-formed request with the token in a cookie', () => {
    expect(checkUpgrade(base)).toEqual({ ok: true, accept: 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' });
  });

  it('accepts the token in the query string too, for the first load', () => {
    const r = checkUpgrade({ ...base, cookies: {}, query: { t: 'sekrit' } });
    expect(r.ok).toBe(true);
  });

  it('refuses a wrong or missing token', () => {
    expect(checkUpgrade({ ...base, cookies: { tn3270_token: 'nope' } }).ok).toBe(false);
    expect(checkUpgrade({ ...base, cookies: {} }).ok).toBe(false);
  });

  it('refuses a token of the wrong LENGTH without throwing', () => {
    // timingSafeEqual throws on unequal lengths, so the length must be checked first. A crash here
    // would be a remote denial of service on a gateway, from an unauthenticated request.
    expect(checkUpgrade({ ...base, cookies: { tn3270_token: 'x' } }).ok).toBe(false);
  });

  it('skips the token entirely when auth is off', () => {
    expect(checkUpgrade({ ...base, cookies: {}, auth: false }).ok).toBe(true);
  });

  it('refuses a MISMATCHED Origin', () => {
    const r = checkUpgrade({
      ...base,
      headers: { ...base.headers, origin: 'https://evil.example' },
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/origin/i);
  });

  it('accepts a MATCHING Origin, on either scheme', () => {
    for (const o of ['http://gw.example:8270', 'https://gw.example:8270']) {
      expect(checkUpgrade({ ...base, headers: { ...base.headers, origin: o } }).ok).toBe(true);
    }
  });

  it('ACCEPTS an absent Origin, and this is deliberate', () => {
    // Browsers always send Origin on an upgrade; non-browser clients -- including Node's built-in
    // WebSocket, which the integration test uses as an independent oracle -- do not. Rejecting
    // absent would block every scripted client while stopping no browser attack, because the
    // attack needs a browser to supply the cookie automatically. Do NOT "tighten" this.
    expect(checkUpgrade(base).ok).toBe(true);
  });

  it('refuses a missing key or the wrong protocol version', () => {
    expect(checkUpgrade({ ...base, headers: { ...base.headers, 'sec-websocket-key': undefined } }).ok)
      .toBe(false);
    expect(checkUpgrade({ ...base, headers: { ...base.headers, 'sec-websocket-version': '8' } }).ok)
      .toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/handshake.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement `packages/web/src/handshake.ts`**

```ts
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The WebSocket upgrade decision: is this a WebSocket request, is it authorised, and is it from
 * somewhere allowed?
 *
 * Split out from `wsserver.ts` so it can be tested as a pure function over headers, which is the
 * only way the refusal paths get exercised without a socket.
 */

/** RFC 6455 §1.3's fixed GUID. Not a secret; the handshake proves protocol awareness, not identity. */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export interface UpgradeRequest {
  readonly headers: Record<string, string | undefined>;
  readonly cookies: Record<string, string>;
  readonly query: Record<string, string>;
  readonly auth: boolean;
  readonly token: string;
}

export type UpgradeResult =
  | { ok: true; accept: string }
  | { ok: false; reason: string };

/** Constant-time compare that survives unequal lengths, which `timingSafeEqual` throws on. */
function tokenMatches(given: string | undefined, want: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  // Length is not secret -- and an unequal-length call to timingSafeEqual THROWS, which on an
  // unauthenticated path would be a remote crash rather than a refusal.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function checkUpgrade(req: UpgradeRequest): UpgradeResult {
  const key = req.headers['sec-websocket-key'];
  if (key === undefined || key === '') return { ok: false, reason: 'no Sec-WebSocket-Key' };
  if (req.headers['sec-websocket-version'] !== '13') {
    return { ok: false, reason: `unsupported Sec-WebSocket-Version ${req.headers['sec-websocket-version']}` };
  }

  /**
   * ABSENT Origin is ACCEPTED; a MISMATCH is refused.
   *
   * Browsers always send Origin on an upgrade, so a mismatch is the cross-site WebSocket
   * hijacking shape and must be refused -- the cookie would otherwise be attached automatically
   * by the very browser being abused. Non-browser clients do not send Origin at all, including
   * Node's built-in WebSocket, which the integration tests use as an independent oracle of our
   * framing. Rejecting absent would block those and stop no attack, since an attack needs a
   * browser to supply the cookie.
   */
  const origin = req.headers['origin'];
  if (origin !== undefined && origin !== '') {
    const host = req.headers['host'] ?? '';
    if (origin !== `http://${host}` && origin !== `https://${host}`) {
      return { ok: false, reason: `cross-origin upgrade from ${origin}` };
    }
  }

  if (req.auth) {
    const given = req.cookies['tn3270_token'] ?? req.query['t'];
    if (!tokenMatches(given, req.token)) return { ok: false, reason: 'bad or missing token' };
  }

  return { ok: true, accept: acceptKey(key) };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/handshake.test.ts`
Expected: PASS, **10 tests** — the test block above contains 10 `it()` calls (1 + 9). This plan said
11; the CONTENT is the source of truth and an implementer correctly refused to invent an eleventh
test to match a stale number.

- [ ] **Step 5: Mutation-check the length guard and the Origin rule**

Remove the `a.length !== b.length` early return, re-run, and confirm the wrong-LENGTH test fails
with a thrown error rather than a clean refusal — that is the remote-crash shape. Restore. Then
change the Origin check to also refuse when `origin === undefined`, re-run, and confirm the
absent-Origin test fails. Restore. Report both.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/handshake.ts packages/web/test/handshake.test.ts
git commit -m "feat(web): the upgrade decision, with the token and the Origin rule

Length is checked before timingSafeEqual, which THROWS on unequal lengths --
on an unauthenticated path that is a remote crash rather than a refusal.
Absent Origin is accepted deliberately and the reason is in the test.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 4b: make the Origin check survive a reverse proxy (added after Task 4's review)

**Files:** modify `packages/web/src/handshake.ts`, `packages/web/src/args.ts`, and both their tests.

**MEASURED PROBLEM, and it would break the user's stated deployment.** The Origin check compares
`Origin` against the `Host` header. A TLS-terminating proxy that rewrites `Host` therefore 403s every
legitimate browser: a browser at `https://gw.example` sends `Origin: https://gw.example`, but
**nginx's default `proxy_set_header Host $proxy_host`** (and Apache's default `ProxyPreserveHost Off`)
forwards `Host: 127.0.0.1:8270`, which can never match. nginx configured with `Host $host`, and Caddy
by default, preserve it and work. Default ports are NOT the problem — a browser omits `:80`/`:443`
from both `Origin` and `Host`, so those agree.

The refusal is at least diagnosable: it logs `cross-origin upgrade from https://gw.example`.

Do both halves:

1. **Add a repeatable `--allow-origin ORIGIN` flag** in `args.ts` (`readonly allowOrigins: readonly string[]`,
   default empty). `checkUpgrade` accepts an `Origin` that matches the `Host` **or** appears in that
   list. Compare exactly — no wildcards, no suffix matching: a `*.example.com` rule is how these
   controls get quietly widened into uselessness. Record in the comment that this exists BECAUSE the
   common proxy default breaks the Host comparison, so nobody deletes it as redundant.
2. **Document it as a deployment requirement** where an operator will meet it: either preserve `Host`
   at the proxy, or pass `--allow-origin https://your.gateway`. This belongs in the web README that
   Task 15 writes — add a note there rather than only in a comment.

**AS BUILT (`df48ca6`).** Items 1, 3, 4 and 5 and the `--allow-origin` flag are done; `handshake.test.ts`
is 20 tests and `args.test.ts` 17. Three things to carry forward:

- **`UpgradeRequest.allowOrigins` was made REQUIRED, not optional** — nothing constructs an
  `UpgradeRequest` outside the test yet, so the cost is zero and it means the task that writes the
  server cannot forget to thread the flag through. **Ratified: keep it required.**
- **Item 2's documentation half is NOT done** and belongs to Task 15: there is no
  `packages/web/README.md` yet. Task 15 must carry the note "preserve `Host` at the proxy, or pass
  `--allow-origin https://your.gateway`".
- The no-wildcard test was itself mutation-checked by widening `includes` to a suffix rule, which
  failed it — so that assertion is not merely decorative.

Tests: a matching `--allow-origin` accepted; a non-matching one still refused; the flag not affecting
the absent-Origin rule; and that no wildcard is honoured (`--allow-origin https://*.example` must NOT
match `https://a.example`). Mutation-check by removing the allow-list branch and confirming the
proxy case fails again.

**Also route this one item to Task 10, where it belongs:** the plan's `main.ts` sketch compares the
token on the static path with `given !== args.token` — a plain, non-constant-time compare, unlike the
`timingSafeEqual` this task uses for the upgrade. That is inconsistent and leaks the token by timing
on the asset route. Task 10 must reuse the same helper for both paths; export it from `handshake.ts`
rather than writing a second comparison.

---

### Task 5: `protocol.ts` — messages and compression

**Files:**
- Create: `packages/web/src/protocol.ts`
- Test: `packages/web/test/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web/test/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { encodeServerMessage, decodeClientMessage } from '../src/protocol.js';

describe('encodeServerMessage', () => {
  it('emits a ZLIB-wrapped deflate stream, because that is what the browser expects', () => {
    // MEASURED: DecompressionStream('deflate') wants RFC 1950 (first bytes 78 9c), which
    // zlib.deflateSync emits. deflateRawSync emits RFC 1951, which has no header at all, and would need
    // 'deflate-raw'. Mismatch these and EVERY frame silently fails to inflate in the browser.
    const out = encodeServerMessage({ kind: 'error', message: 'x' });
    expect(out[0]).toBe(0x78);
    expect(out[1]).toBe(0x9c);
  });

  it('round-trips a frame message', () => {
    const msg = { kind: 'frame' as const, list: { width: 2, height: 3, cells: [] } };
    expect(JSON.parse(inflateSync(encodeServerMessage(msg)).toString())).toEqual(msg);
  });

  it('compresses a realistic frame by more than 20x', () => {
    // The measured figure is 237220 -> 6760 for a 24x80 screen. This asserts the PROPERTY that
    // makes full frames acceptable over a network, without pinning an exact byte count that a
    // zlib upgrade could legitimately change.
    const cells = Array.from({ length: 1920 }, (_, i) => ({
      x: i % 80, y: Math.floor(i / 80), glyph: 64, fg: [0, 255, 0], bg: [0, 0, 0],
    }));
    const raw = JSON.stringify({ kind: 'frame', list: { width: 720, height: 350, cells } });
    const enc = encodeServerMessage({ kind: 'frame', list: { width: 720, height: 350, cells } } as never);
    expect(raw.length / enc.length).toBeGreaterThan(20);
  });

  it('sends the atlas coverage as base64, since JSON cannot hold bytes', () => {
    const enc = encodeServerMessage({
      kind: 'atlas',
      geometry: { cellWidth: 9, cellHeight: 14, cols: 16, index: {} } as never,
      coverage: new Uint8Array([1, 2, 250]),
      blank: [0, 1],
    });
    const back = JSON.parse(inflateSync(enc).toString());
    expect(back.coverage).toBe(Buffer.from([1, 2, 250]).toString('base64'));
    expect(back.blank).toEqual([0, 1]);
  });
});

describe('decodeClientMessage', () => {
  it('accepts hello with and without a session id', () => {
    expect(decodeClientMessage('{"kind":"hello"}')).toEqual({ kind: 'hello' });
    expect(decodeClientMessage('{"kind":"hello","sessionId":"abc"}'))
      .toEqual({ kind: 'hello', sessionId: 'abc' });
  });

  it('accepts an action', () => {
    expect(decodeClientMessage('{"kind":"action","action":{"kind":"enter"}}'))
      .toEqual({ kind: 'action', action: { kind: 'enter' } });
  });

  it('REFUSES a quit action, which a browser must not be able to do to the gateway', () => {
    // The bridge intercepts quit and closes its own socket. This is defence in depth, because the
    // bridge is served code and a client is not obliged to run it.
    expect(() => decodeClientMessage('{"kind":"action","action":{"kind":"quit"}}'))
      .toThrow(/quit/i);
  });

  it('refuses malformed input rather than passing it on', () => {
    for (const bad of ['', 'not json', '{}', '[]', '{"kind":"nope"}', '{"kind":"action"}']) {
      expect(() => decodeClientMessage(bad), `for ${JSON.stringify(bad)}`).toThrow();
    }
  });

  it('refuses a sessionId that is not a string', () => {
    expect(() => decodeClientMessage('{"kind":"hello","sessionId":42}')).toThrow();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/protocol.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement `packages/web/src/protocol.ts`**

```ts
import { deflateSync } from 'node:zlib';
import type { AtlasGeometry, DrawList } from '@tn3270/canvas';
import type { Action } from '@tn3270/frontend';

/**
 * What crosses the socket, in both directions.
 *
 * ## COMPRESSION IS NOT OPTIONAL AND ITS FORMAT IS NOT FREE
 *
 * MEASURED: a 24x80 draw list is 237220 bytes of JSON and 6760 deflated -- 35x, because per-cell
 * colour data is enormously repetitive. Raw frames would be unpleasant over a network since a
 * keystroke can produce several; compressed they are a non-issue, which is why dirty-cell diffing
 * is NOT in this design.
 *
 * `deflateSync` emits the ZLIB wrapper (RFC 1950, first bytes 78 9c) and the browser's
 * `DecompressionStream('deflate')` requires exactly that. `deflateRawSync` emits raw DEFLATE
 * (no header at all; its leading bytes are payload-dependent) and would need `'deflate-raw'`. Mismatch
 * them and every frame silently fails to inflate,
 * with a blank canvas and no error -- the same signature as four other traps already recorded for
 * this renderer. `protocol.test.ts` pins the header bytes.
 */
export type ServerMessage =
  | { kind: 'atlas'; geometry: AtlasGeometry; coverage: Uint8Array; blank: readonly number[] }
  | { kind: 'frame'; list: DrawList }
  | { kind: 'error'; message: string }
  | { kind: 'session'; id: string };

export type ClientMessage =
  | { kind: 'hello'; sessionId?: string }
  | { kind: 'action'; action: Action };

/** Encode one server message as the payload of a binary WebSocket frame. */
export function encodeServerMessage(msg: ServerMessage): Buffer {
  // `coverage` is bytes and JSON has no way to hold them, so the atlas message carries base64.
  // The bridge decodes it back to a Uint8Array, so the renderer sees exactly what Electron's
  // structured clone gave it and needs no knowledge of the transport.
  const wire = msg.kind === 'atlas'
    ? { ...msg, coverage: Buffer.from(msg.coverage).toString('base64') }
    : msg;
  return deflateSync(Buffer.from(JSON.stringify(wire)));
}

/** Parse and VALIDATE one client message. Throws on anything unexpected. */
export function decodeClientMessage(text: string): ClientMessage {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('client message must be an object');
  }
  const kind = (raw as { kind?: unknown }).kind;

  if (kind === 'hello') {
    const id = (raw as { sessionId?: unknown }).sessionId;
    if (id === undefined) return { kind: 'hello' };
    if (typeof id !== 'string') throw new Error('sessionId must be a string');
    return { kind: 'hello', sessionId: id };
  }

  if (kind === 'action') {
    const action = (raw as { action?: unknown }).action;
    if (typeof action !== 'object' || action === null) throw new Error('action must be an object');
    const aKind = (action as { kind?: unknown }).kind;
    if (typeof aKind !== 'string') throw new Error('action needs a kind');
    // A browser must not be able to stop the gateway. The bridge intercepts `quit` and closes its
    // own socket; this is the server half, because the bridge is served code and a client is not
    // obliged to run it.
    if (aKind === 'quit') throw new Error('quit is not accepted from a client');
    return { kind: 'action', action: action as Action };
  }

  throw new Error(`unknown client message kind ${String(kind)}`);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/protocol.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Mutation-check the compression format and the quit refusal**

Change `deflateSync` to `deflateRawSync`, re-run, and confirm the `78 9c` test FAILS — that is the
silent-blank-canvas bug caught at build time instead. Restore. Then remove the `quit` throw,
re-run, and confirm that test FAILS. Restore. Report both.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/protocol.ts packages/web/test/protocol.test.ts
git commit -m "feat(web): the wire protocol, compressed the way the browser expects

Pins the 78 9c zlib header: DecompressionStream('deflate') requires RFC 1950 and
deflateRawSync's raw stream would fail to inflate silently. Also refuses a quit
action, so a browser cannot stop the gateway.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 6: `sessions.ts` — the registry, detach and grace

**Files:**
- Create: `packages/web/src/sessions.ts`
- Test: `packages/web/test/sessions.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web/test/sessions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/sessions.js';

/**
 * WHY A GRACE WINDOW EXISTS AT ALL, in one sentence a future editor must not delete: on VM/370 a
 * logged-on session left running means the next LOGON RECONNECTS past the IPL and lands at CP
 * READ, so without reattachment every wifi handoff would arm a trap that has already produced
 * three false failures in this project.
 */
describe('SessionRegistry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** A stand-in for the 3270 session: we assert on lifecycle, not on protocol. */
  const makeFactory = () => {
    const created: Array<{ id: string; closed: boolean }> = [];
    const factory = (id: string) => {
      const s = { id, closed: false };
      created.push(s);
      return { session: s as never, close: () => { s.closed = true; } };
    };
    return { factory, created };
  };

  it('creates a session for a hello with no id, and returns the new id', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    expect(a.created).toBe(true);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created).toHaveLength(1);
  });

  it('creates a NEW session for an unknown id rather than erroring', () => {
    // A stale sessionStorage id after a server restart is normal, not exceptional.
    const { factory } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach('11111111-1111-1111-1111-111111111111');
    expect(a.created).toBe(true);
    expect(a.id).not.toBe('11111111-1111-1111-1111-111111111111');
  });

  it('reattaches a detached session within the grace window', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    vi.advanceTimersByTime(59_000);
    const b = reg.attach(a.id);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
    expect(created).toHaveLength(1);
    expect(created[0]!.closed).toBe(false);
  });

  it('closes the 3270 session when the grace window expires', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    vi.advanceTimersByTime(60_001);
    expect(created[0]!.closed).toBe(true);
    expect(reg.attach(a.id).created).toBe(true);   // and it is gone
  });

  it('cancels the grace timer on reattach, so a later tick cannot kill a live session', () => {
    // The bug this catches: keeping the timer and letting it fire after reattachment, which would
    // drop the operator's session mid-use some seconds after a successful reconnect.
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    vi.advanceTimersByTime(30_000);
    reg.attach(a.id);
    vi.advanceTimersByTime(60_000);
    expect(created[0]!.closed).toBe(false);
  });

  it('refuses to exceed maxSessions, and says so', () => {
    const { factory } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 2 });
    reg.attach(undefined);
    reg.attach(undefined);
    expect(() => reg.attach(undefined)).toThrow(/too many/i);
  });

  it('counts a detached session against the cap until it expires', () => {
    // It still holds a socket to the host, so it is still a resource.
    const { factory } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 1 });
    const a = reg.attach(undefined);
    reg.detach(a.id);
    expect(() => reg.attach(undefined)).toThrow(/too many/i);
    vi.advanceTimersByTime(60_001);
    expect(reg.attach(undefined).created).toBe(true);
  });

  it('gives two concurrent clients two independent sessions', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    const b = reg.attach(undefined);
    expect(a.id).not.toBe(b.id);
    expect(created).toHaveLength(2);
  });

  it('closeAll closes every session, live or detached', () => {
    const { factory, created } = makeFactory();
    const reg = new SessionRegistry({ factory, graceMs: 60_000, maxSessions: 16 });
    const a = reg.attach(undefined);
    reg.attach(undefined);
    reg.detach(a.id);
    reg.closeAll();
    expect(created.every((s) => s.closed)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/sessions.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement `packages/web/src/sessions.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { Session } from '@tn3270/core';

/**
 * Which 3270 sessions exist, who is attached, and what happens when nobody is.
 *
 * ## THE GRACE WINDOW IS NOT A CONVENIENCE
 *
 * A socket closing does not end the 3270 session. On VM/370 a logged-on session left running is
 * not "busy": the next LOGON RECONNECTS to the still-running virtual machine, past its IPL, so a
 * fixed opening sequence lands at CP READ and CP reads every later command. That trap has already
 * produced three false failures in this project. Without reattachment, every wifi handoff and
 * laptop sleep would arm it.
 *
 * ## A DETACHED SESSION STILL COSTS
 *
 * It holds a socket to the host, so it counts against `maxSessions` until it expires. Excluding
 * it would let a client cycle connections to hold unbounded host resources.
 */
export interface SessionHandle {
  readonly session: Session;
  /** Ends the 3270 connection. Called on grace expiry and on shutdown. */
  close(): void;
}

export interface RegistryOptions {
  /** Builds a live 3270 session. Injected so tests need no host and no socket. */
  readonly factory: (id: string) => SessionHandle;
  readonly graceMs: number;
  readonly maxSessions: number;
}

interface Entry {
  readonly handle: SessionHandle;
  attached: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AttachResult {
  readonly id: string;
  readonly session: Session;
  /** True when this is a NEW session, so the caller knows to send a fresh id. */
  readonly created: boolean;
}

export class SessionRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: RegistryOptions) {}

  get size(): number { return this.entries.size; }

  /**
   * Attach a client. An unknown or absent id yields a NEW session: a stale `sessionStorage` id
   * after a server restart is ordinary, and erroring would strand the browser with no way back.
   */
  attach(sessionId: string | undefined): AttachResult {
    if (sessionId !== undefined) {
      const found = this.entries.get(sessionId);
      if (found !== undefined && !found.attached) {
        // Cancel the reaper FIRST. Leaving it armed would drop a live session seconds after a
        // successful reconnect, which reads as a host problem rather than as ours.
        if (found.timer !== undefined) { clearTimeout(found.timer); delete found.timer; }
        found.attached = true;
        return { id: sessionId, session: found.handle.session, created: false };
      }
    }

    if (this.entries.size >= this.opts.maxSessions) {
      throw new Error(`too many sessions (${this.opts.maxSessions}); try again later`);
    }

    const id = randomUUID();
    const handle = this.opts.factory(id);
    this.entries.set(id, { handle, attached: true });
    return { id, session: handle.session, created: true };
  }

  /** The socket closed. Keep the 3270 session alive briefly in case they come back. */
  detach(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined || !entry.attached) return;
    entry.attached = false;
    entry.timer = setTimeout(() => {
      this.entries.delete(id);
      entry.handle.close();
    }, this.opts.graceMs);
  }

  /** Shutdown: end every session, attached or not. */
  closeAll(): void {
    for (const [id, entry] of this.entries) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      this.entries.delete(id);
      entry.handle.close();
    }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/sessions.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Mutation-check the timer cancellation**

Delete the `clearTimeout` line in `attach`, re-run, and confirm the "cancels the grace timer" test
FAILS. That mutation is the realistic bug — the session dies a minute after a successful reconnect
— so watching it fail is what makes the test worth having. Restore and report the message.

**AS BUILT (`a2359c3`) — the implementation was right; its PROTECTION was missing.** The nine tests
above never call `detach` twice, never reattach more than once, and never look at the timer count, so
four separate mutations were invisible to them. Five tests were added, and one of them pins a
**security property nobody had stated**:

- **An already-attached id must NOT be reattachable.** A leaked or guessed session id would otherwise
  become a way to watch — and type into — another operator's logged-on session. The guard
  `found !== undefined && !found.attached` is what prevents it, and "simplifying" it to
  `found !== undefined` would produce a session-hijacking gateway with a green suite. Pinned now.
- **A duplicate `detach` must be a no-op.** A socket firing both `error` and `close` is ordinary, and
  without `detach`'s `!entry.attached` guard a second reaper is armed while the first is orphaned —
  still armed, unclearable, and able to `close()` a session a later reattach has made live again.
  Measured: `vi.getTimerCount()` goes to 2.
- Reconnect-storm coverage: five detach/reattach cycles keep the timer count at exactly 1 while
  detached and 0 while attached, so a flapping link neither accumulates reapers nor exhausts a
  cumulative budget.

`get size()` was dropped as YAGNI (nothing read it), and cancellation was factored into a private
`disarm(entry)` so no caller can clear the timer without dropping the handle.

**THREE THINGS TASK 10 MUST HANDLE, carried forward from this task's report:**

1. **`closeAll()` on shutdown is mandatory.** A detached session's `setTimeout` holds the Node event
   loop open for `graceMs`, so a gateway that stops listening without calling it hangs for up to a
   minute on exit.
2. **`SessionHandle.close()` must not throw.** An exception inside the timer callback is uncaught and
   would take the process down. The registry cannot sensibly decide that policy, so the real factory
   is where it belongs.
3. **Two tabs mean two host sockets**, because an attached id is deliberately not reattachable. That
   is the intended terminal-lines model, but it is what `--max-sessions` is really sizing, and the
   operator docs should say so.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/sessions.ts packages/web/test/sessions.test.ts
git commit -m "feat(web): the session registry, with detach and a grace window

A socket closing does not end the 3270 session: on VM a logged-on session left
running makes the next LOGON reconnect past the IPL, so without reattachment
every wifi handoff would arm that trap. A detached session still counts against
the cap, because it still holds a socket to the host.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 7: `wsserver.ts` — framing bound to a socket

**AS BUILT — SIX FINDINGS, and one of this task's two carried-over "Minor" review findings is
REFUTED by measurement rather than implemented.**

1. **THE PLAN'S TEST HARNESS WAS BROKEN: a single `PassThrough` is a LOOPBACK.** Its readable and
   writable halves are the same pipe, so two of the eight tests failed as written, each with a
   measured symptom worth keeping:
   - **`written` is a transcript of BOTH directions.** The ping test read back the client's own PING
     and asserted `expected 9 to be 10` — opcode 9 against 10. A collector fed by
     `socket.on('data')` cannot tell which party wrote a byte.
   - **Every frame the server writes re-enters its own `receive()`**, where it is correctly
     diagnosed as an unmasked client frame and closes the connection. `sendBinary` observed
     `'payload� '`, that tail being the CLOSE frame the server sent *itself*.
   Replaced with a `FakeSocket extends EventEmitter` exposing `write`/`end`/`deliver` — the whole of
   `Connection`'s contract, with the two directions independent as a real socket has them.
2. **The frame size cap and both Task 3 minors were absent from this task's own code blocks**,
   though the prose requires all three. The cap is `MAX_MESSAGE_BYTES = 8192` in `wsserver.ts`,
   applied through a new optional `maxPayload` parameter on `parseFrame`. It has to live in the
   codec: refusing a frame that merely DECLARES four gigabytes must happen from its header alone,
   before the promised payload is waited for. The value is reasoned from measurement —
   `keys.ts:114` emits `type` ONE CHARACTER at a time, so the real maximum is under 100 bytes; 8 KB
   leaves room for a future paste path (a 43x80 screenful is 3440 characters) without a protocol
   change.
3. **A HOLE THE PLAN DID NOT MENTION: the per-frame cap alone leaves fragment reassembly
   unbounded.** Each 1 KB fragment with FIN=0 is legal and under the cap, and a client that never
   sends a final frame grows the accumulator without limit — the same exhaustion the cap refuses,
   reached one legal frame at a time. `fragmentBytes` is now checked on every fragment.
4. **THE `as const` FINDING IS FALSE, and it claimed to have been verified.** Its premise was that
   `(typeof OPCODE)['TEXT']` widens to `number` without it. MEASURED on the real six-key shape under
   `tsc --strict`: `Object.freeze` ALREADY preserves the literal type (`const t: (typeof
   OPCODE)['TEXT'] = 999` is rejected as "Type '999' is not assignable to type '1'"), and the
   exhaustiveness `switch` the finding said was unprotected compiles clean with a `const never:
   never = x` default. `Object.freeze`'s lib overload constrains its values to primitives, so `T`
   infers with literals intact. **`as const` was written, measured, and reverted**; the reason is now
   a comment in `wsframe.ts` so the finding is not raised a third time. The other minor became a
   guard with a test, since an out-of-range opcode silently sets RSV1 rather than failing.
5. **THE PLAN'S IMPLEMENTATION DOES NOT COMPILE, AND A GREEN SUITE HID IT.** `private buffer =
   Buffer.alloc(0)` infers the narrow `Buffer<ArrayBuffer>`, while a socket chunk and
   `Buffer.concat` are `Buffer<ArrayBufferLike>` — which admits `SharedArrayBuffer` and is therefore
   not assignable. All 15 tests passed while `npm run build` failed, because **`vitest` does not
   typecheck**. The field needs an explicit `: Buffer` annotation. Build before believing a suite.
6. **ONE MUTATION WAS INERT ON THE FIRST TRY, and the test was the thing at fault.** The
   declared-length test appended the 4-byte masking key, which satisfied the parser's `off + 4`
   wait, so a cap checked LATE still threw and the mutation proved nothing. Both versions of the
   test now stop at the **10 header bytes**, the earliest point the length is known, which makes
   every later placement fail. A late check is in any case near-harmless — waiting four more bytes
   exhausts nothing — so the mutation that matters is moving the check past the PAYLOAD wait, and
   that is the one now pinned.

**Result: 15 tests in `wsserver.test.ts` and 4 added to `wsframe.test.ts` (18 total), against the 8
this task planned. Suite 1428 → 1447 in 61 files, typecheck and build clean. SEVEN mutations run, all
seven falsifying:** partial-frame discard, error containment removed, per-frame cap removed, fragment
bound removed, cap moved past the mask key, cap moved past the payload wait, and the opcode guard
removed.

**Files:**
- Create: `packages/web/src/wsserver.ts`
- Test: `packages/web/test/wsserver.test.ts`
- Modify: `packages/web/src/wsframe.ts` (two small hardenings, below)

**THE FRAME SIZE CAP IN THIS TASK IS NOW LOAD-BEARING FOR A COMMENT THAT ALREADY SHIPPED.**
`protocol.ts` says, in the present tense, that the WebSocket server caps payload size before a frame
reaches `decodeClientMessage`. That cap does not exist yet — `wsframe.ts` reads the extended lengths
and only refuses above `Number.MAX_SAFE_INTEGER`. If this task does not land the cap, that comment
becomes a false reassurance pointing at nothing, so **land it or correct the comment; do not leave the
pair inconsistent.** It is also what bounds a hostile `{kind:'type', text: <multi-megabyte string>}`,
which on an UNFORMATTED screen (`advanceAfterType` has no overflow check, and VM/370's own logon panel
is unformatted) stalls the single-process event loop for every other session.

**ALSO IN THIS TASK — A FRAME SIZE CAP, routed here from Task 5's review.** `decodeClientMessage`
deliberately does not bound its input length, because the layer that knows how big a frame is is this
one. Without a cap, a hostile client that has the token can send a multi-megabyte text frame and make
the server buffer and `JSON.parse` all of it. The only inbound messages are a `hello` and small
`action` objects, so the legitimate maximum is tiny — pick a generous bound (a few KB), refuse a
frame that exceeds it by closing that connection the same way a framing error does, and record in the
comment WHY the cap is small: nothing a browser legitimately sends approaches it. Give it a test.

**ALSO IN THIS TASK — two Minor findings carried over from Task 3's review**, folded here because this
is the task that consumes `OPCODE` and so is the natural place to tighten it:

1. **`OPCODE` is `Object.freeze`d but not `as const`.** Verified under `tsc --strict`: without it,
   `(typeof OPCODE)['TEXT']` widens to `number` rather than the literal `1`. That costs nothing today
   — every use is an `=== opcode` comparison — but it means a future exhaustiveness `switch` gets no
   literal-type protection. Add `as const` and confirm typecheck stays clean.
2. **Nothing asserts `opcode` is within its 4-bit range** in `serializeFrame`. Byte 0 shares its high
   nibble with FIN and the RSV bits, so an out-of-range opcode (say `0x10`) would silently set RSV1
   and corrupt the frame rather than fail. Callers are all internal today, so a guard or a comment is
   enough — pick one and say which, and if you add a guard give it a test.

Not to change: `parseFrame` accepts a non-minimal extended-length encoding (byte 1 = 126 carrying a
16-bit length below 126). The reviewer flagged this as an observation, not a defect — real
implementations are commonly permissive here and rejecting it is out of scope.

- [x] **Step 1: Write the failing tests**

`packages/web/test/wsserver.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { Connection } from '../src/wsserver.js';
import { serializeFrame, parseFrame, OPCODE } from '../src/wsframe.js';

/**
 * `Connection` is the seam that would be replaced wholesale by the `ws` package. It owns exactly
 * one thing: turning a byte stream into messages and back. It must survive a TCP read boundary
 * falling anywhere, which is the failure a hand-rolled transport is most likely to have and the
 * one a local test will never hit by accident.
 */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const key = Buffer.from([9, 8, 7, 6]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= key[i % 4]!;
  const head = payload.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : (() => { const h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 0x80 | 126; h.writeUInt16BE(payload.length, 2); return h; })();
  return Buffer.concat([head, key, masked]);
}

describe('Connection', () => {
  const setup = () => {
    const socket = new PassThrough();
    const written: Buffer[] = [];
    socket.on('data', (b: Buffer) => written.push(b));
    const conn = new Connection(socket as never);
    return { socket, written, conn };
  };

  it('delivers a whole text message', () => {
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    socket.write(clientFrame(OPCODE.TEXT, Buffer.from('{"kind":"hello"}')));
    expect(seen).toEqual(['{"kind":"hello"}']);
  });

  it('delivers a message split across TWO reads, byte by byte', () => {
    // The property that matters: a TCP boundary can fall anywhere, including inside the header or
    // the masking key. Feeding one byte at a time exercises every split at once.
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    const frame = clientFrame(OPCODE.TEXT, Buffer.from('x'.repeat(300)));
    for (const byte of frame) socket.write(Buffer.from([byte]));
    expect(seen).toEqual(['x'.repeat(300)]);
  });

  it('delivers two messages arriving in one read', () => {
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    socket.write(Buffer.concat([
      clientFrame(OPCODE.TEXT, Buffer.from('one')),
      clientFrame(OPCODE.TEXT, Buffer.from('two')),
    ]));
    expect(seen).toEqual(['one', 'two']);
  });

  it('reassembles a fragmented message', () => {
    const { socket, conn } = setup();
    const seen: string[] = [];
    conn.onText((t) => seen.push(t));
    // FIN=0 TEXT then FIN=1 CONTINUATION.
    const first = clientFrame(OPCODE.TEXT, Buffer.from('par'));
    first[0] = OPCODE.TEXT;                       // clear FIN
    socket.write(first);
    socket.write(clientFrame(OPCODE.CONTINUATION, Buffer.from('tial')));
    expect(seen).toEqual(['partial']);
  });

  it('answers a ping with a pong carrying the same payload', () => {
    const { socket, written, conn } = setup();
    conn.onText(() => {});
    socket.write(clientFrame(OPCODE.PING, Buffer.from('beat')));
    const out = parseFrameFromServer(Buffer.concat(written));
    expect(out.opcode).toBe(OPCODE.PONG);
    expect(out.payload.toString()).toBe('beat');
  });

  it('reports a close, once, and stops delivering afterwards', () => {
    const { socket, conn } = setup();
    const closed = vi.fn();
    conn.onClose(closed);
    conn.onText(() => { throw new Error('must not be called after close'); });
    socket.write(clientFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    socket.write(clientFrame(OPCODE.TEXT, Buffer.from('late')));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('sendBinary writes an UNMASKED binary frame', () => {
    const { written, conn } = setup();
    conn.sendBinary(Buffer.from('payload'));
    const out = Buffer.concat(written);
    expect(out[0]).toBe(0x80 | OPCODE.BINARY);
    expect(out[1]! & 0x80).toBe(0);
    expect(out.subarray(2).toString()).toBe('payload');
  });

  it('reports a framing error as a close rather than throwing into the event loop', () => {
    // An unmasked client frame is a protocol violation. Throwing from a 'data' handler would be an
    // unhandled exception that takes the whole gateway down -- one bad client must not do that.
    const { socket, conn } = setup();
    const closed = vi.fn();
    conn.onClose(closed);
    conn.onText(() => {});
    expect(() => socket.write(Buffer.concat([
      Buffer.from([0x80 | OPCODE.TEXT, 5]), Buffer.from('hello'),
    ]))).not.toThrow();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

/** Server frames are unmasked, so the shared parser (which demands a mask) cannot read them. */
function parseFrameFromServer(buf: Buffer): { opcode: number; payload: Buffer } {
  const opcode = buf[0]! & 0x0f;
  let len = buf[1]! & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  return { opcode, payload: buf.subarray(off, off + len) };
}
```

- [x] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/wsserver.test.ts`
Expected: FAIL, unresolved import.

- [x] **Step 3: Implement `packages/web/src/wsserver.ts`**

```ts
import type { Duplex } from 'node:stream';
import { parseFrame, serializeFrame, OPCODE } from './wsframe.js';

/**
 * A WebSocket connection over an already-upgraded socket.
 *
 * ## THIS IS THE SWAP-TO-`ws` SEAM
 *
 * Everything hand-rolled about the transport is behind this class and `wsframe.ts`. If the
 * hand-rolled framing ever disappoints, replacing this file with a `ws` wrapper that offers the
 * same four methods is the whole change -- nothing above it knows how a frame is shaped.
 *
 * ## A BAD CLIENT MUST NOT TAKE THE GATEWAY DOWN
 *
 * Framing errors are reported as a close, not thrown: a throw from a 'data' handler is an
 * unhandled exception that would end the process, so one malformed frame from one browser would
 * disconnect everybody else's mainframe session.
 */
export class Connection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  private textHandler: (text: string) => void = () => {};
  private closeHandler: () => void = () => {};

  constructor(private readonly socket: Duplex) {
    socket.on('data', (chunk: Buffer) => { this.receive(chunk); });
    socket.on('close', () => { this.fireClose(); });
    socket.on('error', () => { this.fireClose(); });
  }

  onText(fn: (text: string) => void): void { this.textHandler = fn; }
  onClose(fn: () => void): void { this.closeHandler = fn; }

  sendBinary(payload: Buffer): void {
    if (this.closed) return;
    this.socket.write(serializeFrame(OPCODE.BINARY, payload));
  }

  close(): void {
    if (this.closed) return;
    this.socket.write(serializeFrame(OPCODE.CLOSE, Buffer.alloc(0)));
    this.socket.end();
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      let frame;
      try {
        frame = parseFrame(this.buffer);
      } catch {
        // Protocol violation. Close this client and keep the process up.
        this.close();
        return;
      }
      if (frame === undefined) return;                 // a partial frame: wait for more bytes
      this.buffer = this.buffer.subarray(frame.consumed);

      if (frame.opcode === OPCODE.CLOSE) { this.close(); return; }
      if (frame.opcode === OPCODE.PING) {
        this.socket.write(serializeFrame(OPCODE.PONG, frame.payload));
        continue;
      }
      if (frame.opcode === OPCODE.PONG) continue;

      if (!frame.fin) {
        if (this.fragments.length === 0) this.fragmentOpcode = frame.opcode;
        this.fragments.push(frame.payload);
        continue;
      }
      if (frame.opcode === OPCODE.CONTINUATION) {
        this.fragments.push(frame.payload);
        const whole = Buffer.concat(this.fragments);
        this.fragments = [];
        if (this.fragmentOpcode === OPCODE.TEXT) this.textHandler(whole.toString('utf8'));
        continue;
      }
      if (frame.opcode === OPCODE.TEXT) this.textHandler(frame.payload.toString('utf8'));
      // Binary from a client is unused: the only inbound messages are small JSON texts.
    }
  }
}
```

- [x] **Step 4: Run the tests**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/wsserver.test.ts`
Expected: PASS, 8 tests.

- [x] **Step 5: Mutation-check the byte-by-byte path and the error containment**

Replace `if (frame === undefined) return;` with `if (frame === undefined) { this.buffer = Buffer.alloc(0); return; }`
(discarding partial frames), re-run, and confirm the byte-by-byte test FAILS. Restore. Then remove
the `try`/`catch` around `parseFrame`, re-run, and confirm the framing-error test FAILS (or the run
reports an unhandled error). Restore. Report both.

- [x] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/wsserver.ts packages/web/test/wsserver.test.ts
git commit -m "feat(web): a Connection over an upgraded socket, and the ws swap seam

Tested against a TCP boundary falling at EVERY byte, which is the failure a
hand-rolled transport is likeliest to have and which a local test never hits by
accident. A framing error closes that client instead of throwing into the event
loop and taking every other session down with it.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 8: `httpstatic.ts` and the page

**AS BUILT — FOUR FINDINGS. The traversal claim was sound; the table had a DIFFERENT lookup hole.**

1. **THE PLAIN-OBJECT TABLE RESOLVES INHERITED NAMES, MEASURED:** `table['constructor']` returns
   `Function`, `table['__proto__']` returns `Object.prototype`, and `toString`/`valueOf`/
   `hasOwnProperty` all likewise. Each is a truthy non-`Asset`, so a caller trusting the documented
   "refuses everything else" contract reaches `readFileSync(undefined)`. **No real request path gets
   there** — every key begins with `/` — so this is a contract hole rather than a live exploit, but
   it is the SAME shape that already bit this branch once (a frozen plain object still inherits, so
   `'Constructor+1'` parsed as a key modifier). Now a `Map`, which cannot have the bug at all
   instead of merely not exhibiting it. **The plan's traversal reasoning was right and is
   unchanged** — a table lookup still cannot be walked out of.
2. **`parseCookies` had the same hole at the WRITE end, and there it IS reachable from a request
   header.** `out[name] = value` on an object literal with the name `__proto__` does not set a
   cookie, it replaces the prototype — process-wide corruption from an untrusted header. And since
   `handshake.ts` looks the token up by name in this result, a `constructor=x` cookie could make
   that lookup yield a function rather than a string. The result is now `Object.create(null)`.
3. **The three browser modules were retyped instead of derived from `BROWSER_MODULES`.** That list
   is what Task 1 had `canvas` publish for exactly this consumer, and `assets.ts`'s own docstring
   says a second copy of an asset list is how this breaks silently when the owning package moves.
   The table now derives its module entries from it, so drift is impossible rather than merely
   unlikely. **Checked the runtime graph while doing it: `renderer.js` imports `blit.js` and
   `keys.js`, and neither imports anything further — so three IS the complete set**, and a missing
   fourth module would have been a 404 and a blank canvas with no error.
4. **Two tests were added for gaps, and one is a class of bug the plan could not see.** Resolving a
   path only proves the table has an entry: a renamed or unbuilt module still resolves and then 404s
   at runtime, which is the blank-canvas-no-error signature this renderer has produced four separate
   ways. A test now asserts every served file EXISTS on disk after a build. **`/bridge.js` is
   deliberately excluded from it until Task 9 creates that file**, and Task 9 must add it.

**Count correction: this task says "PASS, 10 tests" but its own test block contains NINE.** As built
there are 13 (the nine, plus the inherited-name refusal, the cookie-name pollution guard, the
`BROWSER_MODULES` drift guard and the existence check). Suite 1447 → 1460 in 62 files, typecheck and
build clean. Four mutations run, all four falsifying: plain-object table, plain-object cookie result,
hardcoded module list, and a wrong filename in the table.

**Files:**
- Create: `packages/web/src/httpstatic.ts`, `packages/web/static/index.html`
- Test: `packages/web/test/httpstatic.test.ts`

- [x] **Step 1: Write the failing tests**

`packages/web/test/httpstatic.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveAsset, tokenCookie, parseCookies } from '../src/httpstatic.js';

/**
 * A FIXED TABLE, not a path mapping. There is no traversal to defend against because there is no
 * arithmetic on the request path -- the only reachable files are the five named here.
 */
describe('resolveAsset', () => {
  it('serves the five files the browser needs', () => {
    for (const p of ['/', '/index.html', '/bridge.js', '/renderer.js', '/blit.js', '/keys.js']) {
      expect(resolveAsset(p), `for ${p}`).toBeDefined();
    }
  });

  it('gives / and /index.html the same file, with an HTML content type', () => {
    expect(resolveAsset('/')!.file).toBe(resolveAsset('/index.html')!.file);
    expect(resolveAsset('/')!.type).toMatch(/^text\/html/);
  });

  it('serves the browser modules as JavaScript', () => {
    expect(resolveAsset('/renderer.js')!.type).toMatch(/javascript/);
  });

  it('refuses everything else, including traversal attempts', () => {
    for (const p of ['/../package.json', '/../../etc/passwd', '/main.js', '/atlas.bin',
                     '/index.html/../secret', '//etc/passwd', '/drawlist.js']) {
      expect(resolveAsset(p), `for ${p}`).toBeUndefined();
    }
  });

  it('does NOT serve the atlas, which travels over the socket instead', () => {
    // Keeping the renderer's contract identical to the IPC path is the reason; a served atlas
    // would be a second way to get it and a second thing to keep in step.
    expect(resolveAsset('/atlas.json')).toBeUndefined();
  });
});

describe('tokenCookie', () => {
  it('is HttpOnly and SameSite=Strict, so a hostile page cannot read or send it cross-site', () => {
    const c = tokenCookie('abc', false);
    expect(c).toContain('tn3270_token=abc');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
  });

  it('adds Secure only when the gateway itself is TLS', () => {
    // Secure on a plaintext gateway would make the browser DROP the cookie, breaking the token
    // entirely -- so this flag cannot simply be set unconditionally "to be safe".
    expect(tokenCookie('abc', false)).not.toContain('Secure');
    expect(tokenCookie('abc', true)).toContain('Secure');
  });
});

describe('parseCookies', () => {
  it('reads one and several cookies', () => {
    expect(parseCookies('tn3270_token=abc')).toEqual({ tn3270_token: 'abc' });
    expect(parseCookies('a=1; tn3270_token=abc; b=2').tn3270_token).toBe('abc');
  });

  it('survives absent, empty and malformed headers without throwing', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('junk')).toEqual({});
    expect(parseCookies('=x; y=')).toEqual({ y: '' });
  });
});
```

- [x] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/httpstatic.test.ts`
Expected: FAIL, unresolved import.

- [x] **Step 3: Implement `packages/web/src/httpstatic.ts`**

```ts
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assetDir } from '@tn3270/canvas';

/**
 * The only files a browser can fetch, as a FIXED TABLE.
 *
 * There is deliberately no mapping from request path to filesystem path: a table lookup cannot be
 * walked out of, so directory traversal is not a class of bug this file can have. Adding a
 * pattern-matched route here would reintroduce it.
 *
 * The atlas is NOT here. It goes over the socket, which is what keeps the renderer's contract
 * identical to Electron's IPC path -- and one way to get a thing is easier to keep correct than two.
 */
const here = dirname(fileURLToPath(import.meta.url));
const staticDir = join(here, '..', 'static');

export interface Asset { readonly file: string; readonly type: string }

const JS = 'text/javascript; charset=utf-8';
const HTML = 'text/html; charset=utf-8';

/** Built lazily so `assetDir()` is not called at import time in a test that never serves. */
function table(): Record<string, Asset> {
  const page: Asset = { file: join(staticDir, 'index.html'), type: HTML };
  return {
    '/': page,
    '/index.html': page,
    '/bridge.js': { file: join(here, 'bridge.js'), type: JS },
    // The three browser modules live in the package that owns them; `assetDir()` answers where,
    // so this file never guesses a relative path into a sibling package's dist.
    '/renderer.js': { file: join(assetDir(), 'renderer.js'), type: JS },
    '/blit.js': { file: join(assetDir(), 'blit.js'), type: JS },
    '/keys.js': { file: join(assetDir(), 'keys.js'), type: JS },
  };
}

export function resolveAsset(path: string): Asset | undefined {
  return table()[path];
}

/**
 * The token cookie.
 *
 * `Secure` is conditional and that is not timidity: a `Secure` cookie is DROPPED by the browser
 * over plain HTTP, so setting it unconditionally would break authentication on exactly the
 * deployment that has no TLS. `HttpOnly` means the bridge never reads it -- it does not need to,
 * because the browser attaches cookies to the WebSocket upgrade automatically.
 */
export function tokenCookie(token: string, secure: boolean): string {
  const parts = [`tn3270_token=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}
```

- [x] **Step 4: Write `packages/web/static/index.html`**

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>tn3270</title>
<style>html,body{margin:0;background:#000;overflow:hidden}canvas{display:block}</style>
</head><body><canvas id="screen"></canvas>
<!--
  ORDER MATTERS. Module scripts execute in document order, and `renderer.js` reads
  `window.tn3270` in its module body, so the bridge must install it first. `bridge.js` ALSO
  queues messages that arrive before the renderer registers its handlers -- see bridgecore.ts;
  without that queue the atlas can be delivered to nobody and the canvas stays black with no error.
-->
<script type="module" src="./bridge.js"></script>
<script type="module" src="./renderer.js"></script>
</body></html>
```

- [x] **Step 5: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/httpstatic.test.ts`
Expected: PASS, 10 tests.

- [x] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/httpstatic.ts packages/web/static/index.html packages/web/test/httpstatic.test.ts
git commit -m "feat(web): the fixed asset table, the page, and the token cookie

A table cannot be walked out of, so traversal is not a class of bug this file
can have. Secure is conditional because a Secure cookie is DROPPED over plain
HTTP, which would break auth on exactly the deployment that has no TLS.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 9: the bridge — `bridgecore.ts` and `bridge.ts`

**Files:**
- Create: `packages/web/src/bridgecore.ts`, `packages/web/src/bridge.ts`
- Test: `packages/web/test/bridgecore.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/web/test/bridgecore.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createBridge } from '../src/bridgecore.js';

/**
 * The bridge's LOGIC, with the browser injected.
 *
 * `bridge.ts` is a five-line shim that passes the real `WebSocket` and `sessionStorage`; everything
 * worth testing lives here, so it runs under vitest's node environment with no DOM at all. This is
 * the same instinct as the TUI's `app.ts` taking its streams as parameters rather than reaching for
 * `process`.
 */
const fakeSocket = () => {
  const sent: string[] = [];
  const s = {
    sent,
    readyState: 1,
    send: (t: string) => sent.push(t),
    close: vi.fn(),
    onmessage: undefined as ((e: { data: unknown }) => void) | undefined,
    onopen: undefined as (() => void) | undefined,
    onclose: undefined as (() => void) | undefined,
  };
  return s;
};

const fakeStorage = (initial?: string) => {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set('tn3270.sessionId', initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    map,
  };
};

/** Inbound messages arrive already-inflated in these tests; inflation is the shim's job. */
const deliver = (socket: ReturnType<typeof fakeSocket>, msg: unknown) => {
  socket.onmessage?.({ data: JSON.stringify(msg) });
};

describe('createBridge', () => {
  it('sends hello on open, with no id the first time', () => {
    const socket = fakeSocket();
    createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello' });
  });

  it('offers a stored session id, so a reload reattaches', () => {
    const socket = fakeSocket();
    createBridge({ socket: socket as never, storage: fakeStorage('kept-id') as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ kind: 'hello', sessionId: 'kept-id' });
  });

  it('stores the id the server assigns', () => {
    const socket = fakeSocket();
    const storage = fakeStorage();
    createBridge({ socket: socket as never, storage: storage as never, inflate: async (d) => String(d) });
    deliver(socket, { kind: 'session', id: 'new-id' });
    expect(storage.map.get('tn3270.sessionId')).toBe('new-id');
  });

  it('QUEUES messages that arrive before a handler is registered, and flushes in order', async () => {
    // THE RACE THIS EXISTS FOR: the server sends `atlas` as soon as the socket opens, but
    // renderer.js registers its handlers when its module body runs. Without the queue the atlas is
    // delivered to nobody and the canvas stays black with NO error -- the same signature as four
    // other traps already recorded for this renderer.
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    deliver(socket, { kind: 'atlas', geometry: { cols: 16 }, coverage: 'AQID', blank: [1] });
    deliver(socket, { kind: 'frame', list: { width: 1, height: 1, cells: [] } });
    deliver(socket, { kind: 'frame', list: { width: 2, height: 2, cells: [] } });
    await Promise.resolve();

    const atlases: unknown[] = [];
    const frames: unknown[] = [];
    api.onAtlas((a) => atlases.push(a));
    api.onFrame((f) => frames.push(f));
    await Promise.resolve();

    expect(atlases).toHaveLength(1);
    expect(frames).toHaveLength(2);
    expect((frames[0] as { width: number }).width).toBe(1);
    expect((frames[1] as { width: number }).width).toBe(2);
  });

  it('decodes the atlas coverage back to a Uint8Array', async () => {
    // The renderer expects what Electron's structured clone gave it. base64 is a transport detail
    // and must not leak into it.
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    let got: { coverage: Uint8Array } | undefined;
    api.onAtlas((a) => { got = a as { coverage: Uint8Array }; });
    deliver(socket, { kind: 'atlas', geometry: {}, coverage: 'AQID', blank: [] });
    await Promise.resolve();
    expect(got!.coverage).toBeInstanceOf(Uint8Array);
    expect([...got!.coverage]).toEqual([1, 2, 3]);
  });

  it('forwards an action', () => {
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    api.sendAction({ kind: 'enter' });
    expect(JSON.parse(socket.sent[1]!)).toEqual({ kind: 'action', action: { kind: 'enter' } });
  });

  it('INTERCEPTS quit: closes the socket and reports it, never sends it', () => {
    // A browser must not be able to stop the gateway, but Ctrl-] cannot be a dead key either --
    // the renderer binds it and a silent no-op is worse than either alternative.
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    socket.onopen?.();
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    api.sendAction({ kind: 'quit' });
    expect(socket.sent.filter((s) => s.includes('quit'))).toHaveLength(0);
    expect(socket.close).toHaveBeenCalled();
    expect(errors.join(' ')).toMatch(/disconnect/i);
  });

  it('reports an unexpected close through onError, so the canvas is not silently frozen', () => {
    const socket = fakeSocket();
    const api = createBridge({ socket: socket as never, storage: fakeStorage() as never, inflate: async (d) => String(d) });
    const errors: string[] = [];
    api.onError((m) => errors.push(m));
    socket.onclose?.();
    expect(errors).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd ~/git/tn3270 && npx vitest run packages/web/test/bridgecore.test.ts`
Expected: FAIL, unresolved import.

- [ ] **Step 3: Implement `packages/web/src/bridgecore.ts`**

```ts
/**
 * The browser side of the bridge, with the browser injected.
 *
 * Supplies exactly what `preload.cts` supplies over IPC -- `onAtlas`, `onFrame`, `onError`,
 * `sendAction` -- so `renderer.ts` is reused UNMODIFIED. If this file grows a fifth function, the
 * renderer has stopped being shared and something is wrong.
 *
 * ## THE QUEUE IS NOT DEFENSIVE CODING
 *
 * The server sends `atlas` as soon as the socket opens. `renderer.js` registers its handlers when
 * its module body runs. Those orders are independent, so without a queue the atlas can be
 * delivered to nobody and the canvas stays black with no error in any console -- the same
 * signature as the ESM-preload, missing-`.cts`, bare-specifier and `file://`-fetch traps already
 * recorded for this renderer. So inbound messages are held until a handler for their kind exists.
 */
export interface BridgeDeps {
  readonly socket: {
    send(data: string): void;
    close(): void;
    onmessage?: ((e: { data: unknown }) => void) | undefined;
    onopen?: (() => void) | undefined;
    onclose?: (() => void) | undefined;
  };
  readonly storage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  /** Inflate one binary message to JSON text. Injected because Node and the browser differ. */
  readonly inflate: (data: unknown) => Promise<string>;
}

export interface BridgeApi {
  onAtlas(fn: (atlas: unknown) => void): void;
  onFrame(fn: (frame: unknown) => void): void;
  onError(fn: (message: string) => void): void;
  sendAction(action: unknown): void;
}

const ID_KEY = 'tn3270.sessionId';

export function createBridge(deps: BridgeDeps): BridgeApi {
  const handlers = new Map<string, (payload: unknown) => void>();
  const queue: Array<{ kind: string; payload: unknown }> = [];

  const dispatch = (kind: string, payload: unknown): void => {
    const fn = handlers.get(kind);
    if (fn === undefined) { queue.push({ kind, payload }); return; }
    fn(payload);
  };

  const register = (kind: string, fn: (payload: unknown) => void): void => {
    handlers.set(kind, fn);
    // Flush in arrival order, keeping anything still unclaimed.
    const mine = queue.filter((m) => m.kind === kind);
    for (let i = queue.length - 1; i >= 0; i -= 1) if (queue[i]!.kind === kind) queue.splice(i, 1);
    for (const m of mine) fn(m.payload);
  };

  deps.socket.onopen = () => {
    const id = deps.storage.getItem(ID_KEY);
    deps.socket.send(JSON.stringify(id === null ? { kind: 'hello' } : { kind: 'hello', sessionId: id }));
  };

  deps.socket.onclose = () => {
    dispatch('error', 'The connection to the gateway closed. Reload to reconnect.');
  };

  deps.socket.onmessage = (e) => {
    void (async () => {
      const text = await deps.inflate(e.data);
      const msg = JSON.parse(text) as { kind: string } & Record<string, unknown>;
      if (msg.kind === 'session') {
        deps.storage.setItem(ID_KEY, String(msg['id']));
        return;
      }
      if (msg.kind === 'atlas') {
        // base64 is a transport detail; the renderer must see what structured clone gave it.
        const bytes = Uint8Array.from(atob(String(msg['coverage'])), (c) => c.charCodeAt(0));
        dispatch('atlas', { geometry: msg['geometry'], coverage: bytes, blank: msg['blank'] });
        return;
      }
      if (msg.kind === 'frame') { dispatch('frame', msg['list']); return; }
      if (msg.kind === 'error') { dispatch('error', String(msg['message'])); return; }
    })();
  };

  return {
    onAtlas: (fn) => { register('atlas', fn as (p: unknown) => void); },
    onFrame: (fn) => { register('frame', fn as (p: unknown) => void); },
    onError: (fn) => { register('error', (p) => { fn(String(p)); }); },
    sendAction: (action) => {
      // `quit` never goes to the server: a browser must not be able to stop the gateway. But the
      // renderer binds Ctrl-] and a dead key is worse than either alternative, so it means
      // "disconnect this session" -- which, after the grace window, is exactly what it says.
      if ((action as { kind?: unknown }).kind === 'quit') {
        deps.socket.close();
        dispatch('error', 'Disconnected. Reload to start a new session.');
        return;
      }
      deps.socket.send(JSON.stringify({ kind: 'action', action }));
    },
  };
}
```

**`atob` is a browser global and also exists in Node 26**, so the test runs as written. If it is
missing in this Node, inject a `base64ToBytes` in `BridgeDeps` rather than reaching for `Buffer`,
which does not exist in a browser.

- [ ] **Step 4: Implement `packages/web/src/bridge.ts`, the shim**

```ts
import { createBridge } from './bridgecore.js';

/**
 * The five lines that touch real browser globals. Everything testable is in `bridgecore.ts`.
 *
 * The socket URL keeps the page's own scheme and host, so a TLS gateway gets `wss:` with no flag
 * and no configuration. The token rides in the cookie the page was served with, so it is not in
 * this URL and not in the address bar.
 */
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${proto}//${location.host}/ws`);
socket.binaryType = 'arraybuffer';

/** Inflate one binary message. Measured: the server sends zlib-wrapped deflate, so 'deflate'. */
async function inflate(data: unknown): Promise<string> {
  const stream = new DecompressionStream('deflate');
  const writer = stream.writable.getWriter();
  void writer.write(new Uint8Array(data as ArrayBuffer));
  void writer.close();
  return new Response(stream.readable).text();
}

window.tn3270 = createBridge({ socket, storage: sessionStorage, inflate });

// The token was in the query string on the first load only; the cookie carries it from here, so
// take it out of the address bar and out of any future Referer.
if (location.search !== '') history.replaceState(null, '', location.pathname);
```

- [ ] **Step 5: Run the tests**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/bridgecore.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Mutation-check the queue and the quit interception**

Change `dispatch` to drop unclaimed messages (`if (fn === undefined) return;`), re-run, and confirm
the queueing test FAILS. Restore. Then make `sendAction` forward `quit` like any other action,
re-run, and confirm the interception test FAILS. Restore. Report both.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/bridgecore.ts packages/web/src/bridge.ts packages/web/test/bridgecore.test.ts
git commit -m "feat(web): the WebSocket bridge, with the browser injected

Supplies the same four functions preload.cts supplies over IPC, so renderer.ts
is reused unmodified. Queues messages until a handler exists: the server sends
the atlas on open and the renderer registers handlers when its module runs, and
those orders are independent -- without the queue the canvas stays black with no
error anywhere.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 10: `main.ts` and the end-to-end integration test

**Files:**
- Create: `packages/web/src/main.ts`
- Test: `packages/web/test/integration.test.ts`

- [ ] **Step 1: Write `packages/web/src/main.ts`**

```ts
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createReadStream, readFileSync } from 'node:fs';
import { readAtlas, drawList, blankColumns } from '@tn3270/canvas';
import { resolve, resolveTerminalType, resolveAlternateSize } from '@tn3270/core';
import { applyAction, defaultSession, describeTlsError, resolveScheme } from '@tn3270/frontend';
import { parseWebArgs, UsageError, type WebArgs } from './args.js';
import { resolveAsset, tokenCookie, parseCookies } from './httpstatic.js';
import { checkUpgrade } from './handshake.js';
import { Connection } from './wsserver.js';
import { SessionRegistry } from './sessions.js';
import { encodeServerMessage, decodeClientMessage } from './protocol.js';

/**
 * The gateway: an HTTP(S) server, a WebSocket per client, and one 3270 Session each.
 *
 * This is Electron's `main.ts` with a socket where the IPC was. The draw list is computed HERE for
 * the same reason it is computed in Electron's main process -- `drawList` needs core's palette and
 * code page, and a browser cannot resolve a bare specifier without a bundler.
 *
 * ## WHAT MAKES THIS SAFE TO EXPOSE, AND WHAT DOES NOT
 *
 * Loopback by default, a token by default, and a mismatched Origin refused. Without `--tls-cert`
 * every keystroke -- including a password -- crosses the network in the clear, which is why
 * startup says so out loud rather than burying it in a doc.
 */
export function buildServer(args: WebArgs) {
  const atlas = readAtlas();
  const blank = [...blankColumns(atlas.coverage, atlas.geometry)];
  const scheme = args.scheme !== undefined ? resolveScheme(args.scheme) : resolveScheme();
  const typeOpts = { ...(args.model !== undefined ? { model: args.model } : {}) };
  const secure = args.tls !== undefined;

  const registry = new SessionRegistry({
    graceMs: args.graceMs,
    maxSessions: args.maxSessions,
    factory: () => {
      const session = defaultSession(
        resolveTerminalType(typeOpts), args.hostTls, resolveAlternateSize(typeOpts), undefined,
      );
      if (args.replay !== undefined) {
        // The hostless test seam: paint a recorded trace and open no socket at all, so no test
        // can reach a host or capture a credential.
        session.replay(readFileSync(args.replay, 'utf8'));
      } else {
        void session.connect(args.host, args.port).catch(() => { /* reported per-connection */ });
      }
      return { session, close: () => { session.disconnect?.(); } };
    },
  });

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const asset = resolveAsset(url.pathname);
    if (asset === undefined) { res.writeHead(404).end('not found'); return; }

    if (args.auth) {
      const cookies = parseCookies(req.headers.cookie);
      const given = cookies['tn3270_token'] ?? url.searchParams.get('t') ?? undefined;
      if (given !== args.token) { res.writeHead(403).end('forbidden'); return; }
      // Set it on every page load, so a bookmarked ?t= link keeps working and the cookie refreshes.
      if (asset.type.startsWith('text/html')) {
        res.setHeader('Set-Cookie', tokenCookie(args.token, secure));
      }
    }
    res.writeHead(200, { 'content-type': asset.type });
    createReadStream(asset.file).pipe(res);
  };

  const server = args.tls !== undefined
    ? createHttps({
        cert: readFileSync(args.tls.cert), key: readFileSync(args.tls.key),
        ...(args.tls.chain !== undefined ? { ca: readFileSync(args.tls.chain) } : {}),
      }, handler)
    : createHttp(handler);

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const check = checkUpgrade({
      headers: req.headers as Record<string, string | undefined>,
      cookies: parseCookies(req.headers.cookie),
      query: Object.fromEntries(url.searchParams),
      auth: args.auth,
      token: args.token,
    });
    if (!check.ok) {
      process.stderr.write(`upgrade refused: ${check.reason}\n`);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${check.accept}\r\n\r\n`,
    );

    const conn = new Connection(socket);
    let id: string | undefined;
    conn.onText((text) => {
      let msg;
      try { msg = decodeClientMessage(text); } catch (err) {
        conn.sendBinary(encodeServerMessage({ kind: 'error', message: String(err) }));
        return;
      }
      if (msg.kind === 'hello') {
        let attached;
        try { attached = registry.attach(msg.sessionId); } catch (err) {
          conn.sendBinary(encodeServerMessage({ kind: 'error', message: String(err) }));
          conn.close();
          return;
        }
        id = attached.id;
        const session = attached.session;
        if (attached.created) {
          conn.sendBinary(encodeServerMessage({ kind: 'session', id: attached.id }));
        }
        conn.sendBinary(encodeServerMessage({
          kind: 'atlas', geometry: atlas.geometry, coverage: atlas.coverage, blank,
        }));
        const send = (): void => {
          const snapshot = session.screen.snapshot();
          const oia = session.oia.toText();
          conn.sendBinary(encodeServerMessage({
            kind: 'frame',
            list: drawList(snapshot, resolve(snapshot), atlas.geometry, scheme,
              oia === '' ? undefined : oia),
          }));
        };
        session.on('screen', send);
        session.on('connect', send);
        session.on('disconnect', send);
        send();                                     // repaint immediately, which is what makes
        return;                                     // a reattach show the CURRENT screen
      }
      if (id === undefined) return;                 // an action before hello: nothing to apply to
      const entry = registry.attach(id);            // cheap: already attached, returns the same
      applyAction(entry.session, msg.action);
    });
    conn.onClose(() => { if (id !== undefined) registry.detach(id); });
  });

  return { server, registry };
}

/** Entry point. Kept separate from `buildServer` so tests can bind an ephemeral port. */
export function run(argv: readonly string[]): void {
  let args;
  try { args = parseWebArgs(argv); } catch (err) {
    process.stderr.write(`${err instanceof UsageError ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const { server } = buildServer(args);
  server.listen(args.listen, args.bind, () => {
    const scheme = args.tls !== undefined ? 'https' : 'http';
    const shown = args.bind === '0.0.0.0' ? 'YOUR-HOST' : args.bind;
    process.stdout.write(`serving ${args.host}:${args.port} at ${scheme}://${shown}:${args.listen}/`
      + (args.auth ? `?t=${args.token}\n` : '\n'));
    if (!args.auth) {
      process.stderr.write('WARNING: --auth off. Anything that can reach this port can type at '
        + `${args.host}:${args.port}.\n`);
    }
    if (args.tls === undefined && args.bind !== '127.0.0.1') {
      process.stderr.write('WARNING: no --tls-cert and not bound to loopback. Keystrokes, '
        + 'including passwords, cross the network in the clear.\n');
    }
  });
}
```

**Check three things against the real code rather than trusting this sketch, and report what you
find:** whether `Session` has a `disconnect()` method (and use whatever ends a connection if not);
whether `resolveScheme` takes an argument; and `defaultSession`'s real parameter list. All three are
used above from memory of their shapes.

- [ ] **Step 2: Write the integration test**

`packages/web/test/integration.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { buildServer } from '../src/main.js';
import { parseWebArgs } from '../src/args.js';

/**
 * THE WHOLE GATEWAY, DRIVEN BY NODE'S BUILT-IN WebSocket.
 *
 * This is the important test in the package. The framing is hand-rolled, so testing it only
 * against our own client would be self-consistent and prove nothing; Node's built-in WebSocket is
 * an INDEPENDENT implementation and is therefore an oracle. If our handshake or framing is subtly
 * wrong, this is what says so.
 *
 * Hostless: `--replay` paints a recorded trace, so no socket is opened to any mainframe and no
 * credential can appear.
 */
const trace = join(process.cwd(), 'packages/fixtures/traces/synthetic-ispf-like.trace');
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

/** Start on an ephemeral port and return its URL and token. */
async function start(extra: string[] = []): Promise<{ url: string; token: string }> {
  const args = parseWebArgs(['--replay', trace, '--listen', '0', ...extra, '127.0.0.1:3270']);
  const { server, registry } = buildServer(args);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  stop = () => { registry.closeAll(); server.close(); };
  return { url: `ws://127.0.0.1:${port}/ws?t=${args.token}`, token: args.token };
}

/** Collect inflated server messages until `want` of them have arrived. */
function collect(ws: WebSocket, want: number): Promise<Array<Record<string, unknown>>> {
  const got: Array<Record<string, unknown>> = [];
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => rejectP(new Error(`only ${got.length} of ${want} messages`)), 8000);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e) => {
      const text = inflateSync(Buffer.from(e.data as ArrayBuffer)).toString();
      got.push(JSON.parse(text) as Record<string, unknown>);
      if (got.length >= want) { clearTimeout(timer); resolveP(got); }
    });
  });
}

describe('the gateway end to end', () => {
  it('completes a handshake with a standards-compliant client and sends session, atlas, frame', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const messages = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    const got = await messages;
    expect(got.map((m) => m['kind'])).toEqual(['session', 'atlas', 'frame']);
    expect(typeof got[0]!['id']).toBe('string');
    expect(typeof got[1]!['coverage']).toBe('string');       // base64
    const list = got[2]!['list'] as { cells: unknown[] };
    expect(list.cells.length).toBeGreaterThan(100);          // the trace paints a real screen
    ws.close();
  });

  it('applies an action and sends a new frame', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;
    const next = collect(ws, 1);
    // `tab` moves the cursor with no host involved, so a replayed session can show it.
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'tab' } }));
    expect((await next)[0]!['kind']).toBe('frame');
    ws.close();
  });

  it('reattaches the SAME session after a reconnect, and repaints', async () => {
    const { url } = await start();
    const a = new WebSocket(url);
    await new Promise((r) => a.addEventListener('open', r, { once: true }));
    const firstBatch = collect(a, 3);
    a.send(JSON.stringify({ kind: 'hello' }));
    const id = (await firstBatch)[0]!['id'] as string;
    a.close();

    const b = new WebSocket(url);
    await new Promise((r) => b.addEventListener('open', r, { once: true }));
    const second = collect(b, 2);
    b.send(JSON.stringify({ kind: 'hello', sessionId: id }));
    const got = await second;
    // No fresh `session` message, because nothing was created: atlas then frame.
    expect(got.map((m) => m['kind'])).toEqual(['atlas', 'frame']);
    b.close();
  });

  it('refuses the upgrade without a token', async () => {
    const { url } = await start();
    const bad = url.replace(/\?t=.*/, '');
    const ws = new WebSocket(bad);
    const err = await new Promise<string>((r) => {
      ws.addEventListener('error', () => r('error'), { once: true });
      ws.addEventListener('close', () => r('close'), { once: true });
    });
    expect(err).toMatch(/error|close/);
  });

  it('refuses a quit action rather than stopping the gateway', async () => {
    const { url } = await start();
    const ws = new WebSocket(url);
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    const first = collect(ws, 3);
    ws.send(JSON.stringify({ kind: 'hello' }));
    await first;
    const next = collect(ws, 1);
    ws.send(JSON.stringify({ kind: 'action', action: { kind: 'quit' } }));
    const got = await next;
    expect(got[0]!['kind']).toBe('error');
    expect(String(got[0]!['message'])).toMatch(/quit/i);
    ws.close();
  });
});
```

- [ ] **Step 3: Build and run**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/integration.test.ts`
Expected: PASS, 5 tests. **If the handshake fails here, the bug is in `handshake.ts` or
`wsframe.ts`, not in the test** — Node's client is the reference. Report the exact failure rather
than adjusting the test to match our output.

- [ ] **Step 4: Commit**

```bash
cd ~/git/tn3270
git add packages/web/src/main.ts packages/web/test/integration.test.ts
git commit -m "feat(web): wire the gateway, and drive it with Node's own WebSocket client

The framing is hand-rolled, so an independent client is the only test that can
say it is right; testing it against our own client would be self-consistent and
prove nothing. Hostless via --replay, so no test can reach a mainframe.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 11: TLS on the browser side

**Files:**
- Create: `packages/web/test/tls.test.ts`
- Modify: none — `main.ts` already branches on `args.tls`

- [ ] **Step 1: Write the test**

`packages/web/test/tls.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { connect as tlsConnect } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/main.js';
import { parseWebArgs } from '../src/args.js';
import { generateCerts, haveOpenssl } from '../../cli/scripts/gen-test-certs.mjs';

/**
 * `wss://`, with a certificate generated minutes ago.
 *
 * WHY A HAND-ROLLED CLIENT HERE AND NOT NODE'S: Node's built-in WebSocket constructor takes ONE
 * argument and ignores an options object, so it cannot be given a CA and cannot verify a
 * self-signed certificate. `NODE_EXTRA_CA_CERTS` would have to be set before the process starts,
 * which a test cannot do to itself. So this speaks the handshake over `tls.connect({ ca })`.
 *
 * NOTHING IS COMMITTED. A certificate in the repo expires and reddens the suite on a date nobody
 * chose, in a commit that did not touch TLS.
 */
const trace = join(process.cwd(), 'packages/fixtures/traces/synthetic-ispf-like.trace');
let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; });

describe.skipIf(!haveOpenssl())('the gateway over TLS', () => {
  it('serves wss:// and completes a handshake against a pinned CA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tn3270-web-tls-'));
    const certs = generateCerts(dir);
    const args = parseWebArgs([
      '--replay', trace, '--listen', '0',
      '--tls-cert', certs.certPath, '--tls-key', certs.keyPath, '127.0.0.1:3270',
    ]);
    const { server, registry } = buildServer(args);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    stop = () => { registry.closeAll(); server.close(); };

    const key = randomBytes(16).toString('base64');
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: readFileSync(certs.certPath) });
    await new Promise<void>((r, j) => { socket.once('secureConnect', r); socket.once('error', j); });
    // `authorized` is the assertion that matters: "it connected" cannot tell a verified chain from
    // an ignored one, which is a distinction this project has been bitten by before.
    expect(socket.authorized).toBe(true);

    socket.write(
      `GET /ws?t=${args.token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n`
      + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );

    const head = await new Promise<string>((r) => {
      let buf = '';
      socket.on('data', function onData(d: Buffer) {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) { socket.off('data', onData); r(buf); }
      });
    });
    expect(head).toMatch(/^HTTP\/1\.1 101 /);
    const want = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    expect(head).toContain(`Sec-WebSocket-Accept: ${want}`);
    socket.destroy();
  });

  it('refuses --tls-cert without --tls-key at parse time', () => {
    expect(() => parseWebArgs(['--tls-cert', '/tmp/x', '127.0.0.1:3270'])).toThrow(/--tls-key/);
  });
});
```

**`generateCerts`'s real return shape must be checked** — read
`packages/cli/scripts/gen-test-certs.mjs` and use whatever property names it actually returns
instead of `certPath`/`keyPath` if they differ. Also confirm importing a `.mjs` from a vitest test
in another package works here; if it does not, copy the two-line `execFileSync` openssl invocation
rather than duplicating the whole script.

- [ ] **Step 2: Run it**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/web/test/tls.test.ts`
Expected: PASS, 2 tests (or skipped if `openssl` is absent — it is present on this box, version
3.5.6, so a skip means the guard is wrong).

- [ ] **Step 3: Commit**

```bash
cd ~/git/tn3270
git add packages/web/test/tls.test.ts
git commit -m "test(web): wss with a generated certificate, verified against a pinned CA

Asserts socket.authorized, not merely that it connected: those cannot be
distinguished by 'it worked', which has misled this project before. Node's
built-in WebSocket cannot be given a CA, so this speaks the handshake itself.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 12: `browser-keys.mjs` — a real browser, driven

**Files:**
- Create: `packages/web/scripts/browser-keys.mjs`, `packages/web/test/browser-harness-flags.test.ts`

- [ ] **Step 1: Write the harness**

`packages/web/scripts/browser-keys.mjs` starts the gateway on an ephemeral port with `--replay`,
then runs Electron pointed at `http://127.0.0.1:PORT/?t=TOKEN`, driving chords with the same
`TN3270_GUI_KEYS`-style mechanism the GUI harness uses. The server records every action it applies
and the harness asserts the ordered sequence.

Reuse rather than reinvent: import `guiEnv` from `../../gui/scripts/xvfb.mjs`, and copy the CASES
table shape from `packages/gui/scripts/keys.mjs`. The differences from the GUI harness are:

1. It must start the server itself and tear it down in a `finally`, so a failed run leaves no
   listener behind.
2. Electron loads a URL, not a file, so `main.js` needs a way to load one. Add
   `TN3270_GUI_URL` to `packages/gui/src/main.ts` — when set, `loadURL` that instead of
   `loadFile(index.html)`, and skip creating a `Session` entirely, because the page's own bridge
   owns the protocol in this mode. Document it as a fourth test seam with the same reasoning as
   the others.
3. The observable is the SERVER's action log, not Electron's. Have the server print
   `action: {json}` when `--log-actions` is passed, gated exactly as the GUI's log is gated on
   replay mode — a live gateway must never log keystrokes, for the same
   password-on-stdout reason.

Cases: `Alt+1`→`pa 1`, `Alt+2`→`pa 2`, `Ctrl+A`→`attn`, `Ctrl+C`→`clear`, `Shift+Tab`→`backTab`,
`Tab`→`tab`, `F1`→`pf 1`, `Shift+F1`→`pf 13`, `Insert`→`toggleInsert`, `Enter`→`enter`, plus the
two negatives `Ctrl+Z` and `F13` asserting NO action. `Ctrl+]` is excluded: here it would close the
socket, which is a different test.

- [ ] **Step 2: Run it**

Run: `cd ~/git/tn3270 && node packages/web/scripts/browser-keys.mjs`
Expected: `ok 12 chords, 10 actions in order`.

**If the page renders nothing**, check in this order, because each is a trap already recorded:
`bridge.js` loading before `renderer.js`; the queue in `bridgecore.ts` actually flushing; the
`deflate` pairing (`78 9c`); and whether `renderer.js` is being served from `packages/canvas/dist`.

- [ ] **Step 3: Pin the harness in `npm test`**

`packages/web/test/browser-harness-flags.test.ts` reads `browser-keys.mjs` as TEXT and pins:
`--no-sandbox` and `--disable-gpu` present; `--replay` used so it never touches a host;
`--log-actions` present; at least one `Alt+` chord and both negatives; the ordered comparison
(`Math.max(expected.length, actual.length)`); a bail when no action line appears at all; and that
the server is torn down in a `finally`. Follow `packages/gui/test/keys-harness-flags.test.ts`
exactly — same register, a comment on each test saying what its absence would cost.

- [ ] **Step 4: Mutation-check both**

Unbind the Alt branch in `packages/canvas/src/keys.ts`, rebuild, and confirm
`browser-keys.mjs` goes RED. Revert with `git checkout` and rebuild. Then drop `--replay` from the
harness's argv and confirm the pin test FAILS. Restore. Report both, and confirm
`git status --porcelain` is clean afterwards.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270
git add packages/web/scripts/browser-keys.mjs packages/web/test/browser-harness-flags.test.ts packages/gui/src/main.ts
git commit -m "test(web): drive real chords at the served page from a real browser

Covers what no unit test can: the served bridge, the WebSocket hop, and the
renderer's own keydown listener. Its failure was observed by unbinding the Alt
branch in canvas.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 13: `browser-shot.mjs` — prove the reuse claim in pixels

**Files:**
- Create: `packages/web/scripts/browser-shot.mjs`

- [ ] **Step 1: Write the harness**

Serve the same `synthetic-ispf-like.trace` through the gateway, load the page in Electron at a
content size equal to the draw list's `width`×`height`, capture, and hash the RAW BITMAP exactly as
`packages/gui/scripts/shot.mjs` does. Compare against
`packages/gui/test/golden/synthetic-ispf.sha256`.

**Identical pixels are the expected result** — same renderer, same atlas, same scheme — and that is
what makes this the check that proves reuse rather than mere coexistence.

- [ ] **Step 2: Run it, and choose the fallback honestly if it does not match**

Run: `cd ~/git/tn3270 && node packages/web/scripts/browser-shot.mjs`

If the hashes differ, **do not add a pixel tolerance** — that is how a golden stops being evidence.
Diagnose in this order and report what you find: the window content size versus the draw list
dimensions; the integer scale `bestScale` chose; whether `-scheme` matches the GUI golden's
(`default`); and device pixel ratio. If it cannot be made identical for a reason you can NAME, fall
back to the documented method — **compare rendered INK ROW BY ROW against what the CLI reports for
the same trace**, which is how the GUI was verified in the first place — and record why pixel
identity was unreachable.

- [ ] **Step 3: Commit**

```bash
cd ~/git/tn3270
git add packages/web/scripts/browser-shot.mjs
git commit -m "test(web): compare the served page's pixels against the GUI golden

Same renderer and same atlas, so identical pixels are the expected result and
this is the check that proves the canvas extraction shares code rather than
merely coexisting with it.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 14: live verification against both Hercules systems

Both are UP and were verified reachable this session: **VM/370 on `127.0.0.1:3270`** and
**MVS 3.8j TK5 on `127.0.0.1:3271`**.

- [ ] **Step 1: VM/370, model 4, no logon**

```bash
cd ~/git/tn3270
node packages/web/dist/main.js -model 3278-4-E --listen 8270 127.0.0.1:3270 &
```
Note the printed URL with its token. Load it in Electron under Xvfb, capture, and compare the
rendered ink ROW BY ROW against what the CLI reports for the same host:

```bash
printf 'Connect(127.0.0.1:3270)\nWait(3270Mode)\nWait(Settle)\nScreenText()\nDisconnect()\nQuit()\n' \
  | node packages/cli/dist/main.js -insecure -model 3278-4-E
```
Expected: the gateway shows the same VM/370 logo screen the CLI reports. **Do not log on.** A
logged-on VM session left running makes the next `LOGON` reconnect past the IPL and land at
`CP READ`, which has produced three false failures here. Record the row-by-row result.

- [ ] **Step 2: MVS TK5, and the resize**

Repeat against `127.0.0.1:3271`. With `-model 3278-4-E` the session starts 24×80 and TSO resizes it
to 43 rows once logged on; without a logon it should show the TSO logon panel. Confirm the page
resizes rather than clipping — the GUI's first live run CLIPPED 16px and lost the whole OIA row, so
this is a known failure mode and worth checking explicitly.

- [ ] **Step 3: Two tabs, two sessions**

Open the URL twice and confirm two independent sessions with two Hercules devices. Per the
measured device-selection behaviour, one may land on a device the host is not driving and show
**0 fields** — that is the host's logon process painting one device, not a client defect. Record
which happened rather than treating it as a bug.

- [ ] **Step 4: Reattach, live**

With a live VM session showing, kill the browser page, wait 30 seconds, reload with the same
`sessionStorage` (same tab, reload — not a new tab), and confirm the SAME screen returns rather
than a fresh connection. Then wait past the grace window and confirm a new session starts. This is
the one success criterion no unit test covers, because it depends on a real host holding the
connection open.

- [ ] **Step 5: Record it all in `docs/live-testing.md`**

A new section, *The web gateway against both hosts*, with the row-by-row comparison result, the
resize result, the two-tab result, the reattach timings, and anything that surprised you. Follow
the file's convention: the measurement, then what it means for someone changing this code.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270
git add docs/live-testing.md
git commit -m "docs(live): the web gateway against VM/370 and MVS TK5

Row-by-row ink comparison against what the CLI reports, the model-4 resize, two
tabs on two devices, and reattachment after a real 30-second interruption.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 15: documentation, whole-branch verification, merge

- [ ] **Step 1: Write the docs**

- `packages/web/README.md`: what it is, the invocation, every flag, and — prominently — that
  without `--tls-cert` keystrokes cross the network in the clear, that `--auth off` means anything
  reaching the port can type at the mainframe, and that the default bind is loopback.
- Root `README.md`: add the web gateway beside the three existing front ends, with its
  invocation and the updated test count. Note that there are now FOUR front ends.
- `docs/HANDOFF.md`: update *Where things stand* — the new package graph
  (`core ← canvas ← { gui, web }`), the new counts, and that `browser-keys.mjs` and
  `browser-shot.mjs` are by-hand harnesses like `shot.mjs`, `keys.mjs` and `pty-smoke.py`.

- [ ] **Step 2: Verify everything**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -6
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
node packages/web/scripts/browser-keys.mjs
node packages/web/scripts/browser-shot.mjs
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
```
Expected: build and typecheck clean; all tests green; `2/2 goldens matched`;
`ok 15 chords, 13 actions in order`; the web harnesses passing; `pty-smoke.py` 12/12.

**Reconcile the test count before merging rather than editing a number into the docs.** The
expected total is 1352 plus the new files: `args` 10, `wsframe` 12, `handshake` 11, `protocol` 9,
`sessions` 10, `wsserver` 8, `httpstatic` 10, `bridgecore` 8, `integration` 5, `tls` 2,
`browser-harness-flags` 8 — **1445 in 66 files**. If the real number differs, find out why.

- [ ] **Step 3: Read the whole diff**

Run: `cd ~/git/tn3270 && git diff main...HEAD`
Look for: a mutation left behind in `packages/canvas/src/keys.ts` or `renderer.ts`; a stray
`console.log`; an action log that is not gated; and any host-side TLS flag that drifted into
`--tls-*` or vice versa.

- [ ] **Step 4: Merge and push**

```bash
cd ~/git/tn3270
git checkout main
git merge --no-ff web-gateway -m "Merge web-gateway: the same canvas, served to a browser

renderer.ts is reused UNMODIFIED: it already talked to a four-function bridge
and imported only relative modules, so a served bridge.js over a WebSocket
replaces preload.cts over IPC. The canvas layer moved to packages/canvas, which
both front ends now share.

Frames are deflated: a 24x80 draw list is 237220 bytes of JSON and 6760
compressed, which is why full frames are acceptable and dirty-cell diffing is
not in this design.

Loopback by default, a token by default, a mismatched Origin refused, and
wss:// in-process so a terminating proxy is optional rather than required.

Generated with AI

Co-Authored-By: SLAC AI"
git push origin main
git branch -d web-gateway
```

---

## Self-review notes

Spec coverage, section by section:

| spec item | task |
| --- | --- |
| `packages/canvas` extraction, renderer unchanged | 1 |
| Gateway package, flags, auth-on-by-default, loopback default | 2 |
| Hand-rolled framing behind a seam | 3, 7 |
| Upgrade, token, Origin rule | 4 |
| Messages, compression, `quit` refusal | 5 |
| Session lifecycle, grace, cap, multiple tabs | 6 |
| Static table, cookie, page load order | 8 |
| Bridge, the queueing race, `quit` interception | 9 |
| Wiring, `--replay` seam, independent-oracle integration test | 10 |
| In-server TLS | 11 |
| Real-browser chord guard | 12 |
| Pixel proof against the GUI golden | 13 |
| Live verification, reattachment | 14 |
| Docs, verification, merge | 15 |

Names used consistently: `parseWebArgs`, `WebArgs`, `UsageError`, `parseFrame`, `serializeFrame`,
`OPCODE`, `Frame`, `acceptKey`, `checkUpgrade`, `UpgradeRequest`, `UpgradeResult`,
`encodeServerMessage`, `decodeClientMessage`, `ServerMessage`, `ClientMessage`, `SessionRegistry`,
`SessionHandle`, `RegistryOptions`, `AttachResult`, `Connection`, `resolveAsset`, `tokenCookie`,
`parseCookies`, `Asset`, `createBridge`, `BridgeDeps`, `BridgeApi`, `buildServer`, `run`,
`assetDir`, `readAtlas`, `BROWSER_MODULES`.

Three places deliberately tell the implementer to CHECK a shape rather than trust this plan, because
they are written from memory of another module's interface: `takeTlsFlag`'s signature (Task 2),
`Session.disconnect`/`resolveScheme`/`defaultSession` (Task 10), and `generateCerts`'s return shape
(Task 11). Ten defects in the last plan were found exactly this way.
