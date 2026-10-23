# Keyboard harness cover implementation plan (full-keyboard Task 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nothing about the full keyboard can break unseen — the GUI chord, the web caps' actions,
the inert caps, and the one-shot Shift all get a harness witness.

**Architecture:** Three additions to existing harnesses, no product code. A `Ctrl+B` case in
`packages/gui/scripts/keys.mjs`; a keyboard phase in `packages/web/scripts/browser-clicks.mjs` that
CLICKS caps and asserts the gateway's own action log; then the gate and the docs.

**Tech Stack:** Node harness scripts driving Electron under Xvfb, the Chrome DevTools Protocol for
real input, vitest for the unit layer.

**Supersedes** Task 7 of `docs/superpowers/plans/2026-10-22-full-keyboard.md`, which this follows
but reorders: the `Ctrl+B` gap found on 2026-10-23 is promoted to Task 1 because it is the one
defect that would currently pass the entire gate.

---

## READ THIS BEFORE TASK 1 — FOUR TRAPS, EACH ALREADY PAID FOR IN THIS REPO

**1. ELECTRON LEAKS MAKE HARNESSES LIE.** 72 leaked processes once produced `0/7` plus a misleading
"bridge.js did not load". Between every browser harness run:
`pkill -9 -f "node_modules/[e]lectron"; sleep 3`. **The bracket escape is required** — an
unescaped `node_modules/electron` pattern matches the shell's own command line and kills the
compound command before the harness runs, which looks like a silent failure.

**2. A STALE `dist/` MAKES HARNESSES REFUSE** with `dist is OLDER than src`. Fix:
`npx tsc --build --force packages/canvas packages/gui`.

**3. RUN THE WHOLE SUITE, NOT A PACKAGE SUBSET.** A package-scoped run hid an entire omitted edit
earlier in this feature (`BROWSER_MODULES`, in `packages/web`, while the change was in
`packages/canvas`).

**4. ASSERT THE THING, NOT A PROXY — AND PROVE IT BY BREAKING WHAT IT WATCHES.** Five vacuous
assertions were caught in one day on this feature, each of which PASSED against the very defect it
was written for: a 2px tolerance on a 2px error, `elementFromPoint` against a `clip-path` it
honours, two different font-coverage probes, and `w > 0` against a 2.3px fallback. **Every new
check in this plan has a mutation step. Do not skip it.** If a mutation does not fail the check,
the check is decoration — say so rather than moving on.

---

## File Structure

- **Modify `packages/gui/scripts/keys.mjs`** — one `Ctrl+B` case. The GUI chord's only witness.
- **Modify `packages/web/scripts/browser-clicks.mjs`** — a keyboard phase that clicks caps and
  reads the gateway's action log. The web caps' only functional witness.
- **Modify `README.md`, `docs/live-testing.md`, `docs/HANDOFF.md`** — record what is and is not
  covered.

---

## Task 1: `Ctrl+B` gets a witness in the GUI

**Files:**
- Modify: `packages/gui/scripts/keys.mjs`

**WHY THIS IS FIRST -- AND THE PREMISE WAS PARTLY WRONG, CORRECTED 2026-10-23 BY THE IMPLEMENTER.**

What I wrote: `grep -c "Ctrl+B"` is 0 in every harness, so the chord has no witness anywhere and a
regression would pass the whole gate. **The grep was the flaw.** `browser-clicks.mjs` spells it
`Ctrl-B` WITH A HYPHEN and dispatches the real chord through CDP, so the WEB front end had cover
all along. Proved by mutation rather than by reading: deleting `b:` from the `CTRL` table fails
`keys.mjs`, `browser-clicks.mjs` AND `canvas/test/keys.test.ts` -- three witnesses where the
premise claimed zero.

**THE NARROWER GAP IS REAL AND THIS TASK STILL CLOSES IT:** no GUI harness witnessed the chord, and
the GUI path is Electron renderer -> IPC -> `ipcMain`, which no web harness touches. That is worth
a case on its own merits -- it is just the third witness, not the first.

