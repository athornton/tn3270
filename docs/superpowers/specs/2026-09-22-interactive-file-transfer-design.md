# Interactive `IND$FILE` transfer — design

**Date:** 2026-09-22
**Status:** design, approved in brainstorming; no code written
**Scope of THIS spec:** the TUI only. Stages 2-4 are named below but deliberately not designed.

## The gap

`IND$FILE` transfer is finished and live-verified on both hosts in both directions — **and it is
reachable only from a script.** Measured 2026-09-22:

- `Transfer` exists only as a CLI scripting command (`cli/src/runner.ts`, `cli/src/transfer.ts`).
- The `Action` union in `frontend/src/keymap.ts` has **no `transfer` member**. All 24 kinds were
  enumerated; file transfer is not among them.
- Only `packages/cli` and `packages/core` import `CutTransfer`/`TransferDirection`. `tui`, `gui` and
  `web` do not touch the transfer code.

So the TUI, the GUI and the browser cannot transfer a file by any route. **This is the same shape as
`Session.sysreq()` and `Keyboard.newline()` before the keypad branch**: a capability implemented in
`core` with no interactive way to invoke it. The README said nothing about it until `433f62d`.

## The user's sequence, and why this spec stops at stage 1

Decided by the user 2026-09-22, in order:

1. **CUT transfer working in the TUI** ← *this spec*
2. **DFT**, for anything that is not 24x80
3. **Port the TUI interface to the GUI**
4. **Then** work out what to do about the web gateway

Each stage de-risks the next: the TUI form establishes the `Action` and form model that stage 3
reuses, and stage 1 deliberately runs against the engine that already has a live witness rather than
against one written in the same breath as its UI.

**Stage 2 is not optional, and the reason is a hard constraint in stage 1:** CUT transfer requires a
24x80 screen (`runner.ts:454`, `frames.ts` `requireCutGeometry`), because `O_SF = 1919` is "the last
cell of a 24x80 buffer and nothing else". The user's working setting is `-model 3278-4-E` at 43 rows,
so **on their usual setup a CUT transfer is refused.** DFT removes that: `ft_dft.c` has **zero**
screen-buffer references (`grep -c "ea_buf\|ctlr_add\|ROWS\|COLS"` = 0, against 25 in `ft_cut.c`) and
no mention of 1920, 24x80 or geometry anywhere — it moves data through structured fields
(`SF_TRANSFER_DATA = 0xd0`, dispatched at `sf.c:175`), not through the display buffer. **Neither
Hercules host speaks DFT** (both measured as CUT), so stage 2 will have no live witness.

## Architecture

### Where the shared code moves, and why it must

`CutTransfer` is in `core`, which the TUI already depends on. But `TransferFiles`, `TransferRequest`,
`transferCommand`, the `Dialect` objects and all ten keyword validations live in **`packages/cli`** —
and **the TUI deliberately does not depend on `cli`** (`tui/package.json` lists only `core` and
`frontend`; severing that dependency was the point of creating `frontend`).

**Move the host-independent half of `cli/src/transfer.ts` into `packages/frontend`:** the types
(`FtHostType`, `FtMode`, `FtCr`, `FtExist`, `FtRecfm`, `TransferRequest`, `TransferFiles`,
`TransferOptionError`), the `Dialect` objects, `dialectFor`, and the validation
(`parseTransferKeywords`, `transferCommand`). None of it touches Node, the filesystem or a terminal.

`packages/cli` then imports those from `frontend` and keeps `nodeTransferFiles` and the `Transfer`
wiring in `runner.ts`. Graph unchanged: `core ← frontend ← { cli, tui }`.

Two risks, both from prior experience in this repo:
- **After moving a module into `frontend`, `npm run build` MUST precede `vitest`** — the package
  resolves to its built `dist/index.js`, and testing before rebuilding once failed 22 tests in a way
  that looked like a broken refactor rather than a stale artifact.
- **No re-export shims in `cli`.** Imports are updated at their sites, as for the last move.

### The form model lives in `frontend`, the renderer in the TUI

Same split as the keypad: `frontend/src/keypad.ts` owns the button table, `tui/src/keypadOverlay.ts`
renders it. So **`frontend/src/transferForm.ts`** owns the fields, values, cycle order and
applicability; the TUI owns drawing and key routing. This is what makes stage 3 cheap — the GUI
writes a renderer and reuses the model.

### Fields

