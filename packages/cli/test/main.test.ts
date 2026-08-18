import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../src/main.js';

describe('command line arguments', () => {
  it('defaults to no terminal type override', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('parses -model', () => {
    expect(parseArgs(['-model', '3278-2-E'])).toEqual({ model: '3278-2-E' });
  });

  it('parses --terminal-type', () => {
    expect(parseArgs(['--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ terminalType: 'IBM-DYNAMIC' });
  });

  it('accepts both, letting the raw type win at resolution time', () => {
    expect(parseArgs(['-model', '3278-2', '--terminal-type', 'IBM-DYNAMIC']))
      .toEqual({ model: '3278-2', terminalType: 'IBM-DYNAMIC' });
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
