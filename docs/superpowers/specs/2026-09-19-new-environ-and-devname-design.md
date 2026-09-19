# NEW-ENVIRON (telnet option 39) and `-devname` — design

**Date:** 2026-09-19
**Status:** designed, not implemented
**Baseline:** `main` at `3918931`, 1819 tests in 72 files, the only branch, tree clean.

## Why this, and why now rather than oversize

The user asked for the relative cost of this against oversize/`IBM-DYNAMIC`. Measured, this is the
cheaper one, and the gap is structural rather than a matter of line count:

- **NEW-ENVIRON touches no geometry.** It is one telnet option, one subnegotiation shape and a
  string. No `Screen`, no renderer, no front-end sizing, no Query Reply.
- **Oversize touches all of those.** `Screen` would have to allocate beyond the model table, the
  product bound (rows × cols ≤ 16383) is a new *kind* of constraint, four Query Reply units report
  geometry and already disagree about which size to report, and both renderers have sizing policy
  (the TUI refuses rather than clipping; the GUI picks the largest integer scale fitting 80% of the
  work area).

**And uniquely among the remaining roadmap items, this one makes existing evidence stronger rather
than adding new code to verify.** Four traces in x3270's collection become drivable by
`drive-playback.py`: `devname_success.trc`, `devname_failure.trc`, `devname_change1.trc`,
`devname_change2.trc`. `devname_success.trc` is the trace this project originally wanted as the
recorded-host BIND witness and could not use — it was replaced by `sscp-lu-data.trc` because we
answer `IAC WONT NEW-ENVIRON` where it expects `WILL`, mismatching after one block.

**A CORRECTION TO THE COST ESTIMATE GIVEN TO THE USER BEFORE THE TRACES WERE READ.** The first
estimate called the DEVNAME template iterator "optional, skip it initially". **It is not optional if
the goal is driving those traces.** See *The iterator is load-bearing* below. Two other items were
missed at the same time: the host requests **three** uservars in one message, and RFC 1572 defines an
**escaping rule**. The revised shape is still smaller than oversize and still structurally isolated,
but it is not a one-flag job.

## What the wire actually looks like — measured, not from the RFC

From `s3270/Test/devname_success.trc`, host bytes `<`, ours `>`:

```
< fffd27                      IAC DO NEW-ENVIRON
> fffb27                      IAC WILL NEW-ENVIRON
< fffa27 01 03 "IBMELF" 03 "IBMAPPLID" 03 "DEVNAME" fff0
                              SB NEW-ENVIRON SEND USERVAR ... USERVAR ... USERVAR ... SE
> fffa27 00 03 "IBMELF" 01 "YES" 03 "IBMAPPLID" 01 "None" 03 "DEVNAME" 01 "foo001" fff0
                              SB NEW-ENVIRON IS USERVAR/VALUE x3 SE
< fffa27 01 03 "DEVNAME" fff0  SEND USERVAR "DEVNAME"
> fffa27 00 03 "DEVNAME" 01 "foo002" fff0
< fffa27 01 03 "DEVNAME" fff0  SEND USERVAR "DEVNAME"
> fffa27 00 03 "DEVNAME" 01 "foo003" fff0
```

Codes, from x3270's `include/arpa_telnet.h:122-125`:

| name | value |
|---|---|
| `TELOBJ_VAR` | 0 |
| `TELOBJ_VALUE` | 1 |
| `TELOBJ_ESC` | 2 |
| `TELOBJ_USERVAR` | 3 |

and the qualifiers `IS = 0`, `SEND = 1` — **the same two values `TelnetSubopt` already defines for
TERMINAL-TYPE**, which is a coincidence of encoding and not a shared meaning. Do not reuse that
constant here; define NEW-ENVIRON's own, as `constants.ts` already does for the several other places
this project found a value collision (see its `XAH.DEFAULT` / `XA.RESET` note for the same lesson).

## The iterator is load-bearing

`devname_success.trc` answers `foo001`, `foo002`, `foo003`, `foo004` — **a different name every time
the host asks.** `devname_failure.trc` does the same with `foo1`, `foo2`, `foo3`. This is x3270's
`devname_init`/`devname_next` (`Common/devname.c`):

- **Trailing `=` characters in the template become a zero-padded counter.** `devname_init` counts them
  (`while (len > 0 && template[--len] == '=') { sub_length++; max *= 10; }`), so `foo===` yields 3
  digits and a maximum of 999; `foo=` yields 1 digit and 9.
- `devname_next` increments and formats in place with `%0*lu`, and **stops at the maximum rather than
  wrapping** (`if (d->current < d->max)`), so the last name repeats forever once exhausted.
- **The first answer is `foo001`, not `foo000`** — `devname_next` pre-increments, and it is called on
  the first request, not at init.

