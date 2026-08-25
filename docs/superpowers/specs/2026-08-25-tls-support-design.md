# TLS Support — Design

Design settled 2026-08-25. Goal: **connect to a 3270 host over TLS, by default**, with
explicit opt-outs for the vintage systems that cannot do it at all.

**Why TLS defaults to on.** A 3270 client that speaks only plaintext is unusable against
anything currently supported by IBM, and a client that *can* do TLS but does not unless
asked will be used in plaintext by people who thought otherwise. The user's call, taken
2026-08-25: TLS on by default, `-insecure` to turn it off. That is a deliberate departure
from s3270 and is recorded as such below.

Prerequisite reading: `docs/live-testing.md` (host runbook). Reference implementation is
x3270's TLS glue at `~/src/suite3270-4.5/Common/sio_openssl.c` and its option table at
`Common/sio_glue.c`; option spellings are in `include/resources.h`.

## THE DEPARTURE FROM s3270, stated plainly

s3270 has this entire surface already, and we adopt its **spellings** while inverting its
**default**. Verified from source, not memory:

| s3270 | Where | Behaviour |
|---|---|---|
| `L:host:port` prefix | `Common/host.c:633` | this host is TLS |
| `-verifycert` / `-noverifycert` | `include/resources.h:595,583` | chain verification on/off |
| `verify_host_cert = true` | `Common/glue.c:489` | verification defaults **on** |
| `-cafile`, `-cadir` | `include/resources.h:518,517` | trust anchors |
| `-certfile`, `-keyfile`, `-clientcert` | `include/resources.h:521,547,526` | client certificate |
| `-accepthostname` | `include/resources.h:511` | verify chain, accept a name mismatch |

So in s3270, **verification** is on by default but **TLS itself is off** unless the host
carries `L:`. We keep verification-on and make TLS-on the default too.

Consequence for the conformance harness: any comparison against s3270 must pass
`-insecure` on our side, or drive s3270 with `L:` on its side. A conformance run that
forgets this compares a TLS client against a plaintext one and the diff is meaningless: it
would pass while covering nothing.

## THE TRAP THAT SHAPES THE WHOLE FEATURE: a plaintext host does not fail, it hangs

Measured 2026-08-25 with Node 26.7.0 against four stub servers. This is the reason
default-on TLS is not a one-line change:

| Plaintext server behaviour | TLS client result | Time |
|---|---|---|
| writes `IAC DO TN3270E`, then waits — **what Hercules does** | **hangs, no error** | ∞ |
| writes nothing | **hangs, no error** | ∞ |
| keeps writing negotiation | `ERR_SSL_WRONG_VERSION_NUMBER` | 2 ms |
| closes the connection | `ECONNRESET` | 1 ms |

The hang happens because `0xff 0xfd 0x28` is read as the start of a TLS record — content
type 255, version `0xfd28` — and OpenSSL then blocks waiting for a length it will never
receive. Only a *chatty* plaintext server trips the clean error. **The common case is the
silent hang**, so `tn3270 localhost:3270` under a TLS default would appear to do nothing
at all.

Therefore the design **requires** a handshake deadline. Two further measured facts:

- `tls.connect({ timeout })` **does** fire its `timeout` event during a stalled handshake,
  so it is a usable deadline. No separate timer is needed.
- It is an **inactivity** timer, not a handshake timer. A 3270 session is idle for as long
  as the user is reading the screen, so leaving it armed after `secureConnect` would drop
  live sessions at think-time. **`sock.setTimeout(0)` on `secureConnect` is mandatory**,
  and gets a test of its own.

## Verification modes, all three measured working

Against an in-repo TLS proxy holding a freshly generated self-signed cert:

| Mode | Node option | Result |
|---|---|---|
| default | *(none)* | rejected, `DEPTH_ZERO_SELF_SIGNED_CERT` |
| `-noverifycert` | `rejectUnauthorized: false` | connects, TLSv1.3, `authorized: false` |
| `-cafile c.pem` | `ca: [pem]` | connects, **`authorized: true`** |

Telnet negotiation passes through the proxy byte-intact (`ff fd 18` out, `ff fb 18` back),
so nothing above the socket needs to know TLS happened.

**`-cafile` is the recommended path for this environment, not `-noverifycert`.** There is
no way to obtain a real certificate here, but pinning the host's own self-signed cert
still gets a *verified* connection — it authenticates the host and detects
man-in-the-middle. `-noverifycert` authenticates nothing. The docs should say so.

## Flags

Both parsers get the same set: `packages/cli/src/main.ts:34` and
`packages/tui/src/main.ts:54`.

| Flag | Meaning |
|---|---|
| *(default)* | TLS, chain verified against system trust store |
| `-insecure` | no TLS at all — plaintext socket, today's behaviour |
| `-noverifycert` | TLS, chain **not** verified. Alias `-no-verify` |
| `-verifycert` | explicit default; exists for s3270 compatibility and so a future config file can be overridden on the command line |
| `-cafile FILE` | verify against this PEM instead of the system store |

`-insecure` is what VM/CE (`localhost:3270`) and MVS 3.8j TK5 (`:3271`) need. Neither
Hercules system can do TLS, and they are the primary test hosts, so this flag is on the
hot path for our own development — not an edge case.

**Conflicts are usage errors, not precedence rules.** `-insecure` with any of
`-noverifycert` / `-verifycert` / `-cafile` is contradictory; rejecting it is kinder than
silently picking a winner. Likewise `-noverifycert` with `-cafile`.

