# 15b sub-project B2: color mode, and appearance changed while running — design

2026-11-24. README *Staging* 15b, sub-project B2 (after B1, the preferences store, merged as
`49444b0`). Approved by the user 2026-11-24. **One spec, two plans:** Part 1 changes the
protocol and goes first, on its own; Part 2 is display only.

Parity rows: `color-mode`, `screen-model` (its 3279 gap), `color-scheme` (the menu),
`highlight-bold`, `cursor-color`, `window-size-and-font-scale`.

## Decisions (the user's, 2026-11-24)

- **Front ends:** the GUI gets menus. The TUI and the web gateway get matching flags wherever a
  setting means something there.
- **Advertising follows x3270 exactly:** color mode on models 2 and 3 sends `IBM-3279-N`.
- **The model's prefix is the color mode**, as in x3270 (`3279` color, `3278` mono), with the
  breaking change handled as below.
- **Font steps are whole-number scales only**, keeping the bitmap font sharp.

## Part 1: color mode and the terminal type (core, every front end)

- **Names:** `core/src/termtype.ts` accepts `3279-N[-E]` and a bare `N` as well as `3278-N[-E]`.
  It currently refuses 3279 names (`screen-model` row: `termtype.ts:48`). The prefix sets the
  color mode: `3279` and bare are color, `3278` is mono. This is x3270's `canonical_model_x` and
  `common_model_init` (`Common/model.c:60-156`). `-mono` forces mono whatever the name
  (`appres.interactive.mono`, `model.c:155`), in every front end.
- **The advertised type** follows `create_3270_termtype` (`Common/telnet.c:2095-2108`):
  oversize sends `IBM-DYNAMIC`; otherwise `IBM-327{9 if color and model < 4, else 8}-N`, plus
  `-E` when extended. `wrongTerminalName` isn't implemented (see *Deferred*).
- **The default becomes `3279-2-E`.** That's the same color drawing as today, now advertised as
  `IBM-3279-2-E`. The GUI's Connect dialog and Model menu list the 3279 names, plus the 3278 names
  for mono. README examples move to 3279 names.
- **Drawing:** core's `resolve` already has `mode3279` (`core/src/render.ts`), where false means
  x3270's green 3278 colors. It comes from the session's model, so every front end draws mono
  without its own setting. The TUI's existing `mode3279` option is fed from it.
- **The breaking change, handled:** an explicit `-model 3278-…`, or a B1-saved one, now draws
  mono.
  - The changelog says so under Bug fixes.
  - The first use of a `3278-` model in a process prints one notice, through the front end's
    existing notice path: `-model 3278-4-E now means a mono 3278; for color use 3279-4-E`.
    It's once per process, so a deliberately saved mono preference doesn't nag forever.
- **Live, before merging:** VM/370 and TK5 with the new default type (`IBM-3279-2-E`), and with an
  explicit 3278 for mono. TK5 has refused a terminal type before (`docs/live-testing.md`, the
  2026-08-17 TK5 entry). **A refusal on either host stops the merge** and comes back to the user.

## Part 2: appearance changed while running

- **GUI Options menu:**
  - **Color Scheme:** radios for default, 3279, x3270 and green, switching live (repaint with
    the new palette). Enabled only in color mode, as in x3270 (`x3270/menubar.c:2466-2498`).
  - **Color Mode:** 3279 color or 3278 mono. Disabled while connected, as x3270's
    (`menubar.c:2310-2328`), because it changes the terminal type; applied at the next connect
    by swapping the model's prefix.
  - **Highlight Bold:** a checkbox, off by default (`x3270/resources.c:346-347`). When on, an
    intensified field is drawn bold in 3279 mode. Mono always draws it bold, as x3270 does
    (`screen.c:706-712`).
  - **Fixed Cursor Color:** a checkbox, off by default. When on, the cursor is red, as x3270's
    `useCursorColor` with its default `cursorColor` (`resources.c:240-241, 258-259`).
- **GUI View menu:**
  - **Bigger, Smaller and Fit Window** on Ctrl-+, Ctrl-- and Ctrl-0 (unbound today; checked
    2026-11-24), in whole-number scales. Bigger and Smaller set the scale and resize the window to
    it; Fit Window returns to today's largest-scale-that-fits.
  - **Snap Window:** resizes the window to exactly the current scale, removing letterboxing.
  - **Appearance:** System, Light or Dark, which sets `nativeTheme.themeSource` for the GUI's own
    windows. `ui.css` already follows the OS theme (`color-scheme: light dark`), so this is an
    override. The terminal's colors stay the scheme's.
- **Flags:**

  | flag | GUI | TUI | web |
  |---|---|---|---|
  | `-mono` | ✓ | ✓ | ✓ |
  | `-highlightbold` | ✓ | ✓ (SGR bold) | ✓ |
  | `-cursorcolor` | ✓ | (a terminal draws its own cursor) | ✓ |
  | `-appearance system\|light\|dark` | ✓ | | |

- **Saved through B1's store:** new keys `mono`, `highlightbold`, `cursorcolor` and `appearance`
  (GUI), and `scale` (GUI, the chosen font step; absent means fit). Color mode is saved through
  `model`, since the prefix carries it. The TUI gets `mono` and `highlightbold`.

## Deferred, listed so they aren't lost

Each gets a README *Staging* line:
- **Live switching in the browser's Alt-M panel** (scheme, mono, highlight-bold, cursor color).
  Not a parity gate: the gateway has no x3270 counterpart (the user, 2026-11-24).
- **Free scaling with vector fonts**, for the Super-Terminal (the user, 2026-11-24).
- **A color picker** for each 3279 color and the background; **built-in light and dark terminal
  themes**; and **saving a set of colors as a named theme**, which would extend B1's store (the
  user, 2026-11-24).
- **B3, other bitmap fonts**; x3270's `wrongTerminalName`; fixed-size windows.

## Testing

- **Part 1:**
  - termtype parsing for every name form (3278, 3279, bare, with and without `-E`), with case
    handled as x3270's `canonical_model_x` handles it (the plan reads it: only the `IBM-` prefix
    was seen to ignore case), and refusals naming the valid forms;
  - the advertised type for each model, mode, `-mono` and oversize combination, as a table
    checked against `create_3270_termtype`;
  - mono drawing through `resolve`;
  - the once-per-process notice;
  - B1's saved `model` round-trip with a 3279 name;
  - the live checks above.
- **Part 2:**
  - the menu items and their enabled states (Color Mode disabled while connected, Scheme
    disabled in mono);
  - a live scheme switch repaints with the new palette;
  - scale stepping, Fit and Snap against `windowScale`;
  - `nativeTheme.themeSource` from Appearance;
  - each new flag in each front end, including the usage-covers-every-flag test from A;
  - the new keys load and save;
  - a live check under Xvfb.
- **A mutation pass per part.**
