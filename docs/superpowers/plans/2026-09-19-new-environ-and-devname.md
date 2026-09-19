# NEW-ENVIRON and `-devname` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement telnet option 39 (NEW-ENVIRON, RFC 1572) and a `-devname` flag with `=`-template iteration, so hosts that identify sessions by device name work and four more x3270 traces become drivable.

**Architecture:** `newenviron.ts` holds a pure parser and reply builder; `devname.ts` holds the one stateful piece (a counter); `telnet.ts` gains a conditional option and a subnegotiation branch. No geometry, no renderer, no screen buffer.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, Node ≥ 20, no runtime dependencies. Python 3 for the playback harness.

---

## READ THIS BEFORE TASK 1

**THE SOURCE BEATS THIS PLAN.** Every plan in this repo has contained defects the implementers
found — 46 on the keypad branch, ~40 on the web gateway, **14 on the bind-image branch**, and
nearly all of them were in the plan rather than the code. On bind-image specifically: a comment
claiming a mask was load-bearing when it was unfalsifiable; a sketch that dispatched BIND on data
type alone when x3270 gates on the negotiated function; a sketch that silently skipped a screen
erase; a grep that missed a whole test file; and two off line citations. **If a citation here
disagrees with the file it cites, the file is right** — say so in your report rather than making
the code match this document.

**Spec:** `docs/superpowers/specs/2026-09-19-new-environ-and-devname-design.md`. Read it. It records
a cost estimate I got wrong and two claims I had to correct, so do not treat my confidence as
evidence.

**Baseline, measured on `main` at `38483d1`:** `npm run build` clean, `npm run typecheck` clean,
**1819 tests in 72 files** passing, `drive-e.py` 10/10, `drive-playback.py` 6/6.

**Create a branch before Task 1:** `git checkout -b new-environ`. The last six features each ran on
one and merged `--no-ff`.

**Two workflow facts that will otherwise cost an hour:**
1. **`npm run build` MUST precede `vitest`** when you have changed `packages/core` — downstream
   packages resolve to built `dist/index.js`, not source.
2. **`vitest` does NOT typecheck.** Run `npm run typecheck` too, every task.