So the template `foo===` and the observed `foo001`/`foo002`/`foo003` are one mechanism, and a
fixed-string `-devname` cannot reproduce them. **Why a host wants this:** the device name is how it
identifies the session, and a name already in use is refused — so the client offers the next
candidate. That is what `devname_failure.trc` records.

## Scope

**In:**
- Accept option 39 (`DO` → `WILL`, and `WILL` → `DONT`; see below).
- Parse a `SEND` request: a list of `VAR`/`USERVAR` entries, each with an optional name.
- Build the `IS` reply for the variables we know, in the order asked.
- `USER` as a VAR; `IBMELF`, `IBMAPPLID` and `DEVNAME` as USERVARs.
- The `-devname` flag with `=`-template iteration, in all four front ends.
- RFC 1572 escaping on names and values.

**Out, deliberately:**
- **`CODEPAGE`, `CHARSET`, `KBDTYPE`.** **A first draft of this spec said x3270 "initialises all
  three to `NULL`" — that was WRONG, and the correction is the useful part.** The `NULL`s at
  `telnet_new_environ.c:210-212` are only the struct initialiser; `:247-275` fills all three in
  immediately after, from the host codepage (`CODEPAGE` from `cgcsgid & 0xffff` zero-padded below
  100, `CHARSET` from `cgcsgid >> 16`, `KBDTYPE` from `kybdtype`), with environment overrides and a
  `NO_CODEPAGE` escape hatch. So x3270 really does offer them.

  **They stay out of scope anyway, for a different and honest reason: no trace in the collection
  requests them, so we would be shipping three variables with no witness of any kind** — and ours
  would have to invent a `cgcsgid` equivalent, which this client does not model (we have `cp037` and
  nothing else). Add them when a host asks, and record that decision rather than the wrong fact.
- **The `ESC` group code as an incoming request group.** x3270's `VALID_GROUP` accepts it, but it is
  meaningless as a request group and no trace sends one. Refuse or ignore; do not invent semantics.
- **Anything about TN3270E `CONNECT`/LU names.** They are a *different* route to naming a session and
  already work. This adds a second route; it does not change the first.

## Architecture

### 1. A new module, `packages/core/src/newenviron.ts`

**Pure**, matching `bind.ts` and `tn3270e.ts`: it takes the subnegotiation body and a set of
variables, and returns reply bytes. No socket, no session state, no `Date`, no counters that live
outside their argument.

```ts
/** RFC 1572 group and qualifier codes. */
export const EnvironGroup = { VAR: 0, VALUE: 1, ESC: 2, USERVAR: 3 } as const;
export const EnvironQual = { IS: 0, SEND: 1, INFO: 2 } as const;

/** One requested entry: a group, and a name (empty means "the whole group"). */
export interface EnvironRequest {
  readonly group: number;
  readonly name: string;
}

/** Parse a SEND body into the entries requested, in order. */
export function parseEnvironSend(body: Uint8Array): readonly EnvironRequest[] | null;

/** Build the IS reply for `requests`, looking each up in `vars`/`uservars`. */
export function buildEnvironIs(
  requests: readonly EnvironRequest[],
  vars: ReadonlyMap<string, string>,
  uservars: ReadonlyMap<string, string>,
): Uint8Array;
```

`null` from the parser means malformed — traced and dropped, never thrown, the same contract as
`decodeHeader` and `parseBind` and for the same reason: a client cannot correct a host, and an
exception would surface to the operator as a program check the host never caused.

**Order is preserved from the request**, because the reply in the trace lists the three uservars in
exactly the order asked. A `Map` is the right carrier for the lookup and the wrong one for the
output.

### 2. The device-name template, `packages/core/src/devname.ts`

Small and separate, because it is the one piece with *state* — a counter — and keeping it out of the
pure reply builder is what lets the builder stay pure.

```ts
export class DeviceName {
  constructor(template: string);
  /** The next candidate. Increments up to the template's maximum, then repeats it. */
  next(): string;
}
```

`foo===` → `foo001`, `foo002`, … `foo999`, then `foo999` forever. A template with no trailing `=`
is a fixed string and `next()` returns it unchanged — which is the sensible reading of
`-devname MYLU` and is what x3270's arithmetic does when `sub_length` is 0.

### 3. Escaping

Any byte of a name or value equal to `VAR`, `VALUE`, `ESC` or `USERVAR` (0, 1, 2, 3) is prefixed
with `ESC` on the way out, and an `ESC` on the way in means "the next byte is literal". x3270 does
this in `escaped_len` (`telnet_new_environ.c:105`) and `escaped_copy` (`:118`).

**In practice no realistic device name contains those bytes**, so this is a correctness rule with no
reachable test from the trace collection. **Implement it and say in the test that it is unwitnessed**
— the alternative is a silent corruption on the one host that does something unusual, and this
project's habit is to record what has no witness rather than to skip it. Round-trip it against our
own parser, which is a real property even without a host.

