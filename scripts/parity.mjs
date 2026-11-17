#!/usr/bin/env node
// The x3270 parity checklist: check, render, gate
// (docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md, sections 2-3).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const AREAS = ['connection', 'keyboard', 'display', 'files', 'scripting', 'other'];
export const STATUSES = ['ours', 'partial', 'missing', 'proposed-deferred', 'proposed-skipped', 'deferred', 'skipped'];
export const CATEGORIES = ['x11-only', 'obsolete', 'declined', 'n/a'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
 * Heading texts of a markdown file: a line outside a fenced code block (``` or ~~~, tracked so a
 * `# comment` inside a fence never counts), with 0-3 leading spaces then 1-6 `#`s and a space.
 * An optional closing run of `#`s is removed; the rest -- asterisks, underscores, backticks --
 * is kept verbatim, so a citation must be copied exactly, markup and all.
 */
function headings(text) {
  const out = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = HEADING.exec(line);
    if (!m) continue;
    out.push(m[1].replace(/\s+#+$/, '').trim());
  }
  return out;
}

const LINE = /^[1-9]\d*$/;

/**
 * Validates one `file` or `file:line` citation against the repo root. Returns a problem message,
 * or null if the citation is fine; never throws. In particular, a directory is rejected by
 * `isFile()` *before* any attempt to read it for a line count, which is what keeps a citation
 * like `src:1` from throwing EISDIR (the bug this replaces).
 */
function citationProblem(root, cite) {
  const i = cite.indexOf(':');
  const file = i === -1 ? cite : cite.slice(0, i);
  const lineStr = i === -1 ? undefined : cite.slice(i + 1);
  if (lineStr !== undefined && !LINE.test(lineStr)) return `${cite}: line must be a positive integer`;
  if (isAbsolute(file)) return `${cite}: must be a repo-relative path, not absolute`;
  const resolved = resolve(root, file);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith('../')) return `${cite}: path escapes the repo root`;
  if (!existsSync(resolved)) return `${file} does not exist`;
  if (!statSync(resolved).isFile()) return `${file || '(empty)'} is not a regular file`;
  if (lineStr !== undefined) {
    const count = readFileSync(resolved, 'utf8').replace(/\n$/, '').split('\n').length;
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
    if (!KEBAB.test(row.id ?? '')) say('id is not kebab-case');
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
    const code = asList(say, ev, 'code', 'evidence.code');
    const tests = asList(say, ev, 'tests', 'evidence.tests');
    if (row.status === 'ours') {
      if (!code.length) say('ours needs evidence.code');
      if (!tests.length) say('ours needs evidence.tests');
      if (!ev.live) say('ours needs evidence.live (a heading, unwitnessed or n/a)');
      if (ev.live === 'unwitnessed' && !row['accept-unwitnessed']) say('live: unwitnessed needs accept-unwitnessed');
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
    if (row.status === 'skipped') {
      if (!row.category) say('skipped needs category');
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
const note = (r) => r.gap ?? r.reason ?? r['accept-unwitnessed'] ?? '';

/**
 * An allow-list: a row passes only if it is `ours` (with an accepted `unwitnessed` live, or a
 * non-unwitnessed live), `deferred`, or `skipped`. Anything else -- `partial`, `missing`, a
 * `proposed-*`, an unknown status, or no status at all -- blocks with one line. This is
 * deliberately not a list of specific statuses to skip: a status this code has never heard of
 * (a typo, a future addition) blocks by default rather than silently passing the gate.
 */
export function blocking(rows) {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1)).flatMap((r) => {
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
