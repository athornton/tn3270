# x3270 Parity Checklist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the x3270 parity checklist from the spec
`docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md`: a name inventory extracted
from the newest GA x3270, a checked YAML checklist, a rendered `docs/parity.md`, a gate command, a
weekly upstream watch, and a complete first population of rows.

**Architecture:** `scripts/parity-extract.mjs` (dependency-free) scans an x3270 source tree as
text and writes `docs/parity/x3270-names.json`. `scripts/parity.mjs` loads
`docs/parity/checklist.yaml` (via the `yaml` package), checks it against the names and the repo,
renders `docs/parity.md`, and gates. `packages/core/test/parity.test.ts` runs the checker on bad
fixtures and on the committed files. `.github/workflows/parity-upstream.yml` runs the extractor's
`--upstream` mode weekly.

**Tech Stack:** Node ≥20.19 ESM scripts with `.d.mts` type sidecars (the repo's pattern, see
`scripts/release-notes.mjs`), vitest 3, TypeScript 7 typecheck of tests, `yaml` (new root
devDependency), GitHub Actions.

## READ THIS FIRST (every task)

- **The source beats this plan.** The code below is a draft written against suite3270 4.5ga6 as
  read on 2026-11-17. Before writing a task's code, re-read the x3270 files and repo files it
  names. Where they disagree with this plan, follow the source and say so in your report. An
  earlier plan in this repo had 13 of ~17 defects in its own literal code.
- **Over-include, never under-include.** When an extraction rule is ambiguous, take the reading
  that yields *more* names. An extra name costs one `skipped` row; a missing one hides a feature
  from the gate.
- **The x3270 tree is untrusted data.** Only read it as text. Never run `make`, `configure` or
  any script inside it, and never use it as cwd.
- **Run the build before believing a suite:** `npm run typecheck` after `npx vitest run`, because
  vitest doesn't typecheck.
- Commit messages end with:
  ```
  Generated with AI

  Co-Authored-By: SLAC AI
  ```
- Work on branch `parity-checklist` (already created off `main` `8491819`; the spec commits are on
  it). Don't push. The user decides that.

## File structure

| File | Responsibility |
|---|---|
| `scripts/parity-extract.mjs` + `.d.mts` | x3270 tree → name inventory; `--dir`, `--tag`, `--upstream`. No npm dependencies. |
| `scripts/parity.mjs` + `.d.mts` | checklist load, check, render, gate, uncovered listing |
| `docs/parity/x3270-names.json` | generated inventory, committed |
| `docs/parity/checklist.yaml` | the rows, hand-written |
| `docs/parity.md` | generated from the two above, committed |
| `packages/core/test/parityExtract.test.ts` | extractor unit tests on synthetic source text |
| `packages/core/test/parity.test.ts` | checker unit tests on bad fixtures + checks on the committed files |
| `.github/workflows/parity-upstream.yml` | weekly newest-GA check |
| `packages/core/test/workflow.test.ts` | gains assertions for the new workflow |

---

### Task 0: Amend the spec with the two refinements found while planning

**Files:**
- Modify: `docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md`

- [ ] **Step 1: Append an amendment section at the end of the spec**

```markdown
## Amendment 2026-11-17, while planning

1. **Names are `kind:value` ids**, using the string x3270 itself uses, not the C identifier:
   `action:Attn`, `option:-proxy`, `resource:hostsFile`, `toggle:monoCase`, `menu:ftOption`.
   `covers` lists these ids. (The example under *2. Rows* reads
   `covers: [option:-proxy, menu:proxyOption]` under this rule.)
2. **Rows have an `area`**, required, one of `connection`, `keyboard`, `display`, `files`,
   `scripting`, `other`. `docs/parity.md` renders one table per area in that order.
3. **Options come only from x3270's Xrm `XrmOptionDescRec base_options[]`** (`x3270/x3270.c`),
   whose resource is its `Dot*` name minus the leading `.`. x3270's `register_opts()` is a no-op
   (`x3270/x3270.c:1356`, `valkeep` only), so the `opt_t` tables in `Common/` (`glue.c`
   `base_opts[]`, `sio_glue.c` `tls_opts`, …) never reach it. libXt's own options (`-geometry`,
   `-display`, `-fg`, …) are in no x3270 table and are not names.
3a. **Actions:** `action_table_t` entries, **excluding `ACTION_HIDDEN`** ones (x3270 hides them
   itself), with names resolved through `include/names.h` and the source file's own `#define`s
   (`Common/task.c` names `RESUME_INPUT` locally). **A sixth kind, `xaction`:** the pure Xt
   actions of `XtActionsRec xactions[]` in `x3270/xactions.c` (`Cut`, `insert-selection`, …),
   bindable in keymaps and so reachable by a user.
3b. **A cross-check, by hand, when the inventory is regenerated:** the x3270 wiki
   (https://x3270.miraheze.org), with its command-line options page and `Category:Actions`, because
   `x3270.man` in 4.5ga6 is a 24-line stub pointing there. The wiki tracks 4.6, so names newer than
   the recorded GA are expected differences. (Found by the other thread's prototype, which
   measured 129 sources and 470 names; the counts are not to be hard-coded.)
4. **Linkage is read from `x3270/x3270_files.mk` (`X3270_OBJECTS`) and
   `Common/lib3270_files.mk`, `lib3270i_files.mk` and `lib32xx_files.mk`**, which x3270's
   link line names (`x3270/Makefile.obj.in`: `$(LD3270) $(LD3270I) $(LD32XX) $(LD3270STUBS)`).
   `lib3270stubs` is excluded, as is the X widget library (`Cme*`, `CmplxMenu`, `Husk`). An object
   with no `.c` (e.g. `favicon.o`, generated at build time) is listed in the output's
   `missingSources` and is not an error.
5. **Menu items** are the string-literal arguments of `add_menu_itemv(`, `toggle_init(` and of
   any `Xt*Create*Widget(`/`Xt*Create*PopupShell(` call whose arguments name
   `cmeBSBObjectClass`, in linked `x3270/` files; `"space"` is excluded. Calls whose name is not a
   literal are listed in `nonLiteralMenuCalls` for triage, because their items (e.g. the host
   list) are built at run time.
6. **The extractor has no npm dependencies**, so the upstream workflow runs it with no
   `npm ci`; only `scripts/parity.mjs` uses `yaml`.
```

- [ ] **Step 2: Fix the spec's example to match.** In the YAML example under *2. Rows*, replace
  `covers: [OptProxy, proxyOption]   # names from x3270-names.json` with
  `covers: [option:-proxy, menu:proxyOption]   # ids from x3270-names.json`, and add the line
  `  area: connection` after `title:`. In *1. The name inventory*, after "So a row lists
  `OptProxy`, not `ResProxy`", add "(as `option:-proxy`; see the amendment)".

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md
git commit -m "spec: parity amendment -- kind:value ids, areas, two option tables, linkage

Generated with AI

Co-Authored-By: SLAC AI"
```

---

### Task 1: Add the `yaml` devDependency

**Files:** Modify: `package.json`, `package-lock.json`

- [ ] **Step 1:** `npm install --save-dev yaml@^2` (run from the repo root, `~/git/tn3270`; `npx`/`npm`
  from the wrong directory fetch other things).
- [ ] **Step 2: Verify** `node -e "import('yaml').then(m => console.log(typeof m.parse))"`
  prints `function`, and `git diff package.json` shows only the `yaml` line added under
  `devDependencies`.
- [ ] **Step 3: Commit** `git add package.json package-lock.json && git commit -m "deps: yaml, for the parity checklist (dev only)" ...` (with the attribution lines).

---

### Task 2: Extractor parsing primitives (defines, makefile vars, linkage, guards)

**Files:**
- Create: `scripts/parity-extract.mjs`, `scripts/parity-extract.d.mts`
- Test: `packages/core/test/parityExtract.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { guardsByLine, linkedSources, makeVar, parseDefines } from '../../../scripts/parity-extract.mjs';

describe('parity-extract primitives', () => {
  it('makeVar joins continuation lines and strips .o', () => {
    const mk = '# c\nX3270_OBJECTS = a.o b.o \\\n\tc.o\nOTHER = z.o\n';
    expect(makeVar(mk, 'X3270_OBJECTS')).toEqual(['a', 'b', 'c']);
    expect(() => makeVar(mk, 'NOPE')).toThrow(/NOPE/);
  });

  it('parseDefines resolves literals and "." Ident concatenation, and drops non-strings', () => {
    const d = parseDefines([
      '#define ResProxy\t\t"proxy"',
      '#define DotProxy\t\t"." ResProxy',
      '#define OptProxy\t"-proxy"  /* comment */',
      '#define NUM 3',
    ].join('\n'));
    expect(d.get('ResProxy')).toBe('proxy');
    expect(d.get('DotProxy')).toBe('.proxy');
    expect(d.get('OptProxy')).toBe('-proxy');
    expect(d.has('NUM')).toBe(false);
  });

  it('linkedSources: x3270 objects minus widgets, plus the three Common libs, sorted', () => {
    const files: Record<string, string> = {
      'x3270/x3270_files.mk': 'X3270_OBJECTS = Cme.o menubar.o Husk.o x3270.o\n',
      'Common/lib3270_files.mk': 'LIB3270_OBJECTS = kybd.o favicon.o\n',
      'Common/lib3270i_files.mk': 'LIB3270I_OBJECTS = scroll.o\n',
      'Common/lib32xx_files.mk': 'LIB32XX_OBJECTS = proxy.o\n',
    };
    expect(linkedSources((p: string) => files[p]!)).toEqual([
      'Common/favicon.c', 'Common/kybd.c', 'Common/proxy.c', 'Common/scroll.c',
      'x3270/menubar.c', 'x3270/x3270.c',
    ]);
  });

  it('guardsByLine tracks #if/#else/#endif nesting, with /*[*/ markers stripped', () => {
    const src = ['a', '#if defined(X) /*[*/', 'b', '#else /*][*/', 'c', '#endif /*]*/', 'd'].join('\n');
    const g = guardsByLine(src);
    expect(g[0]).toBeNull();
    expect(g[2]).toBe('defined(X)');
    expect(g[4]).toBe('!(defined(X))');
    expect(g[6]).toBeNull();
  });
});
```

- [ ] **Step 2:** Run `npx vitest run packages/core/test/parityExtract.test.ts`. Expected: FAIL,
  cannot resolve `../../../scripts/parity-extract.mjs`.

- [ ] **Step 3: Implement**

`scripts/parity-extract.mjs`:

```js
#!/usr/bin/env node
// Extracts the x3270 feature-name inventory for the parity checklist
// (docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md, section 1 and its
// amendment). Reads an x3270 source tree as TEXT ONLY: nothing in it is built or run.
// No npm dependencies, so parity-upstream.yml runs this without `npm ci`.

/** Value of a Makefile variable, continuation lines joined, as object basenames without `.o`. */
export function makeVar(text, name) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const m = joined.match(new RegExp(`^${name}\\s*=(.*)$`, 'm'));
  if (!m) throw new Error(`makefile has no ${name}`);
  return m[1].trim().split(/\s+/).filter(Boolean).map((o) => o.replace(/\.o$/, ''));
}

