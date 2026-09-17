# @tn3270/web — the browser gateway

The same 3270 screen the Electron app draws, served to a browser over a WebSocket.

```bash
npm run build
node packages/web/dist/main.js -insecure -model 3278-4-E 127.0.0.1:3270
```

It prints the URL to open. By default there is no token, so that is just the address:

```
serving 127.0.0.1:3270 at http://127.0.0.1:8270/
```

With `--auth on` the token appears in it once, and is carried by a cookie thereafter:

```
serving 127.0.0.1:3270 at http://127.0.0.1:8270/?t=4f3c...
```

## The virtual keypad

**`Ctrl-K` shows and hides it; `Alt-K` does the same.** It is the 47-key clickable keypad the
Electron app draws — PF1–PF24, PA1–PA3 and the special keys a PC keyboard lacks, including
**Dup**, **Field Mark**, **Sys Req** and **Newline**, the four with no chord or no host reaction of
their own. `Ctrl-K` is c3270's own terminal binding for its keypad (`Common/fb-c3270:191`) and
`Alt-K` is how its Windows keymap spells the same command, so both are honoured rather than one
being a divergence.

**NOTHING ABOUT THE PROTOCOL CHANGED TO ADD IT, and that is the whole design.** A click is hit-
tested in the browser against rectangles the server already sent, and a hit sends the *ordinary*
`{"kind":"action"}` message the equivalent keystroke sends — the same `sendAction` the bridge has
always had. There is no new message kind, no new bridge function (a fifth would mean the renderer
had stopped being shared) and nothing new for `protocol.ts` to bound: `toggleKeypad` carries no
numeric field. The press highlight is drawn locally and never leaves the renderer, because a round
trip for it would visibly lag behind the finger over a WebSocket.

The keypad is a third region of the draw list, appended **below** the screen and the OIA, so
showing it never moves or covers a row the host wrote. A screen plus keypad taller than the
viewport **scrolls**, which is what the page already did for a model 4.

**The flag is per CONNECTION, not per session, and the reason is a lifetime rather than
concurrency.** Two sockets can never hold one `Session` at the same time — `attach` reattaches only
a *detached* entry, and the id lives in per-tab `sessionStorage` — so what a session-scoped flag
would actually do is hand the preference to **whoever attaches next**. A gateway session
deliberately outlives its socket so a reload reattaches, and the next attacher is a different
window, possibly a different person, whose screen would come back six rows taller than they left
it. A reattaching client therefore starts with the keypad hidden.

**The mouse does keypad buttons and nothing else.** No click-to-place-cursor, no drag-to-select, no
light pen; the right and middle buttons do nothing, so a right-click on `Clear` cannot send it to a
live host while the context menu opens over the label.

## READ THIS BEFORE EXPOSING IT TO A NETWORK

This process types at a mainframe. Three things decide whether that is safe, and **the one that
controls ACCESS is off by default** — the loopback bind is what makes that defensible:

- **Without `--tls-cert` every byte crosses the network in the clear**, including the password
  typed at a logon panel. The gateway says so on startup when it is not bound to loopback. Give it
  `--tls-cert` and `--tls-key` and it serves `https://` and `wss://` in-process, so a terminating
  proxy is optional rather than required.
- **The token is OFF by default, so anything that can reach the port can type at your mainframe.**
  Out of the box only this machine can, which is the point: asking a local operator for a token
  against their own emulator is friction that buys nothing. `--auth on` generates one, prints it
  once in the startup URL, and thereafter carries it in an `HttpOnly`, `SameSite=Strict` cookie so
  it leaves the address bar after the first load.
- **The default bind is `127.0.0.1`.** `--bind 0.0.0.0` is how you choose otherwise.
  **`--bind` off loopback WITHOUT `--auth on` is the dangerous combination**, and it is the one the
  gateway warns about on startup — not `--auth off` on its own, which would print on every run and
  be learned as noise.

A token and TLS are not substitutes: **`--tls-cert` protects the traffic, the token protects
access.** Exposing this beyond loopback wants both.

A cross-origin upgrade is refused. Behind a reverse proxy that rewrites `Host` — which is nginx's
and Apache's DEFAULT — you must name what the browser actually sees with `--allow-origin`, or every
legitimate browser is refused. See `handshake.ts` for the measurement.

## Flags

The gateway's own options are double-dashed. The client options it inherits keep s3270's spelling
with a single dash, exactly as the other front ends do — so `-insecure`, not `--insecure`.

