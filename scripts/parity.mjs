#!/usr/bin/env node
// The x3270 parity checklist: check, render, gate
// (docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md, sections 2-3).
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const AREAS = ['connection', 'keyboard', 'display', 'files', 'scripting', 'other'];
export const STATUSES = ['ours', 'partial', 'missing', 'proposed-deferred', 'proposed-skipped', 'deferred', 'skipped'];
export const CATEGORIES = ['x11-only', 'obsolete', 'declined', 'n/a'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The spec's row fields (section 2), and evidence's. Anything else is a problem, so a misspelt
// key (`accept-unwitnesed`, `evidence.test`) is reported instead of silently meaning nothing.
const ROW_KEYS = new Set([
  'id', 'area', 'title', 'covers', 'x3270', 'gui', 'status', 'gap', 'reason', 'category', 'decided',
  'evidence', 'accept-unwitnessed', 'browser', 'others',
]);
const EVIDENCE_KEYS = new Set(['code', 'tests', 'live']);
/** Orders rows by id, in code-unit order; 0 for equal ids, so a sort keeps them as given. */
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const DECIDED = /^(\d{4})-(\d{2})-(\d{2}), user$/;

/** True for a real calendar date in "YYYY-MM-DD, user" (month 01-12, day valid for that
 * month/year, leap years included). A syntactically matching but impossible date (`2026-13-45`)
 * is rejected, not just a malformed string. */
function validDecided(s) {
  if (typeof s !== 'string') return false;
  const m = DECIDED.exec(s);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}\s(.*)$/;

/**
 * Heading texts of a markdown file: a line outside a fenced code block, with 0-3 leading spaces
 * then 1-6 `#`s and a space. An optional closing run of `#`s is removed; the rest -- asterisks,
 * underscores, backticks -- is kept verbatim, so a citation must be copied exactly, markup and
 * all.
 *
 * Fences pair by kind and length, per CommonMark: a fence opened with N backticks closes only on
 * a line of >= N backticks (same for tildes), so a ```` block can contain a ``` line -- and a
 * `#`-looking line -- without either ending it early.
 */
function headings(text) {
  const out = [];
  let fence = null; // { char: '`' | '~', len: number } | null
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (m) { fence = { char: m[1][0], len: m[1].length }; continue; }
    const hm = HEADING.exec(line);
    if (!hm) continue;
    out.push(hm[1].replace(/\s+#+$/, '').trim());
  }
  return out;
}

const LINE = /^[1-9]\d*$/;

/**
 * Validates one `file` or `file:line` citation against the repo root. Returns a problem message,
 * or null if the citation is fine; never throws. In particular, a directory is rejected by
 * `isFile()` *before* any attempt to read it for a line count, which is what keeps a citation
 * like `src:1` from throwing EISDIR (the bug this replaces).
 *
 * Existence is checked on the lexically-resolved path first (so a missing citation is reported,
 * not crashed on -- `realpathSync` throws ENOENT), and only then is the real path resolved
 * (following symlinks) to check it stays inside the repo root. That order means a symlink that
 * physically lives inside the repo but points outside it is still refused: resolving the
 * citation lexically would never notice.
 */
/**
 * Does `rel`, a `path.relative(root, x)` result, leave the root?
 *
 * Either separator, because `path.relative` uses `\\` on Windows: a `startsWith('../')` test caught
 * nothing there (windows-latest, run 44142799663). The FIRST segment must be exactly `..`, so
 * `..foo/x` stays inside. A different drive comes back absolute (`D:\\x`), so that counts too, on
 * any platform -- `isAbsolute` alone would not see a drive letter from Linux.
 */
export function escapesRoot(rel) {
  return rel.split(/[\\/]/)[0] === '..' || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || /^[\\/]/.test(rel);
}

function citationProblem(root, cite) {
  const i = cite.indexOf(':');
  const file = i === -1 ? cite : cite.slice(0, i);
  const lineStr = i === -1 ? undefined : cite.slice(i + 1);
  if (lineStr !== undefined && !LINE.test(lineStr)) return `${cite}: line must be a positive integer`;
  if (isAbsolute(file)) return `${cite}: must be a repo-relative path, not absolute`;
  const resolved = resolve(root, file);
  if (!existsSync(resolved)) return `${file} does not exist`;
  const real = realpathSync(resolved);
  const realRoot = realpathSync(root);
  const rel = relative(realRoot, real);
  if (escapesRoot(rel)) return `${cite}: path escapes the repo root`;
  if (!statSync(real).isFile()) return `${file || '(empty)'} is not a regular file`;
  if (lineStr !== undefined) {
    const count = readFileSync(real, 'utf8').replace(/\n$/, '').split('\n').length;
    if (Number(lineStr) > count) return `${cite} is past the end (${count} lines)`;
  }
  return null;
}

const isNonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;

/** `obj[key]` as an array: `[]` if absent, `[]` plus a problem if present but not an array. */
function asList(say, obj, key, label) {
  const v = obj?.[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) { say(`${label} must be a list`); return []; }
  return v;
}

/** @returns {{ problems: string[], uncovered: string[] }} */
export function check({ rows, names, root }) {
  const problems = [];
  const known = new Set(names.names.map((n) => n.id));
  const liveFile = join(root, 'docs/live-testing.md');
  const live = existsSync(liveFile) ? new Set(headings(readFileSync(liveFile, 'utf8'))) : new Set();

  if (!Array.isArray(rows)) {
    problems.push('checklist: top level must be a list of rows');
    return { problems, uncovered: [...known].sort() };
  }

  const coveredBy = new Map();
  const ids = new Set();

  rows.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      const kind = raw === null ? 'null' : Array.isArray(raw) ? 'an array' : typeof raw;
      problems.push(`row ${index}: must be a mapping, not ${kind}`);
      return;
    }
    const row = raw;
    const say = (msg) => problems.push(`${row.id ?? `(row ${index})`}: ${msg}`);

    if (ids.has(row.id)) say('duplicate id');
    ids.add(row.id);
    if (typeof row.id !== 'string') say('id must be a string');
    else if (!KEBAB.test(row.id)) say('id is not kebab-case');
    for (const k of Object.keys(row)) if (!ROW_KEYS.has(k)) say(`unknown key ${k}`);
    for (const f of ['title', 'x3270', 'gui']) if (!isNonBlankString(row[f])) say(`needs ${f}`);
    if (!AREAS.includes(row.area)) say(`area must be one of ${AREAS.join(', ')}`);
    if (!STATUSES.includes(row.status)) say(`status must be one of ${STATUSES.join(', ')}`);

    const covers = asList(say, row, 'covers', 'covers');
    for (const id of covers) {
      if (typeof id !== 'string') { say(`covers entry ${JSON.stringify(id)} must be a string`); continue; }
      if (!known.has(id)) say(`covers unknown name ${id}`);
      else if (coveredBy.has(id)) say(`${id} is also covered by ${coveredBy.get(id)}`);
      else coveredBy.set(id, row.id);
    }

    const ev = (row.evidence !== null && typeof row.evidence === 'object' && !Array.isArray(row.evidence)) ? row.evidence : {};
    for (const k of Object.keys(ev)) if (!EVIDENCE_KEYS.has(k)) say(`unknown key evidence.${k}`);
    const code = asList(say, ev, 'code', 'evidence.code');
    const tests = asList(say, ev, 'tests', 'evidence.tests');
    if (row.status === 'ours') {
      if (!code.length) say('ours needs evidence.code');
      if (!tests.length) say('ours needs evidence.tests');
      if (!ev.live) say('ours needs evidence.live (a heading, unwitnessed or n/a)');
      // An unaccepted `live: unwitnessed` is legal here -- only the user may write
      // accept-unwitnessed, so an honest agent-written `ours` row must be able to say
      // "unwitnessed" without failing check(). It still blocks at the gate (see blocking()),
      // the same way a proposed-* row is legal in the file but blocks until decided.
    }
    if (row['accept-unwitnessed'] !== undefined) {
      if (!(row.status === 'ours' && ev.live === 'unwitnessed')) say('accept-unwitnessed only on ours with live: unwitnessed');
      else if (!isNonBlankString(row['accept-unwitnessed'])) say('accept-unwitnessed must be a non-blank string');
    }
    for (const cite of [...code, ...tests]) {
      if (typeof cite !== 'string') { say(`evidence cite ${JSON.stringify(cite)} must be a string`); continue; }
      const msg = citationProblem(root, cite);
      if (msg) say(msg);
    }
    if (ev.live && !['n/a', 'unwitnessed'].includes(ev.live) && !live.has(ev.live)) {
      say(`live heading not in docs/live-testing.md: ${ev.live}`);
    }
    if (row.status === 'partial' && !isNonBlankString(row.gap)) say('partial needs gap');
    if (['deferred', 'skipped', 'proposed-deferred', 'proposed-skipped'].includes(row.status) && !isNonBlankString(row.reason)) {
      say(`${row.status} needs reason`);
    }
    if (['deferred', 'skipped'].includes(row.status) && !row.decided) say(`${row.status} needs decided`);
    if (row.decided !== undefined) {
      if (!['deferred', 'skipped'].includes(row.status)) say('decided only on deferred or skipped');
      else if (!validDecided(row.decided)) say('decided must read "YYYY-MM-DD, user"');
    }
    if (row.status === 'skipped' || row.status === 'proposed-skipped') {
      if (!row.category) say(`${row.status} needs category`);
      else if (!CATEGORIES.includes(row.category)) say(`category must be one of ${CATEGORIES.join(', ')}`);
    }
  });

  const uncovered = [...known].filter((id) => !coveredBy.has(id)).sort();
  return { problems, uncovered };
}

