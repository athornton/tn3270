import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { SCHEMES } from '@tn3270/frontend';
import type { GeometrySetting } from '@tn3270/core';
import { buildSession, parseGuiArgs, printGeometryNotices, UsageError } from '../src/args.js';

/**
 * The flags must be the TUI's, and the way that is guaranteed is by parsing with the same
 * shared helpers rather than by keeping two lists in step. These tests pin the BEHAVIOR
 * a user sees; `packages/frontend/test` owns the rules themselves.
 */
describe('parseGuiArgs', () => {
  it('takes the same host shape as the other front ends', () => {
    expect(parseGuiArgs(['N:LUA@vm:3270'])).toMatchObject({
      host: 'vm', port: 3270, lus: ['LUA'], tn3270e: false,
    });
  });

  it('defaults the port to 23', () => {
    expect(parseGuiArgs(['vm']).port).toBe(23);
  });

  it('accepts -model, --terminal-type, -tn3270e and the TLS flags', () => {
    expect(parseGuiArgs(['-model', '3278-4-E', '-insecure', 'vm:3270']))
      .toMatchObject({ model: '3278-4-E', tls: { kind: 'plaintext' } });
    expect(parseGuiArgs(['--terminal-type', 'IBM-3278-4-E@MOD4', 'vm']))
      .toMatchObject({ terminalType: 'IBM-3278-4-E@MOD4' });
    expect(parseGuiArgs(['-tn3270e', 'off', 'vm']).tn3270e).toBe(false);
  });

  it('parses -scheme, case-insensitively, and rejects an unknown name by listing them', () => {
    expect(parseGuiArgs(['-scheme', 'green', 'vm']).scheme).toBe(SCHEMES.green);
    expect(parseGuiArgs(['-scheme', 'GreenScreen', 'vm']).scheme).toBe(SCHEMES.green);
    expect(parseGuiArgs(['vm']).scheme).toBeUndefined();
    // A bare `-scheme` with nothing after it -- the flag's own "needs a value" check,
    // not resolveScheme's unknown-name path.
    expect(() => parseGuiArgs(['-scheme'])).toThrow(UsageError);
    expect(() => parseGuiArgs(['-scheme'])).toThrow(/-scheme needs a value/);
    expect(() => parseGuiArgs(['-scheme', 'solarized', 'vm'])).toThrow(UsageError);
    expect(() => parseGuiArgs(['-scheme', 'solarized', 'vm'])).toThrow(/default, 3279, x3270, green/);
  });

  it('refuses L: together with -insecure, as the others do', () => {
    expect(() => parseGuiArgs(['-insecure', 'L:vm:992'])).toThrow(UsageError);
    expect(() => parseGuiArgs(['-insecure', 'L:vm:992'])).toThrow(/-insecure disables TLS/);
  });

  it('refuses N: together with -tn3270e on', () => {
    expect(() => parseGuiArgs(['-tn3270e', 'on', 'N:vm'])).toThrow(/N:/);
  });

  it('requires a host', () => {
    expect(() => parseGuiArgs([])).toThrow(UsageError);
    expect(() => parseGuiArgs([])).toThrow(/usage/i);
  });

  it('refuses an unrecognized flag rather than ignoring it', () => {
    // Same reasoning as both other front ends: a silently skipped flag produces a session
    // that negotiates something nobody asked for, which is very hard to see in a trace.
    expect(() => parseGuiArgs(['--nonesuch', 'vm'])).toThrow(UsageError);
    expect(() => parseGuiArgs(['-x', 'vm'])).toThrow(/unrecognized/);
  });

  it('rejects an unusable port instead of connecting to NaN', () => {
    expect(() => parseGuiArgs(['vm:abc'])).toThrow(/port/i);
    expect(() => parseGuiArgs(['vm:0'])).toThrow(/port/i);
  });

  it('refuses a host prefix it does not implement', () => {
    expect(() => parseGuiArgs(['P:vm'])).toThrow(/P:/);
    expect(() => parseGuiArgs(['Y:vm'])).toThrow(/-noverifycert/);
  });

  it('rejects a second host instead of silently taking one', () => {
    expect(() => parseGuiArgs(['a:1', 'b:2'])).toThrow(/more than one host/);
  });

  it('names the GUI binary in its usage line, not the TUI s', () => {
    // A usage message that says `tn3270` when the user typed `tn3270-gui` sends them to
    // the wrong manual page.
    expect(() => parseGuiArgs([])).toThrow(/tn3270-gui/);
  });
});

