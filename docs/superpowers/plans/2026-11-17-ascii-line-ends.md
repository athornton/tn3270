# Ascii Line Ends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Mode=ascii` `IND$FILE` transfers convert line ends locally exactly as x3270 does: strip
every CR and `^Z` on a receive, put a CR before each bare LF on a send, unless `Cr=keep`.

**Architecture:** A pure module `packages/frontend/src/lineEnds.ts` holds the rule
(`convertsLineEnds`), the two byte transforms (`fromHost`, `toHost`) and a `TransferFiles` wrapper
(`withLineEnds`) that applies them on `read` / `write` / `append`. `startTransfer`
(`packages/frontend/src/transferRun.ts`) wraps its `files` once when the request converts, so both
engines and every front end get it with no other edit. `transfer.ts`'s `wantsCrlf` (the command's
`CRLF` option) delegates to `convertsLineEnds`, so the command and the bytes cannot disagree.

**Tech Stack:** TypeScript 7, vitest 3, npm workspaces; the live witness uses
`packages/gui/scripts/live-transfer.py` against the user's Hercules VM/370 (CUT) and TK5 (DFT).

Spec: `docs/superpowers/specs/2026-11-17-ascii-line-ends-design.md`.

## READ THIS FIRST (every task)

- **The source beats this plan.** Re-read every file a task names before editing it; where the
  code disagrees with this plan, follow the code and say so in your report.
- **Run the build before believing a suite:** `npm run typecheck` after `npx vitest run`.
- Branch `ascii-line-ends` (already created off `main`, with the spec committed). Don't push.
- Commit messages end with a blank line, then:
  ```
  Generated with AI

  Co-Authored-By: SLAC AI
  ```
- The user's shell shadows `grep`/`find` with ugrep/bfs functions; use `command grep`. Run npm/npx
  from `~/git/tn3270` only.

## File structure

| File | Responsibility |
|---|---|
| `packages/frontend/src/lineEnds.ts` (new) | the rule, the two transforms, the `TransferFiles` wrapper |
| `packages/frontend/test/lineEnds.test.ts` (new) | unit tests of all four |
| `packages/frontend/src/transfer.ts` | `wantsCrlf` delegates to `convertsLineEnds` |
| `packages/frontend/src/transferRun.ts` | wraps `files` once |
| `packages/frontend/src/index.ts` | exports the new module's public names |
| `packages/tui/test/transferRun.test.ts` | end-to-end DFT receive and send through `startTransfer` |
| `packages/gui/scripts/live-transfer.py` | an ascii round-trip mode |
| `README.md`, `changelog.d/`, `docs/live-testing.md`, `docs/parity/checklist.yaml` | docs |

---

### Task 0: Record the wiring refinement in the spec

**Files:** Modify `docs/superpowers/specs/2026-11-17-ascii-line-ends-design.md`

- [ ] **Step 1:** Append:

```markdown
## Amendment 2026-11-17, while planning

**The wiring wraps `TransferFiles` once instead of converting at each read and write site.**
`withLineEnds(files)` returns a `TransferFiles` whose `read` applies `toHost` and whose `write` and
`append` apply `fromHost`; `startTransfer` uses it in place of `files` when `convertsLineEnds`
holds. Same behaviour as the design above, one wiring point instead of three, and CUT and DFT
cannot diverge because they write through the same object. `wantsCrlf` delegates to
`convertsLineEnds`, which replaces the planned agreement test with a single definition.
```

- [ ] **Step 2: Commit** `spec: ascii line ends -- wrap TransferFiles once` + attribution.

---

### Task 1: The pure module

**Files:**
- Create: `packages/frontend/src/lineEnds.ts`, `packages/frontend/test/lineEnds.test.ts`
- Modify: `packages/frontend/src/transfer.ts` (`wantsCrlf`, ~:294), `packages/frontend/src/index.ts`

