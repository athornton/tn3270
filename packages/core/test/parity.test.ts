import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocking, check, loadRows, render, type Row } from '../../../scripts/parity.mjs';

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