**Mutation-check every test that claims to pin a constant, a boundary or a branch.** Break the code
deliberately, watch the test fail, put it back. On the bind-image branch **two of four mutations
survived the first draft of one commit's tests**, and one implementer's own first draft of a
cancellation test passed with the cancellation removed. If a test cannot be made to fail, it is not
a test — and if a thing turns out **unfalsifiable**, say so and delete the test rather than keeping
a decorative one (that happened twice on bind-image: `maxRu`'s `& 0x0f` and an `else if` ordering).

---

## File Structure

**Create:**
- `packages/core/src/newenviron.ts` — `EnvironGroup`, `EnvironQual`, `EnvironRequest`,
  `parseEnvironSend`, `buildEnvironIs`, `escapeEnvironBytes`. Pure.
- `packages/core/src/devname.ts` — `DeviceName`. The only stateful piece.
- `packages/core/test/newenviron.test.ts`
- `packages/core/test/devname.test.ts`

**Modify:**
- `packages/core/src/constants.ts` — `TelnetOpt.NEW_ENVIRON = 39`.
- `packages/core/src/telnet.ts` — `onDo` conditional branch, `handleSubnegotiation` branch,
  `TelnetLayerOptions` for the variables.
- `packages/core/src/session.ts` — `SessionOptions.devname`/`user`, wiring the variables in.
- `packages/core/src/index.ts` — export the two new modules.
- `packages/frontend/src/session.ts` — thread `devname` through `defaultSession`.
- `packages/cli/src/main.ts`, `packages/gui/src/args.ts`, `packages/tui/src/main.ts`,
  `packages/web/src/args.ts` — `-devname`.
- `packages/cli/scripts/drive-playback.py` — the new trace cases.
- `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md` — docs.

---

## Task 1: The option number and the group/qualifier codes

**Files:**
- Modify: `packages/core/src/constants.ts`
- Test: `packages/core/test/newenviron.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { TelnetOpt, EnvironGroup, EnvironQual } from '../src/constants.js';

/**
 * RFC 1572's codes, taken from x3270's include/arpa_telnet.h:122-125 rather than from
 * the RFC text, because that header is what the traces we drive were produced against.
 */
describe('NEW-ENVIRON constants', () => {
  it('is telnet option 39', () => {
    expect(TelnetOpt.NEW_ENVIRON).toBe(39);
  });

  it('has RFC 1572 s four group codes', () => {
    expect(EnvironGroup.VAR).toBe(0);
    expect(EnvironGroup.VALUE).toBe(1);
    expect(EnvironGroup.ESC).toBe(2);
    expect(EnvironGroup.USERVAR).toBe(3);
  });

  it('has its OWN IS and SEND, not TERMINAL-TYPE s', () => {
    // IS=0 and SEND=1 are the same VALUES that TelnetSubopt already defines for
    // TERMINAL-TYPE (RFC 1091). That is a coincidence of encoding, not a shared
    // meaning, and this project has been bitten by exactly that confusion before --
    // see constants.ts's note on XAH.DEFAULT versus XA.RESET, both 0x00 and unrelated.
    // Asserting the values here is what lets a reader see they are deliberate.
    expect(EnvironQual.IS).toBe(0);
    expect(EnvironQual.SEND).toBe(1);
    expect(EnvironQual.INFO).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/newenviron.test.ts
```

Expected: FAIL — none of the three is exported.

- [ ] **Step 3: Add them**

In `packages/core/src/constants.ts`, add to `TelnetOpt` (keep the existing members):

```typescript
  NEW_ENVIRON: 39,
```

and, near the other subnegotiation code blocks:

```typescript
/**
 * NEW-ENVIRON group codes (RFC 1572), from x3270's include/arpa_telnet.h:122-125.
 *
 * `ESC` is the escape prefix, not a group a host may request: any byte of a NAME or a
 * VALUE that happens to equal one of these four codes is prefixed with `ESC` so the
 * receiver does not read it as a delimiter.
 */
export const EnvironGroup = {
  VAR: 0,
  VALUE: 1,
  ESC: 2,
  USERVAR: 3,
} as const;

/**
 * NEW-ENVIRON qualifiers (RFC 1572).
 *
 * IS AND SEND SHARE THEIR VALUES WITH `TelnetSubopt`, WHICH IS TERMINAL-TYPE's, AND THE
 * TWO ARE NOT THE SAME CONCEPT. Both encode "here it is" as 0 and "give it to me" as 1,
 * by coincidence of two independent RFCs. Reusing one for the other would work today and
 * would be wrong the first time either changed. The same trap, and the same resolution,
 * as this file's note on XAH.DEFAULT versus XA.RESET.
 *
 * INFO (2) is a host-to-client unsolicited update. We never send it and no trace in
 * x3270's collection sends one to us; it is defined so a received INFO can be traced by
 * name rather than as an unknown byte.
 */
export const EnvironQual = {
  IS: 0,
  SEND: 1,
  INFO: 2,
} as const;
```

- [ ] **Step 4: Build and test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/newenviron.test.ts && npm run typecheck
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Verify against the source**

Read `/home/a/athor/src/suite3270-4.5/include/arpa_telnet.h` around 122-125 and confirm all four
group codes. Also confirm option 39's number — grep for `TELOPT_NEW_ENVIRON`. **Report if either
differs.**

- [ ] **Step 6: Mutation-check**

Change `EnvironGroup.USERVAR` to 4. The group-codes test must fail. Restore.

> The IS/SEND test asserts three literals against three constants and **cannot catch a
> transcription error made identically in both places** — it exists to make the deliberate
> non-reuse visible, and the real verification is Step 5. Say so in your report rather than
> claiming it verifies the values.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/constants.ts packages/core/test/newenviron.test.ts
git commit -m "feat(core): NEW-ENVIRON option number and RFC 1572 group codes

Option 39 plus VAR/VALUE/ESC/USERVAR, from x3270's arpa_telnet.h:122-125. IS and
SEND get their own constants rather than reusing TERMINAL-TYPE's identical values:
two independent RFCs agreeing on 0 and 1 is a coincidence of encoding, and this
file already carries the same warning about XAH.DEFAULT versus XA.RESET.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: `DeviceName` — the `=` template iterator

**Files:**
- Create: `packages/core/src/devname.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/devname.test.ts` (create)

**This is the piece the spec's cost estimate originally called optional and is not.** The traces show
a fresh name per request.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { DeviceName } from '../src/devname.js';

/**
 * x3270's devname_init (Common/devname.c:42) and devname_next (:73). The observable
 * behaviour comes from two real traces, not from reasoning:
 *   devname_success.trc: foo001, foo002, foo003, foo004   (template foo===)
 *   devname_failure.trc: foo1, foo2, foo3                 (template foo=)
 */
describe('DeviceName', () => {
  it('replaces trailing = with a zero-padded counter, starting at 1', () => {
    // NOT 000. `devname_next` pre-increments and is called on the FIRST request, so the
    // first name a host ever sees ends in 001. Pinned because starting at 0 is the
    // natural way to write this and would silently differ from every recorded trace.
    const d = new DeviceName('foo===');
    expect(d.next()).toBe('foo001');
    expect(d.next()).toBe('foo002');
    expect(d.next()).toBe('foo003');
  });

  it('matches devname_failure.trc s single-digit template', () => {
    const d = new DeviceName('foo=');
    expect(d.next()).toBe('foo1');
    expect(d.next()).toBe('foo2');
    expect(d.next()).toBe('foo3');
  });

  it('REPEATS the last name at the ceiling rather than wrapping', () => {
    // x3270 guards with `if (d->current < d->max)` and otherwise returns the template
    // unchanged, so the counter saturates. Wrapping to 1 would silently re-offer a name
    // the host already refused, which is the one thing this mechanism exists to avoid.
    const d = new DeviceName('x=');
    const seen = [];
    for (let i = 0; i < 11; i++) seen.push(d.next());
    expect(seen.slice(0, 9)).toEqual(
      ['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9']);
    expect(seen[9]).toBe('x9');
    expect(seen[10]).toBe('x9');
  });

  it('treats a template with no = as a fixed name', () => {
    // `-devname MYLU` is the common case and must not grow a counter.
    const d = new DeviceName('MYLU');
    expect(d.next()).toBe('MYLU');
    expect(d.next()).toBe('MYLU');
  });

  it('counts only TRAILING = characters', () => {
    // An `=` in the middle is part of the name. x3270 scans backwards from the end and
    // stops at the first non-`=`.
    const d = new DeviceName('a=b==');
    expect(d.next()).toBe('a=b01');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/core/test/devname.test.ts
```

Expected: FAIL — cannot resolve `../src/devname.js`.

- [ ] **Step 3: Implement**

```typescript
/**
 * A device-name template that yields a fresh candidate per request.
 *
 * WHY A HOST WANTS THIS: the device name is how some hosts identify a session, and a
 * name already in use is refused -- so the client offers the next candidate. x3270's
 * `devname_success.trc` shows a host asking four times and receiving foo001 through
 * foo004; `devname_failure.trc` shows the same with a single digit.
 *
 * THE ONLY STATEFUL PIECE OF THIS FEATURE, deliberately isolated here so the reply
 * builder in `newenviron.ts` can stay pure and be tested against byte arrays.
 *
 * Ported from x3270's `devname_init` (Common/devname.c:42) and `devname_next` (:73).
 */
export class DeviceName {
  private readonly stem: string;
  private readonly digits: number;
  private readonly max: number;
  private current = 0;

  constructor(template: string) {
    // Count TRAILING '=' only: an '=' earlier in the name is part of the name.
    let digits = 0;
    while (digits < template.length
      && template[template.length - 1 - digits] === '=') digits++;
    this.digits = digits;
    this.stem = digits === 0 ? template : template.slice(0, template.length - digits);
    // 10^digits - 1, matching x3270's `max *= 10` per '=' and then `max - 1`.
    this.max = digits === 0 ? 0 : 10 ** digits - 1;
  }

  /**
   * The next candidate.
   *
   * Saturates rather than wrapping, as x3270 does (`if (d->current < d->max)`):
   * re-offering a name the host already refused is the one outcome this mechanism
   * exists to prevent. A template with no '=' is a constant.
   */
  next(): string {
    if (this.digits === 0) return this.stem;
    if (this.current < this.max) this.current++;
    return this.stem + String(this.current).padStart(this.digits, '0');
  }
}
```

Add to `packages/core/src/index.ts`:

```typescript
export * from './devname.js';
```

- [ ] **Step 4: Build and test**

```bash
cd ~/git/tn3270 && npm run build && npx vitest run packages/core/test/devname.test.ts && npm run typecheck
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-check three things separately**

1. Start the counter at 0 (`padStart` of `this.current` before incrementing) — the "starting at 1"
   test must fail.
2. Remove the `this.current < this.max` guard so it wraps or overruns — the ceiling test must fail.
3. Count all `=` rather than trailing ones (e.g. `template.split('=').length - 1`) — the
   "counts only TRAILING" test must fail.

**Report each outcome.** If any mutation survives, the test is wrong, not the mutation.

- [ ] **Step 6: Verify against the source**

Read `Common/devname.c:42-83`. Confirm: the backward scan, `max *= 10` per `=`, `max - 1`, the
pre-increment in `devname_next`, and the saturation guard. **Note anything that differs** — in
particular, check whether x3270 returns the *unmodified template* on the first call when
`sub_length` is 0, and whether our "fixed name" behaviour matches.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/devname.ts packages/core/src/index.ts packages/core/test/devname.test.ts
git commit -m "feat(core): the -devname = template, which yields a fresh name per request

Ported from x3270's devname.c:41-83, and pinned against two real traces rather
than reasoning: devname_success.trc shows foo001..foo004 for the template foo===,
devname_failure.trc shows foo1..foo3 for foo=. Three details are easy to get wrong
and each has its own test: the first name ends in 001 and not 000, the counter
SATURATES rather than wrapping (re-offering a refused name is what this exists to
avoid), and only TRAILING = characters count.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: `parseEnvironSend` — the four-state parser

**Files:**
- Create: `packages/core/src/newenviron.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/newenviron.test.ts`

**x3270 parses this with an explicit four-state machine** (`parse_new_environ`,
`telnet_new_environ.c:356-470`): `EE_BASE`, `EE_VAR`, `EE_NAME`, `EE_NAME_ESC`. The shape matters
because of two behaviours that are not obvious:

- **A `VAR` or `USERVAR` byte terminates the previous request and starts a new one**, from either
  `EE_VAR` or `EE_NAME`. There is no explicit length or delimiter.
- **An EMPTY body means "send everything".** x3270 detects `state == EE_BASE` at the end and fakes
  *two* requests, one for each group (`:453-470`). Getting this wrong means a host that asks for
  everything gets nothing.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/newenviron.test.ts`:

```typescript
import { parseEnvironSend, type EnvironRequest } from '../src/newenviron.js';

/** ASCII to bytes, for building request bodies. */
const a = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

describe('parseEnvironSend', () => {
  it('parses the three-uservar request from devname_success.trc', () => {
    // The real bytes, from that trace's line 87:
    //   fffa27 01 03 "IBMELF" 03 "IBMAPPLID" 03 "DEVNAME" fff0
    // The body handed to us excludes the option byte and the SEND qualifier.
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, ...a('IBMELF'),
      EnvironGroup.USERVAR, ...a('IBMAPPLID'),
      EnvironGroup.USERVAR, ...a('DEVNAME'),
    ]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.USERVAR, name: 'IBMELF' },
      { group: EnvironGroup.USERVAR, name: 'IBMAPPLID' },
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ]);
  });

  it('parses the single-uservar request the host repeats', () => {
    const body = Uint8Array.from([EnvironGroup.USERVAR, ...a('DEVNAME')]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ]);
  });

  it('treats a group byte with NO name as "the whole group"', () => {
    const body = Uint8Array.from([EnvironGroup.VAR, EnvironGroup.USERVAR]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ]);
  });

  it('EXPANDS AN EMPTY BODY INTO BOTH GROUPS, which is "send everything"', () => {
    // x3270 checks `state == EE_BASE` after the loop and fakes one VAR and one USERVAR
    // request (telnet_new_environ.c:453-470). A client that returned an empty list here
    // would answer a host asking for everything with nothing at all -- and the reply
    // would still be well-formed, so nothing downstream would notice.
    expect(parseEnvironSend(new Uint8Array(0))).toEqual([
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ]);
  });

  it('distinguishes VAR from USERVAR', () => {
    const body = Uint8Array.from([EnvironGroup.VAR, ...a('USER')]);
    expect(parseEnvironSend(body)).toEqual([
      { group: EnvironGroup.VAR, name: 'USER' },
    ]);
  });

  it('un-escapes an ESC in a name', () => {
    // ESC means "the next byte is literal", so a name containing byte 0x03 arrives as
    // ESC 0x03 and must parse back to a one-character name.
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, EnvironGroup.ESC, EnvironGroup.USERVAR,
    ]);
    const got = parseEnvironSend(body)!;
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe(String.fromCharCode(EnvironGroup.USERVAR));
  });

  it('REFUSES a body that does not begin with a group byte', () => {
    // x3270's EE_BASE returns NULL for anything but VAR or USERVAR. Malformed, not
    // truncated: there is nothing to salvage.
    expect(parseEnvironSend(Uint8Array.from(a('DEVNAME')))).toBeNull();
    expect(parseEnvironSend(Uint8Array.of(EnvironGroup.VALUE))).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

Create `packages/core/src/newenviron.ts`:

```typescript
/**
 * The TELNET NEW-ENVIRON option (RFC 1572), telnet option 39.
 *
 * PURE: this module parses a request body and builds a reply body. It holds no session
 * state, opens no socket and owns no counter -- `DeviceName` in devname.ts is where the
 * one piece of state lives, and it is passed in already resolved. Same division as
 * `tn3270e.ts` (a pure state machine) and `bind.ts` (pure parsers).
 *
 * WHAT A HOST USES IT FOR HERE: a `DEVNAME` USERVAR naming the session. That is a
 * SECOND route to the thing TN3270E's CONNECT does with LU names, and the two are
 * unrelated mechanisms for different hosts -- do not unify them.
 *
 * Reference implementation: x3270's Common/telnet_new_environ.c.
 */
import { EnvironGroup } from './constants.js';

/** One requested entry. An empty `name` means "every variable in this group". */
export interface EnvironRequest {
  readonly group: number;
  readonly name: string;
}

/**
 * Parse a SEND request body into the entries requested, in order.
 *
 * Returns null for a malformed body rather than throwing -- the same contract as
 * `decodeHeader` and `parseBind`, and for the same reason: a client cannot correct a
 * host, and an exception here would surface to the operator as a program check the host
 * never caused.
 *
 * THE ORDER IS PRESERVED because the reply must list variables in the order asked; the
 * recorded trace does exactly that with its three uservars.
 *
 * TWO NON-OBVIOUS BEHAVIOURS, both from x3270's four-state machine
 * (telnet_new_environ.c:356-470):
 *  - A VAR or USERVAR byte ENDS the previous request and begins a new one. There is no
 *    length prefix and no delimiter; the group bytes are the delimiters.
 *  - AN EMPTY BODY MEANS "SEND EVERYTHING" and expands to one request per group
 *    (:453-470). Returning an empty list instead would answer such a host with nothing,
 *    in a reply that is still well-formed -- so nothing downstream would notice.
 */
export function parseEnvironSend(body: Uint8Array): readonly EnvironRequest[] | null {
  const out: { group: number; name: number[] }[] = [];
  let escaped = false;

  for (const c of body) {
    if (escaped) {
      // ESC makes the next byte literal, whatever it is.
      out[out.length - 1]!.name.push(c);
      escaped = false;
      continue;
    }
    if (c === EnvironGroup.VAR || c === EnvironGroup.USERVAR) {
      out.push({ group: c, name: [] });
      continue;
    }
    if (out.length === 0) {
      // A name byte before any group byte: x3270's EE_BASE refuses this.
      return null;
    }
    if (c === EnvironGroup.ESC) {
      escaped = true;
      continue;
    }
    out[out.length - 1]!.name.push(c);
  }

  if (out.length === 0) {
    // "Send everything." Both groups, in x3270's order.
    return [
      { group: EnvironGroup.VAR, name: '' },
      { group: EnvironGroup.USERVAR, name: '' },
    ];
  }

  return out.map((r) => ({
    group: r.group,
    name: String.fromCharCode(...r.name),
  }));
}
```

> **IMPLEMENTER: my loop is NOT a transcription of x3270's state machine, and you must decide
> whether that matters.** x3270 distinguishes `EE_VAR` (group byte just seen) from `EE_NAME` (at
> least one name byte seen); mine collapses them because appending to an empty array is the same
> as starting one. **Work out whether any input distinguishes the two** — in particular a trailing
> `ESC` with no following byte, and an `ESC` immediately after a group byte. If my version differs
> from x3270's on any input, **follow x3270 and say so.** If it cannot differ, say that too, and do
> not add a test claiming to pin a distinction that does not exist.

- [ ] **Step 4: Build and test**

- [ ] **Step 5: Mutation-check two things**

1. Make the empty-body case return `[]`. The "send everything" test must fail.
2. Remove the `out.length === 0` refusal so a leading name byte is tolerated. The refusal test must
   fail.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/newenviron.ts packages/core/src/index.ts packages/core/test/newenviron.test.ts
git commit -m "feat(core): parse a NEW-ENVIRON SEND request

Group bytes are the delimiters -- there is no length prefix -- so a VAR or USERVAR
byte ends the previous entry and starts the next. Two behaviours are easy to miss
and both are pinned: a group byte with no name means the whole group, and an EMPTY
body means SEND EVERYTHING, expanding to one request per group. Returning an empty
list for that case would answer the host with nothing in a reply that is still
well-formed, so nothing downstream would notice.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: `buildEnvironIs` — the reply, and the missing-variable rule

**Files:**
- Modify: `packages/core/src/newenviron.ts`
- Test: `packages/core/test/newenviron.test.ts`

**The rule that is easy to get wrong:** for a variable we do NOT have, x3270 emits the **name with no
VALUE byte at all** (`telnet_new_environ.c:559-570`: the `VALUE` append is inside
`if (value != NULL)`). That is distinguishable on the wire from a variable with an empty value, and a
host uses the difference.

- [ ] **Step 1: Write the failing test**

```typescript
import { buildEnvironIs } from '../src/newenviron.js';

describe('buildEnvironIs', () => {
  const uservars = new Map([
    ['IBMELF', 'YES'],
    ['IBMAPPLID', 'None'],
    ['DEVNAME', 'foo001'],
  ]);
  const vars = new Map([['USER', 'herc01']]);

  it('reproduces the reply devname_success.trc records, byte for byte', () => {
    // That trace's line 89-91:
    //   fffa27 00 03 "IBMELF" 01 "YES" 03 "IBMAPPLID" 01 "None" 03 "DEVNAME" 01 "foo001" fff0
    // We build the BODY: everything between `27` and `fff0`, starting at the qualifier.
    const requests = [
      { group: EnvironGroup.USERVAR, name: 'IBMELF' },
      { group: EnvironGroup.USERVAR, name: 'IBMAPPLID' },
      { group: EnvironGroup.USERVAR, name: 'DEVNAME' },
    ];
    expect(Array.from(buildEnvironIs(requests, vars, uservars))).toEqual([
      EnvironQual.IS,
      EnvironGroup.USERVAR, ...a('IBMELF'), EnvironGroup.VALUE, ...a('YES'),
      EnvironGroup.USERVAR, ...a('IBMAPPLID'), EnvironGroup.VALUE, ...a('None'),
      EnvironGroup.USERVAR, ...a('DEVNAME'), EnvironGroup.VALUE, ...a('foo001'),
    ]);
  });

  it('OMITS THE VALUE BYTE ENTIRELY for a variable we do not have', () => {
    // x3270 appends VALUE only `if (value != NULL)` (telnet_new_environ.c:561). So an
    // unknown name is echoed bare. That is DIFFERENT on the wire from a known variable
    // whose value is empty, which emits name + VALUE + nothing, and a host can tell
    // them apart. Emitting an empty VALUE for an unknown name would claim we have a
    // variable we do not.
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'NOSUCH' }], vars, uservars));
    expect(got).toEqual([
      EnvironQual.IS, EnvironGroup.USERVAR, ...a('NOSUCH'),
    ]);
    expect(got).not.toContain(EnvironGroup.VALUE);
  });

  it('distinguishes an EMPTY known value from an absent one', () => {
    const withEmpty = new Map([['EMPTY', '']]);
    expect(Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'EMPTY' }], vars, withEmpty))).toEqual([
      EnvironQual.IS, EnvironGroup.USERVAR, ...a('EMPTY'), EnvironGroup.VALUE,
    ]);
  });

  it('dumps a whole group when the name is empty', () => {
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.VAR, name: '' }], vars, uservars));
    expect(got).toEqual([
      EnvironQual.IS, EnvironGroup.VAR, ...a('USER'), EnvironGroup.VALUE, ...a('herc01'),
    ]);
  });

  it('does not let VAR and USERVAR lookups cross', () => {
    // USER is a VAR; asking for it as a USERVAR must miss, and vice versa. x3270 picks
    // the list by group (`(ereq->group == TELOBJ_VAR)? &vars : &uservars`).
    const asUservar = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'USER' }], vars, uservars));
    expect(asUservar).not.toContain(EnvironGroup.VALUE);
    const asVar = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.VAR, name: 'DEVNAME' }], vars, uservars));
    expect(asVar).not.toContain(EnvironGroup.VALUE);
  });

  it('does NOT prefix-match a name', () => {
    // x3270's find_environ compares with `memcmp(name, e->name, namelen)` and never
    // checks that the LENGTHS match, so a request for "IBM" matches the stored
    // "IBMELF" there. That is a bug in the reference, not a rule to copy: it would
    // answer a question the host did not ask. We require equality.
    const got = Array.from(buildEnvironIs(
      [{ group: EnvironGroup.USERVAR, name: 'IBM' }], vars, uservars));
    expect(got).not.toContain(EnvironGroup.VALUE);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

- [ ] **Step 3: Implement**

```typescript
/**
 * Build the IS reply body for `requests`.
 *
 * Returns the body from the qualifier onward: the caller adds `IAC SB NEW-ENVIRON`
 * ahead of it and `IAC SE` after, and is responsible for IAC doubling -- see the
 * TERMINAL-TYPE reply in telnet.ts for the same division and the RFC 855 reason.
 *
 * THE MISSING-VARIABLE RULE IS THE ONE TO GET RIGHT: a name we do not have is echoed
 * with NO VALUE byte at all (x3270 appends VALUE inside `if (value != NULL)`,
 * telnet_new_environ.c:561). That is distinguishable on the wire from a known variable
 * whose value is empty -- name + VALUE + nothing -- and emitting an empty VALUE for an
 * unknown name would claim we have a variable we do not.
 *
 * WE REQUIRE AN EXACT NAME MATCH, WHICH DIVERGES FROM x3270 DELIBERATELY. Its
 * `find_environ` compares `memcmp(name, e->name, namelen)` without checking that the
 * lengths agree (:159-175), so a request for "IBM" matches its stored "IBMELF". That
 * answers a question the host did not ask; we do not copy it.
 */
export function buildEnvironIs(
  requests: readonly EnvironRequest[],
  vars: ReadonlyMap<string, string>,
  uservars: ReadonlyMap<string, string>,
): Uint8Array {
  const out: number[] = [EnvironQual.IS];
  const emit = (group: number, name: string, value: string | undefined): void => {
    out.push(group, ...escapeEnvironBytes(name));
    if (value !== undefined) out.push(EnvironGroup.VALUE, ...escapeEnvironBytes(value));
  };

  for (const req of requests) {
    const list = req.group === EnvironGroup.VAR ? vars : uservars;
    if (req.name === '') {
      // The whole group, in insertion order.
      for (const [name, value] of list) emit(req.group, name, value);
      continue;
    }
    emit(req.group, req.name, list.get(req.name));
  }
  return Uint8Array.from(out);
}
```

`escapeEnvironBytes` is Task 5. **For this task, stub it** so these tests run:

```typescript
function escapeEnvironBytes(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}
```

Add `EnvironQual` to this module's import from `./constants.js`.

- [ ] **Step 4: Build and test**

- [ ] **Step 5: Mutation-check the missing-variable rule**

Make `emit` always push `EnvironGroup.VALUE`. Both the "omits the VALUE byte" test and the
"distinguishes empty from absent" test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/newenviron.ts packages/core/test/newenviron.test.ts
git commit -m "feat(core): build the NEW-ENVIRON IS reply, byte-identical to a real trace

Pinned against devname_success.trc's own recorded reply rather than against the
RFC. The rule worth naming: a variable we do NOT have is echoed with no VALUE byte
at all, which is distinguishable on the wire from a known variable whose value is
empty, and a host can tell them apart.

Deliberate divergence from x3270: its find_environ compares only namelen bytes
without checking the lengths agree, so a request for IBM matches its stored
IBMELF. That answers a question the host did not ask. We require equality.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: RFC 1572 escaping

**Files:**
- Modify: `packages/core/src/newenviron.ts`
- Test: `packages/core/test/newenviron.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { escapeEnvironBytes } from '../src/newenviron.js';

describe('escapeEnvironBytes', () => {
  it('leaves ordinary text alone', () => {
    expect(escapeEnvironBytes('DEVNAME')).toEqual(a('DEVNAME'));
  });

  it('prefixes each of the four group codes with ESC', () => {
    // x3270's ESCAPED() macro covers VAR, USERVAR, ESC and VALUE
    // (telnet_new_environ.c:58-59), and escaped_copy inserts ESC before each
    // (:118-129).
    //
    // NO HOST HAS EVER SENT US SUCH A NAME and no trace in x3270's collection contains
    // one -- every real device name is plain ASCII. This is therefore an UNWITNESSED
    // wire rule, implemented because the alternative is silent corruption on the one
    // host that does something unusual, and round-tripped below against our own parser,
    // which is a real property even without a host.
    expect(escapeEnvironBytes('\x00')).toEqual([EnvironGroup.ESC, 0]);
    expect(escapeEnvironBytes('\x01')).toEqual([EnvironGroup.ESC, 1]);
    expect(escapeEnvironBytes('\x02')).toEqual([EnvironGroup.ESC, 2]);
    expect(escapeEnvironBytes('\x03')).toEqual([EnvironGroup.ESC, 3]);
  });

  it('round-trips through our own parser', () => {
    // The property that holds without a host: whatever we escape, we un-escape.
    const nasty = '\x00\x01A\x02\x03';
    const body = Uint8Array.from([
      EnvironGroup.USERVAR, ...escapeEnvironBytes(nasty),
    ]);
    expect(parseEnvironSend(body)![0]!.name).toBe(nasty);
  });

  it('truncates above a byte rather than emitting a multi-byte code unit', () => {
    // charCodeAt yields a UTF-16 code unit. The same trap telnet.ts's TERMINAL-TYPE
    // reply documents: mask to a byte or a value above 255 goes out mangled.
    expect(escapeEnvironBytes('ǿ')).toEqual([0xff]);
  });
});
```

- [ ] **Step 2: Run and watch it fail** (the stub passes the first test and fails the rest)

**Report how many of the four fail.** The stub returns unescaped bytes, so some may pass vacuously —
that is the same shape as Task 3 of the bind-image plan, where a stub made two tests pass for the
wrong reason.

- [ ] **Step 3: Implement**

Replace the stub:

```typescript
/**
 * Escape a name or value for the wire (RFC 1572; x3270's `escaped_copy`,
 * telnet_new_environ.c:118-129).
 *
 * Any byte equal to one of the four group codes would otherwise be read as a
 * delimiter, so it is prefixed with ESC. The receiver strips the ESC and takes the next
 * byte literally, which is what `parseEnvironSend` does.
 *
 * UNWITNESSED BY ANY HOST: every real device name in x3270's trace collection is plain
 * ASCII, so no recorded exchange exercises this. Implemented anyway, because the
 * alternative is silent corruption on the first host that does something unusual, and
 * because it round-trips against our own parser -- a real property even without a host.
 *
 * Masked to a byte BEFORE the comparison, not after: `charCodeAt` yields a UTF-16 code
 * unit, and U+01FF is 511 rather than any group code but truncates to 0xFF. The same
 * trap telnet.ts's TERMINAL-TYPE reply documents.
 */
export function escapeEnvironBytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const b = ch.charCodeAt(0) & 0xff;
    if (b === EnvironGroup.VAR || b === EnvironGroup.VALUE
      || b === EnvironGroup.ESC || b === EnvironGroup.USERVAR) {
      out.push(EnvironGroup.ESC);
    }
    out.push(b);
  }
  return out;
}
```

- [ ] **Step 4: Build and test**

- [ ] **Step 5: Mutation-check**

Remove the ESC push. The escaping test and the round-trip test must both fail.

> **Also check:** does `for (const ch of s)` iterate code points rather than code units, and does
> that matter here? A surrogate pair would yield a code point above 0xFFFF whose `charCodeAt(0)`
> masks to something arbitrary. **Decide whether to care, and say why.** A device name is ASCII in
> every known case, but a silent mangling is worth a sentence in the comment either way.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/newenviron.ts packages/core/test/newenviron.test.ts
git commit -m "feat(core): RFC 1572 escaping, unwitnessed but implemented

A byte equal to one of the four group codes would be read as a delimiter, so it is
prefixed with ESC. No host has ever sent us such a name and no trace contains one:
every real device name is plain ASCII. Implemented because the alternative is
silent corruption on the first host that is unusual, and round-tripped against our
own parser, which is a real property even without a host.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 6: The telnet layer — option 39 and the subnegotiation

**Files:**
- Modify: `packages/core/src/telnet.ts`
- Test: `packages/core/test/telnet.test.ts`

**Follow the TN3270E precedent exactly.** `onDo` already has a conditional-option branch for option
40 (`telnet.ts:410-420`) because option 40 is conditional where `DESIRED` is a constant set. Option
39 has the same shape: we want it only when a device name or user is configured.

- [ ] **Step 1: Write the failing tests**

In `packages/core/test/telnet.test.ts`, following that file's `harness()`/`eHarness()` idiom (read
them first):

```typescript
describe('NEW-ENVIRON telnet option (39)', () => {
  it('agrees to option 39 when variables are configured', () => {
    const { layer, sent } = envHarness({ devname: 'foo===' });
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    expect(sent).toEqual([[T.IAC, T.WILL, O.NEW_ENVIRON]]);
  });

  it('REFUSES option 39 when nothing is configured', () => {
    // Dark by default, which is what keeps this feature's blast radius on the existing
    // negotiation tests at zero. A host offering it to a client with no device name and
    // no user has nothing to learn.
    const { layer, sent } = envHarness({});
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    expect(sent).toEqual([[T.IAC, T.WONT, O.NEW_ENVIRON]]);
  });

  it('does not re-acknowledge a repeated DO', () => {
    // RFC 854's loop rule, the same guard the other options carry.
    const { layer, sent } = envHarness({ devname: 'foo===' });
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    sent.length = 0;
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    expect(sent).toEqual([]);
  });

  it('answers a host WILL for option 39 with DONT', () => {
    // NEW-ENVIRON is something WE do. A host offering to do it is refused. Asserted
    // rather than assumed, because the WONT TN3270E bug (e789b4f) was exactly a missing
    // case for an option in the wrong direction, and it was the third of that shape
    // here.
    const { layer, sent } = envHarness({ devname: 'foo===' });
    layer.receive(Uint8Array.of(T.IAC, T.WILL, O.NEW_ENVIRON));
    expect(sent).toEqual([[T.IAC, T.DONT, O.NEW_ENVIRON]]);
  });

  it('answers a SEND for DEVNAME with a full IS reply, framed', () => {
    const { layer, sent } = envHarness({ devname: 'foo===' });
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    sent.length = 0;
    layer.receive(Uint8Array.from([
      T.IAC, T.SB, O.NEW_ENVIRON, EnvironQual.SEND,
      EnvironGroup.USERVAR, ...a('DEVNAME'), T.IAC, T.SE,
    ]));
    expect(sent).toEqual([[
      T.IAC, T.SB, O.NEW_ENVIRON, EnvironQual.IS,
      EnvironGroup.USERVAR, ...a('DEVNAME'), EnvironGroup.VALUE, ...a('foo001'),
      T.IAC, T.SE,
    ]]);
  });

  it('ITERATES the device name across successive requests', () => {
    // The behaviour the whole template mechanism exists for, driven through real bytes
    // rather than by calling DeviceName directly -- the delivery is what could break.
    const { layer, sent } = envHarness({ devname: 'foo===' });
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    const ask = Uint8Array.from([
      T.IAC, T.SB, O.NEW_ENVIRON, EnvironQual.SEND,
      EnvironGroup.USERVAR, ...a('DEVNAME'), T.IAC, T.SE,
    ]);
    sent.length = 0;
    layer.receive(ask);
    layer.receive(ask);
    layer.receive(ask);
    const names = sent.map((frame) => String.fromCharCode(
      ...frame.slice(frame.indexOf(EnvironGroup.VALUE) + 1, frame.length - 2)));
    expect(names).toEqual(['foo001', 'foo002', 'foo003']);
  });

  it('drops a malformed SEND rather than replying', () => {
    const { layer, sent } = envHarness({ devname: 'foo===' });
    layer.receive(Uint8Array.of(T.IAC, T.DO, O.NEW_ENVIRON));
    sent.length = 0;
    // A name byte with no group byte ahead of it: parseEnvironSend returns null.
    layer.receive(Uint8Array.from([
      T.IAC, T.SB, O.NEW_ENVIRON, EnvironQual.SEND, ...a('DEVNAME'), T.IAC, T.SE,
    ]));
    expect(sent).toEqual([]);
  });
});
```

> **IMPLEMENTER: `envHarness` does not exist.** `telnet.test.ts` has `harness()` and `eHarness()`.
> Add one in the same shape that takes the new variable options, and **report its signature** —
> Task 7 will use it. Keep the existing two untouched.
>
> **My `names` extraction in the iteration test is fragile** (`indexOf` finds the first `VALUE`
> byte, and `length - 2` assumes the frame ends `IAC SE`). It will work for this exact reply and
> break confusingly on any other. **Write something clearer if you can**, and if you keep it, say in
> a comment why it is safe for this input.

- [ ] **Step 2: Run and watch them fail**

- [ ] **Step 3: Implement**

`TelnetLayerOptions` gains the variables. **Design decision to make and justify:** does the layer
take a `DeviceName` instance, or resolved maps plus a callback? The layer must get a *fresh* name per
request, so a plain `ReadonlyMap<string,string>` cannot be the whole story.

Suggested shape — **adapt if you find better**:

```typescript
  /** NEW-ENVIRON variables, or absent to refuse option 39 entirely. */
  environ?: {
    readonly vars: ReadonlyMap<string, string>;
    /** Called per reply, so DEVNAME can iterate. Absent means no DEVNAME. */
    readonly uservars: () => ReadonlyMap<string, string>;
  };
