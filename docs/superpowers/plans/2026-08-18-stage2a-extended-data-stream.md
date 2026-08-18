# Stage 2a: Extended Data Stream, Query Reply, Configurable Terminal Type

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MVS 3.8j TSO reachable by advertising the extended data stream terminal type and answering the Read Partition (Query) that TSO then sends.

**Architecture:** Three new core modules — typed structured-field parsing (`stream/sf.ts`), a capability-list Query Reply builder (`queryreply.ts`), and terminal-type resolution (`termtype.ts`) — wired through the existing `parse → execute → session` pipeline. `execute` gains an `sfReply` intent that `session` sends via the same `telnet.sendRecord` path host-initiated reads already use. SFE becomes a field-defining order; SA and MF stay unimplemented but counted.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), vitest, npm workspaces. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-stage2a-extended-data-stream-design.md` — read it first. It records why each decision was made and, more importantly, what is deliberately **out** of scope.

---

## Before you start

**Baseline:** branch `stage1-protocol-core`, 319 tests passing, `npm run typecheck` clean, working tree clean. Verify with `npm test` before task 1; if it is not green, stop and report rather than building on a broken base.

**Build command is `npm run build`, NOT `npm run build --workspaces`** — the latter fails on the data-only fixtures package.

**The project's standing rule, which this plan depends on:** verify every wire constant against `~/3270/ref/pages.txt` (greppable text of GA23-0059) or x3270's source at `~/src/suite3270-4.5/`, never from memory and never by copying the capture. This rule has already caught two errors in the design phase — an OCR-mangled attribute type, and a missing pair of reserved flag bytes. If a byte in this plan disagrees with the manual, **the manual wins and the plan is wrong**; say so rather than making the test match the plan.

**Do not change the default terminal type.** It stays `IBM-3278-2` so the committed VM/370 conformance goldens keep passing. The TSO run passes `-model 3278-2-E` explicitly.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `packages/core/src/stream/sf.ts` | Split a WSF payload into typed structured-field tokens; recognise Read Partition. Pure, no I/O. |
| `packages/core/src/queryreply.ts` | Encode Query Reply units from a capability list. Pure; takes geometry, returns bytes. |
| `packages/core/src/termtype.ts` | Resolve `-model` / `--terminal-type` to a ttype string. Pure, no I/O. |
| `packages/core/test/sf.test.ts` | Tests for the above parser, including the malformed-length cases. |
| `packages/core/test/queryreply.test.ts` | Byte-layout tests against GA23-0059, plus the fixture comparison. |
| `packages/core/test/termtype.test.ts` | Mapping and override precedence. |

**Modify:**

| File | Change |
|---|---|
| `packages/core/src/constants.ts` | Add `Sfid`, `ReadPartitionType`, `Qcode`, `XA_3270`, and the Query Reply geometry constants. |
| `packages/core/src/stream/parse.ts` | Replace the opaque `structuredFields` token with typed SF tokens; split `deferred` so SFE is its own token. |
| `packages/core/src/stream/execute.ts` | Add `sfReply` and the per-order counters; implement SFE. |
| `packages/core/src/session.ts` | Send the Query Reply; thread `terminalType` through to the telnet layer. |
| `packages/core/src/index.ts` | Export the three new modules. |
| `packages/cli/src/main.ts` | Parse `-model` and `--terminal-type` from argv. |
| `packages/cli/src/runner.ts` | `defaultSession()` accepts a terminal type. |
| `docs/live-testing.md` | Correct the two superseded paragraphs (lines 479, 537). |
| `docs/HANDOFF.md` | Update state at the end. |

**Ordering rationale:** constants → parser → executor → session → CLI, so every task builds on committed, tested work below it. The doc corrections come last because the live run may add findings to them.

---

## Task 1: Wire constants for structured fields

**Files:**
- Modify: `packages/core/src/constants.ts` (append after the existing `Order` block, near line 95)
- Test: `packages/core/test/constants.test.ts`

Constants only — no logic. Kept in one commit so later tasks can cite them, and so a wrong byte shows up in one place rather than scattered through three modules.

- [ ] **Step 1: Verify each value against the manual before writing it**

Run these and read the output. Do not skip this — it is the whole point of the task.

```bash
grep -n "Identifies this structured field as Read" -A 12 ~/3270/ref/pages.txt | head -20
grep -n "X'CO' 3270 Field attribute" ~/3270/ref/pages.txt
grep -n "XA_3270" ~/src/suite3270-4.5/include/3270ds.h
```

Expected: Read Partition is SFID `0x01`, PID `0xFF` for query operations, TYPE `0x02` = Query and `0x03` = Query List. The field-attribute pair type is `0xC0` — the manual's table reads `X'CO'` (OCR of `C0`) and `3270ds.h:230` defines `XA_3270 0xc0`. **The manual's prose example OCRs as `X'C8'`; that is OCR damage. Use 0xC0.**

- [ ] **Step 2: Write the failing test**

Append to `packages/core/test/constants.test.ts`, inside the existing top-level `describe`:

```typescript
  it('structured field identifiers match GA23-0059', () => {
    // Read Partition format, p. 5-50 (pages.txt:6342-6356).
    expect(Sfid.READ_PARTITION).toBe(0x01);
    expect(Sfid.QUERY_REPLY).toBe(0x81);
    expect(PID_QUERY).toBe(0xff);
    expect(ReadPartitionType.QUERY).toBe(0x02);
    expect(ReadPartitionType.QUERY_LIST).toBe(0x03);
  });

  it('query reply codes match GA23-0059 table 6-1', () => {
    expect(Qcode.SUMMARY).toBe(0x80);
    expect(Qcode.USABLE_AREA).toBe(0x81);
    expect(Qcode.IMPLICIT_PARTITION).toBe(0xa6);
  });

  it('the SFE field-attribute pair type is 0xC0, not the 0xC8 the manual prose OCRs as', () => {
    // Manual attribute-type table gives X'C0' 3270 Field attribute; x3270
    // include/3270ds.h:230 defines XA_3270 0xc0. Both checked.
    expect(XA_3270).toBe(0xc0);
  });
```

Add the new names to that file's existing import from `../src/constants.js`.

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/core/test/constants.test.ts`
Expected: FAIL — `Sfid is not defined` (or a TS error that the names do not exist).

- [ ] **Step 4: Add the constants**

Append to `packages/core/src/constants.ts`:

```typescript
/**
 * Structured field identifiers (SFID), GA23-0059 p. 5-50 and chapter 6.
 *
 * 0x81 is BOTH the Query Reply SFID (outbound-from-us, chapter 6) and, as a
 * QCODE, the Usable Area reply code. They occupy different byte positions and
 * are never interchangeable: SFID is byte 2, QCODE is byte 3.
 */
export const Sfid = {
  READ_PARTITION: 0x01,
  QUERY_REPLY: 0x81,
} as const;

/** PID value meaning "this is a query, not a read of partition 0x00-0x7E". */
export const PID_QUERY = 0xff;

/** Read Partition TYPE byte. We answer QUERY only; see the stage 2a spec. */
export const ReadPartitionType = {
  QUERY: 0x02,
  QUERY_LIST: 0x03,
} as const;

/** Query Reply codes (QCODE), GA23-0059 table 6-1. Only what we implement. */
export const Qcode = {
  SUMMARY: 0x80,
  USABLE_AREA: 0x81,
  IMPLICIT_PARTITION: 0xa6,
} as const;

/**
 * SFE/MF attribute-type for the basic 3270 field attribute.
 *
 * 0xC0, confirmed twice because the manual's prose example OCRs as X'C8':
 * the attribute-type table reads X'C0' 3270 Field attribute, and x3270's
 * include/3270ds.h:230 defines XA_3270 0xc0. Numerically equal to
 * FA.PRINTABLE, which is a coincidence of the architecture, not a relation —
 * do not unify them.
 */
export const XA_3270 = 0xc0;
```

- [ ] **Step 5: Run the test and the whole suite**

Run: `npx vitest run packages/core/test/constants.test.ts && npm test`
Expected: the new tests PASS; total goes from 319 to 322.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/constants.ts packages/core/test/constants.test.ts
git commit -m "Add structured field wire constants, verified against GA23-0059

