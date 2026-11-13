# Exist Per Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A send's `Exist` offers only Replace/Append (default Replace); a receive keeps
Keep/Replace/Append; the browser hides `Exist` on a receive.

**Architecture:**
- The shared form model (`frontend/src/transferForm.ts`) makes `valuesFor('exist')` and the
  default depend on the direction, and normalises on a direction change.
- The browser-only option in `canvas/src/transferUi.ts` also hides `exist` on a receive.

**Spec:** `docs/superpowers/specs/2026-11-13-exist-per-direction-design.md`.
**Branch:** `exist-per-direction`, from `origin/main` `4a940fe`.

**THE SOURCE BEATS THIS PLAN.** Re-read each file before editing; where the repo disagrees, follow
it and record the difference in the commit message. Run each shell step as one command with a
timeout. vitest does NOT typecheck: always run `npm run typecheck`. Commit trailer, after a blank
line:

```
Generated with AI

Co-Authored-By: SLAC AI
```

## Facts (read 2026-11-13)

- **`transferForm.ts`:**
  - `TRANSFER_FIELDS` has `exist` with values `['keep','replace','append']` (:63).
  - `newTransferForm()` defaults `direction: 'send'` and `exist: 'keep'` (:171-175).
  - `valuesFor(id, values)` (:188) is the one place where offered values depend on state; it
    already filters VM's `Recfm=undefined`.
  - `cycleField` (:202) and the "clear anything the move made inapplicable" step are where a
    direction change happens. Read how `recfm` is normalised when `host` changes to vm, and do
    the same for `exist`.
- **`transferUi.ts`'s `offered()`** gets its values by cycling the model, so a `valuesFor` change
  reaches every renderer automatically.
- **The browser option** is `deriveLocalFileOnReceive` (canvas `transferUi.ts`, commit 8e1988f).
- **The keyword parser** (`transfer.ts:522`) defaults `Exist` to `keep` and accepts all three for
  both directions. It is NOT changed.
- **Pinned import lists:** `defaultLocalName` lives in `transferForm.ts` because browser import
  maps name only that file. Don't add browser-loaded modules.

### Task 1: the form model

**Files:** `packages/frontend/src/transferForm.ts`, `packages/frontend/test/transferForm.test.ts`.

- [ ] **Step 1: Failing tests:**
  - `newTransferForm().values.exist === 'replace'`, since the form opens on a send;
  - cycling `exist` on a send visits exactly `replace`, `append`;
  - on a receive it visits `keep`, `replace`, `append`;
  - from a send with `replace`, switching to receive keeps `replace`;
  - from a receive with `keep`, switching to send gives `replace`;
  - from a receive with `append`, switching to send keeps `append`;
  - `formKeywords` of any reachable send state never contains `Exist=keep`. Drive it through
    `cycleField` and `setFieldText`; don't construct state by hand.
- [ ] **Step 2: fail. Step 3: implement** in `valuesFor` (send: filter out `keep`), plus the
  direction-change normalisation where the model already clears inapplicable values, plus the
  new-form default. Keep `TRANSFER_FIELDS`' value order. If the existing TUI or GUI form tests
  pinned `exist: 'keep'` as a send default, update them and list which.
- [ ] **Step 4:** run `npx vitest run packages/frontend packages/canvas packages/tui packages/gui`,
  then `npm run typecheck`.
- [ ] **Step 5: Mutation:** remove the send filter; remove the normalisation. Each must fail a test.
- [ ] **Step 6: Commit:** `frontend: a send's Exist offers Replace or Append; Keep never did anything on a send`.

### Task 2: the browser hides `Exist` on a receive

**Files:** `packages/canvas/src/transferUi.ts`, `packages/canvas/test/transferUi.test.ts`, and the
web harness `packages/web/scripts/browser-clicks.mjs`.

- [ ] **Step 1: Failing tests:** with the browser option on, a receive's view has no `exist`, and
  a send's has it with options exactly `['replace','append']`. With the option off (GUI and TUI),
  a receive's view has `exist` with all three.
- [ ] **Step 2: fail. Step 3: implement.** Hide `exist` alongside `localFile` under the option.
  If the name `deriveLocalFileOnReceive` now misdescribes the option, rename it (e.g.
  `browserReceive`) in its two call sites and the tests, and say so; otherwise keep it and fix its
  doc comment.
- [ ] **Step 4:** `npm run typecheck`, then `npm test`.
- [ ] **Step 5: Harness:**
  - `browser-clicks.mjs` asserts that `#transfer-exist`, or however the field's control is
    identified (read it), is absent on a receive and offers Replace/Append on a send;
  - run it (build first) and require all checks to pass;
  - run `packages/gui/scripts/transfer.mjs` under Xvfb, and the TUI pty smoke
    (`python3 packages/tui/scripts/pty-smoke.py`);
  - fix any harness that assumed the old values.
- [ ] **Step 6: Mutation:** don't hide `exist` under the option; the unit test AND the harness must
  fail. Revert and rebuild.
- [ ] **Step 7: Commit:** `canvas/web: the browser hides Exist on a receive`.

### Task 3: docs and gate

- [ ] README.md's transfer text (the GUI/TUI form and *Using the web gateway*) and
  `packages/web/README.md`: `Exist` on a send is Replace (the default) or Append; on a receive it
  is Keep/Replace/Append in the GUI and TUI, and absent in the browser, whose download handling
  decides. Check other docs that claim `keep` is the form default for a send.
- [ ] A changelog fragment (`~/.local/bin/uvx scriv==1.8.1 create`), under *Bug fixes*, with the
  spec's text. Delete the empty sections.
- [ ] Gate: `npm run build`, `npm run typecheck`, `npm test`.
- [ ] Commit: `docs: what Exist means per direction`.
