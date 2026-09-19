# x3270 reference captures

**Status: three files, one of them a different kind from the other two.**

- `vm370-conformance-model2.trace` — a real s3270 capture against VM/370.
  `conformance.test.ts` picks up `*.trace` files here automatically and runs
  against this one, so the test is live rather than skipped.
- `tso-query-reply.txt` — **not** a conformance capture. It is the Read Partition
  (Query) / Query Reply exchange that s3270 performs with MVS 3.8j TK5's TSO. Query
  Reply landed in stage 2a, and a live GUI session has since logged on to TSO at 43
  rows — which TSO only reaches after this Query is answered — so this is kept as
  the byte-level reference for what a real, accepted answer looks like on this host,
  not as a description of a gap. The `.txt` extension is deliberate: it keeps this
  file out of the `*.trace` glob, because it is an excerpt of two records rather than
  a whole session and would be meaningless as a replay fixture.
- `sscp-lu-data.trc` — **not** a `conformance.test.ts` fixture either, and not
  captured against our own Hercules host: it is x3270's OWN shipped test trace
  (`s3270/Test/sscp-lu-data.trc` in the suite3270-4.5 source tree), copied here
  verbatim so `packages/cli/scripts/drive-playback.py` can replay it without
  requiring a hand-built suite3270 checkout for the trace itself (the `playback`
  binary that plays it back still has to come from such a checkout — see that
  script's `FIXTURES` comment). Recorded by x3270 v4.3pre1
  (`Command: x3270 -trace -geometry +64+19`) against x3270's own public local test
  target, `Common/Test/target/target.py`, listening on `localhost:8021` — confirmed
  by the "x3270 test target" banner text inside the trace itself. This is x3270's
  open-source test infrastructure, not a private or sensitive live host, and the
  file carries no typed credentials (grepped for `password`/`passwd`; the session
  never logs on to anything, it only reaches the test target's own service menu).
  Kept because it is the one trace among drive-playback.py's traces whose host
  grants BIND-IMAGE and sends a real BIND, giving BIND/UNBIND parsing a real-host
  witness that no other available trace provides (both Hercules test hosts refuse
  TN3270E option 40 outright, and public z/VM 4.4 withdraws it before negotiation
  completes). `devname_success.trc` was tried first and rejected as non-viable
  (NEW-ENVIRON, which we do not implement) — see drive-playback.py's `EXCLUDED`
  dict and the comment on this trace's `Case` for the measured reason.

## What belongs here

Each `*.trace` file is a trace of a real x3270/s3270 session, driving the **same
Hercules host** that our own fixtures in `packages/fixtures/traces/` were
recorded against, produced with the **same scripted command list** (a
`packages/cli/scripts/*.txt`-style file, or the s3270 equivalent) that
produced our fixture. The comparison in `conformance.test.ts` is only
meaningful if both clients did the same thing — a hand-driven x3270 session
typed differently from our own recording proves nothing.

`sscp-lu-data.trc` above is exempt from this rule the same way
`tso-query-reply.txt` is: it is not compared against one of our own recordings by
`conformance.test.ts`, it is replayed at our live client by
`drive-playback.py`/`playback -b`, so "same host, same script as our fixture"
does not apply — there is no "our fixture" on the other side of this one. Its
`.trc` extension (matching the extension x3270's own suite uses for these files)
keeps it out of the `*.trace` glob for the same reason `tso-query-reply.txt` uses
`.txt`, just via a different extension because this file is itself a foreign
trace format, not an excerpt of one of ours.

Every `.trace` file added here must ship together with:

1. The exact command script used to produce it (checked in alongside the
   trace, e.g. as a sibling file or a reference to the
   `packages/cli/scripts/*.txt` file it reused).
2. A one-line note (in this README or a per-file comment) of which host and
   OS build it was captured against, and on what date.

Example capture command, from the stage-1 plan (Task 17, Step 1):

```bash
# On the user's Mac, against the same Hercules host our own fixtures use:
s3270 -trace -tracefile /tmp/x3270-ref.trace HOST:PORT < packages/cli/scripts/record-mvs.txt
```

## Passwords must be redacted

These traces contain the same typed credentials as our own live-host
fixtures (see `docs/live-testing.md`) and are subject to the same rule:
**never commit a working password.** Before adding a capture here, find and
redact any record carrying a typed password the same way
`docs/live-testing.md` describes for `packages/fixtures/traces/` — replace
the specific sent record with a comment noting the redaction, not the whole
file, and note here that the fixture is therefore replay-only up to the
logon point.

## What a divergence means

When `conformance.test.ts` finds our outbound bytes differ from what x3270
sent for the same inbound trace, the difference is exactly one of three
things, and figuring out which one matters:

1. **Our bug.** Fix the code, and add a unit test in `packages/core/test/`
   that reproduces the specific record in isolation (not just relying on the
   conformance test to keep catching it).
2. **A legitimate, deliberate difference** — for example, x3270 supporting an
   extended attribute or order this stage 1 client intentionally defers.
   Document it in the design spec's deliberate-differences list
   (`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`) rather than
   changing code to hide it.
3. **A capture artifact** — the two sessions didn't actually do the same
   thing (different timing, a typo during a supposedly-scripted run, a stale
   command script that no longer matches what's checked in). Fix the capture
   procedure and re-record; do not touch the client code for this case.

**Do not "fix" a divergence by loosening the comparison** — widening the
negotiation exclusion, dropping a record from the comparison, or relaxing
`toEqual` to something fuzzier defeats the entire point of this harness, which
is to catch exactly this class of difference against a real reference
implementation.

## File format

Drop captures in **either** format; the harness sniffs and converts.

- **x3270 native** (`s3270 -trace -tracefile`): `< 0x0   f5c311...` — direction
  char, byte offset in hex, unspaced hex bytes, 32 per line. Note x3270's `<`
  means data x3270 **sent**; ours means received. `trace_netdata()` in
  `Common/telnet.c:3325` is the authority.
- **Ours** (`Trace.toText()` / the CLI's `Trace(on)`): `0.000 < f5 c3` — elapsed
  seconds, direction, spaced hex, 16 per line, `+` marking a continuation of one
  chunk.

`parseX3270Trace()` and `x3270TraceToOurs()` in `packages/core/src/x3270trace.ts`
handle the conversion. x3270's netdata lines carry byte offsets rather than
timestamps, so converted traces show `0.000` throughout — that is honest about
what the source file contains, not a bug.