The SFE field-attribute pair type is 0xC0. The manual's prose example OCRs
as X'C8'; the attribute-type table and x3270's 3270ds.h:230 both give 0xC0."
```

---

## Task 2: Parse the WSF payload into typed tokens

**Files:**
- Create: `packages/core/src/stream/sf.ts`
- Create: `packages/core/test/sf.test.ts`
- Modify: `packages/core/src/stream/parse.ts:88-93` (the `WriteStructuredField` branch), and the `Token` union at lines 28-40

Today `parse.ts:92` wraps the entire WSF payload in one opaque `{kind:'structuredFields', data}` token. This splits it on length boundaries into typed tokens.

**A WSF record may carry SEVERAL structured fields**, each `L L <SFID> <params...>` where L covers the length bytes themselves. That framing is what the parser must respect.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/sf.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseStructuredFields, SfParseError } from '../src/stream/sf.js';

describe('structured field framing', () => {
  it('parses the Read Partition Query that TSO sends', () => {
    // From packages/fixtures/x3270/tso-query-reply.txt, after the telnet layer
    // has un-doubled ff ff -> ff. L=5 covers 00 05 01 ff 02.
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02));
    expect(fields).toEqual([
      { kind: 'readPartition', pid: 0xff, type: 0x02 },
    ]);
  });

  it('parses several structured fields in one payload', () => {
    const fields = parseStructuredFields(Uint8Array.of(
      0x00, 0x05, 0x01, 0xff, 0x02,
      0x00, 0x05, 0x01, 0xff, 0x03,
    ));
    expect(fields).toHaveLength(2);
    expect(fields[1]).toEqual({ kind: 'readPartition', pid: 0xff, type: 0x03 });
  });

  it('keeps an unrecognised SFID as an opaque field rather than failing', () => {
    // A host may send anything; an unknown SF is a logged no-op, not an error.
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x40, 0xaa, 0xbb));
    expect(fields).toEqual([
      { kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of(0xaa, 0xbb) },
    ]);
  });

  it('records the PID rather than assuming the query value', () => {
    // A read against a real partition, which we do not support. It must be
    // distinguishable in the trace from the query case.
    const fields = parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0x00, 0x02));
    expect(fields[0]).toEqual({ kind: 'readPartition', pid: 0x00, type: 0x02 });
  });

  it('rejects a zero length, which would otherwise loop forever', () => {
    // THE nasty case: a naive loop reads L=0 as "advance by zero" and hangs.
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x00, 0x01)))
      .toThrow(SfParseError);
  });

  it('rejects a length shorter than the two length bytes plus an SFID', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x02, 0x01)))
      .toThrow(SfParseError);
  });

  it('rejects a length running past the end of the payload', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x20, 0x01, 0xff, 0x02)))
      .toThrow(SfParseError);
  });

  it('rejects a trailing partial field', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0x02, 0x00)))
      .toThrow(SfParseError);
  });

  it('rejects a Read Partition too short to hold PID and TYPE', () => {
    expect(() => parseStructuredFields(Uint8Array.of(0x00, 0x04, 0x01, 0xff)))
      .toThrow(SfParseError);
  });

  it('accepts an empty payload as no structured fields', () => {
    expect(parseStructuredFields(Uint8Array.of())).toEqual([]);
  });
});

describe('isQueryRequest', () => {
  it('accepts a Query against the query PID', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0xff, type: 0x02 })).toBe(true);
  });

  it('rejects a Query List, whose subsetting rules we have not implemented', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0xff, type: 0x03 })).toBe(false);
  });

  it('rejects a read against a real partition', () => {
    expect(isQueryRequest({ kind: 'readPartition', pid: 0x00, type: 0x02 })).toBe(false);
  });

  it('rejects an unknown structured field', () => {
    expect(isQueryRequest({ kind: 'unknownSf', sfid: 0x40, data: Uint8Array.of() })).toBe(false);
  });
});
```

Import it in the test file's first line alongside the others:

```typescript
import { parseStructuredFields, isQueryRequest, SfParseError } from '../src/stream/sf.js';
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/test/sf.test.ts`
Expected: FAIL — cannot resolve `../src/stream/sf.js`.

- [ ] **Step 3: Write the parser**

Create `packages/core/src/stream/sf.ts`:

```typescript
import { Sfid, ReadPartitionType } from '../constants.js';

/**
 * Structured field framing for the inbound (host to us) direction.
 *
 * A Write Structured Field record carries one or more structured fields, each
 * `L L SFID <params...>` where the 16-bit L INCLUDES the two length bytes
 * (GA23-0059 chapter 5). The bytes here have already been un-doubled by the
 * telnet layer (telnet.ts:122), so a 0xFF in a parameter is a single 0xFF.
 */

export class SfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SfParseError';
  }
}

export type StructuredField =
  /** Read Partition. We answer TYPE=QUERY with PID=0xFF; see stage 2a spec. */
  | { kind: 'readPartition'; pid: number; type: number }
  /** Any SFID we do not implement: counted and traced, never fatal. */
  | { kind: 'unknownSf'; sfid: number; data: Uint8Array };

/** Smallest legal structured field: two length bytes and an SFID. */
const MIN_SF_LENGTH = 3;

export function parseStructuredFields(payload: Uint8Array): StructuredField[] {
  const fields: StructuredField[] = [];
  let i = 0;

  while (i < payload.length) {
    if (i + 2 > payload.length) {
      throw new SfParseError(
        `structured field truncated: ${payload.length - i} byte(s) left, need at least 2 for the length`,
      );
    }
    const length = (payload[i]! << 8) | payload[i + 1]!;

    // A zero or undersized length must be rejected BEFORE it is used to
    // advance, or the loop never terminates.
    if (length < MIN_SF_LENGTH) {
      throw new SfParseError(`structured field length ${length} below the minimum ${MIN_SF_LENGTH}`);
    }
    if (i + length > payload.length) {
      throw new SfParseError(
        `structured field length ${length} runs past the end of a ${payload.length}-byte payload`,
      );
    }

    const sfid = payload[i + 2]!;
    // Parameters only: excludes the length bytes and the SFID.
    const params = payload.subarray(i + MIN_SF_LENGTH, i + length);

    if (sfid === Sfid.READ_PARTITION) {
      if (params.length < 2) {
        throw new SfParseError(`Read Partition needs PID and TYPE, got ${params.length} byte(s)`);
      }
      // PID is RECORDED, not assumed: a non-0xFF value is a read against a real
      // partition, which we do not support, and the trace must show the
      // difference rather than silently treating it as a query.
      fields.push({ kind: 'readPartition', pid: params[0]!, type: params[1]! });
    } else {
      fields.push({ kind: 'unknownSf', sfid, data: Uint8Array.from(params) });
    }

    i += length;
  }

  return fields;
}

/**
 * True for the one request we answer: a Query against the query PID.
 *
 * Both halves matter. A non-query PID is a read against a real partition, which
 * we do not support, and TYPE 0x03 is a Query List whose subsetting rules we
 * have not implemented — answering either with our capabilities would be wrong.
 */
export function isQueryRequest(sf: StructuredField): boolean {
  return sf.kind === 'readPartition'
    && sf.pid === PID_QUERY
    && sf.type === ReadPartitionType.QUERY;
}
```

Import `PID_QUERY` alongside the others at the top of the file:

```typescript
import { Sfid, PID_QUERY, ReadPartitionType } from '../constants.js';
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run packages/core/test/sf.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/stream/sf.ts packages/core/test/sf.test.ts
git commit -m "Parse the WSF payload into typed structured fields

Recognises Read Partition and keeps unknown SFIDs opaque. Rejects a
zero-length field, which a naive loop would read as advance-by-zero and
hang on."
```

---

## Task 3: Wire typed structured fields into the record parser

**Files:**
- Modify: `packages/core/src/stream/parse.ts` — the `Token` union (lines 28-40), the `WriteStructuredField` branch (lines 88-93), and `describeRecord` (line 244)
- Modify: `packages/core/test/parse.test.ts` — two existing tests change; see step 1

This replaces the opaque `structuredFields` token with the typed fields from task 2.

**Two existing tests change, and one of them is a real behaviour change rather than a rename.** Read this before editing:

1. `parse.test.ts:35` ("keeps the payload unexamined") asserts the opaque token. It becomes an assertion about typed tokens.
2. `parse.test.ts:46` ("accepts BOTH WSF encodings") feeds `WSF 0x00 0x05` — **a length claiming 5 bytes when only 2 are present.** That is malformed, and it only passed because the payload was never examined. Typed parsing correctly rejects it. The test's actual purpose is checking that *the command byte* decodes in both encodings, so give it a well-formed payload rather than deleting it.

- [ ] **Step 1: Update the two existing tests to the new behaviour**

In `packages/core/test/parse.test.ts`, replace the "keeps the payload unexamined" test with:

```typescript
  it('parses Write Structured Field into typed structured fields', () => {
    const r = parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02));
    expect(r.command).toBe('WriteStructuredField');
    expect(r.tokens).toEqual([
      { kind: 'structuredField', field: { kind: 'readPartition', pid: 0xff, type: 0x02 } },
    ]);
  });

  it('rejects a WSF whose declared length exceeds the payload', () => {
    // Was accepted while the payload was opaque. A length of 5 with 2 bytes
    // present is malformed and must not reach the executor.
    expect(() => parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05))).toThrow(ParseError);
  });
```

Then in the "accepts BOTH WSF encodings" test, replace both truncated payloads with complete ones:

```typescript
    expect(parseRecord(Uint8Array.of(SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02)).command)
      .toBe('WriteStructuredField');
    expect(parseRecord(Uint8Array.of(Cmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02)).command)
      .toBe('WriteStructuredField');
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/core/test/parse.test.ts`
Expected: FAIL — the typed-token test gets `{kind:'structuredFields', data:...}`, and the malformed-length test does not throw.

- [ ] **Step 3: Change the token union**

In `packages/core/src/stream/parse.ts`, add the import at the top:

```typescript
import { parseStructuredFields, SfParseError, type StructuredField } from './sf.js';
```

Replace the `structuredFields` member of the `Token` union:

```typescript
  /** One structured field from a WSF record, parsed by stream/sf.ts. */
  | { kind: 'structuredField'; field: StructuredField };
```

- [ ] **Step 4: Parse the payload in the WSF branch**

Replace the `WriteStructuredField` branch (currently `parse.ts:88-93`):

```typescript
  // Non-SNA WSF is 0x11, the same value as the SBA order; position tells them
  // apart, which is why this check is on the command byte only.
  if (command === 'WriteStructuredField') {
    const data = record.subarray(i);
    try {
      const tokens: Token[] = parseStructuredFields(data)
        .map((field) => ({ kind: 'structuredField', field }));
      return { command, tokens };
    } catch (e) {
      // Surface SF framing errors as ParseError so session.ts maps them to
      // X PROG the same way as every other malformed record. Callers must not
      // have to know about a second error type.
      if (e instanceof SfParseError) throw new ParseError(e.message);
      throw e;
    }
  }
```

- [ ] **Step 5: Update the trace annotation**

In `describeRecord`, replace the `structuredFields` case:

```typescript
      case 'structuredField':
        switch (t.field.kind) {
          case 'readPartition':
            parts.push(`ReadPartition(pid=0x${t.field.pid.toString(16)},type=0x${t.field.type.toString(16).padStart(2, '0')})`);
            break;
          case 'unknownSf':
            parts.push(`SF(sfid=0x${t.field.sfid.toString(16).padStart(2, '0')},${t.field.data.length}B)`);
            break;
        }
        break;
```

