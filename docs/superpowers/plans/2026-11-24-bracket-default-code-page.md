# The `bracket` default code page, and `-codepage` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default to x3270's `bracket` code page, and add `-codepage`/`-charset` (`bracket` or `cp037`) to the GUI, TUI, web gateway and CLI.

**Architecture:** `bracket` is a second table in core's table-driven `CodePage`. One
`DEFAULT_CODE_PAGE` constant replaces the scattered `?? cp037` fallbacks. The screen snapshot
carries its page's name so `resolve()` decodes with the session's page. Front ends parse the flag
with one shared helper in `@tn3270/frontend` and pass the page through `defaultSession`.

**Tech Stack:** TypeScript, vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-24-bracket-default-code-page-design.md`.

**THE SOURCE BEATS THIS PLAN.** Line numbers and code here were read on 2026-11-24 at `e282c28`.
Re-read every file you change before changing it. Where this plan disagrees with the repo or with
x3270 (`~/src/suite3270-4.5`), the repo and x3270 win: report the discrepancy and don't force the
plan's version.

**Build before believing tests:** vitest does not typecheck. After every task run
`npm run build && npm test` from the repo root (check `package.json` for the exact script names).

---

## Facts established while planning (2026-11-24)

- x3270's cp037 row (`Common/unicode.c:103`) equals our `CP037_TO_UNICODE` at every byte from
  0x41 to 0xFE (checked with a script; 190 entries, no differences). x3270's tables start at 0x41.
- `bracket` (`unicode.c:293`) differs from cp037 at exactly 0xAD (Ý→`[`), 0xBA (`[`→Ý),
  0xBB (`]`→¨) and 0xBD (¨→`]`). Both declare CGCSGID 37.
- **A gap the spec missed:** `render.ts:339` `resolve()` decodes cells with `opts.codePage ?? cp037`,
  and none of its callers pass a page: `gui/src/main.ts:1341, 1767, 2052, 2790, 2843, 2991`,
  `tui/src/app.ts:633`, `web/src/main.ts:296`, `cli/src/runner.ts:508`. Changing only the default
  would make a `-codepage cp037` session encode with cp037 and display with `bracket`. Task 3 fixes
  this by having the snapshot carry the page's name. It's a name, not the `CodePage` object,
  because snapshots may cross IPC, where a structured clone drops a class's methods.
- `drawlist.ts:164` maps characters back through `cp037.fromUnicode` only to find a glyph, so it
  needs no change for `bracket` (same character set). Task 4 proves it with a test.
- `defaultSession` (`frontend/src/session.ts:23`) takes positional arguments; `geometry` is last.

## Files

- Create `packages/core/src/codepages/bracket.ts`: the table.
- Modify `packages/core/src/codepage.ts`: `cgcsgid`, `bracket`, `DEFAULT_CODE_PAGE`,
  `resolveCodePage`, `CODE_PAGE_NAMES`.
- Modify `packages/core/src/screen.ts`, `keyboard.ts`, `session.ts`, `render.ts`: the defaults,
  the snapshot field and `CODEPAGE`.
- Modify `packages/core/src/index.ts` (or wherever core's exports live): export the new names.
- Create `packages/frontend/src/codepageFlag.ts`: the shared flag parser.
- Modify `packages/frontend/src/session.ts`: the `codePage` parameter.
- Modify the arg parsers and `defaultSession` callers: `packages/gui/src/args.ts`,
  `packages/tui/src/args.ts` + `main.ts`, `packages/web/src/args.ts`, `packages/cli/src/main.ts`.
- Tests: `packages/core/test/codepage.test.ts`, `newenviron.test.ts`, a new
  `packages/core/test/default-codepage.test.ts`, `packages/canvas/test/drawlist.test.ts`,
  `packages/frontend/test/codepageFlag.test.ts`, and each front end's `args.test.ts` (or
  `main.test.ts` for the TUI and CLI; find where their flag tests live).
- Docs: `README.md`, `docs/parity.md`, `docs/HANDOFF.md`, `docs/live-testing.md`, a
  `changelog.d/` fragment.

---

### Task 1: The `bracket` table, `cgcsgid`, and name resolution

**Files:** create `packages/core/src/codepages/bracket.ts`; modify `packages/core/src/codepage.ts`;
test `packages/core/test/codepage.test.ts`.

- [ ] **Step 1: Write the failing tests** (append to `codepage.test.ts`):

```ts
import { CodePage, cp037, bracket, DEFAULT_CODE_PAGE, resolveCodePage, CODE_PAGE_NAMES } from '../src/codepage.js';

