# Web copy gesture — design, 2026-10-27

Roadmap item (0e)'s missing piece. Web copy and paste shipped its whole server path, its
`copyText` protocol message and its clipboard write — and **no way for a browser operator to
invoke copy**. This spec adds the gesture.

## The defect this closes

Measured 2026-10-26, after Task 6 landed:

- No `copy` entry in `canvas/src/keys.ts`'s `CTRL` table.
- No `addEventListener('copy')` anywhere in `packages/` (exit 1 on the grep).
- No Copy cap in `frontend/src/keypad.ts` or the 122-key keyboard.
- Nothing in `packages/web/static/index.html`; no `contextmenu` handler anywhere.
- `__tn3270Copy` has exactly three callers: `gui/src/main.ts:1020` (the Electron Edit menu),
  `gui/src/main.ts:1747` (the `TN3270_GUI_SELECT` seam), and `browser-clicks.mjs`.

So web copy is reachable only by Electron's menu or a harness. **Paste works in the browser
only by accident of non-interference** — `keys.ts` never claimed `Ctrl-V`, so Chromium's own
pipeline delivers a `paste` event. Copy gets no such free ride, because no native gesture
produces text from a `<canvas>` whose selection is internal state.

`README.md:287` documents the gesture as "copy from the Edit menu", which is true only for
Electron. `README.md:316` still claims "The web gateway has NEITHER copy nor paste yet",
which is now false in both directions.

## Decision: `Ctrl-Shift-C`, on every platform, as an explicit chord

The user's call, 2026-10-27, taken as an interim with a Linux test to follow. Two
alternatives were examined and are recorded below rather than deleted, because both came
from the user and the reasoning is worth keeping.

### Why not the native `copy` event

**MEASURED, Electron 44.3.0 under Xvfb, with NO text selected in the document** — which is
our real case, since the canvas selection is `anchor`/`focus` module state (`renderer.ts:88`)
and not a DOM Range; there is no `getSelection` or `createRange` call anywhere in
`packages/canvas` or `packages/web`:

```
Ctrl-C        -> copy event FIRES, clipboardData present
Cmd-C         -> no copy event
Ctrl-Shift-C  -> no copy event
```

So on Linux the native copy gesture is **`Ctrl-C` — the Clear AID**. We cannot adopt the
native `copy` event the way paste adopted the native `paste` event: the chord collides with
the one binding this project has already decided must stay Clear everywhere. `menu.ts:58-69`
records that decision and records REJECTING a conditional "Ctrl-C copies when a selection
exists, Clear when it does not", because it makes a destructive AID depend on invisible
state.

**AND IT CORRECTS A CLAIM MADE EARLIER IN THIS SESSION: macOS does NOT get `Cmd-C` for
free.** `actionForKey` returns `null` for `Cmd-C`, so the browser default runs — but the
browser default on a document with no DOM selection fires no `copy` event and copies
nothing. The earlier claim ("macOS gets Cmd-C for free, today, with zero code") was wrong,
and wrong in the same shape this project keeps recording: a `null` from our keymap was read
as "the platform handles it", when it only means "we declined it". The probe above was run
with no selection precisely to test that, and it is why `Cmd-Shift-C` is specified below
rather than assumed unnecessary.

### Why not Clear on `Ctrl-L` (user suggestion, declined on evidence)

The premise was right: zti does bind Ctrl+L to Clear (`zti.py:1066-1067`, and the handler at
`:2196-2208`). But the reason is not the one supposed. zti binds **Ctrl+C to Attn**, not
copy — it is a curses TUI with no clipboard to compete with — and its Ctrl+L handler does a
terminal resize-and-redraw before sending Clear, commented *"assume Ctrl+L is for size
change"*. zti chose Ctrl+L because in a terminal that chord means *redraw*, and Clear is the
3270 action that repaints. It did not move Clear off Ctrl+C to free the clipboard.

Against it:

1. **c3270 already binds `Ctrl<Key>l: Redraw()`** (`Common/fb-c3270:192`, the non-Windows
   table a terminal build reads) and `Ctrl<Key>c: Clear()` at `:185`. Our keymap was lifted
   from that table. Clear-on-Ctrl-L would make us the only 3270 client where Ctrl-L clears.
2. **`Ctrl-L` is the address bar on Windows and Linux** (Chrome's own docs and Wikipedia's
   shortcut table agree: `Ctrl+L`/`Alt+D`/`F6` there, `Cmd+L` on macOS). Whether a page can
   `preventDefault` it on those platforms is **UNVERIFIED** — there is no real browser on
   this box, and Electron has no address bar so it answers "free" regardless, which is a
   falsely encouraging oracle.
3. The user's own macOS Firefox test (Ctrl-L reached the page) **cannot settle it**: on
   macOS the address bar is `Cmd-L`, so `Ctrl-L` was never the browser's shortcut there and
   there was nothing to win. Same shape as the save-dialog lesson — the visible outcome did
   not identify the mechanism.
