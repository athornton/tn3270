import { describe, it, expect } from 'vitest';
import { parseWebArgs, UsageError } from '../src/args.js';

/**
 * The gateway's own flags. The HOST-side flags (-insecure, -cafile, -model, -scheme) are
 * `frontend`'s and are parsed by its helpers; these are the ones that exist only because this
 * front end faces a network.
 *
 * THE TWO TLS DIRECTIONS MUST NOT BLUR. `--tls-cert`/`--tls-key` are how the BROWSER verifies US.
 * `-insecure` and friends are how WE verify the MAINFRAME. A test that confuses them would license
 * a flag that silently downgrades one of the two.
 */
describe('parseWebArgs', () => {
  it('requires a host', () => {
    expect(() => parseWebArgs([])).toThrow(UsageError);
  });

  it('takes host and port from the positional argument', () => {
    const a = parseWebArgs(['127.0.0.1:3270']);
    expect(a.host).toBe('127.0.0.1');
    expect(a.port).toBe(3270);
  });

  it('defaults the listen address to loopback, because exposing it must be deliberate', () => {
    expect(parseWebArgs(['vm:3270']).bind).toBe('127.0.0.1');
    expect(parseWebArgs(['--bind', '0.0.0.0', 'vm:3270']).bind).toBe('0.0.0.0');
  });

  it('defaults the listen port to 8270 and accepts --listen', () => {
    expect(parseWebArgs(['vm:3270']).listen).toBe(8270);
    expect(parseWebArgs(['--listen', '9999', 'vm:3270']).listen).toBe(9999);
  });

  it('generates a token when none is given, and keeps auth on', () => {
    const a = parseWebArgs(['vm:3270']);
    expect(a.auth).toBe(true);
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('accepts an explicit token, and --auth off', () => {
    expect(parseWebArgs(['--token', 'sekrit', 'vm:3270']).token).toBe('sekrit');
    expect(parseWebArgs(['--auth', 'off', 'vm:3270']).auth).toBe(false);
  });

  it('refuses --tls-cert without --tls-key rather than downgrading silently', () => {
    expect(() => parseWebArgs(['--tls-cert', '/tmp/c.pem', 'vm:3270'])).toThrow(/--tls-key/);
    expect(() => parseWebArgs(['--tls-key', '/tmp/k.pem', 'vm:3270'])).toThrow(/--tls-cert/);
    const a = parseWebArgs(['--tls-cert', '/tmp/c.pem', '--tls-key', '/tmp/k.pem', 'vm:3270']);
    expect(a.tls).toEqual({ cert: '/tmp/c.pem', key: '/tmp/k.pem' });
  });

  it('defaults grace to 60s and the session cap to 16', () => {
    const a = parseWebArgs(['vm:3270']);
    expect(a.graceMs).toBe(60_000);
    expect(a.maxSessions).toBe(16);
  });

  it('takes a replay trace, which is the hostless test seam', () => {
    expect(parseWebArgs(['--replay', '/tmp/t.trace', 'vm:3270']).replay).toBe('/tmp/t.trace');
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseWebArgs(['--wat', 'vm:3270'])).toThrow(UsageError);
  });
});