```

`onDo`, beside the TN3270E branch:

```typescript
    if (opt === O.NEW_ENVIRON) {
      // CONDITIONAL, like option 40 and for the same reason: `DESIRED` is a constant
      // set, and we want 39 only when there is something to say. Refusing when nothing
      // is configured keeps this feature dark by default, which is what holds its blast
      // radius on the existing negotiation tests at zero.
      if (this.environ === undefined) {
        this.reply(T.WONT, opt);
        return;
      }
      if (!this.myOpts.has(opt)) {
        this.myOpts.add(opt);
        this.reply(T.WILL, opt);
      }
      return;
    }
```

`handleSubnegotiation`, beside the TERMINAL-TYPE branch:

```typescript
    if (this.sb[0] === O.NEW_ENVIRON && this.sb[1] === EnvironQual.SEND) {
      const requests = parseEnvironSend(Uint8Array.from(this.sb.slice(2)));
      this.sb = [];
      if (requests === null || this.environ === undefined) {
        this.trace?.note('malformed or unconfigured NEW-ENVIRON SEND, dropped');
        return;
      }
      const body = buildEnvironIs(
        requests, this.environ.vars, this.environ.uservars());
      // The body is a subnegotiation PARAMETER, so a 0xFF inside it must be doubled --
      // RFC 855's last paragraph, the same rule the TERMINAL-TYPE reply above follows.
      const out = Uint8Array.from([
        T.IAC, T.SB, O.NEW_ENVIRON, ...doubleIac(Array.from(body)), T.IAC, T.SE,
      ]);
      this.trace?.send(out);
      this.write(out);
      return;
    }
