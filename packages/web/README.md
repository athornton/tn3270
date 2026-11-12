# @tn3270/web — the browser gateway

The same 3270 screen the Electron app draws, served to a browser over a WebSocket.

```bash
npm install -g @tn3270/web
```

```bash
tn3270-web -insecure -model 3278-4-E 127.0.0.1:3270
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

**`Ctrl-K` shows and hides it; `Alt-K` does the same.** It is the same 48-key keypad the
Electron app opens in its own window — PF1–PF24, PA1–PA3 and the special keys a PC keyboard lacks,
including **Dup**, **Field Mark**, **Sys Req** and **Newline** — the four that `core` could do and
no interactive front end could press before the keypad. Sys Req and Newline get no chord in any
front end, so this is their only route besides the CLI. `Ctrl-K` is c3270's own terminal binding
for its keypad (`Common/fb-c3270:191`) and `Alt-K` is how its Windows keymap spells the same
command, so both are honored rather than one being a divergence.

**Here it is an OPAQUE OVERLAY of real HTML buttons** (`keypadOverlay.ts`), because a browser tab
cannot open an OS window the way the GUI does. The browser hit-tests the buttons itself, and a click
sends the *ordinary* `{"kind":"action"}` message the equivalent keystroke sends — **nothing about
the protocol changed to add it**. The toggle never reaches the gateway at all: `bridgecore.ts`
intercepts it client-side, so the server holds no keypad state. The overlay floats over the screen
(`position: fixed`) rather than growing the page, so showing it never moves a row the host wrote;
a model 4 taller than the viewport scrolls, as it always did. `Ctrl-B` opens the full 122-key
keyboard as the same kind of overlay, and `Ctrl-T` the transfer form (below).

**It starts hidden on every page load, and that is a decision about a lifetime.** A gateway session
deliberately outlives its socket so a reload reattaches, and the next attacher may be a different
window, possibly a different person; a keypad state kept with the session would hand one operator's
preference to whoever attaches next. So a reattaching client always starts with it hidden.

**The mouse.** On the 3270 screen a primary-button drag selects a rectangle of text for copying (the
root README's *Copy and paste*); a press off the screen region, and the right and middle buttons, do
nothing, so a right-click cannot send an AID to a live host while the context menu opens. There is
no click-to-place-cursor and no light pen. The keypad, the keyboard, the transfer form and the
`Alt-M` picker are HTML controls, so the mouse works on them as on any page.

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
| `-oversize <cols>x<rows>\|auto\|none` | `none` | a screen past the model, advertised as `IBM-DYNAMIC`; needs a `-E` model. **Columns first**, x3270's order: `160x62` is 62 rows by 160 columns. See below |
| `-scheme NAME` | `default` | color scheme: `default`, `3279`, `x3270`, `green` |
| `-bind-image on\|off` | `on` | request the TN3270E BIND-IMAGE function |
| `-bind-limit on\|off` | `on` | range-check a BIND's geometry against `-model` (or the oversize) before honoring it |
| `-ddm on\|off` | `on` | advertise the DDM Query Reply, so a host can choose DFT for a transfer; `off` forces CUT |
| `-devname NAME` | none | answer NEW-ENVIRON's `DEVNAME` with `NAME` (trailing `=` become a counter); absent, option 39 is refused |

### `-oversize`

`-oversize 160x62` gives every session 62 rows by 160 columns as its alternate size. The host is
told `IBM-DYNAMIC`, and learns the size from the Query Reply. It is refused at startup with
`--terminal-type` (which the gateway does not take anyway), on a non-`-E` model, below the
model's own alternate size, or over 16383 cells (the 14-bit address limit).

`-oversize auto` measures **each browser's viewport, per session**, at scale 1, in whole cells,
less one row for the OIA. The page sends its viewport in CSS pixels in `hello` and again whenever
the window resizes, and the gateway turns that into cells with the atlas cell. **It is measured at
each connect and reconnect only.** Resizing the window mid-session does not change the live
screen, since the host already has its Query Reply. The new size applies the next time the
session reconnects (for example, `Enter` on a disconnected session). A reattaching tab's viewport
replaces the old one.

When `auto` cannot apply (no viewport sent, a viewport smaller than the model, or one too wide to keep the model's rows inside 16383 cells), the session
uses the model, and the gateway says so on stderr, prefixed with the first 8 characters of the
session id. **`--replay` ignores `-oversize`**: a replay never connects, and only a connect
resolves the geometry. That is also why the browser harnesses, which all run replay gateways, do
not exercise `auto` end to end. Its unit tests and the integration `hello` test are the cover.

### Choosing the model and oversize: `Alt-M`

`Alt-M` opens a picker over the screen, the browser's counterpart of the GUI's Model menu: the
eight models (each with its size in words), then oversize None, Auto, and the `-oversize` size the
gateway was started with, if any. Nothing is typed; a new size is a new `-oversize`. **The choice
applies at the next connect** (for example, `Enter` on a disconnected session). While the session is
connected or connecting every choice is disabled, and the picker says which: `Disconnect first`
once the session is actually connected, or `Wait for the connection attempt to finish` while a
connect -- first or reconnect -- is still in flight and there is nothing yet to disconnect.
**The picker's first control is a Disconnect button**, enabled only while the session is actually
connected: it sends a `disconnect` message, the gateway drops this tab's host session (never
another tab's), the status line shows `X Disconnected -- press Enter to reconnect`, and the
choices free up; `Enter` or `Clear` then reconnects with the new choice. It is disabled while a
connect is in flight (`Session.disconnect()` cannot cancel an attempt that has no connection yet)
and while disconnected. If the page's own connection to the gateway closes, the picker says `The
connection to the gateway closed; reload to reconnect.` and disables everything. The
gateway owns the session, so the list comes from it and a click goes back to it as a `setGeometry`
message. **A model choice can reset the oversize to None** when the oversize cannot go with that
model (a non-`-E` model, or a fixed size smaller than the model), by the same rule as the GUI; the
picker says so. Pick
a model the size fits and then the size again to get it back. Opening the picker closes the keypad,
the keyboard and the transfer form, and opening any of those closes it. A choice is made by
clicking it, or by `Enter` or `Space` on the focused one; the arrow keys only move between
choices and apply nothing. `Escape`, `Alt-M` or `Close` shuts the picker. The gateway prints a
reset, and a refused return to the startup size, on stderr with the session id's first 8
characters; a choice refused because the session is connected is only shown in the picker.

**"Picked, never typed" is a rule about the page, not a security boundary.** Any client that can
open the socket can send `setGeometry` for any of the eight models and any oversize the list
names, and through the viewport it reports, `-oversize auto` can come to any size up to 16383
cells. That is the same reach the operator already has; restrict the gateway with `--auth`, not
with the picker.

## File transfer (`IND$FILE`)

**`Ctrl-T`, or the keypad's `Xfer`, opens the transfer form as an overlay** — the GUI's fields:
direction, host (`tso` or `vm`), local file (omitted on a receive — see below), host file, mode,
exist, cr, recfm, lrecl, blksize. Both directions. The bytes travel over the WebSocket in
4096-byte chunks, so the local file is on the **browser's** machine; the gateway holds the file in
memory and never touches its own disk.

- **Options** are the CLI's `Transfer()` keywords; the form does not offer `BufferSize`.
- **10 MB cap, each way**, because the gateway stages the whole file in memory. Over that, the
  transfer is refused before it starts (a send) or before any byte is relayed (a receive).
- **One transfer per session at a time.** Staging belongs to the connection, so a tab that
  reattaches never inherits a half-sent upload.
- **The host chooses CUT or DFT.** DDM is advertised by default; `-ddm off` forces CUT, which
  needs a 24x80 screen.
- **A receive has no Local file field, no Browse and no Save step (2026-11-12).** Start fetches
  the file and, on success, the browser downloads it on its own through a plain `<a download>`
  link — the only route, in every browser; the Chromium `showSaveFilePicker` route was removed
  because it needs a fresh click, which the completion callback does not have. The download is
  named `defaultLocalName(hostFile, host)`: VM `fn ft fm` → `fn.ft`; TSO lowercased with one pair
  of enclosing quotes stripped; `download.bin` when there is nothing to derive from. The status
  line reads `received <n> bytes; downloaded as <name>`; a cancel landing after the last chunk
  downloads nothing (`transfer cancelled; nothing was downloaded`).

Live-verified 2026-10-22: Firefox on macOS, through a reverse proxy, 249 bytes byte-identical
both ways against VM/370 over CUT — that run used the since-removed Save button. The
download-on-completion flow above is not yet live-verified in either Firefox or Chrome, and DFT
from a browser has not been driven live at all (`docs/live-testing.md`).

## The host argument, and what this gateway will NOT take

`HOST:PORT`, and of the full `[prefix:][LU,LU@]host[:port]` shape the other front ends accept, only
`host:port` is honored. The rest is **refused by name rather than ignored**, which is this project's
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
when written and is not now. What is still checked, and is the claim worth making, is that the
served page and the Electron app produce **identical pixels** for the screen.)
It already spoke to a four-function bridge — `onAtlas`, `onFrame`, `onError`, `sendAction` — and
imported only relative modules. Those four are still the bridge's REQUIRED width. Since 2026-11-02
it has a fifth, OPTIONAL member, `fetchSelection`, which prefetches a selection's text when a drag
ends so the browser's copy can write it synchronously; it is optional precisely because Electron's
`preload.cts` does not implement it, and `renderer.ts` tests for it before calling it, so the one
renderer stays shared. Its runtime imports are all relative (`blit.js`, `keys.js`, `selection.js`,
`forwardKeys.js`, `copyCache.js`), and each is served from `BROWSER_MODULES` in
`canvas/src/assets.ts`, for exactly that reason: a runtime import of a workspace package here
blanks the window with no error anywhere, and a module missing from that list blacks out the canvas.
Electron supplies that bridge over IPC from `preload.cts`; here `bridge.js` supplies the same four
functions, plus `fetchSelection`, over a WebSocket. Nothing above the transport knows the difference, and
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
`sessionStorage`. An id naming a session someone is **currently** attached to gets a new session
rather than a handover (`sessions.ts`, `attach`), so a leaked id cannot become a way into another
operator's logged-on session.

**One `hello` per socket** (2026-11-05). A second `hello` on the same socket is answered with an
`error` (`this socket already said hello; open a new connection for another session`) and changes
nothing. Before this, a second `hello` built a second session and orphaned the first, which stayed
attached forever, holding a host connection and a `--max-sessions` slot. So one page repeating
`hello` could use up the gateway. The served page sends `hello` once, when the socket opens.

## By-hand harnesses

Not in `npm test` — they need Xvfb and a real browser. Run them like `packages/gui/scripts/keys.mjs`:

```bash
node packages/web/scripts/browser-keys.mjs       # 14 chords, 10 actions in order, 4 absences (Ctrl+K, Alt+M, Ctrl+Z, F13)
node packages/web/scripts/browser-shot.mjs       # 1 case of served pixels vs the GUI's own golden
node packages/web/scripts/browser-clicks.mjs     # keypad clicks, then 20 checks incl. the Alt-M picker
node packages/web/scripts/browser-lan-copy.mjs   # 2 copy checks at a plain-http LAN address
```

(Counts measured 2026-11-05 at `eabe45b`.) `browser-shot.mjs` runs **one** case, the plain screen.
It was two until 2026-10-06, when the keypad became HTML buttons: a window of system-font controls
is not a pixel the canvas owns, so the keypad case went. The case that is left still says the
renderer is shared: the served page is pixel-identical to the GUI's own golden.

Both need `--no-proxy-server`, which they pass: with `HTTP_PROXY` set, Chromium routes even a
loopback request through the proxy and the failure is completely silent.