- [ ] **Step 1: Write the failing tests** (`packages/frontend/test/lineEnds.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  convertsLineEnds, fromHost, toHost, withLineEnds, transferCommand,
  type TransferFiles, type TransferRequest,
} from '../src/index.js';

const req = (mode: 'ascii' | 'binary', cr: 'auto' | 'remove' | 'add' | 'keep'): TransferRequest => ({
  direction: 'receive', localFile: '/l', hostFile: 'A B A', host: 'vm', mode, cr, exist: 'replace',
});
const b = (...xs: number[]) => Uint8Array.from(xs);

describe('convertsLineEnds: x3270 cr_flag (Common/ft.c:322, :941-951)', () => {
  it('converts in ascii mode for auto, remove and add -- the names are not directional', () => {
    for (const cr of ['auto', 'remove', 'add'] as const) expect(convertsLineEnds(req('ascii', cr)), cr).toBe(true);
  });
  it('never converts for keep, nor in binary mode', () => {
    expect(convertsLineEnds(req('ascii', 'keep'))).toBe(false);
    for (const cr of ['auto', 'remove', 'add', 'keep'] as const) expect(convertsLineEnds(req('binary', cr)), cr).toBe(false);
  });
  it('is exactly when the IND$FILE command carries CRLF, for both hosts and directions', () => {
    // The command's CRLF and the local conversion are ONE rule: a command that asks the host for
    // CRLF with no local conversion was the bug this module fixes.
    for (const host of ['vm', 'tso'] as const) for (const direction of ['send', 'receive'] as const)
      for (const mode of ['ascii', 'binary'] as const) for (const cr of ['auto', 'remove', 'add', 'keep'] as const) {
        if (mode === 'binary' && cr !== 'auto') continue; // the parser refuses Cr= without ascii
        const args = [direction, 'localfile=/l', host === 'vm' ? 'hostfile=A B A' : 'hostfile=A.B', `host=${host}`, `mode=${mode}`, `cr=${cr}`];
        const { request, command } = transferCommand(args);
        expect(/\bCRLF\b/.test(command), args.join(' ')).toBe(convertsLineEnds(request));
      }
  });
});

describe('fromHost: drop every CR and ^Z, wherever (ft_cut.c:190, ft_dft.c:301)', () => {
  it('turns CRLF line ends into LF and drops a trailing ^Z', () => {
    expect([...fromHost(b(0x41, 0x42, 0x0d, 0x0a, 0x43, 0x44, 0x0d, 0x0a, 0x1a))]).toEqual([0x41, 0x42, 0x0a, 0x43, 0x44, 0x0a]);
  });
  it('drops a CR or ^Z in mid-line too, as x3270 does, and a lone trailing CR', () => {
    expect([...fromHost(b(0x41, 0x0d, 0x42, 0x1a, 0x43, 0x0d))]).toEqual([0x41, 0x42, 0x43]);
  });
  it('leaves everything else, and empty input, alone', () => {
    expect([...fromHost(b(0x41, 0x0a, 0x09, 0x7f))]).toEqual([0x41, 0x0a, 0x09, 0x7f]);
    expect([...fromHost(b())]).toEqual([]);
  });
});

describe('toHost: CR before each LF not already after a CR (ft_cut.c:729, ft_dft.c:503)', () => {
  it('turns LF line ends into CRLF', () => {
    expect([...toHost(b(0x41, 0x0a, 0x42, 0x0a))]).toEqual([0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a]);
  });
  it('does not double an existing CRLF, and handles a leading LF and LF LF', () => {
    expect([...toHost(b(0x41, 0x0d, 0x0a))]).toEqual([0x41, 0x0d, 0x0a]);
    expect([...toHost(b(0x0a, 0x0a))]).toEqual([0x0d, 0x0a, 0x0d, 0x0a]);
  });
  it('leaves a lone CR, other bytes and empty input alone', () => {
    expect([...toHost(b(0x41, 0x0d, 0x42))]).toEqual([0x41, 0x0d, 0x42]);
    expect([...toHost(b())]).toEqual([]);
  });
});

describe('withLineEnds: the TransferFiles every engine reads and writes through', () => {
  const fake = () => {
    const m = new Map<string, Uint8Array>([['/src', b(0x41, 0x0a)]]);
    const files: TransferFiles = {
      exists: (p) => m.has(p), read: (p) => m.get(p)!,
      write: (p, x) => { m.set(p, x); },
      append: (p, x) => { const o = m.get(p) ?? b(); const n = new Uint8Array(o.length + x.length); n.set(o); n.set(x, o.length); m.set(p, n); },
    };
    return { m, files: withLineEnds(files) };
  };
  it('read applies toHost; write and append apply fromHost; exists passes through', () => {
    const { m, files } = fake();
    expect([...files.read('/src')]).toEqual([0x41, 0x0d, 0x0a]);
    files.write('/dst', b(0x42, 0x0d, 0x0a, 0x1a));
    expect([...m.get('/dst')!]).toEqual([0x42, 0x0a]);
    files.append('/dst', b(0x43, 0x0d, 0x0a));
    expect([...m.get('/dst')!]).toEqual([0x42, 0x0a, 0x43, 0x0a]);
    expect(files.exists('/dst')).toBe(true);
    expect(files.exists('/nope')).toBe(false);
  });
});
```

- [ ] **Step 2:** `npx vitest run packages/frontend/test/lineEnds.test.ts` — FAIL (the names are not
  exported). Check `transferCommand`'s real argument syntax in `transfer.ts` (`:440`, `:643`): if the
  keyword spelling differs (case, `=`, which keyword names the host file), fix the TEST to the
  parser's real syntax and say so.

- [ ] **Step 3: Implement** `packages/frontend/src/lineEnds.ts`

```ts
/**
 * Ascii line ends in IND$FILE transfers, converted locally exactly as x3270 does.
 *
 * ONE FLAG, AS x3270 HAS: `cr_flag` is true in ascii mode unless `Cr=keep` (Common/ft.c:322,
 * :941-951). THE NAMES ARE NOT DIRECTIONAL: `Cr=remove` on a send also adds CRs, and `Cr=add` on a
 * receive also strips them -- x3270 collapses the three to one boolean, and so does this.
 *
 * The same rule decides whether the IND$FILE command carries `CRLF` (`transfer.ts`, `wantsCrlf`,
 * which calls `convertsLineEnds`): CRLF tells the host the local side uses CRLF line ends, and this
 * module is what turns those into the local LF ones. Before it existed, every front end asked for
 * CRLF and converted nothing, so a received text file kept its CRs and a trailing ^Z.
 */
import type { TransferFiles, TransferRequest } from './transfer.js';

const CR = 0x0d;
const LF = 0x0a;
const SUB = 0x1a; // ^Z

/** Does this transfer convert line ends locally? x3270's `cr_flag`. */
export function convertsLineEnds(request: Pick<TransferRequest, 'mode' | 'cr'>): boolean {
  return request.mode === 'ascii' && request.cr !== 'keep';
}

/** Received bytes with every CR and ^Z removed, wherever they are (ft_cut.c:190, ft_dft.c:301). */
export function fromHost(bytes: Uint8Array): Uint8Array {
  return bytes.filter((c) => c !== CR && c !== SUB);
}

/** Bytes to send, with a CR before each LF that does not already follow one (ft_cut.c:729, ft_dft.c:503). */
export function toHost(bytes: Uint8Array): Uint8Array {
  let extra = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) extra++;
  if (extra === 0) return bytes;
  const out = new Uint8Array(bytes.length + extra);
  let o = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF && (i === 0 || bytes[i - 1] !== CR)) out[o++] = CR;
    out[o++] = bytes[i]!;
  }
  return out;
}

/**
 * `files` with the conversion applied: `read` (a send's source) through `toHost`, `write` and
 * `append` (a receive's result) through `fromHost`. `startTransfer` swaps this in once, so both
 * engines' reads and writes go through it and cannot diverge.
 */
export function withLineEnds(files: TransferFiles): TransferFiles {
  return {
    exists: (path) => files.exists(path),
    read: (path) => toHost(files.read(path)),
    write: (path, bytes) => { files.write(path, fromHost(bytes)); },
    append: (path, bytes) => { files.append(path, fromHost(bytes)); },
  };
}
```

In `transfer.ts`, replace the body of `wantsCrlf` with `return convertsLineEnds(req);` (keep its doc
comment and add one line: "The same rule converts the bytes locally: `lineEnds.ts`."), adding
`import { convertsLineEnds } from './lineEnds.js';`. In `index.ts`, export
`convertsLineEnds, fromHost, toHost, withLineEnds` from `./lineEnds.js`, beside the transfer exports.

- [ ] **Step 4:** Run the test file: PASS. `npx vitest run packages/frontend` and `npm run typecheck`:
  both clean (the existing transfer-command tests must still pass unchanged).
- [ ] **Step 5: Mutate** `fromHost` to keep `0x1a`, confirm a test fails; mutate `toHost` to drop the
  `bytes[i - 1] !== CR` guard, confirm a test fails; restore both. Report.
- [ ] **Step 6: Commit** `frontend: ascii line ends, converted as x3270 does (lineEnds.ts)` + attribution.

---

### Task 2: Wire it into `startTransfer`, proven over the wire

**Files:**
- Modify: `packages/frontend/src/transferRun.ts` (~:88-89)
- Test: `packages/tui/test/transferRun.test.ts` (the file's own fixtures: `connected`, `fakeFiles`,
  `wsfBytes`, `openPayload`, `dataInsert`, `wholeDftDownload`, `aReceive`, `aSend`)

- [ ] **Step 1: Write the failing tests** (append a `describe` to `packages/tui/test/transferRun.test.ts`)

```ts
describe('ascii line ends, end to end through startTransfer (x3270 cr_flag)', () => {
  const ascii = (r: TransferRequest, cr: TransferRequest['cr'] = 'auto'): TransferRequest => ({ ...r, mode: 'ascii', cr });

  async function receive(request: TransferRequest, payload: number[]): Promise<number[]> {
    const { session, conn } = await connected();
    const files = fakeFiles();
    let settle!: (r: { ok: boolean }) => void;
    const done = new Promise<{ ok: boolean }>((r) => { settle = r; });
    startTransfer({ session, files, request, command: 'IND$FILE GET A.TXT', onProgress: () => {}, onDone: settle });
    for (const record of wholeDftDownload(payload)) conn.host(...record);
    await expect(done).resolves.toMatchObject({ ok: true });
    return [...(files.files.get(request.localFile) ?? [])];
  }

  const CRLF_TEXT = [0x41, 0x0d, 0x0a, 0x42, 0x0d, 0x0a, 0x1a];

  it('a DFT ascii receive strips CR and ^Z, for Cr=auto, remove and add alike', async () => {
    for (const cr of ['auto', 'remove', 'add'] as const) {
      expect(await receive(ascii(aReceive('/tmp/t.txt'), cr), CRLF_TEXT), cr).toEqual([0x41, 0x0a, 0x42, 0x0a]);
    }
  });

  it('Cr=keep and binary mode write the bytes untouched', async () => {
    expect(await receive(ascii(aReceive('/tmp/k.txt'), 'keep'), CRLF_TEXT)).toEqual(CRLF_TEXT);
    expect(await receive(aReceive('/tmp/b.bin'), CRLF_TEXT)).toEqual(CRLF_TEXT);
  });

  it('a DFT ascii send puts a CR before each bare LF on the wire', async () => {
    const { session, conn } = await connected();
    const files = fakeFiles({ '/tmp/up.txt': Uint8Array.of(0x41, 0x0a, 0x42, 0x0a) });
    startTransfer({ session, files, request: ascii(aSend('/tmp/up.txt')), command: 'IND$FILE PUT A.TXT', onProgress: () => {}, onDone: () => {} });
    conn.host(...wsfBytes(openPayload()));
    conn.sent = [];
    conn.host(...wsfBytes([0x46, 0x11]));                 // DftRequest.GET (core/src/ft/dftFrames.ts)
    const hex = conn.sent.map((x) => x.toString(16).padStart(2, '0')).join(' ');
    expect(hex).toContain('41 0d 0a 42 0d 0a');
    // And the local file itself is untouched: the conversion is on the way out, not a rewrite.
    expect([...files.files.get('/tmp/up.txt')!]).toEqual([0x41, 0x0a, 0x42, 0x0a]);
  });
});
```

(Add `TransferRequest` to the test file's existing `@tn3270/frontend` type import if it is not
there already; it is, per `:8-10`.)

- [ ] **Step 2:** `npx vitest run packages/tui/test/transferRun.test.ts` — the receive tests FAIL with
  the CRs still present, and the send test FAILS (no `0d` before `0a`). **If the send test fails for
  a different reason** (no reply at all to the Get, i.e. this Open/Get sequence is not what an upload
  looks like), read `packages/core/test/dft.test.ts` `describe('DftTransfer, upload (send)'` and
  `core/src/ft/dft.ts` `onGet`, fix the fixture sequence to what an upload really is, and say so.

- [ ] **Step 3: Implement.** In `transferRun.ts`'s `startTransfer`, change

```ts
  const { session, files, request, command, onProgress, onDone } = opts;
```

to

```ts
  const { session, request, command, onProgress, onDone } = opts;
  // Ascii line ends, converted as x3270 does (lineEnds.ts): ONE wrap here, so a send's read and
  // both engines' receive writes all go through it and the CUT and DFT arms cannot diverge.
  const files = convertsLineEnds(request) ? withLineEnds(opts.files) : opts.files;
```

and add `import { convertsLineEnds, withLineEnds } from './lineEnds.js';`. Check that nothing else in
the function reads `opts.files` directly; if something does, route it through `files`.

- [ ] **Step 4:** The test file passes; `npx vitest run packages/frontend packages/tui packages/cli
  packages/gui packages/web` and `npm run typecheck` are clean (the web gateway and CLI transfer tests
  exercise `startTransfer` too and must not change).
- [ ] **Step 5: Mutate** the wrap away (`const files = opts.files;`) and confirm the new receive and
  send tests fail; restore. Report.
- [ ] **Step 6: Commit** `frontend: startTransfer converts ascii line ends for every front end` + attribution.

---

### Task 3: The live witness — an ascii round trip from the GUI

**Files:** Modify `packages/gui/scripts/live-transfer.py`; modify `docs/live-testing.md`.

The harness already logs on, sends a file up, receives it back to a different path and compares the
bytes (read its whole header first, including CREDENTIALS). Add an **ascii mode** so it sends an
LF-only text file with `Mode=ascii` and receives it back with `Mode=ascii`: the round trip must be
byte-identical, which it cannot be without both conversions (no CR goes up, so the host sees one
record; or the CRs come back down). On CMS, also check the host listing shows one record per line.

- [ ] **Step 1:** Read the harness (`packages/gui/scripts/live-transfer.py`) top to bottom, and its
  test `packages/gui/test/transfer-harness-flags.test.ts`, which pins its flags. Add `--ascii` (or the
  harness's own flag style): a deterministic multi-line LF-only text file (printable ASCII, 5-10
  lines, the last line LF-terminated), `Mode=ascii` in both transfer values (the `TN3270_GUI_TRANSFER`
  scenario syntax the harness already builds; check `main.ts`'s `SEAM.transfer` docstring for it),
  and a `cmp` of the round trip. Keep the binary mode as the default and unchanged. Extend the flags
  test for the new flag the way it pins the existing ones.
- [ ] **Step 2:** `npx vitest run packages/gui/test/transfer-harness-flags.test.ts` passes;
  `python3 -m py_compile packages/gui/scripts/live-transfer.py`.
- [ ] **Step 3: Run it live** (the hosts must be up: probe `127.0.0.1:3270` and `:3271` first, and
  STOP and report if either is closed; never start Hercules yourself). Build first (`npm run build`).
  Run `python3 packages/gui/scripts/live-transfer.py vm --ascii` (CUT) and `... tso --ascii` (DFT),
  then the binary defaults once each as a regression check. VM may need a retry if it shows only
  Hercules' banner (it is slow to free a terminal; see `docs/live-testing.md`, *The four keys and
  reconnect...*). **As a control**, check out `main`'s `transferRun.ts` into the working tree (a
  `git stash` of the wiring line is fine), rebuild, and run one ascii flow: it must FAIL the compare.
  Restore and rebuild.