- [ ] **Step 6: Fix the executor so it still compiles**

`execute.ts:69` and `execute.ts:211` both reference `'structuredFields'`. Task 5 rewrites them properly; for now make them compile by renaming the string in both places:

```typescript
        if (t.kind === 'structuredField') result.structuredFieldsIgnored++;
```

```typescript
    case 'structuredField':
      return addr;
```

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS. Total 323 (319 + 3 from task 1 + 10 from task 2, minus 9 — the WSF test split into two so net +1... just confirm the number is green and no test fails; do not force it to a predicted count).

If `execute.test.ts:222` (`structuredFieldsIgnored` is 1) fails, check its input record is a well-formed structured field; a truncated one now throws.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/stream/parse.ts packages/core/src/stream/execute.ts packages/core/test/parse.test.ts
git commit -m "Parse WSF payloads into typed tokens instead of an opaque blob

A WSF whose declared length exceeds its payload is now rejected. That case
was previously accepted because the payload was never examined; one
existing test relied on it to check command decoding and now uses a
well-formed field."
```

---

## Task 4: Build Query Reply units from a capability list

**Files:**
- Create: `packages/core/src/queryreply.ts`
- Create: `packages/core/test/queryreply.test.ts`

The spec's standing directive: **generated from a capability list, not a hardcoded byte blob**, so advertising a capability later is one list entry. Summary's QCODE list is derived *from that list* so it cannot drift out of sync with what is actually sent.

**Verify these layouts before writing code:**

```bash
sed -n '11579,11620p' ~/3270/ref/pages.txt   # Usable Area base, p. 6-101
sed -n '10522,10528p' ~/3270/ref/pages.txt   # Implicit Partition BASE, p. 6-71
sed -n '10557,10566p' ~/3270/ref/pages.txt   # Sizes for Display SDP, p. 6-72
```

**The nesting is the thing to get right.** Implicit Partition is a base (`L L SFID QCODE FLAGS FLAGS` — bytes 4-5 are two reserved bytes) with the 11-byte SDP *inside* it: 6 + 11 = 17 = x3270's L=0x11. An earlier spec draft dropped those two reserved bytes, which would have shifted every subsequent byte.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/queryreply.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQueryReply, DEFAULT_CAPABILITIES } from '../src/queryreply.js';
import { AID, Qcode, Sfid } from '../src/constants.js';

const GEOMETRY = { rows: 24, cols: 80 };

/** Split a reply body (after the AID) into its length-prefixed units. */
function units(reply: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let i = 1; // skip the AID
  while (i < reply.length) {
    const len = (reply[i]! << 8) | reply[i + 1]!;
    out.push(reply.subarray(i, i + len));
    i += len;
  }
  return out;
}

describe('query reply', () => {
  it('starts with the Query Reply AID', () => {
    // GA23-0059 p. 6-19: inbound structured fields are preceded by AID X'88'.
    expect(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY)[0]).toBe(AID.SF);
    expect(AID.SF).toBe(0x88);
  });

  it('sends exactly the three units we honour', () => {
    const parsed = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    expect(parsed).toHaveLength(3);
    // Every unit is SFID 0x81 (Query Reply) with its QCODE in byte 3.
    expect(parsed.map((u) => u[2])).toEqual([Sfid.QUERY_REPLY, Sfid.QUERY_REPLY, Sfid.QUERY_REPLY]);
    expect(parsed.map((u) => u[3])).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.IMPLICIT_PARTITION,
    ]);
  });

  it('every unit declares a length matching its actual byte count', () => {
    for (const u of units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))) {
      expect((u[0]! << 8) | u[1]!).toBe(u.length);
    }
  });

  it('derives the Summary QCODE list from the capability list itself', () => {
    // p. 6-20: Summary lists the QCODEs of every reply supported, INCLUDING
    // its own. Deriving it means it cannot disagree with what we send.
    const summary = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[0]!;
    expect(Array.from(summary.subarray(4))).toEqual([
      Qcode.SUMMARY, Qcode.USABLE_AREA, Qcode.IMPLICIT_PARTITION,
    ]);
  });

  it('encodes Usable Area per GA23-0059 p. 6-101', () => {
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[1]!;
    // L L SFID QCODE FLAGS FLAGS W W H H UNITS Xr(4) Yr(4) AW AH BUFFSZ(2)
    expect(ua.length).toBe(23);
    expect((ua[6]! << 8) | ua[7]!).toBe(80);    // W
    expect((ua[8]! << 8) | ua[9]!).toBe(24);    // H
    expect((ua[21]! << 8) | ua[22]!).toBe(1920); // BUFFSZ = 80 * 24
  });

  it('nests the Sizes-for-Display SDP inside the Implicit Partition base', () => {
    const ip = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[2]!;
    // Base is 6 bytes (L L SFID QCODE + two RESERVED flag bytes, p. 6-71),
    // then an 11-byte SDP (p. 6-72). Dropping the reserved bytes shifts
    // everything after them.
    expect(ip.length).toBe(17);
    expect(ip[4]).toBe(0x00);
    expect(ip[5]).toBe(0x00);
    const sdp = ip.subarray(6);
    expect(sdp[0]).toBe(0x0b); // L
    expect(sdp[1]).toBe(0x01); // SDPID: Sizes for Display Devices
    expect((sdp[3]! << 8) | sdp[4]!).toBe(80);  // WD
    expect((sdp[5]! << 8) | sdp[6]!).toBe(24);  // HD
    expect((sdp[7]! << 8) | sdp[8]!).toBe(80);  // WA — equals default
    expect((sdp[9]! << 8) | sdp[10]!).toBe(24); // HA — equals default
  });

  it('advertises the alternate size as the default, which the manual requires', () => {
    // p. 6-72: "If the device does not have an alternate screen size, the value
    // for the alternate screen size must be that of the default size."
    const sdp = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY))[2]!.subarray(6);
    expect(Array.from(sdp.subarray(3, 7))).toEqual(Array.from(sdp.subarray(7, 11)));
  });

  it('reflects a different geometry in both the reply and the buffer size', () => {
    // Geometry is a parameter, not a constant, even though 2a only ships 24x80.
    const ua = units(buildQueryReply(DEFAULT_CAPABILITIES, { rows: 32, cols: 80 }))[1]!;
    expect((ua[8]! << 8) | ua[9]!).toBe(32);
    expect((ua[21]! << 8) | ua[22]!).toBe(2560);
  });

  it('matches x3270 byte-for-byte on the units we both send', () => {
    // SCOPE, and read this before extending the test: x3270's reply carries ten
    // units and ours carries three, so the whole records CANNOT be equal. What
    // is comparable is the three units we both send, and those are worth
    // comparing because this host accepted x3270's.
    //
    // WHAT THIS DOES NOT COVER: that our three-unit SUBSET is acceptable to
    // TSO. Nothing offline can show that; only the live run in task 10 can.
    // A passing test here plus a failing live run is a coherent outcome, not a
    // contradiction.
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(
      join(here, '..', '..', 'fixtures', 'x3270', 'tso-query-reply.txt'), 'utf8');
    const theirs = Uint8Array.from(
      text.split('\n')
        .filter((l) => l.startsWith('> '))
        .flatMap((l) => l.slice(2).trim().split(/\s+/))
        .map((h) => parseInt(h, 16))
        .filter((b) => !Number.isNaN(b)),
    );
    // TWO layers of telnet framing come off, not one. An earlier draft of this
    // plan stripped only IAC EOR, which HANGS AND OOMS the vitest worker:
    // content 0xff is IAC-doubled on the wire, x3270's Color unit contains a
    // real 0xff, so leaving `ff ff` in desynchronizes the length walk, a later
    // unit reads len=0, `i` never advances, and the loop allocates until the
    // heap dies — reporting nothing useful. The fixture's own header
    // (tso-query-reply.txt:16-25) warns about exactly this doubling.
    // 183 wire bytes - 2 (IAC EOR) - 1 (doubled IAC) = 180 = ten units.
    // Make `units()` throw on any length below 4 as well, so a future desync
    // fails loudly instead of exhausting memory.
    const framed = theirs.subarray(0, theirs.length - 2);
    const undoubled: number[] = [];
    for (let i = 0; i < framed.length; i++) {
      undoubled.push(framed[i]!);
      if (framed[i] === 0xff && framed[i + 1] === 0xff) i++;
    }
    const theirUnits = units(Uint8Array.from(undoubled));
    const byQcode = new Map(theirUnits.map((u) => [u[3]!, u]));

    const ourUnits = units(buildQueryReply(DEFAULT_CAPABILITIES, GEOMETRY));
    for (const ours of ourUnits) {
      const qcode = ours[3]!;
      if (qcode === Qcode.SUMMARY) continue; // lists ten QCODEs for them, three for us
      expect(Array.from(ours), `unit 0x${qcode.toString(16)} differs from x3270`)
        .toEqual(Array.from(byQcode.get(qcode)!));
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/test/queryreply.test.ts`
Expected: FAIL — cannot resolve `../src/queryreply.js`.

- [ ] **Step 3: Write the builder**

Create `packages/core/src/queryreply.ts`:

