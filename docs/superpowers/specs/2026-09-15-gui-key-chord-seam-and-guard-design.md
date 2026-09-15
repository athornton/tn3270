# Design — modifier chords in the GUI key seam, and a guard that can fail

2026-09-15. Closes the one soft spot named in `docs/HANDOFF.md` and `README.md:160`:
**PA1-3 work from a real keypress — the author confirmed it by hand against MVS — and
nothing in `npm test` or in any committed harness would notice if that broke.**

## The gap, stated exactly

Three separate things are missing, and only the first was previously written down.

1. **`TN3270_GUI_KEYS` cannot express a modifier chord.** `maybeSendKeys`
   (`packages/gui/src/main.ts:262`) calls `sendInputEvent` with no `modifiers` array, so
   `Alt`, `Ctrl` and `Shift` can never be held. Every chord in the GUI's keymap — the PA
   keys, Attn, Clear, Reset, EraseInput, back-tab, PF13-24 — is therefore unreachable
   through the seam.
2. **No committed harness drives the seam at all.** `shot.mjs` never sets
   `TN3270_GUI_KEYS`; it sets `TN3270_GUI_REPLAY`, `TN3270_GUI_SHOT` and
   `TN3270_GUI_SHOT_MS` only. So even the unmodified keys the seam *can* send are exercised
   by nothing that runs on a schedule.
3. **The seam is not reachable without also taking a screenshot.** `maybeSendKeys` is
   called only from inside `maybeCapture`, which returns immediately when
   `TN3270_GUI_SHOT` is unset. A keys-only run is impossible as the code stands.

`packages/gui/test/keys.test.ts` covers `actionForKey` thoroughly, but it hands that
function a synthetic `KeyLike` object. The links it cannot reach are the ones that broke
before: Chromium's real event, the renderer's own `keydown` listener, the IPC hop, and
`ipcMain`'s dispatch to `applyAction`.

## Measured first: which spellings Chromium accepts

Probed on Electron 44.0.0 under Xvfb, 2026-09-15, by sending each `keyCode` through
`sendInputEvent` and logging what a `keydown` listener received. **This is the finding that
shapes the design.**

| seam spelling | `key` | `code` | verdict |
| --- | --- | --- | --- |
| `1` | `1` | `Digit1` | valid — what the PA path matches on |
| `Digit1` | `` (empty) | `` (empty) | **invalid, and SILENT** |
| `Up` `Down` `Left` `Right` | `ArrowUp` … | `ArrowUp` … | valid |
| `ArrowUp` | `` (empty) | `` (empty) | **invalid, and SILENT** |
| `A` and `a` | both `a` | `KeyA` | **lowercase either way** — the case of the spelling is ignored |
| `Space` | a space | `Space` | valid |
| `Home` `End` `Delete` `Backspace` `Tab` `Escape` `Insert` | same as spelling | same | valid |
| `F1` `F12` `F13` | `F1` … | `F1` … | valid; `F13` is a deliberate negative |
| `]` | `]` | `BracketRight` | valid |
| `Alt+1` | `1` | `Digit1`, `altKey: true` | **valid — the gate this design needed** |
| `Ctrl+Z` | `z` | `KeyZ`, `ctrlKey: true` | valid; a deliberate negative |

Two consequences:

- **The chord arrives correctly, so the seam can genuinely exercise the PA path.**
  `actionForKey` matches PA on `e.code` (`keys.ts`, and the reason is macOS: Option-1
  reports `key === '¡'`). `sendInputEvent` populates `code`, so no compromise is needed.
- **The spelling a reader of our own keymap would reach for is the invalid one.** That
  keymap is written in terms of `e.code` and `e.key`, so `Digit1` and `ArrowUp` are the
  natural guesses, and both deliver an *empty* event: `key: ''`, `keyCode: 0`.
  `actionForKey` then returns `null`, no action is sent, and the run still exits 0 with the
  seam reporting `keys: sent Digit1`. A test written that way passes while proving nothing —
  the exact failure mode this repo has been bitten by before.

Also worth recording, because a docstring is currently wrong: the seam's own example
`TN3270_GUI_KEYS=A,B,Enter` types **"ab"**, not "AB". Whether `Shift+A` yields a capital
was NOT measured — no case needs it, so the harness does not assume it.

## What gets built

### 1. `parseKeySpec`, a pure function in a new `packages/gui/src/keyspec.ts`

`'Alt+1'` → `{ keyCode: '1', modifiers: ['alt'] }`. Comma-splitting stays in the caller;
this parses one spec.

- Modifier prefixes are `+`-joined and case-insensitive in their *names*: `Ctrl`/`Control`,
  `Alt`/`Option`, `Shift`, `Meta`/`Cmd`/`Command`/`Super`. They map to Electron's
  lowercase `'control'`, `'alt'`, `'shift'`, `'meta'`.