```

> **CHECK THE `doubleIac` PLACEMENT.** The TERMINAL-TYPE branch doubles only the ttype string, not
> the `IS` qualifier. Mine doubles the whole body including the qualifier. **Work out whether that
> is right** — the qualifier is `0x00`, so it cannot itself need doubling, but a *value* containing
> 0xFF must. Verify by reading how the TERMINAL-TYPE branch frames its reply, and say what you
> concluded.

- [ ] **Step 4: Build, typecheck, FULL suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"
```

**The blast-radius check.** Accepting a new option changes negotiation. **Before fixing anything that
fails, list every failing test with its file and line and say whether it still asserts something.**
On the bind-image branch three tests **lost their subject** in a comparable flip, and the plan's own
grep missed a whole test file because it referenced a constant by a different name. Expect zero
failures here *because* option 39 is refused unless configured — **but verify that, do not assume
it.**

- [ ] **Step 5: Mutation-check**

1. Make `onDo` accept 39 unconditionally. The "REFUSES when nothing is configured" test must fail —
   and **report whether anything else does**, because that is the blast radius the conditional is
   buying.
2. Call `uservars()` once outside the loop instead of per reply. The iteration test must fail.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/core/src/telnet.ts packages/core/test/telnet.test.ts
git commit -m "feat(core): negotiate NEW-ENVIRON and answer its SEND

