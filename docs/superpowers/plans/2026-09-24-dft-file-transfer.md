# DFT File Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement DFT (`SF_TRANSFER_DATA`) file transfer in `packages/core` so `IND$FILE` works at any screen geometry, not just 24x80, and verify it against live MVS/TSO.

**Architecture:** A new record-shaped state machine, `core/src/ft/dft.ts`, that takes a structured-field payload and returns reply bytes. It never sees a `Screen` — that is the whole point, and it is why CUT's 24x80 restriction does not follow us. Wire constants live beside it in `dftFrames.ts`. `stream/sf.ts` gains a `transferData` variant on its `StructuredField` union; `stream/execute.ts` surfaces it as a request for the session to answer, exactly as it already surfaces `sfReply`; `Session` routes the payload to the active transfer. The DDM advertisement that makes a host choose DFT is already built (`9f92816`).

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes`), vitest, npm workspaces. No runtime dependencies.

---

## Before you start: five facts that will cost you a day if you skip them

**1. `npm run build` MUST precede `vitest` when you touch a package another package imports.** Packages resolve to their built `dist/index.js`. Testing before rebuilding has produced 22 failures that looked like a broken refactor and were a stale artifact. `npm test` from the root does not build first.

**2. OUR PAYLOAD OFFSETS ARE x3270's MINUS 3, AND THIS IS THE SINGLE MOST LIKELY BUG IN THIS PLAN.**
x3270 passes `ft_dft_data` a pointer to the **start of the whole structured field** — `cp[0..1]` are the length, `cp[2]` is SFID `0xd0`, and its `struct data_buffer` overlays the field from byte 0 (`ft_dft.c:59-67`, `sf.c:177`). Our `parseStructuredFields` hands out `params`, which **excludes the two length bytes and the SFID** (`stream/sf.ts:140`). So every offset in `ft_dft.c` and in the design spec must be reduced by 3 for our code:

| field | x3270 offset | our offset into `payload` |
|---|---|---|
| request type (16-bit) | 3, into the struct | **0** |
| name, `len == 0x23` | `cp + 25` | **25** |
| record size (16-bit), `len == 0x29` | `cp + 27` | **27** |
| name, `len == 0x29` | `cp + 31` | **31** |

**CORRECTED 2026-09-25 — THE OPEN'S THREE OFFSETS ARE *NOT* REDUCED BY 3, AND THE TABLE ABOVE SAID
THEY WERE. It was a real bug, it shipped in Task 3, and its tests passed over it.** The -3 rule
applies only where a field is read through `data_bufr`, which overlays the field from byte 0 — that
is the request type and everything in a `Data Insert`. The `Open` is read through `cp`, and **`cp` is
already at struct offset 3**: `GET16` does not advance its pointer (`include/3270ds.h:341-344` reads
`*(ptr)` and `*(ptr+1)` and assigns nothing back), so the `cp` set to `data_bufr->sf_request_type` at
`ft_dft.c:108` is still pointing there when `:114` calls `dft_open_request(data_length, cp)`.
`offsetof(struct data_buffer, sf_request_type)` is **3** — compiled and printed, not read off — which
is exactly where our payload starts. So `cp` and our `payload` are the same byte and the Open's
offsets carry over unchanged.

**The live-probe evidence validates the LENGTH subtraction only.** Field lengths `0x29`/`0x23`
arriving as 38/32-byte payloads says nothing about offsets *inside* the payload; fact 2 above
generalised it to them without measuring, and the phrase "confirmed against a real host" gave a
derived claim the standing of a measured one.

**Corroboration that the corrected offsets are right:** the 7-byte name ends exactly at the payload's
last byte in both forms — 25+7 = 32 and 31+7 = 38, the two legal payload lengths. x3270's
`memcpy(namebuf, name, 7)` (`:159`) consumes the field to its end, which is why `0x23` is the short
form's length and not more. Under the old offsets the name ended 3 bytes short with filler after it.

**Why no test caught it, which is the transferable part:** the test helper wrote the name at the same
wrong offset the parser read it from. Helper and parser agreed with each other and not with the wire,
so five tests passed over a real bug — and this is the *quiet* failure fact 2 itself warns about: a
wrong name is not `FT:MSG`, so a MESSAGE frame silently starts a file transfer and the host's status
text is written into the user's file as if it were data. The guard now is a test that builds a `0x23`
Open **byte by byte from the struct layout**, owing nothing to the helper or to the parser's
constants; mutation-verified by restoring offset 22, which reddens it.

**This is confirmed against a real host, not just derived.** The `-ddm on` probe recorded
`unknownSF(0xd0,38B)` and a second at `32B`; the declared field lengths are `0x29` = 41 and `0x23` = 35, and 41 − 3 = 38, 35 − 3 = 32. The lengths the host sends are field lengths (x3270's convention); the payload we receive is 3 bytes shorter.

**Corollary: `len` in `dft_open_request`'s `len == 0x23` test is the FIELD length**, i.e. what the host put in the length bytes — not our `payload.length`. Task 3 therefore compares `payload.length` against `0x20` and `0x26`. Getting this wrong makes every `Open` abort with "unknown open", which is a loud failure, but the *name offset* being wrong is a quiet one: you get a 7-byte string of the wrong bytes, it does not equal `"FT:MSG"`, and a message frame silently starts a file transfer.

**3. Two spec citations are off by one.** The design spec cites `ctlr.c:761` and `:987` for the Read Modified hook; the actual lines are **`ctlr.c:760` and `:986`**, inside `ctlr_read_modified()` (which starts at `:746`) and `ctlr_read_buffer()` (`:974`). Cite the corrected lines. This is not pedantry — this plan asks you to check citations, so it must not add bad ones.

**4. Judge live runs by TRACE, never by whether the transfer succeeded.** Before this plan, a `-ddm on` transfer on TK5 *failing* was the positive result. After Task 6 it inverts: both CUT and DFT end in a transferred file, and only the trace distinguishes `SF_TRANSFER_DATA` frames from CUT screens. Also: `Trace(on)` alone puts **nothing** in the log — **`TraceText` is required.**

**5. A mutation check MUST assert its target was found.** Two "passes" in one sweep on an earlier branch were silent no-matches, i.e. a false "this code is not load-bearing" — the most misleading result possible. When a step says "mutate X and confirm red", verify the edit actually changed the file.

**6. `Close` DOES NOT END A TRANSFER. The host's own message does.** This is the finding most likely to be "fixed" back into a bug by someone who thinks they know how file transfer works, so it is here rather than only in Task 5.

`ft_complete` is called from exactly **three** places in `ft_dft.c` — `:270`, `:273`, `:276` — and all three are inside the **message** branch of `dft_data_insert`. `dft_close_request` (`:672-688`) writes a CloseAck and nothing else. `message_flag` is a single flag reset by every `Open` (`:171-175`), which is what makes the real sequence possible:

```
Open("FT:DATA") -> Data... -> Close -> Open("FT:MSG") -> Data("TRANS03") -> done
```

So **one `DftTransfer` instance must survive its own Close and then handle a second Open**, and the received bytes are handed over on that final message — not on the Close. Completing at the Close would report success before the host said `TRANS03`, i.e. before it had committed the file, and would throw away the host's error text on a failure, which is the only channel carrying it. Stage 1's rule applies: a transfer that reports success and writes a wrong file is the failure mode to look for.

**7. Three requests are answered with SILENCE, and that is the correct answer.** `Set Cursor` and `Insert` are empty functions in x3270 (`ft_dft.c:193-198`, `:417-422`) and the `default` arm only traces `Unsupported(0x%04x)` (`:131-133`). None sends bytes. An earlier draft of this plan had all three replying, which would put unsolicited bytes on the wire to a live mainframe mid-transfer. `DftStep.reply` being absent is a result, not a gap — but `unsupported` is reported so the trace still shows what arrived.

## File structure

| File | Status | Responsibility |
|---|---|---|
| `packages/core/src/ft/dftFrames.ts` | **create** | Wire constants and the pure `parseDftFrame` / reply builders. No state. |
| `packages/core/src/ft/dft.ts` | **create** | `DftTransfer`: the state machine. Payload in, reply bytes out. No `Session`, no `Screen`. |
| `packages/core/src/stream/sf.ts` | modify | Add the `transferData` variant and its dispatch arm. |
| `packages/core/src/stream/execute.ts` | modify | Surface `transferData` as `result.transferData`. |
| `packages/core/src/session.ts` | modify | Route the payload to the active `DftTransfer`; the Read Modified hook. |
| `packages/core/src/constants.ts` | modify | `Sfid.TRANSFER_DATA = 0xd0`. |
| `packages/core/src/index.ts` | modify | Export the new public surface. |
| `packages/core/test/dftFrames.test.ts` | **create** | Constants against the header; parse and build round-trips. |
| `packages/core/test/dft.test.ts` | **create** | The state machine against synthetic payloads. |
| `packages/core/test/dftSession.test.ts` | **create** | The plumbing: payload reaches the engine, reply reaches the wire. |
| `packages/cli/scripts/dft-tso.txt` | **create** | The live run against TK5 at 43x80. |

`ft/cut.ts` and `ft/frames.ts` are **not touched**. If you find yourself editing either, stop — the spec says share nothing but the `frontend` halves, and those are already shared.

---

### Task 1: Wire constants, transcribed from the header

**Files:**
- Create: `packages/core/src/ft/dftFrames.ts`
- Create: `packages/core/test/dftFrames.test.ts`
- Modify: `packages/core/src/constants.ts` (the `Sfid` block at line 354)

- [ ] **Step 1: Read the real header and transcribe from it, not from this plan**

Run: `cat ~/src/suite3270-4.5/include/ft_dft_ds.h`

Every constant below was checked against that file on 2026-09-24 and matched. **Check them again anyway** — that is the standing rule for wire constants here, and the point of the exercise is that the plan is not the source.

- [ ] **Step 2: Write the failing test**

Create `packages/core/test/dftFrames.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DftRequest, DftReply, DftHeader, DftError, OPEN_MSG } from '../src/ft/dftFrames.js';