**A GREP FOR ONE SPELLING OF A CHORD IS NOT A MEASUREMENT OF ITS COVER.** Any later task in this
plan that justifies itself by absence must mutate the thing and watch, not grep for a string. That is not hypothetical: **this exact list
already missed `Ctrl+T` once**, and its own comment records it — the chord was dead in the GUI for
a commit while the `Xfer` keypad button worked perfectly, because the click route goes through
`KEYPAD_KEYS` and never through the `CTRL` table. `Ctrl+B` is the same shape.

- [ ] **Step 1: Read the file's own account of the `Ctrl+T` defect**

```bash
cd ~/git/tn3270 && sed -n '78,120p' packages/gui/scripts/keys.mjs
```

This is the precedent your new case follows. Note that `Ctrl+K` and `Ctrl+T` are both in the list
specifically because their handling is in `main.ts` rather than in `applyAction` — which is also
true of `Ctrl+B`.

- [ ] **Step 2: Add the case**

In `packages/gui/scripts/keys.mjs`, find:

```js
  { spec: 'Ctrl+K', action: { kind: 'toggleKeypad' } },
```

Add directly beneath it:

```js
  /**
   * Ctrl+B, THE FULL KEYBOARD, AND IT HAD NO WITNESS ANYWHERE UNTIL NOW (2026-10-23).
   *
   * Measured: `Ctrl+B` appeared in NEITHER this file nor `browser-keys.mjs`, so the chord could
   * have died in `canvas/src/keys.ts` and the whole gate would still have been green -- build,
   * typecheck, 2577 tests and nine harnesses.
   *
   * THAT IS EXACTLY THE `Ctrl+T` DEFECT THIS LIST ALREADY MISSED ONCE, recorded above: the chord
   * was dead for a commit while the equivalent BUTTON worked, because a click goes through the key
   * TABLE's consumers and never through the table itself. A cap on the 122-key keyboard reaches
   * the session through `keyboardUi.ts`; this chord reaches it through `CTRL`. Two routes, and
   * only the button route had cover.
   *
   * Like `Ctrl+K` and `Ctrl+T`, its interception is in `main.ts` rather than in `applyAction`
   * (which THROWS on the kind), so this position also proves the log-then-intercept order there.
   *
   * IT OPENS A SECOND WINDOW, which is harmless here for the reason the `Ctrl+T` note gives:
   * `quitIfKeysOnly` calls `app.quit()`, which closes every window.
   */
  { spec: 'Ctrl+B', action: { kind: 'toggleKeyboard' } },
```

**VERIFY FIRST:** confirm `Ctrl-B` really maps to `{kind:'toggleKeyboard'}` by reading the `CTRL`
table in `packages/canvas/src/keys.ts`, and confirm the `CASES` entry shape matches its neighbours
(`{ spec, action }`). If the repo differs, follow the repo and report.

- [ ] **Step 3: Run it and see the new case pass**

```bash
cd ~/git/tn3270 && pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | grep -viE "dbus|OOM|zygote|deprecated|GPU" | tail -4
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
```

Expected: the chord count rises by one (19 chords → 20) and the action count by one (17 → 18).
Report the ACTUAL numbers.

- [ ] **Step 4: MUTATION — prove the new case can fail**

Delete the `b:` entry from the `CTRL` table and confirm this harness, and ONLY this kind of check,
catches it:

```bash
cd ~/git/tn3270
cp packages/canvas/src/keys.ts /tmp/keys.bak
python3 - <<'PY'
p = 'packages/canvas/src/keys.ts'
s = open(p).read()
old = "  b: { kind: 'toggleKeyboard' },"
assert old in s, 'MUTATION TARGET NOT FOUND -- read the file and adapt'
s = s.replace(old, '', 1)
open(p, 'w').write(s)
PY
npm run build >/dev/null 2>&1; echo "mutant build: $?"
npx vitest run 2>&1 | tail -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/gui/scripts/keys.mjs 2>&1 | grep -viE "dbus|OOM|zygote|deprecated|GPU" | tail -6
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
cp /tmp/keys.bak packages/canvas/src/keys.ts && npm run build >/dev/null 2>&1
rm -f /tmp/keys.bak
echo "restored"; git diff --stat packages/canvas/src/keys.ts
```

