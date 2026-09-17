# BIND-IMAGE, BIND and UNBIND Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Request the BIND-IMAGE function, parse BIND and UNBIND, honour BIND's geometry within x3270's limits, and gate 3270 data until bound — with a 5-second timeout that executes the retained frame rather than hanging.

**Architecture:** `parseBind` and `parseUnbind` are pure functions in `packages/core/src/bind.ts`, tested without a session. `Screen` gains one narrow mutator, `setSizes`, because `defaultSize`/`alternateSize` are `readonly` and BIND rewrites both. `Session` gains the gate: a retained pre-BIND record, a timer, and the geometry application. **No front end changes** — EWA already resizes mid-session and both renderers already follow it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, Node ≥ 20 with no runtime dependencies. Python 3 for the two harnesses.

---

## READ THIS BEFORE TASK 1

**THE SOURCE BEATS THIS PLAN.** Every previous plan in this repo contained defects the
implementers found — 46 on the keypad branch, 10 on the PA/chord branch, roughly 40 on the web
gateway, and **nearly all of them were in the plan rather than in the code**. If a citation here
disagrees with the file it cites, **the file is right**: say so in your report rather than making
the code match this document. Line numbers especially rot.

**Spec:** `docs/superpowers/specs/2026-09-17-bind-image-and-bind-unbind-design.md`. Read it. It
records six decisions the user made explicitly, and reversing one because it looks wrong in
isolation would be a real defect.

**Baseline, measured on `bind-image` at `40e9a58`:** `npm run build` clean, `npm run typecheck`
clean, **1733 tests in 71 files** passing.

**Two workflow facts that will cost you a confusing hour otherwise:**

1. **`npm run build` MUST precede `vitest`** when you have changed anything in `packages/core`.
   Downstream packages resolve to built `dist/index.js`, not to source. Testing before rebuilding
   once failed 22 tests in a way that looked like a broken refactor.
2. **`vitest` does NOT typecheck.** A green suite over a failing `npm run build` has happened here
   (15 tests). Run **both**, every task.

**Mutation-check every test that claims to pin a constant or a boundary.** Break the code
deliberately, watch the test fail, put it back. Fourteen tests on the keypad branch passed while
proving nothing. If a test cannot be made to fail, it is not a test.

**A naming trap, before it bites:** `Tn3270eFunc.BIND_IMAGE` is **`0x00`** (a negotiable
function) and `Tn3270eDataType.BIND_IMAGE` is **`0x03`** (a data type). Both exist in
`constants.ts`, both are correct, and they are not interchangeable. `UNBIND` is a data type only
(`0x04`), gated on the BIND-IMAGE *function*.

---

## File Structure

**Create:**
- `packages/core/src/bind.ts` — `parseBind`, `parseUnbind`, `BindImage`, `UnbindReason`,
  `maxRu`, `BIND_*` offset constants, `NO_BIND_TIMEOUT_MS`. Pure; imports only `constants.js`
  and `codepage.js`.
- `packages/core/test/bind.ts` → **`packages/core/test/bind.test.ts`** — unit tests for the above.

**Modify:**
- `packages/core/src/constants.ts` — `Tn3270eUnbindReason` table (new).
- `packages/core/src/tn3270e.ts:109` — `REQUESTED_FUNCTIONS` gains BIND-IMAGE; the comment at
  `:95-107` is replaced by the measurement that retired the hazard.
- `packages/core/src/screen.ts:125-128` — `defaultSize`/`alternateSize` stop being `readonly`;
  add `setSizes`.
- `packages/core/src/session.ts:395` (`handleRecord`) — the gate, the timer, geometry application.
- `packages/core/src/index.ts` — export `./bind.js`.
- `packages/cli/src/main.ts:53`, `packages/gui/src/args.ts:59`, `packages/tui/src/main.ts:81`,
  `packages/web/src/args.ts:152` — `-bind-image` and `-bind-limit`.
- `packages/frontend/src/session.ts:25` — pass the two new options through `defaultSession`.
- `packages/core/test/tn3270e.test.ts:219,231,640` — the three tests that pin the old function list.
- `packages/cli/scripts/drive-e.py` — two new cases.
- `packages/cli/scripts/drive-playback.py` — assert the new blocks that BIND-IMAGE unblocks.
- `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md` — docs.

**Why `bind.ts` and not `tn3270e.ts`:** the spec allows either, with a threshold. `session.ts` is
**896 lines, the largest module in core**, and the parsing plus the reason table plus the offsets
comfortably exceed the 60-line threshold the spec set. So `bind.ts` from the start.

---

## Task 1: The UNBIND reason table

**Files:**
- Modify: `packages/core/src/constants.ts` (append near `Tn3270eReason`, around `:77-87`)
- Test: `packages/core/test/bind.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/bind.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Tn3270eUnbindReason } from '../src/constants.js';

/**
 * Values are x3270's include/tn3270e.h:108-118, read from the source rather than
 * from RFC 2355 -- the RFC lists fewer, and the wire is the authority here.
 *
 * NOTE THE GAPS: there is no 0x03-0x06, and no 0x0d. They are not omissions to be
 * "fixed" by interpolating: x3270 has no name for them either, and an unknown reason
 * is handled as unknown rather than guessed at.
 */
describe('UNBIND reason codes', () => {
  it('has the values x3270 defines, gaps included', () => {
    expect(Tn3270eUnbindReason.NORMAL).toBe(0x01);
    expect(Tn3270eUnbindReason.BIND_FORTHCOMING).toBe(0x02);
    expect(Tn3270eUnbindReason.VR_INOPERATIVE).toBe(0x07);
    expect(Tn3270eUnbindReason.RX_INOPERATIVE).toBe(0x08);
    expect(Tn3270eUnbindReason.HRESET).toBe(0x09);
    expect(Tn3270eUnbindReason.SSCP_GONE).toBe(0x0a);
    expect(Tn3270eUnbindReason.VR_DEACTIVATED).toBe(0x0b);
    expect(Tn3270eUnbindReason.LU_FAILURE_PERM).toBe(0x0c);
    expect(Tn3270eUnbindReason.LU_FAILURE_TEMP).toBe(0x0e);
    expect(Tn3270eUnbindReason.CLEANUP).toBe(0x0f);
    expect(Tn3270eUnbindReason.BAD_SENSE).toBe(0xfe);
  });

  it('does not collide NORMAL with the 0x00 that means "no reason byte"', () => {
    // A zero-length UNBIND body has no reason at all, and parseUnbind reports
    // undefined for it. If NORMAL were 0x00 the two would be indistinguishable.
    expect(Tn3270eUnbindReason.NORMAL).not.toBe(0x00);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/bind.test.ts
```

Expected: FAIL — `Tn3270eUnbindReason` is not exported from `constants.js`.

- [ ] **Step 3: Add the table**

Append to `packages/core/src/constants.ts`, after the `Tn3270eReason` block (which ends about
`:87`):

```typescript
/**
 * UNBIND reason codes (x3270's include/tn3270e.h:108-118).
 *
 * RFC 2355 does not enumerate these; x3270 decodes them in `unbind_reason`
 * (Common/telnet.c:2592) and the wire is the authority. THE GAPS ARE REAL — there is
 * no 0x03-0x06 and no 0x0d, and x3270 names none of them either. An unrecognised
 * reason is reported as unknown rather than guessed at.
 *
 * BIND_FORTHCOMING IS THE OPERATIONALLY INTERESTING ONE: it means another BIND is
 * coming, which is how a host hands a session between applications. A client that
 * treated it as a teardown would drop a session the host intended to keep.
 *
 * NORMAL is 0x01, NOT 0x00, and that matters: a zero-length UNBIND body carries no
 * reason at all, so 0x00 must stay available to mean "absent".
 */
export const Tn3270eUnbindReason = {
  NORMAL: 0x01,
  BIND_FORTHCOMING: 0x02,
  VR_INOPERATIVE: 0x07,
  RX_INOPERATIVE: 0x08,
  HRESET: 0x09,
  SSCP_GONE: 0x0a,
  VR_DEACTIVATED: 0x0b,
  LU_FAILURE_PERM: 0x0c,
  LU_FAILURE_TEMP: 0x0e,
  CLEANUP: 0x0f,
  BAD_SENSE: 0xfe,
} as const;
```

- [ ] **Step 4: Build, then run the test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/bind.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check**

Change `NORMAL: 0x01` to `0x00` in `constants.ts`, rebuild, re-run. **Both** tests must fail —
the second is the one that would otherwise be decorative. Put it back, rebuild, confirm green.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/constants.ts packages/core/test/bind.test.ts
git commit -m "feat(core): UNBIND reason codes, gaps and all

From x3270's include/tn3270e.h:108-118 rather than RFC 2355, which does not
enumerate them. The gaps at 0x03-0x06 and 0x0d are real and deliberate.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: `maxRu` and the BIND offsets

**Files:**
- Create: `packages/core/src/bind.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/bind.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/bind.test.ts` (and add `maxRu`, `BIND_RU`, `BIND_OFF` to the
imports from `../src/bind.js`):

```typescript
import { maxRu, BIND_RU, BIND_OFF } from '../src/bind.js';

/**
 * x3270's maxru(), Common/telnet.c:2440-2446:
 *
 *   if (!(c & 0x80)) return 0;
 *   return ((c >> 4) & 0x0f) * (1 << (c & 0xf));
 *
 * It is a MANTISSA-EXPONENT encoding, not a plain integer, and the high bit is a
 * validity flag rather than part of either field.
 */
describe('maxRu', () => {
  it('is zero when the high bit is clear, whatever the rest says', () => {
    expect(maxRu(0x00)).toBe(0);
    expect(maxRu(0x7f)).toBe(0);
    // 0x79 would decode to 7 * 512 with the flag set; without it, zero.
    expect(maxRu(0x79)).toBe(0);
  });

  it('decodes the two values in the real BIND from devname_success.trc', () => {
    // The trace's own annotation reads: MaxSec-RU 1024 MaxPri-RU 3840.
    // Bytes 10 and 11 of that BIND are 0x87 and 0xf8.
    expect(maxRu(0x87)).toBe(1024);   // (8 & 0x0f) * (1 << 7) = 8 * 128
    expect(maxRu(0xf8)).toBe(3840);   // (15 & 0x0f) * (1 << 8) = 15 * 256
  });

  it('decodes the largest legal byte', () => {
    // 0xff: mantissa 15, exponent 15 -> 15 * 32768 = 491520. Large, and legal.
    //
    // THIS DOES NOT TEST THE `& 0x0f` MASK, and deliberately makes no claim to.
    // See the note below Step 5: that mask is unfalsifiable.
    expect(maxRu(0xff)).toBe(491520);
  });
});

describe('BIND offsets', () => {
  it('are x3270 s, from include/3270ds.h:433-443', () => {
    expect(BIND_RU).toBe(0x31);
    expect(BIND_OFF.MAXRU_SEC).toBe(10);
    expect(BIND_OFF.MAXRU_PRI).toBe(11);
    expect(BIND_OFF.RD).toBe(20);
    expect(BIND_OFF.CD).toBe(21);
    expect(BIND_OFF.RA).toBe(22);
    expect(BIND_OFF.CA).toBe(23);
    expect(BIND_OFF.SSIZE).toBe(24);
    expect(BIND_OFF.PLU_NAME_LEN).toBe(27);
    expect(BIND_OFF.PLU_NAME).toBe(28);
    expect(BIND_OFF.PLU_NAME_MAX).toBe(8);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/bind.test.ts
```

