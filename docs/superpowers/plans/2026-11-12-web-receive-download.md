# Web Receive Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the browser, a receive has no Local file field, no Browse and no Save; Start fetches
the file and, on success, the browser downloads it under a name derived from the host file. The
GUI's receive dialog suggests the same name.

**Architecture:**
- A pure `defaultLocalName(hostFile, host)` in `packages/frontend`.
- The shared form controller (`canvas/src/transferUi.ts`) gains one option,
  `deriveLocalFileOnReceive`. With it on, the view omits `localFile` for a receive and the
  submitted keywords carry the derived name. The browser turns it on and the GUI doesn't.
- `browse` also receives a suggested name, which the GUI passes to its save dialog as
  `defaultPath`.
- The web bridge loses the Save button and the `showSaveFilePicker` route. A successful receive
  calls the `<a download>` sink once.

**Tech Stack:** TypeScript, vitest, Electron (GUI), plain browser ES modules (web).

**Spec:** `docs/superpowers/specs/2026-11-12-web-receive-download-design.md`.
**Branch:** `web-receive-download`, from `origin/main` `ae8724f`.

**THE SOURCE BEATS THIS PLAN.** The code here is a draft: re-read each file a task touches, and
follow the repository where they disagree, recording the difference in the commit message. Run
each shell step as one command with a timeout. vitest does NOT typecheck, so always run
`npm run typecheck`. Commit messages end, after a blank line, with:

```
Generated with AI

Co-Authored-By: SLAC AI
```

## Facts (read 2026-11-12, `ae8724f`)

- **`frontend/src/transferForm.ts`:**
  - `TRANSFER_FIELDS` has `localFile` (:60) and `hostFile` (:61).
  - `applicable(id, values)` (:240) is the shared rule for which fields show; both front ends use
    it, so do NOT change it for this.
  - `formKeywords(state)` (:305) maps `localFile` to `LocalFile`.
- **`canvas/src/transferUi.ts`:**
  - `UiDeps.browse(direction)` (:198) and `UiDeps.submit(keywords)` (:200).
  - `view()` filters fields by `applicable`.
  - `browseLocal()` (:307) calls `deps.browse(state.values.direction)`.
  - `start()` submits `formKeywords(state)` (:416).
  - `finished(result)` (:450) sets `done: N bytes` and never redraws.
- **`web/src/transferBoot.ts`:**
  - `saveName` is fixed at submit from `localNameFrom(keywords)` (:436), so a derived `LocalFile`
    in the keywords names the download automatically.
  - The Save button handler (:486-494) has the inverted `saveButton.disabled = bridge.hasUnsaved()`.
  - The completion handler (~:600-612) enables Save and appends "press Save to keep it".
  - `browse` returns `undefined` for a receive (:393).
  - The picker is feature-detected at :124-131 and passed as `savePicker` (:137).
- **`web/src/transferBridge.ts`:** `save(name)` (:297) uses `deps.savePicker`, else
  `deps.saveFallback`. Its restore-on-failure logic exists for the picker's async path.
  `hasUnsaved()` is `complete !== undefined`.
- **`web/src/transferOverlay.ts`:** a close with `hasUnsaved()` asks `confirmDiscard`.
- **`gui/src/main.ts` ~:1166:** `saveDialog: async () => showSaveDialog(tw, { title })`, with no
  `defaultPath`. Find the IPC chain from the GUI's `transferBoot.ts` `browse(direction)` to it.
- **Existing tests:** `web/test/transferBridge.test.ts`, `web/test/transferOverlay.test.ts`,
  `canvas/test/transferUi.test.ts`, `canvas/test/transferUiModule.test.ts`,
  `frontend/test/transferForm.test.ts`, and the `gui/test/transfer*.test.ts` files. The web HTML
  is `packages/web/index.html` (or wherever `transfer-save` is declared; grep for it).
- **The real-browser harness** is `packages/web/scripts/browser-clicks.mjs`, run by hand.

## Spec deviation, recorded

The spec says "`savePicker` is not called even when provided". With the Save button gone,
`savePicker` has no caller, so this plan REMOVES the picker route from the bridge and from
`transferBoot`. That removes the dep, its feature detection and its tests. The test becomes
"there is no picker: `TransferBridgeDeps` has no `savePicker`, and the browser download is the
only route". Note this in the Task 4 commit.

## File structure

