# Keyboard semantics (README *Staging* 15a part 3) — design

Status: approved in brainstorming 2026-11-18. Branch `keyboard-semantics`, off `main` `b4fd071`.

The last part of milestone 15a. The x3270 parity checklist (`docs/parity/checklist.yaml`) found that
the keyboard acts while it is locked, that an operator error locks nothing, that insert mode
outlives an AID and Reset, and that several erase keys do the wrong thing. All of it is core
behaviour, shared by every front end. Rows touched: `typeahead`, `aid-keys`, `cursor-movement`,
`insert-mode`, `reset-key`, `oerr-lock`, `numeric-lock`, `attn`, `erase-backspace`, `delete-key`,
`erase-eof`, `erase-input`.

**The source beats this text.** Every x3270 behaviour below was read from suite3270 4.5
(`~/src/suite3270-4.5`, the same release as the committed inventory's 4.5ga6) on 2026-11-18, and
the citations are to that tree. An implementer who finds the source disagreeing with this spec
follows the source and says so.

## Decisions (the user's, 2026-11-18)

1. **One spec for all five gaps** (A lock and queue, B insert mode, C erase rules, D numericLock,
   E Attn), built as ordered tasks, A first.
2. **x3270's defaults, no flags.** `typeahead` on, `oerrLock` on, `numericLock` off, `alwaysInsert`
   off. Settings come with 15b's preferences and config file; until then the rows that name a
   setting stay `partial` with the gap "no setting (15b)".
3. **Backspace erases in every front end**, the TUI included: it is x3270's `Erase()`
   (`x3270/fb-x3270:294`). c3270 binds the terminal's backspace to the non-destructive
   `BackSpace()` (`c3270/screen.c:1899`); that is recorded as a deliberate divergence from c3270,
   since the store gate measures x3270.

## A. The lock and the typeahead queue

### One way in

A new **`Session.run(action: KeyAction): void`** in core is the only route by which an OPERATOR
action reaches the keyboard. `KeyAction` is a new core union covering exactly the
keyboard-and-AID kinds of frontend's `Action` (`frontend/src/keymap.ts`): `type` (with its text),
`enter`, `clear`, `pf`/`pa` (with `n`), `reset`, the four arrows, `home`, `tab`, `backTab`,
`newline`, `backspace` (now Erase, see C), `delete`, `eraseEOF`, `eraseInput`, `dup`,
`fieldMark`, `insert` (set on), `toggleInsert`, `attn`, `sysreq`. Frontend's `Action` reuses
those members rather than redeclaring them (so the two cannot drift), and keeps its own
front-end-only kinds.

- `applyAction` keeps what is front-end business — reconnect-on-Enter/Clear while disconnected,
  the `quit`/`toggleKeypad`/`toggleKeyboard`/`geometryMenu`/`requestCopy` refusals — and hands every
  other kind to `session.run`.
- The CLI runner's keyboard actions (`String()`, `Enter()`, `Tab()`, `BackSpace()`, ...) call
  `session.run` too.
- `Keyboard`'s methods stay as the immediate operations and carry no lock logic of their own
  except what C needs. `Session.sendAID`, `sendAttn` and `sysreq` stay callable directly for
  INTERNAL callers — a CUT transfer's AIDs must not sit in the operator's queue (x3270 has a
  separate lock test for them, `kybd.c` "Keyboard lock test for AIDs used by CUT-mode file
  transfers") — but no operator path calls them except through `run`.

### What `run` does, in this order (x3270's `enq_xta`, `kybd.c:270-330`, and `OERR_CLEAR_OR_ENQ`, `kybd.c:146-157`)

1. **Not connected** (no 3270, NVT or SSCP mode): drop the action. (The reconnect-on-Enter
   divergence is above this, in `applyAction`, and is unchanged.)
2. **Explicit Reset** is handled before the lock tests: see *Reset* below.
3. **No lock:** perform the action now.
4. **Operator-error lock only** (`ProtectedField`, `Numeric`, `Overflow` and any other OERR state;
   x3270's `KYBDLOCK_IS_OERR`):
   - the **clear-then-act keys** — `tab`, `backTab`, `home`, `up`, `down`, `left`, `right`,
     `eraseEOF`, `eraseInput` (the actions x3270 wraps in `OERR_CLEAR_OR_ENQ`; x3270's
     DeleteField, DeleteWord, FieldEnd and PreviousWord are the same but we have no such
     actions) — clear the error and then act;
   - **every other action** — typed characters, `backspace`, `delete`, `newline`, `dup`,
     `fieldMark`, the AIDs, `attn`, `sysreq`, insert — is dropped and the alarm is rung (the same
     `'alarm'` event the host's WCC alarm uses, so `-visualbell` applies).
5. **Host lock** (any non-OERR state: `SystemWait`, `AwaitingFirstWrite`, `EnterInhibit`,
   `ProgramCheck`, ...):
   - during a file transfer (a DFT or CUT transfer in progress), drop it and ring the alarm
     (`KL_FT`);
   - otherwise append it to the typeahead queue. The OIA shows x3270's typeahead indicator, a `T`
     (`x3270/status.c` `do_typeahead`), while the queue is non-empty.

With an operator error and a host lock together, the host lock wins (x3270: `KYBDLOCK_IS_OERR` is
false), and queueing then drops on the OERR bit (`enq_xta`'s first test) — that is, the action is
dropped with the alarm.

### Draining (x3270's `run_ta`, `kybd.c:351`, called as `while (run_ta())` at `ctlr.c:2654`)

After `Session` has processed each host write, it runs queued actions one at a time, oldest
first, for as long as the keyboard is unlocked and the queue is non-empty. A queued AID locks the
keyboard again, so whatever follows it waits for the next unlock. Each drained action goes through
the same immediate path as an unlocked `run` (step 3), so an operator error raised by a drained
key behaves exactly as one raised live.

Disconnecting empties the queue (`kybd_connect` -> `flush_ta`, `kybd.c:591`).

### Reset (x3270's `do_reset(explicit=true)`, `kybd.c` ~2010-2060)

- **Queue non-empty:** flush the queue and do nothing else (x3270's "half reset"). A second Reset
  then does the rest.
- **Otherwise:** turn insert mode off (`alwaysInsert` default), clear the lock, as today.
- Not connected: insert mode off, nothing else.

### Out of scope

`unlockDelay` (x3270's default is off, `Common/glue.c:476`), scroll lock (`KL_SCROLLED`; we have no
scrollback), the CLI's `aidWait` (HANDOFF item 11 — Enter in a script still returns at once; a
script that types straight after it will now have its keys queued and run at unlock, as s3270's
would be).

## B. Insert mode

- **Turned off by every AID** (`key_AID`, `kybd.c:920`), by **Reset** (above), and when the
  **host restores the keyboard** (a WCC keyboard-restore: x3270 calls `do_reset(false)`, which sets
  insert mode to the `alwaysInsert` default).
- **The keypad Ins button and the CLI's `Insert()` set it on**, as x3270's `Insert_action`
  (`kybd.c:3237`) does. The Insert key and a new CLI `ToggleInsert()` toggle.
- **Room to insert:** an insert succeeds when there is a NUL anywhere from the cursor to the end
  of the field; the characters from the cursor up to the first such NUL shift right one cell and
  the NUL is consumed. Today the field's last cell must be NUL. Trailing blanks counting as room is
  x3270's `blankFill` and belongs to the separate `blank-fill` row, not here.

## C. Erase rules

- **`backspace` is x3270's `Erase`** (`Erase_action` -> `do_erase`, `kybd.c:2374`): delete the
  character to the left of the cursor and close up the rest of the field, a NUL entering at the
  field's end; the cursor moves left one. At the start of a field it does what `do_erase` does
  there (read the source — it is not simply a no-op).
- **`delete` on an unformatted screen** shifts the rest of the screen left one cell
  (`do_delete`, `kybd.c:2168`).
- **`eraseEOF` on an unformatted screen** erases from the cursor to the end of the screen
  (`kybd.c:3034-3039`).
- **CLI:** `BackSpace()` becomes s3270's non-destructive cursor-left (`kybd.c:2285`), and a new
  `Erase()` is the destructive form. **This breaks any script that used `BackSpace()` to erase**;
  the changelog fragment says so.

## D. numericLock off

A letter typed in a numeric field goes in, as in x3270 (`numericLock` off,
`x3270/resources.c:336-337`, tested at `kybd.c:1232`). The `X Numeric` refusal stays in the code
behind a `numericLock` option on `Keyboard`, default false, so 15b can expose it.

## E. Attn (`Attn_action`, `kybd.c:982-1002`)

- TN3270E, bound: send Telnet IAC IP (`net_interrupt`, `telnet.c`).
- TN3270E, unbound: send nothing; the OIA shows `X -f` and the keyboard locks
  (`KL_OIA_MINUS`), cleared by Reset.
- Classic 3270: Telnet BREAK, as now.

Tests only: no TN3270E host is reachable here.

## Testing

- Core unit tests for every rule above: queue under each host-lock state; drain after a write;
  drain pausing at a queued AID; drop and alarm on an operator error for each non-clearing kind;
  clear-then-act for each clearing kind; host lock plus OERR drops; drop and alarm during a
  transfer; drop when disconnected; queue emptied on disconnect; Reset's half reset then full
  reset; the `T` indicator on and off; insert off after an AID, Reset and a host restore; insert
  room anywhere in the field; Erase closing up; Delete and EraseEOF unformatted; numericLock off
  and on; Attn's three cases.
- Existing tests that pin today's behaviour change and the plan names each: insert surviving
  Reset, the numeric refusal, Backspace leaving a gap, `type`'s operator-error exception, the
  keypad Ins button and CLI `Insert()` toggling.
- `applyAction` and CLI-runner tests proving both routes reach `session.run`.
- A mutation pass over each branch of `run` and of the drain loop.
- `npm run build` and the typecheck before believing the suite.

## Live witnesses (GUI through the recording relay, VM/370 and TK5)

- Typeahead: press Enter, type during `X SYSTEM`; the text lands after the host's reply.
- An AID queued behind an AID.
- oerr-lock: type into a protected field (`X Protected`), then a letter (dropped, alarm), then Tab
  (clears, moves).
- Insert mode off after Enter and after Reset.
- Erase closing up a field.
- Delete and EraseEOF on an unformatted screen (VM CP READ or TSO line mode).

Attn on TN3270E stays tests-only.

## Docs

The rows listed at the top re-read and updated (rows still lacking a setting stay `partial`,
"no setting (15b)"; `erase-backspace` records the c3270 divergence); `docs/parity.md` re-rendered
and the gate count recorded; README *Staging* 15a and *Using the CLI* (`BackSpace()`/`Erase()`,
`Insert()`/`ToggleInsert()`); a changelog fragment; `docs/live-testing.md`; HANDOFF.
