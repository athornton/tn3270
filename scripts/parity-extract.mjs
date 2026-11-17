#!/usr/bin/env node
// Extracts the x3270 feature-name inventory for the parity checklist
// (docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md, section 1 and its
// amendment). Reads an x3270 source tree as TEXT ONLY: nothing in it is built or run.
// No npm dependencies, so parity-upstream.yml runs this without `npm ci`.
//
// Exit codes (`main`'s return value, and `process.exitCode` when run as a script):
//   0  success: --dir/--tag wrote the inventory, or --upstream found the recorded tag current.
//   1  --upstream found a newer GA upstream: a notification, printed with the name/site diff.
//   2  usage error (bad or missing arguments).
//   3  any other error: network failure, a non-OK GitHub response, malformed JSON, an invalid
//      --tag, or a curl/tar failure.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * If `text[i]` opens a string literal (`"..."`), a character literal (`'x'`, `'\''`, `'"'`,
 * `'{'`, ...), a C block comment (possibly multi-line), or a `//`-to-end-of-line comment, returns
 * the index just past it (bounded by `text.length`); otherwise returns `i` unchanged.
 *
 * One shared lexer step, used everywhere this file scans C text character by character
 * (`entries()`, `callArgs()`, `fields()`, and `stripComments()` below), so a quote, brace, or
 * paren inside a literal or comment can never be mistaken for real syntax. It also fixes a hang:
 * `String.indexOf('"', i)` (the old per-function logic) is blind to escapes, so on `"a\"b"` it
 * found the escaped quote as if it were the closing one, under-consumed the literal, and then
 * (closing-quote search failing, returning -1) looped forever. Every caller is bounded by
 * `text.length` for the same reason: an unterminated literal or comment must still end the scan.
 *
 * A quote or character literal is also bounded by the end of its own line: real C string/char
 * literals can't span a physical line, so an unterminated one (a stray apostrophe, e.g.
 * `#error don't`) is not a literal at all here -- `i` is returned unchanged, leaving the quote
 * character to be scanned as ordinary text. Without this, that apostrophe would search for its
 * "closing" quote arbitrarily far into the rest of the file, swallowing real `{`/`}`/`,` syntax
 * (and whole table entries) along the way.
 */
function skipAtom(text, i) {
  const c = text[i];
  if (c === '"' || c === "'") {
    const nl = text.indexOf('\n', i);
    const limit = nl === -1 ? text.length : nl;
    let j = i + 1;
    while (j < limit && text[j] !== c) { if (text[j] === '\\') j++; j++; }
    if (j >= limit) return i; // unterminated before end of line: not a real literal
    return Math.min(j + 1, text.length);
  }
  if (c === '/' && text[i + 1] === '*') {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (c === '/' && text[i + 1] === '/') {
    const end = text.indexOf('\n', i + 2);
    return end === -1 ? text.length : end + 1;
  }
  return i;
}

/**
 * `text` with backslash-continued lines joined and comments removed, but with the contents of
 * string/character literals left untouched (so e.g. `#define HTTP_PREFIX "http://"`, real text in
 * x3270/select.c, survives: a blind `s.replace(/\/\/.*$/gm, '')` would truncate it at the `//`).
 * A stripped `/* *‍/` becomes a single space (so tokens on either side don't glue together); a
 * stripped `//...` keeps its line's newline, so line-oriented matching after this still works.
 */
function stripComments(text) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  let out = '';
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === '"' || c === "'") {
      const skip = skipAtom(joined, i);
      if (skip === i) { out += c; continue; } // unterminated before EOL: not a real literal
      out += joined.slice(i, skip);
      i = skip - 1;
      continue;
    }
    if (c === '/' && joined[i + 1] === '*') {
      out += ' ';
      i = skipAtom(joined, i) - 1;
      continue;
    }
    if (c === '/' && joined[i + 1] === '/') {
      const nl = joined.indexOf('\n', i + 2);
      if (nl === -1) break; // comment runs to EOF: nothing more to keep
      i = nl - 1; // land back on the '\n' itself, which the default branch below keeps
      continue;
    }
    out += c;
  }
  return out;
}

