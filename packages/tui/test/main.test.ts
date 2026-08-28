import { describe, expect, it } from 'vitest';
import { BANNER, parseArgs, UsageError } from '../src/main.js';

// Importing this module is safe: the entry point is behind an
// `import.meta.url === file://${process.argv[1]}` guard, so requiring it from a
// test does not start a session. (The CLI's main.ts has no such guard and DOES
// run on import, which is why the TUI is wired this way and why cli/src/index.ts
// deliberately does not re-export it.)

/** TLS is ON by default, so every parse carries it. See the CLI's own test. */
const TLS = { kind: 'tls', verify: true } as const;

describe('parseArgs', () => {
  it('takes a bare argument as the host', () => {
    expect(parseArgs(['127.0.0.1:3270']))
      .toEqual({ host: '127.0.0.1', port: 3270, lus: [], tls: TLS });
  });

  it('parses the flags the CLI also has, with the same spellings', () => {
    expect(parseArgs(['-model', '3278-2-E', 'vm:3270']))
      .toEqual({ model: '3278-2-E', host: 'vm', port: 3270, lus: [], tls: TLS });
    expect(parseArgs(['--terminal-type', 'IBM-DYNAMIC', 'vm']))
      .toEqual({ terminalType: 'IBM-DYNAMIC', host: 'vm', port: 23, lus: [], tls: TLS });
  });

  it('understands every --colors spelling', () => {
    const cases: readonly [string, number][] = [
      ['0', 0], ['none', 0], ['mono', 0],
      ['8', 8], ['16', 16], ['256', 256],
      ['16m', 16777216], ['truecolor', 16777216], ['24bit', 16777216], ['16777216', 16777216],
    ];
    for (const [word, depth] of cases) {
      expect(parseArgs(['--colors', word, 'h']).colors, word).toBe(depth);
    }
  });

  it('is case-insensitive about --colors', () => {
    expect(parseArgs(['--colors', '16M', 'h']).colors).toBe(16777216);
    expect(parseArgs(['--colors', 'TrueColor', 'h']).colors).toBe(16777216);
  });

  it('leaves colors undefined for auto, which means detect', () => {
    // Distinct from `--colors 0`: absent means ask terminfo, 0 means monochrome
    // because the user said so. Conflating them would make the monochrome path
    // impossible to select on a colour terminal, which is how it gets tested.
    expect(parseArgs(['--colors', 'auto', 'h']).colors).toBeUndefined();
    expect(parseArgs(['h']).colors).toBeUndefined();
    expect(parseArgs(['--colors', '0', 'h']).colors).toBe(0);
  });

  it('rejects a --colors value it does not understand', () => {
    expect(() => parseArgs(['--colors', '32', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['--colors', 'lots', 'h'])).toThrow(/0, 8, 16, 256, 16m or auto/);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['-model'])).toThrow(UsageError);
    expect(() => parseArgs(['--terminal-type'])).toThrow(UsageError);
    expect(() => parseArgs(['--colors'])).toThrow(UsageError);
  });

  it('rejects an unrecognised flag rather than ignoring it', () => {
    // Same reasoning as the CLI: a silently skipped flag produces a session that
    // negotiates something nobody asked for, which is very hard to see in a trace.
    expect(() => parseArgs(['--nonesuch', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-x'])).toThrow(/unrecognised/);
  });

  it('rejects a second host instead of silently taking one of them', () => {
    expect(() => parseArgs(['a:1', 'b:2'])).toThrow(/more than one host/);
  });
});

describe('the banner', () => {
  it('documents the escape hatch, because Ctrl-C will not quit', () => {
    // Ctrl-C is the Clear AID here. That is correct for a 3270 and surprising for
    // everyone, so the way out has to be on screen before raw mode starts.
    expect(BANNER).toContain('Ctrl-]');
    expect(BANNER.toLowerCase()).toContain('quit');
    expect(BANNER).toContain('Ctrl-C');
    expect(BANNER).toContain('Clear');
  });
});

describe('-tn3270e', () => {
  it('is absent by default, meaning the session default applies', () => {
    expect(parseArgs(['host']).tn3270e).toBeUndefined();
  });

  it('accepts on and off, and does not eat the host', () => {
    // Both parsers, not one. A flag that works in the CLI and not the TUI is worse
    // than a flag that exists in neither, and the two have separate parsers.
    expect(parseArgs(['-tn3270e', 'off', 'host:23'])).toMatchObject({
      tn3270e: false, host: 'host', port: 23,
    });
    expect(parseArgs(['-tn3270e', 'on', 'host']).tn3270e).toBe(true);
  });

  it('rejects a bad or missing value', () => {
    expect(() => parseArgs(['-tn3270e', 'maybe', 'host'])).toThrow(/on or off|takes on or off/i);
    expect(() => parseArgs(['-tn3270e'])).toThrow(/needs a value/i);
  });
});

/**
 * The host argument's full shape, `[prefix:][LU,LU@]host[:port]`.
 *
 * The rules themselves are `resolveHostSpec`'s and are tested there; these pin that
 * the TUI actually APPLIES them, which is the half that was missing — `hostspec.ts`
 * was parsed and tested while `splitTarget` was still what ran.
 */
describe('the host argument', () => {
  it('splits the port off and defaults it to 23', () => {
    expect(parseArgs(['host']).port).toBe(23);
    expect(parseArgs(['host:3271'])).toMatchObject({ host: 'host', port: 3271 });
  });

  it('turns the N: prefix into -tn3270e off', () => {
    expect(parseArgs(['N:host'])).toMatchObject({ host: 'host', tn3270e: false });
  });

  it('refuses N: together with -tn3270e on rather than picking one', () => {
    // Same precedent as L: alongside -insecure: an explicit contradiction is an error,
    // because silently resolving it gives the operator a session they did not ask for
    // and cannot see in the trace.
    expect(() => parseArgs(['-tn3270e', 'on', 'N:host'])).toThrow(UsageError);
    expect(() => parseArgs(['-tn3270e', 'on', 'N:host'])).toThrow(/N:/);
    // Order must not matter: the check runs after the whole vector is parsed.
    expect(() => parseArgs(['N:host', '-tn3270e', 'on'])).toThrow(/N:/);
  });

  it('accepts N: with -tn3270e off, which agree', () => {
    expect(parseArgs(['-tn3270e', 'off', 'N:host']).tn3270e).toBe(false);
  });

  it('carries the LU list through in order', () => {
    expect(parseArgs(['LUA,LUB@host:992'])).toMatchObject({
      host: 'host', port: 992, lus: ['LUA', 'LUB'],
    });
  });

  it('still refuses L: alongside -insecure', () => {
    // Pre-existing behaviour, re-pinned because the check moved from a regex on the
    // raw argument to the resolved `tlsRequested` flag.
    expect(() => parseArgs(['-insecure', 'L:host'])).toThrow(/L:|TLS/);
    expect(() => parseArgs(['-insecure', 'l:host:992'])).toThrow(/L:|TLS/);
  });

  it('accepts L: on its own and strips it', () => {
    // Without stripping, `L:localhost:3270` becomes a DNS lookup for the host `L`.
    expect(parseArgs(['L:host:992'])).toMatchObject({ host: 'host', port: 992 });
  });

  it('rejects an unusable port instead of connecting to NaN', () => {
    expect(() => parseArgs(['host:abc'])).toThrow(UsageError);
    expect(() => parseArgs(['host:0'])).toThrow(/port/i);
  });

  it('refuses a prefix it does not implement', () => {
    expect(() => parseArgs(['P:host'])).toThrow(UsageError);
    expect(() => parseArgs(['Y:host'])).toThrow(/-noverifycert/);
  });
});