describe('DFT wire constants, from include/ft_dft_ds.h', () => {
  it('has the six host request types', () => {
    expect(DftRequest.OPEN).toBe(0x0012);
    expect(DftRequest.CLOSE).toBe(0x4112);
    expect(DftRequest.SET_CUR).toBe(0x4511);
    expect(DftRequest.GET).toBe(0x4611);
    expect(DftRequest.INSERT).toBe(0x4711);
    expect(DftRequest.DATA_INSERT).toBe(0x4704);
  });

  it('has the four PC reply types', () => {
    expect(DftReply.GET).toBe(0x4605);
    expect(DftReply.NORMAL).toBe(0x4705);
    expect(DftReply.ERROR).toBe(0x08);
    expect(DftReply.CLOSE).toBe(0x4109);
  });

  it('has the other headers', () => {
    expect(DftHeader.RECNUM).toBe(0x6306);
    expect(DftHeader.ERROR).toBe(0x6904);
    expect(DftHeader.NOT_COMPRESSED).toBe(0xc080);
    expect(DftHeader.BEGIN_DATA).toBe(0x61);
  });

  it('has the two error codes', () => {
    expect(DftError.EOF).toBe(0x2200);
    expect(DftError.CMDFAIL).toBe(0x0100);
  });

  it('spells the message-open name exactly as x3270 does', () => {
    // ft_dft.c:52 `#define OPEN_MSG "FT:MSG"`. Six characters, no trailing space:
    // the comparison is against a name whose trailing spaces have been trimmed.
    expect(OPEN_MSG).toBe('FT:MSG');
    expect(OPEN_MSG).toHaveLength(6);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: FAIL — `Failed to resolve import "../src/ft/dftFrames.js"`.

- [ ] **Step 4: Write `dftFrames.ts`**

Create `packages/core/src/ft/dftFrames.ts`:

```typescript
/**
 * DFT (Distributed Function Terminal) file-transfer wire constants.
 *
 * Every value is transcribed from x3270's `include/ft_dft_ds.h`, which is the
 * only place they are written down — the IBM manual documents the DDM Query
 * Reply that ENABLES this protocol but not these request codes.
 *
 * ## THE OFFSET TRAP
 *
 * x3270 overlays `struct data_buffer` on the START of the structured field, so
 * its offsets count the two length bytes and the SFID. `parseStructuredFields`
 * hands us the parameters only. **Every offset here is x3270's minus 3**, and the
 * constants below are named for OUR frame so the subtraction happens once.
 * Confirmed against a live host: TK5 sent field lengths 0x29 and 0x23 and our
 * parser reported 38- and 32-byte payloads (41-3, 35-3).
 */

/** Host request types: `TR_*_REQ` and `TR_DATA_INSERT`. */
export const DftRequest = {
  /** `TR_OPEN_REQ` — open a file or announce a message. */
  OPEN: 0x0012,
  /** `TR_CLOSE_REQ`. */
  CLOSE: 0x4112,
  /** `TR_SET_CUR_REQ` — set cursor. x3270 acknowledges and does nothing else. */
  SET_CUR: 0x4511,
  /** `TR_GET_REQ` — host wants data FROM us: this is the upload path. */
  GET: 0x4611,
  /** `TR_INSERT_REQ`. x3270's handler is empty (`ft_dft.c:193-198`). */
  INSERT: 0x4711,
  /** `TR_DATA_INSERT` — host is giving us data: the download path. */
  DATA_INSERT: 0x4704,
} as const;

/** Replies we send. `TR_*_REPLY`. */
export const DftReply = {
  /** `TR_GET_REPLY` — our data, answering a GET. */
  GET: 0x4605,
  /** `TR_NORMAL_REPLY` — an acknowledgement carrying a record number. */
  NORMAL: 0x4705,
  /**
   * `TR_ERROR_REPLY`, and note it is **8 bits**, not 16: x3270 writes
   * `HIGH8(code)` then this byte, so the reply type's high byte is borrowed from
   * whatever request failed (`ft_dft.c:702-703`, `:646-647`).
   */
  ERROR: 0x08,
  /** `TR_CLOSE_REPLY`. */
  CLOSE: 0x4109,
} as const;

/** Sub-headers inside a frame. */
export const DftHeader = {
  /** `TR_RECNUM_HDR`, followed by a 32-bit record number. */
  RECNUM: 0x6306,
  /** `TR_ERROR_HDR`, followed by a 16-bit error code. */
  ERROR: 0x6904,
  /** `TR_NOT_COMPRESSED`. We never compress, so this is the only value we send. */
  NOT_COMPRESSED: 0xc080,
  /** `TR_BEGIN_DATA`, a single byte introducing the length-prefixed payload. */
  BEGIN_DATA: 0x61,
} as const;

/** Error codes. */
export const DftError = {
  /** `TR_ERR_EOF` — a GET past end of file. Not a failure: it ends an upload. */
  EOF: 0x2200,
  /** `TR_ERR_CMDFAIL` — what `dft_abort` always sends (`ft_dft.c:707`). */
  CMDFAIL: 0x0100,
} as const;

/**
 * `OPEN_MSG` (`ft_dft.c:52`). An `Open` whose trimmed name equals this is the
 * host announcing a MESSAGE, not a file — x3270 sets `message_flag` and pointedly
 * does NOT call `ft_running`, so it must not start a transfer.
 */
export const OPEN_MSG = 'FT:MSG';
```

- [ ] **Step 5: Add the SFID**

In `packages/core/src/constants.ts`, the `Sfid` block currently reads:

```typescript
export const Sfid = {
  READ_PARTITION: 0x01,
  QUERY_REPLY: 0x81,
} as const;
```

Make it:

```typescript
export const Sfid = {
  READ_PARTITION: 0x01,
  QUERY_REPLY: 0x81,
  /**
   * `SF_TRANSFER_DATA` — DFT file transfer, dispatched by x3270 at `sf.c:175`.
   * Both a host request type and the SFID we send our replies under. A host only
   * sends this if we advertised Query Reply (DDM) 0x95, which `-ddm on` does.
   */
  TRANSFER_DATA: 0xd0,
} as const;
```

- [ ] **Step 6: Run the test and the build**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: build clean, 5 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ft/dftFrames.ts packages/core/test/dftFrames.test.ts packages/core/src/constants.ts
git commit -m "feat(core): DFT wire constants, transcribed from ft_dft_ds.h

Constants only -- no behaviour yet. The header is the only written source for
these codes; the manual documents the DDM Query Reply that enables DFT but not
the request types.

Records the offset trap in the module comment: x3270's struct data_buffer
overlays the START of the structured field while parseStructuredFields hands out
parameters only, so every ft_dft.c offset is ours plus 3. Confirmed against TK5's
own frames -- field lengths 0x29/0x23 arrived as 38/32-byte payloads."
```

---

### Task 2: Parse a frame's request type and length

**Files:**
- Modify: `packages/core/src/ft/dftFrames.ts`
- Modify: `packages/core/test/dftFrames.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/dftFrames.test.ts`:

```typescript
import { parseDftFrame, DftFrameError } from '../src/ft/dftFrames.js';

describe('parseDftFrame', () => {
  it('reads the request type from offset 0 of the PARAMS, not offset 3', () => {
    // A minimal Open: request type only. x3270 would read this at cp+3; we get
    // params, so it is at 0. Getting this wrong is the bug this test exists for.
    const frame = parseDftFrame(Uint8Array.of(0x00, 0x12));
    expect(frame.requestType).toBe(0x0012);
  });

  it('reads a CLOSE', () => {
    expect(parseDftFrame(Uint8Array.of(0x41, 0x12)).requestType).toBe(0x4112);
  });

  it('keeps the whole payload, so handlers can read their own offsets', () => {
    const frame = parseDftFrame(Uint8Array.of(0x46, 0x11, 0xaa, 0xbb));
    expect(frame.requestType).toBe(0x4611);
    expect([...frame.payload]).toEqual([0x46, 0x11, 0xaa, 0xbb]);
  });

  it('refuses a payload too short to hold a request type', () => {
    expect(() => parseDftFrame(Uint8Array.of(0x00))).toThrow(DftFrameError);
    expect(() => parseDftFrame(new Uint8Array(0))).toThrow(/2 bytes/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: FAIL — `parseDftFrame` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/ft/dftFrames.ts`:

```typescript
/** A malformed DFT frame. A transfer fault, never a session fault. */
export class DftFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DftFrameError';
  }
}

/** A parsed DFT frame: the request type, and the payload it came from. */
export interface DftFrame {
  /** 16-bit request type from payload offset 0. One of `DftRequest`'s values. */
  requestType: number;
  /**
   * The whole payload, INCLUDING the request type. Handlers read their own
   * fields at their own offsets, so they need the original bytes rather than a
   * subarray whose offsets differ again.
   */
  payload: Uint8Array;
}

/**
 * Split a `SF_TRANSFER_DATA` payload into its request type and its bytes.
 *
 * `payload` is what `parseStructuredFields` yields: the parameters, with the
 * length bytes and the SFID already removed. So the request type x3270 reads at
 * `cp+3` is at **0** here. See the offset trap in this module's header comment.
 */
export function parseDftFrame(payload: Uint8Array): DftFrame {
  if (payload.length < 2) {
    throw new DftFrameError(
      `DFT frame needs at least 2 bytes for a request type, got ${payload.length}`,
    );
  }
  return { requestType: (payload[0]! << 8) | payload[1]!, payload };
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/ft/dftFrames.ts packages/core/test/dftFrames.test.ts
git commit -m "feat(core): parse a DFT frame's request type

Deliberately keeps the whole payload on the frame rather than a subarray: each
handler reads its own fields at its own offsets, and a second slice would shift
them a second time."
```

---

### Task 3: The `Open` request, both lengths and the `FT:MSG` branch

**Files:**
- Modify: `packages/core/src/ft/dftFrames.ts`
- Modify: `packages/core/test/dftFrames.test.ts`

This is the task the spec singles out. Two legal lengths, and a name that means "not a file".

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/dftFrames.test.ts`:

```typescript
import { parseDftOpen } from '../src/ft/dftFrames.js';

/**
 * Build an Open payload as OUR parser sees it: field length minus 3.
 * `len` is the FIELD length the host declares (0x23 or 0x29), so the payload is
 * len-3 bytes. The name sits at the x3270 offset minus 3.
 */
function openPayload(len: 0x23 | 0x29, name: string, recsz = 0): Uint8Array {
  const p = new Uint8Array(len - 3);
  p[0] = 0x00;
  p[1] = 0x12;                       // TR_OPEN_REQ
  const nameAt = len === 0x23 ? 25 : 31;   // CORRECTED: x3270's offsets, NOT minus 3
  if (len === 0x29) {
    p[27] = (recsz >> 8) & 0xff;     // recsz at x3270's cp+27 == our 27
    p[28] = recsz & 0xff;
  }
  // Name is 7 bytes, space-padded, EBCDIC on the wire but ASCII in x3270's
  // comparison because the host sends it as ASCII -- see the note in the impl.
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) p[nameAt + i] = padded.charCodeAt(i);
  return p;
}

describe('parseDftOpen', () => {
  it('accepts the short form, name at payload offset 25', () => {
    const open = parseDftOpen(openPayload(0x23, 'FT:DATA'));
    expect(open.name).toBe('FT:DATA');
    expect(open.recordSize).toBeUndefined();
    expect(open.isMessage).toBe(false);
  });

  it('accepts the long form, record size at 27 and name at 31', () => {
    const open = parseDftOpen(openPayload(0x29, 'FT:DATA', 1024));
    expect(open.name).toBe('FT:DATA');
    expect(open.recordSize).toBe(1024);
    expect(open.isMessage).toBe(false);
  });

  it('trims the name\'s trailing spaces, so a padded FT:MSG still matches', () => {
    const open = parseDftOpen(openPayload(0x23, 'FT:MSG'));
    expect(open.name).toBe('FT:MSG');
    expect(open.isMessage).toBe(true);
  });

  it('does NOT treat a message open as a file, which is the branch that matters', () => {
    expect(parseDftOpen(openPayload(0x29, 'FT:MSG', 80)).isMessage).toBe(true);
  });

  it('refuses any other length, as dft_open_request does', () => {
    // Anything but 0x23 or 0x29 is ftDftUnknownOpen (ft_dft.c:153-155).
    expect(() => parseDftOpen(new Uint8Array(0x24 - 3))).toThrow(/unknown Open length/);
    expect(() => parseDftOpen(new Uint8Array(0x28 - 3))).toThrow(/unknown Open length/);
  });

  it('BISECTS the boundary: 0x20 and 0x26 payloads pass, 0x21 and 0x25 do not', () => {
    // The payload lengths for the two legal FIELD lengths. Testing one grossly
    // wrong value would not catch an off-by-one in the subtraction, which is the
    // error this whole plan warns about.
    expect(() => parseDftOpen(new Uint8Array(0x20))).not.toThrow();
    expect(() => parseDftOpen(new Uint8Array(0x26))).not.toThrow();
    expect(() => parseDftOpen(new Uint8Array(0x21))).toThrow();
    expect(() => parseDftOpen(new Uint8Array(0x25))).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: FAIL — `parseDftOpen` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/ft/dftFrames.ts`:

**AS BUILT (`b17e319`, `5345d34`): the five offset constants below use a literal `3` in this
listing; the shipped code subtracts `X3270_HEADER_LEN` instead.** A quality review pointed out that
a `3` repeated five times, tied to correctness only by prose, was about to be repeated again in
`dft.ts` — so it became an exported constant. Tasks 5 and 6 now import it. Read the shipped
`dftFrames.ts`, not this block.

```typescript
/**
 * The two legal `Open` payload lengths, which are x3270's two legal FIELD
 * lengths minus the 3-byte header we never see.
 *
 * `dft_open_request` tests `len == 0x23` and `len == 0x29` on the field length
 * (`ft_dft.c:145-152`). TK5 sent both in one session, arriving here as 32 and 38
 * bytes, which is what confirmed the subtraction against a real host.
 */
const OPEN_SHORT = 0x23 - 3;   // 32
const OPEN_LONG = 0x29 - 3;    // 38

/** Name offsets, x3270's +25 / +31 less 3. */
const NAME_AT_SHORT = 25 - 3;  // 22
const NAME_AT_LONG = 31 - 3;   // 28
/** Record size offset, x3270's +27 less 3. */
const RECSZ_AT = 27 - 3;       // 24

/** How many bytes the name field occupies. `memcpy(namebuf, name, 7)`. */
const NAME_LENGTH = 7;

/** A parsed `Open`. */
export interface DftOpen {
  /** The 7-byte name with trailing spaces trimmed. */
  name: string;
  /**
   * `true` when the name is `FT:MSG`: the host is sending a MESSAGE, not opening
   * a file. x3270 sets `message_flag` and does not call `ft_running`
   * (`ft_dft.c:170-176`), so this must not start a transfer.
   */
  isMessage: boolean;
  /**
   * Record size, present only in the long form. Absent rather than 0 when the
   * host did not send one, because 0 is what x3270 uses as "no value" and an
   * optional property says so in the type.
   */
  recordSize?: number;
}

/**
 * Parse an `Open` request.
 *
 * The name is compared as ASCII. That looks wrong for a 3270 data stream and is
 * not: x3270 does `strcmp(namebuf, OPEN_MSG)` on the raw bytes with no EBCDIC
 * translation (`ft_dft.c:170`), and TK5's own frames carry ASCII `FT:DATA` —
 * observed in the 2026-09-24 probe trace. The name is metadata the host writes in
 * the PC's alphabet, not screen data.
 */
export function parseDftOpen(payload: Uint8Array): DftOpen {
  let nameAt: number;
  let recordSize: number | undefined;

  if (payload.length === OPEN_SHORT) {
    nameAt = NAME_AT_SHORT;
  } else if (payload.length === OPEN_LONG) {
    nameAt = NAME_AT_LONG;
    recordSize = (payload[RECSZ_AT]! << 8) | payload[RECSZ_AT + 1]!;
  } else {
    throw new DftFrameError(
      `unknown Open length: ${payload.length} payload bytes `
      + `(expected ${OPEN_SHORT} or ${OPEN_LONG}, i.e. field length 0x23 or 0x29)`,
    );
  }

  let name = '';
  for (let i = 0; i < NAME_LENGTH; i++) name += String.fromCharCode(payload[nameAt + i] ?? 0);
  // Trailing spaces only, matching x3270's backwards walk from namebuf[6]
  // (ft_dft.c:159-163). trimEnd() would also eat tabs and newlines, which are
  // legal name bytes; a host sending one would silently get a different name.
  name = name.replace(/ +$/, '');

  // `recordSize: undefined` would not typecheck under exactOptionalPropertyTypes
  // against an optional property, so the key is added only when it has a value.
  return recordSize === undefined
    ? { name, isMessage: name === OPEN_MSG }
    : { name, isMessage: name === OPEN_MSG, recordSize };
}
```

- [ ] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: 15 tests PASS.

- [ ] **Step 5: Mutation-check the name offset, which is the quiet failure**

Temporarily change `NAME_AT_LONG` from `31 - 3` to `31`. Rebuild and rerun.
Expected: the long-form tests FAIL. **Confirm the file actually changed before believing the result** — a silent no-match here would be a false "this offset is not load-bearing".
Then revert.

Repeat for `OPEN_SHORT`: change `0x23 - 3` to `0x23` and confirm the short-form tests redden. Revert.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/ft/dftFrames.ts packages/core/test/dftFrames.test.ts
git commit -m "feat(core): parse a DFT Open, both lengths and the FT:MSG branch

The two legal lengths are expressed as 0x23-3 and 0x29-3 rather than as 32 and
38, so the subtraction that this whole feature turns on is visible at the point
it happens. Both offsets mutation-checked; the name offset is the QUIET failure
(a wrong name simply never equals FT:MSG, and a message frame then starts a file
transfer), so it gets the boundary bisection rather than one wrong value.

The name is compared as ASCII, which is correct and looks wrong: x3270 strcmps
the raw bytes with no EBCDIC step, and TK5's own frames carry ASCII FT:DATA."
```

**AS BUILT CORRECTION (2026-09-25), APPLIED AFTER THIS TASK WAS ALREADY COMMITTED AND GREEN.** The
three `Open` offsets above were WRONG — 22/24/28 where the wire has 25/27/31 — and Task 3 shipped
them in `b17e319` with five passing tests. Fixed in `c0cdfad`, with the derivation in this plan's
fact 2 and in `dftFrames.ts`. The listing in step 3 has been corrected in place; if you are reading
this plan to implement, the numbers above are now right.

**The process lesson, which is the reusable part:** the defect was NOT catchable by the reviews this
task had, because the test helper and the parser shared the same wrong constant. A spec review reads
the plan (which was wrong), and a quality review reads the diff for internal consistency (which was
consistent). What found it was **re-deriving the offsets from the C source while implementing a LATER
task** — Task 5 needed `Data Insert`'s offsets, checking those meant reading `ft_dft_data`'s
pointer handling, and the pointer handling is where the Open's `cp` is set. So: when a later task
touches the same source function, re-read it rather than trusting the earlier task's transcription.
See [[implementers-should-verify-not-trust-plans]] — this is that lesson applied to my own committed
code rather than to a plan.

---

### Task 4: Reply builders

**Files:**
- Modify: `packages/core/src/ft/dftFrames.ts`
- Modify: `packages/core/test/dftFrames.test.ts`

Four replies, all fixed-shape. Byte counts come from x3270's `space3270out` calls.

- [x] **Step 1: Write the failing test**

Append to `packages/core/test/dftFrames.test.ts`:

```typescript
import { buildOpenAck, buildCloseAck, buildDataAck, buildDftError } from '../src/ft/dftFrames.js';

describe('DFT reply builders', () => {
  it('builds the Open acknowledgement, 6 bytes', () => {
    // ft_dft.c:180-189: AID_SF, SET16(5), SF_TRANSFER_DATA, SET16(9).
    expect([...buildOpenAck()]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x00, 0x09]);
  });

  it('builds the Close acknowledgement, 6 bytes ending in TR_CLOSE_REPLY', () => {
    // ft_dft.c:681-687.
    expect([...buildCloseAck()]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x41, 0x09]);
  });

  it('builds a data acknowledgement carrying a 32-bit record number', () => {
    // ft_dft.c:203-215: AID_SF, SET16(11), SF, TR_NORMAL_REPLY, TR_RECNUM_HDR,
    // SET32(recnum). 12 bytes.
    expect([...buildDataAck(1)]).toEqual([
      0x88, 0x00, 0x0b, 0xd0, 0x47, 0x05, 0x63, 0x06, 0x00, 0x00, 0x00, 0x01,
    ]);
  });

  it('puts a large record number in big-endian order', () => {
    expect([...buildDataAck(0x01020304)].slice(8)).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  it('builds an error reply borrowing the failed request\'s high byte', () => {
    // ft_dft.c:697-708: AID_SF, SET16(9), SF, HIGH8(code), TR_ERROR_REPLY,
    // TR_ERROR_HDR, TR_ERR_CMDFAIL. 10 bytes. The reply type's high byte comes
    // from the REQUEST that failed -- 0x46 for a GET -- which is why ERROR is an
    // 8-bit constant.
    expect([...buildDftError(0x4611)]).toEqual([
      0x88, 0x00, 0x09, 0xd0, 0x46, 0x08, 0x69, 0x04, 0x01, 0x00,
    ]);
  });

  it('borrows 0x00 from an Open, since TR_OPEN_REQ is 0x0012', () => {
    expect([...buildDftError(0x0012)].slice(4, 6)).toEqual([0x00, 0x08]);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: FAIL — the builders are not exported.

- [x] **Step 3: Implement**

Append to `packages/core/src/ft/dftFrames.ts`:

```typescript
import { AID, Sfid } from '../constants.js';

/**
 * Big-endian 16-bit. **Exported because `ft/dft.ts` needs it in Task 6** — the
 * alternative is a second copy in that file, and two hand-rolled big-endian
 * writers that could disagree is exactly the kind of drift this project has been
 * bitten by. Matches x3270's `SET16` macro (`include/3270ds.h:341-344`).
 */
export function u16(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}

/**
 * Big-endian 32-bit, for the record number. Exported for the same reason as
 * `u16`. `>>>` not `>>`: a record number above 0x7fffffff would sign-extend and
 * produce a negative high byte with `>>`.
 */
export function u32(n: number): [number, number, number, number] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * Every reply starts `AID_SF, L, L, SF_TRANSFER_DATA`, where L is the structured
 * field length COUNTING ITSELF AND THE SFID BUT NOT THE AID — x3270 writes
 * `SET16(obptr, 5)` before a 6-byte buffer (`ft_dft.c:184`).
 *
 * So `length` here is `bytes.length + 3`: two length bytes, one SFID, and the
 * caller's payload. The AID is outside the count.
 */
function reply(...body: number[]): Uint8Array {
  return Uint8Array.of(AID.SF, ...u16(body.length + 3), Sfid.TRANSFER_DATA, ...body);
}

/** Acknowledge an `Open`. `ft_dft.c:180-189`. */
export function buildOpenAck(): Uint8Array {
  // The literal 0x0009 is x3270's, and it is NOT one of the TR_ constants -- it
  // has no name in the header. Left as a number with this note rather than
  // invented a name for.
  return reply(...u16(0x0009));
}

/** Acknowledge a `Close`. `ft_dft.c:681-687`. */
export function buildCloseAck(): Uint8Array {
  return reply(...u16(DftReply.CLOSE));
}

/** Acknowledge received data, carrying the record number. `ft_dft.c:203-215`. */
export function buildDataAck(recordNumber: number): Uint8Array {
  return reply(...u16(DftReply.NORMAL), ...u16(DftHeader.RECNUM), ...u32(recordNumber));
}

/**
 * Report a failure. `ft_dft.c:697-708`.
 *
 * `failedRequest` supplies the high byte of the reply type, which is why
 * `DftReply.ERROR` is 8 bits: x3270 writes `HIGH8(code)` then the error byte, so
 * a failed GET (`0x4611`) yields reply type `0x4608`. The code sent is always
 * `TR_ERR_CMDFAIL`; `TR_ERR_EOF` is used only by the upload's own EOF frame.
 */
export function buildDftError(failedRequest: number): Uint8Array {
  return reply(
    (failedRequest >> 8) & 0xff,
    DftReply.ERROR,
    ...u16(DftHeader.ERROR),
    ...u16(DftError.CMDFAIL),
  );
}
```

- [x] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftFrames.test.ts`
Expected: 21 tests PASS.

- [x] **Step 5: Mutation-check the length arithmetic**

Change `body.length + 3` to `body.length`. Rebuild, rerun.
Expected: **every** builder test fails on its length bytes. Confirm the edit landed, then revert.

This matters because `+3` is the one place the AID-outside-the-count rule lives, and it is easy to "simplify".

- [x] **Step 6: Commit**

```bash
git add packages/core/src/ft/dftFrames.ts packages/core/test/dftFrames.test.ts
git commit -m "feat(core): DFT reply builders

One `reply` helper owns the rule that the SF length counts itself and the SFID
but NOT the AID -- x3270 writes SET16(5) before a 6-byte buffer. Mutation-checked:
dropping the +3 reddens every builder.

Error replies borrow the high byte of whatever request failed, which is why
DftReply.ERROR is an 8-bit constant and looks like an odd one."
```

**AS BUILT (2026-09-25).** Done inline, not subagent-driven, on remaining budget. All 25 tests in
`dftFrames.test.ts` pass; suite 1986 -> **1996 in 79 files**, build/typecheck clean. Every byte was
re-verified against `~/src/suite3270-4.5/Common/ft_dft.c` and `include/ft_dft_ds.h` before the code
was written, and **all four reply byte-sequences the plan asserts are correct as written.** Six
differences from the plan, none of which changed a wire byte:

1. **The plan's mutation prediction OVERSTATES.** It says dropping `+3` fails "**every** builder
   test". It fails **4 of 7**: the three that assert a `.slice()` past the length bytes still pass,
   because the mutation only moves bytes 1-2. So the load-bearing guard is the four FULL-SEQUENCE
   assertions and must be quoted that way. The edit was asserted to land (per fact 5) via a script
   that aborts if the target string is absent.
2. **`u32`'s `>>>` rationale was FALSE.** The plan says `>>` "would sign-extend and produce a
   negative high byte". Measured across `0x80000000` and `0xffffffff`: `& 0xff` truncates either way
   and the bytes are IDENTICAL. `>>>` is kept because the value is unsigned, but the comment now says
   it is not load-bearing — an unfalsifiable claim in a comment is the same defect this repo already
   recorded for `& 0xff` in `encodeHeader`.
3. **Four citation ranges were off by one at the start.** `:180` is blank, so OpenAck is
   **`:181-189`**; CloseAck is **`:680-687`** (`:679` is the `trace_ds(" Close")`), DataAck
   **`:206-214`**, error **`:698-706`**. The plan's `:180-189`, `:681-687`, `:203-215`, `:697-708`
   were each a line out. Verified line-by-line with `sed`, not by eye.
4. **The import goes at the TOP.** The plan's step 3 says "append to `dftFrames.ts`" with the
   `import` inside the appended block; the file had no imports at all, so a mid-file import would
   have been legal TS but wrong style for this repo. Added after the module header comment.
5. **`u16` was NOT shared with `queryreply.ts`**, which already has a module-private one. That one
   range-checks and throws because a Query Reply's self-describing lengths corrupt the whole unit if
   wrong; these are called with our own constants. Coupling two unrelated wire modules buys nothing.
   Recorded in the doc comment so it is not "fixed" later.
6. **Three tests added beyond the plan's six** (hence 25, not the predicted 21): the two writers are
   pinned directly, and one test pins that `buildDataAck` holds **no state** — x3270 increments a
   static `recnum` inside `dft_data_ack` (`:213`) and ours takes an argument, so the counter belongs
   to Task 5. A builder owning it could not construct two acks for one record, which is what a
   retransmit needs. That is a Task 5/6 design constraint, pinned here where it is cheap.

`buildOpenAck` is sent for an `FT:MSG` open too — x3270 acknowledges at `:181` before testing
`message_flag` at `:171-176`. Task 5 must not skip the ack on the message branch.

---

### Task 5: The state machine — download

**Files:**
- Create: `packages/core/src/ft/dft.ts`
- Create: `packages/core/test/dft.test.ts`

`DftTransfer` mirrors `CutTransfer`'s shape — single-use, an `outcome` once finished — but takes a payload and returns bytes rather than taking a `Screen` and returning an AID.

- [x] **Step 1: Write the failing test**

Create `packages/core/test/dft.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DftTransfer } from '../src/ft/dft.js';
import { DftRequest, DftHeader } from '../src/ft/dftFrames.js';

/** An Open payload, short form, named for a file. */
function open(name = 'FT:DATA'): Uint8Array {
  const p = new Uint8Array(0x23 - 3);
  p[0] = 0x00; p[1] = 0x12;
  const padded = name.padEnd(7, ' ');
  for (let i = 0; i < 7; i++) p[22 + i] = padded.charCodeAt(i);
  return p;
}

/**
 * A `Data Insert` payload carrying `data`.
 *
 * Layout after the request type, from `struct data_buffer`: compress indicator
 * (2), begin-data (1), data length (2), then the data. All offsets less 3.
 * The length field is the data length PLUS 5 (`ft_dft.c:236`).
 */
function dataInsert(data: number[]): Uint8Array {
  return Uint8Array.of(
    0x47, 0x04,                                  // TR_DATA_INSERT
    0xc0, 0x80,                                  // TR_NOT_COMPRESSED
    0x61,                                        // TR_BEGIN_DATA
    ((data.length + 5) >> 8) & 0xff, (data.length + 5) & 0xff,
    ...data,
  );
}

/** A bare request with no extra fields. */
function bare(type: number): Uint8Array {
  return Uint8Array.of((type >> 8) & 0xff, type & 0xff);
}

describe('DftTransfer, download (receive)', () => {
  it('acknowledges an Open without completing', () => {
    const t = new DftTransfer({ direction: 'receive' });
    const step = t.handle(open());
    expect([...step.reply!]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x00, 0x09]);
    expect(step.done).toBeUndefined();
    expect(t.complete).toBe(false);
  });

  it('collects data and acknowledges each record with an increasing number', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    const first = t.handle(dataInsert([0x41, 0x42]));
    expect([...first.reply!].slice(8)).toEqual([0x00, 0x00, 0x00, 0x01]);
    const second = t.handle(dataInsert([0x43]));
    expect([...second.reply!].slice(8)).toEqual([0x00, 0x00, 0x00, 0x02]);
  });

  it('acknowledges a Close WITHOUT ending the transfer', () => {
    // The obvious guess is that Close finishes a download. It does not.
    // ft_complete is called from exactly three places, all in the message branch
    // of dft_data_insert (ft_dft.c:270, :273, :276); dft_close_request only writes
    // a CloseAck. Completing here would report success before the host said
    // TRANS03 -- before it has committed the file.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41, 0x42]));
    const step = t.handle(bare(DftRequest.CLOSE));
    expect([...step.reply!]).toEqual([0x88, 0x00, 0x05, 0xd0, 0x41, 0x09]);
    expect(step.done).toBeUndefined();
    expect(t.complete).toBe(false);
  });

  it('hands over the received bytes on the host\'s TRANS03 message, in order', () => {
    // The REAL sequence, from message_flag being one flag reset by every Open
    // (ft_dft.c:171-175):
    //   Open(FT:DATA) -> Data... -> Close -> Open(FT:MSG) -> Data(TRANS03)
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41, 0x42]));
    t.handle(dataInsert([0x43]));
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));                 // the SECOND Open, same instance
    const msg = [...'TRANS03'].map((c) => c.charCodeAt(0));
    const step = t.handle(dataInsert(msg));
    expect(step.done).toEqual({ ok: true, data: Uint8Array.of(0x41, 0x42, 0x43) });
    expect(t.complete).toBe(true);
  });

  it('subtracts 5 from the declared length, so a wrong length truncates visibly', () => {
    // ft_dft.c:236 `my_length -= 5`. A payload declaring 7 carries 2 data bytes.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x41, 0x42, 0x43, 0x44]));
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    const done = t.handle(dataInsert([...'TRANS03'].map((c) => c.charCodeAt(0)))).done!;
    expect(done).toEqual({ ok: true, data: Uint8Array.of(0x41, 0x42, 0x43, 0x44) });
  });

  it('a second Open for a MESSAGE does not discard the file bytes already received', () => {
    // messageFlag flips on the second Open, and the chunks must survive it. If
    // onOpen cleared them, every download would deliver an empty file while
    // reporting success -- the failure stage 1 warns to look for.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(dataInsert([0x99]));
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    expect(t.isMessage).toBe(true);
    const done = t.handle(dataInsert([...'TRANS03'].map((c) => c.charCodeAt(0)))).done!;
    expect(done).toEqual({ ok: true, data: Uint8Array.of(0x99) });
  });

  it('treats an FT:MSG Open as a message and NOT as a file transfer', () => {
    const t = new DftTransfer({ direction: 'receive' });
    const step = t.handle(open('FT:MSG'));
    expect(step.reply).toBeDefined();
    expect(t.isMessage).toBe(true);
    expect(t.complete).toBe(false);
  });

  it('completes successfully when a message says TRANS03', () => {
    // ft_dft.c:266-269: END_TRANSFER means ft_complete(NULL), a clean finish.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const msg = [...'TRANS03'].map((c) => c.charCodeAt(0));
    const step = t.handle(dataInsert(msg));
    expect(step.done).toEqual({ ok: true });
  });

  it('fails with the host\'s own message text when a message is not TRANS03', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const msg = [...'TRANS99 - Protocol error'].map((c) => c.charCodeAt(0));
    const step = t.handle(dataInsert(msg));
    expect(step.done?.ok).toBe(false);
    expect(step.done).toMatchObject({ error: 'TRANS99 - Protocol error' });
  });

  it('truncates a message at a dollar sign, as x3270 does', () => {
    // ft_dft.c:257-262: memchr for '$' becomes the terminator.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open('FT:MSG'));
    const msg = [...'TRANS99 oops$ignored'].map((c) => c.charCodeAt(0));
    expect(t.handle(dataInsert(msg)).done).toMatchObject({ error: 'TRANS99 oops' });
  });

  it('sends NOTHING for Set Cursor and Insert, because x3270 sends nothing', () => {
    // Both x3270 handlers are empty functions that trace and return
    // (ft_dft.c:193-198, :417-422). Replying would put unsolicited bytes on the
    // wire to a live mainframe mid-transfer, so `reply` must be absent -- not an
    // Open ack, which is what an earlier draft of the plan wrongly specified.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    for (const req of [DftRequest.SET_CUR, DftRequest.INSERT]) {
      const step = t.handle(bare(req));
      expect(step.reply).toBeUndefined();
      expect(step.done).toBeUndefined();
    }
    expect(t.complete).toBe(false);
  });

  it('is inert after completion, and keeps reporting the same outcome', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.handle(bare(DftRequest.CLOSE));
    t.handle(open('FT:MSG'));
    const done = t.handle(dataInsert([...'TRANS03'].map((c) => c.charCodeAt(0)))).done;
    const after = t.handle(dataInsert([0x41]));
    expect(after.reply).toBeUndefined();
    expect(after.done).toEqual(done);
  });

  it('reports an unknown request type for tracing and sends NOTHING', () => {
    // x3270 traces Unsupported(0x%04x) and breaks (ft_dft.c:131-133). It does not
    // send an error reply, and an earlier draft of this plan wrongly said it did.
    // `unsupported` exists so the caller can trace it: a silent drop with nothing
    // in the log is how an unimplemented request becomes an unexplainable stall.
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    const step = t.handle(bare(0x9999));
    expect(step.reply).toBeUndefined();
    expect(step.unsupported).toBe(0x9999);
    expect(step.done).toBeUndefined();
    expect(t.complete).toBe(false);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dft.test.ts`
Expected: FAIL — cannot resolve `../src/ft/dft.js`.

- [x] **Step 3: Implement**

Create `packages/core/src/ft/dft.ts`:

```typescript
/**
 * The DFT file-transfer state machine.
 *
 * ## WHY THIS IS A SEPARATE ENGINE FROM `CutTransfer`
 *
 * CUT is screen-shaped: it takes a `Screen`, parses a frame out of fixed offsets
 * in a 1920-cell buffer, writes a response back into it, and returns an AID to
 * press. That is why CUT works only at 24x80 and why `frames.ts` throws on any
 * other geometry.
 *
 * DFT is record-shaped. **This module imports no `Screen` and no `Session`**, and
 * that is the feature, not an accident of layering: it is what lets a transfer run
 * at 43x80, which is the user's own working geometry and the reason this stage
 * exists. `ft_dft.c` has zero screen-buffer references against 25 in `ft_cut.c`.
 *
 * One instance per transfer, single-use like `CutTransfer` — once `handle` has
 * returned a `done`, the transfer is over and further calls are inert.
 */
import {
  DftRequest,
  X3270_HEADER_LEN,
  buildCloseAck,
  buildDataAck,
  buildDftError,
  buildOpenAck,
  parseDftFrame,
  parseDftOpen,
} from './dftFrames.js';
import type { TransferDirection, TransferResult } from './transfer.js';

/**
 * x3270's own message strings, so a failure here reads like wc3270's.
 * `fb-common:35` and `ft_dft.c:53`.
 */
const MSG = {
  /** `ftUserCancel`. The same string stage 1 adopted for CUT. */
  USER_CANCEL: 'Transfer canceled by user',
} as const;

/** `END_TRANSFER` (`ft_dft.c:53`): the host's own "transfer complete" message. */
const END_TRANSFER = 'TRANS03';

/**
 * Offsets into a `Data Insert` payload, x3270's less the header it counts and we
 * do not. **Use the imported `X3270_HEADER_LEN`, not a literal 3** — Task 3
 * introduced it precisely so this second file could not drift from the first.
 * Offsets are into `struct data_buffer` (`ft_dft.c:59-67`).
 */
const DATA_LENGTH_AT = 8 - X3270_HEADER_LEN;   // 5: data_buffer.data_length
const DATA_AT = 10 - X3270_HEADER_LEN;         // 7: data_buffer.data
/** The declared data length counts 5 bytes of header. `ft_dft.c:236`. */
const LENGTH_OVERHEAD = 5;

export interface DftOptions {
  direction: TransferDirection;
  /** For `send`, the bytes to put on the host. Required for `send`. */
  data?: Uint8Array | readonly number[];
}

/** What one inbound frame produced. */
export interface DftStep {
  /**
   * The reply to send, as a complete inbound record starting with `AID_SF`.
   *
   * **Absent is a real answer, not a gap.** Set Cursor, Insert and an unknown
   * request type all produce no reply, because x3270's handlers for all three
   * trace and return. Sending something would put unsolicited bytes on the wire
   * mid-transfer.
   */
  reply?: Uint8Array;
  /** Present exactly once, on the frame that ends the transfer. */
  done?: TransferResult;
  /**
   * The request type, when it was one we do not implement. For the caller to
   * trace — x3270 logs `Unsupported(0x%04x)` and carries on (`ft_dft.c:131-133`),
   * and a silent drop with nothing in the log is how an unimplemented request
   * becomes an unexplainable stall.
   */
  unsupported?: number;
}

export class DftTransfer {
  readonly direction: TransferDirection;

  /** local->host: the source bytes. Empty for a `receive`. */
  private readonly source: Uint8Array;
  /** local->host: how many source bytes have gone out. */
  private offset = 0;

  /** host->local: received chunks, joined once at the end. */
  private readonly chunks: Uint8Array[] = [];
  private receivedLength = 0;

  /** The record number on the next acknowledgement. `recnum` starts at 1. */
  private recordNumber = 1;

  /**
   * Did the host open `FT:MSG` rather than a file? Public because the session
   * needs it: a message transfer must not be reported as a file transfer.
   */
  private messageFlag = false;

  /** Has the operator asked to cancel? Checked on the inbound edge. */
  private cancelRequested = false;

  private outcome: TransferResult | undefined;

  constructor(opts: DftOptions) {
    this.direction = opts.direction;
    if (opts.direction === 'send') {
      if (opts.data === undefined) {
        throw new TypeError("a 'send' transfer needs the bytes to send");
      }
      this.source = opts.data instanceof Uint8Array ? opts.data : Uint8Array.from(opts.data);
    } else {
      if (opts.data !== undefined) {
        throw new TypeError("a 'receive' transfer takes no data; the host supplies it");
      }
      this.source = new Uint8Array(0);
    }
  }

  get result(): TransferResult | undefined { return this.outcome; }
  get complete(): boolean { return this.outcome !== undefined; }
  get isMessage(): boolean { return this.messageFlag; }
  /** Bytes transferred so far, for a progress display. */
  get transferred(): number {
    return this.direction === 'send' ? this.offset : this.receivedLength;
  }

  /**
   * Ask for the transfer to stop. Idempotent, and deliberately does NOT send
   * anything: DFT defers, checking the flag on the next inbound frame
   * (`ft_dft.c:225-228`, `:576-579`). CUT sends its abort immediately because a
   * front end closing a form has no later frame to wait on; a DFT transfer always
   * has a next inbound frame, so the deferral is free and matches x3270.
   */
  cancel(): void {
    this.cancelRequested = true;
  }

  /** Feed one `SF_TRANSFER_DATA` payload in; get the reply out. */
  handle(payload: Uint8Array): DftStep {
    if (this.outcome !== undefined) return { done: this.outcome };

    const frame = parseDftFrame(payload);

    // The cancellation edge: x3270 tests this in dft_data_insert and
    // dft_get_request, before processing either (ft_dft.c:225, :576). NOT for a
    // message frame, which is how the host's own final message still gets read.
    if (this.cancelRequested && !this.messageFlag
      && (frame.requestType === DftRequest.DATA_INSERT || frame.requestType === DftRequest.GET)) {
      return this.fail(MSG.USER_CANCEL, frame.requestType);
    }

    switch (frame.requestType) {
      case DftRequest.OPEN: return this.onOpen(frame.payload);
      case DftRequest.DATA_INSERT: return this.onDataInsert(frame.payload);
      case DftRequest.CLOSE: return this.onClose();
      // NEITHER SENDS ANYTHING. Both x3270 handlers trace and return -- they are
      // empty functions, `dft_insert_request` at ft_dft.c:193-198 and
      // `dft_set_cur_req` at :417-422, each carrying the comment "Doesn't
      // currently do anything". So the correct reply is NO reply.
      //
      // An earlier draft of this plan had these acknowledge with an Open ack,
      // which would put six unsolicited bytes on the wire to a live mainframe
      // mid-transfer. Returning {} is not laziness; it is what the reference does.
      case DftRequest.SET_CUR:
      case DftRequest.INSERT: return {};
      default:
        // ALSO SILENT. x3270's default arm traces "Unsupported(0x%04x)" and
        // breaks (ft_dft.c:131-133) -- it does not send an error reply, and
        // inventing one would answer a frame the host may not expect an answer to.
        // The caller traces; this returns nothing.
        return { unsupported: frame.requestType };
    }
  }

  private onOpen(payload: Uint8Array): DftStep {
    const open = parseDftOpen(payload);
    this.messageFlag = open.isMessage;
    this.recordNumber = 1;
    return { reply: buildOpenAck() };
  }

  private onDataInsert(payload: Uint8Array): DftStep {
    const declared = (payload[DATA_LENGTH_AT]! << 8) | payload[DATA_LENGTH_AT + 1]!;
    const length = declared - LENGTH_OVERHEAD;
    const data = payload.subarray(DATA_AT, DATA_AT + Math.max(0, length));

    if (this.messageFlag) return this.onMessage(data);

    if (data.length > 0) {
      this.chunks.push(Uint8Array.from(data));
      this.receivedLength += data.length;
    }
    const reply = buildDataAck(this.recordNumber);
    this.recordNumber++;
    return { reply };
  }

  /**
   * A message frame. **This is the completion channel** — the host's text ends the
   * transfer either way, and it is the only path on which `ft_complete` is called.
   * On a download the received bytes are handed over here, not on the `Close`.
   */
  private onMessage(data: Uint8Array): DftStep {
    const reply = buildDataAck(this.recordNumber);
    this.recordNumber++;

    let text = '';
    for (const b of data) text += String.fromCharCode(b);
    // A '$' terminates the message (ft_dft.c:257-262).
    const dollar = text.indexOf('$');
    if (dollar >= 0) text = text.slice(0, dollar);

    if (text.startsWith(END_TRANSFER)) {
      this.outcome = this.direction === 'receive'
        ? { ok: true, data: this.join() }
        : { ok: true };
    } else {
      this.outcome = { ok: false, error: text };
    }
    return { reply, done: this.outcome };
  }

  /**
   * A `Close` acknowledges and **does NOT end the transfer.**
   *
   * MEASURED FROM THE SOURCE, and it is the opposite of the obvious guess:
   * `ft_complete` is called from exactly three places, all inside the message
   * branch of `dft_data_insert` (`ft_dft.c:270`, `:273`, `:276`).
   * `dft_close_request` (`:672-688`) only writes a CloseAck. The real sequence is:
   *
   *     Open("FT:DATA") -> Data... -> Close -> Open("FT:MSG") -> Data(TRANS03)
   *
   * and it is that last message that completes the transfer. `message_flag` is one
   * flag reset by every `Open` (`:171-175`), which is what lets a single transfer
   * be a file and then a message.
   *
   * So this instance MUST survive its own Close. Ending here would report success
   * before the host said `TRANS03` — i.e. before the host has committed the file —
   * and would discard the host's error text on a failure, which is the one channel
   * that carries it.
   */
  private onClose(): DftStep {
    return { reply: buildCloseAck() };
  }

  private fail(error: string, failedRequest: number): DftStep {
    this.outcome = { ok: false, error };
    return { reply: buildDftError(failedRequest), done: this.outcome };
  }

  private join(): Uint8Array {
    const out = new Uint8Array(this.receivedLength);
    let at = 0;
    for (const c of this.chunks) { out.set(c, at); at += c.length; }
    return out;
  }
}
```

- [x] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dft.test.ts`
Expected: 12 tests PASS.

- [x] **Step 5: Mutation-check the length subtraction**

Remove `- LENGTH_OVERHEAD` (i.e. `const length = declared;`). Rebuild, rerun.
Expected: the data tests fail with 5 extra bytes. Confirm the edit landed, then revert.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/ft/dft.ts packages/core/test/dft.test.ts
git commit -m "feat(core): the DFT state machine, download path

Takes a structured-field payload and returns reply bytes. Imports no Screen and
no Session -- that is the feature and not an accident of layering, since it is
what lets a transfer run at 43x80 where CUT refuses.

Two behaviours that are easy to get backwards and are pinned: an FT:MSG open is a
MESSAGE and must not start a file transfer, and a message frame ENDS the transfer
(TRANS03 means success, anything else is the host's own error text, truncated at a
'\$'). Cancellation is deferred to the next inbound frame, matching x3270, unlike
CUT where we deliberately send immediately."
```

**AS BUILT (2026-09-25).** Inline, not subagent-driven. **26 -> 27 tests in `dft.test.ts`; suite
1998 -> 2025 in 80 files**, build/typecheck clean. The plan predicted 12 tests; 27 shipped. The design
was right in every respect — `Close` does not complete, `FT:MSG` must not start a transfer, Set
Cursor/Insert/unknown are silent, cancellation defers — and all of that is as written. What the plan
lacked was found by reading `ft_dft.c` again rather than trusting the plan's prose.

**THREE BEHAVIOURS MISSING FROM THE PLAN, in descending order of how badly each would have hurt:**

1. **`TRANS03` IS A PREFIX MATCH, NOT EQUALITY.** `memcmp(msgp, END_TRANSFER, strlen(END_TRANSFER))`
   at `:268` compares 7 bytes only. A real host sends `TRANS03` followed by its own wording, so
   `text === END_TRANSFER` would report **every successful transfer as a failure whose error text is
   the success message.** The plan's own listing used `startsWith`, so the code was right — but
   nothing in the plan *said* why, and no test distinguished the two until one was added.
   **This is the defect a synthetic-frame suite structurally cannot find**, because the frames the
   tests build are the ones the plan imagined, and it would have surfaced only on TK5 in Task 10.
2. **The completing frame carries BOTH a `reply` and a `done`.** `dft_data_ack()` is called at `:250`,
   before the text is inspected at `:267`. Completing without replying leaves the host's final frame
   unacknowledged.
3. **An empty data frame is ACKNOWLEDGED, not an error.** x3270's `if (my_length > 0)` guard closes at
   `:407`; `dft_data_ack()` is at `:410`, outside it.

**TWO MUTATION CHECKS PASSED VACUOUSLY, WHICH IS THE PROCESS FINDING — fact 5 says a mutation must
assert its target was found, and both of these DID; the target was found, the edit landed, and the
tests still passed. Landing is necessary and not sufficient.**

- **Step 5's own check, dropping `- LENGTH_OVERHEAD`, left 24 of 24 GREEN.** Every payload
  `dataInsert` builds ends exactly where its data ends, and `subarray(7, 7+len)` **clamps at the
  buffer end** — so reading 5 bytes too many returned the identical bytes. The plan asserts this
  mutation makes "the data tests fail with 5 extra bytes"; it does not, with that helper.
  `dataInsertPadded` now appends trailing junk so the over-read swallows something, and the mutation
  reddens 2 tests **on content**. A host may pad a frame; the declared length is what says where data
  stops, so this is a real-frame case and not a contrived one.
- **Deleting `this.recordNumber = 1` left 26 of 26 green.** `recnum = 1` at `:178` runs on **every**
  Open — it is the only assignment besides the two increments — so after the second Open the message
  frame is acked as **record 1**, not as a continuation. The download sequence contains a second Open,
  so this is observable; nothing asserted the number on that final ack. Now pinned.

**The generalisable rule: a mutation that lands and changes nothing means the TEST is weak, not that
the code is dead.** Both of these read as "this line is not load-bearing", which is the most
misleading result available — and both lines were load-bearing.

**Mutation-verified guards, four of them:** the `-5` subtraction (2 tests), the `TRANS03` prefix match
(1), the `recnum` reset (1), and the `!messageFlag` exemption in the cancel guard that lets the host's
final message still be read after a cancel (1).

**One deviation from the plan's listing:** `MSG.USER_CANCEL` is **not** redeclared here. `transfer.ts`
already has that exact string for CUT, so it is exported as `FT_MSG` and imported — one x3270 message,
two engines reporting it, and two literals could drift into two different "canceled by user" texts.
The rest of CUT's `MSG` stays private, being control-code names DFT has no use for.

**Note for Task 7:** `payload` is a view into the inbound record's buffer, so `onDataInsert` copies
with `Uint8Array.from` rather than retaining the subarray. If the plumbing hands us a buffer it then
reuses, a retained view would alias it and corrupt every chunk but the last.

**A test-layout inconsistency, left alone deliberately:** CUT's tests live in `test/ft/`, while Task 3
put `dftFrames.test.ts` at `test/` top level and this plan specifies `test/dft.test.ts`. Moving them
is churn on a branch mid-flight; noted so it is a decision rather than an oversight.

---

### Task 6: The state machine — upload, and the retained buffer

**Files:**
- Modify: `packages/core/src/ft/dft.ts`
- Modify: `packages/core/test/dft.test.ts`

The `GET` path. It also produces the buffer the Read Modified hook re-sends, which is Task 8.

- [x] **Step 1: Write the failing test**

Append to `packages/core/test/dft.test.ts`:

```typescript
describe('DftTransfer, upload (send)', () => {
  it('answers a Get with a data frame carrying the file bytes', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41, 0x42, 0x43) });
    t.handle(open());
    const step = t.handle(bare(DftRequest.GET));
    const b = [...step.reply!];
    // The whole frame, computed by hand from ft_dft.c:626-641. Pinned entire
    // rather than field-by-field only, because the SF LENGTH is the byte most
    // likely to be wrong: it is 16+data, EXCLUDING the AID (obptr - (obuf+1),
    // ft_dft.c:655), while the data still lands at index 17.
    expect(b).toEqual([
      0x88, 0x00, 0x13, 0xd0, 0x46, 0x05, 0x63, 0x06, 0x00, 0x00, 0x00, 0x01,
      0xc0, 0x80, 0x61, 0x00, 0x08, 0x41, 0x42, 0x43,
    ]);
    expect(b[0]).toBe(0x88);                       // AID_SF
    expect(b.slice(1, 3)).toEqual([0x00, 0x13]);   // 3 data + 16, not + 17
    expect(b[3]).toBe(0xd0);                       // SF_TRANSFER_DATA
    expect(b.slice(4, 6)).toEqual([0x46, 0x05]);   // TR_GET_REPLY
    expect(b.slice(6, 8)).toEqual([0x63, 0x06]);   // TR_RECNUM_HDR
    expect(b.slice(8, 12)).toEqual([0x00, 0x00, 0x00, 0x01]);
    expect(b.slice(12, 14)).toEqual([0xc0, 0x80]); // TR_NOT_COMPRESSED
    expect(b[14]).toBe(0x61);                      // TR_BEGIN_DATA
    expect(b.slice(15, 17)).toEqual([0x00, 0x08]); // 3 data bytes + 5
    expect(b.slice(17)).toEqual([0x41, 0x42, 0x43]);
  });

  it('sends an EOF frame when the source is exhausted, and that is not a failure', () => {
    // ft_dft.c:644-651: HIGH8(TR_GET_REQ), TR_ERROR_REPLY, TR_ERROR_HDR,
    // TR_ERR_EOF. 0x2200 is "get past end of file", which ENDS an upload cleanly.
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    t.handle(bare(DftRequest.GET));
    const eof = t.handle(bare(DftRequest.GET));
    expect([...eof.reply!]).toEqual([
      0x88, 0x00, 0x09, 0xd0, 0x46, 0x08, 0x69, 0x04, 0x22, 0x00,
    ]);
    // EOF does not end the transfer, and neither will the Close that follows it:
    // an upload completes the same way a download does, on the host's own FT:MSG
    // TRANS03. Reporting success at EOF would claim the host had committed the
    // file when we had only finished handing it over.
    expect(eof.done).toBeUndefined();
  });

  it('completes an upload on the host\'s message, not at EOF or Close', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    t.handle(bare(DftRequest.GET));
    expect(t.handle(bare(DftRequest.GET)).done).toBeUndefined();   // EOF
    expect(t.handle(bare(DftRequest.CLOSE)).done).toBeUndefined(); // CloseAck
    t.handle(open('FT:MSG'));
    const step = t.handle(dataInsert([...'TRANS03'].map((c) => c.charCodeAt(0))));
    expect(step.done).toEqual({ ok: true });     // no `data` on a send
    expect(t.transferred).toBe(1);
  });

  it('splits a source larger than the buffer across several Gets', () => {
    const data = new Uint8Array(100).fill(0x5a);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 300 });
    t.handle(open());
    // bufferSize 300 leaves 300-27 = 273 data bytes per frame, so 100 fits in one.
    const first = t.handle(bare(DftRequest.GET));
    expect([...first.reply!].slice(17)).toHaveLength(100);
    const second = t.handle(bare(DftRequest.GET));
    expect([...second.reply!].slice(8, 10)).toEqual([0x69, 0x04]);  // EOF header
  });

  it('honours the buffer size, reserving 27 bytes as x3270 does', () => {
    // ft_dft.c:580 `numbytes = ftc->dft_buffersize - 27`.
    const data = new Uint8Array(500).fill(0x01);
    const t = new DftTransfer({ direction: 'send', data, bufferSize: 300 });
    t.handle(open());
    expect([...t.handle(bare(DftRequest.GET)).reply!].slice(17)).toHaveLength(273);
    expect(t.transferred).toBe(273);
  });

  it('retains the last upload frame for a Read Modified', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    const sent = t.handle(bare(DftRequest.GET)).reply!;
    expect(t.retainedFrame).toEqual(sent);
  });

  it('has no retained frame before the first Get', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    expect(t.retainedFrame).toBeUndefined();
  });

  it('refuses a Get after cancellation, with the user-cancel message', () => {
    const t = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    t.handle(open());
    t.cancel();
    const step = t.handle(bare(DftRequest.GET));
    expect(step.done).toEqual({ ok: false, error: 'Transfer canceled by user' });
    expect([...step.reply!].slice(4, 6)).toEqual([0x46, 0x08]);
  });

  it('refuses Data Insert after cancellation too', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.cancel();
    expect(t.handle(dataInsert([0x41])).done?.ok).toBe(false);
  });

  it('cancel() is idempotent', () => {
    const t = new DftTransfer({ direction: 'receive' });
    t.handle(open());
    t.cancel();
    t.cancel();
    expect(t.handle(dataInsert([0x41])).done).toEqual({
      ok: false, error: 'Transfer canceled by user',
    });
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dft.test.ts`
Expected: FAIL — `bufferSize` is not on `DftOptions`, `retainedFrame` does not exist, `GET` is unhandled.

- [x] **Step 3: Implement**

In `packages/core/src/ft/dft.ts`, add to the imports from `./dftFrames.js`: `DftError`, `DftHeader`, `DftReply`.

Add to `DftOptions`:

```typescript
  /**
   * The DFT buffer size, which bounds one upload frame. Defaults to x3270's
   * `DFT_BUF` 16384. The advertised INLIM/OUTLIM in the DDM Query Reply should
   * match, which is why this is settable.
   */
  bufferSize?: number;
```

Add these constants near the other offsets:

```typescript
/** x3270's default `DFT_BUF` (`globals.h:417`). */
const DFT_BUF_DEFAULT = 16384;
/**
 * Bytes of one buffer that are NOT data. `ft_dft.c:580` reads
 * `dft_buffersize - 27`, with the comment "always read 5 bytes less than we're
 * allowed" — the 27 covers the frame header and that margin together.
 */
const UPLOAD_OVERHEAD = 27;
```

Add the fields and the handler:

```typescript
  private readonly bufferSize: number;

  /**
   * The last upload frame, verbatim, for `dft_read_modified` to re-send.
   *
   * x3270 keeps this in `dft_savebuf` (`ft_dft.c:655-663`) and replays it when a
   * Read Modified arrives with `AID_SF`. Retaining the BYTES rather than the
   * source range is the same decision `CutTransfer` documents for retransmits:
   * re-deriving a frame can produce different bytes, and here it would also
   * double-count `offset`.
   */
  private savedFrame: Uint8Array | undefined;
```

In the constructor, after the direction handling:

```typescript
    this.bufferSize = opts.bufferSize ?? DFT_BUF_DEFAULT;
```

Add the accessor beside the others:

```typescript
  /** The last upload frame, for the Read Modified hook. */
  get retainedFrame(): Uint8Array | undefined { return this.savedFrame; }
```

Add the `GET` arm to the `switch` in `handle`, above `SET_CUR`:

```typescript
      case DftRequest.GET: return this.onGet();
```

And the handler:

```typescript
  /**
   * The host is asking us for data: this is the upload path.
   *
   * Either a data frame or, when the source is exhausted, an EOF frame. **EOF is
   * not a failure** — `TR_ERR_EOF` is how an upload ends, and the host answers it
   * with a Close. Reporting it as an error would fail every successful upload.
   */
  private onGet(): DftStep {
    const room = Math.max(1, this.bufferSize - UPLOAD_OVERHEAD);
    const chunk = this.source.subarray(this.offset, this.offset + room);

    if (chunk.length === 0) {
      // 10 bytes, SF length 9 -- byte-for-byte the same SHAPE as dft_abort
      // (ft_dft.c:697-708), differing only in the code: TR_ERR_EOF where an abort
      // sends TR_ERR_CMDFAIL. So this reuses `buildDftError`'s structure rather
      // than hand-rolling a second one; only the final code differs.
      const eof = Uint8Array.of(
        AID.SF, ...u16(9), Sfid.TRANSFER_DATA,
        (DftRequest.GET >> 8) & 0xff, DftReply.ERROR,
        ...u16(DftHeader.ERROR), ...u16(DftError.EOF),
      );
      this.savedFrame = eof;
      return { reply: eof };
    }

    this.offset += chunk.length;
    // SF LENGTH IS 16 + data, NOT 17 + data. x3270 sets it to
    // `obptr - (obuf + 1)` (ft_dft.c:654-655), i.e. total bytes EXCLUDING the
    // AID. The header from the AID to the first data byte is 17 bytes -- which is
    // why the data lands at index 17, matching x3270's `bufptr = obuf + 17` -- so
    // the length that excludes the AID is 16. An earlier draft of this plan said
    // 17 for both, which would have overstated every frame's length by one.
    const frame = Uint8Array.of(
      AID.SF, ...u16(chunk.length + 16), Sfid.TRANSFER_DATA,
      ...u16(DftReply.GET),
      ...u16(DftHeader.RECNUM), ...u32(this.recordNumber),
      ...u16(DftHeader.NOT_COMPRESSED), DftHeader.BEGIN_DATA,
      ...u16(chunk.length + LENGTH_OVERHEAD),
      ...chunk,
    );
    this.recordNumber++;
    this.savedFrame = frame;
    return { reply: frame };
  }
```

Extend the two import statements at the top of `dft.ts`. Add `DftError`, `DftHeader`, `DftReply`, `u16` and `u32` to the existing `./dftFrames.js` import, and add a new one for the AID and SFID:

```typescript
import {
  DftError,
  DftHeader,
  DftReply,
  DftRequest,
  X3270_HEADER_LEN,
  buildCloseAck,
  buildDataAck,
  buildDftError,
  buildOpenAck,
  parseDftFrame,
  parseDftOpen,
  u16,
  u32,
} from './dftFrames.js';
import { AID, Sfid } from '../constants.js';
```

**`u16`/`u32` are exported by Task 4**, so import them rather than writing a second copy — two hand-rolled big-endian writers that could disagree is exactly the drift `X3270_HEADER_LEN` exists to prevent. (An earlier draft declared them private and told you to reach back into Task 4's file to add `export`; that edit-back is gone. If you find them private, the Task 4 implementer missed it — export them there, not here.)

- [x] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dft.test.ts`
Expected: 21 tests PASS.

- [x] **Step 5: Mutation-check the three numbers that would corrupt a file**

(a) Change `UPLOAD_OVERHEAD` from 27 to 0. Expected: the buffer-size test fails (300 data bytes, not 273). Revert.
(b) Change `chunk.length + 16` to `chunk.length + 17` — **the off-by-one this plan itself made in an earlier draft.** Expected: the data-frame test fails on `b.slice(1,3)`, reporting `0x14` where `0x13` is right. Revert.
(c) Change `u16(chunk.length + LENGTH_OVERHEAD)` to `u16(chunk.length)`. Expected: the `slice(15,17)` assertion fails. Revert.

Confirm each edit landed before trusting its result. (b) is the one to take seriously: the SF length excludes the AID while the data offset includes it, so 16 and 17 are both "right" for different things and one draft of this plan used 17 for both.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/ft/dft.ts packages/core/test/dft.test.ts
git commit -m "feat(core): the DFT upload path and the retained frame

EOF IS NOT A FAILURE: TR_ERR_EOF is how an upload ends and the host answers it
with a Close, so reporting it as an error would fail every successful upload.
Pinned, because the constant's name (TR_ERR_*) invites exactly that mistake.

The retained frame keeps the BYTES, not the source range -- the same decision
CutTransfer documents for retransmits, and here re-deriving would also
double-count the offset. Task 8 is the hook that replays it."
```

**AS BUILT (2026-09-25).** Inline. **44 tests in `dft.test.ts`; suite 2025 -> 2042 in 80 files**,
build/typecheck clean. The plan's frame arithmetic was **right** — SF length 16 + data with the data at
index 17 — and I re-derived it from `ft_dft.c:654-655` and `:584` before trusting it, because the plan
itself records an earlier draft that used 17 for both.

**ONE PLAN TEST WAS WRONG IN TWO INDEPENDENT WAYS**, and it is the one named "splits a source larger
than the buffer":
1. **It did not split anything.** A 100-byte source against `bufferSize: 300` is one 273-byte frame, so
   the test asserted a single frame and then an EOF — the multi-frame path it was named for went
   unexercised. Now 600 bytes over three frames (273 + 273 + 54).
2. **It looked for the EOF header at index 8-10, where the error CODE lives.** The EOF frame is
   `88 00 09 d0 46 08 | 69 04 | 22 00`: `TR_ERROR_HDR` is at 6-8 and `TR_ERR_EOF` at 8-10. This was
   the only failing test after implementing, so the plan's own expectation is what caught it — but it
   would have been "fixed" by changing the implementation if I had trusted the test over the frame I
   had just verified byte by byte against the C.

**BUFFER SIZE IS CLAMPED THROUGH `queryreply.ts`'s EXISTING `boundDftBufferSize`, not the plan's new
bare `DFT_BUF_DEFAULT` constant.** `DFT_BUF_DEFAULT`, `DFT_BUF_MIN`, `DFT_BUF_MAX` and the clamp were
already there for the DDM advertisement (`9f92816`), and **reusing them is a correctness requirement,
not tidiness: the size we ADVERTISE to the host and the size we CHUNK by must be the same number.**
The plan's version also had `Math.max(1, ...)` papering over a small `bufferSize`, which would have
produced 1-byte frames where x3270 clamps to 256. No import cycle — `queryreply.ts` imports only
`constants` and `palette`.

**Five behaviours added beyond the plan's tests, each because a mutation showed the plan's set did not
pin it:** the 16-vs-17 relationship checked across three sizes rather than one instance; the EOF frame
distinguished from an ABORT frame, which differ by **one byte** (`0x2200` vs `0x0100`) and are
otherwise identical for 8 bytes; record numbers 1/2/3 across successive frames; the source delivered
**byte for byte** across frames from a positional pattern, so a dropped or reordered chunk shows; and
`offset` NOT advancing on EOF, since `transferred` feeds a progress display.

**Five mutations verified, all reddening:** SF length 17-not-16 (2 tests), `UPLOAD_OVERHEAD` 22-not-27
(3), dropping the `+5` on the inner data length (2), not retaining the EOF frame (1), never advancing
`offset` (7).

**For Task 8:** `retainedFrame` covers BOTH branches deliberately — x3270's savebuf copy at `:657-663`
is after the if/else, so a Read Modified after EOF re-sends the EOF and not the last data frame, which
the host already has.

---

### Task 7: Plumbing — the payload reaches the engine

**Files:**
- Modify: `packages/core/src/stream/sf.ts:63-70` (the union) and its dispatch
- Modify: `packages/core/src/stream/execute.ts:160` (the result type)
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/dftSession.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/core/test/dftSession.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseStructuredFields } from '../src/stream/sf.js';

describe('parseStructuredFields, SF_TRANSFER_DATA', () => {
  it('yields a transferData variant, not an unknownSf', () => {
    // A 6-byte field: length 0x0006, SFID 0xd0, then 3 payload bytes.
    const sf = parseStructuredFields(Uint8Array.of(0x00, 0x06, 0xd0, 0x00, 0x12, 0xff));
    expect(sf).toHaveLength(1);
    expect(sf[0]!.kind).toBe('transferData');
  });

  it('strips the length bytes and the SFID, which is the offset contract', () => {
    // THE test for the -3. The host declares 6; we must see 3 payload bytes.
    const sf = parseStructuredFields(Uint8Array.of(0x00, 0x06, 0xd0, 0x00, 0x12, 0xff));
    const field = sf[0]!;
    if (field.kind !== 'transferData') throw new Error('wrong variant');
    expect([...field.payload]).toEqual([0x00, 0x12, 0xff]);
  });

  it('reproduces the live probe\'s own lengths: 0x29 field -> 38-byte payload', () => {
    // TK5 sent field lengths 0x29 and 0x23 and our trace reported 38B and 32B.
    // That measurement is what this assertion encodes.
    for (const [declared, expected] of [[0x29, 38], [0x23, 32]] as const) {
      const field = new Uint8Array(declared);
      field[0] = (declared >> 8) & 0xff;
      field[1] = declared & 0xff;
      field[2] = 0xd0;
      const sf = parseStructuredFields(field);
      const f = sf[0]!;
      if (f.kind !== 'transferData') throw new Error('wrong variant');
      expect(f.payload).toHaveLength(expected);
    }
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dftSession.test.ts`
Expected: FAIL — `kind` is `'unknownSf'`.

- [x] **Step 3: Add the variant**

In `packages/core/src/stream/sf.ts`, add to the `StructuredField` union (before `unknownSf`):

```typescript
  /**
   * `SF_TRANSFER_DATA` (SFID 0xd0): a DFT file-transfer frame.
   *
   * `payload` is the PARAMETERS — the length bytes and the SFID are already
   * gone — so every offset in x3270's `ft_dft.c` is 3 more than the offset here.
   * `ft/dftFrames.ts` owns that subtraction.
   */
  | { kind: 'transferData'; payload: Uint8Array }
```

And in the dispatch, before the `unknownSf` fallback:

```typescript
    if (sfid === Sfid.TRANSFER_DATA) {
      // No validation beyond this: a DFT frame's own shape is dft.ts's business,
      // and a malformed one must fail the TRANSFER, not the record. Copied rather
      // than subarray'd so a later record cannot mutate a retained payload.
      fields.push({ kind: 'transferData', payload: Uint8Array.from(params) });
      continue;
    }
```

- [x] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftSession.test.ts`
Expected: 3 tests PASS.

- [x] **Step 5: Surface it from `execute`**

In `packages/core/src/stream/execute.ts`, add to the result interface beside `sfReply` (line 160):

```typescript
  /**
   * DFT payloads from this record, in arrival order. Surfaced as a REQUEST for
   * the session to answer, exactly as `sfReply` is — `execute` stays pure and
   * does no I/O.
   *
   * An array because one `WriteStructuredField` may carry several fields, and
   * dropping any but the first would lose data silently.
   */
  transferData?: Uint8Array[];
```

In the `WriteStructuredField` case, beside the `readPartition` arms:

```typescript
        } else if (field.kind === 'transferData') {
          (result.transferData ??= []).push(field.payload);
        }
```

- [x] **Step 6: Route it in `Session`**

In `packages/core/src/session.ts`, add the field:

```typescript
  /**
   * The DFT transfer in flight, if any. `undefined` means a `SF_TRANSFER_DATA`
   * frame is unexpected — which x3270 also treats as a no-op rather than an
   * error, tracing "(no transfer in progress)" (`ft_dft.c:97-100`).
   */
  private dft: DftTransfer | undefined;
```

Add the public entry point near the other transfer surface:

```typescript
  /** Start a DFT transfer. The caller drives it by letting records arrive. */
  startDftTransfer(transfer: DftTransfer): void {
    this.dft = transfer;
  }

  /** The DFT transfer in flight, for a front end to read progress or cancel. */
  get dftTransfer(): DftTransfer | undefined { return this.dft; }
```

And in `handleRecord`, immediately after the `sfReply` block at line 758:

```typescript
      if (result.transferData !== undefined) {
        for (const payload of result.transferData) this.handleTransferData(payload);
      }
```

Then the handler:

```typescript
  /**
   * Answer one DFT frame.
   *
   * A frame arriving with no transfer in flight is IGNORED, matching x3270's
   * `ft_state == FT_NONE` early return (`ft_dft.c:97-100`). It must not throw: a
   * host can send one at any time, and `handleRecord` rethrows non-protocol
   * errors as our own bug, which drops the connection. That would make an
   * unexpected frame a remotely-triggerable disconnect.
   */
  private handleTransferData(payload: Uint8Array): void {
    const transfer = this.dft;
    if (transfer === undefined) {
      this.trace.note('SF_TRANSFER_DATA with no transfer in progress, ignored');
      return;
    }
    let step;
    try {
      step = transfer.handle(payload);
    } catch (err) {
      // A malformed frame ends the TRANSFER, never the session -- the rule CUT
      // already follows. Without this catch a DftFrameError would escape into
      // handleRecord and drop the connection.
      this.trace.note(`DFT frame rejected: ${err instanceof Error ? err.message : String(err)}`);
      this.dft = undefined;
      this.emit('transferEnd');
      return;
    }
    // Trace BEFORE the reply, so the log reads in the order things happened.
    // Without this the `unsupported` field would be dead code and an
    // unimplemented request type would be an unexplainable stall with an empty
    // log -- x3270 logs `Unsupported(0x%04x)` for exactly this reason.
    if (step.unsupported !== undefined) {
      this.trace.note(
        `DFT request type 0x${step.unsupported.toString(16).padStart(4, '0')} not implemented`);
    }
    if (step.reply !== undefined) this.sendInbound(step.reply);
    if (step.done !== undefined) {
      this.dft = undefined;
      this.emit('transferEnd');
    }
  }
```

Import `DftTransfer` at the top, and **add `transferEnd` to `SessionEvent`** (`session.ts:126`), which is a typed union — `'screen' | 'connect' | 'disconnect' | 'alarm'` — so `emit('transferEnd')` will NOT compile until you do. Checked 2026-09-24: `SessionEvent` has **no consumers outside `session.ts`** (it types `on`, `off`, `listenerCount` and `emit` and nothing else references it), so widening it has no blast radius and needs no exhaustive-switch updates.

- [x] **Step 7: Export the public surface**

In `packages/core/src/index.ts`, export `DftTransfer`, `DftOptions`, `DftStep` from `./ft/dft.js` and the constants plus `DftFrameError` from `./ft/dftFrames.js`, following the pattern the CUT exports already use.

- [x] **Step 8: Write the plumbing test**

Append to `packages/core/test/dftSession.test.ts`:

**`handleRecord` is PRIVATE** (`session.ts:620`) and is reached only through the telnet
`onRecord` callback (`session.ts:457`). So a test drives it with **real wire bytes through
`FakeConnection`**, which is the seam `session.test.ts` already uses — copy `FakeConnection`
and `newSession` from the top of that file (lines 9-36) rather than inventing a helper. Its
`host(...bytes)` calls `onData`, and `negotiate()` gets the session into 3270 mode, which is
required: `is3270Mode()` is false on any unconnected session, so records are dropped before
reaching your code.

```typescript
import { Session } from '../src/session.js';
import { DftTransfer } from '../src/ft/dft.js';
// FakeConnection / newSession: copy from packages/core/test/session.test.ts:9-36.

/**
 * The bytes of a WriteStructuredField record carrying one DFT frame, as a host
 * sends them: WSF command, then `L L SFID payload`, then IAC EOR.
 * The declared length counts itself and the SFID, hence +3.
 */
function wsfBytes(payload: number[]): number[] {
  const len = payload.length + 3;
  return [0xf3, (len >> 8) & 0xff, len & 0xff, 0xd0, ...payload, 0xff, 0xef];
}

describe('Session DFT plumbing', () => {
  it('ignores a frame with no transfer in flight, and does NOT throw', async () => {
    // A host can send this at any time. handleRecord rethrows non-protocol errors
    // as our own bug and drops the connection, so a throw here would be a
    // remotely-triggerable disconnect.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(() => conn.host(...wsfBytes([0x00, 0x12]))).not.toThrow();
    expect(session.isConnected()).toBe(true);
  });

  it('does not throw on a malformed frame either; it ends the transfer', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    // One byte: too short for a request type, so parseDftFrame throws inside.
    expect(() => conn.host(...wsfBytes([0x00]))).not.toThrow();
    expect(session.dftTransfer).toBeUndefined();
    expect(session.isConnected()).toBe(true);
  });
});
```

**Assert `isConnected()` afterwards, not just that nothing threw.** The failure being guarded
against is a dropped connection, and `handleRecord` catches and closes rather than propagating
in some paths — so "did not throw" alone would pass against the very bug.

- [x] **Step 9: Run everything**

Run: `cd ~/git/tn3270 && npm run build && npm run typecheck && npm test`
Expected: build and typecheck clean; all tests pass, count up from 1971.

- [x] **Step 10: Commit**

```bash
git add packages/core/src packages/core/test/dftSession.test.ts
git commit -m "feat(core): route SF_TRANSFER_DATA to the DFT engine