Conditional on variables being configured, like option 40 and for the same reason:
DESIRED is a constant set, and a host offering 39 to a client with no device name
has nothing to learn. Dark by default, which holds the blast radius on the
existing negotiation tests at zero.

A host WILL for 39 is answered DONT and that is asserted rather than assumed --
the WONT TN3270E bug was exactly a missing case for an option in the wrong
direction, and it was the third of that shape here.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 7: Session wiring and `-devname` in four front ends

**Files:**
- Modify: `packages/core/src/session.ts`, `packages/core/src/index.ts`
- Modify: `packages/frontend/src/session.ts`
- Modify: `packages/cli/src/main.ts`, `packages/gui/src/args.ts`, `packages/tui/src/main.ts`,
  `packages/web/src/args.ts`
- Test: each package's existing arg-parser tests, plus `packages/core/test/session.test.ts`

- [ ] **Step 1: Write the failing arg tests**

For each of the four parsers, following that package's existing `-model`/`-bind-image` tests:

```typescript
  it('-devname sets the device name template', () => {
    expect(parseArgs(['-devname', 'foo===', 'h:23']).devname).toBe('foo===');
  });

  it('-devname without a value is a usage error', () => {
    expect(() => parseArgs(['-devname'])).toThrow(UsageError);
  });

  it('has no device name by default', () => {
    expect(parseArgs(['h:23']).devname).toBeUndefined();
  });
```