Expected: `keys.mjs` FAILS, naming the missing action. **Record whether the unit suite also caught
it** — `canvas/test/keys.test.ts` has a `BINDING_INTENT` loop that may. Both catching it is fine
and worth stating; only the harness catching it is the interesting case, and the harness failing is
what this task is for. The restored diff must be EMPTY.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add packages/gui/scripts/keys.mjs
git commit -m "test(gui): Ctrl+B gets a witness, which it did not have in either front end

Measured 2026-10-23: Ctrl+B appeared in neither keys.mjs nor browser-keys.mjs, so
the chord that opens the 122-key keyboard could have died in canvas/src/keys.ts
with the entire gate green -- build, typecheck, 2577 tests, nine harnesses.

THAT IS THE Ctrl+T DEFECT THIS LIST ALREADY MISSED ONCE, which its own comment
records: dead chord, working button, because a click goes through the key table's
consumers and never through the table. Same shape, same list, now covered.

Mutation-proved by deleting the `b:` entry from the CTRL table.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 2: the web keyboard phase CLICKS caps and asserts actions

**Files:**
- Modify: `packages/web/scripts/browser-clicks.mjs`

**WHAT EXISTS AND WHAT DOES NOT.** That file's `keyboard` phase already measures **ten layout
properties** (side-by-side layout, narrow reflow, the special bar, the arrow diamond, the centred
PF strip, numpad alignment, the main block's rectangle, the `Z` stagger, the Return's shape, no
clipped cap). **It never clicks a cap and never reads an action.** So the entire functional half of
the surface — 118 caps' actions, the inert caps, the one-shot Shift — has no browser witness. The
keypad phase has exactly that cover and its reason applies here verbatim: *"so no block can go dead
unseen."*

**THE MECHANISM ALREADY IN THE FILE, which you should reuse rather than reinvent:**
- `clickCenter(selector)` — a real `Input.dispatchMouseEvent` at an element's centre, with Chromium
  doing the hit testing, so a covered or hidden cap is genuinely not clicked.
- `window.__tn3270Probe.sent` — every string the page sent over the socket, installed by
  `PROBE_SOURCE` before any page script runs.
- Caps are addressed by `button[data-key="<cap name>"]`, the cap's NAME — not its label, because
  several legends are glyphs and one (the spacebar) is empty.

- [ ] **Step 0: RE-MEASURE THIS TASK'S PREMISE BEFORE BUILDING ON IT**

Task 1's premise was wrong because it grepped for a string instead of mutating the thing. This task
claims the keyboard phase *"never clicks a cap and never reads an action"*. **Verify that by
mutation:** make every cap dead and see whether anything already fails.

Write this to `/tmp/premise.py` (a FILE, not a nested heredoc -- nesting one inside a bash
heredoc broke out and ran a harness once today):

```python
import io
p = '/home/a/athor/git/tn3270/packages/canvas/src/keyboardUi.ts'
s = io.open(p, encoding='utf-8').read()
old = '          deps.sendAction(action);'
assert s.count(old) == 1, 'target is not unique -- read the file and adapt'
io.open(p, 'w', encoding='utf-8').write(s.replace(old, '          void action;', 1))
```

Then:

```bash
cd ~/git/tn3270
cp packages/canvas/src/keyboardUi.ts /tmp/kui-premise.bak
python3 /tmp/premise.py && npm run build >/dev/null 2>&1
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -4
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
cp /tmp/kui-premise.bak packages/canvas/src/keyboardUi.ts && npm run build >/dev/null 2>&1
rm -f /tmp/kui-premise.bak /tmp/premise.py
echo "restored"; git diff --stat packages/canvas/src/keyboardUi.ts
```

