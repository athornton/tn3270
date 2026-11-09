import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readTar } from '../../../scripts/tarball.mjs';
import { publishedPackages, tarballName } from '../../../scripts/workspaces.mjs';
import {
  checkRelease, decide, publishOrder, readTarball, registryShasum, verifyReadBack,
  type FetchFn, type Tarball,
} from '../../../scripts/publish.mjs';

/** One 512-byte ustar header for `name` of `size` bytes, of tar `type` ('0' regular, 'x' pax). */
function header(name: string, size: number, type = '0'): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);       // checksum field as spaces while summing
  h.write(type, 156);
  h.write('ustar\0' + '00', 257);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

/** `body` padded out to a whole number of 512-byte blocks. */
function padded(body: Buffer): Buffer[] {
  return [body, Buffer.alloc((512 - (body.length % 512)) % 512)];
}

/** One pax record, `"<len> key=value\n"`, where `<len>` counts the whole record including itself. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (String(len).length + Buffer.byteLength(rest) !== len) len++;
  return `${len}${rest}`;
}

/**
 * A minimal ustar archive, gzipped: what `npm pack` writes, for the entries given. An entry whose
 * name is longer than ustar's 100 bytes gets a pax `x` header carrying its `path`, as node-tar
 * (npm pack) writes one.
 */