export const loadRows = (text) => parse(text) ?? [];

export const cell = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\|/g, '\\|')
  .replace(/\r/g, '')
  .replace(/\n/g, ' ');
/** The note column: the gap, the reason, or the acceptance -- or, for an `ours` row that is
 * unwitnessed and not accepted (legal in the file, blocking at the gate), says so, so a blocked
 * `ours` row never reads as done. */
const note = (r) => {
  const n = r.gap ?? r.reason ?? r['accept-unwitnessed'];
  if (n !== undefined) return n;
  if (r.status === 'ours' && r.evidence?.live === 'unwitnessed') return 'unwitnessed, not accepted';
  return '';
};

/** A row shaped enough to look at: a non-null, non-array object. `check()` is what reports a
 * malformed row (or a non-array top level) as a problem; `blocking()` and `render()` just skip
 * anything that doesn't look like a row, rather than crashing on it. */
const isMapping = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);
const rowList = (rows) => (Array.isArray(rows) ? rows.filter(isMapping) : []);

/**
 * An allow-list: a row passes only if it is `ours` (with an accepted `unwitnessed` live, or a
 * non-unwitnessed live), `deferred`, or `skipped`. Anything else -- `partial`, `missing`, a
 * `proposed-*`, an unknown status, or no status at all -- blocks with one line. This is
 * deliberately not a list of specific statuses to skip: a status this code has never heard of
 * (a typo, a future addition) blocks by default rather than silently passing the gate.
 */
