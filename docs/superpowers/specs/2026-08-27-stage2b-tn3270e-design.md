# Stage 2b — TN3270E proper

Design, 2026-08-27. Roadmap item 1: the TN3270E telnet option (40), DEVICE-TYPE and
FUNCTIONS subnegotiation, the 5-byte data header, response handling and LU selection.

Primary sources: `~/3270/ref/rfc2355.txt` (RFC 2355, June 1998) and x3270 4.5ga6 at
`~/src/suite3270-4.5/Common/telnet.c`. Every wire constant below was read out of one of
those two, and every transcript was captured off the wire from real s3270 during this
design session. Where this document states a byte, it was measured or quoted, not
recalled — see `verify-wire-constants-against-sources`.

## The fact that shapes everything: this stage cannot be verified against a live host

**Neither available Hercules system offers TN3270E.** Measured 2026-08-27 by completing
full telnet negotiation against both and logging every option:

```
VM/370 :3270    IAC DO TERMINAL-TYPE -> WILL -> SB TERMINAL-TYPE SEND -> IS IBM-3278-2-E
                IAC WILL BINARY / DO BINARY / WILL EOR(25) / DO EOR(25) -> IAC EOR
                953 bytes.  Option 40 never mentioned.
MVS TK5 :3271   identical sequence, 2901 bytes.  Option 40 never mentioned.
```

Tried with the client both accepting and refusing TN3270E; the option never appears
either way, because the host never asks. This confirms from the other direction what the
handoff already recorded as an absence (`zero fffb28/fffd28 in any successful run`) — but
an absence measured by a probe that *can* report the presence is worth more than one that
cannot. See lesson 7 in `docs/HANDOFF.md`.

A correction that belongs here, since it is cited elsewhere as a measured fact:
`packages/cli/src/tls.ts:35` says Hercules writes `IAC DO TN3270E`. It does not. It writes
`IAC DO TERMINAL-TYPE` — `ff fd 18`, option 24, not 40. The TLS-hang mechanism that
comment describes is unaffected (OpenSSL reads the leading `0xff` as a record content type
either way), but the option name is wrong and should be fixed.

Stages 1, 2a, TLS and IND$FILE were all proven against a real host. **2b cannot be**, so
its verification story is deliberately different, and is set out under *Testing* below.
The user is arranging access to a real z/VM or z/OS system; this design is written so that
live verification becomes a drop-in step rather than a rewrite.

## Reference transcript, captured from real s3270

An in-repo TN3270E server was stood up and `s3270 -model 3278-2 C:127.0.0.1:PORT` pointed
at it. This is the complete negotiation, byte for byte, and it is the golden data for the
unit tests:

| direction | meaning | bytes |
|---|---|---|
| server → | `IAC DO TN3270E` | `ff fd 28` |
| ← client | `IAC WILL TN3270E` | `ff fb 28` |
| server → | `IAC SB TN3270E SEND DEVICE-TYPE IAC SE` | `ff fa 28 08 02 ff f0` |
| ← client | `IAC SB TN3270E DEVICE-TYPE REQUEST IBM-3278-2-E IAC SE` | `ff fa 28 02 07 49 42 4d 2d 33 32 37 38 2d 32 2d 45 ff f0` |
| server → | `IAC SB TN3270E DEVICE-TYPE IS IBM-3278-2-E CONNECT TESTLU01 IAC SE` | `ff fa 28 02 04 49 42 4d 2d 33 32 37 38 2d 32 2d 45 01 54 45 53 54 4c 55 30 31 ff f0` |
| ← client | `IAC SB TN3270E FUNCTIONS REQUEST BIND-IMAGE RESPONSES SYSREQ CONTENTION-RESOLUTION IAC SE` | `ff fa 28 03 07 00 02 04 05 ff f0` |
| server → | `IAC SB TN3270E FUNCTIONS IS RESPONSES SYSREQ IAC SE` | `ff fa 28 03 04 02 04 ff f0` |
| ← client | *nothing* — negotiation is complete and the client waits for data | |
| ← client | inbound record after `String(HI)` `Enter` | `00 00 00 00 00` + `7d 40 c2 c8 c9` + `ff ef` |

