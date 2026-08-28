import { describe, it, expect } from 'vitest';
import { parseHostSpec, resolveHostSpec } from '../src/hostspec.js';

/**
 * s3270's documented host shape is `[prefix:][LUname@]hostname[:port]`, with prefixes
 * stacked one colon each and multiple LUs comma-separated, tried in order as
 * rejections come back (telnet.c setup_lus/next_lu).
 */
describe('parseHostSpec', () => {
  it('parses a bare host', () => {
    expect(parseHostSpec('mvs.example.com')).toEqual({
      host: 'mvs.example.com', lus: [], prefixes: [], portText: undefined,
    });
  });

  it('parses host and port', () => {
    expect(parseHostSpec('127.0.0.1:3271')).toEqual({
      host: '127.0.0.1', lus: [], prefixes: [], portText: '3271',
    });
  });

  it('parses one LU', () => {
    expect(parseHostSpec('TESTLU01@host:23')).toEqual({
      host: 'host', lus: ['TESTLU01'], prefixes: [], portText: '23',
    });
  });

  it('parses a comma-separated LU list, preserving order', () => {
    // The order is MEANINGFUL -- s3270 tries them in sequence as REJECTs come back --
    // so it must not be sorted or de-duplicated.
    expect(parseHostSpec('LUA,LUB,LUC@host').lus).toEqual(['LUA', 'LUB', 'LUC']);
  });

  it('keeps a duplicated LU rather than collapsing it', () => {
    // Asking for the same resource twice is legal and might succeed the second time,
    // once whatever held it has gone.
    expect(parseHostSpec('LUA,LUA@host').lus).toEqual(['LUA', 'LUA']);
  });

  it('collects prefixes and strips them, case-insensitively', () => {
    expect(parseHostSpec('N:L:host:992')).toEqual({
      host: 'host', lus: [], prefixes: ['N', 'L'], portText: '992',
    });
    expect(parseHostSpec('n:host').prefixes).toEqual(['N']);
  });

  it('does NOT read two letters written together as two prefixes', () => {
    // s3270 requires a colon per prefix and calls `SC:host` a syntax error
    // ("double ':'"). Accepting it here would silently apply prefixes the operator
    // did not get from s3270, and it is also what keeps a one-character hostname
    // from being eaten as a prefix.
    expect(parseHostSpec('SC:host').prefixes).toEqual([]);
    expect(parseHostSpec('SC:host').host).toBe('SC');
    expect(parseHostSpec('SC:host').portText).toBe('host');
  });

  it('does not mistake an IPv6 literal for prefixes', () => {
    // A bracketed literal owns its colons. Getting this wrong turns ::1 into several
    // unknown prefixes and an empty host.
    expect(parseHostSpec('[::1]:3271')).toEqual({
      host: '::1', lus: [], prefixes: [], portText: '3271',
    });
  });

  it('parses an IPv6 literal with no port', () => {
    expect(parseHostSpec('[fe80::1]')).toEqual({
      host: 'fe80::1', lus: [], prefixes: [], portText: undefined,
    });
  });

  it('parses an LU and a prefix alongside an IPv6 literal', () => {
    expect(parseHostSpec('N:LUA@[::1]:992')).toEqual({
      host: '::1', lus: ['LUA'], prefixes: ['N'], portText: '992',
    });
  });

  it('keeps the LU list when a prefix is also present', () => {
    expect(parseHostSpec('N:LUA,LUB@host:23')).toEqual({
      host: 'host', lus: ['LUA', 'LUB'], prefixes: ['N'], portText: '23',
    });
  });

  it('splits on the LAST @, so an LU name cannot swallow the host', () => {
    expect(parseHostSpec('LUA@LUB@host').lus).toEqual(['LUA@LUB']);
    expect(parseHostSpec('LUA@LUB@host').host).toBe('host');
  });

  it('rejects an empty LU in the list rather than requesting a nameless one', () => {
    expect(() => parseHostSpec('LUA,,LUB@host')).toThrow(/empty LU name/i);
  });

  it('rejects an empty host', () => {
    expect(() => parseHostSpec('LUA@')).toThrow(/no host/i);
    expect(() => parseHostSpec(':3271')).toThrow(/no host/i);
  });

  it('rejects an unterminated bracket', () => {
    expect(() => parseHostSpec('[::1:3271')).toThrow(/unterminated/i);
  });

  it('treats only s3270 PREFIX LETTERS as prefixes, not every letter', () => {
    // The set is exactly `AaCcLlNnPpSsBbYyTt` (Common/split_host.c:38). This file
    // previously matched [A-Za-z], which made `Z:host` a prefix `Z` plus host `host`
    // where s3270 leaves `Z:host` alone -- so a typo silently became a prefix, and a
    // hostname of one letter could be eaten. The letters are checked one at a time
    // because the whole point is which are IN the set and which are not.
    for (const p of ['A', 'C', 'L', 'N', 'P', 'S', 'B', 'Y', 'T']) {
      expect(parseHostSpec(`${p}:host`).prefixes).toEqual([p]);
      expect(parseHostSpec(`${p.toLowerCase()}:host`).prefixes).toEqual([p]);
    }
    for (const p of ['Z', 'Q', 'D', 'E', 'X']) {
      expect(parseHostSpec(`${p}:host`).prefixes).toEqual([]);
      expect(parseHostSpec(`${p}:host`).host).toBe(p);
    }
  });
});