describe('-bind-image', () => {
  it('off clears the option', () => {
    expect(parseGuiArgs(['-bind-image', 'off', 'vm']).bindImage).toBe(false);
  });

  it('defaults to on', () => {
    expect(parseGuiArgs(['vm']).bindImage).not.toBe(false);
  });

  it('rejects a value that is not on or off', () => {
    expect(() => parseGuiArgs(['-bind-image', 'yes', 'vm'])).toThrow(UsageError);
  });

  it('without a value is a usage error', () => {
    expect(() => parseGuiArgs(['-bind-image'])).toThrow(UsageError);
  });
});

describe('-devname', () => {
  it('sets the device name template', () => {
    expect(parseGuiArgs(['-devname', 'foo===', 'vm']).devname).toBe('foo===');
  });

  it('has no device name by default', () => {
    expect(parseGuiArgs(['vm']).devname).toBeUndefined();
  });

  it('without a value is a usage error', () => {
    expect(() => parseGuiArgs(['-devname'])).toThrow(UsageError);
  });
});

describe('-bind-limit', () => {
  it('off lets an out-of-range BIND geometry through', () => {
    expect(parseGuiArgs(['-bind-limit', 'off', 'vm']).bindLimit).toBe(false);
  });

  it('defaults to on', () => {
    expect(parseGuiArgs(['vm']).bindLimit).not.toBe(false);
  });

  it('rejects a value that is not on or off', () => {
    expect(() => parseGuiArgs(['-bind-limit', 'yes', 'vm'])).toThrow(UsageError);
  });

  it('without a value is a usage error', () => {
    expect(() => parseGuiArgs(['-bind-limit'])).toThrow(UsageError);
  });
});

describe('-oversize', () => {
  it('parses a fixed size and auto', () => {
    expect(parseGuiArgs(['-oversize', '160x62', 'vm']).oversize)
      .toEqual({ kind: 'fixed', rows: 62, cols: 160 });
    expect(parseGuiArgs(['-oversize', 'auto', 'vm']).oversize).toEqual({ kind: 'auto' });
    expect(parseGuiArgs(['-oversize', 'none', 'vm']).oversize).toEqual({ kind: 'none' });
    expect(parseGuiArgs(['vm']).oversize).toBeUndefined();
  });

  it('refuses it with --terminal-type, at parse time, as a UsageError naming both', () => {
    expect(() => parseGuiArgs(['-oversize', 'auto', '--terminal-type', 'IBM-DYNAMIC', 'vm']))
      .toThrow(UsageError);
    expect(() => parseGuiArgs(['-oversize', '160x62', '--terminal-type', 'IBM-DYNAMIC', 'vm']))
      .toThrow(/-oversize and --terminal-type/);
  });

  it('refuses it on a model without -E, naming the -E model', () => {
    expect(() => parseGuiArgs(['-model', '3278-2', '-oversize', 'auto', 'vm']))
      .toThrow(UsageError);
    expect(() => parseGuiArgs(['-model', '3278-2', '-oversize', 'auto', 'vm']))
      .toThrow(/use -model 3278-2-E/);
  });

  it('refuses a fixed size smaller than the model at parse time', () => {
    expect(() => parseGuiArgs(['-model', '3278-4-E', '-oversize', '80x30', 'vm']))
      .toThrow(/use at least 80x43/);
  });

  it('is in the usage line', () => {
    expect(() => parseGuiArgs([])).toThrow(/-oversize <cols>x<rows>\|auto\|none/);
  });
});

/**
 * `buildSession` is what main.ts constructs, driven here rather than copied (the CLI's lesson:
 * a test of a copied expression passed a mutant that hardcoded the model).
 */