// x3270's rows, pasted verbatim from suite3270 4.5 Common/unicode.c (cp037 at :103, bracket at
// :293). Each row starts at EBCDIC 0x41. Paste the full brace contents; do not retype them.
const X3270_CP037 = [/* paste unicode.c:103's 190 values */];
const X3270_BRACKET = [/* paste unicode.c:293's 190 values */];

describe('bracket', () => {
  it('matches x3270 from 0x41 to 0xFE, for both pages', () => {
    expect(X3270_CP037).toHaveLength(190);
    expect(X3270_BRACKET).toHaveLength(190);
    for (let i = 0; i < 190; i++) {
      expect(cp037.toUnicode(0x41 + i).codePointAt(0)).toBe(X3270_CP037[i]);
      expect(bracket.toUnicode(0x41 + i).codePointAt(0)).toBe(X3270_BRACKET[i]);
    }
  });

  it('differs from cp037 in exactly 0xAD, 0xBA, 0xBB and 0xBD', () => {
    const diffs: number[] = [];
    for (let b = 0; b < 256; b++) if (bracket.toUnicode(b) !== cp037.toUnicode(b)) diffs.push(b);
    expect(diffs).toEqual([0xad, 0xba, 0xbb, 0xbd]);
    expect([0xad, 0xbd].map((b) => bracket.toUnicode(b))).toEqual(['[', ']']);
    expect(bracket.encode('[]')).toEqual(new Uint8Array([0xad, 0xbd]));
  });

  it('declares CGCSGID 37, as does cp037', () => {
    expect(bracket.cgcsgid).toBe(37);
    expect(cp037.cgcsgid).toBe(37);
  });

  it('is the default', () => {
    expect(DEFAULT_CODE_PAGE).toBe(bracket);
  });
});

describe('resolveCodePage', () => {
  it.each([
    ['cp037', 'cp037'], ['cp37', 'cp037'], ['037', 'cp037'], ['37', 'cp037'], ['us', 'cp037'],
    ['us-intl', 'cp037'], ['CP037', 'cp037'], ['bracket', 'bracket'], ['oldibm', 'bracket'],
    ['bracket437', 'bracket'], ['Bracket', 'bracket'],
  ])('%s resolves to %s', (alias, canonical) => {
    expect(resolveCodePage(alias).name).toBe(canonical);
  });

  it('rejects an unknown name, listing the choices first', () => {
    expect(() => resolveCodePage('cp273')).toThrow("use one of bracket, cp037 (got 'cp273')");
  });

  it('lists the canonical names, default first', () => {
    expect(CODE_PAGE_NAMES).toEqual(['bracket', 'cp037']);
  });
});
```

Also update the existing test file's `new CodePage(...)` calls, if any, for the new constructor
argument (Step 3).

- [ ] **Step 2: Run, expect failure:** `npx vitest run packages/core/test/codepage.test.ts`. It
  should fail on the missing exports.

- [ ] **Step 3: Implement.**

`packages/core/src/codepages/bracket.ts`: generate it once rather than hand-editing. Run:

```bash
node -e '
const fs = require("fs");
const src = fs.readFileSync("packages/core/src/codepages/cp037.ts", "utf8");
const t = [...src.matchAll(/0x[0-9a-f]{4}/g)].map((m) => parseInt(m[0], 16));
if (t.length !== 256) throw new Error("cp037 table parse: " + t.length);
t[0xad] = 0x005b; t[0xba] = 0x00dd; t[0xbb] = 0x00a8; t[0xbd] = 0x005d;
const rows = [];
for (let i = 0; i < 256; i += 8)
  rows.push("  " + t.slice(i, i + 8).map((v) => "0x" + v.toString(16).padStart(4, "0")).join(", ") + ",");