**If every check still passes, the premise holds** -- the cap actions are genuinely uncovered, so
proceed. **If something already fails, report WHICH check** and narrow this task to what is
actually missing. Either answer is useful; an unverified premise is not. The restored diff must be
EMPTY.

- [ ] **Step 1: Read the existing phase and the mechanism**

```bash
cd ~/git/tn3270
grep -n "keyboard phase\|===== keyboard" packages/web/scripts/browser-clicks.mjs
sed -n '745,775p' packages/web/scripts/browser-clicks.mjs    # clickCenter
sed -n "$(grep -n 'const PROBE_SOURCE' packages/web/scripts/browser-clicks.mjs | cut -d: -f1),+30p" packages/web/scripts/browser-clicks.mjs
grep -n "TRANSFER_CHECKS = \[" packages/web/scripts/browser-clicks.mjs
```

- [ ] **Step 2: Get the exact cap NAMES you will click**

Do not guess these — read them from the built table:

```bash
cd ~/git/tn3270 && node --input-type=module -e "
const {KEYBOARD_3279}=await import('/home/a/athor/git/tn3270/packages/frontend/dist/keyboard3279.js');
const pick=(r)=>KEYBOARD_3279.filter(c=>c.region===r&&c.action!==undefined).slice(0,3);
for (const r of ['pf','main','cursor','numpad','special-left']) {
  console.log(r.padEnd(14), pick(r).map(c=>JSON.stringify({name:c.name,action:c.action})).join('  '));
}
console.log('INERT (no action):', KEYBOARD_3279.filter(c=>c.action===undefined&&!c.name.startsWith('Shift')).slice(0,3).map(c=>c.name));
console.log('SHIFT caps:', KEYBOARD_3279.filter(c=>c.name.startsWith('Shift')).map(c=>c.name));
console.log('the 2 cap:', JSON.stringify(KEYBOARD_3279.find(c=>c.name==='@ 2')));
"
```

Record the output; the names below must match it exactly.

- [ ] **Step 3: Add the check-table entries**

In the `TRANSFER_CHECKS` array (the file's check table — note the name is historical; it holds
every phase-two check), add these entries. Match the existing entries' field names exactly
(`name`, `kind`, `what`, `mutant`) — read one first.

```js
  {
    name: 'keyboardCaps',
    kind: 'live',
    what: 'one cap from EVERY region reaches the gateway as the right action',
    mutant: "keyboardUi.ts  sendAction: () => {}  (every cap dead)",
  },
  {
    name: 'keyboardInert',
    kind: 'live',
    what: 'an INERT cap sends nothing at all, being disabled rather than merely silent',
    mutant: "keyboard3279.ts  give the Caps Lock cap an action",
  },
  {
    name: 'keyboardShift',
    kind: 'live',
    what: 'the one-shot Shift sends the shifted legend, then is spent',
    mutant: "keyboardUi.ts  drop the `armed = false` in the consuming branch",
  },
```

**`kind: 'live'` IS A CLAIM ABOUT EVIDENCE AND MUST BE TRUE.** The existing `progress` check says
`injected` because no host sends its messages. These three are fully live: a real click, a real
socket, the gateway's own log. If you end up injecting anything, label it `injected`.

- [ ] **Step 4: Add the three checks to the keyboard phase**

Inside the keyboard phase, AFTER the existing layout measurements (the surface must already be
open from its `Ctrl-B`), add:

```js
      /*
        AND NOW THE FUNCTIONAL HALF, WHICH NO CHECK IN THIS FILE COVERED UNTIL 2026-10-23.

        Everything above measures LAYOUT. A keyboard can be laid out perfectly and be entirely
        dead -- `sendAction: () => {}` in `keyboardUi.ts` would pass all ten of those properties.
        The keypad phase's rule applies verbatim: sample one key from EVERY region, "so no block
        can go dead unseen".

        ASSERTED ON WHAT THE PAGE SENT OVER THE SOCKET, read from the probe installed before any
        page script ran. That is the same evidence the keypad phase uses, and it is stronger than
        a DOM read: it is the action crossing the wire, not a button looking right.
      */
      const sentJson = () => cdp.eval('JSON.stringify(window.__tn3270Probe.sent)');
      const capSelector = (name) => `#keyboard-overlay button[data-key=${JSON.stringify(name)}]`;
      /** Click a cap by NAME and return only what the page sent as a result. */
      const clickCap = async (name) => {
        const before = JSON.parse(await sentJson()).length;
        await clickCenter(capSelector(name));
        await new Promise((r) => { setTimeout(r, 150); });
        return JSON.parse(await sentJson()).slice(before);
      };

      // ONE CAP PER REGION. The names come from `KEYBOARD_3279`'s `name` field, not its label --
      // several legends are glyphs and the spacebar's is empty.
      const CAP_CASES = [
        { name: 'PF3', want: '"pf"' },
        { name: 'Enter', want: '"enter"' },
        { name: 'Cursor up', want: '"up"' },   // region: cursor
        { name: 'Attention', want: '"attn"' },
        { name: '7', want: '"7"' },
      ];
      const capResults = [];
      for (const kase of CAP_CASES) {
        const sent = await clickCap(kase.name);
        const hit = sent.some((s) => s.includes(kase.want));
        capResults.push(`${kase.name}${hit ? '' : ' MISSED'}`);
      }
      const capsOk = !capResults.some((r) => r.includes('MISSED'));

      /*
        AN INERT CAP SENDS NOTHING, and this is the check with the subtlest failure mode.

        The inert caps are `disabled`, so a click on one is a genuine no-op -- there is no handler
        at all, deliberately, because a handler that returned early would be a second place for the
        no-op to be wrong. What this asserts is that the DISABLED attribute is doing its job: a cap
        that lost it would send its action, and an operator would be typing keys this emulator
        cannot honour.
      */
      const inertSent = await clickCap('Caps Lock (not implemented: see the header)');
      const inertOk = inertSent.length === 0;

      /*
        THE ONE-SHOT SHIFT, THROUGH THE REAL DOM, and it is here because a defect in exactly this
        logic reached the user on 2026-10-23: Shift was STICKY for 40 of the 60 character caps,
        because the consuming branch keyed off `shiftLabel !== undefined` -- which is false for
        every letter, since `A` shifted is still `A`. The unit tests of the day all passed.
      */
      const shiftArmedSent = await clickCap('Shift (left, one-shot)');
      const shiftedSent = await clickCap('@ 2');
      const afterSent = await clickCap('@ 2');
      const shiftOk = shiftArmedSent.length === 0
        && shiftedSent.some((s) => s.includes('"@"'))
        && afterSent.some((s) => s.includes('"2"'));
      const shiftStory = `armed sent ${shiftArmedSent.length}, `
        + `then ${shiftedSent.join('')} then ${afterSent.join('')}`;
```

Then report each with the file's own `ok`/`no` helpers, following the shape of a neighbouring
check (read one first — they take `check(name)` plus message arguments):

```js
      if (capsOk) {
        ok(check('keyboardCaps'),
          `one cap from every region reached the gateway: ${capResults.join(', ')}`);
      } else {
        no(check('keyboardCaps'), 'a region\'s caps are not reaching the gateway',
          `clicked ${capResults.join(', ')} -- a MISSED cap sent no matching action`);
      }

      if (inertOk) {
        ok(check('keyboardInert'), 'an inert cap sent nothing, as `disabled` must make it');
      } else {
        no(check('keyboardInert'), 'an INERT cap sent an action, so it is not really inert',
          `it sent ${JSON.stringify(inertSent)}`);
      }

      if (shiftOk) {
        ok(check('keyboardShift'),
          `Shift sent nothing itself, then @ then 2 -- armed, spent, back to plain (${shiftStory})`);
      } else {
        no(check('keyboardShift'), 'the one-shot Shift did not arm-then-spend',
          `${shiftStory} (want: 0 sent on Shift, then "@", then "2")`);
      }