s3270's own trace corroborates the last two rows: `TN3270E option negotiation complete.`,
`Now operating in connected-tn3270e mode.`, `SENT TN3270E(3270-DATA NO-RESPONSE 0)`.

**THE OPERAND ORDER IS ASYMMETRIC, AND GETTING IT WRONG IS SILENT.** The server sends
`SEND DEVICE-TYPE` — `08 02`, the verb first. The client replies `DEVICE-TYPE REQUEST` —
`02 07`, the noun first. The first attempt at this harness sent `02 08` and s3270 answered
by logging `RCVD SB TN3270E DEVICE-TYPE ??8 SE` and then saying nothing at all: no reject,
no error, just a stall. x3270 confirms the layout — at `telnet.c:2199` the test is
`sbbuf[2] == TN3270E_OP_DEVICE_TYPE`, so `sbbuf[1]` is the verb and `sbbuf[2]` the noun.
A test must pin both orders in both directions.

Note also that s3270 requests `IBM-3278-2-E` in DEVICE-TYPE even though it was started as
`-model 3278-2`, consistent with the note in the alternate-screen-size work that x3270
builds one terminal-type string for both the TERMINAL-TYPE reply and the DEVICE-TYPE
request (`telnet.c:2096,2122,4107`).

## Wire constants

From RFC 2355 §3 (`rfc2355.txt:317-347`). All values hexadecimal.

```
option                TN3270E          40 (0x28)

subnegotiation ops    ASSOCIATE        00     IS               04
                      CONNECT          01     REASON           05
                      DEVICE-TYPE      02     REJECT           06
                      FUNCTIONS        03     REQUEST          07
                                              SEND             08

reason codes          CONN-PARTNER     00     TYPE-NAME-ERROR  05
                      DEVICE-IN-USE    01     UNKNOWN-ERROR    06
                      INV-ASSOCIATE    02     UNSUPPORTED-REQ  07
                      INV-NAME         03
                      INV-DEVICE-TYPE  04

functions             BIND-IMAGE       00     SCS-CTL-CODES    03
                      DATA-STREAM-CTL  01     SYSREQ           04
                      RESPONSES        02     CONTENTION-RESOLUTION 05 *

data types            3270-DATA        00     NVT-DATA         05
                      SCS-DATA         01     REQUEST          06
                      RESPONSE         02     SSCP-LU-DATA     07
                      BIND-IMAGE       03     PRINT-EOJ        08
                      UNBIND           04

REQUEST-FLAG          ERR-COND-CLEARED 00

RESPONSE-FLAG   on 3270-DATA/SCS-DATA:  NO-RESPONSE 00, ERROR-RESPONSE 01,
                                        ALWAYS-RESPONSE 02
                on RESPONSE:            POSITIVE-RESPONSE 00, NEGATIVE-RESPONSE 01
```

`*` **CONTENTION-RESOLUTION (05) is not in RFC 2355.** x3270 requests it
(`telnet.c:953`) from a later extension. We do request it, matching x3270, but nothing in
this stage depends on a host granting it.

## Scope

Requested functions: **RESPONSES (02), SYSREQ (04), CONTENTION-RESOLUTION (05).**

**BIND-IMAGE is deliberately not requested**, and the reason is a measured hazard rather
than cost. With BIND-IMAGE granted and no BIND subsequently sent, s3270 **never enters
3270 mode**: an Erase/Write was delivered and ignored, and `Wait(3270Mode,10)` timed out.
Granting it *and* sending a BIND works, and denying it works; only the advertise-then-stay-
silent case hangs. x3270's rule is at `telnet.c:2339` — if the host does not support
BIND-IMAGE, go straight to 3270 mode — so declining to ask is what keeps a server from
being able to put us in that state at all. Three runs, all three reproducible:

| granted functions | BIND sent | client reaches 3270 mode |
|---|---|---|
| BIND-IMAGE, RESPONSES, SYSREQ | no | **no** — write ignored, timeout |
| RESPONSES, SYSREQ | n/a | yes — inbound `00 00 00 00 00 7d 40 c2 c8 c9` |
| BIND-IMAGE, RESPONSES, SYSREQ | yes | yes — identical inbound record |