```typescript
import { AID, Qcode, Sfid } from './constants.js';

/**
 * Query Reply, the answer to a host's Read Partition (Query).
 *
 * Built from a CAPABILITY LIST rather than a hardcoded byte blob, so
 * advertising something later is one list entry and the Summary unit cannot
 * disagree with what is actually sent.
 *
 * Stage 2a advertises the minimal honest set: Summary, Usable Area, Implicit
 * Partition. x3270 sends ten, including Color and Highlighting — which would
 * invite the SA orders stage 2a deliberately does not implement. Every unit
 * here is one we honour. See the stage 2a design doc.
 */

export interface Geometry {
  rows: number;
  cols: number;
}

export interface Capability {
  qcode: number;
  /** Unit body AFTER `L L SFID QCODE` — the builder writes that prefix. */
  params: (geometry: Geometry, all: readonly Capability[]) => number[];
}

/** Big-endian 16-bit. */
const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

/**
 * Summary (QCODE 0x80), GA23-0059 p. 6-20.
 *
 * Every device must support it, and it lists the QCODEs of all supported
 * replies INCLUDING its own — which falls out of mapping the capability list.
 */
const summary: Capability = {
  qcode: Qcode.SUMMARY,
  params: (_geometry, all) => all.map((c) => c.qcode),
};

/**
 * Usable Area (QCODE 0x81), GA23-0059 p. 6-101.
 *
 * L L SFID QCODE FLAGS FLAGS W W H H UNITS Xr(4) Yr(4) AW AH BUFFSZ(2).
 * Bytes 0-20 are always mandatory; BUFFSZ (21-22) is required when any
 * self-defining parameter is present. Total 23 bytes, matching x3270's L=0x17.
 *
 * The fixed values are x3270's, which this host accepted: 12/14-bit addressing,
 * cell units, and the 3278 cell metrics. They are dimensional constants of the
 * device, not capability claims, so copying them advertises nothing we do not
 * honour.
 */
const usableArea: Capability = {
  qcode: Qcode.USABLE_AREA,
  params: (geometry) => [
    0x01,               // FLAGS: ADDR = 12/14-bit addressing allowed
    0x00,               // FLAGS: matrix character, cell units, no variable cells
    ...u16(geometry.cols), // W
    ...u16(geometry.rows), // H
    0x01,               // UNITS: millimetres
    0x00, 0x0a, 0x02, 0xe5, // Xr: 10/741
    0x00, 0x02, 0x00, 0x6f, // Yr: 2/111
    0x09,               // AW: X units per default cell
    0x0c,               // AH: Y units per default cell
    ...u16(geometry.rows * geometry.cols), // BUFFSZ, in character cells
  ],
};

/**
 * Implicit Partition (QCODE 0xA6).
 *
 * NESTED, and the nesting is easy to get wrong. The BASE is
 * `L L SFID QCODE FLAGS FLAGS` with bytes 4-5 RESERVED X'0000' (p. 6-71), and
 * the Sizes-for-Display self-defining parameter sits inside it (p. 6-72):
 * `L=0x0B SDPID=0x01 FLAGS=0x00 WD WD HD HD WA WA HA HA`. 6 + 11 = 17, which is
 * x3270's L=0x11. Omitting the two reserved bytes shifts every byte after them.
 *
 * Alternate equals default deliberately: p. 6-72 requires that a device with no
 * alternate screen size report the default as its alternate. Stage 2a does not
 * implement mid-session resize, so claiming a second size would be a lie the
 * host would act on.
 */
const implicitPartition: Capability = {
  qcode: Qcode.IMPLICIT_PARTITION,
  params: (geometry) => [
    0x00, 0x00,   // base FLAGS: reserved
    0x0b,         // SDP L
    0x01,         // SDPID: Implicit Partition Sizes for Display Devices
    0x00,         // SDP FLAGS: reserved
    ...u16(geometry.cols), ...u16(geometry.rows), // WD HD — default
    ...u16(geometry.cols), ...u16(geometry.rows), // WA HA — alternate == default
  ],
};

/** What stage 2a advertises. Adding a unit is one entry here. */
export const DEFAULT_CAPABILITIES: readonly Capability[] = [
  summary, usableArea, implicitPartition,
];

/**
 * The complete inbound record: AID 0x88 then each unit, length-prefixed.
 *
 * Returns pure 3270 data. IAC doubling is the telnet layer's job (telnet.ts:82),
 * which matters here because 0xFF appears in real reply content.
 */
export function buildQueryReply(
  capabilities: readonly Capability[],
  geometry: Geometry,
): Uint8Array {
  const out: number[] = [AID.SF];
  for (const cap of capabilities) {
    const params = cap.params(geometry, capabilities);
    // Length covers the two length bytes, SFID, QCODE and the parameters.
    const length = 4 + params.length;
    out.push(...u16(length), Sfid.QUERY_REPLY, cap.qcode, ...params);
  }
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run packages/core/test/queryreply.test.ts`
Expected: PASS, 9 tests.

**If the x3270 comparison test fails,** the manual is the authority — check the failing unit's bytes against the `sed` output from the top of this task before changing anything. A mismatch means either our encoder is wrong or the fixture parsing dropped a byte; do not "fix" it by relaxing the assertion.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/queryreply.ts packages/core/test/queryreply.test.ts
git commit -m "Build Query Reply units from a capability list

Summary, Usable Area and Implicit Partition, byte-identical to x3270 on all
three. Summary's QCODE list is derived from the capability list so it cannot
drift from what is sent.

Implicit Partition nests an SDP inside a 6-byte base whose bytes 4-5 are
reserved (p. 6-71); the SDP alone would have shifted every later byte."
```

---

## Task 5: Split SFE out of the `deferred` token

**Files:**
- Modify: `packages/core/src/stream/parse.ts` — the `Token` union, and the `Order.SFE`/`Order.MF` branch at lines 190-210
- Modify: `packages/core/test/parse.test.ts`

Today SA, SFE and MF all become `{kind:'deferred', order, data}`. SFE is about to gain real behaviour, so it gets its own token with its attribute pairs already decoded. SA and MF stay `deferred`.

**Preserve the existing length arithmetic.** `parse.ts` computes `operandLen = 1 + count * 2` — one count byte plus that many type/value pairs. That is correct (GA23-0059 p. 4-4); this task decodes the same bytes into pairs rather than re-deriving the length.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/parse.test.ts`:

```typescript
  it('decodes SFE attribute pairs', () => {
    // SFE, 1 pair, type 0xC0 (3270 field attribute) value 0x60 (protected).
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x01, 0xc0, 0x60));
    expect(r.tokens).toEqual([
      { kind: 'sfe', pairs: [{ type: 0xc0, value: 0x60 }] },
    ]);
  });

  it('decodes an SFE with several pairs, keeping ones we do not honour', () => {
    // Type 0x42 is colour, which stage 2a drops at EXECUTE time — but the
    // parser still reports it, so the trace shows what the host actually sent.
    const r = parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SFE, 0x02, 0xc0, 0x60, 0x42, 0xf4));
    expect(r.tokens[0]).toEqual({
      kind: 'sfe',
      pairs: [{ type: 0xc0, value: 0x60 }, { type: 0x42, value: 0xf4 }],
    });
  });

  it('accepts an SFE with zero pairs', () => {
    // p. 4-5: "If SFE is sent with no type-value pairs (zero value for number
    // of pairs), defaults are set." It still defines a field.
    const r = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x00));
    expect(r.tokens).toEqual([{ kind: 'sfe', pairs: [] }]);
  });

  it('rejects an SFE whose pair count runs past the record', () => {
    expect(() => parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SFE, 0x04, 0xc0, 0x60)))
      .toThrow(ParseError);
  });

  it('leaves SA and MF as deferred tokens', () => {
    const sa = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.SA, 0x42, 0xf4));
    expect(sa.tokens).toEqual([
      { kind: 'deferred', order: Order.SA, data: Uint8Array.of(0x42, 0xf4) },
    ]);
    const mf = parseRecord(Uint8Array.of(SnaCmd.W, 0x00, Order.MF, 0x01, 0xc0, 0x60));
    expect(mf.tokens).toEqual([
      { kind: 'deferred', order: Order.MF, data: Uint8Array.of(0x01, 0xc0, 0x60) },
    ]);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/test/parse.test.ts`
Expected: FAIL — SFE still produces `{kind:'deferred', order:0x29, ...}`.

- [ ] **Step 3: Add the token type**

In the `Token` union in `packages/core/src/stream/parse.ts`, change the `deferred` comment and add `sfe`:

```typescript
  /** SA/MF: recognized so they can be skipped by length, not executed. */
  | { kind: 'deferred'; order: number; data: Uint8Array }
  /** SFE with its attribute pairs decoded. Defines a field; see execute.ts. */
  | { kind: 'sfe'; pairs: AttributePair[] }
```

And export the pair type above the union:

```typescript
/** One SFE/MF attribute type-value pair, GA23-0059 p. 4-4. */
export interface AttributePair {
  type: number;
  value: number;
}
```

- [ ] **Step 4: Split the parse branch**

Replace the combined `case Order.SFE: case Order.MF:` block (`parse.ts:190-210`) with:

```typescript
      case Order.SFE: {
        // One count byte, then that many type/value pairs (p. 4-4). A count of
        // zero is legal and still defines a field.
        flushRun();
        i++;
        need(1, 'SFE count');
        const count = record[i]!;
        const operandLen = 1 + count * 2;
        need(operandLen, 'SFE');
        const pairs: AttributePair[] = [];
        for (let p = 0; p < count; p++) {
          const at = i + 1 + p * 2;
          pairs.push({ type: record[at]!, value: record[at + 1]! });
        }
        tokens.push({ kind: 'sfe', pairs });
        i += operandLen;
        break;
      }
      case Order.MF: {
        // Same wire shape as SFE, but MF MODIFIES an existing field rather than
        // defining one, and stage 2a does not implement it. Kept opaque and
        // counted so the live run can show whether any host actually sends it.
        flushRun();
        i++;
        need(1, 'MF count');
        const count = record[i]!;
        const operandLen = 1 + count * 2;
        need(operandLen, 'MF');
        tokens.push({
          kind: 'deferred',
          order: Order.MF,
          data: Uint8Array.from(record.subarray(i, i + operandLen)),
        });
        i += operandLen;
        break;
      }
```

- [ ] **Step 5: Annotate it in the trace**

In `describeRecord`, add before the `deferred` case:

```typescript
      case 'sfe': parts.push(`SFE(${t.pairs.map((p) => `0x${p.type.toString(16)}=0x${p.value.toString(16)}`).join(',')})`); break;
```

- [ ] **Step 6: Make the executor compile**

`execute.ts`'s `case 'deferred'` no longer covers SFE, so TypeScript will flag a missing case. Add a temporary one immediately above it — task 6 replaces it:

```typescript
    case 'sfe':
      return addr;
```

- [ ] **Step 7: Run and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/stream/parse.ts packages/core/src/stream/execute.ts packages/core/test/parse.test.ts
git commit -m "Give SFE its own token with decoded attribute pairs

SA and MF stay deferred. MF has the same wire shape but modifies an
existing field rather than defining one, and stage 2a does not implement it."
```

---

## Task 6: Execute SFE as a field-defining order, and count SA/MF

**Files:**
- Modify: `packages/core/src/stream/execute.ts` — `ExecuteResult` (lines 20-33), the token loop (line 69), the `deferred` case (lines 204-212)
- Modify: `packages/core/test/execute.test.ts`

**Why SFE and not SA/MF:** SFE *defines a field*. Ignoring one leaves the screen without that field's structure, so `screen.fields()` misses it and Read Modified cannot report what the operator typed there — a structural failure, not a cosmetic one.

**The subtle case, and the reason this is not just "call setFieldAttribute":** an SFE with **no 0xC0 pair still defines a field**, with a default attribute of 0x00 (GA23-0059 p. 4-5, "If SFE is sent with no type-value pairs … defaults are set"). Skipping the field because the pair list lacked 0xC0 would lose the field entirely — the exact failure SFE is being implemented to prevent.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/execute.test.ts`. Match the existing helper style in that file for building a screen and running a record.

```typescript
  it('SFE defines a field with the 0xC0 pair as its attribute', () => {
    const screen = new Screen();
    // W, WCC 0, SBA(0), SFE 1 pair type 0xC0 value 0x60 (protected).
    execute(screen, parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x01, 0xc0, 0x60)));
    expect(screen.attributeAt(0)).toBe(0x60);
    expect(screen.isFormatted()).toBe(true);
    const field = screen.fieldAt(1);
    expect(field?.protected).toBe(true);
  });

  it('SFE with no 0xC0 pair STILL defines a field, with the default attribute', () => {
    // p. 4-5: unspecified attribute types take their defaults. Skipping the
    // field here would lose it entirely, which is the failure SFE exists to
    // prevent. Type 0x42 is colour, which we do not honour.
    const screen = new Screen();
    execute(screen, parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x01, 0x42, 0xf4)));
    expect(screen.attributeAt(0)).toBe(0x00);
    expect(screen.isFormatted()).toBe(true);
  });

  it('SFE with zero pairs defines a field with the default attribute', () => {
    const screen = new Screen();
    execute(screen, parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x00)));
    expect(screen.attributeAt(0)).toBe(0x00);
    expect(screen.isFormatted()).toBe(true);
  });

  it('SFE advances past the attribute position like SF does', () => {
    const screen = new Screen();
    execute(screen, parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40, Order.SFE, 0x01, 0xc0, 0x60, 0xc1)));
    // The data byte lands AFTER the attribute, at address 1.
    expect(screen.cellAt(1).ebcdic).toBe(0xc1);
  });

  it('SFE ignores pair types it does not honour but keeps the field attribute', () => {
    const screen = new Screen();
    execute(screen, parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SBA, 0x40, 0x40,
      Order.SFE, 0x02, 0x42, 0xf4, 0xc0, 0x60)));
    expect(screen.attributeAt(0)).toBe(0x60);
  });

  it('counts SA and MF separately so the live run can measure them', () => {
    // A COUNTER THAT REPORTS ABSENCE MUST FIRST BE SHOWN ABLE TO REPORT
    // PRESENCE (stage 1 lesson 7: a probe that could only ever say "never"
    // produced a confident wrong claim that reached committed docs). These
    // assertions are that proof.
    const screen = new Screen();
    const r = execute(screen, parseRecord(Uint8Array.of(
      SnaCmd.W, 0x00, Order.SA, 0x42, 0xf4, Order.MF, 0x01, 0xc0, 0x60)));
    expect(r.setAttributeIgnored).toBe(1);
    expect(r.modifyFieldIgnored).toBe(1);
  });

  it('reports zero ignored orders for a record containing none', () => {
    const screen = new Screen();
    const r = execute(screen, parseRecord(Uint8Array.of(SnaCmd.W, 0x00, 0xc1)));
    expect(r.setAttributeIgnored).toBe(0);
    expect(r.modifyFieldIgnored).toBe(0);
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/test/execute.test.ts`
Expected: FAIL — `screen.attributeAt(0)` is `null` (SFE is a no-op) and `setAttributeIgnored` is undefined.

- [ ] **Step 3: Add the counters to the result type**

In `packages/core/src/stream/execute.ts`, **keep** `structuredFieldsIgnored` and add two counters beside it, so the block reads:

```typescript
  /** Structured fields we did not act on, for the trace. */
  structuredFieldsIgnored: number;
  /** SA orders parsed and dropped. Stage 2a does not implement them. */
  setAttributeIgnored: number;
  /**
   * MF orders parsed and dropped.
   *
   * A NONZERO VALUE HERE IS A FOLD-INTO-2B SIGNAL: MF modifies an existing
   * field's attributes, so ignoring one can leave a field's protection stale
   * and the operator unable to type where they should. See the stage 2a spec.
   */
  modifyFieldIgnored: number;
```

And initialise both to 0 in the `result` literal at the top of `execute`.

- [ ] **Step 4: Count them in the token loop**

The existing loop at `execute.ts:69` counts structured fields. Extend it so `deferred` tokens are tallied by order — put this inside the same `for (const t of record.tokens)` walk that the write commands use, so counting happens wherever `deferred` tokens can appear:

```typescript
        if (t.kind === 'deferred') {
          if (t.order === Order.SA) result.setAttributeIgnored++;
          else if (t.order === Order.MF) result.modifyFieldIgnored++;
        }
```

Import `Order` from `../constants.js` — the file currently imports only `WCC` and `FA`.

- [ ] **Step 5: Implement SFE**

Replace the temporary `case 'sfe': return addr;` from task 5 with:

```typescript
    case 'sfe': {
      // SFE DEFINES A FIELD. The 0xC0 pair carries the basic field attribute;
      // every other pair type (0x41 highlighting, 0x42 colour, 0x43 character
      // set, ...) is an extended attribute stage 2a does not render, so it is
      // dropped.
      //
      // A missing 0xC0 pair does NOT mean "no field": p. 4-5 says unspecified
      // attribute types take their defaults, so the field exists with attribute
      // 0x00 (unprotected, unintensified, MDT clear). Skipping it would lose
      // the field, which is the failure SFE is implemented to prevent.
      // findLast, NOT find — an earlier draft of this plan specified `find` and
      // was wrong. GA23-0059 p. 4-5 (pages.txt:2899-2901): "If the same
      // attribute / type-value pair appears more than once, the last
      // specification for a repeated / attribute type takes effect." x3270 gets
      // this for free by calling START_FIELD on every 0xC0 it walks past
      // (ctlr.c:1838-1842), so its final write is what remains in the buffer.
      const basic = token.pairs.findLast((p) => p.type === XA_3270);
      screen.setFieldAttribute(addr, basic?.value ?? 0x00);
      return screen.inc(addr);
    }
```

Add `XA_3270` to the `../constants.js` import.

- [ ] **Step 6: Rewrite the deferred case**

```typescript
    case 'deferred':
      // SA and MF only. Parsed for length, counted in the token loop above, and
      // not applied. SA sets character attributes we do not render; MF's gap is
      // functional and documented on modifyFieldIgnored.
      return addr;
```

- [ ] **Step 7: Run everything and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS. If `execute.test.ts:222`'s `structuredFieldsIgnored` assertion fails, its record needs a well-formed structured field (task 3 made malformed ones throw).

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/stream/execute.ts packages/core/test/execute.test.ts
git commit -m "Execute SFE as a field-defining order; count SA and MF

An SFE with no 0xC0 pair still defines a field with the default attribute
(p. 4-5) -- skipping it would lose the field, which is the structural
failure SFE is implemented to prevent.

SA and MF get separate counters, with tests proving the counters can report
a presence before any run trusts their absence."
```

---

## Task 7: Send the Query Reply from the session

**Files:**
- Modify: `packages/core/src/stream/execute.ts` — `ExecuteResult`, and the `WriteStructuredField` case (lines 67-72)
- Modify: `packages/core/src/session.ts` — the receive path (around line 196) and a new send method
- Modify: `packages/core/test/session.test.ts`

`execute` records the *intent* and `session` performs the I/O, matching how `readRequest` and `answerRead` already split (`session.ts:196-224`).

**Three behaviours that are easy to get wrong:**

1. **The screen is not touched.** No clear, no cursor move.
2. **The keyboard is NOT restored, and this needs a REAL CODE CHANGE — not just an omission.** WSF carries no WCC, so there is no restore bit to honour. But look at `session.ts:180-191` before assuming that is enough:

```typescript
      if (result.keyboardRestore) { ... }
      else if (this.oia.keyboard === KeyboardState.AwaitingFirstWrite) { ...unlock... }