fs.writeFileSync("packages/core/src/codepages/bracket.ts",
`/**
 * x3270 \x27bracket\x27 (its default code page) to Unicode.
 *
 * cp037 with [ and ] moved to 0xAD/0xBD, as suite3270 4.5 Common/unicode.c:293 has it:
 * 0xAD Y-acute->[, 0xBA [->Y-acute, 0xBB ]->diaeresis, 0xBD diaeresis->]. Generated from
 * cp037.ts by the command in docs/superpowers/plans/2026-11-24-bracket-default-code-page.md;
 * codepage.test.ts checks every byte from 0x41 to 0xFE against x3270\x27s own table.
 */

/** EBCDIC byte -> Unicode code point. */
export const BRACKET_TO_UNICODE: readonly number[] = [
${rows.join("\n")}
];
`);'
```

`codepage.ts` changes:

```ts
import { BRACKET_TO_UNICODE } from './codepages/bracket.js';

// In the class: add `readonly cgcsgid: number;` and a third constructor parameter
// `cgcsgid: number` (validate: an integer 0..0xffffffff), assigned in the constructor.

export const cp037 = new CodePage('cp037', CP037_TO_UNICODE, 37);
/** x3270's default (`Common/codepage.c:358`). CGCSGID 37, as x3270's table entry declares. */
export const bracket = new CodePage('bracket', BRACKET_TO_UNICODE, 37);

/** The page a session uses when none is chosen: x3270's default. */
export const DEFAULT_CODE_PAGE = bracket;

export const CODE_PAGES = new Map<string, CodePage>([['bracket', bracket], ['cp037', cp037]]);

/** Canonical names, default first: what `-codepage` accepts besides the aliases. */
export const CODE_PAGE_NAMES: readonly string[] = [...CODE_PAGES.keys()];

/** x3270's aliases for these two pages (`Common/unicode.c:381-422`). */
const ALIASES = new Map<string, string>([
  ['cp37', 'cp037'], ['us', 'cp037'], ['us-intl', 'cp037'],
  ['oldibm', 'bracket'], ['bracket437', 'bracket'],
]);

/** A page by canonical name or x3270 alias, ignoring case. Throws, remedy first, if unknown. */
export function resolveCodePage(name: string): CodePage {
  // All digits gets a 'cp' prefix first, so '037' -> 'cp037' and '37' -> 'cp37' -> alias
  // (x3270 canonical_codepage, Common/unicode.c:791-793; set_uni :685-687). Case is ignored
  // as set_uni's strcasecmp ignores it (:691, :702).
  const lower = name.toLowerCase();
  const key = /^[0-9]+$/.test(lower) ? `cp${lower}` : lower;
  const cp = CODE_PAGES.get(ALIASES.get(key) ?? key);
  if (!cp) throw new Error(`use one of ${CODE_PAGE_NAMES.join(', ')} (got '${name}')`);
  return cp;
}
```

Remove `getCodePage`. First check its callers: `grep -rn getCodePage packages/*/src packages/*/test`.
Move any callers to `resolveCodePage`. (Bare `037`/`37` were checked against x3270 while planning:
they're accepted through the digits rule, not as aliases.)

- [ ] **Step 4: Run, expect pass**, then `npm run build`.
- [ ] **Step 5: Export** `bracket`, `DEFAULT_CODE_PAGE`, `resolveCodePage` and `CODE_PAGE_NAMES`
  from core's package entry, wherever `cp037` is exported now. Build again.
- [ ] **Step 6: Commit:** `core: the bracket code page, its CGCSGID, and x3270's code page names`.

### Task 2: `CODEPAGE` from the CGCSGID

**Files:** modify `packages/core/src/session.ts` (the NEW-ENVIRON builder, about :810-830); test
`packages/core/test/newenviron.test.ts`.

- [ ] **Step 1: Failing tests.** Find the existing CODEPAGE assertion (around :176) and copy its
  setup. Add two cases: a default session sends `CODEPAGE` = `037`, and a session built with
  `codePage: cp037` sends `037`. Add a third with a test-only
  `new CodePage('x', CP037_TO_UNICODE, 1047)`, which must send `1047`. That's the `%d` branch, and
  it fails while the value is derived from the name.
