# The transfer direction labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the transfer form's direction state its endpoints — `send: local to host`, `receive: host to local` — and open on `send`, without changing the keyword either value emits.

**Architecture:** One display mapping in `packages/frontend/src/transferForm.ts`, consumed by the three renderers that already map stored values to display text. The stored values stay `send`/`receive` because `formKeywords` emits them verbatim. One default changes (`newTransferForm`); the keyword parser's default deliberately does not.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes` on), vitest for units, Xvfb+Electron harnesses for the two GUIs, CDP for the browser.

**Spec:** `docs/superpowers/specs/2026-10-22-direction-labels-design.md`

---

## Read this before Task 1

**THE REPO BEATS THIS PLAN.** This project has repeatedly found that most execution-time defects
were in the plan's own literal code, not the implementation. Re-derive every citation; if the repo
disagrees, the repo wins and you say so in your report.

**Four facts, verified 2026-10-22. Re-check them:**

1. `transferForm.ts:233` is ``out.push(`${keyword[f.id]}=${value}`);`` — the emitted keyword is the
   **stored value**, so the new text MUST be display-only.
2. `transferForm.ts:92` holds `direction: 'receive', host: 'tso', ...` — the form's default.
3. `transfer.ts:483` is `get('direction') ?? 'receive'` — the PARSER's default, which **stays**.
4. `transferForm.ts:163` makes `recfm` applicable only on a send, so flipping the default **draws
   one more field** on open.

**MEASURED BLAST RADIUS OF THE DEFAULT FLIP: exactly 27 failing tests in 4 files.** Established by
making the one-line change and running the suite, then reverting:

| file | failures |
|---|---|
| `packages/tui/test/app.test.ts` | 11 |
| `packages/frontend/test/transferForm.test.ts` | 7 |
| `packages/canvas/test/transferUi.test.ts` | 7 |
| `packages/tui/test/transferOverlay.test.ts` | 2 |

**EVERY ONE IS A TEST ASSERTING THE OLD DEFAULT, NOT A BEHAVIOUR BREAK** — most set up a form and
cycle to `send`, which now starts there. **If your change produces a failure OUTSIDE these four
files, or a count materially different from 27, stop and report it**: that is a real regression and
not bookkeeping.