| field | type | default |
|---|---|---|
| Direction | cycle: receive / send | `receive` |
| Host | cycle: TSO / VM | `tso` |
| Local file | text | empty |
| Host file | text | empty |
| Mode | cycle: binary / ascii | `binary` |
| Exist | cycle: keep / replace / append | `keep` |
| Cr | cycle: — / auto / remove / add / keep | `—` |
| Recfm | cycle: — / F / V / U | `—` |
| Lrecl | numeric, 5 wide | empty; `80` when Recfm leaves `—` |
| Blksize | numeric, 5 wide | empty |

**`Recfm` is a THREE-state cycle, not an F/V toggle.** "Unset" and "V" produce different wire
commands — unset emits no `RECFM` at all and lets the host choose, which is the current CLI behaviour
that works on both hosts. Starting at `—` preserves "I did not ask for record attributes" as a
distinct intention from "I want F 80". `Lrecl` is **5 wide, not 3**: `positiveInt` has no upper bound
and TSO datasets legitimately reach `32760`, so a narrow field would silently prevent valid transfers.

**`Host` is an explicit field with no detection.** There is no reliable way to tell TSO from VM:
`transfer.ts:452` defaults it to `tso`, and **x3270 does the same and never sniffs it**
(`p->host_type = HT_TSO` hardcoded at `ft.c:320`, set from a resource or keyword). A reference
implementation with thirty years of host exposure declining to guess is strong evidence there is no
dependable tell. Candidate heuristics (VM's `CP READ`, TSO's `IKJ`/`IKT` prefixes, `READY` vs
`Ready;`) are all screen-scraping guesses that fail exactly when it matters — absent pre-logon,
panel-dependent, and wrong for MVS under VM. Guessing wrong emits syntax the other system cannot
parse, whose visible symptom is "a host dataset with attributes nobody chose". RFC 4777's
`SYSTEMTYPE` is the 5250 spec and not available to us.

### Applicability is computed from the validator's own rules

The model exposes `applicable(field, state)`, derived from the four rules already in
`transferCommand`:

- `Recfm`/`Lrecl`/`Blksize` — hidden unless `Direction=send` (on a receive the dataset exists; x3270
  silently drops them, `ft.c:702`)
- `Lrecl`/`Blksize` — disabled while `Recfm` is `—` (`Lrecl=80` alone "emits nothing at all",
  `ft.c:704,721-726`)
- `Blksize` — hidden when `Host=vm` (CMS files have no block size)
- `Recfm`'s `U` — omitted from the cycle when `Host=vm` (`transfer.ts:516`: "CMS supports fixed and
  variable")
- `Cr` — only meaningful with `Mode=ascii`

**Inapplicable values are CLEARED on transition, not retained invisibly.** A hidden value that breaks
a later submit is the worse failure.

### THE CENTRAL RULE: the form never validates

**The form collects strings and hands them to `parseTransferKeywords`.** The applicability rules above
are ergonomics — they stop a user entering a doomed combination — but authority stays in one place. If
the form's rules and the validator's ever disagree, **the validator wins and the user sees its
message.** This is what keeps the TUI and CLI from drifting on what is legal, and it means the form
cannot invent a legal-looking combination the engine rejects.

## `Lrecl` with `Recfm=V`: MEASURED ON BOTH HOSTS, AND THEY DIFFER

The user asked whether `Lrecl`/`Blksize` must be disabled for `Recfm=V`, reasoning that variable-length
records have no record length. **Measured live 2026-09-22 rather than reasoned about, and the two hosts
disagree — which is why the field stays enabled.**

Method, both hosts: three sends of the same 249-byte file differing only as intended, then the host's
own readback. **The third case is load-bearing:** without `LF80`, "the two V cases match" cannot
distinguish "the host ignores LRECL for V" from "our client never sent it", and those demand opposite
designs. Commands were verified by calling `transferCommand` directly, not inferred.

**VM/CMS (MECAFF), `LISTFILE (FORMAT`:**

| host file | command sent | CMS stored |
|---|---|---|
| `LV80` | `IND$FILE PUT LV80 TEST A (RECFM V LRECL 80` | `V 80` |
| `LV00` | `IND$FILE PUT LV00 TEST A (RECFM V` | `V 80` |
| `LF80` | `IND$FILE PUT LF80 TEST A (RECFM F LRECL 80` | `F 80` |

The two `V` cases are **identical**, so CMS did not honour the `LRECL`; `LF80` proves the keyword
reached the host. **On VM, `Lrecl` with `Recfm=V` is INERT — accepted, transferred, silently ignored.**

**MVS/TSO (TK5), `LISTDS`:**