BIND-IMAGE also drags in `bindLimit` (`telnet.c:2526`), where a BIND carrying screen
dimensions can override geometry — which would interact with the default/alternate size
work merged in `a546d1f`. That interaction deserves its own stage.

`SCS-CTL-CODES` and `DATA-STREAM-CTL` are printer-session functions by definition
(RFC 2355 §7.2.2), so they belong to roadmap item 7 and are out of scope here. That seam is
structural, not a deferral of convenience.

Also out of scope: parsing a BIND image, `bindLimit` geometry, SCS, and NVT mode beyond
decoding `NVT-DATA` as a data type.

## Architecture

A new core module `packages/core/src/tn3270e.ts`, holding a **pure state machine** — bytes
in, decisions and bytes out, no socket. This is what made stages 1 and 2a testable at all
and the pattern is unchanged.

Exports:

- `negotiate(state, sbPayload) -> { next, reply?, effect? }` — DEVICE-TYPE and FUNCTIONS
  subnegotiation. `effect` is how completion, backoff and LU assignment reach the session
  without the module knowing what a session is.
- `encodeHeader(fields) -> Uint8Array` and `decodeHeader(bytes) -> fields | null` — the
  five-byte header, decoding to `null` on a short record so the caller decides.

Touch points, deliberately small:

- `packages/core/src/telnet.ts` — option 40 currently falls into the catch-all at
  `telnet.ts:281`. It gains an arm that answers `WILL` when enabled and routes SB payloads
  to the new module.
- `packages/core/src/session.ts` — holds the negotiated state and submode, and wraps
  outbound records with a header when TN3270E is in effect.
- `packages/core/src/stream/execute.ts` — the program-check paths become the source of
  negative-response sense codes. The comment already there at `execute.ts:309` anticipates
  exactly this.
- `packages/cli/src/main.ts` and `packages/tui/src/main.ts` — the `-tn3270e on|off` flag
  and LU parsing in the host string.

## Negotiation state machine

1. `DO TN3270E`, and the option is enabled → `WILL TN3270E`. Disabled → `WONT TN3270E`.
2. `SB SEND DEVICE-TYPE` (`08 02`) → `SB DEVICE-TYPE REQUEST <terminal-type>` (`02 07`),
   with `CONNECT <lu>` (`01`) appended when an LU was named.
3. `SB DEVICE-TYPE IS <type> [CONNECT <name>]` → record both, then send
   `FUNCTIONS REQUEST 02 04 05`.
4. `SB FUNCTIONS IS <list>` → if the list adds nothing beyond what we asked for, adopt it
   and complete. **If it added anything, back off** — x3270 calls this "Host illegally
   added function(s)" (`telnet.c:2327`).
5. `SB FUNCTIONS REQUEST <list>`, host-initiated → if it adds nothing, adopt it, reply
   `FUNCTIONS IS`, complete. Otherwise reply `FUNCTIONS REQUEST` with the intersection
   (`telnet.c:2298-2311`).
6. `SB DEVICE-TYPE REJECT REASON <code>` → on `UNSUPPORTED-REQ` back off; otherwise try
   the next LU, and back off once the list is exhausted (`telnet.c:2261-2277`).
7. **Backoff** → send `WONT TN3270E`, discard all TN3270E state, restore the LU list, and
   continue as traditional tn3270. Modelled on `backoff_tn3270e`. This is what makes
   on-by-default safe: a host that dislikes the option degrades instead of failing.

On completion the session enters **3270 submode immediately**, because BIND-IMAGE was not
requested. A **null function list is legal** — RFC 2355 §9 calls it "basic TN3270E" — and
must complete negotiation rather than being treated as an error.

Observed and required: when the server's `FUNCTIONS IS` is an acceptable subset, the
client sends **nothing** in reply. A test must assert that silence; an implementation that
echoes `FUNCTIONS IS` back would still appear to work against a tolerant server.

## Binary and EOR are implied, and this breaks the existing mode gate

