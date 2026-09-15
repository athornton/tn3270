# Design — a 3270 web gateway serving the same canvas

2026-09-15. Roadmap item (3), "a simple webserver serving the same app". The user's stated
motivation: **reach several emulated S/370 (and /390, and z) systems from a web browser, with a
decent user experience.**

## The user's calls, made 2026-09-15

- **A gateway reachable from other machines**, not a loopback convenience.
- **One host and port fixed at launch**, no connect dialog. Several systems means several server
  instances, each on its own port — which the user likened to a classic pre-TCP/IP system with a
  bunch of terminal lines, and that framing drove two later decisions.
- **In-server TLS**, because requiring a terminating proxy is not acceptable. A proxy remains
  supported, not mandatory.
- **Sessions survive a brief disconnect** and reattach.
- **Multiple tabs are allowed** and each gets its own 3270 session. The user's answer to device
  contention was to define more terminals and vary them online, so the server does not arbitrate.
- **Hand-rolled WebSocket rather than the `ws` package.** The user noted they would probably have
  chosen `ws` themselves and accepted the reasoning; the transport therefore sits behind one
  module boundary so that swapping in `ws` later is contained rather than a rewrite.

## Why the renderer is reusable UNCHANGED, which is the whole reason this is cheap

`packages/gui/src/renderer.ts` was written under a constraint that turns out to be exactly what a
web front end needs: **a browser cannot resolve a bare specifier like `@tn3270/core` and this
project has no bundler**, measured when an earlier version died with "Failed to resolve module
specifier" and left a blank window. So the renderer imports only relative modules, owns no
protocol state, and talks to precisely one bridge:

```ts
window.tn3270 = { onAtlas(fn), onFrame(fn), onError(fn), sendAction(action) }
```

Electron supplies that bridge from `preload.cts` over IPC. The web front end supplies the same
four functions from a served `bridge.js` over a WebSocket. **The renderer is not modified, not
forked, and not parameterised.** If this design needs to change `renderer.ts`, something in it is
wrong.

The draw list is already computed *outside* the browser — `drawList` needs core's palette and code
page — and shipped finished. That is the same shape a server needs.

## Measured before designing

Every number here was taken on this box on 2026-09-15, not estimated.

**1. A frame is 237 KB of JSON and 6.8 KB deflated.** A 24×80 screen from
`packages/fixtures/traces/synthetic-ispf-like.trace`, 1934 drawn cells including the OIA:

| encoding | bytes |
| --- | --- |
| `JSON.stringify(drawList)` | 237220 |
| `zlib.deflateSync` | 6760 |
| `zlib.gzipSync` | 6772 |

A 35× reduction, because per-cell colour data is enormously repetitive. **This is why compression
is in the first slice and dirty-cell diffing is not**: raw frames would be unpleasant over a
network (a keystroke can produce several), while 6.8 KB is a non-issue, and diffing would put
patch semantics into the renderer that Electron does not need.

**2. Node has a WebSocket CLIENT and no server.** Node v26.8.2: `typeof WebSocket === 'function'`,
`require('node:http').WebSocketServer === undefined`, no `node:ws`, `ws` not installed. So the
server must be written or added as a dependency — and the built-in client is an
**independent oracle** for testing hand-rolled framing (see *Testing*).

**3. The project has zero third-party runtime dependencies.** `cli`, `frontend`, `tui` and `gui`
declare only workspace siblings. Preserving that in the one network-facing component is a
deliberate choice, not an accident.

**4. Chromium has what the bridge needs.** Probed inside Electron 44.3.0 under Xvfb:
`DecompressionStream`, `WebSocket`, `sessionStorage` and `createImageBitmap` all present, and a
deflate round-trip through `CompressionStream`/`DecompressionStream` returned the original JSON.

**5. THE COMPRESSION PAIRING IS A SILENT TRAP.** `DecompressionStream('deflate')` expects the
**zlib wrapper** (RFC 1950) and `zlib.deflateSync` produces it — first bytes `78 9c`, confirmed.
`zlib.deflateRawSync` produces raw DEFLATE (first bytes `ab a8`) and needs
`DecompressionStream('deflate-raw')`. Mismatch these and every frame fails to inflate. Pin the
pairing in a test.

**6. Node's WebSocket client cannot be given a CA.** Its constructor takes one argument
(`WebSocket.length === 1`) and silently ignores an options object, so it cannot verify a
self-signed certificate. The `wss` test therefore uses a small in-repo client over
`tls.connect({ ca })` rather than `NODE_EXTRA_CA_CERTS`, which would have to be set before the
test process starts.