- The final segment is the key and passes through **verbatim**, case preserved. Nothing
  about it is normalised: `]` and `1` and `F1` are all just strings to `sendInputEvent`.
- **It THROWS on a DOM-code spelling** — `/^(Digit|Key|Numpad|Arrow)/` — naming the valid
  form in the message (`Digit1` → use `1`; `ArrowUp` → use `Up`). This is the one piece of
  cleverness in the design and it exists because the alternative is a silent pass. It is a
  refusal and not a translation, so nobody learns a spelling that only our harness accepts.
- It also throws on an unknown modifier name and on an empty key, for the same reason.

Why a new file rather than `keys.ts`: `keys.ts` is renderer-side and maps browser events to
actions; this is main-side and builds synthetic input. Different direction, different
consumer. Keeping it out of `keys.ts` also keeps it out of the renderer's import graph,
which `renderer-imports.test.ts` polices.

### 2. An action log at the one funnel, gated on the seam

`ipcMain.on('action')` in `main.ts:198` is the single point every renderer action passes
through. When — and **only** when — `TN3270_GUI_KEYS` **and** `TN3270_GUI_REPLAY` are both
set, it writes `action: {"kind":"pa","n":1}` to stdout before dispatching.

**The gate is a privacy requirement, not tidiness.** `type` actions carry the text typed,
so an unconditional log would put a password on stdout in a live session — the same hazard
that keeps goldens away from live logons.

**Corrected during review: gating on the seam variable ALONE was the wrong condition.**
The first draft of this design reasoned that under the seam every keystroke came from the
environment variable, so nothing secret could exist. That premise is false. Nothing stops
`TN3270_GUI_KEYS` being set on a run that connects to a live host, and
`docs/live-testing.md`, *Typed input, proved end to end*, records exactly that — this seam
driven against live MVS TK5 with `HERC01` typed at its logon panel by hand. `keys.ts` builds
`{ kind: 'type', text: e.key }` for **any** printable keypress, seam-driven or not, so the
log would have carried a hand-typed password. **Replay mode is the condition that actually
makes a logged keystroke impossible to be a credential**, because a replayed session is
connected to nothing. It costs no coverage: the harness sets both variables together.

Key order in `JSON.stringify(action)` is insertion order and not a contract, so a consumer
compares canonically rather than string-diffing the raw line.

### 3. Lifting the seam out of the screenshot path

`maybeSendKeys` becomes its own step, awaited before `maybeCapture`:

- A **keys-only** run (`TN3270_GUI_KEYS` set, `TN3270_GUI_SHOT` unset) waits for the paint
  to settle, sends the keys, prints its summary, and quits. Without its own quit the process
  hangs, and a hanging harness reads as a broken client.
- A **screenshot** run keeps today's ordering exactly: settle, keys, then capture. Keys
  before the picture is deliberate — typing into a screen with no field yet proves nothing.
- A run with **neither** seam set is untouched, which is what keeps the two existing
  goldens byte-identical.
- `TN3270_GUI_KEYS_MS` (default 1200) is how long to let the replay paint before typing,
  mirroring `TN3270_GUI_SHOT_MS`'s reason for existing.
- The quit is preceded by a short drain, because `process.stdout.write` to a pipe is not
  synchronous and `app.quit()` would otherwise be free to truncate the last action line.

### 4. `packages/gui/scripts/keys.mjs`, the committed harness

A sibling of `shot.mjs`, not a case inside it. Two reasons: the failure modes are
different (an action sequence versus a bitmap hash), and a chord that *did* change the
screen would silently re-baseline a pixel golden on the next `--update`.

It runs the client under Xvfb in replay mode against `synthetic-ispf-like.trace` — no host,
no socket, no logon — sends one comma-joined `TN3270_GUI_KEYS` string, and asserts the
**exact ordered sequence** of `action:` lines. Cases:

| chord | expected action |
| --- | --- |
| `Alt+1`, `Alt+2`, `Alt+3` | `pa` 1, 2, 3 |
| `Ctrl+A` | `attn` |
| `Ctrl+C` | `clear` |
| `Ctrl+U` | `eraseInput` |
| `Shift+Tab` | `backTab` |
| `Tab` | `tab` |
| `F1` / `Shift+F1` | `pf` 1 / `pf` 13 |
| `Insert` | `toggleInsert` |
| `Enter` | `enter` |
| `Ctrl+Z` | **no action** |
| `F13` | **no action** |

The two negatives carry real weight: `Ctrl+Z` must be dropped rather than typing "z", and
`F13` must not become `pf 13`. Both are asserted as absences, so the pass condition is the
whole sequence rather than a set of sightings.

`Ctrl+]` is deliberately **excluded**: it quits, and would truncate the run. A comment says
so, so nobody adds it back as an oversight.

