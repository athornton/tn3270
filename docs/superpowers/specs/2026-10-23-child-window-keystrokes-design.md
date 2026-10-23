# Keystrokes from the GUI's child windows — design

**Status: designed and approved 2026-10-23. Not implemented.**

**The idea, in the user's words:** *"typing should send keystrokes to the terminal emulator whether
the keyboard window or the terminal window has focus."*

**The defect it fixes, measured 2026-10-23.** Neither `keypadBoot.ts` nor `keyboardBoot.ts`
installs a `keydown` listener — `grep -c keydown` returns 0 for both. The only listener in the
product is `renderer.ts`'s, which lives in the CANVAS window. So in the GUI today:

- With the terminal window focused, every chord and character works.
- With the keypad or keyboard window focused, **the physical keyboard does nothing at all.** Not a
  dropped chord: silence. An operator who clicks a cap and then types finds the typing goes
  nowhere, and nothing on screen explains why.

The user hit this immediately after the keyboard window shipped, which is the expected way to meet
it: a window full of keys is an invitation to type.

## Scope

**THE ELECTRON GUI ONLY. THE WEB GATEWAY ALREADY WORKS AND NEEDS NO CHANGE.** Its keypad and
keyboard are `<div>` OVERLAYS inside the canvas page (`web/static/index.html:103` and `:135`), so
`renderer.ts`'s `window` listener already sees every keystroke aimed at them. The asymmetry is
Electron's separate `BrowserWindow`s, and it is the GUI's alone. **The TUI is untouched**, having
no such surfaces.

**BOTH CHILD WINDOWS, NOT ONLY THE KEYBOARD.** The keypad window has the identical gap and the
identical one-function bridge. Fixing only the window the user named would leave the other broken
in the same way, and the fix is the same code.

**OUT OF SCOPE: HELD PHYSICAL SHIFT ARMING THE ON-SCREEN ONE-SHOT.** Confirmed with the user:
*"if it feels weird we will revisit it later."* In the keyboard window a physical key and an
on-screen cap become two routes to the same action, and they do not share modifier state: pressing
physical `Shift` and then CLICKING `2` sends `2`, because the arm is the on-screen one-shot and
nothing set it. `docs/HANDOFF.md` already records why joining them is harder than it looks — if
held and one-shot share one flag, releasing a physical Shift clears an arm set by clicking. This
design deliberately does not conflate the two features.

## The decision: all chords work everywhere

**The user's choice, 2026-10-23, from three readings.** A child window behaves exactly like the
terminal window: characters, AIDs, and **every `Ctrl-` chord**, including the two that toggle these
very surfaces.

So `Ctrl-B` pressed IN the keyboard window raises `toggleKeyboard`, which calls `show()` and
`focus()` on the window that is already open — a self-focus, which is harmless. `Ctrl-K` from the
keyboard window opens the keypad, which is useful.

**Why not special-case the two toggle chords** (the rejected reading): `main.ts` already records
that *"the kind is the seam, not the mechanism"*, and `openKeyboardWindow` is idempotent precisely
so a repeated chord brings a window forward rather than stacking a second one. A special case
would add a second place for the rule to be wrong — the
one-path-clears-and-another-doesn't shape this project has met at least five times.

**Why not `globalShortcut`** (the other rejected reading): it registers chords SYSTEM-WIDE, so it
would steal `Ctrl-B` from every other application while the client runs. It also handles only
chords, so typing `A` would still do nothing — it does not solve the request.

## Architecture: one shared helper, two callers

**A new module, `packages/canvas/src/forwardKeys.ts`**, exporting:

```ts
forwardKeys(deps: ForwardKeysDeps): void
```

It installs ONE `keydown` handler that, in order:

1. **Returns if the event target is a form control** — `INPUT`, `TEXTAREA`, `SELECT`, or
   `contentEditable`. No window here has such a control today; this is here because a `window`
   listener sees events aimed at them and `renderer.ts` records the measured cost of learning that
   late: typing into the web transfer form sent every character TO THE MAINFRAME and left the field
   empty.