| dataset | command sent | TSO stored |
|---|---|---|
| `LV80` | `RECFM V LRECL 80` | `VB  80  15040` |
| `LV00` | `RECFM V` (no LRECL) | `VB  255  14790` |
| `LF80` | `RECFM F LRECL 80` | `FB  80  15040` |

The two `V` cases **differ, 80 against 255**, so **TSO HONOURS it** — it is the maximum record length,
and `IND$FILE`'s own default is 255.

**Decision: `Lrecl` stays enabled for `V`.** Disabling it would make a real TSO attribute
unexpressible to satisfy a VM quirk, and a stale prohibition costs as much as a missing one. x3270
agrees: both its branches gate `LRECL` on `recfm != DEFAULT_RECFM` only, with no `V` check
(`ft.c:721-726` TSO, `ft.c:763-766` VM).

Two incidental findings: **TSO reports `VB`/`FB`, not `V`/`F`** (it adds the blocked attribute), so a
readback check cannot string-compare against what was sent; and `BLKSIZE` was host-chosen in all three
TSO cases and tracks `LRECL`, which is consistent with keeping it enabled for `V` but was not varied
directly and so is not evidence.

**Record in the UI or docs that `Lrecl` is silently ignored for `Recfm=V` on VM**, so the next person
does not read a `V 80` result as confirmation their input took effect.

## Key routing

**Opening:** a new `Action`, `{ kind: 'transferForm' }`, bound in the TUI and added to the keypad
table (the keypad entry is what gives stage 3 the button for free). **`Ctrl-T` (`0x14`) is the chord:
verified free in both halves of `Common/fb-c3270` and absent from our own keymap**, whose taken
control bytes are `01 03 04 06 0b 12 15 1d 7f`. c3270 binds no transfer key at all, so there is no
reference spelling to match.

**Routing follows `overlayShown` exactly.** `app.ts:403` already intercepts all input when the keypad
overlay is open; the form adds a second such state, and the two are **mutually exclusive** — opening
one closes the other. That interception is what makes a text field possible: a bare letter is bindable
nowhere else in this emulator, and a filename needs every printable character.

Within the form: `Tab`/`BackTab` and up/down move between fields, left/right cycle a cycle-field,
printables type, `Backspace` deletes, `Enter` submits, `Esc` cancels. **`Esc` must route through
`app.ts`'s existing ESC timer logic rather than around it** — that design "survived two regressions"
and is explicitly not to be simplified.

**`overlayFits` gets a sibling.** The keypad refuses to open on a terminal too small rather than
clipping (`OVERLAY_MIN`, 12x29); the form needs its own minimum — roughly 14 rows for nine fields plus
labels and a status line — and its own refusal.

## Lifecycle

Four states: `idle`, `running`, `done`, `failed`.

- **On submit**, keywords go to `parseTransferKeywords`. **A validation error keeps the form OPEN with
  the message shown**, rather than closing and discarding what was typed.
- **The 24x80 check happens at submit, before the host is told anything.** `runner.ts:454` already
  does this, and its comment gives the reason: better to say so here "than to have the first poll of
  the loop throw it after the host has been told to start". The refusal **names the current
  geometry**, as the model-4 program-check message names the model that would fit.
  **AND IT MUST SAY WHAT TO DO ABOUT IT, because the remedy is a RESTART.** `-model` is parsed once at
  launch (`tui/src/main.ts:106`) and **runtime model-switching does not exist** — it is roadmap item
  (10), unbuilt. So a user at `-model 3278-4-E` cannot fix this from inside the running client, and a
  message that only reports the geometry leaves them stuck. It must name the flag:
  *"CUT file transfer needs a 24x80 screen; this session is 43x80. Restart with `-model 3278-2-E`,
  or wait for DFT."* The user has accepted this constraint explicitly (2026-09-22) and **it is the
  main reason stage 2 exists**: DFT is what makes transfer work at their actual working geometry.
- **While `running`**, the form stays open showing progress from `CutTransfer`'s existing
  `TransferStep`, and the screen underneath keeps updating — in CUT mode a transfer *is* screen
  traffic.
- **Cancellation needs a public method, not new protocol work.** `CutTransfer.abort` exists and
  already sends the right thing (`AckAid.ABORT`, `SC_ABORT_XMIT`) but is **`private`**
  (`ft/transfer.ts:666`). Expose it. Note the asymmetry recorded at `:107-110`: a **host**-initiated
  abort is acknowledged with Enter, not PF2; `AckAid.ABORT` is only for an abort **we** initiate.
  Closing the form mid-transfer must abort rather than abandon, or the host program is left waiting.

## The filesystem seam

