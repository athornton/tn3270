import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocking, cell, check, loadRows, main, render, type Row } from '../../../scripts/parity.mjs';

/**
 * A throwaway repo root with one source file of 3 lines, one test file and a live-testing.md
 * with: a plain heading, a heading carrying literal markdown emphasis characters, a `#`-looking
 * line inside a fenced code block (must NOT count as a heading), a closing-hashes heading, and a
 * ```` fence containing a shorter ``` line and a `#`-looking line (neither must end the fence
 * early) followed by a heading after the fence closes. It also has a real file just outside the
 * root (for a plain path-traversal citation) and a symlink inside the root pointing to a file
 * outside it (for the realpath escape check).
 *
 * Everything lives under one parent temp dir (the root, the `../x` sibling and the symlink's
 * target are all inside it), so nothing is written elsewhere in the temp directory, and the
 * afterAll below removes every parent this file created.
 */
const parents: string[] = [];
afterAll(() => {
  for (const p of parents.splice(0)) rmSync(p, { recursive: true, force: true });
});
function fakeRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), 'parity-test-'));
  parents.push(parent);
  const root = join(parent, 'root');
  mkdirSync(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'src/a.ts'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, 'src/a.test.ts'), '');
  writeFileSync(join(root, 'docs/live-testing.md'), [
    '# Runbook', '',
    '## Proxy against squid', '',
    '### Reached *AND ACTIVE* now', '',
    '```', '# comment', '```', '',
    '## Closer ##', '',
    '````', '```', '# inner', '````', '',
    '## After', '',
  ].join('\n'));
  writeFileSync(join(parent, 'x'), 'a real file just outside the root\n');
  const outsideDir = join(parent, 'outside');
  mkdirSync(outsideDir);
  writeFileSync(join(outsideDir, 'secret.txt'), 'outside the root\n');
  symlinkSync(join(outsideDir, 'secret.txt'), join(root, 'src/escape-link.ts'));
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
    ['acceptance where witnessed', [ours({ 'accept-unwitnessed': 'x' })], 'thing: accept-unwitnessed only on ours with live: unwitnessed'],
    ['partial without gap', [ours({ status: 'partial' })], 'thing: partial needs gap'],
    ['deferred without decided', [ours({ status: 'deferred', reason: 'later' })], 'thing: deferred needs decided'],
    ['deferred without reason', [ours({ status: 'deferred', decided: '2026-11-17, user' })], 'thing: deferred needs reason'],
    ['a malformed decided', [ours({ status: 'deferred', reason: 'r', decided: 'yes' })], 'thing: decided must read "YYYY-MM-DD, user"'],
    ['decided on a proposal', [ours({ status: 'proposed-deferred', reason: 'r', decided: '2026-11-17, user' })], 'thing: decided only on deferred or skipped'],
    ['skipped without category', [ours({ status: 'skipped', reason: 'r', decided: '2026-11-17, user' })], 'thing: skipped needs category'],
    ['a bad category', [ours({ status: 'skipped', category: 'meh' as never, reason: 'r', decided: '2026-11-17, user' })], 'thing: category must be one of'],
    ['proposed-skipped without category', [ours({ status: 'proposed-skipped', reason: 'r' })], 'thing: proposed-skipped needs category'],
    ['proposed-skipped with a bad category', [ours({ status: 'proposed-skipped', category: 'meh' as never, reason: 'r' })], 'thing: category must be one of'],
    ['a non-string id', [ours({ id: 123 as never })], '123: id must be a string'],
    ['a missing id', [ours({ id: undefined as never })], '(row 0): id must be a string'],
    ['an unknown row key', [ours({ colour: 'red' } as never)], 'thing: unknown key colour'],
    ['a misspelt row key', [ours({ 'accept-unwitnesed': 'x' } as never)], 'thing: unknown key accept-unwitnesed'],
    ['an unknown evidence key', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'n/a', test: [] } as never })], 'thing: unknown key evidence.test'],
    ['a missing title', [ours({ title: '' })], 'thing: needs title'],
    // decided must be a real calendar date, not just a matching pattern.
    ['a decided with the wrong word', [ours({ status: 'deferred', reason: 'r', decided: '2026-11-17, agent' })], 'thing: decided must read "YYYY-MM-DD, user"'],
    ['a decided missing the user suffix', [ours({ status: 'deferred', reason: 'r', decided: '2026-11-17' })], 'thing: decided must read "YYYY-MM-DD, user"'],
    ['a decided with an invalid calendar date', [ours({ status: 'deferred', reason: 'r', decided: '2026-13-45, user' })], 'thing: decided must read "YYYY-MM-DD, user"'],
    // live heading matching is exact: emphasis markers are part of the literal text.
    ['a live heading missing its literal asterisks', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'Reached AND ACTIVE now' } })], 'thing: live heading not in docs/live-testing.md: Reached AND ACTIVE now'],
    ['a live heading that is only inside a fenced code block', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'comment' } })], 'thing: live heading not in docs/live-testing.md: comment'],
    // fences pair by kind and length (CommonMark): a ``` line and a `#`-looking line inside a
    // ```` block neither close the fence nor count as a heading.
    ['a heading-looking line inside a longer fence', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'inner' } })], 'thing: live heading not in docs/live-testing.md: inner'],
    // citations: line must be a positive integer.
    ['a zero line number', [ours({ evidence: { code: ['src/a.ts:0'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:0: line must be a positive integer'],
    ['a negative line number', [ours({ evidence: { code: ['src/a.ts:-1'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:-1: line must be a positive integer'],
    ['a non-numeric line number', [ours({ evidence: { code: ['src/a.ts:abc'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:abc: line must be a positive integer'],
    ['a fractional line number', [ours({ evidence: { code: ['src/a.ts:1.5'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:1.5: line must be a positive integer'],
    ['an empty line number', [ours({ evidence: { code: ['src/a.ts:'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:: line must be a positive integer'],
    ['a citation with two colons', [ours({ evidence: { code: ['src/a.ts:2:9'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/a.ts:2:9: line must be a positive integer'],
    // citations: target must be a regular file, never crashing on a directory.
    ['a directory citation', [ours({ evidence: { code: ['src'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src is not a regular file'],
    ['a directory citation with a line number (would have thrown EISDIR)', [ours({ evidence: { code: ['src:1'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src is not a regular file'],
    ['an empty citation', [ours({ evidence: { code: [''], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: (empty) is not a regular file'],
    // citations: path must be repo-relative and stay inside the repo root, by its real path
    // (after symlinks), not just lexically -- so a symlink inside the repo pointing outside it
    // is refused, not silently followed.
    ['an absolute path citation', [ours({ evidence: { code: ['/etc/passwd'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: /etc/passwd: must be a repo-relative path, not absolute'],
    ['a citation that escapes the repo root', [ours({ evidence: { code: ['../x'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: ../x: path escapes the repo root'],
    ['a symlink inside the repo pointing outside it', [ours({ evidence: { code: ['src/escape-link.ts'], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: src/escape-link.ts: path escapes the repo root'],
    // shape checks: malformed covers/evidence/cites give a problem, not a crash.
    ['a non-array covers', [ours({ covers: 'action:A' as never })], 'thing: covers must be a list'],
    ['a non-array evidence.code', [ours({ evidence: { code: 'src/a.ts' as never, tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: evidence.code must be a list'],
    ['a non-array evidence.tests', [ours({ evidence: { code: ['src/a.ts'], tests: 'src/a.test.ts' as never, live: 'n/a' } })], 'thing: evidence.tests must be a list'],
    ['a non-string cite', [ours({ evidence: { code: [42 as never], tests: ['src/a.test.ts'], live: 'n/a' } })], 'thing: evidence cite 42 must be a string'],
    ['a non-string title', [ours({ title: 42 as never })], 'thing: needs title'],
    ['a whitespace-only title', [ours({ title: '   ' })], 'thing: needs title'],
    ['a whitespace-only gap', [ours({ status: 'partial', gap: '   ' })], 'thing: partial needs gap'],
    ['a whitespace-only reason', [ours({ status: 'deferred', reason: '   ', decided: '2026-11-17, user' })], 'thing: deferred needs reason'],
    ['a whitespace-only accept-unwitnessed', [ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' }, 'accept-unwitnessed': '   ' })], 'thing: accept-unwitnessed must be a non-blank string'],
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

  it('accepts a proposed-skipped row with a category, and every spec field on one row', () => {
    expect(run([ours({ status: 'proposed-skipped', category: 'x11-only', reason: 'X only' })]).problems).toEqual([]);
    expect(run([ours({ browser: 'b', others: { tui: 't', cli: 'c' } })]).problems).toEqual([]);
  });

  it('accepts a real calendar date for decided', () => {
    expect(run([ours({ status: 'deferred', reason: 'r', decided: '2026-11-17, user' })]).problems).toEqual([]);
  });

  it('an ours row with an unaccepted unwitnessed live passes check() -- only the user may write accept-unwitnessed, so an honest agent-written row must not fail check() for lacking one; it still blocks at the gate (see "main (gate, injected)" below)', () => {
    expect(run([ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' } })]).problems).toEqual([]);
  });

  it('matches a live heading exactly, asterisks and all, and matches a closing-hashes heading', () => {
    expect(run([ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'Reached *AND ACTIVE* now' } })]).problems).toEqual([]);
    expect(run([ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'Closer' } })]).problems).toEqual([]);
  });

  it('still recognizes a heading after a longer fence closes', () => {
    expect(run([ours({ evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'After' } })]).problems).toEqual([]);
  });

  it('reports a non-array top level without crashing', () => {
    expect(check({ rows: { oops: true } as never, names: NAMES, root }).problems).toEqual(['checklist: top level must be a list of rows']);
  });

  it('reports a null or non-object row without crashing', () => {
    expect(run([null] as never).problems.some((p) => p.includes('must be a mapping'))).toBe(true);
    expect(run(['oops'] as never).problems.some((p) => p.includes('must be a mapping'))).toBe(true);
    expect(run([[1, 2]] as never).problems.some((p) => p.includes('must be a mapping'))).toBe(true);
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
    expect(md).toContain('| id | status | note | feature | our GUI | x3270 |');
    expect(md.indexOf('## connection')).toBeLessThan(md.indexOf('## display'));
    expect(md.indexOf('a-gap')).toBeLessThan(md.indexOf('b-thing'));
    expect(md).toContain('File \\| Connect');
    expect(md).toContain('no dialog');
  });

  it('notes an unaccepted unwitnessed ours row as blocked, and an accepted one by its acceptance', () => {
    const md = render([
      ours({ id: 'u-open', covers: [], evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' } }),
      ours({ id: 'u-ok', covers: [], evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' }, 'accept-unwitnessed': 'no host' }),
    ], { tag: '4.5ga6', names: [] } as never);
    expect(md).toContain('| u-open | ours | unwitnessed, not accepted |');
    expect(md).toContain('| u-ok | ours | no host |');
  });

  it('says how many rows pass the gate, right after the status counts', () => {
    const md = render(rows, { tag: '4.5ga6', names: [{ id: 'action:A' }, { id: 'option:-b' }] } as never);
    // b-thing (ours, witnessed) and z-skip pass; a-gap (partial) blocks.
    expect(md).toContain('| skipped | 1 |\n\nPassing the gate: 2 of 3 rows\n');
  });

  it('cell escapes backslashes before pipes and strips carriage returns', () => {
    expect(cell('a\\b|c\r\nd')).toBe('a\\\\b\\|c d');
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

  it('blocks an unknown status, a missing status, and an ours row with no live', () => {
    expect(blocking([{ id: 'x', area: 'other', status: 'done', title: 'X' } as never])).toEqual(['x: unknown status done']);
    expect(blocking([{ id: 'y', area: 'other', title: 'Y' } as Row])).toEqual(['y: unknown status (none)']);
    expect(blocking([{ id: 'z', area: 'other', status: 'ours', title: 'Z' } as Row])).toEqual(['z: ours without evidence.live']);
  });

  it('blocks an ours row with an unaccepted unwitnessed live, directly (not via check())', () => {
    // check() deliberately does NOT flag this (only the user may write accept-unwitnessed, so
    // an honest agent-written row must pass check() unaccepted) -- blocking() is the only place
    // this rule is enforced now, so this direct unit test is what actually guards it.
    expect(blocking([
      ours({ id: 'unaccepted', covers: [], evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' } }),
    ])).toEqual(['unaccepted: ours but unwitnessed, not accepted']);
  });

  it('passes deferred and skipped unconditionally, and an accepted unwitnessed ours', () => {
    expect(blocking([
      { id: 'd', area: 'other', status: 'deferred', title: 'D' } as Row,
      { id: 's', area: 'other', status: 'skipped', title: 'S' } as Row,
      ours({ id: 'u', covers: [], evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' }, 'accept-unwitnessed': 'ok' }),
    ])).toEqual([]);
  });

  it('keeps rows with equal ids in their given order (the comparator says 0, not 1)', () => {
    const lines = blocking([
      { id: 'x', area: 'other', status: 'partial', gap: 'first', title: 'X1' } as Row,
      { id: 'x', area: 'other', status: 'partial', gap: 'second', title: 'X2' } as Row,
      { id: 'a', area: 'other', status: 'missing', title: 'A' } as Row,
    ]);
    expect(lines).toEqual(['a: missing', 'x: partial -- first', 'x: partial -- second']);
    const md = render([
      { id: 'x', area: 'other', status: 'partial', gap: 'first', title: 'X1' } as Row,
      { id: 'x', area: 'other', status: 'partial', gap: 'second', title: 'X2' } as Row,
    ], { tag: '4.5ga6', names: [] } as never);
    expect(md.indexOf('first')).toBeLessThan(md.indexOf('second'));
  });

  it('never prints "-- undefined" for a partial or proposed row missing its note', () => {
    const lines = blocking([
      { id: 'p1', area: 'other', status: 'partial', title: 'P1' } as Row,
      { id: 'p2', area: 'other', status: 'proposed-deferred', title: 'P2' } as Row,
    ]);
    expect(lines.join('\n')).not.toContain('undefined');
  });
});

describe('main (gate, injected)', () => {
  const root = fakeRoot();
  const names = NAMES;
  const captured = () => {
    const logs: string[] = [];
    const errs: string[] = [];
    return { io: { log: (s: string) => logs.push(s), err: (s: string) => errs.push(s) }, logs, errs };
  };

  it('exits 1 for a check problem alone', () => {
    const rows = [ours({ area: 'misc' as never, covers: ['action:A', 'option:-b'] })];
    expect(main(['gate'], captured().io, { rows, names, root })).toBe(1);
  });

  it('exits 1 for an uncovered name alone', () => {
    const rows = [ours({ covers: ['action:A'] })];
    expect(main(['gate'], captured().io, { rows, names, root })).toBe(1);
  });

  it('exits 1 for an unaccepted unwitnessed ours (check() passes it; the gate is where it blocks)', () => {
    const rows = [ours({ covers: ['action:A', 'option:-b'], evidence: { code: ['src/a.ts'], tests: ['src/a.test.ts'], live: 'unwitnessed' } })];
    expect(main(['gate'], captured().io, { rows, names, root })).toBe(1);
  });

  it('exits 1 for status: done', () => {
    const rows = [ours({ status: 'done' as never, covers: ['action:A', 'option:-b'] })];
    expect(main(['gate'], captured().io, { rows, names, root })).toBe(1);
  });

  it('exits 0 for a clean, fully covered set', () => {
    const rows = [ours({ covers: ['action:A', 'option:-b'] })];
    const { io, logs } = captured();
    expect(main(['gate'], io, { rows, names, root })).toBe(0);
    expect(logs).toContain('parity gate: pass');
  });
});

describe('main handles a malformed checklist without crashing', () => {
  const root = fakeRoot();
  const names = NAMES;
  const captured = () => {
    const logs: string[] = [];
    const errs: string[] = [];
    return { io: { log: (s: string) => logs.push(s), err: (s: string) => errs.push(s) }, logs, errs };
  };

  it.each([
    ['a null row', [null]],
    ['a top-level mapping', { oops: true }],
    ['a string row', ['oops']],
  ])('gate does not crash on %s, and exits 1', (_label, rows) => {
    const { io } = captured();
    expect(main(['gate'], io, { rows: rows as never, names, root })).toBe(1);
  });

  it.each([
    ['a null row', [null]],
    ['a top-level mapping', { oops: true }],
    ['a string row', ['oops']],
  ])('render does not crash on %s', (_label, rows) => {
    let written = '';
    expect(() => main(['render'], captured().io, {
      rows: rows as never, names, root, mdFile: '/dev/null', writeFile: (_p: string, data: string) => { written = data; },
    })).not.toThrow();
    expect(written).toContain('# x3270 parity checklist');
  });

  it('gate on a top-level mapping prints only the check() problems, not uncovered/blocking noise', () => {
    const { io, logs, errs } = captured();
    const code = main(['gate'], io, { rows: { oops: true } as never, names, root });
    expect(code).toBe(1);
    expect(errs).toEqual(['checklist: top level must be a list of rows']);
    expect(logs).toEqual(['parity gate: FAIL, 1 blocking']);
  });
});

describe('main (CLI)', () => {
  it('checks the mode before touching any files; a bad mode is a usage error, exit 2', () => {
    const { io, errs } = (() => {
      const errs: string[] = [];
      return { io: { log: () => {}, err: (s: string) => errs.push(s) }, errs };
    })();
    const code = main(['bogus'], io, { namesFile: '/nonexistent/x.json', rowsFile: '/nonexistent/y.yaml' });
    expect(code).toBe(2);
    expect(errs.join('\n')).toMatch(/check:.*does not report uncovered/is);
  });
});

describe('the committed checklist', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const names = JSON.parse(readFileSync(`${root}docs/parity/x3270-names.json`, 'utf8'));
  const committed = loadRows(readFileSync(`${root}docs/parity/checklist.yaml`, 'utf8'));

  it('has no problems', () => {
    expect(check({ rows: committed, names, root }).problems).toEqual([]);
  });

  it('covers every x3270 name (list them: node scripts/parity.mjs uncovered)', () => {
    expect(check({ rows: committed, names, root }).uncovered).toEqual([]);
  });

  it('docs/parity.md is exactly what render produces (run: node scripts/parity.mjs render)', () => {
    expect(readFileSync(`${root}docs/parity.md`, 'utf8')).toBe(render(committed, names));
  });
});
