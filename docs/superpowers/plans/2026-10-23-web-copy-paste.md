# Web copy and paste implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator in a browser can copy a screen rectangle to their own clipboard and paste
text into a field, with the same rules the Electron GUI uses.

**Architecture:** A new `paste` Action kind that `applyAction` throws on (so both front ends
intercept it and share one helper); a new `copyText` server message carrying extracted text back to
the browser; a `paste` event listener and a clipboard write in the web bridge. `ClientMessage` does
not change.

**Tech Stack:** TypeScript monorepo, vitest (`environment: 'node'`, no jsdom), a Node WebSocket
gateway, native ES modules served to the browser, Electron for the GUI half.

**Spec:** `docs/superpowers/specs/2026-10-23-web-copy-paste-design.md` — read it first; it records
two design corrections made during review and the reasons behind the `paste` kind.

---

## READ THIS BEFORE TASK 1 — FIVE TRAPS, EVERY ONE ALREADY PAID FOR IN THIS REPO

**0. THE TWO-BRANCH RULE IS NECESSARY BUT NOT SUFFICIENT -- AND THE CODE THIS PLAN GAVE FOR TASK 3
WAS ITSELF PROCESS-ENDING.** Found by the Task 3 implementer, 2026-10-23, and verified
independently: `extractText(cells, cols, undefined)` throws `TypeError: Cannot read properties of
undefined (reading top)`, and `pasteString` throws `text is not iterable`. My Task 3 snippet
called both DIRECTLY in the socket handler, outside any try -- so a malformed `copy` or `paste`
frame from any client ended the gateway for every connected operator. The honest renderer always
fills those fields; `integration.test.ts` builds raw frames and does not, which is how it
surfaced. **So a kind accepted at decode must also have its FIELDS shape-checked there** (the
`transferChunk`/`pf` precedent), or the interception is a guard against one failure mode while
leaving another wide open. Obeying the rule I spent two paragraphs on was not enough to satisfy it.

**1. THE TWO-BRANCH RULE IS THE WHOLE SHAPE OF THIS FEATURE, AND BREAKING IT ENDS THE GATEWAY FOR
EVERY CONNECTED OPERATOR.** `applyAction` THROWS on `copy`, and `web/src/main.ts:334` calls it
**outside any try inside a socket `data` handler**. So: accepting a kind at decode (`protocol.ts`)
OWES an interception in `main.ts` **in the same commit**. `toggleKeypad` once spent a commit
violating this. Task 3 does both halves together — do not split it.

**2. A NEW RUNTIME IMPORT IN `renderer.ts` MUST JOIN `BROWSER_MODULES`.** That file is SERVED to
the browser. Add the module to `BROWSER_MODULES` in `packages/canvas/src/assets.ts` AND bump the
count in `packages/web/test/httpstatic.test.ts`. Omitting it on 2026-10-23 made the module 404,
`renderer.js` never evaluated, and `browser-clicks.mjs` reported `1/8` **while blaming three
unrelated checks**. The guard exists (`imported but not served`) but lives in `packages/web` —

**3. SO RUN THE WHOLE SUITE: `npx vitest run` with no path.** A package-scoped run is exactly what
hid trap 2.

