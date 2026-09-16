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

  // 0 is not a typo here: it means "let the OS pick an ephemeral port", which is what the
  // integration and TLS harnesses (later tasks) rely on to avoid colliding on a fixed port.
  // Do not "tighten" this back to positiveInt.
  it('accepts --listen 0 for an ephemeral port, which the integration harnesses rely on', () => {
    expect(parseWebArgs(['--listen', '0', 'vm:3270']).listen).toBe(0);
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

  /**
   * `--allow-origin` is REPEATABLE, and it exists because nginx's default
   * `proxy_set_header Host $proxy_host` (and Apache's default `ProxyPreserveHost Off`) rewrites Host
   * to the upstream address, which no browser's Origin can match. Without this the Origin check
   * refuses every legitimate browser behind such a proxy. Do not "simplify" it to a single value.
   */
  it('defaults --allow-origin to an empty list and COLLECTS repeats', () => {
    expect(parseWebArgs(['vm:3270']).allowOrigins).toEqual([]);
    expect(parseWebArgs(['--allow-origin', 'https://gw.example', 'vm:3270']).allowOrigins)
      .toEqual(['https://gw.example']);
    const a = parseWebArgs([
      '--allow-origin', 'https://gw.example', '--allow-origin', 'https://alt.example', 'vm:3270',
    ]);
    expect(a.allowOrigins).toEqual(['https://gw.example', 'https://alt.example']);
    // The arithmetic check, as with the TLS flags: the host must survive two value-taking flags.
    expect(a.host).toBe('vm');
    expect(a.port).toBe(3270);
  });

  it('refuses --allow-origin with no value instead of eating the host', () => {
    expect(() => parseWebArgs(['vm:3270', '--allow-origin'])).toThrow(/--allow-origin/);
  });

  it('stores the value verbatim -- no normalising, so no accidental wildcard support', () => {
    // handshake.ts compares these as exact strings. Parsing must not helpfully strip a trailing
    // slash or lowercase a scheme, or the flag would start matching more than the operator wrote.
    expect(parseWebArgs(['--allow-origin', 'https://*.example', 'vm:3270']).allowOrigins)
      .toEqual(['https://*.example']);
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    expect(() => parseWebArgs(['--wat', 'vm:3270'])).toThrow(UsageError);
  });

  /**
   * The host-side TLS flags (frontend's `takeTlsFlag`) are the one piece of logic in this file
   * most likely to carry an off-by-one in how many argv slots it consumes. These three tests
   * are not really about `-insecure`/`-cafile`/`-model` themselves -- they are about the
   * ARITHMETIC: that the host positional argument is still parsed correctly afterwards, which
   * only happens if `i += eaten` advances past exactly the right number of slots.
   */
  it('parses -insecure (the zero-extra-slot case) without disturbing the host', () => {
    const a = parseWebArgs(['-insecure', 'vm:3270']);
    expect(a.host).toBe('vm');
    expect(a.port).toBe(3270);
  });

  it('parses -cafile FILE (the one-extra-slot case) without disturbing the host', () => {
    const a = parseWebArgs(['-cafile', '/tmp/ca.pem', 'vm:3270']);
    expect(a.host).toBe('vm');
    expect(a.port).toBe(3270);
    expect(a.hostTls.caFile).toBe('/tmp/ca.pem');
  });

  it('parses -model VALUE without disturbing the host', () => {
    const a = parseWebArgs(['-model', '3278-4-E', 'vm:3270']);
    expect(a.model).toBe('3278-4-E');
    expect(a.host).toBe('vm');
    expect(a.port).toBe(3270);
  });
});
