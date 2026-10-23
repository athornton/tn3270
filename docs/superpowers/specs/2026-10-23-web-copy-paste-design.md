# Web copy and paste — design

**Status: designed and approved 2026-10-23. Not implemented.**

Roadmap item **(0e)**, and the user's stated prerequisite for packaging: *"we're still going to
need to implement copy/paste and the transfer form in the Web interface before we go to
packaging."* With the web transfer UI merged, this is the **last gap between the two front ends**.

## What is already true, measured rather than assumed

**COPY IS FURTHER ALONG THAN THE ROADMAP NOTE SUGGESTS.** `canvas/src/renderer.ts` is shared by
both DOM front ends, so the browser ALREADY has the drag selection, the highlight, and
`__tn3270Copy` — which already sends `{kind:'copy', rect}`. The gateway refuses it.

**THAT REFUSAL IS LOAD-BEARING AND MUST NOT BE DELETED ON ITS OWN.** `applyAction` throws on
`copy`, and `web/src/main.ts` calls it OUTSIDE ANY TRY inside a socket `data` handler — so removing
the refusal without adding an interception in the same commit ends the gateway process and **every
connected operator's session** on the first browser copy. `protocol.ts` records this, and the same
two-branch rule was already exercised for `transferForm`.

**PASTE HAS NO BROWSER PATH AT ALL.** No `paste` listener, no `Ctrl-V` in `canvas/src/keys.ts`,
nothing in either web bridge file.

## The decision that changed during design, and it is a safety one

**MY FIRST DESIGN REUSED `{kind:'type', text}` FOR PASTE. THAT WOULD HAVE BEEN A REAL DEFECT.**

`applyAction`'s `type` arm is `k.typeString(action.text)`, and `core`'s `typeString` is a bare loop
over `type(ch)` returning a boolean. Pasting multi-line text through it would send:

- every `\n` as **Enter — an AID that SUBMITS a half-filled panel to a live host**
- every `\f` as **Clear, which WIPES the screen mid-paste**

`frontend/src/paste.ts`'s `pasteString` exists precisely because those two cases were measured from
x3270's `Common/kybd.c` (`:3928`, `:3957`, `:3918`, `:3920`) and its header says both "would have
been guessed wrong". It also drops `\r` so CRLF text does not gain a stray character per line, and
returns `{typed, dropped, reason?}` — none of which `typeString` has.

**SO PASTE GETS ITS OWN ACTION KIND.**

## Architecture

### 1. `Action` gains `{ kind: 'paste'; text: string }`

In `frontend/src/keymap.ts`, beside `copy` and `type`.

**`applyAction` DOES NOT HANDLE IT — IT THROWS**, exactly as it does for `quit`, `toggleKeypad`,
`transferForm`, `copy` and `toggleKeyboard`:

```
applyAction does not handle paste: the front end owns its own clipboard
```

**AND IT IS A POLICY CHOICE, NOT A MECHANICAL NECESSITY — corrected during spec review.** A first
draft of this section claimed `applyAction` *could not* handle paste because `pasteString` needs a
`Screen` as well as a `Keyboard`. That is false: `applyAction(session, action)` takes a `Session`,
which carries both, and `main.ts:1040` calls `pasteString(session.keyboard, session.screen, text)`
from exactly such an object. It could be handled there.

**THE REAL REASON IS THE ESTABLISHED PATTERN, AND IT IS SUFFICIENT.** Every kind whose meaning
depends on *whose machine it lands on* throws in `applyAction`: `quit`, `toggleKeypad`,
`toggleKeyboard`, `transferForm` and `copy`. Paste is that kind of kind — the clipboard belongs to
the operator, and only the front end knows how to reach it. A front end that forgot the arm then
fails loudly rather than being silently inert, which is the property the throw exists to give.

**THE WEAKER ARGUMENT IS RECORDED BECAUSE IT IS THE KIND THAT GETS RE-ADOPTED** from a design doc
and then defended as a constraint. If a later change wants paste handled centrally, the pattern is
the only thing in its way, and that is a decision rather than an obstacle.

**`ClientMessage` NEEDS NO CHANGE.** `{kind:'action', action}` already carries any `Action`.

### 2. One shared paste path, replacing the GUI's private one

Today the GUI's paste rules live inline in `main.ts`'s `onPaste` menu handler. After this, **both
front ends intercept `{kind:'paste'}` and call the same helper**, so the browser is not a second
copy of the rules. The GUI's menu handler becomes one of two callers.

The helper reports with the GUI's existing wording, verbatim:

- `paste stopped: ${reason} after ${typed} of ${typed + dropped} characters`
- `paste short: ${typed} of ${typed + dropped} characters (field full or protected)`

### 3. Reporting reuses `{kind:'error', message}` — no new inbound message

That arm is already in `ServerMessage`. **AND THE REPAINT IS WHAT DISMISSES IT**, which is the
non-obvious part: `renderer.ts`'s `onError` BLANKS the canvas and draws text, which would be wrong
for "paste short" on its own — but `onFrame` sets `errored = false`, and the GUI already sends a
frame **unconditionally** after a paste because a paste emits no `screen` event. So the warning
shows and the next frame clears it, in both front ends, with no new mechanism.

### 4. Copy: `ServerMessage` gains `{ kind: 'copyText'; text: string }`

The union's own comment predicts this: *"web copy will be the next thing to widen it."*