export function makeTgz(entries: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text);
    if (Buffer.byteLength(name) > 100) {
      const pax = Buffer.from(paxRecord('path', name));
      blocks.push(header('PaxHeader/long', pax.length, 'x'), ...padded(pax));
      blocks.push(header(name.slice(0, 100), body.length), ...padded(body));
    } else {
      blocks.push(header(name, body.length), ...padded(body));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe('readTar', () => {
  it("returns each entry's bytes by path", () => {
    const d = mkdtempSync(join(tmpdir(), 'tar-'));
    try {
      const p = join(d, 'x.tgz');
      writeFileSync(p, makeTgz({ 'package/package.json': '{"name":"@tn3270/core"}', 'package/LICENSE': 'MIT' }));
      const t = readTar(p);
      expect([...t.keys()]).toEqual(['package/package.json', 'package/LICENSE']);
      expect(t.get('package/LICENSE')!.toString()).toBe('MIT');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('takes a long path from its pax header, and lists no pax header as an entry', () => {
    const d = mkdtempSync(join(tmpdir(), 'tar-'));
    try {
      const p = join(d, 'x.tgz');
      const long = `package/dist/${'a'.repeat(120)}.js`;
      writeFileSync(p, makeTgz({ 'package/package.json': '{}', [long]: 'x'.repeat(600), 'package/LICENSE': 'MIT' }));
      const t = readTar(p);
      expect([...t.keys()]).toEqual(['package/package.json', long, 'package/LICENSE']);
      expect(t.get(long)!.toString()).toBe('x'.repeat(600));
      expect(t.get('package/LICENSE')!.toString()).toBe('MIT');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('workspaces', () => {
  it('finds the eight published packages, and names their tarballs as npm pack does', () => {
    const names = publishedPackages().map(({ m }) => m.name).sort();
    expect(names).toEqual(['@tn3270/canvas', '@tn3270/cli', '@tn3270/core', '@tn3270/frontend',
      '@tn3270/gui', '@tn3270/node-files', '@tn3270/tui', '@tn3270/web']);
    expect(tarballName({ name: '@tn3270/node-files', version: '0.1.1' })).toBe('tn3270-node-files-0.1.1.tgz');
  });
});

/** A `package/package.json` for `name@version` with these dependency ranges. */
function man(name: string, version: string, deps: Record<string, string> = {}): string {
  return JSON.stringify({ name, version, ...(Object.keys(deps).length > 0 ? { dependencies: deps } : {}) });
}

/** The real eight's `@tn3270/*` dependencies (2026-11-09), by short name. */
const REAL: Record<string, string[]> = {
  core: [], frontend: ['core'], 'node-files': ['frontend'], canvas: ['core', 'frontend'],
  cli: ['core', 'frontend', 'node-files'], tui: ['core', 'frontend', 'node-files'],
  web: ['canvas', 'core', 'frontend', 'node-files'], gui: ['canvas', 'core', 'frontend', 'node-files'],
};
const REAL_NAMES = Object.keys(REAL).map((n) => `@tn3270/${n}`).sort();

describe('publish.mjs', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  /** Writes one tarball per `[shortName, version, deps, fileName?]`, returns them read back. */
  function tarballs(specs: Array<[string, string, Record<string, string>, string?]>): Tarball[] {
    dir ??= mkdtempSync(join(tmpdir(), 'publish-'));
    return specs.map(([short, version, deps, file]) => {
      const name = `@tn3270/${short}`;
      const p = join(dir!, file ?? tarballName({ name, version }));
      writeFileSync(p, makeTgz({ 'package/package.json': man(name, version, deps), 'package/LICENSE': 'MIT' }));
      return readTarball(p);
    });
  }

  /** The real eight at `v`, every internal dependency pinned to `pin` (default: `v`). */
  function realSet(v: string, pin = v): Tarball[] {
    return tarballs(Object.entries(REAL).map(([n, ds]) =>
      [n, v, Object.fromEntries(ds.map((d) => [`@tn3270/${d}`, pin]))]));
  }

  describe('readTarball', () => {
    it('reads the manifest inside, and the sha1 of the whole file', () => {
      const [t] = tarballs([['cli', '1.2.3', { '@tn3270/core': '1.2.3', chalk: '^5' }]]);
      expect(t!.name).toBe('@tn3270/cli');
      expect(t!.version).toBe('1.2.3');
      expect(t!.deps).toEqual({ '@tn3270/core': '1.2.3' });
      expect(t!.sha1).toBe(createHash('sha1').update(readFileSync(t!.path)).digest('hex'));
    });
  });

  describe('publishOrder', () => {
    it('puts every package after its dependencies, ties alphabetical', () => {
      // Shuffled input, so input order cannot pass for the answer.
      const set = realSet('0.1.2').reverse();
      const order = publishOrder(set).map((t) => t.name.replace('@tn3270/', ''));
      expect(order).toEqual(['core', 'frontend', 'canvas', 'node-files', 'cli', 'gui', 'tui', 'web']);
      for (const [i, n] of order.entries()) {
        for (const d of REAL[n]!) expect(order.indexOf(d)).toBeLessThan(i);
      }
    });

    it('places a new package by its edges, not by a list', () => {
      const set = [...realSet('0.1.2'), ...tarballs([['aaa', '0.1.2', { '@tn3270/web': '0.1.2' }]])];
      const order = publishOrder(set).map((t) => t.name);
      expect(order.at(-1)).toBe('@tn3270/aaa');
    });

    it('refuses a cycle, naming both ends', () => {
      const set = tarballs([['a', '1.0.0', { '@tn3270/b': '1.0.0' }], ['b', '1.0.0', { '@tn3270/a': '1.0.0' }]]);
      expect(() => publishOrder(set)).toThrow(/cycle.*@tn3270\/a.*@tn3270\/b/);
    });

    it('refuses a dependency outside the set, naming it', () => {
      const set = tarballs([['a', '1.0.0', { '@tn3270/missing': '1.0.0' }]]);
      expect(() => publishOrder(set)).toThrow(/@tn3270\/missing/);
    });
  });

  describe('checkRelease', () => {
    const check = (tag: string | undefined, set: Tarball[]) => checkRelease({ tag, tarballs: set, expectedNames: REAL_NAMES });

    it('passes a clean set, and reports its version', () => {
      expect(check('v0.1.2', realSet('0.1.2'))).toEqual({ version: '0.1.2', problems: [] });
    });

    it.each(['0.1.2', 'v0.1', 'v0.1.2-rc1', 'v01.2.3x'])('refuses the tag %s', (tag) => {
      const r = check(tag, realSet('0.1.2'));
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatch(/tag/);
    });

    it('refuses a missing tarball, naming it', () => {
      const r = check('v0.1.2', realSet('0.1.2').filter((t) => t.name !== '@tn3270/tui'));
      expect(r.problems.join('\n')).toMatch(/missing.*@tn3270\/tui/);
    });

    it('refuses an extra tarball, naming it', () => {
      const r = check('v0.1.2', [...realSet('0.1.2'), ...tarballs([['extra', '0.1.2', {}]])]);
      expect(r.problems.join('\n')).toMatch(/unexpected.*@tn3270\/extra/);
    });

    it('refuses a tarball at another version than the tag', () => {
      const set = realSet('0.1.2');
      const [odd] = tarballs([['web', '0.1.3', Object.fromEntries(REAL.web!.map((d) => [`@tn3270/${d}`, '0.1.2']))]]);
      const r = check('v0.1.2', [...set.filter((t) => t.name !== '@tn3270/web'), odd!]);
      expect(r.problems.join('\n')).toMatch(/@tn3270\/web.*0\.1\.3.*0\.1\.2/);
    });

    it('refuses a file not named as npm pack names it', () => {
      const set = realSet('0.1.2');
      const [odd] = tarballs([['web', '0.1.2', Object.fromEntries(REAL.web!.map((d) => [`@tn3270/${d}`, '0.1.2'])), 'web.tgz']]);
      const r = check('v0.1.2', [...set.filter((t) => t.name !== '@tn3270/web'), odd!]);
      expect(r.problems.join('\n')).toMatch(/web\.tgz.*tn3270-web-0\.1\.2\.tgz/);
    });

    it('refuses an internal dependency not pinned to exactly the version', () => {
      const r = check('v0.1.2', realSet('0.1.2', '^0.1.2'));
      expect(r.problems.length).toBeGreaterThan(0);
      expect(r.problems.join('\n')).toMatch(/@tn3270\/core.*\^0\.1\.2/);
    });

    it('on a dry run (no tag) passes one version, and refuses mixed ones', () => {
      expect(check(undefined, realSet('0.1.2'))).toEqual({ version: '0.1.2', problems: [] });
      const set = realSet('0.1.2');
      const [odd] = tarballs([['core', '0.1.3', {}]]);
      const r = check(undefined, [...set.filter((t) => t.name !== '@tn3270/core'), odd!]);
      expect(r.problems.join('\n')).toMatch(/versions disagree/);
    });
  });

  describe('decide', () => {
    it('publishes what is absent, skips what is identical, refuses what differs', () => {
      expect(decide('abc', undefined)).toBe('publish');
      expect(decide('abc', 'abc')).toBe('skip');
      expect(decide('abc', 'def')).toBe('conflict');
    });
  });

  /** A fetch that answers from `doc(url)`: an object is a 200 with that JSON, a number a bare status. */
  function fakeFetch(doc: (url: string) => object | number): FetchFn & { urls: string[] } {
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      const d = doc(url);
      return typeof d === 'number'
        ? { ok: d >= 200 && d < 300, status: d, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => d };
    };
    return Object.assign(f, { urls });
  }

  describe('registryShasum', () => {
    it('reads dist.shasum from the uncached document', async () => {
      const f = fakeFetch(() => ({ versions: { '0.1.2': { dist: { shasum: 'abc' } } } }));
      expect(await registryShasum(f, '@tn3270/core', '0.1.2')).toBe('abc');
      expect(f.urls).toEqual(['https://registry.npmjs.org/@tn3270%2Fcore?write=true']);
    });

    it('is undefined for an unknown package, or a version not there', async () => {
      expect(await registryShasum(fakeFetch(() => 404), '@tn3270/core', '0.1.2')).toBeUndefined();
      expect(await registryShasum(fakeFetch(() => ({ versions: { '0.1.1': { dist: { shasum: 'a' } } } })), '@tn3270/core', '0.1.2'))
        .toBeUndefined();
    });

    it('throws on any other failure, which must not read as "absent"', async () => {
      await expect(registryShasum(fakeFetch(() => 503), '@tn3270/core', '0.1.2')).rejects.toThrow(/503/);
    });
  });

  describe('verifyReadBack', () => {
    it('retries until the registry has every sha1', async () => {
      const set = tarballs([['core', '0.1.2', {}], ['frontend', '0.1.2', { '@tn3270/core': '0.1.2' }]]);
      let calls = 0;
      const f = fakeFetch((url) => {
        calls++;
        const t = set.find((x) => url.includes(x.name.replace('/', '%2F')))!;
        return calls <= 4 ? 404 : { versions: { '0.1.2': { dist: { shasum: t.sha1 } } } };
      });
      const sleeps: number[] = [];
      const left = await verifyReadBack(f, set, '0.1.2', { attempts: 5, delayMs: 7, sleep: async (ms) => { sleeps.push(ms); } });
      expect(left).toEqual([]);
      expect(sleeps).toEqual([7, 7]);
    });

    it('gives up after `attempts`, naming what never matched', async () => {
      const set = tarballs([['core', '0.1.2', {}], ['frontend', '0.1.2', { '@tn3270/core': '0.1.2' }]]);
      const f = fakeFetch((url) => url.includes('core')
        ? { versions: { '0.1.2': { dist: { shasum: set[0]!.sha1 } } } }
        : { versions: { '0.1.2': { dist: { shasum: 'wrong' } } } });
      const sleeps: number[] = [];
      const left = await verifyReadBack(f, set, '0.1.2', { attempts: 3, delayMs: 1, sleep: async (ms) => { sleeps.push(ms); } });
      expect(left).toEqual(['@tn3270/frontend']);
      expect(sleeps).toHaveLength(2);
    });

    it('counts a failing fetch as not yet there, not as a crash', async () => {
      const set = tarballs([['core', '0.1.2', {}]]);
      let n = 0;
      const f = fakeFetch(() => (++n === 1 ? 503 : { versions: { '0.1.2': { dist: { shasum: set[0]!.sha1 } } } }));
      expect(await verifyReadBack(f, set, '0.1.2', { attempts: 2, delayMs: 1, sleep: async () => {} })).toEqual([]);
    });
  });
});
