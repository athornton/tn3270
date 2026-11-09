import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readTar } from '../../../scripts/tarball.mjs';
import { publishedPackages, tarballName } from '../../../scripts/workspaces.mjs';
import {
  checkRelease, decide, main, publishOrder, readTarball, registryShasum, verifyReadBack,
  type FetchFn, type Tarball,
} from '../../../scripts/publish.mjs';

/** One 512-byte ustar header for `name` of `size` bytes, of tar `type` ('0' regular, 'x' pax). */
function header(name: string, size: number, type = '0', sizeField?: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(sizeField ?? size.toString(8).padStart(11, '0') + '\0', 124);
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

/** `blocks` and the end-of-archive marker, gzipped. */
function tgzOf(blocks: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe('readTar', () => {
  let d: string | undefined;
  afterEach(() => { if (d) rmSync(d, { recursive: true, force: true }); d = undefined; });
  const write = (bytes: Buffer) => { d ??= mkdtempSync(join(tmpdir(), 'tar-')); const p = join(d, 'x.tgz'); writeFileSync(p, bytes); return p; };

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

  it('applies a global pax header to every later entry, and lists it as none', () => {
    const g = Buffer.from(paxRecord('path', 'package/global.txt'));
    const p = write(tgzOf([header('pax_global_header', g.length, 'g'), ...padded(g),
      header('package/x', 2), ...padded(Buffer.from('hi'))]));
    expect([...readTar(p).keys()]).toEqual(['package/global.txt']);
  });

  it('takes a GNU L long name for the next entry', () => {
    const long = `package/${'b'.repeat(130)}`;
    const l = Buffer.from(`${long}\0`);
    const p = write(tgzOf([header('././@LongLink', l.length, 'L'), ...padded(l),
      header(long.slice(0, 100), 3), ...padded(Buffer.from('abc')), header('package/LICENSE', 3), ...padded(Buffer.from('MIT'))]));
    const t = readTar(p);
    expect([...t.keys()]).toEqual([long, 'package/LICENSE']);
    expect(t.get(long)!.toString()).toBe('abc');
  });

  it('refuses a negative size field rather than looping on it', () => {
    const p = write(tgzOf([header('package/x', 0, '0', '-0001000\0')]));
    expect(() => readTar(p)).toThrow(/bad size "-0001000"/);
  });

  it('refuses a negative pax size rather than looping on it', () => {
    const x = Buffer.from(paxRecord('size', '-512'));
    const p = write(tgzOf([header('PaxHeader/x', x.length, 'x'), ...padded(x), header('package/x', 0)]));
    expect(() => readTar(p)).toThrow(/bad size "-512"/);
  });

  it('refuses an entry whose data runs past the end', () => {
    // No end-of-archive marker and no data: the header claims 4096 bytes that are not there.
    const p = write(gzipSync(header('package/x', 4096)));
    expect(() => readTar(p)).toThrow(/truncated/);
  });

  it('refuses a truncated gzip', () => {
    const whole = makeTgz({ 'package/package.json': '{}', 'package/LICENSE': 'x'.repeat(5000) });
    const p = write(whole.subarray(0, whole.length - 20));
    expect(() => readTar(p)).toThrow(/not a complete gzip file/);
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

    it('takes @tn3270 dependencies from optionalDependencies and peerDependencies too', () => {
      dir ??= mkdtempSync(join(tmpdir(), 'publish-'));
      const p = join(dir, 'tn3270-web-0.1.2.tgz');
      writeFileSync(p, makeTgz({ 'package/package.json': JSON.stringify({
        name: '@tn3270/web', version: '0.1.2', optionalDependencies: { '@tn3270/core': '0.1.2' },
        peerDependencies: { '@tn3270/canvas': '^0.1.2', react: '*' }, devDependencies: { '@tn3270/fixtures': '*' },
      }) }));
      const t = readTarball(p);
      expect(t.deps).toEqual({ '@tn3270/core': '0.1.2', '@tn3270/canvas': '^0.1.2' });
      const r = checkRelease({ tag: 'v0.1.2', tarballs: [t], expectedNames: ['@tn3270/web'] });
      expect(r.problems).toEqual([expect.stringMatching(/@tn3270\/canvas as "\^0\.1\.2", not exactly 0\.1\.2/)]);
    });

    it.each([['no name', { version: '1.0.0' }], ['a numeric version', { name: '@tn3270/x', version: 1 }]])(
      'refuses a manifest with %s, by message', (_what, m) => {
        dir ??= mkdtempSync(join(tmpdir(), 'publish-'));
        const p = join(dir, 'bad.tgz');
        writeFileSync(p, makeTgz({ 'package/package.json': JSON.stringify(m) }));
        expect(() => readTarball(p)).toThrow(/bad\.tgz's package\/package\.json has no string name and version/);
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

    it('gives every request a timeout, which aborts a stalled one', async () => {
      const seen: Array<AbortSignal | undefined> = [];
      const stall: FetchFn = (_url, init) => {
        seen.push(init?.signal);
        return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      };
      const t0 = Date.now();
      await expect(registryShasum(stall, '@tn3270/core', '0.1.2', { timeoutMs: 50 })).rejects.toThrow(/timeout|abort/i);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(seen[0]).toBeInstanceOf(AbortSignal);
      const f = fakeFetch(() => 404);
      const calls: Array<AbortSignal | undefined> = [];
      await registryShasum((u, i) => { calls.push(i?.signal); return f(u); }, '@tn3270/core', '0.1.2');
      expect(calls[0]).toBeInstanceOf(AbortSignal);
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

    it('stops at the wall-clock deadline even with attempts left', async () => {
      const set = tarballs([['core', '0.1.2', {}]]);
      let clock = 0;
      const sleeps: number[] = [];
      // Each fetch takes 50 s of fake time, as a slow registry's would.
      const slow = fakeFetch(() => { clock += 50_000; return 404; });
      const left = await verifyReadBack(slow, set, '0.1.2', {
        attempts: 24, delayMs: 5000, deadlineMs: 120_000, now: () => clock,
        sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      });
      expect(left).toEqual(['@tn3270/core']);
      expect(slow.urls.length).toBeLessThanOrEqual(3);
      expect(clock).toBeLessThan(120_000 + 50_000);
    });

    it('counts a failing fetch as not yet there, not as a crash', async () => {
      const set = tarballs([['core', '0.1.2', {}]]);
      let n = 0;
      const f = fakeFetch(() => (++n === 1 ? 503 : { versions: { '0.1.2': { dist: { shasum: set[0]!.sha1 } } } }));
      expect(await verifyReadBack(f, set, '0.1.2', { attempts: 2, delayMs: 1, sleep: async () => {} })).toEqual([]);
    });
  });

  describe('main', () => {
    const ORDER = ['core', 'frontend', 'canvas', 'node-files', 'cli', 'gui', 'tui', 'web'].map((n) => `@tn3270/${n}`);
    const NPM11 = 'npm error You cannot publish over the previously published versions: 0.1.2.';

    /**
     * Fakes for every outside effect. The registry is PER VERSION, `name@version` -> shasum, and
     * holds every package at 0.1.1 with other bytes, so a lookup of the wrong version shows.
     * `run` acts as npm: a publish adds the version (unless `neverReadBack`), and with `npm11` a
     * dry run of a version already there exits 1 with npm 11's message.
     */
    function io(opts: {
      tag?: string; refType?: string; actions?: boolean; registry?: Record<string, string>;
      failRun?: string; neverReadBack?: boolean; npm11?: boolean;
      runAlways?: { status: number; output: string };
      fetchFail?: () => Promise<never> | number; tamper?: (registry: Record<string, string>, call: number) => void;
    } = {}) {
      const registry: Record<string, string> = { ...Object.fromEntries(ORDER.map((n) => [`${n}@0.1.1`, '0'.repeat(40)])), ...opts.registry };
      const runs: string[][] = [];
      const captures: boolean[] = [];
      const logs: string[] = [];
      const sleeps: number[] = [];
      let calls = 0;
      const answer = fakeFetch((url) => {
        calls++;
        opts.tamper?.(registry, calls);
        const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').replace('?write=true', ''));
        const versions = Object.fromEntries(Object.entries(registry)
          .filter(([k]) => k.startsWith(`${name}@`)).map(([k, sha]) => [k.slice(name.length + 1), { dist: { shasum: sha } }]));
        return Object.keys(versions).length === 0 ? 404 : { versions };
      });
      const fetchFn: FetchFn = opts.fetchFail === undefined ? answer : async () => {
        const r = await opts.fetchFail!();
        return { ok: false, status: r, json: async () => ({}) };
      };
      const run = (args: string[], { capture }: { capture: boolean }) => {
        runs.push(args);
        captures.push(capture);
        if (opts.runAlways !== undefined) return opts.runAlways;
        const path = args.at(-1)!;
        if (opts.failRun !== undefined && path.includes(opts.failRun)) return { status: 1, output: 'npm error code E403' };
        const t = readTarball(path);
        const key = `${t.name}@${t.version}`;
        if (args[1] === '--dry-run') {
          return opts.npm11 && registry[key] !== undefined ? { status: 1, output: `npm notice ...\n${NPM11}\n` } : { status: 0, output: '' };
        }
        if (!opts.neverReadBack) registry[key] = t.sha1;
        return { status: 0, output: '' };
      };
      const env: Record<string, string> = {};
      if (opts.tag !== undefined) { env.GITHUB_REF_NAME = opts.tag; env.GITHUB_REF_TYPE = opts.refType ?? 'tag'; }
      if (opts.actions) env.GITHUB_ACTIONS = 'true';
      return {
        runs, captures, logs, sleeps, registry,
        args: { env, fetchFn, run, sleep: async (ms: number) => { sleeps.push(ms); }, log: (l: string) => { logs.push(l); } },
      };
    }

    const nameOf = (args: string[]) => readTarball(args.at(-1)!).name;
    const shaOf = (set: Tarball[], n: string) => set.find((t) => t.name === n)!.sha1;
    /** Every package of `set` on the registry at its version with its own bytes. */
    const published = (set: Tarball[]) => Object.fromEntries(set.map((t) => [`${t.name}@${t.version}`, t.sha1]));

    describe('--dry-run', () => {
      it('runs npm publish --dry-run for all eight, in dependency order', async () => {
        realSet('0.1.2');
        const x = io();
        expect(await main(['--dry-run', dir!], x.args)).toBe(0);
        expect(x.runs.map((a) => a.slice(0, 2))).toEqual(Array(8).fill(['publish', '--dry-run']));
        expect(x.runs.map(nameOf)).toEqual(ORDER);
        expect(x.captures).toEqual(Array(8).fill(true));
        expect(x.logs.at(-1)).toBe('publish: dry run of 0.1.2 passed for all 8');
      });

      it('still runs npm for a version already published, and accepts npm 11 refusing it', async () => {
        const set = realSet('0.1.2');
        const x = io({ npm11: true, registry: published(set) });
        expect(await main(['--dry-run', dir!], x.args)).toBe(0);
        expect(x.runs).toHaveLength(8);
        expect(x.logs.filter((l) => /already on the registry, which this npm refuses even dry: accepted/.test(l))).toHaveLength(8);
        expect(x.logs.at(-1)).toBe('publish: dry run of 0.1.2 passed for all 8, 8 refused by npm as already published');
      });

      it("refuses npm 11's message when the registry does not have that version", async () => {
        realSet('0.1.2');
        const x = io({ runAlways: { status: 1, output: NPM11 } });
        expect(await main(['--dry-run', dir!], x.args)).toBe(1);
        expect(x.runs).toHaveLength(1);
        expect(x.logs.join('\n')).toMatch(/refused: npm publish --dry-run tn3270-core-0\.1\.2\.tgz exited 1/);
      });

      it('refuses any other npm failure, even for a version already published', async () => {
        const set = realSet('0.1.2');
        const x = io({ registry: published(set), runAlways: { status: 1, output: 'npm error code E500' } });
        expect(await main(['--dry-run', dir!], x.args)).toBe(1);
        expect(x.runs).toHaveLength(1);
      });

      it("refuses npm 11's message when the registry cannot be read", async () => {
        realSet('0.1.2');
        const x = io({ fetchFail: () => 503, runAlways: { status: 1, output: NPM11 } });
        expect(await main(['--dry-run', dir!], x.args)).toBe(1);
        expect(x.logs.join('\n')).toMatch(/exited 1 \(and the registry could not be read: registry answered 503/);
      });

      it('passes when the registry cannot be read but npm accepts every dry run', async () => {
        realSet('0.1.2');
        const x = io({ fetchFail: () => 503 });
        expect(await main(['--dry-run', dir!], x.args)).toBe(0);
        expect(x.runs).toHaveLength(8);
      });

      it('warns, and on Actions annotates, a version published with OTHER contents', async () => {
        const set = realSet('0.1.2');
        const registry = { ...published(set), '@tn3270/web@0.1.2': 'f'.repeat(40) };
        const msg = '@tn3270/web@0.1.2 is already on the registry with OTHER contents: bump the version (npm run version:set) before tagging, or the release will be refused';
        const local = io({ npm11: true, registry });
        expect(await main(['--dry-run', dir!], local.args)).toBe(0);
        expect(local.logs).toContain(`publish: WARNING: ${msg}`);
        expect(local.logs.some((l) => l.startsWith('::warning::'))).toBe(false);
        const ci = io({ npm11: true, registry, actions: true });
        expect(await main(['--dry-run', dir!], ci.args)).toBe(0);
        expect(ci.logs).toContain(`::warning::${msg}`);
        expect(ci.logs.filter((l) => l.startsWith('::warning::'))).toHaveLength(1);
      });

      it('refuses a failing npm publish --dry-run', async () => {
        realSet('0.1.2');
        const x = io({ failRun: 'tn3270-canvas' });
        expect(await main(['--dry-run', dir!], x.args)).toBe(1);
        expect(x.logs.join('\n')).toMatch(/refused: npm publish --dry-run tn3270-canvas-0\.1\.2\.tgz exited 1/);
      });
    });

    it('refuses a bad mode or a missing directory with the usage', async () => {
      const x = io();
      expect(await main(['--frobnicate', '/nowhere'], x.args)).toBe(1);
      expect(await main(['--check'], x.args)).toBe(1);
      expect(x.logs.every((l) => /usage/.test(l))).toBe(true);
    });

    it('--check refuses a manifest without a name, by message', async () => {
      realSet('0.1.2');
      writeFileSync(join(dir!, 'zz.tgz'), makeTgz({ 'package/package.json': '{"version":"0.1.2"}' }));
      const x = io({ tag: 'v0.1.2' });
      expect(await main(['--check', dir!], x.args)).toBe(1);
      expect(x.logs).toEqual(["publish: refused: zz.tgz: zz.tgz's package/package.json has no string name and version: repack it"]);
    });

    it('--check refuses without GITHUB_REF_NAME', async () => {
      realSet('0.1.2');
      const x = io();
      expect(await main(['--check', dir!], x.args)).toBe(1);
      expect(x.logs.join('\n')).toMatch(/GITHUB_REF_NAME/);
    });

    it.each([['branch'], [undefined]])('--check and --publish refuse GITHUB_REF_TYPE %s', async (refType) => {
      realSet('0.1.2');
      for (const mode of ['--check', '--publish']) {
        const x = io({ tag: 'v0.1.2' });
        if (refType === undefined) delete x.args.env.GITHUB_REF_TYPE; else x.args.env.GITHUB_REF_TYPE = refType;
        expect(await main([mode, dir!], x.args)).toBe(1);
        expect(x.runs).toEqual([]);
        expect(x.logs.join('\n')).toMatch(/GITHUB_REF_TYPE is .*not "tag"/);
      }
    });

    it('--check prints the plan, publishing nothing', async () => {
      const set = realSet('0.1.2');
      const x = io({ tag: 'v0.1.2', registry: { '@tn3270/core@0.1.2': shaOf(set, '@tn3270/core') } });
      expect(await main(['--check', dir!], x.args)).toBe(0);
      expect(x.runs).toEqual([]);
      expect(x.logs).toContain('  skip    @tn3270/core');
      expect(x.logs).toContain('  publish @tn3270/web');
    });

    it('--check and --publish refuse a conflict before running anything', async () => {
      realSet('0.1.2');
      for (const mode of ['--check', '--publish']) {
        const x = io({ tag: 'v0.1.2', registry: { '@tn3270/tui@0.1.2': 'f'.repeat(40) } });
        expect(await main([mode, dir!], x.args)).toBe(1);
        expect(x.runs).toEqual([]);
        expect(x.logs.join('\n')).toMatch(/@tn3270\/tui@0\.1\.2 is already on the registry with other contents/);
      }
    });

    it.each([
      ['answers 503', () => 503],
      ['throws', () => Promise.reject(new Error('ECONNRESET'))],
    ])('--check and --publish refuse when the registry %s, running nothing', async (_what, fail) => {
      realSet('0.1.2');
      for (const mode of ['--check', '--publish']) {
        const x = io({ tag: 'v0.1.2', fetchFail: fail });
        expect(await main([mode, dir!], x.args)).toBe(1);
        expect(x.runs).toEqual([]);
        expect(x.logs.join('\n')).toMatch(/refused: cannot read @tn3270\/core from the registry: (registry answered 503|ECONNRESET)/);
      }
    });

    it('--publish skips what is identical, publishes the rest in order, and verifies', async () => {
      const set = realSet('0.1.2');
      const x = io({ tag: 'v0.1.2', registry: {
        '@tn3270/core@0.1.2': shaOf(set, '@tn3270/core'), '@tn3270/canvas@0.1.2': shaOf(set, '@tn3270/canvas') } });
      expect(await main(['--publish', dir!], x.args)).toBe(0);
      expect(x.runs.every((a) => a[0] === 'publish' && a.length === 2)).toBe(true);
      // Not captured: a real publish streams, and a login/OTP prompt is visible.
      expect(x.captures).toEqual(Array(6).fill(false));
      expect(x.runs.map(nameOf)).toEqual(ORDER.filter((n) => n !== '@tn3270/core' && n !== '@tn3270/canvas'));
      expect(x.logs.at(-1)).toBe('published 0.1.2: 6 new, 2 already there, registry verified');
    });

    it('--publish reads back the SKIPPED packages too', async () => {
      const set = realSet('0.1.2');
      // Identical at plan time (the first eight reads); other bytes by the read-back.
      const x = io({ tag: 'v0.1.2', registry: { '@tn3270/core@0.1.2': shaOf(set, '@tn3270/core') },
        tamper: (reg, call) => { if (call > 8) reg['@tn3270/core@0.1.2'] = 'e'.repeat(40); } });
      expect(await main(['--publish', dir!], x.args)).toBe(1);
      expect(x.runs).toHaveLength(7);
      expect(x.logs.at(-1)).toMatch(/registry does not hold 0\.1\.2 .*: @tn3270\/core$/);
    });

    it('--publish stops at the first failing npm publish, and names what was not attempted', async () => {
      realSet('0.1.2');
      const x = io({ tag: 'v0.1.2', failRun: 'tn3270-node-files' });
      expect(await main(['--publish', dir!], x.args)).toBe(1);
      expect(x.runs.map(nameOf)).toEqual(ORDER.slice(0, 4));
      const out = x.logs.join('\n');
      expect(out).toMatch(/tn3270-node-files-0\.1\.2\.tgz exited 1; not attempted: @tn3270\/cli, @tn3270\/gui, @tn3270\/tui, @tn3270\/web/);
      expect(out).toMatch(/Re-run the failed publish job \(not all jobs, which rebuilds the tarballs\)/);
    });

    it('--publish fails when the registry never shows what was published', async () => {
      realSet('0.1.2');
      const x = io({ tag: 'v0.1.2', neverReadBack: true });
      expect(await main(['--publish', dir!], x.args)).toBe(1);
      expect(x.runs).toHaveLength(8);
      expect(x.sleeps).toHaveLength(23);
      expect(x.logs.at(-1)).toMatch(/registry does not hold 0\.1\.2 .*@tn3270\/core, @tn3270\/frontend/);
    });
  });
});