**The `L:` host prefix is accepted and stripped.** It means TLS, which is now the default,
so it is a no-op — but scripts carried over from s3270 will contain it, and without
stripping, `L:localhost:3270` becomes a DNS lookup for the host `L`. `L:` combined with
`-insecure` is a usage error for the same reason as above. Handled in `splitTarget`
(`packages/cli/src/runner.ts:682`).

**The default port stays 23.** s3270 does not change its default port for TLS and neither
should we: silently redirecting to 992 would send a connection somewhere the user did not
type. TLS hosts are named with an explicit port.

## Where the code goes

The architecture already isolates this. `Session` takes an injected
`connect: (host, port) => Connection` (`packages/core/src/session.ts:31`), and there is
exactly one `createConnection` in the tree, at `packages/cli/src/runner.ts:64`.
**`packages/core` needs no changes at all** — it never learns that TLS exists.

- **`packages/cli/src/tls.ts`** (new) — `TlsOptions` type, the `tcpConnect` that chooses
  `net` or `tls`, the `setTimeout(0)` discipline, and the error mapping. New file rather
  than more of `runner.ts`, which is already ~700 lines.
- **`packages/cli/src/runner.ts`** — `tcpConnect` moves out; `defaultSession` gains an
  additive second parameter `tls?: TlsOptions` (additive, so the three existing callers do
  not churn); `splitTarget` strips `L:`.
- **`packages/cli/src/main.ts`**, **`packages/tui/src/main.ts`** — flags, conflict checks,
  usage text.
- **`packages/cli/scripts/tls-proxy.mjs`** (new) — the test and live-testing harness.

## Error messages

The mapping is the feature's whole usability. Every TLS-connect failure must name the flag
that would fix it, because the failure is otherwise indistinguishable from a dead host:

| Condition | Message names |
|---|---|
| handshake deadline expires | `-insecure` — "host did not complete a TLS handshake; if it does not speak TLS, use `-insecure`" |
| `ERR_SSL_WRONG_VERSION_NUMBER` | `-insecure`, same reasoning, stated as near-certain |
| `DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN` | `-cafile` **first**, then `-noverifycert` |
| `ERR_TLS_CERT_ALTNAME_INVALID` | that the cert is valid but for a different name |
| `CERT_HAS_EXPIRED` | expiry, and `-noverifycert` |

## Testing

**No certificates are committed.** A committed cert expires and turns a green suite red on
a date nobody chose. `scripts/gen-test-certs.mjs` generates a short-lived self-signed cert
into a temp dir at test time via the `openssl` on the box (3.5.6, verified present).

Unit, no sockets:
- both `parseArgs` accept every flag and reject every conflict listed above
- `splitTarget` strips `L:`, and still parses bare host, `host:port`, IPv6
- error mapping: each code above produces a message containing the named flag

Integration, against the in-repo proxy — these are the four rows of the verification table
and the four rows of the hang table, turned into tests:
- default verification rejects a self-signed cert
- `-noverifycert` connects and completes telnet negotiation
- `-cafile` connects **and reports the peer as authorized** — asserting the connection
  succeeded is not enough, since `-noverifycert` also succeeds; the assertion that
  distinguishes them is `authorized === true`
- a plaintext server that negotiates-then-waits produces the `-insecure` message within the
  deadline, **not** a hang
- **an idle session survives longer than the handshake deadline** — this is the
  `setTimeout(0)` regression test, and it is the one a reasonable implementer would skip

Live — **done 2026-08-25, same day**, against both Hercules systems with the proxy in
front. Results and the runbook are in `docs/live-testing.md` under *TLS against both
hosts*. The rows that matter: TK5 and VM/CE both reached over verified TLS with `-cafile`
(CLI and, for TK5, the TUI in a pty); `-insecure` unchanged straight at `:3270`; and
default TLS straight at `:3270` failing in **10.013 s** with the `-insecure` message
rather than hanging. No logon was performed — the opening screen proves the transport, and
staying out of `LOGON` avoids handing the VM reconnect trap to the next run.

Not done: `live-drive.py` over TLS. Its targets are hardcoded and it performs a full
logon, so pointing it at the proxy is a change to that script rather than a TLS test.

## Deliberately out of scope

Recorded so their absence is not read as an oversight — the roadmap note in memory warns
that a list here is never closed:

- **Client certificates** (`-certfile`, `-keyfile`, `-clientcert`, `-keypasswd`). Some real
  installations require them. Deferred, not rejected.
- **`-accepthostname`**. Wanted eventually; `-cafile` covers the self-signed lab case,
  which is the case we have.
- **`-cadir`**, **`-certfiletype`/`-keyfiletype`** (DER vs PEM), `tlsMinProtocol` /
  `tlsMaxProtocol` / `tlsSecurityLevel`.
- **Negotiated TLS** — the TELNET `START_TLS` option, s3270's `startTls`. Different
  mechanism from connect-time TLS; nothing we test against offers it.
- **Printer session TLS** — the printer session does not exist yet.

## Cost note

Written 2026-08-25 with the month's budget nearly exhausted. The measurements above were
made before writing, so the traps are observed rather than anticipated. Implementation was
initially deferred to September on a cost estimate that proved about 5× too high, and was
then completed the same day, live-verified, within the remaining budget.

One correction earned during implementation, recorded because the failure mode is
reusable: the first run of the plaintext-host test hung for the full 5 s test timeout,
which looks exactly like the handshake deadline not firing. It was the *stub* — a
`net.Socket` with no `data` listener stays paused, never processes the client's FIN, and
`server.close()` then waits forever for a connection that will not end. The deadline was
working the whole time and fires at 302 ms. Any stub server in these tests needs a `data`
listener purely to resume the socket.