```

That `else if` fires for **any** record while the state is `AwaitingFirstWrite`, including a WSF. TSO's Query arrives *before* the first host write, so a purely additive implementation would unlock the keyboard on a Query — the operator gets an apparently ready screen with nothing on it. The `AwaitingFirstWrite` release is documented there as "the host writing anything at all" (x3270 `kybd.c:583`), and **a Query is not a write**: it puts nothing in the buffer.

So the condition must exclude the WSF command. Step 5 covers this; the test in step 1 is what catches it if you skip that.
3. **Query List (TYPE=0x03) is NOT answered.** It carries REQTYP and a QCODE list whose subsetting rules stage 2a does not implement (p. 6-19). Counted and traced, deliberately unanswered.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `packages/core/test/session.test.ts`, using the file's real harness: `newSession()` returns `{session, conn}`, and `conn.negotiate()` then `conn.host(...bytes, T.IAC, T.EOR)` drives it.

**`conn.sent` is a FLAT `number[]`, not an array of records** — `write()` does `this.sent.push(...b)`. So `conn.sent.at(-1)` is a single byte, not a record. The tests below therefore add a small helper that reads the one record the session sent. Do not assume `sent` is nested; that mistake produces tests that pass for the wrong reason.

Note also that `negotiate()` ends with `this.sent = []`, so anything sent *during* negotiation is already discarded by the time a test looks.

```typescript
describe('query reply', () => {
  /** WSF carrying Read Partition: L=5 SFID=01 PID=ff TYPE=02. */
  const QUERY = [SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x02] as const;

  /**
   * The 3270 record the session sent, unwrapped from telnet framing.
   *
   * conn.sent is a flat byte array, and an outbound record is terminated by
   * IAC EOR (telnet.ts:84). Doubled IAC inside the payload is not un-doubled
   * here — no assertion below needs it, and a Query Reply's only 0xFF bytes
   * would appear as ff ff.
   */
  function lastRecord(conn: FakeConnection): number[] {
    const end = conn.sent.length - 2; // drop the trailing IAC EOR
    expect(conn.sent.slice(end)).toEqual([T.IAC, T.EOR]);
    return conn.sent.slice(0, end);
  }

  it('answers a Read Partition Query with a Query Reply', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(...QUERY, T.IAC, T.EOR);
    const reply = lastRecord(conn);
    // AID 0x88, then L L SFID QCODE — Summary first.
    expect(reply[0]).toBe(AID.SF);
    expect(reply[3]).toBe(Sfid.QUERY_REPLY);
    expect(reply[4]).toBe(Qcode.SUMMARY);
  });

  it('does not touch the screen when answering a Query', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    session.screen.setChar(0, 0xc1);
    session.screen.cursor = 5;
    conn.host(...QUERY, T.IAC, T.EOR);
    expect(session.screen.cellAt(0).ebcdic).toBe(0xc1);
    expect(session.screen.cursor).toBe(5);
  });

  it('does NOT unlock the keyboard on a Query, which is not a write', async () => {
    // THE REGRESSION THIS GUARDS: the AwaitingFirstWrite release at
    // session.ts:183 fires for any record, and TSO sends its Query BEFORE any
    // write. Without the WriteStructuredField exclusion the operator gets an
    // unlocked keyboard over a blank screen.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    conn.host(...QUERY, T.IAC, T.EOR);
    expect(session.oia.keyboard).toBe(KeyboardState.AwaitingFirstWrite);
    expect(session.oia.isInhibited()).toBe(true);
  });

  it('still unlocks on a real write that follows a Query', async () => {
    // The exclusion must not break the normal release.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.host(...QUERY, T.IAC, T.EOR);
    conn.host(SnaCmd.W, 0x00, 0xc1, T.IAC, T.EOR);
    expect(session.oia.isInhibited()).toBe(false);
  });

  it('does not answer a Query List, which we do not implement', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(SnaCmd.WSF, 0x00, 0x05, 0x01, 0xff, 0x03, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
  });

  it('does not answer a Read Partition against a real partition', async () => {
    // PID 0x00 is a read of partition zero, not a query. We do not support
    // partitions, so answering with capabilities would be wrong.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    conn.sent.length = 0;
    conn.host(SnaCmd.WSF, 0x00, 0x05, 0x01, 0x00, 0x02, T.IAC, T.EOR);
    expect(conn.sent).toHaveLength(0);
  });

  it('reports a malformed structured field as a program check, keeping the connection', async () => {
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.negotiate();
    // A bare length with an SFID but no PID/TYPE. Note L=0 is LEGAL per
    // GA23-0059 p. 5-5 (it means "to the end of the transmission", which
    // stream/sf.ts resolves), so this is rejected for lacking PID and TYPE,
    // not for the zero. An earlier draft of this plan had that backwards.
    conn.host(SnaCmd.WSF, 0x00, 0x00, 0x01, T.IAC, T.EOR);
    expect(session.oia.toText()).toContain('X PROG');
    expect(session.isConnected()).toBe(true);
  });
});
```

Add `Qcode` and `Sfid` to the file's existing import from `../src/constants.js` (`AID`, `SnaCmd`, `Order`, `T`, `O`, `S` and `FA` are already imported).

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/test/session.test.ts`
Expected: FAIL — no reply is sent.

- [ ] **Step 3: Add the intent to ExecuteResult**

In `packages/core/src/stream/execute.ts`:

```typescript
  /** The host asked what this terminal can do, and we should answer. */
  sfReply?: 'queryReply';
```

- [ ] **Step 4: Set it in the WSF case**

Replace the `WriteStructuredField` case:

```typescript
    case 'WriteStructuredField':
      for (const t of record.tokens) {
        if (t.kind !== 'structuredField') continue;
        // isQueryRequest (stream/sf.ts) checks BOTH the PID and the TYPE. A
        // Query List (0x03) needs subsetting rules we have not implemented
        // (p. 6-19), and a non-0xFF PID is a read against a real partition we
        // do not support. Both are counted and traced rather than answered — an
        // unanswered request is honest; a guessed answer is not.
        if (isQueryRequest(t.field)) {
          result.sfReply = 'queryReply';
        } else {
          result.structuredFieldsIgnored++;
        }
      }
      return result;
```

Add the import: `import { isQueryRequest } from './sf.js';`

- [ ] **Step 5: Send it from the session**

In `packages/core/src/session.ts`, add to the imports:

```typescript
import { buildQueryReply, DEFAULT_CAPABILITIES } from './queryreply.js';
```

**First, stop a Query from unlocking the keyboard.** Change the `else if` at `session.ts:183` so the initial-lock release requires an actual write:

```typescript
      } else if (this.oia.keyboard === KeyboardState.AwaitingFirstWrite
        && parsed.command !== 'WriteStructuredField') {
```

Add this comment above it, extending the existing one:

```typescript
        // ...and a Write Structured Field is NOT such a write: it puts nothing
        // in the buffer. TSO sends its Read Partition (Query) BEFORE any write,
        // so without this exclusion the operator gets an unlocked keyboard over
        // a blank screen.
```

Then in the receive path, immediately after the existing `readRequest` block (`session.ts:196-198`):

```typescript
      if (result.sfReply === 'queryReply') {
        this.answerQuery();
      }
```

And add the method next to `answerRead`:

```typescript
  /**
   * Answer a Read Partition (Query) with our capabilities.
   *
   * Deliberately does NOT touch the screen, the cursor or the keyboard: a Query
   * is a question about the device, not a write to it. In particular the
   * keyboard stays locked, because AwaitingFirstWrite is released by host
   * WRITES and the host has not written anything yet.
   */
  private answerQuery(): void {
    const geometry = { rows: this.screen.rows, cols: this.screen.cols };
    this.telnet?.sendRecord(buildQueryReply(DEFAULT_CAPABILITIES, geometry));
  }
```

**Note the geometry comes from the live screen**, not a constant, so it stays truthful if a later stage makes the screen size configurable.

- [ ] **Step 6: Run and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, including the VM/370 conformance test — the capture contains no WSF records, so nothing there changes.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/stream/execute.ts packages/core/src/session.ts packages/core/test/session.test.ts
git commit -m "Answer Read Partition (Query) with a Query Reply

Answers only TYPE=0x02 against PID=0xFF. A Query List needs subsetting rules
we have not implemented and a non-query PID is a partition read we do not
support; both are counted rather than answered, because an unanswered
request is honest and a guessed answer is not.

The screen, cursor and keyboard are untouched: a Query is a question about
the device, not a write to it."
```

---

## Task 8: Resolve the terminal type

**Files:**
- Create: `packages/core/src/termtype.ts`
- Create: `packages/core/test/termtype.test.ts`
- Modify: `packages/core/src/index.ts`

Pure string resolution, no I/O — the CLI plumbing is task 9.

**The default stays `IBM-3278-2`.** Changing it would alter what the VM/370 conformance runs negotiate. The TSO run passes `-model 3278-2-E` explicitly.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/termtype.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveTerminalType, KNOWN_MODELS, TerminalTypeError } from '../src/termtype.js';
import { TERMINAL_TYPE } from '../src/constants.js';

describe('terminal type resolution', () => {
  it('defaults to IBM-3278-2, unchanged from stage 1', () => {
    // Must not change: the committed VM/370 conformance goldens negotiate this.
    expect(resolveTerminalType({})).toBe('IBM-3278-2');
    expect(resolveTerminalType({})).toBe(TERMINAL_TYPE);
  });

  it('maps a model number to its ttype string', () => {
    expect(resolveTerminalType({ model: '3278-2' })).toBe('IBM-3278-2');
    expect(resolveTerminalType({ model: '3278-2-E' })).toBe('IBM-3278-2-E');
  });

  it('accepts a model with the IBM- prefix already on it', () => {
    // s3270 accepts -model 3278-2; a user typing the full string should work too.
    expect(resolveTerminalType({ model: 'IBM-3278-2-E' })).toBe('IBM-3278-2-E');
  });

  it('passes a raw terminal type through verbatim', () => {
    // The escape hatch for experiments: IBM-DYNAMIC, IBM-3279-2-E, anything.
    expect(resolveTerminalType({ terminalType: 'IBM-DYNAMIC' })).toBe('IBM-DYNAMIC');
    expect(resolveTerminalType({ terminalType: 'IBM-3279-2-E' })).toBe('IBM-3279-2-E');
  });

  it('lets the raw terminal type override a model', () => {
    expect(resolveTerminalType({ model: '3278-2', terminalType: 'IBM-DYNAMIC' }))
      .toBe('IBM-DYNAMIC');
  });

  it('rejects an unknown model rather than guessing a ttype string', () => {
    // A typo must fail loudly. Silently negotiating something the user did not
    // ask for is how a session fails in a way nobody can explain.
    expect(() => resolveTerminalType({ model: '3278-9' })).toThrow(TerminalTypeError);
    expect(() => resolveTerminalType({ model: '' })).toThrow(TerminalTypeError);
  });

  it('names the models it knows in the error, so the message is actionable', () => {
    expect(() => resolveTerminalType({ model: 'bogus' }))
      .toThrow(/3278-2-E/);
  });

  it('rejects an empty raw terminal type', () => {
    expect(() => resolveTerminalType({ terminalType: '' })).toThrow(TerminalTypeError);
  });

  it('lists only models we can honestly claim at 24x80', () => {
    // Stage 2a pins the geometry, so a model implying another size is not
    // offered. Adding one means implementing alternate geometry first.
    expect(Object.keys(KNOWN_MODELS)).toEqual(['3278-2', '3278-2-E']);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run packages/core/test/termtype.test.ts`
