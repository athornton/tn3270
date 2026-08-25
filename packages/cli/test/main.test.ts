import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../src/main.js';

/**
 * TLS is ON by default, so every parse carries it. Spelled out in each
 * expectation rather than hidden behind a matcher: the whole point of the
 * default is that it is not silently absent.
 */
const TLS = { kind: 'tls', verify: true } as const;

describe('command line arguments', () => {
  it('defaults to no terminal type override', () => {
    expect(parseArgs([])).toEqual({ tls: TLS });
  });

  it('parses -model', () => {
    expect(parseArgs(['-model', '3278-2-E'])).toEqual({ model: '3278-2-E', tls: TLS });
  });

  it('parses --terminal-type', () => {
    expect(parseArgs(['--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ terminalType: 'IBM-DYNAMIC', tls: TLS });
  });

  it('accepts both, letting the raw type win at resolution time', () => {
    expect(parseArgs(['-model', '3278-2', '--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ model: '3278-2', terminalType: 'IBM-DYNAMIC', tls: TLS });
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['-model'])).toThrow(UsageError);
    expect(() => parseArgs(['--terminal-type'])).toThrow(UsageError);
  });

  it('rejects an unrecognised flag rather than ignoring it', () => {
    // Silently ignoring a flag the user typed is how a session ends up
    // negotiating something nobody asked for.
    expect(() => parseArgs(['--wat'])).toThrow(UsageError);
  });
});