| File | Change |
|---|---|
| `packages/frontend/src/transferName.ts` (new) | `defaultLocalName` |
| `packages/frontend/src/index.ts` | export it |
| `packages/frontend/test/transferName.test.ts` (new) | table tests |
| `packages/canvas/src/transferUi.ts` | `deriveLocalFileOnReceive` option; `browse` gains a suggested name |
| `packages/canvas/test/transferUi.test.ts` | option and suggestion tests |
| `packages/gui/src/transferBoot.ts`, `gui/src/*Preload.cts`, `gui/src/main.ts` | pass the suggestion to `showSaveDialog` `defaultPath` |
| `packages/gui/test/...` | the dialog gets `defaultPath` |
| `packages/web/src/transferBridge.ts` | remove `savePicker`; `save` becomes a synchronous download |
| `packages/web/src/transferBoot.ts` | option on; no Save button; download on success; status text |
| `packages/web/index.html` (wherever `transfer-save` lives) | drop the Save button |
| `packages/web/test/transferBridge.test.ts`, `transferOverlay.test.ts` | updated |
| `packages/web/scripts/browser-clicks.mjs` | receive produces one download with the right name and bytes |
| README.md, `packages/web/README.md`, `changelog.d/` | docs |

---

### Task 1: `defaultLocalName`

**Files:** create `packages/frontend/src/transferName.ts` and
`packages/frontend/test/transferName.test.ts`; modify `packages/frontend/src/index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { defaultLocalName } from '../src/transferName.js';

describe('defaultLocalName', () => {
  it.each([
    ['vm', 'NAP H A2', 'nap.h'],
    ['vm', 'PROFILE EXEC', 'profile.exec'],
    ['vm', 'NAP', 'nap'],
    ['vm', '  nap   h   a2  ', 'nap.h'],
    ['vm', 'Nap H', 'nap.h'],
    ['tso', "'SYS1.PROCLIB(ASMHC)'", 'sys1.proclib(asmhc)'],
    ['tso', "'HERC01.NAP.H'", 'herc01.nap.h'],
    ['tso', 'NAP.H', 'nap.h'],
    ['tso', "'HERC01.LOG(0)'", 'herc01.log(0)'],
    ['tso', "'NAP.H", "'nap.h"],
    ['tso', "  'HERC01.X'  ", 'herc01.x'],
    ['vm', '', 'download.bin'],
    ['tso', '   ', 'download.bin'],
    ['tso', "''", 'download.bin'],
  ])('%s %j -> %j', (host, input, want) => {
    expect(defaultLocalName(input, host)).toBe(want);
  });
});
```

- [ ] **Step 2: Run it and check that it fails:** `npx vitest run packages/frontend/test/transferName.test.ts`
  should fail on module not found.
- [ ] **Step 3: Implement it**

```ts
/**
 * The local file name a received host file defaults to (web receive spec, 2026-11-12).
 *
 * VM: `fn ft fm` -> `fn.ft` (the filemode names a minidisk, not part of the file's name).
 * TSO: one pair of enclosing quotes stripped, lowercased, everything else kept literally --
 * `'SYS1.PROCLIB(ASMHC)'` -> `sys1.proclib(asmhc)`, the user's own example. No OS sanitizing:
 * browsers sanitize download names themselves, and the GUI's dialog lets the user edit it.
 */
export const FALLBACK_LOCAL_NAME = 'download.bin';

export function defaultLocalName(hostFile: string, host: string): string {
  const t = hostFile.trim();
  let name: string;
  if (host === 'vm') {
    name = t.split(/\s+/).filter((w) => w !== '').slice(0, 2).join('.');
  } else {
    name = t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).trim() : t;
  }
  name = name.toLowerCase();
  return name === '' ? FALLBACK_LOCAL_NAME : name;
}
```

  Export both from `packages/frontend/src/index.ts`, following its existing export style.
- [ ] **Step 4: Run the test, then `npm run typecheck`:** both pass.
- [ ] **Step 5: Mutation:** drop `.slice(0, 2)`, so the filemode stays. The VM rows must fail. Revert.
- [ ] **Step 6: Commit:** `frontend: defaultLocalName -- a received host file's default local name`.

### Task 2: the form controller option, and the suggestion for browse

**Files:** modify `packages/canvas/src/transferUi.ts`; test in `packages/canvas/test/transferUi.test.ts`.

The design:
- `createTransferUi(deps, opts?: { deriveLocalFileOnReceive?: boolean })`, defaulting to false so
  the GUI is unchanged. Read how `createTransferUi` is constructed in both front ends first. If an
  options object already exists, add the field to it rather than a second parameter.