Expected: FAIL — cannot resolve `../src/termtype.js`.

- [ ] **Step 3: Write it**

Create `packages/core/src/termtype.ts`:

```typescript
import { TERMINAL_TYPE } from './constants.js';

/**
 * Terminal type resolution for the telnet TERMINAL-TYPE subnegotiation.
 *
 * The `-E` suffix means EXTENDED DATA STREAM, a 3270 capability claim inside
 * the terminal-type string. It is NOT the TN3270E telnet option (40), which is
 * stage 2b; conflating the two produced a wrong diagnosis once already.
 *
 * MVS 3.8j TSO rejects a bare IBM-3278-2 with IKT00405I and accepts
 * IBM-3278-2-E, but claiming -E invites a Read Partition (Query) that must be
 * answered — hence Query Reply landing in the same stage.
 */

export class TerminalTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalTypeError';
  }
}

/**
 * Model number to ttype string.
 *
 * Deliberately tiny: only models we can honestly claim while the screen is
 * pinned at 24x80. A model implying another geometry (3278-3 is 32x80, -4 is
 * 43x80, -5 is 27x132) needs alternate-size support first, which stage 2a does
 * not implement.
 */
export const KNOWN_MODELS: Readonly<Record<string, string>> = {
  '3278-2': 'IBM-3278-2',
  '3278-2-E': 'IBM-3278-2-E',
};

export interface TerminalTypeOptions {
  /** A model number, with or without the IBM- prefix. */
  model?: string;
  /** A complete ttype string, used verbatim. Wins over `model`. */
  terminalType?: string;
}

export function resolveTerminalType(opts: TerminalTypeOptions): string {
  if (opts.terminalType !== undefined) {
    if (opts.terminalType.length === 0) {
      throw new TerminalTypeError('terminal type must not be empty');
    }
    return opts.terminalType;
  }

  if (opts.model === undefined) return TERMINAL_TYPE;

  // Accept both `3278-2-E` and `IBM-3278-2-E`.
  const bare = opts.model.startsWith('IBM-') ? opts.model.slice(4) : opts.model;
  const resolved = KNOWN_MODELS[bare];
  if (resolved === undefined) {
    throw new TerminalTypeError(
      `unknown model ${JSON.stringify(opts.model)}; known models are `
      + `${Object.keys(KNOWN_MODELS).join(', ')}. `
      + 'Use --terminal-type to send an arbitrary string.',
    );
  }
  return resolved;
}
```

- [ ] **Step 4: Export it**

Add to `packages/core/src/index.ts`, after the `./screen.js` line:

```typescript
export * from './termtype.js';
export * from './queryreply.js';
export * from './stream/sf.js';
```

- [ ] **Step 5: Run and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, 10 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/termtype.ts packages/core/test/termtype.test.ts packages/core/src/index.ts
git commit -m "Resolve the terminal type from a model or a raw string

The default stays IBM-3278-2 so the VM/370 conformance goldens keep
negotiating what they recorded. The model table lists only sizes we can
honestly claim while the screen is pinned at 24x80."
```

---

## Task 9: Thread the terminal type through session and CLI

**Files:**
- Modify: `packages/core/src/session.ts` — `SessionOptions` (lines 29-34) and the `TelnetLayer` construction at line 115
- Modify: `packages/cli/src/runner.ts:51-53` — `defaultSession()`
- Modify: `packages/cli/src/main.ts` — argv parsing (new)
- Modify: `packages/core/test/session.test.ts`
- Test: `packages/cli/test/main.test.ts` (create)

**`main.ts` currently parses no argv at all** — it goes straight from stdin to the runner. This is new surface, not a tweak.

**Only the connect-time `TelnetLayer` needs the type.** There is a second construction at `session.ts:267` for `replay()`, which never negotiates (its `write` discards). Leave it alone.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/session.test.ts`.

**Two harness facts to work around.** `newSession()` hardcodes `new Session({connect: () => conn})` with no way to pass options, and `conn.negotiate()` ends with `this.sent = []` — which throws away the very TERMINAL-TYPE reply these tests need to read. So drive the negotiation by hand instead of calling `negotiate()`, and give `newSession` an optional options argument:

```typescript
function newSession(opts: Partial<SessionOptions> = {}) {
  const conn = new FakeConnection();
  const session = new Session({ connect: () => conn, ...opts });
  return { session, conn };
}
```

Import `type SessionOptions` from `../src/session.js`. Existing callers pass nothing and are unaffected.

```typescript
describe('terminal type negotiation', () => {
  /** The ASCII name from the session's TERMINAL-TYPE IS subnegotiation. */
  function negotiatedName(conn: FakeConnection): string {
    // IAC SB 24 IS <name...> IAC SE — telnet.ts:230-234.
    const start = conn.sent.findIndex((b, i) =>
      b === T.IAC && conn.sent[i + 1] === T.SB
      && conn.sent[i + 2] === O.TERMINAL_TYPE && conn.sent[i + 3] === S.IS);
    expect(start, 'no TERMINAL-TYPE IS was sent').toBeGreaterThanOrEqual(0);
    const nameStart = start + 4;
    const end = conn.sent.indexOf(T.SE, nameStart);
    // The name runs up to IAC SE, so stop one byte before the SE's IAC.
    return String.fromCharCode(...conn.sent.slice(nameStart, end - 1));
  }

  it('negotiates the configured terminal type', async () => {
    const { session, conn } = newSession({ terminalType: 'IBM-3278-2-E' });
    await session.connect('localhost', 3270);
    // By hand, because negotiate() clears conn.sent afterwards.
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    expect(negotiatedName(conn)).toBe('IBM-3278-2-E');
  });

  it('negotiates IBM-3278-2 when no terminal type is given', async () => {
    // Must not change: the committed VM/370 conformance goldens recorded this.
    const { session, conn } = newSession();
    await session.connect('localhost', 3270);
    conn.host(T.IAC, T.DO, O.TERMINAL_TYPE);
    conn.host(T.IAC, T.SB, O.TERMINAL_TYPE, S.SEND, T.IAC, T.SE);
    expect(negotiatedName(conn)).toBe('IBM-3278-2');
  });
});
```

Create `packages/cli/test/main.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../src/main.js';

describe('command line arguments', () => {
  it('defaults to no terminal type override', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('parses -model', () => {
    expect(parseArgs(['-model', '3278-2-E'])).toEqual({ model: '3278-2-E' });
  });

  it('parses --terminal-type', () => {
    expect(parseArgs(['--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ terminalType: 'IBM-DYNAMIC' });
  });

  it('accepts both, letting the raw type win at resolution time', () => {
    expect(parseArgs(['-model', '3278-2', '--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ model: '3278-2', terminalType: 'IBM-DYNAMIC' });
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['-model'])).toThrow(UsageError);
    expect(() => parseArgs(['--terminal-type'])).toThrow(UsageError);
  });

  it('rejects an unrecognised flag rather than ignoring it', () => {
    // Silently ignoring a flag the user typed is how a session ends up
    // negotiating something nobody asked for.
    expect(() => parseArgs(['--wat'])).toThrow(UsageError);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run packages/cli/test/main.test.ts`
Expected: FAIL — `parseArgs` is not exported.

- [ ] **Step 3: Add the session option**

In `packages/core/src/session.ts`, add to `SessionOptions`:

```typescript
  /** Telnet TERMINAL-TYPE to advertise. Defaults to IBM-3278-2. */
  terminalType?: string;
```

And pass it at the connect-time construction (line 115), spreading conditionally so an absent option keeps the layer's own default:

```typescript
    this.telnet = new TelnetLayer({
      write: (b) => conn.write(b),
      onRecord: (r) => this.handleRecord(r),
      trace: this.trace,
      ...(this.opts.terminalType ? { terminalType: this.opts.terminalType } : {}),
    });
```

- [ ] **Step 4: Let defaultSession take one**

In `packages/cli/src/runner.ts`, replace `defaultSession`:

```typescript
export function defaultSession(terminalType?: string): Session {
  return new Session({
    connect: (h, p) => tcpConnect(h, p),
    ...(terminalType ? { terminalType } : {}),
  });
}
```

- [ ] **Step 5: Parse argv in main.ts**

Add to `packages/cli/src/main.ts`, above `main()`:

```typescript
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface CliArgs {
  model?: string;
  terminalType?: string;
}

/**
 * Parse the argument vector.
 *
 * `-model` matches s3270's spelling so our invocations stay legible next to it
 * in conformance runs; `--terminal-type` is the escape hatch for a raw string.
 * An unrecognised flag is an error rather than something to skip: silently
 * ignoring a flag the operator typed produces a session that negotiates
 * something nobody asked for, which is very hard to diagnose from a trace.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    switch (flag) {
      case '-model':
        if (value === undefined) throw new UsageError('-model needs a value, e.g. -model 3278-2-E');
        args.model = value;
        i++;
        break;
      case '--terminal-type':
        if (value === undefined) throw new UsageError('--terminal-type needs a value, e.g. --terminal-type IBM-DYNAMIC');
        args.terminalType = value;
        i++;
        break;
      default:
        throw new UsageError(`unrecognised argument ${JSON.stringify(flag)}`);
    }
  }
  return args;
}
```

