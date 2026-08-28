# Stage 3 — the Electron GUI, and a shared front-end library

Design, 2026-08-28. Roadmap item 2 of the user's 2026-08-25 list, opened once stage 2b
(TN3270E) landed. Read `docs/HANDOFF.md` first for current state; the technology choice
and development environment were settled in
`docs/superpowers/specs/2026-08-15-tn3270-client-design.md` and are **not** reopened
here.

## What is already decided, and is not being re-litigated

From the original design, with its reasoning:

- **Electron + TypeScript**, with `electron-builder` for signed and notarised macOS
  builds. PySide6 and truly-native were weighed and rejected: Mac packaging is the
  actual hard part of shipping this, and "download a `.app` that works" is central to
  the project's purpose.
- **Testable headless.** Real Electron 43 runs under Xvfb on the development box and
  `webContents.capturePage()` produces correct PNGs — verified during the original
  design, not assumed. Toolchain at `~/micromamba/envs/gui`, no root required.
- **The renderer must dispatch on `Cell.kind`, never assume a font lookup.** `Cell` is a
  tagged variant for exactly one reason: Programmable Symbol Sets, a committed later
  deliverable. HANDOFF states this twice as the constraint to remember.

## Scope: the thinnest usable vertical slice

**In:** a window that renders the 3270 screen from a live session, accepts keystrokes,
and draws the OIA. The host comes from the **command line, with the TUI's flags
unchanged** — `-model`, `--terminal-type`, `-tn3270e on|off`, the TLS set, and the full
`[prefix:][LU,LU@]host[:port]` shape — so there is nothing new to learn to start it.

**Out, deliberately:** connect dialog, menus, preferences UI, mouse support, packaging,
the webserver front end, and Programmable Symbol Sets. Each is a later stage; none is
cancelled.

**Why this slice and not the old "stage 2" list.** The old staging bundled the dialog and
menus with the renderer and the keymap. The renderer and Chromium's keyboard handling are
where the unknown risk is — the original spec names Option/dead keys and Cmd chords as an
accepted cost of Electron, and canvas text crispness as needing explicit attention. A
connect dialog is ordinary UI work carrying none of that risk. So the uncertain part goes
first, while the result is still genuinely usable.

A renderer-only milestone (display a replayed trace, no input) was considered and
rejected: a client you cannot type into cannot be driven against a host at all, and this
project's evidence standard is live verification.

## Part 1 — `packages/frontend`, a shared front-end library

### Why, in one sentence

Two front ends already exist and a third is coming, and **the two defects fixed on
2026-08-28 were both one rule with two homes**: `splitTarget` sitting beside the
`hostspec.ts` that superseded it, and `-insecure` drifting between the two arg parsers
until `harness-flags.test.ts` pinned it. A GUI that re-implements flag parsing or the
action vocabulary is that bug a third time.

### Dependency graph

```
core  ←  frontend  ←  { cli, tui, gui }
```

Acyclic. `cli` gains a dependency on `frontend` (its `Connect()` needs `resolveHostSpec`)
and keeps everything specific to the s3270 line protocol.

### What moves in

| From | What | Why it is shared |
|---|---|---|
| `cli/src/hostspec.ts` | `parseHostSpec`, `resolveHostSpec`, `ResolvedHost` | Prefix meaning and port validation must be identical in three front ends |
| `cli/src/tls.ts` | `takeTlsFlag`, `resolveTls`, `TLS_USAGE`, `tcpConnect`, `describeTlsError`, `DEFAULT_TLS` | Already shared between two front ends for this exact reason |
| `cli/src/runner.ts` | `defaultSession` only | It wraps the TCP/TLS `Connection` adapter; the GUI needs that one transport |
| `tui/src/keymap.ts` | the module, wholesale | See the trap below — moved, not rewritten |
| `tui/src/app.ts:376-400` | the action → `Session`/`Keyboard` dispatch | ~20 lines of pure translation, identical for any front end |

### What deliberately stays put

- `cli`: `commands.ts`, `runner.ts`, `transfer.ts`, `status.ts`. These are the s3270 line
  protocol and its reply format. A GUI has no `Wait(Settle)` and no `data:` lines.
- `tui`: `render.ts` and `colours.ts`. Both are ANSI. `colours.ts` computes SGR
  parameters and detects terminfo depth; the GUI wants RGB and gets it from core's
  `colourRgb`/`PALETTE_3279`. **A third palette is not created.**
- `tui`: `tooSmall` and `statusRowFor` look shareable and are not. They encode c3270's
  rule about apportioning scarce *terminal rows* (`c3270/screen.c:412-419`, `895`), a
  concept a resizable window does not have.

### THE TRAP IN "LIFT THE KEYMAP", stated because it is easy to get wrong

