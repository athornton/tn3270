#!/usr/bin/env node
// The x3270 parity checklist: check, render, gate
// (docs/superpowers/specs/2026-11-17-x3270-parity-checklist-design.md, sections 2-3).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const AREAS = ['connection', 'keyboard', 'display', 'files', 'scripting', 'other'];
export const STATUSES = ['ours', 'partial', 'missing', 'proposed-deferred', 'proposed-skipped', 'deferred', 'skipped'];
export const CATEGORIES = ['x11-only', 'obsolete', 'declined', 'n/a'];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DECIDED = /^\d{4}-\d{2}-\d{2}, user$/;

/**
 * Strips markdown emphasis markers (`**bold**`, `__bold__`, `*italic*`, `_italic_`), keeping
 * their inner text. Code spans (backticks) are left alone: they are part of the heading's
 * literal text, not decoration, so a citation must still include them.
 */
const stripEmphasis = (s) => s
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/_([^_]+)_/g, '$1');

/** Heading texts of a markdown file: `#`s, surrounding space and markdown emphasis stripped. */
const headings = (text) => text.split('\n')
  .filter((l) => /^#{1,6}\s/.test(l))
  .map((l) => stripEmphasis(l.replace(/^#+\s*/, '').trimEnd()).trim());

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
