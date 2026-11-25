import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Oversize } from '@tn3270/core';

/**
 * THE PREFERENCES FILE (spec docs/superpowers/specs/2026-11-24-preferences-store-design.md): a flat
 * JSON object, keyed by our flag names, turned into ordinary flag tokens placed IN FRONT OF the real
 * argv. The front end's own parser then checks every value with the flags' own messages, and
 * defaults < file < flags falls out because each parser keeps the last value it sees.
 */

export type PrefType = 'string' | 'number' | 'onoff' | 'bare';
export interface PrefKey {
  readonly key: string;
  /** The canonical flag. */
  readonly flag: string;
  /** Other spellings the parsers accept for the same setting, so `argvToPrefs` reads them too. */
  readonly aliases?: readonly string[];
  readonly type: PrefType;
}

const COMMON: readonly PrefKey[] = [
  { key: 'model', flag: '-model', type: 'string' },
  { key: 'oversize', flag: '-oversize', type: 'string' },
  { key: 'scheme', flag: '-scheme', type: 'string' },
  { key: 'codepage', flag: '-codepage', aliases: ['-charset'], type: 'string' },
  { key: 'visualbell', flag: '-visualbell', type: 'bare' },
  { key: 'mono', flag: '-mono', type: 'bare' },
  { key: 'highlightbold', flag: '-highlightbold', type: 'bare' },
  { key: 'tn3270e', flag: '-tn3270e', type: 'onoff' },
  { key: 'bind-image', flag: '-bind-image', type: 'onoff' },
  { key: 'bind-limit', flag: '-bind-limit', type: 'onoff' },
  { key: 'ddm', flag: '-ddm', type: 'onoff' },
  { key: 'cafile', flag: '-cafile', type: 'string' },
];

// `cursorcolor` is the GUI's alone: a terminal draws its own cursor (the B2 spec's flag table).
export const GUI_PREF_KEYS: readonly PrefKey[] = [...COMMON, { key: 'cursorcolor', flag: '-cursorcolor', type: 'bare' }];
export const TUI_PREF_KEYS: readonly PrefKey[] = [...COMMON, { key: 'colors', flag: '--colors', type: 'number' }];

/** Keys refused with a reason rather than merely unknown (spec section 2). */
const REFUSED = new Map<string, string>([
  ['insecure', 'a saved TLS weakening would apply silently to every connection; pass -insecure per run'],
  ['noverifycert', 'a saved TLS weakening would apply silently to every connection; pass -noverifycert per run'],
  ['host', 'it belongs to one host; give it on the command line'],
  ['devname', 'it belongs to one host; give it on the command line'],
  ['terminal-type', 'a debugging override, not a preference; give it on the command line'],
]);

/**
 * Every flag, of either front end, that takes a value: `argvToPrefs` must skip a non-stored
 * flag's VALUE too, or `-devname x===` would leave `x===` looking like a host.
 */
const VALUE_FLAGS = new Set([
  '-model', '--terminal-type', '--colors', '-scheme', '-tn3270e', '-bind-image', '-bind-limit', '-ddm',
  '-devname', '-codepage', '-charset', '-oversize', '-cafile',
]);

/** A wrong-typed value: the message names the key, and the caller prefixes the file's name. */
export function prefsToArgv(
  prefs: Readonly<Record<string, unknown>>, keys: readonly PrefKey[],
): { argv: string[]; warnings: string[] } {
  const argv: string[] = [];
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(prefs)) {
    const def = keys.find((d) => d.key === k);
    if (def === undefined) {
      const why = REFUSED.get(k);
      warnings.push(why !== undefined ? `ignoring "${k}": ${why}` : `ignoring unknown key "${k}"`);
      continue;
    }
    switch (def.type) {
      case 'string':
        if (typeof v !== 'string') throw new Error(`"${k}" must be a string`);
        argv.push(def.flag, v);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${k}" must be a number`);
        argv.push(def.flag, String(v));
        break;
      case 'onoff':
        if (typeof v !== 'boolean') throw new Error(`"${k}" must be true or false`);
        argv.push(def.flag, v ? 'on' : 'off');
        break;
      case 'bare':
        if (typeof v !== 'boolean') throw new Error(`"${k}" must be true or false`);
        if (v) argv.push(def.flag);
        break;
    }
  }
  return { argv, warnings };
}

/** The inverse: the stored settings a token list sets, the last occurrence winning. */
export function argvToPrefs(tokens: readonly string[], keys: readonly PrefKey[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const def = keys.find((d) => d.flag === t || (d.aliases?.includes(t) ?? false));
    if (def === undefined) {
      if (VALUE_FLAGS.has(t)) i++;
      continue;
    }
    if (def.type === 'bare') { out[def.key] = true; continue; }
    const v = tokens[i + 1];
    i++;
    if (v === undefined) continue;
    if (def.type === 'onoff') out[def.key] = v === 'on';
    else if (def.type === 'number') out[def.key] = Number(v);
    else out[def.key] = v;
  }
  return out;
}

export function parsePrefsJson(text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON (${(e as Error).message})`);
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('must be a JSON object');
  return v as Record<string, unknown>;
}

/** `-oversize`'s value for a parsed oversize: `none`, `auto` or `<cols>x<rows>`. */
export function oversizeFlagValue(o: Oversize): string {
  return o.kind === 'fixed' ? `${o.cols}x${o.rows}` : o.kind;
}

/** The fs calls the store needs, injected so tests use memory. */
export interface PrefsFs {
  readFile(path: string): string | undefined;
  writeFile(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdir(path: string): void;
}

/** Load: a missing file is no preferences. Errors name the file's basename. */
export function loadPrefs(
  path: string, keys: readonly PrefKey[], fs: PrefsFs,
): { argv: string[]; warnings: string[] } {
  const text = fs.readFile(path);
  if (text === undefined) return { argv: [], warnings: [] };
  const name = basename(path);
  try {
    const r = prefsToArgv(parsePrefsJson(text), keys);
    return { argv: r.argv, warnings: r.warnings.map((w) => `${name}: ${w}`) };
  } catch (e) {
    throw new Error(`${name}: ${(e as Error).message}`);
  }
}

/**
 * Save atomically (a temporary file, then a rename), creating the directory, and keeping any keys
 * the existing file has that this version does not store, so a newer version's settings survive.
 * Returns how many settings this version wrote.
 */
export function savePrefs(
  path: string, prefs: Readonly<Record<string, unknown>>, keys: readonly PrefKey[], fs: PrefsFs,
): number {
  let kept: Record<string, unknown> = {};
  const old = fs.readFile(path);
  if (old !== undefined) {
    try {
      const o = parsePrefsJson(old);
      kept = Object.fromEntries(Object.entries(o).filter(([k]) => !keys.some((d) => d.key === k)));
    } catch {
      // An unreadable old file is replaced: the user asked to save, and there is nothing to keep.
    }
  }
  fs.mkdir(dirname(path));
  const tmp = `${path}.tmp`;
  fs.writeFile(tmp, `${JSON.stringify({ ...kept, ...prefs }, null, 2)}\n`);
  fs.rename(tmp, path);
  return Object.keys(prefs).length;
}

/** The real filesystem. A missing file reads as undefined; any other read error is thrown. */
export const nodePrefsFs: PrefsFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  },
  writeFile(path, text) { writeFileSync(path, text, 'utf8'); },
  rename(from, to) { renameSync(from, to); },
  mkdir(path) { mkdirSync(path, { recursive: true }); },
};
