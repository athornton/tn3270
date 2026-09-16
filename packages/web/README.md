# @tn3270/web — the browser gateway

The same 3270 screen the Electron app draws, served to a browser over a WebSocket.

```bash
npm run build
node packages/web/dist/main.js -insecure -model 3278-4-E 127.0.0.1:3270
```

It prints the URL to open, including a token:

```
serving 127.0.0.1:3270 at http://127.0.0.1:8270/?t=4f3c...
```

## READ THIS BEFORE EXPOSING IT TO A NETWORK

This process types at a mainframe. Three things decide whether that is safe, and two of them are
on by default:

- **Without `--tls-cert` every byte crosses the network in the clear**, including the password
  typed at a logon panel. The gateway says so on startup when it is not bound to loopback. Give it
  `--tls-cert` and `--tls-key` and it serves `https://` and `wss://` in-process, so a terminating
  proxy is optional rather than required.
- **`--auth off` means anything that can reach the port can type at your mainframe.** The token is
  on by default; it is printed once in the URL and then carried by an `HttpOnly`,
  `SameSite=Strict` cookie, so it leaves the address bar after the first load.
- **The default bind is `127.0.0.1`.** `--bind 0.0.0.0` is how you choose otherwise, and it warns.

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
| `--auth on\|off` | `on` | require the token |
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
| `-model NAME` | `IBM-3278-2-E` | screen model, e.g. `3278-4-E` |
| `-scheme NAME` | `default` | colour scheme: `default`, `3279`, `x3270`, `green` |

`--log-actions` is refused without `--replay` on purpose: a `type` action carries the text typed, so
on a live gateway it would put an operator's password into a log file.

## How it works, and why it is small

`renderer.ts` comes from `@tn3270/canvas` and is shared with the Electron app **with one two-line
exception**: the canvas is sized to `max(viewport, drawing)` rather than to the viewport, because a
page cannot resize its own window and would otherwise clip the OIA row off a model-4 screen. Every
other line, and all five of the other moved modules, are byte-identical to the pre-gateway version.
It already spoke to a four-function bridge — `onAtlas`, `onFrame`, `onError`, `sendAction` — and
imported only relative modules.
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
node packages/web/scripts/browser-keys.mjs   # real chords through a real browser
node packages/web/scripts/browser-shot.mjs   # served pixels against the GUI golden
```

Both need `--no-proxy-server`, which they pass: with `HTTP_PROXY` set, Chromium routes even a
loopback request through the proxy and the failure is completely silent.