- [ ] **Step 2: Session-level test**

```typescript
  it('offers NEW-ENVIRON only when a device name was given', () => {
    // The wiring, end to end: a Session built without -devname must refuse option 39,
    // and one built with it must accept. This is what connects the layer's `environ`
    // option to the flag.
    /* build a Session with no devname, deliver IAC DO NEW_ENVIRON, expect WONT */
    /* build one with devname, same bytes, expect WILL */
  });
```

> **IMPLEMENTER:** `session.test.ts` is the classic-mode harness (`tn3270e-session.test.ts` is the
> TN3270E one — the bind-image plan got this wrong and cost an hour). **Read whichever fits and
> follow its idiom**; option 39 is not TN3270E-specific, so the classic harness is probably right.

- [ ] **Step 3: Implement**

`SessionOptions`:

```typescript
  /**
   * Device-name template for NEW-ENVIRON's DEVNAME uservar. Absent means we refuse
   * telnet option 39 entirely.
   *
   * Trailing `=` characters become a counter: `foo===` yields foo001, foo002, ... See
   * devname.ts for why a host wants a fresh name per request.
   */
  devname?: string;
  /**
   * Value for NEW-ENVIRON's USER var. Defaults to $USER, then $USERNAME, then UNKNOWN,
   * matching x3270 (telnet_new_environ.c:221-228).
   *
   * THIS PUTS THE LOCAL ACCOUNT NAME ON THE WIRE to any host that asks for it. x3270
   * does the same unconditionally. Documented in the README rather than left for someone
   * to discover in a trace.
   */
  user?: string;
```

