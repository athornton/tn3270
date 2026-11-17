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