**4. ELECTRON HARNESS HYGIENE.** Between browser runs: `pkill -9 -f "node_modules/[e]lectron";
sleep 3`. **The bracket escape is required** — unescaped, the pattern matches the shell's own
command line and kills the compound command before the harness runs, which looks like a silent
failure. Leaked processes give bogus scores (72 leaks once gave `0/7` plus a misleading "bridge.js
did not load"). A stale `dist/` makes harnesses refuse with `dist is OLDER than src` — fix with
`npx tsc --build --force packages/canvas packages/gui packages/web`.

**5. NEVER NEST A PYTHON HEREDOC INSIDE A BASH HEREDOC.** It broke out and ran a harness
unintentionally on 2026-10-23. Write mutation scripts to a FILE and run `python3 -I /tmp/mut.py`.

**AND ONE RULE ABOUT EVIDENCE:** six vacuous assertions have been caught on this project, each of
which PASSED against the very defect it was written for. **Every new check in this plan has a
mutation step.** If a mutation leaves a check green, the check is decoration — say so rather than
shipping it.

---

## File Structure

- **`packages/frontend/src/keymap.ts`** — the `paste` Action kind. (Task 1)
- **`packages/frontend/src/actions.ts`** — `applyAction` throws on it. (Task 1)
- **`packages/frontend/src/pasteAction.ts`** (NEW) — the shared "apply a paste and say what
  happened" helper both front ends call. (Task 2)
- **`packages/gui/src/main.ts`** — its menu handler becomes a caller of that helper. (Task 2)
- **`packages/web/src/protocol.ts`** — `copyText` in `ServerMessage`; `copy` and `paste` accepted
  at decode. (Task 3)
- **`packages/web/src/main.ts`** — intercept `copy` (extract + send) and `paste` (apply + report).
  (Task 3)
- **`packages/web/src/bridgecore.ts`**, **`packages/web/src/bridge.ts`** — an optional
  `onCopyText` dep and the clipboard write. (Task 4)
- **`packages/canvas/src/renderer.ts`** — the `paste` listener. (Task 5)
- **`packages/web/scripts/browser-clicks.mjs`** — real-browser cover. (Task 6)
- **Docs.** (Task 7)

---

## Task 1: the `paste` Action kind, which `applyAction` refuses

**Files:**
- Modify: `packages/frontend/src/keymap.ts`
- Modify: `packages/frontend/src/actions.ts`
- Modify: `packages/frontend/test/actions.test.ts`

- [ ] **Step 1: Write the failing test**

In `packages/frontend/test/actions.test.ts`, find the case that asserts `applyAction` refuses
`copy` and add beside it:

```ts
  it('REFUSES paste, the clipboard being the front end s own too', () => {
    /*
      ASSERTED ON THE MESSAGE, not merely that it threw -- the neighbouring cases record why,
      MEASURED: a bare `/paste/` also matches an accidental `TypeError: ...paste is not a
      function`, so the loose pattern passes against a DIFFERENT defect from the one it names.
    */
    const { session } = newSession();
    expect(() => applyAction(session, { kind: 'paste', text: 'HELLO' }))
      .toThrow(/does not handle paste/);
  });
```

**`newSession()` IS THE IDIOM IN THAT FILE — verified 2026-10-23.** An earlier draft of this plan
wrote `defaultSession()`, which `actions.test.ts` does not import at all. Read the neighbouring
`toggleKeypad` / `toggleKeyboard` / `copy` cases and match them exactly; if `newSession` takes
arguments there, follow the repo and report.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/actions.test.ts 2>&1 | tail -15
```

Expected: a TypeScript/assertion failure because `'paste'` is not in the `Action` union. Record the
exact message.

- [ ] **Step 3: Add the union member**

In `packages/frontend/src/keymap.ts`, find:

```ts
  | { kind: 'copy'; rect: { top: number; left: number; bottom: number; right: number } }
  | { kind: 'type'; text: string }
  | { kind: 'quit' };
```

Insert between `type` and `quit`:

```ts
  /**
   * PASTE, 2026-10-23, AND IT IS DELIBERATELY NOT `type`.
   *
   * `type` is dispatched by `applyAction` to `Keyboard.typeString`, which is a bare loop over
   * `type(ch)`. Carrying a paste that way would send every `\n` as **Enter -- an AID that submits
   * a half-filled panel to a live host** -- and every `\f` as **Clear, which wipes the screen
   * mid-paste**. `paste.ts`'s `pasteString` exists because exactly those two cases were measured
   * from x3270's `Common/kybd.c` (`:3928`, `:3957`, `:3918`, `:3920`) and its header records that
   * both would have been guessed wrong. It also drops `\r` so CRLF text gains no stray character
   * per line, and returns `{typed, dropped, reason?}` -- none of which `typeString` has.
   *
   * SO THE TEXT IS THE SAME AND THE SEMANTICS ARE NOT, which is what earns a separate kind.
   */
  | { kind: 'paste'; text: string }
```

- [ ] **Step 4: Add the refusal**

In `packages/frontend/src/actions.ts`, find the `copy` guard:

```ts
  if (action.kind === 'copy') {
    throw new Error('applyAction does not handle copy: the front end owns its own clipboard');
  }
```

Add directly beneath it:

```ts
  /*
    THE SIXTH OF THE SAME SHAPE, 2026-10-23: a kind whose meaning depends on WHOSE MACHINE it
    lands on, so the front end owns it.

    IT COULD BE HANDLED HERE AND IS NOT, WHICH IS A POLICY CHOICE RATHER THAN A CONSTRAINT -- said
    plainly because the spec for this feature first claimed the opposite. `pasteString` needs a
    `Screen` as well as a `Keyboard`, and this function HAS both: `session` carries them. What rules
    it out is the pattern -- `quit`, `toggleKeypad`, `toggleKeyboard`, `transferForm` and `copy` all
    throw here for the same reason, and a front end that forgot the arm fails loudly rather than
    being silently inert.

    BOTH DOM FRONT ENDS THEN SHARE ONE HELPER (`pasteAction.ts`), so the GUI's rules stop being
    private to its menu handler and the browser is not a second copy of them.
  */
  if (action.kind === 'paste') {
    throw new Error('applyAction does not handle paste: the front end owns its own clipboard');
  }
```

- [ ] **Step 5: Watch it pass, then build**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/actions.test.ts 2>&1 | tail -5
npm run build 2>&1 | grep -iE "error TS" | head -5; echo "BUILD exit: $?"
npm run typecheck 2>&1 | grep -iE "error TS" | head -5; echo "TYPECHECK exit: $?"
```

Check EXIT CODES, not just the absence of grep matches.

- [ ] **Step 6: Find every exhaustive switch the new kind breaks**

A new union member can break exhaustiveness checks anywhere. The build above should catch them, but
also run the whole suite — some switches are only exercised at runtime:

```bash
cd ~/git/tn3270 && npx vitest run 2>&1 | tail -5
grep -rn "kind === 'type'" packages/*/src/*.ts | grep -v dist
```

**Report every file the new kind forced a change in.** If the TUI or CLI has a switch over `Action`
that now needs a `paste` arm, say so — and prefer a throw or an explicit "not supported here" over
a silent fallthrough.

- [ ] **Step 7: Commit**

```bash
cd ~/git/tn3270 && git add packages/frontend/src/keymap.ts packages/frontend/src/actions.ts \
  packages/frontend/test/actions.test.ts
git commit -m "feat(frontend): a paste Action kind, which applyAction refuses

NOT \`type\`, and the difference is a safety one. applyAction dispatches \`type\` to
Keyboard.typeString, a bare loop over type(ch) -- so a multi-line paste carried
that way would send every \\n as ENTER, submitting a half-filled panel to a live
host, and every \\f as CLEAR, wiping the screen mid-paste. pasteString exists
because those two cases were measured from x3270's kybd.c and its header says both
would have been guessed wrong.

The refusal is the sixth of its shape: a kind whose meaning depends on whose
machine it lands on. It COULD be handled here -- applyAction has the Session, so it
has the Screen -- and the spec first claimed otherwise; the real reason is the
pattern, and both front ends will share one helper instead.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: one shared paste helper, and the GUI becomes its first caller

**Files:**
- Create: `packages/frontend/src/pasteAction.ts`
- Create: `packages/frontend/test/pasteAction.test.ts`
- Modify: `packages/frontend/src/index.ts` (export it)
- Modify: `packages/gui/src/main.ts` (its menu handler calls it)

**WHY THIS TASK EXISTS.** The GUI's paste rules — which warning to show and when — are inline in
`main.ts`'s `onPaste` handler. If the gateway wrote its own, there would be two copies of wording
and threshold logic that must agree. One helper, two callers.

- [ ] **Step 1: Read the GUI's existing handler, which is the behaviour to preserve**

```bash
cd ~/git/tn3270 && sed -n '1030,1060p' packages/gui/src/main.ts
grep -n -A8 "interface PasteResult" packages/frontend/src/paste.ts
```

Note the two message strings and that a frame is sent UNCONDITIONALLY afterwards.

- [ ] **Step 2: Write the failing test**

Create `packages/frontend/test/pasteAction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { KeyboardState } from '@tn3270/core';
import { applyPaste } from '../src/pasteAction.js';

/**
 * The shared paste path, which both DOM front ends call.
 *
 * WHAT IS WORTH TESTING HERE IS THE REPORTING, not the typing: `paste.test.ts` already covers
 * `pasteString`'s x3270 semantics in detail. This file covers the decision ABOVE that -- which
 * warning an operator sees, and that a clean paste produces none.
 */
describe('applyPaste', () => {
  it('reports nothing when every character landed', () => {
    const { session } = newSession();
    const r = applyPaste(session, 'AB');
    expect(r.warning, 'a clean paste must not warn').toBeUndefined();
    expect(r.typed).toBe(2);
  });

  it('reports REMEDY-FIRST when the paste stopped early', () => {
    /*
      AN INHIBITED KEYBOARD IS THE REACHABLE `reason`, and this is how `paste.test.ts:134` reaches
      it -- NOT an invented `lock()` method. `pasteString` checks `keyboard.oia.isInhibited()`
      (`paste.ts:67`) and returns `reason: 'keyboard locked'` having typed nothing, which is what
      an operator meets by pasting while the host holds the keyboard.
    */
    const { session } = newSession();
    session.keyboard.oia.inhibit(KeyboardState.SystemWait);
    const r = applyPaste(session, 'ABC');
    expect(r.warning, 'a stopped paste must say so').toMatch(/^paste stopped: keyboard locked/);
    expect(r.warning).toContain('0 of 3 characters');
  });
});
```

**THESE APIs WERE VERIFIED AGAINST THE REPO 2026-10-23, AND AN EARLIER DRAFT OF THIS PLAN HAD BOTH
WRONG** — it wrote `defaultSession()` (which these tests do not import) and
`session.keyboard.lock()` (no such method anywhere). The real ones are `newSession()`, as
`actions.test.ts` uses, and `oia.inhibit(KeyboardState.SystemWait)`, as `paste.test.ts:134` uses.

**STILL CHECK THEM YOURSELF.** `newSession` is defined locally in `actions.test.ts` — copy its
definition or import it if it has been shared — and confirm `KeyboardState` is exported from
`@tn3270/core`. If `applyPaste` should take the keyboard and screen separately rather than a
`Session`, follow whatever typechecks and report the signature you used.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/pasteAction.test.ts 2>&1 | tail -12
```

Expected: cannot resolve `../src/pasteAction.js`.

- [ ] **Step 4: Write the helper**

Create `packages/frontend/src/pasteAction.ts`:

```ts
import type { Session } from '@tn3270/core';
import { pasteString } from './paste.js';

/** What a paste did, and the one-line warning an operator should see -- or none. */
export interface PasteOutcome {
  readonly typed: number;
  readonly dropped: number;
  /** Absent when every character landed. Present means SHOW THIS. */
  readonly warning?: string;
}

/**
 * Apply a paste to a session and say what the operator should be told.
 *
 * ## ONE COPY OF THE RULES, TWO FRONT ENDS
 *
 * The Electron GUI had this inline in its menu handler and the gateway would have needed the same
 * decisions -- which warning, at which threshold, in which words. Two copies of that is how they
 * diverge, and the wording matters more than it looks (see below).
 *
 * `applyAction` DELIBERATELY DOES NOT ROUTE HERE: `paste` is one of the six kinds whose meaning
 * depends on whose machine it lands on, so each front end intercepts the kind and calls this.
 *
 * ## THE WARNING IS REMEDY-FIRST, AND THAT IS A SHIPPED-DEFECT LESSON
 *
 * The GUI's status line TRUNCATES, and this project has already shipped a message whose only
 * actionable phrase fell past the cut. A silently half-applied paste is the worst outcome
 * available here: the operator cannot see how much of a dataset name arrived, and a SHORT ONE MAY
 * BE A VALID DIFFERENT NAME.
 *
 * ## IT DOES NOT REPAINT, AND THE CALLER MUST
 *
 * A paste is a LOCAL action and emits no `screen` event, so without a repaint the display shows
 * nothing until the host next speaks -- measured on the same path for `tab` in the gateway, where
 * it cost a 5-second test timeout. Both callers send a frame unconditionally afterwards, which is
 * ALSO what dismisses the warning: the web renderer's `onError` blanks the canvas to draw text and
 * `onFrame` clears that state, so the message shows and the next frame takes it away.
 */
export function applyPaste(session: Session, text: string): PasteOutcome {
  const r = pasteString(session.keyboard, session.screen, text);
  const total = r.typed + r.dropped;
  if (r.reason !== undefined) {
    return {
      typed: r.typed,
      dropped: r.dropped,
      warning: `paste stopped: ${r.reason} after ${r.typed} of ${total} characters`,
    };
  }
  if (r.dropped > 0) {
    return {
      typed: r.typed,
      dropped: r.dropped,
      warning: `paste short: ${r.typed} of ${total} characters (field full or protected)`,
    };
  }
  return { typed: r.typed, dropped: r.dropped };
}
```

- [ ] **Step 5: Export it**

Add to `packages/frontend/src/index.ts`, following that file's existing style:

```ts
export { applyPaste } from './pasteAction.js';
export type { PasteOutcome } from './pasteAction.js';
```

**Read the file first** — it may group exports with comments explaining each, in which case match
that convention.

- [ ] **Step 6: Watch it pass**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/pasteAction.test.ts 2>&1 | tail -5
npm run build 2>&1 | grep -iE "error TS" | head -3; echo "BUILD exit: $?"
```

- [ ] **Step 7: Make the GUI call it**

In `packages/gui/src/main.ts`'s `onPaste` handler, replace the inline `pasteString` call and its
two `if` branches with the helper. The existing code is:

```ts
          const r = pasteString(session.keyboard, session.screen, text);
```

...followed by an `if (r.reason !== undefined) { ... } else if (r.dropped > 0) { ... }` pair that
sends `error-message`. Replace that whole block with:

```ts
          // THE SHARED HELPER, 2026-10-23: the wording and the thresholds now live in
          // `frontend/src/pasteAction.ts` so the web gateway cannot drift from them.
          const r = applyPaste(session, text);
          if (r.warning !== undefined) win.webContents.send('error-message', r.warning);
```

Then fix the import: `pasteString` may no longer be used in this file — check, and replace it with
`applyPaste` in the `@tn3270/frontend` import list if so. **Leave the `send()` call that follows
in place**; its comment explains why it is unconditional.

- [ ] **Step 8: Verify the GUI's behaviour is unchanged**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -3
npx vitest run 2>&1 | tail -4
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | grep -viE "dbus|OOM|zygote|deprecated|GPU" | tail -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
```

Expected: `keys.mjs` still `20 chords, 18 actions`.

**NOTE WHAT IS NOT PROVEN HERE:** no harness drives a GUI paste — `docs/live-testing.md` records
the live GUI paste as unwitnessed. So this refactor's safety rests on the unit tests and on the
wording being moved verbatim. **Diff the two message strings character by character** and say in
your report that you did.

- [ ] **Step 9: Commit**

```bash
cd ~/git/tn3270 && git add packages/frontend/src/pasteAction.ts packages/frontend/src/index.ts \
  packages/frontend/test/pasteAction.test.ts packages/gui/src/main.ts
git commit -m "refactor(frontend): one shared paste path, with the GUI as its first caller

The GUI's paste rules -- which warning, at which threshold, in which words -- were
inline in its menu handler, and the gateway was about to need the same decisions.
Two copies of that is how they diverge, and the wording is load-bearing: the status
line TRUNCATES and this project has already shipped a message whose only actionable
phrase fell past the cut.

Message strings moved VERBATIM, diffed character by character, because no harness
drives a GUI paste -- live-testing.md records it as unwitnessed, so the unit tests
and that diff are the whole safety net.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: the gateway accepts both kinds and answers copy — ONE COMMIT

**Files:**
- Modify: `packages/web/src/protocol.ts`
- Modify: `packages/web/src/main.ts`
- Modify: `packages/web/test/integration.test.ts`
- Modify: `packages/web/test/protocol.test.ts`

**TASK 1 ALREADY ADDED A REJECTION FOR `paste`, SO THIS TASK REMOVES IT RATHER THAN ADDING ONE.**
Found during Task 1 (2026-10-23): the whole-suite run failed with `no reply to the paste action`
the moment the kind existed, because `protocol.ts`'s two-branch rule says a kind `applyAction`
throws on must grow EITHER a rejection there OR an interception in `main.ts` **in the same change
-- "WHAT IS NOT ALLOWED IS NEITHER."** Leaving it in that state for several commits is the mistake
the `transferForm` plan made, which that docblock warns about. So Task 1 took the cheap branch.
**This task therefore: deletes the `paste` rejection and its `protocol.test.ts` case, moves `paste`
from `REFUSED` to `SWALLOWED`, and adds the interception** -- exactly the path `transferForm` took.
`copy` still makes the full journey described below.

**THIS TASK MUST NOT BE SPLIT.** `protocol.ts` accepting a kind owes `main.ts` an interception in
the same commit. `applyAction` throws on both `copy` and `paste`, and `main.ts:334` calls it
outside any try inside a socket `data` handler — so an acceptance without an interception **ends
the gateway process and every connected operator's session** on the first copy. `toggleKeypad`
spent a commit violating this rule; `transferForm` is the worked example of obeying it.

- [ ] **Step 1: Read the rule and the precedent**

```bash
cd ~/git/tn3270 && sed -n '165,230p' packages/web/src/protocol.ts
grep -n "REFUSED\|SWALLOWED" packages/web/test/integration.test.ts | head -6
sed -n '305,335p' packages/web/src/main.ts
```

- [ ] **Step 2: Write the failing tests**

In `packages/web/test/protocol.test.ts`, add a round-trip case for the new message. Read a
neighbouring `encodeServerMessage` case and match it, then add:

```ts
  it('round-trips copyText, which carries the operator s own copied text', () => {
    // PLAIN JSON, no base64 branch: unlike `atlas`'s coverage and `transferData`'s bytes, this
    // payload is a string. A branch here would be a third convention for no reason.
    const buf = encodeServerMessage({ kind: 'copyText', text: 'HELLO  WORLD' });
    const back = JSON.parse(inflateSync(buf).toString('utf8')) as Record<string, unknown>;
    expect(back['kind']).toBe('copyText');
    expect(back['text']).toBe('HELLO  WORLD');
  });
```

**Match the file's own decode idiom** — read how a neighbouring test inflates and parses; it may
have a helper. In `packages/web/test/integration.test.ts`, move `'copy'` out of `REFUSED` and into
`SWALLOWED`, and add `'paste'` to `SWALLOWED`:

```ts
const REFUSED: readonly string[] = ['quit'];
```

...and in the `SWALLOWED` list (currently `['toggleKeypad', 'transferForm', 'toggleKeyboard']`) add
`'copy'` and `'paste'`.

- [ ] **Step 3: Run them and watch them fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/web 2>&1 | tail -15
```

Expected: the `copyText` case fails (the kind is not in `ServerMessage`), and the integration test
fails because `copy` is still refused at decode. Record both messages.

- [ ] **Step 4: Widen `ServerMessage`**

In `packages/web/src/protocol.ts`, find:

```ts
  // Transfer progress and completion. `ServerMessage` was `frame | error | session | atlas`
  // until now; web copy will be the next thing to widen it, as the handoff records.
```

Replace that second sentence's promise with the fact, and add the member. The union's new entry:

```ts
  /**
   * THE OPERATOR'S COPIED TEXT, TRAVELLING BACK TO THEIR OWN BROWSER -- 2026-10-23, and the thing
   * the comment above predicted.
   *
   * WHY A MESSAGE AT ALL, when `sendAction` already crosses the socket: the spec for the GUI's
   * copy/paste claimed the gateway got copy "free" for that reason, and implementing it disproved
   * the claim. Sending the ACTION is free; getting the TEXT BACK is not. A `DrawCell` carries a
   * CG-order atlas glyph and NO character, so the browser's renderer cannot extract anything --
   * only the gateway, which holds `resolve(snapshot)` where `text` and `hidden` both live.
   *
   * PLAIN JSON, no base64 branch in `encodeServerMessage`: this payload is a string, where
   * `atlas`'s coverage and `transferData`'s bytes are not.
   */
  | { kind: 'copyText'; text: string }
```

- [ ] **Step 5: Accept both kinds at decode**

In the same file, find the block that refuses `copy` (search for `does not handle copy` or the
`REFUSED` reasoning around line 174). Accept `copy` and `paste` there, replacing the "web copy is
the next roadmap item" sentence with what actually happened. **Read the surrounding code to see
exactly how a kind is accepted versus rejected** — do not guess the mechanism.

The comment must record:
- that `copy` has LEFT the refusal list and WHY the refusal existed (the text would have landed on
  the gateway's clipboard; socket-carried `copyText` is what removes that reason);
- that `quit` STAYS refused and why (it would stop the gateway);
- that both new kinds owe `main.ts` an interception, landing in the same commit.

- [ ] **Step 6: Intercept both in `main.ts`**

Add `extractText` to the `@tn3270/canvas` import (`resolve` is already imported from
`@tn3270/core`) and `applyPaste` to the `@tn3270/frontend` import. Then, directly above
`if (msg.action.kind === 'transferForm') return;`, add:

```ts
      /*
        COPY, 2026-10-23: EXTRACT HERE AND SEND THE TEXT BACK, because only this side can.

        A `DrawCell` carries a CG-order atlas glyph and no character, so the browser's renderer has
        nothing to extract -- it sends the RECTANGLE and this side resolves it. Exactly what
        `gui/src/main.ts` does, with the clipboard write happening in the OPERATOR'S browser
        instead of on this machine, which is the whole reason this kind was refused until now.

        `hidden` IS HONORED INSIDE `extractText`, and it is the one line in this feature whose
        failure mode is a LEAKED PASSWORD: `ResolvedCell.text` is still the real character in a
        non-display field. Mutation-verified in `canvas/test/selection.test.ts`.

        AN EMPTY RESULT SENDS NOTHING. Copying a blank region must not wipe whatever the operator
        had copied from somewhere else; doing nothing is the lesser surprise, and the GUI makes the
        same call.

        THE LENGTH IS LOGGED AND NEVER THE TEXT. The action log is gated behind `--log-actions`
        precisely because a `type` action carries typed characters; this line is UNGATED and runs
        against a live host, where a copied rectangle can contain anything on the screen.
      */
      if (msg.action.kind === 'copy') {
        const snapshot = session.screen.snapshot();
        const text = extractText(resolve(snapshot), snapshot.cols, msg.action.rect);
        if (text !== '') {
          conn.sendBinary(encodeServerMessage({ kind: 'copyText', text }));
        }
        process.stdout.write(`copy: ${text.length} chars\n`);
        return;
      }
      /*
        PASTE, 2026-10-23, THROUGH THE SHARED HELPER so this cannot drift from the GUI's wording.

        `applyAction` THROWS on this kind (`frontend/src/actions.ts`, the sixth guard of that
        shape) and this call is OUTSIDE ANY TRY in a socket 'data' handler, so without this return
        the first browser paste ends the gateway PROCESS and every other operator's session. This
        is the interception branch of `protocol.ts`'s two-branch rule; the decode acceptance is the
        other, and both are in this commit.

        THE WARNING GOES BACK AS AN `error` MESSAGE, which already exists -- and the REPAINT below
        is what dismisses it: the browser's `onError` blanks the canvas to draw text and `onFrame`
        clears that state, so the message shows and the next frame takes it away.

        THE REPAINT IS UNCONDITIONAL, like every other local action here: a paste emits no
        `screen` event, so without it the browser shows nothing until the host next speaks.
      */
      if (msg.action.kind === 'paste') {
        const outcome = applyPaste(session, msg.action.text);
        if (outcome.warning !== undefined) {
          conn.sendBinary(encodeServerMessage({ kind: 'error', message: outcome.warning }));
        }
        repaint?.();
        return;
      }
```

**VERIFY `conn`, `session` and `repaint` are the names in scope at that point** before relying on
them, and check whether an existing helper (e.g. a local `send`) is the idiomatic way to emit a
server message in this handler.

- [ ] **Step 7: Watch the tests pass, then run the whole suite**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -3; echo "BUILD exit: $?"
npm run typecheck 2>&1 | grep -iE "error TS" | head -3; echo "TYPECHECK exit: $?"
npx vitest run 2>&1 | tail -5
```

- [ ] **Step 8: MUTATION — prove the two-branch rule is actually enforced**

Delete ONLY the `copy` interception from `main.ts` (keeping the decode acceptance) and confirm the
integration test catches it:

```bash
cd ~/git/tn3270
cp packages/web/src/main.ts /tmp/webmain.bak
# Write the mutation to a FILE -- never a nested heredoc.
cat > /tmp/mut3.py <<'PYEOF'
import io, re
p = '/home/a/athor/git/tn3270/packages/web/src/main.ts'
s = io.open(p, encoding='utf-8').read()
m = re.search(r"\n      if \(msg\.action\.kind === 'copy'\) \{.*?\n      \}\n", s, re.S)
assert m, 'copy interception not found -- read the file and adapt'
io.open(p, 'w', encoding='utf-8').write(s[:m.start()] + '\n' + s[m.end():])
PYEOF
python3 -I /tmp/mut3.py && npm run build >/dev/null 2>&1
npx vitest run packages/web/test/integration.test.ts 2>&1 | tail -8
cp /tmp/webmain.bak packages/web/src/main.ts && npm run build >/dev/null 2>&1
rm -f /tmp/webmain.bak /tmp/mut3.py
echo "restored"; git diff --stat packages/web/src/main.ts
```

Expected: the integration test FAILS with an uncaught `applyAction does not handle copy` (or a
"no reply after copy" shape — `transferForm`'s own note records that the string names the TAB sent
afterwards to prove the session survived). **If it passes, the two-branch rule is NOT enforced for
this kind — stop and report**, because that is the condition that ends the gateway in production.

Repeat for `paste`.

- [ ] **Step 9: Commit (both halves together)**

```bash
cd ~/git/tn3270 && git add packages/web/src/protocol.ts packages/web/src/main.ts \
  packages/web/test/integration.test.ts packages/web/test/protocol.test.ts
git commit -m "feat(web): the gateway accepts copy and paste, and answers copy with the text

BOTH BRANCHES OF THE TWO-BRANCH RULE IN ONE COMMIT, which is what the rule demands:
protocol.ts accepting a kind owes main.ts an interception, because applyAction
throws on both of these and main.ts calls it outside any try in a socket data
handler -- so an acceptance alone ends the gateway process and every connected
operator's session on the first copy. Mutation-proved by deleting each
interception and watching integration.test.ts fail.

copy LEAVES the REFUSED list and joins SWALLOWED. Its refusal existed because the
extracted text would have landed on the GATEWAY's clipboard; copyText travelling
back to the operator's own browser is what removes that reason. quit stays refused.

hidden is honored inside extractText, which is the one line here whose failure mode
is a leaked password.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: the bridge writes the clipboard

**Files:**
- Modify: `packages/web/src/bridgecore.ts`
- Modify: `packages/web/src/bridge.ts`
- Modify: `packages/web/test/bridgecore.test.ts`

- [ ] **Step 1: Write the failing test**

Read `packages/web/test/bridgecore.test.ts` and find how an inbound message is fed to a bridge
built with fake deps (the `onTransfer` cases are the model). Add a case asserting that a
`copyText` message reaches `deps.onCopyText` with the text, and that a bridge built WITHOUT that
dep does not throw on one.

**Write it in that file's own idiom** — read two neighbouring cases first. Both halves matter: the
optionality is a contract (`toggleKeypad`, `toggleKeyboard` and `onTransfer` all have it) because
the gateway's own tests and any caller with no DOM must be able to construct a bridge.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/web/test/bridgecore.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Add the dep**

In `packages/web/src/bridgecore.ts`'s `BridgeDeps`, beside `onTransfer`:

```ts
  /**
   * The operator's copied text, for THEIR clipboard. 2026-10-23.
   *
   * OPTIONAL, the same contract `toggleKeypad`, `toggleKeyboard` and `onTransfer` have and for the
   * same reason: the gateway's own tests and any caller with no DOM must be able to construct a
   * bridge without one.
   *
   * `BridgeApi`'s FOUR FUNCTIONS ARE UNTOUCHED BY THIS. That rule is about the surface
   * `renderer.ts` consumes unmodified; this is a `BridgeDeps` member, which is the distinction
   * `toggleKeypad` and `onTransfer` already rely on.
   */
  readonly onCopyText?: (text: string) => void;
```

- [ ] **Step 4: Dispatch the kind**

In the `socket.onmessage` chain, beside the `error` line:

```ts
      if (msg.kind === 'copyText') { deps.onCopyText?.(String(msg['text'])); return; }
```

**NOT through `dispatch`**, and the reason is the one `onTransfer` gives in its own comment: that
queue exists for handlers `renderer.js` registers in its module body, and this is not one of them.
Read `onTransfer`'s note and follow it.

- [ ] **Step 5: Write the clipboard in `bridge.ts`**

```ts
  /**
   * THE OPERATOR'S OWN CLIPBOARD, which is the entire point of routing the text back here.
   *
   * `navigator.clipboard.writeText` IS SECURE-CONTEXT-ONLY, and this gateway often has no secure
   * context: a LAN deployment on plain `http` fails the check, which the transfer feature already
   * records for `showSaveFilePicker` ("`undefined` is the COMMON case for this gateway, not an
   * edge one"). So the absence is EXPECTED and must not look like a bug.
   *
   * CAUGHT, NOT VOIDED. `void` on a rejecting promise is what CREATES an unhandled rejection --
   * measured on this project's transfer window. A clipboard the browser refuses is reportable and
   * recoverable, never fatal.
   */
  onCopyText: (text) => {
    const clip = navigator.clipboard;
    if (clip === undefined) {
      console.warn('copy: this browser has no clipboard API (needs a secure context)');
      return;
    }
    clip.writeText(text).catch((err: unknown) => {
      console.warn(`copy: the browser refused the clipboard: ${String(err)}`);
    });
  },
```

**MEASURE THE FALLBACK QUESTION RATHER THAN INVENTING ONE.** The spec says to decide this in a real
browser. In the Xvfb harness, report what `navigator.clipboard` actually is over `http://127.0.0.1`
— localhost is a secure context in Chromium even on plain http, so it may well be present there and
absent on a LAN address. **State what you measured**; do not add an `execCommand` fallback on
speculation.

- [ ] **Step 6: Build, whole suite, commit**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | grep -iE "error TS" | head -3; echo "BUILD exit: $?"
npx vitest run 2>&1 | tail -4
git add packages/web/src/bridgecore.ts packages/web/src/bridge.ts packages/web/test/bridgecore.test.ts
git commit -m "feat(web): the bridge writes copied text to the operator's clipboard

An optional onCopyText dep -- the same contract toggleKeypad, toggleKeyboard and
onTransfer have, because the gateway's own tests and any caller with no DOM must
be able to construct a bridge without one. BridgeApi's four functions are
untouched; this is a BridgeDeps member.

writeText is SECURE-CONTEXT-ONLY and this gateway often has none: a LAN deployment
on plain http fails the check, which the transfer feature already records for
showSaveFilePicker. So its absence is expected and reported rather than thrown.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: the browser's `paste` listener

**Files:**
- Modify: `packages/canvas/src/renderer.ts`
- Possibly modify: `packages/canvas/src/assets.ts` + `packages/web/test/httpstatic.test.ts`
  (see trap 2)

- [ ] **Step 1: Read the `keydown` listener this sits beside**

```bash
cd ~/git/tn3270 && sed -n '266,300p' packages/canvas/src/renderer.ts
grep -n "isEditableTarget" packages/canvas/src/renderer.ts packages/canvas/src/forwardKeys.ts
```

`isEditableTarget` is already imported in `renderer.ts` — confirm that, because it means this task
may need NO new import and therefore no `BROWSER_MODULES` change.

- [ ] **Step 2: Add the listener**

After the `keydown` listener, add:

```ts
/**
 * A PASTE, from the browser's own `Ctrl-V`. 2026-10-23.
 *
 * ## WHY AN EVENT AND NOT A CHORD OR A BUTTON
 *
 * `navigator.clipboard.readText()` would need a permission prompt in Chromium and does not exist
 * in Firefox. The `paste` event hands over the text with NO prompt in every browser, and the
 * native `Ctrl-V` is already the gesture an operator reaches for -- so this adds no chord to
 * `keys.ts` and needs no menu bar, which a browser tab does not have.
 *
 * ## IT MUST SKIP FORM CONTROLS, AND THAT IS MEASURED RATHER THAN CAUTIOUS
 *
 * This listener is on `window`, and the transfer form has real text inputs. The 2026-10-07 bug in
 * the other direction is recorded on the `keydown` listener above: typing into that form sent
 * every character TO THE MAINFRAME and left the field empty. A paste into the `Local file` field
 * would do exactly the same, so `isEditableTarget` guards both.
 *
 * ## IT SENDS `paste`, NOT `type`
 *
 * `keymap.ts` records the whole reason: `type` reaches `Keyboard.typeString`, which would send
 * every `\n` and `\f` into the field AS A CHARACTER (EBCDIC 0x25 and 0x0c, MDT set), so the next
 * AID carries the corruption to the host as field data. `pasteString`'s x3270 semantics are what
 * the `paste` kind buys.
 *
 * (An earlier draft of this plan said `\n` became ENTER and submitted the panel. That is x3270's
 * `kybd.c`, not this codebase -- `core/src/keyboard.ts` has no AID path at all. Corruption, not
 * submission.)
 */
window.addEventListener('paste', (e) => {
  const target = e.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (isEditableTarget(target)) return;
  const text = e.clipboardData?.getData('text/plain') ?? '';
  if (text === '') return;
  // `preventDefault` ONLY once we have claimed it, matching the `keydown` listener's rule: a paste
  // we are not handling must keep its default behaviour.
  e.preventDefault();
  clearSelection();
  window.tn3270.sendAction({ kind: 'paste', text });
});
```

**VERIFY:** that `clearSelection` is in scope and that calling it is right here — the `keydown`
listener's comment explains why a screen-changing action invalidates the selection. If the
reasoning does not apply, leave it out and say why.

- [ ] **Step 3: Check `BROWSER_MODULES`**

```bash
cd ~/git/tn3270 && npm run build >/dev/null 2>&1
grep -oE "from '[^']*'" packages/canvas/dist/renderer.js | sort -u
npx vitest run packages/web/test/httpstatic.test.ts 2>&1 | tail -4
```

If `renderer.js`'s import list is unchanged, nothing to do. **If it gained a specifier**, add the
module to `BROWSER_MODULES` in `packages/canvas/src/assets.ts` and bump the count in
`httpstatic.test.ts` — see trap 2.

- [ ] **Step 4: Whole suite and the web harnesses**

```bash
cd ~/git/tn3270 && npx vitest run 2>&1 | tail -4
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -4
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
```

`browser-clicks` must still be 9 buttons + 11/11, and `browser-shot` 1/1. **A golden diff means
something leaked into the base page — report it and STOP.**

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/canvas/src/renderer.ts
git commit -m "feat(canvas): a paste listener, so the browser's Ctrl-V reaches the session

The paste EVENT rather than navigator.clipboard.readText (a permission prompt in
Chromium, absent in Firefox) or a new chord: the event hands over the text with no
prompt in every browser, and Ctrl-V is already the gesture.

It skips form controls via the predicate the keydown listener shares, because the
transfer form has text inputs and this listener is on window -- the 2026-10-07 bug
in the other direction sent every character typed into that form TO THE MAINFRAME.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 6: real-browser cover

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs`

**WHAT TO FOLLOW.** That file's phase two has `clickCenter`, a socket probe
(`window.__tn3270Probe.sent`), the gateway's own `--log-actions` output in `serverOut`, and a check
table whose entries carry `name`/`kind`/`what`/`mutant`. The keyboard phase added on 2026-10-23 is
the model: it asserts each cap on TWO independent witnesses, because a mutation renaming the IPC
frame kind satisfied the page-side probe alone.

- [ ] **Step 1: Read the keyboard phase's two-witness pattern**

```bash
cd ~/git/tn3270 && grep -n "keyboardCaps" packages/web/scripts/browser-clicks.mjs | head -4
sed -n "$(grep -n 'const sentJson' packages/web/scripts/browser-clicks.mjs | cut -d: -f1),+40p" packages/web/scripts/browser-clicks.mjs
grep -n "__tn3270CellCenter" packages/canvas/src/renderer.ts
```

`__tn3270CellCenter(row, col)` is the existing seam `select.mjs` uses to drive a real drag by CELL
rather than by pixel — that is how to make a selection here without a second copy of the geometry.

- [ ] **Step 2: Add two check-table entries**

```js
  {
    name: 'webCopy',
    kind: 'live',
    what: 'a real drag-select then copy puts the screen text in the page clipboard path',
    mutant: "main.ts  drop the copy interception (gateway refuses) OR bridge.ts  onCopyText: () => {}",
  },
  {
    name: 'webPaste',
    kind: 'live',
    what: 'a real paste event reaches the gateway as {kind:paste} and types into the screen',
    mutant: "renderer.ts  delete the paste listener",
  },
```

- [ ] **Step 3: Add the two checks**

For **copy**: drag-select a region with `__tn3270CellCenter` and `Input.dispatchMouseEvent`, fire
the copy (the page's `__tn3270Copy()`), then assert BOTH:
- the GATEWAY logged `{"kind":"copy"...}` and printed its `copy: N chars` line;
- the PAGE received a `copyText` message with text matching what is on that part of the screen.

**Instrument `onCopyText` rather than reading the real clipboard** — `navigator.clipboard` cannot
be read back in a headless Xvfb Chromium without a permission grant, and asserting on a value the
harness itself injected would be vacuous. Record in the comment that the OS clipboard is NOT
asserted here and that a live human pass covers it.

For **paste**: dispatch a real paste. CDP's `Input.insertText` does not fire a `paste` event, so
use `Input.dispatchKeyEvent` for Ctrl+V **or** synthesise a `ClipboardEvent` in the page — try the
real chord first and report which worked. Then assert the gateway logged `{"kind":"paste","text":...}`.

**If driving a real paste event in headless Chromium proves impossible, say so plainly and assert
what you CAN** (for example that the listener exists and that a synthesised `ClipboardEvent` with
`clipboardData` reaches the gateway) — labelling the check honestly, `injected` rather than `live`,
as the `progress` check does.

- [ ] **Step 4: Run it**

```bash
cd ~/git/tn3270 && pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -10
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
```

Expected: 13/13. Report the actual output.

- [ ] **Step 5: MUTATION — one per check, each reverted**

Write each to a file; run with `python3 -I`. Expect `webCopy` to fail when the copy interception is
dropped, and `webPaste` to fail when the `paste` listener is deleted. **Also mutate
`extractText`'s `hidden` handling** (`cell.hidden ? ' ' : cell.text` → `cell.text`) and report
whether anything catches it — `canvas/test/selection.test.ts` should, and if the web path has its
own cover that is better still. That is the leaked-password line.

- [ ] **Step 6: Commit**

```bash
cd ~/git/tn3270 && git add packages/web/scripts/browser-clicks.mjs
git commit -m "test(web): real-browser cover for copy and paste

Two checks, on the keyboard phase's two-witness pattern: the gateway's own log AND
the page's receipt, because a mutation renaming the IPC frame kind once satisfied
the page-side probe alone.

The OS CLIPBOARD IS NOT ASSERTED and the comment says so: navigator.clipboard
cannot be read back in headless Xvfb without a permission grant, and asserting on
a value the harness injected would be vacuous. A live human pass covers it.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 7: the gate and the docs

**Files:**
- Modify: `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md`

- [ ] **Step 1: The full gate, serially**

```bash
cd ~/git/tn3270
npm run build; echo "BUILD exit: $?"
npm run typecheck; echo "TYPECHECK exit: $?"
npx vitest run 2>&1 | tail -5
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | tail -2;     pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2;   pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -2;   pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/gui/scripts/shot.mjs 2>&1 | tail -2;     pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2; pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2;   pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -4; pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2;   pkill -9 -f "node_modules/[e]lectron"; sleep 3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
```

Baseline: build/typecheck 0; **2577 tests in 109 files** before this plan (expect more);
`keys` 20/18; `clicks` 9/10; `select` 3/3; `shot` 2/2; `transfer` 10/10; `browser-keys` 13/10;
`browser-clicks` 9 + 11/11 before this plan (expect 13/13); `browser-shot` 1/1; `pty-smoke` 12/0.

**`select.mjs` MATTERS UNUSUALLY HERE** — it drives the drag selection this feature's copy depends
on, and `renderer.ts` changed. A golden diff in either `shot` harness means something leaked into
the base page: report it and STOP.

- [ ] **Step 2: `README.md`**

Document the browser's copy and paste beside the GUI's. Include: the gesture (drag to select, then
the Copy route; `Ctrl-V` to paste), that `hidden` fields copy as spaces, and that **copy needs a
secure context** so a LAN gateway on plain `http` may have no clipboard. Update the
`browser-clicks` verification row for the new count and checks. Also check whether the
`What is not implemented` list still claims web copy/paste is missing, and fix it if so.

- [ ] **Step 3: `docs/live-testing.md` — AND SAY WHAT NEEDS A HUMAN**

Add an entry stating what is proven offline and, explicitly, **that the OS clipboard is not
machine-checkable**. The live pass the user has agreed to do needs naming precisely:

- text copied in the browser appears in the operator's own clipboard;
- a multi-line paste lands in the right fields **without submitting the panel** — the specific
  hazard the `paste` kind exists to avoid;
- **Chromium AND Firefox both**, because `writeText`'s secure-context behaviour differs;
- and whether a plain-`http` LAN address has a clipboard at all.

Record the save-picker lesson by name: **a visible dialog does not identify the route**, and the
same trap applies to a clipboard that appears to work.

- [ ] **Step 4: `docs/HANDOFF.md`**

Update START HERE: roadmap item **(0e) is done**, so the web gateway has reached feature parity
with the GUI — which was the user's stated prerequisite for packaging. Note that `copy` has left
`protocol.ts`'s `REFUSED` list and that `quit` is now its only member. Check and fix any count or
status claim this invalidates.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add README.md docs/live-testing.md docs/HANDOFF.md
git commit -m "docs: web copy and paste, and the live pass it still needs

Roadmap item (0e) is done, so the web gateway has feature parity with the GUI --
the user's stated prerequisite for packaging. copy has left protocol.ts's REFUSED
list, leaving quit as its only member.

live-testing.md names what no harness can check: that copied text reaches the
OPERATOR's clipboard, and that a multi-line paste does not submit the panel. In
Chromium AND Firefox, because writeText is secure-context-only and this gateway is
often plain http. And it records the save-picker lesson by name -- a visible dialog
does not identify the route.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `Action` gains `{kind:'paste', text}`; `applyAction` throws on it | 1 |
| The throw is a POLICY choice, recorded as such | 1 Step 4 (comment) |
| `ClientMessage` unchanged | no task touches it |
| One shared paste path; GUI's inline rules move into it | 2 |
| GUI wording preserved verbatim (`paste stopped:` / `paste short:`) | 2 Steps 4, 8 |
| `ServerMessage` gains `{kind:'copyText', text}` | 3 Step 4 |
| `copy` extracted gateway-side with `extractText(resolve(...))` | 3 Step 6 |
| `hidden` honoured, and asserted on the web path | 3 Step 6; 6 Step 5 |
| `copy` moves `REFUSED` → `SWALLOWED`, same commit as the interception | 3 Steps 2, 5, 6 |
| Two-branch rule mutation-proved | 3 Step 8 |
| Optional `onCopyText` dep; `BridgeApi`'s four untouched | 4 |
| `writeText` secure-context handling, MEASURED not invented | 4 Step 5 |
| An empty copy touches nothing | 3 Step 6 |
| A refused clipboard reports and does not throw | 4 Step 5 |
| `paste` listener on the event, skipping form controls | 5 |
| No `navigator.clipboard.readText` anywhere | 5 Step 2 |
| `BROWSER_MODULES` if `renderer.ts` gains an import | 5 Step 3 |
| Real-browser cover, two witnesses, mutation-proved | 6 |
| Live pass named precisely, incl. both browsers | 7 Step 3 |

**Type consistency:** `PasteOutcome` (`typed`, `dropped`, `warning?`) is defined in Task 2 Step 4
and consumed with those names in Task 2 Step 7 and Task 3 Step 6. `applyPaste(session, text)` has
one signature throughout. `onCopyText` is the dep name in Tasks 4 and 6. `copyText` is the message
kind in Tasks 3, 4 and 6.

**One risk named rather than hidden:** Task 6's paste check may not be drivable as a `live` event
in headless Chromium — CDP has no "fire a paste event" command, and `Input.insertText` does not
produce one. The task says to try the real chord, fall back to a synthesised `ClipboardEvent`, and
**label the check honestly** if it ends up injected. An `injected` label is not a failure; a `live`
label on injected evidence is.