export function blocking(rows) {
  return rowList(rows).sort(byId).flatMap((r) => {
    if (r.status === 'ours') {
      const live = r.evidence?.live;
      if (live === 'unwitnessed') return r['accept-unwitnessed'] ? [] : [`${r.id}: ours but unwitnessed, not accepted`];
      return live ? [] : [`${r.id}: ours without evidence.live`];
    }
    if (r.status === 'deferred' || r.status === 'skipped') return [];
    if (r.status === 'partial') return [`${r.id}: partial -- ${r.gap ?? '(no gap given)'}`];
    if (r.status === 'missing') return [`${r.id}: missing`];
    if (r.status === 'proposed-deferred' || r.status === 'proposed-skipped') {
      return [`${r.id}: ${r.status} -- ${r.reason ?? '(no reason given)'}`];
    }
    return [`${r.id}: unknown status ${r.status ?? '(none)'}`];
  });
}

export function render(rows, names) {
  const list = rowList(rows);
  const count = (s) => list.filter((r) => r.status === s).length;
  const out = [
    '# x3270 parity checklist',
    '',
    '<!-- GENERATED by `node scripts/parity.mjs render` from docs/parity/checklist.yaml and',
    '     docs/parity/x3270-names.json. Do not edit by hand. -->',
    '',
    `Compared against x3270 **${names.tag}**: ${names.names.length} names in ${list.length} rows.`,
    'Design: `docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md`.',
    '',
    '| status | rows |',
    '|---|---|',
    ...STATUSES.map((s) => `| ${s} | ${count(s)} |`),
    '',
    `Passing the gate: ${list.length - blocking(list).length} of ${list.length} rows`,
    '',
  ];
  for (const area of AREAS) {
    const these = list.filter((r) => r.area === area).sort(byId);
    if (!these.length) continue;
    out.push(`## ${area}`, '', '| id | status | note | feature | our GUI | x3270 |', '|---|---|---|---|---|---|');
    for (const r of these) {
      out.push(`| ${cell(r.id)} | ${cell(r.status)} | ${cell(note(r))} | ${cell(r.title)} | ${cell(r.gui)} | ${cell(r.x3270)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAMES_FILE = join(ROOT, 'docs/parity/x3270-names.json');
const ROWS_FILE = join(ROOT, 'docs/parity/checklist.yaml');
const MD_FILE = join(ROOT, 'docs/parity.md');

const MODES = ['render', 'uncovered', 'check', 'gate'];
const USAGE = [
  'usage: parity.mjs render | uncovered | check | gate',
  '  render:    writes docs/parity.md from the checklist and the name inventory',
  '  uncovered: lists x3270 names not covered by any row',
  "  check:     reports problems with the checklist; it does not report uncovered names",
  '             -- see gate or uncovered for those',
  '  gate:      exits nonzero on any problem, any uncovered name, or any blocking row',
];

/**
 * `deps` lets a caller inject `{ rows, names, root }` directly (or `namesFile`/`rowsFile` to
 * read from elsewhere, or `mdFile`/`writeFile` for `render`), so tests can exercise every mode
 * without touching the real committed files. The mode is validated before anything is read, so a
 * bad mode is a usage error even if the injected or real files don't exist.
 */
export function main(argv, io = { log: console.log, err: console.error }, deps = {}) {
  const mode = argv[0];
  if (!MODES.includes(mode)) {
    for (const l of USAGE) io.err(l);
    return 2;
  }
  const root = deps.root ?? ROOT;
  const names = deps.names ?? JSON.parse(readFileSync(deps.namesFile ?? NAMES_FILE, 'utf8'));
  const rows = deps.rows ?? loadRows(readFileSync(deps.rowsFile ?? ROWS_FILE, 'utf8'));
  const { problems, uncovered } = check({ rows, names, root });
  switch (mode) {
    case 'render': {
      const md = render(rows, names);
      const mdFile = deps.mdFile ?? MD_FILE;
      (deps.writeFile ?? writeFileSync)(mdFile, md);
      io.log(`wrote ${mdFile}`);
      return 0;
    }
    case 'uncovered': {
      const sites = new Map(names.names.map((n) => [n.id, n.sites.map((s) => s.at).join(', ')]));
      for (const id of uncovered) io.log(`${id}\t${sites.get(id)}`);
      return 0;
    }
    case 'check':
      for (const p of problems) io.err(p);
      return problems.length ? 1 : 0;
    case 'gate': {
      // A top-level shape problem (the checklist isn't even a list) makes `uncovered` and
      // `blocking` meaningless noise -- hundreds of "not covered" lines when the real problem is
      // that the YAML isn't a list at all. Report just the check() problem(s) and stop there.
      if (!Array.isArray(rows)) {
        for (const p of problems) io.err(p);
        io.log(`parity gate: FAIL, ${problems.length} blocking`);
        return 1;
      }
      const lines = [...problems, ...uncovered.map((id) => `${id}: not covered by any row`), ...blocking(rows)];
      for (const l of lines) io.err(l);
      io.log(lines.length ? `parity gate: FAIL, ${lines.length} blocking` : 'parity gate: pass');
      return lines.length ? 1 : 0;
    }
    default: return 2; // unreachable: MODES guard above has already returned.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