- [ ] **Step 2: Run, expect the default and 1047 cases to fail** (they would send `bracket` and
  `x`).
- [ ] **Step 3: Implement.** Replace the name-stripping with:

```ts
// x3270: cgcsgid & 0xffff, %03d under 100 else %d (telnet_new_environ.c:255-260).
const cp = (this.opts.codePage ?? DEFAULT_CODE_PAGE).cgcsgid & 0xffff;
m.set('CODEPAGE', cp < 100 ? String(cp).padStart(3, '0') : String(cp));
```

Rewrite the long comment above it. It now says the value comes from `CodePage.cgcsgid`, and the
"we have no cgcsgid field" text is false. Keep the CHARSET paragraph, but change its reason: we now
hold only the CPGID half that x3270 sends as CODEPAGE, not the GCSGID half CHARSET needs.

- [ ] **Step 4: Run, pass; build.**
- [ ] **Step 5: Commit:** `core: NEW-ENVIRON CODEPAGE comes from the page's CGCSGID, as x3270's`.

### Task 3: One default, and the snapshot carries its page

**Files:** modify `packages/core/src/screen.ts` (:2, :97, :172, the `ScreenSnapshot` interface at
:77 and `snapshot()` at :602), `keyboard.ts` (:1, :33), `session.ts` (:22, :507), `render.ts`
(:69, :339); create `packages/core/test/default-codepage.test.ts`.