**Do not use `->`, `<-`, `...`, or any non-ASCII arrow in any of this text.** Fira Code ligates the
first three, and the TUI renders printable ASCII only (`tui/src/app.ts:958`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/frontend/src/transferForm.ts` | The shared field table, state and keyword emission | Add `directionLabel()`; flip `newTransferForm`'s default |
| `packages/frontend/src/index.ts` | The package's public surface | Export the new function |
| `packages/tui/src/transferOverlay.ts` | Draws the TUI form | Use it in `shown()` |
| `packages/canvas/src/transferUi.ts` | Shared view model for GUI and browser | Carry display text on `UiField` |
| `packages/web/src/transferBoot.ts` | Builds the browser `<select>` | Render display text |
| `packages/gui/src/transferBoot.ts` | Builds the GUI `<select>` | Render display text |
| `packages/frontend/src/transfer.ts` | The keyword parser | **UNCHANGED** — default stays `receive` |

---

## Task 1: `directionLabel()`, with the stored values untouched

**Files:**
- Modify: `packages/frontend/src/transferForm.ts`
- Modify: `packages/frontend/src/index.ts`
- Test: `packages/frontend/test/transferForm.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/frontend/test/transferForm.test.ts`:

```ts
  describe('directionLabel', () => {
    it('names both endpoints, so a direction cannot be read as a bare verb', () => {
      expect(directionLabel('send')).toBe('send: local to host');
      expect(directionLabel('receive')).toBe('receive: host to local');
    });

    it('returns any other value UNCHANGED, so a new direction cannot vanish from a menu', () => {
      // The renderers map every offered value through this. A `switch` with no default would
      // return undefined and draw a blank option rather than failing loudly.
      expect(directionLabel('')).toBe('');
      expect(directionLabel('sideways')).toBe('sideways');
    });

    it('SAYS LOCAL, NOT BROWSER: the TUI and GUI have no browser', () => {
      // `local` is true in all three front ends and matches the `Local file` field label.
      // Pinned because the user's first phrasing was "this browser", which is wrong in two of
      // the three.
      expect(directionLabel('send')).not.toContain('browser');
      expect(directionLabel('receive')).not.toContain('browser');
    });

    it('USES NO LIGATING PUNCTUATION AND NO NON-ASCII, because the TUI draws ASCII only', () => {
      for (const v of ['send', 'receive']) {
        const text = directionLabel(v);
        expect(text).not.toContain('->');
        expect(text).not.toContain('<-');
        expect(text).not.toContain('...');
        // eslint-disable-next-line no-control-regex
        expect(text).toMatch(/^[\x20-\x7e]*$/);
      }
    });

    it('FITS the TUI value column, which is what stops the box growing past 80 columns', () => {
      // VALUE_WIDTH is 40, set by the two 40-wide text fields. Asserted here rather than only
      // in the TUI's own suite so a future rewording is caught in the module that owns the text.
      expect(directionLabel('receive').length).toBeLessThanOrEqual(40);
      expect(directionLabel('send').length).toBeLessThanOrEqual(40);
    });
  });

  describe('formKeywords, after the labels changed', () => {
    it('EMITS THE STORED VALUE AND NOT THE LABEL -- the whole point of a display mapping', () => {
      // THIS IS THE ASSERTION THAT DISTINGUISHES A DISPLAY MAPPING FROM A VALUE CHANGE. A label
      // that reached `formKeywords` would emit `Direction=send: local to host`, which this
      // project's own validator refuses.
      let s = newTransferForm();
      s = setFieldText(s, 'localFile', '/tmp/x');
      s = setFieldText(s, 'hostFile', 'X DATA A');
      const kw = formKeywords(s);
      expect(kw).toContain('Direction=send');
      expect(kw.join(' ')).not.toContain('local to host');
    });
  });
```

Add `directionLabel` to the existing import from `../src/transferForm.js` at the top of that file.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/frontend/test/transferForm.test.ts 2>&1 | tail -15
```

Expected: failures naming `directionLabel is not a function` (or a TS error that it is not
exported). **The `formKeywords` case may fail on `Direction=send` until Task 2 flips the default —
that is expected and Task 2 closes it.**

- [ ] **Step 3: Implement it**

In `packages/frontend/src/transferForm.ts`, after `TRANSFER_FIELDS`:

```ts
/**
 * The direction as the operator should read it: both endpoints named, never a bare verb.
 *
 * ## THIS IS DISPLAY ONLY, AND THAT IS A HARD CONSTRAINT RATHER THAN A STYLE CHOICE
 *
 * `formKeywords` emits `Direction=${value}` from the STORED value, and `parseTransferKeywords`
 * validates against the literals `['receive', 'send']`. A renamed value would emit
 * `Direction=send: local to host` and be refused by our own validator. So the stored value stays
 * `send`/`receive` and only what is DRAWN changes -- the same split the TUI's `shown()` already
 * uses for `''` -> `-` and the web `<select>` for `''` -> `(host default)`.
 *
 * ## WHY THIS EXISTS: IT COST A REAL FILE
 *
 * On 2026-10-07 the user -- an expert on this protocol, driving their own client -- read the bare
 * `send`/`receive` the wrong way round and OVERWROTE THEIR OWN `PROFILE EXEC A` under
 * `Exist=replace`. All four of this feature's guards defend against an EMPTY file reaching the
 * host; NONE covers a valid file hitting the wrong target. Naming the endpoints is the cheap half
 * of that gap.
 *
 * ## `local`, NOT `browser`
 *
 * The user's own first phrasing was `this browser`, which is right for the web gateway and WRONG
 * for the other two front ends: in the TUI and the Electron GUI, "local" is this machine's
 * filesystem. `local` is true in all three AND matches the `Local file` field label directly
 * above it, so the form reads as one statement rather than two vocabularies.
 *
 * ## NO ARROWS
 *
 * Fira Code and friends ligate `->` and `<-` (see `canvas/src/transferUi.ts`, which already took
 * the arrows out of a help line for this), and the TUI draws printable ASCII only, so a real
 * `->` would force per-front-end text. `to` means the same thing in every renderer.
 *
 * AN UNKNOWN VALUE IS RETURNED UNCHANGED rather than falling through to `undefined`: every
 * renderer maps the values it offers through this, so a `switch` without this property would draw
 * a blank menu entry if a third direction were ever added.
 */
export function directionLabel(value: string): string {
  if (value === 'send') return 'send: local to host';
  if (value === 'receive') return 'receive: host to local';
  return value;
}
```

- [ ] **Step 4: Export it**

In `packages/frontend/src/index.ts`, add `directionLabel` to the existing
`TRANSFER_FIELDS, newTransferForm, cycleField, setFieldText,` export group (around `:111`).

- [ ] **Step 5: Build, typecheck, run**

```bash
cd ~/git/tn3270 && npm run build 2>&1 | tail -3 && npm run typecheck 2>&1 | tail -3
npx vitest run packages/frontend/test/transferForm.test.ts 2>&1 | tail -6
```

Expected: every new case passes except possibly the `Direction=send` one, which Task 2 fixes.
**`npm run build` before believing any result** — vitest does not typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/frontend/src/transferForm.ts packages/frontend/src/index.ts packages/frontend/test/transferForm.test.ts
git commit -m "feat(frontend): directionLabel names both endpoints of a transfer

Display only: formKeywords emits the stored value, so send/receive are
unchanged on the wire. The bare words cost the user their PROFILE EXEC A on
2026-10-07, and all four of this feature's guards defend a different hazard.

Says 'local' rather than 'browser' because the TUI and GUI have no browser,
and uses no ligating punctuation because the TUI draws ASCII only.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: The form opens on `send`

**Files:**
- Modify: `packages/frontend/src/transferForm.ts:92`
- Test: `packages/frontend/test/transferForm.test.ts` and the three other suites listed above

- [ ] **Step 1: Make the change**

```ts
      direction: 'send', host: 'tso', localFile: '', hostFile: '',
```

And extend `newTransferForm`'s docstring:

```ts
/**
 * A fresh form.
 *
 * ## IT OPENS ON `send`, AND THE PARSER'S DEFAULT IS DELIBERATELY DIFFERENT
 *
 * The user's reason, recorded because this will look surprising to someone one day: until VM has a
 * TCP/IP stack, this client is mostly used to GET SOFTWARE ONTO these systems -- few people
 * develop software locally on a VM or MVS guest. Upload is the common case.
 *
 * (The user's planned route to such a stack, which is the condition that would make this worth
 * revisiting: UTS -- v7 Unix -- plus an IUCV-alike backported to VM/370, a simple network driver
 * over a CTC pair cribbed from Linux on System/390, and a small TCP stack in UTS. Hard on a
 * PDP-11 for address-space reasons; not hard on S/370 with up to 16 MB. If download stops being
 * the rare direction, reconsider this default.)
 *
 * ## `parseTransferKeywords` STILL DEFAULTS TO `receive`, AND MUST
 *
 * That default applies when a SCRIPT omits `Direction=`. Flipping it would silently invert every
 * such script -- a run that downloaded would upload, with `Exist=replace` reachable and no form to
 * look at -- which is the same data-destruction shape this change exists to prevent, moved
 * somewhere worse. It is also x3270's own default, which this project matches absent a documented
 * reason. An interactive form with a visible, self-describing control is a different safety
 * situation from an omitted keyword in an unattended script.
 *
 * NOTE THE KNOCK-ON: `applicable` shows `Recfm` only on a send, so a fresh form now draws ONE MORE
 * FIELD than it used to. The TUI's box height is computed from the applicable count, so this is a
 * visible change there, not only a value change.
 */
```

- [ ] **Step 2: Run the suite and CHECK THE SHAPE OF THE DAMAGE**

```bash
cd ~/git/tn3270 && npm run build >/dev/null 2>&1 && npx vitest run 2>&1 | grep -E "Tests |FAIL" | head -32
```

Expected: **27 failures in exactly these four files** — `tui/test/app.test.ts` (11),
`frontend/test/transferForm.test.ts` (7), `canvas/test/transferUi.test.ts` (7),
`tui/test/transferOverlay.test.ts` (2). **A failure anywhere else is a real regression: stop and
report it rather than editing the test.**

- [ ] **Step 3: Fix each failing test by UPDATING ITS SETUP, not its assertion**

Read each one. The pattern is a test that built a form and cycled to `send`; it now starts there, so
the setup cycles one step too far. **Where a test's PURPOSE is the old default** — notably
`transferForm.test.ts`'s `starts at receive, tso, binary, keep, with Cr and Recfm UNSET` — rename it
and assert the new default, and say in the test body WHY it changed.

**DO NOT weaken an assertion to make it pass.** If a test pins `Recfm` being absent on a fresh form,
that fact genuinely changed; re-point it at a receive rather than deleting it.

- [ ] **Step 4: Add the test that pins the asymmetry**

In `packages/frontend/test/transfer.test.ts`:

```ts
  it('DEFAULTS Direction TO receive, which is x3270 and is NOT the form default', () => {
    // LOAD-BEARING, AND THE ASYMMETRY IS THE POINT. `newTransferForm` opens on `send` because the
    // interactive form names its endpoints; this parser serves SCRIPTS, where flipping the default
    // would silently invert every `Transfer(...)` that omits `Direction=` -- upload instead of
    // download, `Exist=replace` reachable, and no form to look at. x3270 defaults to receive and
    // this project matches it absent a documented reason.
    expect(req().direction).toBe('receive');
  });
```

**USE THAT FILE'S OWN `req(...)` HELPER** (`transfer.test.ts:49`), which wraps
`parseTransferKeywords` in `withRequired` so the mandatory `LocalFile`/`HostFile` are supplied. A
hand-written `parseTransferKeywords([...])` would throw `missing 'LocalFile' option` before it ever
reached the direction default, and would fail for the wrong reason. Verified against the file.

- [ ] **Step 5: Full suite green**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | tail -5
```

Expected: all tests pass. The total will have grown by the new cases from Tasks 1 and 2.

- [ ] **Step 6: Commit**

```bash
git add -A packages/frontend packages/canvas packages/tui
git commit -m "feat(frontend): the transfer form opens on send, not receive

The user's reason: until VM has a TCP/IP stack this client is mostly used to
get software ONTO these systems, since few people develop locally on them.

parseTransferKeywords STILL defaults to receive and must -- that default
serves scripts, where flipping it would silently invert every Transfer()
omitting Direction=, which is this change's own hazard moved somewhere
worse. A test now pins that asymmetry.

27 tests across four files asserted the old default. Each had its SETUP
updated rather than its assertion weakened.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: The TUI draws the label

**Files:**
- Modify: `packages/tui/src/transferOverlay.ts` — `shown()` (`:101-105`) and `VALUE_WIDTH` (`:42-47`)
- Test: `packages/tui/test/transferOverlay.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('draws the direction with BOTH ENDPOINTS named, not as a bare verb', () => {
    const lines = transferLines(newTransferForm(), 'form', undefined);
    const row = lines.find((l) => l.includes('Direction'));
    expect(row).toContain('send: local to host');
  });

  it('KEEPS THE BOX WITHIN 24x80 with the longer direction text', () => {
    // The whole box, not just the row: `TRANSFER_MIN.cols` is derived from `LINE_WIDTH`, which is
    // derived from `VALUE_WIDTH`. A direction label longer than the 40-wide text fields would
    // widen every row and could push the form past the 80-column floor `tooSmall` imposes.
    expect(TRANSFER_MIN.cols).toBeLessThanOrEqual(80);
    expect(TRANSFER_MIN.rows).toBeLessThanOrEqual(24);
    for (const line of transferLines(newTransferForm(), 'form', undefined)) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd ~/git/tn3270 && npx vitest run packages/tui/test/transferOverlay.test.ts 2>&1 | tail -8
```

Expected: the first case fails, the row showing a bare `send`.

- [ ] **Step 3: Use the label in `shown()`**

```ts
function shown(id: TransferFieldId, values: TransferValues): string {
  const raw = values[id];
  // THE DIRECTION IS DRAWN WITH BOTH ENDPOINTS NAMED. `directionLabel` is the one home for that
  // text, shared with both GUIs, so the three front ends cannot drift into three wordings -- and
  // the STORED value is still `send`/`receive`, which is what `formKeywords` emits.
  const labelled = id === 'direction' ? directionLabel(raw) : raw;
  const text = labelled === '' ? '-' : labelled;
  return text.length > VALUE_WIDTH ? text.slice(0, VALUE_WIDTH - 1) + '>' : text;
}
```

Import `directionLabel` from `@tn3270/frontend` (match the existing import style in that file).

**`VALUE_WIDTH` NEEDS NO CHANGE** — it is already 40 from the text fields, and the longest label is
24. **Verify that rather than trusting it:** if `VALUE_WIDTH` were ever driven by the cycle values,
this label would widen the box.

- [ ] **Step 4: Run it**

```bash
cd ~/git/tn3270 && npm run build >/dev/null 2>&1 && npx vitest run packages/tui/test/transferOverlay.test.ts 2>&1 | tail -5
```

Expected: pass, including the geometry case.

- [ ] **Step 5: See it, rather than only testing it**

```bash
cd ~/git/tn3270 && python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
```

Expected: 12 PASS / 0 FAIL. This does not open the transfer form, so it is a regression check on the
surrounding draw path rather than evidence of the label.

- [ ] **Step 6: Commit**

```bash
git add packages/tui/src/transferOverlay.ts packages/tui/test/transferOverlay.test.ts
git commit -m "feat(tui): draw the direction with both endpoints named

Through frontend's directionLabel, so the three front ends share one wording.
VALUE_WIDTH is unchanged -- already 40 from the text fields against a 24-char
label -- and a test now pins the whole box inside 24x80.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 4: Both GUIs draw the label

**Files:**
- Modify: `packages/canvas/src/transferUi.ts` — `UiField` and `view()`
- Modify: `packages/web/src/transferBoot.ts` — `renderFields`'s `<option>` text (around `:290-297`)
- Modify: `packages/gui/src/transferBoot.ts` — the equivalent `<option>` text
- Test: `packages/canvas/test/transferUi.test.ts`

- [ ] **Step 1: Decide the seam, and read both renderers first**

```bash
cd ~/git/tn3270
grep -n "interface UiField" -A12 packages/canvas/src/transferUi.ts
grep -n "o.textContent" packages/web/src/transferBoot.ts packages/gui/src/transferBoot.ts
```

**THE DISPLAY TEXT TRAVELS ON `UiField`, rather than each renderer calling `directionLabel`
itself.** Both `<select>` builders already map `''` to `(host default)` locally — so adding a second
local mapping in each would put the same decision in two files, which is how the two front ends
drift. `transferUi.ts` already owns what the renderers draw.

- [ ] **Step 2: Write the failing test**

```ts
  it('offers the direction with DISPLAY TEXT alongside each value, both endpoints named', () => {
    const deps = fakeDeps();
    createTransferUi(deps);
    const dir = deps.rendered[0]!.find((f) => f.id === 'direction');
    // `options` is what gets SUBMITTED; `optionLabels` is what the operator READS. Both are
    // asserted, because the whole design rests on those being different for this one field.
    expect(dir?.options).toEqual(['receive', 'send']);
    expect(dir?.optionLabels).toEqual(['receive: host to local', 'send: local to host']);
  });

  it('LABELS EVERY OPTION OF EVERY CYCLE FIELD, so a renderer can map positionally', () => {
    // `optionLabels` must be the same length and order as `options` for every cycle field, not
    // only for `direction`: the renderers index one by the other, and a short array would draw
    // `undefined` in a menu.
    const deps = fakeDeps();
    createTransferUi(deps);
    for (const f of deps.rendered[0]!) {
      if (f.kind !== 'cycle') continue;
      expect(f.optionLabels).toHaveLength(f.options.length);
    }
  });
```

**THE HELPER IS `fakeDeps()` AND THE FIELDS ARE READ OFF `deps.rendered[0]`** — verified against the
file, which uses `environment: 'node'` and a hand-rolled fake rather than jsdom. An earlier draft of
this plan invented a `harness()` returning a `fields()` accessor; no such helper exists. These cases
go inside the existing `describe('createTransferUi', ...)`, at its indentation.

- [ ] **Step 3: Carry the labels on `UiField`**

In `packages/canvas/src/transferUi.ts`, add to `UiField`:

```ts
  /**
   * What to DRAW for each entry of `options`, positionally aligned with it.
   *
   * SEPARATE FROM `options` BECAUSE THE VALUE IS WHAT GETS SUBMITTED. `formKeywords` emits the
   * stored value, so a renderer must keep both: the value it will report back, and the text the
   * operator reads. Today only `direction` differs between the two; `''` is still rendered as
   * `(host default)` by each renderer, which is about an EMPTY value rather than a named one.
   *
   * ALWAYS THE SAME LENGTH AND ORDER AS `options`, so a renderer can zip them by index.
   */
  readonly optionLabels: readonly string[];
```

and in `view()`:

```ts
      const options = f.kind === 'cycle' ? offered(f.id) : [];
      out.push({
        id: f.id,
        label: f.label,
        kind: f.kind,
        value: state.values[f.id],
        options,
        // ONE MAPPING FOR EVERY CYCLE FIELD, not a special case for `direction`: `directionLabel`
        // returns anything it does not recognise unchanged, so this is the identity for the rest.
        optionLabels: options.map((o) => (f.id === 'direction' ? directionLabel(o) : o)),
      });
```

Import `directionLabel` from `@tn3270/frontend` beside the existing `TRANSFER_FIELDS` import.

- [ ] **Step 4: Draw it in the browser**

In `packages/web/src/transferBoot.ts`'s `renderFields`, replace the option loop:

```ts
        for (const [i, opt] of f.options.entries()) {
          const o = doc.createElement('option');
          o.value = opt;
          // THE VALUE IS SUBMITTED AND THE LABEL IS READ. `optionLabels` is positionally aligned
          // with `options` (`transferUi.ts`), so the index is the join. An empty value is a REAL
          // state meaning "I did not ask" and keeps its own rendering.
          o.textContent = opt === '' ? '(host default)' : (f.optionLabels[i] ?? opt);
          if (opt === f.value) o.selected = true;
          select.append(o);
        }
```

- [ ] **Step 5: Draw it in the Electron GUI**

Apply the same change to `packages/gui/src/transferBoot.ts`'s option loop. **Read it first** — its
structure differs from the browser's, and its `(host default)` handling may not be identical.

- [ ] **Step 6: Build, typecheck, full suite**

```bash
cd ~/git/tn3270 && npm run build && npm run typecheck && npx vitest run 2>&1 | tail -5
```

`UiField` gaining a required property will break every test that constructs one by hand. **Add
`optionLabels` to those fixtures rather than making the property optional** — an optional one would
let a renderer silently fall back to bare values, which is the defect being fixed.

- [ ] **Step 7: Prove both GUIs really draw it**

```bash
cd ~/git/tn3270
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2
pkill -9 -f node_modules/electron 2>/dev/null; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3
pkill -9 -f node_modules/electron 2>/dev/null; sleep 3
```

Expected: `10/10` and `7/7`. **`pkill` BETWEEN RUNS IS NOT OPTIONAL**: leaked Electron processes
contending for the one Xvfb display made `browser-clicks` report `0/7` with `bridge.js did not
load` during the save-affordance work — indistinguishable from a real regression.

- [ ] **Step 8: Add a real-browser assertion on the drawn text**

In `packages/web/scripts/browser-clicks.mjs`, in the `overlay` phase where the field rows are
already counted, read the direction `<select>`'s selected option text and assert it names both
endpoints:

```js
    const dirText = await cdp.eval(
      'document.getElementById("transfer-direction").selectedOptions[0].textContent');
```

Fold it into that phase's existing pass condition with `dirText.includes('local to host')`, and add
it to the failure detail. **Then prove it can fail**: revert `optionLabels` in `transferBoot.ts` to
`opt`, rebuild, confirm the phase goes red, and restore.

- [ ] **Step 9: Commit**

```bash
git add -A packages/canvas packages/web packages/gui
git commit -m "feat(ui): both GUIs draw the direction with its endpoints named

The display text travels on UiField.optionLabels, positionally aligned with
options, rather than each renderer calling directionLabel itself -- the two
select builders already each map '' to '(host default)', and a second local
mapping per file is how the front ends drift.

optionLabels is REQUIRED, not optional: an optional one would let a renderer
fall back to bare values, which is the defect being fixed.

Mutation-proved in the real browser.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 5: The gate and the docs

**Files:**
- Modify: `docs/live-testing.md`, `docs/HANDOFF.md`, `README.md` (only if it documents the form default)

- [ ] **Step 1: Check whether the README states a default**

```bash
cd ~/git/tn3270 && grep -n "Direction\|receive" README.md | head -10
```

If it documents the FORM's default, update it. If it documents the KEYWORD default, **leave it** —
that is unchanged, and this project has recorded that doc audits find real defects, so read before
editing.

- [ ] **Step 2: The full gate, serially**

```bash
cd ~/git/tn3270
npm run build && npm run typecheck && npx vitest run 2>&1 | tail -4
node packages/gui/scripts/transfer.mjs 2>&1 | tail -2; pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | tail -2;     pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/clicks.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/select.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/gui/scripts/shot.mjs 2>&1 | tail -2;     pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-keys.mjs 2>&1 | tail -2;   pkill -9 -f node_modules/electron; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3; pkill -9 -f node_modules/electron; sleep 3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -2
```

**`shot.mjs` AND `browser-shot.mjs` MAY LEGITIMATELY DIFFER THIS TIME** — the transfer form is not
in either golden, but confirm that rather than assuming it. If a golden breaks, report it and stop;
do not regenerate.

`drive-playback.py` and `drive-e.py` are **not** required: the emitted keywords are byte-identical
and nothing touches telnet negotiation or the stream layer. Say so in the commit.

- [ ] **Step 3: Record it in `docs/live-testing.md`**

State that the direction labels and the `send` default are built and **verified offline only**, that
**no live run was needed because the wire bytes are unchanged**, and that the remaining exposure is a
correct direction with a wrong `Host file` — which naming the endpoints does not address.

- [ ] **Step 4: Update `docs/HANDOFF.md`**

The direction-label defect is currently listed as one of two items waiting on the user. Move it to
done, note that the form now opens on `send` with the user's reason, and **state plainly that the
keyword parser's default is deliberately still `receive`** — that asymmetry is exactly the kind of
thing a future session would "fix" without the reasoning in front of it.

- [ ] **Step 5: Commit**

```bash
git add -A docs README.md
git commit -m "docs: the direction labels are built, and the parser asymmetry is explained

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| `send: local to host` / `receive: host to local` | 1 Step 3 |
| Display only; stored values unchanged; `formKeywords` still emits `Direction=send` | 1 Steps 1, 3 (the `formKeywords` case is the key assertion) |
| `local` not `browser`, and why | 1 Step 1 (pinned by test) and Step 3 (docstring) |
| No ligating punctuation, ASCII only | 1 Step 1 (pinned) and Step 3 |
| Fits the TUI column; box stays inside 24x80 | 1 Step 1 (length bound) and 3 Step 1 (box geometry) |
| Form opens on `send`, with the user's reasoning recorded | 2 Steps 1 |
| Parser default STAYS `receive`, with a test pinning the asymmetry | 2 Step 4 |
| The `Recfm` knock-on field is expected and verified | 2 Steps 1 (docstring), 3 (shape of the 27) |
| The three renderers draw it, from one shared mapping | 3, 4 |
| No live run needed, stated explicitly | 5 Steps 2, 3 |
| Remaining exposure (right direction, wrong `Host file`) stated | 5 Step 3 |