/**
 * `resolveHostSpec` is where prefix MEANING lives, and it is deliberately one
 * function rather than a rule copied into each front end. The two arg parsers already
 * diverged once over `-insecure` (see `harness-flags.test.ts`), and a prefix that
 * disabled TN3270E in the TUI but not the CLI would be the same class of bug.
 */
describe('resolveHostSpec', () => {
  const err = (m: string) => new Error(m);

  it('defaults the port to 23, and says nothing about TN3270E', () => {
    expect(resolveHostSpec('host', err)).toEqual({
      host: 'host', port: 23, lus: [], tn3270e: undefined, tlsRequested: false,
    });
  });

  it('takes the port from the argument', () => {
    expect(resolveHostSpec('host:3270', err).port).toBe(3270);
  });

  it('reports L: without changing the port', () => {
    // s3270 keeps 23 for `L:` too (host.c): silently redirecting to 992 would open a
    // connection somewhere the operator did not type.
    expect(resolveHostSpec('L:host', err)).toMatchObject({
      host: 'host', port: 23, tlsRequested: true,
    });
    expect(resolveHostSpec('l:host:992', err)).toMatchObject({ port: 992, tlsRequested: true });
  });

  it('turns N: into tn3270e false', () => {
    expect(resolveHostSpec('N:host', err)).toMatchObject({ host: 'host', tn3270e: false });
    expect(resolveHostSpec('n:host', err).tn3270e).toBe(false);
  });

  it('carries an LU list, a prefix and a port together', () => {
    expect(resolveHostSpec('N:LUA,LUB@host:992', err)).toEqual({
      host: 'host', port: 992, lus: ['LUA', 'LUB'], tn3270e: false, tlsRequested: false,
    });
  });

  it('accepts B: and does nothing, because s3270 does nothing', () => {
    // "B:, now a no-op" (split_host.h). Refusing it would reject a host argument that
    // works in s3270 and changes no behaviour there either.
    expect(resolveHostSpec('B:host', err)).toEqual({
      host: 'host', port: 23, lus: [], tn3270e: undefined, tlsRequested: false,
    });
  });

  it('REFUSES the prefixes we do not implement, rather than ignoring them', () => {
    // Every one of these changes what s3270 puts on the wire. Silently dropping one
    // gives the operator a session they did not ask for and cannot see in the trace --
    // the same reasoning that makes `L:` alongside `-insecure` an error.
    expect(() => resolveHostSpec('A:host', err)).toThrow(/A:.*NVT|ANSI/i);
    expect(() => resolveHostSpec('C:host', err)).toThrow(/C:/);
    expect(() => resolveHostSpec('P:host', err)).toThrow(/P:.*passthru/i);
    expect(() => resolveHostSpec('S:host', err)).toThrow(/S:/);
    expect(() => resolveHostSpec('T:host', err)).toThrow(/T:/);
    expect(() => resolveHostSpec('Y:host', err)).toThrow(/Y:.*noverifycert/i);
  });

  it('names the flag to use instead where there is one', () => {
    // An error that says only "unsupported" makes the operator go and read the source.
    expect(() => resolveHostSpec('Y:host', err)).toThrow(/-noverifycert/);
  });

  it('rejects a port that is not a number', () => {
    // `splitTarget` used Number() with no check, so `host:abc` connected to port NaN.
    expect(() => resolveHostSpec('host:abc', err)).toThrow(/port/i);
    expect(() => resolveHostSpec('host:', err)).toThrow(/port/i);
    expect(() => resolveHostSpec('host:3270x', err)).toThrow(/port/i);
    expect(() => resolveHostSpec('host:32.70', err)).toThrow(/port/i);
  });

  it('rejects a port outside 1-65535', () => {
    expect(() => resolveHostSpec('host:0', err)).toThrow(/port/i);
    expect(() => resolveHostSpec('host:65536', err)).toThrow(/port/i);
    expect(() => resolveHostSpec('host:-1', err)).toThrow(/port/i);
    expect(resolveHostSpec('host:65535', err).port).toBe(65535);
    expect(resolveHostSpec('host:1', err).port).toBe(1);
  });

  it('reports an unknown letter as a bad port, the way s3270 does', () => {
    // `Z:host` is not a prefix, so `Z` is the host and `host` is the port text.
    expect(() => resolveHostSpec('Z:host', err)).toThrow(/port/i);
  });

  it('resolves an IPv6 literal', () => {
    expect(resolveHostSpec('L:LUA@[::1]:992', err)).toEqual({
      host: '::1', port: 992, lus: ['LUA'], tn3270e: undefined, tlsRequested: true,
    });
  });

  it('raises the caller s error type, so each front end reports its own usage', () => {
    class Usage extends Error {}
    expect(() => resolveHostSpec('C:host', (m) => new Usage(m))).toThrow(Usage);
  });
});