Xvfb startup moves from `shot.mjs` into a shared `packages/gui/scripts/xvfb.mjs` and both
scripts import it. The recorded trap stays inside it: start detached with `nohup`-equivalent
semantics and **prove the socket** at `/tmp/.X11-unix/X99`, because a `pgrep -f "Xvfb :99"`
guard matches the shell command containing it, and the symptom is "Missing X server" with
`DISPLAY` set.

### 5. Guards inside `npm test`

- **`packages/gui/test/keyspec.test.ts`** — the parser: each modifier, multiple modifiers,
  verbatim key passthrough, the `Digit1`/`ArrowUp`/`KeyA`/`Numpad0` refusals, an unknown
  modifier, an empty key. The refusals are the point of the file.
- **`packages/gui/test/keys-harness-flags.test.ts`** — reads `keys.mjs` as text and pins
  `-insecure`, `--no-sandbox`, `--disable-gpu`, that it uses `TN3270_GUI_REPLAY`, that its
  case list contains at least one `Alt+` chord and both negatives, and that the expected
  sequence is non-empty. Same reasoning as `shot-flags.test.ts`: a harness outside the fast
  gate is exempt from every change until somebody remembers it, and `pty-smoke.py` sat at
  1 of 12 for two days proving it.

## How this is verified

`npm test`, `npm run typecheck`, `npm run build`, both existing goldens still matching, and
`node packages/gui/scripts/keys.mjs` green.

**And a mutation, without which none of the above is evidence.** With everything passing,
comment out `PA_CODES` in `keys.ts` (or its lookup in `actionForKey`), rebuild, and confirm
`keys.mjs` reports the three PA lines missing and exits non-zero. Then revert. This repo has
already found one test that was unfalsifiable and one that passed vacuously against an
unimplemented branch; a guard whose failure has never been seen is in that family.

**CORRECTED BY MEASUREMENT, 2026-09-15 — the mutation above does NOT show what this design
claimed it would.** Unbinding `PA_CODES` reddens `npm test` as well: `keys.test.ts` calls
`actionForKey` directly, and that is where the mapping lives, so three of its tests fail. The
same is true of a PA2→PA3 transposition (3 failures) and of giving `Ctrl+Z` a binding (1).
**So no mapping-table mutation demonstrates anything this harness catches that the unit tests
do not**, and quoting one as proof of incremental value would be a false claim of exactly the
kind this repo has shipped before.

**The honest proof is a PLUMBING mutation.** Add `if (e.altKey) return;` to `renderer.ts`'s
`keydown` listener — the original bug's shape, chords never reaching the mapper — and
`npm test` stays **fully green at 1352** while `keys.mjs` fails all 13 positions. That is the
gap: the renderer's own listener, the IPC hop and `ipcMain`, none of which a synthetic
`KeyLike` can reach. The mapping mutations remain worth running, but as a demonstration that
the guard also catches the obvious case — not as the argument for its existence.

Two further mutations worth keeping, because they answer questions the obvious one does not:
the **PA2→PA3 transposition** proves the guard catches a realistic regression rather than only
wholesale removal (it reports one position, not a cascade); and **binding `Ctrl+Z`** proves the
negatives are load-bearing. The second is subtler than it looks — the injected action is
`reset`, which legitimately appears elsewhere in the sequence from `Ctrl+R`, so a
set-of-sightings comparison would have seen nothing new. **The ordered comparison is what makes
the negative bite**, which retires it as a stylistic choice.

A second mutation worth one run: change a seam spelling to `Digit1` and confirm the parser
refuses it *before* Electron starts, rather than the run passing with a missing action.

## Deliberately not in scope

- **Extending this to the TUI.** Its keys arrive as byte sequences over a pty and
  `pty-smoke.py` already drives them; there is no equivalent gap.
- **A pixel golden of a chord's effect.** In replay mode no host answers an AID, so most
  chords change nothing on screen and the golden would pin an absence.
- **`Ctrl+]`/quit coverage** — see above.
- **Mouse, keypad, or menu work.** The virtual keypad is its own spec, and the user placed
  it before Programmable Symbol Sets on 2026-09-15.

## Success criteria

1. `TN3270_GUI_KEYS='Alt+1'` produces `{ kind: 'pa', n: 1 }` at `ipcMain`, shown by a
   committed harness rather than by hand.
2. Unbinding the PA keys turns that harness red — demonstrated, not assumed.
3. A DOM-code spelling is refused with a message naming the valid form, and that refusal is
   pinned in `npm test`.
4. Both existing screenshot goldens still match without `--update`.
5. `README.md` and `docs/HANDOFF.md` no longer describe the PA plumbing as unguarded, and
   `docs/live-testing.md` carries the spelling table above.