- [ ] **Step 1: Failing tests** in `default-codepage.test.ts`. Use the repo's existing helpers for
  building a `Session` or `Screen` and typing a character (look at `keyboard.test.ts` and
  `render.test.ts` for the pattern; don't invent new helpers):
  1. A default `Screen` + `Keyboard`: typing `[` stores 0xAD in the cell, and `]` stores 0xBD.
  2. The same with `codePage: cp037`: 0xBA and 0xBB.
  3. `resolve(screen.snapshot())` on a default screen whose cell holds 0xAD gives text `[`.
  4. `resolve(screen.snapshot())` on a `codePage: cp037` screen whose cell holds 0xBA gives `[`.
     This is the gap from *Facts*: **no `codePage` passed to `resolve`.**
  5. `screen.snapshot().codePage` is `'bracket'` by default and `'cp037'` with cp037.
  6. A snapshot without `codePage` (the literal fixtures tests build) resolves with the default.
- [ ] **Step 2: Run, expect 1, 3, 4 and 5 to fail.**
- [ ] **Step 3: Implement.**
  - In `screen.ts`, `keyboard.ts` and `session.ts`, replace each `cp037` fallback with
    `DEFAULT_CODE_PAGE`, and drop the `cp037` imports that become unused.
  - Add `codePage?: string` to `ScreenSnapshot`, documented as the canonical name of the page that
    decodes `cells`. It's a name, not the object, because a snapshot crosses IPC. It's optional so
    hand-built test snapshots stay valid. `snapshot()` sets it to `this.codePage.name`.
  - In `render.ts:339`:
    `const codePage = opts.codePage ?? (snap.codePage !== undefined ? CODE_PAGES.get(snap.codePage) : undefined) ?? DEFAULT_CODE_PAGE;`
  - Check for snapshot equality tests that now see an extra field
    (`grep -rn "snapshot()).toEqual" packages`), and fix them so they include `codePage`, not so
    they ignore it.
- [ ] **Step 4: Run the whole suite and build.** Expect failures in existing tests that typed or
  decoded `[`/`]` assuming cp037. Read each failure. If it asserts cp037 bytes as the default
  behaviour, change the expectation to `bracket`'s. If it's about cp037 itself, give the test
  `codePage: cp037`. Record the list of changed tests in the commit message.
- [ ] **Step 5: Commit:** `core: bracket is the default code page, and resolve() decodes with the snapshot's page`.

### Task 4: Prove the canvas needs no change

**Files:** test `packages/canvas/test/drawlist.test.ts`.

- [ ] **Step 1: Write the test.** Build a default (bracket) screen with cells 0xAD, 0xBA, 0xBB,
  0xBD. Produce its draw list the way the existing tests in that file do. Assert that the four
  glyph columns equal `column(atlas, ebcdicToCg(b))` for cp037's bytes for `[`, Ý, ¨ and `]`
  (0xBA, 0xAD, 0xBD, 0xBB), i.e. the glyphs for those characters, not for the bracket bytes. Then
  check the test can fail: temporarily change `drawlist.ts:164` to use
  `ebcdicToCg(bracket.fromUnicode(...))` and run it. The test must fail before you revert.
- [ ] **Step 2: Run, expect pass on the real code.**
- [ ] **Step 3: Commit:** `canvas: test that bracket text draws the right glyphs through the cp037 glyph path`.

### Task 5: The shared flag parser and `defaultSession`

**Files:** create `packages/frontend/src/codepageFlag.ts`, test
`packages/frontend/test/codepageFlag.test.ts`; modify `packages/frontend/src/session.ts` and
frontend's export list.

- [ ] **Step 1: Failing tests:**

```ts
import { describe, it, expect } from 'vitest';
import { cp037, bracket } from '@tn3270/core';
import { codePageFlag } from '../src/codepageFlag.js';

const err = (m: string) => new Error(`usage: ${m}`);

describe('codePageFlag', () => {
  it('resolves names and aliases', () => {
    expect(codePageFlag('-codepage', 'cp037', err)).toBe(cp037);
    expect(codePageFlag('-charset', 'oldibm', err)).toBe(bracket);
  });
  it('a missing value names the flag and the choices', () => {
    expect(() => codePageFlag('-codepage', undefined, err))
      .toThrow('usage: -codepage needs a value: bracket, cp037');
  });
  it('an unknown name puts the remedy first, through the caller\'s error type', () => {
    expect(() => codePageFlag('-charset', 'cp273', err))
      .toThrow("usage: -charset: use one of bracket, cp037 (got 'cp273')");
  });
});
```

Also a `defaultSession` test, in `frontend/test/session.test.ts` following its existing pattern:
passing `cp037` as the new last argument makes the session's screen snapshot report
`codePage: 'cp037'`, and omitting it reports `'bracket'`.

- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement:**

```ts
// packages/frontend/src/codepageFlag.ts
import { resolveCodePage, CODE_PAGE_NAMES, type CodePage } from '@tn3270/core';

/**
 * `-codepage NAME` / `-charset NAME` (x3270.c:156, :159). The error factory is injected because
 * each front end has its own `UsageError` (as `takeTlsFlag` in `tls.ts` does).
 */
export function codePageFlag(flag: string, value: string | undefined,
  usageError: (m: string) => Error): CodePage {
  if (value === undefined) throw usageError(`${flag} needs a value: ${CODE_PAGE_NAMES.join(', ')}`);
  try {
    return resolveCodePage(value);
  } catch (e) {
    throw usageError(`${flag}: ${(e as Error).message}`);
  }
}
```

In `defaultSession`, add a last parameter `codePage?: CodePage` with a doc comment (absent means
core's default, `bracket`), and `...(codePage === undefined ? {} : { codePage }),` in the options.
Export `codePageFlag` from frontend's entry.

- [ ] **Step 4: Run, pass; build.**
- [ ] **Step 5: Commit:** `frontend: the shared -codepage parser, and defaultSession takes a code page`.

### Task 6: The flag in each front end

**Files:** `packages/gui/src/args.ts` (flag switch about :103-200, usage string :93, the
`defaultSession` calls :268-276), `packages/tui/src/args.ts` (:56, :193) and `main.ts`
(:62-69, usage :123), `packages/web/src/args.ts` (:99, :168, :227, :323, :356), `packages/cli/src/main.ts`
(:45, :137, :185-192, and its usage text), with their tests.

Do one front end per commit, each the same way:

- [ ] **Step 1: Failing tests** in that front end's existing args tests:
  - `-codepage cp037` sets `codePage` to `cp037`.
  - `-charset bracket` sets it to `bracket`.
  - The flag absent leaves `codePage` undefined.
  - `-codepage cp273` throws that front end's `UsageError` with the remedy-first message.
  - The usage/`--help` text contains `-codepage NAME`.
  - The built session's snapshot reports the page, if that front end's tests already build a
    session from args (the GUI's do, at `args.ts:268`). Otherwise skip this one.
- [ ] **Step 2: Run, expect failure.**
- [ ] **Step 3: Implement.** Add a `codePage?: CodePage` field to the args type. In the switch:

```ts
      case '-codepage':
      case '-charset':
        args.codePage = codePageFlag(flag, value, (m) => new UsageError(m));
        i++;
        break;
```

The web parser uses `value(args, i, a)` and local `let`s. Follow its local style, with the same
helper. Pass `args.codePage` as `defaultSession`'s last argument at every call. Where a call
doesn't pass `geometry`, pass `undefined` before it. Add `[-codepage NAME]` to the usage string
next to `-devname`.
- [ ] **Step 4: Run, pass; build.**
- [ ] **Step 5: Commit:** `<frontend>: -codepage and -charset select the host code page`.

After all four: run `node dist/...` for each front end with `-codepage nope` (find the entry
points in each package's `package.json` `bin`). Check by eye that each exits non-zero with the
remedy-first line.

### Task 7: Mutation check

- [ ] Do each of these by hand, run the suite, and confirm the result. Revert after each.
  1. `DEFAULT_CODE_PAGE = cp037` → Task 1 and Task 3 tests fail.
  2. Each of the three `DEFAULT_CODE_PAGE` fallbacks in screen/keyboard/session, set back to `cp037`
     one at a time → a Task 3 test fails for each. If one survives, the test for that site is
     missing: write it.
  3. In `resolve()`, drop the `snap.codePage` lookup → Task 3 test 4 fails.
  4. Delete the `oldibm` alias → a `resolveCodePage` case fails.
  5. `CODEPAGE` back to name-derived → Task 2 fails.
  6. One front end's `case '-charset':` deleted → its test fails.
- [ ] Record the results (mutation, killed by) in the HANDOFF entry. Commit any new tests:
  `test: kill the code page mutation survivors`.

### Task 8: Docs and parity

- [ ] `README.md`: in 15a's text, mark the code page item done (default `bracket`, `-codepage`).
  Move the `cg.ts` remark into 15c's text. Add `-codepage NAME` (alias `-charset`) to each front
  end's flag table and the *Using …* sections, wherever `-devname` is listed. Then grep
  `README.md` for `cp037` and fix every sentence that says it's the default or the only page,
  including any summary or heading line.
- [ ] `docs/parity.md:101` (`code-page`): rewrite *ours* to describe the new behaviour. Leave the
  status for Task 9's witness, then run `node scripts/parity.mjs gate` (check the script name in
  `scripts/`) and note the count.
- [ ] A `changelog.d/` fragment, in the format of the existing ones (look at one; they come from
  scriv): x3270's `bracket` is now the default code page, so `[` and `]` are 0xAD/0xBD at the
  defaults; `-codepage cp037` restores the old bytes.
- [ ] `docs/HANDOFF.md`: a new LATEST entry at the top.
- [ ] Commit: `docs: the bracket default code page and -codepage`.

### Task 9: Live witness on VM/370 (needs the user; VM/370 must be up)

- [ ] With the GUI at the defaults, log on to CMS, then `EDIT CPTEST DATA A`. Input a line that is
  exactly `[]` and FILE it. Receive it binary with no translation. Use the frontends' receive
  with the binary option; check `docs/live-testing.md` for the exact syntax used before. Then
  `od -An -tx1` the local file. Expect `ad bd`.
- [ ] Repeat with `-codepage cp037` into `CPTEST2 DATA A`. Expect `ba bb`.
- [ ] As a cross-check that the screen agrees, `TYPE CPTEST DATA A` in each session. Each should
  show `[]`, and the other page's file should show Ý¨. That proves the display decodes with the
  session's page (Task 3's gap), live.
- [ ] Record both in `docs/live-testing.md` with the hexdumps. Set `code-page` to `ours` in
  `docs/parity.md`, rerun the gate and record the count. Commit:
  `docs: the bracket code page witnessed on VM/370`.
