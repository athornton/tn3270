import { describe, it, expect } from 'vitest';
import { parseGuiArgs, UsageError } from '../src/args.js';

/**
 * The flags must be the TUI's, and the way that is guaranteed is by parsing with the same
 * shared helpers rather than by keeping two lists in step. These tests pin the BEHAVIOUR
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

  it('refuses an unrecognised flag rather than ignoring it', () => {
    // Same reasoning as both other front ends: a silently skipped flag produces a session
    // that negotiates something nobody asked for, which is very hard to see in a trace.
    expect(() => parseGuiArgs(['--nonesuch', 'vm'])).toThrow(UsageError);
    expect(() => parseGuiArgs(['-x', 'vm'])).toThrow(/unrecognised/);
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