Then in `main()`, replace `const session = defaultSession();` with:

```typescript
  const session = defaultSession(resolveTerminalType(parseArgs(process.argv.slice(2))));
```

and import `resolveTerminalType` from `@tn3270/core` (match the package specifier the file already uses for core imports — check `runner.ts`).

- [ ] **Step 6: Verify the flags actually reach the wire**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: all PASS.

Then check by hand, because a flag that parses but never reaches the socket is exactly the class of bug this project has been bitten by:

```bash
printf 'Quit\n' | node packages/cli/dist/main.js -model 3278-2-E
printf 'Quit\n' | node packages/cli/dist/main.js --wat
```

Expected: the first exits cleanly; the second prints a usage error mentioning `--wat` and exits nonzero. Confirm `main()`'s `.catch` renders `UsageError` as a message rather than a stack trace — if it prints a stack, add a `UsageError` branch that writes the message to stderr and exits 2.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/session.ts packages/cli/src/runner.ts packages/cli/src/main.ts packages/core/test/session.test.ts packages/cli/test/main.test.ts
git commit -m "Add -model and --terminal-type command line flags

main.ts had no argv parsing at all, so this is new surface. An unrecognised
flag is an error: silently ignoring one produces a session negotiating
something nobody asked for."
```

---

## Task 10: The live TSO run — the real acceptance test

**Files:**
- Modify: `packages/cli/scripts/record-mvs.txt` (remove the "will NOT work" preamble once it does)
- Create: `packages/fixtures/mvs/` fixture + golden, redacted
- Modify: `docs/live-testing.md`

**Everything before this task is offline. None of it proves TSO works.** The three-unit reply is verified against the manual and matches x3270 on those three units, but whether the *subset* satisfies TSO is unknown until this runs.

**Host setup.** MVS 3.8j TK5 at `~/Emulators/S370/mvs-tk5`. The user starts it by hand with `CNSLPORT=3271` and `HERCULES_RC=scripts/ipl.rc` — `./mvs` does not work, its bundled Hercules was deleted. **Check the port; do not assume 3271** (VM/370 holds 3270). Ask the user to IPL it if it is not up.

- [ ] **Step 1: Confirm the host is reachable before blaming the client**

```bash
printf 'Connect(localhost:3271)\nWait(3270Mode,25)\nScreenText\nQuit\n' \
  | node packages/cli/dist/main.js -model 3278-2-E
```

Expected: the Hercules banner or VTAM logon panel as text. If this fails, the host is not up — stop and ask, rather than debugging the client against nothing.

- [ ] **Step 2: Run the acceptance script into a FRESH log**

```bash
sed 's/HOST:PORT/localhost:3271/' packages/cli/scripts/record-mvs.txt \
  | node packages/cli/dist/main.js -model 3278-2-E \
  > /tmp/tso-run-$(date +%s).log 2>&1
```

**A fresh file every run, never appended** (stage 1 lesson 1: appending produced 31 "replies" for 15 commands, and several conclusions drawn from that mapping were wrong).

- [ ] **Step 3: Read the output and judge it honestly**

Read the log. **Done means the ISPF primary option menu appears** (`USERID: HERC02`, `TERMINAL: 3277`) and the session logs off cleanly.

Check for each of these by name:

- `IKT00405I SCREEN ERASURE` — the ttype was still rejected. The flag did not reach the wire; re-check step 6 of task 9.
- `IKJ56425I LOGON REJECTED, USERID IN USE` — **not a failure of this work.** A previous run left the account logged on. Use `HERC01`, `HERC03` or `HERC04`, or log the account off. One stage-1 run was misscored exactly this way.
- A hang after the userid — TSO is waiting on something. Grep the trace for `ReadPartition` to see what it asked and whether we answered.
- `X PROG` in the status lines — a program check. The message says which address; an address past 1920 means the host is driving a geometry we did not offer, which would be a real finding worth reporting.

- [ ] **Step 4: Check whether SA and MF actually appeared**

```bash
grep -c "SFE(" /tmp/tso-run-*.log
grep -c "deferred(0x28" /tmp/tso-run-*.log   # SA
grep -c "deferred(0x2c" /tmp/tso-run-*.log   # MF
```

**The counters were proven able to report a presence in task 6**, so a zero here is meaningful rather than vacuous. Nonzero MF is the fold-into-2b signal from the spec. Record the actual numbers in `docs/live-testing.md` either way — "TK5's ISPF sends no MF" is a useful fact, and only measurable now.

- [ ] **Step 5: If it fails, diagnose by diffing against s3270 rather than theorising**

s3270 is at `~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/s3270/s3270`. Get its successful exchange and diff the whole conversation, not the outcome — that is what finally cracked the stage 1 TSO diagnosis after two wrong passes.

```bash
printf 'Trace(on)\nConnect(C:localhost:3271)\nWait(3270Mode,25)\nWait(Settle,20)\nScreenText\nQuit\n' \
  | ~/src/suite3270-4.5/obj/x86_64-conda-linux-gnu/s3270/s3270 -model 3278-2-E -trace -tracefile /tmp/s3270-tso.trace
```

Use the `C:` host prefix or it hangs on the all-protected banner. Compare its Query Reply with ours unit by unit; if TSO wants a unit we omit, adding it is one entry in `DEFAULT_CAPABILITIES` — **but only add units we actually honour**, and if that means claiming Color or Highlighting, that is the fold-into-2b signal rather than a quick fix.

- [ ] **Step 6: Commit a redacted fixture and golden, only once it passes**

**The password appears in the trace in EBCDIC** (`CUL8TR` is `c3 e4 d3 f8 e3 d9`). Redact it before committing — `docs/live-testing.md` step 4 has the procedure. Verify with:

```bash
grep -c "c3e4d3f8e3d9" packages/fixtures/mvs/*.trace
```

Expected: `0`. If it is not zero, do not commit.

- [ ] **Step 7: Commit**

```bash
git add packages/fixtures/mvs packages/cli/scripts/record-mvs.txt
git commit -m "Reach TSO on MVS 3.8j TK5: extended data stream and Query Reply work

Redacted fixture and golden from the run that reached the ISPF primary
option menu and logged off cleanly."
```

---

## Task 11: Correct the superseded docs and hand off

**Files:**
- Modify: `docs/live-testing.md` (lines 479 and 537)
- Modify: `docs/HANDOFF.md`
- Modify: `README.md` if it names the terminal type

Last, because the live run may add findings.

- [ ] **Step 1: Fix the two superseded paragraphs**

Both are pass-2 text that the pass-3 diagnosis in the same file already contradicts:

- **line 479** — "Query Reply is still worth implementing, but it is not what blocks TSO." It *is* what blocks TSO once the ttype is right. Replace with a note that this was pass 2's conclusion, superseded by pass 3 in this same document, and that stage 2a confirmed it on the wire.
- **line 537** — "So a TK5/TSO fixture is blocked until TN3270E lands." Blocked on 2a, not TN3270E. Update to reflect what task 10 actually achieved.

Keep the wrong-theory write-ups themselves — they are labelled as wrong and they stop the theories being re-derived. What must change is the two sentences that still read as current fact.

- [ ] **Step 2: Record what the run measured**

In `docs/live-testing.md`, add the stage 2a results: the ttype used, whether the three-unit reply was accepted, the SA/MF/SFE counts from task 10 step 4, and the geometry TSO actually drove. **State the 24×80 result explicitly** — whether TSO stayed at 1920 cells settles the open question about whether it needs a larger screen, and that answer should not have to be re-derived.

- [ ] **Step 3: Update the handoff**

Rewrite `docs/HANDOFF.md`'s *Next steps*: 2a done (or partly done, honestly), and 2b next. Record the new test total and anything the run taught. If SA or MF appeared, say so and name the fold-into-2b decision as live.

- [ ] **Step 4: Final verification**

```bash
npm test && npm run typecheck && npm run build
```

Expected: all green. State the actual test count rather than a predicted one.

- [ ] **Step 5: Commit**

```bash
git add docs/live-testing.md docs/HANDOFF.md README.md
git commit -m "Record stage 2a results and correct two superseded paragraphs

Lines 479 and 537 of the live-testing runbook still carried pass-2
conclusions that the pass-3 diagnosis in the same file contradicted."
```

---

## Verification Summary

| Claim | How it is checked | What it does not cover |
|---|---|---|
| Wire constants correct | Unit tests citing GA23-0059 pages (tasks 1, 4) | Nothing — the manual is the authority |
| Query Reply well-formed | Length self-consistency + byte-identity with x3270 on the three shared units (task 4) | Whether our 3-unit *subset* satisfies TSO |
| SFE keeps screen structure | Field exists and is findable, including with no 0xC0 pair (task 6) | Whether real hosts send SFE at all |
| SA/MF absence is real | Counters proven able to report presence first (task 6), then measured live (task 10) | Nothing, once the presence test passes |
| Query does not disturb state | Screen, cursor and keyboard asserted unchanged (task 7) | — |
| Flags reach the wire | Negotiated ttype read off the fake host, plus a manual run (tasks 9) | — |
| Existing behaviour intact | Full suite + VM/370 conformance every task | — |
| **TSO reachable** | **The live run (task 10) — nothing offline proves this** | — |

**If task 10 fails and the cause is a capability we do not implement, the agreed response is to fold 2a and 2b together** rather than growing 2a piecemeal. That is the spec's contingency, decided in advance.