In `connect()` (and `replay()`, if it builds a layer — **check**), build the `environ` option:
`vars` holds `USER`; `uservars` is a closure returning a fresh map each call with `IBMELF: 'YES'`,
`IBMAPPLID: 'None'`, and `DEVNAME` from a `DeviceName` held on the Session.

> **Two things to decide and justify:**
> 0. **`IBMELF` HAS NO EXPLANATION ANYWHERE IN x3270** — it is set unconditionally at
>    `telnet_new_environ.c:238` with the bare comment `/* Set IBMELF. */` and no statement of what it
>    claims. I could not determine what a host does with it, and **neither should you guess.** But see
>    the note below about x3270's own test target, which *requests* it: that tells you a host asks for
>    it, not what it means. Decide, justify, and if you send it say plainly in the comment that its
>    meaning is unverified rather than inventing one.
> 1. **Where does the `DeviceName` live, and when is it reset?** Per session or per connection? A
>    reconnect to the same host arguably should keep counting (the earlier names may still be in
>    use); a connect to a *different* host arguably should restart. `Session` already distinguishes
>    these — see `forgetTn3270e` and the `per` field, and note the recorded lesson that this project
>    twice shipped a bug where one teardown path cleared state and another did not. **Pick one,
>    implement it in ONE place, and say which.**
> 2. **Is `IBMELF: 'YES'` right for us?** x3270 sends it unconditionally (`:243`). It advertises
>    Enhanced LU Support. **Check what it means before copying it** — if we cannot honour what it
>    claims, sending it may be worse than omitting it. Report your reasoning; this is a judgement
>    call, not a transcription.

Then thread `devname` through `defaultSession` (the `...(x === undefined ? {} : { x })` idiom) and
add `-devname` to all four parsers. **Match each parser's own idiom** — `packages/web/src/args.ts`
uses `value(args, i, a)` and `continue`; the others a `switch` with `i += 1`. Each defines its **own**
`UsageError`; use the local one.

- [ ] **Step 4: Build, typecheck, full suite**

- [ ] **Step 5: Mutation-check**

Make `connect()` always pass `environ`. The session-level "only when a device name was given" test
must fail.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add -A && git commit -m "feat: -devname in all four front ends, and the session wiring

Single-dashed like -model and -bind-image: inherited client flags, where only the
gateway's own flags are double-dashed. Absent means we refuse option 39 entirely,
so the feature is dark unless asked for.

USER goes on the wire to any host that asks, which is x3270's unconditional
behaviour and is now documented rather than left to be discovered in a trace.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 8: The playback oracle — up to four new traces

**Files:**
- Modify: `packages/cli/scripts/drive-playback.py`
- Possibly add: `packages/fixtures/x3270/*.trc`

**DO NOT PROMISE FOUR CASES.** The whole reason this feature's first cost estimate was wrong is that
the traces were not read before estimating. Drive each one, report what actually happens.

### A BETTER ORACLE THAN I PLANNED FOR, found while reviewing this plan

**x3270 ships its own test SERVER and it implements the NEW-ENVIRON request side:**
`Common/Test/target/tn3270.py:173-181`. On receiving `WILL NEW-ENVIRON` it builds a SEND asking for
`IBMELF` and `IBMAPPLID` when its `elf` flag is set and for `DEVNAME` when `devname_max > 0`, then
tracks `devname_last_value` and `devname_count` — i.e. **it checks that the name changes.**

That is a live, scriptable counterparty for this feature, not just a recording, and it is already on
this box. **It is strictly better than a trace for the iteration behaviour**, because a trace can only
replay one recorded conversation while the target can be asked repeatedly.

**Consider using it, and report whether you did.** Two caveats before trusting it: it is a test
target rather than a real host, so it proves interoperability with x3270's *idea* of a host (the same
limitation `e-server.py` has, and this project's rule is that a harness never shown to satisfy a
known-good client cannot say which side is wrong — so **satisfy real s3270 against it first**); and
it needs a Python entry point this repo does not yet wire up. If it is more than an hour's work,
prefer the traces and record the target as a follow-up.

- [ ] **Step 1: Try `devname_success.trc` first**

It is the one that motivated the feature: it negotiates NEW-ENVIRON, then TN3270E with BIND-IMAGE,
and receives a real BIND (PLU `IBM0SMAJ`, MaxSec-RU 1024, MaxPri-RU 3840, default 24x80, alternate
43x80). Add a case with `-devname foo===` and see how far it gets.

