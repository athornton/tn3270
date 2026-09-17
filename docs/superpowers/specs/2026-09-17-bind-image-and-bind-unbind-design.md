# BIND-IMAGE, BIND and UNBIND — design

**Date:** 2026-09-17
**Status:** designed, not implemented
**Baseline:** `main` at `d030b64`, 1733 tests in 71 files, the only branch, tree clean.

## Why now, and what changed

BIND-IMAGE was **deferred, not rejected**, and the reason it was deferred has collapsed
under measurement. The comment at `packages/core/src/tn3270e.ts:95` records the hazard: grant
BIND-IMAGE and send no BIND, and real s3270 never enters 3270 mode — an Erase/Write is
delivered and ignored, `Wait(3270Mode)` times out. Not asking was what made that state
unreachable.

**The hazard is theoretical on real hosts. 29 of 29 hosts in x3270's own trace collection
that grant BIND-IMAGE send a BIND immediately after FUNCTIONS**, measured by bytes across all
71 traces. The grant-then-stay-silent case exists only in our own `e-server.py`, which we
configured to do it deliberately.

Counting that required care, and the trap generalises: grepping for `^< BIND` gave a **false**
"two hosts granted and sent no BIND", because older traces carry no decoded annotation lines.
**Count by bytes, not by annotations.**

Three things make this worth doing before `IBM-DYNAMIC`:

1. It unblocks the playback oracle past FUNCTIONS in all 46 traces that have an emulator side.
2. `devname_success.trc` contains a **real BIND from a real host**, so BIND parsing gets a
   host-free witness on day one. BIND/UNBIND has never had a witness of any kind — both
   Hercules hosts answer `ff fe 28`, and z/VM 4.4 withdraws the option after our
   DEVICE-TYPE REQUEST.
3. **BIND is the second channel by which a host dictates geometry**, the other being Query
   Reply. That is why it belongs immediately before `IBM-DYNAMIC` rather than after it.

## Decisions taken by the user, 2026-09-17

All four were asked as questions and answered explicitly. They are recorded here because a
later reader will otherwise assume the x3270 default was copied.

1. **A timeout, not a silent hang.** "I prefer a timeout to a silent hang." x3270 waits
   forever; we do not.
2. **Parse-and-honour, not parse-and-log.** BIND may resize the screen mid-session, and that
   blast radius is accepted.
3. **Pre-BIND 3270 data is RETAINED and executed if the timeout fires** — not dropped as
   x3270 drops it. A timeout that discarded the frame would recover the session and still
   leave a blank screen, which is a quieter failure than the hang it replaces.
4. **BIND-IMAGE is requested by DEFAULT, with `-bind-image off` to disable.** A flag nobody
   sets is a feature nobody tests, and the residual risk is covered by the timeout.
5. **Range-check by default, `-bind-limit off` to honour anyway.** x3270's own spelling and
   polarity.
6. **The timeout is 5 seconds**, and the reason is not margin-for-its-own-sake: most users
   will be on Hercules, but **P/370 and real 370-class hardware are still out there and are
   slow**. A 2s timeout would punish exactly the users who have no other working client.

## Scope

**In:** requesting the BIND-IMAGE function; parsing BIND and UNBIND; honouring BIND geometry
within limits; gating 3270 data until bound, with the recovering timeout.