**7. Certificate tooling already exists.** `packages/cli/scripts/gen-test-certs.mjs` exports
`generateCerts(dir)` and `haveOpenssl()`, and its SAN already carries both `DNS:localhost` and
`IP:127.0.0.1` — the omission that otherwise fails hostname checking and reports the wrong cause.
**Nothing is committed**: a checked-in certificate expires and reddens the suite on a date nobody
chose, in a commit that did not touch TLS.

## Package layout

### `packages/canvas` — a new package, extracted from `packages/gui`

The canvas presentation layer is about to have two consumers, so it stops living inside one of
them. `packages/frontend` is explicitly **not** the home: its own docstring excludes "anything a
front end owns because of HOW it presents: ANSI generation, SGR depth, canvas geometry."

Moves out of `packages/gui`:

- **browser-side:** `renderer.ts`, `blit.ts`, `keys.ts`
- **server-side:** `drawlist.ts`, `cg.ts`, `bdf.ts`, `scripts/build-atlas.mjs`, and the built
  `atlas.json`/`atlas.bin`
- **tests:** `blit`, `cg`, `drawlist`, `bdf`, `keys`, and the `renderer-imports` guard, which is
  now protecting two front ends instead of one

Stays in `packages/gui`: `main.ts`, `args.ts`, `preload.cts`, `keyspec.ts`, the Electron harnesses
(`keys.mjs`, `shot.mjs`, `xvfb.mjs`), their flag-pinning tests, and the screenshot goldens.

Resulting graph: `core ← canvas ← { gui, web }`, beside the existing
`core ← frontend ← { cli, tui, gui, web }`.

**This extraction has unusually strong verification available: if it is clean, both existing
screenshot goldens still match bit-for-bit**, since the GUI ends up running identical drawing code
over an identical atlas. That is the same check the `frontend` extraction used. Note the recorded
workflow fact that made that extraction painful the first time: **after moving a module between
packages, `npm run build` MUST precede `vitest`**, because the package resolves to its built
`dist/index.js` and testing a stale artefact looks exactly like a broken refactor.

### `packages/web` — the gateway

| file | responsibility |
| --- | --- |
| `src/main.ts` | entry: parse argv, build the server, own the session registry |
| `src/args.ts` | the web-only flags; host, model, scheme and host-side TLS come from `frontend` |
| `src/wsframe.ts` | RFC 6455 frame parse and serialise. Pure, no sockets, fully unit-testable |
| `src/wsserver.ts` | the upgrade handshake and a `Connection` object. **The swap-to-`ws` seam** |
| `src/httpstatic.ts` | serves the five static files and nothing else |
| `src/protocol.ts` | message shapes, and `deflate` on the way out |
| `src/sessions.ts` | create, attach, detach, the grace timer, the cap |
| `static/index.html` | loads `bridge.js`, then `renderer.js` |
| `static/bridge.ts` → `bridge.js` | supplies `window.tn3270` over a WebSocket |

## The transport

`node:http` — or `node:https` when a certificate is configured — with an `upgrade` handler. The
framing works over any duplex socket, which is why TLS costs almost nothing here.

**Served files:** `index.html`, `bridge.js`, `renderer.js`, `blit.js`, `keys.js`. Nothing else is
reachable; there is no directory traversal because there is no path mapping, only a fixed table.

**The atlas travels over the socket, not as a fetch.** That is what keeps the renderer's contract
identical to the IPC path — it already expects `onAtlas`.

**Frames are binary, carrying `deflate(JSON)`.** Client→server messages are tiny and go as text.

### Messages

Server→client, each a JSON object inside one deflated binary frame:

- `{ kind: 'atlas', geometry, coverage, blank }` — once per attach. `coverage` is base64 in JSON,
  because a JSON envelope cannot hold raw bytes; the bridge decodes it to a `Uint8Array` so the
  renderer sees exactly what Electron's structured clone gave it.
- `{ kind: 'frame', list }` — a finished draw list.
- `{ kind: 'error', message }` — connect and TLS failures, shown in the window as the GUI does.
- `{ kind: 'session', id }` — the id to keep in `sessionStorage` for reattachment.

Client→server, text:

- `{ kind: 'hello', sessionId? }` — first message; offers a previous id.
- `{ kind: 'action', action }` — one named `Action`, the same vocabulary `applyAction` takes.

**`quit` IS HANDLED IN THE BRIDGE AND REFUSED AGAIN AT THE SERVER.** `applyAction` *throws* on
`quit` by design, so every front end must intercept it, and here the answer differs from both
others: a browser must not be able to stop the gateway process, but `Ctrl-]` still has to mean
something or the key is a dead spot the renderer claims to bind.