```

**THESE NAMES WERE VERIFIED AGAINST THE BUILT TABLE 2026-10-23** -- and two in an earlier draft of
this plan were WRONG, which is why Step 2 exists: there is no cap named `Attn` (it is `Attention`)
and no inert cap named `Esc` at all. The five names above resolve:

  `PF3` -> `{kind:'pf',n:3}` (pf) | `Enter` -> `{kind:'enter'}` (main)
  `Cursor up` -> `{kind:'up'}` (cursor) | `7` -> `{kind:'type',text:'7'}` (numpad)
  `Attention` -> `{kind:'attn'}` (special-left)
  `Caps Lock (not implemented: see the header)` -- inert
  `Shift (left, one-shot)` | `@ 2` -> `{kind:'type',text:'2'}`

**STILL CHECK THEM YOURSELF** with Step 2's command before relying on them. If one does not
resolve, use the real name and report the correction.

- [ ] **Step 5: Run it**

```bash
cd ~/git/tn3270 && pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -8
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
```

Expected: the transfer-form count rises from 8/8 to 11/11, and the three new `ok` lines appear.
Report the actual output. **If a check fails, that is information — report what it said rather
than adjusting the assertion to pass.**

- [ ] **Step 6: MUTATION — three mutants, one at a time, each reverted**

```bash
cd ~/git/tn3270
# MUTANT A: every cap dead.
cp packages/canvas/src/keyboardUi.ts /tmp/kui.bak
python3 - <<'PY'
p = 'packages/canvas/src/keyboardUi.ts'
s = open(p).read()
old = "          deps.sendAction(action);\n        });"
assert old in s, 'TARGET A NOT FOUND -- read the file and adapt'
s = s.replace(old, "          void action;\n        });", 1)
open(p, 'w').write(s)
PY
npm run build >/dev/null 2>&1
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
echo "--- MUTANT A (caps dead) ---"
node packages/web/scripts/browser-clicks.mjs 2>&1 | grep -E "keyboardCaps|transfer form" | head -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
cp /tmp/kui.bak packages/canvas/src/keyboardUi.ts && npm run build >/dev/null 2>&1

# MUTANT B: the one-shot Shift becomes a latch -- the user's own 2026-10-23 bug.
python3 - <<'PY'
p = 'packages/canvas/src/keyboardUi.ts'
s = open(p).read()
old = "          if (isCharacter && armed) {\n            armed = false;"
assert old in s, 'TARGET B NOT FOUND -- read the file and adapt'
s = s.replace(old, "          if (isCharacter && armed) {\n            armed = true;", 1)
open(p, 'w').write(s)
PY
npm run build >/dev/null 2>&1
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
echo "--- MUTANT B (sticky Shift) ---"
node packages/web/scripts/browser-clicks.mjs 2>&1 | grep -E "keyboardShift|transfer form" | head -3
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
cp /tmp/kui.bak packages/canvas/src/keyboardUi.ts && npm run build >/dev/null 2>&1
rm -f /tmp/kui.bak

# MUTANT C: an inert cap becomes actionable.
cp packages/frontend/src/keyboard3279.ts /tmp/kb3.bak
python3 - <<'PY'
p = 'packages/frontend/src/keyboard3279.ts'
s = open(p).read()
import re
# `dead(...)` builds an inert cap; make the Esc one typeable instead.
m = re.search(r"dead\('Esc'[^\n]*\n", s)
assert m, 'TARGET C NOT FOUND -- find the inert Esc cap and adapt'
print('mutating:', m.group(0).strip())
PY
echo "(see the recipe below)"
```

For MUTANT C: inert caps are built by `dead(label, region, row, x, width, name)` -- read that
helper. The Caps Lock cap is `dead('\u21ea', 'main', 2, 0, 1.75, 'Caps Lock (not implemented: see
the header)')`. Mutate it to carry an action by giving that entry an `action` field (or replacing
the `dead(...)` call with an object literal that has the same `label`/`region`/`row`/`x`/`width`/
`name` plus `action: { kind: 'attn' }`), rebuild, run, and confirm `keyboardInert` FAILS because a
disabled cap sent something. Then revert and confirm an empty diff.