describe('buildSession', () => {
  const none = (): undefined => undefined;

  it('geometry mode by default, with the model and the oversize from argv', () => {
    const session = buildSession(parseGuiArgs(['-model', '3278-4-E', '-oversize', '160x62', 'vm']), none);
    expect(session.geometrySetting).toEqual({ model: '3278-4-E', oversize: { kind: 'fixed', rows: 62, cols: 160 } });
    // Before a connect the session holds the MODEL's geometry, never the oversize's.
    expect(session.screen.alternateSize).toEqual({ rows: 43, cols: 80 });
  });

  it('no flags: geometry mode with no model and oversize none', () => {
    expect(buildSession(parseGuiArgs(['vm']), none).geometrySetting).toEqual({ oversize: { kind: 'none' } });
  });

  describe('against a local socket', () => {
    let server: Server | undefined;
    const sockets: Socket[] = [];
    afterEach(async () => {
      for (const s of sockets.splice(0)) s.destroy();
      await new Promise<void>((r) => { if (server) server.close(() => r()); else r(); });
      server = undefined;
    });
    const listen = async (): Promise<number> => {
      server = createServer((s) => { sockets.push(s); });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      return (server.address() as AddressInfo).port;
    };

    it('legacy mode with --terminal-type: no setting, and the type string as given on the wire', async () => {
      // The server asks for TERMINAL-TYPE (IAC DO TTYPE, then IAC SB TTYPE SEND IAC SE) and the
      // test reads the IS reply, so what is checked is what the host would be told.
      const received: number[] = [];
      let gotIs!: () => void;
      const isDone = new Promise<void>((r) => { gotIs = r; });
      server = createServer((s) => {
        sockets.push(s);
        s.write(Uint8Array.from([0xff, 0xfd, 0x18, 0xff, 0xfa, 0x18, 0x01, 0xff, 0xf0]));
        s.on('data', (d: Buffer) => {
          received.push(...d);
          if (Buffer.from(received).includes(Buffer.from([0xff, 0xf0]))) gotIs();
        });
      });
      await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const session = buildSession(
        parseGuiArgs(['-model', '3278-4-E', '--terminal-type', 'IBM-3278-4-E@MOD4', '-insecure', 'h']),
        none);
      expect(session.geometrySetting).toBeUndefined();
      // 24x80, NOT the model's 43x80: `resolveAlternateSize` declines to guess a geometry from a
      // raw terminal-type string (core/src/geometry.ts), exactly as the GUI's code did before
      // geometry mode -- legacy behaviour, unchanged.
      expect(session.screen.alternateSize).toEqual({ rows: 24, cols: 80 });
      await session.connect('127.0.0.1', port);
      await isDone;
      const bytes = Buffer.from(received);
      const sb = bytes.indexOf(Buffer.from([0xff, 0xfa, 0x18, 0x00]));
      expect(sb).toBeGreaterThanOrEqual(0);
      const name = bytes.subarray(sb + 4, bytes.indexOf(Buffer.from([0xff, 0xf0]), sb)).toString('latin1');
      expect(name).toBe('IBM-3278-4-E@MOD4');
      expect(session.resolvedGeometry).toBeUndefined();
      session.disconnect();
    });

    it('auto is measured when connect() runs, with the setting the session holds THEN', async () => {
      const port = await listen();
      const seen: (GeometrySetting | undefined)[] = [];
      let fits = { rows: 50, cols: 132 };
      const session = buildSession(parseGuiArgs(['-oversize', 'auto', '-insecure', 'h']),
        (setting) => { seen.push(setting); return fits; });
      expect(seen).toEqual([]);                       // never at construction
      await session.connect('127.0.0.1', port);
      expect(session.screen.alternateSize).toEqual({ rows: 50, cols: 132 });
      expect(seen).toEqual([{ oversize: { kind: 'auto' } }]);
      session.disconnect();
      session.setGeometry({ model: '3278-4-E', oversize: { kind: 'auto' } });
      fits = { rows: 62, cols: 160 };
      await session.connect('127.0.0.1', port);
      expect(session.screen.alternateSize).toEqual({ rows: 62, cols: 160 });
      expect(seen[1]).toEqual({ model: '3278-4-E', oversize: { kind: 'auto' } });
      session.disconnect();
    });

    it('printGeometryNotices: the first connect\'s notice and every later one, on stderr', async () => {
      const port = await listen();
      const errors: string[] = [];
      let fits: { rows: number; cols: number } | undefined = { rows: 20, cols: 80 };
      const session = buildSession(
        parseGuiArgs(['-oversize', 'auto', '-insecure', 'h']), () => fits);
      printGeometryNotices(session, { write: (t) => { errors.push(t); } });
      await session.connect('127.0.0.1', port);
      expect(errors).toEqual([
        "oversize auto: window fits 20 rows by 80 columns, less than model 3278-2-E's 24 rows by 80 columns; using the model\n",
      ]);
      fits = { rows: 50, cols: 132 };                  // a fit: no notice, nothing printed
      await session.connect('127.0.0.1', port);
      expect(errors).toHaveLength(1);
      fits = undefined;
      await session.connect('127.0.0.1', port);
      expect(errors[1]).toBe('oversize auto: no window size known; using the model\n');
      session.disconnect();
    });
  });
});
