# Oversize, `IBM-DYNAMIC`, and local model-switching — design

**2026-11-04.** Roadmap items (a) and (b), designed together because both make the CLIENT
choose the screen geometry, and today only the host does (`Screen.resize()`'s callers are all
Erase/Write, Erase/Write Alternate, BIND and UNBIND). One spec, built in two steps:

- **Step 1:** oversize (fixed and `auto`) and the `IBM-DYNAMIC` advertisement.
- **Step 2:** changing model and oversize while the program runs, at the next connect.

Decisions below were made with the user during brainstorming on 2026-11-04.

## What oversize is

An emulator extension, not 3270 architecture: no 3278 had a 160x62 screen. The user names an
alternate screen larger than the model's; Erase/Write still gives the model's default (24x80),
and Erase/Write Alternate gives the oversize screen. The host learns the size from our Query
Reply, which is why the client must advertise `IBM-DYNAMIC` ("ask me via Query Reply") instead
of a model name. This follows x3270:

- `ctlr.c:check_rows_cols`, `:321-335`: oversize becomes the model's maximum
  (`maxROWS = ovr`, `maxCOLS = ovc`).
- `telnet.c:2100`, `create_3270_termtype`: any oversize means the terminal type is
  `IBM-DYNAMIC`, and the TN3270E device type is too (`tn3270e_request` calls the same function).
- `model.c:343`: the value is written **`<cols>x<rows>`**. `160x62` is 160 columns by 62 rows.

**The `<cols>x<rows>` order is kept for compatibility with x3270.** This project's existing
messages are already inconsistent: `core`'s write rows by columns (`bind.ts:278`,
`stream/execute.ts:732`), the TUI's write columns by rows (`tui/src/app.ts:343`, `:451`). So every
NEW message that names a size says it in words, `62 rows by 160 columns`, and never as a bare
`AxB`.

## The setting

`-oversize <cols>x<rows> | auto | none` on every front end (TUI, GUI, web gateway, CLI), default
`none`. With `-model`, it makes one geometry setting.

### Rules for a fixed size (from x3270's `check_rows_cols`)

- Columns and rows both nonzero integers; the syntax is exactly `<cols>x<rows>` (case-free `x`).
- Not smaller than the model's alternate size in either dimension.
- `cols * rows <= 16383` (`MAX_ROWS_COLS`, `include/3270ds.h:456`), the 14-bit address limit.

A fixed size breaking any rule is REFUSED before any socket opens, and the message leads with
the remedy, for example: `oversize 70x20 refused: use at least 80x24 -- model 3278-2 is 24 rows
by 80 columns`. `connect()` rejects with it, so every front end shows it where it already shows a
connect failure.

### `auto`

The front end supplies a measure function returning how many rows and columns it can display.
At each connect the session asks it:

- **Exactly what fits**, not snapped to standard sizes (zti snaps to 24x80/32x80/43x80/62x160;
  we do not, because the hosts here accept arbitrary sizes and snapping wastes space).
- **Larger than 16383 cells:** rows are cut until it fits, keeping the measured width. Noted in
  the trace only; it is a protocol limit, not an operator mistake.