`keymap.ts` maps **terminal byte sequences** to named actions. The GUI receives Chromium
`KeyboardEvent`s. So the table itself is not portable — only the vocabulary is.

**Move the module; do not re-derive it into an encoding-neutral abstraction.** Those 212
lines were measured with `tput -T xterm-256color` on this box rather than taken from the
plan, and two of their entries exist *because* measurement contradicted the plan:

- Arrows and Home have **two encodings each** — `\x1bOA`/`\x1bOH` (SS3, application
  cursor mode) and `\x1b[A`/`\x1b[H` (CSI). Both are in the table because any layer — us,
  tmux, screen — can flip `smkx`, and supporting one loses the arrow keys outright.
- Function keys are irregular: F7-F11 are `18/19/20/21/23~`, with **no `22~`**.

Re-expressing that as "logical key → encoding" would risk regressing a live-verified
table for no gain. What is genuinely shared, and what the GUI consumes:

1. **The `Action` union and its names** — deliberately the same names the CLI's command
   table uses, so a key is a table entry rather than a code change.
2. **The dispatch**, `applyAction(session, action)`.
3. **One documented binding-intent table** — `F3 → PF3`, `Ctrl-R → Reset`, `Ctrl-C →
   Clear` — that each front end satisfies in its own encoding. It is documentation with a
   test, not a code generator.

The GUI's `KeyboardEvent` → `Action` mapper lives beside the terminal one in `frontend`,
so the two are read together and a key added to one is visibly missing from the other.

### Refactor safety

**Moving a module must not change behaviour, and the existing 1202 tests are the
evidence.** Tests move with their subjects (`hostspec.test.ts`, `tls.test.ts`'s
prefix/flag cases, `keymap.test.ts`); the suite must pass with assertions unchanged. No
re-export shims are left behind in `cli` — a second path to the same symbol is the drift
this refactor exists to prevent. `packages/cli/src/index.ts` narrows accordingly, and
`packages/tui/src/main.ts` is the only importer to update.

`harness-flags.test.ts` keeps guarding the harness argv and must keep passing: it reads
scripts as text, so it is indifferent to the move — which is the point of having written
it that way.

## Part 2 — `packages/gui`

### Process model and security

Standard Electron split, with the protocol on the Node side:

- **Main** owns the `Session`, the socket and TLS, argument parsing, and the log. It
  reuses `frontend` verbatim, so the flags cannot diverge from the TUI's.
- **Renderer** owns the canvas and nothing else. `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`. A narrow `contextBridge` preload exposes
  exactly two channels: screen snapshots down, named actions up.

**The renderer holds no protocol state.** A dropped or coalesced frame therefore costs a
repaint and never correctness — the same property that lets the TUI diff its output
safely.

### The renderer: draw list, then blit

Two stages, split for testability, following `render.ts`'s precedent of being **pure** and
letting the caller do the writing:

1. **`drawList(snapshot, geometry) → DrawList`** — pure. Per cell:
   `{ glyph, fg: Rgb, bg: Rgb, reverse, cursor, underline }`, plus the OIA row and the
   letterbox offsets. No canvas, no DOM, no Electron. This is where reverse video, the
   cursor, field colours and intensity are decided, and it is unit-testable in `npm test`.
2. **`blit(ctx, drawList, atlas, scale)`** — walks the list and draws.
   `imageSmoothingEnabled = false`, integer `scale` only.

`glyph` is a *tagged* reference, not an index, so that a PS cell later carries a
host-supplied bitmap through the same structure. That is the `dispatch on kind`
constraint honoured at the one place it has to be.

### The font: x3270's own bitmaps

`~/src/suite3270-4.5/x3270/3270.bdf` and its size variants (`3270-12`, `3270-20`, bold,
and `3270gr.bdf` for line drawing). Verified on the box, and the licence is **BSD
3-clause** (Paul Mattes 1993-2009, Jeff Sparkes 1990, GTRC 1989) — redistributable in
binary form with the notice, which ships with the app.

**The glyph ordering is what makes this cheap.** The BDF's own comments record it: *"Page
0: EBCDIC US-International set, CG order; Page 1: EBCDIC APL/APL2 set, CG order; Page 2:
DEC line-drawing characters."* Our cells already hold EBCDIC, so the atlas is a **direct
lookup with no translation step** — and APL, which a 3270 client needs and a Unicode
monospace font will not have, is already there.

A committed BDF parser converts to a sprite atlas at build time. Bundling a monospace TTF
and using `fillText` was rejected: it is not the authentic 3278/3279 look the project
states as a goal, it needs an EBCDIC→Unicode step, it has no APL, and **PS would need a
second rendering path**, because a host-supplied bitmap cannot be drawn with `fillText`.