- With the option on and `state.values.direction === 'receive'`, `view()` omits `localFile`.
- `start()` submits `formKeywords` of a state whose `localFile` is
  `defaultLocalName(values.hostFile, values.host)`. This is a COPY: `state` itself isn't mutated,
  so switching back to send shows whatever the operator had typed. Make sure any validation
  `start()` runs before submitting sees the derived value, so a receive isn't refused for an
  empty Local file. Find where `state.error` and the required-field check come from
  (`transferForm.ts`).
- `UiDeps.browse(direction, suggestedName?: string)`. `browseLocal()` passes
  `defaultLocalName(hostFile, host)` when the direction is receive and the host file is
  non-empty, and `undefined` otherwise. This applies whatever the option, so the GUI benefits.
- [ ] **Step 1: Failing tests** (follow the file's existing fake `UiDeps` helper):
  - option on, receive: the rendered fields have no `localFile`; send does.
  - option off, receive: `localFile` is still rendered (the GUI's case).
  - option on, receive, hostFile `NAP H A2`, host vm: `submit` gets keywords containing
    `LocalFile=nap.h`, and `values().localFile` is unchanged (still `''`).
  - option on, receive, empty Local file: not refused for a missing local file.
  - `browseLocal` on a receive with hostFile `'SYS1.PROCLIB(ASMHC)'`, host tso: `browse` is
    called with `('receive', 'sys1.proclib(asmhc)')`. On a send, the second argument is
    `undefined`. On a receive with an empty hostFile, it is `undefined`.
- [ ] **Step 2: fail. Step 3: implement. Step 4: tests pass, then `npm run typecheck`.**
  The GUI's and the web's `transferBoot.ts` implement `browse`. The typechecker will flag any
  implementation that no longer matches. Update them minimally here: the web still ignores the
  receive case, and the GUI's change is Task 3.
- [ ] **Step 5: Mutation:** the view ignores the option, then the submit uses the raw
  `localFile`. Each must fail a test. Revert.
- [ ] **Step 6: Commit:** `canvas: deriveLocalFileOnReceive, and browse suggests a received file's name`.

### Task 3: the GUI save dialog suggests the name

**Files:** the GUI's `transferBoot.ts` (renderer `browse`), its transfer preload (`*Preload.cts`),
and `main.ts` (`saveDialog`). Find the IPC channel the receive browse uses.

- [ ] **Step 1: Failing test.** Find the existing GUI test that covers `saveDialog` or the
  transfer IPC (the `gui/test/transfer*.test.ts` files), and add a case: the suggestion reaches
  `showSaveDialog` as `defaultPath`, with no `defaultPath` key when there is no suggestion. If
  `main.ts`'s dialog code isn't unit-testable as it stands, factor the options construction into
  a small pure function (`saveDialogOptions(suggestedName?)`) and test that. Say which you did.
- [ ] **Step 2: fail. Step 3: implement:** carry `suggestedName` across the IPC, and
  `showSaveDialog(tw, { title: 'Receive into which file?', ...(s ? { defaultPath: s } : {}) })`.
  The seam stub (`SEAM.transferPath`) is unchanged.
- [ ] **Step 4:** tests, `npm run typecheck`, `npm run build`, then `node packages/gui/scripts/transfer.mjs`
  under Xvfb (read it for how; the userspace Xvfb lives in `packages/gui/scripts/xvfb.mjs`). It
  must still pass.
- [ ] **Step 5: Commit:** `gui: the receive dialog suggests the host file's default local name`.

### Task 4: the web receive downloads on completion

**Files:** `packages/web/src/transferBridge.ts`, `packages/web/src/transferBoot.ts`, the HTML
declaring `transfer-save`, `packages/web/test/transferBridge.test.ts`, and
`packages/web/test/transferOverlay.test.ts`.

- [ ] **Step 1: Failing tests (bridge):**
  - a completed receive, then `deliver()` (the renamed `save`), calls `saveFallback` exactly once
    with the given name and byte-identical data;
  - after it, `hasUnsaved()` is false;
  - a failed receive (a refused or bad chunk) and a `cancel()` lead to zero `saveFallback` calls;
  - `TransferBridgeDeps` has no `savePicker`: a type-level check, or a test that
    `createTransferBridge` ignores it. The simplest honest form is that the old picker tests are
    deleted and a comment says why.
- [ ] **Step 2: fail. Step 3: implement:**
  - **Bridge:** remove `savePicker` and `SaveSink`, if nothing else uses them; grep first.
    `save(name)` becomes `deliver(name): SendResult`, synchronous: take `complete`, clear it, then
    call `deps.saveFallback(name, bytes)`. If the fallback throws, restore `complete` and return
    the error (it's synchronous, so there's no abort case). Keep `hasUnsaved()`.
  - **`transferBoot.ts`:**
    - pass `{ deriveLocalFileOnReceive: true }` to `createTransferUi`;
    - remove the Save button's lookup, handler and focus logic, and the picker feature-detection;
    - in the completion handler, on a successful receive call `bridge.deliver(saveName)`; on ok,
      set the status to `received <n> bytes; downloaded as <saveName>` (keep the existing "no
      ellipsis in status text" rule); on error, show the error;
    - a send's completion is unchanged.
  - **HTML:** remove the `transfer-save` button, and any CSS rule only it used.
  - **Overlay:** `hasUnsaved` stays wired, but is now only true transiently. Leave
    `transferOverlay.ts` alone if its tests still pass. If a test asserted the receive-discard
    prompt, change it to assert that a completed receive does NOT prompt.
- [ ] **Step 4:** `npx vitest run packages/web`, then `npm run typecheck` and `npm run build`.
- [ ] **Step 5: Mutation:**
  - don't call `deliver` on success;
  - call it on failure;
  - pass a fixed name instead of `saveName`.

  Each must fail a test; if one doesn't, add the test. Revert.
- [ ] **Step 6: Commit:** `web: a receive downloads on completion; the Save button and the picker route are gone`.
  Record the spec deviation.

### Task 5: the real-browser harness

**File:** `packages/web/scripts/browser-clicks.mjs`. Read it fully first: how it launches the
browser (Electron as a browser, or a Chromium?), how it drives the overlay, and its current
transfer steps.

- [ ] **Step 1:** Update its transfer steps:
  - **no Save button:** assert that `#transfer-save` doesn't exist;
  - **receive:** assert that the Local file input is absent from the field list on a receive and
    present on a send;
  - **one download:** a receive from its fake host produces exactly ONE download, whose suggested
    name is the derived one (pick a VM-style host file in the harness, e.g. `NAP H A2` →
    `nap.h`), with bytes identical to what the fake host sent.

  Capture the download with the browser's own download event (Electron's `will-download` on the
  session, or Chromium's equivalent), not by watching a directory. Name the mechanism you used.
- [ ] **Step 2:** Run it the way its header says (build first). It must pass. Record the output.
- [ ] **Step 3: Mutation:** temporarily make the boot not call `deliver`; the harness must FAIL
  on "no download". Revert and rebuild.
- [ ] **Step 4: Commit:** `web: browser-clicks checks a receive downloads once, named from the host file`.

### Task 6: docs

- [ ] README.md, *Using the web gateway*'s transfer paragraph: a receive has no Local file field;
  when it completes the browser downloads it, named from the host file (VM `fn ft fm` → `fn.ft`;
  TSO lowercased with quotes stripped); there is no Save step. Remove any mention of
  `showSaveFilePicker` and of the Save button.
- [ ] `packages/web/README.md`, *File transfer*: the same.
- [ ] The README's GUI transfer text: the receive dialog suggests the same name (one clause).
- [ ] A changelog fragment: run `~/.local/bin/uvx scriv==1.8.1 create`, and fill in:
  - *New features:* "In the browser a receive downloads the file as soon as it completes, named
    from the host file; the GUI's save dialog suggests the same name."
  - *Bug fixes:* "The browser's Save button no longer stays enabled after saving and hands back
    the previous file."

  Delete the empty sections.
- [ ] Check with `/usr/bin/grep -rn -E "showSaveFilePicker|transfer-save|press Save" README.md packages/*/README.md packages/web/src`,
  and read every hit.
- [ ] Commit: `docs: the browser's receive downloads on completion`.

### Task 7: gate

- [ ] `npm ci`, `npm run build`, `npm run typecheck`, `npm test`, each as its own command.
- [ ] Ask the user before pushing. Then push, run
  `/usr/bin/gh workflow run package.yml --ref web-receive-download -f sign=false`, and require all
  jobs green.
- [ ] Owed live, by the user: a receive from VM/CMS in Firefox and in Chrome, which lands as the
  derived name with no further clicks.