**RFC 2355 §4 (`rfc2355.txt:376-382`): TN3270E implies binary and EOR without negotiating
them.** "Note that while they are not explicitly negotiated, the equivalent of the Telnet
Binary Transmission Option and the Telnet End of Record Option is implied in the
negotiation of the TN3270E Option. That is, a party to the negotiation that agrees to
support TN3270E is automatically required to support bi-directional binary and EOR
transmissions."

Confirmed on the wire during this design session: the harness sent **only** `IAC DO
TN3270E` — never BINARY, never EOR — and real s3270 still entered 3270 mode and framed its
inbound record with `IAC EOR`.

Our `is3270Mode()` (`telnet.ts:93-99`) requires BINARY **and** EOR agreed in both
directions. Against such a host it is `false` for the entire session, and then
`storeRecordByte` (`telnet.ts:249`) drops every inbound data byte while `flushRecord`
(`telnet.ts:332`) discards the accumulator on every `IAC EOR`. **A fully negotiated
TN3270E session would render nothing at all**, with a trace full of `EOR received outside
3270 mode` — a symptom that looks like a parser fault and is not one.

So the gate gains a second route: 3270 mode when TN3270E negotiation has **completed**, or
when BINARY and EOR are agreed the classic way. Completion, not merely agreeing option 40 —
during DEVICE-TYPE and FUNCTIONS there is no datastream yet, which is the distinction
s3270 draws between its `connected-unbound` and `connected-tn3270e` states.

This was found while writing the implementation plan rather than during the design proper,
and it is recorded here because it is a protocol fact, not an implementation detail.

## Header codec

Outbound, per `telnet.c:3336-3352`:

- DATA-TYPE `0x00` (3270-DATA) in 3270 submode, `0x07` (SSCP-LU-DATA) otherwise.
- REQUEST-FLAG `0x00`, RESPONSE-FLAG `0x00`. The client sends NO-RESPONSE on its own data.
- SEQ-NUMBER two bytes big-endian, incremented `& 0x7fff` **only when RESPONSES was
  agreed**, and pinned to `0x0000` when it was not (RFC 2355 §8.1.4).

Inbound: dispatch on DATA-TYPE. `3270-DATA` to the existing executor; `RESPONSE`,
`UNBIND`, `NVT-DATA` and `SSCP-LU-DATA` handled; `BIND-IMAGE` and `PRINT-EOJ`
**traced and dropped, not silently ignored** — they are out of scope, and a counter is how
we would find out a real host sends them.

**THE HEADER IS DATA, SO 0xff INSIDE IT MUST BE DOUBLED.** RFC 2355 §8.1.4 is explicit:
"If either byte contains a 0xff, it should be doubled to 0xffff before sending and stripped
back to 0xff upon receipt; this is standard IAC escaping." Because we request RESPONSES the
sequence number increments, so `0x00ff` arrives after 255 records — reachable in a long
session, not a theoretical case. The header must therefore go **through** the existing
IAC-doubling path, not around it. This is the same escaped-byte class that has already
produced four defects in `telnet.ts` (see `docs/HANDOFF.md`, where escaped IACs bypassed
both accumulator ceilings and leaked a banner byte into the first real record), so it gets
an explicit test that drives the sequence number to `0x00ff` and asserts three bytes on
the wire.

## RESPONSES

Per RFC 2355 §10.4.1. On an inbound `3270-DATA` record:

- RESPONSE-FLAG `NO-RESPONSE` → send nothing.
- `ERROR-RESPONSE` and processing succeeded → send nothing.
- `ALWAYS-RESPONSE` and processing succeeded → `RESPONSE` / `POSITIVE-RESPONSE`, data
  `0x00`.
- `ALWAYS-RESPONSE` or `ERROR-RESPONSE` and processing failed → `RESPONSE` /
  `NEGATIVE-RESPONSE`, data `0x00` for an invalid command (Command Reject) or `0x02` for an
  illegal buffer address or order sequence (Operation Check).

SEQ-NUMBER in a response is **copied** from the message being answered, never generated.
The `0x01` and `0x03` sense codes are printer conditions and are not reachable here.

The negative-response mapping is wired to the program-check paths that already exist, so
this function is mostly a matter of routing an existing signal rather than new analysis.