2. **Calls `actionForKey(e)`** and returns if it is `null`.
3. **Calls `preventDefault()` — only for keys we CLAIMED**, so shortcuts we do not use keep
   working and `Tab` does not move focus out of the window.
4. **Calls `sendAction(action)`.**

**WHY A NEW MODULE RATHER THAN IMPORTING `renderer.ts`.** That file value-imports `blit.js` and
`selection.js`; a child window pulling it in would drag the whole rasteriser into a document that
has no canvas, and each new specifier needs its own import-map entry in two HTML files.
`forwardKeys.ts` imports only `keys.js`, which has **zero runtime imports** — so each child
window's module graph grows by exactly one file.

**WHY `packages/canvas` AND NOT `packages/gui`.** It sits beside `keys.ts`, whose table it
consumes, and beside `keypadUi.ts`/`keyboardUi.ts`, whose injected-DOM shape it copies. `packages/gui`
imports `electron`, which would make the module unusable from anywhere else.

**INJECTED DEPS, NOT GLOBALS**, matching `createKeyboardUi` and `createKeypadUi`: `on` to register
the listener and `sendAction` to deliver. That is what lets this be unit-tested under
`environment: 'node'` with a hand-rolled fake, which is how every other piece of this feature's
logic is tested. jsdom is deliberately not a dependency of this repo.

**THE FORM-CONTROL PREDICATE IS EXTRACTED, NOT COPIED.** `renderer.ts` has step 1 already, and two
copies of a rule that must agree is how they diverge. The predicate moves into `forwardKeys.ts`,
is exported, and `renderer.ts` imports it — a targeted improvement to code this change is already
touching, not unrelated refactoring.

### Callers

`keyboardBoot.ts` and `keypadBoot.ts` each add one call, passing `window.addEventListener` and
their own bridge's `sendAction` — the bridge each file already reads and already fails loudly
without.

## Data flow, which is unchanged downstream

```
child window keydown
  -> forwardKeys: skip form controls, actionForKey, preventDefault
  -> that window's existing bridge.sendAction
  -> ipcRenderer.send('action')          [no new channel]
  -> main's ipcMain.on('action')         [ignores the sender]
  -> quit / toggleKeypad / toggleKeyboard / copy / transferForm interceptions, else applyAction
```

**`ipcMain.on('action')` reads no sender**, verified at `main.ts:1127` — so an action from a child
window already reaches the session by exactly the path a canvas-window keystroke takes, through
main's existing interceptions. **No new IPC channel and no change to `main.ts`.**

## Error handling

Nothing to catch. `actionForKey` is pure, returns `null` for anything unclaimed, and both boot
files already throw at LOAD time if their bridge is absent — so a missing preload fails with a
message rather than a window whose keys silently do nothing, which is the failure mode this whole
change exists to remove.

## Testing

**Unit, against the injected fake** (`canvas/test/forwardKeys.test.ts`), each case watched fail
first:

- a claimed chord forwards the right action;
- an unclaimed key (`Ctrl-Z`) forwards NOTHING;
- `preventDefault` is called for a claimed key and **not** for an unclaimed one — the half that
  would let a real accelerator break;
- an event whose target is an `INPUT` is skipped even when the key IS claimed;
- a plain character forwards `{kind:'type'}`.

**Real-window, under Xvfb.** Both boot files are untestable by construction — they read `document`
in their module bodies — and this repo's rule is that such a file must be **LOADED** to be
believed, never reasoned about. So a real `BrowserWindow` loads each document and a dispatched
keystroke is checked to reach the bridge.

**Gate:** build, typecheck, the full suite, and the browser harnesses — `browser-clicks.mjs` in
particular, because `renderer.ts` changes here and that harness is what proves the web gateway's
own key path still works.

**No live host run is needed, and the reason is the same one the keyboard feature gave:** every
action a forwarded keystroke can raise is one an existing chord or cap already raises, through the
same `applyAction`. Nothing new reaches the wire.