4. The proposal's macOS spelling, `Cmd-L`, is exactly the address bar on macOS.

**Not closed, pending one measurement.** If a Linux or Windows page CAN swallow Ctrl-L, this
is worth re-examining — the Redraw collision would still stand, but the reachability
objection would fall. The test: a `keydown` listener calling `preventDefault` on Ctrl-L; see
whether the address bar still takes focus.

### Why not `Alt-C` (recommended, not taken)

Both references bless it — c3270 `Alt <Key>c: Clear()` (`fb-c3270:86-87`) and zti `Alt+C` —
and the Alt branch is already established in our keymap (PA digits, `Alt-K`). It needs no
platform detection and no browser-reservation gamble. The user chose `Ctrl-Shift-C` for now
instead. Recorded because it remains the better long-term answer if Clear ever does need to
move off `Ctrl-C`, and because an `Alt-C` Clear alias is independent of this spec.

## What ships

### 0. CORRECTION, 2026-10-27: the chord CANNOT raise `copy`, and §1-§3 below understate this

**Found while writing the plan, before any code was written.** The sections below say the chord
maps to `{kind:'copy', rect}` in `keys.ts`. **That is not implementable.** `copy` carries
`rect: {top,left,bottom,right}` (`frontend/src/keymap.ts:130`), and `actionForKey(e: KeyLike)`
is a PURE function of a key event — the selection lives in `renderer.ts`'s module-level
`anchor`/`focus` (`renderer.ts:88`), which a key mapper cannot see.

So the mapping is two-step, and the plan adds a task for it that this spec did not have:
`keys.ts` raises a new intent-only **`{kind:'requestCopy'}`**, and `renderer.ts` — the one place
that knows the rectangle — converts it to a real `copy`. Being a kind `applyAction` throws on, it
also needs a decode REJECTION at the gateway, per the two-branch rule.

**CORRECTION, 2026-10-27, from Task 1's implementation: that split is `transferForm`'s, NOT
`toggleKeypad`'s.** This paragraph said "the split `toggleKeypad` already uses" and the plan
repeated it twice. `toggleKeypad` is a SINGLE kind terminally intercepted — `bridgecore.ts`'s
branch calls `deps.toggleKeypad?.()` and returns, and nothing converts it into a second kind.
`transferForm` is the genuine two-step: its branch shows an overlay which LATER emits different
messages. `requestCopy` → `copy` is `transferForm`'s shape.

Read `docs/superpowers/plans/2026-10-27-web-copy-gesture.md` Task 1 for the shape. Everything
else below stands as written.

### 1. `Ctrl-Shift-C` -> a copy request in `canvas/src/keys.ts`

**THE OBSTACLE IS THAT THE `CTRL` LOOKUP IS CASE-FOLDED ON PURPOSE.** `keys.ts:167-170`:

```ts
if (e.ctrlKey && !e.altKey && !e.metaKey) {
  // Case-folded because Ctrl-Shift-C still means Clear, and browsers report the shifted
  // letter. `?? null` is what drops Ctrl-Z rather than typing "z".
  return CTRL[e.key.toLowerCase()] ?? null;
}
```

Verified by driving `actionForKey`: `Ctrl-C` and `Ctrl-Shift-C` BOTH return
`{"kind":"clear"}` today. So a `copy` entry cannot simply be added to `CTRL` — the fold
swallows the Shift. A `shiftKey` test must come **before** that lookup.

**THIS DELIBERATELY BREAKS THE COMMENT AT `:168`.** Plain `Ctrl-C` still means Clear, which
is the property that comment exists to protect; what changes is that the shifted form stops
being an alias for it. The comment must be rewritten, not left to contradict the code — this
repo's recorded failure mode is a fix reaching the body and never the sentence that
summarizes it.

`Ctrl-Shift-C` is free of other meaning: the taken Ctrl chords are
`C R U ] A D F K B T` and none is reached with Shift except by that fold.

### 2. `Cmd-Shift-C` on macOS, by the same branch

Because `Cmd-C` copies nothing on a canvas (measured above), macOS needs a real binding too.
`Cmd-Shift-C` is the natural pair and is NOT the address bar. The branch should test
`(e.ctrlKey || e.metaKey) && e.shiftKey` on `e.code === 'KeyC'`, which gives both platforms
one chord each with **no platform detection** — the point being that neither chord is
ambiguous on either platform.

**MATCH ON `e.code`, NOT `e.key`.** `KeyLike.code`'s own note (`keys.ts:28-32`) records why:
on macOS Option-1 reports `key === '¡'`, so an `e.key` binding works on Linux and fails on a
Mac. A Shift chord has the same hazard — `e.key` is the shifted form — and matching the
physical key is what `Alt-K` already does for this reason.