- [ ] **Step 4:** Record a section in `docs/live-testing.md`, immediately before
  `## Step 1 — Confirm the host is reachable`, headed exactly
  `## Ascii transfers convert line ends, from the GUI against VM/370 and TK5 — 2026-11-17`: the
  method, each run's result (bytes, host listing), the control's failure, and the command lines.
  Never paste a screen or log that may contain the password.
- [ ] **Step 5: Commit** the harness, its test and the doc: `gui: live-transfer.py ascii round trip;
  live witness for ascii line ends` + attribution.

---

### Task 4: Docs

**Files:** `README.md`, `changelog.d/<new>.md`, `docs/parity/checklist.yaml`, `docs/parity.md`

- [ ] **Step 1: README**, *File transfer (IND$FILE)*: replace the paragraph headed
  "**`Mode=ascii` does no local line-end conversion yet.**" with one headed
  "**`Mode=ascii` converts line ends as x3270 does.**": a receive drops every CR and `^Z`; a send puts
  a CR before each bare LF; `Cr=keep` turns both off; **the `Cr` names are not directional**
  (`remove` also adds on a send, `add` also strips on a receive), because x3270 has one flag. Run
  `command grep -n "line-end\|CRLF\|Cr=" README.md` and fix any other sentence this makes stale.
- [ ] **Step 2: Changelog.** A fragment `changelog.d/20261117_200000_athornton_ascii_line_ends.md`
  under `### Bug fixes`: ascii transfers now convert line ends locally as x3270 does (a received
  text file gets LF line ends and no `^Z`; an LF file is sent with CRLF), in every front end.
- [ ] **Step 3: Parity row `file-transfer`.** Remove the line-end gap from its `gap` (keep the rest,
  re-reading the row whole); add `packages/frontend/src/lineEnds.ts` to `evidence.code` and
  `packages/frontend/test/lineEnds.test.ts` to `evidence.tests`; set `evidence.live` to the Task 3
  heading exactly. Then `node scripts/parity.mjs check` (exit 0) and `node scripts/parity.mjs render`.
- [ ] **Step 4: Whole-branch gate:** `npm run build && npm run typecheck && npx vitest run`; all pass
  (2 real-scriv tests may run or skip depending on the uv cache; report which).
- [ ] **Step 5: Commit** `docs: ascii line ends in the README, changelog and parity row` + attribution.