Expected: FAIL — cannot resolve `../src/bind.js`.

- [ ] **Step 3: Create `bind.ts` with just these**

```typescript
/**
 * BIND and UNBIND: the SNA session-management RUs a TN3270E host forwards as data
 * types BIND-IMAGE (0x03) and UNBIND (0x04).
 *
 * PURE. No session state, no I/O, no timers -- the caller owns all of that, exactly
 * as `tn3270e.ts` owns the negotiation state machine without owning a socket. That is
 * what lets every offset and every boundary below be tested against a byte array.
 *
 * BIND IS THE SECOND CHANNEL BY WHICH A HOST DICTATES GEOMETRY, the other being Query
 * Reply. That is the whole reason it matters here and not merely as trace decoration.
 */
import { MODEL_2 } from './constants.js';

/** A BIND request unit begins with this. Anything else is not a BIND. */
export const BIND_RU = 0x31;

/**
 * Byte offsets within the BIND RU, from x3270's include/3270ds.h:433-443.
 *
 * `PLU_NAME_MAX` is a LENGTH CAP, not an offset, and lives here because x3270 keeps it
 * in the same block; a host may declare a longer name and x3270 truncates rather than
 * refusing.
 */
export const BIND_OFF = {
  MAXRU_SEC: 10,
  MAXRU_PRI: 11,
  RD: 20,
  CD: 21,
  RA: 22,
  CA: 23,
  SSIZE: 24,
  PLU_NAME_LEN: 27,
  PLU_NAME: 28,
  PLU_NAME_MAX: 8,
} as const;

/**
 * Decode a maximum-RU byte (x3270's `maxru`, Common/telnet.c:2440-2446).
 *
 * MANTISSA-EXPONENT, not an integer: the high bit is a validity flag, bits 4-6 are a
 * mantissa and bits 0-3 an exponent, giving `mantissa * 2^exponent`. A byte with the
 * high bit clear means "not specified" and decodes to 0 -- which is why this returns a
 * number rather than throwing on it.
 *
 * The `& 0x0f` on the shifted mantissa is not redundant: it drops the validity bit
 * that `>> 4` would otherwise leave in place.
 */
export function maxRu(c: number): number {
  if (!(c & 0x80)) return 0;
  return ((c >> 4) & 0x0f) * (1 << (c & 0x0f));
}
```

Add to `packages/core/src/index.ts`, after the `./screen.js` line:

```typescript
export * from './bind.js';
```

- [ ] **Step 4: Build and test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/bind.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: The `& 0x0f` mask is UNFALSIFIABLE — measured, so do not go looking for a test**

I checked this before writing the task, over all six interesting bytes and reasoning about the
rest: **`(c >> 4)` on a byte is always ≤ 15 already, so `& 0x0f` cannot change the result for any
of the 256 possible inputs.** Masked and unmasked agree everywhere.

```
0x87 masked 1024   unmasked 1024   SAME
0xf8 masked 3840   unmasked 3840   SAME
0xff masked 491520 unmasked 491520 SAME
```

**So do NOT write a test claiming to pin it, and do not mutate it expecting red.** Keep the mask,
because it mirrors x3270 character for character and a reader comparing the two sources should
find them identical — but keep it as **transcription fidelity, not as a checked behaviour**, and
say so in a comment. This is the same shape as `encodeHeader`'s `& 0xff`, which this project
already found to be intent-only because `Uint8Array.of` truncates mod 256 regardless.

Mutation-check the **validity flag** instead, which is real: change `if (!(c & 0x80)) return 0;`
to `if (false) return 0;`, rebuild, re-run. All three high-bit-clear cases must fail. Restore.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/bind.ts packages/core/src/index.ts packages/core/test/bind.test.ts
git commit -m "feat(core): BIND offsets and the mantissa-exponent maxRu decode

Offsets from x3270's include/3270ds.h:433-443. maxRu is telnet.c:2440 -- a
validity flag plus mantissa and exponent, not an integer, and the two values in
devname_success.trc (1024 and 3840) pin it against a real host's bytes.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: `parseBind` — the size codes

**Files:**
- Modify: `packages/core/src/bind.ts`
- Test: `packages/core/test/bind.test.ts`

**The size-code table, from `Common/telnet.c:2485-2521`:**

| code | default | alternate |
|---|---|---|
| `0x00`, `0x02` | 24x80 | 24x80 |
| `0x03` | 24x80 | **the caller's own** |
| `0x7e` | bytes 20-21 | **bytes 20-21 again** |
| `0x7f` | bytes 20-21 | bytes 22-23 |
| other | absent | absent |

`0x03`'s alternate is x3270's `maxROWS`/`maxCOLS` — the client's configured model. A pure
function cannot know that, so `parseBind` reports `alternate: 'caller'` and the caller
substitutes. **Do not resolve it inside `parseBind` by importing a default**: that would silently
make every `0x03` BIND a model 2.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/bind.test.ts`, adding `parseBind` and `type BindImage` to the
`../src/bind.js` imports:

```typescript
/** The real BIND from x3270's s3270/Test/devname_success.trc, bytes after the header. */
const REAL_BIND = Uint8Array.from([
  0x31, 0x01, 0x03, 0x03, 0xb1, 0x90, 0x30, 0x80, 0x00, 0x87,
  0x87, 0xf8, 0x87, 0x00, 0x02, 0x80, 0x00, 0x00, 0x00, 0x00,
  0x18, 0x50, 0x2b, 0x50, 0x7f, 0x00, 0x00, 0x08, 0xc9, 0xc2,
  0xd4, 0xf0, 0xe2, 0xd4, 0xc1, 0xd1, 0x00, 0x05, 0x00, 0x7e,
  0xec, 0x0b, 0x10, 0x08, 0xc9, 0xc2, 0xd4, 0xf0, 0xe3, 0xc5,
  0xe2, 0xd8,
]);

describe('parseBind — the real host BIND', () => {
  it('decodes devname_success.trc exactly as x3270 annotated it', () => {
    // x3270's own decode of these bytes, from the trace at line 133:
    //   < BIND PLU-name 'IBM0SMAJ' MaxSec-RU 1024 MaxPri-RU 3840
    //     Rows-Cols Default 24x80 Alternate 43x80
    //
    // THIS IS THE POINT OF THE WHOLE TASK: a host-free witness from a real host,
    // which BIND has never had. Not one byte of this is our invention.
    const b = parseBind(REAL_BIND);
    expect(b).not.toBeNull();
    expect(b!.pluName).toBe('IBM0SMAJ');
    expect(b!.maxRuSecondary).toBe(1024);
    expect(b!.maxRuPrimary).toBe(3840);
    expect(b!.sizeCode).toBe(0x7f);
    expect(b!.dims).toEqual({
      defaultRows: 24, defaultCols: 80,
      alternate: { rows: 43, cols: 80 },
    });
  });
});