## CLI surface

TN3270E is **on by default**, matching x3270, and safe because of the backoff path. Against
the two Hercules hosts the code never fires, since neither offers the option.

| form | effect |
|---|---|
| *(none)* | TN3270E offered; falls back to traditional tn3270 on refusal or reject |
| `-tn3270e off` | never accept option 40 |
| `-tn3270e on` | the default, stated explicitly |
| `N:host` | s3270's spelling for off; accepted and stripped |
| `[LUname@]host[:port]` | request that LU via `CONNECT` |
| `LU1,LU2@host` | try each in order as `REJECT`s come back |

`N:` is accepted-and-stripped for the same reason `L:` is under TLS: s3270 users have the
prefix in their muscle memory, and the flag is the discoverable form. `NON_TN3270E_HOST`
is `split_host.h:38`, gating option 40 at `telnet.c:1842,1915`. The LU syntax is s3270's
documented `[prefix:][LUname@]hostname[:port]`, comma-separated because `setup_lus` and
`next_lu` walk the list on rejection.

Asking for `-tn3270e on` together with `N:` is an error rather than a silent resolution,
following the precedent set by `L:` alongside `-insecure`.

## Testing

Three layers, because there is no live host. The layering is the point: each one is
checked by something that does not depend on our client being right.

**1. Unit tests over the pure state machine.** The captured s3270 transcript above is the
golden data, byte for byte. Required cases: each of the seven transitions; the null
function list; a `FUNCTIONS IS` that adds a function, asserting backoff; each reject
reason; LU list exhaustion; the silence after an acceptable `FUNCTIONS IS`; both operand
orders, including `02 08` as a negative test since that is the mistake that was actually
made; and the sequence number at `0x00ff` asserting three bytes on the wire.

**2. `packages/cli/scripts/e-server.mjs`** — an in-repo TN3270E server, following the
`tls-proxy.mjs` precedent of building the counterparty rather than installing one.
**It must be validated against real s3270 before it is trusted**: the harness has to drive
s3270 into 3270 mode and back, on the same three BIND-IMAGE configurations tabulated
above, and that result is committed alongside it. Only then is it used against our client.

This inversion is the whole verification argument. A harness that has never been shown to
satisfy a known-good client proves nothing about ours — when our client failed against it
we would not know which side was wrong, which is the mistake `docs/HANDOFF.md` lesson 8
records at length ("a mimic of the real system is a hypothesis, not evidence"). Validating
against s3270 first is what converts the harness from mimic to instrument. It remains a
weaker claim than a live host, and the README should say so in those words.

The harness is also a prerequisite for the printer session (item 7), so it is not
scaffolding built only for this stage.

**3. A recorded probe for the future real host.** Committed as a script plus a checklist in
`docs/live-testing.md`, listing the things only a real z/VM or z/OS can answer:

- Does it send `FUNCTIONS REQUEST` itself rather than waiting for ours? Transition 5 is
  implemented from x3270's source and has never been exercised by a real server.
- Does it ever send `ALWAYS-RESPONSE`? Until one does, the entire positive-response path is
  unit-tested only — the same honest position that retransmit ended up in.
- Does it send a BIND we are declining to ask for, and does it assign an LU we did not
  request?
- Does `-tn3270e off` still reach a usable session there?

Record the answers against this spec rather than in a session note, and treat a stated
scope here as open: see the roadmap discipline in `docs/HANDOFF.md`.

## Success criteria

- Full negotiation against `e-server.mjs`, reaching 3270 submode and round-tripping an
  Erase/Write and an Enter.
- Our `DEVICE-TYPE REQUEST` bytes byte-identical to s3270's captured bytes; our
  `FUNCTIONS REQUEST` identical except for the deliberately omitted BIND-IMAGE.
- `-tn3270e off` produces a session byte-identical to today's against both Hercules hosts,
  proving the stage is a strict addition.
- A host that refuses option 40 still reaches a working session — the backoff path, tested
  by a harness that rejects.
- `npm test`, `npm run typecheck`, `npm run build` clean, and `pty-smoke.py` still 12/12.