| flag | default | meaning |
|---|---|---|
| `--bind ADDR` | `127.0.0.1` | interface to listen on |
| `--listen PORT` | `8270` | port; `0` means let the kernel choose |
| `--auth on\|off` | `off` | require the token. **On is what you want off loopback** |
| `--token STR` | random | use this token instead of a generated one |
| `--grace SECONDS` | `60` | how long a session outlives its socket, for reattachment |
| `--max-sessions N` | `16` | cap on concurrent sessions |
| `--allow-origin ORIGIN` | none | extra Origin accepted verbatim; repeatable |
| `--tls-cert FILE` | none | serve HTTPS/WSS; requires `--tls-key` |
| `--tls-key FILE` | none | private key for the above |
| `--tls-chain FILE` | none | intermediate chain |
| `--replay FILE` | none | paint a recorded trace and open no host socket |
| `--log-actions` | off | print every action applied; **requires `--replay`** |
| `-insecure` | — | the HOST connection is plaintext. Required for Hercules |
| `-cafile FILE` | — | verify the host against this PEM |
| `-noverifycert` | — | make the TLS connection without verifying the host |
| `-verifycert` | — | verify (the default; explicit for symmetry with s3270) |
| `-model NAME` | `IBM-3278-2-E` | screen model, e.g. `3278-4-E` |
| `-scheme NAME` | `default` | colour scheme: `default`, `3279`, `x3270`, `green` |

## The host argument, and what this gateway will NOT take

`HOST:PORT`, and of the full `[prefix:][LU,LU@]host[:port]` shape the other front ends accept, only
`host:port` is honoured. The rest is **refused by name rather than ignored**, which is this project's
rule for anything that would change what goes on the wire without being implemented:

| written | result |
|---|---|
| `LUA,LUB@host` or `LU@host` | **refused** — an LU is a property of one connection, and this serves many sessions from one command line |
| `N:host` | **refused** — it turns TN3270E off for a host, and ignoring it would negotiate what the operator declined |
| `L:host` | accepted; TLS to the host is already the default |
| `L:host` with `-insecure` | **refused** — obeying one disobeys the other, and connecting in the clear to a host marked TLS is a silent downgrade |
| `A:` `C:` `P:` `S:` `T:` `Y:` | refused by name, as in every front end |

**`--terminal-type` and `-tn3270e` are not accepted either.** A gateway session always offers
TN3270E (backing off if the host refuses) and takes its terminal type from `-model`.

`--log-actions` is refused without `--replay` on purpose: a `type` action carries the text typed, so
on a live gateway it would put an operator's password into a log file.

## How it works, and why it is small

`renderer.ts` comes from `@tn3270/canvas` and is the **same file** both front ends load — not a
copy, and not a version with a browser branch in it. The one place the two hosts differ is that the
canvas is sized to `max(viewport, drawing)` rather than to the viewport, because a page cannot
resize its own window and would otherwise clip the OIA row off a model-4 screen; Electron pays
nothing for that, since main sizes its window to exactly the drawing. (An earlier version of this
paragraph added that every *other* line was byte-identical to the pre-gateway version. It was true
when written and is not now — the keypad work added the keypad blit, the click path and a test
seam to this file. What is still checked, and is the claim worth making, is that the served page and
the Electron app produce **identical pixels**, keypad and all.)
It already spoke to a four-function bridge — `onAtlas`, `onFrame`, `onError`, `sendAction` — and
imported only relative modules. Hit-testing lives in `canvas/src/hittest.ts`, which is import-free
for exactly that reason: a runtime import of a workspace package here blanks the window with no
error anywhere.
Electron supplies that bridge over IPC from `preload.cts`; here `bridge.js` supplies the same four
functions over a WebSocket. Nothing above the transport knows the difference, and
`browser-shot.mjs` proves it in pixels by comparing the served page against the Electron app's own
golden.

The draw list is computed in the server for the same reason Electron computes it in main: it needs
core's palette and code page, and a browser cannot resolve a bare specifier without a bundler.

Frames are whole and deflated. Measured: a 24x80 draw list is 237220 bytes of JSON and **6760
compressed**, a 35x ratio, which is why dirty-cell diffing is deliberately not in this design.

Zero runtime dependencies, like every other package here. Node has a WebSocket *client* but no
server, so the framing is hand-rolled in `wsframe.ts` behind the `Connection` seam in
`wsserver.ts` — and the built-in client is then an *independent* oracle for it in
`integration.test.ts`.

## Sessions and reattachment

A session outlives its socket by `--grace` seconds, so a reload or a wifi handoff reattaches to the
running 3270 session instead of dropping it and logging on again. The browser remembers its id in
`sessionStorage`. An id naming a session someone is **currently** attached to is refused a
handover, so a leaked id cannot become a way into another operator's logged-on session.

## By-hand harnesses

Not in `npm test` — they need Xvfb and a real browser. Run them like `packages/gui/scripts/keys.mjs`:

```bash
node packages/web/scripts/browser-keys.mjs   # 13 chords, 11 actions in order over a WebSocket
node packages/web/scripts/browser-shot.mjs   # 2 cases of served pixels vs the GUI's own goldens
```

`browser-shot.mjs` runs **two** cases, not one: the plain screen and the same screen with the keypad
shown, each sized from its own golden's PNG header. The second is the one that matters — it says the
keypad the browser draws is the same keypad Electron draws, which is what makes this one
implementation with two front ends rather than two implementations that agree today.

Both need `--no-proxy-server`, which they pass: with `HTTP_PROXY` set, Chromium routes even a
loopback request through the proxy and the failure is completely silent.