- **Smaller than the model's alternate** in either dimension: FALL BACK to the plain model, no
  oversize, advertising the model's own terminal type, and say so in one line, e.g. `oversize
  auto: window fits 22 rows by 80 columns, less than model 3278-2's 24 rows by 80; using the
  model`. The connection goes ahead. (User's choice: `auto` means "as big as fits", and the
  model is the floor, so refusing would be a strange result for a setting meant to adapt.)

**What each front end measures:**

- **TUI:** the terminal's rows less the status line, by its columns (what zti does).
- **Web:** the browser viewport, in CSS pixels, converted to cells by the GATEWAY at scale 1 (the
  page does not know the cell size until the gateway's `atlas` reply, which follows `hello`). The
  page sends it in `hello` and again, debounced, whenever the window resizes; the gateway keeps the
  latest per session, so a reconnect measures the window as it is then.
- **GUI:** the display's work area at the scale the window would pick anyway (the user's choice,
  over scale 1, which gives very large screens, and over refusing `auto` in the GUI). The GUI
  sizes its window to the host's screen, so there is no window to measure before connecting.

### Combinations that are refused

- **An oversize on a model without `-E`** (`-model 3278-2 -oversize ...`). x3270 silently DROPS
  oversize when the extended data stream is off (`model.c:203-205`, `oversize_init`; `:333-335`,
  "Without extended, no oversize"), because Query Reply belongs to the extended data stream. We
  REFUSE instead, naming the `-E` model to use: a flag that silently does nothing is the outcome
  this project avoids. (The spec first said the reverse, "as x3270"; the Task 1 code review found
  it false against the source, 2026-11-04.)

- **`-oversize` with `--terminal-type`**: an oversize means the terminal type IS `IBM-DYNAMIC`, so
  the two cannot both hold. Refused at startup, naming both flags.
- **`auto` where there is no window** (the CLI, or any session built without a measure function):
  refused, asking for a fixed size.
- **A window that cannot be measured yet** (a web client that sent no viewport): `auto` falls back
  to the model, with the notice `oversize auto: no window size known; using the model`.

### Why `auto` is measured at connect, and only then

A 3270 terminal states its size only when the host sends Read Partition (Query); no message lets
the terminal announce that its size changed. And the terminal type, which depends on the
fallback decision, goes out during telnet negotiation, before any Query. So `auto` is measured
at every `connect()` and `reconnect()`, and NEVER at construction: before a connect the session
holds the model's geometry. (The GUI's font atlas, which its measure needs, is read after the
session is built.) A window resized mid-session changes only how the screen
is drawn (the GUI rescales, the web page fits); the host gets the new size at the next
reconnect. x3270 refuses to change model or oversize while connected for the same reason.

## Architecture

### `core/src/geometry.ts` (new, pure)

- `parseOversize(text)`: `{kind:'none'} | {kind:'fixed', rows, cols} | {kind:'auto'}`, or a
  refusal with its message.
- `resolveGeometry(model, oversize, measure?)`: returns the terminal type, the default size, the
  alternate size, and an optional notice (the `auto` fallback, or the clamp for the trace); or a
  refusal for a fixed size breaking a rule.
- Replaces the "oversize deliberately out of scope" exclusion in `termtype.ts:40-44`, whose
  comment is updated.

### `Session`

- Holds the geometry setting instead of fixing the model and alternate size in its constructor
  (`session.ts:342`). The constructor's existing options keep working and become the initial
  setting.
- `connect()` and `reconnect()` call `resolveGeometry` first. On a refusal, `connect()` rejects
  and opens no socket. Otherwise the session resizes its `Screen` IN PLACE -- `setSizes` to 24x80
  and the resolved alternate, then `useDefaultSize()` and `clear()`, the path UNBIND already uses
  -- because `Keyboard` holds a reference to the `Screen` and a new object would orphan it. It
  then resets `modelAlternate` (what UNBIND reverts to) and emits a new `geometry` event carrying
  the resolved sizes and any notice. Clearing is safe because nothing is on the screen before a
  connect.
- `setGeometry(setting)` changes the setting. It throws while connected, with `disconnect first;
  model and oversize apply at the next connect`. No queued "apply at disconnect" (x3270 has
  one, `XN_DEFER`); a pending change the operator cannot see is a surprise.
- One `Session` per front end, as now. A new `Session` per connection was rejected because the
  session is wired into the transfer, copy, OIA and keypad listeners in every front end.

## Data flow on a connect

1. Resolve the geometry (above). A refusal stops here.
2. Resize the `Screen` in place, reset `modelAlternate`, emit `geometry`. The session writes any
   notice to the trace, and EVERY front end prints it on stderr, as the gateway's `host
   unreachable` line is printed. No front end can hold it on screen: the GUI's and the page's only
   on-canvas painter is the red error painter, which the next frame wipes, and the TUI under
   `auto` has no spare row (the screen fills all but the status line) while its one-line
   `showMessage` is wiped by the next paint. The TUI's stderr line lands in the normal screen
   buffer, so it is there on quitting and in scrollback; the TUI also flashes it once with
   `showMessage`.
3. Negotiate. With an oversize in effect the terminal type is `IBM-DYNAMIC`, and so is the TN3270E
   device type. Otherwise the model's own name,
   unchanged from today.
4. Read Partition (Query): the existing reply code reads `screen.alternateSize`
   (`session.ts:1475-1478`), so Usable Area and Implicit Partition report the oversize with no
   change there. 14-bit addressing is already claimed (`queryreply.ts:212-216`) and
   `encodeAddress` already switches above 4096 cells (`address.ts:45`).
5. Erase/Write Alternate switches to the oversize screen through the existing `Screen.resize()`
   path, and each front end redraws as it does for any host resize. The TUI's refusal to clip is
   unchanged: a terminal too small for the screen says so rather than drawing part of it.
6. **BIND:** the size limit becomes the resolved alternate, as x3270 makes oversize the maximum.
   `acceptBindDims(dims, model)` (`bind.ts:269`) is passed the resolved alternate rather than the
   model's fixed size. A BIND asking for more is still refused. **UNBIND** reverts to the resolved
   geometry.
   **The BIND RFC 2355 prescribes for `IBM-DYNAMIC` needs no new code.** It says a VTAM host
   should answer with screen-size byte `0x03`, "the alternate screen size will be determined by
   the Query Reply (Usable Area)". We already parse `0x03` as `alternate: 'caller'`
   (`bind.ts:130`) and substitute `modelAlternate` (`session.ts:1147`), so once `modelAlternate`
   is the resolved oversize, that BIND gives the oversize. Tested explicitly, because it is the
   path a modern host will take.

### What the host may do

- **Never send a Query** after we advertise `IBM-DYNAMIC`. RFC 2355 requires only that the
  CLIENT "must be able to accept and respond to a Read Partition Query command"; it does not
  oblige the host to send one. If none comes we stay at 24x80, which is harmless.
- **Refuse `IBM-DYNAMIC`.** Treated like any terminal type a host rejects: the trace shows it,
  and the remedy is to drop `-oversize`. **No automatic retry with the plain model**: retrying
  silently would hide which terminal type got in, and this project's terminal-type diagnoses have
  depended on knowing exactly that.

## Errors

- **Bad fixed oversize** (too small, over 16383 cells, zero, bad syntax): refused before any
  socket, remedy first, shown where each front end shows connect failures.
- **`auto` fallback:** a one-line notice (stderr and the trace in every front end; the TUI also
  flashes it), then the connect proceeds.
- **`auto` clamp:** trace only.
- **Switching while connected:** refused with the message above; the GUI and web menus are
  disabled while connected, so the refusal is the CLI's and a defence for the others.

## Step 2: switching while the program runs

All four call `setGeometry`, and the change applies at the next connect or reconnect (Enter or
Clear on a disconnected session already reconnects, `frontend/src/actions.ts`).

- **CLI:** `Set(model,3278-4-E)` and `Set(oversize,160x62|auto|none)`. x3270 names this action
  `Set` (`toggles.c:804`, `names.h:132`). Added to `COMMAND_NAMES` in `cli/src/commands.ts`.
- **PICKED FROM LISTS, NOTHING TYPED (user's choice, 2026-11-04).** Electron has no text-input
  dialog and the web page has no menu at all, so a typed size would cost a new window in one and
  a first menu bar in the other. The choices are the eight models, then oversize `None`, `Auto`,
  and the fixed size given at startup when there was one. A new fixed size is typed only as
  `-oversize` or the CLI's `Set(oversize,...)`.
- **GUI:** a Model menu in `gui/src/menu.ts`: the models and an Oversize submenu, all radio
  items, the current choice checked, the whole menu disabled while connected.
- **Web:** an overlay on **`Alt-M`**, matched on the physical key (`e.code === 'KeyM'`) exactly as
  `Alt-K` opens the keypad, built like the transfer form's, listing the same choices, inert while
  connected. NOT `Ctrl-Shift-M`, which was proposed first and is the browser's in both Firefox
  (Responsive Design Mode) and Chromium (the profile menu) -- from memory, not re-checked. `Alt`
  menu access keys in Firefox and Chromium use F, E, V, S, B, T and H, not M. The cost: Option-M
  on a Mac no longer types `µ` in the page, the same trade `Option-K` already makes. The browser
  harness checks the chord reaches the page in Chromium; Firefox and Safari are a live-pass item.
  The GUI honours the same chord by popping up its Model menu; the TUI has no sequence for it. The choice goes to the gateway, which
  owns the session, as a new `setGeometry` client message (naming a model and one of `none`,
  `auto` or `startup`, never a size) with its own shape check in
  `web/src/protocol.ts`, beside `hello`, `action`, `transferStart` and the rest.
- **TUI: a terminal resize is the switch, for size.** The TUI already handles `SIGWINCH`
  (`tui/src/app.ts:368`, `onResize`). Under `-oversize auto` the next connect or reconnect
  measures again, so resizing the terminal and reconnecting is how a TUI operator changes size,
  with no new control. What is new: when a resize WHILE CONNECTED changes what `auto` would
  resolve, a one-line `showMessage` says so, e.g. `window now fits 50 rows by 132 columns; applies at the
  next reconnect`, because otherwise the resize appears to do nothing. "What `auto` would
  resolve" is compared with what the last connect resolved -- terminal type and alternate, not
  the screen's current alternate, which a BIND can narrow -- and a window that would make `auto`
  fall back says `window no longer fits an oversize; the model's 24 rows by 80 columns applies at
  the next reconnect`, naming the model's size rather than the window's. A resize smaller than the
  current screen still suspends with `terminal too small`, unchanged. Changing the MODEL stays
  flag-only in the TUI: it has no menu, and a resize cannot express a model.

## Testing

- **Unit (core):** every `resolveGeometry` rule, the fallback and the clamp, and the terminal
  type each case gives; `IBM-DYNAMIC` sent exactly when an oversize is in effect, on both the
  terminal-type and the TN3270E device-type paths; the Query Reply carrying the oversize; 14-bit
  addressing above 4096 cells; the BIND limit using the oversize and UNBIND reverting to it; a `0x03` BIND giving the oversize;
  `setGeometry` refused while connected; a reconnect measuring `auto` again.
- **Conformance:** s3270 `-oversize 160x62` and our session with `-oversize 160x62` against the
  same scripted host; the `IBM-DYNAMIC` negotiation and the Query Reply bytes compared.
- **Harnesses:** each `auto` measure in a real environment: the TUI under the pty harness at a
  fixed terminal size, and a pty resize while connected producing the `applies at the next
  reconnect` line and then the new size on reconnect, the web page in the browser harness at a fixed viewport, the GUI under Xvfb
  at a known display size.
- **Live:**
  - **VM/370** with `-oversize 160x62`: log on and run a full-screen application that uses
    Erase/Write Alternate. VM recorded a 32x80 alternate from zti's Query Reply on 2026-08-17
    (main spec, *Corrected by live testing*), so it is expected to act on ours.
  - **TK5 TSO**: its Read Partition answered with the oversize, and ISPF drawn at that size if
    TSO's terminal setup uses it.
  - **A modern host** (z/VM or z/OS) is expected within a couple of weeks of 2026-11-04, per the
    user, and is the witness that matters most: a host that asks for dynamic geometry by design.
  - Whatever the hosts do is reported as observed; a harness pass is not a host witness.

## Out of scope

- A TUI control for changing the model (size changes come from resizing; see Step 2).
- Re-reporting the size mid-session (the protocol has no way).
- A queued model change applied at disconnect.
- A connect dialog (roadmapped separately in `gui/src/menu.ts`).
- Typing a new fixed oversize in the GUI or the web page (see Step 2).