**Note the existing `EXCLUDED` entry for it** — it records that the trace needs NEW-ENVIRON, which we
now have. Update or remove that entry; do not leave a stale exclusion beside a working case.

- [ ] **Step 2: Then the other three**

`devname_failure.trc` (template `foo=`, and it records a host *refusing* names), `devname_change1.trc`,
`devname_change2.trc`. **Each may need a different `-devname` template to match** — read the trace's
own `SENT ... VALUE "..."` lines to see which.

- [ ] **Step 3: Copy any trace you use into `packages/fixtures/x3270/`**

With a provenance note in that directory's README, following what `sscp-lu-data.trc` did. A path into
a hand-built suite3270 checkout is not reproducible; the `playback` binary necessarily lives there,
the traces need not.

- [ ] **Step 4: Preserve the three ways this harness fakes a pass**

In each new case's comments: `playback` **exits 0 whether or not it matched anything**
(`playback.c:373` is literally `exit(0); /* needs to be smarter */`), so assert on `Matched N bytes`;
16 of 71 traces have no emulator side; **a trace records one client version, not a spec.** And
playback never `fflush`es its readiness line, so waiting for it on a pipe hangs forever — use the
existing log-file mechanism, **do not add a probe** (a readiness probe was once accepted *as* the
client in the sibling harness, failing all seven of its cases with a healthy client).

- [ ] **Step 5: Run and pin what you saw**

```bash
cd ~/git/tn3270 && npm run build && python3 packages/cli/scripts/drive-playback.py
```

**Report the exact block and byte counts per case.** If a trace stops on a divergence that is not our
bug — `wrongTerminalName`'s colour digit is the known one — use `mismatch_ok=True` and say why, and
**verify the flag does not mask a regression** by reverting something the case should catch. That
check is what proved `wont-tn3270e.trc`'s flag honest.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/cli/scripts/drive-playback.py packages/fixtures/x3270/
git commit -m "test(cli): drive the devname traces through the playback oracle

<REPLACE with what actually happened: which traces are drivable, how many blocks
each matches, and which are not viable and why. Do not claim four without having
run four.>

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 9: Docs

**Files:** `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md`, this plan

- [ ] **Step 1: README**

Document `-devname`, including the `=` template. **State plainly that `USER` puts the local account
name on the wire.** Remove NEW-ENVIRON from *What is not implemented* — it is listed there now, and a
stale prohibition costs as much as a missing one (this project has measured that).

- [ ] **Step 2: `docs/live-testing.md`**

Record what the new playback cases prove, and what still has no live witness. NEW-ENVIRON has **no
live host** here: neither Hercules system offers it (**check this — do not assume**; probe with the
committed runbook method), so its witness is recorded traces only.

- [ ] **Step 3: `docs/HANDOFF.md`**

Update *START HERE*. **Check the summaries last** — the recurring defect on this project is that a
fix reaches the prose body and never the heading, blurb or expected-count that summarises it. Four
such lines were found on the bind-image branch by grepping the old numbers. **Grep for the old test
count and for "not implemented" claims about option 39.**

- [ ] **Step 4: Annotate this plan AS BUILT**

Every task that diverged gets an `**AS BUILT:**` note. This is why the bind-image and keypad plans'
defects did not need re-deriving.

- [ ] **Step 5: Commit**

---

## Task 10: The whole gate

- [ ] **Step 1: Force-rebuild BOTH GUI and web**

```bash
cd ~/git/tn3270 && npx tsc --build --force packages/gui packages/web
```

**Not optional, and forcing only `gui` is a recorded mistake:** a checkout or merge rewrites mtimes
without changing content, so both staleness guards redden. Forcing only `packages/gui` failed
`browser-keys.mjs` on the gate right after the bind-image merge.

- [ ] **Step 2: Build, typecheck, suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"
```

Expect green and a count above the 1819 baseline. Record it.

- [ ] **Step 3: The three Python harnesses**

```bash
python3 packages/cli/scripts/drive-playback.py    # expect 6/6 plus whatever Task 8 added
python3 packages/cli/scripts/drive-e.py           # expect 10/10
python3 packages/tui/scripts/pty-smoke.py         # expect 12 PASS, exit 0
```

- [ ] **Step 4: The five GUI/web harnesses**

They start Xvfb themselves. **Do not guard with `pgrep -f "Xvfb :99"`** — it matches the shell
command containing the pattern. Test for `[ -S /tmp/.X11-unix/X99 ]`.

```bash
node packages/gui/scripts/shot.mjs           # expect 3/3 goldens
node packages/gui/scripts/keys.mjs           # expect 18 chords / 16 actions
node packages/gui/scripts/clicks.mjs         # expect 9 buttons / 10 actions
node packages/web/scripts/browser-keys.mjs   # expect 13 chords / 11 actions
node packages/web/scripts/browser-shot.mjs   # expect 2/2
```

- [ ] **Step 5: Report, and do NOT merge**

**The merge is the user's call.** Report every number and stop.

---

## Self-Review

**Spec coverage.** Constants → Task 1. The iterator → Task 2. Parser → Task 3. Reply and the
missing-variable rule → Task 4. Escaping → Task 5. Option 39 and the subnegotiation → Task 6.
Flags and session wiring → Task 7. Playback → Task 8. Docs → Task 9. Gate → Task 10. The spec's
out-of-scope items (`CODEPAGE`/`CHARSET`/`KBDTYPE`, the `ESC` request group, LU-name unification)
appear in no task, which is correct.

**Known gaps and uncertainties, stated rather than hidden.**

1. **Task 7's test bodies are sketches**, because the right harness file is uncertain and the
   bind-image plan lost an hour to exactly that guess. The implementer reads and reports.
2. **`envHarness` does not exist** (Task 6) and its signature is the implementer's to set.
3. **My `parseEnvironSend` collapses x3270's `EE_VAR` and `EE_NAME` states.** Task 3 asks whether any
   input distinguishes them. If one does, x3270 wins.
4. **The `doubleIac` placement in Task 6 may be wrong** — I double the whole body including the
   qualifier where TERMINAL-TYPE doubles only the string. Flagged for verification.
5. **Two judgement calls are delegated with reasons required**: where the `DeviceName` lives and when
   it resets (Task 7), and whether `IBMELF: 'YES'` is honest for us to send (Task 7).
6. **Task 8 must not promise four traces.** The estimate that produced this feature was wrong for
   exactly that reason.
7. **My `names` extraction in Task 6's iteration test is fragile** and flagged as such.

**Type consistency.** `EnvironGroup`, `EnvironQual`, `EnvironRequest`, `parseEnvironSend`,
`buildEnvironIs`, `escapeEnvironBytes`, `DeviceName.next`, `TelnetOpt.NEW_ENVIRON`,
`TelnetLayerOptions.environ` (`{ vars, uservars() }`), `SessionOptions.devname`/`user`. `buildEnvironIs`
returns the body **from the qualifier onward** in both its definition and Task 6's caller, and Task 6
is the only place framing and IAC doubling happen.
