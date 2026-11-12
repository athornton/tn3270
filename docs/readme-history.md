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