/** `#define Name <string-literal | Ident>...` -> Map(Name -> string). Non-string defines are dropped. */
export function parseDefines(text) {
  const raw = new Map();
  for (const m of text.matchAll(/^#\s*define\s+(\w+)\s+(.+)$/gm)) {
    raw.set(m[1], m[2].replace(/\/\*.*?\*\//g, '').trim());
  }
  const out = new Map();
  const value = (name, seen) => {
    if (out.has(name)) return out.get(name);
    if (!raw.has(name) || seen.has(name)) return undefined;
    seen.add(name);
    const tokens = raw.get(name).match(/"(?:[^"\\]|\\.)*"|\w+|\S/g) ?? [];
    let s = '';
    for (const t of tokens) {
      if (t.startsWith('"')) s += t.slice(1, -1);
      else if (/^\w+$/.test(t) && !/^\d/.test(t)) {
        const v = value(t, seen);
        if (v === undefined) return undefined;
        s += v;
      } else return undefined;
    }
    out.set(name, s);
    return s;
  };
  for (const name of raw.keys()) value(name, new Set());
  return out;
}

const WIDGET_OBJECTS = /^(Cme|CmeBSB|CmeLine|CmplxMenu|Husk)$/;
const COMMON_LIBS = [
  ['Common/lib3270_files.mk', 'LIB3270_OBJECTS'],
  ['Common/lib3270i_files.mk', 'LIB3270I_OBJECTS'],
  ['Common/lib32xx_files.mk', 'LIB32XX_OBJECTS'],
];

/** The `.c` files x3270 links, relative to the tree root. `read(path)` returns file text. */
export function linkedSources(read) {
  const x = makeVar(read('x3270/x3270_files.mk'), 'X3270_OBJECTS')
    .filter((o) => !WIDGET_OBJECTS.test(o)).map((o) => `x3270/${o}.c`);
  const common = COMMON_LIBS.flatMap(([f, v]) => makeVar(read(f), v)).map((o) => `Common/${o}.c`);
  return [...new Set([...x, ...common])].sort();
}

/** Per 0-based line, the preprocessor condition in force (joined with ` && `), or null. */
export function guardsByLine(text) {
  const stack = [];
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/);
    if (m) {
      const cond = m[2].replace(/\/\*.*?\*\//g, '').trim();
      if (m[1] === 'if') stack.push(cond);
      else if (m[1] === 'ifdef') stack.push(`defined(${cond})`);
      else if (m[1] === 'ifndef') stack.push(`!defined(${cond})`);
      else if (m[1] === 'elif') stack[stack.length - 1] = cond;
      else if (m[1] === 'else') stack[stack.length - 1] = `!(${stack[stack.length - 1]})`;
      else stack.pop();
    }
    out.push(stack.length ? stack.join(' && ') : null);
  }
  return out;
}
```

`scripts/parity-extract.d.mts`:

```ts
/** Types for `parity-extract.mjs`, so the tests that import it are typechecked too. */
export function makeVar(text: string, name: string): string[];
export function parseDefines(text: string): Map<string, string>;
export function linkedSources(read: (path: string) => string): string[];
export function guardsByLine(text: string): (string | null)[];
```

- [ ] **Step 4:** `npx vitest run packages/core/test/parityExtract.test.ts`: PASS (4 tests). Then
  `npm run typecheck`: exit 0. Note on the `#else` test: `g[3]` is the `#else` line itself
  and already carries the negated guard, which is fine; the assertions read lines 0, 2, 4, 6.
- [ ] **Step 5: Commit** `scripts/parity-extract.mjs scripts/parity-extract.d.mts packages/core/test/parityExtract.test.ts`
  with message `parity: extractor primitives (makefile vars, defines, linkage, guards)` + attribution.

---

### Task 3: Extract the five name kinds

**Files:** Modify: `scripts/parity-extract.mjs`, `.d.mts`, `packages/core/test/parityExtract.test.ts`

**Re-read before writing:** `Common/kybd.c:212` (an `action_table_t`), `x3270/xactions.c:137`
(`XtActionsRec xactions[]`, literals and `An*` mixed), `Common/kybd.c:239` and `Common/task.c:611-630`
(`ACTION_HIDDEN`; task.c's local `RESUME_INPUT`), `x3270/x3270.c:1356` (`register_opts` is a
no-op, which is why `opt_t` tables are ignored), `x3270/x3270.c:146` (`XrmOptionDescRec base_options[]=`,
no space before `=`), `Common/toggles.c:86` (`toggle_names[]`), `x3270/menubar.c:1095-1270`
and `:2268` (`toggle_init(t, MONOCASE, "monocaseOption", ...)`: the name is NOT the first
argument), `include/names.h`, `include/resources.h`.

- [ ] **Step 1: Write the failing tests** (append to `parityExtract.test.ts`; merge each new
  `import` into the file's existing top-of-file import from the same module, here and in every
  later task that "appends" tests)

```ts
import { extractNames } from '../../../scripts/parity-extract.mjs';

const TREE: Record<string, string> = {
  'include/names.h': '#define AnAttn "Attn"\n#define AnStepEfont "StepEfont"\n#define AnMonoCase "MonoCase"\n',
  'include/resources.h': [
    '#define ResProxy "proxy"', '#define DotProxy "." ResProxy', '#define OptProxy "-proxy"',
    '#define ResModel "model"', '#define DotModel "." ResModel', '#define OptModel "-model"',
    '#define ResMonoCase "monoCase"', '#define ResHostsFile "hostsFile"', '#define ResUnused "unused"',
    '#define OptOnlyXrm "-onlyxrm"', '#define ResOnlyXrm "onlyXrm"', '#define DotOnlyXrm "." ResOnlyXrm',
    '#define OptGlueOnly "-glueonly"', '#define ResGlueOnly "glueOnly"',
  ].join('\n'),
  'Common/kybd.c': [
    '#define RESUME_INPUT "ResumeInput"',
    'static action_table_t kybd_actions[] = {',
    '    { AnAttn,\t\tAttn_action,\t\tACTION_KE },',
    '    { AnMonoCase,\tMonoCase_action,\tACTION_KE | ACTION_HIDDEN },',
    '    { RESUME_INPUT,\tResumeInput_action, 0 },',
    '};',
    'x = ResHostsFile;',
  ].join('\n'),
  'Common/glue.c': [
    'static opt_t base_opts[] = {',
    '{ OptProxy,  OPT_STRING, false, ResProxy, aoffset(proxy),',
    '    "<host>", "Proxy" },',
    '{ OptGlueOnly, OPT_STRING, false, ResGlueOnly, aoffset(g), NULL, NULL },',
    '};',
  ].join('\n'),
  'Common/toggles.c': 'toggle_name_t toggle_names[] = {\n    { ResMonoCase,        MONOCASE,\t\tfalse },\n    { NULL, 0, false }\n};\n',
  'x3270/x3270.c': [
    'XrmOptionDescRec base_options[]= {',
    '    { OptProxy,\tDotProxy,\tXrmoptionSepArg,\tNULL },',
    '    { OptOnlyXrm,\tDotOnlyXrm,\tXrmoptionNoArg,\tResTrue },',
    '#if defined(X) /*[*/',
    '    { OptModel,\tDotModel,\tXrmoptionSepArg,\tNULL },',
    '#endif /*]*/',
    '    { OptClear,\t".xxx",\tXrmoptionSkipArg,\tNULL },',
    '};',
  ].join('\n'),
  'x3270/xactions.c': 'static XtActionsRec xactions[] = {\n    { "Cut",\t\tCut_xaction },\n    { AnStepEfont,\tStepEfont_xaction },\n};\n',
  'x3270/menubar.c': [
    '    w = add_menu_itemv("ftOption", file_menu,',
    '\t    popup_ft, NULL, &spaced, NULL);',
    '    XtVaCreateManagedWidget("space", cmeLineObjectClass, m, NULL);',
    '    w = XtVaCreateManagedWidget(',
    '\t"exitReallyOption", cmeBSBObjectClass, exit_menu, NULL);',
    '    XtVaCreateManagedWidget("label", labelWidgetClass, m, NULL);',
    '    toggle_init(t, MONOCASE, "monocaseOption", NULL, &spaced);',
    '    add_menu_itemv(host_name, m, cb, NULL, NULL, NULL);',
  ].join('\n'),
};
const read = (p: string) => { const t = TREE[p]; if (t === undefined) throw new Error(`ENOENT ${p}`); return t; };
const FILES = ['Common/glue.c', 'Common/kybd.c', 'Common/toggles.c', 'x3270/menubar.c', 'x3270/x3270.c', 'x3270/xactions.c'];

describe('extractNames', () => {
  const out = extractNames(read, FILES);
  const ids = out.names.map((n) => n.id);

  it('finds actions (An*, or a define local to the file), leaving out ACTION_HIDDEN', () => {
    expect(ids).toEqual(expect.arrayContaining(['action:Attn', 'action:ResumeInput']));
    expect(ids).not.toContain('action:MonoCase');
    expect(out.names.find((n) => n.id === 'action:Attn')!.sites).toEqual([{ at: 'Common/kybd.c:3', guard: null }]);
  });

  it('finds the pure Xt actions of xactions[] as xaction:, literal or An*', () => {
    expect(ids).toEqual(expect.arrayContaining(['xaction:Cut', 'xaction:StepEfont']));
  });

  it("takes options from x3270's Xrm table only, with the resource each sets", () => {
    const proxy = out.names.find((n) => n.id === 'option:-proxy')!;
    expect(proxy.resource).toBe('proxy');
    expect(proxy.sites.map((s) => s.at)).toEqual(['x3270/x3270.c:2']);
    expect(out.names.find((n) => n.id === 'option:-onlyxrm')!.resource).toBe('onlyXrm');
    expect(out.names.find((n) => n.id === 'option:-model')!.sites[0]!.guard).toBe('defined(X)');
  });

  it("ignores opt_t tables (x3270's register_opts is a no-op), so their resource is a plain resource", () => {
    expect(ids).not.toContain('option:-glueonly');
    expect(ids).toContain('resource:glueOnly');
  });

  it('keeps an option whose define is unknown, under its identifier, and flags it', () => {
    expect(ids).toContain('option:OptClear');
    expect(out.unresolved).toContain('OptClear at x3270/x3270.c:7');
  });

  it('finds toggles from toggle_names[]', () => {
    expect(ids).toContain('toggle:monoCase');
  });

  it('lists a resource only when used and not set by an option or a toggle', () => {
    expect(ids).toContain('resource:hostsFile');
    for (const gone of ['resource:proxy', 'resource:model', 'resource:onlyXrm', 'resource:monoCase', 'resource:unused']) {
      expect(ids).not.toContain(gone);
    }
  });

  it('finds menu items, skipping spacers and non-menu widgets, and reports non-literal names', () => {
    expect(ids).toEqual(expect.arrayContaining(['menu:ftOption', 'menu:exitReallyOption', 'menu:monocaseOption']));
    expect(ids).not.toContain('menu:space');
    expect(ids).not.toContain('menu:label');
    expect(out.nonLiteralMenuCalls).toEqual(['x3270/menubar.c:8']);
  });

  it('is sorted by id', () => {
    expect(ids).toEqual([...ids].sort());
  });
});
```

- [ ] **Step 2:** Run the test file. Expected: FAIL, `extractNames` is not exported.

- [ ] **Step 3: Implement** (append to `scripts/parity-extract.mjs`)

```js
/** Text of each `{ ... }` entry in the array literal opened at `open` (index of `{`), with its 1-based line. */
function entries(text, open) {
  const out = [];
  let depth = 0, start = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } continue; }
    if (c === '{') { depth++; if (depth === 2) start = i; }
    else if (c === '}') {
      if (depth === 2) out.push({ body: text.slice(start + 1, i), line: lineOf(text, start) });
      depth--;
      if (depth === 0) break;
    }
  }
  return out;
}
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Each array literal whose declaration matches `decl`, as its entries. */
function tables(text, decl) {
  const out = [];
  for (const m of text.matchAll(decl)) out.push(...entries(text, text.indexOf('{', m.index + m[0].length - 1)));
  return out;
}

/** Top-level comma-separated fields of an entry body. */
const fields = (body) => {
  const out = []; let cur = '', depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') { const j = body.indexOf('"', i + 1); cur += body.slice(i, j + 1); i = j; continue; }
    if (c === '(') depth++; else if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};

/** The argument text of the call whose `(` is at `open`. */
function callArgs(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '"') { i++; while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; } continue; }
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

const MENU_CALL = /\b(add_menu_itemv|toggle_init|Xt\w*Create\w*(?:Widget|PopupShell))\s*\(/g;

/**
 * The six kinds of name, over the linked `files`. `read(path)` returns file text.
 * @returns {{ names: object[], unresolved: string[], nonLiteralMenuCalls: string[] }}
 */
export function extractNames(read, files) {
  const defs = parseDefines(`${read('include/names.h')}\n${read('include/resources.h')}`);
  const names = new Map();
  const unresolved = [];
  const nonLiteralMenuCalls = [];
  const add = (kind, value, file, line, guards, extra = {}) => {
    const id = `${kind}:${value}`;
    const n = names.get(id) ?? { id, kind, value, sites: [] };
    n.sites.push({ at: `${file}:${line}`, guard: guards[line - 1] ?? null });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) n[k] = v;
    names.set(id, n);
  };
  const resolveName = (token, file, line) => {
    if (token.startsWith('"')) return token.slice(1, -1);
    if (defs.has(token)) return defs.get(token);
    unresolved.push(`${token} at ${file}:${line}`);
    return token;
  };
  const used = new Set();
  const optionResources = new Set();
  const toggleResources = new Set();

  for (const file of files) {
    let text;
    try { text = read(file); } catch { continue; } // missingSources is computed by the caller
    const guards = guardsByLine(text);
    for (const t of text.match(/\b(?:Res|Dot)\w+/g) ?? []) used.add(t);
    const local = parseDefines(text); // e.g. Common/task.c's RESUME_INPUT
    const actionName = (token, line) => (local.has(token) ? local.get(token) : resolveName(token, file, line));

    for (const e of tables(text, /\baction_table_t\s+\w+\s*\[\s*\]\s*=\s*\{/g)) {
      const f = fields(e.body);
      if (!/^(\w+|"[^"]*")$/.test(f[0] ?? '') || /\bACTION_HIDDEN\b/.test(f[2] ?? '')) continue;
      add('action', actionName(f[0], e.line), file, e.line, guards);
    }
    // The pure Xt actions (x3270/xactions.c): bindable in keymaps, so reachable by a user.
    for (const e of tables(text, /\bXtActionsRec\s+xactions\s*\[\s*\]\s*=\s*\{/g)) {
      const [name] = fields(e.body);
      if (/^(\w+|"[^"]*")$/.test(name ?? '')) add('xaction', actionName(name, e.line), file, e.line, guards);
    }
    // Options: x3270's own Xrm table only. Its register_opts() is a no-op (x3270/x3270.c:1356),
    // so the opt_t tables in Common/ never reach it.
    for (const e of tables(text, /\bXrmOptionDescRec\s+\w+\s*\[\s*\]\s*=\s*\{/g)) {
      const f = fields(e.body);
      if (!/^Opt\w+$/.test(f[0] ?? '')) continue;
      const dot = /^Dot\w+$/.test(f[1] ?? '') ? defs.get(f[1]) : undefined;
      const res = dot?.startsWith('.') ? dot.slice(1) : undefined;
      if (res) optionResources.add(res);
      add('option', resolveName(f[0], file, e.line), file, e.line, guards, { resource: res });
    }
    for (const e of tables(text, /\btoggle_name_t\s+toggle_names\s*\[\s*\]\s*=\s*\{/g)) {
      const [res] = fields(e.body);
      if (!/^Res\w+$/.test(res ?? '')) continue;
      const v = resolveName(res, file, e.line);
      toggleResources.add(v);
      add('toggle', v, file, e.line, guards);
    }
    if (file.startsWith('x3270/')) {
      for (const m of text.matchAll(MENU_CALL)) {
        const open = m.index + m[0].length - 1;
        const args = callArgs(text, open);
        const line = lineOf(text, m.index);
        if (/^\s*(?:const\s+)?(?:char|Widget|static|bool)\b/.test(args)) continue; // a definition or prototype
        if (m[1].startsWith('Xt') && !/\bcmeBSBObjectClass\b/.test(args)) continue;
        const literals = [...args.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
        const picked = m[1] === 'toggle_init' ? literals : literals.slice(0, 1);
        const first = fields(args)[0] ?? '';
        if (m[1] !== 'toggle_init' && !first.startsWith('"')) { nonLiteralMenuCalls.push(`${file}:${line}`); continue; }
        for (const v of picked) if (v !== 'space') add('menu', v, file, line, guards);
      }
    }
  }

  const resText = read('include/resources.h');
  const resGuards = guardsByLine(resText);
  for (const m of resText.matchAll(/^#\s*define\s+(Res\w+)\b/gm)) {
    const value = defs.get(m[1]);
    if (value === undefined || optionResources.has(value) || toggleResources.has(value)) continue;
    const dots = [...defs.keys()].filter((k) => k.startsWith('Dot') && defs.get(k) === `.${value}`);
    if (!used.has(m[1]) && !dots.some((d) => used.has(d))) continue;
    add('resource', value, 'include/resources.h', lineOf(resText, m.index), resGuards);
  }

  for (const n of names.values()) n.sites.sort((a, b) => a.at.localeCompare(b.at, 'en', { numeric: true }));
  return {
    names: [...names.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    unresolved: [...new Set(unresolved)].sort(),
    nonLiteralMenuCalls: nonLiteralMenuCalls.sort(),
  };
}
```

Add to `.d.mts`:

```ts
export interface Site { at: string; guard: string | null }
export interface Name { id: string; kind: 'action' | 'xaction' | 'option' | 'resource' | 'toggle' | 'menu'; value: string; sites: Site[]; resource?: string }
export interface Extracted { names: Name[]; unresolved: string[]; nonLiteralMenuCalls: string[] }
export function extractNames(read: (path: string) => string, files: string[]): Extracted;
```

**Known parser limits (C text, not a C parser):** a `'"'` or `'{'` character literal, or a
quote inside a comment, inside a table or menu call would mislead `entries`/`callArgs`. If Task
4's counts look wrong, look for these first.

**Known judgement calls to check against the real tree, not just the fixture:** `toggle_init`
takes *every* literal (name1 and name2); a resource counts as used when its `Res*` or any `Dot*`
naming it appears in a linked file (resources.h itself is not linked, so its own definitions
don't count). The `used` check excluding resources.h relies on `files` not containing it. The
sorting uses code-unit order on purpose, so the output is stable across locales.

- [ ] **Step 4:** Run the test file: PASS (13 tests). `npm run typecheck`: exit 0.
- [ ] **Step 5: Commit** with message `parity: extract actions, options, resources, toggles and menu items` + attribution.

---

### Task 4: The extractor's command line and the 4.5ga6 inventory

**Files:** Modify `scripts/parity-extract.mjs`, `.d.mts`, the test. Create `docs/parity/x3270-names.json`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { diffNames, newestGa, renderInventory } from '../../../scripts/parity-extract.mjs';

describe('newestGa', () => {
  it('ignores alphas and betas and orders numerically', () => {
    expect(newestGa(['4.6alpha1', '4.5ga6', '4.5ga10', '4.4ga6', '4.5beta4'])).toBe('4.5ga10');
    expect(newestGa(['4.6alpha1'])).toBeUndefined();
  });
});

describe('renderInventory', () => {
  it('is stable JSON with a trailing newline and the tag first', () => {
    const text = renderInventory({ tag: '4.5ga6', missingSources: [], unresolved: [], nonLiteralMenuCalls: [], names: [] });
    expect(text).toBe('{\n  "source": "pmattes/x3270",\n  "tag": "4.5ga6",\n  "missingSources": [],\n  "unresolved": [],\n  "nonLiteralMenuCalls": [],\n  "names": []\n}\n');
  });
});

describe('diffNames', () => {
  it('reports added, removed and moved names, one line each', () => {
    const a = { names: [{ id: 'action:A', sites: [{ at: 'x.c:1' }] }, { id: 'action:B', sites: [{ at: 'x.c:2' }] }] };
    const b = { names: [{ id: 'action:A', sites: [{ at: 'x.c:9' }] }, { id: 'action:C', sites: [{ at: 'x.c:3' }] }] };
    expect(diffNames(a as never, b as never)).toEqual([
      '+ action:C (x.c:3)', '- action:B (x.c:2)', '~ action:A x.c:1 -> x.c:9',
    ]);
  });
});
```

- [ ] **Step 2:** Run: FAIL (not exported).

- [ ] **Step 3: Implement** (append)

```js
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```
(Put these imports at the top of the file, above the first export.)

```js
const GA = /^(\d+)\.(\d+)ga(\d+)$/;
const TAG = /^\d+\.\d+(?:alpha|beta|ga)\d+$/;

/** The newest `M.NgaP` tag, or undefined. */
export function newestGa(tags) {
  const key = (t) => t.match(GA).slice(1).map(Number);
  return tags.filter((t) => GA.test(t)).sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).at(-1);
}

export function renderInventory({ tag, missingSources, unresolved, nonLiteralMenuCalls, names }) {
  return `${JSON.stringify({ source: 'pmattes/x3270', tag, missingSources, unresolved, nonLiteralMenuCalls, names }, null, 2)}\n`;
}

export function diffNames(oldInv, newInv) {
  const sites = (n) => n.sites.map((s) => s.at).join(', ');
  const before = new Map(oldInv.names.map((n) => [n.id, n]));
  const after = new Map(newInv.names.map((n) => [n.id, n]));
  const added = [...after.values()].filter((n) => !before.has(n.id)).map((n) => `+ ${n.id} (${sites(n)})`);
  const removed = [...before.values()].filter((n) => !after.has(n.id)).map((n) => `- ${n.id} (${sites(n)})`);
  const moved = [...after.values()].filter((n) => before.has(n.id) && sites(before.get(n.id)) !== sites(n))
    .map((n) => `~ ${n.id} ${sites(before.get(n.id))} -> ${sites(n)}`);
  return [...added, ...removed, ...moved];
}

/** Inventory of the tree at `root`. */
export function inventory(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const tag = read('Common/version.txt').match(/^version="([^"]+)"/m)?.[1];
  if (!tag) throw new Error(`${root}: no version= in Common/version.txt`);
  const files = linkedSources(read);
  const missingSources = files.filter((f) => !existsSync(join(root, f)));
  return { tag, missingSources, ...extractNames(read, files.filter((f) => !missingSources.includes(f))) };
}

/** Download and unpack `tag` into a fresh temp dir; returns the tree root. */
export function fetchTag(tag) {
  if (!TAG.test(tag)) throw new Error(`not an x3270 tag: ${tag}`);
  const dir = mkdtempSync(join(tmpdir(), 'x3270-'));
  const tgz = join(dir, 'src.tgz');
  const url = `https://github.com/pmattes/x3270/archive/refs/tags/${tag}.tar.gz`;
  for (const [cmd, args] of [['curl', ['-fsSL', '-o', tgz, url]], ['tar', ['-xzf', tgz, '-C', dir]]]) {
    const r = spawnSync(cmd, args, { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) throw new Error(`${cmd} failed for ${url}`);
  }
  return join(dir, `x3270-${tag}`);
}

async function upstreamTags() {
  const r = await fetch('https://api.github.com/repos/pmattes/x3270/tags?per_page=100', { headers: { accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub tags: HTTP ${r.status}`);
  return (await r.json()).map((t) => t.name);
}

const USAGE = 'usage: parity-extract.mjs (--dir <tree> | --tag <tag>) [--out <file>] | --upstream <committed.json>';

export async function main(argv, io = { log: console.log, err: console.error }) {
  const [mode, arg, ...rest] = argv;
  try {
    if (mode === '--upstream' && arg) {
      const committed = JSON.parse(readFileSync(arg, 'utf8'));
      const ga = newestGa(await upstreamTags());
      if (!ga) throw new Error('no GA tag upstream');
      if (ga === committed.tag) { io.log(`x3270 ${ga} is the newest GA and is the one recorded`); return 0; }
      const lines = diffNames(committed, inventory(fetchTag(ga)));
      io.err(`x3270 ${ga} is newer than the recorded ${committed.tag}: regenerate with --tag ${ga}`);
      for (const l of lines) io.err(l);
      return 1;
    }
    if ((mode === '--dir' || mode === '--tag') && arg) {
      const root = mode === '--dir' ? resolve(arg) : fetchTag(arg);
      const outIx = rest.indexOf('--out');
      const out = outIx >= 0 ? rest[outIx + 1] : 'docs/parity/x3270-names.json';
      const inv = inventory(root);
      writeFileSync(out, renderInventory(inv));
      io.log(`${out}: x3270 ${inv.tag}, ${inv.names.length} names, ${inv.missingSources.length} missing sources, ${inv.unresolved.length} unresolved, ${inv.nonLiteralMenuCalls.length} non-literal menu calls`);
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (e) {
    io.err(`parity-extract: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
```

Add to `.d.mts`:

```ts
export interface Inventory extends Extracted { tag: string; missingSources: string[] }
export function newestGa(tags: string[]): string | undefined;
export function renderInventory(inv: Inventory): string;
export function diffNames(oldInv: Inventory, newInv: Inventory): string[];
export function inventory(root: string): Inventory;
export function fetchTag(tag: string): string;
export function main(argv: string[], io?: { log: (s: string) => void; err: (s: string) => void }): Promise<number>;
```

- [ ] **Step 4:** Run the test file: PASS. `npm run typecheck`: exit 0.

- [ ] **Step 5: Generate the inventory, and prove the two inputs agree**

```bash
mkdir -p docs/parity
node scripts/parity-extract.mjs --dir ~/src/suite3270-4.5
node scripts/parity-extract.mjs --tag 4.5ga6 --out /tmp/parity-tag.json
cmp docs/parity/x3270-names.json /tmp/parity-tag.json && echo IDENTICAL
```
Expected: each run prints a summary line; `IDENTICAL`. If they differ, stop and report:
the tag archive and the release tarball aren't the same tree, which the spec assumes.

- [ ] **Step 6: Read the inventory before committing.** Report the counts per kind
  (`node -e` over the JSON), every `unresolved` entry, every `missingSources` entry, every
  `nonLiteralMenuCalls` site, and spot-check five names of each kind against the source by
  `file:line`. The other thread's prototype measured 129 sources and 470 names (100 `action`, 21
  `xaction`, 67 `option`, 209 `resource`, 73 `menu`; it had no `toggle` kind, and this plan's
  toggles take their resources out of `resource`), so expect roughly that. A count wildly off (say under half or over double) means a rule is wrong: fix it, add a
  test for the case, and re-run Step 5. Known suspects: Xrm entries in `#if` blocks, `XtActionsRec`
  in widget files (excluded by linkage), a `toggle_init` with a non-literal name. Do the
  amendment's wiki cross-check (3b) here too, and record the differences in the commit message.

- [ ] **Step 7: Commit** the script, `.d.mts`, test and `docs/parity/x3270-names.json`, message
  `parity: the x3270 4.5ga6 name inventory (N names)`, with N the real count, + attribution.

---

### Task 5: The checker

**Files:**
- Create: `scripts/parity.mjs`, `scripts/parity.d.mts`
- Test: `packages/core/test/parity.test.ts`

The checker's rules are the spec's *Statuses* table and *3. Checks* items 1-3 and 5, plus the
amendment's `area`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, type Row } from '../../../scripts/parity.mjs';

/** A throwaway repo root with one source file of 3 lines, one test file and a live-testing heading. */
function fakeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'parity-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'src/a.test.ts'), '');
  writeFileSync(join(root, 'docs/live-testing.md'), '# Runbook\n\n## Proxy against squid\n');
  return root;
}
const NAMES = { names: [{ id: 'action:A' }, { id: 'option:-b' }] } as never;
const ours = (over: Partial<Row> = {}): Row => ({
  id: 'thing', area: 'connection', title: 'T', covers: ['action:A', 'option:-b'], x3270: 'menu', gui: 'menu',
  status: 'ours', evidence: { code: ['src/a.ts:3'], tests: ['src/a.test.ts'], live: 'Proxy against squid' }, ...over,
} as Row);

describe('parity check', () => {
  const root = fakeRoot();
  const run = (rows: Row[]) => check({ rows, names: NAMES, root });

  it('passes a well-formed ours row that covers everything', () => {
    expect(run([ours()])).toEqual({ problems: [], uncovered: [] });
  });

  it('reports an uncovered name separately from problems', () => {
    expect(run([ours({ covers: ['action:A'] })])).toEqual({ problems: [], uncovered: ['option:-b'] });
  });

  it.each([
    ['a double cover', [ours(), ours({ id: 'other', covers: ['action:A'] })], 'other: action:A is also covered by thing'],
    ['an unknown name', [ours({ covers: ['action:A', 'option:-b', 'menu:zz'] })], 'thing: covers unknown name menu:zz'],
    ['a duplicate id', [ours(), ours({ covers: [] })], 'thing: duplicate id'],
    ['a non-kebab id', [ours({ id: 'Thing_1' })], 'Thing_1: id is not kebab-case'],
    ['a bad area', [ours({ area: 'misc' as never })], 'thing: area must be one of'],
    ['a bad status', [ours({ status: 'done' as never })], 'thing: status must be one of'],
    ['ours without tests', [ours({ evidence: { code: ['src/a.ts'], tests: [], live: 'n/a' } })], 'thing: ours needs evidence.tests'],
    ['ours without code', [ours({ evidence: { code: [], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: ours needs evidence.code'],
    ['a dead file', [ours({ evidence: { code: ['src/nope.ts'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/nope.ts does not exist'],
    ['a line past the end', [ours({ evidence: { code: ['src/a.ts:9'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:9 is past the end (3 lines)'],
    ['a dead live heading', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'No such heading' } })], 'thing: live heading not in docs/live-testing.md: No such heading'],
    ['unwitnessed without acceptance', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' } })], 'thing: live: unwitnessed needs accept-unwitnessed'],
    ['acceptance where witnessed', [ours({ 'accept-unwitnessed': 'x' })], 'thing: accept-unwitnessed only on ours with live: unwitnessed'],
    ['partial without gap', [ours({ status: 'partial' })], 'thing: partial needs gap'],
    ['deferred without decided', [ours({ status: 'deferred', reason: 'later' })], 'thing: deferred needs decided'],
    ['deferred without reason', [ours({ status: 'deferred', decided: '2026-11-17, user' })], 'thing: deferred needs reason'],
    ['a malformed decided', [ours({ status: 'deferred', reason: 'r', decided: 'yes' })], 'thing: decided must read "YYYY-MM-DD, user"'],
    ['decided on a proposal', [ours({ status: 'proposed-deferred', reason: 'r', decided: '2026-11-17, user' })], 'thing: decided only on deferred or skipped'],
    ['skipped without category', [ours({ status: 'skipped', reason: 'r', decided: '2026-11-17, user' })], 'thing: skipped needs category'],
    ['a bad category', [ours({ status: 'skipped', category: 'meh' as never, reason: 'r', decided: '2026-11-17, user' })], 'thing: category must be one of'],
    ['a missing title', [ours({ title: '' })], 'thing: needs title'],
  ])('fails %s', (_label, rows, expected) => {
    const { problems } = run(rows as Row[]);
    expect(problems.some((p) => p.startsWith(expected)), `${expected}\n  got: ${problems.join('\n  ')}`).toBe(true);
  });

  it('accepts unwitnessed with acceptance, missing with nothing, and a decided skip', () => {
    expect(run([
      ours({ covers: ['action:A'], evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' }, 'accept-unwitnessed': 'no TN3270E host' }),
      { id: 'b', area: 'other', title: 'B', covers: ['option:-b'], x3270: '-b', gui: 'none', status: 'skipped', category: 'x11-only', reason: 'X only', decided: '2026-11-17, user' } as Row,
    ]).problems).toEqual([]);
    expect(run([{ id: 'm', area: 'other', title: 'M', covers: ['action:A', 'option:-b'], x3270: 'x', gui: 'none', status: 'missing' } as Row]).problems).toEqual([]);
  });
});
```

- [ ] **Step 2:** `npx vitest run packages/core/test/parity.test.ts`: FAIL (module missing).

- [ ] **Step 3: Implement** `scripts/parity.mjs`

```js
#!/usr/bin/env node
// The x3270 parity checklist: check, render, gate
// (docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md, sections 2-3).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const AREAS = ['connection', 'keyboard', 'display', 'files', 'scripting', 'other'];
export const STATUSES = ['ours', 'partial', 'missing', 'proposed-deferred', 'proposed-skipped', 'deferred', 'skipped'];
export const CATEGORIES = ['x11-only', 'obsolete', 'declined', 'n/a'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DECIDED = /^\d{4}-\d{2}-\d{2}, user$/;

/** Heading texts of a markdown file, `#`s and surrounding space stripped. */
const headings = (text) => text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/^#+\s*/, '').trim());

/** @returns {{ problems: string[], uncovered: string[] }} */
export function check({ rows, names, root }) {
  const problems = [];
  const say = (row, msg) => problems.push(`${row.id}: ${msg}`);
  const known = new Set(names.names.map((n) => n.id));
  const coveredBy = new Map();
  const ids = new Set();
  const liveFile = join(root, 'docs/live-testing.md');
  const live = existsSync(liveFile) ? new Set(headings(readFileSync(liveFile, 'utf8'))) : new Set();

  for (const row of rows) {
    if (ids.has(row.id)) say(row, 'duplicate id');
    ids.add(row.id);
    if (!KEBAB.test(row.id ?? '')) say(row, 'id is not kebab-case');
    for (const f of ['title', 'x3270', 'gui']) if (!row[f]) say(row, `needs ${f}`);
    if (!AREAS.includes(row.area)) say(row, `area must be one of ${AREAS.join(', ')}`);
    if (!STATUSES.includes(row.status)) say(row, `status must be one of ${STATUSES.join(', ')}`);
    for (const id of row.covers ?? []) {
      if (!known.has(id)) say(row, `covers unknown name ${id}`);
      else if (coveredBy.has(id)) say(row, `${id} is also covered by ${coveredBy.get(id)}`);
      else coveredBy.set(id, row.id);
    }
    const ev = row.evidence ?? {};
    if (row.status === 'ours') {
      if (!ev.code?.length) say(row, 'ours needs evidence.code');
      if (!ev.tests?.length) say(row, 'ours needs evidence.tests');
      if (!ev.live) say(row, 'ours needs evidence.live (a heading, unwitnessed or n/a)');
      if (ev.live === 'unwitnessed' && !row['accept-unwitnessed']) say(row, 'live: unwitnessed needs accept-unwitnessed');
    }
    if (row['accept-unwitnessed'] && !(row.status === 'ours' && ev.live === 'unwitnessed')) {
      say(row, 'accept-unwitnessed only on ours with live: unwitnessed');
    }
    for (const cite of [...(ev.code ?? []), ...(ev.tests ?? [])]) {
      const [file, line] = cite.split(':');
      const path = join(root, file);
      if (!existsSync(path)) { say(row, `${file} does not exist`); continue; }
      if (line !== undefined) {
        const count = readFileSync(path, 'utf8').replace(/\n$/, '').split('\n').length;
        if (Number(line) > count) say(row, `${cite} is past the end (${count} lines)`);
      }
    }
    if (ev.live && !['n/a', 'unwitnessed'].includes(ev.live) && !live.has(ev.live)) {
      say(row, `live heading not in docs/live-testing.md: ${ev.live}`);
    }
    if (row.status === 'partial' && !row.gap) say(row, 'partial needs gap');
    if (['deferred', 'skipped', 'proposed-deferred', 'proposed-skipped'].includes(row.status) && !row.reason) {
      say(row, `${row.status} needs reason`);
    }
    if (['deferred', 'skipped'].includes(row.status) && !row.decided) say(row, `${row.status} needs decided`);
    if (row.decided !== undefined) {
      if (!['deferred', 'skipped'].includes(row.status)) say(row, 'decided only on deferred or skipped');
      else if (!DECIDED.test(row.decided)) say(row, 'decided must read "YYYY-MM-DD, user"');
    }
    if (row.status === 'skipped') {
      if (!row.category) say(row, 'skipped needs category');
      else if (!CATEGORIES.includes(row.category)) say(row, `category must be one of ${CATEGORIES.join(', ')}`);
    }
  }
  const uncovered = [...known].filter((id) => !coveredBy.has(id)).sort();
  return { problems, uncovered };
}

export const loadRows = (text) => parse(text) ?? [];
```

`scripts/parity.d.mts`:

```ts
/** Types for `parity.mjs`, so the tests that import it are typechecked too. */
import type { Inventory } from './parity-extract.mjs';
export type Area = 'connection' | 'keyboard' | 'display' | 'files' | 'scripting' | 'other';
export type Status = 'ours' | 'partial' | 'missing' | 'proposed-deferred' | 'proposed-skipped' | 'deferred' | 'skipped';
export interface Row {
  id: string; area: Area; title: string; covers: string[]; x3270: string; gui: string; status: Status;
  gap?: string; reason?: string; decided?: string;
  category?: 'x11-only' | 'obsolete' | 'declined' | 'n/a';
  evidence?: { code?: string[]; tests?: string[]; live?: string };
  'accept-unwitnessed'?: string;
  browser?: string; others?: Record<string, string>;
}
export const AREAS: Area[];
export const STATUSES: Status[];
export const CATEGORIES: string[];
export function check(args: { rows: Row[]; names: Pick<Inventory, 'names'>; root: string }): { problems: string[]; uncovered: string[] };
export function loadRows(text: string): Row[];
```

- [ ] **Step 4:** Run the test file: PASS (all cases). `npm run typecheck`: exit 0. **Then
  mutate:** for three of the rules (say the double cover, `decided` format and line-past-end),
  break the rule's line in `parity.mjs`, confirm exactly the matching case fails, and restore
  it. Report the three. (A check passing against the defect it was written for proves nothing.)
- [ ] **Step 5: Commit** `parity: the checklist checker` + attribution.

---

### Task 6: Render, gate, uncovered, and the checks on the committed files

**Files:** Modify `scripts/parity.mjs`, `.d.mts`, `packages/core/test/parity.test.ts`. Create
`docs/parity/checklist.yaml` (empty list) and `docs/parity.md` (rendered).

- [ ] **Step 1: Write the failing tests** (append)

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blocking, loadRows, render } from '../../../scripts/parity.mjs';

describe('render and gate', () => {
  const rows: Row[] = [
    ours({ id: 'b-thing', covers: ['action:A'], gui: 'File | Connect' }),
    { id: 'a-gap', area: 'connection', title: 'Gap', covers: ['option:-b'], x3270: 'x', gui: 'flag only', status: 'partial', gap: 'no dialog' } as Row,
    { id: 'z-skip', area: 'display', title: 'Z', covers: [], x3270: 'x', gui: 'none', status: 'skipped', category: 'x11-only', reason: 'X fonts', decided: '2026-11-17, user' } as Row,
  ];

  it('renders generated counts, then one table per area in AREAS order, rows sorted by id', () => {
    const md = render(rows, { tag: '4.5ga6', names: [{ id: 'action:A' }, { id: 'option:-b' }] } as never);
    expect(md).toContain('Compared against x3270 **4.5ga6**');
    expect(md).toMatch(/\| ours \| 1 \|[\s\S]*\| partial \| 1 \|[\s\S]*\| skipped \| 1 \|/);
    expect(md.indexOf('## connection')).toBeLessThan(md.indexOf('## display'));
    expect(md.indexOf('a-gap')).toBeLessThan(md.indexOf('b-thing'));
    expect(md).toContain('File \\| Connect');
    expect(md).toContain('no dialog');
  });

  it('blocks partial, missing, proposed-* and unaccepted unwitnessed; passes the rest', () => {
    const more = [...rows,
      { id: 'm', area: 'other', status: 'missing', title: 'M' },
      { id: 'p', area: 'other', status: 'proposed-deferred', reason: 'later?', title: 'P' },
    ] as Row[];
    expect(blocking(more)).toEqual([
      'a-gap: partial -- no dialog', 'm: missing', 'p: proposed-deferred -- later?',
    ]);
  });
});

describe('the committed checklist', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const names = JSON.parse(readFileSync(`${root}docs/parity/x3270-names.json`, 'utf8'));
  const committed = loadRows(readFileSync(`${root}docs/parity/checklist.yaml`, 'utf8'));

  it('has no problems', () => {
    expect(check({ rows: committed, names, root }).problems).toEqual([]);
  });

  it('docs/parity.md is exactly what render produces (run: node scripts/parity.mjs render)', () => {
    expect(readFileSync(`${root}docs/parity.md`, 'utf8')).toBe(render(committed, names));
  });
});
```

- [ ] **Step 2:** Run: FAIL (`render`/`blocking` not exported; the committed files don't exist).

- [ ] **Step 3: Implement** (append to `parity.mjs`)

```js
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const note = (r) => r.gap ?? r.reason ?? r['accept-unwitnessed'] ?? '';

export function blocking(rows) {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).flatMap((r) => {
    if (r.status === 'partial') return [`${r.id}: partial -- ${r.gap}`];
    if (r.status === 'missing') return [`${r.id}: missing`];
    if (r.status?.startsWith('proposed-')) return [`${r.id}: ${r.status} -- ${r.reason}`];
    if (r.status === 'ours' && r.evidence?.live === 'unwitnessed' && !r['accept-unwitnessed']) return [`${r.id}: ours but unwitnessed, not accepted`];
    return [];
  });
}

export function render(rows, names) {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const out = [
    '# x3270 parity checklist',
    '',
    '<!-- GENERATED by `node scripts/parity.mjs render` from docs/parity/checklist.yaml and',
    '     docs/parity/x3270-names.json. Do not edit by hand. -->',
    '',
    `Compared against x3270 **${names.tag}**: ${names.names.length} names in ${rows.length} rows.`,
    'Design: `docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md`.',
    '',
    '| status | rows |',
    '|---|---|',
    ...STATUSES.map((s) => `| ${s} | ${count(s)} |`),
    '',
  ];
  for (const area of AREAS) {
    const these = rows.filter((r) => r.area === area).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!these.length) continue;
    out.push(`## ${area}`, '', '| id | feature | status | our GUI | x3270 | note |', '|---|---|---|---|---|---|');
    for (const r of these) out.push(`| ${cell(r.id)} | ${cell(r.title)} | ${cell(r.status)} | ${cell(r.gui)} | ${cell(r.x3270)} | ${cell(note(r))} |`);
    out.push('');
  }
  return out.join('\n');
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAMES_FILE = join(ROOT, 'docs/parity/x3270-names.json');
const ROWS_FILE = join(ROOT, 'docs/parity/checklist.yaml');
const MD_FILE = join(ROOT, 'docs/parity.md');

export function main(argv, io = { log: console.log, err: console.error }) {
  const names = JSON.parse(readFileSync(NAMES_FILE, 'utf8'));
  const rows = loadRows(readFileSync(ROWS_FILE, 'utf8'));
  const { problems, uncovered } = check({ rows, names, root: ROOT });
  const sites = new Map(names.names.map((n) => [n.id, n.sites.map((s) => s.at).join(', ')]));
  switch (argv[0]) {
    case 'render': writeFileSync(MD_FILE, render(rows, names)); io.log(`wrote ${MD_FILE}`); return 0;
    case 'uncovered': for (const id of uncovered) io.log(`${id}\t${sites.get(id)}`); return 0;
    case 'check': for (const p of problems) io.err(p); return problems.length ? 1 : 0;
    case 'gate': {
      const lines = [...problems, ...uncovered.map((id) => `${id}: not covered by any row`), ...blocking(rows)];
      for (const l of lines) io.err(l);
      io.log(lines.length ? `parity gate: FAIL, ${lines.length} blocking` : 'parity gate: pass');
      return lines.length ? 1 : 0;
    }
    default: io.err('usage: parity.mjs render | uncovered | check | gate'); return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
```

Add to `.d.mts`:

```ts
export function blocking(rows: Row[]): string[];
export function render(rows: Row[], names: Pick<Inventory, 'tag' | 'names'>): string;
export function main(argv: string[], io?: { log: (s: string) => void; err: (s: string) => void }): number;
```

- [ ] **Step 4: Create the empty checklist and render**

```bash
printf '# The x3270 parity checklist. Rules: docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md\n[]\n' > docs/parity/checklist.yaml
node scripts/parity.mjs render
node scripts/parity.mjs gate; echo "exit $?"
```
Expected: `wrote .../docs/parity.md`; the gate prints one `not covered` line per name, then
`parity gate: FAIL, N blocking` with N equal to the inventory's name count; `exit 1`.

- [ ] **Step 5:** `npx vitest run packages/core/test/parity.test.ts`: PASS. `npm run typecheck`: 0.
  Edit one character of `docs/parity.md`, confirm the "exactly what render produces" test fails,
  and restore it.
- [ ] **Step 6: Commit** the scripts, test, `docs/parity/checklist.yaml` and `docs/parity.md`:
  `parity: render, gate, uncovered; the committed files are checked` + attribution.

---

### Task 7: The weekly upstream workflow

**Files:** Create `.github/workflows/parity-upstream.yml`. Modify `packages/core/test/workflow.test.ts`.

- [ ] **Step 1: Write the failing test** (append to `workflow.test.ts`, which reads workflows
  as text on purpose; see its header comment)

```ts
describe('parity-upstream.yml', () => {
  const up = readFileSync(fileURLToPath(new URL('../../../.github/workflows/parity-upstream.yml', import.meta.url)), 'utf8');

  it('runs weekly and on demand', () => {
    expect(up).toMatch(/schedule:\s*\n\s*- cron: '[0-9]+ [0-9]+ \* \* [0-6]'/);
    expect(up).toMatch(/workflow_dispatch:/);
  });

  it('can only read, and uses no secrets', () => {
    expect(up).toMatch(/permissions:\s*\n\s*contents: read\s*\n/);
    expect(up).not.toMatch(/: write\b/);
    expect(up).not.toMatch(/secrets\./);
  });

  it('runs the extractor against the committed inventory, with no npm install', () => {
    expect(up).toMatch(/run: node scripts\/parity-extract\.mjs --upstream docs\/parity\/x3270-names\.json$/m);
    expect(up).not.toMatch(/npm (ci|install)/);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run packages/core/test/workflow.test.ts`: the three new tests
  FAIL (ENOENT), and the existing ones pass.

- [ ] **Step 3: Write the workflow** (pins match `package.yml`: `actions/checkout@v7`,
  `actions/setup-node@v7`; re-check them there first)

```yaml
# Weekly: is there an x3270 GA newer than the one docs/parity/x3270-names.json was extracted from?
# A failure is a notification, not a broken main: regenerate with
#   node scripts/parity-extract.mjs --tag <new>
# and cover every new name in docs/parity/checklist.yaml (parity spec, section 1).
name: parity-upstream
on:
  schedule:
    - cron: '23 7 * * 1'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  upstream:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: '22' }
      - run: node scripts/parity-extract.mjs --upstream docs/parity/x3270-names.json
```

- [ ] **Step 4:** Run the test file: PASS. Then run the command locally:
  `node scripts/parity-extract.mjs --upstream docs/parity/x3270-names.json; echo "exit $?"`.
  Expected: `x3270 4.5ga6 is the newest GA and is the one recorded`, `exit 0`. Then prove the
  other branch: copy the JSON to `/tmp`, set its `"tag"` to `4.5ga5` **and delete one entry
  from its `names`** (relabelling alone gives an empty diff, because the fetched 4.5ga6 is the same
  tree), run `--upstream` on the copy, and expect `exit 1` with the "newer than" line and exactly
  one `+` line naming the deleted id. Don't commit the copy.
- [ ] **Step 5: Commit** `parity: weekly check for a newer x3270 GA` + attribution.

---

### Tasks 8-13: Populate the checklist, one area per task

The research tasks. They have no code to show: what each row says is a finding. These steps
are the procedure and the rules each row must meet.

**Areas and the names that probably belong to them** (decide by meaning, not by file):

| Task | area | typical x3270 sources | our likely counterparts |
|---|---|---|---|
| 8 | `connection` | `host.c`, `telnet.c`, `telnet_new_environ.c`, `sio_*`, `proxy*.c`, `resolver.c`, `prefer.c`, `login_macro.c`, `host_gui.c`, connect menu | `packages/core/src/telnet.ts`, `session.ts`, TLS code, `gui/src/main.ts` connect dialog |
| 9 | `keyboard` | `kybd.c`, `xkybd.c`, `keymap.c`, `keypad.c`, `apl.c`, compose maps | `frontend` keyboard/keymap, keypad, `gui` keyboard window |
| 10 | `display` | `screen.c`, `display*.c`, `status.c`, `select.c`, `codepage.c`, `model.c`, fonts, colour schemes, cursor toggles, scroll | `canvas`, `gui` menus (Model), copy/paste, status line |
| 11 | `files` | `ft*.c`, `print_*.c`, `printer_gui.c`, `pr3287_session.c`, `trace*.c`, `screentrace.c`, `save*.c`, `fprint_screen.c` | transfer (all front ends), trace format, screenshot seam |
| 12 | `scripting` | `task.c`, `childscript.c`, `peerscript.c`, `httpd-*.c`, `json*.c`, `source.c`, `stdinscript.c`, `-script*` options | `packages/cli` (s3270-compatible) |
| 13 | `other` + completeness | everything still uncovered | |

**Procedure for each area task:**

- [ ] **Step 1: List what's left.** `node scripts/parity.mjs uncovered > /tmp/uncovered.txt`, then
  pick the names belonging to this area (by meaning: read each name's x3270 site).
- [ ] **Step 2: Research, read-only.** The controller may dispatch up to 3 read-only subagents in
  parallel for an area, each given a slice of the names. Each returns *proposed rows* as YAML
  text, with no file writes. Give each the full rules below, the spec path, and the instruction
  "the source beats any summary: cite only `file:line`s you opened".
- [ ] **Step 3: Verify every proposed `ours` and `partial` against the repo yourself.** Open each
  cited `file:line` and each cited test. The test must exercise the feature, not just mention it.
  Check `gui` by reading `packages/gui/src/main.ts`'s menu template and dialogs, not by memory. A
  claim that can't be verified becomes `missing`.
- [ ] **Step 4: Write the rows** into `docs/parity/checklist.yaml` (single writer: the controller
  only), grouped under a `# --- <area> ---` comment, each row's keys in the spec's order.
- [ ] **Step 5:** `node scripts/parity.mjs check` exits 0; `node scripts/parity.mjs render`;
  `npx vitest run packages/core/test/parity.test.ts` passes.
- [ ] **Step 6: Commit** `parity: <area> rows (N rows, M names)` + attribution. Report counts per
  status for the area, and list every `proposed-*` row with its draft reason for the user.

**Rules every row must meet** (from the spec; give these verbatim to research agents):

1. One row per **user-visible feature**. Group names that are the same feature (an option, its
   menu item and the action behind them go in one row). Don't make a row per name.
2. **Unsure means `missing`.** `ours` needs `evidence.code` (`file:line` you opened),
   `evidence.tests` (a test that exercises it), and `evidence.live`: a `docs/live-testing.md`
   heading copied exactly, `n/a` when nothing on the wire depends on it, or `unwitnessed`.
3. **Equivalent reach.** If x3270 reaches it by a menu item or dialog, our GUI needs a menu item,
   dialog or preference, or the row is `partial` with `gap` saying what's missing. If x3270 has only
   an option or resource, a flag or persistent preference is enough. The `gui` field says how ours
   is reached, e.g. `menu: Model → 3278-4`, `flag: -model`, `none`.
4. **Never write `decided`.** Rows you'd skip or defer are `proposed-skipped` (with a
   `category`: `x11-only`, `obsolete`, `declined` or `n/a`) or `proposed-deferred`, each with a
   one-sentence `reason` the user can accept or reject. X resources about X itself (fonts by XLFD,
   `-xrm`, icon geometry, input methods) are the typical `x11-only`.
5. `browser` is a one-line informational note; `others` (`tui`, `cli`) only where obvious.
6. Known facts to reuse, from the README (verify the cite before using it): code pages: only
   `cp037`; no proxy support known; no printer sessions/SCS; no click-to-place-cursor or light pen;
   no preferences store or `File → Connect…`; no client certificates; `Attn` sends BREAK even on
   TN3270E (x3270 sends IP), so that row is `partial`; MF orders parsed and not applied.

**Task 13 additionally:**

- [ ] Cover every remaining name (`uncovered` prints nothing).
- [ ] Add the completeness assertion to `the committed checklist` block in `parity.test.ts`:

```ts
  it('covers every x3270 name (list them: node scripts/parity.mjs uncovered)', () => {
    expect(check({ rows: committed, names, root }).uncovered).toEqual([]);
  });
```
- [ ] Run it, then delete one id from one row's `covers`, confirm it fails naming that id, and restore.
- [ ] `node scripts/parity.mjs gate; echo "exit $?"`: report its line count and exit code (expected: 1,
  since `missing`/`partial`/`proposed-*` rows block until the user triages).
- [ ] Commit `parity: every x3270 4.5ga6 name is covered` + attribution.

---

### Task 14: Point the docs at it, and the whole-branch gate

**Files:** Modify `README.md` (*What is not implemented*, first paragraph), `docs/HANDOFF.md`
(new top START HERE entry, title line), `docs/releasing.md` (one paragraph under *Store probe*,
or wherever the store plan is described: find it with `grep -n -i store docs/releasing.md`).

- [ ] **Step 1: README.** After the paragraph "Stated plainly, because …", add:
  `The complete feature-by-feature comparison with x3270 is **[docs/parity.md](docs/parity.md)**,
  generated from \`docs/parity/checklist.yaml\`; the items below are the ones worth prose.`
- [ ] **Step 2: releasing.md.** One paragraph: store submission requires
  `node scripts/parity.mjs gate` to exit 0; the weekly `parity-upstream` workflow and how to
  regenerate on a new GA (`node scripts/parity-extract.mjs --tag <tag>`, then cover the new names).
- [ ] **Step 3: HANDOFF.** A new top entry: what was built, the commit range, the real counts
  (names per kind, rows per status, from `docs/parity.md`'s header, not retyped by hand), the
  gate's current blocking count, and **next: the user triages the `proposed-*` rows, area by
  area**. Update the title line's "next:" accordingly. Check that every summary line you touch
  (title, START HERE heading) agrees with the body.
- [ ] **Step 4: Whole-branch gate**

```bash
npm ci && npm run build && npm run typecheck && npx vitest run
```
Expected: all exit 0. Report the test count and file count, then compare with `main`'s by
checking out `main` in a temp worktree and running `npx vitest run` there. New tests minus zero
lost: list the new test files by name.

- [ ] **Step 5: Commit** `docs: point README, releasing and HANDOFF at the parity checklist` + attribution.
  Don't push or merge; report to the user.
