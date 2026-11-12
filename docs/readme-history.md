# README history

README passages moved out during the 2026-11-12 accuracy audit, kept verbatim for the record. Each
passage was either superseded (a gap since closed, a count since changed, a code path since
deleted) or condensed to a line because a *Verification* row holds the detail. The README is
current; this file is not, and its claims are true only as of the dates they carry.

## From README § What is not implemented (moved 2026-11-12)

The end of the first paragraph of the *TN3270E is implemented but NOT verified* bullet:

  unwitnessed by any *reachable* host. **No reachable host completes a TN3270E negotiation
  at all**, so the witness for FUNCTIONS, BIND-IMAGE and BIND is a *recorded* host instead:
  x3270's `playback -b` replaying `packages/fixtures/x3270/sscp-lu-data.trc`, a real host
  that grants BIND-IMAGE and sends a real BIND (PLU name `IBM0SMAA`, MaxSec-RU 1024,
  MaxPri-RU 3840, default 24x80, alternate 43x80). Bytes and next steps:
  `docs/live-testing.md`, *TN3270E against a real host*. What is still missing: a **printer
  session**, whose harness now exists, and a live UNBIND with `BIND_FORTHCOMING`, which no
  trace or reachable host has produced.

- **SYS REQ'S CLASSIC PATH IS LIVE-VERIFIED (2026-09-21); ITS TN3270E PATH STILL HAS NO WITNESS.**
  The keypad's `SysRq` button, the TUI overlay's entry and the CLI's `SysReq()` all put bytes on the
  wire against VM/370 and MVS 3.8j, and the key has now been driven at both and the reply read.
  **Both predicted forms appeared, one per host**: VM's unformatted screen sent the heading plus
  modified buffer data (`01 6c 61 02 / 11 5b 60`), TK5's formatted panel the heading alone. No `f0`
  in either record, so `case AID_SYSREQ` ran and not the ordinary-AID path.
  **VM/370 ACTS on a test request** — `RUNNING` → `CP READ`, a second Read Partition and a repaint —
  where MVS ignores it, so a host ignoring the key is legal but not universal. The `IAC AO` path
  needs a host that grants the TN3270E SYSREQ function, which neither Hercules system will ever be.
  Measurements in `docs/live-testing.md`, *Sys Req and Dup against VM/370 and TK5*.
  **It is not the AID you would expect.** Neither Hercules system offers TN3270E — both answer
  `IAC WILL TN3270E` with `ff fe 28` = DONT, measured three times — so both take the classic path,
  and x3270's classic branch does **not** send AID `0xf0`. `ctlr_read_modified` has a dedicated
  `case AID_SYSREQ /* test request */` (`Common/ctlr.c:770-777`) that emits a **four-byte TEST
  REQUEST READ heading** — `EBC_soh`, `EBC_percent`, `EBC_slash`, `EBC_stx`, i.e. `01 6c 61 02` —
  in place of the AID byte and cursor address. `AID.SYSREQ = 0xf0` exists in our `constants.ts`
  and is never what goes on the wire for this key. The modified field data **does** still follow
  the heading, which the phrase "four-byte record" invites you to get wrong: GA23-0059-07 says the
  stream is "the same as described previously for read-modified operations, excluding the 3-byte
  read heading (AID and cursor address)", and x3270's `break` leaves the switch rather than the
  function. There is no ETX; that is BSC framing, and a telnet record ends at `IAC EOR`.
  On an inhibited keyboard the key is **refused**, where x3270 would queue it — we have no action
  queue and did not invent one for a single key.

- **NO KEYPAD BUTTON HAS BEEN CLICKED AT A HOST, and Dup's TAB is still unwitnessed.** (This bullet
  used to lead with "Field Mark and Newline have no live witness"; both got one on 2026-09-24.)
  All four keys are implemented, and **all four are now witnessed on both hosts** — Sys Req and Dup
  2026-09-21, **Field Mark and Newline 2026-09-24**, each against a matched control (above, and
  `docs/live-testing.md`). **Two narrower gaps the runs did not
  close, recorded so the witness is not read as wider than it is:** they drove the **CLI**, which
  shares `applyAction` with the button but not `mousedown` → `hitTestAt` → IPC, so the click path is
  still offline-only (`clicks.mjs`); and **Dup's TAB is unwitnessed** even though its `0x1c` is not,
  because TK5's logon panel has one unprotected field, where plain `Tab` does not move either. That
  check needs a multi-field panel, which needs a logon. The keypad as a whole needs no live
  verification, because a button press produces the same wire bytes as the equivalent keystroke and
  those *are* live-verified.

- **`IND$FILE` IS INTERACTIVE IN THE TUI AND THE GUI — THE BROWSER IS THE ONE THAT STILL CANNOT
  TRANSFER A FILE.** (This bullet used to say "the TUI only"; the GUI half landed 2026-10-01.)
  `Ctrl-T` opens a form in the TUI: ten fields, `Tab` and the arrows to move and change,
  `Enter` to start, `Esc` to close, and closing mid-transfer **aborts** rather than abandoning, so
  the host leaves transfer mode. **Three things it did not do yet; two are now done.** ~~(1) CUT
  mode only, so it needs a 24x80 screen.~~ **DONE 2026-09-29 — BOTH PROTOCOLS WORK AND THE HOST
  CHOOSES.** With
  `-ddm on` a DFT host transfers at any geometry, live-verified at 43x80 on TK5; `-ddm on` really
  does get you DFT now, where it used to be a measurement instrument that broke transfers. The
  24x80 requirement survives only for CUT, and is raised when CUT is chosen rather than up front.
  ~~(2) The GUI has the form's model and no renderer for it.~~ **DONE 2026-10-01 — `Ctrl-T` and the
  `Xfer` button open a transfer window**: a separate `BrowserWindow` with real HTML controls and a
  native file dialog, **not a canvas view**, because the canvas preload must
  stay at four functions for `renderer.ts` to keep being shared with the browser, and teaching a
  canvas text editing and focus buys nothing. See *Using the GUI*, *File transfer*. **Its live gap is now
  mostly closed and was never the protocol's:** VM/CMS has driven this window for real and the macOS
  dialog is verified by hand in ASCII mode; **TSO/DFT remains unrun** —
  `docs/live-testing.md`, *The GUI transfer window*.
  (3) **The web gateway STILL REFUSES the action outright, in
  `web/src/protocol.ts`**, and that is deliberate — **and as of 2026-10-01 the refusal gives the
  right reason.** It used to say "the gateway has no transfer UI", which stopped being the reason
  the moment the GUI had one; the reason is that a browser-initiated transfer moves bytes between
  the host and the *gateway's* filesystem, not the operator's machine. **The answer decided on
  2026-09-30 is real browser file I/O** — the bytes travelling over the WebSocket so that "local
  file" means the operator's machine — which needs a new protocol message pair, chunking and a
  `TransferFiles` over the socket, and is its own spec rather than part of the GUI's. The refusal is
  a rejection at **decode** rather than an interception, which is safe because
  `web/src/main.ts:151-154` answers every decode failure with a per-socket `error` frame and a
  `return`; the hazard that needs an interception is one line lower, at the untried `applyAction`.
  **The transfer protocol itself is live-verified on BOTH hosts in both directions** — see
  *Verification*.