`TransferFiles` is already an injected **four-method** interface — `exists`, `read`, `write`, `append`
(`cli/src/transfer.ts:44-53`) — the same split `Replay()` uses, and what makes every string in that
module unit-testable.

`nodeTransferFiles` is the one genuinely Node-coupled piece, so **it cannot go in `frontend`** if
`frontend` is to stay browser-safe for stages 3 and 4.

**A NEW PACKAGE, `packages/node-files`, decided by the user 2026-09-22 in preference to duplicating
it.** It holds exactly one thing: the `TransferFiles` implementation over `node:fs`, moved from
`cli/src/main.ts:132` (`nodeTransferFiles`). `cli` and `tui` both depend on it; neither duplicates the
four methods, and there is one place where a filesystem bug can live.

Its dependency is **`frontend`** (for the `TransferFiles` type), so the graph becomes:

```
core ← frontend ← { cli, tui, node-files }   with { cli, tui } → node-files
core ← canvas ← { gui, web }
```

`gui` and `web` do **not** depend on it — which is the point of it being separate rather than folded
into `frontend`: the browser bundle must not acquire a `node:fs` import, and stage 4 needs a
*different* `TransferFiles` whose "filesystem" is an upload/download pair rather than a disk.

**Four mechanical steps that are each easy to forget, and the last two fail silently:**
1. `packages/node-files/package.json` — copy `frontend`'s shape: `@tn3270/node-files`, `type: module`,
   `main`/`types`/`exports` pointing at `dist`, one dependency on `@tn3270/frontend`.
2. `packages/node-files/tsconfig.json` — `extends ../../tsconfig.base.json`, `rootDir: src`,
   `outDir: dist`, and `references: [{ "path": "../frontend" }]`.
3. **Add `references` entries** for `../node-files` to `cli`'s and `tui`'s `tsconfig.json`. Without
   this the import resolves at runtime but the build order is undefined.
4. **Add `packages/node-files` to the ROOT `package.json`'s `typecheck` script**, which names every
   package explicitly (`tsc --build packages/core packages/frontend ...`). **A package missing from
   that list is silently exempt from typechecking** — the same class of gap as a harness that is not
   in `npm test`. `workspaces: ["packages/*"]` picks the new package up automatically, so `npm run
   build` needs no edit; only `typecheck` does.

Stage 4 will still revisit *policy*, because the web gateway raises *whose filesystem* — a
browser-initiated transfer moves bytes between the host and the **gateway's** disk, not the operator's
machine, which is a security question and not a UI one. `node-files` is the right shape for that
conversation: the gateway will supply its own implementation of the same interface rather than
inheriting this one by accident.

## Testing

- **`frontend/test/transferForm.test.ts`** — the model: cycle order, defaults, `applicable` for every
  rule above, and clearing on transition. Pure, no terminal.
- **The moved validator keeps its existing tests**, which move with it. This is the regression guard
  for the `cli → frontend` move: the ten keyword rules must behave identically after it.
- **`tui/test/transferOverlay.test.ts`** — rendering and key routing, following
  `keypadOverlay.test.ts`. Includes the too-small refusal.
- **Mutation-check the applicability rules.** Each of the five must be independently falsifiable:
  breaking one should redden exactly one test. Memory's standing lesson is that a rule which passes
  vacuously is worse than a missing one.
- **`node-files` needs a test that actually touches a filesystem**, since its whole reason to exist is
  the `node:fs` coupling. A tmpdir round trip of all four methods, plus `append` against a missing file
  and `exists` on a directory. **It must also be proven to be the SAME implementation `cli` used**: the
  existing `cli` transfer tests are the regression guard for the move, exactly as the validator's tests
  are for the `cli → frontend` move.
- **A live run against VM at `-model 3278-2-E`**, which is the only geometry CUT accepts. The
  committed `transfer-vm.txt` round trip is the oracle: the form must produce the same transfer.
  **Prove state before trusting the run** (`QUERY DISK A` → `Ready;`, not `?CP:`) and reach `LOGOFF`,
  or the VM reconnect trap is handed to the next run.

## Explicitly out of scope

- **DFT** — stage 2, and the thing that makes transfer work at 43x80.
- **The GUI and the web gateway** — stages 3 and 4.
- **`Space`/`Units`/`Avblock`** — x3270's TSO allocation keywords. Our validator does not implement
  them (`transfer.ts:321` notes the `TRACKS|CYLS` syntax is untested against any host), and this spec
  adds no new keywords.
- **A file browser.** The local-file field is a typed path. A picker is a separate feature and the TUI
  is the wrong place to prototype one.