Putting xterm.js in the window and piping the TUI's ANSI into it was also considered and
rejected, though it is the fastest route to a window: it is a terminal in a box, so it can
never push pixels, which forecloses PS permanently.

### Scaling

**Integer multiples only, letterboxed and centred.** 1×, 2×, 3× by glyph cell; a window
size between multiples keeps the nearest smaller multiple and centres the result. Every
glyph pixel stays exact. Fractional scaling would smear a bitmap font, and the TUI
already centres with a border, so the behaviour is familiar. The default multiple is **the largest
integer scale whose letterboxed screen fits within 80% of the display work area, minimum
1×** — stated as a rule rather than "chosen from the display size", which could be read as
either fit-to-fill or a fixed preference.

### Data flow

```
Session 'screen'  →  snapshot + resolve()   [main]
                  →  IPC                    →  drawList  →  blit    [renderer]
KeyboardEvent     →  Action                 [renderer]
                  →  IPC                    →  applyAction(session, action)   [main]
```

### Error handling

- Connect and TLS failures reuse `describeTlsError`, so each names the flag that fixes
  it. The handshake-stall message pointing at `-insecure` is the one users hit against
  Hercules, and **a plaintext host hangs rather than refusing**, so the 10-second
  deadline matters here as much as in the CLI.
- **Failures appear in the window**, not only on a console the user of a `.app` cannot
  see. A GUI that fails silently is worse than a CLI that prints an error.
- `Ctrl-]` quits, matching the TUI, because **Ctrl-C must remain the Clear AID** — a 3270
  user needs it constantly to dismiss VM's `MORE...` state. The window says so on
  startup, as the TUI's banner does.
- The OIA renders from core's `Oia`, unchanged.

## Testing

| Surface | How | Where |
|---|---|---|
| BDF parser | known glyph bitmaps taken from the BDF itself | `npm test` |
| Draw list | reverse video, cursor, field colour, intensity, letterbox offsets | `npm test` |
| Action mapping | `KeyboardEvent` → `Action`, beside the terminal table's tests | `npm test` |
| Refactor safety | the existing 1202 tests, assertions unchanged | `npm test` |
| Pixels reach the screen | a handful of `capturePage()` goldens under Xvfb | script, guarded |

**Goldens are trustworthy here specifically because the output is deterministic** — a
bitmap atlas at integer scale with antialiasing off has no font hinting and no subpixel
AA to vary between machines. That would not be true of `fillText`, and it is the second
reason the atlas wins.

**The bulk stays in `npm test` on purpose.** Putting every rendering assertion behind an
Xvfb spawn would exempt the renderer from the fast gate, and this project's own history is
that harnesses outside `npm test` rot silently: `pty-smoke.py` went from 12/12 to 1/12
unnoticed when TLS went on by default. Any new script gets a guard in
`harness-flags.test.ts` for the same reason.

## Risks, named rather than discovered later

- **Chromium keyboard handling** is the flagged unknown: Option/dead keys, Cmd chords, and
  keys the browser reserves. It is why this milestone puts input first. Expect the
  binding table to need measurement on a real Mac, which is the user's machine and not
  this box.
- **The BDF parser is new code with no reference implementation here.** Mitigated by
  testing it against glyphs read out of the BDF by hand, and by the format being simple
  and documented.
- **`capturePage()` under Xvfb is verified for a trivial page**, not for this renderer. If
  goldens prove unstable, the draw-list tests are the ones that must carry the weight, and
  the goldens degrade to a smoke check rather than being weakened.
- **Live verification needs a host**, and both Hercules systems are IPLed by hand. The GUI
  is verifiable on this box in a way stage 2b was not, which is why it follows 2b.

## Success criteria

1. `packages/frontend` exists — three whole modules (`hostspec.ts`, `tls.ts`, `keymap.ts`)
   and two extractions (`defaultSession`, the action dispatch) — no re-export shims remain, and
   **the existing 1202 tests pass with assertions unchanged**.
2. `npm run typecheck` and `npm run build` clean; `pty-smoke.py` still 12/12 and
   `drive-e.py` still 7/7 — the refactor must not disturb either front end.
3. A window renders a live 3270 screen from `node packages/gui/dist/main.js -insecure
   -model 3278-2-E HOST:PORT` against a Hercules host, with the OIA drawn.
4. Typing, Enter, Clear, PF and PA keys, and cursor movement all reach the host; a logon
   completes.
5. Draw list and BDF parser unit-tested in `npm test`; at least one `capturePage()` golden
   compared under Xvfb.
6. `Ctrl-]` quits; a connect failure against a plaintext host shows the `-insecure`
   message **in the window**.

Record outcomes against this spec rather than in a session note, and treat the scope
above as open: see the roadmap discipline in `docs/HANDOFF.md`.