- **No Programmable Symbol Sets and no graphics.** `XA.CHARSET` (`0x43`) is parsed and
  deliberately dropped. `Cell` is already a tagged variant so that a renderer dispatches
  on `kind` rather than assuming a font lookup — that variant exists for nothing but PS.

- **A model or oversize change applies at the next connect, never to the live screen.** The GUI's
  Model menu, the browser's `Alt-M` picker and the CLI's `Set()` all refuse while connected or
  connecting (see *Oversize*). The menus offer only fixed choices: a new size is a new `-oversize`
  (or `Set(oversize,...)` in the CLI). The TUI has no chooser at all; it changes size by being
  resized and reconnected, and its model only by `-model`. VM/370 honours an oversize live; TSO, a
  modern host, and a menu or picker choice renegotiating against a live host are still owed
  (`docs/live-testing.md`).

## From README § Verification (moved 2026-11-12)

Six rows of the *Verification* table, as they stood:

| check | result |
|---|---|
| `npm test` | **pass** — 2959 tests, 119 files (measured 2026-11-05 on branch `oversize`, with the picker's Disconnect) |
| `keys.mjs` — real Chromium key events in Electron | **pass** — 25 chords, 23 actions in order, 2 asserted absences (`Ctrl+Z`, `F13`), and **2 Model menu popups**, one per `Alt+M` (measured 2026-11-05). One `Alt+M` is on the canvas and one in the keyboard window with its own liveness probe, since `forwardKeys` forwards `geometryMenu` unfiltered and `applyAction` throws on it. **Two of those chords go to a CHILD window** (`kbd:` steps, 2026-10-27): before them no harness here could deliver a keystroke to the keypad or keyboard window at all, which is exactly why a `Ctrl-Shift-C` pressed there froze the main process with the whole suite green — `forwardKeys` forwards any action unfiltered and those windows load their own boot files, not `renderer.js`. The pair is a chord plus an `attn` LIVENESS PROBE, because a frozen client and a correctly dropped chord both produce no action line. It carries `Ctrl+T`, which **this list exists to have caught and did not**: the chord was dead until 2026-10-01 while the `Xfer` keypad button worked. `Ctrl+B` joined 2026-10-23 for the same reason — it is the GUI's only witness for the keyboard chord, the web's being `browser-clicks.mjs` |
| `clicks.mjs` — real mouse events at real keypad buttons | **pass** — 9 buttons clicked by label, 10 actions in order (the `Ctrl-K` toggle plus one per button). A bare `return` in the `mousedown` listener leaves the whole fast gate green while every button is dead; only this reddens |
| Field Mark, Newline vs a live host | **NOT DONE** — neither has been pressed at a host. On `docs/live-testing.md`'s next-run list |
| any keypad **button** vs a live host | **NOT DONE** — the 2026-09-21 runs drove the CLI, which shares `applyAction` with the button but not `mousedown` → `hitTestAt` → IPC. The click path remains offline-only (`clicks.mjs`) |
| TN3270E vs **recorded real hosts**, via x3270's `playback -b` | **pass — 10 of 10 traces**, host-free, by `drive-playback.py`. Replays ten different real hosts (two commercial VTAM systems among them) and asserts our replies byte for byte: `WILL TN3270E`, `DEVICE-TYPE REQUEST` with the right model, `FUNCTIONS REQUEST` including BIND-IMAGE, and the full backoff where the host answers `WONT`. Mutation-verified — corrupting the device type or reversing the DEVICE-TYPE operand order reddens all six, and **that operand-order bug is one real s3270 accepts silently**. **Four of the six stop at FUNCTIONS** (a scripted keystroke this harness's short script never drives, or a BID reply we do not implement — see `docs/live-testing.md` for which reason applies to which trace), matching 3 blocks each. **Two get further, and both are new.** `sscp-lu-data.trc` reaches a **real BIND** — 4 blocks (3, 19, 11, 8 bytes), PLU name `IBM0SMAA` — giving BIND parsing its first real-host witness. `wont-tn3270e.trc` reaches **5 blocks** (3, 19, 11, 3, 3): its host withdraws TN3270E with `WONT` rather than `DONT`, and since `e789b4f` we answer `WONT` and fall back to classic TN3270 as real s3270 does, so that trace is the witness for **that** fix. It stops on a `wrongTerminalName` color-digit divergence that is not our defect. **And since NEW-ENVIRON landed, FOUR MORE traces are drivable and each matches NINE blocks** — `devname_success.trc`, `devname_failure.trc`, `devname_change1.trc`, `devname_change2.trc` — further than every other case here, because option 39's per-request `DEVNAME` exchanges interleave with TN3270E's own steps. `devname_success.trc` was the trace this project originally wanted as its BIND witness and could not drive at all; it now reaches a real BIND with PLU `IBM0SMAJ`. **Mutation-verified to cover the iteration mechanism, not merely the negotiation:** disabling the device-name counter's increment reddens all four with values like `bar0` for `bar1` |

The paragraph under the table:

Both Hercules systems are IPLed by hand by the author; `docs/live-testing.md` is both
the runbook and the log of what was found doing it, including the failures. That last
part is deliberate — the write-ups record six self-inflicted diagnostic mistakes, and
they are the most reusable thing in the file.

## From README § License (moved 2026-11-12)

Note the reference material this project was built against is **not** covered by
that licence and is not redistributed here: IBM's GA23-0059 3270 Data Stream
Programmer's Reference, x3270 (Paul Mattes, BSD-3-Clause), tnz/zti, and the host-side
`IND$FILE` implementations. The `packages/fixtures/` captures are our own recordings
of traffic between this client and hosts the author runs locally.

## From README § Using the web gateway (moved 2026-11-12)

Three paragraphs on the keypad overlay, as they stood:

**`Ctrl-B` gives the full 122-key keyboard here, as the same kind of overlay**, and **opening
either surface closes the other** — two things claiming the page at once is a state the operator
cannot read. Both toggles are intercepted CLIENT-SIDE and never reach the gateway, which holds no
state for either.