### 3. The action is already plumbed; only the trigger is missing

`__tn3270Copy()` (`renderer.ts:485-512`) already normalizes the rect, refuses an empty
selection, returns a boolean, and raises `{kind:'copy', rect}`. The gateway answers it
(`web/src/main.ts:389`) and the bridge writes the clipboard (Task 4). **So this is a
keybinding change, not a feature build** — the new chord routes to the existing global.

`renderer.ts`'s `keydown` listener calls `preventDefault` only for claimed keys and clears
the selection on any claimed action. **Copy MUST NOT clear the selection** — the listener
clears unconditionally once `actionForKey` returns non-null (`renderer.ts:307-316`), so the
new branch needs an exemption or **a copy wipes the rect it just sent**. This is the
subtlest part of the change and the one a test must pin.

**AND IT INVALIDATES A COMMENT THAT CURRENTLY STATES THE OPPOSITE INVARIANT.**
`renderer.ts:312-315` reads, verbatim:

> the Copy accelerator itself arrives as a keystroke, and clearing on unclaimed keys would
> wipe the selection a moment before main asked for it. (On macOS the accelerator is consumed
> by the menu before the page sees it; on Linux `Ctrl+Shift+C` is **not in `actionForKey`'s
> table**, so it lands here as an unclaimed key. Either way the selection must survive it.)

That paragraph's whole mechanism is that `Ctrl+Shift+C` is UNCLAIMED — which is exactly what
this change reverses. It is the only such comment in the repo (grepped). Today the selection
survives a copy *by accident of non-binding*; after this change it must survive *by explicit
exemption*. The comment must be rewritten in the same commit, and the rewrite is the
load-bearing part: a reader who trusts the old text will conclude no exemption is needed.

Note the macOS half of that paragraph stays true for the Electron GUI (the menu consumes the
accelerator before the page sees it) and is irrelevant in the browser, which has no menu.

### 4. The Electron GUI is affected too, and must be checked — but has NO freeze hazard

`keys.ts` is shared by both DOM front ends, so this chord also becomes live in the Electron
window. Unlike Task 5's `paste`, **this is safe by construction**: `gui/src/main.ts:1206`
already intercepts `action.kind === 'copy'` and never reaches `applyAction`, which throws on
it. Verified by reading that arm. So there is no repeat of the frozen-main-process hazard.

**What MUST be measured instead is a double copy on Linux.** Task 5 measured that
`Ctrl+Shift+V` fires BOTH the page event and the Electron menu accelerator, and that
page-side `preventDefault()` does not suppress the accelerator. `menu.ts:70-76` makes
`Ctrl+Shift+C` the Linux/Windows **Copy accelerator**, so the same overlap is likely here:
the new keydown branch would raise `{kind:'copy'}` AND the menu's `onCopy` would fire
`__tn3270Copy()` via `executeJavaScript`.

Two copies of the same rect to the same clipboard is idempotent, so the user-visible harm is
low — but it would print `copy: N chars` twice, which `select.mjs` asserts on, and it is the
same class of defect that made option (a) wrong in Task 5. **Measure it before deciding**
whether the GUI needs the keydown branch gated off `file:` the way `forwardPaste` is, or
whether the menu accelerator should simply be left to own the chord in Electron.

### 5. Docs

- `README.md:287` — "copy from the Edit menu" is Electron-only; name the browser chord.
- `README.md:316` — "The web gateway has NEITHER copy nor paste yet" is false; replace.
- `docs/live-testing.md` — the Task 7 claim that the OS clipboard "is not machine-checkable"
  is ALSO false: it IS checked over loopback by `browser-clicks.mjs`. What stays human-only
  is the LAN / plain-`http` non-secure-context case.

## Testing

- `keys.test.ts`: `Ctrl-Shift-C` and `Cmd-Shift-C` both give `{kind:'copy'}`; plain `Ctrl-C`
  still gives `{kind:'clear'}`; `Ctrl-Shift-V`/`Cmd-Shift-V` are NOT claimed (paste is the
  native event's job, and claiming it would suppress the `paste` event we rely on).
- **A test that the selection SURVIVES a copy chord**, per 3 above. Mutation-check it by
  removing the exemption — if the suite stays green, the test is not pinning it.
- `browser-clicks.mjs`'s `webCopy` currently calls `__tn3270Copy()` directly, and its own
  comment says the page binds no Copy gesture and that only the human's keystroke is
  substituted. **That comment becomes false** and the check should drive the real chord
  through `Input.dispatchKeyEvent`, which is strictly stronger: it would then cover the
  binding too, not just the path behind it.

## Open, for the user

- The Linux/Windows Ctrl-L measurement above.
- Whether `Alt-C` should land as a Clear alias regardless, since both references bless it
  and it costs nothing.