parseStructuredFields gains a transferData variant, execute surfaces it as a
request the session answers (as it already does for sfReply, so execute stays
pure), and Session routes it to the transfer in flight.

Two refusals that are load-bearing rather than defensive, both tested: a frame
arriving with NO transfer in flight is ignored (x3270 traces 'no transfer in
progress'), and a malformed frame ends the TRANSFER. Either one throwing would
escape into handleRecord, which rethrows non-protocol errors as our own bug and
drops the connection -- i.e. a remotely-triggerable disconnect, the same shape as
the gateway kill the keypad branch's task ordering created.

transferData is an ARRAY: one WriteStructuredField can carry several fields and
taking only the first would lose data silently."
```

**AS BUILT (2026-09-25).** Inline. **16 tests in `dftSession.test.ts` + 2 in `parse.test.ts`; suite
2042 -> 2060 in 81 files**, build/typecheck clean. The plan's five source edits were right as
specified; two things it did not predict.

**1. THE UNION VARIANT HAD BLAST RADIUS, AND THE PLAN CHECKED THE WRONG UNION.** Step 6 verifies that
`SessionEvent` has no consumers outside `session.ts` — true, and it is not exported from `index.ts`
either. But adding the variant to **`StructuredField`** broke `describeStructuredField` in
`stream/parse.ts`, an exhaustive switch whose return type makes a missing kind a **compile error**.
That is its documented purpose: its comment says a variant added by a later stage "would silently
vanish from the trace". So the type system did the plan's job for it. **Adding a variant to a
discriminated union in this repo means searching for exhaustive switches over it, not only for
consumers of the adjacent type the plan happened to name.**

**The upside is large and was not in the plan at all: DFT frames now carry their REQUEST TYPE in the
trace** — `FileTransferData(0x0012,38B)` where the `-ddm` probe could only report
`unknownSF(0xd0,38B)`, with the types decoded by hand afterwards. **This is what makes Task 10
judgeable by trace**, which is fact 4's rule: after DFT works, a CUT transfer and a DFT transfer both
end in a transferred file and only the trace distinguishes them. Pinned by two tests, one of which
reproduces the probe's own `0x29` frame.

**2. THE NO-TRANSFER GUARD WAS UNFALSIFIABLE AS THE PLAN SPECIFIED IT.** Replacing
`if (transfer === undefined) { ... return; }` with `this.dft!` left **all 13 tests green** — the
`catch` immediately below swallows the resulting `TypeError`, and the observable outcome is identical:
no reply, still connected, transfer cleared. The two paths differ **only in the trace**, and the
messages are not interchangeable to whoever reads the log ("no transfer in progress" is a host doing
something unexpected; "DFT frame rejected" is a frame we could not parse). Collapsing them would send
a future live-run diagnosis down the wrong path. The trace is now what is asserted, and both
directions are mutation-verified. **This is the third vacuous mutation on this branch and they share a
shape: the guard's effect was invisible because a LATER guard covered the same input.**

**Also note the plan's own step-8 warning was right and insufficient.** It says to assert
`isConnected()` and not merely that nothing threw — correct — but its two tests assert only that
nothing broke. **Neither would have failed if no reply ever reached the host.** Added: an OpenAck
asserted on the wire, a whole download driven through `FakeConnection` (Open, data, Close,
Open(`FT:MSG`), `TRANS03`) proving one transfer survives its own Close **in situ**, an upload
answering a `Get`, Set Cursor staying silent through the plumbing, `transferEnd` firing once, and
several frames from ONE record both being delivered.

**Four mutations verified:** the no-transfer guard (trace), the malformed-frame catch (2 tests),
keeping only the first field of a record (1), and `payload: params` aliasing the inbound buffer
instead of copying (1).

**One deviation:** the `transferData` arm in `execute.ts` sits **before** the
`structuredFieldsIgnored++` fallback, so a DFT frame is not counted as ignored — it is answered, and a
counter saying otherwise would misreport a working transfer in the trace.

---

### Task 8: The Read Modified hook

**Files:**
- Modify: `packages/core/src/session.ts` (the `answerRead` path at line 1152)
- Modify: `packages/core/test/dftSession.test.ts`

The spec's warning: **omitting this stalls uploads only; downloads pass.** That is the shape of defect that ships.

- [x] **Step 1: Write the failing test**

Append to `packages/core/test/dftSession.test.ts`:

A host-initiated read is **a record the host sends**, so it is driven exactly like the frames
above: `SnaCmd.RM` is `0xf6` and `SnaCmd.RB` is `0xf2` (`constants.ts:276-279`). Outbound bytes
are observed with `conn.sent`, which `FakeConnection.write` appends to — clear it before the act
so the assertion sees only what the read produced.

```typescript
describe('the Read Modified hook', () => {
  /** A session with a retained upload frame: negotiated, opened, one Get answered. */
  async function uploading() {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    const transfer = new DftTransfer({ direction: 'send', data: Uint8Array.of(0x41) });
    session.startDftTransfer(transfer);
    conn.host(...wsfBytes([0x00, 0x12]));   // Open
    conn.host(...wsfBytes([0x46, 0x11]));   // Get -> retains a frame
    expect(transfer.retainedFrame).toBeDefined();   // the premise, asserted
    conn.sent = [];
    return { session, conn, transfer };
  }

  it('replays the retained upload frame instead of reading the screen', async () => {
    // x3270 short-circuits to dft_read_modified when the AID is AID_SF, at BOTH
    // read sites: ctlr.c:760 in ctlr_read_modified and ctlr.c:986 in
    // ctlr_read_buffer. Omitting this stalls UPLOADS ONLY -- downloads never take
    // this path -- which is why it gets its own task and its own test.
    const { conn, transfer } = await uploading();
    conn.host(0xf6, 0xff, 0xef);            // Read Modified
    // The retained frame, then IAC EOR that sendInbound appends.
    expect(conn.sent.slice(0, transfer.retainedFrame!.length))
      .toEqual([...transfer.retainedFrame!]);
  });

  it('replays on a Read Buffer too, the second of x3270\'s two sites', async () => {
    const { conn, transfer } = await uploading();
    conn.host(0xf2, 0xff, 0xef);            // Read Buffer
    expect(conn.sent.slice(0, transfer.retainedFrame!.length))
      .toEqual([...transfer.retainedFrame!]);
  });

  it('reads the screen normally when there is no retained frame', async () => {
    // A DOWNLOAD retains nothing, so the hook must not swallow an ordinary read.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.startDftTransfer(new DftTransfer({ direction: 'receive' }));
    conn.sent = [];
    conn.host(0xf6, 0xff, 0xef);
    expect(conn.sent[0]).not.toBe(0x88);    // AID.SF -- i.e. not a replay
    expect(conn.sent.length).toBeGreaterThan(0);   // it DID answer
  });
});
```

Two things these tests do on purpose. `uploading()` **asserts `retainedFrame` is defined before
acting** — without that, a broken Task 6 would make all three pass against `undefined`. And the
third test asserts the read was *answered*, not merely that it was not a replay: `not.toBe(0x88)`
alone passes when nothing is sent at all, which is the stall this hook exists to prevent.

- [x] **Step 2: Run it and watch it fail**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/dftSession.test.ts`
Expected: FAIL — the screen read is sent instead of the retained frame.

- [x] **Step 3: Implement**

In `packages/core/src/session.ts`, at the top of `answerRead`:

```typescript
  private answerRead(kind: 'ReadBuffer' | 'ReadModified' | 'ReadModifiedAll'): void {
    // DFT SHORT-CIRCUIT. x3270 does this at BOTH read sites -- ctlr.c:760 in
    // ctlr_read_modified and ctlr.c:986 in ctlr_read_buffer -- returning
    // immediately when the AID is AID_SF. Ours is one function, so one guard
    // covers both, and the `all` variant comes free.
    //
    // Guarded on there being a retained frame, not merely on a transfer being in
    // flight: a DOWNLOAD retains nothing and must still answer an ordinary read.
    //
    // OMITTING THIS STALLS UPLOADS ONLY. A download never reaches here, so the
    // whole receive path passes with this missing -- which is exactly why it is
    // its own task.
    const retained = this.dft?.retainedFrame;
    if (retained !== undefined) {
      this.trace.note('Read Modified during a DFT upload: replaying the retained frame');
      this.sendInbound(retained);
      return;
    }
    const payload = kind === 'ReadBuffer'
      ? buildReadBuffer(this.screen, AID.NONE)
      : buildReadModified(this.screen, AID.NONE, kind === 'ReadModifiedAll');
    this.sendInbound(payload);
  }
```

- [x] **Step 4: Run the test**

Run: `cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/dftSession.test.ts`
Expected: all PASS.

- [x] **Step 5: Mutation-check, and check it the right way round**

Delete the whole short-circuit. Rebuild and run the **full** suite.
Expected: the two replay tests fail and **every download test still passes** — which is the point. Record that asymmetry in the commit: it is the evidence that this hook needed its own test rather than being covered incidentally.
Revert.

- [x] **Step 6: Commit**

```bash
git add packages/core/src/session.ts packages/core/test/dftSession.test.ts
git commit -m "feat(core): replay the retained DFT frame on a host read

x3270 short-circuits to dft_read_modified at BOTH read sites, ctlr.c:760 in
ctlr_read_modified and ctlr.c:986 in ctlr_read_buffer. (The design spec cites
:761 and :987; the actual lines are one lower.) Ours is one function, so one
guard covers both paths and ReadModifiedAll comes free.

Guarded on a retained frame existing rather than on a transfer being in flight,
because a DOWNLOAD retains nothing and must still answer an ordinary read.

MEASURED, and it is why this is its own task: deleting the guard reddens the two
replay tests and leaves EVERY download test green. Omitting it would have stalled
uploads only."
```

**AS BUILT (2026-09-25).** Inline. **21 tests in `dftSession.test.ts`; suite 2060 -> 2065 in 81
files**, build/typecheck clean. The plan was right in every particular here, including its correction
of the spec's citations — `ctlr.c:760` and `:986` verified exactly, the spec's `:761`/`:987` each one
line late.

**THE ASYMMETRY THE PLAN ASKED FOR IS MEASURED, and it is the whole justification for this task
existing:** deleting the short-circuit fails **2 tests and leaves 2063 green**, every download test
among them. An upload-only stall is invisible to the entire receive suite.

**Two tests added beyond the plan's three:**
1. **A replay must be IDEMPOTENT.** Two reads in a row produce identical bytes and leave
   `transferred` unchanged. This pins the decision to replay retained BYTES rather than ask the engine
   for a frame — re-deriving would consume more source and hand the host the NEXT chunk, corrupting
   the file while both reads appeared to succeed. Nothing in the plan's set distinguished those.
2. **An ordinary read with NO transfer at all**, which is the commonest case in the product and the
   one a wrong guard (`this.dft !== undefined` instead of `retainedFrame !== undefined`) would break
   for every user who never transfers a file. The plan's third test covers a download in flight but
   not the no-transfer case.

**The plan's own two cautions were both right and worth keeping:** `uploading()` asserts
`retainedFrame` is defined **before** acting, so a broken Task 6 cannot make these pass against
`undefined`; and the no-replay test asserts the read was *answered*, since `not.toBe(0x88)` alone
passes when nothing is sent — which is the stall being guarded against.

---

### Task 9: Blast radius — measure it, do not estimate it

**Files:** none modified. This task produces evidence and a doc note.

- [x] **Step 1: Confirm `-ddm off` still puts no `0x95` on the wire**

Run: `cd ~/git/tn3270 && npx vitest run packages/core/test/queryreply.test.ts`

Then add a test if none exists pinning that `DEFAULT_CAPABILITIES` contains no `0x95`:

```typescript
it('does not advertise DDM unless asked, which is what keeps hosts on CUT', () => {
  expect(DEFAULT_CAPABILITIES.map((c) => c.qcode)).not.toContain(0x95);
});

it('advertises DDM in ascending QCODE order when asked', () => {
  const codes = withDdm(DEFAULT_CAPABILITIES, 16384).map((c) => c.qcode);
  expect(codes).toContain(0x95);
  expect([...codes]).toEqual([...codes].sort((a, b) => a - b));
});
```

**Mutation-check both**: the spec warns the established failure mode here is a test that passes vacuously because every other test in the file already supplies the value under test. Remove the `ddm` filter in `answerQuery` and confirm the first test still passes (it tests the constant, not the session) — then add a session-level test if that gap is real.

- [x] **Step 2: Run the conformance and golden suites**

Run: `cd ~/git/tn3270 && npx vitest run packages/cli/test/conformance.test.ts packages/cli/test/golden.test.ts`
Expected: PASS, untouched. Record the numbers.

- [x] **Step 3: Run the playback oracle**

```bash
source /opt/lsst/software/stack/loadLSST.bash >/dev/null 2>&1; hash -r
cd ~/git/tn3270 && python3 packages/cli/scripts/drive-playback.py
```

Expected: **10 of 10**. The reference binaries are at
`~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/{s3270,playback}/` — under `obj/`, **not** beside their source.

- [x] **Step 4: Run the full gate**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npm test
python3 packages/tui/scripts/pty-smoke.py
python3 packages/cli/scripts/drive-e.py
node packages/gui/scripts/shot.mjs
node packages/gui/scripts/keys.mjs
node packages/gui/scripts/clicks.mjs
node packages/web/scripts/browser-shot.mjs
node packages/web/scripts/browser-keys.mjs
```

Expected: typecheck clean; `pty-smoke` 12/12; `drive-e` 10/10; `shot` 3/3; `keys` 18 chords/16 actions; `clicks` 9 buttons/10 actions; `browser-shot` 2/2; `browser-keys` 13 chords/11 actions.

If you ran `git checkout` at any point, run `npx tsc --build --force packages/gui` first or the GUI staleness guard reddens on mtimes alone.

- [x] **Step 5: Commit the evidence**

```bash
git add -A
git commit -m "test(core): pin the DDM default-off guard, and record the blast radius

Measured rather than estimated, per the spec: conformance and golden untouched,
drive-playback 10/10, all eight by-hand harnesses at their recorded numbers.
A default-off capability having zero blast radius is the claim, and confirming it
is the test."
```

**AS BUILT (2026-09-25).** Inline. **Suite 2065 -> 2075 in 81 files.** The plan's step-1 warning was
exactly right and the gap it predicted was real and large.

**THE `-ddm` DEFAULT-OFF GUARD WAS COMPLETELY UNFALSIFIED.** Replacing
`this.opts.ddm ? withDdm(...) : DEFAULT_CAPABILITIES` with an unconditional `withDdm(...)` left **all
2071 tests green**. That is not a coverage nicety: advertising `0x95` changes **which protocol a live
host speaks** — TK5 offers DFT on seeing it and stays on CUT without it — so the unfalsified line was
what stood between a green suite and every CUT live witness in this project being invalidated. Ten
tests now cover it, **four at SESSION level**, and the mutation reddens two. Constant-level tests
could not have done it: they exercise `DEFAULT_CAPABILITIES` and `withDdm`, not the session's choice
between them. **Fourth vacuous-guard finding on this branch.**

**THE REPLY'S REAL SHAPE, measured with a direct probe after two wrong guesses of mine:** a plain
Query reply is **5 units** and `-ddm on` makes it **6** —
`0x80(10) 0x81(23) 0x86(38) 0x87(15) 0x95(12) 0xa6(17)` against
`0x80(9) 0x81(23) 0x86(38) 0x87(15) 0xa6(17)`. **DDM does TWO things**, both now pinned: its own
12-byte unit inserted BEFORE Implicit Partition (`0x95 < 0xa6`, so ascending order holds) and **one
extra byte in the Summary's qcode list**. All other units byte-identical.

**TWO TEST-WRITING TRAPS, both of which first presented as product bugs — worth carrying to any future
session-level wire test:**
1. **A Read Partition's `0xff` PID must be written `IAC IAC`.** A lone `0xff` is consumed by the
   telnet layer and the record never arrives. All four cases failed with **nothing on the wire**,
   which reads like a broken product rather than a malformed test input.
   `session.test.ts:859` already spells it correctly.
2. **Query Reply payloads are full of `0xff`** (Usable Area flags, Highlighting pairs) **and arrive
   DOUBLED.** A walk over the raw bytes reads a doubled pair as part of a length — mine reported a
   unit of length **65535**, and the true 5-unit structure only appeared once `replyUnits` undoubled.
   Relatedly: **parse the structure, do not grep it.** An earlier version of one assertion used
   `indexOf(0x95)` and matched a coincidental byte inside another unit's payload.

**BLAST RADIUS, MEASURED:** build/typecheck clean, **2075 tests in 81 files**, conformance + golden
**12/12 untouched**, `drive-playback.py` **10/10** against real s3270, `pty-smoke.py` **12/12**,
`drive-e.py` **10/10**, `shot.mjs` **3/3**, `keys.mjs` **18 chords/16 actions**, `clicks.mjs`
**9 buttons/10 actions**, `browser-shot.mjs` **2/2**, `browser-keys.mjs` **13 chords/11 actions**.

**Two plan corrections:** step 2's paths are wrong — `conformance.test.ts` and `golden.test.ts` are in
**`packages/core/test`**, not `packages/cli/test`. And `packages/gui/scripts/xvfb.mjs` is a **library**
exporting `ensureDisplay()`, not a runnable script; the harnesses call it themselves, so there is
nothing to run first. Unsetting `HTTP_PROXY`/`no_proxy` before the Electron harnesses remains
necessary.

---

### Task 10: Live run against MVS/TSO at 43x80

> **BLOCKED, 2026-09-25 — AND THE BLOCKER IS A GAP IN THIS PLAN, NOT IN THE CODE.**
> The run was attempted against TK5 at 43x80 with `-ddm on`. It reached the host and logged on
> cleanly, then **`Transfer()` refused before sending anything**: *"CUT file transfer needs a 24x80
> screen; this session is 43x80"* (`packages/cli/src/runner.ts:454`). **Zero `FileTransferData`
> frames.**
>
> **NOTHING SELECTS DFT.** `Session.startDftTransfer` has no caller outside tests, and `runner.ts`
> constructs a `CutTransfer` unconditionally. Tasks 1-9 build the engine, the wire plumbing and the
> Read Modified hook — all of it verified — but **no task in this plan wires the `Transfer()` action
> to choose DFT over CUT.** Tasks 11 and 12 both consume Task 10's trace, so the entire tail is
> blocked behind work nothing specifies. This is the "plumbing built, switch never thrown" shape, and
> it survived nine tasks because every test that exercises the engine calls `startDftTransfer`
> itself — **the tests supply the very call the product is missing.** Compare
> [[harness-passes-on-stale-artifacts]]: a suite can be green over a product that cannot run.
>
> **A NEW TASK IS NEEDED BEFORE THIS ONE, and it needs decisions this plan never poses:**
> 1. **What chooses DFT?** Geometry alone is wrong — a 24x80 session on a DFT host should still work.
>    x3270 does not choose at all: the HOST does, and `ft_running(true/false)` merely *reports* which
>    protocol arrived (`ft_cut.c:440`, `ft_dft.c:175`, read once at `ft.c:556`). So the honest design
>    is probably to start a transfer that can be EITHER, and let the first inbound frame decide —
>    which means `runner.ts`'s poll loop cannot assume CUT frames.
> 2. **What if the host never offers DFT and the screen is not 24x80?** Today that is the refusal
>    above, and it is correct; it must stay reachable.
> 3. **Does `Transfer()`'s `BufferSize` keyword now feed `DftOptions.bufferSize`?** It is parsed and
>    ignored today, and `SessionOptions.dftBufferSize` is set by nothing. Wiring both is a
>    one-liner each and they must agree, since the advertised and chunking sizes are one number.
> 4. **All four front ends** reach transfers now (CLI action, TUI overlay, and the GUI/web forms via
>    `frontend/src/transferForm.ts`), so the choice belongs wherever they already share code, not in
>    `runner.ts` alone.
>
> **UPDATE: STEP 5, THE VM CONTROL, IS DONE — 2026-09-25.** The user rebuilt VM/370 and it is back on
> `localhost:3270`. `ddm-probe-vm.txt` run twice with `-ddm on`/`-ddm off` as the only variable:
> **VM chose CUT both ways, 249 bytes byte-identical each time, ZERO `0xd0` frames**, and our DDM unit
> provably on the wire with `-ddm on` (**4** occurrences of `00 0c 81 95 00 00 40 00 40 00 01 01`,
> against **0** with it off). **So `-ddm on` does not break a CUT host** — that question is closed.
> State was proven first (`QUERY DISK A` → `Ready;`, not `?CP:`) and both runs reached `LOGOFF AT`.
> Details, plus two traps, in `docs/live-testing.md` *Executed so far*.
>
> **It also produced a live confirmation of a Task 5 decision that no unit test could have given:**
> MECAFF answers **`TRANS03 - File transfer complete`** — host text appended — which is exactly why
> the engine matches `TRANS03` as a **prefix**. An equality test would have reported this successful
> transfer as a failure whose error text was the success message.
>
> **But VM is now 24x80-ONLY: the rebuild does not define the 3278-4 pool**, so
> `--terminal-type 'IBM-3278-4-E@MOD4'` yields 0 fields and never completes negotiation (we send the
> suffix correctly; Hercules has no such group). Those `vm370ce.conf` statements were uncommented by
> hand on the old system and are commented again. **Steps 1-4 of this task still need TK5**, which is
> the reference host and is up on 3271 — and they still need the DFT selection work above.
>
> **What the attempt did establish:** `-ddm on` reaches a live host without disturbing logon at
> 43x80, and the geometry refusal fires BEFORE the host is told to start — so the failed run left no
> half-open transfer on TSO and `LOGOFF` completed. `packages/cli/scripts/dft-tso.txt` is committed,
> is correct as written, and carries its own judging criteria; it is the run to repeat once a front
> end can start a DFT transfer.


**Files:**
- Create: `packages/cli/scripts/dft-tso.txt`
- Modify: `docs/live-testing.md`

This is the real gate. TK5 is the reference host; **VM is the control** and must stay on CUT.

- [ ] **Step 1: Read the runbook's TSO section before touching a host**

Run: `grep -n "tsoxfer\|ddm-probe-tso" docs/live-testing.md packages/cli/scripts/*.txt | head`

Facts that decide whether the run is valid, all measured in stage 1:
- `IND$FILE` on TK5 is a **plain TSO command run from `READY`** — Mike Rayborn's FFTP 2.0.5, **no ISPF panel**. Leave ISPF with `X`.
- Use **`Recfm=variable`, never `fixed`** — fixed PADS, and 249 bytes came back as 320.
- **TSO quoting is semantic**: unquoted `FORMV.BIN` gets the userid prepended; quoted `'HERC01.FORMV.BIN'` is absolute.
- TSO reports **`VB`**, not `V`, so a readback cannot string-compare against what was sent.

- [ ] **Step 2: Write the script**

Create `packages/cli/scripts/dft-tso.txt`, modelled on `ddm-probe-tso.txt` — copy that file's header style, and read it first for the exact logon and navigation lines rather than inventing them. The script must:

1. `Trace(on)` **and `TraceText`** as the first lines. `Trace(on)` alone logs nothing.
2. Log on `HERC01`, leave ISPF with `X`, reach `READY`.
3. `Transfer` a file **in both directions**, with `Recfm=variable`.
4. End with `LOGOFF`, so the next run is not handed a stranded userid.

Run it at **43x80**, which is the geometry CUT refuses and the reason this stage exists:

```bash
cd ~/git/tn3270 && node packages/cli/dist/main.js \
  -insecure -model 3278-4-E -ddm on < packages/cli/scripts/dft-tso.txt \
  > /tmp/dft-tso.log 2>&1
```

- [ ] **Step 3: Judge it by trace, and check the four things that make it a result**

```bash
grep -c "0xd0\|TransferData" /tmp/dft-tso.log     # DFT frames: must be > 0
grep -c "O_SF\|CutFrame" /tmp/dft-tso.log         # CUT frames: must be 0
grep "24 80\|43 80" /tmp/dft-tso.log | head       # geometry: must be 43x80
grep "LOGOFF\|READY" /tmp/dft-tso.log | tail -3   # clean exit
```

**A successful transfer is no longer the positive result on its own.** Both protocols now end in a transferred file; only the trace says which ran. A run that succeeded over CUT at 24x80 has proved nothing about this feature.

- [ ] **Step 4: `cmp` the bytes, both directions**

The status line says `done: N bytes transferred` either way, so a transfer that reports success and writes a wrong file is the failure mode to look for. Compare the actual bytes.

- [ ] **Step 5: Run the VM control**

```bash
cd ~/git/tn3270 && node packages/cli/dist/main.js \
  -insecure -model 3278-2-E -ddm on < packages/cli/scripts/ddm-probe-vm.txt \
  > /tmp/dft-vm-control.log 2>&1
grep -c "0xd0" /tmp/dft-vm-control.log    # expect 0: MECAFF declines DDM
```

VM must still transfer over **CUT** with DDM advertised. That is what proves the flag does not break a CUT host. Before trusting the run, prove the session's state: **`QUERY DISK A` must answer `Ready;`** — `?CP: QUERY` means the reconnect trap and a void run. And **do not log off a reconnected machine without asking**: the session may be the user's.

- [ ] **Step 6: Record it in the runbook**

Add a section to `docs/live-testing.md` under *Executed so far* and a detailed one lower down, giving: the wire bytes, the geometry, the `cmp` result both ways, the VM control's zero `0xd0` count, and anything measured that contradicts this plan. Follow the existing sections' shape — they quote bytes and name what would have made the result invalid.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/scripts/dft-tso.txt docs/live-testing.md
git commit -m "docs: DFT live against MVS/TSO at 43x80, with VM as the CUT control

<Replace with what the run actually measured, including anything that
contradicted the plan. If the run failed, say so and what it showed.>"
```

---

### Task 11: Answer the spec's open question from the wire

**Files:** `docs/superpowers/specs/2026-09-24-dft-file-transfer-design.md`, and code only if the answer demands it.

The spec deliberately left one question open: **does DFT honour `Recfm`/`Lrecl`/`Blksize` the way CUT does?** They are `IND$FILE` command keywords rather than protocol, so they should ride through unchanged — but TSO's DFT `Open` carries **its own record size** at payload offset 24, which CUT has no equivalent of.

- [ ] **Step 1: Read the record size TSO actually sent**

From Task 10's trace, find the `Open` frames and decode the long-form ones. Task 3 already parses `recordSize`; log it.

- [ ] **Step 2: Compare against what was requested**

Run two transfers differing only in `Lrecl`, and compare the `Open`'s record size in each. Three cases, as stage 1's `LRECL` work needed: without the third you cannot distinguish a host ignoring the keyword from a client never sending it.

- [ ] **Step 3: Write the answer into the spec**

Replace the *One question deliberately left open* section with what was measured. If the record size simply echoes `Lrecl`, say so and cite the bytes. If it does not, say what it was instead.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-24-dft-file-transfer-design.md
git commit -m "docs: answer DFT's open question from the wire

<What the Open's record size turned out to be, with the bytes.>"
```

---

### Task 12: Merge

- [ ] **Step 1: Re-run the full gate ON THE MERGE COMMIT**

Not on the branch tip — on the merge commit itself. That is this project's standing rule and it has caught real problems. Every command from Task 9 Step 4, plus `drive-playback.py`.

- [ ] **Step 2: Merge `--no-ff`**

```bash
git checkout main && git merge --no-ff dft-file-transfer
```

- [ ] **Step 3: Update the docs that summarise state**

`docs/HANDOFF.md`'s START HERE, `README.md`'s transfer sections and its `-ddm` warning (which currently says DFT is unimplemented and that `-ddm on` breaks a transfer — **both stop being true with this branch**), and the roadmap entry.

**Check the summaries, headings and blurbs, not just the prose bodies.** The recurring failure mode here is a fix that reaches a paragraph and never the heading or expected-count line above it.

- [ ] **Step 4: Decide the default with the user**

The user's decision of 2026-09-24 was to **flip `-ddm` to default on once DFT is tested**. Task 10 is that test. Flipping is a one-line change plus a measured blast radius — and it will move both Hercules hosts onto whichever protocol they prefer, so CUT's live witnesses become statements about a path real hosts here no longer take. **Ask before flipping**, and measure the blast radius the way the `-model` flip was measured.

- [ ] **Step 5: Push**

```bash
git push origin main
```

---

## Self-review

**Spec coverage.** Wire constants → Task 1. State machine → Tasks 5-6. DDM advertisement → already built (`9f92816`), guarded in Task 9. Inbound plumbing → Task 7. The two details the spec makes their own tasks: Read Modified hook → Task 8, `Open`'s two lengths and `FT:MSG` → Task 3. Host-free verification → Tasks 1-8. Blast radius → Task 9. Live run → Task 10. The deliberately-open question → Task 11. Error handling (`ftUserCancel`, inbound-edge cancellation) → Tasks 5-6. Not-in-scope items (default flip, GUI form, gateway) stay out, except that Task 12 Step 4 *asks* about the flip rather than doing it.

**Corrections this plan makes to the spec, deliberately.** The spec's `ctlr.c:761`/`:987` are `:760`/`:986`. The spec's offset table is x3270's and needs −3 for our parser; that is stated in the preamble, encoded as arithmetic in Task 3, and confirmed against the probe's own recorded byte counts in Task 7.

**Four defects found in THIS plan by checking it against `ft_dft.c` after drafting it, all fixed above and each recorded at the point it bit:**
1. **`Close` was made to end the transfer and hand over the data.** It does not; the host's `FT:MSG` / `TRANS03` does, and `ft_complete` appears only in that branch. This is preamble note 6, because it would have reported success before the host committed the file.
2. **`Set Cursor` and `Insert` were made to send an Open ack.** Both x3270 handlers are empty. Six unsolicited bytes to a live mainframe, mid-transfer.
3. **An unknown request type was made to send an error reply.** x3270 only traces. Same shape as (2).
4. **The upload frame's SF length was `+17` where it must be `+16`.** The length excludes the AID (`obptr - (obuf + 1)`, `ft_dft.c:655`) while the data offset includes it, so both numbers are "right" for different things. Every upload frame would have overstated its length by one. Task 6 Step 5(b) mutation-checks precisely this.

That is four wire-visible defects in a plan written from a spec that was itself written from the source — the standing lesson that the implementer should verify against the source rather than trust the plan, applied to this plan. **Expect more, and prefer `ft_dft.c` to this document wherever they disagree.**

**Type consistency.** `TransferDirection` and `TransferResult` are imported from the existing `ft/transfer.ts` rather than redeclared, so a DFT result is the same shape a front end already handles. `DftStep` is new and deliberately unlike `TransferStep`: `reply` bytes instead of an `ack` AID, which is the CUT/DFT asymmetry the spec insists on. `u16`/`u32` are defined once in `dftFrames.ts` and exported for `dft.ts` (Task 6 Step 3 says so). `retainedFrame`, `isMessage`, `transferred`, `result`, `complete` and `cancel()` are the names used in every task that references them.

**The test seams are confirmed, not guessed.** `handleRecord` is private (`session.ts:620`) and
reachable only via the telnet `onRecord` callback (`:457`), so Tasks 7 and 8 drive real wire bytes
through `FakeConnection` and observe `conn.sent` — the helpers at `session.test.ts:9-36`, to be
copied rather than reinvented. `SnaCmd.RM`/`RB` are `0xf6`/`0xf2` (`constants.ts:276-279`).
`negotiate()` is required in each: `is3270Mode()` is false on an unconnected session, so a record
would be dropped before reaching the new code and every test would pass vacuously.

**One number still rests on its own test.** Task 6's `chunk.length + 17` encodes the upload
frame's header size; the test asserts the data begins at index 17, so a wrong value fails
immediately and visibly rather than corrupting a file. Task 6 Step 5 mutation-checks it.