**Clicking a button is an ordinary action** — the same message a keystroke sends, so **nothing
about the protocol changed** to add it. The keypad itself is now **entirely client-side**: the
toggle never reaches the gateway, which holds no keypad state at all. It used to be a region of the
draw list the server built, with a flag held **per connection** rather than per session — because a
3270 session deliberately outlives its socket, so a keypad forced on whoever attaches next,
possibly a different person, is not a preference worth inheriting. That reasoning survived the
move: the overlay starts hidden on every page load, which is the same rule one layer up.

**The screen no longer grows when the keypad opens**, since the overlay floats over it rather than
being appended below. A model 4 taller than the viewport still scrolls, as it always did.

## From README § Layout (moved 2026-11-12)

The layout block and the paragraph under it, as they stood:

```
packages/core      protocol: telnet framing, 3270 parse/execute, screen, keyboard, OIA,
                   color resolution, Query Reply, IND$FILE, trace
packages/frontend  rules every front end shares: host argument, TLS flags, session
                   factory, keymap, action dispatch, binding intent, the keypad key table
packages/canvas    the canvas renderer, glyph atlas, keymap-to-action layer and the virtual
                   keypad's layout and hit-testing, shared by the GUI and the web gateway
packages/cli       s3270-style scripting CLI
packages/gui       Electron GUI: canvas renderer over a 3270 bitmap-font atlas, plus a second
                   HTML BrowserWindow for IND$FILE transfers (its own preload and boot module)
packages/tui       c3270-style terminal front end, plus the live/pty harnesses
packages/web       browser gateway: the same renderer, served over a WebSocket
packages/fixtures  recorded traces, golden screens, x3270 reference captures
docs/              spec, plans, live-host runbook, handoff
```

