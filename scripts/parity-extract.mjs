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

// A name field can be a bare identifier, a string literal, or (suite3270 4.5ga6
// x3270/xactions.c, e.g. `{ PA_PFX "ConfigureNotify", ... }`) a run of either, space-separated
// (a macro prefix concatenated with a literal, C-style). The plan's draft only matched a single
// bare token or literal, which silently dropped all 13 `PA_PFX "..."` entries in xactions.c;
// over-include means accepting the run and resolving/flagging it below.
const NAME_TOKEN = '(?:\\w+|"(?:[^"\\\\]|\\\\.)*")';
const NAME_FIELD = new RegExp(`^${NAME_TOKEN}(?:\\s+${NAME_TOKEN})*$`);

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
    // Resolve a (possibly multi-token) action/xaction name field: concatenate each literal or
    // Ident piece, local #defines first, then names.h/resources.h; an unresolved identifier is
    // kept as its own text (so the result is still a usable, if ugly, id) and flagged.
    const actionName = (raw, line) => {
      if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) return raw.slice(1, -1);
      const tokens = raw.match(/"(?:[^"\\]|\\.)*"|\w+/g) ?? [];
      let ok = true, s = '';
      for (const t of tokens) {
        if (t.startsWith('"')) { s += t.slice(1, -1); continue; }
        const v = local.has(t) ? local.get(t) : defs.get(t);
        if (v === undefined) { ok = false; s += t; } else s += v;
      }
      if (!ok) unresolved.push(`${raw} at ${file}:${line}`);
      return s;
    };

    for (const e of tables(text, /\baction_table_t\s+\w+\s*\[\s*\]\s*=\s*\{/g)) {
      const f = fields(e.body);
      if (!NAME_FIELD.test(f[0] ?? '') || /\bACTION_HIDDEN\b/.test(f[2] ?? '')) continue;
      add('action', actionName(f[0], e.line), file, e.line, guards);
    }
    // The pure Xt actions (x3270/xactions.c): bindable in keymaps, so reachable by a user.
    for (const e of tables(text, /\bXtActionsRec\s+xactions\s*\[\s*\]\s*=\s*\{/g)) {
      const [name] = fields(e.body);
      if (NAME_FIELD.test(name ?? '')) add('xaction', actionName(name, e.line), file, e.line, guards);
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
