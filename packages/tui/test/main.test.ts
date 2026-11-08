import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMES } from '@tn3270/frontend';
import { BANNER, buildSession, connectFirst, parseArgs, run, UsageError } from '../src/main.js';
import type { HostProcess } from '../src/app.js';

// Importing this module is safe: the entry point is behind an `isMain(import.meta.url)` guard
// (packaging milestone, 2026-11-05 -- replaced the old `import.meta.url ===
// file://${process.argv[1]}` comparison, which was false through npm's installed symlink and
// never ran at all), so requiring it from a test does not start a session. (The CLI's main.ts
// has no such guard and DOES run on import, which is why the TUI is wired this way and why
// cli/src/index.ts deliberately does not re-export it.)

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
    // impossible to select on a color terminal, which is how it gets tested.
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

  it('rejects an unrecognized flag rather than ignoring it', () => {
    // Same reasoning as the CLI: a silently skipped flag produces a session that
    // negotiates something nobody asked for, which is very hard to see in a trace.
    expect(() => parseArgs(['--nonesuch', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-x'])).toThrow(/unrecognized/);
  });

  it('rejects a second host instead of silently taking one of them', () => {
    expect(() => parseArgs(['a:1', 'b:2'])).toThrow(/more than one host/);
  });

  it('parses -scheme, case-insensitively, and rejects an unknown name by listing them', () => {
    expect(parseArgs(['-scheme', 'green', 'h']).scheme).toBe(SCHEMES.green);
    expect(parseArgs(['-scheme', 'GreenScreen', 'h']).scheme).toBe(SCHEMES.green);
    expect(parseArgs(['h']).scheme).toBeUndefined();
    expect(() => parseArgs(['-scheme', 'solarized', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-scheme', 'solarized', 'h'])).toThrow(/default, 3279, x3270, green/);
    expect(() => parseArgs(['-scheme', 'h'])).toThrow(UsageError);
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

describe('-bind-image', () => {
  it('off clears the option', () => {
    expect(parseArgs(['-bind-image', 'off', 'h:23']).bindImage).toBe(false);
  });

  it('defaults to on', () => {
    expect(parseArgs(['h:23']).bindImage).not.toBe(false);
  });

  it('rejects a value that is not on or off', () => {
    expect(() => parseArgs(['-bind-image', 'yes', 'h:23'])).toThrow(UsageError);
  });

  it('without a value is a usage error', () => {
    expect(() => parseArgs(['-bind-image'])).toThrow(UsageError);
  });
});

describe('-devname', () => {
  it('sets the device name template', () => {
    expect(parseArgs(['-devname', 'foo===', 'h:23']).devname).toBe('foo===');
  });

  it('has no device name by default', () => {
    expect(parseArgs(['h:23']).devname).toBeUndefined();
  });

  it('without a value is a usage error', () => {
    expect(() => parseArgs(['-devname'])).toThrow(UsageError);
  });
});

describe('-bind-limit', () => {
  it('off lets an out-of-range BIND geometry through', () => {
    expect(parseArgs(['-bind-limit', 'off', 'h:23']).bindLimit).toBe(false);
  });

  it('defaults to on', () => {
    expect(parseArgs(['h:23']).bindLimit).not.toBe(false);
  });

  it('rejects a value that is not on or off', () => {
    expect(() => parseArgs(['-bind-limit', 'yes', 'h:23'])).toThrow(UsageError);
  });

  it('without a value is a usage error', () => {
    expect(() => parseArgs(['-bind-limit'])).toThrow(UsageError);
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
    // Pre-existing behavior, re-pinned because the check moved from a regex on the
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

describe('-oversize', () => {
  it('parses auto and a fixed size; the TUI has a window, so auto is allowed', () => {
    expect(parseArgs(['-oversize', 'auto', 'h']).oversize).toEqual({ kind: 'auto' });
    expect(parseArgs(['-oversize', '160x62', 'h']).oversize)
      .toEqual({ kind: 'fixed', rows: 62, cols: 160 });
    expect(parseArgs(['-oversize', 'none', 'h']).oversize).toEqual({ kind: 'none' });
    expect(parseArgs(['h']).oversize).toBeUndefined();
  });

  it('refuses --terminal-type with it, at parse time', () => {
    expect(() => parseArgs(['--terminal-type', 'X', '-oversize', 'auto', 'h']))
      .toThrow(UsageError);
    expect(() => parseArgs(['--terminal-type', 'X', '-oversize', 'auto', 'h']))
      .toThrow(/cannot both be given/);
  });

  it('refuses a model without -E, at parse time, auto included', () => {
    expect(() => parseArgs(['-model', '3278-2', '-oversize', 'auto', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-model', '3278-2', '-oversize', 'auto', 'h']))
      .toThrow(/extended model/);
    expect(() => parseArgs(['-model', '3278-2', '-oversize', '160x62', 'h']))
      .toThrow(/extended model/);
  });

  it('refuses a fixed size smaller than the model, and a bad value', () => {
    expect(() => parseArgs(['-model', '3278-4-E', '-oversize', '80x30', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-oversize', 'huge', 'h'])).toThrow(UsageError);
    expect(() => parseArgs(['-oversize'])).toThrow(UsageError);
  });

  it('is in the usage line', async () => {
    const host: HostProcess = { on: () => {}, exit: () => {}, stderr: { write: () => {} } };
    await expect(run([], host)).rejects.toThrow(/\[-oversize <cols>x<rows>\|auto\|none\]/);
  });
});

describe('buildSession: what run() actually constructs', () => {
  // Driven through the function `run()` calls, as the CLI's are -- see the CLI's own
  // `buildSession` tests for why a copy of the expression would not do.
  it('no flags: geometry mode, no model, oversize none', () => {
    const session = buildSession(parseArgs(['h']));
    expect(session.geometrySetting).toEqual({ oversize: { kind: 'none' } });
    expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
  });

  it('-model with -oversize: geometry mode, both carried in the setting', () => {
    const session = buildSession(parseArgs(['-model', '3278-4-E', '-oversize', 'auto', 'h']));
    expect(session.geometrySetting).toEqual({ model: '3278-4-E', oversize: { kind: 'auto' } });
    expect(session.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('--terminal-type: legacy mode, no geometry setting at all', () => {
    const session = buildSession(parseArgs(['--terminal-type', 'IBM-DYNAMIC', 'h']));
    expect(session.geometrySetting).toBeUndefined();
  });

  describe('auto reads the terminal at each connect, not at startup', () => {
    // A REAL connect, to a local socket that says nothing: `Session` does not expose its
    // measure, so the only honest observation is what a connect resolved. `-insecure` keeps
    // it plain TCP.
    // Every accepted socket is destroyed in cleanup: a failed assertion skips the test's own
    // `disconnect()`, and `server.close` would then wait on that socket until the test timed out.
    let server: Server | undefined;
    const sockets: Socket[] = [];
    afterEach(async () => {
      for (const s of sockets.splice(0)) s.destroy();
      await new Promise<void>((r) => { if (server) server.close(() => r()); else r(); });
      server = undefined;
    });

    it('measures the terminal as it is when connect() runs, again on a reconnect', async () => {
      server = createServer((s) => { sockets.push(s); });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const term = { rows: 25, cols: 80 };
      const session = buildSession(
        parseArgs(['-oversize', 'auto', '-insecure', 'h']), () => ({ ...term }),
      );
      term.rows = 51; term.cols = 132;        // resized AFTER construction
      await session.connect('127.0.0.1', port);
      expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 });
      term.rows = 63; term.cols = 160;
      await session.connect('127.0.0.1', port);
      expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
      session.disconnect();
    });

    it('connectFirst: an auto that fell back says so on stderr, once, before the App exists', async () => {
      server = createServer((s) => { sockets.push(s); });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const errors: string[] = [];
      const args = parseArgs(['-model', '3278-4-E', '-oversize', 'auto', '-insecure', `127.0.0.1:${port}`]);
      const session = await connectFirst(args, { write: (t) => { errors.push(t); } },
        () => ({ rows: 25, cols: 80 }));
      expect(session.isConnected()).toBe(true);
      expect(session.lastGeometryNotice).toMatch(/less than model 3278-4-E's/);
      expect(errors).toEqual([`${session.lastGeometryNotice}\n`]);
      session.disconnect();
    });

    it('connectFirst: no notice, nothing on stderr', async () => {
      server = createServer((s) => { sockets.push(s); });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const errors: string[] = [];
      const args = parseArgs(['-oversize', 'auto', '-insecure', `127.0.0.1:${port}`]);
      const session = await connectFirst(args, { write: (t) => { errors.push(t); } },
        () => ({ rows: 51, cols: 132 }));
      expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 });
      expect(errors).toEqual([]);
      session.disconnect();
    });
  });
});

describe('run() with no host', () => {
  /** A HostProcess that records exit codes and stderr. */
  function fakeHost() {
    const exits: number[] = [];
    const errors: string[] = [];
    const host = {
      on: () => {}, exit: (c: number) => { exits.push(c); }, stderr: { write: (t: string) => { errors.push(t); return true; } },
    };
    return { host: host as HostProcess, exits, errors };
  }

  it('without a terminal, is the usage error it always was (scripts never meet a prompt)', async () => {
    const { host } = fakeHost();
    await expect(run([], host)).rejects.toThrow(/usage: tn3270/);
  });

  it('at a terminal, prompts instead; EOF at the first question quits with status 1', async () => {
    const { host, exits } = fakeHost();
    const input = new PassThrough();
    const output = new PassThrough();
    let transcript = '';
    output.on('data', (b: Buffer) => { transcript += b.toString(); if (transcript.endsWith('Host: ')) input.end(); });
    expect(await run([], host, { input, output })).toBe(1);
    expect(exits).toEqual([1]);
    expect(transcript).toBe('Host: \n');
  });

  it('at a terminal, the prompt connects through connectFirst: a refused port is reported, then EOF', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));   // nothing listens there now
    const { host, exits } = fakeHost();
    const input = new PassThrough();
    const output = new PassThrough();
    const answers = [`127.0.0.1:${port}`, '', 'n'];
    let transcript = '';
    output.on('data', (b: Buffer) => {
      transcript += b.toString();
      if (!/: $/.test(transcript)) return;
      if (answers.length > 0) input.write(`${answers.shift()!}\n`); else input.end();
    });
    expect(await run([], host, { input, output })).toBe(1);
    expect(exits).toEqual([1]);
    expect(transcript).toContain(`cannot connect to 127.0.0.1:${port}: connection refused (ECONNREFUSED)`);
    expect(transcript).toContain(`Host [127.0.0.1:${port}]: `);
  });
});