describe('parseBind — size codes', () => {
  /** A BIND long enough to reach every offset, with the size code and dims settable. */
  const bindWith = (ssize: number, rd = 0, cd = 0, ra = 0, ca = 0): Uint8Array => {
    const b = new Uint8Array(28);
    b[0] = BIND_RU;
    b[BIND_OFF.RD] = rd; b[BIND_OFF.CD] = cd;
    b[BIND_OFF.RA] = ra; b[BIND_OFF.CA] = ca;
    b[BIND_OFF.SSIZE] = ssize;
    return b;
  };

  it('0x00 and 0x02 both mean model 2 for both sizes', () => {
    for (const code of [0x00, 0x02]) {
      const b = parseBind(bindWith(code, 43, 80, 43, 80))!;
      // The dims bytes are DELIBERATELY set to 43x80 and must be IGNORED: these two
      // codes mean model 2 regardless of what bytes 20-23 happen to hold.
      expect(b.dims).toEqual({
        defaultRows: 24, defaultCols: 80, alternate: { rows: 24, cols: 80 },
      });
    }
  });

  it('0x03 means model-2 default and defers the alternate to the caller', () => {
    const b = parseBind(bindWith(0x03, 43, 80, 43, 80))!;
    expect(b.dims).toEqual({
      defaultRows: 24, defaultCols: 80, alternate: 'caller',
    });
  });

  it('0x7e uses ONE pair for both sizes', () => {
    // The alternate bytes are set to something different and must be ignored:
    // 0x7e duplicates the default pair, it does not read 22-23.
    const b = parseBind(bindWith(0x7e, 32, 80, 43, 132))!;
    expect(b.dims).toEqual({
      defaultRows: 32, defaultCols: 80, alternate: { rows: 32, cols: 80 },
    });
  });

  it('0x7f uses both pairs', () => {
    const b = parseBind(bindWith(0x7f, 24, 80, 43, 80))!;
    expect(b.dims).toEqual({
      defaultRows: 24, defaultCols: 80, alternate: { rows: 43, cols: 80 },
    });
  });

  it('reports no dimensions for an unrecognised size code', () => {
    const b = parseBind(bindWith(0x55, 43, 80, 43, 80))!;
    expect(b.dims).toBeUndefined();
    // Still a valid BIND: the PLU name and RU sizes are unaffected.
    expect(b.sizeCode).toBe(0x55);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/bind.test.ts
```

Expected: FAIL — `parseBind` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/bind.ts`:

```typescript
/**
 * Geometry a BIND asked for.
 *
 * `alternate: 'caller'` is size code 0x03, which means "model-2 default, and the
 * CLIENT's own alternate". A pure function cannot know the client's model, and
 * resolving it here by importing a default would silently turn every 0x03 BIND into a
 * model 2 -- so the caller substitutes and the type makes forgetting impossible.
 */
export interface BindDims {
  readonly defaultRows: number;
  readonly defaultCols: number;
  readonly alternate: { readonly rows: number; readonly cols: number } | 'caller';
}

export interface BindImage {
  /** EBCDIC-decoded primary LU name: WHICH APPLICATION you were just connected to. */
  readonly pluName: string;
  readonly maxRuSecondary: number;
  readonly maxRuPrimary: number;
  /** Byte 24 verbatim, kept so a trace can report a code we do not implement. */
  readonly sizeCode: number;
  /** Absent when the size code is one we have no table entry for. */
  readonly dims?: BindDims;
}

/**
 * Parse a BIND RU (x3270's `process_bind`, Common/telnet.c:2449).
 *
 * Returns null when this is not a BIND at all. EVERY OTHER FIELD IS OPTIONAL and
 * length-guarded, because a short BIND is malformed rather than truncated and there is
 * nothing to salvage -- the same contract as `decodeHeader`, and for the same reason:
 * a client cannot correct a host, and throwing here would surface to the operator as a
 * program check the host never caused.
 *
 * NOTE THE COMPARISON: x3270 guards with `buflen > OFFSET`, not `>=`, so a buffer whose
 * LAST byte is at OFFSET is treated as not reaching it. Preserved exactly, because the
 * boundary is what a fixture from a real host will land on.
 */
export function parseBind(body: Uint8Array): BindImage | null {
  if (body.length < 1 || body[0] !== BIND_RU) return null;

  const maxRuSecondary = body.length > BIND_OFF.MAXRU_SEC
    ? maxRu(body[BIND_OFF.MAXRU_SEC]!) : 0;
  const maxRuPrimary = body.length > BIND_OFF.MAXRU_PRI
    ? maxRu(body[BIND_OFF.MAXRU_PRI]!) : 0;

  const sizeCode = body.length > BIND_OFF.SSIZE ? body[BIND_OFF.SSIZE]! : 0;
  const dims = body.length > BIND_OFF.SSIZE ? decodeDims(body, sizeCode) : undefined;

  return {
    pluName: decodePluName(body),
    maxRuSecondary,
    maxRuPrimary,
    sizeCode,
    ...(dims === undefined ? {} : { dims }),
  };
}

/** The size-code table, Common/telnet.c:2485-2521. */
function decodeDims(body: Uint8Array, sizeCode: number): BindDims | undefined {
  const at = (off: number): number => body[off] ?? 0;
  switch (sizeCode) {
    case 0x00:
    case 0x02:
      return {
        defaultRows: MODEL_2.rows, defaultCols: MODEL_2.cols,
        alternate: { rows: MODEL_2.rows, cols: MODEL_2.cols },
      };
    case 0x03:
      return {
        defaultRows: MODEL_2.rows, defaultCols: MODEL_2.cols,
        alternate: 'caller',
      };
    case 0x7e:
      // ONE pair, used for BOTH sizes. Bytes 22-23 are deliberately not read.
      return {
        defaultRows: at(BIND_OFF.RD), defaultCols: at(BIND_OFF.CD),
        alternate: { rows: at(BIND_OFF.RD), cols: at(BIND_OFF.CD) },
      };
    case 0x7f:
      return {
        defaultRows: at(BIND_OFF.RD), defaultCols: at(BIND_OFF.CD),
        alternate: { rows: at(BIND_OFF.RA), cols: at(BIND_OFF.CA) },
      };
    default:
      // x3270 clears bind_state here: a code we do not know is not a geometry we may
      // guess at. The BIND is still valid; it simply carries no dimensions.
      return undefined;
  }
}
```

`decodePluName` is Task 4. **For this task, stub it so the file compiles and the size-code tests
run:**

```typescript
function decodePluName(_body: Uint8Array): string {
  return '';
}
```

The real-BIND test asserting `pluName === 'IBM0SMAJ'` **will fail** until Task 4. That is
expected and intentional — it is the failing test Task 4 makes pass.

- [ ] **Step 4: Build and test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/bind.test.ts
```

Expected: the five size-code tests PASS; the real-BIND test FAILS on `pluName` only. Confirm
the failure message names `pluName` and **not** `dims` — if `dims` is also wrong, the fixture or
the table is wrong and you should stop and report it.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/bind.ts packages/core/test/bind.test.ts
git commit -m "feat(core): parse a BIND's size code into default and alternate geometry

The table is telnet.c:2485-2521. Two things are easy to get wrong and are pinned:
0x7e uses ONE pair for both sizes rather than reading bytes 22-23, and 0x03 defers
the alternate to the CLIENT's model -- reported as 'caller' rather than resolved,
since resolving it in a pure function would make every 0x03 BIND a model 2.

The PLU name is stubbed; the next commit decodes it.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: The PLU name

**Files:**
- Modify: `packages/core/src/bind.ts`
- Test: `packages/core/test/bind.test.ts`

The PLU name is **which application you were just connected to** — it belongs on the status line
in a real client. Length byte at 27, name at 28, **capped at 8**, EBCDIC.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/bind.test.ts`:

```typescript
describe('parseBind — the PLU name', () => {
  /** Build a BIND carrying `name` as its PLU name, EBCDIC-encoded. */
  const withName = (bytes: number[], declaredLen = bytes.length): Uint8Array => {
    const b = new Uint8Array(BIND_OFF.PLU_NAME + bytes.length);
    b[0] = BIND_RU;
    b[BIND_OFF.SSIZE] = 0x00;
    b[BIND_OFF.PLU_NAME_LEN] = declaredLen;
    b.set(bytes, BIND_OFF.PLU_NAME);
    return b;
  };

  it('decodes EBCDIC', () => {
    // 'IBM' in cp037: I=0xc9 B=0xc2 M=0xd4
    expect(parseBind(withName([0xc9, 0xc2, 0xd4]))!.pluName).toBe('IBM');
  });

  it('is empty when the declared length is zero', () => {
    // x3270 requires namelen > 0 before copying, so a zero length is "no name" and
    // not "a name of length zero followed by whatever bytes are there".
    expect(parseBind(withName([0xc9, 0xc2, 0xd4], 0))!.pluName).toBe('');
  });

  it('caps at 8 bytes even when the host declares more', () => {
    // x3270 clamps namelen to BIND_PLU_NAME_MAX rather than refusing the BIND.
    const nine = [0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9];
    const name = parseBind(withName(nine, 9))!.pluName;
    expect(name).toHaveLength(8);
    expect(name).toBe('ABCDEFGH');
  });

  it('is empty when the declared length overruns the buffer', () => {
    // A HOSTILE OR TRUNCATED BIND: it says 8 bytes and supplies 2. x3270 requires
    // buflen > PLU_NAME + namelen before copying, so it takes nothing. Taking the two
    // available bytes would be inventing a name the host did not send.
    expect(parseBind(withName([0xc9, 0xc2], 8))!.pluName).toBe('');
  });

  it('is empty when the buffer does not reach the length byte at all', () => {
    const short = new Uint8Array(20);
    short[0] = BIND_RU;
    expect(parseBind(short)!.pluName).toBe('');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/bind.test.ts
```

Expected: 4 of the 5 new tests FAIL (the zero-length one passes against the stub by accident —
note that, it is why the stub is not a substitute for the real thing), plus the real-BIND test
from Task 3 still failing.

- [ ] **Step 3: Implement**

Replace the stub in `packages/core/src/bind.ts`:

```typescript
/**
 * The primary LU name: WHICH APPLICATION the host has just connected us to.
 *
 * Four guards, each matching x3270 (Common/telnet.c:2560-2585) and each with a
 * distinct failure it prevents:
 *  - the buffer must REACH the length byte;
 *  - a declared length of 0 means no name, not an empty one followed by stray bytes;
 *  - a declared length over 8 is CLAMPED, as x3270 clamps it, not refused;
 *  - a declared length that OVERRUNS the buffer yields nothing at all, because taking
 *    the bytes that happen to be present would invent a name the host never sent.
 */
function decodePluName(body: Uint8Array): string {
  if (body.length <= BIND_OFF.PLU_NAME_LEN) return '';
  let namelen = body[BIND_OFF.PLU_NAME_LEN]!;
  if (namelen > BIND_OFF.PLU_NAME_MAX) namelen = BIND_OFF.PLU_NAME_MAX;
  if (namelen === 0) return '';
  if (body.length <= BIND_OFF.PLU_NAME + namelen - 1) return '';
  const slice = body.subarray(BIND_OFF.PLU_NAME, BIND_OFF.PLU_NAME + namelen);
  return cp037.decode(slice);
}
```

Add to the imports at the top of `bind.ts`:

```typescript
import { cp037 } from './codepage.js';
```

The method is `decode(bytes: Uint8Array): string` — verified at
`packages/core/src/codepage.ts:51`, and `cp037` is exported at `:69`.

> **IMPLEMENTER: verify the overrun guard against x3270's actual comparison.** It is
> `buflen > BIND_OFF_PLU_NAME + namelen`. My `body.length <= BIND_OFF.PLU_NAME + namelen - 1` is
> an algebraic rearrangement and **may be off by one**. Check it against the "declares 8, supplies
> 2" test and against the real BIND, which declares 8 and supplies exactly 8 — **that fixture is
> the boundary case, so if the guard is wrong by one, the real-BIND test catches it.**

- [ ] **Step 4: Build and test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/bind.test.ts
```

Expected: **all** tests PASS, including the real-BIND test from Task 3 with `pluName ===
'IBM0SMAJ'`.

- [ ] **Step 5: Mutation-check the overrun guard**

Delete the overrun guard line entirely, rebuild, re-run. The "declares 8 and supplies 2" test
must fail. Restore and confirm green. **If it does not fail, the guard is unreachable and the
test is vacuous — report that rather than moving on.**

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/bind.ts packages/core/test/bind.test.ts
git commit -m "feat(core): decode the BIND's PLU name, with x3270's four guards

The name says which application the host connected us to. A declared length that
overruns the buffer yields nothing rather than the bytes that happen to be there:
a truncated BIND must not be able to invent a name. The real BIND from
devname_success.trc declares exactly 8 bytes, so it is the boundary fixture.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: `parseUnbind`

**Files:**
- Modify: `packages/core/src/bind.ts`
- Test: `packages/core/test/bind.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('parseUnbind', () => {
  it('reads the reason byte', () => {
    expect(parseUnbind(Uint8Array.of(Tn3270eUnbindReason.NORMAL)))
      .toEqual({ reason: 0x01, forthcoming: false });
  });

  it('flags BIND_FORTHCOMING, because another BIND is coming', () => {
    // THE OPERATIONALLY IMPORTANT CASE: the host is handing us between applications,
    // not tearing the session down. A client that treated this as a teardown would
    // drop a session the host meant to keep.
    expect(parseUnbind(Uint8Array.of(Tn3270eUnbindReason.BIND_FORTHCOMING)))
      .toEqual({ reason: 0x02, forthcoming: true });
  });

  it('reports an absent reason for a zero-length body', () => {
    // x3270 only traces a reason when (ibptr - ibuf) > EH_SIZE, i.e. when there is a
    // byte at all. Undefined rather than 0, so "no reason given" is distinguishable
    // from any real code -- which is why NORMAL is 0x01 and not 0x00.
    expect(parseUnbind(new Uint8Array(0)))
      .toEqual({ reason: undefined, forthcoming: false });
  });

  it('passes an unrecognised reason through without inventing a meaning', () => {
    // 0x03 is one of the real gaps in x3270's table. It is reported, not mapped.
    expect(parseUnbind(Uint8Array.of(0x03)))
      .toEqual({ reason: 0x03, forthcoming: false });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/bind.test.ts
```

Expected: FAIL — `parseUnbind` is not exported.

- [ ] **Step 3: Implement**

```typescript
/** An UNBIND's reason, if it carried one. */
export interface UnbindInfo {
  /** Undefined when the body was empty: "no reason given", not reason zero. */
  readonly reason: number | undefined;
  /** The host is handing us to another application and a BIND is coming. */
  readonly forthcoming: boolean;
}

/**
 * Parse an UNBIND body (x3270's Common/telnet.c:2745-2765).
 *
 * UNBIND is teardown WITH THE TCP CONNECTION STILL UP: bound state clears, the BIND's
 * sizing reverts, the screen erases, and we wait for another BIND. It is not a
 * disconnection and must not be treated as one.
 */
export function parseUnbind(body: Uint8Array): UnbindInfo {
  const reason = body.length > 0 ? body[0]! : undefined;
  return {
    reason,
    forthcoming: reason === Tn3270eUnbindReason.BIND_FORTHCOMING,
  };
}
```

Add `Tn3270eUnbindReason` to `bind.ts`'s import from `./constants.js`, and
`parseUnbind`/`Tn3270eUnbindReason` to the test file's imports.

- [ ] **Step 4: Build and test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/bind.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/bind.ts packages/core/test/bind.test.ts
git commit -m "feat(core): parse UNBIND, distinguishing BIND-forthcoming from teardown

UNBIND is teardown with the TCP connection still up. BIND_FORTHCOMING means the
host is handing us between applications, so treating it as a disconnection would
drop a session the host meant to keep. An absent reason is undefined rather than
zero, which is why NORMAL is 0x01.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 6: `Screen.setSizes` and the range-check

**Files:**
- Modify: `packages/core/src/screen.ts:125-128`
- Modify: `packages/core/src/bind.ts` (the range-check, as a pure function)
- Test: `packages/core/test/screen.test.ts`, `packages/core/test/bind.test.ts`

**Two separate pieces, deliberately:** the *decision* (is this geometry acceptable?) is pure and
goes in `bind.ts`; the *mutation* goes on `Screen`. Keeping them apart is what lets every
boundary be tested without a screen.

- [ ] **Step 1: Write the failing range-check test**

In `packages/core/test/bind.test.ts`:

```typescript
describe('acceptBindDims — x3270 s bind_limit range check', () => {
  /** A model 4: 24x80 default, 43x80 alternate. */
  const model4 = { rows: 43, cols: 80 };

  it('accepts geometry inside the model', () => {
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: { rows: 43, cols: 80 } },
      model4,
    )).toEqual({ ok: true });
  });

  it('refuses a default LARGER than the model', () => {
    const r = acceptBindDims(
      { defaultRows: 44, defaultCols: 80, alternate: { rows: 43, cols: 80 } },
      model4,
    );
    expect(r.ok).toBe(false);
    expect(r.why).toContain('44x80');
  });

  it('refuses a default SMALLER than model 2', () => {
    // 24x80 is the floor for BOTH pairs. A host asking for less is refused, not
    // clamped: x3270 keeps its own geometry entirely on any failure.
    const r = acceptBindDims(
      { defaultRows: 23, defaultCols: 80, alternate: { rows: 43, cols: 80 } },
      model4,
    );
    expect(r.ok).toBe(false);
  });

  it('refuses an ALTERNATE out of range, separately from the default', () => {
    // Four separate checks in x3270, not two: a valid default does not license an
    // invalid alternate.
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: { rows: 44, cols: 80 } },
      model4,
    ).ok).toBe(false);
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: { rows: 23, cols: 80 } },
      model4,
    ).ok).toBe(false);
  });

  it('accepts exactly 24x80 and exactly the model size, the two boundaries', () => {
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: { rows: 24, cols: 80 } },
      model4,
    ).ok).toBe(true);
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: model4 },
      model4,
    ).ok).toBe(true);
  });

  it('pins a model 2 to EXACTLY 24x80, which is counterintuitive but correct', () => {
    // The upper bound is the model and the lower is model 2, so on a model 2 they
    // COINCIDE: every value except 24x80 is refused. With the limit on, BIND can only
    // ever narrow a large model toward 24x80; it can never grow one past -model.
    // That is a safety rail, not a capability -- growing past the model is oversize's
    // job. Documented in the spec so this does not read as a bug.
    const model2 = { rows: 24, cols: 80 };
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: { rows: 24, cols: 80 } },
      model2,
    ).ok).toBe(true);
    expect(acceptBindDims(
      { defaultRows: 24, defaultCols: 80, alternate: { rows: 43, cols: 80 } },
      model2,
    ).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/bind.test.ts
```

Expected: FAIL — `acceptBindDims` is not exported.

- [ ] **Step 3: Implement the range-check**

Append to `packages/core/src/bind.ts`:

```typescript
/** Whether a BIND's geometry may be applied, and if not, why not. */
export interface BindDimsVerdict {
  readonly ok: boolean;
  /** Present when refused: a phrase for the trace and the OIA. */
  readonly why?: string;
}

/**
 * x3270's `bind_limit` range check (Common/telnet.c:2523-2556).
 *
 * FOUR separate checks, not two: default over the model, default under model 2,
 * alternate over the model, alternate under model 2. A valid default does not license
 * an invalid alternate. Any failure keeps OUR geometry entirely -- x3270 does not
 * clamp, and neither do we, because a host that asked for something impossible has not
 * told us what it would have preferred.
 *
 * THE CONSEQUENCE IS COUNTERINTUITIVE AND IS NOT A BUG: the upper bound is the
 * configured model and the lower bound is model 2, so ON A MODEL 2 THEY COINCIDE and
 * BIND geometry is pinned to exactly 24x80. With the limit on, BIND can only ever
 * narrow a large model toward 24x80; it can never grow one past `-model`. Growing past
 * the model is oversize's job, and letting BIND do it here would silently make this
 * feature into that one.
 *
 * `alternate: 'caller'` never reaches this function: the caller substitutes its own
 * model first, and its own model is by definition in range.
 */
export function acceptBindDims(
  dims: BindDims,
  model: { readonly rows: number; readonly cols: number },
): BindDimsVerdict {
  const alt = dims.alternate;
  if (alt === 'caller') {
    // Defensive: the caller should have substituted. Accepting is right if it did not,
    // since the substitute would have been the model itself.
    return { ok: true };
  }
  const d = `${dims.defaultRows}x${dims.defaultCols}`;
  const a = `${alt.rows}x${alt.cols}`;
  const max = `${model.rows}x${model.cols}`;
  const min = `${MODEL_2.rows}x${MODEL_2.cols}`;
  if (dims.defaultRows > model.rows || dims.defaultCols > model.cols) {
    return { ok: false, why: `BIND default ${d} exceeds model ${max}` };
  }
  if (dims.defaultRows < MODEL_2.rows || dims.defaultCols < MODEL_2.cols) {
    return { ok: false, why: `BIND default ${d} is below ${min}` };
  }
  if (alt.rows > model.rows || alt.cols > model.cols) {
    return { ok: false, why: `BIND alternate ${a} exceeds model ${max}` };
  }
  if (alt.rows < MODEL_2.rows || alt.cols < MODEL_2.cols) {
    return { ok: false, why: `BIND alternate ${a} is below ${min}` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Build and run**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/bind.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing `Screen.setSizes` test**

In `packages/core/test/screen.test.ts`:

```typescript
describe('Screen.setSizes — BIND and UNBIND rewrite both sizes', () => {
  it('replaces the default and alternate sizes', () => {
    const s = new Screen({ alternateRows: 43, alternateCols: 80 });
    s.setSizes({ rows: 24, cols: 80 }, { rows: 32, cols: 80 });
    expect(s.defaultSize).toEqual({ rows: 24, cols: 80 });
    expect(s.alternateSize).toEqual({ rows: 32, cols: 80 });
  });

  it('makes useAlternateSize switch to the NEW alternate', () => {
    // The point of the mutator: EW and EWA must keep meaning what they mean after a
    // BIND. A resize() call could not express this -- it switches the CURRENT geometry
    // between two fixed sizes, while BIND changes what those two sizes ARE.
    const s = new Screen({ alternateRows: 43, alternateCols: 80 });
    s.setSizes({ rows: 24, cols: 80 }, { rows: 32, cols: 80 });
    s.useAlternateSize();
    expect([s.rows, s.cols]).toEqual([32, 80]);
  });

  it('rejects a non-positive or non-integer size, like the constructor does', () => {
    const s = new Screen();
    expect(() => s.setSizes({ rows: 0, cols: 80 }, { rows: 24, cols: 80 }))
      .toThrow(RangeError);
    expect(() => s.setSizes({ rows: 24.5, cols: 80 }, { rows: 24, cols: 80 }))
      .toThrow(RangeError);
  });

  it('does NOT change the current geometry by itself', () => {
    // setSizes changes what EW/EWA mean; it does not perform one. The caller erases
    // explicitly, matching x3270's separate ctlr_erase(false) after process_bind.
    const s = new Screen();
    expect([s.rows, s.cols]).toEqual([24, 80]);
    s.setSizes({ rows: 24, cols: 80 }, { rows: 43, cols: 80 });
    expect([s.rows, s.cols]).toEqual([24, 80]);
  });
});
```

- [ ] **Step 6: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/screen.test.ts
```

Expected: FAIL — `setSizes` does not exist.

- [ ] **Step 7: Implement `setSizes`**

In `packages/core/src/screen.ts`, change the two `readonly` field declarations at `:125-128`:

```typescript
  /**
   * The Erase/Write size. The screen starts here, as x3270's does (ctlr.c:341).
   *
   * NO LONGER `readonly`, and only `setSizes` may write it. A BIND is the second
   * channel by which a host dictates geometry (Query Reply being the other), and it
   * rewrites BOTH sizes -- so this cannot be fixed at construction any more.
   */
  defaultSize: { readonly rows: number; readonly cols: number };
  /** The Erase/Write Alternate size. Equal to `defaultSize` on a model 2. */
  alternateSize: { readonly rows: number; readonly cols: number };
```

Add, next to `useAlternateSize`:

```typescript
  /**
   * Replace what Erase/Write and Erase/Write Alternate MEAN.
   *
   * The only callers are BIND (which sets the host's geometry) and UNBIND (which
   * reverts to the model's). Deliberately narrow: `resize` switches the CURRENT
   * geometry between two fixed sizes, whereas this changes what those two sizes are,
   * and no existing method could express that.
   *
   * It does NOT change the current geometry or erase anything. x3270 calls
   * `ctlr_erase(false)` separately after `process_bind`, and keeping the two apart
   * means a caller that only wants to reinterpret EW/EWA does not pay for a repaint.
   */
  setSizes(
    def: { rows: number; cols: number },
    alt: { rows: number; cols: number },
  ): void {
    checkGeometry(def.rows, def.cols);
    checkGeometry(alt.rows, alt.cols);
    this.defaultSize = { rows: def.rows, cols: def.cols };
    this.alternateSize = { rows: alt.rows, cols: alt.cols };
  }
```

- [ ] **Step 8: Build, run the whole suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run
```

Expected: all pass. **Dropping `readonly` can break other code that relied on it** — if
anything else fails, report it; it is information about a coupling, not noise.

- [ ] **Step 9: Mutation-check**

Make `setSizes` write only `defaultSize` and not `alternateSize`. Rebuild. The
`useAlternateSize` test must fail. Restore, confirm green.

- [ ] **Step 10: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/screen.ts packages/core/src/bind.ts packages/core/test/screen.test.ts packages/core/test/bind.test.ts
git commit -m "feat(core): Screen.setSizes, and x3270's four-way BIND range check

defaultSize and alternateSize were readonly and a BIND rewrites both, so this
needs a mutator rather than a resize() call: resize switches the CURRENT geometry
between two fixed sizes, while BIND changes what those sizes ARE.

The range check is four separate comparisons, not two -- a valid default does not
license an invalid alternate. Its counterintuitive consequence is pinned by a
test: on a model 2 the upper and lower bounds coincide, so BIND geometry is
exactly 24x80 and BIND can never grow a session past -model. That is oversize's
job, and letting BIND do it here would silently make this feature into that one.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 7: Request BIND-IMAGE, and the blast radius

**Files:**
- Modify: `packages/core/src/tn3270e.ts:95-113`
- Modify: `packages/core/test/tn3270e.test.ts:219-233`, `:640-651`

**This is the flipped default.** Memory's warning applies: *a flipped default's blast radius
includes tests that silently depended on the old value*, and when the gateway's token default
flipped, **one test went red with nothing left to refuse**. Watch for that shape. Do not update
expectations until green without reading each one.

- [ ] **Step 1: Measure the blast radius BEFORE changing anything**

```bash
cd ~/git/tn3270 && grep -rn "REQUESTED_FUNCTIONS" packages/ --include=*.ts --include=*.py | grep -v node_modules
```

Write the list into your task notes. Then make the change and let the suite tell you the rest —
**both numbers, before and after, go in your report.**

- [ ] **Step 2: Change `REQUESTED_FUNCTIONS`**

In `packages/core/src/tn3270e.ts`, replace the BIND-IMAGE paragraph of the comment at `:95-107`
(keep the paragraphs about the printer functions and CONTENTION-RESOLUTION) and the array:

```typescript
/**
 * The functions we ask for.
 *
 * BIND-IMAGE IS REQUESTED, and the hazard that once justified omitting it has been
 * measured away. Granted BIND-IMAGE and sent no BIND, real s3270 never enters 3270
 * mode (telnet.c:2339, and the gate at telnet.c:2681 that drops 3270_DATA until
 * `tn3270e_bound`). THAT REMAINS TRUE. What changed is knowing how often it happens:
 * 29 of 29 hosts in x3270's own trace collection that grant BIND-IMAGE send a BIND
 * immediately after FUNCTIONS, counted BY BYTES across all 71 traces -- grepping for
 * decoded `< BIND` annotation lines gives a FALSE answer, because older traces carry
 * no annotations. The advertise-then-stay-silent case exists only in our own
 * e-server.py, which we configured to do it.
 *
 * So we adopt the gate deliberately AND refuse to inherit the hang: a pre-BIND
 * 3270-DATA record is retained and executed if NO_BIND_TIMEOUT_MS expires (bind.ts).
 * Asking for it is what gives BIND, UNBIND and the whole geometry channel a
 * verification path at all -- 46 recorded traces stop dead at FUNCTIONS without it.
 *
 * The two printer functions, SCS-CTL-CODES and DATA-STREAM-CTL, are printer-session
 * functions by RFC 2355 §7.2.2 and belong to the printer stage.
 *
 * CONTENTION-RESOLUTION is not in RFC 2355 at all; x3270 requests it and so do we,
 * but nothing here depends on a host granting it.
 *
 * ORDER MATTERS TO THE TESTS, NOT TO THE PROTOCOL: this is s3270's own order
 * (00 02 04 05), so a byte-for-byte comparison against a recorded s3270 FUNCTIONS
 * REQUEST matches without sorting either side.
 */
export const REQUESTED_FUNCTIONS: readonly number[] = [
  Tn3270eFunc.BIND_IMAGE,
  Tn3270eFunc.RESPONSES,
  Tn3270eFunc.SYSREQ,
  Tn3270eFunc.CONTENTION_RESOLUTION,
];
```

- [ ] **Step 3: Build and run the suite; record what breaks**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run 2>&1 | tail -30
```

Expected: failures in `packages/core/test/tn3270e.test.ts` and possibly elsewhere. **List every
failing test in your notes with its file and line before fixing any of them.**

- [ ] **Step 4: Update the three tests that pin the list**

`packages/core/test/tn3270e.test.ts:219` becomes:

```typescript
  it('requests BIND-IMAGE, RESPONSES, SYSREQ and CONTENTION-RESOLUTION', () => {
    // BIND-IMAGE IS PRESENT, and its presence is the whole of this branch. It was
    // omitted while the grant-then-no-BIND hang was thought to be a live risk; 29 of
    // 29 hosts in x3270's traces that grant it send a BIND immediately, and the gate
    // now has a timeout, so the omission cost us BIND, UNBIND and 46 traces' worth of
    // verification for nothing.
    expect([...REQUESTED_FUNCTIONS]).toEqual([
      Tn3270eFunc.BIND_IMAGE, Tn3270eFunc.RESPONSES,
      Tn3270eFunc.SYSREQ, Tn3270eFunc.CONTENTION_RESOLUTION,
    ]);
  });
```

`:640` — this one is the trap. It currently asserts our list is s3270's **minus** BIND-IMAGE.
Now the lists are **identical**, so the subtraction has nothing left to express:

```typescript
  it('our FUNCTIONS REQUEST is now byte-identical to s3270 s', () => {
    // s3270 sent 03 07 00 02 04 05 (captured; see docs/live-testing.md, *TN3270E
    // harness validation*). We now send the same four function bytes in the same
    // order.
    //
    // THIS TEST PREVIOUSLY ASSERTED A SUBTRACTION -- s3270's list MINUS BIND-IMAGE --
    // and when BIND-IMAGE was added it would have passed VACUOUSLY as
    // `filter(f => f !== 0x00)` over a list that no longer needed filtering. Rewritten
    // as a plain equality so it still has something to refuse. A flipped default's
    // blast radius includes tests that silently depended on the old value.
    const s3270Funcs = [0x00, 0x02, 0x04, 0x05];
    expect([...REQUESTED_FUNCTIONS]).toEqual(s3270Funcs);
  });
```

> **IMPLEMENTER: check whether the old `:640` assertion would in fact have passed vacuously.**
> `s3270Funcs.filter(f => f !== Tn3270eFunc.BIND_IMAGE)` yields `[0x02, 0x04, 0x05]`, which is
> **not** equal to the new four-element list, so it would FAIL rather than pass silently. **If so,
> my comment above is wrong** — fix the comment to say it failed loudly, which is the better
> outcome, and note the correction. Do not commit a comment that misdescribes what happened.

`:231` (the printer-functions test) should still pass untouched. **Confirm it does** rather than
assuming — it asserts absence, and absence tests survive additions.

- [ ] **Step 5: Build, typecheck, full suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"
```

Expected: all green. Record the test count.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/tn3270e.ts packages/core/test/tn3270e.test.ts
git commit -m "feat(core): request BIND-IMAGE, and say why the hazard no longer justifies silence

The grant-then-no-BIND hang is real and remains real; what changed is knowing it
happens on no real host. 29 of 29 hosts in x3270's trace collection that grant
BIND-IMAGE send a BIND immediately after FUNCTIONS, counted by bytes because
older traces carry no annotation lines to grep. Only our own e-server.py stays
silent, and only because we told it to.

Our FUNCTIONS REQUEST is now byte-identical to s3270's, so the test that
expressed it as a SUBTRACTION from s3270's list is rewritten as an equality --
otherwise it would assert a filter over a list that no longer needs filtering.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 8: The gate — retain a pre-BIND record

**Files:**
- Modify: `packages/core/src/session.ts:395` (`handleRecord`)
- Modify: `packages/core/src/bind.ts` (add `NO_BIND_TIMEOUT_MS`)
- Test: `packages/core/test/session.test.ts`

**The behaviour, from the spec.** With the BIND-IMAGE function granted and no BIND yet, a
`3270_DATA` record is **retained, not executed and not dropped**. x3270 drops it
(`telnet.c:2681`, a bare `return 0`); the user chose retention so the timeout in Task 9 recovers
the frame and not merely the session.

- [ ] **Step 1: Add the constant**

In `packages/core/src/bind.ts`:

```typescript
/**
 * How long to wait for a BIND after granting BIND-IMAGE, before giving up and
 * executing what the host already sent.
 *
 * x3270 HAS NO SUCH TIMEOUT: with BIND-IMAGE granted and no BIND, it drops 3270 data
 * indefinitely (Common/telnet.c:2681) and the session appears wedged. We decline to
 * inherit that.
 *
 * FIVE SECONDS, AND THE REASON IS NOT MARGIN FOR ITS OWN SAKE. Every host in x3270's
 * trace collection sends its BIND in the same turn as FUNCTIONS, so one round-trip
 * would nearly always do -- but most of this client's users are on emulated hardware
 * and some are on REAL 370-class iron (P/370s and similar), which is slow, and those
 * are exactly the users with no other working client. A short timeout would punish
 * them and nobody else.
 *
 * TUNABLE ON PURPOSE, and documented in the README: the person who needs it longer is
 * running vintage hardware and is the least likely to be reading this source.
 */
export const NO_BIND_TIMEOUT_MS = 5000;
```

- [ ] **Step 2: Write the failing test**

In `packages/core/test/session.test.ts`. **Follow the file's existing harness** — read how its
other tests build a `Session` with a fake connection and drive bytes in; do **not** invent a new
fixture style.

```typescript
describe('the BIND-IMAGE gate', () => {
  it('retains a 3270-DATA record that arrives before any BIND', async () => {
    // With BIND-IMAGE granted, x3270 DROPS 3270 data until bound (telnet.c:2681).
    // We retain it instead, so the timeout can execute it rather than leaving the
    // operator looking at a blank screen -- a quieter failure than the hang it
    // replaces.
    const s = /* negotiate TN3270E with BIND-IMAGE granted; see this file's helpers */;
    // Send an Erase/Write that would paint 'A' at row 1 col 1.
    /* deliver a 3270-DATA record */;
    // NOT executed: the screen is still blank.
    expect(s.screen.textAt(0, 0)).toBe(' ');
    expect(s.pendingBindRecord).not.toBeUndefined();
  });

  it('executes the retained record when the BIND arrives', async () => {
    const s = /* as above */;
    /* deliver the 3270-DATA record */;
    /* deliver a BIND with size code 0x00 */;
    expect(s.screen.textAt(0, 0)).toBe('A');
    expect(s.pendingBindRecord).toBeUndefined();
  });

  it('keeps only the most recent pre-BIND record', async () => {
    // Not a queue, deliberately: a host that paints twice before binding has painted
    // over its own first screen anyway, and an unbounded queue is a memory hole a
    // remote party controls.
    const s = /* as above */;
    /* deliver a record painting 'A' */;
    /* deliver a record painting 'B' */;
    /* deliver a BIND */;
    expect(s.screen.textAt(0, 0)).toBe('B');
  });

  it('does NOT gate when BIND-IMAGE was not granted', async () => {
    // The gate is conditional on the FUNCTION being agreed. A host that granted
    // nothing must not have its data withheld -- that would break every session that
    // works today.
    const s = /* negotiate with an EMPTY granted list */;
    /* deliver the 3270-DATA record */;
    expect(s.screen.textAt(0, 0)).toBe('A');
  });
});
```

> **IMPLEMENTER: this is the one task where I could not write complete test code**, because the
> session test harness's shape (how it fakes a connection, negotiates, and reads the screen) is
> not something I could reproduce faithfully from a grep — and a plausible-looking fake that
> does not match the file would be worse than this placeholder. **Read
> `packages/core/test/session.test.ts` and follow its existing patterns**, in particular whichever
> helper already negotiates TN3270E (search for `negotiate` or `FUNCTIONS`). `screen.textAt` is
> also a guess: find the real accessor. **Report the harness's actual shape in your notes so the
> remaining tasks can use it.**

- [ ] **Step 3: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/session.test.ts
```

- [ ] **Step 4: Implement the gate**

In `packages/core/src/session.ts`, inside `handleRecord`, in the `if (this.inTn3270e())` block:
after `decodeHeader` succeeds and **before** the `carriesDatastream` check, add BIND and UNBIND
handling; and after it, the gate. Sketch — **adapt to the real surrounding code**:

```typescript
      if (h.dataType === Tn3270eDataType.BIND_IMAGE) {
        this.handleBind(record.subarray(TN3270E_HEADER_BYTES));
        return;
      }
      if (h.dataType === Tn3270eDataType.UNBIND) {
        this.handleUnbind(record.subarray(TN3270E_HEADER_BYTES));
        return;
      }
```

and, for the gate, where `carriesDatastream(h.dataType)` is true:

```typescript
      if (this.bindImageGranted() && !this.bound) {
        // THE GATE (x3270's telnet.c:2681), with the hang removed. x3270 returns here
        // and the record is gone; we keep the most recent one so the timeout can run
        // it. Only the most recent: a host that painted twice before binding has
        // overwritten its own first screen, and a queue would be a memory hole a
        // remote party controls.
        this.pendingBindRecord = record.subarray(TN3270E_HEADER_BYTES);
        this.armNoBindTimer();
        this.trace.note('3270 data before BIND, retained');
        return;
      }
```

New private state and helpers on `Session`:

```typescript
  /** The most recent 3270-DATA record withheld by the BIND gate. */
  private pendingBindRecord: Uint8Array | undefined;
  private bound = false;
  private noBindTimer: ReturnType<typeof setTimeout> | undefined;

  /** True when the host agreed the BIND-IMAGE FUNCTION (0x00, not the data type). */
  private bindImageGranted(): boolean {
    return this.e?.agreed.includes(Tn3270eFunc.BIND_IMAGE) ?? false;
  }
```

- [ ] **Step 5: Build, test**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run
```

- [ ] **Step 6: Mutation-check the grant condition**

Change `bindImageGranted()` to `return true`. The "does NOT gate when BIND-IMAGE was not
granted" test must fail. Restore.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/session.ts packages/core/src/bind.ts packages/core/test/session.test.ts
git commit -m "feat(core): gate 3270 data until bound, retaining the frame instead of dropping it

x3270 returns from process_eor and the record is gone (telnet.c:2681), which is
the measured hang. We keep the most recent withheld record so the timeout can
execute it: a timeout that discarded the frame would recover the session and
still leave a blank screen.

Only the most recent, not a queue -- a host that painted twice before binding has
overwritten its own first screen, and a queue is a memory hole a remote party
controls.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 9: The timeout, and it must be diagnosable

**Files:**
- Modify: `packages/core/src/session.ts`
- Test: `packages/core/test/session.test.ts`

- [ ] **Step 1: Write the failing test, with fake timers**

`packages/tui/test/app.test.ts` and `packages/web/test/sessions.test.ts` both use
`vi.useFakeTimers()` — **read one of them for the pattern** rather than inventing one.

```typescript
describe('the no-BIND timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('executes the retained record when no BIND arrives', async () => {
    const s = /* negotiate with BIND-IMAGE granted */;
    /* deliver a 3270-DATA record painting 'A' */;
    expect(s.screen.textAt(0, 0)).toBe(' ');
    vi.advanceTimersByTime(NO_BIND_TIMEOUT_MS);
    // THE FRAME IS RECOVERED, not merely the session: this is the whole reason the
    // record is retained rather than dropped.
    expect(s.screen.textAt(0, 0)).toBe('A');
  });

  it('does not fire once a BIND has arrived', async () => {
    const s = /* negotiate with BIND-IMAGE granted */;
    /* deliver a BIND */;
    /* deliver a 3270-DATA record painting 'A' */;
    vi.advanceTimersByTime(NO_BIND_TIMEOUT_MS * 2);
    // Executed once by the BIND path, not twice.
    expect(s.screen.textAt(0, 0)).toBe('A');
  });

  it('is OBSERVABLE, because a fired timeout is evidence about the host', async () => {
    // "Nothing visible happened" cannot distinguish a working path from an inert one
    // -- the lesson Sys Req taught this project. A live run must be able to tell "the
    // BIND never came" from "a BIND came and we ignored it", so the timeout traces.
    const s = /* negotiate with BIND-IMAGE granted, tracing enabled */;
    /* deliver a 3270-DATA record */;
    vi.advanceTimersByTime(NO_BIND_TIMEOUT_MS);
    expect(s.traceText()).toContain('BIND');
  });

  it('is cleared when the connection closes, so it cannot hold the event loop', () => {
    // An armed timer keeps the process alive after teardown. This exact bug is
    // recorded in packages/tui/src/app.ts:303 for the ESC timer, where the symptom was
    // a process that appeared to hang for the timeout's duration on exit.
    const s = /* negotiate with BIND-IMAGE granted */;
    /* deliver a 3270-DATA record, arming the timer */;
    /* close the connection */;
    expect(s.hasArmedNoBindTimer()).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/session.test.ts
```

- [ ] **Step 3: Implement**

```typescript
  /**
   * Start the no-BIND deadline, unless one is already running.
   *
   * NOT restarted per record: the deadline is "how long since the host should have
   * bound", and re-arming on every pre-BIND write would let a chatty host defer it
   * forever -- which is the hang, arrived at by a different route.
   */
  private armNoBindTimer(): void {
    if (this.noBindTimer !== undefined) return;
    this.noBindTimer = setTimeout(() => {
      this.noBindTimer = undefined;
      const held = this.pendingBindRecord;
      this.pendingBindRecord = undefined;
      // TRACED BEFORE EXECUTING, so the trace shows the cause ahead of its effect
      // even if executing throws.
      this.trace.note(
        `no BIND within ${NO_BIND_TIMEOUT_MS}ms; executing the retained record at our own geometry`);
      if (held !== undefined) this.executeRecord(held);
    }, NO_BIND_TIMEOUT_MS);
  }

  private clearNoBindTimer(): void {
    if (this.noBindTimer === undefined) return;
    clearTimeout(this.noBindTimer);
    this.noBindTimer = undefined;
  }
```

Call `clearNoBindTimer()` from `handleClose()` **and** from `forgetTn3270e()`.

> **IMPLEMENTER, AND THIS IS THE MOST LIKELY PLACE FOR A REAL BUG:** memory records that this
> project has twice shipped a teardown where *one path clears the state and another does not* —
> `Session.e` once cleared only on the REJECT path, and `IAC DONT TN3270E` cleared the option but
> not `tn3270eNegotiated`. **Enumerate every path that ends a negotiation or a connection and make
> sure each clears the timer, `bound`, and `pendingBindRecord`.** `forgetTn3270e` already exists
> as the single place for exactly this; put the clearing **there** rather than at three call
> sites. Report which paths you found.
>
> **Also:** `executeRecord` is my name for "the rest of `handleRecord` after the gate". That method
> probably does not exist — the body is inline. **Extract it, or inline the execution.** Whichever
> you choose, the retained record and a live record must go through the *same* code, or the
> timeout path will drift from the normal one.

- [ ] **Step 4: Build, typecheck, full suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run
```

- [ ] **Step 5: Mutation-check the clear**

Remove the `clearNoBindTimer()` call from the teardown path. The "cleared when the connection
closes" test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/session.ts packages/core/test/session.test.ts
git commit -m "feat(core): a 5s no-BIND deadline that executes the retained frame

Five seconds rather than one round-trip because some users are on real 370-class
hardware, which is slow, and they are exactly the users with no other working
client. The constant is exported and documented as tunable.

The deadline is not re-armed per record: re-arming on every pre-BIND write would
let a chatty host defer it forever, which is the hang by another route. It is
cleared in forgetTn3270e, the one place a negotiation ends, because this project
has twice shipped a teardown where one path cleared state and another did not.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 10: Apply and revert the geometry

**Files:**
- Modify: `packages/core/src/session.ts`
- Test: `packages/core/test/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('BIND geometry', () => {
  it('applies an in-range BIND geometry and erases', async () => {
    const s = /* model 4 session, BIND-IMAGE granted */;
    /* deliver a BIND with size code 0x7f, default 24x80, alternate 32x80 */;
    expect(s.screen.defaultSize).toEqual({ rows: 24, cols: 80 });
    expect(s.screen.alternateSize).toEqual({ rows: 32, cols: 80 });
  });

  it('keeps our geometry when the BIND is out of range', async () => {
    // A model 2 asked for a 43-row alternate: refused, and OUR geometry stands
    // entirely. x3270 does not clamp and neither do we -- a host that asked for the
    // impossible has not said what it would have preferred.
    const s = /* model 2 session, BIND-IMAGE granted */;
    /* deliver a BIND with alternate 43x80 */;
    expect(s.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
    expect(s.traceText()).toContain('exceeds model');
  });

  it('substitutes OUR alternate for size code 0x03', async () => {
    // 0x03 means "model-2 default, and the CLIENT's alternate". parseBind reports
    // 'caller' and the session fills it in; a pure function cannot know our model.
    const s = /* model 4 session (alternate 43x80), BIND-IMAGE granted */;
    /* deliver a BIND with size code 0x03 */;
    expect(s.screen.defaultSize).toEqual({ rows: 24, cols: 80 });
    expect(s.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('reverts to the model geometry on UNBIND', async () => {
    const s = /* model 4 session, BIND-IMAGE granted */;
    /* deliver a BIND with 0x7f, alternate 32x80 */;
    /* deliver an UNBIND, reason NORMAL */;
    expect(s.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('honours an out-of-range BIND when the limit is off', async () => {
    const s = /* model 2 session, bindLimit: false, BIND-IMAGE granted */;
    /* deliver a BIND with alternate 43x80 */;
    expect(s.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('un-binds without disconnecting, and waits for another BIND', async () => {
    // UNBIND is teardown with the TCP connection still up. After it, the gate is
    // closed again: a 3270-DATA record is retained, not executed.
    const s = /* model 4 session, BIND-IMAGE granted, already bound */;
    /* deliver an UNBIND */;
    /* deliver a 3270-DATA record */;
    expect(s.screen.textAt(0, 0)).toBe(' ');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement `handleBind` and `handleUnbind`**

```typescript
  /**
   * A BIND: the host naming an application and, often, dictating geometry.
   *
   * The ORDER here matters and matches x3270: parse, apply geometry, erase, then
   * release the gate. Releasing the gate first would execute the retained record at
   * the OLD geometry, which is the bug the gate exists to prevent.
   */
  private handleBind(body: Uint8Array): void {
    const bind = parseBind(body);
    if (bind === null) {
      this.trace.note('BIND-IMAGE record that is not a BIND, dropped');
      return;
    }
    if (bind.dims !== undefined) {
      const model = this.modelSize();
      const alt = bind.dims.alternate === 'caller' ? model : bind.dims.alternate;
      const dims = { ...bind.dims, alternate: alt };
      const verdict = this.bindLimit
        ? acceptBindDims(dims, model)
        : { ok: true as const };
      if (verdict.ok) {
        this.screen.setSizes(
          { rows: dims.defaultRows, cols: dims.defaultCols }, alt);
        this.screen.useDefaultSize();
      } else {
        this.trace.note(`${verdict.why}; keeping our geometry`);
      }
    }
    this.bound = true;
    this.clearNoBindTimer();
    const held = this.pendingBindRecord;
    this.pendingBindRecord = undefined;
    if (held !== undefined) this.executeRecord(held);
    this.emit('screen');
  }

  /**
   * An UNBIND: teardown with the TCP connection still up.
   *
   * Reverts the BIND's sizing, erases, and closes the gate again to await another
   * BIND. BIND_FORTHCOMING says one IS coming -- the host handing us between
   * applications -- and treating that as a disconnection would drop a session the host
   * meant to keep.
   */
  private handleUnbind(body: Uint8Array): void {
    const info = parseUnbind(body);
    this.trace.note(
      `UNBIND reason ${info.reason ?? 'absent'}${info.forthcoming ? ' (BIND forthcoming)' : ''}`);
    const model = this.modelSize();
    this.screen.setSizes({ rows: MODEL_2.rows, cols: MODEL_2.cols }, model);
    this.screen.useDefaultSize();
    this.bound = false;
    this.pendingBindRecord = undefined;
    this.clearNoBindTimer();
    this.emit('screen');
  }
```

> **IMPLEMENTER: `modelSize()` and `this.bindLimit` do not exist yet.** `modelSize()` must return
> the alternate geometry the session was CONSTRUCTED with — from `SessionOptions.alternateRows/
> alternateCols` — and it must be remembered separately, because `screen.alternateSize` is now
> mutable and a BIND will have overwritten it. **Getting this wrong makes UNBIND revert to the
> previous BIND's geometry instead of the model's, and no test above would catch it if you derive
> it from the screen.** Add a `readonly modelAlternate` captured in the constructor. `bindLimit`
> comes from Task 11; for this task default it to `true` in the constructor.

- [ ] **Step 4: Build, typecheck, full suite**

- [ ] **Step 5: Mutation-check the revert**

Make `handleUnbind` revert to `this.screen.alternateSize` instead of `this.modelAlternate`.
Then: BIND to 32x80, UNBIND, and assert the alternate is 43x80. It must fail. This is the trap
called out above — **if your test does not catch it, the test is wrong, not the mutation.**

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/session.ts packages/core/test/session.test.ts
git commit -m "feat(core): honour BIND geometry, revert it on UNBIND

Order matters and matches x3270: parse, apply geometry, erase, then release the
gate. Releasing first would execute the retained record at the old geometry,
which is what the gate exists to prevent.

UNBIND reverts to the MODEL's geometry, captured at construction -- not to
screen.alternateSize, which a previous BIND may have overwritten now that it is
mutable. A mutation test pins that, since deriving it from the screen looks right
and reverts to the wrong size.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 11: `-bind-image` and `-bind-limit` in all four front ends

**Files:**
- Modify: `packages/core/src/session.ts` (`SessionOptions`)
- Modify: `packages/frontend/src/session.ts:25`
- Modify: `packages/cli/src/main.ts:53`, `packages/gui/src/args.ts:59`,
  `packages/tui/src/main.ts:81`, `packages/web/src/args.ts:152`
- Test: `packages/cli/test/`, `packages/gui/test/`, `packages/tui/test/`, `packages/web/test/`
  (follow each package's existing arg-parser tests)

Both flags are **single-dashed**, like `-tn3270e` and `-model`: they are inherited client flags,
and the gateway's own flags are the double-dashed ones. `-bind-image on|off`, `-bind-limit on|off`,
both defaulting to `on`.

- [ ] **Step 1: Write the failing tests**

For each of the four parsers, following that package's existing `-tn3270e` tests:

```typescript
  it('-bind-image off clears the option', () => {
    expect(parseArgs(['-bind-image', 'off', 'h:23']).bindImage).toBe(false);
  });

  it('-bind-image defaults to on', () => {
    expect(parseArgs(['h:23']).bindImage).not.toBe(false);
  });

  it('-bind-image rejects a value that is not on or off', () => {
    expect(() => parseArgs(['-bind-image', 'yes', 'h:23'])).toThrow(UsageError);
  });

  it('-bind-image without a value is a usage error', () => {
    expect(() => parseArgs(['-bind-image'])).toThrow(UsageError);
  });

  it('-bind-limit off lets an out-of-range BIND geometry through', () => {
    expect(parseArgs(['-bind-limit', 'off', 'h:23']).bindLimit).toBe(false);
  });

  it('-bind-limit defaults to on', () => {
    expect(parseArgs(['h:23']).bindLimit).not.toBe(false);
  });
```

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

`SessionOptions` in `packages/core/src/session.ts`:

```typescript
  /**
   * Request the BIND-IMAGE function. Defaults to true; `-bind-image off` clears it.
   *
   * Off means the gate never closes, because the gate is conditional on the host
   * having AGREED the function.
   */
  bindImage?: boolean;
  /**
   * Range-check a BIND's geometry against the model. Defaults to true, as x3270's
   * `bindLimit` resource does (Common/glue.c:458).
   */
  bindLimit?: boolean;
```

In each parser, beside the existing `-tn3270e` case:

```typescript
      case '-bind-image': {
        if (value === undefined) throw new UsageError('-bind-image needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-bind-image takes on or off, not ${JSON.stringify(value)}`);
        }
        bindImage = value === 'on';
        i += 1;
        continue;
      }
      case '-bind-limit': {
        if (value === undefined) throw new UsageError('-bind-limit needs a value, on or off');
        if (value !== 'on' && value !== 'off') {
          throw new UsageError(`-bind-limit takes on or off, not ${JSON.stringify(value)}`);
        }
        bindLimit = value === 'on';
        i += 1;
        continue;
      }
```

> **IMPLEMENTER: each parser differs.** `packages/web/src/args.ts` uses a `value(args, i, a)`
> helper and `continue` rather than `break`; the GUI and TUI use a `switch` with `i += 1`. **Match
> each file's own idiom** instead of pasting the above four times. And thread both options through
> `defaultSession` in `packages/frontend/src/session.ts`, whose existing lines use the
> `...(x === undefined ? {} : { x })` spread idiom.

Also make `REQUESTED_FUNCTIONS` conditional. It is currently a module constant; with
`-bind-image off` the request must omit BIND-IMAGE. **Add a function rather than mutating the
constant** — `requestedFunctions(bindImage: boolean)` — and leave `REQUESTED_FUNCTIONS` as the
default-on list so existing tests and `addsNothing` keep working. Check `addsNothing`: with
`-bind-image off`, a host that grants BIND-IMAGE anyway must still back off, and that check
reads `REQUESTED_FUNCTIONS`, so it needs the per-session list instead.

- [ ] **Step 4: Build, typecheck, full suite**

- [ ] **Step 5: Test the interaction that a unit test would miss**

```typescript
  it('backs off when a host grants BIND-IMAGE we did not ask for', () => {
    // With -bind-image off, BIND-IMAGE is outside our requested set, so a host that
    // grants it is "illegally adding a function" and we abandon TN3270E -- exactly the
    // protection that made omitting BIND-IMAGE safe in the first place.
    const st = initialState({
      terminalType: 'IBM-3278-2-E', lus: [], bindImage: false,
    });
    /* drive FUNCTIONS IS with BIND-IMAGE in it */
    expect(next.phase).toBe('backedOff');
  });
```

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add -A && git commit -m "feat: -bind-image and -bind-limit in all four front ends

Both single-dashed and defaulting to on, like -tn3270e and -model: they are
inherited client flags, and only the gateway's own flags are double-dashed.
-bind-limit matches x3270's resource name and polarity, which defaults true at
glue.c:458.

The requested function list becomes per-session rather than a module constant,
because addsNothing reads it: with -bind-image off, a host granting BIND-IMAGE is
adding a function we did not ask for and must still trigger the backoff.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 12: `drive-e.py` — exercise the gate against a server

**Files:**
- Modify: `packages/cli/scripts/drive-e.py` (the `CASES` list, around `:74-150`)

`e-server.py` already has `--send-bind` (`:165-166`) and sends `31 01 03 b1 90` — a 5-byte BIND
that does **not** reach byte 24, so it exercises the "no dimensions" path. That is useful and
insufficient: nothing here sends a BIND with a size code.

- [ ] **Step 1: Read the existing cases and the server's flags**

```bash
cd ~/git/tn3270 && sed -n '55,155p' packages/cli/scripts/drive-e.py && grep -n "add_argument" packages/cli/scripts/e-server.py
```

- [ ] **Step 2: Add a size-code BIND to `e-server.py`**

Extend `--send-bind` to take an optional geometry, or add `--bind-size CODE`. **A BIND with size
code 0x7f, default 24x80, alternate 32x80** needs at least 28 bytes:

```python
        # A BIND with a size code, which the 5-byte one above cannot carry: byte 24 is
        # the size code and bytes 20-23 the two rows/cols pairs. 0x7f means "both pairs
        # present". Padded to 28 bytes so the PLU-name length byte at 27 is a real zero
        # rather than off the end.
        bind = bytearray(28)
        bind[0] = 0x31
        bind[10] = 0x87   # MaxSec-RU 1024, as in x3270's devname_success.trc
        bind[11] = 0xf8   # MaxPri-RU 3840
        bind[20], bind[21] = 24, 80
        bind[22], bind[23] = 32, 80
        bind[24] = 0x7f
```

- [ ] **Step 3: Add three cases to `drive-e.py`**

Following the existing `Case(...)` shape exactly:

1. **`bind-image granted, BIND follows`** — server grants bind-image and sends the size-code
   BIND; assert the session reaches 3270 mode and the wire log shows the BIND.
2. **`bind-image granted, NO BIND — the timeout recovers`** — server grants bind-image and sends
   3270 data but no BIND. **This is the only place the timeout is exercised end to end.** The
   case must allow >5s; check the harness's timeout and raise it if needed, and **say in the
   case's comment that it deliberately takes five seconds** so nobody "optimises" it away.
3. **`-bind-image off refuses the function`** — client passes `-bind-image off`; assert the
   FUNCTIONS REQUEST omits `0x00`.

- [ ] **Step 4: Run it**

```bash
cd ~/git/tn3270 && npm run build && python3 packages/cli/scripts/drive-e.py
```

Expected: **10/10** (7 existing + 3 new). If an existing case broke, **that is information about
the default flip** — report it before fixing.

> **IMPLEMENTER: suspect this harness before the client.** `e-server.py` once scored a correct
> refusal as FAIL, and `drive-e.py`'s readiness probe was once accepted AS the client (the server
> serves one connection at a time), so the real client got `ECONNREFUSED` while the log claimed
> success — it failed all seven cases and the client was fine. If a new case fails, prove the
> harness is right first.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/cli/scripts/drive-e.py packages/cli/scripts/e-server.py
git commit -m "test(cli): drive the BIND gate and its timeout against e-server

Three cases: a granted BIND-IMAGE with a size-code BIND following, a granted
BIND-IMAGE with NO BIND (the only end-to-end exercise of the 5s timeout, and it
deliberately takes five seconds), and -bind-image off omitting the function.

e-server's existing --send-bind sends five bytes, which cannot reach the size
code at byte 24, so it only ever exercised the no-dimensions path.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 13: `drive-playback.py` — the real-host witness

**Files:**
- Modify: `packages/cli/scripts/drive-playback.py`

**This is the payoff.** All five current cases stop at FUNCTIONS because we did not ask for
BIND-IMAGE. With it granted they proceed, and `devname_success.trc` contains a real BIND.

- [ ] **Step 1: Re-run the harness as-is and record what changed**

```bash
cd ~/git/tn3270 && npm run build && python3 packages/cli/scripts/drive-playback.py
```

The five cases each currently match 2 blocks (3 and 19 bytes). **With BIND-IMAGE requested those
byte counts change**, because our FUNCTIONS REQUEST is now four functions rather than three.
Record the new numbers. **Expect the assertions to fail: they pin the old counts.** That is the
harness doing its job.

- [ ] **Step 2: Update the expectations and add `devname_success.trc`**

Add a case for `~/src/suite3270-4.5/s3270/Test/devname_success.trc`. Its host side sends
`FUNCTIONS REQUEST BIND-IMAGE`, we answer `FUNCTIONS IS BIND-IMAGE`, and then it sends the real
BIND. **Copy the trace into `packages/fixtures/x3270/` rather than referencing
`~/src/suite3270-4.5`** — the existing fixture directory is there for exactly this, and a path
into a hand-built source tree is not reproducible.

- [ ] **Step 3: Note the three ways this harness fakes a pass**

Preserve them in the new case's comments, because they are all still live:

```python
# playback EXITS 0 WHETHER OR NOT IT MATCHED ANYTHING (Common/playback.c:373 is
# literally `exit(0); /* needs to be smarter */`), so assert on the "Matched N bytes"
# lines and NEVER on the return code. 16 of the 71 traces have no emulator side at all.
# And a trace records ONE CLIENT VERSION, not a spec.
```

Also: **playback never `fflush`es its readiness line** (`:283`), so waiting for it on a pipe
hangs forever — use a log file plus `stdbuf -oL`, as the existing cases do.

- [ ] **Step 4: Run it**

```bash
cd ~/git/tn3270 && python3 packages/cli/scripts/drive-playback.py
```

Expected: **6/6**, with the new case matching more blocks than the others — it should get past
FUNCTIONS to the BIND. **Report the exact block and byte counts**: they are the evidence that
BIND-IMAGE unblocked the oracle, and "6 of 6 passed" alone does not show it.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/cli/scripts/drive-playback.py packages/fixtures/x3270/
git commit -m "test(cli): the playback oracle now reaches a real host's BIND

devname_success.trc's host grants BIND-IMAGE and sends a real BIND -- PLU name
IBM0SMAJ, MaxSec-RU 1024, MaxPri-RU 3840, default 24x80, alternate 43x80. That
gives BIND parsing a witness from a real host, which it has never had: both
Hercules systems refuse option 40 and z/VM 4.4 withdraws it after our DEVICE-TYPE
REQUEST.

The five existing cases' byte counts changed, because our FUNCTIONS REQUEST is
now four functions rather than three. The trace is copied into
packages/fixtures/x3270 rather than referenced from a hand-built source tree.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 14: Docs

**Files:**
- Modify: `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md`
- Modify: `docs/superpowers/plans/2026-09-17-bind-image-and-bind-unbind.md` (AS BUILT notes)

- [ ] **Step 1: README**

Document `-bind-image on|off` and `-bind-limit on|off` beside `-tn3270e`. State the tunable
timeout and **why** it is 5 seconds (slow real hardware). State the model-2 consequence of
`-bind-limit` explicitly, because a user seeing a refused BIND on a model 2 will otherwise file a
bug.

- [ ] **Step 2: `docs/live-testing.md`**

Add BIND/UNBIND to the next-run list, and record plainly: **no reachable host completes a TN3270E
negotiation**, so the witness is a recorded host. Add to the four existing questions for a future
real host: *does it send a BIND, with what size code, and does it ever UNBIND with
BIND_FORTHCOMING?*

- [ ] **Step 3: `docs/HANDOFF.md`**

Update *Where things stand*. **Its opening START HERE section is already two branches stale and
says so** — fix it or delete the stale part; do not add a third layer of correction on top.
Memory records the recurring shape: *a later fix updates a prose body and never the heading or
expected-count that summarises it.* **Check the summaries last.**

- [ ] **Step 4: Annotate this plan AS BUILT**

Every task that diverged gets an `**AS BUILT:**` note. The web-gateway and keypad plans both did
this and it is why their ~40 and ~46 defects did not need re-deriving. **Record every place this
plan was wrong** — especially the four I flagged as uncertain (`cp037`'s decode method, the
PLU-name off-by-one, whether `maxRu`'s mask is falsifiable, and whether the old `:640` test would
have failed loudly or vacuously).

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add README.md docs/
git commit -m "docs: BIND-IMAGE, BIND and UNBIND, and what has no live witness

Records the two new flags, why the timeout is 5s rather than one round-trip, and
the model-2 consequence of -bind-limit -- a user seeing a refused BIND on a model
2 would otherwise file a bug.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 15: The whole gate, on the merge commit

- [ ] **Step 1: Force-rebuild the GUI**

```bash
cd ~/git/tn3270 && npx tsc --build --force packages/gui
```

**Not optional after a branch checkout:** the staleness guard compares mtimes, and `git checkout`
rewrites them without changing content. `npm run build` cannot clear it.

- [ ] **Step 2: Build, typecheck, suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"
```

Expected: green, and a test count **above** the 1733 baseline. Record it.

- [ ] **Step 3: All five host-free harnesses**

```bash
cd ~/git/tn3270
python3 packages/cli/scripts/drive-playback.py    # expect 6/6
python3 packages/cli/scripts/drive-e.py           # expect 10/10
python3 packages/tui/scripts/pty-smoke.py         # expect 12 PASS, exit 0
```

- [ ] **Step 4: The four GUI/web harnesses**

They start Xvfb themselves via `packages/gui/scripts/xvfb.mjs`. Do **not** guard with
`pgrep -f "Xvfb :99"` — it matches the shell command containing the pattern. Test for
`[ -S /tmp/.X11-unix/X99 ]`.

```bash
cd ~/git/tn3270
node packages/gui/scripts/shot.mjs           # expect 3/3 goldens
node packages/gui/scripts/keys.mjs           # expect 18 chords / 16 actions
node packages/gui/scripts/clicks.mjs         # expect 9 buttons / 10 actions
node packages/web/scripts/browser-keys.mjs   # expect 13 chords / 11 actions
node packages/web/scripts/browser-shot.mjs   # expect 2/2
```

- [ ] **Step 5: Report, and do NOT merge**

Report every number. **The merge is the user's call and they have not given it** — the last five
features each waited to be asked. Say the gate is green and stop.

---

## Self-Review

**Spec coverage.** Negotiation → Task 7 and 11. Parsing → Tasks 2-5. Geometry, mutator and
range-check → Tasks 6 and 10. Gate and timeout → Tasks 8 and 9. Flags → Task 11. Verification →
Tasks 12, 13, 15. Docs → Task 14. The spec's "no front-end changes" claim is exercised by Task
15's GUI/web harnesses rather than by a task, which is right — there is nothing to implement.

**Known gaps, stated rather than hidden.**

1. **Task 8's test code is incomplete** and says so. `session.test.ts`'s harness shape could not
   be reproduced faithfully from a grep, and a plausible-looking fake would be worse than an
   honest placeholder. The implementer reads the file and reports the real shape for Tasks 9-11.
   This is the plan's weakest task.
2. **Two uncertainties resolved before handing this over, two still flagged inline.** Resolved:
   `cp037.decode` is the real method (`codepage.ts:51`), and **`maxRu`'s `& 0x0f` is
   unfalsifiable** — measured over the byte range, so Task 2 now says not to test it rather than
   sending someone hunting for a mutation that cannot exist. Still open, each with instructions to
   check and report: the PLU-name overrun guard's off-by-one, and whether the old `:640` test
   fails loudly or vacuously.
3. **`executeRecord` does not exist** — Task 9 says so and says the retained and live paths must
   share one code path.
4. **`modelSize`/`modelAlternate` must be captured at construction**, called out in Task 10 with
   the mutation test that catches getting it wrong.

**Type consistency.** `BindImage`, `BindDims`, `BindDimsVerdict`, `UnbindInfo`, `parseBind`,
`parseUnbind`, `acceptBindDims`, `maxRu`, `BIND_RU`, `BIND_OFF`, `NO_BIND_TIMEOUT_MS`,
`Screen.setSizes`, `Session.pendingBindRecord`/`bound`/`bindImageGranted`/`armNoBindTimer`/
`clearNoBindTimer`/`handleBind`/`handleUnbind`/`modelAlternate`, options `bindImage`/`bindLimit`.
`BindDims.alternate` is `{rows,cols} | 'caller'` throughout, and Task 10 is the only place the
`'caller'` substitution happens.