### 4. The telnet layer

`onDo` gains a conditional-option branch for 39, **modelled on the existing TN3270E one at
`telnet.ts:410-420`** — that branch exists precisely because option 40 is conditional where `DESIRED`
is a constant set, and 39 has the same shape: we only want it if a device name or user was
configured. Without one, answer `WONT` and the whole feature stays dark.

`onWill` must answer **`DONT`** for 39. NEW-ENVIRON is something *we* do; a host offering to do it is
refused, and that already happens via `onWill`'s catch-all. **Assert it** rather than assume — the
`WONT TN3270E` bug (`e789b4f`) was exactly a missing case for an option in the wrong direction, and
it is the third of that shape on this project.

Subnegotiations for 39 reach `handleSubnegotiation`, which already dispatches on `this.sb[0]`.

### 5. Front ends

`-devname NAME` in all four parsers, single-dashed like `-model`, `-tn3270e`, `-bind-image`. Threads
through `defaultSession` as a `SessionOptions.devname`. Task 11 of the bind-image plan did this exact
shape for two flags; follow it, and **match each parser's own idiom** rather than pasting one form
four times — `packages/web/src/args.ts` uses a `value(args, i, a)` helper and `continue`, the others
a `switch` with `i += 1`.

`USER` comes from `$USER`, then `$USERNAME`, then the literal `UNKNOWN` — x3270's order
(`telnet_new_environ.c:221-228`; it consults its own `host_user` and `appres.user` first, which we
have no equivalent of). **Note the privacy consequence and do not skip it:** this puts the
local account name on the wire to any host that asks. x3270 does it unconditionally; we should too,
for compatibility, but it belongs in the README's own words rather than discovered from a trace.

## Verification

**The payoff, and it is measurable rather than asserted:** `drive-playback.py` gains up to four
cases. `devname_success.trc` should reach well past where `sscp-lu-data.trc` stops — it negotiates
NEW-ENVIRON, TN3270E with BIND-IMAGE, and receives a real BIND (PLU `IBM0SMAJ`, MaxSec-RU 1024,
MaxPri-RU 3840, default 24x80, alternate 43x80). **Do not assert a block count that has not been
observed**; run it, read the output, pin what you saw.

Three ways that harness fakes a pass, all still live and all previously measured: `playback` **exits
0 whether or not it matched anything** (`playback.c:373` is literally `exit(0); /* needs to be
smarter */`) so assert on `Matched N bytes`; 16 of 71 traces have no emulator side; and **a trace
records one client version, not a spec**. Also: playback never `fflush`es its readiness line, so
waiting for it on a pipe hangs forever — use the existing log-file mechanism, do not add a probe.

Unit tests, each **mutation-checked** — a test that cannot be made to fail does not count, and on the
bind-image branch two of four mutations survived the first draft of one commit's tests:

- the three-uservar request from the trace, byte for byte, reply in the order asked
- a request for one named uservar
- a request for a **whole group** (empty name) — x3270 dumps every variable in that group
- a request for a variable we do not have: x3270 emits the name with **no VALUE**, which is
  distinguishable from an empty value; pin that
- `VAR` versus `USERVAR` lookups do not cross
- malformed bodies return `null`: truncated, a bad group code, a name with no terminator
- `DeviceName`: `foo===` → `foo001`; the 999 ceiling repeats rather than wraps; `foo=` → 1 digit;
  a template with no `=` is fixed; **the first call yields `001`, not `000`**
- escaping round-trips a name containing 0x00-0x03, marked as unwitnessed by any host
- option 39: `DO` → `WILL` when configured, `DO` → `WONT` when not, `WILL` → `DONT`

## Risks

**A flipped default's blast radius.** If accepting option 39 is made unconditional, every existing
test that asserts our full negotiation byte sequence changes. Making it **conditional on `-devname`
or `USER` being configured** keeps it dark by default, which is both the safer default and the
smaller diff — but **measure it rather than assuming**, exactly as the BIND-IMAGE flip was measured:
`grep` for the tests that pin negotiation bytes, run the suite, and read each failure before
touching it. Three tests **lost their subject** in the BIND-IMAGE flip (all using BIND-IMAGE as the
exemplar of an illegally-added function) and my grep missed a whole test file, because it referenced
the constant by a different name.

**The traces may not be fully drivable even with this built.** `devname_success.trc` also negotiates
TN3270E and receives a BIND, which we now handle — but it may depend on something else unimplemented.
**Check before promising four cases**; the original estimate of this feature was wrong precisely
because the trace was not read first. If a trace turns out undrivable, say which and why, and do not
force it.

**Scope creep toward LU names.** `-devname` and TN3270E `CONNECT` both name a session, and it will be
tempting to unify them. They are different protocols with different hosts; keep them apart.