So the bridge intercepts `quit` before it reaches the socket, closes the connection, and shows
"disconnected" through the same path as an error message. The effect is *disconnect this session*,
which after the grace window ends the 3270 session — the closest honest analogue of quitting.
The server ALSO refuses a `quit` that arrives anyway, as defence in depth, because the bridge is
served code and a client is not obliged to run it.

### THE QUEUEING RACE, which would present as an intermittently blank screen

`renderer.js` registers its handlers when its module body runs. The server sends `atlas` as soon as
the socket opens. If `index.html` loads `bridge.js` first and the socket opens before the renderer
module has executed, the atlas is delivered to nobody and the canvas stays black with no error —
the same signature as the four separate blank-window traps already recorded for the GUI.

So **`bridge.js` queues every inbound message until a handler is registered for its kind**, and
flushes on registration. This is not defensive coding; it is the ordering the platform actually
gives us, and it must have its own test.

## Session lifecycle

One `Session` per attached client, connected to the host fixed at launch, using the launch-time
`-model`, `-scheme`, and host-side TLS flags.

- **Attach.** `hello` with no id, or an unknown id, creates a session and returns
  `{ kind: 'session', id }`. The id is a `crypto.randomUUID()`, held in `sessionStorage` so a
  reload reattaches but a second tab does not steal the first tab's session.
- **Detach.** The socket closing does NOT end the 3270 session. It is marked detached and a
  **grace timer** starts (`--grace`, default 60s).
- **Reattach.** `hello` with a live detached id cancels the timer, rebinds the socket, and sends
  the atlas plus a frame built from the current screen buffer. Cheap, because `Session` already
  holds the screen.
- **Expiry.** On timeout the 3270 connection is closed and the session dropped.
- **Cap.** `--max-sessions`, default 16. Over the cap, the socket is closed with a message the
  renderer can display rather than a silent failure.

**Why grace matters more here than convenience:** on VM/370 a logged-on session left running is not
"busy" — the next `LOGON` **reconnects** to the still-running virtual machine, past its IPL, so a
fixed opening sequence lands at `CP READ` instead of CMS. That trap has already produced three
false failures in this project. Without a grace window, every wifi handoff or laptop sleep would
arm it.

## Security

This is the part that changes because the server faces a network.

- **Bind defaults to `127.0.0.1`.** Exposing it requires an explicit `--bind`.
- **A shared token is required by default**, auto-generated with `crypto.randomBytes(16)` and
  printed at startup, or supplied with `--token`. Compared with `crypto.timingSafeEqual` on
  equal-length buffers, length-checked first.
- **The token arrives as `?t=…` on the first page load and is then set as a cookie**
  (`HttpOnly`, `SameSite=Strict`, and `Secure` when TLS is on). The browser sends cookies on the
  WebSocket upgrade, so the bridge never needs to read it and the token stops living in the URL
  bar, history, and any future referrer. The page clears it from the address bar with
  `history.replaceState`.
- **The upgrade rejects a MISMATCHED `Origin` and accepts an ABSENT one.** Without the first, any
  page the operator visits could open a socket to the gateway — the cookie would be sent
  automatically, which is exactly the cross-site WebSocket hijacking shape. The second half is
  deliberate and needs its reason recorded: browsers always send `Origin` on a WebSocket upgrade,
  while non-browser clients — including Node's built-in `WebSocket`, which the integration tests
  depend on — do not. Rejecting an absent `Origin` would therefore block the test oracle and every
  scripted client while stopping no browser attack, since the attack requires a browser to supply
  the cookie in the first place. A non-browser client has no cookie jar and must present the token
  itself.
- **`--auth off`** exists for a fronting proxy that already authenticates, and prints a loud
  warning naming the risk.
- **In-server TLS: `--tls-cert FILE --tls-key FILE`**, with optional `--tls-chain`. Both or
  neither; one alone is a usage error rather than a silent downgrade to plaintext.

**TWO TLS CONTEXTS IN ONE PROCESS, IN OPPOSITE DIRECTIONS — do not let the flags blur.**
`frontend` already owns the flags for the connection *to the host* (`-insecure`,
`-noverifycert`, `-cafile`, `-verifycert`, and the `L:` prefix). Those are unchanged and still mean
"how we verify the mainframe". The new `--tls-*` flags mean "how the browser verifies us". The
naming is deliberately different — long `--tls-` prefixes versus the s3270-style short flags — so a
reader cannot mistake one for the other. A future reviewer should treat any flag that could be read
either way as a defect.

Documented plainly, not buried: without `--tls-cert`, keystrokes including passwords cross the
network in the clear, and a proxy or TLS is required for any real use.

## Testing

The web front end can be guarded substantially better than the GUI was, because most of it is
reachable without a browser at all.

**Inside `npm test`:**