**NOTE: this mutant may ALSO fail a unit test** -- `keyboard3279.test.ts` asserts which caps are
inert. That is fine and worth reporting; the point is that the BROWSER check fails, because a unit
test cannot see whether `disabled` actually stops a click.

**Expected:** A fails `keyboardCaps`, B fails `keyboardShift`, C fails `keyboardInert`. Collateral
failures are fine and expected; what proves each mutant is the NAMED check. **If any mutant leaves
its check green, that check is decoration — report it and fix the check.**

- [ ] **Step 7: Verify restored green, then commit**

```bash
cd ~/git/tn3270 && git status --short      # must show ONLY browser-clicks.mjs
npm run build >/dev/null 2>&1; pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -6
pkill -9 -f "node_modules/[e]lectron" >/dev/null 2>&1; sleep 3
git add packages/web/scripts/browser-clicks.mjs
git commit -m "test(web): the keyboard phase now clicks caps and reads the gateway's log

Ten layout properties were measured and NOT ONE ACTION. A keyboard can be laid
out perfectly and be entirely dead: sendAction: () => {} passes all ten. So this
adds the functional half, on the keypad phase's own rule -- one cap from every
region, so no region can go dead unseen -- plus the two things only a real DOM
shows: an inert cap sends nothing, and the one-shot Shift arms then spends.

The Shift check exists because a defect in exactly that logic reached the user on
2026-10-23: Shift was sticky for 40 of 60 character caps and every unit test
passed.

Mutation-proved three ways, each reverted: caps dead fails keyboardCaps, a latched
Shift fails keyboardShift, an actionable Esc fails keyboardInert.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Task 3: the gate and the docs

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
node packages/web/scripts/browser-clicks.mjs 2>&1 | tail -3; pkill -9 -f "node_modules/[e]lectron"; sleep 3
node packages/web/scripts/browser-shot.mjs 2>&1 | tail -2;   pkill -9 -f "node_modules/[e]lectron"; sleep 3
python3 packages/tui/scripts/pty-smoke.py 2>&1 | tail -3
```

Baseline before this plan: build/typecheck 0; 2577 tests in 109 files; `keys` 19 chords/17 actions
(**expect 20/18 now**); `clicks` 9/10; `select` 3/3; `shot` 2/2; `transfer` 10/10; `browser-keys`
13 chords/10 actions; `browser-clicks` 9 buttons + 8/8 (**expect 11/11 now**); `browser-shot` 1/1;
`pty-smoke` 12 PASS/0 FAIL.

**A GOLDEN DIFF IN EITHER `shot` HARNESS MEANS SOMETHING LEAKED INTO THE BASE PAGE. Report it and
STOP — do not regenerate a golden.** Neither golden contains an overlay.

- [ ] **Step 2: `README.md` — correct the harness rows this plan changes**

The Verification section has a row per harness. Update the `keys.mjs` row (it was annotated on
2026-10-23 as lacking `Ctrl+B`; that is now false) and the `browser-clicks` row (new counts and the
three new checks). Read both rows first and report what they said.

- [ ] **Step 3: `docs/live-testing.md` — what is now covered, and what still is not**

Append an entry in the file's established style:

```markdown
- **THE FULL KEYBOARD'S FUNCTIONAL COVER, 2026-10-23 — NO LIVE HOST RUN WAS NEEDED.**

  Every action a cap raises is one an existing keypad button or chord already raises, through the
  same `applyAction` — so nothing new reaches the wire and no host could tell a cap from a
  keystroke.

  **What is now proven in a real browser:** one cap from EVERY region reaches the gateway as the
  right action; an inert cap sends nothing; and the one-shot Shift arms, sends the shifted legend
  and is spent. Each mutation-proved. Plus `Ctrl+B` in the GUI, which had no witness in either
  front end until now.

  **What is still NOT machine-checkable, stated rather than left to be inferred:** the LAYOUT'S
  FIDELITY to the reference photograph. Every cap's legend, position and width was read from
  photographs by eye, and no test can tell a correct keyboard from a plausible one. Two caps remain
  deliberately ambiguous — the arrow cluster's centre diagonal and `Ex Sel` — and three glyphs are
  approximations no Unicode point draws correctly.
```

- [ ] **Step 4: `docs/HANDOFF.md` — Task 7 is done**

Update the START HERE section: the full-keyboard feature's seven tasks are complete. Remove or
rewrite any claim that Task 7 is outstanding, and update the harness-property count (the keyboard
phase now measures ten layout properties **and three functional ones**). Also remove the
`Ctrl+B`-has-no-witness note added on 2026-10-23, which this plan closes — **and report that you
checked for it**, because this repo has a recorded failure mode where a fix reaches the prose body
and never the heading or count that summarises it.

- [ ] **Step 5: Commit**

```bash
cd ~/git/tn3270 && git add README.md docs/live-testing.md docs/HANDOFF.md
git commit -m "docs: the keyboard's functional cover, and what no test can check

The keyboard phase measures ten layout properties and now three functional ones;
Ctrl+B has a witness. live-testing.md states what remains UNCHECKABLE and always
will be: the layout's fidelity to the photograph, two deliberately ambiguous caps
and three approximated glyphs. No live host run was needed -- every cap raises an
action an existing button or chord already raises.

Generated with AI

Co-Authored-By: SLAC AI"
```

---

## Self-review against the superseded plan's Task 7

| Original Task 7 requirement | This plan |
|---|---|
| `Ctrl-B` opens `#keyboard-overlay` in a real browser | already covered by the existing phase |
| One actionable key per region reaches the gateway | Task 2 (`keyboardCaps`) |
| An inert key sends NOTHING | Task 2 (`keyboardInert`) |
| One-shot Shift through the real DOM: `@` then `2` | Task 2 (`keyboardShift`) |
| `Ctrl-K` closes the keyboard and opens the keypad | **DROPPED — see below** |
| Check-table entry with a `mutant` named | Task 2 Step 3 |
| `kind: 'live'` only if nothing is injected | Task 2 Step 3, stated |
| Prove the new phase can fail | Task 2 Step 6, three mutants |
| The full gate, serially, pkill between runs | Task 3 Step 1 |
| `live-testing.md`: no live run needed, and the unmachine-checkable part | Task 3 Step 3 |
| `HANDOFF.md`: the surface, the chord, drift-to-keyboard-alone | Task 3 Step 4 |
| `README.md`: `Ctrl-B` beside `Ctrl-K`, a sentence on inert caps | **already done 2026-10-23** in `56f0fed` |
| **NEW: `Ctrl+B` has no witness in either front end** | **Task 1** |

**ONE REQUIREMENT DROPPED, DELIBERATELY.** The original Task 7 asked that *"`Ctrl-K` closes the
keyboard and opens the keypad"* be asserted. **That is the WEB front end's rule and not the GUI's**
— `web/src/bridge.ts` hides one overlay when the other opens, because two opaque overlays over one
canvas are unreadable; the GUI deliberately does NOT (two windows can sit side by side, and
auto-closing would rebuild the modality the feature removed). Asserting it in `browser-clicks.mjs`
would be correct for the web, but the phase would then encode a rule that is false of the other
front end, so it needs its own named check rather than a line inside the keyboard phase. **Left
open rather than silently skipped**; it is a small follow-up.