/** Value of a Makefile variable, continuation lines joined, as object basenames without `.o`.
 * Both plain (`NAME = ...`) and continuation (`NAME += ...`) assignment lines are collected, in
 * order, and their object lists concatenated. */
export function makeVar(text, name) {
  const joined = text.replace(/\\\r?\n/g, ' ');
  const matches = [...joined.matchAll(new RegExp(`^${name}\\s*\\+?=(.*)$`, 'gm'))];
  if (!matches.length) throw new Error(`makefile has no ${name}`);
  return matches.flatMap((m) => m[1].trim().split(/\s+/).filter(Boolean).map((o) => o.replace(/\.o$/, '')));
}

/** `#define Name <string-literal | Ident>...` -> Map(Name -> string). Non-string defines are
 * dropped. Comments (`//`, `/* *‍/`, possibly multi-line) are stripped and backslash-continued
 * lines joined first, via `stripComments()`, so neither can swallow or split a definition. */
export function parseDefines(text) {
  const clean = stripComments(text);
  const raw = new Map();
  for (const m of clean.matchAll(/^#\s*define\s+(\w+)\s+(.+)$/gm)) {
    raw.set(m[1], m[2].trim());
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

// Each linked object group: the file(s)/variable(s) its *_OBJECTS list(s) come from, any object
// added outside of those variables, and its VPATH (`lib/*/Makefile.in`'s, or x3270/Makefile.in's,
// `VPATH = $(this):$(top)/Common[:.../Nodisplay]`), resolved in that order: the first VPATH
// directory where `<obj>.c` exists wins. VPATH resolution (not a fixed directory per group)
// matters for real reasons, not hypothetical ones: LIB3270U_OBJECTS' find_console.o and
// print_command.o, and LIB32XXU_OBJECTS' xpopen.o, are declared under lib/ but their `.c`s live
// in Common/; and LIB3270_OBJECTS' resources.o has no Common/resources.c at all -- only
// Common/Nodisplay/resources.c, lib3270's third VPATH entry.
//
// lib3270stubs is excluded (per the original amendment) even though x3270 does link it
// (Makefile.obj.in's LD3270STUBS): it is a stub/no-op implementation of an alternate backend,
// contributing no feature names of its own. The X widget library (Cme*, CmplxMenu, Husk) is
// excluded the same way it always was, via WIDGET_OBJECTS.
//
// x3270/Makefile.obj.in separately adds `fallbacks.o` (from a generated fallbacks.c) and
// `version.o` (from a generated, timestamp/version-stamped xversion.c) to its link; neither is
// read from X3270_OBJECTS (the variable this file parses), so neither ever reaches this list --
// which is correct, since both are build-time-generated, not real feature source.
const LIBS = [
  {
    objVars: [['x3270/x3270_files.mk', 'X3270_OBJECTS']],
    extra: [],
    vpath: ['x3270', 'Common'],
    widgetFilter: true,
  },
  {
    objVars: [['Common/lib3270_files.mk', 'LIB3270_OBJECTS'], ['lib/3270/lib3270u_files.mk', 'LIB3270U_OBJECTS']],
    extra: [],
    vpath: ['lib/3270', 'Common', 'Common/Nodisplay'],
  },
  {
    objVars: [['Common/lib3270i_files.mk', 'LIB3270I_OBJECTS']],
    extra: [],
    vpath: ['lib/3270i', 'Common'],
  },
  {
    objVars: [['Common/lib32xx_files.mk', 'LIB32XX_OBJECTS'], ['lib/32xx/lib32xxu_files.mk', 'LIB32XXU_OBJECTS']],
    // The Unix GA-default TLS module (lib/configure.in:254-262): sio_openssl.o, unless
    // --enable-mock-tls (sio_mock.o) or macOS Secure Transport (sio_secure_transport.o) was
    // selected -- not something this text-only extractor can detect, so the GA Unix default is
    // taken unconditionally. It is substituted into lib/32xx/Makefile.obj.in's OBJS via
    // `@TLS_MODULES@`, not read from an *_OBJECTS variable, so it's listed here instead.
    extra: ['sio_openssl'],
    vpath: ['lib/32xx', 'Common'],
  },
];

/** True if `read(path)` succeeds; false if it throws an ENOENT-coded error; rethrows anything
 * else (a real problem, not a "this VPATH directory doesn't have it"). */
function existsAt(read, path) {
  try { read(path); return true; }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}

// LIBS above is pinned (hardcoded), not derived by reading x3270's build files each run -- so
// drift between it and the real tree would otherwise be silent. These are the two facts LIBS
// depends on: x3270/Makefile.obj.in's link line names exactly these $(LD...) libraries
// (LD3270STUBS is deliberately excluded from LIBS: lib3270stubs contributes no feature names),
// and lib/configure.in's Unix TLS default is sio_openssl.o. checkLinkageDrift() verifies both
// against the real files on every run and throws loudly if either has changed.
const EXPECTED_LD_LIBS = ['LD3270', 'LD3270I', 'LD32XX', 'LD3270STUBS'];
const DRIFT = 'x3270 linkage changed: update LIBS in scripts/parity-extract.mjs';

function checkLinkageDrift(read) {
  const obj = read('x3270/Makefile.obj.in');
  const linkLine = obj.split('\n').find((l) => /\$\(CC\)\s+-o\s+\$@\s+\$\(OBJS1\)/.test(l));
  if (!linkLine) throw new Error(`${DRIFT} (x3270/Makefile.obj.in's link line was not found)`);
  // `LD\d\w*` (not `LD\w+`): the library macros are LD3270/LD3270I/LD32XX/LD3270STUBS, always
  // digit-after-LD; `$(LDFLAGS)` on the same line is a different thing entirely and must not match.
  const found = [...linkLine.matchAll(/\$\((LD\d\w*)\)/g)].map((m) => m[1]);
  const expected = EXPECTED_LD_LIBS;
  if (found.length !== expected.length || !found.every((l) => expected.includes(l))) {
    throw new Error(`${DRIFT} (link line now names [${found.join(', ')}], expected [${expected.join(', ')}])`);
  }

  const cfg = read('lib/configure.in');
  if (!/TLS_MODULES\s*=\s*sio_openssl\.o/.test(cfg)) {
    throw new Error(`${DRIFT} (lib/configure.in no longer defaults TLS_MODULES to sio_openssl.o on Unix)`);
  }
}

/** The `.c` files linked, resolved through each group's VPATH, and the object basenames resolved
 * in none of them (`missingSources`; e.g. `favicon`, generated at build time -- not an error).
 * `read(path)` returns file text, or throws an ENOENT-coded error for a path that doesn't exist.
 * Throws first if the real tree's linkage no longer matches what LIBS is pinned to (see
 * `checkLinkageDrift()`). */
export function linkedSources(read) {
  checkLinkageDrift(read);
  const sources = new Set();
  const missingSources = new Set();
  for (const lib of LIBS) {
    const objs = lib.objVars.flatMap(([f, v]) => makeVar(read(f), v)).concat(lib.extra);
    const filtered = lib.widgetFilter ? objs.filter((o) => !WIDGET_OBJECTS.test(o)) : objs;
    for (const o of filtered) {
      const hit = lib.vpath.map((d) => `${d}/${o}.c`).find((p) => existsAt(read, p));
      if (hit) sources.add(hit); else missingSources.add(o);
    }
  }
  return { sources: [...sources].sort(), missingSources: [...missingSources].sort() };
}

/** Per 0-based line, the preprocessor condition in force (joined with ` && `), or null.
 * `#elif`'s condition replaces (rather than conjoins with the negation of) the branch above it,
 * so a guard reported for an `#elif` or its `#else` is approximate: it omits the earlier
 * branches' negation that the real preprocessor also requires. */
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

/** Text of each `{ ... }` entry in the array literal opened at `open` (index of `{`), with its 1-based line. */
function entries(text, open) {
  const out = [];
  let depth = 0, start = -1;
  for (let i = open; i < text.length; i++) {
    const skip = skipAtom(text, i);
    if (skip !== i) { i = skip - 1; continue; }
    const c = text[i];
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
    const skip = skipAtom(body, i);
    if (skip !== i) { cur += body.slice(i, skip); i = skip - 1; continue; }
    const c = body[i];
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
    const skip = skipAtom(text, i);
    if (skip !== i) { i = skip - 1; continue; }
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

const MENU_CALL = /\b(add_menu_itemv|toggle_init|Xt\w*Create\w*(?:Widget|PopupShell))\s*\(/g;
// x3270/x3270.c only: option_help[]'s declaration has no common type tag to key off (it's an
// anonymous `static struct option_help { ... } option_help[] = {`), so it's matched by name.
const OPTION_HELP_TABLE = /\boption_help\s*\[\s*\]\s*=\s*\{/g;
// x3270/x3270.c only (around x3270.c:497-505): a lone "-v"/"--version"/"--help"/"-?" is matched
// by direct string compare in main(), before the option tables are even consulted, so these
// never appear in base_options or option_help and would otherwise be missed entirely.
const STRCMP_OPTION = /!strcmp\(argv\[1\],\s*(Opt\w+)\)/g;
// x3270/ files only: a resource fetched by a literal name that has no Res*/Opt*/Dot* macro at
// all (e.g. keymap.c:309's "serverKeymapList"), so the resources.h-`#define`-driven scan below
// can never find it.
const GET_RESOURCE_CALL = /\bget_resource\(\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * The six kinds of name, over the linked `files`. `read(path)` returns file text, or throws an
 * ENOENT-coded error for a file genuinely absent (tracking that is the caller's job, e.g. via
 * `linkedSources()`'s `missingSources`); any other thrown error is a real problem and propagates.
 * @returns {{ names: object[], unresolved: string[], nonLiteralMenuCalls: string[], privateXactions: number }}
 */
export function extractNames(read, files) {
  const defs = parseDefines(`${read('include/names.h')}\n${read('include/resources.h')}`);
  const names = new Map();
  const unresolved = [];
  const nonLiteralMenuCalls = [];
  const literalResources = []; // get_resource("literal") candidates; filtered once all files are seen
  let privateXactions = 0;
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
    try { text = read(file); } catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }
    const guards = guardsByLine(text);
    for (const t of text.match(/\b(?:Res|Dot)\w+/g) ?? []) used.add(t);
    const local = parseDefines(text); // e.g. Common/task.c's RESUME_INPUT
    const actionName = (token, line) => (local.has(token) ? local.get(token) : resolveName(token, file, line));

    for (const e of tables(text, /\baction_table_t\s+\w+\s*\[\s*\]\s*=\s*\{/g)) {
      const f = fields(e.body);
      if (/\bACTION_HIDDEN\b/.test(f[2] ?? '')) continue;
      if (!/^(\w+|"[^"]*")$/.test(f[0] ?? '')) { unresolved.push(`${f[0] ?? ''} at ${file}:${e.line}`); continue; }
      add('action', actionName(f[0], e.line), file, e.line, guards);
    }
    // The pure Xt actions (x3270/xactions.c): bindable in keymaps, so reachable by a user.
    // x3270's own event-handler actions ("private Xt actions": PA_END, PA_KEYMAP_TRACE, and the
    // PA_PFX-concatenated Expose/Focus/WMProtocols/etc. entries) are internal plumbing, not
    // user-bindable commands, and are counted in privateXactions instead of listed.
    for (const e of tables(text, /\bXtActionsRec\s+xactions\s*\[\s*\]\s*=\s*\{/g)) {
      const [name] = fields(e.body);
      if (/^PA_\w+/.test(name ?? '')) { privateXactions++; continue; }
      if (!/^(\w+|"[^"]*")$/.test(name ?? '')) { unresolved.push(`${name ?? ''} at ${file}:${e.line}`); continue; }
      add('xaction', actionName(name, e.line), file, e.line, guards);
    }
    // Options: x3270's own Xrm table (base_options[]), option_help[] (adds flag-only OptV
    // and OptVersion, with no Xrm entry of their own), and OptHelp1/OptHelp2's main() literal
    // compare -- x3270's register_opts() is a no-op (x3270/x3270.c:1356), so the opt_t tables in
    // Common/ never reach it. Sites merge by id, so an option in both base_options and
    // option_help keeps one entry with both sites.
    for (const e of tables(text, /\bXrmOptionDescRec\s+\w+\s*\[\s*\]\s*=\s*\{/g)) {
      const f = fields(e.body);
      if (!/^Opt\w+$/.test(f[0] ?? '')) continue;
      const dot = /^Dot\w+$/.test(f[1] ?? '') ? defs.get(f[1]) : undefined;
      const res = dot?.startsWith('.') ? dot.slice(1) : undefined;
      if (res) optionResources.add(res);
      add('option', resolveName(f[0], file, e.line), file, e.line, guards, { resource: res });
    }
    if (file === 'x3270/x3270.c') {
      for (const e of tables(text, OPTION_HELP_TABLE)) {
        const [name] = fields(e.body);
        if (/^Opt\w+$/.test(name ?? '')) add('option', resolveName(name, file, e.line), file, e.line, guards);
      }
      for (const m of text.matchAll(STRCMP_OPTION)) {
        add('option', resolveName(m[1], file, lineOf(text, m.index)), file, lineOf(text, m.index), guards);
      }
    }
    for (const e of tables(text, /\btoggle_name_t\s+toggle_names\s*\[\s*\]\s*=\s*\{/g)) {
      const [res] = fields(e.body);
      if (!/^Res\w+$/.test(res ?? '')) continue;
      const v = resolveName(res, file, e.line);
      toggleResources.add(v);
      add('toggle', v, file, e.line, guards);
    }
    if (file.startsWith('x3270/')) {
      for (const m of text.matchAll(GET_RESOURCE_CALL)) {
        literalResources.push({ value: m[1], file, line: lineOf(text, m.index), guards });
      }
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

  // get_resource("literal") names, unless an option or toggle already sets that resource.
  for (const { value, file, line, guards } of literalResources) {
    if (optionResources.has(value) || toggleResources.has(value)) continue;
    add('resource', value, file, line, guards);
  }

  const resText = read('include/resources.h');
  const resGuards = guardsByLine(resText);
  for (const m of resText.matchAll(/^#\s*define\s+(Res\w+)\b/gm)) {
    const line = lineOf(resText, m.index);
    const value = defs.get(m[1]);
    if (value === undefined) { unresolved.push(`${m[1]} at include/resources.h:${line}`); continue; }
    if (optionResources.has(value) || toggleResources.has(value)) continue;
    const dots = [...defs.keys()].filter((k) => k.startsWith('Dot') && defs.get(k) === `.${value}`);
    if (!used.has(m[1]) && !dots.some((d) => used.has(d))) continue;
    add('resource', value, 'include/resources.h', line, resGuards);
  }

  // `path:line` ascending: path in code-unit order, then line as a number, never locale
  // collation -- stable across locales, and doesn't e.g. sort "...:10" before "...:2" as text.
  const compareAt = (a, b) => {
    const ai = a.lastIndexOf(':'), bi = b.lastIndexOf(':');
    const ap = a.slice(0, ai), bp = b.slice(0, bi);
    if (ap !== bp) return ap < bp ? -1 : 1;
    return Number(a.slice(ai + 1)) - Number(b.slice(bi + 1));
  };
  for (const n of names.values()) n.sites.sort((a, b) => compareAt(a.at, b.at));
  return {
    names: [...names.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    unresolved: [...new Set(unresolved)].sort(),
    nonLiteralMenuCalls: nonLiteralMenuCalls.sort(compareAt),
    privateXactions,
  };
}

const GA = /^(\d+)\.(\d+)ga(\d+)$/;
const TAG = /^\d+\.\d+(?:alpha|beta|ga)\d+$/;

/** [major, minor, ga] numeric key for an `M.NgaP` tag. Throws if `t` doesn't match; callers that
 * haven't already checked with `GA.test` (e.g. a recorded tag of unknown shape) get that thrown
 * as a regular error, which `main` turns into exit 3. */
function gaKey(t) {
  const m = t.match(GA);
  if (!m) throw new Error(`not a GA tag: ${t}`);
  return m.slice(1).map(Number);
}

/** Numeric ordering of two GA tags by `gaKey` (negative if `a` is older than `b`, 0 if equal). */
function compareGa(a, b) {
  const [x, y] = [gaKey(a), gaKey(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The newest `M.NgaP` tag in `tags`, or undefined if none is a GA tag. Alpha/beta tags are
 * ignored; GA tags are ordered by `compareGa`'s numeric key (not lexically: `ga10` sorts after
 * `ga6`, and `4.10` after `4.9`) -- the same key a recorded tag is compared against in `main`. */
export function newestGa(tags) {
  return tags.filter((t) => GA.test(t)).sort(compareGa).at(-1);
}

/** Renders an inventory as stable (sorted, deterministic) JSON with a trailing newline, the
 * source and tag first. */
export function renderInventory({ tag, missingSources, unresolved, nonLiteralMenuCalls, privateXactions, names }) {
  return `${JSON.stringify(
    { source: 'pmattes/x3270', tag, missingSources, unresolved, nonLiteralMenuCalls, privateXactions, names },
    null,
    2,
  )}\n`;
}

/** Names added, removed, or whose sites moved, between two inventories: one line each, `+`/`-`/`~`. */
export function diffNames(oldInv, newInv) {
  const sites = (n) => n.sites.map((s) => s.at).join(', ');
  const before = new Map(oldInv.names.map((n) => [n.id, n]));
  const after = new Map(newInv.names.map((n) => [n.id, n]));
  const added = [...after.values()].filter((n) => !before.has(n.id)).map((n) => `+ ${n.id} (${sites(n)})`);
  const removed = [...before.values()].filter((n) => !after.has(n.id)).map((n) => `- ${n.id} (${sites(n)})`);
  const moved = [...after.values()]
    .filter((n) => before.has(n.id) && sites(before.get(n.id)) !== sites(n))
    .map((n) => `~ ${n.id} ${sites(before.get(n.id))} -> ${sites(n)}`);
  return [...added, ...removed, ...moved];
}

/** Inventory of the x3270 tree at `root`. Reports the tag from `Common/version.txt`, and the
 * linked `.c` files' `missingSources` exactly as `linkedSources()` reports them (object
 * basenames, e.g. 'favicon') rather than recomputing which files exist. */
export function inventory(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8');
  const tag = read('Common/version.txt').match(/^version="([^"]+)"/m)?.[1];
  if (!tag) throw new Error(`${root}: no version= in Common/version.txt`);
  const { sources, missingSources } = linkedSources(read);
  return { tag, missingSources, ...extractNames(read, sources) };
}

/** Downloads and unpacks the x3270 GitHub release tarball for `tag` into a fresh temp
 * directory; returns the extracted tree's root. `tag` is validated against `TAG` before it ever
 * reaches a URL or a shell argument. curl and tar both run with the temp dir as cwd, never the
 * untrusted tree itself. On a curl/tar failure the partial download directory is removed before
 * the error propagates. A caller of `fetchTag` directly (rather than `withTag`) is responsible
 * for removing the returned root's parent directory itself once done with it. */
export function fetchTag(tag) {
  if (!TAG.test(tag)) throw new Error(`not an x3270 tag: ${tag}`);
  const dir = mkdtempSync(join(tmpdir(), 'x3270-'));
  try {
    const tgz = join(dir, 'src.tgz');
    const url = `https://github.com/pmattes/x3270/archive/refs/tags/${tag}.tar.gz`;
    for (const [cmd, args] of [
      ['curl', ['-fsSL', '-o', tgz, url]],
      // --no-same-owner: we're not root, and don't want the archive's original ownership
      // restored anyway. Extraction otherwise relies on tar's own default refusal to write a
      // member whose path has a '..' segment or is absolute -- true of GNU tar, and these are
      // plain GitHub release tarballs, not an attacker-chosen archive format or flags.
      ['tar', ['-xzf', tgz, '-C', dir, '--no-same-owner']],
    ]) {
      const r = spawnSync(cmd, args, { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
      if (r.status !== 0) throw new Error(`${cmd} failed for ${url}`);
    }
    return join(dir, `x3270-${tag}`);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Fetches `tag` into a temp directory, calls `fn(root)`, and removes the temp directory
 * afterward -- in a `finally`, so it's removed whether `fn` returns or throws. (A curl/tar
 * failure's directory is already gone by the time this `finally` runs; see `fetchTag`.) */
export function withTag(tag, fn) {
  const root = fetchTag(tag);
  try {
    return fn(root);
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
}

const GITHUB_TAGS_URL = 'https://api.github.com/repos/pmattes/x3270/tags';

function githubHeaders() {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchTagsPage(page) {
  const r = await fetch(`${GITHUB_TAGS_URL}?per_page=100&page=${page}`, { headers: githubHeaders() });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    const limited = r.headers.get('x-ratelimit-remaining') === '0';
    const reason = limited ? 'rate limited' : (body?.message ?? r.statusText);
    throw new Error(`GitHub tags: HTTP ${r.status} (${reason})`);
  }
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('GitHub tags: unexpected response shape (not an array)');
  return data.map((t) => t.name);
}

// GitHub lists a repo's tags newest-first, so one page of 100 almost always already contains the
// newest GA. A second page is fetched anyway -- cheap insurance against a repo with over 100
// tags since the last GA -- but only when the first page came back full (100 items); a short
// first page proves there's no more to fetch.
async function upstreamTags() {
  const page1 = await fetchTagsPage(1);
  if (page1.length < 100) return page1;
  return [...page1, ...await fetchTagsPage(2)];
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(SCRIPT_DIR, '..', 'docs/parity/x3270-names.json');

const USAGE = 'usage: parity-extract.mjs (--dir <tree> | --tag <tag>) [--out <file>] | --upstream <committed.json>\n'
  + 'exit codes: 0 current/success, 1 newer GA found upstream, 2 usage error, 3 other error';

/**
 * @param {string[]} argv
 * @param {{ log: (s: string) => void, err: (s: string) => void }} [io]
 * @param {{ tags?: () => Promise<string[]> | string[], inventoryForTag?: (tag: string) => Promise<object> | object }} [deps]
 *   Injected for testing without the network: `tags` replaces the GitHub tags fetch, and
 *   `inventoryForTag` replaces `(tag) => withTag(tag, inventory)` (used by both --upstream and
 *   --tag, so a test never needs a real download).
 */
export async function main(argv, io = { log: console.log, err: console.error }, deps = {}) {
  const getTags = deps.tags ?? upstreamTags;
  const getInventoryForTag = deps.inventoryForTag ?? ((tag) => withTag(tag, inventory));
  const [mode, arg, ...rest] = argv;
  try {
    if (mode === '--upstream' && arg && rest.length === 0) {
      const committed = JSON.parse(readFileSync(arg, 'utf8'));
      if (typeof committed.tag !== 'string') throw new Error(`${arg}: no tag recorded`);
      const ga = newestGa(await getTags());
      if (!ga) throw new Error('no GA tag upstream');
      const cmp = compareGa(ga, committed.tag);
      if (cmp === 0) {
        io.log(`x3270 ${ga} is the newest GA and is the one recorded`);
        return 0;
      }
      if (cmp < 0) {
        throw new Error(`recorded ${committed.tag} is newer than upstream's newest GA ${ga}: the tag list looks wrong`);
      }
      const lines = diffNames(committed, await getInventoryForTag(ga));
      io.err(`x3270 ${ga} is newer than the recorded ${committed.tag}: regenerate with --tag ${ga}`);
      for (const l of lines) io.err(l);
      return 1;
    }
    if ((mode === '--dir' || mode === '--tag') && arg) {
      let out = DEFAULT_OUT;
      if (rest.length > 0) {
        if (rest.length !== 2 || rest[0] !== '--out') { io.err(USAGE); return 2; }
        out = rest[1];
      }
      const inv = mode === '--dir' ? inventory(resolve(arg)) : await getInventoryForTag(arg);
      writeFileSync(out, renderInventory(inv));
      io.log(
        `${out}: x3270 ${inv.tag}, ${inv.names.length} names, ${inv.missingSources.length} missing sources, `
        + `${inv.unresolved.length} unresolved, ${inv.nonLiteralMenuCalls.length} non-literal menu calls`,
      );
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (e) {
    io.err(`parity-extract: ${e.message}`);
    return 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