**Out, deliberately:** oversize and `IBM-DYNAMIC` (the next feature — and the range-check is
what keeps this one from silently becoming it, since growing past `-model` is precisely
`IBM-DYNAMIC`'s job); the printer session; SNA responses beyond what already exists.

## A naming trap, pinned before it bites

**`BIND_IMAGE` is `0x00` as a negotiable function and `0x03` as a data type.** Both constants
already exist in `constants.ts` (`Tn3270eFunc.BIND_IMAGE: 0x00`, `Tn3270eDataType.BIND_IMAGE:
0x03`) and both are correct. Any code or test that reaches for "the BIND-IMAGE constant" must
say which. `UNBIND` is a data type only (`0x04`), with no function bit of its own — it is
gated on the BIND-IMAGE **function**.

## Architecture

Four pieces, in the order a session meets them.

### 1. Negotiation — `packages/core/src/tn3270e.ts`

`REQUESTED_FUNCTIONS` gains `Tn3270eFunc.BIND_IMAGE`. The requested set becomes
BIND-IMAGE, RESPONSES, SYSREQ, CONTENTION-RESOLUTION.

The long comment explaining BIND-IMAGE's absence is **replaced by the measurement that
retired it**, not deleted. The hazard is still real in `e-server.py` and the reasoning is why
we know it is theoretical elsewhere; a future reader who deletes the timeout needs to find
that argument, not a bare list of function names.

`-bind-image off` removes it from the request. The `addsNothing` check already refuses a host
that grants what we did not ask for, so `-bind-image off` plus a host that forces BIND-IMAGE
still backs off — that path needs no change and gets a test.

### 2. Parsing — a pure function

`parseBind(body: Uint8Array): BindImage | null`, pure and separately testable, matching how
the whole negotiation state machine is already pure.

Offsets, from `include/3270ds.h:433-443` (verified in the source, not recalled):

| field | offset | notes |
|---|---|---|
| `BIND_RU` | 0 | must be `0x31`, else not a BIND |
| MAXRU secondary | 10 | through x3270's `maxru()` decode |
| MAXRU primary | 11 | ditto |
| rows default | 20 | `RD` |
| cols default | 21 | `CD` |
| rows alternate | 22 | `RA` |
| cols alternate | 23 | `CA` |
| size code | 24 | `SSIZE`, table below |
| PLU name length | 27 | capped at 8 |
| PLU name | 28 | EBCDIC |

`maxru(c)`: zero unless the high bit is set, else `((c >> 4) & 0x0f) * (1 << (c & 0xf))`
(`telnet.c:2440`).

The size code (`telnet.c:2485-2521`):

| code | default | alternate |
|---|---|---|
| `0x00`, `0x02` | 24x80 | 24x80 |
| `0x03` | 24x80 | **ours**, from `-model` |
| `0x7e` | bytes 20-21 | **same pair again** |
| `0x7f` | bytes 20-21 | bytes 22-23 |
| anything else | no dimensions present | — |

**Every read is length-guarded and a malformed BIND returns `null` rather than throwing** —
the same discipline as `decodeHeader`, and for the same reason: a client cannot correct a
host, and an exception here would surface to the operator as a program check the host never
caused. Note x3270 checks `buflen > OFFSET`, not `>=`, and the distinction matters at every
boundary.

### 3. Geometry — a narrow new mutator on `Screen`

`Screen.defaultSize` and `Screen.alternateSize` are **`readonly` today** (`screen.ts:125-128`)
and BIND rewrites both. So parse-and-honour needs a new mutator; a `resize()` call cannot
express it, because `resize` switches the *current* geometry between two fixed sizes while
BIND changes what those two sizes *are*.

The mutator is deliberately narrow, and BIND/UNBIND are its only callers. After it runs,
Erase/Write and Erase/Write Alternate continue to mean what they meant.

Range-check, per `telnet.c:2523-2556`, when `-bind-limit` is on (the default, matching
`appres.bind_limit = true` at `glue.c:458`):

- default rows/cols greater than the model's max → refuse
- default rows/cols less than 24x80 → refuse
- alternate rows/cols greater than the model's max → refuse
- alternate rows/cols less than 24x80 → refuse

Any failure keeps **our** geometry entirely. x3270 pops up an error; we trace and set OIA
text.

**A consequence worth stating, because it is counterintuitive and will otherwise read as a
bug:** since the upper bound is the model's size and the lower is model 2, a **model-2
client's BIND geometry is pinned to exactly 24x80** — every other value is refused. With
`-bind-limit` on, BIND can only ever narrow a large model toward 24x80; it can never grow you
past what `-model` already advertised. It is a safety rail, not a capability. `-bind-limit
off` honours whatever arrives, bounded only by the 14-bit addressing limit
(`MAX_ROWS_COLS = 0x3fff`, which `address.ts` already handles).

UNBIND (`telnet.c:2745`) reverts to the `-model` values, clears bound state, erases, and
awaits another BIND. Its reason byte has ~11 values; **`BIND_FORTHCOMING` means another BIND
is coming**, which is how a host hands you between applications. Both BIND and UNBIND erase
the screen, as x3270 does (`ctlr_erase(false)`).

### 4. The gate and the recovering timeout — `session.ts`

With the BIND-IMAGE function granted and no BIND yet, x3270 `return 0`s on a `3270_DATA`
record (`telnet.c:2681`) — it **discards it, silently**. That discard *is* the measured hang
recorded at `tn3270e.ts:95`.

Ours instead:

- **Retain** the most recent pre-BIND `3270_DATA` record, and start a 5-second timer.
- **BIND arrives:** cancel the timer, apply geometry, execute the retained record at the new
  geometry.
- **Timer expires:** execute the retained record at our own geometry, trace it, and set OIA
  text.

Only the most recent record is retained, not a queue: a host that sends several screens
before binding has painted over its own earlier ones anyway, and an unbounded queue is a
memory hole a remote party controls.

**The timeout must be diagnosable, not merely survivable.** It is *evidence about the host* —
a live run has to be able to tell "the BIND never came" from "a BIND came and we ignored
it", and "nothing visible happened" cannot distinguish a working path from an inert one. That
is the Sys Req lesson applied before the fact.

The 5-second value is a **named exported constant**, documented as tunable in the README —
the person who needs it longer is running vintage iron and is the least likely to be reading
our source.

### Where the code lives

`tn3270e.ts` is 328 lines and takes `parseBind`. `session.ts` is **896 lines, the largest
module in core**, and takes the gate, the timer and the geometry application. **If the
session-side additions exceed roughly 60 lines, extract `packages/core/src/bind.ts`** rather
than grow the biggest file further.

## What does NOT change, verified by reading the front ends

**No front-end changes, and no new event.** A BIND-driven resize rides the existing `'screen'`
event and the existing repaint path, because **EWA already changes geometry mid-session** and
both renderers already cope:

- **GUI** calls `win.setContentSize` from **every** draw list, not just the first
  (`packages/gui/src/main.ts:312`), so the window follows whatever geometry the frame carries.
  `packages/web` shares that same `renderer.ts` unmodified.
- **TUI** already compares the *screen* size against its own record independently of the
  terminal size (`packages/tui/src/app.ts:353`) and already suspends with "terminal too
  small" rather than clipping.

The one thing to verify by **running** rather than reading: the TUI's suspend path triggered
by a BIND rather than by a terminal resize. `pty-smoke.py` already covers shrink-below-24-rows,
so the mechanism has a harness.

## Verification

**The playback oracle is the payoff.** `drive-playback.py` stops at FUNCTIONS on every trace
today. With BIND-IMAGE granted it proceeds, and `devname_success.trc` carries a real BIND from
a real host — a host-free witness for BIND parsing on day one.

Three ways that harness can fake a pass, all previously measured and all still live:
`playback` **exits 0 whether or not it matched anything** (`playback.c:373` is literally
`exit(0); /* needs to be smarter */`) so assert on `Matched N bytes`, never the return code;
16 of 71 traces have no emulator side at all; and **a trace records one client version, not a
spec**.

Unit tests, each **mutation-checked** — the keypad branch shipped fourteen tests that passed
while proving nothing, so a test that cannot be made to fail does not count:

- each size code, including `0x03`'s "our alternate" case and `0x7e`'s duplicated pair
- range-check boundaries: exactly 24x80, one under, model max, one over — default *and*
  alternate, since they are separate checks
- a malformed short BIND at each guarded offset returns `null`
- a BIND whose byte 0 is not `0x31`
- `maxru()`'s high-bit-clear zero case
- PLU name: EBCDIC decode, the 8-byte cap, a length byte that overruns the buffer
- UNBIND reverts geometry, and `BIND_FORTHCOMING` is distinguishable
- the gate retains a record and executes it on BIND at the **new** geometry
- the timeout fires, executes the retained record, and is observable
- `-bind-image off` omits the function; a host forcing it anyway still backs off
- `-bind-limit off` honours an out-of-range geometry

## Risks, to be measured rather than assumed

**The `FUNCTIONS REQUEST` bytes change**, so every test asserting them changes. That is a
feature — those tests exist to notice exactly this — but memory records the shape to watch
for: when the gateway's token default flipped, **one test went red with nothing left to
refuse**. A flipped default's blast radius includes tests that silently depended on the old
value. I will look for that shape specifically rather than updating expectations until green.

**`e-server.py` grants BIND-IMAGE and stays silent deliberately**, so `drive-e.py`'s
expectations shift — and that harness becomes our only way to *exercise* the timeout, which
makes it more valuable, not less. Its own history is the caution: it once scored a correct
refusal as FAIL, and its readiness probe was accepted as the client so the real client got
`ECONNREFUSED` while the log claimed success. **When a harness says the client is broken,
suspect the harness until it has satisfied a known-good client.**

**A live run cannot verify any of this**, and the record must say so plainly: no reachable
host completes a TN3270E negotiation. Both Hercules systems refuse option 40; z/VM 4.4 offers
it, asks `SEND DEVICE-TYPE`, then withdraws the option after our well-formed reply. The
witness here is a recorded real host, which is strictly better than `e-server.py` (written
from the RFC, so it can only check what we thought to encode) and strictly weaker than a live
session.
