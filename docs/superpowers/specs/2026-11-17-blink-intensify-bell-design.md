# Blink, intensify and the bell, as x3270 draws and rings them — design

Date: 2026-11-17. Status: approved in conversation. README *Staging* item 15a, part 2 of 3 (after
ascii line ends, before the keyboard semantics).

## Problem (found by the parity review, 2026-11-17)

- **Blink is never drawn** in the canvas front ends (GUI, browser): `canvas/src/drawlist.ts` carries
  `blink` on every cell and `canvas/src/blit.ts` never reads it.
- **Intensify is never drawn** there either (`drawlist.ts` carries `intensify`; `blit.ts` ignores
  it). Parity row `highlight-bold`.
- **The host's alarm never rings**: core emits `'alarm'` (`core/src/session.ts:1221`) and no front
  end listens. Parity row `bell`.
- The TUI already sends SGR 5 (blink) and SGR 1 (bold) (`tui/src/render.ts:486-489`), so its
  terminal draws both; only its bell is missing.

## x3270's behaviour (suite3270 4.5ga6)

- **Blink:** a 500 ms timer flips `text_blinking_on`, forcing a redraw; in the off phase blinking text
  is drawn blank. The timer is rescheduled only while blinking text exists (`x3270/screen.c:1411-1435`).
- **Intensify:** the glyph is drawn again one pixel to the right, an overstrike bold
  (`x3270/screen.c:2914-2921`).
- **Bell:** `ring_bell` sounds the display's bell unless `visualBell` is set (default false,
  `x3270/resources.c:304`); with it set, the window flashes inverted instead (`x3270/screen.c:5457`).

## Decision (the user, 2026-11-17)

Option B: the audible bell everywhere, **plus a `-visualbell` flag** that flashes instead, which
gives the `visualBell` resource an equivalent reach and closes the parity `bell` row.

## Design

1. **Blink, in the shared canvas (GUI and browser).** `blit` takes a `blinkOff` phase: in it, a
   cell with `blink` gets its background and underline but no glyph. The renderer
   (`canvas/src/renderer.ts`) starts a 500 ms timer when a painted frame has a blinking cell, flips
   the phase and repaints, and stops when no blinking cell remains. A new frame keeps the current
   phase rather than resetting it, so a host that repaints often does not freeze the blink. The
   phase starts "on".
2. **Intensify, in the shared canvas.** A cell with `intensify` gets its glyph drawn a second time,
   offset one source pixel (`scale` device pixels) to the right.
3. **The bell, on core's `alarm` event.**
   - **GUI:** `shell.beep()`; with `-visualbell`, a ~100 ms inverted flash of the canvas instead.
   - **Browser:** the gateway sends a new server-to-page message `{ kind: 'alarm' }`; the page
     plays a short WebAudio tone, or flashes when the gateway was started with `-visualbell`. A
     browser may block sound until the page has had a user gesture, so a first alarm can be silent;
     the browser README says so.
   - **TUI:** writes BEL (`\a`); with `-visualbell` it flashes the terminal instead with reverse
     screen (`ESC [ ? 5 h`, then `ESC [ ? 5 l` after ~100 ms), as xterm's visual bell does.
   - `-visualbell` is the same flag in all three.

## Testing

- `blit` with a recording context: a blinking glyph is skipped only when `blinkOff`; its background
  and underline still draw; intensify draws the glyph twice, the second at `+scale` x.
- The renderer's blink timer with fake timers: starts only when blinking cells exist, stops when they
  are gone, is not reset by a new frame. If the renderer's module shape makes this impractical, the
  timer logic moves into a small pure helper that is tested instead.
- The bell in each front end: an alarm calls the beep, or the flash with `-visualbell`; the gateway
  emits `alarm`; the TUI writes `\a` or the DECSCNM pair; the flag parses in all three.
- Screenshot goldens: confirm none contains blink, or pin the phase "on" for captures.
- **Live:** a host that sends a WCC alarm, and a panel with blinking or intensified fields. Check what
  VM and TSO actually send (traces in `packages/fixtures` first) before promising either; record what
  was and was not witnessed.

## Docs

README (the GUI, TUI and browser sections, and *What is not implemented* if it mentions these), a
changelog fragment, parity rows `highlight-bold` and `bell`, and HANDOFF's found-defects items 7-8.

## Out of scope

The cursor blink (parity row `cursor-blink`), a bell volume setting, and the iconified-window
inversion x3270 does when it rings while iconic.
