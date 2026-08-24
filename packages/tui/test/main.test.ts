import { describe, expect, it } from 'vitest';
import { BANNER, parseArgs, UsageError } from '../src/main.js';

// Importing this module is safe: the entry point is behind an
// `import.meta.url === file://${process.argv[1]}` guard, so requiring it from a
// test does not start a session. (The CLI's main.ts has no such guard and DOES
// run on import, which is why the TUI is wired this way and why cli/src/index.ts
// deliberately does not re-export it.)

describe('parseArgs', () => {
  it('takes a bare argument as the host', () => {
    expect(parseArgs(['127.0.0.1:3270'])).toEqual({ host: '127.0.0.1:3270' });
  });

  it('parses the flags the CLI also has, with the same spellings', () => {
    expect(parseArgs(['-model', '3278-2-E', 'vm:3270']))
      .toEqual({ model: '3278-2-E', host: 'vm:3270' });
    expect(parseArgs(['--terminal-type', 'IBM-DYNAMIC', 'vm']))
      .toEqual({ terminalType: 'IBM-DYNAMIC', host: 'vm' });
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