Start with `docs/HANDOFF.md`. The design spec is
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md`, the stage-1 plan is
in `docs/superpowers/plans/`, and `docs/live-testing.md` is both the runbook for
recording against a real host and the log of what was found doing so.

## From README § Staging (moved 2026-11-12)

The whole section, as it stood. The README now keeps one line per done item and a short
remaining list.

Done:

1. **Protocol core + s3270-style CLI.**
2. **Extended data stream + Query Reply** — configurable terminal type, five Query
   Reply units, SFE. This is what MVS/TSO requires, and it was reprioritised ahead of
   the GUI because MVS 3.8j is expected to be the largest group of users.
3. **`IND$FILE`** (CUT mode), both hosts, both directions.
4. **3279 color and the TUI** — per-cell extended attributes, four-level color
   resolution, terminfo-driven depth detection, and a c3270-style front end.
5. **TLS** — and it did jump the queue, for the reason earlier drafts of this section
   predicted: a 3270 client that cannot do TLS is unusable against anything modern.
   **On by default**, with `-cafile`, `-noverifycert` and `-insecure`; s3270's option
   spellings with its default inverted. Verified against both hosts through an in-repo
   TLS proxy, since neither Hercules system can speak it — and, since 2026-11-08, by the user
   against a real TLS host (`pubvm.org` port 623, a public VM/SP 5 or VM/ESA 2.4 system whose
   Let's Encrypt certificate verifies against the system store, so the default verified path is
   the one exercised; see `docs/live-testing.md`). Client certificates,
   `-accepthostname` and negotiated `START_TLS` are **not** done — see *What is not
   implemented*.

6. **TN3270E proper** — the telnet option (40), DEVICE-TYPE/FUNCTIONS subnegotiation,
   the data header, SNA responses, SYSREQ, device-name (LU) selection, and now
   BIND-IMAGE with BIND/UNBIND. Separated from item 2 deliberately: measurement shows
   TSO needs neither the option nor any of this, so bundling them would have delayed a
   working TSO session for no benefit. **Done, including BIND/UNBIND**, and it remains
   the stage with no *host* verification path for anything past DEVICE-TYPE — neither
   Hercules system offers the option, and the one public host that does withdraws it
   (its own fault: real s3270 is refused too) before FUNCTIONS. What stands in for a
   host is a **recorded** one: x3270's `playback -b` replays a real host's TN3270E
   negotiation including a real BIND, and our client is diffed against it byte for
   byte. See *TN3270E* and *Verification*.

7. **The Electron GUI** — done, and verified against both live hosts. Canvas renderer over
   an atlas baked from x3270's own bitmap font; the window sizes itself to whatever model
   the host negotiates. Not everything about it is live-verified, and the spec says so: PF
   and Clear travel the same path as typing but were not exercised live in this sandbox, and
   no VM logon has been attempted here — that arms VM's reconnect trap and could put a
   password in a screenshot. **An MVS TSO logon has been completed live, though**: through
   the GUI itself, by the user on their own Mac, at 43 rows; and separately in this sandbox
   as `HERC03`, over the CLI's identical AID wire path — which is what confirmed PA1 and PA2
   each get a real, distinct host reaction. See *Using the GUI*. **Both halves of the PA1/PA2
   gap are now closed**: the protocol half by those host reactions, and the local half first by
   hand (the author reported PA1 working from a real keypress against MVS on 2026-09-15) and
   then by `packages/gui/scripts/keys.mjs`, which drives 19 real Chromium chords and asserts 17
   ordered actions plus two required absences. The packaged app is now smoke-tested too
   (`npm run smoke:package`, and in CI on five OS/arch runners), merged 2026-11-06 — see *Installing* and `docs/releasing.md` for what is still owed before a release.

8. **A webserver serving the same front end** over HTTP — done, and verified against both
   live hosts. `packages/web` serves the GUI's own canvas renderer to a browser over a
   WebSocket; the canvas layer moved to `packages/canvas`, which both front ends now share.
   That the renderer is genuinely shared rather than merely similar is checked in pixels
   against the Electron app's own screenshot golden. See *Using the web gateway*.

9. **A menu of special keys, and a show/hide virtual keypad** — done. Requested 2026-09-14 and
   moved ahead of Programmable Symbol Sets on 2026-09-15. `Ctrl-K` shows a clickable 48-button
   keypad in the Electron GUI and in a browser, and opens a keyboard-navigable list of the same
   keys in the TUI, which has no mouse. It brought canvas hit-testing with it, and made **Dup,
   Field Mark, Sys Req and Newline** reachable — four keys `core` could do and no interactive
   front end could press. Proven with real mouse events (`clicks.mjs`) and in pixels, identically
   in Electron and in the browser. **THE CANVAS KEYPAD THIS DESCRIBES WAS REPLACED ON 2026-10-06**
   by real HTML controls in both front ends, and the canvas hit-testing it brought was deleted
   with it — the author's verdict on the drawn version was *ugly* and *modal*. The 48 keys, their
   actions and the TUI's list are unchanged; `clicks.mjs` still proves nine of them by label, now
   through DOM clicks. The pixel half of that proof is gone, because HTML in system fonts is not
   reproducible the way a blitted atlas is. At the time this was written the mouse did keypad buttons and
   nothing else; **drag-to-select landed later, for the GUI's copy and paste** (see *Using the
   GUI*). **Click-to-place-cursor and the light pen are still absent**, and text selection is
   **not** the light pen: `lightpen_select()` sends an AID and sets MDT, so a selection built on it
   would transmit on every copy attempt. x3270 keeps the two apart deliberately, and so does this
   implementation — the selection path sends no AID at all. **Sys Req was
   reachable but inert on this branch until the classic path landed**; it now sends a test
   request read, **live-verified on both hosts 2026-09-21** — see *What is not implemented*.

Remaining, in the order the author wants it.

**REORDERED AGAIN 2026-10-05: GUI COPY AND PASTE went first of all of these, ahead of the GUI
keypad window — and is now BUILT** (see *Using the GUI*; the live paste against a real host is the
one piece still unwitnessed). It is a fifth UI item rather than one of the four below:
`docs/superpowers/specs/2026-10-05-gui-copy-paste-design.md` and
`docs/superpowers/plans/2026-10-05-gui-copy-paste.md`. The reason is the user's experience of the
shipped GUI — *neither copying text out of the window nor pasting into it was possible*, which is a
**behaves-like-a-normal-application** gap and so belongs before packaging, on the same argument that
put packaging ahead of graphics. The keypad window is a restyle of something that already works;
this is absent capability. **Text selection here is NOT the light pen** — that distinction is spelled
out two paragraphs above and is why the light pen keeps its own later spec.

**AND THE WEB GATEWAY REACHES PARITY BEFORE PACKAGING, decided by the user the same day:** **web
copy/paste** and the **web transfer form** are both required before any packaging work. Web copy
needs its own spec rather than coming along with the GUI's — a claim the GUI's spec made and
implementation disproved. `sendAction` crossing the WebSocket transmits the *action* for free, but
nothing can return the *text*: the server's only messages to a browser are `frame` and `error`, the
bridge has no clipboard function, and the browser's renderer holds a draw list whose cells carry an
atlas glyph and no character — so the gateway would extract the text onto its own machine rather than
the operator's. Until that lands the gateway **refuses** `copy` at decode, and the refusal is
load-bearing: without it the first browser copy would end the gateway process and every session on
it. **(Web copy and paste LANDED 2026-10-27; see *Copy and paste*.)**

**REORDERED 2026-09-30: the four remaining UI pieces come FIRST, ahead of oversize and everything
after it.** Two features across the two canvas front ends — ~~the GUI transfer UI~~ (**BUILT
2026-10-01**), ~~the GUI keypad window~~ (**BUILT 2026-10-06, and it took the WEB keypad with
it**), then **the web transfer UI**, so one of the original four remains. They were grouped
deliberately rather than by coincidence: the shared halves already exist in `packages/frontend`
(`transferForm.ts` and `transferRun.ts` for transfers, `keypad.ts` for the key table), so doing
them consecutively means the GUI's answer is still in hand when the browser's is written.

**AND THAT GROUPING PAID OFF MORE THAN EXPECTED ON THE KEYPAD: the two front ends landed in ONE
change rather than two.** The plan had the web following later, which is what the idea doc assumed
too — but once the keypad was real HTML controls, the view itself (`keypadUi.ts`) was shared
outright, and the only thing that differed was the container: a window in Electron, an overlay in
the browser. Doing the second front end separately would have meant building that view twice or
extracting it afterwards. The flip side is that the canvas keypad ended up with **no** consumers
rather than one, so it was deleted rather than left for the gateway.

Interleaving these with oversize would have meant deciding twice what a native-window front end
looks like. It also settled everything the **menu bar** touches — the keypad needed one, and so
does the connect dialog — before packaging puts that chrome in front of a first-time user. Items
11 onward keep the order agreed on 2026-09-29.


9a. **Interactive `IND$FILE` — stages 1, 2 and 3 of four are DONE.** The transfer itself was finished and
   live-verified long before any interactive front end could reach it, which is the same shape as
   Sys Req and Newline before item 9. **Stage 1, the TUI's `Ctrl-T` form, is built** — see
   *Using the TUI*. **STAGE 2, DFT, IS DONE AND LIVE — 2026-09-29.** It matters because it is
   **geometry-free**: `ft_dft.c` contains zero screen-buffer references against 25 in `ft_cut.c`, so
   it moves data through structured fields rather than the display, and it is what lifts the 24x80
   restriction CUT imposes. **Measured on MVS 3.8j TK5 at 43x80: 11 DFT frames, zero CUT frames, 249
   bytes byte-identical both directions.** The last piece was not the engine but the *selection* —
   nothing chose DFT, so `startDftTransfer` had no caller outside tests; both drivers now build both
   engines and the first inbound frame decides, because the host chooses and not the client.
   **MVS/TSO DOES offer DFT, measured 2026-09-24** — an earlier version of this line said neither
   Hercules host spoke it. What was really missing was on *our* side: a host offers DFT only to a
   client that advertised the Query Reply (DDM) unit, and we had never sent one. See `-ddm` under
   *Using the CLI* and the wire bytes in `docs/live-testing.md`. VM/370's MECAFF declines it and
   stays on CUT, which makes it the control. **Stage 2 is now COMPLETE**: `Transfer(BufferSize=N)`
   sets the DFT frame size, and it is the SAME number advertised in the DDM Query Reply — verified
   live, `BufferSize=512` moving the host's own `Open` record size to 495.
   **STAGE 3, THE GUI's TRANSFER WINDOW, IS BUILT — 2026-10-01**:
   `docs/superpowers/specs/2026-09-30-gui-transfer-ui-design.md` and
   `docs/superpowers/plans/2026-09-30-gui-transfer-ui.md` (ten tasks, all executed). It was a
   renderer rather than
   a rewrite — the model and the driver were already shared in `packages/frontend`, and the `Xfer`
   keypad button already existed — but **not a CANVAS renderer**, which earlier drafts of this line
   assumed. The user's decision was a **separate `BrowserWindow` with real HTML controls** and a
   native file dialog for the local file: the canvas preload has to stay at four functions for
   `renderer.ts` to keep being shared with the browser, and teaching a canvas text editing, focus and
   a file chooser buys nothing. x3270 puts its own transfer dialog in Xaw widgets for the same reason.
   **Stage 3's live verification LANDED 2026-10-02**: VM/CMS drove the window for real (249 bytes
   both ways, byte-identical, twice) and the user verified the macOS dialog by hand in ASCII mode.
   **TSO/DFT is still unrun.** The work also found that **`Ctrl-T` in the GUI was DEAD** — mapped in
   `frontend` and absent from `canvas/src/keys.ts`, so the chord did nothing while the keypad button
   worked, which is why `keys.mjs` now drives it.
   **Stage 4** is the web gateway, and it is a security decision before it is a UI one: the gateway
   still **refuses** the action, because a browser-initiated transfer would move bytes to the
   gateway's filesystem and not the operator's — **and the refusal message now says that**, where it
   used to blame a missing front end. **The decided answer is real browser file I/O** —
   bytes over the WebSocket, so "local file" means the operator's machine — which is a new protocol
   message pair, chunking and a `TransferFiles` over the socket, and therefore its own spec.
10. **Programmable Symbol Sets** — its hard dependency is item 2's Query Reply (the host
   sends no PS structured fields until the capability is advertised), not TN3270E as
   earlier drafts of the spec assumed. The GUI's blitter was built with this in mind: a PS
   glyph is a host-supplied bitmap, which is exactly what it already draws, so PS should be
   an addition rather than a second renderer.
**THE ORDER HERE IS THE USER'S, 2026-09-29, AND THE REASONING IS WORTH KEEPING.** Packaging came
ahead of all graphics work because *without graphics this is still a useful tool, but without
packaging it is a hard one to RUN*. Then oversize moved ahead of packaging in turn, so that **strange
screen sizes are available in the first packaged build a user ever sees** — a shipped app that cannot
do the geometry an operator's host asks for is a worse first impression than a shipped app with no
vector graphics.

**And printer sessions moved BACK, behind graphics, for a reason the research already supports:
GDDM drives printers and plotters as output devices, so the printing work is likely CONVOLVED with
vector graphics rather than independent of it.** `docs/goca-reference-notes.md` says the same thing
from the other side: the primary GOCA reference is the **AFP edition, bound to MO:DCA and IPDS —
printers** — and the 3270 binding is what diverges from it. Doing printers first would mean building
an SCS/3287 path and then revisiting it once GOCA lands; doing graphics first means the printer work
can reuse whatever the drawing layer turns out to be. **Cheap is not the same as first.**

11. **Oversize + `IBM-DYNAMIC`.** **Step 1 (the `-oversize` flag) is done on branch `oversize`,
   2026-11-04; see *Oversize*.** **Step 2, changing the model and oversize while running (applied at
   the next connect), is done on the same branch, 2026-11-05: the CLI's `Set()`, the GUI's Model
   menu and the browser's `Alt-M` picker.** Really oversize — the advertisement is a by-product. See the
   out-of-scope section of the bind-image spec for the measurements.
12. **Local model-switching** -- **DONE as item 11's step 2, 2026-11-05**: a choice applies at the next
   connect, never to a live screen, so it adds no client-driven mid-session resize; what follows is
   the reasoning that scheduled it, kept for the record. Immediately after it and before packaging. The two belong together:
   both let the *user* do unpredictable things with their window, and in the code both drive the one
   `Screen.resize()` path — which today has four callers, all in `core` and all HOST-driven (EW/EWA
   and BIND/UNBIND). These two add the first CLIENT-driven resizing, so they meet the same questions
   about renderer invalidation and mid-session geometry change; answering those once is the point of
   scheduling them adjacently. x3270's `Common/model.c` is the reference to steal.
   **Neither is well testable against any host reachable from this project** — `IBM-DYNAMIC` has one
   live path (TK5's TSO issues a Read Partition to any `-E` client) and a client-initiated switch has
   none, so expect unit tests, the playback oracle and by-hand GUI runs rather than a live witness.
13. **Packaging, for macOS, Linux AND WINDOWS — DONE, merged into `main` 2026-11-06 (`5669a3a`).** npm
   packages for all four front ends (`@tn3270/cli`, `@tn3270/tui`, `@tn3270/web`, `@tn3270/gui`,
   lockstep version, Node ≥20.19 since 0.1.1), and native installers via electron-builder: macOS universal
   `.dmg`/`.zip`, Linux x64 and arm64 AppImage/`.deb`, a Windows x64 NSIS installer — all unsigned
   in that milestone (signing came later: item 14). Build, test, pack, smoke and package all run on five CI runners (ubuntu-latest,
   ubuntu-24.04-arm, macos-latest, macos-26-intel, windows-latest), and all five passed on
   2026-11-06 (run 6), and again on the merge commit — see `docs/HANDOFF.md`. **Published to npm as
   0.1.0 on 2026-11-08** (the registry's tarballs are byte-identical to CI run 42504570737's, on tag
   `v0.1.0`); nothing was signed then. The hand checks were done by the user on 2026-11-08: macOS on Apple Silicon
   runs once permitted (*Open Anyway*), and the Linux arm64 `.deb`, Linux x64 AppImage and
   Windows 11 all just run, each through the Connect dialog (on Linux launched from a shell, as
   neither box has a desktop environment).
   The Windows target was a deliberate addition rather than a stretch goal: there are **zero
   native dependencies** (every package depends only on other workspace packages, with Electron
   the single external), and there is not one `process.platform` branch anywhere in
   `packages/*/src`.
**ROADMAP FROM HERE, AGREED WITH THE USER 2026-11-06, after packaging merged.** It supersedes the
old items 14 (PS + VMGIF, then GOCA) and 15 (printer sessions last). Two corrections came with it,
both below: **VMGIF cannot run without GDDM** (measured from its module), so our own GIF-to-PS
converter is the test vehicle; and **the printer splits in two**, so "printer last" no longer
holds as one item.

14. **Close out packaging.** The live checks by hand are **done** (the user, 2026-11-08: Apple Silicon
   macOS runs once permitted, the Linux arm64 `.deb`, Linux x64 AppImage and Windows 11 just run;
   Connect dialog used on each). The first
   `npm publish` is **done** (0.1.0, 2026-11-08), and so is the icon (see *Installing*). **npm
   trusted publishing from GitHub Actions is built and proven** (2026-11-09): a pushed
   `vX.Y.Z` tag runs `.github/workflows/package.yml`'s `release-check` and `publish` jobs, which
   publish the CI-built tarballs over OIDC after one approval in the `npm` GitHub environment, with
   provenance and no long-lived npm token anywhere, then read the registry back to prove it landed.
   **Proven by release 0.1.3** (0.1.2 was skipped, a path bug in the publish job): published by
   "GitHub Actions", every shasum equal to the run's tarballs, an SLSA provenance attestation per
   package, `npm audit signatures` verified (`docs/releasing.md`, *Release history*). **The same tag
   run now also cuts the GitHub release** (built 2026-11-09, branch `gh-release`; proof owed:
   release 0.1.4): a `github-release` job after `publish` attaches the run's seven native
   installers and a `SHA256SUMS`, with notes from the version's `CHANGELOG.md` entry, which scriv
   collects from a fragment written with each functional change (`docs/releasing.md`).
   **macOS code signing is built and proven** (2026-11-10; merged 2026-11-11 as `db5a93d`; a
   signed CI run, 42959265358, signed, notarized, stapled, verified and launched the app). A tag
   run signs the mac app with a Developer ID, notarizes and staples it, and verifies it
   (`docs/releasing.md`, *Code signing*). **Windows is not signed in CI**: Azure Artifact Signing
   was dropped (no Azure subscription; spec amendment 2026-11-11), and every run verifies the
   Windows installer is unsigned. Windows signing is planned through the **Microsoft Store as an
   MSIX** (Microsoft signs it); the unsigned NSIS `.exe` stays a release artifact. The Mac App
   Store is planned too, and neither store gets a submission before x3270 parity.
   **Store probe** (2026-11-12, merged `559ea78`): every CI run builds and launches an
   App-Sandboxed Mac App Store stand-in and an installed MSIX, each proving its confinement and
   passing package-smoke's two checks; nothing is uploaded (`docs/releasing.md`, *Store probe*).
15. **The rest of the GUI ("milestone B").** `File` → `Connect…` in a running window (which means
   hoisting the startup block's once-only IPC handlers and quit hook), recent hosts, a config file
   and preferences, light and dark modes, font choice. Moved up from the "super-terminal" stretch
   goal because it is what a person who has just installed the app meets first.
16. **Code pages.** Only `cp037` exists (`packages/core/src/codepage.ts`), which is wrong for any
   host outside the US: 273 (Germany/Austria), 285 (UK), 297 (France), 500 (international), 1047
   (z/OS Unix), the 1140-family euro pages, and so on. Self-contained, and a correctness gap rather
   than a feature. **DBCS** (Japanese, Chinese and Korean hosts) is a separate, larger item and is
   not scheduled.
17. **Click-to-place-cursor, then the light pen.** Own spec, as already recorded above: the light
   pen (`lightpen_select()`) sends an AID and sets MDT, so it must not be built on text selection.
18. **Text printing.** A 3270 printer session is a separate telnet session to a printer LU; the host
   sends SCS (LU type 1) or the 3270 data stream addressed to a printer (LU type 3). Output to a
   text file, a PDF or the OS print dialog. Reference: x3270's `pr3287`. The LU3 side reuses the
   existing data-stream parser; SCS is the new decoder. Cheap, and placeable anywhere; here because
   it does not depend on graphics.
19. **Programmed Symbols — the 3279's all-points-addressable graphics — tested with our own
   `gif2ps`.** On a 3279, APA graphics WAS PS: the host loads pixel patterns into loadable symbol
   sets and then writes characters from them. The emulator needs the Load PS structured field,
   the symbol-set selection attribute, and drawing host-supplied cell bitmaps (the blitter was built
   for this; see item 10). **The test vehicle is a converter in this repo, `gif2ps`**: decode a GIF,
   map it onto the 3279 palette, cut it into cells, reuse identical cells, and emit the PS loads and
   screen writes as a trace, replayed through the existing seams and screenshot goldens, or served
   by a fake host. No mainframe needed. **Before planning, read the 3279's PS capacity from the 3270
   Data Stream Reference (GA23-0059), not memory**: the number of loadable sets and symbols per set,
   cell size per model, and the colour-plane format; together they cap how many unique cells an
   image can use. A later, separate step for authenticity: a small CMS program on VM/CE that writes
   the same generated stream to the terminal (what VM/370's CMS offers for full-screen output needs
   checking; MECAFF shows it can be done). **Truly native APA terminals (3179G, 3192G, 3472G), which
   took graphics data directly rather than through PS, would be a separate later item if wanted.**
20. **Printer graphics through PS, IF it is real.** As understood (to verify against GDDM's device
   documentation before relying on it), GDDM printed graphics on 3270-family printers that had the
   PS feature (some 3287 and 3268 models) with the same PS mechanism as the screen. If so, this
   follows item 19 almost for free. GOCA/IPDS page-printer output (MO:DCA, channel- or SNA-attached
   printers) is out of scope unless a need appears.
21. **GOCA vector graphics.** Unverifiable until the user finds a host with GDDM that this client
   can reach; that same host is also the only way to run VMGIF itself. `docs/goca-reference-notes.md`
   holds the research.
22. **Stretch goals.** (a) The "3270 super-terminal": antialiased fonts, any font rather than only a
   3270 face, GOCA rendered directly as SVG. (b) **5250 support**: the terminal hardware is close to a 3279 and
   the protocol not far off; RFC 1205 (TN5250) is the spec to work from, and the user's System/36
   emulator is the host to validate against. The front ends already separate protocol from
   rendering, which is where a second protocol would plug in. Emulator support for 5250 is far
   thinner than for 3270, so expect less to compare against.

**Also open, not scheduled above** (see *What is not implemented*): MF orders are parsed and not
applied; `Attn` sends `IAC BREAK` on TN3270E where x3270 sends `IAC IP`; NEW-ENVIRON carries only
a device name; no TLS client certificates; the web gateway has no connect dialog and takes fewer
flags; `forwardKeys` forwards action kinds from the GUI's child windows unfiltered; the keypad's
appearance has no visual test; on Linux at a forced scale factor 2 glyph edges are blended where
Retina macOS doubles cleanly (found 2026-11-06, not investigated); accessibility (screen readers,
keyboard-only use of the dialog and menus) and auto-update have never been looked at. Live
witnesses still owed: TK5 against oversize, a modern z/OS or z/VM host (real TN3270E,
`IBM-DYNAMIC`, BIND size 0x03 — `pubvm.org` does not fill this: probed 2026-11-08, it negotiates
TTYPE, EOR and BINARY only and never offers TN3270E), the GUI Model menu on a real desktop, CLI
`Set()`+reconnect against VM, Sys Req over TN3270E, keypad buttons against a host.

Alternate screen sizes and models 3, 4 and 5 are complete and live-verified, and were merged long
ago — an earlier version of this line said they were sitting unmerged on a branch, which stopped
being true on 2026-08-27. Adding screen sizes turned out not to be part of TN3270E at all — the
geometry rides in the terminal-type string — so it never depended on item 6.

## From README § Graphics: the fidelity target, and why GDDM is not the route (moved 2026-11-12)

The whole subsection, as it stood. Superseded by the plan to do Programmed Symbols and then GOCA,
tested against a GDDM-licensed host the author has found.

The target is what a real 3279 could display, and the concrete reference is the
GIF viewing Rick Troth was doing on his own 3279 around 1992. **Provenance now
established from Troth himself**, which corrects earlier drafts of these docs:
the viewer was reached through **CMS Gopher** (his, Rice University, 1993 —
`troth@rice.edu`), but Gopher did not contain it. `GOPHER24 FILELIST` says so in
one line:

```
* To display GIFs with CMS Gopher, get the VMGIF package from BLEKUL11.
```

So CMS Gopher dispatched to a separate package, **VMGIF from BLEKUL11** (the VM
system at Katholieke Universiteit Leuven), via a `GOPCLIGV REXX` glue exec.
`GOPHERT GIF` in the archive is a test image, not the viewer. Local copies of
CMS Gopher 2.4.2 are in `$HOME/cmsgopher`; the `.tar.gz` pair yields only
`FILELIST` and `README`, `gop242s.vmarc` unpacks to service patches, and
`gopher24.vmarc` has not been unpacked (`:CFF` compressed members).

**VMGIF HAS SINCE BEEN FOUND — BUT AS OBJECT MODULES ONLY.** It is on disk at
`$HOME/vmgif`, dated April 1993: `VMGIF.MODULE.T1` at 84600 bytes, the wrapper execs,
`HELPCMS`, and `TONETABL` — its palette/dither table, which is the most directly useful
piece. **There is no source.** **AND IT CANNOT RUN WITHOUT GDDM — MEASURED 2026-11-06 from the
module itself:** GDDM's application interface stub is linked in with its build tag beside it
(`ADMASLV 91067 V2R3.0 PL77871`, GDDM V2R3, linked March 1991); the loader table resolves `FSINN`,
`GSWIN`, `GSSEG` and twenty-odd `ADM*` entry points to that stub, which passes them to GDDM's
resident code; and its own messages assume GDDM (`Sorry, GDDM could not open the device`, `This is
not a graphics device`, saving to `ADMGDF`). The wrapper EXEC loads nothing because sites provided
GDDM as a shared segment. So running VMGIF needs the same GDDM host as GOCA, and **our own
`gif2ps` (roadmap item 19) is how PS gets tested.** Disassembling it is probably unnecessary: decoding GIF
from the published spec is no harder than reverse-engineering a 1993 implementation once
PS can push pixels, so VMGIF is best treated as a *behavioral* reference — evidence of
what a 3279 could be made to do, and a palette to compare against.

**VMGIF used GDDM, and we will not.** IBM is sunsetting GDDM and would be
unlikely to license it even to a current paying VM customer, so the route for us
is **Programmable Symbol Sets driving the 3279 screen directly** — decomposing an
image into custom character cells and loading them, which is how the era's
viewers worked underneath anyway. GDDM would need those same primitives beneath
it, so nothing is wasted by starting there.

**A stretch goal, recorded because it is the natural end point:** an open-source
implementation of the GDDM spec targeting VM/370 R6 and MVS 3.8j. That would let
period-authentic graphics software run against these hosts rather than only our
own client. Unscheduled, and much larger than this project.

## From README § Using the TUI (moved 2026-11-12)

The no-host prompt's dated heading and its wording note, as they stood:

**`tn3270` with no host, run AT A TERMINAL, prompts for one instead of the usage error**
(2026-11-08), the TUI's counterpart of the GUI's Connect dialog:

[...]

in any case, or Enter for the default. **A host starting with `-` is refused** before Model or TLS
are even asked. A failed connect prints the failure and starts a new round, with the last round's
answers as this round's defaults — the TLS-plaintext-host cases read `Answer n to TLS: ...` here,
a third wording alongside `-insecure` on the command line and `Untick TLS in the Connect dialog` in
the GUI. **`Ctrl-D` (EOF) or `Ctrl-C` at any prompt quits**, exit status 1 — nothing was

The keypad list's chord sentence (20 of the 22 blanks were in fact bound F-keys; corrected in the README) and the opacity fix, as they stood:

(**Sys Req** and **Newline** included) would be unreachable. That is the point of the list: those
two are the keys with no chord anywhere, and this is their only keyboard route. Each line shows
the key's chord where it has one, read from the same `BINDING_INTENT` table the keymap is checked
against, so 22 of the 48 correctly show a blank rather than a guess.

**The list is opaque, and that took fixing.** Every line is padded to one width — 27 columns: the
selection mark, the name column, a two-space gap and the widest chord — so the 3270 screen behind
it never shows through. It used to draw each line at its natural length, and the 22 lines with no
chord therefore ended at the name: on a pty against a host whose first row read `HELLO TN3270`, the
PF16 line rendered as `  PF16 TN3270`, which reads as though `TN3270` were PF16's chord. Against a
real MVS or VM screen every chordless line would have invented one that way. The selected line is
a full-width reverse-video bar for the same reason.

`Esc` mid-transfer, as it stood (CUT only; DFT became the default on 2026-09-29):

**`Esc` mid-transfer ABORTS** — `CutTransfer.cancel` writes the response area and presses PF2, so
the host leaves transfer mode rather than waiting for a frame that will never come.

## From README § Connecting over TLS (moved 2026-11-12)

That same failure is worded for the GUI's Connect dialog (`Untick TLS in the Connect dialog: ...`,
naming the checkbox beside it) and the TUI's no-host prompt (`Answer n to TLS: ...`) — see
*Installing* and *Using the TUI*.

**A plaintext connect has a deadline too: 30 seconds** (`CONNECT_TIMEOUT_MS`, since 2026-11-09).
A host that silently drops packets used to be given up on only by the OS's TCP retries, around
two minutes on Linux. Now it is `cannot connect to HOST:PORT: no answer within 30 s
(CONNECT_TIMEOUT)` — measured against the blackholed TEST-NET address 192.0.2.1: exit 1 after
31 s. It is a connect deadline only, disarmed the moment the socket connects, so an idle session
is never dropped by it.

**A host that is down or misspelled is not a TLS problem, even with TLS on.** Refused, no such
host, unreachable and timed-out connects happen before any TLS byte is exchanged, so every front
end words them as `cannot connect to HOST:PORT: connection refused (ECONNREFUSED)` or `no such
host (ENOTFOUND)`, never `TLS connection to ... failed` (since 2026-11-09; before, only a
plaintext attempt was worded that way). A reset or a stall during the handshake is still a TLS
failure, and says so.

## From README § TN3270E (moved 2026-11-12)

**We ask for BIND-IMAGE, RESPONSES, SYSREQ and CONTENTION-RESOLUTION.** Grant
BIND-IMAGE and send no BIND, and real s3270 never enters 3270 mode at all: the
Erase/Write is delivered and silently ignored (x3270's `telnet.c:2339`, and the gate
at `:2681` that drops 3270 data until `tn3270e_bound`). That hazard is real and we do
not deny it — but 29 of 29 hosts in x3270's own trace collection that grant
BIND-IMAGE send a BIND in the same turn as FUNCTIONS (counted by bytes across all 71
traces, not by grepping decoded `< BIND` lines, which older traces do not carry), and
the advertise-then-stay-silent case exists only in our own `e-server.py`, which we
configured to do it. So we ask for the function and refuse to inherit the hang
instead: a 3270-DATA record that arrives before any BIND is **retained, not dropped**,
and a **5-second timeout** (`-bind-image` cannot change the duration, only whether the
gate exists at all) executes it at our own geometry if no BIND shows up. x3270 has no
such timeout and would simply sit there.

**Why 5 seconds and not one round-trip.** Every host in x3270's traces binds
immediately, so a much shorter deadline would satisfy all of them — but some of this
client's users are on real 370-class hardware (P/370s and similar), not an emulator,
and that hardware is slow and has no other working client. A short timeout would
punish exactly the users who can least afford it. The constant is `NO_BIND_TIMEOUT_MS`
in `packages/core/src/bind.ts` and is deliberately easy to find for anyone who needs it
longer.

**One deliberate difference from s3270, still an open question (found 2026-09-17).**
`-model 3278-2` makes us send the bare `IBM-3278-2` as the TN3270E DEVICE-TYPE. **s3270 sends
`IBM-3278-2-E` there whatever the model** — it appends `-E` unless extended data stream is
off or the `S:` prefix is used, so `-model` reaches only its TERMINAL-TYPE. RFC 2355 permits
both, and `-model 3278-2` meaning "not extended" arguably makes the bare form the more honest
one, so this is **recorded as a decision to make rather than a bug**; no host has been
observed caring. With no `-model` flag both clients send `IBM-3278-2-E`.

## From README § Using the CLI (moved 2026-11-12)

**`Transfer`** is `IND$FILE`, and it works on both hosts in both directions and in both protocols —
the host chooses CUT or DFT.
**The TUI and the GUI reach it too, through `Ctrl-T`** — the same validator and the same command
builder, so a form, a window and a script cannot disagree about what is legal. The browser is the
one front end that cannot; see *What is not implemented*.

(The browser has transferred files since 212df60, 2026-10-06.)

**`-ddm on` IS HOW YOU GET DFT, AND IT IS NOW SAFE TO PASS WHILE TRANSFERRING A FILE.** Earlier
versions of this README said the opposite — "do not pass `-ddm on` while transferring a file",
because a host that took the offer sent `Open` requests we could not parse and both directions
timed out at 0 bytes. **That is fixed as of 2026-09-29**: DFT is implemented and the transfer
drivers build both engines, so whichever protocol the host chooses is handled. The flag advertises
the Query Reply (DDM) unit, QCODE `0x95`, and **the client does not choose CUT or DFT — the host
does**, on seeing that unit.

| Flag | Effect |
|---|---|
| *(none)* | **the default as of 2026-09-29: DDM IS advertised**, so a DFT-capable host chooses DFT |
| `-ddm off` | advertise nothing, so every host falls back to CUT — how pre-2026-09-29 CUT runs reproduce |
| `-ddm on` | advertise DDM, QCODE `0x95`, built to match x3270's `do_qr_ddm` (`sf.c:899-906`). **A host may then answer in DFT, which now works** — and is the only way to transfer at a geometry other than 24x80 |

**THE DEFAULT FLIPPED ON 2026-09-29, which was always the plan and is the user's call.** It shipped
off on 2026-09-24 because DFT did not work yet — advertising it made a host offer a protocol we could
not parse, so every transfer would have broken. DFT now works and is live-verified, so the flag has
done its job as a measurement instrument and DFT is the better default: it is faster, and it is the
only protocol that works at a geometry other than 24x80.

**What that costs, stated plainly: the CUT path gets less live exercise than it did**, because a
DFT-capable host will now pick DFT. CUT is still fully implemented and is still the only option
against a CUT-only host such as VM/370's MECAFF. **`-ddm off` restores the old behavior exactly**,
which is what keeps every pre-flip CUT measurement in `docs/live-testing.md` reproducible — and there
is a test pinning that, because if it ever broke, that evidence would become unverifiable rather than
merely old.

**IT IS ONE NUMBER: the size advertised to the host and the size we chunk by are the same value,
read from the in-flight transfer.** That is x3270's design too — `do_qr_ddm` takes
`ftc->dft_buffersize` from the running transfer and falls back to the default only when none is
running (`sf.c:890-897`). It matters because **the host sizes its side from what we advertise**,
measured live on TK5: `BufferSize=512` moved MVS's own `Open` record size to **495** (= 512 − 17,
the DFT frame overhead) while un-keyworded transfers in the same session stayed at 16367. Before
this was wired the two could differ by 32× — advertising 512 while chunking by 16384.

The unit is inserted in ascending-QCODE order rather than appended, so a capture stays
comparable with x3270's. The flag exists because it is what *measured* which hosts offer DFT:
MVS/TSO does and VM/370's MECAFF does not, which was invisible until we sent the unit at all.
Design and wire bytes: `docs/superpowers/specs/2026-09-24-dft-file-transfer-design.md`; the
protocol-selection design is
`docs/superpowers/specs/2026-09-25-transfer-protocol-selection-design.md`.

**The advertisement's own evidence is still a live probe rather than a unit test.** `-ddm` has no
test that pins its bytes directly; what covers it is `dftSession.test.ts`'s
*the DDM advertisement through a Session* suite, which drives a real Read Partition and asserts
`0x95` is on the wire with the flag on and absent with it off — added later than the flag itself.
**And it is witnessed live**: the 2026-09-29 TK5 run shows `00 0c 81 95` in answer to the host's
own `ReadPartition`. Note that **a host may issue no Query at all** — VM did not on that day's
control run — so check `grep -c "81 95"` in a trace before reading it as evidence about DDM.