`web/src/main.ts` intercepts `copy`, extracts with
`extractText(resolve(snapshot), snapshot.cols, action.rect)` exactly as the GUI does, and sends
`copyText` back.

**`extractText` HONOURS `hidden`, AND THAT IS THE ONE LINE HERE WHOSE FAILURE MODE IS A LEAKED
PASSWORD.** `ResolvedCell.text` is still the real character in a non-display field; `selection.ts`
substitutes a space. It is already mutation-verified in `canvas/test/selection.test.ts`, and this
work asserts the WEB path preserves it rather than assuming the shared function is enough.

**`copy` MOVES FROM `protocol.ts`'s `REFUSED` LIST TO `integration.test.ts`'s `SWALLOWED` LIST**,
in the same commit as the interception. Not out of both — that is the two-branch rule, and
`transferForm` is the worked precedent.

### 5. `bridgecore.ts` / `bridge.ts`: an optional `onCopyText` dep

`navigator.clipboard.writeText(text)` in `bridge.ts`. **OPTIONAL**, like `toggleKeypad`,
`toggleKeyboard` and `onTransfer`, for the reason those give: the gateway's own tests and any
caller with no DOM must be able to construct a bridge without one.

**`BridgeApi`'s FOUR FUNCTIONS ARE UNTOUCHED.** That rule is about the surface `renderer.ts`
consumes unmodified, and this adds a `BridgeDeps` member — the same distinction `toggleKeypad` and
`onTransfer` already rely on.

**`writeText` IS SECURE-CONTEXT-ONLY, AND THIS GATEWAY OFTEN HAS NO SECURE CONTEXT.** The repo
already records that for `showSaveFilePicker`: a LAN gateway on plain `http` fails the check, and
`undefined` is the COMMON case there, not an edge one. So copy needs the same shape of handling the
transfer feature uses — **feature-detected by the caller and injected**, with a documented
fallback, decided by MEASUREMENT in a real browser rather than invented here. The `paste` event has
no such requirement, so the inbound direction works regardless.

### 6. `renderer.ts`: a `paste` listener

Reads `e.clipboardData.getData('text/plain')`, calls `preventDefault()`, sends
`{kind:'paste', text}`.

**IT MUST SKIP FORM CONTROLS**, and `isEditableTarget` from `forwardKeys.ts` already exists for
exactly this. The listener is on `window` and the transfer form has real text inputs — this is the
measured 2026-10-07 bug in the other direction, where typing into that form sent every character
TO THE MAINFRAME and left the field empty.

**NO `navigator.clipboard.readText` ANYWHERE.** The `paste` event hands over the text with no
permission prompt and works in every browser; `readText` prompts in Chromium and is unsupported in
Firefox. The native `Ctrl-V` is the trigger, so there is no new chord and no menu bar needed.

### 7. `BROWSER_MODULES`, because `renderer.ts` is SERVED

If the paste path gives `renderer.ts` a new relative import, it must join `BROWSER_MODULES` in
`canvas/src/assets.ts` and the count in `web/test/httpstatic.test.ts` **in the same commit**.
Omitting this cost a run on 2026-10-23: the module 404'd, `renderer.js` never evaluated, and
`browser-clicks.mjs` reported `1/8` while blaming three unrelated checks. The repo's own guard
catches it (`imported but not served`), but it lives in `packages/web` — so **run the whole suite**,
never a package-scoped subset.

## Error handling

- **A clipboard the browser refuses** (no secure context, a denied permission) must report and
  leave the session alone — never throw into the socket handler. The GUI's precedent: a `catch`
  that prints, because `void` on a rejecting promise is what CREATES an unhandled rejection.
- **An empty copy does not touch the clipboard.** Copying a blank region must not wipe what the
  operator copied from somewhere else; doing nothing is the lesser surprise. The GUI does this
  already.
- **A paste into a locked keyboard** returns `reason: 'keyboard locked'` and reports; it is not an
  exception.

## Testing

**Unit:** the `copyText` encode/decode round-trip; `applyAction` throwing on `paste` (asserted on
the MESSAGE, not just that it threw — `actions.test.ts` records why: a bare `/paste/` would match
an accidental `TypeError`); the shared paste helper's reporting arms; `hidden` surviving the web
copy path.

**Integration:** `copy` leaving `REFUSED` and arriving in `SWALLOWED`, which is where the
two-branch rule is actually enforced.

**Real browser (`browser-clicks.mjs`):** a real drag-select then copy, asserting the gateway logged
`copy` and the page received `copyText` with the right text; and a real `paste` event asserting the
gateway logged `{kind:'paste'}`. Both mutation-proved — and note that a page-side probe alone is
half-vacuous here, as 2026-10-23 measured: a mutation renaming the IPC frame kind satisfied the
browser probe for five caps and was caught only by the gateway's own log.

**A LIVE RUN IS WANTED FOR THIS ONE, UNLIKE THE KEYBOARD.** Copy and paste touch the OS clipboard,
which no harness can read — the same shape as the save-picker gap, where a visible dialog was
briefly mistaken for evidence of the route. What needs a human: that text copied in the browser
appears in the operator's own clipboard, and that a multi-line paste lands in the right fields
without submitting the panel. **Chromium AND Firefox both**, because `writeText`'s secure-context
behaviour differs and this gateway is often served over plain `http`.