- `wsframe.test.ts` — parse and serialise across the payload-length boundaries (125/126/127 → 7,
  16 and 64-bit), masking (client frames MUST be masked; a server frame must NOT be), continuation
  frames, close/ping/pong, and malformed input rejected rather than mis-parsed.
- `auth.test.ts` — token accepted, rejected, length-mismatched, absent; `--auth off`; and that the
  comparison is `timingSafeEqual` rather than `===`.
- `origin.test.ts` — same-origin accepted, cross-origin refused, and **absent accepted**, each
  asserted rather than assumed. The absent case is the one a future editor is most likely to
  "tighten" into a rejection, which would break the integration oracle, so its test carries the
  reason.
- `sessions.test.ts` — create, reattach by id, grace expiry on fake timers, expiry actually closing
  the 3270 session, the cap, and that an unknown id yields a NEW session rather than an error.
- `protocol.test.ts` — **the deflate/`DecompressionStream('deflate')` pairing pinned by asserting
  the `78 9c` zlib header**, so nobody "optimises" it to `deflateRawSync`.
- `bridge.test.ts` — the queueing race: messages arriving before handler registration are
  delivered on registration, in order.
- `integration.test.ts` — the whole server on an ephemeral port, driven by **Node's built-in
  `WebSocket`**. This is the important one: testing hand-rolled framing only against our own client
  would be self-consistent and prove nothing, whereas the built-in client is an independent
  implementation. It asserts atlas then frame arrive, that an `action` changes the screen, that a
  reattach after a close repaints, and that `quit` is refused.
- `tls.test.ts` — `wss` with a cert from `generateCerts()`, driven by the in-repo client over
  `tls.connect({ ca })`, skipped when `haveOpenssl()` is false.
- `args.test.ts` — including that `--tls-cert` without `--tls-key` is a usage error.

**A test seam, `--replay FILE`**, paints a recorded trace instead of connecting, exactly as
`TN3270_GUI_REPLAY` does for the GUI. It is what makes the integration tests hostless. A replay
server never opens a socket to a host, so no test can leak a credential.

**Run by hand, like `keys.mjs` and `pty-smoke.py`:**

- `packages/web/scripts/browser-keys.mjs` — Electron loads the served page over `http://` and
  drives real chords with `sendInputEvent`, asserting the ordered action sequence the server
  received. The web renderer therefore ships with the same class of guard the GUI just got, rather
  than acquiring one later.
- `packages/web/scripts/browser-shot.mjs` — screenshots the served page and compares against the
  **existing GUI golden**. Same renderer, same atlas, so identical pixels are the expected result,
  and this is the check that directly proves the reuse claim. **If pixel identity proves fragile
  (window sizing and scale must match), fall back to the documented method — compare ink ROW BY ROW
  against what the CLI reports — and do NOT add a pixel tolerance**, which is how a golden stops
  being evidence.

## Out of scope, deliberately

- A connect dialog, and choosing the host from the browser. Fixed at launch, by the user's call.
- Multi-user accounts, per-user sessions, and reattaching a session from a different browser.
- Mouse, the virtual keypad, and text selection — roadmap item (9), its own spec.
- `permessage-deflate` negotiation. We control both ends and compress the payload ourselves.
- Dirty-cell frame diffing. Revisit only if latency is *measured* to be a problem, given 6.8 KB.
- Client certificates and mTLS.

## Success criteria

1. A browser on another machine reaches a fixed Hercules host through the gateway, renders a real
   screen, and takes typed input.
2. `renderer.ts` is byte-identical to its pre-branch content after being moved, and both GUI
   goldens still match without `--update`.
3. Reload and a 30-second network interruption both reattach to the same 3270 session rather than
   starting a new one; a 90-second interruption does not.
4. The token, the `Origin` check and the loopback default are each demonstrated to refuse, not
   merely present.
5. `wss://` works with a generated certificate, and `--tls-cert` without `--tls-key` is refused.
6. Two tabs hold two independent sessions.
7. The hand-rolled framing satisfies Node's built-in WebSocket client.
8. `browser-keys.mjs` passes, and its failure has been observed by mutation.

## Risks, stated in advance

- **Hand-rolled framing is the main risk.** Mitigated by the independent-oracle test, by keeping it
  pure and separately testable, and by the `wsserver.ts` seam that makes adopting `ws` a contained
  change if it disappoints.
- **The extraction touches a working GUI.** Mitigated by the goldens, and by doing it as its own
  first task with nothing else in the commit.
- **Multiple tabs will sometimes land on an idle Hercules device and look broken** — measured
  previously: `@MOD4` on VM shows 0 fields where no-suffix shows 22, because the host's logon
  process paints one device and the others sit idle. The user's answer is to define and vary on
  more terminals. Worth surfacing in the served page's error area rather than leaving it a mystery.
